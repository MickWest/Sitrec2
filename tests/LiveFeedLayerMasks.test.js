// The live overlays (Live ADS-B Traffic and the other Live Feeds) are drawn in
// the main view only. three.js tests each object's own layer mask against the
// camera's, and a mask set on a Group does not reach its children, so every
// mesh inside the layer's group must carry the group's mask. When the meshes
// kept the default WORLD mask, the look camera drew huge aircraft darts sized
// for the main camera's distance.
import {expect, jest, test} from "@jest/globals";
import {PerspectiveCamera} from "three";
import {MASK_HELPERS, MASK_LOOKRENDER, MASK_MAINRENDER} from "../src/LayerMasks";
import {CNodeADSBLiveTraffic} from "../src/traffic/CNodeADSBLiveTraffic";
import {CNodeLiveFeedLayer} from "../src/livefeeds/CNodeLiveFeedLayer";

// Only what the constructors reach is real: CNode3DGroup itself, the layer masks,
// three.js and the scene-line classes. The rest of the app is stubbed.
jest.mock("../src/nodes/CNode3D", () => ({
    CNode3D: class {
        constructor(v) {
            this.id = v.id;
            this.visible = true;
        }
        update() {}
        dispose() {}
    },
}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: {add: () => {}, remove: () => {}}}));
jest.mock("../src/Globals", () => ({
    Globals: {}, FileManager: {}, NodeMan: {exists: () => false}, Sit: {},
    guiShowHide: {}, setRenderOne: () => {},
}));
// Same behaviour as threeExt's propagateLayerMaskObject: copy the parent's mask
// onto every descendant. threeExt itself pulls in most of the app.
jest.mock("../src/threeExt", () => ({
    propagateLayerMaskObject: (parent) => parent.traverse(child => {
        child.layers.mask = parent.layers.mask;
    }),
    dispose: () => {},
}));
jest.mock("../src/KeyBoardHandler", () => ({toggles: {}}));
jest.mock("../src/ConvertColorInputs", () => ({convertColorInput: () => {}}));
jest.mock("../src/assert", () => ({assert: () => {}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {}}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/SphericalMath", () => ({}));
jest.mock("../src/EGM96Geoid", () => ({}));
jest.mock("../src/ADSBLiveFetch", () => ({}));
jest.mock("../src/CoordinateFormat", () => ({}));
jest.mock("../src/livefeeds/LiveFeedOverlay", () => ({}));
jest.mock("../src/livefeeds/LiveFeedFetch", () => ({}));
jest.mock("../src/BYOKKeyStore", () => ({}));

function expectMainViewOnly(group) {
    const mainCamera = new PerspectiveCamera();
    mainCamera.layers.mask = MASK_MAINRENDER;
    const lookCamera = new PerspectiveCamera();
    lookCamera.layers.mask = MASK_LOOKRENDER;

    expect(group.layers.mask).toBe(MASK_HELPERS);
    let drawn = 0;
    group.traverse(object => {
        expect(object.layers.mask).toBe(group.layers.mask);
        if (object === group) return;
        drawn++;
        expect(object.layers.test(mainCamera.layers)).toBe(true);
        expect(object.layers.test(lookCamera.layers)).toBe(false);
    });
    return drawn;
}

test("Live ADS-B Traffic darts and trails are in the main view only", () => {
    const node = new CNodeADSBLiveTraffic({id: "liveTrafficTest"});
    // The InstancedMesh of darts and the LineSegments of trails.
    expect(expectMainViewOnly(node.group)).toBe(2);
    expect(node.group.children).toContain(node.instances);
    expect(node.group.children).toContain(node.trails);
});

test.each(["dart", "cone", "box", "sphere", "octahedron"])(
    "Live Feed '%s' markers are in the main view only", (shape) => {
        const node = new CNodeLiveFeedLayer({
            id: `liveFeedTest_${shape}`,
            feed: {id: "test", shape, color: 0xffffff, pollMs: 60000},
        });
        expect(expectMainViewOnly(node.group)).toBe(1);
        expect(node.group.children).toContain(node.instances);
    });
