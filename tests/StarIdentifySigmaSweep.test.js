// The detection-threshold (sigma) sweep suite - the regression record for the
// image-neighbour-depth failure, measured live on the "Why not this_" clip
// (?custom=99999999/Why not this_/20260805_171538.js, 42 frames, 1280x720).
//
// The clip was analysed end-to-end at every detect threshold sigma 1..10. Seven of the ten
// runs solved, all agreeing on RA 253.11 / Dec +10.95 / fov 28.07 deg to a hundredth of a
// degree - but sigma 5 (the DEFAULT) and 6 failed, and sigma 1 fails for the honest reason
// (the threshold sinks into airglow and the detector destroys the real stars: merged cloud
// blobs, centroids 12-37 px off).
//
// The sigma-5/6 failure was not the gates: no true-field hypothesis was ever GENERATED.
// Detection at sigma >= 5 loses HIP 83613 (mag 4.89), the one star all twelve of the field's
// tier-0 index quads pass through - and at imageNeighbors 7, image neighbour lists polluted
// by stars the tier's index cannot contain (real stars past the magnitude cap) reach no
// alternative quad. Depth 9 restores generation with margin (8 fixed only one of the two
// failing inputs; 10 behaves like 9). The fix also closed three latent inputs - single-star
// variations of the sigma-6 set - that previously ACCEPTED a confidently wrong wide-field
// solve (RA 145.4 / Dec +8.4).
//
// The round-0 rematch-collapse rule is deliberately untouched: at sigma 5, with the rule
// disabled, the solver ACCEPTS a wrong Cassiopeia-region field (RA 26.3 / Dec +62.8) - the
// rule's third confirmed impostor kill across three different clips.

import fs from "fs";
import path from "path";
import {
    STAR_IDENTIFY_DEFAULTS, buildQuadIndex, certifySolve, parseStarCatalog, solveField,
} from "../src/starTrack/StarIdentify";

const fixture = (name) => JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "fixtures", name), "utf8"));
const sweep = fixture("sigmaSweepWhyNotThis.json");
const occluded = fixture("tweaksOccludedFlares.json");
const catalog = parseStarCatalog((() => {
    const b = fs.readFileSync(path.resolve(__dirname, "..", "data/nightsky/sitrec_bsc_lite.bin"));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
})());

const TRUE_RA = 253.11, TRUE_DEC = 10.95;

// One index per tier, shared across tests. Built AFTER the defaults change, so these carry
// the depth-9 image side implicitly (the index side is unchanged - depth applies per solve).
const indexes = STAR_IDENTIFY_DEFAULTS.tiers.map((t) => buildQuadIndex(catalog, t));

const bySigma = new Map(sweep.map((r) => [r.sigma, r]));

/** identifyStars' single-solve bounds rule. */
function uiOpts(stars, videoW = 1280, videoH = 720) {
    let bx0 = 0, by0 = 0, bx1 = videoW, by1 = videoH;
    for (const s of stars) {
        bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
        by0 = Math.min(by0, s.y); by1 = Math.max(by1, s.y);
    }
    return {
        center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
        width: Math.max(bx1 - bx0, by1 - by0),
        bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
    };
}

async function solveTiers(stars, extra = {}) {
    let last = null;
    for (const index of indexes) {
        last = await solveField(stars, catalog, [index], {...uiOpts(stars), ...extra});
        if (last.ok) return last;
    }
    return last;
}

describe("the sigma sweep on the Why-not-this clip", () => {
    test("the fixture is the measured sweep we think it is", () => {
        expect(sweep).toHaveLength(10);
        expect([...bySigma.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        // The two knife-edge inputs and the wreckage input, as captured live.
        expect(bySigma.get(5).input).toHaveLength(18);
        expect(bySigma.get(6).input).toHaveLength(16);
        expect(bySigma.get(1).input).toHaveLength(19);
        expect(bySigma.get(1).nClassified).toBe(604);
    });

    test("CONTROL: the old configuration (depth 7, three tiers) generates no true hypothesis", async () => {
        // The machine-checked record of the defect this suite exists for. The old shipped
        // configuration - neighbour depth 7 AND no density-matched mag-5.5 tier - made this
        // exact input unsolvable, and the status blamed the last impostor's execution
        // ("round-0 rematch collapsed"). Either half of the fix cures it alone, so the
        // control must exclude both.
        let solved = null;
        for (const index of [indexes[0], indexes[2], indexes[3]]) {
            solved = await solveField(bySigma.get(5).input, catalog, [index],
                {...uiOpts(bySigma.get(5).input), imageNeighbors: 7});
            if (solved.ok) break;
        }
        expect(solved.ok).toBe(false);
    });

    for (const sigma of [5, 6]) {
        test(`sigma ${sigma} now solves the true field on the narrow tier`, async () => {
            const stars = bySigma.get(sigma).input;
            const solved = await solveField(stars, catalog, [indexes[0]], uiOpts(stars));
            expect(solved.ok).toBe(true);
            expect(Math.abs(solved.centerRaDeg - TRUE_RA)).toBeLessThan(1);
            expect(Math.abs(solved.centerDecDeg - TRUE_DEC)).toBeLessThan(1);
            // Measured at the time of writing: 17/18 and 15/16 matched, rms < 2 px.
            expect(solved.matches.length).toBeGreaterThanOrEqual(stars.length - 2);
            expect(solved.rmsPx).toBeLessThan(3);
        });
    }

    test("every previously-passing sigma still solves, same field", async () => {
        for (const sigma of [2, 3, 4, 7, 8, 9, 10]) {
            const r = bySigma.get(sigma);
            const solved = await solveTiers(r.input);
            expect(solved.ok).toBe(true);
            expect(Math.abs(solved.centerRaDeg - TRUE_RA)).toBeLessThan(1);
            expect(Math.abs(solved.centerDecDeg - TRUE_DEC)).toBeLessThan(1);
            // At least as many matches as the live run recorded (floors, not pins).
            expect(solved.matches.length).toBeGreaterThanOrEqual(r.identify.nMatches - 1);
        }
    }, 120000);

    test("the sigma-1 wreckage still refuses at depth 9", async () => {
        // Only 4 of its 19 "stars" are real (the rest are airglow-blob fragments); a deeper
        // neighbour search must find more true quads on real inputs, not conjure hypotheses
        // from junk.
        const solved = await solveTiers(bySigma.get(1).input);
        expect(solved.ok).toBe(false);
    });
});

describe("depth 9 does not re-admit the known impostors", () => {
    test("the occluded flare-lapse input now solves its TRUE field via the mag-5.5 tier", async () => {
        // This fixture is the same video as the sweep - the occluded 251-frame range, with
        // people crossing the camera. 11 of its 18 tracks are real stars of the same field;
        // the rest are occlusion fragments and flare loci. Under the old configuration no
        // tier could represent a quad from the clean 11 and the wide tier's impostors were
        // (correctly) executed - the clip read as unsolvable. The density-matched tier finds
        // the field the whole time: same sky as the clean segment, to a third of a degree.
        const solved = await solveTiers(occluded.stars);
        expect(solved.ok).toBe(true);
        expect(Math.abs(solved.centerRaDeg - TRUE_RA)).toBeLessThan(1);
        expect(Math.abs(solved.centerDecDeg - TRUE_DEC)).toBeLessThan(1);
        expect(solved.matches.length).toBeGreaterThanOrEqual(10);
        expect(solved.rmsPx).toBeLessThan(3);
        // And the impostor path stays dead: the wide tier alone must still refuse this input
        // (its Cassiopeia-region candidates were chance, and remain executed).
        const wideOnly = await solveField(occluded.stars, catalog, [indexes[3]],
            uiOpts(occluded.stars));
        expect(wideOnly.ok).toBe(false);
    }, 60000);

    test("the giddierone wide-tier window still refuses", async () => {
        const runC = fixture("giddieroneLongRunC.json");
        const sub = runC.stars.filter((s) =>
            s.obsF.filter((f) => f >= 440 && f < 660).length >= 15);
        const solved = await solveField(sub, catalog, [indexes[3]], uiOpts(sub, 1150, 642));
        expect(solved.ok).toBe(false);
    });

    test("the failure ladder's arithmetic: a capped view solves, and certification against the full set decides", async () => {
        // The ladder in identifyStars retries a failed identify on the most persistent
        // tracks, then must CERTIFY the pose against the uncapped input - capping shrinks
        // every consensus denominator, so an uncertified capped solve is structurally easier
        // to accept than the evidence justifies. Exercised here in the ladder's historical
        // configuration: at the old neighbour depth 7 the full sigma-5 input cannot solve
        // (the CONTROL above), but its top-12-by-persistence view can - and the pose then
        // certifies against all 18 stars with the full set's own arithmetic.
        const full = bySigma.get(5).input;
        const view = [...full]
            .sort((a, b) => b.n - a.n || a.mag - b.mag || a.index - b.index)
            .slice(0, 12);
        let attempt = null;
        for (const index of indexes) {
            attempt = await solveField(view, catalog, [index],
                {...uiOpts(view), imageNeighbors: 7});
            if (attempt.ok) break;
        }
        expect(attempt.ok).toBe(true);
        expect(Math.abs(attempt.centerRaDeg - TRUE_RA)).toBeLessThan(1);

        const cert = certifySolve(attempt, full, catalog);
        expect(cert.ok).toBe(true);
        expect(cert.nImage).toBe(18);
        expect(cert.matches.length).toBeGreaterThanOrEqual(14);
        expect(cert.rmsPx).toBeLessThan(3);

        // And the same certification refuses a pose that does not belong to the star set it
        // is being certified against: the true Why-not-this pose over the Giddierone chart.
        const giddierone = fixture("giddieronePanSegments.json");
        const foreign = certifySolve(attempt, giddierone.short.stars, catalog);
        expect(foreign.ok).toBe(false);
    }, 60000);

    test("hypothesis budgets hold under the deeper lists on the worst refusing inputs", async () => {
        // Depth 9 more than doubles the image quads per anchor (C(9,3)=84 vs C(7,3)=35). The
        // budget cap is what bounds a refusal's cost; confirm the refusing paths stay inside
        // it and never surface a wrong-field accept while burning it.
        for (const stars of [bySigma.get(1).input, occluded.stars]) {
            const solved = await solveField(stars, catalog, [indexes[3]],
                {...uiOpts(stars), debug: true});
            expect(solved.ok).toBe(false);
            expect(solved.diag.tried).toBeLessThanOrEqual(3000);
        }
    }, 60000);
});
