jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/FastComputeVertexNormalsAsync", () => ({}));
jest.mock("../src/js/get-pixels-mick", () => ({}));
jest.mock("../src/EGM96Geoid", () => ({geoidCorrectionForTile: () => ({}),
    interpolateGeoidOffset: () => 50, meanSeaLevelOffset: () => 50}));
jest.mock("../src/IndexedDBManager", () => ({indexedDBManager: {
    getCachedData: async () => null, cacheData: async () => {}}}));
import {QuadTreeTile} from "../src/QuadTreeTile";

function geoTiffTile(n) {
    const tile = Object.create(QuadTreeTile.prototype);
    Object.assign(tile, {z: 10, x: n, y: 1, map: {options: {zScale: 1}},
        elevationURL: () => `https://elevation.test/${n}.tif`, updateDebugGeometry: () => {}});
    return tile;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("a queued GeoTIFF request is not sent after its caller cancels, and its slot passes on", async () => {
    const pending = [];
    global.fetch = jest.fn(url => new Promise(resolve => pending.push({url, resolve})));
    const notFound = {ok: false, status: 404};

    // Six requests take every slot; the next two wait in the queue.
    const busy = Array.from({length: 6}, (_, i) => geoTiffTile(i).fetchElevationTile().catch(e => e));
    const controller = new AbortController();
    const cancelled = geoTiffTile(6).fetchElevationTile(controller.signal);
    const later = geoTiffTile(7).fetchElevationTile().catch(e => e);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(6);

    controller.abort();
    pending[0].resolve(notFound);
    await expect(cancelled).rejects.toThrow("Aborted");
    await flush();

    const urls = fetch.mock.calls.map(call => call[0]);
    expect(urls).not.toContain("https://elevation.test/6.tif");
    expect(urls).toHaveLength(7);
    expect(urls[6]).toBe("https://elevation.test/7.tif");

    for (const request of pending.slice(1)) request.resolve(notFound);
    await Promise.all([...busy, later]);
});
