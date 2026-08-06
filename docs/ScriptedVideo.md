# Scripting

Sitrec can drive a **cinematic camera from a text script**: place the camera, zoom in on an
object, orbit it, track it, change the lens, cut between views, fade panels, change menu
settings, and overlay on-screen captions — all on the script's own timeline, independent of
the sitch frame slider. The result can be previewed live and rendered out to a **1080P60 MP4**.

You'll find it under **Video → Scripting**:

- **Scripting Window…** opens the editor (a floating, draggable, resizable panel; its ⧉ header
  icon pops it out into a separate browser window so you can drag it to another monitor).
- **Render Video (1080P60)** renders the active script to an MP4.
- **Render Quality** holds the render knobs (see [Rendering](#rendering)).

All your scripts travel **with the saved custom sitch**, so a shared or reloaded sitch carries
its scripts.

## Multiple scripts (tabs)

The Scripting window has a **tab bar** — keep several named scripts in one sitch (e.g. a quick
"Overview" and a full "Flythrough"):

- Click **+** to add a script, click a tab to switch to it.
- **Double-click** a tab to rename it; click its **×** to close it (the last one can't be closed).
- The **active** tab is the one that Parse / Preview / Render and the timeline operate on.
- All tabs are saved to the sitch and to local storage automatically.

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

Because a script stretches over the **whole** sitch timeline, a scene tab that
covers only part of the world's time should pad itself when previewed alone —
the **`included()`** predicate (plain JS) keeps the padding out of the master:

```text
# ——— Scene 2 - Wide ———  (world time 90–180 in the master)
if (!included()) sleep(90);   # standalone preview: skip to this scene's world time
from object 0 115 3800 12
...
```

## Author by flying (Capture)

Instead of typing and guessing camera numbers, **fly the main view to the shot you want and
click "Capture"** in the editor toolbar. It inserts a `moveto lat,lon,alt secs lat,lon,alt`
line that reproduces that exact camera position and aim. Tweak the `secs` to set how long the
move there takes, or change `moveto` to `from`/`zoom`/`orbit` to make it relative to a target.

## Quick start

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

1. Open **Video → Scripted Video → Script Window…** and type (or paste) a script.
2. It parses on every keystroke; the **timeline** below the editor shows labelled blocks.
   Click a line (or a block) to **scrub** the viewport to that moment.
3. Press **space** during a preview to play/pause.
4. When happy, **Render Video (1080P60)**.

The sitch's own playhead advances linearly across the whole scripted duration, so the world
(an aircraft flying its track, a satellite moving, the sun setting) animates *while* the
camera moves.

## The language is JavaScript

The script **is** JavaScript. It never runs during playback — it's executed once, instantly,
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

## Abbreviations (flat one-line shortcuts)

For linear shot lists you don't need JS punctuation. A line that looks like a classic flat
command is rewritten into the equivalent JS before it runs. Raw JS lines pass through
untouched, so you can **mix both styles freely**.

| Sugar line | Becomes | Meaning |
| --- | --- | --- |
| `zoom traverseObject 9 900` | `__sp = zoom("traverseObject", 9, 900); await __sp;` | a **plain line is sequential** (awaited spine) |
| `& text "Overview" 5` | `atStart(__sp, 0, () => text("Overview", 5))` | **`&` runs concurrently**, starting WITH the previous spine line |
| `&2 text "cap" 4` | `atStart(__sp, 2, () => text("cap", 4))` | **`&N`** starts `N` seconds after the previous spine line's start |
| `# comment` | `// comment` | comment |

Rules:

- **Multi-word captions need quotes**: `text "tracking inbound" 4`.
- **Bare words are auto-quoted**, so targets and option names need no quotes:
  `zoom traverseObject 9` , `show "Constellation Lines"` (quote if it has spaces).
- A **`&` line attaches to the most recent plain (spine) line**, at *that line's* start. So to
  put a caption over a move, write the `&` line **after** the move:

  ```text
  zoom traverseObject 9 900
  & text "Zooming in" 5      # caption appears as the zoom begins
  ```

- **Assume-last target**: if you omit a target where a number appears, the most recent target
  is reused — `zoom traverseObject 5` then `orbit 6 180` orbits `traverseObject`.
- Numbers on sugar lines (durations, distances, degrees, fov, `&` offsets) are
  **scroll-wheel editable** — hover the number in the editor and spin the wheel.

## Targets

Camera commands aim at a **target**, resolved (at the relevant frame) to a 3-D position:

- a **friendly alias** — `object` (the traverse object), `witness` / `camera` (the observer);
- a **track short-name** — e.g. `OE-LNC` resolves to the node `Track_OE-LNC`;
- a **node id** directly — e.g. `traverseObject`, `cameraObject` (a synthetic object/camera);
- the same name with a `_ob` suffix; or
- a **`"lat,lon,alt"` literal** — `zoom "51.5,-0.13,1000" 6` (altitude optional).

> **Tip:** pick the end distance relative to the object's size. A model ~356 m long needs an
> end distance around 900 m to frame nicely at FOV 30°; 200 m would overflow the frame.

## Smooth, continuous motion

Camera motion is **continuous and smooth by default** — like a drone with inertia. Each beat
starts exactly where the previous one ended, and the whole path is run through a short
temporal smoothing pass (`cameraSmoothing`, ~0.35 s) so consecutive moves *flow* into each
other instead of decelerating to a stop at every boundary. The camera is also kept a few
metres **above the terrain** (`groundClearance`), so a low move never clips through the
ground. Both apply identically in preview and the final render. (For a hard cut, use a
zero-second beat — e.g. `flyto look 0` — or cut the *view*, not the camera, with `view`.)

## Command reference

**Camera moves** (these consume time on the timeline and move/aim the **main** camera):

| Command | Signature | Notes |
| --- | --- | --- |
| `from` | `from(target, secs=3, bearing=180, distance=3000, elevation=20)` | **place the camera at a vantage around the target** and look at it: on compass `bearing` (0 = N, 90 = E, **180 = S**), `elevation`° above the horizon, `distance` m out. Flies there over `secs` (**0 = snap**). Use it to establish an opening/cutaway shot, e.g. `from object 0 180 11000 24` for a high overview from the south |
| `moveto` | `moveto(pos, secs=4, lookAt?)` | **move the camera to an absolute point** — `pos` and `lookAt` are each a target or a `"lat,lon,alt"` literal. Unlike `from` (relative to a target), this places the camera *exactly*: `moveto 38.72,-104.78,1850 4 object` |
| `follow` | `follow(target, secs=6, distance=18, height=6)` | **third-person follow-cam**: trail a *moving* target (e.g. a `createWalker` marker), staying `distance` m behind its direction of motion and `height` m up, looking just ahead — swings around as the target rounds a corner |
| `ride` | `ride(target, secs=5, lookAt?, height=1.6, back=0)` | **ride ON a moving target** (driver/passenger POV): camera `height` m above it and `back` m behind its heading, looking at `lookAt` (another target or `"lat,lon,alt"`) or straight ahead along the motion when omitted. The shot `follow` can't do — move WITH one target while framing another: `ride car 4 sphere3` |
| `zoom` | `zoom(target, secs=5, dist?)` | dolly toward/away along the current line to end **distance** `dist` metres from the target (defaults to 5% of the start distance, clamped 150–700 m) |
| `orbit` | `orbit(target, secs=8, degrees=90, rise=0)` | circle the target by `degrees` around local vertical; an optional `rise` (metres) climbs during the orbit — a **helical "fly up and around" in one beat** (no need for a concurrent rise, which would fight for the camera) |
| `track` | `track(target, secs=5)` | hold position, pan to keep the target framed |
| `rise` | `rise(target, secs=4, meters=500)` | climb straight up (local vertical) by `meters` while turning to look at the target — the "pull up to a wide shot" move |
| `fov` | `fov(degrees, secs=1)` | pure lens change (1–120°); keeps position and aim |
| `flyto` | `flyto(target="look", secs=0)` | fly the main camera to another camera's live pose. Only `look` (the witness camera) is supported — so `flyto look` is **the pose that matches the witness video**. `flyto look 0` snaps; `flyto look 3` swoops over 3 s |
| `wait` / `linger` | `wait(secs=1)` | hold the current pose (visible bar). `linger` is an alias |

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
| `set` | `set(control, value)` or `set(menu, control, value)` | change any GUI control; value is `true`/`false`, a number, or an option string |
| `show` / `on` | `show(control)` | turn a control on |
| `hide` / `off` | `hide(control)` | turn a control off |

> Only the **main** camera is scripted. The **look** view keeps rendering natively, matched to
> the real witness footage by its own camera controllers — that's why `flyto look` exists, to
> hand the main camera the witness pose.

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
API (callable from the console, MCP, or the in-app assistant). It builds a cylinder (or other
geometry) that follows a linear track through lat/lon waypoints over a frame range and holds
at the last waypoint:

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

The timeline under the editor (and the strip that replaces the frame slider during preview):

- **Scrub** by dragging the **top ruler strip**, or by grabbing the **playhead** (a fat hit
  zone, so it works even over a segment). Scrubbing snaps to view-cut / segment edges
  (hold ⌘/Ctrl for free positioning).
- **Zoom** with **⌘/Ctrl + scroll** (centered on the cursor) or the **⌘/Ctrl +/-/0** keys.
- **Pan** with a plain scroll (or Shift+scroll); when zoomed, drag the bottom scrollbar.
- **Edit a duration** by dragging a segment's right edge, or scrolling over it; **move** a
  concurrent `&` event by dragging its body. (Scroll up increases a value.)

## Rendering

**Render Video (1080P60)** renders to MP4 (via the Mediabunny encoder). Quality knobs live
under **Render Quality**:

- **Wait For Terrain** — ON (default) settles each frame so terrain is stable and correct (no
  pop or edge-tile toggling), slower. OFF is fast/rough; terrain may pop.
- **Terrain Detail** — LOD multiplier; lower loads far fewer tiles → much faster, slightly
  coarser. `1` = full detail.
- **Motion Blur** — sub-frames averaged per output frame; `1` = off.
- **Super-sample** — render at N×N then downscale for extra anti-aliasing; slower.

## Implementation

The system lives in `src/CScriptedVideo.js` (the manager: parsed model, preview/scrub modes,
caption overlay, menu) and `src/scriptedVideo/`:

| File | Role |
| --- | --- |
| `ScriptCommands.js` | command registry — each command's args / prepare / sample (add a command = one entry here) |
| `ScriptJSRunner.js` | the JS scheduling kernel (virtual clock, the record-only API) |
| `ScriptSugar.js` | the flat-line → JS rewriter (line-preserving) |
| `ScriptCameraEngine.js` | camera pose computation (`targetPos`, prepare/compute) |
| `ScriptTimelineWidget.js` | the timeline canvas (draw, scrub, wheel-edit) |
| `ScriptEditorWindow.js` | the floating script editor window |
| `ScriptRenderer.js` | the offline 1080P60 MP4 render |
