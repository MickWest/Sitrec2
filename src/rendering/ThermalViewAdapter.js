import {Vector3} from "three";
import {ThermalPipeline} from "../../tools/thermal/ThermalPipeline.js";
import {normalizeSettings, settingsForPreset, THERMAL_PARAMETERS} from "../../tools/thermal/thermalSchema.js";
import {SENSOR_PRESETS} from "../../tools/thermal/sensorPresets.js";
import {integrateTurbulence} from "../../tools/thermal/turbulence.js";
import {integrationTime} from "../../tools/thermal/sensorMath.js";
import {attachThermalDebug, configureSensorCamera, createThermalControls, resolveVehicleThermal} from "../../tools/vehicles/thermalPreview.js";
import {VEHICLE_THERMAL_GROUP} from "../../tools/vehicles/thermalTags.js";
import {GlobalDateTimeNode, Globals, markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {getCelestialDirection} from "../CelestialMath";
import {par} from "../par";
import {ellipsoidAltitude, terrestrialOptsFrom} from "../atmosphere/terrestrialRefraction";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {t} from "../i18n";
import {thermalStatus} from "./ThermalLoader";
import {createThermalReuseKey, createThermalSceneAdapter, sceneVehicleThermal, thermalSceneAtmosphere, withThermalRefraction, withThermalScene} from "./ThermalSceneAdapters";

/** Estimated plausibility warning, not a certified operating limit. The 0.95
 * Mach threshold is a conservative subsonic transport-jet check; no speed is capped.
 * Other classes have no assigned limit here without a supported class envelope.
 */
export function thermalMachWarning(state, recipe) {
    const p = recipe?.parameters;
    const airliner = p?.bodyStyle === "transport" && p?.engineType === "jet" &&
        (!p.vehicleType || p.vehicleType === "aircraft");
    if (!airliner || state.sources?.mach === "override" || !(state.mach > 0.95)) return "";
    return `Warning: scene-derived Mach ${state.mach.toFixed(3)} is implausible for an airliner (estimated threshold 0.95). Check the track speed, or use Object → Thermal surface → Vehicle thermal state → Mach → Override.`;
}

export function thermalSettings(cameraNode, sit) {
    return normalizeSettings({gainMode: "automatic", polarity: "blackHot", turbulenceMode: "geometry", seaMode: "statistical",
        ...cameraNode.thermalSensor, ...sit.thermalEnvironment});
}

/** One row of per-frame camera data (a cameraState row) applied to the saved settings for one frame. Pure: it returns
 * new settings and never writes the saved ones. Only an infrared row applies: its focal length selects the preset's
 * lens step of that focal length, and its polarity, when the row gives one, replaces the saved polarity. A focal
 * length that is not a lens step of the preset, or a step that the saved pupil policy cannot use, keeps the saved
 * lens. Digital zoom is not applied here: it reaches the sensor once, through the look camera's field of view.
 * report says what applied; it is null when the row does not apply. */
export function thermalSettingsForCameraState(settings, state) {
    if (state?.band !== "IR") return {settings, report: null};
    const report = {row: state, lens: "saved", reason: null, message: null, polarity: state.polarity == null ? "saved" : "row"};
    const polarity = state.polarity ?? settings.polarity;
    const steps = SENSOR_PRESETS[settings.sensorPreset]?.focalSteps;
    const step = String(state.focalLengthMm);
    let focalStep = null;
    if (!steps) report.reason = "noSteps";
    else if (!Object.hasOwn(steps, step)) report.reason = "notStep";
    else {
        report.lens = "step";
        if (step !== settings.focalStep) focalStep = step;
    }
    if (!focalStep && polarity === settings.polarity) return {settings, report};
    try {
        return {settings: normalizeSettings({...settings, polarity, ...(focalStep ? {focalStep} : {})}), report};
    } catch (error) {
        // For example Keep pupil at a short step: the pupil would exceed twice the focal length.
        if (!(error instanceof RangeError) || !focalStep) throw error;
        return {settings: polarity === settings.polarity ? settings : normalizeSettings({...settings, polarity}),
            report: {...report, lens: "saved", reason: "invalid", message: error.message}};
    }
}

// Without recorded lens data, infer the closest preset step from the unzoomed
// camera field. This is an estimate, not an optical measurement. Presentation
// zoom, pan, aspect and compression must not select a different physical lens.
export function thermalSettingsForViewField(settings, verticalFovDeg) {
    const steps = SENSOR_PRESETS[settings.sensorPreset]?.focalSteps;
    if (!steps || !(verticalFovDeg > 0 && verticalFovDeg < 180))
        return {settings, report: null};
    const tangent = Math.tan(verticalFovDeg * Math.PI / 360);
    const error = key => Math.abs(Math.log(tangent / (steps[key].windowHeight.value *
        settings.pixelPitchM / (2 * steps[key].focalLengthM.value))));
    const step = Object.keys(steps).reduce((best, key) => error(key) < error(best) ? key : best,
        Object.hasOwn(steps, settings.focalStep) ? settings.focalStep : Object.keys(steps)[0]);
    try {
        return {settings: step === settings.focalStep ? settings : normalizeSettings({...settings, focalStep: step}),
            report: {focalLengthMm: Number(step), verticalFovDeg, reason: null}};
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return {settings, report: {focalLengthMm: Number(step), verticalFovDeg, reason: error.message}};
    }
}

// A lens step counts as validated when the preset holds a value measured at that step, that is, compared with a
// recording made at it. Steps with only published or calculated values were never checked against a picture.
export function lensStepValidated(settings) {
    const step = SENSOR_PRESETS[settings.sensorPreset]?.focalSteps?.[settings.focalStep];
    return !step || Object.values(step).some(value => value?.status === "measured");
}

const millimeters = meters => +(meters * 1000).toFixed(1);

// Readout lines for per-frame camera data and the lens of this frame. building is {focalM, previousFocalM} while the
// image still shows the previous lens's optics because those of the new lens are being built, otherwise null.
function cameraDataLines(report, settings, building) {
    const lines = [];
    if (report) {
        const row = report.row, polarity = t(`thermal.parameters.polarity.options.${settings.polarity}`);
        lines.push(t("thermal.cameraData.row", {mode: row.mode, focal: row.focalLengthMm, frame: row.frame,
            polarity: report.polarity === "saved" ? t("thermal.cameraData.savedPolarity", {polarity}) : polarity}));
        if (report.reason) lines.push(t(`thermal.cameraData.${report.reason}`, {focal: row.focalLengthMm,
            saved: millimeters(settings.focalLengthM), message: report.message}));
    }
    if (building) lines.push(t("thermal.cameraData.previousLens",
        {focal: millimeters(building.focalM), previous: millimeters(building.previousFocalM)}));
    if (!lensStepValidated(settings)) lines.push(t("thermal.unvalidatedStep", {focal: settings.focalStep}));
    const sampling = settings.opticalSampling;
    if (sampling?.nyquistMet === false) lines.push(t("thermal.nyquistNotMet", {factor: sampling.factor,
        required: sampling.requiredFactor.toFixed(1), fNumber: (settings.focalLengthM / settings.apertureM).toFixed(2)}));
    return lines;
}

// Optics that a driven lens step replaces. While the camera data drives them they show the driven values, and an
// edit would change the saved lens behind them (an edit of the field also turns the saved step to Free).
const DRIVEN_OPTICS = new Set(["focalStep", "focalLengthM", "verticalFovDeg", "fieldMode", "apertureM"]);
// These are generic authoring defaults or presentation metadata, not Look View controls.
export const THERMAL_LOOK_HIDDEN = new Set(["objectTemperatureK", "emissivity", "pictureWidth", "pictureHeight",
    "sunDirectionX", "sunDirectionY", "sunDirectionZ"]);

export function thermalSolarGeometry(position, date, radii = Globals, direction = getCelestialDirection) {
    const sun = direction("Sun", date, position)?.normalize();
    if (!sun) throw new Error("Cannot calculate the thermal Sun direction for this scene time.");
    const up = new Vector3(position.x / radii.equatorRadius ** 2,
        position.y / radii.equatorRadius ** 2, position.z / radii.polarRadius ** 2).normalize();
    const east = new Vector3(-position.y, position.x, 0).normalize(), north = new Vector3().crossVectors(up, east);
    return {direction: sun, elevationDeg: Math.asin(Math.max(-1, Math.min(1, sun.dot(up)))) * 180 / Math.PI,
        azimuthDeg: (Math.atan2(sun.dot(east), sun.dot(north)) * 180 / Math.PI + 360) % 360};
}

export function saveThermalSettings(settings, cameraNode, sit) {
    const sensor = {}, environment = {};
    for (const parameter of THERMAL_PARAMETERS) {
        if (parameter.owner === "sensor") sensor[parameter.key] = settings[parameter.key];
        if (parameter.owner === "environment") environment[parameter.key] = settings[parameter.key];
    }
    sensor.presetMetadata = settings.presetMetadata;
    // Look View host policy; standalone sensor settings do not contain it.
    if (cameraNode.thermalSensor?.lensSource) sensor.lensSource = cameraNode.thermalSensor.lensSource;
    // Sounding data is supplied by the host, never a URL fetched by the renderer.
    if (sit.thermalEnvironment?.sounding) environment.sounding = sit.thermalEnvironment.sounding;
    cameraNode.thermalSensor = sensor; sit.thermalEnvironment = environment;
}

// Calculated pinhole mapping: native tan(half-field) = detector extent / (2 f).
// The prepared projection includes camera zoom, video pan and vertical compression.
// It maps presentation pixels to native detector coordinates, never back to optics.
export function thermalFieldMapping(camera, settings) {
    const p = camera.projectionMatrix.elements;
    const tangentY = settings.detectorHeight * settings.pixelPitchM / (2 * settings.focalLengthM);
    const tangentX = settings.detectorWidth * settings.pixelPitchM / (2 * settings.focalLengthM);
    const scale = [1 / (p[0] * tangentX), 1 / (p[5] * tangentY)];
    return {scale, offset: [p[8] * scale[0] / 2, p[9] * scale[1] / 2],
        nativeVerticalFovDeg: 2 * Math.atan(tangentY) * 180 / Math.PI,
        nativeHorizontalFovDeg: 2 * Math.atan(tangentX) * 180 / Math.PI,
        effectiveDigitalZoom: Math.max(1, settings.digitalZoom / scale[1]),
        fieldMagnification: settings.digitalZoom / scale[1]};
}

// Altitude is height above mean sea level (h_ellipsoid = h_MSL + N): the thermal sea and the atmosphere
// profile begin at sea level, where Sitrec puts terrain and track altitudes. The ellipsoid can lie tens of
// metres above or below it, more than the height of a ship's camera.
export function thermalGeometry(camera, target, radii = Globals, geoidHeight = meanSeaLevelOffset) {
    camera.updateWorldMatrix(true, false);
    const position = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const up = new Vector3(position.x / radii.equatorRadius ** 2,
        position.y / radii.equatorRadius ** 2, position.z / radii.polarRadius ** 2).normalize();
    const skyUp = up.clone().transformDirection(camera.matrixWorldInverse);
    const lla = ECEFToLLAVD_radii(position);
    const sensorAltitudeM = Math.max(0, ellipsoidAltitude(position, radii.equatorRadius, radii.polarRadius)
        - geoidHeight(lla.x, lla.y));
    const pathElevationDeg = Math.asin(Math.max(-1, Math.min(1, -skyUp.z))) * 180 / Math.PI;
    const relative = target?.clone().sub(position);
    const rangeM = relative?.length();
    return {position, skyUp, sensorAltitudeM, pathElevationDeg, rangeM,
        path: rangeM > 0 ? {sensorAltitudeM, slantRangeM: rangeM,
            elevationRad: Math.asin(Math.max(-1, Math.min(1, relative.dot(up) / rangeM)))} : null};
}

export function createThermalViewAdapter(view) {
    // Unit-mass kernel L1 error bounds radiance error by 0.1% of maximum scene contrast. Retaining this certified
    // response longer avoids frequent spectrum rebuilds; synchronous captures still use the exact current kernel.
    const pipeline = new ThermalPipeline(view.renderer, {analysis: false, opticsToleranceL1: .001, onReady: () => setRenderOne(true),
        createOpticsWorker: () => import("./ThermalWorkerFactory.js").then(module => module.createOpticsWorker()),
        createAtmosphereWorker: () => import("./ThermalWorkerFactory.js").then(module => module.createAtmosphereWorker())});
    let controls, lastSettings, mapping, geometry, turbulence, turbulenceKey, comparisonPipeline, comparison;
    let atmosphere, atmosphereKey, vehicles = [], solar;
    // What the camera data drives at the last drawn frame, and the focal length of the last frame drawn with validated
    // optics (for the readout while a new lens builds).
    let drive = {lens: false, polarity: false, field: false}, cameraData = null, fieldLens = null, validatedFocalM = null;
    // Estimated budget: a paused frame's key costs a few ms in a scene with hundreds of meshes, against ~80 ms for
    // the full render it can save; a key that runs out of budget only disables reuse for that draw.
    const reuseKey = createThermalReuseKey({budgetMs: 10});
    const settings = () => lastSettings ?? thermalSettings(view.cameraNode, Sit);
    const lensSource = () => {
        const saved = view.cameraNode.thermalSensor;
        // Keep explicitly authored optics in old saves. Unconfigured sensors
        // follow the host field; subsequent edits store that host policy.
        return saved?.lensSource ?? (saved && [...DRIVEN_OPTICS].some(key => Object.hasOwn(saved,key)) ? "sensor" : "view");
    };
    function set(key, value) {
        if (key === "lensSource") {
            if (!["view", "sensor"].includes(value)) throw new RangeError("Invalid thermal lens source");
            if (value === "sensor" && drive.field && lastSettings) saveThermalSettings(lastSettings, view.cameraNode, Sit);
            view.cameraNode.thermalSensor = {...view.cameraNode.thermalSensor, lensSource: value};
            drive.field = false;
            lastSettings = null; controls?.refresh(); markSitchDirty(); setRenderOne(true);
            return;
        }
        const current = thermalSettings(view.cameraNode, Sit), source = lensSource();
        let next;
        if (key === "sensorPreset") {
            const preset = settingsForPreset(value);
            next = {...current, ...Object.fromEntries(THERMAL_PARAMETERS.filter(p => p.owner === "sensor")
                .map(p => [p.key, preset[p.key]])), presetMetadata: preset.presetMetadata, turbulenceMode: current.turbulenceMode};
        } else {
            const parameter = THERMAL_PARAMETERS.find(p => p.key === key);
            if (!parameter || parameter.owner === "geometry" || parameter.key.startsWith("sunDirection") || key === "psfRangeM")
                throw new Error(t("thermal.readOnly"));
            next = {...current, [key]: value};
            if (key === "focalLengthM") next.fieldMode = "focalLength";
            if (key === "verticalFovDeg") next.fieldMode = "fieldOfView";
        }
        saveThermalSettings(normalizeSettings(next), view.cameraNode, Sit);
        view.cameraNode.thermalSensor.lensSource = source;
        // Explicit optical edits remain authoritative, including API edits.
        if (DRIVEN_OPTICS.has(key)) {view.cameraNode.thermalSensor.lensSource = "sensor"; drive.field = false;}
        lastSettings = null; controls?.refresh(); markSitchDirty(); setRenderOne(true);
    }
    const readOnly = parameter => {
        if (parameter.owner === "geometry" || parameter.key === "psfRangeM") return t("thermal.readOnly");
        if ((drive.lens && DRIVEN_OPTICS.has(parameter.key)) || (drive.polarity && parameter.key === "polarity"))
            return t("thermal.cameraData.readOnly");
        if (drive.field && DRIVEN_OPTICS.has(parameter.key)) return t("thermal.viewLens.readOnly");
        if (parameter.key === "turbulenceR0M" && settings().turbulenceMode === "geometry") return t("thermal.controlReasons.turbulence");
        const smoothSea = settings().skySource === "atmosphere" && settings().seaMode === "smooth";
        if (Sit.thermalEnvironment?.sounding && (parameter.key === "waterVaporDensityKgM3" ||
            parameter.key === "surfaceTemperatureK" && !smoothSea))
            return t("thermal.controlReasons.sounding");
        return false;
    };
    if (view._thermalFolder) {
        controls = createThermalControls(view._thermalFolder, settings, set,
            {translate: t, readOnly, hidden: parameter => THERMAL_LOOK_HIDDEN.has(parameter.key)});
        const optics = view._thermalFolder.folders.find(folder => folder._title === t("thermal.groups.optics"));
        const policy = {get lensSource() {return lensSource();}, set lensSource(value) {set("lensSource", value);}};
        optics.add(policy, "lensSource", {[t("thermal.viewLens.view")]: "view", [t("thermal.viewLens.sensor")]: "sensor"})
            .name(t("thermal.viewLens.title")).listen().tooltip(t("thermal.viewLens.tooltip"));
        controls.refresh();
    }
    const debug = {pipeline, get settings() {return settings();}, get mapping() {return mapping;},
        get geometry() {return geometry;}, get turbulence() {return turbulence;}, set,
        get solar() {return solar;},
        get vehicles() {return vehicles;}, get cameraData() {return cameraData;},
        get fieldLens() {return fieldLens;},
        get comparison() {return comparison;},
        compareWith(otherPipeline) {comparisonPipeline = otherPipeline; comparison = null; setRenderOne(true);},
        readDetectorCounts: () => pipeline.readDetectorCounts(), readStage: name => pipeline.readStage(name),
        // Why the last paused frame could not be reused (null when a key was built).
        get reuseKeyNullReason() {return reuseKey.lastNullReason;}};
    const detachDebug = typeof window === "undefined" ? () => {} : attachThermalDebug(window, debug, "lookThermal");
    return {pipeline, set, render(scene, frame, baseVerticalFovDeg = view.camera.fov) {
        // Per-frame camera data sets this frame's lens step and polarity; the saved settings stay unchanged.
        cameraData = thermalSettingsForCameraState(thermalSettings(view.cameraNode, Sit),
            NodeMan.get("cameraState", false)?.stateAt(frame) ?? null);
        let configured = cameraData.settings;
        fieldLens = !cameraData.report && lensSource() === "view" ? thermalSettingsForViewField(configured, baseVerticalFovDeg) : null;
        if (fieldLens) configured = fieldLens.settings;
        const nextDrive = {lens: cameraData.report?.lens === "step", polarity: cameraData.report?.polarity === "row",
            field: !!fieldLens?.report && !fieldLens.report.reason};
        const refreshControls = Object.keys(nextDrive).some(key => nextDrive[key] !== drive[key]) ||
            lastSettings?.focalStep !== configured.focalStep;
        drive = nextDrive;
        const targetFrame = par.trackToTrackStopAt > 0 ? Math.min(frame, par.trackToTrackStopAt) : frame;
        const target = NodeMan.get("targetTrackSwitchSmooth", false)?.p(targetFrame);
        geometry = thermalGeometry(view.camera, target);
        // Use the astronomical Sun, independent of visible-light overrides or Moon lighting.
        solar = thermalSolarGeometry(geometry.position, GlobalDateTimeNode?.dateNow ?? new Date(Sit.nowTime ?? Sit.startTime));
        if (configured.turbulenceMode === "geometry") {
            if (!geometry.path) throw new Error(t("thermal.noTarget"));
            const key = JSON.stringify(geometry.path);
            if (key !== turbulenceKey) {turbulence = integrateTurbulence(geometry.path); turbulenceKey = key;}
            configured.turbulenceR0M = Number.isFinite(turbulence.r0ReferenceM) ? turbulence.r0ReferenceM : 0;
        }
        configured = normalizeSettings({...configured, sensorAltitudeM: geometry.sensorAltitudeM,
            pathElevationDeg: geometry.pathElevationDeg, frameRateHz: Sit.fps, psfRangeM: geometry.rangeM ?? 0,
            sunDirectionX: solar.direction.x, sunDirectionY: solar.direction.y, sunDirectionZ: solar.direction.z});
        // Show the exposure actually used, rather than the dormant saved manual exposure.
        if (configured.exposureMode === "wellFill") configured.integrationTimeS = integrationTime(configured);
        mapping = thermalFieldMapping(view.camera, configured);
        const camera = view.camera.clone(false);
        configureSensorCamera(camera, null, configured);
        // Preserve world pose even if the view camera belongs to a transformed parent.
        camera.matrixAutoUpdate = false; camera.matrixWorldAutoUpdate = false;
        camera.matrix.copy(view.camera.matrixWorld); camera.matrixWorld.copy(view.camera.matrixWorld);
        camera.matrixWorldInverse.copy(view.camera.matrixWorldInverse);
        const objects = [], clouds = [];
        NodeMan.iterate((id, node) => {if (node.isThermalObject) objects.push(node); if (node.isThermalCloud) clouds.push(node);});
        const sounding = Sit.thermalEnvironment?.sounding;
        const profileKey = JSON.stringify([configured.surfaceTemperatureK, configured.waterVaporDensityKgM3,
            configured.visibilityM, configured.atmosphereEnabled, sounding]);
        if (profileKey !== atmosphereKey) {
            atmosphere = thermalSceneAtmosphere(configured, sounding); atmosphereKey = profileKey;
        }
        const vehicleValues = new Map(), windField = NodeMan.get("windField", false);
        for (const node of objects) {
            node._thermalSceneState = null;
            if (!node.proceduralModel || node.thermal?.mode === "uniform" || !(node.model ?? node.object)) continue;
            const state = sceneVehicleThermal(node, frame, atmosphere, {windField,
                atmosphereSource: sounding ? "sounding" : "standard"});
            node._thermalSceneState = state; vehicleValues.set(node, state);
        }
        vehicles = [...vehicleValues.values()];
        const terrain = NodeMan.get("TerrainModel", false);
        const groundRoots = [terrain?.getGroup(), terrain?.UI?.oceanSurfaceGroup, terrain?.UI?.buildingsNode?.group];
        const options = terrestrialOptsFrom(Sit, Globals);
        const radianceAdapter = createThermalSceneAdapter(objects, groundRoots, camera, options, clouds);
        // Playback can place par.frame between video frames (for example 126.5). The scene uses that exact
        // time; the detector's noise, temporal filter and gain count whole frames, so it gets the frame in progress.
        // While playing, further draws inside a frame that already rendered show that frame's image (holdFrame).
        // GPU pacing (pace) applies only to the main loop's draws, which repeat on the next animation frame. An export,
        // a screenshot or a pending comparison reads the image right after this render, so it always gets its frame.
        const inputs = {
            scene, camera, settings: configured, frame: Math.max(0, Math.floor(frame)), skyUp: geometry.skyUp,
            sounding, radianceAdapter, presentation: mapping, psfRangeM: geometry.rangeM ?? 0, holdFrame: !par.paused,
            pace: Globals.inMainViewRender === true && !comparisonPipeline,
            // Two frames in flight while playing, once no readback waits behind the other frame (GPU gain statistics,
            // or a gain mode without statistics). Paused, a seek renders as soon as the GPU is free.
            framesInFlight: !par.paused && (pipeline.gpuGain || !["automatic", "plateau"].includes(configured.gainMode)) ? 2 : 1,
        };
        withThermalRefraction(camera, options, () => withThermalScene(objects, () => {
            // Resolve vehicle tags and visibility before recording the exact inputs. Only a paused view can reuse a
            // frame (during playback the frame changes, and draws inside one frame are held), so only then is a key built.
            inputs.reuseKey = par.paused ? reuseKey({...inputs, viewCamera: view.camera, objects, groundRoots, clouds,
                atmosphereKey, refractionOptions: options}) : null;
            const ready = pipeline.render(inputs);
            if (ready === false) return;
            if (comparisonPipeline) {
                const other = comparisonPipeline; comparisonPipeline = null;
                // Native counts precede gain, so histories do not affect comparison.
                other.render(inputs);
                const lookCounts = pipeline.readDetectorCounts(), designerCounts = other.readDetectorCounts();
                let maxCountDifference = 0, squareError = 0;
                for (let i = 0; i < lookCounts.length; i++) {
                    const difference = Math.abs(lookCounts[i] - designerCounts[i]);
                    maxCountDifference = Math.max(maxCountDifference, difference); squareError += difference ** 2;
                }
                comparison = {frame, width: configured.detectorWidth, height: configured.detectorHeight,
                    maxCountDifference, rmsCountDifference: Math.sqrt(squareError / lookCounts.length),
                    lookCounts, designerCounts};
            }
        }, vehicleValues));
        lastSettings = configured;
        if (refreshControls) controls?.refresh();
        if (pipeline.hasFrame === false) {thermalStatus(view, "loading"); return;}
        // pipeline.settings belong to the image now shown (a held or reused draw keeps the earlier image). Retained full
        // kernels ("retained") after a lens change are the previous lens's: they were installed on the last image drawn
        // with validated optics. A coarse preview is a different state, which the optics message reports.
        const optics = pipeline.lastFrame?.opticsCache, shown = pipeline.settings;
        if (optics && shown && !optics.outsideValidatedDomain) validatedFocalM = shown.focalLengthM;
        const building = optics?.outsideValidatedDomain && optics.quality === "retained" && shown &&
            validatedFocalM !== null && validatedFocalM !== shown.focalLengthM
            ? {focalM: shown.focalLengthM, previousFocalM: validatedFocalM} : null;
        thermalStatus(view, "readout", {width: configured.detectorWidth, height: configured.detectorHeight,
            vertical: mapping.nativeVerticalFovDeg.toFixed(6), horizontal: mapping.nativeHorizontalFovDeg.toFixed(6),
            zoom: mapping.effectiveDigitalZoom.toFixed(3), r0: configured.turbulenceR0M.toPrecision(4)},
        [...cameraDataLines(cameraData.report, configured, building),
        ...(fieldLens?.report ? [fieldLens.report.reason ? t("thermal.viewLens.invalid", {
            focal: fieldLens.report.focalLengthMm, message: fieldLens.report.reason}) : t("thermal.viewLens.estimate", {
            focal: fieldLens.report.focalLengthMm, field: fieldLens.report.verticalFovDeg.toFixed(3)})] : []),
        t("thermal.sunGeometry", {azimuth: solar.azimuthDeg.toFixed(2), elevation: solar.elevationDeg.toFixed(2)}),
        ...(configured.groundTemperatureMode === "color" && configured.groundTemperatureSpanK > 0 ?
            [t("thermal.terrainTemperatureEstimate", {
                low: (configured.groundTemperatureK - configured.groundTemperatureSpanK / 2).toFixed(2),
                high: (configured.groundTemperatureK + configured.groundTemperatureSpanK / 2).toFixed(2)})] : []),
        ...(pipeline.lastFrame?.opticsCache?.message ? [pipeline.lastFrame.opticsCache.message] : []),
        ...(pipeline.lastFrame?.coverage?.tiles > pipeline.lastFrame?.coverage?.refined ? [t("thermal.coverageLimited",
            {refined: pipeline.lastFrame.coverage.refined, tiles: pipeline.lastFrame.coverage.tiles})] : []),
        ...(pipeline.lastFrame?.clouds?.diagnostics ?? []).map(d => t(`thermal.cloudDiagnostics.${d.code}`, {id: d.id})),
        ...(pipeline.lastFrame?.clouds?.sheets ? [t("thermal.cloudCost", {count: pipeline.lastFrame.clouds.visible,
            prepareMs: (pipeline.lastFrame.clouds.prepareMs + (pipeline.lastFrame.clouds.hostPrepareMs ?? 0)).toFixed(2), sortMs: pipeline.lastFrame.clouds.sortMs.toFixed(2),
            draws: pipeline.lastFrame.clouds.drawCalls})] : []),
        ...(configured.seaMode === "statistical" ? [t("thermal.seaDiagnostic")] : []),
        ...vehicles.map(state => {
            const warning = thermalMachWarning(state, objects.find(node => node.id === state.id)?.proceduralModel?.recipe);
            return t("thermal.vehicleReadout", {id: state.id, altitudeM: state.altitudeM.toFixed(0),
            airTemperatureK: state.airTemperatureK.toFixed(2), mach: state.mach.toFixed(3), power: state.power.toFixed(3),
            speedMps: state.speedMps.toFixed(2), speedSource: t(`thermal.vehicleSources.${state.speedSource}`),
            airSource: t(`thermal.vehicleSources.${state.sources.airTemperatureK}`),
            machSource: t(`thermal.vehicleSources.${state.sources.mach}`),
            powerSource: t(`thermal.vehicleSources.${state.sources.power}`)}) + (warning ? ` ${warning}` : "");
        })]);
    }, dispose() {
        controls?.dispose(); pipeline.dispose();
        detachDebug();
    }};
}

export function setupThermalZoneControls(node, folder) {
    node._thermalZoneFolder?.destroy(); node._thermalZoneFolder = null;
    node._thermalVehicleFolder?.destroy(); node._thermalVehicleFolder = null;
    if (!node.proceduralModel) return;
    const configured = thermalSettings(NodeMan.get("lookCamera", false) ?? {}, Sit);
    const sounding = Sit.thermalEnvironment?.sounding;
    const initial = sceneVehicleThermal(node, par.frame, thermalSceneAtmosphere(configured, sounding),
        {windField: NodeMan.get("windField", false), atmosphereSource: sounding ? "sounding" : "standard"});
    setupThermalVehicleControls(node, folder, () => node._thermalSceneState ?? initial);
    const signature = resolveVehicleThermal(node.proceduralModel.recipe, node._thermalSceneState ?? initial);
    const zones = new Set();
    node.model?.traverse(mesh => {if (mesh.userData.thermal?.zone) zones.add(mesh.userData.thermal.zone);});
    const parent = folder.addFolder(t("thermal.object.zones")).close(); node._thermalZoneFolder = parent;
    for (const zone of zones) {
        const resolved = signature.resolveZone(zone);
        if (!Number.isFinite(resolved.temperatureK) || !Number.isFinite(resolved.emissivity)) continue;
        const group = parent.addFolder(zone).close(), state = {};
        // Thin layers (a lantern canopy) also transmit. The scene adapter limits transmittance to 1 - emissivity;
        // the control shows that effective value.
        const value = key => node.thermal.zones[zone]?.[key] ?? resolved[key];
        // A gas volume (a flame) transmits 1 - emissivity by definition, so it has no separate control.
        for (const key of ["temperatureK", "emissivity", ...(resolved.transmittance !== undefined && !resolved.volume ? ["transmittance"] : [])]) {
            Object.defineProperty(state, key, {get: () => key === "transmittance" ? Math.min(value(key), 1 - value("emissivity")) : value(key),
                set: value => {node.thermal.zones[zone] = {...node.thermal.zones[zone], [key]: value}; markSitchDirty(); setRenderOne(true);}});
            // Same ranges and steps as the shared schema's objectTemperatureK and emissivity.
            const [min, max, step] = key === "temperatureK" ? [0, 3000, 1] : [0, 1, 0.01];
            group.add(state, key, min, max, step).name(t(`thermal.object.${key}`));
        }
        group.add({reset() {delete node.thermal.zones[zone]; group.controllers.forEach(c => c.updateDisplay()); setRenderOne(true); markSitchDirty();}}, "reset")
            .name(t("thermal.object.reset"));
    }
}

export function setupThermalVehicleControls(node, folder, getValues) {
    const parent = folder.addFolder(t("thermal.object.vehicleState")).close(); node._thermalVehicleFolder = parent;
    for (const [key, recipeKey] of [["airTemperatureK", "thermalAmbientK"], ["mach", "thermalMach"], ["power", "thermalPower"]]) {
        const parameter = VEHICLE_THERMAL_GROUP.fields.find(field => field.key === recipeKey);
        const group = parent.addFolder(t(`thermal.object.${key}`)).close(), state = {};
        const sourceKey = `${key}Source`;
        const update = () => {markSitchDirty(); setRenderOne(true);};
        Object.defineProperty(state, key, {get: () => node.thermal[key] ?? getValues()[key],
            set: value => {node.thermal[key] = value; update();}});
        Object.defineProperty(state, sourceKey, {get: () => node.thermal[key] == null ? "scene" : "override",
            set: value => {node.thermal[key] = value === "scene" ? null : state[key]; update();}});
        const source = group.add(state, sourceKey, {[t("thermal.object.fromScene")]: "scene", [t("thermal.object.override")]: "override"})
            .name(t("thermal.object.source")).listen();
        const control = group.add(state, key, parameter.min, parameter.max, parameter.step)
            .name(t(`thermal.object.${key}`)).tooltip(t(`thermal.object.${key}Tooltip`)).listen();
        const refresh = () => {control.disable(node.thermal[key] == null); control.updateDisplay();};
        source.onChange(refresh); refresh();
    }
}
