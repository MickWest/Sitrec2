import {CManager} from "./CManager";
import {setupPageStructure} from "./PageStructure";
import {isConsole} from "./configUtils";

class CViewManager extends CManager {
    constructor(v) {
        super(v);
        this.fullscreenView = null; // tracks which view is in fullscreen mode (null = none)
        // The views fullscreen SUPPRESSES: exactly the ones visible when fullscreen was
        // entered. Views the user opens DURING fullscreen (chat, a graph...) are not in the
        // set, so they show on top of the fullscreen view; exit restores the covered set
        // (their own .visible flags never changed) and leaves the additions alone.
        this.fullscreenSuppressed = new Set();
        if (!isConsole) { // will not be used in console mode, so just an empty singleton
            setupPageStructure();
            this.topPx = 24;
            this.leftPx = 0;
            this.screenOffsetX = 0;  // Container's screen X offset (updated when sidebars appear)
            this.container = document.getElementById("Content")
            this.updateSize();


            // make a div the size of the window, but missing the topPx
            // so we can have a menu bar at the top
            // this.div = document.createElement('div')
            // this.div.style.position = 'absolute';
            // this.div.style.top = this.topPx + 'px';
            // this.div.style.left = '0px';
            // this.div.style.width = '100%'
            // this.div.style.height = 'calc(100% - ' + this.topPx + 'px)'
            // this.div.style.backgroundColor = '#000000'
            // this.div.style.zIndex = 0;
            //
            // // make transparent to mouse events
            // this.div.style.pointerEvents = 'none';
            //
            // document.body.appendChild(this.div);
            // this.container = this.div;
            // old (working) way
            //this.container = window;

        }
    }

    updateSize() {

        if (!isConsole) {
            // leftPx is the container-relative offset (always 0 for views positioned at left edge)
            // Used for positioning view divs within the container
            this.leftPx = 0;

            // screenOffsetX is the container's absolute screen position (accounts for sidebars)
            // Used for converting mouse screen coordinates to view-relative coordinates
            this.screenOffsetX = this.container.offsetLeft;

            this.widthPx = this.container.offsetWidth;
            this.heightPx = this.container.offsetHeight - this.topPx;
        }
    }

    setVisibleByName(name, visible) {
        this.iterate((id, v) => {
            if (v.showHideName === name || v.id === name) {
                v.setVisible(visible);
            }
        })
    }

    updateViewFromPreset(viewName, preset) {
        const view = this.get(viewName, false);
        if (view) {
            if (preset.visible !== undefined) {
                view.setVisible(preset.visible);
            }
            if (preset.left !== undefined) {
                view.left = preset.left;
                view.top = preset.top;
                view.width = preset.width;
                view.height = preset.height;
                view.updateWH();
            }
        } else {
            console.warn(`ViewManager: No view found with name ${viewName}`);
        }
    }

    // Detect if we're in side-by-side rendering mode
    // Returns true if both mainView and lookView are visible and positioned side-by-side
    isSideBySideMode() {
        const mainView = this.get("mainView", false);
        const lookView = this.get("lookView", false);
        
        if (!mainView || !lookView || !mainView.visible || !lookView.visible) {
            return false;
        }
        
        // Check if views are positioned horizontally (side-by-side)
        // Typically: mainView width < 1 and lookView width < 1
        const mainWidth = Math.abs(mainView.width ?? 1);
        const lookWidth = Math.abs(lookView.width ?? 1);
        
        // Side-by-side if combined width is approximately 1 (accounting for negative widths)
        // and both have reduced width
        return mainWidth < 0.9 && lookWidth < 0.9 && (mainWidth + lookWidth) > 0.9;
    }

    // Check if view is a descendant (overlay child or relativeTo child) of ancestor
    isDescendantOf(view, ancestor) {
        if (view === ancestor) return true;
        if (view.overlayView && this.isDescendantOf(view.overlayView, ancestor)) return true;
        if (view.in.relativeTo && this.isDescendantOf(view.in.relativeTo, ancestor)) return true;
        return false;
    }

    // Compute _effectivelyVisible for all views based on user intent, parent state, and fullscreen
    computeEffectiveVisibility() {
        // Reset memoization
        this.iterate((key, view) => { view._evComputed = false; });
        // Compute for all views
        this.iterate((key, view) => { this._computeEV(view); });
    }

    _computeEV(view) {
        if (view._evComputed) return view._effectivelyVisible;

        // A popped-out (windowed) view is "closed" in-page: its content lives in a separate
        // browser window, so it drops out of the layout and its div hides.
        let effective = view.visible && !view.windowed;

        // Overlay children inherit parent visibility (unless separateVisibility)
        if (view.overlayView && !view.separateVisibility) {
            effective = effective && this._computeEV(view.overlayView);
        }

        // RelativeTo children inherit parent visibility
        if (view.in.relativeTo) {
            effective = effective && this._computeEV(view.in.relativeTo);
        }

        // Fullscreen: hide the views fullscreen covered at entry. Views shown DURING
        // fullscreen are not in the suppressed set - the user opened them over the
        // fullscreen view on purpose, so they render on top of it.
        if (this.fullscreenView && !this.isDescendantOf(view, this.fullscreenView)
            && this.fullscreenSuppressed.has(view)) {
            effective = false;
        }

        view._effectivelyVisible = effective;
        view._evComputed = true;
        return effective;
    }

    // Update DOM display/visibility based on computed _effectivelyVisible
    updateDOMVisibility() {
        this.iterate((key, view) => {
            if (!view.overlayView) {
                // Non-overlay view: control div display
                if (view.div) {
                    view.div.style.display = view._effectivelyVisible ? 'block' : 'none';
                }
            } else if (view.separateVisibility) {
                // Separate visibility overlay: control canvas visibility
                if (view.canvas) {
                    view.canvas.style.visibility = view._effectivelyVisible ? 'visible' : 'hidden';
                }
            }
            // Non-separateVisibility overlays: DOM controlled by parent's div display
        });
    }

    // Enter or exit fullscreen for a view (null = exit). The one place fullscreenView should
    // be assigned: entry snapshots the views being covered - exactly the ones visible right
    // now - into fullscreenSuppressed, so later additions are not suppressed with them.
    setFullscreenView(view) {
        // Switching owners (fullscreening B while A is fullscreen): un-double the incumbent
        // first, or A would keep its 1x1 fullscreen geometry forever - exiting B's fullscreen
        // would reveal A still covering the whole screen. A's undouble() re-enters here with
        // null; by then A.doubled is already false, so the recursion terminates immediately,
        // and the assignment below overrides the null it wrote.
        if (this.fullscreenView && this.fullscreenView !== view && this.fullscreenView.doubled) {
            this.fullscreenView.undouble();
        }
        this.fullscreenView = view;
        this.fullscreenSuppressed = new Set();
        if (view) {
            this.iterate((id, v) => {
                // Only INDEPENDENT views belong in the set. Children (relativeTo, and
                // overlays without separateVisibility) inherit their parent's effective
                // visibility in _computeEV - suppressing them directly would keep a child
                // hidden even after its parent is deliberately re-shown during fullscreen,
                // since un-suppression happens per-view on the parent alone.
                if (v.in.relativeTo || (v.overlayView && !v.separateVisibility)) return;
                if (v.visible && !v.windowed && !this.isDescendantOf(v, view)) {
                    this.fullscreenSuppressed.add(v);
                }
            });
        }
    }

    // Lift fullscreen suppression from a view AND its separateVisibility overlay children.
    // Those overlays are snapshotted independently (they do not inherit effective
    // visibility), so a deliberately re-shown parent must bring them along - otherwise
    // showView("video") displays the video without its enabled tracking/annotation
    // overlays. Returns true when anything was actually removed.
    unsuppressView(view) {
        let hit = this.fullscreenSuppressed.delete(view);
        for (const v of [...this.fullscreenSuppressed]) {
            if (v.separateVisibility && this.isDescendantOf(v, view)) {
                this.fullscreenSuppressed.delete(v);
                hit = true;
            }
        }
        return hit;
    }

    // Called after all view mods have been deserialized.
    // Finds views with doubled:true and restores fullscreen for exactly one.
    // If multiple views claim doubled (corrupted legacy save), un-doubles all.
    restoreFullscreenFromMods() {
        const undouble = (view) => {
            if (view.preDoubledWidth !== undefined) {
                view.left = view.preDoubledLeft;
                view.top = view.preDoubledTop;
                view.width = view.preDoubledWidth;
                view.height = view.preDoubledHeight;
                view.updateWH();
            }
            view.doubled = false;
        };

        const doubledViews = [];
        this.iterate((key, view) => {
            if (view.doubled && view.doubleClickFullScreen) {
                // A HIDDEN view must never own fullscreen: fullscreen suppresses every other
                // view, so a hidden owner is a blank screen. Reachable from legacy saves that
                // captured doubled:true with visible:false (closing a full-screened view used
                // to hide it without un-doubling). Un-double it, so a later re-show comes
                // back windowed at its saved pre-fullscreen rect.
                if (!view.visible) {
                    undouble(view);
                    return;
                }
                doubledViews.push(view);
            }
        });

        if (doubledViews.length === 1) {
            // Clean save: exactly one doubled view → restore fullscreen
            this.setFullscreenView(doubledViews[0]);
        } else if (doubledViews.length > 1) {
            // Corrupted save: multiple doubled views → un-double all
            console.warn(`restoreFullscreenFromMods: ${doubledViews.length} views had doubled:true — clearing all`);
            for (const view of doubledViews) {
                undouble(view);
            }
            this.setFullscreenView(null);
        }
        // doubledViews.length === 0: no fullscreen, nothing to do
    }

    updateZOrder() {
        const nonOverlayViews = [];
        const overlayViews = [];
        
        this.iterate((id, view) => {
            if (view.overlayView) {
                overlayViews.push(view);
            } else if (view.div) {
                nonOverlayViews.push(view);
            }
        });
        
        nonOverlayViews.sort((a, b) => {
            // alwaysOnTop tool windows (the script editor, notes, …) stay above EVERYTHING,
            // including scripted-video preview layouts — which assign scriptZ and would
            // otherwise cover them. Checked first so scriptZ can't sink them.
            if (a.alwaysOnTop !== b.alwaysOnTop) {
                return a.alwaysOnTop ? 1 : -1;
            }
            // scripted-video layouts impose an explicit stacking order (scriptZ) among the
            // non-alwaysOnTop views; it outranks the size heuristic so e.g. the witness video
            // can sit on top of an equal-sized look view during an overlay shot.
            const sz = (a.scriptZ || 0) - (b.scriptZ || 0);
            if (sz !== 0) return sz;
            const areaA = (a.widthPx || 0) * (a.heightPx || 0);
            const areaB = (b.widthPx || 0) * (b.heightPx || 0);
            return areaB - areaA;
        });
        
        let zIndex = 1;
        for (const view of nonOverlayViews) {
            view.div.style.zIndex = zIndex;
            view.zIndex = zIndex;
            zIndex++;
        }
        
        for (const view of overlayViews) {
            const parentZ = view.overlayView?.zIndex || 1;
            view.zIndex = parentZ;
        }
    }

}

export const ViewMan = new CViewManager()