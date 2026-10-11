// Validate config/cameras.json: schema, duplicates, and that each public image URL loads.
// Requests are sequential, ~1/s, with the polite User-Agent.
//
//   npm run cameras:validate                  check every camera
//   npm run cameras:validate -- 1695 1771     check specific IDs (handy when adding new ones)
//   npm run cameras:validate -- --fix-coords  (needs SHOULDERWATCH_511GA_KEY) replace approximate
//                                             lat/lng with official values from the cameras API
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ga511Enabled, getCameraList } from "../src/lib/ga511";
import { fetchSnapshot } from "../src/lib/poller";
import { ensureDirs } from "../src/lib/store";

const cameraSchema = z.object({
  id: z.number().int().positive(),
  gdot: z.string().optional(),
  name: z.string().min(3),
  road: z.enum(["I-75", "I-85", "I-75/85", "I-285", "I-20", "I-675", "I-575", "I-985", "GA-400"]),
  direction: z.string().min(1),
  lat: z.number().min(33.3).max(34.3),
  lng: z.number().min(-84.9).max(-83.9),
  area: z.string().optional(),
  ignoreZones: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
});

const file = path.join(process.cwd(), "config", "cameras.json");
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const fixCoords = args.includes("--fix-coords");
const only = args.filter((a) => /^\d+$/.test(a)).map(Number);

let errors = 0;
const seen = new Set<number>();
for (const c of doc.cameras) {
  const r = cameraSchema.safeParse(c);
  if (!r.success) {
    errors++;
    console.log(`✗ ${c.id ?? "?"}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  if (seen.has(c.id)) {
    errors++;
    console.log(`✗ duplicate id ${c.id}`);
  }
  seen.add(c.id);
}

const targets = only.length ? only.map((id) => doc.cameras.find((c: { id: number }) => c.id === id) ?? { id, name: "(not in cameras.json)" }) : doc.cameras;
console.log(`Checking ${targets.length} image URL(s)...`);
const counts = { ok: 0, unavailable: 0, failed: 0 };
for (const c of targets) {
  try {
    const s = await fetchSnapshot(c.id);
    if (s.unavailable) {
      counts.unavailable++;
      console.log(`! ${String(c.id).padEnd(6)} ${c.name} - 511GA placeholder "stream not available" (camera exists but is offline now)`);
    } else {
      counts.ok++;
      console.log(`✓ ${String(c.id).padEnd(6)} ${c.name} (${(s.png.length / 1024).toFixed(0)} KB)`);
    }
  } catch (e) {
    counts.failed++;
    console.log(`✗ ${String(c.id).padEnd(6)} ${c.name} - ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 1_000));
}

if (fixCoords) {
  if (!ga511Enabled()) {
    console.log("--fix-coords needs SHOULDERWATCH_511GA_KEY (key pending) - coordinates left as approximate.");
  } else {
    ensureDirs();
    const list = (await getCameraList()) as { Id: number; Latitude: number; Longitude: number; Location?: string; Views?: { Id: number; Url: string }[] }[];
    let fixed = 0;
    for (const c of doc.cameras) {
      const hit = list.find((o) => o.Id === c.id || o.Views?.some((v) => v.Id === c.id || v.Url.endsWith(`/${c.id}`)));
      if (hit) {
        c.lat = hit.Latitude;
        c.lng = hit.Longitude;
        fixed++;
      }
    }
    if (fixed === doc.cameras.length) doc.coordsSource = "511ga"; // map stops showing "positions approximate"
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    console.log(`Updated official coordinates for ${fixed}/${doc.cameras.length} cameras.`);
  }
}

console.log(`\n${counts.ok} ok, ${counts.unavailable} offline placeholder, ${counts.failed} failed, ${errors} config error(s).`);
process.exit(errors || counts.failed ? 1 : 0);
