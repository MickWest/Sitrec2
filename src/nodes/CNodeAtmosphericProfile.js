// CNodeAtmosphericProfile.js — Atmospheric data lookup from radiosonde sounding.
//
// Stores sonde levels sorted by altitude and provides altitude-interpolated
// atmospheric values: temperature, pressure, humidity, wind direction/speed.
// Created automatically when a sonde track is imported.
//
// Usage:
//   const profile = NodeMan.get("atmosphericProfile_72451_2024-01-01_12Z");
//   const data = profile.getAtAltitude(5000); // → {temp, pressure, rh, windDir, windSpeed}

import {CNode} from "./CNode";
import {MISB} from "../MISBFields";
import {GlobalDateTimeNode, Globals} from "../Globals";
import {normalizeWindTimestampMs} from "./WindHelpers";

export class CNodeAtmosphericProfile extends CNode {
    constructor(v) {
        super(v);
        this.input("dataTrack"); // CNodeMISBDataTrack with MISB data
        this.stationId = v.stationId ?? "";
        this.stationName = v.stationName ?? "";
        // "uwyo" | "igra2" | "manual" — lets the wind field filter by source.
        this.source = v.source ?? "manual";
        // True for a sounding's profile (TrackManager sets it): the track's
        // "Track: <name>" wind source is read by altitude, not by time
        // (see altitudeProfileForSourceKey in WindSources.js).
        this.windByAltitude = v.windByAltitude ?? false;
        // "observation" | "model": what kind of evidence this profile is in the traverse
        // wind comparison (AnalyzeTraverse.windSourceEvidenceClass).
        this.evidenceClass = v.evidenceClass ?? "observation";
        // False for a profile file with no time of its own: it took the sitch
        // start at its import, and it keeps to the sitch start (update()).
        this.timeFromFile = v.timeFromFile ?? true;
        this.stationLat = null;
        this.stationLon = null;
        this.levels = []; // sorted by altitude: [{alt, temp, pressure, rh, windDir, windSpeed}]
        this.buildProfile();
    }

    buildProfile() {
        this.levels = [];
        if (!this.in.dataTrack || !this.in.dataTrack.misb) return;

        var misb = this.in.dataTrack.misb;
        for (var i = 0; i < misb.length; i++) {
            var row = misb[i];
            var alt = row[MISB.SensorTrueAltitude];
            if (alt == null) continue;

            // Capture the first valid lat/lon as the launch/station location.
            // Balloons drift, but wind-field IDW uses the launch site.
            if (this.stationLat == null) {
                const lat = row[MISB.SensorLatitude];
                const lon = row[MISB.SensorLongitude];
                if (lat != null && lon != null) {
                    this.stationLat = lat;
                    this.stationLon = lon;
                }
            }

            this.levels.push({
                idx: i,    // original MISB row, so callers can lookup track position
                alt: alt,
                temp: row[MISB.OutsideAirTemperature] ?? null,
                pressure: row[MISB.StaticPressure] ?? null,
                rh: null, // MISB doesn't have RH field; could extend later
                windDir: row[MISB.WindDirection] ?? null,
                windSpeed: row[MISB.WindSpeed] ?? null,
            });
        }

        // Sort ascending by altitude
        this.levels.sort(function(a, b) { return a.alt - b.alt; });
        // The levels that carry a wind. Wind is interpolated between these
        // only, so a level with no wind (a gap in the file) does not pull the
        // value toward a wind that was never measured there.
        this.windLevels = this.levels.filter(l => l.windDir != null && l.windSpeed != null);
        this.computeTopWindAlt();
    }

    // Highest altitude (m) with a VALID wind sample. Radiosondes measure wind
    // to very different tops — one station may reach ~50k ft, another ~100k ft
    // (and GPS wind-finding often drops out below the balloon's burst altitude
    // while pressure/temp keep reporting). The wind-field blend uses this to
    // drop a station OUT above its top (so it doesn't pollute a high-altitude
    // estimate with a lower-altitude wind); only when EVERY nearby station has
    // been dropped does it hold the highest station's top wind. Null when the
    // profile has no wind at any level.
    computeTopWindAlt() {
        this.topWindAlt = null;
        for (const lvl of this.levels) {
            if (lvl.windDir != null && lvl.windSpeed != null
                && (this.topWindAlt == null || lvl.alt > this.topWindAlt)) {
                this.topWindAlt = lvl.alt;
            }
        }
        return this.topWindAlt;
    }

    // Interpolate the balloon's 3D position (ECEF Vector3) at an altitude.
    // Lerps between the two bracketing sounding levels' actual track positions
    // so the result reflects balloon drift, not just the launch site.
    getPositionAtAltitude(altM) {
        if (!this.in.dataTrack || this.levels.length === 0) return null;
        const dt = this.in.dataTrack;
        if (altM <= this.levels[0].alt) return dt.getPosition(this.levels[0].idx);
        const top = this.levels[this.levels.length - 1];
        if (altM >= top.alt) return dt.getPosition(top.idx);
        for (let i = 0; i < this.levels.length - 1; i++) {
            const lo = this.levels[i];
            const hi = this.levels[i + 1];
            if (altM >= lo.alt && altM <= hi.alt) {
                const t = (altM - lo.alt) / (hi.alt - lo.alt);
                const pLo = dt.getPosition(lo.idx);
                const pHi = dt.getPosition(hi.idx);
                if (!pLo || !pHi) return pLo ?? pHi ?? null;
                return pLo.clone().lerp(pHi, t);
            }
        }
        return null;
    }

    recalculate() {
        this.buildProfile();
    }

    // The launch: the time (epoch ms) of the first row of the track, or null.
    launchTimeMs() {
        const misb = this.in.dataTrack?.misb;
        if (!misb || misb.length === 0) return null;
        const ms = normalizeWindTimestampMs(misb[0]?.[MISB.UnixTimeStamp]);
        return Number.isFinite(ms) ? ms : null;
    }

    // A profile with no time in its file starts at the sitch start. When the
    // start changes (the user sets it, or a saved sitch restores it after the
    // file loaded), move every row of the track by the change, so the drawn
    // ascent starts at the new start (plan phase 3 item 9). Before 2026-11-03
    // it kept the start that was set when the file loaded.
    update(f) {
        super.update(f);
        if (this.timeFromFile !== false || Globals.dontRecalculate) return;
        const start = GlobalDateTimeNode?.frameToDate?.(0)?.valueOf();
        const launch = this.launchTimeMs();
        if (!Number.isFinite(start) || launch == null) return;
        const shiftMs = start - launch;
        if (Math.abs(shiftMs) < 1) return;
        for (const row of this.in.dataTrack.misb) {
            const ms = normalizeWindTimestampMs(row?.[MISB.UnixTimeStamp]);
            if (Number.isFinite(ms)) row[MISB.UnixTimeStamp] = ms + shiftMs;
        }
        this.in.dataTrack.recalculateCascade();
    }

    /**
     * Get interpolated atmospheric data at a given altitude.
     * @param {number} altitude - meters MSL
     * @returns {{alt, temp, pressure, rh, windDir, windSpeed}|null}
     */
    getAtAltitude(altitude) {
        if (this.levels.length === 0) return null;

        let result = null;
        if (altitude <= this.levels[0].alt) {
            // Below lowest level
            result = { ...this.levels[0] };
        } else if (altitude >= this.levels[this.levels.length - 1].alt) {
            // Above highest level
            result = { ...this.levels[this.levels.length - 1] };
        } else {
            // Find bracketing levels
            for (var i = 0; i < this.levels.length - 1; i++) {
                var lo = this.levels[i];
                var hi = this.levels[i + 1];
                if (altitude >= lo.alt && altitude <= hi.alt) {
                    var t = (altitude - lo.alt) / (hi.alt - lo.alt);
                    result = {
                        alt: altitude,
                        temp: interpolateNullable(lo.temp, hi.temp, t),
                        pressure: interpolateNullable(lo.pressure, hi.pressure, t),
                        rh: interpolateNullable(lo.rh, hi.rh, t),
                    };
                    break;
                }
            }
        }
        if (!result) return null;
        const wind = this.windAtAltitude(altitude);
        result.windDir = wind ? wind.windDir : null;
        result.windSpeed = wind ? wind.windSpeed : null;
        return result;
    }

    /**
     * Wind at an altitude, from the levels that carry a wind.
     * Interpolated by components (east and north), the standard method: two
     * opposite winds of the same speed give calm half way, not a full-speed
     * wind at right angles to both (which interpolating the angle gives).
     * Below the lowest and above the highest wind level, that level's wind is
     * held.
     * @param {number} altM - meters MSL
     * @returns {{windDir:number, windSpeed:number}|null} null if no level has wind
     */
    windAtAltitude(altM) {
        // buildProfile() sets windLevels; derive it for a profile whose levels
        // were set some other way, so it never looks as if it had no wind.
        const wl = this.windLevels
            ?? (this.levels ?? []).filter(l => l.windDir != null && l.windSpeed != null);
        if (wl.length === 0) return null;
        if (altM <= wl[0].alt) return {windDir: wl[0].windDir, windSpeed: wl[0].windSpeed};
        const top = wl[wl.length - 1];
        if (altM >= top.alt) return {windDir: top.windDir, windSpeed: top.windSpeed};
        // Binary search for the two levels around altM. The live wind reads a
        // profile once per frame for each user of the wind, and a high-
        // resolution file can have thousands of levels.
        let a = 0, b = wl.length - 1;
        while (b - a > 1) {
            const m = (a + b) >> 1;
            if (wl[m].alt > altM) b = m;
            else a = m;
        }
        const lo = wl[a], hi = wl[b];
        const t = hi.alt > lo.alt ? (altM - lo.alt) / (hi.alt - lo.alt) : 0;
        return interpolateWind(lo, hi, t);
    }

    // Lowest altitude (m) with a valid wind, or null. Below it the wind is held.
    bottomWindAlt() {
        const wl = this.windLevels
            ?? (this.levels ?? []).filter(l => l.windDir != null && l.windSpeed != null);
        return wl.length > 0 ? wl[0].alt : null;
    }

    /**
     * Get interpolated data at a given pressure level.
     * @param {number} pressure_hPa
     * @returns {{alt, temp, pressure, rh, windDir, windSpeed}|null}
     */
    getAtPressure(pressure_hPa) {
        if (this.levels.length === 0) return null;

        // Find levels by pressure (decreasing with altitude)
        var pressureLevels = this.levels.filter(function(l) { return l.pressure != null; });
        if (pressureLevels.length === 0) return null;

        // Pressure decreases with altitude, so search in reverse
        for (var i = 0; i < pressureLevels.length - 1; i++) {
            var lo = pressureLevels[i];
            var hi = pressureLevels[i + 1];
            if (lo.pressure >= pressure_hPa && hi.pressure <= pressure_hPa) {
                var t = (lo.pressure - pressure_hPa) / (lo.pressure - hi.pressure);
                const alt = lo.alt + t * (hi.alt - lo.alt);
                const wind = this.windAtAltitude(alt);
                return {
                    alt,
                    temp: interpolateNullable(lo.temp, hi.temp, t),
                    pressure: pressure_hPa,
                    rh: interpolateNullable(lo.rh, hi.rh, t),
                    windDir: wind ? wind.windDir : null,
                    windSpeed: wind ? wind.windSpeed : null,
                };
            }
        }
        return null;
    }

    /**
     * Get the full temperature profile as an array of {alt, temp} pairs.
     */
    getTemperatureProfile() {
        return this.levels.filter(function(l) { return l.temp != null; }).map(function(l) { return { alt: l.alt, temp: l.temp }; });
    }

    /**
     * Get the full pressure profile as an array of {alt, pressure} pairs.
     */
    getPressureProfile() {
        return this.levels.filter(function(l) { return l.pressure != null; }).map(function(l) { return { alt: l.alt, pressure: l.pressure }; });
    }

    /**
     * Get the full wind profile as an array of {alt, windDir, windSpeed} tuples.
     */
    getWindProfile() {
        return this.levels.filter(function(l) { return l.windDir != null && l.windSpeed != null; }).map(function(l) { return { alt: l.alt, windDir: l.windDir, windSpeed: l.windSpeed }; });
    }

    /**
     * Get altitude range covered by this profile.
     */
    getAltitudeRange() {
        if (this.levels.length === 0) return { min: 0, max: 0 };
        return { min: this.levels[0].alt, max: this.levels[this.levels.length - 1].alt };
    }
}

function interpolateNullable(a, b, t) {
    if (a == null) return b;
    if (b == null) return a;
    return a + (b - a) * t;
}

// Interpolate two winds (FROM direction in degrees, speed) by their components.
// Exported for tests.
export function interpolateWind(lo, hi, t) {
    const DEG = Math.PI / 180;
    const x = (1 - t) * lo.windSpeed * Math.sin(lo.windDir * DEG) + t * hi.windSpeed * Math.sin(hi.windDir * DEG);
    const y = (1 - t) * lo.windSpeed * Math.cos(lo.windDir * DEG) + t * hi.windSpeed * Math.cos(hi.windDir * DEG);
    const windSpeed = Math.hypot(x, y);
    // In a calm the direction has no meaning: keep the nearer level's.
    const windDir = windSpeed > 1e-9
        ? ((Math.atan2(x, y) / DEG) % 360 + 360) % 360
        : (t < 0.5 ? lo.windDir : hi.windDir);
    return {windDir, windSpeed};
}
