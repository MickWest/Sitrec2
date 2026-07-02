// Handles mouse events, and passes them to the view that is under the mouse
// Also handled 3D raycasting calculation based on mouse position and view
//

import {V2} from "./threeUtils";
import {ViewMan} from "./CViewManager";
import {mouseInViewOnly} from "./ViewUtils";
import {setRenderOne} from "./Globals";

let mouseDragView
let mouseDown = false
export const DRAG = {
    NONE: 0,
    PAN: 1,
    ROTATE: 2,
    ZOOM: 3,
    MOVEHANDLE: 4,
}
let dragMode = DRAG.NONE;
let mouseLastX = 0;
let mouseLastY = 0;
// Current mouse position, REALLY needs encapsulating....
let mouseX = 0;
let mouseY = 0;

export function getMousePosition() {
    return { x: mouseX, y: mouseY };
}

function isTopMenuElementAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest && el.closest("#menuBar"));
}

export function getTopViewWithCursor() {
    const mouse = getMousePosition();
    let topView = null;
    let topZ = -Infinity;
    
    ViewMan.iterateVisibleIncludingOverlays((key, view) => {
        if (view.cursorSprite && mouseInViewOnly(view, mouse.x, mouse.y)) {
            const z = view.zIndex || 0;
            if (z > topZ) {
                topZ = z;
                topView = view;
            }
        }
    });
    
    return topView;
}

export function getCursorPositionFromTopView() {
    const view = getTopViewWithCursor();
    if (view && view.cursorSprite) {
        return view.cursorSprite.position.clone();
    }
    return null;
}



export function SetupMouseHandler() {
    document.addEventListener( 'pointermove', onDocumentMouseMove, false );
    document.addEventListener( 'pointerdown', onDocumentMouseDown, false );
    document.addEventListener( 'pointerup', onDocumentMouseUp, false );
    // CAPTURE phase: a hover-revealed CUIBar stops 'dblclick' in the bubble phase (so header
    // clicks don't fullscreen-via-content), and the video canvas has its own bubble dblclick
    // (pan/zoom reset). Capturing at the document lets the header-strip handler run first and
    // swallow the event so neither of those fires on a header double-click.
    document.addEventListener( 'dblclick', onDocumentDoubleClick, true );
    document.addEventListener( 'wheel', onDocumentWheel, false );

    // Initial press of a cursor-consuming key needs an immediate cursor
    // refresh — onMouseMove only raycasts while one of these keys is already
    // held, so a tap with no mouse motion would otherwise read whatever
    // cursor position was last cached on mouseDown.
    //   C/X/L → position-LLA snap (camera / target / lock-all)
    //   V/B   → measure-arrow start / end
    //
    // Registered as a DOM listener (not via EventManager) so it survives
    // EventManager.removeAll() on sitch reload — this is page-global setup,
    // not per-sitch state.
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.ctrlKey || e.metaKey) return;
        const key = e.key.toLowerCase();
        if (key !== 'c' && key !== 'x' && key !== 'l' && key !== 'v' && key !== 'b') return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        const view = getTopViewWithCursor();
        if (view && view.camera && view._refreshCursorFromMouse) {
            view._refreshCursorFromMouse(screenToNDC(view, mouseX, mouseY));
        }
    }, false);
}

export function onDocumentWheel(event) {
    // console.log("onDocumentWheel " + event.deltaX + "," + event.deltaY)
    mouseX = (event.clientX);
    mouseY = (event.clientY);

    if (!mouseDragView && isTopMenuElementAt(mouseX, mouseY)) return;

    // if we started dragging in a view, then send moves only to that
    if (mouseDragView) {
        if (mouseDragView.onMouseWheel) {
            mouseDragView.onMouseWheel(event, mouseX, mouseY, event.deltaX, event.deltaY)
        } else {
            console.warn("No onMouseWheel handler for " + mouseDragView.id)
        }
    } else {
        ViewMan.iterateVisibleIncludingOverlays((name, view) => {
            if (mouseInViewOnly(view, mouseX, mouseY) && view.onMouseWheel !== undefined) {
                view.onMouseWheel(event, mouseX, mouseY, event.deltaX, event.deltaY)
            }
        })
    }

}

//
export function onDocumentMouseDown(event) {

    if (!mouseDown) {
        mouseX = (event.clientX);
        mouseY = (event.clientY);

        if (isTopMenuElementAt(mouseX, mouseY)) {
            mouseDragView = null;
            setRenderOne(true);
            return;
        }

        const vm = ViewMan

//        console.log("Mouse Down, checking exclusive")

        vm.iterateVisibleIncludingOverlays((name, view) => {
//            console.log("onDocumentMouseDown checking" + view.id)

            if (mouseInViewOnly(view, mouseX, mouseY, false)) {
  //              console.log("onDocumentMouseDown has mouseInViewOnly true for" + view.id)
                if (view.onMouseDown !== undefined) {
                  //  console.log("Calling onMouseDown for" + view.id)
                    view.onMouseDown(event, mouseX, mouseY)
                    mouseDragView = view;
                } else {
                   // console.log("No callback onMouseDown for" + view.id)
                }


            }
        })
    }

    // click forces update
    setRenderOne(true);

    mouseDown = true;
}

export function onDocumentMouseMove(event) {


    mouseX = (event.clientX);
    mouseY = (event.clientY);

    if (!mouseDragView && isTopMenuElementAt(mouseX, mouseY)) {
        mouseLastX = mouseX;
        mouseLastY = mouseY;
        return;
    }

    // console.log("onDocumentMouseMove " + mouseX + "," + mouseY)


    // if we started dragging in a view, then send moves only to that
    if (mouseDragView) {
//         console.log("Mouse Dragging " + mouseDragView.id)
        if (mouseDragView.onMouseDrag) {
            // console.log("Mouse Dragging " + mouseDragView.id)
            mouseDragView.onMouseDrag(event, mouseX, mouseY, mouseX - mouseLastX, mouseY - mouseLastY)
        } else {
//            console.log("Mouse Unhandled Dragging " + mouseDragView.id)
            mouseDragView.onMouseMove(event, mouseX, mouseY, mouseX - mouseLastX, mouseY - mouseLastY)
        }
    } else {
        // otherwise, send to the view we are inside
        ViewMan.iterateVisibleIncludingOverlays((name, view) => {

            if (mouseInViewOnly(view, mouseX, mouseY) && view.onMouseMove !== undefined) {
                // console.log("Mouse Move (no drag) in view "+view.id)
                view.onMouseMove(event, mouseX, mouseY, mouseX-mouseLastX, mouseY-mouseLastY)
            }
        })

    }

    // Mouse dragging is likely to need rendering update
    if (mouseDown)
        setRenderOne(true);

    mouseLastX = mouseX;
    mouseLastY = mouseY;

}

export function onDocumentMouseUp(event) {
    if (mouseDragView && mouseDragView.onMouseUp !== undefined ) {
        mouseDragView.onMouseUp(event, mouseX, mouseY)
        dragMode = DRAG.NONE;
    }
    mouseDragView = null;
    mouseDown = false;
}

// Double-clicking a view's HEADER STRIP (its UIBar) toggles fullscreen — the same action as
// the ⛶ icon. This is registered in the CAPTURE phase (see SetupMouseHandler) so it runs
// before a hover-revealed bar's bubble-phase stopPropagation and before any content dblclick
// handler. We gate on the bar's live bounding rect, which exists even when the bar is hidden
// (opacity:0/pointerEvents:none), so it behaves identically whether the header is pinned or
// hover-revealed. Double-clicking the CONTENT does nothing here — the old "double-click inside
// the window to fullscreen" behaviour is intentionally removed.
export function onDocumentDoubleClick(event) {
    const x = event.clientX, y = event.clientY;

    // Defer to menus (same as mousedown/move/wheel): a menu tab overlapping a view's
    // header strip must get the dblclick (e.g. its setDoubleClickAction), not trigger
    // the view's fullscreen toggle. This handler is capture-phase, so without this
    // bail-out it would run — and swallow the event — before the menu's own listener.
    if (isTopMenuElementAt(x, y)) return;

    let done = false;
    ViewMan.iterate((key, view) => {
        if (done || !view._effectivelyVisible) return;
        const bar = view.uiBar?.bar;
        if (!bar) return;                          // only views WITH a header strip
        if (!mouseInViewOnly(view, x, y)) return;  // top-most view under the cursor
        const r = bar.getBoundingClientRect();     // the ~26px header strip rect
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            view.doubleClick();                    // self-gates on doubleClickResizes||doubleClickFullScreen
            done = true;
        }
    });

    if (done) {
        // Swallow so the underlying content handler doesn't ALSO fire — e.g. a hidden video
        // header strip would otherwise pass the dblclick through to the canvas and reset
        // pan/zoom on top of the fullscreen toggle. (The camera double-tap zoom on 3D views
        // is suppressed separately in CameraControls.handleMouseUp / pointInHeaderStrip.)
        event.stopPropagation();
        event.preventDefault();
        setRenderOne(true);
    }
}

/**
 * Convert screen coordinates to Three.js NDC (Normalized Device Coordinates).
 * Takes absolute screen coordinates (event.clientX, event.clientY) and returns
 * a Vector2 suitable for raycaster.setFromCamera().
 *
 * This function properly handles:
 * - Sidebar offsets (via ViewMan.screenOffsetX which tracks the Content container's screen position)
 * - View position within container (via view.leftPx, view.topPx)
 * - Y-axis inversion (screen Y increases downward, NDC Y increases upward)
 *
 * @param {Object} view - The view object with leftPx, topPx, widthPx, heightPx
 * @param {number} screenX - Screen X coordinate (event.clientX)
 * @param {number} screenY - Screen Y coordinate (event.clientY)
 * @returns {Vector2} NDC coordinates in range [-1, 1] for both axes
 */
export function screenToNDC(view, screenX, screenY) {
    // Convert screen coords to view-relative coords
    // view.leftPx is relative to the container, so we also need the container's screen offset
    const containerOffsetX = ViewMan.screenOffsetX || 0;
    const viewX = screenX - view.leftPx - containerOffsetX;
    const viewY = screenY - view.topPx;

    // Convert to NDC: x from -1 (left) to +1 (right), y from -1 (bottom) to +1 (top)
    const ndcX = (viewX / view.widthPx) * 2 - 1;
    const ndcY = -(viewY / view.heightPx) * 2 + 1;  // Invert Y for Three.js

    return V2(ndcX, ndcY);
}

/**
 * @deprecated Use screenToNDC() instead. This function expects pre-converted
 * coordinates in a confusing coordinate system. Kept for backward compatibility.
 *
 * LEGACY: Expects mouseX and mouseY to already be view-relative, with mouseY
 * being "Y-up" (i.e., measured from bottom of view, not top). This non-standard
 * expectation has caused many bugs.
 */
export function makeMouseRay(view, mouseX, mouseY) {
    // Legacy function - expects view-relative coords with Y measured from bottom
    // Convert to proportion
    const viewXp = mouseX / view.widthPx;
    const viewYp = mouseY / view.heightPx;

    // Convert to Three.js NDC: -1 to +1
    return V2(viewXp * 2 - 1, viewYp * 2 - 1);
}
