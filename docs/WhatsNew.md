# What's New in Sitrec

<!--
## AI Instructions for Updating This Document

IMPORTANT: Always check what the last documented version is, and update ALL missing versions up to the current version.

CRITICAL - DO NOT HALLUCINATE:
- ONLY document features that are explicitly mentioned in git commit messages
- NEVER invent, guess, or assume features that might exist
- If a commit message is unclear, examine the actual code changes
- If you cannot verify a feature from commits, DO NOT include it
- It is better to have a sparse changelog than an inaccurate one

When updating this changelog:

1. **Check last documented version**: Look at the first version heading below these instructions
2. **Get version tags**: Run `git tag -l "2.*" --sort=-version:refname --format='%(refname:short)|%(creatordate:short)' | head -20`
3. **Get commits between versions**: Run `git log [old_tag]..[new_tag] --pretty=format:"%s"` for each missing version
   - To find the previous tag, list all tags and find the one before: `git tag -l "2.*" --sort=-version:refname`
4. **Get commits since last tag**: Run `git log [latest_tag]..HEAD --pretty=format:"%s"` for unreleased changes
5. **Verify each entry**: Every changelog entry MUST correspond to an actual commit message
6. **Categorize entries**:
   - **New Features**: New functionality, UI additions, new file format support
   - **Improvements**: Enhancements to existing features, performance, UX improvements
   - **Bug Fixes**: Entries starting with "Fixed", "Fix", corrections to existing behavior
7. **Write clean descriptions**: Convert commit messages to user-friendly descriptions. Look at actual code changes if the commit message is unclear.
8. **Format**: Use present tense, focus on user benefit, be concise
9. **Add new versions at the top** of the document, below these instructions
10. **Include the date** with each version heading
11. **Omit empty sections**: If a version has no New Features, don't include that heading

Example entry format:
## Version X.Y.Z (YYYY-MM-DD)

### New Features
- Feature description focusing on what users can now do

### Improvements  
- Enhancement description

### Bug Fixes
- Fixed issue description
-->

---

## Version 2.56.1 (2026-05-20)

### Improvements
- **3D Buildings access expanded to Registered and Verified users**: the Cesium OSM and Google Photorealistic 3D Buildings sources were previously gated to Admin, Sitrec Members, and Sitrec Plus only. Registered (group 2) and Verified (group 9) users are now in the allowlist with a baseline daily quota of 30 Google 3D root sessions and ~35.8 MB of Cesium OSM bytes per day. Members and Plus tiers have been re-laddered to 2× and 4× the baseline respectively (Members: 60 root / ~72 MB; Plus: 120 root / ~143 MB). The client `CNodeTerrainUI` allowlist mirror was updated to match the server, so the Show Buildings toggle now appears for the newly-eligible groups even before the server's `canUse3DBuildings` field is read.
- **AI Chatbot tier ladder rebuilt**: added a new Sitrec Plus (group 19) tier with the same premium model set as Sitrec Members (GPT-4o, Claude Sonnet 4, Llama 3.3 70B) but 10× the rate limit (200/min, 1000/hr). Upgraded Registered (group 2) to match Verified (group 9) — GPT-4o Mini and Llama 3.3 70B at 10/min, 50/hr, replacing the prior Llama 3.1 8B / 5/min basic tier.
- **Tile-usage daily-quota drift fix**: `tile_usage.php`'s `$TILE_DAILY_LIMITS` table previously listed only Admin, Members, and Plus, with Plus quotas equal to Members. It now mirrors the rehost.php tier ladder exactly (Registered/Verified at baseline, Members at 2×, Plus at 4×) and carries a header comment cross-referencing the rehost.php tables to prevent future drift.

## Version 2.56.0 (2026-05-20)

### New Features
- **File → Export → Image Set**: orbit the look view's camera around the current target and dump every (az, el) pose as a PNG inside a zip. Inputs are *AZ Step* (1-90°), *EL Start* (0-80°, default 10°), and *EL Step* (1-90°). Az sweeps the full 360° at each elevation; el sweeps from *EL Start* to 90° (straight down) and the pole image is included exactly once. The camera-to-target distance is fixed at whatever it was when you pressed the button, so the orbit is a true sphere around the target. Target resolution falls back through `targetObject` → `traverseObject` → `targetTrack` → `targetSphere`, so the exporter works in custom sitches and in jet sitches (ATFLIR pod). Controllers on `lookCamera` (TrackPosition, PTZUI, LookAtTrack, BankRoll, …) are temporarily disabled so the orbit pose isn't snapped back to the track between captures, and `preRenderFunction`/`focusTrackName`/orbit controls are neutralised for the same reason. Before each capture the helper renders the new pose a few times and then runs `waitForExportFrameSettled` (terrain map+elevation tiles, 3D Tiles streaming, video decode, async-op registry) with stricter `stableChecks=4`/`postSettleRenders=2` so the foreground geometry is actually loaded before the PNG is encoded — fixing a "first shot has holes in the foreground" symptom on big initial camera jumps. A second button — *Export Image Set (Fullscreen)* — additionally enters fullscreen, hides the menu bar, the lookView compass (`compassLook`), the clock/UTC overlay (`labelVideo`), the map-attribution overlay (`Globals.settings.showAttribution`), pushes effects render scale to native (`renderScale = 1`), and pushes Effects → Resolution (`canvasResolution`) to the screen width — all capped at 1920 px wide on the saved PNG so output stays portable. Files land as `<sitch>_imageset[_fs]_<timestamp>.zip` with image names `<sitch>[_fs]_el<sign><deg>_az<deg>.png`, where padding makes alphabetical sort match the capture order (outer loop = el, inner = az). All state — camera pose, controllers, settings, fullscreen, UI visibility — is restored in `finally` regardless of success/abort.
- **OBB-based 3D tile culling (V5)**: 3D Tiles map/elevation visibility is now decided by oriented-bounding-box tests against the camera frustum rather than the previous sphere-based proxy. The new culler ships with a `tile.altitudeBounds` measurement pipeline (`tile.cullingState` lifecycle: PENDING → MEASURED, transactional commits, REPLACE-refinement invariants enforced across views and zooms) so each tile uses its own actual elevation range instead of a conservative shared sphere — eliminating the over-conservative "tile rendered because its sphere clips the frustum even though the actual surface is far below the camera" false positives that drove unnecessary tile downloads on aerial views. OBB mode is now the default for both `mainView` and `lookView` (no silent fallback to sphere mode if measurement fails — failures are visible). Optional debug overlay highlights OBB extents and per-pass stats; the cull-mode controls live in the debug-only knob area. Phases include a sphere-mode warmup (Phase 2/2.5), an OBB narrow-phase with squared-screen-error distance (Phase 3), and the parent-bounds inheritance + REPLACE invariant work that landed in 2.55.0's tail.

### Improvements
- **BankRoll: skip non-live frames to avoid polluting `ptz.roll`**: the bank-roll controller was sampling the camera bank/heading on every applied frame, including frames where the camera node wasn't actually being driven by a live source (initialisation, settle passes, export sweeps). Those samples leaked into `ptz.roll`, drifting the displayed roll away from the true value across sitch reload and pause/resume. The controller now early-returns on non-live frames so `ptz.roll` only reflects real heading changes.
- **OBB cull V5 hash collision fix + per-frame stats reset**: the per-tile visibility hash used 32-bit math that collided on large tile sets (≥4M entries); switched to a wider mix and added a per-frame reset of the stats bag so cumulative counters don't bleed across renders during long sessions.
- **Security: webpack-dev-server 5.2.3 → 5.2.4 + ws 8.20.0 → 8.20.1 in /tools/SitrecBridge**: dependency bumps pick up upstream security/stability fixes. Dev-only and bridge-only, no runtime/serverless impact.

### Bug Fixes
- **OBB cull V5: fix z-fighting from V5 sphere in coverage recursion**: the coverage-recursion path was running the V5 sphere test against tiles whose altitude bounds hadn't yet been measured (`tile.altitudeBounds.measured === false`), occasionally returning "visible" for tiles already replaced by their children — producing flickering z-fights along refinement seams. V5 sphere/OBB checks now gate on `altitudeBounds.measured` and fall back to the conservative existing behaviour for unmeasured tiles.

## Version 2.55.0 (2026-05-17)

### New Features
- **ASTERIX CAT-048 / CAT-062 PCAP import**: drag-and-drop a libpcap or pcapng capture of an ASTERIX UDP multicast (or a raw ASTERIX byte stream) and Sitrec parses it into MISB rows consumed by the existing TrackManager. CAT-048 target reports are projected from radar polar coordinates to WGS-84 using a per-SAC/SIC reference table (default Zagreb LDZA for the Croatia Control sample captures); CAT-062 system tracks use the in-message WGS-84 position directly. Because a single snapshot PCAP usually carries each aircraft once — below the track system's 2-point minimum — the parser emits a 4-second velocity-projected sibling plus phantom bookend rows aligned to the sitch's integer-ms boundaries so every aircraft stays visible across the entire playback timeline. pcapng captures share the same Ethernet/IPv4/UDP extraction path as classic pcap. For CAT-062 the parser walks the I062/380 compound to extract the I062/040 track number and synthesizes `T<sac>_<sic>_<trackNumber>` when the callsign is missing, so distinct tracks from one radar no longer collapse together; CAT-048 now looks up `radarRef` per record (with a DEFAULT_RADAR fallback) instead of stickily reusing the last known radar across unknowns. Sample captures live in `test-data/TEST-Radar/` and verify against the README's published ground-truth for DLH65A (Mode-S 0x3C660C, FL330, 434 kt) to within 1%.

### Bug Fixes
- **Edit Mask paints instead of panning the video**: in Motion Analysis → Masking, clicking and dragging the video with **Edit Mask** enabled used to both paint the mask *and* pan the video, because the mask-overlay canvas has `pointer-events: none` and the video view's underlying `CMouseHandler` fired its left-drag pan handler in parallel with the overlay's document-level paint handler. `CNodeVideoView`'s drag handler now early-returns when the motion-analysis mask overlay reports `editing === true`, mirroring the existing guard for tracking-overlay control drags. Right-drag (frame scrub) and middle-drag (zoom) are unaffected.
- **Multi-aircraft MISB files render all aircraft**: `TrackManager.makeMotionTrack` previously created a 2 m invisible sphere whenever `trackIndex !== 0`, on the assumption that index > 0 always meant a MISB FrameCenter co-located reference. The gate now consults `isSupplementaryTrack()`, which `CTrackFileMISB` overrides to return `false` for files containing multiple distinct TrackIDs (e.g. an ASTERIX drop with 42 aircraft, where only the first would otherwise be visible).

## Version 2.54.5 (2026-05-14)

### Improvements
- **Atmospheric refraction now defaults to off**: the celestial-bending feature added in 2.54.0 was enabled out-of-the-box, which silently shifted Sun, Moon, planet, star, constellation-line, and satellite positions toward the zenith on first load — surprising users who hadn't yet noticed the new Atmospheric Refraction toggle in the View menu. The default is flipped to off so the rendered sky matches the unrefracted celestial coordinates unless the user explicitly enables it. Existing custom sitches that already serialized `refractionEnabled: true` keep their setting; only sitches without the field (built-in sitches, anything saved before 2.54.0) pick up the new default.

## Version 2.54.4 (2026-05-14)

### Improvements
- **Security: bumped `express-rate-limit` 8.3.1 → 8.5.2 in root and added `ip-address ^10.2.0` override in SitrecBridge**, picking up the fix for the medium-severity XSS in `ip-address` Address6 HTML-emitting methods (Dependabot alerts #111, #112). The vulnerable code path was only reachable through transitive deps, but lockfiles now pin the patched version explicitly.

## Version 2.54.3 (2026-05-12)

### Bug Fixes
- **Video stabilization no longer drifts off precisely-tracked objects**: pressing *Stabilize* after Auto-Tracking would leave the tracked object drifting around the centre by up to its own width, even though the on-screen tracking cursor stayed glued to the object on every frame. `CVideoData.setStabilizationData` was running every tracked point through a spike filter that replaced any point deviating more than 10 px and more than 3× neighbour motion from a linear interpolation of its neighbours — a heuristic meant to catch OpenCV outliers but indistinguishable from genuine non-linear motion (a thrown ball, a turning aircraft). The on-screen cursor read from the raw `trackedPositions`, while stabilization read from the *filtered* copy, so the two visibly disagreed at every modified frame. The filter has been removed; stabilization now uses the tracking data verbatim, matching what the cursor displays.

## Version 2.54.2 (2026-05-11)

### Bug Fixes
- **CPA time and camera framing restored for multi-aircraft KML drops**: dropping a KML containing two distinct aircraft (e.g. an FR24 export with two `<Folder>` tracks) was leaving the playhead at the first sample of track 0 instead of advancing to the closest point of approach, and leaving the main camera over the second track's bounding-box centre — typically hundreds of km from where the flights actually pass each other. The CPA guard in `TrackManager.centerOnTrack` used `trackIndex === 0` as a proxy for "primary, not supplementary"; correct for MISB where index>0 is a co-located FrameCenter target, wrong for KML where every track is its own flight. Replaced the proxy with an explicit `isSupplementaryTrack(trackIndex)` hook on `CTrackFile` (default `trackIndex > 0`, preserving MISB behaviour); `CTrackFileKML` overrides it to return `false`. CPA now also repositions the main camera above the midpoint of the two flights at the closest-approach moment, with a framing margin that scales with their separation.

## Version 2.54.1 (2026-05-11)

### Bug Fixes
- **KML polygons with pretty-printed coordinates now load**: `CTrackFileKML.extractCoordinates` was splitting the `<coordinates>` text on a single literal space character, but the KML 2.2 spec separates tuples by *any* whitespace (space, tab, CR, LF). Files that exported one coordinate per line — common from Google Earth, GIS tools, and hand-written KML — produced 7 empty tokens between each real tuple, which `Number("")` silently coerced to `0` (the middle field), leaving `[NaN, 0, NaN]` rows interleaved with the real ones. The track that should have had N frames came out with ≈8N frames, most of them NaN, and the cascade of `trackPoint has NaNs` asserts in `CNodeDisplayTrack.recalculate` / `makeTrackWall` blocked rendering. Now splits on `/\s+/`, filters empty tokens, defaults missing altitude to 0 (for 2D tuples), and drops any tuple that doesn't yield three valid numbers. The existing "polygon → display track with cap" pseudo-building path is unchanged — these polygons just couldn't reach it before.

## Version 2.54.0 (2026-05-11)

### New Features
- **Atmospheric refraction for celestial rendering**: bends apparent positions of the Sun, Moon, planets, stars, constellation lines, and satellites toward the observer's zenith using Saemundsson's formula. Refraction runs per-vertex in the shader for the Sun/Moon so their disks flatten correctly near the horizon; CPU-side bends keep the picker, labels, and ground arrows aligned with the rendered dots. New GUI controls (Stellarium-style defaults: 1010 hPa, 10 °C) serialize with the sitch — `Sit.refractionEnabled`, `refractionPressure`, `refractionTemp`.
- **Asterism Style dropdown** (Celestial menu): switches between the existing d3-celestial asterisms (default) and Astrometry.net's constellation line set, so the rendered night sky can be visually matched against Astrometry.net plate-solve plots. The new dataset is derived from Astrometry.net's `catalogs/stellarium-constellations.c` (BSD-3-Clause); the ThirdPartyNotices generator gains a `DATA_FILES` section attributing the new file plus the previously-uncredited d3-celestial constellation files, IAU-CSN, and BSC5.
- **Levels Midpoint slider** (Video → Video Adjustments): Photoshop-style gamma curve for video midtones — `output = input^(1/midpoint)`. Range 0.1–5.0, default 1.0; >1 brightens midtones, <1 darkens them, while pure black/white are preserved. Implemented via a cached 256-entry LUT and an offscreen canvas in the per-frame pixel pipeline (CSS `ctx.filter` has no native gamma), applied after echo accumulation and before brightness/contrast/blur so it acts as a base tone adjustment. Reset by "Reset Video Adjustments".

### Bug Fixes
- **Track and LOS lines stay visible at lower MSAA levels**: `LineMaterial`'s `alphaToCoverage` path emits a smoothstep alpha that the GPU quantizes into MSAA-sample-mask coverage. With MSAA=4 (5 levels) sub-pixel-wide lines faded smoothly, but MSAA=2 (3 levels) showed periodic gaps and MSAA=0's α<0.5 discard made lines disappear. At MSAA<4, line width is now clamped to at least 1 framebuffer-pixel — the rasterized triangle is always ≥1 px wide and its center passes the discard threshold. The clamp updates on the fly when MSAA toggles at runtime (the requested width is stashed in `userData.originalLinewidth` so Quality preset, which uses MSAA=4, keeps the originally-requested widths).

## Version 2.53.2 (2026-05-11)

### Bug Fixes
- **Horizon Extractor enabled state now serializes**: enabling the overlay, saving the sitch, and reloading previously dropped the enabled state — the overlay came back off. `serializeHorizonExtractor` now writes the `enabled` flag alongside `keyframes`, `deserializeHorizonExtractor` restores it (auto-enabling the overlay and flipping the menu item to "Disable Horizon Extractor"), and the "nothing to save" early-return now requires *both* an empty keyframe set *and* the overlay being off (previously dropped the enabled state when no keyframes existed yet). Old saves without an `enabled` field continue to load with the overlay off.

## Version 2.53.1 (2026-05-11)

### Bug Fixes
- **Horizon Extractor → Bank sign flipped**: the "Horizon Extractor" turn-rate source in Simple Flight Sim was driving bank in the wrong direction. A right bank rotates the aircraft CW (viewed from behind), so the world — and the horizon — appears to rotate CCW from the aircraft's POV. The horizon-extractor angle is CW-positive in screen space, so the bank signal must be its negation: `bank = -horizon`. The aircraft now turns in the same direction as the visible horizon tilt.
- **`CNodeGUIFlag` now serializes its value**: the flag class extended `CNodeConstant` directly and inherited only the base `CNode.modSerialize()`, which doesn't capture `value`. Every `CNodeGUIFlag` checkbox — including "Roll View with Bank" — was therefore failing to round-trip through save/load and reverted to its constructor default each time. Added `modSerialize`/`modDeserialize` mirroring the `CNodeGUIValue` pattern.

## Version 2.53.0 (2026-05-11)

### New Features
- **"Local from Constant Camera" wind fit** (Physics → Wind Data): button that solves for the local wind vector best explaining the camera track's ground-velocity variation, under the assumption that the camera is flying at approximately constant true airspeed. Geometry: in a local horizontal frame, ground velocity = air velocity + wind velocity — if airspeed is constant, the ground-velocity points trace a circle of that radius around the wind vector. Seeds from the heading at peak ground speed flipped 180° and `(max−min)/2` magnitude, then refines with a small genetic algorithm scored on airspeed standard deviation. Switches the local wind source to Manual so the fit actually takes effect — track or atmospheric sources would otherwise overwrite `from`/`knots` each frame. Track lookup covers the custom sitch's `cameraTrackSwitchSmooth` / `cameraTrackSwitch` as well as the legacy `jetTrack` / `cameraTrack`. Reports the resulting wind plus standard-deviation residual in the status line, e.g. `Local wind: 285° / 12 kt (σ=0.9 kt, cameraTrackSwitchSmooth)`.

### Improvements
- **`AddSpeedGraph` takes options object plus new `wind` parameter** (default `"targetWind"`): the speed-graph helper used by sitches now takes named fields instead of nine positional arguments, mirroring `AddValueGraph`. The new `wind` parameter routes the horizontal-air-speed series through any wind node, so a camera/airspeed graph can be charted against the local wind. All call sites (`JetStuff`, `SituationSetup`, `SitGoFast`, `SitAguadilla`) updated.

## Version 2.52.0 (2026-05-10)

### New Features
- **Horizon Extractor**: manual horizon-angle keyframing on the video. A new entry in the Video menu (under OSD Tracker) toggles a draggable cross overlay — drag the magenta centre to position it on the horizon, drag any of the four cyan handles at 0°/90°/180°/270° to rotate so the horizontal arm matches the visible horizon. Each move/rotate writes a keyframe at the current frame; between keyframes the cross interpolates linearly (positions and shortest-arc angle). Outside the keyframe range, the cross holds the nearest endpoint rather than extrapolating (extrapolation would push it thousands of pixels off-screen on long clips). Keyframes serialize into the sitch JSON for round-trip, *and* into localStorage keyed by sitch + video so an analyst can come back to a long session without losing work. Cross uses original-video coords throughout, so resolution/quality-preset changes don't break the geometry.
- **"From Bank" / "Horizon Extractor" turn-rate sources**: consolidated dropdown in Simple Flight Sim (`Turn Rate Source`) now picks between three signals — Manual Turn Rate (the legacy slider), Manual Bank (`g·tan(bank)/V` from a new Manual Bank slider), and Horizon Extractor (`g·tan(bank)/V` from the horizon-extractor's measured angle). Same formula and `CNodeTurnRateBS` node as Gimbal sitch uses. When the source is per-frame (Bank or Horizon), the racetrack pattern is bypassed — the supplied real per-frame turn rate drives the jet directly. The legacy "Turn Rate Control" dropdown that confusingly controlled the *heading* source is now renamed "Heading Source".
- **Roll View with Bank**: optional flag in Simple Flight Sim. When on, the look camera rolls by the bank angle so the rendered horizon tilts as if you were the pilot. Drives the PTZ's roll/rotation channel directly; bypasses the `syncFromCamera` overwrite that previously snapped roll back to zero each frame.
- **Frame-slider keyframe markers + navigation**: any tool that maintains a set of keyframed frames (currently the Horizon Extractor; designed for future use by auto-tracker, motion analysis, etc.) registers a provider with a new `KeyframeRegistry` and the slider draws yellow diamonds at those frames. `<` (Shift+,) and `>` (Shift+.) jump to previous / next keyframe across the union of all providers. Clicking a diamond on the slider navigates directly to that exact frame (with playhead-thumb overlap yielding to thumb-drag).
- **Line Width slider for track display**: new control in the track edit dialog (Line Color → Line Width), 0.5–10 px in 0.1 increments. The contrail controls moved under a `Contrails` sub-folder so the main controls aren't drowned out.

### Improvements
- **Track default widths reduced to 1 px**: the previously-thick `cameraDisplayTrack` / `satelliteDisplayTrack` / `satelliteDisplayTrack2` lines now render at 1 px by default. Removed a stray `width *= 3` multiplier in `CNodeDisplayTrack` that had been silently inflating every supplied width.
- **`Switch.choiceChanged.<id>` event**: `CNodeSwitch` now dispatches this event on every choice change — including the quiet path used by `modDeserialize` — so listeners can react to a deserialized state change that `Switch.onChange.<id>` (interactive-only) doesn't catch. Used by the Simple Flight Sim visibility hook to hide `Leg Length` / `Transition Time` when the active turn-rate source is per-frame.

### Bug Fixes
- **Racetrack pattern no longer overrides per-frame turn-rate sources**: `CNodeJetTrack.recalculate()` activated the racetrack-pattern rewrite whenever `legLength > 0`, regardless of where the turn rate came from. That made the jet fly straight for `legLength` seconds even when the Horizon Extractor (or Manual Bank) was supplying a real per-frame schedule — the racetrack code keyed on the constant `|turnRate|` and ignored the per-frame variation. Racetrack mode is now gated additionally on `turnRateSource.choice === "Manual Turn Rate"`. With any per-frame source, the supplied turn rate flows through unmodified.
- **Leg Length / Transition Time hidden when not in Manual Turn Rate**: the racetrack sliders were always visible even when the source was set to Manual Bank or Horizon Extractor, where they had no effect. Now hidden when not in Manual Turn Rate (and re-shown when toggled back). Saved sitches with a non-Manual source also load with the sliders correctly hidden via the new `Switch.choiceChanged.<id>` event. Discovered while fixing: `CNodeGUIValue.update()` actively syncs `guiEntry._hidden` to `this.visible` every render frame — a direct `guiEntry.hide()` gets reverted on the very next tick, so visibility must go through `node.show()` / `node.hide()`.
- **Arrow-key override removed from the Horizon Extractor**: ←/→ were previously hijacked to step by 15 frames (Shift+←/→ for single frame) when the overlay was enabled, stealing keys that the user expected to mean nothing (or something else globally). Removed — `,` / `.` continue to handle single-step globally, `<` / `>` handle keyframe jumps.
- **`CNodeControllerCustomHeading` no longer throws when no heading file is loaded**: switching `Turn Rate Source` exposed a latent crash in the heading-source code path when a file hadn't been loaded yet. Falls back to a manual heading value instead of dereferencing an undefined array.



### New Features
- **Simple Flight Sim folder under Physics**: TAS, Turn Rate, Total Turn, Jet Heading, and the new racetrack controls below all live in one place — was scattered across the top of the Physics menu.
- **Racetrack flight pattern**: two new controls in Simple Flight Sim — `Leg Length` (seconds, default 0) and `Transition Time` (0–10 s, default 3). When `Leg Length > 0`, the flight-sim camera flies straight for that long, smoothly ramps the turn rate up to the user-supplied Turn Rate over Transition Time, holds at full rate until 180°−2·rampDeg of turn is complete (`rampDeg = TurnRate × TransitionTime / 2`), ramps back down to zero over the same time, then repeats — a clean configurable racetrack with smooth bank-in/bank-out. Sign of Turn Rate selects left- or right-handed pattern. `Leg Length = 0` keeps the legacy constant-turn behaviour, so existing custom sitches are unchanged.
- **Hold-key auto-tracking loops** (`'` and `;`): hold `'` to advance frame-by-frame at video fps with the tracker re-running on each new frame (force-overwrites stale stored positions, re-inits the template/keypoints from the current cursor so a freshly-placed manual keyframe drives matching). Hold `;` to rewind at fps, deleting any tracked keyframe at each frame as it goes. The combination — rewind through a bad section with `;`, click to anchor manually, hold `'` forward — replaces the previous "all-or-nothing fast-track" workflow with one where auto and manual passes can be combined frame-by-frame.
- **High Peak / Low Peak tracking methods**: two new entries in the Tracking Method dropdown that find local maxima/minima of a Gaussian-blurred ROI. Motion-extrapolated seed from the last two tracked positions; Hessian eigenvalue-ratio test rejects line-like ridges (`trace²/det > 12`); relative-brightness gate requires the peak's *original* luminance to sit in the top 5% (high) or bottom 5% (low) of the ROI — adapts per-frame to lighting changes that fixed Brightness Threshold can't. Among qualifying peaks the largest blurred response wins ("brightest+largest" in one number — the blur attenuates sharp pixel-noise spikes more than wider blobs).
- **`Feature Size` slider with live peak-marker preview** (range 2–20 px, step 0.1, default 4): Gaussian sigma for High/Low Peak detection. While dragging, green dots appear over high-peak candidates and red dots over low-peak candidates (both gated by the same percentile threshold the picker uses, so what you see is what gets chosen). Lets you tune the sigma until the intended feature is the only nearby green/red dot before committing to a track.
- **Tracking Method dropdown unified**: previously `Center on Bright` / `Center on Dark` were standalone checkboxes that conflicted with the Tracking Method dropdown's settings. Now they are entries *in* the dropdown alongside Template Match, Optical Flow, High Peak, Low Peak, and SAM2 — exactly one method active at a time. Legacy saves with the old checkboxes auto-migrate to the equivalent dropdown entry.

### Bug Fixes
- **Physical Banking on flight-sim cameraObject no longer pitches the model nose-down**: `CNodeControllerObjectTilt`'s banking case did `lookAt(rawNext)` to face the object along the *raw* track, then `rotateOnWorldAxis(fwd_smoothed, bankAngle)` to roll using the *smoothed*-track velocity as the rotation axis. During racetrack ramp-in/out the 200-frame smoothing window lags 10°+ behind the actual heading, so the rotation axis wasn't parallel to the object's facing direction — what should have been a pure roll leaked a pitch component (`sin(bank) × sin(angle_between)` — at frame 2783 of the test sitch, `sin(42°) × sin(15.8°) ≈` the visible 16° nose-down tilt almost exactly). Now both the lookAt direction and the bank rotation axis use the smoothed forward, guaranteeing a pure roll regardless of how raw and smoothed tracks diverge during turns. Same fix applied to the AoA branch.
- **Auto-tracking save/restore: manual keyframes survive reload**: the `manualKeyframes` Set (which frames the user placed by hand vs auto-tracked) wasn't serialized. After reload, the magenta-circle overlay and the "delete keyframe under cursor" hit-test forgot which keyframes were manual. Now serialised as an array; round-trips correctly.
- **Auto-tracking save/restore: GUI controls show loaded values**: the seven tunable tracking controls (Track Radius, Search Radius, Tracking Method, Feature Size, Brightness Threshold, Stabilize Centers, Show N Keyframes) had get/set accessors writing through to `objectTracker.*` but no `.listen()`, so the displayed value only updated on user interaction. Saving a sitch with non-default settings and reloading showed defaults until you clicked each slider. Added `.listen()` to all seven so the GUI immediately reflects the loaded state.
- **`'` hold-loop now overwrites stale stored positions**: when stepping into a region pre-populated with stuck auto-track output (e.g. 100 frames all at the same dud position), `trackFrame` early-returned because `trackedPositions.has(frame)` was true — algorithm never ran. Added a `force` parameter (passed by the `'` hold-loop) that bypasses the early-return and seeds `prevPos` from the current cursor instead of `frame-1`, so a freshly-placed manual keyframe drives the algorithm forward through dud frames. The full-speed `Start Auto Tracking` keeps its original "skip already-tracked" optimisation.

## Version 2.50.6 (2026-05-08)

### Bug Fixes
- **Auto-tracking + stabilization survive save/reload across quality presets**: a saved sitch with auto-track + stabilization would come back broken on reload — at best the stabilization toggle was off; at worst (legacy saves) the stabilized image flew off-screen to the upper-left and the track-point cursor drifted right of the actual feature. Two compounding bugs: (1) `finishDeserialization` ran `deserializeAutoTracking` synchronously while the video's `loadVideoFromEntry` was still async-loading, so the stabilization branch silently no-op'd because `videoData` was null. (2) Tracker positions were stored in **decoded-image coordinates** that depend on the `videoMaxSize` quality preset (854×480 at Fast vs 1920×1080 at Quality) — a track captured under one preset became geometrically wrong under any other. Migrated tracker runtime to use the source video's *original* coordinate space (referenced to `originalVideoWidth`/`originalVideoHeight`, which is stable across presets). Boundary code scales to the actual decoded image only where pixels are touched: `getStabilizedImage` (CVideoData), `renderOverlay` (CObjectTracking), and tracking-algorithm I/O via a new `runAlgorithm` wrapper. Reload race fixed by re-applying `Sit.autoTracking` from `CNodeVideoView.continueVideoRestore` once the video is actually loaded. New saves carry an explicit `coordSpace: "original"` tag so future round-trips are deterministic; legacy saves are accepted as-is (they were already in original-video coords by accident of how the metadata `videoWidth` reads pre-resize).

## Version 2.50.5 (2026-05-07)

### Improvements
- **GPU Memory Monitor: per-view authoritative GL counters**: two new rows show `mainView (tex/geo/prog)` and `lookView (tex/geo/prog)` — Three.js's `info.memory.textures`, `info.memory.geometries`, and `info.programs.length`. These are the GL-side counts, not the scene-traversal estimates. If these climb during pan and *return to baseline* after pause, the underlying disposes are landing correctly and any persistent OS-VRAM growth is in Chrome's GPU-process pool (not directly fixable from JS). If they stay elevated after pause, it's a real leak in our code. Lets users distinguish "leak" from "slow GC" without guessing.
- **GPU Memory Monitor: "Force Render (drain dispose queue)" button**: triggers a synchronous render + `gl.flush()` on each view and logs before/after `info.memory` to console. Three.js's dispose model is event-based — `texture.dispose()` queues a deletion that the renderer processes on next render. After heavy pan + pause, hundreds of disposes can sit in the queue. Clicking this drains them deterministically; the before/after delta shows how much memory was waiting on the queue.
- **GPU Memory Monitor: numbers update even when the menu is closed**: previously `updateGUI()` early-returned when the debug folder was collapsed, leaving stale "0 MB" until the user opened the panel. Now updates run unconditionally (cheap, no observable cost) so opening the panel mid-session shows current values rather than the last-captured-while-open snapshot.

### Improvements
- **GPU Memory Monitor: 4× more accurate texture accounting**: the monitor was hardcoded against an old Three.js format-constant table — `RGBAFormat=1023` mapped (incorrectly) to `RedFormat`, charging every RGBA texture at 1 byte/pixel instead of 4. Switched to imported named constants (`RGBAFormat`, `RGFormat`, etc.) and added per-channel-type adjustment for `HalfFloatType` / `FloatType`. On the Orbit Stress Test sitch the same scene that previously read 28 MB now reads ~120 MB; gigabyte-scale pressure on heavy sitches is no longer hidden behind a broken counter.
- **GPU Memory Monitor: multi-scene + render-target accounting**: previously walked only `GlobalScene`. Now also traverses `GlobalNightSkyScene` / `GlobalDaySkyScene` / `GlobalSunSkyScene` (NightSky alone owns the 117k-star sprite atlas) and per-view render targets (anti-aliased + HDR + post-process passes), which on a 4K display can be 100+ MB per view before any tile loads. Idle reading on the orbit sitch went from 28 MB → 455 MB on the same scene state — same VRAM, accurate measurement.
- **GPU mipmap multiplier applied correctly**: previous code only counted mipmaps when `texture.mipmaps[]` was non-empty (almost never — Three.js generates mipmaps on the GPU via `generateMipmap()`, which doesn't populate the JS array). Now applies the 4/3 mipmap-chain multiplier when `generateMipmaps !== false`, matching real GPU usage.

### Bug Fixes
- **`QuadTreeMapTexture.clean()` now evicts disposed materials from `materialCache`**: previously disposed each tile's material+texture inline but left the cache entry pointing at the disposed handle. After a map-source change (e.g. user switches terrain provider), any subsequent tile re-requesting the same URL would receive a use-after-dispose material. Now routes through `removeMaterialByCacheKey` so the cache and the GL state stay synchronized.
- **`QuadTreeTile.dispose()` now evicts the cache entry**: symmetric with the regular prune path. Currently has no in-tree callers (so the bug was latent), but any future code that calls it would have leaked a cache entry per tile.

## Version 2.50.3 (2026-05-07)

### Improvements
- **Tile-material cache leak sealed**: `materialCache` now evicts the entry the moment its owning tile is pruned, instead of growing monotonically until sitch reload. The pre-fix cache was a one-way ratchet — at maxDetails ≥ 20, a 2-min orbit-pan run grew it from 261 → 1596 entries and *never* shrank. Now the same run grows to ~1274 peak and falls back to ~312 (matching active-frustum coverage) once the timeout-based pruner catches up. Three.js's `info.memory.textures` counter dropped from 1789 → 332 in the same window — i.e. the GL textures actually got released, not just the JS-side material handles.
- **Inactive-tile timeout scales with `maxDetails`**: the constant 100 s timeout no longer dominates at high subdivision depth. Each step of `maxDetails` quadruples the worst-case visible-tile count, so a 100 s leash means tile creation outpaces pruning indefinitely. New schedule: 100 s @ md=15, 76 s @ md=17, 41 s @ md=20, 17 s @ md=22, 5 s @ md=23+ (linear interpolation, clamped). At Quality preset (md=25) the prune queue drains 20× faster than before.
- **GPU Memory Monitor: works correctly + persists across sitch reload**: previously stuck at ~6 MB regardless of actual usage because it only counted textures bound to standard `material.map`/`material.normalMap` slots — terrain tiles and sky/star shaders use `ShaderMaterial` with textures in `material.uniforms[*].value`, so they were silently skipped. Now also walks shader uniforms (and arrays of them). Monitor folder + 7 controls (and the Render Debug folder + 18 controls + Sky Steps subfolder + 5 controls + Visual Profiler / Tile Stats / Force GL Context Loss buttons) now all marked `.perm()` so they survive `disposeEverything()` on every File → Load. Monitor pinned to mainView's renderer (was: whichever view constructed first — gimbal's `podsEyeViewDero` etc.) and re-attaches on every reload via new `setRenderer()`.
- **New monitor display rows + manual circuit breaker**: "Active tiles" and "Material cache" rows show live counts. New "Prune Inactive Tiles" button force-prunes every individually-aged inactive leaf across all loaded terrain maps, bypassing the normal all-4-siblings-inactive rule. Use as a relief valve when GPU memory pressure builds faster than the timeout pruner can catch up.

### Bug Fixes
- **Blank screen on sitch reload (per-view WebGL context-loss flag)**: reloading a saved sitch sometimes left every viewport black with only the 2D overlays drawing. Root cause: a single shared `Globals.contextLost` flag, mutated by every view's `webglcontextlost` listener. `CNodeView3D.dispose()` calls `forceContextLoss()` to release the dying view's GL context — by design — which fires an async `webglcontextlost` event on the disposed canvas. The (still-attached) listener latched the **shared** global flag to `true`. By the time the event landed, the new sitch was already set up; no matching `webglcontextrestored` ever fired (canvas dead), so the global flag stayed `true` and `renderCanvas()` early-exited on every view forever. Each view actually has its own canvas, renderer, and GL context — so the flag is now per-view (`this.contextLost`), matching the real per-context isolation enforced by Three.js. A disposed view's lost-event no longer poisons healthy peers.

## Version 2.50.1 (2026-05-06)

### Bug Fixes
- Fixed `lookView` rendering off-center after switching the **Performance Preset** dropdown when side-by-side mode is active. Two callsites that resize the WebGL renderer for `canvasWidth`-mode views (`deferredResizeWebGL` and the per-frame size-sync block) were computing different widths for the same canvas — the per-frame block applied the side-by-side 0.7 reduction, the debounced one didn't. After a preset change, `terrainUI.doRefresh()` triggered the debounced path, which set the renderer's internal `_width` to the larger value and updated only its own dedup state. The per-frame block then skipped its own `setSize` because its independent dedup said "no change", leaving the GL viewport extending past the canvas drawingBuffer — the centered Earth rendered into pixels outside the visible canvas region and shifted off-center. `deferredResizeWebGL` now mirrors the side-by-side reduction and keeps both dedup variables in sync.

## Version 2.50.0 (2026-05-06)

### New Features
- **Frame-rate mismatch dialog**: when a loaded video's labeled frame rate disagrees with the rate measured from KLV `UnixTimeStamp` by more than 1%, a modal now offers three candidates (recommended real-time fps from KLV UTS, PES-PTS-derived fps, current Sit.fps) with rationale. Recommended button rounds to standard rates (24 / 25 / 29.97 / 30 / …) so it reads "30 fps" instead of "29.9603 fps". Catches the "ffmpeg `-r N` without an `fps` filter" footgun and similar tactical-encoder PTS-cadence misconfigurations where the platform track silently ends partway through the video timeline.
- **WebGL context-loss recovery**: GPU-process crashes (browser tab backgrounded too long, driver hiccup, etc.) now recover gracefully instead of leaving Sitrec with a black canvas. `CNodeView3D` disposes render targets and re-applies pixel ratio + size on `webglcontextrestored`; `CNodeViewCanvas.forceContextRescale()` invalidates the 2D backing store + scale transform on every overlay view, fixing the half-size video / overlay symptom that persisted because GPU crashes silently wipe the 2D ctx scale transform without firing any standard event. Adds a Debug → Force GL Context Loss button (local-only) for deterministic recovery testing.
- **MQ9UI degrees + decimal minutes (DM) coordinate format**: the ACFT and target position rows now cycle MGRS / decimal / DMS / **DM** (DD°MM.MMM'). Three decimal places of minutes match the existing DMS sub-meter precision.

### Improvements
- **Timing Analysis report (CNodeMISBData) — anonymized**: the report is now paste-safe to share in any thread or bug tracker. Removed: generation timestamp, sitch name, MISB node id (often a tail number like `TrackData_CG2314`), `Sit.startTime`, KLV UnixTimeStamp absolute values, FileManager filenames (often encode capture date/time), and `videoFirstPESus`. All numeric-statistical signal (record counts, intervals, spans-since-stream-start, CV, gap counts, coverage, distance spans) is preserved.
- **Timing Analysis report — new diagnostics**: per-tag FIELD COVERAGE histogram with FULL / EARLY-ONLY / LATE-ONLY / GAP-MIDDLE / SPARSE / ABSENT classification; stuck-value detector for encoder GPS-loss padding (bit-identical lat/lon runs); stationary-period detector for platforms holding within 25 m for multi-second windows; sample values at quartile points + bounding-box for direct OSD-vs-rendered comparison; slow-GPS-padded-to-fast-KLV pattern detection that distinguishes real-platform velocity spikes from per-record artifacts of slow GPS padded into a fast KLV cadence; encoder PTS-cadence-mismatch detection that flags labeled fps as wrong when KLV UTS span disagrees with PES PTS span (no real hardware drifts >100 ppm).
- **Suspicious-velocity threshold raised** 50 → 500 m/s in MISB analysis. The 50 m/s threshold flagged routine aircraft motion as bogus.
- **Shared FPS-analysis helpers**: `computeMisbSpans` and `computeFpsAnalysis` now live in `MISBUtils.js` so the timing-analysis report and the frame-rate mismatch dialog use one implementation.

### Bug Fixes
- **Saved sitches now load across deployments**: a sitch saved on `www.metabunk.org` and reloaded on `local.metabunk.org` (or any other Sitrec deployment) no longer crashes during night-sky setup. The TLE-extension detector previously matched only the *current* deployment's `proxy.php` URL via full-prefix comparison; cross-deployment URLs fell through to the default file-extension parser, which read `.php` from the proxy URL and stored the bytes as a raw `ArrayBuffer`, causing `CTLEData` to assert at construction. Now matches by URL path (`/proxy.php`, `/proxyStarlink.php`).
- **TLE merge/replace dialog no longer reappears on saved sitch reload**: the saved sitch already encodes the user's chosen final state — every TLE present in the save is meant to coexist — so deserialization defaults to "merge" when no explicit action was recorded. Fixes the dialog appearing for older saves predating `tleAction` metadata, and for first-loaded TLEs that were never marked `tleMerged`.
- **Time anchor in coverage report** now correctly reads `this.misb.pesPTSus` (was checking `this.pesPTSus`, a non-existent property on the wrapper).

## Version 2.49.2 (2026-05-05)

### Bug Fixes
- Fixed camera look-direction drift on TS-sourced sitches with two derived tracks (platform + Center) when the encoder's KLV `UnixTimeStamp` clock is severely skewed against PCR. The Center track now carries the source MISB's PCR-anchored per-record timing (`pesPTSus[]`) the same way the platform track does, so both tracks use synchronous-mode (PES PTS) sync instead of the Center silently falling back to the broken `UnixTimeStamp` clock. Symptom on the file that motivated this fix: 333 s recording, platform position correct end-to-end, gimbal aim up to 33 s out of phase by end-of-run. Now both stay locked to video.

### Documentation
- `docs/dev/misb-timing.md`: expanded §1 into a four-layer "chain of clocks" diagram (PCR → PCR-relative microseconds → Sitrec timeline → wall-clock label) with new subsections for `Sit.fps`-driven timeline (§1e) and `Sit.startTime` (§1f). Added §5g pitfall documenting the derived-track `pesPTSus` forwarding contract any future `toMISB(N)` paths must honor. Renumbered the multi-PID KLV section to §5h.

## Version 2.49.1 (2026-05-05)

### Bug Fixes
- Fixed crash loading some MISB-bearing `.TS` files where the encoder used the ST 0601 "out-of-range / unknown" sentinel for corner-point tags 82–87 (Frame Center / Footprint Corners "Full"). The parser now records such tags with a `null` value and continues, instead of throwing and discarding the rest of the packet (including the checksum and any tags after 82). Sparse `null` cells in the exported CSV for those columns are normal and reflect frames where the source encoder genuinely had no footprint solution.
- Added a defensive guard in `st0601` parse so packets that bail before reaching the checksum tag (for any reason) return their partial values rather than NPE'ing on the unguarded checksum lookup.

## Version 2.49.0 (2026-05-05)

### New Features
- **Patched-video timeline (`CVideoPatchedData`)**: TS-sourced H.264 video with dropped-frame bursts is now wrapped in a virtual-frame timeline that synthesizes "held" copies of the most recent decoded frame to bridge gaps. KLV/RTC stays unaltered; the sim no longer accelerates through dropped-frame bursts (it pauses on the held image while camera position keeps advancing at honest wall-clock pace). Held frames render with a 60-px red square in the top-right corner during debugging.
- **Source Frame Number** readout in Video / Video Info Display: new VID showing the underlying decoded source frame number — diverges from the renamed "Frame Number" during held bursts when video is patched.
- **Frame patching block** in the Timing Analysis report: source/virtual frame counts, held-frame totals, longest hold, and a top-10 patches table with src(N→N+1) range, virtual range, held frames, held ms, and src gap ms (cross-references with the Video PTS Jumps table).

### Improvements
- Renamed "Frame Counter" Video Info Display item to **"Frame Number"** (en/it/ja/zh) for clarity. The displayed value is the virtual frame when video is patched.
- Manual-tracking keyframes (`CNodeTrackingOverlay`) now persist as source-indexed frame numbers (`frameSpace: "source"`), so saves are stable across patching toggles and `Sit.fps` changes; UI now prevents placing keyframes on synthesized held frames.
- Auto-tracker (`CObjectTracking.runFastTrackingLoop`) skips held frames during processing — identical pixels would yield the same template-match result; the prior tracked position is carried forward.
- Timing Analysis "Video Timing" section now reads the underlying source PTS when wrapped, so dropped-frame bursts remain visible instead of being smoothed by the wrapper's uniform virtual array. Section header changes to "(source PTS — pre-virtualization)" when patching is active.
- Tier-1 KLV pairing log tagged `[wrapped]` when patching is active.
- New developer documentation: `docs/dev/misb-timing.md` §12 covering the algorithm, wrap predicate, source/virtual contract, held-frame rule, stabilization key collapse, migration, and code map.

---

## Version 2.48.4 (2026-05-05)

### Improvements
- Backfilled WhatsNew.md changelog entries for versions 2.45.23 through 2.48.2

---

## Version 2.48.3 (2026-05-05)

### Bug Fixes
- Fixed a race condition that could fire a "Missing Managed object azSources" assert during Gimbal sitch load when the render loop ticked before legacy gimbal nodes were created

---

## Version 2.48.2 (2026-05-05)

### Improvements
- Timing analysis report wording neutralized; multi-node prelude includes per-stream gap counts and max-interval

### Bug Fixes
- Fixed spurious "Error Loading" overlay flash on substream deferral during reload
- Deferred WebXR runtime activation until "Start VR/XR" is clicked, so emulator UI no longer paints into the look view at load time

---

## Version 2.48.1 (2026-05-05)

### Improvements
- PES PTS round-trip across save/reload now closes remaining gaps
- Quieter console output; PTS sidecar files renamed to `.pts.txt`

---

## Version 2.48.0 (2026-05-04)

### New Features
- KLV-to-video sync via real PES PTS through the H.264 chunk pipeline
- Timing analysis report with PES PTS, drift decomposition, and multi-node coverage
- "Visible" checkbox on 3D object submenus
- Chatbot LLM fallback for unknown sky targets

### Improvements
- Default MISB center tracks render as an invisible 2 m sphere
- Right-click picking now skips render-hidden and camera-locked objects
- Render loop pauses when paused AND the window is unfocused (still kept alive for MCP-driven sessions)
- CNodeSmoothedPositionTrack self-heals when its source grows
- TS substreams and PES timing sidecars persist across save/reload; parent TS bytes are no longer retained
- Suppressed noisy log for ESRI placeholder tiles
- Expanded Biome rules; 17 latent bugs flagged by the new checks were fixed

### Bug Fixes
- Chatbot duplicate-call loop guard

---

## Version 2.47.4 (2026-05-03)

### New Features
- Performance Tweaks folder with `videoMaxSize` preset and a "Balanced" default

---

## Version 2.47.3 (2026-05-02)

### Bug Fixes
- Fixed node-smoke test breakage in MatLines `getEffectiveMSAASamples` calls

---

## Version 2.47.2 (2026-05-02)

### Bug Fixes
- Fixed Line2 gaps at low renderScale via correct resolution and alphaToCoverage
- Fixed lookView mis-sized render at low renderScale

---

## Version 2.47.1 (2026-05-02)

### New Features
- Performance preset settings: `renderScale` and `msaaSamples`

### Improvements
- README now links previously-unlisted user and technical docs

---

## Version 2.47.0 (2026-05-02)

### New Features
- Framework for custom wind sources
- MISB ST 0604 PES-PTS sync for TS-sourced KLV

### Improvements
- Tolerates per-group decode failure when other groups loaded
- Prevented lil-gui menu names and titles from wrapping
- Added `docs/dev/misb-timing.md` technical reference

---

## Version 2.46.1 (2026-05-01)

### Improvements
- File-type detection now sniffs contents, not just the extension

---

## Version 2.46.0 (2026-05-01)

### New Features
- Tile edges debug overlay in the Terrain UI

### Improvements
- Tile LOD replaced with frustum-dilated screen-space error
- Tile subdivision: bounding sphere shifts to actual terrain altitude
- Tile subdivision: merge hysteresis prevents tracking flicker
- ESRI placeholder tiles are detected; refresh / detail-slider gating fixed
- Server-side settings allowlist now includes `language`

### Bug Fixes
- Fixed shader compile error breaking 3D buildings on untextured tiles

---

## Version 2.45.29 (2026-05-01)

### New Features
- Progress indicator for large dropped files and TS parsing

### Improvements
- `sitrec.sh` now always re-pins to `:latest` first when pulling

---

## Version 2.45.28 (2026-05-01)

### Improvements
- MISB tracks cache per-frame elevation and persist it across saves
- Coalesced MISB AGL terrain-refresh cascades for fewer redundant recomputes
- Reduced per-frame work in lil-gui and terrain tile builders
- Sun and moon positions now update only per-viewer

### Bug Fixes
- Fixed AGL-locked MISB tracks frozen at stale terrain altitude

---

## Version 2.45.27 (2026-04-30)

### Bug Fixes
- Fixed graph canvas blanking on panel resize

---

## Version 2.45.26 (2026-04-30)

### Improvements
- Contrails now sample the wind field at altitude
- Track-derived wind sources fetch the wind field

### Bug Fixes
- Fixed wind grid filled with stale defaults during sitch deserialize
- Fixed wind lines/arrows not appearing after load on manual sitches

---

## Version 2.45.25 (2026-04-29)

### Improvements
- Help menu now links Wind, Traverse, and Gimbal documentation
- Deprecated LocalCustomSitches

---

## Version 2.45.24 (2026-04-29)

### Improvements
- Documented versions 2.45.14 through 2.45.22 in WhatsNew.md

---

## Version 2.45.23 (2026-04-29)

### Improvements
- Internal documentation and regression-test stability improvements (loadAsset multi-entry parser docs; NITF test per-worker port)

---

## Version 2.45.22 (2026-04-29)

### Bug Fixes
- Fixed timeline scrub judder by re-running node updates when the frame changes between logic ticks

---

## Version 2.45.21 (2026-04-28)

### Improvements
- Video export now applies the playback-speed setting; encoder is loaded via dynamic import

---

## Version 2.45.20 (2026-04-28)

### New Features
- **Playback Speed slider** in the Time menu (0.25× to 10×)

---

## Version 2.45.19 (2026-04-27)

### New Features
- **Wind inspect tool**: shift/alt-click for multi-point readouts anchored to Camera or Target, with altitude lock, auto-flipping tooltip, and ground stalks
- **Independent Target/Local wind sources** with a Separate Wind Sources toggle, plus a new MISB track-derived option
- **Screen-grid wind arrows** and **sonde altitude arrows** for visualizing vertical wind structure
- Reusable promptForChoice dialog (used by sounding-source selection)

### Improvements
- Wind/Gimbal Analysis GUI reorganized
- Sounding import defaults to the closest 00Z/12Z observation (rolls date if needed); dialog defaults to sitch start time
- Sounding import auto-switches source to "Manual Soundings" on success
- UWYO sounding fetch walks to the next-nearest station on failure, with a tighter year filter
- Wind refresh button drops every cache; reload concurrency capped at 3 to avoid stampeding the wind proxy
- Wind streamlines rebuild when time-scrub drifts past the nearby-data bbox
- Show Wind Lines toggle decoupled from group visibility
- WebGL programs now pinned to prevent per-tile shader recompile thrash
- Cut per-frame allocations in screen-grid and inspect hot paths; skip per-frame grid rebuilds when nothing changed

### Bug Fixes
- Fixed three wind save/restore drift bugs after the `par` refactor
- Fixed wind inspect readout positioning in client coords (sidebar offset)
- Fixed manual wind grid not refreshing when Target/Local Wind From/Knots change
- Sounding-source dialog label now reflects the actual sort anchor

### Documentation
- New user and technical wind docs (with images), including how IDW interpolation works and which sources use it

---

## Version 2.45.18 (2026-04-25)

### New Features
- **Wind**: nearby-only sounding filter, persistent per-level cache, live altitude drag, sonde arrows

### Improvements
- `sitrec.sh` probes and prints the live version after start/restart/pull/switch

---

## Version 2.45.16 (2026-04-25)

### Bug Fixes
- Graphs: stopped full-repaint every frame; fixed munge cache when frame count changes mid-session

---

## Version 2.45.15 (2026-04-25)

### Improvements
- Wind Data panel state persists across save/reload; altitude commits on finish
- Physics GUI: Wind/Gimbal folder shells created once instead of per-sitch
- CoordinateParser now requires an explicit separator between lat/lon pairs

### Bug Fixes
- Local-folder file loads now key by id, matching the URL-fetch path so wind grids restore correctly
- J2K tile decode worker derives its WASM URL from `self.location` instead of the init message

---

## Version 2.45.14 (2026-04-24)

### New Features
- **Multi-source wind field**: choose UWYO, IGRA2, Manual Soundings, open-meteo, or uniform
- **Manual sounding import** with target anchors, 3-nearest IDW interpolation, retry until good data, and differentiated errors when all samples are rejected
- **Coverage-aware fade** for sparse-sample wind sources
- **OSD Graph**: raw keyframe overlay with draggable frame-line
- **Export Motion CSV** menu item
- **Gimbal Analysis** pipeline now available to custom sitches via a Physics > Gimbal Analysis menu
- **SA Page**: scroll-wheel SCL zoom, compass rose, auto-add track HAFUs, and a Show/Hide > Views toggle
- **Individual feature toggles** for SA Page, ATFLIR Pod, and Gimbal Preset
- **BYOK (Bring Your Own Key)** foundation with direct Anthropic LLM client

### Improvements
- Wind sources consolidated; Weather Balloons folder folded into Wind Data
- Removed [BETA] Fetch <name> Wind buttons (superseded by the Wind Data folder)
- Wind Show toggle retries failed loads
- Non-GFS wind sources properly reload after deserialize; GFS fetch now has a timeout
- Wind field correctness: renderAltitude floor, propagation status, dedupe
- Per-sandbox MCP isolation via paired origins
- Sitrec uploads, cache, and videos preserved across docker rebuilds

### Bug Fixes
- Fixed fullscreen aspect-ratio stretch for views with negative width/height
- DDI buttons: MQ9UI-style click detection, square fullscreen aspect
- SA Page: button serialization, dashed-circle flicker, crash from missing wind/CMetaTrack.trackNode
- Enable Gimbal Analysis: fixed camera/jet location mismatch, contaminated Sit serialization, and duplicate-node errors from base custom sitches
- Guard video view references in `initViews` for sitches without video
- SitrecBridge: stale-socket close-handler bugs, `.mcp.json` portability, MV3 worker-reload stale-socket detection

### Documentation
- Document production server requirements for the wind proxy

---

## Version 2.45.12 (2026-04-16)

### New Features
- **MPEG-TS auto-extraction**: Files containing MPEG Transport Streams (even when named `.mpg`) now auto-extract their H.264 video stream via the existing TSParser instead of hanging the MP4 loader

### Improvements
- Video load diagnostics: replaced per-frame "Pending actions" log spam with a throttled `[Pending]` status line that shows which video is stuck and at which stage
- Unsupported video containers (MPEG-PS, AVI, MKV, WebM, FLV, Ogg) now fail fast with a single clear error and an `ffmpeg` conversion hint

### Bug Fixes
- Fixed silent video load hangs where a file's extension didn't match its actual container (e.g., `.mpg` holding MPEG-TS fed to MP4Box)
- Added a 2-minute safety-net watchdog on MP4 `getConfig()` so corrupt/truncated ISO-BMFF no longer pins the pending-actions counter indefinitely

---

## Version 2.45.11 (2026-04-16)

### New Features
- **Camera + Auto Track LOS source**: new line-of-sight option combining camera position with the auto-tracked target point

### Improvements
- Renamed Physics > Wind subfolder to "Wind Data" for clarity

### Bug Fixes
- Fixed Camera + Auto Track LOS so the traverse and LOS pipelines work together correctly

---

## Version 2.45.10 (2026-04-15)

### Improvements
- OSD graph now draws a full crosshair spanning the full graph
- Smoothed OSD latitude/longitude tracks

---

## Version 2.45.9 (2026-04-15)

### Bug Fixes
- Fixed OSD graph for coordinate-format data series (e.g. `N 032 54.87`)

---

## Version 2.45.8 (2026-04-15)

### Improvements
- Use a pre-built Playwright Docker image for smoke tests (faster CI runs)
- Bumped `follow-redirects` dependency to 1.16.0

---

## Version 2.45.7 (2026-04-15)

### Bug Fixes
- Fixed OSD data series visibility and minimum box sizing

---

## Version 2.45.6 (2026-04-15)

### Improvements
- Suppress the browser context menu on non-text elements

### Bug Fixes
- Fixed celestial object occlusion
- Fixed KML polygon altitude race condition with async terrain mesh updates

---

## Version 2.45.5 (2026-04-14)

### New Features
- **Celestial Lock System**: lock the camera to celestial objects with improved pointing behaviour
- **Selectable Flare Model**: choose the model used for satellite normal direction, affecting flare calculations
- Additional language translations

### Improvements
- Satellites now fade during daytime based on sky brightness attenuation
- Wider range on X and Y offsets for the KM sitch
- Preserve `sitrec-upload` and `sitrec-cache` volumes across Docker builds
- MCP bridge auto force-retries after three failed connection attempts
- Further MCP robustification

### Bug Fixes
- Fixed double URL-encoding of spaces in custom sitch share links

---

## Version 2.45.4 (2026-04-13)

### Bug Fixes
- Fixed Docker build failing when target directories already existed (now uses `mkdir -p`)

---

## Version 2.45.3 (2026-04-13)

### Bug Fixes
- Fixed Docker production build (npm upgrade + missing `scripts/` directory)

---

## Version 2.45.2 (2026-04-13)

### Improvements
- Added Python3 + eccodes to Docker images so wind-data fetching works in containers

### Bug Fixes
- Fixed wind proxy for local (non-Docker) development

---

## Version 2.45.1 (2026-04-13)

### New Features
- **Planet-Only Labels**: New "Only Label Planets" checkbox to hide star labels while keeping planet labels visible
- **Dusk/Dawn Label Fading**: Star and planet labels now fade out at dusk and dawn for a cleaner sky view

### Improvements
- Allow arbitrary wind altitudes with interpolated values between levels
- Performance: cache preRender/postRender node lists in CNodeManager instead of rebuilding each frame
- Performance: skip terrain subdivision when cameras are stationary
- Performance: reuse per-frame allocations in NightSky update
- Robustified regression tests for reliability under heavy machine load

### Bug Fixes
- Fixed TLE status font size

---

## Version 2.45.0 (2026-04-12)

### New Features
- **Wind Field Visualization**: GFS weather data integration with animated streamline rendering

### Improvements
- Wind LOD improvements for better rendering at different zoom levels
- Wind serialization support for saving/loading wind configurations
- MCP tweaks for Docker sandbox compatibility
- Allow Escape key to cancel version selection in sitrec.sh installer
- Reduce semver retention in GHCR cleanup from 30 to 20 versions
- Expand GHCR cleanup to also prune build-* tags and old semver versions

### Bug Fixes
- Fixed celestial sphere appearing squished when Match Video Aspect is active

---

## Version 2.44.8 (2026-04-11)

### Improvements
- Override description in annotations input, not just labels
- Add manifest annotations so GHCR shows descriptions for each Docker image version

### Bug Fixes
- Fixed sitrec.sh versions list truncating newest releases

---

## Version 2.44.7 (2026-04-11)

### Bug Fixes
- Fixed lookView label drift when video is panned or zoomed

---

## Version 2.44.6 (2026-04-10)

### Bug Fixes
- Fixed lookView pan alternation by skipping fixUp for PTZ cameras

---

## Version 2.44.5 (2026-04-10)

### New Features
- **Tracking Cursor Extrapolation**: Tracking cursor now extrapolates past keyframes with a configurable "Show N Keyframes" setting
- **Experimental Flight Viewer**: New tool for viewing flight data
- MCP bridge extended to tools

### Improvements
- Add test-viewer menu control sweep regression test and fix sweep-discovered UI bugs
- More robust MCP bridge connection handling
- Scope bitstream keyframe detection to H.264 only

### Bug Fixes
- Fixed satellite track not appearing in the UI after loading a sitch
- Fixed MCP bridge routing eval calls to non-Sitrec metabunk tabs
- Fixed double stabilization when exporting stabilized videos

---

## Version 2.44.4 (2026-04-09)

### Bug Fixes
- Fixed VLC-exported MP4 video decode failures and chunk duplication

---

## Version 2.44.3 (2026-04-08)

### Improvements
- Avoid re-reading local files that have already been read or written, making re-saving locally much faster
- Tracking point click radius now based on screen pixels instead of video pixels for consistent interaction
- Smaller click radius for dragging track points to better distinguish them from the main tracking region

---

## Version 2.44.2 (2026-04-08)

### Improvements
- Optional larger file upload limits for admin users

---

## Version 2.44.1 (2026-04-08)

### Improvements
- Comprehensive i18n translations across the entire UI including menus, settings, node labels, tooltips, and data-driven label lookups

### Bug Fixes
- Fixed serialization issues when saving in a different language than the one loaded
- Fixed nodeLabels keys not matching actual node IDs
- Fixed settings menu disappearing after sitch change

---

## Version 2.44.0 (2026-04-08)

### New Features
- **Internationalization (i18n)**: Full translation support with English, French, and Spanish translations using i18next
- **Flare Horizon Check**: Flares detected through the ground are now filtered using ellipsoid horizon checking

### Improvements
- Setting menu now remains active in the startup sitch browser

### Bug Fixes
- Fixed missing conversion path for high bit-depth tiled JPEG 2000 images

---

## Version 2.43.1 (2026-04-08)

### Improvements
- Added notes API methods and updated documentation

### Bug Fixes
- Fixed sitch API issues from PR #53: restored getSitchState, guarded built-in loads, prevented dialog triggers

---

## Version 2.43.0 (2026-04-08)

### New Features
- **Camera Orbit Track**: Orbit track visualization for camera position

### Improvements
- Performance: lazy track recalculation for large-frame sitches
- Performance: cache munge values, skip unnecessary graph redraws and node recalculations
- Show edges only on OSM buildings (cleaner rendering)
- Skip spline recalculation on terrain change unless tracks are AGL

### Bug Fixes
- Fixed crash when fixedCameraPosition node does not exist
- Fixed MCP server launch: run.sh referenced non-existent mcp-server.mjs

---

## Version 2.42.1 (2026-04-07)

### Improvements
- Lazy-compute LOS fitting nodes: skip recalculation when the fitting method is not selected

---

## Version 2.42.0 (2026-04-07)

### New Features
- **Physics-Based Trajectory Fitting**: Trajectory fitting using Nelder-Mead optimizer for physics-based motion models
- **LOS Fitting Algorithms**: Added global LOS fitting methods — Constant Velocity, Constant Acceleration, Kalman filter, and Monte Carlo least-squares alongside the original RANSAC method

### Improvements
- Suppressed system context menu when right-clicking on sliders to set range

---

## Version 2.41.3 (2026-04-07)

### Bug Fixes
- Fixed crash loading MP4 files whose first sample is not a key frame

---

## Version 2.41.2 (2026-04-06)

### Improvements
- Only tag Docker image as 'latest' when it is the newest version

---

## Version 2.41.1 (2026-04-06)

### Improvements
- **Stable Track IDs**: Track IDs now persist across save/load even when the underlying file parser changes (e.g. NITF vs MISB CSV), preventing broken references in saved custom sitches
- **Deferred Switch Selection**: Switch nodes gracefully handle options that aren't registered yet during deserialization, applying the saved choice once the option becomes available

### Bug Fixes
- Fixed double-loading error when using single images as video sources
- Fixed legacy saved sitches failing to load due to the `angelsSwitch` typo rename (now `anglesSwitch` with automatic migration)

---

## Version 2.41.0 (2026-04-06)

### New Features
- **Satellite Camera Mode**: Gimbal-lock-free nadir camera control for satellite viewing
- **Wireframe Building Edges**: Shader-based wireframe edge rendering for OSM 3D building tiles

### Improvements
- Improved satellite look-camera mode with smoother controls
- Manual PTZ values now sync from the active camera controller
- Suppressed native context menu on sitch browser items

---

## Version 2.40.12 (2026-04-03)

### Improvements
- Bumped Electron to 39.8.4 for video-viewer desktop app
- Removed npm self-upgrade step from Docker CI workflow

---

## Version 2.40.10 (2026-04-03)

### Improvements
- **Native Context Menu on DOM Elements**: Right-clicking on Notes, debug log, chatbot, lil-gui inputs, and context menu text now shows the browser's native context menu with copy/paste support
- **Selectable Celestial Info**: Satellite and star context menu info (NORAD number, name, RA/DEC) is now selectable and copyable
- **Ctrl+C/X/A on Mac**: Ctrl+C, Ctrl+X, and Ctrl+A now work as copy/cut/select-all (same as Cmd), including for users with swapped Ctrl/Cmd keys
- **Video-Only Sitches**: Save and load video-only sitches (from SitVideo)

### Bug Fixes
- Fixed context menu showing satellites behind the Earth or far from the cursor; now uses screen-pixel distance (15px threshold) matching star/planet picking
- Fixed Ctrl/Cmd+letter combos (e.g. Cmd+C) triggering camera/game-style keyboard shortcuts
- Fixed right-clicking on lil-gui slider values starting an unintended drag when the context menu is dismissed
- Fixed right-click on GUI tab/menu titles showing the browser context menu instead of acting like a regular click
- Fixed "Zoom (fov)" display jumping to a wrong value when dragging altitude with the FOV Editor active
- Fixed extra pending actions in the video load pipeline
- Fixed sitrec.sh version detection when pinned to latest

---

## Version 2.40.9 (2026-04-01)

### Improvements
- **Curve Editor**: Margin drag, FOV sentinel value support, improved show() defaults, menu pointer fix
- **Resize Handles**: Positioned on panel edges (macOS-style) to avoid scrollbar overlap

### Bug Fixes
- Fixed curve editor yMax clamping output; added frame snap and disabled out-of-range points

---

## Version 2.40.8 (2026-04-01)

### Bug Fixes
- Fixed curve editor OOM crash when window is very small
- Fixed floating/sidebar menus not hiding when sitch browser is open
- Consolidated panel event/drag handling with blockViewEvents() utility

---

## Version 2.40.7 (2026-03-31)

### New Features
- **Image Import with EXIF Support**: Import images directly with automatic EXIF metadata extraction (camera position, orientation, FOV)
- **Stabilize Centers**: New option for auto tracking stabilization

### Improvements
- EXIF info panel no longer passes mouse/wheel events through to 3D views
- Consolidated EXIF metadata application into loadedCallback
- Serialized yMax in FOV editor (vertical range)

### Bug Fixes
- Fixed "Show Video Info" master toggle not hiding video info overlay
- Fixed auto tracking serialization round-trip
- Fixed Moon position using exact same angles across different code paths

---

## Version 2.40.6 (2026-03-31)

### Improvements
- **SitrecBridge Security Hardening**: Narrowed permissions, added nonce authentication, stronger detection
- Wrapped render-path camera state restoration in try/finally for robustness

---

## Version 2.40.5 (2026-03-30)

### New Features
- **Video Pan & Zoom**: Pan and zoom in the video view with automatic lookView synchronization
- **Video Adjustments Context Menu**: Right-click on video for quick access to adjustments
- **Auto-Stretch 16-bit NITF Images**: Mono NITF images that underuse their bit range are automatically stretched

### Improvements
- Cached convolution filter results when image and parameters are unchanged
- Used effective FOV and pan for terrain tile LOD evaluation
- Raised default Max G to 10 for track loading/filtering

### Bug Fixes
- Fixed pixel-match zoom: split FOV zoom and pixel shader cleanly
- Fixed lookView pan sync for pillarbox/letterbox aspect ratios
- Fixed LOD camera prep to save/restore aspect and apply matchVideoAspect

---

## Version 2.40.4 (2026-03-30)

### New Features
- **Video Pan & Zoom**: Added pan and zoom to video view with lookView sync

---

## Version 2.40.3 (2026-03-29)

### Improvements
- NITF resize dialog now shown before tile decode instead of after

---

## Version 2.40.1 (2026-03-29)

### New Features
- **HeightMap Flood Simulation**: Grid-based shallow water simulation on terrain heightmaps with Manning friction, velocity advection, and CFL stability
- **Free Terrain Map Sources**: Added fetch-based tile loader with additional free terrain map services

### Improvements
- MCP server: robust stale server detection and auto-kill on startup

### Bug Fixes
- Fixed USGS 3DEP elevation: concurrency limiting, caching, and tile alignment
- Fixed numerical instability in flood simulation: velocity clamping, diffusion, advection blend

---

## Version 2.40.0 (2026-03-29)

### New Features
- **TLE Merge/Replace on Import**: When importing TLE files with data already loaded, a dialog offers Merge, Merge All (sticky for batch), or Replace, with a detailed assessment of how the new data relates to the existing set and simulation date
- **TLE Filter Dialog**: Modeless draggable panel for filtering satellites by spatial criteria (above/below camera, altitude range, view frustum, centerline angle, Earth occlusion), name (wildcard or regex), and orbital parameters (eccentricity, inclination, period, speed)
- **TLE Filter "Any Frame in Range"**: Precalculates per-satellite visibility across the sitch time range — satellites pass if visible at any sample frame. Results stored as on/off/changeable for O(1) per-frame lookup during playback
- **TLE Filter "Not Hidden by Earth"**: On by default — filters out satellites occluded by the Earth using ray-sphere intersection from the observer position
- **Export Resources Menu**: File > Export > Resources submenu allows downloading raw data for any loaded file
- **Multi-Track Selection Dialog**: When importing files with 3+ tracks, shows a selection dialog with preview info. Selections are saved in custom sitch serialization
- **Track Filter Panel**: Modeless draggable panel with live preview for filtering loaded tracks by altitude, frustum, and direction (towards/away from camera)
- **Inter-Agent Communication**: New sitrec-comms MCP server for message passing between parallel AI agents
- **Full-Tab Screenshot**: `view='page'` option for `sitrec_screenshot` captures the entire browser tab including DOM overlays, dialogs, and GUI panels

### Improvements
- **Co-Located Satellite Hiding**: When the camera follows a satellite track (e.g. ISS), docked objects within 500m are hidden in the look view (dots and labels) but remain visible in the main 3D overview
- **Live TLE Filter Updates**: Spatial filters auto-update at 5Hz when the camera position, orientation, FOV, or frame changes
- **NITF Rehosting as Converted Products**: NITF files are rehosted as MISB CSV + JPEG instead of the original binary, with optional image resize for large files
- **Tiled JPEG 2000 Decoding**: Large NITF images with tiled J2K compression are decoded in parallel via Web Worker pool with progress indicator
- **NSIF Format Support**: Added support for NATO Secondary Imagery Format files and UTM/MGRS coordinate parsing in NITF headers
- **TypeScript Migration**: Converted `LLA-ECEF-ENU.js` and `TLEUtils.js` to TypeScript with full type annotations; added esbuild-loader for TS compilation; removed `.js` extensions from all relative imports
- **Model Filename Delimiter**: Changed `#L...#` to `~L...~` for in-filename parameters (avoids URL fragment issues); legacy `#` delimiter still supported for backward compatibility
- **MCP Reliability**: Protocol version handshake, orphan process detection, graceful shutdown, stale extension probe, auto-match sessions to tabs by build directory
- **Test Infrastructure**: Node registration tests, drift checks for code-that-must-stay-in-sync, synthetic NITF/J2K tests, NSIF regression tests
- Track filter towards/away camera fix: first and last ECEF samples always included
- Fixed NLU "jet" alias resolution
- Removed unused esbuild-jest dependency (fixed braces vulnerability)
- Bumped path-to-regexp 8.3.0→8.4.0, aws-sdk-php 3.368.0→3.371.4

### Bug Fixes
- Fixed TLE batch replace: first file replaces, remaining files merge instead of chain-replacing each other
- Fixed stale `tleFilterResults` after TLE merge hiding newly added satellites
- Fixed `_tleMergeAll` sticky flag leaking across import methods (drag-drop vs File > Import)
- Fixed TLE "Above/Below Camera" filter using viewport camera altitude instead of observer (lookCamera) altitude
- Fixed TLE and NITF dialogs permanently bypassed when MCP extension is connected
- Fixed ReDoS risk in TLE name regex filter: pre-compiled outside loop with probe guard
- Fixed legacy `#`-delimited model filenames silently losing length parameter after delimiter change
- Fixed balloon sphere pressure scaling to use interpolated track position
- Fixed ICORDS 'N' offset bug causing wrong IC values in NITF parser
- Fixed extension reconnect after page reload and stale connection detection

---

## Version 2.39.3 (2026-03-26)

### New Features
- **Sonde Trajectory Comparison**: New `compareSondeTrajectory` API compares wind-reconstructed trajectories against GPS ground truth from the same balloon flight, with per-level horizontal error metrics
- **UWYO GPS CSV Support**: Proxy now uses the UWYO WSGI endpoint to fetch per-second GPS radiosonde data for recent soundings (2018+)

### Improvements
- Sonde import shows progress dialog at each stage with cancel button
- UWYO rate limit (HTTP 429) triggers a 66-second cooldown with live countdown timer and automatic retry
- Station coordinates refined from IGRA2 database (4-decimal precision, ~35m accuracy) instead of truncated UWYO LIST HTML values (~2 km error)
- Station picker and auto-import use lookCamera position for proximity sorting
- Decommissioned stations filtered out based on sim start time year
- IGRA2 fetch falls back to previous year's y2d file when current year's doesn't exist
- IGRA2 format detection allows preceding metadata lines; UWYO LIST detection accepts flexible whitespace
- Escape HTML in sounding picker dialog to prevent DOM XSS

### Bug Fixes
- Fixed "Sync Time To" only recalculating the synced track instead of all tracks connected to the datetime node
- Fixed SitrecBridge URL validation to use exact hostname matching

---

## Version 2.39.2 (2026-03-26)

### Improvements
- Run Playwright tests on version tags in CI
- Replace hardcoded absolute paths in test files with `path.resolve(__dirname)`

---

## Version 2.39.1 (2026-03-26)

### Bug Fixes
- Fixed Docker CI build: use flat dist/ output instead of branch-based subdirectory

---

## Version 2.39.0 (2026-03-26)

### New Features
- **Weather Balloon / Radiosonde Support**: Import, reconstruct, and display radiosonde (weather balloon) trajectories from UWYO and IGRA2 (NOAA NCEI) data sources
- **Station Picker**: Searchable station picker dialog sorted by proximity to camera position
- **IGRA2 Direct Fetch**: Download and decompress IGRA2 sounding archives directly from NOAA NCEI
- **Atmospheric Profile Node**: Altitude/pressure-interpolated temperature, humidity, and wind data from imported soundings
- **Weather Balloons Menu**: Physics menu with auto-import of nearest station and API access
- **Temperature-Gradient Coloring**: Sonde tracks colored by temperature gradient instead of constant white
- **Wind Arrow Display**: Wind direction and magnitude arrows along sonde tracks
- **Balloon Sphere Display**: Pressure-scaled balloon sphere that expands with altitude following ideal gas law

---

## Version 2.38.0 (2026-03-25)

### New Features
- **NITF Image Support**: Import NITF/NITF 2.0 images with JPEG, JPEG 2000, and blocked image decoding, sensor metadata extraction, and georeferencing
- **JPEG 2000 Support**: Decode JP2/J2K/JPX files via OpenJPEG WebAssembly, including >8-bit monochrome, sYCC color space, and ICC TRC curves
- **Multi-Tab MCP Support**: SitrecBridge can target specific Sitrec instances by URL or tab ID

### Improvements
- FOV corrections and "Match Video Aspect" pillarbox fix
- Improved MCP screenshots and view captures
- SitrecBridge popup shows current window's Sitrec tab

### Bug Fixes
- Fixed NITF 2.0 datetime parsing, ICORDS='N' subheader misalignment, and >8-bit mono images too dark
- Fixed LUT-based NITF images showing as grayscale instead of color
- Fixed JP2 drag-drop, component map handling, and JP2 inside NITF containers
- Fixed `versions` command showing remote latest instead of actual installed version

---

## Version 2.37.3 (2026-03-24)

### Improvements
- More robust H.264 decoder: recovers from errors, better error reporting
- More robust handling of canvas dimensions to avoid async startup issues
- Basic NITF support (initial implementation)
- Expanded MCP/AI-facing API for deeper access to Sitrec client internals
- Added "Visible" checkbox to synth 3D objects
- Suppress blocking dialogs when MCP debugging

### Bug Fixes
- Fixed multi-slice H.264 decode failure
- Show clear error for MPEG-2 video in TS files

---

## Version 2.37.2 (2026-03-24)

### Improvements
- Updated tooltips for all menu items that were missing them
- Move debug buttons to Debug menu, add Server/Local folder toggle
- Replace grey sphere with polar caps for Mercator tile gaps
- Custom map and elevation configurable via .env
- Adjusted attribution position when banners shown
- Docker: bundled installer files in image, improved offline install with automatic image detection

### Bug Fixes
- Fixed SELinux :Z detection to avoid false positives
- Fixed `versions` command to correctly resolve 'latest' tag

---

## Version 2.37.1 (2026-03-23)

### New Features
- **Flood Sim**: Experimental flood simulation
- **sitrec.sh Management Script**: Unified Docker/Podman management with `start`, `update`, `versions`, and `--offline` commands
- **SitrecBridge Launcher Scripts**: Claude Desktop compatibility

### Improvements
- Podman compatibility for Docker install
- SitrecBridge: show MCP command activity in popup, document time system

---

## Version 2.37.0 (2026-03-22)

### New Features
- **SitrecBridge MCP Server**: AI assistants (Claude Code, Claude Desktop) can now control Sitrec in real-time via the SitrecBridge MCP server and Chrome extension — navigate, take screenshots, inspect nodes, and call API functions
- **SitrecBridge Distribution Build**: Zero-dependency distributable zip for end users (no `npm install` needed), with a download link in the Help menu
- **Screenshot Quality Control**: MCP screenshots now support JPEG quality (1–100) and `maxWidth` downscale parameter for smaller payloads on high-DPI displays
- **Full Window Screenshots**: Capture the entire browser tab including HTML overlays (time display, UI labels), not just the WebGL canvas
- **Attribution Overlay**: Map tile providers now display proper attribution overlays
- **ThirdPartyNotices.txt**: Auto-generated third-party license notices included in builds

### Improvements
- Chatbot API: add `toggleFullscreen`, fix LLM parameter type fragility
- Enable chatbot in older sitches
- MCP server binds to localhost only, avoiding macOS firewall prompts
- Multi-browser MCP support with automatic primary/secondary promotion
- MCP server handles browser debugger asserts for round-trip debugging
- Update GitHub Actions to Node.js 24-compatible versions
- Added smoke test to Docker build
- Fall back to `npm install` when `npm ci` fails on lock file sync issues

### Bug Fixes
- Fixed grey sphere visibility check for 3D building tiles
- Fixed zero-size WebGL render targets causing errors during initialization
- Fixed messy time display on legacy sitches
- Fixed custom sitches never reaching data-ready="complete"
- Fixed spline editor handles too small in legacy sitches (e.g. Agua)
- Fixed potential incomplete multi-character sanitization (CodeQL alert)

---

## Version 2.36.8 (2026-03-20)

### Improvements
- Fallback to NASA Blue Marble minimal basemap when internet tile services are unavailable
- Docker: install mbstring and iconv, allow override of user ID and user groups, fallback checksum when crypto.subtle unavailable
- Pin npm@11 in CI workflows to fix `npm ci` lock file mismatch

---

## Version 2.36.7 (2026-03-20)

### New Features
- **Service Availability Checks**: Tile services are tested for availability before use

### Improvements
- Use server file storage if S3 is disabled
- Add shared.env.example download to Docker install scripts
- Add explicit permissions to GitHub Actions workflow jobs
- Added nightsky permalink regression test for legacy URL format

### Bug Fixes
- Fixed banking calculations in degenerate cases and when Sim Speed is not 1
- Fixed old nightsky permalink URLs broken by EUS→ECEF migration
- Fixed 15 obscure bugs found during full codebase review
- Fixed fullscreen race condition causing black views on custom sitch load
- Fixed issues when toggling 3D buildings on with legacy terrain 9x9 grid
- Fixed CodeQL alerts: HTML stripping, hostname matching, URL sanitization, DOM text XSS, rate limiting

---

## Version 2.36.6 (2026-03-19)

### Bug Fixes
- Fixed missing map sources from recent .env changes
- Docker fixes

---

## Version 2.36.5 (2026-03-19)

### Bug Fixes
- Fixed Ubuntu version on ARM Docker build

---

## Version 2.36.4 (2026-03-19)

### Bug Fixes
- Fixed Docker image lowercase naming issue

---

## Version 2.36.3 (2026-03-19)

### Improvements
- Standardize Docker port to 8080, improve install docs, add video download scripts
- Restructure install docs with Zero-Config Docker Image as primary method
- Add PowerShell install script for Windows deployment
- Add one-liner install script for Docker deployment

### Bug Fixes
- Fixed relative paths in CI

---

## Version 2.36.2 (2026-03-18)

### Bug Fixes
- Use relative `./dist` paths in config-install.js.example

---

## Version 2.36.1 (2026-03-18)

### Improvements
- Suppress Apache ServerName warning in Docker containers
- Split Docker CI into build-js + native ARM packaging
- Skip CI workflow on tag pushes

---

## Version 2.36.0 (2026-03-18)

### Improvements
- Migrate all runtime env vars to `getEnv()` for Docker override support
- Add `env_file` support to docker-compose.yml
- Add GitHub Actions workflow for multi-arch Docker image publishing
- Standardize placeholder tokens as EXAMPLEKEY
- Hide map/elevation sources when their API token is missing

### Bug Fixes
- Fixed premature star visibility during twilight

### Security
- Bump minimatch, serialize-javascript, terser-webpack-plugin, copy-webpack-plugin, tar

---

## Version 2.35.0 (2026-03-18)

### New Features
- **Electron Desktop App**: Build and run Sitrec as an offline Electron desktop application with local filesystem support and native file dialogs
- **Color Space Management Overhaul**: Comprehensive fix to the render pipeline color space — proper sRGB tagging, linear output for custom shaders, and correct color management across terrain, globe, clouds, splats, 3D objects, tracks, and effects

### Improvements
- Document title now shows the current sitch name
- Isolated serverless runtime config for cleaner builds

### Bug Fixes
- Fixed "World Down" gradient texture direction
- Fixed gradient texture loss of accuracy from EUS→ECEF transition (now uses local dot product across triangles)
- Removed unnecessary manual gamma correction from Google 3D Tiles
- Fixed elevation caching causing tracks to get stuck
- Fixed cached AGL track altitude lock
- Removed bounding box arrows in look view

---

## Version 2.34.7 (2026-03-16)

### Improvements
- Proper Gaussian splat rendering for PLY files with improved stability
- Updated custom model documentation

### Bug Fixes
- Fixed Gaussian splat PLY bounding box and scale

---

## Version 2.34.6 (2026-03-16)

### New Features
- **Shahed Drone Model**: Added Shahed drone as a built-in 3D model
- **VR Sky Rendering**: Sky now renders correctly in VR mode

### Bug Fixes
- Fixed units label not updating correctly on deserialization

---

## Version 2.34.5 (2026-03-16)

### Bug Fixes
- Fixed model extension detection for legacy sitches using "TargetObjectFile"

---

## Version 2.34.4 (2026-03-16)

### New Features
- **PLY File Support**: Basic PLY file loading and Gaussian splat rendering for PLY files

### Improvements
- Model length now uses units (m/ft) with mirror GUI updates when units change
- Simplified model length setting to always assume Z axis
- Support passing length in filename
- DAG view improvements: invisible nodes (or those with no visible descendants) shown in red
- Reduced range of traverse start distance from 300 to 30

### Bug Fixes
- Fixed assert when loading the same model twice
- Corrected debug axes for scaled models
- Fixed teardown of synthetic tracks when disposing all
- Guard against "Camera + Object Track" being selected with no video

---

## Version 2.34.3 (2026-03-15)

### New Features
- **Lommel-Seeliger Reflectance Model**: Physically-based reflectance model for the moon, with regression test

### Improvements
- Improved dropped GLB import flow and custom model lighting

### Bug Fixes
- Fixed model-view bounding box helpers
- Fixed sun and moon rendering position in main view vs. look view

---

## Version 2.34.2 (2026-03-14)

### New Features
- **Direct .h264 and .dad File Support**: Load raw video files directly (e.g., into the video viewer)
- **Center Sidebar**: Optional center "sidebar" for menu docking between views

### Improvements
- More accurate moon position and orientation
- Improved moon blending
- Sun rendered as a 3D mesh with correct size, positioned behind the moon

---

## Version 2.34.1 (2026-03-13)

### New Features
- **Sitch Browser in Main Container**: Sitch browser now displays in the main container with restricted menus for empty sitches and save/load available on all sitches

### Improvements
- Error handling and reporting for missing local file folders
- Guard against overwriting existing files with user confirmation prompt
- Added saving and loading documentation
- Hardened track cleanup

### Removed
- Removed "Save with Permalink" option (redundant)
- Removed old "Reset Origin" (leftover from EUS coordinates, meaningless in ECEF)

---

## Version 2.34.0 (2026-03-12)

### Improvements
- Improved local folder save/rehost UX with status bar feedback
- Refined local folder save flow and save shortcut behavior

### Bug Fixes
- Fixed S3 object-ref video loading

---

## Version 2.33.3 (2026-03-12)

### New Features
- **Local (Non-S3) Server Browser**: Added sitch browser support for local server filesystem saves in non-S3 deployments

### Bug Fixes
- Ignore non-sitch files when linking sitch versions in the admin dashboard

---

## Version 2.33.2 (2026-03-12)

### New Features
- **Browser-First Startup**: Sitrec can now start directly in the sitch browser when no specific sitch or action is requested

### Improvements
- Added dirty-state tracking so the leave-site warning appears only after meaningful changes
- Added stale-build detection and surfaced the build version in the sitch browser
- Reduced redundant sitch browser startup fetches

### Bug Fixes
- Fixed featured sitch key collisions in the sitch browser

---

## Version 2.33.1 (2026-03-11)

### Bug Fixes
- Allow forward slashes in object keys so user and sitch paths are stored correctly

---

## Version 2.33.0 (2026-03-11)

### New Features
- **Object References**: Refactored storage from direct S3 URLs to host-agnostic object references (`sitrec://...`), enabling private storage with presigned URLs and decoupling shared links from specific S3 buckets
- **Featured Sitches**: Admin-curated "Featured" list for highlighting sitches; renamed "Home" tab to "All" and added "Unlabeled" filter

### Improvements
- Fixed double URL decoding in object resolver that could cause key misinterpretation
- Extracted shared PHP helpers to eliminate duplicated visibility/env logic across server endpoints

### Bug Fixes
- Fixed frame for UI tests
- Don't screenshot deleted sitches

---

## Version 2.32.0 (2026-03-08)

### New Features
- **SAM2 Object Tracking**: Basic framework for SAM2-based object tracking
- **New File Browser**: Replaced the old "Open" and "Delete" drop-downs with a new browse dialog
- **Ctrl-N for New Sitch**: Keyboard shortcut to create a new sitch (Cmd-N can't be overridden on Mac)

### Improvements
- Improved drag and drop onto labels in the Sitch browser
- Escape key exits sitch browser even when focus is on the search box
- Refresh screenshot option in sitch browser context menu
- Don't render hidden canvases in screenshots; display thumbnails full width
- More detailed user stats on admin dashboard with monthly records
- Model alias support for older sitches with model names containing spaces
- Handle old sitches with features, allow creation from KML, then dispose and recreate
- Filename sanitization consistency
- Latitude clamping
- More robust error handling, FOV handling, and screenshotting with retry on errors
- Changed a non-functional error into a warning for chopped file data at boundaries

### Bug Fixes
- Fixed flashing text when changing labels
- Fixed error from loading images that was incorrectly also trying to handle as video
- Fixed waiting for screenshots
- Fixed labels uploading
- Fixed clearing source user ID when screenshotting

---

## Version 2.31.4 (2026-03-05)

### Bug Fixes
- Fixed leaking event listener on MQ9 UI
- Fixed resize timeout not being cleared on dispose
- Fixed audio decode timeout not being cleared when disposing MP4 video
- Fixed ECEF-to-LLA conversion near the poles

---

## Version 2.31.3 (2026-03-05)

### Improvements
- Auto-hide empty CNodeViewUI overlay canvases to reduce GPU compositing
- Auto Tracking/Stabilization state is now serialized
- Added "Center on Dark" option

### Bug Fixes
- Fixed chatbot session continuation infinite loop
- Fixed "LOADING" message getting stuck

---

## Version 2.31.2 (2026-03-04)

### Bug Fixes
- Fixed incorrect scaling of lights (from Global Scale)
- Fixed contrail subdivision stack overflow
- Handle version correctly when loading from one user's file while not logged in as them

---

## Version 2.31.1 (2026-03-04)

### Bug Fixes
- Fixed right-clicking on stars and other objects

---

## Version 2.31.0 (2026-03-04)

### New Features
- **Contrails**: Contrail rendering as flat horizontal ribbons trailing behind tracks, with wind drift, initial width ramp, and spread over time
- **Forensics Menu**: Error Level Analysis (ELA) and noise level analysis for image forensics investigation
- **Ocean Surface**: Beta ocean surface rendering with 3D tiles
- **WSPR Track Support**: Import WSPR tracks with Maidenhead grid format locations (e.g., Traquito)
- **Wind Data Fetching**: Fetch wind data from Open-Meteo API (beta)
- **Atmosphere/Fog**: Experimental atmosphere rendering with HDR parameters

### Improvements
- Contrail width ramp subdivided to ~2m segments for smooth visual transition from initial to full width
- Contrails follow earth's curvature for large contrails
- Wind direction applied to plane heading angle
- More accurate usage of HAE (height above WGS84 ellipsoid) and MSL (height above EGM96 geoid)
- Renamed EUS variables and code to ECEF to reflect actual coordinate system
- Blur video/image at source pixel level, not display level; allow fractional pixel blur
- Video and model viewer promoted to top-level buttons in Sitrec menu
- Automatically extend orbital paths by two orbits (e.g., FlightClub)
- Improved smoothing methods for camera motion
- Video export waits for all pending terrain tiles and elevation to load before rendering each frame
- Unique short names when importing the same track in different format
- Correctly orient objects in model viewer
- Allow expanded max in sliders
- Brighter Google 3D tiles
- 3D building status serialized; ellipsoid mode forced when enabling 3D buildings
- Keep stale forensics overlay visible while recalculating with progressive worker updates
- Security hardening
- More robust UI tests with local tilesets
- Package updates including Electron, tar, and electron-builder

### Bug Fixes
- Fixed synth tracks placed in wrong location (was using EUS in ECEF)
- Fixed orientation of track indicator (inverted cone)
- Fixed camera movement on hover disrupting 3D tiles culling
- Fixed massive tile subdivision explosion with narrow-FOV satellite views
- Fixed menu detaching to bottom of screen on multi-monitor fullscreen
- Fixed MSL/HAE handling for camera tracks and altitude labels
- Fixed shift-C to lock to MSL, not HAE
- Fixed missing Draco loader for Google 3D tiles
- Fixed large gap in menus for SitVideo (Video viewer)
- Fixed rotation change triggering cache lock
- Fixed track selection for right-click context menu
- Fixed for sitches missing wind
- Fixed STANAG test failure from incorrect ECEF usage
- Fixed warnings from extra gamma parameter passed to standard material

---

## Version 2.30.0 (2026-02-24)

### New Features
- **3D Buildings**: Basic 3D building rendering with Google Maps PBR tiles (admin only)
- **Ellipsoid Earth Model**: Framework for WGS84 ellipsoid earth model with sphere/ellipsoid toggle in terrain options
- **3D Tile Renderer**: Per-viewport 3D tile rendering with lighting
- **EGM96 Geoid Correction**: Terrarium elevation corrected from EGM96 geoid to WGS84 altitude

### Improvements
- Full ECEF coordinate system transition replacing Y-up EUS assumptions with local tangent vectors
- Ellipsoid model enabled by default in Starlink live mode
- Gimbal cloud speed matching updated for ECEF coordinates
- Moon and Earth shadow calculations corrected for ECEF
- Eclipse umbra sizing fixed with geocentric Sun/Moon vectors
- Fixed lighting on Google Maps PBR tiles with gamma correction
- MSL/HAE altitude handling clarified and corrected throughout
- Removed legacy radius parameters (earth radius is now fixed, no longer variable for refraction simulation)
- Converted legacy local frame EUS camera start positions to LLA
- Globe updates when changing globe model; Agua spline recalculates accordingly
- Per-user tracking and limits for 3D buildings API usage
- Updated npm packages

### Bug Fixes
- Fixed SplineEditor breaking linear tracks (SitJellyfish, SitPorterville)
- Fixed getLocalUp for ellipsoid mode
- Fixed editing buildings
- Fixed crashing when switching from 3D to 2D tiles
- Fixed hardcoded MSL elevation values that need conversion to HAE
- Fixed projectHorizontal for ECEF and replaced clockwiseZX with cross product
- Fixed CNodeTrackFromVelocity.getGroundPoint for ECEF coordinates
- Fixed ECEF camera issues related to assuming local EUS

---

## Version 2.29.0 (2026-02-22)

### Improvements
- Tile coverage caching with dirty parent tracking for faster tile iteration
- Skip GPU usage calculation in dev mode when the GPU usage menu is not visible
- Don't display bad data filter for serialized sitches
- CORS header for getsitches.php

### Security
- Fixed reflected XSS in proxy.php error output
- Fixed path traversal in chatbot.php getHelpDocContent
- Fixed open redirect and reflected XSS in cachemaps.php
- XSS hardening across server-side code
- Restricted unsafe file extensions (like .php)
- Clarified example keys to avoid false security triggers

### Bug Fixes
- Fixed CNodeSpecificFrame using passed frame instead of its own specificFrame
- Fixed getLST returning negative values for western longitudes
- Fixed LLAToECEFVD returning NaN from array-indexing a Vector3
- Fixed ECEFToLLA longitude using atan2 instead of atan
- Fixed event listener leak in PointEditor
- Fixed off-by-one day in tleEpochToDate
- Fixed addInput duplicate-key assert checking literal "key" instead of dynamic key
- Dispose render targets, shader materials, and geometry in CNodeView3D to prevent memory leaks
- Disabled unused CNodeCode.js

---

## Version 2.28.8 (2026-02-21)

### New Features
- **G-Force Track Filtering**: Auto-detect bad tracks with spurious data and apply g-force based filtering
- **Multiple Tracks in CSV Files**: Support multiple tracks in a single CSV file, matching JSON multi-track behavior

### Improvements
- Confirmation dialog before removing a track
- "Try Altitude First" option for track filtering, as altitude is often noisier
- Smoothing parameter visibility updates on folder open and menu mirror
- Clean handling of missing sitches with user-friendly error

### Bug Fixes
- Fixed banking menu after loading sitches
- Fixed invisible tracks being selectable with right-click

---

## Version 2.28.7 (2026-02-21)

### Improvements
- Selectable smoothing types and bank angle for tracks

### Bug Fixes
- Fixed disposing of unused controllers with inputs (e.g., tilt controller)
- Fixed loading a sitch after being in full-screen mode
- Fixed TLE loading with initial blank lines, now stores multiple entries per satellite and chooses the best one

---

## Version 2.28.6 (2026-02-20)

### New Features
- **Gradient Material**: Gradient material for 3D objects with leading edge direction control
- **Export All OSD Data**: Export all OSD data series at once

### Improvements
- Object editing menu stays open even when clicking outside it

---

## Version 2.28.5 (2026-02-19)

### Bug Fixes
- Fixed EPS (Google Earth Studio) exporting

---

## Version 2.28.4 (2026-02-19)

### New Features
- **IR Balloon Thermal Simulator**: Standalone tool for simulating balloon thermal signatures with HDR bloom rendering
- **FOV Curve Editor Y-Range Slider**: Vertical slider on the curve editor for direct visual control of the Y-axis range

### Improvements
- Starlink sitch correctly sets video layout in live mode and clears live mode when any video is dragged in
- Reset live mode when setting time
- Cleaned up export buttons for legacy sitch "reinterpret" functionality

### Bug Fixes
- Fixed relative camera controller
- Fixed ambient temperature calculation in IR balloon simulator (no emissive cooling)

---

## Version 2.28.3 (2026-02-16)

### Bug Fixes
- Fixed terrain not-loaded check
- Fixed deferred track locking during deserialization

---

## Version 2.28.2 (2026-02-16)

### New Features
- **Reflection Analysis**: Analyze surface reflections on 3D objects with configurable grid size and debug arrows

### Improvements
- Refactored view visibility system, separating user intent from computed state to fix fullscreen exit permanently hiding views
- Fixed compositing of overlays and relative views (compass, MQ9UI) when rendering video exports
- Caching AGL positions for jet track and positionLLA so terrain resolution changes don't degrade tracks
- Fix for sky rendering with effects (removed workaround patch)
- More robust tile checks in quadtrees

### Bug Fixes
- Fixed rotation of objects in reflection analysis

---

## Version 2.28.1 (2026-02-16)

### New Features
- **Video Grid Overlay**: Configurable grid overlay on video views with size, subdivisions, offset, and color controls
- **Video Menu**: New consolidated "Video" menu grouping video-related controls (current video selector, rotation, adjustments)

### Improvements
- Grid overlay fades as you zoom out, with default 64px grid and 4 subdivisions
- Slider max values preserved as maxMax, with 300 maxMax enforced for Tgt Start distance
- Allow celestial controller updates during video exporting and panorama rendering

### Bug Fixes
- Fixed feature/pin double deserialization issue (not being disposed on cleanup)
- Fixed grid serialization

---

## Version 2.28.0 (2026-02-15)

### New Features
- **A-B Echo Overlay**: Accumulated video frame echo between A and B markers, with Min and Max echo effects
- **Record Browser Window**: Record the browser window directly
- **Environment Map Material**: Environment mapping for 3D objects with IR mode white sky support
- **Zoom to Point**: Zoom to a specific point in main view
- **Near Plane Slider**: Adjustable near plane distance for fine-tuning 3D rendering

### Improvements
- Improved caching logic for echo groups with detailed caching status display
- More robust handling of corrupt H.264 files, GPU config errors, and open-GOP B-frame decoding
- Selectable display interval for OSD tracks, Page Up/Down navigates to prev/next keyframe
- OSD tracks support altitude lock with both AGL (default) and MSL options
- Spacebar now always toggles pause/unpause instead of toggling GUI
- Moving A and B sliders now keeps main frame slider in the same position
- Effect states are now serialized and restored
- More meaningful file export prefixes
- Ground overlay syncing with quadtrees more robust
- Forcing object above surface is now optional

### Bug Fixes
- Fixed excessive CPU usage from ground overlays
- Fixed wiggle from smoothed tracks
- Fixed exported videos not matching screen
- Fixed overlay visibility issues
- Fixed overlay duplicate display in wireframe
- Fixed importing of FOV CSV files
- Fixed web worker buffer issue for H.264
- Fixed video frame ordering and open-GOP B-frame decoding
- Fixed view visibility logic

---

## Version 2.27.0 (2026-02-10)

### New Features
- **OSD Data Graphing**: Graph OSD data series with scatter plots, separate Y axes, and A-B range selection
- **OSD Track Editing**: Create and edit tracks derived from OSD data with keyframe editing and tab-cycling between tracks
- **KML Track Exporting**: Export tracks in KML format
- **Google Earth Pin Export**: Export Google Earth pins from context menu
- **Crosshair Display**: Press "/" in video view to show crosshair overlay, click to fix position
- **Video Info Display**: Frame numbers, datetime, and video metadata shown in video viewer
- **"Stop At" Parameter**: Track-to-track targets can specify a stop point
- **TARGET/GROUND Modes**: MQ9UI supports switching between target and ground display modes

### Improvements
- Elevation data cached and serialized at highest available level, making synth and OSD tracks load faster without degrading when zooming out
- Multiple OSD data series tracks with serialization, renamed from "Tracks" to "DataSeries" for clarity
- Better OSD value interpolation and keyframe color consistency
- Simplified image and video loading in video viewer
- Corrected overlay borders and dragging for terrain altitude
- Increased blur range to 200

### Bug Fixes
- Fixed AB range
- Fixed scatterplot OSD interpolation
- Fixed full-screen offset in menu bar
- Fixed video info display in video viewer sitch

---

## Version 2.26.9 (2026-02-07)

### New Features
- **Celestial Lock Camera Mode**: Lock camera to celestial objects like "moon", "sirius", etc.
- **EPS Exporting**: Experimental EPS (Google Earth Studio) file exporting

### Improvements
- Added datetime and frame number information to video info display
- Better moon libration application
- Moon parallax adjustment for observer position
- Restored view menu in video viewer

### Bug Fixes
- Fixed context menu when zoomed in on Moon

---

## Version 2.26.8 (2026-02-06)

### New Features
- **3D Lit Moon**: Realistic 3D moon rendering with correct size, phases, and texture
- **Spline from Data Track**: Create splines from existing data tracks
- **Elevation Indicator**: Added elevation indicator to MQ9UI

### Improvements
- Stars now render behind the moon for correct occlusion
- Auto-load latest version of sitch when none specified
- Tests now stop if an assertion fires

### Bug Fixes
- Fixed moon daylight color
- Fixed specular color in Phong shading
- Fixed error caused by unexportable empty arrays in GoFast

---

## Version 2.26.7 (2026-02-05)

### Bug Fixes
- Fixed track edit menu auto-closing and exiting edit mode

---

## Version 2.26.6 (2026-02-04)

### New Features
- **Compass Graticule**: Compass line overlay for azimuth reference in views
- **MQ9 UI Display**: Enhanced MQ9 HUD with distances, positions, display units, and video-matched layout
- **Google Maps Link**: "Google Maps Here" option in ground right-click context menu
- **MGRS Coordinate Support**: Accept Military Grid Reference System coordinates in CSV imports

### Improvements
- Wind incorporated into airframe heading and camera azimuth calculations
- Broader range of coordinate format support including MGRS
- Better moving and rotating of free-transform overlays
- Banking objects use local up instead of EUS up for more correct behavior

### Bug Fixes
- Fixed click-and-drag on look view with MQ9UI
- Fixed backward camera vector causing azimuth graticule position and value to be flipped
- Fixed GUI elements that may have changed parents
- Fixed deserializing lat/lon with new handling

---

## Version 2.26.5 (2026-02-03)

### New Features
- **FlightClub Import**: Drop a .json FlightClub file to create separate tracks for each stage (e.g., filename-Stage_1.csv), with mission info displayed in notes
- **Alt-Az File Import**: Import Alt-Az files exported from FlightClub
- **User-Defined Start Times**: Allow user-defined start times for relative time tracks
- **New Tracking Algorithm**: Added new tracking algorithm with improved base "Template Match" algorithm

### Improvements
- **Notes Shortcut**: Press "N" to toggle notes, Shift-N to pseudo-dock notes on right side
- **Date/Time Parsing**: Parsing date/time with chrono-node for simplified relative time calculations
- **Manual Tracking**: "Limit AB" off by default with updated tooltip
- **Building Edit Mode**: Maintain sidebar status for edit menus, closing edit menu exits edit mode
- **Cloud Properties**: Use correct small units for all cloud properties
- **Mirrored Menus**: Open sub-menus on mirrored menus by default
- **MISB Export**: Export missing sensor roll column for MISB-compliant LOS export
- **Double-Sided Roof Material**: Eaves now look better with double-sided material

### Bug Fixes
- Fixed notes view shrinking due to event handlers not being cleaned up on dispose
- Fixed mirroring of controls that use onFinishChange, not just onChange
- Fixed unit change now affects mirrored controllers as well as the original
- Fixed mirrored controller updating when value is altered by a third different controller
- Fixed edit mode and edit menus show/hide/enable/disable logic with buildings
- Fixed small graph canvas size crash on mobile
- Added test to ensure app starts up for mobile screen size

---

## Version 2.26.4 (2026-01-31)

### New Features
- **Render Stabilized Video**: Export stabilized video at original size from Auto Tracking menu
- **Render Stabilized Expanded**: Export stabilized video with expanded canvas so no pixels are lost during stabilization shifts
- **Notes Panel**: Add and edit notes within the application
- **V-B Measure from Look View**: Set camera, target, and V-B measure positions directly from the look view
- **Undo/Redo for Camera and Target**: Full undo/redo support for camera and target positioning
- **Undo/Redo for V-B Measure**: Full undo/redo support for V-B measurement tool
- **Lock Altitude to Ground**: Track editor can now lock altitude relative to the ground
- **Delete Key Support**: Delete selected objects using the Delete key

### Improvements
- **Video Export Memory Fix**: Added backpressure to video encoder to prevent unbounded memory growth and long "flushing encoder" delays during video export
- **Auto Tracking Enhancements**: Keyframe editing, threshold preview, "Clear from Here" option, "Continue Tracking" feature
- **Snapping Windows**: Windows now snap to edges and other windows when dragging
- **All Views Draggable**: All viewport views can now be dragged and repositioned
- **Z-ordering for Viewports**: Proper layering of overlapping viewports
- **Cmd-S Shortcut**: Save with Cmd-S (Mac) or Ctrl-S (Windows), with smart detection of changes
- **Spline Precision**: Splines use local coordinates to avoid precision jittering
- **Updated Keyboard Shortcuts**: Refreshed keyboard shortcut documentation

### Bug Fixes
- Fixed deleting buildings (broke with local origin changes)
- Fixed caching of incorrect frames when stabilizing video
- Fixed sidebar mouse interaction issues
- Fixed Q-drag of video views

---

## Version 2.26.3 (2026-01-27)

### Improvements
- **Optimized Settings Saving**: Only save settings when actually changed, avoiding unnecessary server calls
- **Robust Error Handling**: More graceful handling of errors during loading
- **Model Loading**: More robust handling of model loading errors
- **Admin Panel**: Additional admin panel information

### Bug Fixes
- Fixed handling of missing .ts files

---

## Version 2.26.2 (2026-01-26)

### Bug Fixes
- Fixed tiles not subdividing when their center is behind the frustum, which led to low resolution tiles near the camera
- Fixed mouse coordinates and other view/screen transforms when sidebar is active

---

## Version 2.26.0 (2026-01-26)

### New Features
- **Sidebar Docking**: Dock menus in left and right sidebars for a customizable workspace
- **Drop Indicator for Sidebar**: Visual indicator shows where menus will dock when dragging
- **Convolution Filters at Source Level**: Image convolution filters now applied at source image level for better quality
- **Video URL Support**: Load videos directly from URLs
- **Video Viewer Electron App**: Basic video viewer extracted to standalone Electron application

### Improvements
- **Sidebar Serialization**: Sidebar configurations are saved and restored between sessions

### Bug Fixes
- Fixed drift when mouse dragging menus
- Fixed spurious scrollbar appearing when dragging a menu into the right dock

---

## Version 2.25.10 (2026-01-26)

### New Features
- **Help Menu Search**: Search box in the Help menu allows searching all menu items across all menus. Type to filter, hover or use arrow keys to preview items in their menus with highlighting, click or press Enter to select. Tooltips are shown for items that have them.
- **Video in Frustum**: Display video texture directly on the camera frustum
- **Video on Ground**: Display video texture on the ground plane with correct aspect ratio
- **Slider Settings Menu**: Right-click on any slider to adjust min, max, and step values for more precision
- **Free Transform for Overlays**: More flexible positioning of ground overlays

### Improvements
- Better TIFF support for files without geolocation data
- Deterministic flash offset based on light ID for consistent strobe timing
- Server-side rate limiting for improved security

### Bug Fixes
- Fixed JSON parsing of sitch file names returning numbers instead of strings
- Fixed feature marker text color not applying correctly
- Fixed FOV calculation issues
- Fixed ground video aspect ratio and visibility in look view

---

## Version 2.25.9 (2026-01-24)

### New Features
- **Customizable Aircraft Strobe Offset**: Random or user-defined strobe offset so aircraft lights can flash at different times
- **Camera Offset Control**: Added customizable camera offset ±10°
- **Elevated Overlays**: Overlays can now be elevated for use as clouds
- **Cloud Extraction**: Extract cloud overlays from ground overlays
- **Context Menu for Overlays**: Right-click on overlay to edit or exit edit mode

### Improvements
- **QuickFetch with Chunked Downloads**: Improved loading of larger S3 files with DB caching
- Improved loading manager
- Highlight borders around overlays to help finding them on the map
- Full GeoTIFF location format support via proj4-fully-loaded
- Rendering camera detached from pod head for better custom code compatibility
- Added terrain to SitGimbal with customization options
- Legacy sitch compatibility patches
- Short names for overlays with cloud feathering
- Auto-lock overlay when dragging in KMZ or GeoTIFF
- Exit one edit mode when starting another
- Navigate to overlay when drag and dropped

### Bug Fixes
- Fixed menu mirroring issues
- Fixed GeoTIFF and overlay handling
- Don't create control points when locked

---

## Version 2.25.8 (2026-01-22)

### Bug Fixes
- Fixed visibility of object3D labels, measurement labels, and feature labels with new overlay label system

---

## Version 2.25.7 (2026-01-22)

### New Features
- **3D Object Labels**: Labels for planes and other 3D objects
- **Label Toggle**: Toggle labels visibility in look and main views

### Improvements
- Undo/Redo support for more operations

---

## Version 2.25.6 (2026-01-22)

### Improvements
- Satellite arrows now use same visibility settings as labels

### Bug Fixes
- Fixed satellite visibility rendering in look view

---

## Version 2.25.5 (2026-01-22)

### New Features
- **Lit Only filter** for satellite labels to show only sun-illuminated satellites
- **Look View Visible Only filter** for main view satellite labels

### Improvements
- Satellite arrows now use same visibility settings as labels
- Backwards compatibility patch for satellite display range in older saves

### Bug Fixes
- Fixed overlay memory leak
- Fixed satellite visibility rendering in look view

---

## Version 2.25.4 (2026-01-22)

### Improvements
- **Replaced sprite text with overlay text** for labels - higher resolution and simpler rendering
- Increased default ambient lighting from 0.2 to 0.3

### Bug Fixes
- Fixed labeled arrows displaying at wrong end for celestial objects

---

## Version 2.25.3 (2026-01-21)

### Improvements
- Satellite display range now defaults to 100,000m
- Ignore satellites with TLE data more than 90 days out of date

### Bug Fixes
- Fixed satellite cutoff value to match previous behavior
- Fixed interpolation continuing when paused

---

## Version 2.25.2 (2026-01-21)

### Improvements
- **Improved satellite rendering** with refactored point light cloud system
- Satellite labels now limited to N closest satellites per view to prevent browser crashes
- Better satellite brightness range in main view
- Main view satellites size-attenuated by distance while remaining visible when zoomed out
- Separated brightness calculation (sun illumination) from view-specific size attenuation
- Stars rendered without subpixel flickering using minimum size and alpha blending
- Saved sitches now correctly restore exact camera orientation via local up vector serialization

### Bug Fixes
- Fixed right-click context menu on satellites and stars
- Fixed jerky satellite motion when playing at 20x+ speed
- Fixed stand-alone video viewer issues

---

## Version 2.24.2 (2026-01-20)

### New Features
- **HEVC/H.265 video support** with improved error handling
- **Rotated video support** for properly oriented playback

### Improvements
- Stand-alone LOS view now supports drag-and-drop
- Admin debug dashboard improvements

---

## Version 2.24.1 (2026-01-19)

### New Features
- **Version history menu** for loading previous saves of a sitch
- **Spline2 spline type** for manual tracking curves

### Improvements
- Improved default spline parameters
- Sitches in load menu now sorted by last save date instead of creation date
- File content hash calculation moved client-side to work with S3 presigned URLs

---

## Version 2.24.0 (2026-01-19)

### New Features
- **SubSitches** for saving and restoring sub-states within a sitch
- **Multi-video handling** with support for multiple video files
- **Video loading manager** displaying loading status of videos

### Improvements
- Improved shift-dragging to rotate camera (prevents glitching at zenith, avoids going underground)
- Double-click Sub triggers rename
- SubSitch details for selecting what is saved and restored
- Saving more metadata with file types including original origin from KML overlays
- Dialog for choosing between video image or image overlay

### Bug Fixes
- Fixed issues with async loading of multiple videos/images
- Fixed ground overlay corner dragging
- Skip "video/image is already loaded" dialog when loading TS file from sitch

---

## Version 2.23.0 (2026-01-17)

### New Features
- **GeoTiff support** for loading GeoTiff image files
- **Image ground overlays** integrated with tile system
- **KMZ file support** with embedded images (e.g., from NASA Worldview/EODIS)
- **Zaine Triangulation** for Gimbal analysis (in Show/Hide menu)
- **Admin DAG view** for node tree visualization

### Bug Fixes
- Fixed z-fighting with custom z-bias for overlay seams
- Fixed async visibility issue
- Fixed initial rotation handles
- Improved overlay visibility

---

## Version 2.22.2 (2026-01-16)

### New Features
- **PBA track importing** for Pico Balloon Archive data

### Improvements
- Great circle interpolation for display of large missing track chunks
- PBA tracks use "balloon_callsign" if available
- Exporting legacy tracks (e.g. Gimbal) as MISB compliant
- Increased video load timeout to 2 minutes

### Bug Fixes
- Fixed missing settings with server sanitization validation

---

## Version 2.22.1 (2026-01-16)

### Improvements
- Updated documentation

---

## Version 2.22.0 (2026-01-16)

### New Features
- **Cloud layers** with sprite-based rendering, proper lighting, and wind-driven animation
- **Feathered cloud edges** with randomized wiggled borders for realistic appearance
- **Cloud drag handles** for intuitive positioning and scaling in the scene

### Improvements
- Clouds conform to earth curvature creating realistic "cloud horizon" for flat cloud banks
- Optimized cloud rendering with comb sort for proper transparency ordering
- Optimized cloud mesh generation for better performance
- Panorama export now starts motion analysis automatically
- Cloud GUI matches building controls for consistency

---

## Version 2.21.0 (2026-01-14)

### New Features
- **Depth velocity traversal** using manual tracking with optimization for ground speed vs air speed
- **Multiple manual curve types** with linear segmented curves for testing
- **MISB track exporting** for minimally-compliant tracks that can be reimported
- **Compass tool** for mobile devices
- **Align with Flow** option to rotate overlays based on motion direction
- **Remove Outer Black** video processing option
- **Speed overlay** display
- **Flowgen tool** to generate scrolling fuzzy backgrounds for testing motion analysis

### Improvements
- Optimized flow orbs by reusing Three.js vectors
- Increased max satellite brightness to 50 (was 6)
- Force settings to default for visual regression tests
- Video resize now uses original dimensions for consistency across users
- Resample audio to 48K if not a common format (48K or 44.1K)
- Flow orbs working in Legacy Gimbal sitch with different camera matrix
- Legacy gimbal sphere visible in look view for better visibility

### Bug Fixes
- Fixed focus issues with GUI mousing out of input boxes
- Fixed typo (choise → choice) preventing early return optimization
- Fixed exporting of Gimbal viewport
- Fixed viewport resizing when changing presets

---

## Version 2.20.1 (2026-01-06)

### Improvements
- Panorama frame step control for more precise panorama creation
- Improved subpixel tracking for slow movement (panning)
- Using actual values (not smoothed) for panorama motion
- Using effects in panorama rendering
- Code consolidation with DRY utility functions

### Bug Fixes
- Fixed mouse scroll wheel leaking through GUI to video zoom
- Fixed skipping frames on panorama export
- Fixed multiple Masking menus bug
- Fixed OpenCV loading issue

---

## Version 2.20.0 (2026-01-04)

### New Features
- **Animated panorama exporting** for video-based 360-degree views
- **Auto masking** for motion analysis regions
- **Multiple motion analysis techniques** with selectable methods
- **Motion analysis cache status indicator** with automatic frame advance until cache is full
- **Automatic encoding fallback** to software encoding when hardware encoding fails
- **Chatbot documentation access** allowing AI assistant to reference docs

### Improvements
- Renamed "Pano Video" to "Animated Pano" for clarity
- Better interpolating over gaps and smoothing with incomplete data
- Much more accurate linear tracklet method for motion tracking
- Using last-known-good frame to handle frames with no tracking data
- Prefer software WebM encoding on Firefox for better compatibility
- Added **Sitch Duration** field in Time menu showing duration as HH:MM:SS.sss
- Elastic GUI sliders now expand their range when typing a value outside the current range
- Basic panorama exporting for 360-degree views

### Bug Fixes
- Fixed motion analysis menu loading on older sitches
- Fixed startup frame issues
- Fixed motion tracking using incorrect frames if frame not yet loaded
- Fixed motion tracking arrows not redrawing when paused and resizing
- Fixed WebM exporter
- Fixed panorama creation using video playback correctly
- Fixed menu position jumping in legacy sitches when hiding empty menus

---

## Version 2.19.6 (2026-01-01)

### New Features
- **MP4 video export** using native browser encoding via MediaBunny
- **4K video export** support (if browser supports it)
- **OpenCV integration** for video motion analysis with background direction detection
- **Motion analysis mask editing** with brush tools for defining analysis regions
- Video export now includes motion analysis overlays
- Added **Enough/Abort button** during video rendering
- Added **watermark** with version and build date to exported videos
- Export videos now render the A-to-B frame range
- Full-screen video export option

### Improvements
- H.264 encoding starts at level 4.1 for maximum compatibility
- Better video render export progress indication
- Reorganized video rendering menu

### Bug Fixes
- Fixed frame slider going one past the end of the video
- Fixed jittery labels on video export
- Fixed OpenCV crash
- Removed sliders from Lat/Lon inputs
- Fixed resize handles appearing when editing video analysis mask
- Fixed fullscreen video issues
- Fixed WebM encoding for fractional framerates
- Fixed video creator changing visibility of separate overlays

---

## Version 2.19.5 (2026-01-01)

### New Features
- **Export Look View Video** option for recording the camera view
- Optional Retina resolution export for higher quality videos
- Select between Main View or Look View for video export

### Improvements
- Better check for pending video frames for more deterministic regression tests

### Bug Fixes
- Fixed jerky Gimbal video recording
- Fixed double numbers appearing in speed graph

---

## Version 2.19.4 (2026-01-01)

### Improvements
- Retrying space-track if recent TLEs fail to load, with progress indicator
- Admin validation of all saved sitches

---

## Version 2.19.3 (2025-12-29)

### New Features
- **Local NLU parsing** for common chatbot requests with fuzzy typo correction using Levenshtein distance
- Basic usage tracking for tiles and AI features

### Improvements
- More robust JSON parsing
- More secure example getUserIDCustom

### Bug Fixes
- Fixed sitch name validation issues

---

## Version 2.19.2 (2025-12-29)

### Improvements
- Removed unused vendor files and replaced with node modules
- Updated dependencies: jest 29.7.0 to 30.2.0, express 4.22.0 to 5.2.1, mathjs 14.6.0 to 15.1.0, three.js 0.181.2 to 0.182.0, webpack 5.101.3 to 5.104.1

### Bug Fixes
- Fixed GUI menus blocking keyboard input to the application

---

## Version 2.19.1 (2025-12-28)

### New Features
- **STANAG 4676 file importing** with correct camera and target tracks
- **MISB/KLV file support** improvements with CSV variant support

### Improvements
- Track file importing refactored for better multi-track support
- More robust getSitches handling for simultaneous requests
- Additional unit tests for file loading (KML, GeoJSON, SRT, STANAG)

### Bug Fixes
- Fixed "to-target" setting for multi-track imports

---

## Version 2.15.1 (2025-12-09)

### Improvements
- Removed right-click deletion of spline editor points to prevent accidental deletions
- Smoothing for synthetic tracks
- Expanded track time offset range to 600 seconds (10 minutes)

### Bug Fixes
- Fixed orientation controller for synthetic objects
- Fixed distorted MQ9 models at long distances from origin

---

## Version 2.15.0 (2025-12-08)

### New Features
- **Terrain transparency slider** for adjusting terrain opacity
- Configurable sources for Starlink and active satellite data

### Improvements
- More accurate raycasting for LLA positioning to prevent camera going underground
- Changed Draco web workers from CDN to local hosting for better server compatibility
- Restructured documentation with CSS styling for local HTML docs

---

## Version 2.14.2 (2025-12-08)

### New Features
- **Human Horizon controller** for GoFast analysis
- **Sky plot** for celestial view
- **Ephemeris view** with aligned columns
- **ACTIVE satellite source** from Celestrak
- **Export TLE button** for saving satellite data

### Improvements
- Better event calculations for celestial objects
- VIS/etc calculations for visual ephemeris

---

## Version 2.14.1 (2025-12-08)

### New Features
- Save and load terrain layers (e.g., for NRL WMTS)
- Handle serializing sitches with local folder .TS video files

### Bug Fixes
- Fixed various .TS file rehosting issues

---

## Version 2.14.0 (2025-12-03)

### New Features
- **XML STANAG 4676 file parsing** framework
- Basic XML position track loading
- KML track loading encapsulation

### Improvements
- Restructured track file import logic for more source formats
- Only set terrain material transparency when opacity < 1 to avoid render overhead

---

## Version 2.13.0 (2025-11-28)

### New Features
- **WebXR VR support** for desktop VR headsets via navigator.xr.isSessionSupported()

### Improvements
- Correctly snap to ground with keyboard shortcuts when position mode is AGL
- VR emulator excluded from production builds

### Bug Fixes
- Fixed background flow indicator on GoFast

---

## Version 2.12.0 (2025-11-25)

### Improvements
- S3 presigned multipart uploading support

---

## Version 2.11.0 (2025-11-17)

### New Features
- **Audio file support**: Play audio-only files (mp3, wav, ogg, flac, webm, aac, aif, m4a) with visualization
- **Elevation pseudo-color**: Map type showing elevation with color coding
- **Ridgeline inset** display option

### Improvements
- Support for changing playback framerate for audio
- Audio/video cleanup on dispose
- Support for iPhone .mov files with multiple audio streams

### Bug Fixes
- Fixed Ocean surface display in Elevation Pseudo-Color map type

---

## Version 2.10.0 (2025-11-12)

### New Features
- **FOV Editor**: Visual editor for field of view with max slider

### Improvements
- Additional video effects and convolution filters
- Improved track point editing widget
- Restored brightness/contrast controls to video view

### Bug Fixes
- Fixed issues with dragging a view while over its tab menu
- Fixed object tracker and pointer events
- Fixed synth track deletion

---

## Version 2.9.0 (2025-11-04)

### New Features
- **AR Mode**: Long press on compass to activate augmented reality mode on mobile devices

### Improvements
- Compass testbed improvements
- Ensure custom menus are on-screen when created

### Bug Fixes
- Fixed satellite menu visibility and showing/hiding track based on valid satellite names
- Fixed issue with saved rotation for buildings
- Fixed issue where neighboring points were not being moved in the horizontal plane when dragging a corner
- Fixed fiddly rotation handles
- Removed unused code for dragging roof vertices

---

## Version 2.8.0 (2025-11-02)

### New Features
- **Building editor**: Create and edit 3D buildings with rooflines
- **WASD controls** for camera movement
- **Feature labels**: 3D labels from CSV with arrows
- **Earth shadow display**: Show location of Earth's shadow at given altitude
- **Mobile support**: Pinch controls, touch camera controls, mobile file loading

### Improvements
- Double-click on menu tab to close
- Undo/redo support for building editor
- Better conforming buildings to ground elevation
- Adaptive frame rate for performance
- VB measure (renamed from AB measure)

### Bug Fixes
- Fixed flare region display
- Fixed satellite arrows cleanup with large time jumps
- Fixed planet brightness GUI error

---

## Version 2.7.0 (2025-10-11)

### New Features
- **Settings menu**: Added to Sitrec menu with terrain max details slider
- **LOS exporting**: Export Line of Sight data with uncertainty values
- **LOS viewer tool**: Standalone viewer for exported ENU LOS data

### Improvements
- Subdivision maps on by default
- Docker development environment improvements
- Terrain tile handling improvements with minZoom support
- Time offset for tracks (up to 30 seconds)
- Covering holes at poles with grey sphere

### Bug Fixes
- Fixed Docker volume mount issues
- Fixed race condition in map loading and cleanup

---

## Version 2.6.0 (2025-10-02)

### New Features
- **Context menus**: Right-click on planets, satellites, tracks, and ground for context-sensitive options
- **Aircraft model lights**: Strobing nav lights with configurable timing

### Improvements
- More robust MISB/KLV file parsing with better error handling
- Improved light timing for 737 model
- TS file validation and improved parsing
- Suppressing context menus when right-clicking on a menu

### Bug Fixes
- Fixed timing of short duration lights

---

## Version 2.5.0 (2025-09-08)

### Improvements
- **Build system updates**: Brought up to date for external builds
- Standalone server support for quick install tests
- Made chatbot install optional
- Moved custom URL functions into config.js

### Bug Fixes
- Fixed circular dependency checking for multiple runs
- Fixed keyboard shortcuts display

---

## Version 2.4.0 (2025-07-20)

### New Features
- **AI Assistant chatbot**: Natural language scene control with persistent chat history
- **Camera pointing via RA/Dec**: Look at static celestial objects like stars and constellations
- **Auto time zone detection** from client

### Improvements
- Dark and light themes for chat interface (defaults to dark)
- Better handling of time zones with +/- format
- Draggable chat window with close button

### Bug Fixes
- Fixed button presses and double clicks getting through chat window
- Fixed paragraphs in chat display

---

## Version 2.3.0 (2025-07-14)

### Improvements
- **IP-based geolocation**: More reliable than browser-based geolocation
- Improved startup experience for Starlink sitch

---

## Version 2.2.0 (2025-07-13)

### New Features
- **3D model lights**: Basic 3D lights with support for extracting lights from GLTF files
- **Time zone display** in UI elements

### Improvements
- Expanded flare band to better match actual reflections
- Non-Starlink satellites now displayed in bluish white

---

## Version 2.1.0 (2025-07-01)

### Improvements
- Better perceptual scaling of stars and satellites
- Track management with per-track smoothing controls
- Video time display now in top right corner
- Flow orb improvements
- Dynamic subdivision now a menu option
- Global object scale and sim speed up to 500
- Added "Show in look view" to Contents menu

### Bug Fixes
- Fixed point sprite scaling when viewport changes size
- Fixed camera up vector after dragging long distance
- Fixed speed graphs for sitches not near the origin
- Fixed aspect ratios on render targets
