// m1Set.js — the M1 batch: the full thirteen-type maneuver taxonomy with its
// parameter variants, swept over clip duration and operator error.
//
// Structure of the sweep (the bench, m1.bench.test.js, iterates it):
//   duration  20 / 60 / 120 / 300 s          -> results/m1/batch_<D>sec/
//   error     0.0 / 0.15 / 0.3 deg wobble    ->   <batch>/<E>deg/
//   variant   the 23 rows below              ->     Input/ Truth/ All/
//
// Error levels are OPERATOR error: the wobble model (seeded random walk with
// reaction-delayed recentering), amplitude at the stated degrees. 0.0deg uses
// the clean observation — no error at all — so the ladder starts from a
// perfect operator. Other wobble parameters stay at the Aguadilla operator
// values; only the deadband amplitude climbs.
//
// Truth is shared down the error ladder by construction: the wobble spec
// lives in spec.observation, which generateScenario excludes from the truth
// key, so the three error levels of one variant are the SAME flight observed
// three ways.
//
// Variant table notes (per the agreed thirteen-type table + variant brief):
//   accel-instant     both directions of the step: 20->200 and 200->20 m/s.
//   highg-turn        20 g and 50 g, each with and without a lead-in (without:
//                     turning at full rate from frame 0 — no onset to detect).
//   hypersonic-glide  mach6 matches known hypersonic glide vehicles
//                     (1700 m/s ~ Mach 5.7 at 25 km); mach50 (15000 m/s) is
//                     far beyond any known system but keeps the aerodynamic
//                     dive; the pull-up variant mirrors the dive upward.
//   sine-wave         s-turn is a normal gentle weave (~1.3 g); impossible
//                     runs ~56 g lateral.
//   corkscrew         no lead-in: it spirals from frame 0 (the generator has
//                     never had a lead-in; stated here as a contract).
//   vertical-loop     aero ~3.3 g (aerobatic); tooslow flies the same circle
//                     at 15 m/s (0.11 g centripetal — an aircraft would fall
//                     off the top); toofast ~62 g.
//   figure-eight      plausible ~1.2 g; implausible ~41 g with 3 s lobes.
//
// A variant's anomalous flag is explicit (the M1 sweep can make a mundane
// shape anomalous by parameters and vice versa), and reaches the generator
// through spec.target.parameters.anomalous as usual.

import {DEFAULT_SITE} from "./generateScenario";

const ORBIT = {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000};

// Aguadilla operator wobble, amplitude swapped per error level.
const WOBBLE_BASE = {driftSpeed: 0.10, reactionTime: 0.4,
    correctionSpeed: 1.0, accuracy: 0.8};

export const M1_DURATIONS_SECONDS = [20, 60, 120, 300];

export const M1_ERROR_LEVELS = [
    {label: "0.0deg", observation: (fov) => ({kind: "clean", fovFullDeg: fov})},
    {label: "0.15deg", observation: (fov) => ({kind: "wobble", fovFullDeg: fov,
        wobble: {amplitude: 0.15, ...WOBBLE_BASE}})},
    {label: "0.3deg", observation: (fov) => ({kind: "wobble", fovFullDeg: fov,
        wobble: {amplitude: 0.3, ...WOBBLE_BASE}})},
];

export const M1_VARIANTS = [
    {kind: "static-point",     variant: null,           anomalous: false, rangeM: 5000,   parameters: {}},
    {kind: "straight-cv",      variant: null,           anomalous: false, rangeM: 20000,  parameters: {speed: 100}},
    {kind: "straight-ca",      variant: null,           anomalous: false, rangeM: 20000,  parameters: {}},
    {kind: "slow-turn",        variant: null,           anomalous: false, rangeM: 20000,  parameters: {speed: 100, radiusM: 3000}},
    {kind: "accel-instant",    variant: "20to200",      anomalous: true,  rangeM: 20000,  parameters: {v0: 20, v1: 200}},
    {kind: "accel-instant",    variant: "200to20",      anomalous: true,  rangeM: 20000,  parameters: {v0: 200, v1: 20}},
    {kind: "turn90-instant",   variant: null,           anomalous: true,  rangeM: 20000,  parameters: {}},
    {kind: "zigzag",           variant: null,           anomalous: true,  rangeM: 5000,   parameters: {}},
    {kind: "highg-turn",       variant: "20g-lead",     anomalous: true,  rangeM: 20000,  parameters: {gLoad: 20, leadIn: true}},
    {kind: "highg-turn",       variant: "20g-nolead",   anomalous: true,  rangeM: 20000,  parameters: {gLoad: 20, leadIn: false}},
    {kind: "highg-turn",       variant: "50g-lead",     anomalous: true,  rangeM: 20000,  parameters: {gLoad: 50, leadIn: true}},
    {kind: "highg-turn",       variant: "50g-nolead",   anomalous: true,  rangeM: 20000,  parameters: {gLoad: 50, leadIn: false}},
    {kind: "hypersonic-glide", variant: "mach6-dive",   anomalous: true,  rangeM: 100000, fovFullDeg: 2.0, parameters: {speed: 1700, sense: "dive"}},
    {kind: "hypersonic-glide", variant: "mach6-pullup", anomalous: true,  rangeM: 100000, fovFullDeg: 2.0, parameters: {speed: 1700, sense: "pullup"}},
    {kind: "hypersonic-glide", variant: "mach50-dive",  anomalous: true,  rangeM: 100000, fovFullDeg: 2.0, parameters: {speed: 15000, sense: "dive"}},
    {kind: "sine-wave",        variant: "s-turn",       anomalous: false, rangeM: 5000,   parameters: {speed: 80, amplitudeM: 300, periodSeconds: 30}},
    {kind: "sine-wave",        variant: "impossible",   anomalous: true,  rangeM: 5000,   parameters: {speed: 120, amplitudeM: 500, periodSeconds: 6}},
    {kind: "corkscrew",        variant: null,           anomalous: false, rangeM: 5000,   parameters: {}},
    {kind: "vertical-loop",    variant: "aero",         anomalous: false, rangeM: 5000,   parameters: {speed: 80, radiusM: 200}},
    {kind: "vertical-loop",    variant: "tooslow",      anomalous: true,  rangeM: 5000,   parameters: {speed: 15, radiusM: 200}},
    {kind: "vertical-loop",    variant: "toofast",      anomalous: true,  rangeM: 5000,   parameters: {speed: 350, radiusM: 200}},
    {kind: "figure-eight",     variant: "plausible",    anomalous: false, rangeM: 5000,   parameters: {}},
    {kind: "figure-eight",     variant: "implausible",  anomalous: true,  rangeM: 5000,   parameters: {speed: 200, radiusM: 100}},
];

export function m1Spec(v, durationSeconds, errorLevel) {
    return {
        epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the site
        durationSeconds, fps: 10,
        initialHorizontalRangeM: v.rangeM,
        siteId: DEFAULT_SITE,
        platform: {...ORBIT},
        target: {kind: v.kind, family: "maneuver",
            parameters: {...v.parameters,
                ...(v.variant ? {variant: v.variant} : {}),
                anomalous: v.anomalous}},
        wind: {kind: "zero"},   // self-propelled shapes; wind is not the subject
        observation: errorLevel.observation(v.fovFullDeg ?? 0.9),
    };
}
