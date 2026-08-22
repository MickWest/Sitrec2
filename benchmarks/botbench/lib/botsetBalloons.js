// botsetBalloons.js — buoyant targets swept over platform geometry, target
// behaviour, range and OPERATOR DRIFT.
//
// PUBLISHED AS THREE SETS, ONE PER PLATFORM PATH:
//
//   botset_balloons_straight   the sensor flies past
//   botset_balloons_curve      a gentle constant bank — the "banking away" case
//   botset_balloons_orbit      a full orbit of the target's ground point
//
// The maneuver sets sweep clip DURATION, because a maneuver's detectability is
// a question about time. A balloon's is a question about GEOMETRY — how the
// sensor moves relative to a target that barely moves at all — so the platform
// path is the axis that separates the sets, and duration is pinned at the 20 s
// a real tracking clip tends to be. Publishing the paths as separate sets
// rather than as folders inside one set says that plainly: three geometries are
// three different experiments on the same twenty objects, and the orbit is the
// upper bound on what parallax can buy.
//
// Structure of each set:
//   duration  20 s (pinned)              -> results/botset_balloons_<path>/batch_20s/
//   drift     0 / 5 / 20 pct of FOV      ->   <E>pct/
//   variant   the 20 rows below          ->     Input/ Truth/ All/ meta/
//
// WHY THE ERROR LADDER IS DRIFT, NOT WOBBLE. The maneuver ladder is the
// Aguadilla wobble: a seeded random walk that recentres, i.e. zero-mean.
// Zero-mean error is the kind a fit absorbs best. A slow one-way slide off the
// target is the kind it cannot, because over a short clip it is
// indistinguishable from the target genuinely drifting — which is precisely the
// question a balloon set exists to ask. The two families therefore probe
// different failure modes.
//
// Truth is shared down the drift ladder by construction, exactly as in the
// maneuver sets: the observation section is excluded from the truth key, so the
// three drift levels of one variant are the SAME balloon observed three ways.

import {DEFAULT_SITE} from "./generateScenario";
import {BALLOON_DIAMETER_M} from "./angularSize";
import {BOTSET_DRIFT_LEVELS} from "./botsetErrors";

const MILE_M = 1609.344;

// A tracking aircraft, not the maneuver sets' low orbiter: 21,000 ft and
// 130 m/s, the case these scenarios were built to reproduce.
const PLATFORM_ALT_AGL_M = 6400.8;
const PLATFORM_SPEED_MS = 130;

// One camera for the whole family. 3 degrees is a realistic narrow tracking FOV
// and is wide enough that the 20pct rung (0.6 deg) stays well inside the frame
// — the sets are about what the FIT does with the error, so a target masked out
// by the field of view would be measuring something else.
export const BOTSET_BALLOON_FOV_FULL_DEG = 3.0;

// Duration is pinned: geometry, not time, is this family's axis.
export const BOTSET_BALLOON_DURATION_SECONDS = 20;

export const BOTSET_BALLOON_ERROR_LEVELS = BOTSET_DRIFT_LEVELS;

export const BOTSET_BALLOON_SETS = [
    {key: "straight", dirName: "botset_balloons_straight", spec: {kind: "straight"},
        blurb: "the sensor flies past"},
    {key: "curve", dirName: "botset_balloons_curve", spec: {kind: "curve", bankDeg: 10},
        blurb: "a gentle constant bank"},
    {key: "orbit", dirName: "botset_balloons_orbit", spec: {kind: "orbit-point"},
        blurb: "a full orbit of the target's ground point"},
].map((p) => ({...p, spec: {...p.spec,
    speedMS: PLATFORM_SPEED_MS, altitudeAGL: PLATFORM_ALT_AGL_M}}));

export function botsetBalloonSet(key) {
    const s = BOTSET_BALLOON_SETS.find((x) => x.key === key);
    if (!s) throw new Error(`botsetBalloons: unknown set "${key}"`);
    return s;
}

// The ranges, as the round numbers a reader thinks in. Statute miles.
export const BOTSET_BALLOON_RANGES_MILES = [2, 8, 20, 50];

// The five behaviours, as the vertical rate and the drift speed that define a
// buoyant object. `sinking` rides party-rising with a NEGATIVE ascent rate —
// the same integration, a leaking envelope instead of a climbing one — because
// party-neutral pins its rate at zero and cannot express descent.
//
// TWO ORTHOGONAL AXES THROUGH ONE CENTRE. `level` is the shared reference:
// rising/level/sinking vary the VERTICAL rate at one wind, and slow/level/fast
// vary the DRIFT speed at zero vertical rate. Every row is a distinct scenario
// — an earlier draft gave `slow` and `level` the same wind, which made them the
// same file, and the duplicate-basename check in the batch driver caught it.
export const BOTSET_BALLOON_BEHAVIOURS = [
    {label: "rising",  kind: "party-rising",  wind: "fixed",      parameters: {startAGL: 920, ascentRate: 3}},
    {label: "level",   kind: "party-neutral", wind: "fixed",      parameters: {startAGL: 920}},
    {label: "sinking", kind: "party-rising",  wind: "fixed",      parameters: {startAGL: 1200, ascentRate: -2}},
    {label: "slow",    kind: "party-neutral", wind: "light",      parameters: {startAGL: 920}},
    {label: "fast",    kind: "party-neutral", wind: "hab-steady", parameters: {startAGL: 920}},
];

// behaviour x range: 5 x 4 = 20 rows per set per drift level.
export const BOTSET_BALLOON_VARIANTS = [];
for (const b of BOTSET_BALLOON_BEHAVIOURS) {
    for (const miles of BOTSET_BALLOON_RANGES_MILES) {
        BOTSET_BALLOON_VARIANTS.push({
            behaviour: b.label,
            rangeMiles: miles,
            rangeM: Math.round(miles * MILE_M),
            kind: b.kind,
            wind: b.wind,
            parameters: b.parameters,
        });
    }
}

export function botsetBalloonSpec(v, platform, errorLevel) {
    return {
        epochISO: "2026-06-15T20:00:00Z",   // daylight at the site
        durationSeconds: BOTSET_BALLOON_DURATION_SECONDS, fps: 10,
        initialHorizontalRangeM: v.rangeM,
        siteId: DEFAULT_SITE,
        platform: {...platform.spec},
        // This family keeps its FIXED 3 deg FOV because the drift ladder needs
        // the target to survive the 20pct rung, so framing here is whatever the
        // physics gives: a 0.35 m balloon subtends 0.21% of frame at 2 miles and
        // 0.008% at 50. That is the honest picture — at long range the
        // apparent-size channel supplies only a weak range floor, which is
        // exactly what it should supply. It also makes this the one family
        // where the apparent-size channel varies independently of range.
        target: {kind: v.kind, family: "balloon", diameterM: BALLOON_DIAMETER_M,
            parameters: {...v.parameters}},
        wind: {kind: v.wind},
        observation: errorLevel.observation(BOTSET_BALLOON_FOV_FULL_DEG),
    };
}
