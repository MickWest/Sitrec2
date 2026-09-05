// Base class for physics trajectory models.
// Subclasses define parameters, initial state, and dynamics (the ODE).
// The fitting system integrates the ODE forward and scores against LOS data.

export class PhysicsModel {
    // Maximum RK4 substep in seconds. Stiff models (e.g. quadratic drag)
    // need small steps; smooth kinematic models can override with a larger
    // value for speed.
    maxDt = 0.02;

    // Return array of parameter definitions:
    // [{name, min, max, default, scale}, ...]
    // 'scale' is the initial simplex perturbation for Nelder-Mead
    getParameterDefs() {
        return [];
    }

    // Return display name for the UI dropdown
    getName() {
        return "Base Model";
    }

    // Given optimized parameter array and dataset, return initial state [x,y,z, vx,vy,vz]
    // sensorPos/losDir at frame 0 are provided for computing initial position along LOS
    getInitialState(params, dataset) {
        return [0, 0, 0, 0, 0, 0];
    }

    // ODE right-hand side: given state [x,y,z, vx,vy,vz], params array, time t,
    // return derivatives [dx,dy,dz, dvx,dvy,dvz]
    derivatives(state, params, t) {
        return [state[3], state[4], state[5], 0, 0, 0];
    }

    // Additional cost added to the mean-angular-error cost during fitting.
    // Lets a model express soft plausibility priors (pure LOS angular error
    // is hugely ambiguous — near-perfect fits exist over a wide family of
    // turning trajectories). T is the total duration in seconds.
    // Must be scale-compatible with the fit cost: the angular-error term is
    // meanErrorDegrees / errSigma (see fitPhysicsModel in LOSFitting.js).
    extraCost(params, dataset, T) {
        return 0;
    }

    // The same soft priors, itemised for DISPLAY only: {label: costUnits}.
    //
    // Why this exists separately rather than extraCost() being built from it:
    // extraCost is inside the optimizer's inner loop, and summing an itemised
    // object would reorder the floating-point additions, which can nudge the
    // search onto a different path. Reporting must not perturb the fit, so the
    // two are deliberately parallel implementations and a test asserts they
    // agree (tests/PhysicsPriorDisclosure.test.js).
    //
    // Needed because the fit's reported errDeg is recomputed as PURE angular
    // error (see fitPhysicsModel), deliberately excluding these terms — so a
    // prior can move the solution while being invisible in the number the UI
    // prints. Itemising them lets the UI say how much of the fit budget the
    // priors consumed, instead of the tile claiming a value was "inferred, not
    // assumed" when a prior helped choose it.
    extraCostTerms(params, dataset, T) {
        const total = this.extraCost(params, dataset, T);
        return total ? {"model priors": total} : {};
    }
}

// 4th-order Runge-Kutta integrator
// Starts at sampleTimes[0], landing exactly on every requested sample time.
// Fitting can override the substep cap and retain its existing divergence guard.
// Stage scratch is local to the integration; saved output states own their arrays.
export function integrateRK4(model, initialState, params, sampleTimes, {
    maxDt: maxDtOverride, checkDivergence = false,
} = {}) {
    const states = [];
    const state = initialState.slice();
    const n = state.length;
    let t = sampleTimes[0];
    let sampleIdx = 0;

    // Adaptive substep: model-defined cap for stability (default 0.02s)
    const maxDt = maxDtOverride ?? model.maxDt ?? 0.02;
    const stages = [new Array(n), new Array(n), new Array(n)];

    // Record initial state
    if (sampleIdx < sampleTimes.length && Math.abs(t - sampleTimes[sampleIdx]) < 1e-10) {
        states.push(state.slice());
        sampleIdx++;
    }

    while (sampleIdx < sampleTimes.length) {
        const tNext = sampleTimes[sampleIdx];
        while (t < tNext - 1e-10) {
            const dt = Math.min(maxDt, tNext - t);
            rk4Step(model, state, params, t, dt, n, stages);
            t += dt;
            if (checkDivergence && (Math.abs(state[0]) > 1e8 || Math.abs(state[2]) > 1e6)) {
                throw new Error("diverged");
            }
        }
        t = tNext; // snap to exact sample time
        states.push(state.slice());
        sampleIdx++;
    }

    return states;
}

function rk4Step(model, state, params, t, dt, n, [s2, s3, s4]) {
    const k1 = model.derivatives(state, params, t);

    for (let i = 0; i < n; i++) s2[i] = state[i] + 0.5 * dt * k1[i];
    const k2 = model.derivatives(s2, params, t + 0.5 * dt);

    for (let i = 0; i < n; i++) s3[i] = state[i] + 0.5 * dt * k2[i];
    const k3 = model.derivatives(s3, params, t + 0.5 * dt);

    for (let i = 0; i < n; i++) s4[i] = state[i] + dt * k3[i];
    const k4 = model.derivatives(s4, params, t + dt);

    for (let i = 0; i < n; i++) {
        state[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    }
}
