/** Angular-size observations, kept separate from truth and physical-size priors. */
const RAD = Math.PI / 180;
const finite = Number.isFinite;

// Diameters refer to projected extent perpendicular to the sightline. Ratios
// describe tan(angle / 2), which is proportional to extent/range. At small
// angles this is also the angular-diameter ratio, without a guessed range.
export function angularExtentFactor(degrees) {
    return 2 * Math.tan(degrees * RAD / 2);
}

export function validateAngularSize(observations, n) {
    if (!observations) return null;
    const frame = f => Number.isInteger(f) && f >= 0 && f < n;
    const samples = observations.samples ?? [];
    const relative = observations.relative ?? [];
    if (!Array.isArray(samples) || !Array.isArray(relative)) throw new Error("Angular-size samples must be arrays.");
    for (const s of samples) {
        if (!frame(s.frame) || !finite(s.minDeg) || !finite(s.maxDeg)
            || s.minDeg < 0 || s.maxDeg <= 0 || s.minDeg > s.maxDeg || s.maxDeg >= 180) {
            throw new Error("Angular size needs a valid frame and bounds 0 ≤ minimum ≤ maximum < 180 degrees.");
        }
    }
    for (const s of relative) {
        if (!frame(s.frame) || !frame(s.referenceFrame) || !finite(s.minRatio) || !finite(s.maxRatio)
            || s.minRatio <= 0 || s.minRatio > s.maxRatio) {
            throw new Error("Relative angular size needs valid frames and positive, ordered ratio bounds.");
        }
    }
    const b = observations.relativeBound;
    if (b && (!frame(b.referenceFrame) || !frame(b.startFrame) || !frame(b.endFrame)
        || b.startFrame > b.endFrame || !finite(b.minRatio) || !finite(b.maxRatio)
        || b.minRatio <= 0 || b.minRatio > b.maxRatio)) {
        throw new Error("The angular-size variation bound needs a valid frame interval and positive ratio bounds.");
    }
    return observations;
}

/** A published upper bound supplies no lower bound, even when FOV is known. */
export function angularSizeFromUpperBounds(values) {
    const samples = [];
    values.forEach((maxDeg, frame) => {
        if (finite(maxDeg) && maxDeg > 0 && maxDeg < 180) samples.push({frame, minDeg: 0, maxDeg});
    });
    return samples.length ? {samples, relative: [], source: "Recorded angular-diameter bounds"} : null;
}

/** Describe available evidence independently of whether judging is enabled. */
export function angularSizeInventory(observations) {
    const samples = observations?.samples ?? [];
    const upperOnly = samples.filter(s => s.minDeg === 0).length;
    const relative = (observations?.relative?.length ?? 0)
        + (observations?.relativeBound ? observations.relativeBound.endFrame - observations.relativeBound.startFrame + 1 : 0);
    const count = samples.length + relative;
    const parts = [];
    if (upperOnly) parts.push(`${upperOnly} upper-bound samples`);
    if (samples.length > upperOnly) parts.push(`${samples.length - upperOnly} samples with lower and upper bounds`);
    if (relative) parts.push(`${relative} relative constraints`);
    return {count, upperOnly, absolute: samples.length, relative,
        summary: count ? `Available: ${parts.join("; ")}.` : "No angular-size observations on the selected sightline in this analysis window.",
        upperOnlyNote: upperOnly && upperOnly === count
            ? "Upper bounds are not measured diameters. They can exclude class sizes at a candidate range, but alone cannot constrain range changes: an unknown object can always be small enough."
            : ""};
}

export function angularSizeFitUnavailableReason(observations, options = {}) {
    const inventory = angularSizeInventory(observations);
    if (!inventory.count) return "No angular-size observations are available.";
    if (inventory.upperOnly === inventory.count) return "Upper bounds alone do not constrain range changes. Add lower-and-upper measurements at multiple frames, or relative size bounds.";
    if (!options.constantProjectedSize) return "Requires the constant projected physical-size assumption.";
    const absoluteChange = new Set((observations?.samples ?? []).map(s => s.frame)).size > 1
        && observations.samples.some(s => s.minDeg > 0);
    const relativeChange = observations?.relative?.some(s => s.frame !== s.referenceFrame)
        || (observations?.relativeBound && observations.relativeBound.endFrame > observations.relativeBound.startFrame);
    return absoluteChange || relativeChange ? null : "Requires size-change observations at more than one frame.";
}

/** Remap original observation indices after a crop/drop; no nearest-frame guessing. */
export function remapAngularSize(observations, originalFrames) {
    if (!observations) return null;
    const indices = new Map(originalFrames.map((frame, i) => [frame, i]));
    const samples = (observations.samples ?? []).filter(s => indices.has(s.frame))
        .map(s => ({...s, frame: indices.get(s.frame)}));
    const relative = (observations.relative ?? []).filter(s => indices.has(s.frame) && indices.has(s.referenceFrame))
        .map(s => ({...s, frame: indices.get(s.frame), referenceFrame: indices.get(s.referenceFrame)}));
    const b = observations.relativeBound;
    if (b && indices.has(b.referenceFrame)) {
        originalFrames.forEach((frame, i) => {
            if (frame >= b.startFrame && frame <= b.endFrame) relative.push({frame: i,
                referenceFrame: indices.get(b.referenceFrame), minRatio: b.minRatio, maxRatio: b.maxRatio});
        });
    }
    return {...observations, samples, relative, relativeBound: undefined};
}

function rangeAt(dataset, track, frame) {
    const k = frame * 3;
    return Math.hypot(track[k] - dataset.S[k], track[k + 1] - dataset.S[k + 1], track[k + 2] - dataset.S[k + 2]);
}

function outsideLog(value, lo, hi) {
    return value < lo ? lo - value : value > hi ? value - hi : 0;
}

// Profile out ONE unknown projected diameter. This is an interval consistency
// loss, not a likelihood, chi-square statistic or confidence measurement.
function fitLogDiameter(intervals) {
    const lower = Math.max(...intervals.map(s => s.lo > 0 ? Math.log(s.lo) : -Infinity));
    const upper = Math.min(...intervals.map(s => Math.log(s.hi)));
    if (lower <= upper) return {logDiameter: upper, lo: Math.exp(lower), hi: Math.exp(upper)};
    let a = upper, b = lower;
    for (let i = 0; i < 48; i++) {
        const mid = (a + b) / 2;
        let derivative = 0;
        for (const s of intervals) {
            const lo = s.lo > 0 ? Math.log(s.lo) : -Infinity, hi = Math.log(s.hi);
            derivative += mid < lo ? mid - lo : mid > hi ? mid - hi : 0;
        }
        if (derivative > 0) b = mid; else a = mid;
    }
    return {logDiameter: (a + b) / 2, lo: Math.exp(lower), hi: Math.exp(upper)};
}

/**
 * Judge a candidate at observed frames only. Sparse samples are not interpolated.
 * A clip-wide relative bound is different: its author explicitly asserts that
 * bound at every frame. Turning constantProjectedSize off disables range-change
 * inference; absolute samples still constrain projected size at their own frames.
 */
export function assessAngularSize(dataset, hypothesis, {constantProjectedSize = false} = {}) {
    const observations = dataset?.angularSize;
    const empty = {status: "unavailable", checked: 0, absoluteCount: 0, relativeCount: 0,
        constantProjectedSize, impliedM: null, sizeIntervals: [], rmsLogViolation: 0, maxFactor: null};
    if (!observations) return {...empty, reason: "No angular-size observations"};
    const h = hypothesis, track = h?.track;
    if (!track || h.atInfinity || h.identity || track.length !== dataset.n * 3 || !dataset.S) {
        return {...empty, reason: "No comparable finite path"};
    }
    validateAngularSize(observations, dataset.n);
    const intervals = [];
    const violations = [];
    let missing = 0, relativeCount = 0;
    for (const s of observations.samples ?? []) {
        const range = rangeAt(dataset, track, s.frame);
        if (!(range > 0) || !finite(range)) { missing++; continue; }
        intervals.push({frame: s.frame, lo: range * angularExtentFactor(s.minDeg),
            hi: range * angularExtentFactor(s.maxDeg)});
    }
    let impliedM = null;
    if (intervals.length) {
        if (constantProjectedSize) {
            const fit = fitLogDiameter(intervals);
            impliedM = fit.lo <= fit.hi ? {lo: fit.lo, hi: fit.hi, oneSided: !(fit.lo > 0)} : null;
            for (const s of intervals) violations.push(outsideLog(fit.logDiameter,
                s.lo > 0 ? Math.log(s.lo) : -Infinity, Math.log(s.hi)));
        } else {
            impliedM = {lo: Math.min(...intervals.map(s => s.lo)), hi: Math.max(...intervals.map(s => s.hi)),
                oneSided: intervals.some(s => s.lo === 0)};
        }
    }
    const checkRatio = (s, frame) => {
        const r = rangeAt(dataset, track, frame), ref = rangeAt(dataset, track, s.referenceFrame);
        if (!(r > 0) || !(ref > 0) || !finite(r + ref)) { missing++; return; }
        violations.push(outsideLog(Math.log(ref / r), Math.log(s.minRatio), Math.log(s.maxRatio)));
        relativeCount++;
    };
    if (constantProjectedSize) {
        for (const s of observations.relative ?? []) checkRatio(s, s.frame);
        const b = observations.relativeBound;
        if (b) for (let f = b.startFrame; f <= b.endFrame; f++) checkRatio(b, f);
    }
    const checked = intervals.length + relativeCount;
    const worst = violations.reduce((m, v) => Math.max(m, v), 0);
    const status = worst > 1e-8 ? "conflict" : !checked || missing ? "unavailable" : "compatible";
    return {status, checked, absoluteCount: intervals.length, relativeCount,
        constantProjectedSize, impliedM, sizeIntervals: intervals, missing,
        upperOnlyCount: intervals.filter(s => s.lo === 0).length,
        rmsLogViolation: Math.sqrt(violations.reduce((s, v) => s + v * v, 0) / Math.max(1, violations.length)),
        maxFactor: checked ? Math.exp(worst) : null,
        reason: !checked && !constantProjectedSize && ((observations.relative?.length ?? 0) || observations.relativeBound)
            ? "Relative size needs the constant projected-size assumption"
            : missing ? "Path missing at observed size frames" : null};
}

export function angularSizeSummary(check) {
    if (!check || check.status === "unavailable") return check?.reason ?? "Angular size not assessed";
    const assumption = check.constantProjectedSize ? "; constant projected size assumed" : "; projected size may vary";
    return (check.status === "conflict" ? `Conflict: up to ${check.maxFactor.toFixed(2)}× outside size bounds`
        + (check.reason ? ` (${check.reason})` : "")
        : check.absoluteCount > 0 && check.upperOnlyCount === check.absoluteCount && !check.relativeCount
            ? `Upper bounds checked (${check.absoluteCount} samples)`
            : `Within size bounds (${check.absoluteCount} absolute, ${check.relativeCount} relative)`) + assumption;
}

/** A separate optional fit loss; leave the reported LOS residual unchanged. */
export function angularSizeFitCost(dataset, track) {
    if (!dataset?.angularSizeOptions?.fit) return 0;
    const c = assessAngularSize(dataset, {track}, dataset.angularSizeOptions);
    return c.missing ? 1e6 : (c.rmsLogViolation / Math.log(1.1)) ** 2;
}

/** Unknown physical size supplies a range-change constraint only under this assumption. */
export function angularSizeFitEnabled(dataset) {
    return !!dataset?.angularSizeOptions?.fit
        && !angularSizeFitUnavailableReason(dataset.angularSize, dataset.angularSizeOptions);
}

const SIZE_FIT_KEYS = new Set(["lantern", "quadcopter", "droneControl", "aircraft", "horizontalSpeed", "constAlt", "constAir", "plausible"]);
export function angularSizeUsedInFit(dataset, hypothesis) {
    return angularSizeFitEnabled(dataset) && SIZE_FIT_KEYS.has(hypothesis.key);
}
export function angularSizeFitSummary(dataset, hypothesis, {requested = false} = {}) {
    if (!requested && hypothesis?.angularSizeFit) return hypothesis.angularSizeFit.summary
        + (Number.isFinite(hypothesis.angularSizeFit.loss) ? `; final path size loss ${hypothesis.angularSizeFit.loss.toFixed(3)}` : "");
    if (!dataset?.angularSizeOptions?.fit) return "Off";
    const unavailable = angularSizeFitUnavailableReason(dataset.angularSize, dataset.angularSizeOptions);
    if (unavailable) return `Not used: ${unavailable}`;
    if (!SIZE_FIT_KEYS.has(hypothesis.key)) return "LOS-only fit; this method does not use angular size during fitting";
    return "Size interval loss added to the CPU search; constant projected size assumed";
}

export function angularSizeFrames(observations) {
    const frames = new Set((observations?.samples ?? []).map(s => s.frame));
    for (const s of observations?.relative ?? []) { frames.add(s.frame); frames.add(s.referenceFrame); }
    const b = observations?.relativeBound;
    if (b) {
        frames.add(b.referenceFrame);
        for (let f = b.startFrame; f <= b.endFrame; f++) frames.add(f);
    }
    return [...frames].sort((a, b) => a - b);
}

/** Compile the interval loss once for an optimizer. No truth or object-size prior is read. */
export function compileAngularSizeFit(dataset) {
    if (!angularSizeFitEnabled(dataset)) return () => 0;
    validateAngularSize(dataset.angularSize, dataset.n);
    const absolute = (dataset.angularSize.samples ?? []).map(s => ({frame: s.frame,
        lo: s.minDeg > 0 ? Math.log(angularExtentFactor(s.minDeg)) : -Infinity,
        hi: Math.log(angularExtentFactor(s.maxDeg))}));
    const relative = [...(dataset.angularSize.relative ?? [])];
    const b = dataset.angularSize.relativeBound;
    if (b) for (let frame = b.startFrame; frame <= b.endFrame; frame++) relative.push({...b, frame});
    const ratios = relative.map(s => ({...s, lo: Math.log(s.minRatio), hi: Math.log(s.maxRatio)}));
    const frames = angularSizeFrames(dataset.angularSize);
    const logRanges = new Float64Array(dataset.n);
    return track => {
        for (const f of frames) {
            const r = rangeAt(dataset, track, f);
            if (!(r > 0) || !finite(r)) return 1e6;
            logRanges[f] = Math.log(r);
        }
        let sum = 0;
        if (absolute.length > 1) {
            let lower = -Infinity, upper = Infinity;
            for (const s of absolute) {
                lower = Math.max(lower, s.lo + logRanges[s.frame]);
                upper = Math.min(upper, s.hi + logRanges[s.frame]);
            }
            if (lower > upper) {
                let a = upper, b = lower;
                for (let i = 0; i < 32; i++) {
                    const mid = (a + b) / 2;
                    let derivative = 0;
                    for (const s of absolute) {
                        const lo = s.lo + logRanges[s.frame], hi = s.hi + logRanges[s.frame];
                        derivative += mid < lo ? mid - lo : mid > hi ? mid - hi : 0;
                    }
                    if (derivative > 0) b = mid; else a = mid;
                }
                const mid = (a + b) / 2;
                for (const s of absolute) sum += outsideLog(mid, s.lo + logRanges[s.frame], s.hi + logRanges[s.frame]) ** 2;
            }
        }
        for (const s of ratios) sum += outsideLog(logRanges[s.referenceFrame] - logRanges[s.frame], s.lo, s.hi) ** 2;
        // Mean, not sum: repeating the complete observation set does not increase its fit weight.
        return sum / Math.max(1, absolute.length + ratios.length) / Math.log(1.1) ** 2;
    };
}
