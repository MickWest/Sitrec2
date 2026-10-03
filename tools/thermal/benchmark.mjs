import {PerspectiveCamera} from 'three';
import {ThermalCloudPass, ThermalPipeline} from './ThermalPipeline.js';
import {timingDistribution} from './sensorMath.js';
import {createAtmosphere, createStatisticalSea, createSeaSkyTable, skyViewGeometry, EARTH_RADIUS_M} from './atmosphere.js';
import {normalizeSettings} from './thermalSchema.js';

function benchmarkCloudSea() {
// Estimated motion fixture: 300 frames at 30 Hz, camera 60 m/s at 21 m,
// cloud drift 10 m/s, 20 sheets of 200 x 100 m, 10 km initial range.
// Camera follows the sphere at constant altitude; pitch changes 1e-5 rad/frame.
// Calculated wall-clock distribution includes binding, sorting, CPU tables and
// texture creation. It excludes GPU upload/draw, optics and opaque-object LUTs.
const settings = normalizeSettings({sensorAltitudeM: 21, seaMode: 'statistical', verticalFovDeg: 8,
    detectorWidth: 640, detectorHeight: 640, seaWindMps: 5, seaSkinTemperatureK: 293});
const atmosphere = createAtmosphere(), camera = new PerspectiveCamera(8, 1, 1, 200000);
camera.updateMatrixWorld();
const pipeline = {atmosphere, profileKey: 'motion-fixture', skyView: {up: [0, 1, 0]}};
const clouds = new ThermalCloudPass(pipeline);
const frameMs = [], evaluations = [], seaRebuilds = [];
let sea, previous;
for (let frame = 0; frame < 300; frame++) {
    const start = performance.now(), timeS = frame / 30, angle = 60 * timeS / (EARTH_RADIUS_M + 21);
    const pitch = frame * 1e-5, up = [0, Math.cos(pitch), -Math.sin(pitch)];
    const sheets = Array.from({length: 20}, (_, i) => {
        const worldY = EARTH_RADIUS_M + 70, worldZ = -10000 - 5 * i;
        const localY = worldY * Math.cos(angle) - worldZ * Math.sin(angle) - (EARTH_RADIUS_M + 21);
        const localZ = worldY * Math.sin(angle) + worldZ * Math.cos(angle);
        return {id: `sheet:${i}`, center: [(i - 10) * 5 + 10 * timeS,
            localY * Math.cos(pitch) + localZ * Math.sin(pitch),
            -localY * Math.sin(pitch) + localZ * Math.cos(pitch)], size: [200, 100],
            temperaturePolicy: 'airAtAltitude', opticalDepth: Math.log(100)};
    });
    pipeline.skyView = {up};
    clouds.prepare(sheets, camera, settings);
    sea ??= createStatisticalSea(settings, atmosphere);
    const table = createSeaSkyTable(skyViewGeometry(settings, up, camera), [1, 0, 0], settings, atmosphere, sea);
    if (table !== previous) seaRebuilds.push(frame);
    previous = table;
    frameMs.push(performance.now() - start); evaluations.push(clouds.report.evaluations);
}
const distribution = values => {
    const sorted = [...values].sort((a, b) => a - b), percentile = p => sorted[Math.ceil(p * sorted.length) - 1];
    return {medianMs: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
        maxMs: sorted.at(-1), meanMs: values.reduce((a, b) => a + b, 0) / values.length};
};
console.log(JSON.stringify({status: 'calculated wall-clock time; estimated synthetic motion', frames: frameMs.length,
    firstFrameMs: frameMs[0], allFrames: distribution(frameMs), warmFrames: distribution(frameMs.slice(1)),
    atmosphericEvaluations: evaluations.reduce((a, b) => a + b, 0), framesWithIntegration: evaluations.filter(n => n > 0).length,
    seaRebuilds, target: {medianMs: 5, p95Ms: 16},
    meetsTarget: distribution(frameMs).medianMs < 5 && distribution(frameMs).p95Ms < 16}, null, 2));
clouds.dispose();

}

if (!process.argv.includes("--moving")) benchmarkCloudSea();

// Estimated airliner-speed fixture: 250 m/s, 300 delivered frames at 30 Hz.
// Calculated observer-relative target positions produce changing camera bearing,
// elevation and physical source range. Native detector and optical support are
// unchanged. These timings include production CPU preparation and kernel reuse,
// but exclude GPU work, scene traversal and gain readback/processing.
function benchmarkMovingCamera(initialRangeM, analysis) {
    const settings = normalizeSettings({sensorPreset: "MX15", sensorAltitudeM: 1380,
        psfRangeM: initialRangeM, pathElevationDeg: 2.27});
    const pipeline = new ThermalPipeline({}, {analysis});
    pipeline.resources = {surfaces: new Map(), textures: new Set(), targets: new Map()};
    pipeline._prepareSpectrum = () => {}; // explicitly excluded GPU submission
    const camera = new PerspectiveCamera(settings.verticalFovDeg,
        settings.detectorWidth / settings.detectorHeight, 1, 500000);
    const stages = {atmosphere: [], optics: [], sky: []}, times = [];
    let skyBuilds = 0, spectraBuilds = 0, basisBuilds = 0, maxKernelError = 0, maxSkyErrorK = 0;
    for (let frame = 0; frame < 300; frame++) {
        const start = performance.now(), t = frame / 30;
        const x = 250 * t, z = initialRangeM, y = initialRangeM * Math.tan(2.27 * Math.PI / 180);
        camera.lookAt(x, y, -z); camera.updateMatrixWorld(true);
        // Camera-coordinate up from the current tracking camera, with no rounded pose.
        const m = camera.matrixWorldInverse.elements, up = [m[4], m[5], m[6]];
        const elevation = Math.atan2(y, Math.hypot(x, z));
        const current = {...settings, psfRangeM: Math.hypot(x, y, z), pathElevationDeg: elevation * 180 / Math.PI};
        const view = skyViewGeometry(current, up, camera);
        pipeline.skyView = view; pipeline.seaWind = [1, 0, 0];
        let before = performance.now();
        pipeline._prepareAtmosphere(current);
        stages.atmosphere.push(performance.now() - before); before = performance.now();
        pipeline._prepareOptics(current, settings.detectorWidth * settings.supersample, settings.detectorHeight * settings.supersample);
        stages.optics.push(performance.now() - before); before = performance.now();
        pipeline._prepareSkyBackground(current, view);
        stages.sky.push(performance.now() - before);
        times.push(performance.now() - start);
        skyBuilds += Number(pipeline.skyCacheRebuilt); spectraBuilds += Number(pipeline.opticsReport.spectraRebuilt);
        basisBuilds += Number(pipeline.opticsReport.basisRebuilt);
        maxKernelError = Math.max(maxKernelError, pipeline.opticsReport.errorL1);
        maxSkyErrorK = Math.max(maxSkyErrorK, pipeline.frameBackground.interpolation?.maxErrorK ?? 0);
    }
    const output = {status: "measured CPU preparation; estimated synthetic motion", tier: analysis ? "analysis" : "interactive",
        initialRangeM, speedMps: 250, frames: times.length, firstFrameMs: times[0],
        allFrames: timingDistribution(times), warmFrames: timingDistribution(times.slice(1)),
        stages: Object.fromEntries(Object.entries(stages).map(([key, values]) => [key, timingDistribution(values)])),
        skyBuilds, spectraBuilds, basisBuilds, maxKernelError, maxSkyErrorK,
        fft: pipeline.scatterSplit, targetMs: 1000 / 30,
        cpuPreparationMeetsTarget: timingDistribution(times).medianMs <= 1000 / 30,
        realtimeEstablished: false, excluded: "GPU upload/draw/completion, scene traversal and gain; run the browser self-test for end-to-end results"};
    for (const texture of pipeline.resources.textures) texture.dispose();
    console.log(JSON.stringify(output, null, 2));
}
for (const analysis of [false, true]) for (const rangeM of [2000, 125000]) benchmarkMovingCamera(rangeM, analysis);
