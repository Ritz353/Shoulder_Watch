// Shoulder Watch worker: polls cameras (live) or plays back recordings (--replay),
// runs detection + stall logic, writes state for the dashboard, and runs the iMessage agent.
//
//   npm run worker            live mode (default)
//   npm run worker:replay     REPLAY mode: recorded frames from ./replay, clearly labelled
//   add --replay-alerts       to also send [REPLAY]-prefixed alerts to subscribers (demo only)

import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { THRESHOLDS } from "../config/thresholds";
import { Agent, photonConfigured } from "../src/lib/agent";
import type { StatusInput } from "../src/lib/status-reply";
import { subscriptionExpired } from "../src/lib/commands";
import { geminiConfigured } from "../src/lib/gemini";
import { ga511Enabled } from "../src/lib/ga511";
import { fetchSnapshot, nextDelay, sha1 } from "../src/lib/poller";
import { REPLAY_DIR, ensureDirs, loadCameras, loadDetections, loadSubscribers, paths, writeJson } from "../src/lib/store";
import type { WorkerState } from "../src/lib/types";
import { Pipeline, createRuntime, type CameraRuntime } from "./pipeline";

const args = new Set(process.argv.slice(2));
const mode: "live" | "replay" = args.has("--replay") ? "replay" : "live";
const startedAt = Date.now();
const log = (msg: string) => console.log(`${new Date().toLocaleTimeString("en-US", { hour12: false })} ${msg}`);

ensureDirs();
const allCameras = loadCameras();

// Detections from a previous run can't keep being tracked (tracker state is in memory).
const detections = loadDetections();
for (const d of detections) {
  if (d.status === "active" && d.source === "live") {
    d.status = "cleared";
    d.clearedReason = "worker_restart";
  }
}

const runtimes = new Map<number, CameraRuntime>();
const agent = new Agent({ input: statusInput, log });
const pipeline = new Pipeline(
  {
    mode,
    log,
    alertsEnabled: mode === "live" || args.has("--replay-alerts"),
    sendAlert: (sub, msg, photo) => agent.sendAlert(sub, msg, photo),
  },
  detections,
);
let replayNote: string | undefined;

async function writeState(): Promise<void> {
  const state: WorkerState = {
    mode,
    startedAt,
    updatedAt: Date.now(),
    replayNote,
    integrations: {
      gemini: geminiConfigured() ? `on (${process.env.GEMINI_MODEL})` : "off - detections marked unconfirmed",
      photon: agent.status,
      ga511: ga511Enabled() ? "on (official events)" : "off - key pending; manual check workflow",
    },
    cameras: [...runtimes.values()].map((r) => r.state),
  };
  await writeJson(paths.state, state).catch((e) => log(`[store] ${e.message}`));
}

// ---------------------------------------------------------------- live mode
async function pollLoop(rt: CameraRuntime): Promise<void> {
  try {
    const snap = await fetchSnapshot(rt.cam.id);
    rt.failures = 0;
    if (snap.unavailable) pipeline.markBad(rt, "unavailable", snap.fetchedAt, "511GA: stream not available");
    else await pipeline.processFrame(rt, snap.png, snap.hash, snap.fetchedAt);
  } catch (e) {
    rt.failures++;
    pipeline.markBad(rt, "unreachable", Date.now(), (e as Error).message);
    log(`[cam ${rt.cam.id}] fetch failed (${(e as Error).message}); backoff #${rt.failures}`);
  }
  await writeState();
  setTimeout(() => void pollLoop(rt), nextDelay(rt.failures));
}

function startLive(): void {
  log(`LIVE mode: ${allCameras.length} cameras, every ${THRESHOLDS.POLL_INTERVAL_MS / 1000}s + jitter`);
  allCameras.forEach((cam, i) => {
    const rt = createRuntime(cam);
    runtimes.set(cam.id, rt);
    // Stagger the first round so we never burst requests at 511GA.
    setTimeout(() => void pollLoop(rt), i * 1_500 + Math.random() * 1_000);
  });
}

// ---------------------------------------------------------------- replay mode
interface Recording {
  dir: string;
  cameraId: number;
  note: string;
  frames: { file: string; ts: number }[];
}

function loadRecordings(): Recording[] {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  return fs
    .readdirSync(REPLAY_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(REPLAY_DIR, d.name, "manifest.json")))
    .map((d) => ({ dir: path.join(REPLAY_DIR, d.name), ...JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, d.name, "manifest.json"), "utf8")) }));
}

async function startReplay(): Promise<void> {
  const recs = loadRecordings();
  if (!recs.length) {
    log("REPLAY mode: no recordings in ./replay - run `npm run replay:capture -- <detectionId>` after a live detection.");
    replayNote = "No recordings found";
    await writeState();
    return;
  }
  log(`REPLAY mode: ${recs.length} recording(s); frames every ${THRESHOLDS.REPLAY_FRAME_INTERVAL_MS / 1000}s (accelerated, original timestamps)`);
  for (const r of recs) {
    const cam = allCameras.find((c) => c.id === r.cameraId) ?? { id: r.cameraId, name: `Camera ${r.cameraId}`, road: "?", direction: "", lat: 0, lng: 0 };
    runtimes.set(cam.id, createRuntime(cam));
  }
  const seedIds = new Set(pipeline.detections.map((d) => d.id));
  for (;;) {
    for (const r of recs) {
      // Drop what the previous loop of this recording produced, so detections don't pile up.
      pipeline.detections = pipeline.detections.filter((d) => seedIds.has(d.id) || !(d.source === "replay" && d.cameraId === r.cameraId));
      const rt = createRuntime(runtimes.get(r.cameraId)!.cam);
      runtimes.set(r.cameraId, rt);
      replayNote = r.note;
      log(`[replay] ${rt.cam.name}: ${r.frames.length} frames - ${r.note}`);
      for (const f of r.frames) {
        const png = await fsp.readFile(path.join(r.dir, f.file));
        await pipeline.processFrame(rt, png, sha1(png), f.ts);
        await writeState();
        await new Promise((res) => setTimeout(res, THRESHOLDS.REPLAY_FRAME_INTERVAL_MS));
      }
    }
  }
}

// ---------------------------------------------------------------- agent replies (read-only state)
function statusInput(): StatusInput {
  const rts = [...runtimes.values()];
  return {
    mode,
    cameras: rts.map((r) => r.cam),
    states: new Map(rts.map((r) => [r.cam.id, r.state])),
    detections: pipeline.detections,
    latestFrame: (id) => runtimes.get(id)?.buffer.at(-1)?.png ?? null,
  };
}

// ---------------------------------------------------------------- housekeeping
async function housekeeping(): Promise<void> {
  const purged = await pipeline.purgeOldSnapshots();
  if (purged) log(`[privacy] purged snapshots of ${purged} detection(s) older than ${THRESHOLDS.SNAPSHOT_RETENTION_HOURS}h`);
  const subs = loadSubscribers();
  const keep = subs.filter((s) => !subscriptionExpired(s, Date.now()));
  if (keep.length !== subs.length) {
    await writeJson(paths.subscribers, keep);
    log(`[privacy] removed ${subs.length - keep.length} expired subscription(s)`);
  }
}

async function main(): Promise<void> {
  log(`Shoulder Watch worker (${mode.toUpperCase()}) - Gemini: ${geminiConfigured() ? "on" : "off"}, Photon: ${photonConfigured() ? "on" : "off"}, 511GA API: ${ga511Enabled() ? "on" : "off"}`);
  await pipeline.flush();
  if (mode === "live") startLive();
  else void startReplay();
  void agent.run();
  setInterval(() => void housekeeping(), 10 * 60_000);
  void housekeeping();
  const shutdown = async () => {
    log("shutting down");
    await pipeline.flush().catch(() => undefined);
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();

