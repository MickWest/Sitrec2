// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original counts map-tile requests per service and reports the counts to the server.
// Here the tracker counts nothing and reports nothing: every track*() call is a no-op, nothing
// is ever blocked, and getUsageSummary() is empty.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:TileUsageTracker";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export const TILE_USAGE_SERVICES = Object.freeze({
    GOOGLE_3D_ROOT: "google_3d_root",
    GOOGLE_3D_TILES: "google_3d_tiles",
    CESIUM_OSM_3D_TILES: "cesium_osm_3d_tiles",
    CESIUM_OSM_3D_BYTES: "cesium_osm_3d_bytes",
});

// Retained verbatim from the original, deliberately. This is a pure classifier, hostname
// fragment to service label, with no network behind it, and ServiceAvailability.js keeps one
// failure counter PER label. Returning "other" for everything would fold every source into
// one counter, so five failures on an unreachable public source would mark the deployment's
// own tile server unavailable as well. paidTileProviders.js and CNodeTerrainUI.js read the
// labels too.
export const SERVICE_PATTERNS = {
    mapbox: /api\.mapbox\.com/i,
    maptiler: /maptiler/i,
    aws: /s3\.amazonaws\.com|elevation-tiles-prod/i,
    osm: /openstreetmap\.org|tile\.osm/i,
    eox: /tiles\.maps\.eox\.at/i,
    usgs: /nationalmap\.gov/i,
    noaa: /noaa\.gov/i,
    gibs: /gibs\.earthdata\.nasa\.gov/i,
    esri: /arcgisonline\.com|services\.arcgis\.com/i,
};

export function identifyServiceFromUrl(url) {
    if (!url) return 'other';
    for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
        if (pattern.test(url)) {
            return service;
        }
    }
    return 'other';
}

class TileUsageTrackerClass {
    constructor() {
        this.usage = {};
        this.limits = null;
        this.remaining = null;
        this.dailyLimits = null;
        this.dailyRemaining = null;
        this.pendingReport = {};
        this.reportInterval = null;
        this.reportBatchSize = 50;
        this.reportIntervalMs = 30000;
        this.initialized = false;
        this.disabled = true;
        this.blocked = {};
        this.warnings = {};
    }

    async init() {
    }

    async fetchLimits() {
    }

    identifyService(url) {
        return identifyServiceFromUrl(url);
    }

    trackService() {
    }

    trackTile() {
    }

    trackGoogle3DRootSession() {
    }

    trackGoogle3DTile() {
    }

    trackCesiumOSM3DTile() {
    }

    trackCesiumOSM3DBytes() {
    }

    isBlocked() {
        return false;
    }

    getRemaining() {
        return Infinity;
    }

    async reportUsage() {
    }

    startReportingInterval() {
    }

    stopReportingInterval() {
    }

    setupUnloadHandler() {
    }

    getUsageSummary() {
        return {
            usage: {},
            limits: null,
            remaining: null,
            dailyLimits: null,
            dailyRemaining: null,
            blocked: {},
            warnings: {},
        };
    }
}

export const TileUsageTracker = new TileUsageTrackerClass();
