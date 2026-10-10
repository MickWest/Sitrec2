import {BoxGeometry, Color, Group, Line, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector4} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {BANDS, sourceRangeLUT} from "../tools/thermal/atmosphere.js";
import {grayBodyRadiance, inBandRadiance, PHOTON_SCALE, solarIrradiance} from "../tools/thermal/radiometry.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";

function fixture(options = {}) {
    const pipeline = new ThermalPipeline({}, {analysis: false, synchronous: false, ...options});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(), textures: new Set()};
    pipeline._drawRadiance = () => {};
    const settings = normalizeSettings({skySource: "atmosphere", atmosphereEnabled: true,
        detectorWidth: 640, detectorHeight: 512, atmosphereMaxRangeM: 200000});
    const scene = new Scene(), camera = new PerspectiveCamera(8, 640 / 512, 1, 200000);
    const terrain = new Group(), aircraft = new Group(), sea = new Group();
    scene.add(terrain, aircraft, sea);
    const geometry = new BoxGeometry(100, 100, 100), material = new MeshBasicMaterial();
    for (let i = 0; i < 300; i++) {
        const mesh = new Mesh(geometry, material);
        mesh.position.set((i % 20 - 10) * 500, -300, -20000 - Math.floor(i / 20) * 500);
        terrain.add(mesh);
    }
    for (let i = 0; i < 48; i++) {
        const mesh = new Mesh(geometry, i % 4 ? material : [material, material]);
        mesh.userData.thermal = {temperatureK: 290 + (i % 12) * 25, emissivity: .7 + (i % 3) * .1};
        mesh.position.set((i % 8 - 4) * 30, 0, -10000);
        aircraft.add(mesh);
    }
    for (let i = 0; i < 32; i++) sea.add(new Mesh(geometry, material));
    for (let i = 0; i < 80; i++) {
        const helper = i % 2 ? new Line() : new Mesh(geometry, material);
        if (!helper.isLine) helper.type = "BoxHelper";
        scene.add(helper);
    }
    pipeline.radianceAdapter = {
        materialKey: "fixture", prepareMaterial() {},
        attributes: mesh => mesh.parent === terrain ? {temperatureK: settings.groundTemperatureK,
            emissivity: settings.groundEmissivity} : mesh.parent === sea ? {sea: true} : undefined,
        isSurface: mesh => mesh.parent === terrain || mesh.parent === sea,
    };
    camera.updateMatrixWorld(true);
    const target = {width: 640, height: 512, viewport: new Vector4()};
    const setRange = frame => {
        // Match atmospheric invalidation during camera altitude drift, outside the timed stage.
        for (const surface of pipeline.resources.surfaces.values()) {
            surface.material.dispose(); pipeline._removeTexture(surface.texture);
        }
        pipeline.resources.surfaces.clear();
        const size = 128;
        pipeline.rangeLUT = {size, maxRangeM: 200000, transmission: Float32Array.from({length: size * 12},
            (_, i) => Math.exp(-i / (size * 12) * (.2 + frame * .00001))),
        pathRadiance: new Float32Array(size * 12).fill(.01 + frame * .000001)};
    };
    setRange(0);
    const draw = () => pipeline._radiance(scene, camera, settings, target, 0);
    const dispose = () => {pipeline.dispose(); geometry.dispose(); material.dispose();};
    return {pipeline, settings, scene, camera, target, terrain, aircraft, sea, setRange, draw, dispose};
}

// Independent reference: a per-surface spectral evaluation.
function referenceTexture(attributes, settings, rangeLUT) {
    const emission = new Float64Array(12), reflectedSun = new Float64Array(12);
    BANDS.forEach((band, index) => {
        const minUm = Math.max(settings.bandMinUm, band.minM * 1e6);
        const maxUm = Math.min(settings.bandMaxUm, band.maxM * 1e6);
        if (maxUm <= minUm) return;
        const response = {minUm, maxUm};
        const gray = grayBodyRadiance({...attributes,
            environment: inBandRadiance(settings.environmentTemperatureK, response)}, response);
        emission[index] = gray.total.photon;
        reflectedSun[index] = (1 - attributes.emissivity) * solarIrradiance({}, response).photon * settings.solarScale / Math.PI;
    });
    const thermal = sourceRangeLUT(rangeLUT, emission), rgba = new Float32Array(rangeLUT.size * 4);
    for (let sample = 0; sample < rangeLUT.size; sample++) {
        rgba[sample * 4] = thermal[sample];
        for (let band = 0; band < 12; band++) rgba[sample * 4 + 1] +=
            reflectedSun[band] / PHOTON_SCALE * rangeLUT.transmission[sample * 12 + band];
    }
    return rgba;
}

function snapshot(f) {
    const result = [];
    for (const root of [f.terrain, f.aircraft]) for (const mesh of root.children) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            result.push({side: material.side, visible: material.visible, vertex: material.vertexShader,
                fragment: material.fragmentShader, depthTest: material.depthTest, depthWrite: material.depthWrite,
                uniforms: Object.fromEntries(Object.entries(material.uniforms).map(([key, {value}]) =>
                    [key, value?.isTexture ? Buffer.from(value.image.data.buffer).toString("hex") :
                        value?.isVector3 ? value.toArray() : value]))});
        }
    }
    return result;
}
function hostState(scene) {
    const objects = [];
    scene.traverse(object => objects.push({object, material: object.material, visible: object.visible,
        frustumCulled: object.frustumCulled, onBeforeRender: object.onBeforeRender, onAfterRender: object.onAfterRender}));
    return {objects, background: scene.background, overrideMaterial: scene.overrideMaterial};
}
function expectHost(scene, state) {
    expect(scene.background).toBe(state.background); expect(scene.overrideMaterial).toBe(state.overrideMaterial);
    for (const entry of state.objects) for (const key of Object.keys(entry)) {
        if (key !== "object") expect(entry.object[key]).toBe(entry[key]);
    }
}

test("cached uniforms and texture bytes match fresh renders throughout attribute and camera changes", () => {
    const cached = fixture(), fresh = fixture({analysis: true});
    const captures = [[], []];
    [cached, fresh].forEach((f, index) => {
        // Four different surfaces suffice for the byte comparison; the benchmark uses the full scene.
        for (const root of [f.terrain, f.aircraft]) for (const mesh of [...root.children].slice(4)) root.remove(mesh);
        f.scene.background = new Color("blue"); f.scene.overrideMaterial = new MeshBasicMaterial();
        f.pipeline._drawRadiance = () => captures[index].push(snapshot(f));
    });
    try {
        for (let frame = 0; frame < 14; frame++) {
            for (const f of [cached, fresh]) {
                if (frame % 2 === 0) f.setRange(frame);
                f.camera.rotation.y = frame * .0001; f.camera.updateMatrixWorld(true);
                f.settings.sunDirectionX = frame * .02;
                if (frame === 2) f.aircraft.children[0].userData.thermal.temperatureK += 2;
                if (frame === 4) f.aircraft.children[1].userData.thermal.emissivity = .5;
                if (frame === 6) f.settings.environmentTemperatureK += 5;
                if (frame === 8) {f.settings.solarScale = .4; f.settings.bandMinUm = 3.4; f.settings.bandMaxUm = 4.8;}
                if (frame === 10) {
                    f.pipeline.radianceAdapter.materialKey = "updated shader";
                    f.pipeline.radianceAdapter.prepareMaterial = material => {material.defines = {UPDATED: 1}; material.uniforms.extra = {value: 7};};
                }
                if (frame === 12) {
                    const material = f.aircraft.children[1].material;
                    material.side = 2; material.visible = false;
                }
                const before = hostState(f.scene); f.draw(); expectHost(f.scene, before);
            }
            expect(captures[0].at(-1)).toEqual(captures[1].at(-1));
        }
        expect(cached.pipeline.resources.surfaceSpectra.size).toBeGreaterThan(0);
        expect(fresh.pipeline.resources.surfaceSpectra).toBeUndefined();
    } finally {cached.dispose(); fresh.dispose();}
});

test.each([{analysis: false, synchronous: false}, {analysis: true}, {analysis: false, synchronous: true}])(
    "surface texture is bit-identical to original evaluation with %j", options => {
        const f = fixture(options);
        try {
            for (let frame = 0; frame < 5; frame++) {
                f.setRange(frame);
                const attributes = {temperatureK: 317 + frame % 2, emissivity: .72};
                const surface = f.pipeline._surface(attributes, f.terrain.children[0].material, f.settings, f.camera.position);
                const expected = referenceTexture(attributes, f.settings, f.pipeline.rangeLUT);
                expect(Buffer.from(surface.uniforms.rangeTexture.value.image.data.buffer)).toEqual(Buffer.from(expected.buffer));
            }
            if (options.analysis || options.synchronous) {
                expect(f.pipeline.resources.surfaceSpectra).toBeUndefined();
                expect(f.pipeline.resources.surfaceIllumination).toBeUndefined();
            }
        } finally {f.dispose();}
    });

test("materials and source spectra expire with their last mesh and shader settings", () => {
    const f = fixture();
    try {
        f.draw();
        const old = [...f.pipeline.resources.surfaces.values()];
        const disposed = old.map(surface => jest.spyOn(surface.material, "dispose"));
        const textures = old.map(surface => jest.spyOn(surface.texture, "dispose"));
        const source = [...f.pipeline.resources.surfaceSpectra.values()][0];
        f.pipeline.radianceAdapter.materialKey = "new shader"; f.draw();
        for (const spy of [...disposed, ...textures]) expect(spy).toHaveBeenCalledTimes(1);
        expect([...f.pipeline.resources.surfaceSpectra.values()]).toContain(source);
        const replacements = [...f.pipeline.resources.surfaces.values()].map(surface => jest.spyOn(surface.material, "dispose"));
        f.terrain.clear(); f.aircraft.clear(); f.draw();
        expect(f.pipeline.resources.surfaces.size).toBe(0);
        expect(f.pipeline.resources.surfaceSpectra.size).toBe(0);
        expect(f.pipeline.resources.textures.size).toBe(0);
        for (const spy of replacements) expect(spy).toHaveBeenCalledTimes(1);
        expect(f.pipeline.resources.surfaceIllumination).toBeNull();
    } finally {f.dispose();}
});

test.each(["draw", "prepare"])("warm host state restores after a %s error", stage => {
    const f = fixture();
    try {
        f.draw(); const state = hostState(f.scene);
        if (stage === "draw") f.pipeline._drawRadiance = () => {throw Error("draw");};
        else {
            f.setRange(1);
            f.pipeline.radianceAdapter.prepareMaterial = () => {throw Error("prepare");};
        }
        expect(() => f.draw()).toThrow(stage); expectHost(f.scene, state);
        if (stage === "prepare") expect(f.pipeline.resources.textures.size).toBe(0);
        f.pipeline._drawRadiance = () => {}; f.pipeline.radianceAdapter.prepareMaterial = () => {};
        f.draw(); expectHost(f.scene, state);
        const disposed = [...f.pipeline.resources.surfaces.values()].flatMap(surface =>
            [jest.spyOn(surface.material, "dispose"), jest.spyOn(surface.texture, "dispose")]);
        f.dispose();
        for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
        expect(f.pipeline.resources).toBeNull();
    } finally {if (!f.pipeline.disposed) f.dispose();}
});
