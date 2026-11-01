# Recreating Gimbal from Drag-and-Drop + UI

Gimbal is a US Navy targeting-pod video of an unidentified object. This page shows how to
rebuild its scene in a custom sitch with menu buttons, without editing any code. It is a build
guide. It does not analyze the video and does not say what the object was. For what
line-of-sight geometry can and cannot show, see
[The Ideas Behind the Traverse Analysis](TraverseConcepts.md).

Two paths: one-click preset (fastest) or piece-by-piece manual build (understand each part).
Both Create buttons upload the new sitch to the server, so log in first.

> **Known limit:** In the current version, a sitch made with either Create button does not
> finish loading. The load stops with no error message, and the Gimbal scene and its menu
> items do not appear. You cannot complete either path until this is fixed. The rest of this
> page describes what the buttons are designed to do.

Terms: **ATFLIR** is the targeting pod camera on the jet. The **SA Page** is the pilot's
Situational Awareness display. A **HAFU** is a symbol on that display (Hostile, Ambiguous,
Friendly, Unknown). The [Glossary](Glossary.md) defines line of sight (LOS), azimuth (az),
elevation (el) and traverse.

## Path A — One-click preset

1. Open Sitrec with the base custom sitch (`/?sitch=custom`, or the "Custom (Drag and Drop)" menu entry).
2. Open **Physics → Scenarios → Gimbal Analysis**. (The Gimbal Analysis
   items appear when you first open the Scenarios folder.)
3. (Optional) Set the parameters. Cloud Wind From, Cloud Wind Knots and Show Glare
   are in this folder. Target and local wind are in **Physics → Wind**. Tgt Start Dist
   and Target Speed are in the **Traverse** menu. The new sitch copies these values,
   so set them before you click. To match the built-in sitch, use the values in
   "What's different" below.
4. Click **>> Create Gimbal Sitch**.

The page reloads into a fresh sitch with:
- Jet track at 28.5 N, 79.5 W, 25000 ft (Gimbal defaults)
- Az, bank and glare switches fed from the built-in Gimbal CSVs, plus an elevation
  ramp (el Start and el Rise sliders)
- Clouds, winds (cloud/target/local), traverse switch, set to Constant Air Speed
  (change LOS Traverse Method in the Traverse menu after the sitch loads)
- SA Page with HAFUs for the target and a fleet of five objects
- ATFLIR pod + HUD overlays
- Acceleration / speed / altitude / tail-angle graphs
- Target model (FA-18F) on the traverse path
- Video + mirror video views (empty until you drop a file)

These are defaults for building the scene. The FA-18F is a display model for the target. The
five fleet objects and all the HAFUs are display objects. None of them says what the object was.

![The Path A scene in Sitrec with no video loaded. Top left, a large graph titled Object g-force with black, green and red curves and pink vertical bands. Across the top, six small graphs: Traverse Distance NM, Apparent Size %, Traverse Speed Knots, Traverse Altitude, Fleet Speed Knots and Tail Angle. Bottom left, the black SA Page with a compass ring. In the center, the main view above a yellow grid and gray clouds: a dark teal fan runs from a cyan curve at the lower right to the upper left, with a long green line along it and yellow arcs beside it. At the lower right, a gray cloud image with thin white and yellow HUD text that includes NAR CAM, and beside it a black area labeled ORIGINAL VIDEO](docimages/gimbal-recreate-path-a-scene.jpg)

**The Path A scene, as designed.** Because of the known limit above, this picture comes from a
copy of the generated sitch with a different name. It uses the Gimbal (Far) values from "What's
different" below, and no video. In the main view, the cyan curve is the jet track and the dark
teal fan shows the lines of sight over the whole clip. The long green line is a distance
measurement from the jet to the traverse path, which is the short green stroke at its far end.
The short blue line beside that stroke is the air track. The two vertical green arrows are
altitude measurements at the jet and at the target. The numbers for these measurements do not
show in this picture. The dark green arrow at the jet is the initial heading. The white broken
line continues the line of sight past the traverse path. The yellow arcs are the fleet tracks,
the gray patches are the clouds, and the yellow grid is a ground grid. The pink bands on the
**Object g-force** and **Traverse Speed Knots** graphs mark fixed frame ranges. At the lower right, the look view shows the view from the ATFLIR
pod with the HUD overlay. The black area beside it is the video view, labeled ORIGINAL VIDEO.

## Path B — Manual build (piece-by-piece)

1. Open Sitrec with the base custom sitch.
2. Open **Physics → Scenarios → Gimbal Analysis**.
3. Click **>> Create Gimbal Base (manual build)**. This creates a sitch with the jet
   origin, altitude, terrain, camera, views, Gimbal CSVs and FA-18F/ATFLIR models
   already loaded, but with none of the steps below.
4. In the same folder, open the **Manual Build** sub-folder and click each
   step button in order. Each button runs that piece live (no reload) and
   records the step in the sitch.

Recommended order (later steps assume earlier ones are done):

| Button | What it adds | Needs |
| --- | --- | --- |
| Core (az/el/bank/winds/jetTrack/SAPage) | CSV parse + az/bank/glare switches, elevation ramp, cloud/target/local winds, turn-rate, jet track, SA Page, line of sight from the jet | Base sitch |
| Traverse Nodes | Straight-line / const-ground / const-air / const-air-AB / const-altitude traverses + the traverse switch | Core |
| Air Track (target airspeed) | Target motion relative to the target wind | Core + Traverse |
| Track LOS Display Nodes | Line-of-sight, jet track and traverse display tracks | Core + Traverse |
| Clouds | Cloud geometry + horizon track | Core |
| Fleet (5-ship) | Five fleet objects, their display tracks and their HAFUs on the SA Page | Traverse |
| Jet Views (chart + ATFLIR pod) | Speed, altitude, tail-angle, distance and size graphs, chart view, ATFLIR pod | Traverse (click after Fleet to include the fleet speed graph) |
| Fleet HAFUs on SA Page | HAFUs for target + fleet. Skip this button in this order: Fleet already added them, and a click adds a second set | Core + Traverse + Fleet |
| Gimbal Graphs | Cloud-speed overlay, Az editor overlays, acceleration graph | Core + Traverse + Clouds |
| Target Model (FA-18F) | Target model + target sphere on the traverse path | Core + Traverse + Air Track |
| Air Track Display | Blue track for the air track | Air Track |

Most buttons check their prerequisites on click. If a step is missing, the button pops an
error such as "Traverse needs Core first (missing: JetLOS)" and the scene does not change.
Follow the order in the table: a few wrong orders still give an error or leave a graph out.

**Show → Views → SA Page** toggles the SA Page view.

![The SA Page: a black display with a dashed green ring and white compass numbers. Green words at the corners and edges read MAP, SCL/20, DCNTR, N-UP and WIND. A green cross is at the center. Near the W mark is a small diamond, and between it and the center are five small overlapping circles. At the lower left, the main view's compass overlaps the display, with the reading 271.6° and an N needle](docimages/gimbal-recreate-sa-page.jpg)

**The SA Page in the same scene.** The green cross at the center is the jet. The diamond near W is
the HAFU for the target, and the five circles are the HAFUs for the fleet. The diamond is on the
circle of compass numbers, just outside the dashed ring, because the target is 32 NM away and
the display scale is 20 NM (SCL/20). Sitrec holds a HAFU on that circle when it is out of range.
The **WIND** button at the lower right adds wind arrows here and in the main view. The number,
the green mark, the N needle and the small text at the lower left are not part of the SA Page.
They are the compass of the main view, which draws over this corner.

## Adding the Gimbal video

You need your own copy of the Gimbal MP4. The built-in Gimbal sitches use a 428x428 crop. The
scene runs for 1031 frames at 29.97 fps and the Gimbal data follows those frames, so use the
same cut.

Drop the video anywhere on the page before or after creating the Gimbal sitch:
- **Drop before (Path A only):** **>> Create Gimbal Sitch** uploads the video to the
  server and adds it to the generated sitch, so a reload keeps it. The Path B
  button (**>> Create Gimbal Base (manual build)**) does not carry the video
  over, so for Path B drop the video after the base sitch has loaded.
- **Drop after (either path):** the new sitch already has a video view, so the
  drop lands in it directly.

The server's upload size limit must cover the video. If the upload fails, Sitrec shows an
error and does not create the sitch. Reload the base sitch, click **>> Create Gimbal Sitch**
with no video, then drop the video into the new sitch. If the new sitch opens with no video,
drop the video into it.

## Working on an existing Gimbal sitch

On a Gimbal sitch, the Create buttons are replaced by **Apply Parameter Changes**.

To change wind, use Cloud Wind From, Cloud Wind Knots, Target Wind From, Target Wind Knots,
Local Wind From and Local Wind Knots at the top level of the **Physics** menu. These change
the scene at once. Tgt Start Dist, Target Speed and LOS Traverse Method are in the
**Traverse** menu.

Use **Apply Parameter Changes** for Show Glare: it saves the sitch and reloads it with the
new value.

The Manual Build sub-folder is also shown here. Use it only on a sitch made with Path B, to
add steps that you have not run. A Path A sitch has already run every step, and a click there
makes the next load run only the clicked steps.

## What's different vs. built-in `gimbal`

Both Create buttons take target wind, local wind, Tgt Start Dist and Target Speed from the
sitch you start from. A new sitch does not match the built-in Gimbal (Far) sitch unless you
set these values first:

| Setting | Fresh base sitch | Gimbal (Far) |
| --- | --- | --- |
| Target wind | 277° at 0 kt | 274° at 65 kt |
| Local wind | 285° at 70 kt | 270° at 120 kt |
| Tgt Start Dist | 1 NM | 32 NM |
| Target Speed | 320 kt | 340 kt |

The target is the FA-18F at 1 ft, as in Gimbal (Far). The SR-71 and saucer variants are not
available.

## How the persistence works

Each Manual Build button records its step in the sitch. When you save the sitch, a reload runs
the recorded steps. Jet Views also return on reload once Traverse is recorded, even if you did
not click that button, and the SA Page HAFUs return with Fleet. A Path A sitch records no
steps, so it runs every step on load.

Click each button once. A second click can break graphs that still read the old nodes. If that
happens, reload the sitch. To change wind or fleet values, use their sliders (the fleet sliders
are in the **Effects** menu). Do not click the step again.
