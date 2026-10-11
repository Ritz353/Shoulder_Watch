export interface Camera {
  id: number;
  gdot?: string; // GDOT camera code from the image caption, e.g. "GDOT-0040"
  name: string;
  road: string; // canonical road, e.g. "I-75", "I-85", "I-285", "I-20", "I-75/85"
  direction: string; // N / S / E / W / CW / CCW / "both"
  lat: number;
  lng: number;
  area?: string; // neighborhood keywords used by "how's ..." (e.g. "Midtown")
  /** Normalized [x, y, w, h] rectangles (0-1) where stationary vehicles are expected (lots, ramps meters). */
  ignoreZones?: [number, number, number, number][];
}

export interface Box {
  x: number; // pixels in the 450x253 source frame
  y: number;
  w: number;
  h: number;
  cls: "car" | "truck" | "bus" | "motorcycle";
  score: number;
}

export type CameraStatus = "ok" | "frozen" | "unavailable" | "unreachable" | "pending";

export interface CameraState {
  id: number;
  status: CameraStatus;
  lastFetchAt?: number; // epoch ms of last successful fetch
  lastChangeAt?: number; // epoch ms the image last changed
  lastError?: string;
  vehicles: number;
  stationary: number;
  boxes: Box[];
  stationaryBoxes: Box[];
  night: boolean;
  congestion: boolean;
  /** Vehicles that were at the same spot one fresh frame ago (traffic level input). */
  heldStill?: number;
  /** Mean vehicle count over the rolling frame buffer, and how many frames that covers. */
  avgVehicles?: number;
  avgSamples?: number;
  frameFile?: string; // relative path under data dir of the latest frame
}

export type Verdict = "stalled_vehicle" | "stopped_traffic" | "parked_or_work_zone" | "unclear";

export interface AiResult {
  status: "confirmed" | "unconfirmed";
  verdict?: Verdict;
  evidence?: string;
  /** Human label, e.g. "unconfirmed (AI unavailable)". */
  label: string;
  detail?: string;
  model?: string;
  checkedAt: number;
}

export interface Snapshot {
  file: string; // relative to data dir (or replay dir for seeded detections)
  ts: number;
  box?: Box;
}

export interface Detection {
  id: string;
  cameraId: number;
  cameraName: string;
  road: string;
  direction: string;
  source: "live" | "replay";
  kind: "stall" | "long_parked";
  firstSeenAt: number;
  flaggedAt: number;
  lastSeenAt: number;
  stationaryMinutes: number;
  box: Box;
  night: boolean;
  /** Arrival check: "verified" = the spot was empty earlier; "unverified" = already there when monitoring began (logged, not alerted). */
  arrival?: "verified" | "unverified";
  status: "active" | "cleared";
  clearedReason?: "vehicle_left" | "scene_change" | "feed_lost" | "worker_restart";
  snapshots: Snapshot[];
  snapshotsPurged?: boolean;
  ai?: AiResult;
  official?: { status: "matched" | "not_on_511ga"; minutesBefore?: number; eventId?: number; description?: string; checkedAt: number };
}

export interface ManualCheck {
  detectionId: string;
  onMap: "yes" | "no" | "unsure";
  at: number;
}

export interface WorkerState {
  mode: "live" | "replay";
  startedAt: number;
  updatedAt: number;
  replayNote?: string;
  integrations: { gemini: string; photon: string; ga511: string };
  cameras: CameraState[];
}

export interface Subscription {
  phone: string;
  spaceId: string;
  road: string;
  /** Daily window in America/New_York, "HH:MM". */
  window?: { start: string; end: string };
  /** Or a one-off expiry (epoch ms). */
  until?: number;
  createdAt: number;
}
