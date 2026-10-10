import {Mesh, PerspectiveCamera, Vector3, Scene, WebGLRenderTarget} from "three";
import {createThermalSceneAdapter, thermalCloudSheets, withThermalRefraction} from "../src/rendering/ThermalSceneAdapters";
import {createThermalViewAdapter} from "../src/rendering/ThermalViewAdapter";
import {liftWorldPoint, terrestrialLiftContext, terrestrialRefractionUniforms} from "../src/atmosphere/terrestrialRefraction";
import {backgroundAtElevation, createAtmosphere, createSkyElevationLUT, sampleSkyElevationLUT, cloudSampleGeometry,
    cloudRadianceTable, evaluatePhotonPath, EARTH_RADIUS_M, thermalSeaDistance, createSeaSkyTable, createStatisticalSea, skyViewGeometry,
    RADIUS_REUSE_M} from "../tools/thermal/atmosphere.js";
import {ThermalPipeline, cloudScreenBounds} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {createThermalDepthTable, createCloudRadianceDomain, blackbodyBands, brightnessErrorBound} from "../tools/thermal/atmosphere.js";
import {radianceVertex} from "../tools/thermal/shaders.js";
import {thermalRefractionHorizonFixture} from "../tools/thermal/selfTest.js";
import {apparentTemperature, PHOTON_SCALE} from "../tools/thermal/radiometry.js";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000},
    GlobalDateTimeNode: {dateNow: new Date("2014-11-11T16:55:00Z")},
    Sit: {lat: 0, lon: 0, fps: 30, terrestrialRefraction: true, terrestrialRefractionOverrideK: true, terrestrialRefractionK: .13,
        thermalEnvironment: {turbulenceMode: "manual"}}, NodeMan: {get: () => undefined, iterate() {}}}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.setTimeout(120000);
// Estimated synthetic conditions; distances m and angles rad. Expected values
// are calculated from independent projected surface points and physical chords.
const R = EARTH_RADIUS_M, h = 21;
function fixture(enabled = true, extra = {}) {
    const camera = new PerspectiveCamera(1, 1, 1, 300000);
    camera.position.set(0, R + h, 0); camera.updateMatrixWorld();
    const options = {enabled, k: .13, equatorRadius: R, polarRadius: R, ...extra};
    const adapter = createThermalSceneAdapter([], [], camera, options);
    const settings = normalizeSettings({sensorAltitudeM: h, seaMode: "statistical"});
    return {camera, options, adapter, settings, geometry: adapter.rayGeometry(settings)};
}
const apparentElevation = p => Math.atan2(p.y, Math.hypot(p.x, p.z));

test("range and sky domains are not keyed to the drifting Earth radius; caches reuse them within RADIUS_REUSE_M", () => {
    // The radius at the observer changes by centimeters per frame: a key holding it would change on every frame and
    // reuse no range or sky domain, and a rounded radius would force rebuilds at every step boundary.
    const ellipsoid = {enabled: true, k: .13, equatorRadius: 6378137, polarRadius: 6356752.314245};
    const at = position => {
        const camera = new PerspectiveCamera(1, 1, 1, 300000); camera.position.copy(position); camera.updateMatrixWorld();
        const geometry = createThermalSceneAdapter([], [], camera, ellipsoid).rayGeometry(normalizeSettings({sensorAltitudeM: 2500}));
        return {domainKey: geometry.domainKey, key: geometry.key, radius: geometry.earthRadiusM};
    };
    // About 1.3 km steps in latitude from 45°, where the radius changes fastest (a few meters per step).
    const samples = Array.from({length: 300}, (_, i) =>
        at(new Vector3(6378137 + 2500, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), -Math.PI / 4 - i * 2e-4)));
    expect(Math.abs(samples.at(-1).radius - samples[0].radius)).toBeGreaterThan(300);
    expect(new Set(samples.map(sample => sample.domainKey)).size).toBe(1);
    // The frame's own geometry identity still follows the radius, so the pipeline asks its caches again.
    expect(new Set(samples.map(sample => sample.key)).size).toBe(samples.length);
    expect(RADIUS_REUSE_M).toBe(100);
});

test("the thermal view enables the shared refraction uniforms throughout its draw", () => {
    const {camera} = fixture(), view = {renderer: {}, camera, cameraNode: {}};
    const adapter = createThermalViewAdapter(view), saved = terrestrialRefractionUniforms.uTerrK.value;
    const draw = jest.spyOn(adapter.pipeline, "render").mockImplementation(input => {
        expect(terrestrialRefractionUniforms.uTerrK.value).toBe(.13);
        expect(input.radianceAdapter.rayGeometry(input.settings)).not.toBeNull();
        throw Error("draw fixture");
    });
    try {
        expect(() => adapter.render(new Scene(), 0)).toThrow("draw fixture");
        expect(draw).toHaveBeenCalledTimes(1); expect(terrestrialRefractionUniforms.uTerrK.value).toBe(saved);
    } finally {adapter.dispose();}
});

test("projected surface limb and inverse first hit use the vertex lift, including the old tangent", () => {
    const {camera, options, geometry} = fixture();
    const context = terrestrialLiftContext(camera.position, options);
    const tangentAngle = Math.acos(R / (R + h));
    const point = new Vector3(0, R * Math.cos(tangentAngle), -R * Math.sin(tangentAngle));
    const projected = liftWorldPoint(context, point).sub(camera.position), e = apparentElevation(projected);
    expect(e).toBeCloseTo(-.002400898, 9);
    expect(geometry.sea(e)).not.toBeNull();
    expect(geometry.horizonRad).toBeGreaterThan(e);
    let maximum = -Infinity;
    for (let distance = 10000; distance <= 26000; distance += 1) {
        const physical = new Vector3(0, Math.sqrt(R * R - distance * distance), -distance);
        const displayed = liftWorldPoint(context, physical).sub(camera.position);
        maximum = Math.max(maximum, apparentElevation(displayed));
    }
    expect(Math.abs(maximum - geometry.horizonRad)).toBeLessThan(1e-10);
    for (const delta of [-.02, -.001, -1e-7, -1e-10, 1e-10, 1e-7]) {
        const elevation = geometry.horizonRad + delta, hit = geometry.sea(elevation);
        expect(!!hit).toBe(delta <= 0);
        if (!hit) continue;
        const physical = new Vector3(0, R + h + hit.physical[1], -hit.physical[0]);
        const displayed = liftWorldPoint(context, physical).sub(camera.position);
        expect(Math.abs(apparentElevation(displayed) - elevation)).toBeLessThan(1e-10);
        expect(Math.abs(physical.length() - R)).toBeLessThan(1e-8);
        expect(hit.slantRangeM).toBeCloseTo(physical.distanceTo(camera.position), 7);
    }
});

test("distant aircraft projection matches the visible shader geometry within a microradian", () => {
    const {camera, options, adapter, settings} = fixture(true);
    camera.position.y = R + 1382; camera.updateMatrixWorld();
    const thermal = createThermalSceneAdapter([], [], camera, options);
    const point = new Vector3(10, R + 7480, -125000);
    const expected = liftWorldPoint(terrestrialLiftContext(camera.position, options), point).sub(camera.position).normalize();
    const actual = thermal.projectPoint(point.clone().applyMatrix4(camera.matrixWorldInverse)).normalize();
    expect(Math.atan2(actual.clone().cross(expected).length(), actual.dot(expected))).toBeLessThan(1e-6);
    expect(expected.angleTo(point.clone().sub(camera.position))).toBeGreaterThan(.0005);
    const p = new ThermalPipeline({}); p.resources = {surfaces: new Map(), textures: new Set()};
    p.rangeLUT = {size: 2, maxRangeM: 200000, transmission: new Float32Array(24).fill(1), pathRadiance: new Float32Array(24)};
    p.radianceAdapter = adapter;
    const original = new Mesh().material;
    const material = p._surface({temperatureK: 300, emissivity: 1}, original, settings, new Vector3());
    const shader = {vertexShader: radianceVertex, uniforms: {}};
    material.onBeforeCompile(shader);
    expect(shader.vertexShader).toContain("gl_Position = applyTerrestrialRefraction_clip(mvPosition)");
    expect(shader.vertexShader).toContain("vViewPosition = mvPosition.xyz");
    expect(shader.uniforms.uTerrK).toBe(terrestrialRefractionUniforms.uTerrK);
    const saved = terrestrialRefractionUniforms.uTerrK.value;
    expect(() => withThermalRefraction(camera, options, () => {throw Error("draw");})).toThrow("draw");
    expect(terrestrialRefractionUniforms.uTerrK.value).toBe(saved);
    material.dispose(); original.dispose();
});

test("sky, sea angular lookup and depth use physical endpoints on the same displayed ray", () => {
    const {geometry} = fixture(), atmosphere = createAtmosphere();
    const received = [];
    const seaProvider = g => {received.push(g); return {kind: "sea", radiance: [1e19]};};
    const options = {sensorAltitudeM: h, rayGeometry: geometry, seaProvider};
    const table = createSkyElevationLUT({...options,
        elevationRange: {minRad: geometry.horizonRad - .001, maxRad: geometry.horizonRad + .001, centerRad: geometry.horizonRad}}, atmosphere);
    expect(table.elevations.filter(e => e === geometry.horizonRad)).toHaveLength(2);
    expect(backgroundAtElevation(geometry.horizonRad - 1e-7, options, atmosphere).kind).toBe("sea");
    const g = received.at(-1), hit = geometry.sea(geometry.horizonRad - 1e-7);
    expect(g.elevationRad).toBe(hit.elevationRad); expect(g.slantRangeM).toBe(hit.slantRangeM);
    expect(Math.abs(g.elevationRad - (geometry.horizonRad - 1e-7))).toBeGreaterThan(1e-4);
    const sky = geometry.ray(geometry.horizonRad + 1e-7, atmosphere.options.topAltitudeM);
    const path = evaluatePhotonPath(sky, atmosphere, {segments: 96});
    const expected = path.pathRadiance.reduce((a, b) => a + b, 0);
    expect(backgroundAtElevation(geometry.horizonRad + 1e-7, options, atmosphere).photonRadiance).toBe(expected);
    expect(sampleSkyElevationLUT(table, geometry.horizonRad - 1e-7)).toBe(1e19);
    expect(sampleSkyElevationLUT(table, geometry.horizonRad + 1e-7)).not.toBe(1e19);
    const depth = createThermalDepthTable(geometry, geometry.horizonRad - .01);
    expect(depth.sampleCount).toBeLessThan(4096);
    for (const delta of [1e-10, 1e-8, .0001, .001, .009]) {
        const q = Math.sqrt(delta), data = depth.data;
        let i = 0; while (i < depth.sampleCount - 2 && data[4 * (i + 1)] <= q) i++;
        const t = (q - data[4 * i]) / (data[4 * (i + 1)] - data[4 * i]);
        const distance = data[4 * i + 1] * (1 - t) + data[4 * (i + 1) + 1] * t;
        expect(Math.abs(distance - geometry.sea(geometry.horizonRad - delta).apparentDistanceM)).toBeLessThan(.06);
    }
});

test("analytic radiance and sea depth ignore ocean coverage with refraction on and off", () => {
    for (const enabled of [false, true]) {
        const {camera, settings, options} = fixture(enabled);
        const seen = [];
        for (const count of [0, 1, 3]) {
            const scene = new Scene(), ocean = new Mesh(); scene.add(ocean);
            for (let i = 1; i < count; i++) ocean.add(new Mesh());
            const adapter = createThermalSceneAdapter([], [null, count ? ocean : null], camera, options);
            const pipeline = new ThermalPipeline({clear() {}, render() {}});
            pipeline.resources = {surfaces: new Map()}; pipeline.radianceAdapter = adapter;
            pipeline.rayGeometry = adapter.rayGeometry(settings); pipeline.skyView = {up: [0, 1, 0]};
            pipeline._drawSky = () => {}; pipeline._coverageTiles = () => [];
            pipeline._pass = (name, shader, uniforms) => {if (name === "seaDepth") seen.push(uniforms);};
            const target = new WebGLRenderTarget(8, 8);
            pipeline._radiance(scene, camera, settings, target, 0);
            expect(ocean.visible).toBe(true);
            target.dispose(); scene.traverse(o => {o.geometry?.dispose(); o.material?.dispose();});
        }
        expect(seen).toHaveLength(3);
        expect(seen.map(u => u.mappedSea)).toEqual([enabled, enabled, enabled]);
        expect(new Set(seen.map(u => u.apparentHorizon)).size).toBe(1);
    }
});

test("cloud anchors match visible lift; horizon crossing retains local physical samples", () => {
    const {camera, options, adapter, settings, geometry} = fixture();
    const mesh = new Mesh(); mesh.position.set(0, R + h, -20000); mesh.updateMatrixWorld();
    const node = {id: "sheet", mesh, cloudCount: 1, instanceOffsets: [0, 0, 0], instanceSizes: [1000, 500]};
    const atmosphere = createAtmosphere();
    const sheet = thermalCloudSheets([node], camera, settings, atmosphere, adapter.projectPoint).sheets[0];
    const expected = liftWorldPoint(terrestrialLiftContext(camera.position, options), mesh.position).sub(camera.position);
    expect(new Vector3(...sheet.apparentCenter).distanceTo(expected)).toBeLessThan(1e-8);
    expect(cloudScreenBounds(sheet, camera, 32, 32)).not.toBeNull();
    const sampleOptions = {sensorAltitudeM: h, up: [0, 1, 0], rayGeometry: geometry};
    expect(cloudSampleGeometry(sheet, .5, 0, sampleOptions).visible).toBe(false);
    expect(cloudSampleGeometry(sheet, .5, 1, sampleOptions).visible).toBe(true);
    const table = cloudRadianceTable(sheet, atmosphere, sampleOptions);
    expect(table.empty).not.toBe(true); expect(table.toleranceMet).toBe(true);
    expect([...table.data].every(Number.isFinite)).toBe(true);
    const top = cloudSampleGeometry(sheet, .5, 1, sampleOptions);
    expect(top.point).toEqual([0, 250, -20000]);
    expect(top.apparent[1] - top.point[1]).toBeCloseTo(expected.y, 8);
    mesh.geometry.dispose(); mesh.material.dispose();
});

test("inverse projection retains physical range and responds to every lift option", () => {
    const base = fixture();
    for (const changes of [{k: .2}, {maxBendRad: .001}, {maxLiftM: 1}, {scaleHeightM: 1000}]) {
        const other = fixture(true, changes);
        expect(other.geometry.key).not.toBe(base.geometry.key);
        expect(other.geometry.horizonRad).not.toBe(base.geometry.horizonRad);
    }
    const path = base.geometry.rangePath(.002, 125000);
    expect(path.slantRangeM).toBeCloseTo(125000, 7);
    const p = new Vector3(0, Math.sin(path.elevationRad) * path.slantRangeM, -Math.cos(path.elevationRad) * path.slantRangeM);
    expect(apparentElevation(base.adapter.projectPoint(p))).toBeCloseTo(.002, 10);
    expect(thermalSeaDistance(h, Math.sin(base.geometry.horizonRad))).toBe(Infinity);
});

test("browser horizon fixture uses the same lift and a curved physical ocean", () => {
    for (const enabled of [false, true]) {
        const f = thermalRefractionHorizonFixture(enabled), {adapter, geometry} = fixture(enabled);
        try {
            for (const distance of [2000, 16358, 17540, 42000]) for (const height of [-200, 0, 1000]) {
                const point = new Vector3(0, height, -distance), projected = adapter.projectPoint(point.clone());
                expect(f.lift(distance, height)).toBeCloseTo(projected.y - point.y, 9);
            }
            const expected = geometry?.horizonRad ?? -Math.acos(R / (R + h));
            expect(f.rayGeometry.horizonRad).toBeCloseTo(expected, 11);
            const positions = f.meshGeometry.attributes.position;
            for (let i = 0; i < positions.count; i += 300) {
                const radius = Math.hypot(positions.getX(i), R + h + positions.getY(i), positions.getZ(i));
                expect(Math.abs(radius - R)).toBeLessThan(.001);
            }
        } finally {f.meshGeometry.dispose();}
    }
});

test.each([false, true])("browser horizon hot sheet has finite radiance on visible support, refraction %s", enabled => {
    // Estimated synthetic inputs match the browser horizon cloud check: a 500 K
    // sheet 50000 m away, 200 m wide/high, viewed across a 0.08 degree field.
    const f = thermalRefractionHorizonFixture(enabled);
    try {
        const camera = new PerspectiveCamera(.08, 1, 1, 300000), horizon = f.rayGeometry.horizonRad;
        camera.lookAt(0, Math.sin(horizon), -Math.cos(horizon)); camera.updateMatrixWorld();
        const up = new Vector3(0, 1, 0).transformDirection(camera.matrixWorldInverse).toArray();
        const center = new Vector3(0, 0, -50000), world = center.clone().applyMatrix4(camera.matrixWorld);
        world.y += f.lift(Math.hypot(world.x, world.z), world.y);
        const sheet = {id: "horizon-sheet", center: center.toArray(),
            apparentCenter: world.applyMatrix4(camera.matrixWorldInverse).toArray(), size: [200, 200],
            temperatureK: 500, temperaturePolicy: "isothermal", opticalDepth: 20};
        const atmosphere = createAtmosphere({densityScale: 0}), band = {minUm: 3, maxUm: 5};
        const options = {sensorAltitudeM: h, up, rayGeometry: f.rayGeometry, band};
        expect(cloudSampleGeometry(sheet, .5, 0, options).visible).toBe(false);
        expect(cloudSampleGeometry(sheet, .5, 1, options).visible).toBe(true);
        const domain = createCloudRadianceDomain(atmosphere, band, {isothermal: true});
        const sampled = jest.spyOn(domain, "sample");
        for (const cache of [domain, undefined]) {
            const table = cloudRadianceTable(sheet, atmosphere, {...options, domain: cache});
            expect(table.empty).not.toBe(true);
            expect(table.toleranceMet).toBe(true);
            expect([...table.data].every(value => Number.isFinite(value) && value >= 0)).toBe(true);
            const expected = blackbodyBands(sheet.temperatureK, {quantity: "photon", band}).reduce((a, b) => a + b, 0) / PHOTON_SCALE;
            // Calculated vacuum transfer is constant; estimated relative gate
            // accounts for the radiance texture's single-precision storage.
            for (const value of table.data) expect(Math.abs(value / expected - 1)).toBeLessThan(1e-6);
        }
        // Every integrated sample must be in front of the displayed sea or on
        // its sky branch. Hidden texture nodes supply no atmospheric paths.
        expect(sampled).toHaveBeenCalled();
        for (const [g] of sampled.mock.calls) {
            expect(g.visible).toBe(true);
            const apparent = new Vector3(...g.apparent), range = apparent.length();
            const elevation = Math.asin(apparent.dot(new Vector3(...up)) / range);
            const sea = f.rayGeometry.sea(elevation);
            if (sea) expect(range).toBeLessThanOrEqual(sea.apparentDistanceM);
        }
        sampled.mockClear();
        const hidden = {...sheet, center: [0, -200, -50000],
            apparentCenter: sheet.apparentCenter.map((value, i) => value - (i === 1 ? 200 : 0))};
        expect(cloudRadianceTable(hidden, atmosphere, {...options, domain}).empty).toBe(true);
        expect(sampled).not.toHaveBeenCalled();
    } finally {f.meshGeometry.dispose();}
});

test.each([-1, NaN, Infinity, -Infinity])("brightness error rejects invalid cell minimum %s before inversion", minimum => {
    const band = {minUm: 3, maxUm: 5}, cell = "cloud sheet horizon-sheet, cell (0, 1)";
    for (const error of [0, 1]) {
        expect(() => brightnessErrorBound(error, minimum, band, .005, cell))
            .toThrow(`Invalid minimum radiance in ${cell}: ${minimum}; expected a finite value >= 0`);
    }
    expect(brightnessErrorBound(0, 0, band, .005, cell)).toBe(0);
    expect(brightnessErrorBound(1, 0, band, .005, cell)).toBe(Infinity);
});

test("invalid cloud table radiance identifies the sheet, interpolation cell and probe", () => {
    const sheet = {id: "invalid-source", center: [0, 0, -1000], size: [100, 100]};
    const options = {sensorAltitudeM: h, up: [0, 1, 0], domain: {sample: () => NaN}};
    expect(() => cloudRadianceTable(sheet, createAtmosphere(), options))
        .toThrow(/Invalid minimum radiance in cloud sheet invalid-source, cell \(0, 0\) in 2x2 grid, u=.+, v=.+, actual=NaN, interpolated=NaN/);
});

test("refracted sea caches validate height changes and invalidate different lift laws", () => {
    const {geometry, settings} = fixture(), atmosphere = createAtmosphere({densityScale: 0});
    const view = skyViewGeometry({...settings, verticalFovDeg: .05, pathElevationDeg: geometry.horizonRad * 180 / Math.PI});
    const sea = {evaluate: jest.fn(g => {
        const L = 1e19 * (1 + g.sensorAltitudeM * .0001 + .01 * Math.cos(g.elevationRad));
        return {kind: "sea", photonRadiance: L, radiance: [L]};
    })};
    const table = createSeaSkyTable(view, [1, 0, 0], settings, atmosphere, sea, geometry);
    expect(table.interpolation.toleranceMet).toBe(true);
    const moved = geometry.atAltitude(h + .001);
    expect(createSeaSkyTable(view, [1, 0, 0], {...settings, sensorAltitudeM: h + .001}, atmosphere, sea, moved)).toBe(table);
    expect(table.altitudeDomain.maxErrorK).toBeLessThanOrEqual(.001);
    const changed = fixture(true, {k: .2}).geometry;
    expect(createSeaSkyTable(view, [1, 0, 0], settings, atmosphere, sea, changed)).not.toBe(table);
});

test("production statistical sea resolves the lifted horizon without blending into vacuum sky", () => {
    const {geometry, settings} = fixture(), atmosphere = createAtmosphere({densityScale: 0});
    const view = skyViewGeometry({...settings, verticalFovDeg: .08, pathElevationDeg: geometry.horizonRad * 180 / Math.PI});
    const sea = createStatisticalSea(settings, atmosphere);
    const table = createSeaSkyTable(view, [1, 0, 0], settings, atmosphere, sea, geometry);
    expect(table.interpolation.toleranceMet).toBe(true);
    const row = table.rows[(table.rows.length - 1) / 2];
    for (const delta of [-.0005, -1e-6, -1e-8, 1e-8, 1e-6]) {
        const elevation = geometry.horizonRad + delta, sampled = sampleSkyElevationLUT(row, elevation);
        const hit = geometry.sea(elevation);
        if (!hit) {expect(sampled).toBe(0); continue;}
        const actual = sea.evaluate({...hit, azimuthRad: table.axisAzimuth}).photonRadiance;
        expect(Math.abs(apparentTemperature(actual, {quantity: "photon"}) - apparentTemperature(sampled, {quantity: "photon"}))).toBeLessThan(.005);
    }
});
