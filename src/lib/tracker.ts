// Stall logic: pure, synchronous, no I/O - fed one frame at a time per camera.
//
// A "track" is a vehicle that has been seen in about the same place in consecutive
// fresh frames. Matching is by overlap with the track's FIRST position (its anchor),
// so a slowly creeping vehicle eventually stops matching and is not called stationary.

import { THRESHOLDS, type Thresholds } from "../../config/thresholds";
import type { Box } from "./types";

export interface FrameInput {
  ts: number; // epoch ms (from fetch time, or the recorded time in replay)
  hash: string; // content hash of the raw image bytes
  boxes: Box[];
  /** 32x18 grayscale thumbnail (576 values, 0-255) for scene-change detection. */
  thumb: ArrayLike<number>;
}

export interface Track {
  id: number;
  anchor: Box;
  last: Box;
  firstTs: number;
  lastTs: number;
  hits: number; // frames in which it was matched (including the first)
  scoreSum: number; // sum of detector scores over matched frames (for the mean-confidence gate)
  missed: number; // consecutive fresh frames it was not seen
  othersMoved: boolean; // did any other vehicle appear/move while this one sat still?
  flagged: boolean; // already reported as stationary
  kind?: "stall" | "long_parked";
}

export interface TrackerState {
  tracks: Track[];
  nextId: number;
  lastHash?: string;
  sameHashRun: number; // consecutive polls with the current hash (1 = first time seen)
  hashSince?: number; // ts when the current hash was first seen
  lastThumb?: number[];
}

export type TrackerEvent =
  | { type: "stationary"; track: Track; kind: "stall" | "long_parked" }
  | { type: "reclassified"; track: Track; kind: "long_parked" }
  | { type: "cleared"; track: Track; reason: "vehicle_left" | "scene_change" }
  | { type: "scene_reset" };

export interface StepResult {
  /** False when the image is byte-identical to the previous poll (not analyzed). */
  fresh: boolean;
  frozen: boolean;
  sceneChanged: boolean;
  congestion: boolean;
  vehicles: number;
  /** Vehicles in this frame that were already at the same spot in the previous fresh frame. */
  heldStill: number;
  stationaryBoxes: Box[];
  events: TrackerEvent[];
}

export function createTrackerState(): TrackerState {
  return { tracks: [], nextId: 1, sameHashRun: 0 };
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function centerDrift(a: Box, b: Box): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  const diag = Math.hypot(a.w, a.h) || 1;
  return Math.hypot(dx, dy) / diag;
}

/** Fraction of thumbnail cells whose luminance changed by more than SCENE_CELL_DIFF. */
export function sceneChangeFraction(prev: ArrayLike<number>, next: ArrayLike<number>, cellDiff: number): number {
  const n = Math.min(prev.length, next.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(prev[i] - next[i]) > cellDiff) changed++;
  return changed / n;
}

export function inZones(box: Box, zones: [number, number, number, number][] | undefined, frameW = 450, frameH = 253): boolean {
  if (!zones?.length) return false;
  const cx = (box.x + box.w / 2) / frameW;
  const cy = (box.y + box.h / 2) / frameH;
  return zones.some(([x, y, w, h]) => cx >= x && cx <= x + w && cy >= y && cy <= y + h);
}

function isStationary(t: Track, cfg: Thresholds): boolean {
  return (
    t.hits >= cfg.MIN_STATIONARY_FRAMES &&
    (t.lastTs - t.firstTs) / 1000 >= cfg.MIN_STATIONARY_SECONDS &&
    t.scoreSum / t.hits >= cfg.STATIONARY_SCORE_MIN
  );
}

/**
 * Advance one camera's tracker by one poll. Mutates `state`.
 * Order: frozen check -> scene-change check -> match boxes to tracks -> congestion -> flag.
 */
export function step(
  state: TrackerState,
  frame: FrameInput,
  opts: { cfg?: Thresholds; ignoreZones?: [number, number, number, number][] } = {},
): StepResult {
  const cfg = opts.cfg ?? THRESHOLDS;
  const events: TrackerEvent[] = [];

  // 1. Frozen feed: identical bytes => nothing new to analyze.
  if (state.lastHash === frame.hash) {
    state.sameHashRun++;
    return {
      fresh: false,
      frozen: state.sameHashRun >= cfg.FROZEN_AFTER_IDENTICAL_POLLS && frame.ts - (state.hashSince ?? frame.ts) >= cfg.FROZEN_MIN_UNCHANGED_MS,
      sceneChanged: false,
      congestion: false,
      vehicles: frame.boxes.length,
      heldStill: 0,
      stationaryBoxes: [],
      events,
    };
  }
  state.lastHash = frame.hash;
  state.sameHashRun = 1;
  state.hashSince = frame.ts;

  // 2. Scene change (operator panned/zoomed): drop every track and start over.
  let sceneChanged = false;
  if (state.lastThumb && sceneChangeFraction(state.lastThumb, frame.thumb, cfg.SCENE_CELL_DIFF) > cfg.SCENE_CHANGE_FRACTION) {
    sceneChanged = true;
    for (const t of state.tracks) if (t.flagged) events.push({ type: "cleared", track: t, reason: "scene_change" });
    state.tracks = [];
    events.push({ type: "scene_reset" });
  }
  state.lastThumb = Array.from(frame.thumb);

  // 3. Match boxes to tracks (greedy by IoU against the anchor position).
  const boxes = frame.boxes.filter((b) => !inZones(b, opts.ignoreZones));
  const pairs: { t: number; b: number; score: number }[] = [];
  state.tracks.forEach((t, ti) =>
    boxes.forEach((b, bi) => {
      const o = iou(t.anchor, b);
      if (o >= cfg.STATIONARY_IOU_MIN && centerDrift(t.anchor, b) <= cfg.STATIONARY_CENTER_DRIFT_MAX) pairs.push({ t: ti, b: bi, score: o });
    }),
  );
  pairs.sort((a, b) => b.score - a.score);
  const usedT = new Set<number>();
  const usedB = new Set<number>();
  for (const p of pairs) {
    if (usedT.has(p.t) || usedB.has(p.b)) continue;
    usedT.add(p.t);
    usedB.add(p.b);
    const t = state.tracks[p.t];
    t.hits++;
    t.scoreSum += boxes[p.b].score;
    t.missed = 0;
    t.last = boxes[p.b];
    t.lastTs = frame.ts;
  }

  // Unseen tracks age out; a flagged one leaving means the vehicle cleared.
  const survivors: Track[] = [];
  state.tracks.forEach((t, ti) => {
    if (usedT.has(ti)) return survivors.push(t);
    t.missed++;
    if (t.missed > cfg.MAX_MISSED_FRAMES) {
      if (t.flagged) events.push({ type: "cleared", track: t, reason: "vehicle_left" });
    } else survivors.push(t);
  });

  // New boxes are new (or moved) vehicles: that is "other traffic changing".
  const newBoxes = boxes.filter((_, bi) => !usedB.has(bi));
  const othersChanged = newBoxes.length > 0 || state.tracks.length - usedT.size > 0;
  for (const b of newBoxes) {
    survivors.push({ id: state.nextId++, anchor: b, last: b, firstTs: frame.ts, lastTs: frame.ts, hits: 1, scoreSum: b.score, missed: 0, othersMoved: false, flagged: false });
  }
  state.tracks = survivors;

  // 4. Congestion: most of the visible vehicles have not moved since the last frame.
  const seenNow = state.tracks.filter((t) => t.lastTs === frame.ts);
  const heldStill = seenNow.filter((t) => t.hits >= 2).length;
  const vehicles = boxes.length;
  const congestion = vehicles >= cfg.CONGESTION_MIN_VEHICLES && heldStill / vehicles >= cfg.CONGESTION_STATIONARY_FRACTION;

  // 5. Flag stationary vehicles.
  const stationaryBoxes: Box[] = [];
  for (const t of seenNow) {
    if (t.hits >= 2 && othersChanged) t.othersMoved = true;
    if (!isStationary(t, cfg)) continue;
    stationaryBoxes.push(t.last);
    const parked = (t.lastTs - t.firstTs) / 60_000 >= cfg.LONG_PARKED_MINUTES;
    if (!t.flagged) {
      if (congestion) continue; // everyone is stopped: that's traffic, not a stall
      if (cfg.REQUIRE_OTHER_MOTION && !t.othersMoved) continue;
      t.flagged = true;
      t.kind = parked ? "long_parked" : "stall";
      events.push({ type: "stationary", track: t, kind: t.kind });
    } else if (parked && t.kind === "stall") {
      t.kind = "long_parked";
      events.push({ type: "reclassified", track: t, kind: "long_parked" });
    }
  }

  return { fresh: true, frozen: false, sceneChanged, congestion, vehicles, heldStill, stationaryBoxes, events };
}
