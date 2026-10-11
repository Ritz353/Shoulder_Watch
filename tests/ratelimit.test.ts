import { describe, expect, it } from "vitest";
import { nextDelay } from "../src/lib/poller";
import { THRESHOLDS } from "../config/thresholds";
import { WindowLimiter, canSendAlert, forgetRecipient, recordAlert, type AlertLog } from "../src/lib/ratelimit";

const cfg = { gapMs: 10 * 60_000, maxPerHour: 3 };
const T0 = 1_800_000_000_000;

describe("alert rate limiting", () => {
  it("never sends the same detection to the same person twice", () => {
    const log: AlertLog = { sent: [] };
    recordAlert(log, "+14045550001", "det-1", T0);
    expect(canSendAlert(log, "+14045550001", "det-1", T0 + 3_600_000, cfg)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("enforces a per-recipient cooldown across different detections", () => {
    const log: AlertLog = { sent: [] };
    recordAlert(log, "+14045550001", "det-1", T0);
    expect(canSendAlert(log, "+14045550001", "det-2", T0 + 5 * 60_000, cfg)).toEqual({ ok: false, reason: "recipient_cooldown" });
    expect(canSendAlert(log, "+14045550001", "det-2", T0 + 11 * 60_000, cfg)).toEqual({ ok: true });
    expect(canSendAlert(log, "+14045550002", "det-1", T0 + 60_000, cfg)).toEqual({ ok: true });
  });

  it("enforces a global hourly cap for the shared line", () => {
    const log: AlertLog = { sent: [] };
    for (let i = 0; i < 3; i++) recordAlert(log, `+1404555000${i}`, "det-1", T0 + i);
    expect(canSendAlert(log, "+14045559999", "det-1", T0 + 10, cfg)).toEqual({ ok: false, reason: "global_cap" });
    expect(canSendAlert(log, "+14045559999", "det-1", T0 + 3_600_001, cfg)).toEqual({ ok: true });
  });

  it("forgets a recipient entirely on stop (privacy)", () => {
    const log: AlertLog = { sent: [] };
    recordAlert(log, "+14045550001", "det-1", T0);
    recordAlert(log, "+14045550002", "det-1", T0);
    forgetRecipient(log, "+14045550001");
    expect(log.sent.map((s) => s.to)).toEqual(["+14045550002"]);
  });

  it("prunes history older than a day", () => {
    const log: AlertLog = { sent: [] };
    recordAlert(log, "+1", "a", T0);
    recordAlert(log, "+2", "b", T0 + 25 * 3_600_000);
    expect(log.sent).toHaveLength(1);
  });
});

describe("511GA API limiter (10 calls / 60 s)", () => {
  it("allows 10 calls per window then refuses until the window slides", () => {
    let t = 0;
    const lim = new WindowLimiter(10, 60_000, () => t);
    for (let i = 0; i < 10; i++) expect(lim.tryTake()).toBe(true);
    expect(lim.tryTake()).toBe(false);
    t = 60_001;
    expect(lim.tryTake()).toBe(true);
  });
});

describe("polling backoff", () => {
  it("polls at most once per interval, with jitter, and backs off exponentially to a cap", () => {
    expect(nextDelay(0, () => 0)).toBe(THRESHOLDS.POLL_INTERVAL_MS);
    expect(nextDelay(0, () => 0.999)).toBeLessThan(THRESHOLDS.POLL_INTERVAL_MS + THRESHOLDS.POLL_JITTER_MS);
    expect(nextDelay(2, () => 0)).toBe(THRESHOLDS.POLL_INTERVAL_MS * 4);
    expect(nextDelay(50, () => 0)).toBe(THRESHOLDS.BACKOFF_MAX_MS);
  });
});
