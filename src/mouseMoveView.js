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
    document.addEventListener( 'dblclick', onDocumentDoubleClick, false );
    document.addEventListener( 'wheel', onDocumentWheel, false );

}

export function onDocumentWheel(event) {
    // console.log("onDocumentWheel " + event.deltaX + "," + event.deltaY)
    mouseX = (event.clientX);
    mouseY = (event.clientY);

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

export function onDocumentDoubleClick(event) {
    mouseX = event.clientX;
    mouseY = event.clientY;

    let done=false;
    ViewMan.iterate((key, view) => {
        if (!done && view._effectivelyVisible) {
            if (mouseInViewOnly(view, mouseX, mouseY)) {
                //  console.log("Dbl " + key)
                view.doubleClick();
                done = true;
            } else {
                //  console.log("NOT " + key)
            }
        }
    })
    setRenderOne(true);
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