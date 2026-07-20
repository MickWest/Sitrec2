// Drone hypothesis as CONTROL INPUTS rather than as a path shape.
//
// WHY
// The free QuadcopterModel is defined by a capability envelope and then asked
// for the best-scoring path inside it. On Aguadilla that produced a
// 61-revolution corkscrew of growing radius, buying 0.011 degrees of residual —
// a path inside the envelope that no human has flown. Asking "is there ANY path
// within the envelope" is a question that is almost always answerable yes, so
// the drone tile was not testing the drone hypothesis at all.
//
// An earlier attempt replaced it with a small library of flight modes (hover,
// straight leg, orbit). That was too rigid: real flights are none of those for
// their whole duration, and a fixed vocabulary is itself a foreclosure.
//
// This is the third formulation and the right one. A drone is flown by holding
// a small number of inputs and changing them occasionally: forward speed, yaw,
// climb. So:
//
//   1. SEED from a solution that already fits the sightlines — a global fit
//      (constant velocity, constant acceleration, Kalman) or the plausible
//      least-manoeuvring track. Those are geometry-driven and carry no drone
//      assumptions at all.
//   2. INVERT that path into the control history a drone would need to fly it:
//      per-frame ground speed, heading and climb rate.
//   3. COMPRESS that history onto a few knots, which is the actual modelling
//      claim — that a real flight is a handful of held inputs, not a
//      continuously varying one.
//   4. REFINE the knots against the sightlines, paying a price for control
//      EFFORT (how much the inputs have to move) rather than for path shape.
//
// PLAUSIBILITY LIVES IN THE INPUTS, NOT THE SHAPE. That is what makes this
// different from every previous attempt, and why it does not foreclose:
//   - a hover or a straight leg needs constant inputs and is therefore FREE;
//   - an orbit needs a steady yaw rate: cheap, and correctly so, because
//     orbiting a subject is ordinary;
//   - an aggressive but deliberate manoeuvre needs a few large input changes:
//     affordable, and it stays reachable if the sightlines really demand it;
//   - the 61-revolution corkscrew needs the heading to sweep ~22,000 degrees,
//     which costs enormously. It is not banned, it is priced — and it never
//     bought more than 0.011 degrees, so it will not survive the price.
//
// The knot count K is the one real assumption: it says a flight over this clip
// is describable by K held inputs. Raise it and the model approaches the free
// one (and its overfitting); lower it and it approaches a single flight mode.

import {PhysicsModel} from "./PhysicsModel";

const DEG = Math.PI / 180;

// Knot count the effort weights were calibrated at. Costs are normalised to
// this so that raising K for a longer clip does not change what an ordinary
// manoeuvre costs.
const REFERENCE_KNOTS = 4;

/**
 * Recover the control history a drone would need in order to fly a given
 * ground track: horizontal speed, unwrapped heading, and climb rate per frame.
 *
 * Heading is UNWRAPPED (continuous, not folded to +-180) because the whole
 * point is to measure how far it has to travel. A corkscrew's heading marches
 * off to thousands of degrees, and that must be visible to the effort term
 * rather than hidden by wrapping.
 *
 * Differencing is over a half-window of `smooth` frames on each side so that
 * per-frame jitter in the seed track does not masquerade as control activity.
 */
export function inverseControls(track, times, count, smooth = 3) {
    const speed = new Float64Array(count);
    const heading = new Float64Array(count);
    const climb = new Float64Array(count);
    const h = Math.max(1, Math.round(smooth));

    let prev = null;
    for (let f = 0; f < count; f++) {
        const a = Math.max(0, f - h), b = Math.min(count - 1, f + h);
        const dt = (times[b] - times[a]) || 1e-6;
        const vx = (track[b * 3] - track[a * 3]) / dt;
        const vy = (track[b * 3 + 1] - track[a * 3 + 1]) / dt;
        const vz = (track[b * 3 + 2] - track[a * 3 + 2]) / dt;
        speed[f] = Math.hypot(vx, vy);
        climb[f] = vz;

        // Heading is undefined when barely moving; hold the previous one so a
        // hover does not inject spurious control activity (the same failure the
        // metrics code has at trackMetrics' HEADING_MIN_HORIZ_SPEED).
        let hd;
        if (speed[f] > 0.05) {
            hd = Math.atan2(vx, vy) / DEG;
            if (prev !== null) {
                // unwrap onto the previous value
                let d = hd - prev;
                while (d > 180) { hd -= 360; d -= 360; }
                while (d < -180) { hd += 360; d += 360; }
            }
            prev = hd;
        } else {
            hd = prev ?? 0;
        }
        heading[f] = hd;
    }
    return {speed, heading, climb};
}

/**
 * Knots needed for a clip of this length. The modelling claim is that a flight
 * is a few HELD inputs, so knot SPACING is what should stay roughly fixed: a
 * pilot changes something every tens of seconds regardless of how long you
 * filmed them.
 *
 * K=4 was adequate on 60 s synthetic scenes and hopeless on the 667 s Generated
 * Orbit Test, where it meant one held input per 167 s — the fit could not
 * describe any real flight, let alone the orbit actually present (residual
 * 4.29 deg, 1268 m from truth, and it corkscrewed anyway).
 *
 * Capped because the parameter count is 1 + 3K and the search must stay
 * tractable; floored at 4 so short clips behave as before.
 */
export function knotsForDuration(seconds, spacingSec = 45, min = 4, max = 12) {
    if (!Number.isFinite(seconds) || seconds <= 0) return min;
    return Math.max(min, Math.min(max, Math.round(seconds / spacingSec) + 1));
}

/** Sample a per-frame series onto K evenly spaced knots in time. */
export function toKnots(series, count, K) {
    const knots = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        const idx = K === 1 ? (count - 1) / 2 : Math.round(k * (count - 1) / (K - 1));
        knots[k] = series[Math.max(0, Math.min(count - 1, idx))];
    }
    return knots;
}

/** Piecewise-linear interpolation of K knots spanning [0, T]. */
function knotValue(knots, K, t, T) {
    if (K === 1) return knots[0];
    const u = Math.max(0, Math.min(1, T > 0 ? t / T : 0)) * (K - 1);
    const i = Math.min(K - 2, Math.floor(u));
    const f = u - i;
    return knots[i] * (1 - f) + knots[i + 1] * f;
}

/**
 * The model. Parameters are [initialRange, speed knots..., heading knots...,
 * climb knots...]; controls are piecewise-linear between knots, and the ground
 * velocity follows directly. Like the other kinematic models the derivative is
 * a function of time alone, so RK4 is exact quadrature.
 */
export class DroneControlModel extends PhysicsModel {
    // The controls are piecewise-linear knots spaced tens of seconds apart, so
    // the derivative varies slowly and RK4 needs no fine step. 1/30 s (copied
    // from the frame rate) made a long clip integrate ~20,000 substeps per cost
    // evaluation — with the duration-scaled knot count (K up to 12 => 37 params)
    // the DE fit took minutes. 0.25 s (matching SkyLanternModel) resolves each
    // ~60 s knot segment with hundreds of substeps at ~7x the speed, with no
    // measurable accuracy loss on so smooth an ODE.
    maxDt = 0.25;

    constructor(K = 4) {
        super();
        this.K = Math.max(1, Math.round(K));
        // Seed knots, set by seedFromTrack(). Also used as the reference the
        // effort term measures deviation from, so a fit that simply reproduces
        // the geometric seed pays nothing extra.
        this.seed = null;
        this._T = 1;

        // Cost weights, in fit-cost units (errSigma = 0.02 deg each, so 1 unit
        // = 0.02 deg of residual budget). Deliberately modest: these should
        // decide between fits that are otherwise close, not overrule geometry.
        this.wHeadingRate = 0.02;   // per (deg/s)^2 of sustained yaw rate, integrated
        // Speed and climb are HELD settings changed occasionally, so their effort
        // is the TOTAL VARIATION of the setting over the clip (sum of |changes|),
        // squared — knot-invariant (splitting or merging a change does not alter
        // the total) and duration-invariant (a 10 m/s change is a 10 m/s change
        // however long the clip). 0.0167 preserves the previous per-interval
        // calibration for a monotonic change at the reference knot count (the old
        // sum-of-squares form gave w*ΔV²/3 there); see TA-10.
        this.wSpeedChange = 0.0167;   // per (m/s)^2 of total speed variation
        this.wClimbChange = 0.0167;   // per (m/s)^2 of total climb variation
    }

    getName() { return "Drone (control-input fit)"; }

    /**
     * Seed from a track that already fits the sightlines — a global fit or the
     * plausible least-manoeuvring path. This sets both the initial guess and
     * the reference for the effort term.
     */
    seedFromTrack(track, dataset) {
        const {times, count} = dataset;
        this._T = (times[count - 1] - times[0]) || 1;
        const c = inverseControls(track, times, count);
        const b = 0;
        const r0 = Math.hypot(
            track[b] - dataset.sensorPos[b],
            track[b + 1] - dataset.sensorPos[b + 1],
            track[b + 2] - dataset.sensorPos[b + 2]);
        this.seed = {
            range: r0,
            speed: toKnots(c.speed, count, this.K),
            heading: toKnots(c.heading, count, this.K),
            climb: toKnots(c.climb, count, this.K),
        };
        return this.seed;
    }

    /** Initial guess vector matching getParameterDefs order. */
    seedParams() {
        if (!this.seed) return null;
        const h = this.seed.heading;
        const hd = [h[0]];
        for (let k = 0; k < this.K - 1; k++) {
            // Clamp to the increment bound so the seed is never silently
            // repaired by the optimizer into something the caller did not ask
            // for — a seed outside its own bounds is a bug worth surfacing, not
            // absorbing.
            hd.push(Math.max(-1440, Math.min(1440, h[k + 1] - h[k])));
        }
        return [this.seed.range, ...this.seed.speed, ...hd, ...this.seed.climb];
    }

    /**
     * Whether the seed had to be clamped to fit the parameter bounds, and by
     * how much. A silently clamped seed means the fit starts somewhere the
     * caller did not intend — most likely on a genuinely turning flight, which
     * is exactly the case this model must not mishandle.
     */
    seedClamping() {
        if (!this.seed) return null;
        const h = this.seed.heading;
        let worst = 0, count = 0;
        for (let k = 0; k < this.K - 1; k++) {
            const d = h[k + 1] - h[k];
            const over = Math.abs(d) - 1440;
            if (over > 0) { count++; worst = Math.max(worst, over); }
        }
        return count ? {intervals: count, worstExcessDeg: worst} : null;
    }

    getParameterDefs() {
        const K = this.K;
        const s = this.seed;
        const defs = [{
            name: "initialRange",
            min: 50, max: 20000,
            default: s ? s.range : 2000, scale: 500,
        }];
        for (let k = 0; k < K; k++) {
            defs.push({name: `speed${k}`, min: 0, max: 30,
                default: s ? s.speed[k] : 5, scale: 2});
        }
        // Initial heading, then per-interval increments. Bounding the
        // INCREMENT is a statement about flying ("how far can it turn in this
        // interval"); bounding an absolute unwrapped heading is not, and the
        // previous +-720 per-knot clamp silently truncated genuinely turning
        // flights. The increment bound is deliberately generous — a full
        // revolution per interval — so manoeuvring stays reachable and is
        // priced by the effort term rather than forbidden by the bound.
        const h0 = s ? s.heading[0] : 0;
        defs.push({name: "heading0", min: h0 - 180, max: h0 + 180, default: h0, scale: 30});
        for (let k = 0; k < K - 1; k++) {
            const d = s ? (s.heading[k + 1] - s.heading[k]) : 0;
            // Generous by design: 4 revolutions per interval. The bound must
            // NOT be what limits turning — the effort term prices it, and a
            // bound tight enough to bite would foreclose aggressive but genuine
            // manoeuvring, which is the one thing this model must not do.
            defs.push({name: `headingDelta${k}`, min: -1440, max: 1440,
                default: Math.max(-1440, Math.min(1440, d)), scale: 20});
        }
        for (let k = 0; k < K; k++) {
            defs.push({name: `climb${k}`, min: -8, max: 8,
                default: s ? s.climb[k] : 0, scale: 1});
        }
        return defs;
    }

    _controls(params, t) {
        const K = this.K, T = this._T;
        const sp = knotValue(params.slice(1, 1 + K), K, t, T);
        // Heading knots are reconstructed from the initial value + increments.
        const hk = new Float64Array(K);
        hk[0] = params[1 + K];
        for (let k = 1; k < K; k++) hk[k] = hk[k - 1] + this._headingDelta(params, k - 1);
        const hd = knotValue(hk, K, t, T);
        const cl = knotValue(params.slice(1 + 2 * K, 1 + 3 * K), K, t, T);
        return [sp, hd, cl];
    }

    getInitialState(params, dataset) {
        const t = dataset.times;
        this._T = (t && t.length > 1) ? (t[t.length - 1] - t[0]) : 1;
        const r = params[0];
        return [
            dataset.sensorPos[0] + r * dataset.losDir[0],
            dataset.sensorPos[1] + r * dataset.losDir[1],
            dataset.sensorPos[2] + r * dataset.losDir[2],
        ];
    }

    derivatives(state, params, t) {
        const [sp, hd, cl] = this._controls(params, t);
        const th = hd * DEG;
        return [sp * Math.sin(th), sp * Math.cos(th), cl];
    }

    /**
     * Control EFFORT, not path shape. Three terms, all measuring how much the
     * inputs must move:
     *   - sustained yaw rate between knots (this is what prices a corkscrew:
     *     22,000 degrees of heading travel is enormous, while a steady orbit is
     *     a few degrees per second and cheap);
     *   - speed changes between knots;
     *   - climb changes between knots.
     * Holding any input costs nothing, which is the whole modelling claim.
     */
    extraCost(params, dataset, T) {
        const terms = this.extraCostTerms(params, dataset, T);
        let sum = 0;
        for (const k of Object.keys(terms)) sum += terms[k];
        return sum;
    }

    extraCostTerms(params, dataset, T) {
        const K = this.K;
        if (K < 2) return {};
        const dur = T || this._T || 1;
        const span = dur / (K - 1);            // seconds per knot interval
        // Nominal span at the REFERENCE knot count. Every term is scaled by
        // (span / sRef) so it behaves as an INTEGRAL of effort over the clip
        // rather than a sum over intervals.
        //
        // This is the single most important correction in the model. The first
        // version summed squared per-interval rates, so for a fixed physical
        // flight with total heading change H the cost came out
        //     (K-1) * w * (H/T)^2
        // — LINEAR IN K. Raising K to get the resolution needed for a long clip
        // simultaneously multiplied the price of an ordinary turn, so every
        // remedy for the measured under-recovery of manoeuvres made the bias
        // toward straight flight worse. It also rewarded SMEARING: concentrating
        // a turn into one interval cost m times what spreading it over m did,
        // which is precisely backwards for representing a real course change.
        //
        // With the (span / sRef) factor the same flight costs the same at any K,
        // and calibration at the reference K is preserved.
        const sRef = dur / (REFERENCE_KNOTS - 1);
        const norm = span / sRef;
        // Yaw is a sustained RATE integrated over time (norm makes it a time
        // integral, knot-invariant). Speed and climb are total-VARIATION of a
        // held setting: accumulate the absolute changes, then square the total
        // once outside the loop, so the cost depends only on how far the setting
        // moved in all, not on how many knots it was chunked across (TA-10).
        let yaw = 0, spdTV = 0, clbTV = 0;
        for (let k = 0; k < K - 1; k++) {
            const dh = this._headingDelta(params, k);
            const rate = dh / span;             // deg/s over this interval
            yaw += this.wHeadingRate * rate * rate * norm;
            spdTV += Math.abs(params[1 + k + 1] - params[1 + k]);
            clbTV += Math.abs(params[1 + 2 * K + k + 1] - params[1 + 2 * K + k]);
        }
        // (total variation)^2 — knot- and duration-invariant.
        const spd = this.wSpeedChange * spdTV * spdTV;
        const clb = this.wClimbChange * clbTV * clbTV;
        const out = {};
        if (yaw > 0) out["yaw input"] = yaw;
        if (spd > 0) out["speed changes"] = spd;
        if (clb > 0) out["climb changes"] = clb;
        return out;
    }

    /**
     * Heading change across interval k. Heading is parameterised as an initial
     * value plus per-interval INCREMENTS rather than K absolute values, so that
     * a bound means "how much can it turn in this interval" — a statement about
     * flying — instead of "where can the heading be", which is meaningless once
     * the value is unwrapped and can legitimately run to thousands of degrees.
     * It also removes the absolute +-720 clamp the first version imposed on
     * each knot, which silently truncated any genuinely turning flight.
     */
    _headingDelta(params, k) {
        return params[1 + this.K + 1 + k];
    }

    /** Absolute heading at knot index k, from the initial value + increments. */
    _headingAt(params, k) {
        let h = params[1 + this.K];
        for (let i = 0; i < k; i++) h += this._headingDelta(params, i);
        return h;
    }

    /** Total heading travel in degrees — the headline plausibility readout. */
    headingTravelDeg(params) {
        let total = 0;
        for (let k = 0; k < this.K - 1; k++) total += Math.abs(this._headingDelta(params, k));
        return total;
    }

    describe(params) {
        const K = this.K;
        const travel = this.headingTravelDeg(params);
        const sp = [];
        for (let k = 0; k < K; k++) sp.push(params[1 + k]);
        const smin = Math.min(...sp) * 1.94384, smax = Math.max(...sp) * 1.94384;
        const spTxt = (smax - smin) < 2
            ? `holding ${smax.toFixed(0)} kt`
            : `varying ${smin.toFixed(0)}-${smax.toFixed(0)} kt`;
        const hdTxt = travel < 20 ? "on a steady heading"
            : travel < 200 ? `turning through ${travel.toFixed(0)}°`
            : `turning through ${(travel / 360).toFixed(1)} full revolutions`;
        return `${spTxt}, ${hdTxt}, at ${(params[0] / 1852).toFixed(2)} NM`;
    }
}
