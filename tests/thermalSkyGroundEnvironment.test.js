import {MeshBasicMaterial, Vector3} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {createAtmosphere, ENVIRONMENT_NORMAL_SINES, hemisphereAzimuthWeight, reflectedEnvironmentTable, sourceRangeLUT} from "../tools/thermal/atmosphere.js";
import {apparentTemperature} from "../tools/thermal/radiometry.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";

test("the azimuth weight integrates to a unit cosine-weighted hemisphere at every normal elevation", () => {
    for (const degrees of [-90, -45, -30, 0, 30, 60, 90]) {
        const beta = degrees * Math.PI / 180, steps = 4000;
        let sum = 0;
        for (let i = 0; i < steps; i++) {
            const e = -Math.PI / 2 + (i + 0.5) * Math.PI / steps;
            sum += Math.cos(e) * hemisphereAzimuthWeight(e, beta) * Math.PI / steps / Math.PI;
        }
        expect(sum).toBeCloseTo(1, 5);
    }
    expect(hemisphereAzimuthWeight(0.3, 0)).toBeCloseTo(2 * Math.cos(0.3), 12);
});

test("a vertical wall at 265 m over 288 K land reflects about 282 K; facing down is warmer than facing up", () => {
    const atmosphere = createAtmosphere({surfaceTemperatureK: 288.15, surfaceWaterVaporDensityKgM3: 0.01, visibilityM: 23000});
    const rows = reflectedEnvironmentTable({altitudeM: 265, groundTemperatureK: 288.15}, atmosphere);
    const kelvin = row => apparentTemperature(row.reduce((a, b) => a + b, 0), {quantity: "photon", band: {minUm: 3, maxUm: 5}});
    expect(rows).toHaveLength(ENVIRONMENT_NORMAL_SINES.length);
    expect(kelvin(rows[2])).toBeCloseTo(281.9, 0);
    for (let i = 1; i < rows.length; i++) expect(kelvin(rows[i])).toBeLessThan(kelvin(rows[i - 1]));
});

test("sky and ground gives a reflecting surface five environment rows of r L(mu), without path radiance", () => {
    const renderer = {extensions: {has: () => true}};
    const pipeline = new ThermalPipeline(renderer, {analysis: false, synchronous: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(), textures: new Set()};
    const size = 8;
    pipeline.rangeLUT = {size, maxRangeM: 20000, transmission: Float32Array.from({length: size * 12}, (_, i) => Math.exp(-i / 200)),
        pathRadiance: new Float32Array(size * 12).fill(0.01)};
    const settings = normalizeSettings({environmentSource: "skyGround", solarScale: 0});
    const rows = ENVIRONMENT_NORMAL_SINES.map((_, k) => new Float64Array(12).fill((k + 1) * 1e20));
    pipeline._environmentTable = () => ({rows, key: "test"});
    try {
        const pass = pipeline._surface({temperatureK: 290, emissivity: 0.8, environmentAltitudeM: 250}, new MeshBasicMaterial(),
            settings, new Vector3(0, 0, 1));
        const texture = pass.uniforms.rangeTexture.value, rowLength = size * 4;
        expect(pass.uniforms.environmentRow.value).toBe(1);
        expect(texture.image.height).toBe(6);
        rows.forEach((bands, k) => {
            const expected = sourceRangeLUT(pipeline.rangeLUT, bands.map(value => 0.2 * value), 0);
            for (let sample = 0; sample < size; sample++)
                expect(texture.image.data[(k + 1) * rowLength + sample * 4]).toBeCloseTo(expected[sample], 4);
        });
        // A black surface reflects nothing, so it gets no environment rows.
        const black = pipeline._surface({temperatureK: 290, emissivity: 1, environmentAltitudeM: 250}, new MeshBasicMaterial(), settings, new Vector3(0, 0, 1));
        expect(black.uniforms.environmentRow.value).toBe(0);
        expect(black.uniforms.rangeTexture.value.image.height).toBe(1);
    } finally {pipeline.dispose();}
});

test("the environment table is cached across camera motion: its key is the atmosphere profile, not the frame geometry", () => {
    const pipeline = new ThermalPipeline({}, {analysis: false, synchronous: false});
    pipeline.atmosphere = createAtmosphere({});
    pipeline.profileKey = "profile-A";
    const settings = normalizeSettings({environmentSource: "skyGround"});
    try {
        pipeline.atmosphereKey = "frame-1";
        const first = pipeline._environmentTable(250, settings);
        pipeline.atmosphereKey = "frame-2";
        expect(pipeline._environmentTable(250, settings).rows).toBe(first.rows);
        pipeline.profileKey = "profile-B";
        expect(pipeline._environmentTable(250, settings).rows).not.toBe(first.rows);
    } finally {pipeline.dispose();}
});

test("without a host the local up is world +Y in camera space, so a pitched camera sees it tilted", async () => {
    const {PerspectiveCamera, Scene, Vector4} = await import("three");
    const pipeline = new ThermalPipeline({extensions: {has: () => true}}, {analysis: false, synchronous: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(), textures: new Set()};
    pipeline.rangeLUT = {size: 2, maxRangeM: 1000, transmission: new Float32Array(24).fill(1), pathRadiance: new Float32Array(24)};
    pipeline._drawRadiance = () => {};
    const camera = new PerspectiveCamera(10, 1, 1, 1000);
    camera.rotation.x = -Math.PI / 3; camera.updateMatrixWorld(true);   // looking 60 degrees down
    try {
        pipeline._radiance(new Scene(), camera, normalizeSettings({}), {width: 8, height: 8, viewport: new Vector4()}, 0);
        expect(pipeline.upView.y).toBeCloseTo(Math.cos(Math.PI / 3), 9);
        expect(pipeline.upView.z).toBeCloseTo(Math.sin(Math.PI / 3), 9);   // toward the viewer when looking down
    } finally {pipeline.dispose();}
});
