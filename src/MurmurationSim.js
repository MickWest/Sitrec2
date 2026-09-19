// MurmurationSim.js - a starling murmuration over its roost, simulated.
//
// The other flock formations (FlockModel.js) are pure functions of time. A murmuration
// cannot be: its shapes come from each bird reacting to its neighbors, moment by moment,
// so it is a simulation with state. It is run forward once, from before the start of the
// sitch to its end, and sampled; the timeline then reads the samples, so scrubbing works
// the same as for any other flock. See MurmurationTimeline, below.
//
// THE MODEL is StarDisplay: Hildenbrandt, Carere & Hemelrijk 2010, "Self-organized aerial
// displays of thousands of starlings: a model", Behavioral Ecology 21: 1349 (arXiv
// 0908.2677). It was chosen because it was checked against the measured starling flocks of
// Rome (Ballerini et al. 2008) and matched them in shape, density, orientation and the
// bearing of nearest neighbors. Equation numbers below are the paper's, and so are the
// values in Table 1 unless marked. Where the text of the paper is unclear, the reading used
// is written down beside it.
//
// What it reproduces, by the paper's own tests: aspect ratios 1 : 2-4 : 4-9, thickness
// against volume, density independent of flock size, no front/back imbalance, nearest
// neighbors to the side, equal-radius turns in which birds change place, and whole flocks
// tilting in a turn. What it does NOT: its flocks are too level (they change height less
// than real ones), and the density at the border is not higher than inside as it is in real
// flocks. It has no predator, so it has none of the waves of darkness that run through a
// flock under attack; those come from later work (Storms et al. 2019).
//
// Two places depart from the paper as printed, because as printed they did not work: the
// banking rule and the vertical pull to the roost. Both are explained where they are set.
//
// Axes are local to the roost: x east, y north, z up, meters, with the roost at the origin
// and z = 0 the height the birds prefer.

import {mulberry32} from "./DifferentialEvolution";

export const MURMURATION_DEFAULTS = {
    count: 1000,
    spacing: 1.1,           // wanted mean nearest-neighbor distance, meters
    cruiseSpeed: 10,        // v0, m/s
    roostRadius: 150,       // R_Roost, meters
    seed: 1,
};

// Table 1
const DT = 0.005;                   // integration time step, s
const REACTION_STEPS = 10;          // reaction time, 50 ms, in integration steps
const MASS = 0.08;                  // kg
const LIFT_DRAG = 3.3;              // C_L / C_D
const GRAVITY = 9.81;
const LIFT0 = MASS * GRAVITY;       // L0: lift at cruise speed carries the weight
const THRUST0 = LIFT0 / LIFT_DRAG;  // T0 = D0 (Equ. 15)
const SPEED_TAU = 1;                // speed control relaxation, s
const R_MAX = 100;                  // largest perception radius, m
const TOPOLOGICAL = 6.5;            // n_c, neighbors each bird tries to have
// s, the interpolation factor, is "0.1 du" in Table 1: 0.1 x 0.05 s = 0.005 per reaction.
// (Read as 0.1 per reaction, the radius jumps by 1.5 m for each neighbor gained or lost,
// several times the spacing; read this way it moves by 0.08 m.)
const INTERPOLATION = 0.1 * REACTION_STEPS * DT;
const HARD_SPHERE = 0.2;            // r_h: half a starling's wingspan
const W_SEPARATION = 1;             // N
const W_ALIGNMENT = 0.5;            // N
const W_COHESION = 1;               // N
const BLIND_COS = -Math.cos(Math.PI / 4);   // rear blind angle 2 x 45 deg, cohesion and alignment only
const W_NOISE = 0.01;               // N
const W_ROOST_H = 0.01;             // N per meter outside the roost

// THE VERTICAL PULL TO THE ROOST: A DEVIATION FROM TABLE 1, WHICH IS INCONSISTENT HERE.
// Table 1 gives w_RoostV = 0.2 "N", and Equ. 12 multiplies it by the vertical distance. Read
// as 0.2 N per meter, it squashed every flock into a sheet one bird thick (1.6 m, and
// 1 : 12 : 60) where Rome's flocks were 5 to 19 m thick and 1 : 2.8 : 5.6 (Ballerini et al.
// 2008), and the paper's own model flocks 4 to 13 m and 1 : 2-4 : 4-9 (its Table 2). The
// paper says this weight was tuned to give the flat shape observed, so it was tuned again
// here, against the same measurements: at 0.015 N per meter, flocks of 500 birds come out
// 4.6 m thick and 1 : 1.8 : 5.8, and of 2000 birds 6.3 m and 1 : 2.1 : 7.7. The thin axis
// stays within 10 degrees of vertical (|I1.G| 0.98-1.0; Rome 0.93, the paper's model 0.97).
const W_ROOST_V = 0.015;            // N per meter from the preferred height

// Centrality (Equ. 7) is measured over twice the perception radius, which reaches eight
// times as many birds as the steering does, and was most of the cost. A bird's place in the
// flock changes over seconds (Cavagna et al. 2013), so each bird's is measured every this
// many reactions, 0.2 s, in turn with the others. A choice for speed, not the paper's.
const CENTRALITY_EVERY = 4;

// BANKING: A DEVIATION FROM THE PAPER. Equations 19-21 as printed, tan(beta_in) =
// w_in a_l dt with w_in = 10, and tan(beta_out) = w_out sin(beta) dt with w_out = 1, settle
// where sin(beta) = 10 a_l: any sideways push above 0.1 m/s2 banks a bird past 90 degrees.
// Run as printed, the birds wobbled +/- 45 degrees ten times a second and some rolled right
// over. The paper's own account of a turn is a bank into it, a loss of lift and height, then
// a slow return to level flight (its Fig. 8). So here each bird rolls toward the bank at
// which its lift would give the sideways push it wants, tan(beta) = a_l / g, which is how a
// real turn is flown, rolling in ten times faster than it rolls out: the paper's 10 : 1.
const ROLL_IN = 10;                 // 1/s: an active roll, into a turn or across into the next
const ROLL_OUT = 1;                 // 1/s: back toward level

// The separation radius is what sets how far apart the birds end up; the paper tuned it
// flock by flock to match Rome (its Table 2), where NND rises with r_sep. This model, with
// its weaker vertical pull, packs a little tighter than the paper's did, so the curve was
// measured again on it: the mean distance to the nearest neighbor for each separation
// radius, over flocks of 1000 birds (two seeds, 40 s each, after the warm-up). The spacing
// asked for is turned into a radius by reading the curve backwards.
const NND_BY_SEPARATION = [[1.5, 0.465], [2, 0.628], [3, 0.863], [4, 1.094], [5.5, 1.36], [7, 1.579]];

export function separationRadiusFor(spacing) {
    const table = NND_BY_SEPARATION;
    let k = 0;
    while (k < table.length - 2 && spacing > table[k + 1][1]) k++;
    const [r0, s0] = table[k], [r1, s1] = table[k + 1];
    const radius = r0 + (spacing - s0) * (r1 - r0) / (s1 - s0);
    return Math.min(20, Math.max(2 * HARD_SPHERE, radius));
}

// The birds' start: a flock already formed, flying north at cruise speed, in a flattened
// ellipsoid of about the right density. (The paper released birds at random over the
// whole roost and let flocks form. Starting formed gives one murmuration from the first
// frame instead of several scraps; the warm-up then lets the flock become the model's own.)
function startPositions(sim, rand) {
    const n = sim.count;
    // A random (Poisson) scatter has a mean nearest-neighbor distance of 0.554 / cbrt(density).
    const volumePerBird = Math.pow(sim.spacing / 0.554, 3);
    // semi-axes a : b : c = 2.8 : 5.6 : 1 about (east, north, up), after Ballerini 2008
    const c = Math.cbrt(volumePerBird * n / (4 / 3 * Math.PI * 2.8 * 5.6));
    const a = 2.8 * c, b = 5.6 * c;
    for (let i = 0; i < n; i++) {
        let x, y, z;
        do {
            x = rand() * 2 - 1; y = rand() * 2 - 1; z = rand() * 2 - 1;
        } while (x * x + y * y + z * z > 1);
        sim.px[i] = x * a; sim.py[i] = y * b - 0.5 * sim.roostRadius; sim.pz[i] = z * c;
        sim.vx[i] = 0; sim.vy[i] = sim.cruise; sim.vz[i] = 0;
        sim.radius[i] = 3 * sim.spacing;
    }
}

export class MurmurationSim {
    constructor(params = {}) {
        const p = {...MURMURATION_DEFAULTS, ...params};
        const n = this.count = Math.max(2, Math.round(p.count));
        this.spacing = p.spacing;
        this.cruise = p.cruiseSpeed;
        this.roostRadius = p.roostRadius;

        this.separation = separationRadiusFor(p.spacing);
        // Equ. 4: g falls from 1 at the hard sphere to 0.01 at the separation radius.
        const sigma = (this.separation - HARD_SPHERE) / Math.sqrt(Math.log(100));
        this.invSigma2 = 1 / (sigma * sigma);
        this.rand = mulberry32((p.seed >>> 0) || 1);
        this.time = 0;
        this.step = 0;

        const f64 = () => new Float64Array(n);
        this.px = f64(); this.py = f64(); this.pz = f64();
        this.vx = f64(); this.vy = f64(); this.vz = f64();
        this.bank = f64();
        this.bankTarget = f64();
        this.radius = f64();
        // the steering force, held between reactions
        this.fx = f64(); this.fy = f64(); this.fz = f64();
        // unit forward of each bird, taken at each reaction
        this.ux = f64(); this.uy = f64(); this.uz = f64();
        this.neighbors = new Int32Array(n);         // |N_i|, for the tests
        this.centrality = new Float64Array(n).fill(1);   // until first measured: hold on

        // spatial hash for the neighbor search
        let size = 1;
        while (size < 2 * n) size *= 2;
        this.hashMask = size - 1;
        this.cellStart = new Int32Array(size + 1);
        this.fill = new Int32Array(size);
        this.cellX = new Int32Array(n); this.cellY = new Int32Array(n); this.cellZ = new Int32Array(n);
        this.hashOf = new Int32Array(n);
        this.order = new Int32Array(n);
        this.candidates = new Int32Array(n);
        this.candidateD2 = new Float64Array(n);
        this.buckets = new Int32Array(343);
        this.bucketStamp = new Int32Array(size);     // which search last took each bucket
        this.searches = 0;
        this.reactions = 0;

        startPositions(this, this.rand);
    }

    buildGrid(cell) {
        const n = this.count, inv = 1 / cell, mask = this.hashMask;
        const start = this.cellStart.fill(0);
        for (let i = 0; i < n; i++) {
            const cx = Math.floor(this.px[i] * inv), cy = Math.floor(this.py[i] * inv), cz = Math.floor(this.pz[i] * inv);
            this.cellX[i] = cx; this.cellY[i] = cy; this.cellZ[i] = cz;
            const h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) & mask;
            this.hashOf[i] = h;
            start[h + 1]++;
        }
        for (let h = 0; h <= mask; h++) start[h + 1] += start[h];
        this.fill.set(start.subarray(0, mask + 1));
        for (let i = 0; i < n; i++) this.order[this.fill[this.hashOf[i]]++] = i;
    }

    // The birds within `reach` of bird i, into this.candidates; returns how many.
    gather(i, reach, cell) {
        const n = this.count, mask = this.hashMask, reach2 = reach * reach;
        const xi = this.px[i], yi = this.py[i], zi = this.pz[i];
        const cand = this.candidates, candD2 = this.candidateD2;
        let found = 0;
        const span = Math.ceil(reach / cell);
        if (span > 3) {
            // a bird far from the rest: look at everyone
            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                const dx = this.px[j] - xi, dy = this.py[j] - yi, dz = this.pz[j] - zi;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= reach2) {
                    cand[found] = j; candD2[found++] = d2;
                }
            }
            return found;
        }
        // The buckets of the cells in reach, each once: two cells can share a bucket, and a
        // bird must not be counted twice. Birds of other cells in a bucket are far away,
        // and the distance test drops them.
        const buckets = this.buckets, stamp = this.bucketStamp;
        const search = ++this.searches;
        let bucketCount = 0;
        const ci = this.cellX[i], cj = this.cellY[i], ck = this.cellZ[i];
        for (let a = ci - span; a <= ci + span; a++) {
            const ha = Math.imul(a, 73856093);
            for (let b = cj - span; b <= cj + span; b++) {
                const hab = ha ^ Math.imul(b, 19349663);
                for (let c = ck - span; c <= ck + span; c++) {
                    const h = (hab ^ Math.imul(c, 83492791)) & mask;
                    if (stamp[h] !== search) {
                        stamp[h] = search;
                        buckets[bucketCount++] = h;
                    }
                }
            }
        }
        for (let q = 0; q < bucketCount; q++) {
            const h = buckets[q], end = this.cellStart[h + 1];
            for (let k = this.cellStart[h]; k < end; k++) {
                const j = this.order[k];
                const dx = this.px[j] - xi, dy = this.py[j] - yi, dz = this.pz[j] - zi;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= reach2 && j !== i) {
                    cand[found] = j; candD2[found++] = d2;
                }
            }
        }
        return found;
    }

    // Every bird looks at its neighbors and decides how to steer (Equ. 2-14).
    react() {
        const n = this.count;
        const ux = this.ux, uy = this.uy, uz = this.uz;
        let meanRadius = 0;
        for (let i = 0; i < n; i++) {
            const speed = Math.sqrt(this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i] + this.vz[i] * this.vz[i]) || 1;
            ux[i] = this.vx[i] / speed; uy[i] = this.vy[i] / speed; uz[i] = this.vz[i] / speed;
            meanRadius += this.radius[i] / n;
        }
        // Most searches reach R, so cells of that size make most of them 3 x 3 x 3.
        const cell = Math.min(50, Math.max(0.5, meanRadius));
        this.buildGrid(cell);
        const cand = this.candidates, candD2 = this.candidateD2;
        const turn = this.reactions++ % CENTRALITY_EVERY;

        for (let i = 0; i < n; i++) {
            const exi = ux[i], eyi = uy[i], ezi = uz[i];
            const R = this.radius[i], R2 = R * R;
            const xi = this.px[i], yi = this.py[i], zi = this.pz[i];
            const measure = i % CENTRALITY_EVERY === turn;
            const found = this.gather(i, measure ? 2 * R : R, cell);

            let count = 0, starCount = 0;
            let sx = 0, sy = 0, sz = 0;         // separation
            let cx = 0, cy = 0, cz = 0;         // cohesion
            let ax = 0, ay = 0, az = 0;         // alignment
            let gx = 0, gy = 0, gz = 0;         // centrality
            for (let k = 0; k < found; k++) {
                const j = cand[k], d2 = candD2[k];
                const d = Math.sqrt(d2) || 1e-9;
                const dxu = (this.px[j] - xi) / d, dyu = (this.py[j] - yi) / d, dzu = (this.pz[j] - zi) / d;
                gx += dxu; gy += dyu; gz += dzu;
                if (d2 > R2) continue;
                count++;
                // Equ. 4, all round: a bird avoids others it cannot see as well
                const over = d - HARD_SPHERE;
                const g = over <= 0 ? 1 : Math.exp(-over * over * this.invSigma2);
                sx += g * dxu; sy += g * dyu; sz += g * dzu;
                if (dxu * exi + dyu * eyi + dzu * ezi < BLIND_COS) continue;     // behind it
                starCount++;
                if (over > 0) {
                    cx += dxu; cy += dyu; cz += dzu;        // Equ. 5
                }
                ax += ux[j] - exi; ay += uy[j] - eyi; az += uz[j] - ezi;      // Equ. 8
            }

            // Equ. 2: the radius grows or shrinks toward n_c neighbors
            this.radius[i] = Math.min(R_MAX, Math.max(HARD_SPHERE,
                (1 - INTERPOLATION) * R + INTERPOLATION * (R_MAX - R_MAX * count / TOPOLOGICAL)));
            this.neighbors[i] = count;

            let fx = 0, fy = 0, fz = 0;
            if (count > 0) {
                fx -= W_SEPARATION * sx / count; fy -= W_SEPARATION * sy / count; fz -= W_SEPARATION * sz / count;
            }
            // Equ. 7: centrality, near 0 inside the flock and 0.5 to 0.75 at its border.
            // Cohesion is scaled by it, so birds at the border hold on harder (Equ. 5).
            if (measure) this.centrality[i] = found > 0 ? Math.sqrt(gx * gx + gy * gy + gz * gz) / found : 1;
            const centrality = this.centrality[i];
            if (starCount > 0) {
                const pull = centrality * W_COHESION / starCount;
                fx += pull * cx; fy += pull * cy; fz += pull * cz;
                // Equ. 8, read as w_a times the unit vector of the sum of (e_xj - e_xi)
                const align = Math.sqrt(ax * ax + ay * ay + az * az);
                if (align > 1e-9) {
                    fx += W_ALIGNMENT * ax / align; fy += W_ALIGNMENT * ay / align; fz += W_ALIGNMENT * az / align;
                }
            }

            // Equ. 1: speed control
            const speed = Math.sqrt(this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i] + this.vz[i] * this.vz[i]);
            const push = MASS / SPEED_TAU * (this.cruise - speed);
            fx += push * exi; fy += push * eyi; fz += push * ezi;

            // the bird's level "left": up x forward
            let lx = -eyi, ly = exi;
            const level = Math.sqrt(lx * lx + ly * ly);
            if (level < 1e-6) {
                lx = 1; ly = 0;
            } else {
                lx /= level; ly /= level;
            }

            // Equ. 11: outside the roost, turn back in, harder the more it heads outward.
            // Read as w_RoostH times the distance outside, from its unit, N/m.
            const out = Math.sqrt(xi * xi + yi * yi);
            if (out > this.roostRadius) {
                const nx = xi / out, ny = yi / out;
                const outward = 0.5 + 0.5 * (exi * nx + eyi * ny);
                const side = (lx * nx + ly * ny) > 0 ? -1 : 1;      // the side that points inward
                const pull = W_ROOST_H * (out - this.roostRadius) * outward * side;
                fx += pull * lx; fy += pull * ly;
            }
            // Equ. 12: back to the preferred height
            fz -= W_ROOST_V * zi;

            // Equ. 13: a random push
            const u = 2 * this.rand() - 1, phi = 2 * Math.PI * this.rand(), r = Math.sqrt(1 - u * u);
            fx += W_NOISE * r * Math.cos(phi); fy += W_NOISE * r * Math.sin(phi); fz += W_NOISE * u;

            this.fx[i] = fx; this.fy[i] = fy; this.fz[i] = fz;
            // the bank that would give the sideways push asked for (see BANKING, above)
            this.bankTarget[i] = Math.atan2((fx * lx + fy * ly) / MASS, GRAVITY);
        }
    }

    // One integration step (Equ. 15-23).
    advance() {
        if (this.step % REACTION_STEPS === 0) this.react();
        const n = this.count;
        const fastRoll = ROLL_IN * DT, slowRoll = ROLL_OUT * DT, v0Squared = this.cruise * this.cruise;
        for (let i = 0; i < n; i++) {
            let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
            const speed2 = vx * vx + vy * vy + vz * vz;
            const speed = Math.sqrt(speed2) || 1e-9;
            const ex = vx / speed, ey = vy / speed, ez = vz / speed;
            // level left (up x forward) and level up (forward x left)
            let lx = -ey, ly = ex;
            const level = Math.sqrt(lx * lx + ly * ly);
            if (level < 1e-6) {
                lx = 1; ly = 0;
            } else {
                lx /= level; ly /= level;
            }
            const upx = -ez * ly, upy = ez * lx, upz = ex * ly - ey * lx;

            // roll toward the target: fast away from level or across it, slow back toward it
            const bank = this.bank[i], target = this.bankTarget[i];
            const next = bank + (target - bank) * ((target - bank) * target > 0 ? fastRoll : slowRoll);
            this.bank[i] = next;
            const c = Math.cos(next), s = Math.sin(next);

            // Equ. 16-17: lift along the bird's banked up, drag against its motion, thrust, weight
            const lift = speed2 / v0Squared * LIFT0;
            const along = THRUST0 - lift / LIFT_DRAG;
            const liftX = lift * (c * upx + s * lx), liftY = lift * (c * upy + s * ly), liftZ = lift * c * upz;
            // Equ. 22-23
            vx += (this.fx[i] + liftX + along * ex) / MASS * DT;
            vy += (this.fy[i] + liftY + along * ey) / MASS * DT;
            vz += ((this.fz[i] + liftZ + along * ez) / MASS - GRAVITY) * DT;
            this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
            this.px[i] += vx * DT; this.py[i] += vy * DT; this.pz[i] += vz * DT;
        }
        this.step++;
        this.time = this.step * DT;
    }

    // Positions in the flock's frame: [north, east, up] for each bird.
    writePositions(out, offset = 0) {
        for (let i = 0; i < this.count; i++) {
            out[offset + 3 * i] = this.py[i];
            out[offset + 3 * i + 1] = this.px[i];
            out[offset + 3 * i + 2] = this.pz[i];
        }
    }
}

// How long the flock flies before the first sample, so that it is the model's own flock and
// not the starting shape. The paper let its flocks run for minutes; this is the shortest in
// which the tests find the spacing and the number of neighbors have settled.
export const WARM_UP_SECONDS = 30;
// Samples start this long before time 0, so that the first frame has samples on both sides.
export const PRE_SECONDS = 1;

// The time between samples: 0.1 s, or longer for a big flock over a long sitch, so that
// the samples stay under about 50 MB.
export function sampleSecondsFor(count, duration) {
    const seconds = 0.1 * Math.max(1, count * (duration + PRE_SECONDS) / (4000 * 100));
    return Math.max(1, Math.round(seconds / DT)) * DT;
}

// Run the simulation from the warm-up to `duration` seconds, passing out the samples in
// chunks: onChunk(firstSample, Float32Array of samples x birds x 3). Used by the worker, and
// by the tests directly.
export function runMurmuration(params, onChunk, shouldStop = () => false) {
    const sim = new MurmurationSim(params);
    const sampleSeconds = sampleSecondsFor(sim.count, params.duration);
    const stepsPerSample = Math.round(sampleSeconds / DT);
    const samples = Math.ceil((params.duration + 2 * PRE_SECONDS) / sampleSeconds) + 1;
    const warmSteps = Math.round((WARM_UP_SECONDS - PRE_SECONDS) / DT);
    for (let step = 0; step < warmSteps; step++) {
        sim.advance();
        if (step % 2000 === 0 && shouldStop()) return;
    }
    // About a second of samples per chunk at first, so that something shows soon, then two.
    let first = 0;
    while (first < samples) {
        const size = Math.min(samples - first, Math.max(1, Math.round((first === 0 ? 1 : 2) / sampleSeconds)));
        const chunk = new Float32Array(size * sim.count * 3);
        for (let k = 0; k < size; k++) {
            if (first + k > 0) for (let s = 0; s < stepsPerSample; s++) sim.advance();
            sim.writePositions(chunk, k * sim.count * 3);
        }
        onChunk(first, chunk, {sampleSeconds, samples, count: sim.count});
        first += size;
        if (shouldStop()) return;
    }
}

// Catmull-Rom: smooth through the samples, so a bird's velocity has no corners at them.
function catmullRom(p0, p1, p2, p3, u) {
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u3);
}

// The samples of one run, as the timeline reads them. `runner(params, onChunk)` produces
// them: in the browser a worker, in the tests runMurmuration itself. It returns a function
// that stops the run.
export class MurmurationTimeline {
    constructor(params, runner, onProgress = () => {}) {
        this.params = params;
        this.count = Math.max(2, Math.round(params.count));
        this.available = 0;
        this.samples = 0;
        this.data = null;
        this.onProgress = onProgress;
        this.stop = runner(params, (first, chunk, info) => this.receive(first, chunk, info));
    }

    receive(first, chunk, info) {
        if (this.disposed) return;      // a message from a run that has been replaced
        if (!this.data) {
            this.sampleSeconds = info.sampleSeconds;
            this.samples = info.samples;
            this.data = new Float32Array(info.samples * this.count * 3);
        }
        this.data.set(chunk, first * this.count * 3);
        this.available = first + chunk.length / (this.count * 3);
        this.onProgress(this.available / this.samples);
    }

    get ready() {
        return this.available > 0;
    }

    get progress() {
        return this.samples ? this.available / this.samples : 0;
    }

    // Where every bird is at time t (seconds), in [north, east, up] meters from the roost.
    // A time not yet simulated shows the last one that has been.
    evaluate(t, out) {
        if (!this.ready) return out;
        const n = this.count, last = this.available - 1;
        const u = Math.min(last, Math.max(0, (t + PRE_SECONDS) / this.sampleSeconds));
        const k = Math.min(last, Math.floor(u)), frac = u - k;
        const k0 = Math.max(0, k - 1), k2 = Math.min(last, k + 1), k3 = Math.min(last, k + 2);
        const d = this.data, stride = 3 * n;
        for (let i = 0; i < 3 * n; i++) {
            out[i] = catmullRom(d[k0 * stride + i], d[k * stride + i], d[k2 * stride + i], d[k3 * stride + i], frac);
        }
        return out;
    }

    dispose() {
        this.disposed = true;
        this.stop?.();
        this.data = null;
        this.available = 0;
    }
}

// The runner the tests use: the whole run, at once, in this thread.
export function runMurmurationHere(params, onChunk) {
    runMurmuration(params, onChunk);
    return () => {};
}
