import {isServerless, SITREC_SERVER} from "./configUtils";
import {parseBoolean} from "./utils";

export const TILE_USAGE_SERVICES = Object.freeze({
    GOOGLE_3D_ROOT: "google_3d_root",
    GOOGLE_3D_TILES: "google_3d_tiles",
    CESIUM_OSM_3D_TILES: "cesium_osm_3d_tiles",
    CESIUM_OSM_3D_BYTES: "cesium_osm_3d_bytes",
});

const SERVICE_PATTERNS = {
    mapbox: /api\.mapbox\.com/i,
    maptiler: /maptiler/i,
    aws: /s3\.amazonaws\.com|elevation-tiles-prod/i,
    osm: /openstreetmap\.org|tile\.osm/i,
    eox: /tiles\.maps\.eox\.at/i,
    esri: /arcgisonline\.com|arcgis/i,
};

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
        if (!parseBoolean(process.env.SITREC_TRACK_STATS)) return;
        
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
            const response = await fetch(SITREC_SERVER + 'tile_usage.php', {
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
        if (!url) return 'other';
        
        for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
            if (pattern.test(url)) {
                return service;
            }
        }
        return 'other';
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

    trackGoogle3DRootSession() {
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
            const response = await fetch(SITREC_SERVER + 'tile_usage.php', {
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
