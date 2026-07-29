// Sitrec spline interchange format (.spline.json)
//
// A small, hand-editable JSON file holding the CONTROL POINTS of a spline
// track — not its per-frame expansion. Dropping one on Sitrec creates a
// synthetic track, exactly what the "Add Track" menu makes, so a
// hand-authored solution path (e.g. the Aguadilla UAP/Lantern/Ground splines)
// can move between sitches as a droppable data file instead of being
// hard-coded in a Sit*.js.
//
// Points are [frame, lat, lon, altHAE]:
//  - geodetic, so the file survives a change of Earth model or sitch origin
//    (the legacy in-sitch arrays are raw EUS/ECEF and do not)
//  - altitude is HAE (height above ellipsoid), the datum ECEFToLLAVD_radii
//    returns, so LLA -> ECEF -> LLA round-trips exactly with no geoid lookup
//  - frame numbers are video frames, matching the spline editor's own
//    frameNumbers array. fps/frames are recorded for reference so a file
//    can be checked against the sitch it is dropped into.

import {Vector3} from "three";
import {ECEFToLLAVD_radii, LLAVToECEF} from "./LLA-ECEF-ENU";
import {NodeMan, Sit, TrackManager} from "./Globals";
import {showError} from "./showError";

export const SPLINE_FILE_TYPE = "sitrec-spline";
export const SPLINE_FILE_VERSION = 1;

// Mirrors the Curve Type dropdown the synthetic track folder offers. An unknown
// value would reach SplineEditor.setCurveType and silently pick no curve.
export const SPLINE_CURVE_TYPES = ["linear", "catmull", "centripetal", "chordal"];

// Content sniff used by the .json parse path: does this file CLAIM to be a spline?
// The fileType alone decides, so a spline file that is malformed still reaches
// validateSplineJSON and gets a proper error, rather than falling through to the
// generic JSON track handlers and disappearing quietly.
export function isSplineJSON(data) {
    return !!data
        && typeof data === "object"
        && data.fileType === SPLINE_FILE_TYPE;
}

/**
 * Check a file that passed isSplineJSON is actually usable.
 * Returns null if fine, otherwise a message naming the problem.
 *
 * The sniff decides "this is meant to be a spline file"; this decides "and it can
 * be loaded". The format invites hand-editing, so every field that gets consumed
 * is checked here rather than at the point it blows up — a bad value otherwise
 * surfaces far downstream (NaN control points render as an invisible track).
 */
export function validateSplineJSON(data) {
    if (data.version !== undefined
        && (typeof data.version !== "number" || data.version > SPLINE_FILE_VERSION)) {
        return `version ${data.version} is not one this build understands (${SPLINE_FILE_VERSION})`;
    }
    if (data.name !== undefined && typeof data.name !== "string") {
        return "name must be a string";
    }
    if (data.curveType !== undefined && !SPLINE_CURVE_TYPES.includes(data.curveType)) {
        return `curveType "${data.curveType}" is not one of ${SPLINE_CURVE_TYPES.join(", ")}`;
    }
    for (const key of ["constantSpeed", "extrapolateTrack", "altitudeLockAGL"]) {
        if (data[key] !== undefined && typeof data[key] !== "boolean") {
            return `${key} must be true or false`;
        }
    }
    if (data.altitudeLock !== undefined
        && (typeof data.altitudeLock !== "number" || !Number.isFinite(data.altitudeLock))) {
        return "altitudeLock must be a number (-1 for off)";
    }
    if (data.altitudeOffset !== undefined
        && (typeof data.altitudeOffset !== "number" || !Number.isFinite(data.altitudeOffset))) {
        return "altitudeOffset must be a number (metres)";
    }

    if (!Array.isArray(data.points)) {
        return "no points array";
    }
    if (data.points.length === 0) {
        return "no control points";
    }

    let previousFrame = null;
    for (let i = 0; i < data.points.length; i++) {
        const p = data.points[i];
        if (!Array.isArray(p) || p.length < 4) {
            return `point ${i} is not a [frame, lat, lon, alt] array`;
        }
        for (let j = 0; j < 4; j++) {
            if (typeof p[j] !== "number" || !Number.isFinite(p[j])) {
                return `point ${i} has a non-numeric value in column ${j}`;
            }
        }
        if (Math.abs(p[1]) > 90 || Math.abs(p[2]) > 180) {
            return `point ${i} has an out-of-range lat/lon (${p[1]}, ${p[2]})`;
        }
        // Frames must strictly increase. PointEditor.getPointFrame finds the
        // bracketing segment by walking the list in order, then divides by
        // (frames[s+1] - frames[s]) — equal frames divide by zero and unordered
        // ones select the wrong segment, either way poisoning every frame of
        // the track with NaN.
        if (previousFrame !== null && p[0] <= previousFrame) {
            return `point ${i} has frame ${p[0]}, which does not come after ${previousFrame}` +
                ` — frame numbers must strictly increase`;
        }
        previousFrame = p[0];
    }
    return null;
}

/**
 * Build the interchange object from a spline editor's live control points.
 * @param {Object} v
 * @param {string} v.name - display name; also the exported filename stem
 * @param {Vector3[]} v.positions - control points in ECEF
 * @param {number[]} v.frameNumbers - frame number per control point
 * @param {number} v.frames - the track's frame count (for reference)
 * @param {string} [v.curveType] - linear | catmull | centripetal | chordal
 * @param {boolean} [v.constantSpeed]
 * @param {boolean} [v.extrapolateTrack]
 * @param {number} [v.altitudeLock] - -1 = off
 * @param {boolean} [v.altitudeLockAGL]
 * @param {number} [v.altitudeOffset] - metres added to the output track
 * @param {string} [v.color] - "#rrggbb"; omitted means "use the auto palette"
 */
export function makeSplineJSON(v) {
    const points = [];
    for (let i = 0; i < v.positions.length; i++) {
        const lla = ECEFToLLAVD_radii(v.positions[i]);
        points.push([v.frameNumbers[i], lla.x, lla.y, lla.z]);
    }

    const json = {
        fileType: SPLINE_FILE_TYPE,
        version: SPLINE_FILE_VERSION,
        name: v.name,
        // provenance only — optional so this stays a pure function of its
        // arguments and can be exercised without a loaded sitch
        sourceSitch: Sit?.name,
        fps: Sit?.fps,
        frames: v.frames,
        curveType: v.curveType ?? "chordal",
        constantSpeed: v.constantSpeed ?? false,
        extrapolateTrack: v.extrapolateTrack ?? true,
        altitudeLock: v.altitudeLock ?? -1,
        altitudeLockAGL: v.altitudeLockAGL ?? true,
        // Metres, and applied to the output rather than the control points — so a
        // spline adjusted with Alt offset transfers at the altitude you set it to,
        // not the one its raw points describe.
        altitudeOffset: v.altitudeOffset ?? 0,
        altitudeDatum: "HAE",
        columns: ["frame", "lat", "lon", "alt"],
        points: points,
    };

    if (v.color !== undefined) {
        json.color = v.color;
    }

    return json;
}

// [frame, lat, lon, alt] -> [frame, x, y, z] in ECEF, the format
// CNodeSplineEditor / addSyntheticTrack expect for initialPoints.
export function splineJSONToECEFPoints(json) {
    const out = [];
    for (const p of json.points) {
        const ecef = LLAVToECEF(new Vector3(p[1], p[2], p[3]));
        out.push([p[0], ecef.x, ecef.y, ecef.z]);
    }
    return out;
}

// "UAP Spline" -> "UAP Spline" first time, "UAP Spline 2" next, and so on.
// Pure so the collision rules can be tested without a node graph.
export function makeUniqueName(name, taken) {
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} ${n}`)) n++;
    return `${name} ${n}`;
}

/**
 * A switch option is a plain-object key, so a name that happens to be an
 * Object.prototype property ("constructor", "__proto__", "toString", ...) is not
 * safe: CNodeSwitch.removeOption guards with `inputs[option] !== undefined`,
 * which is TRUE for an inherited property, so it would try to remove an input
 * that was never added — throwing after the track is half built. Such a name is
 * also invisible to the Object.keys() collision gathering below.
 *
 * Renamed rather than rejected, mirroring how TrackManager handles a numeric-only
 * track name (it prepends "#" too).
 */
export function safeTrackName(name) {
    return ({})[name] !== undefined ? "#" + name : name;
}

// Names a spline must not claim, from all three registries that matter:
//
//  - usedShortNames: TrackManager's canonical registry, consulted by the imported
//    and balloon track paths. addSyntheticTrack registers the chosen name there,
//    which is what stops a KML loaded LATER from picking the same name.
//  - existing track menuText, for anything not in that registry.
//  - the drop-target switches' options — addSyntheticTrack registers a track with
//    removeOption(name)/addOption(name), so a spline named "fixedCamera" would
//    delete that switch's built-in option and put itself in its place.
function takenTrackNames() {
    const taken = new Set(TrackManager.usedShortNames);
    TrackManager.iterate((key, trackOb) => {
        if (trackOb.menuText !== undefined) taken.add(trackOb.menuText);
    });
    for (let target of Sit.dropTargets?.track ?? []) {
        target = target.replace(/-\d+$/, "");
        const switchNode = NodeMan.get(target, false);
        if (!switchNode?.inputs) continue;
        for (const option of Object.keys(switchNode.inputs)) {
            taken.add(option);
        }
    }
    return taken;
}


function colorHexToInt(color) {
    if (typeof color !== "string") return undefined;
    const parsed = parseInt(color.replace(/^#/, ""), 16);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Create a synthetic track from a dropped/loaded spline interchange file.
 * Returns the track object, or null if the file had no usable points.
 */
export function importSplineJSON(filename, json) {
    const problem = validateSplineJSON(json);
    if (problem) {
        showError(`Can't import spline "${filename}": ${problem}`);
        return null;
    }

    const initialPoints = splineJSONToECEFPoints(json);

    // safeTrackName covers the filename fallback too — a file called
    // "constructor.spline.json" is as dangerous as a "name": "constructor" field.
    const requestedName = safeTrackName(
        json.name || filename.replace(/\.spline\.json$/i, "").replace(/\.json$/i, ""));

    // Use the file's name so switch options and the Contents folder read
    // "UAP Spline" rather than "synth_01_d", made unique because the short name
    // keys switch options — a second import of the same spline would otherwise
    // silently steal the first's entry. addSyntheticTrack reserves it in
    // TrackManager.usedShortNames so later track loads route around it too.
    //
    // The SAME uniqued value is used for both name and shortName: they feed
    // different fields (menuText on the spline node vs on the track object), and
    // letting them diverge means a track shown as "Lantern 2" exports itself as
    // "Lantern.spline.json".
    const name = makeUniqueName(requestedName, takenTrackNames());

    const trackOb = TrackManager.addSyntheticTrack({
        name: name,
        shortName: name,
        initialPoints: initialPoints,
        curveType: json.curveType,
        color: colorHexToInt(json.color),
        editMode: false,
    });

    if (!trackOb) return null;

    // Properties addSyntheticTrack doesn't take as options — apply them the
    // same way TrackManager.deserialize() does, on the unsmoothed spline node.
    const splineEditorNode = NodeMan.get(trackOb.trackID + "_unsmoothed", false);
    if (splineEditorNode) {
        trackOb.constantSpeed = json.constantSpeed ?? false;
        trackOb.extrapolateTrack = json.extrapolateTrack ?? true;
        trackOb.altitudeLock = json.altitudeLock ?? -1;
        trackOb.altitudeLockAGL = json.altitudeLockAGL ?? true;
        trackOb.altitudeOffset = json.altitudeOffset ?? 0;
        splineEditorNode.constantSpeed = trackOb.constantSpeed;
        splineEditorNode.extrapolateTrack = trackOb.extrapolateTrack;
        splineEditorNode.altitudeLock = trackOb.altitudeLock;
        splineEditorNode.altitudeLockAGL = trackOb.altitudeLockAGL;
        splineEditorNode.altitudeOffset = trackOb.altitudeOffset;
        splineEditorNode.updateAltitudeLock();

        // Keep the folder's sliders in step with the values we just applied.
        const altLockNode = NodeMan.get(trackOb.trackID + "_altitudeLock", false);
        if (altLockNode) {
            // -1 is the "off" sentinel, not a length, so it must not be converted.
            if (trackOb.altitudeLock < 0) {
                altLockNode.setValue(-1, true);
            } else {
                altLockNode.setValueWithUnits(trackOb.altitudeLock, "metric", "small", true);
            }
        }
        // The file stores metres, but the slider holds DISPLAY units (feet, by
        // default) — assigning .value directly would make it read "76.2 ft" for a
        // 76.2 m offset. setValueWithUnits does the conversion; ignoreOnChange
        // because the offset is already applied to the node above.
        const altOffsetNode = NodeMan.get(trackOb.trackID + "_altitudeOffset", false);
        if (altOffsetNode) {
            altOffsetNode.setValueWithUnits(trackOb.altitudeOffset, "metric", "small", true);
        }

        splineEditorNode.recalculateCascade();
    }

    console.log(`Imported spline "${name}" from ${filename} as synthetic track ${trackOb.trackID}`);

    if (json.fps !== undefined && Sit.fps !== undefined && Math.abs(json.fps - Sit.fps) > 0.01) {
        console.warn(`Spline "${name}" was authored at ${json.fps} fps, this sitch is ${Sit.fps} fps — ` +
            `control point frame numbers will not line up with the video.`);
    }

    return trackOb;
}
