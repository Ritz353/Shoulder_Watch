// Per-camera processing shared by live and replay modes:
// frame -> (frozen? scene change?) -> YOLO boxes -> tracker -> detections -> AI check -> alerts.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { THRESHOLDS } from "../config/thresholds";
import { roadMatches, subscriptionActive } from "../src/lib/commands";
import { analyzeFrame, annotate, classifyArrival, regionSignature } from "../src/lib/detector";
import { confirmWithGemini, geminiConfigured, unconfirmed } from "../src/lib/gemini";
import { ga511Enabled, getEvents, matchOfficial } from "../src/lib/ga511";
import { canSendAlert, recordAlert, type AlertLog } from "../src/lib/ratelimit";
import { DATA_DIR, loadSubscribers, paths, readJson, writeFileAtomic, writeJson } from "../src/lib/store";
import { createTrackerState, inZones, step, type Track, type TrackerState } from "../src/lib/tracker";
import type { Box, Camera, CameraState, Detection, Snapshot } from "../src/lib/types";

export interface BufferedFrame {
  ts: number;
  hash: string;
  png: Buffer;
  boxes: Box[];
  night: boolean;
}

export interface CameraRuntime {
  cam: Camera;
  tracker: TrackerState;
  buffer: BufferedFrame[];
  failures: number;
  state: CameraState;
  trackToDetection: Map<number, string>;
  badSince?: number; // when the feed went frozen/unavailable/unreachable
}

export interface PipelineHooks {
  mode: "live" | "replay";
  log: (msg: string) => void;
  /** Send an iMessage alert; resolves false if the agent is unavailable. */
  sendAlert?: (sub: import("../src/lib/types").Subscription, message: string, photo: Buffer) => Promise<boolean>;
  alertsEnabled: boolean;
}

const rel = (abs: string) => "data/" + path.relative(DATA_DIR, abs).split(path.sep).join("/");

export function createRuntime(cam: Camera): CameraRuntime {
  return {
    cam,
    tracker: createTrackerState(),
    buffer: [],
    failures: 0,
    trackToDetection: new Map(),
    state: { id: cam.id, status: "pending", vehicles: 0, stationary: 0, boxes: [], stationaryBoxes: [], night: false, congestion: false },
  };
}

export class Pipeline {
  detections: Detection[];
  private saveQueued = false;

  constructor(private readonly hooks: PipelineHooks, initial: Detection[]) {
    this.detections = initial;
  }

  /** Called with a successfully fetched (or replayed) frame. */
  async processFrame(rt: CameraRuntime, png: Buffer, hash: string, ts: number): Promise<void> {
    const prev = rt.buffer.at(-1);
    rt.state.lastFetchAt = ts;
    rt.state.lastError = undefined;

    // Byte-identical to the last frame: don't re-run the detector, just count toward "frozen".
    if (prev && prev.hash === hash) {
      const r = step(rt.tracker, { ts, hash, boxes: prev.boxes, thumb: [] }, { ignoreZones: rt.cam.ignoreZones });
      rt.state.status = r.frozen ? "frozen" : "ok";
      if (r.frozen) {
        rt.badSince ??= ts;
        rt.state.boxes = [];
        rt.state.stationaryBoxes = [];
      }
      this.checkFeedLost(rt, ts);
      return;
    }

    const a = await analyzeFrame(png);
    const result = step(rt.tracker, { ts, hash, boxes: a.boxes, thumb: a.thumb }, { ignoreZones: rt.cam.ignoreZones });
    rt.badSince = undefined;
    rt.buffer.push({ ts, hash, png, boxes: a.boxes, night: a.night });
    if (rt.buffer.length > THRESHOLDS.FRAME_BUFFER_SIZE) rt.buffer.shift();

    const liveFile = path.join(paths.live, `${rt.cam.id}.png`);
    await writeFileAtomic(liveFile, png);
    const counts = rt.buffer.map((f) => f.boxes.filter((b) => !inZones(b, rt.cam.ignoreZones)).length);
    Object.assign(rt.state, {
      status: "ok",
      lastChangeAt: ts,
      vehicles: result.vehicles,
      stationary: result.stationaryBoxes.length,
      boxes: a.boxes,
      stationaryBoxes: result.stationaryBoxes,
      night: a.night,
      congestion: result.congestion,
      heldStill: result.heldStill,
      avgVehicles: Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10,
      avgSamples: counts.length,
      frameFile: `${rel(liveFile)}?t=${ts}`,
    } satisfies Partial<CameraState>);

    if (result.sceneChanged) this.hooks.log(`[cam ${rt.cam.id}] scene change (pan/zoom) - tracks reset`);

    for (const ev of result.events) {
      if (ev.type === "stationary") await this.onStationary(rt, ev.track, ev.kind, a.night);
      else if (ev.type === "reclassified") this.update(rt, ev.track, (d) => (d.kind = "long_parked"));
      else if (ev.type === "cleared") {
        this.update(rt, ev.track, (d) => {
          d.status = "cleared";
          d.clearedReason = ev.reason;
        });
        rt.trackToDetection.delete(ev.track.id);
      }
    }

    // Extend the timeline of active detections with the newest frame.
    for (const t of rt.tracker.tracks) {
      const id = rt.trackToDetection.get(t.id);
      const d = id && this.detections.find((x) => x.id === id);
      if (!d || d.status !== "active") continue;
      d.lastSeenAt = t.lastTs;
      d.stationaryMinutes = Math.round((t.lastTs - t.firstTs) / 60_000);
      d.box = t.last;
      if (t.lastTs === ts && d.snapshots.length < THRESHOLDS.MAX_SNAPSHOTS_PER_DETECTION && !d.snapshots.some((s) => s.ts === ts)) {
        d.snapshots.push(await this.saveSnapshot(d.id, rt.buffer.at(-1)!, t.last));
      }
    }
    this.queueSave();
  }

  /** Camera fetch failed or returned the "not available" placeholder. */
  markBad(rt: CameraRuntime, status: "unavailable" | "unreachable", ts: number, error?: string): void {
    rt.state.status = status;
    rt.state.lastError = error;
    rt.state.boxes = [];
    rt.state.stationaryBoxes = [];
    rt.badSince ??= ts;
    this.checkFeedLost(rt, ts);
  }

  private checkFeedLost(rt: CameraRuntime, ts: number): void {
    if (!rt.badSince || ts - rt.badSince < 15 * 60_000) return;
    for (const [trackId, id] of rt.trackToDetection) {
      const d = this.detections.find((x) => x.id === id);
      if (d?.status === "active") {
        d.status = "cleared";
        d.clearedReason = "feed_lost";
      }
      rt.trackToDetection.delete(trackId);
    }
    this.queueSave();
  }

  private update(rt: CameraRuntime, track: Track, fn: (d: Detection) => void): void {
    const id = rt.trackToDetection.get(track.id);
    const d = id && this.detections.find((x) => x.id === id);
    if (d) {
      fn(d);
      this.queueSave();
    }
  }

  private async saveSnapshot(detId: string, f: BufferedFrame, box?: Box): Promise<Snapshot> {
    const file = path.join(paths.snapshots, detId, `${f.ts}.png`);
    await writeFileAtomic(file, f.png);
    return { file: rel(file), ts: f.ts, box };
  }

  private async onStationary(rt: CameraRuntime, track: Track, kind: "stall" | "long_parked", night: boolean): Promise<void> {
    const now = track.lastTs;
    // Arrival check: lane markings, signs and barriers "stay put" too, but they were already there.
    const latestFrame = rt.buffer.at(-1)!;
    const nowSig = await regionSignature(latestFrame.png, track.last);
    const preSigs = await Promise.all(rt.buffer.filter((f) => f.ts < track.firstTs).map((f) => regionSignature(f.png, track.last)));
    const arrival = classifyArrival(nowSig, preSigs);
    if (arrival === "background") {
      this.hooks.log(`[cam ${rt.cam.id}] stationary object rejected: matches an earlier frame (sign/marking/barrier), track ${track.id}`);
      return;
    }
    const id = `${new Date(now).toISOString().slice(0, 10)}-${rt.cam.id}-${crypto.randomBytes(3).toString("hex")}`;
    const d: Detection = {
      id,
      cameraId: rt.cam.id,
      cameraName: rt.cam.name,
      road: rt.cam.road,
      direction: rt.cam.direction,
      source: this.hooks.mode,
      kind,
      firstSeenAt: track.firstTs,
      flaggedAt: now,
      lastSeenAt: now,
      stationaryMinutes: Math.round((track.lastTs - track.firstTs) / 60_000),
      box: track.last,
      night,
      arrival,
      status: "active",
      snapshots: [],
    };
    // Timeline: up to 2 frames of context before the vehicle appeared, then every frame since.
    const startIdx = Math.max(0, rt.buffer.findIndex((f) => f.ts >= track.firstTs) - 2);
    for (const f of rt.buffer.slice(startIdx)) {
      d.snapshots.push(await this.saveSnapshot(id, f, f.ts >= track.firstTs ? matchBox(f.boxes, track.anchor) : undefined));
    }
    rt.trackToDetection.set(track.id, id);
    this.detections.push(d);
    this.hooks.log(`[cam ${rt.cam.id}] STATIONARY ${kind} ${rt.cam.name} - ${d.stationaryMinutes} min, arrival ${arrival} (track ${track.id})`);
    this.queueSave();

    const latest = rt.buffer.at(-1)!;
    const annotated = await annotate(latest.png, latest.boxes.filter((b) => b !== track.last), [track.last]);

    // AI confirmation (optional). Detection stands regardless of the outcome.
    d.ai = geminiConfigured() ? await confirmWithGemini(annotated) : unconfirmed("GEMINI_API_KEY / GEMINI_MODEL not set");
    this.hooks.log(`[cam ${rt.cam.id}] AI: ${d.ai.label}${d.ai.detail ? ` (${d.ai.detail})` : ""}`);

    if (ga511Enabled()) {
      try {
        d.official = matchOfficial(d, rt.cam, await getEvents());
      } catch (e) {
        this.hooks.log(`[511GA] ${(e as Error).message}`);
      }
    }
    this.queueSave();

    const aiSaysNotAStall = d.ai.status === "confirmed" && (d.ai.verdict === "parked_or_work_zone" || d.ai.verdict === "stopped_traffic");
    if (kind === "stall" && arrival === "verified" && !aiSaysNotAStall) await this.alertSubscribers(d, annotated);
  }

  private async alertSubscribers(d: Detection, photo: Buffer): Promise<void> {
    if (!this.hooks.alertsEnabled || !this.hooks.sendAlert) return;
    const now = Date.now();
    const subs = loadSubscribers().filter((s) => roadMatches(d.road, s.road) && subscriptionActive(s, now));
    if (!subs.length) return;
    const log = readJson<AlertLog>(paths.alertsLog, { sent: [] });
    const prefix = this.hooks.mode === "replay" ? "[REPLAY – recorded data] " : "";
    const msg = `${prefix}⚠️ Stationary vehicle, ${d.cameraName}, stopped ${Math.max(d.stationaryMinutes, 1)} min. Move over if you can.${d.ai?.status === "confirmed" ? `\n${d.ai.evidence}` : ""}`;
    for (const sub of subs) {
      const ok = canSendAlert(log, sub.phone, d.id, now);
      if (!ok.ok) {
        this.hooks.log(`[alert] skipped (${ok.reason})`);
        continue;
      }
      if (await this.hooks.sendAlert(sub, msg, photo)) recordAlert(log, sub.phone, d.id, now);
    }
    await writeJson(paths.alertsLog, log);
  }

  queueSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    setTimeout(async () => {
      this.saveQueued = false;
      await writeJson(paths.detections, this.detections).catch((e) => this.hooks.log(`[store] ${e.message}`));
    }, 250);
  }

  async flush(): Promise<void> {
    await writeJson(paths.detections, this.detections);
  }

  /** Delete flagged snapshots older than the retention window (privacy). */
  async purgeOldSnapshots(now = Date.now()): Promise<number> {
    let purged = 0;
    for (const d of this.detections) {
      if (d.snapshotsPurged || d.status === "active") continue;
      if (!d.snapshots.some((s) => s.file.startsWith("data/"))) continue;
      if (now - d.lastSeenAt < THRESHOLDS.SNAPSHOT_RETENTION_HOURS * 3_600_000) continue;
      await fsp.rm(path.join(paths.snapshots, d.id), { recursive: true, force: true });
      d.snapshots = [];
      d.snapshotsPurged = true;
      purged++;
    }
    if (purged) this.queueSave();
    return purged;
  }
}

function matchBox(boxes: Box[], anchor: Box): Box | undefined {
  let best: Box | undefined;
  let bestD = Infinity;
  for (const b of boxes) {
    const dd = Math.hypot(b.x - anchor.x, b.y - anchor.y);
    if (dd < bestD) {
      bestD = dd;
      best = b;
    }
  }
  return bestD < Math.max(anchor.w, anchor.h) ? best : undefined;
}

