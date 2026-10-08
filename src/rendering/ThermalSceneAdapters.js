import {Box3, Frustum, Matrix4, Object3D, Ray, Vector3} from "three";
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
    atmosphereSource = "standard", geoidHeight = meanSeaLevelOffset} = {}) {
    const root = node.group ?? node.model ?? node.object;
    const position = root.getWorldPosition(new Vector3());
    // Calculated height above mean sea level, matching the thermal pipeline's host geometry (thermalGeometry).
    const lla = ECEFToLLAVD_radii(position);
    const altitudeM = ellipsoidAltitude(position, radii.equatorRadius, radii.polarRadius) - geoidHeight(lla.x, lla.y);
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
        // Wind fields use meters above mean sea level (CNodeContrail._windAt).
        const wind = windField.sampleWindAtAltitude(lla.x, lla.y, altitudeM);
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
    // The Earth radius at the observer changes by centimetres per frame as the camera moves, so it is not part of the
    // domain key (in the key, no range or sky domain was ever reused). The ray geometry carries it; each domain records
    // the radius it was built at and serves requests within RADIUS_REUSE_M of it (atmosphere.js). Rays use the current
    // radius.
    const geometryDomainKey = JSON.stringify(context && [context.k, context.maxBendRad, context.scaleHeightM, context.maxLiftM]);
    // The identity of this frame's geometry keeps the exact radius, so the pipeline asks its caches again as it
    // drifts and the caches decide reuse by the tolerance above.
    const geometryKey = JSON.stringify([geometryDomainKey, context?.obsAlt, context?.R]);
    let rayGeometry;
    const atAltitude = altitude => {
        const local = {...context, obsAlt: altitude, zenith: new Vector3(0, 1, 0)}, point = new Vector3();
        return Object.assign(createThermalRayGeometry({sensorAltitudeM: altitude,
            earthRadiusM: context.R, key: JSON.stringify([geometryDomainKey, altitude, context.R]),
            lift: (d, z) => liftCameraRelative(local, point.set(d, z, 0), point).y - z}),
        {domainKey: geometryDomainKey, atAltitude,
            workerSpec: {sensorAltitudeM: altitude, earthRadiusM: context.R, k: context.k,
                maxBendRad: context.maxBendRad, scaleHeightM: context.scaleHeightM, maxLiftM: context.maxLiftM,
                domainKey: geometryDomainKey}});
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
        // Ground and sea are extended backgrounds, never sub-pixel targets, so coverage refinement skips them.
        isSurface: mesh => ["ground", "sea"].includes(thermalParticipation(mesh, roots)?.kind),
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
                emissivity: settings.groundEmissivity,
                ...(binding.kind === "ground" && settings.groundTemperatureMode === "color" && settings.groundTemperatureSpanK > 0
                    ? {terrainColor: true} : {})};
            const thermal = binding.node.thermal;
            if (thermal?.mode === "uniform") return {temperatureK: thermal.temperatureK, emissivity: thermal.emissivity};
            const zone = mesh.userData.thermal?.zone;
            const override = thermal?.zones?.[zone];
            return override ? {...mesh.userData.thermal, ...override} : undefined;
        },
    };
}

// Exact values, not a rounded or hashed key. Geometry revisions follow the same
// BufferAttribute.needsUpdate contract as the renderer. Unsupported deformation,
// unbounded projection and an exhausted CPU budget disable reuse.
export function createThermalReuseKey({budgetMs = 2} = {}) {
    const identities = new WeakMap(), bounds = new WeakMap(), projectedBounds = new WeakMap();
    let nextIdentity = 1;
    const identity = value => {
        if (value == null) return null;
        if (!identities.has(value)) identities.set(value, nextIdentity++);
        return identities.get(value);
    };
    const unavailable = {};
    let failure = null;
    const fail = why => {failure = why; return unavailable;};
    const key = ({scene, camera, viewCamera = camera, settings, frame, objects = [], groundRoots = [], clouds = [],
        sounding = null, atmosphereKey = null, refractionOptions = {}, presentation = null, skyUp = null, psfRangeM = 0}) => {
        const start = performance.now();
        failure = null;
        const check = () => {if (performance.now() - start > budgetMs) throw fail("time budget");};
        // JSON keeps every finite number's round-trip value. Non-data state has no
        // reliable revision contract here and must not silently disappear from a key.
        let encodedValues = 0;
        const encode = value => JSON.stringify(value, function (key, item) {
            if (++encodedValues % 256 === 0) check();
            if (typeof this[key]?.toJSON === "function" || typeof item === "number" && !Number.isFinite(item) ||
                ["function", "symbol", "bigint"].includes(typeof item)) throw fail("unserializable value");
            return item;
        });
        const attribute = value => {
            if (!value) return null;
            if (value.isGLBufferAttribute) throw fail("GL buffer attribute");
            return [identity(value), identity(value.array), value.count, value.itemSize, value.normalized,
                value.version ?? value.data?.version, value.gpuType,
                value.isInterleavedBufferAttribute ? [identity(value.data), identity(value.data.array), value.data.stride, value.offset] : null];
        };
        try {
            // A scene hook may change the image on every draw. Hooks that declare themselves reuse-safe depend
            // only on inputs this key covers (the camera); any other custom hook disables reuse.
            const hookSafe = (hook, base) => hook === base || hook?.thermalReuseSafe?.() === true;
            if (!scene || !camera?.isPerspectiveCamera ||
                !hookSafe(scene.onBeforeRender, Object3D.prototype.onBeforeRender) ||
                !hookSafe(scene.onAfterRender, Object3D.prototype.onAfterRender)) {key.lastNullReason = "scene hook or camera"; return null;}
            camera.updateWorldMatrix(true, false);
            // Match the update done by the radiance pass before taking the snapshot.
            scene.updateMatrixWorld(true);
            const observer = new Vector3().setFromMatrixPosition(camera.matrixWorld);
            const lift = terrestrialLiftContext(observer, refractionOptions);
            if (lift && !(Number.isFinite(lift.maxLiftM) && lift.maxLiftM > 0 &&
                Number.isFinite(lift.R) && lift.R > 0 && Number.isFinite(lift.k) &&
                Number.isFinite(lift.maxBendRad) && lift.maxBendRad > 0 && lift.scaleHeightM > 0)) {key.lastNullReason = "refraction context"; return null;}
            const frustum = new Frustum().setFromProjectionMatrix(new Matrix4()
                .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
            // Without apparent-position mapping, the cloud pass tests occlusion with
            // rays from the camera across each sheet, so an off-image mesh can still
            // change the image. Record the visible sheets; their occluders are kept below.
            const cloudRays = [];
            if (!lift) for (const node of clouds) {
                const mesh = node.cloudMesh ?? node.mesh;
                if (!mesh || !mesh.layers.test(camera.layers) || node.isThermalCloud === "unresolvedThermal") continue;
                let visible = true;
                for (let parent = mesh; parent; parent = parent.parent)
                    if (!parent.visible || parent.userData?.thermal === false) visible = false;
                if (!visible) continue;
                mesh.updateWorldMatrix(true, false);
                for (let i = 0; i < node.cloudCount; i++) {
                    check();
                    const point = new Vector3().fromArray(node.instanceOffsets, 3 * i).applyMatrix4(mesh.matrixWorld);
                    const distance = point.clone().applyMatrix4(camera.matrixWorldInverse).length();
                    cloudRays.push({ray: new Ray(observer, point.sub(observer).normalize()), distance});
                }
            }
            const roots = new Map();
            for (const node of objects) if (node.model ?? node.object) roots.set(node.model ?? node.object, {kind: "object", node});
            for (const [i, root] of groundRoots.entries()) if (root) roots.set(root, {kind: i === 1 ? "sea" : "ground"});
            const parts = [encode([frame, settings, sounding, atmosphereKey, refractionOptions, presentation, skyUp, psfRangeM,
                identity(scene), scene.visible, camera.matrixWorld.elements, camera.matrixWorldInverse.elements,
                camera.projectionMatrix.elements, camera.layers.mask, camera.near, camera.far,
                camera.coordinateSystem, camera.reversedDepth, viewCamera.matrixWorld.elements, viewCamera.projectionMatrix.elements])];
            for (const node of objects) {
                const root = node.model ?? node.object;
                root?.updateWorldMatrix(true, true);
                parts.push(encode([identity(node), node.id, identity(root), root?.matrixWorld.elements,
                    node.thermal, node._thermalSceneState, node.proceduralModel?.recipe]));
            }
            scene.traverse(mesh => {
                check();
                if (mesh.isLOD && mesh.autoUpdate) throw fail("automatic detail selection");
                if (!mesh.isMesh || !mesh.layers.test(camera.layers)) return;
                const binding = thermalParticipation(mesh, roots);
                if (!binding) return;
                const ancestry = [];
                for (let parent = mesh; parent; parent = parent.parent) {
                    if (!parent.visible || parent.userData?.thermal === false) return;
                    if (parent.isLOD || parent.isLine || parent.isPoints || parent.isSprite || parent.type?.endsWith("Helper")) throw fail(`unsupported ancestor ${parent.type}`);
                    if (!Number.isFinite(parent.renderOrder)) throw fail("render order");
                    ancestry.push([parent.renderOrder, parent.userData?.thermal == null ? null : encode(parent.userData.thermal)]);
                }
                const geometry = mesh.geometry, position = geometry?.attributes?.position;
                if (!position || position.isGLBufferAttribute || mesh.isSkinnedMesh || mesh.isInstancedMesh ||
                    mesh.isBatchedMesh || Object.keys(geometry.morphAttributes).length) throw fail("batched or morph geometry");
                if (binding.kind !== "object") {
                    const revision = JSON.stringify(attribute(position));
                    let cached = bounds.get(geometry);
                    if (cached?.revision !== revision) {
                        // Calculated enclosure of every vertex; recompute on a position
                        // revision rather than trusting a possibly stale geometry bound.
                        const box = new Box3();
                        const point = new Vector3();
                        for (let i = 0; i < position.count; i++) {
                            if (i % 256 === 0) check();
                            box.expandByPoint(point.fromBufferAttribute(position, i));
                        }
                        cached = {revision, box}; bounds.set(geometry, cached);
                    }
                    let projected = projectedBounds.get(mesh);
                    // Calculated zero-error reuse of the same enclosure and planes.
                    // No camera, vertex revision or transform component is rounded.
                    if (projected?.domain !== parts[0] || projected.revision !== revision ||
                        !mesh.matrixWorld.elements.every((value, i) => value === projected.world[i])) {
                        const box = cached.box.clone().applyMatrix4(mesh.matrixWorld);
                        if (![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) throw fail("non-finite bounds");
                        // Calculated: |saturateLift| <= maxLiftM. The camera's
                        // Frobenius norm bounds conversion back to world distance,
                        // including scaled cameras. Absolute transform terms bound
                        // Float32 error even when large local coordinates cancel.
                        const world = camera.matrixWorld.elements;
                        const cameraNorm = Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map(i => world[i]));
                        const mv = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).elements;
                        const extent = ["x", "y", "z"].map(axis => Math.max(Math.abs(cached.box.min[axis]), Math.abs(cached.box.max[axis])));
                        const terms = [0, 1, 2].map(row => Math.abs(mv[row + 12]) +
                            extent.reduce((sum, value, column) => sum + Math.abs(mv[row + 4 * column]) * value, 0));
                        // 64 Float32 ulps exceeds the coefficient rounding and the
                        // four-term transform error. This only retains extra tiles.
                        const magnitude = Math.max(1, observer.length(), box.min.length(), box.max.length(), ...terms);
                        box.expandByScalar(cameraNorm * ((lift?.maxLiftM ?? 0) + 64 * 2 ** -23 * magnitude));
                        projected = {domain: parts[0], revision, world: mesh.matrixWorld.elements.slice(),
                            outside: !frustum.intersectsBox(box), box};
                        projectedBounds.set(mesh, projected);
                    }
                    // The cloud pass tests occlusion on rays across each whole sheet, not only its centre ray, so
                    // with a visible cloud any off-image mesh may change the image: keep them all in the key then.
                    if (projected.outside && !cloudRays.length) return;
                }
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                if (!mesh.matrixWorld.elements.every(Number.isFinite)) throw fail("non-finite matrix");
                // Generated renderer descriptors need no recursive value inspection;
                // user-supplied thermal tags still use the checked encoder.
                parts.push(JSON.stringify([identity(mesh), binding.kind, mesh.matrixWorld.elements, mesh.layers.mask, ancestry,
                    identity(geometry), Object.entries(geometry.attributes).map(([name, value]) => [name, attribute(value)]),
                    attribute(geometry.index), geometry.groups.map(group => {
                        const values = [group.start, group.count, group.materialIndex];
                        if (!values.every(Number.isFinite)) throw fail("non-finite uniform");
                        return values;
                    }), geometry.drawRange.start,
                    geometry.drawRange.count === Infinity ? "all" : geometry.drawRange.count,
                    materials.map(material => {
                        const state = [material.side, material.visible];
                        if (binding.kind === "ground" && settings.groundTemperatureMode === "color" && settings.groundTemperatureSpanK > 0) {
                            const map = material.map;
                            if (map?.isVideoTexture) throw fail("animated terrain texture");
                            if (map?.matrixAutoUpdate) map.updateMatrix();
                            state.push(material.color?.toArray(), material.vertexColors, identity(map), map?.version,
                                identity(map?.source), map?.source?.version, map?.channel, map?.matrix.elements,
                                map && [map.wrapS, map.wrapT, map.minFilter, map.magFilter, map.anisotropy,
                                    map.flipY, map.colorSpace, map.format, map.type]);
                        }
                        return state;
                    })]));
            });
            for (const node of clouds) {
                check();
                const mesh = node.cloudMesh ?? node.mesh;
                if (!mesh) {parts.push(encode([identity(node), node.id, node.isThermalCloud])); continue;}
                mesh.updateWorldMatrix(true, false);
                const ancestry = [];
                for (let parent = mesh; parent; parent = parent.parent) ancestry.push([parent.visible, parent.userData?.thermal]);
                const mask = node.cloudTexture;
                // The cloud pass also reads mask data on the CPU. Snapshot those
                // values, including in-place edits, instead of relying on a GPU version.
                const array = values => values == null ? null : Array.from(values, value => {check(); return value;});
                if (mask?.isVideoTexture || mask && !mask.image?.data) throw fail("untracked cloud mask");
                parts.push(encode([identity(node), node.id, node.isThermalCloud, identity(mesh), mesh.matrixWorld.elements,
                    mesh.layers.mask, ancestry, node.cloudCount, array(node.instanceOffsets), array(node.instanceSizes),
                    identity(mask), mask?.version, mask?.image?.width, mask?.image?.height, array(mask?.image?.data),
                    mask && [mask.wrapS, mask.wrapT, mask.minFilter, mask.magFilter, mask.format, mask.type,
                        mask.flipY, mask.premultiplyAlpha, mask.unpackAlignment, mask.colorSpace]]));
            }
            check();
            key.lastNullReason = null;
            return parts.join("\n");
        } catch (error) {
            // Cycles, custom data and a time-budget overrun are conservative misses.
            if (error === unavailable || error instanceof TypeError || error instanceof RangeError) {
                key.lastNullReason = error === unavailable ? failure ?? "unavailable" : error.message;
                return null;
            }
            throw error;
        }
    };
    // Why the last call returned null (for diagnostics); null after a key was built.
    key.lastNullReason = null;
    return key;
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
            // Height above mean sea level, where the atmosphere profile begins (as in thermalGeometry).
            const lla = ECEFToLLAVD_radii(physical);
            const altitudeM = ellipsoidAltitude(physical, Globals.equatorRadius, Globals.polarRadius)
                - meanSeaLevelOffset(lla.x, lla.y);
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
