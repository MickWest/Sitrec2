// The foreground range table: photon scale, band pairing, and the sea-limited range.
import {BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import * as A from "../tools/thermal/atmosphere.js";
import * as M from "../tools/thermal/sensorMath.js";
import {PHOTON_SCALE} from "../tools/thermal/radiometry.js";

const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
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

test("non-vacuum range samples preserve photon scale and distinct band pairing", () => {
    const atmosphere = A.createAtmosphere(), band = {minUm: 3.2, maxUm: 4.9};
    const geometry = {sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180};
    const table = A.createRangeLUT({...geometry, maxRangeM: 160000, size: 128, band, atmosphere});
    const source = A.blackbodyBands(730, {quantity: "photon", band}).map((v, i) => v * (i + 1));
    const values = A.sourceRangeLUT(table, source);
    for (const node of [3, 21, 73, 100, 127]) for (const offset of [0, ...(node < 127 ? [.5] : [])]) {
        const position = node + offset, range = table.maxRangeM * (position / (table.size - 1)) ** 2;
        const path = A.evaluatePhotonPath({...geometry, slantRangeM: range}, atmosphere, {band, segments: 96});
        const expected = M.sum(source.map((v, i) => v * path.transmission[i] + path.pathRadiance[i])) / PHOTON_SCALE;
        const actual = offset ? (values[node] + values[node + 1]) / 2 : values[node];
        close(actual / expected, 1, offset ? 1e-3 : 2e-7);
        if (!offset) path.pathRadiance.forEach((v, i) => close(table.pathRadiance[node * 12 + i], v / PHOTON_SCALE, 2e-9));
    }
});

test.each([[20, -.3, 15000], [1382, -1.3, 125000], [0, -.05, 5000]])(
    "sea-limited range rejects farther geometry at altitude %s m", (altitude, elevation, distance) => {
        const pipeline = cpuPipeline(), settings = sensorSettings({sensorAltitudeM: altitude, pathElevationDeg: elevation});
        pipeline._prepareAtmosphere(settings);
        expect(pipeline.rangeLUT.maxRangeM).toBeLessThan(distance);
        const camera = new PerspectiveCamera(1, 1, 1, 1e6);
        camera.updateMatrixWorld();
        const mesh = new Mesh(new BoxGeometry(10, 10, 10), new MeshBasicMaterial());
        mesh.position.z = -distance; mesh.updateMatrixWorld();
        expect(() => [...pipeline._coverageTiles([mesh], camera, settings)]).toThrow(/range|Range/);
        mesh.geometry.dispose(); mesh.material.dispose();
    });
