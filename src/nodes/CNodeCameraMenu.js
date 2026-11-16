import {CNode} from "./CNode";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne} from "../Globals";
import {ViewMan} from "../CViewManager";
import {createNativeControlGroup, mirrorControl, setNativeControlGroupActive} from "../NativeControls";
import {routeNativeKeys} from "../NativeKeyRouting";
import {localizeElements} from "../NativeText";
import {modernControlStyle} from "../ModernControlStyle";
import {widgetPanelStyle} from "../WidgetPanelStyle";
import {viewingWidgets} from "../ViewingWidgets";
import {t} from "../i18n";

// A compact front page for the standard Camera menu. Original controllers keep
// their ownership and paths, so saves, AI commands and advanced edits share state.
export class CNodeCameraMenu extends CNode {
    constructor(v) {
        super(v);
        this.disposed = false;
        this.look = NodeMan.get("lookView");
        this.main = NodeMan.get("mainView");
        const menu = this.menu = guiMenus.camera;
        menu.domElement.classList.add("sitrec-modern");
        this.style = document.createElement("style");
        this.style.textContent = modernControlStyle + widgetPanelStyle + `
            .camera-menu { padding: 5px 7px; }
            .camera-menu .native-control { min-width: 0; }
            .camera-menu [data-section=camera] { border-top: 1px solid var(--panel-divider); margin-top: 5px; padding-top: 3px; }
            .camera-menu-advanced > summary { cursor: pointer; padding: 7px; font: 11px system-ui,sans-serif; }
        `;
        document.head.append(this.style);
        this.advanced = document.createElement("details");
        this.advanced.className = "camera-menu-advanced";
        const summary = document.createElement("summary");
        summary.textContent = t("satelliteEditor.advanced");
        this.advanced.append(summary, ...Array.from(menu.$children.children));
        this.host = document.createElement("div");
        this.host.className = "camera-menu widget-body sitrec-modern";
        this.host.dataset.interactionNative = "true";
        this.host.dataset.widgetPath = menu.$title.textContent;
        routeNativeKeys(this.host);
        this.parts = [];
        const position = document.createElement("div");
        position.innerHTML = '<div data-id="positionSource"></div>';
        this.host.append(position);
        const positionScope = this.createScope(position);
        positionScope.control("positionSource", NodeMan.get("cameraTrackSwitch"), "choice");
        this.parts.push(positionScope.lifecycle());
        for (const type of ["observer", "camera"]) {
            const definition = viewingWidgets[type];
            const body = document.createElement("div");
            body.dataset.section = type;
            body.innerHTML = definition.html;
            localizeElements(body);
            this.host.append(body);
            this.parts.push(definition.mount({body, context: this, scope: this.createScope(body)}));
        }
        menu.$children.prepend(this.host, this.advanced);
        this.layoutMenu = guiMenus.view.addFolder(t("panels.widgets.viewLayout.title")).close();
        this.layoutMenu._folderId = "view-layout";
        this.layoutMenu.add({sky: () => this.action("sky")}, "sky").name(t("panels.widgets.viewLayout.sky"));
        this.layoutMenu.add({split: () => this.action("split")}, "split").name(t("panels.widgets.viewLayout.split"));
        // Refresh paused scenes too; native bindings retain active text drafts.
        this.timer = setInterval(() => this.sync(), 250);
        this.sync();
    }

    get sky() { return NodeMan.get("NightSkyNode"); }
    get observer() { return NodeMan.get("fixedCameraPosition"); }
    get ptz() { return NodeMan.get("ptzAngles"); }
    get skyOverviewLayout() { return this.look.width > 0.9 && this.main.height < 0.5; }
    get splitLayout() { return this.look.width === 0.5 && this.main.width === 0.5; }
    get observerIsManual() { return NodeMan.get("cameraTrackSwitch").choice === "fixedCamera"; }
    get headingIsManual() { return NodeMan.get("CameraLOSController").choice === "Manual"; }
    changed() { markSitchDirty(); setRenderOne(true); }

    findSource(property, object) {
        for (const menu of Object.values(guiMenus)) {
            const source = menu.controllersRecursive?.().find(c => c.property === property && (!object || c.object === object));
            if (source) return source;
        }
    }

    source(object, property) {
        return this.findSource(property, object);
    }

    setControl(object, property, value) {
        this.source(object, property)?.setValue(value);
        this.changed();
    }

    // One scope for each mounted widget body. Elements and control groups belong to
    // that body only, so two instances of a widget do not replace each other. The
    // sources are shared, so each instance shows the same values.
    createScope(body) {
        const groups = new Map();
        const scope = {
            el: id => body.querySelector(`[data-id="${id}"]`),
            // Options apply when the group is made: {beforeEdit, onChange}.
            group: (id, options = {}) => {
                if (!groups.has(id)) {
                    groups.set(id, createNativeControlGroup(scope.el(id), {
                        beforeEdit: options.beforeEdit,
                        onChange: () => { options.onChange?.(); this.changed(); },
                    }));
                }
                return groups.get(id);
            },
            mirror: (source, container, options) => source ? mirrorControl(source, scope.group(container), options) : undefined,
            control: (container, object, property, options = {}) => {
                const twin = scope.mirror(this.source(object, property), container, options);
                if (twin?.$input?.type === "checkbox") twin.asListCheckbox();
                return twin;
            },
            // The hooks that a widget returns from mount(). `extra` adds its own.
            lifecycle: (extra = {}) => ({
                update: extra.update,
                setActive: active => {
                    for (const group of groups.values()) setNativeControlGroupActive(group, active);
                    extra.setActive?.(active);
                },
                dispose: () => {
                    for (const group of groups.values()) group.destroy();
                    groups.clear();
                    extra.dispose?.();
                },
            }),
        };
        return scope;
    }

    action(action) {
        if (action === "sky" || action === "split") {
            if (ViewMan.fullscreenView) ViewMan.fullscreenView.doubleClick();
            const split = action === "split";
            this.setViewLayout(split);
            this.look.setVisible(true);
            this.main.setVisible(true);
            markSitchDirty();
        }
        if (action === "aim") this.sky.lookTowardsFlareRegion();
        setRenderOne(true);
        this.sync();
    }

    setViewLayout(split) {
        Object.assign(this.look, {left: split ? 0.5 : 0, top: 0, width: split ? 0.5 : 1, height: 1});
        Object.assign(this.main, {left: split ? 0 : 0.74, top: split ? 0 : 0.72, width: split ? 0.5 : 0.26, height: split ? 1 : 0.28});
    }


    sync() {
        if (this.disposed) return;
        for (const part of this.parts) part.update?.();
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        for (const part of this.parts) part.dispose?.();
        this.layoutMenu.destroy();
        this.host.remove();
        // Camera folder shells are permanent. Put them back before removing this
        // presentation, so the next scene can reuse them normally.
        for (const child of [...this.advanced.children].slice(1)) this.menu.$children.append(child);
        this.advanced.remove();
        this.style.remove();
        super.dispose();
    }
}
