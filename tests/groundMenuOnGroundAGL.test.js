// Right-click ground menu, "Set Camera on Ground" and "Set Target on Ground", with the
// position's "Above Ground Level" (AGL) box on and off (Metabunk thread 15147). With AGL
// on, setLLA's altitude is the height ABOVE THE GROUND, so passing the ground's MSL
// height counted the ground twice: the camera went to an AGL height equal to the ground's
// MSL height (3315 ft AGL, 6630 ft MSL in the report).
// This drives the REAL menuMethods.showGroundContextMenu against a REAL CNodeManager.
// Only the menu widget, the terrain height, the geoid and the clouds/overlay lookup are
// stubbed, and the camera and target position nodes are fakes that record setLLA.
import {menuMethods} from '../src/CustomManagerMenus';
import {CNodeManager} from '../src/nodes/CNodeManager';
import {Globals, setNodeMan, setSit, setSynth3DManager, setTrackManager, TrackManager} from '../src/Globals';
import {ECEFToLLAVD_radii, LLAToECEF} from '../src/LLA-ECEF-ENU';

import {Matrix4, Vector3} from "three";
import {getVisiblePointBelow} from "../src/threeExt";

jest.mock("../src/nodes/CNode3DObject", () => ({CNode3DObject: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({
    __esModule: true,
    ...jest.requireActual("../src/EGM96Geoid"),
    meanSeaLevelOffset: () => -30,   // = GEOID
}));
jest.mock("../src/threeExt", () => ({
    __esModule: true,
    ...jest.requireActual("../src/threeExt"),
    elevationAtLL: jest.fn(() => 0),
    getVisiblePointBelow: jest.fn(),
}));

// Geoid height N (HAE = MSL + N): non-zero, so a mix-up of HAE and MSL shows.
const GEOID = -30;
const LAT = 34.5, LON = -111.8;
const GROUND_MSL = 2020;                   // about 6630 ft, as in the report
const GROUND_HAE = GROUND_MSL + GEOID;

let nodeMan, menu, menuData, camera, target;

function makeMenu() {
    const controller = {name: () => controller, tooltip: () => controller, disable: () => controller};
    const folders = new Map();
    return {
        folders, addFolder: jest.fn(label => {
            const folder = {add: jest.fn(() => controller), close: jest.fn().mockReturnThis()};
            folders.set(label, folder);
            return folder;
        }),
        open: jest.fn(), destroy: jest.fn(), addHTML: jest.fn(), addHeading: jest.fn(),
        add: jest.fn(obj => { menuData = obj; return controller; }),
    };
}

// Right-click the ground at LAT, LON, GROUND_HAE.
function rightClickGround() {
    const self = {groundContextMenu: null, getNextTrackAndObjectNames: () => ({trackName: "Track 1", objectName: "Object 1"})};
    menuMethods.showGroundContextMenu.call(self, 100, 200, LLAToECEF(LAT, LON, GROUND_HAE), "mainView");
    expect(menuData).toBeDefined();
}

beforeEach(() => {
    nodeMan = new CNodeManager();
    setNodeMan(nodeMan);
    setSynth3DManager({findOverlayAtLatLon: jest.fn(() => null), findCloudsAtLatLon: jest.fn(() => null)});
    menuData = undefined;
    menu = makeMenu();
    Globals.menuBar = {createStandaloneMenu: jest.fn(() => menu)};
    const position = id => ({id, agl: false, _LLA: [0, 0, 0],
        setLLA: jest.fn(function (...lla) { this._LLA = lla; })});
    camera = position("fixedCameraPosition");
    target = position("fixedTargetPositionWind");
    nodeMan.add("fixedCameraPosition", camera);
    nodeMan.add("fixedTargetPositionWind", target);
});

test("camera on ground with AGL on goes 2 m above the ground", () => {
    camera.agl = true;
    rightClickGround();
    menuData.setCameraOnGround();
    expect(camera.setLLA).toHaveBeenCalledTimes(1);
    const [lat, lon, alt] = camera.setLLA.mock.calls[0];
    expect(lat).toBeCloseTo(LAT, 9);
    expect(lon).toBeCloseTo(LON, 9);
    expect(alt).toBe(2);
    expect(menu.destroy).toHaveBeenCalled();
});

test("an explicit ground pick can open alongside a track editor", () => {
    Globals.editingTrack = {editMode: true};
    try {
        menuMethods.showGroundContextMenu.call({}, 100, 200, LLAToECEF(LAT, LON, GROUND_HAE), "mainView", {throughObjects: true});
        expect(Globals.menuBar.createStandaloneMenu).toHaveBeenCalledWith("Ground", 100, 200, true, true);
        expect(Globals.editingTrack.editMode).toBe(true);
    } finally { Globals.editingTrack = null; }
});

test("camera on ground with AGL off goes to the ground's MSL height plus 2 m", () => {
    camera.agl = false;
    rightClickGround();
    menuData.setCameraOnGround();
    expect(camera.setLLA).toHaveBeenCalledTimes(1);
    const [lat, lon, alt] = camera.setLLA.mock.calls[0];
    expect(lat).toBeCloseTo(LAT, 9);
    expect(lon).toBeCloseTo(LON, 9);
    expect(alt).toBeCloseTo(GROUND_MSL + 2, 4);
});

test("target on ground with AGL on goes 0 m above the ground", () => {
    target.agl = true;
    rightClickGround();
    menuData.setTargetOnGround();
    expect(target.setLLA).toHaveBeenCalledTimes(1);
    const [lat, lon, alt] = target.setLLA.mock.calls[0];
    expect(lat).toBeCloseTo(LAT, 9);
    expect(lon).toBeCloseTo(LON, 9);
    expect(alt).toBe(0);
    expect(menu.destroy).toHaveBeenCalled();
});

test("target on ground with AGL off goes to the ground's MSL height", () => {
    target.agl = false;
    rightClickGround();
    menuData.setTargetOnGround();
    expect(target.setLLA).toHaveBeenCalledTimes(1);
    const [lat, lon, alt] = target.setLLA.mock.calls[0];
    expect(lat).toBeCloseTo(LAT, 9);
    expect(lon).toBeCloseTo(LON, 9);
    expect(alt).toBeCloseTo(GROUND_MSL, 4);
});


test("the Add and Add (Legacy) folders are adjacent, closed and have distinct actions", () => {
    rightClickGround();
    expect([...menu.folders.keys()]).toEqual(["Add", "Add (Legacy)"]);
    for (const folder of menu.folders.values()) expect(folder.close).toHaveBeenCalledTimes(1);
    const actions = label => menu.folders.get(label).add.mock.calls.map(([, key]) => key);
    expect(actions("Add")).toEqual(["dropPin", "addFixedObject", "addFlyingObject", "addGroundedObject",
        "addBalloon", "addKite", "addSpotlight", "addBuilding", "addOverlay", "addGrid", "addRegion"]);
    expect(actions("Add (Legacy)")).toEqual(["createTrackWithObject", "createSyntheticTrack", "addClouds"]);
});

test.each([
    ["addFlyingObject", 300, 600, 700],
    ["addFlyingObject", 600, 300, 700],
    ["addFlyingObject", -300, -250, -150],
    ["addGroundedObject", 300, 600, 0],
])("%s over terrain at %im and %im initializes the lock at %im", (action, startHAE, endHAE, height) => {
    setSit({frames: 100, aFrame: 10, bFrame: 70});
    setTrackManager({addSyntheticTrack: jest.fn()});
    nodeMan.add("mainView", {camera: {matrixWorld: new Matrix4()}, pixelsToMeters: () => 50});
    getVisiblePointBelow.mockReset();
    for (const hae of [startHAE, endHAE]) getVisiblePointBelow.mockImplementationOnce(p => {
        const lla = ECEFToLLAVD_radii(p);
        return LLAToECEF(lla.x, lla.y, hae);
    });
    rightClickGround();
    menuData[action]();
    const options = TrackManager.addSyntheticTrack.mock.calls[0][0];
    const grounded = action === "addGroundedObject";
    expect(options).toMatchObject({altitudeLockAGL: grounded, constantSpeed: true, editMode: true, recordUndo: true});
    expect(options.altitudeLock).toBeCloseTo(height, 5);
    expect(options.initialPoints.map(([frame]) => frame)).toEqual([10, 70]);
    const [start, end] = options.initialPoints.map(p => new Vector3(...p.slice(1)));
    expect(start.distanceTo(end)).toBeCloseTo(50, 1);
    if (!grounded) {
        for (const p of [start, end]) expect(ECEFToLLAVD_radii(p).z).toBeCloseTo(height, 5);
    }
});
