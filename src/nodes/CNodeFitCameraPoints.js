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
import {raycastGroundElevationFast} from "../raycastGround";
import {extractFOV} from "./CNodeControllerVarious";
import {FitPointHandles3D} from "../FitPointHandles3D";
import {FitPointSightLines3D} from "../FitPointSightLines3D";
import {drawFitHandle, GRAB_RADIUS, POINT_COLORS} from "../FitHandleDraw";
import {
    azElRollFromBasis, basisFromAzElRoll, evaluateCamera, fitCameraToPoints, MAX_ABS_EL,
} from "../CameraPointFit";
import {fitCameraByPlaneHomography} from "../CameraPlaneHomography";

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
            onMoved: (id, pos) => this.onMarkerMoved(id, pos),
            onCommit: () => this.requestFit(),
            onCorrectFrame: () => this.onCorrectFrame(),
            onBeginEdit: () => this.beginUndo(),
            onEndEdit: (description) => this.endUndo(description),
        });

        this.sightLines = new FitPointSightLines3D(() => this.rayDisplay());

        this._setupGUI();
    }

    // ---------- serialization ----------
    //
    // 3D points are stored as lat/lon/alt, not ECEF, for the same reason every other position in
    // Sitrec is: an ECEF triple silently means something different if the earth model changes.

    modSerialize() {
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
            points: this.points.map((p) => ({
                vx: p.vx, vy: p.vy, lat: p.lat, lon: p.lon, alt: p.alt, color: p.color,
            })),
        };
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
        this.sightLines.update();
    }

    dispose() {
        this.setEnabled(false);   // also removes the gesture-cancel listeners
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
            // Switches first, for the same reason applyResult does it: selecting "Manual" fires a
            // listener that syncs ptzAngles from the live camera, so angles written before the
            // selection are discarded.
            for (const [id, choice] of Object.entries(c.choices ?? {})) {
                const sw = NodeMan.get(id, false);
                if (sw && choice !== undefined && sw.choice !== choice
                    && sw.inputs?.[choice] !== undefined) {
                    sw.selectOption(choice);
                }
            }
            fixed.agl = c.agl;
            fixed.setLLA(c.lla[0], c.lla[1], c.lla[2]);
            ptz.relative = false;
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
        return {
            points: this.points.map((p) => ({...p})),
            nextId: this.nextId,
            fitFrame: this.fitFrame,
            camera: this.captureCameraState(),
        };
    }

    restoreState(s) {
        this.points = s.points.map((p) => ({...p}));
        this.nextId = s.nextId;
        this.fitFrame = s.fitFrame;
        this.lastResult = null;
        this.observability = "-";
        this.restoreCameraState(s.camera);

        // Re-measure the restored camera against the restored points. Read-only — it scores what
        // is there, it does not solve — so undo stays an exact inverse. Without it the residual
        // would blank out after an undo, which reads as "unknown" when it is in fact known and
        // unchanged.
        this.residual = this.measureCurrentResidual();
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
    currentCameraState() {
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
            const v = extractFOV(fovSwitch.getValueFrame(this.fitFrame));
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

    // ---------- point management ----------

    /** @returns {object|null} the point that was added, so the caller can grab it for a drag. */
    addPointAtVideo(vx, vy) {
        const size = this.videoSize;
        const state = this.currentCameraState();
        if (!size || !state) return null;

        const origin = new Vector3(state.position[0], state.position[1], state.position[2]);
        const dir = this.rayForVideoPixel(state, vx, vy, size);

        // Seed on the terrain under the ray. This is only a starting place — the pair carries no
        // information until the sphere is dragged to the real feature — but starting on the
        // ground under the clicked pixel is a far better guess than a fixed range, and for a
        // landmark the user has already identified it is often close to right.
        let world = raycastGroundElevationFast(origin, dir, 400000);
        if (!world) world = origin.clone().addScaledVector(dir, FALLBACK_RANGE);

        const lla = ECEFToLLAVD_radii(world);
        const point = {
            id: this.nextId++,
            vx, vy,
            lat: lla.x, lon: lla.y, alt: lla.z,
            color: POINT_COLORS[this.points.length % POINT_COLORS.length],
        };
        this.points.push(point);
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
            this.requestFit();
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
    }

    /** Fit if auto-fit is on. Every interactive path goes through here. */
    requestFit() {
        if (!this.enabled) return;
        if (this.autoFit) this.runFit(false);
    }

    runFit(explicit) {
        if (!this.enabled) return;

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
            this.updateStatus(`Points belong to frame ${this.fitFrame} — go to it to fit`);
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

        const notes = this.applyResult(result);
        // Residuals are keyed by point id, not by array index. Add or delete a point after a fit
        // and the indices shift, which would silently draw each residual against the wrong
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
        this.applyingFit = true;
        try {
            const camTrack = NodeMan.get("cameraTrackSwitch", false);
            if (camTrack && !this.lockPosition && camTrack.choice !== "fixedCamera"
                && camTrack.inputs.fixedCamera !== undefined) {
                camTrack.selectOption("fixedCamera");
            }
            const fovSwitch = NodeMan.get("fovSwitch", false);
            if (fovSwitch && !this.lockFOV && fovSwitch.choice !== "userFOV"
                && fovSwitch.inputs.userFOV !== undefined) {
                fovSwitch.selectOption("userFOV");
            }
            const heading = NodeMan.get("CameraLOSController", false);
            if (heading && heading.choice !== "Manual" && heading.inputs.Manual !== undefined) {
                heading.selectOption("Manual");
            }

            const ptz = NodeMan.get("ptzAngles", false);
            if (!ptz) {
                notes.push("no Manual PTZ controller to write orientation to");
                return notes;
            }
            ptz.relative = false;

            if (!this.lockPosition) notes.push(...this.writePosition(result.position));

            ptz.az = result.azDeg;
            ptz.el = result.elDeg;
            if (!this.lockRoll && ptz.roll !== undefined) ptz.roll = result.rollDeg;
            if (!this.lockFOV) ptz.fov = result.vfovDeg;
            ptz.refresh();
        } finally {
            this.applyingFit = false;
        }

        notes.push(...this.checkAppliedCamera(result));
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

    /** Only this frame's points may be edited — see the note on fitFrame in the constructor. */
    onCorrectFrame() {
        return Math.round(par.frame) === this.fitFrame;
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
            this.updateStatus(`Points belong to frame ${this.fitFrame} — go back to it to edit`);
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
