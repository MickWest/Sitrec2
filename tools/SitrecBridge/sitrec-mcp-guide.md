# Sitrec MCP Agent Guide

Reference for AI agents interacting with Sitrec via the SitrecBridge MCP server.

## Architecture Overview

Sitrec is a 3D situation recreation app built with Three.js. It uses a **node-based computational graph** where everything — tracks, cameras, effects, UI — is a node.

**Message path:** MCP Client (stdio) -> MCP Server (WebSocket :9780+N) -> Chrome Extension (background.js) -> Content Script -> Page Bridge (page-bridge.js, main world) -> Sitrec globals.

### Multi-sandbox isolation
Each MCP server runs as its own WebSocket primary on a unique port in 9780–9799. Sandboxes launched via `wt sandbox` get a deterministic pairing: build port `8080+N` ↔ MCP port `9780+N`, with the sandbox advertising `pairedOrigin: http://localhost:80NN`. The Chrome extension scans the port range, opens a connection to each MCP server, and routes commands to the tab whose origin matches the originating server's `pairedOrigin`.

A host-side Claude session (no `SITREC_BRIDGE_PAIRED_ORIGIN` set) becomes a **fallback** server: it scans 9799→9780 for the first free port (descending so it never steals a sandbox's reserved low port), advertises `pairedOrigin: null`, and the extension routes any tab not matched by another MCP to it.

Use `sitrec_status` to see this server's `pairedOrigin`, `boundPort`, and whether the extension is connected. If your tab's origin doesn't match any paired server, an explicit error tells you which origin the server is paired to.

### Deferred tool discovery
Some Codex sessions expose only a subset of SitrecBridge tools at first. If `sitrec_eval`, `sitrec_api_call`, or another expected `sitrec_*` tool is missing from the callable namespace, run tool discovery/search for the missing tool name (for example, search `sitrec_bridge sitrec_eval sitrec_api_call`). The bridge may already advertise the tool, but Codex has not lazy-loaded its schema yet.

### Multi-tab support within a paired origin
Multiple Sitrec tabs at the *same* origin (e.g. two `localhost:8080` tabs) share one MCP server. Use `sitrec_list_tabs` to see all open Sitrec tabs with their IDs, URLs, and origins. Pass the `tab` parameter on any tool to target a specific tab:

- **By URL substring:** `tab: "build2"` — matches the first tab whose URL contains "build2"
- **By numeric tab ID:** `tab: 361294686` — targets an exact Chrome tab ID
- **Omit `tab`:** defaults to the first matching tab for this server's `pairedOrigin`

## Key Globals (accessible via `sitrec_eval`)

| Global | Type | Description |
|--------|------|-------------|
| `NodeMan` | CNodeManager | All nodes. `get(id)`, `iterate((id, node) => {})` |
| `Sit` | CSituation | Current sitch config: `name`, `frames`, `fps`, `lat`, `lon`, `startTime` |
| `par` | object | Runtime state: `frame`, `paused`, `renderOne`, `speed` |
| `Globals` | object | Managers: `SitchMan`, `ViewMan`, `GPUMemoryMonitor` |
| `ViewMan` | CViewManager | View layout. `setVisibleByName(name, vis)`, `updateViewFromPreset()` |
| `LocalFrame` | object | ENU coordinate origin for the current sitch |
| `GlobalScene` | THREE.Scene | Main 3D scene |
| `sitrecAPI` | CSitrecAPI | Chatbot API. `call(fn, args)`, `handleAPICall({fn, args})` |
| `guiMenus` | object | All lil-gui menu folders, keyed by menu ID |

## Node System

### CNode Base

Every node has:
- `id` — unique string identifier
- `inputs` — dict of named input nodes
- `outputs` — array of output nodes
- `visible` — node-level visibility (NOT Three.js visibility)
- `getValue(frame)` — compute value at frame
- `simpleSerials` — array of property names for serialization

### Common Node Types (172 total)

**Data:** `CNodeConstant`, `CNodeArray`, `CNodeMISBDataTrack`, `CNodeDateTime`
**Tracks:** `CNodeSmoothedPositionTrack`, `CNodeJetTrack`, `CNodeSatelliteTrack`, `CNodeTrackFromMISB`
**Display:** `CNodeDisplayTrack`, `CNodeDisplayLOS`, `CNodeDisplayCameraFrustum`, `CNodeDisplayNightSky`
**Views:** `CNodeView3D`, `CNodeVideoWebCodecView`, `CNodeMirrorVideoView`, `CNodeViewDAG`, `CNodeViewChat`
**GUI:** `CNodeGUIValue`, `CNodeGUIFlag`, `CNodeGUIColor`, `CNodeTrackGUI`
**Controllers:** `CNodeControllerTrackPosition`, `CNodeControllerObjectTilt`, `CNodeControllerPTZUI`
**LOS:** `CNodeLOSFromCamera`, `CNodeLOSTraverse`, `CNodeLOSTraverseStraightLine`, `CNodeLOSTraverseWind`
**3D:** `CNode3DObject`, `CNode3DGroup`, `CNodeCamera`, `CNodeTerrain`
**Math:** `CNodeMunge`, `CNodeScale`, `CNodeMath`, `CNodeDerivative`
**Switches:** `CNodeSwitch` — selects between inputs by `choice` property

### Track Data Structure

Each imported aircraft creates ~6+ nodes:
- `TrackData_<ID>` (CNodeMISBDataTrack) — raw MISB data, `.misb` is array of rows
- `Track_<ID>_unsmoothed` (CNodeTrackFromMISB) — position track from MISB
- `Track_<ID>` (CNodeSmoothedPositionTrack) — smoothed track
- `<ID>_ob` (CNode3DObject) — 3D object at track position
- `<ID>_ob_ControllerTrackPosition` — moves object along track
- `Track_<ID>_GUI` (CNodeTrackGUI) — GUI controls

### CNodeTrackGUI

The GUI node for each track. Key properties:
- `metaTrack` — the CMetaTrack wrapper
- `metaTrack.guiFolder` — lil-gui folder with controllers

**Important controllers in `guiFolder.controllers`:**
- `visible` — show/hide track (the correct way to toggle visibility)
- `gotoTrack` — move mainCamera to track position
- `showTrackInLook` — show in look view
- `extendToGround` — draw line to ground
- `lineColor`, `polyColor` — track colors
- `contrail`, `contrailDuration`, `contrailWidth` — contrail settings

**To hide a track properly:**
```js
const gui = NodeMan.get("Track_<ID>_GUI");
gui.metaTrack.guiFolder.controllers.find(c => c.property === 'visible').setValue(false);
```
Setting `node.visible = false` or `container.visible = false` does NOT work — you must use the lil-gui controller's `setValue()` to trigger the full visibility chain (layer masks, display nodes, etc.).

### MISB Data Format

`CNodeMISBDataTrack.misb` is an array of rows (arrays). Key column indices:
- `[2]` — timestamp (ms since epoch)
- `[13]` — latitude (degrees)
- `[14]` — longitude (degrees)
- `[15]` — altitude

### Track getValue() Return Format

`CNodeSmoothedPositionTrack.getValue(frame)` returns:
```js
{
  position: Vector3,   // ENU coordinates (local frame)
  lla: [lat, lon, alt], // Note: may be in internal scaled units, not degrees
  misbRow: Array       // Raw MISB row (indices 13/14 = lat/lon in degrees)
}
```

### CNodeSwitch

Used for selecting between inputs. Key property: `choice` (string matching an input key).
Example: `zoomToTrack` node — set `choice` to a track name to make mainCamera follow it.

## Layer System

Visibility in 3D views is controlled by layer bit masks, not `node.visible`.

| Layer | Bit | Purpose |
|-------|-----|---------|
| WORLD | 0 | All normal 3D objects |
| LEFTEYE | 1 | VR left eye |
| RIGHTEYE | 2 | VR right eye |
| MAIN | 3 | Main camera only |
| LOOK | 4 | Look camera only |
| HELPERS | 5 | Debug lines (main view) |
| TARGET | 6 | Target objects |

**Composite masks:** `MASK_MAINRENDER = WORLD|MAIN|TARGET|HELPERS`, `MASK_LOOKRENDER = WORLD|LOOK|TARGET`

## Sitrec API (sitrecAPI)

72 functions accessible via `window.sitrecAPI.call(fn, args)`. Type coercion is automatic (strings -> numbers).

### Camera & Navigation
- `gotoLLA({lat, lon, alt})` — move camera position
- `setCameraAltitude({alt})` — altitude only
- `getCameraLLA()` — returns {lat, lon, alt}
- `pointCameraAtRaDec({ra, dec})` — point at sky coordinates
- `pointCameraAtNamedObject({object})` — point at planet/Moon/Sun

### Playback
- `getFrame()`, `setFrame({frame})`, `play()`, `pause()`, `togglePlayPause()`
- `getCurrentSimTime()`, `getRealTime()`, `setDateTime({dateTime})`

### Notes & Sitches
- `getNotes()`, `setNotes({text})`, `updateNotes({mode, text})`
- `listSitches()` — lists built-in sitches and any saved sitches available in the current runtime
- `loadSitch({name, source, sourceUserID})` — load a saved sitch (built-in sitches with setup hooks are rejected)
- `saveSitch({target, name})` — save to `auto`, `server`, or `local` (`name` required if sitch not previously saved)
- `getShareLink({saveIfNeeded, target})` — returns the current share link (re-saves if dirty and `saveIfNeeded`)
- `getSitchState()` — lightweight status: `{name, dirty, isCustom, canMod}`
- `exportSitchState({local})` — exports full serialized sitch JSON state

### Satellites
- `satellitesLoadLEO()`, `satellitesLoadCurrentStarlink()`
- `satellitesShow/HideStarlink()`, `Show/HideISS()`, `Show/HideBrightest()`, `Show/HideOther()`
- `satelliteLabelsOn/Off()`, `satelliteLookViewNamesOn/Off/Toggle()`
- `findSatellite({name})`, `listCelestialObjects()`
- `satellitesFlareRegionOn/Off()`

### 3D Objects
- `addObjectAtLLA({lat, lon, alt, name})`
- `listObjectFolders()`, `listAvailableModels()`, `listAvailableGeometries()`
- `setObjectModel({object, model})`, `setAllObjectsModel({model})`
- `setObjectGeometry({object, geometry})`, `setAllObjectsGeometry({geometry})`
- `setObjectDimensions({object, width, height, depth})`

### Menu Controls
- `listMenus()`, `listMenuControls({menu})`
- `setMenuValue({menu, path, value})`, `getMenuValue({menu, path})`
- `executeMenuButton({menu, path})`

Path can be nested with `/` separator. Matching is flexible (case-insensitive, substring).

### Views & Layout
- `listViews()`, `showView({view})`, `hideView({view})`
- `setViewPosition({view, left, top, width, height, visible})`
- `setLayout({template, views})` — templates: columns, rows, leftWide, rightWide, grid, single
- `hideMenu()`, `showMenu()`, `hideTimeline()`, `showTimeline()`
- `hideChrome()`, `showChrome()`, `toggleFullscreen()`

### Debug
- `debug({show})` — toggle debug mode

## View System

Common views: `mainView`, `lookView`, `video`, `mirrorVideo`, `chatView`, `debugView`, `dagView`, `notesView`

Views are positioned using fractional coordinates (0-1) for `left`, `top`, `width`, `height`.

**CNodeView3D** has:
- `renderer` — Three.js WebGLRenderer
- `camera` — PerspectiveCamera (the view's own camera, e.g., CNodeCamera)
- `renderSky()`, `renderCanvas()`, `renderTargetAndEffects()` — render pipeline

**Screenshot capture:** `sitrec_screenshot` composites all visible views and overlays into a single image by default (same as "Render Viewport Video"). Pass `view: "mainView"` or `view: "lookView"` to capture a single view instead. Works with `preserveDrawingBuffer=false` because it re-renders synchronously before capture.

**Video frame capture:** `sitrec_get_video_frame` captures the raw decoded video frame (before any view rendering, overlays, or effects) from the `video` node's `videoData.getImage()`. Useful for analyzing source video content. Defaults to the current playback frame; pass `frame` to capture a specific frame.

## Camera System

Two main cameras:
- **`mainCamera`** (CNodeCamera) — orbital camera for the 3D globe/overview. `goToPoint(vec3)` to move.
- **`lookCamera`** (CNodeCamera) — the analysis camera. Controlled by `CameraLOSController` switch.

`fixedCameraPosition` (CNodePositionLLA) — the observer's geographic position. `gotoLLA()` changes this.

`zoomToTrack` (CNodeSwitch) — set `choice` to a track name to attach mainCamera to that track.

## MetaTrack (CMetaTrack)

Wrapper managing a complete track lifecycle:
- `trackNode` — position track
- `trackDataNode` — raw data
- `trackDisplayNode` / `trackDisplayDataNode` — renderers
- `displayTargetSphere` / `displayCenterSphere`
- `guiFolder` — lil-gui GUI folder (has `visible`, `gotoTrack`, etc.)
- `show(visible)` — toggle center/sphere display (NOT the track lines)
- `dispose()` — clean up all nodes

## par Object (Runtime State)

Key properties:
- `frame` (getter/setter) — current frame number
- `paused` — playback state
- `renderOne` — set `true` to force single frame render
- `speed` — playback speed multiplier
- `direction` — 1 or -1
- `showVideo`, `showGraphs`, `showJet` — visibility toggles
- `mainFOV` — main camera field of view
- `az`, `el` — azimuth/elevation angles
- `TAS` — true airspeed

## Sit Object (Situation Config)

- `name`, `menuName`, `isCustom`, `canMod`
- `frames`, `fps`, `startTime`
- `lat`, `lon`, `alt` — sitch center coordinates
- `mainFOV`, `lookFOV`, `nearClip`, `farClipLook`
- `startDistance`, `targetSpeed`
- `files` / `files2` — asset files
- `units` — "Nautical", "Metric", etc.
- `lighting` — `{ambientIntensity, sunIntensity, sunScattering, ambientOnly}`
- `nightSky`, `starScale`, `satScale`

## Common Patterns

### Iterating all nodes of a type
```js
NodeMan.iterate((id, node) => {
    if (node.constructor.name === 'CNodeMISBDataTrack') { ... }
});
```

### Getting a node value
```js
const track = NodeMan.get("Track_N117AN");
const val = track.getValue(par.frame); // {position: Vector3, lla, misbRow}
```

### Controlling a lil-gui controller
```js
const folder = NodeMan.get("Track_XXX_GUI").metaTrack.guiFolder;
const ctrl = folder.controllers.find(c => c.property === 'visible');
ctrl.setValue(false); // triggers onChange callbacks
```

### Agent-coded runtime additions

When asked to add something to the live scene, prefer Sitrec's existing managers, menus, and API paths over raw Three.js meshes. Raw meshes can render, but they will not serialize, show in menus, participate in edit modes, or clean up like native Sitrec objects.

Good order of operations:
- Use `sitrec_api_call` for public API operations such as `addObjectAtLLA`, `setObjectGeometry`, and `setObjectDimensions`.
- Use `sitrec_eval` for advanced manager/menu paths that are not public API functions yet.
- If a feature normally comes from a context menu, invoke the same context-menu path and call its controller action. This preserves normal creation behavior, undo wiring, GUI folders, edit mode, and serialization.
- Before opening a context menu to create a building, clouds, ground overlay, feature, or similar object, close any active edit menu/edit mode. The ground context menu intentionally does nothing while a building/clouds/overlay edit menu is open.
- After configuring an agent-created object, close its edit mode/menu unless the user explicitly asked to keep editing it. Leaving the edit menu open can block the next context-menu creation.
- After mutating runtime objects directly, set `par.renderOne = true` and take a JPEG screenshot to verify.

Some imported managers are module globals but are not exposed as `window` properties. For example, `Synth3DManager` may be usable inside application modules but not directly visible to `sitrec_eval`. In that case, drive it through an exposed path such as `CustomManager.showGroundContextMenu(...)`.

Reusable cleanup helper for MCP snippets:
```js
function closeAgentEditMenus() {
    if (Globals.editingBuilding?.setEditMode) Globals.editingBuilding.setEditMode(false);
    if (Globals.editingClouds?.setEditMode) Globals.editingClouds.setEditMode(false);
    if (Globals.editingOverlay?.setEditMode) Globals.editingOverlay.setEditMode(false);

    for (const key of ["groundContextMenu", "buildingEditMenu", "cloudsEditMenu", "overlayEditMenu"]) {
        if (CustomManager[key]?.destroy) CustomManager[key].destroy();
        CustomManager[key] = null;
    }
}
```

### Creating synthetic buildings

The right-click "Add Building" command creates a native `CNodeSynthBuilding` through `Synth3DManager.createBuildingAtPoint(groundPoint)`. From MCP, create the same building by opening the ground context menu at an ECEF point and calling the `addBuilding` controller. The new building is usually available as `Globals.editingBuilding`.

Example: create a 1 km x 1 km x 1 km synthetic building centered at a lat/lon:
```js
(() => {
    const centerLat = 33.15;
    const centerLon = -118.46;
    const size = 1000; // meters
    const half = size / 2;
    const metersPerDegLat = 111320;
    const metersPerDegLon = 111320 * Math.cos(centerLat * Math.PI / 180);
    const dLat = half / metersPerDegLat;
    const dLon = half / metersPerDegLon;

    function closeAgentEditMenus() {
        if (Globals.editingBuilding?.setEditMode) Globals.editingBuilding.setEditMode(false);
        if (Globals.editingClouds?.setEditMode) Globals.editingClouds.setEditMode(false);
        if (Globals.editingOverlay?.setEditMode) Globals.editingOverlay.setEditMode(false);

        for (const key of ["groundContextMenu", "buildingEditMenu", "cloudsEditMenu", "overlayEditMenu"]) {
            if (CustomManager[key]?.destroy) CustomManager[key].destroy();
            CustomManager[key] = null;
        }
    }

    // Use a local WGS84 conversion because LLAToECEF is not always exposed to sitrec_eval.
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const toRad = d => d * Math.PI / 180;
    function llaToVec(lat, lon, alt = 0) {
        const phi = toRad(lat), lam = toRad(lon);
        const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
        const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
        const x = (N + alt) * cosPhi * Math.cos(lam);
        const y = (N + alt) * cosPhi * Math.sin(lam);
        const z = (N * (1 - e2) + alt) * sinPhi;
        return NodeMan.get("mainCamera").camera.position.clone().set(x, y, z);
    }

    closeAgentEditMenus();
    const groundPoint = llaToVec(centerLat, centerLon, 0);
    CustomManager.showGroundContextMenu(100, 100, groundPoint, "mainView");
    const menu = CustomManager.groundContextMenu;
    const ctrl = menu?.controllers.find(c => c.property === "addBuilding");
    if (!ctrl?.object?.addBuilding) return { success: false, error: "Add Building controller not found" };

    ctrl.object.addBuilding();
    const building = Globals.editingBuilding;
    if (!building) return { success: false, error: "Building was not created" };

    building.name = "1km Synthetic Building";
    building.cornerLatLons = [
        { lat: centerLat - dLat, lon: centerLon - dLon },
        { lat: centerLat + dLat, lon: centerLon - dLon },
        { lat: centerLat + dLat, lon: centerLon + dLon },
        { lat: centerLat - dLat, lon: centerLon + dLon },
    ];
    building.roofAGL = size;
    building.rooflineHeightAGL = 0;
    building.ridgelineInset = 0;
    building.roofEaves = 0;
    building.recalculateVerticesFromTerrain();
    building.buildMesh();
    building.updateGUIControllers();
    building.setEditMode(false);
    closeAgentEditMenus();
    par.renderOne = true;

    return { success: true, id: building.buildingID, serialized: building.serialize() };
})()
```

For synthetic buildings, edit `cornerLatLons`, `roofAGL`, `rooflineHeightAGL`, `ridgelineInset`, and `roofEaves`, then call `recalculateVerticesFromTerrain()`, `buildMesh()`, and `updateGUIControllers()`. This keeps the building terrain-relative, editable, and serializable.

### Haversine distance (for finding nearest tracks)
```js
function distKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```
Use `node.misb[row][13]` / `[14]` for lat/lon in degrees (not `getValue().lla` which may be scaled).

### Changing the Time (startTime / nowTime)

Sitrec has two key time values:
- **`Sit.startTime`** — UTC time at frame 0
- **`Sit.nowTime`** — UTC time at the current frame

The relationship: `nowTime = startTime + (frame * simSpeed / fps)`, controlled by `Sit.simSpeed` (default 1) and `Sit.fps`.

The `dateTimeStart` node (`CNodeDateTime`) owns the authoritative time state. It caches the parsed start time internally — **setting `Sit.startTime` as a string does NOT propagate** to the rendering (sun position, sky, lighting will not update).

**Correct way to change the time:**
```js
(() => {
    const dt = NodeMan.get('dateTimeStart');
    dt.setStartDateTime(new Date("2022-09-19T12:00:00.000Z"));
    dt.recalculateCascade();
    return { startTime: Sit.startTime, nowTime: Sit.nowTime };
})()
```

`setStartDateTime()` updates the internal `dateStart`, recalculates `dateNow`, repopulates all UI fields (year/month/day/hour/minute/second), and triggers a render. `recalculateCascade()` propagates the change to all downstream nodes (sun position, lighting, night sky, satellite positions, etc.).

**Other time methods on `dateTimeStart`:**
- `setNowDateTime(date)` — set the time at the *current frame* (back-calculates startTime)
- `AdjustStartTime(ms)` — shift start time by milliseconds
- `resetStartTime()` — revert to the original start time from the sitch definition
- `resetNowTimeToCurrent()` — sync to the system clock

**Time zone:** The `dateTimeStart` node tracks a display time zone (`timeZoneName`, e.g., `"PDT UTC-7"`). This affects the UI display but all internal times are UTC. The time zone is auto-detected from the system or from the data source.

**Simulation speed:** `Sit.simSpeed` controls how many real-time seconds pass per frame step. Changing it via `sitrec_eval` requires updating the start time to keep `nowTime` consistent — use the GUI controller instead:
```js
(() => {
    const dt = NodeMan.get('dateTimeStart');
    const ctrl = guiMenus.time.controllers.find(c => c.property === 'simSpeed');
    ctrl.setValue(10); // 10x speed
    return { simSpeed: Sit.simSpeed };
})()
```

### Importing local files into Sitrec

Browser security prevents programmatic file picker dialogs (the `<input type="file">.click()` call is blocked without a real user gesture). To import a local file (KML, CSV, video, etc.) into Sitrec from the MCP:

1. **Spin up a one-shot Node.js HTTP server** on port 9781 that serves the file once then exits:
```bash
node -e "
const http = require('http');
const fs = require('fs');
const data = fs.readFileSync('/path/to/file.kml');
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml');
  res.end(data);
  server.close();
});
server.listen(9781, () => console.log('ready'));
"
```

2. **Fetch and parse in Sitrec** via `sitrec_eval`:
```js
(window._importResult = 'fetching',
 fetch('http://localhost:9781/file.kml')
   .then(r => r.arrayBuffer())
   .then(buf => FileManager.parseResult('file.kml', buf, null, {returnMeta: true}))
   .then(r => window._importResult = 'done')
   .catch(e => window._importResult = 'error: ' + e.message),
 'started')
```

3. **Check the result** with a follow-up eval: `window._importResult`

This works because `FileManager.parseResult()` is the same pipeline used by drag-and-drop. The one-shot server avoids browser CORS issues and closes itself after serving the file once.

### Reloading the Sitrec tab
When the MCP bridge is active (`window._mcpDebug` is set by `page-bridge.js`), the `beforeunload` "Leave Site?" dialog is **automatically suppressed**. Just reload directly:
```js
(location.reload(), 'reloading')
```
No need to set `Globals.allowUnload` — the MCP bridge handles it.

### Generated track duration and start time
When generating track data (KML, CSV, etc.) for import into Sitrec, default to the sitch's existing duration and start time unless the user specifies otherwise:
- **Duration:** `Sit.frames / Sit.fps` (e.g., 900 / 30 = 30 seconds)
- **Start time:** `Sit.startTime`

Tracks are built at import time using the sitch's current frame count. Changing `Sit.frames` afterward does **not** rebuild existing tracks. If you need a longer sitch, set the frame count *before* importing any tracks.

## Debugging with MCP

MCP allows fully automated diagnosis and fix verification without manual browser interaction. Follow this cycle:

### 1. Query runtime state
Use `sitrec_eval` to inspect the live state of nodes, properties, scales, positions, etc:
```js
// Check a property
NodeMan.get("someNode").someProperty

// Inspect computed values
(function() {
    var view = NodeMan.get("mainView");
    return { heightPx: view.heightPx, fov: view.camera.fov };
})()
```

### 2. Test a hypothesis
Call methods directly to see if they fix the problem:
```js
// e.g. manually scale handles to see if the scaling code works
(function() {
    var se = NodeMan.get("lanternSplineEditor").splineEditor;
    var view = NodeMan.get("mainView");
    se.updateCubeScales(view);
    return "scaled";
})()
```

### 3. Take a screenshot to verify
Use `sitrec_screenshot` to capture the current state visually. Compare before/after to confirm the fix.

### 4. Build → Reload → Verify
Once you've identified the code fix:
```bash
npm run build          # Build the updated code
```
Then reload via eval:
```js
(location.reload(), 'reloading')
```
Wait for the page to load (check with `Sit.name`), re-enable the feature under test, and screenshot again to confirm.

**Verify the build:** `sitrec_get_sitch` returns a `buildTime` field (e.g., `"03/22/2026 10:39:50"`) — the `document.lastModified` timestamp. After a build + reload, check this to confirm the browser is running your updated code.

### 5. Run tests
```bash
npm test               # Ensure nothing is broken
```

### Tips
- **Check all code paths.** A feature may have multiple enable paths (e.g., `Globals.editingTrack` vs. a sitch-specific GUI checkbox). A fix that only covers one path will miss the others.
- **Use `par.renderOne = true`** after making changes via eval to force a render frame, so screenshots capture the updated state.
- **Iterate fast.** The full cycle (eval diagnosis → code fix → build → reload → verify) can be done in under a minute without any manual browser interaction.

### Assert relay
When the MCP bridge is active, Sitrec's `assert()` skips the `debugger` statement and instead captures the assert message and stack trace. These are relayed back in the MCP tool response as `⚠️ ASSERT(S) FIRED DURING THIS CALL:` with full stack traces. Execution continues so the call still returns a result (or error).

**If you see an assert in a response:** treat it as a "drop everything" signal. Read the assert message and stack, find the code, and fix the root cause before proceeding. Do not ignore asserts or retry without investigating.

When no MCP bridge is connected, asserts fire the `debugger` as normal for interactive DevTools debugging.

Common assert triggers: calling render methods without a `frame` argument, accessing nodes before the sitch is fully loaded, or querying frames outside the valid range.

### safeSerialize
The page-bridge `safeSerialize` handles Three.js types (Vector3, Euler, etc.) by checking their `isVector3`/`isEuler` flags. All other objects are serialized generically (up to 50 keys, depth 4). Arrays are capped at 100 elements.
