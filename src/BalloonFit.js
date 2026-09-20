import {PhysicsModel} from "./PhysicsModel";
import {SkyLanternModel} from "./SkyLanternModel";
import {SuppliedWindModel} from "./SuppliedWindModel";
import {fitPhysicsModel} from "./LOSFitting";
import {localFitCompletionWarnings} from "./TraverseRanking";
import {WIND_SEARCH_LIMIT_MS, WIND_PRIOR_SIGMA_MS, windPriorCost} from "./TraverseWind";

const R = 6371000;
export const BALLOON_IMPROVEMENT_DEG = 0.002;

// A passive tracer with a signed vertical speed. The optional wind extensions
// are alternatives: time variation and altitude shear are never fit together.
export class BalloonDriftModel extends PhysicsModel {
    maxDt = 0.5;
    geodeticVerticalSpeed = true;
    constructor(stage = "steady", duration = 120) {
        super();
        this.stage = stage;
        this.clipDuration = duration;
    }
    getName() { return "Balloon drift"; }
    getParameterDefs() {
        const defs = [
            {name: "initialRange", min: 200, max: 30000, default: 3000, scale: 500},
            {name: "windE", min: -WIND_SEARCH_LIMIT_MS, max: WIND_SEARCH_LIMIT_MS, default: 0, scale: 2},
            {name: "windN", min: -WIND_SEARCH_LIMIT_MS, max: WIND_SEARCH_LIMIT_MS, default: 0, scale: 2},
            {name: "verticalSpeed", min: -4, max: 4, default: 0, scale: 0.5},
        ];
        if (["linear", "quadratic"].includes(this.stage)) defs.push(
            {name: "windDriftE", min: -15, max: 15, default: 0, scale: 1},
            {name: "windDriftN", min: -15, max: 15, default: 0, scale: 1});
        if (this.stage === "quadratic") defs.push(
            {name: "windCurveE", min: -15, max: 15, default: 0, scale: 1},
            {name: "windCurveN", min: -15, max: 15, default: 0, scale: 1});
        if (this.stage === "shear") defs.push(
            {name: "shearPerM", min: -0.004, max: 0.008, default: 0, scale: 0.001});
        return defs;
    }
    getInitialState(p, d) {
        const s = [0, 1, 2].map(a => d.sensorPos[a] + p[0] * d.losDir[a]);
        return [...s, s[2] + (s[0] ** 2 + s[1] ** 2) / (2 * R)];
    }
    windAt(p, t) {
        const s = this.clipDuration > 0 ? t / this.clipDuration : 0;
        if (this.stage === "shear") {
            const mult = Math.max(0.25, Math.min(3, 1 + p[4] * p[3] * t));
            return [p[1] * mult, p[2] * mult];
        }
        return [p[1] + (p[4] ?? 0) * s + (p[6] ?? 0) * s * s,
            p[2] + (p[5] ?? 0) * s + (p[7] ?? 0) * s * s];
    }
    derivatives(state, p, t) {
        const [u, v] = this.windAt(p, t);
        return [u, v, p[3] - (state[0] * u + state[1] * v) / R, 0];
    }
    extraCostTerms(p, d, T) {
        let meanU = 0, meanV = 0, meanSq = 0;
        for (let k = 0; k <= 16; k++) {
            const [u, v] = this.windAt(p, T * k / 16);
            meanU += u / 17; meanV += v / 17; meanSq += (u * u + v * v) / 17;
        }
        const terms = {"shared wind prior": windPriorCost(meanU, meanV),
            "wind variability": Math.max(0, meanSq - meanU * meanU - meanV * meanV) / 4};
        const h0 = this.getInitialState(p, d)[3];
        let below = 0;
        for (let k = 0; k <= 16; k++) below += (Math.min(0, h0 + p[3] * T * k / 16) / 8) ** 2 / 17;
        if (below) terms["below-surface profile"] = below;
        return terms;
    }
    extraCost(p, d, T) { return Object.values(this.extraCostTerms(p, d, T)).reduce((a, b) => a + b, 0); }
}

export function makeBalloonModel(stage, duration) {
    if (stage !== "lifecycle") return new BalloonDriftModel(stage, duration);
    const model = new SkyLanternModel();
    model.clipDuration = duration;
    model.windPriorE = 0; model.windPriorN = 0; model.windPriorSigma = WIND_PRIOR_SIGMA_MS;
    model.windPriorLabel = "shared wind prior";
    return model;
}

export function balloonStageLocks(stage) {
    return stage === "lifecycle"
        ? {shearPerM: 0, windDriftE: 0, windDriftN: 0, windCurveE: 0, windCurveN: 0} : {};
}

export async function fitBalloon(physicsDataset, dataset, {seedTrack = null, mode = "fitted",
    correctionSigmaMS, improvementDeg = BALLOON_IMPROVEMENT_DEG, ...options} = {}) {
    const duration = (dataset.n - 1) / dataset.fps;
    let seed = {};
    if (seedTrack) {
        const initializer = new SkyLanternModel(); initializer.clipDuration = duration;
        initializer.seedFromTrack(seedTrack, physicsDataset);
        if (initializer.seed) seed = Object.fromEntries(initializer.getParameterDefs().map((d, i) => [d.name, initializer.seed[i]]));
        seed.verticalSpeed = seed.vRise - seed.vSink;
    }
    if (mode === "corrected") {
        for (const [key, axis] of [["windE", 0], ["windN", 1]]) {
            let mean = 0;
            for (let f = 0; f < dataset.n; f++) mean += dataset.W[f * 3 + axis] * dataset.fps / dataset.n;
            seed[key] = (seed[key] ?? 0) - mean;
        }
    }
    let referenceResidualDeg = 0;
    if (seedTrack) {
        for (let f = 0; f < dataset.n; f++) {
            const b = f * 3, x = seedTrack[b] - dataset.S[b], y = seedTrack[b + 1] - dataset.S[b + 1], z = seedTrack[b + 2] - dataset.S[b + 2];
            const dx = dataset.D[b], dy = dataset.D[b + 1], dz = dataset.D[b + 2];
            referenceResidualDeg += Math.atan2(Math.hypot(y * dz - z * dy, z * dx - x * dz, x * dy - y * dx), x * dx + y * dy + z * dz) * 180 / Math.PI / dataset.n;
        }
    }
    const candidates = [];
    const fitted = [];
    let best = null;
    const attempt = async stage => {
        let model = makeBalloonModel(stage, duration);
        if (mode !== "fitted") model = new SuppliedWindModel(model, dataset,
            mode === "corrected" ? {correctionSigmaMS} : {});
        const prior = best?.params?.solved ?? seed;
        const overrides = {...seed, ...prior};
        if (stage === "lifecycle") {
            // A changing-wind fit can explain vertical curvature through range.
            // Start the alternative vertical model from the geometric seed,
            // rather than inheriting that alternative's distorted wind/range.
            Object.assign(overrides, seed);
            const h = f => {
                const b = f * 3;
                return seedTrack[b + 2] + (seedTrack[b] ** 2 + seedTrack[b + 1] ** 2) / (2 * R);
            };
            const w = Math.max(1, Math.floor(dataset.n / 10));
            const initialVz = seedTrack ? (h(w) - h(0)) * dataset.fps / w : seed.verticalSpeed ?? 1;
            const finalVz = seedTrack ? (h(dataset.n - 1) - h(dataset.n - 1 - w)) * dataset.fps / w : initialVz;
            overrides.vRise = Math.max(0, initialVz);
            overrides.vSink = Math.max(0.5, -finalVz);
            overrides.tBurn = duration * 0.4; overrides.tauCool = Math.max(10, duration / 4);
        }
        const fit = await fitPhysicsModel(physicsDataset, new Set(), model, {
            ...options, gpu: false, // these reduced models have no matching GPU kernel
            optimizer: best ? "nm" : options.optimizer ?? "de",
            paramOverrides: overrides, paramLocks: {...balloonStageLocks(stage), ...options.paramLocks},
        });
        if (!fit) return;
        const complete = localFitCompletionWarnings(fit.params.optimizer).length === 0;
        const record = {stage, errDeg: fit.params.errDeg, completed: complete,
            freeParameterCount: fit.params.optimizer?.paramNames?.length ?? model.getParameterDefs().length};
        candidates.push(record); fitted.push({fit, record});
        if (!best || fit.params.errDeg < best.params.errDeg) best = fit;
    };
    const tryStage = async stage => {
        try { await attempt(stage); } catch (e) { if (options.shouldCancel?.()) throw e;
            candidates.push({stage, completed: false, error: e.message}); }
    };
    await tryStage("steady");
    // No need to fit inactive lifecycle dimensions or wind curvature when a
    // steady model already matches to the declared practical tolerance.
    if (!best || localFitCompletionWarnings(best.params.optimizer).length
        || best.params.errDeg > improvementDeg) {
        for (const stage of mode === "fitted" ? ["linear", "lifecycle", "shear", "quadratic"] : ["lifecycle"]) {
            await tryStage(stage);
        }
    }
    if (fitted.length) {
        const completed = fitted.filter(c => c.record.completed);
        const pool = completed.length ? completed : fitted;
        const lowestError = Math.min(...pool.map(c => c.record.errDeg));
        const required = Math.max(improvementDeg, lowestError * 0.1);
        const chosen = pool.filter(c => c.record.errDeg <= lowestError + required)
            .sort((a, b) => a.record.freeParameterCount - b.record.freeParameterCount || a.record.errDeg - b.record.errDeg)[0];
        best = chosen.fit;
        const stage = chosen.record.stage;
        best.params.modelSelection = {selectedStage: stage, freeParameterCount: chosen.record.freeParameterCount,
            requiredImprovementDeg: required, thresholdBasis: "practical tolerance (not statistical confidence)",
            fixedAssumptions: stage === "steady" ? "constant horizontal wind; constant signed vertical speed"
                : stage === "lifecycle" ? "constant horizontal wind; rise/cooling/descent" : "constant signed vertical speed; one wind extension",
            alternatives: candidates, referenceResidualDeg};
        if (mode !== "fitted") best.params.modelSelection.fixedAssumptions =
            (mode === "supplied" ? "supplied wind series held fixed" : "supplied wind series plus a constant correction")
            + (stage === "lifecycle" ? "; rise/cooling/descent" : "; constant signed vertical speed");
        best.params.windMode = mode;
        if (mode === "corrected") best.params.windCorrectionSigmaMS = correctionSigmaMS;
    }
    return best;
}
