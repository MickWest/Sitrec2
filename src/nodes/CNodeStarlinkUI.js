import {Vector3} from "three";
import {CNode} from "./CNode";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {ViewMan} from "../CViewManager";
import {setToolPanel} from "../PageStructure";
import {resolveLocationString} from "../CoordinateInput";
import {rayIntersectsEllipsoid} from "../threeExt";
import {getAzElFromPositionAndForward} from "../SphericalMath";
import {withDisplayedCamera} from "../ViewUtils";
import {fisheyeProjectVector} from "../FisheyeProjection";
import {panoramicProjectVector} from "../PanoramicCamera";
import {compassHeading, parseViewingDate, viewingDateInput} from "../StarlinkViewing";
import {starlinkPanelStyle} from "../StarlinkPanelStyle";

// Shared custom-scene viewing controls. The Starlink preset opts into the initial
// sky layout; other scenes retain their layout. Controls start invisible.
// All scientific state stays in the existing nodes.
export class CNodeStarlinkUI extends CNode {
    constructor(v) {
        super(v);
        this.utc = true;
        this.visible = v.visible ?? false;
        this.expanded = v.expanded ?? window.innerWidth > 760;
        this.addSimpleSerial("utc");
        this.addSimpleSerial("expanded");
        this.bindings = [];
        this.disposed = false;
        this.style = document.createElement("style");
        this.style.textContent = starlinkPanelStyle;
        document.head.append(this.style);
        this.panel = document.createElement("aside");
        this.panel.className = "starlink-panel";
        this.panel.id = "starlink-viewing-panel";
        this.panel.dataset.interactionNative = "true";
        this.panel.setAttribute("aria-label", "Starlink viewing controls");
        this.panel.innerHTML = `
            <header><div><h1>Starlink</h1><div class="sl-subtitle">Satellite observer</div></div>
                <button class="sl-close" data-action="collapse" aria-label="Collapse Starlink controls" title="Collapse controls">‹</button></header>
            <div class="sl-row sl-segments" aria-label="View layout">
                <button data-action="sky">Sky + overview</button><button data-action="split">Split views</button>
            </div>
            <section><h2>Observer location</h2>
                <form data-id="locationForm" class="sl-row"><input data-id="search" type="search" aria-label="Search observer location" placeholder="Place or coordinates…"><button type="submit" data-id="go">Go</button></form>
                <div class="sl-grid">
                    <label>Latitude<input data-id="lat" type="number" min="-90" max="90" step="any"></label>
                    <label>Longitude<input data-id="lon" type="number" min="-180" max="180" step="any"></label>
                    <label>Height (meters)<input data-id="alt" type="number" step="any"></label>
                    <label>Height reference<select data-id="heightRef"><option value="agl">Above ground</option><option value="msl">Above sea level</option></select></label>
                </div>
                <p data-id="observerNote" class="sl-muted"></p>
                <p data-id="locationMessage" class="sl-muted sl-message" role="status"></p>
            </section>
            <section><h2>Time & playback</h2>
                <div data-id="playState" class="sl-status"></div>
                <div class="sl-row sl-segments"><button data-action="live" title="Follow the current clock">● Live now</button><button data-action="utc">UTC</button><button data-action="local" title="Use the time zone selected in the Time menu">Local</button></div>
                <div data-id="dateEditor"><label data-id="zoneLabel" for="starlink-viewing-date">Viewing time · UTC</label>
                    <div class="sl-row"><input id="starlink-viewing-date" data-id="date" type="datetime-local" step="1" class="sl-date" aria-label="Viewing date and time"><button data-action="applyTime">Set</button></div>
                </div>
                <p data-id="timeMessage" class="sl-muted sl-message" role="status"></p>
                <div class="sl-row sl-segments"><button data-action="back" title="Back one minute">−1 min</button><button data-action="play" class="sl-primary" title="Play or pause" data-id="play">▶ Play</button><button data-action="forward" title="Forward one minute">+1 min</button></div>
                <div class="sl-row sl-segments" aria-label="Playback speed"><button data-speed="1">1×</button><button data-speed="5">5×</button><button data-speed="10">10×</button><button data-speed="60">60×</button></div>
                <p data-id="speedNote" class="sl-muted"></p>
            </section>
            <section><h2>Satellites</h2>
                <input data-id="filter" type="search" aria-label="Filter loaded satellites" placeholder="Filter name or NORAD number…" style="width:100%">
                <p data-id="filterStatus" class="sl-muted sl-message" role="status"></p>
                <div class="sl-checks" data-id="categories"></div>
                <div class="sl-range-label"><label class="sl-check"><input data-id="limit" type="checkbox">Magnitude limit</label><output data-id="magnitudeValue"></output></div>
                <input data-id="magnitude" type="range" min="-5" max="20" step="0.1" aria-label="Satellite magnitude limit">
                <p data-id="magnitudeNote" class="sl-muted">Lower = brighter only · estimated visibility</p>
                <div class="sl-checks" data-id="satelliteToggles"></div>
            </section>
            <section><h2>Look direction</h2>
                <button data-action="aim" title="Look toward the Sun's azimuth, 10 degrees above the horizon">Look toward flare band</button>
                <div data-id="angles"></div>
                <p data-id="aimNote" class="sl-muted">Drag sky · scroll to zoom</p>
            </section>
            <details><summary>Sky guides</summary><div class="sl-checks" data-id="guides"></div></details>
            <details><summary>Orbit data</summary>
                <p data-id="dataStatus" class="sl-muted sl-data"></p>
                <div class="sl-row"><button data-action="refresh">Load current Starlink</button></div>
                <div class="sl-row"><button data-action="dated">Load LEO for this date</button></div>
                <p class="sl-muted">Historical times need orbit data near the viewing date. More catalogs and saved sessions are in Satellites and File.</p>
            </details>`;
        document.body.append(this.panel);
        this.launcher = document.createElement("button");
        this.launcher.className = "starlink-launcher";
        this.launcher.textContent = "☰ Starlink controls";
        this.launcher.setAttribute("aria-controls", this.panel.id);
        this.launcher.onclick = () => this.setExpanded(true);
        document.body.append(this.launcher);
        this.hud = document.createElement("div");
        this.hud.className = "starlink-hud";
        this.hud.innerHTML = `<div class="sl-hud-block"><strong data-id="count">Loading satellites…</strong><small data-id="heading"></small></div><div class="sl-hud-block sl-hud-time"><strong data-id="clock"></strong><small data-id="clockState"></small></div>`;
        this.look = NodeMan.get("lookView");
        this.main = NodeMan.get("mainView");
        if (v.startSkyLayout && !Sit.mods?.mainView && !Sit.mods?.lookView) this.setViewLayout(false);
        this.look.div.append(this.hud);

        const sky = this.sky;
        const sats = sky.satellites;
        this.toggle("categories", "Starlink", sats, "showStarlink");
        this.toggle("categories", "Other loaded", sats, "showOtherSatellites");
        this.toggle("categories", "ISS", sats, "showISS");
        this.toggle("categories", "Brightest", sats, "showBrightest");
        this.toggle("satelliteToggles", "Show satellites", sats, "showSatellites");
        this.toggle("satelliteToggles", "Names", sats, "showSatelliteNames");
        this.toggle("guides", "Constellations", sky, "showConstellationsLook");
        this.toggle("guides", "Star names", NodeMan.get("lookView_NightSkyOverlay"), "showStarNames");
        this.toggle("guides", "Celestial grid", sky, "showEquatorialGridLook");
        this.toggle("guides", "Horizon compass", sky, "showHorizonCompassRibbonLook");
        this.toggle("guides", "Flare band", sky, "showFlareBand");
        this.toggle("guides", "Sun arrows", sky, "showSunArrows");
        this.angle("az", "Azimuth · true", 0, 360);
        this.angle("el", "Elevation", -89, 89);
        this.angle("fov", "Vertical field of view", 0.01, 170);

        this.panel.addEventListener("click", event => {
            const button = event.target.closest("button");
            if (button?.dataset.action) this.action(button.dataset.action);
            if (button?.dataset.speed) {
                this.setControl(Sit, "simSpeed", Number(button.dataset.speed));
                par.speed = 1;
                this.sync();
            }
        });
        // Native date inputs and buttons must not also trigger scene shortcuts.
        for (const type of ["keydown", "keyup"]) this.panel.addEventListener(type, e => e.stopPropagation());
        this.el("locationForm").onsubmit = e => { e.preventDefault(); this.findLocation(); };
        for (const id of ["lat", "lon", "alt"]) this.el(id).onchange = () => this.setLocation();
        this.el("heightRef").onchange = () => {
            this.setControl(this.observer, "agl", this.el("heightRef").value === "agl");
            this.sync();
        };
        this.el("filter").oninput = () => this.setControl(sats, "nameFilter", this.el("filter").value);
        this.el("limit").onchange = () => this.setControl(sky, "satelliteMagnitudeLimitEnabled", this.el("limit").checked);
        this.el("magnitude").oninput = () => this.setControl(sky, "satelliteMagnitudeLimit", this.el("magnitude").valueAsNumber);
        this.onResize = () => this.layoutPanel();
        window.addEventListener("resize", this.onResize);
        this.gui = guiMenus.view;
        this.gui.add(this, "visible").name("Starlink Viewing Controls").listen().onChange(v => {
            this.show(v);
            if (this.gui.mode === "DOCKED") this.gui.close();
            markSitchDirty();
        });
        this.show(this.visible);
        // Paused scenes sleep their render loop. UI still needs to follow menu edits.
        this.timer = setInterval(() => this.sync(), 250);
    }

    get sky() { return NodeMan.get("NightSkyNode"); }
    get dateTime() { return NodeMan.get("dateTimeStart"); }
    get observer() { return NodeMan.get("fixedCameraPosition"); }
    get ptz() { return NodeMan.get("ptzAngles"); }
    el(id) { return this.panel.querySelector(`[data-id="${id}"]`); }
    hudEl(id) { return this.hud.querySelector(`[data-id="${id}"]`); }

    setControl(object, property, value) {
        // Reuse callbacks for filtering, units, graph invalidation and serialization.
        for (const gui of Object.values(guiMenus)) {
            const controller = gui.controllersRecursive?.().find(c => c.object === object && c.property === property);
            if (controller) {
                controller.setValue(value);
                markSitchDirty();
                setRenderOne(true);
                return;
            }
        }
    }

    toggle(container, text, object, property) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.setting = property;
        label.append(input, document.createTextNode(text));
        this.el(container).append(label);
        input.onchange = () => this.setControl(object, property, input.checked);
        this.bindings.push({input, object, property});
    }

    angle(property, labelText, min, max) {
        const row = document.createElement("div");
        row.innerHTML = `<label class="sl-range-label">${labelText}<input type="number" min="${min}" max="${max}" step="any" aria-label="${labelText} in degrees"></label><input type="range" min="${min}" max="${max}" step="0.01" aria-label="${labelText}">`;
        this.el("angles").append(row);
        const [number, range] = row.querySelectorAll("input");
        const change = input => {
            if (input.value === "" || !input.checkValidity()) return;
            this.ptz[property] = input.valueAsNumber;
            this.ptz.refresh();
            markSitchDirty();
            setRenderOne(true);
            this.sync();
        };
        number.onchange = () => change(number);
        range.oninput = () => change(range);
        this.bindings.push({input: number, object: this.ptz, property, angle: true});
        this.bindings.push({input: range, object: this.ptz, property, angle: true});
    }

    action(action) {
        const dt = this.dateTime;
        if (action === "collapse") this.setExpanded(false);
        if (action === "sky" || action === "split") {
            if (ViewMan.fullscreenView) ViewMan.fullscreenView.doubleClick();
            const split = action === "split";
            this.setViewLayout(split);
            this.look.setVisible(true);
            this.main.setVisible(true);
            markSitchDirty();
        }
        if (action === "utc" || action === "local") {
            this.utc = action === "utc";
            this.el("date").value = viewingDateInput(dt.dateNow, this.utc ? 0 : dt.getTimeZoneOffset());
            markSitchDirty();
        }
        if (action === "applyTime") {
            const date = parseViewingDate(this.el("date").value, this.utc ? 0 : dt.getTimeZoneOffset());
            if (!date) this.el("timeMessage").textContent = "Enter a complete, valid date and time.";
            else { this.setTime(date); this.el("timeMessage").textContent = ""; }
        }
        if (action === "back" || action === "forward") this.setTime(new Date(dt.dateNow.getTime() + (action === "back" ? -60000 : 60000)));
        if (action === "live") {
            dt.liveMode = true;
            par.paused = true;
            dt.setNowDateTime(new Date(), true);
            dt.recalculateCascade();
        }
        if (action === "play") {
            if (dt.liveMode) { dt.liveMode = false; par.paused = true; }
            else { par.paused = !par.paused; par.direction = 1; }
        }
        if (action === "aim") {
            const [az] = getAzElFromPositionAndForward(this.look.camera.position, this.sky.satellites.toSun);
            this.setControl(NodeMan.get("CameraLOSController"), "choice", "Manual");
            this.ptz.az = az;
            this.ptz.el = 10;
            this.ptz.refresh();
            markSitchDirty();
        }
        if (action === "refresh") this.sky.satellites.updateStarlink();
        if (action === "dated") this.sky.satellites.updateLEOSats();
        setRenderOne(true);
        this.sync();
    }

    setTime(date) {
        par.paused = true;
        this.dateTime.setNowDateTime(date);
        this.dateTime.recalculateCascade();
        markSitchDirty();
        setRenderOne(true);
    }

    setViewLayout(split) {
        Object.assign(this.look, {left: split ? 0.5 : 0, top: 0, width: split ? 0.5 : 1, height: 1});
        Object.assign(this.main, {left: split ? 0 : 0.74, top: split ? 0 : 0.72, width: split ? 0.5 : 0.26, height: split ? 1 : 0.28});
    }

    setLocation() {
        if (NodeMan.get("cameraTrackSwitch").choice !== "fixedCamera") return;
        const inputs = ["lat", "lon", "alt"].map(id => this.el(id));
        if (inputs.some(input => input.value === "" || !input.checkValidity())) {
            this.el("locationMessage").textContent = "Enter a latitude (−90 to 90), longitude (−180 to 180), and height.";
            return;
        }
        this.locationTicket = (this.locationTicket ?? 0) + 1;
        this.observer.gotoLLA(...inputs.map(input => input.valueAsNumber), this.observer.agl);
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
                this.el("locationMessage").textContent = "No location found. Try a place name or latitude, longitude.";
                return;
            }
            this.observer.gotoLLA(result.lat, result.lon, result.alt ?? 2, result.alt === undefined);
            this.el("locationMessage").textContent = "Observer moved to " + query;
            this.sync();
        } catch (error) {
            if (!this.disposed && ticket === this.locationTicket) this.el("locationMessage").textContent = "Location lookup failed. Coordinates can also be entered directly.";
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
        this.expanded = expanded;
        this.updateVisibility();
        markSitchDirty();
    }

    updateVisibility() {
        this.panel.hidden = !this.visible || !this.expanded;
        this.launcher.hidden = !this.visible || this.expanded;
        this.hud.hidden = !this.visible;
        this.launcher.setAttribute("aria-expanded", String(this.expanded));
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
        if (this.disposed || !this.visible) return;
        const dt = this.dateTime, sky = this.sky, sats = sky.satellites;
        const live = dt.liveMode;
        const status = live ? "LIVE · following current time" : par.paused ? "PAUSED" : "PLAYING";
        this.el("playState").textContent = status;
        this.el("play").textContent = live || !par.paused ? "Ⅱ Pause" : "▶ Play";
        this.el("play").setAttribute("aria-label", live || !par.paused ? "Pause" : "Play");
        this.el("zoneLabel").textContent = "Viewing time · " + (this.utc ? "UTC" : dt.getTimeZoneName());
        if (!this.el("dateEditor").contains(document.activeElement)) this.syncValue(this.el("date"), viewingDateInput(dt.dateNow, this.utc ? 0 : dt.getTimeZoneOffset()));
        const speed = (Sit.simSpeed ?? 1) * (par.speed ?? 1);
        this.el("speedNote").textContent = !live && ![1, 5, 10, 60].includes(speed) ? `${speed}× playback` : "";
        for (const button of this.panel.querySelectorAll("[data-speed]")) button.setAttribute("aria-pressed", String(!live && Number(button.dataset.speed) === speed));
        for (const action of ["utc", "local", "live", "sky", "split"]) {
            const pressed = action === "utc" ? this.utc : action === "local" ? !this.utc : action === "live" ? live : action === "sky" ? this.look.width > 0.9 && this.main.height < 0.5 : this.look.width === 0.5 && this.main.width === 0.5;
            this.panel.querySelector(`[data-action="${action}"]`).setAttribute("aria-pressed", String(pressed));
        }
        const fixed = NodeMan.get("cameraTrackSwitch").choice === "fixedCamera";
        ["lat", "lon", "alt"].forEach((id, i) => {
            this.syncValue(this.el(id), Number(this.observer._LLA[i].toFixed(i === 2 ? 2 : 5)));
            this.el(id).disabled = !fixed;
        });
        this.el("heightRef").value = this.observer.agl ? "agl" : "msl";
        for (const id of ["heightRef", "search"]) this.el(id).disabled = !fixed;
        this.el("go").disabled = !fixed || !!this.pendingLocation;
        this.el("observerNote").textContent = fixed ? "" : "Observer follows a track. Use Camera → Location to switch to fixed.";
        this.syncValue(this.el("filter"), sats.nameFilter);
        this.el("limit").checked = sky.satelliteMagnitudeLimitEnabled;
        const photometric = sats.brightnessModel === "Photometric estimate";
        this.el("limit").disabled = !photometric;
        this.el("magnitude").disabled = !photometric || !sky.satelliteMagnitudeLimitEnabled;
        this.syncValue(this.el("magnitude"), sky.satelliteMagnitudeLimit);
        this.el("magnitudeValue").textContent = sky.satelliteMagnitudeLimitEnabled ? sky.satelliteMagnitudeLimit.toFixed(1) + " mag" : "No limit";
        this.el("magnitudeNote").textContent = photometric ? "Lower = brighter only · estimated visibility" : "Magnitude requires the Photometric estimate model in Satellites.";
        const manual = NodeMan.get("CameraLOSController").choice === "Manual";
        for (const {input, object, property, angle} of this.bindings) {
            if (input.type === "checkbox") input.checked = object[property];
            else {
                const value = property === "az" ? ((object[property] % 360) + 360) % 360 : object[property];
                this.syncValue(input, Number(value.toFixed(property === "fov" && value < 1 ? 4 : 1)));
                if (angle) input.disabled = !manual;
            }
        }
        this.el("aimNote").textContent = manual ? "Drag sky · scroll to zoom" : "Direction follows the selected Camera heading source.";
        this.hudEl("heading").textContent = `${compassHeading(this.ptz.az)} · El ${this.ptz.el.toFixed(1)}° · VFOV ${this.ptz.fov.toFixed(1)}°`;
        this.hudEl("clock").textContent = viewingDateInput(dt.dateNow).replace("T", " ") + " UTC";
        this.hudEl("clockState").textContent = status + (live ? "" : ` · ${speed}×`);
        if (!this.lastStats || performance.now() - this.lastStats > 1000) {
            this.lastStats = performance.now();
            this.syncSatellites();
        }
    }

    syncSatellites() {
        const sky = this.sky, sats = sky.satellites, data = sats.TLEData;
        if (!data) {
            this.hudEl("count").textContent = "No orbit data loaded";
            this.el("dataStatus").textContent = "Load current Starlink or orbit data for the selected date.";
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
        const filterStatus = sats.nameFilter.trim() ? `${matching.toLocaleString()} match the enabled categories · clear search to reset` : "";
        if (this.el("filterStatus").textContent !== filterStatus) this.el("filterStatus").textContent = filterStatus;
        this.hudEl("count").textContent = `${inView.toLocaleString()} satellite points in view`;
        this.hudEl("count").title = "Modeled points inside the camera view after category, search, brightness, and Earth-horizon filtering. Terrain and daylight can obscure them.";
        const start = data.startDate, end = data.endDate;
        const haveDates = start instanceof Date && end instanceof Date && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime());
        const outside = haveDates && (this.dateTime.dateNow < start || this.dateTime.dateNow > end);
        this.el("dataStatus").classList.toggle("sl-warning", outside);
        this.el("dataStatus").textContent = `${data.satData.length.toLocaleString()} loaded · ${matching.toLocaleString()} match filters. ` + (haveDates ? `Orbit epochs: ${viewingDateInput(start).replace("T", " ")} to ${viewingDateInput(end).replace("T", " ")} UTC.${outside ? " Viewing time is outside these epochs; positions are extrapolated." : ""}` : "");
        this.el("playState").classList.toggle("sl-warning", outside && !this.dateTime.liveMode);
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.show(this.visible);
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        window.removeEventListener("resize", this.onResize);
        setToolPanel(null);
        this.panel.remove();
        this.launcher.remove();
        this.hud.remove();
        this.style.remove();
        super.dispose();
    }
}
