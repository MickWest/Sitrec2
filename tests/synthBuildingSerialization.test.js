import {CNodeSynthBuilding} from "../src/nodes/CNodeSynthBuilding";

jest.mock("../src/nodes/CNode3DGroup", () => ({CNode3DGroup: class {
    constructor(v) { this.visible = v.visible ?? true; }
}}));
jest.mock("../src/Globals", () => ({}));
jest.mock("../src/showError", () => ({}));
jest.mock("../src/SphericalMath", () => ({}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CEventManager", () => ({}));
jest.mock("../src/i18n", () => ({}));
jest.mock("../src/CViewManager", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));

beforeEach(() => {
    // Exercise the real constructor and save/load methods without terrain, rendering or UI.
    for (const method of ["recalculateVerticesFromTerrain", "buildMesh", "setupEventListeners", "createGUIFolder"]) {
        jest.spyOn(CNodeSynthBuilding.prototype, method).mockImplementation(() => {});
    }
});
afterEach(() => jest.restoreAllMocks());

const buildingData = {
    id: "building1", name: "Building 1",
    cornerLatLons: [{lat: 34, lon: -118}, {lat: 34, lon: -117.999},
        {lat: 34.001, lon: -117.999}, {lat: 34.001, lon: -118}],
    roofAGL: 12, rooflineHeightAGL: 3, ridgelineInset: 0.5,
};

test.each([0, 1.25])("a saved building retains its %s m roof overhang", roofEaves => {
    const building = new CNodeSynthBuilding({...buildingData, roofEaves});
    const saved = JSON.parse(JSON.stringify(building.serialize()));
    const restored = CNodeSynthBuilding.deserialize(saved);

    expect(restored.roofEaves).toBe(roofEaves);
    expect(restored.serialize()).toEqual(saved);
    expect(restored.cornerLatLons).not.toBe(saved.cornerLatLons);
});

test("a saved building without roofEaves retains the zero-overhang default", () => {
    expect(CNodeSynthBuilding.deserialize(buildingData).roofEaves).toBe(0);
});
