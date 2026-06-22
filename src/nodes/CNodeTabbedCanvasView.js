import {CNodeViewCanvas2D} from "./CNodeViewCanvas";

class CNodeTabbedCanvasView extends CNodeViewCanvas2D {
    constructor(v) {
        super(v);

        this.menuName = v.menuName ?? 'Menu';
        this._dragHandle = v.dragHandle;

        this.createTabMenu();
    }

    createTabMenu() {
        // Phase 3: the per-view menu IS the CUIBar TITLE menu (named with the friendly view
        // name by CNodeView). Subclasses (FOV / curve editors) add their controls to
        // this.tabMenu via addMenuItems(). Closing is the header ✕ icon now, so no "close"
        // item here. Moving is the header drag handle; lil-gui's title click (wired in
        // CUIBar.addMenu) toggles the dropdown.
        if (!this.uiBar || !this.uiBar.titleMenu) return;   // overlay / passThrough: no header
        this.tabMenu = this.uiBar.titleMenu;

        // A "Close" item that hides the view. (The header ✕ icon does the same; the menu item
        // is kept because the per-view menu is the primary control surface for these editors —
        // e.g. the custom graph — and also keeps the title menu non-empty so it opens.)
        this.tabMenu.add({ close: () => this.show(false) }, 'close').name('Close');

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
