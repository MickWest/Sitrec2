import {WidgetDocking} from "./WidgetDocking";
import {refreshSidebarVisibility} from "./PageStructure";
import {widgetPanelStyle} from "./WidgetPanelStyle";
import {modernControlStyle} from "./ModernControlStyle";
import {routeNativeKeys} from "./NativeKeyRouting";

// A composition is an ordered tree of widget type IDs, not another store of
// control values. Native hosts own placement and saved layout; factories
// own content and return optional activation/disposal hooks.
export class WidgetPanel {
    constructor({parent, backend = new WidgetDocking(), definition, registry, context, homes = {}, onChange = () => {}, onCollapse = () => {}}) {
        Object.assign(this, {backend, definition, context, homes, onChange, onCollapse});
        this.instances = new Map();
        this.visible = false;
        this.expanded = true;
        this.disposed = false;
        this.updating = true;
        const doc = backend.document;
        if (!doc.getElementById("sitrec-widget-panel-style")) {
            const style = doc.createElement("style");
            style.id = "sitrec-widget-panel-style";
            style.textContent = modernControlStyle + widgetPanelStyle;
            doc.head.append(style);
        }
        this.host = this.createHost(parent, definition.id, definition.title);
        this.host.element.classList.add("widget-composition");
        this.host.onOpenChange = changed => {
            if (this.updating || this.disposed || this.backend.changingLayout) return;
            if (changed === this.host && changed.closed && changed.placementElement) this.onCollapse();
            this.updateVisibility();
            this.onChange();
        };
        const build = (items, parentHost) => {
            for (const item of items) {
                const spec = typeof item === "string" ? {type: item} : item;
                const type = registry[spec.type];
                if (!type) throw new Error(`Unknown widget: ${spec.type}`);
                const id = spec.id ?? spec.type;
                if (this.instances.has(id)) throw new Error(`Duplicate widget instance: ${id}`);
                const host = this.createHost(parentHost, id, spec.title ?? type.title);
                const body = doc.createElement("div");
                body.className = "widget-body";
                host.contentElement.append(body);
                const instance = {id, host, body, hidden: false, spec, type};
                this.instances.set(id, instance);
                if (type.html) body.innerHTML = type.html;
                context.registerElements?.(body);
                instance.lifecycle = type.mount?.({host, body, context}) ?? {};
                if (spec.children) build(spec.children, host);
                host.open(!(spec.collapsed ?? type.collapsed));
                if (spec.home && homes[spec.home]) {
                    homes[spec.home].append(host.element);
                    host.element.classList.add("widget-info");
                }
                this.addPlacementButton(host, instance);
                // Every extracted widget keeps a named way back in its original
                // composition. This is outside host.children: it is presentation.
                instance.returnButton = doc.createElement("button");
                instance.returnButton.className = "widget-return";
                instance.returnButton.textContent = `↩ ${host.title}`;
                instance.returnButton.title = `Return ${host.title} to ${definition.title}`;
                instance.returnButton.hidden = true;
                instance.returnButton.onclick = () => this.recover(id);
                host.element.before(instance.returnButton);
            }
        };
        build(definition.widgets, this.host);
        this.addPlacementButton(this.host);
        this.updating = false;
    }

    createHost(parent, id, title) {
        const host = this.backend.createHost(parent, {id, title});
        host.element.classList.add("widget-panel");
        host.element.dataset.widgetId = id;
        host.element.setAttribute("aria-label", title);
        host.titleElement.title = "Drag the title to move; use the placement menu to dock, return or hide.";
        routeNativeKeys(host.element);
        host.onPlacementChange = () => {
            if (this.disposed) return;
            const floating = host.floating;
            host.element.classList.toggle("widget-floating", floating);
            if (host.placementElement) {
                host.placementElement.classList.add("widget-window");
                if (!floating) host.element.style.maxHeight = "";
            } else host.element.style.maxHeight = "";
            this.updateVisibility();
            if (!this.updating && !this.backend.changingLayout) this.onChange();
        };
        return host;
    }

    addPlacementButton(host, instance) {
        const button = document.createElement("button");
        button.className = "widget-placement-button";
        button.textContent = "⋮";
        button.title = `Arrange ${host.title}`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        host.titleElement.after(button);
        button.onclick = () => this.openPlacementMenu(host, instance, button);
    }

    openPlacementMenu(host, instance, button) {
        this.closePlacementMenu();
        const menu = document.createElement("div");
        menu.className = "widget-placement-menu sitrec-modern";
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", `Arrange ${host.title}`);
        button.setAttribute("aria-expanded", "true");
        const add = (label, action) => {
            const item = document.createElement("button");
            item.textContent = label;
            item.setAttribute("role", "menuitem");
            item.onclick = () => { this.closePlacementMenu(); action(); this.onChange(); };
            menu.append(item);
        };
        for (const [label, placement] of [["Float", "float"], ["Dock left", "left"], ["Dock right", "right"]]) {
            add(label, () => { this.place(instance?.id, placement); host.titleElement.focus({preventScroll: true}); });
        }
        if (instance) {
            add(instance.spec.home ? "Return to sky view" : `Return to ${this.definition.title}`, () => this.recover(instance.id));
            add("Hide widget", () => this.hide(instance.id));
        } else {
            add("Collapse controls", () => this.onCollapse());
            add("Restore default arrangement", () => this.reset());
        }
        const rect = button.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 230))}px`;
        menu.style.top = `${Math.max(4, Math.min(rect.bottom, window.innerHeight - 210))}px`;
        const outside = event => { if (!menu.contains(event.target) && event.target !== button) this.closePlacementMenu(); };
        menu.addEventListener("keydown", event => {
            event.stopPropagation();
            const items = [...menu.children];
            if (event.key === "Escape") { event.preventDefault(); this.closePlacementMenu(); button.focus(); }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index = items.indexOf(document.activeElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next].focus();
            }
        });
        menu.addEventListener("keyup", event => event.stopPropagation());
        document.body.append(menu);
        document.addEventListener("pointerdown", outside, true);
        this.menuCleanup = () => { menu.remove(); button.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); };
        menu.firstElementChild.focus();
    }

    closePlacementMenu() { this.menuCleanup?.(); this.menuCleanup = null; }

    place(id, placement, position) {
        const host = id ? this.instances.get(id).host : this.host;
        host.place(placement, position);
        this.updateVisibility();
    }

    recover(id) {
        const instance = this.instances.get(id);
        instance.hidden = false;
        this.place(id, "home");
        // Expand enclosing widgets when returning a nested widget.
        for (let host = instance.host.parent; host && host !== this.host.parent; host = host.parent) host.open();
        this.updateVisibility();
        instance.host.titleElement.focus({preventScroll: true});
        this.onChange();
    }

    hide(id) {
        const instance = this.instances.get(id);
        instance.hidden = true;
        this.updateVisibility();
        const target = instance.returnButton.getClientRects().length ? instance.returnButton : this.host.titleElement;
        target.focus({preventScroll: true});
        this.onChange();
    }

    setVisible(visible, expanded = true) {
        this.visible = visible;
        this.expanded = expanded;
        // An older save has no widget layout. A composition restored to its menu
        // home also uses the familiar left rail when opened with the launcher.
        if (visible && expanded && !this.host.placementElement) this.place(undefined, "left");
        this.updating = true;
        if (visible && expanded) this.host.open();
        this.updating = false;
        this.updateVisibility();
    }

    updateVisibility() {
        if (!this.host || this.disposed) return;
        this.host.setVisible(this.visible && this.expanded);
        for (const instance of this.instances.values()) {
            const available = this.visible && (this.expanded || instance.host.detached || !!instance.spec.home);
            const visible = available && !instance.hidden;
            instance.host.setVisible(visible);
            if (instance.returnButton) instance.returnButton.hidden = !available || !(instance.hidden || instance.host.placementElement);
            let active = visible && !instance.host.closed;
            if (!instance.host.placementElement && !instance.spec.home) {
                for (let parent = instance.host.parent; parent && parent !== this.host.parent; parent = parent.parent) active &&= !parent.closed;
            }
            if (instance.active !== active) {
                instance.active = active;
                instance.lifecycle?.setActive?.(active);
            }
        }
        refreshSidebarVisibility();
    }

    reset() {
        this.updating = true;
        for (const instance of this.instances.values()) {
            instance.hidden = false;
            instance.host.place("home");
            instance.host.open(!(instance.spec.collapsed ?? instance.type.collapsed));
        }
        this.place(undefined, "left");
        this.updating = false;
        this.updateVisibility();
        this.host.titleElement.focus({preventScroll: true});
        this.onChange();
    }

    getState() {
        return {version: 1, panel: this.host.serialize(), widgets: Object.fromEntries([...this.instances].map(([id, instance]) =>
            [id, {...instance.host.serialize(), hidden: instance.hidden}]))};
    }
    setState(state) {
        this.updating = true;
        this.host.restore(state?.panel);
        for (const instance of [...this.instances.values()].sort((a, b) => (state?.widgets?.[a.id]?.order ?? 0) - (state?.widgets?.[b.id]?.order ?? 0))) {
            const saved = state?.widgets?.[instance.id];
            instance.hidden = saved?.hidden ?? false;
            instance.host.restore(saved);
        }
        this.updating = false;
        this.updateVisibility();
    }

    dispose() {
        this.disposed = true;
        this.closePlacementMenu();
        for (const instance of this.instances.values()) { instance.lifecycle.dispose?.(); instance.returnButton.remove(); }
        this.host.dispose();
        this.instances.clear();
        this.backend.dispose();
    }
}
