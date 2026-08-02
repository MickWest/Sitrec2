// raDec2Celestial takes the ra and dec (in radians) of a celestial point (like a star)
// and returns an x,y,z point on the equatorial celestial sphere of sphereRadius
// in ECEF format, standard celestial coordinates, centered on the center of the Earth
// X axis - To vernal equinox
// Y Axis - right angles to this, in the equatorial plane
// Z Axis - Up through the North pole
// Celestial and scene coordinates are both ECEF.
// See: https://en.wikipedia.org/wiki/Equatorial_coordinate_system#Rectangular_coordinates
import {Matrix4} from "three";
import {V3} from "./threeUtils";
import {ECEFToLLAVD_radii, wgs84} from "./LLA-ECEF-ENU";
import {Sit} from "./Globals";
import * as Astronomy from "astronomy-engine";
import {radians} from "./utils";

export function raDec2Celestial(raRad, decRad, sphereRadius) {
    const x = sphereRadius * Math.cos(decRad) * Math.cos(raRad);
    const y = sphereRadius * Math.cos(decRad) * Math.sin(raRad);
    const z = sphereRadius * Math.sin(decRad);
    const equatorial = V3(x, y, z);
    return equatorial;
}


// http://aa.usno.navy.mil/faq/docs/GAST.php

//  some code
//Greg Miller (gmiller@gregmiller.net) 2021
//Released as public domain
//http://www.celestialprogramming.com/
////////////////////////////////////////////////////////

export function getJulianDate(date) {
    return date / 86400000 + 2440587.5; // convert to Julian Date
}

export function getSiderealTime(date, longitude) {

    const JD = getJulianDate(date)

    const D = JD - 2451545.0; // Days since J2000.0
    let GMST = 280.46061837 + 360.98564736629 * D; // in degrees

    // Add the observer's longitude (in degrees)
    GMST += longitude;

    // Normalize to [0, 360)
    GMST = GMST % 360;

    if (GMST < 0) {
        GMST += 360; // make it positive
    }

    return GMST; // returns in degrees
}

//All input and output angles are in radians, jd is Julian Date in UTC
export function raDecToAltAz(ra, dec, lat, lon, jd_ut) {
    //Meeus 13.5 and 13.6, modified so West longitudes are negative and 0 is North
    const gmst = greenwichMeanSiderealTime(jd_ut);
    let localSiderealTime = (gmst + lon) % (2 * Math.PI);


    let H = (localSiderealTime - ra);
    if (H < 0) {
        H += 2 * Math.PI;
    }
    if (H > Math.PI) {
        H = H - 2 * Math.PI;
    }

    let az = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)));
    let a = (Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)));
    az -= Math.PI;

    if (az < 0) {
        az += 2 * Math.PI;
    }

    const el = a;
    return {az, el};
}

function greenwichMeanSiderealTime(jd) {
    //"Expressions for IAU 2000 precession quantities" N. Capitaine1,P.T.Wallace2, and J. Chapront
    const t = ((jd - 2451545.0)) / 36525.0;

    let gmst = earthRotationAngle(jd) + (0.014506 + 4612.156534 * t + 1.3915817 * t * t - 0.00000044 * t * t * t - 0.000029956 * t * t * t * t - 0.0000000368 * t * t * t * t * t) / 60.0 / 60.0 * Math.PI / 180.0;  //eq 42
    gmst %= 2 * Math.PI;
    if (gmst < 0) gmst += 2 * Math.PI;

    return gmst;
}

function earthRotationAngle(jd) {
    //IERS Technical Note No. 32

    const t = jd - 2451545.0;
    const f = jd % 1.0;

    let theta = 2 * Math.PI * (f + 0.7790572732640 + 0.00273781191135448 * t); //eq 14
    theta %= 2 * Math.PI;
    if (theta < 0) theta += 2 * Math.PI;

    return theta;

}

// Function to calculate Greenwich Sidereal Time (GST)
// This is a simplified example; for more accurate calculations, you may want to use a library
export function calculateGST(date) {
    const julianDate = date / 86400000 + 2440587.5;  // Convert from milliseconds to Julian date
    const T = (julianDate - 2451545.0) / 36525.0;
    let theta = 280.46061837 + 360.98564736629 * (julianDate - 2451545) + T * T * (0.000387933 - T / 38710000);
    theta %= 360;
    return radians(theta);
}

// Function to convert equatorial celestial coordinates in the form of ra and dec to ECEF
// ra and dec in radians.
export function celestialToECEF(ra, dec, dist, gst) {
    // Step 1: Convert to Geocentric Equatorial Coordinates (i.e. ECI)
    const x_geo = dist * Math.cos(dec) * Math.cos(ra);
    const y_geo = dist * Math.cos(dec) * Math.sin(ra);
    const z_geo = dist * Math.sin(dec);

    // Step 2: Convert to ECEF Coordinates
    const x_ecef = x_geo * Math.cos(gst) + y_geo * Math.sin(gst);
    const y_ecef = -x_geo * Math.sin(gst) + y_geo * Math.cos(gst);

    const z_ecef = z_geo;

    return V3(x_ecef, y_ecef, z_ecef);
}

// Shared memo for getCelestialDirection. Within ONE rendered frame this is
// called many times per 3D view — CNodeSunlight.update plus the sky
// colour/opacity/brightness/haze passes and several overlays all ask for the Sun
// (and Moon) direction — and each miss runs Astronomy.Equator, the heaviest
// pure-JS solve in the app. For a fixed (body, instant, observer) the answer is
// constant, so cache it keyed on the body, the exact epoch ms, and the observer
// position quantised to ~1 km (only the Moon/nearby planets are position
// sensitive; the Sun is effectively unaffected). date.getTime() gives automatic
// per-frame invalidation as GlobalDateTimeNode advances. Bounded + cleared when
// it grows, so stale (past-frame) entries can't accumulate. Mirrors the proven
// CNodeLensGhost._sunCache. Values are cloned in/out since callers mutate them.
const _celestialDirCache = new Map();

// get a vector in ECEF coordinates to a celestial body from an ECEF position (like a camera or object)
// - body = (e.g "Sun", "Venus", "Moon", etc)
// - date = date of observation (Date object)
export function getCelestialDirection(body, date, pos) {
    // Astronomy.Equator requires capitalized body names (e.g. "Moon", not "moon")
    const normalizedBody = body.charAt(0).toUpperCase() + body.slice(1).toLowerCase();

    const positioned = (pos !== undefined && pos.lengthSq() > 1e12);
    const t = (date && typeof date.getTime === "function") ? date.getTime() : date;
    const qx = positioned ? Math.round(pos.x / 1000) : 0;
    const qy = positioned ? Math.round(pos.y / 1000) : 0;
    const qz = positioned ? Math.round(pos.z / 1000) : 0;
    const cacheKey = `${normalizedBody}|${t}|${qx}|${qy}|${qz}`;
    const cached = _celestialDirCache.get(cacheKey);
    if (cached !== undefined) return cached ? cached.clone() : null;

    let LLA;
    // if a position is provided, use that to calculate the LLA of the observer
    // realistically this won't make any significant difference for the Sun,
    // the biggest difference will be for the Moon, then nearby planets
    if (pos !== undefined && pos.lengthSq() > 1e12) {
        // Position must be on or above Earth's surface (radius ~6.4e6 m, so lengthSq ~4e13)
        // If too close to origin (e.g. camera not yet positioned), fall back to Sit origin.
        LLA = ECEFToLLAVD_radii(pos);
    } else {
        // default to the local origin, should be fine for the sun.
        LLA = V3(Sit.lat, Sit.lon, 0)
    }

    let observer = new Astronomy.Observer(LLA.x, LLA.y, LLA.z);
    let result = null;
    try {
        const celestialInfo = Astronomy.Equator(normalizedBody, date, observer, false, true);
        const ra = (celestialInfo.ra) / 24 * 2 * Math.PI;   // Right Ascension NOTE, in hours, so 0..24 -> 0..2π
        const dec = radians(celestialInfo.dec); // Declination
        result = getCelestialDirectionFromRaDec(ra, dec, date);
    } catch {
        result = null; // Unknown body name
    }
    // Bound the cache: within a frame it holds at most (bodies × views) entries;
    // clearing when it grows drops last frame's now-unreachable keys.
    if (_celestialDirCache.size > 128) _celestialDirCache.clear();
    _celestialDirCache.set(cacheKey, result);
    return result ? result.clone() : null;
}

export function getCelestialDirectionFromRaDec(ra, dec, date) {
    // ra/dec are EQJ (J2000/ICRS equatorial) — the frame astronomy-engine
    // returns with ofdate=false, and the frame the star catalog is in.
    // getEQJToECEFMatrix is the same transform the celestial sphere is drawn
    // with, so camera pointing and the rendered body stay locked together.
    const dir = raDec2Celestial(ra, dec, 1);
    // ecef for the sun will give us a vector from the center to the earth towards the Sun (which, for our purposes
    // is considered to be infinitely far away
    return dir.applyMatrix4(getEQJToECEFMatrix(date, _eqjMatrixOut)).normalize();
}

// Rotation from EQJ (J2000/ICRS equatorial) to ECEF for a given instant:
//
//     ECEF = Rz(-GAST) · PrecessionNutation(EQJ → EQD)
//
// Both halves are load-bearing. GAST (and GMST) measure Earth's rotation from
// the equinox OF DATE, so pairing either with J2000 coordinates and no
// precession leaves the whole sky rotated against the ground by the precession
// accumulated since 2000 — ~50"/yr, which had reached 22 arcmin by 2026. That
// was a real bug: it put the rendered Moon 0.37° (0.7 lunar diameters) off a
// photograph, and it is why this matrix, not a bare Rz(-GMST), must be used
// everywhere an EQJ direction becomes an Earth-fixed one.
//
// Memoised on the epoch: within a frame this is asked for once per view per
// body, and Rotation_EQJ_EQD runs a full nutation series each time.
let _eqjMatrixMs = null;
const _eqjMatrixCached = new Matrix4();
const _eqjMatrixScratch = new Matrix4();
const _eqjMatrixOut = new Matrix4();

export function getEQJToECEFMatrix(date, target = new Matrix4()) {
    const ms = (date && typeof date.getTime === "function") ? date.getTime() : +date;
    if (_eqjMatrixMs !== ms) {
        const time = Astronomy.MakeTime(date);
        const r = Astronomy.Rotation_EQJ_EQD(time).rot;
        // astronomy-engine stores rot[i][j] as "component i of the source
        // contributes to component j of the target" — the transpose of the
        // row-major order Matrix4.set() expects.
        _eqjMatrixCached.set(
            r[0][0], r[1][0], r[2][0], 0,
            r[0][1], r[1][1], r[2][1], 0,
            r[0][2], r[1][2], r[2][2], 0,
            0, 0, 0, 1,
        );
        // SiderealTime returns GAST in sidereal hours. GAST rather than GMST:
        // the equation of the equinoxes is only ~17" but it is free here.
        const gastRad = radians(15 * Astronomy.SiderealTime(time));
        _eqjMatrixCached.premultiply(_eqjMatrixScratch.makeRotationZ(-gastRad));
        _eqjMatrixMs = ms;
    }
    return target.copy(_eqjMatrixCached);
}

// Inverse of the above. A rotation's inverse is its transpose, so this is
// exact and cheap. Used to express an Earth-fixed direction (the observer's
// zenith, for refraction) in the celestial sphere's own EQJ frame.
export function getECEFToEQJMatrix(date, target = new Matrix4()) {
    return getEQJToECEFMatrix(date, target).transpose();
}

// Annual aberration: the Earth's ~29.8 km/s orbital motion tilts the apparent
// direction of anything genuinely at rest by up to v/c ≈ 20.5". Applies to
// catalog stars ONLY — astronomy-engine already folds aberration into the
// Sun/planet positions it returns (aberration=true), so running this on those
// would double-count it.
//
// Classical first-order form; the relativistic terms are ~0.001".
//
// Deliberately NOT applied to the 3D constellation lines or the equatorial
// grid in CCelestialElements: the grid is a coordinate reference that should
// stay unaberrated, and a 20" offset between a constellation line and its
// stars is far below the width of the line at any field of view those lines
// are drawn at. (The star chart aberrates its own lines because doing so
// there was free.)
let _aberrationMs = null;
const _aberrationVOverC = V3();

function getAberrationVOverC(date) {
    const ms = (date && typeof date.getTime === "function") ? date.getTime() : +date;
    if (_aberrationMs !== ms) {
        const state = Astronomy.BaryState(Astronomy.Body.Earth, Astronomy.MakeTime(date));
        // AU/day → km/s → fraction of c
        const scale = Astronomy.KM_PER_AU / 86400 / 299792.458;
        _aberrationVOverC.set(state.vx * scale, state.vy * scale, state.vz * scale);
        _aberrationMs = ms;
    }
    return _aberrationVOverC;
}

// Length-preserving, so it can be applied to a sphere-radius position as well
// as a unit direction.
export function applyAnnualAberration(dirEQJ, date) {
    const r = dirEQJ.length();
    if (r < 1e-12) return dirEQJ;
    return dirEQJ.divideScalar(r).add(getAberrationVOverC(date)).normalize().multiplyScalar(r);
}

// Catalog star RA/Dec (EQJ radians) → apparent unit direction in ECEF.
// The one call every star-specific consumer should use, so the aberration
// decision is made in exactly one place and can't drift between the CPU paths
// and the star-field shader.
export function getStarDirectionECEF(ra, dec, date) {
    const dir = applyAnnualAberration(raDec2Celestial(ra, dec, 1), date);
    return dir.applyMatrix4(getEQJToECEFMatrix(date, _eqjMatrixOut)).normalize();
}

// GPU counterpart of applyAnnualAberration, for the star-field vertex shader.
// Shared uniform object on the same one-update-per-frame pattern as
// refractionUniforms — the star cloud has ~118k points, so baking aberration
// into the position buffer would mean re-uploading all of them on every time
// change. Applied BEFORE refraction: aberration is an inertial-frame effect on
// the incoming ray, refraction is what the atmosphere then does to it.
export const aberrationUniforms = {
    uAberration: {value: V3(0, 0, 0)},
};

export function updateAberrationUniforms(date) {
    aberrationUniforms.uAberration.value.copy(getAberrationVOverC(date));
}

export const ABERRATION_VERTEX_GLSL = /* glsl */`
uniform vec3 uAberration;

vec3 applyAberration_chunk(vec3 pos) {
    float r = length(pos);
    if (r < 1e-6) return pos;
    return normalize(pos / r + uAberration) * r;
}
`;

// Geocentric body vector in ECEF (meters).
// Uses astronomy-engine's geocentric EQJ vector, rotates to EQD (of-date),
// then rotates by GAST into Earth-fixed coordinates.
export function getGeocentricBodyPositionECEF(body, date, aberration = true) {
    const time = Astronomy.MakeTime(date);
    const bodyId = typeof body === "string" ? Astronomy.Body[body] : body;
    const eqj = Astronomy.GeoVector(bodyId, time, aberration); // AU, EQJ
    const eqd = Astronomy.RotateVector(Astronomy.Rotation_EQJ_EQD(time), eqj); // AU, EQD

    const gastRad = radians(15 * Astronomy.SiderealTime(time));
    const x = eqd.x * Math.cos(gastRad) + eqd.y * Math.sin(gastRad);
    const y = -eqd.x * Math.sin(gastRad) + eqd.y * Math.cos(gastRad);
    const z = eqd.z;

    const scale = Astronomy.KM_PER_AU * 1000; // AU -> meters
    const ecef = V3(x * scale, y * scale, z * scale);
    return ecef;
}

export function getGeocentricBodyDirectionECEF(body, date, aberration = true) {
    return getGeocentricBodyPositionECEF(body, date, aberration).normalize();
}
