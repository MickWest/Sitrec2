# Dynamic GUI Mirroring

Sitrec uses two related layers for GUI mirroring:

- [`src/MenuMirror.js`](../../src/MenuMirror.js) clones an individual lil-gui controller. The
  source and twin bind to the same `object[property]`, and the helper copies controller type,
  label, tooltip, range, units, visibility, options, and relevant callbacks. Its keyed
  `shareAs()`/`addMirror()` API is used when independently built menus need the same control.
- [`src/CustomManagerMirror.js`](../../src/CustomManagerMirror.js) manages a whole-folder mirror
  in a draggable standalone menu. It uses `GUI.mirrorFolderFrom()` from `MenuMirror.js` for the
  controller clones, then rebuilds the folder when supported structural or visibility changes
  are detected.

Whole-folder mirroring is part of the shipping UI. Object, building, cloud, overlay, track, and
video-adjustment edit/context menus use `setupDynamicMirroring()` or `showNodeEditMenu()`.
The convenience methods `mirrorGUIFolder()`, `mirrorNodeGUI()`, and `createDynamicMirror()` are
also useful from the browser console.

## Initialization Requirements

Call these methods only after Sitrec has created `Globals.menuBar`. A menu mirror also requires
the named `guiMenus` entry to exist; a node mirror requires `NodeMan` and the node's GUI to have
been created. Normal browser-console use after a sitch finishes loading satisfies these
requirements.

`CustomManagerMirror.js` exports `mirrorMethods`, which `CustomSupport.js` mixes into
`CCustomManager.prototype`. The running instance is exposed as `window.CustomManager`.

## Convenience API

### Mirror a Top-Level Menu

```javascript
const objectsMirror = CustomManager.mirrorGUIFolder(
    "objects",
    "Objects Mirror",
    300,
    100,
);
```

`mirrorGUIFolder(sourceFolderName, menuTitle, x = 200, y = 200)` looks up
`guiMenus[sourceFolderName]`, creates a persistent standalone menu, installs dynamic mirroring,
opens it, and returns the GUI. It reports an error and returns `null` when the source menu is
missing.

The source name is the internal menu ID such as `objects`, `effects`, `view`, or `camera`, not
the translated title displayed to the user.

### Mirror a Node's `gui`

```javascript
const nodeMirror = CustomManager.mirrorNodeGUI(
    "myObjectNode",
    "Object Controls",
    500,
    150,
);
```

`mirrorNodeGUI(nodeId, menuTitle, x = 200, y = 200)` resolves the node with `NodeMan.get(nodeId)`
and mirrors `node.gui`. Use an existing node ID: the manager asserts on a missing ID in a
development build. This convenience method does not fall back to `node.guiFolder`; use
`showNodeEditMenu()` or pass the folder to `setupDynamicMirroring()` for those nodes.

### Dispatch by Source Type

```javascript
const menuMirror = CustomManager.createDynamicMirror(
    "menu",
    "objects",
    "My Objects",
    200,
    100,
);

const nodeMirror = CustomManager.createDynamicMirror(
    "node",
    "myNode",
    "My Node",
    300,
    200,
);
```

`createDynamicMirror(sourceType, sourceName, title, x = 200, y = 200)` dispatches to the two
methods above. `sourceType` must be `"menu"` or `"node"`; another value logs an error and
returns `null`.

## Shipping Edit Menus

`showNodeEditMenu(node, clientX, clientY)` is the shared entry point for object edit windows.
It:

- uses `node.guiFolder`, or an object-valued `node.gui` as a fallback;
- creates a persistent standalone menu;
- installs dynamic mirroring;
- enables object editing and its move widget for `CNode3DObject` instances;
- opens the menu and places it clear of the invocation point; and
- clears the editing-object state when the menu is destroyed.

It returns the standalone GUI, or `null` when the node has no usable GUI or menu creation is
blocked.

Other context-menu paths already create their own standalone GUI and call the lower-level API:

```javascript
const menu = Globals.menuBar.createStandaloneMenu("Track", x, y, true);
if (menu) {
    CustomManager.setupDynamicMirroring(track.guiFolder, menu);
    menu.open();
}
```

The fourth `createStandaloneMenu()` argument controls outside-click dismissal. Persistent edit
menus normally pass `false`; short-lived context menus pass `true`.

## Refresh and Cleanup

Mirrors returned by `mirrorGUIFolder()` and `mirrorNodeGUI()` get a convenience method:

```javascript
const mirror = CustomManager.mirrorGUIFolder("objects", "Objects Mirror");
mirror?.refreshMirror();
```

`refreshMirror()` calls `updateMirror()`. It rebuilds only when the current GUI signature differs
from the last one. A menu wired directly with `setupDynamicMirroring()` does not receive this
convenience method; call `CustomManager.updateMirror(menu)` instead.

Destroy a standalone mirror through its normal `destroy()` method:

```javascript
mirror?.destroy();
```

The installed destroy wrapper unregisters the standalone GUI root, clears a fallback polling
interval when present, runs the recorded event-hook cleanup, and then destroys the GUI.

## What Stays Synchronized

`setupDynamicMirroring(sourceFolder, standaloneMenu)` performs an initial clone and registers the
standalone menu as a polled GUI root. Each controller clone binds to the same object and property
as its source. `MenuMirror` wires changes in either controller through the source's side effect,
and whole-folder clones force `.listen()` on both ends so direct writes from code or 3D handles
are reflected during the render loop.

`CustomManagerMirror` separately watches folder structure and visibility. It wraps supported
lil-gui operations (`add`, `addColor`, `addFolder`, `remove`, controller destruction, and
`show`) and schedules `updateMirror()` for the next task. If installing those hooks throws, it
falls back to checking the signature every 100 ms.

The signature contains:

- controller names, runtime types, and hidden/visible state; and
- nested folder titles, open/closed state, hidden/visible state, and recursive contents.

When the signature changes, the standalone contents are destroyed and recreated in source DOM
order through `GUI.mirrorFolderFrom()`.

The event hooks do not observe every possible in-place mutation. In particular, changing only a
label, tooltip, option list, or folder open state does not by itself schedule a whole-folder
signature check. Keyed single-controller mirrors have stronger propagation for names,
visibility, and dropdown options. For a whole-folder source that mutates unsupported metadata,
call `updateMirror()` after the mutation or rebuild through a supported structural operation.

## Single-Controller Mirroring

Do not create a whole standalone folder when one control needs to appear in a second menu. Use
the keyed API from `MenuMirror.js`:

```javascript
sourceController.shareAs("view:lookView:labels");
headerMenu.addMirror("view:lookView:labels", {
    name: "Labels",
});
```

Registration and subscription are order-independent. The target must be a polled root; see
[`src/GUIRootRegistry.js`](../../src/GUIRootRegistry.js). Register the source after its
`.name().tooltip().onChange()` chain so `shareAs()` captures its finished side effect.

For a one-off controller clone when both controllers are already in hand:

```javascript
sourceController.mirrorTo(targetMenu);
```

See the header comments in `MenuMirror.js` for lifecycle and rebuild details.

## Multiple Console Mirrors

Only one persistent standalone menu is tracked at a time. Creating another persistent
standalone menu destroys the previous one. If several controls must coexist, mirror one common
folder or build a single standalone target and mirror the desired controllers into it.

## Tests

Run the mirroring tests directly:

```bash
npx jest tests/dynamic-mirroring.test.js tests/MenuMirror.test.js tests/PanAzimuth360.test.js --runInBand
```

`tests/dynamic-mirroring.test.js` models the whole-folder orchestration with test doubles.
`tests/MenuMirror.test.js` and `tests/PanAzimuth360.test.js` exercise the real controller-mirror
implementation, including type fidelity, callbacks, ranges, and wrapping.

## Troubleshooting

### The Source Cannot Be Found

Use the internal `guiMenus` ID, and wait until the menu or node has been constructed. Check a
node with `NodeMan.exists(id)` before calling the node convenience method.

### Values Do Not Follow Code or a 3D Handle

The standalone GUI must remain registered as a root so `.listen()` controllers are polled.
Always use `setupDynamicMirroring()` rather than calling `mirrorFolderFrom()` alone for a
floating edit menu.

### Structure Does Not Update

Call `mirror.refreshMirror()` for a convenience mirror, or
`CustomManager.updateMirror(standaloneMenu)` for a directly wired menu. If a new kind of source
mutation needs automatic support, add a focused hook and test rather than shortening the
100 ms fallback interval globally.

### A Second Popup Closes the First

This is expected for persistent standalone menus. `createStandaloneMenu()` enforces a single
active persistent menu and a single active context menu.
