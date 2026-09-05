/** @jest-environment jsdom */
import {PerspectiveCamera, Vector2, Vector3} from "three";
import {offsetWorldPointPixels, projectWorldToView} from "../src/ViewUtils";

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});
jest.mock("../src/Globals", () => {
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    return new Proxy({}, {get: () => () => inert});
});
const {CNodeFeatureMarker} = require("../src/nodes/CNodeLabels3D");
const {CNodeDisplaySkyOverlay, registerLabel3D, unregisterLabel3D} = require("../src/nodes/CNodeDisplaySkyOverlay");
const {FeatureManager} = require("../src/CFeatureManager");
const threeExt = require("../src/threeExt");

test.each([false, true])("feature arrow, rendered label and grab target preserve saved length (letterbox %s)", letterbox => {
    const camera = new PerspectiveCamera(50, 4 / 3, 0.1, 2000);
    camera.position.set(6378237, 0, 100);
    camera.lookAt(6378137, 0, 0);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const view = {
        camera, widthPx: 800, heightPx: 600, leftPx: 0, topPx: 0,
        div: {getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600})},
        canvas: {getBoundingClientRect: () => ({left: 0, top: letterbox ? 75 : 0, width: 800, height: letterbox ? 450 : 600})},
        offsetScreenPixels(position, x, y) { return offsetWorldPointPixels(this, position, x, y); },
    };
    const marker = Object.assign(Object.create(CNodeFeatureMarker.prototype), {
        id: "pin", text: "Test Pin", textAlign: "center", size: 12,
        featurePosition: new Vector3(6378137, 0, 0), textPosition: new Vector3(6378137, 0, 0),
        arrowLength: 100, offset: new Vector2(0, 100), arrowColor: 0xff0000,
        _object: {visible: true}, groupNode: {group: {layers: camera.layers}},
        layerMask: camera.layers.mask, shouldRender: () => true,
    });
    const arrow = jest.spyOn(threeExt, "DebugArrowAB").mockImplementation(() => {});
    const ctx = {fillText: jest.fn()};
    const overlay = {
        camera, overlayView: view, ctx,
        renderLabels3D: CNodeDisplaySkyOverlay.prototype.renderLabels3D,
        labelXY: ndc => [400 * (ndc.x + 1), (letterbox ? 75 : 0) + (1 - ndc.y) * (letterbox ? 225 : 300)],
    };
    registerLabel3D(marker);
    try {
        for (const length of [100, 200, 0]) {
            marker.arrowLength = length;
            marker.offset.y = length;
            overlay.renderLabels3D(0, camera);
            const base = projectWorldToView(view, marker.featurePosition);
            const top = projectWorldToView(view, arrow.mock.calls.at(-1)[1]);
            const text = ctx.fillText.mock.calls.at(-1);
            const grabs = FeatureManager.featureScreenPoints(marker, view);
            expect(base[1] - top[1]).toBeCloseTo(length / 2, 7);
            expect(text[1]).toBeCloseTo(top[0], 7);
            expect(text[2]).toBeCloseTo(top[1], 7);
            expect(grabs[1].x).toBeCloseTo(top[0], 7);
            expect(grabs[1].y).toBeCloseTo(top[1], 7);
        }
    } finally {
        unregisterLabel3D(marker);
        arrow.mockRestore();
    }
});
