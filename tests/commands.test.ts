import { describe, expect, it } from "vitest";
import { HELP_TEXT, matchCameras, parseCommand, parseDirection, parseRoad, shortLocation, subscriptionActive } from "../src/lib/commands";
import type { Camera } from "../src/lib/types";

// 2026-10-12 08:00 in Atlanta (EDT, UTC-4)
const MON_8AM = Date.UTC(2026, 9, 12, 12, 0);

describe("road parsing", () => {
  it.each([
    ["I-75", "I-75"],
    ["i75", "I-75"],
    ["I 85", "I-85"],
    ["interstate 285", "I-285"],
    ["the perimeter", "I-285"],
    ["downtown connector", "I-75/85"],
    ["75/85", "I-75/85"],
    ["GA 400", "GA-400"],
    ["I-20 east", "I-20"],
  ])("%s -> %s", (input, road) => expect(parseRoad(input)).toBe(road));

  it("does not mistake Perimeter Center for I-285", () => expect(parseRoad("perimeter center")).toBeUndefined());
});

describe("message commands", () => {
  it("parses status questions with road and area", () => {
    expect(parseCommand("how's I-75 near Midtown?")).toMatchObject({ type: "status", road: "I-75", area: "Midtown" });
    expect(parseCommand("How’s I-75?")).toMatchObject({ type: "status", road: "I-75" });
    expect(parseCommand("hows the connector")).toMatchObject({ type: "status", road: "I-75/85" });
    expect(parseCommand("how is the airport looking")).toMatchObject({ type: "status", area: "Airport" });
    expect(parseCommand("I-85")).toMatchObject({ type: "status", road: "I-85" });
  });

  it("parses watch with a daily window", () => {
    expect(parseCommand("watch I-85 7-9am", MON_8AM)).toMatchObject({ type: "watch", road: "I-85", window: { start: "07:00", end: "09:00" } });
    expect(parseCommand("watch I-75 4:30pm to 6:30pm", MON_8AM)).toMatchObject({ window: { start: "16:30", end: "18:30" } });
    expect(parseCommand("watch i285 from 10pm-2am", MON_8AM)).toMatchObject({ road: "I-285", window: { start: "22:00", end: "02:00" } });
  });

  it("parses watch with a duration, 'until', or no window (default)", () => {
    expect(parseCommand("watch I-20 for 90 min", MON_8AM)).toMatchObject({ type: "watch", until: MON_8AM + 90 * 60_000 });
    expect(parseCommand("watch I-20 for 2 hours", MON_8AM)).toMatchObject({ until: MON_8AM + 2 * 3_600_000 });
    expect(parseCommand("watch I-75 until 9am", MON_8AM)).toMatchObject({ until: MON_8AM + 60 * 60_000 });
    expect(parseCommand("watch I-75", MON_8AM)).toMatchObject({ type: "watch", until: MON_8AM + 2 * 3_600_000 });
  });

  it("rejects watch without a road or with a bad window", () => {
    expect(parseCommand("watch 7-9am")).toMatchObject({ type: "watch_invalid" });
    expect(parseCommand("watch I-85 for 30 hours")).toMatchObject({ type: "watch_invalid" });
  });

  it("parses stop variants", () => {
    for (const t of ["stop", "STOP", "unsubscribe", "Stop please"]) expect(parseCommand(t)).toEqual({ type: "stop" });
  });

  it("parses traffic-level questions", () => {
    expect(parseCommand("how's traffic on I-85?")).toMatchObject({ type: "traffic", road: "I-85" });
    expect(parseCommand("is 285 bad?")).toMatchObject({ type: "traffic", road: "I-285" });
    expect(parseCommand("traffic near Midtown")).toMatchObject({ type: "traffic", area: "Midtown", road: undefined });
    expect(parseCommand("how bad is the connector")).toMatchObject({ type: "traffic", road: "I-75/85" });
    expect(parseCommand("How is traffic near the airport?")).toMatchObject({ type: "traffic", area: "Airport" });
    expect(parseCommand("what's traffic like on I-20")).toMatchObject({ type: "traffic", road: "I-20" });
    expect(parseCommand("is I-75 backed up")).toMatchObject({ type: "traffic", road: "I-75" });
    expect(parseCommand("how busy is 85 south near clairmont")).toMatchObject({ type: "traffic", road: "I-85", direction: "S" });
    expect(parseCommand("traffic")).toMatchObject({ type: "traffic", road: undefined, area: undefined });
  });

  it("keeps plain status questions as status (no traffic words)", () => {
    expect(parseCommand("how's I-75")).toMatchObject({ type: "status", road: "I-75" });
    expect(parseCommand("status of I-85")).toMatchObject({ type: "status", road: "I-85" });
  });

  it("parses 'any stalls?' / 'anything happening?'", () => {
    for (const t of ["any stalls?", "Any stalled cars?", "anything happening?", "what's happening", "are there any accidents", "anything going on?", "stalls"]) {
      expect(parseCommand(t)).toMatchObject({ type: "incidents" });
    }
    expect(parseCommand("any stalls on I-85?")).toMatchObject({ type: "incidents", road: "I-85" });
  });

  it("parses 'status' / 'what am I watching?' as the sender's subscriptions", () => {
    for (const t of ["status", "Status?", "what am I watching?", "my subscriptions", "what are my alerts", "am I subscribed"]) {
      expect(parseCommand(t)).toEqual({ type: "subscriptions" });
    }
  });

  it("parses camera list requests", () => {
    expect(parseCommand("cameras on I-85")).toMatchObject({ type: "cameras", road: "I-85" });
    expect(parseCommand("list cameras on 285")).toMatchObject({ type: "cameras", road: "I-285" });
    expect(parseCommand("which cameras do you have on the connector?")).toMatchObject({ type: "cameras", road: "I-75/85" });
    expect(parseCommand("what cameras are near Midtown")).toMatchObject({ type: "cameras", area: "Midtown" });
    expect(parseCommand("cameras")).toMatchObject({ type: "cameras", road: undefined });
  });

  it("parses direction filters on status, traffic and camera questions", () => {
    expect(parseCommand("how's I-85 S near Clairmont")).toMatchObject({ type: "status", road: "I-85", direction: "S" });
    expect(parseCommand("how's traffic on I-75 northbound")).toMatchObject({ type: "traffic", road: "I-75", direction: "N" });
    expect(parseCommand("cameras on 285 outer loop")).toMatchObject({ type: "cameras", road: "I-285", direction: "CCW" });
    expect(parseCommand("how's I-85 near Clairmont")).toMatchObject({ type: "status", direction: undefined });
  });

  it("help text lists the new commands", () => {
    for (const k of ["traffic", "any stalls", "cameras on", "what am I watching"]) expect(HELP_TEXT).toContain(k);
  });

  it("falls back to help", () => {
    expect(parseCommand("hello")).toEqual({ type: "help" });
    expect(parseCommand("")).toEqual({ type: "help" });
  });
});

describe("direction parsing", () => {
  it.each([
    ["I-85 S", "S"],
    ["i85 southbound", "S"],
    ["northbound 75", "N"],
    ["I-20 east", "E"],
    ["I-20 WB", "W"],
    ["285 inner loop", "CW"],
    ["285 outer loop", "CCW"],
    ["I-285 counter-clockwise", "CCW"],
    ["I-285 CW", "CW"],
  ])("%s -> %s", (input, dir) => expect(parseDirection(input)).toBe(dir));

  it("does not read stray letters as directions", () => {
    expect(parseDirection("how's I-85 near Clairmont")).toBeUndefined();
    expect(parseDirection("what's on 85 near Spaghetti Junction")).toBeUndefined();
  });

  it("extracts the location part of a camera name", () => {
    expect(shortLocation("I-85 S at Clairmont Rd")).toBe("at Clairmont Rd");
    expect(shortLocation("Connector S past University Ave")).toBe("past University Ave");
    expect(shortLocation("I-285 CCW at I-75 (south)")).toBe("at I-75 (south)");
  });
});

describe("subscription windows (America/New_York)", () => {
  it("handles same-day and overnight windows", () => {
    expect(subscriptionActive({ window: { start: "07:00", end: "09:00" } }, MON_8AM)).toBe(true);
    expect(subscriptionActive({ window: { start: "16:00", end: "18:00" } }, MON_8AM)).toBe(false);
    expect(subscriptionActive({ window: { start: "22:00", end: "08:30" } }, MON_8AM)).toBe(true);
    expect(subscriptionActive({ until: MON_8AM + 1 }, MON_8AM)).toBe(true);
    expect(subscriptionActive({ until: MON_8AM - 1 }, MON_8AM)).toBe(false);
  });
});

describe("camera matching", () => {
  const cams = [
    { id: 1, road: "I-75", area: "Buckhead" },
    { id: 2, road: "I-75/85", area: "Midtown" },
    { id: 3, road: "I-85", area: "Decatur" },
  ] as Camera[];
  it("connector cameras count for I-75 and I-85; area narrows the result", () => {
    expect(matchCameras(cams, "I-75").map((c) => c.id)).toEqual([1, 2]);
    expect(matchCameras(cams, "I-75", "Midtown").map((c) => c.id)).toEqual([2]);
    expect(matchCameras(cams, undefined, "Decatur").map((c) => c.id)).toEqual([3]);
    expect(matchCameras(cams, undefined, "Airport")).toEqual([]);
  });
  it("prefers cameras whose name contains a landmark from the question", () => {
    const named = [
      { id: 11, road: "I-85", name: "I-85 S past Shallowford Rd", area: "Decatur", lat: 33.86, lng: -84.306 },
      { id: 10, road: "I-85", name: "I-85 S at Clairmont Rd", area: "Decatur", lat: 33.837, lng: -84.33 },
    ] as Camera[];
    expect(matchCameras(named, "I-85", undefined, "i-85 near clairmont").map((c) => c.id)).toEqual([10, 11]);
    expect(matchCameras(named, "I-85", undefined, "i-85 near nowhere").map((c) => c.id)).toEqual([11, 10]);
  });
  it("filters by camera direction", () => {
    const both = [
      { id: 20, road: "I-85", name: "I-85 S at Clairmont Rd", direction: "S", lat: 33.837, lng: -84.33 },
      { id: 21, road: "I-85", name: "I-85 N at Clairmont Rd", direction: "N", lat: 33.837, lng: -84.33 },
    ] as Camera[];
    expect(matchCameras(both, "I-85", undefined, "i-85 s near clairmont", "S").map((c) => c.id)).toEqual([20]);
    expect(matchCameras(both, "I-85", undefined, undefined, "N").map((c) => c.id)).toEqual([21]);
    expect(matchCameras(both, "I-85", undefined, undefined, "E")).toEqual([]);
  });
});
