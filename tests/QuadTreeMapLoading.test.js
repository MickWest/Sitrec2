jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/QuadTreeTile", () => ({QuadTreeTile: jest.fn()}));

import {QuadTreeMapTexture} from "../src/QuadTreeMapTexture";

test("tracks high-resolution loads after initial readiness without repeating the loaded callback", async () => {
    const map = Object.create(QuadTreeMapTexture.prototype);
    Object.assign(map, {loaded: false, scene: {}, pendingTileLoads: new Set(), loadedCallback: jest.fn()});
    let finishInitial;
    const initial = new Promise(resolve => {finishInitial = resolve;});
    map.trackTileLoading("initial", initial);
    expect(map.pendingTileLoads.size).toBe(1);
    finishInitial(); await initial;
    expect(map.loaded).toBe(true);
    expect(map.loadedCallback).toHaveBeenCalledTimes(1);

    let finishHighRes;
    const highRes = new Promise(resolve => {finishHighRes = resolve;});
    map.trackTileLoading("highres", highRes);
    expect(map.pendingTileLoads.has("highres")).toBe(true);
    finishHighRes(); await highRes;
    expect(map.pendingTileLoads.size).toBe(0);
    expect(map.loadedCallback).toHaveBeenCalledTimes(1);
});
