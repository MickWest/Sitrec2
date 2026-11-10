import {Vector3} from "three";
import {CNode} from "./CNode";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {ViewMan} from "../CViewManager";
import {rayIntersectsEllipsoid} from "../threeExt";
import {withDisplayedCamera} from "../ViewUtils";
import {fisheyeProjectVector} from "../FisheyeProjection";
import {panoramicProjectVector} from "../PanoramicCamera";
import {createNativeControlGroup, mirrorControl, setNativeControlGroupActive} from "../NativeControls";
import {starlinkPanelStyle} from "../StarlinkPanelStyle";
import {WidgetPanel} from "../WidgetPanel";
import {satellitePanelDefinition, satelliteWidgets} from "../SatelliteWidgets";
import {t} from "../i18n";


// Shared custom-scene viewing controls. The Starlink preset opts into the initial
// sky layout and visible controls; other scenes retain their layout and start hidden.
// All scientific state stays in the existing nodes.
//
// This node is the scene context of the widgets. It gives them the scene nodes, the
// sources of the old controls, one scope for each mounted widget, and one producer of
// satellite counts. Each widget owns its elements, its controls and its refresh.
export class CNodeStarlinkUI extends CNode {
    constructor(v) {
        super(v);
        this.visible = v.visible ?? false;
        this.expanded = v.expanded ?? window.innerWidth > 760;
        this.addSimpleSerial("expanded");
        this.disposed = false;
        this.style = document.createElement("style");
        this.style.textContent = starlinkPanelStyle;
        document.head.append(this.style);
        this.look = NodeMan.get("lookView");
        this.main = NodeMan.get("mainView");
        if (v.startSkyLayout && !Sit.mods?.mainView && !Sit.mods?.lookView) this.setViewLayout(false);
        this.hud = document.createElement("div");
        this.hud.className = "starlink-hud sitrec-modern";
        const homes = {};
        for (const side of ["left", "right"]) {
            homes[side] = document.createElement("div");
            homes[side].className = `widget-info-stack widget-info-${side}`;
            this.hud.append(homes[side]);
        }
        this.look.div.append(this.hud);
        const panelName = t("panels.satellite.title");
        this.controlsMenu = guiMenus.view.addFolder(t("panels.menu.folder")).close();
        this.controlsMenu._folderId = "control-panels";
        this.widgetHome = document.createElement("div");
        this.widgetHome.hidden = true;
        document.body.append(this.widgetHome);
        this.widgets = new WidgetPanel({
            parent: this.widgetHome,
            definition: satellitePanelDefinition, registry: satelliteWidgets,
            context: this, homes,
            onChange: () => this.changed(),
            onCollapse: () => { this.setExpanded(false); this.launcher?.focus({preventScroll: true}); },
        });
        this.panel = this.widgets.host.element;
        this.panel.id = "starlink-viewing-panel";
        this.launcher = document.createElement("button");
        this.launcher.className = "starlink-launcher sitrec-modern";
        this.launcher.textContent = `☰ ${panelName}`;
        this.launcher.setAttribute("aria-controls", this.panel.id);
        this.launcher.onclick = () => this.setExpanded(true);
        document.body.append(this.launcher);
        // Named recovery works even when every widget has been hidden or moved.
        const actions = {open: () => { this.show(true); this.setExpanded(true); },
            reset: () => { this.show(true); this.setExpanded(true); this.widgets.reset(); }};
        this.controlsMenu.add(actions, "open").name(panelName).moveToFirst();
        for (const instance of this.widgets.instances.values()) {
            // Show one widget where it is. A hidden panel stays collapsed, so that only
            // this widget opens.
            const reveal = {open: () => {
                if (!this.visible) this.expanded = false;
                this.show(true);
                this.widgets.reveal(instance.id);
                this.controlsMenu.close();
            }};
            this.controlsMenu.add(reveal, "open").name(instance.host.title);
        }
        this.controlsMenu.add(actions, "reset").name(t("panels.menu.restore"));
        this.onResize = () => this.layoutPanel();
        window.addEventListener("resize", this.onResize);
        // The master visibility checkbox is the first row of the Satellites menu, and
        // only there. The menu stays open after a change.
        this.gui = guiMenus.satellites;
        this.gui.add(this, "visible").name(panelName).listen().onChange(v => {
            this.show(v);
            markSitchDirty();
        }).moveToFirst();
        this.show(this.visible);
        // Paused scenes sleep their render loop. UI still needs to follow menu edits.
        this.timer = setInterval(() => this.sync(), 250);
    }

    // ---- Scene state that widgets read ----
    get sky() { return NodeMan.get("NightSkyNode"); }
    get dateTime() { return NodeMan.get("dateTimeStart"); }
    get observer() { return NodeMan.get("fixedCameraPosition"); }
    get ptz() { return NodeMan.get("ptzAngles"); }
    get skyOverviewLayout() { return this.look.width > 0.9 && this.main.height < 0.5; }
    get splitLayout() { return this.look.width === 0.5 && this.main.width === 0.5; }
    get observerIsManual() { return NodeMan.get("cameraTrackSwitch").choice === "fixedCamera"; }
    get headingIsManual() { return NodeMan.get("CameraLOSController").choice === "Manual"; }
    get playback() {
        return {live: this.dateTime.liveMode, paused: par.paused, speed: (Sit.simSpeed ?? 1) * (par.playbackSpeed ?? 1)};
    }

    changed() { markSitchDirty(); setRenderOne(true); }

    // ---- Sources: the old controls that hold the values ----
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

    // ---- The one producer of satellite counts. Widgets read it; they do not count again. ----
    satelliteStatus() {
        const now = performance.now();
        if (!this.status || now - this.statusTime > 1000) {
            this.statusTime = now;
            this.status = this.countSatellites();
        }
        return this.status;
    }

    countSatellites() {
        const sats = this.sky.satellites, data = sats.renderTLEData;
        if (!data) return {data: false};
        const projected = new Vector3(), direction = new Vector3();
        let inView = 0, matching = 0;
        withDisplayedCamera(this.look, camera => {
            for (const sat of data.satData) {
                if (!sat.visible) continue;
                matching++;
                if (sat.invalidPosition || sat.tleFrameHidden || sat.hiddenInLookView || !(sat.lastScale > 0) || !(Sit.satScale > 0)) continue;
                const position = sat.ecefApparent ?? sat.ecef;
                if (!position) continue;
                projected.copy(position);
                if (!panoramicProjectVector(projected, camera) && !fisheyeProjectVector(projected, camera)) projected.project(camera);
                if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
                direction.copy(position).sub(camera.position);
                if (rayIntersectsEllipsoid(camera.position, direction)) continue;
                inView++;
            }
        });
        const start = data.startDate, end = data.endDate, now = this.dateTime.dateNow;
        const haveDates = start instanceof Date && end instanceof Date && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime());
        return {
            data: true, simulated: !!data.simulated, total: data.satData.length, matching, inView,
            searchActive: !!sats.nameFilter.trim(),
            // A TLE filter applies to loaded orbit data only, not to simulated satellites.
            tleActive: !!sats.tleFilterResults && !data.simulated,
            savedTleFilter: !!sats.tleFilterResults,
            loadedCount: sats.TLEData?.satData.length ?? 0,
            start: haveDates ? start : null, end: haveDates ? end : null,
            outside: haveDates && (now < start || now > end),
        };
    }

    action(action) {
        if (action === "collapse") this.setExpanded(false);
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

    show(visible = true) {
        this.visible = visible;
        this.updateVisibility();
        this.sync();
    }

    setExpanded(expanded) {
        if (this.expanded === expanded) return;
        const active = this.panel.ownerDocument.activeElement;
        const transferFocus = this.panel.contains(active) || this.launcher === active;
        this.expanded = expanded;
        this.updateVisibility();
        if (this.visible && transferFocus) {
            const target = expanded ? (this.widgets?.host.titleElement ?? this.panel.querySelector('[data-action="collapse"]')) : this.launcher;
            target.focus({preventScroll: true});
        }
        markSitchDirty();
    }

    updateVisibility() {
        if (this.widgets) this.widgets.setVisible(this.visible, this.expanded);
        else this.panel.hidden = !this.visible || !this.expanded;
        this.launcher.hidden = !this.visible || this.expanded;
        this.hud.hidden = !this.visible;
        this.launcher.setAttribute("aria-expanded", String(this.expanded));
        this.layoutPanel();
    }

    layoutPanel() {
        const top = ViewMan.container.getBoundingClientRect().top + ViewMan.topPx;
        this.launcher.style.top = (top + 12) + "px";
        this.widgets?.updateVisibility();
        setRenderOne(true);
    }

    // The periodic refresh. Each active widget refreshes its own elements.
    sync() {
        if (this.disposed) return;
        // The TLE epoch/range stats belong to the large sky view in this layout,
        // even when the sidebar itself is hidden or collapsed.
        NodeMan.get("labelMainViewPVS", false)?.setOverlayView(this.skyOverviewLayout ? this.look : this.main);
        if (!this.visible) return;
        this.widgets?.setVisible(this.visible, this.expanded);
        this.widgets?.update();
    }

    modSerialize() {
        return {...super.modSerialize(), widgetState: this.widgets.getState()};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.widgets.setState(v.widgetState);
        this.show(this.visible);
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        this.widgets.dispose();
        this.controlsMenu.destroy();
        this.widgetHome.remove();
        window.removeEventListener("resize", this.onResize);
        this.panel.remove();
        this.launcher.remove();
        this.hud.remove();
        this.style.remove();
        super.dispose();
    }
}
