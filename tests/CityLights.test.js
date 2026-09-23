/** @jest-environment jsdom */
jest.mock("../src/Globals", () => ({
    guiMenus: {}, Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    NodeMan: {add: jest.fn(), get: jest.fn(() => undefined)},
    FileManager: {removeExportButton: jest.fn()}, setRenderOne: jest.fn(),
}));
jest.mock("../src/threeUtils", () => ({V3: () => new (require("three").Vector3)()}));
jest.mock("../src/configUtils", () => ({isConsole: false, isLocal: false}));

import {CNodeCityLights} from "../src/nodes/CNodeCityLights";
import {cityLightsUniforms, cityLightsDefault} from "../src/citylights/CityLightsShader";
import {getAttributionText, setTilesAttribution, disposeAttributionOverlay} from "../src/AttributionOverlay";
import {CityLightsMasks} from "../src/citylights/CityLightsMasks";
import {cityLightsRegion} from "../src/citylights/CityLightsRegion";

afterEach(() => disposeAttributionOverlay());

test("all city-light settings round-trip through the real node serialization", () => {
    const node = new CNodeCityLights({id: "cityLights"});
    expect(node.enabled).toBe(false);
    expect(node.masks.worker).toBeNull();
    Object.assign(node, {enabled: true, method: 4, roads: 23, paths: 4, windows: 71, intensity: 1.7, groundBrightness: .12});
    node.recalculate();
    const saved = JSON.parse(JSON.stringify(node.modSerialize()));
    node.dispose();
    const restored = new CNodeCityLights({id: "cityLights"});
    restored.modDeserialize(saved);
    for (const key of ["enabled", "method", "roads", "paths", "windows", "intensity", "groundBrightness"]) expect(restored[key]).toEqual(saved[key]);
    expect(cityLightsUniforms.cityWindows.value).toBe(.71);
    expect(cityLightsUniforms.cityGain.value).toBe(1.7);
    expect(cityLightsDefault()).toBe(true);
    restored.dispose();
    expect(cityLightsDefault()).toBe(false);
});

test("city-light credits join existing credits and are cleared when unused", () => {
    setTilesAttribution("Google");
    const node = new CNodeCityLights({id: "cityLights", enabled: true});
    expect(getAttributionText()).toContain("Google");
    expect(getAttributionText()).toContain("Overture Maps");
    expect(getAttributionText()).toContain("OpenStreetMap contributors");
    expect(document.getElementById("sitrec-attribution").textContent).toContain("Overture Maps");
    node.method = 2; node.recalculate();
    expect(getAttributionText()).toBe("Google");
    node.method = 3; node.recalculate();
    node.dispose();
    expect(getAttributionText()).toBe("Google");
});

test("stale worker results cannot replace a newer mask or survive disposal", () => {
    const workers = [];
    const previous = global.Worker;
    global.Worker = class {
        constructor() {workers.push(this);}
        postMessage = jest.fn();
        terminate = jest.fn();
    };
    try {
        const masks = new CityLightsMasks(jest.fn());
        const region = cityLightsRegion(34, -118, 300);
        masks.get("lookView", region, 60, 8);
        const worker = workers[0], first = worker.postMessage.mock.calls[0][0];
        masks.get("lookView", region, 20, 8);
        const second = worker.postMessage.mock.calls[1][0];
        const result = id => ({data: {id, view: "lookView", pixels: new Uint8Array(4).buffer, meta: {...region, size: 1}, stats: {}}});
        worker.onmessage(result(first.id));
        expect(masks.views.get("lookView").texture).toBeUndefined();
        worker.onmessage(result(second.id));
        expect(masks.views.get("lookView").texture).toBeDefined();
        masks.dispose();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        worker.onmessage(result(second.id));
        expect(masks.views.size).toBe(0);
    } finally { global.Worker = previous; }
});
