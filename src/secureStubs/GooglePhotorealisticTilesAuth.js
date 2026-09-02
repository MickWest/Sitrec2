// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original wraps the tiles renderer's authentication plugins for two commercial
// 3D-building sources, sharing one session per key and counting tile usage. Here the two
// plugin classes keep their names and constructor shapes (src/nodes/CNodeBuildings3DTiles.js
// registers one of them when either source is selected) but authenticate nothing.
//
// Each stub plugin DEFINES fetchData, and rejects from it, on purpose. The renderer asks its
// plugins in turn and falls back to a plain fetch() when none of them answers, so a plugin
// without fetchData would let every tile request go out to the provider unauthenticated. A
// rejected fetch is a load error the renderer already handles; no request is made.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:GooglePhotorealisticTilesAuth";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function isGooglePhotorealisticRootRequest() {
    return false;
}

export function isGooglePhotorealisticTileRequest() {
    return false;
}

export function getSharedGooglePhotorealisticState() {
    return {auth: null, rootTilesetRequests: new Map()};
}

export function _resetSharedGooglePhotorealisticStateForTests() {
}

export class SharedGoogleCloudAuthPlugin {
    constructor(options) {
        const o = options || {};
        this.name = "SECURE_STUB_GOOGLE_CLOUD_AUTH_PLUGIN";
        this.apiToken = o.apiToken ?? null;
        this.auth = null;
        this.sharedState = o.sharedState ?? getSharedGooglePhotorealisticState(this.apiToken);
    }

    fetchData() {
        return Promise.reject(new Error("Google Photorealistic 3D Tiles are not available in this build"));
    }
}

export class TrackedCesiumIonAuthPlugin {
    constructor(options) {
        const o = options || {};
        this.name = "SECURE_STUB_CESIUM_ION_AUTH_PLUGIN";
        this.apiToken = o.apiToken ?? null;
        this.assetId = o.assetId ?? null;
    }

    trackBytesFromResponse() {
    }

    fetchData() {
        return Promise.reject(new Error("Cesium OSM Buildings are not available in this build"));
    }
}
