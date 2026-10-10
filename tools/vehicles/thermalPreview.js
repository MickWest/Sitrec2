import {PerspectiveCamera, Sphere, Vector3} from "three";
import {ThermalPipeline} from "../thermal/ThermalPipeline.js";
import {THERMAL_PARAMETERS, normalizeSettings, settingsForPreset} from "../thermal/thermalSchema.js";
import {PRESET_OVERRIDES, resolveSignatures} from "../thermal/signatures.js";

const STORAGE_KEY = "sitrec-vehicle-ir-preview-v1";
// Far: the sensor at range and aspect around the vehicle. Near: the visible preview's own camera.
export const IR_VIEWS = {near: "Near · visible-preview camera", far: "Far · sensor at range"};
export const SENSOR_VIEW_PARAMETERS = [
    {key: "rangeM", label: "Sensor range", unit: "m", min: 1, max: 300000, step: 100, default: 125000},
    {key: "azimuthDeg", label: "Aspect azimuth (0 = behind)", unit: "degree", min: -180, max: 180, step: .1, default: 0},
    {key: "elevationDeg", label: "Aspect elevation (positive = above)", unit: "degree", min: -89.9, max: 89.9, step: .1, default: 0},
];
// Estimated: a zoom moves the near distance in many small steps, and each new point-response range rebuilds the
// optical kernels; the range follows the distance once it has been still for this long.
const NEAR_RANGE_SETTLE_MS = 300;

export function thermalControlGroups() {
    const groups = new Map();
    for (const parameter of THERMAL_PARAMETERS) {
        if (!groups.has(parameter.group)) groups.set(parameter.group, []);
        groups.get(parameter.group).push(parameter);
    }
    return groups;
}

export function normalizeSensorView(input = {}) {
    const view = Object.fromEntries(SENSOR_VIEW_PARAMETERS.map(parameter => {
        const value = input[parameter.key] ?? parameter.default;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${parameter.label} must be finite`);
        return [parameter.key, Math.max(parameter.min, Math.min(parameter.max, value))];
    }));
    view.irView = input.irView === "far" ? "far" : "near";
    return view;
}

/** Near view: the visible camera's field of view on the selected sensor's detector rows, pixel pitch and f-number.
 * The focal length follows the field of view and the aperture follows the f-number, so the point response in
 * detector pixels is the sensor's own. Columns follow the camera's aspect, so the picture frames the visible view.
 * A focal-step lens becomes free optics (its measured residual blur belongs to that lens).
 */
export function nearSensorSettings(settings, camera) {
    const fNumber = settings.focalLengthM / settings.apertureM;
    const focalLengthM = settings.detectorHeight * settings.pixelPitchM / 2 / Math.tan(camera.fov * Math.PI / 360);
    return normalizeSettings({...settings, focalStep: "free", fieldMode: "focalLength", focalLengthM,
        apertureM: focalLengthM / fNumber, digitalZoom: 1,
        detectorWidth: Math.max(1, Math.min(2048, Math.round(settings.detectorHeight * camera.aspect)))});
}

/** Distance in m from a camera to the center of the vehicle's bounding sphere: the range of the near view. */
export function vehicleDistance(camera, bounds) {
    return camera.position.distanceTo(bounds.getBoundingSphere(new Sphere()).center);
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

export function resolveVehicleThermal(recipe, {airTemperatureK, mach, power, canopyPower} = {}) {
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
        canopyPowerFraction: canopyPower ?? null, skinEmissivityMWIR: p.thermalEmissivity}}, airTemperatureK ?? p.thermalAmbientK);
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

// readOnly(parameter) is truthy for a field the host does not let the user edit; a string is shown in the tooltip.
// The menu host evaluates it again on every refresh, so a host can make a field read only for a while.
// The standalone page cannot load src/i18n/en.js, so it keeps this copy of thermal.controlReasons;
// tests/thermalParameterText.test.js requires the two to be identical.
export const CONTROL_REASONS = {
    terrainColor: "Used only with Ground temperature source = Terrain color estimate.",
    materialClasses: "Used only with Ground temperature source = Material classes.",
    groundAutomatic: "Used only with Ground condition = From sun and time; the other conditions are clear or overcast.",
    statisticalSea: "Used only with atmospheric sky and the statistical sea model.",
    swell: "Set a nonzero swell height to use this control.",
    manualSky: "Used only with Sky source = Manual temperature.",
    manualEnvironment: "Used only with Reflected environment source = Manual temperature.",
    atmosphericSky: "Used only with Sky source = Atmosphere.",
    exposure: "Calculated by the reference well-fill exposure policy. Select Manual to edit.",
    wellFill: "Used only with Exposure policy = Reference well fill.",
    noise: "Enable Detector noise to use this control.",
    noiseSeed: "Used for detector noise or a nonzero residual fixed pattern.",
    shading: "Set nonzero Edge shading to use this control.",
    scatter: "Set a nonzero Scatter fraction to use this control.",
    lensStep: "Used only with a preset Focal step.",
    sampling: "Calculated by the Optical Nyquist policy. Select Manual to edit.",
    manualGain: "Used only with Gain mode = Manual.",
    adaptiveGain: "Used only with Automatic or Plateau gain.",
    plateau: "Used only with Gain mode = Plateau equalization.",
    localEnhancement: "Set nonzero Local enhancement to use this control.",
    radiometric: "Used only with Fixed radiometric gain or the Radiance diagnostic view.",
    diffraction: "Enable Diffraction to use this control.",
    wavelengthBlur: "Used only with Diffraction or nonzero turbulence blur.",
    whiteHot: "Used only with White hot polarity.",
};
export function thermalControlReason(key, settings) {
    const s = settings, statisticalSea = s.skySource === "atmosphere" && s.seaMode === "statistical";
    if (key === "groundTemperatureSpanK" && s.groundTemperatureMode !== "color") return "terrainColor";
    if (["groundCondition", "groundClimate", "groundCloudFraction", "groundWindMps", "groundMapData"].includes(key) && s.groundTemperatureMode !== "materials") return "materialClasses";
    if (key === "groundCloudFraction" && s.groundCondition !== "automatic") return "groundAutomatic";
    if (key === "seaMode" && s.skySource !== "atmosphere") return "atmosphericSky";
    if (["seaWindMps", "seaWindDirectionRad", "seaSkinTemperatureK", "seaSwellHeightM", "seaSwellPeriodS", "seaSwellDirectionRad"].includes(key) && !statisticalSea) return "statisticalSea";
    if (["seaSwellPeriodS", "seaSwellDirectionRad"].includes(key) && s.seaSwellHeightM === 0) return "swell";
    if (key === "skyTemperatureK" && s.skySource !== "manual") return "manualSky";
    if (key === "environmentTemperatureK" && s.environmentSource === "skyGround") return "manualEnvironment";
    if (key === "skyGradient" && s.skySource !== "atmosphere") return "atmosphericSky";
    if (key === "integrationTimeS" && s.exposureMode !== "manual") return "exposure";
    if (["wellFillFraction", "wellFillReferenceK"].includes(key) && s.exposureMode !== "wellFill") return "wellFill";
    if (["shotNoiseEnabled", "readNoiseElectrons"].includes(key) && !s.noiseEnabled) return "noise";
    if (key === "noiseSeed" && !s.noiseEnabled && s.fixedPatternFraction === 0) return "noiseSeed";
    if (key === "shadingWidth" && s.shadingK === 0) return "shading";
    if (["scatterSlope", "scatterShoulderRad", "scatterCutoffRad"].includes(key) && s.scatterFraction === 0) return "scatter";
    if (key === "defocusM" && !s.opticsEnabled) return "diffraction";
    if (["opticsRadiusPx", "psfTemperatureK"].includes(key) && !s.opticsEnabled && s.turbulenceR0M === 0) return "wavelengthBlur";
    if (["pupilReferenceM", "pupilPolicy"].includes(key) && s.focalStep === "free") return "lensStep";
    if (key === "supersample" && s.opticalSamplingMode !== "manual") return "sampling";
    if (["fixedGain", "fixedLevel"].includes(key) && s.gainMode !== "manual") return "manualGain";
    if (["gainRegion", "lowPercentile", "highPercentile", "minimumWindowCounts", "agcDynamics", "agcTimeConstantS"].includes(key) && !["automatic", "plateau"].includes(s.gainMode)) return "adaptiveGain";
    if (key === "plateauFactor" && s.gainMode !== "plateau") return "plateau";
    if (key === "localRadiusPx" && s.localAmount === 0) return "localEnhancement";
    if (["radiometricLow", "radiometricHigh"].includes(key) && s.gainMode !== "fixedRadiometric" && s.diagnosticView !== "radiance") return "radiometric";
    if (["polarityAffineGain", "polarityAffineOffset"].includes(key) && s.polarity !== "whiteHot") return "whiteHot";
    return null;
}

export function createThermalControls(mount, getSettings, set, {translate = null, readOnly = () => false, hidden = () => false} = {}) {
    const reasonFor = (parameter, settings) => readOnly(parameter) || (() => {
        const reason = thermalControlReason(parameter.key, settings);
        return reason ? (translate ? translate(`thermal.controlReasons.${reason}`) : CONTROL_REASONS[reason]) : false;
    })();
    // Both widget hosts walk the same descriptors and use the same edit callback.
    if (mount.addFolder) {
        const fields = [], state = {}, folders = [];
        for (const [group, parameters] of thermalControlGroups()) {
            const folder = mount.addFolder(translate(`thermal.groups.${group}`)).close();
            folders.push(folder);
            for (const parameter of parameters) {
                if (hidden(parameter)) continue;
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
                const metadata = settings.presetMetadata?.[parameter.key], reason = reasonFor(parameter, settings);
                control.disable(!!reason);
                control.tooltip(`${translate(parameter.tooltipKey)}\n${translate(`thermal.status.${metadata?.status ?? parameter.status ?? "estimated"}`)}${metadata?.source ? ` · ${metadata.source}` : ""}${typeof reason === "string" ? `\n${reason}` : ""}`);
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
            if (hidden(parameter)) continue;
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
            const reason = reasonFor(parameter, settings);
            input.disabled = !!reason;
            input.title = `${parameter.tooltip}${typeof reason === "string" ? `\n${reason}` : ""}`;
            provenance.textContent = metadata ? `${metadata.overridden ? "Edited · preset " : ""}${metadata.status}` : parameter.status ?? "Model setting · estimated default";
            provenance.title = metadata?.source ?? parameter.tooltip;
        }
    }, dispose() {mount.replaceChildren();}};
}

// viewCamera and orbit are the visible preview's camera and OrbitControls; the near view renders through them.
export function createVehicleThermalPreview({renderer, panel, readout, onChange, onError, viewCamera, orbit}) {
    let settings = normalizeSettings({...settingsForPreset("MX15"), gainMode: "automatic", polarity: "blackHot"});
    // counts and stats are read from the GPU on demand (readCounts), not after every draw; drawn says whether the
    // pipeline holds a frame of the current settings to read.
    let view = normalizeSensorView(), counts, drawn = false, lastSettings, stats, pointer = null, model = null, nearRange = null;
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved) {const nextSettings = normalizeSettings(saved.settings), nextView = normalizeSensorView(saved.view); settings = nextSettings; view = nextView;}
    } catch { /* Disabled storage or an obsolete record must not prevent preview. */ }
    const pipeline = new ThermalPipeline(renderer), camera = new PerspectiveCamera();
    const lifecycle = new AbortController(), hostFields = new Map();
    const host = document.createElement("div"); host.className = "folder-fields sensor-view-fields";
    const note = document.createElement("p"); note.className = "folder-note";
    host.append(note); panel.append(host);
    const viewLabel = document.createElement("label"), viewSelect = document.createElement("select");
    viewLabel.className = "field thermal-field"; viewLabel.textContent = "IR view";
    for (const [value, text] of Object.entries(IR_VIEWS)) viewSelect.add(new Option(text, value));
    viewSelect.addEventListener("change", () => edit("irView", viewSelect.value));
    viewLabel.append(viewSelect); host.append(viewLabel);
    // Near: the orbit camera's distance to the vehicle, shared with the visible preview (scroll zoom changes it too).
    const distanceLabel = document.createElement("label"), distanceInput = document.createElement("input");
    distanceLabel.className = "field thermal-field"; distanceLabel.textContent = "Distance to the vehicle · m";
    distanceInput.type = "number"; distanceInput.min = .1; distanceInput.max = 300000; distanceInput.step = .1;
    distanceInput.addEventListener("change", () => edit("nearDistanceM", distanceInput.valueAsNumber));
    distanceLabel.append(distanceInput); host.append(distanceLabel);
    const farLabels = [];
    for (const parameter of SENSOR_VIEW_PARAMETERS) {
        const label = document.createElement("label"), input = document.createElement("input");
        label.className = "field thermal-field"; label.textContent = `${parameter.label} · ${parameter.unit}`;
        input.type = "number"; input.min = parameter.min; input.max = parameter.max; input.step = parameter.step;
        input.addEventListener("change", () => edit(parameter.key, input.valueAsNumber));
        label.append(input); host.append(label); hostFields.set(parameter.key, input); farLabels.push(label);
    }
    const schemaMount = document.createElement("div"); panel.append(schemaMount);
    const controls = createThermalControls(schemaMount, () => settings, edit);
    const near = () => view.irView === "near" && !!viewCamera;
    function refresh() {
        controls.refresh(); viewSelect.value = view.irView;
        for (const [key, input] of hostFields) input.value = view[key];
        for (const label of farLabels) label.hidden = near();
        distanceLabel.hidden = !near();
        if (near() && model) distanceInput.value = vehicleDistance(viewCamera, model.bounds).toFixed(1);
        note.textContent = near() ?
            "IR preview from the visible preview's camera: drag to orbit, scroll to zoom. The selected sensor's detector rows, pixel pitch and f-number with this field of view. Uniform cold sky; surface temperatures and electronics are estimates." :
            "IR sensor preview · uniform cold sky. Surface temperatures, aperture, scatter and electronics are estimates. Aspect rotates around the vehicle; atmospheric elevation is a separate ray setting. Fit preserves range.";
    }
    function persist() {try {localStorage.setItem(STORAGE_KEY, JSON.stringify({settings, view}));} catch { /* Optional storage. */ }}
    // Moves the shared orbit camera along its line from the vehicle's center, keeping the direction of view.
    function setNearDistance(distanceM) {
        if (!viewCamera || !model) throw new Error("The near view needs the visible preview's camera and a vehicle");
        if (!(distanceM > 0) || !Number.isFinite(distanceM)) throw new Error("Distance must be positive and finite");
        const sphere = model.bounds.getBoundingSphere(new Sphere());
        if (distanceM <= sphere.radius * 1e-3) throw new Error("Distance must place the camera outside the vehicle's center");
        const direction = viewCamera.position.clone().sub(sphere.center);
        if (direction.lengthSq() === 0) direction.set(0, 0, 1);
        viewCamera.position.copy(sphere.center).addScaledVector(direction.normalize(), distanceM);
        viewCamera.far = Math.max(viewCamera.far, distanceM + 4 * sphere.radius); viewCamera.updateProjectionMatrix();
        if (orbit) {orbit.target.copy(sphere.center); orbit.update();}
    }
    function set(key, value) {
        if (key === "irView") {
            if (!(value in IR_VIEWS)) throw new Error(`Unknown IR view: ${value}`);
            view = normalizeSensorView({...view, irView: value});
        } else if (key === "nearDistanceM") setNearDistance(value);
        else if (hostFields.has(key)) view = normalizeSensorView({...view, [key]: value});
        else if (key === "sensorPreset") settings = settingsForPreset(value);
        else {
            if (!THERMAL_PARAMETERS.some(parameter => parameter.key === key)) throw new Error(`Unknown thermal setting: ${key}`);
            const fieldMode = key === "focalLengthM" ? "focalLength" : key === "verticalFovDeg" ? "fieldOfView" : settings.fieldMode;
            settings = normalizeSettings({...settings, [key]: value, fieldMode});
        }
        counts = null; drawn = false; refresh(); persist(); onError(""); onChange();
    }
    function edit(key, value) {try {set(key, value);} catch (error) {onError(error.message); refresh();}}
    const geometryReadout = document.createElement("div"), countReadout = document.createElement("div"); readout.append(geometryReadout, countReadout);
    function readCounts() {
        if (!counts && drawn) {counts = pipeline.readDetectorCounts(); stats = detectorStatistics(counts);}
        return counts;
    }
    function showCounts() {
        if (!readCounts()) {countReadout.textContent = "Detector counts · waiting for a frame"; return;}
        const pixel = pointer && detectorPixelAt(pointer.x, pointer.y, renderer.domElement.getBoundingClientRect(), lastSettings);
        countReadout.textContent = `14-bit counts · pointer ${pixel ? `${counts[pixel.index]} [${pixel.column}, ${pixel.row}]` : "—"} · min ${stats.min} · max ${stats.max} · median ${stats.median}`;
    }
    renderer.domElement.addEventListener("pointermove", event => {pointer = {x: event.clientX, y: event.clientY}; showCounts();}, {signal: lifecycle.signal});
    renderer.domElement.addEventListener("pointerleave", () => {pointer = null; showCounts();}, {signal: lifecycle.signal});
    const debug = {pipeline, get settings() {return {...settings, ...view};}, set, readDetectorCounts: () => pipeline.readDetectorCounts(),
        get viewCamera() {return viewCamera;}, get nearRange() {return nearRange && {...nearRange};}};
    const detachDebug = attachThermalDebug(window, debug);
    refresh();
    // Both views use the real distance for the atmospheric path and as the point-response range (psfRangeM).
    function ensureAtmosphereRange(requiredRangeM) {
        if (settings.atmosphereMaxRangeM >= requiredRangeM) return;
        settings = normalizeSettings({...settings, atmosphereMaxRangeM: Math.ceil(requiredRangeM)}); refresh(); persist();
    }
    function renderFar(scene, vehicle, frame) {
        const scale = configureSensorCamera(camera, vehicle.bounds, settings, view);
        ensureAtmosphereRange(scale.requiredRangeM);
        withThermalVehicle(vehicle, () => pipeline.render({scene, camera, settings, frame, psfRangeM: view.rangeM}));
        lastSettings = {...settings};
        geometryReadout.textContent = `Far · ${view.rangeM.toLocaleString()} m · FOV ${scale.verticalFovDeg.toFixed(3)}° V × ${scale.horizontalFovDeg.toFixed(3)}° H · ${scale.pixelSizeM.toFixed(3)} m / detector pixel · aspect ${view.azimuthDeg}°, ${view.elevationDeg}°`;
    }
    function renderNear(scene, vehicle, frame) {
        const nearSettings = nearSensorSettings(settings, viewCamera);
        const distanceM = vehicleDistance(viewCamera, vehicle.bounds);
        const radius = vehicle.bounds.getBoundingSphere(new Sphere()).radius;
        ensureAtmosphereRange(distanceM + Math.max(10, 2 * radius));
        // The point-response range follows the distance once it has been still for NEAR_RANGE_SETTLE_MS.
        const now = performance.now();
        if (!nearRange || distanceM !== nearRange.latest) nearRange = {applied: nearRange?.applied ?? distanceM, latest: distanceM, since: now};
        if (nearRange.applied !== nearRange.latest && now - nearRange.since >= NEAR_RANGE_SETTLE_MS) nearRange.applied = nearRange.latest;
        withThermalVehicle(vehicle, () => pipeline.render({scene, camera: viewCamera, settings: nearSettings, frame, psfRangeM: nearRange.applied}));
        lastSettings = {...nearSettings};
        if (document.activeElement !== distanceInput) distanceInput.value = distanceM.toFixed(1);
        const half = Math.tan(nearSettings.verticalFovDeg * Math.PI / 360);
        const horizontalFovDeg = 2 * Math.atan(half * nearSettings.detectorWidth / nearSettings.detectorHeight) * 180 / Math.PI;
        geometryReadout.textContent = `Near · ${distanceM.toFixed(1)} m to the vehicle · FOV ${nearSettings.verticalFovDeg.toFixed(2)}° V × ${horizontalFovDeg.toFixed(2)}° H · ${(2 * distanceM * half / nearSettings.detectorHeight).toFixed(3)} m / detector pixel at the vehicle · ${nearSettings.detectorWidth} × ${nearSettings.detectorHeight} detector · f/${(nearSettings.focalLengthM / nearSettings.apertureM).toFixed(2)}${nearRange.applied !== distanceM ? " · point response updating" : ""}`;
    }
    return {pipeline, get settings() {return settings;}, get view() {return view;}, set,
        /** True when the IR picture renders through the visible preview's camera (its orbit stays active). */
        get usesViewCamera() {return near();},
        /** showCounts: false leaves the count readout to the next pointer move (a frame that only advances the
         * detector noise needs no synchronous GPU readback). */
        render(scene, vehicle, frame, {showCounts: show = true} = {}) {
            counts = null; drawn = false; model = vehicle;
            try {
                if (near()) renderNear(scene, vehicle, frame); else renderFar(scene, vehicle, frame);
                drawn = true;
            } finally {if (show) showCounts();}
        },
        dispose() {
            lifecycle.abort(); pipeline.dispose(); controls.dispose(); panel.replaceChildren(); readout.replaceChildren();
            detachDebug();
        },
    };
}
