/**
 * The criteria ribbon.
 *
 * The behaviour worth pinning is the class-conditional grading: the SAME
 * acceleration has to read green on a multirotor and red on a balloon, and a
 * forward model must be judged against the class it claims to be rather than
 * against whichever class would let it off.
 */

import {candidateCriteria, judgingClass, criteriaSummary, CRITERION_COLORS}
    from "../src/TraverseCriteria";
import {plausibilityRating} from "../src/TraverseRanking";
import {KNOTS_TO_MS} from "../src/TraverseAnalysis";

function metrics({gMax = 0.1, speedKt = 10, rangeM = 2800} = {}) {
    return {
        gLoad: {min: 0, max: gMax, mean: gMax / 2, rms: gMax / 2, std: 0},
        airSpeed: {min: 0, max: speedKt * KNOTS_TO_MS, mean: speedKt * KNOTS_TO_MS,
            rms: speedKt * KNOTS_TO_MS, std: 0},
        verticalSpeed: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        turnRate: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        altitude: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        range: {min: rangeM, max: rangeM, mean: rangeM, rms: rangeM, std: 0},
    };
}

function hyp(key, opts = {}) {
    return {
        key, name: key, track: new Float64Array([1, 2, 3]),
        metricsFull: opts.metrics || metrics(),
        errDeg: opts.errDeg ?? 0.02,
        params: opts.params || {},
        ...opts.extra,
    };
}

const of = (list, key) => list.find((c) => c.key === key);

describe("judgingClass", () => {
    test("a forward model is held to the class it claims to be", () => {
        // 1.2 g is inside a multirotor's envelope and outside a balloon's, so
        // a "balloon" fit must NOT be re-judged as the drone that admits it.
        const balloon = judgingClass(hyp("lantern", {metrics: metrics({gMax: 1.2, speedKt: 2})}));
        expect(balloon.declared).toBe(true);
        expect(balloon.cls.key).toBe("balloon");
        expect(balloon.gCost).toBeCloseTo(Math.log10(1.2 / 0.5), 6);
        // The multirotor envelope would have admitted it at no cost at all.
        const asDrone = judgingClass(hyp("quadcopter", {metrics: metrics({gMax: 1.2, speedKt: 2})}));
        expect(asDrone.gCost).toBe(0);
    });

    test("a candidate that claims no object type gets the most ordinary class that admits it", () => {
        const los = judgingClass(hyp("constAlt", {metrics: metrics({gMax: 0.48, speedKt: 51})}));
        expect(los.declared).toBe(false);
        expect(los.total).toBe(0);          // some real class contains it
    });

    test("the generic fixed-wing prior picks the best member of the fixed-wing family", () => {
        const jetLike = judgingClass(hyp("aircraft", {metrics: metrics({gMax: 1, speedKt: 400})}));
        expect(jetLike.declared).toBe(true);
        expect(["jet", "airliner"]).toContain(jetLike.cls.key);
        // and it can never escape into the balloon or bird envelopes
        const slow = judgingClass(hyp("aircraft", {metrics: metrics({gMax: 0.01, speedKt: 2})}));
        expect(["smallUAS", "lightAir", "jet", "airliner"]).toContain(slow.cls.key);
        expect(slow.speedCost).toBeGreaterThan(0);
    });

    test("no metrics, no class", () => {
        expect(judgingClass({key: "lantern"})).toBeNull();
    });
});

describe("the ribbon", () => {
    test("the same acceleration reads differently for a balloon and a drone", () => {
        const g = 1.2;
        const balloon = hyp("lantern", {metrics: metrics({gMax: g, speedKt: 2})});
        const drone = hyp("quadcopter", {metrics: metrics({gMax: g, speedKt: 2})});
        const bAccel = of(candidateCriteria(balloon, plausibilityRating(balloon)), "accel");
        const dAccel = of(candidateCriteria(drone, plausibilityRating(drone)), "accel");
        expect(bAccel.status).toBe("fail");      // 1.2 g against a balloon's 0.5
        expect(dAccel.status).toBe("pass");      // 1.2 g against a multirotor's 2.0
        expect(bAccel.why).toContain("balloon");
        expect(dAccel.why).toContain("multirotor");
    });

    test("the absolute screen wins when it is harsher than the class envelope", () => {
        // 5 g is inside a jet's 9 g envelope, but the kinematic screen already
        // grades above 4 g as not ordinary; a green square there would put two
        // surfaces of the same analysis in contradiction.
        const jet = hyp("aircraft", {metrics: metrics({gMax: 5, speedKt: 400})});
        const accel = of(candidateCriteria(jet, plausibilityRating(jet)), "accel");
        expect(accel.status).toBe("fail");
        expect(accel.why).toContain("absolute screen");
    });

    test("mirroring is reported from the rating, with its share", () => {
        const h = hyp("constAlt", {extra: {platformMirror: {
            share: 0.959, beta: 0.229, snr: 94, rmsPlatform: 1182, rmsTrack: 276,
            mirroredM: 270, independentM: 56, referenceRangeM: 2911,
        }}});
        const c = of(candidateCriteria(h, plausibilityRating(h)), "mirror");
        expect(c.status).toBe("fail");
        expect(c.value).toBe("96%");
        expect(c.why).toContain("0.23× copy");
    });

    test("a platform that never manoeuvres gives grey, not green", () => {
        const h = hyp("constAlt");                 // no platformMirror attached
        const c = of(candidateCriteria(h, plausibilityRating(h)), "mirror");
        expect(c.status).toBe("na");
        expect(c.why).toContain("no parallax");
    });

    test("grey always says what is missing, never what was found", () => {
        const h = hyp("constAlt");
        const list = candidateCriteria(h, plausibilityRating(h), {useTruth: true});
        for (const c of list.filter((x) => x.status === "na")) {
            expect(c.value).toBe("—");
            expect(c.why.length).toBeGreaterThan(20);
        }
        // The two that are grey on a bare run for lack of inputs.
        expect(of(list, "size").status).toBe("na");
        expect(of(list, "truth").status).toBe("na");
    });

    test("a rejected candidate fails loudly instead of reading mostly grey", () => {
        // Measured on the Aguadilla file: Ground Object is badged "Underground",
        // takes an early return in plausibilityRating, and so carries no fit or
        // kinematic rank. Its ribbon read as three greens and five greys —
        // BETTER, at a glance, than a tile whose only fault was mirroring the
        // platform.
        const h = hyp("ground", {extra: {underground: true}});
        const r = plausibilityRating(h);
        expect(r.rank).toBeLessThan(0);
        const list = candidateCriteria(h, r);
        const valid = of(list, "valid");
        expect(list[0]).toBe(valid);                 // first square, not buried
        expect(valid.status).toBe("fail");
        expect(valid.why).toContain("never ran");
        // and the fit square must not claim it is a catalogue identification
        expect(of(list, "fit").why).toContain("rejected before its residual was scored");
        expect(list.filter((c) => c.status === "pass").length)
            .toBeLessThan(list.filter((c) => c.status === "pass" || c.status === "na").length);
    });

    test("an admissible candidate passes the validity square", () => {
        const h = hyp("lantern");
        const valid = of(candidateCriteria(h, plausibilityRating(h)), "valid");
        expect(valid.status).toBe("pass");
        expect(valid.value).toBe("ok");
    });

    test("an unfinished search is never clean", () => {
        const h = hyp("lantern", {extra: {
            boundPinned: ["shearPerM (max)"], optimizerWarnings: ["budget reached"],
        }});
        const c = of(candidateCriteria(h, plausibilityRating(h)), "convergence");
        expect(c.status).toBe("fail");
        expect(c.why).toContain("optimizer incomplete");
    });

    test("wind evidence is graded only on the free fit", () => {
        const free = hyp("lantern", {extra: {
            windEvidence: {role: "free", rating: "supports", why: "close vector match"}}});
        const pinned = hyp("lantern", {extra: {
            windEvidence: {role: "pinned", rating: "supports", why: "given the answer"}}});
        expect(of(candidateCriteria(free, plausibilityRating(free)), "wind").status).toBe("pass");
        const p = of(candidateCriteria(pinned, plausibilityRating(pinned)), "wind");
        expect(p.status).toBe("na");
        expect(p.why).toContain("given the answer");
    });

    test("truth separation is graded relative to the truth's own range", () => {
        const near = hyp("lantern", {extra: {truthComparison: {
            comparable: true, score: 20, sep3D: {mean: 20, max: 30}, meanTruthRange: 2800}}});
        const far = hyp("lantern", {extra: {truthComparison: {
            comparable: true, score: 900, sep3D: {mean: 900, max: 1200}, meanTruthRange: 2800}}});
        expect(of(candidateCriteria(near, plausibilityRating(near)), "truth").status).toBe("pass");
        expect(of(candidateCriteria(far, plausibilityRating(far)), "truth").status).toBe("fail");
        // and it is grey when the reader has turned the truth track off
        expect(of(candidateCriteria(near, plausibilityRating(near), {useTruth: false}), "truth")
            .status).toBe("na");
    });

    test("every square carries a unique letter", () => {
        // A repeated letter would make two squares indistinguishable, which is
        // worse than leaving them blank.
        const h = hyp("lantern");
        const letters = candidateCriteria(h, plausibilityRating(h)).map((c) => c.letter);
        expect(letters).toEqual(["P", "L", "S", "A", "Z", "M", "C", "W", "T"]);
        expect(new Set(letters).size).toBe(letters.length);
    });

    test("every criterion has a colour and a non-empty explanation", () => {
        const h = hyp("lantern");
        for (const c of candidateCriteria(h, plausibilityRating(h))) {
            expect(CRITERION_COLORS[c.status]).toMatch(/^#[0-9a-f]{6}$/i);
            expect(typeof c.why).toBe("string");
            expect(c.why.length).toBeGreaterThan(10);
            expect(c.label.length).toBeGreaterThan(0);
            expect(c.letter).toMatch(/^[A-Z]$/);
        }
    });

    test("the summary counts every square", () => {
        const h = hyp("lantern");
        const list = candidateCriteria(h, plausibilityRating(h));
        const text = criteriaSummary(list);
        const counted = ["failing", "marginal", "passing", "not evaluated"]
            .map((w) => { const m = text.match(new RegExp(`(\\d+) ${w}`)); return m ? +m[1] : 0; })
            .reduce((a, b) => a + b, 0);
        expect(counted).toBe(list.length);
    });
});
