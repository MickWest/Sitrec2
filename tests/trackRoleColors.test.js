/**
 * trackRoleColors.test.js — the shared camera/target/truth palette.
 *
 * These colors were chosen by measurement, not by eye
 * (private/notes/TrackRoleColorProposal.md), and the measurements are the reason the
 * values are what they are. Without a test the next person to "tidy" the palette
 * has no way to know that softening the target red or adopting a brighter camera
 * blue quietly reintroduces a collision.
 *
 * The visual-regression suite cannot cover this: only STANAG and BOT files
 * declare track roles, and no regression sitch loads either.
 */

import {VIZ} from "../src/TraverseHypotheses";

/** Weighted-RGB distance — enough to answer "are these two confusable". */
function distance(hexA, hexB) {
    const rgb = (h) => {
        const s = h.replace("#", "");
        return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
    };
    const [a, b] = [rgb(hexA), rgb(hexB)];
    const rMean = (a[0] + b[0]) / 2;
    const [dr, dg, db] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    return Math.sqrt((2 + rMean) * dr * dr + 4 * dg * dg + (3 - rMean) * db * db);
}

// Under about 0.4 reads as a collision at a glance; 0.6 is comfortable.
const COMFORTABLE = 0.6;

const HYPOTHESIS_KEYS = ["constAir", "aircraft", "slowObj", "fastObj"];

describe("track role palette", () => {

    test("the three roles are defined and sensor is an alias of camera", () => {
        expect(VIZ.camera).toBe("#7fd4e8");
        expect(VIZ.target).toBe("#ff0000");
        expect(VIZ.truth).toBe("#e0569f");
        // Chart code says "sensor" because that is the domain word there. It must
        // stay the same colour as the camera it draws.
        expect(VIZ.sensor).toBe(VIZ.camera);
    });

    test("camera and truth clear every hypothesis colour they share a chart with", () => {
        // Target is deliberately NOT checked here: it is never drawn on a traverse
        // chart, because there the target IS the hypothesis. That freedom is what
        // lets it keep the legacy red.
        for (const key of HYPOTHESIS_KEYS) {
            expect(distance(VIZ.camera, VIZ[key])).toBeGreaterThan(COMFORTABLE);
            expect(distance(VIZ.truth, VIZ[key])).toBeGreaterThan(COMFORTABLE);
        }
    });

    test("the roles are separated from each other", () => {
        expect(distance(VIZ.camera, VIZ.target)).toBeGreaterThan(1.0);
        expect(distance(VIZ.camera, VIZ.truth)).toBeGreaterThan(1.0);
        // Target and truth share a surface only in the Track Browser, on a BOT
        // file where they ARE the same object. They are still well separated, and
        // truth is drawn dashed there so the distinction never rests on hue.
        expect(distance(VIZ.target, VIZ.truth)).toBeGreaterThan(1.0);
    });

    test("softening the target red would reintroduce a collision", () => {
        // The measurement that decided this, kept because the instinct to soften a
        // pure red is strong and the consequence is invisible without the number.
        expect(distance("#e8564d", VIZ.truth)).toBeLessThan(0.6);
        expect(distance(VIZ.target, VIZ.truth)).toBeGreaterThan(1.0);
    });

    test("the Track Browser's old camera blue would collide with constAir", () => {
        // #4fc3f7 was the Track Browser's own choice before the palettes merged.
        // constAir is the most common line on a traverse chart.
        expect(distance("#4fc3f7", VIZ.constAir)).toBeLessThan(COMFORTABLE);
        expect(distance(VIZ.camera, VIZ.constAir)).toBeGreaterThan(COMFORTABLE);
    });
});
