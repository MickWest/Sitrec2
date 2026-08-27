/**
 * CTrackFileADSBTrace — readsb/tar1090 "trace" JSON (adsb.lol, ADS-B Exchange).
 *
 * These files hold roughly the last 24 hours of positions for one aircraft,
 * keyed by its ICAO 24-bit hex address, e.g.
 *   https://adsb.lol/data/traces/45/trace_full_a1b245.json
 * (the directory is the LAST two hex digits). They can arrive by drag-drop,
 * by URL drop, or through the "Import ADS-B Track..." menu action
 * (src/ADSBTraceFetch.js + sitrecServer/proxyADSBTrace.php).
 *
 * File shape (readsb README-json.md):
 *   {
 *     icao: "a1b245",          // lowercase hex address
 *     r: "N123AB",             // registration (optional)
 *     t: "B738",               // ICAO type code (optional)
 *     desc: "BOEING 737-800",  // (optional)
 *     timestamp: 1724650000.0, // base epoch SECONDS
 *     trace: [ [secondsAfterTimestamp, lat, lon,
 *               alt_ft | "ground" | null,   // [3] barometric ft (see flags)
 *               gs_kt, track_deg, flags, vert_rate_fpm,
 *               aircraftObj | null,         // [8] full state incl. `flight`
 *               source, alt_geom_ft, ...],  // [10] geometric (WGS84) ft
 *              ... ]
 *   }
 *
 * flags is a bitfield: 1 = position stale, 2 = new leg, 4 = vertical rate is
 * geometric, 8 = the altitude in field [3] is GEOMETRIC, not barometric.
 *
 * Altitude datum: geometric altitude is height above the WGS84 ellipsoid
 * (HAE), so when the trace carries good geometric coverage we use it and
 * report isAltitudeHAE() = true (the MISB pipeline then skips the geoid add).
 * Otherwise we fall back to barometric feet treated as MSL — the same
 * convention as the FR24 CSV importer. Points without the chosen datum
 * (e.g. "ground" rows) carry the nearest known altitude forward/backward,
 * never a mixed-datum substitute.
 *
 * Data license note: adsb.lol trace data is ODbL — fetch and display with
 * attribution ("adsb.lol"), do not bundle it in the repo.
 */

import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";
import {f2m} from "../utils";

// readsb trace-array field indices
const TRACE_TIME = 0;
const TRACE_LAT = 1;
const TRACE_LON = 2;
const TRACE_ALT = 3;        // barometric ft, or "ground", or null (see FLAG_ALT_GEOMETRIC)
const TRACE_TRACK = 5;      // course over ground, degrees
const TRACE_FLAGS = 6;
const TRACE_AIRCRAFT = 8;   // occasional full aircraft object (has `flight`)
const TRACE_GEOM_ALT = 10;  // geometric (WGS84 ellipsoid) altitude, ft

const FLAG_ALT_GEOMETRIC = 8;

export class CTrackFileADSBTrace extends CTrackFile {

    // Tight on purpose: detectTrackFile() asserts when two handlers claim a
    // file, and generic JSON drops (saved sitches, GeoJSON, MISB arrays) must
    // fall through to their own handlers.
    static canHandle(filename, data) {
        return !!(data
            && typeof data === "object"
            && !Array.isArray(data)
            && typeof data.icao === "string"
            && Number.isFinite(Number(data.timestamp))
            && Array.isArray(data.trace));
    }

    // Parse once and cache: valid points with both altitude datums kept
    // separate, plus the per-track datum decision.
    parseTrace() {
        if (this._parsed !== undefined) return this._parsed;

        const base = Number(this.data.timestamp);
        const points = [];
        let geomCount = 0;
        let baroCount = 0;
        let callsign = null;

        // Strictly-numeric field read. Number(null) is 0 — NOT missing data —
        // so a loose Number() coercion here read every absent altitude as 0 ft
        // and poisoned the datum vote. Only a real, finite number passes.
        const num = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;

        for (const p of this.data.trace) {
            if (!Array.isArray(p)) continue;
            const rel = num(p[TRACE_TIME]);
            const lat = num(p[TRACE_LAT]);
            const lon = num(p[TRACE_LON]);
            if (rel === null || lat === null || lon === null) continue;
            const t = base + rel;

            const flags = num(p[TRACE_FLAGS]) ?? 0;
            const altField = p[TRACE_ALT];
            const geomField = p[TRACE_GEOM_ALT];

            let baroFt = null;
            let geomFt = null;
            if (flags & FLAG_ALT_GEOMETRIC) {
                // field [3] is geometric on this row
                geomFt = num(altField);
            } else {
                baroFt = num(altField);
            }
            if (num(geomField) !== null) geomFt = num(geomField);

            if (geomFt !== null) geomCount++;
            if (baroFt !== null) baroCount++;

            const track = num(p[TRACE_TRACK]);
            const aircraft = p[TRACE_AIRCRAFT];
            if (callsign === null && aircraft && typeof aircraft === "object"
                && typeof aircraft.flight === "string" && aircraft.flight.trim().length) {
                callsign = aircraft.flight.trim();
            }

            points.push({t, lat, lon, baroFt, geomFt, heading: track});
        }

        // Prefer geometric (already HAE) when its coverage is at least
        // comparable to barometric; otherwise barometric-as-MSL (FR24 style).
        const useGeom = geomCount >= 2 && geomCount >= baroCount * 0.8;

        this._parsed = {points, useGeom, callsign};
        return this._parsed;
    }

    doesContainTrack() {
        return this.parseTrace().points.length >= 2;
    }

    toMISB(trackIndex = 0) {
        const {points, useGeom} = this.parseTrace();
        if (points.length < 2) {
            console.warn("CTrackFileADSBTrace: not enough valid trace points");
            return false;
        }

        // Chosen-datum altitude per point, with forward-fill then back-fill
        // for rows that lack it ("ground" rows, sparse geometric coverage).
        // Never substitute the other datum — a mixed-datum track steps by the
        // local geoid undulation at every substitution.
        const altsFt = points.map(p => (useGeom ? p.geomFt : p.baroFt));
        let last = null;
        for (let i = 0; i < altsFt.length; i++) {
            if (altsFt[i] === null) altsFt[i] = last; else last = altsFt[i];
        }
        let next = null;
        for (let i = altsFt.length - 1; i >= 0; i--) {
            if (altsFt[i] === null) altsFt[i] = next; else next = altsFt[i];
        }

        const tailNumber = this.getShortName(trackIndex);
        const misb = [];
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const row = new Array(MISBFields).fill(null);
            row[MISB.UnixTimeStamp] = p.t * 1000; // ms (auto-detected at read time)
            row[MISB.SensorLatitude] = p.lat;
            row[MISB.SensorLongitude] = p.lon;
            row[MISB.SensorTrueAltitude] = f2m(altsFt[i] ?? 0);
            row[MISB.PlatformTailNumber] = tailNumber;
            if (p.heading !== null) row[MISB.PlatformHeadingAngle] = p.heading;
            misb.push(row);
        }
        return misb;
    }

    // Callsign > registration > ICAO hex. All are alphanumeric, so the
    // Track_<shortName> node ids stay well-formed.
    getShortName(trackIndex = 0, trackFileName = "") {
        const {callsign} = this.parseTrace();
        if (callsign) return callsign;
        if (typeof this.data.r === "string" && this.data.r.trim().length) {
            return this.data.r.trim();
        }
        if (typeof this.data.icao === "string" && this.data.icao.trim().length) {
            return this.data.icao.trim().toUpperCase();
        }
        return trackFileName || "ADSB_Trace";
    }

    hasMoreTracks(trackIndex = 0) {
        return false;
    }

    getTrackCount() {
        return 1;
    }

    // One aircraft per file; never a supplementary reference track.
    isSupplementaryTrack(_trackIndex) {
        return false;
    }

    // Geometric altitude is height above the WGS84 ellipsoid, so the MISB
    // pipeline must skip its MSL->HAE geoid add.
    isAltitudeHAE(trackIndex = 0) {
        return this.parseTrace().useGeom;
    }

    extractObjects() {
        // no non-track features in a trace file
    }
}
