// Sitrec FOV interchange format (.fov.json)
//
// Keyframes for the look camera's vertical field of view, in the form the FOV
// Editor (CNodeCurveEditor2, id "fovEditor") consumes: {x: frame, y: degrees}
// with linear interpolation between them.
//
// The point is to lift a camera zoom track out of a sitch that computes it
// however it likes — a legacy sitch reading a CSV column in a preRenderFunction,
// a dropped MISB track, a hand-set value — and land it in the editor, where it
// can be seen and adjusted. Export walks the CURRENT FOV source frame by frame
// and reduces those samples to the fewest keyframes that reproduce them under
// the editor's linear interpolation; import feeds them straight back in.
//
// An instant zoom change therefore comes out as two keyframes one frame apart
// (last frame of the old value, first frame of the new), which is a step under
// linear interpolation — not a ramp. That is exactly what a real camera's
// discrete zoom steps look like, e.g. Aguadilla's.

import {NodeMan, Sit} from "./Globals";
import {showError} from "./showError";
import {par} from "./par";
import {saveAs} from "file-saver";
import {extractFOV} from "./FOVUtils";

export const FOV_FILE_TYPE = "sitrec-fov";
export const FOV_FILE_VERSION = 1;

// Absolute tolerance in degrees for the keyframe reduction. Small enough that
// even Aguadilla's sub-degree FOVs (0.27 - 0.8) reduce exactly, rather than
// having genuine steps smoothed away.
export const FOV_EPSILON_DEGREES = 1e-4;

// Sanity bound on a vertical FOV. Three.js will accept more, but a file outside
// this is a unit mix-up (radians, or a raw zoom factor) rather than a camera.
// Exported so the export path can refuse to write a file the import path would
// then reject.
export const MAX_FOV_DEGREES = 179;

export function isFOVJSON(data) {
    return !!data
        && typeof data === "object"
        && data.fileType === FOV_FILE_TYPE;
}

/**
 * Returns null if the file is usable, otherwise a message naming the problem.
 */
export function validateFOVJSON(data) {
    if (data.version !== undefined
        && (typeof data.version !== "number" || data.version > FOV_FILE_VERSION)) {
        return `version ${data.version} is not one this build understands (${FOV_FILE_VERSION})`;
    }
    if (data.name !== undefined && typeof data.name !== "string") {
        return "name must be a string";
    }
    // These three describe how the numbers are to be READ. Reading a radians or
    // horizontal-FOV or stepped file as degree-linear-vertical produces a plausible
    // but wrong zoom track, so refuse rather than reinterpret.
    if (data.units !== undefined && data.units !== "degrees") {
        return `units "${data.units}" is not degrees`;
    }
    if (data.axis !== undefined && data.axis !== "vertical") {
        return `axis "${data.axis}" is not vertical`;
    }
    if (data.interpolation !== undefined && data.interpolation !== "linear") {
        return `interpolation "${data.interpolation}" is not linear`;
    }
    if (!Array.isArray(data.keyframes)) {
        return "no keyframes array";
    }
    if (data.keyframes.length === 0) {
        return "no keyframes";
    }

    let previousFrame = null;
    for (let i = 0; i < data.keyframes.length; i++) {
        const k = data.keyframes[i];
        if (!Array.isArray(k) || k.length < 2) {
            return `keyframe ${i} is not a [frame, fov] array`;
        }
        const [frame, fov] = k;
        if (typeof frame !== "number" || !Number.isFinite(frame)) {
            return `keyframe ${i} has a non-numeric frame`;
        }
        if (typeof fov !== "number" || !Number.isFinite(fov)) {
            return `keyframe ${i} has a non-numeric fov`;
        }
        if (fov <= 0 || fov > MAX_FOV_DEGREES) {
            return `keyframe ${i} has fov ${fov}, outside 0..${MAX_FOV_DEGREES} degrees`;
        }
        // The editor interpolates between consecutive points by frame, so two
        // keyframes on the same frame are ambiguous and a decreasing one is a
        // segment of negative length.
        if (previousFrame !== null && frame <= previousFrame) {
            return `keyframe ${i} has frame ${frame}, which does not come after ${previousFrame}` +
                ` — frames must strictly increase`;
        }
        previousFrame = frame;
    }
    return null;
}

/**
 * Reduce per-frame samples to the fewest [frame, value] keyframes that reproduce
 * them under linear interpolation, to within epsilon.
 *
 * Greedy longest-segment fit: extend the current run while every sample inside it
 * still lies on the straight line from the run's start to the candidate end. The
 * first sample that does not fit closes the run at the PREVIOUS index, and a new
 * run starts there. On a step change that yields adjacent keyframes; on a ramp,
 * just its two endpoints; on a constant stretch, just its ends.
 *
 * Exported for testing.
 */
export function reduceToKeyframes(values, epsilon = FOV_EPSILON_DEGREES) {
    const n = values.length;
    if (n === 0) return [];
    if (n === 1) return [[0, values[0]]];

    const keyframes = [];
    let start = 0;
    keyframes.push([0, values[0]]);

    // Instead of re-testing every interior sample each time the run grows (which
    // is quadratic, and an hour of 30 fps is 108,000 samples), carry the run's
    // feasible SLOPE interval. Requiring
    //     |values[i] - (values[start] + m*(i-start))| <= epsilon
    // is the same as requiring
    //     m in [(values[i]-values[start]-eps)/(i-start),
    //           (values[i]-values[start]+eps)/(i-start)]
    // so each interior sample just narrows the interval once, in O(1), and the
    // test is whether the start->end line's own slope still lies inside it.
    // Identical results to the per-sample check, linear time.
    let loSlope = -Infinity;
    let hiSlope = Infinity;

    let end = 1;
    while (end < n) {
        const span = end - start;
        const slope = (values[end] - values[start]) / span;

        if (slope >= loSlope && slope <= hiSlope) {
            // end joins the run, so it becomes an interior sample: fold in its
            // constraint before considering the next one.
            const rise = values[end] - values[start];
            const lo = (rise - epsilon) / span;
            const hi = (rise + epsilon) / span;
            if (lo > loSlope) loSlope = lo;
            if (hi < hiSlope) hiSlope = hi;
            end++;
        } else {
            // Close the run one short of the sample that broke it, and restart there.
            const keep = end - 1;
            keyframes.push([keep, values[keep]]);
            start = keep;
            loSlope = -Infinity;
            hiSlope = Infinity;
            end = start + 1;
        }
    }

    const last = n - 1;
    if (keyframes[keyframes.length - 1][0] !== last) {
        keyframes.push([last, values[last]]);
    }

    return keyframes;
}

/**
 * The node currently supplying the camera FOV, if the sitch has one.
 * In a custom sitch this is fovSwitch, which resolves to whichever option the
 * "Camera FOV" dropdown has selected — so sampling it captures the user's
 * current choice, not a fixed source.
 */
function getFOVSourceNode() {
    return NodeMan.get("fovSwitch", false);
}

/**
 * Sample the effective vertical FOV, in degrees, for every frame of the sitch.
 *
 * Two routes, because sitches drive the camera FOV two different ways:
 *  - a FOV node (custom sitches): read it per frame, which respects whichever
 *    option the Camera FOV dropdown currently has selected.
 *  - no FOV node (legacy sitches such as Aguadilla): the FOV is computed inside
 *    the look view's preRenderFunction from par.frame, so step par.frame through
 *    the sitch and read what that function puts on the camera. par.frame and the
 *    camera are restored afterwards.
 *
 * Returns {values, source} or null if neither route is available.
 */
export function sampleFOVPerFrame() {
    const frames = Sit.frames;
    if (!frames || frames <= 0) return null;

    const fovNode = getFOVSourceNode();
    if (fovNode) {
        const values = new Array(frames);
        for (let f = 0; f < frames; f++) {
            // A FOV source is not always a plain number: a dropped MISB track
            // yields a row (SensorVerticalFieldofView), and some tracks carry a
            // vFOV member. extractFOV is what every other consumer of fovSwitch
            // uses (CNodeLOS, PTZUI, TrackingOverlay), so use it here too rather
            // than refusing to export exactly the sources worth capturing.
            values[f] = extractFOV(fovNode.getValueFrame(f));
        }
        const choice = fovNode.choice ?? "";
        return {values, source: choice ? `fovSwitch:${choice}` : "fovSwitch"};
    }

    // Legacy path: drive the per-frame update and read the camera it writes to.
    const lookView = NodeMan.get("lookView", false);
    const lookCameraNode = NodeMan.get("lookCamera", false);
    if (!lookView || !lookView.preRenderFunction || !lookCameraNode?.camera) {
        return null;
    }

    const camera = lookCameraNode.camera;
    const savedFrame = par.frame;
    const values = new Array(frames);
    try {
        for (let f = 0; f < frames; f++) {
            par.frame = f;
            lookView.preRenderFunction();
            values[f] = camera.fov;
        }
    } finally {
        par.frame = savedFrame;
        // Put the camera back to where the current frame says it should be.
        lookView.preRenderFunction();
    }
    return {values, source: "lookCamera.preRenderFunction"};
}

/**
 * Build the interchange object from per-frame samples.
 */
export function makeFOVJSON(v) {
    const keyframes = reduceToKeyframes(v.values, v.epsilon ?? FOV_EPSILON_DEGREES);
    return {
        fileType: FOV_FILE_TYPE,
        version: FOV_FILE_VERSION,
        name: v.name,
        sourceSitch: Sit?.name,
        sourceNode: v.source,
        fps: Sit?.fps,
        frames: v.values.length,
        units: "degrees",
        // Three.js PerspectiveCamera.fov is the VERTICAL angle, and so is the
        // FOV Editor's y axis. Recorded so a horizontal-FOV file can't be fed
        // in silently.
        axis: "vertical",
        interpolation: "linear",
        columns: ["frame", "fov"],
        keyframes: keyframes,
    };
}

/**
 * "Export for FOV Editor" — the Camera > FOV (Zoom) button.
 * Samples the current FOV source across the sitch and writes the keyframes out.
 */
export function exportFOVForEditor() {
    const sampled = sampleFOVPerFrame();
    if (!sampled) {
        showError("Nothing to export: this sitch has no FOV source that can be sampled " +
            "per frame (no fovSwitch node, and no look view preRenderFunction).");
        return null;
    }

    // Same bounds the importer enforces, so this can never write a file that
    // then refuses to load.
    const bad = sampled.values.findIndex(v =>
        typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_FOV_DEGREES);
    if (bad !== -1) {
        showError(`Can't export FOV: the current source returned ${sampled.values[bad]} ` +
            `at frame ${bad}, outside 0..${MAX_FOV_DEGREES} degrees.`);
        return null;
    }

    const name = `${Sit?.name ?? "sitrec"}-fov`;
    const json = makeFOVJSON({name, values: sampled.values, source: sampled.source});

    // A source that changes every frame (per-frame MISB FOV, say) legitimately
    // reduces to a keyframe per frame. Faithful, but say so — a few thousand
    // points is a lot to then hand-edit.
    if (json.keyframes.length > 500) {
        console.warn(`Exported ${json.keyframes.length} FOV keyframes from ${sampled.source} ` +
            `over ${sampled.values.length} frames — the source varies nearly every frame, ` +
            `so the editor will be dense.`);
    }

    console.log(`Exported ${json.keyframes.length} FOV keyframes from ${sampled.source} ` +
        `(${sampled.values.length} frames sampled)`);

    saveAs(new Blob([JSON.stringify(json, null, 2)], {type: "application/json"}),
        name + ".fov.json");

    return json;
}

/**
 * Load keyframes into the FOV Editor and make it the active FOV source.
 * Returns the editor node, or null if the file or the sitch can't support it.
 */
export function importFOVJSON(filename, json) {
    const problem = validateFOVJSON(json);
    if (problem) {
        showError(`Can't import FOV file "${filename}": ${problem}`);
        return null;
    }

    const fovEditor = NodeMan.get("fovEditor", false);
    if (!fovEditor) {
        showError(`Can't import FOV file "${filename}": this sitch has no FOV Editor. ` +
            `Load it into a custom sitch.`);
        return null;
    }

    // Work everything out BEFORE touching the editor, so nothing can fail partway
    // and leave it holding new points with a stale axis and no recalculate.
    const points = new Array(json.keyframes.length);
    // A plain loop rather than Math.max(...array): spreading blows the argument
    // limit (~125k) and a dense per-frame source over a long sitch gets there.
    let maxFOV = 0;
    for (let i = 0; i < json.keyframes.length; i++) {
        const k = json.keyframes[i];
        points[i] = {x: k[0], y: k[1]};
        if (k[1] > maxFOV) maxFOV = k[1];
    }

    // Widen the editor's y axis if the data needs it, and tighten it for a
    // narrow-FOV sitch — the default 0..40 makes Aguadilla's sub-degree zoom
    // track a flat line pinned to the bottom of the graph.
    const niceMax = maxFOV <= 1 ? Math.ceil(maxFOV * 10) / 10
        : maxFOV <= 10 ? Math.ceil(maxFOV)
        : Math.ceil(maxFOV / 5) * 5;

    fovEditor.editorView.setPoints(points);
    fovEditor.editorView.maxY = niceMax;
    if (fovEditor.editorView.yRangeSlider) {
        fovEditor.editorView.yRangeSlider.value = niceMax;
    }

    fovEditor.recalculate();
    fovEditor.recalculateCascade();

    // Make it the live FOV source, otherwise the import appears to do nothing.
    const fovSwitch = NodeMan.get("fovSwitch", false);
    if (fovSwitch && fovSwitch.inputs["FOV Editor"] !== undefined) {
        fovSwitch.selectOption("FOV Editor");
    }

    console.log(`Imported ${points.length} FOV keyframes from ${filename} ` +
        `(y axis 0..${niceMax} degrees)`);

    if (json.frames !== undefined && Sit.frames !== undefined && json.frames !== Sit.frames) {
        console.warn(`FOV file "${filename}" was authored over ${json.frames} frames, ` +
            `this sitch has ${Sit.frames} — keyframe frame numbers are absolute, so the ` +
            `zoom track will not line up with the video.`);
    }

    return fovEditor;
}
