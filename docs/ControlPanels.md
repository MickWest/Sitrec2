# Shared controls and modern panels

Sitrec's menus, custom edit windows, view-header widgets and satellite sidebar can present
the same control. Define its state, label, tooltip, range, units and callbacks once, on the
source lil-gui controller. Presentations should reuse that controller through `MenuMirror`.

## Embedding controls in an HTML panel

`src/ModernControls.js` supplies a styled control group that fits inside an HTML container:

```js
import {createControlGroup, setControlGroupActive} from "./ModernControls";

const group = createControlGroup(container, {onChange: markSitchDirty});
sourceController.mirrorTo(group, {listen: true});

// A hidden panel need not participate in the application's listener walk.
setControlGroupActive(group, false);
setControlGroupActive(group, true);

// Destroy the group when its owning panel closes permanently.
group.destroy();
```

The mirrored control is a real lil-gui controller. Numeric entry, drag, wrapping, elastic
ranges, unit conversion, dropdowns and keyboard input use the existing implementation.
Native form keys in embedded groups stay in the form rather than becoming scene shortcuts.
Use `beforeEdit` for a context-specific action, such as leaving Free Look before a heading
edit. Zoom edits can remain available during Free Look.

Use `source.shareAs(key)` and `group.addMirror(key)` when the source and presentation are
created independently. Keyed consumers reconnect if the source is rebuilt. Use `mirrorTo`
when the source already exists and shares the panel's lifetime. An optional `name` or
`tooltip` override is for deliberate contextual wording; defaults follow the source.
For a shorter label that retains live units, use
`source.mirrorTo(group, {name: "Altitude", unitLabel: true})`. This uses the source's unit
type and configured abbreviation; the shared source still owns all value conversion.

## Shared behavior

`src/MenuMirror.js` connects both forms of mirror. A change runs the source controller's
current callback and source-folder hooks. Finish callbacks are forwarded too, so text parsing
and edit completion have the same behavior from every presentation. Later changes to labels,
help, visibility, disabled state, choices, steps and ranges propagate to the mirrors. Direct
state changes from scripts or saved scenes are reflected through `.listen()`.

Closing a mirror removes its connection. Destroying a source removes its mirrors. M/L pairs
and folder-header checkboxes retain their existing implementations and serialization.

## Shared appearance

`src/ModernControlStyle.js` contains the scoped panel colors and control styles, with dark
and light themes. `applyModernControls(gui)` applies them to an existing GUI without changing
its layout, callbacks or menu identity. Custom object and track edit windows use this path.
Ordinary menu-bar controls retain their compact layout.

`CNodeStarlinkUI` supplies the satellite panel's arrangement, visibility, collapse state,
observer/time editors and readouts. Its altitude, satellite, guide and camera controls are mirrors.
`StarlinkPanelStyle.js` contains only that panel's layout and specialized HTML styling,
using the shared colors. Domain calculations and catalog loading remain in their existing
nodes. The clock/readouts keep a timer because paused scenes can stop rendering.

When adding another panel, prefer a mirror before creating a custom input. Keep specialized
workflows, such as a combined date/time editor, separate from shared property controls.

`CNodeDateTime.createTimeEditor(container)` mounts the reusable `TimeEditor` used by the
Time menu and satellite panel. Its adapter reads the node and uses its date setters,
pause/edit/undo methods and existing zone/speed controllers. `TimeEditing.js` handles only
wall-clock parsing and component arithmetic with explicit offsets. Call `dispose()` when
the host is removed. The editor coalesces pointer movement to one time update per animation
frame, treats a scrub as one undo step, and refreshes only while visible. It has no separate
serialized clock or time-zone state.
