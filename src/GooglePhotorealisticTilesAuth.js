import {CesiumIonAuthPlugin, GoogleCloudAuthPlugin} from "3d-tiles-renderer/plugins";
import {TileUsageTracker} from "./TileUsageTracker";

const GOOGLE_3D_TILES_HOSTNAME = "tile.googleapis.com";
const GOOGLE_3D_TILES_ROOT_PATH = "/v1/3dtiles/root.json";
const LOCAL_BASE_URL = "https://local.invalid/";

// Shared auth/session and root tileset cache keyed by API token.
const sharedStateByApiKey = new Map();

function parseURL(uri) {
    try {
        return new URL(uri, LOCAL_BASE_URL);
    } catch {
        return null;
    }
}

function cloneRootTileset(rootTileset) {
    if (typeof structuredClone === "function") {
        return structuredClone(rootTileset);
    }
    return JSON.parse(JSON.stringify(rootTileset));
}

function isResponseLike(value) {
    return !!value
        && typeof value === "object"
        && typeof value.ok === "boolean"
        && typeof value.json === "function";
}

async function normalizeRootTilesetResponse(result, uri) {
    if (isResponseLike(result)) {
        if (!result.ok) {
            throw new Error(
                `SharedGoogleCloudAuthPlugin: Failed to load root tileset "${uri}" with status ${result.status} : ${result.statusText}`
            );
        }
        return result.json();
    }
    return result;
}

function getRootCacheKey(uri) {
    const parsed = parseURL(uri);
    if (!parsed) return uri;
    return `${parsed.origin}${parsed.pathname}`;
}

export function isGooglePhotorealisticRootRequest(uri) {
    const parsed = parseURL(uri);
    if (!parsed) return false;
    return parsed.hostname === GOOGLE_3D_TILES_HOSTNAME
        && parsed.pathname === GOOGLE_3D_TILES_ROOT_PATH;
}

export function isGooglePhotorealisticTileRequest(uri) {
    const parsed = parseURL(uri);
    if (!parsed) return false;
    return parsed.hostname === GOOGLE_3D_TILES_HOSTNAME
        && parsed.pathname.startsWith("/v1/3dtiles/")
        && parsed.pathname !== GOOGLE_3D_TILES_ROOT_PATH;
}

export function getSharedGooglePhotorealisticState(apiToken) {
    const stateKey = apiToken ?? "__missing_api_key__";
    let state = sharedStateByApiKey.get(stateKey);
    if (!state) {
        state = {
            auth: null,
            rootTilesetRequests: new Map(),
        };
        sharedStateByApiKey.set(stateKey, state);
    }
    return state;
}

// Test helper to keep caching deterministic per test case.
export function _resetSharedGooglePhotorealisticStateForTests() {
    sharedStateByApiKey.clear();
}

export class SharedGoogleCloudAuthPlugin extends GoogleCloudAuthPlugin {
    constructor({apiToken, sharedState = null, autoRefreshToken = true, ...options}) {
        super({apiToken, autoRefreshToken, ...options});

        this.sharedState = sharedState ?? getSharedGooglePhotorealisticState(apiToken);
        if (!this.sharedState.auth) {
            this.sharedState.auth = this.auth;
        } else {
            this.auth = this.sharedState.auth;
        }
    }

    async fetchData(uri, options) {
        if (!isGooglePhotorealisticRootRequest(uri)) {
            if (isGooglePhotorealisticTileRequest(uri)) {
                TileUsageTracker.trackGoogle3DTile();
            }
            return this.auth.fetch(uri, options);
        }

        const cacheKey = getRootCacheKey(uri);
        let rootRequest = this.sharedState.rootTilesetRequests.get(cacheKey);
        if (!rootRequest) {
            TileUsageTracker.trackGoogle3DRootSession();
            rootRequest = Promise.resolve(this.auth.fetch(uri, options))
                .then(result => normalizeRootTilesetResponse(result, uri))
                .then(rootTileset => {
                    if (!rootTileset || typeof rootTileset !== "object" || !rootTileset.root) {
                        throw new Error("SharedGoogleCloudAuthPlugin: Invalid root tileset payload.");
                    }
                    return rootTileset;
                })
                .catch(error => {
                    this.sharedState.rootTilesetRequests.delete(cacheKey);
                    throw error;
                });

            this.sharedState.rootTilesetRequests.set(cacheKey, rootRequest);
        }

        const rootTileset = await rootRequest;
        return cloneRootTileset(rootTileset);
    }
}

export class TrackedCesiumIonAuthPlugin extends CesiumIonAuthPlugin {
    trackBytesFromResponse(response) {
        if (!response || typeof response !== "object") return;
        const headers = response.headers;
        if (!headers || typeof headers.get !== "function") return;

        const contentLength = headers.get("content-length");
        const bytes = Number.parseInt(contentLength, 10);
        if (Number.isFinite(bytes) && bytes > 0) {
            TileUsageTracker.trackCesiumOSM3DBytes(bytes);
        }
    }

    fetchData(uri, options) {
        const result = super.fetchData(uri, options);
        if (result) {
            TileUsageTracker.trackCesiumOSM3DTile();
        }
        if (!result || typeof result.then !== "function") {
            this.trackBytesFromResponse(result);
            return result;
        }

        return result.then(response => {
            this.trackBytesFromResponse(response);
            return response;
        });
    }
}
