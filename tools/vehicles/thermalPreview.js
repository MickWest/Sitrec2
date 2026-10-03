import {PerspectiveCamera, Sphere, Vector3} from "three";
import {ThermalPipeline} from "../thermal/ThermalPipeline.js";
import {THERMAL_PARAMETERS, normalizeSettings, settingsForPreset} from "../thermal/thermalSchema.js";
import {PRESET_OVERRIDES, resolveSignatures} from "../thermal/signatures.js";

const STORAGE_KEY = "sitrec-vehicle-ir-preview-v1";
export const SENSOR_VIEW_PARAMETERS = [
    {key: "rangeM", label: "Sensor range", unit: "m", min: 1, max: 300000, step: 100, default: 125000},
    {key: "azimuthDeg", label: "Aspect azimuth (0 = behind)", unit: "degree", min: -180, max: 180, step: .1, default: 0},
    {key: "elevationDeg", label: "Aspect elevation (positive = above)", unit: "degree", min: -89.9, max: 89.9, step: .1, default: 0},
];

export function thermalControlGroups() {
    const groups = new Map();
    for (const parameter of THERMAL_PARAMETERS) {
        if (!groups.has(parameter.group)) groups.set(parameter.group, []);
        groups.get(parameter.group).push(parameter);
    }
    return groups;
}

export function normalizeSensorView(input = {}) {
    return Object.fromEntries(SENSOR_VIEW_PARAMETERS.map(parameter => {
        const value = input[parameter.key] ?? parameter.default;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${parameter.label} must be finite`);
        return [parameter.key, Math.max(parameter.min, Math.min(parameter.max, value))];
    }));
}

export function attachThermalDebug(host, debug, key = "vehicleThermal") {
    if (!["localhost", "local.metabunk.org"].includes(host.location.hostname)) return () => {};
    host[key] = debug;
    return () => {if (host[key] === debug) delete host[key];};
}

export function configureSensorCamera(camera, bounds, settings, view) {
    // A world-view host already owns its pose and clipping planes. Share the
    // detector projection without replacing that host's camera-to-target geometry.
    if (!bounds) {
        camera.fov = settings.verticalFovDeg;
        camera.aspect = settings.detectorWidth / settings.detectorHeight;
        camera.zoom = 1; camera.filmOffset = 0; camera.clearViewOffset(); camera.updateProjectionMatrix();
        return {verticalFovDeg: camera.fov, horizontalFovDeg: 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect) * 180 / Math.PI};
    }
    const sphere = bounds.getBoundingSphere(new Sphere());
    if (view.rangeM <= sphere.radius) throw new Error("Sensor range must place the camera outside the vehicle.");
    const azimuth = view.azimuthDeg * Math.PI / 180, elevation = view.elevationDeg * Math.PI / 180;
    const direction = new Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    camera.position.copy(sphere.center).addScaledVector(direction, view.rangeM);
    camera.up.set(0, 1, 0); camera.lookAt(sphere.center);
    const margin = Math.max(10, sphere.radius * 2);
    camera.near = Math.max(.01, view.rangeM - margin); camera.far = view.rangeM + margin;
    camera.fov = settings.verticalFovDeg; camera.aspect = settings.detectorWidth / settings.detectorHeight;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    return {verticalFovDeg: camera.fov, horizontalFovDeg: 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect) * 180 / Math.PI,
        pixelSizeM: 2 * view.rangeM * Math.tan(camera.fov * Math.PI / 360) / settings.detectorHeight,
        requiredRangeM: view.rangeM + margin};
}

export function detectorStatistics(counts) {
    if (!counts.length) return null;
    const histogram = new Uint32Array(16384);
    let min = 16383, max = 0;
    for (const count of counts) {histogram[count]++; min = Math.min(min, count); max = Math.max(max, count);}
    const lower = Math.floor((counts.length - 1) / 2), upper = Math.floor(counts.length / 2);
    let total = 0, lowValue, highValue;
    for (let count = min; count <= max; count++) {
        total += histogram[count];
        if (lowValue === undefined && total > lower) lowValue = count;
        if (total > upper) {highValue = count; break;}
    }
    return {min, max, median: (lowValue + highValue) / 2};
}

// Canvas coordinates are top-down; detector readback rows start at the bottom.
export function detectorPixelAt(x, y, rect, settings) {
    const u = (x - rect.left) / rect.width, v = (y - rect.top) / rect.height;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    const column = Math.min(settings.detectorWidth - 1, Math.floor(((u - .5) / settings.digitalZoom + .5) * settings.detectorWidth));
    const row = Math.min(settings.detectorHeight - 1, Math.floor(((.5 - v) / settings.digitalZoom + .5) * settings.detectorHeight));
    return {column, row, index: row * settings.detectorWidth + column};
}

export function resolveVehicleThermal(recipe, {airTemperatureK, mach, power} = {}) {
    const p = recipe.parameters, override = PRESET_OVERRIDES[recipe.presetId];
    let profile = p.thermalProfile === "auto" ? override?.profile : p.thermalProfile;
    if (!profile) {
        if (p.vehicleType === "balloon") profile = ["foil", "star", "heart"].includes(p.balloonShape) ? "foil" :
            ["lantern", "boxlantern", "pagoda"].includes(p.balloonShape) ? "lantern" :
            ["hotair", "solar"].includes(p.balloonShape) ? "hotair" : ["blimp"].includes(p.balloonShape) ? "unpowered" : "latex";
        else if (p.rotorLayout && p.rotorLayout !== "none") profile = "turboshaft";
        else if (p.vehicleType === "drone" && p.droneStyle !== "fixedwing") profile = "electric";
        else if (p.engineType === "none") profile = "unpowered";
        else if (p.engineType === "prop") profile = "piston";
        else if (p.engineType === "turboprop") profile = "turboprop";
        else if (p.engineType === "jet") profile = p.bodyStyle === "jet" ? "fighter" : "high_bypass_turbofan";
        else if (["car", "truck"].includes(p.vehicleType)) profile = /electric|ev-/.test(recipe.presetId ?? "") ? "electric" : "road_combustion";
    }
    return resolveSignatures({...recipe, thermal: {profile, powerFraction: power ?? p.thermalPower, mach: mach ?? p.thermalMach,
        skinEmissivityMWIR: p.thermalEmissivity}}, airTemperatureK ?? p.thermalAmbientK);
}

// Changes are scoped to one draw; a failed pipeline cannot leave the visible editor altered.
export function withThermalVehicle(model, draw, values = {}) {
    const signature = resolveVehicleThermal(model.recipe, values), changed = [];
    const parameters = model.recipe.parameters;
    const burner = resolveSignatures({thermal: {profile: "lantern", powerFraction: values.power ?? parameters.thermalPower,
        mach: values.mach ?? parameters.thermalMach}}, values.airTemperatureK ?? parameters.thermalAmbientK);
    try {
        model.root.traverse(mesh => {
            if (!mesh.isMesh) return;
            changed.push({mesh, visible: mesh.visible, thermal: mesh.userData.thermal});
            if (mesh.userData.thermalOnly) mesh.visible = true;
            if (mesh.userData.thermalHidden) mesh.visible = false;
            let zone = mesh.userData.thermal?.zone;
            // Markings replace substrate color, not the thermal surface underneath.
            if (/marking|wordmark|ribbon|outline/i.test(mesh.name)) mesh.visible = false;
            if (["electric", "unpowered"].includes(signature.profile) && mesh.userData.thermalOnly &&
                (mesh.userData.thermalEngineIndex !== undefined || /nozzle|cavity/i.test(mesh.name))) mesh.visible = false;
            if (signature.profile === "piston" && ["jet_nozzle", "jet_cavity"].includes(zone)) zone = "piston_stack";
            if (signature.profile === "piston" && zone === "helicopter_engine_bay") zone = "piston_cowl";
            if (signature.profile === "turboshaft" && zone === "nacelle_skin") zone = "helicopter_engine_bay";
            if (["turboshaft", "turboprop"].includes(signature.profile) && zone === "hot_outlet") zone = "jet_nozzle";
            if (signature.profile === "fighter" && zone === "hot_outlet") zone = "jet_nozzle";
            mesh.userData.thermal = {...(zone === "lantern_flame" ? burner : signature).resolveZone(zone), zone: mesh.userData.thermal?.zone};
        });
        return draw(signature);
    } finally {
        for (const {mesh, visible, thermal} of changed) {mesh.visible = visible; mesh.userData.thermal = thermal;}
    }
}

export function createThermalControls(mount, getSettings, set, {translate = null, readOnly = () => false} = {}) {
    // Both widget hosts walk the same descriptors and use the same edit callback.
    if (mount.addFolder) {
        const fields = [], state = {}, folders = [];
        for (const [group, parameters] of thermalControlGroups()) {
            const folder = mount.addFolder(translate(`thermal.groups.${group}`)).close();
            folders.push(folder);
            for (const parameter of parameters) {
                Object.defineProperty(state, parameter.key, {enumerable: true,
                    get: () => getSettings()[parameter.key], set: value => set(parameter.key, value)});
                const options = parameter.options && Object.fromEntries(parameter.options.map(option =>
                    [translate(`thermal.parameters.${parameter.key}.options.${option.value}`), option.value]));
                const control = parameter.type === "select" ? folder.add(state, parameter.key, options) :
                    parameter.type === "number" ? folder.add(state, parameter.key, parameter.min, parameter.max, parameter.step) : folder.add(state, parameter.key);
                control.name(`${translate(parameter.labelKey)} · ${parameter.unit}`).listen();
                if (readOnly(parameter)) control.disable();
                fields.push({control, parameter});
            }
        }
        return {refresh() {
            const settings = getSettings();
            for (const {control, parameter} of fields) {
                const metadata = settings.presetMetadata?.[parameter.key];
                control.tooltip(`${translate(parameter.tooltipKey)}\n${translate(`thermal.status.${metadata?.status ?? parameter.status ?? "estimated"}`)}${metadata?.source ? ` · ${metadata.source}` : ""}`);
                control.updateDisplay();
            }
        }, dispose() {folders.forEach(folder => folder.destroy());}};
    }
    const fields = new Map();
    for (const [group, parameters] of thermalControlGroups()) {
        const folder = document.createElement("details"), summary = document.createElement("summary"), body = document.createElement("div");
        summary.textContent = group[0].toUpperCase() + group.slice(1); folder.open = ["detector", "processing", "display"].includes(group);
        body.className = "folder-fields"; folder.append(summary, body); mount.append(folder);
        for (const parameter of parameters) {
            const row = document.createElement("div"), label = document.createElement("label"), provenance = document.createElement("small");
            row.className = "field thermal-field";
            label.textContent = `${parameter.label} · ${parameter.unit}`;
            const input = document.createElement(parameter.type === "select" ? "select" : "input");
            input.id = `thermal-${parameter.key}`; input.dataset.thermalKey = parameter.key; label.htmlFor = input.id;
            if (parameter.type === "select") for (const option of parameter.options) input.add(new Option(option.label, String(option.value)));
            else {
                input.type = parameter.type === "boolean" ? "checkbox" : "number";
                if (parameter.type === "number") {input.min = parameter.min; input.max = parameter.max; input.step = parameter.step;}
            }
            input.title = parameter.tooltip; row.append(label, input, provenance); body.append(row);
            input.addEventListener("change", () => {
                const value = parameter.type === "boolean" ? input.checked : parameter.type === "number" ? input.valueAsNumber :
                    parameter.options.find(option => String(option.value) === input.value).value;
                set(parameter.key, value);
            });
            fields.set(parameter.key, {input, provenance, parameter});
        }
    }
    return {refresh() {
        const settings = getSettings();
        for (const [key, {input, provenance, parameter}] of fields) {
            if (parameter.type === "boolean") input.checked = settings[key]; else input.value = settings[key];
            const metadata = settings.presetMetadata[key];
            provenance.textContent = metadata ? `${metadata.overridden ? "Edited · preset " : ""}${metadata.status}` : parameter.status ?? "Model setting · estimated default";
            provenance.title = metadata?.source ?? parameter.tooltip;
        }
    }, dispose() {mount.replaceChildren();}};
}

export function createVehicleThermalPreview({renderer, panel, readout, onChange, onError}) {
    let settings = normalizeSettings({...settingsForPreset("MX15"), gainMode: "automatic", polarity: "blackHot"});
    let view = normalizeSensorView(), counts, lastSettings, stats, pointer = null;
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved) {const nextSettings = normalizeSettings(saved.settings), nextView = normalizeSensorView(saved.view); settings = nextSettings; view = nextView;}
    } catch { /* Disabled storage or an obsolete record must not prevent preview. */ }
    const pipeline = new ThermalPipeline(renderer), camera = new PerspectiveCamera();
    const lifecycle = new AbortController(), hostFields = new Map();
    const host = document.createElement("div"); host.className = "folder-fields sensor-view-fields";
    const note = document.createElement("p"); note.className = "folder-note";
    note.textContent = "IR sensor preview · uniform cold sky. Surface temperatures, aperture, scatter and electronics are estimates. Aspect rotates around the vehicle; atmospheric elevation is a separate ray setting. Fit preserves range.";
    host.append(note); panel.append(host);
    for (const parameter of SENSOR_VIEW_PARAMETERS) {
        const label = document.createElement("label"), input = document.createElement("input");
        label.className = "field thermal-field"; label.textContent = `${parameter.label} · ${parameter.unit}`;
        input.type = "number"; input.min = parameter.min; input.max = parameter.max; input.step = parameter.step;
        input.addEventListener("change", () => edit(parameter.key, input.valueAsNumber));
        label.append(input); host.append(label); hostFields.set(parameter.key, input);
    }
    const schemaMount = document.createElement("div"); panel.append(schemaMount);
    const controls = createThermalControls(schemaMount, () => settings, edit);
    function refresh() {controls.refresh(); for (const [key, input] of hostFields) input.value = view[key];}
    function persist() {try {localStorage.setItem(STORAGE_KEY, JSON.stringify({settings, view}));} catch { /* Optional storage. */ }}
    function set(key, value) {
        if (hostFields.has(key)) view = normalizeSensorView({...view, [key]: value});
        else if (key === "sensorPreset") settings = settingsForPreset(value);
        else {
            if (!THERMAL_PARAMETERS.some(parameter => parameter.key === key)) throw new Error(`Unknown thermal setting: ${key}`);
            const fieldMode = key === "focalLengthM" ? "focalLength" : key === "verticalFovDeg" ? "fieldOfView" : settings.fieldMode;
            settings = normalizeSettings({...settings, [key]: value, fieldMode});
        }
        counts = null; refresh(); persist(); onError(""); onChange();
    }
    function edit(key, value) {try {set(key, value);} catch (error) {onError(error.message); refresh();}}
    const geometryReadout = document.createElement("div"), countReadout = document.createElement("div"); readout.append(geometryReadout, countReadout);
    function showCounts() {
        if (!counts) {countReadout.textContent = "Detector counts · waiting for a frame"; return;}
        const pixel = pointer && detectorPixelAt(pointer.x, pointer.y, renderer.domElement.getBoundingClientRect(), lastSettings);
        countReadout.textContent = `14-bit counts · pointer ${pixel ? `${counts[pixel.index]} [${pixel.column}, ${pixel.row}]` : "—"} · min ${stats.min} · max ${stats.max} · median ${stats.median}`;
    }
    renderer.domElement.addEventListener("pointermove", event => {pointer = {x: event.clientX, y: event.clientY}; showCounts();}, {signal: lifecycle.signal});
    renderer.domElement.addEventListener("pointerleave", () => {pointer = null; showCounts();}, {signal: lifecycle.signal});
    const debug = {pipeline, get settings() {return {...settings, ...view};}, set, readDetectorCounts: () => pipeline.readDetectorCounts()};
    const detachDebug = attachThermalDebug(window, debug);
    refresh();
    return {pipeline, get settings() {return settings;}, get view() {return view;}, set,
        render(scene, model, frame) {
            counts = null;
            try {
                const scale = configureSensorCamera(camera, model.bounds, settings, view);
                if (settings.atmosphereMaxRangeM < scale.requiredRangeM) {
                    settings = normalizeSettings({...settings, atmosphereMaxRangeM: Math.ceil(scale.requiredRangeM)}); refresh(); persist();
                }
                withThermalVehicle(model, () => pipeline.render({scene, camera, settings, frame}));
                counts = pipeline.readDetectorCounts(); lastSettings = {...settings}; stats = detectorStatistics(counts);
                geometryReadout.textContent = `${view.rangeM.toLocaleString()} m · FOV ${scale.verticalFovDeg.toFixed(3)}° V × ${scale.horizontalFovDeg.toFixed(3)}° H · ${scale.pixelSizeM.toFixed(3)} m / detector pixel · aspect ${view.azimuthDeg}°, ${view.elevationDeg}°`;
            } finally {showCounts();}
        },
        dispose() {
            lifecycle.abort(); pipeline.dispose(); controls.dispose(); panel.replaceChildren(); readout.replaceChildren();
            detachDebug();
        },
    };
}
