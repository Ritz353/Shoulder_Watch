"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Box, Camera, CameraState, Detection, ManualCheck, WorkerState } from "@/src/lib/types";
import { Backdrop, Cloud, Cone, Flower, Sparkle } from "./Decor";

// Leaflet touches `window`, so the map is client-only and loaded on demand.
const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

type View = "wall" | "map" | "detections";
const VIEWS: View[] = ["wall", "map", "detections"];
// View switch: the outgoing panel fades/slides out, then the incoming one fades/slides in.
const OUT_MS = 150;
const IN_MS = 250;

function prefersReducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

interface ApiState {
  state: WorkerState | null;
  detections: Detection[];
  manual: Record<string, ManualCheck>;
  serverTime: number;
}

const REFRESH_MS = 10_000;
const FRAME_W = 450;
const FRAME_H = 253;

const STATUS_TEXT: Record<CameraState["status"], string> = {
  ok: "OK",
  frozen: "Feed frozen",
  unavailable: "Camera offline",
  unreachable: "Unreachable",
  pending: "Starting…",
};

function imgUrl(file: string): string {
  const [p, q] = file.split("?");
  return `/api/file?p=${encodeURIComponent(p)}${q ? `&${q}` : ""}`;
}

function ago(ts: number | undefined, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Each road gets a ribbon color; cards use it for their thick border. */
const ROAD_COLOR: Record<string, string> = {
  "I-75": "#ff4b5c",
  "I-85": "#ff8c2b",
  "I-75/85": "#ffd23f",
  "I-285": "#33d17a",
  "I-20": "#2f8cff",
};
const roadStyle = (road: string) => ({ "--c": ROAD_COLOR[road] ?? "#b58cff" }) as CSSProperties;

const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const dateTime = (ts: number) =>
  new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** `pad` (source px) enlarges highlighted boxes so tiny distant vehicles stay visible in thumbnails. */
function Boxes({ boxes, stationary, pad = 0 }: { boxes: Box[]; stationary: Box[]; pad?: number }) {
  const pct = (b: Box, p = 0) => {
    const x = Math.max(0, b.x - p), y = Math.max(0, b.y - p);
    const w = Math.min(FRAME_W - x, b.w + 2 * p), h = Math.min(FRAME_H - y, b.h + 2 * p);
    return { left: `${(x / FRAME_W) * 100}%`, top: `${(y / FRAME_H) * 100}%`, width: `${(w / FRAME_W) * 100}%`, height: `${(h / FRAME_H) * 100}%` };
  };
  return (
    <>
      {boxes.map((b, i) => (
        <span key={`b${i}`} className="bx" style={pct(b)} />
      ))}
      {stationary.map((b, i) => (
        <span key={`s${i}`} className="bx st" style={pct(b, pad)} />
      ))}
    </>
  );
}

export default function Dashboard({ cameras, coordsSource }: { cameras: Camera[]; coordsSource: "approximate" | "511ga" }) {
  const [data, setData] = useState<ApiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("wall"); // selected tab
  const [onScreen, setOnScreen] = useState<View>("wall"); // panel actually displayed (lags `view` during the switch)
  const [phase, setPhase] = useState<{ step: "out" | "in"; dir: 1 | -1 } | null>(null);
  // Views stay mounted (just hidden) once visited, so switching never remounts the map or refetches.
  const [visited, setVisited] = useState<ReadonlySet<View>>(() => new Set());
  const swapTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tabsRef = useRef<HTMLElement>(null);
  const [ink, setInk] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [inkAnim, setInkAnim] = useState(false);
  const [focusDet, setFocusDet] = useState<string | null>(null);
  const [road, setRoad] = useState<string>("All");
  const [showBoxes, setShowBoxes] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const a = setInterval(load, REFRESH_MS);
    const b = setInterval(() => setNow(Date.now()), 1_000);
    try {
      const v = new URLSearchParams(location.search).get("view") ?? localStorage.getItem("sw:view");
      if (VIEWS.includes(v as View)) {
        setView(v as View); // initial view: no animation
        setOnScreen(v as View);
      }
      if (location.hash.startsWith("#det-")) setFocusDet(decodeURIComponent(location.hash.slice(5)));
    } catch {
      /* storage unavailable: defaults are fine */
    }
    // Let the tab indicator settle on the initial tab before it starts sliding.
    const c = setTimeout(() => setInkAnim(true), 120);
    const timers = swapTimers.current;
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearTimeout(c);
      timers.forEach(clearTimeout);
    };
  }, [load]);

  useEffect(() => setVisited((s) => (s.has(onScreen) ? s : new Set(s).add(onScreen))), [onScreen]);

  // Active-tab indicator: one pill that slides (transform) to the selected tab.
  useLayoutEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const measure = () => {
      const b = nav.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (b) setInk({ x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    nav.querySelectorAll("button").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [view]);

  const pickView = (v: View) => {
    try {
      localStorage.setItem("sw:view", v);
    } catch {
      /* ignore */
    }
    if (v === view) return;
    setView(v);
    swapTimers.current.splice(0).forEach(clearTimeout);
    if (prefersReducedMotion()) {
      setOnScreen(v);
      setPhase(null);
      return;
    }
    const dir = VIEWS.indexOf(v) > VIEWS.indexOf(view) ? 1 : -1;
    const slideIn = () => {
      setOnScreen(v);
      setPhase({ step: "in", dir });
      swapTimers.current.push(setTimeout(() => setPhase(null), IN_MS));
    };
    if (v === onScreen) {
      slideIn(); // switched back mid-fade: just bring it back in
    } else {
      setPhase({ step: "out", dir });
      swapTimers.current.push(setTimeout(slideIn, OUT_MS));
    }
  };

  // Map -> "Open in Detections": switch views, keep a shareable URL, then scroll to the card.
  const openDetection = (id: string) => {
    pickView("detections");
    setFocusDet(id);
    try {
      history.replaceState(null, "", `?view=detections#det-${encodeURIComponent(id)}`);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (onScreen !== "detections" || !focusDet || !data) return;
    const el = document.getElementById(`det-${focusDet}`);
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    el.classList.add("focus");
    const t = setTimeout(() => el.classList.remove("focus"), 2600);
    setFocusDet(null);
    return () => clearTimeout(t);
  }, [onScreen, focusDet, data]);

  const state = data?.state;
  const replay = state?.mode === "replay";
  const workerStale = state ? now - state.updatedAt > 3 * 60_000 : true;
  const camById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);
  const camStates = useMemo(() => new Map((state?.cameras ?? []).map((c) => [c.id, c])), [state]);
  // Cameras for this mode: every configured camera live; only the recorded ones in replay.
  const modeCams = replay ? (state?.cameras ?? []).map((c) => camById.get(c.id) ?? ({ id: c.id, name: `Camera ${c.id}`, road: "?", direction: "", lat: 0, lng: 0 } as Camera)) : cameras;
  const shown = modeCams.filter(
    (c) => road === "All" || c.road === road || (c.road === "I-75/85" && (road === "I-75" || road === "I-85")),
  );
  const roads = ["All", ...new Set(cameras.map((c) => c.road))];
  const activeDets = (data?.detections ?? []).filter((d) => d.status === "active" && (d.source === "live") === !replay);

  const counts = { ok: 0, frozen: 0, down: 0, vehicles: 0 };
  for (const s of state?.cameras ?? []) {
    if (s.status === "ok") counts.ok++;
    else if (s.status === "frozen") counts.frozen++;
    else if (s.status !== "pending") counts.down++;
    if (s.status === "ok") counts.vehicles += s.vehicles;
  }

  const verified = activeDets.filter((d) => d.arrival !== "unverified").length;
  const unverified = activeDets.length - verified;
  // Until the first /api/state response arrives we don't know yet - don't flash "offline".
  const modeKind = !data && !error ? "loading" : replay ? "replay" : workerStale ? "offline" : "live";

  // A view's panel: mounted on first visit, then only hidden, so nothing remounts or refetches.
  const panel = (v: View, body: ReactNode) =>
    (visited.has(v) || onScreen === v) && (
      <div
        key={v}
        className={`view-panel${onScreen === v && phase ? ` ${phase.step}` : ""}`}
        style={{ "--dir": phase?.dir ?? 1 } as CSSProperties}
        hidden={onScreen !== v}
      >
        {body}
      </div>
    );

  return (
    <>
      <Backdrop />
      {replay && (
        <div className="replay-banner" role="status">
          <strong>REPLAY: recorded data — not live</strong>
          <small>{state?.replayNote ? `${state.replayNote} · ` : ""}accelerated playback, original timestamps</small>
        </div>
      )}
      <div className="wrap">
        <header className="hero">
          <div className="hero-copy">
            <Cloud className="st-cloud" />
            <Sparkle className="st-spark1" />
            <Sparkle className="st-spark2" color="#7fe3ff" />
            <p className="kicker">Built at Hacklanta ’26 · Atlanta interstates</p>
            <h1 className="title">
              <span>Shoulder</span> <span>Watch</span>
            </h1>
            <p className="tagline">Eyes on the shoulder, not on your phone</p>
            <p className="lede">Stalled vehicles on Atlanta interstates, spotted from public GDOT cameras.</p>
            <nav ref={tabsRef} className={`tabs${ink ? " ink-ready" : ""}${inkAnim ? " ink-anim" : ""}`} aria-label="View">
              {ink && <span className="tab-ink" aria-hidden style={{ width: ink.w, height: ink.h, transform: `translate(${ink.x}px, ${ink.y}px)` }} />}
              <button aria-pressed={view === "wall"} onClick={() => pickView("wall")}>
                <span className="lbl">Live wall</span>
              </button>
              <button aria-pressed={view === "map"} onClick={() => pickView("map")}>
                <span className="lbl">Map</span>
              </button>
              <button aria-pressed={view === "detections"} onClick={() => pickView("detections")}>
                <span className="lbl">Detections{activeDets.length ? ` (${activeDets.length})` : ""}</span>
              </button>
            </nav>
          </div>

          <div className="lanyard" aria-label="System status">
            <div className="strap" aria-hidden />
            <div className={`badge ${modeKind}`}>
              <div className="clip" aria-hidden />
              <div className="badge-head">
                <span>Status pass</span>
                <Cone className="st-cone" />
              </div>
              <div className={`mode ${modeKind}`} role="status">
                {modeKind === "loading" ? (
                  "CONNECTING…"
                ) : modeKind === "replay" ? (
                  "REPLAY"
                ) : modeKind === "offline" ? (
                  <>
                    <span className="dot" /> WORKER OFFLINE
                  </>
                ) : (
                  <>
                    <span className="dot" /> LIVE
                  </>
                )}
              </div>
              <div className="badge-stats">
                <div>
                  <div className="k">Cameras OK</div>
                  <div className="v">{state ? `${counts.ok}/${state.cameras.length}` : "–"}</div>
                </div>
                <div>
                  <div className="k">Active stalls</div>
                  <div className={`v ${verified ? "stall" : ""}`}>{state ? verified : "–"}</div>
                  {unverified > 0 && <div className="vsub">+{unverified} unverified</div>}
                </div>
              </div>
              <div className="badge-mini">
                <span>
                  Frozen <b>{counts.frozen}</b>
                </span>
                <span>
                  Offline <b>{counts.down}</b>
                </span>
                <span>
                  Vehicles <b>{counts.vehicles}</b>
                </span>
              </div>
              <div className="badge-foot">
                <span className="barcode" aria-hidden />
                <span>{state ? `updated ${ago(state.updatedAt, now)}` : "waiting for worker"}</span>
              </div>
            </div>
          </div>
        </header>

        {error && <p className="empty">Dashboard can’t reach its API ({error}). Retrying…</p>}
        {!state && !error && <p className="empty">Waiting for the worker… start it with <code>npm run worker</code>.</p>}

        {state && (
          <div className="integrations">
            <span>
              AI check <b>{state.integrations.gemini}</b>
            </span>
            <span>
              iMessage <b>{state.integrations.photon}</b>
            </span>
            <span>
              511GA API <b>{state.integrations.ga511}</b>
            </span>
          </div>
        )}

        {state &&
          panel(
          "wall",
          <>
            <div className="section-head">
              <h2>The wall</h2>
              <Flower className="st-flower" />
            </div>
            <div className="toolbar">
              {roads.map((r) => (
                <button key={r} className="chip" style={r === "All" ? undefined : roadStyle(r)} aria-pressed={road === r} onClick={() => setRoad(r)}>
                  {r}
                </button>
              ))}
              <span className="spacer" />
              <label className="toggle">
                <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
                <span className="knob" aria-hidden />
                Vehicle boxes
              </label>
            </div>
            <section className="grid">
              {shown.map((cam) => {
                const s = camStates.get(cam.id);
                const status = s?.status ?? "pending";
                const camDets = activeDets.filter((d) => d.cameraId === cam.id);
                const hasStall = camDets.some((d) => d.arrival !== "unverified");
                const hasUnverified = !hasStall && camDets.length > 0;
                const showImg = s?.frameFile && (status === "ok" || status === "frozen");
                return (
                  <article key={cam.id} className={`tile ${hasStall ? "has-stall" : ""}`} style={roadStyle(cam.road)}>
                    <div className="frame">
                      {showImg ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imgUrl(s!.frameFile!)} alt={`Camera view: ${cam.name}`} loading="lazy" />
                      ) : (
                        <div className="placeholder">{status === "pending" ? "Waiting for first frame…" : STATUS_TEXT[status]}</div>
                      )}
                      {showImg && showBoxes && status === "ok" && <Boxes boxes={s!.boxes} stationary={s!.stationaryBoxes} pad={4} />}
                    </div>
                    <div className="meta">
                      {/* Status tags live below the image so they never cover the camera view. */}
                      {(hasStall || hasUnverified || status === "frozen" || (status === "ok" && (s?.congestion || s?.night))) && (
                        <div className="tags">
                          {hasStall && <span className="tag stall">STATIONARY VEHICLE</span>}
                          {hasUnverified && <span className="tag cong">stationary object (unverified)</span>}
                          {status === "frozen" && <span className="tag frozen">feed frozen — not analyzed</span>}
                          {s?.congestion && status === "ok" && <span className="tag cong">congestion</span>}
                          {s?.night && status === "ok" && <span className="tag night">night: low reliability</span>}
                        </div>
                      )}
                      <div className="row">
                        <span className="name" title={cam.name}>
                          {cam.name}
                        </span>
                        <span className={`pill ${status}`}>{STATUS_TEXT[status]}</span>
                      </div>
                      <div className="row sub">
                        <span>
                          <span className="road">{cam.road}</span> {cam.area ?? ""} · #{cam.id}
                        </span>
                        <span>
                          {status === "ok" ? `${s!.vehicles} vehicles · ` : ""}
                          {status === "frozen" ? `unchanged since ${ago(s?.lastChangeAt, now)}` : `updated ${ago(s?.lastChangeAt ?? s?.lastFetchAt, now)}`}
                        </span>
                      </div>
                      {s?.lastError && status !== "ok" && <div className="sub">{s.lastError}</div>}
                    </div>
                  </article>
                );
              })}
            </section>
          </>,
          )}

        {state &&
          panel(
          "map",
          <>
            <div className="section-head">
              <h2>The map</h2>
              <Sparkle className="st-flower" color="#7fe3ff" />
            </div>
            <MapView
              mode={replay ? "replay" : "live"}
              cameras={modeCams}
              states={camStates}
              detections={data?.detections ?? []}
              coordsSource={coordsSource}
              now={now}
              onOpenDetection={openDetection}
              visible={onScreen === "map"}
            />
          </>,
          )}

        {state && panel("detections", <DetectionsView data={data!} now={now} reload={load} />)}

        <footer className="credit">
          <Flower className="st-foot" petal="#7fe3ff" />
          <span>
            Camera imagery: Georgia Department of Transportation (GDOT) via{" "}
            <a href="https://511ga.org" target="_blank" rel="noreferrer">
              511GA
            </a>
            . Public, low-resolution snapshots. Shoulder Watch is an independent hackathon project, not affiliated with GDOT.
          </span>
          <span>No plate reading or identification of people. Raw frames are kept only in a short rolling buffer; flagged snapshots are deleted after 24 h.</span>
          <span>See a crash or a stranded driver in danger? Call 911.</span>
        </footer>
      </div>
    </>
  );
}

function DetectionsView({ data, now, reload }: { data: ApiState; now: number; reload: () => void }) {
  const ga511On = data.state?.integrations.ga511.startsWith("on");
  const record = async (detectionId: string, onMap: "yes" | "no" | "unsure") => {
    await fetch("/api/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ detectionId, onMap }) });
    reload();
  };
  const head = (
    <div className="section-head">
      <h2>Detections</h2>
      <Sparkle className="st-flower" color="#ff7ab6" />
    </div>
  );
  if (!data.detections.length)
    return (
      <>
        {head}
        <p className="empty">No detections yet. Stationary vehicles appear here after ~3 minutes of observation.</p>
      </>
    );
  return (
    <>
    {head}
    <section className="dets">
      {data.detections.map((d) => {
        const manual = data.manual[d.id];
        return (
          <article key={d.id} id={`det-${d.id}`} className={`det ${d.status}`} style={roadStyle(d.road)}>
            <h3>
              {d.source === "replay" && <span className="badge-replay">REPLAY · recorded</span>}
              <span className="road">{d.road}</span>
              {d.cameraName}
              <span className={d.status === "active" ? "status-active" : "status-cleared"}>
                {d.status === "active" ? "● ACTIVE" : `cleared${d.clearedReason ? ` (${d.clearedReason.replace(/_/g, " ")})` : ""}`}
              </span>
              {d.kind === "long_parked" && <span className="pill frozen">long-parked</span>}
            </h3>
            <div className="facts">
              <span>
                First seen <b>{dateTime(d.firstSeenAt)}</b>
              </span>
              <span>
                Flagged <b>{clock(d.flaggedAt)}</b>
              </span>
              <span>
                Stationary <b>{Math.max(d.stationaryMinutes, 1)} min</b>
              </span>
              <span>
                Last seen <b>{d.status === "active" ? ago(d.lastSeenAt, now) : clock(d.lastSeenAt)}</b>
              </span>
              {d.night && <span>night frame (lower reliability)</span>}
              {d.arrival === "unverified" && <span>present when monitoring began: arrival not seen, no alert sent</span>}
            </div>
            <div className={`ai ${d.ai?.status ?? "unconfirmed"}`}>
              <span className="lbl">{d.ai ? d.ai.label : "AI check pending…"}</span>
              {d.ai?.evidence && <span> — “{d.ai.evidence}”</span>}
              {d.ai?.status === "unconfirmed" && d.ai.detail && <span className="sub"> ({d.ai.detail})</span>}
            </div>
            {d.snapshotsPurged ? (
              <p className="sub">Snapshots deleted after the retention window.</p>
            ) : (
              <div className="timeline">
                {d.snapshots.map((s) => (
                  <figure key={s.ts}>
                    <div className="frame">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imgUrl(s.file)} alt={`Snapshot at ${clock(s.ts)}`} loading="lazy" />
                      {s.box && <Boxes boxes={[]} stationary={[s.box]} pad={10} />}
                    </div>
                    <figcaption>{clock(s.ts)}</figcaption>
                  </figure>
                ))}
              </div>
            )}
            {ga511On && d.official ? (
              <div className="manual">
                {d.official.status === "matched"
                  ? d.official.minutesBefore !== undefined && d.official.minutesBefore > 0
                    ? `Spotted ${d.official.minutesBefore} min before 511GA`
                    : `On 511GA (reported ${Math.abs(d.official.minutesBefore ?? 0)} min before our flag): ${d.official.description ?? ""}`
                  : "Not on 511GA"}
              </div>
            ) : (
              <div className="manual">
                <span>
                  Was it on the{" "}
                  <a href="https://511ga.org/map" target="_blank" rel="noreferrer">
                    511GA map
                  </a>
                  ?
                </span>
                {(["yes", "no", "unsure"] as const).map((v) => (
                  <button key={v} aria-pressed={manual?.onMap === v} onClick={() => record(d.id, v)}>
                    {v === "yes" ? "Yes, listed" : v === "no" ? "Not listed" : "Unsure"}
                  </button>
                ))}
                {manual && <span>recorded {ago(manual.at, now)}</span>}
              </div>
            )}
          </article>
        );
      })}
    </section>
    </>
  );
}
