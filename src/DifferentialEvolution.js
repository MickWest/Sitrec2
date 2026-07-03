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
 * @param {function(number[]): number} costFn - cost to minimize
 * @param {number[]} lo - lower bounds
 * @param {number[]} hi - upper bounds
 * @param {object} options
 *   pop        - population size (default 15 * dim, min 40)
 *   gens       - number of generations (default 150)
 *   F          - differential weight (default 0.7)
 *   CR         - crossover probability (default 0.9)
 *   seeds      - array of parameter vectors to seed into the initial population
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

    const P = [];
    for (let i = 0; i < pop; i++) {
        const x = new Array(dim);
        for (let d = 0; d < dim; d++) x[d] = lo[d] + Math.random() * (hi[d] - lo[d]);
        P.push(x);
    }
    for (let i = 0; i < seeds.length && i < pop; i++) {
        P[i] = clampVec(seeds[i].slice(), lo, hi);
    }
    const costs = P.map(costFn);

    for (let g = 0; g < gens; g++) {
        for (let i = 0; i < pop; i++) {
            let a, b, c;
            do { a = (Math.random() * pop) | 0; } while (a === i);
            do { b = (Math.random() * pop) | 0; } while (b === i || b === a);
            do { c = (Math.random() * pop) | 0; } while (c === i || c === a || c === b);
            const trial = P[i].slice();
            const jr = (Math.random() * dim) | 0;
            for (let d = 0; d < dim; d++) {
                if (d === jr || Math.random() < CR) {
                    let v = P[a][d] + F * (P[b][d] - P[c][d]);
                    // reflect back into bounds with a little randomness so the
                    // population doesn't pile up on the boundary
                    if (v < lo[d]) v = lo[d] + Math.random() * (hi[d] - lo[d]) * 0.1;
                    if (v > hi[d]) v = hi[d] - Math.random() * (hi[d] - lo[d]) * 0.1;
                    trial[d] = v;
                }
            }
            const tc = costFn(trial);
            if (tc <= costs[i]) { P[i] = trial; costs[i] = tc; }
        }
        if (options.onGeneration) {
            let bi = 0;
            for (let i = 1; i < pop; i++) if (costs[i] < costs[bi]) bi = i;
            const keepGoing = await options.onGeneration(g, costs[bi]);
            if (keepGoing === false) break;
        }
    }

    let bi = 0;
    for (let i = 1; i < pop; i++) if (costs[i] < costs[bi]) bi = i;
    return {params: P[bi], cost: costs[bi]};
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
export function patternSearchPolish(costFn, x0, scales, options = {}) {
    const maxIter = options.maxIter ?? 300;
    const minStep = options.minStep ?? 1e-4;
    const {lo, hi} = options;
    let x = x0.slice();
    if (lo && hi) x = clampVec(x, lo, hi);
    let c = costFn(x);
    let step = 1.0;
    for (let it = 0; it < maxIter; it++) {
        let improved = false;
        for (let d = 0; d < x.length; d++) {
            for (const s of [step, -step]) {
                const y = x.slice();
                y[d] += scales[d] * s;
                if (lo && y[d] < lo[d]) continue;
                if (hi && y[d] > hi[d]) continue;
                const cy = costFn(y);
                if (cy < c) { x = y; c = cy; improved = true; }
            }
        }
        if (!improved) {
            step *= 0.5;
            if (step < minStep) break;
        }
    }
    return {params: x, cost: c};
}

function clampVec(x, lo, hi) {
    for (let d = 0; d < x.length; d++) {
        if (x[d] < lo[d]) x[d] = lo[d];
        if (x[d] > hi[d]) x[d] = hi[d];
    }
    return x;
}
