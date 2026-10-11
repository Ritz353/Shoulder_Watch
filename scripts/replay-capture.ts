// Save a real live detection (its frame sequence) as a permanent REPLAY recording in ./replay.
//
//   npm run replay:capture -- <detectionId> ["short note for the banner"]
//   npm run replay:capture -- --list
//
// Recordings are curated demo fixtures and are NOT subject to the 24 h snapshot retention:
// only capture public, low-resolution GDOT frames you are comfortable keeping.
import fs from "node:fs";
import path from "node:path";
import { REPLAY_DIR, loadDetections, resolveStored } from "../src/lib/store";
import type { Detection } from "../src/lib/types";

const [id, note] = process.argv.slice(2);
const dets = loadDetections();

if (!id || id === "--list") {
  const live = dets.filter((d) => d.source === "live" && d.snapshots.length);
  if (!live.length) console.log("No live detections with snapshots yet. Run `npm run worker` and wait for one.");
  for (const d of live)
    console.log(`${d.id}  ${d.cameraName}  ${d.kind}  ${d.stationaryMinutes} min  ${d.snapshots.length} frames  ${d.status}  ${d.ai?.label ?? ""}`);
  process.exit(0);
}

const d = dets.find((x) => x.id === id);
if (!d) {
  console.error(`No detection ${id}. Use --list.`);
  process.exit(1);
}
if (d.snapshots.length < 3) {
  console.error(`Detection ${id} has only ${d.snapshots.length} snapshot(s); need at least 3 for a meaningful replay.`);
  process.exit(1);
}

const dir = path.join(REPLAY_DIR, id);
fs.mkdirSync(dir, { recursive: true });
const frames: { file: string; ts: number }[] = [];
for (const s of d.snapshots) {
  const src = resolveStored(s.file);
  if (!src || !fs.existsSync(src)) continue;
  const file = `${s.ts}.png`;
  fs.copyFileSync(src, path.join(dir, file));
  frames.push({ file, ts: s.ts });
}
const when = new Date(d.firstSeenAt).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
fs.writeFileSync(
  path.join(dir, "manifest.json"),
  JSON.stringify({ cameraId: d.cameraId, note: note || `Recorded ${when} · ${d.cameraName}`, capturedFrom: d.id, frames }, null, 2) + "\n",
);
const seed: Detection = {
  ...d,
  source: "replay",
  status: "cleared",
  snapshots: d.snapshots.filter((s) => frames.some((f) => f.ts === s.ts)).map((s) => ({ ...s, file: `replay/${id}/${s.ts}.png` })),
};
fs.writeFileSync(path.join(dir, "detection.json"), JSON.stringify(seed, null, 2) + "\n");
console.log(`Saved ${frames.length} frames to replay/${id}/ (manifest.json + detection.json). Seed it with: npm run demo:reset`);
