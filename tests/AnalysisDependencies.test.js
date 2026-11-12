import {Vector3} from "three";
import {dependsOnCameraHeading} from "../src/AnalysisDependencies";
import {captureInputFiltering} from "../src/AnalysisFiltering";

// Exercise the production dependency methods without constructing the scene/UI.
jest.mock("../src/nodes/CNode", () => ({CNode: class {}}));
jest.mock("../src/nodes/CNodeTrack", () => ({CNodeTrack: class {}}));
jest.mock("../src/nodes/CNodeLOS", () => ({CNodeLOS: class {}}));
jest.mock("../src/Globals", () => ({Sit: {frames: 301}}));
jest.mock("../src/SphericalMath", () => ({}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/utils", () => ({}));
jest.mock("../src/FitSurfacePick", () => ({}));
jest.mock("../src/CViewManager", () => ({}));
jest.mock("../src/GroundTrackHandles3D", () => ({}));
jest.mock("../src/CKeyframeRegistry", () => ({}));
jest.mock("../src/CEventManager", () => ({}));
jest.mock("../src/atmosphere/refractionAim", () => ({}));
const {CNodeGroundTrackLOS} = require("../src/nodes/CNodeGroundTrackLOS");
const {CNodeGroundTrack} = require("../src/nodes/CNodeGroundTrack");
const {CNodeLOSFromCamera} = require("../src/nodes/CNodeLOSFromCamera");

const context = {fps: 30, frame0: 0, frame1: 300};
const positionFilter = id => ({id, smoothingKind: "position", method: "moving", frames: 301,
    in: {window: {v0: 20}, source: {frames: 301}}});

function scene() {
    const cameraPosition = positionFilter("cameraTrackSwitchSmooth");
    const targetPosition = positionFilter("targetTrackSwitchSmooth");
    const camera = {in: {toTarget: {isController: true, enabled: true,
        analysisPositionInputs: ["sourceTrack"], in: {sourceTrack: cameraPosition, targetTrack: targetPosition}}}};
    const cameraLOS = Object.assign(Object.create(CNodeLOSFromCamera.prototype), {
        id: "JetLOSCameraCenter", in: {cameraNode: camera},
        getValueFrame: () => ({position: new Vector3(0, 0, 100), heading: new Vector3(1, 0, 0)}),
    });
    const ground = Object.assign(Object.create(CNodeGroundTrack.prototype), {
        id: "groundTrack", smoothingKind: "groundTracking", enabled: false,
        keyframes: [{frame: 0}, {frame: 30}, {frame: 330}], curveType: "Spline", betweenPoints: "3D Position",
        in: {cameraLOSNode: cameraLOS}, getGroundPosition: () => new Vector3(100, 200, 0),
    });
    const los = Object.assign(Object.create(CNodeGroundTrackLOS.prototype), {
        id: "groundTrackLOS", frames: 301, in: {cameraLOSNode: cameraLOS, groundTrack: ground},
    });
    return {los, ground, cameraLOS, camera};
}

test.each(["3D Position", "Ground Intersection"])("%s ground rays use position but not target-aimed attitude", mode => {
    const {los, ground} = scene();
    ground.betweenPoints = mode;
    expect(dependsOnCameraHeading(los, context)).toBe(false);
    const before = los.getValueFrame(100);
    expect(before.heading.distanceTo(new Vector3(100, 200, -100).normalize())).toBeLessThan(1e-12);
    const rows = captureInputFiltering([{node: los, role: "Sightlines"}], context);
    expect(rows.map(row => row.source).sort()).toEqual(["Camera position", "Ground track"]);
    const row = rows.find(row => row.source === "Ground track");
    expect(row.status).toBe("active"); // editing disabled does not disable the saved track
    expect(row.method).toContain(mode);
    expect(row.detail).toContain("3 keyframes (2 within the analysis window)");
    expect(row.detail).toContain("1 s–10 s");
    expect(row.detail).toContain("outside frames 0–330");
    expect(los.getValueFrame(100).heading.toArray()).toEqual(before.heading.toArray());
});

test.each([null, new Vector3(0, 0, 100)])("missing or degenerate ground point retains the attitude fallback", point => {
    const {los, ground, cameraLOS} = scene();
    ground.getGroundPosition = f => f === 120 ? point : new Vector3(100, 200, 0);
    expect(los.getValueFrame(120).heading.toArray()).toEqual(cameraLOS.getValueFrame(120).heading.toArray());
    expect(dependsOnCameraHeading(los, context)).toBe(true);
    expect(dependsOnCameraHeading(los, {...context, frame1: 119})).toBe(false);
    const rows = captureInputFiltering([{node: los, role: "Sightlines"}], context);
    expect(rows.some(row => row.source === "Target position")).toBe(true);
});

test("camera-center and pixel-offset rays keep the warning; only the selected switch branch counts", () => {
    const {los, cameraLOS} = scene();
    const pixelLOS = {id: "pixel", in: {cameraLOSNode: cameraLOS}};
    expect(dependsOnCameraHeading(cameraLOS, context)).toBe(true);
    expect(dependsOnCameraHeading(pixelLOS, context)).toBe(true);
    const sw = {in: {los, pixelLOS}, getObject: () => los};
    expect(dependsOnCameraHeading(sw, context)).toBe(false);
    sw.getObject = () => pixelLOS;
    expect(dependsOnCameraHeading(sw, context)).toBe(true);
});

test("disabled camera controllers do not contribute position filters", () => {
    const {los, camera} = scene();
    camera.in.toTarget.enabled = false;
    expect(captureInputFiltering([{node: los, role: "Sightlines"}], context).map(row => row.source)).toEqual(["Ground track"]);
});

test("position filtering follows the selected camera controller inside a switch", () => {
    const {los, camera} = scene();
    const active = camera.in.toTarget;
    camera.in.toTarget = {getObject: () => active, in: {active,
        unused: {analysisPositionInputs: ["sourceTrack"], in: {sourceTrack: positionFilter("unused")}}}};
    expect(captureInputFiltering([{node: los, role: "Sightlines"}], context).map(row => row.source))
        .toEqual(["Camera position", "Ground track"]);
});
