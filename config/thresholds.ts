// Every tunable number in Shoulder Watch lives here. Units are in the names.

export const THRESHOLDS = {
  // ---- Polling (be polite to 511GA) ----
  /** Minimum gap between two fetches of the same camera. Images refresh every ~1-2 min. */
  POLL_INTERVAL_MS: 60_000,
  /** Random extra delay added to each poll so 30 cameras don't fire at once. */
  POLL_JITTER_MS: 15_000,
  /** Abort an image fetch after this long. */
  FETCH_TIMEOUT_MS: 10_000,
  /** Exponential backoff after failures: interval * 2^failures, capped here. */
  BACKOFF_MAX_MS: 15 * 60_000,
  /** Frames kept in memory per camera (the rolling buffer). */
  FRAME_BUFFER_SIZE: 10,
  /**
   * "Feed frozen" (not analyzed) = identical image hash for this many polls in a row...
   */
  FROZEN_AFTER_IDENTICAL_POLLS: 4,
  /**
   * ...AND unchanged for at least this long. Measured 2026-10-10 22:20-22:32 ET: the core metro
   * GDOT feeds refreshed every 400-490 s and others every 620-740 s (not 1-2 min), so a
   * poll-count-only rule would mislabel healthy feeds. 20 min leaves margin over the slowest.
   */
  FROZEN_MIN_UNCHANGED_MS: 20 * 60_000,

  // ---- Vehicle detection (YOLOv8s, COCO classes) ----
  DETECT_SCORE_MIN: 0.25,
  DETECT_NMS_IOU: 0.45,
  /** Ignore boxes overlapping the burned-in caption bar at the top of every frame (px of the 253-px frame). */
  CAPTION_BAR_PX: 20,
  /** Ignore tiny boxes (fraction of frame area) - usually noise or headlight glare. */
  MIN_BOX_AREA_FRAC: 0.0004,
  /** Mean luminance (0-255) under which a frame is labelled "night / low light". */
  NIGHT_LUMA_MAX: 70,

  // ---- Stall logic ----
  /** Track-to-box match: IoU against the track's first ("anchor") position. */
  STATIONARY_IOU_MIN: 0.5,
  /** ...and the box center may drift at most this fraction of the box diagonal. */
  STATIONARY_CENTER_DRIFT_MAX: 0.35,
  /**
   * Mean detector score a track needs before it can be flagged (boxes are still drawn from
   * DETECT_SCORE_MIN). Static non-vehicles - dashed lane markings, signs - were flagged in live
   * testing at scores 0.27-0.28; real parked cars in the same run scored 0.36-0.47.
   */
  STATIONARY_SCORE_MIN: 0.35,
  /** Consecutive fresh frames a vehicle must stay put before it is STATIONARY. */
  MIN_STATIONARY_FRAMES: 3,
  /** ...and the time between first and latest sighting must be at least this. */
  MIN_STATIONARY_SECONDS: 150,
  /** Frames a track may go unseen (detector flicker, occlusion) before it is dropped. */
  MAX_MISSED_FRAMES: 1,
  /** A stationary vehicle only counts as a stall if other traffic moved during its window. */
  REQUIRE_OTHER_MOTION: true,
  /** Congestion: at least this many vehicles in view... */
  CONGESTION_MIN_VEHICLES: 4,
  /** ...and at least this fraction of them stationary => "congestion", not a stall. */
  CONGESTION_STATIONARY_FRACTION: 0.6,
  /** Scene-change detector on a 32x18 grayscale thumbnail: a cell "changed" if |diff| > this. */
  SCENE_CELL_DIFF: 40,
  /** Fraction of changed cells above which we assume the operator panned/zoomed => reset tracks. */
  SCENE_CHANGE_FRACTION: 0.5,
  /**
   * Arrival check (pixel level, in the worker): a real stall ARRIVES, so the box region must look
   * different in every buffered frame from before the track began. Mean abs grayscale diff of a
   * 16x16 crop (box + 30% padding). Measured live: same object across frames 3-12.5; a frame with
   * a car driving over the spot 33. Lane markings/signs match some earlier frame => rejected.
   */
  BACKGROUND_DIFF_MAX: 15,
  /** Earlier frames needed to call an arrival verified; with fewer, the detection is logged as unverified and not alerted. */
  ARRIVAL_MIN_PRE_FRAMES: 2,
  /** A vehicle stationary longer than this is probably parked; flagged as such and not alerted. */
  LONG_PARKED_MINUTES: 90,

  // ---- Traffic level ("how's traffic on I-85?") ----
  // Inputs per camera: detector boxes in the latest fresh frame (a 450x253 snapshot, so these are
  // visible-vehicle counts, not true volumes; night undercounts), how many of them were at the same
  // spot one fresh frame earlier, and the camera's average over its rolling buffer.
  // Calibration: on the 2026-10-10 night run, per-camera counts ranged 0-13.
  /** At least this many vehicles in view => moderate. */
  TRAFFIC_MODERATE_VEHICLES: 5,
  /** At least this many vehicles in view => heavy. */
  TRAFFIC_HEAVY_VEHICLES: 10,
  /** Moderate count but at least this fraction held in place since the last frame => heavy. */
  TRAFFIC_HEAVY_STILL_FRACTION: 0.3,
  /** At least this many vehicles AND this fraction held in place => stop-and-go (matches the congestion rule). */
  TRAFFIC_STOPGO_MIN_VEHICLES: 4,
  TRAFFIC_STOPGO_STILL_FRACTION: 0.6,
  /** Count at least this multiple of the camera's recent average bumps the level up one step... */
  TRAFFIC_ABOVE_AVG_RATIO: 1.5,
  /** ...only if the average covers this many frames and the count is at least this high. */
  TRAFFIC_AVG_MIN_SAMPLES: 3,
  TRAFFIC_AVG_MIN_VEHICLES: 3,
  /** "traffic near Clairmont": the named camera(s) plus this many nearest cameras on the road. */
  TRAFFIC_LANDMARK_NEIGHBORS: 2,
  /** Max area lines in a traffic reply (worst first); the rest are summarized. */
  TRAFFIC_MAX_LINES: 8,

  // ---- Alerts (iMessage) ----
  /** Never text the same person more often than this. */
  ALERT_MIN_GAP_PER_RECIPIENT_MS: 10 * 60_000,
  /** Global cap on outgoing alert texts per rolling hour (shared free line). */
  ALERT_MAX_PER_HOUR: 30,
  /** Default subscription length when "watch <road>" has no time window. */
  DEFAULT_WATCH_HOURS: 2,

  // ---- Retention ----
  SNAPSHOT_RETENTION_HOURS: Number(process.env.SHOULDERWATCH_SNAPSHOT_RETENTION_HOURS ?? 24),
  /** Max snapshots stored per detection (timeline length). */
  MAX_SNAPSHOTS_PER_DETECTION: 14,

  // ---- 511GA official API (only when SHOULDERWATCH_511GA_KEY is set) ----
  GA511_MAX_CALLS_PER_MINUTE: 10,
  GA511_CAMERAS_CACHE_MS: 24 * 60 * 60_000,
  GA511_EVENTS_CACHE_MS: 2 * 60_000,
  /** Detection <-> incident match radius and time slack. */
  GA511_MATCH_RADIUS_M: 800,
  GA511_MATCH_WINDOW_MS: 60 * 60_000,

  // ---- Replay ----
  /** Wall-clock delay between replayed frames (playback is accelerated; timestamps stay original). */
  REPLAY_FRAME_INTERVAL_MS: 5_000,
} as const;

export type Thresholds = typeof THRESHOLDS;
