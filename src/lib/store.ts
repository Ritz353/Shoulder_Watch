// File-based storage shared by the worker (writer) and the dashboard (reader).
// JSON files + PNGs under SHOULDERWATCH_DATA_DIR. Writes are atomic (tmp + rename) so the
// dashboard never reads a half-written file. Only the worker writes detections/state;
// the dashboard writes manual-checks.json only, so the two never race on a file.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Camera, Detection, ManualCheck, Subscription, WorkerState } from "./types";

export const ROOT = process.cwd();
export const DATA_DIR = path.resolve(ROOT, process.env.SHOULDERWATCH_DATA_DIR || "data");
export const REPLAY_DIR = path.resolve(ROOT, "replay");

export const paths = {
  state: path.join(DATA_DIR, "state.json"),
  detections: path.join(DATA_DIR, "detections.json"),
  subscribers: path.join(DATA_DIR, "subscribers.json"),
  manual: path.join(DATA_DIR, "manual-checks.json"),
  alertsLog: path.join(DATA_DIR, "alerts-sent.json"),
  ga511Cache: path.join(DATA_DIR, "ga511-cache.json"),
  live: path.join(DATA_DIR, "live"),
  snapshots: path.join(DATA_DIR, "snapshots"),
};

export function ensureDirs(): void {
  for (const d of [DATA_DIR, paths.live, paths.snapshots]) fs.mkdirSync(d, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await renameWithRetry(tmp, file);
}

export async function writeFileAtomic(file: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await renameWithRetry(tmp, file);
}

// Windows: rename can fail with EPERM/EBUSY while another process has the target open for reading.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
}

export function loadCameras(): Camera[] {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "config", "cameras.json"), "utf8")).cameras as Camera[];
}

/** Where camera lat/lng came from: hand-placed ("approximate") or the official 511GA cameras API. */
export function loadCoordsSource(): "approximate" | "511ga" {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "cameras.json"), "utf8"));
  return doc.coordsSource === "511ga" ? "511ga" : "approximate";
}

export const loadDetections = () => readJson<Detection[]>(paths.detections, []);
export const loadState = () => readJson<WorkerState | null>(paths.state, null);
export const loadSubscribers = () => readJson<Subscription[]>(paths.subscribers, []);
export const loadManualChecks = () => readJson<Record<string, ManualCheck>>(paths.manual, {});

/**
 * Resolve a stored relative file path (from state/detections) to an absolute path, refusing
 * anything that escapes the data or replay directories.
 */
export function resolveStored(rel: string): string | null {
  const [root, ...rest] = rel.split("/");
  const base = root === "replay" ? REPLAY_DIR : root === "data" ? DATA_DIR : null;
  if (!base) return null;
  const abs = path.resolve(base, ...rest);
  return abs.startsWith(base + path.sep) ? abs : null;
}
