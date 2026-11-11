// KiteAnchorFinder.js — the reverse of the kite track (KitePhysics.js). There,
// the anchor is known and the wind gives the position of the kite. Here, the
// kite is on a line of sight from the camera, and the question is where its
// line is held on the ground.
//
//   1. The size of the object in the picture is an angle. That angle and a
//      real size give the distance, and thus a point on the line of sight.
//   2. A kite flies downwind of its anchor, and a straight line from the
//      anchor to the kite is at the flight angle above the horizontal. So the
//      anchor is upwind of the kite, where a line that goes down at the flight
//      angle meets the ground.
//
// The real size, the flight angle and the wind direction are not known well,
// so the answer is a band on the ground and not a point. kiteAnchorBand gives
// the anchors for a range of each.
//
// The ground and the wind are injected, so Jest can test this with no terrain
// and no node graph.

import {ECEFToLLA_radii} from "./LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {angleBetween, midpointRangeFromAngularSize} from "./AngularSizeMath";

const DEGREES = 180 / Math.PI;
const LIGHT_AIR = 0.5;          // m/s: lighter air than this does not hold a kite in one direction
const ARC_STEPS = 6;            // segments in each curved side of an outline

// The angle (radians) between the two ends of an object that is `pixels` wide
// in the picture, for a pinhole camera with a focal length of `focal` pixels.
// (x, y) is the middle of the object, in pixels from the middle of the picture.
// Away from the middle of the picture, the same number of pixels is a smaller angle.
export function pixelsToAngle(pixels, focal, x = 0, y = 0) {
    return angleBetween([x - pixels / 2, y, focal], [x + pixels / 2, y, focal]);
}

// Round sizes from `least` to `most` for the labels, the two limits included: `count` of them at most.
export function niceSizes(least, most, count = 6) {
    if (!(most > least)) return [least];
    for (let power = Math.floor(Math.log10(most - least)) - 2; ; power++) {
        for (const multiple of [1, 2, 5]) {
            const step = multiple * 10 ** power;
            // the multiples of the step between the limits, but not one that is almost on a limit
            const sizes = [];
            for (let index = Math.ceil(least / step + 0.3); index <= most / step - 0.3; index++) {
                sizes.push(Math.round(index * step * 1e6) / 1e6);
            }
            if (sizes.length + 2 <= count) return [least, ...sizes, most];
        }
    }
}

// The point on the ground where the line of a kite is held.
//
//   kite            ECEF Vector3
//   windToward      the bearing that the wind blows toward, radians from north
//   flightAngle     radians above the horizontal, of a straight line from the anchor to the kite
//   maxLineLength   metres: the longest line
//   groundHit       (origin, direction, maxDistance) → the FIRST point of that ray which is on
//                   the ground, as an ECEF Vector3, or null when there is none. In Sitrec this
//                   is raycastGroundElevationFast, which does not step over a narrow ridge
//
// Returns {position, lat, lon, groundHAE, distance, lineLength}, or null when
// the kite is in the ground, or when the line would be longer than
// maxLineLength. position is an ECEF Vector3 and distance is horizontal.
// lineLength is that of a straight line. A real line sags, so it is a little longer.
export function solveKiteAnchor({kite, windToward, flightAngle, maxLineLength, groundHit}) {
    // The line from the kite to its anchor, as a ray: upwind, and down at the flight angle.
    const direction = getLocalEastVector(kite).multiplyScalar(-Math.sin(windToward))
        .addScaledVector(getLocalNorthVector(kite), -Math.cos(windToward))
        .multiplyScalar(Math.cos(flightAngle))
        .addScaledVector(getLocalUpVector(kite), -Math.sin(flightAngle));
    const position = groundHit(kite, direction, maxLineLength);
    if (!position) return null;
    // A ground query can answer past the limit, and it answers with the start for a kite in the ground.
    const lineLength = position.distanceTo(kite);
    if (!(lineLength > 0) || lineLength > maxLineLength) return null;
    const lla = ECEFToLLA_radii(position.x, position.y, position.z);
    return {
        position,
        lat: lla[0] * DEGREES, lon: lla[1] * DEGREES, groundHAE: lla[2],
        distance: lineLength * Math.cos(flightAngle),
        lineLength,
    };
}

// The anchors of a kite on a line of sight, for a range of kite sizes, flight
// angles and wind directions.
//
//   origin, direction     the line of sight: an ECEF Vector3, and a unit Vector3
//   angularSize           radians: the size of the object as the camera sees it
//   sizeMin, sizeMax      metres: the real size of the same part of the kite
//   flightAngleMin/Max    radians above the horizontal
//   windError             radians: the wind direction is this near to the one that windAt gives
//   maxLineLength         metres
//   windAt                (lat, lon, altitudeHAE) → {u, v} in m/s (u = east, v = north)
//   groundHAE             (lat, lon) → the height of the ground above the ellipsoid, metres
//   groundHit             (origin, direction, maxDistance) → the first point of the ray on the
//                         ground, or null (see solveKiteAnchor)
//   steps                 the number of parts that the size range is divided into
//   labelSizes            the sizes that get an outline (the default is niceSizes)
//
// Returns {samples, outlines}. Each entry is a kite on the line of sight:
//   size, range           metres: the size of the kite, and its distance from the camera
//   kite                  ECEF Vector3
//   lat, lon, hae         of the kite
//   height                metres above the ground below the kite
//   windSpeed             m/s at the kite
//   windToward            radians from north, or null in a wind too light to hold a kite
//   center                the anchor for the middle flight angle and the wind as given
//                         (see solveKiteAnchor), or null when there is none
// A sample also has:
//   corners               the anchors for [lowest angle, wind turned left], [lowest, right],
//                         [highest, left], [highest, right]. Each can be null
// An outline also has:
//   loop                  ECEF points around all the anchors for that one size, or null
export function kiteAnchorBand({origin, direction, angularSize, sizeMin, sizeMax, flightAngleMin, flightAngleMax,
                                   windError, maxLineLength, windAt, groundHAE, groundHit, steps = 32, labelSizes}) {
    const flightAngleMid = (flightAngleMin + flightAngleMax) / 2;

    const kiteAt = size => {
        const range = midpointRangeFromAngularSize(angularSize, size);
        const kite = origin.clone().addScaledVector(direction, range);
        const lla = ECEFToLLA_radii(kite.x, kite.y, kite.z);
        const lat = lla[0] * DEGREES, lon = lla[1] * DEGREES, hae = lla[2];
        const wind = windAt(lat, lon, hae) ?? {u: 0, v: 0};
        const windSpeed = Math.hypot(wind.u, wind.v);
        return {
            size, range, kite, lat, lon, hae,
            height: hae - groundHAE(lat, lon),
            windSpeed,
            windToward: windSpeed > LIGHT_AIR ? Math.atan2(wind.u, wind.v) : null,
        };
    };
    // No anchor in a calm, or for a kite that is in the ground.
    const anchor = (point, flightAngle, windTurn) => point.windToward === null || !(point.height > 0) ? null
        : solveKiteAnchor({kite: point.kite, windToward: point.windToward + windTurn, flightAngle, maxLineLength, groundHit});

    const samples = [];
    for (let index = 0; index <= steps; index++) {
        const point = kiteAt(sizeMin + (sizeMax - sizeMin) * index / steps);
        point.center = anchor(point, flightAngleMid, 0);
        point.corners = [
            anchor(point, flightAngleMin, -windError), anchor(point, flightAngleMin, windError),
            anchor(point, flightAngleMax, -windError), anchor(point, flightAngleMax, windError),
        ];
        samples.push(point);
    }

    const outlines = (labelSizes ?? niceSizes(sizeMin, sizeMax)).map(size => {
        const point = kiteAt(size);
        point.center = anchor(point, flightAngleMid, 0);
        // Out along the far side (the lowest flight angle), and back along the near side.
        const loop = [];
        for (let index = 0; index <= ARC_STEPS; index++) {
            loop.push(anchor(point, flightAngleMin, windError * (2 * index / ARC_STEPS - 1)));
        }
        for (let index = ARC_STEPS; index >= 0; index--) {
            loop.push(anchor(point, flightAngleMax, windError * (2 * index / ARC_STEPS - 1)));
        }
        point.loop = loop.every(found => found !== null) ? loop.map(found => found.position) : null;
        return point;
    });

    return {samples, outlines};
}
