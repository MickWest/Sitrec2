// Handles mouse events, and passes them to the view that is under the mouse
// Also handled 3D raycasting calculation based on mouse position and view
//

import {ViewMan} from "./CViewManager";
import {mouseInViewOnly, mouseToNDC, viewToNDC} from "./ViewUtils";
import {setRenderOne} from "./Globals";

let mouseDragView
let mouseDown = false
let mousePointerId;
let mouseButton;

// Deliberately NOT exposed: mouseDragView is not "the view that claimed the press". The
// dispatcher below sets it for any handler that did not return an explicit false, and most fall
// off the end returning undefined — CNodeTrackingOverlay does so on every ordinary click. An
// overlay wanting to know whether a press belongs to somebody else must ask that overlay
// directly (see CNodeVideoView._isMaskEditing / _isAnnotateEditing / _isOverlayDragging).
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
    document.addEventListener('pointercancel', onDocumentMouseCancel, true);
    document.addEventListener('lostpointercapture', onDocumentMouseCancel, true);
    window.addEventListener('blur', onDocumentMouseCancel);
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
    //   C/X → position-LLA snap (camera / target)
    //   V/B   → measure-arrow start / end
    //
    // Registered as a DOM listener (not via EventManager) so it survives
    // EventManager.removeAll() on sitch reload — this is page-global setup,
    // not per-sitch state.
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.ctrlKey || e.metaKey) return;
        const key = e.key.toLowerCase();
        if (key !== 'c' && key !== 'x' && key !== 'v' && key !== 'b') return;
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
        mouseLastX = mouseX;
        mouseLastY = mouseY;
        mousePointerId = event.pointerId;
        mouseButton = event.button;

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
                    // Every view under the cursor gets onMouseDown and the LAST one wins
                    // mouseDragView, because mouseInViewOnly only rejects a view when a
                    // HIGHER-z view with an onMouseDown covers the point — overlays sharing
                    // a z-index (all the video overlays sit at z=3) never exclude each other.
                    //
                    // So a handler that DECLINES the click by returning false was still
                    // being handed the drag, stealing it from the view that actually took
                    // it. That is how dragging a manual-tracking keyframe broke: the
                    // trackingOverlay started the drag (and jumped to the keyframe's frame,
                    // which is why it looked like a seek), then annotateOverlay — not in
                    // editing mode, returning false — overwrote mouseDragView, so the
                    // mousemove never reached the overlay and the point never moved.
                    //
                    // Treat an explicit false as "not mine". Anything else (true, or the
                    // undefined that most handlers return) keeps the previous behaviour,
                    // so this only changes views that already opted out on purpose.
                    if (view.onMouseDown(event, mouseX, mouseY) !== false) {
                        mouseDragView = view;
                    }
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
    if (mouseDown && event.pointerId !== mousePointerId) return;
    // A release outside the document may never deliver pointerup here.
    if (mouseDown && event.buttons === 0) {
        onDocumentMouseCancel(event);
    }

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
            mouseDragView.onMouseMove?.(event, mouseX, mouseY, mouseX - mouseLastX, mouseY - mouseLastY)
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
    if (mouseDown && (event.pointerId !== mousePointerId || event.button !== mouseButton)) return;
    finishDocumentDrag(event, false);
}

export function onDocumentMouseCancel(event) {
    if (event.type !== 'blur' && event.pointerId !== mousePointerId) return;
    finishDocumentDrag(event, true);
}

function finishDocumentDrag(event, cancelled) {
    const view = mouseDragView;
    const x = cancelled ? mouseX : event.clientX;
    const y = cancelled ? mouseY : event.clientY;
    const dx = x - mouseLastX, dy = y - mouseLastY;
    // Clear ownership before callbacks: releasing capture or disposing an editor
    // can synchronously send another termination event.
    mouseDragView = null;
    mouseDown = false;
    mousePointerId = undefined;
    mouseButton = undefined;
    dragMode = DRAG.NONE;
    mouseX = mouseLastX = x;
    mouseY = mouseLastY = y;
    if (!view) return;
    if (!cancelled && (dx !== 0 || dy !== 0)) {
        // Editors normally mutate on move, so deliver the release's last delta
        // before their undo snapshot is finalized.
        (view.onMouseDrag ?? view.onMouseMove)?.call(view, event, x, y, dx, dy);
    }
    // Until editors have a dedicated cancellation policy, finish the visible
    // edit through their normal up path so its undo bookkeeping is preserved.
    (cancelled ? view.onMouseCancel ?? view.onMouseUp : view.onMouseUp)?.call(view, event, x, y);
    setRenderOne(true);
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
    return mouseToNDC(view, screenX, screenY);
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
    return viewToNDC(view, mouseX, view.heightPx - mouseY);
}
