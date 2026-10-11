import { describe, expect, it } from "vitest";
import { THRESHOLDS } from "../config/thresholds";
import { createTrackerState, sceneChangeFraction, step, type FrameInput } from "../src/lib/tracker";
import type { Box } from "../src/lib/types";

const MIN = 60_000;
const car = (x: number, y: number, w = 30, h = 20): Box => ({ x, y, w, h, cls: "car", score: 0.8 });
const thumb = (v = 100) => new Array(576).fill(v);
let n = 0;
const frame = (ts: number, boxes: Box[], t = thumb()): FrameInput => ({ ts, hash: `h${n++}`, boxes, thumb: t });

/** A moving car that shifts far enough each frame never to match its previous position. */
const mover = (i: number) => car(20 + i * 60, 180);

describe("stall logic", () => {
  it("flags a vehicle that stays put for >=3 fresh frames while other traffic moves", () => {
    const s = createTrackerState();
    const stalled = car(300, 120);
    const events = [];
    for (let i = 0; i < 4; i++) events.push(...step(s, frame(i * 1.5 * MIN, [stalled, mover(i)])).events);
    const flagged = events.filter((e) => e.type === "stationary");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].type === "stationary" && flagged[0].kind).toBe("stall");
    expect(flagged[0].type === "stationary" && flagged[0].track.anchor.x).toBe(300);
  });

  it("tolerates small jitter in the box position (detector noise)", () => {
    const s = createTrackerState();
    const ev = [];
    for (let i = 0; i < 4; i++) ev.push(...step(s, frame(i * 1.5 * MIN, [car(300 + (i % 2) * 2, 120 - (i % 2)), mover(i)])).events);
    expect(ev.some((e) => e.type === "stationary")).toBe(true);
  });

  it("does not flag before MIN_STATIONARY_SECONDS even with enough frames", () => {
    const s = createTrackerState();
    const ev = [];
    for (let i = 0; i < 3; i++) ev.push(...step(s, frame(i * 30_000, [car(300, 120), mover(i)])).events); // 60 s total
    expect(ev.some((e) => e.type === "stationary")).toBe(false);
  });

  it("labels congestion (nearly everything stationary) instead of a stall", () => {
    const s = createTrackerState();
    const jam = [car(50, 150), car(120, 150), car(190, 150), car(260, 150), car(330, 150)];
    const ev = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = step(s, frame(i * 1.5 * MIN, [...jam, mover(i)]));
      ev.push(...last.events);
    }
    expect(last!.congestion).toBe(true);
    expect(ev.some((e) => e.type === "stationary")).toBe(false);
  });

  it("does not flag a lone stationary vehicle when nothing else in view ever moves (parked)", () => {
    const s = createTrackerState();
    const ev = [];
    for (let i = 0; i < 5; i++) ev.push(...step(s, frame(i * 1.5 * MIN, [car(300, 120)])).events);
    expect(ev.some((e) => e.type === "stationary")).toBe(false);
  });

  it("does not flag a slowly creeping vehicle (drifts away from its anchor position)", () => {
    const s = createTrackerState();
    const ev = [];
    for (let i = 0; i < 6; i++) ev.push(...step(s, frame(i * 1.5 * MIN, [car(100 + i * 14, 120), mover(i)])).events);
    expect(ev.some((e) => e.type === "stationary")).toBe(false);
  });

  it("resets tracking on a sharp scene change (camera pan/zoom) and clears active detections", () => {
    const s = createTrackerState();
    for (let i = 0; i < 4; i++) step(s, frame(i * 1.5 * MIN, [car(300, 120), mover(i)], thumb(100)));
    expect(s.tracks.some((t) => t.flagged)).toBe(true);
    const r = step(s, frame(6 * MIN, [car(300, 120), mover(5)], thumb(200)));
    expect(r.sceneChanged).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["cleared", "scene_reset"]));
    expect(r.events.find((e) => e.type === "cleared")).toMatchObject({ reason: "scene_change" });
    expect(s.tracks.every((t) => t.hits === 1)).toBe(true);
  });

  it("does not treat ordinary traffic changes as a scene change", () => {
    const a = thumb(100);
    const b = thumb(100);
    for (let i = 0; i < 60; i++) b[i] = 220; // ~10% of the image changed (vehicles moving)
    expect(sceneChangeFraction(a, b, THRESHOLDS.SCENE_CELL_DIFF)).toBeLessThan(THRESHOLDS.SCENE_CHANGE_FRACTION);
  });

  it("does not call a slow-refreshing feed frozen before FROZEN_MIN_UNCHANGED_MS", () => {
    const s = createTrackerState();
    const f = frame(0, [car(300, 120)]);
    step(s, f);
    let r;
    for (let i = 1; i <= 6; i++) r = step(s, { ...f, ts: i * MIN }); // 6 identical polls over 6 min
    expect(r!.fresh).toBe(false);
    expect(r!.frozen).toBe(false);
  });

  it("marks a feed frozen after N identical polls over the minimum time and does not analyze those frames", () => {
    const s = createTrackerState();
    const f = frame(0, [car(300, 120)]);
    const gap = Math.ceil(THRESHOLDS.FROZEN_MIN_UNCHANGED_MS / (THRESHOLDS.FROZEN_AFTER_IDENTICAL_POLLS - 1));
    const results = [step(s, f)];
    for (let i = 1; i < THRESHOLDS.FROZEN_AFTER_IDENTICAL_POLLS + 1; i++) results.push(step(s, { ...f, ts: i * gap }));
    expect(results[0].fresh).toBe(true);
    expect(results.slice(1).every((r) => !r.fresh)).toBe(true);
    expect(results[THRESHOLDS.FROZEN_AFTER_IDENTICAL_POLLS - 2].frozen).toBe(false);
    expect(results[THRESHOLDS.FROZEN_AFTER_IDENTICAL_POLLS - 1].frozen).toBe(true);
    // A frozen feed must never produce a stationary detection, no matter how long.
    expect(results.flatMap((r) => r.events).some((e) => e.type === "stationary")).toBe(false);
    expect(s.tracks[0].hits).toBe(1);
  });

  it("emits cleared when a flagged vehicle leaves", () => {
    const s = createTrackerState();
    for (let i = 0; i < 4; i++) step(s, frame(i * 1.5 * MIN, [car(300, 120), mover(i)]));
    const ev = [];
    for (let i = 4; i < 4 + THRESHOLDS.MAX_MISSED_FRAMES + 1; i++) ev.push(...step(s, frame(i * 1.5 * MIN, [mover(i)])).events);
    expect(ev.find((e) => e.type === "cleared")).toMatchObject({ reason: "vehicle_left" });
  });

  it("survives a single missed detection (flicker) without losing the track", () => {
    const s = createTrackerState();
    const ev = [];
    ev.push(...step(s, frame(0, [car(300, 120), mover(0)])).events);
    ev.push(...step(s, frame(1.5 * MIN, [mover(1)])).events); // detector missed it once
    ev.push(...step(s, frame(3 * MIN, [car(300, 120), mover(2)])).events);
    ev.push(...step(s, frame(4.5 * MIN, [car(300, 120), mover(3)])).events);
    expect(ev.some((e) => e.type === "stationary")).toBe(true);
  });

  it("does not flag a low-confidence static detection (lane marking / sign seen as a car)", () => {
    const s = createTrackerState();
    const ghost: Box = { ...car(250, 130), score: 0.27 };
    const ev = [];
    for (let i = 0; i < 6; i++) ev.push(...step(s, frame(i * 1.5 * MIN, [ghost, mover(i)])).events);
    expect(ev.some((e) => e.type === "stationary")).toBe(false);
  });

  it("ignores vehicles inside configured ignore zones (parking lots)", () => {
    const s = createTrackerState();
    const ev = [];
    for (let i = 0; i < 5; i++) ev.push(...step(s, frame(i * 1.5 * MIN, [car(300, 120), mover(i)]), { ignoreZones: [[0.6, 0.4, 0.3, 0.3]] }).events);
    expect(ev.some((e) => e.type === "stationary")).toBe(false);
  });
});
