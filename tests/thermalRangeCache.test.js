import {RangeTableCache, RANGE_TRANSMISSION_TOLERANCE, RANGE_PATH_TOLERANCE_K} from "../tools/thermal/atmosphere.js";
import {createAtmosphere, createRangeLUT, sourceRangeLUT, blackbodyBands, thermalSeaDistance} from "../tools/thermal/atmosphere.js";
import {PHOTON_SCALE, radianceDerivative} from "../tools/thermal/radiometry.js";

test("foreground range cache bounds independent elevations, heights and nonnegative spectra", () => {
    const atmosphere = createAtmosphere(), cache = new RangeTableCache();
    const options = {size: 32, maxRangeM: 200000, sensorAltitudeM: 1380, elevationRad: .04, band: {minUm: 3, maxUm: 5}};
    const steps = cache.build(options, atmosphere);
    let result; do {result = steps.next();} while (!result.done);
    cache.domain = result.value; cache.atmosphere = atmosphere;
    cache.key = JSON.stringify([options.maxRangeM, options.size, options.band, undefined, options.segments]);
    // Disable prefetch only in this numeric reference test.
    cache.pending = {};
    const derivative = radianceDerivative(300, options.band).photon / PHOTON_SCALE;
    for (const offset of [-.87, -.217, .431, .93]) {
        const moved = {...options, elevationRad: options.elevationRad + offset*cache.domain.de,
            sensorAltitudeM: options.sensorAltitudeM + .713*cache.domain.dh};
        const predicted = cache.request(moved, atmosphere), exact = createRangeLUT({...moved, atmosphere});
        for (const temperatureK of [220, 300, 750]) {
            const source = blackbodyBands(temperatureK, {quantity: "photon", band: options.band});
            const a = sourceRangeLUT(predicted, source), b = sourceRangeLUT(exact, source);
            const bound = RANGE_TRANSMISSION_TOLERANCE*source.reduce((s,v) => s+v,0)/PHOTON_SCALE + derivative*RANGE_PATH_TOLERANCE_K;
            for (let i=0; i<a.length; i++) expect(Math.abs(a[i]-b[i])).toBeLessThanOrEqual(bound+1e-6);
        }
    }
    expect(cache.request({...options, elevationRad: .3}, atmosphere)).toBeNull();
    expect(cache.request(options, createAtmosphere({surfaceTemperatureK: 300}))).toBeNull();
    cache.dispose();
});

test("cooperative range build yields before completion and disposal cancels publication", async () => {
    const ready = jest.fn(), cache = new RangeTableCache(ready);
    const atmosphere = createAtmosphere(), options = {size: 8, maxRangeM: 2000, sensorAltitudeM: 1380,
        elevationRad: .04, band: {minUm: 3, maxUm: 5}};
    expect(cache.request(options, atmosphere)).toBeNull();
    expect(cache.domain).toBeUndefined();
    cache.dispose();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ready).not.toHaveBeenCalled();
});


test("surface-limited cache follows the moving first intersection without crossing it", () => {
    const atmosphere = createAtmosphere(), cache = new RangeTableCache();
    const options = {size: 16, rangeLimitM: 200000, surfaceLimited: true, sensorAltitudeM: 21,
        elevationRad: -.1, band: {minUm: 3, maxUm: 5}};
    options.maxRangeM = thermalSeaDistance(options.sensorAltitudeM, Math.sin(options.elevationRad));
    const steps = cache.build(options, atmosphere);
    let result; do {result = steps.next();} while (!result.done);
    cache.domain = result.value; cache.atmosphere = atmosphere; cache.pending = {};
    cache.key = JSON.stringify([["surface",options.rangeLimitM],options.size,options.band,undefined,options.segments]);
    const moved = {...options, elevationRad: options.elevationRad + .37*cache.domain.de};
    moved.maxRangeM = thermalSeaDistance(moved.sensorAltitudeM,Math.sin(moved.elevationRad));
    const predicted = cache.request(moved,atmosphere), exact = createRangeLUT({...moved,atmosphere});
    expect(predicted.maxRangeM).toBe(moved.maxRangeM);
    for (let i=0;i<exact.transmission.length;i++)
        expect(Math.abs(predicted.transmission[i]-exact.transmission[i])).toBeLessThan(RANGE_TRANSMISSION_TOLERANCE);
    cache.dispose();
});
