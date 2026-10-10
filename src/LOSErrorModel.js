// Statistics and synthesis only: this module has no scene, file or network access.
import {generateWobbleOffsets} from "./TrackingWobbleMath";
import {mulberry32} from "./DifferentialEvolution";
import {t} from "./i18n";

// Angles use the spherical log map, in degrees, in a local horizontal/vertical
// tangent frame. The horizontal axis is local up × the reference direction, so a
// positive horizontal error is to the left of the reference bearing (counter-clockwise
// seen from above) and a positive vertical error is up. The portable model deliberately
// has no empirical samples.
const DEG = Math.PI / 180;
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = vector => {
    const length = Math.hypot(...vector);
    return length > 1e-12 && vector.every(Number.isFinite) ? vector.map(component => component / length) : null;
};

export const quantile = (values, q) => {
    if (!values.length) return null;
    const sorted = [...values].sort((x, y) => x - y);
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (position - lower);
};

// The [horizontal, vertical] unit axes of the tangent frame at a direction.
function basis(direction, up) {
    let horizontal = unit(cross(up, direction));
    // Deterministic fallback at zenith/nadir; the horizontal axis is ambiguous there.
    if (!horizontal) horizontal = unit(cross(Math.abs(direction[0]) < .9 ? [1, 0, 0] : [0, 1, 0], direction));
    return [horizontal, cross(direction, horizontal)];
}

/** Exact angular residual; null for invalid geometry or antipodal ambiguity. */
export function angularResidual(sensor, target, observed, up = [0, 0, 1]) {
    const clean = unit(target.map((value, axis) => value - sensor[axis]));
    const measured = unit(observed);
    if (!clean || !measured || !unit(up)) return null;
    const cosine = Math.max(-1, Math.min(1, dot(clean, measured)));
    const sine = Math.hypot(...cross(clean, measured));
    const angle = Math.atan2(sine, cosine);
    if (Math.PI - angle < 1e-6) return null;
    const [horizontal, vertical] = basis(clean, up);
    const scale = sine > 1e-12 ? angle / sine / DEG : 1 / DEG;
    return [dot(measured, horizontal) * scale, dot(measured, vertical) * scale];
}

/** Apply a new error realization to arbitrary sensor/target positions. */
export function directionWithError(sensor, target, error, up = [0, 0, 1]) {
    const clean = unit(target.map((value, axis) => value - sensor[axis]));
    if (!clean || !error.every(Number.isFinite) || !unit(up)) return null;
    const radius = Math.hypot(...error);
    const angle = radius * DEG;
    if (angle >= Math.PI) return null;
    if (radius < 1e-12) return clean;
    const [horizontal, vertical] = basis(clean, up);
    return clean.map((component, axis) => component * Math.cos(angle)
        + (horizontal[axis] * error[0] + vertical[axis] * error[1]) / radius * Math.sin(angle));
}

export function cadence(samples) {
    const intervals = samples.slice(1).map((sample, index) => sample.t - samples[index].t)
        .filter(interval => interval > 0 && Number.isFinite(interval));
    const dt = quantile(intervals, .5);
    return {
        hz: dt ? 1 / dt : null,
        dt,
        gaps: dt ? intervals.filter(interval => interval > 1.5 * dt).length : 0,
        intervalP05: quantile(intervals, .05),
        intervalP95: quantile(intervals, .95),
    };
}

/** Nearest recorded samples, anchored at the first sample. No averaging,
 * interpolation, duplicate reuse, or gap filling. Upsampling is unavailable. */
export function sampleAtRate(samples, hz) {
    const sourceCadence = cadence(samples);
    if (!(hz > 0) || !sourceCadence.hz || hz > sourceCadence.hz * 1.01) return null;
    if (Math.abs(hz - sourceCadence.hz) / hz < .001) return [...samples];
    const selected = [];
    const firstTime = samples[0].t;
    const lastTime = samples.at(-1).t;
    let sampleIndex = 0;
    let previousIndex = -1;
    for (let outputIndex = 0; firstTime + outputIndex / hz <= lastTime + 1e-8; outputIndex++) {
        const time = firstTime + outputIndex / hz;
        while (sampleIndex + 1 < samples.length
            && Math.abs(samples[sampleIndex + 1].t - time) < Math.abs(samples[sampleIndex].t - time)) sampleIndex++;
        if (sampleIndex !== previousIndex && Math.abs(samples[sampleIndex].t - time) <= sourceCadence.dt * .55) {
            selected.push(samples[sampleIndex]);
            previousIndex = sampleIndex;
        }
    }
    return selected;
}

// Correlation of each axis with itself `lag` seconds later, over the pairs of samples
// that are that far apart (to a quarter of a sample interval).
function correlation(samples, lag, means, dt) {
    let laterIndex = 0;
    const sumFirstSquared = [0, 0];
    const sumSecondSquared = [0, 0];
    const sumProducts = [0, 0];
    let pairs = 0;
    for (let index = 0; index < samples.length; index++) {
        laterIndex = Math.max(laterIndex, index + 1);
        const wanted = samples[index].t + lag;
        while (laterIndex + 1 < samples.length
            && Math.abs(samples[laterIndex + 1].t - wanted) < Math.abs(samples[laterIndex].t - wanted)) laterIndex++;
        if (laterIndex >= samples.length || Math.abs(samples[laterIndex].t - wanted) > dt * .25) continue;
        pairs++;
        for (let axis = 0; axis < 2; axis++) {
            const first = samples[index].e[axis] - means[axis];
            const second = samples[laterIndex].e[axis] - means[axis];
            sumFirstSquared[axis] += first * first;
            sumSecondSquared[axis] += second * second;
            sumProducts[axis] += first * second;
        }
    }
    return {
        seconds: lag,
        pairs,
        axes: sumProducts.map((product, axis) => pairs >= 5 && sumFirstSquared[axis] * sumSecondSquared[axis] > 1e-20
            ? product / Math.sqrt(sumFirstSquared[axis] * sumSecondSquared[axis]) : null),
    };
}

export function summarizeErrors(samples) {
    if (samples.length < 2) throw new Error(t("losErrorAnalysis.model.twoSamples"));
    const n = samples.length;
    const sampleCadence = cadence(samples);
    const mean = [0, 1].map(axis => samples.reduce((sum, row) => sum + row.e[axis], 0) / n);
    const variance = [0, 1].map(axis => samples.reduce((sum, row) => sum + (row.e[axis] - mean[axis]) ** 2, 0) / n);
    const sigma = variance.map(Math.sqrt);
    const radial = samples.map(row => Math.hypot(...row.e));
    const centered = samples.map(row => Math.hypot(row.e[0] - mean[0], row.e[1] - mean[1]));
    const covariance = samples.reduce((sum, row) => sum + (row.e[0] - mean[0]) * (row.e[1] - mean[1]), 0) / n;
    const moments = power => [0, 1].map(axis => sigma[axis] > 1e-12
        ? samples.reduce((sum, row) => sum + ((row.e[axis] - mean[axis]) / sigma[axis]) ** power, 0) / n : null);
    const lags = [...new Set([sampleCadence.dt, .1, .2, .5, 1, 2, 5, 10, 20, 30]
        .filter(lag => lag >= sampleCadence.dt * .99 && lag <= (samples.at(-1).t - samples[0].t) / 3))];
    const acf = lags.sort((a, b) => a - b).map(lag => correlation(samples, lag, mean, sampleCadence.dt));
    const increments = [];
    for (let index = 1; index < n; index++) {
        if (samples[index].t - samples[index - 1].t <= 1.5 * sampleCadence.dt) {
            increments.push(Math.hypot(samples[index].e[0] - samples[index - 1].e[0], samples[index].e[1] - samples[index - 1].e[1]));
        }
    }
    const blocks = Array.from({length: 3}, (_, block) => {
        const rows = samples.slice(Math.floor(block * n / 3), Math.floor((block + 1) * n / 3));
        return {
            mean: [0, 1].map(axis => rows.reduce((sum, row) => sum + row.e[axis], 0) / rows.length),
            rms: Math.sqrt(rows.reduce((sum, row) => sum + dot(row.e, row.e), 0) / rows.length),
        };
    });
    return {
        n,
        ...sampleCadence,
        duration: samples.at(-1).t - samples[0].t,
        mean,
        sigma,
        covariance,
        axisCorrelation: sigma[0] * sigma[1] > 1e-20 ? covariance / (sigma[0] * sigma[1]) : null,
        radialRms: Math.sqrt(radial.reduce((sum, value) => sum + value * value, 0) / n),
        radialMean: radial.reduce((sum, value) => sum + value, 0) / n,
        radialP50: quantile(radial, .5),
        radialP95: quantile(radial, .95),
        radialP99: quantile(radial, .99),
        radialMax: radial.reduce((maximum, value) => Math.max(maximum, value), 0),
        centeredRms: Math.sqrt(variance[0] + variance[1]),
        centeredP95: quantile(centered, .95),
        skewness: moments(3),
        excessKurtosis: moments(4).map(value => value === null ? null : value - 3),
        incrementRms: increments.length
            ? Math.sqrt(increments.reduce((sum, value) => sum + value * value, 0) / increments.length) : null,
        acf,
        blocks,
    };
}

export function analyzeErrors(samples) {
    const valid = [];
    const rejected = {invalid: 0, nonIncreasingTime: 0};
    for (const sample of samples) {
        if (!Number.isFinite(sample.t) || !sample.e || sample.e.length !== 2 || !sample.e.every(Number.isFinite)) {
            rejected.invalid++;
            continue;
        }
        if (valid.length && sample.t <= valid.at(-1).t) {
            rejected.nonIncreasingTime++;
            continue;
        }
        valid.push(sample);
    }
    const views = [
        {label: "Original", samples: valid},
        ...[10, 1].map(hz => ({label: `${hz} Hz`, samples: sampleAtRate(valid, hz)})),
    ].map(view => ({...view, summary: view.samples?.length >= 2 ? summarizeErrors(view.samples) : null}));
    return {samples: valid, rejected, views};
}

// Burg lattice fits each axis, choosing a small stationary AR order by BIC.
// Missing records split segments; never manufacture adjacency across a gap.
function fitAxis(samples, axis, mean, dt) {
    const forward = samples.map(row => row.e[axis] - mean);
    const backward = [...forward];
    let coefficients = [];
    let variance = dot(forward, forward) / samples.length;
    let best = {reflection: [], coeff: [], variance, bic: samples.length * Math.log(Math.max(variance, 1e-30))};
    const reflections = [];
    const maxOrder = Math.min(20, Math.floor(samples.length / 20), Math.max(1, Math.round(2 / dt)));
    for (let order = 1; order <= maxOrder; order++) {
        let numerator = 0;
        let denominator = 0;
        let count = 0;
        for (let index = order; index < samples.length; index++) {
            if (samples[index].t - samples[index - order].t < dt * (order + .25)) {
                numerator += forward[index] * backward[index - 1];
                denominator += forward[index] ** 2 + backward[index - 1] ** 2;
                count++;
            }
        }
        if (count < 20 || denominator < 1e-24) break;
        const reflection = Math.max(-.98, Math.min(.98, 2 * numerator / denominator));
        // Levinson step-up: the order-n AR coefficients from order n-1 and the new reflection.
        const previous = [...coefficients];
        coefficients = previous.map((coefficient, index) => coefficient - reflection * previous[previous.length - 1 - index]);
        coefficients.push(reflection);
        reflections.push(reflection);
        // Lattice update of the forward and backward prediction errors.
        const previousForward = [...forward];
        const previousBackward = [...backward];
        for (let index = order; index < samples.length; index++) {
            forward[index] = previousForward[index] - reflection * previousBackward[index - 1];
            backward[index] = previousBackward[index - 1] - reflection * previousForward[index];
        }
        variance *= 1 - reflection * reflection;
        const bic = samples.length * Math.log(Math.max(variance, 1e-30)) + order * Math.log(samples.length);
        if (bic < best.bic) best = {reflection: [...reflections], coeff: [...coefficients], variance, bic};
    }
    return best;
}

export function fitErrorModel(samples) {
    const summary = summarizeErrors(samples);
    const {mean, dt, hz} = summary;
    const amplitudeOnly = () => validateErrorModel({
        schema: "sitrec-los-error-model", version: 1, basis: "local-up-cross-clean-los", sampleRateHz: hz,
        meanDeg: mean, reflection: [[], []], innovationSigmaDeg: summary.sigma,
        innovationCorrelation: summary.axisCorrelation ?? 0, innovationDistribution: "gaussian",
    });
    // A short clip still has a portable amplitude/bias model, but does not
    // provide enough observations to estimate temporal memory reliably.
    if (samples.length < 20) return amplitudeOnly();
    const axisFits = [0, 1].map(axis => fitAxis(samples, axis, mean[axis], dt));
    const order = Math.max(...axisFits.map(fit => fit.coeff.length));
    const innovations = [];
    for (let index = order; index < samples.length; index++) {
        if (index > 0 && samples[index].t - samples[Math.max(0, index - order - 1)].t > dt * (order + 1.25)) continue;
        innovations.push([0, 1].map(axis => {
            let value = samples[index].e[axis] - mean[axis];
            axisFits[axis].coeff.forEach((coefficient, lag) => value -= coefficient * (samples[index - lag - 1].e[axis] - mean[axis]));
            return value;
        }));
    }
    if (innovations.length < 10) return amplitudeOnly();
    const residual = summarizeErrors(innovations.map((error, index) => ({t: index * dt, e: error})));
    const model = {
        schema: "sitrec-los-error-model", version: 1, basis: "local-up-cross-clean-los", sampleRateHz: hz,
        meanDeg: mean, reflection: axisFits.map(fit => fit.reflection), innovationSigmaDeg: residual.sigma,
        innovationCorrelation: residual.axisCorrelation ?? 0,
        // A Gaussian innovation model is a hypothesis, not a claim about tails.
        innovationDistribution: "gaussian",
    };
    return validateErrorModel(model);
}

/** Allowlist copy for BOTH import and export; ignore arbitrary extra metadata. */
export function validateErrorModel(value) {
    const finite = (x, low, high) => typeof x === "number" && Number.isFinite(x) && x >= low && x <= high;
    const pair = (array, low, high) => Array.isArray(array) && array.length === 2 && array.every(x => finite(x, low, high));
    if (value?.modelType === "operator-feedback") {
        const operator = value.operator;
        if (value.schema !== "sitrec-los-error-model" || value.version !== 1 || value.basis !== "local-up-cross-clean-los"
            || !finite(value.sampleRateHz, .01, 1000) || !finite(value.simulationRateHz, 10, 1000)
            || value.simulationRateHz < value.sampleRateHz || !pair(value.meanDeg, -90, 90)
            || !pair(value.axisScale, 0, 10) || !pair(value.jitterSigmaDeg, 0, 90)
            || !finite(value.axisCorrelation, -1, 1) || !finite(value.trackingDelaySeconds, 0, 2)
            || !operator || !finite(operator.amplitude, 0, 90) || !finite(operator.driftSpeed, 0, 900)
            || !finite(operator.reactionTime, 0, 5) || !finite(operator.correctionSpeed, 0, 900)
            || !finite(operator.accuracy, 0, 1)) {
            throw new Error(t("losErrorAnalysis.model.invalidOperator"));
        }
        return {
            schema: value.schema, version: 1, basis: value.basis, modelType: "operator-feedback",
            sampleRateHz: value.sampleRateHz, simulationRateHz: value.simulationRateHz, meanDeg: [...value.meanDeg],
            axisScale: [...value.axisScale], axisCorrelation: value.axisCorrelation, jitterSigmaDeg: [...value.jitterSigmaDeg],
            trackingDelaySeconds: value.trackingDelaySeconds,
            operator: {
                amplitude: operator.amplitude, driftSpeed: operator.driftSpeed, reactionTime: operator.reactionTime,
                correctionSpeed: operator.correctionSpeed, accuracy: operator.accuracy,
            },
        };
    }
    if (value?.schema !== "sitrec-los-error-model" || value.version !== 1 || value.basis !== "local-up-cross-clean-los"
        || !finite(value.sampleRateHz, .01, 1000) || !pair(value.meanDeg, -90, 90)
        || !pair(value.innovationSigmaDeg, 0, 90) || !finite(value.innovationCorrelation, -1, 1)
        || !Array.isArray(value.reflection) || value.reflection.length !== 2
        || !value.reflection.every(axis => Array.isArray(axis) && axis.length <= 20 && axis.every(x => finite(x, -.98, .98)))
        || value.innovationDistribution !== "gaussian") throw new Error(t("losErrorAnalysis.model.invalidModel"));
    return {
        schema: value.schema, version: 1, basis: value.basis, sampleRateHz: value.sampleRateHz,
        meanDeg: [...value.meanDeg], reflection: value.reflection.map(axis => [...axis]),
        innovationSigmaDeg: [...value.innovationSigmaDeg], innovationCorrelation: value.innovationCorrelation,
        innovationDistribution: "gaussian",
    };
}

export const serializeErrorModel = model => JSON.stringify(validateErrorModel(model), null, 2) + "\n";

// Seeded PRNG is only for NEW realizations. No source seed is inferred or retained.
// The FNV-1a hash of the seed text.
function seedNumber(seed) {
    let state = 2166136261;
    for (const character of String(seed)) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
    return state >>> 0;
}

// Standard normal draws (Box-Muller) from mulberry32 seeded with the seed text.
function normalRandom(seed) {
    const uniform = mulberry32(seedNumber(seed));
    return () => Math.sqrt(-2 * Math.log(Math.max(1e-15, uniform()))) * Math.cos(2 * Math.PI * uniform());
}

/** Generate at the fitted internal cadence, then sample this SAME realization
 * at requested times. Never redraw per output frame when downsampling. */
export function generateErrors(inputModel, times, seed, geometry = null) {
    const model = validateErrorModel(inputModel);
    if (!times.length || times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= times[index - 1]))) {
        throw new Error(t("losErrorAnalysis.model.timesIncrease"));
    }
    const outputCadence = times.length > 1 ? cadence(times.map(time => ({t: time}))) : null;
    if (outputCadence?.hz > model.sampleRateHz * 1.01) {
        throw new Error(t("losErrorAnalysis.model.rateTooHigh"));
    }
    if (model.modelType === "operator-feedback") {
        const hz = model.simulationRateHz;
        const burnIn = Math.ceil(60 * hz);
        const count = Math.round((times.at(-1) - times[0]) * hz) + 1;
        if (count + burnIn > 5e6) throw new Error(t("losErrorAnalysis.model.operatorTooLarge"));
        const offsets = generateWobbleOffsets({...model.operator, minCorrectionSpeed: 0, seed: seedNumber(seed)}, count + burnIn, hz);
        const jitter = normalRandom(`${seed}:jitter`);
        const rho = model.axisCorrelation;
        const independent = Math.sqrt(Math.max(0, 1 - rho * rho));
        const delayErrors = trackingDelayErrors(geometry, times, model.trackingDelaySeconds);
        // Jitter is drawn on the internal grid too, so decimation of the same
        // seed preserves the SAME realization rather than redrawing at 1 Hz.
        const output = [];
        let generatedIndex = -1;
        let error;
        for (let index = 0; index < times.length; index++) {
            const wanted = Math.round((times[index] - times[0]) * hz);
            while (generatedIndex < wanted) {
                generatedIndex++;
                const offset = offsets[burnIn + generatedIndex];
                error = [
                    offset.pan * model.axisScale[0] + jitter() * model.jitterSigmaDeg[0],
                    (rho * offset.pan + independent * offset.tilt) * model.axisScale[1] + jitter() * model.jitterSigmaDeg[1],
                ];
            }
            output.push({t: times[index], e: error.map((value, axis) => value + model.meanDeg[axis] + delayErrors[index][axis])});
        }
        return output;
    }
    // Levinson step-up from the reflection coefficients to the AR coefficients of each axis.
    const coefficients = model.reflection.map(reflections => {
        let axisCoefficients = [];
        for (const reflection of reflections) {
            const previous = axisCoefficients;
            axisCoefficients = previous.map((coefficient, index) => coefficient - reflection * previous[previous.length - 1 - index]);
            axisCoefficients.push(reflection);
        }
        return axisCoefficients;
    });
    const history = coefficients.map(axisCoefficients => Array(axisCoefficients.length).fill(0));
    const random = normalRandom(seed);
    const rho = model.innovationCorrelation;
    const independent = Math.sqrt(Math.max(0, 1 - rho * rho));
    const step = () => {
        const firstDraw = random();
        const secondDraw = rho * firstDraw + independent * random();
        return [firstDraw, secondDraw].map((draw, axis) => {
            let value = draw * model.innovationSigmaDeg[axis];
            coefficients[axis].forEach((coefficient, lag) => value += coefficient * history[axis][lag]);
            if (history[axis].length) {
                history[axis].pop();
                history[axis].unshift(value);
            }
            return value + model.meanDeg[axis];
        });
    };
    // Burn in the stationary process. Discard all these values.
    const burnIn = Math.max(2000, Math.ceil(60 * model.sampleRateHz));
    const lastIndex = Math.round((times.at(-1) - times[0]) * model.sampleRateHz);
    if (lastIndex > 5e6 || burnIn > 1e6) throw new Error(t("losErrorAnalysis.model.syntheticTooLarge"));
    for (let index = 0; index < burnIn; index++) step();
    const output = [];
    let generatedIndex = -1;
    let error;
    for (const time of times) {
        const wanted = Math.round((time - times[0]) * model.sampleRateHz);
        while (generatedIndex < wanted) {
            error = step();
            generatedIndex++;
        }
        output.push({t: time, e: [...error]});
    }
    return output;
}

/** Lag follows past world-space bearings, including platform motion. It is an
 * effective tracking delay; pointing alone cannot separate it from clock skew. */
export function trackingDelayErrors(geometry, times, seconds) {
    if (!seconds) return times.map(() => [0, 0]);
    if (!geometry || geometry.length !== times.length) {
        throw new Error(t("losErrorAnalysis.model.delayNeedsGeometry"));
    }
    const bearings = geometry.map(row => unit(row.target.map((value, axis) => value - row.sensor[axis])));
    let earlierIndex = 0;
    return geometry.map((row, index) => {
        const wanted = times[index] - seconds;
        while (earlierIndex + 1 < times.length && times[earlierIndex + 1] <= wanted) earlierIndex++;
        const laterIndex = Math.min(earlierIndex + 1, times.length - 1);
        const fraction = Math.max(0, Math.min(1, (wanted - times[earlierIndex]) / (times[laterIndex] - times[earlierIndex] || 1)));
        const past = unit(bearings[earlierIndex].map((value, axis) => value + (bearings[laterIndex][axis] - value) * fraction));
        return angularResidual(row.sensor, row.target, past, row.up) ?? [0, 0];
    });
}

export function estimateTrackingDelay(samples, geometry) {
    if (!geometry || samples.length !== geometry.length) return {seconds: 0, explainedFraction: 0};
    const dt = cadence(samples).dt;
    const velocities = [];
    const errors = [];
    for (let index = 1; index < samples.length; index++) {
        const delta = samples[index].t - samples[index - 1].t;
        if (delta > 1.5 * dt) continue;
        const previous = unit(geometry[index - 1].target.map((value, axis) => value - geometry[index - 1].sensor[axis]));
        const change = angularResidual(geometry[index].sensor, geometry[index].target, previous, geometry[index].up);
        if (change) {
            velocities.push(change.map(value => value / delta));
            errors.push(samples[index].e);
        }
    }
    if (velocities.length < 20) return {seconds: 0, explainedFraction: 0};
    const velocityMean = [0, 1].map(axis => velocities.reduce((sum, velocity) => sum + velocity[axis], 0) / velocities.length);
    const errorMean = [0, 1].map(axis => errors.reduce((sum, error) => sum + error[axis], 0) / errors.length);
    let velocityVariance = 0;
    let covariance = 0;
    let errorVariance = 0;
    velocities.forEach((velocity, index) => velocity.forEach((value, axis) => {
        velocityVariance += (value - velocityMean[axis]) ** 2;
        covariance += (value - velocityMean[axis]) * (errors[index][axis] - errorMean[axis]);
        errorVariance += (errors[index][axis] - errorMean[axis]) ** 2;
    }));
    const seconds = velocityVariance > 1e-12 ? Math.max(0, Math.min(2, covariance / velocityVariance)) : 0;
    const explainedFraction = errorVariance > 1e-20
        ? Math.max(0, (2 * seconds * covariance - seconds * seconds * velocityVariance) / errorVariance) : 0;
    // Require varying angular motion and useful explanatory power. With almost
    // constant target angular velocity, lag and a fixed bias are inseparable.
    return {seconds: explainedFraction >= .1 ? seconds : 0, explainedFraction};
}

/** Fit aggregate statistics over an ensemble of fixed, independent simulation
 * seeds. No measured residuals are replayed and no source seed is recovered.
 * Parameters are a descriptive feedback analogue, not uniquely identified
 * human reaction times. Yield periodically so the panel remains cancellable. */
export async function fitOperatorErrorModel(samples, geometry = null, {onProgress = () => {}, cancelled = () => false} = {}) {
    if (samples.length < 20) throw new Error(t("losErrorAnalysis.model.operatorSamples"));
    const source = summarizeErrors(samples);
    const delay = estimateTrackingDelay(samples, geometry);
    const delayErrors = trackingDelayErrors(geometry, samples.map(row => row.t), delay.seconds);
    const residual = samples.map((row, index) => ({t: row.t, e: row.e.map((value, axis) => value - delayErrors[index][axis])}));
    const summary = summarizeErrors(residual);
    const hz = source.hz;
    // Limit calibration duration, retaining a contiguous prefix; the report
    // still evaluates fresh realizations over the whole selected A–B window.
    const window = residual.filter(row => row.t - residual[0].t <= 90);
    const times = window.map(row => row.t);
    const target = summarizeErrors(window);
    const sigma = summary.sigma;
    const prototype = {
        schema: "sitrec-los-error-model", version: 1, basis: "local-up-cross-clean-los", modelType: "operator-feedback",
        sampleRateHz: hz, simulationRateHz: Math.max(10, hz), meanDeg: summary.mean,
        axisScale: sigma.map(axisSigma => summary.centeredRms > 1e-12 ? Math.SQRT2 * axisSigma / summary.centeredRms : 1),
        axisCorrelation: summary.axisCorrelation ?? 0, jitterSigmaDeg: [0, 0], trackingDelaySeconds: delay.seconds,
        operator: {amplitude: 0, driftSpeed: 0, reactionTime: .4, correctionSpeed: 0, accuracy: .8},
    };
    if (summary.centeredRms < 1e-10) return {model: validateErrorModel(prototype), score: 0, delay, candidates: 0};
    // Independent per-frame jitter floor from second differences (white noise
    // has variance 6*sigma^2 here). Feedback curvature may also contribute.
    const secondDifferences = [];
    for (let index = 2; index < window.length; index++) {
        if (window[index].t - window[index - 2].t < target.dt * 2.25) {
            secondDifferences.push(window[index].e.map((value, axis) => value - 2 * window[index - 1].e[axis] + window[index - 2].e[axis]));
        }
    }
    const floor = [0, 1].map(axis => Math.min(sigma[axis],
        Math.sqrt(secondDifferences.reduce((sum, difference) => sum + difference[axis] ** 2, 0) / Math.max(1, secondDifferences.length) / 6)));
    const lagOne = target.acf.find(row => Math.abs(row.seconds - target.dt) < target.dt * .01)?.axes ?? [null, null];
    if (lagOne.every(value => value !== null && Math.abs(value) < .12)) {
        prototype.jitterSigmaDeg = sigma;
        return {model: validateErrorModel(prototype), score: 0, delay, candidates: 0};
    }
    const candidates = [];
    for (const drift of [.3, .7, 1.5]) {
        for (const correction of [2, 6, 12]) {
            for (const reaction of [.15, .4, .8]) {
                for (const accuracy of [.5, .8]) {
                    candidates.push({amplitude: 1, driftSpeed: drift, reactionTime: reaction, correctionSpeed: correction, accuracy});
                }
            }
        }
    }
    const ratioLoss = (a, b) => Math.log(Math.max(a, 1e-8) / Math.max(b, 1e-8)) ** 2;
    let best = null;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        if (cancelled()) throw new Error(t("losErrorAnalysis.model.operatorCancelled"));
        const candidate = candidates[candidateIndex];
        const trial = {...prototype, meanDeg: [0, 0], trackingDelaySeconds: 0, operator: candidate};
        const ensemble = [0, 1].map(seed => generateErrors(trial, times, `operator-calibration-${seed}`));
        const rms = Math.sqrt(ensemble.reduce((sum, rows) => sum + summarizeErrors(rows).centeredRms ** 2, 0) / 2);
        const amplitude = Math.sqrt(Math.max(0, target.centeredRms ** 2 - dot(floor, floor))) / Math.max(rms, 1e-12);
        const scaled = ensemble.map((rows, seed) => {
            const jitter = normalRandom(`operator-floor-${seed}`);
            return rows.map(row => ({t: row.t, e: row.e.map((value, axis) => value * amplitude + floor[axis] * jitter())}));
        }).map(summarizeErrors);
        let score = 0;
        for (const synthetic of scaled) {
            score += ratioLoss(synthetic.centeredP95 / Math.max(synthetic.centeredRms, 1e-12), target.centeredP95 / target.centeredRms);
            if (target.incrementRms) score += ratioLoss(synthetic.incrementRms, target.incrementRms);
            for (const measured of target.acf.filter(row => row.seconds <= 5)) {
                const predicted = synthetic.acf.find(row => Math.abs(row.seconds - measured.seconds) < target.dt * .01);
                if (predicted) {
                    for (let axis = 0; axis < 2; axis++) {
                        if (measured.axes[axis] !== null && predicted.axes[axis] !== null) {
                            score += (predicted.axes[axis] - measured.axes[axis]) ** 2;
                        }
                    }
                }
            }
        }
        if (!best || score < best.score) {
            best = {
                score,
                model: {
                    ...prototype, jitterSigmaDeg: floor,
                    operator: {...candidate, amplitude, driftSpeed: candidate.driftSpeed * amplitude, correctionSpeed: candidate.correctionSpeed * amplitude},
                },
            };
        }
        if (candidateIndex % 6 === 0) {
            onProgress(candidateIndex + 1, candidates.length);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    return {model: validateErrorModel(best.model), score: best.score / 2, delay, candidates: candidates.length};
}
