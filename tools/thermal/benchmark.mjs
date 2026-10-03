import {Worker} from 'node:worker_threads';
import {integrateTurbulence} from './turbulence.js';
import {PerspectiveCamera} from 'three';
import {ThermalCloudPass, ThermalPipeline} from './ThermalPipeline.js';
import {timingDistribution, opticalFields} from './sensorMath.js';
import {createAtmosphere, createStatisticalSea, createSeaSkyTable, skyViewGeometry, EARTH_RADIUS_M, RangeTableCache, SkyBackgroundCache} from './atmosphere.js';
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

if (!process.argv.includes("--moving") && !process.argv.includes("--busy-cache") && !process.argv.includes("--busy-sky")) benchmarkCloudSea();

// Estimated track fixtures: 250 and 822 m/s, 300 delivered frames at 30 Hz.
// Calculated observer-relative target positions produce changing camera bearing,
// elevation and physical source range. Native detector and optical support are
// unchanged. These timings include production CPU preparation and kernel reuse,
// but exclude GPU work, scene traversal and gain readback/processing.
async function benchmarkMovingCamera(initialRangeM, analysis, speedMps, verticalSpeedMps = 0) {
    const settings = normalizeSettings({sensorPreset: "MX15", sensorAltitudeM: 1380,
        psfRangeM: initialRangeM, pathElevationDeg: 2.27});
    const createOpticsWorker = () => {
        const worker = new Worker(new URL('./opticsWorkerNode.mjs', import.meta.url));
        worker.on('message', data => worker.onmessage?.({data}));
        worker.on('error', error => worker.onerror?.(error));
        return worker;
    };
    const pipeline = new ThermalPipeline({}, {analysis, createOpticsWorker});
    pipeline.resources = {surfaces: new Map(), textures: new Set(), targets: new Map(), materials: new Map()};
    pipeline._prepareSpectrum = name => {pipeline.resources.targets.set(name, {dispose() {}});}; // explicitly excluded GPU submission
    const camera = new PerspectiveCamera(settings.verticalFovDeg,
        settings.detectorWidth / settings.detectorHeight, 1, 500000);
    const stages = {atmosphere: [], optics: [], sky: []}, times = [], includingCooperative = [];
    let previousRangeWork = 0, rangeHits = 0, rangeRequests = 0, synchronousFallbackFrames = 0;
    let skyRequests = 0;
    const requestSky = pipeline.skyCache.table.bind(pipeline.skyCache);
    pipeline.skyCache.table = (...args) => {skyRequests++; return requestSky(...args);};
    let frameFallback = false, previousSkyBuilds = 0, previousSkyFallbacks = 0, skyTextureUpdates = 0, skySynchronousBuilds = 0;
    const requestRange = pipeline.rangeCache.request.bind(pipeline.rangeCache);
    pipeline.rangeCache.request = (...args) => {
        const result = requestRange(...args);
        rangeRequests++; rangeHits += Number(!!result); frameFallback ||= !result;
        return result;
    };
    let skyBuilds = 0, spectraBuilds = 0, basisBuilds = 0, maxKernelError = 0, maxSkyErrorK = 0;
    const rebuilds = []; let previousSettings;
    let nextFrameAt = performance.now();
    let initializationMs = 0, waitingFrames = 0, maxRangeErrorK = 0, maxRangeTransmissionError = 0;
    const frames = Number(process.argv.find(v => v.startsWith("--frames="))?.split("=")[1] ?? 300);
    for (let frame = 0; frame < frames; frame++) {
        if (!analysis && frame) await new Promise(resolve => setTimeout(resolve, Math.max(0, nextFrameAt-performance.now())));
        let start = performance.now();
        frameFallback = false;
        if (process.argv.includes("--trace-cache") && frame%30 === 0) console.error({frame,
            domain: pipeline.rangeCache.domain && {e: pipeline.rangeCache.domain.e, h: pipeline.rangeCache.domain.h, de: pipeline.rangeCache.domain.de, dh: pipeline.rangeCache.domain.dh},
            rangeWork: pipeline.rangeCache.workMs, rangeWall: pipeline.rangeCache.buildWallMs,
            skyDomain: pipeline.skyCache.domain && {h: pipeline.skyCache.domain.h, dh: pipeline.skyCache.domain.dh,
                minQ: pipeline.skyCache.domain.minQ, maxQ: pipeline.skyCache.domain.maxQ},
            jobAge: pipeline.rangeCache.pending ? performance.now()-pipeline.rangeCache.pending.started : 0});
        const t = frame / 30;
        const x = speedMps * t, z = initialRangeM, y = initialRangeM * Math.tan(2.27 * Math.PI / 180);
        camera.lookAt(x, y, -z); camera.updateMatrixWorld(true);
        // Camera-coordinate up from the current tracking camera, with no rounded pose.
        const m = camera.matrixWorldInverse.elements, up = [m[4], m[5], m[6]];
        const elevation = Math.atan2(y, Math.hypot(x, z));
        // Estimated climb/descent fixture: the target retains its relative height,
        // isolating altitude drift from the existing horizontal tracking motion.
        const current = {...settings, sensorAltitudeM: settings.sensorAltitudeM + verticalSpeedMps * t, psfRangeM: Math.hypot(x, y, z), pathElevationDeg: elevation * 180 / Math.PI};
        current.turbulenceR0M = integrateTurbulence({sensorAltitudeM: current.sensorAltitudeM,
            slantRangeM: current.psfRangeM, elevationRad: elevation}).r0ReferenceM;
        const view = skyViewGeometry(current, up, camera);
        pipeline.skyView = view; pipeline.seaWind = [1, 0, 0];
        let before = performance.now();
        let atmosphereReady = pipeline._prepareAtmosphere(current);
        stages.atmosphere.push(performance.now() - before); before = performance.now();
        let opticsReady = pipeline._prepareOptics(current, settings.detectorWidth * settings.supersample, settings.detectorHeight * settings.supersample);
        if (!frame && !analysis) {
            while (!atmosphereReady || !opticsReady || pipeline.rangeCache.pending) {
                await new Promise(resolve => setTimeout(resolve, 10));
                atmosphereReady = pipeline._prepareAtmosphere(current);
                opticsReady = pipeline._prepareOptics(current, settings.detectorWidth * settings.supersample, settings.detectorHeight * settings.supersample);
            }
            pipeline._prepareSkyBackground(current, view);
            while (pipeline.skyCache.pending) await new Promise(resolve => setTimeout(resolve, 10));
            initializationMs = performance.now()-start;
            frameFallback = false; rangeRequests = 0; rangeHits = 0; skyRequests = 0;
            previousSkyBuilds = pipeline.skyCache.builds ?? 0;
            previousSkyFallbacks = pipeline.skyCache.fallbacks ?? 0;
            previousRangeWork = (pipeline.rangeCache.workMs ?? 0) + (pipeline.skyCache.workMs ?? 0);
            // Each poll is a separate preparation attempt. Start the first
            // delivered-frame measurement after asynchronous initialization.
            start = performance.now();
            pipeline._prepareAtmosphere(current);
            stages.atmosphere[0] = performance.now()-start; before = performance.now();
            pipeline._prepareOptics(current, settings.detectorWidth*settings.supersample, settings.detectorHeight*settings.supersample);
        }
        waitingFrames += Number(!atmosphereReady || !opticsReady);
        stages.optics.push(performance.now() - before); before = performance.now();
        pipeline._prepareSkyBackground(current, view);
        stages.sky.push(performance.now() - before);
        times.push(performance.now() - start);
        synchronousFallbackFrames += Number(frameFallback);
        const rangeWork = (pipeline.rangeCache.workMs ?? 0) + (pipeline.skyCache.workMs ?? 0);
        includingCooperative.push(times.at(-1)+rangeWork-previousRangeWork); previousRangeWork = rangeWork;
        nextFrameAt = Math.max(start, performance.now()-1000/30) + 1000/30;
        skyTextureUpdates += Number(pipeline.skyCacheRebuilt);
        skyBuilds += pipeline.skyCache.builds === undefined ? Number(pipeline.skyCacheRebuilt) : pipeline.skyCache.builds - previousSkyBuilds;
        skySynchronousBuilds += (pipeline.skyCache.fallbacks ?? 0)-previousSkyFallbacks;
        previousSkyBuilds = pipeline.skyCache.builds ?? 0;
        previousSkyFallbacks = pipeline.skyCache.fallbacks ?? 0;
        spectraBuilds += Number(pipeline.opticsReport.spectraRebuilt);
        basisBuilds += Number(pipeline.opticsReport.basisRebuilt);
        if (pipeline.opticsReport.basisRebuilt) rebuilds.push({frame, ms: stages.optics.at(-1),
            basisKeyChanges: previousSettings ? opticalFields.filter(k => current[k] !== previousSettings[k]) : ["initial"]});
        previousSettings = current;
        maxKernelError = Math.max(maxKernelError, pipeline.opticsReport.errorL1 ?? 0);
        maxRangeErrorK = Math.max(maxRangeErrorK, pipeline.rangeReport?.pathErrorK ?? 0);
        maxRangeTransmissionError = Math.max(maxRangeTransmissionError, pipeline.rangeReport?.transmissionError ?? 0);
        maxSkyErrorK = Math.max(maxSkyErrorK, pipeline.frameBackground.interpolation?.maxErrorK ?? 0);
    }
    const output = {status: "measured CPU preparation; estimated synthetic motion", tier: analysis ? "analysis" : "interactive",
        initialRangeM, speedMps, verticalSpeedMps, initializationMs, waitingFrames, maxRangeErrorK, maxRangeTransmissionError, frames: times.length, firstFrameMs: times[0],
        allFrames: timingDistribution(times), cpuIncludingCooperative: timingDistribution(includingCooperative), warmFrames: timingDistribution(times.slice(1)),
        stages: Object.fromEntries(Object.entries(stages).map(([key, values]) => [key, timingDistribution(values)])),
        skyDomainBuilds: skyBuilds, skySynchronousBuilds, skyTextureUpdates,
        skyRequests, skyHitRate: skyRequests ? (skyRequests-skySynchronousBuilds)/skyRequests : null, rangeHits, rangeRequests, rangeHitRate: rangeRequests ? rangeHits / rangeRequests : null, synchronousFallbackFrames, spectraBuilds, basisBuilds, rebuilds, maxKernelError, maxSkyErrorK,
        worker: {buildMs: pipeline.opticsScheduler.buildMs, basisBuilds: pipeline.opticsScheduler.domain?.builds},
        rangeCacheBuilds: pipeline.rangeCache.builds,
        cooperativeRangeWork: {cpuMs: pipeline.rangeCache.workMs, maxSliceMs: pipeline.rangeCache.maxSliceMs},
        cooperativeSkyWork: {cpuMs: pipeline.skyCache.workMs, maxSliceMs: pipeline.skyCache.maxSliceMs}, fft: pipeline.scatterSplit, targetMs: 1000 / 30,
        cpuPreparationMeetsTarget: timingDistribution(includingCooperative).medianMs <= 33 && timingDistribution(includingCooperative).maxMs <= 50 && waitingFrames === 0 && synchronousFallbackFrames === 0 && skySynchronousBuilds === 0,
        opticsToleranceMet: maxKernelError <= 1e-4,
        realtimeEstablished: false, excluded: "GPU upload/draw/completion, scene traversal and gain; run the browser self-test for end-to-end results"};
    console.log(JSON.stringify(output, null, 2));
    pipeline.skyCache?.dispose?.();
    pipeline.dispose();
}
if (process.argv.includes("--moving")) {
    const verticalArgument = process.argv.find(v => v.startsWith("--vertical="));
    const verticalSpeeds = verticalArgument ? [Number(verticalArgument.split("=")[1])] :
        process.argv.includes("--level-only") ? [0] : process.argv.includes("--drift-only") ? [10, -10, 50, -50] : [0, 10, -10, 50, -50];
    const speeds = [250, 822].filter(v => !process.argv.includes("--fast-only") || v === 822);
    const ranges = [2000, 125000].filter(v => !process.argv.includes("--near-only") || v === 2000);
    for (const speedMps of speeds) for (const rangeM of ranges) for (const verticalSpeedMps of verticalSpeeds)
        await benchmarkMovingCamera(rangeM, process.argv.includes("--analysis"), speedMps, verticalSpeedMps);
}

// Estimated busy-page fixture: 100 ms of main-thread work in each 120 ms frame.
// The publication wall time includes contention and the production slice policy.
if (process.argv.includes("--busy-cache") || process.argv.includes("--busy-sky")) {
    const sky = process.argv.includes("--busy-sky");
    const cache = sky ? new SkyBackgroundCache() : new RangeTableCache(), atmosphere = createAtmosphere();
    let running = true;
    const busy = () => {
        if (!running) return;
        const end = performance.now() + 100;
        while (performance.now() < end) { /* main-thread frame work */ }
        setTimeout(busy, 20);
    };
    setTimeout(busy, 0);
    const start = performance.now();
    await new Promise((resolve, reject) => {
        cache.onReady = () => cache.error ? reject(cache.error) : resolve();
        if (sky) {
            const settings = normalizeSettings({sensorPreset: "MX15", sensorAltitudeM: 1380, pathElevationDeg: 2.27});
            cache.table({sensorAltitudeM: 1380, temperatureK: settings.surfaceTemperatureK,
                view: skyViewGeometry(settings), band: {minUm: 3, maxUm: 5}}, atmosphere);
        } else cache.request({maxRangeM: 200000, sensorAltitudeM: 1380, elevationRad: .04,
            band: {minUm: 3, maxUm: 5}}, atmosphere);
    });
    running = false;
    const wallMs = performance.now() - start;
    console.log(JSON.stringify({cache: sky ? "sky" : "range", fixture: "100 ms busy / 120 ms frame", wallMs, cpuMs: cache.workMs,
        maxSliceMs: cache.maxSliceMs, altitudeHalfWidthM: cache.domain.dh,
        verticalSpeeds: [10, 50].map(speedMps => ({speedMps, timeToLeaveMs: cache.domain.dh / speedMps * 1000,
            publishedBeforeExit: wallMs < cache.domain.dh / speedMps * 1000}))}, null, 2));
    cache.dispose();
}
