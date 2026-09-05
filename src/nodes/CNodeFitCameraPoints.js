import {getInteractionRouter} from "../InteractionRouter";
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
import {drawFitHandle, GRAB_RADIUS, OFF_FRAME_ALPHA, POINT_COLORS} from "../FitHandleDraw";
import {
    azElRollFromBasis, basisFromAzElRoll, evaluateCamera, fitCameraToPoints, MAX_ABS_EL,
    projectWorldPoint,
} from "../CameraPointFit";
import {fitCameraByPlaneHomography} from "../CameraPlaneHomography";
import {liftCameraRelative, liftWorldPoint} from "../atmosphere/terrestrialRefraction";
import {currentTerrestrialLiftContext} from "../atmosphere/refractionSettings";
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
import {showChoice, showConfirm} from "../showError";

/** Movement below this many canvas pixels still counts as a click, not a drag. */
const CLICK_SLOP = 4;
/** How far along the ray to drop a new 3D point when the terrain raycast misses. */
const FALLBACK_RANGE = 5000;
/**
 * How many times one press of Fit Now may re-solve from its own answer.
 *
 * The solver's seed set depends on where the camera currently is — the caller's state is one
 * seed, and the focal scan stands off from the landmark centroid ALONG the direction the caller's
 * camera lies in. So moving the camera changes which basins get looked at, and a solve from the
 * answer is not the same solve again: measured on the 3-point 38 km case, successive presses ran
 * 176.9 -> 62.4 -> 62.1 -> 61.1 px, each finding a basin the previous press could not see from
 * where it stood. That is a fixed control point appearing to wander every time the button is
 * pressed, and the user is right that it should not.
 *
 * The fix is not to refuse the improvement — it is real — but to stop making the user click for
 * it. One press runs to a fixed point, and the next press then has nothing left to find and is
 * refused by the acceptance gate, which is what "idempotent" means here.
 */
const SOLVE_PASSES = 6;
/** Below this improvement in RMS pixels, a re-solve has found nothing worth moving the camera for. */
const RESOLVE_EPS = 0.01;
/**
 * How far the applied camera's residual may exceed the solved one before it is called out —
 * absolute and relative, both required, so a sub-pixel fit cannot trip it on rounding.
 */
const APPLIED_RESIDUAL_SLOP = 0.5;
const APPLIED_RESIDUAL_FRACTION = 0.05;
/** Seeding a new point against the refracted render: close enough, in original video pixels. */
const SEED_TOLERANCE = 0.5;
/** Bound on that correction. The bend is smooth and small; it settles in one or two. */
const SEED_ITERATIONS = 4;
/** The camera contributes pose but no scale to the video quad's world matrix. */
const UNIT_SCALE = new Vector3(1, 1, 1);

export class CNodeFitCameraPoints extends CNodeActiveOverlay {
    constructor(v) {
        super(v);
        this.interactionProfile = "fit";
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

        // Re-solve on every point move. OFF by default: placing the first points is the part of
        // the workflow where the solution is least constrained, so fitting as you go spends the
        // time on answers nobody wants and swings the camera about between them. Place the set,
        // then Fit Now.
        this.autoFit = false;

        // Tie the look view's framing to the video's — see setSyncLookCamera. Off until the
        // first fit turns it on, because until there is a solved camera there is nothing to
        // compare and the lock only costs the user their 3D navigation.
        this.syncLookCamera = false;

        this.showRays = true;
        // Place control points against the 3D tile geometry — roofs, walls, trees — rather than
        // the elevation surface. On by default: the tiles are the surface the analyst is actually
        // looking at, and a rooftop corner placed against the elevation map instead lands at
        // street level. A landmark on bare ground still lands on bare ground, because the tilesets
        // carry their own ground, so this costs nothing where there is nothing built. Where the
        // 3D tiles are absent or not yet streamed the pick falls back to the elevation surface
        // (surfaceAlongRay), which is the whole-planet one.
        this.useTiles = true;
        // Place points on the scene's own 3D objects too — an aircraft, a balloon, a sphere.
        // On by default for the same reason useTiles is: when one is in the shot it is almost
        // always the thing being pointed at, and a point aimed at an aircraft that silently
        // landed on the ground half a kilometre beyond it would be a hard error to spot.
        this.useObjects = true;
        this.status = "Off";
        this.residual = "-";
        this.observability = "-";

        this.lastResult = null;
        this.applyingFit = false;
        this.draggingId = null;
        // Whether the current 2D / 3D gesture actually moved anything — a grab-and-release
        // that didn't must not invalidate solutions on commit.
        this._dragMoved = false;
        this._markerMoved = false;
        // A left-press on empty video, held until release decides whether it was a click (add a
        // point) or a pan. See onMouseDown.
        this.pendingAdd = null;
        this._cancelListener = null;
        this._moveListener = null;
        this._upListener = null;
        // Snapshot taken when an undoable edit opens; see beginUndo.
        this._undoBefore = null;
        this._pendingEnable = undefined;
        // The two prompts that stand between a Fit Now and a fit — "go to the nearest fit
        // keyframe?" and "clear Free Look?" — and the fit they interrupted, resumed a tick after
        // whichever of them is accepted. One pending flag for both, because they chain: clearing
        // Free Look re-enters fitNow, which may then raise the keyframe prompt in its turn.
        this._keyframePromptOpen = false;
        this._freeLookPromptOpen = false;
        this._pendingFit = false;

        this.markers = new FitPointHandles3D({
            getPoints: () => this.points.map((p) => ({
                id: p.id, color: p.color, position: this.pointECEF(p),
            })),
            getRayDisplay: () => this.rayDisplay(),
            getOccluder: () => this.videoQuadOccluder(),
            getUseTiles: () => this.useTiles,
            getUseObjects: () => this.useObjects,
            onMoved: (id, pos) => this.onMarkerMoved(id, pos),
            // A 3D drag moved a SHARED landmark, so every keyframe's solution is stale, not
            // just the active one's — demote them all first, and let the refits re-earn what
            // they can. With Fit on Change off the demotion is the whole story, honestly told.
            // Gated on onMoved having fired: the overlay commits on every release, including a
            // bare click that grabbed a handle and let go.
            onCommit: () => {
                if (this._markerMoved) this.invalidateKeyframes("all");
                this.requestFit();
                if (this.autoFit) this.refitOtherKeyframes();
            },
            onCorrectFrame: () => this.onCorrectFrame(),
            // Reaching for a handle in a 3D view asks the same question as reaching for one on
            // the video, so it gets the same answer.
            onWrongFrame: () => this.offerNearestKeyframe("move them"),
            onBeginEdit: () => {
                this._markerMoved = false;
                this.beginUndo();
            },
            onEndEdit: (description) => this.endUndo(description),
            onRollbackEdit: () => this.onMouseRollback(),
        });

        this.sightLines = new FitPointSightLines3D(() => this.rayDisplay());

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
            syncLookCamera: this.syncLookCamera,
            showRays: this.showRays,
            useTiles: this.useTiles,
            useObjects: this.useObjects,
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
                // The third element marks a seeded (tool-invented) pixel; older builds
                // validate only the first two and strip the rest, so the shape is compatible
                // both ways.
                return {frame: k.frame,
                    uv: k.uv.map((u) => (u[2] ? [u[0], u[1], 1] : [u[0], u[1]])), solved};
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
            // A pre-seeded-flag save has plain pairs; its pixels were all treated as
            // observations when it was made, and stay observations now.
            out.push({frame, uv: uv.map((u) => (u[2] ? [u[0], u[1], 1] : [u[0], u[1]])), solved});
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
        // Restored as a plain flag. Match Video Aspect is not touched here and is not this
        // node's to touch — the frustum node serializes its own value and brings it back itself.
        // A save with no syncLookCamera key predates the flag, and back then the sync WAS
        // Enable Fit — so that is what it meant, and reading it any other way would silently
        // drop a lock the sitch was saved with. A `restoreMatchVideoAspect` key from 2.131.0 is
        // ignored: nothing owes Match Video Aspect a value any more, so there is nothing to
        // restore, and a saved one would only re-apply a coupling that no longer exists.
        this.syncLookCamera = v.syncLookCamera !== undefined ? v.syncLookCamera : !!v.enabled;
        if (v.showRays !== undefined) this.showRays = v.showRays;
        if (v.useTiles !== undefined) this.useTiles = v.useTiles;
        if (v.useObjects !== undefined) this.useObjects = v.useObjects;

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
                this.points[i].seeded = !!kf.uv[i][2];
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

        // The fit a prompt interrupted, resumed now that the graph has recalculated for whatever
        // the prompt changed — the frame it moved to, or the controllers it handed the camera
        // back to. Back through fitNow() rather than straight to runFit, so its own gates get
        // another look: clearing Free Look off a keyframe lands here and raises the keyframe
        // prompt in turn, which is how the two chain when both stand in the way.
        if (this._pendingFit) {
            this._pendingFit = false;
            if (this.enabled) this.fitNow();
        }

        // Scrubbing onto a fit keyframe makes it the one being edited. Only while the gesture
        // state is fully idle: an activation mid-drag would swap the point set under the
        // user's cursor and leave one undo entry spanning two keyframes. The open-undo check
        // covers the 3D handle drags too — they bracket themselves with beginUndo/endUndo.
        if (this.enabled && !Globals.deserializing && this.keyframes.length > 0
            && this.pendingAdd === null && this.draggingId === null
            && this._undoBefore === null) {
            const f0 = Math.round(par.frame);
            if (f0 !== this.fitFrame && this.keyframes.some((k) => k.frame === f0)) {
                this.activateKeyframe(f0);
                this.updateStatus(`Editing fit keyframe at frame ${f0}`);
            }
        }

        this.sightLines.update();
    }

    dispose() {
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

        this.gui.add(this, "syncLookCamera").name("Sync Look Camera").listen()
            .onChange((on) => this.setSyncLookCamera(on))
            .tooltip("Point the look view's controls at the video: the wheel and left drag over " +
                "the look view zoom and pan the VIDEO instead of moving the 3D camera, so the " +
                "two pictures stay framed together while you place points. A fit turns this on, " +
                "because a fit is only worth looking at side by side. Turn it off to fly the 3D " +
                "camera again — the control points stay put, and the next fit turns it back on. " +
                "Independent of Enable Fit: switching the fit off leaves this as you set it. " +
                "Does not touch Match Video Aspect, which is yours to set in the Camera menu.");

        this.gui.add(this, "showRays").name("Show Sight Lines").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("In the main view, draw a line from the camera to each ground point, and " +
                "mark each video point where it falls on the video in the frustum (Show/Hide " +
                "-> Video in Frustum). Every line crosses the video at its own marker only for " +
                "the one camera position and pointing that explains all the pairs at once — so " +
                "any gap you can see is that point's residual, drawn in 3D.");

        this.gui.add(this, "autoFit").name("Fit on Change").listen()
            .tooltip("Re-solve the camera every time a control point moves. Off by default: " +
                "place the whole set first, then fit once with the button below.");

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

        this.gui.add(this, "useObjects").name("Place on 3D Objects").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Put control points on the scene's own 3D objects — an aircraft, a balloon, " +
                "a sphere — as well as on the terrain and buildings. Aim at the aircraft and the " +
                "point lands on the aircraft, instead of passing through it onto the ground " +
                "beyond. Whichever the ray reaches FIRST wins, so an object hidden behind a " +
                "building is not picked through it, and clicking past an object still lands on " +
                "the ground. Only objects that are switched on can be hit, and the camera's own " +
                "marker never is — it sits where the fit says the camera is, so a point on it " +
                "would move every time you solved. Like the option above, this affects where " +
                "new points are dropped and where dragged handles land, not points already " +
                "placed.");

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
        if (!on) getInteractionRouter()?.cancelOwner(this);
        this.enabled = on;
        this.visible = on;
        this.markers.setEnabled(on);
        this.sightLines.setEnabled(on);
        this.cancelGesture();

        if (on) {
            // Adopt the current frame the first time points are placed; after that the points
            // own it.
            if (this.points.length === 0) this.fitFrame = Math.round(par.frame);
            setRenderOne(true);
            this.updateStatus(this.points.length ? "Ready" : "Click the video to add a point");
        } else {
            this.updateStatus("Off");
        }
        setRenderOne(true);
    }

    /**
     * Hand the look view's wheel and left drag to the video's zoom and pan, or give them back.
     *
     * That is ALL this does. It deliberately does not touch **Match Video Aspect**, which is a
     * checkbox of the user's own: cropping the look view to the video's shape is a different
     * decision from choosing what the wheel does, and the two want different answers. Judging a
     * fit at a glance often wants the wider field, so that the building you are checking is
     * visible along with its surroundings.
     *
     * Nothing is lost by the separation, because the look view ALREADY follows the video's zoom
     * and pan without it: the view is built with `syncVideoZoom`, and CNodeView3D widens the
     * camera by 1/fovCoverage and applies the video's zoom and pan offset every frame. Match
     * Video Aspect only decides whether the extra field around the video's frame is shown or
     * cropped away. So the two pictures stay comparable either way — one just has margins.
     *
     * An earlier version of this forced Match Video Aspect on, and a fit re-asserted it, so
     * unticking that box by hand did not survive the next fit. That is the behaviour this
     * replaces.
     *
     * Not tied to Enable Fit either. Placing points and judging the result want the wheel on the
     * video; reading the scene, checking what is behind a building, or lining up the next
     * keyframe want the camera back — and those happen with the fit still on. So a fit turns
     * this on (runFit), and only the user turns it off.
     */
    setSyncLookCamera(on) {
        this.syncLookCamera = on;
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
            // A fit switches this on by itself (see runFit), exactly as it selects the camera
            // switches captureCameraState records — and for the same reason it is captured here.
            // With Fit on Change, one point drag flips it; an undo that put the points back but
            // left the wheel still driving the video would not be an undo of what the user did.
            //
            // Match Video Aspect is NOT captured with it. The fit no longer touches that box, so
            // it is the user's setting and not part of the edit — restoring it would mean an
            // undo of a point move silently reverting a checkbox the user had ticked since.
            syncLookCamera: this.syncLookCamera,
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
        // Snapshots taken before this was captured leave the flag alone. A 2.131.0 snapshot may
        // also carry matchVideoAspect / restoreMatchVideoAspect; both are ignored, for the same
        // reason captureState no longer records them.
        if (s.syncLookCamera !== undefined) this.setSyncLookCamera(s.syncLookCamera);

        // Re-measure the restored camera against the restored points. Read-only — it scores what
        // is there, it does not solve — so undo stays an exact inverse. Without it the residual
        // would blank out after an undo, which reads as "unknown" when it is in fact known and
        // unchanged.
        this.residual = this.measureCurrentResidual();
        this.updateKeyframeInfo();
        this.updateStatus(this.points.length ? "Restored" : "Click the video to add a point");
        setRenderOne(true);
    }

    /**
     * RMS reprojection error of the camera as it now stands, in original video pixels.
     * @returns {number|null} null when there is nothing to score.
     */
    currentResidualPx() {
        const size = this.videoSize;
        const state = this.currentCameraState();
        // Real observations only, matching the solve: a seeded marker sits wherever some camera
        // projected it, and measuring the camera against its own projection reports agreement
        // that means nothing.
        const kept = this.points.filter((p) => !p.seeded);
        if (!size || !state || kept.length === 0) return null;
        const r = evaluateCamera({
            points: kept.map((p) => {
                const w = this.pointECEF(p);
                return {px: [p.vx, p.vy], world: [w.x, w.y, w.z]};
            }),
            imageSize: size,
            state,
            localFrame: (pos) => this.localFrameAt(pos),
            liftFactory: this.liftFactory(),
        });
        return Number.isFinite(r.rms) ? r.rms : null;
    }

    /** Score the camera as it stands against the current points, without solving anything. */
    measureCurrentResidual() {
        const rms = this.currentResidualPx();
        return rms === null ? "-" : `${rms.toFixed(2)} px`;
    }

    /** Open an undoable edit. Paired with endUndo; used for edits that span a whole drag. */
    beginUndo() {
        // One at a time. A second begin without an end means a gesture was abandoned, and the
        // newer edit is the one the user is actually performing.
        this._undoBefore = this.captureState();
    }

    onMouseRollback() {
        const before = this._undoBefore;
        this.cancelGesture();
        if (before) this.restoreState(before);
        setRenderOne(true);
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

    /**
     * The air between the camera and the landmarks, in the form the solver wants it.
     *
     * The video shows a REFRACTED world, and so does the look view: the solid scene is lofted in
     * the vertex shader by k*d/(2R) (see atmosphere/terrestrialRefraction.js). Matching a video
     * pixel to a straight line through the landmark therefore charges the whole bend to the
     * camera's pointing. That is a self-consistent lie — the residuals come out small, because
     * every landmark at a similar range is displaced by a similar amount and a pitch error
     * absorbs it — and it is exactly why a fit could read 0.5 px on a point while the look view
     * visibly disagreed with the footage. Measured here: 0.013 deg of bend on a 38 km sightline,
     * against a 0.084 deg field. Fifteen per cent of the frame, hidden inside a plausible number.
     *
     * Returns null when refraction is off, so the solve is then bit-identical to before.
     */
    liftFactory() {
        return (positionArray) => {
            const ctx = currentTerrestrialLiftContext(
                new Vector3(positionArray[0], positionArray[1], positionArray[2]));
            if (!ctx) return null;
            // One scratch pair per factory call, not per projection: the solver calls this a few
            // thousand times per solve through the numerical Jacobian.
            const rel = new Vector3(), out = new Vector3();
            return (d) => {
                liftCameraRelative(ctx, rel.set(d[0], d[1], d[2]), out);
                return [out.x, out.y, out.z];
            };
        };
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

    /**
     * Exact inverse of rayForVideoPixel: where a world point falls, in original video pixels.
     * Same intrinsics and same basis, so a point put through one and back through the other
     * returns the pixel it started from.
     *
     * @returns {number[]|null} null when the point is behind the camera.
     */
    videoPixelForPoint(state, world, size) {
        const frame = this.localFrameAt(state.position);
        const b = basisFromAzElRoll(frame.up, frame.north, state.azDeg, state.elDeg, state.rollDeg);
        const dx = world.x - state.position[0];
        const dy = world.y - state.position[1];
        const dz = world.z - state.position[2];
        const f = dx * b.fwd[0] + dy * b.fwd[1] + dz * b.fwd[2];
        if (!(f > 1e-6)) return null;
        const r = dx * b.right[0] + dy * b.right[1] + dz * b.right[2];
        const d = dx * b.down[0] + dy * b.down[1] + dz * b.down[2];
        const fpx = size[1] / (2 * Math.tan((state.vfovDeg * Math.PI) / 360));
        return [size[0] / 2 + (fpx * r) / f, size[1] / 2 + (fpx * d) / f];
    }

    /**
     * The surface point that RENDERS at a video pixel, or null if the ray reaches none.
     *
     * The mirror of groundUnderCanvasPoint, for the same reason: the ray through a pixel is the
     * APPARENT ray, and the ground it appears to meet sits below it by the refraction lift. Cast
     * that ray and stop, and the point is seeded where the pixel would have looked through a
     * vacuum — metres of ground, and tens of screen pixels, from the feature just clicked on.
     * So aim, see where the aim actually lands once lofted, and aim off by the error.
     *
     * With refraction off the first cast is exact and the loop leaves after one pass.
     */
    surfaceUnderVideoPixel(state, vx, vy, size, origin) {
        const camera = this.lookCameraNode()?.camera;
        const ctx = currentTerrestrialLiftContext(origin);
        const apparent = new Vector3();
        let aimX = vx, aimY = vy;
        let found = null;
        for (let i = 0; i < SEED_ITERATIONS; i++) {
            const dir = this.rayForVideoPixel(state, aimX, aimY, size);
            const hit = surfaceAlongRay(origin, dir, this.useTiles, camera, this.useObjects);
            // Aimed off the world: keep the last real surface rather than discarding a good
            // answer because a correction overshot the horizon.
            if (!hit) return found;
            found = hit;
            if (ctx === null) break;
            const at = this.videoPixelForPoint(state, liftWorldPoint(ctx, hit, apparent), size);
            if (at === null) break;
            const ex = vx - at[0], ey = vy - at[1];
            if (Math.hypot(ex, ey) < SEED_TOLERANCE) break;
            aimX += ex;
            aimY += ey;
        }
        return found;
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

    // A uv entry is [vx, vy] for an observation a person placed, and [vx, vy, 1] for a SEED — a
    // pixel this tool invented by projecting the landmark through some camera it already believed
    // in. The distinction is the whole basis of the fitted-solution lifecycle: seeds keep markers
    // visually attached across keyframes, but they are not evidence, so no solve may consume one
    // and no solution derived while they existed outlives an edit. The mirror carries the flag as
    // p.seeded, cleared the moment the user drags that marker (see onMouseDrag).

    pointsUV() {
        return this.points.map((p) => (p.seeded ? [p.vx, p.vy, 1] : [p.vx, p.vy]));
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
            this.points[i].seeded = !!kf.uv[i][2];
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

    /**
     * Where a landmark projects in a given camera, in original video pixels, or null.
     *
     * Carries the refraction bend, because both callers are making a claim about what a camera
     * SEES: one opens a new keyframe's crosshairs where the landmarks would be if the camera had
     * not moved, the other seeds a new landmark's pixel in the other keyframes consistently with
     * their existing solutions. Those solutions are solved through the bend, so a straight-line
     * projection here would put the marker tens of pixels off the feature it names and then drag
     * the next refit towards it.
     */
    projectThroughState(state, worldVec, size) {
        const frame = this.localFrameAt(state.position);
        const basis = basisFromAzElRoll(
            frame.up, frame.north, state.azDeg, state.elDeg, state.rollDeg);
        const px = projectWorldPoint(
            {position: state.position, focalScale: 1, basis,
             lift: this.liftFactory()(state.position)},
            [worldVec.x, worldVec.y, worldVec.z],
            lensFromVFOV(state.vfovDeg, size), size);
        return px && Number.isFinite(px[0]) && Number.isFinite(px[1]) ? px : null;
    }

    /** How many of a keyframe's pixels a person actually placed — the ones a solve may use. */
    realObservationCount(kf) {
        const uv = kf.frame === this.fitFrame ? this.pointsUV() : kf.uv;
        let n = 0;
        for (const u of uv) if (!u[2]) n++;
        return n;
    }

    /**
     * The observations changed, so every solution derived from the old ones stops being a
     * statement about these landmarks. Demote rather than delete: the camera is kept as a seed
     * for the next solve and a hold for the display, but motion stops flying through it and the
     * keyframe readout marks it '?' until a solve re-earns it. With Fit on Change on, the refit
     * that follows the edit re-promotes immediately; with it off, nothing pretends.
     *
     * @param {string} scope "active" for an edit that touched only this keyframe's pixels,
     *                       "all" for one that moved a landmark every keyframe observes
     */
    invalidateKeyframes(scope) {
        let changed = false;
        let activeChanged = false;
        for (const kf of this.keyframes) {
            if (scope === "active" && kf.frame !== this.fitFrame) continue;
            if (kf.solved && kf.solved.fitted !== false) {
                kf.solved.fitted = false;
                changed = true;
                if (kf.frame === this.fitFrame) activeChanged = true;
            }
        }
        if (changed) {
            this.refreshMotionNodes();
            this.updateKeyframeInfo();
        }
        // The readouts describe the demoted solve, so they go with it: keeping "Fitted" and the
        // old residual arrows on screen after the observations changed would be this display
        // claiming exactly what the demotion just retracted. With Fit on Change on, the solve
        // that follows immediately overwrites all of this; with it off, this is what remains.
        if (activeChanged) {
            this.lastResult = null;
            this.observability = "-";
            this.residual = this.measureCurrentResidual();
            this.updateStatus("Points edited — Fit Now to re-solve");
        }
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

        // Refresh this keyframe's SEEDS first: a seed's only job is to keep the marker visually
        // on the landmark, and the landmark may be why we are here — re-project it through the
        // stored camera so the display follows the edit. Never the active keyframe: its markers
        // are under the user's cursor, and uv there is a copy of the mirror anyway.
        if (kf.solved && kf.frame !== this.fitFrame) {
            for (let i = 0; i < uv.length && i < this.points.length; i++) {
                if (!uv[i][2]) continue;
                const px = this.projectThroughState(
                    this.stateFromSolved(kf.solved), this.pointECEF(this.points[i]), size);
                if (px) { uv[i][0] = px[0]; uv[i][1] = px[1]; }
            }
        }

        // Solve from real observations only. A seed is a projection of the very solution being
        // refit — feeding it back in would let the old camera vote for itself, which is exactly
        // the circularity that let fabricated pixels masquerade as fitted solutions.
        const realIdx = [];
        for (let i = 0; i < uv.length && i < this.points.length; i++) {
            if (!uv[i][2]) realIdx.push(i);
        }
        if (realIdx.length < 2) {
            demote();
            return false;
        }
        const solverPoints = realIdx.map((i) => {
            const w = this.pointECEF(this.points[i]);
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
        // Same air as the interactive fit. A headless refit that solved straight lines while the
        // interactive one solved through the bend would make every keyframe but the active one
        // disagree with it, and the motion between them is the difference of the two.
        const liftFactory = this.liftFactory();
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
            liftFactory,
            // A refit starts from a previous solution, so the full multi-seed search is wasted
            // work — and this can run for several keyframes in one edit.
            options: kf.solved ? {seedsToRefine: 1, prefilterIterations: 8} : undefined,
        };
        const result = this.fitMethod === "homography"
            ? this.fitHomographyRefracted(spec)
            : fitCameraToPoints(spec);
        if (!result.ok) {
            demote();
            return false;
        }
        if (kf.solved) {
            // The same guard runFit applies: a solve far worse than the solution it would
            // replace is a bad basin, not an answer. Scored through the same forward model as
            // the result it is being compared against, or the guard is comparing two physics.
            const current = evaluateCamera({
                points: solverPoints, imageSize: size,
                state: this.stateFromSolved(kf.solved), localFrame, liftFactory,
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
        // Same gate as runFit: a disabled tool must not rewrite anything, and API paths reach
        // here without going through the GUI.
        if (!this.enabled) return;
        if (this.keyframes.length < 2) return;
        let failed = 0;
        for (const kf of this.keyframes) {
            if (kf.frame === this.fitFrame) continue;
            // A keyframe that is still mostly seeds has nothing real to refit FROM — it is
            // provisional, not failing. It stays (or becomes) '?' without counting against the
            // status line.
            if (this.realObservationCount(kf) < 2) {
                if (kf.solved) kf.solved.fitted = false;
                continue;
            }
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
        // where the landmarks really are is what states the motion. Every one is marked as a
        // seed: none of these pixels was observed on this frame, so none may feed a solve
        // until the user has placed it (dragging clears the mark).
        const state = this.currentCameraState(frame);
        const uv = this.points.map((p) => {
            const px = state ? this.projectThroughState(state, this.pointECEF(p), size) : null;
            return px ? [px[0], px[1], 1] : [p.vx, p.vy, 1];
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

    /**
     * @param {object|null} worldLLA {lat, lon, alt} (alt is HAE) when the caller — the API —
     *        already knows where the landmark IS. It must arrive here, not be patched on
     *        afterwards: everything below that depends on the world position (the seeds pushed
     *        into the other keyframes above all) has to describe the real landmark, not a
     *        surface guess that is about to be thrown away.
     * @returns {object|null} the point that was added, so the caller can grab it for a drag.
     */
    addPointAtVideo(vx, vy, worldLLA = null) {
        const size = this.videoSize;
        const state = this.currentCameraState();
        if (!size || !state) return null;

        const origin = new Vector3(state.position[0], state.position[1], state.position[2]);

        // Seed on the surface under the pixel. This is only a starting place — the pair carries
        // no information until the sphere is dragged to the real feature — but starting under
        // the clicked pixel is a far better guess than a fixed range, and for a landmark the user
        // has already identified it is often close to right. Uses the same surface the handles
        // are dragged against, so clicking a rooftop seeds on the roof rather than on the street
        // below it and then jumping when first dragged. UNDER THE PIXEL means under it in the
        // rendered image, refraction included — see surfaceUnderVideoPixel.
        let world;
        if (worldLLA) {
            world = LLAToECEF(worldLLA.lat, worldLLA.lon, worldLLA.alt);
        } else {
            world = this.surfaceUnderVideoPixel(state, vx, vy, size, origin);
            if (!world) {
                const dir = this.rayForVideoPixel(state, vx, vy, size);
                world = origin.clone().addScaledVector(dir, FALLBACK_RANGE);
            }
        }

        const lla = worldLLA ?? (() => {
            const g = ECEFToLLAVD_radii(world);
            return {lat: g.x, lon: g.y, alt: g.z};
        })();
        const point = {
            id: this.nextId++,
            vx, vy,
            lat: lla.lat, lon: lla.lon, alt: lla.alt,
            color: POINT_COLORS[this.points.length % POINT_COLORS.length],
        };
        this.points.push(point);

        // Every keyframe carries a pixel for every landmark. The other keyframes get this one
        // SEEDED — projected through their stored camera, so the marker sits where that
        // keyframe's solution says the landmark is, marked as invented so no solve consumes it.
        // Their existing solutions stay fitted: they still explain every pixel that was actually
        // observed there, and a seed adds no observation. Falling back to this frame's pixel
        // when there is no solution to project through — equally a seed.
        this.ensureBaseKeyframe();
        for (const kf of this.keyframes) {
            if (kf.frame === this.fitFrame) continue;
            const px = kf.solved
                ? this.projectThroughState(this.stateFromSolved(kf.solved), world, size)
                : null;
            kf.uv.push(px ? [px[0], px[1], 1] : [vx, vy, 1]);
        }
        // The ACTIVE keyframe gained a real observation, so its solution no longer explains
        // everything on this frame; the refit that normally follows re-earns it.
        this.invalidateKeyframes("active");
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
            // Every keyframe may have observed the deleted landmark, so every solution is now
            // about a point set that no longer exists.
            this.invalidateKeyframes("all");
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
        this._markerMoved = true;
    }

    // ---------- the fit ----------

    /**
     * @param {boolean} offerFixes offer to clear whatever stands between here and a fit —
     *        Free Look, or being off a fit keyframe — instead of just refusing. False for
     *        callers with nobody to ask; see the API note below.
     */
    fitNow(offerFixes = true) {
        // Free Look first, because it is the one that would otherwise look like it worked: the
        // solve succeeds and the camera ignores every part of the answer. Asked before the
        // keyframe question so the user is not moved to another frame only to be told the fit
        // could not be applied there either.
        if (offerFixes && !this.offerClearFreeLook()) return;
        // Off a keyframe, offer to go to one and fit there rather than simply refusing. Asked
        // HERE, on the explicit button, and not down in runFit: requestFit reaches runFit on
        // every point nudge with Fit on Change on, and a dialog raised by a drag nobody thought
        // of as "attempting a fit" would be an ambush. runFit still refuses on its own, so the
        // rule is enforced in one place and merely offered in this one.
        //
        // The API passes false. A modal there would put a dialog on screen with nobody in front
        // of it, and hand the caller a summary of a fit that had not happened; runFit's own
        // refusal reaches it as a status string, which is what fitPointsSolve already reported.
        if (offerFixes && this.points.length > 0
            && !this.offerNearestKeyframe("fit the camera", true)) {
            return;
        }
        // An explicit Fit Now re-solves everything, so the whole keyframe set is consistent
        // with the landmarks as they now stand — but only when the active solve actually RAN.
        // A refusal (tool off, wrong frame, no video) refuses the whole operation: rewriting
        // the other keyframes after refusing the active one would make "refused" a lie.
        if (this.runFit(true)) this.refitOtherKeyframes();
    }

    /** Fit if auto-fit is on. Every interactive path goes through here. */
    requestFit() {
        if (!this.enabled) return;
        if (this.autoFit) this.runFit(false);
    }

    /** @returns {boolean} whether a solve actually ran — false on every refusal gate */
    runFit(explicit) {
        if (!this.enabled) return false;

        // Re-entrancy guard. Applying a fit selects switches and writes nodes, each of which
        // cascades; anything downstream that pokes this node back must not start a second solve
        // inside the first one's write-back.
        if (this.applyingFit) return false;

        const size = this.videoSize;
        if (!size) { this.updateStatus("No video loaded"); return false; }

        // Free Look would make this a fit that appears to work and does nothing — see
        // freeLookOn(). Refused here so every path is covered, and OFFERED as a choice on the
        // Fit Now button, the same division of labour the wrong-frame gate uses.
        if (this.freeLookOn()) {
            this.updateStatus("Free Look is on, so the fit could not move the camera — " +
                "switch it off and fit again");
            setRenderOne(true);
            return false;
        }

        // The fit reads the LIVE camera as its starting state, and the live camera is whatever
        // the controllers produce at par.frame. Solving points from frame N against a camera
        // posed for frame M would be quietly wrong for anything but a locked-off camera, so the
        // two have to agree. Refusing is the honest option: scrubbing the timeline for the user
        // would be a surprising side effect of ticking a checkbox.
        if (this.points.length > 0 && !this.onCorrectFrame()) {
            this.updateStatus(this.wrongFrameMessage("fit"));
            setRenderOne(true);
            return false;
        }

        const state = this.currentCameraState();
        if (!state) { this.updateStatus("No look camera"); return false; }

        if (Math.abs(state.elDeg) > MAX_ABS_EL) {
            this.updateStatus(`Camera is within ${90 - MAX_ABS_EL} deg of vertical — cannot fit`);
            return false;
        }

        const free = {
            position: !this.lockPosition,
            az: true,
            el: true,
            roll: !this.lockRoll,
            fov: !this.lockFOV,
        };

        // Only observations a person actually placed. A seeded marker is a projection of some
        // camera this tool already believed in, so solving against it can only tell the solver
        // what it already thinks — and on a freshly added keyframe, where EVERY marker is still
        // a seed, it would "converge" instantly on the seeding camera and report a perfect fit
        // of nothing. See addPointAtVideo/addFitKeyframe for where seeds are made and the drag
        // handlers for where they become real.
        const kept = this.points.filter((p) => !p.seeded);
        if (kept.length < 2 && kept.length < this.points.length) {
            this.updateStatus("The markers on this frame are still seeded guesses — drag each " +
                "to its landmark before fitting");
            setRenderOne(true);
            return false;
        }
        const solverPoints = kept.map((p) => {
            const w = this.pointECEF(p);
            return {px: [p.vx, p.vy], world: [w.x, w.y, w.z]};
        });
        const localFrame = (pos) => this.localFrameAt(pos);
        const liftFactory = this.liftFactory();

        // What the camera the user already has scores against these points. The fit has to beat
        // it to be worth applying — see the rejection below. Scored through the SAME forward
        // model the fit uses, or the gate would be comparing two different physics.
        const current = evaluateCamera({
            points: solverPoints, imageSize: size, state, localFrame, liftFactory,
        });

        const solverSpec = {
            points: solverPoints,
            imageSize: size,
            initial: state,
            free,
            localFrame,
            liftFactory,
        };
        const solveFrom = (initial) => (this.fitMethod === "homography"
            ? this.fitHomographyRefracted({...solverSpec, initial})
            : fitCameraToPoints({...solverSpec, initial}));

        let result = solveFrom(state);
        // Re-solve from the answer until the answer stops improving — see SOLVE_PASSES.
        for (let pass = 1; pass < SOLVE_PASSES && result.ok; pass++) {
            const again = solveFrom({
                position: result.position, azDeg: result.azDeg, elDeg: result.elDeg,
                rollDeg: result.rollDeg, vfovDeg: result.vfovDeg,
            });
            // Judged on RMS, the same metric the acceptance gate below and the Residual
            // readout use, so a pass is kept exactly when it is an improvement the user
            // would be shown.
            if (!again.ok || !(again.rms < result.rms - RESOLVE_EPS)) break;
            result = again;
        }

        if (!result.ok) {
            this.lastResult = null;
            this.residual = "-";
            this.observability = "-";
            this.updateStatus(result.reason);
            setRenderOne(true);
            return true;
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
            return true;
        }

        const notes = this.applyResult(result);
        // A fit exists to be checked against the footage, so put the look view's controls on the
        // video. Only the change is announced, so a refit does not go on repeating it. (This was
        // written as a deliberate RE-ASSERT when the sync also forced Match Video Aspect, to
        // repair that box being unticked by hand; it no longer owns that box, so with the sync
        // already on this is now simply a no-op.)
        const wasSynced = this.syncLookCamera;
        this.setSyncLookCamera(true);
        if (!wasSynced) notes.push("Sync Look Camera on");
        // The solver models a square-pixel pinhole; the look view's anamorphic Y-compress
        // is applied AFTER projection and the fit cannot see it. Even 1% is ~5 px of
        // vertical mismatch at the frame edges when blending the video over the look view,
        // while displaying as a plausible-looking image — so say it in the status rather
        // than let the overlay comparison quietly disagree with a correct fit.
        const lookYc = NodeMan.get("lookView", false)?.yCompress;
        if (lookYc > 1.0001) {
            notes.push(`Look Y-comp is ${lookYc.toFixed(2)}x — the fit assumes 1.00, ` +
                `so the look view will not overlay the video exactly`);
        }
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
        // Residuals are keyed by point id, not by array index — and only the points the solve
        // actually used get one. Add or delete a point after a fit and the indices shift, and a
        // seeded marker was never solved against; drawing a residual for either would claim a
        // disagreement with a landmark nobody measured.
        result.pointIds = kept.map((p) => p.id);
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
        return true;
    }

    /**
     * Plane homography, with the atmosphere folded in by iteration.
     *
     * The homography is closed form — it decomposes ONE plane-to-image map — so there is nowhere
     * to hang a per-evaluation bend the way the descent solver has. What there is instead is a
     * fixed point: lift the landmarks to where the camera we currently believe in would SEE them,
     * solve the straight-line problem against those, and the camera that falls out is a better
     * observer to lift about than the one we started from. Two passes is generous: the lift moves
     * by a small fraction of itself when the camera moves within its own uncertainty, so the
     * second pass is already a correction to a correction.
     *
     * Note this keeps the solver itself straight-line, which is the honest division of labour —
     * refraction is not a property of the homography. The price of that is that the number it
     * hands back is about the stand-ins rather than about the landmarks, so it is re-scored
     * before it leaves here; see below.
     */
    fitHomographyRefracted(spec) {
        let from = new Vector3(spec.initial.position[0], spec.initial.position[1],
            spec.initial.position[2]);
        // Refraction off: the lifted points ARE the points, so run it once and change nothing.
        if (currentTerrestrialLiftContext(from) === null) {
            return fitCameraByPlaneHomography(spec);
        }
        let result = null;
        for (let pass = 0; pass < 2; pass++) {
            // Lift each correspondence's OWN world position. spec.points is compacted — seeded
            // markers are filtered out before the solver sees anything — so indexing this.points
            // in parallel would pair pixels with the wrong landmarks whenever a seed sits
            // between two real observations.
            const ctx = currentTerrestrialLiftContext(from);
            const lifted = spec.points.map((sp) => {
                const w = liftWorldPoint(ctx,
                    new Vector3(sp.world[0], sp.world[1], sp.world[2]), new Vector3());
                return {px: sp.px, world: [w.x, w.y, w.z]};
            });
            const r = fitCameraByPlaneHomography({...spec, points: lifted});
            // A failure on the first pass is the answer; on the second, keep the first pass's
            // camera rather than reporting a failure we already had a result for.
            if (!r.ok) {
                if (result === null) return r;
                break;
            }
            result = r;
            from = new Vector3(r.position[0], r.position[1], r.position[2]);
        }
        return this.scoreAgainstRealPoints(spec, result);
    }

    /**
     * Replace a result's residuals with the same camera scored against the REAL landmarks under
     * the app's own forward model.
     *
     * Needed because the homography scores ITSELF, straight-line, against whatever points it was
     * handed — which above are lifted stand-ins, and lifted about the PREVIOUS pass's camera at
     * that. So the rms and per-point residuals it returns answer "how well does this camera
     * explain those stand-ins", and three places downstream are asking something else:
     *
     *   runFit's acceptance gate compares this rms against the current camera scored WITH the
     *   lift. Two numbers from two different forward models, and the gate decides on the
     *   difference between them — it could refuse a good fit or apply a bad one.
     *
     *   The Residual readout and the dashed per-point lines in the video overlay are drawn from
     *   perPoint, and a residual line is a claim about a specific landmark.
     *
     *   The outer re-solve loop in runFit keeps a pass only when its rms improves, so it too has
     *   to be comparing like with like.
     *
     * Cheap — one projection per point — and it makes every one of those a single metric.
     */
    scoreAgainstRealPoints(spec, result) {
        if (!result || !result.ok) return result;
        const scored = evaluateCamera({
            points: spec.points,
            imageSize: spec.imageSize,
            localFrame: spec.localFrame,
            liftFactory: spec.liftFactory,
            state: {
                position: result.position, azDeg: result.azDeg, elDeg: result.elDeg,
                rollDeg: result.rollDeg, vfovDeg: result.vfovDeg,
            },
        });
        return {...result, rms: scored.rms, perPoint: scored.perPoint};
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
        const locks = this.effectiveLocks();
        // Aspects currently owned by the "Fit Points" motion sources are NOT written here and
        // their switches are NOT yanked back to the manual options: for those, the stored
        // keyframe solution (see land()) IS the write-back — the motion nodes read it
        // directly, and at a keyframe's own frame the interpolated camera is that solution.
        const owns = this.motionOwnsAspects();
        this.applyingFit = true;
        try {
            const camTrack = NodeMan.get("cameraTrackSwitch", false);
            if (!owns.pos && camTrack && !locks.position && camTrack.choice !== "fixedCamera"
                && camTrack.inputs.fixedCamera !== undefined) {
                camTrack.selectOption("fixedCamera");
            }
            const fovSwitch = NodeMan.get("fovSwitch", false);
            if (!owns.fov && fovSwitch && !locks.fov && fovSwitch.choice !== "userFOV"
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
                if (!locks.roll && ptz.roll !== undefined) ptz.roll = result.rollDeg;
            }
            if (!owns.pos && !locks.position) notes.push(...this.writePosition(result.position));
            if (!owns.fov && !locks.fov) ptz.fov = result.vfovDeg;

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
        //
        // The residual cross-check is stricter still: it scores the WHOLE rendered camera, so it
        // only means anything when this method wrote the whole camera. Let a motion source own
        // the pointing or the FOV and it would be scoring a camera nobody applied yet, and
        // reporting "something downstream did not take the fit" about a camera that is simply
        // arriving on a later frame.
        if (!owns.pos) {
            notes.push(...this.checkAppliedCamera(result,
                {scoreResidual: !owns.head && !owns.fov}));
        }
        return notes;
    }

    /**
     * Which locks the CURRENT solver can actually honour.
     *
     * The homography honours none of them: it recovers position, pointing and focal length from
     * one decomposition, and there is no version of it that holds any of the three fixed. That is
     * why syncMethodControls() greys the three checkboxes out under this method — but greying a
     * control out only changes what the user can set, not what applyResult reads, and it went on
     * reading them.
     *
     * The visible consequence was roll, because Lock Roll defaults ON. A homography that solved
     * roll = 127.6 deg had it silently dropped, so the camera that got applied was not the camera
     * that had been solved OR scored: measured, 254.9 px reported against 1145.8 px actually
     * rendered. The residual readout, the per-point lines and the acceptance gate were all
     * describing a camera the user did not have.
     *
     * The saved lockPosition/lockFOV/lockRoll flags are left alone — switching back to the direct
     * method has to find them as the user left them.
     */
    effectiveLocks() {
        if (this.fitMethod === "homography") {
            return {position: false, fov: false, roll: false};
        }
        return {position: this.lockPosition, fov: this.lockFOV, roll: this.lockRoll};
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
     *
     * @param {object}  [options]
     * @param {boolean} [options.scoreResidual] run the whole-camera residual check below. Off
     *        when a Fit Points motion source owns part of the camera, because then the rendered
     *        camera is not the one this write-back produced — see the call site.
     */
    checkAppliedCamera(result, options = {}) {
        const scoreResidual = options.scoreResidual ?? true;
        const node = this.lookCameraNode();
        if (!node) return [];
        const notes = [];
        node.camera.updateMatrixWorld();
        const applied = node.camera.position;
        const off = Math.hypot(
            applied.x - result.position[0],
            applied.y - result.position[1],
            applied.z - result.position[2],
        );
        if (off > 1) {
            notes.push(`camera ended up ${off.toFixed(0)} m from the solution (ground clamp?) — ` +
                `the residual is for the solution, not the rendered camera`);
        }

        // Position is not the only way the applied camera can end up being a different camera:
        // a lock the solver could not honour, a switch that refused to select, a controller
        // still driving the pointing. Rather than enumerate the ways, score what actually got
        // rendered against the same points and compare it with what was solved. One projection
        // per point, and it is the check that would have caught the homography's solved roll
        // being dropped on the way out — 254.9 px reported, 1145.8 px rendered.
        const appliedRms = scoreResidual ? this.currentResidualPx() : null;
        if (appliedRms !== null && Number.isFinite(result.rms)
            && appliedRms > result.rms + APPLIED_RESIDUAL_SLOP
            && appliedRms > result.rms * (1 + APPLIED_RESIDUAL_FRACTION)) {
            notes.push(`the camera that was applied scores ${appliedRms.toFixed(1)} px, not the ` +
                `solved ${result.rms.toFixed(1)} px — something downstream did not take the fit`);
        }
        return notes;
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
     * Is the look camera being hand-flown, so a fit could not move it?
     *
     * Free Look suspends every computed source that writes the camera's pose —
     * CNodeCamera.applyControllers returns before running any of them. A fit still SOLVES
     * correctly under it, because it reads the live camera and the hand-flown pose is a real
     * pose; what it cannot do is apply the answer. fixedCameraPosition, ptzAngles and fovUI
     * would all be written and every one of them ignored, and the fit would report a residual
     * and a "Fitted" status over a camera that had not moved — which is the worst kind of
     * failure this tool can have, because the camera IS the output.
     */
    freeLookOn() {
        return !!this.lookCameraNode()?.freeLook;
    }

    /**
     * Free Look is on and a fit was asked for: offer to switch it off and go ahead.
     *
     * Switching it off is not a discard — the setter publishes the flown position into the
     * Manual position node and hands the orientation to the PTZ angles, so the camera stays
     * exactly where it was flown to. That is what makes this offer safe to accept: the fit then
     * starts from the pose the user chose, rather than from wherever the camera was before they
     * started flying.
     *
     * @returns {boolean} true when Free Look is already off and the caller may just proceed
     */
    offerClearFreeLook() {
        if (!this.freeLookOn()) return true;
        if (this._freeLookPromptOpen) return false;

        this._freeLookPromptOpen = true;
        showChoice("Free Look needs to be off to fit points.", {
            title: "Free Look Is On",
            options: [
                {label: "Clear Lock, then Do Fit", value: true, primary: true, color: "#1976d2"},
                {label: "Cancel Fit", value: false, cancel: true, color: "#757575"},
            ],
        }).then((clear) => {
            this._freeLookPromptOpen = false;
            if (!clear) {
                this.updateStatus("Fit cancelled — Free Look is still on");
                setRenderOne(true);
                return;
            }
            const cam = this.lookCameraNode();
            // Through the GUI controller the camera node keeps a handle to, so the checkbox
            // follows rather than silently disagreeing with the state. Straight to the property
            // if the menu was never built — the setter does all the real work either way, and
            // the mirrored copy in the look view's header menu follows through shareAs.
            if (cam?.freeLookController) cam.freeLookController.setValue(false);
            else if (cam) cam.freeLook = false;
            // Deferred for the same reason the keyframe jump is: switching Free Look off hands
            // the flown pose to the position and angle nodes and lets the controllers drive
            // again, and the fit's write-back should land on a camera those controllers are
            // already posing. update() picks it up next tick.
            this._pendingFit = true;
            this.updateStatus("Free Look off — fitting");
            setRenderOne(true);
        });
        return false;
    }

    /** The fit keyframe closest to the playhead, or the active frame when there are none yet. */
    nearestKeyframeFrame() {
        const f = Math.round(par.frame);
        if (this.keyframes.length === 0) return this.fitFrame;
        let best = this.keyframes[0];
        for (const k of this.keyframes) {
            if (Math.abs(k.frame - f) < Math.abs(best.frame - f)) best = k;
        }
        return best.frame;
    }

    /**
     * Off a fit keyframe, ask whether to go to the nearest one — and do it if so.
     *
     * The refusals this replaces were correct and useless in the same breath. Points belong to
     * the frame they were observed on (see fitFrame), so editing or fitting from anywhere else
     * has to be refused; but "go to frame 214" left the user to find frame 214, when the tool
     * knew the number and could just as well go there. Every refusal here is one keypress from
     * being the thing the user wanted, so it is offered as that instead.
     *
     * @param {string} verb what the caller was trying to do, as an infinitive that reads after
     *                 "go to it to ..." — it is used in the prompt and in the status line the
     *                 refusal leaves behind, so it has to fit both
     * @param {boolean} thenFit re-run the fit on arrival — set when a fit is what was refused
     * @returns {boolean} true when already on a keyframe and the caller may just proceed
     */
    offerNearestKeyframe(verb, thenFit = false) {
        if (this.onCorrectFrame()) return true;
        // One dialog at a time. Without this a press held over a handle, or a second click while
        // the first prompt is up, stacks modals the user has to dismiss one by one.
        if (this._keyframePromptOpen) return false;

        const target = this.nearestKeyframeFrame();
        const plural = this.keyframes.length > 1 ? " nearest" : "";
        this._keyframePromptOpen = true;
        showChoice(
            `Camera fit points can only be edited on the frame they were placed on. ` +
            `Go to the${plural} fit keyframe at frame ${target} to ${verb}?`,
            {
                title: "Not On A Fit Keyframe",
                options: [
                    {label: `Go To Frame ${target}`, value: true, primary: true, color: "#1976d2"},
                    {label: "Cancel", value: false, cancel: true, color: "#757575"},
                ],
            },
        ).then((go) => {
            this._keyframePromptOpen = false;
            if (!go) {
                this.updateStatus(this.wrongFrameMessage(verb));
                setRenderOne(true);
                return;
            }
            par.frame = target;
            // No-op unless target really is a keyframe (it is, unless there are none yet, in
            // which case fitFrame already IS the frame we just moved to).
            this.activateKeyframe(target);
            // Deferred, never run here: the fit reads the LIVE camera as its starting state, and
            // the live camera is whatever the controllers produce at par.frame — which they have
            // not produced yet, because the graph has not recalculated for the frame set on the
            // line above. Fitting now would solve this keyframe's points against the camera pose
            // of the frame the user was just looking at. update() picks it up next tick.
            this._pendingFit = thenFit;
            this.updateStatus(`Moved to fit keyframe ${target}`);
            setRenderOne(true);
        });
        return false;
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

    isInteractionEnabled() { return this.enabled; }

    getInteractionIntent(e, mouseX, mouseY) {
        if (!this.enabled || !this.hasVideoGeometry()) return null;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const hit = this.pointNear(cx, cy);
        if (e.button === 2) return hit ? {kind: "click", priority: 75} : null;
        if (e.button !== 0) return null;
        if (hit) return {kind: this.onCorrectFrame() ? "drag" : "click", priority: 75, handleId: hit.id};
        return this.onCorrectFrame() && e.isPrimary !== false ? {kind: "pending", priority: 20} : null;
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
                this.removePoint(hit.id);
                return true;
            }
            return false;
        }
        if (e.button !== 0) return false;

        if (hit) {
            // Reaching for a point on the wrong frame: offer to go to the keyframe it lives on.
            // Checked here rather than ahead of the hit test, so that a press on empty video —
            // which is a pan as often as it is an add — keeps its quiet status message and never
            // raises a dialog just for panning around off-keyframe.
            if (!this.onCorrectFrame()) {
                this.offerNearestKeyframe("move them");
                return true;
            }
            this.draggingId = hit.id;
            // Grabbing is not moving: a bare click on a marker states nothing about the
            // observations and must not invalidate anything on release.
            this._dragMoved = false;
            this.beginUndo();
            return true;
        }

        // Empty video off-keyframe: refuse quietly, as before. An add here would be an
        // observation of a frame these points do not belong to, but the press is at least as
        // likely to be a pan, so it gets a status line rather than a dialog.
        if (!this.onCorrectFrame()) {
            this.updateStatus(this.wrongFrameMessage("edit"));
            setRenderOne(true);
            return false;
        }

        // The router owns this pending click and hands it to video navigation
        // once movement exceeds the shared click threshold.
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
        // The user has now placed this marker on this frame: it stops being a seed and becomes
        // an observation the solver may use.
        p.seeded = false;
        this._dragMoved = true;
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
        if (e.buttons === 0) {
            this.pendingAdd = null;
            return;
        }
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

        const [vx, vy] = this.overlayView.canvasToVideoCoordsOriginal(pending.cx, pending.cy);
        this.withUndo("Add camera fit point", () => {
            this.addPointAtVideo(vx, vy);
            this.requestFit();
        });
    }

    onMouseCancel(e) {
        // An interrupted click must never add a landmark. A point already moved
        // on screen still needs its keyframe and undo span finalized.
        if (this.pendingAdd !== null && !this.isPendingPointer(e)) return;
        this.pendingAdd = null;
        this.onMouseUp(e);
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
        // This keyframe's pixels changed, so its stored solution is a statement about the old
        // ones. Other keyframes are untouched — a 2D drag edits only this frame. Only when the
        // pixel actually moved: releasing a grabbed marker in place changed nothing.
        if (this._dragMoved) this.invalidateKeyframes("active");
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

            // Off-frame points are drawn faintly rather than hidden — see OFF_FRAME_ALPHA. The
            // 3D handles fade by the same amount, so the same point never looks live in one view
            // and faded in the other.
            const alpha = onFrame ? 1 : OFF_FRAME_ALPHA;

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
            drawFitHandle(ctx, cx, cy, p.color, label, alpha,
                this.draggingId === p.id ? "dragging" : this.interactionHover === p.id ? "hover" : "idle");
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
