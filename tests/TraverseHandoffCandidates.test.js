/**
 * Which candidates a ONE-LINK handoff sends (handoffCandidateCSVs).
 *
 * The bench's row link has no place to offer a choice, so it applies a rule:
 * the consistent band, or — when nothing passed the consistency screen — the
 * weak band in its place. The live gallery keeps the choice as two buttons and
 * calls consistentTrackCSVs directly, so the rule tested here is deliberately
 * NOT in the shared selector.
 */
jest.mock("../src/showError", () => ({showError: jest.fn()}));

import {consistentTrackCSVs, handoffCandidateCSVs, HANDOFF_TRACK_SLUGS}
    from "../src/TraverseHandoff";
import {SWEEP_VARIANTS} from "../src/TraverseBattery";
import {KNOTS_TO_MS} from "../src/TraverseAnalysis";

const N = 4;
const START_MS = Date.UTC(2024, 4, 1, 18, 0, 0);

// A flat local ENU -> LLA, near enough for a selection test: the numbers only
// have to be finite and distinct, because nothing here checks geography.
const toLLA = (x, y, z) => [35 + y * 1e-5, -119 + x * 1e-5, z];

function metrics({gRms = 0.1, gMax = 0.2, speedKt = 120} = {}) {
    return {
        gLoad: {min: 0, max: gMax, mean: gRms, rms: gRms, std: 0},
        airSpeed: {min: speedKt * KNOTS_TO_MS, max: speedKt * KNOTS_TO_MS,
            mean: speedKt * KNOTS_TO_MS, rms: speedKt * KNOTS_TO_MS, std: 0},
        verticalSpeed: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        turnRate: {min: 0, max: 0, mean: 0, rms: 0.2, std: 0.2},
        altitude: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        range: {min: 1000, max: 1000, mean: 1000, rms: 1000, std: 0},
    };
}

// A track of N points, offset so two hypotheses are distinguishable.
function track(offset) {
    const t = new Float64Array(N * 3);
    for (let f = 0; f < N; f++) {
        t[f * 3] = 1000 + offset + f;
        t[f * 3 + 1] = 2000 + offset;
        t[f * 3 + 2] = 500 + offset;
    }
    return t;
}

// boundaryLimited is read from h.params (TraverseRanking.plausibilityRating),
// not from a top-level flag — a fit reports where it stopped in its own
// parameter record.
function hypothesis(key, {offset = 0, boundaryLimited = false, optimizerWarnings} = {}) {
    return {
        key, name: key, track: track(offset),
        metricsFull: metrics(), errDeg: 0.05,
        params: boundaryLimited ? {boundaryLimited: true} : {},
        optimizerWarnings,
    };
}

const results = (hypotheses) => ({
    dataset: {n: N, fps: 10, frame0: 0, frame1: N - 1},
    hypotheses,
});

const opts = {toLLA, altitudeIsHAE: false, startMs: START_MS};

const names = (rows) => rows.map((r) => r.name).sort();

// The premise the whole rule rests on: a bound-pinned solve is a candidate the
// analysis FOUND and then declined to endorse. It is absent from the consistent
// band and present in the weak one.
test("a bound-pinned candidate is weak, not consistent", () => {
    const r = results([hypothesis("lantern", {boundaryLimited: true})]);
    expect(consistentTrackCSVs(r, opts)).toEqual([]);
    const weak = consistentTrackCSVs(r, {...opts, includeWeak: true});
    expect(names(weak)).toEqual(["w_sky_lantern_balloon"]);
    expect(weak[0].weak).toBe(true);
    expect(weak[0].weakReason).toMatch(/bound/i);
});

test("with nothing consistent, the one-link handoff sends the weak band", () => {
    const r = results([
        hypothesis("lantern", {boundaryLimited: true}),
        hypothesis("drone", {offset: 50, optimizerWarnings: ["did not converge"]}),
    ]);
    expect(consistentTrackCSVs(r, opts)).toEqual([]);       // the old payload
    const sent = handoffCandidateCSVs(r, opts);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.weak)).toBe(true);
    expect(sent.every((c) => c.name.startsWith("w_"))).toBe(true);
});

// FALLBACK, NOT ADDITION. A weak solve standing in the scene beside an endorsed
// one reads as its peer, which is the distinction the c_ prefix exists to draw.
test("when anything is consistent, the weak band does NOT travel with it", () => {
    const r = results([
        hypothesis("plane"),
        hypothesis("lantern", {offset: 50, boundaryLimited: true}),
    ]);
    const sent = handoffCandidateCSVs(r, opts);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((c) => c.weak)).toBe(false);
    expect(sent.every((c) => c.name.startsWith("c_"))).toBe(true);
});

// The ordinary case must be untouched, counts included: asking for both bands
// and filtering afterwards would leave a consistent entry silently counting the
// weak members of its family among the peers it stands for.
test("the consistent case is bit-for-bit what consistentTrackCSVs returns", () => {
    const r = results([
        hypothesis("plane"),
        hypothesis("lantern", {offset: 50, boundaryLimited: true}),
    ]);
    expect(handoffCandidateCSVs(r, opts))
        .toEqual(consistentTrackCSVs(r, opts));
});

test("no hypotheses at all still sends nothing, rather than throwing", () => {
    expect(handoffCandidateCSVs(results([]), opts)).toEqual([]);
    expect(handoffCandidateCSVs(null, opts)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Track NAMES: readable labels, kept separate from the hypothesis KEYS.
// ---------------------------------------------------------------------------

// The longest entry, "minimum_acceleration", measured 125 px of a 132 px
// dropdown budget in the browser (see HANDOFF_TRACK_SLUGS for how that budget
// is derived). Jest has no text metrics, so the character count of that same
// measured string stands in for it: nothing may be longer than the one entry
// whose width was actually checked.
const MAX_SLUG_CHARS = "minimum_acceleration".length;

test("a candidate is named from its readable slug, not its internal key", () => {
    const r = results([hypothesis("plausible", {boundaryLimited: true})]);
    const sent = handoffCandidateCSVs(r, opts);
    expect(sent.map((c) => c.name)).toEqual(["w_minimum_acceleration"]);
    // The CSV's CALLSIGN column carries the same label, so the track imports
    // under the readable name rather than under the key.
    expect(sent[0].text).toContain("w_minimum_acceleration");
    expect(sent[0].text).not.toContain("plausible");
});

// The slug is a LABEL; the key is the family. Two members of one family still
// collapse to a single track — naming from the per-member display name instead
// would have split the polynomial sweep into five near-identical tracks.
test("the slug does not affect which candidates collapse into one family", () => {
    const r = results([
        hypothesis("gfPolyALS", {boundaryLimited: true}),
        hypothesis("gfPolyALS", {offset: 50, boundaryLimited: true}),
    ]);
    const sent = handoffCandidateCSVs(r, opts);
    expect(sent.map((c) => c.name)).toEqual(["w_polynomial_curve_fit"]);
    expect(sent[0].alsoRan).toBe(1);
});

test("an unlisted key falls back to the sanitized key rather than breaking", () => {
    const r = results([hypothesis("someNewFit", {boundaryLimited: true})]);
    expect(handoffCandidateCSVs(r, opts).map((c) => c.name))
        .toEqual(["w_somenewfit"]);
});

test("every slug is unique, safe in a node id, and inside the measured width", () => {
    const slugs = Object.values(HANDOFF_TRACK_SLUGS);
    // Duplicates would give two FAMILIES the same track name, which collides
    // on the "Track_<name>" node id in the receiving window.
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
        expect(slug).toMatch(/^[a-z0-9_]+$/);       // node ids and CSV callsigns
        expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_CHARS);
    }
});

// The curve-fitting sweep is the one family list that can be enumerated from
// its source, so it is the one that can be checked for drift: adding a variant
// without a slug would silently reintroduce a name like "w_gfmc3".
test("every curve-fit sweep variant has a readable slug", () => {
    for (const variant of SWEEP_VARIANTS) {
        expect(HANDOFF_TRACK_SLUGS[variant.key]).toBeDefined();
    }
});
