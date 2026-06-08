# Fast-Regression Scenario Harness — Coverage Expansion Plan

**Status:** M1 IMPLEMENTED & green (custom-sitch focus); M2–M6 proposed. See §13.
**Author:** derived from a 20-agent coverage/design/verify workflow, corrected against four
adversarial code-grounded reviews.
**Scope:** Extend the existing fast visual-regression harness so that a single warm sitch
load can exercise *many* aspects of Sitrec — driving events and asserting on **computed
values** (committable JSON) as well as pixels — without changing app behavior and with zero
side effects on shared state.

---

## 0. Executive summary

The current harness (`tests_regression/fast-regression/run.mjs`) is **one-dimensional**: per
sitch it does exactly one thing — load → settle → jump to frame 10 → screenshot the
*composited* viewport → pixel-compare. That asserts "the final image of a static scene at one
frame looks the same." It never drives an interaction, never advances time, never reads a
*computed value*, and never touches the analysis/export tools.

But the harness already drives real Chrome through Playwright's library `page.evaluate()`, and
the app exposes `window.sitrecAPI` (97 functions — the same surface the MCP bridge wraps),
plus `NodeMan`, `ViewMan`, `Sit`. So a test can **drive the same API the bridge uses** and
**inspect node values**, warm-cache, GPU-deterministic, with no Playwright test-runner.

The plan adds a **Scenario Harness** — a sibling runner (`run-scenarios.mjs`) that *imports*
(does not fork) the proven internals of `run.mjs`, plus a single step interpreter
(`stepRunner.mjs`) shared by both the headless runner and the MCP bridge. Scenarios are
auto-discovered `.mjs` files; each amortizes one expensive warm load over **many cheap value
assertions**.

The single highest-leverage idea: **committable value baselines.** A
`NodeMan.get(id).getValue(frame)` result — a track's LLA, the camera's look direction, the sun
vector, a serialized node-graph — is deterministic JSON. Unlike pixels (GPU/driver-dependent,
gitignored, local-only), value JSON is **env-independent and committable**, produces a
human-readable git diff on an intended change, and catches logic regressions pixels miss (a
wrong-but-plausible number can render near-identical pixels and pass today).

**Two-tier model:** a *value* tier (no screenshot, dozens of assertions per sitch, committed
JSON baselines) and a *pixel* tier (per-view captures, local-only PNG baselines, reusing
today's flow). The existing frame-10 pixel pass is left untouched.

---

## 1. Current scope (what `run.mjs` covers today)

| Dimension | Today |
|---|---|
| Trigger | Load saved `?custom=<url>&regression=1&frame=10` |
| Settle | `waitForSettle()` — load/parse/tile/elevation bookkeeping + visible-tile hash quiet & stable, `par.frame===10` |
| Capture | ONE screenshot, full composited 1920×1050 clip (top 30px menu bar cropped) |
| Assertion | `pixelmatch` vs local `baseline/<slug>.png`, `maxDiffRatio 0.001` |
| Coverage | ~38 Regression-labelled sitches |
| Error detection | `ASSERT:` console capture, blank-render guard, frame-lock confirmation |

**What it does NOT do:** drive any interaction; advance time / multi-frame; read any computed
value; assert per-view (a lookView regression is masked by mainView in the composite); exercise
any tool (motion analysis, tracking, panorama, de-fence, scripted video, export); test
save/load serialization; verify network independence.

---

## 2. Coverage gap analysis (12 functional areas)

The mapping phase produced a grounded, file:line-cited inventory of **~158 testable
behaviors** across 12 areas. Highlights of what the frame-10 pixel-only pass completely misses:

| # | Area | Key untested, value-assertable behaviors |
|---|---|---|
| 1 | **Camera & navigation** | `JetLOS.getValue()` heading/up/right/vFOV (the LOS the look view aims down — catches the historically fragile **AZELISSUE** az/el sign flips); `getCameraLLA`; track-to-track look-at aim; PTZ az/el/fov drives; celestial point/lock/unlock |
| 2 | **Night sky & satellites** | TLE propagation positions; `filterSatellites` visible counts; `toSun`/sun-moon RA·Dec ephemeris; star-catalog count/maxMag (`CStarField.getStarCount` :239) |
| 3 | **Tracks & ingestion** | `Track_<sn>.getValue().lla[]` directly (interpolation correctness); track manifest; **palette `colorData_` map** (the documented async color-order flake — caught *every* run by value, not intermittently by pixels); MSL-vs-HAE altitude reference |
| 4 | **Synthetic 3D** | cloud `cloudCount`/`instanceCount` (the 2.78.1 puff-shed seedrandom guard); building roof-coplanar invariant; create→update→delete CRUD with no-leak count check |
| 5 | **Terrain & maps** | elevation at fixed lat/lon (Local/Flat); active map/elevation source (silent-fallback guard); visible-tile-key set; gaussian-splat instanceCount/bbox |
| 6 | **Video** | `Sit.videoFrames`/`fps`; decoded dimensions vs `videoMaxSize` downscale; **PTS array** (B-frame/PTS desync pixels never catch); `hasRealFramePTS`; per-view pixel |
| 7 | **Video analysis tools** | motion-pass dx/dy/conf; `fitSimilarity` RANSAC; `detectRedactionRects`; auto-mask `isPointMasked`; object-tracker centroid |
| 8 | **Export & cinematic** | `createVideoExportFramePlan` (pure ping-pong/loop/cap arithmetic); speed-suffix strings; scripted-video parse events/beats/duration |
| 9 | **Wind / physics / traverse** | `CNodeWind.getValueFrame` vector; LOS-traverse method-switch LLA; airspeed wind coupling; atmospheric profile |
| 10 | **Views / layout / menus** | `listViews` fractions; `setLayout` template math; `setMenuValue↔getMenuValue` round-trips; notes; `hideChrome`; undo empty-stack |
| 11 | **Save/load/serialization** | `exportSitchState` shape; **`mods` map field-fidelity** (the highest-value committable serialization baseline); `dirty===false` on clean load; reload-idempotence; `force:true` injection |
| 12 | **Time/celestial** | frame↔ms round-trip; `setDateTime` cascade; sun/moon direction + `sunAngle`; timezone UTC-invariance |

---

## 3. Architecture — the Scenario Harness

**Two-tier, single-schema, sibling runner.** A new
`tests_regression/fast-regression/run-scenarios.mjs` **imports** the proven internals of
`run.mjs` after a behavior-neutral refactor. Scenarios are auto-discovered `.mjs` modules. One
shared `stepRunner.mjs` is the single execution path — used by both the headless runner and a
new MCP bridge handler, so **a scenario authored live via MCP runs byte-identical headless**.

### 3.1 File layout

```
tests_regression/fast-regression/
  run.mjs                 # EXISTING pixel pass — refactored ONLY to export internals + guard main()
  run-scenarios.mjs       # NEW sibling runner (imports run.mjs exports; globs scenarios; fresh page each)
  stepRunner.mjs          # NEW single step interpreter + canonical normalizer + tolerance + denylist
  scenarios/              # NEW auto-discovered scenario modules, grouped by area
    camera-nav/gofast-camera-los.scenario.mjs
    tracks/...  satellites/...  synth/...  video/...  export/...  save-load/...
    _helpers/camera.mjs synth.mjs serial.mjs    # shared step-factory closures (DRY, no core changes)
    _authoring/record.mjs                        # drive/expect impl backed by the MCP bridge (live dry-run)
  value-baseline/<id>.json    # NEW — COMMITTED, env-independent value baselines (OUTSIDE baseline/)
  baseline/<id>__<name>.png   # EXISTING gitignored dir — now also per-scenario LOCAL-only pixel captures
  output/                     # EXISTING gitignored — value-report.json + scenario-report.json + diff PNGs
tools/SitrecBridge/extension/page-bridge.js   # NEW handler sitrec_run_scenario -> same stepRunner
src/CSitrecAPI.js  src/index.js               # isLocal-gated getters + window.__sitrecTest re-export bundle
package.json: "test-regression-scenarios": "node tests_regression/fast-regression/run-scenarios.mjs"
```

### 3.2 Scenario file format

```js
// scenarios/<area>/<slug>.scenario.mjs
export default {
  id: 'gofast-camera-los',   // unique; names value-baseline/<id>.json
  sitch: 'gofast',           // BUILT-IN key -> ?sitch=gofast  (see §4 frozen-input rule)
  builtin: true,             // REQUIRED: true -> ?sitch= ; false -> ?custom=<url> (frozen fixture)
  frame: 10,                 // initial settle frame (locked via frame= URL param + regression=1)
  tier: 'value',             // 'value' | 'pixel' | 'both'
  network: 'none',           // 'none' (runner default-deny network) | 'fixture' (page.route sentinel)
  localTerrain: false,       // adds regressionLocalTerrain=1 for deterministic elevation
  pinDateTime: null,         // optional ISO -> leading apiCall setDateTime (required for celestial reads)
  steps: [ /* StepObject[] */ ],
}
```

### 3.3 Step vocabulary (the only things `stepRunner.mjs` interprets)

| Step | Purpose |
|---|---|
| `{type:'settle', frame}` | drive frame + `waitForSettle({wantFrame})` |
| `{type:'setFrame', frame}` | `setFrame` + re-settle (temporal reads) |
| `{type:'snapshot', name, fn}` | read a string `()=>{…}` via `page.evaluate`; stored for restore |
| `{type:'restore', from, fn}` | re-apply snapshot (+ `recalculateCascade`); **auto-emitted at scenario end** for every snapshot |
| `{type:'apiCall', fn, args, capture?}` | **`await window.sitrecAPI.call(fn,args)`** (the MCP path); resolved result stored under `capture` |
| `{type:'eval', name, fn, arg?, capture?}` | string body via `page.evaluate(fn,arg)`; **must return a plain object** (§7) |
| `{type:'assert', name, fn, equals}` | inline structural equality vs an embedded literal (env-independent invariants; NO baseline file) |
| `{type:'capture', name, read, pick?, tol?}` | `read={node|api|eval}`; canonicalize + diff vs committed value-baseline JSON |
| `{type:'pixel', name, view?}` | `view:'mainView'|'lookView'|'video'|'composite'|'page'`; LOCAL-only PNG via pixelmatch |

`read` forms: `{node:'JetLOS', method:'getValue', frame:10}` · `{api:'getCameraLLA', args:{}}`
· `{eval:'()=>({…})'}`. `pick` is a dotted-path list (or a helper projector).

### 3.4 Value-baseline JSON (committed)

```jsonc
{ "schema":1, "scenarioId":"gofast-camera-los", "sitch":"gofast", "frame":10,
  "captures": { "<captureName>": <normalizedValue>, ... } }
```

**Canonical normalizer** (one function, applied identically at write and compare):
1. `Vector3 {x,y,z}` kept as a plain object (never a raw Three object — see §7).
2. Every finite number rounded by its tolerance tier: `Math.round(v*10^d)/10^d` (**absolute**,
   never ratio — ECEF magnitudes ~6.4e6 m make ratio wrong).
3. Object keys alpha-sorted; arrays-of-objects sorted by a declared stable key (tracks by
   `trackID`, `mods` by node id) to kill insertion-order nondeterminism.
4. `lla` arrays `[lat,lon,alt]` preserved as arrays.
5. A fixed **denylist** strips volatile fields before write/compare: `exportVersion`,
   `exportTag`, `exportTagNumber` (`CustomManagerSerialize.js:588-590`), datetime-based
   `sitchName`, `elapsedMs`.

**Tolerance tiers** (inferred from key path, **overridable & required via step `tol`** where a
name doesn't match a known tier — see correction C11):

| Tier | Keys | Tolerance |
|---|---|---|
| vector | heading/up/right/toSun/toMoon (`|v|≈1`) | abs `1e-6` |
| lla | lat/lon, az/el/from (deg) | abs `1e-6` |
| ecef | position `{x,y,z}` (`|x|>1e5`), alt (m) | abs `1e-3` m |
| scalar | vFOV/fov/angles/knots | abs `1e-4` |
| count | integers (cloudCount/frame counts) | EXACT |
| string/bool | — | exact |

A `frameMismatch` / `settleTimedOut` / `ASSERT` / blocked-network capture **refuses to write a
baseline** (cannot poison committed JSON). `--update-values` rewrites JSON only; `--update`
rewrites local PNGs only.

---

## 4. The committable-value insight — and the frozen-input rule (correction C9)

Value baselines are env-independent **only if computed from frozen inputs.** Node values are
pure JS computed from the sitch definition + bundled data (fixed `startTime`, bundled TLE,
Local/Flat terrain). The normalizer rounds to tolerance and sorts, so the same JSON is produced
on any GPU/OS/CI.

**Critical correction:** a value baseline derived from a `?custom=` **server-saved** Regression
sitch will silently **rot** — that sitch's content lives in the server DB under the regression
user, not in the repo, so re-saving it (or a version-list change) diverges the committed JSON
with no code change. Therefore:

- **Committed value baselines MUST use frozen inputs** = **built-in sitches**
  (`src/sitch/Sit*.js`, in the repo: `gofast`, `pvs14`, `custom`, `aguadilla`, `chilean`, …)
  and bundled data.
- For a behavior only a saved sitch exercises (e.g. `potomac` multi-track palette flake), either
  (a) **commit a frozen fixture copy** of that sitch's JSON into the repo and load it via a
  `network:'fixture'` `page.route` sentinel `?custom=`, **or** (b) keep that sitch's value
  baseline **local-only** (not committed) and rely on the built-in equivalent for the committed
  signal. The flagship palette-order test should be re-homed onto a built-in (or frozen-fixture)
  multi-track sitch so its JSON is genuinely committable.

This is the single most important correction to the original synthesis.

---

## 5. API & bridge extensions (all test-only; never ship to production)

All app-side additions gate on `isLocal` (hostname-derived, `configUtils.js:63`) **and**
`Globals.regression` (`index.js:495,537`) — the same local-only pattern as the SHF
`window.shf` hooks — so nothing reaches `www.metabunk.org`.

1. **Refactor `run.mjs` (behavior-neutral):** add `export` to `settleStateFn`, `isPending`,
   `waitForSettle`, `renderOneFrame`, `isBlank`, `enumerateSitches`, `buildLoadUrl`,
   `currentWorktreeBase`, `fetchJson`, `slug`, `CONFIG`; **hoist `launchOpts` into a
   module-level `buildLaunchOpts(CONFIG)`** (correction C16 — today it's a local const inside
   `main()` at `run.mjs:653`, not exportable as-is); wrap the `main()` call in
   `if (import.meta.url === pathToFileURL(process.argv[1]).href)` so `run.mjs` stays a standalone
   script *and* an importable module. **Extend `buildLoadUrl` to branch on `sitch.builtin`** →
   emit `?sitch=<key>` instead of `?custom=<url>` (correction C8 — today it only emits `custom=`).
2. **`getCameraOrientation({view})`** → `{viewId,cameraId,heading,up,right,vFOV,az,el,pos}` via
   `ViewMan.get(view).camera` + the ptz controller. Unlocks orientation assertions on sitches
   lacking a `JetLOS` (custom, aguadilla).
3. **`getTerrainElevation({lat,lon})`** → `{elevation,tileZ,tileX,tileY}` from
   `elevationMap.getElevationWithTileInfo` (`QuadTreeMapElevation.js:562`). Local/Flat only.
4. **`getSynthInternals({type,id})`** → clouds `{cloudCount,instanceCount}`
   (`CNodeSynthClouds.js:212/223`), buildings `{bottomAltsHAE,roofAltHAE,roofCoplanar}` — the
   determinism invariants `serialize()` omits.
5. **`getSunMoon()`** → `{sunDir,moonDir,sunAngle,sunTotal}`; **`getCameraAzEl()`** →
   `{az,el}` of `NodeMan.get('ptzAngles')`. Stable shapes for celestial scenarios.
6. **`window.__sitrecTest`** namespace, populated **only inside `if (isLocal && Globals.regression)`**
   (NOT the ungated `if (typeof window)` block — correction C3/extensibility): thin re-exports of
   module-private pure fns — `createVideoExportFramePlan`/`getVideoExportSpeedSuffix`/
   `compareGraySamplesForDuplicate` (`VideoExporter.js`), `fitSimilarity`
   (`CameraMotionFromVideo.js:244`), `detectRedactionRects` (`RedactionDetect.js:298`),
   `interpolatePosition`/`detectVideoContainer`, `getObjectTrackerForTesting`.
7. **HARDEN existing exposure (live bug):** `window.getMotionAnalyzerForTesting` and
   `window.toggleMotionAnalysis` currently ship **ungated** at `index.js:1542-1543` (verified).
   Wrap them in the same `if (isLocal && Globals.regression)` gate.
8. **`sitrec_run_scenario({scenario})`** bridge handler in `page-bridge.js` dispatching an
   in-memory scenario through the **same** `stepRunner.mjs` the headless runner uses.

**Gating mechanics (correction C3):** `this.api` is a single object literal built once in the
`CSitrecAPI` constructor and `this.debug` is mutable via `toggleDebug` — so do **not** gate on
`this.debug`. Register the new getters by `if (isLocal) Object.assign(this.api, {…})` *after* the
literal, keyed on the real `isLocal` const. Append each new read-only getter name to the
`transientCalls` set so it's classified read-only.

---

## 6. Side-effect & determinism guardrails (corrected)

1. **Fresh page per scenario** — `context.newPage()` + `page.close()` (as `processSitch` does
   today, `run.mjs:476`). In-page node-graph/menu/notes/ViewMan mutations never leak between
   scenarios; only the on-disk warm tile/asset/video cache is shared (the real speedup).
2. **localStorage/IndexedDB are PROFILE-scoped, not page-scoped (correction C2).** A fresh page
   does **not** isolate them — they persist on disk in `.chrome-profile/` across pages and runs.
   `CScriptedVideoManager.parse()` writes `localStorage[STORAGE_KEY]` (`CScriptedVideo.js:279`).
   So any scenario that writes localStorage/IndexedDB MUST either (a) snapshot the specific keys
   and restore them in `finally`, or (b) run in a **separate ephemeral context/profile**, or
   (c) have the runner clear those keys between scenarios. Fresh-page alone is insufficient.
3. **Static mutation lint (pre-execution).** The runner flags any `apiCall` whose `fn` is in an
   explicit **mutating set** (`gotoLLA`, `setCameraAltitude`, `lock*`, `pointCamera*`,
   `setMenuValue`, `executeMenuButton`, `createSynth*`, `deleteSynthElement`, `addObjectAtLLA`,
   `satellitesShow/Hide*`, `setDateTime`, `showView/hideView/setLayout/setViewPosition`,
   `setNotes/updateNotes`) and **requires** it be bracketed by `snapshot`+`restore` or carry
   `isolated:true`. **`transientCalls` is NOT a safety signal** (verified `CSitrecAPI.js:2766`:
   it means "does not change *serialized* state" and *includes* mutating drives) — mutation is
   determined by this explicit denylist, never by `transientCalls`.
4. **Auto-restore in `finally`.** Every `snapshot` auto-emits its paired `restore` at scenario
   end inside try/finally, reverting ptz az/el/fov, wind, traverse choice, view layout, notes,
   satellite visibility, video rotation, celestial locks (always ends with `unlockCamera`).
5. **Hard server-write ban (correction C1 — the original block was decorative).** The real save
   path is `FileManager.saveSitchNamed → rehostDynamicLinks → CRehoster`, which hits
   `rehost.php?action=…`, then raw **S3 presigned `PUT`** uploads to arbitrary AWS URLs, plus
   `getsitches.php?get=myfiles`. None match the original `**/sitrecServer/save*` glob. The block
   must be **default-deny on write**: (a) `saveSitch`/`getShareLink({saveIfNeeded})` are **absent
   from the drive vocabulary entirely** — only read-only `exportSitchState`/`getSitchState`/
   `getCustomSitchString` are permitted for save-path coverage; (b) `page.route` aborts
   `**/rehost.php*`, `**/getsitches.php?*get=myfiles*`, and **any request whose method is `PUT`**;
   (c) a `page.evaluate` shim throws if `FileManager.saveSitchNamed`/`rehostDynamicLinks` is ever
   entered. Belt-and-suspenders, so the regression user's saved versions can never be overwritten.
6. **No live network for value baselines.** `network:'none'` (default) → runner aborts
   `proxyStarlink.php`, celestrak, open-meteo, UWYO/IGRA2; asserts the sitch uses **bundled TLE**
   (pvs14 ships `data/pvs14/StarlinkTLE18APr23.txt`) and Local/Flat terrain. A scenario that
   reaches a blocked host **fails fast** rather than baselining daily-changing data. Per
   open-question, the runner must also assert *no live request actually fired* for a
   `network:'none'` scenario (a sitch could lazily fetch).
7. **Cache / ordering.** Value steps run **before** any pixel/`getImage` step at a frame
   (`getImage` purges the decode cache, `CVideoWebCodecBase.js:1266`); rotation/stabilization/
   `selectVideo` drives are `isolated:true`.
8. **ASSERT trap.** Every `page.evaluate` is wrapped with `processSitch`'s `ASSERT:` console
   listener + `pageerror` rejector (`run.mjs:489-498`) plus a per-step timeout. A Sitrec
   `assert()` emits `console.error('ASSERT: …')`; in headless the subsequent `debugger` is a
   no-op (no inspector attached), so execution continues — the trap surfaces the `ASSERT:` line
   as a **step failure** and refuses to write a baseline (correction C5 — it is *not* rescuing an
   indefinite hang, it is catching the console signal).

---

## 7. MCP authoring loop — true single source of truth (corrected)

The authoring promise (a scenario authored live via MCP runs byte-identical headless) holds
**only with a hard projection rule** (correction C7). The bridge's `sitrec_eval` runs results
through `safeSerialize`, which tags `Vector3`/`Color` with a `_type` field and **truncates**
arrays at 100 / object keys at 50 / depth at 7. Playwright `page.evaluate` does none of this.
So a raw Three object read one way ≠ the other.

**Rule:** every `read`/`eval` MUST return a **plain projected object** (e.g.
`{x:v.x,y:v.y,z:v.z}`, never the raw `Vector3`), and `stepRunner`'s canonical normalizer runs
on **both** the MCP-authoring path and the headless path. With nothing raw to tag/truncate, the
two paths produce identical JSON.

**Async correction (C10):** `window.sitrecAPI.call(fn,args)` is **async** (returns a Promise).
The original worked examples read `.result` synchronously off it — broken. The `apiCall` step
**awaits** the call and stores the resolved result in the captures map; `assert`/`eval` bodies
read pre-captured values from the captures arg (passed by the runner) and never call the API
synchronously inline. `eval`/`setFrame` reads use `getFrame`/`NodeMan`, **never `window.par`**
(not exposed; the harness already guards it defensively — correction C14).

**Authoring flow:** drive interactively with `sitrec_set_frame`/`sitrec_api_call`/`sitrec_eval`/
`sitrec_get_node` to discover the exact node ids/values for the sitch in front of you; each MCP
call maps 1:1 to a step object; dry-run the `.scenario.mjs` via `_authoring/record.mjs` (the
drive/expect impl backed by the bridge) against the live tab; then
`run-scenarios.mjs --scenario=<id> --update-values` mints the committable JSON via the same
normalizer; review the JSON diff; commit scenario + JSON. *(The optional `sitrec_record`
convenience is descoped — correction C13: `_mcpDebugLog` is a console-output buffer, not an
API-call log, so it has no data source without new bridge infra.)*

---

## 8. Phased rollout

| Milestone | Content | New app code? |
|---|---|---|
| **M1** | Refactor `run.mjs` (export internals, `buildLaunchOpts`, `buildLoadUrl` `?sitch=` branch, guarded `main`); add `run-scenarios.mjs` + `stepRunner.mjs` + normalizer/tolerance/denylist; npm script; `.gitignore` split (commit `value-baseline/`, keep `baseline/`+`output/` ignored). Ship **zero-mutation value scenarios on built-in sitches**: camera LOS (`JetLOS` heading/vFOV across frames), tracks (`Track_<sn>.getValue().lla[]` directly — **never** `getTrackPosition`, correction C15/below), satellites (bundled-TLE `pvs14`), wind read, save-load (`exportSitchState` shape + `mods` + `dirty===false`). | **None** (test harness only) |
| **M2** | Four `isLocal`-gated read-only getters (`getCameraOrientation`, `getTerrainElevation`, `getSynthInternals`, `getSunMoon`/`getCameraAzEl`); harden the two ungated motion hooks. Adds terrain, time-celestial, synth read invariants. | Thin gated getters |
| **M3** | **Driven** scenarios with snapshot/restore + static lint + auto-restore + hard save/network blocks: camera drives (PTZ, point/lock→unlock, sat-mode toggle), wind/traverse drives, views-ui (`setMenuValue↔getMenuValue`, layout, notes, `hideChrome`, undo empty-stack), terrain source switches. | None |
| **M4** | Synth + 3D-object CRUD round-trips (isolated `create→assert→delete`, count returns to baseline = no leak); `addObjectAtLLA` position; geometry/dimensions. Synth content authored at load, anchored to the sitch's own `Sit.lat/Sit.lon` (correction C19). | None |
| **M5** | Video value reads (`videoFrames`/`fps`, dims, PTS array, `hasRealFramePTS`, `settleReady`) + **per-view pixel tier** (`lookView`/`mainView`/`video` — closes the composited-masking gap) + decoded-source-frame readback; sitch-switch teardown; save-load reload-idempotence via `page.route` sentinel. Pixel baselines LOCAL-only. | None |
| **M6** | Heaviest — tools/export via `window.__sitrecTest`: pure-fn value scenarios (`createVideoExportFramePlan`, `fitSimilarity`, `detectRedactionRects`, `compareGraySamplesForDuplicate` — deterministic, no OpenCV); scripted-video parse (localStorage snapshot/restore per C2); motion-analysis short-range pass; auto-mask probes. Excludes file-download exporters, `getDisplayMedia`, GPU-binary output, unseeded-RNG paths. | `__sitrecTest` bundle (M2 gate) |

---

## 9. Coverage matrix (target end-state)

| Area | New tests / drive | Assertion | Frozen sitch | Milestone |
|---|---|---|---|---|
| 1 camera-nav | `JetLOS` heading/vFOV/pos across frames; track-to-track aim; `getCameraLLA`; (M3) PTZ/point/lock drives | value + assert wiring | gofast, aguadilla, custom, pvs14 | M1/M3 |
| 2 nightsky-sat | TLE propagation; filter counts; `toSun`/sun-moon RA·Dec; star catalog; (M3) RA·Dec lock | value (count EXACT) | pvs14 (bundled TLE) | M1/M3 |
| 3 tracks | `Track_<sn>.getValue().lla[]`; interpolation; manifest; **palette `colorData_`** (frozen-fixture or built-in); MSL-vs-HAE | value | built-in multi-track / frozen potomac fixture | M1/M3 |
| 4 synth-3d | cloud count (puff-shed guard); roof-coplanar; CRUD no-leak; object position | value (count EXACT) | gofast (create-at-load) | M2/M4 |
| 5 terrain | elevation at lat/lon; active source (fallback guard); tile-key set; splat bbox; (M3) source switch | value + local pixel (splat) | gofast, aguadilla, chilean, splat | M2/M3 |
| 6 video | `videoFrames`/`fps`; dims; PTS array; `hasRealFramePTS`; (M5) per-view + decoded pixel | value (EXACT) + local pixel | gofast, rocket-launch, beaver, truck-2 | M1/M5 |
| 7 video-analysis | motion dx/dy/conf; `fitSimilarity`; `detectRedactionRects`; auto-mask; object-tracker centroid | value via `__sitrecTest` + hooks | gofast, aguadilla, chilean (**never Gimbal**) | M6 |
| 8 export | frame-plan arithmetic; speed strings; scripted-video parse | value via `__sitrecTest` | gofast, agua (pure-fn) | M6 |
| 9 wind-physics | `CNodeWind.getValueFrame`; traverse method-switch; airspeed coupling; atmos profile | value | gofast, aguadilla, custom, chilean | M1/M3 |
| 10 views-ui | `listViews`; layout math; `setMenuValue↔getMenuValue`; notes; `hideChrome`; undo empty | value + local pixel (hideChrome) | gofast, custom, aguadilla | M3 |
| 11 save-load | `exportSitchState` shape; **`mods` fidelity**; `dirty===false`; reload-idempotence; `force:true` | value via read-only getters | custom (`?action=new`), frozen fixtures | M1/M5 |
| 12 time-celestial | frame↔ms; `setDateTime` cascade; sun/moon dir + `sunAngle`; UTC-invariance | value via `getSunMoon`/`getCameraAzEl` | pvs14 (fixed startTime) | M1/M2/M3 |

---

## 10. Worked examples (corrected)

**Hard rule applied throughout:** read `NodeMan.get(id).getValue(f).lla[0..2]` (the value is an
**array** `[lat,lon,alt]`). **Never** use `getTrackPosition` — it reads `.lla.lat/.lon/.alt` off
that array (`CSitrecAPI.js:1357`) and returns `undefined` (verified bug).

### Example 1 — `gofast-camera-los` (camera-nav, value, network:'none')
- snapshot ptz `{az,el,fov}` (auto-restored at end).
- `assert wiring` — `{look:ViewMan.get('lookView').cameraNode.id, main:…}` equals
  `{look:'lookCamera', main:'mainCamera'}`.
- for f in `[0,10,60]`: `setFrame` then `capture los@f` =
  `{node:'JetLOS', method:'getValue', frame:f}` picking `heading.{x,y,z}` (tol 1e-6 — the
  AZELISSUE sign-flip catcher), `vFOV` (1e-4), `position.{x,y,z}` (ecef 1e-3).
- `apiCall getCameraLLA` (awaited) → `capture cameraLLA` (lat/lon 1e-6, alt 1e-3). No pixels.

### Example 2 — `potomac-tracks` (tracks, value)
- `apiCall listTracks` → `capture trackInventory` sorted by `trackID` (catches missing/renamed/
  ID-drift).
- per track shortName: `capture color_<sn>` = `{r,g,b}` of `colorData_<sn>` — **the palette
  async-order flake**, caught *every* run.  *(Re-home onto a built-in/frozen-fixture multi-track
  sitch so the JSON is committable — §4.)*
- `capture pos@10` = `Track_<sn>.getValue(10)` picking `lla.0/lla.1/lla.2`.

### Example 3 — `pvs14-sat-celestial` (satellites, value, network:'none')
- `settle frame:10` (so NightSky `update()` ran).
- `capture toSun` (unit vec, 1e-6 — refraction/GMST regression); `capture sunMoonRaDec`.
- `apiCall satellitesHideStarlink` → `capture visCountHidden` (count EXACT) →
  `apiCall satellitesShowStarlink` (restore).
- `capture starCatalog` = `{count:getStarCount(), maxMag:getMaxMagnitude()}` (EXACT).

### Example 4 — `synth-cloud-determinism` (synth, value, isolated)
- `apiCall createSynthClouds {lat:Sit.lat, lon:Sit.lon, …, seed:42}` (anchored to the sitch).
- `capture cloudCount` = `getSynthInternals({type:'clouds',id})` — count EXACT (the 2.78.1
  seedrandom puff-shed guard).
- `assert lossless` — `instanceCount===cloudCount` (from pre-captured values, async-safe).
- teardown: `deleteSynthElement`. Scenario `isolated:true`; never saves.

### Example 5 — `gofast-video-pts` + `export-frameplan-pure` (video / export, value)
- `capture timeline` = `{frames:Sit.videoFrames, fps:Sit.fps}` (EXACT); `capture dims`
  (`videoMaxSize` downscale); `capture pts` = `[0,5,10,20].map(getFrameTimeMs)` (PTS desync that
  pixels never catch); `capture hasRealPTS`; `capture settleReady`.
- pure-fn: `capture plan` = `window.__sitrecTest.createVideoExportFramePlan({…pingPong,loops,
  maxOutputFps})` → `totalFrames/fps/frameStep` EXACT + `frameAt[]`.

### Example 6 — `custom-serial-roundtrip` (save-load, value, network:'fixture')
- `apiCall exportSitchState` → `capture state1`.
- `assert shapeValid` (from captured state: `isASitchFile===true && stringified===true`).
- `capture mods` sorted by node id, volatile stripped — **the highest-value serialization
  baseline**.
- `capture sitchState` = `getSitchState` (assert `dirty===false` on clean load).
- idempotence: reload bytes via `page.route` sentinel `?custom=`, re-export `state2`,
  `assert idempotent` (deepEqual minus volatile). **No server write; save APIs hard-blocked.**

---

## 11. Corrections applied from adversarial review

All four reviews returned **sound-with-fixes** (architecture validated; no "unsound"). The
following concrete fixes are folded into this plan:

- **C1** Server-write block was decorative — real path is `rehost.php` + S3 `PUT` +
  `getsitches.php?get=myfiles`. → default-deny on write + drop save APIs from vocabulary + entry
  shim (§6.5).
- **C2** localStorage/IndexedDB are profile-scoped — fresh page does not isolate. → per-key
  snapshot/restore or ephemeral profile (§6.2).
- **C3** `this.api` is a static literal; `this.debug` is runtime-mutable. → gate getters on real
  `isLocal` via post-literal `Object.assign`, not `this.debug` (§5).
- **C7** MCP `safeSerialize` (type-tag + truncation) ≠ `page.evaluate`. → mandatory plain-object
  projection in every read + shared normalizer (§7).
- **C8** `buildLoadUrl` only emits `custom=`. → add `?sitch=` branch for built-ins (§5.1).
- **C9** Committable baselines from server-saved sitches rot. → frozen inputs only (built-in or
  committed fixture) (§4).
- **C10** `sitrecAPI.call` is async — synchronous `.result` reads were broken. → await in
  `apiCall`, read pre-captured values in asserts (§7).
- **C11** Tolerance-by-key-path is fragile. → explicit `tol` required when no tier matches;
  normalizer warns on fall-through, never silently picks (§3.4).
- **C15** `getTrackPosition.lla` is broken. → read `getValue(f).lla[0..2]` directly (§10).
- **C16** `launchOpts` is a local const, not exportable. → hoist to `buildLaunchOpts(CONFIG)` (§5.1).
- **Hardening** `window.toggleMotionAnalysis`/`getMotionAnalyzerForTesting` ship ungated to
  production today (`index.js:1542-1543`) — fix regardless (§5.7).

### Open questions (carry into implementation)
1. `GlobalDateTimeNode` id is **`dateTimeStart`** (lowercase, verified `index.js:2082`) — discover
   via `NodeMan.iterate` for `constructor.name==='CNodeDateTime'` or the `getSunMoon` getter;
   never hardcode a guessed id.
2. No built-in Regression sitch ships synthetic buildings/clouds/overlays → create-at-load path
   (anchored coords). A frozen-fixture synth sitch would be needed only if a saved-state path is
   preferred.
3. Multi-video (`selectVideo`) and `CVideoPatchedData` (dropped-frame hold) have no confirmed
   fixture → commit a small `twovid` fixture + a known-dropped-frame clip, or leave those two
   behaviors uncovered in M5 (do **not** mark them covered — the original matrix overclaimed).
4. The undo/redo round-trip needs a confirmed deterministic undoable op; until then only the
   empty-stack/no-op path is safe (M3).
5. Optimizer determinism (`fitPhysicsModel` Nelder-Mead, `estimateWindFromConstantAirspeed` GA,
   `CNodeControllerCameraShake`) is unseeded-RNG → **excluded** from value baselines until a
   seeded test-only RNG hook (gated like `window.shf`) exists.
6. `network:'none'` scenarios must assert no live request actually fired (a sitch could lazily
   fetch even with bundled data present).

---

## 12. Acceptance criteria

- **Determinism:** `node run-scenarios.mjs` is green twice in a row, and on a second machine for
  the committed value baselines (pixels remain local-only).
- **No side effects:** after a full run, the regression user's saved versions are unchanged; the
  `.chrome-profile/` localStorage/IndexedDB is unchanged (or restored); no `PUT`/`rehost.php`/
  `getsitches.php?get=myfiles` request was issued (assert in the runner).
- **No production leak:** a production build (`www.metabunk.org`) exposes none of the new getters
  / `window.__sitrecTest` / motion hooks (covered by `auditBundleSecrets`-style check or a unit
  test asserting the gate).
- **Speed:** value-tier scenarios add assertions at near-zero marginal cost (no screenshot) on
  the existing warm cache; a full value pass over the built-in set stays in the tens of seconds.
- **Extensibility:** adding a new test = drop a `<slug>.scenario.mjs` in `scenarios/<area>/` and
  run `--update-values` once; no core-harness edit.

---

## 13. M1 — Implemented (custom-sitch focus)

M1 is built and **green twice** (deterministic), reoriented per direction toward the
**custom-sitch create/use workflow** rather than legacy built-in sitches.

**Files delivered:**
- `run.mjs` — refactored behavior-neutral: internals exported, `launchOpts` hoisted to
  `buildLaunchOpts()`, `buildLoadUrl` gained a `?sitch=` (built-in) branch + `sitch.frame`
  honoring, `main()` guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`.
  The existing 38-sitch pixel suite still enumerates and runs unchanged.
- `stepRunner.mjs` — canonical normalizer + tolerance tiers (abs-diff compare, rounded store) +
  `lintScenario` (forbidden/mutating-fn gating) + driver-agnostic `executeSteps`. 22 pure-fn
  unit tests pass.
- `run-scenarios.mjs` — sibling runner; imports run.mjs internals; fresh page per scenario in
  one warm persistent context; startup-safe network guards; compares/writes value baselines.
- `scenarios/custom/` — eight scenarios covering the custom-sitch create/use/edit/persist
  workflow, all loading the blank `custom` sitch, `isolated:true`, never saved → zero side
  effects. ~37s for the suite, warm, concurrency 3; green on back-to-back runs:
  - `custom-create-object` — `addObjectAtLLA` → track count 0→1, `dirty:true`.
  - `custom-create-synth` — `createSynthBuilding`/`createSynthClouds` → building `cornerLatLons`
    geometry to 6dp + synth inventory.
  - `custom-synth-crud` — create→update→delete → count 0→1→0 (no leak), `roofAGL` 5→9 applied.
  - `custom-object-edit` — `setAllObjectsGeometry`/`Dimensions` → all 3 objects boxed/resized
    (stable summary; the created object's folder is `syntheticObject_<n>`, deliberately not baselined).
  - `custom-camera-use` — `gotoLLA`/`setCameraAltitude` → `getCameraLLA` reads the move back exactly.
  - `custom-serialize-after-create` — `exportSitchState` `modsCount` 229→241 proves the created
    object lands in the serialized node-graph.
  - `custom-time-frames` — `setDateTime` fidelity (single deterministic UTC isoString).
  - `custom-undo-redo` — undo/redo around a create → count `0→1→0→1` (regression guard for the
    object-creation undo fix below).
  - `custom-serialize-after-create` asserts the serialization INVARIANT (mods grow by ≥10), not
    an exact node count — object creation spins up ~12 sub-nodes asynchronously, so the precise
    count is timing-sensitive (±1). Lesson: value baselines should assert invariants, not transient
    async counts.

  **A bug the scenarios surfaced and we FIXED:** `addObjectAtLLA` (and the "Add Object" menu) was
  **not undoable** — both route through `CustomManager.createObjectFromInput`, which pushed no
  undo action (unlike synth buildings/clouds/overlays). Fixed by extracting a testable
  `makeCreateObjectUndoAction` (`src/undoCreateObject.js`) and registering it in
  `createObjectFromInput`: undo removes the object node + synthetic track, redo recreates (mutable
  id closure handles redo-then-undo). Covered by `tests/createObjectUndo.test.js` (7 unit tests)
  AND the `custom-undo-redo` scenario. Resolves the plan's open question #4.

  **One finding still documented (not yet actionable):** `getCurrentSimTime` does **not** re-derive
  from a forced `setFrame` in regression mode — it reflects the loaded frame's offset — so a true
  per-frame temporal assertion needs a frame-indexed node read (deferred).
- `value-baseline/*.json` committed; `baseline/` (PNG) + `output/` + `.chrome-profile/` ignored.
- npm scripts `test-scenarios`, `test-scenarios-update`, `test-scenarios-list`.

**One app change (gated, pre-authorized "extend the API as needed"):** `src/index.js` now does
`if (isLocal) window.sitrecAPI = sitrecAPI;`. Production (`www.metabunk.org`, `isLocal` false) is
byte-for-byte unchanged.

**Three runtime discoveries the planning agents could not have known (all verified live):**
1. **`window.sitrecAPI` was absent under `?regression=1`.** It is only ever set as a side effect
   of the chat view loading (`CNodeVIewChat → CClientNLU → CSitrecAPI`), which regression mode
   skips. Hence the gated `index.js` exposure above — which also fixes the MCP bridge in
   regression mode.
2. **`sitrecAPI.call()` returns an ENVELOPE** `{success, fn, result}` (`CSitrecAPI.js:2750`), not
   the bare value. `stepRunner.apiCallExpr` unwraps `.result` and throws on `success:false`.
3. **`rehost.php` is dual-purpose:** `?getuser=1` is a startup user-identity READ (blocking it
   kills app init — NodeMan never builds), while `?action=…` is the WRITE that precedes S3 PUTs.
   The network guard blocks only `rehost.php?…action=…`, never `getuser`. (Corrects review item
   C1, which had the block too broad.)

**Determinism guard added in practice:** synthetic track ids are `syntheticTrack_<epochMs>`
(wall-clock) — scenarios project to stable fields (count + menuText), never the raw id.

**Next:** M2 (isLocal-gated read-only getters: `getCameraOrientation`, `getTerrainElevation`,
`getSynthInternals`, `getSunMoon`) to deepen custom-content assertions (e.g. cloud puff-count
determinism, building roof-coplanarity), still within the custom-sitch authoring focus.
```
