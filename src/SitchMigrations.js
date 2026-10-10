// Pure, dependency-free backward-compat migrations applied to a parsed sitch
// object before it is used to build nodes or apply mods. Kept as a leaf module
// (no imports) so it can be unit-tested in isolation and so importing it never
// drags in the heavy Globals / three.js graph. Called from textSitchToObject()
// in RegisterSitches.js.
//
// Saved CUSTOM sitches embed their ENTIRE node graph; modded sitches carry only a
// thin overlay (modding:<base> + a `mods` block). Both flow through
// textSitchToObject, so every migration here is written to be idempotent and a
// safe no-op on shapes it does not apply to.

/**
 * Collapse the old two-switch camera-heading model ("Camera Heading" /
 * CameraLOSController wrapping an "Angles Source" / anglesSwitch) into the single
 * flattened "Camera Heading" switch.
 *
 * Rewriting the parsed object here — before any nodes are built — lets old saves
 * load (and re-save) exactly as if authored against the new flat structure, so the
 * rest of the codebase only ever deals with one switch. Because custom saves
 * re-emit `Sit` (out = {...Sit}) and regenerate `mods` from the live graph, a
 * migrated load that is re-saved is permanently healed: no anglesSwitch, no
 * "Use Angles".
 *
 * Old → new option mapping on CameraLOSController:
 *   "Use Angles" + "Angles Source: Manual PTZ"   →  "Manual"   (ptzAngles)
 *   "Use Angles" + "Angles Source: Custom Az/El" →  "Custom Az/El"
 *   "Use Angles" + "Angles Source: Angles_<name>"→  "Angles_<name>"
 *   "To Target"                                  →  "To Target" (unchanged)
 *   "Celestial Lock" / "Horizon Flare Region"    →  unchanged
 *
 * Handles the historical "angelsSwitch" typo, the embedded node defs,
 * dropTargets.angles, the top-level `mods`, and every sub-sitch `state.mods`.
 * Idempotent: a no-op on an already-flattened object.
 *
 * @param {Object} obj - parsed sitch object (becomes Sit for a custom load)
 */
export function migrateCameraHeadingReorg(obj) {
    if (!obj || typeof obj !== "object") return;

    // The angles sub-switch id, accounting for the historical "angelsSwitch" typo.
    const anglesKey = obj.anglesSwitch !== undefined ? "anglesSwitch"
                    : obj.angelsSwitch !== undefined ? "angelsSwitch"
                    : null;

    const los = obj.CameraLOSController;
    const losIsNested = !!(los && typeof los === "object" && los.inputs
        && los.inputs["Use Angles"] !== undefined);

    // Nothing to do if this object never had the nested structure (e.g. a new
    // save, a built-in sitch, or a thin mod overlay with only a `mods` block).
    if (anglesKey === null && !losIsNested && !objHasNestedChoice(obj)) return;

    // Only "Manual PTZ" is renamed; every other angles-source name is preserved
    // (Custom Az/El, Angles_<track>, ...).
    const mapAngleChoice = (c) => (c === "Manual PTZ" ? "Manual" : c);

    // --- 1. Node defs: flatten CameraLOSController, drop the angles sub-switch.
    if (losIsNested) {
        const anglesDef = anglesKey ? obj[anglesKey] : null;
        const manualTarget = (anglesDef && anglesDef.inputs && anglesDef.inputs["Manual PTZ"])
            || "ptzAngles";
        const newInputs = { "Manual": manualTarget };
        // Preserve CameraLOSController's other options (e.g. "To Target"),
        // dropping the "Use Angles" indirection into the sub-switch.
        for (const [name, target] of Object.entries(los.inputs)) {
            if (name === "Use Angles") continue;
            if (newInputs[name] === undefined) newInputs[name] = target;
        }
        los.inputs = newInputs;
        if (los.default === "Use Angles" || los.default === undefined) {
            los.default = "Manual";
        }
    }

    // Remove the now-orphaned angles sub-switch def.
    if (anglesKey !== null) delete obj[anglesKey];

    // --- 2. dropTargets.angles: per-track angle sources now land on CameraLOSController.
    if (obj.dropTargets && Array.isArray(obj.dropTargets.angles)) {
        obj.dropTargets.angles = obj.dropTargets.angles.map(
            (id) => (id === "anglesSwitch" || id === "angelsSwitch") ? "CameraLOSController" : id
        );
    }

    // --- 3. Choice migration for a mods block: translate a "Use Angles" choice
    // into the flattened angles choice, then drop the angles-switch mod.
    const migrateChoiceMods = (mods, fallback) => {
        if (!mods || typeof mods !== "object") return;
        const anglesMod = mods.anglesSwitch ?? mods.angelsSwitch;
        const losMod = mods.CameraLOSController;
        if (losMod && losMod.choice === "Use Angles") {
            const angleChoice = anglesMod && anglesMod.choice;
            losMod.choice = angleChoice ? mapAngleChoice(angleChoice) : fallback;
        }
        delete mods.anglesSwitch;
        delete mods.angelsSwitch;
    };

    // Capture the MAIN angles source BEFORE migrating (migrateChoiceMods deletes
    // the anglesSwitch mod). Sub-sitch snapshots only ever store CameraLOSController,
    // never the anglesSwitch sub-choice (the sub-sitch include patterns match
    // "*Camera*"/ptzAngles but not anglesSwitch), so historically a sub's bare
    // "Use Angles" deferred to the LIVE/ambient angles source — i.e. the main
    // save's anglesSwitch choice (default "Manual"), INDEPENDENT of whatever the
    // main heading happened to be. So the correct sub fallback is the main angles
    // source, NOT the main CameraLOSController choice (using the latter would wrongly
    // restore a sub to "To Target"/"Celestial Lock"/etc. when that was the main heading).
    const mainAnglesMod = obj.mods && (obj.mods.anglesSwitch ?? obj.mods.angelsSwitch);
    const mainAnglesFallback = (mainAnglesMod && mainAnglesMod.choice)
        ? mapAngleChoice(mainAnglesMod.choice) : "Manual";

    // Main mods first; default a bare "Use Angles" (no captured sub-choice) to "Manual".
    migrateChoiceMods(obj.mods, "Manual");

    // Sub-sitch snapshots: resolve a bare "Use Angles" to the main angles source.
    const subSitches = obj.subSitchesData && obj.subSitchesData.subSitches;
    if (Array.isArray(subSitches)) {
        for (const sub of subSitches) {
            if (sub && sub.state) migrateChoiceMods(sub.state.mods, mainAnglesFallback);
        }
    }
}

// True if any mods block (top-level or sub-sitch) still carries a "Use Angles"
// choice or an angles-switch mod, so a thin mod overlay (no embedded node defs)
// still gets its choices migrated.
export function objHasNestedChoice(obj) {
    const hasInMods = (mods) => !!(mods && typeof mods === "object"
        && (mods.anglesSwitch !== undefined || mods.angelsSwitch !== undefined
            || mods.CameraLOSController?.choice === "Use Angles"));
    if (hasInMods(obj.mods)) return true;
    const subSitches = obj.subSitchesData && obj.subSitchesData.subSitches;
    if (Array.isArray(subSitches)) {
        for (const sub of subSitches) {
            if (sub && sub.state && hasInMods(sub.state.mods)) return true;
        }
    }
    return false;
}

/**
 * Give the Camera FOV switch's manual "userFOV" option the friendlier "Manual"
 * display label on old saves. The label is display-only and lives in the switch
 * def (consumed at construction), so saves that predate it would otherwise still
 * show the raw "userFOV". The choice VALUE is untouched ("userFOV"), so no choice
 * migration is needed. Idempotent; re-saves self-heal because the label ends up in
 * Sit.fovSwitch and serialization re-emits it.
 *
 * @param {Object} obj - parsed sitch object
 */
export function migrateFovSwitchLabel(obj) {
    if (!obj || typeof obj !== "object") return;
    const fov = obj.fovSwitch;
    if (!fov || typeof fov !== "object") return;
    if (!fov.inputs || fov.inputs.userFOV === undefined) return;
    fov.labels = fov.labels ?? {};
    if (fov.labels.userFOV === undefined) fov.labels.userFOV = "Manual";
}

/**
 * Route an OLD saved custom sitch's camera controls into the new Camera-menu
 * sub-folders (Location / Heading / FOV (Zoom)). A save embeds each node's `gui`
 * target, so a sitch saved before 2.88.0 carries `gui: "camera"` for the camera
 * nodes and would land them in the top-level Camera menu — leaving the new
 * sub-folders empty (and hidden). Rewrite those gui targets so old saves get the
 * SAME layout as freshly-created ones, and apply the "Position" rename + the
 * Manual / Flight Sim display labels on the position switch.
 *
 * Only the embedded node defs need this — the runtime-added options (Celestial
 * Lock, Orbit, per-track angles, Custom Az/El) are placed by CustomManagerSetup /
 * CFileManagerParse, which already target the new folders. The removed nodes
 * (CameraPositionController, anglesSwitch) keep gui:"camera" harmlessly — they are
 * never created (see migrateCameraHeadingReorg / REMOVED_NODE_IDS).
 *
 * Idempotent: only rewrites the old "camera" value, so a new save (already
 * "cameraLocation"/etc.) is untouched.
 *
 * @param {Object} obj - parsed sitch object
 */
/**
 * Carry an old save's painted mask onto the shared mask node.
 *
 * The mask used to be created by Motion Analysis under the id "motionMaskOverlay", named for the
 * one system that happened to own it. It is now "videoMask", built for every custom sitch with a
 * video (CustomManagerSetup) because several systems read it and because a node that does not
 * exist when mods are applied never receives its saved state at all.
 *
 * Renaming the key is enough: the payload shape is unchanged, and the old node is no longer
 * created for custom sitches, so its mod would otherwise be dropped on the floor and the user's
 * painted mask would silently vanish on reload.
 *
 * Idempotent, and non-destructive: a save that already carries a "videoMask" mod keeps it, and
 * the old entry is only moved when there is nothing to overwrite.
 *
 * @param {Object} obj - parsed sitch object
 */
export function migrateMaskOverlayId(obj) {
    if (!obj || typeof obj !== "object") return;
    const mods = obj.mods;
    if (!mods || typeof mods !== "object") return;
    const old = mods.motionMaskOverlay;
    if (!old || typeof old !== "object") return;
    if (mods.videoMask === undefined) mods.videoMask = old;
    delete mods.motionMaskOverlay;
}

export function migrateCameraMenuFolders(obj) {
    if (!obj || typeof obj !== "object") return;
    const reGui = (node, newGui) => {
        if (node && typeof node === "object" && node.gui === "camera") node.gui = newGui;
    };
    // Location
    reGui(obj.fixedCameraPosition, "cameraLocation");
    reGui(obj.cameraTrackSwitch, "cameraLocation");
    reGui(obj.cameraTrackSwitchSmooth?.window, "cameraLocation"); // nested Smooth Window
    // Heading
    reGui(obj.ptzAngles, "cameraHeading");
    reGui(obj.CameraLOSController, "cameraHeading");
    reGui(obj.orientCameraController, "cameraHeading");
    // FOV (Zoom)
    reGui(obj.fovUI, "cameraFOV");
    reGui(obj.fovSwitch, "cameraFOV");

    // Position rename + display labels (display-only; choice values unchanged).
    const cts = obj.cameraTrackSwitch;
    if (cts && typeof cts === "object") {
        if (cts.desc === "Camera Track") cts.desc = "Position";
        cts.labels = cts.labels ?? {};
        if (cts.labels.fixedCamera === undefined) cts.labels.fixedCamera = "Manual";
        if (cts.labels.flightSimCamera === undefined) cts.labels.flightSimCamera = "Flight Sim";
    }
}

/**
 * Convert the old hard-wired measurement nodes of a saved CUSTOM sitch into the
 * `measurements` block that CMeasurementManager builds from (Show > Measurements).
 *
 * Before measurements could be added by the user, SitCustom.js defined three nodes: camera
 * altitude (altitudeLabel), traverse altitude (altitudeLabel2) and camera-to-traverse
 * distance (distanceLabel). A saved custom sitch embeds its whole node graph, so every old
 * save still carries them. Each MeasureAltitude / MeasureAB node definition becomes a
 * measurement with the same id, and the node definition (and any mod for it) is deleted, so
 * a re-save is in the new format only.
 *
 * Only a sitch with at least one such node gets a `measurements` block. A fresh custom sitch
 * has none, and CMeasurementManager then makes the three defaults. A new save always has the
 * block (it can be empty, when the user deleted them all), and it is left alone.
 *
 * @param {Object} obj - parsed sitch object
 */
export function migrateLegacyMeasurements(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.name !== "custom" && !obj.isCustom) return;
    if (obj.measurements !== undefined) return;

    const measurements = [];
    for (const [id, def] of Object.entries(obj)) {
        if (!def || typeof def !== "object") continue;
        let measurement;
        if (def.kind === "MeasureAltitude" && typeof def.position === "string") {
            measurement = {id, type: "altitude", from: legacyMeasurementRef(def.position), to: null};
        } else if (def.kind === "MeasureAB" && typeof def.A === "string" && typeof def.B === "string") {
            measurement = {id, type: "distance", from: legacyMeasurementRef(def.A), to: legacyMeasurementRef(def.B)};
        } else {
            continue;
        }
        // Hidden by the definition or by a mod. A color on the old node is kept too; the
        // default sitch never set one, but a hand-edited sitch can have.
        measurement.show = def.visible !== false && obj.mods?.[id]?.visible !== false;
        if (typeof def.color === "string") measurement.color = def.color;
        measurements.push(measurement);
        delete obj[id];
        if (obj.mods && typeof obj.mods === "object") delete obj.mods[id];
    }
    if (measurements.length > 0) obj.measurements = measurements;
}

// The {kind, id} reference for a node id used by an old measurement node. The camera track
// (cameraTrackSwitchSmooth) is where the look camera is, so both mean "the camera".
export function legacyMeasurementRef(nodeId) {
    if (nodeId === "lookCamera" || nodeId === "cameraTrackSwitchSmooth") return {kind: "camera", id: "lookCamera"};
    if (nodeId === "traverseSmoothedTrack") return {kind: "traverse", id: nodeId};
    return {kind: "node", id: nodeId};
}

/**
 * Turn the timeline events of an old save's chapters into timeline markers.
 *
 * Sitch chapters (subSitchesData.subSitches) used to keep their own "timeline events"
 * ({name, frame} in state.events), while the timeline markers ({frame, label}, the top-level
 * timelineMarkers) belonged to the whole sitch and so showed in every chapter. Now the markers
 * are the one store of named frames, and each chapter keeps its own copy in state.markers. So
 * each chapter that has events gets the sitch's markers plus its own events, and the top-level
 * markers become those of the current chapter.
 *
 * One marker per frame: an event on a frame that already has a marker is added to that
 * marker's label after "; ". Idempotent: a migrated chapter has no events left.
 *
 * @param {Object} obj - parsed sitch object
 */
export function migrateChapterEventsToMarkers(obj) {
    if (!obj || typeof obj !== "object") return;
    const chapters = obj.subSitchesData?.subSitches;
    if (!Array.isArray(chapters)) return;
    const sitchMarkers = Array.isArray(obj.timelineMarkers) ? obj.timelineMarkers : [];
    let migrated = false;
    for (const chapter of chapters) {
        const state = chapter?.state;
        if (!state || !Array.isArray(state.events)) continue;
        const byFrame = new Map();
        const addMarker = (frame, label) => {
            frame = Math.round(Number(frame));
            if (!Number.isFinite(frame)) return;
            label = label == null ? "" : String(label);
            const existing = byFrame.get(frame);
            if (!existing) byFrame.set(frame, {frame, label});
            else if (label && !existing.label.split("; ").includes(label)) {
                existing.label = existing.label ? existing.label + "; " + label : label;
            }
        };
        for (const marker of sitchMarkers) addMarker(marker?.frame, marker?.label);
        for (const event of state.events) addMarker(event?.frame, event?.name);
        state.markers = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        delete state.events;
        migrated = true;
    }
    if (!migrated) return;
    const current = chapters[obj.subSitchesData.currentSubIndex ?? 0]?.state?.markers;
    if (current?.length) obj.timelineMarkers = current.map(marker => ({...marker}));
    else if (current) delete obj.timelineMarkers;
}
