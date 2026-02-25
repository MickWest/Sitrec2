// A variety of functions for converting between LLA (lat, lon, alt) and ECEF (earth centered earth fixed) and ENU (east, north, up)
// as well as some other useful related functions

import {Matrix3, Vector3} from "three";
// Removed import of cos, degrees, radians, sin - using direct Math functions instead
import {Globals, NodeMan, setRenderOne, Sit} from "./Globals";
import {assert} from "./assert.js";

// This is the distance in KM between two lat/long locations
// assumes a sphere of equatorial radius (WGS84)
export function haversineDistanceKM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const rLat1 = lat1 * Math.PI / 180;
    const rLat2 = lat2 * Math.PI / 180;
    const sin_dLat = Math.sin(dLat / 2);
    const sin_dLon = Math.sin(dLon / 2);
    const a = sin_dLat * sin_dLat +
        sin_dLon * sin_dLon * Math.cos(rLat1) * Math.cos(rLat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (wgs84.RADIUS / 1000) * c;
}

export function haversineDistanceABKM(a, b) {
    return haversineDistanceKM(a.y, a.x, b.y, b.x);
}

export function interpolateGreatCircle(lat1, lon1, lat2, lon2, t) {
    const toRad = Math.PI / 180;
    const toDeg = 180 / Math.PI;
    const phi1 = lat1 * toRad;
    const lambda1 = lon1 * toRad;
    const phi2 = lat2 * toRad;
    const lambda2 = lon2 * toRad;
    
    const d = 2 * Math.asin(Math.sqrt(
        Math.pow(Math.sin((phi2 - phi1) / 2), 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.pow(Math.sin((lambda2 - lambda1) / 2), 2)
    ));
    
    if (d < 1e-10) {
        return { lat: lat1, lon: lon1 };
    }
    
    const a = Math.sin((1 - t) * d) / Math.sin(d);
    const b = Math.sin(t * d) / Math.sin(d);
    
    const x = a * Math.cos(phi1) * Math.cos(lambda1) + b * Math.cos(phi2) * Math.cos(lambda2);
    const y = a * Math.cos(phi1) * Math.sin(lambda1) + b * Math.cos(phi2) * Math.sin(lambda2);
    const z = a * Math.sin(phi1) + b * Math.sin(phi2);
    
    return {
        lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
        lon: Math.atan2(y, x) * toDeg
    };
}


/////////////////
// https://github.com/lakowske/ecef-projector/blob/master/index.js

// wgs84 defines the ellipse. It's the standard earth shape used by Google Earth.
// it's very similar to GRS 80
// see https://en.wikipedia.org/wiki/World_Geodetic_System
export const wgs84 = {
    RADIUS: 6378137,                            // exact, and same as in GRS 80
    FLATTENING_DENOM: 298.257223563,
    radiusMiles: 3963.190592


};           // vs 298.257222100882711 for GRS 80

wgs84.FLATTENING = 1/wgs84.FLATTENING_DENOM;
wgs84.POLAR_RADIUS = wgs84.RADIUS*(1-wgs84.FLATTENING);
wgs84.CIRC = 2*Math.PI*wgs84.RADIUS

/**
 * Update Globals.equatorRadius and Globals.polarRadius based on the earth model.
 *   useEllipsoid=false → both = wgs84.RADIUS (degenerate sphere, same as legacy code)
 *   useEllipsoid=true  → equatorial = wgs84.RADIUS, polar = wgs84.POLAR_RADIUS (real WGS84)
 * Call this when a sitch loads and when the user toggles the earth model.
 */
export function updateEarthRadii(useEllipsoid) {
    const newEquator = wgs84.RADIUS;
    // Testing: use 0.5 * equatorialRadius when ellipsoid is enabled for obvious visual difference.
    // Replace 0.5 * wgs84.RADIUS with wgs84.POLAR_RADIUS once the implementation is verified.
//    const newPolar = useEllipsoid ? 0.5 * wgs84.RADIUS : wgs84.RADIUS;
    const newPolar = useEllipsoid ? wgs84.POLAR_RADIUS : wgs84.RADIUS;

    if (newEquator === Globals.equatorRadius && newPolar === Globals.polarRadius) return;

    Globals.equatorRadius = newEquator;
    Globals.polarRadius   = newPolar;

    // Refresh scene if the node graph is already set up (not during initial sitch load).
    if (NodeMan?.recalculateAllRootFirst) {
        NodeMan.recalculateAllRootFirst();
        if (NodeMan.exists("terrainUI")) {
            NodeMan.get("terrainUI").doRefresh();
        }
        setRenderOne(true);
    }
}

/** Radius of curvature in the prime vertical at geodetic latitude, using Globals radii. */
export function getN_radii(latitude) {
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;
    const e2 = (a*a - b*b) / (a*a);
    const sinLat = Math.sin(latitude);
    return a / Math.sqrt(1 - e2 * sinLat * sinLat);
}

/** LLA (radians) → ECEF Vector3 using Globals.equatorRadius / Globals.polarRadius. */
export function RLLAToECEF_radii(latitude, longitude, altitude) {
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;
    const N = getN_radii(latitude);
    const ratio = (b*b) / (a*a);
    const X = (N + altitude) * Math.cos(latitude) * Math.cos(longitude);
    const Y = (N + altitude) * Math.cos(latitude) * Math.sin(longitude);
    const Z = (ratio * N + altitude) * Math.sin(latitude);
    return new Vector3(X, Y, Z);
}

/** ECEF → [lat, lon, alt] (radians) using the iterative Bowring method with Globals radii.
 *  The single-step Bowring approximation has ~10m error at 10km altitude on extreme ellipsoids
 *  (e.g. the 0.5× polar radius test ellipsoid). Iterating the latitude converges to sub-mm. */
export function ECEFToLLA_radii(X, Y, Z) {
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;
    const asqr = a*a;
    const bsqr = b*b;
    const e2      = (asqr - bsqr) / asqr;
    const eprime2 = (asqr - bsqr) / bsqr;

    const p        = Math.sqrt(X*X + Y*Y);
    const theta    = Math.atan((Z*a) / (p*b));
    const sintheta = Math.sin(theta);
    const costheta = Math.cos(theta);

    // Bowring initial estimate
    let latitude  = Math.atan2(
        Z + eprime2 * b * sintheta * sintheta * sintheta,
        p - e2 * a * costheta * costheta * costheta
    );

    // Iterate to converge latitude (needed for high eccentricity or high altitude)
    for (let i = 0; i < 5; i++) {
        const sinLat = Math.sin(latitude);
        const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
        const newLat = Math.atan2(Z + e2 * N * sinLat, p);
        if (Math.abs(newLat - latitude) < 1e-15) break;
        latitude = newLat;
    }

    const longitude = Math.atan2(Y, X);
    const N         = getN_radii(latitude);
    const cosLat    = Math.cos(latitude);
    // Near the poles cos(lat)→0 and p→0, so use the Z-based formula instead.
    const altitude  = Math.abs(cosLat) > 1e-10
        ? (p / cosLat) - N
        : Math.abs(Z) / Math.abs(Math.sin(latitude)) - N * (1 - e2);
    return [latitude, longitude, altitude];
}

/** EUS → ECEF using the ellipsoid origin at Sit.lat/lon computed from Globals radii. */
// EXPERIMENT: EUS is now identical to ECEF (origin at Earth center, same axes)
export function EUSToECEF_radii(posEUS) {
    return posEUS.clone();
}

/** ECEF → EUS using the ellipsoid origin at Sit.lat/lon computed from Globals radii. */
// EXPERIMENT: EUS is now identical to ECEF (origin at Earth center, same axes)
export function ECEFToEUS_radii(posECEF) {
    return posECEF.clone();
}


// Other elipsoids I've seen:
//
// This is the default valued for "Other" in the NGS NCAT tool
//
// https://apa.ny.gov/gis/GisData/Wetlands/regulatorywetlands.html
// Horizontal Datum Name: North American Datum of 1983
// Ellipsoid Name: GRS 1980
// Semi-Major Axis: 6378206.40
// Denominator of Flattening Ratio: 294.98

///////////////////////////////////////////////////////////////////////////
// Source of the ECEF->LLA algorithm was given as
// * Datum Transformations of GPS Positions
// * Application Note
// NAL Research
// * 5th July 1999
//
// But it's actually B. R. Bowring, “Transformation from Spatial to Geographical Coordinates,”
//                   Survey Review, 23:181 (1976) 323-327


/*
 * Convert GPS coordinates (degrees) to Cartesian coordinates (meters)
 */
export function project(latitude, longitude, altitude) {
    return RLLAToECEF(latitude * Math.PI / 180, longitude * Math.PI / 180, altitude);
}

/*
 * Convert Cartesian coordinates (meters) to GPS coordinates (degrees)
 */
export function unproject(x, y, z) {
    const gps = ECEFToLLA(x, y, z);

    gps[0] = gps[0] * 180 / Math.PI;
    gps[1] = gps[1] * 180 / Math.PI;

    return gps;
}


export function RLLAToECEF(latitude, longitude, altitude) {


    const a    = wgs84.RADIUS;
    const f    = wgs84.FLATTENING;
    const b    = wgs84.POLAR_RADIUS;
    const asqr = a*a;
    const bsqr = b*b;
    const e = Math.sqrt((asqr-bsqr)/asqr);
    const eprime = Math.sqrt((asqr-bsqr)/bsqr);

    //Auxiliary values first
    const N = getN(latitude);
    const ratio = (bsqr / asqr);

    //Now calculate the Cartesian coordinates
    const X = (N + altitude) * Math.cos(latitude) * Math.cos(longitude);
    const Y = (N + altitude) * Math.cos(latitude) * Math.sin(longitude);

    //Sine of latitude looks right here
    const Z = (ratio * N + altitude) * Math.sin(latitude);

    return new Vector3(X, Y, Z);

}


export function LLAToECEF_Sphere(latitude, longitude, altitude) {

    const a    = wgs84.RADIUS;  // using the standard wgs84.RADIUS
    const X = (a + altitude) * Math.cos(latitude) * Math.cos(longitude);
    const Y = (a + altitude) * Math.cos(latitude) * Math.sin(longitude);
    const Z = (a + altitude) * Math.sin(latitude);

    return [X, Y, Z];
}

export function RLLAToECEFV_Sphere(latitude, longitude, altitude, radius = wgs84.RADIUS) {

    const X = (radius + altitude) * Math.cos(latitude) * Math.cos(longitude);
    const Y = (radius + altitude) * Math.cos(latitude) * Math.sin(longitude);
    const Z = (radius + altitude) * Math.sin(latitude);

    return new Vector3(X, Y, Z);
}

// Bowring method
// NOTE: this uses the WGS84 ellipse
// if using simple maps like map33 that use a sphere, then use the sphere version, next.
export function ECEFToLLA(X, Y, Z) {
    const a    = wgs84.RADIUS;
    const f    = wgs84.FLATTENING;
    const b    = wgs84.POLAR_RADIUS;
    const asqr = a*a;
    const bsqr = b*b;
    const e = Math.sqrt((asqr-bsqr)/asqr);
    const eprime = Math.sqrt((asqr-bsqr)/bsqr);

    //Auxiliary values first
    const p = Math.sqrt(X*X + Y*Y);
    const theta = Math.atan((Z*a)/(p*b));

    const sintheta = Math.sin(theta);
    const costheta = Math.cos(theta);

    const num = Z + eprime * eprime * b * sintheta * sintheta * sintheta;
    const denom = p - e * e * a * costheta * costheta * costheta;

    //Now calculate LLA
    const latitude  = Math.atan(num/denom);
    const longitude = Math.atan2(Y, X);
    const N = getN(latitude);
    const altitude  = (p / Math.cos(latitude)) - N;

    return [latitude, longitude, altitude];
}

export function ECEFToLLA_Sphere(X, Y, Z) {
    const R = wgs84.RADIUS; // Radius of the Earth

    // Calculate LLA
    const latitude  = Math.atan2(Z, Math.sqrt(X*X + Y*Y));
    const longitude = Math.atan2(Y, X);
    const altitude  = Math.sqrt(X*X + Y*Y + Z*Z) - R;

    return [latitude, longitude, altitude];
}


// same functions, but passing and returning parameters as a Vector3
// with LL as degrees
export function ECEFToLLAVD_Sphere(V) {
    const a = ECEFToLLA_Sphere(V.x,V.y,V.z);
    return new Vector3(a[0] * 180 / Math.PI, a[1] * 180 / Math.PI, a[2])
}

// EXPERIMENT: EUS is now identical to ECEF, so eus coords are ECEF coords
export function EUSToLLA(eus) {
    const lla = ECEFToLLA_radii(eus.x, eus.y, eus.z);
    return new Vector3(lla[0] * 180 / Math.PI, lla[1] * 180 / Math.PI, lla[2]);
}




// same functions, but passing and returning parameters as a Vector3
// with LL as degrees
export function ECEFToLLAVD(V) {
    const a = ECEFToLLA(V.x,V.y,V.z);
    return new Vector3(a[0] * 180 / Math.PI, a[1] * 180 / Math.PI, a[2])
}

// and with radians
export function ECEFToLLAV(V) {
    const a = ECEFToLLA(V.x,V.y,V.z);
    return new Vector3((a[0]),(a[1]),a[2])
}


export function LLAToECEFVD(V) {
    return RLLAToECEF(V.x * Math.PI / 180, V.y * Math.PI / 180, V.z);
}


// N is the radius of curvature at a given latitude
export function getN(latitude) {

    const a    = wgs84.RADIUS;
    const f    = wgs84.FLATTENING;
    const b    = wgs84.POLAR_RADIUS;
    const asqr = a*a;
    const bsqr = b*b;
    const e = Math.sqrt((asqr-bsqr)/asqr);
    const eprime = Math.sqrt((asqr-bsqr)/bsqr);

    const sinlatitude = Math.sin(latitude);
    const denom = Math.sqrt(1-e*e*sinlatitude*sinlatitude);
    const N = a / denom;
    return N;
}


// Models in Google Earth exist in a local coordinate system, where point a is going to be at 0,0,0
// and point B will be a transformed A2B vector away (same length)
// we need to tranlast between coordinate systems. So we need to calculate a set or orthogonal vectors
// for a coordinate system at A
// The local coordinate system has basis vectors in ECEF of:
// x = due east (right)
// y = due north (forward)
// z = up from center (up)
// This is known in the literature as an ENU system.


// see: https://en.wikipedia.org/wiki/Geographic_coordinate_conversion#Geodetic_to/from_ENU_coordinates
// the latitude and longitude define the ENU coordinate system realtive to A
// so we just need the standard transform
// note Google Earth uses Geodetic latitude, as required. Meaning the up vector is perpendicular to
// the tangent of the ellipse, and not through the center of the ellipse
// this is basically a rotation matrix created with two angles.
// Roatate about (y?) with latitude, and then about z with longtitude

// lat1, lon1 in radians
export function ECEF2ENU(pos,lat1, lon1, radius, justRotate=false) {
    assert(radius !== undefined, "ECEF2ENU needs explicit radius" )
    // the origin in ECEF coordinates is at the surface with lat1, lon1

    const mECEF2ENU = new Matrix3().set(
        -Math.sin(lon1), Math.cos(lon1), 0,
        -Math.sin(lat1) * Math.cos(lon1), -Math.sin(lat1) * Math.sin(lon1), Math.cos(lat1),
        Math.cos(lat1) * Math.cos(lon1), Math.cos(lat1) * Math.sin(lon1), Math.sin(lat1)
    );
    let enu
    if (!justRotate) {
        const originECEF = RLLAToECEFV_Sphere(lat1, lon1, 0, radius)
        enu = pos.clone().sub((originECEF)).applyMatrix3(mECEF2ENU)
    } else {
        enu = pos.clone().applyMatrix3(mECEF2ENU)
    }

    return enu;
}

// EXPERIMENT: EUS is now identical to ECEF
export function ECEF2EUS(pos,lat1, lon1, radius, justRotate=false) {
    return pos.clone();
}

// Ellipsoid-aware ECEF→ENU using RLLAToECEF_radii for origin (Globals radii).
// Rotation matrix depends only on geodetic lat/lon, not Earth shape.
export function ECEF2ENU_radii(pos, lat1, lon1, justRotate=false) {
    const mECEF2ENU = new Matrix3().set(
        -Math.sin(lon1), Math.cos(lon1), 0,
        -Math.sin(lat1) * Math.cos(lon1), -Math.sin(lat1) * Math.sin(lon1), Math.cos(lat1),
        Math.cos(lat1) * Math.cos(lon1), Math.cos(lat1) * Math.sin(lon1), Math.sin(lat1)
    );
    let enu;
    if (!justRotate) {
        const originECEF = RLLAToECEF_radii(lat1, lon1, 0);
        enu = pos.clone().sub(originECEF).applyMatrix3(mECEF2ENU);
    } else {
        enu = pos.clone().applyMatrix3(mECEF2ENU);
    }
    return enu;
}

// Ellipsoid-aware ENU→ECEF using RLLAToECEF_radii for origin (Globals radii).
export function ENU2ECEF_radii(pos, lat1, lon1, justRotate=false) {
    const mECEF2ENU = new Matrix3().set(
        -Math.sin(lon1), Math.cos(lon1), 0,
        -Math.sin(lat1) * Math.cos(lon1), -Math.sin(lat1) * Math.sin(lon1), Math.cos(lat1),
        Math.cos(lat1) * Math.cos(lon1), Math.cos(lat1) * Math.sin(lon1), Math.sin(lat1)
    );
    const mENU2ECEF = new Matrix3().copy(mECEF2ENU).invert();
    let ecef;
    if (!justRotate) {
        const originECEF = RLLAToECEF_radii(lat1, lon1, 0);
        ecef = pos.clone().applyMatrix3(mENU2ECEF).add(originECEF);
    } else {
        ecef = pos.clone().applyMatrix3(mENU2ECEF);
    }
    return ecef;
}

// Inverse of ECEF2ENU - converts from ENU to ECEF
export function ENU2ECEF(pos, lat1, lon1, radius, justRotate=false) {
    assert(radius !== undefined, "ENU2ECEF needs explicit radius")
    
    // Create the inverse transformation matrix (ENU to ECEF)
    const mECEF2ENU = new Matrix3().set(
        -Math.sin(lon1), Math.cos(lon1), 0,
        -Math.sin(lat1) * Math.cos(lon1), -Math.sin(lat1) * Math.sin(lon1), Math.cos(lat1),
        Math.cos(lat1) * Math.cos(lon1), Math.cos(lat1) * Math.sin(lon1), Math.sin(lat1)
    );
    
    const mENU2ECEF = new Matrix3().copy(mECEF2ENU).invert();
    
    let ecef;
    if (!justRotate) {
        const originECEF = RLLAToECEFV_Sphere(lat1, lon1, 0, radius);
        ecef = pos.clone().applyMatrix3(mENU2ECEF).add(originECEF);
    } else {
        ecef = pos.clone().applyMatrix3(mENU2ECEF);
    }
    
    return ecef;
}

// Convert legacy EUS (East-Up-South) local tangent plane coordinates
// to ECEF on the ellipsoid. Used for old sitch data that has spline points
// defined in the local EUS frame at Sit.lat/Sit.lon.
// The old EUS frame assumed a spherical Earth (wgs84.RADIUS), so we:
// 1. EUS→ENU axis swap: (x, y, z) → (x, -z, y)
// 2. ENU→ECEF on the sphere (recovering the spherical ECEF position)
// 3. Spherical ECEF→LLA (getting the geographic coordinates)
// 4. LLA→ECEF on the ellipsoid (placing the point correctly on the WGS84 ellipsoid)
export function legacyEUSToECEF(eus, lat, lon) {
    const enu = new Vector3(eus.x, -eus.z, eus.y);
    const sphericalECEF = ENU2ECEF(enu, lat, lon, wgs84.RADIUS);
    const lla = ECEFToLLA_Sphere(sphericalECEF.x, sphericalECEF.y, sphericalECEF.z);
    // lla = [lat_rad, lon_rad, alt_m]
    return LLAToEUSRadians(lla[0], lla[1], lla[2]);
}

// EXPERIMENT: EUS is now identical to ECEF
export function ECEFToEUS(posECEF, radius) {
    return posECEF.clone();
}

// EXPERIMENT: EUS is now identical to ECEF
export function EUSToECEF(posEUS, radius) {
    return posEUS.clone();
}

// Pre-computed constants for optimization - updated when Sit location or earth model changes
let _sitLatRad, _sitLonRad, _sitSinLat, _sitCosLat, _sitSinLon, _sitCosLon;
let _originEcefX, _originEcefY, _originEcefZ;
let _m00, _m01, _m10, _m11, _m12, _m20, _m21, _m22;
// Pre-computed per-vertex ellipsoid constants (used in LLAToEUSRadians)
let _llaeus_e2, _llaeus_ratio;
let _lastSitLat = null, _lastSitLon = null;
let _lastEquatorRadius = null, _lastPolarRadius = null;

// Constant for radians conversion (Math.PI / 180)
const _DEG_TO_RAD = 0.017453292519943295;

// Update pre-computed constants when Sit location or earth model changes
function _updateSitConstants() {
    if (Sit.lat === _lastSitLat && Sit.lon === _lastSitLon
            && Globals.equatorRadius === _lastEquatorRadius && Globals.polarRadius === _lastPolarRadius) {
        return; // No change, constants are still valid
    }

    _lastSitLat = Sit.lat;
    _lastSitLon = Sit.lon;
    _lastEquatorRadius = Globals.equatorRadius;
    _lastPolarRadius   = Globals.polarRadius;

    _sitLatRad = Sit.lat * _DEG_TO_RAD;
    _sitLonRad = Sit.lon * _DEG_TO_RAD;
    _sitSinLat = Math.sin(_sitLatRad);
    _sitCosLat = Math.cos(_sitLatRad);
    _sitSinLon = Math.sin(_sitLonRad);
    _sitCosLon = Math.cos(_sitLonRad);

    // Pre-compute ellipsoid constants for vertex ECEF conversion
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;
    _llaeus_e2    = (a*a - b*b) / (a*a);
    _llaeus_ratio = (b*b) / (a*a);

    // Pre-compute origin ECEF using the current earth model (ellipsoid or degenerate sphere)
    const N_origin = a / Math.sqrt(1 - _llaeus_e2 * _sitSinLat * _sitSinLat);
    _originEcefX = N_origin * _sitCosLat * _sitCosLon;
    _originEcefY = N_origin * _sitCosLat * _sitSinLon;
    _originEcefZ = _llaeus_ratio * N_origin * _sitSinLat;
    
    // Pre-compute transformation matrix elements
    _m00 = -_sitSinLon;
    _m01 = _sitCosLon;
    // _m02 = 0 (not needed, always zero)
    _m10 = -_sitSinLat * _sitCosLon;
    _m11 = -_sitSinLat * _sitSinLon;
    _m12 = _sitCosLat;
    _m20 = _sitCosLat * _sitCosLon;
    _m21 = _sitCosLat * _sitSinLon;
    _m22 = _sitSinLat;
}

// Convert LLA to EUS. Optional earth's radius parameter is deprecated, and should not be used.
// EXPERIMENT: EUS is now identical to ECEF, so this just does LLA → ECEF.
export function LLAToEUSRadians(lat, lon, alt=0, radius) {
    assert(radius === undefined, "undexpected radius in LLAToEUS")
    assert(Sit.lat !== undefined, "Sit.lat undefined in LLAToEUS")

    // Update constants if Sit location or earth model changed (need ellipsoid constants)
    _updateSitConstants();

    const cos_lat = Math.cos(lat);
    const sin_lat = Math.sin(lat);
    const cos_lon = Math.cos(lon);
    const sin_lon = Math.sin(lon);

    // Convert LLA to ECEF using the current earth model (ellipsoid or degenerate sphere)
    const N = Globals.equatorRadius / Math.sqrt(1 - _llaeus_e2 * sin_lat * sin_lat);
    const ecef_x = (N + alt) * cos_lat * cos_lon;
    const ecef_y = (N + alt) * cos_lat * sin_lon;
    const ecef_z = (_llaeus_ratio * N + alt) * sin_lat;

    // EUS = ECEF (no origin subtraction, no rotation)
    return new Vector3(ecef_x, ecef_y, ecef_z);
}

// Convert LLA to Spherical EUS. Optional earth's radius parameter is deprecated, and should not be used.
// OPTIMIZED VERSION: Uses constant multiplier for degree to radian conversion
export function LLAToEUS(lat, lon, alt=0, radius) {
    // Convert degrees to radians using constant multiplier (faster than radians() function)
    return LLAToEUSRadians(lat * _DEG_TO_RAD, lon * _DEG_TO_RAD, alt, radius);
}

// vector input version
export function LLAVToEUS(lla, radius) {
    assert(radius === undefined, "undexpected radius in LLAVToEUS")
    return LLAToEUS(lla.x, lla.y, lla.z)
}

// Force update of LLA to EUS constants (call this if you manually change Sit.lat/lon)
export function updateLLAToEUSConstants() {
    _lastSitLat = null;
    _lastSitLon = null;
    _updateSitConstants();
}


// Convert RA, Dec to Az, El
// Inputs in radians, outputs in radians
// modified so az is positive clockwise from north
export function raDecToAzElRADIANS(ra, dec, lat, lon, lst) {
    // Calculate the Hour Angle (HA)
    const ha = lst - ra;

    // Calculate Altitude (Elevation - El)
    const sinEl = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
    const el = Math.asin(sinEl);

    // Calculate Azimuth (Az)
    const cosAz = (Math.sin(dec) - Math.sin(el) * Math.sin(lat)) / (Math.cos(el) * Math.cos(lat));
    const sinAz = Math.cos(dec) * Math.sin(ha) / Math.cos(el);
    let az = -Math.atan2(sinAz, cosAz);

    // // Convert azimuth from [-π, π] to [0, 2π]
    // if (az < 0) {
    //     az += 2 * Math.PI;
    // }

    return { az, el };
}

// GIven a date JS object (which also contains time) and a longitiude
// Find the Local Sidereal time.
export function getLST(date, longitude) {
    // Convert date to Julian Date
    const JD = date.getTime() / 86400000 + 2440587.5;

    // Calculate the number of centuries since the epoch J2000.0
    const T = (JD - 2451545.0) / 36525;

    // Calculate the Greenwich Mean Sidereal Time (GMST)
    let GMST = 280.46061837 + 360.98564736629 * (JD - 2451545) + T * T * (0.000387933 - T / 38710000);
    GMST %= 360;  // Reduce to between 0 and 360 degrees
    if (GMST < 0) GMST += 360;  // Make sure it's positive

    // Convert to radians
    GMST = GMST * Math.PI / 180;

    // Adjust by longitude to get Local Sidereal Time (in radians)
    const LST = GMST + longitude;

    // Reduce to between 0 and 2π radians
    return ((LST % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}


// given a position on the celestial sphere, find the az and el from a particular lat, lon
// BAD
export function ECEFCelestialToAzEl(ecef, lat, lon) {
    // First convert to ENU, so locally Z is up
    const enu = ECEF2ENU(ecef, lat, lon, 1, true)

    // elevation is now the angle between the ENU vector and the XY plane

    const r = enu.length();

    const el = Math.asin(enu.z/r)
    const az = Math.atan2(enu.x,enu.y)

    return {az,el}
}


//var mENU2ECEF = new Matrix3().getInverse(ECEF2ENU);

/**
 * Convert UTM coordinates to latitude/longitude (WGS84)
 * @param {number} easting - UTM easting in meters
 * @param {number} northing - UTM northing in meters
 * @param {number} zone - UTM zone number (1-60)
 * @param {boolean} northern - true for northern hemisphere, false for southern
 * @returns {{lat: number, lon: number}} Latitude and longitude in degrees
 */
export function utmToLatLon(easting, northing, zone, northern = true) {
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const k0 = 0.9996;
    
    const e = Math.sqrt(2 * f - f * f);
    const e2 = e * e;
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const ep2 = e2 / (1 - e2);
    
    const x = easting - 500000;
    const y = northern ? northing : northing - 10000000;
    
    const M = y / k0;
    const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    
    const phi1 = mu + 
        (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu) +
        (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu) +
        (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu) +
        (1097 * e1 * e1 * e1 * e1 / 512) * Math.sin(8 * mu);
    
    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = Math.tan(phi1);
    
    const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const T1 = tanPhi1 * tanPhi1;
    const C1 = ep2 * cosPhi1 * cosPhi1;
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
    const D = x / (N1 * k0);
    
    const lat = phi1 - (N1 * tanPhi1 / R1) * (
        D * D / 2 -
        (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D * D * D * D / 24 +
        (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D * D * D * D * D * D / 720
    );
    
    const lonOrigin = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const lon = lonOrigin + (
        D -
        (1 + 2 * T1 + C1) * D * D * D / 6 +
        (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D * D * D * D * D / 120
    ) / cosPhi1;
    
    return {
        lat: lat * 180 / Math.PI,
        lon: lon * 180 / Math.PI
    };
}

/**
 * Parse EPSG code to extract UTM zone and hemisphere info
 * Supports NAD83 (269xx) and WGS84 (326xx/327xx) UTM zones
 * @param {number} epsgCode - EPSG code (e.g., 26911, 32611)
 * @returns {{zone: number, northern: boolean}|null} Zone info or null if not UTM
 */
export function parseUTMFromEPSG(epsgCode) {
    if (epsgCode >= 26901 && epsgCode <= 26923) {
        return { zone: epsgCode - 26900, northern: true };
    }
    if (epsgCode >= 32601 && epsgCode <= 32660) {
        return { zone: epsgCode - 32600, northern: true };
    }
    if (epsgCode >= 32701 && epsgCode <= 32760) {
        return { zone: epsgCode - 32700, northern: false };
    }
    return null;
}

const CA_STATE_PLANE_ZONES = {
    2225: { zone: 1, units: 'ft', feM: 2000000, fnM: 500000 },
    2226: { zone: 2, units: 'ft', feM: 2000000, fnM: 500000 },
    2227: { zone: 3, units: 'ft', feM: 2000000, fnM: 500000 },
    2228: { zone: 4, units: 'ft', feM: 2000000, fnM: 500000 },
    2229: { zone: 5, units: 'ft', feM: 2000000, fnM: 500000 },
    2230: { zone: 6, units: 'ft', feM: 2000000, fnM: 500000 },
    2766: { zone: 1, units: 'm', feM: 2000000, fnM: 500000 },
    2767: { zone: 2, units: 'm', feM: 2000000, fnM: 500000 },
    2768: { zone: 3, units: 'm', feM: 2000000, fnM: 500000 },
    2769: { zone: 4, units: 'm', feM: 2000000, fnM: 500000 },
    2770: { zone: 5, units: 'm', feM: 2000000, fnM: 500000 },
    2771: { zone: 6, units: 'm', feM: 2000000, fnM: 500000 },
    2870: { zone: 1, units: 'ftUS', feM: 2000000, fnM: 500000 },
    2871: { zone: 2, units: 'ftUS', feM: 2000000, fnM: 500000 },
    2872: { zone: 3, units: 'ftUS', feM: 2000000, fnM: 500000 },
    2873: { zone: 4, units: 'ftUS', feM: 2000000, fnM: 500000 },
    2874: { zone: 5, units: 'ftUS', feM: 2000000, fnM: 500000 },
    2875: { zone: 6, units: 'ftUS', feM: 2000000, fnM: 500000 },
    6414: { zone: 1, units: 'ftUS', feM: 2000000, fnM: 500000 },
    6415: { zone: 2, units: 'ftUS', feM: 2000000, fnM: 500000 },
    6416: { zone: 3, units: 'ftUS', feM: 2000000, fnM: 500000 },
    6417: { zone: 4, units: 'ftUS', feM: 2000000, fnM: 500000 },
    6418: { zone: 5, units: 'ftUS', feM: 2000000, fnM: 500000 },
    6419: { zone: 6, units: 'ftUS', feM: 2000000, fnM: 500000 },
};

const CA_ZONE_PARAMS = {
    1: { lat0: 39.333333, lon0: -122, sp1: 40, sp2: 41.666667 },
    2: { lat0: 37.666667, lon0: -122, sp1: 38.333333, sp2: 39.833333 },
    3: { lat0: 36.5, lon0: -120.5, sp1: 37.066667, sp2: 38.433333 },
    4: { lat0: 35.333333, lon0: -119, sp1: 36, sp2: 37.25 },
    5: { lat0: 33.5, lon0: -118, sp1: 34.033333, sp2: 35.466667 },
    6: { lat0: 32.166667, lon0: -116.25, sp1: 32.783333, sp2: 33.883333 },
};

/**
 * Parse California State Plane EPSG code
 * @param {number} epsgCode - EPSG code
 * @returns {{zone: number, units: string}|null} Zone info or null if not CA State Plane
 */
export function parseCAStatePlaneFromEPSG(epsgCode) {
    return CA_STATE_PLANE_ZONES[epsgCode] || null;
}

/**
 * Convert California State Plane coordinates to lat/lon (NAD83)
 * Uses Lambert Conformal Conic projection
 * @param {number} easting - Easting coordinate
 * @param {number} northing - Northing coordinate
 * @param {number} zone - CA State Plane zone (1-6)
 * @param {string} units - 'm', 'ft', or 'ftUS'
 * @param {number} feM - False easting in meters
 * @param {number} fnM - False northing in meters
 * @returns {{lat: number, lon: number}} Latitude and longitude in degrees
 */
export function caStatePlaneToLatLon(easting, northing, zone, units = 'ftUS', feM = 2000000, fnM = 500000) {
    const p = CA_ZONE_PARAMS[zone];
    if (!p) return null;
    
    let e = easting, n = northing;
    if (units === 'ftUS') {
        e *= 0.3048006096012192;
        n *= 0.3048006096012192;
    } else if (units === 'ft') {
        e *= 0.3048;
        n *= 0.3048;
    }
    
    const a = 6378137.0;
    const f = 1 / 298.257222101;
    const e2 = 2 * f - f * f;
    const ec = Math.sqrt(e2);
    
    const toRad = Math.PI / 180;
    const lat0 = p.lat0 * toRad;
    const lon0 = p.lon0 * toRad;
    const sp1 = p.sp1 * toRad;
    const sp2 = p.sp2 * toRad;
    
    const m1 = Math.cos(sp1) / Math.sqrt(1 - e2 * Math.sin(sp1) * Math.sin(sp1));
    const m2 = Math.cos(sp2) / Math.sqrt(1 - e2 * Math.sin(sp2) * Math.sin(sp2));
    const t0 = Math.tan(Math.PI / 4 - lat0 / 2) / Math.pow((1 - ec * Math.sin(lat0)) / (1 + ec * Math.sin(lat0)), ec / 2);
    const t1 = Math.tan(Math.PI / 4 - sp1 / 2) / Math.pow((1 - ec * Math.sin(sp1)) / (1 + ec * Math.sin(sp1)), ec / 2);
    const t2 = Math.tan(Math.PI / 4 - sp2 / 2) / Math.pow((1 - ec * Math.sin(sp2)) / (1 + ec * Math.sin(sp2)), ec / 2);
    
    const nn = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
    const F = m1 / (nn * Math.pow(t1, nn));
    const rho0 = a * F * Math.pow(t0, nn);
    
    const x = e - feM;
    const y = rho0 - (n - fnM);
    const rho = Math.sign(nn) * Math.sqrt(x * x + y * y);
    const t = Math.pow(rho / (a * F), 1 / nn);
    const theta = Math.atan2(x, y);
    
    let lat = Math.PI / 2 - 2 * Math.atan(t);
    for (let i = 0; i < 10; i++) {
        const eSinLat = ec * Math.sin(lat);
        lat = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - eSinLat) / (1 + eSinLat), ec / 2));
    }
    
    const lon = theta / nn + lon0;
    
    return {
        lat: lat * 180 / Math.PI,
        lon: lon * 180 / Math.PI
    };
}