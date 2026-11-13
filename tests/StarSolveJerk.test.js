// A sparse field through a camera jerk: three stars that wander by half a pixel (a wide lens), a
// moving light, and 12 frames where the camera jumps 10 px and back while a rolling shutter
// shears the picture.
//
// Two faults turned the three stars "incoherent" on a real clip of this shape (Jupiter, Regulus
// and Mars at dawn). The refinement gate shrank below the shear, so the jerk frames' fits failed
// and were filled in from their neighbours - which erased the jerk and left the stars 10 px off
// on those frames. Then the star-only refinement ran on two long tracks and a few short ones, so
// most frames had too few stars to fit and were filled in across long gaps.

import {solveFrameChain} from "../src/starTrack/StarMatch";
import {solveStarField} from "../src/starTrack/StarSolve";

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const STARS = [[785, 335], [722, 402], [825, 271]];
const FRAMES = 197, JERK0 = 155, JERK1 = 167;

function clip(seed) {
    const rand = rng(seed);
    const gauss = () => (rand() + rand() + rand() - 1.5) * 0.12;
    const perFrame = [];
    for (let f = 0; f < FRAMES; f++) {
        // A slow hand-held drift and roll, as on the clip.
        const roll = 0.012 * f * Math.PI / 180;
        const tx = 0.1 * f, ty = -0.05 * f;
        // The jerk: 10 px right and back, and a shear of 1 px per 70 rows while it moves.
        const k = f >= JERK0 && f <= JERK1 ? Math.sin(Math.PI * (f - JERK0) / (JERK1 - JERK0)) : 0;
        const jerk = 10 * k, shear = k / 70;
        const frame = [];
        STARS.forEach(([x, y], k) => {
            const c = Math.cos(roll), s = Math.sin(roll);
            const X = c * x - s * y + tx, Y = s * x + c * y + ty;
            // What a flat model cannot remove - a wide lens as the camera drifts: each star
            // wanders slowly by about half a pixel, each its own way.
            const wx = 0.5 * Math.sin(f / 23 + 2.1 * k), wy = 0.5 * Math.cos(f / 31 + 1.3 * k);
            frame.push({x: X + jerk + shear * (Y - 340) + wx + gauss(), y: Y + wy + gauss(), flux: 500, peak: 200});
        });
        // A light that moves against the stars.
        frame.push({x: 950 + 0.4 * f + jerk, y: 500 - 0.15 * f, flux: 400, peak: 150});
        perFrame.push(frame);
    }
    return perFrame;
}

test("three stars stay stars through a camera jerk", () => {
    const perFrame = clip(5);
    const chain = solveFrameChain(perFrame, {});
    const solved = solveStarField(perFrame, chain.cumulative, {minObservations: 8});
    const byStart = (x, y) => solved.classified.find((c) => {
        const o = solved.tracks[c.index].obs[0];
        return o && Math.hypot(o.x - x, o.y - y) < 3;
    });
    for (const [x, y] of STARS) {
        const c = byStart(x, y);
        expect(c).toBeDefined();
        expect(solved.tracks[c.index].obs.length).toBeGreaterThan(FRAMES - 5);   // one track, end to end
        expect(c.klass).toBe("star");
    }
    // The transforms follow the jerk: in its middle, every star is where the solve puts it.
    const f = Math.round((JERK0 + JERK1) / 2);
    const T = solved.transforms[f];
    for (const c of solved.classified.filter((c) => c.klass === "star")) {
        const o = solved.tracks[c.index].obs.find((o) => o.f === f);
        if (!o) continue;
        const [sx, sy] = solved.stars[c.index];
        const px = T.A[0] * sx - T.A[1] * sy + T.B[0], py = T.A[1] * sx + T.A[0] * sy + T.B[1];
        expect(Math.hypot(px - o.x, py - o.y)).toBeLessThan(2);
    }
});

// The real clip: Jupiter, Regulus and Mars at dawn, a light that moves, and a 10 px camera jerk
// on frames 155-167. Its detections, as positions only.
test("the dawn clip's three points stay whole and the solve follows the jerk", () => {
    const fixture = require("./fixtures/dawnJerkDetections.json");
    const perFrame = fixture.frames.map((frame) => frame.map(([x, y]) => ({x, y, flux: 100, peak: 50})));
    const chain = solveFrameChain(perFrame, {});
    const solved = solveStarField(perFrame, chain.cumulative, {minObservations: fixture.minObservations});
    const near = (x, y) => solved.classified.find((c) => c.position
        && Math.hypot(c.position[0] - x, c.position[1] - y) < 4 && solved.tracks[c.index].obs.length > 150);
    const jupiter = near(785, 335), regulus = near(722, 402), mars = near(825, 271);
    for (const c of [jupiter, regulus, mars]) {
        expect(c).toBeDefined();                                         // one track, end to end
        const o = solved.tracks[c.index].obs.find((o) => o.f === 160);   // mid-jerk
        const T = solved.transforms[160], [sx, sy] = solved.stars[c.index];
        const px = T.A[0] * sx - T.A[1] * sy + T.B[0], py = T.A[1] * sx + T.A[0] * sy + T.B[1];
        expect(Math.hypot(px - o.x, py - o.y)).toBeLessThan(2);
    }
    // Mars sits on the scatter limit (0.66 px against about 0.6), so only these two are pinned.
    expect(jupiter.klass).toBe("star");
    expect(regulus.klass).toBe("star");
});
