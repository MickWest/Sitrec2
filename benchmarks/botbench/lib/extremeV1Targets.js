// Prescribed stress trajectories. Limits are class composites, not a model of
// a particular airframe. Durations follow the limits rather than the output Hz.
const G = 9.80665;
const DEG = Math.PI / 180;
const clamp = u => Math.max(0, Math.min(1, u));
const blend = u => { u = clamp(u); return u ** 3 * (10 - 15 * u + 6 * u * u); };
const slope = u => u > 0 && u < 1 ? 30 * u * u * (1 - u) ** 2 : 0;
const integral = u => u <= 0 ? 0 : u >= 1 ? u - 0.5 : 2.5 * u ** 4 - 3 * u ** 5 + u ** 6;
const norm = a => Math.hypot(...a);
const plus = (a, b) => a.map((x, i) => x + b[i]);
const scale = (a, b) => a.map(x => x * b);
const direction = (heading, pitch) => [Math.cos(pitch) * Math.cos(heading), Math.cos(pitch) * Math.sin(heading), Math.sin(pitch)];

// Piecewise velocity ramps with an analytic position integral. Each vector
// transition reaches its requested inertial acceleration and preserves speed
// bounds because the velocity blend is a convex combination.
function velocityProgram(p, stages, initialVelocity = [0, 0, 0]) {
    let start = 2, from = initialVelocity;
    const ramps = stages.map(stage => {
        const delta = stage.to.map((x, i) => x - from[i]);
        const duration = 1.875 * norm(delta) / (p.accelerationG * G);
        const ramp = {start, duration, from, delta, phase: stage.phase};
        start += duration + (stage.hold ?? 0.4);
        from = stage.to;
        return ramp;
    });
    return {
        endSeconds: start,
        windows: ramps.map(r => ({startSeconds: r.start, endSeconds: r.start + r.duration, phase: r.phase})),
        state(t) {
            let position = [initialVelocity[0] * t, initialVelocity[1] * t, p.startAGL + initialVelocity[2] * t];
            let v = [...initialVelocity], a = [0, 0, 0];
            for (const r of ramps) {
                const u = (t - r.start) / r.duration;
                position = plus(position, scale(r.delta, r.duration * integral(u)));
                v = plus(v, scale(r.delta, blend(u)));
                a = plus(a, scale(r.delta, slope(u) / r.duration));
            }
            return {p: position, v, a};
        },
        details: {velocityStages: ramps, timing: "Quintic velocity ramps, with duration = 1.875 * |delta-v| / peak acceleration."},
    };
}

// Constant-speed heading/pitch changes. Smooth turn rate removes instantaneous
// velocity changes while the specified speed is maintained throughout a turn.
function angleProgram(p, stages) {
    let start = 2, heading = 0, pitch = (p.initialPitchDeg ?? 0) * DEG;
    const turns = stages.map(stage => {
        const dh = (stage.headingDeg ?? heading / DEG) * DEG - heading;
        const dp = (stage.pitchDeg ?? pitch / DEG) * DEG - pitch;
        // Heading and pitch transitions are separate in this catalogue.
        if (dh && dp) throw new Error("extreme-v1: simultaneous angle changes need a combined acceleration bound");
        const angularDistance = Math.abs(dp || dh * Math.cos(pitch));
        const duration = 1.875 * angularDistance * p.speedMS / (p.accelerationG * G);
        const turn = {start, duration, heading, pitch, dh, dp, phase: stage.phase};
        start += duration + (stage.hold ?? 0.4);
        heading += dh; pitch += dp;
        return turn;
    });
    return {
        endSeconds: start,
        windows: turns.map(r => ({startSeconds: r.start, endSeconds: r.start + r.duration, phase: r.phase})),
        state(t) {
            let h = 0, e = (p.initialPitchDeg ?? 0) * DEG, hd = 0, ed = 0;
            for (const r of turns) {
                const u = (t - r.start) / r.duration;
                h += r.dh * blend(u); e += r.dp * blend(u);
                hd += r.dh * slope(u) / r.duration; ed += r.dp * slope(u) / r.duration;
            }
            const c = Math.cos, s = Math.sin, v = p.speedMS;
            return {v: scale(direction(h, e), v), a: [
                v * (-s(e) * ed * c(h) - c(e) * s(h) * hd),
                v * (-s(e) * ed * s(h) + c(e) * c(h) * hd),
                v * c(e) * ed,
            ]};
        },
        details: {angleStages: turns, timing: "Constant speed; quintic angle transitions sized from the acceleration limit."},
    };
}

export function buildExtremeV1Motion(p) {
    const v = p.speedMS, motion = p.motion;
    if (motion === "ascent" || motion === "descent" || motion === "up-down-up") {
        const signs = motion === "ascent" ? [1] : motion === "descent" ? [-1] : [1, -1, 1];
        return velocityProgram(p, signs.flatMap(sign => [
            {to: [0, 0, sign * v], phase: sign > 0 ? "accelerate-up" : "accelerate-down"},
            {to: [0, 0, 0], phase: "vertical-stop", hold: 0.2},
        ]));
    }
    if (motion === "stop-reverse") return velocityProgram(p, [
        {to: [0, 0, 0], phase: "maximum-braking", hold: 0.2},
        {to: [-v, 0, 0], phase: "reverse-acceleration", hold: 1},
    ], [v, 0, 0]);
    if (motion === "brake-turn-reverse") {
        // Fixed-wing reversal retains forward flight: brake, turn at reduced
        // speed, then accelerate along the reciprocal heading.
        const low = v * p.minimumSpeedFraction, a = p.accelerationG * G;
        const ramp = 1.875 * (v - low) / a;
        const turn = 1.875 * Math.PI * low / a;
        const t1 = 2, t2 = t1 + ramp + 0.4, t3 = t2 + turn + 0.4;
        return {endSeconds: t3 + ramp,
            windows: [
                {startSeconds: t1, endSeconds: t1 + ramp, phase: "maximum-braking"},
                {startSeconds: t2, endSeconds: t2 + turn, phase: "reverse-heading"},
                {startSeconds: t3, endSeconds: t3 + ramp, phase: "reverse-acceleration"},
            ], state(t) {
                const u = (t - t1) / ramp, w = (t - t3) / ramp, q = (t - t2) / turn;
                const speed = v + (low - v) * blend(u) + (v - low) * blend(w);
                const sd = (low - v) * slope(u) / ramp + (v - low) * slope(w) / ramp;
                const h = Math.PI * blend(q), hd = Math.PI * slope(q) / turn;
                return {v: [speed * Math.cos(h), speed * Math.sin(h), 0],
                    a: [sd * Math.cos(h) - speed * Math.sin(h) * hd,
                        sd * Math.sin(h) + speed * Math.cos(h) * hd, 0]};
            }, details: {minimumSpeedMS: low, turnDeg: 180,
                note: "Brakes to 20% of maximum speed, turns, and accelerates back to maximum speed. No stationary hover or backward flight is assumed."}};
    }
    if (motion === "random-3d") {
        // Fixed seeded directions are stored in the generating spec, making the
        // complete path reproducible without relying on an output-rate seed.
        return velocityProgram(p, p.directions.map((d, i) => ({to: scale(d, v),
            phase: `random-maneuver-${i + 1}`, hold: 0.2})), [v, 0, 0]);
    }
    if (motion === "turn-90" || motion === "turn-180") return angleProgram(p, [
        {headingDeg: motion === "turn-90" ? 90 : 180, phase: motion},
    ]);
    if (motion === "climb" || motion === "dive") return angleProgram(p, [
        {pitchDeg: motion === "climb" ? p.pitchDeg : -p.pitchDeg, phase: motion, hold: 1},
        {pitchDeg: 0, phase: "level-out"},
    ]);
    if (motion === "weave-3d") return angleProgram(p, p.angleStages);
    if (motion === "straight") {
        const velocity = scale(direction(0, (p.initialPitchDeg ?? 0) * DEG), v);
        return {endSeconds: p.straightSeconds, windows: [{startSeconds: 0, endSeconds: p.straightSeconds, phase: "straight"}],
            state: t => ({p: [velocity[0] * t, velocity[1] * t, p.startAGL + velocity[2] * t], v: velocity, a: [0, 0, 0]}),
            details: {pitchDeg: p.initialPitchDeg ?? 0}};
    }
    if (motion === "shallow-turn") return angleProgram(p, [{headingDeg: p.turnDeg, phase: "shallow-turn"}]);
    throw new Error(`extreme-v1: unknown motion ${motion}`);
}

export function extremeV1Duration(parameters) {
    return Math.max(10, Math.ceil(buildExtremeV1Motion(parameters).endSeconds + 2));
}
