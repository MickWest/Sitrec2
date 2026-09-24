# Adding Objects and Tracks

**Right-click the ground in a 3D view**

In a Custom sitch, right-clicking the ground opens a menu that places things at that point: a
camera or target position, a pin, a 3D object, a track, a balloon, a building, a cloud layer, a
ground overlay or a measurement grid. This page describes each item in that menu, the editors for
buildings, clouds, ground overlays and ground grids, and how to find, change and remove each thing
after you make it.

This page has four parts:

- **A. [The ground menu](#a-the-ground-menu)**: every item, and where the new thing appears
- **B. [Right-clicking things that are already there](#b-right-clicking-things-that-are-already-there)**
- **C. [The editors](#c-the-editors)**: buildings, clouds, ground overlays and ground grids
- **D. [Finding, saving and removing](#d-finding-saving-and-removing)**

---

## A. The ground menu

Right-click the ground (terrain, or the globe) in the main view or the look view. The menu is
titled **Ground**. It is only available in a Custom sitch, which is the default starting point.

The top of the menu shows the location of the point you clicked:

- latitude and longitude, to six decimal places
- the altitude above mean sea level (MSL)
- the WGS84 height above the ellipsoid (HAE), with the difference between the two in parentheses

You can select and copy this text.

### Menu items

| Item | What it does | Where the result goes |
|---|---|---|
| **Set Camera Above** | Moves the camera's fixed position to the clicked latitude and longitude. The camera keeps its current altitude | The camera position |
| **Set Camera on Ground** | Moves the camera's fixed position to the clicked point, 2 m above the ground (eye level) | The camera position |
| **Set Target Above** | Moves the target's fixed position to the clicked latitude and longitude. The target keeps its current altitude | The target position |
| **Set Target on Ground** | Moves the target's fixed position to the clicked point, on the ground | The target position |
| **Drop Pin** | Places a labelled pin (a feature marker) and opens its edit window with the label text selected, ready to type | See [Pins](#pins) |
| **Add 3D Object** | Places a grey 5 m sphere that stays in one place. It has no track | **Objects** menu, as *Object 1*, *Object 2*, ... |
| **Create Track with Object** | Starts a new hand-drawn track at the clicked point, at the current frame, with a grey 5 m sphere riding on it. The track opens in edit mode | Track in **Contents**, object in **Objects** |
| **Create In->Out Obj Track** | Makes a straight track with an object riding on it, from the In frame to the Out frame. See [In->Out tracks](#in-out-tracks) | Track in **Contents**, object in **Objects** |
| **Create Track (No Object)** | Starts a new hand-drawn track called *New Track* at the clicked point, at the current frame, in edit mode | **Contents** |
| **Add Balloon** | Adds a balloon that launches from the clicked point, rises and drifts with the wind. See [Balloons](#balloons) | **Contents**, as *Balloon*, *Balloon_1*, ... |
| **Add Building** | Adds a 15 × 15 m building, 4 m high, centered on the clicked point, and opens its editor | **Objects**, as *Building: Building 1* |
| **Add Clouds** | Adds a round layer of clouds at 10,000 ft, 500 m in radius, centered above the clicked point, and opens its editor | **Objects**, as *Clouds: Clouds 1* |
| **Add Ground Overlay** | Adds an image overlay draped on the ground, 0.02° square, centered on the clicked point, and opens its editor. It has no image until you give it one | **Objects**, as *Overlay: Overlay 1* |
| **Add Ground Grid** | Adds a measurement grid draped on the ground, 1000 × 1000 of your current small units (meters or feet), with major lines every 100 and minor lines every 10, and opens its editor | **Objects**, as *Grid: Grid 1* |
| **Center Terrain square here** | Moves the center of the terrain square to the clicked point. Only shown when **Dynamic Subdivision** is off (see [Terrain](Terrain.md)) | The terrain |
| **Google Maps Here** | Opens Google Maps at the clicked point in a new browser tab | A new tab |
| **Google Earth Here** | Downloads a small KML file, *Sitrec Pin.kml*, with a pin at the clicked point. Open it in Google Earth | Your downloads |

**Google Maps Here** and **Google Earth Here** are shown only on installations that enable extra
help links.

Two more items can appear, between the others, when you right-click inside something that
already exists:

- **Edit Clouds: *name*** when the clicked point is under a cloud layer (within its radius)
- **Edit Overlay: *name*** or **Edit Grid: *name*** when the clicked point is inside a ground
  overlay or ground grid

Each one opens that item's editor. This is the usual way to edit clouds, overlays and grids from
the 3D view, because a right-click on them passes through to the ground behind.

The camera and target items move the fixed positions that the camera and target use when they are
not following a track. If the camera or target follows a track, the move has no visible effect
until you switch back to the fixed position.

If you right-clicked in the **look view**, a new track (from any of the three track items or from
**Add Balloon**) is also shown in the look view. A track made from the main view is shown only in
the main view. You can change this later with **Show in look view** in the track's folder.

### In->Out tracks

**Create In->Out Obj Track** makes a track with two keyframes:

- the first at the **In** frame, at the point you clicked
- the second at the **Out** frame, level with the first and 200 screen pixels to its right in the
  view you clicked

Both ends are therefore on screen and easy to grab, and left to right matches In to Out on the
timeline. **Constant Speed** is on, so the object moves at a steady speed between the keyframes.
**Alt Lock** is set to 0 above ground, so the whole track stays at one height: drag the object or
either keyframe up, and the whole track rises.

Set the In and Out frames before you use it, with **Time → In Frame [I]** and
**Time → Out Frame [O]**, or the **I** and **O** keys at those frames. See
[Keyboard Shortcuts](KeyboardShortcuts.md).

### Hand-drawn tracks

All three track items create a *synthetic* track: a spline through control points you place by
hand. It starts in edit mode. To add, move and delete points, and to leave edit mode, see the
edit-mode notes under [Sitrec Spline](Tracks.md#sitrec-spline-splinejson) in
[Loading and Filtering Tracks](Tracks.md).

A synthetic track's folder in **Contents** has **Edit Track**, **Constant Speed**,
**Extrapolate Track**, **Curve Type**, **Alt offset**, **Alt Lock (-1 = off)**, **Alt Lock AGL**,
**Show in look view**, **Export Spline** and **Delete Track**, in addition to the usual display
controls described in [Track Display Controls](Tracks.md#track-display-controls).

### Balloons

**Add Balloon** makes a balloon target: a 0.5 m white sphere on a generated track. The balloon
starts at the ground height of the clicked point, rises once launched, and drifts with the wind at
each altitude (see [Wind](Wind.md)). It is added to the camera and target track lists, so the
camera can follow or look at it.

Its folder in **Contents** has these launch settings:

| Control | Default | What it does |
|---|---|---|
| **Start Altitude (m MSL)** | ground at the clicked point | Launch altitude above mean sea level |
| **Launch Delay (s)** | 0 | Seconds after the start of the sitch before the balloon lifts off |
| **Buoyancy (m/s)** | 5 | Steady ascent rate once launched. A negative value makes it descend |
| **Wind Variability (%)** | 20 | Random gustiness, as a percentage of the local wind speed |
| **Random Seed** | 1 | Change it for a different, but repeatable, flight path |

It also has **Show in look view** and **Delete Track**, which asks before it deletes the balloon.

### Pins

**Drop Pin** places a pin labelled *New Feature* and opens a window titled **Edit: *label***. In
it you can change **Label Text**, **Arrow Length**, **Arrow Color** and **Text Color**, and read
the pin's latitude, longitude and altitudes. While the window is open you can drag the pin in the
view. **Delete Pin** removes it (it asks first). **Done**, Escape, or a double-click on the window
title closes the window.

Pins do not have a folder in a menu. To edit a pin later, right-click it. **Show → Pins in Main**
and **Show → Pins in Look** show or hide all pins in each view.

### 3D objects

**Add 3D Object** opens the new object's edit window straight away, because a grey 5 m sphere on
open ground can be hard to find. While the window is open you can drag the object with the move
widget that appears when the pointer is near it. The window holds the same controls as the
object's folder in the **Objects** menu: geometry or model, size, material and so on. See
[Custom Models and 3D Objects](CustomModels.md).

---

## B. Right-clicking things that are already there

A right-click in a 3D view picks the first thing it finds, in this order:

1. a **pin**: opens the pin's edit window
2. a **3D object** (including buildings): opens its edit window, as described below
3. a **track** line, within about 10 pixels of the pointer: opens a window titled
   **Track: *name*** with the same controls as the track's folder in **Contents**
4. a star, planet or satellite
5. the **ground**: opens the ground menu

**3D object.** The edit window is titled with the object's name and holds the controls of its
folder in the **Objects** menu. It stays open while you work in the view. While it is open, the
object can be dragged with its move widget. You can also move any movable object without opening
a window: hold **Option** (Mac) or **Alt** (Windows, Linux) and drag it.

**Building.** Right-clicking a building puts it in edit mode and opens its editor at the pointer.
See [Buildings](#buildings).

**Clouds, overlays and grids** do not catch the right-click. It goes through to the ground, and the
ground menu then offers **Edit Clouds**, **Edit Overlay** or **Edit Grid** for the item under the
pointer.

**While a track is in edit mode**, every right-click goes to that track's edit menus, and nothing
else opens a menu until you leave edit mode. See
[Sitrec Spline](Tracks.md#sitrec-spline-splinejson).

**While an editor is open** for a building, a cloud layer, an overlay or a grid, right-clicking the
ground does not open the ground menu. Close the editor first.

---

## C. The editors

Buildings, clouds, ground overlays and ground grids share one way of working:

- **Edit mode** shows colored handles in the 3D views. Drag a handle to change the item.
- **The editor** is a floating window titled **Edit: *name***. It holds the same controls as the
  item's folder in the **Objects** menu, so a change in one shows in the other. You can drag the
  window, or dock it in a sidebar.
- **Closing the editor leaves edit mode.** Close it with its close control, or press **Escape**
  when it is the top window. You can also clear **Edit Mode** in the item's folder.
- **Creating an item, or choosing Edit ... in the ground menu,** ends edit mode on any other
  building, cloud layer, overlay, grid or track.
- **Escape during a drag** cancels that drag and puts the item back where it was.
- **Delete** or **Backspace** deletes the item being edited, after asking you. This works for a
  building, a cloud layer, an overlay or a grid.
- **Undo** (**Cmd**/**Ctrl** + **Z**) works for creating, dragging and deleting.

Handles keep the same size on screen at any zoom. Heights and sizes are shown in your current small
units (meters or feet), unless the label says otherwise.

### Buildings

Right-click the ground and choose **Add Building**, or right-click an existing building. You can
also turn on **Edit Mode** in **Objects → Building: *name***.

A new building is a 15 × 15 m box, 4 m high, with a flat roof. It sits on the ground: if the
terrain or 3D tiles under it change, the building moves back onto the ground.

#### Handles

| Handle | Drag it to |
|---|---|
| **Yellow** sphere at each bottom corner | Resize the footprint. The opposite corner stays fixed and the footprint stays a rectangle |
| Just **outside** a yellow corner, in the direction away from the building | Rotate the whole building about its center |
| **Grey** sphere at the center of the roof | Raise or lower the whole roof |
| **Cyan** sphere at one end of the ridgeline | Raise or lower the ridgeline above the roof edge. This makes a pitched roof from a flat one |
| The **building itself** | Move the building over the ground |

Hold **Option** / **Alt** and drag the building or one of its handles to make a copy and drag the
copy. Press **Escape** during that drag to cancel the copy.

A new building starts at the rotation you last gave a building, so a row of buildings along one
street comes out already aligned.

#### Controls

These are in **Objects → Building: *name*** and in the editor.

| Control | Default | What it does |
|---|---|---|
| **Name** | *Building 1*, *Building 2*, ... | The name in the menus and the editor title |
| **Visible** | on | Show or hide the building |
| **Edit Mode** | on when created | Show the handles and the editor |
| **Height → Roof Edge Height** | 4 m | Height of the top of the walls, above the highest ground point under the building |
| **Height → Ridgeline Height** | same as Roof Edge Height | Height of the roof ridge. When it equals Roof Edge Height, the roof is flat. It cannot be lower than the roof edge |
| **Height → Ridgeline Inset** | 0 | Moves both ends of the ridge inward, which slopes the end faces of the roof |
| **Height → Roof Eaves** | 0 | Extends the roof beyond the walls |
| **Material → Type** | lambert | Lighting model: basic, lambert, phong or physical |
| **Material → Wall Color** | light grey | Color of the walls |
| **Material → Roof Color** | dark grey | Color of the roof |
| **Material → Opacity** | 1 | 0 is invisible, 1 is solid |
| **Material → Transparent** | on | Lets Opacity below 1 take effect |
| **Material → Wireframe** | off | Draws the building as edges only |
| **Material → Depth Test** | on | Turn off to draw the building on top of everything in front of it |
| **Delete Building** | | Deletes the building, after asking you |

**Objects → Remove all Buildings** deletes every synthetic building at once. It does not ask first,
and it does not affect clouds, overlays or grids.

### Clouds

Right-click the ground and choose **Add Clouds**, or right-click the ground under an existing
cloud layer and choose **Edit Clouds: *name***. You can also turn on **Edit Mode** in
**Objects → Clouds: *name***.

A cloud layer is a round patch of cloud puffs at one altitude. The puffs always face the camera.

#### Handles

Each handle turns green when the pointer is over it.

| Handle | Drag it to |
|---|---|
| **Yellow**, at the center | Raise or lower the layer |
| **Cyan**, on the east edge | Change the radius |
| **Orange**, halfway to the west edge | Move the layer |

#### Controls

These are in **Objects → Clouds: *name*** and in the editor.

| Control | Default | What it does |
|---|---|---|
| **Name** | *Clouds 1*, *Clouds 2*, ... | The name in the menus and the editor title |
| **Visible** | on | Show or hide the layer |
| **Edit Mode** | on when created | Show the handles and the editor |
| **Properties → Altitude** | 10,000 ft | Height of the layer |
| **Properties → Radius** | 500 m | Radius of the layer |
| **Properties → Cloud Size** | 200 m | Width of each cloud puff. Its height is half its width |
| **Properties → Density** | 0.5 | How many puffs fill the layer. The number also grows with the area |
| **Properties → Opacity** | 0.8 | How solid the puffs are |
| **Properties → Brightness** | 1 | Values above 1 make the puffs glow |
| **Properties → Sun Reflection** | 0 | Brightens the clouds around the point where the Sun's reflection on the layer is seen from the camera, over this radius in meters. 0 is off |
| **Properties → Depth** | 0 | Spreads the puffs up and down over this thickness |
| **Properties → Edge Wiggle** | 0 | Makes the edge of the layer irregular. The value is a fraction of the radius |
| **Properties → Edge Frequency** | 5 | How many bumps the irregular edge has |
| **Properties → Seed** | 0 | Change it for a different, but repeatable, arrangement of puffs |
| **Properties → Feather** | 1000 m | Distance inside the edge over which the puffs thin out |
| **Wind → Wind Mode** | No Wind | *No Wind* keeps the layer still. *Use Local* and *Use Target* move it with the local or target wind. *Custom* uses the two settings below |
| **Wind → Wind From (°)** | 270 | Direction the wind blows from. Shown only for *Custom* |
| **Wind → Wind (knots)** | 50 | Wind speed. Shown only for *Custom* |
| **Delete Clouds** | | Deletes the layer, after asking you |

With wind, the layer drifts from its position at frame 0 by the wind speed times the time since
frame 0. It moves as one piece.

### Ground overlays

A ground overlay is an image draped on the terrain, such as a map, a satellite photo or a site
plan. There are two ways to make one:

- **Drag an image file** onto Sitrec and choose **Ground Overlay** in the *Import Image* dialog.
  The overlay is placed at the center of the main view, about 0.01° square, named after the file,
  and opens in edit mode.
- **Right-click the ground → Add Ground Overlay**. The overlay has no image yet and shows a grey
  square with a red circle. Give it an image with **Image URL** or **Rehost Local Image**.

To edit an existing overlay, right-click the ground inside it and choose **Edit Overlay: *name***,
or turn on **Edit Mode** in **Objects → Overlay: *name***.

#### Handles

| Handle | Drag it to |
|---|---|
| **Yellow** sphere at each corner | Resize. The opposite corner stays fixed and the overlay stays a rectangle. With **Free Transform** on, each corner moves by itself |
| **Cyan** sphere near the north edge | Rotate the overlay about its center |
| The **image itself** | Move the overlay |
| **Magenta** sphere (a lock point) | Warp the image so that this point of the image goes where you drop it |

**Lock points** help you match an image to the ground. In edit mode, right-click a feature on the
overlay to pin that point of the image. You can place up to three. Then drag a lock point onto the
place where that feature really is:

- with one lock point, the image moves
- with two, it also turns and scales
- with three, it can also stretch and shear

Dragging a lock point turns on **Free Transform**. **Option** / **Alt** + right-click a lock point
removes it.

#### Controls

These are in **Objects → Overlay: *name*** and in the editor.

| Control | Default | What it does |
|---|---|---|
| **Name** | *Overlay 1*, ... or the file name | The name in the menus and the editor title |
| **Visible** | on | Show or hide the overlay |
| **Edit Mode** | on when created | Show the handles and the editor |
| **Lock Shape** | off | Hides the corner and rotation handles, so you cannot change the size, shape or rotation by accident. You can still drag the overlay to move it |
| **Free Transform** | off | Lets each corner move by itself, for a perspective warp. Turning it on sets **Rotation** to 0. Turning it off returns the overlay to a rectangle |
| **Show Border** | off | Draws a red border around the overlay. The border is also shown while the pointer is over the overlay's folder |
| **Properties → Image URL** | empty | Web address of the image |
| **Properties → Rehost Local Image** | | Choose an image file on your computer. Sitrec uploads it and puts its address in Image URL. You must be logged in |
| **Properties → North**, **South**, **East**, **West** | 0.01° from the clicked point | The edges of the overlay, in degrees |
| **Properties → Rotation** | 0 | Rotation in degrees, −180 to 180 |
| **Properties → Altitude (ft)** | 0 | Always in feet. At 0 the overlay is draped over the terrain. Above 0 it is a flat sheet at that altitude, for example for clouds taken from a satellite image |
| **Properties → Wireframe** | off | Draws the overlay's triangles as lines |
| **Properties → Opacity** | 1 | 0 is invisible, 1 is solid |
| **Cloud Extraction → Extract Clouds** | off | Keeps only the parts of the image close to **Cloud Color**, and makes the rest transparent |
| **Cloud Extraction → Cloud Color** | #E0E0E0 | The color to keep |
| **Cloud Extraction → Fuzziness** | 40 | How far from Cloud Color a pixel can be and still be fully kept |
| **Cloud Extraction → Feather** | 40 | A further range over which pixels fade out, instead of a hard cut |
| **Go to Overlay** | | Moves the main view camera to look down on the overlay |
| **Delete Overlay** | | Deletes the overlay, after asking you |

### Ground grids

A ground grid is a measurement grid draped on the terrain, with major and minor lines. Lines stay
the same width on screen at any distance, and fade out when they get too close together.

Right-click the ground and choose **Add Ground Grid**. To edit an existing grid, right-click the
ground inside it and choose **Edit Grid: *name***, or turn on **Edit Mode** in
**Objects → Grid: *name***.

The grid has the same **yellow** corner, **cyan** rotation and move-by-dragging handles as a ground
overlay. It has no lock points: a right-click on a grid goes to the ground menu.

#### Controls

These are in **Objects → Grid: *name*** and in the editor. The labels of sizes and steps end with
your current small unit, for example **Width (m)** or **Width (ft)**. The grid keeps its real size
when you change the unit system.

| Control | Default | What it does |
|---|---|---|
| **Name** | *Grid 1*, ... | The name in the menus and the editor title |
| **Visible** | on | Show or hide the grid |
| **Edit Mode** | on when created | Show the handles and the editor |
| **Width**, **Height** | 1000 | Size of the grid |
| **Major Step** | 100 | Spacing of the major lines. 0 turns them off |
| **Minor Step** | 10 | Spacing of the minor lines. 0 turns them off |
| **Lat/Lon Grid** | off | Draws lines of latitude and longitude at round values instead. See below |
| **Min Pixel Spacing** | 10 | Lat/Lon Grid only: the smallest on-screen gap between minor lines |
| **Max Pixel Spacing** | 200 | Lat/Lon Grid only: the largest on-screen gap between minor lines |
| **Major Line Width** | 1.5 | Width of major lines, in screen pixels |
| **Minor Line Width** | 1 | Width of minor lines, in screen pixels |
| **Minor Brightness** | 0.4 | How bright the minor lines are, compared with the major lines |
| **Rotation** | 0 | Rotation in degrees, −180 to 180 |
| **Altitude** | 0 | At 0 the grid is draped over the terrain. Above 0 it is a flat sheet at that height |
| **Major Color** | yellow | Color of the major lines and the outline |
| **Minor Color** | same as Major Color | Color of the minor lines |
| **Lock Colors** | on | Makes Minor Color follow Major Color. Turn it off to set Minor Color by itself |
| **Opacity** | 1 | 0 is invisible, 1 is solid |
| **Go to Grid** | | Moves the main view camera to look down on the grid |
| **Delete Grid** | | Deletes the grid, after asking you |

The outline of the grid is always drawn, so a grid with both steps at 0 is still visible and can
still be dragged.

**Lat/Lon Grid.** With this on, the lines are at exact round coordinates: whole degrees, tenths,
hundredths and so on. Each view picks its own spacing as you zoom, so that the gap between minor
lines stays between **Min Pixel Spacing** and **Max Pixel Spacing**. Major lines are ten times the
minor spacing. A label at the bottom of each 3D view shows the spacing drawn there, for example
*Major: 0.001°, Minor: 0.0001°*. While it is on, **Major Step**, **Minor Step** and **Rotation**
are disabled and the grid is squared to north. Your step values are kept for when you turn it
off. The rotation is not restored.

---

## D. Finding, saving and removing

### Where things are in the menus

| Thing | Menu folder | How to remove it |
|---|---|---|
| Hand-drawn track | **Contents → *track name*** | **Delete Track** (asks first) |
| Balloon | **Contents → *Balloon*** | **Delete Track** (asks first) |
| 3D object, including the object on a track | **Objects → *object name*** | No delete button. Undo removes an object just after you add it |
| Building | **Objects → Building: *name*** | **Delete Building**, or **Delete** / **Backspace** in edit mode. **Objects → Remove all Buildings** removes them all |
| Cloud layer | **Objects → Clouds: *name*** | **Delete Clouds**, or **Delete** / **Backspace** in edit mode |
| Ground overlay | **Objects → Overlay: *name*** | **Delete Overlay**, or **Delete** / **Backspace** in edit mode |
| Ground grid | **Objects → Grid: *name*** | **Delete Grid**, or **Delete** / **Backspace** in edit mode |
| Pin | none: right-click the pin | **Delete Pin** in its edit window |

You can drag the **Objects** or **Contents** menu off the menu bar to keep it open while you work.
See [The Menu System](UserInterface.md#the-menu-system).

### Saving

Tracks, balloons, 3D objects, pins, buildings, cloud layers, overlays and grids are saved with a
Custom sitch, with their settings. When you load the sitch, they come back where you left them.
An image you dragged in as a ground overlay is saved with the sitch like other files you drop in.
An overlay made with **Image URL** keeps that address. See [Saving and Loading](SavingAndLoading.md).

---

## Tips

- **Can't see a new object?** A 5 m sphere is small from far away. Its edit window opens when you
  add it; drag it with the move widget, or use **Global Scale** in the **Objects** menu to make all
  objects larger while you find it. Set it back to 1 for real size.
- **Satellite image with clouds.** Drag the image in as a ground overlay, turn on
  **Extract Clouds**, pick the cloud color, then set **Altitude (ft)** to the cloud height.
- **Nothing happens on right-click?** Check for an open editor, or a track still in edit mode
  (the label at the top of each 3D view names it). Press **Escape** to leave track edit mode.

## See also

- [Loading and Filtering Tracks](Tracks.md): track edit mode, and the controls in a track's folder
- [Custom Models and 3D Objects](CustomModels.md): the controls in an object's folder
- [Terrain and Elevation](Terrain.md): the terrain square and Dynamic Subdivision
- [Wind](Wind.md): the wind that moves balloons and cloud layers
- [Sitrec User Interface](UserInterface.md): menus, windows and measurements
- [Saving and Loading](SavingAndLoading.md)
- [Keyboard Shortcuts](KeyboardShortcuts.md)
