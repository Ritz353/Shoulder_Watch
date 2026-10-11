// Builds the agent's read-only replies ("how's I-75?", traffic level, "any stalls?", camera lists,
// "what am I watching?"). Shared by the worker's iMessage agent and the offline
// `npm run agent:dry` check, so both produce exactly the same messages.

import {
  DIRECTION_WORD,
  HELP_TEXT,
  fmt12,
  landmarkWords,
  matchCameras,
  shortLocation,
  subscriptionActive,
  type Command,
  type Direction,
} from "./commands";
import { annotate } from "./detector";
import { levelRank, overallLevel, trafficLevel, type TrafficLevel } from "./traffic";
import type { Camera, CameraState, Detection, Subscription } from "./types";
import { THRESHOLDS } from "../../config/thresholds";

export interface StatusReply {
  text: string;
  photos: { name: string; png: Buffer }[];
}

export interface StatusInput {
  mode: "live" | "replay";
  cameras: Camera[]; // cameras currently watched
  states: Map<number, CameraState>;
  detections: Detection[];
  /** Latest analyzed frame for a camera (null if none). */
  latestFrame: (id: number) => Buffer | null;
  now?: number;
}

const replayPrefix = (input: StatusInput) => (input.mode === "replay" ? "REPLAY (recorded data, not live): " : "");

function liveCams(input: StatusInput, cams: Camera[]): Camera[] {
  return cams.filter((c) => input.states.get(c.id)?.status === "ok" && input.latestFrame(c.id));
}

function camLevel(input: StatusInput, c: Camera): TrafficLevel {
  return trafficLevel(input.states.get(c.id)!);
}

/** Cameras for a question; if a direction filter leaves none, fall back to both directions and say so. */
function resolveCams(input: StatusInput, road?: string, area?: string, query?: string, direction?: Direction): { cams: Camera[]; note?: string } {
  const cams = matchCameras(input.cameras, road, area, query, direction);
  if (cams.length || !direction) return { cams };
  const all = matchCameras(input.cameras, road, area, query);
  return { cams: all, note: all.length ? `no ${DIRECTION_WORD[direction]} cameras there, showing all directions` : undefined };
}

/** "I-85 S near Clairmont", "I-75 near Midtown", "the connector". */
function placeLabel(cams: Camera[], road: string | undefined, area: string | undefined, query: string, direction?: Direction): string {
  // "connector" names the road itself, so it is never shown as a place ("Connector near Connector").
  const landmark = cams.length ? landmarkWords(query).find((w) => w !== "connector" && cams[0].name.toLowerCase().includes(w)) : undefined;
  const place = landmark ? landmark[0].toUpperCase() + landmark.slice(1) : road === "I-75/85" ? undefined : area;
  const roadPart = road ? `${road === "I-75/85" ? "Connector" : road}${direction ? ` ${direction}` : ""}` : "";
  return `${roadPart}${place ? `${roadPart ? " near " : ""}${place}` : ""}` || query;
}

/**
 * "camera snapshots received 2–9 min ago". We only know when the worker first received each
 * image (511GA does not expose the capture time), so the wording says "received", not "taken".
 */
function snapshotAge(input: StatusInput, cams: Camera[]): string {
  const now = input.now ?? Date.now();
  const ages = cams.map((c) => Math.max(0, Math.round((now - (input.states.get(c.id)?.lastChangeAt ?? now)) / 60_000)));
  if (!ages.length) return "";
  const lo = Math.min(...ages), hi = Math.max(...ages);
  const fmt = (m: number) => (m < 1 ? "<1" : String(m));
  return `camera snapshots received ${lo === hi ? fmt(lo) : `${fmt(lo)}–${hi}`} min ago`;
}

function notFound(input: StatusInput, query: string): StatusReply {
  const roads = [...new Set(input.cameras.map((c) => c.road))].join(", ");
  return { text: `${replayPrefix(input)}I don't have cameras for "${query}" yet. I watch: ${roads}.`, photos: [] };
}

// ------------------------------------------------------------------ "how's I-75 near Midtown?"
export async function buildStatusReply(
  input: StatusInput,
  road: string | undefined,
  area: string | undefined,
  query: string,
  direction?: Direction,
): Promise<StatusReply> {
  const prefix = replayPrefix(input);
  const { cams, note } = resolveCams(input, road, area, query, direction);
  if (!cams.length) return notFound(input, query);
  const live = liveCams(input, cams);
  const active = input.detections.filter(
    (d) => d.status === "active" && d.source === input.mode && d.arrival !== "unverified" && cams.some((c) => c.id === d.cameraId),
  );
  const st = (c: Camera) => input.states.get(c.id)!;
  // A landmark question ("near Clairmont") keeps matchCameras' nearest-first order; otherwise
  // show the busiest views. Cameras with an active stall always come first.
  const byProximity = landmarkWords(query).some((w) => cams[0]?.name.toLowerCase().includes(w));
  const ranked = [...live].sort((a, b) => {
    const ad = active.some((d) => d.cameraId === a.id) ? 1 : 0;
    const bd = active.some((d) => d.cameraId === b.id) ? 1 : 0;
    if (bd !== ad) return bd - ad;
    if (byProximity) return cams.indexOf(a) - cams.indexOf(b);
    return st(b).vehicles - st(a).vehicles || (st(b).lastChangeAt ?? 0) - (st(a).lastChangeAt ?? 0);
  });
  const pick = ranked.slice(0, 3);
  const vehicles = pick.reduce((n, c) => n + st(c).vehicles, 0);
  const label = placeLabel(cams, road, area, query, direction);

  const parts = [`${prefix}${label}: ${live.length}/${cams.length} cams live, ~${vehicles} vehicles in these views`];
  const level = overallLevel(pick.map((c) => camLevel(input, c)));
  if (level) parts.push(`traffic ${level}`);
  if (active.length) {
    const d = active[0];
    parts.push(`⚠️ ${active.length} stationary vehicle${active.length > 1 ? "s" : ""} flagged (${d.cameraName}, ${Math.max(d.stationaryMinutes, 1)} min, ${d.ai?.status === "confirmed" ? d.ai.label : "unconfirmed"})`);
  } else if (live.some((c) => st(c).congestion)) parts.push("slow/stopped traffic, no stalls flagged");
  else parts.push("no stalled vehicles flagged");
  if (pick.some((c) => st(c).night)) parts.push("night: detection less reliable");
  if (note) parts.push(note);

  const photos = await Promise.all(
    pick.map(async (c) => ({ name: `cam-${c.id}.png`, png: await annotate(input.latestFrame(c.id)!, st(c).boxes, st(c).stationaryBoxes) })),
  );
  const names = pick.map((c) => `📷 ${c.name}`).join("\n");
  return { text: `${parts.join(" · ")}${names ? `\n${names}` : ""}${live.length ? "" : "\n(no live camera images right now)"}`, photos };
}

// ------------------------------------------------------------------ "how's traffic on I-85?"
export async function buildTrafficReply(
  input: StatusInput,
  road: string | undefined,
  area: string | undefined,
  query: string,
  direction?: Direction,
): Promise<StatusReply> {
  const prefix = replayPrefix(input);
  const resolved = resolveCams(input, road, area, query, direction);
  const { note } = resolved;
  let cams = resolved.cams;
  if (!cams.length) return notFound(input, query);
  // A landmark question is about that spot: the named camera(s) and their nearest neighbors only.
  const words = landmarkWords(query).filter((w) => w !== "connector");
  const named = cams.filter((c) => words.some((w) => c.name.toLowerCase().includes(w))).length;
  if (named) cams = cams.slice(0, named + THRESHOLDS.TRAFFIC_LANDMARK_NEIGHBORS);
  const live = liveCams(input, cams); // frozen / offline / unreachable cameras are skipped
  const skipped = cams.length - live.length;
  const label = road || area || landmarkWords(query).length ? placeLabel(cams, road, area, query, direction) : "Atlanta interstates";
  if (!live.length) {
    return { text: `${prefix}${label}: no live camera images right now (${cams.length} cam${cams.length > 1 ? "s" : ""} frozen or offline), so I can't judge traffic.`, photos: [] };
  }
  const st = (c: Camera) => input.states.get(c.id)!;
  const levels = new Map(live.map((c) => [c.id, camLevel(input, c)] as const));
  const worse = (a: Camera, b: Camera) => levelRank(levels.get(b.id)!) - levelRank(levels.get(a.id)!) || st(b).vehicles - st(a).vehicles;

  // Per-area breakdown: one line per road + direction + area, rated by its worst camera.
  const groups = new Map<string, Camera[]>();
  for (const c of live) {
    const key = `${c.road} ${c.direction}|${c.area ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const lines = [...groups.values()]
    .map((g) => {
      const sorted = [...g].sort(worse);
      const worst = sorted[0];
      const lvl = levels.get(worst.id)!;
      const roadName = worst.road === "I-75/85" ? "Connector" : worst.road;
      const name = g.length === 1 ? worst.name : `${roadName} ${worst.direction}${worst.area ? ` near ${worst.area}` : ""}`;
      const where = g.length > 1 && levelRank(lvl) >= 1 ? ` (worst ${shortLocation(worst.name)})` : "";
      return { lvl, vehicles: st(worst).vehicles, text: `• ${name}: ${lvl}${where}` };
    })
    .sort((a, b) => levelRank(b.lvl) - levelRank(a.lvl) || b.vehicles - a.vehicles);
  const max = THRESHOLDS.TRAFFIC_MAX_LINES;
  const shown = lines.slice(0, max).map((l) => l.text);
  if (lines.length > max) {
    const rest = lines.slice(max);
    const restWorst = rest.reduce((m, l) => (levelRank(l.lvl) > levelRank(m) ? l.lvl : m), "light" as TrafficLevel);
    shown.push(`• +${rest.length} more area${rest.length > 1 ? "s" : ""}: ${restWorst === "light" ? "light" : `${restWorst} or lighter`}`);
  }

  const all = [...levels.values()];
  const overall = overallLevel(all)!;
  const bad = all.filter((l) => levelRank(l) >= 2).length;
  const head = [`${prefix}${label} traffic: ${overall}${live.length > 1 ? " overall" : ""}`];
  if (bad && levelRank(overall) < 2) head.push(`heavy or worse at ${bad} of ${live.length} cams`);
  head.push(snapshotAge(input, live));
  const foot: string[] = [];
  if (skipped) foot.push(`${skipped} cam${skipped > 1 ? "s" : ""} skipped (frozen/offline)`);
  if (live.some((c) => st(c).night)) foot.push("night: counts may be low");
  if (note) foot.push(note);

  const worst2 = [...live].sort(worse).slice(0, Math.min(2, live.length));
  const photos = await Promise.all(
    worst2.map(async (c) => ({ name: `cam-${c.id}.png`, png: await annotate(input.latestFrame(c.id)!, st(c).boxes, st(c).stationaryBoxes) })),
  );
  return {
    text: [head.join(" · "), ...shown, ...(foot.length ? [foot.join(" · ")] : []), ...worst2.map((c) => `📷 ${c.name}`)].join("\n"),
    photos,
  };
}

// ------------------------------------------------------------------ "any stalls?"
export async function buildIncidentsReply(input: StatusInput, road?: string): Promise<StatusReply> {
  const prefix = replayPrefix(input);
  const inScope = (d: Detection) => !road || matchCameras(input.cameras, road).some((c) => c.id === d.cameraId);
  // Verified stalls first, then items whose arrival we didn't see.
  const active = input.detections
    .filter((d) => d.status === "active" && d.source === input.mode && inScope(d))
    .sort((a, b) => Number(a.arrival === "unverified") - Number(b.arrival === "unverified") || b.stationaryMinutes - a.stationaryMinutes);
  const live = input.cameras.filter((c) => input.states.get(c.id)?.status === "ok").length;
  const where = road ? ` on ${road}` : "";
  if (!active.length) {
    return { text: `${prefix}✅ No stalled vehicles flagged${where} right now. Watching ${input.cameras.length} cameras (${live} live).`, photos: [] };
  }
  const lines = active.map((d, i) => {
    const cam = input.cameras.find((c) => c.id === d.cameraId);
    const ai = d.ai?.status === "confirmed" ? d.ai.label : "AI: unconfirmed";
    const unverified = d.arrival === "unverified" ? " · unverified (already there when monitoring began)" : "";
    return `${i + 1}. ${d.road} ${d.direction} ${shortLocation(d.cameraName)}${cam?.area ? ` (${cam.area})` : ""}: stopped ${Math.max(d.stationaryMinutes, 1)} min · ${ai}${unverified}`;
  });
  const photos: StatusReply["photos"] = [];
  for (const d of active.slice(0, 3)) {
    const frame = input.latestFrame(d.cameraId);
    if (frame) photos.push({ name: `stall-${d.cameraId}.png`, png: await annotate(frame, [], [d.box]) });
  }
  const n = active.length;
  return { text: [`${prefix}⚠️ ${n} stationary vehicle${n > 1 ? "s" : ""} flagged${where}:`, ...lines].join("\n"), photos };
}

// ------------------------------------------------------------------ "cameras on I-85"
export function buildCamerasReply(input: StatusInput, road: string | undefined, area: string | undefined, query: string, direction?: Direction): StatusReply {
  const prefix = replayPrefix(input);
  if (!road && !area && !direction) {
    const byRoad = new Map<string, number>();
    for (const c of input.cameras) byRoad.set(c.road, (byRoad.get(c.road) ?? 0) + 1);
    const list = [...byRoad].map(([r, n]) => `${r} (${n})`).join(", ");
    return { text: `${prefix}I watch ${input.cameras.length} cameras: ${list}. Text "cameras on I-85" for the list.`, photos: [] };
  }
  const { cams, note } = resolveCams(input, road, area, undefined, direction);
  if (!cams.length) return notFound(input, query);
  const statusWord: Partial<Record<CameraState["status"], string>> = { frozen: "feed frozen", unavailable: "offline", unreachable: "unreachable", pending: "starting" };
  const lines = cams.map((c) => {
    const s = statusWord[input.states.get(c.id)?.status ?? "pending"];
    return `• ${c.name}${c.area ? ` · ${c.area}` : ""}${s ? ` · ${s}` : ""}`;
  });
  const label = `${road ?? ""}${direction ? ` ${direction}` : ""}${area ? `${road ? " near " : ""}${area}` : ""}`.trim();
  return { text: [`${prefix}${label} cameras (${cams.length}):`, ...lines, ...(note ? [`(${note})`] : [])].join("\n"), photos: [] };
}

// ------------------------------------------------------------------ "what am I watching?"
function endTime(ts: number, now: number): string {
  const day = (t: number) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const time = new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  if (day(ts) === day(now)) return time;
  if (day(ts) === day(now + 86_400_000)) return `${time} tomorrow`;
  return `${time} ${new Date(ts).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}`;
}

export function buildSubscriptionsReply(input: Pick<StatusInput, "mode" | "now">, subs: Subscription[], phone: string): StatusReply {
  const prefix = input.mode === "replay" ? "REPLAY (recorded data, not live): " : "";
  const now = input.now ?? Date.now();
  const mine = subs.filter((s) => s.phone === phone && !(s.until !== undefined && s.until < now));
  if (!mine.length) return { text: `${prefix}You're not watching any roads. Try: watch I-85 7-9am`, photos: [] };
  const lines = mine.map((s) => {
    const on = subscriptionActive(s, now);
    if (s.until !== undefined) return `• ${s.road}: until ${endTime(s.until, now)}${on ? " (on now)" : ""}`;
    const w = `daily ${fmt12(s.window!.start)}–${fmt12(s.window!.end)}`;
    return `• ${s.road}: ${w}${on ? `, on now, ends ${fmt12(s.window!.end)}` : `, next starts ${fmt12(s.window!.start)}`}`;
  });
  return { text: [`${prefix}You're watching:`, ...lines, `Reply "stop" to unsubscribe.`].join("\n"), photos: [] };
}

// ------------------------------------------------------------------ dispatcher
/**
 * Reply for every read-only command; null for commands that change state (watch / stop),
 * which the agent handles itself.
 */
export async function buildReply(
  cmd: Command,
  input: StatusInput,
  ctx: { phone: string; subscriptions: Subscription[] },
): Promise<StatusReply | null> {
  switch (cmd.type) {
    case "status":
      return buildStatusReply(input, cmd.road, cmd.area, cmd.query, cmd.direction);
    case "traffic":
      return buildTrafficReply(input, cmd.road, cmd.area, cmd.query, cmd.direction);
    case "incidents":
      return buildIncidentsReply(input, cmd.road);
    case "cameras":
      return buildCamerasReply(input, cmd.road, cmd.area, cmd.query, cmd.direction);
    case "subscriptions":
      return buildSubscriptionsReply(input, ctx.subscriptions, ctx.phone);
    case "help":
      return { text: HELP_TEXT, photos: [] };
    default:
      return null;
  }
}
