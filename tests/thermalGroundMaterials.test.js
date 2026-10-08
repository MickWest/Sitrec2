import {BoxGeometry, DataTexture, Mesh, MeshBasicMaterial, Vector3} from "three";
import {GROUND_CLASSES, groundClassOffset, groundClimateFromSurface, resolveGroundClasses, surfaceHumidity} from "../tools/thermal/groundMaterials.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {createAtmosphere, ENVIRONMENT_NORMAL_SINES} from "../tools/thermal/atmosphere.js";
import {inBandRadiance, PHOTON_SCALE} from "../tools/thermal/radiometry.js";
import {hoursSinceSunset} from "../src/rendering/ThermalViewAdapter";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245}, Sit: {},
    NodeMan: {get: () => undefined, iterate() {}}, FileManager: {iterate() {}}}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));

const byId = Object.fromEntries(GROUND_CLASSES.map(groundClass => [groundClass.id, groundClass]));
const evening = {climate: "humid", sunElevationDeg: -15, hoursSinceSunset: 2, cloudFraction: 0, windMps: 2};

test("The time law reproduces the research table's anchors", () => {
    // Calculated from the published forms: humid evening, 2 h after sunset, clear, 2 m/s (table: -1.5, -2.5, +4).
    expect(groundClassOffset(byId.grass, evening)).toBeCloseTo(-3 * 0.7 * 12.6 / 18.3, 10);
    expect(groundClassOffset(byId.roof, evening)).toBeCloseTo(-5 * 0.7 * 12.6 / 18.3, 10);
    expect(groundClassOffset(byId.asphalt, evening)).toBeCloseTo(15 * 0.4 * Math.exp(-2 / 11), 10);
    // Clear midday at 70 degrees and 2 m/s is the reference itself; full overcast leaves 25% of it.
    const day = {climate: "dry", sunElevationDeg: 70, hoursSinceSunset: 18, cloudFraction: 0, windMps: 2};
    expect(groundClassOffset(byId.asphalt, day)).toBeCloseTo(25, 10);
    expect(groundClassOffset(byId.grass, {...day, climate: "humid", cloudFraction: 1})).toBeCloseTo(0.25, 10);
    // An overcast night leaves 16% of the deficit, and wind reduces it.
    expect(groundClassOffset(byId.grass, {...evening, cloudFraction: 1})).toBeCloseTo(-3 * 0.7 * 0.16 * 12.6 / 18.3, 10);
    expect(Math.abs(groundClassOffset(byId.grass, {...evening, windMps: 6}))).toBeLessThan(Math.abs(groundClassOffset(byId.grass, evening)));
});

test("Every class is continuous at sunrise; heavy surfaces change little at sunset", () => {
    for (const id of GROUND_CLASSES.map(groundClass => groundClass.id)) {
        const beforeSunrise = groundClassOffset(byId[id], {...evening, sunElevationDeg: -0.01, laggedSunElevationDeg: -15, hoursSinceSunset: 12});
        const afterSunrise = groundClassOffset(byId[id], {...evening, sunElevationDeg: 0.01, laggedSunElevationDeg: -14, hoursSinceSunset: 12});
        expect(Math.abs(afterSunrise - beforeSunrise)).toBeLessThan(0.01);
        // The Sun 1.5 h before sunset is about 20 degrees up in the tropics.
        const beforeSunset = groundClassOffset(byId[id], {...evening, sunElevationDeg: 0.01, laggedSunElevationDeg: 20, hoursSinceSunset: 23.9});
        const afterSunset = groundClassOffset(byId[id], {...evening, sunElevationDeg: -0.01, hoursSinceSunset: 0});
        expect(Math.abs(afterSunset - beforeSunset)).toBeLessThan(byId[id].stored > 0 ? 1.5 : 0.01);
    }
});

test("The climate follows the surface humidity of the profile", () => {
    // 26 C with a 21 C dew point (0.0180 kg/m3) is warm humid air.
    expect(surfaceHumidity({temperatureK: 299.15, waterVaporDensityKgM3: 0.0180}).dewPointK).toBeCloseTo(294.15, 0);
    expect(groundClimateFromSurface({temperatureK: 299.15, waterVaporDensityKgM3: 0.0180})).toBe("humid");
    expect(groundClimateFromSurface({temperatureK: 308, waterVaporDensityKgM3: 0.004})).toBe("dry");
    expect(groundClimateFromSurface({temperatureK: 288.15, waterVaporDensityKgM3: 0.008})).toBe("temperate");
});

test("Manual conditions are the table's states; classes keep the shader row order", () => {
    const surface = {temperatureK: 299.15, waterVaporDensityKgM3: 0.018};
    const resolved = resolveGroundClasses({groundCondition: "evening", groundClimate: "automatic", groundWindMps: 2}, {surface});
    expect(resolved.classes.map(c => c.id)).toEqual(["grass", "trees", "asphalt", "concrete", "roof", "soil"]);
    expect(resolved.climate).toBe("humid");
    expect(resolved.airK).toBe(299.15);
    expect(resolved.classes[0].offsetK).toBeCloseTo(groundClassOffset(byId.grass, evening), 10);
    const automatic = resolveGroundClasses({groundCondition: "automatic", groundClimate: "dry", groundCloudFraction: 0.5, groundWindMps: 3},
        {surface, sunElevationDeg: -20, laggedSunElevationDeg: -5, hoursSinceSunset: 3});
    expect(automatic.inputs).toMatchObject({climate: "dry", cloudFraction: 0.5, windMps: 3, hoursSinceSunset: 3});
});

function fixture(settings = {}) {
    const pipeline = new ThermalPipeline({}, {analysis: false, synchronous: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(), textures: new Set()};
    pipeline.rangeLUT = {size: 2, maxRangeM: 10000, transmission: new Float32Array(24).fill(1), pathRadiance: new Float32Array(24)};
    pipeline.atmosphere = createAtmosphere({surfaceTemperatureK: 299.15, surfaceWaterVaporDensityKgM3: 0.018});
    pipeline.profileKey = "test-profile";
    return {pipeline, settings: normalizeSettings({groundTemperatureMode: "materials", ...settings})};
}
const classes = resolveGroundClasses({groundCondition: "evening", groundClimate: "humid", groundWindMps: 2},
    {surface: {temperatureK: 299.15, waterVaporDensityKgM3: 0.018}}).classes;

test("Each class row is a gray body at the air temperature of its altitude plus the offset", () => {
    const f = fixture({environmentSource: "manual", environmentTemperatureK: 285, bandMinUm: 3, bandMaxUm: 5});
    try {
        const table = f.pipeline._terrainClassTable({terrainClasses: classes, terrainAltitudeM: 50}, f.settings);
        expect(table.spectra.length).toBe(6);
        const airK = f.pipeline.atmosphere.sample(50).temperatureK, band = {minUm: 3, maxUm: 5};
        const environment = inBandRadiance(285, band).photon;
        classes.forEach((c, row) => {
            const expected = (c.emissivity * inBandRadiance(airK + c.offsetK, band).photon + (1 - c.emissivity) * environment) / PHOTON_SCALE;
            expect(table.texture.image.data[row * 2 * 4] / expected).toBeCloseTo(1, 3);
        });
        // A different altitude is a different table (a colder air temperature); the same one is reused.
        expect(f.pipeline._terrainClassTable({terrainClasses: classes, terrainAltitudeM: 50}, f.settings)).toBe(table);
        expect(f.pipeline._terrainClassTable({terrainClasses: classes, terrainAltitudeM: 500}, f.settings).airK).toBeLessThan(table.airK);
    } finally {f.pipeline.dispose();}
});

test("With sky and ground, a class reflects the sky hemisphere above a level surface", () => {
    const f = fixture({environmentSource: "skyGround", bandMinUm: 3, bandMaxUm: 5});
    try {
        const table = f.pipeline._terrainClassTable({terrainClasses: classes, terrainAltitudeM: 0}, f.settings);
        const up = f.pipeline._environmentTable(0, f.settings).rows[ENVIRONMENT_NORMAL_SINES.length - 1];
        const sky = up.reduce((sum, value) => sum + value, 0);
        const roof = classes[4], airK = f.pipeline.atmosphere.sample(0).temperatureK;
        const expected = (roof.emissivity * inBandRadiance(airK + roof.offsetK, {minUm: 3, maxUm: 5}).photon + (1 - roof.emissivity) * sky) / PHOTON_SCALE;
        expect(table.texture.image.data[4 * 2 * 4] / expected).toBeCloseTo(1, 3);
    } finally {f.pipeline.dispose();}
});

test("Class terrain materials compile the class shader, one per table", () => {
    const f = fixture(), mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    mesh.material.map = new DataTexture(new Uint8Array([60, 120, 50, 255]), 1, 1);
    try {
        const attributes = {temperatureK: 288.15, emissivity: 1, terrainColor: true, terrainClasses: classes};
        const low = f.pipeline._surface({...attributes, terrainAltitudeM: 0}, mesh.material, f.settings, new Vector3(), mesh);
        const high = f.pipeline._surface({...attributes, terrainAltitudeM: 300}, mesh.material, f.settings, new Vector3(), mesh);
        expect(low.defines.MATERIAL_CLASSES).toBe("");
        expect(low.uniforms.temperatureSamples.value).toBe(6);
        expect(low).not.toBe(high);
        expect(low.uniforms.rangeTexture.value).not.toBe(high.uniforms.rangeTexture.value);
    } finally {f.pipeline.dispose(); mesh.geometry.dispose(); mesh.material.map.dispose(); mesh.material.dispose();}
});

test("Hours since sunset are found by day and by night", () => {
    // Synthetic Sun: up from 06:00 to 18:00 UTC, 60 degrees at noon; position on the equator.
    const elevation = (position, date) => 60 * Math.sin(2 * Math.PI * (date.getTime() / 3600000 - 6) / 24);
    const position = new Vector3(6378137, 0, 0);
    expect(hoursSinceSunset(position, new Date("2013-04-26T20:00:00Z"), elevation)).toBeCloseTo(2, 2);
    expect(hoursSinceSunset(position, new Date("2013-04-27T10:00:00Z"), elevation)).toBeCloseTo(16, 2);
    expect(hoursSinceSunset(position, new Date("2013-06-21T10:00:00Z"), () => -10)).toBe(Infinity);
});

test("Surfaces reflect the host's class-based ground instead of the uniform ground setting", () => {
    const f = fixture({environmentSource: "skyGround", groundTemperatureK: 288.15, groundEmissivity: 1, bandMinUm: 3, bandMaxUm: 5});
    try {
        const uniform = f.pipeline._environmentTable(50, f.settings);
        f.pipeline.radianceAdapter = {environmentGround: () => ({temperatureK: 300, emissivity: 0.95})};
        const classes = f.pipeline._environmentTable(50, f.settings);
        const sum = row => row.reduce((total, value) => total + value, 0);
        // A downward normal sees mostly ground: warmer ground, more reflected radiance; an upward normal sees only sky.
        expect(sum(classes.rows[0])).toBeGreaterThan(sum(uniform.rows[0]) * 1.1);
        expect(sum(classes.rows[ENVIRONMENT_NORMAL_SINES.length - 1])).toBeCloseTo(sum(uniform.rows[ENVIRONMENT_NORMAL_SINES.length - 1]), 12);
        expect(classes.key).not.toBe(uniform.key);
    } finally {f.pipeline.dispose();}
});

test("A mapped ground mask and 3D building walls compile into the class material", () => {
    const f = fixture(), mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    mesh.material.map = new DataTexture(new Uint8Array([60, 120, 50, 255]), 1, 1);
    const maskTexture = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    try {
        const attributes = {temperatureK: 288.15, emissivity: 1, terrainColor: true, terrainClasses: classes, terrainAltitudeM: 0};
        const plain = f.pipeline._surface(attributes, mesh.material, f.settings, new Vector3(), mesh);
        const mapped = f.pipeline._surface({...attributes, terrainMask: {texture: maskTexture, rect: [0.3, 0.4, 2048, 2048]}},
            mesh.material, f.settings, new Vector3(), mesh);
        const walls = f.pipeline._surface({...attributes, buildingSurfaces: true}, mesh.material, f.settings, new Vector3(), mesh);
        expect(plain.defines.GROUND_MASK).toBeUndefined();
        expect(mapped).not.toBe(plain);
        expect(mapped.defines.GROUND_MASK).toBe("");
        expect(mapped.uniforms.groundMask.value).toBe(maskTexture);
        expect(mapped.uniforms.groundMaskRect.value.toArray()).toEqual([0.3, 0.4, 2048, 2048]);
        expect(mapped.vertexShader).toContain("vWorldPosition = (modelMatrix");
        expect(walls.defines.BUILDING_SURFACES).toBe("");
    } finally {f.pipeline.dispose(); mesh.geometry.dispose(); mesh.material.map.dispose(); mesh.material.dispose(); maskTexture.dispose();}
});
