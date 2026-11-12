/** @jest-environment jsdom */
import {Group, PerspectiveCamera, Sphere, Vector3} from "three";
import {updateObjectLocatorRings} from "../src/ObjectLocatorOverlay";

jest.mock("../src/CViewManager", () => ({ViewMan: {screenOffsetX: 0}}));

let view;
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
beforeEach(() => {
    const div = document.createElement("div"), canvas = document.createElement("canvas");
    document.body.append(div); div.append(canvas);
    div.getBoundingClientRect = () => rect(200, 30, 800, 600);
    canvas.getBoundingClientRect = () => rect(200, 130, 800, 400);
    const camera = new PerspectiveCamera(60, 2, 1, 10000);
    camera.updateMatrixWorld();
    view = {id: "mainView", div, canvas, camera, widthPx: 800, heightPx: 600};
});
afterEach(() => view.div.remove());

function object(id, diameter) {
    const group = new Group();
    group.position.z = -1000;
    // Independent perspective sizing: a 400px image spans 2*z*tan(FOV/2) metres.
    const units = 2 * 1000 * Math.tan(Math.PI / 6) / 400;
    return {id, group, cachedBoundingSphere: new Sphere(new Vector3(), diameter * units / 2)};
}
const rings = () => [...view.div.querySelectorAll(".object-locator-ring")];

test("100 CSS pixel rings fade by projected diameter, independent of backing resolution", () => {
    view.canvas.width = 1600; view.canvas.height = 800;
    updateObjectLocatorRings(view, [object("small", 25), object("solid", 50), object("half", 62.5), object("large", 76)]);
    expect(rings().map(r => r.dataset.objectId)).toEqual(["small", "solid", "half"]);
    rings().forEach((ring, i) => expect(Number(ring.style.opacity)).toBeCloseTo([1, 1, 0.5][i]));
    for (const ring of rings()) {
        expect(ring.style.width).toBe("100px");
        expect(ring.style.height).toBe("100px");
        expect(ring.style.pointerEvents).toBe("none");
    }
    updateObjectLocatorRings(view, [object("edge", 75)]);
    expect(rings()).toHaveLength(0);
});

test("rings follow the object origin through a letterboxed pane and respect world scale", () => {
    const node = object("scaled", 31.25), parent = new Group();
    parent.scale.set(2, 1, 1); parent.add(node.group);
    node.group.position.x = 100;
    node.cachedBoundingSphere.center.x = 30;
    updateObjectLocatorRings(view, [node]);
    const ring = rings()[0];
    expect(Number(ring.style.opacity)).toBeCloseTo(0.5);
    expect(parseFloat(ring.style.left)).toBeCloseTo(400 + 200 * 200 / (1000 * Math.tan(Math.PI / 6)));
    expect(ring.style.top).toBe("200px");
    expect(view._objectLocatorOverlay.style.top).toBe("100px");
    expect(view._objectLocatorOverlay.style.height).toBe("400px");
    expect(view._objectLocatorOverlay.style.overflow).toBe("hidden");
});

test("off-screen and behind-camera objects have no rings, and releasing selection clears old rings", () => {
    const behind = object("behind", 10), outside = object("outside", 10), shown = object("shown", 10);
    behind.group.position.z = 1000; outside.group.position.x = 10000;
    updateObjectLocatorRings(view, [behind, outside, shown]);
    expect(rings().map(r => r.dataset.objectId)).toEqual(["shown"]);
    shown.group.position.x = 10000;
    updateObjectLocatorRings(view, [shown]);
    expect(rings()).toHaveLength(0);
    shown.group.position.x = 0;
    updateObjectLocatorRings(view, [shown]);
    updateObjectLocatorRings(view, []);
    expect(rings()).toHaveLength(0);
});

test("the look view never gets locator rings", () => {
    view.id = "lookView";
    updateObjectLocatorRings(view, [object("small", 10)]);
    expect(view._objectLocatorOverlay).toBeUndefined();
});
