// botsetPlatform.js — an endurance surveillance platform staring down a fixed
// sightline, with the object at four DEPTHS along that sightline.
//
// WHY THIS FAMILY EXISTS. Every other botset varies the target's range by
// moving the target. That moves the bearing and the depression angle with it,
// so "how far away is it" and "where in the frame is it" change together and a
// fit can lean on either. Released footage of this kind does not work that
// way: the sensor is high, it is looking down at the ground past the object,
// and the only question is how far along that one sightline the object sits.
//
// So this family holds the SIGHTLINE fixed and varies only the depth:
//
//   platform      6096 m above terrain (20000 ft), 87 m/s
//   ground range  G in {5, 10, 20, 40} km  -> the sightline's ground intercept
//   depth         f in {0.25, 0.50, 0.75, 0.98} of the slant range to that
//                 intercept  -> where the object actually is
//
// All four f values at one G share the SAME initial bearing and the SAME
// depression angle. They differ only in depth. That is the range ambiguity in
// its pure form, and no existing set isolates it.
//
// THE PARALLAX IS THE POINT. The existing 855-scenario matrix has a median
// parallax aperture of 12 deg, and 42% of it sits at 5 deg or less. Every cell
// here is 11.3 deg or better on the orbit (11.2 deg on the straight pass), and
// the near cells reach 100 deg. Released footage of an orbiting platform has
// that much parallax; the benchmark did not.
//
// TWO SETS, ONE PER SENSOR PATH:
//
//   botset_platform_orbit      orbits the ground intercept at radius G
//   botset_platform_straight   flies straight past, perpendicular to the sightline
//
// The straight pass is NOT merely a weaker-parallax control. For a target in
// constant-velocity motion, an observer also in constant-velocity motion cannot
// determine range at all — the classical bearings-only observability result.
// The orbit accelerates continuously, so it is observable; the straight pass
// does not accelerate, so for the constant-velocity member of the object set it
// is degenerate BY CONSTRUCTION however wide its baseline looks. Targets that
// accelerate on their own (the rising balloon, the turning aircraft, the
// impulse pair) restore observability on both paths. Reading the two sets side
// by side separates "the geometry was too weak" from "the geometry was
// structurally incapable", which an aperture number alone cannot do.
//
// Structure of each set:
//   duration  90 s (pinned)               -> results/botset_platform_<path>/batch_90s/
//   error     0.0 to 2.0 deg, nine rungs   ->   <E>deg/
//   cell x object   16 x 8 = 128 rows      ->     Input/ Truth/ All/ meta/
//
// Truth is shared down the error ladder by construction, exactly as in the
// other botsets: spec.observation is excluded from the truth key, so the nine
// rungs of one row are the SAME flight observed nine ways.

import {DEFAULT_SITE} from "./generateScenario";
import {BOTSET_ERROR_LEVELS} from "./botsetErrors";

const FT_M = 0.3048;

// 20000 ft above terrain. The site is central-valley, whose ground is 27.6 m
// MSL, so this is 6124 m MSL — the distinction is below the noise of anything
// the family measures, which is why a flat inland site was chosen for it.
export const PLATFORM_ALT_AGL_M = 20000 * FT_M;    // 6096 m
export const PLATFORM_SPEED_MS = 87;               // ~170 kt, endurance cruise

export const PLATFORM_DURATION_SECONDS = 90;
export const PLATFORM_FPS = 10;

// ONE field of view for the whole family, and it must NOT be sized per
// scenario. angularSize.js frames the maneuver sets from the target's true
// range, which is right there but wrong here: the field of view is published in
// every scenario sidecar, so a field sized from the object's range would hand
// the consumer the depth f directly and dissolve the one thing this family
// asks. A fixed field leaks nothing. 1.5 deg is a real narrow tracking field
// and it keeps a 3 m object resolved out to 73 km, past the farthest cell.
export const PLATFORM_FOV_FULL_DEG = 1.5;

export const PLATFORM_ERROR_LEVELS = BOTSET_ERROR_LEVELS;

// Deliberately not 801 (maneuvers) or 802 (balloons): a shared seed across
// families would correlate their wind and target draws, and a cross-family
// comparison would quietly be comparing one draw with itself.
export const PLATFORM_SEED = 803;

export const PLATFORM_SETS = [
    {key: "orbit", dirName: "botset_platform_orbit", tag: "orbitground",
        blurb: "orbits the sightline's ground intercept at radius G"},
    {key: "straight", dirName: "botset_platform_straight", tag: "straight",
        blurb: "flies straight past, perpendicular to the sightline"},
];

export function platformSet(key) {
    const s = PLATFORM_SETS.find((x) => x.key === key);
    if (!s) throw new Error(`botsetPlatform: unknown set "${key}"`);
    return s;
}

export const PLATFORM_GROUND_RANGES_KM = [5, 10, 20, 40];
export const PLATFORM_DEPTH_FRACTIONS = [0.25, 0.50, 0.75, 0.98];

/**
 * The 16 geometry cells. Everything here is derived from (G, f) and the
 * platform height, so the grid cannot drift out of step with the spec builder.
 *
 *   slantToGroundM   the sightline from sensor to ground intercept
 *   objectSlantM     f x that — where the object is
 *   objectAltAGL     H(1-f) — depends on f ALONE, never on G
 *   objectHorizM     f x G — what the generator takes as the horizontal range
 */
export const PLATFORM_CELLS = [];
for (const gKm of PLATFORM_GROUND_RANGES_KM) {
    const G = gKm * 1000;
    const H = PLATFORM_ALT_AGL_M;
    const slantToGroundM = Math.hypot(G, H);
    for (const f of PLATFORM_DEPTH_FRACTIONS) {
        PLATFORM_CELLS.push({
            gKm, groundRangeM: G, f,
            depthPct: Math.round(f * 100),
            slantToGroundM,
            objectSlantM: f * slantToGroundM,
            objectAltAGL: H * (1 - f),
            objectHorizM: f * G,
            depressionDeg: Math.atan2(H, G) * 180 / Math.PI,
        });
    }
}

/**
 * The eight objects. A small mixed set, chosen so that every distinct answer
 * the analysis can give is represented at every depth — and so that the
 * straight pass has both a target it cannot resolve and targets it can.
 *
 * `diameterM` is answer-key material, published only as the angular-diameter
 * BOUND (angularSize.js). The values are the honest size of each thing, not a
 * size picked to fill the frame: a 0.3 m bird at 39 km really is below one
 * pixel, and the manifest records where that happens rather than hiding it.
 *
 * `altKey` names the parameter the truth generator reads. Both keys are set on
 * every object regardless, because generateScenario takes its WIND reference
 * altitude from startAGL — an object placed by altitudeAGL alone would be
 * advected by the wind at 500 m rather than at its own height.
 */
export const PLATFORM_OBJECTS = [
    {tag: "party-neutral", kind: "party-neutral", family: "balloon",
        wind: "fixed", diameterM: 1.0, altKey: "startAGL",
        note: "level buoyant drift — the everyday mundane answer"},
    {tag: "party-rising", kind: "party-rising", family: "balloon",
        wind: "fixed", diameterM: 1.0, altKey: "startAGL",
        parameters: {ascentRate: 3},
        note: "ascending: its own vertical motion breaks the sightline degeneracy"},
    {tag: "static-point", kind: "static-point", family: "maneuver",
        wind: "zero", diameterM: 2.0, altKey: "startAGL",
        note: "hovers — the pure range-collapse case, nothing to triangulate on"},
    {tag: "aircraft-cruise", kind: "aircraft-cruise", family: "aircraft",
        wind: "fixed", diameterM: 10.0, altKey: "altitudeAGL",
        note: "exact constant velocity — UNOBSERVABLE on the straight pass"},
    {tag: "aircraft-turn", kind: "aircraft-turn", family: "aircraft",
        wind: "fixed", diameterM: 10.0, altKey: "altitudeAGL",
        note: "banked turn: accelerates, so observable on both paths"},
    {tag: "bird", kind: "bird", family: "bird",
        wind: "fixed", diameterM: 0.3, altKey: "startAGL",
        note: "small and erratic; below one pixel in the far cells by design"},
    // MATCHED PAIR. `pairKey` links the two members and is what makes the
    // comparison controlled — see platformSpec for how it reaches the generator.
    {tag: "anom-impulse-east", kind: "anomalous", family: "anomalous",
        wind: "zero", diameterM: 5.0, altKey: "altitudeAGL",
        pairKey: "impulse-east",
        parameters: {tupleId: "impulse-east", anomalous: true},
        note: "anomalous member of a matched pair"},
    {tag: "ctrl-impulse-east", kind: "anomalous", family: "anomalous",
        wind: "zero", diameterM: 5.0, altKey: "altitudeAGL",
        pairKey: "impulse-east",
        parameters: {tupleId: "impulse-east", anomalous: false},
        note: "its mundane twin on the identical geometry"},
];

/** The 128 rows of one rung folder: every object at every geometry cell. */
export const PLATFORM_VARIANTS = [];
for (const cell of PLATFORM_CELLS) {
    for (const obj of PLATFORM_OBJECTS) PLATFORM_VARIANTS.push({cell, obj});
}

/** The platform section for one set at one cell. */
export function platformPathFor(set, cell) {
    const base = {speedMS: PLATFORM_SPEED_MS, altitudeAGL: PLATFORM_ALT_AGL_M};
    if (set.key === "orbit") {
        return {kind: "orbit-ground", groundRangeM: cell.groundRangeM, ...base};
    }
    return {kind: "straight", ...base};
}

/**
 * The pair identity for a matched anomaly/control row, or null for an
 * unpaired object.
 *
 * TWO KEYS, ON PURPOSE, AND THEY ARE NOT THE SAME STRING.
 *
 * `pairId` names the pair and must be IDENTICAL for both members. It lives
 * outside spec.observation, so it is part of the truth key — which means it
 * must NOT carry the error rung, or the nine rungs of one row would hash
 * differently and this family's "same flight observed nine ways" contract would
 * be broken for these two objects alone.
 *
 * `sharedSeedKey` lives INSIDE spec.observation, which generateScenario
 * excludes from the truth key, so it is free to carry the rung — and it has to.
 * generateScenario draws the observation stream from `sharedSeedKey ??
 * scenarioId`, and scenarioId differs between the two members (their truth
 * differs, which is the point). Without a shared key each member would get its
 * own wobble realization, and a difference between them would confound "the
 * impulse showed" with "the noise draw differed". Every other matched pair in
 * the bench does this: blocks.js ANOMALY-CONTROL, the interchange pairs, and
 * realScenarioSet's gofast-pair / hover-pair.
 */
function platformPairIds(obj, set, cell, errorLevel) {
    if (!obj.pairKey) return {pairId: null, sharedSeedKey: null};
    const pairId = `platform-${obj.pairKey}-${set.key}-g${cell.gKm}km-f${cell.depthPct}`;
    return {pairId, sharedSeedKey: `${pairId}-${errorLevel.label}`};
}

export function platformSpec(variant, set, errorLevel) {
    const {cell, obj} = variant;
    const alt = Math.round(cell.objectAltAGL);
    const {pairId, sharedSeedKey} = platformPairIds(obj, set, cell, errorLevel);
    const observation = errorLevel.observation(PLATFORM_FOV_FULL_DEG);
    return {
        // Added only for a paired row: an unconditional `pairId: null` would
        // put a new key in every unpaired object's canonical hash and move
        // truth that has no reason to move.
        ...(pairId ? {pairId} : {}),
        epochISO: "2026-06-15T20:00:00Z",   // daylight at the site
        durationSeconds: PLATFORM_DURATION_SECONDS,
        fps: PLATFORM_FPS,
        // The generator places the sensor at [0, -R, altitudeAGL] and the
        // object's ground point at the origin, so R is the object's HORIZONTAL
        // range — f x G, never G itself. The ground intercept is a further
        // G(1-f) north, which is what the orbit centres on.
        initialHorizontalRangeM: Math.round(cell.objectHorizM),
        siteId: DEFAULT_SITE,
        platform: platformPathFor(set, cell),
        target: {
            kind: obj.kind, family: obj.family, diameterM: obj.diameterM,
            // BOTH altitude keys, always: the track functions read one and the
            // wind reference reads startAGL. See PLATFORM_OBJECTS.
            parameters: {startAGL: alt, altitudeAGL: alt, ...(obj.parameters ?? {})},
        },
        wind: {kind: obj.wind},
        observation: sharedSeedKey ? {...observation, sharedSeedKey} : observation,
    };
}
