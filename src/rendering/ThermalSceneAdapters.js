import {Matrix4, Vector3} from "three";
import {withThermalVehicle} from "../../tools/vehicles/thermalPreview.js";
import {createAtmosphere, createThermalRayGeometry} from "../../tools/thermal/atmosphere.js";
import {atmosphereFromSounding} from "../../tools/thermal/sounding.js";
import {TURBOFAN_CLIMB_REFERENCE} from "../../tools/thermal/signatures.js";
import {Globals, Sit} from "../Globals";
import {airDataFromTAS} from "../AirData";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {getLocalEastVector, getLocalNorthVector} from "../SphericalMath";
import {ellipsoidAltitude, terrestrialLiftContext, liftCameraRelative, installTerrestrialRefractionOnMaterial} from "../atmosphere/terrestrialRefraction";
import {terrestrialRefractionUniforms, updateTerrestrialRefractionUniforms} from "../atmosphere/terrestrialRefraction";

// Explicit registration grants participation to physical roots. Scene decoration,
// annotations and celestial geometry have no registration and are excluded.
// Clouds register separately as radiance sheets, never as opaque surfaces.
export function thermalParticipation(mesh, roots) {
    let binding;
    for (let ancestor = mesh; ancestor; ancestor = ancestor.parent) {
        if (ancestor.userData?.thermal === false) return false;
        binding ??= roots.get(ancestor);
    }
    return binding ?? false;
}

// Same profile construction and options as ThermalPipeline._prepareAtmosphere.
// Extinction can be disabled without removing the air's thermodynamic state.
export function thermalSceneAtmosphere(settings, sounding) {
    const options = {visibilityM: settings.visibilityM, densityScale: settings.atmosphereEnabled ? 1 : 0};
    return sounding ? atmosphereFromSounding(sounding, options).atmosphere : createAtmosphere({...options,
        surfaceTemperatureK: settings.surfaceTemperatureK, surfaceWaterVaporDensityKgM3: settings.waterVaporDensityKgM3});
}

export function sceneVehicleThermal(node, frame, atmosphere, {sit = Sit, windField, radii = Globals,
    atmosphereSource = "standard"} = {}) {
    const root = node.group ?? node.model ?? node.object;
    const position = root.getWorldPosition(new Vector3());
    // Calculated ellipsoid altitude, matching the thermal pipeline's host geometry.
    const altitudeM = ellipsoidAltitude(position, radii.equatorRadius, radii.polarRadius);
    const thermal = node.thermal ?? {}, recipe = node.proceduralModel.recipe;
    const airTemperatureK = thermal.airTemperatureK ?? atmosphere.sample(altitudeM).temperatureK;
    const track = node.getSourceTrack?.();
    const velocity = new Vector3();
    const lastFrame = Math.max(0, (track?.frames ?? sit.frames ?? 1) - 1);
    const f0 = Math.max(0, Math.min(frame - 1, lastFrame)), f1 = Math.max(0, Math.min(frame + 1, lastFrame));
    const hasTrackVelocity = !!track?.p && f1 > f0;
    // Calculated central difference in m/s, one-sided at endpoints. simSpeed
    // converts a displayed frame interval to elapsed scene time (trackUtils.js).
    if (hasTrackVelocity) velocity.copy(track.p(f1)).sub(track.p(f0))
        .multiplyScalar(sit.fps / ((sit.simSpeed ?? 1) * (f1 - f0)));
    const groundSpeedMps = velocity.length();
    let speedSource = hasTrackVelocity ? "groundSpeed" : "stationary";
    let windVelocity;
    if (windField?.sampleWindAtAltitude) {
        const lla = ECEFToLLAVD_radii(position);
        // Wind fields use meters above mean sea level (CNodeContrail._windAt).
        const wind = windField.sampleWindAtAltitude(lla.x, lla.y, altitudeM - meanSeaLevelOffset(lla.x, lla.y));
        if (Number.isFinite(wind?.u) && Number.isFinite(wind?.v)) {
            windVelocity = getLocalEastVector(position).multiplyScalar(wind.u)
                .addScaledVector(getLocalNorthVector(position), wind.v);
            speedSource = "windField";
        }
    }
    // A bound wind is a uniform-column assumption. Do not substitute a display-
    // altitude value when an active altitude-dependent field has no sample here.
    if (!windVelocity && (!windField || windField.source === "manual")) {
        const wind = node.in?.wind ?? Object.values(node.inputs ?? {})
            .find(input => input.isController && input.in?.wind)?.in.wind;
        const sample = wind?.windVectorAt?.(frame, position) ?? wind?.getValueFrame?.(frame, position);
        if (sample) {
            windVelocity = sample.clone().multiplyScalar(sit.fps / (sit.simSpeed ?? 1));
            speedSource = "objectWind";
        }
    }
    if (windVelocity) velocity.sub(windVelocity);
    const speedMps = velocity.length();
    // Calculated M = |v_ground - v_wind| / sqrt(gamma R T), using the shared
    // published ideal-dry-air constants and relation in AirData.js.
    const sceneMach = airDataFromTAS(speedMps, null, airTemperatureK).mach;
    // Estimated fallback load coordinate, sourced from the signature schema.
    const power = thermal.power ?? recipe.parameters.thermalPower ?? TURBOFAN_CLIMB_REFERENCE.powerFraction;
    return {id: node.id, frame, altitudeM, airTemperatureK, mach: thermal.mach ?? sceneMach, power,
        speedMps, groundSpeedMps, speedSource, hasTrackVelocity,
        sources: {airTemperatureK: thermal.airTemperatureK != null ? "override" : atmosphereSource,
            mach: thermal.mach != null ? "override" : speedSource,
            power: thermal.power != null ? "override" : recipe.parameters.thermalPower != null ? "recipe" : "climbReference"}};
}

export function withThermalScene(objects, draw, values = new Map(), index = 0) {
    if (index === objects.length) return draw();
    const node = objects[index], root = node.model ?? node.object;
    const next = () => withThermalScene(objects, draw, values, index + 1);
    return root && node.proceduralModel ? withThermalVehicle({root, recipe: node.proceduralModel.recipe}, next, values.get(node)) : next();
}

export function createThermalSceneAdapter(objects, groundRoots, camera, refractionOptions, clouds = []) {
    const roots = new Map();
    for (const node of objects) {
        const root = node.model ?? node.object;
        if (root) roots.set(root, {kind: "object", node});
    }
    for (const [index, root] of groundRoots.entries()) if (root) roots.set(root, {kind: index === 1 ? "sea" : "ground"});
    const observer = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const context = terrestrialLiftContext(observer, refractionOptions);
    const rotation = new Matrix4().extractRotation(camera.matrixWorld);
    const inverseRotation = rotation.clone().invert();
    const projectPoint = point => {
        if (context) liftCameraRelative(context, point.applyMatrix4(rotation), point).applyMatrix4(inverseRotation);
        return point;
    };
    const geometryDomainKey = JSON.stringify(context && [context.k, context.R,
        context.maxBendRad, context.scaleHeightM, context.maxLiftM]);
    const geometryKey = JSON.stringify([geometryDomainKey, context?.obsAlt]);
    let rayGeometry;
    const atAltitude = altitude => {
        const local = {...context, obsAlt: altitude, zenith: new Vector3(0, 1, 0)}, point = new Vector3();
        return Object.assign(createThermalRayGeometry({sensorAltitudeM: altitude,
            earthRadiusM: context.R, key: JSON.stringify([geometryDomainKey, altitude]),
            lift: (d, z) => liftCameraRelative(local, point.set(d, z, 0), point).y - z}),
        {domainKey: geometryDomainKey, atAltitude});
    };
    return {
        materialKey: "terrestrialProjection",
        geometryMode: "terrestrialProjection",
        geometryKey,
        rayGeometry(settings) {
            if (!context) return null;
            if (rayGeometry?.sensorAltitudeM !== settings.sensorAltitudeM) rayGeometry = atAltitude(settings.sensorAltitudeM);
            return rayGeometry;
        },
        seaWind: settings => getLocalNorthVector(observer).multiplyScalar(Math.cos(settings.seaWindDirectionRad))
            .addScaledVector(getLocalEastVector(observer), Math.sin(settings.seaWindDirectionRad))
            .transformDirection(camera.matrixWorldInverse).toArray(),
        cloudSheets: (viewCamera, settings, atmosphere) => thermalCloudSheets(clouds, viewCamera, settings, atmosphere, projectPoint),
        // Distant terrain beyond the lookup receives its endpoint transfer. Small
        // target geometry must still fit the supplied atmosphere range.
        allowRangeClamping: mesh => ["ground", "sea"].includes(thermalParticipation(mesh, roots)?.kind),
        prepareMaterial(material) {
            installTerrestrialRefractionOnMaterial(material);
            const prepare = material.onBeforeCompile;
            material.onBeforeCompile = function (shader, renderer) {
                prepare.call(this, shader, renderer);
                shader.vertexShader = shader.vertexShader.replace("vProjectedPosition = mvPosition.xyz;",
                    "vProjectedPosition = applyTerrestrialRefraction_chunk(mvPosition.xyz);");
            };
        },
        projectPoint,
        isSea: mesh => thermalParticipation(mesh, roots)?.kind === "sea",
        attributes(mesh, settings) {
            const binding = thermalParticipation(mesh, roots);
            if (!binding) return false;
            if (binding.kind === "sea" && settings.seaMode === "statistical") return {sea: true};
            if (binding.kind === "ground" || binding.kind === "sea") return {temperatureK: settings.groundTemperatureK,
                emissivity: settings.groundEmissivity};
            const thermal = binding.node.thermal;
            if (thermal?.mode === "uniform") return {temperatureK: thermal.temperatureK, emissivity: thermal.emissivity};
            const zone = mesh.userData.thermal?.zone;
            const override = thermal?.zones?.[zone];
            return override ? {...mesh.userData.thermal, ...override} : undefined;
        },
    };
}

export function withThermalRefraction(camera, options, draw) {
    const saved = Object.fromEntries(Object.entries(terrestrialRefractionUniforms).map(([key, uniform]) =>
        [key, uniform.value?.clone ? uniform.value.clone() : uniform.value]));
    try {
        updateTerrestrialRefractionUniforms(camera, options);
        return draw();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            const uniform = terrestrialRefractionUniforms[key];
            if (uniform.value?.copy) uniform.value.copy(value); else uniform.value = value;
        }
    }
}

// Canonical arrays, never the visible renderer's camera-specific permutation.
// Physical centers and local sheet samples share the unrefracted geometry.
export function thermalCloudSheets(nodes, camera, settings, atmosphere, projectPoint = p => p) {
    const sheets = [], diagnostics = [];
    const observer = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const rotation = new Matrix4().extractRotation(camera.matrixWorld).invert();
    for (const node of nodes) {
        const mesh = node.cloudMesh ?? node.mesh;
        if (!mesh || !mesh.layers.test(camera.layers)) continue;
        let visible = true;
        for (let p = mesh; p; p = p.parent) if (!p.visible || p.userData?.thermal === false) visible = false;
        if (!visible) continue;
        if (node.isThermalCloud === "unresolvedThermal") {
            diagnostics.push({id: node.id, code: "unresolvedThermal"}); continue;
        }
        const world = mesh.matrixWorld, transform = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, world);
        const offsets = node.instanceOffsets, sizes = node.instanceSizes;
        for (let i = 0; i < node.cloudCount; i++) {
            const local = new Vector3().fromArray(offsets, 3 * i), physical = local.clone().applyMatrix4(world);
            const center = local.applyMatrix4(transform), apparent = physical.clone().sub(observer);
            apparent.applyMatrix4(rotation);
            projectPoint(apparent);
            const altitudeM = ellipsoidAltitude(physical, Globals.equatorRadius, Globals.polarRadius);
            sheets.push({id: `${node.id}:${i}`, center: center.toArray(), apparentCenter: apparent.toArray(),
                size: [sizes[2 * i], sizes[2 * i + 1]], altitudeM,
                temperatureK: atmosphere.sample(altitudeM).temperatureK,
                temperaturePolicy: "airAtAltitude",
                opticalDepth: settings.cloudOpticalDepth, mask: node.cloudTexture,
                maskSemantics: "normalizedColumn", phase: "unknown", scattering: "absorptionOnly"});
        }
    }
    return {sheets, diagnostics};
}
