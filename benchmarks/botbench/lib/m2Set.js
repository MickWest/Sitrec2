// m2Set.js — the M2-BALLOONS batch: buoyant targets swept over platform
// geometry, target behaviour, range and OPERATOR DRIFT.
//
// Structure of the sweep, laid out exactly like M1 so the two read alike:
//   platform  straight / curve / orbit        -> results/m2-balloons/batch_<P>/
//   drift     0.0 / 0.1 / 0.5 deg             ->   <batch>/<E>deg/
//   variant   the 20 rows below               ->     Input/ Truth/ All/
//
// M1 sweeps clip DURATION on its outer axis because a maneuver's detectability
// is a question about time. A balloon's is a question about GEOMETRY — how the
// sensor moves relative to a target that barely moves at all — so the outer
// axis here is the platform path, and duration is pinned at the 20 s a real
// tracking clip tends to be.
//
// WHY THE ERROR LADDER IS DRIFT, NOT WOBBLE. M1's ladder is the Aguadilla
// wobble: a seeded random walk that recentres, i.e. zero-mean. Zero-mean error
// is the kind a fit absorbs best. A slow one-way slide off the target is the
// kind it cannot, because over a short clip it is indistinguishable from the
// target genuinely drifting — which is precisely the question a balloon set
// exists to ask. The two sets therefore probe different failure modes, and the
// folder name states the true on-sky angle reached by the end of the clip.
//
// Truth is shared down the drift ladder by construction, exactly as in M1: the
// observation section is excluded from the truth key, so the three drift levels
// of one variant are the SAME balloon observed three ways.

import {DEFAULT_SITE} from "./generateScenario";

const MILE_M = 1609.344;

// A tracking aircraft, not M1's low orbiter: 21,000 ft and 130 m/s, the case
// these scenarios were built to reproduce.
const PLATFORM_ALT_AGL_M = 6400.8;
const PLATFORM_SPEED_MS = 130;

// One camera for the whole set. 3 degrees is a realistic narrow tracking FOV
// and is wide enough that a 0.5 deg drift stays well inside the frame — the
// set is about what the FIT does with the error, so a target masked out by the
// field of view would be measuring something else.
export const M2_FOV_FULL_DEG = 3.0;

export const M2_PLATFORMS = [
    {label: "straight", spec: {kind: "straight"}},
    // A gentle constant bank, the "banking away" case: the sensor's own turn is
    // most of the parallax a short clip gets.
    {label: "curve", spec: {kind: "curve", bankDeg: 10}},
    // The strongest geometry available — a full orbit of the target's ground
    // point — as the upper bound on what parallax can buy.
    {label: "orbit", spec: {kind: "orbit-point"}},
].map((p) => ({...p, spec: {...p.spec,
    speedMS: PLATFORM_SPEED_MS, altitudeAGL: PLATFORM_ALT_AGL_M}}));

export const M2_ERROR_LEVELS = [
    {label: "0.0deg", driftDeg: 0,
        observation: (fov) => ({kind: "clean", fovFullDeg: fov})},
    {label: "0.1deg", driftDeg: 0.1,
        observation: (fov) => ({kind: "drift", fovFullDeg: fov, driftDeg: 0.1})},
    {label: "0.5deg", driftDeg: 0.5,
        observation: (fov) => ({kind: "drift", fovFullDeg: fov, driftDeg: 0.5})},
];

// The ranges, as the round numbers a reader thinks in. Statute miles.
export const M2_RANGES_MILES = [2, 8, 20, 50];

// The five behaviours, as the vertical rate and the drift speed that define a
// buoyant object. `sinking` rides party-rising with a NEGATIVE ascent rate —
// the same integration, a leaking envelope instead of a climbing one — because
// party-neutral pins its rate at zero and cannot express descent.
//
// TWO ORTHOGONAL AXES THROUGH ONE CENTRE. `level` is the shared reference:
// rising/level/sinking vary the VERTICAL rate at one wind, and slow/level/fast
// vary the DRIFT speed at zero vertical rate. Every row is a distinct scenario
// — an earlier draft gave `slow` and `level` the same wind, which made them the
// same file, and the duplicate-basename check in m2Batch caught it.
export const M2_BEHAVIOURS = [
    {label: "rising",  kind: "party-rising",  wind: "fixed",      parameters: {startAGL: 920, ascentRate: 3}},
    {label: "level",   kind: "party-neutral", wind: "fixed",      parameters: {startAGL: 920}},
    {label: "sinking", kind: "party-rising",  wind: "fixed",      parameters: {startAGL: 1200, ascentRate: -2}},
    {label: "slow",    kind: "party-neutral", wind: "light",      parameters: {startAGL: 920}},
    {label: "fast",    kind: "party-neutral", wind: "hab-steady", parameters: {startAGL: 920}},
];

// behaviour x range: 5 x 4 = 20 rows per batch folder.
export const M2_VARIANTS = [];
for (const b of M2_BEHAVIOURS) {
    for (const miles of M2_RANGES_MILES) {
        M2_VARIANTS.push({
            behaviour: b.label,
            rangeMiles: miles,
            rangeM: Math.round(miles * MILE_M),
            kind: b.kind,
            wind: b.wind,
            parameters: b.parameters,
        });
    }
}

export function m2Spec(v, platform, errorLevel) {
    return {
        epochISO: "2026-06-15T20:00:00Z",   // daylight at the site
        durationSeconds: 20, fps: 10,
        initialHorizontalRangeM: v.rangeM,
        siteId: DEFAULT_SITE,
        platform: {...platform.spec},
        target: {kind: v.kind, family: "balloon", parameters: {...v.parameters}},
        wind: {kind: v.wind},
        observation: errorLevel.observation(M2_FOV_FULL_DEG),
    };
}
