// BalloonLaunchFinder.js — the reverse of the balloon track (BalloonPhysics.js).
// There, the launch point is known: the balloon goes up at its buoyancy, and
// the wind of each height moves it. Here, the balloon is at a known point, or
// on a line of sight from the camera, and the question is where it left the
// ground.
//
// The flight is followed back in time: down at the buoyancy and against the
// wind of each height, until the path meets the ground.
//
// The buoyancy and the wind direction are not known well, and on a line of
// sight the distance is not known. So the answer is an area on the ground, not
// a point: the functions below give the launch sites for a range of each.
//
// The ground and the wind are injected, so Jest can test this with no terrain
// and no node graph.

import {ECEFToLLA_radii} from "./LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {midpointRangeFromAngularSize} from "./AngularSizeMath";
import {niceSizes} from "./KiteAnchorFinder";

const DEGREES = 180 / Math.PI;
const LIGHT_AIR = 0.5;          // m/s: the wind text of a lighter air is "Calm"
const HEIGHT_STEPS = 32;        // a flight goes down in about this number of steps, when the caller gives no number
const LEAST_STEP = 5;           // m: the smallest of those steps
const MOST_HEIGHTS = 4;         // a flight can go down by this number of heights, for a launch site that is far below the ground under the balloon
const BUOYANCY_STEPS = 4;       // parts that the buoyancy range is divided into (even, so that the middle is a step)
const TURN_STEPS = 2;           // parts of each end of an outline, between the two wind directions
const LIMIT_PASSES = 6;         // the most flights to find the buoyancy whose flight takes the time limit
const LIMIT_NEAR = 0.002;       // that buoyancy is found when a pass changes it by this part at most

// Follow the flight of a balloon back in time, from where it is to the ground.
//
//   position      where the balloon is: an ECEF Vector3
//   height        metres above the ground below it (it sets the size of the steps)
//   buoyancy      m/s: how fast the balloon rises
//   windTurn      radians: the wind of each height is turned by this, to the right as seen from above
//   heightSteps   the number of steps from the balloon down to the ground below it. With more
//                 steps, the flight follows the change of the wind with the height more closely
//   windAt        (lat, lon, altitudeHAE) → {u, v} in m/s (u = east, v = north)
//   groundHit     (origin, direction, maxDistance) → the first point of that ray which is on the
//                 ground, as an ECEF Vector3, or null. In Sitrec this is raycastGroundElevationFast
//   withPath      true to get the points of the flight
//
// Returns {position, lat, lon, groundHAE, seconds, path}, or null when the
// balloon is in the ground. position is the launch site (an ECEF Vector3),
// seconds is the time from the launch to the balloon's position, and path is
// the points from the balloon down to the launch site (null without withPath).
//
// Each step goes down by a fixed height. Its wind is that of its middle height,
// at the place of the balloon at the top of the step.
export function reverseBalloonFlight({position, height, buoyancy, windTurn = 0, heightSteps = HEIGHT_STEPS, windAt, groundHit, withPath = false}) {
    if (!(height > 0) || !(buoyancy > 0)) return null;
    const step = Math.max(LEAST_STEP, height / heightSteps);
    const stepSeconds = step / buoyancy;
    const cos = Math.cos(windTurn), sin = Math.sin(windTurn);
    const path = withPath ? [position.clone()] : null;
    let point = position, seconds = 0;
    for (let count = 0; count < MOST_HEIGHTS * heightSteps; count++) {
        const lla = ECEFToLLA_radii(point.x, point.y, point.z);
        const wind = windAt(lla[0] * DEGREES, lla[1] * DEGREES, lla[2] - step / 2) ?? {u: 0, v: 0};
        const u = wind.u * cos + wind.v * sin, v = wind.v * cos - wind.u * sin;
        // back in time: against the wind, and down
        const next = point.clone()
            .addScaledVector(getLocalEastVector(point), -u * stepSeconds)
            .addScaledVector(getLocalNorthVector(point), -v * stepSeconds)
            .addScaledVector(getLocalUpVector(point), -step);
        const direction = next.clone().sub(point), length = direction.length();
        const hit = groundHit(point, direction.divideScalar(length), length);
        const reached = hit ? hit.distanceTo(point) : Infinity;
        if (reached <= length) {
            seconds += stepSeconds * reached / length;
            path?.push(hit);
            const site = ECEFToLLA_radii(hit.x, hit.y, hit.z);
            return {position: hit, lat: site[0] * DEGREES, lon: site[1] * DEGREES, groundHAE: site[2], seconds, path};
        }
        seconds += stepSeconds;
        path?.push(next);
        point = next;
    }
    return null;
}

// The buoyancies from the highest to the lowest, at equal steps of the flight
// time (which goes with 1 / buoyancy). The middle one is thus the one whose
// launch site is in the middle, in a wind that does not change with the height.
export function buoyancySteps(buoyancyMin, buoyancyMax, steps = BUOYANCY_STEPS) {
    const fast = 1 / buoyancyMax, slow = 1 / buoyancyMin;
    return Array.from({length: steps + 1}, (unused, index) => 1 / (fast + (slow - fast) * index / steps));
}

// A balloon at a point, and what is known there.
function balloonAt(position, {windAt, groundHAE}, more = {}) {
    const lla = ECEFToLLA_radii(position.x, position.y, position.z);
    const lat = lla[0] * DEGREES, lon = lla[1] * DEGREES, hae = lla[2];
    const wind = windAt(lat, lon, hae) ?? {u: 0, v: 0};
    const windSpeed = Math.hypot(wind.u, wind.v);
    return {
        ...more, balloon: position, lat, lon, hae,
        height: hae - groundHAE(lat, lon),
        windSpeed,
        windToward: windSpeed > LIGHT_AIR ? Math.atan2(wind.u, wind.v) : null,
    };
}

// The flights of one balloon position: `site` gives the launch site of a flight, and
// `rates` is the buoyancies of the result, from the highest to the lowest, in `steps` parts.
//
// A flight that takes longer than maxSeconds is not in the result. A balloon that rises
// more slowly has a longer flight. So when the flight of buoyancyMin is too long, the
// lowest buoyancy is the one whose flight takes maxSeconds, and point.limited is true.
// When the flight of buoyancyMax is too long also, there are no rates.
function flightsOf(point, {buoyancyMin, buoyancyMax, maxSeconds, ...flight}, steps) {
    const site = (buoyancy, windTurn, withPath = false) =>
        reverseBalloonFlight({position: point.balloon, height: point.height, buoyancy, windTurn, withPath, ...flight});
    // The flight time is the height above the launch site, divided by the buoyancy, and the
    // launch site is not known before the flight. So the first value is for the ground below
    // the balloon, and each next value is for the launch site that the value before it gives.
    // Over level ground the first flight is enough. The values come together more slowly
    // where the ground has a steep slope along the line of the launch sites.
    let slowest = Math.max(buoyancyMin, point.height / maxSeconds);
    for (let pass = 0; pass < LIMIT_PASSES; pass++) {
        const found = site(slowest, 0);
        if (!found) break;
        const next = Math.max(buoyancyMin, slowest * found.seconds / maxSeconds);
        const near = Math.abs(next - slowest) <= LIMIT_NEAR * slowest;
        slowest = next;
        if (near) break;
    }
    point.limited = slowest > buoyancyMin;
    return {site, rates: slowest <= buoyancyMax ? buoyancySteps(slowest, buoyancyMax, steps) : []};
}

// The launch site for the middle buoyancy and the wind as given, and the four
// corners: [highest buoyancy, wind turned left], [highest, right], [lowest, left], [lowest, right].
function addCorners(point, {windError, ...options}) {
    const {site, rates: [fast, middle, slow]} = flightsOf(point, options, 2);
    // with no rates, each of these is null
    point.center = site(middle, 0);
    point.corners = [site(fast, -windError), site(fast, windError), site(slow, -windError), site(slow, windError)];
    return point;
}

// All the launch sites of one balloon position: `spine` (the wind as given, for each
// buoyancy from the highest to the lowest, with the path of the middle one) and `loop`
// (ECEF points around all the launch sites, or null when a flight on it has no launch site).
function addOutline(point, {windError, ...options}) {
    const {site, rates} = flightsOf(point, options, BUOYANCY_STEPS);
    const middle = rates.length >> 1;
    point.buoyancies = rates;
    point.spine = rates.map((buoyancy, index) => site(buoyancy, 0, index === middle));
    point.center = point.spine[middle] ?? null;

    // Along the left side from the nearest launch site to the farthest, across the far
    // end, back along the right side, and across the near end.
    const loop = rates.map(buoyancy => site(buoyancy, -windError));
    for (let index = 1; index < TURN_STEPS; index++) loop.push(site(rates[rates.length - 1], windError * (2 * index / TURN_STEPS - 1)));
    for (let index = rates.length - 1; index >= 0; index--) loop.push(site(rates[index], windError));
    for (let index = TURN_STEPS - 1; index > 0; index--) loop.push(site(rates[0], windError * (2 * index / TURN_STEPS - 1)));
    point.loop = loop.every(found => found !== null) ? loop.map(found => found.position) : null;
    return point;
}

// The launch sites of a balloon at a known position.
//
//   position              where the balloon is: an ECEF Vector3
//   buoyancyMin/Max       m/s: how fast the balloon rises
//   windError             radians: the wind direction is this near to the one that windAt gives
//   maxSeconds            the longest flight: it cuts the slow end of the buoyancy range (see flightsOf)
//   heightSteps, windAt, groundHit     see reverseBalloonFlight
//   groundHAE             (lat, lon) → the height of the ground above the ellipsoid, metres
//
// Returns {samples: [], outlines: [one entry]}, in the form of balloonLaunchSitesOnSight.
export function balloonLaunchSitesOfObject({position, ...options}) {
    return {samples: [], outlines: [addOutline(balloonAt(position, options), options)]};
}

// The launch sites of a balloon on a line of sight, for a range of balloon sizes.
//
//   origin, direction     the line of sight: an ECEF Vector3, and a unit Vector3
//   angularSize           radians: the size of the object as the camera sees it
//   sizeMin, sizeMax      metres: the real size of the balloon
//   steps                 the number of parts that the size range is divided into
//   labelSizes            the sizes that get an outline (the default is niceSizes)
//   and the values of balloonLaunchSitesOfObject
//
// Returns {samples, outlines}. Each entry is a balloon on the line of sight:
//   size, range           metres: the size of the balloon, and its distance from the camera
//   balloon               ECEF Vector3
//   lat, lon, hae         of the balloon
//   height                metres above the ground below the balloon
//   windSpeed             m/s at the balloon
//   windToward            radians from north, or null in a calm
//   limited               true when maxSeconds cut the buoyancy range of this balloon
//   center                the launch site for the middle buoyancy and the wind as given
//                         (see reverseBalloonFlight), or null when there is none
// A sample also has:
//   corners               the launch sites for [highest buoyancy, wind turned left], [highest, right],
//                         [lowest, left], [lowest, right]. Each can be null
// An outline also has:
//   buoyancies            m/s, from the highest to the lowest. None when the flight of the
//                         highest buoyancy is longer than maxSeconds
//   spine                 the launch site for each of those, with the wind as given. Each can be
//                         null. The middle one is `center`, and it has the path of its flight
//   loop                  ECEF points around all the launch sites for that one size, or null
export function balloonLaunchSitesOnSight({origin, direction, angularSize, sizeMin, sizeMax, steps = 8, labelSizes, ...options}) {
    const balloonOfSize = size => {
        const range = midpointRangeFromAngularSize(angularSize, size);
        return balloonAt(origin.clone().addScaledVector(direction, range), options, {size, range});
    };
    const samples = [];
    for (let index = 0; index <= steps; index++) {
        samples.push(addCorners(balloonOfSize(sizeMin + (sizeMax - sizeMin) * index / steps), options));
    }
    const outlines = (labelSizes ?? niceSizes(sizeMin, sizeMax)).map(size => addOutline(balloonOfSize(size), options));
    return {samples, outlines};
}
