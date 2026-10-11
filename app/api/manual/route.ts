import { z } from "zod";
import { loadManualChecks, paths, writeJson } from "@/src/lib/store";

// Manual 511GA comparison (used while the API key is pending): record whether a detection
// also appeared on the public 511GA map. Stored separately from detections.json so the
// dashboard never races the worker on the same file.
const body = z.object({ detectionId: z.string().min(1).max(80), onMap: z.enum(["yes", "no", "unsure"]) });

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
  const all = loadManualChecks();
  all[parsed.data.detectionId] = { ...parsed.data, at: Date.now() };
  await writeJson(paths.manual, all);
  return Response.json({ ok: true });
}
