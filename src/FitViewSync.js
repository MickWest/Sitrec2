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
 */
export function fitViewSyncActive(view) {
    if (!view || view.id !== "lookView" || !view.syncVideoZoom) return false;
    const fit = NodeMan.get("fitCameraPoints", false);
    if (!fit || !fit.enabled) return false;
    if (!NodeMan.exists("videoZoom")) return false;
    const video = NodeMan.get("video", false);
    return !!video && video.videoWidth > 0 && video.videoHeight > 0;
}

/**
 * Where the pointer is in the video frame, as a fraction of the full video in each axis.
 *
 * Mapped through renderedRect, not through the pane, because the fit forces Match Video Aspect on
 * and that letterboxes the rendered image inside the pane. Measured on one 767x435 look view: the
 * canvas sat 2px down and 4px short. Using pane coordinates would put the zoom anchor off the
 * feature the user is pointing at, by more the further from centre they are — which is exactly
 * where they are when they have zoomed in to place a point.
 *
 * @returns {[number, number]|null} null when the geometry is not yet usable
 */
function videoFractionUnderPointer(view, clientX, clientY, zoom, video) {
    const r = renderedRect(view, view.widthPx, view.heightPx);
    if (!(r.w > 0) || !(r.h > 0) || !(zoom > 0)) return null;
    const [vx, vy] = mouseToView(view, clientX, clientY);
    // Fraction across the rendered image, then back out through the current zoom and pan. The
    // visible region is 1/zoom of the video, centred on 0.5 + panOffset.
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

    const r = renderedRect(view, view.widthPx, view.heightPx);
    if (!(r.w > 0) || !(r.h > 0)) return;

    // Negated so the picture goes with the pointer rather than away from it — grabbing and pulling
    // the image is the gesture, the same one the video view itself implements. A drag right across
    // the whole frame moves by the visible fraction, 1/zoom, which is what makes the two views move
    // together by construction rather than by a tuned constant.
    video.panOffsetX -= (dxPx / r.w) / zoom;
    video.panOffsetY -= (dyPx / r.h) / zoom;
    video.clampPanOffset();
    setRenderOne(true);
}
