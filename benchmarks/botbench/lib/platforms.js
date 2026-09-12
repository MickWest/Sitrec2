// platforms.js — the eight fixed-wing sensor paths (PLAN.md "Platform
// configurations"), analytic/integrated in the scenario ENU frame.
//
// Frame convention (documented in PLAN.md): ENU origin is the target's initial
// ground reference point; z is height above the (flat-proxy) site ground. The
// platform starts at [0, -R, altitudeAGL] so the target initially bears NORTH.
//
// Feasibility contract: every path must satisfy R_turn >= v^2 / (g tan 30deg).
// Generation FAILS LOUDLY (throws) rather than silently altering speed/bank;
// the feasibility record is still returned on success for the scenario object.

const G = 9.80665;
const DEG = Math.PI / 180;
export const PHI_MAX_DEG = 30;

function minAllowedRadius(speedMS) {
    return (speedMS * speedMS) / (G * Math.tan(PHI_MAX_DEG * DEG));
}

// Circular path around center [cx, cy] with radius r, starting at [sx, sy],
// CCW at angular rate omega = v/r.
function fillOrbit(pos, n, times, cx, cy, r, sx, sy, z, speedMS) {
    const a0 = Math.atan2(sy - cy, sx - cx);
    const omega = speedMS / r;
    for (let f = 0; f < n; f++) {
        const a = a0 + omega * times[f];
        pos[f * 3] = cx + r * Math.cos(a);
        pos[f * 3 + 1] = cy + r * Math.sin(a);
        pos[f * 3 + 2] = z;
    }
    return r;
}

// Integrate a banked path: heading psi (compass radians, 0 = north, +CW),
// psiDot = (g/v) tan(bank(t)). Substepped Euler is deterministic and accurate
// enough at 20 substeps/frame for these smooth bank profiles.
function fillBanked(pos, n, times, fps, x0, y0, z, speedMS, psi0, bankAtT) {
    const SUB = 20;
    let x = x0, y = y0, psi = psi0;
    let minRadius = Infinity;
    pos[0] = x; pos[1] = y; pos[2] = z;
    for (let f = 1; f < n; f++) {
        const t0 = times[f - 1];
        const dtF = times[f] - times[f - 1];
        const h = dtF / SUB;
        for (let s = 0; s < SUB; s++) {
            const t = t0 + (s + 0.5) * h;
            const bank = bankAtT(t);
            const psiDot = (G / speedMS) * Math.tan(bank);
            if (Math.abs(psiDot) > 1e-9) {
                minRadius = Math.min(minRadius, speedMS / Math.abs(psiDot));
            }
            psi += psiDot * h;
            x += speedMS * Math.sin(psi) * h;
            y += speedMS * Math.cos(psi) * h;
        }
        pos[f * 3] = x;
        pos[f * 3 + 1] = y;
        pos[f * 3 + 2] = z;
    }
    return minRadius;
}

/**
 * The timing of a "racetrack" holding pattern: leg, turn, leg, turn, in
 * seconds, from the spec's speed, bank and leg length. The turn rate is the
 * coordinated-turn rate at the bank, psiDot = g tan(bank) / v, so a 180 degree
 * turn lasts pi / psiDot.
 */
export function racetrackSchedule(spec) {
    const v = spec.speedMS ?? 100;
    const bankRad = (spec.bankDeg ?? 25) * DEG;
    const legSeconds = spec.legSeconds ?? 90;
    const psiDot = (G / v) * Math.tan(bankRad);
    const turnSeconds = Math.PI / psiDot;
    const period = 2 * legSeconds + 2 * turnSeconds;
    return {v, bankRad, legSeconds, turnSeconds, psiDot, period,
        turnDir: spec.turnDir === -1 ? -1 : 1,
        headingRad: (spec.headingDeg ?? 0) * DEG,
        phaseSeconds: ((spec.phaseSeconds ?? 0) % period + period) % period};
}

/**
 * Where the pattern is at pattern time tau (seconds from the start of the
 * inbound leg): which segment, the heading, and the bank in force. Heading is
 * compass radians (0 = north, clockwise positive), the convention fillBanked
 * integrates.
 */
export function racetrackState(spec, tau) {
    const s = racetrackSchedule(spec);
    const t = ((tau % s.period) + s.period) % s.period;
    const dir = s.turnDir;
    if (t < s.legSeconds) {
        return {segment: "leg1", headingRad: s.headingRad, bankRad: 0, tau: t};
    }
    if (t < s.legSeconds + s.turnSeconds) {
        const dt = t - s.legSeconds;
        return {segment: "turn1", headingRad: s.headingRad + dir * s.psiDot * dt, bankRad: dir * s.bankRad, tau: t};
    }
    if (t < 2 * s.legSeconds + s.turnSeconds) {
        return {segment: "leg2", headingRad: s.headingRad + dir * Math.PI, bankRad: 0, tau: t};
    }
    const dt = t - (2 * s.legSeconds + s.turnSeconds);
    return {segment: "turn2", headingRad: s.headingRad + dir * Math.PI + dir * s.psiDot * dt,
        bankRad: dir * s.bankRad, tau: t};
}

/** The fraction of a clip of `durationSeconds` spent in the two turns. */
export function racetrackTurnFraction(spec, durationSeconds, step = 0.1) {
    const s = racetrackSchedule(spec);
    let turning = 0, total = 0;
    for (let t = 0; t < durationSeconds; t += step) {
        total++;
        if (racetrackState(spec, s.phaseSeconds + t).bankRad !== 0) turning++;
    }
    return total ? turning / total : 0;
}

// spec: {kind, speedMS=70, altitudeAGL=3000, rangeErrorFactor?, bankDeg?,
//        bankAmplitudeDeg?, bankPeriodSeconds?, and for "racetrack":
//        legSeconds?, phaseSeconds?, headingDeg?, turnDir?}
// Returns {positionENU: Float64Array(3n), feasibility}.
export function generatePlatformPath(spec, n, times, fps, initialHorizontalRangeM) {
    const v = spec.speedMS ?? 70;
    const z = spec.altitudeAGL ?? 3000;
    const R = initialHorizontalRangeM;
    const pos = new Float64Array(n * 3);
    const rMin = minAllowedRadius(v);
    let actualMinRadius = Infinity;

    switch (spec.kind) {
        case "orbit-point":
            // Orbit the target's initial ground point; radius = initial separation.
            actualMinRadius = fillOrbit(pos, n, times, 0, 0, R, 0, -R, z, v);
            break;

        case "orbit-direction": {
            // Orbit the position inferred from the initial LOS (due north) at
            // rangeErrorFactor x the true horizontal range.
            const f = spec.rangeErrorFactor;
            if (!(f > 0)) throw new Error("botbench: orbit-direction needs rangeErrorFactor > 0");
            const r = f * R;
            actualMinRadius = fillOrbit(pos, n, times, 0, -R + r, r, 0, -R, z, v);
            break;
        }

        case "orbit-ground": {
            // Orbit the point where the initial sightline meets the GROUND, at
            // a radius equal to the ground range. This is the surveillance
            // pattern an endurance platform actually flies: it circles a place
            // on the ground and stares at whatever is above it. The target
            // sits somewhere ALONG that sightline, not at its far end, so the
            // orbit centre is groundRangeM - R north of the sensor rather than
            // at the target's own ground point (which is what orbit-point
            // assumes). Giving the radius directly, instead of as a multiple of
            // the target range, keeps the geometry readable: the radius is the
            // ground range and nothing else.
            const rg = spec.groundRangeM;
            if (!(rg > 0)) throw new Error("botbench: orbit-ground needs groundRangeM > 0");
            if (!(rg >= R)) {
                throw new Error(`botbench: orbit-ground needs groundRangeM (${rg}) >= `
                    + `initialHorizontalRangeM (${R}) — the target lies between the `
                    + `sensor and the ground intercept, never beyond it`);
            }
            actualMinRadius = fillOrbit(pos, n, times, 0, -R + rg, rg, 0, -R, z, v);
            break;
        }

        case "curve": {
            // Initial course perpendicular to LOS (east); constant bank toward
            // the target (left turn, toward north).
            const bank = (spec.bankDeg ?? 10) * DEG;
            actualMinRadius = fillBanked(pos, n, times, fps, 0, -R, z, v,
                90 * DEG, () => -bank);   // negative bank => psiDot < 0 => east->north (CCW)
            break;
        }

        case "straight":
            for (let f = 0; f < n; f++) {
                pos[f * 3] = v * times[f];
                pos[f * 3 + 1] = -R;
                pos[f * 3 + 2] = z;
            }
            actualMinRadius = Infinity;
            break;

        case "racetrack": {
            // A standard holding pattern, entered at a random point: two
            // straight legs of legSeconds joined by two 180 degree turns at a
            // fixed bank, flown level. The clip is the window
            // [phaseSeconds, phaseSeconds + duration) of that pattern, so a
            // short clip may be all leg, all turn, or both, which is the
            // point of the kind: the platform's own motion decides how much
            // range information the clip carries, and a set that draws the
            // phase at random samples that honestly. Standard holds turn
            // right; turnDir -1 gives the non-standard left-hand hold.
            const st = racetrackSchedule(spec);
            const psi0 = racetrackState(spec, st.phaseSeconds).headingRad;
            actualMinRadius = fillBanked(pos, n, times, fps, 0, -R, z, v, psi0,
                (t) => racetrackState(spec, st.phaseSeconds + t).bankRad);
            break;
        }

        case "s-curve-toward":
        case "s-curve-perp": {
            const amp = (spec.bankAmplitudeDeg ?? 15) * DEG;
            const period = spec.bankPeriodSeconds ?? 12;
            const psi0 = spec.kind === "s-curve-toward" ? 0 : 90 * DEG;
            actualMinRadius = fillBanked(pos, n, times, fps, 0, -R, z, v, psi0,
                (t) => amp * Math.sin(2 * Math.PI * t / period));
            break;
        }

        default:
            throw new Error(`botbench: unknown platform kind "${spec.kind}"`);
    }

    const feasibility = {
        valid: actualMinRadius >= rMin * (1 - 1e-9),
        phiMaxDeg: PHI_MAX_DEG,
        minimumRadiusM: rMin,
        minimumActualRadiusM: actualMinRadius,
        offendingFrame: null,
    };
    if (!feasibility.valid) {
        throw new Error(`botbench: platform "${spec.kind}" infeasible: `
            + `min radius ${actualMinRadius.toFixed(0)} m < required ${rMin.toFixed(0)} m `
            + `(v=${v} m/s, phiMax=${PHI_MAX_DEG} deg)`);
    }
    return {positionENU: pos, feasibility};
}
