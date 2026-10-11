# Shoulder Watch 🚧

**Hacklanta '26.** Shoulder Watch watches Atlanta's public Georgia DOT traffic cameras and spots vehicles stopped on the shoulder or stalled in a lane. It shows them on a live dashboard and texts subscribers over iMessage. Commuters can also text it *"how's I-75 near Midtown?"* and get live camera photos back.

- **See:** a local YOLOv8s detector (ONNX on CPU, no cloud) boxes cars, trucks, and buses on every fresh frame from 34 interstate cameras.
- **Understand:** a tracker flags a vehicle that stays in about the same spot for 3 or more fresh frames (about 3–6 minutes) while other traffic keeps moving. It tells congestion apart from a stall, resets when an operator pans the camera, and skips frozen feeds. Gemini can optionally double-check each flag with a strict structured verdict.
- **React:** iMessage alerts through Photon Spectrum (`spectrum-ts@12.10.1`), a detections log with a snapshot timeline, and a comparison against official 511GA incidents.

> Camera imagery comes from GDOT via [511GA](https://511ga.org). This is an independent project. It does not read plates or identify people.

---

## Quick start

```bash
npm install                      # Node 20+ (tested on Node 24, Windows 10)
cp .env.example .env             # every key is optional; see below
npm run cameras:validate         # checks every camera URL (~1 request/s)
npm run worker                   # terminal 1: live polling + detection + iMessage agent
npm run dev                      # terminal 2: dashboard at http://localhost:3000
npm test                         # unit tests
```

The ONNX model (`models/yolov8s-960x544.onnx`, 43 MB, COCO-pretrained YOLOv8s from Ultralytics, AGPL-3.0) is committed, so nothing is downloaded at runtime.

### Environment (`.env`)

| Variable | What it enables | If missing |
|---|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | AI confirmation of each flagged frame (server-side only) | Detections are kept and labeled **"unconfirmed (AI unavailable)"** |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | The iMessage agent (Photon Spectrum cloud, free shared line) | The dashboard and detection still run; the agent status reads "not configured" |
| `SHOULDERWATCH_511GA_KEY` | Official 511GA incident comparison, plus exact camera coordinates | A manual check button on each detection ("Was it on the 511GA map?") |
| `SHOULDERWATCH_SNAPSHOT_RETENTION_HOURS` | How long flagged snapshots are kept | 24 |
| `NEXT_PUBLIC_CARTO_BASEMAPS_KEY` | CARTO dark basemap on the Map tab (free key; public by design) | Darkened OpenStreetMap tiles |

### Finishing the Photon (iMessage) setup
1. Sign in at <https://app.photon.codes>, create a project, and enable **iMessage**. The free tier uses Photon's shared line, which supports one-to-one chats only.
2. Copy the project ID and secret into `.env` as `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`.
3. Restart `npm run worker`. The log should print `[agent] Spectrum connected`, and the dashboard header should show `iMessage: connected`.
4. Text the line number shown in your Photon dashboard: `how's I-75?`

Before Photon is set up, you can check the agent's replies offline against the worker's real live data. This parses the message exactly as the agent does, prints the reply, and saves the attached photos:
```bash
npm run agent:dry -- "how's I-85 near Clairmont?"
npm run agent:dry -- "how's traffic on I-85?"
npm run agent:dry -- "what am I watching?" --from=+14045550123   # whose subscriptions to show
```

Without credentials, the SDK fails like this (the worker catches it and keeps running):
```
Error: Cloud iMessage requires projectId and projectSecret. Pass credentials to Spectrum() or provide explicit clients with imessage.config({ clients: [...] }).
```
With wrong credentials it fails with `SpectrumCloudError: {"type":"validation","on":"params",...}`, and the worker retries with backoff.

---

## Texting the agent

| You text | Shoulder Watch replies |
|---|---|
| `how's I-75 near Midtown?` · `hows the connector` · `how's 285?` | 2–3 current annotated camera photos plus a one-line summary (cameras live, vehicles visible, traffic level, any flagged stall) |
| `how's traffic on I-85?` · `is 285 bad?` · `traffic near Midtown` · `how bad is the connector` | Traffic level per camera (**light / moderate / heavy / stop-and-go**): a one-line road summary with snapshot age, a per-area breakdown worst first (e.g. `• I-85 S near Decatur: heavy (worst at Clairmont Rd)`), and photos of the 1–2 worst cameras. Frozen or offline cameras are skipped and counted; night frames add "night: counts may be low" |
| `any stalls?` · `anything happening?` · `any stalls on I-85?` | Every active detection (road, direction, location, minutes stopped, AI verdict, "unverified" if it was already there when monitoring began), with a photo each (max 3). If none: says so and how many cameras are being watched |
| `status` · `what am I watching?` | Your active subscriptions and when each ends |
| `cameras on I-85` · `which cameras do you have on 285?` · `cameras` | That road's camera names and areas (plus any that are frozen or offline), or a per-road count |
| `watch I-85 7-9am` · `watch I-75 for 2 hours` · `watch I-20 until 11pm` · `watch I-285` (default 2 h) | Subscribes you. During the window, a new stall on that road sends something like **"⚠️ Stationary vehicle, I-85 S at Clairmont Rd, stopped 6 min. Move over if you can."** with a photo |
| `stop` | Unsubscribes you and **deletes your number** (subscriptions and alert history) |
| anything else | Help text |

**Directions:** add one to any camera question to filter by the camera's direction of travel: `how's I-85 S near Clairmont`, `traffic on I-75 northbound`, `cameras on 285 outer loop` (outer loop = counterclockwise, inner loop = clockwise). If no camera faces that way, the reply says so and shows both directions.

**How the traffic level is computed** (cutoffs `TRAFFIC_*` in `config/thresholds.ts`): per camera, from the latest fresh frame:
- **stop-and-go:** at least 4 vehicles, with at least 60% still in the same spot as one frame earlier (the same rule as congestion).
- **heavy:** at least 10 vehicles, or at least 5 with 30% of them held in place.
- **moderate:** at least 5 vehicles.
- **light:** anything less.

A count at least 1.5× the camera's recent average bumps the level up one step, once it has 3+ frames of history. The road summary is the median camera.

Caveats: counts are detector boxes on a 450×253 snapshot, so they are visible vehicles, not true volume, and night undercounts. A static false positive (e.g. a sign) adds 1. Frames arrive only every ~7–12 minutes, so the level can't measure speed: "held in place" only catches vehicles that stand still for minutes. A busy road at full speed reads as moderate/heavy by count alone. The snapshot age is when the worker *received* the image; 511GA doesn't expose capture time.

Roads it understands: I-75, I-85, the Downtown Connector (I-75/85), I-285 ("the perimeter"), I-20, and GA-400 (no cameras yet). Areas it understands: Midtown, Downtown, Buckhead, Airport, Spaghetti Junction, Cumberland, Decatur, Sandy Springs, South Atlanta, and East Atlanta.

Alert limits for the shared line (in `config/thresholds.ts`): one alert per person per detection, at most one per person every 10 minutes, and at most 30 alerts per hour across everyone.

---

## Map view

The **Map** tab (or `localhost:3000/?view=map`) plots every camera on a dark basemap. Tiles load from a CDN, so the map needs internet, while the wall and detections don't.
- **Basemap:** CARTO now requires a free basemaps key ([get one](https://carto.com/basemaps/apikey), emailed in about a minute). Put it in `NEXT_PUBLIC_CARTO_BASEMAPS_KEY` and restart `npm run dev` to get CARTO `dark_all` (© OpenStreetMap contributors, © CARTO). The key is public by design, since it rides in every tile URL. Without a key, the map uses standard OpenStreetMap tiles darkened in CSS (© OpenStreetMap contributors) and says so above the map.
- Each camera is a dot colored by its traffic level: green light, yellow moderate, orange heavy, magenta stop-and-go. Frozen, offline, or unreachable cameras are a dashed gray dot.
- Active detections pulse red at their camera, or amber if their arrival wasn't seen. The pulse stops with reduced motion.
- Click a camera for its latest frame, road and direction, vehicle count, status, and age. Click a stall for a link that opens it in **Detections** (`?view=detections#det-<id>`).
- The **Detections in last 24 h** toggle adds small markers for cleared detections.
- The map shows "Camera positions approximate" until `npm run cameras:validate -- --fix-coords` loads official 511GA coordinates for every camera and sets `coordsSource: "511ga"` in `config/cameras.json`.
- In REPLAY mode the map shows only the recorded cameras and detections, with the REPLAY banner and badges.

## Live mode vs REPLAY mode

- **Live (default):** `npm run worker`. Polls real cameras, and the header shows a green **LIVE** dot.
- **REPLAY:** `npm run worker:replay`. Use this when the venue Wi-Fi fails. It plays back **recorded frames of real past detections** from `./replay` through the same detector and tracker, faster than real time but with the original timestamps. The dashboard shows a full-width **"REPLAY: recorded data, not live"** banner, every replayed detection carries a **REPLAY** badge, and iMessage replies start with "REPLAY (recorded data, not live)". Replay alerts to subscribers are off unless you pass `--replay-alerts`, and when on they are prefixed `[REPLAY – recorded data]`.
- If the worker stops, the header switches to **WORKER OFFLINE**. Stale data is never shown as live.

**Recordings included** (real frames from the 2026-10-10 night test run):
- `replay/2026-10-11-1737-590936`: a vehicle stopped on the right shoulder of the I-285 CCW bridge at I-75, 11:06–11:25 PM. It was already there when monitoring began, so its arrival is *unverified* and it was not AI-confirmed.
- `replay/2026-10-11-1729-383e6e`: a car parked in a lot beside I-85 at Bobby Brown Pkwy, a **known false positive** that the camera's `ignoreZone` now suppresses. Replaying it shows the fix: no new flag.

Capture a daytime stall before judging if you can; it makes a much stronger replay.

**Recording a replay:** after a live detection, run `npm run replay:capture -- --list`, then `npm run replay:capture -- <detectionId> "note for the banner"`.
**Demo reset:** `npm run demo:reset` wipes runtime data (frames, detections, subscribers, alert log) and seeds the detections log with the recorded detections in `./replay`, labeled REPLAY, so the dashboard is useful immediately.

---

## Adding cameras

`config/cameras.json` holds 34 hand-curated cameras. Each camera's `id` is the number in `https://511ga.org/map/Cctv/{id}`.

**Finding IDs on the map:** open <https://511ga.org/map>, turn on the **Cameras** layer, and click a camera icon. In the popup, right-click the snapshot and choose *Copy image address*. You'll get `https://511ga.org/map/Cctv/1695`, so the ID is `1695`. The caption burned into the image (for example `GDOT-0040: I-85 S past US23/ClairmontRd MM 90 (DeKalb)`) gives you the name, road, and direction.

> Tip: in the core metro block (511GA IDs ~1680–1780), the ID is close to the GDOT number + 1655 (GDOT-0040 → 1695, GDOT-0068 → 1723, but GDOT-0024 → 1680). It is only a hint for guessing neighbors; always confirm the caption with the validator.

Add an entry at the end of the list:
```json
{ "id": 1696, "gdot": "GDOT-0041", "name": "I-85 S before Clairmont Rd", "road": "I-85", "direction": "S", "lat": 33.84, "lng": -84.32, "area": "Decatur" }
```
Then run `npm run cameras:validate -- 1696`. Coordinates are approximate until your 511GA key arrives; after that, `npm run cameras:validate -- --fix-coords` fills in the official values from the documented cameras API. If a camera looks at a parking lot or frontage road, add `"ignoreZones": [[x, y, w, h]]` (fractions of the frame) so parked cars there are never flagged.

---

## Architecture

```
            public PNGs (https://511ga.org/map/Cctv/{id}, ≤1 req/camera/min, jitter, backoff)
                                   │
┌──────────────────────── worker (Node, tsx) ────────────────────────┐
│ poller ──► frozen? (same SHA-1 N times) ──► YOLOv8s ONNX (CPU)      │
│               │ unavailable placeholder?        │ boxes + 32×18 thumb│
│               ▼                                 ▼                    │
│        status only                   tracker (pure, unit tested)    │
│                                       stationary / congestion /     │
│                                       scene change / cleared        │
│                                                 │                    │
│              Gemini structured check (optional) ◄┤                   │
│              511GA events match (optional)    ◄─┤                    │
│              iMessage alerts (Spectrum)       ◄─┘ rate-limited       │
│ Spectrum agent: how's / watch / stop  ◄──► photon cloud (optional)  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ atomic JSON + PNG writes: data/state.json, detections.json, live/, snapshots/
┌───────────────▼──────────────── dashboard (Next.js 15) ─────────────┐
│ /api/state (polled every 10 s) · /api/file (data/ and replay/ only) │
│ /api/manual (manual 511GA checks; separate file, no write races)    │
│ Live wall · Detections log with snapshot timeline · GDOT credit     │
└──────────────────────────────────────────────────────────────────────┘
```

- **One TypeScript codebase.** Spectrum is TypeScript-only, so the worker and the dashboard share `src/lib`.
- **Files instead of a database.** Nothing native to install and nothing to fail at a venue. The worker is the only writer of detections and state; the dashboard writes only `manual-checks.json`.
- **Degrades gracefully.** Spectrum errors reconnect with backoff and never stop polling. Gemini errors leave the detection marked "unconfirmed (AI unavailable)". A dead camera shows **Unreachable** (network/HTTP error, with exponential backoff up to 15 minutes), **Camera offline** (511GA's "stream not available" placeholder, matched by hash), or **Feed frozen**.

## Stall-detection logic

All thresholds live in [`config/thresholds.ts`](config/thresholds.ts). Each poll for one camera goes through these steps:

1. **Frozen feed.** If the image bytes are identical to the previous poll (same SHA-1), the frame is not analyzed (no new information). After `FROZEN_AFTER_IDENTICAL_POLLS = 4` identical polls **and** `FROZEN_MIN_UNCHANGED_MS = 20 min` unchanged, the tile shows *Feed frozen — not analyzed*, and a frozen feed can never produce a detection. The time floor exists because, measured on a Saturday night, the core metro feeds refreshed every 400–490 s and the others every 620–740 s, not every 1–2 minutes.
2. **Scene change.** The frame is compared with the previous one as 32×18 grayscale thumbnails. If more than `SCENE_CHANGE_FRACTION = 50%` of cells changed by more than 40 levels, the operator panned or zoomed, so all tracks reset (active detections clear with reason "scene change").
3. **Detect.** YOLOv8s at 960×544 (about a 2× upsample of the 450×253 frame) keeps car, truck, bus, and motorcycle boxes with score ≥ 0.25, after NMS. It drops boxes under the burned-in caption bar, tiny boxes, and boxes inside a camera's `ignoreZones`.
4. **Track by position.** Each box is matched to an existing track by IoU ≥ 0.5 against the track's **first** position (its anchor), with center drift ≤ 35% of the box diagonal. A creeping vehicle stops matching. A track may miss one frame (detector flicker) before it is dropped.
5. **Stationary.** A track is stationary when it has been matched in ≥ `MIN_STATIONARY_FRAMES = 3` fresh frames spanning ≥ `MIN_STATIONARY_SECONDS = 150`, with a mean detector score ≥ `STATIONARY_SCORE_MIN = 0.35` (boxes are still drawn from 0.25).
6. **Stall vs congestion.** It is flagged as a stall only if
   - **other traffic moved** while it sat still (new or departed vehicles in the same view; `REQUIRE_OTHER_MOTION`), and
   - the view is **not congested**: congestion means ≥ 4 vehicles in view with ≥ 60% of them stationary.
7. **Arrival check (pixel level).** Signs, lane markings, and barriers also "stay put". Before a flag becomes a detection, the worker compares a 16×16 grayscale crop of the box against the same region in every buffered frame from *before* the track began:
   - if it matches any earlier frame (mean diff < `BACKGROUND_DIFF_MAX = 15`), it's background and is rejected;
   - if it differs from at least `ARRIVAL_MIN_PRE_FRAMES = 2` earlier frames, the **arrival is verified** and the detection alerts;
   - otherwise (e.g. right after startup) it's logged as **unverified** ("present when monitoring began"), shown in amber, and never alerts.
8. **Lifecycle.** A flagged vehicle becomes an **active** detection: snapshots go into the timeline, the Gemini check runs, the 511GA match runs, and subscribers are alerted. When the vehicle leaves (missed for more than one frame), the detection is **cleared**. One stationary for more than 90 minutes is relabeled *long-parked* and no longer alerts. If the feed is lost for more than 15 minutes, active detections clear as "feed lost".

## Privacy and ethics
- Only public, low-resolution GDOT snapshots are used, and only through documented URLs. There is no scraping of 511GA's internal endpoints.
- No plate reading and no person identification. The Gemini prompt explicitly forbids both.
- Raw frames stay in a 10-frame in-memory buffer; only the latest frame per camera is written to disk, and it is overwritten every poll. Flagged snapshots are deleted after 24 hours (configurable). Curated replay recordings in `./replay` are kept on purpose for demos.
- Phone numbers are stored only for alerts, are redacted in logs, and are deleted on `stop` or when a timed subscription expires.

---

## 2-minute demo script

1. **(0:00) Hook.** "Every day, Atlanta drivers stall on the shoulder of I-85, and the first warning anyone gets is brake lights. GDOT already has hundreds of public cameras. Shoulder Watch watches them for you."
2. **(0:15) Live wall.** Show `localhost:3000`: the green LIVE dot, 34 interstate cameras, and the per-camera status (OK, Feed frozen, Offline). Toggle vehicle boxes: "Local YOLO, no cloud, on every fresh frame." Point at a frozen tile: "Frozen feeds are detected and never analyzed, so they can't cause false alarms."
3. **(0:40) The stall.** Open **Detections** (or go straight to `localhost:3000/?view=detections`). Pick the strongest detection (live, or the REPLAY-badged seed) and scroll its snapshot timeline: "Same spot for 3+ frames while traffic flows past is a stall. If everyone is stopped, it's congestion. If the camera pans, we reset." Show the AI verdict, or the honest "unconfirmed (AI unavailable)" label.
4. **(1:05) iMessage.** On your phone, text `how's I-85 near Clairmont?` and show the photos that come back. Then text `watch I-85 for 1 hour`: "Next stall on I-85 lands on my phone: '⚠️ Stationary vehicle… Move over if you can.'" Then text `stop`: "and my number is deleted."
5. **(1:30) Official comparison.** "With a 511GA key we match each detection against official incidents and show whether we beat them. Until then, there's a one-click manual check."
6. **(1:45) Close.** "See, understand, react: computer vision on public infrastructure, an agent in iMessage, and drivers moved over sooner." If the Wi-Fi dies, run `npm run worker:replay` and say clearly that the yellow banner means recorded data.

## Known limitations / false positives
- **Night:** in dark, grainy, glare-heavy frames the COCO model misses many vehicles. Tiles show *night: low reliability*, and night detections are tagged.
- **Parked vehicles near the road** (seen live: cars in a lot beyond I-85 at Bobby Brown Pkwy were flagged after 16 min; an `ignoreZone` now covers that lot). Mitigated by `ignoreZones`, the arrival check (cars parked before monitoring began are unverified), the 90-minute long-parked relabel, and the Gemini `parked_or_work_zone` verdict. A car that parks in an unzoned lot *while we watch* will still be flagged.
- **Work zones, police, and tow trucks** on the shoulder are really stopped vehicles. The tracker flags them correctly as stationary; whether that is an "incident" needs the AI check or a human.
- **Signs, lane markings, barrels misdetected as vehicles** (seen live: wide double-dash lane markings scored 0.5–0.6 as "car" on I-20 at Columbia Dr). They stay put by definition. The arrival check rejects them once the camera has a little history; in the first frames after startup they show up as amber *unverified* items without alerts. Gemini would catch most of the rest.
- **Slow-refreshing feeds:** measured at night, the feeds updated only every ~7–12 minutes, so three fresh frames take ~15–25 minutes instead of 3–6 (daytime refresh may be faster; not measured). Polling stays at once a minute so new frames are picked up promptly.
- **Heavy congestion hides stalls:** a stall inside a jam is labeled congestion by design.
