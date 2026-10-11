// Optional official 511GA API integration. Only active when SHOULDERWATCH_511GA_KEY is set.
// Documented endpoints only (https://511ga.org/developers/doc):
//   GET https://511ga.org/api/v2/get/event?key=...&format=json
//   GET https://511ga.org/api/v2/get/cameras?key=...&format=json
// Throttle: 10 calls / 60 s. We cache events for 2 min and cameras for 24 h (on disk).

import { THRESHOLDS } from "../../config/thresholds";
import { WindowLimiter } from "./ratelimit";
import { paths, readJson, writeJson } from "./store";
import type { Camera, Detection } from "./types";

export interface Ga511Event {
  ID: number;
  RoadwayName?: string;
  DirectionOfTravel?: string;
  Description?: string;
  Reported?: number; // unix seconds
  StartDate?: number;
  LastUpdated?: number;
  Latitude: number;
  Longitude: number;
  EventType?: string;
  IsFullClosure?: boolean;
}

interface Cache {
  events?: { at: number; data: Ga511Event[] };
  cameras?: { at: number; data: unknown[] };
}

const limiter = new WindowLimiter(THRESHOLDS.GA511_MAX_CALLS_PER_MINUTE, 60_000);

export const ga511Key = () => process.env.SHOULDERWATCH_511GA_KEY || "";
export const ga511Enabled = () => Boolean(ga511Key());

async function call<T>(endpoint: "event" | "cameras"): Promise<T> {
  if (!limiter.tryTake()) throw new Error("511GA rate limit reached locally; using cache");
  const url = `https://511ga.org/api/v2/get/${endpoint}?key=${encodeURIComponent(ga511Key())}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`511GA ${endpoint} HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function getEvents(now = Date.now()): Promise<Ga511Event[]> {
  const cache = readJson<Cache>(paths.ga511Cache, {});
  if (cache.events && now - cache.events.at < THRESHOLDS.GA511_EVENTS_CACHE_MS) return cache.events.data;
  try {
    const data = await call<Ga511Event[]>("event");
    await writeJson(paths.ga511Cache, { ...cache, events: { at: now, data } });
    return data;
  } catch (e) {
    if (cache.events) return cache.events.data; // stale is better than nothing
    throw e;
  }
}

/** Cached official camera list - used by scripts/validate-cameras.ts to fill in names/coords. */
export async function getCameraList(now = Date.now()): Promise<unknown[]> {
  const cache = readJson<Cache>(paths.ga511Cache, {});
  if (cache.cameras && now - cache.cameras.at < THRESHOLDS.GA511_CAMERAS_CACHE_MS) return cache.cameras.data;
  const data = await call<unknown[]>("cameras");
  await writeJson(paths.ga511Cache, { ...readJson<Cache>(paths.ga511Cache, {}), cameras: { at: now, data } });
  return data;
}

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Match a detection to an official incident near the camera around the same time. */
export function matchOfficial(det: Detection, cam: Camera, events: Ga511Event[], now = Date.now()): NonNullable<Detection["official"]> {
  const candidates = events
    .filter((e) => e.EventType !== "roadwork" && e.EventType !== "specialEvents")
    .filter((e) => haversineM(cam.lat, cam.lng, e.Latitude, e.Longitude) <= THRESHOLDS.GA511_MATCH_RADIUS_M)
    .filter((e) => {
      const t = (e.Reported ?? e.StartDate ?? 0) * 1000;
      return Math.abs(t - det.firstSeenAt) <= THRESHOLDS.GA511_MATCH_WINDOW_MS;
    });
  if (!candidates.length) return { status: "not_on_511ga", checkedAt: now };
  const e = candidates.sort((a, b) => (a.Reported ?? 0) - (b.Reported ?? 0))[0];
  const reported = (e.Reported ?? e.StartDate ?? 0) * 1000;
  return {
    status: "matched",
    eventId: e.ID,
    description: e.Description,
    minutesBefore: Math.round((reported - det.flaggedAt) / 60_000),
    checkedAt: now,
  };
}
