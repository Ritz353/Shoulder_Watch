// Outgoing-alert limiter for the shared iMessage line. Pure + serializable so it survives restarts.
//
// Rules (from config/thresholds.ts):
//  1. Never send the same detection to the same person twice (dedupe).
//  2. At most one alert per person per ALERT_MIN_GAP_PER_RECIPIENT_MS.
//  3. At most ALERT_MAX_PER_HOUR alerts in total per rolling hour.

import { THRESHOLDS } from "../../config/thresholds";

export interface AlertLog {
  sent: { to: string; detectionId: string; at: number }[];
}

export type AlertDecision = { ok: true } | { ok: false; reason: "duplicate" | "recipient_cooldown" | "global_cap" };

export function canSendAlert(
  log: AlertLog,
  to: string,
  detectionId: string,
  now: number,
  cfg: { gapMs: number; maxPerHour: number } = { gapMs: THRESHOLDS.ALERT_MIN_GAP_PER_RECIPIENT_MS, maxPerHour: THRESHOLDS.ALERT_MAX_PER_HOUR },
): AlertDecision {
  if (log.sent.some((s) => s.to === to && s.detectionId === detectionId)) return { ok: false, reason: "duplicate" };
  const last = log.sent.filter((s) => s.to === to).reduce((m, s) => Math.max(m, s.at), -Infinity);
  if (now - last < cfg.gapMs) return { ok: false, reason: "recipient_cooldown" };
  if (log.sent.filter((s) => now - s.at < 3_600_000).length >= cfg.maxPerHour) return { ok: false, reason: "global_cap" };
  return { ok: true };
}

export function recordAlert(log: AlertLog, to: string, detectionId: string, now: number): void {
  log.sent.push({ to, detectionId, at: now });
  // Keep a day of history (enough for dedupe of any active detection).
  log.sent = log.sent.filter((s) => now - s.at < 24 * 3_600_000);
}

export function forgetRecipient(log: AlertLog, to: string): void {
  log.sent = log.sent.filter((s) => s.to !== to);
}

/** Sliding-window limiter for API calls (511GA allows 10 calls / 60 s). */
export class WindowLimiter {
  private calls: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  tryTake(): boolean {
    const t = this.now();
    this.calls = this.calls.filter((c) => t - c < this.windowMs);
    if (this.calls.length >= this.max) return false;
    this.calls.push(t);
    return true;
  }
}
