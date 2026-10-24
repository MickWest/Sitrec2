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
import {Globals, setNodeMan, setSynth3DManager} from '../src/Globals';
import {LLAToECEF} from '../src/LLA-ECEF-ENU';

jest.mock("../src/EGM96Geoid", () => ({
    __esModule: true,
    ...jest.requireActual("../src/EGM96Geoid"),
    meanSeaLevelOffset: () => -30,   // = GEOID
}));
jest.mock("../src/threeExt", () => ({
    __esModule: true,
    ...jest.requireActual("../src/threeExt"),
    elevationAtLL: jest.fn(() => 0),
}));

// Geoid height N (HAE = MSL + N): non-zero, so a mix-up of HAE and MSL shows.
const GEOID = -30;
const LAT = 34.5, LON = -111.8;
const GROUND_MSL = 2020;                   // about 6630 ft, as in the report
const GROUND_HAE = GROUND_MSL + GEOID;

let nodeMan, menu, menuData, camera, target;

function makeMenu() {
    const controller = {name: () => controller, disable: () => controller};
    return {
        open: jest.fn(), destroy: jest.fn(), addHTML: jest.fn(), addHeading: jest.fn(),
        add: (obj, key) => { menuData = obj; return controller; },
    };
}

// Right-click the ground at LAT, LON, GROUND_HAE.
function rightClickGround() {
    const self = {groundContextMenu: null};
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
    camera = {id: "fixedCameraPosition", agl: false, setLLA: jest.fn()};
    target = {id: "fixedTargetPositionWind", agl: false, setLLA: jest.fn()};
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
