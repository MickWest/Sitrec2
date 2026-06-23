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
