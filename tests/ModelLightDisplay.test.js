import {Group, InstancedMesh, Matrix4, PerspectiveCamera, PointLight, SpotLight, Vector3} from "three";
import {flashFraction, memberStrobeOffset, modelLightAdaptationLux, peakCandela} from "../src/ModelLightDisplay";
import {CNode3DLight} from "../src/nodes/CNode3DLight";

jest.mock("../src/nodes/CNode3D", () => ({CNode3D: class {
    constructor(v) { this.id = v.id; }
    update() {}
    dispose() {}
    addSimpleSerial() {}
}}));
jest.mock("../src/nodes/CNodeGUIValue", () => ({CNodeGUIValue: class {}}));
jest.mock("../src/nodes/CNodeGUIColor", () => ({CNodeGUIColor: class {}}));
jest.mock("../src/Globals", () => ({
    Sit: {fps: 30}, NodeMan: {disposeRemove() {}, get: () => ({calculateSkyBrightness: () => 0.7575})}
}));
jest.mock("../src/atmosphere/terrestrialRefraction", () => ({installTerrestrialRefractionOnShaderMaterial() {}}));

test("dusk preserves contrast for a short 3 km aircraft flash while a brighter sky raises the threshold", () => {
    const dusk = modelLightAdaptationLux(0.7575);
    expect(dusk).toBeGreaterThan(modelLightAdaptationLux(0));
    expect(dusk).toBeLessThan(modelLightAdaptationLux(1));
    const flashLux = peakCandela(2717, 1, 0.01) * 0.3 / (3190 ** 2);
    const navLux = peakCandela(543, 0, 0) / (3190 ** 2);
    expect(flashLux).toBeGreaterThan(10 * dusk);
    expect(flashLux).toBeGreaterThan(10 * navLux);
    expect(peakCandela(0, 1, 0.01)).toBe(0);
    expect(peakCandela(100, 1, 1)).toBe(20);
});

test("a 10 ms flash keeps its integrated energy at every member phase", () => {
    for (const i of [0, 1, 2, 217]) {
        const offset = memberStrobeOffset(i, 1);
        const sum = Array.from({length: 30}, (_, f) => flashFraction(f / 30 + offset, 0.01, 1 / 30))
            .reduce((a, b) => a + b);
        expect(sum / 30).toBeCloseTo(0.01, 12);
    }
});

test("flock lamp switches between three independent sources and the original lamp", () => {
    const scene = new Group();
    scene.position.x = 12345;
    const mount = new Group();
    mount.position.z = -2;
    const light = new PointLight(0xffffff, 2717);
    light.position.x = 5;
    light.userData = {strobeEvery: 1, strobeLength: 0.01};
    scene.add(mount); mount.add(light);
    const node = new CNode3DLight({id: "wing", light, scene});
    node.strobeOffset = 0;
    const mesh = new InstancedMesh(node._object.geometry, node._object.material, 3);
    for (let i = 0; i < 3; i++) mesh.setMatrixAt(i, new Matrix4().makeTranslation(i * 100 + 5, 0, -2));
    scene.add(mesh); scene.updateMatrixWorld(true);
    const view = {camera: new PerspectiveCamera(), heightPx: 869};
    node.setFlockBillboard(mesh);
    node.lightIlluminates = true;
    const seen = new Set();
    function check(frame) {
        node.update(frame); node.preRender(view);
        expect(node.memberCount).toBe(3);
        expect(node._object.visible).toBe(false);
        expect(light.visible).toBe(false);
        const on = [];
        for (let i = 0; i < 3; i++) {
            expect(node.memberPosition(i, new Vector3()).toArray()).toEqual([12350 + i * 100, 0, -2]);
            if (node.flashAt(i) > 1e-6) on.push(i);
        }
        const lit = node.illuminators.filter(lamp => lamp.visible).map(lamp => (lamp.position.x - 5) / 100);
        expect(lit).toEqual(on);
        expect(on.length).toBeLessThanOrEqual(1);
        if (on.length) seen.add(on[0]);
        return on;
    }
    for (let f = 0; f < 30; f++) check(f);
    expect(seen).toEqual(new Set([0, 1, 2]));
    expect(check(1)).toEqual([0]);
    expect(check(1)).toEqual([0]);
    node.suppressBillboard = true; check(1); expect(mesh.visible).toBe(false);
    node.suppressBillboard = false;
    node.setLightVisible(false); node.preRender(view); expect(node.illuminators).toHaveLength(0);
    node.setFlockBillboard(null); node.setLightVisible(true); node.update(1); node.preRender(view);
    expect(node.memberCount).toBe(1);
    expect(node._object.getWorldPosition(new Vector3()).toArray()).toEqual([12350, 0, -2]);
    expect(light.visible).toBe(true);
    node.dispose(); mesh.dispose();
});

test("a landing spotlight follows each aircraft's heading in an exposure", () => {
    const scene = new Group();
    const light = new SpotLight(0xffffff, 100, 0, 0.3);
    scene.add(light);
    light.add(light.target);
    light.target.position.set(0, 0, -1);
    const node = new CNode3DLight({id: "landing", light, scene});
    const mesh = new InstancedMesh(node._object.geometry, node._object.material, 2);
    mesh.setMatrixAt(0, new Matrix4());
    mesh.setMatrixAt(1, new Matrix4().makeRotationY(Math.PI));
    scene.add(mesh); scene.updateMatrixWorld(true);
    node.setFlockBillboard(mesh);
    const camera = new PerspectiveCamera(); camera.position.z = -100;
    node.preRender({camera, heightPx: 869});
    expect(node.candelaToward(0, camera.position, new Vector3())).toBe(20);
    expect(node.candelaToward(1, camera.position, new Vector3())).toBe(0);
    node.setFlockBillboard(null); node.dispose(); mesh.dispose();
});
