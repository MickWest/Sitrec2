// SondeTrajectory.js — Reconstruct balloon trajectory from wind profile or GPS data

const EARTH_RADIUS = 6371000; // meters
const DEFAULT_ASCENT_RATE = 5.0; // m/s, standard for radiosondes (~300 m/min)
const SURFACE_PRESSURE_HPA = 1013.25;

/**
 * Estimate geopotential height from pressure using the hypsometric formula
 * (standard atmosphere approximation).
 * @param {number} pressure_hPa
 * @returns {number} height in meters
 */
export function pressureToHeight(pressure_hPa) {
    return 44330 * (1 - Math.pow(pressure_hPa / SURFACE_PRESSURE_HPA, 0.1903));
}

/**
 * Compute the circular (angular) mean of two angles in degrees.
 * Handles the 0°/360° wrap-around correctly.
 * @param {number} a - first angle in degrees
 * @param {number} b - second angle in degrees
 * @returns {number} mean angle in degrees [0, 360)
 */
export function circularMean(a, b) {
    const ar = a * Math.PI / 180;
    const br = b * Math.PI / 180;
    const sinSum = Math.sin(ar) + Math.sin(br);
    const cosSum = Math.cos(ar) + Math.cos(br);
    let mean = Math.atan2(sinSum, cosSum) * 180 / Math.PI;
    if (mean < 0) mean += 360;
    if (mean >= 360) mean -= 360;
    return mean;
}

/**
 * Compute a destination point given a start point, bearing, and distance.
 * Uses great-circle (Vincenty) formula on a sphere.
 *
 * @param {number} lat - start latitude (degrees)
 * @param {number} lon - start longitude (degrees)
 * @param {number} bearing - bearing in degrees (0=N, 90=E)
 * @param {number} distance - distance in meters
 * @returns {{lat: number, lon: number}}
 */
export function greatCircleDestination(lat, lon, bearing, distance) {
    const d = distance / EARTH_RADIUS;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;
    const brng = bearing * Math.PI / 180;

    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const sinD = Math.sin(d);
    const cosD = Math.cos(d);

    const lat2 = Math.asin(sinLat1 * cosD + cosLat1 * sinD * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(
        Math.sin(brng) * sinD * cosLat1,
        cosD - sinLat1 * Math.sin(lat2)
    );

    return {
        lat: lat2 * 180 / Math.PI,
        lon: ((lon2 * 180 / Math.PI) + 540) % 360 - 180, // Normalize to [-180, 180]
    };
}

/**
 * The whole frame whose data row a display reads at playback frame f. Playback can sit between video frames
 * (f = 126.5), but a track's rows exist only at whole frames, and the frame can run past the end of a short track.
 *
 * @param {number} f - playback frame, possibly fractional
 * @param {number} frames - number of rows in the track
 * @returns {number} a valid row index, or -1 for an empty track
 */
export function sondeRowFrame(f, frames) {
    if (!(frames > 0)) return -1;
    return Math.max(0, Math.min(frames - 1, Math.floor(Number.isFinite(f) ? f : 0)));
}

/**
 * Estimate balloon radius at a given pressure, modeling ideal gas expansion.
 *
 * A weather balloon expands as it ascends due to decreasing atmospheric pressure.
 * Volume ∝ 1/P (ideal gas at constant temperature approximation),
 * so radius ∝ (P₀/P)^(1/3).
 *
 * Typical values:
 *   - Launch: ~1.5m diameter (0.75m radius) at ~1013 hPa
 *   - Burst:  ~6-8m diameter (3-4m radius) at ~5-10 hPa (~30km altitude)
 *
 * @param {number} baseDiameter - diameter at surface pressure (meters)
 * @param {number} pressure_hPa - current pressure (hPa)
 * @param {number} surfacePressure_hPa - surface pressure (hPa), default 1013.25
 * @returns {number} estimated diameter at this pressure
 */
export function balloonDiameter(baseDiameter, pressure_hPa, surfacePressure_hPa = SURFACE_PRESSURE_HPA) {
    if (pressure_hPa <= 0 || surfacePressure_hPa <= 0) return baseDiameter;
    return baseDiameter * Math.pow(surfacePressure_hPa / pressure_hPa, 1 / 3);
}

/**
 * Reconstruct balloon trajectory from sonde data.
 *
 * If GPS positions are available (UWYO CSV), uses them directly.
 * Otherwise, integrates wind vectors from the station position upward:
 *   1. For each consecutive level pair, compute the time interval
 *   2. Average the wind speed/direction (circular mean for direction)
 *   3. Compute horizontal displacement (wind × time)
 *   4. Apply displacement using great-circle formula
 *
 * Wind direction is meteorological: direction wind blows FROM.
 * Balloon drifts in the opposite direction: bearing = (windDir + 180) % 360.
 *
 * @param {import('./ParseSonde').SondeData} sondeData
 * @returns {Array<{time: number, lat: number, lon: number, alt: number,
 *                   pressure: number|null, temp: number|null,
 *                   windDir: number|null, windSpeed: number|null}>}
 */
export function reconstructTrajectory(sondeData) {
    if (!sondeData || !sondeData.levels || sondeData.levels.length === 0) return [];

    const levels = sondeData.levels;
    const launchEpoch = sondeData.datetime.getTime();

    // If GPS positions available, use them directly
    if (sondeData.hasGPS) {
        return levels
            .filter(l => l.lat != null && l.lon != null)
            .map(l => ({
                time: launchEpoch + (l.time_s != null ? l.time_s * 1000 : 0),
                lat: l.lat,
                lon: l.lon,
                alt: l.height != null ? l.height : (l.pressure != null ? pressureToHeight(l.pressure) : 0),
                pressure: l.pressure,
                temp: l.temp,
                windDir: l.windDir,
                windSpeed: l.windSpeed,
            }));
    }

    // Wind-integration trajectory reconstruction
    const positions = [];
    let currentLat = sondeData.station.lat;
    let currentLon = sondeData.station.lon;

    // Ensure all levels have a height (estimate from pressure if needed)
    const enrichedLevels = levels.map(l => ({
        ...l,
        height: l.height != null ? l.height : (l.pressure != null ? pressureToHeight(l.pressure) : null),
    }));

    // Filter levels with height and sort ascending
    const validLevels = enrichedLevels.filter(l => l.height != null);
    validLevels.sort((a, b) => a.height - b.height);

    if (validLevels.length === 0) return [];

    // Track cumulative time for levels without ETIME
    let cumulativeTime_s = validLevels[0].time_s != null ? validLevels[0].time_s : 0;

    // First level: at station position
    positions.push({
        time: launchEpoch + cumulativeTime_s * 1000,
        lat: currentLat,
        lon: currentLon,
        alt: validLevels[0].height,
        pressure: validLevels[0].pressure,
        temp: validLevels[0].temp,
        windDir: validLevels[0].windDir,
        windSpeed: validLevels[0].windSpeed,
    });

    for (let i = 1; i < validLevels.length; i++) {
        const prev = validLevels[i - 1];
        const curr = validLevels[i];

        // Time interval
        let dt;
        if (curr.time_s != null && prev.time_s != null) {
            dt = curr.time_s - prev.time_s;
        } else {
            // Estimate from altitude difference using standard ascent rate
            dt = (curr.height - prev.height) / DEFAULT_ASCENT_RATE;
        }

        if (dt <= 0) {
            // Still record position (duplicate/descending level), just don't move
            cumulativeTime_s += Math.abs(dt) || 0;
            positions.push({
                time: launchEpoch + cumulativeTime_s * 1000,
                lat: currentLat,
                lon: currentLon,
                alt: curr.height,
                pressure: curr.pressure,
                temp: curr.temp,
                windDir: curr.windDir,
                windSpeed: curr.windSpeed,
            });
            continue;
        }

        cumulativeTime_s = curr.time_s != null ? curr.time_s : cumulativeTime_s + dt;

        // Average wind between levels
        const prevHasWind = prev.windDir != null && prev.windSpeed != null;
        const currHasWind = curr.windDir != null && curr.windSpeed != null;

        if (prevHasWind || currHasWind) {
            let avgSpeed, avgDir;
            if (prevHasWind && currHasWind) {
                avgSpeed = (prev.windSpeed + curr.windSpeed) / 2;
                avgDir = circularMean(prev.windDir, curr.windDir);
            } else if (currHasWind) {
                avgSpeed = curr.windSpeed;
                avgDir = curr.windDir;
            } else {
                avgSpeed = prev.windSpeed;
                avgDir = prev.windDir;
            }

            if (avgSpeed > 0) {
                // Balloon moves opposite to wind-from direction
                const balloonBearing = (avgDir + 180) % 360;
                const displacement_m = avgSpeed * dt;

                const dest = greatCircleDestination(currentLat, currentLon, balloonBearing, displacement_m);
                currentLat = dest.lat;
                currentLon = dest.lon;
            }
        }

        positions.push({
            time: launchEpoch + cumulativeTime_s * 1000,
            lat: currentLat,
            lon: currentLon,
            alt: curr.height,
            pressure: curr.pressure,
            temp: curr.temp,
            windDir: curr.windDir,
            windSpeed: curr.windSpeed,
        });
    }

    return positions;
}
