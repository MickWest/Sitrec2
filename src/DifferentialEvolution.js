/**
 * DifferentialEvolution.js — generic bounded differential-evolution optimizer.
 *
 * Global search companion to NelderMead.js. DE/rand/1/bin scheme with
 * reflection-into-bounds. Used by the traverse analysis tools and the
 * physics-model LOS fit, where the cost landscape is multi-modal and a
 * single-start simplex reliably falls into the wrong basin.
 *
 * Pure math, no dependencies.
 */

/**
 * Deterministic PRNG (mulberry32). Production fits seed this from a fixed
 * per-call-site constant so identical inputs give identical results — an
 * unseeded Math.random made the physics-fit gallery tiles (and the applied
 * live fits) land in different corners of near-degenerate cost families on
 * every run. Same generator the deterministic Monte-Carlo fits already use.
 */
export function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {function(number[]): number} costFn - cost to minimize
 * @param {number[]} lo - lower bounds
 * @param {number[]} hi - upper bounds
 * @param {object} options
 *   pop        - population size (default 15 * dim, min 40)
 *   gens       - number of generations (default 150)
 *   F          - differential weight (default 0.7)
 *   CR         - crossover probability (default 0.9)
 *   seeds      - array of parameter vectors to seed into the initial population
 *   rng        - random source (default Math.random); pass mulberry32(seed)
 *                for reproducible fits
 *   onEvaluation - optional callback after each objective evaluation; returning
 *                false cancels promptly, and a returned promise is awaited
 *   onGeneration - optional callback (gen, bestCost) called after each generation;
 *                  if it returns a promise it is awaited (lets the UI breathe),
 *                  and if it resolves/returns false the search stops early.
 * @returns {{params: number[], cost: number}} best individual found
 *   (async — always returns a Promise)
 */
export async function differentialEvolution(costFn, lo, hi, options = {}) {
    const dim = lo.length;
    const pop = options.pop ?? Math.max(40, 15 * dim);
    const gens = options.gens ?? 150;
    const F = options.F ?? 0.7;
    const CR = options.CR ?? 0.9;
    const seeds = options.seeds ?? [];
    const rng = options.rng ?? Math.random;

    const P = [];
    for (let i = 0; i < pop; i++) {
        const x = new Array(dim);
        for (let d = 0; d < dim; d++) x[d] = lo[d] + rng() * (hi[d] - lo[d]);
        P.push(x);
    }
    for (let i = 0; i < seeds.length && i < pop; i++) {
        P[i] = clampVec(seeds[i].slice(), lo, hi);
    }
    const costs = new Array(pop).fill(Infinity);

    let generations = 0;
    let cancelled = false;
    let evaluations = 0;
    const evaluate = (x) => {
        evaluations++;
        const value = costFn(x);
        return Number.isFinite(value) ? value : Infinity;
    };
    const afterEvaluation = async (payload) => {
        if (!options.onEvaluation) return true;
        const signal = options.onEvaluation(payload);
        return signal && typeof signal.then === "function"
            ? (await signal) !== false : signal !== false;
    };

    // Initial-population evaluation used to be one uninterrupted P.map(costFn),
    // which could block longer than an entire later generation. Cooperate after
    // every candidate here too so repaint/cancel works from the first second.
    for (let i = 0; i < pop; i++) {
        costs[i] = evaluate(P[i]);
        if (!(await afterEvaluation({phase: "initial", generation: -1,
            individual: i, evaluations}))) {
            cancelled = true;
            break;
        }
    }

    outer:
    for (let g = 0; g < gens; g++) {
        if (cancelled) break;
        for (let i = 0; i < pop; i++) {
            let a, b, c;
            do { a = (rng() * pop) | 0; } while (a === i);
            do { b = (rng() * pop) | 0; } while (b === i || b === a);
            do { c = (rng() * pop) | 0; } while (c === i || c === a || c === b);
            const trial = P[i].slice();
            const jr = (rng() * dim) | 0;
            for (let d = 0; d < dim; d++) {
                if (d === jr || rng() < CR) {
                    let v = P[a][d] + F * (P[b][d] - P[c][d]);
                    // reflect back into bounds with a little randomness so the
                    // population doesn't pile up on the boundary
                    if (v < lo[d]) v = lo[d] + rng() * (hi[d] - lo[d]) * 0.1;
                    if (v > hi[d]) v = hi[d] - rng() * (hi[d] - lo[d]) * 0.1;
                    trial[d] = v;
                }
            }
            const tc = evaluate(trial);
            if (tc <= costs[i]) { P[i] = trial; costs[i] = tc; }
            if (!(await afterEvaluation({phase: "generation", generation: g,
                individual: i, evaluations}))) {
                cancelled = true;
                break outer;
            }
        }
        if (options.onGeneration) {
            let bi = 0;
            for (let i = 1; i < pop; i++) if (costs[i] < costs[bi]) bi = i;
            const signal = options.onGeneration(g, costs[bi]);
            const keepGoing = signal && typeof signal.then === "function"
                ? await signal : signal;
            generations = g + 1;
            if (keepGoing === false) { cancelled = true; break; }
        } else {
            generations = g + 1;
        }
    }

    let bi = 0;
    for (let i = 1; i < pop; i++) if (costs[i] < costs[bi]) bi = i;
    return {
        params: P[bi],
        cost: costs[bi],
        generations,
        evaluations,
        cancelled,
        stopReason: cancelled ? "cancelled" : "generation_limit",
    };
}

/**
 * Coordinate-descent pattern-search polish. Cheap derivative-free local
 * refinement to run after differentialEvolution (or on its own from a good
 * starting point).
 *
 * @param {function(number[]): number} costFn
 * @param {number[]} x0 - starting point
 * @param {number[]} scales - per-parameter initial step size
 * @param {object} options - {maxIter (default 300), minStep (default 1e-4), lo, hi}
 * @returns {{params: number[], cost: number}}
 */
export async function patternSearchPolish(costFn, x0, scales, options = {}) {
    const maxIter = options.maxIter ?? 300;
    const minStep = options.minStep ?? 1e-4;
    const {lo, hi} = options;
    let x = x0.slice();
    if (lo && hi) x = clampVec(x, lo, hi);
    let evaluations = 0;
    let cancelled = false;
    const evaluate = (value) => {
        evaluations++;
        const cost = costFn(value);
        return Number.isFinite(cost) ? cost : Infinity;
    };
    const afterEvaluation = async (payload) => {
        if (!options.onEvaluation) return true;
        const signal = options.onEvaluation(payload);
        return signal && typeof signal.then === "function"
            ? (await signal) !== false : signal !== false;
    };
    let c = evaluate(x);
    if (!(await afterEvaluation({phase: "initial", iteration: -1, evaluations}))) {
        cancelled = true;
    }
    let step = 1.0;
    let iterations = 0;
    let stopReason = "iteration_limit";
    outer:
    for (let it = 0; it < maxIter && !cancelled; it++) {
        iterations = it + 1;
        let improved = false;
        for (let d = 0; d < x.length; d++) {
            for (const s of [step, -step]) {
                const y = x.slice();
                y[d] += scales[d] * s;
                if (lo && y[d] < lo[d]) continue;
                if (hi && y[d] > hi[d]) continue;
                const cy = evaluate(y);
                if (cy < c) { x = y; c = cy; improved = true; }
                if (!(await afterEvaluation({phase: "iteration", iteration: it,
                    dimension: d, evaluations}))) {
                    cancelled = true;
                    break outer;
                }
            }
        }
        if (!improved) {
            step *= 0.5;
            if (step < minStep) { stopReason = "step_tolerance"; break; }
        }
    }
    return {params: x, cost: c, iterations,
        stopReason: cancelled ? "cancelled" : stopReason,
        evaluations, cancelled};
}

function clampVec(x, lo, hi) {
    for (let d = 0; d < x.length; d++) {
        if (x[d] < lo[d]) x[d] = lo[d];
        if (x[d] > hi[d]) x[d] = hi[d];
    }
    return x;
}
