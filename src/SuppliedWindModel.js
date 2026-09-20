import {PhysicsModel, integrateRK4} from "./PhysicsModel";

const WIND_PARAMETERS = new Set([
    "windE", "windN", "shearPerM", "windDriftE", "windDriftN", "windCurveE", "windCurveN",
]);

/**
 * Fit the same object dynamics with the supplied per-frame wind held fixed.
 * Wind coordinates are removed from the optimizer, including the balloon's
 * shear and temporal terms. Adding the supplied ENU velocity to the zero-wind
 * dynamics preserves the entire input field, rather than replacing it with a
 * single average or silently fitting a correction to it.
 */
export class SuppliedWindModel extends PhysicsModel {
    constructor(model, dataset, {correctionSigmaMS = null} = {}) {
        super();
        this.model = model;
        this.dataset = dataset;
        this.correctionSigmaMS = correctionSigmaMS;
        if (correctionSigmaMS !== null && !(Number.isFinite(correctionSigmaMS) && correctionSigmaMS > 0)) {
            throw new Error("Wind correction uncertainty must be positive");
        }
        this.maxDt = model.maxDt;
        this.defs = model.getParameterDefs();
        this.indices = this.defs.map((d, i) => WIND_PARAMETERS.has(d.name)
            && !(correctionSigmaMS !== null && ["windE", "windN"].includes(d.name)) ? -1 : i).filter(i => i >= 0);
        this.drift = new Float64Array(dataset.n * 3);
        for (let f = 1; f < dataset.n; f++) for (let axis = 0; axis < 3; axis++) {
            this.drift[f * 3 + axis] = this.drift[(f - 1) * 3 + axis] + dataset.W[(f - 1) * 3 + axis];
        }
    }

    getName() { return this.model.getName(); }
    getParameterDefs() { return this.indices.map(i => this.defs[i]); }

    expand(params) {
        const full = this.defs.map(d => WIND_PARAMETERS.has(d.name) ? 0 : d.default);
        this.indices.forEach((index, i) => { full[index] = params[i]; });
        return full;
    }

    getInitialState(params, dataset) {
        return this.model.getInitialState(this.expand(params), dataset);
    }

    derivatives(state, params, t) {
        const result = this.model.derivatives(state, this.expand(params), t);
        const {n, fps, W} = this.dataset;
        // W[f] is the displacement over [f, f+1]. Use that same interval
        // convention for both integration and the air-relative metrics.
        const frame = Math.max(0, Math.min(n - 1, Math.floor(t * fps + 1e-9)));
        for (let axis = 0; axis < 3; axis++) result[axis] += W[frame * 3 + axis] * fps;
        if (this.model.geodeticVerticalSpeed) result[2] -=
            (state[0] * W[frame * 3] + state[1] * W[frame * 3 + 1]) * fps / 6371000;
        return result;
    }

    // Integrate in coordinates translated by the exact cumulative wind drift.
    // RK4 then sees only smooth object dynamics: a coarse search step cannot
    // skip changes in the supplied series or smear a discontinuity at a frame.
    integrate(initialState, params, times, options) {
        const full = this.expand(params);
        const offset = (t, axis) => {
            const f = Math.max(0, Math.min(this.dataset.n - 1, t * this.dataset.fps));
            const lo = Math.floor(f), hi = Math.min(this.dataset.n - 1, lo + 1);
            return this.drift[lo * 3 + axis] * (1 - (f - lo)) + this.drift[hi * 3 + axis] * (f - lo);
        };
        const relative = initialState.slice();
        for (let axis = 0; axis < 3; axis++) relative[axis] -= offset(times[0], axis);
        const dynamics = {
            maxDt: this.maxDt,
            derivatives: (state, _params, t) => {
                const actual = state.slice();
                for (let axis = 0; axis < 3; axis++) actual[axis] += offset(t, axis);
                const result = this.model.derivatives(actual, full, t);
                if (this.model.geodeticVerticalSpeed) {
                    const f = Math.max(0, Math.min(this.dataset.n - 2, Math.floor(t * this.dataset.fps + 1e-9)));
                    result[2] -= (actual[0] * this.dataset.W[f * 3]
                        + actual[1] * this.dataset.W[f * 3 + 1]) * this.dataset.fps / 6371000;
                }
                return result;
            },
        };
        const states = integrateRK4(dynamics, relative, params, times, options);
        for (let f = 0; f < times.length; f++) for (let axis = 0; axis < 3; axis++) {
            states[f][axis] += offset(times[f], axis);
        }
        return states;
    }

    extraCost(params, dataset, duration) {
        return Object.values(this.extraCostTerms(params, dataset, duration)).reduce((a, b) => a + b, 0);
    }

    extraCostTerms(params, dataset, duration) {
        const full = this.expand(params);
        const terms = this.model.extraCostTerms(full, dataset, duration);
        // Supplied wind is an input, not a reason to penalize a vehicle. In
        // correction mode the weather-uncertainty prior REPLACES calm priors.
        for (const key of Object.keys(terms)) if (/wind/i.test(key)) delete terms[key];
        if (this.correctionSigmaMS !== null) {
            const at = name => full[this.defs.findIndex(d => d.name === name)] ?? 0;
            terms["supplied wind correction"] = (at("windE") ** 2 + at("windN") ** 2) / this.correctionSigmaMS ** 2;
        }
        return terms;
    }
}
