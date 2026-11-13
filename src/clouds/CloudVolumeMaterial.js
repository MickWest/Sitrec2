// CloudVolumeMaterial.js - the ShaderMaterial of the volumetric clouds, and the
// per-camera uniform packer that runs in its onBeforeRender.
//
// Every render of the world scene reaches onBeforeRender with ITS camera: the
// main view, the look view, the water mirror, XR eyes and exports. The packer
// forms every camera-relative constant in double precision (CloudMath.js) and
// writes them into preallocated uniform values: no allocation per frame.
//
// The haze uniforms are SHARED BY REFERENCE with materialAtmosphereUniforms,
// whose values withMaterialAtmosphere sets for the draw in progress, so a
// cloud takes exactly the haze the terrain under it gets in that view.

import {Color, CustomBlending, Matrix3, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, Vector3, Vector4} from "three";
import {atmosphereProjectionUniforms, setAtmosphereProjection} from "../atmosphere/AtmosphereProjection";
import {materialAtmosphereUniforms} from "../atmosphere/MaterialAtmosphere";
import {CLOUD_FRAGMENT_SHADER, CLOUD_MAX_LAYERS, CLOUD_MAX_STEPS, CLOUD_VERTEX_SHADER} from "./cloudShaders";
import {CLOUD_QUALITY_STEPS, cloudTypeInfo} from "./CloudLayerModel";
import {localFrameAt, noisePeriod, positiveModulo, shellConstant, sunBrightness, WGS84_A, WGS84_B} from "./CloudMath";

const HAZE_KEYS = ["atmoEnabled", "atmoBeta", "atmoAltitude", "atmoRadius", "atmoUp", "atmoSun",
    "atmoCool", "atmoWarm", "atmoWarmStrength", "atmoStartPlane"];

// Energy of the multiple scattering that three octaves leave out. Tuned once so
// a sunlit cumulus top is about as bright as a white surface in the same sun.
export const CLOUD_SUN_GAIN = 5.0;

// Stretch of a fibrous (cirrus) pattern along the wind.
const FIBER_STRETCH = 6;

// Linear hues of the sky light from above and the light from the ground below,
// each with a luminance of about one.
const SKY_TOP_HUE = new Color(0.75, 1.0, 1.3);
// The scene's ambient light stands for the whole sky dome; inside a cloud
// field part of the dome is other clouds, so the clouds take less of it.
const CLOUD_AMBIENT_SHARE = 0.75;
const GROUND_HUE = new Color(1.05, 1.0, 0.9);
const GROUND_ALBEDO = 0.15;

// Farthest cloud distance (m) for a camera near the ground.
const MARCH_RANGE = 400000;

// Ground cap height (m): rays end where they reach it, even with no terrain depth.
const GROUND_CAP = -200;

// Per-layer noise offsets: a seed moves the pattern, never its statistics.
const SEED_OFFSET = [1731.37, 2903.71, 1187.93];

function vec4Array() {
    return Array.from({length: CLOUD_MAX_LAYERS}, () => new Vector4());
}

export function createCloudVolumeMaterial() {
    const uniforms = {
        ...atmosphereProjectionUniforms(),
        cloudViewToWorld: {value: new Matrix3()},
        cloudUp: {value: new Vector3(0, 0, 1)},
        cloudR: {value: WGS84_A},
        cloudR0: {value: WGS84_A},
        cloudC0: {value: 0},
        cloudCEarth: {value: 0},
        cloudNear: {value: 0.1},
        cloudTMax: {value: 400000},
        cloudSunDir: {value: new Vector3(0, 0, 1)},
        cloudSunIntensity: {value: 0},
        cloudSunGain: {value: CLOUD_SUN_GAIN},
        cloudAmbientTop: {value: new Color()},
        cloudAmbientBottom: {value: new Color()},
        cloudFrame: {value: 0},
        cloudLayerCount: {value: 0},
        cloudSteps: {value: 72},
        cloudLightSteps: {value: 5},
        cloudShapeTex: {value: null},
        cloudDetailTex: {value: null},
        cloudWeatherTex: {value: null},
        cloudShell: {value: vec4Array()},
        cloudParams: {value: vec4Array()},
        cloudGradient: {value: vec4Array()},
        cloudShapeInfo: {value: vec4Array()},
        cloudWind: {value: vec4Array()},
        cloudDisc: {value: vec4Array()},
        cloudDiscUp: {value: vec4Array()},
        cloudCoverageA: {value: vec4Array()},
        cloudCoverageB: {value: vec4Array()},
        cloudShapeA: {value: vec4Array()},
        cloudDetailA: {value: vec4Array()},
        cloudStretch: {value: vec4Array()},
    };
    // Shared by reference: the values are the current draw's haze.
    for (const key of HAZE_KEYS) uniforms[key] = materialAtmosphereUniforms[key];

    const material = new ShaderMaterial({
        name: "VolumetricClouds",
        uniforms,
        vertexShader: CLOUD_VERTEX_SHADER,
        fragmentShader: CLOUD_FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        // Premultiplied color over the scene: out = cloud + scene * (1 - alpha).
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneMinusSrcAlphaFactor,
        premultipliedAlpha: true,
    });
    // Not a surface: no material haze patch, no thermal radiance, no lift.
    material.userData.atmosphere = false;
    return material;
}

// Scratch state for the packer (module level, reused every call).
const scratch = {
    frame: {h0: 0, R: WGS84_A, up: [0, 0, 1]},
    base: [0, 0, 0],
    stretched: [0, 0, 0],
    wind: [0, 0, 0],
    sun: new Vector3(),
};

function setOffset(target, point, period) {
    target.set(positiveModulo(point[0], period), positiveModulo(point[1], period), positiveModulo(point[2], period), 1 / period);
}

// Apply the fibrous stretch M = I - (1 - 1/s) w w^T to a point.
function stretchAlong(point, direction, stretch, out) {
    const along = (point[0] * direction[0] + point[1] * direction[1] + point[2] * direction[2]) * (1 - 1 / stretch);
    out[0] = point[0] - direction[0] * along;
    out[1] = point[1] - direction[1] * along;
    out[2] = point[2] - direction[2] * along;
    return out;
}

/**
 * Fill the material uniforms for one camera.
 * @param {Object} uniforms - the material's uniforms
 * @param {Camera} camera - the camera of this draw (matrixWorld current)
 * @param {Object} state - from CNodeCloudLayers.renderState():
 *   {layers: [normalized layer], derived: [{windECEF:[3], windDir:[3], discECEF:[3]|null, discUp:[3]}],
 *    seconds, frame, quality, radii: {a, b}, sun: {dir: Vector3, intensity, angle}, ambient,
 *    lens: fisheye lens or null}
 */
export function updateCloudUniforms(uniforms, camera, state) {
    const elements = camera.matrixWorld.elements;
    const cameraX = elements[12], cameraY = elements[13], cameraZ = elements[14];
    // Rotation only; normalize the axes in case the camera carries a scale.
    const view = uniforms.cloudViewToWorld.value;
    const sx = Math.hypot(elements[0], elements[1], elements[2]) || 1;
    const sy = Math.hypot(elements[4], elements[5], elements[6]) || 1;
    const sz = Math.hypot(elements[8], elements[9], elements[10]) || 1;
    view.set(
        elements[0] / sx, elements[4] / sy, elements[8] / sz,
        elements[1] / sx, elements[5] / sy, elements[9] / sz,
        elements[2] / sx, elements[6] / sy, elements[10] / sz,
    );
    setAtmosphereProjection(uniforms, camera, state.lens);

    const a = state.radii?.a ?? WGS84_A, b = state.radii?.b ?? WGS84_B;
    const frame = localFrameAt(cameraX, cameraY, cameraZ, a, b, scratch.frame);
    const {h0, R} = frame;
    uniforms.cloudUp.value.set(frame.up[0], frame.up[1], frame.up[2]);
    uniforms.cloudR.value = R;
    uniforms.cloudR0.value = R + h0;
    uniforms.cloudC0.value = h0 * (2 * R + h0);
    uniforms.cloudCEarth.value = shellConstant(h0, R, GROUND_CAP);
    uniforms.cloudNear.value = camera.near ?? 0.1;
    // Far enough to reach the horizon of a high camera (an orbital main view).
    uniforms.cloudTMax.value = MARCH_RANGE + 4 * Math.max(0, h0);
    uniforms.cloudFrame.value = Math.floor(state.frame ?? 0);

    const steps = CLOUD_QUALITY_STEPS[state.quality] ?? CLOUD_QUALITY_STEPS.Medium;
    uniforms.cloudSteps.value = Math.min(steps.steps, CLOUD_MAX_STEPS);
    uniforms.cloudLightSteps.value = steps.lightSteps;

    // Sun and sky light.
    uniforms.cloudSunDir.value.copy(state.sun.dir);
    uniforms.cloudSunIntensity.value = state.sun.intensity;
    const ambient = state.ambient * CLOUD_AMBIENT_SHARE;
    uniforms.cloudAmbientTop.value.copy(SKY_TOP_HUE).multiplyScalar(ambient);
    const sunAngle = state.sun.angle ?? 90;
    const groundIrradiance = state.sun.intensity * sunBrightness(sunAngle) * Math.max(0, Math.sin(sunAngle * Math.PI / 180));
    uniforms.cloudAmbientBottom.value.copy(GROUND_HUE).multiplyScalar(ambient * 0.55 + groundIrradiance * GROUND_ALBEDO / Math.PI);

    const count = Math.min(state.layers.length, CLOUD_MAX_LAYERS);
    uniforms.cloudLayerCount.value = count;
    for (let index = 0; index < count; index++) {
        const layer = state.layers[index];
        const derived = state.derived[index];
        const info = cloudTypeInfo(layer.type);
        const sheet = info.render === "sheet";
        const baseAltitude = layer.baseAltitude, thickness = layer.thickness;

        if (sheet) {
            const mid = shellConstant(h0, R, baseAltitude + 0.5 * thickness);
            uniforms.cloudShell.value[index].set(mid, mid, baseAltitude, thickness);
        } else {
            uniforms.cloudShell.value[index].set(shellConstant(h0, R, baseAltitude),
                shellConstant(h0, R, baseAltitude + thickness), baseAltitude, thickness);
        }
        uniforms.cloudParams.value[index].set(layer.coverage,
            sheet ? layer.density : info.extinction * layer.density, layer.detail, sheet ? 1 : 0);
        const gradient = info.gradient ?? [0, 0.1, 0.9, 1];
        uniforms.cloudGradient.value[index].set(gradient[0], gradient[1], gradient[2], gradient[3]);
        uniforms.cloudShapeInfo.value[index].set(info.domed ?? 0, info.anvil ?? 0, info.pattern ?? 0, info.opticalDepth ?? 0);

        const windDir = derived.windDir;
        uniforms.cloudWind.value[index].set(windDir[0], windDir[1], windDir[2], layer.windSkew * thickness);
        const fibrous = sheet && info.pattern === 1;
        const stretch = fibrous ? FIBER_STRETCH : 1;
        uniforms.cloudStretch.value[index].set(stretch, 0, 0, 0);

        if (derived.discECEF) {
            const disc = derived.discECEF, windECEF = derived.windECEF;
            uniforms.cloudDisc.value[index].set(disc[0] + windECEF[0] - cameraX,
                disc[1] + windECEF[1] - cameraY, disc[2] + windECEF[2] - cameraZ, layer.extent.radius);
            uniforms.cloudDiscUp.value[index].set(derived.discUp[0], derived.discUp[1], derived.discUp[2], layer.extent.feather);
        } else {
            uniforms.cloudDisc.value[index].set(0, 0, 0, 0);
            uniforms.cloudDiscUp.value[index].set(0, 0, 1, 0);
        }

        // Noise lookups: (offset + p) / period with offset = (camera - wind + seed) mod period,
        // formed here in double precision so the shader only adds small numbers.
        const base = scratch.base, windECEF = derived.windECEF;
        const seed = layer.seed + 1;
        base[0] = cameraX - windECEF[0] + seed * SEED_OFFSET[0];
        base[1] = cameraY - windECEF[1] + seed * SEED_OFFSET[1];
        base[2] = cameraZ - windECEF[2] + seed * SEED_OFFSET[2];
        const stretched = fibrous ? stretchAlong(base, windDir, stretch, scratch.stretched) : base;
        setOffset(uniforms.cloudCoverageA.value[index], base, noisePeriod(layer.scale, "coverage"));
        setOffset(uniforms.cloudCoverageB.value[index], stretched, noisePeriod(layer.scale, "coverage2"));
        setOffset(uniforms.cloudShapeA.value[index], stretched, noisePeriod(layer.scale, "shape"));
        // The detail scrolls a little faster than the wind, so the shapes evolve.
        const detail = scratch.wind;
        detail[0] = base[0] - 0.2 * windECEF[0];
        detail[1] = base[1] - 0.2 * windECEF[1];
        detail[2] = base[2] - 0.2 * windECEF[2];
        const detailPoint = fibrous ? stretchAlong(detail, windDir, stretch, scratch.stretched) : detail;
        setOffset(uniforms.cloudDetailA.value[index], detailPoint, noisePeriod(layer.scale, "detail"));
    }
}
