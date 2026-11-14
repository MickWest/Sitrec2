// TrackObjectLinks.js
//
// Which object is on which track, and what each track is used for: worked out in ONE place,
// from the node graph as it is now, and shown the same way for every kind of track and object.
//
// A TRACK gives a position for each frame, and has a folder in the Contents menu. An OBJECT is
// a model or a shape that is drawn at a position, and has a folder in the Objects menu. The
// whole link between the two is one input: the `sourceTrack` of the object's TrackPosition
// controller. There are five kinds of object (the camera object and the traverse object of the
// sitch, the marker of a loaded track, an object that the user made, a balloon's sphere and a
// kite) and each kind was wired by different code, so each had different rows, or none. This
// module reads the link itself, so the rows do not depend on how an object was made.
//
// What it puts in the menus (refreshTrackObjectLinks):
//
//   Objects > an object     On Track | [track name]    opens that track's menu
//                           Used For | Target          when a selector has the object
//                           a title note "on Track 3"  when the names differ
//   Contents > a track      Object   | [object name]   one for each object on it
//                           Used For | Camera position, FOV, heading
//                           a title note "Camera" or "Target"
//   Contents > Camera Track    Camera Position | N97826     and the note "follows N97826"
//   Contents > Traverse Track  Traverse Method | Constant Altitude
//   a balloon or kite track    Wind Source     | Manual
//   Objects > Traverse Object  Not Drawn | Same track as N97826   only while that is so
//
// Nothing here is saved. Every text is read from the sitch on each refresh, so it cannot
// disagree with it, and a sitch from any version gets the rows.
//
// THE REFRESH. One debounced call brings the rows in step. It writes to the page only where a
// text changed, and the rows do not .listen(), so a sitch with hundreds of tracks pays
// nothing between changes. installTrackObjectLinks() adds the listeners, on each sitch load
// (the event manager is cleared on a sitch change).
//
// The first part of this file is pure: it takes plain lists, so tests/TrackObjectLinks.test.js
// runs it without the app. It imports no node class and no manager file: a new import cycle
// fails the development build.

import {CustomManager, Globals, guiMenus, NodeMan, Sit, TrackManager} from "./Globals";
import {EventManager} from "./CEventManager";
import {DISPLAY_NAME_CHANGED} from "./DisplayName";
import {OBJECT_MANUAL_POSITION, trackSelectors} from "./TrackSelectors";
import {windSourceShortLabel} from "./nodes/WindSources";
import {t} from "./i18n";

// --- the model (pure) --------------------------------------------------------------------

// What a selector uses its track for, by the selector's node id. A selector that is not here
// gives its own label. Each role has its words under links.roles in en.js.
const ROLE_OF_SELECTOR = {
    cameraTrackSwitch: "cameraPosition",
    targetTrackSwitch: "target",
    orbitTargetSwitch: "orbitCenter",
    balloonLaunchFinder_source: "balloonLaunchFinder",
    kiteAnchorFinder_source: "kiteAnchorFinder",
    fovSwitch: "cameraFOV",
    CameraLOSController: "cameraHeading",
};

// Selectors that are in the list of track selectors but do not USE a track. Zoom to Track is
// a one-time pick: it goes back to "-" after the zoom, and a new sitch selects each loaded
// track into it in turn.
const NOT_A_ROLE = new Set(["zoomToTrack"]);

// The Orbit Target is in use only while the camera's position is Orbit. It also selects each
// loaded track in turn, so without this rule the last track of a file would say "Orbit center".
const ORBIT_SELECTOR = "orbitTargetSwitch";
const ORBIT_CAMERA_CHOICE = "orbitCamera";

// The positions of the camera that are not a track: the option keys of Camera > Location >
// Position that the sitch has from the start. Each has its words in en.js.
const CAMERA_POSITION_KINDS = ["fixedCamera", "flightSimCamera", ORBIT_CAMERA_CHOICE];

// The roles that a title note shows, and the roles that are a part of "Camera".
const NOTE_ROLES = ["cameraPosition", "target"];
const CAMERA_PART_ROLES = ["cameraFOV", "cameraHeading"];

/**
 * The enabled position controller's source: the node that sets where the object is. As
 * objectFocusTrack (CameraFocusUI.js), but null for an object that has none.
 */
export function positionSourceOf(objectNode) {
    const controller = Object.values(objectNode?.inputs ?? {}).find(input =>
        input?.isController && input.inputs?.sourceTrack && input.enabled !== false);
    return controller?.inputs.sourceTrack ?? null;
}

/**
 * Look-up tables from a node to the named thing that it belongs to.
 * @param {object} world
 * @param {Array} world.tracks - the entries of TrackManager
 * @param {Array} world.builtInTracks - display track nodes that own their folder (the camera
 *        track, the traverse track): `inputs.track` is the track that they draw
 * @param {Array} world.objects - the 3D objects that have a folder
 */
export function buildLinkIndex({tracks = [], builtInTracks = [], objects = []}) {
    const trackOfNode = new Map();
    for (const trackOb of tracks) {
        // A loaded track has one node. A hand-drawn track has two: the selectors of the sitch
        // hold its spline, and an object's Position holds the finished (smoothed) track.
        for (const node of [trackOb.trackNode, trackOb.smoothedTrackNode, trackOb.splineEditorNode]) {
            if (node && !trackOfNode.has(node)) trackOfNode.set(node, trackOb);
        }
    }
    const builtInOfNode = new Map();
    for (const displayNode of builtInTracks) {
        const node = displayNode.inputs?.track;
        if (node && !trackOfNode.has(node) && !builtInOfNode.has(node)) builtInOfNode.set(node, displayNode);
    }
    const objectOfManualPosition = new Map();
    const positionSwitches = new Map();     // switch id -> its object
    for (const objectNode of objects) {
        if (!objectNode.positionSwitchID) continue;
        positionSwitches.set(objectNode.positionSwitchID, objectNode);
        const manual = positionSource(objectNode)?.inputs?.[OBJECT_MANUAL_POSITION];
        if (manual) objectOfManualPosition.set(manual, objectNode);
    }
    return {trackOfNode, builtInOfNode, objectOfManualPosition, positionSwitches};
}

// The Position selector of an object that has one (its position controller reads it).
function positionSource(objectNode) {
    const source = positionSourceOf(objectNode);
    return source && source.id === objectNode.positionSwitchID ? source : null;
}

/**
 * What an object is on. It starts at the node that sets the object's position and stops at
 * the first thing that has a name.
 * @returns {{kind: "track", trackOb}|{kind: "builtIn", displayNode}|{kind: "manual"}
 *          |{kind: "object", objectNode}|null}
 */
export function sourceOfObject(objectNode, index) {
    let node = positionSourceOf(objectNode);
    const seen = new Set();
    while (node && !seen.has(node)) {
        seen.add(node);
        const trackOb = index.trackOfNode.get(node);
        if (trackOb) return {kind: "track", trackOb};
        const displayNode = index.builtInOfNode.get(node);
        if (displayNode) return {kind: "builtIn", displayNode};
        const owner = index.objectOfManualPosition.get(node);
        if (owner) return owner === objectNode ? {kind: "manual"} : {kind: "object", objectNode: owner};
        // A selector: go on with what it selects. A smoothed copy: go on with what it copies.
        node = node.choice !== undefined ? node.inputs?.[node.choice] : node.inputs?.source;
    }
    return null;
}

/** The option keys that one track has in the selectors: a different key for each kind. */
export function keysOfTrack(trackOb) {
    const short = trackOb.menuText;
    return {
        track: short,                               // Camera Position, Target Track, Orbit Target...
        fov: trackOb.trackID,                       // Camera FOV
        angles: short !== undefined ? "Angles_" + short : undefined,    // Camera Heading
        wind: trackOb.trackDataNode?.id ? "track:" + trackOb.trackDataNode.id : undefined,
    };
}

/**
 * The roles of the thing that has these option keys.
 * @param {object} keys - {track, fov, angles, wind}; an object on its manual position has
 *        only `track`, which is its node id
 * @param {object} world
 * @param {Array} world.selectors - {id, keyKind, choice, label}
 * @param {Array} [world.windSources] - the source keys of the wind in use
 * @returns {Array<{role: string, selector: string, label: string}>}
 */
export function rolesOf(keys, {selectors = [], windSources = []}) {
    const cameraIsOrbit = selectors.some(s => s.id === "cameraTrackSwitch" && s.choice === ORBIT_CAMERA_CHOICE);
    const roles = [];
    for (const selector of selectors) {
        const key = keys[selector.keyKind];
        if (key === undefined || selector.choice !== key) continue;
        if (NOT_A_ROLE.has(selector.id)) continue;
        if (selector.id === ORBIT_SELECTOR && !cameraIsOrbit) continue;
        roles.push({role: ROLE_OF_SELECTOR[selector.id] ?? null, selector: selector.id, label: selector.label});
    }
    if (keys.wind !== undefined && windSources.includes(keys.wind)) {
        roles.push({role: "windSource", selector: "windField", label: "Wind Source"});
    }
    return roles;
}

/**
 * Every link of the sitch.
 * @returns {{objects: Map, tracks: Map, builtIn: Map}} objects: object -> {source, roles};
 *          tracks: trackOb -> {objects, roles}; builtIn: display node -> {objects, roles}
 */
export function describeLinks(world) {
    const index = buildLinkIndex(world);
    const objects = new Map(), tracks = new Map(), builtIn = new Map();
    for (const trackOb of world.tracks ?? []) {
        tracks.set(trackOb, {objects: [], roles: rolesOf(keysOfTrack(trackOb), world)});
    }
    for (const displayNode of world.builtInTracks ?? []) {
        // A satellite track is an option of the track lists, under its trackName ("Satellite").
        const key = displayNode.inputs?.track?.trackName;
        builtIn.set(displayNode, {objects: [], roles: key !== undefined ? rolesOf({track: key}, world) : []});
    }
    for (const objectNode of world.objects ?? []) {
        const source = sourceOfObject(objectNode, index);
        // An object on its manual position is an option of the selectors, under its id.
        const roles = source?.kind === "manual" ? rolesOf({track: objectNode.id}, world) : [];
        objects.set(objectNode, {source, roles});
        if (source?.kind === "track") tracks.get(source.trackOb)?.objects.push(objectNode);
        if (source?.kind === "builtIn") builtIn.get(source.displayNode)?.objects.push(objectNode);
    }
    return {objects, tracks, builtIn, index};
}

// --- the words -----------------------------------------------------------------------------

const roleWord = (entry, form) => entry.role ? t(`links.roles.${entry.role}.${form}`) : entry.label;

/**
 * The text of a Used For row: "Camera position, FOV, heading". The camera's FOV and heading
 * are short after "Camera position", and have their full names without it.
 */
export function usedForText(roles) {
    const hasCamera = roles.some(entry => entry.role === "cameraPosition");
    return roles.map(entry =>
        roleWord(entry, hasCamera && CAMERA_PART_ROLES.includes(entry.role) ? "short" : "name")).join(", ");
}

// The tooltip of a Used For row: one line for each role, with the place of its selector.
function usedForTip(roles) {
    return [t("links.usedFor.tooltip"),
        ...roles.map(entry => "- " + (entry.role ? t(`links.roles.${entry.role}.where`) : entry.label))].join("\n");
}

/** The words of a title note for these roles: "Camera", "Target", or "" for none of the two. */
export function noteWords(roles) {
    return NOTE_ROLES.filter(role => roles.some(entry => entry.role === role))
        .map(role => t(`links.roles.${role}.note`));
}

const trackName = (trackOb) => trackOb.displayName ?? trackOb.menuText ?? trackOb.trackID;
const objectName = (objectNode) => objectNode.displayName ?? objectNode.menuName ?? objectNode.id;
const builtInName = (displayNode) => displayNode.menuTitle ?? displayNode.guiFolder?._title ?? displayNode.id;
const byName = (a, b) => objectName(a).localeCompare(objectName(b), undefined, {numeric: true});

// The text that a selector shows for its choice.
const choiceLabel = (selector) => selector ? (selector.guiLabels?.[selector.choice] ?? selector.choice) : "";

// --- the sitch, as the model wants it -------------------------------------------------------

// A 3D object that has its folder in the Objects menu.
function isMenuObject(node) {
    return typeof node?.setDisplayName === "function" && node.gui && typeof node.gui.add === "function";
}

function gatherWorld() {
    const tracks = [];
    TrackManager?.iterate?.((id, trackOb) => tracks.push(trackOb));
    const builtInTracks = [], objects = [];
    NodeMan.iterate((id, node) => {
        if (node.ownsGuiFolder && node.guiFolder) builtInTracks.push(node);
        else if (isMenuObject(node)) objects.push(node);
    });

    // The Position of an object is a track selector too, but not a use of the track: the
    // object is then reported as an object on the track.
    const positionSwitches = new Set(objects.map(objectNode => objectNode.positionSwitchID).filter(Boolean));
    const selectors = [];
    const add = (node, keyKind) => {
        if (!node || node.choice === undefined) return;
        selectors.push({id: node.id, keyKind, choice: node.choice,
            label: String(node.controller?._name ?? node.id).replace(/^\*/, "").trim()});
    };
    for (const selector of trackSelectors()) {
        if (!positionSwitches.has(selector.id)) add(selector, "track");
    }
    for (const id of Sit.dropTargets?.fov ?? []) add(NodeMan.get(id, false), "fov");
    for (const id of Sit.dropTargets?.angles ?? []) add(NodeMan.get(id, false), "angles");

    // The wind in use. With one Wind Source, the local wind has the same source.
    const windField = NodeMan.get("windField", false);
    const windSources = windField
        ? [windField.source, windField.sourceSeparate ? windField.sourceLocal : undefined].filter(Boolean)
        : [];

    return {tracks, builtInTracks, objects, selectors, windSources};
}

// --- the rows -------------------------------------------------------------------------------

// The x on screen of the menu button just clicked: a lil-gui button keeps focus after a click.
// A panel that a link opens goes beside that button. The middle of the window otherwise.
function clickedButtonX() {
    const element = document.activeElement;
    if (element?.closest?.(".lil-gui")) {
        const rect = element.getBoundingClientRect();
        return rect.left + rect.width / 2;
    }
    return window.innerWidth / 2;
}

function openTrackMenu(target) {
    if (target.trackOb) {
        const trackOb = target.trackOb;
        CustomManager.showTrackMenu({trackID: trackOb.trackID, guiFolder: trackOb.guiFolder, trackOb}, clickedButtonX(), 0);
    } else if (target.displayNode) {
        const displayNode = target.displayNode;
        CustomManager.showTrackMenu({trackID: displayNode.id, guiFolder: displayNode.guiFolder}, clickedButtonX(), 0);
    }
}

// A row handle is good while its folder still has the row. A geometry rebuild of an object's
// folder, or a new sitch that makes a node with the same id, can remove a row.
const alive = (controller, folder) => !!controller && folder.controllers.includes(controller);

// Write only what changed. A write goes on to the copy of the row in an open panel.
function setRowName(controller, name) {
    if (controller._name !== name) controller.name(name);
}
function setRowTip(controller, tip) {
    if (controller._tooltip !== tip) controller.tooltip(tip);
}
function setRowShown(controller, shown) {
    if (!!controller._hidden === shown) controller.show(shown);
}
function setRowText(controller, text) {
    if (controller.object.text !== text) {
        controller.object.text = text;
        controller.updateDisplay();
    }
}

// A link row: a label, and a button with the name of the thing that it opens.
function makeLinkRow(folder, property, label, signatureName, action) {
    return folder.add({[property]: action}, property).asLinkRow(label, signatureName);
}

// A display row: a label and a text that the user reads.
function makeDisplayRow(folder, label) {
    return folder.add({text: ""}, "text").name(label).asDisplayRow();
}

// Put rows in this order directly below the Name row of a folder (or at its top, for a folder
// with no Name). A row is moved only when it is not in its place, because a move makes an open
// panel build its copy of the folder again.
function placeRows(folder, rows) {
    const nameRow = folder.controllers.find(controller => controller.property === "displayName")?.domElement;
    let previous = nameRow ?? null;
    let moved = false;
    for (const row of rows) {
        const element = row.domElement;
        const wanted = previous ? previous.nextElementSibling : folder.$children.firstElementChild;
        if (wanted !== element) {
            if (previous) previous.after(element);
            else folder.$children.prepend(element);
            moved = true;
        }
        previous = element;
    }
    if (moved) folder._triggerMirrorRefresh?.();
}

// The rows of an object's folder stay through a rebuild of the folder for a new model or
// geometry (isCommon), and they work while the object is hidden.
function keepInObjectFolder(controller) {
    controller.isCommon = true;
    controller.keepLiveWhenFolderOff?.();
    return controller;
}

// The Used For row of a folder: made the first time there is something to show.
function syncUsedFor(host, folder, roles, inObjectFolder) {
    let row = alive(host._usedForRow, folder) ? host._usedForRow : null;
    if (!row && roles.length === 0) return null;
    if (!row) {
        row = host._usedForRow = makeDisplayRow(folder, t("links.usedFor.label"));
        if (inObjectFolder) keepInObjectFolder(row);
    }
    if (roles.length > 0) {
        setRowText(row, usedForText(roles));
        setRowTip(row, usedForTip(roles));
    }
    setRowShown(row, roles.length > 0);
    return roles.length > 0 ? row : null;
}

// One "Object" link row for each object on a track, in the track's folder.
function syncObjectRows(host, folder, objectNodes) {
    const rows = host._objectLinkRows ??= new Map();     // object id -> row
    const wanted = new Set(objectNodes.map(objectNode => objectNode.id));
    for (const [id, row] of rows) {
        if (!wanted.has(id) || !alive(row, folder)) {
            if (alive(row, folder)) row.destroy();
            rows.delete(id);
        }
    }
    const ordered = [];
    for (const objectNode of [...objectNodes].sort(byName)) {
        let row = rows.get(objectNode.id);
        if (!row) {
            row = makeLinkRow(folder, "showObjectMenu", t("links.object.label"), "link:object:" + objectNode.id,
                () => CustomManager.showNodeEditMenu(objectNode, clickedButtonX(), 0));
            rows.set(objectNode.id, row);
        }
        setRowName(row, objectName(objectNode));
        setRowTip(row, t("links.object.tooltip", {name: objectName(objectNode)}));
        ordered.push(row);
    }
    return ordered;
}

// A display row that one kind of folder has: its text and tooltip, or null for no row.
function syncInfoRow(host, folder, slot, label, info, inObjectFolder = false) {
    let row = alive(host[slot], folder) ? host[slot] : null;
    if (!row && !info) return null;
    if (!row) {
        row = host[slot] = makeDisplayRow(folder, label);
        if (inObjectFolder) keepInObjectFolder(row);
    }
    if (info) {
        setRowText(row, info.text);
        setRowTip(row, info.tooltip);
    }
    setRowShown(row, !!info);
    return info ? row : null;
}

// What the camera track is: the choice of Camera > Location > Position.
function cameraPositionInfo() {
    const selector = NodeMan.get("cameraTrackSwitch", false);
    if (!selector || selector.choice === undefined) return null;
    const label = choiceLabel(selector);
    const builtIn = CAMERA_POSITION_KINDS.includes(selector.choice)
        ? t(`links.cameraPosition.kinds.${selector.choice}`) : "";
    if (selector.choice === ORBIT_CAMERA_CHOICE) {
        const target = choiceLabel(NodeMan.get(ORBIT_SELECTOR, false));
        return {text: t("links.cameraPosition.orbit", {name: target}), note: label, tooltip: builtIn};
    }
    if (builtIn) return {text: label, note: label, tooltip: builtIn};
    // a track, or an object on its manual position
    return {
        text: label,
        note: t("links.cameraPosition.followsNote", {name: label}),
        tooltip: t("links.cameraPosition.follows", {name: label}),
    };
}

// What the traverse track is: the choice of Traverse > LOS Traverse Method. The method
// "Target Object" calculates nothing: the traverse track is then the target track.
function traverseMethodInfo() {
    const selector = NodeMan.get("LOSTraverseSelectTrack", false);
    if (!selector || selector.choice === undefined) return null;
    if (selector.choice === "Target Object") {
        return {text: t("links.traverseMethod.sameAsTarget"), tooltip: t("links.traverseMethod.sameAsTargetTooltip")};
    }
    return {text: choiceLabel(selector), tooltip: t("links.traverseMethod.tooltip")};
}

// The wind that moves a balloon or a kite: the wind of the scene (SceneWind.js).
function windSourceInfo(trackOb) {
    const windField = NodeMan.get("windField", false);
    const source = windField?.source;
    const text = source ? windSourceShortLabel(source) : t("links.windSource.targetWind");
    return {text, tooltip: t(`links.windSource.${trackOb.isKite ? "kiteTooltip" : "balloonTooltip"}`)};
}

// The traverse object is not drawn while another object is on the same track
// (CCustomManager.preRenderUpdate): two objects would be at one place. Says which.
function notDrawnInfo(objectNode, objects) {
    if (!["traverseObject", "targetObject"].includes(objectNode.id) || !objectNode.rootTrack) return null;
    const other = objects.find(node => node !== objectNode && node.rootTrack === objectNode.rootTrack);
    return other ? {text: t("links.notDrawn.text", {name: objectName(other)}), tooltip: t("links.notDrawn.tooltip")} : null;
}

function refreshObjectFolder(objectNode, entry, world) {
    const folder = objectNode.gui;
    const source = entry.source;
    const target = source?.kind === "track" ? {trackOb: source.trackOb, name: trackName(source.trackOb)}
        : source?.kind === "builtIn" ? {displayNode: source.displayNode, name: builtInName(source.displayNode)}
        : null;

    // On Track: the property is the one the Show Track Menu button had, which the API matches.
    let onTrack = alive(objectNode.showTrackController, folder) ? objectNode.showTrackController : null;
    if (target && !onTrack) {
        onTrack = objectNode.showTrackController = keepInObjectFolder(
            makeLinkRow(folder, "showTrackMenu", t("links.onTrack.label"), "link:onTrack",
                () => objectNode._onTrackTarget && openTrackMenu(objectNode._onTrackTarget)));
    }
    objectNode._onTrackTarget = target;
    if (onTrack) {
        if (target) {
            setRowName(onTrack, target.name);
            setRowTip(onTrack, t("links.onTrack.tooltip", {name: target.name}));
        }
        setRowShown(onTrack, !!target);
    }

    const usedFor = syncUsedFor(objectNode, folder, entry.roles, true);
    const notDrawn = syncInfoRow(objectNode, folder, "_notDrawnRow", t("links.notDrawn.label"),
        notDrawnInfo(objectNode, world.objects), true);
    placeRows(folder, [target ? onTrack : null, usedFor, notDrawn].filter(Boolean));

    // The note: the track, when the two have different names. Not for the camera and traverse
    // objects, which are on their own track always. Then what the object is used for.
    const words = [];
    const tips = [];
    if (source?.kind === "track" && target.name !== objectName(objectNode)) {
        words.push(t("links.onTrack.note", {name: target.name}));
        tips.push(t("links.onTrack.tooltip", {name: target.name}));
    }
    const roleWords = noteWords(entry.roles);
    if (roleWords.length > 0) {
        words.push(...roleWords);
        tips.push(usedForText(entry.roles.filter(role => NOTE_ROLES.includes(role.role))));
    }
    folder.setTitleNote?.(words.join(", "), tips.join("\n"));
}

function refreshTrackFolder(trackOb, entry) {
    const folder = trackOb.guiFolder;
    if (!folder?.controllers) return;       // a track of a legacy sitch can have no folder
    const rows = syncObjectRows(trackOb, folder, entry.objects);
    const usedFor = syncUsedFor(trackOb, folder, entry.roles, false);
    const wind = syncInfoRow(trackOb, folder, "_windSourceRow", t("links.windSource.label"),
        trackOb.isBalloon || trackOb.isKite ? windSourceInfo(trackOb) : null);
    placeRows(folder, [...rows, usedFor, wind].filter(Boolean));
    const words = noteWords(entry.roles);
    folder.setTitleNote?.(words.join(", "),
        words.length > 0 ? t("links.usedFor.note", {roles: usedForText(entry.roles)}) : "");
}

function refreshBuiltInFolder(displayNode, entry) {
    const folder = displayNode.guiFolder;
    if (!folder?.controllers) return;
    const rows = syncObjectRows(displayNode, folder, entry.objects);
    const camera = displayNode.id === "cameraDisplayTrack" ? cameraPositionInfo() : null;
    const cameraRow = syncInfoRow(displayNode, folder, "_cameraPositionRow", t("links.cameraPosition.label"), camera);
    const traverse = displayNode.id === "traverseDisplayTrack" ? traverseMethodInfo() : null;
    const traverseRow = syncInfoRow(displayNode, folder, "_traverseMethodRow", t("links.traverseMethod.label"), traverse);
    const usedFor = syncUsedFor(displayNode, folder, entry.roles, false);
    placeRows(folder, [...rows, usedFor, cameraRow, traverseRow].filter(Boolean));
    // The camera track says what the camera's position is. Another track (a satellite) says
    // what it is used for, as a track of TrackManager does.
    const words = noteWords(entry.roles);
    if (camera) folder.setTitleNote?.(camera.note, camera.tooltip);
    else folder.setTitleNote?.(words.join(", "),
        words.length > 0 ? t("links.usedFor.note", {roles: usedForText(entry.roles)}) : "");
}

/**
 * Bring the link rows and the title notes of every track and object folder in step with the
 * sitch. Safe to call at any time; it changes nothing that is saved.
 */
export function refreshTrackObjectLinks() {
    if (Globals.disposing || !NodeMan || !guiMenus.contents) return;
    const world = gatherWorld();
    const links = describeLinks(world);
    for (const [objectNode, entry] of links.objects) refreshObjectFolder(objectNode, entry, world);
    for (const [trackOb, entry] of links.tracks) refreshTrackFolder(trackOb, entry);
    for (const [displayNode, entry] of links.builtIn) refreshBuiltInFolder(displayNode, entry);
}

/**
 * The links of every track, as plain data: for the Sitrec API (listTracks).
 * @returns {Map<object, {kind: string, objects: string[], usedFor: string[]}>} by TrackManager entry
 */
export function trackLinkSummaries() {
    const summaries = new Map();
    for (const [trackOb, entry] of describeLinks(gatherWorld()).tracks) {
        summaries.set(trackOb, {
            kind: trackOb.isBalloon ? "balloon" : trackOb.isKite ? "kite" : trackOb.isSynthetic ? "handDrawn" : "loaded",
            objects: entry.objects.map(objectName),
            usedFor: entry.roles.map(role => roleWord(role, "name")),
        });
    }
    return summaries;
}

// --- when the refresh runs ------------------------------------------------------------------

let refreshTimer = null;
let scheduledGeneration = null;

/**
 * Ask for a refresh. Many calls in one turn make one refresh, after the turn. Nothing happens
 * for a call during a sitch load (the load asks once at its end), or if another sitch started
 * to load before the refresh ran.
 */
export function scheduleTrackObjectLinksRefresh() {
    if (refreshTimer !== null || typeof setTimeout !== "function") return;
    scheduledGeneration = Globals.loadGeneration;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (Globals.loadGeneration !== scheduledGeneration) return;
        if (Globals.disposing || Globals.deserializing) return;
        try {
            refreshTrackObjectLinks();
        } catch (error) {
            // The rows are a display. An error in them must not stop a load or an edit.
            console.warn("Track and object links: refresh failed", error);
        }
    }, 0);
}

/** Drop a refresh that is waiting. For the start of a sitch change. */
export function cancelTrackObjectLinksRefresh() {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
}

// The listener of every event. It returns nothing: the event manager removes a listener that
// returns a true value.
function onLinksChanged() {
    scheduleTrackObjectLinksRefresh();
}

// A track is added or removed; an object is made or deleted; a thing gets a new name; a
// selector changes (CNodeSwitch.choiceChanged sends the last one for every switch).
const LINK_EVENTS = ["tracksChanged", "objectsChanged", DISPLAY_NAME_CHANGED, "Switch.choiceChanged"];

/**
 * Listen for the changes that move a link, and ask for the first refresh. Called on each
 * sitch load (CCustomManager.setup): the event manager is cleared when the sitch changes.
 */
export function installTrackObjectLinks() {
    for (const event of LINK_EVENTS) {
        EventManager.removeEventListener(event, onLinksChanged);
        EventManager.addEventListener(event, onLinksChanged);
    }
    scheduleTrackObjectLinksRefresh();
}
