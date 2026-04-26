// SondeFetch.js — Fetch radiosonde sounding data from UWYO or IGRA2 (NCEI)
// and import it into Sitrec as a track.

import {SITREC_SERVER, SITREC_APP, isServerless} from "./configUtils";
import {FileManager, GlobalDateTimeNode, NodeMan, Sit} from "./Globals";
import {promptForText} from "./TextPrompt";
import {detectSondeFormat, listIGRA2Soundings, parseIGRA2, parseUWYOList, parseUWYOCSV} from "./ParseSonde";
import {reconstructTrajectory} from "./SondeTrajectory";
import {initProgress, updateProgress, hideProgress} from "./CProgressIndicator";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import JSZip from "jszip";

// Escape HTML metacharacters to prevent XSS when interpolating into innerHTML
function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Fetch a sounding from UWYO via the proxySounding.php CORS proxy.
 *
 * @param {string} stationId - 5-digit WMO station number (e.g. "72451")
 * @param {string} date - Date string YYYY-MM-DD
 * @param {number|string} hour - UTC hour (0 or 12)
 * @param {string} format - "csv" or "list"
 * @returns {Promise<string>} Raw HTML response from UWYO
 */
// Rate limit state: shared across all UWYO requests
let uwyoRateLimitUntil = 0; // epoch ms when rate limit expires
const RATE_LIMIT_DELAY_MS = 66000; // 1.1 minutes

/**
 * Wait until the UWYO rate limit expires, showing a countdown in the progress UI.
 * Returns a promise that resolves when the wait is over, or rejects if cancelled.
 */
function waitForRateLimit(cancelledRef) {
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (cancelledRef.cancelled) {
                reject(new Error("Cancelled"));
                return;
            }
            const remaining = Math.max(0, uwyoRateLimitUntil - Date.now());
            if (remaining <= 0) {
                resolve();
                return;
            }
            updateProgress({ status: `UWYO rate limit — waiting ${Math.ceil(remaining / 1000)}s...` });
            setTimeout(tick, 1000);
        };
        tick();
    });
}

export async function fetchUWYOSounding(stationId, date, hour, format = "list") {
    // If rate-limited, wait before making the request
    if (Date.now() < uwyoRateLimitUntil) {
        await waitForRateLimit({ cancelled: false });
    }

    const url = SITREC_SERVER + "proxySounding.php"
        + "?source=uwyo"
        + "&station=" + encodeURIComponent(stationId)
        + "&date=" + encodeURIComponent(date)
        + "&hour=" + encodeURIComponent(hour)
        + "&format=" + encodeURIComponent(format);

    const response = await fetch(url);

    if (!response.ok) {
        if (response.status === 429) {
            uwyoRateLimitUntil = Date.now() + RATE_LIMIT_DELAY_MS;
            throw new Error("UWYO rate limit hit — will retry after " + Math.ceil(RATE_LIMIT_DELAY_MS / 1000) + "s");
        }
        const errorText = await response.text();
        throw new Error(errorText || `HTTP ${response.status}`);
    }

    const text = await response.text();

    if (!text || text.trim().length === 0) {
        throw new Error("Empty response from UWYO proxy");
    }

    // Verify the response is actually sonde data
    const detectedFormat = detectSondeFormat(text);
    if (!detectedFormat) {
        throw new Error("UWYO returned data but it doesn't look like sounding data. "
            + "The station may not exist or no data is available for this date/time.");
    }

    return text;
}

// ── IGRA2 Fetch (NOAA NCEI) ──────────────────────────────────────────────

const NCEI_BASE = "https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access/";

/**
 * Fetch IGRA2 sounding data from NCEI, decompress the zip, and return the text.
 * Uses year-to-date file for the current year, full history for older years.
 *
 * @param {string} igra2Id - Full IGRA2 station ID (e.g. "USM00072451")
 * @param {number} year - Year to fetch (determines y2d vs full file)
 * @returns {Promise<string>} Raw IGRA2 text (may contain thousands of soundings)
 */
export async function fetchIGRA2Data(igra2Id, year) {
    var currentYear = new Date().getFullYear();
    var urls;
    if (year >= currentYear) {
        // Try current year's y2d first, then previous year's (NCEI may not have
        // rolled over the filename yet — beg2025 can contain early 2026 data),
        // then fall back to full period-of-record.
        urls = [
            NCEI_BASE + "data-y2d/" + igra2Id + "-data-beg" + currentYear + ".txt.zip",
            NCEI_BASE + "data-y2d/" + igra2Id + "-data-beg" + (currentYear - 1) + ".txt.zip",
            NCEI_BASE + "data-por/" + igra2Id + "-data.txt.zip",
        ];
    } else {
        urls = [
            NCEI_BASE + "data-por/" + igra2Id + "-data.txt.zip",
        ];
    }

    var response = null;
    for (var url of urls) {
        console.log("Fetching IGRA2 from: " + url);
        response = await fetch(url);
        if (response.ok) break;
        console.log("IGRA2 " + response.status + " for " + url + ", trying next...");
        response = null;
    }
    if (!response) {
        throw new Error("IGRA2 data not found for station " + igra2Id + ". Tried " + urls.length + " URLs.");
    }

    var arrayBuffer = await response.arrayBuffer();
    var zip = new JSZip();
    var contents = await zip.loadAsync(arrayBuffer);

    // Find the .txt data file in the zip
    var txtFile = null;
    for (var name in contents.files) {
        if (name.endsWith(".txt") && !contents.files[name].dir) {
            txtFile = contents.files[name];
            break;
        }
    }
    if (!txtFile) throw new Error("No .txt file found in IGRA2 zip");

    var text = await txtFile.async("text");
    if (!text || text.trim().length === 0) throw new Error("IGRA2 data file is empty");

    return text;
}

/**
 * Show a sounding picker dialog for an IGRA2 multi-sounding file.
 * Lists available soundings filtered near the target date.
 *
 * @param {string} igra2Text - Raw IGRA2 text with multiple soundings
 * @param {string} targetDate - YYYY-MM-DD to center the filter on
 * @returns {Promise<number|null>} Selected sounding index, or null if cancelled
 */
export async function pickIGRA2Sounding(igra2Text, targetDate) {
    var soundings = listIGRA2Soundings(igra2Text);
    if (soundings.length === 0) throw new Error("No soundings found in IGRA2 data");

    // Sort by proximity to target date
    var targetMs = new Date(targetDate + "T12:00:00Z").getTime();
    var sorted = soundings.map(function(s) {
        var sMs = new Date(s.date + "T" + String(s.hour != null ? s.hour : 12).padStart(2, "0") + ":00:00Z").getTime();
        return { ...s, dist: Math.abs(sMs - targetMs) };
    }).sort(function(a, b) { return a.dist - b.dist; });

    return new Promise(function(resolve) {
        var overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;";

        var dialog = document.createElement("div");
        dialog.style.cssText = "background:#1a1a2e;color:#e0e0e0;border-radius:8px;padding:20px;width:450px;max-height:70vh;display:flex;flex-direction:column;font-family:sans-serif;";

        dialog.innerHTML =
            '<h3 style="margin:0 0 10px 0;color:#fff;">Select Sounding (' + esc(soundings.length) + ' available)</h3>' +
            '<div style="font-size:11px;color:#888;margin-bottom:8px;">Nearest to ' + esc(targetDate) + ' shown first</div>' +
            '<div id="igra2-sounding-list" style="overflow-y:auto;flex:1;max-height:50vh;"></div>' +
            '<div style="margin-top:10px;text-align:right;">' +
            '<button id="igra2-cancel" style="padding:6px 16px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancel</button></div>';

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        var listDiv = dialog.querySelector("#igra2-sounding-list");
        var cancelBtn = dialog.querySelector("#igra2-cancel");

        // Show nearest 100 soundings
        listDiv.innerHTML = sorted.slice(0, 100).map(function(s) {
            var hourStr = s.hour != null ? String(s.hour).padStart(2, "0") + "Z" : "??Z";
            var daysAway = Math.round(s.dist / 86400000);
            var distLabel = daysAway === 0 ? "today" : daysAway + "d away";
            return '<div class="igra2-item" data-index="' + esc(s.index) + '"' +
                ' style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #333;font-size:13px;"' +
                ' onmouseover="this.style.background=\'#3a3a5a\'" onmouseout="this.style.background=\'transparent\'">' +
                '<b>' + esc(s.date) + ' ' + esc(hourStr) + '</b>' +
                ' <span style="color:#888;font-size:11px;">(' + esc(s.numLevels) + ' levels, ' + esc(distLabel) + ')</span></div>';
        }).join("");

        listDiv.addEventListener("click", function(e) {
            var item = e.target.closest(".igra2-item");
            if (item) {
                document.body.removeChild(overlay);
                resolve(parseInt(item.dataset.index));
            }
        });

        cancelBtn.addEventListener("click", function() {
            document.body.removeChild(overlay);
            resolve(null);
        });

        overlay.addEventListener("click", function(e) {
            if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); }
        });
    });
}

// Station list cache
let stationListCache = null;

/**
 * Load the IGRA2 station list JSON (cached after first load).
 * @returns {Promise<Array<{id, wmo, name, lat, lon, elev, country, firstYear, lastYear}>>}
 */
export async function loadStationList() {
    if (stationListCache) return stationListCache;
    const url = SITREC_APP + "data/igra2-stations.json";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Failed to load station list");
    stationListCache = await resp.json();
    return stationListCache;
}


/**
 * Look up precise station coordinates from the IGRA2 station database.
 * UWYO LIST HTML truncates coordinates to 2 decimal places (~1-2 km error).
 * The IGRA2 database has 4-decimal precision (~10 m accuracy).
 *
 * Synchronous — uses the cached station list if already loaded.
 * @param {string} wmoId - 5-digit WMO station number
 * @returns {{lat: number, lon: number, elev: number, name: string}|null}
 */
export function lookupStationPosition(wmoId) {
    if (!stationListCache || !wmoId) return null;
    const station = stationListCache.find(s => s.wmo === wmoId);
    if (!station) return null;
    return { lat: station.lat, lon: station.lon, elev: station.elev, name: station.name };
}

/**
 * Haversine distance in km between two lat/lon points.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Show a searchable station picker dialog.
 * Sorts by proximity to the lookCamera (the observer's position) so
 * scrolling through the unfiltered list shows the most relevant
 * stations first.
 * @returns {Promise<{wmo: string, name: string}|null>} Selected station or null if cancelled.
 */
export async function pickStation() {
    const stations = await loadStationList();

    // Sort anchor: lookCamera position. Falls back to Sit.lat/lon (legacy
    // fixed-camera sitches that don't expose a lookCamera) so the dialog
    // never hard-fails — a globe-distance sort against (0,0) is wrong but
    // not broken.
    let sitLat, sitLon;
    let sortAnchor = "lookCamera";
    try {
        const lookCamera = NodeMan.get("lookCamera").camera;
        const lla = ECEFToLLAVD_radii(lookCamera.position);
        sitLat = lla.x;
        sitLon = lla.y;
    } catch {
        sitLat = Sit.lat || 0;
        sitLon = Sit.lon || 0;
        sortAnchor = "sitch center";
    }
    let simYear;
    try {
        simYear = GlobalDateTimeNode.frameToDate(0).getUTCFullYear();
    } catch {
        simYear = new Date().getFullYear();
    }
    const sorted = stations
        .filter(s => s.wmo && s.lastYear >= simYear)
        .map(s => ({ ...s, dist: haversineKm(sitLat, sitLon, s.lat, s.lon) }))
        .sort((a, b) => a.dist - b.dist);

    return new Promise((resolve) => {
        // Build modal dialog
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;";

        const dialog = document.createElement("div");
        dialog.style.cssText = "background:#1a1a2e;color:#e0e0e0;border-radius:8px;padding:20px;width:500px;max-height:70vh;display:flex;flex-direction:column;font-family:sans-serif;";

        dialog.innerHTML = `
            <h3 style="margin:0 0 10px 0;color:#fff;">Select Radiosonde Station</h3>
            <input type="text" id="sonde-search" placeholder="Search by name, ID, or country..."
                style="width:100%;padding:8px;margin-bottom:10px;background:#2a2a4a;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;font-size:14px;">
            <div style="font-size:11px;color:#888;margin-bottom:5px;">Sorted by distance from ${sortAnchor} (${sitLat.toFixed(1)}°, ${sitLon.toFixed(1)}°)</div>
            <div id="sonde-station-list" style="overflow-y:auto;flex:1;max-height:50vh;"></div>
            <div style="margin-top:10px;text-align:right;">
                <button id="sonde-cancel" style="padding:6px 16px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const searchInput = dialog.querySelector("#sonde-search");
        const listDiv = dialog.querySelector("#sonde-station-list");
        const cancelBtn = dialog.querySelector("#sonde-cancel");

        function renderList(filter) {
            const needle = (filter || "").toLowerCase();
            const filtered = needle
                ? sorted.filter(s => s.name.toLowerCase().includes(needle) || s.wmo.includes(needle) || s.id.toLowerCase().includes(needle) || s.country.toLowerCase().includes(needle))
                : sorted.slice(0, 50); // show nearest 50 by default

            listDiv.innerHTML = filtered.slice(0, 100).map(s =>
                `<div class="sonde-station-item" data-wmo="${s.wmo}" data-name="${s.name}" data-igraid="${s.id}"
                    style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #333;font-size:13px;"
                    onmouseover="this.style.background='#3a3a5a'" onmouseout="this.style.background='transparent'">
                    <b>${s.wmo}</b> — ${s.name} <span style="color:#888;font-size:11px;">(${s.country}, ${s.dist.toFixed(0)} km, ${s.lat.toFixed(2)}° ${s.lon.toFixed(2)}°)</span>
                </div>`
            ).join("");
        }

        renderList("");
        searchInput.focus();
        searchInput.addEventListener("input", () => renderList(searchInput.value));

        listDiv.addEventListener("click", (e) => {
            const item = e.target.closest(".sonde-station-item");
            if (item) {
                document.body.removeChild(overlay);
                resolve({ wmo: item.dataset.wmo, name: item.dataset.name, id: item.dataset.igraid });
            }
        });

        cancelBtn.addEventListener("click", () => {
            document.body.removeChild(overlay);
            resolve(null);
        });

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
                resolve(null);
            }
        });

        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                document.body.removeChild(overlay);
                resolve(null);
            }
        });
    });
}

/**
 * Auto-import the nearest station's latest sounding. For quick testing.
 * Uses today's date and 12Z by default.
 */
/**
 * Import the N nearest weather balloon soundings to the camera position.
 * Picks the most recent sounding launched before startTime + 1 hour.
 *
 * @param {number} count - Number of nearby stations to import (1-10)
 * @param {string} source - "uwyo" or "igra2"
 * @returns {Promise<Array>} Array of {station, filename, success, error?} results
 */
export async function getNearbyWeatherBalloons(count = 1, source = "uwyo") {
    count = Math.max(1, Math.min(count, 10));

    const cancelledRef = { cancelled: false };

    initProgress({
        title: "Loading Weather Balloons",
        showAbort: true,
        onAbort: () => { cancelledRef.cancelled = true; },
    });
    updateProgress({ status: "Loading station list..." });

    const stations = await loadStationList();

    // Get lookCamera position for proximity sorting
    let camLat, camLon;
    try {
        const lookCamera = NodeMan.get("lookCamera").camera;
        const lla = ECEFToLLAVD_radii(lookCamera.position);
        camLat = lla.x;
        camLon = lla.y;
    } catch {
        camLat = Sit.lat || 0;
        camLon = Sit.lon || 0;
    }

    // Target time: sitch start + 1 hour
    let targetDate;
    try {
        targetDate = GlobalDateTimeNode.frameToDate(0);
        targetDate = new Date(targetDate.getTime() + 3600000); // +1 hour
    } catch {
        targetDate = new Date();
    }

    // Find the most recent 00Z or 12Z launch before target
    const targetHour = targetDate.getUTCHours();
    let launchHour, launchDate;
    if (targetHour >= 12) {
        launchHour = 12;
        launchDate = targetDate.toISOString().slice(0, 10);
    } else {
        // Before 12Z today → use 00Z today, or 12Z yesterday
        launchHour = 0;
        launchDate = targetDate.toISOString().slice(0, 10);
    }

    // Sort stations by proximity to camera, excluding inactive stations
    const targetYear = targetDate.getUTCFullYear();
    const sorted = stations
        .filter(s => s.wmo && s.lastYear >= targetYear)
        .map(s => ({ ...s, dist: haversineKm(camLat, camLon, s.lat, s.lon) }))
        .sort((a, b) => a.dist - b.dist);

    // Walk the sorted list until we have `count` successful imports *with
    // usable wind data*, or we hit the attempt cap. A successful fetch
    // whose resulting profile has no wind levels is discarded and we keep
    // going — e.g. the station had a launch at that date but the sensor
    // failed, so the imported track is useless as a wind sample.
    const maxAttempts = Math.min(sorted.length, count * 3);
    const results = [];
    let successes = 0;

    for (let idx = 0; idx < maxAttempts && successes < count; idx++) {
        if (cancelledRef.cancelled) {
            console.log("Weather balloon import cancelled by user");
            break;
        }

        const station = sorted[idx];
        const label = `${station.wmo} ${station.name} (${Math.round(station.dist)}km)`;
        updateProgress({ status: `Fetching ${successes + 1}/${count}: ${label}` });

        try {
            let filename;
            if (source === "igra2" && station.id) {
                // IGRA2 path
                const year = parseInt(launchDate.split("-")[0]);
                updateProgress({ status: `Downloading IGRA2 archive for ${label}...` });
                const text = await fetchIGRA2Data(station.id, year);
                const soundings = listIGRA2Soundings(text);

                // Find sounding closest to target but not after target + 1h
                const targetMs = targetDate.getTime();
                let bestIdx = 0;
                let bestDist = Infinity;
                for (const s of soundings) {
                    const sHour = s.hour != null ? s.hour : 12;
                    const sMs = new Date(s.date + "T" + String(sHour).padStart(2, "0") + ":00:00Z").getTime();
                    if (sMs <= targetMs) {
                        const dist = targetMs - sMs;
                        if (dist < bestDist) { bestDist = dist; bestIdx = s.index; }
                    }
                }

                const single = extractSingleSounding(text, bestIdx);
                const sel = soundings.find(s => s.index === bestIdx);
                const hourStr = sel && sel.hour != null ? String(sel.hour).padStart(2, "0") + "Z" : "00Z";
                filename = `igra2_${station.id}_${sel ? sel.date : launchDate}_${hourStr}.txt`;
                updateProgress({ status: `Importing ${label}...` });
                await FileManager.parseResult(filename, new TextEncoder().encode(single).buffer);
            } else {
                // UWYO path — check for rate limit before fetching
                if (Date.now() < uwyoRateLimitUntil) {
                    await waitForRateLimit(cancelledRef);
                    if (cancelledRef.cancelled) break;
                }
                updateProgress({ status: `Fetching UWYO for ${label}...` });
                const html = await fetchUWYOSounding(station.wmo, launchDate, launchHour, "list");
                filename = `sounding_${station.wmo}_${launchDate}_${String(launchHour).padStart(2, "0")}Z.html`;
                updateProgress({ status: `Importing ${label}...` });
                await FileManager.parseResult(filename, new TextEncoder().encode(html).buffer);
            }

            if (profileHasUsableWind(station, filename)) {
                console.log(`Imported balloon: ${station.wmo} ${station.name} (${Math.round(station.dist)}km away)`);
                results.push({ station: station.wmo, name: station.name, dist: Math.round(station.dist), filename, success: true });
                successes++;
            } else {
                console.warn(`Imported ${station.wmo} ${station.name} but it has no usable wind profile — trying next station`);
                results.push({ station: station.wmo, name: station.name, success: false, error: "no usable wind data" });
            }
        } catch (e) {
            if (e.message.includes("rate limit")) {
                // Rate limit hit — wait and retry this station
                updateProgress({ status: `Rate limited — waiting...` });
                try {
                    await waitForRateLimit(cancelledRef);
                    if (!cancelledRef.cancelled) {
                        idx--; // retry this station
                    }
                } catch { /* cancelled */ }
            } else {
                console.error(`Failed to import ${station.wmo} ${station.name}: ${e.message}`);
                results.push({ station: station.wmo, name: station.name, success: false, error: e.message });
            }
        }
    }

    if (successes < count) {
        console.warn(`Sounding fetch: wanted ${count}, got ${successes} after ${results.length} attempts`);
    }

    hideProgress();
    return results;
}

// After an import, check that a CNodeAtmosphericProfile exists for this
// station and has at least a couple of wind levels. Filters out stations
// that reported a launch but had no usable wind data (equipment failure,
// truncated telemetry, etc).
function profileHasUsableWind(station, filename) {
    const wmo = station.wmo;
    let found = null;
    NodeMan.iterate((id, node) => {
        if (!node || node.constructor?.name !== "CNodeAtmosphericProfile") return;
        // Match by stationId prefix — UWYO uses the WMO number directly,
        // IGRA2 encodes it inside a longer id (e.g. "USM00072451").
        if (node.stationId && node.stationId.includes(wmo)) found = node;
    });
    if (!found) return false;
    const windLevels = found.getWindProfile();
    // At least 2 levels — single-level profiles can't be interpolated.
    return windLevels.length >= 2;
}

// Semantic alias. The wind system treats these as soundings, not "balloons".
// Keep both exports — the old name is part of the CSitrecAPI allowlist.
export const getNearbySoundings = getNearbyWeatherBalloons;

/**
 * Import Sounding dialog — station picker + date/hour, fetches from UWYO,
 * and imports into the current sitch as a track.
 *
 * Called from the File menu.
 */
export async function importSoundingDialog() {
    // Step 1: Station picker
    let station;
    try {
        station = await pickStation();
    } catch (e) {
        console.warn("Station picker failed, falling back to manual entry:", e.message);
        const stationId = await promptForText({
            title: "Import Sounding — Station",
            message: "Enter WMO station number (5 digits).\n"
                + "Examples: 72451 (Sterling VA), 72426 (Amarillo TX), 72681 (Boise ID)",
            defaultValue: "72451",
            validate: (val) => {
                if (!/^\d{5}$/.test(val.trim())) return "Must be exactly 5 digits";
                return "";
            },
        });
        if (stationId === null) return;
        station = { wmo: stationId.trim(), name: stationId.trim(), id: "" };
    }
    if (!station) return;

    // Step 2: Source selection
    const source = await promptForText({
        title: `Import Sounding — Source (${station.wmo} ${station.name})`,
        message: "Choose data source:\n"
            + "  uwyo  — University of Wyoming (recent data, needs PHP proxy)\n"
            + "  igra2 — NOAA NCEI archive (historical data, direct download)\n",
        defaultValue: isServerless ? "igra2" : "uwyo",
        validate: (val) => {
            const v = val.trim().toLowerCase();
            if (v !== "uwyo" && v !== "igra2") return "Enter 'uwyo' or 'igra2'";
            return "";
        },
    });
    if (source === null) return;

    // Step 3: Date — default to the sitch's start date (frame 0) so the
    // imported sounding lines up with the data the user is analyzing.
    // Falls back to today only if there's no sitch clock yet.
    let defaultDate;
    try {
        const sitStart = GlobalDateTimeNode.frameToDate(0);
        defaultDate = sitStart.toISOString().slice(0, 10);
    } catch {
        defaultDate = new Date().toISOString().slice(0, 10);
    }
    const dateStr = await promptForText({
        title: `Import Sounding — Date (${station.wmo} ${station.name})`,
        message: "Enter sounding date (YYYY-MM-DD).\n"
            + "Most stations launch at 00Z and 12Z daily.\n"
            + "Defaults to the sitch start date.",
        defaultValue: defaultDate,
        validate: (val) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) return "Use YYYY-MM-DD format";
            return "";
        },
    });
    if (dateStr === null) return;
    const date = dateStr.trim();

    if (source.trim().toLowerCase() === "igra2") {
        // IGRA2 path: fetch zip → decompress → pick sounding → import
        await importViaIGRA2(station, date);
    } else {
        // UWYO path: fetch via PHP proxy
        await importViaUWYO(station, date);
    }
}

async function importViaUWYO(station, date) {
    // Default hour: the most recent 00Z / 12Z launch on or before the
    // sitch start time (matching getNearbyWeatherBalloons' auto-pick
    // logic, so manual + auto imports converge on the same launch).
    let defaultHour = "12";
    try {
        const sitStart = GlobalDateTimeNode.frameToDate(0);
        defaultHour = sitStart.getUTCHours() >= 12 ? "12" : "0";
    } catch { /* leave default */ }
    const hourStr = await promptForText({
        title: `Import Sounding — Hour (${station.wmo} ${station.name})`,
        message: "Enter UTC launch hour (0 or 12).\n"
            + "Defaults to the most recent launch on the sitch start date.",
        defaultValue: defaultHour,
        validate: (val) => {
            const v = val.trim();
            if (v !== "0" && v !== "00" && v !== "12") return "Must be 0 or 12";
            return "";
        },
    });
    if (hourStr === null) return;
    const hour = parseInt(hourStr.trim());

    try {
        console.log(`Fetching UWYO sounding: station=${station.wmo}, date=${date}, hour=${hour}`);
        const html = await fetchUWYOSounding(station.wmo, date, hour, "list");
        const filename = `sounding_${station.wmo}_${date}_${String(hour).padStart(2, '0')}Z.html`;
        await FileManager.parseResult(filename, new TextEncoder().encode(html).buffer);
        console.log("Sounding imported: " + filename);
    } catch (e) {
        alert("Failed to import sounding:\n" + e.message);
        console.error("Sounding import error:", e);
    }
}

async function importViaIGRA2(station, date) {
    // Need the full IGRA2 ID (e.g. "USM00072451"), not just the WMO number
    const igra2Id = station.id || "";
    if (!igra2Id) {
        alert("IGRA2 requires the full station ID (e.g. USM00072451). "
            + "This station doesn't have one in the database. Try UWYO instead.");
        return;
    }

    try {
        const year = parseInt(date.split("-")[0]);
        console.log(`Fetching IGRA2: station=${igra2Id}, year=${year}`);

        const text = await fetchIGRA2Data(igra2Id, year);
        console.log("IGRA2 data fetched, finding soundings...");

        // Pick a sounding near the requested date
        const selectedIndex = await pickIGRA2Sounding(text, date);
        if (selectedIndex === null) return; // cancelled

        // Import the selected sounding by feeding the FULL text + index into the pipeline.
        // CTrackFileSonde will parse with soundingIndex=0 by default, but we need to
        // extract just the selected sounding and feed it as a standalone file.
        const soundings = listIGRA2Soundings(text);
        const selected = soundings.find(s => s.index === selectedIndex);
        const hourStr = selected && selected.hour != null ? String(selected.hour).padStart(2, "0") + "Z" : "00Z";
        const dateStr = selected ? selected.date : date;

        // Extract just this one sounding from the text
        const singleSounding = extractSingleSounding(text, selectedIndex);

        const filename = `igra2_${igra2Id}_${dateStr}_${hourStr}.txt`;
        await FileManager.parseResult(filename, new TextEncoder().encode(singleSounding).buffer);
        console.log("IGRA2 sounding imported: " + filename);

    } catch (e) {
        alert("Failed to import IGRA2 sounding:\n" + e.message);
        console.error("IGRA2 import error:", e);
    }
}

/**
 * Extract a single sounding (header + data lines) from an IGRA2 multi-sounding file.
 */
function extractSingleSounding(text, soundingIndex) {
    const lines = text.split("\n");
    let headerCount = -1;
    let start = -1;
    let end = lines.length;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#")) {
            headerCount++;
            if (headerCount === soundingIndex) {
                start = i;
            } else if (headerCount === soundingIndex + 1) {
                end = i;
                break;
            }
        }
    }

    if (start < 0) return text; // fallback: return everything
    return lines.slice(start, end).join("\n");
}

/**
 * Compare a wind-reconstructed sonde trajectory against GPS ground truth.
 *
 * Fetches both UWYO CSV (GPS) and LIST (wind-only) for the same station/date/hour,
 * imports both as tracks, and computes error metrics.
 *
 * @param {string} stationId - 5-digit WMO station number
 * @param {string} date - YYYY-MM-DD
 * @param {number|string} hour - UTC hour (0 or 12)
 * @returns {Promise<Object>} Comparison results with error metrics
 */
export async function compareSondeTrajectory(stationId, date, hour) {
    // Ensure station list is loaded so lookupStationPosition works
    await loadStationList();

    // Fetch both formats for the same sounding
    console.log(`Fetching UWYO CSV (GPS) for ${stationId} ${date} ${hour}Z...`);
    const csvHtml = await fetchUWYOSounding(stationId, date, hour, "csv");

    console.log(`Fetching UWYO LIST (wind) for ${stationId} ${date} ${hour}Z...`);
    const listHtml = await fetchUWYOSounding(stationId, date, hour, "list");

    // Parse both
    const csvSonde = parseUWYOCSV(csvHtml);
    const listSonde = parseUWYOList(listHtml);

    if (!csvSonde || csvSonde.levels.length === 0) {
        throw new Error("CSV (GPS) data not available for this sounding. Not all stations provide CSV format.");
    }
    if (!listSonde || listSonde.levels.length === 0) {
        throw new Error("LIST (wind) data not available for this sounding.");
    }

    // Reconstruct trajectories
    const gpsTrajectory = reconstructTrajectory(csvSonde);    // GPS ground truth

    // Use precise IGRA2 coordinates if available, otherwise fall back to GPS start position.
    // UWYO LIST HTML truncates coords to 2 decimals (~2 km error);
    // IGRA2 database has 4-decimal precision (~35m from actual launch site).
    const precise = lookupStationPosition(stationId);
    if (precise) {
        listSonde.station.lat = precise.lat;
        listSonde.station.lon = precise.lon;
    } else if (gpsTrajectory.length > 0) {
        listSonde.station.lat = gpsTrajectory[0].lat;
        listSonde.station.lon = gpsTrajectory[0].lon;
    }
    const windTrajectory = reconstructTrajectory(listSonde);  // wind-integrated estimate

    if (gpsTrajectory.length < 2 || windTrajectory.length < 2) {
        throw new Error("Insufficient trajectory points for comparison.");
    }

    // Compute error metrics FIRST (before import, which may fail during rendering)
    // For each wind-reconstructed point, find nearest GPS point by time
    // Match by ALTITUDE, not time. The LIST format uses a nominal 12Z epoch while
    // the CSV has the actual launch time (~11:09Z), so time-matching produces huge
    // offsets. Altitude is the common axis for both sounding types.
    const errors = [];
    for (const wp of windTrajectory) {
        let bestIdx = 0;
        let bestDa = Math.abs(gpsTrajectory[0].alt - wp.alt);
        for (let i = 1; i < gpsTrajectory.length; i++) {
            const da = Math.abs(gpsTrajectory[i].alt - wp.alt);
            if (da < bestDa) {
                bestDa = da;
                bestIdx = i;
            }
        }

        const gp = gpsTrajectory[bestIdx];
        const horizDist = haversineKm(wp.lat, wp.lon, gp.lat, gp.lon) * 1000; // meters

        errors.push({
            altKm: wp.alt / 1000,
            horizError_m: horizDist,
            altMatchDiff_m: Math.round(bestDa),
            windLat: wp.lat,
            windLon: wp.lon,
            gpsLat: gp.lat,
            gpsLon: gp.lon,
        });
    }

    // Summary statistics
    const horizErrors = errors.map(e => e.horizError_m);
    const sortedHoriz = [...horizErrors].sort((a, b) => a - b);
    const maxIdx = horizErrors.indexOf(Math.max(...horizErrors));

    const stats = {
        station: stationId,
        date,
        hour,
        gpsPoints: gpsTrajectory.length,
        windPoints: windTrajectory.length,
        comparedPoints: errors.length,
        horizontalError: {
            mean_m: Math.round(horizErrors.reduce((a, b) => a + b, 0) / horizErrors.length),
            median_m: Math.round(sortedHoriz[Math.floor(sortedHoriz.length / 2)]),
            max_m: Math.round(Math.max(...horizErrors)),
            max_km: (Math.max(...horizErrors) / 1000).toFixed(1),
            atMaxAlt_km: errors[maxIdx].altKm.toFixed(1),
        },
    };

    // Log to console in a readable format
    console.log("\n=== Sonde Trajectory Comparison ===");
    console.log(`Station: ${stationId}, Date: ${date} ${hour}Z`);
    console.log(`GPS track: ${gpsTrajectory.length} points, Wind-reconstructed: ${windTrajectory.length} points`);
    console.log(`Horizontal error: mean=${stats.horizontalError.mean_m}m, median=${stats.horizontalError.median_m}m, max=${stats.horizontalError.max_km}km (at ${stats.horizontalError.atMaxAlt_km}km alt)`);
    console.log("===================================\n");

    // Log per-level errors for detailed analysis
    console.log("Per-level errors (altitude → horizontal error):");
    for (const e of errors) {
        console.log(`  ${e.altKm.toFixed(1)}km → ${e.horizError_m.toFixed(0)}m horiz (alt match: ±${e.altMatchDiff_m}m)`);
    }

    // Import both as tracks for visual comparison (may fail if sitch isn't set up for it)
    const csvFilename = `sonde_GPS_${stationId}_${date}_${String(hour).toString().padStart(2, '0')}Z.html`;
    const listFilename = `sonde_WIND_${stationId}_${date}_${String(hour).toString().padStart(2, '0')}Z.html`;
    try {
        // CTrackFileSonde now uses precise IGRA2 coordinates (~35m accuracy)
        // instead of the truncated UWYO LIST HTML values (~2 km error)
        await FileManager.parseResult(listFilename, new TextEncoder().encode(listHtml).buffer);
        await FileManager.parseResult(csvFilename, new TextEncoder().encode(csvHtml).buffer);
        stats.files = { gps: csvFilename, wind: listFilename };
    } catch (e) {
        console.warn("Track import failed (comparison metrics still valid):", e.message);
        stats.files = { error: e.message };
    }

    return { stats, errors };
}
