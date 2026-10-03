import {CircleGeometry, DataTexture, FloatType, Float32BufferAttribute, DoubleSide, NearestFilter, NoColorSpace, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Vector3,
    RGBAFormat, Scene, WebGLRenderer, WebGLRenderTarget} from "three";
import {ThermalPipeline} from "./ThermalPipeline.js";
import {integrateTurbulence} from "./turbulence.js";
import {buildOpticalDomain, timingDistribution} from "./sensorMath.js";
import {cloudOpacity, opaqueCloudRadiance, thermalSeaDistance} from "./atmosphere.js";
import {createStatisticalSea, seaRayAzimuth} from "./atmosphere.js";
import {apparentTemperature, inBandRadiance, PHOTON_SCALE} from "./radiometry.js";
import {displayFragment, enlargeFragment} from "./shaders.js";
import {POLARITY_PROFILES, SCATTER_PRESETS} from "./sensorPresets.js";
import {defaultSettings, normalizeSettings} from "./thermalSchema.js";
import {createThermalRayGeometry} from "./atmosphere.js";
import {backgroundAtElevation, brightnessErrorBound, blackbodyBands, evaluatePhotonPath, clearSky, createAtmosphere, createSkyElevationLUT, sampleSkyElevationLUT, seaBackground,
    skyRayElevation, skyViewGeometry} from "./atmosphere.js";
import {applyFarScatter, applyOptics, displayCodes, displayCurve, displayCurveLUT, enlargeImage, temporalFilter, detectorCounts, electronsPerRadiance, integrationTime,
    opticalKernels, processCounts, processingParameters, sampleDetector, sum, windowImage, localEnhancement} from "./sensorMath.js";

// Estimated horizon fixture: observer 21 m, dimensionless k=0.13. The reference
// lift is calculated from the terrestrial projection's density and saturation
// laws, independently of the inverse first-hit solver. Defaults are model inputs.
export function thermalRefractionHorizonFixture(enabled = true) {
    const R = 6371000, h = 21, H = 8500, maxBend = 34 / 60 * Math.PI / 180, maxLift = 3 * H;
    const lift = (d, z) => {
        if (!enabled) return 0;
        const ht = Math.max(0, h + z + d * d / (2 * R)), dh = h - ht;
        const density = Math.abs(dh) < 1e-6 ? Math.exp(-ht / H) : H * (Math.exp(-ht / H) - Math.exp(-h / H)) / dh;
        const angle = .13 * density * d / (2 * R);
        const raw = d * angle / Math.hypot(1, angle / maxBend);
        return raw / Math.hypot(1, raw / maxLift);
    };
    const rayGeometry = createThermalRayGeometry({sensorAltitudeM: h, earthRadiusM: R, lift, key: `horizonFixture:${enabled}`});
    // Calculated curved surface mesh in observer-relative coordinates. A 10 m
    // longitudinal step resolves the projected limb well below a test pixel.
    const meshGeometry = new PlaneGeometry(60, 40000, 2, 4000), positions = meshGeometry.attributes.position;
    const lifts = [];
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i), distance = positions.getY(i) + 22000;
        const d = Math.hypot(x, distance), z = -h - d * d / (R + Math.sqrt(R * R - d * d));
        positions.setXYZ(i, x, z, -distance); lifts.push(lift(d, z));
    }
    meshGeometry.setAttribute("thermalFixtureLiftM", new Float32BufferAttribute(lifts, 1));
    const prepareMaterial = pass => {
        pass.side = DoubleSide;
        pass.onBeforeCompile = shader => {
            shader.vertexShader = "attribute float thermalFixtureLiftM;\n" + shader.vertexShader.replace("#include <project_vertex>",
                "#include <project_vertex>\ngl_Position = projectionMatrix * (mvPosition + viewMatrix * vec4(0.0, thermalFixtureLiftM, 0.0, 0.0));");
        };
    };
    return {lift, rayGeometry, meshGeometry, prepareMaterial};
}

/** Calculated rear-view engine spacing from the A340-500/-600 aircraft planning
 * document: stations +/-9.37 and +/-19.27 m.
 * The 125000 m range, 750 K equal sources, 0.25 native-pixel diameter and offsets
 * are estimated test conditions, not inferred engine temperatures or dimensions.
 * A 32x32 crop and 8-pixel kernel radius contain the test cores. Scatter is off
 * to isolate diffraction sampling. Estimated numerical acceptance: integrated
 * absolute radiance difference <=5% of the factor-8 sampled flux.
 */
export function opticalConvergenceCase() {
    const settings = normalizeSettings({...defaultSettings(), detectorWidth: 32, detectorHeight: 32,
        fieldMode: "focalLength", opticalSamplingMode: "nyquist", opticsRadiusPx: 8,
        scatterPreset: "custom", scatterFraction: 0, psfTemperatureK: 750,
        skySource: "manual", skyTemperatureK: 0, atmosphereEnabled: false,
        turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
        shadingK: 0, fixedPatternFraction: 0, noiseEnabled: false});
    const points = [-19.27, -9.37, 9.37, 19.27].map(x => ({
        x: x / 125000 * settings.focalLengthM / settings.pixelPitchM + 0.13, y: 0.21}));
    return {settings, points, radiusPx: 0.125, temperatureK: 750, tolerance: 0.05};
}

/** CPU counterpart of coverage refinement: independent 128-per-pixel coverage
 * samples deposited into fine cells, then production optics and pixel footprint.
 * Positions/radius use native pixels about the image center; radiance uses 1e20
 * photons/(s m² sr). The GPU uses a 192-sided disc (area error <0.02%).
 */
export function sampledConvergenceSources(testCase, settings = testCase.settings) {
    const coverage = 128, factor = settings.supersample;
    const width = settings.detectorWidth * factor, height = settings.detectorHeight * factor;
    const input = new Float32Array(width * height);
    const photons = inBandRadiance(testCase.temperatureK, {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}).photon / PHOTON_SCALE;
    for (const point of testCase.points) {
        const cx = point.x + settings.detectorWidth / 2, cy = point.y + settings.detectorHeight / 2;
        for (let y = Math.floor((cy - testCase.radiusPx) * coverage); y < Math.ceil((cy + testCase.radiusPx) * coverage); y++)
            for (let x = Math.floor((cx - testCase.radiusPx) * coverage); x < Math.ceil((cx + testCase.radiusPx) * coverage); x++) {
                if (((x + 0.5) / coverage - cx) ** 2 + ((y + 0.5) / coverage - cy) ** 2 > testCase.radiusPx ** 2) continue;
                const column = Math.floor(x * factor / coverage), row = Math.floor(y * factor / coverage);
                if (column >= 0 && column < width && row >= 0 && row < height)
                    input[row * width + column] += photons / (coverage / factor) ** 2;
            }
    }
    return sampleDetector(applyOptics(input, width, height, opticalKernels(settings)), width, height, factor, settings.fillFactor);
}

export const relativeRadianceError = (actual, expected) => actual.length !== expected.length ? Infinity :
    actual.reduce((total, value, index) => total + Math.abs(value - expected[index]), 0) / sum(expected);

/** Estimated numerical test scene: one subpixel emitter and all three blur terms.
 * r0 .572 m is the calculated HV21 reference path; jitter/diffusion use the
 * estimated MX-15 defaults. Independent fine coverage is shared with Jest.
 */
export function blurredPointSourceCase() {
    const base = opticalConvergenceCase();
    return {...base, points: [{x: 0.13, y: 0.21}], temperatureK: 800,
        settings: {...base.settings, fillFactor: 1, turbulenceR0M: 0.572, jitterRmsUrad: 2.714, diffusionSigmaPx: 0.2}};
}

/** Estimated validation geometry; calculated CPU table/rays in photon units.
 * The 32x24 detector and 1.5 degree field resolve a clear sky gradient. A supplied
 * camera-space up exercises roll. Samples are bottom row first, like WebGL.
 */
export function skyGradientReference(skyUp = null) {
    const settings = normalizeSettings({detectorWidth: 32, detectorHeight: 24,
        verticalFovDeg: 1.5, apertureM: .005, pathElevationDeg: 2.23, sensorAltitudeM: 1382,
        opticsEnabled: false, turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
        scatterPreset: "custom", scatterFraction: 0, shadingK: 0, fixedPatternFraction: 0,
        noiseEnabled: false, atmosphereEnabled: true, skySource: "atmosphere"});
    const view = skyViewGeometry(settings, skyUp), atmosphere = createAtmosphere();
    const table = createSkyElevationLUT({view, sensorAltitudeM: settings.sensorAltitudeM,
        temperatureK: settings.surfaceTemperatureK}, atmosphere);
    const width = settings.detectorWidth * settings.supersample, height = settings.detectorHeight * settings.supersample;
    const pixels = [[1, 1], [width - 2, 1], [Math.floor(width / 2), Math.floor(height / 2)],
        [1, height - 2], [width - 2, height - 2]];
    const values = pixels.map(([x, y]) => sampleSkyElevationLUT(table,
        skyRayElevation(2 * (x + 0.5) / width - 1, 2 * (y + 0.5) / height - 1, view)) / PHOTON_SCALE);
    return {settings, view, atmosphere, table, width, height, pixels, values};
}

/** Estimated unequal-population ADC fixture: a textured background occupies
 * 30 of 32 columns, with two distinct hot columns. Plateau, automatic and manual
 * must produce different outputs before any GPU comparison can be informative.
 */
export function processingModesReference() {
    return Float32Array.from({length: 32 * 32}, (_, i) => {
        const x = i % 32;
        return x < 30 ? 3800 + (x % 16) : x === 30 ? 12000 : 16000;
    });
}

/** Measured slope witnesses in black-hot codes. Interpolate the inverse of the
 * fixed LUT only to locate probes; the rendered derivative remains independent.
 * Calculated finite-difference interval 1e-4 drive resolves the local segment.
 */
export function measuredDisplayReference() {
    const settings = {sensorPreset: "MX15", displayCurve: "measured", responseGamma: 1};
    const lut = displayCurveLUT(settings), epsilon = 1e-4;
    const probes = [58, 166, 234].map(code => {
        const response = 1 - code / 255;
        const index = lut.findIndex(value => value >= response) - 1;
        const u = (index + (response - lut[index]) / (lut[index + 1] - lut[index])) / (lut.length - 1);
        return {code, u};
    });
    return {settings, epsilon, probes, drive: Float32Array.from(probes.flatMap(({u}) => [u - epsilon, u + epsilon]))};
}

/** Flux-normalized central moments on a fine grid, in fine-pixel squared units. */
export function imageAxisVariances(image, width) {
    const flux = sum(image);
    const mean = [sum(image.map((v, i) => v * (i % width))) / flux,
        sum(image.map((v, i) => v * Math.floor(i / width))) / flux];
    return [sum(image.map((v, i) => v * (i % width - mean[0]) ** 2)) / flux,
        sum(image.map((v, i) => v * (Math.floor(i / width) - mean[1]) ** 2)) / flux];
}

/** Owns a detached canvas and renderer; does not touch a caller's scene or GL state.
 * Expected/measured/tolerance carry units in each check name. Numeric tolerance is
 * absolute; a failed exception check includes the actual error text in measured.
 * Render-target readbacks are bottom row first. No fixture depends on display color.
 */
export async function runThermalSelfTest() {
    const checks = [], geometries = new Set(), materials = new Set();
    const performanceReport = {status: "not run", movingCamera: []};
    let renderer, pipeline, target;
    const record = (name, expected, measured, tolerance) => {
        const pass = Number.isFinite(measured) && Math.abs(measured - expected) <= tolerance;
        checks.push({name, expected, measured, tolerance, pass});
    };
    const test = async (name, operation) => {
        try { await operation(); } catch (error) {
            // The first stack frames say which call failed, not just why.
            checks.push({name, expected: "completed without an exception", measured: error.message, tolerance: 0, pass: false,
                message: String(error.stack ?? "").split("\n").slice(1, 7).map(line => line.trim()).join(" | ")});
        }
    };
    const maxError = (actual, expected) => {
        if (actual.length !== expected.length) return Infinity;
        let error = 0;
        for (let pixel = 0; pixel < actual.length; pixel++) error = Math.max(error, Math.abs(actual[pixel] - expected[pixel]));
        return error;
    };
    try {
        const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(32, 32) : document.createElement("canvas");
        renderer = new WebGLRenderer({canvas, antialias: false, alpha: false});
        renderer.setSize(32, 32, false);
        renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
            throw new Error(`Thermal shader failed: ${gl.getProgramInfoLog(program)}; vertex: ${gl.getShaderInfoLog(vertex)}; fragment: ${gl.getShaderInfoLog(fragment)}`);
        };
        pipeline = new ThermalPipeline(renderer, {analysis: true, gpuTiming: true});
        target = new WebGLRenderTarget(32, 32, {type: FloatType, format: RGBAFormat});
        const settings = {...defaultSettings(), focalStep: "free", temporalFilterAlpha: 0, sampling: "linear",
            detectorWidth: 32, detectorHeight: 32,
            opticsEnabled: false, scatterFraction: 0, atmosphereEnabled: false, supersample: 2,
            opticalSamplingMode: "manual", skySource: "manual",
            turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
            fillFactor: 1, skyTemperatureK: 0, environmentTemperatureK: 0, solarScale: 0,
            noiseEnabled: false, darkElectronsPerS: 0, adcOffsetCounts: 0, localAmount: 0, responseGamma: 1, displayCurve: "linear",
            exposureMode: "manual", shadingK: 0, fixedPatternFraction: 0, scatterPreset: "custom",
            opticsRadiusPx: 4, gainMode: "manual", fixedGain: 1, fixedLevel: 8191.5};
        // Keep pitch/focal geometry fixed when varying detector crop dimensions.
        settings.fieldMode = "focalLength";
        const camera = new OrthographicCamera(-16, 16, 16, -16, 0.1, 100);
        camera.position.z = 10;
        const mesh = (geometry, temperatureK) => {
            const paint = new MeshBasicMaterial({color: 0xff00ff});
            geometries.add(geometry); materials.add(paint);
            const object = new Mesh(geometry, paint);
            object.userData.thermal = {temperatureK, emissivity: 1};
            return object;
        };
        const render = (scene, extra = {}, frame = 0) => pipeline.render({scene, camera,
            settings: {...settings, ...extra}, target, frame});
        const uniform = new Scene(), patch = mesh(new PlaneGeometry(32, 32), 300);
        uniform.add(patch);
        await test("Uniform photon radiance and charge conversion", () => {
            render(uniform);
            const expected = inBandRadiance(300).photon / PHOTON_SCALE;
            record("Uniform radiance: maximum absolute error, scaled photon units", 0,
                maxError(pipeline.readStage("radiance").image, new Float32Array(64 * 64).fill(expected)), expected * 2e-5);
            const expectedCounts = detectorCounts(new Float32Array(32 * 32).fill(expected), settings);
            record("Uniform counts: maximum absolute error, 14-bit counts", 0, maxError(pipeline.readDetectorCounts(), expectedCounts), 1);
        });
        const pointScene = new Scene();
        const point = mesh(new CircleGeometry(0.125, 192), 800);
        pointScene.add(point);
        await test("Subpixel position and sampling conservation", () => {
            // Polygonal projected area, independent of raster coverage or pipeline output.
            const area = 192 * 0.5 * 0.125 ** 2 * Math.sin(2 * Math.PI / 192);
            const expected = area * inBandRadiance(800).photon / PHOTON_SCALE;
            const fluxes = [];
            for (const supersample of [2, 4, 8]) for (const offset of [0, 0.13, 0.37, 0.49]) {
                point.position.set(offset, offset * 0.61, 0);
                render(pointScene, {supersample});
                const radiance = pipeline.readStage("radiance").image;
                const measured = sum(radiance) / supersample ** 2;
                fluxes.push(measured);
                record(`Quarter-pixel source flux, sampling ${supersample}, offset ${offset}, radiance·pixel²`, expected, measured, expected * 0.05);
            }
            record("Quarter-pixel source maximum flux variation / analytic flux", 0,
                (Math.max(...fluxes) - Math.min(...fluxes)) / expected, 0.05);
        });
        await test("Normalized optics preserves contained source flux", () => {
            point.position.set(0.13, 0.21, 0);
            const optical = {...settings, opticsEnabled: true, scatterFraction: 0.07,
                scatterShoulderRad: 10e-6, scatterCutoffRad: 60e-6};
            render(pointScene, optical);
            const before = pipeline.readStage("radiance"), after = pipeline.readStage("optics");
            record("Optics total source flux / incoming flux", 1, sum(after.image) / sum(before.image), 0.002);
            const kernels = opticalKernels(optical);
            const reference = applyOptics(before.image, before.width, before.height, kernels);
            record("GPU FFT convolution: maximum error / source peak", 0,
                maxError(after.image, reference) / Math.max(...reference), 0.001);
            const native = sampleDetector(reference, before.width, before.height, optical.supersample);
            record("Optics and detector CPU/GPU comparison, 14-bit counts", 0,
                maxError(pipeline.readDetectorCounts(), detectorCounts(native, optical)), 2);
        });
        await test("Optical Nyquist convergence for four rear-view sources", () => {
            const testCase = opticalConvergenceCase(), sourceScene = new Scene();
            for (const point of testCase.points) {
                const source = mesh(new CircleGeometry(testCase.radiusPx, 192), testCase.temperatureK);
                source.position.set(point.x, point.y, 0); sourceScene.add(source);
            }
            render(sourceScene, testCase.settings);
            record("MX-15 optical Nyquist factor", 4, pipeline.lastFrame.opticalSampling.factor, 0);
            const nyquist = pipeline.readStage("sampled").image;
            record("Four-source Nyquist GPU/CPU integrated radiance error / CPU flux", 0,
                relativeRadianceError(nyquist, sampledConvergenceSources(testCase)), 0.01);
            render(sourceScene, {...testCase.settings, opticalSamplingMode: "manual", supersample: 8});
            const reference = pipeline.readStage("sampled").image;
            record("Four-source Nyquist versus 8x integrated radiance error / 8x flux", 0,
                relativeRadianceError(nyquist, reference), testCase.tolerance);
        });
        await test("Blurred point-source kernel against independent CPU coverage and optics", () => {
            const testCase = blurredPointSourceCase();
            point.position.set(testCase.points[0].x, testCase.points[0].y, 0);
            render(pointScene, testCase.settings);
            const before = pipeline.readStage("radiance"), after = pipeline.readStage("optics");
            const expected = applyOptics(before.image, before.width, before.height, opticalKernels(testCase.settings));
            record("Turbulence/jitter/diffusion GPU/CPU kernel integrated error / flux", 0,
                relativeRadianceError(after.image, expected), 0.001);
            record("Blurred point-source contained flux ratio", 1, sum(after.image) / sum(before.image), 0.002);
            record("Blurred point-source native GPU/CPU independent coverage error / flux", 0,
                relativeRadianceError(pipeline.readStage("sampled").image, sampledConvergenceSources(testCase)), 0.01);
        });
        await test("Per-pixel atmospheric sky against CPU elevation table", () => {
            const elevation = 2.23 * Math.PI / 180;
            for (const skyUp of [null, [Math.cos(elevation), 0, -Math.sin(elevation)]]) {
                const reference = skyGradientReference(skyUp);
                const perspective = new PerspectiveCamera();
                pipeline.render({scene: new Scene(), camera: perspective, settings: reference.settings, skyUp, target});
                const image = pipeline.readStage("radiance").image;
                const errors = reference.pixels.map(([x, y], i) =>
                    Math.abs(image[y * reference.width + x] / reference.values[i] - 1));
                record(`Per-pixel sky ${skyUp ? "rolled" : "default up"}: maximum relative photon error`,
                    0, Math.max(...errors), 1e-5);
                const table = pipeline.skyTable;
                pipeline.render({scene: new Scene(), camera: perspective, settings: reference.settings, skyUp, target});
                record(`Unchanged reference sky ${skyUp ? "rolled" : "default up"}: identical cached table`,
                    1, Number(pipeline.skyTable === table), 0);
                record(`Unchanged reference sky ${skyUp ? "rolled" : "default up"}: identical GPU radiance`,
                    0, maxError(image, pipeline.readStage("radiance").image), 0);
            }
        });
        await test("Interactive sky is compared against its stated brightness bound", () => {
            const bounded = new ThermalPipeline(renderer, {analysis: false, createOpticsWorker: () => null});
            try {
                const elevation = 2.23 * Math.PI / 180;
                for (const skyUp of [null, [Math.cos(elevation), 0, -Math.sin(elevation)]]) {
                    const reference = skyGradientReference(skyUp), camera = new PerspectiveCamera();
                    bounded.render({scene: new Scene(), camera, settings: reference.settings, skyUp, target});
                    const image = bounded.readStage("radiance").image, band = {minUm: 3, maxUm: 5};
                    const errors = reference.pixels.map(([x, y]) => {
                        const e = skyRayElevation(2 * (x + .5) / reference.width - 1, 2 * (y + .5) / reference.height - 1, reference.view);
                        const exact = backgroundAtElevation(e, {sensorAltitudeM: reference.settings.sensorAltitudeM,
                            temperatureK: reference.settings.surfaceTemperatureK, band}, reference.atmosphere).photonRadiance;
                        const actual = image[y * reference.width + x] * PHOTON_SCALE;
                        return brightnessErrorBound(Math.abs(actual - exact), Math.min(actual, exact), band);
                    });
                    record(`Bounded interactive sky ${skyUp ? "rolled" : "default up"}: brightness error, K`,
                        0, Math.max(...errors), bounded.lastFrame.background.interpolation.toleranceK);
                }
            } finally {bounded.dispose();}
        });
        await test("Coarse startup and a paused rebuild both produce complete frames", async () => {
            let request;
            const worker = {postMessage(message) {request = message;}, terminate() {}};
            const live = new ThermalPipeline(renderer, {analysis: false, createOpticsWorker: () => worker});
            const configured = {...settings, opticsRadiusPx: 2, gainMode: "manual"};
            try {
                live.render({scene: uniform, camera, settings: configured, target});
                record("Coarse startup has a completed display", 1, Number(live.hasFrame), 0);
                record("Coarse startup states its calculated contrast error bound", 2, live.lastFrame.opticsCache.errorL1, 0);
                record("Coarse startup has a readout label", 1, Number(live.lastFrame.opticsCache.message.includes("Coarse")), 0);
                await live.opticsScheduler.workerPromise;
                await Promise.resolve();
                worker.onmessage({data: {id: request.id, domain: buildOpticalDomain(request.settings,
                    request.width, request.height, request.spectrum)}});
                live.render({scene: uniform, camera, settings: configured, target});
                const kernel = live.activeKernels;
                live.render({scene: uniform, camera, settings: {...configured, defocusM: 1e-5}, target});
                record("Paused rebuild retains the last valid kernel", 1, Number(live.activeKernels === kernel), 0);
                record("Paused rebuild has a completed display", 1, Number(live.hasFrame), 0);
                record("Paused rebuild display readback is finite", 1,
                    Number(live.readStage("display").image.every(Number.isFinite)), 0);
            } finally {live.dispose();}
        });
        await test("Atmospheric sky and sea background against CPU", () => {
            for (const pathElevationDeg of [2.23, -30]) for (const skyGradient of [false, true]) {
                const atmospheric = {skyGradient,skySource: "atmosphere", atmosphereEnabled: true,
                    sensorAltitudeM: 1382, pathElevationDeg, atmosphereMaxRangeM: 200000};
                render(new Scene(), atmospheric);
                const geometry = {sensorAltitudeM: 1382, elevationRad: pathElevationDeg * Math.PI / 180};
                const accuracy = {quantity: "photon", segments: 96, band: {minUm: 3, maxUm: 5}};
                const sky = clearSky(geometry, pipeline.atmosphere, accuracy);
                const background = sky.kind === "surface" ? seaBackground({...geometry,
                    temperatureK: settings.surfaceTemperatureK}, pipeline.atmosphere, accuracy) : sky;
                const expected = sum(background.radiance) / PHOTON_SCALE;
                record(`${background.kind} gradient=${skyGradient} GPU background maximum relative radiance error`, 0,
                    maxError(pipeline.readStage("sampled").image, new Float32Array(32 * 32).fill(expected)) / expected, 1e-5);
                record(`${background.kind} gradient=${skyGradient} reported brightness temperature, K`, apparentTemperature(expected * PHOTON_SCALE),
                    pipeline.lastFrame.backgroundTemperatureK, 1e-9);
            }
        });
        await test("Cloud billboard transfer and shader-composite fallback", () => {
            const mask = new DataTexture(new Float32Array([1, 1, 1, .5]), 1, 1, RGBAFormat, FloatType);
            mask.needsUpdate = true; mask.colorSpace = NoColorSpace;
            const view = new OrthographicCamera(-1, 1, 1, -1, .1, 300000);
            const scene = new Scene(), band = {minUm: 3, maxUm: 5};
            const configured = {...settings, atmosphereEnabled: true, skySource: "atmosphere",
                sensorAltitudeM: 1382, pathElevationDeg: 1.84, atmosphereMaxRangeM: 200000};
            let depth = 0;
            const adapter = {cloudSheets: () => ({sheets: [
                {id: "far", center: [0, 0, -130000], size: [2, 2], temperatureK: 249, temperaturePolicy: "isothermal", opticalDepth: depth, mask},
                {id: "near", center: [0, 0, -100000], size: [2, 2], temperatureK: 259, temperaturePolicy: "isothermal", opticalDepth: depth, mask}], diagnostics: []})};
            try {
                for (const source of ["atmosphere", "manual"]) for (const fallback of [false, true]) for (const q of [0, Math.log(100), 20]) {
                    depth = q; pipeline.forceCloudShaderComposite = fallback;
                    pipeline.render({scene, camera: view, target, settings: {...configured, skySource: source, skyTemperatureK: 300}, radianceAdapter: adapter});
                    const atmosphere = pipeline.atmosphere;
                    let expected = source === "manual" ? inBandRadiance(300, band).photon : sum(clearSky({sensorAltitudeM: 1382, elevationRad: 1.84 * Math.PI / 180},
                        atmosphere, {quantity: "photon", band, segments: 96}).radiance);
                    for (const [range, temperatureK] of [[130000, 249], [100000, 259]]) {
                        const source = opaqueCloudRadiance({sensorAltitudeM: 1382, elevationRad: 1.84 * Math.PI / 180, slantRangeM: range},
                            atmosphere, {temperatureK, band}).photonRadiance;
                        const alpha = cloudOpacity(.5, q); expected = alpha * source + (1 - alpha) * expected;
                    }
                    // Small physical patch: corner-to-axis difference is below the
                    // 0.005 K received interpolation gate; compare the full patch.
                    const image = pipeline.readStage("radiance").image;
                    const expectedK = apparentTemperature(expected, {quantity: "photon", band});
                    const extrema = [image.reduce((a, b) => Math.min(a, b), Infinity), image.reduce((a, b) => Math.max(a, b), -Infinity)];
                    const error = Math.max(...extrema.map(L => Math.abs(apparentTemperature(L * PHOTON_SCALE, {quantity: "photon", band}) - expectedK)));
                    record(`Cloud ${source} q=${q} ${fallback ? "forced " : ""}${pipeline.lastFrame.clouds.composition}: received error K`, 0, error, .005);
                }
            } finally {mask.dispose(); pipeline.forceCloudShaderComposite = false;}
        });
        await test("Perspective cloud horizon, local temperature and opaque foreground", () => {
            // Estimated synthetic geometry. Pixel-center expectations use physical
            // ray intersections and direct atmospheric integration, never the GPU LUT.
            const mask = new DataTexture(new Float32Array([1, 1, 1, 0, 1, 1, 1, .5]), 2, 1, RGBAFormat, FloatType);
            mask.minFilter = mask.magFilter = NearestFilter; mask.needsUpdate = true; mask.colorSpace = NoColorSpace;
            const view = new PerspectiveCamera(4, 1, 1, 100000), scene = new Scene(), band = {minUm: 3, maxUm: 5};
            const foreground = mesh(new PlaneGeometry(60, 1000), 310);
            foreground.position.set(130, 0, -5000); scene.add(foreground);
            let active = [];
            const adapter = {attributes: object => object === foreground ? {temperatureK: 310, emissivity: 1} : false,
                cloudSheets: () => ({sheets: active, diagnostics: []})};
            try {
                for (const height of [21, 3000]) for (const fallback of [false, true]) {
                    if (!fallback && !renderer.extensions.has("EXT_float_blend")) {
                        record("Float blending hardware path is required for complete acceptance", 1, 0, 0);
                        continue;
                    }
                    pipeline.forceCloudShaderComposite = fallback;
                    const configured = normalizeSettings({...settings, fieldMode: "fieldOfView", verticalFovDeg: 4, apertureM: .005,
                        atmosphereEnabled: true, skySource: "atmosphere", skyGradient: true,
                        sensorAltitudeM: height, pathElevationDeg: 0, atmosphereMaxRangeM: 30000});
                    active = []; pipeline.render({scene, camera: view, settings: configured, target, radianceAdapter: adapter});
                    const baseline = pipeline.readStage("radiance"), saved = Float32Array.from(baseline.image);
                    const range = height === 21 ? 20000 : 10000;
                    const sheets = [
                        {id: "far", center: [0, 0, -range - 1000], size: [1000, 500], temperatureK: 305, temperaturePolicy: "isothermal", mask},
                        {id: "near", center: [0, 0, -range], size: [1000, 500], temperaturePolicy: "airAtAltitude", mask}];
                    for (const q of [0, .7, 20]) {
                        active = sheets.map(s => ({...s, opticalDepth: q}));
                        pipeline.render({scene, camera: view, settings: configured, target, radianceAdapter: adapter});
                        const {image, width, height: rows} = pipeline.readStage("radiance");
                        let maximumK = 0, occluded = 0, clear = 0, cloudPixels = 0;
                        // Calculated 8-pixel stride; avoid texture/geometry edges.
                        for (let y = 3; y < rows; y += 8) for (let x = 3; x < width; x += 8) {
                            const dx = (2 * (x + .5) / width - 1) * Math.tan(2 * Math.PI / 180);
                            const dy = (2 * (y + .5) / rows - 1) * Math.tan(2 * Math.PI / 180);
                            const rayLength = Math.hypot(dx, dy, 1), seaDistance = thermalSeaDistance(height, dy / rayLength);
                            const foregroundHit = dx * 5000 > 100 && dx * 5000 < 160 && Math.abs(dy * 5000) < 500;
                            let expected = saved[y * width + x] * PHOTON_SCALE;
                            if (foregroundHit) occluded++;
                            else for (const sheet of active) {
                                const distance = -sheet.center[2], px = dx * distance, py = dy * distance;
                                if (Math.abs(px) >= 500 || Math.abs(py) >= 250 || distance * rayLength > seaDistance || px < 0) {clear++; continue;}
                                cloudPixels++;
                                const source = opaqueCloudRadiance({sensorAltitudeM: height, elevationRad: Math.atan2(dy, Math.hypot(dx, 1)),
                                    slantRangeM: distance * rayLength}, pipeline.atmosphere, {band,
                                    temperatureK: sheet.temperaturePolicy === "isothermal" ? sheet.temperatureK : undefined}).photonRadiance;
                                const alpha = 1 - Math.exp(-q * .5);
                                expected = alpha * source + (1 - alpha) * expected;
                            }
                            maximumK = Math.max(maximumK, Math.abs(apparentTemperature(image[y * width + x] * PHOTON_SCALE, {band, quantity: "photon"}) -
                                apparentTemperature(expected, {band, quantity: "photon"})));
                        }
                        record(`Perspective h=${height} m q=${q} ${fallback ? "fallback" : "floatBlend"} error K`, 0, maximumK, .005);
                        record("Opaque foreground samples exercised", 1, Number(occluded > 0), 0);
                        record("Transparent or horizon-hidden support exercised", 1, Number(clear > 0), 0);
                        record("Visible local-temperature cloud samples exercised", 1, Number(cloudPixels > 0), 0);
                    }
                }
            } finally {mask.dispose(); pipeline.forceCloudShaderComposite = false;}
        });
        await test("Refracted horizon: projected ocean edge, analytic boundary and changed coverage", () => {
            for (const enabled of [false, true]) {
                const fixture = thermalRefractionHorizonFixture(enabled);
                geometries.add(fixture.meshGeometry);
                const view = new PerspectiveCamera(.08, 1, 1, 300000);
                const horizon = fixture.rayGeometry.horizonRad;
                view.lookAt(0, Math.sin(horizon), -Math.cos(horizon)); view.updateMatrixWorld();
                const scene = new Scene(), ocean = mesh(fixture.meshGeometry, 300); scene.add(ocean);
                const configured = normalizeSettings({...settings, fieldMode: "fieldOfView", verticalFovDeg: .08,
                    sensorAltitudeM: 21, skySource: "manual", skyTemperatureK: 0, seaMode: "statistical"});
                const up = new Vector3(0, 1, 0).transformDirection(view.matrixWorldInverse);
                const adapter = {materialKey: `horizonMesh:${enabled}`, rayGeometry: () => fixture.rayGeometry,
                    prepareMaterial: fixture.prepareMaterial, allowRangeClamping: () => true};
                pipeline.render({scene, camera: view, skyUp: up, target, settings: configured, radianceAdapter: adapter});
                const raster = pipeline.readStage("radiance"), geometry = skyViewGeometry(configured, up, view);
                let mismatches = 0, seaPixels = 0, skyPixels = 0;
                for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
                    const e = skyRayElevation(2 * (x + .5) / raster.width - 1, 2 * (y + .5) / raster.height - 1, geometry);
                    const sea = e <= horizon;
                    sea ? seaPixels++ : skyPixels++;
                    if ((raster.image[y * raster.width + x] > 0) !== sea) mismatches++;
                }
                record(`Projected ocean/analytic limb mismatch pixels, refraction ${enabled}`, 0, mismatches, 0);
                record(`Both horizon branches exercised, refraction ${enabled}`, 1, Number(seaPixels > 0 && skyPixels > 0), 0);
                let reference;
                for (const coverage of [1, .5, 0]) {
                    ocean.visible = coverage > 0; ocean.scale.x = coverage || 1;
                    pipeline.render({scene, camera: view, skyUp: up, target,
                        settings: {...configured, skySource: "atmosphere", skyGradient: true},
                        radianceAdapter: {...adapter, attributes: () => ({sea: true})}});
                    const image = pipeline.readStage("radiance").image;
                    reference ??= image;
                    record(`Horizon coverage ${coverage}, refraction ${enabled}: scaled photon error`, 0, maxError(image, reference), 1e-6);
                    let branchErrors = 0;
                    for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
                        const e = skyRayElevation(2 * (x + .5) / raster.width - 1, 2 * (y + .5) / raster.height - 1, geometry);
                        if ((image[y * raster.width + x] > 0) !== (e <= horizon)) branchErrors++;
                    }
                    record(`Analytic sea/sky classification, coverage ${coverage}, refraction ${enabled}`, 0, branchErrors, 0);
                }
                const mask = new DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, RGBAFormat, FloatType);
                mask.needsUpdate = true;
                // Estimated distant hot sheet behind every sea hit. Its physical
                // chord, apparent anchor and opacity are independent test inputs.
                const center = new Vector3(0, 0, -50000), world = center.clone().applyMatrix4(view.matrixWorld);
                world.y += fixture.lift(Math.hypot(world.x, world.z), world.y);
                const apparentCenter = world.applyMatrix4(view.matrixWorldInverse).toArray();
                const source = inBandRadiance(500).photon / PHOTON_SCALE;
                try {
                    for (const fallback of [false, true]) {
                        pipeline.forceCloudShaderComposite = fallback;
                        pipeline.render({scene, camera: view, skyUp: up, target,
                            settings: {...configured, skySource: "atmosphere", skyGradient: true},
                            radianceAdapter: {...adapter, attributes: () => ({sea: true}), cloudSheets: () => ({diagnostics: [], sheets: [
                                {id: "horizon-sheet", center: center.toArray(), apparentCenter, size: [200, 200],
                                    temperatureK: 500, temperaturePolicy: "isothermal", opticalDepth: 20, mask}]})}});
                        const image = pipeline.readStage("radiance").image;
                        const expected = Float32Array.from(reference, (value, i) => value > 0 ? value : source * (1 - Math.exp(-20)));
                        record(`Refracted cloud/sea depth, refraction ${enabled}, fallback ${fallback}: relative photon error`,
                            0, maxError(image, expected) / source, 5e-5);
                    }
                } finally {mask.dispose(); pipeline.forceCloudShaderComposite = false;}
            }
        });
        await test("Statistical rough sea patch against directional CPU transfer", () => {
            const view = new OrthographicCamera(-1, 1, 1, -1, .1, 300000);
            const configured = {...settings, skySource: "atmosphere", skyGradient: true, atmosphereEnabled: true,
                seaMode: "statistical", seaWindMps: 5, seaSkinTemperatureK: 293, sensorAltitudeM: 1382, pathElevationDeg: -30};
            pipeline.render({scene: new Scene(), camera: view, target, settings: configured});
            const reference = createStatisticalSea(normalizeSettings(configured), pipeline.atmosphere);
            const azimuthRad = seaRayAzimuth([0, 0, -1], pipeline.skyView.up, pipeline.seaWind);
            const expected = reference.evaluate({sensorAltitudeM: 1382, elevationRad: -Math.PI / 6, azimuthRad}).photonRadiance;
            const image = pipeline.readStage("radiance").image;
            record("Statistical sea patch: maximum relative photon error", 0,
                maxError(image, new Float32Array(image.length).fill(expected / PHOTON_SCALE)) / (expected / PHOTON_SCALE), 1e-5);
            record("Statistical sea patch: reported brightness error K", apparentTemperature(expected, {quantity: "photon"}),
                pipeline.lastFrame.backgroundTemperatureK, 1e-9);
        });
        await test("Surface through non-vacuum range table", () => {
            const view = new OrthographicCamera(-16, 16, 16, -16, .1, 300000);
            const scene = new Scene(), surface = mesh(new PlaneGeometry(32, 32), 730);
            scene.add(surface); view.updateMatrixWorld(true);
            for (const node of [100, 100.5]) {
                const rangeM = 200000 * (node / 127) ** 2;
                surface.position.z = -rangeM;
                const configured = {...settings, atmosphereEnabled: true, skySource: "atmosphere",
                    pathElevationDeg: 2.23, sensorAltitudeM: 1382, atmosphereMaxRangeM: 200000};
                pipeline.render({scene, camera: view, target, settings: configured});
                const source = blackbodyBands(730, {quantity: "photon"});
                const path = evaluatePhotonPath({sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180,
                    slantRangeM: rangeM}, pipeline.atmosphere, {segments: 96});
                const expected = sum(source.map((v, i) => v * path.transmission[i] + path.pathRadiance[i])) / PHOTON_SCALE;
                const image = pipeline.readStage("radiance").image;
                record(`Non-vacuum surface at LUT coordinate ${node}: relative photon error`, 0,
                    maxError(image, new Float32Array(image.length).fill(expected)) / expected, .001);
            }
        });
        await test("Sky gradient remains continuous at optical boundaries", () => {
            const reference = skyGradientReference();
            const configured = {...reference.settings, opticsEnabled: true, opticsRadiusPx: 8,
                scatterPreset: "clean", jitterRmsUrad: 2.714, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 40, diffusionSigmaPx: .2};
            const view = new PerspectiveCamera(configured.verticalFovDeg, 32 / 24, 1, 300000);
            pipeline.render({scene: new Scene(), camera: view, settings: configured, target});
            const before = pipeline.readStage("radiance"), after = pipeline.readStage("optics");
            record("Sky-only optics preserve all edges and corners, scaled photon units", 0,
                maxError(before.image, after.image), 1e-6);
            record("Sky-only far-scatter contrast is zero", 0,
                maxError(pipeline.readStage("farScatter").image, new Float32Array(before.image.length)), 1e-7);
        });
        await test("Unequal-population processing and gain frame sequence", () => {
            const counts = processingModesReference(), scene = new Scene();
            const factor = electronsPerRadiance(settings);
            for (let column = 0; column < 32; column++) {
                const radiance = counts[column] / 16383 * settings.wellElectrons / factor;
                const strip = mesh(new PlaneGeometry(1, 32), apparentTemperature(radiance * PHOTON_SCALE));
                strip.position.x = column - 15.5; scene.add(strip);
            }
            const results = {};
            for (const gainMode of ["manual", "automatic", "plateau"]) {
                const configured = {...settings, gainMode, plateauFactor: 100, agcTimeConstantS: 0};
                render(scene, configured, 30);
                const raw = pipeline.readDetectorCounts();
                results[gainMode] = processCounts(raw, 32, 32, configured).codes;
                record(`${gainMode} unequal-population GPU/CPU display error`, 0,
                    maxError(pipeline.readStage("display").image, results[gainMode]), 1);
            }
            record("Plateau differs from automatic by at least 100 display codes", 1,
                Number(maxError(results.plateau, results.automatic) >= 100), 0);
            record("Automatic differs from manual by at least 50 display codes", 1,
                Number(maxError(results.automatic, results.manual) >= 50), 0);
            const configured = {...settings, gainMode: "automatic", agcTimeConstantS: 1};
            let previous = null, previousFrame = null;
            for (const frame of [40, 41, 41, 39]) {
                scene.children.forEach(object => { object.userData.thermal.temperatureK += 1; });
                render(scene, configured, frame);
                const reset = previousFrame === null || frame <= previousFrame;
                const expected = processingParameters(pipeline.readDetectorCounts(), configured,
                    reset ? null : previous, reset ? 0 : (frame - previousFrame) / configured.frameRateHz).window;
                record(`Automatic gain frame ${frame}: low endpoint error, counts`, expected.low, pipeline.window.low, .002);
                record(`Automatic gain frame ${frame}: high endpoint error, counts`, expected.high, pipeline.window.high, .002);
                previous = expected; previousFrame = frame;
            }
        });
        await test("Fenced gain uses exactly the previous render, with CPU parity", async () => {
            const scene = new Scene();
            for (let column = 0; column < 32; column++) {
                const strip = mesh(new PlaneGeometry(1, 32), 280 + column);
                strip.position.x = column - 15.5; scene.add(strip);
            }
            pipeline.analysis = false;
            const originalRead = pipeline._read;
            try {
                for (const gainMode of ["automatic", "plateau"]) {
                    const configured = normalizeSettings({...settings, gainMode, agcTimeConstantS: .12, plateauFactor: 4});
                    const deadline = performance.now()+300000;
                    while (render(scene, configured, 0) === false) {
                        if (performance.now() > deadline) throw new Error("Optical initialization timed out");
                        await new Promise(resolve => setTimeout(resolve,16));
                    }
                    let previousCodes, previousWindow;
                    for (let frame = 0; frame < 4; frame++) {
                        scene.children.forEach(object => {object.userData.thermal.temperatureK += .3;});
                        pipeline._read = () => {throw new Error("Interactive render performed a synchronous readback");};
                        try {render(scene, configured, frame);} finally {pipeline._read = originalRead;}
                        // Diagnostic reads are outside render and also let this test
                        // compare the completed GPU image against an independent CPU.
                        const current = pipeline.readFilteredCounts();
                        if (previousCodes) {
                            const expected = processingParameters(previousCodes, configured, previousWindow,
                                1 / configured.frameRateHz, 32, 32);
                            record(`${gainMode} fenced gain frame ${frame}: one-render latency`, 1, pipeline.lastFrame.gain.latencyFrames, 0);
                            record(`${gainMode} fenced gain frame ${frame}: low endpoint`, expected.window.low, pipeline.window.low, .002);
                            record(`${gainMode} fenced gain frame ${frame}: high endpoint`, expected.window.high, pipeline.window.high, .002);
                            let drive = windowImage(current, expected.window);
                            if (expected.lut && !expected.lut.constant) drive = Float32Array.from(current,
                                value => expected.lut.values[Math.round(Math.min(16383, Math.max(0, value)))]);
                            const codes = displayCodes(localEnhancement(drive, 32, 32, configured.localAmount, configured.localRadiusPx), configured);
                            record(`${gainMode} fenced GPU/CPU display error at frame ${frame}`, 0,
                                maxError(pipeline.readStage("display").image, codes), 1);
                            previousWindow = expected.window;
                        }
                        previousCodes = current;
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            } finally {pipeline.analysis = true; pipeline._read = originalRead;}
        });
        await test("Rectangular detector with dark current, pedestal and low counts", () => {
            const view = new OrthographicCamera(-20, 20, 12, -12, .1, 100);
            view.position.z = 10;
            const scene = new Scene(), surface = mesh(new PlaneGeometry(40, 24), 300); scene.add(surface);
            for (const lowCounts of [false, true]) {
                const configured = {...settings, detectorWidth: 40, detectorHeight: 24,
                    darkElectronsPerS: lowCounts ? 0 : 100000, shadingK: lowCounts ? 0 : .3,
                    adcOffsetCounts: 256, noiseEnabled: true, readNoiseElectrons: lowCounts ? 0 : 500,
                    wellElectrons: lowCounts ? 16383 : settings.wellElectrons};
                // 16 expected photoelectrons executes the exact Poisson branch.
                surface.userData.thermal.temperatureK = lowCounts ? apparentTemperature(16 / electronsPerRadiance(configured) * PHOTON_SCALE) : 300;
                pipeline.render({scene, camera: view, settings: configured, target, frame: 19});
                const actual = pipeline.readDetectorCounts();
                const expected = detectorCounts(pipeline.readStage("sampled").image, pipeline.settings, 19);
                record(`Rectangular ${lowCounts ? "16-electron Poisson" : "dark/shading"} GPU/CPU maximum count error`,
                    0, maxError(actual, expected), 2);
                record(`Rectangular ${lowCounts ? "Poisson" : "dark"} GPU/CPU mean absolute count error`,
                    0, sum(actual.map((v, i) => Math.abs(v - expected[i]))) / actual.length, .1);
            }
        });
        const ramp = new Scene();
        await test("Measured display LUT and recording polarity affine", () => {
            const reference = measuredDisplayReference();
            const rampSize = 4096; // calculated 1/4095 drive spacing; 1024x4 texture
            const drive = Float32Array.from({length: rampSize}, (_, i) => i / (rampSize - 1));
            const texture = values => {
                const rgba = new Float32Array(values.length * 4);
                values.forEach((value, i) => {rgba[4 * i] = value; rgba[4 * i + 3] = 1;});
                const t = new DataTexture(rgba, values.length === rampSize ? 1024 : values.length,
                    values.length === rampSize ? 4 : 1, RGBAFormat, FloatType);
                t.minFilter = t.magFilter = NearestFilter; t.colorSpace = NoColorSpace; t.needsUpdate = true;
                return t;
            };
            const input = texture(drive), lut = texture(displayCurveLUT(reference.settings)), probes = texture(reference.drive);
            try {
                const output = pipeline._target("curveTest", 1024, 4);
                const uniforms = {tInput: input, tMean: input, tDisplayCurve: lut, useDisplayCurve: true,
                    responseGamma: 1, localAmount: 0, blackHot: false, polarityAffine: [1, 0]};
                // Same production response function, read before integer rounding.
                const responseFragment = displayFragment.replace("polarity(quantize8Bit(responseCurve(drive)))", "responseCurve(drive)");
                pipeline._pass("curveResponseTest", responseFragment, uniforms, output);
                const response = pipeline._read(output);
                record("Measured curve GPU/CPU normalized response error", 0,
                    maxError(response, displayCurve(drive, reference.settings)), 1e-6);
                record("Measured curve GPU monotonicity", 1,
                    Number(response.every((v, i) => i === 0 || v >= response[i - 1])), 0);
                record("Measured curve cold endpoint", 0, response[0], 0);
                record("Measured curve warm endpoint", 1, response[response.length - 1], 0);
                const probeOutput = pipeline._target("curveSlopeTest", reference.drive.length, 1);
                pipeline._pass("curveResponseTest", responseFragment, {...uniforms, tInput: probes, tMean: probes}, probeOutput);
                const values = pipeline._read(probeOutput);
                const slopes = reference.probes.map((_, i) => (values[2 * i + 1] - values[2 * i]) * 255 / (2 * reference.epsilon));
                record("Measured curve slope at black-hot code 166, codes/drive", 131, slopes[1], 3);
                record("Measured curve slope ratio 58/166", 5.2, slopes[0] / slopes[1], .12);
                record("Measured curve slope ratio 234/166", 3.2, slopes[2] / slopes[1], .10);
                for (const displayCurve of ["linear", "measured"]) {
                    const images = {};
                    for (const polarity of ["whiteHot", "blackHot"]) {
                        const configured = {...reference.settings, displayCurve, polarity};
                        pipeline._pass("curveCodesTest", displayFragment, {...uniforms,
                            useDisplayCurve: displayCurve === "measured", blackHot: polarity === "blackHot"}, output);
                        images[polarity] = pipeline._read(output);
                        record(`${displayCurve} ${polarity} GPU/CPU code error`, 0,
                            maxError(images[polarity], displayCodes(drive, configured)), 1);
                    }
                    record(`${displayCurve} GPU exact default polarity inverse`, 0,
                        maxError(images.whiteHot.map((v, i) => v + images.blackHot[i]), new Float32Array(rampSize).fill(255)), 0);
                    const affine = POLARITY_PROFILES.IB6830.polarityAffine;
                    pipeline._pass("curveCodesTest", displayFragment, {...uniforms, useDisplayCurve: displayCurve === "measured",
                        polarityAffine: [affine.gain, affine.offset]}, output);
                    record(`${displayCurve} recording affine GPU/CPU code error`, 0, maxError(pipeline._read(output),
                        displayCodes(drive, {...reference.settings, displayCurve, polarity: "whiteHot", polarityAffine: affine})), 1);
                }
            } finally {input.dispose(); lut.dispose(); probes.dispose();}
        });
        await test("Two-axis residual blur before native sampling", () => {
            const widths = [];
            point.position.set(.13, .21, 0);
            for (const focalLengthM of [.675, 1.012]) {
                const configured = {...normalizeSettings(settings), focalLengthM, supersample: 4,
                    systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 40};
                render(pointScene, configured);
                const before = pipeline.readStage("radiance"), after = pipeline.readStage("optics");
                const expected = applyOptics(before.image, before.width, before.height, opticalKernels(pipeline.settings));
                const flux = sum(before.image);
                record(`${focalLengthM} m anisotropic GPU/CPU optical flux-relative error`, 0,
                    sum(after.image.map((v, i) => Math.abs(v - expected[i]))) / flux, .001);
                record(`${focalLengthM} m anisotropic energy ratio`, 1, sum(after.image) / flux, .002);
                const initial = imageAxisVariances(before.image, before.width), final = imageAxisVariances(after.image, after.width);
                const rms = final.map((v, i) => Math.sqrt(Math.max(0, v - initial[i])) / configured.supersample);
                for (const axis of [0, 1]) record(`${focalLengthM} m residual ${axis ? "vertical" : "horizontal"} RMS, urad`,
                    axis ? 40 : 0, rms[axis] * configured.pixelPitchM / focalLengthM * 1e6, .15);
                widths.push(rms[1]);
                record(`${focalLengthM} m anisotropic GPU/CPU native sample error`, 0,
                    maxError(pipeline.readStage("sampled").image,
                        sampleDetector(expected, before.width, before.height, configured.supersample, configured.fillFactor)) / flux, 1e-5);
            }
            record("Angle-fixed vertical blur native-pixel lens-step ratio", 1.012 / .675, widths[1] / widths[0], .005);
        });
        await test("14-bit ramp, processing and exact polarity", () => {
            const factor = electronsPerRadiance(settings);
            for (let column = 0; column < 32; column++) {
                const radiance = settings.wellElectrons / factor * column / 31;
                const temperatureK = apparentTemperature(radiance * PHOTON_SCALE);
                const strip = mesh(new PlaneGeometry(1, 32), temperatureK);
                strip.position.x = column - 15.5;
                ramp.add(strip);
            }
            render(ramp);
            const counts = pipeline.readDetectorCounts();
            const expected = Float32Array.from({length: counts.length}, (_, pixel) => Math.round((pixel % 32) / 31 * 16383));
            record("Ramp 14-bit endpoint minimum", 0, Math.min(...counts), 0);
            record("Ramp 14-bit endpoint maximum", 16383, Math.max(...counts), 0);
            record("Ramp 14-bit maximum code error", 0, maxError(counts, expected), 1);
            for (const gainMode of ["manual", "automatic", "plateau", "fixedRadiometric"]) {
                const processing = {...settings, gainMode, localAmount: 0.4, localRadiusPx: 1.2,
                    responseGamma: 1.7, agcTimeConstantS: 0};
                render(ramp, processing, 1);
                // Compare with the normalized settings the GPU used: defaults such as the fixed
                // radiometric endpoints follow the exposure, so raw inputs are not the reference.
                const reference = processCounts(pipeline.readDetectorCounts(), 32, 32, pipeline.settings);
                const white = pipeline.readStage("display").image;
                record(`${gainMode}: GPU/CPU 8-bit display code error`, 0, maxError(white, reference.codes), 1);
                render(ramp, {...processing, polarity: "blackHot"}, 1);
                const black = pipeline.readStage("display").image;
                record(`${gainMode}: exact white-hot plus black-hot codes`, 0,
                    maxError(Float32Array.from(white, (value, pixel) => value + black[pixel]), new Float32Array(white.length).fill(255)), 0);
            }
        });
        await test("Fixed radiometric mapping across different scenes", () => {
            const fixed = {gainMode: "fixedRadiometric", radiometricLow: 0, radiometricHigh: 2};
            render(uniform, fixed);
            const first = pipeline.readStage("display").image[16 * 32 + 8];
            const hot = mesh(new PlaneGeometry(8, 32), 700);
            hot.position.set(10, 0, 1); uniform.add(hot);
            render(uniform, fixed);
            const second = pipeline.readStage("display").image[16 * 32 + 8];
            const expected = processCounts(detectorCounts(new Float32Array([inBandRadiance(300).photon / PHOTON_SCALE]),
                {...settings, ...fixed}), 1, 1, {...settings, ...fixed}).codes[0];
            record("Fixed radiometric reference patch, scene one, 8-bit code", expected, first, 0);
            record("Fixed radiometric same patch after adding hot surface, 8-bit code", first, second, 0);
            uniform.remove(hot);
        });
        await test("Local enhancement ring around a clipped source", () => {
            const ringScene = new Scene();
            const background = mesh(new PlaneGeometry(32, 32), 300);
            const source = mesh(new CircleGeometry(1.2, 96), 1000);
            source.position.set(0.5, 0.5, 1);
            ringScene.add(background, source);
            const enhanced = {...settings, localAmount: 1.5, localRadiusPx: 2};
            render(ringScene, enhanced);
            const counts = pipeline.readDetectorCounts();
            const reference = processCounts(counts, 32, 32, enhanced);
            const image = pipeline.readStage("display").image;
            record("Local enhancement GPU/CPU maximum 8-bit error", 0, maxError(image, reference.codes), 1);
            const ringPixel = 16 * 32 + 19;
            const plain = processCounts(counts, 32, 32, settings).codes;
            record("Hot source ring is darker than its white-hot background", 1, Number(image[ringPixel] < plain[ringPixel]), 0);
        });
        await test("Frame-seeded detector noise", () => {
            render(uniform, {noiseEnabled: true}, 19);
            const first = pipeline.readDetectorCounts();
            const expected = detectorCounts(pipeline.readStage("sampled").image, {...settings, noiseEnabled: true}, 19);
            record("Seeded CPU/GPU noise maximum difference, counts", 0, maxError(first, expected), 2);
            render(uniform, {noiseEnabled: true}, 19);
            record("Repeated frame noise must be identical, counts", 0, maxError(first, pipeline.readDetectorCounts()), 0);
        });
        await test("Reference well-fill exposure", () => {
            const exposure = {...settings, exposureMode: "wellFill", wellFillFraction: 0.5, wellFillReferenceK: 300};
            render(uniform, exposure);
            record("Reported reference integration time, seconds", integrationTime(exposure), pipeline.lastFrame.integrationTimeS, 1e-12);
            record("300 K reference fraction of ADC range after zero dark subtraction", 0.5,
                sum(pipeline.readDetectorCounts()) / (32 * 32 * 16383), 1 / 16383);
        });
        await test("Detector-fixed shading and digital crop", () => {
            const shaded = {...settings, exposureMode: "wellFill", shadingK: 0.3, shadingWidth: 0.9,
                diagnosticView: "detectorCounts", sampling: "nearest"};
            render(uniform, shaded, 20);
            const reference = detectorCounts(pipeline.readStage("sampled").image, shaded, 20);
            const first = pipeline.readDetectorCounts();
            record("Shading GPU/CPU maximum error, ADC counts", 0, maxError(first, reference), 1);
            record("Shading edges warmer than center", 1, Number(first[16 * 32] > first[16 * 32 + 16]), 0);
            render(uniform, {...shaded, digitalZoom: 2}, 21);
            record("Native shading unchanged across frames and digital zoom, counts", 0,
                maxError(first, pipeline.readDetectorCounts()), 0);
            const expected = Float32Array.from(first, (_, pixel) => {
                const x = Math.floor(((pixel % 32 + 0.5) / 32 - 0.5) / 2 * 32 + 16);
                const y = Math.floor(((Math.floor(pixel / 32) + 0.5) / 32 - 0.5) / 2 * 32 + 16);
                return first[y * 32 + x] / 16383;
            });
            record("Digital zoom crops detector shading, normalized output", 0, maxError(pipeline._read(target), expected), 1e-6);
        });
        await test("Residual fixed pattern is frame independent", () => {
            const fixed = {...settings, fixedPatternFraction: 0.0002};
            render(uniform, fixed, 22);
            const first = pipeline.readDetectorCounts();
            const reference = detectorCounts(pipeline.readStage("sampled").image, fixed, 22);
            record("Fixed pattern GPU/CPU maximum error, ADC counts", 0, maxError(first, reference), 1);
            render(uniform, fixed, 23);
            record("Fixed pattern identical between distinct frames, ADC counts", 0, maxError(first, pipeline.readDetectorCounts()), 0);
            record("Fixed pattern has nonzero spatial variation", 1, Number(new Set(first).size > 5), 0);
        });
        for (const preset of ["clean", "dirty"]) await test(`${preset} far-skirt energy and profile`, () => {
            // Normalize through render so the selected preset supplies all four values.
            render(pointScene, {...SCATTER_PRESETS[preset], scatterPreset: preset, atmosphereEnabled: true,
                skySource: "atmosphere", skyGradient: false, sensorAltitudeM: 1382, pathElevationDeg: 2.23}, 24);
            const optical = pipeline.settings, before = pipeline.readStage("radiance");
            const kernels = opticalKernels(optical, before.width, before.height);
            const coarse = pipeline._read(pipeline.farResult);
            const background = pipeline.background.scaledPhotonRadiance;
            const contrast = before.image.map(v => v - background);
            const expectedFlux = sum(contrast) * kernels.farMass;
            record(`${preset} full padded far-skirt flux / expected flux`, 1,
                sum(coarse) * kernels.split.factor ** 2 / expectedFlux, 0.005);
            const farReference = applyFarScatter(contrast, before.width, before.height, kernels);
            const far = pipeline.readStage("farScatter").image;
            record(`${preset} cropped far-skirt GPU/CPU integrated absolute error / full far flux`, 0,
                sum(Float32Array.from(far, (value, pixel) => Math.abs(value - farReference[pixel]))) / expectedFlux, 0.005);
            const opticalReference = applyOptics(before.image, before.width, before.height, kernels, background);
            record(`${preset} nonzero sky plus scatter GPU/CPU error / source contrast flux`, 0,
                sum(pipeline.readStage("optics").image.map((v, i) => Math.abs(v - opticalReference[i]))) / sum(contrast), .001);
            record(`${preset} near plus far kernel energy`, 1, sum(kernels.scatter.data) + sum(kernels.farScatter.data), 1e-7);
            record(`${preset} fine FFT side within 4096`, 1,
                Number(Math.max(pipeline.fftWidth, pipeline.fftHeight) <= 4096), 0);
        });
        await test("Packed overlap-add optics against the single-FFT reference and CPU", () => {
            // Forced 2 × 2 tiles at this small size. Sources at the tile corner (image centre) and near the image
            // corners, where the tile convolutions overlap and the padding must absorb the wrap.
            const packed = new ThermalPipeline(renderer, {analysis: true, packedOptics: {tiles: [2, 2]}});
            const sources = new Scene();
            for (const [x, y] of [[0.13, 0.21], [-15.4, -15.2], [15.1, 14.7], [-15.3, 9.8]]) {
                const source = mesh(new CircleGeometry(0.125, 192), 800); source.position.set(x, y, 0); sources.add(source);
            }
            try {
                for (const [label, extra] of [["near scatter", {opticsEnabled: true, scatterFraction: 0.07,
                    scatterShoulderRad: 10e-6, scatterCutoffRad: 60e-6}],
                ["dirty preset", {...SCATTER_PRESETS.dirty, scatterPreset: "dirty", atmosphereEnabled: true,
                    skySource: "atmosphere", skyGradient: false, sensorAltitudeM: 1382, pathElevationDeg: 2.23}]]) {
                    render(sources, extra, 25);
                    packed.render({scene: sources, camera, settings: {...settings, ...extra}, target, frame: 25});
                    record(`Packed ${label}: four tiles`, 4, packed.nearPlan.packed ? packed.nearPlan.tilesX * packed.nearPlan.tilesY : 0, 0);
                    const a = pipeline.readStage("optics").image, b = packed.readStage("optics").image;
                    const before = packed.readStage("radiance"), background = packed.background.scaledPhotonRadiance;
                    // Estimated float32 FFT bound for both paths, as for the full detector below.
                    record(`Packed ${label}: packed/reference optics L2 difference / reference contrast L2`, 0,
                        Math.sqrt(sum(b.map((v, i) => (v - a[i]) ** 2)) / sum(a.map(v => (v - background) ** 2))), 1.4e-4);
                    // The single transform's own CPU bound.
                    const kernels = opticalKernels(packed.settings, before.width, before.height);
                    const cpu = applyOptics(before.image, before.width, before.height, kernels, background);
                    record(`Packed ${label}: GPU/CPU integrated absolute error / source contrast flux`, 0,
                        sum(b.map((v, i) => Math.abs(v - cpu[i]))) / sum(before.image.map(v => v - background)), .001);
                    record(`Packed ${label}: maximum detector count difference from the reference`, 0,
                        maxError(packed.readDetectorCounts(), pipeline.readDetectorCounts()), 1);
                }
            } finally {packed.dispose();}
        });
        await test("Enlargement sample alignment", () => {
            // Calculated unit impulse in a 9×9 field at 2× isolates both sampling phases.
            const input = new Float32Array(81); input[40] = 1;
            const rgba = new Float32Array(81 * 4); rgba[40 * 4] = 1;
            const texture = new DataTexture(rgba, 9, 9, RGBAFormat, FloatType);
            texture.minFilter = texture.magFilter = NearestFilter;
            texture.colorSpace = NoColorSpace; texture.needsUpdate = true;
            const enlarged = new WebGLRenderTarget(18, 18, {type: FloatType, format: RGBAFormat});
            try {
                for (const sampling of ["nearest", "linear", "sampleCentered"]) {
                    pipeline._pass("selfTestEnlarge", enlargeFragment, {tInput: texture, imageSize: [9, 9],
                        zoom: 1, fieldScale: [1, 1], fieldOffset: [0, 0], windowScale: [1, 1], outputSize: [18, 18],
                        linearSampling: sampling !== "nearest", sampleCentered: sampling === "sampleCentered",
                        outputWindow: [0, 1]}, enlarged);
                    const actual = pipeline._read(enlarged);
                    const expected = enlargeImage(input, 9, 9, 18, 18, {detectorWidth: 9, detectorHeight: 9, digitalZoom: 1, sampling});
                    record(`${sampling} enlargement GPU/CPU error, normalized`, 0, maxError(actual, expected), 1e-6);
                    if (sampling === "sampleCentered") for (const [pixel, value] of [[7, .5], [8, 1], [9, .5]])
                        record(`Sample-centered impulse at display column ${pixel}`, value, actual[9 * 18 + pixel], 1e-6);
                    if (sampling === "sampleCentered") record("Sample-centered vertical top-left alignment", .5, actual[8 * 18 + 8], 1e-6);
                }
                enlarged.setSize(4, 3);
                for (const sampling of ["nearest", "linear", "sampleCentered"]) {
                    pipeline._pass("selfTestEnlarge", enlargeFragment, {tInput: texture, imageSize: [9, 9],
                        zoom: 1, fieldScale: [1, 1], fieldOffset: [0, 0], windowScale: [1, 1], outputSize: [4, 3],
                        linearSampling: sampling !== "nearest", sampleCentered: sampling === "sampleCentered", outputWindow: [0, 1]}, enlarged);
                    const actual = pipeline._read(enlarged);
                    const expected = enlargeImage(input, 9, 9, 4, 3, {detectorWidth: 9, detectorHeight: 9, digitalZoom: 1, sampling});
                    record(`${sampling} minification GPU/CPU normalized error`, 0, maxError(actual, expected), 1e-6);
                    record(`${sampling} minification integrated impulse`, 1, sum(actual) * 81 / 12, 1e-6);
                }
                enlarged.setSize(18, 18);
                // The selected window excludes its immediate bright neighbors.
                for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++)
                    rgba[(y * 9 + x) * 4] = x < 2 || x > 6 || y < 2 || y > 6 ? 1 : 0;
                texture.needsUpdate = true;
                pipeline._pass("selfTestEnlarge", enlargeFragment, {tInput: texture, imageSize: [9, 9],
                    zoom: 1, fieldScale: [5 / 9, 5 / 9], fieldOffset: [0, 0], windowScale: [5 / 9, 5 / 9],
                    outputSize: [18, 18], linearSampling: true, sampleCentered: true, outputWindow: [0, 1]}, enlarged);
                record("Detector-window enlargement excludes outside samples", 0, Math.max(...pipeline._read(enlarged)), 1e-6);
            } finally {renderer.setRenderTarget(null); renderer.setViewport(0, 0, 32, 32); texture.dispose(); enlarged.dispose();}
        });
        await test("Temporal count recursion and frame resets", () => {
            const filtered = {...settings, temporalFilterAlpha: .30};
            let previous = null;
            try {
                for (const [frame, temperatureK] of [[50, 300], [51, 320], [54, 310], [54, 330], [49, 300]]) {
                    patch.userData.thermal.temperatureK = temperatureK;
                    render(uniform, filtered, frame);
                    previous = temporalFilter(pipeline.readDetectorCounts(), pipeline.settings, frame, previous);
                    record(`Temporal recursion frame ${frame}, ${temperatureK} K: GPU/CPU count error`, 0,
                        maxError(pipeline.readFilteredCounts(), previous.image), .002);
                    const expected = processCounts(previous.image, 32, 32, pipeline.settings).codes;
                    record(`Temporal precedes gain at frame ${frame}, ${temperatureK} K: display code error`, 0,
                        maxError(pipeline.readStage("display").image, expected), 1);
                }
                render(uniform, {...filtered, temporalFilterAlpha: 0}, 55);
                record("Disabled temporal filter preserves raw ADC counts", 0,
                    maxError(pipeline.readFilteredCounts(), pipeline.readDetectorCounts()), 0);
                // Estimated numerical fixture; pure read noise avoids shot-rate changes.
                const noisy = {...filtered, noiseEnabled: true, shotNoiseEnabled: false, readNoiseElectrons: 50000};
                let rawSquare = 0, filteredSquare = 0, rawSum = 0, filteredSum = 0, n = 0;
                for (let index = 0; index < 80; index++) {
                    render(uniform, noisy, 1000 + index);
                    if (index < 16) continue; // alpha^16 makes initialization negligible.
                    const raw = pipeline.readDetectorCounts(), smooth = pipeline.readFilteredCounts();
                    for (let pixel = 0; pixel < raw.length; pixel++) {
                        rawSquare += raw[pixel] ** 2; filteredSquare += smooth[pixel] ** 2;
                        rawSum += raw[pixel]; filteredSum += smooth[pixel]; n++;
                    }
                }
                const ratio = (filteredSquare / n - (filteredSum / n) ** 2) / (rawSquare / n - (rawSum / n) ** 2);
                record("Stationary temporal noise variance ratio (1-alpha)/(1+alpha)", .7 / 1.3, ratio, .02);
            } finally {patch.userData.thermal.temperatureK = 300;}
        });
        await test("Scene and renderer restoration after a draw failure", () => {
            const original = patch.material;
            const callback = patch.onBeforeRender;
            patch.onBeforeRender = () => { throw new Error("Intentional radiance draw failure"); };
            let propagated = false;
            try { render(uniform); } catch (error) {
                propagated = error.message.includes("Intentional radiance draw failure");
            } finally { patch.onBeforeRender = callback; }
            record("Expected radiance exception was propagated", 1, Number(propagated), 0);
            record("Original surface material restored after failure", 1, Number(patch.material === original), 0);
            record("Original target restored after failure", 1, Number(renderer.getRenderTarget() === null), 0);
        });
        await test("Packed optics at the full MX15 detector against the single-FFT reference", () => {
            // Same analysis render except the near convolution: the automatic layout, as live views use it.
            const configured = normalizeSettings({sensorPreset: "MX15", sensorAltitudeM: 1380});
            const scene = new Scene(), camera = new PerspectiveCamera(configured.verticalFovDeg,
                configured.detectorWidth / configured.detectorHeight, 1, 300000);
            // Sources near the tile corner (image centre) and near two image corners, placed by the field of view.
            const halfV = Math.tan(configured.verticalFovDeg * Math.PI / 360) * 2000;
            const halfH = halfV * configured.detectorWidth / configured.detectorHeight;
            for (const [x, y] of [[0.002, 0.003], [-0.85, -0.8], [0.9, 0.85]]) {
                const object = mesh(new PlaneGeometry(halfV / 20, halfV / 40), 600);
                object.position.set(x * halfH, y * halfV, -2000); scene.add(object);
            }
            const reference = new ThermalPipeline(renderer, {analysis: true});
            const packed = new ThermalPipeline(renderer, {analysis: true, packedOptics: true});
            try {
                const inputs = {scene, camera, settings: configured, psfRangeM: 2000, frame: 3, target};
                reference.render(inputs); packed.render(inputs);
                record("Full detector: packed layout is four tiles of a 2048² transform", 1,
                    Number(packed.nearPlan.packed && packed.fftWidth === 2048 && packed.fftHeight === 2048 &&
                        packed.nearPlan.tilesX * packed.nearPlan.tilesY === 4), 0);
                record("Full detector: reference layout is unchanged", 1, Number(!reference.nearPlan.packed), 0);
                const a = reference.readStage("optics").image, b = packed.readStage("optics").image;
                const background = reference.background.scaledPhotonRadiance;
                // Estimated float32 FFT bound for both paths: (2 × 24 + 1) stages × (4√2 × 2⁻²⁴ + 1e-6 twiddle error) ≈ 7e-5.
                record("Full detector: packed/reference optics L2 difference / reference contrast L2", 0,
                    Math.sqrt(sum(b.map((v, i) => (v - a[i]) ** 2)) / sum(a.map(v => (v - background) ** 2))), 1.4e-4);
                record("Full detector: packed/reference maximum detector count difference", 0,
                    maxError(packed.readDetectorCounts(), reference.readDetectorCounts()), 1);
            } finally {reference.dispose(); packed.dispose();}
        });
        await test("Moving-camera CPU and GPU timing", async () => {
            pipeline.dispose(); // Release reference targets before the full detector benchmark.
            // Estimated transverse tracks at both requested speeds and ranges.
            // Full native sampling and retained optical support are preserved.
            for (const speedMps of [250, 822]) for (const initialRangeM of [2000, 125000]) {
                const scene = new Scene(), object = mesh(new PlaneGeometry(24, 8), 320);
                object.position.set(0, initialRangeM*Math.tan(2.27*Math.PI/180), -initialRangeM); scene.add(object);
                const configured = normalizeSettings({sensorPreset: "MX15", sensorAltitudeM: 1380});
                const moving = new PerspectiveCamera(configured.verticalFovDeg,
                    configured.detectorWidth/configured.detectorHeight, 1, 300000);
                // This benchmark explicitly exercises the live scheduler. All
                // reference/capture tests retain synchronous preparation.
                const measured = new ThermalPipeline(renderer, {analysis: false, gpuTiming: true});
                const cpu = [], preparation = [], wall = [], stageCpu = {}, fftSizes = new Set();
                let missed = 0, pendingFrames = 0, maxKernelError = 0, previousStart, initializationMs = 0, previousRangeWork;
                try {
                    for (let frame = 0; frame < 300; frame++) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        // A live pipeline starts a frame only after the previous one has completed on the GPU (GPU
                        // pacing); a draw before that shows the last image. Every benchmark frame is a full render.
                        while (measured._gpuBusy()) await new Promise(resolve => requestAnimationFrame(resolve));
                        const start = performance.now();
                        if (previousStart !== undefined) wall.push(start-previousStart);
                        previousStart = start;
                        moving.position.x = speedMps*frame/30; moving.lookAt(object.position); moving.updateMatrixWorld(true);
                        const m = moving.matrixWorldInverse.elements, rangeM = moving.position.distanceTo(object.position);
                        const elevationRad = Math.atan2(object.position.y, Math.hypot(moving.position.x, initialRangeM));
                        const settings = {...configured, turbulenceR0M: integrateTurbulence({sensorAltitudeM: configured.sensorAltitudeM,
                            slantRangeM: rangeM, elevationRad}).r0ReferenceM};
                        const inputs = {scene, camera: moving, settings, skyUp: [m[4], m[5], m[6]], psfRangeM: rangeM, frame, target, pace: true};
                        let ready = measured.render(inputs);
                        if (!frame) {
                            const initStart = performance.now();
                            record(`${speedMps} m/s at ${initialRangeM} m: startup produces output`, 1, Number(measured.hasFrame), 0);
                            while ((ready === false || measured.opticsReport.workerPending || measured.rangeCache.pending) && performance.now()-initStart < 300000) {
                                await new Promise(resolve => setTimeout(resolve, 16)); ready = measured.render(inputs);
                            }
                            if (measured.opticsReport.workerPending || measured.rangeCache.pending) throw new Error("Thermal preparation timed out");
                            initializationMs = performance.now()-initStart; previousStart = undefined;
                        }
                        if (ready === false) {pendingFrames++; continue;}
                        const timing = measured.lastFrame.timing;
                        cpu.push(timing.cpuMs); missed += Number(measured.lastFrame.gain.missedDeadline ?? false);
                        const rangeWork = measured.rangeCache.workMs ?? 0;
                        preparation.push(["atmosphere", "prepareOptics", "skyTable"].reduce((sum,key) => sum+(timing.stages[key] ?? 0),0) +
                            rangeWork-(previousRangeWork ?? rangeWork));
                        previousRangeWork = rangeWork;
                        maxKernelError = Math.max(maxKernelError, measured.lastFrame.opticsCache.errorL1 ?? 0);
                        for (const [name, ms] of Object.entries(timing.stages)) (stageCpu[name] ??= []).push(ms);
                        fftSizes.add(`${measured.fftWidth}x${measured.fftHeight}`);
                    }
                    const deadline = performance.now()+5000;
                    while (measured.gpuTimer.pending.length && performance.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve,10)); measured.gpuTimer.poll();
                    }
                    const gpu = {};
                    for (const sample of measured.gpuTimer.samples) (gpu[sample.stage] ??= []).push(sample.ms);
                    const prefix = `${speedMps} m/s at ${initialRangeM} m`;
                    performanceReport.movingCamera.push({tier: "interactive", speedMps, initialRangeM,
                        frames: cpu.length, pendingFrames, initializationMs, maxKernelError,
                        worker: {firstKernelMs: measured.opticsScheduler.firstKernelMs,
                            domainBuildMs: measured.opticsScheduler.buildMs},
                        cpu: timingDistribution(cpu), preparation: timingDistribution(preparation),
                        wallCadence: timingDistribution(wall),
                        stageCpu: Object.fromEntries(Object.entries(stageCpu).map(([name,samples]) => [name,timingDistribution(samples)])),
                        gpuAvailable: !!measured.gpuTimer.extension,
                        gpuStages: Object.fromEntries(Object.entries(gpu).map(([name,samples]) => [name,{...timingDistribution(samples),samples:samples.length}])),
                        disjointSamples: measured.gpuTimer.disjointSamples, pendingQueries: measured.gpuTimer.pending.length,
                        cooperativeRangeWork: {cpuMs: measured.rangeCache.workMs, maxSliceMs: measured.rangeCache.maxSliceMs},
                        missedGainDeadlines: missed, fftSizes: [...fftSizes], targetBytes: measured.lastFrame?.timing.targetBytes});
                    record(`${prefix}: completed moving frames`, 300, cpu.length, 0);
                    record(`${prefix}: optical error bound`, 1, Number(maxKernelError <= 1e-4), 0);
                    // The timing gates measure the live worker path. A host with no worker (an evaluated bundle,
                    // Node) builds each interpolation domain in the main thread, which blocks that frame by design;
                    // its timings are still in the report above, but they are not gated.
                    if (!measured.opticsScheduler.workerUnavailable) {
                        record(`${prefix}: median CPU preparation at most 33 ms`, 1, Number(timingDistribution(preparation).medianMs <= 33), 0);
                        record(`${prefix}: maximum CPU preparation at most 50 ms`, 1, Number(timingDistribution(preparation).maxMs <= 50), 0);
                    } else record(`${prefix}: timing gates need a worker; this host has none (timings reported, not gated)`, 1, 1, 0);
                    record(`${prefix}: gain meets one-render deadline`, 0, missed, 0);
                    if (measured.gpuTimer.extension && !measured.gpuTimer.disjointSamples)
                        for (const stage of ["radiance", "sky", "optics", "sample", "detector", "temporal", "processing", "display", "output"])
                            record(`${prefix}: GPU timing includes ${stage}`, 1, Number((gpu[stage]?.length ?? 0)>0), 0);
                } finally {measured.dispose(); object.geometry.dispose(); object.material.dispose();}
            }
            performanceReport.status = "measured; CPU submission and GPU stage execution reported separately";
        });
    } catch (error) {
        checks.push({name: "WebGL setup or float-target requirement", expected: "WebGL 2 and EXT_color_buffer_float",
            measured: error.message, tolerance: 0, pass: false});
    } finally {
        pipeline?.dispose(); target?.dispose();
        for (const geometry of geometries) geometry.dispose();
        for (const paint of materials) paint.dispose();
        renderer?.dispose(); renderer?.forceContextLoss();
    }
    return {pass: checks.length > 0 && checks.every(check => check.pass), checks, performance: performanceReport};
}
