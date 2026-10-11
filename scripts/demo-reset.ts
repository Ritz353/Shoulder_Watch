// Reset the demo: wipe runtime data (frames, detections, subscribers, alert log, manual checks)
// and seed the detections log with the REAL recorded detections in ./replay (labelled REPLAY).
//
//   npm run demo:reset
//
// Stop the worker first; restart it afterwards (live or replay).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, REPLAY_DIR, ensureDirs, paths } from "../src/lib/store";
import type { Detection } from "../src/lib/types";

for (const p of [paths.state, paths.detections, paths.subscribers, paths.manual, paths.alertsLog]) fs.rmSync(p, { force: true });
for (const d of [paths.live, paths.snapshots]) fs.rmSync(d, { recursive: true, force: true });
ensureDirs();

const seeds: Detection[] = [];
if (fs.existsSync(REPLAY_DIR)) {
  for (const e of fs.readdirSync(REPLAY_DIR, { withFileTypes: true })) {
    const f = path.join(REPLAY_DIR, e.name, "detection.json");
    if (e.isDirectory() && fs.existsSync(f)) seeds.push({ ...(JSON.parse(fs.readFileSync(f, "utf8")) as Detection), source: "replay" });
  }
}
fs.writeFileSync(paths.detections, JSON.stringify(seeds, null, 2));
console.log(`Reset ${path.relative(process.cwd(), DATA_DIR)}/. Seeded ${seeds.length} recorded detection(s) from replay/ (shown with a REPLAY badge).`);
console.log("Next: npm run worker   (live)   or   npm run worker:replay   (venue Wi-Fi down)");
