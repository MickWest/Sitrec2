// SettingsManager.js
// Handles loading and saving user settings from cookies, server (S3), or IndexedDB
// The setting UI is set up in setupSettingsMenu()

import {getEffectiveUserID, Globals, withTestUser} from "./Globals";
import {indexedDBManager} from "./IndexedDBManager";
import {isServerless} from "./configUtils";
import {assert} from "./assert";
import {getEnvBool} from "./envUtils";
import {primeKeyCache} from "./BYOKKeyStore";

// Environment variable flags for storage methods (default to false if not specified)
// Set to 'true', 'false', '1', '0', 'yes', or 'no'
const SETTINGS_COOKIES_ENABLED = getEnvBool("SETTINGS_COOKIES_ENABLED", process.env.SETTINGS_COOKIES_ENABLED);
const SETTINGS_SERVER_ENABLED = getEnvBool("SETTINGS_SERVER_ENABLED", process.env.SETTINGS_SERVER_ENABLED);
const SETTINGS_DB_ENABLED = getEnvBool("SETTINGS_DB_ENABLED", process.env.SETTINGS_DB_ENABLED);

// Cookie helper functions for settings
function setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function getCookie(name) {
    return document.cookie.split('; ').reduce((r, v) => {
        const parts = v.split('=');
        return parts[0] === name ? decodeURIComponent(parts[1]) : r
    }, null);
}

// Sanitize settings to prevent exploits
// NOTE: When adding new settings, you must update BOTH:
//   1. This function (SettingsManager.js)
//   2. sanitizeSettings() in settings.php (server-side) if using PHP backend
export function sanitizeSettings(settings) {
    const sanitized = {};

    assert(typeof settings === 'object' && settings !== null, "Settings must be an object, it is " + typeof settings + "Value:" + settings);

    // Only allow specific known settings with type checking
    if (settings.maxDetails !== undefined) {
        const maxDetails = Number(settings.maxDetails);
        // Clamp to valid range
        sanitized.maxDetails = Math.max(5, Math.min(30, maxDetails));
    }
    
    if (settings.fpsLimit !== undefined) {
        const fpsLimit = Number(settings.fpsLimit);
        // Only allow specific allowed values
        const allowedValues = [60, 30, 20, 15];
        if (allowedValues.includes(fpsLimit)) {
            sanitized.fpsLimit = fpsLimit;
        }
    }
    
    if (settings.tileSegments !== undefined) {
        const tileSegments = Number(settings.tileSegments);
        // Clamp to valid range (must be power of 2 or common value between 16 and 256)
        sanitized.tileSegments = Math.max(16, Math.min(256, Math.round(tileSegments)));
    }

    if (settings.renderScale !== undefined) {
        const allowed = [1, 0.85, 0.7, 0.5, 0.35];
        const rs = Number(settings.renderScale);
        // Snap to nearest allowed step; default to 1 if out of range
        if (Number.isFinite(rs)) {
            let best = 1, bestErr = Infinity;
            for (const v of allowed) {
                const err = Math.abs(v - rs);
                if (err < bestErr) { bestErr = err; best = v; }
            }
            sanitized.renderScale = best;
        }
    }

    if (settings.msaaSamples !== undefined) {
        const allowed = [0, 2, 4, 8];
        const s = Math.round(Number(settings.msaaSamples));
        if (allowed.includes(s)) sanitized.msaaSamples = s;
    }

    if (settings.performancePreset !== undefined) {
        const allowed = ["Quality", "Balanced", "Fast", "Potato", "Custom"];
        const p = String(settings.performancePreset);
        if (allowed.includes(p)) sanitized.performancePreset = p;
    }
    
    if (settings.videoMaxSize !== undefined) {
        const videoMaxSize = String(settings.videoMaxSize);
        // Only allow specific allowed values
        const allowedValues = ["None", "1080P", "720P", "480P", "360P"];
        if (allowedValues.includes(videoMaxSize)) {
            sanitized.videoMaxSize = videoMaxSize;
        }
    }
    
    if (settings.lastBuildingRotation !== undefined) {
        const rotation = Number(settings.lastBuildingRotation);
        // Allow any rotation angle (will be normalized to 0-2π internally)
        if (!isNaN(rotation)) {
            sanitized.lastBuildingRotation = rotation;
        }
    }
    
    if (settings.chatModel !== undefined) {
        const chatModel = String(settings.chatModel);
        // Validate format: "provider:model" or empty string
        if (chatModel === '' || /^[a-zA-Z0-9_-]+:[a-zA-Z0-9._-]+$/.test(chatModel)) {
            sanitized.chatModel = chatModel;
        }
    }

    if (settings.centerSidebar !== undefined) {
        sanitized.centerSidebar = Boolean(settings.centerSidebar);
    }

    if (settings.showAttribution !== undefined) {
        sanitized.showAttribution = Boolean(settings.showAttribution);
    }

    if (settings.showFilename !== undefined) {
        sanitized.showFilename = Boolean(settings.showFilename);
    }

    if (settings.language !== undefined) {
        const language = String(settings.language).toLowerCase();
        if (/^[a-z]{2}$/.test(language)) {
            sanitized.language = language;
        }
    }

    // ---- New-sitch startup preferences (see applyStartupDefaults in StartupDefaults.js) ----

    if (settings.startupUnits !== undefined) {
        // Keys of SELECTABLE_UNITS in CUnits.js
        const allowed = ["nautical", "imperial", "metric", "feet"];
        const units = String(settings.startupUnits).toLowerCase();
        if (allowed.includes(units)) {
            sanitized.startupUnits = units;
        }
    }

    if (settings.startupLocation !== undefined) {
        sanitized.startupLocation = Boolean(settings.startupLocation);
    }

    if (settings.startupLat !== undefined) {
        const lat = Number(settings.startupLat);
        if (Number.isFinite(lat)) {
            sanitized.startupLat = Math.max(-90, Math.min(90, lat));
        }
    }

    if (settings.startupLon !== undefined) {
        const lon = Number(settings.startupLon);
        if (Number.isFinite(lon)) {
            sanitized.startupLon = Math.max(-180, Math.min(180, lon));
        }
    }

    if (settings.startupAlt !== undefined) {
        // Metres ABOVE GROUND, so 0 (ground level) is the floor. The ceiling is
        // arbitrary but keeps a fat-fingered paste from starting the camera in orbit.
        const alt = Number(settings.startupAlt);
        if (Number.isFinite(alt)) {
            sanitized.startupAlt = Math.max(0, Math.min(100000, alt));
        }
    }

    if (settings.startupBuildings !== undefined) {
        sanitized.startupBuildings = Boolean(settings.startupBuildings);
    }

    return sanitized;
}

// IndexedDB-based settings functions (for serverless mode)
export async function loadSettingsFromIndexedDB() {
    if (!SETTINGS_DB_ENABLED) {
        console.log("IndexedDB settings disabled by SETTINGS_DB_ENABLED flag");
        return null;
    }
    
    try {
        const settings = await indexedDBManager.getAllSettings();
        if (Object.keys(settings).length > 0) {
            const sanitized = sanitizeSettings(settings);
            console.log("Loaded settings from IndexedDB:", sanitized);
            return sanitized;
        }
        return null;
    } catch (e) {
        console.warn("Failed to load settings from IndexedDB:", e);
        return null;
    }
}

export async function saveSettingsToIndexedDB(settings) {
    if (!SETTINGS_DB_ENABLED) {
        console.log("IndexedDB settings disabled by SETTINGS_DB_ENABLED flag");
        return false;
    }
    
    try {
        const sanitized = sanitizeSettings(settings);
        for (const [key, value] of Object.entries(sanitized)) {
            await indexedDBManager.setSetting(key, value);
        }
        console.log("Saved settings to IndexedDB:", sanitized);
        return true;
    } catch (e) {
        console.warn("Failed to save settings to IndexedDB:", e);
        return false;
    }
}

// Load settings from cookie
export function loadSettingsFromCookie() {
    if (!SETTINGS_COOKIES_ENABLED) {
        console.log("Cookie settings disabled by SETTINGS_COOKIES_ENABLED flag");
        return null;
    }
    
    const cookieValue = getCookie("sitrecSettings");
    if (cookieValue) {
        try {
            const parsed = JSON.parse(cookieValue);
            const sanitized = sanitizeSettings(parsed);
            console.log("Loaded settings from cookie:", sanitized);
            return sanitized;
        } catch (e) {
            console.warn("Failed to parse settings cookie", e);
        }
    }
    return null;
}

// Save settings to cookie
export function saveSettingsToCookie(settings) {
    if (!SETTINGS_COOKIES_ENABLED) {
        console.log("Cookie settings disabled by SETTINGS_COOKIES_ENABLED flag");
        return;
    }
    
    try {
        const sanitized = sanitizeSettings(settings);
        setCookie("sitrecSettings", JSON.stringify(sanitized), 365); // Save for 1 year
        console.log("Saved settings to cookie:", sanitized);
    } catch (e) {
        console.warn("Failed to save settings cookie", e);
    }
}

// Load settings from server (S3)
export async function loadSettingsFromServer() {
    if (!SETTINGS_SERVER_ENABLED) {
        console.log("Server settings disabled by SETTINGS_SERVER_ENABLED flag");
        return null;
    }
    
    try {
        const response = await fetch(withTestUser('./sitrecServer/settings.php'), {
            method: 'GET',
            credentials: 'same-origin'
        });
        
        if (!response.ok) {
            console.warn("Server settings unavailable, status:", response.status);
            return null;
        }
        
        const data = await response.json();
        
        if (data.error) {
            console.warn("Server settings error:", data.error);
            return null;
        }
        
        if (data.settings) {
            const sanitized = sanitizeSettings(data.settings);
//            console.log("Loaded settings from server:", sanitized);
            // only log non-sensitive settings, for logging purposes
            console.log("MaxDetails:", sanitized.maxDetails, "FPS Limit:", sanitized.fpsLimit, "Tile Segments:", sanitized.tileSegments, "Video Max Size:", sanitized.videoMaxSize);

            return sanitized;
        }
        
        return null;
    } catch (e) {
        console.warn("Failed to load settings from server:", e);
        return null;
    }
}

// Save settings to server (S3)
export async function saveSettingsToServer(settings) {
    if (!SETTINGS_SERVER_ENABLED) {
        console.log("Server settings disabled by SETTINGS_SERVER_ENABLED flag");
        return false;
    }
    
    try {
        const sanitized = sanitizeSettings(settings);
        const testPayload = { ...sanitized, stripthis: "123" };
        
        const response = await fetch(withTestUser('./sitrecServer/settings.php'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ settings: testPayload })
        });
        
        if (!response.ok) {
            console.warn("Failed to save settings to server, status:", response.status);
            return false;
        }
        
        const data = await response.json();
        
        if (data.error) {
            console.warn("Server settings save error:", data.error);
            return false;
        }
        
        if (data.success) {
            console.log("Saved settings to server:", data.settings);
            
            const serverSettings = data.settings;
            for (const key of Object.keys(sanitized)) {
                assert(key in serverSettings, 
                    `Server stripped expected setting '${key}'. Client sent: ${JSON.stringify(sanitized)}, Server returned: ${JSON.stringify(serverSettings)}`);
            }
            assert(!('stripthis' in serverSettings), 
                `Server did NOT strip dummy field 'stripthis'. Server should sanitize unknown fields. Returned: ${JSON.stringify(serverSettings)}`);
            
            return true;
        }
        
        return false;
    } catch (e) {
        console.warn("Failed to save settings to server:", e);
        return false;
    }
}

/**
 * Initialize settings by loading from appropriate source
 * Priority order:
 * 1. Server (if logged in and not serverless, and SETTINGS_SERVER_ENABLED)
 * 2. IndexedDB (if serverless and SETTINGS_DB_ENABLED)
 * 3. Cookie (fallback, if SETTINGS_COOKIES_ENABLED)
 * 
 * NOTE: When adding new settings, remember to:
 *   1. Add default value here
 *   2. Update sanitizeSettings() in this file
 *   3. Update sanitizeSettings() in settings.php (if using PHP backend)
 *   4. Add UI control in CustomSupport.js setupSettingsMenu()
 *   5. Add tests in SettingsManager.test.js
 *   6. Add environment variable flag check (SETTINGS_*_ENABLED) if needed
 * @returns {Promise<Object>} The loaded settings object
 */
export async function initializeSettings() {
    // Initialize Globals.settings with defaults
    if (!Globals.settings) {
        Globals.settings = {
            // Defaults below intentionally match the "Balanced" performance
            // preset (see PERFORMANCE_PRESETS in CustomSupport.js) so that
            // performancePreset: "Balanced" is consistent on first load.
            // If you change either, change both — otherwise the preset
            // dropdown will display "Balanced" while the actual knob values
            // belong to a different preset.
            maxDetails: 20,         // matches Balanced
            fpsLimit: 30,           // matches Balanced
            tileSegments: 32,       // matches Balanced
            videoMaxSize: "720P",   // matches Balanced (None / 1080P / 720P / 480P / 360P)
            renderScale: 0.85,      // matches Balanced (0.25–1, 1=native)
            msaaSamples: 2,         // matches Balanced (0, 2, 4, 8)
            performancePreset: "Balanced",
            lastBuildingRotation: 0, // Last building rotation in radians (persists across sessions)
            chatModel: "", // AI chat model in "provider:model" format (empty = use first available)
            centerSidebar: false, // Enable center sidebar between split views
            showAttribution: true, // Show map/elevation data source attribution overlay
            showFilename: true, // Show the current video filename in the bottom overlay
            language: "en", // UI language

            // How a NEW sitch starts. These are applied to Sit before setup runs
            // (see StartupDefaults.js) and are never part of a sitch, so loading a
            // saved sitch always restores that sitch's own units and camera.
            // The defaults below reproduce the old hard-coded startup exactly.
            startupUnits: "nautical",   // nautical / imperial / metric / feet
            startupLocation: false,     // false = use the sitch's own start location
            startupLat: 34,             // only used when startupLocation is true
            startupLon: -118.3,
            startupAlt: 0,              // metres ABOVE GROUND. 0 = standing on the ground
            startupBuildings: false,    // 3D buildings on at startup (needs permission + a provider key)
        };
    }

    // BYOK key presence is derived from IndexedDB, independent of the
    // settings-load path below. It must be computed BEFORE any early returns
    // so the value is correct in every mode (regression, serverless, server).
    try {
        // Prime the synchronous key cache: terrain and tile code reads a provider key on a
        // synchronous construction path and cannot await IndexedDB.
        //
        // ONE await, deliberately. primeKeyCache() already reads every stored key, so the
        // count comes back from it rather than calling hasAnyKey() and re-reading
        // IndexedDB. That keeps this to a single await and a single read — the same shape
        // as before the cache existed. Startup ordering here has historically been
        // sensitive, so it is worth not adding awaits to this path casually.
        Globals.hasByokKeys = (await primeKeyCache()) > 0;
    } catch (e) {
        Globals.hasByokKeys = false;
    }

    if (Globals.regression) {
        console.log("Regression mode - forcing Balanced preset (deterministic; ignores saved/cookie settings)");
        // Regression screenshots must be deterministic regardless of the machine's
        // saved/cookied performance preferences. Force the Balanced preset's knobs
        // explicitly so a drifted default, a pre-set Globals.settings, or a changed
        // per-user preset can never alter regression output.
        // KEEP IN SYNC with PERFORMANCE_PRESETS.Balanced in CustomSupport.js.
        Globals.settings.performancePreset = "Balanced";
        Globals.settings.renderScale = 0.85;
        Globals.settings.msaaSamples = 2;
        Globals.settings.fpsLimit = 30;
        Globals.settings.tileSegments = 32;
        Globals.settings.maxDetails = 20;
        Globals.settings.videoMaxSize = "720P";
        Globals.settings.showAttribution = false;
        Globals.lastSettingsJSON = JSON.stringify(sanitizeSettings(Globals.settings));
        return Globals.settings;
    }
    
    // Serverless mode - use IndexedDB
    if (isServerless) {
        const indexedDBSettings = await loadSettingsFromIndexedDB();
        if (indexedDBSettings && Object.keys(indexedDBSettings).length > 0) {
            Object.assign(Globals.settings, indexedDBSettings);
            console.log("Using IndexedDB settings (serverless mode)");
            Globals.lastSettingsJSON = JSON.stringify(sanitizeSettings(Globals.settings));
            return Globals.settings;
        }
        // Fall back to cookie if IndexedDB is empty or disabled
        const savedSettings = loadSettingsFromCookie();
        if (savedSettings) {
            Object.assign(Globals.settings, savedSettings);
            console.log("Using cookie settings (serverless mode)");
        }
        Globals.lastSettingsJSON = JSON.stringify(sanitizeSettings(Globals.settings));
        return Globals.settings;
    }
    
    // Server mode - try server first (if logged in)
    if (getEffectiveUserID() > 0) {
        const serverSettings = await loadSettingsFromServer();
        if (serverSettings && Object.keys(serverSettings).length > 0) {
            Object.assign(Globals.settings, serverSettings);
            console.log("Using server settings");
            Globals.lastSettingsJSON = JSON.stringify(sanitizeSettings(Globals.settings));
            return Globals.settings;
        }
    }
    
    // Fall back to cookie if server unavailable or user not logged in
    const savedSettings = loadSettingsFromCookie();
    if (savedSettings) {
        Object.assign(Globals.settings, savedSettings);
        console.log("Using cookie settings");
    }
    
    Globals.lastSettingsJSON = JSON.stringify(sanitizeSettings(Globals.settings));
    return Globals.settings;
}

/**
 * Save settings to appropriate storage
 * Serverless mode: saves to IndexedDB + cookie
 * Server mode: saves to server + cookie
 * @param {Object} settings - The settings object to save
 * @returns {Promise<boolean>} True if saved successfully
 */
export async function saveSettings() {

    if (Globals.regression) {
        return true;
    }

    const settings = Globals.settings;
    const currentJSON = JSON.stringify(sanitizeSettings(settings));

    if (currentJSON === Globals.lastSettingsJSON) {
        // console.log("Settings unchanged, skipping save");
        return true;
    }

    // Serverless mode - use IndexedDB
    if (isServerless) {
        const indexedDBSuccess = await saveSettingsToIndexedDB(settings);
        // Also save to cookie as backup/compatibility
        saveSettingsToCookie(settings);
        if (indexedDBSuccess) {
            Globals.lastSettingsJSON = currentJSON;
        }
        return indexedDBSuccess;
    }
    
    // Server mode - try to save to server first (if logged in)
    if (getEffectiveUserID() > 0) {
        const success = await saveSettingsToServer(settings);
        if (success) {
            console.log("Settings saved to server");
            // Also save to cookie as backup
            saveSettingsToCookie(settings);
            Globals.lastSettingsJSON = currentJSON;
            return true;
        }
    }
    
    // Fall back to cookie if server unavailable or user not logged in
    saveSettingsToCookie(settings);
    Globals.lastSettingsJSON = currentJSON;
    console.log("Settings saved to cookie only");
    return true;
}

/**
 * SettingsSaver - Encapsulates intelligent debouncing logic for settings saves
 * 
 * This class manages the timing and debouncing of settings saves to prevent
 * server overload during rapid UI changes (like slider dragging) while ensuring
 * responsive saves when appropriate.
 * 
 * Features:
 * - Saves immediately if no recent save occurred (> delay period)
 * - Automatically debounces when saves occur within the delay period
 * - Supports force immediate saves via optional parameter
 * - Calculates optimal remaining delay for scheduled saves
 * 
 * Usage:
 *   const saver = new SettingsSaver();
 *   await saver.save();           // Intelligent save (immediate or debounced)
 *   await saver.save(true);        // Force immediate save
 */
export class SettingsSaver {
    /**
     * Create a new SettingsSaver
     * @param {number} delay - Minimum milliseconds between saves (default: 5000)
     */
    constructor(delay = 5000) {
        this.lastSaveTime = 0;
        this.saveTimer = null;
        this.saveDelay = delay;
    }
    
    /**
     * Save settings with intelligent debouncing
     * - Saves immediately if no recent save (> delay period ago)
     * - Schedules a delayed save if saved recently (< delay period ago)
     * - Ensures final value is always saved
     * 
     * @param {boolean} immediate - Force immediate save, bypassing debounce
     * @returns {Promise<boolean>} True if saved successfully
     */
    async save(immediate = false) {
        const now = Date.now();
        const timeSinceLastSave = now - this.lastSaveTime;
        
        // If immediate flag is set, cancel any pending save and save now
        if (immediate) {
            if (this.saveTimer) {
                clearTimeout(this.saveTimer);
                this.saveTimer = null;
            }
            this.lastSaveTime = now;
            return await saveSettings(Globals.settings);
        }
        
        // If enough time has passed since last save, save immediately
        if (timeSinceLastSave >= this.saveDelay) {
            this.lastSaveTime = now;
            return await saveSettings(Globals.settings);
        }
        
        // Otherwise, schedule a delayed save (debounce)
        // Clear any existing timer
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        
        // Schedule save for when the delay period expires
        const remainingDelay = this.saveDelay - timeSinceLastSave;
        this.saveTimer = setTimeout(async () => {
            this.lastSaveTime = Date.now();
            await saveSettings(Globals.settings);
            this.saveTimer = null;
        }, remainingDelay);
        
        return true; // Scheduled successfully
    }
    
    /**
     * Cancel any pending save
     */
    cancel() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }
    
    /**
     * Check if a save is currently scheduled
     * @returns {boolean} True if a save is pending
     */
    isPending() {
        return this.saveTimer !== null;
    }
}
