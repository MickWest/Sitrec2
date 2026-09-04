/**
 * config.default.js
 * Default configuration for Sitrec (used in serverless mode)
 * 
 * This configuration is used when running Sitrec in serverless mode (no PHP backend).
 * It provides sensible defaults for all configurable options.
 */

export const CONFIG = {
    // Application settings
    app: {
        name: 'Sitrec Serverless',
        version: '1.0.0',
        mode: 'serverless'
    },

    // Browser-local settings and cache storage. User sitch files themselves are
    // saved through the local file/folder workflow, not into this database.
    storage: {
        // IndexedDB settings
        indexedDB: {
            enabled: true,
            dbName: 'SitrecDB',
            dbVersion: 1
        },
        
        // LocalStorage settings
        localStorage: {
            enabled: true,
            prefix: 'sitrec_'
        }
    },

    // Features that are disabled in serverless mode
    features: {
        serverUpload: false,        // File rehosting disabled
        serverSettings: false,      // Cloud settings sync disabled
        aiChat: false,              // AI chat disabled (requires backend)
        authentication: false,      // User login disabled
        s3Storage: false            // S3 storage disabled
    },

    // Features that are enabled in serverless mode
    enabledFeatures: {
        localSave: true,            // Save to a local file or selected working folder
        localLoad: true,            // Open a local sitch file or working folder
        offline: true,              // No PHP dependency; required assets must still be local
        dataCaching: true,          // Cache eligible data in IndexedDB
        manifestLoading: true       // Load available sitches from manifest
    },

    // API endpoints (for debug/status)
    api: {
        health: '/api/health',
        manifest: '/api/manifest',
        debug: {
            status: '/api/debug/status',
            files: '/api/debug/files'
        }
    },

    // Default UI settings
    ui: {
        maxDetailsDefault: 15,
        maxDetailsMin: 5,
        maxDetailsMax: 30
    },

    // Caching settings
    cache: {
        ttl: 3600000,  // 1 hour in milliseconds
        celestrakTTL: 3600000  // 1 hour for TLE data
    }
};

export default CONFIG;
