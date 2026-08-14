import {isServerless, SITREC_SERVER} from "./configUtils";
import {withTestUser} from "./Globals";
import {getEnvBool} from "./envUtils";
import {hasCachedKey} from "./BYOKKeyStore";
import {recordProviderUsage} from "./BYOKUsage";

export const TILE_USAGE_SERVICES = Object.freeze({
    GOOGLE_3D_ROOT: "google_3d_root",
    GOOGLE_3D_TILES: "google_3d_tiles",
    CESIUM_OSM_3D_TILES: "cesium_osm_3d_tiles",
    CESIUM_OSM_3D_BYTES: "cesium_osm_3d_bytes",
});

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
        this.disabled = false;
        this.blocked = {};
        this.warnings = {};
    }

    async init() {
        if (this.initialized || isServerless) return;
        if (!getEnvBool("SITREC_TRACK_STATS", process.env.SITREC_TRACK_STATS)) return;
        
        try {
            await this.fetchLimits();
            if (this.disabled) return;
            this.startReportingInterval();
            this.setupUnloadHandler();
            this.initialized = true;
        } catch (e) {
            console.warn('TileUsageTracker: Failed to initialize', e);
        }
    }

    async fetchLimits() {
        try {
            const response = await fetch(withTestUser(SITREC_SERVER + 'tile_usage.php'), {
                credentials: 'include',
            });
            if (!response.ok) return;
            
            const data = await response.json();
            if (data.disabled) {
                this.disabled = true;
                return;
            }
            this.limits = data.limits;
            this.remaining = data.remaining;
            this.dailyLimits = data.dailyLimits || null;
            this.dailyRemaining = data.dailyRemaining || null;
            this.usage = data.usage || {};
        } catch (e) {
            console.warn('TileUsageTracker: Failed to fetch limits', e);
        }
    }

    identifyService(url) {
        return identifyServiceFromUrl(url);
    }

    trackService(service, count = 1) {
        if (isServerless) return;
        if (!service) return;

        const safeCount = Math.max(0, Number(count) || 0);
        if (safeCount <= 0) return;

        this.pendingReport[service] = (this.pendingReport[service] || 0) + safeCount;
        this.usage[service] = (this.usage[service] || 0) + safeCount;

        if (this.remaining && this.remaining[service] != null) {
            this.remaining[service] = Math.max(0, this.remaining[service] - safeCount);
        }
        if (this.dailyRemaining && this.dailyRemaining[service] != null) {
            this.dailyRemaining[service] = Math.max(0, this.dailyRemaining[service] - safeCount);
        }

        const totalPending = Object.values(this.pendingReport).reduce((a, b) => a + b, 0);
        if (totalPending >= this.reportBatchSize) {
            this.reportUsage();
        }
    }

    trackTile(url) {
        const service = this.identifyService(url);
        this.trackService(service, 1);
    }

    // A Google 3D "root session" is one request to /v1/3dtiles/root.json, and it is the
    // unit Google actually bills — every tile fetched afterwards rides on it. That is why
    // the server caps google_3d_root daily (tile_usage.php) while leaving google_3d_tiles
    // effectively unlimited.
    //
    // When the user supplied their own Google key, the session is billed to THEM, so it
    // must not be reported to Sitrec's server: it neither consumes nor should be counted
    // against Sitrec's shared quota, and their private usage is not Sitrec's business. It
    // is still recorded locally so the key dialog can show them what they are spending —
    // and unlike trackService(), that local record is NOT suppressed in serverless builds,
    // where a user on their own key is exactly who needs the number.
    trackGoogle3DRootSession() {
        if (hasCachedKey("google-maps")) {
            recordProviderUsage("google-maps", 1).catch(() => {});
            return;
        }
        this.trackService(TILE_USAGE_SERVICES.GOOGLE_3D_ROOT, 1);
    }

    trackGoogle3DTile() {
        this.trackService(TILE_USAGE_SERVICES.GOOGLE_3D_TILES, 1);
    }

    trackCesiumOSM3DTile() {
        this.trackService(TILE_USAGE_SERVICES.CESIUM_OSM_3D_TILES, 1);
    }

    trackCesiumOSM3DBytes(bytes) {
        const safeBytes = Math.max(0, Number(bytes) || 0);
        if (safeBytes <= 0) return;
        // Same split as the Google root session above: a user's own Ion token is billed to
        // them, so it is counted locally and not reported against Sitrec's byte quota.
        if (hasCachedKey("cesium-ion")) {
            recordProviderUsage("cesium-ion", safeBytes).catch(() => {});
            return;
        }
        this.trackService(TILE_USAGE_SERVICES.CESIUM_OSM_3D_BYTES, safeBytes);
    }

    isBlocked(service) {
        if (this.remaining && this.remaining[service] != null && this.remaining[service] <= 0) {
            return true;
        }
        if (this.dailyRemaining && this.dailyRemaining[service] != null && this.dailyRemaining[service] <= 0) {
            return true;
        }
        return false;
    }

    getRemaining(service) {
        const hourlyRemaining = this.remaining?.[service] ?? this.remaining?.other ?? Infinity;
        const dailyRemaining = this.dailyRemaining?.[service] ?? Infinity;
        return Math.min(hourlyRemaining, dailyRemaining);
    }

    async reportUsage() {
        if (isServerless) return;
        
        const toReport = {...this.pendingReport};
        this.pendingReport = {};
        
        const totalToReport = Object.values(toReport).reduce((a, b) => a + b, 0);
        if (totalToReport === 0) return;
        
        try {
            const response = await fetch(withTestUser(SITREC_SERVER + 'tile_usage.php'), {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({usage: toReport}),
                credentials: 'include',
            });
            
            if (!response.ok) return;
            
            const data = await response.json();
            this.remaining = data.remaining;
            this.dailyRemaining = data.dailyRemaining || this.dailyRemaining;
            this.blocked = data.blocked || {};
            this.warnings = data.warnings || {};
            
            if (Object.keys(this.warnings).length > 0) {
                for (const [service, info] of Object.entries(this.warnings)) {
                    const windowLabel = info.window === 'daily' ? 'day' : 'hour';
                    console.warn(`TileUsageTracker: ${service} ${windowLabel} warning - ${info.used}/${info.limit} (${info.remaining} remaining)`);
                }
            }
            
            if (Object.keys(this.blocked).length > 0) {
                for (const [service, info] of Object.entries(this.blocked)) {
                    const windowLabel = info.window === 'daily' ? 'day' : 'hour';
                    console.error(`TileUsageTracker: ${service} BLOCKED (${windowLabel}) - ${info.used}/${info.limit} exceeded`);
                }
            }
        } catch (e) {
            Object.entries(toReport).forEach(([service, count]) => {
                this.pendingReport[service] = (this.pendingReport[service] || 0) + count;
            });
        }
    }

    startReportingInterval() {
        if (this.reportInterval) return;
        
        this.reportInterval = setInterval(() => {
            this.reportUsage();
        }, this.reportIntervalMs);
    }

    stopReportingInterval() {
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            this.reportInterval = null;
        }
    }

    setupUnloadHandler() {
        window.addEventListener('beforeunload', () => {
            this.reportUsage();
        });
        
        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.reportUsage();
            }
        });
    }

    getUsageSummary() {
        return {
            usage: this.usage,
            limits: this.limits,
            remaining: this.remaining,
            dailyLimits: this.dailyLimits,
            dailyRemaining: this.dailyRemaining,
            blocked: this.blocked,
            warnings: this.warnings,
        };
    }
}

export const TileUsageTracker = new TileUsageTrackerClass();
