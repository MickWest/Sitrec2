// While "Fit Camera to Points" is on, zooming or dragging the LOOK view drives the VIDEO's zoom
// and pan instead of the 3D camera, so the two stay framed identically.
//
// The rendering half of this already exists and is not new: the look view is created with
// syncVideoZoom, so it reframes itself to whatever the video's zoom and pan are (see CNodeView3D).
// What was missing is the other direction. Placing a control point is a matter of finding the same
// feature twice, once in the footage and once in the world, which means zooming a long way into
// both — and the only way to zoom the 3D was to move the camera, which is the very thing being
// solved for. Nudging it desynchronised the two pictures and, worse, changed the answer.
//
// So during a fit the look view stops being a camera you fly and becomes a second window onto the
// video's framing: the wheel and the left drag are forwarded here, and the 3D follows because it
// was already following. Turn the fit off and every control goes back to what it was.

import {NodeMan, setRenderOne} from "./Globals";
import {mouseToView, renderedRect} from "./ViewUtils";

/** Same 10% per notch the video view uses, so a wheel click means the same thing in both. */
const WHEEL_SCALE = 0.9;

/**
 * Should this view's zoom/pan be forwarded to the video?
 *
 * Deliberately narrow. syncVideoZoom is required because without it the look view does NOT reframe
 * to the video, so driving the video's pan would move one picture and not the other — worse than
 * doing nothing. And a videoZoom node is required because that is where the zoom actually lives;
 * the pos-based fallback path in CNodeVideoView zooms by moving the view's own rectangle, which the
 * 3D has no way to follow.
 *
 * The switch is "Sync Look Camera", not "Enable Fit". Taking the 3D camera away is the right
 * default while judging a fit and the wrong one while reading the scene, and those alternate
 * within a single session with the fit left on throughout — so the user gets a control for it.
 * See CNodeFitCameraPoints.setSyncLookCamera.
 */
export function fitViewSyncActive(view) {
    if (!view || view.id !== "lookView" || !view.syncVideoZoom) return false;
    const fit = NodeMan.get("fitCameraPoints", false);
    if (!fit || !fit.syncLookCamera) return false;
    if (!NodeMan.exists("videoZoom")) return false;
    const video = NodeMan.get("video", false);
    return !!video && video.videoWidth > 0 && video.videoHeight > 0;
}

/**
 * Where the pointer is in the video frame, as a fraction of the full video in each axis.
 *
 * Asked of the mirrorVideo overlay wherever there is one, because that overlay shares the look
 * view's div and its canvasToVideoCoords IS the mapping the video was drawn with. That makes the
 * answer right in every mode without this module having to know which is in force — Match Video
 * Aspect on or off, letterbox or pillarbox, cropped or filling the pane.
 *
 * Which matters now that Sync Look Camera no longer forces Match Video Aspect (see
 * CNodeFitCameraPoints.setSyncLookCamera). With it off the look view shows a WIDER field than
 * the video's own frame — CNodeView3D divides the camera's field by fovCoverage — so the pane
 * spans 1/(fovCoverage*zoom) of the video vertically rather than 1/zoom. The fallback below
 * still assumes 1/zoom, which is exact only while the rendered rect is the video's frame; it is
 * kept for the case where no mirror overlay exists, where it is the best available guess.
 *
 * @returns {[number, number]|null} null when the geometry is not yet usable
 */
function videoFractionUnderPointer(view, clientX, clientY, zoom, video) {
    if (!(zoom > 0)) return null;
    const [vx, vy] = mouseToView(view, clientX, clientY);

    const mirror = NodeMan.get("mirrorVideo", false);
    if (mirror?.canvasToVideoCoords && mirror.videoWidth > 0 && mirror.videoHeight > 0) {
        // Bring the mirror up to date FIRST. It copies the video's pan in its own update(), once
        // per rendered frame, and a trackpad delivers wheel events a good deal faster than that:
        // the second event of a flick would otherwise map the cursor through the pan the first
        // one had already superseded, and the zoom would walk away from the pointer. update() is
        // the defined "make the mirror current" operation and is cheap and idempotent, so it is
        // used rather than re-copying the two fields here — this cannot then fall behind if the
        // mirror ever starts mirroring more state.
        mirror.update();
        const [px, py] = mirror.canvasToVideoCoords(vx, vy);
        if (Number.isFinite(px) && Number.isFinite(py)) {
            return [px / mirror.videoWidth, py / mirror.videoHeight];
        }
    }

    const r = renderedRect(view, view.widthPx, view.heightPx);
    if (!(r.w > 0) || !(r.h > 0)) return null;
    // Fraction across the rendered image, then back out through the current zoom and pan. The
    // visible region is taken to be 1/zoom of the video, centred on 0.5 + panOffset.
    const u = (vx - r.x) / r.w;
    const v = (vy - r.y) / r.h;
    return [
        0.5 + video.panOffsetX + (u - 0.5) / zoom,
        0.5 + video.panOffsetY + (v - 0.5) / zoom,
    ];
}

/** Wheel on the look view: zoom the video about the pointer. */
export function fitViewSyncWheel(view, event) {
    const video = NodeMan.get("video", false);
    const zoomNode = NodeMan.get("videoZoom", false);
    if (!video || !zoomNode) return;

    const oldZoom = zoomNode.v0 / 100;
    if (!(oldZoom > 0)) return;
    const newZoom = oldZoom * (event.deltaY < 0 ? 1 / WHEEL_SCALE : WHEEL_SCALE);

    // Same zoom-about-the-cursor step as CNodeVideoView.onMouseWheel: keep whatever is under the
    // pointer under the pointer, by moving the pan by the part of the frame the zoom took away.
    const frac = videoFractionUnderPointer(view, event.clientX, event.clientY, oldZoom, video);
    if (frac !== null) {
        const ratio = oldZoom / newZoom;
        video.panOffsetX = (frac[0] - 0.5) * (1 - ratio) + video.panOffsetX * ratio;
        video.panOffsetY = (frac[1] - 0.5) * (1 - ratio) + video.panOffsetY * ratio;
    }

    zoomNode.setValue(newZoom * 100);
    video.clampPanOffset();
    setRenderOne(true);
}

/** Left drag on the look view: pan the video by the same fraction of the frame. */
export function fitViewSyncPan(view, dxPx, dyPx) {
    const video = NodeMan.get("video", false);
    const zoomNode = NodeMan.get("videoZoom", false);
    if (!video || !zoomNode) return;
    const zoom = zoomNode.v0 / 100;
    if (!(zoom > 0)) return;

    // Negated so the picture goes with the pointer rather than away from it — grabbing and
    // pulling the image is the gesture, the same one the video view itself implements.
    //
    // Through the mirror overlay's own drawn rectangle where there is one, which is the same
    // conversion CNodeVideoView's left-drag uses: (px / dWidth) * (sWidth / videoWidth) is
    // exactly px / (the displayed image's width in pane pixels). Right in every mode, and in
    // particular with Match Video Aspect off, where the pane no longer spans 1/zoom of the
    // video vertically. The fallback keeps the old 1/zoom assumption for the no-mirror case.
    //
    // No mirror.update() needed here, unlike the wheel path: what is read is the RATIO
    // sWidth/dWidth, which is sourceW/fullW — a function of the zoom and the pane, not of the
    // pan. Clipping shrinks both terms together, so a stale pan cannot bias it.
    const mirror = NodeMan.get("mirrorVideo", false);
    if (mirror?.dWidth > 0 && mirror?.dHeight > 0
        && mirror.videoWidth > 0 && mirror.videoHeight > 0) {
        mirror.getSourceAndDestCoords();
        video.panOffsetX -= (dxPx / mirror.dWidth) * (mirror.sWidth / mirror.videoWidth);
        video.panOffsetY -= (dyPx / mirror.dHeight) * (mirror.sHeight / mirror.videoHeight);
    } else {
        const r = renderedRect(view, view.widthPx, view.heightPx);
        if (!(r.w > 0) || !(r.h > 0)) return;
        video.panOffsetX -= (dxPx / r.w) / zoom;
        video.panOffsetY -= (dyPx / r.h) / zoom;
    }
    video.clampPanOffset();
    setRenderOne(true);
}
