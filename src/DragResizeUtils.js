/**
 * Modern drag and resize utilities to replace jQuery UI functionality
 *
 * IMPORTANT: This module uses Pointer Events (pointerdown/pointermove/pointerup) instead of
 * mouse events for all drag operations. This is critical for correct off-screen drag behavior.
 *
 * Why Pointer Events?
 * - Mouse events (mouseup) may not fire reliably when the pointer moves outside the browser window
 * - Pointer events continue firing even when dragging off-screen, preventing elements from
 *   remaining "stuck" to the cursor after releasing outside the viewport
 * - Pointer events are the modern standard and work with mouse, touch, and stylus input
 *
 * Key Implementation Detail:
 * - Drag-end listeners MUST be attached to `document`, not the element being dragged
 * - This ensures proper event delivery when the pointer moves off-screen
 *
 * Do not replace pointer events with mouse events in this file.
 * See related fix: lil-gui-extras.js handleTitleMouseDown() method (similar fix applied)
 */

import {isKeyHeld} from "./KeyBoardHandler";
import {ViewMan} from "./CViewManager";

export let isViewDragging = false;

// Snap distance in pixels
const SNAP_DISTANCE = 10;

// Minimum on-screen size (px) for a view in EITHER dimension — enforced by edge-resize
// (makeResizable, below) and by shared-edge seam dragging (CLayoutManager imports this), so a
// view can't be shrunk into an unusable sliver.
export const MIN_VIEW_PX = 128;

// Phase 1 — unified view interaction. The SINGLE modifier key that puts a movable
// view into "edit layout" mode: hold it to highlight edges, move the view, and
// edge-resize with snapping. Every movable CNodeView uses this same key (legacy
// per-view shiftDrag / bare-drag configs are mapped onto it in CNodeView), so the
// interaction is identical across 3D, look, video, graph, and 2D views.
// (Value matches the historical mainView/lookView dragKey, so behaviour is unchanged
// for views that already used Q.)
export const VIEW_EDIT_KEY = "Q";

// Resize handle thickness in pixels
const HANDLE_SIZE = 10;
const HANDLE_HALF = HANDLE_SIZE / 2;

// Border highlight color when drag key is held
const DRAG_BORDER_COLOR = 'rgba(100, 150, 255, 0.6)';

// Track elements with drag borders for cleanup
const elementsWithDragBorder = new Set();

/**
 * Shows a border highlight on an element's resize handles when drag key is pressed
 */
function showDragBorder(element) {
    if (!element._resizeHandles) return;
    const handles = element._resizeHandles;
    // Highlight the side handles (n, e, s, w) to form a border
    ['n', 'e', 's', 'w'].forEach(dir => {
        if (handles[dir]) {
            handles[dir].style.backgroundColor = DRAG_BORDER_COLOR;
        }
    });
    elementsWithDragBorder.add(element);
}

/**
 * Hides the border highlight on an element's resize handles
 */
function hideDragBorder(element) {
    if (!element._resizeHandles) return;
    const handles = element._resizeHandles;
    ['n', 'e', 's', 'w'].forEach(dir => {
        if (handles[dir]) {
            handles[dir].style.backgroundColor = 'transparent';
        }
    });
    elementsWithDragBorder.delete(element);
}

/**
 * Calculates snap positions for a dragging element
 * Returns adjusted left/top if snapping should occur
 */
function calculateSnap(left, top, width, height, excludeView) {
    let snappedLeft = left;
    let snappedTop = top;

    const right = left + width;
    const bottom = top + height;

    // Screen edges (using ViewMan container dimensions)
    const screenLeft = 0;
    const screenTop = 0;
    const screenRight = ViewMan.widthPx;
    const screenBottom = ViewMan.heightPx;

    // Check screen edge snapping
    if (Math.abs(left - screenLeft) < SNAP_DISTANCE) {
        snappedLeft = screenLeft;
    }
    if (Math.abs(right - screenRight) < SNAP_DISTANCE) {
        snappedLeft = screenRight - width;
    }
    if (Math.abs(top - screenTop) < SNAP_DISTANCE) {
        snappedTop = screenTop;
    }
    if (Math.abs(bottom - screenBottom) < SNAP_DISTANCE) {
        snappedTop = screenBottom - height;
    }

    // Check snapping to other views
    ViewMan.iterate((id, view) => {
        // Skip the view being dragged, overlay views, passthrough views, and relative views
        if (view === excludeView) return;
        if (view.overlayView) return;  // This view is an overlay of another view
        if (view.passThrough) return;  // This view has pointer events disabled (overlay-like)
        if (view.in && view.in.relativeTo) return;  // This view is positioned relative to another
        if (!view.visible) return;

        const vLeft = view.leftPx;
        const vTop = view.topPx;
        const vRight = vLeft + view.widthPx;
        const vBottom = vTop + view.heightPx;

        // Snap our left edge to their right edge
        if (Math.abs(left - vRight) < SNAP_DISTANCE) {
            snappedLeft = vRight;
        }
        // Snap our right edge to their left edge
        if (Math.abs(right - vLeft) < SNAP_DISTANCE) {
            snappedLeft = vLeft - width;
        }
        // Snap our top edge to their bottom edge
        if (Math.abs(top - vBottom) < SNAP_DISTANCE) {
            snappedTop = vBottom;
        }
        // Snap our bottom edge to their top edge
        if (Math.abs(bottom - vTop) < SNAP_DISTANCE) {
            snappedTop = vTop - height;
        }

        // Also snap matching edges (left-to-left, top-to-top, etc.)
        if (Math.abs(left - vLeft) < SNAP_DISTANCE) {
            snappedLeft = vLeft;
        }
        if (Math.abs(right - vRight) < SNAP_DISTANCE) {
            snappedLeft = vRight - width;
        }
        if (Math.abs(top - vTop) < SNAP_DISTANCE) {
            snappedTop = vTop;
        }
        if (Math.abs(bottom - vBottom) < SNAP_DISTANCE) {
            snappedTop = vBottom - height;
        }
    });

    return { left: snappedLeft, top: snappedTop };
}

/**
 * Calculates snap for resize operations
 * Returns adjusted left, top, width, height if snapping should occur
 * @param {string} dir - Resize direction (n, e, s, w, ne, se, sw, nw)
 */
function calculateResizeSnap(left, top, width, height, dir, excludeView) {
    let snappedLeft = left;
    let snappedTop = top;
    let snappedWidth = width;
    let snappedHeight = height;

    const right = left + width;
    const bottom = top + height;

    // Screen edges
    const screenLeft = 0;
    const screenTop = 0;
    const screenRight = ViewMan.widthPx;
    const screenBottom = ViewMan.heightPx;

    // Determine which edges are being dragged based on direction
    const affectsTop = ['n', 'ne', 'nw'].includes(dir);
    const affectsBottom = ['s', 'se', 'sw'].includes(dir);
    const affectsLeft = ['w', 'nw', 'sw'].includes(dir);
    const affectsRight = ['e', 'ne', 'se'].includes(dir);

    // Snap to screen edges
    if (affectsLeft && Math.abs(left - screenLeft) < SNAP_DISTANCE) {
        const diff = left - screenLeft;
        snappedLeft = screenLeft;
        snappedWidth = width + diff;
    }
    if (affectsRight && Math.abs(right - screenRight) < SNAP_DISTANCE) {
        snappedWidth = screenRight - snappedLeft;
    }
    if (affectsTop && Math.abs(top - screenTop) < SNAP_DISTANCE) {
        const diff = top - screenTop;
        snappedTop = screenTop;
        snappedHeight = height + diff;
    }
    if (affectsBottom && Math.abs(bottom - screenBottom) < SNAP_DISTANCE) {
        snappedHeight = screenBottom - snappedTop;
    }

    // Snap to other views
    ViewMan.iterate((id, view) => {
        // Skip the view being resized, overlay views, passthrough views, and relative views
        if (view === excludeView) return;
        if (view.overlayView) return;  // This view is an overlay of another view
        if (view.passThrough) return;  // This view has pointer events disabled (overlay-like)
        if (view.in && view.in.relativeTo) return;  // This view is positioned relative to another
        if (!view.visible) return;

        const vLeft = view.leftPx;
        const vTop = view.topPx;
        const vRight = vLeft + view.widthPx;
        const vBottom = vTop + view.heightPx;

        // Snap left edge
        if (affectsLeft) {
            if (Math.abs(left - vRight) < SNAP_DISTANCE) {
                const diff = left - vRight;
                snappedLeft = vRight;
                snappedWidth = width + diff;
            }
            if (Math.abs(left - vLeft) < SNAP_DISTANCE) {
                const diff = left - vLeft;
                snappedLeft = vLeft;
                snappedWidth = width + diff;
            }
        }

        // Snap right edge
        if (affectsRight) {
            const currentRight = snappedLeft + snappedWidth;
            if (Math.abs(currentRight - vLeft) < SNAP_DISTANCE) {
                snappedWidth = vLeft - snappedLeft;
            }
            if (Math.abs(currentRight - vRight) < SNAP_DISTANCE) {
                snappedWidth = vRight - snappedLeft;
            }
        }

        // Snap top edge
        if (affectsTop) {
            if (Math.abs(top - vBottom) < SNAP_DISTANCE) {
                const diff = top - vBottom;
                snappedTop = vBottom;
                snappedHeight = height + diff;
            }
            if (Math.abs(top - vTop) < SNAP_DISTANCE) {
                const diff = top - vTop;
                snappedTop = vTop;
                snappedHeight = height + diff;
            }
        }

        // Snap bottom edge
        if (affectsBottom) {
            const currentBottom = snappedTop + snappedHeight;
            if (Math.abs(currentBottom - vTop) < SNAP_DISTANCE) {
                snappedHeight = vTop - snappedTop;
            }
            if (Math.abs(currentBottom - vBottom) < SNAP_DISTANCE) {
                snappedHeight = vBottom - snappedTop;
            }
        }
    });

    return { left: snappedLeft, top: snappedTop, width: snappedWidth, height: snappedHeight };
}

/**
 * Adjusts resize handle positions for all views so that handles straddle
 * the edge by default, but shrink to inside-only when an adjacent window's
 * edge (or the screen boundary) is within HANDLE_SIZE pixels. This prevents
 * overlapping grab zones between neighbouring panels.
 */
export function updateAllHandlePositions() {
    // Collect visible views that have resize handles
    const views = [];
    ViewMan.iterate((id, view) => {
        if (view.div && view.div._resizeHandles && view.visible) {
            views.push(view);
        }
    });

    const screenRight = ViewMan.widthPx;
    const screenBottom = ViewMan.heightPx;

    for (const view of views) {
        const handles = view.div._resizeHandles;
        const L = view.leftPx;
        const T = view.topPx;
        const R = L + view.widthPx;
        const B = T + view.heightPx;

        // Start assuming no neighbour conflict (straddle the edge)
        let northInside = false;
        let eastInside = false;
        let southInside = false;
        let westInside = false;

        // Screen edges: shrink inward if flush with viewport boundary
        if (L < HANDLE_HALF) westInside = true;
        if (T < HANDLE_HALF) northInside = true;
        if (screenRight - R < HANDLE_HALF) eastInside = true;
        if (screenBottom - B < HANDLE_HALF) southInside = true;

        // Neighbouring views: shrink inward if opposing edges are close
        for (const other of views) {
            if (other === view) continue;
            const oL = other.leftPx;
            const oT = other.topPx;
            const oR = oL + other.widthPx;
            const oB = oT + other.heightPx;

            // Only consider neighbours that share vertical/horizontal extent
            const vOverlap = T < oB && oT < B;
            const hOverlap = L < oR && oL < R;

            if (vOverlap) {
                if (Math.abs(R - oL) < HANDLE_SIZE) eastInside = true;
                if (Math.abs(L - oR) < HANDLE_SIZE) westInside = true;
            }
            if (hOverlap) {
                if (Math.abs(B - oT) < HANDLE_SIZE) southInside = true;
                if (Math.abs(T - oB) < HANDLE_SIZE) northInside = true;
            }
        }

        // Apply offsets: 0 = inside-only, -HANDLE_HALF = straddling edge
        const nOff = northInside ? '0px' : `-${HANDLE_HALF}px`;
        const eOff = eastInside  ? '0px' : `-${HANDLE_HALF}px`;
        const sOff = southInside ? '0px' : `-${HANDLE_HALF}px`;
        const wOff = westInside  ? '0px' : `-${HANDLE_HALF}px`;

        if (handles.n)  handles.n.style.top    = nOff;
        if (handles.e)  handles.e.style.right   = eOff;
        if (handles.s)  handles.s.style.bottom  = sOff;
        if (handles.w)  handles.w.style.left    = wOff;
        if (handles.ne) { handles.ne.style.top   = nOff; handles.ne.style.right  = eOff; }
        if (handles.se) { handles.se.style.bottom = sOff; handles.se.style.right  = eOff; }
        if (handles.sw) { handles.sw.style.bottom = sOff; handles.sw.style.left   = wOff; }
        if (handles.nw) { handles.nw.style.top   = nOff; handles.nw.style.left   = wOff; }
    }
}

/**
 * Makes an element draggable
 * @param {HTMLElement} element - The element to make draggable
 * @param {Object} options - Configuration options
 * @param {HTMLElement|string} [options.handle] - Element or selector for drag handle
 * @param {Function} [options.onDrag] - Callback during drag
 * @param {Function} [options.onDragStart] - Callback when drag starts
 * @param {Function} [options.onDragEnd] - Callback when drag ends
 * @param {boolean} [options.shiftKey] - Whether to require shift key for dragging
 * @param {string} [options.requiredKey] - Key that must be held for dragging (e.g., "shift", "control", "alt", or any letter)
 * @param {HTMLElement[]} [options.excludeElements] - Elements to exclude from triggering drag (like the tab menu)
 */

/**
 * Prevent mouse and wheel events from propagating through a floating panel
 * to the 3D views underneath. Pointer events are intentionally NOT blocked
 * because makeDraggable relies on document-level pointerup to end drags.
 */
export function blockViewEvents(element) {
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
        element.addEventListener(type, (e) => e.stopPropagation());
    }
}

// Bottom edge (px) of the Sitrec top menu bar, so floating windows can stay below it.
function menuBarBottomPx() {
    const el = document.getElementById("menuBarBlackBar");
    return el ? (el.offsetTop + el.offsetHeight) : 0;
}

// True when a window dragged by `handle` is far enough above the menu bar that
// releasing should dismiss it (the handle's mid-point is above the menu bar bottom).
function willCloseOffTop(element, handle) {
    const h = (handle && handle.offsetHeight) || 30;
    const top = parseFloat(element.style.top) || 0;
    return (top + h / 2) < menuBarBottomPx();
}

// Clamp a floating window's top so it sits at/below the menu bar — used on re-open
// so a window that was dragged off the top doesn't come back stranded off-screen.
export function clampBelowMenuBar(element, pad = 8) {
    if (!element) return;
    const limit = menuBarBottomPx() + pad;
    const top = parseFloat(element.style.top) || 0;
    if (top < limit) element.style.top = `${limit}px`;
}

export function makeDraggable(element, options = {}) {
    if (!element) return;
    
    // Store the view instance on the element for callbacks
    const viewInstance = options.viewInstance;
    element._dragData = { viewInstance };
    
    let isDragging = false;
    let startX, startY;
    let startLeft, startTop;
    
    // Determine the handle element
    let handleElement = element;
    if (options.handle) {
        if (typeof options.handle === 'string') {
            handleElement = element.querySelector(options.handle);
        } else if (options.handle instanceof HTMLElement) {
            handleElement = options.handle;
        }
    }
    
    if (!handleElement) handleElement = element;
    
    // Store original cursor for restoration
    const originalCursor = handleElement.style.cursor || '';
    const requiresKey = options.shiftKey || options.requiredKey;
    
    // Only set move cursor immediately if no key is required
    if (!requiresKey) {
        handleElement.style.cursor = 'move';
    }
    
    // Update cursor and border based on key state
    const updateCursorAndBorder = () => {
        if (!requiresKey) return;
        const keyHeld = (options.shiftKey && isKeyHeld('shift')) ||
                       (options.requiredKey && isKeyHeld(options.requiredKey));
        handleElement.style.cursor = keyHeld ? 'move' : originalCursor;

        // Show/hide drag border on this element
        if (keyHeld) {
            showDragBorder(element);
        } else {
            hideDragBorder(element);
        }
    };

    // Listen for key changes if a key is required
    if (requiresKey) {
        document.addEventListener('keydown', updateCursorAndBorder);
        document.addEventListener('keyup', updateCursorAndBorder);
    }
    
    const isEventInExcludedElement = (e) => {
        if (!options.excludeElements || options.excludeElements.length === 0) {
            return false;
        }
        let target = e.target;
        while (target) {
            for (const excludedElement of options.excludeElements) {
                if (target === excludedElement || excludedElement.contains(target)) {
                    return true;
                }
            }
            target = target.parentElement;
        }
        return false;
    };
    
    const onPointerDown = (e) => {
        // Check if event target is in an excluded element
        if (isEventInExcludedElement(e)) {
            return;
        }

        // Check if shift key is required and pressed
        if (options.shiftKey && !e.shiftKey) return;

        // Check if a specific key is required and held
        if (options.requiredKey && !isKeyHeld(options.requiredKey)) return;
        
        // Prevent default to avoid text selection during drag
        e.preventDefault();
        e.stopPropagation();

        // Get initial positions - use element's current style for document-relative coordinates
        startX = e.clientX;
        startY = e.clientY;

        // Get the element's current position in document coordinates, not viewport coordinates
        startLeft = parseFloat(element.style.left) || 0;
        startTop = parseFloat(element.style.top) || 0;

        isDragging = true;
        isViewDragging = true;

        // Call onDragStart callback if provided. Pass viewInstance for parity with onDrag /
        // onDragEnd — without it `data.viewInstance` is undefined at drag start, silently
        // no-opping any callback that relies on it (e.g. CNodeView's header-drag pin guard).
        if (options.onDragStart && typeof options.onDragStart === 'function') {
            options.onDragStart(e, { left: startLeft, top: startTop, element, viewInstance });
        }

        // Add global event listeners using pointer events for better off-screen support
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        // pointercancel: the gesture can be aborted (OS / browser / touch takeover) with NO
        // pointerup to follow — end the drag there too so state, listeners and onDragEnd don't
        // get left dangling.
        document.addEventListener('pointercancel', onPointerCancel);
    };

    const onPointerMove = (e) => {
        if (!isDragging) {
            return;
        }

        e.stopPropagation();

        // Calculate new position
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = startLeft + dx;
        let newTop = startTop + dy;

        // Apply snapping if we have a view instance
        if (viewInstance) {
            const width = viewInstance.widthPx || parseFloat(element.style.width) || element.offsetWidth;
            const height = viewInstance.heightPx || parseFloat(element.style.height) || element.offsetHeight;
            const snapped = calculateSnap(newLeft, newTop, width, height, viewInstance);
            newLeft = snapped.left;
            newTop = snapped.top;
        }

        // Update element position
        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;
        
        // Call onDrag callback if provided
        if (options.onDrag && typeof options.onDrag === 'function') {
            const result = options.onDrag(e, { 
                left: newLeft, 
                top: newTop, 
                dx, 
                dy, 
                element,
                viewInstance: element._dragData.viewInstance
            });
            
            // If callback returns false, revert the position
            if (result === false) {
                element.style.left = `${startLeft}px`;
                element.style.top = `${startTop}px`;
            }
        }

        // visual hint: dragging the handle up under the menu bar will close the window
        if (options.closeOnDragOffTop) {
            element.style.opacity = willCloseOffTop(element, handleElement) ? "0.5" : "";
        }
    };

    const onPointerUp = (e) => {
        if (!isDragging) return;

        e.stopPropagation();
        isDragging = false;
        isViewDragging = false;

        // If released with the window dragged up under the menu bar, close it instead
        // of leaving it stranded off-screen (re-opening repositions it below the bar).
        if (options.closeOnDragOffTop) {
            element.style.opacity = "";
            if (willCloseOffTop(element, handleElement)) {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerCancel);
                options.closeOnDragOffTop({
                    left: parseFloat(element.style.left) || 0,
                    top: parseFloat(element.style.top) || 0,
                    element,
                    viewInstance: element._dragData && element._dragData.viewInstance,
                });
                return;
            }
        }

        // Call onDragEnd callback if provided
        if (options.onDragEnd && typeof options.onDragEnd === 'function') {
            options.onDragEnd(e, { 
                left: parseInt(element.style.left), 
                top: parseInt(element.style.top), 
                element,
                viewInstance: element._dragData.viewInstance
            });
        }
        
        // Recompute handle positions for all views after a drag
        updateAllHandlePositions();

        // Remove global event listeners
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
    };

    // Pointer interaction interrupted (OS / browser / touch takeover): per the Pointer Events
    // spec no pointerup follows, so without this the drag is left half-finished — isDragging
    // stuck true, document listeners orphaned, and onDragEnd never fired (so a consumer's drag
    // flag, e.g. CNodeView._headerDragging, stays stuck → bar permanently shown). End the drag
    // like pointerup, but WITHOUT the closeOnDragOffTop close action (a cancel is an abort, not
    // a deliberate drop), and always fire onDragEnd so consumers can clean up.
    const onPointerCancel = (e) => {
        if (!isDragging) return;
        isDragging = false;
        isViewDragging = false;
        if (options.closeOnDragOffTop) {
            element.style.opacity = "";
        }
        if (options.onDragEnd && typeof options.onDragEnd === 'function') {
            options.onDragEnd(e, {
                left: parseInt(element.style.left),
                top: parseInt(element.style.top),
                element,
                viewInstance: element._dragData?.viewInstance,
                cancelled: true,
            });
        }
        updateAllHandlePositions();
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
    };

    // Add event listener to handle using pointerdown for better off-screen support
    handleElement.addEventListener('pointerdown', onPointerDown);
    
    // Store cleanup function on element.
    // A single element can have makeDraggable called more than once (e.g. a view div with
    // the Phase-1 Q-drag on the whole div AND a header-bar drag handle). Chain any previous
    // cleanup so the earlier wiring's listeners — including the document keydown/keyup added
    // for requiredKey — are removed too, instead of being orphaned by this reassignment.
    const _previousDragCleanup = element._dragCleanup;
    element._dragCleanup = () => {
        handleElement.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
        if (requiresKey) {
            document.removeEventListener('keydown', updateCursorAndBorder);
            document.removeEventListener('keyup', updateCursorAndBorder);
        }
        hideDragBorder(element);
        if (_previousDragCleanup) _previousDragCleanup();
        delete element._dragData;
        delete element._dragCleanup;
    };
    
    return element;
}

/**
 * Makes an element resizable
 * @param {HTMLElement} element - The element to make resizable
 * @param {Object} options - Configuration options
 * @param {boolean} [options.aspectRatio] - Whether to maintain aspect ratio
 * @param {string} [options.handles] - Which handles to show ('n,e,s,w,ne,se,sw,nw' or 'all')
 * @param {Function} [options.onResize] - Callback during resize
 * @param {Function} [options.onResizeStart] - Callback when resize starts
 * @param {Function} [options.onResizeEnd] - Callback when resize ends
 */
export function makeResizable(element, options = {}) {
    if (!element) return;
    
    // Store the view instance on the element for callbacks
    const viewInstance = options.viewInstance;
    element._resizeData = { viewInstance };
    
    // Set position to relative if not already absolute or fixed
    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.position !== 'absolute' && computedStyle.position !== 'fixed') {
        element.style.position = 'relative';
    }
    
    // Determine which handles to create
    const handles = options.handles === 'all' ? 
        ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] : 
        (options.handles || 'se').split(',').map(h => h.trim());
    
    // Create resize handles
    const handleElements = {};
    handles.forEach(dir => {
        const handle = document.createElement('div');
        handle.className = `resize-handle resize-handle-${dir}`;
        handle.style.position = 'absolute';
        handle.style.width = '10px';
        handle.style.height = '10px';
        handle.style.backgroundColor = 'transparent';
        handle.style.zIndex = '1000';
        // Add subtle hover effect to make handles more discoverable
        handle.style.transition = 'background-color 0.2s ease';
        handle.addEventListener('mouseenter', () => {
            // Don't override drag border highlight
            if (!elementsWithDragBorder.has(element)) {
                handle.style.backgroundColor = 'rgba(100, 150, 255, 0.3)';
            }
        });
        handle.addEventListener('mouseleave', () => {
            // Don't remove drag border highlight
            if (!elementsWithDragBorder.has(element)) {
                handle.style.backgroundColor = 'transparent';
            }
        });
        
        // Position handles straddling the edge (macOS-style) so they
        // don't overlap scrollbars or content inside the panel.
        // updateAllHandlePositions() will later adjust these inward
        // where adjacent windows' handles would overlap.
        switch (dir) {
            case 'n':
                handle.style.top = `-${HANDLE_HALF}px`;
                handle.style.left = '0px';
                handle.style.cursor = 'n-resize';
                handle.style.width = '100%';
                handle.style.height = `${HANDLE_SIZE}px`;
                break;
            case 'e':
                handle.style.top = '0px';
                handle.style.right = `-${HANDLE_HALF}px`;
                handle.style.cursor = 'e-resize';
                handle.style.width = `${HANDLE_SIZE}px`;
                handle.style.height = '100%';
                break;
            case 's':
                handle.style.bottom = `-${HANDLE_HALF}px`;
                handle.style.left = '0px';
                handle.style.cursor = 's-resize';
                handle.style.width = '100%';
                handle.style.height = `${HANDLE_SIZE}px`;
                break;
            case 'w':
                handle.style.top = '0px';
                handle.style.left = `-${HANDLE_HALF}px`;
                handle.style.cursor = 'w-resize';
                handle.style.width = `${HANDLE_SIZE}px`;
                handle.style.height = '100%';
                break;
            case 'ne':
                handle.style.top = `-${HANDLE_HALF}px`;
                handle.style.right = `-${HANDLE_HALF}px`;
                handle.style.cursor = 'ne-resize';
                break;
            case 'se':
                handle.style.bottom = `-${HANDLE_HALF}px`;
                handle.style.right = `-${HANDLE_HALF}px`;
                handle.style.cursor = 'se-resize';
                break;
            case 'sw':
                handle.style.bottom = `-${HANDLE_HALF}px`;
                handle.style.left = `-${HANDLE_HALF}px`;
                handle.style.cursor = 'sw-resize';
                break;
            case 'nw':
                handle.style.top = `-${HANDLE_HALF}px`;
                handle.style.left = `-${HANDLE_HALF}px`;
                handle.style.cursor = 'nw-resize';
                break;
        }
        
        element.appendChild(handle);
        handleElements[dir] = handle;
        
        // Add resize event listeners
        let isResizing = false;
        let startX, startY;
        let startWidth, startHeight, startLeft, startTop;
        let aspectRatio;
        
        const onPointerDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = element.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            // Get element position from style for document-relative coordinates, not viewport coordinates
            startLeft = parseFloat(element.style.left) || 0;
            startTop = parseFloat(element.style.top) || 0;
            
            if (options.aspectRatio) {
                aspectRatio = startWidth / startHeight;
            }
            
            // Call onResizeStart callback if provided
            if (options.onResizeStart && typeof options.onResizeStart === 'function') {
                options.onResizeStart(e, { 
                    width: startWidth, 
                    height: startHeight, 
                    left: startLeft, 
                    top: startTop, 
                    element,
                    direction: dir,
                    viewInstance: element._resizeData.viewInstance
                });
            }
            
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
        };
        
        const onPointerMove = (e) => {
            if (!isResizing) return;
            
            let newWidth = startWidth;
            let newHeight = startHeight;
            let newLeft = startLeft;
            let newTop = startTop;
            
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            // Calculate new dimensions based on handle direction
            switch (dir) {
                case 'n':
                    newHeight = startHeight - dy;
                    newTop = startTop + dy;
                    if (options.aspectRatio) {
                        newWidth = newHeight * aspectRatio;
                    }
                    break;
                case 'e':
                    newWidth = startWidth + dx;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 's':
                    newHeight = startHeight + dy;
                    if (options.aspectRatio) {
                        newWidth = newHeight * aspectRatio;
                    }
                    break;
                case 'w':
                    newWidth = startWidth - dx;
                    newLeft = startLeft + dx;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 'ne':
                    newWidth = startWidth + dx;
                    newHeight = startHeight - dy;
                    newTop = startTop + dy;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                        newTop = startTop + (startHeight - newHeight);
                    }
                    break;
                case 'se':
                    newWidth = startWidth + dx;
                    newHeight = startHeight + dy;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 'sw':
                    newWidth = startWidth - dx;
                    newHeight = startHeight + dy;
                    newLeft = startLeft + dx;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 'nw':
                    newWidth = startWidth - dx;
                    newHeight = startHeight - dy;
                    newLeft = startLeft + dx;
                    newTop = startTop + dy;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                        newTop = startTop + (startHeight - newHeight);
                    }
                    break;
            }
            
            // Enforce minimum size
            const minWidth = MIN_VIEW_PX;
            const minHeight = MIN_VIEW_PX;
            
            if (newWidth < minWidth) {
                newWidth = minWidth;
                if (options.aspectRatio) {
                    newHeight = newWidth / aspectRatio;
                }
            }
            
            if (newHeight < minHeight) {
                newHeight = minHeight;
                if (options.aspectRatio) {
                    newWidth = newHeight * aspectRatio;
                }
            }

            // Apply snapping if we have a view instance (and not maintaining aspect ratio, as snapping would break it)
            if (viewInstance && !options.aspectRatio) {
                const snapped = calculateResizeSnap(newLeft, newTop, newWidth, newHeight, dir, viewInstance);
                newLeft = snapped.left;
                newTop = snapped.top;
                newWidth = snapped.width;
                newHeight = snapped.height;
            }

            // Update element dimensions
            element.style.width = `${newWidth}px`;
            element.style.height = `${newHeight}px`;

            // Update position for handles that affect position
            if (['n', 'w', 'nw', 'ne', 'sw'].includes(dir)) {
                element.style.left = `${newLeft}px`;
                element.style.top = `${newTop}px`;
            }
            
            // Call onResize callback if provided
            if (options.onResize && typeof options.onResize === 'function') {
                const result = options.onResize(e, { 
                    width: newWidth, 
                    height: newHeight, 
                    left: newLeft, 
                    top: newTop, 
                    element,
                    direction: dir,
                    viewInstance: element._resizeData.viewInstance
                });
                
                // If callback returns false, revert the dimensions
                if (result === false) {
                    element.style.width = `${startWidth}px`;
                    element.style.height = `${startHeight}px`;
                    element.style.left = `${startLeft}px`;
                    element.style.top = `${startTop}px`;
                }
            }
        };
        
        const onPointerUp = (e) => {
            if (!isResizing) return;
            
            isResizing = false;
            
            // Call onResizeEnd callback if provided
            if (options.onResizeEnd && typeof options.onResizeEnd === 'function') {
                options.onResizeEnd(e, { 
                    width: parseInt(element.style.width), 
                    height: parseInt(element.style.height), 
                    left: parseInt(element.style.left), 
                    top: parseInt(element.style.top), 
                    element,
                    direction: dir,
                    viewInstance: element._resizeData.viewInstance
                });
            }
            
            // Recompute handle positions for all views after a resize
            updateAllHandlePositions();

            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
        };

        handle.addEventListener('pointerdown', onPointerDown);
        handle._resizeCleanup = () => {
            handle.removeEventListener('pointerdown', onPointerDown);
        };
    });

    // Store handles on element for border highlighting
    element._resizeHandles = handleElements;

    // Store cleanup function on element
    element._resizeCleanup = () => {
        handles.forEach(dir => {
            const handle = handleElements[dir];
            if (handle && handle._resizeCleanup) {
                handle._resizeCleanup();
                element.removeChild(handle);
            }
        });
        delete element._resizeData;
        delete element._resizeCleanup;
    };
    
    return element;
}

/**
 * Removes draggable functionality from an element
 * @param {HTMLElement} element - The element to remove draggable from
 */
export function removeDraggable(element) {
    if (element && element._dragCleanup) {
        element._dragCleanup();
    }
}

/**
 * Removes resizable functionality from an element
 * @param {HTMLElement} element - The element to remove resizable from
 */
export function removeResizable(element) {
    if (element && element._resizeCleanup) {
        element._resizeCleanup();
    }
}

/**
 * Makes an element both draggable and resizable
 * @param {HTMLElement} element - The element to make draggable and resizable
 * @param {Object} options - Combined options for both functionalities
 */
export function makeDraggableAndResizable(element, options = {}) {
    makeDraggable(element, options);
    makeResizable(element, options);
    
    return element;
}