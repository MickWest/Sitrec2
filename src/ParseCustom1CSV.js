// take a csv file, which is a 2d array [row][col]
// the header row indicated wih
import {findColumn, parseISODate} from "./ParseUtils";
import {MISB, MISBFields} from "./MISBUtils";
import {GlobalDateTimeNode, Sit} from "./Globals";
import {showError} from "./showError";
import {f2m} from "./utils";
import {parseMGRS} from "./CoordinateParser";
import {ecefToLLA, extendECEFTelemetryWithOrbit} from "./ParseFlightClubJSON";

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;

function llaToECEF(latDeg, lonDeg, altMeters) {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

    return [
        (N + altMeters) * cosLat * cosLon,
        (N + altMeters) * cosLat * sinLon,
        (N * (1 - WGS84_E2) + altMeters) * sinLat,
    ];
}

function median(values) {
    if (!values.length) {
        return null;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function inferTimeScaleToSeconds(rawTimes) {
    if (!rawTimes.length) {
        return 1e-3;
    }

    const base = Math.abs(rawTimes[0]);
    if (base > 1e14) {
        return 1e-6;
    }
    if (base > 1e11) {
        return 1e-3;
    }
    if (base > 1e9) {
        return 1;
    }

    const deltas = [];
    for (let i = 1; i < rawTimes.length; i++) {
        const dt = rawTimes[i] - rawTimes[i - 1];
        if (Number.isFinite(dt) && dt > 0) {
            deltas.push(dt);
        }
    }
    const dtMedian = median(deltas);
    if (!Number.isFinite(dtMedian)) {
        return 1e-3;
    }
    if (dtMedian > 100000) {
        return 1e-6;
    }
    if (dtMedian > 100) {
        return 1e-3;
    }
    return 1;
}

function extendOrbitalMISBTrack(misbArray) {
    if (!Array.isArray(misbArray) || misbArray.length < 3) {
        return 0;
    }

    const uniqueTrackIDs = new Set();
    for (const row of misbArray) {
        const trackID = row[MISB.TrackID];
        if (trackID !== null && trackID !== undefined && trackID !== "") {
            uniqueTrackIDs.add(trackID);
        }
    }
    // Avoid extending mixed multi-track files here; those are split downstream.
    if (uniqueTrackIDs.size > 1) {
        return 0;
    }

    const rawTimes = [];
    const parsedRows = [];
    for (const row of misbArray) {
        const rawTime = Number(row[MISB.UnixTimeStamp]);
        const lat = Number(row[MISB.SensorLatitude]);
        const lon = Number(row[MISB.SensorLongitude]);
        const alt = Number(row[MISB.SensorTrueAltitude]);
        if (!Number.isFinite(rawTime) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) {
            continue;
        }
        parsedRows.push({rawTime, lat, lon, alt});
        rawTimes.push(rawTime);
    }

    if (parsedRows.length < 3) {
        return 0;
    }

    const timeScaleToSeconds = inferTimeScaleToSeconds(rawTimes);
    if (!Number.isFinite(timeScaleToSeconds) || timeScaleToSeconds <= 0) {
        return 0;
    }

    const baseRawTime = parsedRows[0].rawTime;
    const telemetry = parsedRows.map((row) => ({
        t: (row.rawTime - baseRawTime) * timeScaleToSeconds,
        x_NI: llaToECEF(row.lat, row.lon, row.alt),
    }));

    const extendedTelemetry = extendECEFTelemetryWithOrbit(telemetry, 2);
    if (extendedTelemetry.length <= telemetry.length) {
        return 0;
    }

    const singleTrackID = uniqueTrackIDs.size === 1 ? Array.from(uniqueTrackIDs)[0] : null;
    const added = extendedTelemetry.length - telemetry.length;

    for (let i = telemetry.length; i < extendedTelemetry.length; i++) {
        const point = extendedTelemetry[i];
        const [x, y, z] = point.x_NI;
        const lla = ecefToLLA(x, y, z);

        const newRow = new Array(MISBFields).fill(null);
        newRow[MISB.UnixTimeStamp] = baseRawTime + point.t / timeScaleToSeconds;
        newRow[MISB.SensorLatitude] = lla.lat;
        newRow[MISB.SensorLongitude] = lla.lon;
        newRow[MISB.SensorTrueAltitude] = lla.alt;
        if (singleTrackID !== null) {
            newRow[MISB.TrackID] = singleTrackID;
        }
        misbArray.push(newRow);
    }

    return added;
}

// Parse a numeric string that may contain commas as thousands separators (e.g. "12,520" → 12520)
function parseNumericWithCommas(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value === 'number') return value;
    return Number(value.replace(/,/g, ''));
}

function parseNullableNumber(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    const trimmed = String(value).trim();
    if (trimmed === "") return NaN;
    return Number(trimmed);
}

function normalizeGridValue(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim().replace(/\s+/g, "").toUpperCase();
}

function isLikelyMaidenhead(grid) {
    return /^[A-R]{2}\d{2}([A-X]{2})?$/.test(grid);
}

function maidenheadToLatLon(grid) {
    const normalized = normalizeGridValue(grid);
    if (!/^[A-R]{2}\d{2}([A-X]{2})?$/.test(normalized)) {
        return null;
    }

    let lon = (normalized.charCodeAt(0) - 65) * 20 - 180;
    let lat = (normalized.charCodeAt(1) - 65) * 10 - 90;
    lon += Number(normalized[2]) * 2;
    lat += Number(normalized[3]);

    if (normalized.length >= 6) {
        lon += (normalized.charCodeAt(4) - 65) * (5 / 60);
        lat += (normalized.charCodeAt(5) - 65) * (2.5 / 60);
        lon += 5 / 120;     // center of subsquare
        lat += 2.5 / 120;   // center of subsquare
    } else {
        lon += 1;   // center of 2-degree square
        lat += 0.5; // center of 1-degree square
    }

    return {lat, lon};
}

function parseGridCoordinate(gridValue, regGridValue, grid56Value, row) {
    const grid = normalizeGridValue(gridValue);
    const regGrid = normalizeGridValue(regGridValue);
    const grid56 = normalizeGridValue(grid56Value);

    const mgrsCandidates = [];
    if (grid) {
        mgrsCandidates.push(grid);
    }
    if (regGrid && grid56) {
        mgrsCandidates.push(`${regGrid}${grid56}`);
    }
    if (regGrid) {
        mgrsCandidates.push(regGrid);
    }

    for (const candidate of mgrsCandidates) {
        const coords = parseMGRS(candidate);
        if (coords) {
            return coords;
        }
    }

    const maidenheadCandidates = [];
    if (isLikelyMaidenhead(grid)) {
        maidenheadCandidates.push(grid);
    }
    if (isLikelyMaidenhead(`${regGrid}${grid56}`)) {
        maidenheadCandidates.push(`${regGrid}${grid56}`);
    }
    if (isLikelyMaidenhead(regGrid)) {
        maidenheadCandidates.push(regGrid);
    }

    for (const candidate of maidenheadCandidates) {
        const coords = maidenheadToLatLon(candidate);
        if (coords) {
            return coords;
        }
    }

    if (grid || regGrid || grid56) {
        console.warn(`Invalid grid value at row ${row}: grid='${gridValue}' regGrid='${regGridValue}' grid56='${grid56Value}'`);
    }

    return null;
}

export function isPBAFile(text) {
    return text.startsWith("---Pico Balloon Archive");
}

export function extractPBACSV(text) {
    const separatorIndex = text.indexOf("-----");
    if (separatorIndex === -1) {
        return text;
    }
    const afterSeparator = text.indexOf("\n", separatorIndex);
    if (afterSeparator === -1) {
        return "";
    }
    return text.substring(afterSeparator + 1);
}


// For a custom format we have a list of acceptable column headers
// for the various needed fields
// we need at least time, lat, lon
// if alt is missing or empty fields, then assume on the ground/sea level
// alt is assumed to be in meters unless an "altFeet" column is present
// if we have a trackID, then we group those points as one track (so multiple tracks per CSV file)
// Time can be in ms (Epoch time) or ISO date string
// case is ignored for header matching
const CustomCSVFormats = {
    CUSTOM1: {
        trackID:  ["THRESHERID", "TRACK_ID", "STAGENUMBER"],
        time:     ["DATETIMEUTC", "DATETIME_UTC", "DATE_TIME_UTC", "DATETIME UTC", "UTC", "DATETIME", "DATE_TIME", "TIMESTAMP", "TIME", "DATE", "DTG", "DT", "FRAME"],
        lat:      ["LAT", "LATITUDE", "TPLAT", "LATITUDEDEGS"],
        lon:      ["LON", "LONG", "LONGITUDE", "TPLON", "LONGITUDEDEGS"],
        mgrs:     ["MGRS", "GRID", "GRIDREF", "GRID_REF", "REGGRID"],
        maidenheadRegGrid: ["REGGRID", "REG_GRID"],
        maidenheadGrid56: ["GRID56", "GRID_56"],
        alt:      ["ALTITUDE", "ALT", "ALTITUDE (m)*", "TPHAE", "alt_m"],
        agl:      ["AGL", "ALT (m/agl)"],
        altFeet:  ["ALTITUDE (FT)", "ALT (FT)", "ALTITUDE(FT)", "ALT(FT)"],
        altKm:    ["ALTITUDEKM"],
        aircraft: ["AIRCRAFT", "AIRCRAFTSPECIFICTYPE"],
        callsign: ["CALLSIGN", "TAILNUMBER", "BALLOON_CALLSIGN"],
        az:       ["AZIMUTH", "AZ", "AZIMUTHDEGS"],
    }
}


export function isCustom1(csv) {
    // CUSTOM1 is one of several custom track format exported from some database
    // at a minimum it has time, lat, lon (or MGRS as alternative to lat/lon)
    // optionally it has aircraft and callsign

    // csv[0] is the header row
    const headerValues= CustomCSVFormats.CUSTOM1;
    // we need time and either (lat+lon) or mgrs
    const hasTime = findColumn(csv, headerValues.time, true) !== -1;
    const hasLatLon = findColumn(csv, headerValues.lat, true) !== -1
        && findColumn(csv, headerValues.lon, true) !== -1;
    const hasMGRS = findColumn(csv, headerValues.mgrs, true) !== -1;
    const hasRegGrid = findColumn(csv, headerValues.maidenheadRegGrid, true) !== -1;

    if (hasTime && (hasLatLon || hasMGRS || hasRegGrid)) {
        return true;
    }

    return false;
}

export function parseCustom1CSV(csv) {
    const rows = csv.length;
    let MISBArray = new Array(rows - 1);

    // Possible new formats:
    // thresherId,dtg,lat,lon,alt,tailNumber - Aircraft
    // track_Id,dtg,lat,lon,tailNumber


    const headerValues= CustomCSVFormats.CUSTOM1;
    const trackIDCol =  findColumn(csv, headerValues.trackID, true)
    const dateCol =     findColumn(csv, headerValues.time, true)
    const latCol =      findColumn(csv, headerValues.lat, true)
    const lonCol =      findColumn(csv, headerValues.lon, true)
    const mgrsCol =     findColumn(csv, headerValues.mgrs, true)
    const regGridCol =  findColumn(csv, headerValues.maidenheadRegGrid, true)
    const grid56Col =   findColumn(csv, headerValues.maidenheadGrid56, true)
    const altCol =      findColumn(csv, headerValues.alt, true)
    const altFeet =     findColumn(csv, headerValues.altFeet, true)
    const altKmCol =    findColumn(csv, headerValues.altKm, true)
    const aglCol =      findColumn(csv, headerValues.agl, true)
    const azCol =       findColumn(csv, headerValues.az, true)
    const aircraftCol = findColumn(csv, headerValues.aircraft, true)
    const callsignCol = findColumn(csv, headerValues.callsign, true)

    const useGridCoordinates = (latCol === -1 || lonCol === -1) && (mgrsCol !== -1 || regGridCol !== -1 || grid56Col !== -1);

    const timeColHeader = csv[0][dateCol];
    console.log("Detected Custom1 CSV format with columns: " +
        "trackIDCol=" + trackIDCol + ", " +
    "dateCol=" + dateCol + " (\"" + timeColHeader + "\"), latCol=" + latCol +
        ", lonCol=" + lonCol + ", mgrsCol=" + mgrsCol +
        ", regGridCol=" + regGridCol +
        ", grid56Col=" + grid56Col + (useGridCoordinates ? " (using grid coordinates)" : "") +
        ", altCol=" + altCol +
        ", aglCol=" + aglCol +
        ", altFeet=" + altFeet +
        ", altKmCol=" + altKmCol +
        ", aircraftCol=" + aircraftCol +
        ", callsignCol=" + callsignCol);

    // speed is currently ignored, and is generally derived from the position data
    const speedCol = findColumn(csv, "SPEED_KTS", true)

  //  const startTime = parseISODate(csv[1][dateCol])
  //  console.log("Detected Airdata start time of " + startTime)


    let isNumberTime = false;
    let isRelativeTime = false;
    let isFrameTime = false;

    // Check if the time column header is "FRAME" (case-insensitive)
    const timeHeader = csv[0][dateCol].toUpperCase();
    if (timeHeader === "FRAME") {
        isFrameTime = true;
        isRelativeTime = true;
    }

    const firstDateValue = csv[1][dateCol];
    // is it just a postive number, possible with decimal point?
    const relativeTimeRegex = /^\d+(\.\d+)?$/;
    if (relativeTimeRegex.test(firstDateValue)) {
        isNumberTime = true;

        // detect to see if the time is relative in seconds
        // not perfect, but works for most cases
        // we assume if the first date is less than 1, it's relative time in seconds
        const firstDate = Number(csv[1][dateCol]);
        if (firstDate < 1 && !isFrameTime) {
            isRelativeTime = true;
        }
    }

    for (let i = 1; i < rows; i++) {
        // any empty cell will be null
        MISBArray[i - 1] = new Array(MISBFields).fill(null);

        let date = null;
        // date can either be an ISO date string, or a number (epoch time in µs, ms or seconds)
        // parseISODate assumes Zulu time if no timezone specified
        if (isFrameTime) {
            // frame number - convert to time using fps
            const frame = Number(csv[i][dateCol]);
            const startTime = GlobalDateTimeNode.dateStart.valueOf();
            date = startTime + (frame / Sit.fps * 1000);
        } else if (isNumberTime) {
            // try to parse as a number
            // we don't distinguish the units here, as that's handled by CNodeMISBData::getTime()
            date = Number(csv[i][dateCol]);
            if (isRelativeTime) {
                const startTime = GlobalDateTimeNode.dateStart.valueOf();
                date = startTime + date * 1000;
            }
        }
        else {
            date = parseISODate(csv[i][dateCol]).getTime();

            if (i < 200) {
                console.log(`ISO date string detected, row ${i} time=${csv[i][dateCol]} converted to ${date} ms`);
            }
        }

        // at this point date is in milliseconds or microseconds since epoch
        MISBArray[i - 1][MISB.UnixTimeStamp] = date;

        if (useGridCoordinates) {
            const gridValue = mgrsCol !== -1 ? csv[i][mgrsCol] : "";
            const regGridValue = regGridCol !== -1 ? csv[i][regGridCol] : "";
            const grid56Value = grid56Col !== -1 ? csv[i][grid56Col] : "";
            const coords = parseGridCoordinate(gridValue, regGridValue, grid56Value, i);
            if (coords) {
                MISBArray[i - 1][MISB.SensorLatitude] = coords.lat;
                MISBArray[i - 1][MISB.SensorLongitude] = coords.lon;
            } else {
                MISBArray[i - 1][MISB.SensorLatitude] = NaN;
                MISBArray[i - 1][MISB.SensorLongitude] = NaN;
            }
        } else {
            MISBArray[i - 1][MISB.SensorLatitude] = parseNullableNumber(csv[i][latCol]);
            MISBArray[i - 1][MISB.SensorLongitude] = parseNullableNumber(csv[i][lonCol]);
        }

        if (trackIDCol !== -1) {
            MISBArray[i - 1][MISB.TrackID] = csv[i][trackIDCol];
        }

        // we expect either alt or agl to be present, but not both
        // altitude is in meters, agl is in meters above ground level
        // they are just used in in inverted priority
        // so we use alt if present, otherwise agl
        // and then altFeet takes precedence over both
        // (this is to support some datasets that have alt in feet)
        if (altCol !== -1) {
            const altitude = parseNumericWithCommas(csv[i][altCol]);
            MISBArray[i - 1][MISB.SensorTrueAltitude] = isNaN(altitude) ? null : altitude;
        }

        if (aglCol !== -1) {
            MISBArray[i - 1][MISB.AltitudeAGL] = Number(csv[i][aglCol]);
        }

        // altFeet takes precedence over alt in meters
        if (altFeet !== -1) {
            const altitude = f2m(parseNumericWithCommas(csv[i][altFeet]));
            MISBArray[i - 1][MISB.SensorTrueAltitude] = isNaN(altitude) ? null : altitude;
        }

        // altKm takes precedence over altFeet
        if (altKmCol !== -1) {
            const altitude = Number(csv[i][altKmCol]) * 1000;
            MISBArray[i - 1][MISB.SensorTrueAltitude] = isNaN(altitude) ? null : altitude;
        }

        if (aircraftCol !== -1) {
            MISBArray[i - 1][MISB.PlatformDesignation] = csv[i][aircraftCol]
        }
        if (callsignCol !== -1) {
            MISBArray[i - 1][MISB.PlatformTailNumber] = csv[i][callsignCol]
        }
        if (speedCol !== -1) {
            MISBArray[i - 1][MISB.PlatformTrueAirspeed] = Number(csv[i][speedCol]);
        }

        // NO FOV
        //MISBArray[i - 1][MISB.SensorVerticalFieldofView] = 0

    }

    // Remove rows that have no valid position.
    // These are useless for track display and can trigger asserts downstream.
    const before = MISBArray.length;
    MISBArray = MISBArray.filter(row =>
        Number.isFinite(Number(row[MISB.SensorLatitude]))
        && Number.isFinite(Number(row[MISB.SensorLongitude]))
    );
    if (MISBArray.length < before) {
        console.log(`Filtered out ${before - MISBArray.length} rows with no position data`);
    }

    // Ensure rows are sorted by ascending timestamp (some sources like WSPR are newest-first)
    if (MISBArray.length >= 2) {
        const t0 = Number(MISBArray[0][MISB.UnixTimeStamp]);
        const tN = Number(MISBArray[MISBArray.length - 1][MISB.UnixTimeStamp]);
        if (t0 > tN) {
            MISBArray.sort((a, b) => Number(a[MISB.UnixTimeStamp]) - Number(b[MISB.UnixTimeStamp]));
            console.log("Sorted track data into chronological order");
        }
    }

    const extensionCount = extendOrbitalMISBTrack(MISBArray);
    if (extensionCount > 0) {
        console.log(`Extended orbital CSV track by ${extensionCount} points`);
    }

    // For relative-time tracks, attach metadata so downstream consumers can
    // allow user to override the start time via trackStartTime GUI field
    if (isRelativeTime) {
        MISBArray.isRelativeTime = true;
        MISBArray.parsingBaseTime = GlobalDateTimeNode.dateStart.valueOf();
    }

    // The TPHAE header is explicitly Height Above Ellipsoid (same producer family as
    // STANAG 4676 WGS-84 tracks). Flag the datum so the pipeline skips the MSL->HAE
    // geoid add (see CNodeMISBDataTrack.needsGeoidToHAE). Only applies when TPHAE
    // actually supplied the values — altFeet/altKm columns take precedence and are MSL.
    if (altCol !== -1 && altFeet === -1 && altKmCol === -1
        && csv[0][altCol].trim().toUpperCase() === "TPHAE") {
        MISBArray.altitudeIsHAE = true;
    }

    return MISBArray;

}

export function parseCustomFLLCSV(csv) {


    // get the global start time in MS
    const startTime = GlobalDateTimeNode.dateStart.valueOf()

    const rows = csv.length;
    let MISBArray = new Array(rows - 1);

    const altCol = findColumn(csv, "Alt");

    for (let i = 1; i < rows; i++) {
        MISBArray[i - 1] = new Array(MISBFields).fill(null);

        const frame = Number(csv[i][0]);
        // givena  frame number, we can derive the time from the DateTime object's start time
        const date = startTime + (frame / Sit.fps * 1000);


        MISBArray[i - 1][MISB.UnixTimeStamp] = date;

        MISBArray[i - 1][MISB.SensorLatitude] = Number(csv[i][1])
        MISBArray[i - 1][MISB.SensorLongitude] = Number(csv[i][2])

        if (altCol !== -1) {
            const altitude = f2m(Number(csv[i][altCol]));
            MISBArray[i - 1][MISB.SensorTrueAltitude] = isNaN(altitude) ? null : altitude;
        }

    }

    // FLL format uses frame numbers relative to sitch start time,
    // so always mark as relative time for trackStartTime GUI support
    MISBArray.isRelativeTime = true;
    MISBArray.parsingBaseTime = startTime;

    return MISBArray;
}


// FR24 headers are Timestamp, UTC, Callsign, Position, Altitude, Speed, Direction
export function isFR24CSV(csv) {
    // check the first row for the headers
    const header = csv[0];
    // check in the exact position
    return header[0] === "Timestamp" && header[1] === "UTC" &&
        header[2] === "Callsign" && header[3] === "Position" &&
        header[4] === "Altitude" && header[5] === "Speed" &&
        header[6] === "Direction";
}

export function parseFR24CSV(csv) {
    const rows = csv.length;
    let MISBArray = new Array(rows - 1);

    for (let i = 1; i < rows; i++) {
        MISBArray[i - 1] = new Array(MISBFields).fill(null);

        MISBArray[i - 1][MISB.UnixTimeStamp] = Number(csv[i][0])*1000;

        const postiion = csv[i][3].split(",");
        if (postiion.length !== 2) {
            showError("Invalid position format in FR24 CSV at row " + i);
            continue;
        }
        MISBArray[i - 1][MISB.SensorLatitude] = Number(postiion[0]);
        MISBArray[i - 1][MISB.SensorLongitude] = Number(postiion[1]);

        const altitude = f2m(Number(csv[i][4]));
        MISBArray[i - 1][MISB.SensorTrueAltitude] = isNaN(altitude) ? null : altitude;

        MISBArray[i - 1][MISB.PlatformTailNumber] = csv[i][2]; // Callsign

    }

    return MISBArray;
}
