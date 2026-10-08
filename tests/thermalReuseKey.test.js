import {BoxGeometry, DataTexture, Group, LOD, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3} from "three";
import {createThermalReuseKey} from "../src/rendering/ThermalSceneAdapters";
import {createThermalViewAdapter} from "../src/rendering/ThermalViewAdapter";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {Globals, NodeMan, Sit} from "../src/Globals";
import {par} from "../src/par";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    GlobalDateTimeNode: {dateNow: new Date("2014-11-11T16:55:00Z")},
    NodeMan: {get: jest.fn(), iterate: jest.fn()}, Sit: {fps: 30}, markSitchDirty: jest.fn(), setRenderOne: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));
jest.mock("../src/par", () => ({par: {frame: 10, trackToTrackStopAt: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/rendering/ThermalLoader", () => ({thermalStatus: jest.fn()}));

function fixture() {
    const scene = new Scene(), camera = new PerspectiveCamera(60, 1, 1, 1e6);
    camera.position.x = Globals.equatorRadius + 1000; camera.updateMatrixWorld(true);
    const groundRoots = [new Group(), new Group(), new Group()]; scene.add(...groundRoots);
    const mesh = () => {const m = new Mesh(new BoxGeometry(10, 10, 10), new MeshBasicMaterial());
        m.position.set(camera.position.x, 0, -1000); return m;};
    const ground = mesh(), sea = mesh(), building = mesh(), object = mesh();
    groundRoots[0].add(ground); groundRoots[1].add(sea); groundRoots[2].add(building); scene.add(object);
    const node = {id: "target", model: object, thermal: {mode: "uniform", temperatureK: 300, emissivity: .9},
        _thermalSceneState: {mach: .4, airTemperatureK: 280, power: .5}};
    const cloud = {id: "cloud", isThermalCloud: true, mesh: new Mesh(), cloudCount: 1,
        instanceOffsets: new Float32Array([0, 0, -1000]), instanceSizes: new Float32Array([20, 20]),
        cloudTexture: new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)};
    scene.add(cloud.mesh);
    const inputs = {scene, camera, settings: normalizeSettings({turbulenceMode: "manual"}), frame: 10,
        objects: [node], groundRoots, clouds: [cloud], atmosphereKey: "air", sounding: {levels: [{temperatureK: 280}]},
        refractionOptions: {enabled: false}, presentation: {scale: [1, 1], offset: [0, 0]}, skyUp: new Vector3(1, 0, 0), psfRangeM: 1000};
    const key = createThermalReuseKey({budgetMs: Infinity});
    return {inputs, key: () => key(inputs), ground, sea, building, object, node, cloud, mesh};
}

test("unchanged resolved inputs produce the same exact key", () => {
    const f = fixture(), first = f.key(); expect(typeof first).toBe("string");
    expect(f.key()).toBe(first);
    f.inputs.camera = f.inputs.camera.clone(); expect(f.key()).toBe(first);
});

test.each([
    ["detector frame", f => {f.inputs.frame++;}],
    ["camera pose", f => {f.inputs.camera.position.y += .000001;}],
    ["camera projection", f => {f.inputs.camera.fov++; f.inputs.camera.updateProjectionMatrix();}],
    ["camera layer", f => {f.inputs.camera.layers.enable(2);}],
    ["normalized setting", f => {f.inputs.settings.objectTemperatureK++;}],
    ["presentation", f => {f.inputs.presentation.offset[0] += .1;}],
    ["sky up", f => {f.inputs.skyUp.y += .1;}],
    ["optical path range", f => {f.inputs.psfRangeM++;}],
    ["object identity", f => {f.inputs.objects = [{...f.node}];}],
    ["object world matrix", f => {f.object.position.z++;}],
    ["geometry identity", f => {f.object.geometry = f.object.geometry.clone();}],
    ["position revision", f => {f.object.geometry.attributes.position.needsUpdate = true;}],
    ["normal revision", f => {f.object.geometry.attributes.normal.needsUpdate = true;}],
    ["draw range", f => {f.object.geometry.setDrawRange(0, 3);}],
    ["resolved thermal state", f => {f.node._thermalSceneState.mach += .001;}],
    ["thermal override", f => {f.node.thermal.temperatureK++;}],
    ["thermal mesh tag", f => {f.object.userData.thermal = {temperatureK: 310};}],
    ["mesh visibility", f => {f.object.visible = false;}],
    ["material side", f => {f.object.material.side = 2;}],
    ["material visibility", f => {f.object.material.visible = false;}],
    ["ground detail", f => {f.ground.geometry = new BoxGeometry(20, 20, 20);}],
    ["terrain material color", f => {f.ground.material.color.setRGB(.2,.3,.4);}],
    ["terrain vertex color mode", f => {f.ground.material.vertexColors = true;}],
    ["terrain texture arrival", f => {f.ground.material.map = new DataTexture(new Uint8Array([80,90,100,255]),1,1);}],
    ["sea detail", f => {f.sea.geometry.attributes.position.needsUpdate = true;}],
    ["building matrix", f => {f.building.position.y++;}],
    ["inside tile arrival", f => {f.inputs.groundRoots[0].add(f.mesh());}],
    ["inside tile removal", f => {f.ground.removeFromParent();}],
    ["cloud identity", f => {f.inputs.clouds = [{...f.cloud}];}],
    ["cloud center", f => {f.cloud.instanceOffsets[0]++;}],
    ["cloud size", f => {f.cloud.instanceSizes[0]++;}],
    ["cloud pose", f => {f.cloud.mesh.position.x++;}],
    ["cloud visibility", f => {f.cloud.mesh.visible = false;}],
    ["cloud mask contents", f => {f.cloud.cloudTexture.image.data[3] = 128;}],
    ["cloud mask revision", f => {f.cloud.cloudTexture.needsUpdate = true;}],
    ["cloud sampler", f => {f.cloud.cloudTexture.wrapS++;}],
    ["parent world transform", f => {f.inputs.groundRoots[0].position.y++;}],
    ["index revision", f => {f.ground.geometry.index.needsUpdate = true;}],
    ["near plane", f => {f.inputs.camera.near += .1; f.inputs.camera.updateProjectionMatrix();}],
    ["sounding contents", f => {f.inputs.sounding.levels[0].temperatureK++;}],
    ["atmosphere key", f => {f.inputs.atmosphereKey = "new air";}],
    ["refraction options", f => {f.inputs.refractionOptions = {enabled: true, k: .17};}],
])("%s changes the key", (name, change) => {
    const f = fixture(), before = f.key(); change(f); const after = f.key();
    expect(typeof after).toBe("string"); expect(after).not.toBe(before);
});

test("view projection changes are tracked separately from the native detector projection", () => {
    const f = fixture(); f.inputs.viewCamera = f.inputs.camera.clone();
    const before = f.key(); f.inputs.viewCamera.projectionMatrix.elements[8] += .1;
    expect(f.key()).not.toBe(before);
});

test("a custom scene hook disables reuse unless it declares itself reuse-safe", () => {
    // Sitrec's scene carries hooks (transparent ordering, fisheye uniforms); without this rule reuse never applied there.
    const f = fixture();
    f.inputs.scene.onBeforeRender = () => {};
    expect(f.key()).toBeNull();
    f.inputs.scene.onBeforeRender.thermalReuseSafe = () => true;
    expect(typeof f.key()).toBe("string");
    f.inputs.scene.onBeforeRender.thermalReuseSafe = () => false; // for example fisheye switched on
    expect(f.key()).toBeNull();
});

test("with a visible cloud, an outside tile still changes the key: the cloud pass tests rays across the whole sheet", () => {
    const f = fixture(), before = f.key(), outside = f.mesh(); outside.position.x += 200000;
    f.inputs.groundRoots[0].add(outside); expect(f.key()).not.toBe(before);
});

test("outside tile arrival, detail changes and removal do not change the key", () => {
    const f = fixture(); f.inputs.clouds = [];
    const before = f.key(), outside = f.mesh(); outside.position.x += 200000;
    f.inputs.groundRoots[0].add(outside); expect(f.key()).toBe(before);
    outside.geometry = new BoxGeometry(100, 100, 100); expect(f.key()).toBe(before);
    outside.geometry.attributes.position.needsUpdate = true; expect(f.key()).toBe(before);
    outside.removeFromParent(); expect(f.key()).toBe(before);
});

test("the lift margin retains a tile just outside the physical frustum", () => {
    const f = fixture(); f.inputs.refractionOptions = {enabled: true, k: .176, maxLiftM: 1000};
    const tile = f.mesh(); tile.position.x -= 900; f.inputs.groundRoots[0].add(tile);
    const before = f.key(); tile.geometry = new BoxGeometry(12, 12, 12);
    expect(f.key()).not.toBe(before);
});

test("position edits invalidate the cached enclosure and can bring an outside tile into view", () => {
    const f = fixture(), tile = f.mesh(); tile.position.x += 200000; f.inputs.groundRoots[0].add(tile);
    const before = f.key();
    const position = tile.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) position.setX(i, position.getX(i) - 200000);
    position.needsUpdate = true;
    expect(f.key()).not.toBe(before);
});

test.each([
    ["unbounded lift", f => {f.inputs.refractionOptions = {enabled: true, maxLiftM: 0};}],
    ["deformed mesh", f => {f.object.isSkinnedMesh = true;}],
    ["instanced mesh", f => {f.object.isInstancedMesh = true;}],
    ["custom thermal function", f => {f.node.thermal.dynamic = () => 300;}],
    ["nonfinite value", f => {f.node.thermal.temperatureK = NaN;}],
    ["cyclic state", f => {f.node.thermal.self = f.node.thermal;}],
    ["untracked cloud image", f => {f.cloud.cloudTexture.image = {};}],
    ["scene callback", f => {f.inputs.scene.onBeforeRender = () => {};}],
    ["automatic detail selection", f => {f.inputs.scene.add(new LOD());}],
    ["custom serialization", f => {f.node.thermal.toJSON = () => ({});}],
])("%s disables reuse", (name, change) => {
    const f = fixture(); change(f); expect(f.key()).toBeNull();
});

test("exhausting the snapshot budget disables reuse", () => {
    const f = fixture(); expect(createThermalReuseKey({budgetMs: 0})(f.inputs)).toBeNull();
});

test("the host supplies a key after resolving object state and changes it for paused camera edits", () => {
    const f = fixture(); Sit.thermalEnvironment = {turbulenceMode: "manual"};
    NodeMan.get.mockReturnValue(undefined);
    const adapter = createThermalViewAdapter({camera: f.inputs.camera, cameraNode: {}, renderer: {}});
    const render = jest.spyOn(adapter.pipeline, "render").mockImplementation(() => {});
    // A stable node identity is part of the host's normal registry contract.
    f.node.isThermalObject = true; NodeMan.iterate.mockImplementation(fn => fn("target", f.node));
    const wasPaused = par.paused;
    try {
        par.paused = true;
        adapter.render(f.inputs.scene, 10); adapter.render(f.inputs.scene, 10);
        expect(typeof render.mock.calls[1][0].reuseKey).toBe("string");
        expect(render.mock.calls[1][0].reuseKey).toBe(render.mock.calls[0][0].reuseKey);
        f.inputs.camera.position.y++; adapter.render(f.inputs.scene, 10);
        expect(render.mock.calls[2][0].reuseKey).not.toBe(render.mock.calls[1][0].reuseKey);
        // During playback no frame can be reused, so no key is built; draws inside one frame are held instead.
        par.paused = false; adapter.render(f.inputs.scene, 10);
        expect(render.mock.calls[3][0].reuseKey).toBeNull(); expect(render.mock.calls[3][0].holdFrame).toBe(true);
    } finally {par.paused = wasPaused; adapter.dispose(); Sit.thermalEnvironment = undefined;}
});

(process.env.THERMAL_REUSE_BENCH ? test : test.skip)("host key benchmark", () => {
    const f = fixture(); f.inputs.clouds = [];
    for (let i = 0; i < 200; i++) {const tile = f.mesh(); tile.position.x += i % 2 ? 200000 : i; f.inputs.groundRoots[0].add(tile);}
    const key = createThermalReuseKey({budgetMs: Number(process.env.THERMAL_REUSE_BUDGET ?? 2)}), times = []; let misses = 0;
    for (let i = 0; i < 10; i++) key(f.inputs);
    for (let i = 0; i < 101; i++) {
        const start = performance.now(), result = key(f.inputs); times.push(performance.now() - start);
        if (result == null) misses++;
    }
    times.sort((a, b) => a - b);
    console.log(`Host key, 204 meshes: median ${times[50].toFixed(3)} ms, p95 ${times[95].toFixed(3)} ms; budget misses ${misses}/101`);
    expect(misses).toBeLessThan(101);
});


test("an offscreen tile intersecting a visible wide cloud's center ray remains an image dependency", () => {
    const f = fixture();
    f.cloud.mesh.position.copy(f.inputs.camera.position);
    f.cloud.instanceOffsets.set([2000, 0, -1000]); f.cloud.instanceSizes.set([4000, 4000]);
    const tile = f.mesh(); tile.position.set(f.inputs.camera.position.x + 1000, 0, -500);
    f.inputs.groundRoots[0].add(tile);
    const before = f.key(); tile.geometry = new BoxGeometry(20, 20, 20);
    expect(f.key()).not.toBe(before);
});
