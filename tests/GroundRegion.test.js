import {fetchRegionPowerGrid, regionalPowerFeatures} from "../src/OverpassPowerGrid";
import {boundsCorners, footprintBounds, resolveFootprintBounds} from "../src/GroundFootprint";
import {parsePowerNetwork} from "../src/PowerNetworkFormat";

const point = (lon, lat) => ({lon, lat});
const diamond = [point(-2, 0), point(0, 2), point(2, 0), point(0, -2)];
const smallDiamond = diamond.map(({lon, lat}) => point(lon / 100, lat / 100));
const way = geometry => ({type: "way", tags: {power: "line", cables: "3"}, geometry});

test.each([diamond, diamond.slice().reverse()].map(corners => [corners]))("a rotated region clips partial spans and preserves support coordinates", corners => {
    const support = point(0.123456789, 1);
    const data = regionalPowerFeatures([
        way([point(-4, 1), support, point(4, 1)]),
        {type: "node", ...support, tags: {power: "tower", height: "46", design: "guyed_v-frame"}},
        way([point(1.5, 1.5), point(1.8, 1.5)]), // Inside the bounding box, outside the region.
    ], corners);
    const network = parsePowerNetwork(data);
    expect(network.ways).toHaveLength(1);
    const route = network.ways[0].path.map(i => network.points[i]);
    expect(route).toHaveLength(3);
    expect(route[0].lon).toBeCloseTo(-1, 12);
    expect(route[1]).toMatchObject({...support, kind: "pylon", height: 46, design: "guyedV"});
    expect(route[2].lon).toBeCloseTo(1, 12);
});

test("keeps a crossing with both ends outside, splits missing geometry and excludes a corner touch", () => {
    const data = regionalPowerFeatures([way([point(-3, 0), point(3, 0), null, point(0, -3), point(0, 3)]),
        way([point(1, 1), point(3, 3)])], diamond);
    expect(data.features.map(f => f.geometry.coordinates)).toEqual([[[-2, 0], [2, 0]], [[0, -2], [0, 2]]]);
});

test("a region and grid created in metres use the same bounds as their stored corners", () => {
    const footprint = resolveFootprintBounds({centerLat: 38, centerLon: -81, width: 2000, height: 1000});
    const bounds = footprintBounds(boundsCorners(footprint));
    expect(bounds).toMatchObject({north: footprint.north, east: footprint.east, west: footprint.west, south: footprint.south});
    expect(bounds.north - bounds.south).toBeCloseTo(0.009, 4);
    expect(resolveFootprintBounds(bounds)).toBe(bounds);
});

const originalFetch = global.fetch;
let now = Date.now();
beforeEach(() => {
    now += 600000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
});

test("requests only mapped power features and sends no credentials or referrer", async () => {
    global.fetch = jest.fn().mockResolvedValue({ok: true, json: async () => ({elements: []})});
    const signal = new AbortController().signal;
    const result = await fetchRegionPowerGrid(smallDiamond, signal);
    expect(result.features).toEqual([]);
    const [[url, options]] = global.fetch.mock.calls;
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(options).toMatchObject({method: "POST", credentials: "omit", referrerPolicy: "no-referrer", signal});
    const query = options.body.get("data");
    expect(query).toContain('node["power"~"^(tower|pole)$"](poly:"0.0000000 -0.0200000');
    expect(query).toContain('way["power"~"^(line|minor_line)$"](-0.0200000,-0.0200000,0.0200000,0.0200000)');
});

test("errors and incomplete Overpass responses do not become partial network layers", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ok: false, status: 429})
        .mockResolvedValueOnce({ok: true, json: async () => ({elements: [], remark: "incomplete result"})});
    await expect(fetchRegionPowerGrid(smallDiamond)).rejects.toThrow(/busy/);
    now += 60000;
    await expect(fetchRegionPowerGrid(smallDiamond)).rejects.toThrow(/incomplete/);
    const crossing = boundsCorners({west: -179, east: 179, south: 4, north: 5});
    await expect(fetchRegionPowerGrid(crossing)).rejects.toThrow(/date line/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
});

jest.mock("../src/DragDropHandler", () => ({
    DragDropHandler: {reserveUniqueName: () => "Test power grid-1.geojson", reservedImportNames: new Set()},
}));

// Exercise the region's real import/serialization methods while isolating the
// terrain meshes and the shared file import path (covered by PowerNetwork.test).
function regionForTest() {
    const {CNodeGroundRegion} = require("../src/nodes/CNodeGroundRegion");
    const {setFileManager, setNodeMan} = require("../src/Globals");
    const region = Object.assign(Object.create(CNodeGroundRegion.prototype), {
        id: "groundRegion_1", name: "Test", north: 2, south: -2, west: -2, east: 2, rotation: 45,
        visible: true, gridImports: [], getCornerLLAs: () => smallDiamond, server: "overpass.private.coffee",
    });
    const files = new Map();
    const manager = {get: jest.fn(() => region)};
    setNodeMan(manager);
    setFileManager({exists: name => files.has(name), parseResult: async (name, bytes, url, options) => {
        if (options.canApply()) files.set(name, JSON.parse(new TextDecoder().decode(bytes)));
    }});
    return {region, files, manager};
}

test("repeat clicks request one file and a restored region remembers the imported area", async () => {
    const {region, files} = regionForTest();
    global.fetch = jest.fn().mockResolvedValue({ok: true, json: async () => ({elements: [way([point(-3, 0), point(3, 0)])]})});
    await Promise.all([region.importPowerGrid(), region.importPowerGrid()]);
    const restored = regionForTest().region;
    Object.assign(restored, JSON.parse(JSON.stringify(region.serialize())));
    const {setFileManager} = require("../src/Globals");
    setFileManager({exists: name => files.has(name)});
    await restored.importPowerGrid();
    expect(files.size).toBe(1);
    const saved = [...files.values()][0];
    expect(saved.attribution).toBe("© OpenStreetMap contributors");
    expect(parsePowerNetwork(saved).ways).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe("https://overpass.private.coffee/api/interpreter");
    expect(restored.importStatus).toMatch(/already/);
});

test("removing the region during a request discards the returned data", async () => {
    const {region, files, manager} = regionForTest();
    let finish;
    global.fetch = jest.fn().mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const pending = region.importPowerGrid();
    manager.get.mockReturnValue(null);
    finish({ok: true, json: async () => ({elements: [way([point(-3, 0), point(3, 0)])]})});
    await pending;
    expect(files.size).toBe(0);
    expect(region.gridImports).toEqual([]);
});

test.each([429, 502, 503, 504])("HTTP %i exposes a copyable URL for exactly the attempted query", async status => {
    const {region, files} = regionForTest();
    global.fetch = jest.fn().mockResolvedValue({ok: false, status, headers: {get: () => "120"}});
    await region.importPowerGrid();
    const [[endpoint, options]] = global.fetch.mock.calls;
    const manual = new URL(region.downloadURL);
    expect(manual.origin + manual.pathname).toBe(endpoint);
    expect(manual.searchParams.get("data")).toBe(options.body.get("data"));
    expect(manual.searchParams.has("data")).toBe(true);
    expect(files.size).toBe(0);
    expect(region.serialize()).not.toHaveProperty("downloadURL");
    now += 30000;
    await region.importPowerGrid();
    expect(region.importStatus).toMatch(/90 s/);
    expect(region.downloadURL).toBe(manual.href);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    now += 90000;
    global.fetch.mockResolvedValue({ok: true, json: async () => ({elements: []})});
    await region.importPowerGrid();
    expect(region.downloadURL).toBe("");
});

test("server and client timeouts offer a manual URL while invalid regions do not", async () => {
    const {region} = regionForTest();
    global.fetch = jest.fn().mockResolvedValueOnce({ok: true, json: async () => ({elements: [], remark: "Query timed out"})});
    await region.importPowerGrid();
    const url = region.downloadURL;
    expect(url).toMatch(/^https:/);
    now += 60000;
    global.fetch.mockImplementationOnce(() => {
        region.pendingImport.abort();
        return Promise.reject(new Error("Aborted"));
    });
    await region.importPowerGrid();
    expect(region.downloadURL).toBe(url);
    region.getCornerLLAs = () => diamond;
    await region.importPowerGrid();
    expect(region.downloadURL).toBe("");
    expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("rejects simultaneous regions, oversize regions and early retries without sending a request", async () => {
    let finish;
    global.fetch = jest.fn(() => new Promise(resolve => {finish = resolve;}));
    await expect(fetchRegionPowerGrid(diamond)).rejects.toThrow(/25 km/);
    const pending = fetchRegionPowerGrid(smallDiamond);
    await expect(fetchRegionPowerGrid(smallDiamond.slice().reverse())).rejects.toThrow(/running/);
    finish({ok: false, status: 429, headers: {get: () => "120"}});
    await expect(pending).rejects.toThrow(/busy/);
    now += 90000;
    await expect(fetchRegionPowerGrid(smallDiamond)).rejects.toThrow(/30 s/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    now += 30000;
    global.fetch.mockResolvedValue({ok: true, json: async () => ({elements: []})});
    await fetchRegionPowerGrid(smallDiamond);
    await expect(fetchRegionPowerGrid(smallDiamond)).rejects.toThrow(/30 s/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
});
