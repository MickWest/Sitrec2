import {parseSingleCoordinate} from "./CoordinateParser";
// ParseSonde.js — Parsers for radiosonde sounding data
// Supports: IGRA2 fixed-width text, UWYO TEXT:LIST HTML, UWYO TEXT:CSV HTML

/**
 * @typedef {Object} SondeLevel
 * @property {number|null} time_s    - Seconds since launch (null if unavailable)
 * @property {number|null} pressure  - Pressure in hPa (null if missing)
 * @property {number|null} height    - Geopotential height in meters (null if missing)
 * @property {number|null} temp      - Temperature in °C (null if missing)
 * @property {number|null} rh        - Relative humidity % (null if missing)
 * @property {number|null} dewpoint  - Dewpoint temperature in °C (null if missing)
 * @property {number|null} windDir   - Wind direction in degrees, 0=N (null if missing)
 * @property {number|null} windSpeed - Wind speed in m/s (null if missing)
 * @property {number|null} lat       - GPS latitude (UWYO CSV only)
 * @property {number|null} lon       - GPS longitude (UWYO CSV only)
 */

/**
 * @typedef {Object} SondeData
 * @property {Object} station         - Station metadata
 * @property {number} station.lat     - Station latitude
 * @property {number} station.lon     - Station longitude
 * @property {number} station.elev    - Station elevation (m)
 * @property {string} station.id      - Station identifier
 * @property {string} station.name    - Station name
 * @property {Date}   datetime        - Launch datetime (UTC)
 * @property {SondeLevel[]} levels    - Array of sounding levels
 * @property {string} source          - "igra2" | "uwyo-list" | "uwyo-csv"
 * @property {boolean} hasGPS         - Whether GPS positions are available
 */

const IGRA2_MISSING = -9999;
const IGRA2_REMOVED = -8888;

function isMissing(val) {
    return val === IGRA2_MISSING || val === IGRA2_REMOVED;
}

/**
 * Parse an integer from a fixed-width field, returning null if missing.
 */
function parseFixedInt(line, start, end) {
    const s = line.substring(start, end).trim();
    if (s === '' || s === '-') return null;
    const v = parseInt(s, 10);
    if (isNaN(v)) return null;
    return v;
}

/**
 * Detect which sonde format a string is.
 * @param {string} text
 * @returns {"igra2"|"uwyo-list"|"uwyo-csv"|null}
 */
export function detectSondeFormat(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trimStart();

    // IGRA2: # followed by station ID pattern like USM00072451
    // Allow up to 20 preceding lines (metadata/headers) before the first # line
    if (/^#[A-Z]{2}[A-Z0-9]\d{8}\s/m.test(trimmed)) {
        const lines = trimmed.split('\n');
        for (let i = 0; i < Math.min(lines.length, 20); i++) {
            if (/^#[A-Z]{2}[A-Z0-9]\d{8}\s/.test(lines[i])) return "igra2";
        }
    }

    // UWYO CSV: contains the CSV header signature (may be inside HTML <pre> tags)
    if (trimmed.includes('time,longitude,latitude,pressure') ||
        trimmed.includes('time, longitude, latitude, pressure')) return "uwyo-csv";

    // UWYO LIST: contains the table header with PRES, HGHT, TEMP (any whitespace separation)
    if (/PRES\s+HGHT\s+TEMP/.test(trimmed) ||
        (trimmed.includes('University of Wyoming') && trimmed.includes('PRES'))) return "uwyo-list";

    return null;
}

/**
 * Strip any preceding lines before the first IGRA2 header line.
 * Returns the text starting from the first # header line.
 */
export function stripIGRA2Preamble(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (/^#[A-Z]{2}[A-Z0-9]\d{8}\s/.test(lines[i])) {
            return lines.slice(i).join('\n');
        }
    }
    return text;
}

// ─── IGRA2 Parser ────────────────────────────────────────────────────────

/**
 * Count the number of soundings (header lines) in an IGRA2 file.
 */
export function countIGRA2Soundings(text) {
    let count = 0;
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.startsWith('#')) count++;
    }
    return count;
}

/**
 * List all soundings in an IGRA2 file (header info only).
 * @returns {Array<{index: number, date: string, hour: number, numLevels: number, stationId: string}>}
 */
export function listIGRA2Soundings(text) {
    const soundings = [];
    const lines = text.split('\n');
    let idx = 0;
    for (const line of lines) {
        if (line.startsWith('#')) {
            const stationId = line.substring(1, 12).trim();
            const year = parseFixedInt(line, 13, 17);
            const month = parseFixedInt(line, 18, 20);
            const day = parseFixedInt(line, 21, 23);
            const hour = parseFixedInt(line, 24, 26);
            const numLevels = parseFixedInt(line, 32, 36);
            const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            soundings.push({
                index: idx,
                date: dateStr,
                hour: hour != null && hour !== 99 ? hour : null,
                numLevels: numLevels || 0,
                stationId,
            });
            idx++;
        }
    }
    return soundings;
}

/**
 * Parse one sounding from an IGRA2 file.
 *
 * IGRA2 fixed-width columns:
 *   Header: #ID(1-12) YEAR(14-17) MONTH(19-20) DAY(22-23) HOUR(25-26) RELTIME(28-31)
 *           NUMLEV(33-36) ... LAT(56-62) LON(64-71)
 *   Data:   LVLTYP1(1) LVLTYP2(2) ETIME(4-8) PRESS(10-15) GPH(17-21)
 *           TEMP(23-27) RH(29-33) DPDP(35-39) WDIR(41-45) WSPD(47-51)
 *
 * @param {string} text - Full IGRA2 file text
 * @param {number} soundingIndex - Which sounding to extract (0-based)
 * @returns {SondeData|null}
 */
export function parseIGRA2(text, soundingIndex = 0) {
    const lines = text.split('\n');
    let headerCount = -1;
    let headerLine = null;
    let dataStart = -1;

    // Find the Nth header
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#')) {
            headerCount++;
            if (headerCount === soundingIndex) {
                headerLine = lines[i];
                dataStart = i + 1;
                break;
            }
        }
    }

    if (!headerLine) return null;

    // Parse header
    const stationId = headerLine.substring(1, 12).trim();
    const year  = parseFixedInt(headerLine, 13, 17);
    const month = parseFixedInt(headerLine, 18, 20);
    const day   = parseFixedInt(headerLine, 21, 23);
    let hour    = parseFixedInt(headerLine, 24, 26);
    const reltime = parseFixedInt(headerLine, 27, 31);
    const numLevels = parseFixedInt(headerLine, 32, 36) || 0;
    const latRaw = parseFixedInt(headerLine, 55, 62);
    const lonRaw = parseFixedInt(headerLine, 63, 71);

    if (year == null || month == null || day == null) return null;

    // Hour: 99 = missing; try RELTIME (HHMM) as fallback
    if (hour === 99 || hour == null) {
        if (reltime != null && reltime !== 9999) {
            hour = Math.floor(reltime / 100);
        } else {
            hour = 0;
        }
    }

    const lat = latRaw != null ? latRaw / 10000 : 0;
    const lon = lonRaw != null ? lonRaw / 10000 : 0;

    const datetime = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));

    // Parse data levels
    const levels = [];
    for (let i = dataStart; i < dataStart + numLevels && i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#') || line.trim() === '') break;

        const etimeRaw = parseFixedInt(line, 3, 8);
        const pressRaw = parseFixedInt(line, 9, 15);
        const gphRaw   = parseFixedInt(line, 16, 21);
        const tempRaw  = parseFixedInt(line, 22, 27);
        const rhRaw    = parseFixedInt(line, 28, 33);
        const dpdpRaw  = parseFixedInt(line, 34, 39);
        const wdirRaw  = parseFixedInt(line, 40, 45);
        const wspdRaw  = parseFixedInt(line, 46, 51);

        const pressure = (pressRaw != null && !isMissing(pressRaw)) ? pressRaw / 100 : null; // Pa → hPa
        const height   = (gphRaw != null && !isMissing(gphRaw)) ? gphRaw : null;
        const temp     = (tempRaw != null && !isMissing(tempRaw)) ? tempRaw / 10 : null;
        const rh       = (rhRaw != null && !isMissing(rhRaw)) ? rhRaw / 10 : null;
        const dewpoint = (dpdpRaw != null && !isMissing(dpdpRaw)) ? dpdpRaw / 10 : null;
        const windDir  = (wdirRaw != null && !isMissing(wdirRaw)) ? wdirRaw : null;
        const windSpeed = (wspdRaw != null && !isMissing(wspdRaw)) ? wspdRaw / 10 : null;

        // Convert ETIME from MMMSS (minutes*100 + seconds) to total seconds
        let time_s = null;
        if (etimeRaw != null && !isMissing(etimeRaw)) {
            const minutes = Math.floor(etimeRaw / 100);
            const seconds = etimeRaw % 100;
            time_s = minutes * 60 + seconds;
        }

        // Skip levels with no useful positional data
        if (height == null && pressure == null) continue;

        levels.push({
            time_s,
            pressure,
            height,
            temp,
            rh,
            dewpoint,
            windDir,
            windSpeed,
            lat: null,
            lon: null,
        });
    }

    return {
        station: { lat, lon, elev: 0, id: stationId, name: stationId },
        datetime,
        levels,
        source: "igra2",
        hasGPS: false,
    };
}

// ─── UWYO TEXT:LIST Parser ───────────────────────────────────────────────

/**
 * Extract text from <pre> tags in HTML.
 */
function extractPreContent(html) {
    // Handle both raw text (no HTML) and HTML-wrapped content
    if (!html.includes('<pre>') && !html.includes('<PRE>')) {
        return html; // Already plain text
    }
    const matches = [];
    const regex = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
        matches.push(m[1]);
    }
    return matches.join('\n');
}

/**
 * Parse UWYO TEXT:LIST format.
 *
 * The data table has columns:
 *   PRES  HGHT  TEMP  DWPT  RELH  MIXR  DRCT  SPED  THTA  THTE  THTV
 *   hPa   m     C     C     %     g/kg  deg   m/s (or knots if SKNT)
 *
 * Station metadata appears at the bottom:
 *   Station latitude: 40.78
 *   Station longitude: -111.97
 *   Station elevation: 1288.0
 *   Station number: 72572
 *
 * @param {string} html - Raw HTML or plain text from UWYO
 * @returns {SondeData|null}
 */
export function parseUWYOList(html) {
    const text = extractPreContent(html);
    const lines = text.split('\n');

    // Find the header row and parse column positions
    let headerIdx = -1;
    let columns = null;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('PRES') && trimmed.includes('HGHT') && trimmed.includes('TEMP')) {
            headerIdx = i;
            columns = trimmed.split(/\s+/);
            break;
        }
    }
    if (headerIdx < 0 || !columns) return null;

    // Detect wind speed column: SPED (m/s) or SKNT (knots)
    const windSpeedCol = columns.indexOf('SPED') >= 0 ? 'SPED' : 'SKNT';
    const isKnots = windSpeedCol === 'SKNT';

    // Column indices
    const colIdx = {};
    columns.forEach((c, i) => colIdx[c] = i);

    // Parse data rows (skip header + units line + dashes line)
    const levels = [];
    let dataStarted = false;
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // Skip units line (contains 'hPa')
        if (trimmed.includes('hPa') && trimmed.includes('m') && trimmed.includes('C')) continue;
        // Skip separator lines
        if (trimmed.startsWith('---') || trimmed === '') {
            if (dataStarted) break; // End of data section
            continue;
        }

        // Try to parse as data row
        const parts = trimmed.split(/\s+/);
        if (parts.length < 7) {
            if (dataStarted) break;
            continue;
        }

        const pres = parseFloat(parts[colIdx['PRES']]);
        if (isNaN(pres)) {
            if (dataStarted) break;
            continue;
        }
        dataStarted = true;

        const hght = colIdx['HGHT'] !== undefined ? parseFloat(parts[colIdx['HGHT']]) : NaN;
        const temp = colIdx['TEMP'] !== undefined ? parseFloat(parts[colIdx['TEMP']]) : NaN;
        const dwpt = colIdx['DWPT'] !== undefined ? parseFloat(parts[colIdx['DWPT']]) : NaN;
        const relh = colIdx['RELH'] !== undefined ? parseFloat(parts[colIdx['RELH']]) : NaN;
        const drct = colIdx['DRCT'] !== undefined ? parseFloat(parts[colIdx['DRCT']]) : NaN;
        let sped = colIdx[windSpeedCol] !== undefined ? parseFloat(parts[colIdx[windSpeedCol]]) : NaN;

        // Convert knots to m/s if needed
        if (isKnots && !isNaN(sped)) sped *= 0.514444;

        levels.push({
            time_s: null,  // UWYO LIST doesn't provide elapsed time
            pressure: isNaN(pres) ? null : pres,
            height: isNaN(hght) ? null : hght,
            temp: isNaN(temp) ? null : temp,
            rh: isNaN(relh) ? null : relh,
            dewpoint: isNaN(dwpt) ? null : dwpt,
            windDir: isNaN(drct) ? null : drct,
            windSpeed: isNaN(sped) ? null : sped,
            lat: null,
            lon: null,
        });
    }

    // Parse station metadata. Two page generations:
    //   legacy cgi-bin (REMOVED by UWYO July 2026): footer block
    //     "Station latitude: 40.78 / Station longitude: -111.97 / ..."
    //   WSGI: header block
    //     <H1>Observations for Station 72293 at 12 UTC 15 Jul 2026</H1>
    //     <H3>SAN DIEGO/MIRAMAR,  NAS, CA., USA</H3>
    //     <I>Latitude: 32.845 Longitude: -117.124</I>
    // Try legacy first, fall back to the WSGI shapes. Without these, the WSGI
    // page parsed to station (0,0) and observation time "now" — which put the
    // sonde track on the equator and misdated its profile.
    let stationLat = 0, stationLon = 0, stationElev = 0, stationId = '', stationName = '';
    const fullText = html; // search in original HTML for metadata
    const latMatch = fullText.match(/Station latitude:\s*([-\d.]+)/i)
        || fullText.match(/\bLatitude:\s*([-\d.]+)/i);
    const lonMatch = fullText.match(/Station longitude:\s*([-\d.]+)/i)
        || fullText.match(/\bLongitude:\s*([-\d.]+)/i);
    const elevMatch = fullText.match(/Station elevation:\s*([-\d.]+)/i);
    const numMatch = fullText.match(/Station number:\s*(\d+)/i)
        || fullText.match(/Observations for Station\s+(\d+)/i);
    const nameMatch = fullText.match(/<H3>\s*([^<]+?)\s*<\/H3>/i);

    if (latMatch) stationLat = parseSingleCoordinate(latMatch[1]) ?? 0;
    if (lonMatch) stationLon = parseSingleCoordinate(lonMatch[1]) ?? 0;
    if (elevMatch) stationElev = parseFloat(elevMatch[1]);
    if (numMatch) stationId = numMatch[1];
    if (nameMatch) stationName = nameMatch[1].replace(/\s+/g, ' ').trim();

    // Try to extract observation time from the HTML
    //   legacy: "Observations from the ... at 12Z 01 Jan 2024"
    //   WSGI:   "Observations for Station 72293 at 12 UTC 15 Jul 2026"
    let datetime = new Date();
    const timeMatch = fullText.match(/(\d{2})Z\s+(\d{1,2})\s+(\w{3})\s+(\d{4})/)
        || fullText.match(/at\s+(\d{1,2})\s*UTC\s+(\d{1,2})\s+(\w{3})\s+(\d{4})/i);
    if (timeMatch) {
        const hourStr = timeMatch[1];
        const dayStr = timeMatch[2];
        const monStr = timeMatch[3];
        const yearStr = timeMatch[4];
        const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
        const mon = months[monStr];
        if (mon !== undefined) {
            datetime = new Date(Date.UTC(parseInt(yearStr), mon, parseInt(dayStr), parseInt(hourStr), 0, 0));
        }
    }

    // Estimate station elevation from first level height if not provided
    if (stationElev === 0 && levels.length > 0 && levels[0].height != null) {
        stationElev = levels[0].height;
    }

    if (levels.length === 0) return null;

    return {
        station: { lat: stationLat, lon: stationLon, elev: stationElev, id: stationId, name: stationName || stationId },
        datetime,
        levels,
        source: "uwyo-list",
        hasGPS: false,
    };
}

// ─── UWYO TEXT:CSV Parser ────────────────────────────────────────────────

/**
 * Parse UWYO TEXT:CSV format (per-second GPS positions).
 *
 * CSV header (inside HTML <pre> tags):
 *   time,longitude,latitude,pressure_hPa,geopotential height_m,temperature_C,...,wind direction_degree,wind speed_m/s
 *
 * @param {string} html - Raw HTML or plain text containing CSV
 * @returns {SondeData|null}
 */
export function parseUWYOCSV(html) {
    const text = extractPreContent(html);
    const lines = text.split('\n').filter(l => l.trim().length > 0);

    // Find header row
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('time') && lines[i].includes('longitude') && lines[i].includes('latitude')) {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) return null;

    // Parse column names (normalize to lowercase)
    const rawHeaders = lines[headerIdx].split(',').map(h => h.trim().toLowerCase());
    const col = {};
    rawHeaders.forEach((h, i) => col[h] = i);

    // Map flexible column names
    const timeCol = col['time'];
    const lonCol  = col['longitude'];
    const latCol  = col['latitude'];
    const presCol = col['pressure_hpa'] ?? col['pressure'];
    const hghtCol = col['geopotential height_m'] ?? col['geopotential_height_m'] ?? col['height_m'] ?? col['height'];
    const tempCol = col['temperature_c'] ?? col['temperature'] ?? col['temp_c'];
    const rhCol   = col['relative humidity_%'] ?? col['rh_%'] ?? col['rh'];
    const wdirCol = col['wind direction_degree'] ?? col['wind_direction_degree'] ?? col['wdir'];
    const wspdCol = col['wind speed_m/s'] ?? col['wind_speed_m/s'] ?? col['wspd'];
    const dewCol  = col['dewpoint_c'] ?? col['dewpoint'];

    if (timeCol === undefined || lonCol === undefined || latCol === undefined) return null;

    // Parse data rows
    const levels = [];
    let firstTime = null;
    let stationLat = null, stationLon = null;

    for (let i = headerIdx + 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        if (parts.length < rawHeaders.length) continue;

        const timeStr = parts[timeCol];
        const lon = parseFloat(parts[lonCol]);
        const lat = parseFloat(parts[latCol]);
        if (isNaN(lon) || isNaN(lat)) continue;

        // Parse timestamp
        const timestamp = new Date(timeStr + 'Z'); // Assume UTC
        if (isNaN(timestamp.getTime())) continue;

        if (firstTime === null) {
            firstTime = timestamp;
            stationLat = lat;
            stationLon = lon;
        }

        const time_s = (timestamp.getTime() - firstTime.getTime()) / 1000;

        const pressure  = presCol !== undefined ? parseFloat(parts[presCol]) : NaN;
        const height    = hghtCol !== undefined ? parseFloat(parts[hghtCol]) : NaN;
        const temp      = tempCol !== undefined ? parseFloat(parts[tempCol]) : NaN;
        const rh        = rhCol !== undefined ? parseFloat(parts[rhCol]) : NaN;
        const windDir   = wdirCol !== undefined ? parseFloat(parts[wdirCol]) : NaN;
        const windSpeed = wspdCol !== undefined ? parseFloat(parts[wspdCol]) : NaN;
        const dewpoint  = dewCol !== undefined ? parseFloat(parts[dewCol]) : NaN;

        levels.push({
            time_s,
            pressure:  isNaN(pressure) ? null : pressure,
            height:    isNaN(height) ? null : height,
            temp:      isNaN(temp) ? null : temp,
            rh:        isNaN(rh) ? null : rh,
            dewpoint:  isNaN(dewpoint) ? null : dewpoint,
            windDir:   isNaN(windDir) ? null : windDir,
            windSpeed: isNaN(windSpeed) ? null : windSpeed,
            lat,
            lon,
        });
    }

    if (levels.length === 0 || !firstTime) return null;

    return {
        station: {
            lat: stationLat,
            lon: stationLon,
            elev: (levels[0].height != null) ? levels[0].height : 0,
            id: '',
            name: '',
        },
        datetime: firstTime,
        levels,
        source: "uwyo-csv",
        hasGPS: true,
    };
}
