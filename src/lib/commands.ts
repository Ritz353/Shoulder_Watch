// Parse inbound iMessage text into a command. Pure functions - unit tested.

import { THRESHOLDS } from "../../config/thresholds";
import type { Camera, Subscription } from "./types";

export type Direction = "N" | "S" | "E" | "W" | "CW" | "CCW";

export type Command =
  | { type: "status"; road?: string; area?: string; direction?: Direction; query: string }
  | { type: "traffic"; road?: string; area?: string; direction?: Direction; query: string }
  | { type: "incidents"; road?: string }
  | { type: "subscriptions" }
  | { type: "cameras"; road?: string; area?: string; direction?: Direction; query: string }
  | { type: "watch"; road: string; window?: { start: string; end: string }; until?: number; describe: string }
  | { type: "watch_invalid"; reason: string }
  | { type: "stop" }
  | { type: "help" };

const AREAS: Record<string, string[]> = {
  Midtown: ["midtown", "14th", "10th st", "north ave", "brookwood"],
  Downtown: ["downtown", "connector", "the connector", "georgia state", "capitol"],
  Buckhead: ["buckhead", "west paces", "howell mill", "northside"],
  Airport: ["airport", "hartsfield", "atl airport", "college park", "5th runway"],
  "Spaghetti Junction": ["spaghetti", "spaghetti junction", "doraville"],
  Cumberland: ["cumberland", "vinings", "the battery", "battery", "cobb"],
  Decatur: ["decatur", "emory", "druid hills"],
  "Sandy Springs": ["sandy springs", "perimeter center", "mt paran", "mount paran"],
  "South Atlanta": ["south atlanta", "hapeville", "forest park", "jonesboro"],
  "East Atlanta": ["east atlanta", "glenwood", "kirkwood", "candler", "columbia dr"],
};

/** Normalize free text to a canonical road ("I-75", "I-85", "I-285", "I-20", "I-675", "GA-400", "I-75/85"). */
export function parseRoad(text: string): string | undefined {
  const t = ` ${text.toLowerCase().replace(/[^\w\s/-]/g, " ")} `;
  if (/\b(downtown )?connector\b/.test(t) || /\b(i-?\s?)?75\s*\/\s*(i-?\s?)?85\b/.test(t)) return "I-75/85";
  if (/\bperimeter\b/.test(t) && !/perimeter center/.test(t)) return "I-285";
  if (/\b(ga|sr|state route|georgia)[\s-]?400\b|\b400\b/.test(t)) return "GA-400";
  const m = t.match(/\b(?:i|interstate|highway|hwy)?[\s-]*(285|675|575|985|75|85|20)\b/);
  return m ? `I-${m[1]}` : undefined;
}

const DIR_WORDS: Record<string, Direction> = {
  n: "N", nb: "N", north: "N", northbound: "N",
  s: "S", sb: "S", south: "S", southbound: "S",
  e: "E", eb: "E", east: "E", eastbound: "E",
  w: "W", wb: "W", west: "W", westbound: "W",
  cw: "CW", clockwise: "CW", ccw: "CCW", counterclockwise: "CCW",
};

/**
 * Direction of travel, matching camera.direction: "I-85 S", "i85 southbound", "northbound 75",
 * "285 inner loop" (= CW), "outer loop" (= CCW). Single letters only count right after a road.
 */
export function parseDirection(text: string): Direction | undefined {
  const t = ` ${text.toLowerCase().replace(/[^\w\s/-]/g, " ").replace(/counter[\s-]clockwise/g, "counterclockwise")} `;
  if (/\bouter loop\b/.test(t)) return "CCW";
  if (/\binner loop\b/.test(t)) return "CW";
  const bound = t.match(/\b(northbound|southbound|eastbound|westbound|nb|sb|eb|wb|counterclockwise|clockwise|ccw|cw)\b/);
  if (bound) return DIR_WORDS[bound[1]];
  const afterRoad = t.match(/\b(?:i|interstate)?[\s-]*(?:285|675|575|985|75|85|20|400|connector)\s+(n|s|e|w|north|south|east|west)\b/);
  return afterRoad ? DIR_WORDS[afterRoad[1]] : undefined;
}

export const DIRECTION_WORD: Record<Direction, string> = {
  N: "northbound", S: "southbound", E: "eastbound", W: "westbound", CW: "clockwise (inner loop)", CCW: "counterclockwise (outer loop)",
};

export function parseArea(text: string): string | undefined {
  const t = text.toLowerCase();
  for (const [area, keys] of Object.entries(AREAS)) if (keys.some((k) => t.includes(k))) return area;
  return undefined;
}

/** "7", "7am", "7:30 pm", "19:00", "noon" -> minutes since midnight (meridiem may come from a sibling). */
function parseClock(s: string, fallbackMeridiem?: "am" | "pm"): { min: number; meridiem?: "am" | "pm" } | null {
  const t = s.trim().toLowerCase().replace(/\./g, "");
  if (t === "noon") return { min: 720, meridiem: "pm" };
  if (t === "midnight") return { min: 0, meridiem: "am" };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mm = Number(m[2] ?? 0);
  const mer = m[3] ? ((m[3][0] === "a" ? "am" : "pm") as "am" | "pm") : fallbackMeridiem;
  if (h > 23 || mm > 59) return null;
  if (mer && h > 12) return null;
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  return { min: h * 60 + mm, meridiem: m[3] ? mer : undefined };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function fmt12(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const mer = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${mer}` : `${h12}${mer}`;
}

export function parseWatchWindow(rest: string, now: number): { window?: { start: string; end: string }; until?: number; describe: string } | { error: string } {
  const t = rest.toLowerCase();
  // "for 2 hours", "for 90 min", "2h"
  const dur = t.match(/(?:for\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/);
  if (dur) {
    const n = Number(dur[1]);
    const ms = /^h/.test(dur[2]) ? n * 3_600_000 : n * 60_000;
    if (ms <= 0 || ms > 24 * 3_600_000) return { error: "Watch windows can be up to 24 hours." };
    return { until: now + ms, describe: `for the next ${/^h/.test(dur[2]) ? `${n} hr` : `${n} min`}` };
  }
  // "7-9am", "7am to 9am", "from 4:30pm-6:30pm", "between 7 and 9 am"
  const range = t.match(/(?:from|between)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)\s*(?:-|–|to|until|and|till)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)\b/);
  if (range) {
    const end = parseClock(range[2]);
    const start = parseClock(range[1], end?.meridiem);
    if (!start || !end) return { error: "I couldn't read that time window. Try: watch I-85 7-9am" };
    if (start.min === end.min) return { error: "Start and end time are the same." };
    const w = { start: hhmm(start.min), end: hhmm(end.min) };
    return { window: w, describe: `daily ${fmt12(w.start)}–${fmt12(w.end)}` };
  }
  // "until 11pm"
  const until = t.match(/\b(?:until|till|til)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)/);
  if (until) {
    const c = parseClock(until[1]);
    if (!c) return { error: "I couldn't read that time. Try: watch I-75 until 11pm" };
    const nowMin = minutesInAtlanta(now);
    let delta = c.min - nowMin;
    if (delta <= 0) delta += 24 * 60;
    return { until: now + delta * 60_000, describe: `until ${fmt12(hhmm(c.min))}` };
  }
  const h = THRESHOLDS.DEFAULT_WATCH_HOURS;
  return { until: now + h * 3_600_000, describe: `for the next ${h} hr` };
}

export function parseCommand(input: string, now = Date.now()): Command {
  const text = input.trim().replace(/[’‘]/g, "'");
  const lower = text.toLowerCase();
  if (/^(stop|unsubscribe|cancel|quit|end|unwatch)\b/.test(lower)) return { type: "stop" };

  const watch = lower.match(/^(?:watch|alert me( about)?|notify me( about)?|subscribe( to)?)\s+(.+)$/);
  if (watch) {
    const rest = watch[4];
    const road = parseRoad(rest.replace(/\d{1,2}(:\d{2})?\s*(am|pm)\b/g, " "));
    if (!road) return { type: "watch_invalid", reason: "Which road? Try: watch I-85 7-9am" };
    const w = parseWatchWindow(rest.replace(/\b(i|interstate)[\s-]*(285|675|575|985|75|85|20)\b|\b(ga|sr)[\s-]?400\b/g, " "), now);
    if ("error" in w) return { type: "watch_invalid", reason: w.error };
    return { type: "watch", road, ...w };
  }

  // "status" / "what am I watching?" -> the sender's own subscriptions.
  if (/^(?:status|my status|subscriptions?|my (?:subscriptions?|watches|alerts)|what am i watching|what(?:'s| is| are) my (?:status|subscriptions?|watches|alerts)|what am i subscribed to|am i (?:subscribed|watching anything)|list my (?:watches|alerts|subscriptions))[?.!]*$/.test(lower)) {
    return { type: "subscriptions" };
  }

  // "any stalls?" / "anything happening?" -> every active detection.
  if (
    /\b(?:any|are there(?: any)?)\s+(?:stalls?|stalled(?: vehicles| cars)?|incidents?|crash(?:es)?|accidents?|wrecks?|breakdowns?)\b/.test(lower) ||
    /\b(?:anything|what'?s|whats|something)\s+(?:happening|going on)\b/.test(lower) ||
    /^(?:stalls|incidents)[?.!]*$/.test(lower)
  ) {
    return { type: "incidents", road: parseRoad(lower) };
  }

  // "cameras on I-85" / "which cameras do you have on 285?"
  const cams = lower.match(/^(?:list|show(?: me)?|which|what|where are)?\s*(?:(?:the|all|your)\s+)*cameras?\b\s*(?:are there|are|do you (?:have|watch)|you have)?\s*(?:on|for|near|along|in|at)?\s*(?<q>.*?)[?.!]*$/);
  if (cams) {
    const q = (cams.groups?.q ?? "").replace(/^the\s+/, "");
    return { type: "cameras", road: parseRoad(q), area: parseArea(q), direction: parseDirection(q), query: q };
  }

  // Traffic level: "how's traffic on I-85?", "is 285 bad?", "traffic near Midtown", "how bad is the connector".
  const traffic =
    lower.match(/^(?:is|are)\s+(?<q>.+?)\s+(?:bad|busy|jammed|backed up|congested|slow|moving|clear|ok|okay|open)\b/) ??
    lower.match(/^how\s+(?:bad|busy|slow|backed up|congested|heavy)\s+(?:is|are)\s+(?<q>.+?)[?.!]*$/) ??
    lower.match(/^(?:how'?s|how is|hows|what'?s|whats|what is)\s+(?:the\s+)?traffic\b\s*(?:like\s+)?(?:on|near|around|at|in|along|for)?\s*(?<q>.*?)[?.!]*$/) ??
    lower.match(/^traffic\b\s*(?:on|near|around|at|in|along|for)?\s*(?<q>.*?)[?.!]*$/);
  if (traffic) {
    const q = (traffic.groups?.q ?? "").replace(/^the\s+/, "");
    return { type: "traffic", road: parseRoad(q), area: parseArea(q), direction: parseDirection(q), query: q };
  }

  const status = lower.match(/^(?:how'?s|how is|hows|how are|what'?s|whats|status( of)?|check|show( me)?)\s+(?<q>.+?)[?.!]*$/);
  const query = status?.groups?.q ?? lower.replace(/[?.!]+$/, "");
  const road = parseRoad(query);
  const area = parseArea(query);
  if (status || road) return { type: "status", road, area, direction: parseDirection(query), query: query.replace(/^the\s+/, "") };
  return { type: "help" };
}

export const HELP_TEXT = [
  "👋 Shoulder Watch spots stalled vehicles on Atlanta GDOT cameras.",
  "• how's I-75 near Midtown?  → live camera photos",
  "• how's traffic on I-85 S?  → light / moderate / heavy / stop-and-go",
  "• any stalls?  → everything flagged right now",
  "• cameras on I-285  → what I can see",
  "• watch I-85 7-9am  → text me if a stall shows up",
  "• what am I watching?  → your alerts",
  "• stop  → unsubscribe & delete your number",
].join("\n");

/** Minutes since midnight in Atlanta (America/New_York). */
export function minutesInAtlanta(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function subscriptionActive(sub: Pick<Subscription, "window" | "until">, now: number): boolean {
  if (sub.until !== undefined) return now <= sub.until;
  if (!sub.window) return false;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const cur = minutesInAtlanta(now);
  const s = toMin(sub.window.start);
  const e = toMin(sub.window.end);
  return s < e ? cur >= s && cur < e : cur >= s || cur < e; // overnight windows wrap
}

export function subscriptionExpired(sub: Pick<Subscription, "window" | "until">, now: number): boolean {
  return sub.until !== undefined && now > sub.until;
}

/** Does a camera's road satisfy a queried road? "I-75/85" cameras count for both I-75 and I-85. */
export function roadMatches(cameraRoad: string, road: string): boolean {
  if (cameraRoad === road) return true;
  if (cameraRoad === "I-75/85") return road === "I-75" || road === "I-85";
  if (road === "I-75/85") return cameraRoad === "I-75/85";
  return false;
}

const STOPWORDS = new Set([
  "near", "around", "traffic", "looking", "like", "right", "there", "interstate", "highway", "north", "south", "east", "west",
  "northbound", "southbound", "eastbound", "westbound", "clockwise", "counterclockwise", "inner", "outer", "loop",
  "the", "from", "with", "today", "now", "along", "cameras", "camera",
]);

/** Landmark words from a free-text query ("near Clairmont") that appear in camera names. */
export function landmarkWords(query: string): string[] {
  return (query.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** "I-85 S at Clairmont Rd" -> "at Clairmont Rd" (the location part of a camera name). */
export function shortLocation(name: string): string {
  return name.replace(/^(?:I-\d+(?:\/\d+)?|Connector|GA-400)\s+(?:N|S|E|W|CW|CCW)\s+/, "");
}

export function matchCameras(cameras: Camera[], road?: string, area?: string, query?: string, direction?: Direction): Camera[] {
  let list = road ? cameras.filter((c) => roadMatches(c.road, road)) : cameras;
  if (direction) list = list.filter((c) => c.direction === direction);
  const words = query ? landmarkWords(query) : [];
  const named = words.length ? list.filter((c) => words.some((w) => c.name.toLowerCase().includes(w))) : [];
  if (named.length) {
    // Named cameras first, then the nearest others on the same road (for 2-3 photos).
    const ref = named[0];
    const d2 = (c: Camera) => (c.lat - ref.lat) ** 2 + (c.lng - ref.lng) ** 2;
    return [...named, ...list.filter((c) => !named.includes(c)).sort((a, b) => d2(a) - d2(b))];
  }
  if (area) {
    const inArea = list.filter((c) => c.area === area);
    if (inArea.length) list = inArea;
    else if (!road) list = [];
  }
  return list;
}
