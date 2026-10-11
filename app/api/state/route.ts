import { loadDetections, loadManualChecks, loadState } from "@/src/lib/store";

export const dynamic = "force-dynamic";

// Everything the dashboard needs in one poll. Reads files the worker writes; no secrets included.
export async function GET() {
  const state = loadState();
  const detections = loadDetections()
    .sort((a, b) => b.flaggedAt - a.flaggedAt)
    .slice(0, 100);
  return Response.json(
    { state, detections, manual: loadManualChecks(), serverTime: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
