///////////////////////////////////////////////////////////////////////////////
// CNodeView is the base class of all the views (2D, text, 3D, and maybe more)
// it has a div, which can be resized with our modern drag/resize utilities
// canvas elements are in CNodeView3D
// take their size from the div.
//
import {CNode} from './CNode'
import {Globals, guiShowHideGraphs, guiShowHideViews, NodeMan, setRenderOne, UndoManager} from "../Globals";
import {assert} from "../assert";
import {ViewMan} from "../CViewManager";
import {LayoutMan} from "../CLayoutManager";
import {makeDraggable, makeResizable, removeDraggable, removeResizable, VIEW_EDIT_KEY, clampBelowMenuBar} from "../DragResizeUtils";
import {CUIBar, hudClipPath} from "../CUIBar";
import {FRIENDLY_VIEW_NAMES, populateViewUIBarMenu} from "../ViewUIBarMenus";
import {isKeyHeld} from "../KeyBoardHandler";
import {par} from "../par";
import {
    getCenterSidebarAdjustment,
    getLeftSidebar,
    getRightSidebar,
    hideLeftSidebar,
    hideRightSidebar,
    isCenterSidebarSuspended,
    resumeCenterSidebar,
    showLeftSidebar,
    showRightSidebar,
    suspendCenterSidebar
} from "../PageStructure";

const DOCK_EDGE_PX = 36;
const DOCK_MARGIN_PX = 8;
const CLOSE_OFF_TOP_PX = -5;

// Friendly, capitalised view names for the per-view header (UIBar). Falls back to the
// view's menuName, then a prettified id ("altitudeGraphView" → "Altitude Graph").
// The big content views default to an UNpinned (hover-reveal) header — a persistent bar is
// intrusive there. Other views (editors/panels) default pinned. The state is serialized;
// old sitches (no serialized value) assume off (see modDeserialize).
const HEADER_DEFAULT_OFF = new Set(["mainView", "lookView", "video", "video2"]);

// A header/Q drag must move the pointer past MOVE_THRESHOLD before it moves the view at all
// (so a click with tiny jitter doesn't nudge it), and past the much larger DOCK_THRESHOLD
// before a drag can dock the view to a sidebar (so a click near a screen edge can't dock it).
const HEADER_DRAG_MOVE_THRESHOLD = 5;
const HEADER_DRAG_DOCK_THRESHOLD = 60;
// A tiled view is locked in the grid; dragging its header past this distance pops it out into
// a free-floating window (Blender-style detach). Larger than the move threshold so a small
// nudge doesn't accidentally tear a tile out of the layout.
const HEADER_DRAG_DETACH_THRESHOLD = 30;
function friendlyViewName(v, id) {
    if (FRIENDLY_VIEW_NAMES[id]) return FRIENDLY_VIEW_NAMES[id];
    if (v && v.menuName) return v.menuName;
    let s = String(id).replace(/View$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    if (!s) s = String(id);
    return s.charAt(0).toUpperCase() + s.slice(1);
}

const defaultCViewParams = {
    visible: true,
    background:null,
    up: [0,1,0],
    fov: 45,
    draggable: false,
    resizable: false,
    doubleClickResizes: false,
    doubleClickFullScreen: true,

}

// a view node is renderable node, usually a window
class CNodeView extends CNode {
    constructor (v) {
        assert(v.id !== undefined,"View Node Requires ID")
        super(v)

        this.nominalViewWidth = 2*948; // expected width of the look view in pixels, for scaling point sprites
        this.nominalViewHeight = 1080


        // optionally make the view relative to anohther view
        this.input("relativeTo", true);

        // merge defaults with the passed parameters
        // into this. We used to merge in all of v, but that's not a good idea
        // as it leads to unexpected behaviour.
        // Object.assign(this,defaultCViewParams,v)
        Object.assign(this,defaultCViewParams)

        // // Instead of merging, we just copy the parameters we want
        this.top = v.top ?? 0;
        this.left = v.left ?? 0;
        this.width = v.width ?? 1;
        this.height = v.height ?? 1;

        // in initial setup, move windows to not go outside screen
        // only on MetaQuest?
        if (Globals.onMetaQuest) {
            let w = this.width;
            let h = this.height;
            if (w < 0) w = -w * h;
            if (h < 0) h = -h * w;

            if (this.left + w > 0.99) {
                this.left = 0.99 - w;
            }

            if (this.top + h > 0.99) {
                this.top = 0.99 - h;
            }
        }


  //      if (v.visible !== undefined)
        this.visible = v.visible ?? true;

        // all views are display nodes, meaning they are counted to determine
        // if we need to recalculate any of their inputs that have
        this.isDisplayNode = true; // all view nodes are display nodes checkDisplayOutputs set to true


        this.background = v.background;
        this.up = v.up;
        this.fov = v.fov;
        this.draggable = v.draggable;
        this.resizable = v.resizable;
        this.doubleClickResizes = v.doubleClickResizes;
        if (v.doubleClickFullScreen !== undefined) this.doubleClickFullScreen = v.doubleClickFullScreen;
        this.alwaysOnTop = v.alwaysOnTop ?? false;
        this.poppable = v.poppable ?? false;   // adds a ⧉ "pop out into a browser window" header icon
        this.windowed = false;                 // true while popped out — the in-page view is closed for layout
        // Static-DOM views (Notes) keep their content when popped out and need no rendering while
        // windowed. Live canvas views (the DAG) must keep being drawn each frame even while popped;
        // they opt in here so the render loop renders them and sizes the canvas from the popup.
        this.renderWhileWindowed = v.renderWhileWindowed ?? false;
        this.shiftDrag = v.shiftDrag;
        this.dragKey = v.dragKey;

        // --- Phase 1: unified view interaction ---
        // All movable views share ONE edit gesture: hold VIEW_EDIT_KEY (Q) to highlight
        // edges, move, and edge-resize with snapping. Legacy per-view configs are mapped
        // onto it so the interaction is identical everywhere: shiftDrag:true (was "hold
        // Shift") and bare-drag (no modifier at all) BOTH become the single Q gesture.
        // Done in one place rather than at ~40 view-definition call sites.
        if (this.draggable || this.resizable) {
            this.dragKey = VIEW_EDIT_KEY;
            this.shiftDrag = false;
        }

        this.freeAspect = v.freeAspect;
        this.dockable = v.dockable ?? this.draggable;
        this.dockedSidebar = null;
        this.floatingRectBeforeDock = null;
        this.dockedAspectRatio = null;
        this.dockedTextScale = v.dockedTextScale;
        this.dockedTextOriginalFontSizes = null;
        //
        //

        this.passThrough = v.passThrough ?? false;

        // container defaults to the window, but could be something else
        // (not yet tested with anything else)
        if (this.container === undefined)
            this.container = ViewMan.container;   // was window

        this.updateWH(); //need to get the pixel dimension to set the div

        if (v.overlayView) {
            this.overlayView = NodeMan.get(v.overlayView); // might be an id, so get the object
            this.div = this.overlayView.div
            assert(this.div, "Overlay view does not have a div")
        } else {

            this.div = document.createElement('div')
            this.div.style.position = 'absolute';

            // was recommended to fix Occulus overflow resizing.
            // does not work
            // this.div.style.contain = "layout size";

            this.div.style.top = this.topPx + 'px';
            this.div.style.left = this.leftPx + 'px';
            this.div.style.width = this.widthPx + 'px'
            this.div.style.height = this.heightPx + 'px'
            this.div.style.zIndex = 1;

            this.div.style.pointerEvents = 'auto';
            if (this.passThrough) {
                this.div.style.pointerEvents = 'none';
            }

//            console.log("For node "+this.id+" INITIAL setting widthPx,heightPx and div.style to "+this.widthPx+","+this.heightPx)

            // setting border style of divs also needs a color setting
            //this.div.style.borderStyle = 'solid'
            //this.div.style.color = '#404040';

            // Single-pixel 25% transparent grey border so view edges are always visible.
            // Use an inset outline (offset -1px) so it draws inside the bounds and does
            // not affect layout the way a border would. Base (free-standing) views only:
            // this else-branch already excludes overlayView; also exclude relativeTo views
            // (e.g. the compass HUD), which attach to a parent view and should not get a box.
            if (!this.in.relativeTo) {
                this.div.style.outline = '1px solid rgba(128, 128, 128, 0.25)';
                this.div.style.outlineOffset = '-1px';
            }



            if (this.container === window) {
                this.divParent = document.body;
            } else {
                this.divParent = this.container;
            }
            this.floatingParent = this.divParent;

            this.divParent.appendChild(this.div);

            if (this.draggable) {
                makeDraggable(this.div, {
                    handle: v.dragHandle,
                    viewInstance: this,
                    shiftKey: this.shiftDrag,
                    requiredKey: this.dragKey,
                    onDragStart: (event, data) => {
                        this.onViewDragStart?.(event, {...data, viewInstance: this});
                    },
                    onDrag: (event, data) => {
                        const view = data.viewInstance;
                        if (!view.draggable) return false;
                        if (view.dockedSidebar) return true;
                        // If dragKey is set, use that instead of shiftDrag
                        if (view.dragKey) {
                            if (!isKeyHeld(view.dragKey)) return false;
                        } else if (view.shiftDrag && !event.shiftKey) {
                            return false;
                        }
                        return view._applyDragMove(data, event);
                    },
                    onDragEnd: (event, data) => {
                        data.viewInstance?.onViewDragEnd?.(event, data);
                    },
                });
            }
            
            if (this.resizable) {
                makeResizable(this.div, {
                    handles: 'all',
                    aspectRatio: !this.freeAspect,
                    viewInstance: this,
                    onResize: (event, data) => {
                        const view = data.viewInstance;
                        return true;
                    }
                });
            }

            // Phase 3: per-view header overlay (hover-reveal + pin). Additive chrome —
            // does NOT inset the canvas or change geometry/rendering/serialization.
            this.createViewHeader(v);

            const visibleToSet = this.visible;
            this.visible = undefined; // force update
            this.setVisible(visibleToSet)

        }

        assert(!ViewMan.exists(v.id),"Adding "+v.id+" to ViewMan twice")
        ViewMan.add(v.id,this)

        this.excludeFromViewsMenu = v.excludeFromViewsMenu ?? false;

        if (!this.overlayView && !this.excludeFromViewsMenu) {
            const name = v.menuName ?? this.id;
            this.showHideName = name;

            let menu = guiShowHideViews;
            // if it's derived from a graph view, then put it in the graph submenu
            if (v.isGraphView) {
                menu = guiShowHideGraphs;
            }

            // menu entry to show/hide this view. Kept as a member so a subclass can
            // publish it somewhere else as well — the compass mirrors it into its host
            // view's header menu (CNodeCompassUI), which is the SAME controller, not a
            // second copy of the flag.
            this.showHideController = menu.add(this, 'visible').listen().name(name).onChange(value => {
                this.visible = undefined; // force update
                this.setVisible(value);
                if (value) {
                    // if we are showing the view, then recaulcualte
                    // for things like graphs
                    this.recalculate();
                }
            })
                .tooltip("Show/Hide the view: " + name);
        }

        this.applyEarlyMods();
    }

    // After this view moves (Q-drag or header-drag), refresh dependents: overlay children
    // inherit the new size, relativeTo children re-layout. Shared by both drag wirings.
    _propagateDragToDependents() {
        // Don't let the view be dragged above the menu bar — snap it flush under (pad 0).
        clampBelowMenuBar(this.div, 0);
        this.setFromDiv(this.div);
        ViewMan.iterate((id, v) => {
            if (v.overlayView === this) v.inheritSize();
            if (v.in.relativeTo === this) v.updateWH();
        });
    }

    // Apply a drag move only once the pointer has moved past a small threshold, so a click
    // (no / tiny jitter) doesn't nudge the view. Records the displacement so onViewDragEnd
    // can gate sidebar docking behind a much larger threshold. Returns false (→ makeDraggable
    // reverts to the start position) while under threshold.
    _applyDragMove(data, event) {
        const moved = Math.hypot(data.dx || 0, data.dy || 0);
        this._dragDisplacement = moved;

        // A tiled view is locked in the grid (the seams resize it). Dragging its header far
        // enough detaches it: it pops out of the tree into a free-floating window and then
        // follows the pointer. Below the threshold it stays put (returns false → revert).
        if (LayoutMan.hasLeaf(this.id)) {
            if (moved < HEADER_DRAG_DETACH_THRESHOLD) return false;
            LayoutMan.removeLeaf(this.id);
            this.setResizeHandlesVisible(true);
        }

        // While dragging a floating view in a tiled layout, preview where it would re-dock (the
        // blue zone) so the snap is never a surprise — only when the cursor is in a tile's edge
        // band; the central region shows nothing and leaves the view free-floating.
        if (event && event.clientX !== undefined && moved >= HEADER_DRAG_MOVE_THRESHOLD
            && LayoutMan.active && !LayoutMan.hasLeaf(this.id)) {
            LayoutMan.updateDropPreview(this.id, event.clientX, event.clientY);
        } else {
            LayoutMan.hideDropPreview();
        }

        if (moved < HEADER_DRAG_MOVE_THRESHOLD) return false;
        this._propagateDragToDependents();
        return true;
    }

    // Keep this view's header bar reachable: at least partly visible horizontally and fully
    // visible vertically (below the menu bar, above the bottom of the screen). Used after a
    // drag-end and after undocking from a sidebar.
    _ensureUIBarVisible() {
        if (!this.uiBar || !this.div) return;
        const barH = this.uiBar.bar.offsetHeight || 26;
        const mb = document.getElementById("menuBarBlackBar");
        const menuBottom = mb ? mb.getBoundingClientRect().bottom : 0;
        const screenW = window.innerWidth, screenH = window.innerHeight;
        const minVisible = 80;   // px of the bar that must stay on screen horizontally
        const rect = this.div.getBoundingClientRect();
        let dx = 0, dy = 0;
        if (rect.left > screenW - minVisible) dx = (screenW - minVisible) - rect.left;
        else if (rect.right < minVisible) dx = minVisible - rect.right;
        if (rect.top < menuBottom) dy = menuBottom - rect.top;
        else if (rect.top + barH > screenH) dy = screenH - (rect.top + barH);
        if (dx === 0 && dy === 0) return;
        const left = (parseFloat(this.div.style.left) || this.leftPx) + dx;
        const top = (parseFloat(this.div.style.top) || this.topPx) + dy;
        this.div.style.left = `${Math.round(left)}px`;
        this.div.style.top = `${Math.round(top)}px`;
        this.setFromDiv(this.div);
    }

    // --- Phase 3: per-view header / UI bar (Blender-style) ---
    // The header is a CUIBar: an OVERLAY strip above the canvas (it never insets the
    // canvas, so showing/hiding changes NO rendering — the viewport renders full-size
    // underneath). The bar supports a title, menus, and icon buttons. Hover-reveals; the
    // pin keeps it shown. Runtime chrome only — nothing here is serialized, so saved and
    // legacy sitches are unaffected.
    createViewHeader(v) {
        if (this.overlayView) return;   // overlay views share the parent div
        if (this.passThrough) return;   // pointer events disabled — nothing to hover
        if (v.noUIBar) return;          // HUD instruments (compass, OSD, info) opt out
        if (this.uiBar) return;

        // Title is a lil-gui menu named with a friendly, capitalised view name.
        const title = friendlyViewName(v, this.id);
        const bar = new CUIBar(this.div, {title});
        // Standard chrome, left→right: fullscreen, pin, close.
        if (this.doubleClickFullScreen || this.doubleClickResizes) {
            bar.addIcon('⛶', () => this.doubleClick(), 'Toggle fullscreen', 'fullscreen');
        }
        if (this.poppable) {
            this._popIcon = bar.addIcon('⧉', () => this.togglePopout(), 'Pop out into a window', 'popout');
        }
        bar.addPinIcon(() => this.setHeaderPinned(!this.headerPinned));
        bar.addCloseIcon(() => this.closeViewWithUndo(title));
        this.uiBar = bar;

        // Fill the title menu with this view's own controls, mirrored from the global menus.
        // A no-op for views with no registry entry, and order-independent: controls created
        // later in the sitch load (night sky, video) drop in when they appear.
        populateViewUIBarMenu(this);
        bar.onMenuStateChange = () => this._updateHeaderShown();

        // The header bar is a DRAG HANDLE: drag it to move the view (no modifier — the bar is
        // an explicit affordance). Interactive children (menus, icons) stopPropagation on
        // pointerdown so they don't start a drag. Coexists with the Phase-1 Q-drag-anywhere.
        if (this.draggable) {
            bar.bar.style.cursor = 'move';
            makeDraggable(this.div, {
                handle: bar.bar,
                viewInstance: this,
                onDragStart: (event, data) => {
                    data.viewInstance?._setHeaderDragging(true, event);
                },
                onDrag: (event, data) => {
                    const view = data.viewInstance;
                    if (!view.draggable) return false;
                    if (view.dockedSidebar) return true;
                    return view._applyDragMove(data, event);
                },
                onDragEnd: (event, data) => {
                    data.viewInstance?._setHeaderDragging(false, event);
                    data.viewInstance?.onViewDragEnd?.(event, data);
                },
            });
        }

        this.headerPinned = false;
        this._headerHovering = false;
        this._headerDragging = false;
        // Default pinned for most views; OFF for the big content views (Main/Look/Video).
        // A saved sitch overrides this in modDeserialize; old sitches assume off.
        this.setHeaderPinned(v.pinHeader ?? !HEADER_DEFAULT_OFF.has(this.id));

        // Hover-reveal (only when NOT pinned): the bar fades in while the pointer is over the
        // BAR STRIP itself — not the whole view — AND no mouse button is held. So it won't
        // appear while interacting with view content, nor while a drag passes over the strip
        // (button held). Leaving the strip hides it; mid-strip with a button held leaves the
        // state unchanged (so a header-drag-in-progress isn't hidden out from under itself).
        const updateReveal = (e) => {
            // While dragging the bar it acts as if pinned (see _setHeaderDragging): don't let a
            // fast drag that briefly moves the pointer off the (moving) strip hide it mid-drag.
            if (this.headerPinned || this._headerDragging) return;
            const r = bar.bar.getBoundingClientRect();
            const inBar = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            if (!inBar) {
                if (this._headerHovering) { this._headerHovering = false; this._updateHeaderShown(); }
            } else if (e.buttons === 0 && !this._headerHovering) {
                this._headerHovering = true; this._updateHeaderShown();
            }
        };
        const hideReveal = () => { if (!this.headerPinned && !this._headerDragging && this._headerHovering) { this._headerHovering = false; this._updateHeaderShown(); } };
        this.div.addEventListener('pointermove', updateReveal);
        this.div.addEventListener('pointerleave', hideReveal);
        this.div.addEventListener('pointercancel', hideReveal);
    }

    _updateHeaderShown() {
        if (this.uiBar) {
            // An OPEN menu latches the bar visible. Its dropdown hangs BELOW the strip, so
            // moving the pointer down to click a row leaves the bar's hover region — without
            // this the menu fades out from under the click. The latch releases when the menu
            // closes (title tap, or a press anywhere outside the bar).
            this.uiBar.setShown(this.headerPinned || this._headerHovering
                || this._headerDragging || this.uiBar.hasOpenMenu());
        }
        this._clipHUDsBelowHeader();
    }

    // A view's HUD companions — the compass, the MQ-9 / Wescam OSD frames, the video-info
    // panel — are separate views positioned `relativeTo` this one: SIBLING divs with a higher
    // z-index (updateZOrder stacks by area, and they are the same size). The header lives
    // inside THIS view's stacking context, so no z-index on the bar can climb above them, and
    // they paint over the header and its open menu. They are already pointer-transparent, so
    // the header still receives the clicks — this is purely about what you can see.
    //
    // So clip the shape the header chrome occupies out of any companion that reaches into it.
    // Nothing is lost: that shape is exactly what the opaque header is already covering. It is
    // measured per companion, because clip-path is relative to each one's own box — a corner
    // compass well below the bar is left untouched rather than beheaded.
    _clipHUDsBelowHeader() {
        const chrome = this.uiBar?.shown ? this.uiBar.chromeRect() : null;
        ViewMan.iterate((id, view) => {
            if (view.in?.relativeTo !== this || !view.div) return;
            view.div.style.clipPath = chrome ? hudClipPath(chrome, view.div.getBoundingClientRect()) : "";
        });
    }

    // A header drag must keep the bar visible for the whole gesture, even if the pointer
    // briefly slips off the strip as the view follows it — otherwise an unpinned bar hides
    // out from under the drag. So while dragging we treat the bar like a pinned one (forced
    // shown, hover-reveal suppressed). On drag end we recompute hover from the final pointer
    // position (the strip may have moved) so the bar settles into the right revealed state.
    _setHeaderDragging(dragging, event) {
        this._headerDragging = dragging;
        if (!dragging && event && this.uiBar) {
            const r = this.uiBar.bar.getBoundingClientRect();
            this._headerHovering = !this.headerPinned
                && event.clientX >= r.left && event.clientX <= r.right
                && event.clientY >= r.top && event.clientY <= r.bottom;
        }
        this._updateHeaderShown();
    }

    setHeaderPinned(pinned) {
        this.headerPinned = !!pinned;
        if (this.uiBar) this.uiBar.setPinned(this.headerPinned);
        this._updateHeaderShown();
    }

    // Close (hide) this view via the header ✕, recorded as an undoable action so Undo
    // reopens it (and Redo closes it again). UndoManager.add is a no-op while undoing/redoing.
    closeViewWithUndo(name) {
        // Closing a FULL-SCREENED view always restores the pre-fullscreen layout - but only a
        // FLOATING view then actually closes. A view that sits edge-to-edge with others (the
        // preset layouts) is structural: closing it would leave a hole, so its X reads as
        // "exit fullscreen" and the tiles come back intact. Order matters: undouble() first,
        // so the seam test runs against this view's real restored rect, whatever its aspect
        // conventions - not against the fullscreen rect or a hand-computed one.
        if (ViewMan.fullscreenView === this) {
            this.undouble();
            if (LayoutMan.viewSharesEdge(this.id)) {
                return;
            }
        }
        this.show(false);
        if (UndoManager) {
            UndoManager.add({
                undo: () => this.show(true),
                redo: () => this.show(false),
                description: "Close " + (name || this.id) + " view",
            });
        }
    }

    // virtual functions for mouseMouveView.js onDocumentMouseMove
    onMouseMove(event, x, y, dx, dy) {
   //      console.log("UNIMPLEMENTED Mouse Move in view "+this.id)
    }

    onMouseDrag(event, x, y, dx, dy) {
   //      console.log("UNIMPLEMENTED Mouse Drag in view "+this.id)
    }

    // debug_v() {
    //     if (!this.done_debug_v) {
    //         this.done_debug_v = true;
    //         // list the elements that are in v but not in this
    //         for (const key in this.v_for_debug) {
    //             // check if it's unchanged, and not an input
    //             if (this[key] !== this.v_for_debug[key] && this.inputs[key] !== undefined) {
    //                 console.warn(this.constructor.name + ": v." + key + " differs in this " + this.id + " values are: " + this.v_for_debug[key] + " and " + this[key])
    //             }
    //         }
    //     }
    // }

    toSerialCNodeView = ["left","top","width","height","visible","doubled","preDoubledLeft","preDoubledTop","preDoubledWidth","preDoubledHeight","headerPinned"];



    modSerialize() {
        const result = {
            ...super.modSerialize(),
            ...this.simpleSerialize(this.toSerialCNodeView)
        };
        if (this.dockedSidebar) {
            result.dockedSidebar = this.dockedSidebar;
        }
        // Only the actual fullscreen view should serialize as doubled.
        // Otherwise all views with doubled:true race during deserialization,
        // and the last one wins — hiding the others.
        if (result.doubled && this.doubleClickFullScreen && ViewMan.fullscreenView !== this) {
            result.doubled = false;
            // Rewind the GEOMETRY as well as the flag. Clearing the flag alone writes a state
            // that cannot exist and cannot be recovered from: a view that is not fullscreen yet
            // fills the whole window. Nothing un-doubles it on load either, because undouble()
            // is gated on `doubled` — the flag just cleared — so the view stays at 1x1 for the
            // life of the sitch, drawn underneath whatever else the layout puts on top of it.
            // Observed as a video view showing only the top-right quarter of the frame.
            if (this.preDoubledWidth > 0) {
                result.left = this.preDoubledLeft;
                result.top = this.preDoubledTop;
                result.width = this.preDoubledWidth;
                result.height = this.preDoubledHeight;
            }
        }
        return result;
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        const restoredDockedSidebar = v.dockedSidebar === "left" || v.dockedSidebar === "right"
            ? v.dockedSidebar
            : null;
        if (this.dockedSidebar) {
            this.undockFromSidebar();
        }
        this.simpleDeserialize(v,this.toSerialCNodeView)
        this.updateWH();
        const visible = v.visible ?? this.visible;
        if (restoredDockedSidebar) {
            this.dockToSidebar(restoredDockedSidebar);
        }
        this.visible = !visible; // ensure we toggle the visibility
        this.setVisible(visible);

        // Header pin state: a NEW sitch carries `headerPinned` (already applied by
        // simpleDeserialize above); an OLD sitch (no field) keeps the per-view DEFAULT —
        // Main/Look/Video off, other panels on. Apply whatever's now in this.headerPinned.
        if (this.uiBar) {
            this.setHeaderPinned(this.headerPinned);
        }

        // Don't restore fullscreen here — that's deferred to
        // restoreFullscreenFromMods() which runs after ALL mods are applied,
        // so it can detect corrupted saves with multiple doubled views.
    }

    dispose() {
        console.log("Disposing CNodeView: "+this.id)
        const sidebar = this.dockedSidebar ? this.getDockSidebar(this.dockedSidebar) : null;

        // If popped out into a separate browser window, dock back FIRST: the view's
        // content (e.g. a canvas) lives in the popup's document while popped, so
        // tearing down the in-page div now would leave the popup orphaned (with its
        // poll interval running) and make child removal in subclass dispose paths
        // (CNodeViewCanvas.dispose's div.removeChild(canvas)) throw mid-teardown.
        // dockWindow() moves the content home, closes the popup, and stops the
        // popup poll/render loop; it is a safe no-op when not popped.
        if (this._poppedWindow) this.dockWindow();

        // Clear any pending resize timeout to prevent post-disposal callbacks
        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = null;
        }

        // Dispose the per-view header/UI bar (destroys its hosted lil-gui menus) so they
        // don't leak on sitch reload. Owns its own DOM removal; null it so nothing reuses it.
        if (this.uiBar) {
            this.uiBar.dispose();
            this.uiBar = null;
            this._clipHUDsBelowHeader();   // hand the HUD companions their full box back
        }

        // if it's an overlay view, then we don't want to remove the div
        if (this.overlayView === undefined && this.div) {
            // Clean up draggable and resizable functionality
            if (this.draggable) {
                removeDraggable(this.div);
            }

            if (this.resizable) {
                removeResizable(this.div);
            }

            this.div.parentElement?.removeChild(this.div);
            this.hideSidebarIfEmpty(sidebar);
        }
        
        super.dispose()

        // views are stored in two managers, the node manager and the view manager
        // so we need to remove from both
        ViewMan.remove(this.id);
    }


    containerWidth() {
        if (this.in.relativeTo)
            return this.in.relativeTo.widthPx
        return ViewMan.widthPx;
    }
    containerHeight() {
        if (this.in.relativeTo)
            return this.in.relativeTo.heightPx
        return ViewMan.heightPx;
    }

    containerTop() {
        if (this.in.relativeTo)
            return this.in.relativeTo.topPx
        return ViewMan.topPx;
    }

    containerLeft() {
        if (this.in.relativeTo)
            return this.in.relativeTo.leftPx
        return ViewMan.leftPx;
    }

    dumpPosition() {
        console.log("left:"+this.left.toPrecision(5)+
            ", top:"+this.top.toPrecision(5)+
            ", width:"+this.width.toPrecision(5)+
            ",height:"+this.height.toPrecision(5)+",")
    }



    inheritSize() {
        if (this.overlayView) {
            this.widthPx = this.div.clientWidth
            this.heightPx = this.div.clientHeight
            this.topPx = this.div.offsetTop
            this.leftPx = this.div.offsetLeft
            this.width = this.overlayView.width
            this.height = this.overlayView.height
            this.top = this.overlayView.top
            this.left = this.overlayView.left
        }
    }

    preRenderCameraUpdate() {
        const newAspect = this.widthPx / this.heightPx;
        
        // Ensure WebGL canvas backing store matches the intended dimensions before rendering.
        // This fixes a race condition when view presets change rapidly:
        // - widthPx/heightPx update immediately when preset changes
        // - But changedSize() uses a 100ms debounce before calling renderer.setSize()
        //   (the debounce prevents flickering during continuous window resize drag)
        // - If presets change faster than 100ms, the canvas has stale dimensions
        // - Result: camera aspect is correct but canvas backing store is wrong size,
        //   causing CSS to scale the mismatched canvas and distort the view
        // Solution: Check dimensions before render and fix any mismatch immediately.
        // Note: Skip this for canvasWidth mode where dimensions intentionally differ.
        if (this.renderer && !this.in.canvasWidth) {
            const pixelRatio = this.renderer.getPixelRatio();
            const canvasW = this.renderer.domElement.width;
            const canvasH = this.renderer.domElement.height;
            const expectedW = Math.floor(this.widthPx * pixelRatio);
            const expectedH = Math.floor(this.heightPx * pixelRatio);
            if (canvasW !== expectedW || canvasH !== expectedH) {
                this.renderer.setSize(this.widthPx, this.heightPx);
                this._lastRendererWidth = this.widthPx;
                this._lastRendererHeight = this.heightPx;
            }
        }
        
        this.camera.aspect = newAspect;
        this.camera.updateProjectionMatrix();

        // do any custom projection modifications

        // Sync the zoom on this camera to the video zoom
        // check if it's flagged, and we actually have a videoZoom UI control
        if (NodeMan.exists("videoZoom")) {
            if (this.effectsEnabled && this.syncPixelZoomWithVideo && NodeMan.get("pixelZoomNode").enabled) {
                var videoZoom = NodeMan.get("videoZoom")
                var pixelZoom = NodeMan.get("pixelZoom");
                const totalZoom = videoZoom.v0 / 100;

                // Compute render dimensions to find pixel-match threshold.
                // Below threshold: FOV zoom (camera.zoom) gives full 3D resolution.
                // Above threshold: pixel shader magnifies the rest so pixels match video.
                let renderW, renderH;
                if (this.in.canvasWidth !== undefined) {
                    const long = this.in.canvasWidth.v0;
                    if (this.widthPx > this.heightPx) {
                        renderW = long;
                        renderH = Math.floor(long * this.heightPx / this.widthPx);
                    } else {
                        renderH = long;
                        renderW = Math.floor(long * this.widthPx / this.heightPx);
                    }
                } else {
                    renderW = this.widthPx;
                    renderH = this.heightPx;
                }

                const videoView = NodeMan.get("video", false);
                let pixelMatchZoom = Infinity;
                if (videoView && videoView.videoWidth > 0 && renderW > 0 && renderH > 0) {
                    pixelMatchZoom = Math.max(
                        videoView.videoWidth / renderW,
                        videoView.videoHeight / renderH
                    );
                }

                // FOV zoom up to pixel-match, pixel shader for the rest
                this.camera.zoom = Math.min(totalZoom, pixelMatchZoom);
                pixelZoom.value = Math.max(100, totalZoom / this.camera.zoom * 100);
            }
            else if (this.syncVideoZoom) {
                var videoZoom = NodeMan.get("videoZoom")
                this.camera.zoom = videoZoom.v0 / 100;
            }
        }
    }

    renderCanvas(frame) {
        assert(frame !== undefined, "Undefined frame in "+this.id)

        // if an overlay view, then inherit the parent's size
        this.inheritSize()

    }

    // given a div, modify the CView's pixel pos/size and the fractional pos/size
    // so they match the div (accounting for this.containerWidth()/windowSize)
    setFromDiv(div) {

        if (div.clientWidth === 0 || div.clientHeight === 0) {
            // div is not visible, so don't update — keep last known valid dimensions
            return;
        }

        assert(div.clientWidth !== 0, "Div has no width in "+this.id+" possibly hidden or ot in DOM")

        if (this.widthPx !== div.clientWidth ||
            this.heightPx !== div.clientHeight ||
            this.leftPx !== div.offsetLeft ||
            this.topPx !== div.offsetTop
        ) {
            this.widthPx = div.clientWidth
            this.heightPx = div.clientHeight

            this.leftPx = div.offsetLeft;
            this.topPx = div.offsetTop;

            if (this.freeAspect) {
                if (this.width < 0 ) this.width = this.widthPx / this.heightPx;
                if (this.height < 0) this.height = this.heightPx / this.widthPx;
            }


            if (this.width>0) this.width = this.widthPx / this.containerWidth()
            if (this.height>0) this.height = this.heightPx / this.containerHeight()


            this.left = (this.leftPx-this.containerLeft()) / this.containerWidth()
            this.top = (this.topPx-this.containerTop()) / this.containerHeight()
        }

        this.widthDiv = div.clientWidth
        this.heightDiv = div.clientHeight

    }

    // Updates the Pixel and Div values from the fractional and window values
    // If this view is a leaf in the active split-tree layout, place it at the tile rect and
    // mirror that rect back into the legacy left/top/width/height fractions (so serialization
    // and any non-tree code path stay consistent, and a later detach has a sane floating rect).
    // Returns true if it handled placement (caller skips the legacy fractional path).
    applyLayoutRect() {
        if (this.in.relativeTo || this.overlayView) return false;
        // The fullscreen view must take the whole screen, not its tile rect — let the legacy
        // (doubled) path place it. The other tiles are hidden by computeEffectiveVisibility
        // while fullscreen, so their tile geometry doesn't matter.
        if (ViewMan.fullscreenView === this) return false;
        const rect = LayoutMan.rectFor(this.id);
        if (!rect) return false;

        const oldWidth = this.widthPx, oldHeight = this.heightPx;
        this.leftPx = rect.leftPx;
        this.topPx = rect.topPx;
        this.widthPx = rect.widthPx;
        this.heightPx = rect.heightPx;

        const W = this.containerWidth(), H = this.containerHeight();
        if (W > 0 && H > 0) {
            this.left = (this.leftPx - this.containerLeft()) / W;
            this.top = (this.topPx - this.containerTop()) / H;
            this.width = this.widthPx / W;
            this.height = this.heightPx / H;
        }

        if (this.div) {
            this.div.style.top = this.topPx + 'px';
            this.div.style.left = this.leftPx + 'px';
            this.div.style.width = this.widthPx + 'px';
            this.div.style.height = this.heightPx + 'px';
        }

        if (oldWidth !== this.widthPx || oldHeight !== this.heightPx) {
            this.changedSize();
        }
        return true;
    }

    updateWH() {
        if (this.updateDockedWH?.()) return;

        // Split-tree tiling (optional, see CLayoutManager). When this view is a leaf in the
        // active layout tree it takes its rect from the tree instead of the legacy fractional
        // path. Floating/detached views, overlays, and relativeTo children are never leaves.
        if (this.applyLayoutRect()) return;

        this.leftPx = Math.floor(this.containerLeft() + this.containerWidth()  * this.left);
        this.topPx  = Math.floor(this.containerTop()  + this.containerHeight() * this.top);

        let oldWidth = this.widthPx;
        let oldHeight = this.heightPx;

        var widthFraction = this.width
        var heightFraction = this.height

        if (heightFraction < 0)
        {
            // height is a multiple of width pixels
            // keeping constant aspect ratio
            this.widthPx = Math.floor(this.containerWidth() * widthFraction);
            this.heightPx = Math.floor(this.containerWidth() * widthFraction * -heightFraction);
        } else if (widthFraction < 0) {
            this.heightPx = Math.floor(this.containerHeight() * heightFraction);
            this.widthPx = Math.floor(this.containerHeight() * heightFraction * -widthFraction);
        }
        else {
            this.widthPx = Math.floor(this.containerWidth() * widthFraction);
            this.heightPx = Math.floor(this.containerHeight() * heightFraction);
        }

        // Auto-suspend/resume center sidebar when mainView layout changes
        if (this.id === "mainView" && !this.in.relativeTo && !this.overlayView) {
            const csState = getCenterSidebarAdjustment();
            const layoutSupportsSplit = this.width > 0 && this.width < 0.99
                && this.height >= 0.99 && this.left < 0.01;
            if (csState.visible && !layoutSupportsSplit) {
                suspendCenterSidebar();
            } else if (isCenterSidebarSuspended() && layoutSupportsSplit) {
                resumeCenterSidebar();
            }
        }

        // Apply center sidebar adjustment for top-level (non-relative, non-overlay) views
        const csAdj = getCenterSidebarAdjustment();
        if (csAdj.visible && !this.in.relativeTo && !this.overlayView) {
            const D = csAdj.dividerFraction;
            const W = this.containerWidth();
            const halfS = csAdj.sidebarWidthPx / 2;
            const CL = this.containerLeft();

            if (D > 0.01 && D < 0.99) {
                const viewLeft = this.left;
                // Compute actual fractional width from pixels (handles negative width encoding)
                const actualFracWidth = this.widthPx / W;
                const viewRight = viewLeft + actualFracWidth;

                if (viewRight <= D + 0.001) {
                    // View is entirely in the left half of the divider
                    const leftHalfPx = D * W - halfS;
                    this.leftPx = Math.floor(CL + (viewLeft / D) * leftHalfPx);
                    if (widthFraction > 0) {
                        this.widthPx = Math.floor((widthFraction / D) * leftHalfPx);
                        if (heightFraction < 0) {
                            this.heightPx = Math.floor(this.widthPx * -heightFraction);
                        }
                    }
                } else if (viewLeft >= D - 0.001) {
                    // View is entirely in the right half of the divider
                    const rightHalfPx = (1 - D) * W - halfS;
                    const rightStartPx = CL + D * W + halfS;
                    this.leftPx = Math.floor(rightStartPx + ((viewLeft - D) / (1 - D)) * rightHalfPx);
                    if (widthFraction > 0) {
                        this.widthPx = Math.floor((widthFraction / (1 - D)) * rightHalfPx);
                        if (heightFraction < 0) {
                            this.heightPx = Math.floor(this.widthPx * -heightFraction);
                        }
                    }
                }
                // Views straddling the divider: left unchanged
            }
        }

        if (this.div && !this.overlayView) {
            // and finally set the div
            this.div.style.top = this.topPx + 'px';
            this.div.style.left = this.leftPx + 'px';
            this.div.style.width = this.widthPx + 'px'
            this.div.style.height = this.heightPx + 'px'
        }

        // Only notify of a size change when dimensions actually changed.
        // updateWH() is called every frame from indexRender.js for every visible view,
        // so without this gate every 2D-canvas view would set _pendingCanvasResize=true
        // every frame, forcing graph editors etc. to fully repaint at 60Hz.
        // (WebGL views debounce inside changedSize, but the 2D-canvas branch does not.)
        if (oldHeight !== this.heightPx || oldWidth !== this.widthPx) {
            this.changedSize();
        }


    }

    changedSize() {
        // A size change must (re)arm a render. Under render-on-demand a PAUSED resize that
        // doesn't move the camera — fullscreen toggle, tiling layout change, window resize —
        // otherwise wouldn't repaint, and (critically) the terrain LOD wouldn't re-evaluate:
        // terrain's update() reads view.heightPx BEFORE updateWH refreshes it this frame, sees
        // no change, and self-sleeps. Arming one more frame lets update() run again next frame
        // with the NEW heightPx, where the viewport now feeds the subdivision fingerprint (see
        // CNodeTerrainUI). Gated by an actual dimension change above, so no continuous render.
        setRenderOne(true);
        if (this.renderer) {
            // For WebGL renderers: debounce renderer.setSize() to avoid flickering
            // Problem: During window resize drag gestures, widthPx/heightPx change 1-2 pixels every frame
            // Without debounce: renderer.setSize() called dozens of times/sec, clearing canvas each time -> flicker
            // Solution: Defer the actual resize 100ms, accumulating changes until gesture settles
            if (this._resizeTimeout) {
                clearTimeout(this._resizeTimeout);
            }
            this._resizeTimeout = setTimeout(() => {
                this.deferredResizeWebGL();
                this._resizeTimeout = null;
            }, 100);
        } else if (this.canvas) {
            // For 2D canvas: just mark pending, will be applied in renderCanvas() before drawing
            // This ensures dimensions are correct before rendering without extra debounce delay
            this._pendingCanvasResize = true;
        }
    }

    deferredResizeWebGL() {
        if (!this.renderer) return;
        
        // Called via 100ms debounce after resize gesture settles
        // Calculates final renderer dimensions and applies resize with deduping to avoid redundant calls
        
        if (this.in.canvasWidth) {
            // Custom canvas resolution mode: scale proportionally to maintain aspect ratio
            let long = Math.floor(this.in.canvasWidth.v0);

            if (this.widthPx > this.heightPx) {
                var width = long;
                var height = Math.floor(long * this.heightPx / this.widthPx);
            } else {
                var height = long;
                var width = Math.floor(long * this.widthPx / this.heightPx);
            }

            // Side-by-side resolution reduction must mirror the per-frame
            // size-sync block in CNodeView3D.renderCanvas — otherwise the two
            // paths set the renderer to different sizes for the same canvas.
            // The per-frame block writes canvas.width = rtWidth (with the 0.7
            // factor), while three.js's internal _width stays at the value
            // last setSize'd here (without 0.7). Result: GL viewport (= _width
            // × pixelRatio) extends past the canvas drawingBuffer and
            // canvasWidth-mode views (e.g. lookView) render off-center.
            if (ViewMan.isSideBySideMode()) {
                const sideBySideResolutionScale = 0.7;
                width = Math.floor(width * sideBySideResolutionScale);
                height = Math.floor(height * sideBySideResolutionScale);
            }

            // Only call setSize() if dimensions actually changed (avoids redundant WebGL calls)
            if (width !== this._lastRendererWidth || height !== this._lastRendererHeight) {
                this.renderer.setSize(width, height, false);
                this._lastRendererWidth = width;
                this._lastRendererHeight = height;
                // Keep the per-frame size-sync's dedup state aligned so the
                // next render doesn't skip its own setSize believing the
                // renderer is already at the per-frame computed width.
                this._lastSyncedRendererWidth = width;
                this._lastSyncedRendererHeight = height;
            }
        } else {
            // Normal mode: resize to match container dimensions
            const width = this.widthPx;
            const height = this.heightPx;
            
            if (width !== this._lastRendererWidth || height !== this._lastRendererHeight) {
                this.renderer.setSize(width, height);
                this._lastRendererWidth = width;
                this._lastRendererHeight = height;
            }
        }
    }

    getRenderTargetHeight() {
        if (!this.in.canvasWidth) {
            return this.heightPx;
        }
        
        const long = this.in.canvasWidth.v0;
        let width = this.widthPx;
        let height = this.heightPx;
        
        let rtHeight;
        if (width > height) {
            rtHeight = Math.floor(long * height / width);
        } else {
            rtHeight = long;
        }
        
        if (ViewMan.isSideBySideMode()) {
            const sideBySideResolutionScale = 0.7;
            rtHeight = Math.floor(rtHeight * sideBySideResolutionScale);
        }
        
        return rtHeight;
    }

    adjustPointScale(scale)  {

        const view = this;
        const camera = view.camera;

        // infoDiv.innerHTML += "view.id = "+view.id+"<br>";
        // infoDiv.innerHTML += " - view.widthPx = "+view.widthPx+",  view.heightPx = "+view.heightPx+"<br>";
        // infoDiv.innerHTML += " - view.div.clientWidth = "+view.div.clientWidth+", view.div.clientHeight = "+view.div.clientHeight+"<br>";
        // infoDiv.innerHTML += " - view.canvas.width = "+view.canvas.width+", view.canvas.height = "+view.canvas.height+"<br>";
        // infoDiv.innerHTML += " - this.nominalViewWidth = "+this.nominalViewWidth+"<br>";
        // infoDiv.innerHTML += " - input Scale = "+scale+"<br>";
        // infoDiv.innerHTML += " - view.in.canvasWidth = "+view.in.canvasWidth+"<br>";
        // infoDiv.innerHTML += " - window.devicePixelRatio = "+window.devicePixelRatio+"<br>";
        // infoDiv.innerHTML += " - view.canvas.width/view.widthPx = "+(view.canvas.width/view.widthPx)+"<br>";

        // camera.fov is in degrees, and is the vertical FOV of the camera in this viewpoirt
        // view.widthPx is the width of the viewport in screen-space pixels The size of the containing div
        // view.heightPx is the height of the viewport in screen-space pixels
        // if (!this.in.canvasWidth) i.e. no custom canvas width set
        //    view.canvas.width is the width of the canvas in device pixels
        //    view.canvas.height is the height of the canvas in device pixels
        // else
        //    view.canvas.width is the width of an off-screen canvas in device pixels
        //    view.canvas.height is the height of an off-screen canvas in device pixels
        //    this off-screen canvas is used to render the view, and then the result is drawn to the screen
        // end if
        // widonew.devicePixelRatio is the ratio of device pixels to screen pixels (usually 2 for retina displays)
        //
        //

        // we are rending sprites as point sprites, so we need to scale them
        // by the size of the viewport in screen pixels, and the FOV of the camera
        // accounting for the device pixel ratio
        // and the

        // firsgure out how many canvas pixels high the viewport is
        // we know that's one FOV height
        // for angular size is proportional to that
        let veticalCanvasPx;

        if (view.in.canvasWidth) {
            veticalCanvasPx = view.getRenderTargetHeight();
        } else {
            veticalCanvasPx = view.heightPx;
        }

        scale *= (veticalCanvasPx / view.nominalViewHeight)
        scale *= 45/view.camera.fov; // 45 is the default FOV, so we scale by that

        // calculations here:
        // infoDiv.innerHTML += " - Adjusted Scale = "+scale+"<br>";

        return scale / 2;
    }



    snapInsidePx(l,t,w,h) {
        //  debugger
        if (this.leftPx < l)
            this.leftPx = l;
        if (this.topPx < t)
            this.leftPx = t;
        if (this.topPx+this.heightPx > t+h)
            this.topPx = t+h-this.heightPx
        if (this.leftPx+this.heightPx > l+w)
            this.leftPx = l+w-this.widthPx
        this.left = this.leftPx/this.containerWidth()
        this.top = this.topPx/this.containerHeight()
        this.updateWH()
    }

    doubleClick() {
        if (this.visible && (this.doubleClickResizes || this.doubleClickFullScreen)) {
            if (!this.doubled) {
                this.doubled = true;
                this.preDoubledLeft = this.left;
                this.preDoubledTop = this.top;
                this.preDoubledWidth = this.width;
                this.preDoubledHeight = this.height;

                // Mark fullscreen BEFORE updateWH so applyLayoutRect lets this view take the
                // full screen instead of pinning it to (and mirroring back) its tile rect.
                if (this.doubleClickFullScreen) {
                    ViewMan.setFullscreenView(this);
                }

                if (this.doubleClickResizes) {
                    if (this.width > 0) {
                        this.width *= 2;
                    }
                    if (this.height > 0) {
                        this.height *= 2;
                    }
                } else {
                    // Preserve negative-width/height convention for aspect-ratio views.
                    // A negative width means "compute from height * abs(width)" (square when -1).
                    if (this.width < 0) {
                        this.height = 1;
                        this.left = 0;
                        this.top = 0;
                    } else if (this.height < 0) {
                        this.width = 1;
                        this.left = 0;
                        this.top = 0;
                    } else {
                        this.width = 1;
                        this.height = 1;
                        this.left = 0;
                        this.top = 0;
                    }
                }

                if (this.width > 1) this.width = 1;
                if (this.height > 1) this.height = 1;

                this.updateWH();
                this.snapInsidePx(0, 0, this.containerWidth(), this.containerHeight());

            } else {
                this.undouble();
                return;
            }

            // Hide/show the split-tree seam overlay to match fullscreen (the seams must not
            // draw over a fullscreen view, and must come back on exit).
            LayoutMan.updateDividerVisibility();

            // Fullscreen toggles visibility, geometry AND z-order — all applied in renderMain
            // (computeEffectiveVisibility / updateDOMVisibility / updateZOrder). Arm a render;
            // the render-loop fix (renderLoopControl: a pending renderOne always runs, even
            // unfocused) guarantees it actually paints.
            setRenderOne(true);
        }
    }

    // The exit half of doubleClick(): restore the saved pre-doubled/pre-fullscreen geometry and
    // release ViewMan.fullscreenView. Split out WITHOUT doubleClick's visibility guard because
    // the hide path must run it while the view is on its way to hidden - and the Show/Views
    // checkbox even forces this.visible = undefined before calling setVisible, which that guard
    // would read as "not visible, do nothing".
    undouble() {
        if (!this.doubled) return;
        this.doubled = false;
        this.left = this.preDoubledLeft;
        this.top = this.preDoubledTop;
        if (this.width > 0) this.width = this.preDoubledWidth;
        if (this.height > 0) this.height = this.preDoubledHeight;
        this.updateWH();

        if (this.doubleClickFullScreen) {
            ViewMan.setFullscreenView(null);
        }

        // Same tail as doubleClick, and for the same reasons (seams back, repaint guaranteed).
        LayoutMan.updateDividerVisibility();
        setRenderOne(true);
    }

    setVisible(visible) {
        // A view shown WHILE another is fullscreen is a deliberate reveal on top of it - lift
        // its fullscreen suppression, or it stays invisible despite the action that showed it
        // (the Show/Views checkbox, setViewPosition({visible:true}), Notes opening, the
        // second-video reveal...). Same-value shows count too - a suppressed view still has
        // visible === true - so this runs BEFORE the same-value early-out below. Calling
        // setVisible IS the intent signal: the offline-render machinery that merely forces
        // and restores flags (LongExposure's lookView, Scripted Video's per-shot views) uses
        // setVisibleRaw instead, so it never trips this - and a genuine reveal arriving in
        // the middle of one of those renders still lands. The repaint is armed because
        // effective visibility is applied in the render pass; nothing else would repaint a
        // pure suppression change.
        if (visible && ViewMan.fullscreenView && ViewMan.unsuppressView(this)) {
            setRenderOne(true);
        }

        if (this.visible === visible)
            return;

        // Hiding the FULLSCREEN view - by ANY path: header X, Show/Views checkbox, title-menu
        // close, an API hide(), or the redo of a close - must exit fullscreen first. Fullscreen
        // suppresses every other view, so hiding the one view it shows leaves a blank screen
        // owned by a view that is no longer there; undouble() restores the pre-fullscreen
        // layout, so the hide leaves the ordinary layout with this view closed.
        if (!visible && ViewMan.fullscreenView === this) {
            this.undouble();
        }

        this.setVisibleRaw(visible);
    }

    // Set the visible flag with NO intent semantics: no fullscreen un-suppression, no
    // fullscreen exit. For render machinery (LongExposure, Scripted Video) mechanically
    // forcing or restoring a view's flag around an offline pass - every user-facing and API
    // path goes through setVisible, where a show during fullscreen is a deliberate reveal.
    setVisibleRaw(visible) {
        if (this.visible === visible)
            return;

        this.visible = visible;

        // Hiding a view (display:none) suppresses the pointerleave that would normally
        // clear the hover state, so the header would pop up unprompted on re-show. Clear it.
        if (!visible && this._headerHovering) {
            this._headerHovering = false;
            this._updateHeaderShown();
        }

        // Immediate DOM update for responsiveness.
        // Central DOM updates happen in ViewMan.updateDOMVisibility() each frame.
        this._updateOwnDOM();
    }

    // Update this view's own DOM elements based on this.visible (user intent)
    _updateOwnDOM() {
        if (!this.overlayView) {
            if (this.div) {
                this.div.style.display = (this.visible && !this.windowed) ? 'block' : 'none';
            }
        } else if (this.separateVisibility) {
            if (this.canvas) {
                this.canvas.style.visibility = this.visible ? 'visible' : 'hidden';
            }
        }
        if (!this.dockedSidebar) return;

        if (this.visible) {
            if (this.dockedSidebar === "left") {
                showLeftSidebar();
            } else {
                showRightSidebar();
            }
            this.updateDockedWH();
        } else {
            this.hideSidebarIfEmpty(this.getDockSidebar(this.dockedSidebar));
        }
        // Non-separateVisibility overlays: DOM controlled by parent's div
    }

    updateDockedWH() {
        if (!this.dockedSidebar || !this.div) return false;

        const sidebar = this.getDockSidebar(this.dockedSidebar);
        if (!sidebar) return false;

        const oldWidth = this.widthPx;
        const oldHeight = this.heightPx;
        const aspect = this.dockedAspectRatio || this.currentAspectRatio();
        const availableWidth = Math.max(1, sidebar.clientWidth - DOCK_MARGIN_PX * 2);
        const availableHeight = Math.max(1, sidebar.clientHeight - DOCK_MARGIN_PX * 2);

        let width = availableWidth;
        let height = width / aspect;
        if (height > availableHeight) {
            height = availableHeight;
            width = height * aspect;
        }

        this.widthPx = Math.max(1, Math.floor(width));
        this.heightPx = Math.max(1, Math.floor(height));
        this.leftPx = DOCK_MARGIN_PX;
        this.topPx = DOCK_MARGIN_PX;

        Object.assign(this.div.style, {
            position: "relative",
            left: "0px",
            top: "0px",
            width: `${this.widthPx}px`,
            height: `${this.heightPx}px`,
            margin: `${DOCK_MARGIN_PX}px`,
            display: this.visible ? "block" : "none",
        });
        this.applyDockedTextScale();

        if (oldWidth !== this.widthPx || oldHeight !== this.heightPx) {
            this.changedSize();
        }
        return true;
    }

    onViewDragEnd(event) {
        if (!this.visible) return;

        // How far this drag actually moved (0 for a click). Reset for next time.
        const moved = this._dragDisplacement || 0;
        this._dragDisplacement = 0;

        if (this.dockedSidebar) {
            if (!this.isEventInDockSidebar(event, this.dockedSidebar)) {
                this.undockFromSidebar(event);
            } else {
                this.updateDockedWH();
            }
            return;
        }

        LayoutMan.hideDropPreview();

        this.setFromDiv(this.div);
        // Keep the header bar on screen (below the menu bar, partly visible L/R).
        this._ensureUIBarVisible();

        // Re-dock into the split-tree grid: if tiling is active and this floating view was
        // dropped over a tile's EDGE band (the blue preview was showing), split that tile to
        // insert it — the inverse of detach. dockViewAt no-ops for a central (no-snap) drop, so
        // the view stays free-floating there. Takes precedence over sidebar docking.
        if (moved >= HEADER_DRAG_MOVE_THRESHOLD && LayoutMan.active && !LayoutMan.hasLeaf(this.id)
            && event && event.clientX !== undefined) {
            if (LayoutMan.dockViewAt(this.id, event.clientX, event.clientY)) {
                this.setResizeHandlesVisible(false);   // tiled views resize via the seams
                return;
            }
        }

        if (!this.dockable) return;

        // Docking requires a DELIBERATE drag, not a click that happens to land near an edge.
        if (moved < HEADER_DRAG_DOCK_THRESHOLD) return;

        const side = this.dockSideForEvent(event);
        if (side) {
            this.dockToSidebar(side);
        }
    }

    dockToSidebar(side) {
        if (!this.dockable || (side !== "left" && side !== "right")) return;

        if (!this.dockedSidebar) {
            this.saveFloatingRect();
        }

        this.dockedSidebar = side;
        this.dockedAspectRatio = this.currentAspectRatio();
        if (side === "left") {
            showLeftSidebar();
        } else {
            showRightSidebar();
        }

        const sidebar = this.getDockSidebar(side);
        sidebar.appendChild(this.div);
        this.setResizeHandlesVisible(false);
        this.updateDockedWH();
    }

    undockFromSidebar(event) {
        if (!this.dockedSidebar) return;

        const sidebar = this.getDockSidebar(this.dockedSidebar);
        const saved = this.floatingRectBeforeDock || {
            widthPx: this.widthPx,
            heightPx: this.heightPx,
            leftPx: this.leftPx,
            topPx: this.topPx,
        };

        this.dockedSidebar = null;
        this.dockedAspectRatio = null;
        this.floatingParent.appendChild(this.div);
        this.hideSidebarIfEmpty(sidebar);
        this.setResizeHandlesVisible(true);
        this.restoreDockedTextScale();

        const widthPx = Math.max(1, Math.floor(saved.widthPx));
        const heightPx = Math.max(1, Math.floor(saved.heightPx));
        const parentRect = this.floatingParent.getBoundingClientRect();
        const pointerLeft = event?.clientX !== undefined
            ? event.clientX - parentRect.left - widthPx / 2
            : saved.leftPx;
        const pointerTop = event?.clientY !== undefined
            ? event.clientY - parentRect.top - 16
            : saved.topPx;

        this.widthPx = widthPx;
        this.heightPx = heightPx;
        this.leftPx = this.clamp(pointerLeft, 0, Math.max(0, this.containerWidth() - widthPx));
        this.topPx = this.clamp(pointerTop, 0, Math.max(0, this.containerHeight() - heightPx));

        this.width = this.widthPx / this.containerWidth();
        this.height = this.heightPx / this.containerHeight();
        this.left = (this.leftPx - this.containerLeft()) / this.containerWidth();
        this.top = (this.topPx - this.containerTop()) / this.containerHeight();

        Object.assign(this.div.style, {
            position: "absolute",
            margin: "0px",
            left: `${this.leftPx}px`,
            top: `${this.topPx}px`,
            width: `${this.widthPx}px`,
            height: `${this.heightPx}px`,
            display: this.visible ? "block" : "none",
        });

        // Never restore to a state where the header bar is off the top (or off-screen) —
        // the saved floating rect (or pointer drop) could place it under the menu bar.
        this._ensureUIBarVisible();

        this.changedSize();
        this.deferFloatingPixelSizeRestore(widthPx, heightPx);
    }

    saveFloatingRect() {
        this.floatingRectBeforeDock = {
            leftPx: this.leftPx,
            topPx: this.topPx,
            widthPx: this.div?.clientWidth || this.widthPx,
            heightPx: this.div?.clientHeight || this.heightPx,
        };
    }

    currentAspectRatio() {
        const width = this.div?.clientWidth || this.widthPx || 1;
        const height = this.div?.clientHeight || this.heightPx || 1;
        return Math.max(0.01, width / height);
    }

    dockSideForEvent(event) {
        if (event.clientX <= DOCK_EDGE_PX || this.isEventInDockSidebar(event, "left")) {
            return "left";
        }
        if (event.clientX >= window.innerWidth - DOCK_EDGE_PX || this.isEventInDockSidebar(event, "right")) {
            return "right";
        }
        return null;
    }

    isEventInDockSidebar(event, side) {
        const sidebar = this.getDockSidebar(side);
        if (!sidebar || sidebar.style.display === "none") return false;
        const rect = sidebar.getBoundingClientRect();
        return event.clientX >= rect.left
            && event.clientX <= rect.right
            && event.clientY >= rect.top
            && event.clientY <= rect.bottom;
    }

    getDockSidebar(side) {
        return side === "left" ? getLeftSidebar() : getRightSidebar();
    }

    hideSidebarIfEmpty(sidebar) {
        if (!sidebar) return;
        const hasVisibleChild = Array.from(sidebar.children).some(child => {
            return child !== this.div && child.style.display !== "none";
        });
        if (hasVisibleChild) return;

        if (sidebar.id === "LeftSidebar") {
            hideLeftSidebar();
        } else if (sidebar.id === "RightSidebar") {
            hideRightSidebar();
        }
    }

    setResizeHandlesVisible(visible) {
        if (!this.div?._resizeHandles) return;
        Object.values(this.div._resizeHandles).forEach(handle => {
            handle.style.display = visible ? "block" : "none";
        });
    }

    applyDockedTextScale() {
        if (!this.dockedTextScale || this.dockedTextOriginalFontSizes || !this.div) return;

        this.dockedTextOriginalFontSizes = new Map();
        this.div.querySelectorAll("*").forEach(element => {
            const fontSize = parseFloat(getComputedStyle(element).fontSize);
            if (!Number.isFinite(fontSize)) return;
            this.dockedTextOriginalFontSizes.set(element, element.style.fontSize);
            element.style.fontSize = `${fontSize * this.dockedTextScale}px`;
        });
    }

    restoreDockedTextScale() {
        if (!this.dockedTextOriginalFontSizes) return;

        this.dockedTextOriginalFontSizes.forEach((fontSize, element) => {
            element.style.fontSize = fontSize;
        });
        this.dockedTextOriginalFontSizes = null;
    }

    deferFloatingPixelSizeRestore(widthPx, heightPx) {
        requestAnimationFrame(() => {
            if (this.dockedSidebar || !this.div) return;
            this.widthPx = widthPx;
            this.heightPx = heightPx;
            this.leftPx = this.clamp(this.leftPx, 0, Math.max(0, this.containerWidth() - widthPx));
            this.topPx = this.clamp(this.topPx, 0, Math.max(0, this.containerHeight() - heightPx));
            this.width = this.widthPx / this.containerWidth();
            this.height = this.heightPx / this.containerHeight();
            this.left = (this.leftPx - this.containerLeft()) / this.containerWidth();
            this.top = (this.topPx - this.containerTop()) / this.containerHeight();
            Object.assign(this.div.style, {
                left: `${this.leftPx}px`,
                top: `${this.topPx}px`,
                width: `${this.widthPx}px`,
                height: `${this.heightPx}px`,
            });
            this.changedSize();
        });
    }

    clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    show(visible = true) {
        this.setVisible(visible)
    }

    hide() {
        this.show(false)
    }

    // --- Pop out into a real separate browser window (poppable DOM views) ---
    // Moves the view's CONTENT (everything under the CUIBar header) into a window.open popup and
    // marks the in-page view `windowed`, so it drops out of the layout/seams (treated as closed)
    // and its div hides. Docking — or closing the popup — moves the content back. Only meaningful
    // for DOM-content views; WebGL views (their canvas context is bound to this document) are not
    // made poppable.
    togglePopout() {
        if (this._poppedWindow && !this._poppedWindow.closed) this.dockWindow();
        else this.popOut();
    }

    popOut() {
        if (this._poppedWindow && !this._poppedWindow.closed) { this._poppedWindow.focus(); return; }
        const w = Math.max(240, Math.round(this.widthPx || 480));
        const h = Math.max(180, Math.round(this.heightPx || 360));
        const win = window.open("", "sitrec_view_" + this.id, `popup,width=${w},height=${h}`);
        if (!win) { alert("Popup blocked — please allow popups for this site, then try again."); return; }
        this._poppedWindow = win;
        try { win.document.title = "Sitrec — " + friendlyViewName(this.in, this.id); } catch (e) { /* cross-doc */ }
        // --sitrec-header-h:0 → content positioned below the (now absent) header fills the window.
        win.document.body.style.cssText = "margin:0; height:100vh; overflow:hidden;"
            + "background:var(--sitrec-bg-app,#1a1a1a); color:var(--sitrec-text,#ebebeb); --sitrec-header-h:0px;";
        const bar = this.uiBar && this.uiBar.bar;
        this._poppedContent = [...this.div.children].filter(c => c !== bar);
        for (const c of this._poppedContent) win.document.body.appendChild(win.document.adoptNode(c));
        // (Closing the popup window docks it back — see the beforeunload handler below — so no
        //  separate in-popup dock button is needed.)
        this.windowed = true;
        this._updateOwnDOM();                 // hide the in-page div
        setRenderOne(true);                   // re-layout the remaining views (seams)
        win.addEventListener("beforeunload", () => this.dockWindow());
        // fallback poll in case beforeunload doesn't fire
        this._popPoll = setInterval(() => { if (!this._poppedWindow || this._poppedWindow.closed) this.dockWindow(); }, 600);
        // Live canvas views (renderWhileWindowed, e.g. the DAG) must keep drawing while popped.
        // The main render loop is render-on-demand and sleeps when this window is backgrounded
        // (which happens as soon as the popup is focused), so the canvas would otherwise freeze as
        // a fixed-size bitmap. Drive the render from the POPUP's OWN requestAnimationFrame — it
        // keeps ticking while the popup is visible, so renderCanvas() runs every frame, adjustSize()
        // sizes the canvas to the popup, and the view's own pointer handlers (pan/zoom/isolate) stay
        // live — i.e. fully interactive, just like an in-page view.
        if (this.renderWhileWindowed) {
            this._popRendering = true;
            const tick = () => {
                if (!this._popRendering || !this._poppedWindow || this._poppedWindow.closed) return;
                try { this.renderCanvas(par.frame); } catch (e) { /* keep the popup loop alive */ }
                this._poppedWindow.requestAnimationFrame(tick);
            };
            this._poppedWindow.requestAnimationFrame(tick);
        }
        // the popup has no JS of its own — if the main window goes away, take it along
        if (!this._popUnloadWired) {
            this._popUnloadWired = true;
            window.addEventListener("pagehide", () => { if (this._poppedWindow && !this._poppedWindow.closed) this._poppedWindow.close(); });
        }
        if (this._popIcon) this._popIcon.title = "Dock the window back";
    }

    dockWindow() {
        this._popRendering = false;   // stop the popup-driven render loop (renderWhileWindowed views)
        if (this._popPoll) { clearInterval(this._popPoll); this._popPoll = null; }
        if (this._poppedContent) {
            for (const c of this._poppedContent) {
                if (c.ownerDocument !== document) this.div.appendChild(document.adoptNode(c));
            }
            this._poppedContent = null;
        }
        if (this._poppedWindow && !this._poppedWindow.closed) { try { this._poppedWindow.close(); } catch (e) { /* gone */ } }
        this._poppedWindow = null;
        this.windowed = false;
        this._updateOwnDOM();
        setRenderOne(true);
        if (this._popIcon) this._popIcon.title = "Pop out into a window";
    }

}

// example CUIText being added to a CUIView
//         this.addText("az", "35° L", 47, 7).listen(par, "az", function (value) {
//             this.text = (floor(0.499999+abs(value))) + "° " + (value > 0 ? "R" : "L");
//         })
// Note the callback to .listen is options

// position and size are specified as percentages
// and stored as fractions (ie. /100)
class CUIText {
    constructor (text,x,y,size,color,align, font) {
        this.text = text;
        this.x = x/100;
        this.y = y/100;
        this.size = size/100;
        this.color = color
        this.font = font;
        this.align = align;
        this.boxed = false;
        this.boxGap = 2;  // gap between text BBox and display BBox
        this.alwaysUpdate = false;
        // Per-element visibility. The whole overlay node can be hidden with
        // setVisible(), but a single overlay often mixes independently
        // toggleable readouts (e.g. labelVideo holds both the date/time display
        // and the PTZ alt/az/pitch lines), so each element gets its own flag.
        // CNodeViewUI.renderCanvas still runs the listener/update callback for a
        // hidden element — that is how a callback can turn itself back on.
        this.visible = true;

    }

    getValue() {
        return this.object[ this.property ];
    }

    setPosition(x,y) {
        this.x = x/100
        this.y = y/100
    }

    listen (object, property, callback) {
        this.object = object;
        this.property = property
        this.callback = callback;
        this.initialValue = this.getValue()
        return this;
    }

    update (callback) {
        this.callback = callback;
        this.alwaysUpdate = true;
        return this;
    }

    checkListener() {
        if (this.object !== undefined) {
            const v = this.getValue()
            if (v != this.initialValue) {
                if (this.callback === undefined) {
                    this.text = String(v)
                } else {
                    this.callback.call(this, v)
                }
                this.initialValue = v;
            }
        }

        if (this.alwaysUpdate) {
            this.callback.call(this)
        }
    }
}

export {CNodeView, CUIText}


export function VG(id){
    return ViewMan.get(id)
}
