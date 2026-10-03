import {RangeTableCache, SkyBackgroundCache, createAtmosphere, createRangeLUT,
    createSkyElevationLUT, sampleSkyElevationLUT, backgroundAtElevation, brightnessErrorBound,
    skyViewGeometry, thermalSeaDistance, EARTH_RADIUS_M, createThermalRayGeometry,
    RANGE_TRANSMISSION_TOLERANCE, RANGE_PATH_TOLERANCE_K} from '../tools/thermal/atmosphere.js';
import {ThermalPipeline} from '../tools/thermal/ThermalPipeline.js';
import {normalizeSettings} from '../tools/thermal/thermalSchema.js';
import {PHOTON_SCALE, radianceDerivative} from '../tools/thermal/radiometry.js';

const band = {minUm: 3, maxUm: 5};
const finish = steps => {let result; do {result = steps.next();} while (!result.done); return result.value;};
const horizon = h => -Math.acos(EARTH_RADIUS_M/(EARTH_RADIUS_M+h));
function random() {let seed = 18271; return () => {seed = (1664525*seed+1013904223) >>> 0; return seed/2**32;};}
function rangeCache(options, atmosphere) {
    const cache = new RangeTableCache();
    cache.domain = finish(cache.build(options, atmosphere)); cache.atmosphere = atmosphere;
    cache.key = JSON.stringify([options.surfaceLimited ? ['surface', options.rangeLimitM] : options.maxRangeM, options.size, band, options.rayGeometry?.domainKey ?? options.rayGeometry?.key, options.segments]);
    cache.pending = {};
    return cache;
}
function compareRange(cache, options, atmosphere) {
    const predicted = cache.request(options, atmosphere), exact = createRangeLUT({...options, atmosphere});
    expect(predicted).not.toBeNull();
    const slope = radianceDerivative(300, band).photon/PHOTON_SCALE;
    let transmission = 0, path = 0;
    for (let i = 0; i < exact.size; i++) {
        let sum = 0;
        for (let b = 0; b < 12; b++) {
            const k = i*12+b;
            transmission = Math.max(transmission, Math.abs(predicted.transmission[k]-exact.transmission[k]));
            sum += Math.abs(predicted.pathRadiance[k]-exact.pathRadiance[k]);
        }
        path = Math.max(path, sum/slope);
    }
    expect(transmission).toBeLessThanOrEqual(RANGE_TRANSMISSION_TOLERANCE);
    expect(path).toBeLessThanOrEqual(RANGE_PATH_TOLERANCE_K);
}

test('range domains validate independent random heights and elevations and metre drift', () => {
    const atmosphere = createAtmosphere(), options = {size: 32, maxRangeM: 200000,
        sensorAltitudeM: 1380, elevationRad: .04, band};
    const cache = rangeCache(options, atmosphere), next = random(), {dh, de} = cache.domain;
    expect(dh).toBeGreaterThan(100);
    for (let i = 0; i < 32; i++) compareRange(cache, {...options,
        sensorAltitudeM: options.sensorAltitudeM+(2*next()-1)*dh,
        elevationRad: options.elevationRad+(2*next()-1)*de}, atmosphere);
    for (const delta of [-100, -1, -.001, .001, 1, 100])
        expect(cache.request({...options, sensorAltitudeM: options.sensorAltitudeM+delta}, atmosphere)).not.toBeNull();
    cache.dispose();
});

test.each([-.1, horizon(21)-.0001, horizon(21)+.0001])('range surface and horizon limits at elevation %s', elevationRad => {
    const atmosphere = createAtmosphere(), surfaceLimited = elevationRad < horizon(21);
    const options = {size: 12, maxRangeM: surfaceLimited ? thermalSeaDistance(21, Math.sin(elevationRad)) : 200000,
        sensorAltitudeM: 21, elevationRad, band, surfaceLimited, rangeLimitM: 200000};
    const cache = rangeCache(options, atmosphere), next = random();
    for (let i = 0; i < 12; i++) {
        const moved = {...options, sensorAltitudeM: 21+(2*next()-1)*cache.domain.dh,
            elevationRad: elevationRad+(2*next()-1)*cache.domain.de};
        if (surfaceLimited) moved.maxRangeM = Math.min(200000, thermalSeaDistance(moved.sensorAltitudeM, Math.sin(moved.elevationRad)));
        compareRange(cache, moved, atmosphere);
        expect(cache.request(moved, atmosphere).maxRangeM).toBe(moved.maxRangeM);
    }
    cache.dispose();
});

function skyCache(options, atmosphere) {
    const cache = new SkyBackgroundCache();
    cache.key = JSON.stringify([options.temperatureK, band, undefined, undefined, undefined]);
    cache.atmosphere = atmosphere; cache.domain = finish(cache.build(options, atmosphere)); cache.pending = {};
    return cache;
}
const view = (e, fov = .4) => skyViewGeometry({pathElevationDeg: e*180/Math.PI,
    verticalFovDeg: fov, detectorWidth: 640, detectorHeight: 512});

test.each([[1380, .04, .4], [21, horizon(21), .2], [0, 0, .2]])(
    'sky interpolation validates random heights and both horizon limits at %s m', (h, e, fov) => {
        const atmosphere = createAtmosphere(), options = {sensorAltitudeM: h, temperatureK: 288.15, band, view: view(e, fov)};
        const cache = skyCache(options, atmosphere), next = random(), domain = cache.domain;
        expect(domain.q.length).toBeLessThanOrEqual(4097);
        expect(domain.altitudeErrorK).toBeLessThanOrEqual(.001);
        expect(domain.angularErrorK).toBeLessThanOrEqual(.002);
        for (let i = 0; i < 18; i++) {
            const height = h+(2*next()-1)*domain.dh;
            const elevation = domain.minQ+next()*(domain.maxQ-domain.minQ)+horizon(height);
            const moved = {...options, sensorAltitudeM: height, view: view(e+horizon(height)-horizon(h), fov)};
            const table = cache.table(moved, atmosphere);
            const points = [elevation];
            if (domain.minQ < 0 && domain.maxQ > 0) points.push(horizon(height)-1e-7, horizon(height)+1e-7);
            for (const angle of points) {
                const actual = backgroundAtElevation(angle, moved, atmosphere).photonRadiance;
                const predicted = sampleSkyElevationLUT(table, angle);
                expect(brightnessErrorBound(Math.abs(actual-predicted), Math.min(actual,predicted), band)).toBeLessThanOrEqual(.005);
                const uploaded = {...table, elevations: Float32Array.from(table.elevations),
                    photonRadiances: Float64Array.from(table.photonRadiances, v => Math.fround(v/PHOTON_SCALE)*PHOTON_SCALE)};
                const quantized = sampleSkyElevationLUT(uploaded, angle);
                if (domain.dh) {
                    const nodes = [-1, -1/3, 1/3, 1], y = (height-domain.h)/domain.dh, q = angle-horizon(height);
                    const altitudeOnly = nodes.reduce((sum, node, j) => {
                        const weight = nodes.reduce((w, other, k) => j === k ? w : w*(y-other)/(node-other), 1);
                        const z = domain.h+node*domain.dh;
                        return sum+weight*backgroundAtElevation(q+horizon(z), {...options, sensorAltitudeM: z}, atmosphere).photonRadiance;
                    }, 0);
                    expect(brightnessErrorBound(Math.abs(actual-altitudeOnly), Math.min(actual,altitudeOnly), band)).toBeLessThanOrEqual(.001);
                }
                expect(brightnessErrorBound(Math.abs(actual-quantized), Math.min(actual,quantized), band)).toBeLessThanOrEqual(.005);
            }
        }
        expect(cache.fallbacks).toBe(0);
        cache.dispose();
    });

test('reference sky and range table generation remains deterministic during cache use', () => {
    const atmosphere = createAtmosphere(), options = {sensorAltitudeM: 1380, temperatureK: 288.15, band, view: view(.04)};
    const range = {...options, size: 12, maxRangeM: 200000, elevationRad: .04};
    const beforeSky = createSkyElevationLUT(options, atmosphere), beforeRange = createRangeLUT({...range, atmosphere});
    const cache = skyCache(options, atmosphere);
    cache.table({...options, sensorAltitudeM: 1390}, atmosphere); cache.dispose();
    expect(createSkyElevationLUT(options, atmosphere)).toEqual(beforeSky);
    expect(createRangeLUT({...range, atmosphere})).toEqual(beforeRange);
});

test.each([-50, -10, 10, 50])('range prefetch follows measured altitude motion (%s m/s)', speed => {
    const atmosphere = createAtmosphere(), options = {size: 8, maxRangeM: 200000,
        sensorAltitudeM: 1380, elevationRad: .04, band};
    const cache = rangeCache(options, atmosphere), height = options.sensorAltitudeM+Math.sign(speed)*cache.domain.dh*.2;
    cache.pending = null; cache.start = jest.fn();
    cache.lastRequest = {e: options.elevationRad, h: height-speed*.1, time: performance.now()-100};
    expect(cache.request({...options, sensorAltitudeM: height}, atmosphere)).not.toBeNull();
    const predicted = cache.start.mock.calls[0][0].sensorAltitudeM;
    expect(Math.sign(predicted-height)).toBe(Math.sign(speed));
    cache.dispose();
});

test('adjacent range domains reuse exact samples and revalidate the moved domain', () => {
    const atmosphere = createAtmosphere(), options = {size: 16, maxRangeM: 200000,
        sensorAltitudeM: 1380, elevationRad: .04, band};
    const cache = rangeCache(options, atmosphere), first = cache.domain;
    cache.domain = finish(cache.build({...options, elevationRad: first.e-first.grid.stepE}, atmosphere, first));
    expect(cache.domain.tables.filter(t => first.tables.includes(t)).length).toBe(30);
    expect([...cache.domain.checks.values()].filter(t => [...first.checks.values()].includes(t)).length).toBe(20);
    const next = random();
    for (let i = 0; i < 16; i++) compareRange(cache, {...options,
        sensorAltitudeM: cache.domain.h+(2*next()-1)*cache.domain.dh,
        elevationRad: cache.domain.e+(2*next()-1)*cache.domain.de}, atmosphere);
    cache.dispose();
});

test('range interpolation at the surface retains the exact tangent ray', () => {
    const atmosphere = createAtmosphere(), options = {size: 8, maxRangeM: 2000,
        sensorAltitudeM: 0, elevationRad: 0, band};
    const cache = rangeCache(options, atmosphere);
    expect(cache.domain.dh).toBe(0);
    expect(cache.domain.de).toBe(0);
    compareRange(cache, options, atmosphere);
    cache.dispose();
});

test('sky drift reuses its domain without integrations or synchronous tables', () => {
    const atmosphere = {...createAtmosphere()}, options = {sensorAltitudeM: 1380, temperatureK: 288.15, band, view: view(.04)};
    const cache = skyCache(options, atmosphere), first = cache.domain;
    const exactSample = atmosphere.sample;
    // A cache hit must only interpolate. Atmospheric integration is forbidden here.
    atmosphere.sample = () => {throw new Error('unexpected atmospheric evaluation');};
    try {
        for (const speed of [-50, -10, 10, 50]) for (let frame = 0; frame < 300; frame++) {
            const height = options.sensorAltitudeM+speed*frame/30;
            if (Math.abs(height-first.h) > first.dh) continue;
            const table = cache.table({...options, sensorAltitudeM: height}, atmosphere);
            expect(table.domain).toBe(first);
            expect(table.sensorAltitudeM).toBe(height);
        }
        expect(cache.fallbacks).toBe(0);
    } finally {atmosphere.sample = exactSample; cache.dispose();}
});


test.each([{analysis: true}, {analysis: false, synchronous: true}])(
    'offline pipeline retains bit-identical range and sky tables (%j)', mode => {
        const pipeline = new ThermalPipeline({}, mode);
        pipeline.resources = {surfaces: new Map(), textures: new Set(), targets: new Map(), materials: new Map()};
        const settings = normalizeSettings({sensorPreset: 'MX15', sensorAltitudeM: 1380, pathElevationDeg: 2.27});
        const options = {sensorAltitudeM: settings.sensorAltitudeM, elevationRad: settings.pathElevationDeg*Math.PI/180,
            maxRangeM: settings.atmosphereMaxRangeM, band, temperatureK: settings.surfaceTemperatureK, view: skyViewGeometry(settings)};
        pipeline.rangeCache.request = () => {throw new Error('interactive range cache used offline');};
        pipeline.skyCache.table = () => {throw new Error('interactive sky cache used offline');};
        try {
            pipeline._prepareAtmosphere(settings);
            pipeline._prepareSkyBackground(settings, options.view);
            expect(pipeline.rangeLUT).toEqual(createRangeLUT({...options, atmosphere: pipeline.atmosphere}));
            expect(pipeline.skyTable).toEqual(createSkyElevationLUT(options, pipeline.atmosphere));
        } finally {pipeline.dispose();}
    });


test('mapped rays reuse only a compatible altitude factory and integration accuracy', () => {
    const mapped = h => {
        const geometry = createThermalRayGeometry({sensorAltitudeM: h, earthRadiusM: EARTH_RADIUS_M,
            lift: () => 0, key: `mapped-height-${h}`});
        return {...geometry, domainKey: 'mapped-height-domain', atAltitude: mapped};
    };
    const atmosphere = createAtmosphere(), options = {size: 8, maxRangeM: 2000,
        sensorAltitudeM: 1380, elevationRad: .04, band, rayGeometry: mapped(1380)};
    const cache = rangeCache(options, atmosphere);
    for (const offset of [-.7, -.23, .31, .87]) {
        const h = cache.domain.h+offset*cache.domain.dh;
        compareRange(cache, {...options, sensorAltitudeM: h, rayGeometry: mapped(h)}, atmosphere);
    }
    expect(cache.request({...options, segments: 192}, atmosphere)).toBeNull();
    cache.dispose();
});

test('descent clips the altitude seed without discarding angular coverage', () => {
    const atmosphere = createAtmosphere(), options = {size: 12, maxRangeM: 200000,
        sensorAltitudeM: 1380, elevationRad: .04, band};
    const cache = rangeCache(options, atmosphere), first = cache.domain;
    cache.domain = finish(cache.build({...options, sensorAltitudeM: first.h-first.grid.stepH,
        elevationRad: first.e-first.grid.stepE}, atmosphere, first));
    expect(cache.domain.h-cache.domain.dh).toBeGreaterThanOrEqual(0);
    expect(cache.domain.dh).toBe(first.dh/2);
    expect(cache.domain.de).toBe(first.de);
    const next = random();
    for (let i = 0; i < 16; i++) compareRange(cache, {...options,
        sensorAltitudeM: cache.domain.h+(2*next()-1)*cache.domain.dh,
        elevationRad: cache.domain.e+(2*next()-1)*cache.domain.de}, atmosphere);
    cache.dispose();
});

test('publication retains the older domain that still serves the current pose', async () => {
    const atmosphere = createAtmosphere(), cache = new RangeTableCache();
    const active = {h: 1380, dh: 512, e: .04, de: .016};
    cache.domain = {h: 2400, dh: 10, e: .04, de: .002}; cache.previousDomain = active;
    cache.key = 'publication-fixture'; cache.atmosphere = atmosphere;
    cache.lastRequest = {h: 1380, e: .04, time: performance.now()};
    const future = {h: 2500, dh: 10, e: .04, de: .002};
    cache.build = function* () {yield; return future;};
    await new Promise(resolve => {
        cache.onReady = resolve;
        cache.start({sensorAltitudeM: 1380, elevationRad: .04}, atmosphere, cache.key);
    });
    expect(cache.domain).toBe(future);
    expect(cache.previousDomain).toBe(active);
    cache.dispose();
});

test('motion toward a prefetched center does not schedule another strip', () => {
    const atmosphere = createAtmosphere(), options = {size: 8, maxRangeM: 2000,
        sensorAltitudeM: 1380, elevationRad: .04, band};
    const cache = rangeCache(options, atmosphere), e = cache.domain.e+cache.domain.de*.2;
    cache.pending = null; cache.start = jest.fn();
    cache.lastRequest = {h: options.sensorAltitudeM, e: e+.0001, time: performance.now()-100};
    expect(cache.request({...options, elevationRad: e}, atmosphere)).not.toBeNull();
    expect(cache.start).not.toHaveBeenCalled();
    cache.dispose();
});

test('cooperative sky work preserves a factory whose returned rays have no factory', async () => {
    const mapped = sensorAltitudeM => createThermalRayGeometry({sensorAltitudeM, earthRadiusM: EARTH_RADIUS_M,
        lift: () => 0, key: `sky-height-${sensorAltitudeM}`});
    const at = h => ({...mapped(h), domainKey: 'sky-height-domain', atAltitude: mapped});
    const atmosphere = createAtmosphere(), options = {sensorAltitudeM: 1380, temperatureK: 288.15,
        rayGeometry: at(1380), band, view: view(.04)};
    const cache = new SkyBackgroundCache();
    try {
        await new Promise((resolve, reject) => {
            cache.onReady = () => cache.error ? reject(cache.error) : resolve();
            cache.table(options, atmosphere);
        });
        const moved = {...options, sensorAltitudeM: 1381, rayGeometry: at(1381)};
        const table = cache.table(moved, atmosphere);
        expect(table.domain).toBe(cache.domain);
        const actual = backgroundAtElevation(.04, moved, atmosphere).photonRadiance;
        const predicted = sampleSkyElevationLUT(table, .04);
        expect(brightnessErrorBound(Math.abs(actual-predicted), Math.min(actual,predicted), band)).toBeLessThanOrEqual(.005);
    } finally {cache.dispose();}
}, 20000);
