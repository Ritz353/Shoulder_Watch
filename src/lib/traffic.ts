// Traffic level per camera from data the worker already has. Pure - unit tested.
// Cutoffs live in config/thresholds.ts (TRAFFIC_*).

import { THRESHOLDS } from "../../config/thresholds";

export const LEVELS = ["light", "moderate", "heavy", "stop-and-go"] as const;
export type TrafficLevel = (typeof LEVELS)[number];

export interface TrafficInput {
  vehicles: number; // boxes in the latest fresh frame (ignore zones excluded)
  heldStill?: number; // of those, how many were at the same spot one fresh frame earlier
  avgVehicles?: number; // mean count over the camera's rolling buffer
  avgSamples?: number; // frames behind that mean
  congestion?: boolean; // the tracker's congestion flag
}

export const levelRank = (l: TrafficLevel) => LEVELS.indexOf(l);

export function trafficLevel(s: TrafficInput, cfg = THRESHOLDS): TrafficLevel {
  const v = s.vehicles;
  const still = v > 0 ? (s.heldStill ?? 0) / v : 0;
  if (s.congestion || (v >= cfg.TRAFFIC_STOPGO_MIN_VEHICLES && still >= cfg.TRAFFIC_STOPGO_STILL_FRACTION)) return "stop-and-go";
  let rank = v >= cfg.TRAFFIC_HEAVY_VEHICLES ? 2 : v >= cfg.TRAFFIC_MODERATE_VEHICLES ? 1 : 0;
  // Plenty of vehicles and a good share of them not moving between frames: it's slowing down.
  if (rank === 1 && still >= cfg.TRAFFIC_HEAVY_STILL_FRACTION) rank = 2;
  // Busier than this camera usually is (only with enough history to trust the average).
  const avg = s.avgVehicles ?? 0;
  if (rank < 2 && (s.avgSamples ?? 0) >= cfg.TRAFFIC_AVG_MIN_SAMPLES && avg > 0 && v >= cfg.TRAFFIC_AVG_MIN_VEHICLES && v >= cfg.TRAFFIC_ABOVE_AVG_RATIO * avg) rank++;
  return LEVELS[rank];
}

/** Road-wide summary level: the median camera level (ties round up, toward caution). */
export function overallLevel(levels: TrafficLevel[]): TrafficLevel | undefined {
  if (!levels.length) return undefined;
  const ranks = levels.map(levelRank).sort((a, b) => a - b);
  return LEVELS[ranks[Math.floor(ranks.length / 2)]];
}
