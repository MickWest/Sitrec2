import {AdditiveBlending, BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, Matrix4, Vector3} from "three";
import {markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {MetaBezierCurveEditor} from "../MetaCurveEdit";
import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {getInteractionRouter} from "../InteractionRouter";
import {blockViewEvents} from "../DragResizeUtils";
import {RefractionPass} from "./RefractionPass";
import {applyProfilePreset, atmosphere, clamp, defaultLaser, groundY, normalizeCurve, normalizeSettings,
    PROFILE_PRESETS, PROFILE_PRESET_DETAILS} from "./RefractionPhysics";
import "./refraction.css";

function element(tag, className, text, parent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    parent?.appendChild(el);
    return el;
}

// Saved profiles remain [height, value]; only the editor uses [value, height].
const swapAxes = curve => curve.flatMap((value, i) => i % 2 ? [] : [curve[i + 1], value]);

export class RefractionTool {
    constructor() {
        this.settings = Sit.raytracedRefraction = normalizeSettings(Sit.raytracedRefraction);
        this.opticalRevision = 0;
        this.controls = [];
        this.editors = [];
        this.laserGroup = new Group();
        this.laserGroup.name = "Refraction laser paths";
        this.laserGroup.layers.enableAll();
        this.laserGroup.visible = false;
        GlobalScene.add(this.laserGroup);
        this.sync();
    }

    sync() {
        // One explicitly selected view pays for ray tracing. Other views keep
        // their existing analytic atmosphere; begin() restores its flags before
        // another view renders. mainView is selectable here just like lookView.
        const candidate = NodeMan.get(this.settings.view, false);
        const view = candidate?.renderTargetAndEffects ? candidate : null;
        if (this.view !== view || !this.settings.enabled) this.releasePass();
        this.view = view;
        if (this.settings.enabled && view && !this.pass) {
            try {
                this.pass = new RefractionPass(this);
                view.raytracedRefraction = this.pass;
            } catch (error) {
                this.settings.enabled = false;
                this.status(`Refraction could not start: ${error.message}`);
            }
        }
        if (this.settings.enabled && !view) this.status("Choose an available 3D view.");
        this.laserGroup.visible = !!(this.settings.enabled && this.settings.lasersEnabled && this.result);
        for (const refresh of this.controls) refresh();
        setRenderOne(true);
    }

    releasePass() {
        if (this.view && this.view.raytracedRefraction === this.pass) delete this.view.raytracedRefraction;
        this.pass?.dispose();
        this.pass = null;
    }

    changed(optical = true) {
        markSitchDirty();
        if (optical) {
            this.opticalRevision++;
            this.medium = null;
        }
        this.sideDirty = true;
        this.sync();
    }

    setEditing(editing) {
        this.editing = editing;
        setRenderOne(true);
    }

    status(text) {
        this.statusText = text;
        if (this.statusElement) this.statusElement.textContent = text;
    }

    show() {
        if (!this.panel) this.buildPanel();
        this.panel.hidden = false;
        this.resizeGraphs();
        this.animate();
        this.panel.focus();
    }

    hide() {
        getInteractionRouter(this.panel.ownerDocument).cancelOwner(this);
        this.panel.hidden = true;
        cancelAnimationFrame(this.animation);
        this.animation = null;
    }

    animate() {
        if (this.animation || this.panel.hidden) return;
        const tick = () => {
            this.animation = null;
            if (!this.panel || this.panel.hidden) return;
            for (const e of this.editors) if (e.c.offsetParent) e.update();
            if (this.sideDirty && this.sideCanvas.offsetParent) { this.drawSide(); this.sideDirty = false; }
            this.animation = requestAnimationFrame(tick);
        };
        this.animation = requestAnimationFrame(tick);
    }

    buildPanel() {
        const panel = this.panel = element("section", "refraction-tool", null, document.getElementById("Content") ?? document.body);
        panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Ray-traced refraction"); panel.tabIndex = -1;
        panel.dataset.interactionNative = "";
        blockViewEvents(panel);
        const header = element("header", "rf-header", null, panel);
        const title = element("div", "", null, header);
        element("span", "rf-eyebrow", "ATMOSPHERE LAB", title);
        element("h2", "", "Ray-traced refraction", title);
        const close = element("button", "rf-close", "×", header);
        close.setAttribute("aria-label", "Close refraction tool"); close.onclick = () => this.hide();
        // Share capture and termination with the curve editors and scene tools.
        // Release outside the header, lost capture, blur and Escape all end the drag.
        this.unregisterPanelDrag = registerSurfaceInteraction(header, {
            model: this, intent: {zIndex: 1200}, capture: () => header,
            snapshot: () => ({left: panel.style.left, top: panel.style.top, right: panel.style.right}),
            restore: state => Object.assign(panel.style, state),
            begin: e => {
                const r = panel.getBoundingClientRect();
                this.drag = {x: e.clientX, y: e.clientY, left: r.left, top: r.top};
            },
            move: e => {
                panel.style.right = "auto";
                panel.style.left = `${clamp(this.drag.left + e.clientX - this.drag.x, 0, window.innerWidth - 100)}px`;
                panel.style.top = `${clamp(this.drag.top + e.clientY - this.drag.y, 0, window.innerHeight - 50)}px`;
            },
            end: () => { this.drag = null; },
        });
        panel.addEventListener("keydown", e => { if (e.key === "Escape") this.hide(); e.stopPropagation(); });
        const top = element("div", "rf-toolbar", null, panel);
        this.check(top, this.settings, "enabled", "Enable", false);
        const views = {};
        for (const {data: view} of Object.values(NodeMan.list)) if (view.renderTargetAndEffects) views[view.id] = view.id;
        this.select(top, this.settings, "view", "Ray-traced view", views, false);
        element("p", "rf-hint rf-view-scope", "Only this view uses the edited atmosphere. Other views keep their existing atmospheric refraction settings.", panel);
        const tabs = element("nav", "rf-tabs", null, panel);
        tabs.setAttribute("aria-label", "Refraction panels");
        this.pages = {};
        const body = element("div", "rf-body", null, panel);
        for (const label of ["Atmosphere", "Ray paths", "Lasers"]) {
            const button = element("button", "", label, tabs);
            const page = this.pages[label] = element("div", "rf-page", null, body);
            page.hidden = label !== "Atmosphere";
            button.setAttribute("aria-pressed", String(!page.hidden));
            button.onclick = () => {
                for (const [key, p] of Object.entries(this.pages)) p.hidden = key !== label;
                for (const b of tabs.children) b.setAttribute("aria-pressed", String(b === button));
                this.resizeGraphs(); this.sideDirty = true;
            };
        }
        this.buildAtmosphere(this.pages.Atmosphere);
        this.buildRays(this.pages["Ray paths"]);
        this.buildLasers(this.pages.Lasers);
        const footer = element("footer", "rf-footer", null, panel);
        this.statusElement = element("div", "rf-status", this.statusText ?? "Enable to trace the selected view.", footer);
        const actions = element("div", "rf-actions", null, footer);
        element("button", "", "Export profile", actions).onclick = () => this.exportSettings();
        const file = element("input", "", null, actions); file.type = "file"; file.accept = ".json,application/json"; file.hidden = true;
        element("button", "", "Import profile", actions).onclick = () => file.click();
        file.onchange = async () => {
            try {
                const data = JSON.parse(await file.files[0].text());
                this.replaceSettings(normalizeSettings({...data, enabled: this.settings.enabled}));
                this.status("Profile imported.");
            } catch (error) { this.status(`Could not import profile: ${error.message}`); }
            file.value = "";
        };
        element("button", "", "Reset", actions).onclick = () => this.replaceSettings(normalizeSettings({enabled: this.settings.enabled, view: this.settings.view}));
        this.resizeObserver = new ResizeObserver(() => this.resizeGraphs());
        this.resizeObserver.observe(panel);
        this.sync();
    }

    check(parent, object, key, label, optical = true) {
        const row = element("label", "rf-check", null, parent);
        const input = element("input", "", null, row); input.type = "checkbox";
        element("span", "", label, row);
        input.onchange = () => { object[key] = input.checked; this.changed(optical); };
        this.controls.push(() => { input.checked = object[key]; });
        input.checked = object[key];
        return input;
    }

    number(parent, object, key, label, min, max, step = 1, optical = true) {
        const row = element("label", "rf-field", null, parent);
        element("span", "", label, row);
        const input = element("input", "", null, row);
        input.type = "number"; input.min = min; input.max = max; input.step = step; input.value = object[key];
        input.onchange = () => {
            if (!input.value || !Number.isFinite(input.valueAsNumber)) { input.value = object[key]; return; }
            object[key] = clamp(input.valueAsNumber, min, max); input.value = object[key]; this.changed(optical);
        };
        this.controls.push(() => { if (document.activeElement !== input) input.value = object[key]; });
        return input;
    }

    select(parent, object, key, label, choices, optical = true) {
        const row = element("label", "rf-field", null, parent);
        element("span", "", label, row);
        const select = element("select", "", null, row);
        for (const [name, value] of Object.entries(choices)) { const option = element("option", "", name, select); option.value = value; }
        select.value = object[key];
        select.onchange = () => { object[key] = select.value; this.changed(optical); };
        this.controls.push(() => { select.value = object[key]; });
        return select;
    }

    buildAtmosphere(page) {
        const s = this.settings;
        const presets = element("div", "rf-presets", null, page);
        const presetLabel = element("label", "rf-field", null, presets);
        element("span", "", "Temperature preset", presetLabel);
        const preset = element("select", "", null, presetLabel);
        preset.setAttribute("aria-label", "Temperature preset");
        element("option", "", "Choose a starting profile…", preset).value = "";
        for (const name of Object.keys(PROFILE_PRESETS)) element("option", "", name, preset).value = name;
        const presetNote = element("p", "rf-hint", "Presets replace the temperature curve and upper lapse rate. Humidity and other optical settings are kept.", page);
        preset.onchange = () => {
            if (!preset.value) return;
            const name = preset.value;
            applyProfilePreset(s, name);
            this.editors[0].setPointsFromFlatArray(swapAxes(s.temperatureCurve));
            this.fitEditor(this.editors[0]); this.changed();
            presetNote.textContent = `${name} applied. ${PROFILE_PRESET_DETAILS[name].note}`;
            preset.value = "";
        };
        const grid = element("div", "rf-grid", null, page);
        this.check(grid, s, "useStandard", "Standard temperature lapse");
        this.check(grid, s, "bend", "Bend light (off = straight rays)");
        this.number(grid, s, "temperature", "Surface temperature · °C", -40, 60, 0.1);
        this.number(grid, s, "lapseRate", "Upper lapse rate · K/km", -100, 100, 0.1);
        this.number(grid, s, "pressure", "Sea-level pressure · hPa", 0, 1200, 0.1);
        this.number(grid, s, "wavelength", "Wavelength · nm", 300, 1700, 1);
        this.number(grid, s, "humidity", "Relative humidity · %", 0, 100, 1);
        this.number(grid, s, "co2", "CO₂ · ppm", 0, 2000, 1);
        this.check(grid, s, "humidityProfile", "Use humidity curve");
        this.check(grid, s, "flat", "Flat atmosphere reference");
        element("p", "rf-hint", "Profiles use height above sea level. Flat reference changes the ray model; scene geometry follows Sitrec’s Earth model.", page);
        const profiles = element("div", "rf-profiles", null, page);
        this.addEditor(profiles, "Temperature profile", "Temperature · °C", "temperatureCurve", -40, 100);
        this.addEditor(profiles, "Humidity profile", "Humidity · %", "humidityCurve", 0, 100);
        element("p", "rf-hint", "Drag Sitrec’s curve points and handles. Right-click to add or remove a point. Editing a curve activates it. Camera height, tilt and FOV follow the selected Sitrec camera.", page);
    }

    addEditor(page, title, xLabel, key, low, high) {
        const card = element("section", "rf-chart", null, page);
        const header = element("div", "rf-chart-title", null, card);
        element("strong", "", title, header);
        const fit = element("button", "", "Fit curve", header);
        const canvas = element("canvas", "rf-curve", null, card);
        canvas.width = 380; canvas.height = 340;
        const editor = new MetaBezierCurveEditor({canvas, points: swapAxes(this.settings[key]),
            minX: low, maxX: high, minY: 0, maxY: 100, xLabel, yLabel: "Height · m", independentAxis: "y",
            xStep: 20, yStep: 5, devicePixelRatio: 1, fillCanvas: false,
            tickFormat: value => String(Number(value.toFixed(3))),
            onEditStart: () => this.setEditing(true), onEditEnd: () => this.setEditing(false),
            onChange: () => {
                this.settings[key] = normalizeCurve(swapAxes(editor.getProfile()),
                    this.settings[key === "temperatureCurve" ? "temperaturePoints" : "humidityPoints"], low, high);
                const curve = swapAxes(this.settings[key]);
                // Preserve the editor's selectedPoint reference across every
                // pointer move. Replacing ps here would end a drag after one step.
                if (editor.curve.ps.length * 2 === curve.length) {
                    editor.curve.ps.forEach((point, i) => { point.x = curve[i * 2]; point.y = curve[i * 2 + 1]; });
                } else {
                    editor.selectedPoint = null;
                    editor.setPointsFromFlatArray(curve);
                }
                if (key === "temperatureCurve") this.settings.useStandard = false;
                else this.settings.humidityProfile = true;
                this.changed();
            }});
        this.editors.push(editor);
        this.fitEditor(editor);
        fit.onclick = () => this.fitEditor(editor);
        // Explicit axes remain useful when fitting sub-metre layers inside a tall profile.
        const axes = element("div", "rf-grid rf-axis", null, card);
        const limit = (object, property, label) => {
            const input = this.number(axes, object, property, label, -1000, 20000, 0.1, false);
            const change = input.onchange;
            input.onchange = () => { change();
                editor.max.x = Math.max(editor.min.x + 0.01, editor.max.x);
                editor.max.y = Math.max(editor.min.y + 0.01, editor.max.y);
                this.editorSteps(editor); editor.dirty = true;
            };
        };
        limit(editor.min, "y", "Height min"); limit(editor.max, "y", "Height max");
        limit(editor.min, "x", "Value min"); limit(editor.max, "x", "Value max");
    }

    editorSteps(e) {
        const nice = span => { const p = 10 ** Math.floor(Math.log10(span / 5)); return Math.max(0.001, Math.ceil(span / 5 / p) * p); };
        e.xStep = nice(e.max.x - e.min.x); e.yStep = nice(e.max.y - e.min.y);
    }

    fitEditor(e) {
        const p = e.curve.ps;
        e.min.y = Math.min(...p.map(p => p.y));
        e.max.y = Math.max(e.min.y + 1, ...p.map(p => p.y));
        const min = Math.min(...p.map(p => p.x)), max = Math.max(...p.map(p => p.x));
        const pad = Math.max(0.5, (max - min) * 0.15);
        e.min.x = min - pad; e.max.x = max + pad;
        this.editorSteps(e);
        e.min.x = Math.floor(e.min.x / e.xStep) * e.xStep;
        e.max.x = Math.ceil(e.max.x / e.xStep) * e.xStep;
        e.dirty = true;
        for (const update of this.controls) update();
    }

    buildRays(page) {
        this.observerElement = element("p", "rf-observer", "Camera follows the selected 3D view.", page);
        const stats = element("dl", "rf-diagnostics", null, page);
        this.diagnosticFields = {};
        for (const [key, label] of Object.entries({kAt1m: "Local k at 1 m", kAt50m: "Local k at 50 m",
            kAtObserver: "Local k at camera", groundHits: "Rays hitting the surface",
            reachedSamples: "Samples above the surface", foldedPairs: "Folded ray pairs"})) {
            const row = element("div", "", null, stats);
            element("dt", "", label, row);
            this.diagnosticFields[key] = element("dd", "", "—", row);
        }
        element("p", "rf-hint", "Last traced fan: k compares local bending with Earth curvature. Folds indicate reversed ray order; they do not guarantee a visible mirage. Sample coverage is not scene visibility.", page);
        this.updateDiagnostics();
        this.sideCanvas = element("canvas", "rf-side", null, page);
        const s = this.settings, grid = element("div", "rf-grid", null, page);
        this.number(grid, s, "maxDistance", "Trace distance · m", 100, 300000, 100);
        this.number(grid, s, "step", "Maximum integration step · m", 2, 1000, 1);
        this.number(grid, s, "distanceSamples", "Distance samples", 64, 2048, 1);
        this.number(grid, s, "resolution", "Rays per screen line", 0.25, 2, 0.25);
        this.number(grid, s, "raySpacing", "Show every Nth ray", 1, 500, 1, false);
        this.number(grid, s, "sideZoom", "Cross-section vertical zoom", 0.1, 1000, 0.1, false);
        this.check(grid, s, "showRays", "Show ray paths", false);
        this.check(grid, s, "showGradient", "Temperature backdrop", false);
        this.check(grid, s, "showIndex", "Graph refractive index", false);
        this.check(grid, s, "showEyeLevel", "Eye-level guide", false);
        this.check(grid, s, "showHorizon", "Geometric-horizon guide", false);
        this.check(grid, s, "night", "Night preview", false);
        this.check(grid, s, "visibilityEnabled", "Visibility attenuation", false);
        this.number(grid, s, "visibility", "Visibility · km", 0.1, 500, 0.1, false);
        element("p", "rf-hint", "The cross-section is compressed horizontally. Ray tables rebuild only when the atmosphere or camera sampling changes. Colours update live through the GPU.", page);
        element("p", "rf-hint", "This is a depth-based screen-space effect: it can reproduce folds and mirage images of visible surfaces, but cannot recover hidden or offscreen geometry. Scene measurements and overlays remain geometric. Use a perspective camera near the horizon.", page);
    }

    buildLasers(page) {
        this.check(page, this.settings, "lasersEnabled", "Show lasers in the scene and cross-section");
        element("p", "rf-hint", "Beams use the same atmosphere at their own wavelength. Height is above sea level; position follows the selected camera’s horizontal heading. Beam edges show divergence. Brightness is a visual guide, not calibrated radiometry.", page);
        const list = element("div", "rf-laser-list", null, page);
        for (const [index, l] of this.settings.lasers.entries()) {
            const card = element("section", "rf-laser", null, list);
            const title = element("div", "rf-chart-title", null, card);
            const enabled = this.check(title, l, "enabled", l.name);
            element("button", "", "Remove", title).onclick = () => {
                this.settings.lasers.splice(index, 1); this.rebuildPanel(); this.changed();
            };
            const grid = element("div", "rf-grid", null, card);
            const nameLabel = element("label", "rf-field", "Name", grid);
            const name = element("input", "", null, nameLabel); name.type = "text"; name.maxLength = 80; name.value = l.name;
            name.onchange = () => {
                l.name = name.value.trim() || `Laser ${index + 1}`;
                name.value = l.name; enabled.nextElementSibling.textContent = l.name; this.changed(false);
            };
            this.number(grid, l, "height", "Height · m", 0, 20000, 0.01);
            this.number(grid, l, "angle", "Elevation · °", -30, 30, 0.001);
            this.number(grid, l, "distance", "Range · m", 1, 300000, 1);
            this.number(grid, l, "offset", "Lateral offset · m", -10000, 10000, 0.1);
            this.number(grid, l, "diameter", "Aperture diameter · mm", 0.1, 1000, 0.1);
            this.number(grid, l, "divergence", "Full divergence · mrad", 0, 100, 0.01);
            this.number(grid, l, "power", "Power · mW", 0, 100000, 1);
            this.number(grid, l, "wavelength", "Wavelength · nm", 300, 1700, 1);
            this.check(grid, l, "reverse", "Emit from far end");
            const label = element("label", "rf-field", "Beam colour", grid);
            const color = element("input", "", null, label); color.type = "color"; color.value = l.color;
            color.onchange = () => { l.color = color.value; this.changed(); };
        }
        const add = element("button", "rf-add", "＋ Add laser", page);
        add.disabled = this.settings.lasers.length >= 8;
        add.onclick = () => { this.settings.lasers.push(defaultLaser(this.settings.lasers.length)); this.rebuildPanel(); this.changed(); };
    }

    resizeGraphs() {
        for (const e of this.editors) {
            if (!e.c.clientWidth) continue;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            e.c.width = Math.round(e.c.clientWidth * dpr); e.c.height = Math.round(e.c.clientHeight * dpr);
            e.devicePixelRatio = dpr;
            e.c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
            e.dirty = true;
        }
        this.sideDirty = true;
    }

    updateObserver(position, zenith, camera, height) {
        const forward = camera.getWorldDirection(new Vector3());
        forward.addScaledVector(zenith, -forward.dot(zenith)).normalize();
        const right = new Vector3().crossVectors(forward, zenith).normalize();
        this.laserGroup.position.copy(position).addScaledVector(zenith, -height);
        this.laserGroup.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(forward, zenith, right));
        if (this.observerElement) {
            const text = `Observer ${height.toFixed(2)} m above sea level · vertical FOV ${camera.fov.toFixed(4)}°`;
            if (this.observerElement.textContent !== text) this.observerElement.textContent = text;
        }
    }

    clearLasers() {
        for (const child of [...this.laserGroup.children]) {
            this.laserGroup.remove(child); child.geometry.dispose(); child.material.dispose();
        }
    }

    setResult(result) {
        this.result = result;
        this.updateDiagnostics();
        this.sideDirty = true;
        this.clearLasers();
        for (const l of result.lasers) {
            for (const [path, opacity] of [[l.center, 0.9], [l.upper, 0.3], [l.lower, 0.3]]) {
                const points = [];
                for (let i = 0; i < l.distances.length; i++) {
                    if (!path[i * 3 + 2]) break;
                    const x = l.laser.reverse ? l.laser.distance - l.distances[i] : l.distances[i];
                    points.push(x, path[i * 3], l.laser.offset);
                }
                if (points.length < 6) continue;
                const geometry = new BufferGeometry();
                geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
                const material = new LineBasicMaterial({color: l.laser.color, transparent: true,
                    opacity: opacity * Math.min(1, Math.sqrt(l.laser.power / 100)), blending: AdditiveBlending, depthWrite: false});
                const line = new Line(geometry, material); line.layers.enableAll(); this.laserGroup.add(line);
            }
        }
        this.laserGroup.visible = this.settings.lasersEnabled;
    }

    updateDiagnostics() {
        if (!this.diagnosticFields) return;
        const d = this.result?.diagnostics;
        const percent = (count, total) => {
            if (!(total > 0)) return "—";
            const value = 100 * count / total;
            return value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`;
        };
        for (const [key, field] of Object.entries(this.diagnosticFields)) {
            field.textContent = !d ? "—" : key.startsWith("kAt")
                ? (Number.isFinite(d[key]) ? d[key].toFixed(3) : "—")
                : percent(d[key], key === "groundHits" ? d.totalRays : key === "reachedSamples" ? d.totalSamples : d.testedPairs);
        }
    }

    drawSide() {
        const canvas = this.sideCanvas, dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        canvas.width = w * dpr; canvas.height = h * dpr;
        const c = canvas.getContext("2d"); c.scale(dpr, dpr);
        c.fillStyle = this.settings.night ? "#101926" : "#eff5f8"; c.fillRect(0, 0, w, h);
        const r = this.result;
        if (!r) { c.fillStyle = "#526879"; c.fillText("Enable refraction to trace rays.", 24, 40); return; }
        const s = this.settings, pad = 48, right = w - 18, bottom = h - 32;
        const range = r.distances[r.width - 1];
        const low = Math.min(groundY(range, r.radius), -5);
        const high = Math.max(r.height * 2, 30, range * Math.tan(r.maxAngle) + r.height);
        const top = r.height + (high - r.height) / s.sideZoom;
        const base = r.height + (low - r.height) / s.sideZoom;
        const x = d => pad + d / range * (right - pad);
        const y = v => bottom - (v - base) / (top - base) * (bottom - 18);
        this.medium ??= atmosphere(s);
        if (s.showGradient) {
            for (let py = 18; py < bottom; py += 3) {
                const value = top - (py - 18) / (bottom - 18) * (top - base);
                const t = this.medium.temperature(Math.max(0, value));
                c.fillStyle = `hsla(${clamp(225 - (t - s.temperature) * 12, 5, 260)},65%,75%,0.45)`;
                c.fillRect(pad, py, right - pad, 3);
            }
        }
        c.font = "11px system-ui"; c.textAlign = "right";
        for (let i = 0; i <= 4; i++) {
            const v = base + (top - base) * i / 4;
            c.strokeStyle = "#bacad366"; c.beginPath(); c.moveTo(pad, y(v)); c.lineTo(right, y(v)); c.stroke();
            c.fillStyle = "#657784"; c.fillText(`${v.toFixed(0)} m`, pad - 5, y(v) + 3);
        }
        c.save(); c.beginPath(); c.rect(pad, 18, right - pad, bottom - 18); c.clip();
        c.fillStyle = s.night ? "#1e3641" : "#b7cbd2"; c.beginPath(); c.moveTo(x(0), bottom);
        for (const d of r.distances) c.lineTo(x(d), y(groundY(d, r.radius)));
        c.lineTo(right, bottom); c.closePath(); c.fill();
        const drawPath = (distances, path, color, reverse = false, range = 0) => {
            c.strokeStyle = color; c.beginPath();
            for (let i = 0; i < distances.length; i++) {
                if (!path[i * 3 + 2]) break;
                const px = x(reverse ? range - distances[i] : distances[i]), py = y(path[i * 3]);
                if (i) c.lineTo(px, py); else c.moveTo(px, py);
            }
            c.stroke();
        };
        if (s.showRays) for (let row = 0; row < r.rows; row += s.raySpacing) {
            c.strokeStyle = "#078c9f65"; c.beginPath();
            for (let i = 0; i < r.width; i++) {
                const k = (row * r.width + i) * 4;
                if (r.distances[i] > r.data[k + 2]) break;
                if (i) c.lineTo(x(r.distances[i]), y(r.data[k + 3])); else c.moveTo(x(0), y(r.height));
            }
            c.stroke();
        }
        for (const l of r.lasers) {
            drawPath(l.distances, l.center, l.laser.color, l.laser.reverse, l.laser.distance);
            drawPath(l.distances, l.upper, l.laser.color + "66", l.laser.reverse, l.laser.distance);
            drawPath(l.distances, l.lower, l.laser.color + "66", l.laser.reverse, l.laser.distance);
        }
        if (s.showEyeLevel) { c.strokeStyle = "#039f85"; c.beginPath(); c.moveTo(pad, y(r.height)); c.lineTo(right, y(r.height)); c.stroke(); }
        if (s.showIndex) {
            c.strokeStyle = "#a549c5"; c.beginPath();
            for (let i = 0; i <= 200; i++) {
                const height = base + (top - base) * i / 200;
                const n = (this.medium.index(Math.max(0, height)) - 1) * 1e6;
                const px = pad + n / 400 * (right - pad);
                if (i) c.lineTo(px, y(height)); else c.moveTo(px, y(height));
            }
            c.stroke();
        }
        c.restore(); c.fillStyle = "#536a79"; c.textAlign = "center";
        for (let i = 0; i <= 4; i++) {
            c.textAlign = i === 4 ? "right" : "center";
            c.fillText(`${(range * i / 4000).toFixed(1)} km`, x(range * i / 4), h - 12);
        }
        c.textAlign = "center";
        if (s.showIndex) { c.fillStyle = "#974caf"; c.fillText("Refractivity (n − 1) × 10⁶: 0 → 400", w / 2, 13); }
    }

    exportSettings() {
        const url = URL.createObjectURL(new Blob([JSON.stringify(this.settings, null, 2)], {type: "application/json"}));
        const a = element("a"); a.href = url; a.download = "refraction-profile.json"; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    replaceSettings(settings) {
        this.releasePass();
        this.settings = Sit.raytracedRefraction = settings;
        this.rebuildPanel(); this.changed();
    }

    destroyPanel() {
        this.unregisterPanelDrag?.(); this.unregisterPanelDrag = null;
        cancelAnimationFrame(this.animation); this.animation = null;
        this.resizeObserver?.disconnect();
        for (const e of this.editors) e.unregisterInteraction?.();
        this.editors = []; this.controls = [];
        this.panel?.remove(); this.panel = null;
    }

    rebuildPanel() {
        const page = this.pages && Object.keys(this.pages).find(key => !this.pages[key].hidden);
        this.destroyPanel(); this.show();
        if (page) [...this.panel.querySelectorAll(".rf-tabs button")].find(b => b.textContent === page)?.click();
    }

    dispose() {
        this.releasePass(); this.destroyPanel(); this.clearLasers(); this.laserGroup.removeFromParent();
    }
}
