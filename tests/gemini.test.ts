import { afterEach, describe, expect, it, vi } from "vitest";
import { UNCONFIRMED_LABEL, confirmWithGemini, validateAiText } from "../src/lib/gemini";

const ok = (o: object) => JSON.stringify(o);

describe("Gemini response validation", () => {
  it("accepts a well-formed stalled_vehicle verdict", () => {
    const r = validateAiText(ok({ verdict: "stalled_vehicle", evidence: "Sedan stopped on the right shoulder while traffic flows.", confidence_note: "none" }), "m");
    expect(r).toMatchObject({ status: "confirmed", verdict: "stalled_vehicle" });
    expect(r.label).not.toMatch(/%/);
  });

  it.each([
    ["not JSON", "Sure! It looks stalled."],
    ["empty", ""],
    ["unknown verdict", ok({ verdict: "accident", evidence: "Two cars touching.", confidence_note: "none" })],
    ["fabricated confidence", ok({ verdict: "stalled_vehicle", evidence: "Car on shoulder.", confidence_note: "92% confident" })],
    ["extra fields", ok({ verdict: "stalled_vehicle", evidence: "Car on shoulder.", confidence_note: "none", confidence: 0.92 })],
    ["missing evidence", ok({ verdict: "stalled_vehicle", confidence_note: "none" })],
    ["array instead of object", ok([{ verdict: "stalled_vehicle" }])],
  ])("rejects %s -> unconfirmed (AI unavailable)", (_name, text) => {
    const r = validateAiText(text, "m");
    expect(r.status).toBe("unconfirmed");
    expect(r.label).toBe(UNCONFIRMED_LABEL);
    expect(r.verdict).toBeUndefined();
  });

  it("treats an 'unclear' verdict as ambiguous: unconfirmed, but keeps the evidence text", () => {
    const r = validateAiText(ok({ verdict: "unclear", evidence: "Image too dark to tell.", confidence_note: "none" }), "m");
    expect(r.status).toBe("unconfirmed");
    expect(r.label).toBe(UNCONFIRMED_LABEL);
    expect(r.evidence).toBe("Image too dark to tell.");
  });
});

describe("confirmWithGemini degrades gracefully", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns unconfirmed without calling the network when no key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const f = vi.fn();
    const r = await confirmWithGemini(Buffer.from("png"), f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
    expect(r.label).toBe(UNCONFIRMED_LABEL);
  });

  it("returns unconfirmed on HTTP errors and network failures", async () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("GEMINI_MODEL", "gemini-test");
    const r1 = await confirmWithGemini(Buffer.from("png"), (async () => new Response("quota", { status: 429 })) as typeof fetch);
    expect(r1).toMatchObject({ status: "unconfirmed", detail: "Gemini HTTP 429" });
    const r2 = await confirmWithGemini(Buffer.from("png"), (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch);
    expect(r2.status).toBe("unconfirmed");
  });

  it("parses a structured response and sends the key in a header, not the URL", async () => {
    vi.stubEnv("GEMINI_API_KEY", "secret-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-test");
    let url = "";
    let headers: Record<string, string> = {};
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return Response.json({ candidates: [{ content: { parts: [{ text: ok({ verdict: "parked_or_work_zone", evidence: "Truck with cones behind it.", confidence_note: "none" }) }] } }] });
    }) as unknown as typeof fetch;
    const r = await confirmWithGemini(Buffer.from("png"), f);
    expect(r).toMatchObject({ status: "confirmed", verdict: "parked_or_work_zone" });
    expect(url).not.toContain("secret-key");
    expect(headers["x-goog-api-key"]).toBe("secret-key");
  });
});
