import {PerspectiveCamera} from 'three';
import {ThermalCloudPass} from './ThermalPipeline.js';
import {createAtmosphere, createStatisticalSea, createSeaSkyTable, skyViewGeometry, EARTH_RADIUS_M} from './atmosphere.js';
import {normalizeSettings} from './thermalSchema.js';

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
