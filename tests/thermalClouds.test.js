// Clouds: gray absorbing sheets, their temperature, transfer, order, shader alpha, visibility and domains.
import {DataTexture, FloatType, RGBAFormat, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3, WebGLRenderTarget} from "three";
import {createAtmosphere, clearSky, evaluatePhotonPath, blackbodyBands} from "../tools/thermal/atmosphere.js";
import {apparentTemperature, inBandRadiance} from "../tools/thermal/radiometry.js";
import {parseSoundingCSV, atmosphereFromSounding} from "../tools/thermal/sounding.js";
import {SOUNDING_CSV} from "../tools/thermal/validationFixtures.js";
import {cloudOpacity, cloudTemperature, opaqueCloudRadiance, sortCloudSheets, cloudRadianceTable} from "../tools/thermal/atmosphere.js";
import {defaultSettings, normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {ThermalCloudPass} from "../tools/thermal/ThermalPipeline.js";
import {cloudFragment} from "../tools/thermal/shaders.js";
import {createCloudRadianceDomain, cloudSampleGeometry, thermalSeaDistance, EARTH_RADIUS_M, RADIUS_REUSE_M} from "../tools/thermal/atmosphere.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {thermalCloudSheets, createThermalSceneAdapter} from "../src/rendering/ThermalSceneAdapters";
import {registerTransparentCamera} from "../src/rendering/CloudSort";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000}, Sit: {lat: 0, lon: 0}, NodeMan: {}}));
jest.setTimeout(120000);
const band = {minUm: 3, maxUm: 5}, sum = a => a.reduce((s, x) => s + x, 0);
const kelvin = L => apparentTemperature(L, {quantity: "photon", band});
const close = (a, b, tolerance = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance);
// Estimated fixtures and numerical gates; not scene measurements.
const geometry = range => ({sensorAltitudeM: 1382, elevationRad: 1.84 * Math.PI / 180, slantRangeM: range});
const measured = atmosphereFromSounding(parseSoundingCSV(SOUNDING_CSV, {stationId: "CIM00085586", stationElevationM: 77})).atmosphere;

test("gray support mask has explicit column, calibrated opacity and coverage meanings", () => {
    for (const [m, alpha] of [[0, 0], [.1, .3690426555], [.5, .9], [1, .99]]) close(cloudOpacity(m), alpha, 1e-10);
    close(cloudOpacity(.5, Math.log(100), "coverage"), .495);
    close(cloudOpacity(.5, 20, "calibratedOpacity"), .5);
    expect(() => cloudOpacity(.5, 1, "rgb")).toThrow();
});

// Reuses the 96 bounded-layer checks across two profiles, two quadrature
// resolutions, four ranges and six columns from the explicit photon reference.
test.each([["sounding", measured], ["standard", createAtmosphere()]])("%s cloud limits, contrast and convergence", (name, atmosphere) => {
    const records = [];
    for (const segments of [512, 1024]) {
        const sky = sum(clearSky(geometry(0), atmosphere, {quantity: "photon", band, segments}).radiance);
        for (const range of [100000, 130000, 160000, 200000]) {
            const cloud = opaqueCloudRadiance(geometry(range), atmosphere, {band, segments});
            for (const q of [0, .1, 1, 3, Math.log(100), 20]) {
                const alpha = cloudOpacity(1, q), L = alpha * cloud.photonRadiance + (1 - alpha) * sky;
                expect(L).toBeGreaterThanOrEqual(Math.min(sky, cloud.photonRadiance) * (1 - 1e-14));
                expect(L).toBeLessThanOrEqual(Math.max(sky, cloud.photonRadiance) * (1 + 1e-14));
            }
            records.push({range, segments, contrast: kelvin(cloud.photonRadiance) - kelvin(sky)});
        }
    }
    const productionSky = kelvin(sum(clearSky(geometry(0), atmosphere, {quantity: "photon", band, segments: 96}).radiance));
    for (const r of records.filter(r => r.segments === 1024)) {
        close(r.contrast, records.find(c => c.range === r.range && c.segments === 512).contrast, .005);
        if (name === "sounding") {
            const expected = {100000: .880, 130000: .497, 160000: .241, 200000: .075}[r.range];
            close(r.contrast, expected, .03);
            close(kelvin(opaqueCloudRadiance(geometry(r.range), atmosphere, {band}).photonRadiance) - productionSky, expected, .03);
        }
    }
});

test("physical altitude honors inversions and sheet interpolation bounds", () => {
    const atmosphere = createAtmosphere({temperatureProfile: [{altitudeM: 0, temperatureK: 280}, {altitudeM: 1000, temperatureK: 290}, {altitudeM: 10000, temperatureK: 220}]});
    close(cloudTemperature(atmosphere, 500), 285);
    expect(cloudTemperature(atmosphere, 900)).toBeGreaterThan(cloudTemperature(atmosphere, 100));
    const sheet = {center: [0, 0, -100000], size: [1000, 500], temperatureK: 260};
    const table = cloudRadianceTable(sheet, measured, {sensorAltitudeM: 1382, up: [0, Math.cos(.032), -Math.sin(.032)], band});
    expect(table.toleranceMet).toBe(true); expect(table.evaluations).toBeGreaterThanOrEqual(9);
    expect([...table.data].every(Number.isFinite)).toBe(true);
});

test("global order interleaves layers with stable identities and reverses with camera", () => {
    const sheets = [{id: "a:0", center: [0, 0, -10], temperatureK: 270}, {id: "a:1", center: [0, 0, -30], temperatureK: 250},
        {id: "b:0", center: [0, 0, -20], temperatureK: 260}, {id: "b:1", center: [0, 0, -20], temperatureK: 265}];
    expect(sortCloudSheets(sheets).map(s => s.id)).toEqual(["a:1", "b:0", "b:1", "a:0"]);
    expect(sortCloudSheets(sheets.map(s => ({...s, center: s.center.map(v => -v)}))).map(s => s.temperatureK)).toEqual([270, 260, 265, 250]);
});

test("registered cloud sheets preserve canonical coordinates, masks, wind and physical temperature", () => {
    const camera = new PerspectiveCamera(20, 1, 1, 200000); camera.position.set(6372382, 0, 0); camera.updateMatrixWorld();
    const mesh = new Mesh(new PlaneGeometry(), new MeshBasicMaterial()), group = new Group(); group.add(mesh);
    group.position.set(6373000, 0, -10000); group.updateMatrixWorld(true);
    const node = {id: "bank", isThermalCloud: "grayAbsorbingSheet", cloudMesh: mesh, instanceOffsets: new Float32Array([0, 0, 0, 100, 0, -20]),
        instanceSizes: new Float32Array([100, 50, 200, 100]), cloudCount: 2, cloudTexture: {id: "alpha"}};
    const settings = defaultSettings(), atmosphere = createAtmosphere();
    const first = thermalCloudSheets([node], camera, settings, atmosphere).sheets;
    expect(first[0].mask).toBe(node.cloudTexture);
    close(first[1].temperatureK, atmosphere.sample(first[1].altitudeM).temperatureK);
    group.position.x += 50; group.updateMatrixWorld(true);
    const moved = thermalCloudSheets([node], camera, settings, atmosphere).sheets;
    close(moved[0].center[0] - first[0].center[0], 50);
    expect(moved[0].temperatureK).not.toBe(first[0].temperatureK);
    group.visible = false; expect(thermalCloudSheets([node], camera, settings, atmosphere).sheets).toHaveLength(0);
    group.visible = true; node.isThermalCloud = "unresolvedThermal";
    expect(thermalCloudSheets([node], camera, settings, atmosphere)).toEqual({sheets: [], diagnostics: [{id: "bank", code: "unresolvedThermal"}]});
    mesh.geometry.dispose(); mesh.material.dispose();
});

test.each(["success", "scene", "cloud"])("cloud callback isolation, cache cost and restoration on %s", failure => {
    const scene = new Scene(), camera = new PerspectiveCamera(1, 1, 1, 200000);
    camera.updateMatrixWorld();
    const visibleMaterial = new MeshBasicMaterial(), cloud = new Mesh(new PlaneGeometry(), visibleMaterial);
    scene.add(cloud);
    const lighting = jest.fn(() => {expect(cloud.material).toBe(visibleMaterial);});
    cloud.userData.prepareTransparentCamera = lighting; registerTransparentCamera(cloud);
    const renderer = {extensions: {has: () => true}, clear: jest.fn(), setRenderTarget: jest.fn(), setScissorTest: jest.fn(),
        render(object, cam) {
            if (object.isScene) {
                object.onBeforeRender(this, object, cam, null);
                if (failure === "scene") throw new Error("fixture scene");
            } else if (failure === "cloud") throw new Error("fixture cloud");
        }};
    const p = new ThermalPipeline(renderer), target = new WebGLRenderTarget(16, 16);
    p.resources = {surfaces: new Map()}; p._drawSky = () => {}; p._pass = () => {}; p._coverageTiles = () => [];
    p.atmosphere = createAtmosphere({densityScale: 0}); p.profileKey = "vacuum"; p.skyView = {up: [0, 1, 0]};
    const sheets = [{id: "a", center: [0, 0, -10000], size: [100, 50], temperatureK: 275, opticalDepth: 1, mask: {}}];
    p.radianceAdapter = {attributes: () => false, cloudSheets: () => ({sheets, diagnostics: []})};
    const settings = normalizeSettings({detectorWidth: 8, detectorHeight: 8, atmosphereEnabled: false});
    try {
        if (failure === "success") {
            p._radiance(scene, camera, settings, target, 0);
            expect(p.cloudPass.report.evaluations).toBeGreaterThan(0);
            const buildMs = p.cloudPass.report.prepareMs;
            p._radiance(scene, camera, settings, target, 0);
            expect(p.cloudPass.report.evaluations).toBe(0);
            expect(p.cloudPass.report.uploadedBytes).toBe(0);
            console.log(`Cloud CPU one-sheet preparation: dirty ${buildMs.toFixed(3)} ms, cached ${p.cloudPass.report.prepareMs.toFixed(3)} ms, sort ${p.cloudPass.report.sortMs.toFixed(3)} ms; GPU unmeasured`);
        } else expect(() => p._radiance(scene, camera, settings, target, 0)).toThrow(`fixture ${failure}`);
        expect(lighting).not.toHaveBeenCalled(); expect(cloud.visible).toBe(true); expect(cloud.material).toBe(visibleMaterial);
        scene.onBeforeRender(renderer, scene, camera, target); expect(lighting).toHaveBeenCalledTimes(1);
        expect(p.cloudPass.material.depthWrite).toBe(false);
    } finally {p.cloudPass?.dispose(); target.dispose(); cloud.geometry.dispose(); visibleMaterial.dispose();}
});

// Executes the alpha arithmetic from the actual production shader. This is a
// CPU arithmetic/dispatch gate; GPU rasterization is checked by the self-test.
const shaderAlpha = Function('mask', 'opticalDepth', 'semantics', 'exp',
    `return ${cloudFragment.match(/float alpha = ([^;]+);/)[1]};`);

test('production draw order and shader alpha compose unequal-temperature layers', () => {
    const atmosphere = createAtmosphere({densityScale: 0}), settings = normalizeSettings({sensorAltitudeM: 3000});
    const camera = new PerspectiveCamera(4, 1, 1, 100000); camera.updateMatrixWorld();
    let output;
    const renderer = {extensions: {has: () => true}, setRenderTarget() {}, setScissorTest() {},
        render(mesh) {
            const u = mesh.material.uniforms;
            const alpha = shaderAlpha(.5, u.opticalDepth.value, u.semantics.value, Math.exp);
            const source = u.radianceTexture.value.image.data[0] * 1e20;
            output = alpha * source + (1 - alpha) * output;
        }};
    const pass = new ThermalCloudPass({renderer, atmosphere, profileKey: 'vacuum', skyView: {up: [0, 1, 0]}});
    const target = new WebGLRenderTarget(4, 4);
    const near = {id: 'near', center: [0, 0, -1000], size: [100, 100], temperatureK: 280, temperaturePolicy: 'isothermal', opticalDepth: 1.2};
    const far = {...near, id: 'far', center: [0, 0, -2000], temperatureK: 310, opticalDepth: .7};
    try {
        pass.prepare([near, far], camera, settings);
        expect(pass.sheets.map(s => s.id)).toEqual(['far', 'near']);
        output = inBandRadiance(260, band).photon;
        let expected = output;
        for (const s of [far, near]) {
            const alpha = 1 - Math.exp(-.5 * s.opticalDepth);
            expected = alpha * inBandRadiance(s.temperatureK, band).photon + (1 - alpha) * expected;
        }
        pass.draw(camera, target);
        close(kelvin(output), kelvin(expected), .005);
        for (const semantics of [0, 1, 2]) for (const mask of [0, .1, .5, 1]) {
            close(shaderAlpha(mask, 1.2, semantics, Math.exp), semantics === 0 ? 1 - Math.exp(-1.2 * mask) : semantics === 1 ? mask : mask * (1 - Math.exp(-1.2)));
        }
    } finally {pass.dispose(); target.dispose();}
});

test('transparent support and sea-hidden sheets never integrate an occluded path', () => {
    const atmosphere = createAtmosphere(), settings = normalizeSettings({sensorAltitudeM: 21});
    const camera = new PerspectiveCamera(4, 1, 1, 100000); camera.updateMatrixWorld();
    const pass = new ThermalCloudPass({atmosphere, profileKey: 'horizon', skyView: {up: [0, 1, 0]}});
    const mask = new DataTexture(new Float32Array([1, 1, 1, 0, 1, 1, 1, 1]), 2, 1, RGBAFormat, FloatType);
    const sheet = {id: 'crossing', center: [0, 0, -20000], size: [1000, 500], opticalDepth: 20, mask};
    try {
        pass.prepare([{...sheet, opticalDepth: 0}], camera, settings);
        expect(pass.report.evaluations).toBe(0); expect(pass.report.visible).toBe(0);
        for (const opticalDepth of [.1, 20]) {
            pass.prepare([{...sheet, opticalDepth}], camera, settings);
            expect(pass.report.visible).toBe(1);
            expect(pass.sheets[0].table.table.toleranceMet).toBe(true);
            expect([...pass.sheets[0].table.table.data].every(Number.isFinite)).toBe(true);
        }
        expect(cloudSampleGeometry(sheet, 0, 0, {sensorAltitudeM: 21, up: [0, 1, 0]}).visible).toBe(false);
        expect(cloudSampleGeometry(sheet, 0, 1, {sensorAltitudeM: 21, up: [0, 1, 0]}).visible).toBe(true);
        pass.prepare([{...sheet, center: [0, -350, -20000]}], camera, settings);
        expect(pass.report.visible).toBe(0); expect(pass.report.evaluations).toBe(0);
        mask.image.data.fill(0);
        pass.prepare([sheet], camera, settings);
        expect(pass.report.visible).toBe(0); expect(pass.report.evaluations).toBe(0);
        // A nearer opaque surface clips the same CPU support used for transfer.
        const hidden = cloudRadianceTable(sheet, atmosphere, {sensorAltitudeM: 21, up: [0, 1, 0], band, firstHitM: () => 100});
        expect(hidden.empty).toBe(true); expect(hidden.evaluations).toBe(0);
    } finally {pass.dispose(); mask.dispose();}
});

const sampleSheetTable = (table, u, v) => {
    const n = table.size, x = Math.min(n - 2, Math.floor(u * (n - 1))), y = Math.min(n - 2, Math.floor(v * (n - 1)));
    const a = u * (n - 1) - x, b = v * (n - 1) - y, L = (x, y) => table.data[y * n + x] * 1e20;
    return (L(x, y) * (1 - a) + L(x + 1, y) * a) * (1 - b) + (L(x, y + 1) * (1 - a) + L(x + 1, y + 1) * a) * b;
};

test.each(['lapse', 'inversion'])('tall sheets sample local physical temperature: %s', profile => {
    const localTemperature = z => profile === 'lapse' ? 288.15 - .0065 * z : 250 + .01 * z;
    const atmosphere = profile === 'lapse' ? createAtmosphere() : createAtmosphere({temperatureProfile: [
        {altitudeM: 0, temperatureK: 250}, {altitudeM: 8000, temperatureK: 330}, {altitudeM: 80000, temperatureK: 200}]});
    const sheet = {center: [0, 0, -10000], size: [1000, 500], temperatureK: 280};
    const table = cloudRadianceTable(sheet, atmosphere, {sensorAltitudeM: 3000, up: [0, 1, 0], band});
    const fixed = cloudRadianceTable({...sheet, temperaturePolicy: 'isothermal'}, atmosphere, {sensorAltitudeM: 3000, up: [0, 1, 0], band});
    expect(table.toleranceMet).toBe(true);
    for (const v of [0, .17, .5, .81, 1]) {
        const y = (v - .5) * 500, range = Math.hypot(y, 10000);
        // Independent Cartesian endpoint altitude and analytic local profile.
        const altitudeM = Math.hypot(EARTH_RADIUS_M + 3000 + y, 10000) - EARTH_RADIUS_M;
        const g = {sensorAltitudeM: 3000, elevationRad: Math.atan2(y, 10000), slantRangeM: range};
        const path = evaluatePhotonPath(g, atmosphere, {band, segments: 96});
        const B = blackbodyBands(localTemperature(altitudeM), {band, quantity: 'photon'});
        const expected = sum(B.map((b, i) => b * path.transmission[i] + path.pathRadiance[i]));
        close(kelvin(sampleSheetTable(table, .5, v)), kelvin(expected), .005);
        const override = opaqueCloudRadiance(g, atmosphere, {temperatureK: 280, band});
        close(kelvin(sampleSheetTable(fixed, .5, v)), kelvin(override.photonRadiance), .005);
    }
    expect(Math.abs(kelvin(sampleSheetTable(table, .5, 0)) - kelvin(sampleSheetTable(table, .5, 1)))).toBeGreaterThan(1);
});

test('moving sheets reuse a validated profile/band domain instead of freezing a pose', () => {
    const atmosphere = createAtmosphere(), domain = createCloudRadianceDomain(atmosphere, band);
    const ray = {sensorAltitudeM: 3021, slantRangeM: 10050, elevationRad: .0123};
    domain.sample(ray); const before = domain.evaluations;
    for (let i = 0; i < 10; i++) {
        const moved = {...ray, sensorAltitudeM: ray.sensorAltitudeM + .1 * i, slantRangeM: ray.slantRangeM + i, elevationRad: ray.elevationRad + i * 1e-6};
        close(kelvin(domain.sample(moved)), kelvin(opaqueCloudRadiance(moved, atmosphere, {band}).photonRadiance), .001);
    }
    expect(domain.evaluations).toBe(before);
});

test('refracted samples reuse a domain built on their sphere; outside the radius span they are exact', () => {
    // Estimated fixture: a local radius 7.3 km below the mean sphere and a cirrus point 176 km away.
    const atmosphere = createAtmosphere(), radius = EARTH_RADIUS_M - 7300;
    const domain = createCloudRadianceDomain(atmosphere, band, {earthRadiusM: radius});
    const ray = {sensorAltitudeM: 1382, slantRangeM: 176000, elevationRad: .0376, visibilityResolved: true, earthRadiusM: radius};
    domain.sample(ray); const before = domain.evaluations;
    for (let i = 0; i < 10; i++) {
        // A moving camera: its local radius drifts within the reuse span.
        const moved = {...ray, sensorAltitudeM: ray.sensorAltitudeM + .1 * i, slantRangeM: ray.slantRangeM + i,
            elevationRad: ray.elevationRad + i * 1e-6, earthRadiusM: radius + 9 * i};
        close(kelvin(domain.sample(moved)), kelvin(opaqueCloudRadiance(moved, atmosphere, {band}).photonRadiance), .001);
    }
    expect(domain.evaluations).toBe(before);
    const far = {...ray, earthRadiusM: radius + 2 * RADIUS_REUSE_M};
    expect(domain.sample(far)).toBe(opaqueCloudRadiance(far, atmosphere, {band}).photonRadiance);
    expect(domain.evaluations).toBe(before + 1);
});

test('thermal horizon and cloud projection share refraction independently of ocean mesh coverage', () => {
    const camera = new PerspectiveCamera(4, 1, 1, 100000); camera.position.set(0, EARTH_RADIUS_M + 21, 0); camera.updateMatrixWorld();
    const settings = normalizeSettings({sensorAltitudeM: 21, seaMode: 'statistical'}), atmosphere = createAtmosphere();
    const horizon = -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + 21));
    for (const enabled of [false, true]) for (const coverage of [[], [new Mesh(), new Mesh()]]) {
        const adapter = createThermalSceneAdapter([], coverage, camera, {enabled, k: .13, equatorRadius: EARTH_RADIUS_M, polarRadius: EARTH_RADIUS_M});
        const point = new Vector3(0, -100, -20000), before = point.clone(); adapter.projectPoint(point);
        expect(point.y >= before.y).toBe(true);
        expect(point.y > before.y).toBe(enabled); expect(adapter.geometryMode).toBe('terrestrialProjection');
        const mapping = adapter.rayGeometry(settings), boundary = mapping?.horizonRad ?? horizon;
        for (const delta of [-1e-7, 1e-7]) {
            const e = boundary + delta, hit = mapping ? mapping.sea(e)?.apparentDistanceM ?? Infinity : thermalSeaDistance(21, Math.sin(e));
            expect(Number.isFinite(hit)).toBe(delta < 0);
            expect((mapping?.ray(e, atmosphere.options.topAltitudeM) ?? clearSky({sensorAltitudeM: 21, elevationRad: e}, atmosphere)).kind).toBe(delta < 0 ? 'surface' : 'sky');
        }
        if (coverage.length) expect(adapter.attributes(coverage[1], settings)).toEqual({sea: true});
        coverage.forEach(mesh => {mesh.geometry.dispose(); mesh.material.dispose();});
    }
});
