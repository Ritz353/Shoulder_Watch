// Optional AI confirmation of a flagged frame with Google Gemini (structured output).
// Server-side only. Any failure => the detection is kept and marked "unconfirmed (AI unavailable)".
// We never produce or display a confidence percentage.

import { z } from "zod";
import type { AiResult, Verdict } from "./types";

export const VERDICTS = ["stalled_vehicle", "stopped_traffic", "parked_or_work_zone", "unclear"] as const;

export const UNCONFIRMED_LABEL = "unconfirmed (AI unavailable)";

/** JSON schema sent to Gemini (OpenAPI subset accepted by responseSchema). */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: [...VERDICTS] },
    evidence: { type: "STRING", description: "One short sentence describing only what is visible in the image." },
    confidence_note: { type: "STRING", enum: ["none"], description: "Always the literal string none. Do not estimate confidence." },
  },
  required: ["verdict", "evidence", "confidence_note"],
  propertyOrdering: ["verdict", "evidence", "confidence_note"],
};

export const aiResponseSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    evidence: z.string().trim().min(3).max(300),
    confidence_note: z.literal("none"),
  })
  .strict();

export type AiResponse = z.infer<typeof aiResponseSchema>;

export const VERDICT_LABEL: Record<Verdict, string> = {
  stalled_vehicle: "AI: looks like a stalled vehicle",
  stopped_traffic: "AI: stopped traffic",
  parked_or_work_zone: "AI: parked / work zone",
  unclear: "AI: unclear",
};

/**
 * Validate Gemini's raw text. Returns a confirmed result, or an "unconfirmed" one for anything
 * malformed, off-schema, or ambiguous ("unclear" counts as ambiguous).
 */
export function validateAiText(text: string | undefined, model: string, now = Date.now()): AiResult {
  if (!text) return unconfirmed("empty response", model, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unconfirmed("response was not JSON", model, now);
  }
  const r = aiResponseSchema.safeParse(parsed);
  if (!r.success) return unconfirmed(`schema mismatch: ${r.error.issues[0]?.message ?? "invalid"}`, model, now);
  if (r.data.verdict === "unclear") {
    return { ...unconfirmed("model answered unclear", model, now), verdict: "unclear", evidence: r.data.evidence };
  }
  return { status: "confirmed", verdict: r.data.verdict, evidence: r.data.evidence, label: VERDICT_LABEL[r.data.verdict], model, checkedAt: now };
}

export function unconfirmed(detail: string, model?: string, now = Date.now()): AiResult {
  return { status: "unconfirmed", label: UNCONFIRMED_LABEL, detail, model, checkedAt: now };
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL);
}

const PROMPT = `You are reviewing a single low-resolution highway traffic-camera snapshot from the Georgia DOT.
A computer-vision system flagged the vehicle inside the RED rectangle as stationary for several minutes.
Decide what the flagged vehicle most likely is, using only what is visible:
- stalled_vehicle: a vehicle stopped on the shoulder or in a travel lane while other traffic is not stopped.
- stopped_traffic: the lane is congested and many vehicles are stopped together.
- parked_or_work_zone: a parked vehicle off the roadway, a construction/work-zone vehicle, a police/emergency/tow vehicle on scene, or a sign/object misdetected as a vehicle.
- unclear: the image is too dark, blurry, or ambiguous to tell.
Do not try to read license plates or identify people. Describe the visible evidence in one short sentence.
Set confidence_note to the literal string "none".`;

export async function confirmWithGemini(annotatedPng: Buffer, fetchImpl: typeof fetch = fetch): Promise<AiResult> {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!key || !model) return unconfirmed("GEMINI_API_KEY / GEMINI_MODEL not set", model);
  try {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType: "image/png", data: annotatedPng.toString("base64") } }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_RESPONSE_SCHEMA, temperature: 0 },
      }),
    });
    if (!res.ok) return unconfirmed(`Gemini HTTP ${res.status}`, model);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    return validateAiText(text, model);
  } catch (e) {
    return unconfirmed(`Gemini error: ${(e as Error).message}`, model);
  }
}
