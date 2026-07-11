// Manual Tracking - A tracking view that overlays the video and shows manual tracking data
// User manually places keyframes to track objects
// This is distinct from Auto Tracking (CObjectTracking) which automatically tracks objects
//

import {CNodeViewUI} from "./CNodeViewUI";
import {assert} from "../assert";
import {Globals, NodeMan, Sit} from "../Globals";
import {par} from "../par";
import {radians} from "../utils";
import {extractFOV} from "./CNodeControllerVarious";
import {mouseToCanvas} from "../ViewUtils";
import {CNodeVideoView} from "./CNodeVideoView";
import {EventManager} from "../CEventManager";
import {t} from "../i18n";

/*
    the intent of a tracking overlay is to track point on a video
    so the location of a point is stored as pixels in the video
    and can extend beyond the video (visible and editable if the video is zoomed out)

    So we First have mouse coordinates in the canvas which contains the video
    we need to convert these to pixels in the video

    Then for rendering, we convert these video coordinates back to canvas coordinates

    CNodeVideoView has methods to convert canvas coordinates to video coordinates
    and video coordinates to canvas coordinates
    CNodeVideoView: canvasToVideoCoords(x, y) and videoToCanvasCoords(x, y)

 */


// Draggable items use VIDEO coordinates, which are pixels
// the view member here is a CNodeTrackingOverlay which has a CNodeVideoView as overlayView
export class CDraggableItem {
    constructor(v) {
        this.view = v.view;
        assert(this.view instanceof CNodeTrackingOverlay, "CDraggableItem: view must be an instance of CNodeTrackingOverlay");
        assert(this.view.overlayView instanceof CNodeVideoView, "CDraggableItem: view.overlayView must be an instance of CNodeVideoView");

        this.video = this.view.overlayView;

        if (v.coordinatesAreVideo) {
            // Deserialized keyframes are already stored in original-video coordinates.
            this.x = v.x;
            this.y = v.y;
        } else if (this.view.hasVideoGeometry()) {
            const [vX, vY] = this.video.canvasToVideoCoordsOriginal(v.x, v.y);

            console.log(`Adding draggable item at canvas (${v.x}, ${v.y}) which is video (${vX}, ${vY})`)

            this.x = vX;
            this.y = vY;
        } else {
            // Keep finite placeholder values until a video is available and the overlay can rebuild cleanly.
            this.x = v.x;
            this.y = v.y;
        }


        this.dragging = false;
    }



    // cX and cY gettors will convert internal video coordinates to canvas coordinates
    // canvas X
    get cX() {
        const [cX, cY] = this.video.videoToCanvasCoordsOriginal(this.x, this.y);
        return cX;
    }

    // canvas Y
    get cY() {
        const [cX, cY] = this.video.videoToCanvasCoordsOriginal(this.x, this.y);
        return cY;
    }

    // canvas radius NOT RIGHT
    get cR() {
        // just a fixed radius for now.
        return 10;
    }

    startDrag(x, y) {
        this.dragging = true;
    }
}

export class CDraggableCircle extends CDraggableItem {
     constructor(v) {
        super(v);
        this.radius = v.radius ?? 5;
    }


    isWithin(x, y) {
        const dx = x - this.cX
        const dy = y - this.cY

        const inside = ( dx * dx + dy * dy) < (this.cR * this.cR);

  //      console.log("isWithin", x, y, this.cX, this.cY, this.cR, inside)

        return inside
    }

    render(ctx) {
        const v = this.view
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5
        if (par.frame === this.frame) {
            ctx.strokeStyle = '#FF0000'
            ctx.lineWidth = 2.5
        }
        ctx.beginPath();
        ctx.arc(this.cX, this.cY, this.cR, 0, 2 * Math.PI);
        ctx.stroke();
    }

}


// An active overlay is a view that contains draggable and clickable items
// such as the object tracking spline editor (which is currently the only thing that uses it)
export class CNodeActiveOverlay extends CNodeViewUI {
    constructor(v) {
        super(v);


        // disable double clicking to full-screen or resize, as it does not
        // work well with the active overlay
        this.doubleClickResizes = false;
        this.doubleClickFullScreen = false

        // check to see that the overlayView is set and derived from CNodeVideoView
        assert(this.overlayView !== undefined, "CNodeActiveOverlay:overlayView is undefined, this should be set in the constructor of the derived class")
        assert(this.overlayView instanceof CNodeVideoView, "CNodeActiveOverlay:overlayView is not an instance of CNodeVideoView, this should be set in the constructor of the derived class")

        this.draggable  = []

    }


    resetDraggable() {
        this.draggable = [];
        this.keyframes = [];
        this.recalculateCascade();
    }

    add(draggable) {
        this.draggable.push(draggable)
        return draggable;
    }


    renderCanvas(frame) {
        super.renderCanvas(frame)

        if (!this.showTracking) return;
        
        const ctx = this.ctx
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5
        this.draggable.forEach(
                  d => {
                        d.render(ctx)
                  }
        )
    }


    onMouseWheel(e, mouseX, mouseY) {
        // pass to the  overlayView
        if (this.overlayView.onMouseWheel) {
            this.overlayView.onMouseWheel(e, mouseX, mouseY);
        } else {
            console.warn("CNodeActiveOverlay: onMouseWheel called, but overlayView does not have an onMouseWheel method");
        }
    }

    doubleClick(e, mouseX, mouseY) {
        // pass to the overlayView
        if (this.overlayView.doubleClick) {
            this.overlayView.doubleClick(e, mouseX, mouseY);
        } else {
            console.warn("CNodeActiveOverlay: doubleClick called, but overlayView does not have an doubleClick method");
        }
    }


    onMouseDown(e, mouseX, mouseY) {
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY)

        const x = cx;
        const y = cy;

        this.lastMouseX = x
        this.lastMouseY = y
        for (const d of this.draggable) {
            if (d.isWithin(x, y)) {
                console.log("Clicked on draggable item, starting drag")
                d.startDrag(x, y)
                return true;
            }
        }
        return false;
    }

    onMouseUp(e, mouseX, mouseY) {
        console.log("Mouse up, stopping drag")
        this.draggable.forEach(d => {
            d.dragging = false
        })
    }

    onMouseDrag(e, mouseX, mouseY) {
        const [x, y] = mouseToCanvas(this, mouseX, mouseY)

        // delta x and y in canvas pixels
        const dx = x - this.lastMouseX
        const dy = y - this.lastMouseY


        this.draggable.forEach(d => {
            if (d.dragging) {
                // get the coords of c as canvas coordinates
                let cX = d.cX;
                let cY = d.cY;
                // now add the delta to the canvas coordinates
                cX += dx;
                cY += dy;
                // and convert back to video coordinates (original coords for storage)
                const [vX, vY] = d.video.canvasToVideoCoordsOriginal(cX, cY);
                // set the x and y of the draggable item to the new video coordinates
                d.x = vX;
                d.y = vY;


                this.recalculateCascade();

            }
        })

        this.lastMouseX = x
        this.lastMouseY = y
    }

}


class CNodeVideoTrackKeyframe extends CDraggableCircle{
    constructor(v) {
        super(v);
        this.frame = v.frame;
        this.view = v.view
    }

    startDrag(x, y) {

        par.frame = this.frame;
        par.paused = true;
        super.startDrag(x,y);
    }
}


export class CNodeTrackingOverlay extends CNodeActiveOverlay {
    constructor(v) {
        super(v);

        this.input("cameraLOSNode")
        this.input("fovNode")

        this.setGUI(v,"traverse");

        this.manualTrackingFolder = this.gui.addFolder("Manual Tracking").close();

        this.showTracking = true;

        this.manualTrackingFolder.add(this, "showTracking").name(t("trackingOverlay.showTracking.label")).listen()
            .tooltip(t("trackingOverlay.showTracking.tooltip"))

        this.manualTrackingFolder.add(this, "resetDraggable").name(t("trackingOverlay.reset.label"))
            .tooltip(t("trackingOverlay.reset.tooltip"))


        this.limitAB = false;
        this.manualTrackingFolder.add(this, "limitAB").name(t("trackingOverlay.limitAB.label")).listen().onChange(() => {

            if (this.limitAB && this.keyframes.length > 0) {
                this.applyLimitAB();
            } else {
                Sit.aFrame = 0;
                Sit.bFrame = Sit.frames - 1;
            }

            NodeMan.recalculateAllRootFirst();
        })
            .tooltip(t("trackingOverlay.limitAB.tooltip"))

        this.curveType = "Spline2";
        this.manualTrackingFolder.add(this, "curveType", ["Spline", "Spline2", "Linear", "Perspective"]).name(t("trackingOverlay.curveType.label")).listen().onChange(() => {
            if (this.curveType === "Perspective") {
                const traverseSelect = NodeMan.get("LOSTraverseSelectTrack", false);
                if (traverseSelect && traverseSelect.inputs["Perspective"]) {
                    traverseSelect.selectOption("Perspective");
                    traverseSelect.controller.updateDisplay();
                }
                this.minimizeGroundSpeed();
            }
            this.recalculateCascade();
        })
            .tooltip(t("trackingOverlay.curveType.tooltip"))

        this.manualTrackingFolder.add(this, "minimizeGroundSpeed").name(t("trackingOverlay.minimizeGroundSpeed.label"))
            .tooltip(t("trackingOverlay.minimizeGroundSpeed.tooltip"))

        this.manualTrackingFolder.add(this, "minimizeAirSpeed").name(t("trackingOverlay.minimizeAirSpeed.label"))
            .tooltip(t("trackingOverlay.minimizeAirSpeed.tooltip"))

        this.separateVisibility = true; // don't propagate visibility to the overlaid view

        // Remove the old conditional contextmenu handler to avoid interfering with custom context menu
        // document.addEventListener('contextmenu', function (event) {
        //     if (event.ctrlKey) {
        //         event.preventDefault();
        //     }
        // });

        this.keyframes = [];

        this.updateCurve();



    }

    applyLimitAB() {
        // get the frame of the first keyframe
        const A = this.keyframes[0].frame;
        // get the frame of the last keyframe
        const B = this.keyframes[this.keyframes.length - 1].frame;
        // 10% of that span
        const tenPercent = (B - A) / 10;
        // set the A frame to 10% before
        Sit.aFrame = Math.floor(A - tenPercent);
        // set the B frame to 10% after
        Sit.bFrame = Math.floor(B + tenPercent);
        // check for limits
        if (Sit.aFrame < 0) Sit.aFrame = 0;
        if (Sit.bFrame >= Sit.frames) Sit.bFrame = Sit.frames - 1;
    }

    minimizeGroundSpeed() {
        this.minimizeTraverseSpeed(false);
    }

    minimizeAirSpeed() {
        this.minimizeTraverseSpeed(true);
    }

    hasVideoGeometry() {
        const overlayView = this.overlayView;
        return overlayView !== undefined &&
            overlayView.videoWidth > 0 &&
            overlayView.videoHeight > 0 &&
            overlayView.originalVideoWidth > 0 &&
            overlayView.originalVideoHeight > 0;
    }

    ensureOverlayGeometryReady() {
        if (!this.hasVideoGeometry()) {
            return false;
        }

        // Tracking math uses the video view's cached geometry values, so refresh them lazily here
        // when the LOS graph is evaluated before the video view has rendered this frame.
        if ((!Number.isFinite(this.overlayView.fovCoverage) || this.overlayView.fovCoverage <= 0) &&
            this.overlayView.widthPx > 0 &&
            this.overlayView.heightPx > 0 &&
            this.overlayView.getSourceAndDestCoords) {
            this.overlayView.getSourceAndDestCoords();
        }

        return Number.isFinite(this.overlayView.fovCoverage) && this.overlayView.fovCoverage > 0;
    }

    getFallbackTrackPoint() {
        // These placeholders are only used while no video exists. Once a video loads,
        // the existing videoLoaded hook triggers a recalc and replaces them with real video coordinates.
        return [this.overlayView.widthPx / 2, this.overlayView.heightPx / 2];
    }

    minimizeTraverseSpeed(useAirSpeed = false) {
        const traverseNode = NodeMan.get("LOSTraversePerspective", false);
        const startDistNode = NodeMan.get("startDistance", false);
        if (!traverseNode || !startDistNode) {
            console.warn("minimizeTraverseSpeed: required nodes not found");
            return;
        }

        if (this.keyframes.length < 3) {
            console.warn("minimizeTraverseSpeed: need at least 3 keyframes");
            return;
        }

        const windNode = useAirSpeed ? NodeMan.get("targetWind", false) : null;
        if (useAirSpeed && !windNode) {
            console.warn("minimizeTraverseSpeed: targetWind node not found for air speed calculation");
            return;
        }

        const minDistNM = 0.00;
        const maxDistNM = 200;

        const calcTraverseDistance = (distNM) => {
            assert(!traverseNode._needsRecalculate,
                "minimizeTraverseSpeed assumes traverse node is already materialized");
            startDistNode.value = distNM;
            startDistNode.recalculate();
            traverseNode.recalculate();
            const Ta = this.keyframes[0].frame;
            const Tc = this.keyframes[this.keyframes.length - 1].frame;
            const P_A = traverseNode.getValueFrame(Ta).position;
            const P_C = traverseNode.getValueFrame(Tc).position;

            if (!useAirSpeed) {
                return P_A.distanceTo(P_C);
            }

            const groundDisplacement = P_C.clone().sub(P_A);
            const numFrames = Tc - Ta;
            const windPerFrame = windNode.getValueFrame(0, P_A);
            const totalWindDisplacement = windPerFrame.clone().multiplyScalar(numFrames);
            const airDisplacement = groundDisplacement.clone().sub(totalWindDisplacement);
            return airDisplacement.length();
        };

        const phi = (1 + Math.sqrt(5)) / 2;
        let a = minDistNM, b = maxDistNM;
        let c = b - (b - a) / phi;
        let d = a + (b - a) / phi;
        const tol = 0.0000001;

        while (Math.abs(b - a) > tol) {
            if (calcTraverseDistance(c) < calcTraverseDistance(d)) {
                b = d;
            } else {
                a = c;
            }
            c = b - (b - a) / phi;
            d = a + (b - a) / phi;
        }

        const optimalDistNM = (a + b) / 2;
        startDistNode.setValue(optimalDistNM);
        startDistNode.guiEntry.updateDisplay();
        NodeMan.recalculateAllRootFirst();
    }

    getValueFrame(f) {
        const cameraLOSNode = this.in.cameraLOSNode
        const fovNode = this.in.fovNode
        const los = cameraLOSNode.getValueFrame(f)

        // "Camera + Object Track" only makes sense once the overlay has a real video coordinate system.
        // Without a loaded video, fall back to the plain camera LOS instead of manufacturing NaNs.
        if (!this.ensureOverlayGeometryReady()) {
            return los;
        }

        const vFOV = extractFOV(fovNode.getValueFrame(f));

        // x and y are in original video coordinates, which are pixels
        const [vx, vy] = this.pointsXY[f];

        // Pointing angles computed ENTIRELY in original-video pixel space.
        // The old path round-tripped through the live canvas (letterbox
        // fovCoverage, widthPx/heightPx from div.clientWidth, zoom, and a
        // panOffset zero/restore hack) purely to invert the display mapping.
        // That transform cancels analytically (verified for both letterbox
        // branches), but it made the physical LOS depend on window/layout
        // state down to float rounding — and it mixed zoom.v0 (inside the
        // mapping) with zoom.v(f) (in the unscale). Direct form: the video's
        // vertical FOV spans originalVideoHeight pixels, so the focal length
        // in original pixels is oh / (2 tan(vFOV/2)).
        const ow = this.overlayView.originalVideoWidth;
        const oh = this.overlayView.originalVideoHeight;
        const fpx = oh / (2 * Math.tan(radians(vFOV) / 2));
        const xangle = -Math.atan((vx - ow / 2) / fpx);
        const yangle = -Math.atan((vy - oh / 2) / fpx);


        const up = los.up;
        const right = los.right;
        const heading = los.heading;

        // rotate the heading and right vector by xangle about the up vector
        // and then the new headin by yangle about the new right vector
        const newHeading = heading.clone().applyAxisAngle(up, xangle)
        const newRight = right.clone().applyAxisAngle(up, xangle)
        newHeading.applyAxisAngle(newRight, yangle)

        los.heading = newHeading;

        // up and right are no longer valid
        // could update them, but they are not used.
        los.up = undefined;
        los.right = undefined;

        assert(!isNaN(los.heading.x) && !isNaN(los.heading.y) && !isNaN(los.heading.z), "CNodeTrackingOverlay:getValueFrame: los.heading is NaN at frame " + f);


        return los;

    }

    recalculate() {
        this.updateCurve();
    }

    // Public accessor for the interpolated track point (original-video pixels) at frame f.
    // Lets other nodes (e.g. CNodeLensGhost's fit) read the track without reaching into the
    // private pointsXY buffer. Returns [x,y] or null if not available.
    getTrackPixelXY(f) {
        this.updateCurve();
        const i = Math.floor(f);
        if (!this.pointsXY || i < 0 || i >= this.pointsXY.length) return null;
        return this.pointsXY[i];
    }

    // Frame range that actually has keyframe data (outside this the track is extrapolated).
    getKeyframeSpan() {
        if (!this.keyframes || this.keyframes.length < 2) return null;
        const fr = this.keyframes.map(k => k.frame).sort((a, b) => a - b);
        return [fr[0], fr[fr.length - 1]];
    }

    // we now use video coordiantes
    updateCurve() {
        // Get the total number of frames
        this.frames = Sit.frames;


        // Sort keyframes by frame
        this.keyframes.sort((a, b) => a.frame - b.frame);

        // Create a new curve as an empty array of points
        this.pointsXY = new Array(this.frames).fill(0).map(() => [0, 0]);

        // Handle special cases first
        if (this.keyframes.length === 0) {
            // No keyframes, set all points to middle (50, 50)
            let centerX;
            let centerY;

            if (this.hasVideoGeometry()) {
                // Once video dimensions exist, store the default track point in original-video coordinates.
                const viewWidth = this.overlayView.widthPx;
                const viewHeight = this.overlayView.heightPx;
                [centerX, centerY] = this.overlayView.canvasToVideoCoordsOriginal(viewWidth / 2, viewHeight / 2);
            } else {
                // Before a video loads we still need finite placeholders, but they should not try to
                // pretend canvas space is video space.
                [centerX, centerY] = this.getFallbackTrackPoint();
            }

            for (let i = 0; i < this.frames; i++) {
                this.pointsXY[i] = [centerX, centerY];
            }
            return;
        } else if (this.keyframes.length === 1) {
            // One keyframe, set all points to that keyframe
            const point = [this.keyframes[0].x, this.keyframes[0].y];
            for (let i = 0; i < this.frames; i++) {
                this.pointsXY[i] = [...point];
            }
            return;
        } else if (this.keyframes.length === 2) {
            // Two keyframes, use linear interpolation
            const k1 = this.keyframes[0];
            const k2 = this.keyframes[1];

            // Guard against duplicate keyframes at the same frame (div by zero)
            if (k1.frame === k2.frame) {
                const point = [(k1.x + k2.x) / 2, (k1.y + k2.y) / 2];
                for (let i = 0; i < this.frames; i++) {
                    this.pointsXY[i] = [...point];
                }
                return;
            }

            for (let i = 0; i < this.frames; i++) {
                if (i <= k1.frame) {
                    // Before first keyframe, extrapolate linearly
                    const t = (i - k1.frame) / (k2.frame - k1.frame);
                    this.pointsXY[i] = [
                        k1.x + t * (k2.x - k1.x),
                        k1.y + t * (k2.y - k1.y)
                    ];
                } else if (i >= k2.frame) {
                    // After last keyframe, extrapolate linearly
                    const t = (i - k2.frame) / (k2.frame - k1.frame);
                    this.pointsXY[i] = [
                        k2.x + t * (k2.x - k1.x),
                        k2.y + t * (k2.y - k1.y)
                    ];
                } else {
                    // Between keyframes, interpolate linearly
                    const t = (i - k1.frame) / (k2.frame - k1.frame);
                    this.pointsXY[i] = [
                        k1.x + t * (k2.x - k1.x),
                        k1.y + t * (k2.y - k1.y)
                    ];
                }
            }
            return;
        }

        // Three or more keyframes
        const frames = this.keyframes.map(k => k.frame);
        const xCoords = this.keyframes.map(k => k.x);
        const yCoords = this.keyframes.map(k => k.y);

        if (this.curveType === "Linear") {
            // Linear interpolation between keyframes
            for (let i = 0; i < this.frames; i++) {
                if (i <= frames[0]) {
                    // Before/at first keyframe - linear extrapolation from first two keyframes
                    const t = (i - frames[0]) / (frames[1] - frames[0]);
                    this.pointsXY[i] = [
                        xCoords[0] + t * (xCoords[1] - xCoords[0]),
                        yCoords[0] + t * (yCoords[1] - yCoords[0])
                    ];
                } else if (i >= frames[frames.length - 1]) {
                    // After/at last keyframe - linear extrapolation from last two keyframes
                    const n = frames.length;
                    const t = (i - frames[n - 1]) / (frames[n - 1] - frames[n - 2]);
                    this.pointsXY[i] = [
                        xCoords[n - 1] + t * (xCoords[n - 1] - xCoords[n - 2]),
                        yCoords[n - 1] + t * (yCoords[n - 1] - yCoords[n - 2])
                    ];
                } else {
                    // Find which segment we're in
                    let segIdx = 0;
                    while (segIdx < frames.length - 1 && i > frames[segIdx + 1]) {
                        segIdx++;
                    }
                    const t = (i - frames[segIdx]) / (frames[segIdx + 1] - frames[segIdx]);
                    this.pointsXY[i] = [
                        xCoords[segIdx] + t * (xCoords[segIdx + 1] - xCoords[segIdx]),
                        yCoords[segIdx] + t * (yCoords[segIdx + 1] - yCoords[segIdx])
                    ];
                }
            }
        } else if (this.curveType === "Spline2") {
            const n = frames.length;
            const startSlopeX = (xCoords[1] - xCoords[0]) / (frames[1] - frames[0]);
            const startSlopeY = (yCoords[1] - yCoords[0]) / (frames[1] - frames[0]);
            const endSlopeX = (xCoords[n - 1] - xCoords[n - 2]) / (frames[n - 1] - frames[n - 2]);
            const endSlopeY = (yCoords[n - 1] - yCoords[n - 2]) / (frames[n - 1] - frames[n - 2]);

            const h0 = frames[1] - frames[0];
            const hLast = frames[n - 1] - frames[n - 2];

            const extFrames = [frames[0] - h0, ...frames, frames[n - 1] + hLast];
            const extX = [xCoords[0] - h0 * startSlopeX, ...xCoords, xCoords[n - 1] + hLast * endSlopeX];
            const extY = [yCoords[0] - h0 * startSlopeY, ...yCoords, yCoords[n - 1] + hLast * endSlopeY];

            for (let i = 0; i < this.frames; i++) {
                if (i < frames[0]) {
                    const t = i - frames[0];
                    this.pointsXY[i] = [
                        xCoords[0] + t * startSlopeX,
                        yCoords[0] + t * startSlopeY
                    ];
                } else if (i > frames[n - 1]) {
                    const t = i - frames[n - 1];
                    this.pointsXY[i] = [
                        xCoords[n - 1] + t * endSlopeX,
                        yCoords[n - 1] + t * endSlopeY
                    ];
                } else {
                    this.pointsXY[i] = this.centripetalCatmullRom(i, extFrames, extX, extY);
                }
            }
        } else if (this.curveType === "Perspective") {
            // Perspective projection model for an object moving linearly in 3D space.
            // When an object moves at constant velocity, its projected screen position
            // follows a rational function (not linear) due to perspective division.
            //
            // Uses exactly 3 keyframes: A, B, C at times Ta, Tb, Tc
            //   - (uA, vA), (uB, vB), (uC, vC) are the screen coordinates at each keyframe
            //   - tau = t - Ta is time relative to the first keyframe
            //
            // The perspective projection formula is:
            //   u(t) = (uA + a1 * tau) / (1 + d * tau)
            //   v(t) = (vA + b1 * tau) / (1 + d * tau)
            //
            // Where:
            //   - uA, vA: initial screen position at keyframe A
            //   - a1, b1: linear velocity terms in screen space (before perspective division)
            //   - d: perspective depth rate - how fast the object approaches/recedes from camera
            //        d > 0 means object is approaching (denominator decreases, object grows)
            //        d < 0 means object is receding (denominator increases, object shrinks)
            //        d = 0 degenerates to linear motion (no perspective effect)
            //
            // The denominator (1 + d * tau) represents the relative depth change over time.
            // When it approaches zero, the object is at or behind the camera.
            const uA = xCoords[0], uB = xCoords[1], uC = xCoords[2];
            const vA = yCoords[0], vB = yCoords[1], vC = yCoords[2];
            const Ta = frames[0], Tb = frames[1], Tc = frames[2];

            const tauB = Tb - Ta;
            const tauC = Tc - Ta;

            // d = [(uC - uA)/τC - (uB - uA)/τB] / (uB - uC)
            const denominator = uB - uC;
            let d, a1, b1;

            if (Math.abs(denominator) < 1e-10) {
                // Degenerate case: uB ≈ uC, fall back to linear
                d = 0;
                a1 = (uB - uA) / tauB;
                b1 = (vB - vA) / tauB;
            } else {
                d = ((uC - uA) / tauC - (uB - uA) / tauB) / denominator;
                a1 = (uB - uA) / tauB + uB * d;
                b1 = (vB - vA) / tauB + vB * d;
            }

            const minDenom = 0.01;
            let tauEdge, xEdge, yEdge, dxEdge, dyEdge;

            if (Math.abs(d) > 1e-10) {
                tauEdge = (minDenom - 1) / d;
                xEdge = (uA + a1 * tauEdge) / minDenom;
                yEdge = (vA + b1 * tauEdge) / minDenom;
                dxEdge = (a1 - uA * d) / (minDenom * minDenom);
                dyEdge = (b1 - vA * d) / (minDenom * minDenom);
            }

            for (let i = 0; i < this.frames; i++) {
                const tau = i - Ta;
                const denom = 1 + d * tau;

                if (denom <= minDenom && Math.abs(d) > 1e-10) {
                    // Object at or behind camera - use linear extrapolation from valid edge
                    const deltaTau = tau - tauEdge;
                    this.pointsXY[i] = [
                        xEdge + dxEdge * deltaTau,
                        yEdge + dyEdge * deltaTau
                    ];
                } else {
                    this.pointsXY[i] = [
                        (uA + a1 * tau) / denom,
                        (vA + b1 * tau) / denom
                    ];
                }
            }
        } else {
            // Cubic spline interpolation
            const xSpline = this.calculateCubicSpline(frames, xCoords);
            const ySpline = this.calculateCubicSpline(frames, yCoords);

            for (let i = 0; i < this.frames; i++) {
                if (i < frames[0]) {
                    // Before first keyframe - linear extrapolation
                    const slope = this.getInitialSlope(xSpline, ySpline);
                    const t = i - frames[0];
                    this.pointsXY[i] = [
                        xCoords[0] + t * slope.x,
                        yCoords[0] + t * slope.y
                    ];
                } else if (i > frames[frames.length - 1]) {
                    // After last keyframe - linear extrapolation
                    const slope = this.getFinalSlope(xSpline, ySpline);
                    const t = i - frames[frames.length - 1];
                    this.pointsXY[i] = [
                        xCoords[xCoords.length - 1] + t * slope.x,
                        yCoords[yCoords.length - 1] + t * slope.y
                    ];
                } else {
                    // Within keyframe range - cubic spline interpolation
                    this.pointsXY[i] = [
                        this.evaluateCubicSpline(i, frames, xSpline),
                        this.evaluateCubicSpline(i, frames, ySpline)
                    ];
                }
            }
        }
    }

// Calculate cubic spline coefficients
    calculateCubicSpline(x, y) {
        const n = x.length;
        const splines = new Array(n - 1);

        if (n < 2) return splines;

        if (n === 2) {
            // Special case for two points - linear interpolation
            splines[0] = {
                a: y[0],
                b: (y[1] - y[0]) / (x[1] - x[0]),
                c: 0,
                d: 0
            };
            return splines;
        }

        // Step 1: Calculate second derivatives
        const h = new Array(n - 1);
        const alpha = new Array(n - 1);
        const l = new Array(n);
        const mu = new Array(n - 1);
        const z = new Array(n);

        for (let i = 0; i < n - 1; i++) {
            h[i] = x[i + 1] - x[i];
        }

        for (let i = 1; i < n - 1; i++) {
            alpha[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
        }

        l[0] = 1;
        mu[0] = 0;
        z[0] = 0;

        for (let i = 1; i < n - 1; i++) {
            l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
            mu[i] = h[i] / l[i];
            z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
        }

        l[n - 1] = 1;
        z[n - 1] = 0;

        // Step 2: Back-substitution
        const c = new Array(n);
        c[n - 1] = 0;

        for (let j = n - 2; j >= 0; j--) {
            c[j] = z[j] - mu[j] * c[j + 1];
        }

        // Step 3: Calculate the remaining coefficients
        for (let i = 0; i < n - 1; i++) {
            splines[i] = {
                a: y[i],
                b: (y[i + 1] - y[i]) / h[i] - h[i] * (c[i + 1] + 2 * c[i]) / 3,
                c: c[i],
                d: (c[i + 1] - c[i]) / (3 * h[i])
            };
        }

        return splines;
    }

// Evaluate cubic spline at a given x
    evaluateCubicSpline(x, xValues, splines) {
        const n = xValues.length;

        // Find the appropriate interval
        let i = 0;
        while (i < n - 1 && x > xValues[i + 1]) {
            i++;
        }

        // Ensure we're within bounds
        if (i >= splines.length) i = splines.length - 1;

        // Calculate the value
        const dx = x - xValues[i];
        const spline = splines[i];

        return spline.a + spline.b * dx + spline.c * dx * dx + spline.d * dx * dx * dx;
    }

// Get the initial slope for extrapolation
    getInitialSlope(xSpline, ySpline) {
        // Use the first spline segment's first derivative at the start point
        return {
            x: xSpline[0].b,
            y: ySpline[0].b
        };
    }

// Get the final slope for extrapolation
    getFinalSlope(xSpline, ySpline) {
        const lastSegmentX = xSpline[xSpline.length - 1];
        const lastSegmentY = ySpline[ySpline.length - 1];

        // Compute h = x_n - x_{n-1}
        const h = this.keyframes[this.keyframes.length - 1].frame
            - this.keyframes[this.keyframes.length - 2].frame;

        return {
            x: lastSegmentX.b + 2 * lastSegmentX.c * h + 3 * lastSegmentX.d * h * h,
            y: lastSegmentY.b + 2 * lastSegmentY.c * h + 3 * lastSegmentY.d * h * h
        };
    }

    calculateClampedSpline(x, y, startSlope, endSlope) {
        const n = x.length;
        const splines = new Array(n - 1);

        if (n < 2) return splines;

        if (n === 2) {
            splines[0] = {
                a: y[0],
                b: startSlope,
                c: 0,
                d: 0
            };
            return splines;
        }

        const h = new Array(n - 1);
        for (let i = 0; i < n - 1; i++) {
            h[i] = x[i + 1] - x[i];
        }

        const A = [];
        const rhs = [];
        for (let i = 0; i < n; i++) {
            A.push(new Array(n).fill(0));
        }

        A[0][0] = 2 * h[0];
        A[0][1] = h[0];
        rhs.push(3 * ((y[1] - y[0]) / h[0] - startSlope));

        for (let i = 1; i < n - 1; i++) {
            A[i][i - 1] = h[i - 1];
            A[i][i] = 2 * (h[i - 1] + h[i]);
            A[i][i + 1] = h[i];
            rhs.push(3 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]));
        }

        A[n - 1][n - 2] = h[n - 2];
        A[n - 1][n - 1] = 2 * h[n - 2];
        rhs.push(3 * (endSlope - (y[n - 1] - y[n - 2]) / h[n - 2]));

        const c = this.solveTridiagonal(A, rhs, n);

        for (let i = 0; i < n - 1; i++) {
            splines[i] = {
                a: y[i],
                b: (y[i + 1] - y[i]) / h[i] - h[i] * (c[i + 1] + 2 * c[i]) / 3,
                c: c[i],
                d: (c[i + 1] - c[i]) / (3 * h[i])
            };
        }

        return splines;
    }

    calculateNotAKnotSpline(x, y) {
        const n = x.length;
        const splines = new Array(n - 1);

        if (n < 2) return splines;

        if (n === 2) {
            splines[0] = {
                a: y[0],
                b: (y[1] - y[0]) / (x[1] - x[0]),
                c: 0,
                d: 0
            };
            return splines;
        }

        if (n === 3) {
            const h0 = x[1] - x[0];
            const h1 = x[2] - x[1];
            const d0 = (y[1] - y[0]) / h0;
            const d1 = (y[2] - y[1]) / h1;
            const c1 = (d1 - d0) / (h0 + h1);
            splines[0] = { a: y[0], b: d0 - c1 * h0, c: c1, d: 0 };
            splines[1] = { a: y[1], b: d0 + c1 * h0, c: c1, d: 0 };
            return splines;
        }

        const h = new Array(n - 1);
        for (let i = 0; i < n - 1; i++) {
            h[i] = x[i + 1] - x[i];
        }

        const A = [];
        const rhs = [];

        for (let i = 0; i < n; i++) {
            A.push(new Array(n).fill(0));
        }

        A[0][0] = h[1];
        A[0][1] = -(h[0] + h[1]);
        A[0][2] = h[0];
        rhs.push(0);

        for (let i = 1; i < n - 1; i++) {
            A[i][i - 1] = h[i - 1];
            A[i][i] = 2 * (h[i - 1] + h[i]);
            A[i][i + 1] = h[i];
            rhs.push(3 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]));
        }

        A[n - 1][n - 3] = h[n - 2];
        A[n - 1][n - 2] = -(h[n - 3] + h[n - 2]);
        A[n - 1][n - 1] = h[n - 3];
        rhs.push(0);

        const c = this.solveTridiagonal(A, rhs, n);

        for (let i = 0; i < n - 1; i++) {
            splines[i] = {
                a: y[i],
                b: (y[i + 1] - y[i]) / h[i] - h[i] * (c[i + 1] + 2 * c[i]) / 3,
                c: c[i],
                d: (c[i + 1] - c[i]) / (3 * h[i])
            };
        }

        return splines;
    }

    solveTridiagonal(A, rhs, n) {
        const x = new Array(n).fill(0);
        const Acopy = A.map(row => [...row]);
        const b = [...rhs];

        for (let i = 0; i < n - 1; i++) {
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(Acopy[k][i]) > Math.abs(Acopy[maxRow][i])) {
                    maxRow = k;
                }
            }
            [Acopy[i], Acopy[maxRow]] = [Acopy[maxRow], Acopy[i]];
            [b[i], b[maxRow]] = [b[maxRow], b[i]];

            for (let k = i + 1; k < n; k++) {
                if (Math.abs(Acopy[i][i]) < 1e-12) continue;
                const factor = Acopy[k][i] / Acopy[i][i];
                for (let j = i; j < n; j++) {
                    Acopy[k][j] -= factor * Acopy[i][j];
                }
                b[k] -= factor * b[i];
            }
        }

        for (let i = n - 1; i >= 0; i--) {
            let sum = b[i];
            for (let j = i + 1; j < n; j++) {
                sum -= Acopy[i][j] * x[j];
            }
            x[i] = Math.abs(Acopy[i][i]) < 1e-12 ? 0 : sum / Acopy[i][i];
        }

        return x;
    }

    getInitialSlopeNAK(xSpline, ySpline) {
        return {
            x: xSpline[0].b,
            y: ySpline[0].b
        };
    }

    getFinalSlopeNAK(xSpline, ySpline, frames) {
        const lastSegmentX = xSpline[xSpline.length - 1];
        const lastSegmentY = ySpline[ySpline.length - 1];
        const h = frames[frames.length - 1] - frames[frames.length - 2];

        return {
            x: lastSegmentX.b + 2 * lastSegmentX.c * h + 3 * lastSegmentX.d * h * h,
            y: lastSegmentY.b + 2 * lastSegmentY.c * h + 3 * lastSegmentY.d * h * h
        };
    }

    centripetalCatmullRom(frameIdx, frames, xCoords, yCoords) {
        const n = frames.length;

        let segIdx = 0;
        while (segIdx < n - 2 && frameIdx > frames[segIdx + 1]) segIdx++;

        const i0 = Math.max(0, segIdx - 1);
        const i1 = segIdx;
        const i2 = segIdx + 1;
        const i3 = Math.min(n - 1, segIdx + 2);

        const p0 = { x: xCoords[i0], y: yCoords[i0], t: frames[i0] };
        const p1 = { x: xCoords[i1], y: yCoords[i1], t: frames[i1] };
        const p2 = { x: xCoords[i2], y: yCoords[i2], t: frames[i2] };
        const p3 = { x: xCoords[i3], y: yCoords[i3], t: frames[i3] };

        const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

        const d01 = Math.pow(dist(p0, p1), 0.5);
        const d12 = Math.pow(dist(p1, p2), 0.5);
        const d23 = Math.pow(dist(p2, p3), 0.5);

        const t0 = 0;
        const t1 = t0 + (d01 || 1);
        const t2 = t1 + (d12 || 1);
        const t3 = t2 + (d23 || 1);

        const frameU = (frameIdx - p1.t) / (p2.t - p1.t);
        const t = t1 + frameU * (t2 - t1);

        const lerp = (a, b, aT, bT, targetT) => {
            if (Math.abs(bT - aT) < 1e-10) return { x: a.x, y: a.y };
            const u = (targetT - aT) / (bT - aT);
            return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) };
        };

        const a1 = lerp(p0, p1, t0, t1, t);
        const a2 = lerp(p1, p2, t1, t2, t);
        const a3 = lerp(p2, p3, t2, t3, t);

        const b1 = lerp(a1, a2, t0, t2, t);
        const b2 = lerp(a2, a3, t1, t3, t);

        const c = lerp(b1, b2, t1, t2, t);

        return [c.x, c.y];
    }

    catmullRomInterpolate(t, times, values) {
        const n = times.length;

        if (t <= times[0]) {
            const slope = (values[1] - values[0]) / (times[1] - times[0]);
            return values[0] + slope * (t - times[0]);
        }
        if (t >= times[n - 1]) {
            const slope = (values[n - 1] - values[n - 2]) / (times[n - 1] - times[n - 2]);
            return values[n - 1] + slope * (t - times[n - 1]);
        }

        let i = 1;
        while (i < n - 1 && t > times[i]) i++;

        const i0 = Math.max(0, i - 2);
        const i1 = i - 1;
        const i2 = i;
        const i3 = Math.min(n - 1, i + 1);

        const t0 = times[i0], t1 = times[i1], t2 = times[i2], t3 = times[i3];
        const p0 = values[i0], p1 = values[i1], p2 = values[i2], p3 = values[i3];

        const u = (t - t1) / (t2 - t1);

        const m1 = (t2 - t1) * ((p1 - p0) / (t1 - t0 || 1) + (p2 - p1) / (t2 - t1)) / 2;
        const m2 = (t2 - t1) * ((p2 - p1) / (t2 - t1) + (p3 - p2) / (t3 - t2 || 1)) / 2;

        const u2 = u * u;
        const u3 = u2 * u;

        return (2 * u3 - 3 * u2 + 1) * p1 +
               (u3 - 2 * u2 + u) * m1 +
               (-2 * u3 + 3 * u2) * p2 +
               (u3 - u2) * m2;
    }





    onMouseDown(e, mouseX, mouseY) {
        if (!this.hasVideoGeometry()) {
            return false;
        }

        // if we clicked on a draggable item, then we return true
        // we don't need to check this
        if (!e.ctrlKey && super.onMouseDown(e, mouseX, mouseY)) {
            // this means we clicked on a draggable item
            // check to see if the alt key is down
            // if so, we remove the item from the lists
            if (e.altKey) {
                this.draggable = this.draggable.filter(d => !d.dragging)

                // remove the keyframe from the keyframes array
                this.keyframes = this.keyframes.filter(k => !k.dragging)

                this.recalculateCascade();

                // no dispose is needed
            }


           // if (!e.ctrlKey)
           //     return true;
        }

        const [x, y] = mouseToCanvas(this, mouseX, mouseY)

        const [vX, vY] = this.overlayView.canvasToVideoCoordsOriginal(x, y);

         if (e.ctrlKey) {
            // control key means we add a new one at this frame
             // we disable the default action
                e.preventDefault();

            // Forbid placing keyframes on a held (synthesized) virtual frame.
            // Held frames have no unique pixels — they reuse the bracketing
            // real source frame — so a keyframe authored there would collapse
            // onto the canonical V at save time and lose information. Force
            // the user to scrub to a real frame instead.
            const videoData = this.overlayView?.videoData;
            if (videoData && videoData.isHeldFrame && videoData.isHeldFrame(par.frame)) {
                const sourceV = videoData.sourceToVirtual(videoData.virtualToSource(par.frame));
                console.warn(`[TrackingOverlay] frame ${par.frame} is a held (duplicate) frame; scrub to frame ${sourceV} or the next real frame to place a keyframe.`);
                return;
            }

            // interate over keyframes and find if there is one at this frame
            let found = false;
            for (const k of this.keyframes) {
                if (k.frame === par.frame) {
                    found = true;

                    // move it to the new position
                    k.x = vX;
                    k.y = vY;
                    this.recalculateCascade();


                    break;
                }
            }

            if (!found) {
                console.log("Adding a new keyframe at frame ", par.frame)
                this.keyframes.push(this.add(new CNodeVideoTrackKeyframe({
                    view: this,
                    x: x,
                    y: y,
                    frame: par.frame
                })))
                this.recalculateCascade();
            }

         }


    }

    renderCanvas(frame) {
        super.renderCanvas(frame) // will be CNodeViewCanvas2D

        if (!this.showTracking) return;

        // Without video geometry there is nothing meaningful to draw or project into LOS space yet.
        if (!this.hasVideoGeometry()) return;

        // The tracking overlay is based on integer frames
        frame = Math.floor(frame);

        this.updateCurve();

        // iterate over keyframes and render lines between them
        const ctx = this.ctx
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5

        // iterate over points and render the curve
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2.5
        ctx.beginPath();
        const [x0, y0] = this.pointsXY[0]
        // convert to canvas coordinates (from original video coords)
        const [cX0, cY0] = this.overlayView.videoToCanvasCoordsOriginal(x0, y0);

        ctx.moveTo(cX0, cY0);
        for (let i = 0; i < this.frames; i++) {
            const [vx, vy] = this.pointsXY[i]
            const [x, y] = this.overlayView.videoToCanvasCoordsOriginal(vx, vy);
            ctx.lineTo(x, y)
        }
        ctx.stroke();

        assert (this.pointsXY[frame] !== undefined, "CNodeTrackingOverlay:renderCanvas: pointsXY[frame] is undefined, this.frames = "+this.frames+", frame = "+frame, "Sit.frames = "+Sit.frames)

        // find the XY position for the current frame
        // and render a circle there
        const [vx, vy] = this.pointsXY[frame];
        const [x, y] = this.overlayView.videoToCanvasCoordsOriginal(vx, vy);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI);

        ctx.stroke();

    }

    modSerialize() {
        // Persist keyframe frame numbers as source-indexed when the
        // videoData is a CVideoPatchedData wrapper, so saves are stable
        // across patching toggles, fps changes, and re-imports of the same
        // source TS. frameSpace flag distinguishes new-format saves from
        // legacy saves where source/virtual were the same axis.
        const videoData = this.overlayView?.videoData;
        const useSource = videoData && typeof videoData.virtualToSource === "function";
        const toSource = useSource ? (V) => videoData.virtualToSource(V) : (V) => V;
        return {
            ...super.modSerialize(),
            curveType: this.curveType,
            frameSpace: useSource ? "source" : "virtual",
            keyframes: this.keyframes.map(k => {
                return {
                    x: k.x,
                    y: k.y,
                    frame: toSource(k.frame)
                }
            })
        }
    }

    // here's and old one in case you want to be more backward compatible.
    // https://local.metabunk.org/sitrec/?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Mosul%20Orb/20250701_215755.js
    // and a new one
    // https://local.metabunk.org/sitrec/?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Mosul%20Orb/20250706_234314.js


    modDeserialize(v) {
        this.draggable = [];
     //   super.modDeserialize(v);
        if (v.curveType !== undefined) {
            this.curveType = v.curveType;
        }
        // frameSpace marks whether saved frame numbers are source-indexed
        // (new format, set by modSerialize when wrapping is active) or
        // virtual/legacy. We stash it and apply the source->virtual
        // translation once the video has loaded — the wrapper doesn't
        // exist yet at deserialize time.
        this._savedFrameSpace = v.frameSpace || "virtual";
        this.keyframes = v.keyframes.map(k => {
            const newKeyframe = this.add(new CNodeVideoTrackKeyframe({
                view: this,
                x: k.x,
                y: k.y,
                frame: k.frame,
                coordinatesAreVideo: true
            }))
            if (Globals.exportTagNumber < 2001001) {
                console.log("exportTagNumber is less than 2001001 (" + Globals.exportTagNumber + "), converting keyframe coordinates to video coordinates");
                // old format x, and y are as % of the video height
                // so we need to convert them to video coordinates
                // PROBLEM. The video has not yet been loaded, so we can't use the video height
                // newKeyframe.x = k.x * this.overlayView.imageHeight / 100;
                // newKeyframe.y = k.y * this.overlayView.imageHeight / 100;

                let h = 720; // PATCH, for legacy Mosul Orb videos

                // if (this.overlayView.imageHeight > 100 )
                //     h = this.overlayView.imageHeight;

                newKeyframe.x = k.x * h / 100;
                newKeyframe.y = k.y * h / 100;


            } else {
                newKeyframe.x = k.x;
                newKeyframe.y = k.y;
            }
            return newKeyframe;
        })

        const onVideoLoaded = () => {
            EventManager.removeEventListener("videoLoaded", onVideoLoaded);
            // Translate saved source-indexed frame numbers to virtual now
            // that the wrapper exists. For legacy saves (frameSpace
            // undefined / "virtual") we leave them alone.
            const videoData = this.overlayView?.videoData;
            if (this._savedFrameSpace === "source" &&
                videoData && typeof videoData.sourceToVirtual === "function") {
                for (const k of this.keyframes) {
                    k.frame = videoData.sourceToVirtual(k.frame);
                }
            }
            this.recalculateCascade();
        };
        EventManager.addEventListener("videoLoaded", onVideoLoaded);
    }

}
