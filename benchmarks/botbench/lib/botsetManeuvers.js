// botsetManeuvers.js — the maneuver taxonomy: thirteen track types with their
// parameter variants, swept over clip duration and operator error.
//
// The table is ONE taxonomy, published as TWO sets, partitioned by the
// `anomalous` flag:
//
//   botset_anomalies   15 variants — no conventional model should fit
//   botset_mundane      8 variants — a conventional model exists and must be found
//
// The partition is a publishing decision, not a modelling one. The variants
// share a spec builder, a seed, a duration ladder and an error ladder, so a
// result from one set is directly comparable with a result from the other. What
// the split buys is that "did we find the mundane answer" and "did we correctly
// report an anomaly" stop being one mixed number over one mixed folder — they
// are different questions and a mixed set cannot answer either cleanly.
//
// Structure of the sweep (botset-maneuvers.bench.test.js iterates it):
//   set       anomalies / mundane        -> results/botset_<set>/
//   duration  20 / 60 / 120 / 300 s      ->   batch_<D>s/
//   error     0.0 to 2.0 deg, nine rungs  ->     <E>deg/
//   variant   the rows below             ->       Input/ Truth/ All/ meta/
//
// Truth is shared down the error ladder by construction: the error spec lives
// in spec.observation, which generateScenario excludes from the truth key, so
// the nine error rungs of one variant are the SAME flight observed nine ways.
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
// A variant's anomalous flag is explicit (a mundane shape can be made anomalous
// by parameters and vice versa), and reaches the generator through
// spec.target.parameters.anomalous as usual.

import {DEFAULT_SITE} from "./generateScenario";
import {MANEUVER_DIAMETER_M, fovForFraction} from "./angularSize";
import {BOTSET_ERROR_LEVELS} from "./botsetErrors";

const ORBIT = {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000};

export const BOTSET_MANEUVER_DURATIONS_SECONDS = [20, 60, 120, 300];

// The shared operator-wobble ladder, in degrees (botsetErrors.js): a zero-mean
// random walk that recentres, which is what an operator tracking a moving
// target produces.
export const BOTSET_MANEUVER_ERROR_LEVELS = BOTSET_ERROR_LEVELS;

export const BOTSET_MANEUVER_VARIANTS = [
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
    {kind: "hypersonic-glide", variant: "mach6-dive",   anomalous: true,  rangeM: 100000, parameters: {speed: 1700, sense: "dive"}},
    {kind: "hypersonic-glide", variant: "mach6-pullup", anomalous: true,  rangeM: 100000, parameters: {speed: 1700, sense: "pullup"}},
    {kind: "hypersonic-glide", variant: "mach50-dive",  anomalous: true,  rangeM: 100000, parameters: {speed: 15000, sense: "dive"}},
    {kind: "sine-wave",        variant: "s-turn",       anomalous: false, rangeM: 5000,   parameters: {speed: 80, amplitudeM: 300, periodSeconds: 30}},
    {kind: "sine-wave",        variant: "impossible",   anomalous: true,  rangeM: 5000,   parameters: {speed: 120, amplitudeM: 500, periodSeconds: 6}},
    {kind: "corkscrew",        variant: null,           anomalous: false, rangeM: 5000,   parameters: {}},
    {kind: "vertical-loop",    variant: "aero",         anomalous: false, rangeM: 5000,   parameters: {speed: 80, radiusM: 200}},
    {kind: "vertical-loop",    variant: "tooslow",      anomalous: true,  rangeM: 5000,   parameters: {speed: 15, radiusM: 200}},
    {kind: "vertical-loop",    variant: "toofast",      anomalous: true,  rangeM: 5000,   parameters: {speed: 350, radiusM: 200}},
    {kind: "figure-eight",     variant: "plausible",    anomalous: false, rangeM: 5000,   parameters: {}},
    {kind: "figure-eight",     variant: "implausible",  anomalous: true,  rangeM: 5000,   parameters: {speed: 200, radiusM: 100}},
];

/**
 * The two published sets. `anomalous` is the partition predicate, so adding a
 * variant to the table above puts it in exactly one set automatically and
 * neither set can silently lose a row.
 */
export const BOTSET_MANEUVER_SETS = [
    {key: "anomalies", dirName: "botset_anomalies", anomalous: true,
        blurb: "no conventional model should fit"},
    {key: "mundane", dirName: "botset_mundane", anomalous: false,
        blurb: "a conventional model exists and must be found"},
];

export function botsetManeuverSet(key) {
    const s = BOTSET_MANEUVER_SETS.find((x) => x.key === key);
    if (!s) throw new Error(`botsetManeuvers: unknown set "${key}"`);
    return s;
}

/** The variants belonging to one published set. */
export function botsetManeuverVariants(key) {
    return BOTSET_MANEUVER_VARIANTS.filter(
        (v) => v.anomalous === botsetManeuverSet(key).anomalous);
}

/** The field of view that frames this variant's object at its nominal range. */
export function botsetManeuverFov(v) {
    return v.fovFullDeg ?? fovForFraction(MANEUVER_DIAMETER_M[v.kind], v.rangeM);
}

export function botsetManeuverSpec(v, durationSeconds, errorLevel) {
    const fovFullDeg = botsetManeuverFov(v);
    return {
        epochISO: "2025-02-01T20:00:00Z",   // noon PST: daylight at the site
        durationSeconds, fps: 10,
        initialHorizontalRangeM: v.rangeM,
        siteId: DEFAULT_SITE,
        platform: {...ORBIT},
        target: {kind: v.kind, family: "maneuver",
            // Physical diameter is TRUTH and belongs on the target, so it enters
            // the truth key: a different-sized object is a different answer. It
            // is constant down the error ladder, so truth sharing is unaffected.
            diameterM: MANEUVER_DIAMETER_M[v.kind],
            parameters: {...v.parameters,
                ...(v.variant ? {variant: v.variant} : {}),
                anomalous: v.anomalous}},
        wind: {kind: "zero"},   // self-propelled shapes; wind is not the subject
        // FOV is DERIVED, not declared: it is whatever frames this object at
        // this range (see angularSize.js). A fixed 0.9 deg made a 12 m glider at
        // 100 km a sub-pixel speck and a 2 m balloon at 5 km a smear, so the
        // apparent-size channel carried nothing on either. The error ladder is
        // absolute degrees (botsetErrors.js); a rung this field cannot hold
        // widens it, so the observation's fovFullDeg can exceed the framing
        // field returned by botsetManeuverFov.
        observation: errorLevel.observation(fovFullDeg),
    };
}
