// Mouse coordinate utility functions for converting between coordinate systems.
//
// Coordinate systems:
// - Screen/Window: (0,0) at top-left of browser window (event.clientX, event.clientY)
// - View-relative: (0,0) at top-left of view (after subtracting view position)
// - Three.js NDC: (-1,-1) at bottom-left, (1,1) at top-right, (0,0) at center
//
// IMPORTANT: view.leftPx/topPx are positions RELATIVE to the Content container.
// The Content container itself may be offset from the screen edge (e.g., by sidebars).
// ViewMan.screenOffsetX tracks this container offset for proper screen-to-view conversion.

import {assert} from "./assert";
import {ViewMan} from "./CViewManager";
import {Vector2} from "three";

// ---------------------------------------------------------------------------------------------
// Right-click arbitration between a view and an overlay sitting on top of it.
//
// An overlay canvas has pointer-events:none and receives its clicks through the document-level
// router in mouseMoveView.js, while a view's own context menu comes from a `contextmenu` listener
// on the VIEW's canvas. Those are two separate DOM events on two different elements, so an
// overlay that acts on a right-click has no event to cancel — its handler has already returned by
// the time the view's fires.
//
// So the overlay CLAIMS the click, and the view checks the claim before opening its menu.
//
// The claim is SINGLE USE, and also time windowed. Both, because the two failure modes are
// different: consuming it means a claim suppresses exactly the one context menu it was paired
// with, so a second right-click a moment later still opens the menu normally; and the time window
// means a claim that is never consumed at all — the overlay acted, but that view has no context
// menu to suppress — expires instead of lying in wait for the next real one.
// ---------------------------------------------------------------------------------------------

let rightClickClaimedAt = -Infinity;

/** Call from an overlay that just acted on a right-click, to suppress the view's context menu. */
export function claimRightClick() {
    rightClickClaimedAt = performance.now();
}

/**
 * Call from a view's contextmenu handler; if true, an overlay already handled this click.
 * Consumes the claim, so it suppresses one menu and not a burst of them.
 */
export function rightClickWasClaimed(windowMs = 600) {
    if (!(performance.now() - rightClickClaimedAt < windowMs)) return false;
    rightClickClaimedAt = -Infinity;
    return true;
}

/**
 * Convert screen coordinates to view-relative coordinates.
 * Both input and output use top-left origin (screen convention).
 * Accounts for sidebar offsets via ViewMan.screenOffsetX.
 * @param {Object} view - The view object with leftPx, topPx, widthPx, heightPx
 * @param {number} x - Screen X coordinate (event.clientX)
 * @param {number} y - Screen Y coordinate (event.clientY)
 * @returns {[number, number]} View-relative [x, y] with (0,0) at view's top-left
 */
export function mouseToView(view, x, y) {
    // view.leftPx is relative to the container, so add container's screen offset
    const containerOffsetX = ViewMan.screenOffsetX || 0;
    const xv = x - view.leftPx - containerOffsetX;
    const yv = y - view.topPx;
    return [xv, yv];
}

/**
 * Convert screen coordinates to Three.js Normalized Device Coordinates (NDC).
 * Three.js NDC has (-1,-1) at bottom-left, (1,1) at top-right.
 * Accounts for sidebar offsets via ViewMan.screenOffsetX.
 * @param {Object} view - The view object with leftPx, topPx, widthPx, heightPx
 * @param {number} x - Screen X coordinate (event.clientX)
 * @param {number} y - Screen Y coordinate (event.clientY)
 * @returns {[number, number]} NDC [x, y] in range [-1, 1]
 */
export function mouseToViewNormalized(view, x, y) {
    const [xv, yv] = mouseToView(view, x, y);
    return [(xv / view.widthPx) * 2 - 1, -(yv / view.heightPx) * 2 + 1];
}

/**
 * Create a Vector2 in Three.js NDC from screen coordinates.
 * This is the preferred method for raycaster.setFromCamera().
 * Accounts for sidebar offsets via ViewMan.screenOffsetX.
 * @param {Object} view - The view object with leftPx, topPx, widthPx, heightPx
 * @param {number} x - Screen X coordinate (event.clientX)
 * @param {number} y - Screen Y coordinate (event.clientY)
 * @returns {Vector2} NDC coordinates suitable for raycaster.setFromCamera()
 */
export function mouseToNDC(view, x, y) {
    const [ndcX, ndcY] = mouseToViewNormalized(view, x, y);
    return new Vector2(ndcX, ndcY);
}

/**
 * Convert screen coordinates to view-relative coordinates.
 * Alias for mouseToView() for backward compatibility.
 * @deprecated Use mouseToView() instead
 */
export function mouseToCanvas(view, x, y) {
    return mouseToView(view, x, y);
}

export function mouseInView(view, x, y, debug = false) {
    assert(view !== undefined)
    assert(x !== undefined)
    assert(y !== undefined)
    // localize to the view window
    const [vx, vy] = mouseToView(view, x, y)

    if (view.ignoreMouse) {
        if (debug) console.log(`Mouse (${x},${y}) Ignored in view(${view.id})`)
        return false;
    }
    if (!view.visible) {
        if (debug) console.log(`Mouse (${x},${y}) NOT visible in view(${view.id})`)
        return false;
    }

    const inside = (vx >= 0 && vy >= 0 && vx < view.widthPx && vy < view.heightPx);
    if (debug) {
        if (inside)
            console.log(`Mouse (${x},${y}) In view(${view.id})`)
        else
            console.log(`Mouse (${x},${y}) NOT in view(${view.id})`)
    }
    return inside;
}

export function mouseInViewOnly(view, x, y, debug = false) {
    if (!mouseInView(view, x, y, debug)) {
        if (debug) console.log(`Mouse (${x},${y}) NOT in view(${view.id})`)
        return false;
    }

    const viewZ = view.zIndex || 0;
    let inView = true;
    
    ViewMan.iterateVisibleIncludingOverlays((key, otherView) => {
        if (otherView === view) return;
        
        const otherZ = otherView.zIndex || 0;
        if (otherZ > viewZ && mouseInView(otherView, x, y)) {
            if (debug) {
                console.log(`Mouse (${x},${y}) In FRONT view(${otherView.id}) z=${otherZ} > ${viewZ}`)
            }
            if (otherView.onMouseDown !== undefined) {
                inView = false;
            }
        }
    })

    return inView;
}
/**
 * The sub-rectangle of a view's pixel space that its 3D canvas actually fills, as {x, y, w, h}.
 *
 * Normally the whole thing — but not always, and the exception is invisible until it bites. With
 * "Match Video Aspect" on, CNodeView3D letterboxes by resizing and centring the 3D CANVAS ELEMENT
 * inside its div (canvas.style.width/height/left/top) rather than by using a viewport inside a
 * full-size canvas. Anything working in the div's pixel space — an overlay canvas drawn on top,
 * or a mouse position measured against the pane — therefore spans more pixels than the scene was
 * drawn into. Measured on a 572x435 div: the 3D canvas was 572x321 at a 57 px vertical inset, so
 * a straight mapping was correct at the centre, wrong everywhere else, and wrong by a different
 * amount whenever the letterbox changed. One fit handle landed 39 px low.
 *
 * Going through the real rect covers letterbox, pillarbox and neither without the caller having
 * to know which is in play, and reduces to the naive mapping exactly when the render fills the
 * canvas.
 */
export function renderedRect(view, w, h) {
    const canvas = view.canvas, div = view.div;
    const whole = {x: 0, y: 0, w, h};
    if (!canvas || !div) return whole;
    const rc = canvas.getBoundingClientRect();
    const rd = div.getBoundingClientRect();
    if (!(rd.width > 0) || !(rd.height > 0) || !(rc.width > 0) || !(rc.height > 0)) return whole;
    return {
        x: ((rc.left - rd.left) / rd.width) * w,
        y: ((rc.top - rd.top) / rd.height) * h,
        w: (rc.width / rd.width) * w,
        h: (rc.height / rd.height) * h,
    };
}

/**
 * Run fn with the view's camera holding the projection it is actually RENDERED with, then put it
 * back.
 *
 * view.camera between renders carries the base fov/aspect/zoom and a clean projection matrix.
 * What reaches the screen can differ by a lot: video zoom, video fov coverage, video pan (an
 * off-centre frustum written straight into projectionMatrix.elements[8]/[9], which
 * updateProjectionMatrix() will never reproduce), Match Video Aspect's fov/aspect rewrite,
 * y-compression, the display-only lookAt, and camera-tweak offsets. prepareCameraForLOD applies
 * all of them — it exists so terrain LOD evaluates the frustum that is displayed — and it is
 * equally what makes a screen->world pick land on the pixel the user is pointing at.
 *
 * Re-entrant: if LOD has already prepared the camera (a pick from inside the render pass), the
 * state is used as-is and left alone, since the paired restore rebuilds from the saved fov/aspect
 * /zoom and a nested pair would restore to the wrong baseline.
 */
export function withDisplayedCamera(view, fn) {
    const lodActive = view._lodSavedZoom !== undefined;
    if (!lodActive) view.prepareCameraForLOD();
    view.camera.updateMatrixWorld();
    try {
        return fn(view.camera);
    } finally {
        if (!lodActive) view.restoreCameraAfterLOD();
    }
}
