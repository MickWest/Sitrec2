import {PerspectiveCamera, Vector3} from "three";
const mockLook = {camera: new PerspectiveCamera(40, 2, 0.1, 1000)};
jest.mock("../src/Globals", () => ({NodeMan: {get: () => mockLook}}));
jest.mock("../src/ViewUtils", () => ({withDisplayedCamera: (view, draw) => draw(view.camera)}));
jest.mock("../src/FlowAlignment", () => ({getFlowAlignRotation: () => 0}));
jest.mock("../src/FisheyeProjection", () => ({isFisheyeCamera: () => false}));
jest.mock("../src/PanoramicCamera", () => ({isPanoramicCamera: () => false}));
import {videoSkyProjection} from "../src/VideoSkyProjection";

test("video labels follow the source aspect, crop and stabilization independently of look-pane framing", () => {
    mockLook.camera.updateMatrixWorld();
    const video = {videoWidth: 1200, videoHeight: 1600, sx: 100, sy: 200, sWidth: 600, sHeight: 800,
        dx: 10, dy: 30, dWidth: 300, dHeight: 400, getSourceAndDestCoords() {},
        videoData: {stabilizationMatrix: () => ({a: 1, b: 0, c: 0, d: 1, e: 20, f: -10})}};
    const projected = videoSkyProjection(video, 0);
    expect(projected.clipRect).toEqual({x: 10, y: 30, w: 300, h: 400});
    expect(projected.camera.aspect).toBe(0.75);
    expect(projected.camera.fov).toBe(40);
    expect(projected.labelXY(new Vector3(0, 0, 0))).toEqual([270, 325]);
    const direction = new Vector3(0, 0, -100).project(projected.camera);
    expect(projected.labelXY(direction)).toEqual([270, 325]);
    expect(mockLook.camera.aspect).toBe(2);
});
