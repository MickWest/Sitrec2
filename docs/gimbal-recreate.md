# Recreating Gimbal from Drag-and-Drop + UI

Turn a blank custom sitch into a Gimbal analysis scene without editing any JS.
Two paths: one-click preset (fastest) or piece-by-piece manual build (understand each part).

## Path A — One-click preset

1. Open Sitrec with the base custom sitch (`/?sitch=custom`, or the "Custom (Drag and Drop)" menu entry).
2. Open **Physics > Gimbal Analysis**.
3. (Optional) Tweak parameters. Only Cloud Wind From / Cloud Wind Knots,
   Show Glare and Show ATFLIR Pod live in the Gimbal Analysis menu;
   target/local wind are at the top of the Physics menu, and start distance /
   target speed / traverse mode are in the Traverse menu.
4. Click **>> Create Gimbal Sitch**.

The page reloads into a fresh sitch with:
- Jet track at 28.5 N, -79.5 W, 25000 ft (Gimbal defaults)
- Az/El/bank/glare switches fed from the built-in Gimbal CSVs
- Clouds, winds (cloud/target/local), traverse switch
- SA Page with target + 5-ship fleet HAFUs
- ATFLIR pod + HUD overlays
- Acceleration / speed / altitude / tail-angle graphs
- Target model (FA-18F) on the traverse path
- Video + mirror video views (empty until you drop a file)

## Path B — Manual build (piece-by-piece)

1. Open Sitrec with the base custom sitch.
2. Open **Physics > Gimbal Analysis**.
3. Click **>> Create Gimbal Base (manual build)**.
   - Creates a sitch with the jet origin, altitude, terrain, camera, views,
     Gimbal CSVs and FA-18F/ATFLIR models already loaded — but **no pipeline nodes**.
   - The sitch saves an empty `gimbalSetup.pipeline` so each step you add
     later gets remembered across save/reload.
4. In the same folder, open the **Manual Build** sub-folder and click each
   step button in order. Each button runs that piece live (no reload) and
   flips the corresponding flag in `gimbalSetup.pipeline`.

Recommended order (later steps assume earlier ones are done):

| Button | What it adds | Needs |
| --- | --- | --- |
| Core (az/el/bank/winds/jetTrack/SAPage) | CSV parse + az/el/bank/glare switches, cloud/target/local winds, turn-rate, `jetTrack`, `SAPage`, `JetLOS` | `jetOrigin`, `jetAltitude` (from the base) |
| Traverse Nodes | Straight-line / const-ground / const-air / const-air-AB / const-altitude traversals + `LOSTraverseSelect` | Core |
| Air Track (target airspeed) | `airTrack` (target motion relative to wind) | Traverse + Core (`targetWind`) |
| Track LOS Display Nodes | JetLOS and jetTrack display tracks | Core + Traverse |
| Clouds | Cloud geometry + `LOSHorizonTrack` | Core |
| Fleet (5-ship) | 5 fleeter nodes + displays (and SA HAFUs if SA Page is up) | Traverse |
| Jet Views (chart + ATFLIR pod) | Speed/altitude/tail-angle/distance/size graphs, `chart` view, dragMesh, ATFLIR display pod, LocalFrame layer (via `initViews`) | Traverse (click after Fleet to include fleet speed sub-graph) |
| Fleet HAFUs on SA Page | Hostile + friendly HAFUs for target + fleet | SA Page + Fleet + Traverse |
| Gimbal Graphs | Cloud-speed overlay, Az editor overlays, acceleration graph | Core + Traverse |
| Target Model (FA-18F) | `targetModel` + `targetSphere` on traverse path | Traverse + Air Track + `targetWind` |
| Air Track Display | Cyan track for `airTrack` (toggled by SA-page wind button) | Air Track |

Prerequisite checks run on click — if a dependency is missing, the button
pops a "Step failed / missing X" error instead of breaking the scene, so it's
safe to click them in the wrong order. The step also remembers which buttons
you've pressed, so saving the sitch and reloading reproduces the same partial
pipeline.

Individual view/pod toggles still live alongside these steps:
- **Show > Views > SA Page** — toggles the SA page view.
- **Physics > Gimbal Analysis > Add ATFLIR Pod (reload)** — enables the pod + HUD overlays.
  This button only appears on the plain base custom sitch (before any gimbal
  sitch is created, when neither `Sit.showATFLIR` nor `Sit.jetStuff` is set).
  Once you've created a gimbal sitch (`jetStuff` is set), the pod comes in via
  the "Jet Views (chart + ATFLIR pod)" manual-build step / "Show ATFLIR Pod"
  toggle instead.

## Adding the Gimbal video

Drop the Gimbal MP4 anywhere on the page **either before or after** creating
the Gimbal sitch (whichever path). Both work:
- **Drop before:** the preset rehosts the video and bakes the URL into the
  generated sitch so reload keeps it.
- **Drop after:** the new sitch already has a video view, so the drop lands
  in it directly.

Note: the server's PHP upload limits (`upload_max_filesize`, `post_max_size`)
must cover the video size. If the pre-click rehost fails due to size, the
preset silently skips carry-over — drop the video again after reload and
it'll work through the normal drop path.

## Working on an existing Gimbal sitch

Once `gimbalSetup` is active, the **Create Gimbal Sitch** button is replaced
by **Apply Parameter Changes**. Edit the cloud-wind / glare knobs in this
menu (target/local wind are at the top of the Physics menu; start distance /
target speed / traverse mode are in the Traverse menu), click that button, and
the sitch resaves and reloads with the new values. The Manual Build sub-folder
is also shown here so you can add any pipeline steps that weren't activated yet.

## What's different vs. built-in `gimbal`

- `targetSize` defaults to 1 ft (the CSituation default; the `?? 56` fallback in `setupTargetModel` never fires because `situationDefaults` always sets `targetSize: 1`). Built-in Gimbal Far resolves to the same 1 ft default — it doesn't set `targetSize` either.
- Target model is FA-18F (same as built-in Gimbal Far); no SR-71 / saucer variants.
- `cameraFrustumATFLIR` and overlays use property-based checks
  (`Sit.showATFLIR`, `Sit.showGimbalCharts`, `Sit.showGimbalDragMesh`), set by `gimbalSetup`.

## How the persistence works

- `Sit.gimbalSetup.pipeline` is an object whose keys are step names
  (`core`, `traverse`, `airTrack`, `trackLOS`, `clouds`, `fleet`,
  `commonViews`, `saHAFU`, `graphs`, `targetModel`, `airTrackDisplay`).
  A truthy value means "run this step on load."
- When `pipeline` is **absent** (the Path A preset), every step runs — the
  legacy behaviour.
- When `pipeline` is **present** (Path B or any saved piece-by-piece sitch),
  only flagged steps run during `handleGimbalSetup` at sitch load.
- Each Manual Build button live-applies its step AND flips its flag, so the
  next save reproduces the exact state on reload.
- Every step clears the nodes it's about to (re)create before running, so
  clicking a button twice is safe — useful for retrying after tweaking
  a wind knob or fleet offset.

## Why partial pipelines don't crash

Several downstream modules were hardened so the scene stays alive in
intermediate states (e.g. after Core but before Traverse):

- `JetStuff.CommonJetStuff` — defers if `LOSTraverseSelect` absent; idempotent
  on re-entry via the `chart` existence check.
- `JetStuff.initJetStuff` preRenderFunction — bails if `SAPage`/winds/
  `jetTrack`/`LOSTraverseSelect` are not yet created, instead of dereferencing
  nulls every frame.
- `JetGraphs.AddSpeedGraph` — skips the fleet speed sub-graph unless
  `fleeter01` exists.
- `CNodeATFLIRUI.renderCanvas` — skips the bank overlay until `bank` exists.
- `CNodeGUIValue.recalculate` — skips linked `setValue()` when the target was
  swapped to a kind without `setValue` (e.g. Core replaces the GUIValue
  `turnRate` with a `CNodeSwitch`, leaving the base-sitch `totalTurn`
  GUIValue still linked at it).
