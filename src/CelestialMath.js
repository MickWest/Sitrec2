// raDec2Celestial takes the ra and dec (in radians) of a celestial point (like a star)
// and returns an x,y,z point on the equatorial celestial sphere of sphereRadius
// in ECEF format, standard celestial coordinates, centered on the center of the Earth
// X axis - To vernal equinox
// Y Axis - right angles to this, in the equatorial plane
// Z Axis - Up through the North pole
// EUS is now identical to ECEF (identity mapping), so celestial and scene coords are the same.
// See: https://en.wikipedia.org/wiki/Equatorial_coordinate_system#Rectangular_coordinates
import {V3} from "./threeUtils";
import {ECEF2EUS, EUSToLLA, wgs84} from "./LLA-ECEF-ENU";
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

// get a vector in EUS coordinates to a celestial body from a EUS position (like a camera or object)
// - body = (e.g "Sun", "Venus", "Moon", etc)
// - date = date of observation (Date object)
export function getCelestialDirection(body, date, pos) {
    let LLA;
    // if a position is provided, use that to calculate the LLA of the observer
    // realistically this won't make any significant difference for the Sun,
    // the biggest difference will be for the Moon, then nearby planets
    if (pos !== undefined && pos.lengthSq() > 1e12) {
        // Position must be on or above Earth's surface (radius ~6.4e6 m, so lengthSq ~4e13)
        // If too close to origin (e.g. camera not yet positioned), fall back to Sit origin.
        LLA = EUSToLLA(pos);
    } else {
        // default to the local origin, should be fine for the sun.
        LLA = V3(Sit.lat, Sit.lon, 0)
    }

    let observer = new Astronomy.Observer(LLA.x, LLA.y, LLA.z);
    const celestialInfo = Astronomy.Equator(body, date, observer, false, true);
    const ra = (celestialInfo.ra) / 24 * 2 * Math.PI;   // Right Ascension NOTE, in hours, so 0..24 -> 0..2π
    const dec = radians(celestialInfo.dec); // Declination
    return getCelestialDirectionFromRaDec(ra, dec, date);
}

export function getCelestialDirectionFromRaDec(ra, dec, date) {
    const gst = calculateGST(date);
    const ecef = celestialToECEF(ra, dec, wgs84.RADIUS, gst)
    // ecef for the sun will give us a vector from the center to the earth towards the Sun (which, for our purposes
    // is considered to be infinitely far away

    // rotate this into the EUS coordinate system and normalize
    const eusDir = ECEF2EUS(ecef, radians(Sit.lat), radians(Sit.lon), 0, true).normalize();
    return eusDir;
}

// Geocentric body vector in ECEF/EUS (meters).
// Uses astronomy-engine's geocentric EQJ vector, rotates to EQD (of-date),
// then rotates by GAST into Earth-fixed coordinates.
export function getGeocentricBodyPositionEUS(body, date, aberration = true) {
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
    return ECEF2EUS(ecef, radians(Sit.lat), radians(Sit.lon), 0, false);
}

export function getGeocentricBodyDirectionEUS(body, date, aberration = true) {
    return getGeocentricBodyPositionEUS(body, date, aberration).normalize();
}
