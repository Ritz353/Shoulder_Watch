import fs from "node:fs/promises";
import { resolveStored } from "@/src/lib/store";

export const dynamic = "force-dynamic";

// Serves frame/snapshot PNGs from data/ or replay/ only (path traversal is rejected).
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams.get("p") ?? "";
  const abs = /\.png$/.test(p) ? resolveStored(p) : null;
  if (!abs) return new Response("bad path", { status: 400 });
  try {
    const buf = await fs.readFile(abs);
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
