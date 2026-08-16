// generateScenario.js — assemble a BotScenario (PLAN.md "Module API").
// Synchronous, deterministic, no filesystem or network access.
//
// Seed-key discipline (contract "Design laws" + pairing rules):
//  - platform/target/wind/event streams derive from the TRUTH KEY — a hash of
//    the spec WITHOUT the observation section — so matched-noise pair members
//    (identical truth, different noise) share the exact same truth realization;
//  - the observation stream derives from spec.observation.sharedSeedKey when
//    blocks.js sets one (anomaly/control pairs: identical pointing-error
//    realization) and from the full scenario hash otherwise (matched-white:
//    an INDEPENDENT draw, matched only in realized RMS via
//    observation.matchedRealizedRmsDeg).

import {deriveSeed, fnv1a32} from "./rng";
import {generatePlatformPath} from "./platforms";
import {generateTargetTruth} from "./targets";
import {makeWind} from "./wind";
import {cleanDirections, generateObservation} from "./observation";
import {cvDesignConditioning, sensorPathStats, losSeriesFeatures} from "./diagnostics";

export const SITES = {
    "flat-reference":    {latDeg: 40,       lonDeg: -105,      groundElevationMSL: 0},
    "ocean":             {latDeg: 35,       lonDeg: -125,      groundElevationMSL: 0},
    "denver":            {latDeg: 39.7392,  lonDeg: -104.9903, groundElevationMSL: 1609},
    "cheyenne-mountain": {latDeg: 38.744,   lonDeg: -104.846,  groundElevationMSL: 2900},
};

// Stable stringify with sorted keys (canonical spec hashing).
export function canonical(obj) {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

// Bumped 1 -> 1.1: balloon gusts now draw from the wind component stream
// (audit R2), so realizations differ from version 1 by design.
export const GENERATOR_VERSION = "1.1";

export function generateScenario(spec, {scenarioSeed, generatorVersion = GENERATOR_VERSION} = {}) {
    if (!Number.isInteger(scenarioSeed)) {
        throw new Error("botbench: scenarioSeed (integer) is required");
    }
    const site = SITES[spec.siteId];
    if (!site) throw new Error(`botbench: unknown siteId "${spec.siteId}"`);

    const fps = spec.fps;
    const n = Math.round(spec.durationSeconds * fps) + 1;
    const times = new Float64Array(n);
    for (let f = 0; f < n; f++) times[f] = f / fps;

    const {observation: obsSpec, ...truthSpec} = spec;
    const truthKey = fnv1a32(canonical(truthSpec)).toString(16);
    const scenarioId = `bb-${fnv1a32(`${canonical(spec)}|${scenarioSeed}|${generatorVersion}`).toString(16)}`;

    // Group key strips noise variant, rate, site, and duration (contract):
    // pairs and sentinels sharing truth+seed stay in one classifier group.
    const targetGroup = {...spec.target, parameters: {...(spec.target.parameters ?? {})}};
    delete targetGroup.parameters.anomalous;
    // Real-segment pairs: the spliced impulse and the control marker are the
    // event variant, not truth content — strip them or the pair's two members
    // land in different groups (audit F2). pairOnsetSeconds is identical
    // across members and may stay.
    delete targetGroup.parameters.impulse;
    delete targetGroup.parameters.paired;
    const scenarioGroupId = `bg-${fnv1a32(canonical({
        platform: spec.platform,
        target: targetGroup,
        wind: spec.wind,
        rangeM: spec.initialHorizontalRangeM ?? null,
        scenarioSeed,
    })).toString(16)}`;

    const rngSeeds = {
        platform: deriveSeed(truthKey, scenarioSeed, "platform", generatorVersion),
        target: deriveSeed(truthKey, scenarioSeed, "target", generatorVersion),
        wind: deriveSeed(truthKey, scenarioSeed, "wind", generatorVersion),
        observation: deriveSeed(obsSpec.sharedSeedKey ?? scenarioId, scenarioSeed,
            "observation", generatorVersion),
        event: deriveSeed(truthKey, scenarioSeed, "event", generatorVersion),
    };

    // --- wind ------------------------------------------------------------
    const refAltAGL = spec.target.parameters?.startAGL
        ?? (spec.target.kind === "hab-stable" ? 18000 : 500);
    const wind = makeWind(spec.wind.kind, refAltAGL + site.groundElevationMSL);

    // --- platform ---------------------------------------------------------
    const R = spec.initialHorizontalRangeM;
    const {positionENU: platformPos, feasibility} =
        generatePlatformPath(spec.platform, n, times, fps, R);

    // --- target truth ------------------------------------------------------
    let target, events, capabilityProfile = null;
    if (spec.target.kind === "venus") {
        // Lazy import keeps astronomy-engine out of non-venus scenarios.
        // eslint-disable-next-line global-require
        const {generateVenusTruth} = require("./venus");
        target = generateVenusTruth({
            site: {...site, id: spec.siteId},
            n, times, platformPositionENU: platformPos,
        });
        events = [];
    } else if (spec.target.kind === "capability") {
        // Emerging-threats capability targets (envelope exceedance / novel tech).
        // eslint-disable-next-line global-require
        const {generateCapabilityTruth} = require("./capabilityTargets");
        const r = generateCapabilityTruth(spec.target, {n, fps});
        target = r.target;
        capabilityProfile = r.capabilityProfile;
        events = [];
    } else {
        const r = generateTargetTruth(spec.target, {
            site: {...site, id: spec.siteId}, n, fps,
            seed: rngSeeds.target, windSeed: rngSeeds.wind, wind,
        });
        target = r.target;
        events = r.events;
    }
    for (const ev of events) ev.pairId = spec.pairId ?? null;

    // --- recorded wind series (MEAN wind at target altitude; gusts live
    // inside the balloon/bird truth integration, not here) -----------------
    const windStep = new Float64Array(n * 3);
    const windVel = new Float64Array(n * 3);
    const dt = 1 / fps;
    for (let f = 0; f < n; f++) {
        const altAGL = target.kind === "track" ? target.positionENU[f * 3 + 2] : refAltAGL;
        const {u, v} = wind.meanAt(altAGL + site.groundElevationMSL);
        windVel[f * 3] = u;
        windVel[f * 3 + 1] = v;
        if (f < n - 1) {   // final triple stays zero (contract)
            windStep[f * 3] = u * dt;
            windStep[f * 3 + 1] = v * dt;
        }
    }

    // --- observation --------------------------------------------------------
    const cleanDir = cleanDirections(platformPos, target, n);
    const observation = generateObservation(obsSpec, cleanDir, n, fps, rngSeeds.observation);

    // --- diagnostics ---------------------------------------------------------
    const activeFrames = [];
    const allFrames = [];
    for (let f = 0; f < n; f++) {
        allFrames.push(f);
        if (observation.inFov[f]) activeFrames.push(f);
    }
    const condObs = cvDesignConditioning(observation.observedDirectionENU, times, activeFrames);
    const condClean = cvDesignConditioning(cleanDir, times, allFrames);
    const pathStats = sensorPathStats(platformPos, n);
    const losFeatures = losSeriesFeatures(observation.observedDirectionENU, times, activeFrames);

    return {
        schemaVersion: 1,
        generatorVersion,
        scenarioId,
        scenarioGroupId,
        blockId: spec.blockId ?? null,
        pairId: spec.pairId ?? null,
        scenarioSeed,
        rngSeeds,
        spec,
        n,
        fps,
        durationSeconds: spec.durationSeconds,
        times,
        site: {
            id: spec.siteId,
            latDeg: site.latDeg,
            lonDeg: site.lonDeg,
            groundElevationMSL: site.groundElevationMSL,
            surfaceModel: "flat-elevation-proxy",
            epochISO: spec.epochISO ?? "2025-02-01T02:00:00Z",
        },
        platform: {positionENU: platformPos, feasibility},
        target,
        capabilityProfile,
        wind: {displacementPerFrameENU: windStep, sampledVelocityENU: windVel},
        observation,
        events,
        constraints: {minRangeM: null, maxRangeM: null},
        diagnostics: {
            sensorPathLengthM: pathStats.sensorPathLengthM,
            sensorSpanM: pathStats.sensorSpanM,
            cvDesignRcondObserved: condObs.rcond,
            cvDesignLog10RcondObserved: condObs.log10Rcond,
            cvDesignEffectiveRank: condObs.effectiveRank,
            cvDesignRcondCleanOracle: condClean.rcond,
            cvNormalLambdaMinOverTrace: condObs.lambdaMinOverTrace,
            losSweepDeg: losFeatures.losSweepDeg,
            losMeanRateDegPerS: losFeatures.losMeanRateDegPerS,
            losLag1Autocorr: losFeatures.losLag1Autocorr,
        },
    };
}
