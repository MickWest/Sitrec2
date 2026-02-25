var mockTrackGoogle3DRootSession;
var mockTrackGoogle3DTile;
var mockTrackCesiumOSM3DTile;
var mockTrackCesiumOSM3DBytes;

jest.mock("3d-tiles-renderer/plugins", () => {
    class GoogleCloudAuthPlugin {
        constructor({apiToken}) {
            this.apiToken = apiToken;
            this.auth = {
                fetch: async () => ({})
            };
        }
    }

    class CesiumIonAuthPlugin {
        constructor() {
            this._nextFetchResult = Promise.resolve({
                ok: true,
                headers: {
                    get: () => "1024",
                },
            });
        }

        fetchData() {
            return this._nextFetchResult;
        }
    }

    return {GoogleCloudAuthPlugin, CesiumIonAuthPlugin};
}, {virtual: true});

jest.mock("../src/TileUsageTracker", () => {
    mockTrackGoogle3DRootSession = jest.fn();
    mockTrackGoogle3DTile = jest.fn();
    mockTrackCesiumOSM3DTile = jest.fn();
    mockTrackCesiumOSM3DBytes = jest.fn();

    return {
        TileUsageTracker: {
            trackGoogle3DRootSession: mockTrackGoogle3DRootSession,
            trackGoogle3DTile: mockTrackGoogle3DTile,
            trackCesiumOSM3DTile: mockTrackCesiumOSM3DTile,
            trackCesiumOSM3DBytes: mockTrackCesiumOSM3DBytes,
        },
        TILE_USAGE_SERVICES: {
            GOOGLE_3D_ROOT: "google_3d_root",
            GOOGLE_3D_TILES: "google_3d_tiles",
            CESIUM_OSM_3D_TILES: "cesium_osm_3d_tiles",
            CESIUM_OSM_3D_BYTES: "cesium_osm_3d_bytes",
        },
    };
});

import {
    _resetSharedGooglePhotorealisticStateForTests,
    getSharedGooglePhotorealisticState,
    isGooglePhotorealisticRootRequest,
    isGooglePhotorealisticTileRequest,
    SharedGoogleCloudAuthPlugin,
    TrackedCesiumIonAuthPlugin
} from "../src/GooglePhotorealisticTilesAuth";

describe("Google Photorealistic root request caching", () => {
    beforeEach(() => {
        _resetSharedGooglePhotorealisticStateForTests();
        mockTrackGoogle3DRootSession.mockReset();
        mockTrackGoogle3DTile.mockReset();
        mockTrackCesiumOSM3DTile.mockReset();
        mockTrackCesiumOSM3DBytes.mockReset();
    });

    test("detects root requests only for Google 3D tiles root endpoint", () => {
        expect(isGooglePhotorealisticRootRequest("https://tile.googleapis.com/v1/3dtiles/root.json")).toBe(true);
        expect(isGooglePhotorealisticRootRequest("https://tile.googleapis.com/v1/3dtiles/root.json?key=abc")).toBe(true);
        expect(isGooglePhotorealisticRootRequest("https://tile.googleapis.com/v1/3dtiles/tiles/0.b3dm")).toBe(false);
        expect(isGooglePhotorealisticRootRequest("https://example.com/v1/3dtiles/root.json")).toBe(false);
    });

    test("deduplicates parallel root requests across plugin instances sharing an API key", async () => {
        const sharedState = getSharedGooglePhotorealisticState("test-key");
        const rootUrl = "https://tile.googleapis.com/v1/3dtiles/root.json?key=test-key";
        const rootTileset = {
            asset: {version: "1.1"},
            root: {
                content: {
                    uri: "https://tile.googleapis.com/v1/3dtiles/datasets/foo/tiles/0.b3dm?session=session-123"
                }
            }
        };

        const pluginA = new SharedGoogleCloudAuthPlugin({apiToken: "test-key", sharedState});
        const fetchMock = jest.fn(async () => rootTileset);
        pluginA.auth.fetch = fetchMock;

        const pluginB = new SharedGoogleCloudAuthPlugin({apiToken: "test-key", sharedState});
        expect(pluginB.auth).toBe(pluginA.auth);

        const [tilesetA, tilesetB] = await Promise.all([
            pluginA.fetchData(rootUrl, {}),
            pluginB.fetchData(rootUrl, {}),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tilesetA).toEqual(rootTileset);
        expect(tilesetB).toEqual(rootTileset);
        expect(tilesetA).not.toBe(tilesetB);
        expect(mockTrackGoogle3DRootSession).toHaveBeenCalledTimes(1);

        // Returned payloads are cloned per renderer to avoid shared mutation.
        tilesetA.root.extraField = "mutated";
        expect(tilesetB.root.extraField).toBeUndefined();
    });

    test("reuses cached root request result for subsequent renderer in same session", async () => {
        const sharedState = getSharedGooglePhotorealisticState("test-key");
        const rootTileset = {
            asset: {version: "1.1"},
            root: {
                content: {
                    uri: "https://tile.googleapis.com/v1/3dtiles/datasets/foo/tiles/0.b3dm?session=session-123"
                }
            }
        };

        const pluginA = new SharedGoogleCloudAuthPlugin({apiToken: "test-key", sharedState});
        const fetchMock = jest.fn(async () => rootTileset);
        pluginA.auth.fetch = fetchMock;

        const pluginB = new SharedGoogleCloudAuthPlugin({apiToken: "test-key", sharedState});

        await pluginA.fetchData("https://tile.googleapis.com/v1/3dtiles/root.json?key=test-key", {});
        await pluginB.fetchData("https://tile.googleapis.com/v1/3dtiles/root.json?key=test-key&session=another", {});

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockTrackGoogle3DRootSession).toHaveBeenCalledTimes(1);
    });

    test("does not cache non-root tile content requests", async () => {
        const sharedState = getSharedGooglePhotorealisticState("test-key");
        const plugin = new SharedGoogleCloudAuthPlugin({apiToken: "test-key", sharedState});
        const fetchMock = jest.fn(async () => ({ok: true}));
        plugin.auth.fetch = fetchMock;

        await plugin.fetchData("https://tile.googleapis.com/v1/3dtiles/datasets/foo/tiles/0.b3dm?session=session-123", {});
        await plugin.fetchData("https://tile.googleapis.com/v1/3dtiles/datasets/foo/tiles/0.b3dm?session=session-123", {});

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mockTrackGoogle3DTile).toHaveBeenCalledTimes(2);
    });

    test("clears failed root request from cache so later retries can recover", async () => {
        const sharedState = getSharedGooglePhotorealisticState("test-key");
        const plugin = new SharedGoogleCloudAuthPlugin({apiToken: "test-key", sharedState});

        const rootTileset = {
            asset: {version: "1.1"},
            root: {
                content: {
                    uri: "https://tile.googleapis.com/v1/3dtiles/datasets/foo/tiles/0.b3dm?session=session-123"
                }
            }
        };

        const fetchMock = jest.fn()
            .mockRejectedValueOnce(new Error("network fail"))
            .mockResolvedValueOnce(rootTileset);
        plugin.auth.fetch = fetchMock;

        await expect(plugin.fetchData("https://tile.googleapis.com/v1/3dtiles/root.json?key=test-key", {}))
            .rejects
            .toThrow("network fail");

        await expect(plugin.fetchData("https://tile.googleapis.com/v1/3dtiles/root.json?key=test-key", {}))
            .resolves
            .toEqual(rootTileset);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mockTrackGoogle3DRootSession).toHaveBeenCalledTimes(2);
    });

    test("detects non-root Google 3D tiles requests", () => {
        expect(isGooglePhotorealisticTileRequest("https://tile.googleapis.com/v1/3dtiles/datasets/foo/tiles/0.b3dm?session=s")).toBe(true);
        expect(isGooglePhotorealisticTileRequest("https://tile.googleapis.com/v1/3dtiles/root.json")).toBe(false);
        expect(isGooglePhotorealisticTileRequest("https://example.com/v1/3dtiles/datasets/foo/tiles/0.b3dm")).toBe(false);
    });

    test("tracks Cesium OSM 3D tile fetches", async () => {
        const plugin = new TrackedCesiumIonAuthPlugin({});
        await plugin.fetchData("https://assets.cesium.com/tileset.json", {});
        await plugin.fetchData("https://assets.cesium.com/tile.b3dm", {});

        expect(mockTrackCesiumOSM3DTile).toHaveBeenCalledTimes(2);
        expect(mockTrackCesiumOSM3DBytes).toHaveBeenCalledTimes(2);
        expect(mockTrackCesiumOSM3DBytes).toHaveBeenNthCalledWith(1, 1024);
    });

    test("does not track Cesium fetch when plugin returns null", async () => {
        const plugin = new TrackedCesiumIonAuthPlugin({});
        plugin._nextFetchResult = null;

        const result = plugin.fetchData("https://assets.cesium.com/tile.b3dm", {});
        expect(result).toBeNull();
        expect(mockTrackCesiumOSM3DTile).not.toHaveBeenCalled();
        expect(mockTrackCesiumOSM3DBytes).not.toHaveBeenCalled();
    });
});
