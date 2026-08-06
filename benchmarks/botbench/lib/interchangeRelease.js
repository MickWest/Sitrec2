// interchangeRelease.js — build a BOT interchange release (the curated
// scenario set + the challenge/answers split + the integrity manifest).
//
// Kept out of the .bench test so the adversary test in tests/botbench/ can
// build releases and attack them.
//
// THE CENTRAL SECURITY PROPERTY
// -----------------------------
// A sealed challenge must not be reproducible from public information. The
// templates below ARE public (they live in this repo), so a sealed release
// must NOT use them verbatim:
//
//   * every template's scenarioSeed is public, so the truth realization is
//     reproducible;
//   * worse, generatePlatformPath takes NO seed — the sensor trajectory is a
//     pure function of the spec — so an adversary who knows the spec can
//     regenerate the shipped SensorPos columns exactly, whatever the seed.
//
// So an adversary reads a shipped input.csv, takes its TrackID from the file,
// regenerates each public template under that TrackID and compares bytes. An
// exact match hands them both the identity AND the truth. Permuting the ids
// under a secret salt does nothing about this: it protects the LABEL while the
// CONTENT stays reproducible.
//
// The fix is that a sealed release draws its actual parameters from the
// withheld salt (randomizeSpec): range, speed, altitude, duration and start
// altitude are jittered, and the scenario seed is salt-derived. The adversary
// still knows the KINDS of scenario in the set — that is unavoidable and fine
// — but cannot reproduce any specific realization, so cannot pin ids to truth.
//
// tests/botbench/interchangeReidentification.test.js runs that exact attack
// against both a non-randomized release (must be fully re-identified — proving
// the attack works) and a randomized one (must not be re-identified at all).

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {WIND_CONFIGS} from "./wind";
import {VENUS_EPOCH_ISO} from "./venus";
import {deriveSeed, makeStream} from "./rng";
import {writeInterchange, scenarioBaseName, sha256, saltedCommit,
    INTERCHANGE_SPEC_VERSION} from "./exportInterchange";

const OCEAN = "ocean";
const EPOCH = "2025-02-01T20:00:00Z";
// Venus truth is generated at venus.js's own VENUS_EPOCH_ISO (a night epoch)
// and generateScenario does NOT forward spec.epochISO to it, so the celestial
// scenario's published epoch is forced. Left alone it was the ONLY night epoch
// in the set, which fingerprints it regardless of the id. Non-celestial truth
// ignores epochISO entirely (it is only recorded), so sharing that epoch with
// a few other scenarios removes the tell at zero cost to their truth.
const NIGHT_EPOCH = VENUS_EPOCH_ISO;

// SAMPLE RATE. The whole set is generated at 1 Hz: one measurement per second,
// which is what a human-operated sensor or a downsampled feed actually delivers,
// and the rate at which the range problem is hardest per unit of clip time.
// n = durationSeconds * FPS + 1, so a 60 s clip is 61 rows and a 15 s clip is 16.
//
// One consequence worth knowing before you weight anything: the operator-wobble
// model's time constants (0.4 s reaction, 1.0 correction speed) are FASTER than
// the 1 s sample interval, so at this rate its error is heavily aliased and
// looks close to white in the sampled series even though the underlying process
// is correlated. scenario.json still declares it correlated with no white sigma,
// which is the honest declaration; do not conclude from a lag-1 autocorrelation
// near zero that you may treat it as white.
const FPS = 1;

const CLEAN = {kind: "clean", fovFullDeg: 0.5};
const WHITE_003 = {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03};
// Fast or long-crossing targets need a sensor that is not zoomed all the way
// in, or they leave the frame mid-clip and the cell measures FOV bookkeeping
// instead of the geometry it was chosen for.
const WHITE_003_WIDE = {kind: "white", fovFullDeg: 4.0, gaussianSigmaDeg: 0.03};
const WOBBLE = {
    kind: "wobble", fovFullDeg: 0.9,
    wobble: {amplitude: 0.15, driftSpeed: 0.10, reactionTime: 0.4,
        correctionSpeed: 1.0, accuracy: 0.8},
};
const WOBBLE_WIDE = {
    kind: "wobble", fovFullDeg: 4.0,
    wobble: {amplitude: 0.15, driftSpeed: 0.10, reactionTime: 0.4,
        correctionSpeed: 1.0, accuracy: 0.8},
};

const ORBIT = {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000};
const STRAIGHT = {kind: "straight", speedMS: 70, altitudeAGL: 3000};
const CURVE = {kind: "curve", bankDeg: 10, speedMS: 70, altitudeAGL: 3000};
// rangeErrorFactor 2.0, NOT 1.0. The factor scales where the orbit centre sits
// along the initial sightline, so 1.0 puts it exactly ON the target and a Kasa
// circle fit to the published sensor columns hands over the target's initial
// ground position — the same leak that forces orbit-point to be rewritten for a
// sealed release, except randomizeSpec would leave an explicit 1.0 alone and
// the sealed extraction gate would then fail to draw a geometry at all.
const ORBIT_DIR_2 = {kind: "orbit-direction", rangeErrorFactor: 2.0,
    speedMS: 70, altitudeAGL: 3000};
const S_CURVE_TOWARD = {kind: "s-curve-toward", bankAmplitudeDeg: 15,
    bankPeriodSeconds: 12, speedMS: 70, altitudeAGL: 3000};
const S_CURVE_PERP = {kind: "s-curve-perp", bankAmplitudeDeg: 15,
    bankPeriodSeconds: 12, speedMS: 70, altitudeAGL: 3000};

const BALLOON_NEUTRAL = {kind: "party-neutral", family: "balloon",
    parameters: {startAGL: 500}};
const BALLOON_RISING = {kind: "weather-rising", family: "balloon",
    parameters: {startAGL: 300, ascentRate: 5}};
const BALLOON_PARTY_RISING = {kind: "party-rising", family: "balloon",
    parameters: {startAGL: 300, ascentRate: 3}};
const HAB = {kind: "hab-stable", family: "balloon",
    parameters: {startAGL: 20000, mslKm: 20}};
const AEROSTAT = {kind: "tethered-aerostat", family: "aerostat", parameters: {}};
const BIRD = {kind: "bird", family: "bird", parameters: {}};
const AIRCRAFT_CRUISE = {kind: "aircraft-cruise", family: "aircraft", parameters: {}};
const AIRCRAFT_TURN = {kind: "aircraft-turn", family: "aircraft", parameters: {}};

const anomalousTarget = (tupleId, anomalous) => ({
    kind: "anomalous", family: "anomalous", parameters: {tupleId, anomalous},
});

// Shared pointing-error realization for the anomaly/control pair: both members
// see the EXACT same noise, so any difference in solver behaviour is the
// manoeuvre, not the draw.
const PAIR_KEY = "interchange-impulse-east";
const PAIR_KEY_20G = "interchange-pulse-20g";

/**
 * The curated set. PUBLIC by construction — these live in the repo. A sealed
 * release uses them only as TEMPLATES; see randomizeSpec.
 *
 * jitterKey groups scenarios that must receive the SAME parameter jitter.
 * The anomaly/control pair has to stay a matched pair (identical geometry and
 * noise, differing only in the manoeuvre), so both members share a key. The
 * two members of the clean/noisy balloon comparison likewise share truth.
 */
export const SCENARIOS = [
    {
        jitterKey: "balloon-orbit-60s",
        note: "Recoverable reference, noiseless. 70 m/s orbit at 5 km, 60 s, "
            + "neutral party balloon drifting at 500 m AGL. Strong parallax: "
            + "CV/KS recover range to ~0.6% here. The control that says "
            + "'my reader works'.",
        designIntent: "recoverable",
        scenarioSeed: 101,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT, target: BALLOON_NEUTRAL,
            wind: {kind: "fixed"}, observation: CLEAN},
    },
    {
        jitterKey: "balloon-orbit-60s",
        note: "Same truth as above with realistic white pointing noise "
            + "(0.03 deg per-axis). The workhorse case.",
        designIntent: "recoverable",
        scenarioSeed: 101,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT, target: BALLOON_NEUTRAL,
            wind: {kind: "fixed"}, observation: WHITE_003},
    },
    {
        jitterKey: "balloon-straight-15s",
        note: "THE COLLAPSE TRAP. Straight-and-level sensor, 15 s, same "
            + "balloon. Range is unobservable: every free solver collapses "
            + "onto the sensor (relSep 1.0, ~90 deg residual). An algorithm "
            + "that reports Status=abstain here is CORRECT; one that returns "
            + "a confident position is not.",
        designIntent: "degenerate-by-design",
        scenarioSeed: 101,
        spec: {epochISO: NIGHT_EPOCH, durationSeconds: 15, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: STRAIGHT, target: BALLOON_NEUTRAL,
            wind: {kind: "fixed"}, observation: WHITE_003},
    },
    {
        jitterKey: "balloon-curve-wobble",
        note: "CORRELATED noise. Banked-curve sensor, 60 s, same balloon, "
            + "operator tracking wobble (0.15 deg deadband) instead of white "
            + "noise. Estimators that assume white measurement error are "
            + "mis-specified here — that is the point.",
        designIntent: "recoverable",
        scenarioSeed: 102,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: CURVE, target: BALLOON_NEUTRAL,
            wind: {kind: "fixed"}, observation: WOBBLE},
    },
    {
        jitterKey: "balloon-rising-shear",
        note: "Climbing target through wind shear. 5 m/s weather balloon "
            + "rising from 300 m AGL in a layered, gusty wind — vertical "
            + "motion coupled to a changing horizontal drift.",
        designIntent: "recoverable",
        scenarioSeed: 103,
        spec: {epochISO: NIGHT_EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT, target: BALLOON_RISING,
            wind: {kind: "layered-gust"}, observation: WHITE_003},
    },
    {
        // Same key as the control below: a matched pair must keep identical
        // geometry, so both members receive the same jitter.
        jitterKey: "impulse-east-pair",
        note: "ANOMALY member of a matched pair. 120 m/s target takes an "
            + "instantaneous +150 m/s eastward velocity step at t=5 s, seen "
            + "from a 20 km orbit over 15 s. Physically impossible.",
        designIntent: "weak-geometry",
        scenarioSeed: 401,
        spec: {epochISO: EPOCH, durationSeconds: 15, fps: FPS,
            initialHorizontalRangeM: 20000, siteId: OCEAN,
            platform: ORBIT,
            target: {kind: "anomalous", family: "anomalous",
                parameters: {tupleId: "impulse-east", anomalous: true}},
            wind: {kind: "zero"},
            observation: {...WHITE_003, sharedSeedKey: PAIR_KEY}},
    },
    {
        jitterKey: "impulse-east-pair",
        note: "CONTROL member of the same pair: the same manoeuvre flown "
            + "within a physically achievable envelope, with an IDENTICAL "
            + "pointing-error realization (shared seed key). Any behavioural "
            + "difference from the anomaly member is the manoeuvre alone.",
        designIntent: "weak-geometry",
        scenarioSeed: 401,
        spec: {epochISO: EPOCH, durationSeconds: 15, fps: FPS,
            initialHorizontalRangeM: 20000, siteId: OCEAN,
            platform: ORBIT,
            target: {kind: "anomalous", family: "anomalous",
                parameters: {tupleId: "impulse-east", anomalous: false}},
            wind: {kind: "zero"},
            observation: {...WHITE_003, sharedSeedKey: PAIR_KEY}},
    },
    {
        jitterKey: "venus-orbit",
        note: "DIRECTION-ONLY truth. Venus: effectively at infinity, so there "
            + "is no finite position to recover and truth.csv's TruePosition "
            + "columns are EMPTY — the bearings are in truth.json's "
            + "directionTruth. Every finite-range solver collapses onto the "
            + "sensor; a fixed-direction fit lands at ~0.016 deg. Tests that a "
            + "consumer handles truthKind='direction'.",
        designIntent: "no-finite-range",
        scenarioSeed: 501,
        spec: {epochISO: NIGHT_EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT,
            target: {kind: "venus", family: "venus", parameters: {}},
            wind: {kind: "zero"}, observation: WHITE_003},
    },

    // --- Added for the v1.1 set: sensor, target and range coverage ----------
    // The eight above are the diagnostic cases — each one exists to catch a
    // specific reader or solver mistake. These twelve broaden the set so a
    // consumer meets more than one sensor construction, more than one object
    // class and more than two decades of range.

    {
        jitterKey: "aerostat-straight-60s",
        note: "STRAIGHT SENSOR THAT IS NOT A TRAP. A tethered aerostat is "
            + "stationary, and a stationary target is over-determined by a "
            + "straight baseline: a fixed-point fit holds 0.08-0.09 relative "
            + "separation here while CV and Kalman collapse. Read alongside "
            + "the collapse trap — same sensor construction, opposite verdict, "
            + "which is why observability is a property of the geometry AND "
            + "the model, never of the geometry alone.",
        designIntent: "recoverable",
        scenarioSeed: 104,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: STRAIGHT, target: AEROSTAT,
            wind: {kind: "fixed"}, observation: WHITE_003},
    },
    {
        jitterKey: "aerostat-scurve-perp",
        note: "S-curve sensor weaving perpendicular to the sightline against "
            + "the same stationary aerostat. The weave manufactures a baseline "
            + "a straight pass does not have; compare its conditioning with "
            + "the straight cell above.",
        designIntent: "recoverable",
        scenarioSeed: 105,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: S_CURVE_PERP, target: AEROSTAT,
            wind: {kind: "zero"}, observation: WHITE_003},
    },
    {
        jitterKey: "balloon-scurve-toward-2km",
        note: "CLOSE RANGE, 2 km. Party balloon rising at 3 m/s seen from an "
            + "S-curve flown toward it. Weaving along the sightline buys far "
            + "less baseline than weaving across it — the near-range twin of "
            + "the perpendicular cell.",
        designIntent: "recoverable",
        scenarioSeed: 106,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 2000, siteId: OCEAN,
            platform: S_CURVE_TOWARD, target: BALLOON_PARTY_RISING,
            wind: {kind: "fixed-gust"}, observation: WHITE_003},
    },
    {
        jitterKey: "balloon-curve-20km",
        note: "LONG RANGE BALLOON, 20 km. The same neutral party balloon as "
            + "the reference cell, four times further out from a banked curve. "
            + "Angular size of the manoeuvre falls with range, so this is the "
            + "reference case's difficulty knob.",
        designIntent: "recoverable",
        scenarioSeed: 107,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 20000, siteId: OCEAN,
            platform: CURVE, target: BALLOON_NEUTRAL,
            wind: {kind: "fixed"}, observation: WHITE_003},
    },
    {
        jitterKey: "hab-50km",
        note: "HIGH-ALTITUDE BALLOON at 50 km, 20 km MSL, in a 20 m/s steady "
            + "upper wind, from an orbit centred on the sightline rather than "
            + "on the target. The altitude-coupling case: at this range the "
            + "flat-plane surface model matters, and a solver that assumes a "
            + "curved earth without reading scenario.json is wrong by "
            + "hundreds of metres in Z.",
        designIntent: "recoverable",
        scenarioSeed: 108,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 50000, siteId: OCEAN,
            platform: ORBIT_DIR_2, target: HAB,
            wind: {kind: "hab-steady"}, observation: WHITE_003_WIDE},
    },
    {
        jitterKey: "aircraft-cruise-curve",
        note: "COOPERATIVE TARGET. Airliner in level cruise at 20 km from a "
            + "banked curve: constant velocity is the RIGHT model here, so a "
            + "CV fit should be near-optimal. The set needs a case where the "
            + "cheap solver wins, or it reads as an argument for physics "
            + "priors everywhere.",
        designIntent: "recoverable",
        scenarioSeed: 109,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 20000, siteId: OCEAN,
            platform: CURVE, target: AIRCRAFT_CRUISE,
            wind: {kind: "fixed"}, observation: WHITE_003_WIDE},
    },
    {
        jitterKey: "aircraft-turn-orbit",
        note: "MANOEUVRING TARGET. The same airliner in a sustained turn — a "
            + "physically ordinary manoeuvre that breaks constant velocity. "
            + "Distinguishing this from an anomaly is the discrimination the "
            + "benchmark is for: both violate CV, only one violates physics.",
        designIntent: "recoverable",
        scenarioSeed: 110,
        spec: {epochISO: NIGHT_EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 20000, siteId: OCEAN,
            platform: ORBIT, target: AIRCRAFT_TURN,
            wind: {kind: "fixed"}, observation: WHITE_003_WIDE},
    },
    {
        jitterKey: "aircraft-straight-wobble",
        note: "MIS-SPECIFIED NOISE ON A WEAK GEOMETRY. Cruising aircraft, "
            + "straight sensor, operator wobble. Both the range degeneracy and "
            + "the correlated error are present at once; a solver that "
            + "abstains here is behaving correctly.",
        designIntent: "degenerate-by-design",
        scenarioSeed: 111,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 20000, siteId: OCEAN,
            platform: STRAIGHT, target: AIRCRAFT_CRUISE,
            wind: {kind: "fixed"}, observation: WOBBLE_WIDE},
    },
    {
        jitterKey: "bird-orbit",
        note: "SMALL ERRATIC TARGET. A bird at 5 km: slow, close, and "
            + "manoeuvring on its own timescale. Its truth comes from a seeded "
            + "integration, so it is the cell most sensitive to reading the "
            + "time grid correctly.",
        designIntent: "recoverable",
        scenarioSeed: 112,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT, target: BIRD,
            wind: {kind: "fixed"}, observation: WHITE_003},
    },
    {
        jitterKey: "balloon-rising-wobble-curve",
        note: "CLIMB THROUGH SHEAR UNDER CORRELATED NOISE. The rising "
            + "weather balloon of the shear cell, but tracked by a wobbling "
            + "operator instead of a clean sensor — vertical motion, changing "
            + "drift and mis-specified error together.",
        designIntent: "recoverable",
        scenarioSeed: 113,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: CURVE, target: BALLOON_RISING,
            wind: {kind: "layered-gust"}, observation: WOBBLE},
    },
    {
        // Matched pair, so both members share a jitter key and a noise draw.
        jitterKey: "pulse-20g-pair",
        note: "ANOMALY member of a second matched pair, at a RECOVERABLE "
            + "geometry rather than the 20 km weak one: a 20 g pulse seen "
            + "from a 5 km orbit over 60 s. The impulse pair asks whether you "
            + "can detect an anomaly you cannot localise; this one asks "
            + "whether you can detect one you can.",
        designIntent: "recoverable",
        scenarioSeed: 402,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT, target: anomalousTarget("pulse-20g", true),
            wind: {kind: "zero"},
            observation: {...WHITE_003_WIDE, sharedSeedKey: PAIR_KEY_20G}},
    },
    {
        jitterKey: "pulse-20g-pair",
        note: "CONTROL member of the recoverable pair: the same manoeuvre "
            + "within a physically achievable envelope, identical geometry and "
            + "an IDENTICAL pointing-error realization. Any difference in "
            + "solver behaviour is the manoeuvre alone.",
        designIntent: "recoverable",
        scenarioSeed: 402,
        spec: {epochISO: EPOCH, durationSeconds: 60, fps: FPS,
            initialHorizontalRangeM: 5000, siteId: OCEAN,
            platform: ORBIT, target: anomalousTarget("pulse-20g", false),
            wind: {kind: "zero"},
            observation: {...WHITE_003_WIDE, sharedSeedKey: PAIR_KEY_20G}},
    },
];

// ---------------------------------------------------------------------------
// Salt-derived parameter jitter
// ---------------------------------------------------------------------------

// Uniform in [lo, hi] from a stream.
const u = (s, lo, hi) => lo + s.uniform() * (hi - lo);

// A deterministic stream from (salt, key). The first 8 hex digits of the HMAC
// give the 32-bit seed.
function saltStream(saltHex, key) {
    return makeStream(parseInt(saltedCommit(key, saltHex).slice(0, 8), 16) >>> 0);
}

/**
 * Draw a concrete scenario from a public template, under the withheld salt.
 *
 * Bands are deliberately MODEST: wide enough that an adversary cannot pin the
 * realization, narrow enough that the scenario keeps the regime it was chosen
 * to exercise (a straight-platform trap stays range-unobservable, a 60 s orbit
 * at ~5 km stays recoverable), so the hand-set designIntent labels remain
 * correct. Duration is rounded to whole seconds so frameCount stays integral.
 *
 * @returns {{spec, scenarioSeed}} the realized scenario definition
 */
export function randomizeSpec(template, saltHex, jitterKey) {
    const s = saltStream(saltHex, `jitter|${jitterKey}`);
    const spec = template.spec;
    const p = spec.platform;

    const out = {
        ...spec,
        durationSeconds: Math.round(spec.durationSeconds * u(s, 0.8, 1.25)),
        initialHorizontalRangeM: Math.round(spec.initialHorizontalRangeM * u(s, 0.7, 1.4)),
        platform: {
            ...p,
            speedMS: Math.round(p.speedMS * u(s, 0.85, 1.2) * 10) / 10,
            altitudeAGL: Math.round(p.altitudeAGL * u(s, 0.8, 1.3)),
        },
    };

    // orbit-point ORBITS THE TARGET'S INITIAL GROUND POINT, so a circle fit to
    // the published SensorPos columns recovers the target's starting position
    // exactly — measured at 3e-9 m. That relationship is invariant under any
    // rigid transform of the scene, so no amount of translating, rotating or
    // parameter-jittering removes it; the construction itself has to change.
    //
    // orbit-direction instead orbits a point along the initial sightline at
    // rangeErrorFactor x the true range, leaving the target at an UNKNOWN
    // distance beyond the fitted centre along a known bearing — which is
    // exactly the intended range ambiguity rather than a giveaway. f is drawn
    // from the withheld salt and bounded away from 1 (f = 1 would put the
    // centre back on the target) and kept above it, so the orbit radius stays
    // comfortably clear of the platform's minimum turn radius.
    if (out.platform.kind === "orbit-point") {
        out.platform = {
            ...out.platform,
            kind: "orbit-direction",
            rangeErrorFactor: Math.round(u(s, 1.2, 1.8) * 1000) / 1000,
        };
    }

    const params = spec.target.parameters ?? {};
    if (params.startAGL != null) {
        out.target = {
            ...spec.target,
            parameters: {...params, startAGL: Math.round(params.startAGL * u(s, 0.7, 1.5))},
        };
    }

    // The seed is salt-derived too, so the noise and gust realizations are not
    // reproducible even for the (deterministic) platform path.
    const seedStream = saltStream(saltHex, `seed|${jitterKey}`);
    const scenarioSeed = 1 + Math.floor(seedStream.uniform() * 0x7ffffffe);

    return {spec: out, scenarioSeed};
}

/**
 * Rigidly transform a whole scenario in the horizontal plane: rotate by psi
 * about the vertical axis, then translate by (dE, dN).
 *
 * WHY THIS IS REQUIRED. The generator places every track target at the ENU
 * ORIGIN — truth[0] is exactly (0, 0, startAGL) for all of them — and
 * scenario.json publishes that origin in frame.originLLA. So an adversary does
 * not need the circle fit at all: solving S + lambda*L for the point with
 * E = N = 0 pins frame-0 truth outright, which bypasses the orbit-direction
 * defence completely.
 *
 * Translation alone is not enough either. The constructions start the sensor
 * DUE SOUTH of the target, so after a pure translation delta the sensor's
 * frame-0 East coordinate still equals the target's. Rotation is what breaks
 * that; translation is what moves the target off the origin. Both are needed,
 * and both are drawn from the withheld salt.
 *
 * Everything that carries a direction or a position rotates: sensor path,
 * truth, both LOS series, the wind series, and the event vectors. Altitudes
 * and the U axis are untouched, so the flat-plane ground reference still holds.
 * The scenario's diagnostics (rcond, LOS sweep, path length) are functions of
 * directions and rigid distances only, so they are invariant and are left as
 * generated.
 *
 * @returns the EFFECTIVE placement actually applied. Callers must record this
 *          rather than what they asked for — the celestial clamp below can
 *          override psi, and provenance has to describe what happened to the
 *          bytes. This is the single source of truth for the clamp; duplicating
 *          it in a caller makes the caller's copy operative and silently turns
 *          any test of this one vacuous.
 */
export function applyRigidTransform(scenario, psi, dE, dN) {
    // CELESTIAL SCENARIOS GET NO TRANSFORM AT ALL.
    //
    // Rotation is obviously wrong: a direction-kind target's bearings are the
    // real sky, computed by generateVenusTruth from the site and epoch that
    // scenario.json publishes, so rotating about the local vertical shifts
    // Venus's azimuth while keeping its elevation and the shipped sightlines
    // contradict any ephemeris — which is exactly what that scenario exists to
    // check.
    //
    // Translation is subtler but also wrong, and it buys NOTHING. Nothing:
    // both extraction attacks return Infinity for a direction target because
    // there is no finite truth position to hide, so the security value of
    // moving the scene is exactly zero. The cost is not zero. The shipped
    // bearings live in the ENU basis at originLLA, but a celestial consumer
    // naturally converts the sensor's ENU position to LLA and computes Venus
    // in the sensor's OWN local basis — and those bases diverge as the scene
    // moves away from the origin. Measured on a 30 km offset: 0.163 deg, or
    // 5.4x the declared 0.03 deg pointing sigma, a systematic error dwarfing
    // the noise the scenario is meant to exercise.
    if (scenario.target.kind === "direction") {
        psi = 0; dE = 0; dN = 0;
    }

    const cos = Math.cos(psi), sin = Math.sin(psi);
    const rotXY = (a, translate) => {
        if (!a) return;
        for (let i = 0; i < a.length; i += 3) {
            const x = a[i], y = a[i + 1];
            a[i] = cos * x - sin * y + (translate ? dE : 0);
            a[i + 1] = sin * x + cos * y + (translate ? dN : 0);
        }
    };
    const rotVec3 = (v) => {
        if (!Array.isArray(v) || v.length < 2) return v;
        const [x, y] = v;
        return [cos * x - sin * y, sin * x + cos * y, ...v.slice(2)];
    };

    rotXY(scenario.platform.positionENU, true);
    rotXY(scenario.target.positionENU, true);
    rotXY(scenario.target.directionENU, false);           // bearings: rotate only
    rotXY(scenario.observation.cleanDirectionENU, false);
    rotXY(scenario.observation.observedDirectionENU, false);
    rotXY(scenario.wind.displacementPerFrameENU, false);
    rotXY(scenario.wind.sampledVelocityENU, false);

    // Every ENU vector an event carries, not just the two the impulse family
    // uses: targets.js also writes v0 / dvScaled for the transition family and
    // copies the whole event into parameters, so those shipped unrotated while
    // the truth track they describe was rotated. Today's curated set only uses
    // impulse-east, so this was latent — add a transition scenario and the two
    // frames silently disagree.
    const EVENT_VECTOR_KEYS = ["directionENU", "deltaVENU", "v0", "dvScaled"];
    for (const ev of scenario.events ?? []) {
        for (const k of EVENT_VECTOR_KEYS) {
            if (Array.isArray(ev[k])) ev[k] = rotVec3(ev[k]);
        }
        if (ev.parameters) {
            const p = {...ev.parameters};
            for (const k of EVENT_VECTOR_KEYS) {
                if (Array.isArray(p[k])) p[k] = rotVec3(p[k]);
            }
            ev.parameters = p;
        }
    }
    return {psiRad: psi, dE, dN};
}

/**
 * Rebuild a scenario from recorded provenance alone.
 *
 * The rigid placement is applied AFTER generateScenario, so spec + seed +
 * generatorVersion no longer reproduce the shipped bytes on their own. Unless
 * the placement is recorded and replayed alongside them the provenance is
 * decorative — it would describe a scene nobody ever shipped. This is the
 * function the reproducibility test replays.
 */
export function rebuildFromProvenance({spec, scenarioSeed, placement, generatorVersion}) {
    // generatorVersion seeds all five RNG streams and the scenarioId
    // (generateScenario.js:54, 69-74). truth.json records it, so replay it —
    // otherwise the first bump (1 -> 1.1 already happened once, deliberately
    // changing realizations) makes old provenance silently rebuild a different
    // scenario, and the reproducibility test passes only against the current
    // version.
    const scenario = generateScenario(spec,
        generatorVersion ? {scenarioSeed, generatorVersion} : {scenarioSeed});
    if (placement && (placement.psiRad || placement.dE || placement.dN)) {
        applyRigidTransform(scenario, placement.psiRad, placement.dE, placement.dN);
    }
    return scenario;
}

/**
 * The ORIGIN attack: assume the target starts at the published ENU origin and
 * solve the frame-0 ray for it. Needs no circle fit and no arc — it works on a
 * straight sensor path too.
 *
 * @returns error in metres
 */
export function originExtractionErrorM(scenario) {
    const P = scenario.target.positionENU;
    if (!P) return Infinity;
    const S = scenario.platform.positionENU;
    const D = scenario.observation.observedDirectionENU;
    const lam = ((0 - S[0]) * D[0] + (0 - S[1]) * D[1]) / (D[0] * D[0] + D[1] * D[1]);
    if (!Number.isFinite(lam)) return Infinity;
    return Math.hypot(
        S[0] + lam * D[0] - P[0],
        S[1] + lam * D[1] - P[1],
        S[2] + lam * D[2] - P[2],
    );
}

/**
 * How well the circle-fit extraction recovers frame-0 truth from a scenario's
 * PUBLIC columns alone. See tests/botbench/interchangeReidentification.test.js
 * for the full attack; this is the same computation used as a build-time gate.
 *
 * Any sensor path with a recoverable centre is a hazard, not just orbit-point:
 * the banked `curve` platform traces an arc of radius v^2/(g tan bank) (~2.8 km
 * at 70 m/s and 10 deg), and when the jittered range lands near that radius the
 * arc centre sits almost exactly on the target — measured at 94 m on a ~5 km
 * range under one salt. Jitter alone therefore does not GUARANTEE the property,
 * it only usually achieves it; the release has to measure and enforce it.
 *
 * @returns error in metres, or Infinity when the fit is degenerate (a straight
 *          sensor path has no centre to find)
 */
export function circleFitExtractionErrorM(scenario) {
    const P = scenario.target.positionENU;
    if (!P) return Infinity;                       // direction truth: no position
    const S = scenario.platform.positionENU;
    const D = scenario.observation.observedDirectionENU;
    const n = scenario.n;

    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxxx = 0, Syyy = 0, Sxyy = 0, Sxxy = 0;
    for (let i = 0; i < n; i++) {
        const x = S[i * 3], y = S[i * 3 + 1];
        Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
        Sxxx += x * x * x; Syyy += y * y * y; Sxyy += x * y * y; Sxxy += x * x * y;
    }
    const a = 2 * (Sxx - Sx * Sx / n), b = 2 * (Sxy - Sx * Sy / n);
    const c = 2 * (Syy - Sy * Sy / n);
    const d = Sxxx + Sxyy - (Sxx + Syy) * Sx / n;
    const e = Syyy + Sxxy - (Sxx + Syy) * Sy / n;
    const det = a * c - b * b;
    // Scale-aware degeneracy test: |det| is in m^4, so compare against the
    // path's own extent rather than an absolute epsilon.
    const extent = Math.max(1, Math.hypot(Sxx / n - (Sx / n) ** 2, Syy / n - (Sy / n) ** 2));
    if (Math.abs(det) < 1e-6 * extent * extent) return Infinity;

    const cE = (d * c - e * b) / det;
    const cN = (a * e - b * d) / det;
    const s0 = [S[0], S[1], S[2]];
    const l0 = [D[0], D[1], D[2]];
    const lam = ((cE - s0[0]) * l0[0] + (cN - s0[1]) * l0[1])
        / (l0[0] * l0[0] + l0[1] * l0[1]);
    if (!Number.isFinite(lam)) return Infinity;
    return Math.hypot(
        s0[0] + lam * l0[0] - P[0],
        s0[1] + lam * l0[1] - P[1],
        s0[2] + lam * l0[2] - P[2],
    );
}

// A sealed scenario must leave the extraction wrong by at least this much.
// Scaled to the true range, because "how much did they learn" is relative:
// 94 m on a 5 km range is a 2% fix on the single hardest unknown.
export function extractionFloorM(spec) {
    return Math.max(500, 0.2 * spec.initialHorizontalRangeM);
}

/**
 * Assign opaque ids under a SECRET permutation.
 *
 * The obvious `bot-${i + 1}` is not opaque at all: SCENARIOS is public source,
 * so bot-0001 is SCENARIOS[0] to anyone holding the repo. Ordering by
 * HMAC(salt, name) makes the assignment unguessable until the salt is released
 * at scoring, and exactly reproducible afterwards.
 *
 * Callers must ALSO emit manifests sorted by the opaque name — publishing rows
 * in SCENARIOS order would leak the same mapping through row order.
 */
export function assignOpaqueIds(descriptiveNames, saltHex) {
    return descriptiveNames
        .map((name, i) => ({i, key: saltedCommit(`order|${name}`, saltHex)}))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .reduce((out, o, rank) => {
            out[o.i] = `bot-${String(rank + 1).padStart(4, "0")}`;
            return out;
        }, new Array(descriptiveNames.length));
}

// The wind an ANALYST would have: the truth field perturbed by a deterministic
// draw at the stated sigma. Handing over the generator's exact wind would
// collapse the balloon fit's hardest unobservable (the coupled range/wind pair)
// to free, which is not what a real sounding gives you.
//
// Seeded from the PUBLISHED TRACK ID, not from (windKind, seed): seeding it
// from the truth spec gave both members of an anomaly/control pair the
// identical estimate, which — since every other manifest field also matched —
// made the pair identifiable from the public files alone.
const WIND_ESTIMATE_SIGMA_MS = 2.0;

export function analystWind(scenario, trackId) {
    const kind = scenario.spec.wind.kind ?? scenario.spec.wind;
    if (!WIND_CONFIGS[kind]) return null;
    // Sample the SCENARIO's own wind at mid-clip rather than the WIND_CONFIGS
    // table. The scene is rigidly rotated by a salt-derived angle, so a table
    // lookup would publish an estimate in the untransformed frame — physically
    // inconsistent with the drift in the shipped truth, and a channel for
    // recovering the rotation by comparing the two.
    const mid = (scenario.n >> 1) * 3;
    const uTrue = scenario.wind.sampledVelocityENU[mid];
    const vTrue = scenario.wind.sampledVelocityENU[mid + 1];
    // "1.0" here is a SEED NAMESPACE, not the spec version — do not swap it for
    // INTERCHANGE_SPEC_VERSION. It feeds deriveSeed, so changing the string
    // changes every analyst wind estimate in every shipped file, and would
    // silently do so on each future spec bump.
    const stream = makeStream(deriveSeed(trackId, 0, "wind-estimate", "1.0"));
    return {
        model: "constant",
        E: uTrue + stream.gaussian() * WIND_ESTIMATE_SIGMA_MS,
        N: vTrue + stream.gaussian() * WIND_ESTIMATE_SIGMA_MS,
        sigmaMS: WIND_ESTIMATE_SIGMA_MS,
        provenance: "modelled",
        note: "Analyst-available estimate, not the generator's exact field. "
            + "Perturbed by a deterministic draw at sigmaMS.",
    };
}

// ---------------------------------------------------------------------------
// Release builder
// ---------------------------------------------------------------------------

/**
 * Build a complete release.
 *
 * @param opts.outDir     root
 * @param opts.sealed     opaque ids + challenge/answers split + salted commits
 * @param opts.saltHex    required when sealed
 * @param opts.randomize  draw parameters from the salt, and replace the
 *                        target-revealing orbit-point path (defaults to sealed)
 * @param opts.harden     withhold noiseless members and truth-sharing
 *                        duplicates (defaults to sealed)
 *
 * randomize and harden exist as separate knobs ONLY so
 * tests/botbench/interchangeReidentification.test.js can build deliberately
 * weak releases and prove its attacks actually work. Turning either off makes
 * a sealed release unsafe to publish, and the manifest says so.
 *
 * @returns {{index, manifest, challengeDir, answersDir, realized}}
 */
export function buildRelease({
    outDir, sealed = false, saltHex = null, randomize, harden,
} = {}) {
    const doRandomize = randomize ?? sealed;
    const doHarden = harden ?? sealed;

    // randomize and harden consume the salt independently of `sealed`, so the
    // guard has to cover all three or an unsealed randomized build dies inside
    // Buffer.from instead of reporting the missing salt.
    if ((sealed || doRandomize || doHarden)
        && !(saltHex && /^[0-9a-fA-F]{32,}$/.test(saltHex))) {
        throw new Error(
            "A sealed release requires a salt of >=32 hex chars, kept secret "
            + "until scoring. Without it the published truth commitments can be "
            + "brute-forced from the public generator: the spec space is small "
            + "and fully enumerable. Generate one with: openssl rand -hex 32");
    }

    // Clear first. writeInterchange overwrites by NAME, so a previous run with
    // different scenario names left orphans inside the shippable challenge/
    // tree that MANIFEST.json no longer lists — and a dev-then-sealed run into
    // one root left descriptive filenames beside the opaque ids meant to hide
    // them.
    fs.rmSync(outDir, {recursive: true, force: true});
    fs.mkdirSync(outDir, {recursive: true});
    const challengeDir = sealed ? path.join(outDir, "challenge") : outDir;
    const answersDir = sealed ? path.join(outDir, "answers") : outDir;

    // Realize every scenario definition first: opaque ids are ranked over the
    // REALIZED descriptive names, so the permutation cannot be precomputed
    // from the public templates alone.
    // Draw parameters, then MEASURE the circle-fit extraction and re-draw any
    // group that lands too close to the target. Jitter makes the hazard
    // unlikely; only this gate makes it impossible. The attempt index is
    // resolved PER jitterKey so both members of a matched pair keep identical
    // geometry — re-drawing one member alone would break the pairing.
    // Salt-derived rigid placement of each scene: rotation about the vertical
    // plus a horizontal offset, so the target no longer sits at the published
    // ENU origin and the sensor no longer starts due south of it. Keyed by
    // jitterKey so both members of a matched pair land on the SAME placement
    // and keep their identical geometry.
    const placementFor = (key, attempt) => {
        if (!(doRandomize && doHarden)) return {psi: 0, dE: 0, dN: 0};
        const s = saltStream(saltHex, `frame|${key}|${attempt}`);
        return {
            psi: u(s, 0, 2 * Math.PI),
            dE: Math.round(u(s, -30000, 30000)),
            dN: Math.round(u(s, -30000, 30000)),
        };
    };

    const buildOne = (e, attempt) => {
        const suffix = attempt === 0 ? e.jitterKey : `${e.jitterKey}#${attempt}`;
        const r = doRandomize
            ? randomizeSpec(e, saltHex, suffix)
            : {spec: e.spec, scenarioSeed: e.scenarioSeed};
        const scenario = generateScenario(r.spec, {scenarioSeed: r.scenarioSeed});
        const drawn = placementFor(e.jitterKey, attempt);
        // Always call through, and record what applyRigidTransform REPORTS it
        // did. It owns the celestial clamp; re-deriving the clamp here would
        // make this copy operative and turn any test of the real one vacuous.
        const placement = applyRigidTransform(scenario, drawn.psi, drawn.dE, drawn.dN);
        return {r, scenario, placement};
    };

    // Gate on BOTH extractions. The circle fit finds an arc centre; the origin
    // attack needs no arc at all and defeats a straight sensor path too, so
    // passing one says nothing about the other.
    const extractionRedraws = [];
    const attemptForKey = new Map();
    if (doRandomize && doHarden) {
        for (const key of new Set(SCENARIOS.map((e) => e.jitterKey))) {
            const group = SCENARIOS.filter((e) => e.jitterKey === key);
            let attempt = 0;
            for (; attempt < 64; attempt++) {
                const ok = group.every((e) => {
                    const {r, scenario} = buildOne(e, attempt);
                    const floor = extractionFloorM(r.spec);
                    return circleFitExtractionErrorM(scenario) >= floor
                        && originExtractionErrorM(scenario) >= floor;
                });
                if (ok) break;
            }
            if (attempt >= 64) {
                throw new Error(`botbench: could not draw a sealed geometry for `
                    + `"${key}" whose sensor path hides the target after 64 attempts`);
            }
            if (attempt > 0) extractionRedraws.push({jitterKey: key, attempts: attempt});
            attemptForKey.set(key, attempt);
        }
    }

    let realized = SCENARIOS.map((e) => {
        const attempt = attemptForKey.get(e.jitterKey) ?? 0;
        const {r, scenario, placement} = buildOne(e, attempt);
        return {
            ...e, ...r, scenario, placement,
            extractionErrorM: circleFitExtractionErrorM(scenario),
            originErrorM: originExtractionErrorM(scenario),
            descriptive: scenarioBaseName(r.spec, r.scenarioSeed),
            // Digest of the TRUTH ITSELF, so truth sharing is detected by
            // content rather than inferred from the spec.
            truthSha256: sha256(Array.from(
                scenario.target.positionENU ?? scenario.target.directionENU).join(",")),
            declaredSigmaDeg: scenario.spec.observation.kind === "clean"
                ? 0 : (scenario.spec.observation.gaussianSigmaDeg
                    ?? scenario.spec.observation.wobble?.amplitude ?? 0),
        };
    });

    // A sealed release must never ship two scenarios with IDENTICAL truth.
    // The clean/noisy balloon pair shares its truth exactly, and the clean
    // member is noiseless — its LOS is the true bearing to the metre-free
    // digit, so solving it hands over the noisy member's answer as well. Keep
    // the hardest (highest declared sigma) member of each truth group.
    const droppedForSharedTruth = [];
    const droppedNoiseless = [];
    if (doHarden) {
        const byTruth = new Map();
        for (const r of realized) {
            const g = byTruth.get(r.truthSha256);
            if (!g) byTruth.set(r.truthSha256, [r]);
            else g.push(r);
        }
        const keep = new Set();
        // A noiseless member is exactly solvable, so hardening drops it on its
        // own merits — not only when it happens to share truth with a noisier
        // twin. The docs and the shipped manifest note both promised this;
        // previously noiselessness was merely reported.
        for (const r of realized) {
            if (r.declaredSigmaDeg === 0) droppedNoiseless.push(r.descriptive);
        }
        realized = realized.filter((r) => r.declaredSigmaDeg !== 0);
        byTruth.clear();
        for (const r of realized) {
            const g = byTruth.get(r.truthSha256);
            if (!g) byTruth.set(r.truthSha256, [r]); else g.push(r);
        }
        for (const group of byTruth.values()) {
            const best = group.reduce((a, b) =>
                (b.declaredSigmaDeg > a.declaredSigmaDeg ? b : a));
            keep.add(best);
            for (const r of group) {
                if (r !== best) droppedForSharedTruth.push(r.descriptive);
            }
        }
        // No silent caps: what was dropped is recorded in the manifest below.
        realized = realized.filter((r) => keep.has(r));
    }

    const opaqueIds = sealed
        ? assignOpaqueIds(realized.map((r) => r.descriptive), saltHex)
        : null;

    const index = [];
    const opaqueMap = [];

    realized.forEach((e, i) => {
        const scenario = e.scenario;
        const publishedName = sealed ? opaqueIds[i] : e.descriptive;
        if (sealed) opaqueMap.push({opaqueName: publishedName, descriptiveName: e.descriptive});

        const written = writeInterchange(scenario, challengeDir, {
            answersDir,
            basename: publishedName,
            trackId: publishedName,
            trackSource: "botbench",
            designIntent: e.designIntent,
            windEstimate: analystWind(scenario, publishedName),
            placement: e.placement,
            // Carried ONLY in the All/ (answer-key) copy of the sidecar, so
            // an analyst scoring against truth sees meaningful names while
            // the challenge side stays opaque (the leak test enforces that).
            descriptiveName: e.descriptive,
            // Only when sealed. The manifest hard-codes saltedCommitments:
            // sealed, so passing the salt on an unsealed build wrote HMAC
            // commitments under a manifest declaring plain sha256 — and the
            // salt is never persisted in that mode, making them unverifiable.
            sealSaltHex: sealed ? saltHex : null,
        });

        index.push({
            name: written.basename,
            trackId: written.trackId,
            // Digest of the sensor trajectory alone. Matched pairs share one
            // by construction, and an adversary can compute this from the
            // shipped columns, so it is used below to REPORT the residual
            // linkage rather than to hide it.
            sensorPathSha256: sha256(Array.from(scenario.platform.positionENU).join(",")),
            truthSha256: e.truthSha256,
            declaredSigmaDeg: e.declaredSigmaDeg,
            note: e.note,
            designIntent: e.designIntent,
            frames: scenario.n,
            fps: scenario.fps,
            durationSeconds: scenario.durationSeconds,
            truthKind: scenario.target.kind === "direction" ? "direction" : "position",
            objectClass: scenario.target.family,
            realizedRmsDeg: scenario.observation.realizedRmsDegAllFrames,
            cvDesignLog10Rcond: scenario.diagnostics.cvDesignLog10RcondObserved,
            digests: written.digests,
            files: written,
        });
    });

    // ROW ORDER IS A CHANNEL. Rows are built in SCENARIOS order; emitting them
    // that way would hand over the id -> scenario mapping even under a secret
    // permutation. Sort by published name.
    index.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // MEASURED residual linkage. A matched pair shares its sensor trajectory
    // by construction — that is what makes it matched — so any adversary can
    // group the shipped files by their SensorPos columns. Publishing the
    // grouping costs nothing (they can compute it) and stops the manifest
    // implying an opacity the release does not have: for an anomaly/control
    // pair, knowing the grouping means knowing one of the two is anomalous.
    const byPath = new Map();
    for (const r of index) {
        if (!byPath.has(r.sensorPathSha256)) byPath.set(r.sensorPathSha256, []);
        byPath.get(r.sensorPathSha256).push(r.name);
    }
    const sharedGeometryGroups = [...byPath.values()].filter((g) => g.length > 1)
        .map((g) => [...g].sort());

    const manifest = {
        specVersion: INTERCHANGE_SPEC_VERSION,
        sealed,
        saltedCommitments: sealed,
        parametersRandomized: doRandomize,
        hardened: doHarden,
        // Scenarios withheld from a sealed release because another member
        // shared their truth exactly. Recorded, never silent — but as a COUNT
        // in the shipped manifest, since the names are descriptive. The names
        // are listed in answers/withheld-scenarios.json.
        withheldForSharedTruth: droppedForSharedTruth.length,
        withheldNoiseless: droppedNoiseless.length,
        // Geometries re-drawn because their sensor path pointed too directly
        // at the target. Reported so a release that needed many re-draws is
        // visible rather than quietly lucky.
        extractionRedraws: extractionRedraws.length,
        // A noiseless member is exactly solvable and must not ship sealed.
        noiselessMembersShipped: index.filter((r) => r.declaredSigmaDeg === 0)
            .map((r) => r.name),
        sharedGeometryGroups,
        sharedGeometryNote: sharedGeometryGroups.length
            ? "These id groups share a sensor trajectory because they are "
              + "matched pairs (identical truth and geometry, differing only "
              + "in noise or in the manoeuvre). The grouping is derivable from "
              + "the shipped SensorPos columns, so it is published rather than "
              + "implied to be hidden. A release that must not reveal which "
              + "files are paired should ship at most one member of each pair."
            : null,
        commitmentNote: sealed
            ? "truth*Commit are HMAC-SHA256 under a salt withheld until "
              + "scoring; the salt is published in answers/seal-salt.txt."
            : "Development set: truth ships alongside, so commitments are "
              + "plain sha256 and are NOT tamper-evident against an "
              + "enumerating adversary.",
        reidentificationNote: sealed
            ? (doRandomize && doHarden
                ? "Scenario parameters and seeds are drawn from the withheld "
                  + "salt, so no shipped file can be reproduced from the public "
                  + "templates; the target-revealing orbit-point path is "
                  + "replaced; noiseless members and truth-sharing duplicates "
                  + "are withheld. Ids are salt-permuted and rows are "
                  + "id-sorted. The KINDS of scenario in the set remain public "
                  + "by design."
                : "WARNING: NOT SAFE TO PUBLISH."
                  + (doRandomize ? "" : " Parameters were NOT randomized, so"
                      + " every shipped file is reproducible from the public"
                      + " templates and ids are exactly re-identifiable, and"
                      + " orbit-point sensor paths reveal the target's initial"
                      + " ground position by circle fit.")
                  + (doHarden ? "" : " Hardening was DISABLED, so a noiseless"
                      + " member may ship — its sightlines are the true"
                      + " bearings — and truth-sharing duplicates are not"
                      + " withheld."))
            : null,
        files: index.map((r) => ({name: r.name, ...r.digests})),
    };
    // Digest of this manifest WITH manifestSha256 removed — it cannot cover
    // itself. State the rule in the file so a verifier does not have to guess
    // it and conclude, on mismatch, that the release was tampered with.
    manifest.manifestSha256Note = "sha256 of this file's JSON with ONLY the "
        + "manifestSha256 key removed, re-serialised by JSON.stringify with "
        + "keys in their original order. This note is itself covered by the "
        + "digest, so it cannot be altered without detection.";
    manifest.manifestSha256 = sha256(JSON.stringify(manifest));

    const fullIndex = {
        specVersion: INTERCHANGE_SPEC_VERSION, sealed,
        scenarios: index.map(({files, ...r}) => r),
    };
    fs.writeFileSync(path.join(challengeDir, "MANIFEST.json"),
        JSON.stringify(manifest, null, 2) + "\n");

    if (sealed) {
        fs.writeFileSync(path.join(answersDir, "index-full.json"),
            JSON.stringify(fullIndex, null, 2) + "\n");
        fs.writeFileSync(path.join(answersDir, "opaque-map.json"),
            JSON.stringify({specVersion: INTERCHANGE_SPEC_VERSION, mapping: opaqueMap}, null, 2) + "\n");
        fs.writeFileSync(path.join(answersDir, "seal-salt.txt"), `${saltHex}\n`);
        fs.writeFileSync(path.join(answersDir, "withheld-scenarios.json"),
            JSON.stringify({specVersion: INTERCHANGE_SPEC_VERSION, reason: "shared truth with a "
                + "shipped member; the easier member is exactly solvable and "
                + "would hand over the harder member's answer",
            withheld: droppedForSharedTruth,
            withheldNoiseless: droppedNoiseless}, null, 2) + "\n");
        // The realized specs are answer-key material: publishing them would
        // undo the randomization.
        fs.writeFileSync(path.join(answersDir, "realized-specs.json"),
            JSON.stringify({specVersion: INTERCHANGE_SPEC_VERSION, scenarios: realized.map((r) => ({
                descriptive: r.descriptive, spec: r.spec, scenarioSeed: r.scenarioSeed,
                // Required to reproduce the shipped bytes: the rigid placement
                // is applied after generation, so spec+seed alone rebuild a
                // scene that was never published.
                placement: r.placement,
            }))}, null, 2) + "\n");
        fs.writeFileSync(path.join(challengeDir, "index.json"), JSON.stringify({
            specVersion: INTERCHANGE_SPEC_VERSION, sealed: true,
            scenarios: index.map((r) => ({
                name: r.name, trackId: r.trackId, frames: r.frames,
                fps: r.fps, durationSeconds: r.durationSeconds,
            })),
        }, null, 2) + "\n");
    } else {
        fs.writeFileSync(path.join(outDir, "index.json"),
            JSON.stringify(fullIndex, null, 2) + "\n");
    }

    return {index, manifest, challengeDir, answersDir, realized, opaqueMap};
}
