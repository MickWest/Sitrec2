import {WidgetDocking} from "./WidgetDocking";
import {refreshSidebarVisibility} from "./PageStructure";
import {widgetPanelStyle} from "./WidgetPanelStyle";
import {modernControlStyle} from "./ModernControlStyle";
import {routeNativeKeys} from "./NativeKeyRouting";
import {t} from "./i18n";
import {localizeElements, titleText} from "./NativeText";

// A composition is an ordered tree of widget type IDs, not another store of
// control values. Native hosts own placement and saved layout; factories
// own content and return optional activation/disposal hooks.
// A definition, a type or an entry gives its title as `titleKey` (a key in
// src/i18n/en.js) or as fixed text in `title`.
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
        this.title = titleText(definition);
        this.host = this.createHost(parent, definition.id, this.title);
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
                // A combined widget: `merge` names more widget types. Their content follows
                // the content of `type` in the same host, so related controls share one
                // title, one placement and one saved layout entry.
                const names = [spec.type, ...(spec.merge ?? [])];
                const parts = names.map(name => {
                    if (!registry[name]) throw new Error(`Unknown widget: ${name}`);
                    return registry[name];
                });
                const type = parts[0];
                const id = spec.id ?? spec.type;
                if (this.instances.has(id)) throw new Error(`Duplicate widget instance: ${id}`);
                const host = this.createHost(parentHost, id, titleText(spec) ?? titleText(type));
                const lifecycles = [];
                const bodies = parts.map((part, index) => {
                    const body = doc.createElement("div");
                    body.className = "widget-body";
                    body.dataset.widgetPart = names[index];
                    host.contentElement.append(body);
                    if (part.html) {
                        body.innerHTML = part.html;
                        localizeElements(body);
                    }
                    // The scope holds the elements and the control groups of this body only.
                    lifecycles.push(part.mount?.({host, body, context, scope: context.createScope?.(body)}) ?? {});
                    return body;
                });
                const instance = {id, host, body: bodies[0], bodies, hidden: false, spec, type};
                this.instances.set(id, instance);
                instance.lifecycle = lifecycles.length === 1 ? lifecycles[0] : {
                    update: () => { for (const lifecycle of lifecycles) lifecycle.update?.(); },
                    setActive: active => { for (const lifecycle of lifecycles) lifecycle.setActive?.(active); },
                    dispose: () => { for (const lifecycle of lifecycles) lifecycle.dispose?.(); },
                };
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
                instance.returnButton.title = t("panels.placement.returnTip", {title: host.title, panel: this.title});
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
        // The usage log names a control by this path. It does not change when the widget
        // moves to a rail or to a float.
        const parentPath = parent?.element?.dataset.widgetPath;
        host.element.dataset.widgetPath = parentPath ? `${parentPath}/${title}` : title;
        host.titleElement.title = t("panels.placement.titleTip");
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
        button.title = t("panels.placement.arrange", {title: host.title});
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
        menu.setAttribute("aria-label", button.title);
        menu.dataset.widgetPath = `${host.element.dataset.widgetPath}/⋮`;
        button.setAttribute("aria-expanded", "true");
        const add = (label, action) => {
            const item = document.createElement("button");
            item.textContent = label;
            item.setAttribute("role", "menuitem");
            item.onclick = () => { this.closePlacementMenu(); action(); this.onChange(); };
            menu.append(item);
        };
        for (const [key, placement] of [["float", "float"], ["dockLeft", "left"], ["dockRight", "right"]]) {
            add(t(`panels.placement.${key}`), () => { this.place(instance?.id, placement); host.titleElement.focus({preventScroll: true}); });
        }
        if (instance) {
            add(instance.spec.home ? t("panels.placement.returnToSky") : t("panels.placement.returnTo", {title: this.title}), () => this.recover(instance.id));
            add(t("panels.placement.hide"), () => this.hide(instance.id));
        } else {
            add(t("panels.placement.collapse"), () => this.onCollapse());
            add(t("panels.placement.restore"), () => this.reset());
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
                // A widget that comes into view shows current values at once.
                if (active) instance.lifecycle?.update?.();
            }
        }
        refreshSidebarVisibility();
    }

    // The periodic refresh. Each widget in view refreshes its own elements from the scene.
    update() {
        if (this.disposed) return;
        for (const instance of this.instances.values()) {
            if (instance.active) instance.lifecycle?.update?.();
        }
    }

    // Show one widget where it is: at home, in a rail or in a float. A widget at home in
    // a collapsed composition has no place to show, so it floats.
    reveal(id) {
        const instance = this.instances.get(id);
        instance.hidden = false;
        if (!instance.host.detached && !instance.spec.home && !this.expanded) this.place(id, "float");
        instance.host.open();
        this.updateVisibility();
        instance.host.element.scrollIntoView?.({block: "nearest"});
        instance.host.titleElement.focus({preventScroll: true});
        this.onChange();
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
