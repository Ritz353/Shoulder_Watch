"use client";

// Live map of the watched cameras. Loaded with next/dynamic({ ssr: false }) because Leaflet
// needs `window`. Data comes from the dashboard's existing /api/state poll - nothing new here
// talks to the backend except the popup image (the existing /api/file route).

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import { trafficLevel, type TrafficLevel } from "@/src/lib/traffic";
import type { Camera, CameraState, Detection } from "@/src/lib/types";

const ATLANTA: [number, number] = [33.76, -84.39];

// CARTO basemaps now require a (free) key, passed as ?key=; a keyless request returns
// "API KEY REQUIRED" tiles. Basemap keys are public by design (they ride in every tile URL).
// Without one we fall back to standard OpenStreetMap tiles, darkened in CSS.
const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_BASEMAPS_KEY ?? "";
const BASEMAP = CARTO_KEY
  ? {
      url: `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_KEY)}`,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      className: "",
      maxZoom: 19,
    }
  : {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: "osm-dark",
      maxZoom: 19,
    };
const DAY_MS = 24 * 60 * 60_000;

export const LEVEL_COLOR: Record<TrafficLevel, string> = {
  light: "#33d17a",
  moderate: "#ffd23f",
  heavy: "#ff8c2b",
  "stop-and-go": "#d81f5c",
};
const DOWN_COLOR = "#7c86ad";

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

const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// Pulsing stall marker: a Leaflet divIcon whose rings are animated in CSS (opacity/transform only).
const stallIcon = (unverified: boolean) =>
  L.divIcon({
    className: "",
    html: `<span class="map-stall${unverified ? " unverified" : ""}"><span class="ring"></span><span class="core"></span></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -14],
  });
const pastIcon = L.divIcon({ className: "", html: `<span class="map-past"></span>`, iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6] });

/** Fit all cameras once (not on every poll, so the user's pan/zoom sticks). */
function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !points.length) return;
    done.current = true;
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 13 });
  }, [map, points]);
  return null;
}

/** The map stays mounted while hidden (display: none); re-measure once it is shown again,
 *  and again after the slide-in, so tiles aren't gray or offset. */
function InvalidateOnShow({ visible }: { visible: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!visible) return;
    map.invalidateSize({ pan: false });
    const t = setTimeout(() => map.invalidateSize({ pan: false }), 300);
    return () => clearTimeout(t);
  }, [map, visible]);
  return null;
}

export interface MapViewProps {
  mode: "live" | "replay";
  cameras: Camera[]; // cameras to show (all configured in live mode; recorded ones in replay)
  states: Map<number, CameraState>;
  detections: Detection[];
  coordsSource: "approximate" | "511ga";
  now: number;
  onOpenDetection: (id: string) => void;
  visible: boolean;
}

export default function MapView({ mode, cameras: allCameras, states, detections, coordsSource, now, onOpenDetection, visible }: MapViewProps) {
  const [showPast, setShowPast] = useState(false);
  const cameras = useMemo(() => allCameras.filter((c) => c.lat && c.lng), [allCameras]); // no coordinates => not on the map
  const camById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);
  const points = useMemo(() => cameras.map((c) => [c.lat, c.lng] as [number, number]), [cameras]);

  const inMode = (d: Detection) => d.source === mode && camById.has(d.cameraId);
  const active = detections.filter((d) => d.status === "active" && inMode(d));
  // "Last 24 h" is measured against the data's own clock in replay (recorded timestamps).
  const past = detections.filter((d) => d.status === "cleared" && inMode(d) && (mode === "replay" || now - d.lastSeenAt < DAY_MS));

  const counts: Record<TrafficLevel | "down", number> = { light: 0, moderate: 0, heavy: 0, "stop-and-go": 0, down: 0 };

  const markers = cameras.map((cam) => {
    const s = states.get(cam.id);
    const live = s?.status === "ok";
    const level = live ? trafficLevel(s) : undefined;
    counts[level ?? "down"]++;
    const color = level ? LEVEL_COLOR[level] : DOWN_COLOR;
    return (
      <CircleMarker
        key={cam.id}
        center={[cam.lat, cam.lng]}
        radius={8}
        pathOptions={{ color: "#0a0f2c", weight: 2.5, fillColor: color, fillOpacity: live ? 0.95 : 0.6, dashArray: live ? undefined : "3 3" }}
      >
        <Tooltip direction="top" offset={[0, -8]}>
          {cam.name}
        </Tooltip>
        <Popup maxWidth={300} minWidth={240}>
          <div className="map-pop">
            {s?.frameFile && (s.status === "ok" || s.status === "frozen") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imgUrl(s.frameFile)} alt={`Camera view: ${cam.name}`} width={450} height={253} />
            ) : (
              <div className="map-pop-ph">{STATUS_TEXT[s?.status ?? "pending"]}</div>
            )}
            <strong>{cam.name}</strong>
            <div className="map-pop-row">
              <span className="road" style={{ background: "var(--cream)" }}>
                {cam.road}
              </span>
              <span>{cam.direction}{cam.area ? ` · ${cam.area}` : ""}</span>
            </div>
            <div className="map-pop-row">
              <span className={`pill ${s?.status ?? "pending"}`}>{STATUS_TEXT[s?.status ?? "pending"]}</span>
              {level && <span className="lvl" style={{ background: LEVEL_COLOR[level] }}>{level}</span>}
              {live && <span>{s!.vehicles} vehicles</span>}
            </div>
            <div className="map-pop-sub">
              {s?.status === "frozen" ? `unchanged since ${ago(s.lastChangeAt, now)}` : `updated ${ago(s?.lastChangeAt ?? s?.lastFetchAt, now)}`}
              {s?.night && s.status === "ok" ? " · night: counts may be low" : ""}
            </div>
          </div>
        </Popup>
      </CircleMarker>
    );
  });

  const stallMarker = (d: Detection, kind: "active" | "past") => {
    const cam = camById.get(d.cameraId)!;
    return (
      <Marker key={`${kind}-${d.id}`} position={[cam.lat, cam.lng]} icon={kind === "active" ? stallIcon(d.arrival === "unverified") : pastIcon} zIndexOffset={kind === "active" ? 1000 : 500}>
        <Popup maxWidth={280}>
          <div className="map-pop">
            {d.source === "replay" && <span className="badge-replay">REPLAY · recorded</span>}
            <strong>
              {kind === "active" ? (d.arrival === "unverified" ? "Stationary object (unverified)" : "⚠️ Stationary vehicle") : "Cleared detection"}
            </strong>
            <div>{d.cameraName}</div>
            <div className="map-pop-sub">
              stopped {Math.max(d.stationaryMinutes, 1)} min · first seen {clock(d.firstSeenAt)}
              {kind === "past" ? ` · cleared ${d.clearedReason ? `(${d.clearedReason.replace(/_/g, " ")})` : ""}` : ""}
            </div>
            <div className="map-pop-sub">{d.ai?.status === "confirmed" ? d.ai.label : "AI: unconfirmed"}</div>
            <button type="button" className="map-link" onClick={() => onOpenDetection(d.id)}>
              Open in Detections →
            </button>
          </div>
        </Popup>
      </Marker>
    );
  };

  return (
    <div className="map-shell">
      <div className="map-bar">
        <label className="toggle">
          <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
          <span className="knob" aria-hidden />
          Detections in last 24 h{past.length ? ` (${past.length})` : ""}
        </label>
        {mode === "replay" && <span className="badge-replay">REPLAY · recorded data on map</span>}
        {coordsSource !== "511ga" && <span className="map-note">Camera positions approximate</span>}
        {!CARTO_KEY && <span className="map-note subtle">Basemap: OpenStreetMap (set NEXT_PUBLIC_CARTO_BASEMAPS_KEY for CARTO dark tiles)</span>}
      </div>
      <div className="map-frame">
        <MapContainer center={ATLANTA} zoom={11} scrollWheelZoom className="map" attributionControl>
          <TileLayer url={BASEMAP.url} attribution={BASEMAP.attribution} className={BASEMAP.className} maxZoom={BASEMAP.maxZoom} />
          <FitOnce points={points} />
          <InvalidateOnShow visible={visible} />
          {markers}
          {showPast && past.map((d) => stallMarker(d, "past"))}
          {active.map((d) => stallMarker(d, "active"))}
        </MapContainer>
      </div>
      <div className="map-legend" aria-label="Map legend">
        {(Object.keys(LEVEL_COLOR) as TrafficLevel[]).map((l) => (
          <span key={l}>
            <i style={{ background: LEVEL_COLOR[l] }} /> {l[0].toUpperCase() + l.slice(1)} <b>{counts[l]}</b>
          </span>
        ))}
        <span>
          <i className="down" /> No live image (frozen / offline / starting) <b>{counts.down}</b>
        </span>
        <span>
          <i className="stall" /> Active stall <b>{active.filter((d) => d.arrival !== "unverified").length}</b>
        </span>
        <span>
          <i className="stall unverified" /> Unverified <b>{active.filter((d) => d.arrival === "unverified").length}</b>
        </span>
        {showPast && (
          <span>
            <i className="past" /> Cleared (24 h)
          </span>
        )}
      </div>
    </div>
  );
}
