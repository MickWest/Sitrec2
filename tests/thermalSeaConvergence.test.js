import {execFileSync} from 'node:child_process';

// Run the numerical domain sweep in the same native module runtime as the tool.
// Estimated fixtures: U10 2–10 m/s, skin 288–297 K, 21/7620 m altitude,
// nadir through 89.99 degree incidence, and both wind axes plus the diagonal.
// The reported difference is quadrature uncertainty, not interpolation or
// uncertainty in the assumed atmosphere, water index or reflection closure.
test('statistical sea resolution doubling across its declared numerical domain', () => {
    const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        import {createAtmosphere, createStatisticalSea, createSeaSkyTable, skyViewGeometry, sampleSkyElevationLUT, EARTH_RADIUS_M} from './tools/thermal/atmosphere.js';
        import {normalizeSettings} from './tools/thermal/thermalSchema.js';
        import {apparentTemperature} from './tools/thermal/radiometry.js';
        const atmosphere = createAtmosphere();
        let maximumK = 0, worst, cases = 0;
        for (const seaWindMps of [2, 3, 5, 7, 10]) for (const seaSkinTemperatureK of [288, 293, 297]) {
            const settings = normalizeSettings({seaWindMps, seaSkinTemperatureK});
            const production = createStatisticalSea(settings, atmosphere);
            const doubled = createStatisticalSea(settings, atmosphere, {count: 192, bins: 1025});
            for (const sensorAltitudeM of [21, 7620]) for (const incidenceDeg of [0, 54, 64, 75, 85, 89.99]) for (const azimuthRad of [0, Math.PI / 4, Math.PI / 2]) {
                const elevationRad = -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + sensorAltitudeM) * Math.sin(incidenceDeg * Math.PI / 180));
                const ray = {sensorAltitudeM, elevationRad, azimuthRad};
                const values = [production, doubled].map(sea => apparentTemperature(sea.evaluate(ray).photonRadiance, {quantity: 'photon'}));
                const errorK = Math.abs(values[0] - values[1]); cases++;
                if (errorK > maximumK) {maximumK = errorK; worst = {seaWindMps, seaSkinTemperatureK, sensorAltitudeM, incidenceDeg, azimuthRad, values};}
            }
        }
        const settings = normalizeSettings({sensorAltitudeM: 21, verticalFovDeg: .02, pathElevationDeg: -.15});
        const sea = createStatisticalSea(settings, atmosphere), view = skyViewGeometry(settings);
        const table = createSeaSkyTable(view, [1, 0, 0], settings, atmosphere, sea);
        const altitudeM = 21.01, moved = createSeaSkyTable(view, [1, 0, 0], {...settings, sensorAltitudeM: altitudeM}, atmosphere, sea);
        const elevationRad = -.0027, shift = -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + altitudeM)) - table.horizonRad;
        const row = table.rows[(table.rows.length - 1) / 2];
        const actual = sea.evaluate({sensorAltitudeM: altitudeM, elevationRad, azimuthRad: table.axisAzimuth}).photonRadiance;
        const estimate = sampleSkyElevationLUT(row, elevationRad - shift);
        const altitudeReuseErrorK = Math.abs(apparentTemperature(actual, {quantity: 'photon'}) - apparentTemperature(estimate, {quantity: 'photon'}));
        const vacuum = createAtmosphere({densityScale: 0}), vacuumSea = createStatisticalSea(settings, vacuum);
        const vacuumTable = createSeaSkyTable(view, [1, 0, 0], settings, vacuum, vacuumSea);
        console.log(JSON.stringify({cases, maximumK, worst, altitudeDomainReused: table === moved, altitudeReuseErrorK,
            vacuumToleranceMet: vacuumTable.interpolation.toleranceMet,
            vacuumReused: createSeaSkyTable(view, [1, 0, 0], settings, vacuum, vacuumSea) === vacuumTable}));
    `], {cwd: process.cwd(), encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024}));
    console.log('Calculated sea quadrature doubling:', report);
    expect(report.cases).toBe(540);
    expect(report.maximumK).toBeLessThan(.005);
    expect(report.altitudeDomainReused).toBe(true);
    expect(report.altitudeReuseErrorK).toBeLessThan(.005);
    expect(report.vacuumToleranceMet).toBe(true);
    expect(report.vacuumReused).toBe(true);
}, 250000);
