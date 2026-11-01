# Scripted Camera Moves

Sitrec can drive a **cinematic camera from a text script**: place the camera, zoom in on an
object, orbit it, track it, change the lens, cut between views, fade panels, change menu
settings, and overlay on-screen captions — all on the script's own timeline, independent of
the timeline in the [playback bar](TimeAndSync.md#the-playback-bar). The result can be previewed
live and rendered out to a **1080P60 MP4**.

You'll find it under **Video → Scripting**:

- **Scripting Window…** opens the editor (a floating, draggable, resizable panel; its ⧉ header
  icon pops it out into a separate browser window so you can drag it to another monitor).
- **Render Video (1080P60)** renders the active script to an MP4.
- **Render Quality** holds the render knobs (see [Rendering](#rendering)).

All your scripts travel **with the saved custom sitch**, so a shared or reloaded sitch carries
its scripts.

## Quick start

This example runs in a new custom sitch, with no track or video loaded. `object` is the traverse
object, the object that follows the [traverse](Glossary.md). The **look camera** is the simulated
camera of the [look view](Glossary.md). With a video, it is the camera that filmed the video, so
this page also calls it the witness camera. To use your own subject, see [Targets](#targets).

```text
# Overview from the south, drop to the witness, then zoom in on the object
view main

# 1. high, wide establishing shot from the south
from object 0 180 11000 24
& text "Overview" 4
orbit object 6 -10            # slow drift for life
linger 1

# 2. drop in to the witness POV (matches the video)
flyto look 5
& text "The witness, by the building" 4
linger 2

# 3. zoom in on the object
zoom object 6 1500
& text "The object" 4
linger 1
```

1. Open **Video → Scripting → Scripting Window…** and replace the demo script with your own.
2. It parses on every keystroke, so you do not need to press **Parse**. The **timeline** below the
   editor shows labelled blocks. The status line under the script text shows the first error or
   warning. A red wavy underline marks a line with an error, and an amber one marks a line with a
   warning.
3. Press **Preview** in the editor toolbar to play the script. Press **Stop** to end the preview.
   **Space** pauses and resumes a preview when the keyboard focus is outside the script text. In
   the script text, space types a space.
4. When happy, **Render Video (1080P60)**, or press **Render** in the toolbar.

![The Scripting window. Two tabs, Overview and Flythrough, sit above the buttons Parse, Preview, Stop, Render, Insert and Capture. Below the buttons is the Quick start script, then a status line that reads "Ready — 21.0s, 7 beats", then a timeline of colored blocks in two rows](docimages/scripted-video-window.jpg)

The Scripting window with the script above. From the top: the [tabs](#multiple-scripts-tabs), the
toolbar, the script text, the status line and the timeline. The color of a block shows its command.
The status line gives the script length and the number of shots, which it calls beats. Bold text
marks the line with the cursor. Here the pointer rests on the `5` in `flyto look 5`: a yellow box
marks the number, and a yellow edge marks the block of that line.

Click a line to **scrub** the viewport to that moment. Clicking a block on the timeline also
scrubs, unless it is a `&` block or you click its right edge: those start a drag edit. A scrub
starts a paused preview, which locks the main view and replaces the playback bar until you press
**Stop**. The **Insert** button opens a form that adds one command line.

![A paused preview. The main view fills the page and shows an island and a far coast, with the white caption "The object" low in the center. A thin green line runs down the center of the view, with a dot and an arrow at the middle, and a label near the bottom reads 16404 ft msl. The Scripting window shows the status line "Preview paused at 17.0s (space to play)" and two script lines in yellow. At the bottom of the page, a strip of thin colored bars with a yellow playhead takes the place of the playback bar](docimages/scripted-video-preview.jpg)

The same script in a preview paused at 17.0 s of 21.0 s. The white text is the caption from
`& text "The object" 4`. Yellow text in the editor marks the lines that are active at the playhead.
The strip at the bottom of the page holds the same blocks as the timeline. The traverse object is at
the center of the view, at the tip of the green arrow. The camera is still far from it, so the
object is too small to see here. The green lines are measurements from **Show → Measurements**: the
line below the object gives its altitude, with the label `16404 ft msl`. The line above the object,
with the green dot at its end, is the distance measurement from the look camera to the object. The
main camera is on that line, and the label of the line is behind the main camera, out of view. The
cyan lines are edges of the look camera's field of view.

The sitch's own playhead advances linearly across the whole scripted duration, from the
sitch's **In** frame to its **Out** frame, so the world (an aircraft flying its
track, a satellite moving, the sun setting) animates *while* the camera moves. In and Out mark the
part of the sitch that plays. Set them with the `I` and `O`
[keys](TimeAndSync.md#keys-for-time-and-frames). By default they are the first and last frames.
To control which moment of the world each shot shows, see [World time](#world-time).

## Author by flying (Capture)

Instead of typing and guessing camera numbers, **fly the main view to the shot you want and
click "Capture"** in the editor toolbar. It inserts a `moveto lat,lon,alt secs lat,lon,alt`
line that reproduces that exact camera position and aim. The new line goes below the selected
event or the cursor line. It does not record the [FOV](Glossary.md), so add a `fov` line if the
shot needs one.

A preview locks the main view, and a click in the script text starts a paused preview. So click
the line first, press **Stop**, then fly the view and click **Capture**.

Tweak the `secs` to set how long the move there takes. To make the shot relative to a target,
write a new `from`, `zoom` or `orbit` line, for example `from object 3 180 3000 20`. These commands
take other arguments, so a change to the command word alone gives a parse error.

## Abbreviations (flat one-line shortcuts)

For linear shot lists you don't need JS punctuation. A line that looks like a classic flat
command is rewritten into the equivalent JS before it runs. Raw JS lines pass through
untouched, so you can **mix both styles freely**. On this page, a **flat line** is the one-line form
of a command, and a **shot** is one camera command.

| Flat line | Becomes | Meaning |
| --- | --- | --- |
| `zoom traverseObject 9 900` | `__sp = zoom("traverseObject", 9, 900); await __sp;` | a **plain line is sequential**: the next line starts when it ends |
| `& text "Overview" 5` | `atStart(__sp, 0, () => text("Overview", 5))` | **`&` runs concurrently**, starting WITH the previous plain line |
| `&2 text "cap" 4` | `atStart(__sp, 2, () => text("cap", 4))` | **`&N`** starts `N` seconds after the previous plain line's start |
| `# comment` | `// comment` | comment |

Rules:

- **Multi-word captions need quotes**: `text "tracking inbound" 4`.
- **Bare words are auto-quoted**, so targets and option names need no quotes:
  `zoom traverseObject 9` , `show "Constellation Lines"` (quote if it has spaces).
- A **`&` line attaches to the most recent plain flat line**, at *that line's* start. A raw JS line
  such as `await zoom("A", 4);` does not count. To put a caption over a move, write the `&` line
  **after** the move:

  ```text
  zoom traverseObject 9 900
  & text "Zooming in" 5      # caption appears as the zoom begins
  ```

- **Assume-last target**: if you omit a target where a number appears, the most recent target
  is reused — `zoom traverseObject 5` then `orbit 6 180` orbits `traverseObject`.
- A **trailing `#` comment** works only on a flat line. On a raw JS line, use `//`.
- Most numbers on flat lines (durations, distances, degrees, fov, `&` offsets) are
  **scroll-wheel editable** — hover the number in the editor, and a yellow box marks it if you can
  edit it. Spin the wheel, or drag up or down (hold Shift for steps 10 times larger).

## Targets

Camera commands aim at a **target**, resolved (at the relevant frame) to a 3-D position:

- a **friendly alias** — `object` / `target` (the traverse object), `witness` / `camera` /
  `observer` (the look camera's position);
- a **track short-name** — e.g. `OE-LNC` resolves to the node `Track_OE-LNC`. A loaded track's short
  name is the name its folder has in the **Contents** menu when it loads;
- a **node id** directly — e.g. `traverseObject`, `cameraObject` (a synthetic object/camera), or a
  [walker's](#walkers-a-marker-that-moves-along-a-path) name. Sitrec also tries a name with `_ob`
  added to it; or
- a **`"lat,lon,alt"` literal** — `zoom "51.5,-0.13,1000" 6`. Altitude is optional, with a default of
  0. It is in metres [above the WGS84 ellipsoid (HAE)](GIS.md#three-kinds-of-height), not above mean
  sea level (MSL) or above ground level (AGL). Other places in Sitrec read an entered altitude
  differently: see [Coordinate formats](GIS.md#coordinate-formats).

Names such as `UFO`, `car` and `sphere3` in the examples on this page stand for targets in your own
sitch. A target that does not resolve gives a warning, and that shot holds still. `rise` and
`moveto` give no warning. `rise` still climbs. `moveto` holds still if `pos` does not resolve, and
keeps its previous aim if `lookAt` does not resolve. An object that you add from a menu does not
work as a target by its menu name: give its `"lat,lon,alt"` instead.

> **Tip:** pick the end distance relative to the object's size. A model ~356 m long needs an
> end distance around 900 m to frame nicely at FOV 30°; 200 m would overflow the frame.

## Smooth, continuous motion

Camera motion is **continuous and smooth by default** — like a drone with inertia. Each shot
starts exactly where the previous one ended, and the whole path is run through a short
temporal smoothing pass (`cameraSmoothing`, ~0.35 s) so consecutive moves *flow* into each
other instead of decelerating to a stop at every boundary. The camera is also kept at least
3 m **above the terrain**, so a low move never clips through the ground. Both apply identically
in preview and the final render. (For a hard cut, use a zero-second shot — e.g. `flyto look 0` —
or, before a `ride` or `follow`, the `cut` command. To cut the *view* rather than the camera, use
`view`.)

The first shot starts from the main camera's pose when Preview or Render starts. A preview does not
put the camera back when it stops, so the next run starts from where the last one ended. For the
same result on every run, open the script with an absolute shot, such as
`from object 0 180 3000 20`. The FOV carries over too, so put a line such as `fov 30 0` before it if
the shot needs a known FOV. A preview also leaves the sitch on the frame where it stopped. If the
look camera moves, `flyto look` then gives a different pose on the next run, so set the frame on the
playback bar's timeline before each run.

## Command reference

**Camera moves** (these consume time on the timeline and move/aim the **main** camera):

| Command | Signature | Notes |
| --- | --- | --- |
| `from` | `from(target, secs=3, bearing=180, distance=3000, elevation=20)` | **place the camera at a vantage around the target** and look at it: on compass `bearing` (0 = N, 90 = E, **180 = S**), `elevation`° above the horizon, `distance` m out. Flies there over `secs` (**0 = snap**). Use it to establish an opening/cutaway shot, e.g. `from object 0 180 11000 24` for a high overview from the south |
| `moveto` | `moveto(pos, secs=4, lookAt?)` | **move the camera to an absolute point** — `pos` and `lookAt` are each a target or a `"lat,lon,alt"` literal. Unlike `from` (relative to a target), this places the camera *exactly*: `moveto 38.72,-104.78,1850 4 object`. Without `lookAt`, the camera keeps aiming at its previous look point |
| `follow` | `follow(target, secs=6, distance=18, height=6)` | **third-person follow-cam**: trail a *moving* target (e.g. a `createWalker` marker), staying `distance` m behind its direction of motion and `height` m up, looking just ahead — swings around as the target rounds a corner |
| `ride` | `ride(target, secs=5, lookAt?, height=1.6, back=0)` | **ride ON a moving target** (driver/passenger POV): camera `height` m above it and `back` m behind its heading, looking at `lookAt` (another target or `"lat,lon,alt"`) or straight ahead along the motion when omitted. The shot `follow` can't do — move WITH one target while framing another: `ride car 4 sphere3`. The camera stays at least 3 m above the terrain, so on a ground-level target a `height` below 3 gives 3 m |
| `zoom` | `zoom(target, secs=5, dist?)` | dolly toward/away along the current line to end **distance** `dist` metres from the target (defaults to 5% of the start distance, clamped 150–700 m) |
| `orbit` | `orbit(target, secs=8, degrees=90, rise=0)` | circle the target by `degrees` around local vertical (positive degrees go counterclockwise seen from above); an optional `rise` (metres) climbs during the orbit — a **helical "fly up and around" in one shot** (no need for a concurrent rise, which would fight for the camera) |
| `track` | `track(target, secs=5)` | hold position, pan to keep the target framed |
| `rise` | `rise(target, secs=4, meters=500)` | climb straight up (local vertical) by `meters` while turning to look at the target — the "pull up to a wide shot" move |
| `fov` | `fov(degrees, secs=1)` | pure lens change (1–120°); keeps position and aim |
| `flyto` | `flyto(target="look", secs=0)` | fly the main camera to the pose of the look camera (the witness camera), including its FOV. Only `look` is supported. Sitrec reads that pose once, at the current sitch frame, when Preview or Render starts. It does not follow the look camera during the script. So `flyto look` is **the pose that matches the witness video at that frame**. `flyto look 0` snaps; `flyto look 3` swoops over 3 s |
| `wait` / `linger` | `wait(secs=1)` | hold the current pose (visible bar). `linger` is an alias |
| `cut` | `cut()` | a cut for `ride` and `follow`: the next `ride` or `follow` starts on its own pose instead of easing out of the previous one. Takes no time and moves nothing itself. Other commands still start from the previous end pose, so to cut to one of those, use a zero-second `from` or `moveto` |

**Shot markers** (attach to a shot with `&`; they take no time):

| Command | Signature | Notes |
| --- | --- | --- |
| `world` | `world(from, to?)` | the slice of world time the shot shows — `world a..b`, `world a b`, or `world a` to freeze. See [World time](#world-time) |
| `intent` | `intent(establish \| feature)` | what the shot is for: `establish` (showing where we are; a small subject is fine) or `feature` (looking at the subject). It does not change the preview or the render. Only a framing check reads it, and no menu item or button runs that check |

**Views, captions, fades:**

| Command | Signature | Notes |
| --- | --- | --- |
| `view` | `view(name, secs=0)` | cut to a single view (`main`, `look`, `video`, …), a **view preset** name, a **dynamic preset** (see below), or an explicit layout object `view({main:[0,0,.5,1], video:[.5,0,.5,1]})` (rects are `[left,top,width,height]` as fractions of the frame). A non-zero `secs` makes it an **animated layout transition**. |
| `text` / `title` | `text(caption, secs=3)` | white centred caption with a soft fade in/out |
| `fade` | `fade(view, secs=1, to=0)` | fade a view's opacity to `to` (0–1) |

**Dynamic view presets** (computed live, so no hand-typed rects):

- **`view photo`** — the **witness photo** (`video`) letterboxed to its own aspect, stacked on top of the full-frame 3D `main` view. To dissolve to the real photo and back, pre-hide it then cross-fade:
  ```text
  view main
  & fade video 0.01 0     # arm: hide the photo until we want it
  ...
  view photo
  fade video 1.5 1        # cross-fade UP to the real witness photo
  & fade main 1.5 0       #   (dim the 3D behind it to black)
  linger 2
  fade video 1.5 0        # ...and back to the 3D
  & fade main 1.5 1
  view main
  ```
- **`view VideoOverlay`** — the same idea over the `look` view (witness camera) instead of `main`.

**Menu settings** (snapshotted on preview/render enter and **restored on exit** — a scripted
change never permanently mutates the sitch; scrubbing backwards undoes them):

| Command | Signature | Notes |
| --- | --- | --- |
| `set` | `set(control, value)` or `set(menu, control, value)` | change any menu control; value is `true`/`false`, a number, or an option string. `control` is the label in the menu, and case does not matter: `set "Ambient Intensity" 0.5`. `menu` is the menu's id, for a label that two menus share: `set lighting "Ambient Intensity" 0.5` |
| `show` / `on` | `show(control)` | turn a control on |
| `hide` / `off` | `hide(control)` | turn a control off |

> Only the **main** camera is scripted. A camera command that runs under `view look` moves
> nothing, and no warning appears. The **look** view keeps rendering natively, matched to
> the real witness footage by its own camera controllers — that's why `flyto look` exists, to
> hand the main camera the witness pose.

## World time

By default the script's whole duration is mapped evenly onto the In/Out range. To choose
the slice of world time for each shot, attach a **`world`** marker to it with `&`:

```text
track UFO 4
& world 23:04:39..23:04:49     # 10 s of world in 4 s of screen (fast)
orbit UFO 6
& world 23:04:44               # freeze the world at one instant
```

The shot's own duration and its world window are independent, which gives slow motion,
speed-up, freeze and replay. Each endpoint can be seconds into the sitch (`164`), a sitch
frame (`f4920`), a wall-clock time on the sitch's start date in its display time zone
(`23:04:39`), or an absolute instant (`1973-10-19T03:02:00Z`).

Once any shot has a `world` marker, **every** shot that takes time must have one, including `wait`
and `linger`. If a shot has no marker, a time is outside the sitch, or two shots overlap on the
screen, Sitrec ignores all the `world` markers and uses the even In/Out mapping, in the preview and
in the render. For a missing marker or a time outside the sitch, no message appears: the status
line still says Ready, and no line is underlined.

## Multiple scripts (tabs)

The Scripting window has a **tab bar** — keep several named scripts in one sitch (e.g. a quick
"Overview" and a full "Flythrough"):

- Click **+** to add a script, click a tab to switch to it.
- **Double-click** a tab to rename it; click its **×** to close it (the last one can't be closed).
- The **active** tab is the one that Parse / Preview / Render and the timeline operate on.
- Sitrec keeps all tabs in this browser's local storage automatically. That store holds one set
  of tabs, not one set per sitch, and loading a sitch that has scripts replaces it.
- The tabs become part of the sitch only when you save the sitch. A
  [server link](SavingAndLoading.md#share-a-saved-sitch) opens the version that you saved, so after
  you change a script, save again and share the new link. Whoever opens the link finds the scripts
  in **Video → Scripting → Scripting Window…**.

### Master / scene scripts (`include`)

A tab can **include** another tab by name, so a long production can live as one
scene per tab plus a master tab that just plays them in order:

```text
# ——— Master ———
include "Scene 1 - POV"
include "Scene 2 - Wide"
fade main 3 0
```

`include "Name"` compiles that tab's script and inlines its events at the
current point on the timeline — the clock runs through the scene and the next
line continues after it. Each scene tab stays individually previewable (switch
to it and press Preview) for fast iteration. Rules: includes are **sequential
only** — don't attach `&` lines to an `include` (put concurrent captions inside
the scene tab); the included tab's events are shown on the master timeline but
are wheel-editable only in their own tab; self-includes and circular includes
are errors, nesting is capped at 8.

Because a script stretches over the sitch's whole **In/Out range** (unless its
shots declare [world windows](#world-time)), a scene tab that
covers only part of the world's time should pad itself when previewed alone —
the **`included()`** predicate (plain JS) keeps the padding out of the master:

```text
# ——— Scene 2 - Wide ———  (world time 90–180 in the master)
if (!included()) sleep(90);   // standalone preview: hold 90 s, so this scene plays at its world time
from object 0 115 3800 12
...
```

## The language is JavaScript

You do not need JavaScript for a plain list of shots: use the flat lines in
[Abbreviations](#abbreviations-flat-one-line-shortcuts). For anything more, the script **is**
JavaScript. It never runs during playback — it's executed once, instantly,
against a record-only API to build the timeline. A **virtual clock** stands in for time, and
**`await` is the concurrency syntax**:

| Form | Meaning |
| --- | --- |
| `zoom("A", 6)` | records an event at the current clock, returns a handle. Does **not** advance the clock. |
| `await zoom("A", 6)` | advances the clock to the end of that event (sequential) |
| un-awaited command | starts at the current clock and runs **concurrently** with what follows |
| `await sleep(n)` | advance the clock by `n` seconds, recording nothing (the `await` is optional) |
| `await all(a, b, …)` | advance to the latest end of several handles |
| `at(off, fn)` | run `fn()` with the clock temporarily `off` seconds ahead |
| `atStart(h, off, fn)` | run `fn()` relative to handle `h`'s **start** |
| `wait(n)` | a **command** (a visible camera-hold bar on the timeline); `sleep` is invisible |

Because it's real JS you can use `const`, loops, and functions to generate shots
programmatically. Guards abort runaway loops (an API-call cap and a wall-clock cap).

```js
view("main");
const z = zoom("traverseObject", 6);   // returns a handle
text("The object", 4);                 // un-awaited → starts WITH the zoom
await z;                               // now advance past the zoom
await orbit("traverseObject", 9, 110);
```

## Scripting scene objects

`set` / `show` / `hide` work on **scene objects** too, not just menu controls — name a 3D
object by its id and its visibility becomes a boolean you can drive from the timeline:

```text
hide Viewer          # turn a 3D object off at this point (snapshot/restored like any setting)
show Viewer          # ...and back on
```

An exact object id wins over a menu control that merely *contains* the same word, and the
change is snapshotted on preview/render enter and restored on exit (scrubbing backwards
un-does it) — exactly like a menu `set`.

### Walkers (a marker that moves along a path)

Create a moving marker — e.g. a viewer walking to a vantage point — with the **`createWalker`**
API (callable from the browser's developer console, the [MCP Bridge](MCPBridge.md), or the in-app
assistant). It is not a script command, so do not put it in the Scripting window. It builds a
cylinder (or other geometry) that follows a linear track through lat/lon waypoints over a frame
range and holds at the last waypoint. `alt` is in metres above the WGS84 ellipsoid (HAE):

```js
sitrecAPI.call("createWalker", {
  name: "Viewer",                 // address it later as a target / with show·hide
  waypoints: [[38.7199,-104.7856], [38.7199,-104.7851], [38.7197,-104.7850]],
  alt: 1772, geometry: "cylinder", color: "#ff2020", height: 5, radius: 1,
  startFrame: 0, endFrame: 700,   // reaches the last waypoint at frame 700, then holds
});
```

Because the world's playhead advances across the scripted duration, the walker moves *while*
the camera does. Then in the script you can frame it and switch it off:

```text
from Viewer 5 300 55 16     # fly to 55 m from the walker, 16° up, looking at it
from witness 7 210 360 28   # back out and watch it walk to the camera position
flyto look 4                # settle into the witness viewpoint...
& hide Viewer               # ...and turn the marker off
```

## Timeline controls

![The timeline, zoomed in. A narrow ruler strip runs along the top, with a yellow triangle and a vertical yellow line at the playhead. Colored blocks fill two rows below the ruler. A white vertical line labelled look crosses the blocks. A gray scrollbar runs along the bottom edge, and a label at the lower right reads 7.5 / 21.0s ×1.6](docimages/scripted-video-timeline.jpg)

The timeline, zoomed in. From the top: the ruler strip, then two rows of blocks, then the scrollbar,
which appears only when the timeline is zoomed in. The yellow triangle and line are the playhead. The
white line labelled `look` is a view cut, from a `&5 view look` line added to the Quick start script.
The label at the lower right gives the playhead time, the script length and the zoom factor.

The timeline under the editor (and the strip that replaces the playback bar during preview):

- **Scrub** by dragging the **top ruler strip**, or by grabbing the **playhead** (a fat hit
  zone, so it works even over a block). Scrubbing snaps to view-cut / block edges
  (hold ⌘/Ctrl for free positioning).
- **Zoom** with **⌘/Ctrl + scroll** (centered on the cursor) or the **⌘/Ctrl +/-/0** keys.
- **Pan** when zoomed in: drag the bottom scrollbar, or scroll over the top ruler strip or another
  empty part of the timeline. A plain scroll over a block edits its duration.
- **Edit a duration** by dragging a block's right edge, or scrolling over it. This needs a written
  duration on a flat line. **Move** a concurrent `&` event by dragging its body. (Scroll up
  increases a value.)

## Rendering

**Render Video (1080P60)** renders to MP4 (H.264, 16 Mbit/s, via the Mediabunny encoder). If
the browser cannot encode H.264 at 1920×1080 it writes WebM (VP8) instead. It does not open
the Video Render & Export dialog, so no signal-format filter is applied. A progress box counts
the frames: **Enough** stops early and keeps what is done, and **Abort** gives no file. When the
render ends, the browser downloads the file, named `Sitrec-<sitch>_scripted_<date and time>.mp4`.
Quality knobs live under **Render Quality**:

- **Wait For Terrain** — ON (default) settles each frame so terrain is stable and correct (no
  pop or edge-tile toggling), slower. OFF is fast/rough; terrain may pop.
- **Terrain Detail** — LOD multiplier; lower loads far fewer tiles → much faster, slightly
  coarser. `1` = full detail.
- **Freeze Terrain (Preview)** — OFF (default) keeps terrain tiles loading during the live
  preview as the camera moves. ON freezes the tile set at preview start: no LOD flicker, but
  areas the camera had not already looked at have missing tiles.
- **Motion Blur** — sub-frames averaged per output frame; `1` = off.
- **Super-sample** — render at N×N then downscale for extra anti-aliasing; slower.

## Implementation

The system lives in `src/CScriptedVideo.js` (the manager: parsed model, preview/scrub modes,
caption overlay, menu) and `src/scriptedVideo/`:

| File | Role |
| --- | --- |
| `ScriptRunnerClient.js` | main-thread front end to the script runner. Scripts run only in a Worker (`src/workers/ScriptRunnerWorker.js`), never in the page |
| `ScriptCommands.js` | command registry — each command's args / prepare / sample (add a command = one entry here) |
| `ScriptJSRunner.js` | the JS scheduling kernel (virtual clock, the record-only API) |
| `ScriptSugar.js` | the flat-line → JS rewriter (line-preserving) |
| `ScriptCameraEngine.js` | camera pose computation (`targetPos`, prepare/compute) |
| `ScriptTimelineWidget.js` | the timeline canvas (draw, scrub, wheel-edit) |
| `ScriptEditorWindow.js` | the floating script editor window |
| `ScriptRenderer.js` | the offline 1080P60 MP4 render |
| `ScriptTimeMap.js` | maps script time to sitch frames (`world` windows, the even In/Out mapping) |
| `ScriptCinematics.js` | framing checks: measures sampled shots against framing rules and returns findings. No menu item or button runs them |
| `ScriptJSCallSites.js` | finds where each API call is in the script text, for timeline↔editor highlighting and wheel-editing |
| `ScriptAuthoring.js` | text helpers for palette inserts and timeline edits |
| `ScriptMath.js` | small shared math helpers |
