import {SIMULATED_SATELLITE_COLOR, SIMULATED_SATELLITE_DESCRIPTION} from "../SatelliteSimulation";
import {Vector3} from "three";
import {CNode} from "./CNode";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {ViewMan} from "../CViewManager";
import {resolveLocationString} from "../CoordinateInput";
import {rayIntersectsEllipsoid} from "../threeExt";
import {withDisplayedCamera} from "../ViewUtils";
import {fisheyeProjectVector} from "../FisheyeProjection";
import {panoramicProjectVector} from "../PanoramicCamera";
import {compassHeading, viewingDateInput} from "../StarlinkViewing";
import {createNativeControlGroup, mirrorControl, setNativeControlGroupActive} from "../NativeControls";
import {disableFreeLook} from "../FreeLookGuard";
import {starlinkPanelStyle} from "../StarlinkPanelStyle";
import {WidgetPanel} from "../WidgetPanel";
import {SATELLITE_PANEL_NAME as PANEL_NAME, satellitePanelDefinition, satelliteWidgets} from "../SatelliteWidgets";


// Shared custom-scene viewing controls. The Starlink preset opts into the initial
// sky layout and visible controls; other scenes retain their layout and start hidden.
// All scientific state stays in the existing nodes.
export class CNodeStarlinkUI extends CNode {
    constructor(v) {
        super(v);
        this.visible = v.visible ?? false;
        this.expanded = v.expanded ?? window.innerWidth > 760;
        this.addSimpleSerial("expanded");
        this.controlGroups = new Map();
        this.elements = new Map();
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
        this.controlsMenu = guiMenus.view.addFolder("Control Panels").close();
        this.controlsMenu._folderId = "control-panels";
        this.widgetHome = document.createElement("div");
        this.widgetHome.hidden = true;
        document.body.append(this.widgetHome);
        this.widgets = new WidgetPanel({
            parent: this.widgetHome,
            definition: satellitePanelDefinition, registry: satelliteWidgets,
            context: this, homes,
            onChange: () => { markSitchDirty(); setRenderOne(true); },
            onCollapse: () => { this.setExpanded(false); this.launcher?.focus({preventScroll: true}); },
        });
        this.panel = this.widgets.host.element;
        this.panel.id = "starlink-viewing-panel";
        this.launcher = document.createElement("button");
        this.launcher.className = "starlink-launcher sitrec-modern";
        this.launcher.textContent = `☰ ${PANEL_NAME}`;
        this.launcher.setAttribute("aria-controls", this.panel.id);
        this.launcher.onclick = () => this.setExpanded(true);
        document.body.append(this.launcher);
        // Named recovery works even when every widget has been hidden or moved.
        const actions = {open: () => { this.show(true); this.setExpanded(true); },
            reset: () => { this.show(true); this.setExpanded(true); this.widgets.reset(); }};
        this.controlsMenu.add(actions, "open").name(PANEL_NAME).moveToFirst();
        for (const instance of this.widgets.instances.values()) {
            const recover = {open: () => {
                if (!this.visible) this.expanded = false;
                this.show(true);
                instance.hidden = false;
                this.widgets.place(instance.id, "float");
                instance.host.open();
                instance.host.titleElement.focus({preventScroll: true});
                this.controlsMenu.close();
            }};
            this.controlsMenu.add(recover, "open").name(instance.host.title);
        }
        this.controlsMenu.add(actions, "reset").name("Restore control arrangement");
        this.onResize = () => this.layoutPanel();
        window.addEventListener("resize", this.onResize);
        this.gui = guiMenus.view;
        const visibility = this.gui.add(this, "visible").name(PANEL_NAME).listen().onChange(v => {
            this.show(v);
            if (this.gui.mode === "DOCKED") this.gui.close();
            markSitchDirty();
        });
        visibility.mirrorTo(guiMenus.satellites, {listen: true}).moveToFirst();
        this.show(this.visible);
        // Paused scenes sleep their render loop. UI still needs to follow menu edits.
        this.timer = setInterval(() => this.sync(), 250);
    }

    get sky() { return NodeMan.get("NightSkyNode"); }
    get dateTime() { return NodeMan.get("dateTimeStart"); }
    get observer() { return NodeMan.get("fixedCameraPosition"); }
    get ptz() { return NodeMan.get("ptzAngles"); }
    get skyOverviewLayout() { return this.look.width > 0.9 && this.main.height < 0.5; }
    el(id) { return this.elements?.get(id) ?? this.panel.querySelector(`[data-id="${id}"]`); }
    hudEl(id) { return this.elements?.get(id) ?? this.hud.querySelector(`[data-id="${id}"]`); }

    registerElements(body) {
        for (const element of body.querySelectorAll("[data-id]")) this.elements.set(element.dataset.id, element);
    }

    groupLifecycle(ids) {
        return {setActive: active => {
            for (const id of ids) { const gui = this.controlGroups.get(id); if (gui) setNativeControlGroupActive(gui, active); }
        }};
    }

    findSource(property, object) {
        for (const menu of Object.values(guiMenus)) {
            const source = menu.controllersRecursive?.().find(c => c.property === property && (!object || c.object === object));
            if (source) return source;
        }
    }

    source(object, property) {
        return this.findSource(property, object);
    }

    group(id) {
        if (!this.controlGroups.has(id)) {
            this.controlGroups.set(id, createNativeControlGroup(this.el(id), {
                beforeEdit: id === "angles" ? disableFreeLook : undefined,
                onChange: () => {
                    if (id === "altitudeControls") this.locationTicket = (this.locationTicket ?? 0) + 1;
                    markSitchDirty(); setRenderOne(true);
                },
            }));
        }
        return this.controlGroups.get(id);
    }

    control(container, object, property, options = {}) {
        const source = this.source(object, property);
        const twin = source ? mirrorControl(source, this.group(container), options) : undefined;
        if (twin?.$input?.type === "checkbox") twin.asListCheckbox();
        return twin;
    }

    mirror(source, group, options) {
        return source ? mirrorControl(source, this.group(group), options) : undefined;
    }

    setControl(object, property, value) {
        this.source(object, property)?.setValue(value);
        markSitchDirty();
        setRenderOne(true);
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

    setLocation(id) {
        if (NodeMan.get("cameraTrackSwitch").choice !== "fixedCamera") return;
        const input = this.el(id);
        if (input.value === "" || !input.checkValidity()) {
            this.el("locationMessage").textContent = "Invalid latitude or longitude";
            return;
        }
        this.locationTicket = (this.locationTicket ?? 0) + 1;
        // Display precision must not change the untouched coordinates.
        const lla = this.observer._LLA.slice();
        const index = ["lat", "lon"].indexOf(id);
        const value = input.valueAsNumber;
        if (lla[index] !== value) {
            lla[index] = value;
            this.observer.gotoLLA(...lla, this.observer.agl);
        }
        this.el("locationMessage").textContent = "";
        this.sync();
    }

    async findLocation() {
        if (NodeMan.get("cameraTrackSwitch").choice !== "fixedCamera") return;
        const query = this.el("search").value.trim();
        if (!query) return;
        const ticket = this.locationTicket = (this.locationTicket ?? 0) + 1;
        this.pendingLocation = ticket;
        this.el("go").disabled = true;
        this.el("locationMessage").textContent = "Finding location…";
        try {
            const result = await resolveLocationString(query);
            if (this.disposed || ticket !== this.locationTicket || NodeMan.get("cameraTrackSwitch").choice !== "fixedCamera") return;
            if (!result) {
                this.el("locationMessage").textContent = "Location not found";
                return;
            }
            this.observer.gotoLLA(result.lat, result.lon, result.alt ?? 2, result.alt === undefined);
            this.el("locationMessage").textContent = "Observer moved to " + query;
            this.sync();
        } catch (error) {
            if (!this.disposed && ticket === this.locationTicket) this.el("locationMessage").textContent = "Location lookup failed";
        } finally {
            if (!this.disposed && this.pendingLocation === ticket) {
                this.pendingLocation = null;
                this.sync();
            }
        }
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
        if (!this.widgets) for (const gui of this.controlGroups.values()) setNativeControlGroupActive(gui, this.visible && this.expanded);
        this.layoutPanel();
    }

    layoutPanel() {
        const top = ViewMan.container.getBoundingClientRect().top + ViewMan.topPx;
        this.launcher.style.top = (top + 12) + "px";
        this.widgets?.updateVisibility();
        setRenderOne(true);
    }

    syncValue(input, value) {
        if (document.activeElement !== input && input.value !== String(value)) input.value = value;
    }

    sync() {
        if (this.disposed) return;
        // The TLE epoch/range stats belong to the large sky view in this layout,
        // even when the sidebar itself is hidden or collapsed.
        NodeMan.get("labelMainViewPVS", false)?.setOverlayView(this.skyOverviewLayout ? this.look : this.main);
        if (!this.visible) return;
        this.widgets?.setVisible(this.visible, this.expanded);
        const dt = this.dateTime, sky = this.sky, sats = sky.satellites;
        const live = dt.liveMode;
        const status = live ? "LIVE" : par.paused ? "PAUSED" : "PLAYING";
        const speed = (Sit.simSpeed ?? 1) * (par.playbackSpeed ?? 1);
        for (const action of ["sky", "split"]) {
            const pressed = action === "sky" ? this.skyOverviewLayout : this.look.width === 0.5 && this.main.width === 0.5;
            (this.widgets?.instances.get("viewLayout").body.querySelector(`[data-action="${action}"]`) ?? this.panel.querySelector(`[data-action="${action}"]`)).setAttribute("aria-pressed", String(pressed));
        }
        const fixed = NodeMan.get("cameraTrackSwitch").choice === "fixedCamera";
        ["lat", "lon"].forEach((id, i) => {
            this.syncValue(this.el(id), Number(this.observer._LLA[i].toFixed(5)));
            this.el(id).disabled = !fixed;
        });
        this.el("altitudeControls").inert = !fixed;
        this.el("altitudeControls").setAttribute("aria-disabled", String(!fixed));
        this.el("heightRef").value = this.observer.agl ? "agl" : "msl";
        for (const id of ["heightRef", "search"]) this.el(id).disabled = !fixed;
        this.el("go").disabled = !fixed || !!this.pendingLocation;
        this.el("observerNote").textContent = fixed ? "" : "Track-controlled observer";
        this.el("locationControls").title = fixed ? "" : "Use Camera → Location → Manual to edit the observer position.";
        this.widgets?.updateVisibility();
        const photometric = sats.brightnessModel === "Photometric estimate";
        this.el("magnitudeControls").title = photometric ? "Lower magnitudes show brighter satellites only. Visibility is estimated." : "Magnitude requires the Photometric estimate model in Satellites.";
        const manual = NodeMan.get("CameraLOSController").choice === "Manual";
        this.el("cameraControls").title = manual ? "Drag the sky to aim; scroll to zoom." : "Direction follows the selected Camera heading source.";
        this.hudEl("heading").textContent = `${compassHeading(this.ptz.az)} · El ${this.ptz.el.toFixed(1)}° · VFOV ${this.ptz.fov.toFixed(1)}°`;
        this.hudEl("clock").textContent = viewingDateInput(dt.dateNow).replace("T", " ") + " UTC";
        this.hudEl("clockState").textContent = status + (live ? "" : ` · ${speed}×`);
        this.el("loadDate").textContent = "Viewing date: " + viewingDateInput(dt.dateNow).slice(0, 10) + " UTC";
        if (!this.lastStats || performance.now() - this.lastStats > 1000) {
            this.lastStats = performance.now();
            this.syncSatellites();
        }
    }

    syncSatellites() {
        const sky = this.sky, sats = sky.satellites, data = sats.renderTLEData;
        this.el("dataStatus").style.color = data?.simulated ? SIMULATED_SATELLITE_COLOR : "";
        if (!data) {
            this.hudEl("count").textContent = "No orbit data loaded";
            this.hudEl("count").title = "";
            this.el("filterStatus").textContent = "";
            this.el("filterStatus").title = "";
            this.el("dataStatus").classList.remove("sl-warning");
            this.el("dataStatus").textContent = "No orbit data loaded";
            this.el("dataStatus").title = "Use current data for live viewing, or load data for a historical date.";
            return;
        }
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
        const searchActive = !!sats.nameFilter.trim();
        const tleActive = !!sats.tleFilterResults && !data.simulated;
        const filterStatus = searchActive || tleActive
            ? `${matching.toLocaleString()} match${tleActive ? " · TLE filter active" : ""}` : "";
        if (this.el("filterStatus").textContent !== filterStatus) this.el("filterStatus").textContent = filterStatus;
        this.el("filterStatus").title = [searchActive ? "Clear search to remove the name/NORAD filter." : "", tleActive ? "Use Clear TLE Filter to remove the orbit filter." : ""].filter(Boolean).join(" ");
        this.hudEl("count").textContent = `${inView.toLocaleString()} ${data.simulated ? "simulated satellites" : "satellite points"} in view`;
        this.hudEl("count").title = "Modeled points inside the camera view after category, search, brightness, and Earth-horizon filtering. Terrain and daylight can obscure them.";
        if (data.simulated) {
            this.el("dataStatus").classList.remove("sl-warning");
            this.el("dataStatus").textContent = `${data.satData.length.toLocaleString()} simulated Starlink · ${matching.toLocaleString()} match`;
            this.el("dataStatus").title = SIMULATED_SATELLITE_DESCRIPTION + (sats.TLEData?.satData.length
                ? " Loaded orbit data is out of range; it returns automatically when in range."
                : " No orbit data is loaded.") + (sats.tleFilterResults ? " The saved TLE filter applies only to loaded orbit data." : "");
            return;
        }
        const start = data.startDate, end = data.endDate;
        const haveDates = start instanceof Date && end instanceof Date && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime());
        const outside = haveDates && (this.dateTime.dateNow < start || this.dateTime.dateNow > end);
        this.el("dataStatus").classList.toggle("sl-warning", outside);
        this.el("dataStatus").textContent = `${data.satData.length.toLocaleString()} loaded · ${matching.toLocaleString()} match${outside ? " · Extrapolated" : ""}`;
        this.el("dataStatus").title = haveDates ? `Orbit epochs: ${viewingDateInput(start).replace("T", " ")} to ${viewingDateInput(end).replace("T", " ")} UTC.${outside ? " Viewing time is outside these epochs; positions are extrapolated." : ""}` : "";
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
        for (const gui of this.controlGroups.values()) gui.destroy();
        this.controlGroups.clear();
        this.elements.clear();
        window.removeEventListener("resize", this.onResize);
        this.panel.remove();
        this.launcher.remove();
        this.hud.remove();
        this.style.remove();
        super.dispose();
    }
}
