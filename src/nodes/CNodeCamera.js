import {Camera, PerspectiveCamera, Raycaster, Vector3} from "three";
import {f2m, m2f} from "../utils";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {ECEFToLLAVD_radii, LLAToECEF, LLAVToECEF} from "../LLA-ECEF-ENU";
import {
    altitudeAboveSphere,
    getAzElFromPositionAndForward,
    getLocalSouthVector,
    getLocalUpVector,
    raisePoint
} from "../SphericalMath";
import {CNode3D} from "./CNode3D";
import {MV3} from "../threeUtils";
import {getCelestialDirection, getCelestialDirectionFromRaDec} from "../CelestialMath";
import {applyRefractionToDirection} from "../atmosphere/refraction";
import {currentRefractionOpts} from "../atmosphere/refractionSettings";
import {t} from "../i18n";
import {raycastLocalGround} from "../raycastGround";
import {ViewMan} from "../CViewManager";
import {viewMenuKey} from "../ViewUIBarMenus";
import {meanSeaLevelOffset} from "../EGM96Geoid";

export class CNodeCamera extends CNode3D {
    constructor(v, camera = null) {
        super(v);

        this.isCamera = true;
        this.celestialLock = null; // {type:"named", object:"Moon"} or {type:"radec", ra:hours, dec:degrees}

        // "Free Look Camera" - the user flies this camera by hand with the view's own
        // map controls, exactly as they fly the main camera. While it is on, NOTHING
        // computed is allowed to write the pose (see applyControllers and update).
        // Assigned to the backing field directly: the setter does view wiring that
        // must not run this early. Default off.
        this._freeLook = v.freeLook ?? false;
        // Registered HERE and not beside the GUI it belongs to, because
        // applyEarlyMods() below already deserializes this node — simpleDeserialize
        // walks simpleSerials as it stands at that moment, so a serial added later in
        // the constructor is silently skipped and the saved value lost. It also must
        // not depend on a menu existing: addFreeLookGUI() returns early on cut-down
        // menu setups, which would otherwise make what a sitch SAVES depend on what
        // GUI happens to be present.
        this.addSimpleSerial("freeLook");

        this.addInput("altAdjust", "altAdjust", true);

        this.startPos = v.startPos;
        this.lookAt = v.lookAt;
        this.startPosLLA = v.startPosLLA;
        this.lookAtLLA = v.lookAtLLA;
        this.switchToGroundTrackFrame = v.switchToGroundTrackFrame ?? 0;
        if (v.switchToGroundTrackEnabled && this.switchToGroundTrackFrame <= 0) {
            this.switchToGroundTrackFrame = 1;
        }
        this._groundTrackSwitchComputing = false;
        this._groundTrackSwitchRaycaster = new Raycaster();
        this._groundTrackSwitchWarned = false;
        this._groundTrackSwitchCachedFrame = null;
        this._groundTrackSwitchCachedTarget = null;
        this.addSimpleSerial("switchToGroundTrackFrame");
        this.onTerrainLoaded(() => this.clearGroundTrackSwitchCache());

        if (camera) {
            this._object = camera;
        } else {
            this._object = new PerspectiveCamera(v.fov, v.aspect, v.near, v.far);
        }

        if (v.layers !== undefined) {
            this._object.layers.mask = v.layers;
        }

        // Orthographic-mode + per-camera near-plane state. We keep the projection
        // on the PerspectiveCamera object (so every .fov/.aspect/isPerspectiveCamera
        // reader keeps working); when `orthographic` is on we override the camera's
        // updateProjectionMatrix to build an ortho matrix instead. The ortho box is
        // sized to match the perspective framing at the ground under the view centre
        // (_refreshOrthoProjection), so it scales naturally as the camera moves.
        this.orthographic = v.orthographic ?? false;
        this.nearPlane = v.nearPlane ?? v.near ?? 1;
        this._ownsNearPlane = false;             // set true when this camera adds its own Near Plane control
        this._orthoRaycaster = new Raycaster();
        this._orthoForward = new Vector3();
        this._orthoRefDistance = undefined;      // cached camera→ground distance for ortho sizing
        this._orthoCamAGL = undefined;           // cached camera height above the ground below (box clamp)
        this._orthoUpDotRadial = 1;              // cos(angle) of camera up axis vs local vertical (box clamp)
        this._orthoLastPos = null;               // movement guard so we don't re-raycast when still
        this._orthoLastDir = null;
        this._installOrthographicOverride();

//        console.log("🎥🎥🎥 " + this.id + " CREATE CAMERA " + this.id);

        this.resetCamera()

        if (this.id === "mainCamera") {
            guiMenus.view.add(this, "snapshotCamera").name(t("misc.snapshotCamera.label"))
                .tooltip(t("misc.snapshotCamera.tooltip"))
            guiMenus.view.add(this, "resetCamera").name(t("misc.resetCamera.label"))
                .tooltip(t("misc.resetCamera.tooltip"))
        }

        this.applyEarlyMods();

        if (this.id === "lookCamera") {
            this.addGroundTrackSwitchGUI();
            this.addFreeLookGUI();
        }

        this.addCameraTweaksControls();
    }



    modSerialize() {
        this.camera.updateMatrixWorld();
        const p = this.camera.position.clone()
        const v = new Vector3();
        v.setFromMatrixColumn(this.camera.matrixWorld,2);
        v.multiplyScalar(-1000)
        v.add(p)
        const posLLA = ECEFToLLAVD_radii(this.camera.position)
        const atLLA = ECEFToLLAVD_radii(v)
        const upLLA = ECEFToLLAVD_radii(this.camera.position.clone().add(this.camera.up.clone().multiplyScalar(1000)))

        return {
            ...super.modSerialize(),
            startPosLLA: [posLLA.x, posLLA.y, posLLA.z],
            lookAtLLA: [atLLA.x, atLLA.y, atLLA.z],
            upLLA: [upLLA.x, upLLA.y, upLLA.z],
            fov: this.camera.fov,
            orthographic: this.orthographic,
            nearPlane: this.nearPlane,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.startPosLLA = v.startPosLLA;
        this.lookAtLLA = v.lookAtLLA;
        this.upLLA = v.upLLA;
        this.camera.fov = v.fov;
        if (v.orthographic !== undefined) this.orthographic = v.orthographic;
        if (v.nearPlane !== undefined) this.nearPlane = v.nearPlane;
        if (this._ownsNearPlane) this.camera.near = this.nearPlane;

        this.resetCamera()

        // Rebuild the projection so a restored orthographic flag / near plane
        // takes effect immediately (per-frame update() also maintains it).
        if (this.orthographic) this._refreshOrthoProjection();
        else this.camera.updateProjectionMatrix();
    }

    // when a camera object is treated like a track
    // it can only return the current position
    // so if you want to get the position at a specific frame
    // you need to use a CNodeTrack object or similar
    getValueFrame(f) {
        return this._object.position;
    }

    resetCamera() {

        if (this.startPos !== undefined) {
            this._object.position.copy(MV3(this.startPos));
        }

        if (this.startPosLLA !== undefined) {
            this._object.position.copy(LLAVToECEF(MV3(this.startPosLLA)));
        }

        // If no explicit position was set, default to the surface at Sit origin.
        // In ECEF this prevents the camera from being at (0,0,0) = Earth's center.
        if (this.startPos === undefined && this.startPosLLA === undefined && Sit.lat !== undefined) {
            this._object.position.copy(LLAToECEF(Sit.lat, Sit.lon, 0));
        }

        if (this.upLLA !== undefined) {
            const upWorld = LLAVToECEF(MV3(this.upLLA));
            this._object.up.copy(upWorld.sub(this._object.position).normalize());
        } else {
            const localUp = getLocalUpVector(this._object.position);
            this._object.up.copy(localUp);
        }

        if (this.lookAt !== undefined) {
            this._object.lookAt(MV3(this.lookAt));
        }

        if (this.lookAtLLA !== undefined) {
            this._object.lookAt(LLAVToECEF(MV3(this.lookAtLLA)));
        }

        this.camera.updateMatrix();
        this.camera.updateMatrixWorld();
    }


    snapshotCamera() {
        this.camera.updateMatrixWorld();
        var p = this.camera.position.clone()
        const v = new Vector3();
        v.setFromMatrixColumn(this.camera.matrixWorld,2);
        v.multiplyScalar(-1000)
        v.add(p)
        this.startPosLLA = ECEFToLLAVD_radii(this.camera.position)
        this.lookAtLLA = ECEFToLLAVD_radii(v)
        this.upLLA = ECEFToLLAVD_radii(this.camera.position.clone().add(this.camera.up.clone().multiplyScalar(1000)))
    }

    addGroundTrackSwitchGUI() {
        // Lives in Camera ▸ Camera Tweaks (falls back to the Camera menu itself if
        // that permanent shell isn't present, e.g. on cut-down menu setups).
        const menu = guiMenus.cameraTweaks ?? guiMenus.camera;
        if (!menu) return;

        const controller = menu.add(
            this,
            "switchToGroundTrackFrame",
            0,
            Math.max(0, (Sit.frames ?? 1) - 1),
            1
        )
            .name("Switch to Ground Track at")
            .listen()
            .onChange(() => {
                this.switchToGroundTrackFrame = Math.round(this.switchToGroundTrackFrame);
                this.clearGroundTrackSwitchCache();
                setRenderOne(true);
            })
            .tooltip("0 disables this. Any positive frame bakes the camera's ground intersection at that frame, then aims at that point for all later frames.")
            .moveToEnd();
        this.groundTrackSwitchFrameController = controller;
        setTimeout(() => controller.moveToEnd(), 0);
    }

    clearGroundTrackSwitchCache() {
        this._groundTrackSwitchCachedFrame = null;
        this._groundTrackSwitchCachedTarget = null;
        this._groundTrackSwitchWarned = false;
    }

    // ── Free Look ───────────────────────────────────────────────────────────────
    //
    // Turning this on hands the camera to the view it is rendered in, so it flies
    // exactly like the main camera: left-drag moves the world, middle-drag orbits
    // the point under the cursor, right-drag looks around, the wheel dollies in and
    // out, and WASD walks. Three things make that true, and all three are needed:
    //
    //   1. applyControllers() below stops every computed source (Location, Heading,
    //      FOV, Tracking Wobble, ...) from writing the pose, so a hand-flown camera
    //      is not snapped back on the next node update.
    //   2. update() below suspends the other pose writers on this node for the
    //      same reason.
    //   3. CameraControls' getInteractivePTZController() reports no PTZ controller
    //      while this is on, which is what makes the gestures fall through to the
    //      plain main-camera set instead of the PTZ pan/zoom ones.
    //
    // The flown position does not just float free, though: syncFreeLookPosition()
    // publishes it back into the camera's Manual position node on every move, which is
    // what turns the mode into a way of CHOOSING a camera position — fly to where you
    // want to be, switch Free Look off, and you stay there.
    //
    // It is a property with a setter (rather than a plain field) so the GUI, a
    // deserialized save and any API caller all go through the same wiring.
    get freeLook() {
        return this._freeLook;
    }

    set freeLook(value) {
        const on = !!value;
        const changed = (on !== this._freeLook);

        // Leaving Free Look locks in where the user flew to. The POSITION is already
        // published (syncFreeLookPosition runs on every move), so the final call here
        // only catches a last movement in the same tick. The ORIENTATION is not
        // published anywhere, and the Heading source is about to take the camera back,
        // so hand it to the manual PTZ angles — a Heading of "Manual" then keeps
        // looking where the user left it instead of spinning back. For any other
        // Heading source this changes nothing that is visible: keeping the PTZ angles
        // warm against the live camera is exactly what the custom sitch's
        // postApplyControllers already does whenever PTZ is not the thing driving.
        if (changed && !on) {
            this.syncFreeLookPosition();
            NodeMan.get("ptzAngles", false)?.syncFromCamera(this.camera);
        }

        this._freeLook = on;

        // A fresh session must publish its first move even if the camera happens to be
        // exactly where the last one ended.
        if (changed && on) this._freeLookSyncedPos = null;

        this._freeLookWired = false;
        this.wireFreeLookView();

        if (changed) setRenderOne(true);
    }

    // Give the view whatever Free Look needs from it, and record whether the view was
    // there to give it to.
    //
    // Most look views already carry map controls — SituationSetup adds them unless the
    // sitch asked for noOrbitControls, as the Gimbal pod views do — so this only makes
    // them for those. Once made we keep them switched off whenever Free Look is off, so
    // turning the mode on and back off leaves such a view navigating exactly as it did
    // before.
    //
    // This can legitimately run before there is a view: restoring a saved sitch drives
    // freeLook through the setter while this camera node is still being constructed, and
    // its view is not built until later in SituationSetup. update() retries until it
    // lands, rather than leaving it to a subsequent deserialize pass — depending on one
    // of those is what stopped freeLook persisting at all.
    wireFreeLookView() {
        const view = this.getRenderingView();
        if (!view) return false;

        if (this._freeLook && !view.controls) {
            view.addOrbitControls();
            this._freeLookAddedControls = true;
        }
        if (this._freeLookAddedControls && view.controls) {
            view.controls.enabled = this._freeLook;
        }

        this._freeLookWired = true;
        return true;
    }

    // Publish the hand-flown position into the camera's Manual position node. Called
    // once per rendered frame from CameraMapControls.update(), which is downstream of
    // every gesture — drag, orbit, pan, wheel, WASD, touch — so one call site covers
    // them all, and it is the same place (and the same frequency) at which the WASD
    // walker already writes that node.
    //
    // Two things follow from the write. The Location folder's Lat/Lon/Alt track the
    // flight, so you can read off where you are; and CCustomManager's
    // PositionLLA.onChange listener promotes the Location source to Manual, so
    // switching Free Look off leaves the camera where you flew it rather than snapping
    // back to whatever was driving it before.
    //
    // Altitude follows the WASD walker's rule: written as MSL for an absolute-altitude
    // node, and left alone for an AGL one — there "N metres above the ground" is the
    // user's standing instruction and outranks the height they happened to fly at, so
    // only the horizontal move is kept.
    syncFreeLookPosition() {
        if (!this._freeLook) return;

        const pos = this.camera.position;
        // Sub-millimetre moves are float noise, not navigation; skipping them keeps a
        // parked free-look camera from cascading a recalculate every frame.
        if (this._freeLookSyncedPos && this._freeLookSyncedPos.distanceToSquared(pos) < 1e-6) return;

        const fixedCamera = NodeMan.get("fixedCameraPosition", false);
        if (!fixedCamera) return;

        (this._freeLookSyncedPos ??= new Vector3()).copy(pos);

        if (fixedCamera.agl) {
            fixedCamera.setFromECEF(pos);
        } else {
            const lla = ECEFToLLAVD_radii(pos);
            // setLLA wants MSL; ECEFToLLAVD_radii returns HAE (h = H + N).
            fixedCamera.setLLA(lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y));
        }
    }

    // The view this camera is rendered in, if any. There is normally exactly one.
    getRenderingView() {
        let found = null;
        ViewMan.iterate((id, view) => {
            if (!found && view.cameraNode === this && view.addOrbitControls !== undefined) {
                found = view;
            }
        });
        return found;
    }

    addFreeLookGUI() {
        // Lives in Camera ▸ Camera Tweaks alongside the other per-camera mode
        // switches (Orthographic, the ground-track switch), with the same fallback
        // to the Camera menu itself on cut-down menu setups.
        const menu = guiMenus.cameraTweaks ?? guiMenus.camera;
        if (!menu) return;

        // First in the folder, because it overrides everything else in the Camera
        // menu: while it is on, the Location / Heading / FOV sources are suspended.
        // Also mirrored into the look view's own header menu (src/ViewUIBarMenus.js),
        // which is where you want it when you are flying the camera and not looking
        // at the menu bar. shareAs comes last: registration captures the source's
        // onChange as it stands, so it has to follow the whole naming chain.
        this.freeLookController = menu.add(this, "freeLook")
            .name(t("misc.freeLookCamera.label"))
            .listen()
            .tooltip(t("misc.freeLookCamera.tooltip"))
            .moveToFirst()
            .shareAs(viewMenuKey("lookView", "freeLook"));
        setTimeout(() => this.freeLookController.moveToFirst(), 0);

        // (freeLook is serialized — registered in the constructor, see the note there.
        // The pose itself already round-trips: modSerialize writes the camera's CURRENT
        // position and heading as startPosLLA/lookAtLLA, i.e. where the user left it.)
    }



    get camera() {
        return this._object
    }

    // Camera Tweaks: "<Main|Look> View Orthographic" checkbox for both view
    // cameras, plus a "Main Near Plane" slider on the main camera (the look
    // camera's near plane is owned by its PTZ controller, so we don't duplicate
    // it here). Lives in Camera ▸ Camera Tweaks.
    addCameraTweaksControls() {
        if (this.id !== "mainCamera" && this.id !== "lookCamera") return;
        const menu = guiMenus.cameraTweaks ?? guiMenus.camera;
        if (!menu) return;
        const label = (this.id === "lookCamera") ? "Look" : "Main";

        this.orthoController = menu.add(this, "orthographic")
            .name(label + " View Orthographic")
            .listen()
            .tooltip("Render this view with an orthographic (parallel) projection instead of perspective. "
                + "The ortho size auto-matches the current framing at the ground and scales as the camera moves.")
            .onChange(() => {
                this._orthoRefDistance = undefined; // force a fresh size
                if (this.orthographic) this._refreshOrthoProjection();
                else this._object.updateProjectionMatrix();
                setRenderOne(true);
            });

        if (this.id === "mainCamera") {
            this._ownsNearPlane = true;
            this.nearPlaneController = menu.add(this, "nearPlane", 0.1, 2000, 0.1)
                .name(label + " Near Plane (m)")
                .listen()
                .tooltip("Near clipping-plane distance for this camera. Increase to slice through 3D buildings / "
                    + "terrain in front of the camera; especially useful in orthographic mode.")
                .onChange(() => {
                    this._object.near = this.nearPlane;
                    this._object.updateProjectionMatrix();
                    setRenderOne(true);
                });
        }
    }

    // Replace the camera's updateProjectionMatrix so it builds an orthographic
    // matrix while `orthographic` is on, and the normal perspective matrix
    // otherwise. Done as an instance override (not a camera swap) so all the
    // .fov/.aspect/isPerspectiveCamera readers throughout the app keep working.
    _installOrthographicOverride() {
        const cam = this._object;
        if (cam.__sitrecOrthoInstalled) return;
        const perspectiveUpdate = cam.updateProjectionMatrix.bind(cam);
        cam.updateProjectionMatrix = () => {
            // __sitrecOrthoMatrixActive tells the Raycaster.setFromCamera patch
            // (threeExt.js) that this camera's CURRENT matrix is orthographic,
            // so screen rays must be built as parallel rays. Kept in lockstep
            // with the matrix here — the only place either kind is installed.
            if (this.orthographic) {
                this._updateOrthographicProjectionMatrix();
                cam.__sitrecOrthoMatrixActive = true;
            } else {
                cam.__sitrecOrthoMatrixActive = false;
                perspectiveUpdate();
            }
        };
        cam.__sitrecOrthoInstalled = true;
    }

    // Build the orthographic projection matrix from the current perspective
    // parameters: an ortho box whose half-height equals what the perspective
    // frustum spans at the reference distance (ground under the view centre),
    // so toggling ortho is visually seamless and scales with camera distance.
    _updateOrthographicProjectionMatrix() {
        const cam = this._object;
        const d = this._orthoRefDistance ?? 1000;
        let halfH = Math.tan((cam.fov ?? 30) * Math.PI / 360) * d / (cam.zoom || 1);
        // Clamp the box so its lower edge can't sink below the ground beneath the
        // camera. halfH is sized to match the perspective framing at the screen-
        // centre ground distance `d`; on a shallow/grazing view d far exceeds the
        // camera's height, so that half-height would drop the box's bottom edge
        // kilometres underground — and the bottom of the screen then samples terrain
        // backfaces/skirts at grazing incidence as vertical streaks. The box spans
        // ±halfH along the camera's up axis, so its lower edge sits halfH·(up·localUp)
        // below the camera; cap halfH at camAGL/(up·localUp) to hold it at/above the
        // surface. up·localUp → 0 for a top-down view, so the clamp never bites there.
        const agl = this._orthoCamAGL;
        const upDotRadial = this._orthoUpDotRadial;
        if (agl !== undefined && upDotRadial > 1e-3) {
            halfH = Math.min(halfH, agl / upDotRadial);
        }
        const halfW = halfH * (cam.aspect || 1);
        // Orthographic depth is LINEAR: three.js's log-depth shader falls back to
        // gl_FragCoord.z for a non-perspective matrix, so the camera's perspective
        // far plane (~1e9 m) would leave only ~hundreds of metres of depth
        // resolution → severe z-fighting (torn roofs). Use a TIGHT range scaled to
        // the reference distance instead — a window ~8× the camera→ground distance
        // deep, which comfortably contains the visible scene while giving sub-mm
        // depth precision. `near` stays the user's Near Plane so it still slices.
        const near = cam.near;
        const far = near + 8 * d;
        cam.projectionMatrix.makeOrthographic(-halfW, halfW, halfH, -halfH, near, far);
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    // Refresh the ortho reference distance (camera → ground under the view centre)
    // then rebuild the ortho matrix. Cheap movement guard avoids re-raycasting
    // every call when the camera is still.
    _refreshOrthoProjection() {
        const cam = this._object;
        cam.getWorldDirection(this._orthoForward);
        const moved = !this._orthoLastPos
            || this._orthoLastPos.distanceToSquared(cam.position) > 1e-4
            || this._orthoLastDir.dot(this._orthoForward) < 0.99999995
            || this._orthoRefDistance === undefined;
        if (moved) {
            // Terrain lives on the camera's render layers (not necessarily layer 0),
            // and a fresh Raycaster only tests layer 0 — so widen the mask to the
            // camera's before any ground query, otherwise the terrain mesh is missed
            // and every distance silently falls back to the ellipsoid horizon.
            this._orthoRaycaster.layers.mask = cam.layers.mask;
            this._orthoRaycaster.set(cam.position, this._orthoForward);
            // Measure to the ACTUAL ground under the screen centre — the real
            // terrain mesh AND the Google 3D-tile surface (pass the camera so
            // raycastLocalGround includes the tiles). isTerrain===true marks a
            // real surface hit (terrain or tile); the ellipsoid fallback
            // (isTerrain false) is a smooth sphere that at grazing tilts sits
            // far from the real ground, so we never size the ortho box from it —
            // that keeps buildings near the screen centre at ~perspective scale.
            const hit = raycastLocalGround(this._orthoRaycaster, cam);
            if (hit && hit.isTerrain) {
                this._orthoRefDistance = cam.position.distanceTo(hit.point);
            } else if (this._orthoRefDistance === undefined) {
                // No real ground yet (sky, or tiles not streamed in): provisional
                // size until a real hit is available on a later frame.
                this._orthoRefDistance = hit ? cam.position.distanceTo(hit.point) : 1000;
            }

            // Camera height above the ground directly below it, plus how vertical the
            // camera's up axis is — both feed the box-underground clamp in
            // _updateOrthographicProjectionMatrix. raycastLocalGround falls back to
            // the ellipsoid (≈ sea level) when there's no terrain below, which is the
            // right AGL proxy over ocean.
            const localUp = cam.position.clone().normalize();
            this._orthoRaycaster.set(cam.position, localUp.clone().multiplyScalar(-1));
            const below = raycastLocalGround(this._orthoRaycaster, cam);
            this._orthoCamAGL = below ? cam.position.distanceTo(below.point) : undefined;
            this._orthoUpDotRadial = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1).dot(localUp);

            (this._orthoLastPos ??= new Vector3()).copy(cam.position);
            (this._orthoLastDir ??= new Vector3()).copy(this._orthoForward);
        }
        cam.updateProjectionMatrix();
    }

    // Free Look suspends every computed source that would otherwise write this
    // camera's pose - Location, Heading, FOV, Tracking Wobble, all of them - so the
    // hand-flown pose survives the frame it was set in. Gating here rather than on
    // each controller's own `enabled` flag deliberately: those flags belong to the
    // source switches, which turn them on and off as the choice changes, so a
    // second owner would just fight them.
    applyControllers(f, depth = 0) {
        if (this.freeLook) return;
        super.applyControllers(f, depth);
    }

    update(f) {
        super.update(f);

        // Free Look restored from a save reaches the setter before this camera has a
        // view to wire — see wireFreeLookView(). Retry until it lands; one boolean test
        // a frame afterwards.
        if (this._freeLook && !this._freeLookWired) this.wireFreeLookView();

        // The pose writers below are suspended by Free Look for the same reason the
        // controllers are. altAdjust in particular: it RAISES the current position
        // rather than setting one, so with no controller re-seeding the position
        // each frame it would compound, and the camera would climb away.
        const poseIsComputed = !this.freeLook;

        if (poseIsComputed && this.in.altAdjust !== undefined) {
            // raise or lower the position
            this.camera.position.copy(raisePoint(this.camera.position, f2m(this.in.altAdjust.v())))
        }

        // Celestial lock: update PTZ angles to track the locked object.
        // We ONLY set ptzController.az/el here — we do NOT call setFromDirection()
        // or camera.lookAt(), because CNodeLOSFromCamera calls cameraNode.update()
        // from within getValueFrame(), causing infinite recursion if we modify the
        // camera or trigger any node evaluation from here.
        if (poseIsComputed && this.celestialLock) {
            let dir = null;
            if (this.celestialLock.type === "named") {
                dir = getCelestialDirection(this.celestialLock.object, GlobalDateTimeNode.dateNow);
            } else if (this.celestialLock.type === "radec") {
                const raRad = this.celestialLock.ra * (Math.PI / 12);
                const decRad = this.celestialLock.dec * (Math.PI / 180);
                dir = getCelestialDirectionFromRaDec(raRad, decRad, GlobalDateTimeNode.dateNow);
            }
            if (dir) {
                // getCelestialDirection returns the GEOMETRIC direction, but the sky is
                // DRAWN refracted — every body is bent toward the observer's zenith before
                // it is rendered. Locking on the geometric direction therefore aimed the
                // camera just off the body it was locked to, by the full refraction amount
                // (~0.48° at the horizon from the ground, and nothing at the zenith). Bend
                // the lock direction the same way, through the same routine the satellites
                // use, so the camera and the drawn body stay together.
                //
                // The bend depends on observer HEIGHT as well as apparent altitude, and
                // applyRefractionToDirection derives that from the camera's own ECEF
                // position — so a camera in orbit correctly gets almost no bend while one
                // on the ground gets the full amount.
                dir = applyRefractionToDirection(dir, this.camera.position, currentRefractionOpts());
                // Compute az/el from the celestial direction without modifying the camera
                const fakeTarget = this.camera.position.clone().add(dir.multiplyScalar(1000));
                const toTarget = fakeTarget.clone().sub(this.camera.position).normalize();
                const [az, el] = getAzElFromPositionAndForward(this.camera.position, toTarget);
                const ptzController = NodeMan.get("ptzAngles", false);
                if (ptzController) {
                    ptzController.az = az;
                    ptzController.el = el;
                }
            }
        }

        // The frame-range refresh is GUI-only, so it runs either way; the aim itself
        // is a pose write, so Free Look suspends it.
        this.updateGroundTrackSwitchFrameRange();
        if (poseIsComputed) this.applyGroundTrackSwitch(f);

        // Maintain the per-camera near plane (main camera owns it; the look camera's
        // near is driven by its PTZ controller) and the orthographic projection.
        // Runs last so the camera is at its final render pose (post controllers /
        // altAdjust / ground-track-switch).
        if (this._ownsNearPlane && this.camera.near !== this.nearPlane) {
            // Something (e.g. ground-track-switch restore) drifted near; reassert it.
            this.camera.near = this.nearPlane;
            if (!this.orthographic) this.camera.updateProjectionMatrix();
        }
        if (this.orthographic) {
            this._refreshOrthoProjection();
        }
    }

    updateGroundTrackSwitchFrameRange() {
        const controller = this.groundTrackSwitchFrameController;
        if (!controller || Sit.frames === undefined) return;

        const maxFrame = Math.max(0, Sit.frames - 1);
        if (controller._max !== maxFrame) {
            controller._max = maxFrame;
            // Do NOT clamp this.switchToGroundTrackFrame here. Sit.frames can
            // transiently shrink during load (e.g. before the video decode
            // reports its final frame count), and overwriting the stored value
            // would permanently destroy the user's setting — which then gets
            // serialized as the clamped value (typically 0). The stored
            // property is the user's intent; it is clamped safely at use-time
            // in getGroundTrackSwitchFrame(). Only the GUI display range updates.
            controller.updateDisplay();
        }
    }

    getGroundTrackSwitchFrame() {
        return Math.max(0, Math.min(Math.round(this.switchToGroundTrackFrame), Math.max(0, (Sit.frames ?? 1) - 1)));
    }

    applyGroundTrackSwitch(f) {
        if (this._groundTrackSwitchComputing) return;

        const switchFrame = this.getGroundTrackSwitchFrame();
        if (switchFrame <= 0 || f < switchFrame) return;

        const target = this.getGroundTrackSwitchTarget(switchFrame);
        if (!target) return;

        this.camera.up.copy(this.getUpVector(this.camera.position));
        this.camera.lookAt(target);
        this.camera.updateMatrix();
        this.camera.updateMatrixWorld(true);
    }

    getGroundTrackSwitchTarget(switchFrame) {
        if (this._groundTrackSwitchCachedFrame === switchFrame) {
            return this._groundTrackSwitchCachedTarget?.clone() ?? null;
        }

        const camera = this.camera;
        const savedPosition = camera.position.clone();
        const savedQuaternion = camera.quaternion.clone();
        const savedUp = camera.up.clone();
        const savedFov = camera.fov;
        const savedNear = camera.near;
        const savedFar = camera.far;

        this._groundTrackSwitchComputing = true;
        // Pose PROBE: this controller pass only measures where the clean
        // boresight meets the ground. Noise controllers (Tracking Wobble)
        // check this flag and skip, so the locked ground point — cached by
        // switchFrame alone — is independent of wobble params/seed.
        this._poseProbe = true;
        try {
            this.applyControllers(switchFrame);
            if (this.in.altAdjust !== undefined) {
                camera.position.copy(raisePoint(camera.position, f2m(this.in.altAdjust.v())));
            }

            camera.updateMatrix();
            camera.updateMatrixWorld(true);

            this._groundTrackSwitchRaycaster.ray.origin.copy(camera.position);
            camera.getWorldDirection(this._groundTrackSwitchRaycaster.ray.direction);
            this._groundTrackSwitchRaycaster.near = 0;
            this._groundTrackSwitchRaycaster.far = Infinity;

            const hit = raycastLocalGround(this._groundTrackSwitchRaycaster);
            if (!hit && !this._groundTrackSwitchWarned) {
                console.warn(`Camera ground track switch could not find a ground intersection at frame ${switchFrame}.`);
                this._groundTrackSwitchWarned = true;
            }
            this._groundTrackSwitchCachedFrame = switchFrame;
            this._groundTrackSwitchCachedTarget = hit?.point.clone() ?? null;
            return this._groundTrackSwitchCachedTarget?.clone() ?? null;
        } finally {
            camera.position.copy(savedPosition);
            camera.quaternion.copy(savedQuaternion);
            camera.up.copy(savedUp);
            camera.fov = savedFov;
            camera.near = savedNear;
            camera.far = savedFar;
            camera.updateProjectionMatrix();
            camera.updateMatrix();
            camera.updateMatrixWorld(true);
            this.syncUIPosition();
            this._groundTrackSwitchComputing = false;
            this._poseProbe = false;
        }
    }

    // The "Camera Heading" switch and its "Celestial Lock" controller, if this
    // sitch has them (the custom sitch does, built in CustomManagerSetup). When
    // present we drive the lock through that menu mechanism so the GUI ("Camera
    // Heading" → Celestial Lock) reflects reality, instead of the standalone
    // ptzAngles hack below — which silently stayed on "Manual".
    celestialMenu() {
        const sw = NodeMan.get("CameraLOSController", false);
        const controller = NodeMan.get("celestialController", false);
        if (sw && controller && sw.inputs["Celestial Lock"] === controller) {
            return { sw, controller };
        }
        return null;
    }

    lockOnObject(objectName) {
        const dir = getCelestialDirection(objectName, GlobalDateTimeNode.dateNow);
        if (!dir) return false;
        const menu = this.celestialMenu();
        if (menu) {
            this.celestialLock = null;
            menu.controller.setLockObject(objectName);
            menu.sw.selectOption("Celestial Lock");
        } else {
            // Fallback for sitches without the menu: drive PTZ angles each frame.
            this.celestialLock = { type: "named", object: objectName };
            this.setFromDirection(dir, true);
        }
        return true;
    }

    lockOnRaDec(ra, dec) {
        const menu = this.celestialMenu();
        if (menu) {
            this.celestialLock = null;
            menu.controller.setLockRaDec(ra, dec);
            menu.sw.selectOption("Celestial Lock");
        } else {
            this.celestialLock = { type: "radec", ra, dec };
            const raRad = ra * (Math.PI / 12);
            const decRad = dec * (Math.PI / 180);
            const dir = getCelestialDirectionFromRaDec(raRad, decRad, GlobalDateTimeNode.dateNow);
            this.setFromDirection(dir, true);
        }
        return true;
    }

    unlockCelestial() {
        this.celestialLock = null;
        const menu = this.celestialMenu();
        if (menu && menu.sw.choice === "Celestial Lock") {
            // Leave the camera pointing where it is, on the manual-angle path.
            menu.sw.selectOption("Manual");
        }
    }


    updateUIPosition() {
        // propagate the camera position values value to the camera position UI (if there is one)
        if (NodeMan.exists("cameraLat")) {
            const LLA = ECEFToLLAVD_radii(this.camera.position)
            NodeMan.get("cameraLat").value = LLA.x
            NodeMan.get("cameraLon").value = LLA.y
            NodeMan.get("cameraAlt").value = m2f(LLA.z)
        }
    }


    syncUIPosition() {
        // propogate the camera position values value to the camera position UI (if there is one)
        // and then recalculate dependent nodes
        if (NodeMan.exists("cameraLat")) {
            this.updateUIPosition();

            // we should not even need this, UI changes will trigger a recalculation cascade
            // if they change
            //    NodeMan.get("cameraLat").recalculateCascade() // manual update
        }
    }


    goToPoint(point, above = 200, back = 20) {
        const altitude = altitudeAboveSphere(point);
        console.log("🎥🎥🎥 goToPoint altitude = " + altitude)


        // get the local up vector at the track point
        const up = getLocalUpVector(point);
        // and south vector
        const south = getLocalSouthVector(point);
        // make a point 200m above, and 20m south
        const newCameraPos = point.clone().add(up.clone().multiplyScalar(above)).add(south.clone().multiplyScalar(back));

        const newCameraPosAltitude = altitudeAboveSphere(newCameraPos);
        console.log("🎥🎥🎥 newCameraPos altitude = " + newCameraPosAltitude)

        // set the position to the target
        this.camera.position.copy(newCameraPos);
        // Set up to local up
        this.camera.up.copy(up);
        // and look at the target point
        this.camera.lookAt(point);
        this.camera.updateMatrixWorld(true);

        if (NodeMan.exists("terrainUI")) {
            NodeMan.get("terrainUI").requestSubdivisionPass();
        }

        setRenderOne(true);
    }


    setFromRaDec(ra, dec) {
        // set the camera orientation based on Right Ascension and Declination
        // ra is in hours, dec is in degrees
        // convert ra to radians
        const raRad = ra * (Math.PI / 12); // 1 hour = π/12 radians
        const decRad = dec * (Math.PI / 180); // degrees to radians


        const dateNow = GlobalDateTimeNode.dateNow;

        const dir = getCelestialDirectionFromRaDec(raRad, decRad, dateNow);
        this.setFromDirection(dir);

    }

    setFromDirection(dir, fromLock = false) {
        // If this is a manual point-at (not from the lock update loop), clear any active lock
        if (!fromLock) {
            this.celestialLock = null;
            // If a menu-driven Celestial Lock is active, drop back to "Manual"
            // so this one-shot point actually holds (otherwise the lock controller
            // would re-point the camera on the next frame).
            const menu = this.celestialMenu();
            if (menu && menu.sw.choice === "Celestial Lock") {
                menu.sw.selectOption("Manual");
            }
        }

        const target = this.camera.position.clone().add(dir.multiplyScalar(1000)); // 1000m away in the direction of the celestial body
        this.camera.lookAt(target);
        this.camera.updateMatrixWorld();

        // FIXED: Use camera.getWorldDirection() which correctly negates Z for cameras
        const fwd = new Vector3();
        this.camera.getWorldDirection(fwd);
        const [az, el] = getAzElFromPositionAndForward(this.camera.position, fwd);

        // get the PTZ Controller and set the az/el
        const ptzController = NodeMan.get("ptzAngles", false);
        if (ptzController) {
            ptzController.az = az;
            ptzController.el = el;
            // Only cascade for one-shot pointing (user/API action).
            // During the per-frame lock update, the PTZ controller's apply()
            // will read these values naturally — cascading here would cause
            // infinite recursion via dependent nodes (e.g. CNodeLOSFromCamera)
            // that re-evaluate the camera.
            if (!fromLock) {
                ptzController.recalculateCascade();
            }
        } else {
            console.warn("CNodeCamera:setFromRaDec No PTZ Controller found to set az/el for camera " + this.id);
        }
    }

// set the camera orientation based on a named celestial object
    // e.g. "Sun", "Moon", "Mars"
    setFromNamedObject(objectName) {
        const dir = getCelestialDirection(objectName, GlobalDateTimeNode.dateNow);
        if (!dir) {
            console.warn("CNodeCamera:setFromNamedObject No direction found for object " + objectName);
            return false;
        }
        this.setFromDirection(dir);
        return true;
    }


}

// given a camera object that's either:
//  - a Three.js Camera
//  - a CNodeCamera object
//  - the name of a CNodeCamera object
// then return a CNodeCamera object, creating one if needed ot wrap the Camera
export function getCameraNode(cam) {
    var cameraNode;
    if (cam instanceof Camera) {
        // It's a THREE.JS Camaera, so encapsulate it in a CNodeCamera
        cameraNode = new CNodeCamera("cameraNode",cam)
    } else {
        cameraNode = NodeMan.get(cam) // this handles disambiguating Nodes and Node Names.
        //assert(cameraNode instanceof CNodeCamera, "CNodeView3D ("+this.id+") needs a camera node")
    }
    return cameraNode;
}
