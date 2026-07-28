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

export const SPLINE_FILE_TYPE = "sitrec-spline";
export const SPLINE_FILE_VERSION = 1;

// Content sniff used by the .json parse path. Deliberately narrow so a
// generic .json track file (GeoJSON, FlightClub, ...) can't be mistaken for one.
export function isSplineJSON(data) {
    return !!data
        && typeof data === "object"
        && data.fileType === SPLINE_FILE_TYPE
        && Array.isArray(data.points);
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
        sourceSitch: Sit.name,
        fps: Sit.fps,
        frames: v.frames,
        curveType: v.curveType ?? "chordal",
        constantSpeed: v.constantSpeed ?? false,
        extrapolateTrack: v.extrapolateTrack ?? true,
        altitudeLock: v.altitudeLock ?? -1,
        altitudeLockAGL: v.altitudeLockAGL ?? true,
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
    const initialPoints = splineJSONToECEFPoints(json);
    if (initialPoints.length === 0) {
        console.warn(`importSplineJSON: ${filename} has no points`);
        return null;
    }

    const name = json.name || filename.replace(/\.spline\.json$/i, "").replace(/\.json$/i, "");

    const trackOb = TrackManager.addSyntheticTrack({
        name: name,
        // Use the file's name as the short name so switch options and the
        // Contents folder read "UAP Spline" rather than "synth_01_d".
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
        splineEditorNode.constantSpeed = trackOb.constantSpeed;
        splineEditorNode.extrapolateTrack = trackOb.extrapolateTrack;
        splineEditorNode.altitudeLock = trackOb.altitudeLock;
        splineEditorNode.altitudeLockAGL = trackOb.altitudeLockAGL;
        splineEditorNode.updateAltitudeLock();

        // Keep the folder's Alt Lock slider in step with the value we just applied.
        const altLockNode = NodeMan.get(trackOb.trackID + "_altitudeLock", false);
        if (altLockNode) {
            altLockNode.value = trackOb.altitudeLock;
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
