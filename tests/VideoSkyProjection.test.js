import {PerspectiveCamera, Vector3} from "three";
const mockLook = {camera: new PerspectiveCamera(40, 2, 0.1, 1000)};
const mockController = {};
const mockDate = new Date("2025-09-20T04:50:27Z");
jest.mock("../src/Globals", () => ({
    NodeMan: {get: id => id === "starTrackCameraController" ? mockController : mockLook},
    GlobalDateTimeNode: {frameToDate: () => mockDate},
}));
jest.mock("../src/ViewUtils", () => ({withDisplayedCamera: (view, draw) => draw(view.camera)}));
jest.mock("../src/FlowAlignment", () => ({getFlowAlignRotation: () => 0}));
jest.mock("../src/FisheyeProjection", () => ({isFisheyeCamera: () => false}));
jest.mock("../src/PanoramicCamera", () => ({isPanoramicCamera: () => false}));
import {videoSkyProjection, projectSkyPoint} from "../src/VideoSkyProjection";
import {photoPixelToSky} from "../src/starTrack/SkyPhotoPlate";
import {tangentBasis} from "../src/starTrack/StarIdentify";
import {applyAnnualAberration, getEQJToECEFMatrix} from "../src/CelestialMath";

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

test("registered Video keeps its stars through Look rotation, zoom and time changes", () => {
    const plate = {version: 1, width: 1200, height: 1600, source: "photo.png",
        transform: {A: [1, 0], B: [0, 0]},
        model: {T: {A: [0.0003, 0], B: [-0.18, -0.24]}, c0: [1, 0, 0], b0: tangentBasis([1, 0, 0])}};
    Object.assign(mockController, {registerPhotoInSky: true, photoRegistration: plate});
    const video = {videoWidth: 1200, videoHeight: 1600, fileName: "photo.png",
        videoData: {img: {}}, sx: 0, sy: 0, sWidth: 1200, sHeight: 1600,
        dx: 0, dy: 0, dWidth: 300, dHeight: 400, getSourceAndDestCoords() {}};
    const project = () => {
        const p = videoSkyProjection(video, 0);
        const direction = applyAnnualAberration(new Vector3(...photoPixelToSky(plate, 900, 400)), mockDate)
            .transformDirection(getEQJToECEFMatrix(mockDate));
        return p.labelXY(projectSkyPoint(direction, p.camera));
    };
    expect(project()[0]).toBeCloseTo(225, 9);
    expect(project()[1]).toBeCloseTo(100, 9);
    mockLook.camera.rotation.set(0.8, -1.2, 0.4);
    mockLook.camera.fov = 110;
    mockLook.camera.zoom = 3;
    mockLook.camera.updateMatrixWorld();
    mockDate.setUTCMonth(11);
    expect(project()[0]).toBeCloseTo(225, 9);
    expect(project()[1]).toBeCloseTo(100, 9);
    video.fileName = "another-photo.png";
    expect(videoSkyProjection(video, 0).camera._skyPhotoProject).toBeUndefined();
    mockController.registerPhotoInSky = false;
});
