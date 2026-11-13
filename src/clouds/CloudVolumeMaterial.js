// CloudVolumeMaterial.js - the ShaderMaterials of the volumetric clouds, and the
// per-camera uniform packer.
//
// Two materials share ONE uniforms object (cloudShaders.js explains the two
// programs): the scene material draws in the world scene (composite, or a
// direct march), and the march material renders into a per-camera target at
// the quality's resolution. Every render of the world scene reaches the scene
// material's onBeforeRender with ITS camera: the main view, the look view,
// the water mirror, XR eyes and exports. The packer forms every
// camera-relative constant in double precision (CloudMath.js) and writes them
// into preallocated uniform values: no allocation per frame.
//
// The haze uniforms are SHARED BY REFERENCE with materialAtmosphereUniforms,
// whose values withMaterialAtmosphere sets for the draw in progress, so a
// cloud takes the haze the terrain under it gets in that view (with its own
// airlight scale at night, cloudAirlightScale). The refraction strength is
// read from terrestrialRefractionUniforms, which the scene hook sets per camera.

import {
    Color,
    CustomBlending,
    Matrix3,
    NoBlending,
    OneFactor,
    OneMinusSrcAlphaFactor,
    ShaderMaterial,
    Vector2,
    Vector3,
    Vector4,
} from "three";
import {atmosphereProjectionUniforms, setAtmosphereProjection} from "../atmosphere/AtmosphereProjection";
import {materialAtmosphereUniforms} from "../atmosphere/MaterialAtmosphere";
import {terrestrialRefractionUniforms} from "../atmosphere/terrestrialRefraction";
import {rayGeometryUniforms} from "../refraction/RayGeometryProjection";
import {
    CLOUD_FRAGMENT_SHADER,
    CLOUD_MAX_LAYERS,
    CLOUD_MAX_LIGHT_STEPS,
    CLOUD_MAX_SKIP_STEPS,
    CLOUD_MAX_STEPS,
    CLOUD_VERTEX_SHADER,
} from "./cloudShaders";
import {cloudQualitySettings, cloudTypeInfo} from "./CloudLayerModel";
import {
    localFrameAt,
    noisePeriod,
    positiveModulo,
    refractedRadius,
    shellConstant,
    sunBrightness,
    WGS84_A,
    WGS84_B,
} from "./CloudMath";

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

// The jitter pattern moves by the golden ratio each frame (a paused frame is stable).
const GOLDEN_RATIO_FRACTION = 0.6180339887498949;

function vec4Array() {
    return Array.from({length: CLOUD_MAX_LAYERS}, () => new Vector4());
}

function createUniforms() {
    const uniforms = {
        ...atmosphereProjectionUniforms(),
        cloudViewToWorld: {value: new Matrix3()},
        cloudUp: {value: new Vector3(0, 0, 1)},
        cloudR: {value: WGS84_A},
        cloudR0: {value: WGS84_A},
        cloudH0: {value: 0},
        cloudGroundRadius: {value: WGS84_A},
        cloudCEarth: {value: 0},
        cloudNear: {value: 0.1},
        cloudTMax: {value: MARCH_RANGE},
        cloudSunDir: {value: new Vector3(0, 0, 1)},
        cloudSunIntensity: {value: 0},
        cloudSunGain: {value: CLOUD_SUN_GAIN},
        cloudAmbientTop: {value: new Color()},
        cloudAmbientBottom: {value: new Color()},
        cloudAirlightScale: {value: 1},
        cloudLayerCount: {value: 0},
        cloudSteps: {value: 64},
        cloudSkipSteps: {value: 128},
        cloudLightSteps: {value: 4},
        cloudFineStep: {value: 2},
        cloudOpticalStep: {value: 0.8},
        cloudDetailLevel: {value: 2},
        cloudDebug: {value: 0},
        cloudLodBias: {value: 0},
        cloudPixelAngle: {value: 1e-3},
        cloudPixelSize: {value: 0},
        cloudRefraction: {value: false},
        cloudShapeTex: {value: null},
        cloudDetailTex: {value: null},
        cloudWeatherTex: {value: null},
        cloudBlueNoise: {value: null},
        cloudJitterOffset: {value: 0},
        cloudMarchSize: {value: new Vector2(1, 1)},
        cloudComposite: {value: false},
        cloudMarchColor: {value: null},
        cloudMarchFront: {value: null},
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
        cloudLayerExtra: {value: vec4Array()},
    };
    // Shared by reference: the values are the current draw's haze.
    for (const key of HAZE_KEYS) uniforms[key] = materialAtmosphereUniforms[key];
    return uniforms;
}

/**
 * The two materials and their shared uniforms.
 * scene: drawn in the world scene, premultiplied over the opaque image.
 * march: renders into the march target (two outputs, no blending).
 */
export function createCloudMaterials() {
    const uniforms = createUniforms();
    const scene = new ShaderMaterial({
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
    scene.userData.atmosphere = false;

    const march = new ShaderMaterial({
        name: "VolumetricCloudsMarch",
        uniforms,
        defines: {CLOUD_MRT: ""},
        vertexShader: CLOUD_VERTEX_SHADER,
        fragmentShader: CLOUD_FRAGMENT_SHADER,
        transparent: false,
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
    });
    march.userData.atmosphere = false;
    return {scene, march, uniforms};
}

// Scratch state for the packer (module level, reused every call).
const scratch = {
    frame: {h0: 0, R: WGS84_A, up: [0, 0, 1]},
    base: [0, 0, 0],
    stretched: [0, 0, 0],
    wind: [0, 0, 0],
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
 * The angular (perspective) or linear (orthographic) size of one march pixel.
 * Written into cloudPixelAngle / cloudPixelSize; the march's steps follow it.
 */
export function setMarchPixelSize(uniforms, camera, marchHeight, lens) {
    const projection = camera.projectionMatrix.elements;
    const height = Math.max(1, marchHeight);
    if (projection[15] === 1) {
        uniforms.cloudPixelAngle.value = 0;
        uniforms.cloudPixelSize.value = 2 / Math.max(projection[5], 1e-12) / height;
    } else if (lens) {
        // A fisheye images about its field across the circle; a pixel is that over its pixels.
        uniforms.cloudPixelAngle.value = Math.max(1e-5, (lens.fovRadians ?? Math.PI) / height);
        uniforms.cloudPixelSize.value = 0;
    } else {
        uniforms.cloudPixelAngle.value = Math.max(1e-6, 2 / Math.max(projection[5], 1e-12) / height);
        uniforms.cloudPixelSize.value = 0;
    }
}

/**
 * Fill the material uniforms for one camera.
 * @param {Object} uniforms - the shared uniforms
 * @param {Camera} camera - the camera of this draw (matrixWorld current)
 * @param {Object} state - from CNodeCloudLayers.renderState():
 *   {layers: [normalized layer], derived: [{windECEF:[3], windDir:[3], discECEF:[3]|null, discUp:[3]}],
 *    frame, quality, radii: {a, b}, sun: {dir: Vector3, intensity, angle}, ambient,
 *    airlightScale, lens: fisheye lens or null}
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
    uniforms.cloudH0.value = h0;
    uniforms.cloudNear.value = camera.near ?? 0.1;
    // Far enough to reach the horizon of a high camera (an orbital main view).
    uniforms.cloudTMax.value = MARCH_RANGE + 4 * Math.max(0, h0);
    const wholeFrame = Math.floor(state.frame ?? 0);
    uniforms.cloudJitterOffset.value = positiveModulo(wholeFrame * GOLDEN_RATIO_FRACTION, 1);

    // Terrestrial refraction lifts the terrain by the scene's shared k for this
    // camera; each layer then sits on a larger sphere (CloudMath.refractedRadius).
    // The ray-traced model draws its view through a ray table the clouds do not follow.
    const k = rayGeometryUniforms.uRayGeometry.value > 0.5 ? 0 : terrestrialRefractionUniforms.uTerrK.value;
    const scaleHeight = 1 / terrestrialRefractionUniforms.uTerrInvH.value;
    uniforms.cloudRefraction.value = k > 0;
    const groundRadius = k > 0 ? refractedRadius(R, k, h0, 0, scaleHeight) : R;
    uniforms.cloudGroundRadius.value = groundRadius;
    uniforms.cloudCEarth.value = shellConstant(h0, groundRadius, GROUND_CAP);

    const quality = cloudQualitySettings(state.quality);
    uniforms.cloudSteps.value = Math.min(quality.steps, CLOUD_MAX_STEPS);
    uniforms.cloudSkipSteps.value = Math.min(quality.skipSteps, CLOUD_MAX_SKIP_STEPS);
    uniforms.cloudLightSteps.value = Math.min(quality.lightSteps, CLOUD_MAX_LIGHT_STEPS);
    uniforms.cloudFineStep.value = quality.fineStep;
    uniforms.cloudOpticalStep.value = quality.opticalStep;
    uniforms.cloudDetailLevel.value = quality.detailLevel ?? 2;
    uniforms.cloudLodBias.value = quality.lodBias ?? 0;

    // Key light (the sun, or the moon at night) and sky light.
    uniforms.cloudSunDir.value.copy(state.sun.dir);
    uniforms.cloudSunIntensity.value = state.sun.intensity;
    uniforms.cloudAirlightScale.value = state.airlightScale ?? 1;
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
        const radius = k > 0 ? refractedRadius(R, k, h0, baseAltitude + 0.5 * thickness, scaleHeight) : R;

        if (sheet) {
            const mid = shellConstant(h0, radius, baseAltitude + 0.5 * thickness);
            uniforms.cloudShell.value[index].set(mid, mid, baseAltitude, thickness);
        } else {
            uniforms.cloudShell.value[index].set(shellConstant(h0, radius, baseAltitude),
                shellConstant(h0, radius, baseAltitude + thickness), baseAltitude, thickness);
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
        uniforms.cloudLayerExtra.value[index].set(stretch, 0, radius, 0);

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
