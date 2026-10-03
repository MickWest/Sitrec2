import {Vector3} from "three";
import {ThermalPipeline} from "../../tools/thermal/ThermalPipeline.js";
import {normalizeSettings, settingsForPreset, THERMAL_PARAMETERS} from "../../tools/thermal/thermalSchema.js";
import {integrateTurbulence} from "../../tools/thermal/turbulence.js";
import {attachThermalDebug, configureSensorCamera, createThermalControls, resolveVehicleThermal} from "../../tools/vehicles/thermalPreview.js";
import {VEHICLE_THERMAL_GROUP} from "../../tools/vehicles/thermalTags.js";
import {Globals, markSitchDirty, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {ellipsoidAltitude, terrestrialOptsFrom} from "../atmosphere/terrestrialRefraction";
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

export function saveThermalSettings(settings, cameraNode, sit) {
    const sensor = {}, environment = {};
    for (const parameter of THERMAL_PARAMETERS) {
        if (parameter.owner === "sensor") sensor[parameter.key] = settings[parameter.key];
        if (parameter.owner === "environment") environment[parameter.key] = settings[parameter.key];
    }
    sensor.presetMetadata = settings.presetMetadata;
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

export function thermalGeometry(camera, target, radii = Globals) {
    camera.updateWorldMatrix(true, false);
    const position = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const up = new Vector3(position.x / radii.equatorRadius ** 2,
        position.y / radii.equatorRadius ** 2, position.z / radii.polarRadius ** 2).normalize();
    const skyUp = up.clone().transformDirection(camera.matrixWorldInverse);
    const sensorAltitudeM = Math.max(0, ellipsoidAltitude(position, radii.equatorRadius, radii.polarRadius));
    const pathElevationDeg = Math.asin(Math.max(-1, Math.min(1, -skyUp.z))) * 180 / Math.PI;
    const relative = target?.clone().sub(position);
    const rangeM = relative?.length();
    return {position, skyUp, sensorAltitudeM, pathElevationDeg, rangeM,
        path: rangeM > 0 ? {sensorAltitudeM, slantRangeM: rangeM,
            elevationRad: Math.asin(Math.max(-1, Math.min(1, relative.dot(up) / rangeM)))} : null};
}

export function createThermalViewAdapter(view) {
    const pipeline = new ThermalPipeline(view.renderer, {analysis: false, onReady: () => setRenderOne(true),
        createOpticsWorker: () => import("./ThermalWorkerFactory.js").then(module => module.createOpticsWorker())});
    let controls, lastSettings, mapping, geometry, turbulence, turbulenceKey, comparisonPipeline, comparison;
    let atmosphere, atmosphereKey, vehicles = [];
    // Estimated budget: a paused frame's key costs a few ms in a scene with hundreds of meshes, against ~80 ms for
    // the full render it can save; a key that runs out of budget only disables reuse for that draw.
    const reuseKey = createThermalReuseKey({budgetMs: 10});
    const settings = () => lastSettings ?? thermalSettings(view.cameraNode, Sit);
    function set(key, value) {
        const current = thermalSettings(view.cameraNode, Sit);
        let next;
        if (key === "sensorPreset") {
            const preset = settingsForPreset(value);
            next = {...current, ...Object.fromEntries(THERMAL_PARAMETERS.filter(p => p.owner === "sensor")
                .map(p => [p.key, preset[p.key]])), presetMetadata: preset.presetMetadata, turbulenceMode: current.turbulenceMode};
        } else {
            const parameter = THERMAL_PARAMETERS.find(p => p.key === key);
            if (!parameter || parameter.owner === "geometry") throw new Error(t("thermal.readOnly"));
            next = {...current, [key]: value};
            if (key === "focalLengthM") next.fieldMode = "focalLength";
            if (key === "verticalFovDeg") next.fieldMode = "fieldOfView";
        }
        saveThermalSettings(normalizeSettings(next), view.cameraNode, Sit);
        lastSettings = null; controls?.refresh(); markSitchDirty(); setRenderOne(true);
    }
    if (view._thermalFolder) {
        controls = createThermalControls(view._thermalFolder, settings, set, {translate: t, readOnly: p => p.owner === "geometry"});
        controls.refresh();
    }
    const debug = {pipeline, get settings() {return settings();}, get mapping() {return mapping;},
        get geometry() {return geometry;}, get turbulence() {return turbulence;}, set,
        get vehicles() {return vehicles;},
        get comparison() {return comparison;},
        compareWith(otherPipeline) {comparisonPipeline = otherPipeline; comparison = null; setRenderOne(true);},
        readDetectorCounts: () => pipeline.readDetectorCounts(), readStage: name => pipeline.readStage(name),
        // Why the last paused frame could not be reused (null when a key was built).
        get reuseKeyNullReason() {return reuseKey.lastNullReason;}};
    const detachDebug = typeof window === "undefined" ? () => {} : attachThermalDebug(window, debug, "lookThermal");
    return {pipeline, set, render(scene, frame) {
        let configured = thermalSettings(view.cameraNode, Sit);
        const targetFrame = par.trackToTrackStopAt > 0 ? Math.min(frame, par.trackToTrackStopAt) : frame;
        const target = NodeMan.get("targetTrackSwitchSmooth", false)?.p(targetFrame);
        geometry = thermalGeometry(view.camera, target);
        if (configured.turbulenceMode === "geometry") {
            if (!geometry.path) throw new Error(t("thermal.noTarget"));
            const key = JSON.stringify(geometry.path);
            if (key !== turbulenceKey) {turbulence = integrateTurbulence(geometry.path); turbulenceKey = key;}
            configured.turbulenceR0M = Number.isFinite(turbulence.r0ReferenceM) ? turbulence.r0ReferenceM : 0;
        }
        configured = normalizeSettings({...configured, sensorAltitudeM: geometry.sensorAltitudeM,
            pathElevationDeg: geometry.pathElevationDeg, frameRateHz: Sit.fps});
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
        if (pipeline.hasFrame === false) {thermalStatus(view, "loading"); return;}
        thermalStatus(view, "readout", {width: configured.detectorWidth, height: configured.detectorHeight,
            vertical: mapping.nativeVerticalFovDeg.toFixed(6), horizontal: mapping.nativeHorizontalFovDeg.toFixed(6),
            zoom: mapping.effectiveDigitalZoom.toFixed(3), r0: configured.turbulenceR0M.toPrecision(4)},
        [...(pipeline.lastFrame?.opticsCache?.message ? [pipeline.lastFrame.opticsCache.message] : []),
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
        for (const key of ["temperatureK", "emissivity"]) {
            Object.defineProperty(state, key, {get: () => node.thermal.zones[zone]?.[key] ?? resolved[key],
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
