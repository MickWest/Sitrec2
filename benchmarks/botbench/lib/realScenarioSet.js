// realScenarioSet.js — the first-pass REAL-TRACK scenario definitions (case
// geometries: Go Fast, Aguadilla, Rubber Duck, burst probe, dash, circuits,
// impulse pairs), shared by the file-writing bench (realtracks.bench.test.js)
// and the tractability runner. See realSegments.js for the loader contract.

import {loadSegment, registerSegment} from "./realSegments";
import {DEFAULT_SITE} from "./generateScenario";

const RADIOSONDE = "balloon_radiosonde_Y1333892.csv";   // Oakland, full flight
const HEXAROTOR = "drone_px4_36634f3e.csv";             // slow (<6 m/s), 18 min
const VTOL_DASH = "drone_px4_0de00c98.csv";             // fastest real segment
const FW_CIRCUITS = "drone_px4_15b762bc.csv";           // 9.4 km path in 415 m box

// One row per scenario. `segment` feeds loadSegment; `impulse`/`paired` build
// the anomaly pairs; everything else is the familiar scenario spec surface.
export const REAL_SCENARIOS = [
    {
        label: "gofast", pairId: "gofast-pair", paired: true, pairOnsetSeconds: 15,
        note: "Go Fast geometry: 180 m/s platform at 7.6 km, balloon at 4 km "
            + "over the ocean. The mundane member of the pair.",
        segment: {file: RADIOSONDE, rule: "altitude", ruleArgs: {altitudeM: 4000},
            durationSeconds: 30, fps: 1, startAGL: 4000},
        platform: {kind: "straight", speedMS: 180, altitudeAGL: 7600},
        rangeM: 7000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03, sharedSeedKey: "gofast-pair"},
    },
    {
        label: "gofast", anomalous: true, pairId: "gofast-pair", pairOnsetSeconds: 15,
        note: "The same balloon segment with a +100 m/s eastward impulse at "
            + "t=15 s — a Go Fast that actually goes fast. Identical noise "
            + "realization to the control.",
        segment: {file: RADIOSONDE, rule: "altitude", ruleArgs: {altitudeM: 4000},
            durationSeconds: 30, fps: 1, startAGL: 4000},
        impulse: {onsetSeconds: 15, deltaVENU: [100, 0, 0]},
        platform: {kind: "straight", speedMS: 180, altitudeAGL: 7600},
        rangeM: 7000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03, sharedSeedKey: "gofast-pair"},
    },
    {
        label: "aguadilla",
        note: "Aguadilla geometry: 100 m/s platform arcing at 1.2 km, "
            + "lantern-like riser near the surface (radiosonde launch phase), "
            + "operator wobble.",
        segment: {file: RADIOSONDE, rule: "offset", ruleArgs: {offsetSeconds: 0},
            durationSeconds: 120, fps: 1, startAGL: 150},
        platform: {kind: "curve", bankDeg: 10, speedMS: 100, altitudeAGL: 1200},
        rangeM: 3000, observation: {kind: "wobble", fovFullDeg: 0.9,
            wobble: {amplitude: 0.15, driftSpeed: 0.10, reactionTime: 0.4,
                correctionSpeed: 1.0, accuracy: 0.8}},
    },
    {
        label: "rubberduck-balloon",
        note: "Rubber Duck geometry: two full 2 km orbits (360 s) of a "
            + "drifting balloon. It is a radiosonde, so it CLIMBS ~5 m/s "
            + "while it drifts: 1.0 -> ~3.2 km across the orbits.",
        segment: {file: RADIOSONDE, rule: "altitude", ruleArgs: {altitudeM: 1000},
            durationSeconds: 360, fps: 1, startAGL: 1000},
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 6000},
        rangeM: 2000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03},
    },
    {
        label: "burst",
        note: "Radiosonde burst: +5 m/s climb to -40 m/s fall in one sample, "
            + "on a completely mundane object. Any anomaly detector that "
            + "fires here is detecting discontinuity, not capability.",
        segment: {file: RADIOSONDE, rule: "burst", ruleArgs: {beforeSeconds: 45},
            durationSeconds: 90, fps: 1, startAGL: 3000},
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
        rangeM: 5000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03},
    },
    {
        label: "rubberduck-drone",
        note: "Rubber Duck, drone edition: two full orbits of a slow "
            + "hexarotor (<6 m/s) at 100 m.",
        segment: {file: HEXAROTOR, rule: "offset", ruleArgs: {offsetSeconds: 60},
            durationSeconds: 360, fps: 2, startAGL: 100, cleanMaxSpeedMS: 30},
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
        rangeM: 2000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03},
    },
    {
        label: "dash",
        note: "Real VTOL dash segment seen from 20 km on a straight pass: "
            + "fast-near vs slow-far, with genuine flight texture.",
        segment: {file: VTOL_DASH, rule: "peak-speed", ruleArgs: {},
            durationSeconds: 30, fps: 10, startAGL: 500,
            // Real peak ~87 m/s; steps run to ~200. The 0.013 s sampling makes
            // the speed cap alone fire on metre-scale estimator jitter, which
            // the loader's minimum-displacement guard now keeps (study F7).
            cleanMaxSpeedMS: 120},
        platform: {kind: "straight", speedMS: 70, altitudeAGL: 3000},
        rangeM: 20000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03},
    },
    {
        label: "circuits",
        note: "Real fixed-wing circuits (9.4 km of path inside a 415 m box) "
            + "under a 5 km orbit — repeated crossings of the same bearings.",
        segment: {file: FW_CIRCUITS, rule: "offset", ruleArgs: {offsetSeconds: 60},
            durationSeconds: 120, fps: 5, startAGL: 300,
            cleanMaxSpeedMS: 60},    // real ~28-40 m/s; eight ~90 m steps
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
        rangeM: 5000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03},
    },
    {
        label: "hover", pairId: "hover-pair", paired: true, pairOnsetSeconds: 30,
        note: "Slow hexarotor segment through a zero-magnitude sham splice — "
            + "the control of the drone impulse pair.",
        segment: {file: HEXAROTOR, rule: "offset", ruleArgs: {offsetSeconds: 500},
            durationSeconds: 60, fps: 2, startAGL: 100, cleanMaxSpeedMS: 30},
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
        rangeM: 2000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03, sharedSeedKey: "hover-pair"},
    },
    {
        label: "hover", anomalous: true, pairId: "hover-pair", pairOnsetSeconds: 30,
        note: "The same hexarotor segment with a +120 m/s northward impulse "
            + "at t=30 s. Identical noise realization to the control.",
        segment: {file: HEXAROTOR, rule: "offset", ruleArgs: {offsetSeconds: 500},
            durationSeconds: 60, fps: 2, startAGL: 100, cleanMaxSpeedMS: 30},
        impulse: {onsetSeconds: 30, deltaVENU: [0, 120, 0]},
        platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
        rangeM: 2000, observation: {kind: "white", fovFullDeg: 0.5,
            gaussianSigmaDeg: 0.03, sharedSeedKey: "hover-pair"},
    },
];

export function buildRealSpec(def, segKey) {
    return {
        epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the ocean site
        durationSeconds: def.segment.durationSeconds, fps: def.segment.fps,
        initialHorizontalRangeM: def.rangeM,
        siteId: DEFAULT_SITE,
        platform: def.platform,
        target: {kind: "real-segment", family: "real", parameters: {
            segmentKey: segKey, label: def.label,
            anomalous: def.anomalous === true,
            ...(def.paired ? {paired: true} : {}),
            ...(def.impulse ? {impulse: def.impulse} : {}),
            ...(def.pairOnsetSeconds != null ? {pairOnsetSeconds: def.pairOnsetSeconds} : {}),
            // Everything the loader needs to reconstruct the truth (audit F3):
            // the cleaning caps change the loaded track, so they are declared.
            source: {file: def.segment.file, rule: def.segment.rule,
                ruleArgs: def.segment.ruleArgs,
                startAGL: def.segment.startAGL,
                cleanMaxSpeedMS: def.segment.cleanMaxSpeedMS ?? 100,
                cleanMaxVSpeedMS: def.segment.cleanMaxVSpeedMS ?? 20,
                cleanMinStepM: def.segment.cleanMinStepM ?? 20},
        }},
        wind: {kind: "zero"},   // the real motion already embodies its wind
        observation: def.observation,
        pairId: def.pairId ?? null,
    };
}


// Load the segment, register it, and return the ready spec.
export function buildRealScenarioSpec(def) {
    const seg = loadSegment(def.segment);
    const segKey = registerSegment(seg);
    return {spec: buildRealSpec(def, segKey), seg};
}
