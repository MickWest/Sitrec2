import {isKeyHeld} from "./KeyBoardHandler";
import {getInteractionRouter, INTERACTION} from "./InteractionRouter";
import {isViewDisplayed, mouseInViewOnly} from "./ViewUtils";

// The basic functionality of a mouse handler attached to a view
// stores last mouse position, delta, etc
export class CMouseHandler {
    constructor(view, handlers) {
        this.view = view
        this.handlers = handlers;
        this.x = 0;
        this.y = 0;
        this.dx = 0;
        this.dy = 0;
        this.dragging = false;

        // Long press support for mobile context menu
        this.longPressTimer = null;
        this.longPressDuration = 500; // 500ms
        this.longPressThreshold = 10; // 10px movement threshold
        this.longPressStartX = 0;
        this.longPressStartY = 0;
        this.longPressEvent = null;
        this.isLongPressTriggered = false;
        this.activePointers = new Set(); // Track active pointer IDs for multi-touch detection

        const surface = e => mouseInViewOnly(view, e.clientX, e.clientY)
            ? {kind: INTERACTION.DRAG, zIndex: view.zIndex ?? 0} : null;
        this.unregisterInteraction = getInteractionRouter(view.canvas.ownerDocument).register({
            id: `video:${view.id}`, model: view, navigation: true, priority: 0,
            enabled: () => isViewDisplayed(view) && !(view.dragKey && isKeyHeld(view.dragKey)),
            valid: () => isViewDisplayed(view),
            hitTest: surface, hitSurface: surface, capture: () => view.canvas,
            begin: e => this.handleMouseDown(e), move: e => this.handleMouseMove(e),
            end: e => this.handleMouseUp(e), cancel: e => this.handlePointerCancel(e),
            beginTouches: e => { this.touchPair = this.touchGeometry(e); },
            moveTouches: e => this.handleTouches(e),
            endTouches: () => { this.touchPair = null; },
            wheel: e => this.handleMouseWheel(e), contextMenu: e => this.handleContextMenu(e),
            hover: e => { if (e) this.handleMouseMove(e); },
        });
        view.canvas.style.touchAction = "none";
        this.view.canvas.addEventListener('dblclick', e => this.handleMouseDblClick(e));
        this.view.canvas.addEventListener('mouseleave', e => this.handleMouseLeave(e));
    }

    touchGeometry(e) {
        if (e.touches.length !== 2) return null;
        const [a, b] = e.touches;
        return {clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2,
            distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)};
    }

    handleTouches(e) {
        const next = this.touchGeometry(e), previous = this.touchPair;
        this.touchPair = next;
        if (!next || !previous) return;
        this.newPosition(previous, true);
        this.newPosition(next);
        this.handlers.drag?.(e);
        this.newPosition(next, true);
        if (previous.distance > 0 && next.distance > 0) this.handlers.pinch?.(next.distance / previous.distance);
    }

    newPosition(e, anchor) {
        const rect = this.view.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        this.dx = x - this.x;
        this.dy = y - this.y;
        this.x = x;
        this.y = y;
        if (anchor) {
            this.anchorX = x;
            this.anchorY = y
        }
    }

    handleMouseLeave(e) {
        // does not seem like it makes a diference
        //       e.preventDefault();

    }

    handleMouseWheel(e) {
        e.preventDefault();
        this.newPosition(e, true)
        if (this.handlers.wheel) this.handlers.wheel(e)
    }

    handleMouseMove(e) {
        if (this.dragging && e.buttons === 0) this.handlePointerCancel(e);
//        console.log("Move, dragging = "+this.dragging)
//        e.preventDefault();
        this.newPosition(e)

        // Check if movement exceeds long press threshold
        if (this.longPressTimer) {
            const deltaX = Math.abs(e.clientX - this.longPressStartX);
            const deltaY = Math.abs(e.clientY - this.longPressStartY);
            
            if (deltaX > this.longPressThreshold || deltaY > this.longPressThreshold) {
                this.clearLongPressTimer();
            }
        }

        if (this.dragging) {
            if (e.buttons === 1) {
                if (this.handlers.drag) {
                    this.handlers.drag(e)
                }
            }
            if (e.buttons === 2) {
                if (this.handlers.rightDrag) {
                    this.handlers.rightDrag(e)
                }
            }
            if (e.buttons === 4) {
                if (this.handlers.centerDrag) {
                    this.handlers.centerDrag(e)
                }
            }


        } else {
            if (this.handlers.move) this.handlers.move(e)
        }
    }

    handleMouseDown(e) {
//        e.preventDefault();

        // If the view has a dragKey and it's currently held, don't capture the pointer
        // Let the event bubble up to the parent div's makeDraggable handler
        if (this.view.dragKey && isKeyHeld(this.view.dragKey)) {
            return;
        }


        // Track pointer for multi-touch detection
        this.activePointers.add(e.pointerId);

        this.newPosition(e, true)
        this.dragging = true;

        // Track right-click down position for context menu detection
        if (e.button === 2) {
            this._contextMenuDownPos = { x: e.clientX, y: e.clientY };
        }

        // Cancel long press if a second finger touches down
        if (this.activePointers.size > 1 && this.longPressTimer) {
            this.clearLongPressTimer();
        }
        
        if (this.handlers.down) this.handlers.down(e)

    }

    handleMouseUp(e) {
//        e.preventDefault();
        const wasDragging = this.dragging;
        this.dragging = false;

        // Remove pointer from active set
        this.activePointers.delete(e.pointerId);

        // Clear long press timer
        this.clearLongPressTimer();

        this.newPosition(e)
        this.dragging = false;

        this._contextMenuDownPos = null;

        // Don't trigger up handler if long press was triggered
        if (wasDragging && !this.isLongPressTriggered) {
            if (this.handlers.up) this.handlers.up(e)
        } else {
            // Reset flag
            this.isLongPressTriggered = false;
        }

    }

    handlePointerCancel(e) {
        // Handle pointer interruptions (e.g., browser gestures, context menus)
        const wasDragging = this.dragging;
        this.dragging = false;
        this.activePointers.delete(e.pointerId);
        this.clearLongPressTimer();
        this.isLongPressTriggered = false;
        this._contextMenuDownPos = null;
        if (wasDragging) (this.handlers.cancel ?? this.handlers.up)?.(e);
    }

    handleMouseDblClick(e) {
        e.preventDefault();
        this.newPosition(e)
        if (this.handlers.dblClick) this.handlers.dblClick(e)
    }

    handleContextMenu(event) {

//		console.log("onConrxt")

        // CRITICAL: Prevent default BEFORE any enabled checks
        // This ensures the browser context menu is ALWAYS blocked
        event.preventDefault();
        event.stopPropagation();

        if (this.enabled === false) return;
        
        this.newPosition(event);
        if (this.handlers.contextMenu) {
            this.handlers.contextMenu(event);
        }

    }

    clearLongPressTimer() {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }

    dispose() {
        this.unregisterInteraction?.();
        this.clearLongPressTimer();
    }


}
