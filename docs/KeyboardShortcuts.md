# Keyboard Shortcuts

Most of Sitrec's interaction is mouse-driven, but a substantial amount of it is only
reachable from the keyboard — and several of the most useful controls (moving views, placing
the camera, measuring) have no menu equivalent at all.

Press **K** at any time to show a short summary overlay in the app.

Two conventions used below:

- **Tap** — press and release.
- **Hold** — the key does nothing on its own; it changes what the *mouse* does while held.

Keys are ignored while you are typing in a text field.

---

## Playback and frames

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `,` and `.` | Step one frame back / forward (hold to repeat) |
| `←` / `→` | Step back / forward; hold to run continuously |
| `↑` / `↓` | Scrub quickly forward / backward |
| `<` and `>` (Shift+`,` / Shift+`.`) | Jump to the previous / next **keyframe**, where a tool has published them. Does nothing if none exist — it deliberately does not fall back to single-stepping |
| `G` | Go to frame: prompts for a frame number, jumps there and pauses |
| `I` | Set the **In** frame (start of the A-B range) |
| `O` | Set the **Out** frame (end of the A-B range) |

The In/Out range matters for more than playback: every Global Fit and the whole traverse
analysis fit **only** the sightlines inside it. See [Traverse Methods](TraverseMethods.md).

## Time

| Key | Action |
|---|---|
| `;` and `'` (hold) | Nudge the Start Time backwards / forwards, one second per frame |
| … with `Shift` | ×10 |
| … with `Ctrl` | ×100 |
| … with `Alt` | ×1000 |
| … with `Cmd` | ×10000 |

This is the fastest way to sync a video against the sky: hold `'` and watch the stars or a
satellite slide into place.

## View layout

| Key | Action |
|---|---|
| `Q` (hold) | **Move and resize views.** Hold `Q` and drag a view to move it; drag its edge or corner to resize. Edges highlight while held, and moves snap to neighbouring views |
| `1` – `8` | Switch view preset — see below |
| `U` | Show / hide the menu bar |
| `F` | Toggle fullscreen |
| Double-click a view | Make it fullscreen; double-click again to restore. Only works on views that allow it — a few, such as the video views in the `video` sitch, deliberately disable it |

`Q` exists because most views use the mouse for camera navigation, so a bare drag inside a 3D
view flies the camera instead of moving the window. Without `Q` held, nothing happens — which
is the single most common "the app is broken" report.

### View presets

| Key | Preset |
|---|---|
| `1` | Default (main view left, video and look view stacked right) |
| `2` | Side by side |
| `3` | Top and bottom |
| `4` | Three wide |
| `5` | Tall video |
| `6` | Video + look, horizontal |
| `7` | Video + look, vertical |
| `8` | Two videos |

The same presets are in the **View** menu, so you can see which one you are on.

## Placing things in the world

| Key | Action |
|---|---|
| `C` (hold) | Move the **camera** to the point under the mouse |
| `X` (hold) | Move the **target** to the point under the mouse |
| `Shift`+`C` / `Shift`+`X` | Same, but also drop the altitude to **7 ft above the ground** — eye level, not ground level. (Sitrec keeps a small clearance so the camera does not end up inside inaccurate terrain.) |
| `V` (hold) | Set the **start** point of a measurement |
| `B` (hold) | Set the **end** point of a measurement |
| `T` (hold) | Drag the terrain square to a new area (only when Dynamic Subdivision is off) |
| `E` | Extend all tracks to the ground |

## Moving the camera

In the main 3D view:

| Input | Action |
|---|---|
| Left drag | Drag the world around (the camera moves) |
| Right drag | Tilt the viewpoint without moving the camera |
| Middle drag | Orbit around a point in the world |
| Mouse wheel | Zoom |
| `Shift` + drag | Force rotate |
| `Cmd` or `Ctrl` + drag | Force pan |
| `-` / `=` | Zoom out / in |
| Numpad `.` | Reset the camera to its start position |
| Numpad `1` / `7` / `3` | Snap to front / top / side |
| Numpad `9` | Flip 180° |

In the **look view**, when the camera is manually positioned, you can walk:

| Key | Action |
|---|---|
| `W` `A` `S` `D` | Walk forward / left / back / right (10 m/s) |
| `Shift` | Walk faster (50 m/s) |

A **manually positioned** camera has its own, separate movement handler with the same letters
but a much finer step (0.1 m per frame, ×10 with `Shift`), and adds:

| Key | Action |
|---|---|
| `Q` / `E` | Move the camera up / down |

Note `Q` does double duty: held over a view edge it resizes a view, and on a manually
positioned camera it ascends.

## Files and editing

| Key | Action |
|---|---|
| `Cmd`/`Ctrl` + `S` | Save |
| `Cmd`/`Ctrl` + `O` | Open |
| `Cmd`/`Ctrl` + `N` | New sitch |
| `Cmd`/`Ctrl` + `Z` | Undo |
| `Cmd`/`Ctrl` + `Y` or `Shift`+`Cmd`/`Ctrl`+`Z` | Redo |

## Panels and overlays

| Key | Action |
|---|---|
| `Tab` | Show / hide the AI assistant |
| `K` | Show / hide the keyboard-shortcut overlay |
| `N` | Show / hide notes (`Shift`+`N` docks them) |
| `/` (hold) | Crosshair on any 2D view; click while held to pin it |

## Tool-specific

| Key | Action | Where |
|---|---|---|
| `[` / `]` | Smaller / larger brush | Masking |
| `Alt` + paint | Erase instead of paint | Masking |
| `Shift` + drag | Rectangle fill (`Alt`+`Shift` = rectangle erase) | Mask editing |
| `'` (hold) | Advance frame by frame, tracking as it goes | Point Track |
| `;` (hold) | **Rewind, deleting tracked positions as it goes.** Not backward tracking — use it to undo a bad run | Point Track |
| `Delete` / `Backspace` | Delete the keyframe under the mouse | Point Track |
| `J` / `K` | Previous / next keyframe | Horizon Extractor |
| `\`, `PageUp`/`PageDown` | Cycle OSD track / step keyframe | OSD Tracker |
| `Esc` | Abort the recording | *Record Browser Window* only — the other renders use the **Abort** button on the progress panel |
| `Enter` | Stop early and keep what has recorded | *Record Browser Window* only — the other renders use the **Enough** button |

---

## Keys that collide

A few keys are bound in more than one place. These are the ones that surprise people:

- **`O`** is *Set Out frame*, and is also bound as a show/hide toggle for lines of sight in
  some legacy sitches. The In/Out handler runs first and returns immediately, so the toggle
  never fires — `O` always sets the Out frame and nothing else.
- **`I`** shadows a glare-sprite toggle in the Gimbal sitches the same way.
- **`;`** and **`'`** drive both the Start Time nudge and the Point Track run loop. If Point
  Track is open, expect both.
- **`K`** is the shortcuts overlay and also *next keyframe* in the Horizon Extractor.
- **`Q`** resizes views, and on a manually positioned camera also moves it up.
- **`E`** extends tracks to the ground, and in the legacy jet sitches toggles the pod's-eye
  view.
- **`V`**, **`G`**, **`C`**, **`X`**, **`N`**, **`P`** are all bound to show/hide toggles in
  the legacy Gimbal/GoFast sitches, where they do not clash with the custom-sitch bindings
  above because those sitches do not use them.

---

## See also

- [User Interface Basics](UserInterface.md) — menus, views, and the time controls
- [Saving and Loading Sitches](SavingAndLoading.md)
- [Point Track and Stabilization](PointTrack.md)
- [Masking](Masking.md)
