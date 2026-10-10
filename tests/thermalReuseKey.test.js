import {BoxGeometry, BufferGeometry, DataTexture, Float32BufferAttribute, Group, LOD, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3} from "three";
import {createThermalReuseKey, createThermalSceneAdapter} from "../src/rendering/ThermalSceneAdapters";
import {CloudSort, registerTransparentCamera} from "../src/rendering/CloudSort";
import {installTerrestrialRefractionSceneHook} from "../src/atmosphere/refractionSettings";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {createThermalViewAdapter} from "../src/rendering/ThermalViewAdapter";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {Globals, NodeMan, Sit} from "../src/Globals";
import {par} from "../src/par";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    GlobalDateTimeNode: {dateNow: new Date("2014-11-11T16:55:00Z")},
    NodeMan: {get: jest.fn(), iterate: jest.fn()}, Sit: {fps: 30, lat: 0, lon: 0}, markSitchDirty: jest.fn(), setRenderOne: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: null}));
jest.mock("../src/par", () => ({par: {frame: 10, trackToTrackStopAt: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/rendering/ThermalLoader", () => ({thermalStatus: jest.fn()}));
// The mapped-ground mask without its worker: the test sets what the mask has loaded.
const mockGroundMask = {state: {texture: null, rect: null, region: {meters: 8000}, loading: true, error: null, stats: null}};
jest.mock("../src/rendering/ThermalGroundMask", () => ({ThermalGroundMask: class {
    get() {return mockGroundMask.state;}
    dispose() {}
}}));

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
    // A sounding is replaced, never edited in place: its identity names its contents.
    ["sounding replaced", f => {f.inputs.sounding = {levels: [{temperatureK: 281}]};}],
    ["atmosphere key", f => {f.inputs.atmosphereKey = "new air";}],
    ["refraction options", f => {f.inputs.refractionOptions = {enabled: true, k: .17};}],
])("%s changes the key", (name, change) => {
    const f = fixture(), before = f.key(); change(f); const after = f.key();
    expect(typeof after).toBe("string"); expect(after).not.toBe(before);
});

// Material classes classify the imagery too, and add the mapped-ground mask and one terrain height per frame.
function materialsFixture() {
    const f = fixture();
    f.inputs.settings = normalizeSettings({turbulenceMode: "manual", groundTemperatureMode: "materials"});
    f.inputs.groundClasses = [{id: "vegetation", offsetK: -1, emissivity: .98}, {id: "asphalt", offsetK: 4, emissivity: .95}];
    f.inputs.groundAltitudeM = 25;
    return f;
}

const maskTexture = () => new DataTexture(new Uint8Array(4), 1, 1);
const withMap = f => {f.ground.material.map = new DataTexture(new Uint8Array(4), 1, 1);};
const withMask = f => {f.inputs.groundMask = {texture: maskTexture(), rect: [0, 0, 1, 1]};};
test.each([
    ["terrain texture arrival (material swap)", null, f => {f.ground.material = new MeshBasicMaterial({map: new DataTexture(new Uint8Array([80, 90, 100, 255]), 1, 1)});}],
    ["terrain texture arrival (map set)", null, f => {f.ground.material.map = new DataTexture(new Uint8Array([80, 90, 100, 255]), 1, 1);}],
    ["terrain texture revision", withMap, f => {f.ground.material.map.needsUpdate = true;}],
    ["terrain material color", null, f => {f.ground.material.color.setRGB(.2, .3, .4);}],
    ["ground mask arrival", null, withMask],
    ["ground mask replaced", withMask, f => {f.inputs.groundMask = {...f.inputs.groundMask, texture: maskTexture()};}],
    ["ground mask revision", withMask, f => {f.inputs.groundMask.texture.needsUpdate = true;}],
    ["ground mask region", withMask, f => {f.inputs.groundMask.rect = [.5, .5, 1, 1];}],
    ["terrain height of the classes", null, f => {f.inputs.groundAltitudeM = 50;}],
    ["class offsets", null, f => {f.inputs.groundClasses[1].offsetK++;}],
])("material classes: %s changes the key", (name, setup, change) => {
    const f = materialsFixture(); setup?.(f);
    const before = f.key(); change(f); const after = f.key();
    expect(typeof before).toBe("string"); expect(typeof after).toBe("string"); expect(after).not.toBe(before);
});

test("material classes: unchanged imagery, mask and terrain height keep the key", () => {
    const f = materialsFixture(); withMap(f); withMask(f);
    expect(f.key()).toBe(f.key());
});

test("view projection changes are tracked separately from the native detector projection", () => {
    const f = fixture(); f.inputs.viewCamera = f.inputs.camera.clone();
    const before = f.key(); f.inputs.viewCamera.projectionMatrix.elements[8] += .1;
    expect(f.key()).not.toBe(before);
});

// Sitrec's world scene carries render hooks: transparent cloud ordering (CloudSort), terrestrial refraction, fisheye
// and the flat Earth. The thermal radiance pass draws its own scene of borrowed roots, so none of them runs inside a
// thermal draw (fisheye on the look camera and the flat Earth also make the thermal route unavailable). Between two
// thermal draws other views run them; what they change is outside both the draw and the key: visible cloud
// attribute order (thermal clouds use the canonical arrays and hide the cloud meshes), shader patches on visible
// materials (the draw replaces every material), frustum culling (off for every mesh in the draw) and the shared
// refraction uniforms (set from the camera and the options in the key for the draw, then restored).
function sceneHookFixture() {
    const f = fixture();
    // A visible cloud mesh with two puffs, ordered per camera by the real CloudSort hook.
    const offsets = new Float32Array([0, 0, -900, 0, 0, -1100]), sizes = new Float32Array([20, 20, 30, 30]);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("instanceOffset", new Float32BufferAttribute(offsets.slice(), 3));
    geometry.setAttribute("instanceSize", new Float32BufferAttribute(sizes.slice(), 2));
    const cloudMesh = new Mesh(geometry, new MeshBasicMaterial({transparent: true}));
    cloudMesh.position.copy(f.inputs.camera.position);
    f.cloud.mesh.removeFromParent(); f.cloud.mesh = cloudMesh; f.cloud.cloudCount = 2;
    f.cloud.instanceOffsets = offsets; f.cloud.instanceSizes = sizes;
    f.cloud.cloudTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    f.inputs.scene.add(cloudMesh);
    const sort = new CloudSort(offsets, sizes, 2);
    cloudMesh.userData.prepareTransparentCamera = camera => sort.prepare(camera, cloudMesh);
    registerTransparentCamera(cloudMesh);
    installTerrestrialRefractionSceneHook(f.inputs.scene);
    // A stand-in for the fisheye and flat-Earth sweeps: they patch visible materials and switch frustum culling.
    const previous = f.inputs.scene.onBeforeRender;
    const sweep = jest.fn(scene => scene.traverse(object => {
        if (!object.isMesh) return;
        object.frustumCulled = !object.frustumCulled;
        object.material.onBeforeCompile = () => {}; object.material.needsUpdate = true;
    }));
    f.inputs.scene.onBeforeRender = function (renderer, scene, camera, target) {
        previous.call(this, renderer, scene, camera, target); sweep(this);
    };
    // Another view draws the world scene with its own camera, as Three does: the scene's hooks run around the draw.
    const otherView = (turnRad = 0) => {
        const camera = f.inputs.camera.clone(); camera.rotateY(turnRad); camera.updateMatrixWorld(true);
        f.inputs.scene.onBeforeRender({}, f.inputs.scene, camera, null);
        f.inputs.scene.onAfterRender({}, f.inputs.scene, camera);
    };
    return {...f, cloudMesh, sweep, otherView};
}

// A thermal pipeline whose renderer calls the hooks of what it draws, as Three's WebGLRenderer does, and records the
// meshes, materials and culling the thermal draw used.
function hookedPipeline(f) {
    const renderer = {autoClear: true, shadowMap: {enabled: true}, xr: {enabled: true}, capabilities: {maxTextureSize: 16384},
        extensions: {has: () => true}, getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
        getViewport: v => v.set(0, 0, 4, 4), getScissor: v => v.set(0, 0, 4, 4), getScissorTest: () => false,
        getClearColor: v => v.set(0), getClearAlpha: () => 1, setRenderTarget() {}, setViewport() {}, setScissor() {},
        setScissorTest() {}, setClearColor() {}, clear() {}, getSize: v => v.set(4, 4),
        getContext: () => ({FRAMEBUFFER: 1, FRAMEBUFFER_COMPLETE: 2, checkFramebufferStatus: () => 2}),
        drawn: [],
        render(scene, camera) {
            if (scene.isScene) scene.onBeforeRender(this, scene, camera, null);
            scene.traverseVisible(object => {
                if (!object.isMesh) return;
                object.onBeforeRender(this, scene, camera, object.geometry, object.material, null);
                this.drawn.push([object.uuid, [object.material].flat().map(material => material.uuid), object.frustumCulled]);
            });
            if (scene.isScene) scene.onAfterRender(this, scene, camera);
        }};
    const pipeline = new ThermalPipeline(renderer);
    pipeline._prepareOptics = () => {pipeline.scatterSplit = {farMass: 0};};
    pipeline._optics = () => {}; pipeline._prepareFixedPattern = () => {}; pipeline._pass = () => {};
    pipeline._read = () => new Float32Array(16).fill(1000);
    const settings = normalizeSettings({detectorWidth: 4, detectorHeight: 4, turbulenceMode: "manual", gainMode: "manual",
        atmosphereEnabled: false, skySource: "manual", groundTemperatureMode: "uniform"});
    const draw = () => {
        renderer.drawn = [];
        pipeline.render({scene: f.inputs.scene, camera: f.inputs.camera, settings, frame: 10,
            radianceAdapter: createThermalSceneAdapter(f.inputs.objects, f.inputs.groundRoots, f.inputs.camera, {enabled: false})});
        return renderer.drawn;
    };
    return {pipeline, draw};
}

test("the thermal draw never runs the world scene's render hooks", () => {
    const f = sceneHookFixture(), {pipeline, draw} = hookedPipeline(f);
    const meshHook = jest.fn(); f.ground.onBeforeRender = meshHook;
    const prepare = jest.spyOn(f.cloudMesh.userData, "prepareTransparentCamera");
    try {
        const drawn = draw();
        expect(drawn.length).toBeGreaterThan(0);
        expect(f.sweep).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(meshHook).not.toHaveBeenCalled();
        // The cloud mesh is not a thermal surface; the thermal clouds are radiance sheets.
        expect(drawn.some(([uuid]) => uuid === f.cloudMesh.uuid)).toBe(false);
        // The hooks still run for a normal draw of the world scene.
        f.otherView(); expect(f.sweep).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1);
    } finally {pipeline.dispose();}
});

test("what the world scene's hooks leave between thermal draws changes neither the key nor the thermal draw", () => {
    const f = sceneHookFixture(), {pipeline, draw} = hookedPipeline(f);
    const terrestrial = Sit.terrestrialRefraction;
    try {
        const key = f.key(), drawn = draw();
        expect(typeof key).toBe("string");
        // The other view faces the clouds, then turns away, so their back-to-front order changes each time.
        for (const [refraction, turnRad] of [[false, 0], [true, Math.PI]]) {
            // The refraction hook's sweep and culling run only with terrestrial refraction on in the visible views.
            Sit.terrestrialRefraction = refraction;
            const order = Array.from(f.cloudMesh.geometry.getAttribute("instanceOffset").array);
            const culled = f.ground.frustumCulled, compiled = f.ground.material.onBeforeCompile;
            f.otherView(turnRad);
            // The hooks did change the visible state ...
            expect(Array.from(f.cloudMesh.geometry.getAttribute("instanceOffset").array)).not.toEqual(order);
            expect(f.ground.frustumCulled).not.toBe(culled); expect(f.ground.material.onBeforeCompile).not.toBe(compiled);
            // ... but not what the thermal frame depends on.
            expect(f.key()).toBe(key);
            expect(draw()).toEqual(drawn);
        }
    } finally {Sit.terrestrialRefraction = terrestrial; pipeline.dispose();}
});

test("a scene with render hooks gets a reuse key", () => {
    const f = fixture();
    f.inputs.scene.onBeforeRender = () => {}; f.inputs.scene.onAfterRender = () => {};
    expect(typeof f.key()).toBe("string");
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
    // No time budget: a cold first key under a loaded CPU must not turn into a missing key here.
    const adapter = createThermalViewAdapter({camera: f.inputs.camera, cameraNode: {}, renderer: {}}, {reuseBudgetMs: Infinity});
    const render = jest.spyOn(adapter.pipeline, "render").mockImplementation(() => {});
    // A stable node identity is part of the host's normal registry contract.
    f.node.isThermalObject = true; NodeMan.iterate.mockImplementation(fn => fn("target", f.node));
    const wasPaused = par.paused;
    try {
        par.paused = true;
        adapter.render(f.inputs.scene, 10); adapter.render(f.inputs.scene, 10);
        expect(typeof render.mock.calls[0][0].reuseKey).toBe("string");
        expect(typeof render.mock.calls[1][0].reuseKey).toBe("string");
        expect(render.mock.calls[1][0].reuseKey).toBe(render.mock.calls[0][0].reuseKey);
        f.inputs.camera.position.y++; adapter.render(f.inputs.scene, 10);
        expect(render.mock.calls[2][0].reuseKey).not.toBe(render.mock.calls[1][0].reuseKey);
        // During playback no frame can be reused, so no key is built; draws inside one frame are held instead.
        par.paused = false; adapter.render(f.inputs.scene, 10);
        expect(render.mock.calls[3][0].reuseKey).toBeNull(); expect(render.mock.calls[3][0].holdFrame).toBe(true);
    } finally {par.paused = wasPaused; adapter.dispose(); Sit.thermalEnvironment = undefined;}
});

test("material classes: a paused view gets a new key when terrain imagery, the ground mask or the terrain height arrives", () => {
    const f = fixture(); f.inputs.clouds = [];
    Sit.thermalEnvironment = {turbulenceMode: "manual", groundTemperatureMode: "materials", groundMapData: true};
    let below = null;
    const terrain = {getGroup: () => f.inputs.groundRoots[0], UI: {oceanSurfaceGroup: f.inputs.groundRoots[1],
        buildingsNode: {group: f.inputs.groundRoots[2]}}, getPointBelow: () => below};
    NodeMan.get.mockImplementation(id => id === "TerrainModel" ? terrain : undefined);
    NodeMan.iterate.mockImplementation(() => {});
    const adapter = createThermalViewAdapter({camera: f.inputs.camera, cameraNode: {}, renderer: {}}, {reuseBudgetMs: Infinity});
    const render = jest.spyOn(adapter.pipeline, "render").mockImplementation(() => {});
    const key = () => {adapter.render(f.inputs.scene, 10); return render.mock.calls.at(-1)[0].reuseKey;};
    const wasPaused = par.paused;
    try {
        par.paused = true;
        const first = key(); expect(typeof first).toBe("string"); expect(key()).toBe(first);
        // An imagery tile's texture arrives: Sitrec's terrain swaps the tile's material.
        f.ground.material = new MeshBasicMaterial({map: new DataTexture(new Uint8Array([80, 90, 100, 255]), 1, 1)});
        const imagery = key(); expect(typeof imagery).toBe("string"); expect(imagery).not.toBe(first);
        // The mapped roads and buildings arrive from the worker (ThermalGroundMask then asks for a render).
        Object.assign(mockGroundMask.state, {texture: new DataTexture(new Uint8Array(4), 1, 1), rect: [0, 0, 1, 1],
            loading: false, stats: {roads: 1, paths: 0, buildings: 2, metersPerTexel: 4}});
        const masked = key(); expect(typeof masked).toBe("string"); expect(masked).not.toBe(imagery);
        // The terrain below the target loads: the classes' air temperature now uses its height.
        below = f.inputs.camera.position.clone().setLength(Globals.equatorRadius + 60);
        const height = key(); expect(typeof height).toBe("string"); expect(height).not.toBe(masked);
        expect(key()).toBe(height);
    } finally {
        par.paused = wasPaused; adapter.dispose(); Sit.thermalEnvironment = undefined;
        Object.assign(mockGroundMask.state, {texture: null, rect: null, loading: true, stats: null});
        NodeMan.get.mockReset();
    }
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
