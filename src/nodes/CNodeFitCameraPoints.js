// "Fit Camera to Points" — recover an unknown camera from landmarks the analyst can identify.
//
// The problem: a redacted clip arrives with the platform position and the field of view stripped
// out. Those are exactly the two things every downstream measurement in Sitrec depends on. But
// the footage still SHOWS places, and the analyst can still say "that pixel is that headland".
// Enough of those pairs determine the camera, and this is the tool for stating them.
//
// A pair is one 2D point on the video and one point on the GROUND in the world. Both are drawn
// as the same circle-and-crosshair handle in the same colour — on the video, and again in the
// main and look views (see FitPointHandles3D) — because they are two statements about one thing:
// that pixel is that place. Move either and the camera is re-solved so the two agree.
//
// Note the workflow this implies, because it is the opposite of what it first looks like. A newly
// added pair seeds its ground point by casting the current camera's ray through the clicked pixel
// onto the terrain — so it starts sitting EXACTLY on its own line of sight and contributes no
// information at all. The information arrives when the user drags the ground handle to where the
// feature really is. Clicking adds a question; dragging answers it.
//
//
// THIS NODE IS A TOOL, NOT A CONTROLLER.
//
// It writes into the ordinary camera nodes — fixedCameraPosition, ptzAngles, fovUI — and then
// stops existing as far as the render path is concerned. Switch "Enable Fit" off and there is no
// overlay, no handle, no listener, no solve and no camera write: the camera simply keeps the
// values the last fit gave it, indistinguishable from a hand-set camera. The saved control points
// stay in the sitch so the solution can be re-opened, inspected and revised later, which also
// makes them a record of WHICH landmarks a published camera was derived from.

import {CNodeActiveOverlay} from "./CNodeTrackingOverlay";
import {CNodeVideoView} from "./CNodeVideoView";
import {Matrix4, Vector3} from "three";
import {assert} from "../assert";
import {Globals, guiMenus, NodeMan, setRenderOne, UndoManager} from "../Globals";
import {par} from "../par";
import {claimRightClick, mouseToCanvas} from "../ViewUtils";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {getLocalUpVector, getNorthPole} from "../SphericalMath";
import {extractFOV} from "./CNodeControllerVarious";
import {FitPointHandles3D, surfaceAlongRay} from "../FitPointHandles3D";
import {FitPointSightLines3D} from "../FitPointSightLines3D";
import {FitSearchPlayback, showTracedCamera} from "../FitSearchPlayback";
import {drawFitHandle, GRAB_RADIUS, POINT_COLORS} from "../FitHandleDraw";
import {
    azElRollFromBasis, basisFromAzElRoll, evaluateCamera, fitCameraToPoints, MAX_ABS_EL,
    projectWorldPoint,
} from "../CameraPointFit";
import {fitCameraByPlaneHomography} from "../CameraPlaneHomography";
import {lensFromVFOV} from "../CameraLens";
import {KeyframeRegistry} from "../CKeyframeRegistry";
import {interpolateFitCamera} from "../FitKeyframeMotion";
import {
    attachFitPointsMotion, detachFitPointsMotion,
    FIT_POINTS_FOV_OPTION, FIT_POINTS_HEADING_OPTION, FIT_POINTS_TRACK_OPTION,
} from "./CNodeFitPointsMotion";

/** Solver choices for the Method dropdown. Values are what gets serialised. */
export const FIT_METHODS = {
    "3D points (direct)": "direct",
    "Plane homography": "homography",
};
import {showConfirm} from "../showError";

/** Movement below this many canvas pixels still counts as a click, not a drag. */
const CLICK_SLOP = 4;
/** How far along the ray to drop a new 3D point when the terrain raycast misses. */
const FALLBACK_RANGE = 5000;
/** The camera contributes pose but no scale to the video quad's world matrix. */
const UNIT_SCALE = new Vector3(1, 1, 1);

export class CNodeFitCameraPoints extends CNodeActiveOverlay {
    constructor(v) {
        super(v);
        assert(this.overlayView instanceof CNodeVideoView,
            "CNodeFitCameraPoints: overlayView must be a CNodeVideoView");

        this.separateVisibility = true;
        this.doubleClickResizes = false;
        this.doubleClickFullScreen = false;

        this.enabled = false;
        this.visible = false;

        // Points own the frame they were placed on. Mixing observations from different frames
        // into one seven-parameter solve would be silently wrong for anything but a locked-off
        // camera, so the frame is recorded and enforced rather than assumed.
        this.fitFrame = 0;
        this.points = [];
        this.nextId = 1;

        // Fit keyframes. Each is the same landmarks observed at another video frame: the 3D
        // half of every pair is SHARED (a landmark is a fact about the world, not about a
        // frame), while the 2D pixel positions are per keyframe, along with the camera the
        // solver recovered from them. `points` always mirrors the ACTIVE keyframe's 2D
        // coordinates — the one at fitFrame — so every existing edit/solve/draw path keeps
        // working on `points` unchanged.
        //
        //   {frame, uv: [[vx, vy], ...] index-aligned with points,
        //    solved: {position:[x,y,z] ECEF, azDeg, elDeg, rollDeg, vfovDeg, fitted} | null}
        //
        // `fitted` distinguishes a camera the solver actually produced from one merely seeded
        // off the live camera when the keyframe was created — a seed is a guess, and the
        // keyframe readout marks it so the user knows which frames still need a real fit.
        this.keyframes = [];
        this.keyframeInfo = "none";

        this.lockPosition = false;
        this.lockFOV = false;
        this.lockRoll = true;
        // Which solver runs. "direct" fits the camera to the points at their real 3D positions;
        // "homography" assumes they are coplanar and recovers the camera from the plane-to-image
        // projective map. Having both makes it possible to tell a disagreement caused by the
        // control points apart from one caused by the choice of method.
        this.fitMethod = "direct";

        this.autoFit = true;
        this.showRays = true;
        // Place control points against the 3D tile geometry — roofs, walls, trees — rather than
        // the elevation surface. Off by default because the elevation surface is the right one
        // for landmarks that ARE the ground, and because it is the one that is always there:
        // both surfaces stream, but elevation tiles cover the whole planet at some zoom while the
        // photorealistic 3D tiles cover a fraction of it and may not be enabled at all.
        this.useTiles = false;
        this.status = "Off";
        this.residual = "-";
        this.observability = "-";

        this.lastResult = null;
        this.applyingFit = false;
        this.draggingId = null;
        // A left-press on empty video, held until release decides whether it was a click (add a
        // point) or a pan. See onMouseDown.
        this.pendingAdd = null;
        this._cancelListener = null;
        this._moveListener = null;
        this._upListener = null;
        // Snapshot taken when an undoable edit opens; see beginUndo.
        this._undoBefore = null;
        this._pendingEnable = undefined;
        this._restoreMatchVideoAspect = undefined;

        this.markers = new FitPointHandles3D({
            getPoints: () => this.points.map((p) => ({
                id: p.id, color: p.color, position: this.pointECEF(p),
            })),
            getRayDisplay: () => this.rayDisplay(),
            getOccluder: () => this.videoQuadOccluder(),
            getUseTiles: () => this.useTiles,
            onMoved: (id, pos) => this.onMarkerMoved(id, pos),
            // A 3D drag moved a SHARED landmark, so every keyframe's solution is stale, not
            // just the active one's.
            onCommit: () => {
                this.requestFit();
                if (this.autoFit) this.refitOtherKeyframes();
            },
            onCorrectFrame: () => this.onCorrectFrame(),
            onBeginEdit: () => this.beginUndo(),
            onEndEdit: (description) => this.endUndo(description),
        });

        this.sightLines = new FitPointSightLines3D(() => this.rayDisplay());
        this.playback = new FitSearchPlayback();

        // Fit keyframes on the frame slider, like every other keyframe set: yellow diamonds,
        // and Shift+,/. steps through them. Pull-based, so this costs nothing to maintain.
        KeyframeRegistry.register("cameraFit", {
            getFrames: () => this.keyframes.map((k) => k.frame),
        });

        this._setupGUI();
    }

    // ---------- serialization ----------
    //
    // 3D points are stored as lat/lon/alt, not ECEF, for the same reason every other position in
    // Sitrec is: an ECEF triple silently means something different if the earth model changes.

    modSerialize() {
        // The mirror may be newer than the keyframe — a save can land mid-gesture, and the
        // keyframe entry, not the mirror, is what uv is written from.
        this.syncActiveKeyframe();
        return {
            ...super.modSerialize(),
            enabled: this.enabled,
            fitFrame: this.fitFrame,
            lockPosition: this.lockPosition,
            lockFOV: this.lockFOV,
            lockRoll: this.lockRoll,
            fitMethod: this.fitMethod,
            autoFit: this.autoFit,
            showRays: this.showRays,
            useTiles: this.useTiles,
            points: this.points.map((p) => ({
                vx: p.vx, vy: p.vy, lat: p.lat, lon: p.lon, alt: p.alt, color: p.color,
            })),
            // points/fitFrame above keep their pre-keyframe meaning (the active keyframe's 2D
            // coordinates), so an older build loading this save still gets a working
            // single-frame fit. The solved camera is stored as geodetic lat/lon with
            // ELLIPSOIDAL height — the same storage the landmarks use, and it converts back to
            // ECEF exactly; MSL is only for the user-facing fixedCameraPosition node.
            keyframes: this.keyframes.map((k) => {
                let solved = null;
                if (k.solved) {
                    const lla = ECEFToLLAVD_radii(new Vector3(...k.solved.position));
                    solved = {
                        lla: [lla.x, lla.y, lla.z],
                        az: k.solved.azDeg, el: k.solved.elDeg,
                        roll: k.solved.rollDeg, fov: k.solved.vfovDeg,
                        fitted: k.solved.fitted !== false,
                    };
                }
                return {frame: k.frame, uv: k.uv.map((u) => [u[0], u[1]]), solved};
            }),
        };
    }

    /**
     * Validate a saved keyframes array into runtime shape, atomically: parse the whole thing,
     * keep only entries that can be trusted, and never let a malformed entry half-apply.
     *
     * A keyframe whose uv cannot be matched to the points is dropped WHOLE rather than padded:
     * padding with another frame's pixels would silently invent observations, which is worse
     * than losing a keyframe the user can re-add. A malformed solved camera just becomes null —
     * the observations are still good, and a solve can be re-run from them.
     */
    parseKeyframes(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        const seen = new Set();
        for (const k of raw) {
            const frame = Math.round(k?.frame);
            if (!Number.isFinite(frame) || frame < 0 || seen.has(frame)) continue;
            const uv = Array.isArray(k.uv) ? k.uv : null;
            if (!uv || uv.length !== this.points.length
                || !uv.every((u) => Array.isArray(u)
                    && Number.isFinite(u[0]) && Number.isFinite(u[1]))) {
                continue;
            }
            let solved = null;
            const s = k.solved;
            if (s && Array.isArray(s.lla) && s.lla.length === 3 && s.lla.every(Number.isFinite)
                && [s.az, s.el, s.roll, s.fov].every(Number.isFinite) && s.fov > 0) {
                const p = LLAToECEF(s.lla[0], s.lla[1], s.lla[2]);
                solved = {
                    position: [p.x, p.y, p.z],
                    azDeg: s.az, elDeg: s.el, rollDeg: s.roll, vfovDeg: s.fov,
                    fitted: s.fitted !== false,
                };
            }
            seen.add(frame);
            out.push({frame, uv: uv.map((u) => [u[0], u[1]]), solved});
        }
        out.sort((a, b) => a.frame - b.frame);
        return out;
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (Array.isArray(v.points)) {
            this.points = v.points.map((p, i) => ({
                id: this.nextId++,
                vx: p.vx, vy: p.vy,
                lat: p.lat, lon: p.lon, alt: p.alt,
                color: p.color ?? POINT_COLORS[i % POINT_COLORS.length],
            }));
        }
        if (Number.isFinite(v.fitFrame)) this.fitFrame = v.fitFrame;
        if (v.lockPosition !== undefined) this.lockPosition = v.lockPosition;
        if (v.lockFOV !== undefined) this.lockFOV = v.lockFOV;
        if (v.lockRoll !== undefined) this.lockRoll = v.lockRoll;
        if (v.fitMethod !== undefined) {
            this.fitMethod = v.fitMethod;
            this.syncMethodControls();
        }
        if (v.autoFit !== undefined) this.autoFit = v.autoFit;
        if (v.showRays !== undefined) this.showRays = v.showRays;
        if (v.useTiles !== undefined) this.useTiles = v.useTiles;

        this.keyframes = this.parseKeyframes(v.keyframes);
        if (this.keyframes.length === 0 && this.points.length > 0) {
            // A pre-keyframe save: the points and the frame they belong to ARE one keyframe.
            // No solved camera is recorded — the fit is deliberately not re-run on load (see
            // below), and Add Fit Keyframe solves it from these correspondences when a second
            // keyframe first makes a solution necessary.
            this.keyframes = [{frame: this.fitFrame, uv: this.pointsUV(), solved: null}];
        } else if (this.keyframes.length > 0) {
            // The keyframes are authoritative for which frames exist; make the active frame
            // one of them and load its observations into the mirror.
            if (!this.keyframes.some((k) => k.frame === this.fitFrame)) {
                this.fitFrame = this.keyframes[0].frame;
            }
            const kf = this.keyframes.find((k) => k.frame === this.fitFrame);
            const n = Math.min(this.points.length, kf.uv.length);
            for (let i = 0; i < n; i++) {
                this.points[i].vx = kf.uv[i][0];
                this.points[i].vy = kf.uv[i][1];
            }
        }
        if (this.keyframes.length >= 2) {
            // Put the "Fit Points" options back into the camera dropdowns NOW, inside the mod
            // pass: the switches restore a saved "Fit Points" choice through pendingChoice,
            // which resolves the moment the option is registered, and the manager's post-mod
            // recalculations re-gate the controllers. The Star Track camera options take
            // exactly this path; the deferral warning below is about creating VIEWS, which
            // these are not.
            attachFitPointsMotion(this);
        }
        this.updateKeyframeInfo();

        // Restore the points, but NOT the fit. The camera already carries the answer the last fit
        // produced — it was written into fixedCameraPosition/ptzAngles/fovUI and saved with them.
        // Re-solving on load would overwrite any hand adjustment made since, to no benefit.
        // Enabling builds two overlay VIEWS, and creating views from inside the mod pass
        // corrupts it. Measured on a real save: 17 other nodes silently lost their restored
        // state — the camera position reverted to the sitch default on the far side of the
        // world, along with the FOV and the target position — because new views appeared in the
        // middle of the loop that was still applying mods to the existing ones. The overlays
        // that predate this feature (annotate, videoMask) sidestep the whole question by being
        // built in CCustomManager.setup(), before any mod is applied.
        //
        // So record the wish and grant it once the pass is over; update() picks it up on the
        // next frame. A feature that appears one frame late is not a cost anyone can see; a
        // sitch that quietly loads with the wrong camera is the worst kind of bug this tool
        // could have, because the camera IS the output.
        if (v.enabled !== undefined) this._pendingEnable = v.enabled;
        this.updateStatus(this.enabled ? "Loaded" : "Off");
        setRenderOne(true);
    }

    update(f) {
        if (super.update) super.update(f);
        // Deferred from modDeserialize — see the note there.
        if (this._pendingEnable !== undefined && !Globals.deserializing) {
            const on = this._pendingEnable;
            this._pendingEnable = undefined;
            this.setEnabled(on);
        }

        // Scrubbing onto a fit keyframe makes it the one being edited. Only while the gesture
        // state is fully idle: an activation mid-drag would swap the point set under the
        // user's cursor and leave one undo entry spanning two keyframes. The open-undo check
        // covers the 3D handle drags too — they bracket themselves with beginUndo/endUndo.
        if (this.enabled && !Globals.deserializing && this.keyframes.length > 0
            && this.pendingAdd === null && this.draggingId === null
            && this._undoBefore === null && !this.playback.running) {
            const f0 = Math.round(par.frame);
            if (f0 !== this.fitFrame && this.keyframes.some((k) => k.frame === f0)) {
                this.activateKeyframe(f0);
                this.updateStatus(`Editing fit keyframe at frame ${f0}`);
            }
        }

        this.stepPlayback();
        this.sightLines.update();
    }

    dispose() {
        this.playback.stop();     // lands the fit rather than abandoning the camera mid-search
        this.setEnabled(false);   // also removes the gesture-cancel listeners
        KeyframeRegistry.unregister("cameraFit");
        this.markers.dispose();
        this.sightLines.dispose();
        super.dispose();
    }

    // ---------- GUI ----------

    _setupGUI() {
        const parent = guiMenus.camera ?? guiMenus.view ?? guiMenus.main;
        if (!parent) return;
        this.gui = parent.addFolder("Fit Camera to Points").close();

        this.gui.add(this, "enabled").name("Enable Fit").listen()
            .onChange((on) => this.setEnabled(on))
            .tooltip("Show the control points and allow editing. When off this feature does " +
                "nothing at all — the camera keeps whatever the last fit gave it. Saved points " +
                "are kept either way.");

        this.gui.add(this, "showRays").name("Show Sight Lines").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("In the main view, draw a line from the camera to each ground point, and " +
                "mark each video point where it falls on the video in the frustum (Show/Hide " +
                "-> Video in Frustum). Every line crosses the video at its own marker only for " +
                "the one camera position and pointing that explains all the pairs at once — so " +
                "any gap you can see is that point's residual, drawn in 3D.");

        this.gui.add(this, "autoFit").name("Fit on Change").listen()
            .tooltip("Re-solve the camera whenever a point is moved. Turn off to place several " +
                "points first and fit once with the button below.");

        this.gui.add(this, "fitNow").name("Fit Now")
            .tooltip("Solve the camera from the current control points.");

        this.gui.add(this, "fitMethod", FIT_METHODS).name("Method").listen()
            .onChange(() => { this.syncMethodControls(); this.requestFit(); })
            .tooltip("How the camera is solved. '3D points' uses each landmark's real terrain " +
                "position and searches position, pointing and FOV together. 'Plane homography' " +
                "instead assumes the landmarks are coplanar, solves the plane-to-image " +
                "projective map, and recovers the focal length from the rotation columns — the " +
                "classical method, and the one most published reconstructions use. On " +
                "well-spread points the two agree; where they disagree, the control points are " +
                "the reason, not the method.");

        // Kept so the Method dropdown can grey them out: the homography solver recovers
        // position, pointing and focal length from one decomposition and cannot hold any of
        // them fixed, so leaving these live would let the user set a lock that did nothing.
        this._lockControls = [
            this.gui.add(this, "lockPosition").name("Lock Position").listen()
                .onChange(() => this.requestFit())
                .tooltip("Keep the camera where it is and solve only pointing and FOV. Use this " +
                    "when the platform position is known, or when all the landmarks are distant " +
                    "and the position is not recoverable from them."),
            this.gui.add(this, "lockFOV").name("Lock FOV").listen()
                .onChange(() => this.requestFit())
                .tooltip("Keep the current field of view and solve only position and pointing."),
            this.gui.add(this, "lockRoll").name("Lock Roll").listen()
                .onChange(() => this.requestFit())
                .tooltip("Hold camera roll at its current value. Leave on unless the horizon in " +
                    "the video is visibly tilted."),
        ];

        const ro = (prop, name, tip) => {
            const c = this.gui.add(this, prop).name(name).listen().disable();
            if (tip) c.tooltip(tip);
            return c;
        };
        ro("status", "Status");
        ro("residual", "Residual",
            "RMS distance between where each 3D point projects and where its 2D point is, in " +
            "original video pixels. A small residual means the camera explains the points; it " +
            "does NOT by itself mean the camera is right — see Observability.");
        ro("observability", "Observability",
            "Whether the landmark geometry can actually determine all the parameters being " +
            "solved. Distant landmarks at similar ranges pin the pointing but leave camera " +
            "range and field of view trading off against each other; when that happens the " +
            "unresolvable combination is held at its starting value rather than invented.");

        this.gui.add(this, "addFitKeyframe").name("Add Fit Keyframe")
            .tooltip("Record this frame as another fit keyframe: the same landmarks, observed " +
                "again. The video markers start where each landmark would appear if the " +
                "camera had not moved — drag them to where the landmarks actually are in THIS " +
                "frame, and the solver recovers where the camera was here. The 3D landmark " +
                "positions are shared by every keyframe and do not change. Keyframes show as " +
                "diamonds on the frame slider; scrub onto one to edit it.");

        this.gui.add(this, "deleteFitKeyframe").name("Delete Fit Keyframe")
            .tooltip("Remove the fit keyframe at the current frame. The landmarks and the " +
                "other keyframes are untouched.");

        this.gui.add(this, "fitKeyframeMotion").name("Fit Keyframe Motion")
            .tooltip("Drive the camera from the fit keyframes: Position, Heading and FOV all " +
                "switch to 'Fit Points', which uses the solved camera at each keyframe and " +
                "moves in a straight line at constant speed between them. Needs at least two " +
                "keyframes with FITTED cameras — a keyframe marked '?' has only a seeded " +
                "guess and is not used for motion until it is solved. Each source can also be " +
                "selected individually in the Camera menu, and switched back to Manual there " +
                "at any time.");

        ro("keyframeInfo", "Keyframes",
            "The fit keyframe frames, and which one is being edited. A frame marked '?' has " +
            "no solved camera yet — go to it and Fit Now (or edit a point with Fit on Change " +
            "on) to solve it.");

        this.gui.add(this, "useTiles").name("Place on 3D Buildings").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Put control points on the 3D tile geometry that is actually on screen — a " +
                "roof, a wall, the top of a tree — instead of on the elevation surface. The " +
                "elevation map has no buildings on it, so a rooftop corner placed against it " +
                "lands at street level, which at short range is a large error and at long range " +
                "is none at all. The tiles are used wherever they cover the ray, even when the " +
                "elevation surface happens to be nearer — which it can be, since it is draped " +
                "over the buildings rather than around them. A landmark on bare ground still " +
                "lands on bare ground, because the tilesets carry their own ground. Needs the " +
                "3D tiles to have loaded; " +
                "affects where new points are dropped and where dragged handles land, not points " +
                "already placed.");

        this.gui.add(this, "showAlgorithmWorking").name("Show Algorithm Working")
            .tooltip("Solve again, but replay the search one step per frame instead of jumping " +
                "straight to the answer. The 3D points fit descends from a rough starting guess " +
                "and converges. The plane homography instead sweeps the field of view, and " +
                "because every focal length it tries implies a whole camera, you watch the " +
                "camera slide along the trade-off — if it travels a long way while the score " +
                "barely changes, these landmarks do not pin it down. Ends on the same camera an " +
                "ordinary Fit Now would give.");

        this.gui.add(this, "clearAllPoints").name("Clear All Points");
        this.syncMethodControls();
    }

    /** Grey out the lock toggles the current solver cannot honour. */
    syncMethodControls() {
        if (!this._lockControls) return;
        const homography = this.fitMethod === "homography";
        for (const c of this._lockControls) {
            if (homography) c.disable(); else c.enable();
        }
    }

    // ---------- enable / disable ----------

    setEnabled(on) {
        // Switching the fit off mid-replay lands it on the solved camera rather than leaving the
        // camera wherever the search happened to have reached.
        if (!on) this.playback.stop();
        this.enabled = on;
        this.visible = on;
        this.markers.setEnabled(on);
        this.sightLines.setEnabled(on);
        this.cancelGesture();

        // See setMatchVideoAspect: while editing a fit the look view must frame the 3D the way
        // the video is framed, or the preview the user is judging by is not comparable.
        if (on) {
            const was = this.setMatchVideoAspect(true);
            if (was === false) this._restoreMatchVideoAspect = false;
        } else if (this._restoreMatchVideoAspect !== undefined) {
            this.setMatchVideoAspect(this._restoreMatchVideoAspect);
            this._restoreMatchVideoAspect = undefined;
        }

        // Only listened for while the feature is on, so a disabled fit really does cost nothing.
        if (on && !this._cancelListener) {
            this._cancelListener = () => this.cancelGesture();
            document.addEventListener("pointercancel", this._cancelListener);
            window.addEventListener("blur", this._cancelListener);
            // The press on empty video returns false from onMouseDown so the video keeps its
            // pan, and mouseMoveView delivers onMouseDrag and onMouseUp only to the view that
            // CLAIMED the press. So both halves of the gesture have to be watched directly here,
            // or a click could never add a point at all.
            //
            // CAPTURE phase for the release: finishPendingAdd asks the video view whether an
            // overlay is mid-edit, and one of those answers — _isOverlayDragging — reads the
            // tracking overlay's `dragging` flags, which its own onMouseUp clears. That runs
            // from onDocumentMouseUp, a bubble-phase pointerup registered at startup and so
            // ahead of this one. In the bubble phase the flags would already be cleared and a
            // real keyframe drag would read as an ordinary click; capture runs first.
            this._moveListener = (e) => this.trackPendingAdd(e);
            this._upListener = (e) => this.finishPendingAdd(e);
            document.addEventListener("pointermove", this._moveListener);
            document.addEventListener("pointerup", this._upListener, true);
        } else if (!on && this._cancelListener) {
            document.removeEventListener("pointercancel", this._cancelListener);
            window.removeEventListener("blur", this._cancelListener);
            document.removeEventListener("pointermove", this._moveListener);
            document.removeEventListener("pointerup", this._upListener, true);
            this._cancelListener = null;
            this._moveListener = null;
            this._upListener = null;
        }

        if (on) {
            // Adopt the current frame the first time points are placed; after that the points
            // own it.
            if (this.points.length === 0) this.fitFrame = Math.round(par.frame);
            setRenderOne(true);
            // Say when we changed a setting out from under the user, rather than leaving them to
            // notice a checkbox ticking itself.
            const forced = this._restoreMatchVideoAspect === false
                ? " · Match Video Aspect on, so the look view frames the 3D like the video" : "";
            this.updateStatus(
                (this.points.length ? "Ready" : "Click the video to add a point") + forced);
        } else {
            this.updateStatus("Off");
        }
        setRenderOne(true);
    }

    // ---------- undo / redo ----------
    //
    // Every edit here is really TWO changes: the control points, and the camera the fit derives
    // from them. Undoing only the points would leave a camera describing landmarks that are no
    // longer where it was solved for — a state the user never created and cannot see is wrong.
    // So a snapshot carries both, and restoring writes both.
    //
    // The camera is restored DIRECTLY rather than by re-solving. Re-solving looks tidier but is
    // not an inverse: the solver can land in a different minimum, and the acceptance gate can
    // refuse to apply anything at all, either of which makes undo fail to undo.

    captureCameraState() {
        const fixed = NodeMan.get("fixedCameraPosition", false);
        const ptz = NodeMan.get("ptzAngles", false);
        if (!fixed || !ptz) return null;
        return {
            // The raw stored triple plus the flag that says what its altitude MEANS, so the
            // AGL/MSL switch a fit performs is itself undoable.
            lla: fixed._LLA.slice(),
            agl: fixed.agl,
            az: ptz.az, el: ptz.el, roll: ptz.roll, fov: ptz.fov,
            satellite: ptz.satellite,
            choices: {
                cameraTrackSwitch: NodeMan.get("cameraTrackSwitch", false)?.choice,
                fovSwitch: NodeMan.get("fovSwitch", false)?.choice,
                CameraLOSController: NodeMan.get("CameraLOSController", false)?.choice,
            },
        };
    }

    restoreCameraState(c) {
        if (!c) return;
        const fixed = NodeMan.get("fixedCameraPosition", false);
        const ptz = NodeMan.get("ptzAngles", false);
        if (!fixed || !ptz) return;
        this.applyingFit = true;
        try {
            // Position VALUE before the position CHOICE: setLLA fires PositionLLA.onChange,
            // and a setup-time listener yanks cameraTrackSwitch to "fixedCamera" whenever the
            // fixed position changes while an unrecognised source (like "Fit Points") is
            // selected. Writing the value first and selecting the choice after lets the
            // captured choice win.
            fixed.agl = c.agl;
            fixed.setLLA(c.lla[0], c.lla[1], c.lla[2]);
            // The heading CHOICE still goes before the ANGLES, as applyResult does: selecting
            // "Manual" fires a listener that syncs ptzAngles from the live camera, so angles
            // written before the selection are discarded.
            for (const [id, choice] of Object.entries(c.choices ?? {})) {
                const sw = NodeMan.get(id, false);
                if (sw && choice !== undefined && sw.choice !== choice
                    && sw.inputs?.[choice] !== undefined) {
                    sw.selectOption(choice);
                }
            }
            ptz.relative = false;
            if (c.satellite !== undefined && ptz.satellite !== c.satellite) {
                ptz.satellite = c.satellite;
                ptz.updateSatelliteSliderRanges?.();
                ptz.updateSatelliteSliderVisibility?.();
            }
            ptz.az = c.az;
            ptz.el = c.el;
            if (ptz.roll !== undefined) ptz.roll = c.roll;
            ptz.fov = c.fov;
            ptz.refresh();
        } finally {
            this.applyingFit = false;
        }
    }

    captureState() {
        this.syncActiveKeyframe();
        return {
            points: this.points.map((p) => ({...p})),
            nextId: this.nextId,
            fitFrame: this.fitFrame,
            keyframes: this.keyframes.map((k) => ({
                frame: k.frame,
                uv: k.uv.map((u) => u.slice()),
                solved: k.solved ? {...k.solved, position: k.solved.position.slice()} : null,
            })),
            camera: this.captureCameraState(),
        };
    }

    restoreState(s) {
        this.points = s.points.map((p) => ({...p}));
        this.nextId = s.nextId;
        this.fitFrame = s.fitFrame;
        this.keyframes = (s.keyframes ?? []).map((k) => ({
            frame: k.frame,
            uv: k.uv.map((u) => u.slice()),
            solved: k.solved ? {...k.solved, position: k.solved.position.slice()} : null,
        }));
        this.lastResult = null;
        this.observability = "-";
        // The dropdown options must exist (or be gone) BEFORE the captured switch choices are
        // restored — a choice naming a missing option is ignored.
        this.syncMotionOptions();
        this.restoreCameraState(s.camera);

        // Re-measure the restored camera against the restored points. Read-only — it scores what
        // is there, it does not solve — so undo stays an exact inverse. Without it the residual
        // would blank out after an undo, which reads as "unknown" when it is in fact known and
        // unchanged.
        this.residual = this.measureCurrentResidual();
        this.updateKeyframeInfo();
        this.updateStatus(this.points.length ? "Restored" : "Click the video to add a point");
        setRenderOne(true);
    }

    /** Score the camera as it stands against the current points, without solving anything. */
    measureCurrentResidual() {
        const size = this.videoSize;
        const state = this.currentCameraState();
        if (!size || !state || this.points.length === 0) return "-";
        const r = evaluateCamera({
            points: this.points.map((p) => {
                const w = this.pointECEF(p);
                return {px: [p.vx, p.vy], world: [w.x, w.y, w.z]};
            }),
            imageSize: size,
            state,
            localFrame: (pos) => this.localFrameAt(pos),
        });
        return Number.isFinite(r.rms) ? `${r.rms.toFixed(2)} px` : "-";
    }

    /** Open an undoable edit. Paired with endUndo; used for edits that span a whole drag. */
    beginUndo() {
        // One at a time. A second begin without an end means a gesture was abandoned, and the
        // newer edit is the one the user is actually performing.
        this._undoBefore = this.captureState();
    }

    endUndo(description) {
        const before = this._undoBefore;
        this._undoBefore = null;
        if (!before) return;
        const after = this.captureState();
        if (JSON.stringify(before) === JSON.stringify(after)) return;   // nothing actually changed
        UndoManager?.add({
            undo: () => this.restoreState(before),
            redo: () => this.restoreState(after),
            description,
        });
    }

    /** Wrap a self-contained edit (add, delete, clear) in a single undo entry. */
    withUndo(description, fn) {
        this.beginUndo();
        fn();
        this.endUndo(description);
    }

    // ---------- Match Video Aspect ----------

    /**
     * Force the look view to frame the 3D scene exactly as the video is framed, for as long as
     * the fit is being edited.
     *
     * The fit itself does not care — it is solved entirely in video-pixel space, and toggling
     * this leaves the residual and the solved camera byte-identical. What it changes is whether
     * the PREVIEW means anything. With it off the look view renders at its own aspect while the
     * video has another, so the 3D and the footage are framed differently and a control point can
     * sit exactly on its landmark while appearing not to. Since the entire way a user judges this
     * tool is "does the sphere sit on the feature in the look view", a preview that lies is worse
     * than no preview.
     *
     * The previous value is returned so switching the fit off puts it back.
     */
    setMatchVideoAspect(on) {
        const frustum = this.frustumNode();
        if (!frustum) return undefined;
        const was = frustum.matchVideoAspect;
        if (was === on) return was;
        // Through the GUI controller where there is one, so the checkbox follows the change
        // rather than silently disagreeing with the state.
        const controller = findGuiController(frustum, "matchVideoAspect");
        if (controller) controller.setValue(on);
        else frustum.matchVideoAspect = on;
        return was;
    }

    // ---------- geometry helpers ----------

    /**
     * Local up/north at an ECEF position, matching CNodeControllerAzElZoom.apply() exactly.
     *
     * "Exactly" is load-bearing: the solver reconstructs the camera basis from az/el/roll using
     * this frame, and the PTZ controller then rebuilds it the same way from the same numbers. Any
     * disagreement between the two frames would show up as a residual the user could not remove.
     */
    localFrameAt(posArray) {
        const pos = new Vector3(posArray[0], posArray[1], posArray[2]);
        const up = getLocalUpVector(pos);
        const toNorth = getNorthPole().clone().sub(pos).normalize();
        const north = toNorth.clone().sub(up.clone().multiplyScalar(toNorth.dot(up))).normalize();
        return {up: [up.x, up.y, up.z], north: [north.x, north.y, north.z]};
    }

    pointECEF(p) {
        return LLAToECEF(p.lat, p.lon, p.alt);
    }

    get videoSize() {
        const ov = this.overlayView;
        const w = ov?.originalVideoWidth ?? 0;
        const h = ov?.originalVideoHeight ?? 0;
        return w > 0 && h > 0 ? [w, h] : null;
    }

    lookCameraNode() {
        return NodeMan.get("lookCamera", false);
    }

    /** The frustum display node for the look camera, which owns the video quad and its toggles. */
    frustumNode() {
        const camNode = this.lookCameraNode();
        return camNode ? NodeMan.get(camNode.id + "_Frustum", false) : null;
    }

    /**
     * The camera as it currently stands, read from the rendered camera rather than from the
     * controller nodes.
     *
     * Reading the camera means the fit always starts from what the user can see, whichever
     * controller happens to be driving it — and it means the az/el/roll it reports are the true
     * ones even if ptzAngles is stale because some other heading source is selected.
     */
    currentCameraState(atFrame = this.fitFrame) {
        const node = this.lookCameraNode();
        if (!node) return null;
        const cam = node.camera;
        cam.updateMatrixWorld();
        const e = cam.matrixWorld.elements;
        const right = new Vector3(e[0], e[1], e[2]).normalize();
        const camUp = new Vector3(e[4], e[5], e[6]).normalize();
        const camBack = new Vector3(e[8], e[9], e[10]).normalize();

        const position = [cam.position.x, cam.position.y, cam.position.z];
        const frame = this.localFrameAt(position);
        const {azDeg, elDeg, rollDeg} = azElRollFromBasis(frame.up, frame.north, {
            right: [right.x, right.y, right.z],
            down: [-camUp.x, -camUp.y, -camUp.z],
            fwd: [-camBack.x, -camBack.y, -camBack.z],
        });

        // The authoritative FOV is the switch, not camera.fov: the render path rewrites camera.fov
        // for letterboxing and video zoom, so reading it back would fold display state into the
        // fit.
        const fovSwitch = NodeMan.get("fovSwitch", false);
        let vfovDeg = cam.fov;
        if (fovSwitch) {
            const v = extractFOV(fovSwitch.getValueFrame(atFrame));
            if (Number.isFinite(v) && v > 0) vfovDeg = v;
        }

        return {position, azDeg, elDeg, rollDeg, vfovDeg};
    }

    /**
     * Unit world ray for an original-video pixel, under the current camera.
     *
     * Same intrinsics the solver uses — principal point at the frame centre and
     * fpx = height / (2 tan(vfov/2)) — and the same basis construction, so the ray a point is
     * seeded along is exactly the ray the fit will later measure it against.
     */
    rayForVideoPixel(state, vx, vy, size) {
        const frame = this.localFrameAt(state.position);
        const b = basisFromAzElRoll(frame.up, frame.north, state.azDeg, state.elDeg, state.rollDeg);
        const fpx = size[1] / (2 * Math.tan((state.vfovDeg * Math.PI) / 360));
        const dx = vx - size[0] / 2;
        const dy = vy - size[1] / 2;
        return new Vector3(
            b.fwd[0] * fpx + b.right[0] * dx + b.down[0] * dy,
            b.fwd[1] * fpx + b.right[1] * dx + b.down[1] * dy,
            b.fwd[2] * fpx + b.right[2] * dx + b.down[2] * dy,
        ).normalize();
    }

    // ---------- the convergence display ----------
    //
    // See FitPointSightLines3D for what this display is saying. This end of it just answers three
    // questions for the two halves that draw it: where the camera and the ground points are (the
    // lines, drawn as scene geometry), where each video point falls on the video in the frustum
    // (drawn as a handle by the view overlays), and where the video quad is (so the ground handles
    // can hide behind it).

    /**
     * World matrix of the frustum's video quad, or null unless it is actually showing the video.
     *
     * Gated on the toggle because the markers are meant to sit ON the footage. The quad still
     * exists when the toggle is off — it is just an invisible rectangle in mid-air, and markers
     * floating on a plane the user cannot see would read as points in space at some arbitrary
     * range, which is the opposite of the thing being demonstrated.
     *
     * Composed here rather than read from quad.matrixWorld, because the frustum sets the quad's
     * local transform in its own update() and may not have run yet this frame — so its stored world
     * matrix can describe last frame's camera. Everything else in this display comes from the LIVE
     * camera, and a fit moves the camera in one step; mixing the two would smear the markers off
     * the video for exactly the frame the user is looking at the result. The quad's own local
     * position and scale are still the frustum's, so nothing about its placement is duplicated —
     * only the parent pose, which the frustum defines as the camera's (see its update()).
     */
    videoQuadMatrix() {
        const frustum = this.frustumNode();
        const quad = frustum?.videoQuad;
        if (!quad || !frustum.showVideoInFrustum || !quad.visible) return null;
        const cam = frustum.camera;
        return new Matrix4()
            .compose(cam.position, cam.quaternion, UNIT_SCALE)
            .multiply(new Matrix4().compose(quad.position, quad.quaternion, quad.scale));
    }

    /**
     * The video quad as a thing the ground handles can hide behind, or null when it is not shown.
     *
     * Handed over as the world -> quad-local transform because that is the frame the occlusion test
     * is trivial in: the quad is exactly the square x,y in [-0.5, 0.5] at z = 0, so a line of sight
     * is blocked by it or not with one segment-plane intersection and two comparisons.
     */
    videoQuadOccluder() {
        const m = this.videoQuadMatrix();
        return m === null ? null : {worldToQuad: m.invert()};
    }

    /**
     * Everything the display needs, or null if there is nothing to draw. `image` is null per point
     * when the video is not being shown in the frustum.
     */
    rayDisplay() {
        if (!this.showRays || !this.enabled || this.points.length === 0) return null;
        const node = this.lookCameraNode();
        if (!node) return null;
        node.camera.updateMatrixWorld();

        const quad = this.videoQuadMatrix();
        const size = this.videoSize;
        return {
            origin: node.camera.position.clone(),
            points: this.points.map((p, i) => ({
                index: i,
                color: p.color,
                ground: this.pointECEF(p),
                image: quad && size ? videoPointOnQuad(quad, p, size) : null,
            })),
        };
    }

    // ---------- fit keyframes ----------
    //
    // One set of landmarks, observed at several frames. `points` mirrors the ACTIVE keyframe's
    // 2D coordinates so the whole editing surface — handles, solver, renderer, undo — keeps
    // working on `points` untouched; the keyframe entries are the durable store the mirror is
    // synced to and loaded from.

    pointsUV() {
        return this.points.map((p) => [p.vx, p.vy]);
    }

    activeKeyframe() {
        return this.keyframes.find((k) => k.frame === this.fitFrame);
    }

    /** The first point placed creates the first keyframe; the two exist together. */
    ensureBaseKeyframe() {
        if (this.points.length > 0 && this.keyframes.length === 0) {
            this.keyframes.push({frame: this.fitFrame, uv: this.pointsUV(), solved: null});
            this.updateKeyframeInfo();
        }
    }

    /** Write the mirror's current 2D coordinates back into the active keyframe. */
    syncActiveKeyframe() {
        const kf = this.activeKeyframe();
        if (kf) kf.uv = this.pointsUV();
    }

    /** Make the keyframe at `frame` the one being edited: save the mirror out, load its uv in. */
    activateKeyframe(frame) {
        const kf = this.keyframes.find((k) => k.frame === frame);
        if (!kf) return;
        this.syncActiveKeyframe();
        this.fitFrame = frame;
        const n = Math.min(this.points.length, kf.uv.length);
        for (let i = 0; i < n; i++) {
            this.points[i].vx = kf.uv[i][0];
            this.points[i].vy = kf.uv[i][1];
        }
        // Residuals are per-keyframe: the last solve's arrows describe the OLD keyframe's
        // pixels and would be drawn against the new ones — the most misleading thing this
        // display could do.
        this.lastResult = null;
        this.observability = "-";
        this.residual = this.measureCurrentResidual();
        this.updateKeyframeInfo();
        setRenderOne(true);
    }

    updateKeyframeInfo() {
        if (this.keyframes.length === 0) {
            this.keyframeInfo = "none";
            return;
        }
        const frames = this.keyframes
            .map((k) => `${k.frame}${k.solved?.fitted === false || !k.solved ? "?" : ""}`)
            .join(", ");
        this.keyframeInfo = `${this.keyframes.length} @ ${frames} — editing ${this.fitFrame}`;
    }

    /** The interpolated camera for any frame — what the three motion nodes serve. */
    interpolatedState(f) {
        return interpolateFitCamera(this.keyframes, f);
    }

    /** Which camera aspects the "Fit Points" motion sources currently own. */
    motionOwnsAspects() {
        const pos = NodeMan.get("cameraTrackSwitch", false)?.choice === FIT_POINTS_TRACK_OPTION;
        const head = NodeMan.get("CameraLOSController", false)?.choice === FIT_POINTS_HEADING_OPTION;
        const fov = NodeMan.get("fovSwitch", false)?.choice === FIT_POINTS_FOV_OPTION;
        return {pos, head, fov, any: pos || head || fov};
    }

    /** Cascade the motion source nodes after keyframe solutions change. */
    refreshMotionNodes() {
        NodeMan.get("fitPointsPositionTrack", false)?.recalculateCascade();
        NodeMan.get("fitPointsFOV", false)?.recalculateCascade();
        setRenderOne(true);
    }

    /**
     * Offer or withdraw the "Fit Points" dropdown options to match the keyframe count.
     *
     * Withdrawing while a switch is still ON a fit option first writes the camera the user is
     * looking at into the manual nodes, so the fallback selection lands exactly where the
     * camera already is instead of jumping to whatever the manual nodes last held.
     */
    syncMotionOptions() {
        if (this.keyframes.length >= 2) {
            attachFitPointsMotion(this);
        } else {
            if (this.motionOwnsAspects().any) this.landMotionCamera();
            detachFitPointsMotion();
        }
        this.updateKeyframeInfo();
    }

    /** Write the live camera into the manual position/heading/FOV nodes. See syncMotionOptions. */
    landMotionCamera() {
        const state = this.currentCameraState(Math.round(par.frame));
        if (!state) return;
        this.applyingFit = true;
        try {
            this.writePosition(state.position);
            const ptz = NodeMan.get("ptzAngles", false);
            if (ptz) {
                ptz.relative = false;
                ptz.az = state.azDeg;
                ptz.el = state.elDeg;
                if (ptz.roll !== undefined) ptz.roll = state.rollDeg;
                ptz.fov = state.vfovDeg;
                ptz.refresh();
            }
        } finally {
            this.applyingFit = false;
        }
    }

    /** {position, azDeg, elDeg, rollDeg, vfovDeg} from a stored keyframe solution. */
    stateFromSolved(s) {
        return {
            position: s.position.slice(),
            azDeg: s.azDeg, elDeg: s.elDeg, rollDeg: s.rollDeg, vfovDeg: s.vfovDeg,
        };
    }

    /** A keyframe solution from a solver result. `fitted` marks it as a real solve. */
    solvedFromResult(result) {
        return {
            position: result.position.slice(),
            azDeg: result.azDeg, elDeg: result.elDeg,
            rollDeg: result.rollDeg, vfovDeg: result.vfovDeg,
            fitted: true,
        };
    }

    /** Where a landmark projects in a given camera, in original video pixels, or null. */
    projectThroughState(state, worldVec, size) {
        const frame = this.localFrameAt(state.position);
        const basis = basisFromAzElRoll(
            frame.up, frame.north, state.azDeg, state.elDeg, state.rollDeg);
        const px = projectWorldPoint(
            {position: state.position, focalScale: 1, basis},
            [worldVec.x, worldVec.y, worldVec.z],
            lensFromVFOV(state.vfovDeg, size), size);
        return px && Number.isFinite(px[0]) && Number.isFinite(px[1]) ? px : null;
    }

    /**
     * Solve one keyframe from its own observations, headlessly: same solver, same method
     * choice, same locks and the same is-it-an-improvement gate as the interactive fit, but no
     * camera-node writes and no status churn. Used for keyframes OTHER than the one being
     * edited, whose solutions go stale when a shared landmark moves.
     *
     * On failure the old solution is kept but demoted to unfitted — it still describes A
     * camera, but no longer provably the camera for these landmarks, and the keyframe readout
     * says so.
     *
     * @returns {boolean} whether the keyframe now carries a freshly fitted solution
     */
    solveKeyframe(kf) {
        const size = this.videoSize;
        if (!size || this.points.length === 0) return false;
        const demote = () => {
            if (kf.solved) kf.solved.fitted = false;
        };

        const uv = kf.frame === this.fitFrame ? this.pointsUV() : kf.uv;
        const solverPoints = this.points.map((p, i) => {
            const w = this.pointECEF(p);
            return {px: [uv[i][0], uv[i][1]], world: [w.x, w.y, w.z]};
        });
        const initial = kf.solved
            ? this.stateFromSolved(kf.solved)
            : this.currentCameraState(kf.frame);
        if (!initial || Math.abs(initial.elDeg) > MAX_ABS_EL) {
            demote();
            return false;
        }
        const localFrame = (pos) => this.localFrameAt(pos);
        const spec = {
            points: solverPoints,
            imageSize: size,
            initial,
            free: {
                position: !this.lockPosition,
                az: true,
                el: true,
                roll: !this.lockRoll,
                fov: !this.lockFOV,
            },
            localFrame,
            // A refit starts from a previous solution, so the full multi-seed search is wasted
            // work — and this can run for several keyframes in one edit.
            options: kf.solved ? {seedsToRefine: 1, prefilterIterations: 8} : undefined,
        };
        const result = this.fitMethod === "homography"
            ? fitCameraByPlaneHomography(spec)
            : fitCameraToPoints(spec);
        if (!result.ok) {
            demote();
            return false;
        }
        if (kf.solved) {
            // The same guard runFit applies: a solve far worse than the solution it would
            // replace is a bad basin, not an answer.
            const current = evaluateCamera({
                points: solverPoints, imageSize: size,
                state: this.stateFromSolved(kf.solved), localFrame,
            });
            const ruinous = this.fitMethod === "homography"
                ? current.rms * 4 + 20
                : current.rms + 0.01;
            if (Number.isFinite(current.rms) && current.behind === 0 && result.rms > ruinous) {
                demote();
                return false;
            }
        }
        kf.solved = this.solvedFromResult(result);
        return true;
    }

    /** Re-solve every keyframe except the active one (whose solve runs interactively). */
    refitOtherKeyframes() {
        if (this.keyframes.length < 2) return;
        let failed = 0;
        for (const kf of this.keyframes) {
            if (kf.frame === this.fitFrame) continue;
            if (!this.solveKeyframe(kf)) failed++;
        }
        this.refreshMotionNodes();
        this.updateKeyframeInfo();
        if (failed > 0) {
            this.updateStatus(`${this.status} · ${failed} other keyframe` +
                `${failed === 1 ? "" : "s"} failed to refit`);
        }
    }

    /** The "Add Fit Keyframe" button. */
    addFitKeyframe() {
        if (!this.enabled) {
            this.updateStatus("Enable Fit before adding keyframes");
            setRenderOne(true);
            return;
        }
        const size = this.videoSize;
        if (!size || this.points.length === 0) {
            this.updateStatus("Click the video to place fit points first");
            setRenderOne(true);
            return;
        }
        const frame = Math.round(par.frame);
        if (this.keyframes.some((k) => k.frame === frame)) {
            this.updateStatus(`Frame ${frame} is already a fit keyframe`);
            setRenderOne(true);
            return;
        }
        this.ensureBaseKeyframe();

        // The existing keyframe must carry a real solution before motion between keyframes can
        // mean anything. A loaded sitch restores points but never re-solves (the camera may
        // have been hand-adjusted since), so solve from the correspondences now — and refuse
        // the add if that fails, rather than record a keyframe pair that cannot be
        // interpolated.
        const active = this.activeKeyframe();
        if (active && (!active.solved || active.solved.fitted === false)) {
            if (!this.solveKeyframe(active)) {
                this.updateStatus(`Could not solve the keyframe at frame ${active.frame} — ` +
                    `go to it and Fit Now first`);
                setRenderOne(true);
                return;
            }
        }

        // Seed the new keyframe's markers where each landmark projects through the camera the
        // user is looking at RIGHT NOW on this frame — visually, the crosshairs open exactly
        // on where the landmarks would be if the camera had not moved, and dragging them to
        // where the landmarks really are is what states the motion.
        const state = this.currentCameraState(frame);
        const uv = this.points.map((p) => {
            const px = state ? this.projectThroughState(state, this.pointECEF(p), size) : null;
            return px ?? [p.vx, p.vy];
        });

        this.withUndo("Add fit keyframe", () => {
            this.syncActiveKeyframe();
            this.keyframes.push({
                frame,
                uv,
                // Provisional: where the camera IS at this frame, recorded so interpolation is
                // defined immediately — but marked unfitted until a solve replaces it, because
                // a seeded camera is a guess, not a fit.
                solved: state ? {...state, position: state.position.slice(), fitted: false} : null,
            });
            this.keyframes.sort((a, b) => a.frame - b.frame);
            this.activateKeyframe(frame);
            this.syncMotionOptions();
        });
        this.updateStatus(`Fit keyframe added at frame ${frame} — drag the video markers to ` +
            `where the landmarks are in this frame`);
        setRenderOne(true);
    }

    /** The "Delete Fit Keyframe" button. */
    deleteFitKeyframe() {
        const frame = Math.round(par.frame);
        const i = this.keyframes.findIndex((k) => k.frame === frame);
        if (i < 0) {
            this.updateStatus(`No fit keyframe at frame ${frame}`);
            setRenderOne(true);
            return;
        }
        if (this.keyframes.length === 1) {
            this.updateStatus("This is the only fit keyframe — Clear All Points removes the " +
                "fit entirely");
            setRenderOne(true);
            return;
        }
        this.withUndo("Delete fit keyframe", () => {
            const wasActive = this.fitFrame === frame;
            this.keyframes.splice(i, 1);
            if (wasActive) {
                let nearest = this.keyframes[0];
                for (const k of this.keyframes) {
                    if (Math.abs(k.frame - frame) < Math.abs(nearest.frame - frame)) nearest = k;
                }
                this.activateKeyframe(nearest.frame);
            }
            this.syncMotionOptions();
        });
        this.updateStatus(`Fit keyframe at frame ${frame} deleted`);
        setRenderOne(true);
    }

    /** The "Fit Keyframe Motion" button: select "Fit Points" for position, heading and FOV. */
    fitKeyframeMotion() {
        if (this.keyframes.length < 2) {
            this.updateStatus("Motion needs at least 2 fit keyframes — use Add Fit Keyframe " +
                "at another frame first");
            setRenderOne(true);
            return;
        }
        // Motion interpolates FITTED solutions only — a freshly added keyframe still carries
        // its seeded guess, and flying the camera through a guess would present motion the
        // landmarks never supported. Refuse until the keyframes have real solves, and say
        // which ones.
        const unfitted = this.keyframes.filter((k) => !k.solved || k.solved.fitted === false);
        if (this.keyframes.length - unfitted.length < 2) {
            const frames = unfitted.map((k) => k.frame).join(", ");
            this.updateStatus(`Fit the keyframe${unfitted.length === 1 ? "" : "s"} at frame` +
                `${unfitted.length === 1 ? "" : "s"} ${frames} first — go there, place the ` +
                `video markers, and Fit Now`);
            setRenderOne(true);
            return;
        }
        this.syncActiveKeyframe();
        if (!attachFitPointsMotion(this, true)) {
            this.updateStatus("This sitch has no camera source switches to drive");
            setRenderOne(true);
            return;
        }
        this.refreshMotionNodes();
        this.updateStatus("Camera position, heading and FOV now follow the fit keyframes");
        setRenderOne(true);
    }

    // ---------- point management ----------

    /** @returns {object|null} the point that was added, so the caller can grab it for a drag. */
    addPointAtVideo(vx, vy) {
        const size = this.videoSize;
        const state = this.currentCameraState();
        if (!size || !state) return null;

        const origin = new Vector3(state.position[0], state.position[1], state.position[2]);
        const dir = this.rayForVideoPixel(state, vx, vy, size);

        // Seed on the surface under the ray. This is only a starting place — the pair carries no
        // information until the sphere is dragged to the real feature — but starting on the
        // surface under the clicked pixel is a far better guess than a fixed range, and for a
        // landmark the user has already identified it is often close to right. Uses the same
        // surface the handles are dragged against, so clicking a rooftop seeds on the roof rather
        // than on the street below it and then jumping when first dragged.
        let world = surfaceAlongRay(origin, dir, this.useTiles, this.lookCameraNode()?.camera);
        if (!world) world = origin.clone().addScaledVector(dir, FALLBACK_RANGE);

        const lla = ECEFToLLAVD_radii(world);
        const point = {
            id: this.nextId++,
            vx, vy,
            lat: lla.x, lon: lla.y, alt: lla.z,
            color: POINT_COLORS[this.points.length % POINT_COLORS.length],
        };
        this.points.push(point);

        // Every keyframe carries an observation of every landmark. The other keyframes get
        // this one seeded where the landmark projects through THEIR stored camera — exactly
        // consistent with their existing solutions, so nothing about them changes until the
        // user refines the marker there. Falling back to this frame's pixel when there is no
        // solution to project through.
        this.ensureBaseKeyframe();
        for (const kf of this.keyframes) {
            if (kf.frame === this.fitFrame) continue;
            const px = kf.solved
                ? this.projectThroughState(this.stateFromSolved(kf.solved), world, size)
                : null;
            kf.uv.push(px ?? [vx, vy]);
        }
        this.syncActiveKeyframe();
        this.updateKeyframeInfo();

        this.updateStatus(`${this.points.length} point${this.points.length === 1 ? "" : "s"} — ` +
            `drag the ground handle to the real location`);
        setRenderOne(true);
        return point;
    }

    removePoint(id) {
        const i = this.points.findIndex((p) => p.id === id);
        if (i < 0) return;
        this.withUndo("Delete camera fit point", () => {
            this.points.splice(i, 1);
            // A landmark is shared by every keyframe; its observation goes with it everywhere.
            for (const kf of this.keyframes) kf.uv.splice(i, 1);
            if (this.points.length === 0) {
                this.keyframes = [];
                this.syncMotionOptions();
            }
            this.requestFit();
            if (this.autoFit) this.refitOtherKeyframes();
            this.updateKeyframeInfo();
        });
        setRenderOne(true);
    }

    clearAllPoints() {
        if (this.points.length === 0) return;
        const count = this.points.length;
        showConfirm(`Delete all ${count} camera fit points?`).then((ok) => {
            if (!ok) return;
            this.withUndo(`Delete all ${count} camera fit points`, () => {
                this.points = [];
                this.keyframes = [];
                this.syncMotionOptions();
                this.lastResult = null;
                this.updateStatus("Click the video to add a point");
            });
            setRenderOne(true);
        });
    }

    onMarkerMoved(id, pos) {
        const p = this.points.find((q) => q.id === id);
        if (!p) return;
        const lla = ECEFToLLAVD_radii(pos);
        p.lat = lla.x; p.lon = lla.y; p.alt = lla.z;
    }

    // ---------- the fit ----------

    fitNow() {
        this.runFit(true);
        // An explicit Fit Now re-solves everything, so the whole keyframe set is consistent
        // with the landmarks as they now stand.
        this.refitOtherKeyframes();
    }

    /** Fit if auto-fit is on. Every interactive path goes through here. */
    requestFit() {
        if (!this.enabled) return;
        if (this.autoFit) this.runFit(false);
    }

    /** @param {boolean} animate replay the search rather than jumping to the answer */
    runFit(explicit, animate = false) {
        if (!this.enabled) return;
        // A replay in progress owns the camera; starting another solve underneath it would have
        // two things writing the same nodes every frame.
        if (this.playback.running && !animate) return;

        // Re-entrancy guard. Applying a fit selects switches and writes nodes, each of which
        // cascades; anything downstream that pokes this node back must not start a second solve
        // inside the first one's write-back.
        if (this.applyingFit) return;

        const size = this.videoSize;
        if (!size) { this.updateStatus("No video loaded"); return; }

        // The fit reads the LIVE camera as its starting state, and the live camera is whatever
        // the controllers produce at par.frame. Solving points from frame N against a camera
        // posed for frame M would be quietly wrong for anything but a locked-off camera, so the
        // two have to agree. Refusing is the honest option: scrubbing the timeline for the user
        // would be a surprising side effect of ticking a checkbox.
        if (this.points.length > 0 && !this.onCorrectFrame()) {
            this.updateStatus(this.wrongFrameMessage("fit"));
            setRenderOne(true);
            return;
        }

        const state = this.currentCameraState();
        if (!state) { this.updateStatus("No look camera"); return; }

        if (Math.abs(state.elDeg) > MAX_ABS_EL) {
            this.updateStatus(`Camera is within ${90 - MAX_ABS_EL} deg of vertical — cannot fit`);
            return;
        }

        const free = {
            position: !this.lockPosition,
            az: true,
            el: true,
            roll: !this.lockRoll,
            fov: !this.lockFOV,
        };

        const solverPoints = this.points.map((p) => {
            const w = this.pointECEF(p);
            return {px: [p.vx, p.vy], world: [w.x, w.y, w.z]};
        });
        const localFrame = (pos) => this.localFrameAt(pos);

        // What the camera the user already has scores against these points. The fit has to beat
        // it to be worth applying — see the rejection below.
        const current = evaluateCamera({
            points: solverPoints, imageSize: size, state, localFrame,
        });

        const solverSpec = {
            points: solverPoints,
            imageSize: size,
            initial: state,
            free,
            localFrame,
            // Only when the user asked to watch. The direct solver takes it through `options`.
            trace: animate,
            options: animate ? {trace: true} : undefined,
        };
        const result = this.fitMethod === "homography"
            ? fitCameraByPlaneHomography(solverSpec)
            : fitCameraToPoints(solverSpec);

        if (!result.ok) {
            this.lastResult = null;
            this.residual = "-";
            this.observability = "-";
            this.updateStatus(result.reason);
            setRenderOne(true);
            return;
        }

        // A solver always returns its best LOCAL minimum, and "best local" can be far worse than
        // where the user already was — measured: a solve that landed 9800 km away with a 169 deg
        // field and a 612 px residual, which would have silently destroyed a good camera. So the
        // fit has to actually be an improvement before it is allowed to touch anything. The
        // margin keeps float noise on an already-perfect fit from reading as a regression.
        //
        // The margin depends on which solver ran, because the two do not optimise the same
        // thing. The direct solver minimises reprojection error, so its answer IS the RMS
        // optimum and anything worse than the current camera means it fell into a bad basin —
        // a hair's margin is right there. The homography solver never minimises RMS at all; it
        // builds the camera from a decomposition, so it normally lands a little worse in RMS
        // than a direct optimum even when it is exactly right. Judging it by the tight margin
        // rejected every homography fit made after a direct one — which is precisely the
        // comparison the second method exists to support — so it gets a threshold that only
        // catches an actual runaway.
        const ruinous = this.fitMethod === "homography"
            ? current.rms * 4 + 20
            : current.rms + 0.01;
        if (Number.isFinite(current.rms) && current.behind === 0 && result.rms > ruinous) {
            this.lastResult = null;
            this.residual = `${current.rms.toFixed(2)} px (unchanged)`;
            this.observability = "-";
            this.updateStatus(`Rejected: fit ${result.rms.toFixed(1)} px is worse than the ` +
                `current ${current.rms.toFixed(1)} px — camera left alone`);
            setRenderOne(true);
            return;
        }

        const land = () => {
            const notes = this.applyResult(result);
            // The solved camera is also this keyframe's stored solution — the thing "Fit
            // Keyframe Motion" interpolates between.
            this.ensureBaseKeyframe();
            const kf = this.activeKeyframe();
            if (kf) {
                kf.solved = this.solvedFromResult(result);
                this.syncActiveKeyframe();
                this.refreshMotionNodes();
                this.updateKeyframeInfo();
            }
            // Residuals are keyed by point id, not by array index. Add or delete a point after a
            // fit and the indices shift, which would silently draw each residual against the wrong
            // landmark — the most misleading thing this display could do.
            result.pointIds = this.points.map((p) => p.id);
            this.lastResult = result;
            this.residual = `${result.rms.toFixed(2)} px`;
            // The homography solver reports its own observability, because what limits it is the
            // control points' spread in RANGE rather than the parameter conditioning the direct
            // solver measures.
            this.observability = result.observability ?? describeObservability(result);
            // Notes come LAST. They are the reasons the applied camera might not be the solved one,
            // and an earlier version of this composed them the other way round — so every warning
            // was overwritten by the word "Fitted" and none of them ever reached the user.
            this.updateStatus([explicit ? "Fitted" : "Fitted (auto)", ...notes].join(" · "));
            setRenderOne(true);
        };

        // Watching it: walk the trace first and apply the real result on arrival, so a replay ends
        // in exactly the state an ordinary fit would have reached. The apply is deferred rather
        // than done up front and re-shown, because applyResult selects switches — and selecting a
        // heading source re-syncs ptzAngles from the live camera, which would fight the playback
        // on every frame.
        if (animate && Array.isArray(result.trace) && result.trace.length > 1) {
            const label = this.fitMethod === "homography" ? "Sweeping FOV" : "Descending";
            this.playback.start(result.trace, label, land);
            return;
        }
        land();
    }

    /**
     * Solve again, but replay the search instead of jumping to the answer.
     *
     * Re-solves rather than replaying the last fit, so what is shown is always the search that
     * produced the camera you end up with — a stored trace could be from before the points moved.
     */
    showAlgorithmWorking() {
        if (this.playback.running) { this.playback.stop(); return; }
        // The replay drives the ordinary camera nodes; while Fit Points motion owns any of
        // them the camera would not follow the search, so there would be nothing to watch.
        // Solve without the replay instead.
        if (this.motionOwnsAspects().any) { this.runFit(true, false); return; }
        this.runFit(true, true);
    }

    /** Advance a running replay by one step. Called once per frame from update(). */
    stepPlayback() {
        if (!this.playback.running) return;
        const state = this.playback.step();
        if (!state) return;
        // Guarded so the cascade this write kicks off cannot re-enter runFit and start a second
        // solve inside the replay of the first.
        this.applyingFit = true;
        try {
            showTracedCamera(state, (p) => {
                const lla = ECEFToLLAVD_radii(new Vector3(p[0], p[1], p[2]));
                // MSL, matching writePosition — the altitude field means orthometric height, and
                // recalculate() adds the geoid separation back on the way to ECEF.
                return [lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y)];
            });
        } finally {
            this.applyingFit = false;
        }
        // The last step both shows itself AND lands the fit, and land() has already written the
        // real status by the time step() returns. Writing progress over it here left "Descending"
        // on screen after the fit had finished.
        if (!this.playback.running) return;
        const detail = Number.isFinite(state.rms) ? ` · ${state.rms.toFixed(1)} px`
            : Number.isFinite(state.score) ? ` · score ${state.score.toExponential(2)}` : "";
        this.updateStatus(`${this.playback.label} ${this.playback.progress}${detail}`);
    }

    /**
     * Write a solved camera into the ordinary camera nodes.
     *
     * The ORDER here is load-bearing, and every step of it is a hazard that bit somebody:
     *
     *   Switches first. Selecting "Manual" on the heading switch fires a listener that
     *   immediately syncs ptzAngles FROM the current camera (CustomManagerSetup) — so orientation
     *   written before the switch is selected is discarded a moment later.
     *
     *   relative = false. In relative mode az/el are applied on top of whatever pose the camera
     *   already has, so a fitted absolute orientation would land as a delta on itself.
     *
     *   MSL, not HAE, and not AGL. CNodePositionLLA's altitude means one of three different
     *   things depending on its `agl` flag: above ground, or orthometric with the geoid
     *   separation added on the way to ECEF. The solver works in ECEF and ECEFToLLAVD_radii
     *   returns ellipsoid height, so both conversions have to be undone — see writePosition.
     *
     *   FOV through ptz.refresh(). PTZ re-reads the FOV from fovSwitch on every apply, so the
     *   value has to reach fovUI — which is exactly what refresh() does.
     *
     * @returns {string[]} notes about anything that makes the APPLIED camera differ from the
     *          solved one. The caller appends these to the status; they must not be swallowed.
     */
    applyResult(result) {
        const notes = [];
        // Aspects currently owned by the "Fit Points" motion sources are NOT written here and
        // their switches are NOT yanked back to the manual options: for those, the stored
        // keyframe solution (see land()) IS the write-back — the motion nodes read it
        // directly, and at a keyframe's own frame the interpolated camera is that solution.
        const owns = this.motionOwnsAspects();
        this.applyingFit = true;
        try {
            const camTrack = NodeMan.get("cameraTrackSwitch", false);
            if (!owns.pos && camTrack && !this.lockPosition && camTrack.choice !== "fixedCamera"
                && camTrack.inputs.fixedCamera !== undefined) {
                camTrack.selectOption("fixedCamera");
            }
            const fovSwitch = NodeMan.get("fovSwitch", false);
            if (!owns.fov && fovSwitch && !this.lockFOV && fovSwitch.choice !== "userFOV"
                && fovSwitch.inputs.userFOV !== undefined) {
                fovSwitch.selectOption("userFOV");
            }
            const heading = NodeMan.get("CameraLOSController", false);
            if (!owns.head && heading && heading.choice !== "Manual"
                && heading.inputs.Manual !== undefined) {
                heading.selectOption("Manual");
            }

            const ptz = NodeMan.get("ptzAngles", false);
            if (!ptz) {
                notes.push("no Manual PTZ controller to write orientation to");
                return notes;
            }

            if (!owns.head) {
                ptz.relative = false;
                // A fit is an absolute az/el pose. In satellite mode the PTZ controller
                // rebuilds the camera from its own quaternion and would ignore the solved
                // angles entirely.
                if (ptz.satellite) {
                    ptz.satellite = false;
                    ptz.updateSatelliteSliderRanges?.();
                    ptz.updateSatelliteSliderVisibility?.();
                    notes.push("satellite mode switched off so the fitted pointing applies");
                }
                ptz.az = result.azDeg;
                ptz.el = result.elDeg;
                if (!this.lockRoll && ptz.roll !== undefined) ptz.roll = result.rollDeg;
            }
            if (!owns.pos && !this.lockPosition) notes.push(...this.writePosition(result.position));
            if (!owns.fov && !this.lockFOV) ptz.fov = result.vfovDeg;

            // refresh() copies ptz.fov into fovUI — the MANUAL FOV store. While Fit Points
            // owns the FOV that write would clobber the user's manual value with a fit value,
            // so cascade without it instead.
            if (!owns.fov) ptz.refresh();
            else ptz.recalculateCascade();
        } finally {
            this.applyingFit = false;
        }

        // The positional cross-check reads the camera as rendered NOW; under Fit Points motion
        // the position lands via the track on the next frame, so the check would only ever
        // report a stale camera.
        if (!owns.pos) notes.push(...this.checkAppliedCamera(result));
        return notes;
    }

    /**
     * Write a solved ECEF position into fixedCameraPosition, whatever datum it is currently using.
     *
     * The altitude field means one of two different things:
     *   agl === false : orthometric (MSL). recalculate() adds meanSeaLevelOffset on the way to
     *                   ECEF, so the geoid separation has to come off first.
     *   agl === true  : metres above the rendered ground.
     *
     * The AGL case is not merely a different conversion, it is a different KIND of answer. A fit
     * produces an absolute position; storing it as a terrain-relative offset means the camera
     * silently moves later, when finer tiles stream in and the ground beneath it changes. A
     * calibration that drifts with the elevation data is not a calibration, so AGL is switched off
     * and the answer stored absolutely — visibly, via the note, not quietly.
     */
    writePosition(positionECEF) {
        const notes = [];
        const fixed = NodeMan.get("fixedCameraPosition", false);
        if (!fixed) {
            notes.push("no fixedCameraPosition node to write position to");
            return notes;
        }
        if (fixed.agl) {
            fixed.agl = false;
            notes.push("camera altitude switched from AGL to MSL so the fit stays absolute");
        }
        const lla = ECEFToLLAVD_radii(new Vector3(...positionECEF));
        fixed.setLLA(lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y));
        return notes;
    }

    /**
     * Did the camera actually end up where the fit put it?
     *
     * It may not have. TrackPosition clamps the camera above the visible ground unless the node
     * opts out, so a fit that lands underground renders somewhere else than it solved for — and
     * the residual shown would then describe a camera that does not exist. Checking the applied
     * camera rather than trusting the write is the only way to notice.
     */
    checkAppliedCamera(result) {
        const node = this.lookCameraNode();
        if (!node) return [];
        node.camera.updateMatrixWorld();
        const applied = node.camera.position;
        const off = Math.hypot(
            applied.x - result.position[0],
            applied.y - result.position[1],
            applied.z - result.position[2],
        );
        if (off <= 1) return [];
        return [`camera ended up ${off.toFixed(0)} m from the solution (ground clamp?) — the ` +
            `residual is for the solution, not the rendered camera`];
    }

    updateStatus(text) {
        this.status = text;
    }

    // ---------- 2D interaction ----------

    hasVideoGeometry() {
        const ov = this.overlayView;
        return ov !== undefined && ov.videoWidth > 0 && ov.videoHeight > 0
            && ov.originalVideoWidth > 0 && ov.originalVideoHeight > 0;
    }

    canvasPosOf(p) {
        return this.overlayView.videoToCanvasCoordsOriginal(p.vx, p.vy);
    }

    pointNear(cx, cy) {
        for (let i = this.points.length - 1; i >= 0; i--) {
            const [px, py] = this.canvasPosOf(this.points[i]);
            if (Math.hypot(cx - px, cy - py) <= GRAB_RADIUS) return this.points[i];
        }
        return null;
    }

    /** Only this frame's points may be edited — see the note on fitFrame in the constructor.
     * With keyframes, scrubbing onto any keyframe frame activates it (see update), so in
     * practice this answers "is the playhead on a fit keyframe". */
    onCorrectFrame() {
        return Math.round(par.frame) === this.fitFrame;
    }

    /** Where the points may be edited/fitted, phrased for however many keyframes exist. */
    wrongFrameMessage(verb) {
        if (this.keyframes.length > 1) {
            const frames = this.keyframes.map((k) => k.frame).join(", ");
            return `Points belong to the fit keyframes (frames ${frames}) — go to one to ${verb}`;
        }
        return `Points belong to frame ${this.fitFrame} — go to it to ${verb}`;
    }

    /**
     * Abandon any half-finished gesture.
     *
     * A press that never reaches mouseup leaves state behind: a pending add would be committed by
     * the next unrelated mouseup, at coordinates from a gesture the user abandoned, silently
     * writing a control point into the saved sitch. Interrupted presses are ordinary — touch
     * cancellation, an OS gesture, the window losing focus — so the state has to be clearable
     * from outside the mouse sequence as well as reset at the start of the next one.
     */
    cancelGesture() {
        this.pendingAdd = null;
        this.draggingId = null;
        // Drop any open undo span too: an abandoned gesture changed nothing the user wants back.
        this._undoBefore = null;
    }

    onMouseDown(e, mouseX, mouseY) {
        // A new press supersedes whatever the last one left behind, however it ended.
        this.cancelGesture();
        if (!this.enabled || !this.hasVideoGeometry()) return false;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const hit = this.pointNear(cx, cy);

        if (e.button === 2) {
            if (hit) {
                // Claim the click so the video view does not also open its "Video Adjustments"
                // menu on top of the deletion. A right-click on empty video is NOT claimed, so
                // that menu still works normally while fitting.
                claimRightClick();
                this.removePoint(hit.id);
                return true;
            }
            return false;
        }
        if (e.button !== 0) return false;

        if (!this.onCorrectFrame()) {
            this.updateStatus(this.wrongFrameMessage("edit"));
            setRenderOne(true);
            return false;
        }

        if (hit) {
            this.draggingId = hit.id;
            this.beginUndo();
            return true;
        }

        // Empty video. This press is either a CLICK, which adds a point, or the start of a PAN,
        // and there is no way to tell which until the pointer either moves or does not. So claim
        // nothing yet and decide on release.
        //
        // Adding on press instead was wrong in a way worth recording: it made every press add a
        // point AND claim the drag, so panning the video became impossible for as long as Fit was
        // enabled, and every attempt to pan left an unwanted control point behind. Placing points
        // accurately is mostly a matter of panning and zooming around to find the landmark, so
        // that is precisely the wrong thing to take away.
        //
        // Only a PRIMARY pointer arms one, and it remembers which pointer it belongs to. A
        // second finger arriving mid-press has already voided the pending add through the
        // cancelGesture above, and not re-arming here means it stays voided: during a pinch,
        // neither finger's release may drop a point. Same rule the Star Tracker's click-toggle
        // uses. A mouse is always primary, so none of this changes on the desktop.
        if (e.isPrimary !== false) this.pendingAdd = {cx, cy, pointerId: e.pointerId};
        return false;
    }

    onMouseDrag(e, mouseX, mouseY) {
        if (!this.enabled) return;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);

        if (this.pendingAdd !== null) {
            // Moved: this was a pan, not a click. Drop the pending add and let the video have it.
            if (Math.hypot(cx - this.pendingAdd.cx, cy - this.pendingAdd.cy) > CLICK_SLOP) {
                this.pendingAdd = null;
            }
            return;
        }

        if (this.draggingId === null) return;
        const p = this.points.find((q) => q.id === this.draggingId);
        if (!p) return;
        const [vx, vy] = this.overlayView.canvasToVideoCoordsOriginal(cx, cy);
        p.vx = vx;
        p.vy = vy;
        setRenderOne(true);
    }

    /**
     * Watch a pending add for movement. Same rule as onMouseDrag — past the slop it was a pan,
     * not a click — but driven from the document, because a press this node declined is never
     * handed drag events either. Without it the pan/click test would reduce to comparing where
     * the press went down with where it came up, and a pan that wandered away and back would
     * read as a click.
     */
    trackPendingAdd(e) {
        if (!this.isPendingPointer(e)) return;
        const [cx, cy] = mouseToCanvas(this, e.clientX, e.clientY);
        if (Math.hypot(cx - this.pendingAdd.cx, cy - this.pendingAdd.cy) > CLICK_SLOP) {
            this.pendingAdd = null;
        }
    }

    /** Is this event from the pointer that opened the pending add? False if there is none. */
    isPendingPointer(e) {
        const pending = this.pendingAdd;
        if (pending === null) return false;
        if (e === undefined || e.pointerId === undefined || pending.pointerId === undefined) {
            return true;    // not a pointer event: nothing to disambiguate, so it is ours
        }
        return e.pointerId === pending.pointerId;
    }

    /**
     * Complete a press on empty video that survived to release without moving: add the point.
     *
     * Driven by a document-level pointerup (see setEnabled) rather than by the view dispatcher,
     * because that press declined the drag and so is never handed the release. It can arrive
     * either way — whichever delivery lands first consumes the pending add, and the other finds
     * nothing to do.
     *
     * Every visible view under the cursor gets onMouseDown, not just the one that ends up owning
     * the gesture, so a pending add is opened even when Annotate, the mask, or manual tracking
     * took the same press. Committing it then would drop a camera-fit point into an unrelated
     * edit, so those are asked directly whether they are mid-edit.
     *
     * NOT by asking who holds mouseDragView, which was tried and is wrong: the dispatcher sets it
     * for any handler that did not return an explicit false, and most fall off the end returning
     * undefined. CNodeTrackingOverlay does exactly that on every ordinary click, so "somebody
     * else holds the drag" is true for every click on the video and rejected all of them.
     */
    finishPendingAdd(e) {
        // Checked BEFORE consuming: another pointer's release must leave the pending add intact
        // for the pointer that actually opened it.
        if (!this.isPendingPointer(e)) return;
        const pending = this.pendingAdd;
        this.pendingAdd = null;
        if (!this.enabled || !this.hasVideoGeometry()) return;
        if (e && e.button !== undefined && e.button !== 0) return;

        // The video view's own gates for "left-click belongs to an overlay, not to me" — the
        // single place that already answers this, rather than a second opinion that can drift.
        const ov = this.overlayView;
        if (ov?._isMaskEditing?.() || ov?._isAnnotateEditing?.() || ov?._isOverlayDragging?.()) {
            return;
        }

        const [vx, vy] = this.overlayView.canvasToVideoCoordsOriginal(pending.cx, pending.cy);
        this.withUndo("Add camera fit point", () => {
            this.addPointAtVideo(vx, vy);
            this.requestFit();
        });
    }

    onMouseUp(e) {
        // Released without moving: it was a click, so add the point.
        if (this.pendingAdd !== null) {
            this.finishPendingAdd(e);
            return;
        }

        if (this.draggingId === null) return;
        this.draggingId = null;
        // The keyframe entry is the durable store; the drag edited only the mirror.
        this.syncActiveKeyframe();
        // A 2D drag does not depend on the fitted camera, so unlike the 3D handles it could refit
        // live. It still commits on release: a solve per pointermove would write nodes and
        // cascade the whole graph dozens of times a second for no visible gain.
        this.requestFit();
        this.endUndo("Move camera fit point");
    }

    // ---------- drawing ----------

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.enabled || !this.hasVideoGeometry()) return;

        const ctx = this.ctx;
        const onFrame = this.onCorrectFrame();
        const residualOf = (id) => {
            const r = this.lastResult;
            if (!r) return null;
            const k = r.pointIds.indexOf(id);
            return k < 0 ? null : r.perPoint[k];
        };

        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            const [cx, cy] = this.canvasPosOf(p);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

            // Off-frame points are drawn faintly rather than hidden: seeing that the fit's points
            // exist somewhere else in the timeline is more useful than them vanishing.
            const alpha = onFrame ? 1 : 0.3;

            // Where this point's ground position actually projects, and a line to it. That line
            // IS the residual — it shows the direction and size of the disagreement the solver
            // could not remove, per point, which tells the user which landmark to re-examine.
            const r = residualOf(p.id);
            if (r && onFrame && Number.isFinite(r.dx) && r.distance > 1) {
                const [px, py] = this.overlayView.videoToCanvasCoordsOriginal(p.vx + r.dx, p.vy + r.dy);
                ctx.save();
                ctx.strokeStyle = p.color;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(px, py);
                ctx.stroke();
                ctx.restore();
            }

            const label = r && onFrame ? `${i + 1}  ${r.distance.toFixed(1)}px` : `${i + 1}`;
            drawFitHandle(ctx, cx, cy, p.color, label, alpha);
        }
    }
}

/**
 * Where an original-video pixel lands on the frustum's video quad, in world space.
 *
 * Put through the quad's own transform rather than recomputed from the FOV and the video distance.
 * The quad is a unit PlaneGeometry that the frustum scales by the LOOK CAMERA's fov and aspect —
 * not the video's — so the footage is stretched across it whenever those two disagree, which under
 * Match Video Aspect and video zoom they routinely do. The texture is stretched over the whole
 * quad, so normalised (u,v) through the same matrix lands on the pixel it names by construction,
 * and keeps doing so if the frustum ever changes how it sizes or places the quad.
 *
 * v is measured DOWN from the top of the frame, and the quad's top edge is v=1 in texture space
 * (PlaneGeometry's first row, and CanvasTexture's default flipY puts canvas row 0 there) — hence
 * 0.5 - vy/H rather than vy/H - 0.5.
 */
function videoPointOnQuad(quadMatrix, p, size) {
    return new Vector3(p.vx / size[0] - 0.5, 0.5 - p.vy / size[1], 0).applyMatrix4(quadMatrix);
}

/** One line the user can act on, rather than a condition number. */
function describeObservability(result) {
    const d = result.diagnostics;
    if (!d || d.conditioning === "unknown") return "-";
    if (d.conditioning === "good") {
        const pos = d.uncertainty.east !== undefined
            ? Math.max(d.uncertainty.east, d.uncertainty.north, d.uncertainty.up) : null;
        return pos !== null ? `Good (position +/-${pos.toFixed(0)} m)` : "Good";
    }
    const worst = d.weakestMode?.components?.[0]?.name ?? "some combination";
    const verb = d.conditioning === "unobservable" ? "cannot be determined" : "is weakly determined";
    return `Weak: ${worst} ${verb} by these points — held near its previous value`;
}

/**
 * Find the lil-gui controller bound to obj[prop], anywhere under the menu bar.
 *
 * Setting a flag directly would work but would leave its checkbox showing the old state, which
 * reads as the app ignoring you. Going through the controller keeps the two in step.
 */
function findGuiController(obj, prop) {
    const search = (gui) => {
        if (!gui) return null;
        for (const c of gui.controllers ?? []) {
            if (c.object === obj && c.property === prop) return c;
        }
        for (const f of gui.folders ?? []) {
            const found = search(f);
            if (found) return found;
        }
        return null;
    };
    for (const key of Object.keys(guiMenus)) {
        const found = search(guiMenus[key]);
        if (found) return found;
    }
    return null;
}
