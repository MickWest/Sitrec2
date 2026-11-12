// KitePhysics.js — pure bake of the simulated kite track (CNodeKiteTrack, "Add
// Kite" in the ground context menu). The wind sampler is injected, so Jest can
// test it with a synthetic wind and no node graph.
//
// On every frame the wind gives the kite a balance position (solveKiteLine in
// tools/vehicles/kiteFlight.js), where lift, drag, weight and the pull of the
// line are in balance. The kite follows that position with a delay. It has no
// other dynamics. The wind changes with the wind source and with the seeded
// gusts.

import {LLAToECEF} from "./LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {mulberry32} from "./DifferentialEvolution";
import {solveKiteLine} from "../tools/vehicles/kiteFlight.js";

const LIGHT_AIR = 0.5;      // m/s

// THE GUSTS. Wind Variability is the turbulence intensity: the standard
// deviation of the along-wind gust as a percentage of the wind speed. The
// values below are those of the Kaimal turbulence model in the wind-turbine
// standard IEC 61400-1.
//
// A gust is a body of faster or slower air that the wind carries past the kite.
// So a gust lasts for its length divided by the wind speed. The length goes
// with the height above the ground, up to 60 m.
const CROSSWIND_GUST_RATIO = 0.8;       // crosswind gusts are this fraction of the along-wind gusts
const GUST_LENGTH_ALONG = 8.1 * 0.7;    // length of the along-wind gusts, as a multiple of the height
const GUST_LENGTH_CROSS = 2.7 * 0.7;    // length of the crosswind gusts, as a multiple of the height
const GUST_LEAST_HEIGHT = 10;           // m: the gusts do not become shorter below this height (a floor, not from the standard)
const GUST_MOST_HEIGHT = 60;            // m: the gusts do not become longer above this height
// A kite does not answer to a gust that is much shorter than this (seconds).
// It is an estimate, and it also keeps the wind free of frame-to-frame jitter.
const GUST_SMOOTHING = 1;

// THE RESPONSE OF THE KITE. A kite that is away from its balance position
// flies toward it, and its speed goes with the distance. The reason: a kite
// that moves across the wind at speed w meets a wind that is turned by the
// angle w / windSpeed, and the line of a light kite points along the wind that
// the kite meets. So a kite that is the angle a to one side moves back at
// a × windSpeed. The distance thus becomes smaller by the same fraction in each
// second, and the time for that is the horizontal distance from the anchor to
// the kite, divided by the wind speed: the time that the wind takes to go from
// the anchor to the kite. The same holds for a kite above or below its balance
// height. This is a simple model, not a measurement.
//
// KITE_SPEED_FRACTION is the fastest that a kite moves across the sky, as a
// fraction of the wind speed. KITE_LEAST_SPEED is the least speed at which a
// kite sinks when the wind is too light to hold it. Both are estimates.
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
//   variabilityPct         turbulence intensity: the standard deviation of the
//                          along-wind gust as a percentage of the wind speed.
//                          About 10 over open flat ground, 20 among trees and houses
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
//
// THE MEAN OF THE GUSTS. The wind of the wind source is the wind during the
// sitch, so the gusts must move the wind about it. But a gust can last longer
// than a short sitch: in 30 seconds, one slow gust holds the wind to one side
// for the whole sitch, and the kite then flies as if the wind came from a
// different direction. So the gusts are made with a mean of zero over the
// frames of the sitch: the part of the gusts that is slower than the sitch is
// removed, and the faster part stays.
//
// The bake has three steps. First the kite flies in the wind of the wind source
// with no gusts. Then the gusts are made for that flight, because how long a
// gust lasts goes with the height of the kite and with the wind speed. Then the
// kite flies in those gusts. (To take the gust heights from a flight WITH gusts
// does not work: a gust that holds the kite up for the whole sitch then sets
// the length of the gusts for a kite that, with the mean taken out, flies lower.)
//
// In the gusts, the kite starts where the wind of the wind source puts it. It
// does not start in balance with the gust of the first frame. A kite follows a
// gust with a delay, which can be as long as a short sitch, so it would stay
// near that first position, to one side, for most of the frames.
export function integrateKiteStates(params, windAt) {
    const steady = flyKite(params, windAt, null, null);
    if (!(params.variabilityPct > 0)) return steady;
    const {bearing, downwind, height} = steady[0].kite;
    const start = {e: Math.sin(bearing) * downwind, n: Math.cos(bearing) * downwind, u: height};
    return flyKite(params, windAt, makeGusts(params, steady), start);
}

// The along-wind and the crosswind gust for each frame, each as a multiple of
// its standard deviation, and each with a mean of zero over the frames.
// `steady` is the flight with no gusts.
function makeGusts({seed = 1, frames, dt}, steady) {
    const rand = mulberry32((seed >>> 0) || 1);
    // A random number with a normal distribution: mean 0, standard deviation 1.
    const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    // `raw` is the random process and `smooth` follows it. `sizes` is the gust on each frame.
    const gusts = [GUST_LENGTH_ALONG, GUST_LENGTH_CROSS].map(length => {
        const raw = normal();
        return {length, raw, smooth: raw, sizes: new Float64Array(frames)};
    });
    for (let f = 0; f < frames; f++) {
        const height = Math.max(GUST_LEAST_HEIGHT, Math.min(GUST_MOST_HEIGHT, steady[f].kite.height));
        for (const gust of gusts) {
            // How long a gust lasts. Each frame keeps a part of the last
            // value and adds a new random part, so the size of the gusts
            // does not change with the frame rate.
            const lasts = gust.length * height / Math.max(steady[f].kite.windSpeed, LIGHT_AIR);
            const keep = Math.exp(-dt / lasts);
            gust.raw = gust.raw * keep + Math.sqrt(1 - keep * keep) * normal();
            gust.smooth += (gust.raw - gust.smooth) * (1 - Math.exp(-dt / GUST_SMOOTHING));
            // The smoothing takes a little from the size of the gusts: put it back.
            gust.sizes[f] = gust.smooth * Math.sqrt(1 + GUST_SMOOTHING / lasts);
        }
    }
    return gusts.map(({sizes}) => {
        const mean = sizes.reduce((sum, size) => sum + size, 0) / Math.max(1, frames);
        return sizes.map(size => size - mean);
    });
}

// Fly the kite: its state for every frame (see integrateKiteStates). `gusts` is
// null for no gusts, or the result of makeGusts. `start` is the kite on the
// first frame, in metres {e, n, u} from the anchor, or null to start it at its
// balance position in the wind of that frame.
function flyKite(params, windAt, gusts, start) {
    const {
        anchorLat, anchorLon,
        anchorAltMSL = 0,
        lineLength,
        lineMassPerMetre = 0,
        lineDiameter = 0,
        properties,
        variabilityPct = 0,
        frames,
        dt,
        geoidOffset = meanSeaLevelOffset,
    } = params;

    const frame = kiteAnchorFrame(anchorLat, anchorLon, anchorAltMSL, geoidOffset);
    const out = new Array(frames);
    let windToward = 0;
    let air = 0;
    // The kite, in metres east, north and up of the anchor.
    let kite = start ? {...start} : null;

    for (let f = 0; f < frames; f++) {
        // The wind at the kite's own height. A kite with no given start is at its balance position
        // on the first frame, and its height sets the wind that it meets, so solve that a few times.
        let line, windSpeed;
        for (let pass = 0; pass < (f === 0 && !start ? 8 : 1); pass++) {
            const wind = windAt(anchorLat, anchorLon, anchorAltMSL + (kite ? kite.u : lineLength * 0.5), f) || {u: 0, v: 0};

            const baseSpeed = Math.hypot(wind.u, wind.v);
            // The gusts are along and across the wind of the wind source.
            let u = wind.u, v = wind.v;
            if (gusts && baseSpeed > 1e-6) {
                const sigma = (variabilityPct / 100) * baseSpeed;
                const along = sigma * gusts[0][f] / baseSpeed, across = sigma * CROSSWIND_GUST_RATIO * gusts[1][f] / baseSpeed;
                u += wind.u * along - wind.v * across;
                v += wind.v * along + wind.u * across;
            }
            windSpeed = Math.hypot(u, v);
            // Air lighter than this does not turn the kite: it stays where the last wind left it.
            // On the first frame, a light wind still gives the side of the anchor it lies on.
            if (windSpeed > LIGHT_AIR) windToward = Math.atan2(u, v);
            else if (f === 0 && baseSpeed > 1e-6) windToward = Math.atan2(wind.u, wind.v);
            line = solveKiteLine({windSpeed, lineLength, lineMassPerMetre, lineDiameter, properties, withPoints: false});

            const balance = {e: Math.sin(windToward) * line.downwind, n: Math.cos(windToward) * line.downwind, u: line.height};
            if (f === 0) {
                if (!start) kite = balance;
            } else {
                const de = balance.e - kite.e, dn = balance.n - kite.n, du = balance.u - kite.u;
                const distance = Math.hypot(de, dn, du);
                if (distance > 0) {
                    // The time that the wind takes to go from the anchor to the kite.
                    const delay = Math.max(1, Math.hypot(kite.e, kite.n)) / Math.max(windSpeed, LIGHT_AIR);
                    let reach = Math.min(distance * (1 - Math.exp(-dt / delay)), KITE_SPEED_FRACTION * windSpeed * dt);
                    // A kite that the wind cannot hold sinks, in a calm also.
                    if (!line.flying) reach = Math.max(reach, KITE_LEAST_SPEED * dt);
                    const part = Math.min(1, reach / distance);
                    kite = {e: kite.e + de * part, n: kite.n + dn * part, u: kite.u + du * part};
                }
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
