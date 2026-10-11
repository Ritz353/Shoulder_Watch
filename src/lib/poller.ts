// Polite image fetching from the public 511GA snapshot URLs. Only https://511ga.org/map/Cctv/{id} is used.

import crypto from "node:crypto";
import { THRESHOLDS } from "../../config/thresholds";

export const SNAPSHOT_URL = (id: number) => `https://511ga.org/map/Cctv/${id}`;
export const USER_AGENT = process.env.SHOULDERWATCH_USER_AGENT || "ShoulderWatch/0.1 (Hacklanta 2026 hackathon project)";

/** SHA-1s of the placeholders 511GA serves for dead cameras ("STREAM NOT AVAILABLE", "No live camera feed"). */
export const UNAVAILABLE_HASHES = new Set(["e851dacfdfcc51436f9af7accc75808b25a7c489", "7063c3929559b480e4c4874b8064082603994c69"]);

export interface Snapshot {
  png: Buffer;
  hash: string;
  fetchedAt: number;
  unavailable: boolean;
}

export class FetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function sha1(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

export async function fetchSnapshot(id: number, fetchImpl: typeof fetch = fetch): Promise<Snapshot> {
  let res: Response;
  try {
    res = await fetchImpl(SNAPSHOT_URL(id), {
      headers: { "User-Agent": USER_AGENT, Accept: "image/png,image/*" },
      signal: AbortSignal.timeout(THRESHOLDS.FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new FetchError(e instanceof Error && e.name === "TimeoutError" ? "timeout" : `network: ${(e as Error).message}`);
  }
  if (!res.ok) throw new FetchError(`HTTP ${res.status}`, res.status);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new FetchError(`unexpected content-type ${type}`);
  const png = Buffer.from(await res.arrayBuffer());
  if (png.length < 100) throw new FetchError("empty image");
  const hash = sha1(png);
  return { png, hash, fetchedAt: Date.now(), unavailable: UNAVAILABLE_HASHES.has(hash) };
}

/** Next poll delay: base interval + jitter, doubled per consecutive failure, capped. */
export function nextDelay(failures: number, rand: () => number = Math.random): number {
  const base = THRESHOLDS.POLL_INTERVAL_MS * 2 ** Math.min(failures, 10);
  return Math.min(base, THRESHOLDS.BACKOFF_MAX_MS) + Math.floor(rand() * THRESHOLDS.POLL_JITTER_MS);
}
