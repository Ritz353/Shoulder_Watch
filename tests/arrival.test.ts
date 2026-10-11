import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { classifyArrival, regionSignature, signatureDiff } from "../src/lib/detector";
import type { Box } from "../src/lib/types";

const sig = (v: number, noise = 0) => Array.from({ length: 256 }, (_, i) => Math.min(255, v + ((i * 7) % (noise + 1))));

describe("arrival check (rejects signs / lane markings that 'stay put')", () => {
  it("rejects an object whose region matches an earlier frame (it was always there)", () => {
    expect(classifyArrival(sig(180, 4), [sig(60), sig(178, 4)])).toBe("background");
  });

  it("verifies an arrival when the spot looked different in every earlier frame", () => {
    expect(classifyArrival(sig(180), [sig(60), sig(70), sig(65)])).toBe("verified");
  });

  it("marks it unverified when there is too little history (present at startup)", () => {
    expect(classifyArrival(sig(180), [])).toBe("unverified");
    expect(classifyArrival(sig(180), [sig(60)])).toBe("unverified");
  });

  it("measures region similarity on real image crops", async () => {
    const blank = await sharp({ create: { width: 450, height: 253, channels: 3, background: "#404040" } }).png().toBuffer();
    const withCar = await sharp(blank)
      .composite([{ input: await sharp({ create: { width: 30, height: 20, channels: 3, background: "#f0f0f0" } }).png().toBuffer(), left: 200, top: 120 }])
      .png()
      .toBuffer();
    const box: Box = { x: 200, y: 120, w: 30, h: 20, cls: "car", score: 0.8 };
    const a = await regionSignature(withCar, box);
    expect(signatureDiff(a, await regionSignature(withCar, box))).toBe(0);
    expect(signatureDiff(a, await regionSignature(blank, box))).toBeGreaterThan(50);
  });
});
