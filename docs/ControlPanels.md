# Shared controls and native widget panels

New UI (NUI) panels use native HTML. Existing UI (OUI) menus continue to use lil-gui.
They share control state and edit behavior through an adapter; changing presentation must
not change a scene's values, callbacks, units, saved data, or investigation workflow.

## Separate hosting, binding and rendering

- `WidgetPanel.js` composes widgets from an ordered definition, manages visibility,
  recovery and lifecycle, and supplies placement menus.
- `WidgetDocking.js` provides native panel hosts: title, content, collapse, drag, float,
  left/right dock, bounds, serialization and disposal. It creates no lil-gui objects.
  A small surface adapter shares the existing `PageStructure` docking rails with OUI.
- `ControlAdapter.js` is the compatibility boundary around an existing OUI controller.
  It exposes values, labels, units, choices, availability and edit operations. Source
  callbacks and numeric behavior remain authoritative during this migration.
- `NativeControls.js` renders native checkboxes, M/L pairs, buttons, text, choices and
  numeric fields/sliders. `bindControl(adapter, group)` consumes the common binding
  contract; `mirrorControl(source, group)` wraps an existing OUI source as a convenience.

Host selection and control rendering are separate decisions. Replacing a slider renderer
must not require replacing a panel host or changing saved scene data. New NUI code must
not construct lil-gui folders or manipulate its DOM; legacy knowledge belongs in adapters.

## Declarative compositions

`SatelliteWidgets.js` defines the Satellite Controls composition and its satellite-specific
widgets. `ViewingWidgets.js` defines time, observer, camera, layout and information widgets.
A definition names a widget type, with an optional stable instance ID, initial collapse
state, children, and an information-overlay home:

```js
const definition = {
    id: "satellite-controls",
    title: "Satellite Controls",
    widgets: ["time", "observer", "camera", "satelliteData", "satelliteFilters"],
};
const registry = {
    time: {
        title: "Time & playback",
        mount: ({body, context}) => {
            const editor = context.dateTime.createTimeEditor(body);
            return {dispose: () => editor.dispose()};
        },
    },
    // Other content factories use the same mount contract.
};
```

Content factories receive a body and scene context, and can return `setActive` and
`dispose` hooks. They do not own docking or copy scientific state. Widget IDs are saved
independently of titles. The initial Satellite context supplies one instance of each
control widget; repeating a widget within that context needs scoped bindings first.

`CNodeStarlinkUI` remains the saved-scene compatibility owner. Its `visible` and `expanded`
fields retain their meaning. Its `widgetState` stores presentation only. The existing node
ID remains unchanged. Older scenes without widget layout use the familiar left panel.
Opening a composition does not load a catalog, enable Live, or move a camera.

Every widget and the complete composition can float or dock. Placement menus offer named
commands so dragging is optional. Extracted widgets leave a return control at their home;
View → Control Panels can reopen them. Restore control arrangement resets presentation,
not scene state. Master visibility hides all owned widgets while preserving placement;
collapsing the composition keeps detached widgets and information widgets available.
Opening an individual widget from the recovery menu does not force open the composition.

## Binding controls

```js
import {createNativeControlGroup, mirrorControl,
        setNativeControlGroupActive} from "./NativeControls";
const group = createNativeControlGroup(container, {onChange: markSitchDirty});
mirrorControl(sourceController, group, {name: "Altitude", unitLabel: true}).noSlider();
setNativeControlGroupActive(group, false);
// On permanent removal:
group.destroy();
```

The adapter forwards actual source callbacks and completion hooks. Labels, choices, ranges,
units, disabled states and externally changed values refresh from the source. Numeric
formatting does not round the underlying value. Hidden groups stop polling. Native controls
isolate their keys from scene shortcuts and share checkbox drag painting with OUI.

The first native slice covers the controls used by Satellite Controls. Color controls,
BigSlider and other compound editors remain on OUI until their contracts and parity checks
are implemented. Source discovery still uses the existing controller lifetime; automatic
reconnection after source replacement is a separate migration step.

## Density and compatibility

Use the existing menu footprint for equivalent controls: current rails are 250px wide,
ordinary native rows are 22px, and widget headers are 24px. Do not impose a universal large
form layout. Floaters scroll within the viewport, and small-screen rails overlay the view.
Compact information widgets reuse existing readouts; satellite counting has one producer.

`ModernControlStyle.js` supplies shared dark/light tokens. `WidgetPanelStyle.js` supplies
native shells and specialized forms. `StarlinkPanelStyle.js` only places the launcher and
sky readouts. Existing custom object/track windows still use `ModernControls.js` and
`MenuMirror.js`; these are the legacy presentation path, not the basis for new NUI widgets.
Their keyed `shareAs`/`addMirror` connections and ordinary controller APIs remain intact.

`CNodeDateTime.createTimeEditor(container)` remains the shared native date/time editor for
OUI and NUI. It uses the existing date setters, pause/edit/undo methods and zone/speed
controls. A scrub is one undo step. Tab/Shift+Tab still cycles through date/time digits.
The editor has no separate serialized clock or zone state; dispose it with its host.

## Incremental migration

Inventory direct controller construction, prototype patches, DOM access, private fields,
callback interception and serialization before replacing an OUI feature. Introduce a
stable interface at each boundary, then switch individual control types or instances.
Preserve public controller paths and scene formats while legacy callers remain.

For each replacement, compare OUI/NUI value changes, callback counts, finish/undo behavior,
disabled state, units, keyboard/pointer gestures, saved restoration, disposal and occupied
space. A successful new appearance alone is not sufficient evidence of compatibility.
