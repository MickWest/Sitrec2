// Sky and background: the clear-sky elevation table, ray elevation, the pipeline's background and its cache,
// the sea below the horizon, and the atmospheric profile.
import {Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, Vector3} from "three";
import {backgroundAtElevation, clearSky, createAtmosphere, createSkyElevationLUT, EARTH_RADIUS_M, sampleSkyElevationLUT,
    seaBackground, skyElevationRange, skyRayDirection, skyRayElevation, skyViewGeometry} from "../tools/thermal/atmosphere.js";
import {atmosphereFromSounding, parseSoundingCSV} from "../tools/thermal/sounding.js";
import {SOUNDING_CSV} from "../tools/thermal/validationFixtures.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {inBandRadiance, PHOTON_SCALE} from "../tools/thermal/radiometry.js";
import {sum} from "../tools/thermal/sensorMath.js";
import {skyGradientReference} from "../tools/thermal/selfTest.js";

const rad = degrees => degrees * Math.PI / 180;
const metadata = {stationId: "CIM00085586", stationElevationM: 77};
const sounding = () => parseSoundingCSV(SOUNDING_CSV, metadata);
const band = {minUm: 3, maxUm: 5};
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
// No noise, shading, fixed pattern, dark current, pedestal or blur.
const quiet = extra => normalizeSettings({noiseEnabled: false, shadingK: 0, fixedPatternFraction: 0,
    darkElectronsPerS: 0, adcOffsetCounts: 0, systemBlurRmsUrad: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, turbulenceR0M: 0, ...extra});
const cpuPipeline = () => {
    const pipeline = new ThermalPipeline(null, {analysis: true});
    pipeline.resources = {surfaces: new Map(), textures: new Set()};
    return pipeline;
};

test("clear-sky elevation table decreases, contains the axis, and reports interpolation error", () => {
    const reference = skyGradientReference(), {table, atmosphere, settings} = reference;
    const options = {sensorAltitudeM: settings.sensorAltitudeM, temperatureK: settings.surfaceTemperatureK};
    for (let i = 1; i < table.sampleCount; i++) expect(table.photonRadiances[i]).toBeLessThanOrEqual(table.photonRadiances[i - 1]);
    const axis = backgroundAtElevation(rad(settings.pathElevationDeg), options, atmosphere).photonRadiance;
    close(sampleSkyElevationLUT(table, rad(settings.pathElevationDeg)) / axis, 1, 1e-12);
    expect(table.sampleCount).toBeGreaterThanOrEqual(65);
    expect(table.sampleCount).toBeLessThanOrEqual(2049);
    let error = 0;
    // Independent quarter-point probes, rather than rechecking adaptive midpoints.
    for (let i = 1; i < table.sampleCount; i++) {
        const e = 0.75 * table.elevations[i - 1] + 0.25 * table.elevations[i];
        const direct = backgroundAtElevation(e, options, atmosphere).photonRadiance;
        error = Math.max(error, Math.abs(sampleSkyElevationLUT(table, e) / direct - 1));
    }
    expect(table.interpolation.toleranceMet).toBe(true);
    expect(error).toBeLessThan(2e-5);
    console.log(`Sky elevation LUT: ${table.sampleCount} samples; midpoint relative error ${table.interpolation.maxRelativeError.toExponential(3)}; independent quarter-point error ${error.toExponential(3)}`);
});

test("wide table covers the diagonal, keeps the sea below the depressed horizon and never blends the branches", () => {
    const settings = normalizeSettings({verticalFovDeg: 20, apertureM: .005, sensorAltitudeM: 1382, pathElevationDeg: 0});
    const view = skyViewGeometry(settings), atmosphere = createAtmosphere();
    const options = {sensorAltitudeM: settings.sensorAltitudeM, temperatureK: 288.15};
    const table = createSkyElevationLUT({view, ...options}, atmosphere);
    close(table.horizonRad, -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + 1382)), 1e-15);
    for (const degrees of [-10, -3, -0.5, 2, 10]) {
        const direct = backgroundAtElevation(rad(degrees), options, atmosphere);
        expect(direct.kind).toBe(degrees < table.horizonRad * 180 / Math.PI ? "sea" : "sky");
        close(sampleSkyElevationLUT(table, rad(degrees)) / direct.photonRadiance, 1, 8e-5);
    }
    expect(table.elevations.filter(e => e === table.horizonRad)).toHaveLength(2);
    for (let y = -1; y <= 1; y += 0.25) for (let x = -1; x <= 1; x += 0.25) {
        const e = skyRayElevation(x, y, view);
        expect(e).toBeGreaterThan(table.minRad); expect(e).toBeLessThan(table.maxRad);
    }
    console.log(`Wide sky/sea LUT: ${table.sampleCount} samples; midpoint relative error ${table.interpolation.maxRelativeError.toExponential(3)}`);
});

test("ray elevation uses image vertical by default and camera-space local up when supplied", () => {
    const settings = normalizeSettings({verticalFovDeg: 20, apertureM: .005, pathElevationDeg: 30});
    const view = skyViewGeometry(settings), e = rad(30);
    close(skyRayElevation(0, 0, view), e, 1e-15);
    close(skyRayElevation(0, 1, view), e + rad(10), 1e-15);
    close(skyRayElevation(0, -1, view), e - rad(10), 1e-15);
    // Finite horizontal off-axis elevation is not center elevation plus y*FOV.
    close(skyRayElevation(1, 0, view), Math.asin(Math.sin(e) / Math.hypot(1, view.aspect * view.tanHalfY)), 1e-15);
    const rolled = skyViewGeometry(settings, new Vector3(Math.cos(e), 0, -Math.sin(e)).multiplyScalar(7));
    close(skyRayElevation(0, 0, rolled), e, 1e-15);
    expect(skyRayElevation(1, 0, rolled)).toBeGreaterThan(e);
    close(skyRayElevation(0, 1, rolled), skyRayElevation(0, -1, rolled), 1e-15);
    const otherElevation = skyViewGeometry(settings, [0, 1, 0]);
    expect(skyRayElevation(0, 0, otherElevation)).toBe(0);
    expect(() => skyViewGeometry(settings, [0, 0, 0])).toThrow(/skyUp/);
    const nearZenith = skyViewGeometry({...settings, pathElevationDeg: 89});
    expect(skyElevationRange(nearZenith).maxRad).toBe(Math.PI / 2);
});

test("inverse projection handles a coverage tile and orthographic directions", () => {
    const settings = normalizeSettings({verticalFovDeg: 5});
    const camera = new PerspectiveCamera(settings.verticalFovDeg, settings.detectorWidth / settings.detectorHeight);
    const plain = skyViewGeometry(settings), projected = skyViewGeometry(settings, null, camera);
    for (const [x, y] of [[-1, -1], [0, 0], [0.4, 0.7]]) {
        const direction = new Vector3(x, y, 0).unproject(camera).normalize().toArray();
        skyRayDirection(x, y, projected).forEach((value, i) => close(value, direction[i], 1e-14));
        close(skyRayElevation(x, y, plain), skyRayElevation(x, y, projected), 1e-14);
    }
    camera.setViewOffset(640, 512, 320, 0, 320, 256);
    const tile = skyViewGeometry(settings, null, camera);
    close(skyRayElevation(0, 0, tile), skyRayElevation(0.5, 0.5, plain), 1e-14);
    const ortho = skyViewGeometry(settings, null, new OrthographicCamera());
    close(skyRayElevation(-1, 1, ortho), skyRayElevation(1, -1, ortho), 0);
});

test("background cache keys track atmosphere content, field, band and sky direction; uniform mode is retained", () => {
    const pipeline = cpuPipeline();
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: 2.23});
    const prepare = (s, sounding = null, up = null) => {
        pipeline._prepareAtmosphere(s, sounding);
        pipeline._prepareSkyBackground(s, skyViewGeometry(s, up));
    };
    prepare(settings);
    const first = pipeline.skyTable;
    expect(pipeline.frameBackground).toMatchObject({gradient: true, sampleCount: first.sampleCount});
    expect(pipeline.frameBackground.elevationRangeDeg[0]).toBeLessThan(2.23);
    expect(pipeline.frameBackground.photonRadianceRange[0]).toBeLessThan(pipeline.frameBackground.photonRadianceRange[1]);
    prepare({...settings, digitalZoom: 2}); expect(pipeline.skyTable).toBe(first);
    const elevation = rad(settings.pathElevationDeg);
    prepare(settings, null, [Math.cos(elevation), 0, -Math.sin(elevation)]);
    expect(pipeline.skyTable).toBe(first); // pure roll keeps the enclosing elevation interval
    prepare(settings, null, [0, Math.cos(rad(5)), -Math.sin(rad(5))]);
    expect(pipeline.skyTable).not.toBe(first);
    const pointed = pipeline.skyTable;
    prepare({...settings, pathElevationDeg: 7}); expect(pipeline.skyTable).not.toBe(pointed);
    prepare({...settings, verticalFovDeg: 2}); expect(pipeline.skyTable).not.toBe(first);
    prepare({...settings, bandMinUm: 3.7}); expect(pipeline.skyTable).not.toBe(first);
    prepare({...settings, skyGradient: false});
    expect(pipeline.frameBackground).toMatchObject({gradient: false, sampleCount: 1});
    expect(pipeline.frameBackground.photonRadianceRange).toEqual([pipeline.background.photonRadiance, pipeline.background.photonRadiance]);
    prepare({...settings, skySource: "manual"}); expect(pipeline.frameBackground.gradient).toBe(false);
    const csv = `level_type,pressure_Pa,geopotential_height_m,temperature_C,relative_humidity_pct,dewpoint_depression_C,wind_dir_deg,wind_speed_m_s
10,100000,0,15,50,,,
10,70000,3000,-5,20,,,`;
    const profile = parseSoundingCSV(csv); // estimated two-level test sounding
    prepare(settings, profile);
    const measured = pipeline.skyTable;
    expect(measured).not.toBe(first);
    const direct = backgroundAtElevation(rad(2.23), {sensorAltitudeM: 1382}, atmosphereFromSounding(profile).atmosphere);
    close(sampleSkyElevationLUT(measured, rad(2.23)) / direct.photonRadiance, 1, 1e-12);
    prepare(settings, parseSoundingCSV(csv)); expect(pipeline.skyTable).toBe(measured);
    prepare(settings, parseSoundingCSV(csv.replace(",15,50", ",16,50"))); expect(pipeline.skyTable).not.toBe(measured);
    for (const texture of pipeline.resources.textures) texture.dispose();
});

test("CPU side of the per-pixel sky browser check executes in Jest", () => {
    const e = rad(2.23);
    for (const up of [null, [Math.cos(e), 0, -Math.sin(e)]]) {
        const reference = skyGradientReference(up);
        expect(reference.values).toHaveLength(5);
        reference.pixels.forEach(([x, y], i) => {
            const elevationRad = skyRayElevation(2 * (x + 0.5) / reference.width - 1, 2 * (y + 0.5) / reference.height - 1, reference.view);
            const direct = backgroundAtElevation(elevationRad, {sensorAltitudeM: 1382}, reference.atmosphere);
            close(reference.values[i] * PHOTON_SCALE / direct.photonRadiance, 1, 2e-5);
        });
    }
});

test.each([false, true])("pipeline sky equals CPU clearSky, measured=%s; cache uses content", measured => {
    const pipeline = cpuPipeline(), profile = measured ? sounding() : null;
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: 2.23, atmosphereMaxRangeM: 125000});
    pipeline._prepareAtmosphere(settings, profile);
    const atmosphere = measured ? atmosphereFromSounding(profile).atmosphere : createAtmosphere();
    const sky = clearSky({sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180}, atmosphere,
        {segments: 96, quantity: "photon", band});
    close(pipeline.background.photonRadiance, sum(sky.radiance), sum(sky.radiance) * 1e-12);
    expect(pipeline.atmosphereProfile.source).toBe(measured ? "sounding" : "standard");
    const table = pipeline.rangeLUT, background = pipeline.background;
    pipeline._prepareAtmosphere({...settings, ambientTemperatureK: 250}, measured ? sounding() : null);
    expect(pipeline.rangeLUT).toBe(table); expect(pipeline.background).toBe(background);
    if (measured) {
        pipeline._prepareAtmosphere({...settings, surfaceTemperatureK: 310, waterVaporDensityKgM3: 0}, sounding());
        expect(pipeline.rangeLUT).toBe(table);
        expect(pipeline.background).toBe(background);
        close(pipeline.background.photonRadiance, background.photonRadiance, 0);
        const changed = parseSoundingCSV(SOUNDING_CSV.replace("10,85000,1510,10.2", "10,85000,1510,11.2"), metadata);
        pipeline._prepareAtmosphere(settings, changed);
        expect(pipeline.rangeLUT).not.toBe(table);
        expect(pipeline.background.photonRadiance).not.toBe(background.photonRadiance);
    }
    pipeline._prepareAtmosphere({...settings, visibilityM: 10000}, profile);
    expect(pipeline.rangeLUT).not.toBe(table);
    expect(pipeline.background.photonRadiance).not.toBe(background.photonRadiance);
    pipeline._prepareAtmosphere({...settings, skySource: "manual", skyTemperatureK: 240}, profile);
    close(pipeline.background.scaledPhotonRadiance, inBandRadiance(240).photon / PHOTON_SCALE, 1e-14);
    pipeline._prepareAtmosphere({...settings, bandMinUm: 3.7}, profile);
    const narrowSky = clearSky({sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180}, atmosphere,
        {segments: 96, quantity: "photon", band: {minUm: 3.7, maxUm: 5}});
    close(pipeline.background.photonRadiance, sum(narrowSky.radiance), sum(narrowSky.radiance) * 1e-12);
});

test("surface center ray uses selected-band photon sea radiance and bounds the range table", () => {
    const pipeline = cpuPipeline();
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: -30, bandMinUm: 3.7, surfaceTemperatureK: 294});
    pipeline._prepareAtmosphere(settings, sounding());
    const geometry = {sensorAltitudeM: 1382, elevationRad: -Math.PI / 6};
    const atmosphere = atmosphereFromSounding(sounding()).atmosphere;
    const sea = seaBackground({...geometry, temperatureK: 294}, atmosphere,
        {quantity: "photon", band: {minUm: 3.7, maxUm: 5}, segments: 96});
    expect(pipeline.background).toMatchObject({kind: "sea", status: "estimated"});
    close(pipeline.background.photonRadiance, sum(sea.radiance), sum(sea.radiance) * 1e-12);
    close(pipeline.rangeLUT.maxRangeM, clearSky(geometry, atmosphere).distanceM, 1e-9);
    // Independent vacuum emission check catches energy/photon or full-band mixing.
    const vacuum = createAtmosphere({densityScale: 0});
    const direct = seaBackground(geometry, vacuum, {quantity: "photon", band: {minUm: 3.7, maxUm: 5}});
    close(sum(direct.radiance) / ((1 - direct.meanReflectance) * inBandRadiance(290, {minUm: 3.7, maxUm: 5}).photon), 1, 1e-12);
    pipeline._prepareAtmosphere({...settings, sensorAltitudeM: 0, atmosphereEnabled: false});
    expect(pipeline.rangeLUT.maxRangeM).toBe(0);
    expect(pipeline.background.photonRadiance).toBeGreaterThan(0);
});

test("surface air drives the atmospheric profile independently of object ambient air", () => {
    const standard = createAtmosphere(), warmer = createAtmosphere({surfaceTemperatureK: 300});
    close(standard.sample(0).temperatureK, 288.15, 1e-12);
    close(standard.sample(1382).temperatureK, 288.15 - 0.0065 * 1382, 1e-12);
    close(warmer.sample(1382).temperatureK, 300 - 0.0065 * 1382, 1e-12);
    expect(warmer.sample(1382).pressurePa).toBeGreaterThan(standard.sample(1382).pressurePa);
    const pipeline = new ThermalPipeline(null, {analysis: true});
    pipeline.resources = {surfaces: new Map()};
    const settings = quiet({surfaceTemperatureK: 300, ambientTemperatureK: 240, atmosphereMaxRangeM: 1000});
    pipeline._prepareAtmosphere(settings);
    const table = pipeline.rangeLUT;
    pipeline._prepareAtmosphere({...settings, ambientTemperatureK: 280});
    expect(pipeline.rangeLUT).toBe(table);
    pipeline._prepareAtmosphere({...settings, surfaceTemperatureK: 288.15});
    expect(pipeline.rangeLUT).not.toBe(table);
    expect(pipeline.rangeLUT.pathRadiance).not.toEqual(table.pathRadiance);
    const scene = new Scene(), mesh = new Mesh(new PlaneGeometry(), new MeshBasicMaterial()); scene.add(mesh);
    expect(pipeline._attributes(mesh, scene, settings).temperatureK).toBe(240);
    mesh.geometry.dispose(); mesh.material.dispose();
});
