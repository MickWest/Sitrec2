# Keyboard Shortcuts

Most of Sitrec's interaction is mouse-driven, but some of it is only reachable from the
keyboard, such as the `/` crosshair on a video view. Other keys are quicker ways to reach
controls that are also in a menu: for example, measurements are also in **Show → Measurements**,
and camera placement is also in the right-click menu on the ground.

Press **K** in a custom sitch (see [Getting Started](CustomSitchTool.md)) to show a short summary overlay in the app.

Two conventions used below:

- **Tap** — press and release.
- **Hold** — keep the key down; the action lasts until you release it. Some held keys act at the
  mouse position, or change what a drag does.

Keys are ignored while you are typing in a text field, except `Tab`, which still shows or hides
the AI assistant.

---

## Playback and frames

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `,` and `.` | Step one frame back / forward (hold to repeat) |
| `←` / `→` | Step back / forward; hold to run continuously |
| `↑` / `↓` | Scrub quickly backward / forward (10× speed) |
| `<` and `>` (Shift+`,` / Shift+`.`) | Jump to the previous / next **timeline stop**: a timeline marker, the **In** or **Out** frame, or a **keyframe** a tool has published. Does nothing if there is no stop in that direction — it deliberately does not fall back to single-stepping. Right-click the timeline to add markers (see [Time, Frames and Syncing](TimeAndSync.md#the-playback-bar)) |
| `G` | Go To: prompts for a frame number (jumps there and pauses; a frame outside the In/Out range becomes the new In or Out frame), a date and/or time (`12pm`, `15:20`, `17:33 UTC`, `12/25`, `Jan 6, 2020`), a coordinate in any format, a place name to fly the camera to, or the two or three lines of a TLE, which are loaded as a satellite. Pasting text onto Sitrec (Ctrl/Cmd+V outside a text field) runs it through the same parser |
| `I` | Set the **In** frame (start of the In/Out range) |
| `O` | Set the **Out** frame (end of the In/Out range) |

The other frame keys stop at the In and Out frames. The In/Out range matters for more than
playback: every Global Fit and the whole traverse
analysis fit **only** the sightlines inside it. See [Traverse Methods](TraverseMethods.md).

## Time

| Key | Action |
|---|---|
| `;` and `'` (hold) | Nudge the Start Time backwards / forwards, one second per screen update |
| … with `Shift` | ×10 |
| … with `Alt` | ×1000 |

Hold `'` to slide the stars or a satellite into place when you sync a video against the sky.

## View layout

| Key | Action |
|---|---|
| `Q` (hold) | **Move and resize views.** Hold `Q` and drag a view to move it; drag its edge or corner to resize. Edges highlight while held, and moves snap to neighbouring views |
| `1` – `8` | Switch view preset — see below. Use the number row: numpad `1`, `3`, `7` and `9` also move the main camera (numpad `.` resets it) |
| `U` | Show / hide the menu bar and the playback bar |
| `F` | Toggle fullscreen |
| Double-click an empty part of a view's header | Make it fullscreen; double-click again to restore. The ⛶ icon does the same. Only works on views that allow it — a few, such as the video histogram, deliberately disable it |

`Q` exists because most views use the mouse for camera navigation, so a bare drag inside a 3D
view flies the camera instead of moving the window. Without `Q`, drag a view's header to move
it, or drag an edge, a corner or the seam between two views to resize it.

### View presets

| Key | Preset |
|---|---|
| `1` | **Default** (main view left, video and look view stacked right) |
| `2` | **SideBySide** |
| `3` | **TopandBottom** |
| `4` | **ThreeWide** |
| `5` | **TallVideo** |
| `6` | **VideoLookHorizontal** (video and look view) |
| `7` | **VideoLookVertical** (video and look view) |
| `8` | **TwoVideos** |

![The eight view presets, each a small capture with tags that name its views. 1 Default: main view on the left, video above look view on the right. 2 SideBySide: main view and look view. 3 TopandBottom: main view above look view. 4 ThreeWide: main view, video and look view in three equal columns. 5 TallVideo: main view on the left half, then narrow video and look view columns. 6 VideoLookHorizontal: video above look view. 7 VideoLookVertical: video and look view side by side. 8 TwoVideos: two video views side by side](docimages/keyboardshortcuts-view-presets.jpg)

*The eight view presets, without the menu bar and the playback bar. The number above each capture is its key. The white tags name the views: they are added to this picture, and the app does not show them. Presets 1 to 7 have one video loaded. Preset 8 has the same test clip in both video views.*

The same presets are in **View → View Preset**, so you can see which one you are on. While the
second video view holds a video or image, each preset except **TwoVideos** shows it as a
smaller view over the main view, or over the look view when the main view is hidden (see
[Loading and Adjusting Video](LoadingVideo.md)).

## Placing things in the world

| Key | Action |
|---|---|
| `C` (hold) | Move the **camera** to the point under the mouse, at its current altitude. If the camera **Position** is a track, it changes to **Manual** |
| `X` (hold) | Move the **target** to the point under the mouse, at its current altitude. Works only when **Target Track** is **Manual** or **Manual + Wind** |
| `Shift`+`C` / `Shift`+`X` | Same, but also drop the altitude to **7 ft (about 2.1 m) above the ground** — eye level, not ground level |
| `V` (hold) | Set the **start** point of a measurement |
| `B` (hold) | Set the **end** point of a measurement |
| `T` (hold) | Move the terrain square: it follows the cursor while `T` is held (only when Dynamic Subdivision is off) |

For `C`, `X`, `V` and `B`, hold the key and move the mouse over the ground in the main view or
the look view. You do not need to click.

The V/B measurement shows the distance and true heading from V toward B, measured clockwise
from north (0° north, 90° east). A circle centered on V passes through B. Both the circle and the
measurement arrow stay visible over terrain. The measurement visibility controls in
**Show → Measurements** also control the circle.

## Moving the camera

For the complete gesture reference, open **Help → Mouse, touch and pen controls**. With the **K** overlay open, hover over a tool to see its controls.

In the main 3D view:

| Input | Action |
|---|---|
| Left drag | Drag the world around (the camera moves) |
| Right drag | Aim the camera without moving it |
| Middle drag | Orbit around a point in the world |
| Mouse wheel | Move toward or away from the pointer; in PTZ mode, change field of view |
| `Shift` + wheel | Change field of view |
| `Shift` + drag | Same as Middle drag |
| `Cmd` or `Ctrl` + drag | Aim the camera without moving it |
| `-` / `=` | Zoom out / in |
| Numpad `.` | Reset the camera to its start position |

In the **look view**, when the camera is manually positioned, you can walk:

| Key | Action |
|---|---|
| `W` `A` `S` `D` | Walk forward / left / back / right (about 10 m/s at 60 fps) |
| `PageUp` / `PageDown` | Raise / lower the camera at the same speed as walking |
| `Shift` | Move faster (about 50 m/s at 60 fps), including altitude changes |

WASD preserves the camera's altitude, or its height above ground when **Above Ground Level** is
on. Where [3D tiles](Terrain.md) are loaded, a step below the tile surface raises the camera to
5 ft above it. On plain terrain, rising ground lifts the camera, so it does not go below the
surface. With **Free Look Camera** on, or after a dropped photo or video gives the altitude, the
camera can go below the ground.

A few legacy built-in sitches (for example Night Sky) have a "Manual Position" camera with its
own, separate movement handler. It uses the same letters but a much finer step (0.1 m per
frame, ×10 with `Shift`), and adds `Q` / `E` to move the camera up / down. The custom sitch
does not use it.

## Files and editing

| Key | Action |
|---|---|
| `Cmd`/`Ctrl` + `S` | Save |
| `Cmd`/`Ctrl` + `O` | Open (the server sitch browser) |
| `Cmd`/`Ctrl` + `N` | New sitch |
| `Cmd`/`Ctrl` + `Z` | Undo |
| `Cmd`/`Ctrl` + `Y` or `Shift`+`Cmd`/`Ctrl`+`Z` | Redo |

## Panels and overlays

| Key | Action |
|---|---|
| `Tab` | Show / hide the AI assistant |
| `K` | Show / hide the keyboard-shortcut overlay |
| `N` | Show / hide notes (`Shift`+`N` docks them) |
| `/` (hold) | Crosshair on a video view; click while held to pin it. Press `/` again to clear it |
| `Esc` | Hide the notes, or the AI assistant when it floats; leave track edit mode |

## Tool-specific

| Key | Action | Where |
|---|---|---|
| `[` / `]` | Smaller / larger brush | Masking; Paint On Ground |
| `Alt` + paint | Erase instead of paint | Masking |
| `Shift` + drag | Rectangle fill (`Alt`+`Shift` = rectangle erase) | Mask editing |
| `'` (hold) | Advance frame by frame, tracking as it goes | Point Track |
| `;` (hold) | **Rewind, deleting tracked positions as it goes.** Not backward tracking — use it to undo a bad run | Point Track |
| `Delete` / `Backspace` | Delete the keyframe under the mouse | Point Track |
| `Delete` / `Backspace` | Delete the building, cloud layer or ground overlay being edited | Buildings, clouds, overlays |
| `S` `P` `B` `L` `A` `R` `E` `T` `I` `X` | Select, Pencil, Brush, Line, Arrow, Rectangle, Ellipse, Text, Image, Eraser tool | Annotations, in **Edit Mode** |
| `J` / `K` | Previous / next keyframe | Horizon Extractor |
| `\` | Start editing the first OSD track. While you edit, keys type into the value: `Tab` goes to the next track, `[` / `]` step one frame, and `Enter` or `Esc` stops editing | OSD Tracker |
| `PageUp` / `PageDown` | Previous / next OSD keyframe | OSD Tracker |
| `←` / `→` | Previous / next result, in tile order; wraps at the ends | Traverse analysis results |
| `↑` / `↓` | Result above / below in the grid | Traverse analysis results |
| `Enter` | Expand the selected result's graph; again to return to the list | Traverse analysis results |
| `Esc` | Close the expanded graph, or else the results | Traverse analysis results |
| `Space` | Play / pause the results timeline | Traverse analysis results |
| `Esc` | Abort the recording | *Record Browser Window* only — the other renders use the **Abort** button on the progress panel |
| `Enter` | Stop early and keep what has recorded | *Record Browser Window* only — the other renders use the **Enough** button |

---

## Keys that collide

A few keys are bound in more than one place:

- **`O`** is *Set Out frame*, and is also bound as a show/hide toggle for lines of sight. The
  toggle never fires — `O` always sets the Out frame and nothing else.
- **`I`** shadows a glare-sprite toggle in the Gimbal sitches the same way.
- **`;`** and **`'`** drive both the Start Time nudge and the Point Track hold keys while Point
  Track is enabled. A rewind with `;` also moves the Start Time back, one second per screen
  update. The Start Time does not move while `'` is tracking, but the first hold of `'` can move
  it forward before tracking starts.
- **`K`** is the shortcuts overlay and also *next keyframe* in the Horizon Extractor.
- **Annotation tool keys** also run their normal action. For example, `I` also sets the In frame.
- **`V`**, **`G`**, **`C`**, **`X`**, **`E`**, **`N`**, **`P`** are bound to show/hide toggles in
  the legacy Gimbal/GoFast sitches.

---

## See also

- [User Interface](UserInterface.md) — menus, views, and the time controls
- [Saving and Loading Sitches](SavingAndLoading.md)
- [Point Tracking](PointTrack.md)
- [Masking](Masking.md)
