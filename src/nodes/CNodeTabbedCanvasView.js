import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {t} from "../i18n";

class CNodeTabbedCanvasView extends CNodeViewCanvas2D {
    constructor(v) {
        super(v);

        this.menuName = v.menuName ?? 'Menu';
        this._dragHandle = v.dragHandle;

        this.createTabMenu();
    }

    createTabMenu() {
        // Phase 3: the per-view menu now lives on the shared CUIBar header (created by
        // CNodeView); moving is the header drag handle, and lil-gui's title click (wired in
        // CUIBar.addMenu) toggles it. Subclasses (FOV / curve editors) add their controls to
        // this.tabMenu via addMenuItems(). This replaced the old bespoke menuContainer/tabMenu
        // DOM + setupTabDragging + updateDraggableWithMenuExclude machinery (now removed).
        if (!this.uiBar) return;   // overlay / passThrough views have no header bar
        this.tabMenu = this.uiBar.addMenu(this.menuName);

        const closeObj = {
            close: () => {
                this.tabMenu.close();
                this.show(false);
            }
        };
        this.tabMenu.add(closeObj, 'close').name(t("misc.hide.label"))
            .tooltip(t("misc.hide.tooltip"));

        this.tabMenu.close();

        // isMenuInteraction() (in subclasses) walks up to this.menuContainer to let canvas
        // handlers ignore clicks on the menu; the header bar is that region now.
        this.menuContainer = this.uiBar.bar;
    }

    constrainToScreen(left, top) {
        const rect = this.div.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        const halfWidth = rect.width / 2;
        const halfHeight = rect.height / 2;

        if (left < -halfWidth) {
            left = -halfWidth;
        } else if (left + halfWidth > viewportWidth) {
            left = viewportWidth - halfWidth;
        }

        if (top < -halfHeight) {
            top = -halfHeight;
        } else if (top + halfHeight > viewportHeight) {
            top = viewportHeight - halfHeight;
        }

        return { left, top };
    }

    ensureOnScreen() {
        const currentLeft = parseInt(this.div.style.left || 0);
        const currentTop = parseInt(this.div.style.top || 0);

        const constrainedPos = this.constrainToScreen(currentLeft, currentTop);

        if (constrainedPos.left !== currentLeft || constrainedPos.top !== currentTop) {
            this.div.style.left = constrainedPos.left + 'px';
            this.div.style.top = constrainedPos.top + 'px';
        }
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);

        if (this.visible) {
            this.ensureOnScreen();
        }
    }

    dispose() {
        // The tab menu + its container live on the shared CUIBar header; CNodeView.dispose()
        // disposes the uiBar (destroying the menu and removing the bar), so there's nothing to
        // tear down here beyond dropping our references.
        this.tabMenu = null;
        this.menuContainer = null;
        super.dispose();
    }
}

export {CNodeTabbedCanvasView};
