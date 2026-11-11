// KitePhysics.js — pure bake of the simulated kite track (CNodeKiteTrack, "Add
// Kite" in the ground context menu). The wind sampler is injected, so Jest can
// test it with a synthetic wind and no node graph.
//
// On every frame the wind gives the kite a balance position (solveKiteLine in
// tools/vehicles/kiteFlight.js), where lift, drag, weight and the pull of the
// line are in balance. The kite moves toward that position at a limited speed.
// It has no other dynamics. The wind changes with the wind source and with the
// seeded gusts.

import {LLAToECEF} from "./LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {mulberry32} from "./DifferentialEvolution";
import {solveKiteLine} from "../tools/vehicles/kiteFlight.js";

const LIGHT_AIR = 0.5;      // m/s
// The fastest that a kite moves toward its balance position, as a fraction of
// the wind speed, and the least value of that speed (a kite also sinks in a
// calm). Both are estimates: a single-line kite moves across the sky at less
// than the wind speed.
const KITE_SPEED_FRACTION = 0.5;
const KITE_LEAST_SPEED = 1;     // m/s

// The local frame at the anchor, for the bake and for drawing the line.
export function kiteAnchorFrame(anchorLat, anchorLon, anchorAltMSL, geoidOffset = meanSeaLevelOffset) {
    const anchor = LLAToECEF(anchorLat, anchorLon, anchorAltMSL + geoidOffset(anchorLat, anchorLon));
    return {anchor, east: getLocalEastVector(anchor), north: getLocalNorthVector(anchor), up: getLocalUpVector(anchor)};
}

// A point that is `distance` metres from the anchor on a bearing (radians from north) and `height` metres above it.
export function kitePointECEF(frame, bearing, distance, height) {
    return frame.anchor.clone()
        .addScaledVector(frame.east, Math.sin(bearing) * distance)
        .addScaledVector(frame.north, Math.cos(bearing) * distance)
        .addScaledVector(frame.up, height);
}

// Bake the kite's state for every frame.
//
// params:
//   anchorLat, anchorLon   degrees
//   anchorAltMSL           metres MSL, where the line is held
//   lineLength             metres
//   lineMassPerMetre       kg/m
//   lineDiameter           metres
//   properties             {massKg, areaM2, liftCoefficient, dragCoefficient}
//   variabilityPct         0..100: gust size as a percentage of the wind speed
//                          (plus a 0.5 m/s floor); smooth seeded gusts re-target
//                          every 3-8 s, the same model as the balloon track
//   seed                   PRNG seed: the same seed gives the same flight
//   frames, dt             frame count, and sim seconds per frame
//   geoidOffset            (lat, lon) → geoid undulation in metres
//
// windAt(lat, lon, altMSL, f) → {u, v} wind in m/s (u = east, v = north).
//
// Returns an array of {position, kite} of length frames. position is an ECEF
// Vector3. kite holds:
//   windSpeed    m/s at the kite, with the gust
//   windToward   bearing the wind blows toward, radians from north
//   air          metres of wind that passed the kite before this frame
//   flying       false when the kite is on the ground
//   height       metres above the anchor
//   downwind     metres from the anchor, horizontally
//   bearing      bearing of the kite from the anchor, radians from north. It is
//                windToward once the kite has reached its balance position
//   lineAngle    radians above the horizontal, of the line at the kite
//   tension      N, the pull of the line at the kite
export function integrateKiteStates(params, windAt) {
    const {
        anchorLat, anchorLon,
        anchorAltMSL = 0,
        lineLength,
        lineMassPerMetre = 0,
        lineDiameter = 0,
        properties,
        variabilityPct = 0,
        seed = 1,
        frames,
        dt,
        geoidOffset = meanSeaLevelOffset,
    } = params;

    const rand = mulberry32((seed >>> 0) || 1);
    const frame = kiteAnchorFrame(anchorLat, anchorLon, anchorAltMSL, geoidOffset);
    const out = new Array(frames);

    let gustU = 0, gustV = 0;
    let targetGustU = 0, targetGustV = 0;
    let nextGust = 0;
    let windToward = 0;
    let air = 0;
    // The kite, in metres east, north and up of the anchor.
    let kite = null;

    for (let f = 0; f < frames; f++) {
        const t = f * dt;
        // The wind at the kite's own height. On the first frame the kite starts at its balance
        // position, and its height sets the wind that it meets, so solve that a few times.
        let line, windSpeed;
        for (let pass = 0; pass < (f === 0 ? 8 : 1); pass++) {
            const wind = windAt(anchorLat, anchorLon, anchorAltMSL + (kite ? kite.u : lineLength * 0.5), f) || {u: 0, v: 0};

            if (variabilityPct > 0 && pass === 0) {
                if (t >= nextGust) {
                    const speed = Math.hypot(wind.u, wind.v);
                    const size = (variabilityPct / 100) * (speed + 0.5) * (0.3 + 0.7 * rand());
                    const direction = rand() * 2 * Math.PI;
                    targetGustU = Math.cos(direction) * size;
                    targetGustV = Math.sin(direction) * size;
                    nextGust = t + 3 + rand() * 5;
                }
                const blend = Math.min(1, dt / 2);
                gustU += (targetGustU - gustU) * blend;
                gustV += (targetGustV - gustV) * blend;
            }

            const u = wind.u + gustU, v = wind.v + gustV;
            windSpeed = Math.hypot(u, v);
            // Air lighter than this does not turn the kite: it stays where the last wind left it.
            // On the first frame, a light wind still gives the side of the anchor it lies on.
            if (windSpeed > LIGHT_AIR) windToward = Math.atan2(u, v);
            else if (f === 0 && Math.hypot(wind.u, wind.v) > 1e-6) windToward = Math.atan2(wind.u, wind.v);
            line = solveKiteLine({windSpeed, lineLength, lineMassPerMetre, lineDiameter, properties, withPoints: false});

            const balance = {e: Math.sin(windToward) * line.downwind, n: Math.cos(windToward) * line.downwind, u: line.height};
            if (f === 0) {
                kite = balance;
            } else {
                const reach = Math.max(KITE_LEAST_SPEED, KITE_SPEED_FRACTION * windSpeed) * dt;
                const de = balance.e - kite.e, dn = balance.n - kite.n, du = balance.u - kite.u;
                const distance = Math.hypot(de, dn, du);
                const part = distance > reach ? reach / distance : 1;
                kite = {e: kite.e + de * part, n: kite.n + dn * part, u: kite.u + du * part};
            }
        }

        const downwind = Math.hypot(kite.e, kite.n);
        const bearing = downwind > 1e-9 ? Math.atan2(kite.e, kite.n) : windToward;
        out[f] = {
            position: kitePointECEF(frame, bearing, downwind, kite.u),
            kite: {windSpeed, windToward, air, flying: line.flying || kite.u > 0.01, height: kite.u, downwind, bearing,
                lineAngle: line.lineAngleAtKite, tension: line.tension},
        };
        air += windSpeed * dt;
    }
    return out;
}
