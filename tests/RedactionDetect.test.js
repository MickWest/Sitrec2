/**
 * Tests for detectRedactionRects() — the redaction-box detector behind the
 * "Auto Mask Redactions" button (src/RedactionDetect.js).
 *
 * The detector is pure JS with no DOM/OpenCV/Three dependency, so we can build
 * synthetic ImageData-like frames ({data, width, height}) and assert the rects.
 *
 * Frame model used by the helpers:
 *   - background pixels are grey (R=G=B) and TEXTURED (differ sharply between
 *     neighbours); when `moving` they also change every frame -> rejected by both
 *     the flatness and the temporal-invariance tests.
 *   - "black rects" are constant 0 (flat + invariant + grey + dark) -> redactions.
 */

import {detectRedactionRects} from '../src/RedactionDetect.js';

function makeFrame(w, h, f, blackRects, {moving = true} = {}) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const inRect = blackRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
            // Textured background; +f term makes it change frame-to-frame.
            const v = inRect ? 0 : ((x * 37 + y * 101 + (moving ? f * 60 : 0)) & 255);
            data[idx] = v; data[idx + 1] = v; data[idx + 2] = v; data[idx + 3] = 255;
        }
    }
    return {data, width: w, height: h};
}

function makeFrames(w, h, n, blackRects, opts) {
    return Array.from({length: n}, (_, f) => makeFrame(w, h, f, blackRects, opts));
}

function covers(rects, x, y) {
    return rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

describe('detectRedactionRects', () => {
    test('detects a solid black rectangle over a moving textured background', () => {
        const W = 200, H = 150;
        const box = {x: 60, y: 50, w: 60, h: 50};
        const frames = makeFrames(W, H, 4, [box]);
        const rects = detectRedactionRects(frames, W, H);

        expect(rects.length).toBeGreaterThanOrEqual(1);
        // Some returned rect contains the centre of the box.
        expect(covers(rects, box.x + box.w / 2, box.y + box.h / 2)).toBe(true);
        // ... and the whole box is covered, but the result is not the whole frame.
        const corners = [[box.x, box.y], [box.x + box.w - 1, box.y], [box.x, box.y + box.h - 1], [box.x + box.w - 1, box.y + box.h - 1]];
        for (const [cx, cy] of corners) expect(covers(rects, cx, cy)).toBe(true);
        const masked = rects.reduce((a, r) => a + r.w * r.h, 0);
        expect(masked).toBeLessThan(W * H * 0.5);
    });

    test('requires at least two frames (no temporal evidence -> empty)', () => {
        const W = 120, H = 100;
        const frames = makeFrames(W, H, 1, [{x: 30, y: 30, w: 40, h: 40}]);
        expect(detectRedactionRects(frames, W, H)).toEqual([]);
        expect(detectRedactionRects([], W, H)).toEqual([]);
    });

    test('flatness rejects an invariant-but-textured region (only the flat box is masked)', () => {
        // Background is identical in every frame (invariant) but textured, so the
        // ONLY discriminator left is flatness. It must not be masked.
        const W = 160, H = 120;
        const box = {x: 50, y: 40, w: 50, h: 40};
        const frames = makeFrames(W, H, 3, [box], {moving: false});
        const rects = detectRedactionRects(frames, W, H);

        expect(covers(rects, box.x + box.w / 2, box.y + box.h / 2)).toBe(true);
        // A textured background point well away from the box is not masked.
        expect(covers(rects, 10, 10)).toBe(false);
        const masked = rects.reduce((a, r) => a + r.w * r.h, 0);
        expect(masked).toBeLessThan(W * H * 0.4);
    });

    test('snaps a near-edge box to the frame edge to avoid slivers', () => {
        // A tall box a few px in from the left and not quite touching top/bottom.
        // With edgeSnap=0.05 (default) its left edge (within 5% of width) snaps to
        // x=0 and its top/bottom (within 5% of height) snap to 0 and H.
        const W = 200, H = 200;
        const box = {x: 6, y: 8, w: 30, h: H - 16}; // left=6 (<10), top=8 (<10), bottom=H-8 (>H-10)
        const frames = makeFrames(W, H, 3, [box]);
        const rects = detectRedactionRects(frames, W, H);

        const edgeRect = rects.find(r => r.x === 0);
        expect(edgeRect).toBeDefined();
        expect(edgeRect.x).toBe(0);
        expect(edgeRect.y).toBe(0);
        expect(edgeRect.y + edgeRect.h).toBe(H);
    });

    test('does NOT snap a box that sits comfortably away from the edges', () => {
        const W = 200, H = 200;
        const box = {x: 60, y: 60, w: 50, h: 50};
        const frames = makeFrames(W, H, 3, [box]);
        const rects = detectRedactionRects(frames, W, H);
        // No returned rect should be glued to an edge.
        for (const r of rects) {
            expect(r.x).toBeGreaterThan(0);
            expect(r.y).toBeGreaterThan(0);
            expect(r.x + r.w).toBeLessThan(W);
            expect(r.y + r.h).toBeLessThan(H);
        }
    });

    test('covers overlapping boxes (L-shape) without masking the empty notch', () => {
        // Wide top arm + narrow left arm = an L. The notch (bottom-right) is real
        // content and must stay unmasked; both arms must be covered.
        const W = 120, H = 120;
        const top = {x: 20, y: 20, w: 60, h: 22};   // wide
        const left = {x: 20, y: 42, w: 22, h: 50};  // narrow, continues downward
        const frames = makeFrames(W, H, 3, [top, left]);
        const rects = detectRedactionRects(frames, W, H);

        expect(covers(rects, 50, 30)).toBe(true);  // in the wide top arm
        expect(covers(rects, 30, 80)).toBe(true);  // in the narrow left arm
        expect(covers(rects, 70, 85)).toBe(false); // deep in the empty notch
    });

    test('detects a coloured (non-grey) flat invariant box — colour is ignored', () => {
        // A saturated blue box (RGB spread 180) would be rejected by the old
        // "greyness" test; the detector now ignores colour entirely, so a flat,
        // invariant box of any colour (luma <= maxLuma) is masked.
        const W = 160, H = 120;
        const box = {x: 50, y: 40, w: 50, h: 40, rgb: [20, 40, 200]}; // luma ~ 52
        const frames = Array.from({length: 4}, (_, f) => {
            const data = new Uint8ClampedArray(W * H * 4);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
                if (inBox) { data[idx] = box.rgb[0]; data[idx + 1] = box.rgb[1]; data[idx + 2] = box.rgb[2]; }
                else { const v = (x * 37 + y * 101 + f * 60) & 255; data[idx] = v; data[idx + 1] = v; data[idx + 2] = v; }
                data[idx + 3] = 255;
            }
            return {data, width: W, height: H};
        });
        const rects = detectRedactionRects(frames, W, H);
        expect(covers(rects, box.x + box.w / 2, box.y + box.h / 2)).toBe(true);
    });

    test('bridges the non-flat seam between two stacked boxes when snap is enabled', () => {
        // Two black boxes with a 6px gap between them filled by an invariant but
        // NON-FLAT seam (alternating tones). The seam fails the flatness test, so
        // it is not a candidate and the boxes are separate masses. `snap` should
        // bridge across it (covering the seam); snap=0 should leave it unmasked.
        const W = 160, H = 140;
        const top = {x: 40, y: 30, w: 70, h: 30};
        const bot = {x: 40, y: 66, w: 70, h: 30}; // gap y60..66
        const frames = Array.from({length: 4}, (_, f) => {
            const data = new Uint8ClampedArray(W * H * 4);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                const inTop = x >= top.x && x < top.x + top.w && y >= top.y && y < top.y + top.h;
                const inBot = x >= bot.x && x < bot.x + bot.w && y >= bot.y && y < bot.y + bot.h;
                const inSeam = x >= 40 && x < 110 && y >= 60 && y < 66;
                let v;
                if (inTop || inBot) v = 0;                       // black boxes (flat, invariant)
                else if (inSeam) v = ((x + y) & 1) ? 30 : 150;   // invariant but NON-FLAT seam
                else v = (x * 37 + y * 101 + f * 60) & 255;      // moving textured background
                data[idx] = v; data[idx + 1] = v; data[idx + 2] = v; data[idx + 3] = 255;
            }
            return {data, width: W, height: H};
        });

        // spread:0 isolates the bridging from the outward expansion.
        const bridged = detectRedactionRects(frames, W, H, {snap: 10, spread: 0});
        expect(covers(bridged, 70, 63)).toBe(true);   // seam centre now masked
        expect(covers(bridged, 70, 45)).toBe(true);   // top box
        expect(covers(bridged, 70, 80)).toBe(true);   // bottom box

        const unbridged = detectRedactionRects(frames, W, H, {snap: 0, spread: 0});
        expect(covers(unbridged, 70, 45)).toBe(true); // boxes still detected
        expect(covers(unbridged, 70, 80)).toBe(true);
        expect(covers(unbridged, 70, 63)).toBe(false); // seam left unmasked without snap
    });
});
