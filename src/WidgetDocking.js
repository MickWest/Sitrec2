import {
    addMenuToLeftSidebar, addMenuToRightSidebar, removeMenuFromLeftSidebar, removeMenuFromRightSidebar,
    getLeftSidebarMenuIndex, getRightSidebarMenuIndex, refreshSidebarVisibility,
} from "./PageStructure";

// Native panel backend. Only the rail adapter below shares legacy docking
// infrastructure; no lil-gui objects or markup are created for new widgets.
export class WidgetDocking {
    constructor() {
        this.document = document;
        this.hosts = new Set();
        this.changingLayout = false;
        this.front = 4700;
        this.floatCount = 0;
        this.onResize = () => {
            if (this.changingLayout) return;
            for (const host of this.hosts) host.clamp();
            refreshSidebarVisibility();
        };
        window.addEventListener("resize", this.onResize);
    }
    createHost(parent, options) {
        const host = new WidgetHost(this, parent, options);
        this.hosts.add(host);
        return host;
    }
    dispose() {
        window.removeEventListener("resize", this.onResize);
        for (const host of [...this.hosts]) host.dispose();
    }
}

class WidgetHost {
    constructor(backend, parent, {id, title, width = 250}) {
        Object.assign(this, {backend, id, title, width, closed: false, placement: "home", children: [], shown: true});
        this.parent = parent instanceof WidgetHost ? parent : null;
        this.parent?.children.push(this);
        this.element = document.createElement("section");
        this.element.className = "sitrec-modern";
        this.element.dataset.interactionNative = "true";
        this.titleElement = document.createElement("button");
        this.titleElement.className = "widget-title";
        this.titleElement.type = "button";
        this.titleElement.textContent = title;
        this.titleElement.setAttribute("aria-expanded", "true");
        this.contentElement = document.createElement("div");
        this.contentElement.className = "widget-content";
        this.element.append(this.titleElement, this.contentElement);
        (this.parent?.contentElement ?? parent).append(this.element);
        this.titleElement.onclick = () => {
            if (this.ignoreClick) { this.ignoreClick = false; return; }
            this.open(this.closed);
        };
        this.titleElement.ondblclick = () => { if (this.detached && this.parent) this.place("home"); };
        this.titleElement.addEventListener("pointerdown", event => this.startDrag(event));
        this.element.addEventListener("pointerdown", () => {
            if (this.floating) this.placementElement.style.zIndex = String(++backend.front);
        });
        // The existing rails accept a surface handle. Keep this compatibility
        // shape here, not in widget definitions or the native host interface.
        this.railHandle = {domElement: this.element, _widgetHidden: false};
    }
    get detached() { return this.placement !== "home"; }
    get floating() { return this.placement === "float"; }
    open(open = true) {
        if (this.closed === !open) return;
        this.closed = !open;
        this.element.classList.toggle("closed", this.closed);
        this.contentElement.hidden = this.closed;
        this.titleElement.setAttribute("aria-expanded", String(open));
        for (let host = this; host; host = host.parent) host.onOpenChange?.(this);
    }
    setVisible(visible) {
        this.shown = visible;
        this.element.hidden = !visible;
        this.railHandle._widgetHidden = !visible;
        if (this.placementElement) this.placementElement.hidden = !visible;
    }
    place(placement, position) {
        if (!["home", "float", "left", "right"].includes(placement)) return;
        const active = this.element.contains(document.activeElement) ? document.activeElement : null;
        this.backend.changingLayout = true;
        if (placement !== this.placement) {
            removeMenuFromLeftSidebar(this.railHandle);
            removeMenuFromRightSidebar(this.railHandle);
            if (placement === "home") {
                this.homeMarker?.replaceWith(this.element);
                this.placementElement?.remove();
                this.placementElement = null;
                this.homeMarker = null;
            } else {
                if (!this.placementElement) {
                    this.homeMarker = document.createComment(`widget:${this.id}`);
                    this.element.before(this.homeMarker);
                    this.placementElement = document.createElement("div");
                    this.placementElement.className = "widget-window";
                    this.placementElement.append(this.element);
                }
                document.body.append(this.placementElement);
                if (placement === "left") addMenuToLeftSidebar(this.railHandle);
                else if (placement === "right") addMenuToRightSidebar(this.railHandle);
                else {
                    // Each new float starts a step down and right of the one before, so that
                    // floats do not hide each other. A given position replaces this below.
                    const step = 24 * (this.backend.floatCount++ % 8);
                    Object.assign(this.placementElement.style, {position: "fixed", width: `${this.width}px`, height: "auto",
                        left: `${100 + step}px`, top: `${70 + step}px`, zIndex: String(++this.backend.front)});
                }
            }
            this.placement = placement;
        }
        if (this.floating && position) {
            if (Number.isFinite(position.x)) this.placementElement.style.left = `${position.x}px`;
            if (Number.isFinite(position.y)) this.placementElement.style.top = `${position.y}px`;
        }
        this.element.style.position = "relative";
        this.element.style.width = "100%";
        this.clamp();
        this.backend.changingLayout = false;
        this.setVisible(this.shown);
        this.onPlacementChange?.();
        refreshSidebarVisibility();
        if (active?.isConnected && document.activeElement !== active) active.focus({preventScroll: true});
    }
    clamp() {
        if (!this.floating) return;
        const c = this.placementElement;
        const width = Math.min(this.width, window.innerWidth - 8);
        const x = Math.max(4, Math.min(parseFloat(c.style.left) || 4, window.innerWidth - width - 4));
        const y = Math.max(25, Math.min(parseFloat(c.style.top) || 25, window.innerHeight - 60));
        Object.assign(c.style, {width: `${width}px`, left: `${x}px`, top: `${y}px`});
        this.element.style.maxHeight = `${Math.max(60, window.innerHeight - y - 8)}px`;
    }
    startDrag(event) {
        if (event.button !== 0 || event.isPrimary === false) return;
        const rect = this.titleElement.getBoundingClientRect();
        const initial = this.serialize();
        const offset = {x: event.clientX - rect.left, y: event.clientY - rect.top};
        let dragging = false, edge = null;
        const preview = document.createElement("div");
        preview.className = "widget-dock-preview";
        const move = e => {
            if (!dragging && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 8) return;
            dragging = true;
            this.place("float", {x: e.clientX - offset.x, y: e.clientY - offset.y});
            edge = e.clientX < 24 ? "left" : e.clientX > window.innerWidth - 24 ? "right" : null;
            preview.hidden = !edge;
            preview.style.left = edge === "left" ? "0" : "auto";
            preview.style.right = edge === "right" ? "0" : "auto";
            if (!preview.isConnected) document.body.append(preview);
            e.preventDefault();
        };
        const cleanup = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", end);
            document.removeEventListener("pointercancel", cancel);
            preview.remove(); this.dragCleanup = null;
        };
        // The click that ends a drag must not open or close the widget. The browser sends
        // that click in the same task as the release of the pointer. It sends no click when
        // the drag moved the widget to a new container, so the flag lasts for this task
        // only: a flag that stays set would cancel the next click of the user.
        const skipClickOfThisRelease = () => {
            this.ignoreClick = true;
            setTimeout(() => { this.ignoreClick = false; }, 0);
        };
        const end = e => {
            cleanup();
            if (!dragging) return;
            skipClickOfThisRelease();
            if (edge) this.place(edge);
            else if (e.clientY < 20 && this.parent) this.place("home");
        };
        const cancel = () => { cleanup(); if (dragging) { this.restore(initial); skipClickOfThisRelease(); } };
        this.dragCleanup?.(); this.dragCleanup = cleanup;
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", end);
        document.addEventListener("pointercancel", cancel);
    }
    serialize() {
        return {placement: this.placement, closed: this.closed,
            x: parseFloat(this.placementElement?.style.left) || 0, y: parseFloat(this.placementElement?.style.top) || 0,
            order: this.placement === "left" ? getLeftSidebarMenuIndex(this.railHandle) : getRightSidebarMenuIndex(this.railHandle)};
    }
    restore(state) {
        if (!state) return;
        this.place(state.placement, {x: state.x, y: state.y});
        this.open(!state.closed);
    }
    dispose() {
        this.dragCleanup?.();
        for (const child of [...this.children]) child.dispose();
        this.place("home");
        this.element.remove();
        this.backend.hosts.delete(this);
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }
}
