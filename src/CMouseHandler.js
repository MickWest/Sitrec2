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

        this.view.canvas.addEventListener('wheel', e => this.handleMouseWheel(e));
        this.view.canvas.addEventListener('pointermove', e => this.handleMouseMove(e));
        this.view.canvas.addEventListener('pointerdown', e => this.handleMouseDown(e));
        this.view.canvas.addEventListener('pointerup', e => this.handleMouseUp(e));
        this.view.canvas.addEventListener('pointercancel', e => this.handlePointerCancel(e));
        this.view.canvas.addEventListener('dblclick', e => this.handleMouseDblClick(e));
        this.view.canvas.addEventListener('contextmenu', e => this.handleContextMenu(e));
        this.view.canvas.addEventListener('mouseLeave', e => this.handleMouseLeave(e));
    }

    newPosition(e, anchor) {
        const x = e.clientX - this.view.leftPx;
        const y = e.clientY - this.view.topPx;
        this.dx = x - this.x;
        this.dy = y - this.y;
        this.x = x;
        this.y = y;
        if (anchor) {
            this.anchorX = x;
            this.anchorY = y
        }
        // console.log("Mouse: "+this.x+","+this.y+","+" Delta: "+this.dx+","+this.dy)
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
        this.view.canvas.setPointerCapture(e.pointerId)

        // Track pointer for multi-touch detection
        this.activePointers.add(e.pointerId);

        this.newPosition(e, true)
        this.dragging = true;
        
        // Cancel long press if a second finger touches down
        if (this.activePointers.size > 1 && this.longPressTimer) {
            this.clearLongPressTimer();
        }
        
        // Start long press timer for single-finger touch events only (not for mouse right-click)
        // pointerType will be 'touch' for touch events, 'mouse' for mouse events
        if (e.pointerType === 'touch' && e.button === 0 && this.activePointers.size === 1) {
            this.longPressStartX = e.clientX;
            this.longPressStartY = e.clientY;
            this.longPressEvent = e;
            this.isLongPressTriggered = false;
            
            this.longPressTimer = setTimeout(() => {
                this.isLongPressTriggered = true;
                
                // Create synthetic right-click event for context menu
                const syntheticEvent = new PointerEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: this.longPressStartX,
                    clientY: this.longPressStartY,
                    pointerType: 'touch',
                    button: 2
                });
                
                // Add custom properties
                Object.defineProperty(syntheticEvent, 'isSynthetic', { value: true });
                Object.defineProperty(syntheticEvent, 'originalEvent', { value: e });
                
                this.handleContextMenu(syntheticEvent);
                
                // Clean up state since context menu interrupts normal pointer flow
                this.activePointers.clear();
                this.dragging = false;
                if (e.pointerId !== undefined) {
                    this.view.canvas.releasePointerCapture(e.pointerId);
                }
                
                // Vibrate for tactile feedback
                if (navigator.vibrate) {
                    navigator.vibrate(50);
                }
            }, this.longPressDuration);
        }
        
        if (this.handlers.down) this.handlers.down(e)

    }

    handleMouseUp(e) {
//        e.preventDefault();
        this.view.canvas.releasePointerCapture(e.pointerId)

        // Remove pointer from active set
        this.activePointers.delete(e.pointerId);

        // Clear long press timer
        this.clearLongPressTimer();

        this.newPosition(e)
        this.dragging = false;
        
        // Don't trigger up handler if long press was triggered
        if (!this.isLongPressTriggered) {
            if (this.handlers.up) this.handlers.up(e)
        } else {
            // Reset flag
            this.isLongPressTriggered = false;
        }

    }

    handlePointerCancel(e) {
        // Handle pointer interruptions (e.g., browser gestures, context menus)
        this.view.canvas.releasePointerCapture(e.pointerId);
        this.activePointers.delete(e.pointerId);
        this.clearLongPressTimer();
        this.dragging = false;
        this.isLongPressTriggered = false;
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


}