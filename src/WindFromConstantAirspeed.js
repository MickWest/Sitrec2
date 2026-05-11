// Estimate a single constant base wind vector that best explains a camera
// track's ground-velocity variation under the assumption that the camera
// is flying at approximately constant true airspeed.
//
// Geometry: in a horizontal local-ENU frame, ground velocity = air velocity
// + wind velocity. If |air velocity| is constant, the ground-velocity points
// trace a circle of that radius centered on the wind vector. We find the
// wind vector that minimizes the standard deviation of |groundV - windV|
// across all sampled frames.
//
// Two-pass approach:
//   1. Seed: wind FROM = opposite of camera heading at maximum ground speed
//            (tailwind heading flipped 180°), magnitude = (max-min)/2 of the
//            ground-speed range.
//   2. Refine: small genetic algorithm in (fromDeg, knots) space.

import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {Sit} from "./Globals";
import {V3} from "./threeUtils";
import {degrees, knotsFromMetersPerSecond, radians} from "./utils";

// Build per-frame ground-velocity samples projected onto a single local-ENU
// frame fixed at the track centroid. For short tracks (a few km, a few
// minutes) the local frame doesn't rotate appreciably, so a single reference
// frame is accurate enough and keeps the inner loops cheap.
function sampleGroundVelocities(track, startFrame, endFrame, frameStep) {
    const fps = Sit.fps || 30;

    let centerPos = track.p(Math.floor((startFrame + endFrame) / 2));
    const up = getLocalUpVector(centerPos);
    const north = getLocalNorthVector(centerPos);
    const east = V3().crossVectors(up, north).normalize();

    const samples = [];
    for (let f = startFrame; f < endFrame; f += frameStep) {
        const p0 = track.p(f);
        const p1 = track.p(f + 1);
        const v = p1.clone().sub(p0).multiplyScalar(fps); // m/s in ECEF
        // Project to horizontal at the reference frame
        v.sub(up.clone().multiplyScalar(v.dot(up)));
        samples.push({
            e: v.dot(east),
            n: v.dot(north),
            speed: Math.hypot(v.dot(east), v.dot(north)),
        });
    }
    return samples;
}

// Standard deviation of |groundV - windV| across all samples — lower is
// flatter (closer to constant airspeed).
function airspeedStdDev(samples, fromDeg, speedMs) {
    // Compass "from" → wind vector in ENU. Wind blows TO bearing (from+180),
    // so the east/north components carry a negative sign relative to the
    // FROM angle. Matches CNodeWind.getValueFrame, which rotates +north by
    // (180-from) around +up under right-hand rule (CCW from above).
    const fromRad = radians(fromDeg);
    const we = -Math.sin(fromRad) * speedMs;
    const wn = -Math.cos(fromRad) * speedMs;

    let sum = 0;
    let sumSq = 0;
    for (const s of samples) {
        const de = s.e - we;
        const dn = s.n - wn;
        const a = Math.hypot(de, dn);
        sum += a;
        sumSq += a * a;
    }
    const n = samples.length;
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    return Math.sqrt(variance);
}

// Take the shorter circular path when blending two compass bearings.
function circularBlend(a, b, t) {
    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    let r = a + diff * t;
    r = ((r % 360) + 360) % 360;
    return r;
}

function tournament(pop) {
    const a = pop[(Math.random() * pop.length) | 0];
    const b = pop[(Math.random() * pop.length) | 0];
    return a.cost <= b.cost ? a : b;
}

// Refine (fromDeg, speedMs) by GA. Seeds half the population around the
// physical seed and half uniformly in the plausible range. Linearly cooling
// mutation lets early generations explore widely and late ones polish.
function refineGA(samples, seedFromDeg, seedSpeedMs, maxGroundMs) {
    const popSize = 40;
    const generations = 60;
    const elites = 4;
    const speedCap = Math.max(maxGroundMs, seedSpeedMs * 2, 5);

    let pop = [];
    for (let i = 0; i < popSize; i++) {
        let fromDeg;
        let speedMs;
        if (i < popSize / 2) {
            fromDeg = seedFromDeg + (Math.random() - 0.5) * 60;
            speedMs = seedSpeedMs + (Math.random() - 0.5) * Math.max(2, seedSpeedMs);
        } else {
            fromDeg = Math.random() * 360;
            speedMs = Math.random() * speedCap;
        }
        fromDeg = ((fromDeg % 360) + 360) % 360;
        speedMs = Math.max(0, speedMs);
        pop.push({fromDeg, speedMs, cost: airspeedStdDev(samples, fromDeg, speedMs)});
    }
    pop.sort((a, b) => a.cost - b.cost);

    for (let g = 0; g < generations; g++) {
        const next = pop.slice(0, elites).map(e => ({...e}));
        const mutScale = Math.max(0.05, 1 - g / generations);

        while (next.length < popSize) {
            const a = tournament(pop);
            const b = tournament(pop);
            const t = Math.random();
            let fromDeg = circularBlend(a.fromDeg, b.fromDeg, t);
            let speedMs = a.speedMs * (1 - t) + b.speedMs * t;
            fromDeg += (Math.random() - 0.5) * 40 * mutScale;
            speedMs += (Math.random() - 0.5) * 4 * mutScale;
            fromDeg = ((fromDeg % 360) + 360) % 360;
            speedMs = Math.max(0, Math.min(speedCap, speedMs));
            next.push({fromDeg, speedMs, cost: airspeedStdDev(samples, fromDeg, speedMs)});
        }
        next.sort((a, b) => a.cost - b.cost);
        pop = next;
    }
    return pop[0];
}

export function estimateWindFromConstantAirspeed(track, options = {}) {
    const startFrame = Math.max(0, options.startFrame ?? 0);
    const endFrame = Math.min(Sit.frames - 1, options.endFrame ?? (Sit.frames - 1));
    const frameStep = Math.max(1, options.frameStep ?? 1);
    if (endFrame - startFrame < 4) return null;

    const samples = sampleGroundVelocities(track, startFrame, endFrame, frameStep);
    if (samples.length < 4) return null;

    let maxSpeed = -Infinity;
    let minSpeed = Infinity;
    let eAtMax = 0;
    let nAtMax = 0;
    for (const s of samples) {
        if (s.speed > maxSpeed) {
            maxSpeed = s.speed;
            eAtMax = s.e;
            nAtMax = s.n;
        }
        if (s.speed < minSpeed) minSpeed = s.speed;
    }
    // Compass heading of travel at peak ground speed (0 = north, 90 = east).
    const travelDeg = (degrees(Math.atan2(eAtMax, nAtMax)) + 360) % 360;
    // Wind blows TO that heading, so it comes FROM the opposite.
    const seedFromDeg = (travelDeg + 180) % 360;
    const seedSpeedMs = Math.max(0, (maxSpeed - minSpeed) / 2);

    const best = refineGA(samples, seedFromDeg, seedSpeedMs, maxSpeed);

    return {
        from: best.fromDeg,
        knots: knotsFromMetersPerSecond(best.speedMs),
        seedFrom: seedFromDeg,
        seedKnots: knotsFromMetersPerSecond(seedSpeedMs),
        finalCost: best.cost,
        finalCostKnots: knotsFromMetersPerSecond(best.cost),
        sampleCount: samples.length,
        groundSpeedRangeKnots: knotsFromMetersPerSecond(maxSpeed - minSpeed),
    };
}
