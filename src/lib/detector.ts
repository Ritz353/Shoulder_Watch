// Local vehicle detector: YOLOv8s (COCO) exported to ONNX at 960x544, run on CPU with onnxruntime-node.
// No cloud calls. ~100-200 ms per 450x253 frame on a laptop CPU. The 16:9 input upsamples the tiny
// GDOT frames ~2x, which matters: at 640 input most distant vehicles are only a few pixels wide.

import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { THRESHOLDS } from "../../config/thresholds";
import type { Box } from "./types";

const INPUT_W = 960;
const INPUT_H = 544;
const VEHICLE_CLASSES: Record<number, Box["cls"]> = { 2: "car", 3: "motorcycle", 5: "bus", 7: "truck" };

let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function modelPath(): string {
  return path.join(process.cwd(), "models", "yolov8s-960x544.onnx");
}

function session(): Promise<ort.InferenceSession> {
  sessionPromise ??= ort.InferenceSession.create(modelPath(), { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
  return sessionPromise;
}

export interface FrameAnalysis {
  boxes: Box[];
  width: number;
  height: number;
  meanLuma: number;
  night: boolean;
  /** 32x18 grayscale thumbnail for scene-change detection. */
  thumb: number[];
}

/** Grayscale stats only (cheap) - used for frozen/unavailable frames that we don't run YOLO on. */
export async function thumbnail(png: Buffer): Promise<{ thumb: number[]; meanLuma: number }> {
  const raw = await sharp(png).grayscale().resize(32, 18, { fit: "fill" }).raw().toBuffer();
  const thumb = Array.from(raw);
  return { thumb, meanLuma: thumb.reduce((a, b) => a + b, 0) / thumb.length };
}

export async function analyzeFrame(png: Buffer): Promise<FrameAnalysis> {
  const { thumb, meanLuma } = await thumbnail(png);
  const night = meanLuma < THRESHOLDS.NIGHT_LUMA_MAX;
  // Dark frames: local contrast enhancement (CLAHE) before detection. Measured on 34 live
  // night frames: +12% boxes overall, and it finds taillight-lit cars the raw frame misses.
  let img = sharp(png).removeAlpha();
  if (night) img = sharp(await img.clahe({ width: 32, height: 32, maxSlope: 3 }).png().toBuffer());
  const meta = await img.metadata();
  const width = meta.width ?? 450;
  const height = meta.height ?? 253;

  // Letterbox into 960x544 (gray padding, like Ultralytics).
  const scale = Math.min(INPUT_W / width, INPUT_H / height);
  const nw = Math.round(width * scale);
  const nh = Math.round(height * scale);
  const padX = Math.floor((INPUT_W - nw) / 2);
  const padY = Math.floor((INPUT_H - nh) / 2);
  const rgb = await img
    .resize(nw, nh, { kernel: "cubic" })
    .extend({ top: padY, bottom: INPUT_H - nh - padY, left: padX, right: INPUT_W - nw - padX, background: { r: 114, g: 114, b: 114 } })
    .raw()
    .toBuffer();

  const plane = INPUT_W * INPUT_H;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    data[i] = rgb[i * 3] / 255;
    data[plane + i] = rgb[i * 3 + 1] / 255;
    data[2 * plane + i] = rgb[i * 3 + 2] / 255;
  }

  const s = await session();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, INPUT_H, INPUT_W]) });
  const t = out[s.outputNames[0]];
  const boxes = decodeYolo(t.data as Float32Array, { scale, padX, padY, width, height }, t.dims[2]);
  return { boxes, width, height, meanLuma, night, thumb };
}

/** Decode YOLOv8 output [1, 84, N] -> vehicle boxes in source-image pixels, after NMS. */
export function decodeYolo(
  out: Float32Array,
  t: { scale: number; padX: number; padY: number; width: number; height: number },
  n: number,
): Box[] {
  const cands: Box[] = [];
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestScore = 0;
    for (const c of [2, 3, 5, 7]) {
      const sc = out[(4 + c) * n + i];
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    if (best < 0 || bestScore < THRESHOLDS.DETECT_SCORE_MIN) continue;
    const cx = out[i], cy = out[n + i], w = out[2 * n + i], h = out[3 * n + i];
    const x = Math.max(0, (cx - w / 2 - t.padX) / t.scale);
    const y = Math.max(0, (cy - h / 2 - t.padY) / t.scale);
    const bw = Math.min(t.width - x, w / t.scale);
    const bh = Math.min(t.height - y, h / t.scale);
    if (bw <= 0 || bh <= 0) continue;
    if ((bw * bh) / (t.width * t.height) < THRESHOLDS.MIN_BOX_AREA_FRAC) continue;
    if (y + bh / 2 < THRESHOLDS.CAPTION_BAR_PX) continue; // burned-in caption text
    cands.push({ x, y, w: bw, h: bh, cls: VEHICLE_CLASSES[best], score: bestScore });
  }
  return nms(cands, THRESHOLDS.DETECT_NMS_IOU);
}

function nms(boxes: Box[], iouMax: number): Box[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: Box[] = [];
  for (const b of sorted) {
    if (keep.every((k) => overlap(k, b) < iouMax)) keep.push(b);
  }
  return keep.map((b) => ({ ...b, x: round1(b.x), y: round1(b.y), w: round1(b.w), h: round1(b.h), score: Math.round(b.score * 100) / 100 }));
}

function overlap(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Draw boxes onto a frame (used for iMessage photos and detection snapshots). */
export async function annotate(png: Buffer, boxes: Box[], highlight: Box[] = []): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 450, H = meta.height ?? 253;
  const rect = (b: Box, color: string, sw: number) =>
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${boxes.map((b) => rect(b, "#38bdf8", 1.5)).join("")}${highlight.map((b) => rect(b, "#f43f5e", 3)).join("")}</svg>`;
  return sharp(png).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

/** 16x16 grayscale crop of a box (+30% padding) - the unit of the arrival/background check. */
export async function regionSignature(png: Buffer, b: Box): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 450, H = meta.height ?? 253;
  const p = Math.max(b.w, b.h) * 0.3;
  const left = Math.max(0, Math.round(b.x - p));
  const top = Math.max(0, Math.round(b.y - p));
  const width = Math.max(1, Math.min(W - left, Math.round(b.w + 2 * p)));
  const height = Math.max(1, Math.min(H - top, Math.round(b.h + 2 * p)));
  return sharp(png).extract({ left, top, width, height }).grayscale().resize(16, 16, { fit: "fill" }).raw().toBuffer();
}

export function signatureDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export type Arrival = "verified" | "unverified" | "background";

/**
 * Did the object in `box` arrive during observation? Compares its region now against every
 * buffered frame from before the track started.
 */
export function classifyArrival(nowSig: ArrayLike<number>, preSigs: ArrayLike<number>[], cfg = THRESHOLDS): Arrival {
  if (preSigs.some((p) => signatureDiff(nowSig, p) < cfg.BACKGROUND_DIFF_MAX)) return "background";
  return preSigs.length >= cfg.ARRIVAL_MIN_PRE_FRAMES ? "verified" : "unverified";
}
