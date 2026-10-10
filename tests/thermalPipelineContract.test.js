// The pipeline's CPU-side contract: excluded line meshes, logarithmic depth, render-target formats and the
// resident render-target budget.
import {BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, RGFormat, RedFormat} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {radianceVertex, radianceFragment} from "../tools/thermal/shaders.js";

// A quiet 32 × 24 detector at a manual 4× sampling, with a linear display: chain fixtures.
const sensorSettings = extra => normalizeSettings({detectorWidth: 32, detectorHeight: 24,
    fieldMode: "focalLength", opticalSamplingMode: "manual", supersample: 4,
    opticsRadiusPx: 8, scatterPreset: "custom", scatterFraction: 0,
    turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
    displayCurve: "linear", shadingK: 0, fixedPatternFraction: 0, noiseEnabled: false, ...extra});
const cpuPipeline = () => {
    const pipeline = new ThermalPipeline({capabilities: {maxTextureSize: 8192}}, {analysis: true});
    pipeline.resources = {surfaces: new Map(), textures: new Set(), targets: new Map()};
    return pipeline;
};

test.each(["isLine2", "isLineSegments2", "isWireframe"])("generic radiance excludes %s meshes and restores them", flag => {
    const pipeline = cpuPipeline(), settings = sensorSettings(), scene = new Scene(), camera = new PerspectiveCamera();
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); mesh[flag] = true; scene.add(mesh);
    const paint = mesh.material;
    pipeline._drawRadiance = () => expect(mesh.visible).toBe(false);
    pipeline._surface = () => { throw new Error("line became a surface"); };
    pipeline._coverageTiles = meshes => { expect(meshes).toHaveLength(0); return []; };
    pipeline._radiance(scene, camera, settings, {width: 1, height: 1, viewport: {set() {}}}, 0);
    expect(mesh.visible).toBe(true); expect(mesh.material).toBe(paint);
    mesh.geometry.dispose(); paint.dispose();
});

test("radiance shaders retain all logarithmic depth chunks", () => {
    for (const chunk of ["logdepthbuf_pars_vertex", "logdepthbuf_vertex"]) expect(radianceVertex).toContain(`#include <${chunk}>`);
    for (const chunk of ["logdepthbuf_pars_fragment", "logdepthbuf_fragment"]) expect(radianceFragment).toContain(`#include <${chunk}>`);
});

test("scalar and complex targets use one and two float channels", () => {
    const pipeline = cpuPipeline();
    expect(pipeline._target("radiance", 64, 48, true).texture.format).toBe(RedFormat);
    expect(pipeline._target("fineFftA", 128, 128).texture.format).toBe(RGFormat);
    expect(pipeline._target("opticalSpectrum", 128, 128).texture.format).toBe(RGFormat);
    for (const target of pipeline.resources.targets.values()) target.dispose();
});

test("MX15 render-target byte budget uses actual allocated formats and sizes", () => {
    const settings = settingsForPreset("MX15"), pipeline = cpuPipeline();
    pipeline._prepareSpectrum = (name, kernels, width, height) => {
        pipeline._target(name, width, height);
        const pool = name === "farSpectrum" ? "far" : "fine";
        pipeline._target(`${pool}FftA`, width, height); pipeline._target(`${pool}FftB`, width, height);
    };
    const w = settings.detectorWidth * settings.supersample, h = settings.detectorHeight * settings.supersample;
    pipeline._prepareOptics(settings, w, h);
    for (const name of ["radiance", "optics", "nearOptics", "farScatter", "skyBackground"]) pipeline._target(name, w, h, name === "radiance");
    for (const name of ["sampled", "counts", "drive", "display", "temporalA", "temporalB"]) pipeline._target(name, settings.detectorWidth, settings.detectorHeight);
    let rw = w, rh = h;
    for (let factor = 1; factor < pipeline.scatterSplit.factor; factor *= 2) {
        rw = Math.ceil(rw / 2); rh = Math.ceil(rh / 2); pipeline._target(`scatterReduce${factor}`, rw, rh);
    }
    pipeline._target("coverage", 512, 512, true);
    let bytes = 0;
    for (const t of pipeline.resources.targets.values()) {
        const channels = t.texture.format === RedFormat ? 1 : t.texture.format === RGFormat ? 2 : 4;
        bytes += t.width * t.height * (4 * channels + (t.depthBuffer ? 4 : 0)); t.dispose();
    }
    console.log(`MX15 resident targets: ${(bytes / 2 ** 20).toFixed(3)} MiB; routine ADC readback peak +5 MiB; fine-stage diagnostic readback +80 MiB`);
    expect(bytes / 2 ** 20).toBeLessThan(540);
});
