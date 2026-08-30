/**
 * Mouse / pointer interaction and selection methods for CNodeView3D.
 *
 * Split out of CNodeView3D.js to keep the view node focused on rendering and
 * lifecycle. Covers:
 * - Mouse up/down/move drag modes and camera/orbit scrubbing hand-offs.
 * - Track segment hit-testing (checkTrackSegments, findClosestTrack).
 * - Celestial body hit-testing and menu (showCelestialObjectMenu,
 *   findClosestCelestialObject).
 * - Context menu + per-track menu dispatch (onContextMenu, showTrackMenu).
 *
 * Installed on CNodeView3D.prototype via Object.assign (see CNodeView3D.js).
 */

import {
    CustomManager,
    GlobalDateTimeNode,
    Globals,
    NodeMan,
    setRenderOne,
    Sit,
    Synth3DManager,
    TrackManager,
} from "../Globals";
import {Sphere, Vector3} from "three";
import {par} from "../par";
import {DRAG, getMousePosition, screenToNDC} from "../mouseMoveView";
import {mouseInViewOnly, renderedRect, withDisplayedCamera} from "../ViewUtils";
import {DebugArrowAB} from "../threeExt";
import {CNode3DObject} from "./CNode3DObject";
import {FeatureManager} from "../CFeatureManager";
import {wgs84} from "../LLA-ECEF-ENU";
import {intersectSphere2, V3} from "../threeUtils";
import {GlobalScene, LocalFrame} from "../LocalFrame";
import {ViewMan} from "../CViewManager";
import {earthCenterECEF, XYZ2EA, XYZJ2PR} from "../SphericalMath";
import {isKeyHeld} from "../KeyBoardHandler";
import {glareSphere, targetSphere} from "../JetStuffVars";
import {jetPitchFromFrame} from "../JetUtils";
import {t} from "../i18n";
import {importADSBTraceByHex} from "../ADSBTraceFetch";
import {applyAnnualAberration, raDec2Celestial} from "../CelestialMath";
import {applyRefractionECI, refractionUniforms, refractionOptsFromUniforms} from "../atmosphere/refraction";
import {findRootTrack} from "../FindRootTrack";
import {raycastLocalGround} from "../raycastGround";
// NOTE: ChangedPR / UIChangedAz intentionally NOT imported. They are used only
// inside the legacy "GIMBAL SPECIFIC, NOT USED" dragMode>0 code path below.
// Importing from ../JetStuff creates a circular dependency
// (JetStuff -> CNodeView3D -> CNodeView3DMouse -> JetStuff) that webpack flags
// as an error. If that code path is ever revived, either move ChangedPR /
// UIChangedAz to a non-cyclic module or use a lazy require at call site.

export const mouseMethods = {
    // Raycast the terrain (with a globe-sphere fallback) and snap
    // cursorSprite.position + controls.target to the hit point. Honours focus
    // tracks the same way the old per-mousemove path did. Used by onMouseMove
    // (only when something needs continuous updates) and onMouseDown (so every
    // click sees a fresh cursor position).
    // Wrapper: hold the camera in the projection the view is actually RENDERED with for the
    // duration of the pick, then restore.
    //
    // This used to apply only the display-only lookAt (Render Camera Use Traverse Track), which
    // is one of the EIGHT things prepareCameraForLOD applies to turn the stored camera into the
    // displayed one. The others are camera.zoom from the videoZoom node, aspect from the pane,
    // the look view's fovCoverage widening, Match Video Aspect's fov/aspect rewrite, the video
    // pan's off-centre frustum, y-compression, and the camera-tweak offsets. The video ones bite
    // exactly when the user zooms or pans the video, and the pan and y-compress terms are why a
    // rebuild cannot substitute: they are written straight into projectionMatrix.elements[8]/[9]
    // and [5], which updateProjectionMatrix() will never reproduce. With any of them active the
    // ray was cast through a projection the user was never shown, so the cursor — and everything
    // reading it: the V/B measure arrow, C/X position snapping, the orbit pivot, focus-track
    // snapping — landed away from the pointer.
    //
    // withDisplayedCamera is prepareCameraForLOD/restoreCameraAfterLOD, which applies all eight.
    // It is re-entrant, and it subsumes the lookAt this used to do on its own.
    _refreshCursorFromMouse(mouseRay, options = {}) {
        return withDisplayedCamera(this, () => this._refreshCursorFromMouseInner(mouseRay, options));
    },

    _refreshCursorFromMouseInner(mouseRay, options = {}) {
        this.raycaster.setFromCamera(mouseRay, this.camera);

        // Pass the camera so raycastLocalGround also considers Google 3D-tile
        // buildings (on the MAIN/LOOK layers) — the orbit/pan pivot then lands
        // on a rooftop under the cursor instead of the terrain behind it.
        const hit = raycastLocalGround(this.raycaster, this.camera);
        let target = hit?.point;
        let targetIsTerrain = hit?.isTerrain ?? false;

        const focusTrackActive = options.focusTrackActive
            ?? (this.focusTrackName !== "default" && NodeMan.exists(this.focusTrackName));
        let scrubbedFocusTrack = false;

        if (focusTrackActive) {
            const focusTrackNode = NodeMan.get(this.focusTrackName);
            const closestFrame = focusTrackNode.closestFrameToRay(this.raycaster.ray);
            target = focusTrackNode.p(closestFrame);
            targetIsTerrain = false;

            // Holding command/windows scrubs along the track.
            if (isKeyHeld("meta")) {
                par.frame = closestFrame;
                scrubbedFocusTrack = true;
                setRenderOne(true);
            }
        }

        if (target === undefined) return;

        this.cursorSprite.position.copy(target);

        if (this.controls && (!focusTrackActive || scrubbedFocusTrack)) {
            this.controls.target = target;
            this.controls.targetIsTerrain = targetIsTerrain;
        }

        if (this.showLOSArrow) {
            DebugArrowAB("LOS from Mouse", this.camera.position, target, 0xffff00, true, GlobalScene, 0);
        }

        setRenderOne(true);
    },

    // Coalesce per-pointermove cursor refreshes to one per animation frame.
    // Browsers dispatch pointermove at up to ~120 Hz; we don't need to raycast
    // the terrain that often — the cursor only matters for the next render,
    // which happens at rAF cadence anyway. Per-event work in onMouseMove
    // becomes "record the latest position + arm rAF"; the actual raycast runs
    // once per frame using the freshest mouse position read out of
    // mouseMoveView at fire time. Gate conditions (visible/camera/in-view,
    // focusTrack, position-key-held, showLOSArrow) are re-evaluated at fire
    // time in case the user released the key or the view changed state
    // between the schedule and the rAF tick.
    //
    // Only the onMouseMove path uses this. mouseDown / wheel / keydown
    // synchronous callers still hit _refreshCursorFromMouse directly because
    // they need a fresh result *before* their own logic continues (orbit
    // pivot, zoom anchor, position-LLA tap).
    _scheduleDeferredCursorRefresh() {
        if (this._cursorRefreshRafId !== undefined) return;
        this._cursorRefreshRafId = requestAnimationFrame(() => {
            this._cursorRefreshRafId = undefined;
            if (!this.visible || !this.camera || !this.mouseEnabled) return;
            const focusTrackActive =
                this.focusTrackName !== "default" && NodeMan.exists(this.focusTrackName);
            const positionKeyHeld =
                isKeyHeld('c') || isKeyHeld('x')
                || isKeyHeld('v') || isKeyHeld('b');
            if (!this.showLOSArrow && !focusTrackActive && !positionKeyHeld) return;
            const {x, y} = getMousePosition();
            if (!mouseInViewOnly(this, x, y)) return;
            this._refreshCursorFromMouse(screenToNDC(this, x, y), { focusTrackActive });
        });
    },

    onMouseUp(event, mouseX, mouseY) {
        if (!this.mouseEnabled) return;
        // A click that started on a live-traffic aircraft and never turned into a
        // drag promotes that aircraft to a real track. Resolved on mouse UP, not
        // down, precisely so the press that begins a camera orbit is not stolen.
        this._completeTrafficClick(mouseX, mouseY);
        this.dragMode = DRAG.NONE;
        this.mouseDown = false;
//        console.log("Mouse Down = "+this.mouseDown+ " Drag mode = "+this.dragMode)
    },

    // ── Live ADS-B traffic: click an aircraft to promote it to a track ───────
    //
    // The traffic layer is reached through NodeMan rather than an import, and
    // that is deliberate: it is lazy-loaded as its own webpack chunk, so a static
    // import here would pull it back into the main bundle for every user whether
    // or not they ever switch the layer on. Absent layer, absent node, no cost.

    _trafficLayer() {
        return NodeMan.exists("ADSBLiveTraffic") ? NodeMan.get("ADSBLiveTraffic") : null;
    },

    /**
     * Remember an aircraft under the press, if there is one.
     *
     * Nothing is consumed here and the click is not claimed — a press on an
     * aircraft must still be able to become a camera orbit, because the aircraft
     * are scattered across the whole view and demanding the user find empty sky
     * to rotate from would make the layer hostile to use.
     */
    _beginTrafficClick(mouseX, mouseY) {
        this._trafficClick = null;

        // The ADS-B layer first: an aircraft promotes to a full track, which is a
        // more useful outcome than an info line, so it wins a tie.
        const traffic = this._trafficLayer();
        if (traffic?.polling) {
            const hit = traffic.findAircraftAtScreen(this, mouseX, mouseY);
            if (hit) {
                this._trafficClick = {kind: 'aircraft', hex: hit.hex, aircraft: hit.aircraft,
                    x: mouseX, y: mouseY};
                return;
            }
        }

        // Then the generic live-feed layers. Found through NodeMan by id prefix
        // rather than by importing the registry, so this file stays free of the
        // lazy chunk — an import here would pull it into the main bundle for
        // every user whether or not they ever switch a feed on.
        let best = null;
        NodeMan.iterate((id, node) => {
            if (!id.startsWith("LiveFeed_")) return;
            if (typeof node.findMarkerAtScreen !== "function") return;
            const hit = node.findMarkerAtScreen(this, mouseX, mouseY);
            if (hit && (!best || hit.distancePx < best.distancePx)) best = hit;
        });
        if (best) {
            this._trafficClick = {kind: 'marker', marker: best.marker, feed: best.feed,
                x: mouseX, y: mouseY};
        }
    },

    /**
     * Promote the armed aircraft, unless the press turned into a drag.
     *
     * The drag test lives HERE, comparing the release position against the press
     * position, rather than in onMouseMove. onMouseMove is not a reliable place
     * for it: onDocumentMouseMove routes a drag to onMouseDrag when the view
     * defines one, pointer capture can deliver moves somewhere other than the
     * document, and a fast drag can produce a release with no intervening move
     * event at all. One comparison at release depends on none of that — and
     * onDocumentMouseUp hands us the current pointer position for exactly this.
     *
     * The threshold is 4 px rather than exact equality because a mouse almost
     * always creeps a pixel or two between press and release, and requiring zero
     * movement would mean the click essentially never fired.
     */
    _completeTrafficClick(mouseX, mouseY) {
        const click = this._trafficClick;
        this._trafficClick = null;
        if (!click) return;

        if (mouseX !== undefined && mouseY !== undefined
            && Math.hypot(mouseX - click.x, mouseY - click.y) > 4) {
            return;     // that was a camera drag, not a click on an aircraft
        }

        if (click.kind === 'marker') {
            this._openFeedMarker(click.marker, click.feed);
            return;
        }

        const traffic = this._trafficLayer();
        const label = click.aircraft?.callsign || click.aircraft?.registration || click.hex;
        // Shown in the Traffic readout while the fetch runs. A click with no
        // visible effect for a second or two reads as a click that missed, and
        // the user clicks again — queuing a second identical import.
        traffic?.setPromoting(label);
        console.log(`Live traffic: importing full trace for ${label} (${click.hex})`);

        importADSBTraceByHex(click.hex)
            .finally(() => traffic?.setPromoting(null));
    },

    /**
     * What clicking a live-feed marker does, which depends on what it is.
     *
     * A military aircraft promotes to a real track, exactly like a civil one —
     * it is the same data from the same provider, and the only difference is
     * which endpoint listed it. A webcam opens its current image, because a
     * webcam you cannot look through is not worth marking. Anything with a
     * source URL opens it. Everything else reports what it is, since for a
     * launch or a quake the marker plus its details IS the answer.
     */
    _openFeedMarker(marker, feed) {
        if (feed.id === 'mil' && marker.hex) {
            console.log(`Live feed: importing full trace for ${marker.label} (${marker.hex})`);
            importADSBTraceByHex(marker.hex);
            return;
        }
        const href = marker.imageURL || marker.url;
        if (href) {
            // noopener: the opened page must not get a handle on Sitrec's window.
            window.open(href, "_blank", "noopener,noreferrer");
            return;
        }
        // No link to follow — a ship or a radiosonde. The details go into that
        // feed's own readout rather than a modal: an error dialog is the wrong
        // shape for "here is what you clicked", and a dialog per click would make
        // browsing a busy layer unbearable.
        const layer = NodeMan.exists(`LiveFeed_${feed.id}`) ? NodeMan.get(`LiveFeed_${feed.id}`) : null;
        layer?.setSelected(marker);
        console.log(`Live feed ${feed.id}: ${marker.label}${marker.detail ? " — " + marker.detail : ""}`);
    },

    // Wrapper: pick with the displayed camera orientation (see _refreshCursorFromMouse).
    onMouseDown(event, mouseX, mouseY) {
        const _dl = this.applyDisplayLookAt?.(par.frame);
        try {
            return this.onMouseDownInner(event, mouseX, mouseY);
        } finally {
            this.removeDisplayLookAt?.(_dl);
        }
    },

    onMouseDownInner(event, mouseX, mouseY) {
        if (!this.mouseEnabled) return;

        // Convert screen coordinates to NDC for raycasting
        const mouseRay = screenToNDC(this, mouseX, mouseY);

        // Refresh cursorSprite.position / controls.target from the current mouse
        // ray before any downstream code reads them. onMouseMove no longer does
        // this every move, so click-time consumers (middle-click spline insert
        // below, CameraControls.handleMouseDown's cursorLLA label, and the
        // orbit pivot for the drag that's about to start) need a fresh hit here.
        if (this.camera && mouseInViewOnly(this, mouseX, mouseY)) {
            this._refreshCursorFromMouse(mouseRay);
        }

        // Left button only: middle inserts spline points below, and right opens
        // the context menu, so neither should arm a promotion.
        if (event.button === 0 && mouseInViewOnly(this, mouseX, mouseY)) {
            this._beginTrafficClick(mouseX, mouseY);
        }

        if (event.button === 1 && this.camera) {
            console.log("Center Click")

            if (NodeMan.exists("groundSplineEditor")) {
                const groundSpline = NodeMan.get("groundSplineEditor")
                if (groundSpline.enable) {
                    groundSpline.insertPoint(par.frame, this.cursorSprite.position)
                }
            }

            if (NodeMan.exists("ufoSplineEditor")) {
                this.raycaster.setFromCamera(mouseRay, this.camera);
                const ufoSpline = NodeMan.get("ufoSplineEditor")
                console.log(ufoSpline.enable)
                if (ufoSpline.enable) {
                    // it's both a track, and an editor
                    // so we first use it to pick a close point
                    var closest = ufoSpline.closestPointToRay(this.raycaster.ray).position

                    ufoSpline.insertPoint(par.frame, closest)
                }
            }
        }


        this.mouseDown = true;
//        console.log(this.id+"Mouse Down = "+this.mouseDown+ " Drag mode = "+this.dragMode)

        if (this.dragMode === 0 && this.controls && mouseInViewOnly(this, mouseX, mouseY)) {
//            console.log ("Click re-Enabled "+this.id)
            // debugger
            // console.log(mouseInViewOnly(this, mouseX, mouseY))
            //          this.controls.enabled = true;
        }
    },

    onMouseMove(event, mouseX, mouseY) {
        if (!this.mouseEnabled) return;

//        console.log(this.id+" Mouse Move = "+this.mouseDown+ " Drag mode = "+this.dragMode)

        //     return;

        // Convert screen coordinates to NDC for raycasting
        const mouseRay = screenToNDC(this, mouseX, mouseY);

        // For testing mouse position, just set dragMode to 1
        //  this.dragMode = DRAG.MOVEHANDLE;


// LOADS OF EXTERNAL STUFF


        if (this.mouseDown) {

            if (this.dragMode > 0) {
                // Dragging green or white (GIMBAL SPECIFIC, NOT USED
                this.raycaster.setFromCamera(mouseRay, this.camera);
                var intersects = this.raycaster.intersectObjects(this.scene.children, true);

                console.log(`Mouse Move Dragging (${mouseX},${mouseY})`)

                //  debugText = ""
                var closestPoint = V3()
                var distance = 10000000000;
                var found = false;
                var spherePointWorldPosition = V3();
                if (this.dragMode == 1)
                    glareSphere.getWorldPosition(spherePointWorldPosition)
                else
                    targetSphere.getWorldPosition(spherePointWorldPosition)

                for (var i = 0; i < intersects.length; i++) {
                    if (intersects[i].object.name == "dragMesh") {
                        var sphereDistance = spherePointWorldPosition.distanceTo(intersects[i].point)
                        if (sphereDistance < distance) {
                            distance = sphereDistance;
                            closestPoint.copy(intersects[i].point);
                            found = true;
                        }
                    }
                }
                if (found) {
                    const closestPointLocal = LocalFrame.worldToLocal(closestPoint.clone())
                    if (this.dragMode == 1) {
                        // dragging green
                        var pitch, roll;
                        [pitch, roll] = XYZJ2PR(closestPointLocal, jetPitchFromFrame())
                        par.podPitchPhysical = pitch;
                        par.globalRoll = roll
                        par.podRollPhysical = par.globalRoll - NodeMan.get("bank").v(par.frame)
                        // biome-ignore lint/correctness/noUndeclaredVariables: JetStuff circular-dep; see imports block
                        ChangedPR()
                    } else if (this.dragMode == 2) {
                        // dragging white
                        var el, az;
                        [el, az] = XYZ2EA(closestPointLocal)
                        // we want to keep it on the track, so are only changing Az, not El
                        // this is then converted to a frame number
                        par.az = az;
                        // biome-ignore lint/correctness/noUndeclaredVariables: JetStuff circular-dep; see imports block
                        UIChangedAz();
                    }
                }
            }
        } else if (this.visible && this.camera && mouseInViewOnly(this, mouseX, mouseY)) {

            // moving mouse around ANY view with a camera.
            //
            // The cursor raycast is only useful for things that read it each
            // frame: the LOS debug arrow, focus-track snapping, and held
            // position keys — C=camera, X=target (drive
            // CNodePositionLLA.update() via getCursorPositionFromTopView()),
            // V/B (drive globalMeasureState start/end via
            // CameraControls.updateMeasureArrow). Everything else (orbit
            // pivot, cursorLLA label, spline editors) reads on mouseDown
            // — refreshed there instead. Skipping the raycast also skips
            // setRenderOne(true), avoiding a full-scene redraw on every
            // hover when nothing visible depends on it.
            const focusTrackActive =
                this.focusTrackName !== "default" && NodeMan.exists(this.focusTrackName);
            const positionKeyHeld =
                isKeyHeld('c') || isKeyHeld('x')
                || isKeyHeld('v') || isKeyHeld('b');
            if (!this.showLOSArrow && !focusTrackActive && !positionKeyHeld) {
                return;
            }

            // Defer the actual raycast to the next animation frame so multiple
            // pointermoves that arrive within one frame coalesce into one
            // refresh. The handler reads the latest mouseX/mouseY out of
            // mouseMoveView at fire time, so we don't capture stale coords.
            this._scheduleDeferredCursorRefresh();

            // here we are just mouseing over the globe viewport
            // but the mouse it up
            // we want to allow rotation so it gets the first click.
            //           console.log("ENABLED controls "+this.id)
            //       this.controls.enabled = true;
        } else {
            //              console.log("DISABLED controls not just in "+this.id)
            //       if (this.controls) this.controls.enabled = false;
        }

    },

    /**
     * Helper function to check distance from mouse to line segments of a track
     * @param {Object} trackNode - The track node with position data
     * @param {number} dataPointCount - Number of data points in the track
     * @param {Function} getPositionFunc - Function to get position at index i
     * @param {number} mouseX - Screen X coordinate
     * @param {number} mouseY - Screen Y coordinate
     * @returns {number} Minimum distance from mouse to any segment (or Infinity if no valid segments)
     */
    checkTrackSegments(trackNode, dataPointCount, getPositionFunc, mouseX, mouseY) {
        let minDistance = Infinity;
        
        // Check distance to line segments between consecutive points
        for (let dataIndex = 0; dataIndex < dataPointCount - 1; dataIndex++) {
            // For nodes with validPoint method, check if data exists before accessing
            if (trackNode.validPoint) {
                if (!trackNode.validPoint(dataIndex) || !trackNode.validPoint(dataIndex + 1)) {
                    continue;
                }
            }
            
            const pos3D_A = getPositionFunc(dataIndex);
            const pos3D_B = getPositionFunc(dataIndex + 1);
            if (!pos3D_A || !pos3D_B) continue;
            
            // Project both endpoints to screen space
            const screenPos_A = new Vector3(pos3D_A.x, pos3D_A.y, pos3D_A.z);
            screenPos_A.project(this.camera);
            
            const screenPos_B = new Vector3(pos3D_B.x, pos3D_B.y, pos3D_B.z);
            screenPos_B.project(this.camera);
            
            // Skip if both points are behind camera
            if (screenPos_A.z > 1 && screenPos_B.z > 1) continue;
            
            // Convert from normalized device coordinates (-1 to 1) to screen pixels
            // Note: leftPx/topPx are container-relative, add screenOffsetX for absolute screen position
            const containerOffsetX = ViewMan.screenOffsetX || 0;
            const screenX_A = (screenPos_A.x * 0.5 + 0.5) * this.widthPx + this.leftPx + containerOffsetX;
            const screenY_A = (1 - (screenPos_A.y * 0.5 + 0.5)) * this.heightPx + this.topPx;

            const screenX_B = (screenPos_B.x * 0.5 + 0.5) * this.widthPx + this.leftPx + containerOffsetX;
            const screenY_B = (1 - (screenPos_B.y * 0.5 + 0.5)) * this.heightPx + this.topPx;
            
            // Calculate distance from mouse to line segment
            // Using point-to-line-segment distance formula
            const dx = screenX_B - screenX_A;
            const dy = screenY_B - screenY_A;
            const lengthSquared = dx * dx + dy * dy;
            
            let distance;
            if (lengthSquared === 0) {
                // Degenerate case: A and B are the same point
                const px = mouseX - screenX_A;
                const py = mouseY - screenY_A;
                distance = Math.sqrt(px * px + py * py);
            } else {
                // Calculate the parameter t for the closest point on the line segment
                // t = 0 means closest to A, t = 1 means closest to B
                let t = ((mouseX - screenX_A) * dx + (mouseY - screenY_A) * dy) / lengthSquared;
                t = Math.max(0, Math.min(1, t)); // Clamp to [0, 1] to stay on segment
                
                // Calculate the closest point on the segment
                const closestX = screenX_A + t * dx;
                const closestY = screenY_A + t * dy;
                
                // Calculate distance from mouse to closest point
                const px = mouseX - closestX;
                const py = mouseY - closestY;
                distance = Math.sqrt(px * px + py * py);
            }
            
            minDistance = Math.min(minDistance, distance);
        }
        
        return minDistance;
    },

    /**
     * Find the closest track to the mouse position in screen space
     * @param {number} mouseX - Screen X coordinate
     * @param {number} mouseY - Screen Y coordinate
     * @param {number} threshold - Maximum distance in pixels to consider (default: 10)
     * @returns {Object|null} Object with {trackID, nodeId, guiFolder} or null if no track is close enough
     */
    findClosestTrack(mouseX, mouseY, threshold = 10) {
        if (!this.camera) return null;
        
        let closestTrack = null;
        let closestDistance = threshold;
        
        // First, check tracks from TrackManager (user-loaded tracks from KML/CSV/etc)
        TrackManager.iterate((trackID, trackOb) => {
            const trackNode = trackOb.trackNode;
            const trackDataNode = trackOb.trackDataNode;
            
            // Check the display node's visibility (trackDisplayNode for loaded tracks, displayTrack for synthetic)
            const displayNode = trackOb.trackDisplayNode || trackOb.displayTrack;
            if (!trackNode || (displayNode && !displayNode.visible)) return;
            
            // Check ONLY the track data node if it exists (raw data points)
            // This represents the actual track data (e.g., from KML/CSV) and is the complete track
            if (trackDataNode && trackDataNode.getPosition && trackDataNode.misb) {
                const dataPointCount = trackDataNode.misb.length;
                const distance = this.checkTrackSegments(
                    trackDataNode, 
                    dataPointCount, 
                    (i) => trackDataNode.getPosition(i),
                    mouseX, 
                    mouseY
                );
                
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestTrack = {
                        trackID: trackID,
                        nodeId: trackDataNode.id,
                        guiFolder: trackOb.guiFolder,
                        trackOb: trackOb
                    };
                }
            }
        });
        
        // Second, check display tracks (cameraDisplayTrack, satelliteDisplayTrack, traverseDisplayTrack, etc)
        // These are algorithmic tracks that aren't in TrackManager
        NodeMan.iterate((nodeId, node) => {
            // Check if this is a CNodeDisplayTrack with a visible track
            if (node.constructor.name === 'CNodeDisplayTrack' && node.visible && node.guiFolder) {
                const trackNode = node.in.track;
                if (!trackNode || !trackNode.p || !trackNode.validPoint) return;
                
                // For display tracks, we check the track node's position data
                // Use trackNode.frames to get the number of frames
                const frameCount = trackNode.frames;
                if (!frameCount || frameCount < 2) return;
                
                // Check if the track has valid data at the first frame
                // Some tracks (like satellites) might not have data loaded yet
                if (!trackNode.validPoint(0)) return;
                
                const distance = this.checkTrackSegments(
                    trackNode,
                    frameCount,
                    (i) => trackNode.p(i),
                    mouseX,
                    mouseY
                );
                
                if (distance < closestDistance) {

                    // for now we can only pick tracks in the track manager
                    // so we will ignore the traverse track, camera track, and satellite tracks
                    const trackOb = TrackManager.get(trackNode.id, false);
                    if (trackOb) {
                        closestDistance = distance;
                        // Try to find the trackOb from TrackManager
                        // For synthetic tracks, the trackID matches the track node ID
                        closestTrack = {
                            trackID: nodeId,
                            nodeId: nodeId,
                            guiFolder: node.guiFolder,
                            trackOb: trackOb
                        };
                    }
                }
            }
        });
        
        return closestTrack;
    },

    // Display a context menu for a celestial object
    showCelestialObjectMenu(celestialObject, clientX, clientY) {
        console.log(`Found celestial object: ${celestialObject.type} - ${celestialObject.name}`);
        
        // Create an info menu for the celestial object
        let menuTitle = '';
        if (celestialObject.type === 'planet') {
            menuTitle = `Planet: ${celestialObject.name}`;
        } else if (celestialObject.type === 'satellite') {
            menuTitle = `Satellite: ${celestialObject.name}`;
        } else if (celestialObject.type === 'star') {
            menuTitle = `Star: ${celestialObject.name}`;
        }
        
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, clientX, clientY, true);
        
        // If menu creation was blocked (persistent menu is open), return early
        if (!standaloneMenu) {
            return;
        }
        
        // Add information about the celestial object
        if (celestialObject.type === 'planet') {
            const data = celestialObject.data;
            if (data.ra !== undefined) {
                standaloneMenu.add({raHours: (data.ra * 12 / Math.PI).toFixed(3)}, 'raHours').name(t("view3d.celestial.raHours")).listen().disable();
            }
            if (data.dec !== undefined) {
                standaloneMenu.add({decDegrees: (data.dec * 180 / Math.PI).toFixed(3)}, 'decDegrees').name(t("view3d.celestial.decDegrees")).listen().disable();
            }
            if (data.mag !== undefined) {
                standaloneMenu.add({magnitude: data.mag.toFixed(2)}, 'magnitude').name(t("view3d.celestial.magnitude")).listen().disable();
            }
        } else if (celestialObject.type === 'satellite') {
            standaloneMenu.add({noradNum: String(celestialObject.number)}, 'noradNum').name(t("view3d.celestial.noradNumber")).listen().disable();
            standaloneMenu.add({name: celestialObject.name}, 'name').name(t("view3d.celestial.name")).listen().disable();
        } else if (celestialObject.type === 'star') {
            if (celestialObject.ra !== undefined) {
                standaloneMenu.add({raHours: (celestialObject.ra * 12 / Math.PI).toFixed(3)}, 'raHours').name(t("view3d.celestial.raHours")).listen().disable();
            }
            if (celestialObject.dec !== undefined) {
                standaloneMenu.add({decDegrees: (celestialObject.dec * 180 / Math.PI).toFixed(3)}, 'decDegrees').name(t("view3d.celestial.decDegrees")).listen().disable();
            }
            if (celestialObject.magnitude !== undefined && celestialObject.magnitude !== 'Unknown') {
                standaloneMenu.add({magnitude: celestialObject.magnitude.toFixed(2)}, 'magnitude').name(t("view3d.celestial.magnitude")).listen().disable();
            }
        }
        
        // For satellites, offer to point one of the two "Satellite to Track" fields in
        // the Satellites menu at this satellite. setSatelliteText() is the same code
        // path as typing it in by hand, so the track, the camera/target track switches
        // and the Contents folder all update.
        // We pass the NORAD number rather than the name: names are not unique in the
        // TLE data (e.g. two satellites called SAPPHIRE) and a name lookup returns the
        // first match, which could be a different satellite than the one clicked.
        // setSatelliteText() resolves the number and then puts the name in the field.
        if (celestialObject.type === 'satellite') {
            const satTrackActions = {};
            const satTrackSlots = [
                ["satelliteTrack", "satTrack1", "view3d.celestial.satTrack1", "Sat Track 1"],
                ["satelliteTrack2", "satTrack2", "view3d.celestial.satTrack2", "Sat Track 2"],
            ];
            for (const [nodeID, key, labelKey, defaultLabel] of satTrackSlots) {
                // the satellite track nodes only exist in sitches that define them (e.g. custom)
                const trackNode = NodeMan.get(nodeID, false);
                if (!trackNode) continue;
                satTrackActions[key] = () => {
                    standaloneMenu.destroy();
                    trackNode.setSatelliteText(celestialObject.number);
                    console.log(`Set ${nodeID} to track satellite: ${celestialObject.name} (${celestialObject.number})`);
                };
                standaloneMenu.add(satTrackActions, key).name(t(labelKey, {defaultValue: defaultLabel}));
            }
        }

        // Make disabled controller values selectable and copyable
        // Override lil-gui's user-select:none and pointer-events:none on disabled controllers
        const style = document.createElement('style');
        style.textContent = `
            .lil-gui.celestial-info { user-select: text; -webkit-user-select: text; }
            .lil-gui.celestial-info .controller.disabled,
            .lil-gui.celestial-info .controller.disabled * { pointer-events: auto !important; }
            .lil-gui.celestial-info .controller.disabled input { cursor: text; }
        `;
        standaloneMenu.domElement.prepend(style);
        standaloneMenu.domElement.classList.add('celestial-info');

        // Open the menu
        standaloneMenu.open();
    },

    // Find the closest celestial object (star, planet, or satellite) to a ray.
    //
    // This picks by projecting each candidate FORWARD and comparing screen pixels, so
    // unlike a raycast it needs the projection the view is actually displayed with —
    // the same one CNodeDisplaySkyOverlay draws the labels through. Without it, a click
    // and the label it is aimed at disagree by the letterbox stretch.
    findClosestCelestialObject(mouseRay, mouseX, mouseY, maxAngleDegrees = 5) {
        return withDisplayedCamera(this,
            () => this.findClosestCelestialObjectInner(mouseRay, mouseX, mouseY, maxAngleDegrees));
    },

    findClosestCelestialObjectInner(mouseRay, mouseX, mouseY, maxAngleDegrees = 5) {
        const nightSkyNode = NodeMan.get("NightSkyNode", false);
        if (!nightSkyNode) {
            console.log("NightSkyNode not found");
            return null;
        }

        let closestObject = null;
        let closestAngle = maxAngleDegrees;

        // NDC -> screen pixels through the rectangle the 3D actually fills, which is
        // NOT the whole pane: with Match Video Aspect the canvas is letterboxed inside
        // its div, so mapping across the div puts every hit target radially out from
        // the pane centre and the click lands on the wrong object. This is the forward
        // twin of screenToNDC(), which already takes the mouse the other way.
        const pickRect = renderedRect(this, this.widthPx, this.heightPx);
        const containerOffsetX = ViewMan.screenOffsetX || 0;
        const toScreen = (ndc) => [
            pickRect.x + (ndc.x + 1) * 0.5 * pickRect.w + this.leftPx + containerOffsetX,
            pickRect.y + (1 - ndc.y) * 0.5 * pickRect.h + this.topPx,
        ];

        // Convert mouse ray to a direction vector using the raycaster
        // mouseRay is in NDC coordinates (-1 to +1)
        
        // IMPORTANT: The night sky is rendered with the camera temporarily at the origin (0,0,0)
        // So we need to get the ray direction as if the camera were at the origin
        // Save the camera's actual position and temporarily move it to origin
        const savedCameraPos = this.camera.position.clone();
        this.camera.position.set(0, 0, 0);
        this.camera.updateMatrixWorld();
        
        this.raycaster.setFromCamera(mouseRay, this.camera);
        const rayDirection = this.raycaster.ray.direction.clone();
        
        console.log(`Checking celestial objects:`);
        console.log(`  Ray direction (from origin): (${rayDirection.x.toFixed(4)}, ${rayDirection.y.toFixed(4)}, ${rayDirection.z.toFixed(4)})`);

        // Earth occlusion: ray from actual camera position toward celestial object
        // If the ray hits the Earth sphere, the object is behind the Earth and shouldn't be selectable
        const earthGlobe = new Sphere(new Vector3(0, 0, 0), wgs84.POLAR_RADIUS);
        const earthHitTemp = new Vector3();
        const occlusionRay = { origin: savedCameraPos, direction: new Vector3() };

        // Check planets (using pixel-based distance from edge)
        const maxEdgeDistance = 20;
        let closestEdgeDistance = maxEdgeDistance;

        if (nightSkyNode.planets.planetSprites) {
            console.log(`Checking ${Object.keys(nightSkyNode.planets.planetSprites).length} planets (edge threshold: ${maxEdgeDistance}px)`);
            for (const [planetName, planetData] of Object.entries(nightSkyNode.planets.planetSprites)) {
                if (!planetData.sprite || !planetData.sprite.visible) continue;

                // Use the stored apparent equatorial position rather than
                // sprite.getWorldPosition(): for Sun/Moon, mesh.position is
                // the geometric center while the rendered disk is lifted by
                // the per-vertex refraction shader. planetData.equatorial
                // holds the apparent center so the picker hits the visible
                // disk. Falls back to getWorldPosition() if not yet stored.
                const planetWorldPos = new Vector3();
                if (planetData.equatorial) {
                    planetWorldPos.copy(planetData.equatorial)
                        .applyMatrix4(nightSkyNode.celestialSphere.matrix);
                } else {
                    planetData.sprite.getWorldPosition(planetWorldPos);
                }

                // Skip planets occluded by the Earth
                occlusionRay.direction.copy(planetWorldPos).normalize();
                if (intersectSphere2(occlusionRay, earthGlobe, earthHitTemp)) continue;

                // Project center to NDC
                const pos = planetWorldPos.clone().project(this.camera);
                
                // Check if in front of camera and within view
                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    const [screenX, screenY] = toScreen(pos);

                    // Calculate screen radius by projecting an edge point
                    const spriteScale = planetData.sprite.scale.x;
                    const edgeWorldPos = planetWorldPos.clone();
                    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
                    edgeWorldPos.addScaledVector(right, spriteScale);
                    const edgePos = edgeWorldPos.project(this.camera);
                    const [edgeScreenX, edgeScreenY] = toScreen(edgePos);
                    const screenRadius = Math.sqrt((edgeScreenX - screenX) ** 2 + (edgeScreenY - screenY) ** 2);
                    
                    const dx = screenX - mouseX;
                    const dy = screenY - mouseY;
                    const pixelDistanceFromCenter = Math.sqrt(dx * dx + dy * dy);
                    const edgeDistance = pixelDistanceFromCenter - screenRadius;
                    
                    console.log(`  Planet ${planetName}: center=${pixelDistanceFromCenter.toFixed(1)}px, radius=${screenRadius.toFixed(1)}px, edge=${edgeDistance.toFixed(1)}px`);

                    if (edgeDistance < closestEdgeDistance) {
                        closestEdgeDistance = edgeDistance;
                        closestObject = {
                            type: 'planet',
                            name: planetName,
                            data: planetData,
                            pixelDistance: edgeDistance,
                            angle: edgeDistance
                        };
                        console.log(`    -> New closest object: ${planetName} at ${edgeDistance.toFixed(1)}px from edge`);
                    }
                }
            }
        }

        // Check satellites
        // IMPORTANT: Unlike stars/planets which are in GlobalNightSkyScene (rendered with camera at origin),
        // satellites are in GlobalScene (rendered with camera at its actual position).
        // So we must use the actual camera position for satellite direction calculation.
        if (nightSkyNode.TLEData && nightSkyNode.TLEData.satData) {
            // Restore camera position temporarily for satellite picking
            this.camera.position.copy(savedCameraPos);
            this.camera.updateMatrixWorld();

            const maxSatPixelDistance = 15;
            let closestSatDistance = maxSatPixelDistance;

            for (const satData of nightSkyNode.TLEData.satData) {
                if (!satData.visible || !satData.ecef) continue;

                // Project the rendered (apparent) position so the picker
                // hits the dot the user sees. ecefApparent equals ecef when
                // refraction is disabled.
                const satPos = (satData.ecefApparent || satData.ecef).clone();

                // Project satellite position to screen
                const projected = satPos.clone().project(this.camera);

                // Skip satellites behind the camera (outside NDC range)
                if (projected.z < -1 || projected.z > 1) continue;

                const [screenX, screenY] = toScreen(projected);

                const dx = screenX - mouseX;
                const dy = screenY - mouseY;
                const pixelDistance = Math.sqrt(dx * dx + dy * dy);

                if (pixelDistance >= closestSatDistance) continue;

                // Skip satellites occluded by the Earth (Earth hit is closer than the satellite)
                const camToSat = satPos.clone().sub(this.camera.position);
                occlusionRay.direction.copy(camToSat).normalize();
                if (intersectSphere2(occlusionRay, earthGlobe, earthHitTemp)) {
                    if (earthHitTemp.distanceTo(this.camera.position) < camToSat.length()) continue;
                }

                closestSatDistance = pixelDistance;
                closestObject = {
                    type: 'satellite',
                    name: satData.name,
                    number: satData.number,
                    data: satData,
                    pixelDistance: pixelDistance,
                    angle: pixelDistance
                };
            }

            // Move camera back to origin for remaining celestial object checks (stars)
            this.camera.position.set(0, 0, 0);
            this.camera.updateMatrixWorld();
        }

        // Check stars (using pixel-based distance)
        if (nightSkyNode.starField && nightSkyNode.starField.commonNames) {
            const date = GlobalDateTimeNode.dateNow;
            const maxPixelDistance = 15;
            let closestStarDistance = maxPixelDistance;
            const refractApplies = refractionUniforms.uRefractionEnabled.value > 0.5;
            const refractOpts = refractApplies ? refractionOptsFromUniforms() : null;

            console.log(`Checking ${Object.keys(nightSkyNode.starField.commonNames).length} named stars (pixel threshold: ${maxPixelDistance}px)`);

            for (const HR in nightSkyNode.starField.commonNames) {
                const n = HR - 1;
                const starName = nightSkyNode.starField.commonNames[HR];
                
                const ra = nightSkyNode.starField.getStarRA(n);
                const dec = nightSkyNode.starField.getStarDEC(n);
                const mag = nightSkyNode.starField.getStarMagnitude(n);
                
                const pos = applyAnnualAberration(raDec2Celestial(ra, dec, 100), date);
                if (refractApplies) {
                    applyRefractionECI(pos, refractionUniforms.uZenithECI.value, refractOpts);
                }
                pos.applyMatrix4(nightSkyNode.celestialSphere.matrix);

                // Skip stars occluded by the Earth
                occlusionRay.direction.copy(pos).normalize();
                if (intersectSphere2(occlusionRay, earthGlobe, earthHitTemp)) continue;

                pos.project(this.camera);
                
                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    const [screenX, screenY] = toScreen(pos);

                    const dx = screenX - mouseX;
                    const dy = screenY - mouseY;
                    const pixelDistance = Math.sqrt(dx * dx + dy * dy);
                    
                    if (pixelDistance < closestStarDistance) {
                        closestStarDistance = pixelDistance;
                        closestObject = {
                            type: 'star',
                            name: starName,
                            ra: ra,
                            dec: dec,
                            magnitude: mag,
                            pixelDistance: pixelDistance,
                            angle: pixelDistance
                        };
                        console.log(`    -> New closest star: ${starName} at ${pixelDistance.toFixed(1)}px (mag ${mag.toFixed(2)})`);
                    }
                }
            }
        }
        
        // Restore the camera's actual position
        this.camera.position.copy(savedCameraPos);
        this.camera.updateMatrixWorld();

        if (closestObject) {
            if (closestObject.type === 'star' || closestObject.type === 'planet') {
                console.log(`Found closest celestial object: ${closestObject.type} - ${closestObject.name} at ${closestObject.pixelDistance.toFixed(1)}px`);
            } else {
                console.log(`Found closest celestial object: ${closestObject.type} - ${closestObject.name} at ${closestObject.angle.toFixed(2)}°`);
            }
        } else {
            console.log(`No celestial objects found within thresholds`);
        }

        return closestObject;
    },

    // Helper method to show track menu (extracted to avoid duplication)
    showTrackMenu(closestTrack, event) {
        console.log(`Found track near mouse: ${closestTrack.trackID}`);

        // Mirror the track's GUI folder from the Contents menu
        if (closestTrack.guiFolder) {
            // Refresh smoothing parameter visibility before creating the menu
            const trackOb = closestTrack.trackOb;
            const smoothedNode = trackOb?.smoothedTrackNode || trackOb?.trackNode;
            if (smoothedNode?.isDynamicSmoothing) {
                smoothedNode._updateParameterVisibility();
            }

            const menuTitle = `Track: ${closestTrack.trackOb?.menuText || closestTrack.trackID}`;

            // Create a standalone menu and mirror the track's GUI folder
            // Use dismissOnOutsideClick=false so dragging control points doesn't close the menu
            const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, event.clientX, event.clientY, false);

            // If menu creation was blocked (persistent menu is open), return early
            if (!standaloneMenu) {
                return;
            }

            // Set up dynamic mirroring for the track's GUI folder
            CustomManager.setupDynamicMirroring(closestTrack.guiFolder, standaloneMenu);

            // Add a method to manually refresh the mirror
            standaloneMenu.refreshMirror = () => {
                CustomManager.updateMirror(standaloneMenu);
            };

            // Open the menu by default
            standaloneMenu.open();
            console.log(`Created standalone menu for track: ${closestTrack.trackID}`);
        }
    },

    // Wrapper: pick with the displayed camera orientation (see _refreshCursorFromMouse),
    // so right-clicking hits what is on screen — including the traverse object
    // when the render camera is tracking it.
    onContextMenu(event, mouseX, mouseY) {
        const _dl = this.applyDisplayLookAt?.(par.frame);
        try {
            return this.onContextMenuInner(event, mouseX, mouseY);
        } finally {
            this.removeDisplayLookAt?.(_dl);
        }
    },

    onContextMenuInner(event, mouseX, mouseY) {
        // Prevent the default browser context menu
        event.preventDefault();
        event.stopPropagation();
        
        if (!this.mouseEnabled) return;
        
        // First check for feature markers using screen-space detection (more reliable for screen-invariant markers)
        if (FeatureManager.handleContextMenu(mouseX, mouseY, this)) {
            return; // Feature menu shown, we're done
        }
        
        // mouseX, mouseY are screen coordinates (event.clientX, event.clientY)
        // Convert screen coordinates to NDC for raycasting
        const mouseRay = screenToNDC(this, mouseX, mouseY);
        
        if (this.camera && mouseInViewOnly(this, mouseX, mouseY)) {
            // First, check for 3D objects using raycasting (they have priority over tracks).
            // Match the raycaster's layers to the camera's so we never pick objects
            // the camera couldn't render (Three.js raycaster does test layers, but defaults to layer 0 only).
            const prevRaycasterMask = this.raycaster.layers.mask;
            this.raycaster.layers.mask = this.camera.layers.mask;
            this.raycaster.setFromCamera(mouseRay, this.camera);
            const allIntersects = this.raycaster.intersectObjects(this.scene.children, true);
            this.raycaster.layers.mask = prevRaycasterMask;

            // Helper to check if object or any parent has ignoreContextMenu
            const shouldIgnoreContextMenu = (obj) => {
                let current = obj;
                while (current) {
                    if (current.userData?.ignoreContextMenu) return true;
                    current = current.parent;
                }
                return false;
            };

            // Skip CNode3D objects whose position is driven from the same root
            // track as this view's camera — the camera is effectively coincident
            // with them so they shouldn't be pickable from inside.
            const cameraRootTrack = this.cameraNode ? findRootTrack(this.cameraNode) : null;
            const sharesCameraRootTrack = (obj) => {
                if (!cameraRootTrack) return false;
                const objectID = this.findObjectID(obj);
                if (!objectID) return false;
                const node = NodeMan.get(objectID, false);
                if (!node) return false;
                return findRootTrack(node) === cameraRootTrack;
            };

            // Skip objects the renderer would not have drawn last frame:
            // any ancestor with visible===false blocks rendering (mirrors
            // WebGLRenderer.projectObject), and Three.js's raycaster ignores
            // .visible entirely so we have to walk this ourselves.
            // Also consult the per-view _renderHiddenNodeIDs populated by
            // CustomSupport.preRenderUpdate — those nodes are hidden for the
            // render but their .visible is restored by postRenderUpdate
            // before the user's right-click event reaches us.
            const renderHiddenNodeIDs = this._renderHiddenNodeIDs;
            const wasRendered = (obj) => {
                let cur = obj;
                while (cur) {
                    if (cur.visible === false) return false;
                    cur = cur.parent;
                }
                if (renderHiddenNodeIDs && renderHiddenNodeIDs.size > 0) {
                    const objectID = this.findObjectID(obj);
                    if (objectID && renderHiddenNodeIDs.has(objectID)) return false;
                }
                return true;
            };

            // Filter out objects marked to ignore context menu (overlays, clouds, sprites),
            // objects locked to the camera's own position track, and anything not actually
            // rendered in this view.
            const intersects = allIntersects.filter(intersect =>
                !shouldIgnoreContextMenu(intersect.object)
                && !sharesCameraRootTrack(intersect.object)
                && wasRendered(intersect.object)
            );

            if (intersects.length > 0) {
                // Track if we found a valid object with nodeId
                let foundObject = false;
                
                // Find the closest intersected object that belongs to a CNode3DObject
                for (const intersect of intersects) {

                    // make a debug sphere at the intersection point
                    // DebugSphere("DEBUGPick" + intersect.point.x +","+intersect.point.y, intersect.point, 1, 0xFF00FF);


                    const object = intersect.object;
                    const objectID = this.findObjectID(object);
                    
                    if (objectID) {
                        console.log(`Found object: ${objectID}`);
                        foundObject = true;

                        // get coordinates of the intersection point
                        const groundPoint = intersect.point;

//                        DebugSphere("DEBUGPIck"+par.frame, groundPoint, 2, 0xFFFF00)

                        // Check if this is a synthetic 3D building - if so, enter edit mode
                        if (objectID.startsWith('synthBuilding_')) {
                            const building = Synth3DManager.getBuilding(objectID);
                            if (building) {
                                console.log(`Right-clicked on synthetic building: ${objectID}, entering edit mode`);
                                
                                // First, exit edit mode on the currently edited building (if any)
                                if (Globals.editingBuilding && Globals.editingBuilding !== building) {
                                    console.log(`  Exiting edit mode on previous building: ${Globals.editingBuilding.buildingID}`);
                                    Globals.editingBuilding.setEditMode(false);
                                }
                                
                                // Enter edit mode (this will create handles and set up state)
                                building.setEditMode(true);
                                
                                // Show the building edit menu at the mouse position (better UX than default position)
                                // This will close the default-positioned menu created by setEditMode and show it at the cursor
                                CustomManager.showBuildingEditingMenu(event.clientX, event.clientY, groundPoint);
                                
                                return; // Edit mode entered, we're done
                            }
                        }
                        
                        // Check if this is a synthetic cloud layer - if so, enter edit mode
                        if (objectID.startsWith('synthClouds_')) {
                            const clouds = Synth3DManager.getClouds(objectID);
                            if (clouds) {
                                console.log(`Right-clicked on synthetic clouds: ${objectID}, entering edit mode`);
                                
                                // First, exit edit mode on the currently edited clouds (if any)
                                if (Globals.editingClouds && Globals.editingClouds !== clouds) {
                                    console.log(`  Exiting edit mode on previous clouds: ${Globals.editingClouds.cloudsID}`);
                                    Globals.editingClouds.setEditMode(false);
                                }
                                
                                // Enter edit mode (this will create handles and set up state)
                                clouds.setEditMode(true);
                                
                                // Show the clouds edit menu at the mouse position
                                CustomManager.showCloudsEditingMenu(event.clientX, event.clientY, groundPoint);
                                
                                return; // Edit mode entered, we're done
                            }
                        }

                        // Get the node from NodeManager
                        const node = NodeMan.get(objectID);
                        // Use guiFolder (the actual lil-gui folder) if available, otherwise gui
                        // node.gui can be a string like "contents" on CNodeDisplayTrack, so check it's an object
                        const guiToMirror = node?.guiFolder || (node?.gui && typeof node.gui === 'object' ? node.gui : null);
                        if (node && guiToMirror) {
                            // Create a draggable window with the node's GUI controls
                            const menuTitle = node.menuName || guiToMirror._title || node.id;



                            // Create a standalone menu and mirror the object's GUI folder
                            // Use dismissOnOutsideClick=false so interacting with the scene doesn't close the menu
                            const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, event.clientX, event.clientY, false);

                            // If menu creation was blocked (persistent menu is open), return early
                            if (!standaloneMenu) {
                                return;
                            }

                            // Set up dynamic mirroring for the object's GUI folder
                            CustomManager.setupDynamicMirroring(guiToMirror, standaloneMenu);
                            if (node instanceof CNode3DObject) {
                                CustomManager.setEditingObject(node, standaloneMenu);
                            }
                            
                            // Add a method to manually refresh the mirror
                            standaloneMenu.refreshMirror = () => {
                                CustomManager.updateMirror(standaloneMenu);
                            };
                            
                            // Open the menu by default
                            standaloneMenu.open();
                            // console.log(`Created standalone menu for object: ${objectID}`);
                        } else {
                            console.log(`Node ${objectID} not found or has no GUI folder`);
                        }
                        return; // Found an object, don't check tracks or ground
                    } else {
                        // Debug: log what we're hitting
                       // console.log(`Hit object without valid name: ${object.type}, name: "${object.name}", userData:`, object.userData);
                    }
                }
                
                // If we didn't find an object with nodeId, but we hit something (like terrain/ground)
                if (!foundObject) {
                    // Check if we're close to any track in screen space
                    // Tracks are too thin to pick with raycasting, so we check screen space distance
                    const closestTrack = this.findClosestTrack(mouseX, mouseY, 10);

                    if (closestTrack) {
                        this.showTrackMenu(closestTrack, event);
                        return; // Found a track, don't show ground menu
                    }

                    // Check celestial objects BEFORE ground menu - the user may be clicking
                    // on a star, planet, or satellite even though the ray also hits terrain/globe
                    const celestialObject = this.findClosestCelestialObject(mouseRay, mouseX, mouseY);
                    if (celestialObject) {
                        this.showCelestialObjectMenu(celestialObject, event.clientX, event.clientY);
                        return;
                    }

                    // No celestial objects found, show ground context menu if in custom sitch
                    if (Sit.isCustom) {
                        // Get the first intersection point (closest to camera)
                        const groundPoint = intersects[0].point;
                        CustomManager.showGroundContextMenu(mouseX, mouseY, groundPoint, this.id);
                        return;
                    }
                }
            }

            // No intersections with 3D objects or ground, check for tracks
            const closestTrack = this.findClosestTrack(mouseX, mouseY, 10);

            if (closestTrack) {
                this.showTrackMenu(closestTrack, event);
                return; // Found a track, don't check celestial objects
            }

            // No tracks found, check for celestial objects (stars, planets, satellites)
            const celestialObject = this.findClosestCelestialObject(mouseRay, mouseX, mouseY);

            if (celestialObject) {
                this.showCelestialObjectMenu(celestialObject, event.clientX, event.clientY);
            }
        }
    },
};
