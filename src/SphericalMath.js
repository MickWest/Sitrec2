import {Plane, Vector3} from "three";
import {atan2, cos, degrees, radians, sin} from "./utils.js";
import {ECEF2EUS, ECEFToEUS_radii, ECEFToLLA_radii, EUSToECEF_radii, RLLAToECEF_radii, wgs84} from "./LLA-ECEF-ENU";
import {Globals, Sit} from "./Globals";
import {assert} from "./assert.js";
import {MV3, V3} from "./threeUtils";


// Scene coordinates are now ECEF (Earth-Centered Earth-Fixed).
// EUS is an identity mapping to ECEF. The old local tangent plane (East, Up, South)
// convention is no longer used for coordinate transforms, but some variable names persist.
// See: https://en.wikipedia.org/wiki/Local_tangent_plane_coordinates
//
// the Az=0 and El=0 is always along the -Z axis (horizontal, North)
// This can be thought of as a position on a unit sphere.
// El is relative to the horizontal plane, so jetPitch is irrelevant
// Az is relative to the jet's forward direction in the horizontal plane


function CueAz(el,az,jetRoll,jetPitch) {
    // get a unit vector in the direction of Az/El
    // the Az=0 and El=0 is always along the global -Z axis (horizontal, or N in ENU)
    // This can be thought of as a position on a unit sphere.
    // El is relative to the horizontal plane, so jetPitch is irrelevant
    // Az is relative to the jet's forward direction in the horizontal plane
    const AzElHeading = EA2XYZ(el, az, 1)

    // Create a Plane object, representing the wing plane
    // (a "plane" is a flat 2D surface in 3D space, not an aeroplane)
    // the plane in Hessian normal form, normal unit vector (jetUp)
    // and a distance from the origin (0, as the origin is the ATFLIR camera, i.e. the jet)
    const jetUp = new Vector3(0, 1, 0) // y=1 is the jet up unit vector with no rotation
    jetUp.applyAxisAngle(V3(0,0,1),-radians(jetRoll)) // apply roll about Z axis (-Z is fwd, so -ve)
    jetUp.applyAxisAngle(V3(1,0,0),radians(jetPitch))  // apply pitch about X axis (right)
    const wingPlane = new Plane(jetUp,0)

    // project AzElHeading onto wingPlane, giving cueHeading
    const cueHeading = wingPlane.projectPoint(AzElHeading,new Vector3)

    // now find the jet's forward vector, which will be in the wing plane
    // same rotations as with the up vector
    const jetForward = new Vector3(0, 0, -1)
    jetForward.applyAxisAngle(V3(0,0,1),-radians(jetRoll))
    jetForward.applyAxisAngle(V3(1,0,0),radians(jetPitch))

    // calculate the angle between the jet forward vector
    let cueAz = degrees(jetForward.angleTo(cueHeading))

    // angleTo always returns a positive value, so we
    // need to negate it unless cross product is in same direction as jet up
    // the cross product will give a vector either up or down from the plane
    // depending on if cueHeading is left or right of JetForward when looking down
    const cross = cueHeading.clone().cross(jetForward)
    // then use a dot product which returns positive if two vectors are in the same direction
    const sign = cross.dot(jetUp)
    if (sign < 0) cueAz = -cueAz

    // The return value is plotted in cyan (light blue)
    return cueAz;
}

// These were written for Left Handed Coordinates, so returning -z
// as THREE.js is right handed

// pitch = rotation of the "ball", relative to straight ahead
// roll = clockwise roll of the entire system along the forward axis
// jetPitch is the angle of boresight above horizon, rotation about X
// These have somewhat nominal orientations, but 0,0 is straight ahead
// and when roll = 0, a positive pitch is vertical.
// The forward axis is -z, vertical is y, right = x.
function PRJ2XYZ(pitch, roll, jetPitch, r) {
    roll -=180
    if (roll < 360) roll += 360

    const x = r * sin(radians(pitch)) * sin(radians(roll))
    const y = r * sin(radians(pitch)) * cos(radians(roll))
    const z = r * cos (radians(pitch))
    const jetPitchR = radians(-jetPitch)
    const za = z * cos(jetPitchR) + y * sin(jetPitchR)
    const ya = y * cos(jetPitchR) - z * sin(jetPitchR)
    return new Vector3(x,ya,-za);
}

// el = Elevation is the angle above horizontal
// az = Azimuth is the angle in the horizontal plane relative to the direction of travel

// Calculations here assume positive z is forward, right hand
// but return -ve z (left hand)
// the XYZ result is in the GLOBAL frame of reference

function EA2XYZ(el, az, r) {
    const x = r *  cos(radians(el)) * sin(radians(az))
    const y = r * sin(radians(el))
    const z = r *  cos(radians(el)) * cos (radians(az))

    return new Vector3(x,y,-z);
}

// note, this assumes normalized global x,y,z coordiantes (on the surface of a sphere centerd at 0,0,0))
function XYZ2EA(v) {
    const el = degrees(atan2(v.y, Math.sqrt(v.z*v.z + v.x*v.x)))
    const az = degrees(atan2(v.x,-v.z))
    return [el,az];
}

// convert global X,Y,Z and jetPitch to pod Pitch and Roll.
// jetPitch is the angle of boresight above horizon
// so first we need to convert to the frame of reference of the pod
// by rotating about x (right) by jetPitch
// Will always return a positive pitch.
// But there's always a solution with the same negative pitch
// and roll+180 or roll-180
// if you are seeing minimum movement, then the algorithm should consider that.
function XYZJ2PR(v,jetPitch) {

    const jetPitchR = radians(-jetPitch)
    const x = v.x
    const y = v.y * cos(jetPitchR) - v.z * sin(jetPitchR)
    const z = v.z * cos(jetPitchR) + v.y * sin(jetPitchR)

    const pitch = degrees(atan2(Math.sqrt(x*x + y*y),-z))
    let roll = degrees(atan2(x,y))
    roll += 180
    if (roll >180) roll -= 360;
    return [pitch, roll]
}

// Convert El, Al, and jetPitch to Pitch and Roll
// by converting global El and Al first to global x,y,z
// then converting that global x,y,z, together with jetPitch to pitch and roll
function EAJP2PR(el, az, jetPitch) {
    return XYZJ2PR(EA2XYZ(el,az,1),jetPitch)
}

// convert a pitch, roll, and jetPitch to elevation and azimuth
// first convert pitch, roll, and jetPitch to global xyz, then that to global El and Az
function PRJ2EA(pitch, roll, jetPitch) {
    return XYZ2EA(PRJ2XYZ(pitch,roll,jetPitch,1))
}

////////////////////////////////////////////////////////////////////////////////
// Earth geometry utility functions.
// Currently implemented using sphere geometry (all radii = wgs84.RADIUS).
// These are the single points of change when migrating to ellipsoid geometry.
////////////////////////////////////////////////////////////////////////////////

/**
 * Earth centre in EUS (East-Up-South) rendering coordinates.
 * Computed as the EUS position of the ECEF origin (0,0,0) using the active earth model.
 * In sphere mode (polarRadius === equatorRadius) this returns V3(0, -equatorRadius, 0).
 * In ellipsoid mode the Y component depends on latitude:
 *   - equator (lat=0):  Y = -equatorRadius
 *   - pole (lat=90°):   Y = -polarRadius
 */
export function earthCenterEUS() {
    return ECEFToEUS_radii(V3(0, 0, 0));
}

/**
 * Geodetic MSL altitude of a point in EUS coordinates.
 * Converts EUS → ECEF → LLA using the active earth model (Globals radii).
 * When Globals.polarRadius === Globals.equatorRadius this degenerates to the
 * same result as the old sphere formula, preserving regression stability.
 */
export function altitudeMSL(point) {
    const ecef = EUSToECEF_radii(point);
    return ECEFToLLA_radii(ecef.x, ecef.y, ecef.z)[2];
}

/**
 * Move a point to a specific geodetic MSL altitude.
 * Converts EUS → ECEF → LLA, replaces the altitude, then converts back.
 * Degenerates to exact sphere result when polarRadius === equatorRadius.
 */
export function setAltitudeMSL(point, altitude) {
    const ecef = EUSToECEF_radii(point);
    const lla  = ECEFToLLA_radii(ecef.x, ecef.y, ecef.z);
    const ecef2 = RLLAToECEF_radii(lla[0], lla[1], altitude);
    return ECEFToEUS_radii(ecef2);
}

/**
 * Point on the Earth surface directly below a given EUS point.
 */
export function pointOnSurface(point) {
    return setAltitudeMSL(point, 0);
}

/**
 * Vertical drop of Earth's surface below a flat horizontal tangent plane
 * at horizontal distance dist from the tangent point.
 * The default radius is Globals.equatorRadius; a caller with a latitude-specific
 * radius of curvature may pass it explicitly.
 */
export function earthSurfaceDrop(dist, r = Globals.equatorRadius) {
    return r - Math.sqrt(r * r - dist * dist);
}

/**
 * Straight-line distance to the visible horizon from height h above MSL.
 * Default radius is Globals.equatorRadius.
 */
export function horizonDistance(h, r = Globals.equatorRadius) {
    return Math.sqrt((r + h) * (r + h) - r * r);
}

/**
 * How much of an object at ground distance d and height h above MSL
 * is hidden below the horizon due to Earth's curvature.
 * Default radius is Globals.equatorRadius.
 */
export function hiddenBelowHorizon(h, d, r = Globals.equatorRadius) {
    return r / Math.cos(d / r - Math.acos(r / (r + h))) - r;
}

////////////////////////////////////////////////////////////////////////////////

// How much is the ground below the EUS plane
// x, y are in meters
// Note there two Pythagorean ways you can derive drop
// Either the distance straight down, or the distance towards the center of the Earth
// this uses the former, so subtracting this from Y will give a point on the surface.
// (using the latter would need a scaled vector towards the center)
function drop(x,y) {
    // dist = how far it is from 0,0 horizontally
    const dist = Math.sqrt(x*x + y*y);
    return earthSurfaceDrop(dist);
}

export function dropFromDistance(dist, radius=Globals.equatorRadius) {
    return earthSurfaceDrop(dist, radius);
}


// get altitude of a point in EUS coordinates above MSL
// for full terrain use altitudeAt(position) or altitudeAtLL(lat, lon)
export function pointAltitude(position) {
    return altitudeMSL(position);
}


export function raisePoint(position, raise) {
    let up = getLocalUpVector(position)
    let result = position.clone().add(up.multiplyScalar(raise))
    return result;
}


// get as a point, drop below surface
function drop3(x,y) {
    return new Vector3(x,y,-drop(x,y))
}


export {drop, drop3, CueAz,PRJ2EA,EAJP2PR,XYZJ2PR,XYZ2EA,EA2XYZ,PRJ2XYZ}


// position is in EUS (East, Up, South) coordinates relative to an arbitary origin
// origin might be above the surface (in Gimbal it's the start of the jet track, so that is passed in
export function getLocalUpVector(position) {
    // Compute the geodetic normal for the current earth model.
    // The outward normal to the ellipsoid x²/a² + y²/a² + z²/b² = 1
    // at ECEF point (X,Y,Z) is proportional to (X/a², Y/a², Z/b²).
    // For a sphere (a === b) this degenerates to the geocentric direction.
    const ecef = EUSToECEF_radii(position);
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;
    const normalECEF = V3(ecef.x / (a * a), ecef.y / (a * a), ecef.z / (b * b)).normalize();

    // Rotate from ECEF to EUS (rotation only, no translation)
    return ECEF2EUS(normalECEF, radians(Sit.lat), radians(Sit.lon), wgs84.RADIUS, true);
}

export function getLocalDownVector(position) {
    return getLocalUpVector(position).negate();
}


export function getNorthPole() {
    // North Pole in ECEF is at (0, 0, polarRadius) for an ellipsoid
    const northPoleECEF = V3(0, 0, Globals.polarRadius);
    return ECEFToEUS_radii(northPoleECEF);
}

export function getLocalNorthVector(position) {
    assert(Sit.lat !== undefined && Sit.lon !== undefined, "Sit.lat and Sit.lon must be defined for getLocalNorthVector() to work.");
    // to get a northish direction we get the vector from here to the north pole.
    // to get the north pole in EUS, we take the north pole's position in ECEF
    const northPoleEUS = getNorthPole();
    const toNorth = northPoleEUS.clone().sub(position).normalize()
    // take only the component perpendicular to the local up vector
    const up = getLocalUpVector(position);
    const dot = toNorth.dot(up)
    const north = toNorth.clone().sub(up.clone().multiplyScalar(dot)).normalize()
    return north;
}

export function getLocalSouthVector(position) {
    return getLocalNorthVector(position).negate();
}

export function getLocalEastVector(position) {
    const up = getLocalUpVector(position);
    const north = getLocalNorthVector(position);
    const south = north.clone().negate()
    const east = V3().crossVectors(up, south)
    return east;

}

export function getLocalWestVector(position) {
    return getLocalEastVector(position).negate();
}


// given a position (A) and a vector direction (fwd), and an altitude for the horizon surface,
// find the position of the horizon in that direction
// this actually calculates the distance to the horizon, and then a point that distance along the fwd vector.
export function calcHorizonPoint(A, fwd, horizonAlt) {
    // Derive the local geocentric surface radius from the ECEF position.
    // Using equatorialRadius fails at non-equatorial latitudes because the Earth is oblate:
    // at lat 28.5°, the geocentric distance is ~6373 km vs equatorial 6378 km,
    // so (A.length() - equatorialRadius - cloudAlt) can go negative → sqrt(negative) = NaN.
    const lla = ECEFToLLA_radii(A.x, A.y, A.z); // [lat_rad, lon_rad, altitude_m]
    const geodeticAlt = lla[2];
    const localSurfaceRadius = A.length() - geodeticAlt;
    const horizonRadius = localSurfaceRadius + horizonAlt;

    // A is already in ECEF (origin at Earth center)
    // altAboveSphere = A.length() - horizonRadius = geodeticAlt - horizonAlt
    const observerR = A.length();
    const distToHorizon = Math.sqrt(observerR * observerR - horizonRadius * horizonRadius);

    const fwdNorm = fwd.clone().normalize();
    fwdNorm.multiplyScalar(distToHorizon);
    const horizonPoint = A.clone().add(fwdNorm)

    return horizonPoint;
}


// given a rotation matrix m, it's comprised of orthogonal x,y, and z basis vectors
// which define an object or camera orientation
// -z is the forward basis, meaning that it's the direction the camera is looking in
// x and y are rotated around the z-axis by the roll angle
// the roll angle is the angle or y from a vector orthogonal to z and pointing up
// find the angle the y basis vector is rotated around the z basis vector
// from a y-up orientation
export function extractRollFromMatrix(m) {
    const xBasis = V3();
    const yBasis = V3();
    const zBasis = V3();
    m.extractBasis(xBasis, yBasis, zBasis)
    xBasis.normalize()
    yBasis.normalize()
    zBasis.normalize()

    // right is orthogonal to the forward vector and the global up
    const right = zBasis.clone().cross(V3(0, 1, 0))

    // yUP is the y basis rotated upright
    const yUp = right.clone().cross(zBasis)

    // so calculate how much we rotated it
    let angle = yUp.angleTo(yBasis)

    // flip depending on which side of the plane defined by the right vector
    if (right.dot(yBasis) > 0)
        angle = -angle;

    return angle
}


// Given a point p. return the point on the globe below this, with an optional added altitude
// (essentially adjusting the MSL altitude of a point)
export function pointOnSphereBelow(p, altitude=0) {
    return setAltitudeMSL(p, altitude);
}

export function altitudeAboveSphere(p) {
    return altitudeMSL(p);
}

// given a position and a forward vector, return the Azimuth and Elevation (heading and pitch)
// Az and El are relative to the local north and up vectors at that position
// Az is degrees clockwise from north (0-360)
// El is degrees above horizontal (+90) or below horizontal (-90)

// NOTE, prior to 2.7.18, this function was backwards and was being using inconsistently
// with both forward and backward vectors (with local negating to compensate)

export function getAzElFromPositionAndForward(position, forward) {


    const up = getLocalUpVector(position);
    const north = getLocalNorthVector(position);

    // get the forward vector projected onto the horizontal plane defined by up
    const forwardH = forward.clone().sub(up.clone().multiplyScalar(forward.dot(up)));
    if (forwardH.lengthSq() < 1e-10) {
        return [0, forward.dot(up) > 0 ? 90 : -90];
    }
    forwardH.normalize();

    // same with the north vector (should already be horizontal, but ensure it)
    const northH = north.clone().sub(up.clone().multiplyScalar(north.dot(up))).normalize();

    // get the east vector (north × up gives east in EUS coordinates)
    const east = north.clone().cross(up);

    // calculate the heading using atan2 for proper quadrant handling
    // project forwardH onto north and east axes
    const forwardNorth = forwardH.dot(northH);
    const forwardEast = forwardH.dot(east);
    
    // atan2(east, north) gives angle clockwise from north
    // atan2(y, x) where x=north component, y=east component
    let heading = Math.atan2(forwardEast, forwardNorth);
    
    // convert to degrees and normalize to 0-360
    const headingDeg = heading * 180 / Math.PI;
    const headingPos = (headingDeg + 360) % 360;

    // calculate the elevation as the angle between the forward vector and the up vector
    const elevation = forward.angleTo(up);
    // elevation: 0° = up, 90° = horizontal, 180° = down
    // convert to standard elevation: -90° (down) to 0° (horizontal) to +90° (up)
    const elevationDeg = 90 - (elevation * 180 / Math.PI);
    return [headingPos, elevationDeg];
}


// given position and a vector, return the heading in radians relative to the north vector at that position
export function getCompassHeading(position, forward, camera) {

    // get local up vector, the headings are the angle about this axis.
    const up = getLocalUpVector(position);

    // get the north vector
    const north = getLocalNorthVector(position);

    // project the forward vector onto the horizontal plane defined by up
    const forwardH = forward.clone().sub(up.clone().multiplyScalar(forward.dot(up))).normalize();

    // same with the north vector (should already be horizontal, but ensure it)
    const northH = north.clone().sub(up.clone().multiplyScalar(north.dot(up))).normalize();

    // get the east vector (north × up gives east in EUS coordinates)
    const east = north.clone().cross(up);

    // calculate the heading using atan2 for proper quadrant handling
    const forwardNorth = forwardH.dot(northH);
    const forwardEast = forwardH.dot(east);
    
    // atan2(east, north) gives angle clockwise from north (in radians)
    let heading = Math.atan2(forwardEast, forwardNorth);

    // optional check for upside down camera
    if (camera) {
        // when we lock the up vector the camera can be upside down
        // so check the dot product with the local up vector and the camera's up vector
        // from the matrix
        const cameraUp = MV3(camera.matrixWorld.elements.slice(4, 7));

        if (up.dot(cameraUp) < 0) {
            heading = Math.PI - heading;
        }
    }

    return heading;

}

export function distanceToHorizon(h, r = Globals.equatorRadius) {
    return horizonDistance(h, r);
}

export function hiddenByGlobe(h, d, r = Globals.equatorRadius) {
    return hiddenBelowHorizon(h, d, r);
}