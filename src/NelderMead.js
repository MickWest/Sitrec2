// Nelder-Mead simplex optimizer
// Minimizes costFn(params) over a parameter vector with optional box bounds.

export async function nelderMead(costFn, x0, options = {}) {
    const n = x0.length;
    const maxIter = options.maxIter ?? 2000;
    const tol = options.tol ?? 1e-8;
    const xTol = options.xTol ?? 1e-6;
    const lo = options.lo ?? null;  // lower bounds array (or null)
    const hi = options.hi ?? null;  // upper bounds array (or null)
    const initialScale = options.initialScale ?? null; // per-param simplex spread (array or null)

    const alpha = 1.0;  // reflection
    const gamma = 2.0;  // expansion
    const rho = 0.5;    // contraction
    const sigma = 0.5;  // shrink

    function clamp(x) {
        if (!lo && !hi) return x;
        const c = x.slice();
        for (let i = 0; i < n; i++) {
            if (lo && c[i] < lo[i]) c[i] = lo[i];
            if (hi && c[i] > hi[i]) c[i] = hi[i];
        }
        return c;
    }

    // Build initial simplex: n+1 vertices. If the outward step would leave the
    // bounds, step INWARD instead — clamping used to collapse that vertex back
    // onto x0 (zero simplex volume in that dimension), so a start point sitting
    // AT a bound (common after a bound-pinned DE result) could never be
    // polished along exactly the dimension that was pinned.
    const simplex = [clamp(x0.slice())];
    for (let i = 0; i < n; i++) {
        const v = x0.slice();
        const delta = initialScale ? initialScale[i] : (Math.abs(v[i]) * 0.05 || 0.00025);
        if (hi && v[i] + delta > hi[i] && v[i] - delta >= (lo ? lo[i] : -Infinity)) {
            v[i] -= delta;
        } else {
            v[i] += delta;
        }
        simplex.push(clamp(v));
    }

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
    const costs = new Array(simplex.length).fill(Infinity);
    for (let i = 0; i < simplex.length; i++) {
        costs[i] = evaluate(simplex[i]);
        if (!(await afterEvaluation({phase: "initial", iteration: -1,
            vertex: i, evaluations}))) {
            cancelled = true;
            break;
        }
    }

    function centroid(exclude) {
        const c = new Array(n).fill(0);
        for (let i = 0; i <= n; i++) {
            if (i === exclude) continue;
            for (let j = 0; j < n; j++) c[j] += simplex[i][j];
        }
        for (let j = 0; j < n; j++) c[j] /= n;
        return c;
    }

    function addVec(a, b, scale) {
        const r = new Array(n);
        for (let j = 0; j < n; j++) r[j] = a[j] + scale * (b[j] - a[j]);  // wrong form
        return r;
    }

    // point = centroid + scale * (centroid - worst)
    function reflect(c, worst, scale) {
        const r = new Array(n);
        for (let j = 0; j < n; j++) r[j] = c[j] + scale * (c[j] - worst[j]);
        return clamp(r);
    }

    let iterations = 0;
    let stopReason = "iteration_limit";
    outer:
    for (let iter = 0; iter < maxIter && !cancelled; iter++) {
        iterations = iter + 1;
        // Sort simplex by cost
        const indices = Array.from({length: n + 1}, (_, i) => i);
        indices.sort((a, b) => costs[a] - costs[b]);
        const sorted = indices.map(i => simplex[i]);
        const sortedCosts = indices.map(i => costs[i]);
        for (let i = 0; i <= n; i++) {
            simplex[i] = sorted[i];
            costs[i] = sortedCosts[i];
        }

        // Convergence requires both a flat objective AND a collapsed simplex.
        // Cost-only stopping is unsafe on LOS fits: an unobservable parameter
        // can span much of its range while every vertex has the same cost.
        const spread = costs[n] - costs[0];
        let parameterSpread = 0;
        for (let i = 1; i <= n; i++) {
            for (let j = 0; j < n; j++) {
                const scale = lo && hi
                    ? Math.max(1e-12, hi[j] - lo[j])
                    : Math.max(1, Math.abs(simplex[0][j]));
                parameterSpread = Math.max(parameterSpread,
                    Math.abs(simplex[i][j] - simplex[0][j]) / scale);
            }
        }
        if (spread < tol && parameterSpread < xTol) {
            stopReason = "cost_and_parameter_tolerance";
            break;
        }

        const c = centroid(n); // centroid excluding worst
        const worst = simplex[n];

        // Reflection
        const xr = reflect(c, worst, alpha);
        const fr = evaluate(xr);
        if (!(await afterEvaluation({phase: "reflection", iteration: iter, evaluations}))) {
            cancelled = true;
            break;
        }

        if (fr < costs[0]) {
            // Try expansion
            const xe = reflect(c, worst, gamma);
            const fe = evaluate(xe);
            if (!(await afterEvaluation({phase: "expansion", iteration: iter, evaluations}))) {
                cancelled = true;
                break;
            }
            if (fe < fr) {
                simplex[n] = xe; costs[n] = fe;
            } else {
                simplex[n] = xr; costs[n] = fr;
            }
        } else if (fr < costs[n - 1]) {
            // Accept reflection
            simplex[n] = xr; costs[n] = fr;
        } else {
            // Contraction
            const inside = fr >= costs[n];
            const xc = inside
                ? reflect(c, worst, -rho)   // inside contraction
                : reflect(c, worst, rho);    // outside contraction (toward reflected)
            const fc = evaluate(xc);
            if (!(await afterEvaluation({phase: "contraction", iteration: iter, evaluations}))) {
                cancelled = true;
                break;
            }

            if (fc < (inside ? costs[n] : fr)) {
                simplex[n] = xc; costs[n] = fc;
            } else {
                // Shrink all toward best
                for (let i = 1; i <= n; i++) {
                    for (let j = 0; j < n; j++) {
                        simplex[i][j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j]);
                    }
                    simplex[i] = clamp(simplex[i]);
                    costs[i] = evaluate(simplex[i]);
                    if (!(await afterEvaluation({phase: "shrink", iteration: iter,
                        vertex: i, evaluations}))) {
                        cancelled = true;
                        break outer;
                    }
                }
            }
        }
    }

    // Return best
    let bestIdx = 0;
    for (let i = 1; i <= n; i++) {
        if (costs[i] < costs[bestIdx]) bestIdx = i;
    }
    let parameterSpread = 0;
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j < n; j++) {
            const scale = lo && hi
                ? Math.max(1e-12, hi[j] - lo[j])
                : Math.max(1, Math.abs(simplex[bestIdx][j]));
            parameterSpread = Math.max(parameterSpread,
                Math.abs(simplex[i][j] - simplex[bestIdx][j]) / scale);
        }
    }
    return {
        params: simplex[bestIdx], cost: costs[bestIdx], iterations,
        stopReason: cancelled ? "cancelled" : stopReason,
        parameterSpread, evaluations, cancelled,
    };
}
