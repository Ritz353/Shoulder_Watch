// Run the vehicle detector once on a live camera (or a local PNG) and save an annotated image.
// usage: npm run detect:sample -- <cameraId | path/to/frame.png> [out.png]
import fs from "node:fs/promises";
import { analyzeFrame, annotate } from "../src/lib/detector";
import { fetchSnapshot } from "../src/lib/poller";

const [target, outArg] = process.argv.slice(2);
if (!target) {
  console.error("usage: npm run detect:sample -- <cameraId | file.png> [out.png]");
  process.exit(1);
}
const png = /^\d+$/.test(target) ? (await fetchSnapshot(Number(target))).png : await fs.readFile(target);
const t0 = performance.now();
const a = await analyzeFrame(png);
const ms = Math.round(performance.now() - t0);
const out = outArg ?? `detect-${target.replace(/\W+/g, "_")}.png`;
await fs.writeFile(out, await annotate(png, a.boxes));
console.log(`${a.boxes.length} vehicles in ${ms} ms (mean luma ${a.meanLuma.toFixed(0)}${a.night ? ", night" : ""}) -> ${out}`);
for (const b of a.boxes) console.log(`  ${b.cls.padEnd(10)} ${b.score.toFixed(2)}  x=${b.x} y=${b.y} w=${b.w} h=${b.h}`);
