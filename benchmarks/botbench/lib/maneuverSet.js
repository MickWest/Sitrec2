// maneuverSet.js — the TRACTABILITY maneuver set: one scenario per track kind
// at a deliberately DECISIVE geometry (orbiting sensor), so results are about
// the shape, not about collapse. Shared by the tractability runner
// (tractability.bench.test.js, whose records feed triage/dossiers) and by the
// file-writing bench (maneuver.bench.test.js). The swept, published maneuver
// sets are the botsets (lib/botsetManeuvers.js); this set is the single-point
// companion that the tractability study is measured on, not a predecessor.

import {MANEUVER_ANOMALOUS} from "./maneuverTargets";
import {DEFAULT_SITE} from "./generateScenario";
import {MANEUVER_DIAMETER_M, fovForFraction} from "./angularSize";

const ORBIT = {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000};

// Per-kind geometry: range and duration sized to keep the whole shape in a
// plausible sensor engagement. Hypersonic needs long range and a wide FOV or
// it crosses the scene in seconds.
export const MANEUVER_CASES = {
    "static-point":     {rangeM: 5000,   durationSeconds: 60},
    "straight-cv":      {rangeM: 20000,  durationSeconds: 60},
    "straight-ca":      {rangeM: 20000,  durationSeconds: 60},
    "slow-turn":        {rangeM: 20000,  durationSeconds: 60},
    "accel-instant":    {rangeM: 20000,  durationSeconds: 15},
    "turn90-instant":   {rangeM: 20000,  durationSeconds: 15},
    "zigzag":           {rangeM: 5000,   durationSeconds: 30},
    "highg-turn":       {rangeM: 20000,  durationSeconds: 15},
    "hypersonic-glide": {rangeM: 100000, durationSeconds: 60},
    "sine-wave":        {rangeM: 5000,   durationSeconds: 60},
    "corkscrew":        {rangeM: 5000,   durationSeconds: 60},
    "vertical-loop":    {rangeM: 5000,   durationSeconds: 30},
    "figure-eight":     {rangeM: 5000,   durationSeconds: 120},
};

export function maneuverSpecFor(kind) {
    const c = MANEUVER_CASES[kind];
    return {
        epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the ocean site
        durationSeconds: c.durationSeconds, fps: 10,
        initialHorizontalRangeM: c.rangeM,
        siteId: DEFAULT_SITE,
        platform: {...ORBIT},
        // The interchange truth flag reads spec.target.parameters.anomalous,
        // so the spec must declare it; the table keeps spec and generator in
        // agreement (the bench asserts they match).
        target: {kind, family: "maneuver",
            // Same diameter table as the maneuver botsets, imported rather than repeated: the two
            // sets share these kinds and a drift between them would make their
            // results incomparable without saying so.
            diameterM: MANEUVER_DIAMETER_M[kind],
            parameters: {anomalous: MANEUVER_ANOMALOUS[kind]}},
        wind: {kind: "zero"},   // self-propelled shapes; wind is not the subject
        observation: {kind: "white",
            fovFullDeg: c.fovFullDeg
                ?? fovForFraction(MANEUVER_DIAMETER_M[kind], c.rangeM),
            gaussianSigmaDeg: 0.03},
    };
}
