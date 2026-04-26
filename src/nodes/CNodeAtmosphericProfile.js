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

export class CNodeAtmosphericProfile extends CNode {
    constructor(v) {
        super(v);
        this.input("dataTrack"); // CNodeMISBDataTrack with MISB data
        this.stationId = v.stationId ?? "";
        this.stationName = v.stationName ?? "";
        // "uwyo" | "igra2" | "manual" — lets the wind field filter by source.
        this.source = v.source ?? "manual";
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

    /**
     * Get interpolated atmospheric data at a given altitude.
     * @param {number} altitude - meters MSL
     * @returns {{alt, temp, pressure, rh, windDir, windSpeed}|null}
     */
    getAtAltitude(altitude) {
        if (this.levels.length === 0) return null;

        // Below lowest level
        if (altitude <= this.levels[0].alt) return { ...this.levels[0] };
        // Above highest level
        if (altitude >= this.levels[this.levels.length - 1].alt) return { ...this.levels[this.levels.length - 1] };

        // Find bracketing levels
        for (var i = 0; i < this.levels.length - 1; i++) {
            var lo = this.levels[i];
            var hi = this.levels[i + 1];
            if (altitude >= lo.alt && altitude <= hi.alt) {
                var t = (altitude - lo.alt) / (hi.alt - lo.alt);
                return {
                    alt: altitude,
                    temp: interpolateNullable(lo.temp, hi.temp, t),
                    pressure: interpolateNullable(lo.pressure, hi.pressure, t),
                    rh: interpolateNullable(lo.rh, hi.rh, t),
                    windDir: interpolateAngle(lo.windDir, hi.windDir, t),
                    windSpeed: interpolateNullable(lo.windSpeed, hi.windSpeed, t),
                };
            }
        }
        return null;
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
                return {
                    alt: lo.alt + t * (hi.alt - lo.alt),
                    temp: interpolateNullable(lo.temp, hi.temp, t),
                    pressure: pressure_hPa,
                    rh: interpolateNullable(lo.rh, hi.rh, t),
                    windDir: interpolateAngle(lo.windDir, hi.windDir, t),
                    windSpeed: interpolateNullable(lo.windSpeed, hi.windSpeed, t),
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

function interpolateAngle(a, b, t) {
    if (a == null) return b;
    if (b == null) return a;
    // Circular interpolation for wind direction (degrees)
    var diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    var result = a + diff * t;
    if (result < 0) result += 360;
    if (result >= 360) result -= 360;
    return result;
}
