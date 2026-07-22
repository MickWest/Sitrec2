// blocks.js — the 9-block scenario matrix, 765 scenarios total (PLAN.md
// "Block matrix"). Emits spec ENTRIES; the runner generates wobble members
// first and feeds their realized RMS into the paired matched-white members
// (entry.matchedRmsFrom / entry.rmsKey).
//
// Pairing keys:
//  - MATCHED-NOISE pairId links {wobble, matched-white} members sharing truth;
//    the white draw is INDEPENDENT (no sharedSeedKey), matched in RMS only.
//  - ANOMALY-CONTROL pairId links {anomalous, control} within one noise kind;
//    sharedSeedKey (excludes the anomalous flag) gives both members the EXACT
//    same pointing-error realization. Its matched-white RMS comes from the
//    same cell's wobble member (identical for both pair members by key).

const WOBBLE = {amplitude: 0.15, driftSpeed: 0.10, reactionTime: 0.4,
    correctionSpeed: 1.0, accuracy: 0.8};

export const PLATFORM_SPECS = {
    "orbit-point":         {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
    "orbit-direction-0.5": {kind: "orbit-direction", rangeErrorFactor: 0.5, speedMS: 70, altitudeAGL: 3000},
    "orbit-direction-1.0": {kind: "orbit-direction", rangeErrorFactor: 1.0, speedMS: 70, altitudeAGL: 3000},
    "orbit-direction-2.0": {kind: "orbit-direction", rangeErrorFactor: 2.0, speedMS: 70, altitudeAGL: 3000},
    "curve":               {kind: "curve", bankDeg: 10, speedMS: 70, altitudeAGL: 3000},
    "straight":            {kind: "straight", speedMS: 70, altitudeAGL: 3000},
    "s-curve-toward":      {kind: "s-curve-toward", bankAmplitudeDeg: 15, bankPeriodSeconds: 12, speedMS: 70, altitudeAGL: 3000},
    "s-curve-perp":        {kind: "s-curve-perp", bankAmplitudeDeg: 15, bankPeriodSeconds: 12, speedMS: 70, altitudeAGL: 3000},
};
const ALL_PLATFORMS = Object.keys(PLATFORM_SPECS);

const TARGETS = {
    "party-rising":     {kind: "party-rising", family: "balloon", parameters: {startAGL: 300, ascentRate: 3}},
    "weather-rising":   {kind: "weather-rising", family: "balloon", parameters: {startAGL: 300, ascentRate: 5}},
    "party-neutral":    {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
    "tethered-aerostat":{kind: "tethered-aerostat", family: "aerostat", parameters: {}},
    "bird":             {kind: "bird", family: "bird", parameters: {}},
    "aircraft-cruise":  {kind: "aircraft-cruise", family: "aircraft", parameters: {}},
    "aircraft-turn":    {kind: "aircraft-turn", family: "aircraft", parameters: {}},
    "venus":            {kind: "venus", family: "venus", parameters: {}},
};

const WHITE_003 = {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03};
const CLEAN = {kind: "clean", fovFullDeg: 0.5};

function entry(blockId, scenarioSeed, spec, extra = {}) {
    return {blockId, scenarioSeed, spec: {...spec, blockId}, ...extra};
}

function base({platform, target, wind, observation, durationSeconds, fps = 10,
               rangeM, siteId = "flat-reference", pairId = null}) {
    return {
        durationSeconds, fps,
        initialHorizontalRangeM: rangeM,
        siteId,
        platform: PLATFORM_SPECS[platform] ?? platform,
        target,
        wind: {kind: wind},
        observation,
        pairId,
    };
}

export function buildAllScenarioEntries() {
    const out = [];

    // --- GEO-DURATION: 8 x 3 x 3 x 3 = 216 --------------------------------
    for (const platform of ALL_PLATFORMS)
        for (const rangeM of [2000, 5000, 20000])
            for (const durationSeconds of [5, 15, 60])
                for (const scenarioSeed of [101, 102, 103])
                    out.push(entry("GEO-DURATION", scenarioSeed, base({
                        platform, rangeM, durationSeconds,
                        target: TARGETS["party-neutral"],
                        wind: "fixed", observation: {...WHITE_003},
                    })));

    // --- TARGET-WIND: 20 cases x 3 platforms x 2 seeds = 120 ----------------
    const twCases = [];
    for (const t of ["party-rising", "weather-rising", "party-neutral", "tethered-aerostat"])
        for (const w of ["zero", "fixed", "fixed-gust", "layered-gust"])
            twCases.push({target: t, wind: w, rangeM: 5000});
    twCases.push({target: "bird", wind: "fixed", rangeM: 5000});
    twCases.push({target: "aircraft-cruise", wind: "fixed", rangeM: 20000});
    twCases.push({target: "aircraft-turn", wind: "fixed", rangeM: 20000});
    twCases.push({target: "venus", wind: "zero", rangeM: 5000});
    for (const c of twCases)
        for (const platform of ["orbit-point", "curve", "straight"])
            for (const scenarioSeed of [201, 202])
                out.push(entry("TARGET-WIND", scenarioSeed, base({
                    platform, rangeM: c.rangeM, durationSeconds: 15,
                    target: TARGETS[c.target], wind: c.wind,
                    observation: {...WHITE_003},
                })));

    // --- HAB-LONG-RANGE: 2 x 3 x 6 x 2 = 72 ---------------------------------
    for (const mslKm of [18, 20])
        for (const rangeM of [20000, 50000, 100000])
            for (const platform of ["orbit-point", "orbit-direction-0.5",
                "orbit-direction-1.0", "orbit-direction-2.0", "curve", "straight"])
                for (const scenarioSeed of [211, 212])
                    out.push(entry("HAB-LONG-RANGE", scenarioSeed, base({
                        platform, rangeM, durationSeconds: 60,
                        target: {kind: "hab-stable", family: "balloon",
                            parameters: {startAGL: mslKm * 1000, mslKm}},
                        wind: "hab-steady", observation: {...WHITE_003},
                    })));

    // --- MATCHED-NOISE: 3 x 2 x 3 x 3 x 2 = 108 ------------------------------
    for (const platform of ["orbit-point", "curve", "straight"])
        for (const targetId of ["party-neutral", "aircraft-cruise"])
            for (const durationSeconds of [5, 15, 60])
                for (const scenarioSeed of [301, 302, 303]) {
                    const rangeM = targetId === "aircraft-cruise" ? 20000 : 5000;
                    const pairId = `mn-${platform}-${targetId}-${durationSeconds}-${scenarioSeed}`;
                    const rmsKey = pairId;
                    out.push(entry("MATCHED-NOISE", scenarioSeed, base({
                        platform, rangeM, durationSeconds, pairId,
                        target: TARGETS[targetId], wind: "fixed",
                        observation: {kind: "wobble", fovFullDeg: 0.9, wobble: {...WOBBLE}},
                    }), {rmsKey, assertNoFovExclusions: true}));
                    out.push(entry("MATCHED-NOISE", scenarioSeed, base({
                        platform, rangeM, durationSeconds, pairId,
                        target: TARGETS[targetId], wind: "fixed",
                        observation: {kind: "white", fovFullDeg: 0.9},
                    }), {matchedRmsFrom: rmsKey}));
                }

    // --- ANOMALY-CONTROL: 6 x 2 x 2 x 3 x 2 = 144 ----------------------------
    const TUPLES = ["pulse-20g", "pulse-100g", "transition-90", "transition-180",
        "impulse-east", "impulse-north"];
    for (const tupleId of TUPLES)
        for (const platform of ["orbit-point", "straight"])
            for (const noise of ["clean", "matched-white", "wobble"])
                for (const scenarioSeed of [401, 402]) {
                    const cellKey = `ac-${tupleId}-${platform}-${scenarioSeed}`;
                    const pairId = `${cellKey}-${noise}`;
                    for (const anomalous of [true, false]) {
                        let observation, extra = {};
                        if (noise === "clean") {
                            observation = {kind: "clean", fovFullDeg: 0.5};
                        } else if (noise === "wobble") {
                            observation = {kind: "wobble", fovFullDeg: 0.5,
                                wobble: {...WOBBLE}, sharedSeedKey: pairId};
                            // one RMS source per cell: the anomalous wobble member
                            if (anomalous) extra = {rmsKey: cellKey};
                        } else {
                            observation = {kind: "white", fovFullDeg: 0.5,
                                sharedSeedKey: pairId};
                            extra = {matchedRmsFrom: cellKey};
                        }
                        out.push(entry("ANOMALY-CONTROL", scenarioSeed, base({
                            platform, rangeM: 20000, durationSeconds: 15, pairId,
                            target: {kind: "anomalous", family: "anomalous",
                                parameters: {tupleId, anomalous}},
                            wind: "zero", observation,
                        }), extra));
                    }
                }

    // --- CLEAN-CONTROL: 8 x 3 x 3 = 72 (seed 101 truth, zero observation error)
    for (const platform of ALL_PLATFORMS)
        for (const rangeM of [2000, 5000, 20000])
            for (const durationSeconds of [5, 15, 60])
                out.push(entry("CLEAN-CONTROL", 101, base({
                    platform, rangeM, durationSeconds,
                    target: TARGETS["party-neutral"], wind: "fixed",
                    observation: {...CLEAN},
                })));

    // --- RATE-30HZ: 3 x 2 x 2 = 12 -------------------------------------------
    for (const platform of ["orbit-point", "straight", "s-curve-perp"])
        for (const rangeM of [2000, 20000])
            for (const durationSeconds of [15, 60])
                out.push(entry("RATE-30HZ", 101, base({
                    platform, rangeM, durationSeconds, fps: 30,
                    target: TARGETS["party-neutral"], wind: "fixed",
                    observation: {...WHITE_003},
                })));

    // --- DURATION-120S: 3 x 4 = 12 --------------------------------------------
    for (const platform of ["orbit-point", "straight", "s-curve-perp"])
        for (const targetId of ["party-neutral", "bird", "aircraft-cruise", "venus"]) {
            const rangeM = targetId === "aircraft-cruise" ? 20000 : 5000;
            out.push(entry("DURATION-120S", 101, base({
                platform, rangeM, durationSeconds: 120,
                target: TARGETS[targetId],
                wind: targetId === "venus" ? "zero" : "fixed",
                observation: {...WHITE_003},
            })));
        }

    // --- RECOVERABLE-NOISE (round 1.1, Codex R3): 2 x 3 x 3 x 5 = 90 ---------
    // Q1/Q3 in the RECOVERABLE regime: 2 km range x 60 s gives the geometry
    // real parallax, so noise color and KS-vs-CV are measured on working fits
    // rather than on competing collapse modes. Wobble members source the
    // matched-white RMS exactly as in MATCHED-NOISE; clean members share the
    // scenario group (group key strips the noise variant).
    for (const platform of ["orbit-point", "curve"])
        for (const targetId of ["party-neutral", "bird", "aircraft-turn"])
            for (const scenarioSeed of [601, 602, 603, 604, 605])
                for (const noise of ["clean", "wobble", "matched-white"]) {
                    const pairId = `rn-${platform}-${targetId}-${scenarioSeed}`;
                    let observation, extra = {};
                    if (noise === "clean") {
                        observation = {kind: "clean", fovFullDeg: 0.9};
                    } else if (noise === "wobble") {
                        observation = {kind: "wobble", fovFullDeg: 0.9, wobble: {...WOBBLE}};
                        extra = {rmsKey: pairId, assertNoFovExclusions: true};
                    } else {
                        observation = {kind: "white", fovFullDeg: 0.9};
                        extra = {matchedRmsFrom: pairId};
                    }
                    out.push(entry("RECOVERABLE-NOISE", scenarioSeed, base({
                        platform, rangeM: 2000, durationSeconds: 60, pairId,
                        target: TARGETS[targetId], wind: "fixed", observation,
                    }), extra));
                }

    // --- SITE-PROXY: 3 sites x 3 targets = 9 ----------------------------------
    const SITE_GROUND = {"ocean": 0, "denver": 1609, "cheyenne-mountain": 2900};
    for (const siteId of ["ocean", "denver", "cheyenne-mountain"])
        for (const targetId of ["party-rising", "hab-19km", "venus"]) {
            let target, wind, rangeM;
            if (targetId === "party-rising") {
                target = TARGETS["party-rising"]; wind = "fixed"; rangeM = 5000;
            } else if (targetId === "hab-19km") {
                target = {kind: "hab-stable", family: "balloon",
                    parameters: {startAGL: 19000 - SITE_GROUND[siteId], mslKm: 19}};
                wind = "hab-steady"; rangeM = 50000;
            } else {
                target = TARGETS["venus"]; wind = "zero"; rangeM = 5000;
            }
            out.push(entry("SITE-PROXY", 501, base({
                platform: "orbit-point", rangeM, durationSeconds: 15,
                siteId, target, wind, observation: {...WHITE_003},
            })));
        }

    return out;
}

export const EXPECTED_TOTAL = 855;   // 765 round-1 + 90 RECOVERABLE-NOISE (round 1.1)
