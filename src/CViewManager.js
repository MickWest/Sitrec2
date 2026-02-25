import {CManager} from "./CManager";
import {setupPageStructure} from "./PageStructure";
import {isConsole} from "./configUtils";

class CViewManager extends CManager {
    constructor(v) {
        super(v);
        this.fullscreenView = null; // tracks which view is in fullscreen mode (null = none)
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

        let effective = view.visible;

        // Overlay children inherit parent visibility (unless separateVisibility)
        if (view.overlayView && !view.separateVisibility) {
            effective = effective && this._computeEV(view.overlayView);
        }

        // RelativeTo children inherit parent visibility
        if (view.in.relativeTo) {
            effective = effective && this._computeEV(view.in.relativeTo);
        }

        // Fullscreen: only fullscreen view and its descendants are visible
        if (this.fullscreenView && !this.isDescendantOf(view, this.fullscreenView)) {
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
            if (a.alwaysOnTop !== b.alwaysOnTop) {
                return a.alwaysOnTop ? 1 : -1;
            }
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