// "Show Algorithm Working" — replay a camera fit's search, one step per rendered frame.
//
// A fit normally happens between one frame and the next: the camera is in the wrong place, and
// then it is in the right one. That hides the only part a reader can actually check. Replaying it
// puts the search on screen — the look view shows the 3D sliding into register with the video
// while the main view shows the frustum and the sight lines swinging round to the landmarks.
//
// The two solvers produce traces of quite different shapes, and the difference is the point.
//
//   The direct fit is a DESCENT. It starts from a rough seed and walks downhill in reprojection
//   error, so the replay converges: big moves first, then smaller ones, then nothing.
//
//   The homography is a SWEEP. Every focal length it scores implies a complete camera — position
//   and pointing fall out of the same decomposition — so the replay slides the camera along the
//   focal/position trade-off from wide to narrow, passing through the answer rather than settling
//   on it. When the landmarks are all at similar range that slide is long and the score barely
//   changes, which is the honest picture of an unobservable height and is very hard to convey any
//   other way.
//
// Playback is driven off the render loop rather than par.frame, because par.frame is the video
// timeline and the search has nothing to do with it.

import {NodeMan, setRenderOne} from "./Globals";

/**
 * Roughly how many frames the whole replay should take, at any trace length.
 *
 * The two solvers differ by an order of magnitude in step count — the direct fit converges in
 * about a dozen accepted steps, the homography sweep is ~140 samples — so a fixed frames-per-step
 * makes one of them a blink and the other a wait. Measured on a real 7-point fit: 12 steps at one
 * frame each is over in a fifth of a second, which is not something a viewer can follow. Holding
 * each step for a computed number of frames keeps both around three seconds.
 */
const TARGET_FRAMES = 180;
/** Never hold so long that a short trace turns into a slideshow. */
const MAX_HOLD = 14;

export class FitSearchPlayback {
    constructor() {
        this.trace = null;
        this.index = 0;
        this.holdCounter = 0;
        this.hold = 1;
        this.onFinished = null;
        this.label = "";
    }

    get running() {
        return this.trace !== null;
    }

    /**
     * @param {Array}    trace  states from a solver's `trace`, oldest first
     * @param {string}   label  shown in the fit's Status line while it plays
     * @param {Function} onFinished called once, after the last step, whether it ran to the end or
     *        was stopped — the caller uses it to apply the real result, so a replay always lands
     *        on the same camera the fit would have produced without it.
     */
    start(trace, label, onFinished) {
        // A second start supersedes the first; finish the old one so its caller is not left
        // waiting on a callback that will never come.
        this.stop();
        if (!Array.isArray(trace) || trace.length === 0) {
            onFinished?.();
            return false;
        }
        this.trace = trace;
        this.index = 0;
        this.holdCounter = 0;
        this.hold = Math.max(1, Math.min(MAX_HOLD, Math.round(TARGET_FRAMES / trace.length)));
        this.label = label;
        this.onFinished = onFinished;
        setRenderOne(true);
        return true;
    }

    /** Called once per rendered frame. Returns the state shown, or null when not playing. */
    step() {
        if (this.trace === null) return null;
        if (this.holdCounter > 0) {
            this.holdCounter--;
            setRenderOne(true);
            return this.trace[Math.min(this.index, this.trace.length - 1)];
        }
        const state = this.trace[this.index];
        this.index++;
        this.holdCounter = this.hold - 1;
        if (this.index >= this.trace.length) {
            // Show the last step, THEN finish — stopping on arrival would skip it.
            this.finish();
        } else {
            setRenderOne(true);
        }
        return state;
    }

    /** Stop without running the remaining steps. The finished callback still fires. */
    stop() {
        if (this.trace === null) return;
        this.finish();
    }

    finish() {
        const done = this.onFinished;
        this.trace = null;
        this.onFinished = null;
        this.index = 0;
        this.holdCounter = 0;
        done?.();
        setRenderOne(true);
    }

    /** Progress as "step 12 / 47", for the status line. */
    get progress() {
        if (this.trace === null) return "";
        return `${Math.min(this.index, this.trace.length)} / ${this.trace.length}`;
    }
}

/**
 * Put a traced state onto the live camera.
 *
 * Deliberately the same three writes `CNodeFitCameraPoints.restoreCameraState` makes — the path
 * undo already relies on — and nothing else. In particular it does NOT touch the switches:
 * selecting a heading source fires a listener that re-syncs ptzAngles from the current camera, so
 * doing it per frame would fight the playback. The switches are set once, by the real applyResult,
 * when the replay finishes.
 *
 * @param {object} state {position: [x,y,z] ECEF, azDeg, elDeg, rollDeg, vfovDeg}
 * @param {Function} ecefToLLA  converter supplied by the caller, so this stays free of Sitrec's
 *        coordinate modules and of any opinion about the geoid
 */
export function showTracedCamera(state, ecefToLLA) {
    const fixed = NodeMan.get("fixedCameraPosition", false);
    const ptz = NodeMan.get("ptzAngles", false);
    if (!fixed || !ptz || !state) return;
    const lla = ecefToLLA(state.position);
    if (lla !== null) {
        fixed.agl = false;
        fixed.setLLA(lla[0], lla[1], lla[2]);
    }
    ptz.relative = false;
    ptz.az = state.azDeg;
    ptz.el = state.elDeg;
    if (ptz.roll !== undefined && Number.isFinite(state.rollDeg)) ptz.roll = state.rollDeg;
    if (Number.isFinite(state.vfovDeg)) ptz.fov = state.vfovDeg;
    ptz.refresh();
}
