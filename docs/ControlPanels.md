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
    titleKey: "panels.satellite.title",
    widgets: ["time", "observer", "camera", "satelliteData", "satelliteFilters"],
};
const registry = {
    time: {
        titleKey: "panels.widgets.time.title",
        mount: ({body, context}) => {
            const editor = context.dateTime.createTimeEditor(body);
            return {dispose: () => editor.dispose()};
        },
    },
    cameraInfo: {
        titleKey: "panels.widgets.cameraInfo.title",
        html: `<small data-id="heading"></small>`,
        mount: ({context, scope}) => ({update: () => {
            scope.el("heading").textContent = compassHeading(context.ptz.az);
        }}),
    },
    // Other content factories use the same mount contract.
};
```

A definition can also merge related widget types into one combined widget. `merge` names
the types whose content follows the content of `type`, in the same host:

```js
widgets: ["time", "observer", {type: "camera", merge: ["aim"], collapsed: false}],
```

The combined widget has the title, the instance ID and the saved layout entry of `type`.
Each merged type keeps its own content factory and its own hooks, so the same type can
still be a separate widget in a different composition. Use `merge` when a type has only
one or two controls that belong with a larger widget.

### Self-contained widgets

A content factory is `mount({host, body, context, scope})`. It does not own docking and it
does not copy scientific state.

- `context` is the scene side: the nodes, the sources of the existing controls, and shared
  status such as `satelliteStatus()`. `CNodeStarlinkUI` is the context of Satellite Controls.
- `scope` belongs to one mounted body. `scope.el(id)` finds an element of this body by its
  `data-id`. `scope.group(id, options)`, `scope.control(...)` and `scope.mirror(...)` make
  native control groups and controls in this body. Two instances of one widget type thus
  do not share elements or groups, and both show the values of the same sources.
- `mount` returns its hooks. `update()` refreshes the elements of the widget from the scene.
  `scope.lifecycle({update})` adds `setActive` and `dispose` for the control groups.

The panel calls `update()` only for widgets that are in view, and one time when a widget
comes into view. The context does not write to the elements of a widget. A composition can
thus use any subset of the widget types, and can use a type more than one time with
different instance IDs. Widget IDs are saved independently of titles.

`CNodeStarlinkUI` remains the saved-scene compatibility owner. Its `visible` and `expanded`
fields retain their meaning. Its `widgetState` stores presentation only. The existing node
ID remains unchanged. Older scenes without widget layout use the familiar left panel.
Opening a composition does not load a catalog, enable Live, or move a camera.

Every widget and the complete composition can float or dock. Placement menus offer named
commands so dragging is optional. Extracted widgets leave a return control at their home;
View → Control Panels can reopen them. Restore control arrangement resets presentation,
not scene state. Master visibility hides all owned widgets while preserving placement;
collapsing the composition keeps detached widgets and information widgets available.
The master visibility control is the Satellite Controls checkbox. It is the first row of
the Satellites menu.

`CCustomManager.setup()` makes the `CNodeStarlinkUI` node in each custom sitch, new or
saved. It is not a node definition in `SitCustom.js`. A sitch definition shows the panel
at the start with `showSatelliteControls: true`, and asks for the sky layout with
`startSkyLayout: true`.

A command in View → Control Panels shows one widget where it is: at home, in a rail or in a
float. It does not force open the composition. A widget that is at home in a collapsed
composition has no place to show, so the command floats it. Each new float starts a step
down and to the right of the float before it.

## Text and localization

All text of a native panel is in `src/i18n/en.js`: section `timeEditor` for the date and
time editor, and section `panels` for the widget hosts, the widgets and Satellite Controls.

- A template has no text. An element names its strings with keys: `data-i18n` (its text),
  `data-i18n-title` (its tooltip), `data-i18n-placeholder` and `data-i18n-label` (its
  `aria-label`). `localizeElements(root)` in `NativeText.js` fills them. `WidgetPanel` calls
  it for the `html` of each widget type.
- A definition, a widget type or a composition entry gives its title as `titleKey`. Fixed
  text in `title` is for tests and for names that are not translated.
- Code that makes text at run time calls `t(key, values)` from `i18n`, with `{{name}}`
  placeholders in the string for the values.
- A control that mirrors an OUI source shows the name and tooltip of that source, which are
  already localized. Give a `name` option only when the panel needs a different name.

## Usage log

`UILogging.js` records which control a user clicks, as a path. A menu control has the path of
its menu titles and its label. A native control has the path of its panel, its widget and its
label, for example `Satellite Controls/Time & playback/Edit Start`. `WidgetPanel` writes the
path of each widget host to `data-widget-path`. The path is that of the home of the widget, so
it does not change when the widget moves to a rail or to a float. The date and time editor in
the Time menu has the path of the menu, for example `Time/Edit Start`. A new native surface
that is not in a widget must be in an element with `data-widget-path` to be recorded.

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
share checkbox drag painting with OUI.

## Keys and scene shortcuts

`NativeKeyRouting.js` decides who gets a key press when the focus is in a native surface.
The rule is the same as in OUI menus:

- A text or number field keeps its keys.
- After a click on any other control (a checkbox, button, selector, slider or widget title),
  the next key press is a scene shortcut. The control loses focus, its own key action is
  cancelled, and the event continues to the document handler. Space plays, and comma and
  period step a frame, as they do after a click in an OUI menu.
- After Tab moved the focus to a control, that control keeps its keys. A panel can then be
  operated with the keyboard only. A pointer press ends this state.

A new native surface calls `routeNativeKeys(rootElement)`. A key handler on a control that
is not a text field calls `releaseKeyToScene(event)` first and returns when the result is
true. OUI forms that carry `data-interaction-native` use the same rule through
`panelKeepsKey(event)`.

## Shared rails

Menus, native widgets and docked views (Notes, text views and other dockable views) use
the same left and right rails. A menu or a widget registers with the rail. A docked view
does not: `CNodeView` appends its element to the rail. A hidden widget keeps its position
and gives up its space, so a rail closes when hidden widgets are all that it shows. A rail
stays open while a menu, a visible widget or a visible docked view is in it. Code that adds,
removes, shows or hides a rail occupant calls `refreshSidebarVisibility()`.

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
