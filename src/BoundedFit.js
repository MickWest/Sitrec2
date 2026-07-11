/**
 * Diagnose parameters that finish close to a numerical bound.
 *
 * Merely landing near a bound is not evidence that the data require motion
 * outside the model.  The parameter may be inactive over the selected clip,
 * locally flat, or an optimizer artifact.  Probe a fixed distance inward and
 * call the bound load-bearing only when that worsens the fitted objective by a
 * material amount.
 *
 * This is deliberately a local diagnostic, not an uncertainty interval.  A
 * full identifiability analysis would re-optimize the remaining parameters.
 */
export function assessBoundPins(params, lo, hi, names, costFn, options = {}) {
    const proximityFraction = options.proximityFraction ?? 0.01;
    const probeFraction = options.probeFraction ?? 0.05;
    const absoluteTolerance = options.absoluteTolerance ?? 0.02;
    const relativeTolerance = options.relativeTolerance ?? 0.001;
    const excluded = new Set(options.excludeIndices || []);
    const base = Number.isFinite(options.baseCost) ? options.baseCost : costFn(params);
    const pins = [];

    for (let i = 0; i < params.length; i++) {
        if (excluded.has(i)) continue;
        const span = hi[i] - lo[i];
        if (!(span > 0) || !Number.isFinite(params[i])) continue;

        let side = null;
        if (params[i] - lo[i] < proximityFraction * span) side = "lo";
        else if (hi[i] - params[i] < proximityFraction * span) side = "hi";
        if (!side) continue;

        const probe = params.slice();
        probe[i] = side === "lo"
            ? lo[i] + probeFraction * span
            : hi[i] - probeFraction * span;
        const probeCost = costFn(probe);
        const deltaCost = probeCost - base;
        const tolerance = Math.max(absoluteTolerance,
            relativeTolerance * Math.max(1, Math.abs(base)));
        const loadBearing = Number.isFinite(base)
            && (!Number.isFinite(probeCost) || deltaCost > tolerance);
        const inwardBetter = Number.isFinite(deltaCost) && deltaCost < -tolerance;

        pins.push({
            name: names[i] ?? `parameter ${i + 1}`,
            side,
            loadBearing,
            inwardBetter,
            deltaCost: Number.isFinite(deltaCost) ? deltaCost : null,
            tolerance,
            probeValue: probe[i],
        });
    }
    return pins;
}
