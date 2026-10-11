import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { THRESHOLDS as T } from "../config/thresholds";
import { buildCamerasReply, buildIncidentsReply, buildStatusReply, buildSubscriptionsReply, buildTrafficReply, type StatusInput } from "../src/lib/status-reply";
import { overallLevel, trafficLevel } from "../src/lib/traffic";
import type { Camera, CameraState, Detection } from "../src/lib/types";

describe("trafficLevel", () => {
  it("light below the moderate cutoff", () => {
    expect(trafficLevel({ vehicles: 0 })).toBe("light");
    expect(trafficLevel({ vehicles: T.TRAFFIC_MODERATE_VEHICLES - 1 })).toBe("light");
  });

  it("moderate and heavy by vehicle count", () => {
    expect(trafficLevel({ vehicles: T.TRAFFIC_MODERATE_VEHICLES })).toBe("moderate");
    expect(trafficLevel({ vehicles: T.TRAFFIC_HEAVY_VEHICLES })).toBe("heavy");
  });

  it("moderate count with many vehicles held in place is heavy", () => {
    const v = T.TRAFFIC_MODERATE_VEHICLES;
    expect(trafficLevel({ vehicles: v, heldStill: Math.ceil(v * T.TRAFFIC_HEAVY_STILL_FRACTION) })).toBe("heavy");
  });

  it("stop-and-go when most vehicles have not moved, or the tracker flagged congestion", () => {
    expect(trafficLevel({ vehicles: 6, heldStill: 5 })).toBe("stop-and-go");
    expect(trafficLevel({ vehicles: 20, heldStill: 2, congestion: true })).toBe("stop-and-go");
    // too few vehicles to call it stop-and-go
    expect(trafficLevel({ vehicles: T.TRAFFIC_STOPGO_MIN_VEHICLES - 1, heldStill: T.TRAFFIC_STOPGO_MIN_VEHICLES - 1 })).toBe("light");
  });

  it("bumps one level when well above the camera's recent average (with enough history)", () => {
    expect(trafficLevel({ vehicles: 4, avgVehicles: 2, avgSamples: 5 })).toBe("moderate");
    expect(trafficLevel({ vehicles: 7, avgVehicles: 3, avgSamples: 5 })).toBe("heavy");
    expect(trafficLevel({ vehicles: 4, avgVehicles: 2, avgSamples: 2 })).toBe("light"); // not enough history
    expect(trafficLevel({ vehicles: 2, avgVehicles: 0.5, avgSamples: 9 })).toBe("light"); // too few vehicles
    expect(trafficLevel({ vehicles: 12, avgVehicles: 2, avgSamples: 9 })).toBe("heavy"); // never bumps into stop-and-go
  });

  it("overall level is the median camera level, ties rounded up", () => {
    expect(overallLevel([])).toBeUndefined();
    expect(overallLevel(["light", "light", "heavy"])).toBe("light");
    expect(overallLevel(["light", "heavy"])).toBe("heavy");
    expect(overallLevel(["moderate", "heavy", "stop-and-go"])).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------- reply builders
const NOW = Date.UTC(2026, 9, 12, 12, 0);
let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 450, height: 253, channels: 3, background: "#333" } }).png().toBuffer();
});

const cam = (id: number, name: string, direction: string, area: string, road = "I-85"): Camera => ({ id, name, road, direction, area, lat: 33.8, lng: -84.3 });
const state = (id: number, over: Partial<CameraState> = {}): CameraState => ({
  id, status: "ok", vehicles: 1, stationary: 0, boxes: [], stationaryBoxes: [], night: false, congestion: false, lastChangeAt: NOW - 3 * 60_000, ...over,
});

function input(over: Partial<StatusInput> = {}, states: CameraState[] = []): StatusInput {
  const cameras = [
    cam(1, "I-85 S at Clairmont Rd", "S", "Decatur"),
    cam(2, "I-85 N at Clairmont Rd", "N", "Decatur"),
    cam(3, "I-85 S before GA-400", "S", "Buckhead"),
    cam(4, "I-85 S past Shallowford Rd", "S", "Decatur"),
  ];
  const map = new Map(cameras.map((c) => [c.id, state(c.id)]));
  for (const s of states) map.set(s.id, s);
  return { mode: "live", cameras, states: map, detections: [], latestFrame: () => png, now: NOW, ...over };
}

describe("traffic reply", () => {
  it("summarizes the road, breaks down by area, rates worst first, and attaches 1-2 photos", async () => {
    const r = await buildTrafficReply(input({}, [state(1, { vehicles: 12 }), state(3, { vehicles: 6 })]), "I-85", undefined, "i-85");
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^I-85 traffic: (light|moderate|heavy) overall/);
    expect(lines[0]).toContain("camera snapshots received 3 min ago");
    expect(lines[1]).toBe("• I-85 S near Decatur: heavy (worst at Clairmont Rd)");
    expect(r.text).toContain("• I-85 S before GA-400: moderate");
    expect(r.photos).toHaveLength(2);
    expect(r.photos[0].name).toBe("cam-1.png");
  });

  it("skips frozen/offline cameras and says so; adds the night caveat", async () => {
    const r = await buildTrafficReply(input({}, [state(2, { status: "frozen" }), state(4, { status: "unavailable" }), state(3, { night: true })]), "I-85", undefined, "i-85");
    expect(r.text).toContain("2 cams skipped (frozen/offline)");
    expect(r.text).toContain("night: counts may be low");
    expect(r.text).not.toContain("I-85 N at Clairmont Rd");
  });

  it("limits a landmark question to the named camera and its nearest neighbors", async () => {
    const cams = [
      cam(1, "I-85 S at Clairmont Rd", "S", "Decatur"),
      { ...cam(5, "I-85 S near Airport", "S", "Airport"), lat: 33.6, lng: -84.4 },
      { ...cam(6, "I-85 S past Shallowford Rd", "S", "Decatur"), lat: 33.81, lng: -84.3 },
      { ...cam(7, "I-85 S at Sylvan Rd", "S", "Airport"), lat: 33.65, lng: -84.4 },
    ];
    const r = await buildTrafficReply(input({ cameras: cams, states: new Map(cams.map((c) => [c.id, state(c.id)])) }), "I-85", undefined, "i-85 near clairmont");
    expect(r.text).toContain("Clairmont");
    expect(r.text).toContain("Shallowford");
    expect(r.text).not.toContain("Airport"); // farthest camera dropped (1 named + 2 neighbors)
  });

  it("filters by direction and labels the place", async () => {
    const r = await buildTrafficReply(input(), "I-85", undefined, "i-85 s near clairmont", "S");
    expect(r.text.split("\n")[0]).toMatch(/^I-85 S near Clairmont traffic:/);
    expect(r.text).not.toContain("I-85 N at Clairmont");
  });

  it("is honest when no camera is live", async () => {
    const all = [1, 2, 3, 4].map((id) => state(id, { status: "frozen" }));
    const r = await buildTrafficReply(input({}, all), "I-85", undefined, "i-85");
    expect(r.text).toContain("no live camera images right now");
    expect(r.photos).toHaveLength(0);
  });

  it("keeps the REPLAY prefix", async () => {
    const r = await buildTrafficReply(input({ mode: "replay" }), "I-85", undefined, "i-85");
    expect(r.text.startsWith("REPLAY (recorded data, not live): ")).toBe(true);
  });
});

describe("existing status reply", () => {
  it("still answers 'how's I-85' and now includes the traffic level", async () => {
    const r = await buildStatusReply(input(), "I-85", undefined, "i-85");
    expect(r.text).toMatch(/^I-85: 4\/4 cams live, ~\d+ vehicles in these views · traffic light · no stalled vehicles flagged/);
    expect(r.photos).toHaveLength(3);
  });
  it("respects the direction filter", async () => {
    const r = await buildStatusReply(input(), "I-85", undefined, "i-85 s near clairmont", "S");
    expect(r.text).toMatch(/^I-85 S near Clairmont: 3\/3 cams live/);
  });
});

describe("stalls, cameras and subscriptions replies", () => {
  const det = (over: Partial<Detection>): Detection => ({
    id: "d1", cameraId: 1, cameraName: "I-85 S at Clairmont Rd", road: "I-85", direction: "S", source: "live", kind: "stall",
    firstSeenAt: NOW - 600_000, flaggedAt: NOW, lastSeenAt: NOW, stationaryMinutes: 6, box: { x: 1, y: 1, w: 10, h: 10, cls: "car", score: 0.8 },
    night: false, status: "active", snapshots: [], arrival: "verified", ...over,
  });

  it("lists active detections with a photo each (max 3)", async () => {
    const dets = [det({ id: "a" }), det({ id: "b", cameraId: 3, cameraName: "I-85 S before GA-400", arrival: "unverified" }), det({ id: "c" }), det({ id: "d" })];
    const r = await buildIncidentsReply(input({ detections: dets }));
    expect(r.text).toContain("⚠️ 4 stationary vehicles flagged:");
    expect(r.text).toContain("1. I-85 S at Clairmont Rd (Decatur): stopped 6 min · AI: unconfirmed");
    expect(r.text).toContain("unverified (already there when monitoring began)");
    expect(r.photos).toHaveLength(3);
  });

  it("says when nothing is flagged and how many cameras are watched", async () => {
    const r = await buildIncidentsReply(input({ mode: "replay" }));
    expect(r.text).toBe("REPLAY (recorded data, not live): ✅ No stalled vehicles flagged right now. Watching 4 cameras (4 live).");
  });

  it("lists a road's cameras with areas and non-OK status", () => {
    const r = buildCamerasReply(input({}, [state(2, { status: "frozen" })]), "I-85", undefined, "i-85");
    expect(r.text).toContain("I-85 cameras (4):");
    expect(r.text).toContain("• I-85 N at Clairmont Rd · Decatur · feed frozen");
    expect(buildCamerasReply(input(), undefined, undefined, "").text).toContain("I watch 4 cameras: I-85 (4)");
  });

  it("shows the sender's subscriptions and when each ends; never another person's", () => {
    const subs = [
      { phone: "+1", spaceId: "s", road: "I-85", window: { start: "07:00", end: "09:00" }, createdAt: 0 },
      { phone: "+1", spaceId: "s", road: "I-75", until: NOW + 90 * 60_000, createdAt: 0 },
      { phone: "+2", spaceId: "t", road: "I-20", until: NOW + 60_000, createdAt: 0 },
    ];
    const r = buildSubscriptionsReply({ mode: "live", now: NOW }, subs, "+1");
    expect(r.text).toContain("• I-85: daily 7am–9am, on now, ends 9am");
    expect(r.text).toContain("• I-75: until 9:30 AM (on now)");
    expect(r.text).not.toContain("I-20");
    expect(buildSubscriptionsReply({ mode: "live", now: NOW }, subs, "+3").text).toContain("You're not watching any roads");
  });
});
