import {BackSide, BoxGeometry, CustomBlending, DoubleSide, FrontSide, Mesh, MeshBasicMaterial, NoBlending, OneFactor, OneMinusSrcAlphaFactor,
    PerspectiveCamera, Scene, SphereGeometry, Vector3, Vector4} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {BANDS, sourceRangeLUT} from "../tools/thermal/atmosphere.js";
import {grayBodyRadiance, inBandRadiance, PHOTON_SCALE, solarIrradiance} from "../tools/thermal/radiometry.js";
import {resolveSignatures} from "../tools/thermal/signatures.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {radianceFragment} from "../tools/thermal/shaders.js";
import {createThermalSceneAdapter} from "../src/rendering/ThermalSceneAdapters";

const relative = (actual, expected, tolerance = 1e-12) =>
    expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);

test("a thin layer in an isothermal enclosure adds its transmitted radiance to give the enclosure radiance", () => {
    const enclosure = inBandRadiance(300);
    for (const [emissivity, transmittance] of [[0.3, 0.5], [0.1, 0.9], [0.6, 0], [0, 1]]) {
        const own = grayBodyRadiance({temperatureK: 300, emissivity, transmittance, environment: enclosure});
        for (const quantity of ["energy", "photon"])
            relative(own.total[quantity] + transmittance * enclosure[quantity], enclosure[quantity]);
    }
});

test("a thin layer reflects 1 - emissivity - transmittance of the environment and the sun", () => {
    const environment = inBandRadiance(250), solar = solarIrradiance();
    const layer = grayBodyRadiance({temperatureK: 0, emissivity: 0.3, transmittance: 0.5, environment, solar, cosIncidence: 0.5});
    for (const quantity of ["energy", "photon"]) {
        relative(layer.reflectedEnvironment[quantity], 0.2 * environment[quantity], 1e-9);
        relative(layer.reflectedSolar[quantity], 0.2 * solar[quantity] * 0.5 / Math.PI, 1e-9);
    }
});

test("zero transmittance keeps the opaque result and an impossible layer is refused", () => {
    const environment = inBandRadiance(280);
    const opaque = grayBodyRadiance({temperatureK: 320, emissivity: 0.85, environment});
    const explicit = grayBodyRadiance({temperatureK: 320, emissivity: 0.85, transmittance: 0, environment});
    expect(explicit.total).toEqual(opaque.total);
    expect(() => grayBodyRadiance({temperatureK: 300, emissivity: 0.6, transmittance: 0.5})).toThrow();
    expect(() => grayBodyRadiance({temperatureK: 300, emissivity: 0.5, transmittance: -0.1})).toThrow();
});

test("source table plus t times the radiance behind equals band-by-band segmented transfer", () => {
    // Sample 0 is the layer range r1; the background lies further on, with its own segment r1 -> r2.
    const t1 = Float64Array.from({length: 12}, (_, band) => 0.35 + 0.05 * band);
    const p1 = Float64Array.from({length: 12}, (_, band) => 0.002 * (12 - band));
    const t12 = Float64Array.from({length: 12}, (_, band) => 0.9 - 0.03 * band);
    const p12 = Float64Array.from({length: 12}, (_, band) => 0.001 * (band + 1));
    const layer = Float64Array.from({length: 12}, (_, band) => 0.4 + 0.02 * band); // scaled emitted + reflected
    const background = Float64Array.from({length: 12}, (_, band) => 0.3 + 0.01 * band); // scaled, at r2
    const rangeLUT = {size: 1, transmission: Float32Array.from(t1), pathRadiance: Float32Array.from(p1)};
    for (const transmittance of [0, 0.3, 1]) {
        let behind = 0, expected = 0;
        for (let band = 0; band < 12; band++) {
            // Sensor-referred background: T(r2) = T(r1) T12, P(r2) = P(r1) + T(r1) P12.
            behind += t1[band] * t12[band] * background[band] + p1[band] + t1[band] * p12[band];
            const arriving = t12[band] * background[band] + p12[band];
            expected += t1[band] * (layer[band] + transmittance * arriving) + p1[band];
        }
        const source = sourceRangeLUT(rangeLUT, layer.map(value => value * PHOTON_SCALE), 1 - transmittance)[0];
        relative(source + transmittance * behind, expected, 1e-6);
    }
});

function pipelineFixture({floatBlend = true} = {}) {
    const renderer = {extensions: {has: name => floatBlend && name === "EXT_float_blend"}};
    const pipeline = new ThermalPipeline(renderer, {analysis: false, synchronous: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(), textures: new Set()};
    const size = 16;
    pipeline.rangeLUT = {size, maxRangeM: 20000, transmission: Float32Array.from({length: size * 12}, (_, i) => Math.exp(-i / 400)),
        pathRadiance: new Float32Array(size * 12).fill(0.01)};
    const settings = normalizeSettings({skySource: "atmosphere", atmosphereEnabled: true, solarScale: 1,
        detectorWidth: 64, detectorHeight: 64, atmosphereMaxRangeM: 20000});
    return {pipeline, settings};
}

function referenceTexture(attributes, settings, rangeLUT, interior = false) {
    const emission = new Float64Array(12), reflectedSun = new Float64Array(12), transmittance = attributes.transmittance ?? 0;
    BANDS.forEach((band, index) => {
        const minUm = Math.max(settings.bandMinUm, band.minM * 1e6), maxUm = Math.min(settings.bandMaxUm, band.maxM * 1e6);
        if (maxUm <= minUm) return;
        const response = {minUm, maxUm}, outside = inBandRadiance(settings.environmentTemperatureK, response);
        // Interior of a shell of one layer: L = e B(T) + r L + t L_env, so L = (e B(T) + t L_env) / (e + t).
        const own = inBandRadiance(attributes.temperatureK, response), e = attributes.emissivity;
        const environment = interior ? {energy: (e * own.energy + transmittance * outside.energy) / (e + transmittance),
            photon: (e * own.photon + transmittance * outside.photon) / (e + transmittance)} : outside;
        emission[index] = grayBodyRadiance({...attributes, environment}, response).total.photon;
        reflectedSun[index] = interior ? 0 : (1 - e - transmittance) * solarIrradiance({}, response).photon * settings.solarScale / Math.PI;
    });
    const thermal = sourceRangeLUT(rangeLUT, emission, 1 - transmittance), rgba = new Float32Array(rangeLUT.size * 4);
    for (let sample = 0; sample < rangeLUT.size; sample++) {
        rgba[sample * 4] = thermal[sample];
        for (let band = 0; band < 12; band++) rgba[sample * 4 + 1] += reflectedSun[band] / PHOTON_SCALE * rangeLUT.transmission[sample * 12 + band];
    }
    return rgba;
}

test("a transmitting surface blends premultiplied without depth writes and uses r = 1 - e - t", () => {
    const {pipeline, settings} = pipelineFixture();
    try {
        const attributes = {temperatureK: 337, emissivity: 0.45, transmittance: 0.3};
        const pass = pipeline._surface(attributes, new MeshBasicMaterial({side: DoubleSide}), settings, new Vector3(0, 0, 1));
        expect(pass).toMatchObject({transparent: true, blending: CustomBlending, blendSrc: OneFactor,
            blendDst: OneMinusSrcAlphaFactor, depthTest: true, depthWrite: false, side: DoubleSide});
        expect(pass.uniforms.transmittance.value).toBe(0.3);
        // Row 0 is the outer face, row 1 the inner face that back faces use.
        expect(pass.uniforms.innerRow.value).toBe(1);
        const texture = pass.uniforms.rangeTexture.value, row = pipeline.rangeLUT.size * 4;
        expect(texture.image.height).toBe(2);
        expect(Array.from(texture.image.data.subarray(0, row))).toEqual(Array.from(referenceTexture(attributes, settings, pipeline.rangeLUT)));
        expect(Array.from(texture.image.data.subarray(row))).toEqual(Array.from(referenceTexture(attributes, settings, pipeline.rangeLUT, true)));
        const opaque = pipeline._surface({temperatureK: 337, emissivity: 0.45}, new MeshBasicMaterial({side: DoubleSide}), settings, new Vector3(0, 0, 1));
        expect(opaque).not.toBe(pass);
        expect(opaque).toMatchObject({transparent: false, blending: NoBlending, depthWrite: true});
        expect(opaque.uniforms.transmittance.value).toBe(0);
        expect(opaque.uniforms.innerRow.value).toBe(0);
        // No flame glow unless a shell's draw sets one.
        expect(pass.uniforms.glowSource.value.toArray()).toEqual([0, 0, 0, 0]);
        expect(opaque.uniforms.rangeTexture.value.image.height).toBe(1);
    } finally {pipeline.dispose();}
});

test("without float blending a transmitting surface is drawn as an opaque surface", () => {
    const {pipeline, settings} = pipelineFixture({floatBlend: false});
    try {
        const pass = pipeline._surface({temperatureK: 337, emissivity: 0.45, transmittance: 0.3}, new MeshBasicMaterial(), settings, new Vector3(0, 0, 1));
        expect(pass).toMatchObject({transparent: false, blending: NoBlending, depthWrite: true});
        expect(pass.uniforms.transmittance.value).toBe(0);
        expect(Array.from(pass.uniforms.rangeTexture.value.image.data))
            .toEqual(Array.from(referenceTexture({temperatureK: 337, emissivity: 0.45}, settings, pipeline.rangeLUT)));
    } finally {pipeline.dispose();}
});

test("lantern zones: a thin canopy that follows burn power and a flame whose intensity follows burn power", () => {
    const at = power => resolveSignatures({thermal: {profile: "lantern", powerFraction: power}}, 297);
    const full = at(1), quarter = at(0.25), out = at(0);
    expect(full.resolveZone("lantern_envelope")).toMatchObject({temperatureK: 337, emissivity: 0.45, transmittance: 0.3});
    expect(out.resolveZone("lantern_envelope").temperatureK).toBe(297);
    expect(quarter.resolveZone("lantern_envelope").temperatureK).toBeGreaterThan(297);
    expect(quarter.resolveZone("lantern_envelope").temperatureK).toBeLessThan(337);
    for (const [signature, power] of [[full, 1], [quarter, 0.25], [out, 0]])
        expect(signature.resolveZone("lantern_flame")).toMatchObject({temperatureK: 1400, emissivity: 0.05 * power, transmittance: 1 - 0.05 * power, volume: true});
    // A flame emissivity override keeps a volume's transmittance at 1 - e.
    expect(resolveSignatures({thermal: {profile: "lantern", zones: {lantern_flame: {emissivity: 0.01}}}}, 297).resolveZone("lantern_flame"))
        .toMatchObject({emissivity: 0.01, transmittance: 0.99, volume: true});
    expect(resolveSignatures(full.resolveZone("lantern_flame"), 297).airframe).toMatchObject({volume: true});
    // An override that raises emissivity reduces transmittance so that e + t <= 1.
    const overridden = resolveSignatures({thermal: {profile: "lantern", zones: {lantern_envelope: {emissivity: 0.8}}}}, 297);
    expect(overridden.resolveZone("lantern_envelope").transmittance).toBeCloseTo(0.2, 12);
    // A resolved zone copied onto a mesh as plain attributes keeps its transmittance.
    expect(resolveSignatures(full.resolveZone("lantern_envelope"), 297).airframe).toMatchObject({emissivity: 0.45, transmittance: 0.3});
});

test("the radiance stage draws the shell and the flame volume as transparent layers and nests the flame in the shell", () => {
    const {pipeline, settings} = pipelineFixture();
    const scene = new Scene(), camera = new PerspectiveCamera(1, 1, 1, 20000);
    const shell = new Mesh(new SphereGeometry(0.3), new MeshBasicMaterial({side: DoubleSide}));
    shell.userData.thermal = {temperatureK: 337, emissivity: 0.45, transmittance: 0.3, zone: "lantern_envelope"};
    const flame = new Mesh(new BoxGeometry(0.05, 0.12, 0.05), new MeshBasicMaterial());
    flame.userData.thermal = {temperatureK: 1400, emissivity: 0.05, transmittance: 0.95, volume: true, zone: "lantern_flame"};
    shell.position.set(0, 0, -2000); flame.position.set(0, 0, -2000);
    scene.add(shell, flame); camera.updateMatrixWorld(true);
    const drawn = [];
    // The sub-pixel lantern takes the coverage-patch path, which draws through the same _drawRadiance.
    pipeline._target = () => ({texture: {}});
    pipeline._pass = () => {};
    let layers;
    pipeline._drawRadiance = drawScene => {
        layers = pipeline.transmissiveLayers;
        drawn.push(...drawScene.children.map(mesh => ({mesh, transparent: mesh.material.transparent, depthWrite: mesh.material.depthWrite})));
    };
    try {
        pipeline._radiance(scene, camera, settings, {width: 64, height: 64, viewport: new Vector4()}, 0);
        expect(drawn.find(entry => entry.mesh === shell)).toMatchObject({transparent: true, depthWrite: false});
        // The flame is a transmitting gas volume, composited inside the shell rather than as its own layer.
        expect(drawn.find(entry => entry.mesh === flame)).toMatchObject({transparent: true, depthWrite: false});
        expect(layers.map(entry => [entry.mesh, entry.volumes])).toEqual([[shell, [flame]]]);
        expect(pipeline.transmissionReport).toEqual({layers: 2, composition: "floatBlend"});
        expect(shell.material).toBeInstanceOf(MeshBasicMaterial);
    } finally {pipeline.dispose();}
});

test("the back-face pass selects the inner row by FLIP_SIDED, not by gl_FrontFacing", () => {
    // Three.js draws a transparent double-sided material as a BackSide pass with the winding reversed, so
    // gl_FrontFacing is true for the inner faces it draws. Measured in the browser: selecting by gl_FrontFacing
    // alone gave the far wall the outer environment.
    expect(radianceFragment).toMatch(/#if defined\(FLIP_SIDED\)\s*int row = innerRow;/);
    expect(radianceFragment).toMatch(/#elif defined\(DOUBLE_SIDED\)\s*int row = gl_FrontFacing \? 0 : innerRow;/);
});

test("a zone override that raises emissivity limits the canopy transmittance on the host path", () => {
    const camera = new PerspectiveCamera(1, 1, 1, 20000); camera.updateMatrixWorld();
    const root = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    root.userData.thermal = {temperatureK: 337, emissivity: 0.45, transmittance: 0.3, zone: "lantern_envelope"};
    const node = {model: root, thermal: {mode: "inherit", zones: {lantern_envelope: {emissivity: 0.85}}}};
    const adapter = createThermalSceneAdapter([node], [], camera, {enabled: false});
    const attributes = adapter.attributes(root, normalizeSettings({}));
    expect(attributes.emissivity).toBe(0.85);
    expect(attributes.transmittance).toBeCloseTo(0.15, 12);
    expect(() => grayBodyRadiance({...attributes, environment: inBandRadiance(280)})).not.toThrow();
});

test("cloud sheets and transmitting layers are interleaved by camera depth, far to near", () => {
    const {pipeline} = pipelineFixture();
    const far = new Mesh(new SphereGeometry(0.3), new MeshBasicMaterial()), near = new Mesh(new SphereGeometry(0.3), new MeshBasicMaterial());
    const flame = new Mesh(new BoxGeometry(0.05, 0.1, 0.05));
    const name = mesh => mesh === far ? "farShell" : mesh === near ? "nearShell" : "flame";
    const scene = new Scene(); scene.children = [far, near, flame];
    const calls = [];
    pipeline.renderer.render = drawn => calls.push(["render", drawn.children.filter(mesh => mesh.visible).map(name)]);
    pipeline._drawSky = () => {}; pipeline.renderer.clear = () => {};
    // Lanterns at 4 km and 2 km; sheets beyond both, between them, and in front of both.
    const sheets = [{id: "beyond", center: [0, 0, -5000]}, {id: "between", center: [0, 0, -3000]}, {id: "front", center: [0, 0, -500]}];
    pipeline.cloudPass = {dispose() {}, draw: (camera, target, force, include) => calls.push(["clouds", sheets.filter(sheet => !include || include(sheet)).map(sheet => sheet.id)])};
    pipeline.transmissiveLayers = [{mesh: far, depthM: 4000}, {mesh: near, depthM: 2000}];
    pipeline._drawRadiance(scene, new PerspectiveCamera(), {}, 0);
    expect(calls).toEqual([["render", ["flame"]], ["clouds", ["beyond"]], ["render", ["farShell"]], ["clouds", ["between"]],
        ["render", ["nearShell"]], ["clouds", ["front"]]]);
    expect(far.visible && near.visible).toBe(true);
    pipeline.transmissiveLayers = null; calls.length = 0;
    pipeline._drawRadiance(scene, new PerspectiveCamera(), {}, 0);
    expect(calls).toEqual([["render", ["farShell", "nearShell", "flame"]], ["clouds", ["beyond", "between", "front"]]]);
    pipeline.dispose();
});

test("a multi-group transmitting shell gets one layer material so it draws as one back and one front pass", () => {
    const {pipeline, settings} = pipelineFixture();
    const scene = new Scene(), camera = new PerspectiveCamera(1, 1, 1, 20000);
    const geometry = new SphereGeometry(0.3, 16, 8);
    geometry.clearGroups(); geometry.addGroup(0, 240, 0); geometry.addGroup(240, geometry.index.count - 240, 1);
    const originals = [new MeshBasicMaterial({side: DoubleSide}), new MeshBasicMaterial({side: DoubleSide})];
    const shell = new Mesh(geometry, originals);
    shell.userData.thermal = {temperatureK: 337, emissivity: 0.45, transmittance: 0.3};
    shell.position.set(0, 0, -2000); scene.add(shell); camera.updateMatrixWorld(true);
    let drawnMaterial;
    pipeline._target = () => ({texture: {}}); pipeline._pass = () => {};
    pipeline._drawRadiance = () => {drawnMaterial = shell.material;};
    try {
        pipeline._radiance(scene, camera, settings, {width: 64, height: 64, viewport: new Vector4()}, 0);
        expect(Array.isArray(drawnMaterial)).toBe(false);
        expect(drawnMaterial.transparent).toBe(true);
        expect(shell.material).toBe(originals);
    } finally {pipeline.dispose();}
});

test("a flame proxy is a gas volume: it emits and transmits, reflects nothing, and is absent after flame-out", () => {
    const {pipeline, settings} = pipelineFixture();
    try {
        const flame = pipeline._surface({temperatureK: 1400, emissivity: 0.05, transmittance: 0.95, volume: true}, new MeshBasicMaterial(), settings, new Vector3(0, 0, 1));
        // An emitting, absorbing volume: source T e B + e P, alpha e, no reflection and no inner row.
        expect(flame).toMatchObject({transparent: true, depthWrite: false});
        expect(flame.uniforms.transmittance.value).toBe(0.95);
        expect(flame.uniforms.innerRow.value).toBe(0);
        const emission = new Float64Array(12);
        BANDS.forEach((band, index) => {
            const minUm = Math.max(settings.bandMinUm, band.minM * 1e6), maxUm = Math.min(settings.bandMaxUm, band.maxM * 1e6);
            if (maxUm > minUm) emission[index] = 0.05 * inBandRadiance(1400, {minUm, maxUm}).photon;
        });
        const expected = sourceRangeLUT(pipeline.rangeLUT, emission, 0.05), data = flame.uniforms.rangeTexture.value.image.data;
        for (let sample = 0; sample < pipeline.rangeLUT.size; sample++) {
            expect(data[sample * 4]).toBeCloseTo(expected[sample], 4);
            expect(data[sample * 4 + 1]).toBe(0);
        }
        const scene = new Scene(), camera = new PerspectiveCamera(1, 1, 1, 20000);
        const out = new Mesh(new BoxGeometry(0.05, 0.12, 0.05), new MeshBasicMaterial());
        out.userData.thermal = {temperatureK: 1400, emissivity: 0, transmittance: 1, volume: true}; out.position.set(0, 0, -2000);
        scene.add(out); camera.updateMatrixWorld(true);
        let visibleDuringDraw;
        pipeline._target = () => ({texture: {}}); pipeline._pass = () => {};
        pipeline._drawRadiance = () => {visibleDuringDraw = out.visible;};
        pipeline._radiance(scene, camera, settings, {width: 64, height: 64, viewport: new Vector4()}, 0);
        expect(visibleDuringDraw).toBe(false);
        expect(out.visible).toBe(true);
    } finally {pipeline.dispose();}
});

test("a volume inside a shell is drawn between the shell's far wall and near wall", () => {
    const {pipeline} = pipelineFixture();
    const material = new MeshBasicMaterial({side: DoubleSide});
    const shell = new Mesh(new SphereGeometry(0.3), material), flame = new Mesh(new BoxGeometry(0.05, 0.1, 0.05), new MeshBasicMaterial());
    const ground = new Mesh(new BoxGeometry(1, 1, 1));
    const name = mesh => mesh === shell ? "shell" : mesh === flame ? "flame" : "ground";
    const scene = new Scene(); scene.children = [shell, flame, ground];
    const calls = [];
    pipeline.renderer.render = drawn => calls.push(drawn.children.filter(mesh => mesh.visible)
        .map(mesh => mesh === shell ? `shell:${material.side === BackSide ? "back" : material.side === FrontSide ? "front" : "double"}` : name(mesh)).join(","));
    pipeline._drawSky = () => {}; pipeline.renderer.clear = () => {};
    pipeline.transmissiveLayers = [{mesh: shell, depthM: 2000, volumes: [flame]}];
    pipeline._drawRadiance(scene, new PerspectiveCamera(), {}, 0);
    expect(calls).toEqual(["ground", "shell:back", "flame", "shell:front"]);
    expect(material.side).toBe(DoubleSide);
    expect(shell.visible && flame.visible).toBe(true);
    pipeline.dispose();
});

test("a scattering layer in an isothermal enclosure still gives the enclosure radiance on both faces", () => {
    const {pipeline} = pipelineFixture();
    const settings = normalizeSettings({environmentTemperatureK: 300, solarScale: 0});
    try {
        const layer = {temperatureK: 300, emissivity: 0.45, transmittance: 0.3, directTransmittance: 0.03};
        const outer = pipeline._surfaceSpectrum(layer, settings), inner = pipeline._surfaceSpectrum({...layer, interior: true}, settings);
        expect(outer.transmittance).toBe(0.03);
        BANDS.forEach((band, index) => {
            const minUm = Math.max(settings.bandMinUm, band.minM * 1e6), maxUm = Math.min(settings.bandMaxUm, band.maxM * 1e6);
            if (maxUm <= minUm) return;
            const enclosure = inBandRadiance(300, {minUm, maxUm}).photon;
            // Own emission + reflection + scattered transmission, plus the 0.03 image of the enclosure behind.
            relative(outer.emission[index] + 0.03 * enclosure, enclosure, 1e-9);
            relative(inner.emission[index] + 0.03 * enclosure, enclosure, 1e-9);
        });
    } finally {pipeline.dispose();}
});

test("band transmission at a distance is sampled like the shader samples a range texture", () => {
    const {pipeline} = pipelineFixture();
    try {
        const {size, maxRangeM, transmission} = pipeline.rangeLUT;
        for (const sample of [0, 3, size - 1]) {
            const distance = (sample / (size - 1)) ** 2 * maxRangeM, bands = pipeline._rangeTransmission(distance);
            for (let band = 0; band < 12; band++) expect(bands[band]).toBeCloseTo(transmission[sample * 12 + band], 6);
        }
    } finally {pipeline.dispose();}
});

test("a flame volume's in-band intensity is e B(T) times its side-view ellipse area", () => {
    const {pipeline, settings} = pipelineFixture();
    try {
        const flame = new Mesh(new SphereGeometry(1, 12, 10)); flame.scale.set(0.025, 0.0625, 0.025); flame.updateMatrixWorld(true);
        const bands = pipeline._volumeIntensity(flame, {temperatureK: 1400, emissivity: 0.05}, settings);
        const area = Math.PI * 0.025 * 0.0625;
        const expected = BANDS.reduce((sum, band) => {
            const minUm = Math.max(settings.bandMinUm, band.minM * 1e6), maxUm = Math.min(settings.bandMaxUm, band.maxM * 1e6);
            return maxUm > minUm ? sum + 0.05 * inBandRadiance(1400, {minUm, maxUm}).photon * area : sum;
        }, 0);
        // The sphere geometry's bounding box is slightly inside the unit sphere at 12 x 10 segments.
        relative(bands.reduce((a, b) => a + b, 0), expected, 0.02);
    } finally {pipeline.dispose();}
});

test("a shell's flame glow uniform is set for its own draw and cleared afterwards", () => {
    const {pipeline} = pipelineFixture();
    const material = new MeshBasicMaterial({side: DoubleSide});
    material.uniforms = {glowSource: {value: new Vector4()}};
    const shell = new Mesh(new SphereGeometry(0.3), material), flame = new Mesh(new BoxGeometry(0.05, 0.1, 0.05));
    const scene = new Scene(); scene.children = [shell, flame];
    const seen = [];
    pipeline.renderer.render = drawn => { if (drawn.children.some(mesh => mesh === shell && mesh.visible)) seen.push(material.uniforms.glowSource.value.clone()); };
    pipeline._drawSky = () => {}; pipeline.renderer.clear = () => {};
    const camera = new PerspectiveCamera(); camera.updateMatrixWorld(true);
    const bands = new Float64Array(12).fill(1e20);
    pipeline.transmissiveLayers = [{mesh: shell, depthM: 2000, volumes: [flame], glow: {world: new Vector3(0, 0, -2000), bands, total: 12e20}}];
    pipeline._drawRadiance(scene, camera, {}, 0);
    const expected = pipeline._rangeTransmission(2000).reduce((sum, t) => sum + t, 0);
    expect(seen).toHaveLength(2);
    for (const value of seen) { expect(value.z).toBeCloseTo(-2000, 6); expect(value.w).toBeCloseTo(expected, 6); }
    expect(material.uniforms.glowSource.value.w).toBe(0);
    pipeline.dispose();
});
