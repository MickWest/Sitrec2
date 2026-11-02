// SatelliteBrightness.js
//
// Where a satellite is, how much sunlight reaches it and how bright it looks:
// the calculations behind CSatellite's live display, the long-exposure render
// and the timelapse preview's workers. Pure: no Sitrec globals, so a worker can
// import it. The settings that CSatellite holds (models, profile, the earth
// model's radii) are passed in as `settings`, see CSatellite.brightnessSettings.

import {Vector3} from "three";
import * as satellite from "satellite.js";
import {satelliteIllumination} from "../tools/shf/solarIllumination.js";
import {penumbraFade, shadowOcclusion} from "../tools/shf/flarePhysics.js";
import {
    fluxToMagnitude, KUIPER_PHOTOMETRY, satelliteFlux, STARLINK_PER_SATELLITE, starlinkProfileForDesign,
} from "../tools/shf/satellitePhotometry.js";

const RAD2DEG = 180 / Math.PI;

// ECEF position (metres) of a satellite at `date`, on the earth model with
// equatorial radius a and polar radius b. Null for a failed propagation and for
// heights that cannot be a working orbit: under 100 km (in the atmosphere) or
// over 40,000 km (well past geostationary, so probably an error).
// The geodetic-to-ECEF step is LLAToECEFRadians (LLA-ECEF-ENU.ts) with the radii
// passed in rather than read from Globals.
export function satelliteECEF(satrec, date, a, b, target = new Vector3()) {
    const positionAndVelocity = satellite.propagate(satrec, date);
    if (!positionAndVelocity || !positionAndVelocity.position) return null;
    const gmst = satellite.gstime(date);
    const GD = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
    const altitude = GD.height * 1000;
    if (altitude < 100000 || altitude > 40000000) return null;
    const e2 = (a * a - b * b) / (a * a);
    const ratio = (b * b) / (a * a);
    const sinLat = Math.sin(GD.latitude), cosLat = Math.cos(GD.latitude);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    return target.set(
        (N + altitude) * cosLat * Math.cos(GD.longitude),
        (N + altitude) * cosLat * Math.sin(GD.longitude),
        (ratio * N + altitude) * sinLat,
    );
}

// The sunlit fraction (0..1) at `position` with the Sun in direction `toSun`.
export function satelliteSunlitFraction(position, toSun, settings) {
    const a = settings.equatorRadius, b = settings.polarRadius;
    if (settings.illuminationModel === "Legacy fade") {
        return penumbraFade(shadowOcclusion(position, toSun, a, b), settings.penumbraDepth);
    }
    return satelliteIllumination(position, toSun,
        {equatorRadius: a, polarRadius: b, atmosphere: settings.illuminationModel !== "Finite Sun"});
}

// Mean projected area, in square metres, for an object without a GCAT size, from
// the Space-Track radar size class: SMALL is under 0.1 m², MEDIUM 0.1 to 1 m²,
// LARGE over 1 m². Each value is near the geometric middle of its class (taking
// 0.01 and 10 m² as the outer ends). Radar cross-section is only a rough guide
// to the optical area, so these are estimates.
export const RCS_SIZE_AREA_M2 = Object.freeze({SMALL: 0.03, MEDIUM: 0.3, LARGE: 3});

// The photometric class of a satellite, from its catalog name, number and size,
// as options for satelliteFlux. Any other satellite gets the generic diffuse
// estimate, from its mean projected area: satData.areaM2 (GCAT, set by
// SatelliteSizes.js), else its radar size class, else 1 m².
function photometryClass(satData, settings) {
    const name = satData.name ?? "";
    if (/STARLINK/i.test(name)) {
        const profile = settings.starlinkProfile === STARLINK_PER_SATELLITE
            ? starlinkProfileForDesign(satData.starlinkDesign) : settings.starlinkProfile;
        return {starlink: true, profile};
    }
    if (/KUIPER/i.test(name)) {
        return {flareProfile: KUIPER_PHOTOMETRY.flareProfile,
            diffuseMagnitudeAt90Deg: KUIPER_PHOTOMETRY.diffuseMagnitudeAt90Deg};
    }
    // Retain the previous ISS magnitude as an explicit estimated
    // 1000-km/90-degree reference, now with range and phase dependence.
    // GCAT sizes only the first module, so its area would be far too small.
    if (satData.number === 25544) return {diffuseMagnitudeAt90Deg: -2};
    const area = satData.areaM2 ?? RCS_SIZE_AREA_M2[satData.rcsSize];
    return area > 0 ? {diffuseAreaM2: area} : {};
}

// The magnitude of a fully lit satellite at 1000 km and 90 degrees phase, away
// from any flare: the "standard magnitude" that satellite catalogs list.
export function standardMagnitude(satData, settings) {
    return fluxToMagnitude(satelliteFlux({rangeM: 1e6, phaseAngleRad: Math.PI / 2,
        ...photometryClass(satData, settings)}));
}

// Flux, magnitude and the angles behind them, for a satellite at `position`
// seen from `observer`. `satData` needs name and number, and uses areaM2, rcsSize
// and starlinkDesign when it has them. The reflecting surface faces the
// zenith: geocentric (from the Earth's centre) or geodetic (the
// ellipsoid normal, as SphericalMath.getLocalUpVector).
export function satelliteAppearance(satData, position, observer, toSun, illumination, settings) {
    const dx = position.x - observer.x, dy = position.y - observer.y, dz = position.z - observer.z;
    const rangeM = Math.hypot(dx, dy, dz);
    if (!(rangeM > 0)) return {flux: 0, magnitude: Infinity, rangeM, glintAngleDeg: 180};
    let nx, ny, nz;
    if (settings.flareModel === "Geocentric Nadir") {
        nx = position.x; ny = position.y; nz = position.z;
    } else {
        const a2 = settings.equatorRadius * settings.equatorRadius;
        const b2 = settings.polarRadius * settings.polarRadius;
        nx = position.x / a2; ny = position.y / a2; nz = position.z / b2;
    }
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    const incidence = (dx * nx + dy * ny + dz * nz) * 2;
    const reflectedSunDot = ((dx - incidence * nx) * toSun.x +
        (dy - incidence * ny) * toSun.y + (dz - incidence * nz) * toSun.z) / rangeM;
    const glintAngleDeg = RAD2DEG * Math.acos(Math.max(-1, Math.min(1, reflectedSunDot)));
    const phaseAngleRad = Math.acos(Math.max(-1, Math.min(1,
        -(dx * toSun.x + dy * toSun.y + dz * toSun.z) / rangeM)));
    illumination ??= satelliteSunlitFraction(position, toSun, settings);
    const flux = satelliteFlux({rangeM, phaseAngleRad, glintAngleDeg, illumination,
        ...photometryClass(satData, settings)});
    return {flux, magnitude: fluxToMagnitude(flux), rangeM, glintAngleDeg, phaseAngleRad, illumination};
}
