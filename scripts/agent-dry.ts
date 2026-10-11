// Offline check of the iMessage agent: parse a message exactly like the agent does and print
// the reply it would send, saving the attached photos. Uses the worker's real live data
// (data/state.json + data/live/*.png); no Photon credentials needed.
//
//   npm run agent:dry -- "how's traffic on I-85?" [outDir] [--from=+14045550123]
//   (--from picks whose subscriptions "what am I watching?" shows)
import fs from "node:fs";
import path from "node:path";
import { parseCommand } from "../src/lib/commands";
import { buildReply } from "../src/lib/status-reply";
import { DATA_DIR, loadCameras, loadDetections, loadState, loadSubscribers, paths } from "../src/lib/store";

const args = process.argv.slice(2);
const from = args.find((a) => a.startsWith("--from="))?.slice(7) ?? "+10000000000";
const [msg = "how's I-75?", outDir = "agent-dry-out"] = args.filter((a) => !a.startsWith("--"));
const cmd = parseCommand(msg);
console.log(`> ${msg}\n  parsed: ${JSON.stringify(cmd)}`);

const state = loadState();
if (!state) {
  console.error(`No worker state in ${DATA_DIR}. Run \`npm run worker\` first.`);
  process.exit(1);
}
const watched = new Set(state.cameras.map((c) => c.id));
const reply = await buildReply(
  cmd,
  {
    mode: state.mode,
    cameras: loadCameras().filter((c) => watched.has(c.id)),
    states: new Map(state.cameras.map((c) => [c.id, c])),
    detections: loadDetections(),
    latestFrame: (id) => {
      const f = path.join(paths.live, `${id}.png`);
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    },
  },
  { phone: from, subscriptions: loadSubscribers() },
);
if (!reply) {
  console.log("  (watch/stop change state; they are handled by the live agent - see README)");
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
for (const p of reply.photos) fs.writeFileSync(path.join(outDir, p.name), p.png);
console.log(`\n< ${reply.text.replace(/\n/g, "\n  ")}\n  [${reply.photos.length} photo(s)${reply.photos.length ? ` saved to ${outDir}/: ${reply.photos.map((p) => p.name).join(", ")}` : ""}]`);
