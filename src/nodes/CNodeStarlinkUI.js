import {SIMULATED_SATELLITE_COLOR, SIMULATED_SATELLITE_DESCRIPTION} from "../SatelliteSimulation";
import {Vector3} from "three";
import {CNode} from "./CNode";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {ViewMan} from "../CViewManager";
import {setToolPanel} from "../PageStructure";
import {resolveLocationString} from "../CoordinateInput";
import {rayIntersectsEllipsoid} from "../threeExt";
import {withDisplayedCamera} from "../ViewUtils";
import {fisheyeProjectVector} from "../FisheyeProjection";
import {panoramicProjectVector} from "../PanoramicCamera";
import {compassHeading, viewingDateInput} from "../StarlinkViewing";
import {createControlGroup, setControlGroupActive} from "../ModernControls";
import {disableFreeLook} from "../FreeLookGuard";
import {starlinkPanelStyle} from "../StarlinkPanelStyle";

const PANEL_NAME = "Satellite Controls";

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
        this.sourceControls = [...new Set(Object.values(guiMenus).flatMap(gui => gui.controllersRecursive?.() ?? []))];
        this.disposed = false;
        this.style = document.createElement("style");
        this.style.textContent = starlinkPanelStyle;
        document.head.append(this.style);
        this.panel = document.createElement("aside");
        this.panel.className = "starlink-panel sitrec-modern";
        this.panel.id = "starlink-viewing-panel";
        this.panel.dataset.interactionNative = "true";
        this.panel.setAttribute("aria-label", PANEL_NAME);
        this.panel.innerHTML = `
            <header><h1 title="Satellite observer controls">${PANEL_NAME}</h1>
                <button class="sl-close" data-action="collapse" aria-label="Collapse ${PANEL_NAME}" title="Collapse controls">‹</button></header>
            <section data-id="timeControls"><h2>Time & playback</h2><div data-id="timeEditor"></div></section>
            <section data-id="locationControls"><h2>Observer location</h2>
                <form data-id="locationForm" class="sl-row"><input data-id="search" type="search" aria-label="Search observer location" placeholder="Place or coordinates…" title="Enter a place name or latitude, longitude."><button type="submit" data-id="go">Go</button></form>
                <div class="sl-grid">
                    <label>Latitude<input data-id="lat" type="number" min="-90" max="90" step="any" title="Latitude in degrees, from −90 to 90."></label>
                    <label>Longitude<input data-id="lon" type="number" min="-180" max="180" step="any" title="Longitude in degrees, from −180 to 180."></label>
                    <div data-id="altitudeControls"></div>
                    <label>Altitude reference<select data-id="heightRef" title="Measure altitude above the terrain or mean sea level."><option value="agl">Above ground</option><option value="msl">Above sea level</option></select></label>
                </div>
                <p data-id="observerNote" class="sl-muted"></p>
                <p data-id="locationMessage" class="sl-muted sl-message" role="status"></p>
            </section>
            <section data-id="viewControls"><h2>View adjustments</h2>
                <div data-id="aimControl"></div>
                <details data-id="cameraControls"><summary>Camera direction & zoom</summary>
                    <div data-id="angles"></div><div data-id="zoom"></div>
                </details>
                <div class="sl-row sl-segments" aria-label="View layout">
                    <button data-action="sky">Sky + overview</button><button data-action="split">Split views</button>
                </div>
            </section>
            <section data-id="orbitControls"><h2>Satellite data</h2>
                <div data-id="loaders"></div>
                <p data-id="dataStatus" class="sl-muted sl-data"></p>
            </section>
            <section data-id="satelliteControls"><h2>Satellites</h2>
                <div data-id="filterControls"></div>
                <p data-id="filterStatus" class="sl-muted sl-message" role="status"></p>
                <div data-id="categories"></div>
                <div data-id="magnitudeControls"></div>
                <div data-id="satelliteToggles"></div>
            </section>
            <section data-id="flareControls" title="Flare Band marks observing locations on Earth. Flare Region marks where to look in the sky."><h2>Flares</h2>
                <div data-id="flareGuides"></div>
            </section>
            <details><summary>Sky guides</summary><div data-id="guides"></div></details>`;
        document.body.append(this.panel);
        this.timeEditor = this.dateTime.createTimeEditor(this.el("timeEditor"));
        this.launcher = document.createElement("button");
        this.launcher.className = "starlink-launcher sitrec-modern";
        this.launcher.textContent = `☰ ${PANEL_NAME}`;
        this.launcher.setAttribute("aria-controls", this.panel.id);
        this.launcher.onclick = () => this.setExpanded(true);
        document.body.append(this.launcher);
        this.hud = document.createElement("div");
        this.hud.className = "starlink-hud sitrec-modern";
        this.hud.innerHTML = `<div class="sl-hud-block"><strong data-id="count">Loading satellites…</strong><small data-id="heading"></small></div><div class="sl-hud-block sl-hud-time"><strong data-id="clock"></strong><small data-id="clockState"></small></div>`;
        this.look = NodeMan.get("lookView");
        this.main = NodeMan.get("mainView");
        if (v.startSkyLayout && !Sit.mods?.mainView && !Sit.mods?.lookView) this.setViewLayout(false);
        this.look.div.append(this.hud);

        const sky = this.sky;
        const sats = sky.satellites;
        this.observer.guiAlt.guiEntry.mirrorTo(this.group("altitudeControls"), {
            name: "Altitude", unitLabel: true, listen: true,
        }).noSlider();
        this.control("filterControls", sats, "nameFilter");
        for (const property of ["filterTLEs", "clearTLEFilter"]) {
            this.sourceControls.find(controller => controller.property === property)?.mirrorTo(this.group("filterControls"));
        }
        this.control("magnitudeControls", sky, "satelliteMagnitudeLimitEnabled");
        this.control("magnitudeControls", sky, "satelliteMagnitudeLimit");
        for (const property of ["showStarlink", "showOtherSatellites", "showISS", "showBrightest"]) {
            this.control("categories", sats, property);
        }
        this.group("categories").domElement.classList.add("modern-grid");
        this.control("satelliteToggles", sats, "showSatellites");
        this.control("satelliteToggles", sats, "showSatelliteNames");
        this.control("guides", sky, "showConstellationsLook");
        this.control("guides", NodeMan.get("lookView_NightSkyOverlay"), "showStarNames");
        this.control("guides", sky, "showEquatorialGridLook");
        this.control("guides", sky, "showHorizonCompassRibbonLook");
        this.control("flareGuides", sky, "showSunArrows");
        this.control("flareGuides", sky, "showFlareBand");
        for (const [property, view] of [["showFlareRegionMain", "mainView"], ["showFlareRegionLook", "lookView"]]) {
            this.control("flareGuides", sky, property)?.asViewCheckbox(view, "Flare Region");
        }
        this.control("aimControl", sky, "lookTowardsFlareRegion");
        // Only show loaders configured on this installation.
        const current = this.source(sats, "updateActive") ?? this.source(sats, "updateStarlink");
        const dated = this.source(sats, "updateCustomSats") ?? this.source(sats, "updateLEOSats");
        for (const loader of [current, dated]) loader?.mirrorTo(this.group("loaders"));
        this.control("angles", NodeMan.get("CameraLOSController"), "choice");
        // These are the actual camera controls: Pan follows its signed/360 convention,
        // and FOV keeps its own source/metadata lock rather than the heading's lock.
        for (const controller of [this.ptz.azController, this.ptz.elController]) {
            controller?.mirrorTo(this.group("angles"), {listen: true});
        }
        this.ptz.fovController?.mirrorTo(this.group("zoom"), {listen: true});

        this.panel.addEventListener("click", event => {
            if (event.target.closest(".sitrec-time-editor")) return;
            const button = event.target.closest("button");
            if (button?.dataset.action) this.action(button.dataset.action);
        });
        // Native date inputs and buttons must not also trigger scene shortcuts.
        for (const type of ["keydown", "keyup"]) this.panel.addEventListener(type, e => e.stopPropagation());
        this.el("locationForm").onsubmit = e => { e.preventDefault(); this.findLocation(); };
        for (const id of ["lat", "lon"]) this.el(id).onchange = () => this.setLocation(id);
        this.el("heightRef").onchange = () => {
            this.setControl(this.observer, "agl", this.el("heightRef").value === "agl");
            this.sync();
        };
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
    el(id) { return this.panel.querySelector(`[data-id="${id}"]`); }
    hudEl(id) { return this.hud.querySelector(`[data-id="${id}"]`); }

    source(object, property) {
        return this.sourceControls.find(c => c.object === object && c.property === property);
    }

    group(id) {
        if (!this.controlGroups.has(id)) {
            this.controlGroups.set(id, createControlGroup(this.el(id), {
                beforeEdit: id === "angles" ? disableFreeLook : undefined,
                onChange: () => {
                    if (id === "altitudeControls") this.locationTicket = (this.locationTicket ?? 0) + 1;
                    markSitchDirty(); setRenderOne(true);
                },
            }));
        }
        return this.controlGroups.get(id);
    }

    control(container, object, property) {
        const source = this.source(object, property);
        const twin = source?.mirrorTo(this.group(container), {listen: true});
        if (twin?.$input?.type === "checkbox") twin.asListCheckbox();
        return twin;
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
            const target = expanded ? this.panel.querySelector('[data-action="collapse"]') : this.launcher;
            target.focus({preventScroll: true});
        }
        markSitchDirty();
    }

    updateVisibility() {
        this.panel.hidden = !this.visible || !this.expanded;
        this.launcher.hidden = !this.visible || this.expanded;
        this.hud.hidden = !this.visible;
        this.launcher.setAttribute("aria-expanded", String(this.expanded));
        for (const gui of this.controlGroups.values()) setControlGroupActive(gui, this.visible && this.expanded);
        this.layoutPanel();
    }

    layoutPanel() {
        const top = ViewMan.container.getBoundingClientRect().top + ViewMan.topPx;
        this.panel.style.top = top + "px";
        this.launcher.style.top = (top + 12) + "px";
        setToolPanel(this.panel, this.visible && this.expanded && window.innerWidth > 760 ? 300 : 0);
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
        const dt = this.dateTime, sky = this.sky, sats = sky.satellites;
        const live = dt.liveMode;
        const status = live ? "LIVE" : par.paused ? "PAUSED" : "PLAYING";
        const speed = (Sit.simSpeed ?? 1) * (par.playbackSpeed ?? 1);
        for (const action of ["sky", "split"]) {
            const pressed = action === "sky" ? this.skyOverviewLayout : this.look.width === 0.5 && this.main.width === 0.5;
            this.panel.querySelector(`[data-action="${action}"]`).setAttribute("aria-pressed", String(pressed));
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
        this.el("locationControls").title = fixed ? "" : "Use Camera → Location to switch to a fixed observer.";
        if (this.expanded) for (const gui of this.controlGroups.values()) gui.updateListeners();
        const photometric = sats.brightnessModel === "Photometric estimate";
        this.el("magnitudeControls").title = photometric ? "Lower magnitudes show brighter satellites only. Visibility is estimated." : "Magnitude requires the Photometric estimate model in Satellites.";
        const manual = NodeMan.get("CameraLOSController").choice === "Manual";
        this.el("cameraControls").title = manual ? "Drag the sky to aim; scroll to zoom." : "Direction follows the selected Camera heading source.";
        this.hudEl("heading").textContent = `${compassHeading(this.ptz.az)} · El ${this.ptz.el.toFixed(1)}° · VFOV ${this.ptz.fov.toFixed(1)}°`;
        this.hudEl("clock").textContent = viewingDateInput(dt.dateNow).replace("T", " ") + " UTC";
        this.hudEl("clockState").textContent = status + (live ? "" : ` · ${speed}×`);
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

    modDeserialize(v) {
        super.modDeserialize(v);
        this.show(this.visible);
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        this.timeEditor.dispose();
        for (const gui of this.controlGroups.values()) gui.destroy();
        this.controlGroups.clear();
        this.sourceControls.length = 0;
        window.removeEventListener("resize", this.onResize);
        setToolPanel(null);
        this.panel.remove();
        this.launcher.remove();
        this.hud.remove();
        this.style.remove();
        super.dispose();
    }
}
