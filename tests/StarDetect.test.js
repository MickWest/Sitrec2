// Stage 1 of Star Track: point-source extraction, scored against synthetic ground truth.
//
// The synthetic generator reproduces the properties measured on the real target clip (saturated
// bloomed star disks, sky level ~24 with sigma ~3.1, a green laser whose core clips to white,
// hot pixels), so passing here means the detector survives the cases that actually break it.

import {
    STAR_DETECT_DEFAULTS,
    calibrateDetection,
    detectSources,
    estimateBackground,
    lumaFromRGBA,
    rejectReason,
    backgroundAt,
} from "../src/starTrack/StarDetect";

import {buildScene, inverseTransform, mulberry32, renderFrame, SYNTH_DEFAULTS} from "../src/starTrack/StarSynthetic";

/** Pearson correlation coefficient. */
function pearson(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
}

/** Least-squares slope of ys against xs. */
function slope(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    return sxy / sxx;
}

/** Pair detections to truth by nearest neighbour within `tol` px, greedily, brightest first. */
function matchToTruth(sources, truthStars, tol = 3.0) {
    const used = new Set();
    const matched = [];
    for (const s of sources) {
        let best = -1, bd = tol * tol;
        for (let i = 0; i < truthStars.length; i++) {
            if (used.has(i)) continue;
            const t = truthStars[i];
            const d2 = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
            if (d2 < bd) { bd = d2; best = i; }
        }
        if (best >= 0) { used.add(best); matched.push({source: s, truth: truthStars[best], dist: Math.sqrt(bd)}); }
    }
    return matched;
}

describe("StarDetect background estimation", () => {
    test("recovers sky level and noise sigma from a source-free frame", () => {
        const scene = buildScene({
            width: 320, height: 192, frames: 1, starCount: 0,
            movingObject: false, laser: false, hotPixels: 0, seed: 7,
        });
        const {rgba} = renderFrame(scene, 0);
        const L = lumaFromRGBA(rgba, 320, 192);
        const model = estimateBackground(L, 320, 192);

        const bg = backgroundAt(model, model.bg, 160, 96);
        const sg = backgroundAt(model, model.sigma, 160, 96);

        // Sky is skyLevel modulated by the luma weighting of skyTint.
        const P = SYNTH_DEFAULTS;
        const expected = P.skyLevel * (0.299 * P.skyTint[0] + 0.587 * P.skyTint[1] + 0.114 * P.skyTint[2]);
        expect(bg).toBeGreaterThan(expected - 2);
        expect(bg).toBeLessThan(expected + 2);
        expect(sg).toBeGreaterThan(1.0);
        expect(sg).toBeLessThan(6.0);
    });

    test("a bright source does not drag its own tile's background up", () => {
        // The failure this guards against: without sigma-clipping, a large bright feature raises
        // the local background until it thresholds itself away - which sliced the laser into one
        // piece per tile row in the prototype.
        const scene = buildScene({
            width: 256, height: 256, frames: 1, starCount: 0,
            movingObject: false, laser: true, hotPixels: 0, seed: 11,
        });
        const {rgba} = renderFrame(scene, 0);
        const L = lumaFromRGBA(rgba, 256, 256);
        const model = estimateBackground(L, 256, 256);

        // No tile's background may sit far above the true sky level, even tiles the beam crosses.
        let maxBg = -Infinity;
        for (let i = 0; i < model.bg.length; i++) maxBg = Math.max(maxBg, model.bg[i]);
        expect(maxBg).toBeLessThan(40);
    });
});

describe("StarSynthetic scene coverage", () => {
    test("a scene with no frames is rejected rather than silently producing NaN stars", () => {
        // The field bounds come from the frames' actual footprints, so with no frames the
        // bounding box stays at +/-Infinity and every star position is NaN - a scene that renders
        // nothing at all, with no error to say so.
        expect(() => buildScene({frames: 0})).toThrow(/frames must be an integer >= 1/);
        expect(() => buildScene({frames: -3})).toThrow(/frames must be an integer >= 1/);
        // A fractional count fails quietly rather than loudly: `1.5` builds two transforms while
        // params.frames stays 1.5, so any caller looping to params.frames disagrees with the array
        // it is indexing. Infinity never finishes building the transform list at all.
        expect(() => buildScene({frames: 1.5})).toThrow(/frames must be an integer >= 1/);
        expect(() => buildScene({frames: Infinity})).toThrow(/frames must be an integer >= 1/);
        expect(() => buildScene({frames: NaN})).toThrow(/frames must be an integer >= 1/);
    });

    test("every frame's footprint lies inside the generated star field", () => {
        // Regression: the reference-plane bounds were computed with the wrong sign on the pan, so
        // with the default downward pan the last frame had a starless band ~74 rows deep along
        // the bottom. Anything sampling outside the generated field silently loses stars, and
        // every downstream metric then measures the generator's bug rather than the algorithm.
        //
        // Tested as the exact geometric invariant - map each frame's corners back into the
        // reference plane and require them to be inside the generated rectangle. Inferring this
        // from where randomly-placed stars happen to land is far too noisy to be a real check.
        // Tested at ZERO margin, with jitter and roll left on. A generous margin hides bounds
        // errors rather than proving their absence: the previous closed-form bounds ignored both
        // the roll (which swings corners by up to half the diagonal times sin(theta)) and the
        // accumulated jitter (a random walk, so not boundable in closed form at all), and only
        // the 200 px default margin was concealing overshoots of up to 22 px.
        const W = 640, H = 360, frames = 120;
        const paths = [
            [-0.7, -2.3, -0.011], [0.7, 2.3, -0.011], [2.0, -1.0, 0.05],
            [0, 0, -0.05], [-3.1, 1.7, 0.02], [0, 0, 0],
        ];
        for (const [panX, panY, rollDegPerFrame] of paths) {
            const scene = buildScene({
                width: W, height: H, frames, seed: 5, panX, panY, rollDegPerFrame,
                fieldMargin: 0, jitterSigma: 0.35,
                laser: false, hotPixels: 0, movingObject: false, starCount: 1,
            });
            const {x0, y0, spanX, spanY} = scene.field;
            for (let f = 0; f < frames; f++) {
                const T = scene.transforms[f];
                for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
                    const [px, py] = inverseTransform(T, cx, cy);
                    // At zero margin the extreme corners define the bounds exactly, so they land
                    // ON the boundary and the round trip through inverseTransform can differ in
                    // the last bit. An ULP-scale epsilon, not a real tolerance.
                    const eps = 1e-9;
                    expect(px).toBeGreaterThanOrEqual(x0 - eps);
                    expect(px).toBeLessThanOrEqual(x0 + spanX + eps);
                    expect(py).toBeGreaterThanOrEqual(y0 - eps);
                    expect(py).toBeLessThanOrEqual(y0 + spanY + eps);
                }
            }
        }
    });
});

describe("StarDetect source extraction", () => {
    const W = 640, H = 360;
    const scene = buildScene({width: W, height: H, frames: 8, seed: 2024});
    const frame = renderFrame(scene, 3);
    const {sources} = detectSources(frame.rgba, W, H);
    const kept = sources.filter((s) => !rejectReason(s));

    /**
     * Pool unsaturated star photometry across every frame of the clip, so slope estimates rest on
     * a few dozen measurements rather than one frame's dozen.
     */
    let photometryCache = null;
    function photometryOverClip() {
        if (photometryCache) return photometryCache;
        const truthMag = [], aperture = [], isophotal = [];
        for (let f = 0; f < scene.params.frames; f++) {
            const fr = renderFrame(scene, f);
            const ks = detectSources(fr.rgba, W, H).sources.filter((s) => !rejectReason(s));
            for (const m of matchToTruth(ks, fr.truth.stars, 3.0)) {
                if (m.source.saturatedFrac !== 0 || !m.source.apertureComplete) continue;
                if (m.source.apertureFlux <= 0) continue;
                truthMag.push(m.truth.mag);
                aperture.push(-2.5 * Math.log10(m.source.apertureFlux));
                isophotal.push(-2.5 * Math.log10(m.source.flux));
            }
        }
        photometryCache = {truthMag, aperture, isophotal};
        return photometryCache;
    }

    test("finds essentially every star that is detectable in principle", () => {
        // Measured WITHOUT the laser, so this isolates detection performance. With the beam
        // present some stars are physically swallowed by it - they merge into one blob with the
        // beam (area ~11000, four peaks) which is then correctly rejected. That is the right
        // behaviour, not a miss, and it is covered by the laser tests below; mixing it in here
        // would just make this test measure where the beam happened to fall.
        //
        // Score only against stars comfortably above the detection threshold: stars below it are
        // SUPPOSED to be missed, and counting them would measure the noise floor instead.
        const clean = buildScene({width: W, height: H, frames: 8, seed: 2024, laser: false});
        const cf = renderFrame(clean, 3);
        const cs = detectSources(cf.rgba, W, H).sources.filter((s) => !rejectReason(s));

        const detectable = cf.truth.stars.filter((s) => s.peakSNR > 8);
        expect(detectable.length).toBeGreaterThanOrEqual(8);
        const matched = matchToTruth(cs, detectable, 3.0);
        expect(matched.length / detectable.length).toBeGreaterThan(0.9);
    });

    test("astrometry is sub-pixel for the stars it finds", () => {
        const matched = matchToTruth(kept, frame.truth.stars, 3.0);
        const dists = matched.map((m) => m.dist).sort((a, b) => a - b);
        const median = dists[dists.length >> 1];
        expect(median).toBeLessThan(0.5);
    });

    test("blob area carries magnitude for saturated stars, where peak carries none", () => {
        // This is the photometric premise of the whole feature: once a star clips, its peak stops
        // varying at all and only the AREA above threshold still ranks it. If this ever fails,
        // magnitude estimates downstream are meaningless.
        const matched = matchToTruth(kept, frame.truth.stars, 3.0)
            .filter((m) => m.source.saturatedFrac > 0.05);
        expect(matched.length).toBeGreaterThanOrEqual(4);

        const peaks = matched.map((m) => m.source.peak);
        // Peaks are pinned at the clip level - no information whatsoever.
        expect(Math.max(...peaks) - Math.min(...peaks)).toBeLessThan(5);

        // Area, in contrast, is strongly (and monotonically) anti-correlated with magnitude:
        // brighter star = numerically smaller magnitude = bigger blob.
        expect(pearson(
            matched.map((m) => m.truth.mag),
            matched.map((m) => Math.log10(m.source.area)),
        )).toBeLessThan(-0.85);
    });

    test("area remains a usable magnitude proxy across the unsaturated range too", () => {
        // Must EXCLUDE saturated sources. Leaving them in lets their very strong area/magnitude
        // relation carry the correlation and hide broken photometry on the unsaturated stars,
        // which are the majority and the ones where flux should be doing the work.
        const matched = matchToTruth(kept, frame.truth.stars, 3.0)
            .filter((m) => m.source.saturatedFrac === 0);
        expect(matched.length).toBeGreaterThanOrEqual(10);
        expect(pearson(
            matched.map((m) => m.truth.mag),
            matched.map((m) => Math.log10(m.source.area)),
        )).toBeLessThan(-0.85);
    });

    test("aperture photometry is zero-point-only calibrated (unit slope)", () => {
        // The claim is that instrumental magnitude differs from true magnitude by a CONSTANT.
        // Correlation cannot check that - it is invariant to slope, and isophotal flux passes a
        // correlation test easily while carrying a slope of ~1.70, i.e. exaggerating the whole
        // magnitude range by 70%. Only a regression slope tests the actual claim.
        // Pooled over every frame of the clip: a single frame yields only ~12 usable unsaturated
        // stars, and a slope from 12 points is too noisy to assert to a few percent.
        const {truthMag, aperture} = photometryOverClip();
        expect(aperture.length).toBeGreaterThanOrEqual(60);
        expect(slope(truthMag, aperture)).toBeCloseTo(1.0, 1);
    });

    test("isophotal flux is BIASED, which is why aperture flux exists", () => {
        // Guards the REASON for the aperture: if someone "simplifies" by going back to the
        // threshold-summed flux, this documents what that costs. The fraction of a source's light
        // above a fixed threshold depends on how bright the source is, so faint stars lose
        // proportionally more of their wings and the magnitude scale stretches by ~55%.
        const {truthMag, isophotal} = photometryOverClip();
        expect(slope(truthMag, isophotal)).toBeGreaterThan(1.3);
    });

    test("rejects the laser, including its saturated core", () => {
        // Every surviving source must be near a real star, the moving object, or a hot pixel -
        // no laser fragment may get through, whether or not its core clipped to white.
        // Hot pixels count as explained: they are genuine points of light and Stage 3 identifies
        // them by being fixed in camera coordinates, so the detector must NOT drop them here.
        const targets = frame.truth.stars.slice();
        if (frame.truth.object) targets.push(frame.truth.object);
        for (const hp of scene.hotPixels) targets.push({x: hp.x, y: hp.y});
        for (const s of kept) {
            const near = targets.some((t) => Math.hypot(t.x - s.x, t.y - s.y) < 4.0);
            if (!near) {
                throw new Error(
                    `unexplained source at (${s.x.toFixed(1)}, ${s.y.toFixed(1)}) ` +
                    `area=${s.area} peak=${s.peak.toFixed(0)} elong=${s.elongation.toFixed(2)} ` +
                    `green=${s.green} satFrac=${s.saturatedFrac.toFixed(2)}`);
            }
        }
    });

    test("the laser is rejected specifically BY COLOR, not incidentally by shape or size", () => {
        // Asserting only that rejectReason() is non-null would pass even with color detection
        // completely broken, because "elongated" or "huge" would fire anyway. Assert the green
        // flag itself, with the shape and size cuts disabled so nothing else can mask it.
        const laserOnly = buildScene({
            width: 320, height: 320, frames: 1, starCount: 0,
            movingObject: false, hotPixels: 0, laser: true, seed: 31,
        });
        const lf = renderFrame(laserOnly, 0);
        const {sources: ls} = detectSources(lf.rgba, 320, 320, {
            maxElongation: Infinity, maxArea: Infinity,
        });
        const beam = ls.filter((s) => s.area > 100);
        expect(beam.length).toBeGreaterThan(0);
        for (const s of beam) {
            expect(s.green).toBe(true);
            expect(rejectReason(s, {maxElongation: Infinity, maxArea: Infinity})).toBe("green");
        }
    });

    test("a clipped green core does not defeat the color test", () => {
        // The exact bug, isolated. Three zones: a core with all channels clipped, a wide annulus
        // where ONLY green is clipped, and thin genuinely-green wings.
        //
        // The (200,245,200) annulus has a luma of just 226, so a luma-based saturation test calls
        // it unsaturated and averages it into the color. The annulus is deliberately made to
        // dominate the pixel count, which drags the mean to (171,237,172) - not green by a ratio
        // test, so the source escapes rejection. A per-channel test discards every clipped pixel
        // and reads the true wing color (30,200,35), which is unambiguously green.
        //
        // These radii matter: at a narrower annulus BOTH the old and new logic return green, and
        // the test would prove nothing.
        const W = 64, H = 64;
        const rgba = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const d = Math.hypot(x - 32, y - 32);
                let r = 24, g = 24, b = 24;
                if (d < 4) { r = 245; g = 245; b = 245; }         // clipped white core
                else if (d < 12) { r = 200; g = 245; b = 200; }   // green clipped, luma only 226
                else if (d < 13) { r = 30; g = 200; b = 35; }     // unambiguously green wings
                rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
            }
        }
        const {sources: ss} = detectSources(rgba, W, H, {detectSmoothSigma: 0});
        const blob = ss.find((s) => s.area > 50);
        expect(blob).toBeDefined();
        expect(blob.saturatedFrac).toBeGreaterThan(0);
        expect(blob.green).toBe(true);
        // Pin down WHERE the color came from: the unclipped wings, not the clipped annulus.
        // Under the luma test this would read ~(171, 237, 172) instead.
        expect(blob.r).toBeLessThan(60);
        expect(blob.b).toBeLessThan(60);
    });

    test("a source clipped in green everywhere is not silently accepted", () => {
        // The mirror of the luma bug. This blob is (100,245,100) throughout: green hard-clipped
        // in every pixel, red and blue mid-range. There is no spatially consistent sample to
        // measure color from, so the detector must say so - and the policy must refuse to accept
        // a source it has no color evidence about, rather than defaulting to "not green" and
        // passing it through as a star.
        const W = 64, H = 64;
        const rgba = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const inside = Math.hypot(x - 32, y - 32) < 10;
                rgba[i] = inside ? 100 : 24;
                rgba[i + 1] = inside ? 245 : 24;
                rgba[i + 2] = inside ? 100 : 24;
                rgba[i + 3] = 255;
            }
        }
        const {sources: ss} = detectSources(rgba, W, H, {detectSmoothSigma: 0});
        const blob = ss.find((s) => s.area > 50);
        expect(blob).toBeDefined();
        expect(blob.colorUnknown).toBe(true);
        // Round and modest in size, so neither the elongation nor the area cut can save us here -
        // the color-evidence rule has to be what rejects it.
        expect(blob.elongation).toBeLessThan(2.5);
        expect(rejectReason(blob)).toBe("noColor");
    });

    test("sky pixels swept in by smoothing do not count as color evidence", () => {
        // Detection runs on the SMOOTHED image, so a small source's mask spills onto raw sky.
        // Those sky pixels are unclipped, so a naive "clean pixel" count says we have plenty of
        // color samples - while every genuine source pixel is clipped and we in fact know
        // nothing. Here all three source pixels are green-clipped at 245 and the mask grows to 27
        // pixels; the detector must still say colorUnknown rather than reporting the sky's
        // color as the source's.
        const W = 64, H = 64;
        const rgba = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const on = Math.abs(x - 32) <= 1 && y === 32;
                rgba[i] = on ? 100 : 24;
                rgba[i + 1] = on ? 245 : 24;
                rgba[i + 2] = on ? 100 : 24;
                rgba[i + 3] = 255;
            }
        }
        const blob = detectSources(rgba, W, H).sources.find((s) => s.area >= 3);
        expect(blob).toBeDefined();
        expect(blob.area).toBeGreaterThan(3);          // the mask really did grow past the source
        expect(blob.colorUnknown).toBe(true);
        expect(rejectReason(blob)).toBe("noColor");
    });

    test("a minimum-area source is not rejected for lack of color", () => {
        // Exactly THREE source pixels, with smoothing left ON so the mask dilates well past them.
        // That combination is what discriminates: capping the clean-pixel requirement against the
        // mask AREA needs min(4, 27) = 4 samples and only 3 exist, so the source is wrongly called
        // color-unknown and the whole smallest size class is rejected. Capping against the CORE
        // count needs min(4, 3) = 3, which is satisfied.
        //
        // A 2x2 block would not discriminate - it has four pixels, so the area-capped rule passes
        // too and the test proves nothing.
        const W = 64, H = 64;
        const rgba = new Uint8ClampedArray(W * H * 4);
        const on = new Set(["32,32", "33,32", "32,33"]);   // L-shape: three pixels, not a line
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const v = on.has(`${x},${y}`) ? 150 : 24;
                rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
            }
        }
        const blob = detectSources(rgba, W, H).sources.find((s) => s.area >= 3);
        expect(blob).toBeDefined();
        expect(blob.area).toBeGreaterThan(3);      // smoothing really did dilate the mask
        expect(blob.colorUnknown).toBe(false);
        expect(rejectReason(blob)).not.toBe("noColor");
    });

    test("a fixed aperture does not swallow a neighbouring source's pixels", () => {
        // A faint source whose aperture reaches into a MUCH brighter neighbour's detected
        // footprint. Summing a plain disk would hand the faint source a large share of the
        // neighbour's light, destroying relative photometry exactly where it matters most.
        //
        // Verified against the naive unmasked disk sum computed here, not against a loose ratio:
        // with the two sources barely touching, masked and unmasked differ by only a few percent
        // and any tolerant assertion passes either way, proving nothing.
        // Noise is deliberately present: it sets a realistic detection threshold. Without it the
        // threshold collapses to the sigma floor, both sources' footprints grow until they touch,
        // and they merge into a single component - so there is no neighbour to exclude and the
        // test cannot exercise the masking at all.
        const W = 96, H = 64;
        const rnd = mulberry32(4242);
        const rgba = new Uint8ClampedArray(W * H * 4);
        const px = (x, y) => 24
            + 3000 * Math.exp(-((x - 56) ** 2 + (y - 32) ** 2) / 2.88)   // bright, compact
            + 60 * Math.exp(-((x - 64) ** 2 + (y - 32) ** 2) / 2.88);    // faint, 8 px away
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const v = Math.max(0, Math.min(245, Math.round(px(x, y) + (rnd() - 0.5) * 10.4)));
                rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
            }
        }
        const {sources: ss, background} = detectSources(rgba, W, H, {detectSmoothSigma: 0});
        expect(ss.length).toBe(2);
        const faint = ss.find((s) => s.x > 60);
        expect(faint).toBeDefined();

        // What a naive unmasked disk would have summed.
        const AR = STAR_DETECT_DEFAULTS.apertureRadius;
        let naive = 0;
        for (let y = Math.floor(faint.y - AR); y <= Math.ceil(faint.y + AR); y++) {
            for (let x = Math.floor(faint.x - AR); x <= Math.ceil(faint.x + AR); x++) {
                if ((x - faint.x) ** 2 + (y - faint.y) ** 2 > AR * AR) continue;
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const i = (y * W + x) * 4;
                const L = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
                naive += L - backgroundAt(background, background.bg, x, y);
            }
        }
        // The unmasked disk is inflated ~1.7x by the neighbour's pixels; the masked one is not.
        // For contrast, the earlier version of this test used two barely-touching sources where
        // masked and unmasked differed by 3% - a margin any assertion would have passed.
        expect(naive).toBeGreaterThan(1.5 * faint.apertureFlux);
        expect(faint.apertureContaminated).toBe(true);
    });

    test("a bright neighbour's sub-threshold wings are flagged, not silently absorbed", () => {
        // The label masking tested above only removes a neighbour's DETECTED pixels. A broad
        // bright neighbour also spills wings that never cross the detection threshold, so no
        // foreign label is ever touched and the flux is inflated anyway. This covers that path.
        //
        // Note this cannot be caught by asking which source each aperture pixel is nearest to:
        // at this separation every aperture pixel is still nearest its own source, so such a
        // measure reads exactly zero while the flux is visibly wrong.
        const W = 128, H = 96;
        const render = (withNeighbour) => {
            const rnd = mulberry32(99);
            const a = new Uint8ClampedArray(W * H * 4);
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    let v = 24;
                    if (withNeighbour) v += 3000 * Math.exp(-((x - 40) ** 2 + (y - 48) ** 2) / 72);
                    v += 60 * Math.exp(-((x - 66) ** 2 + (y - 48) ** 2) / 2.8);
                    v += (rnd() - 0.5) * 10.4;
                    const c = Math.max(0, Math.min(245, Math.round(v)));
                    const i = (y * W + x) * 4;
                    a[i] = c; a[i + 1] = c; a[i + 2] = c; a[i + 3] = 255;
                }
            }
            return a;
        };
        const find = (img) => detectSources(img, W, H, {detectSmoothSigma: 0})
            .sources.find((s) => Math.abs(s.x - 66) < 3);

        const alone = find(render(false));
        const withN = find(render(true));
        expect(alone).toBeDefined();
        expect(withN).toBeDefined();

        // The photometry really IS corrupted here - about 20% - and no foreign labelled pixel
        // ever enters the aperture, so label masking alone would report it as clean.
        const err = Math.abs(withN.apertureFlux / alone.apertureFlux - 1);
        expect(err).toBeGreaterThan(0.1);

        // The annulus cannot rescue this case, and that is precisely why the geometric test
        // exists: the ring pixels that would reveal the neighbour are excluded for being
        // labelled, so the measured local sky comes out near zero.
        expect(Math.abs(withN.apertureLocalSky)).toBeLessThan(1);

        // What matters is that the measurement is not presented as trustworthy.
        expect(withN.apertureNeighbour).toBe(true);
        expect(withN.apertureContaminated).toBe(true);
        // ...while the same source measured in isolation is clean.
        expect(alone.apertureContaminated).toBe(false);
    });

    test("an elongated neighbour lying across the annulus is flagged", () => {
        // The neighbour test originally bounded a component by sqrt(area / PI) - the radius of a
        // disk of equal area. A laser streak has a small area spread over a long line, so that
        // radius says "far away" while the beam is lying right across the source's sky annulus.
        // Bounding by the component's actual extent is what makes the test shape-independent.
        const W = 128, H = 96;
        const rnd = mulberry32(21);
        const render = (withBeam) => {
            const a = new Uint8ClampedArray(W * H * 4);
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    let v = 24;
                    // A long thin near-vertical beam: modest area, very large extent.
                    if (withBeam) v += 220 * Math.exp(-((x - 52) ** 2) / 4.0);
                    v += 70 * Math.exp(-((x - 64) ** 2 + (y - 48) ** 2) / 2.8);
                    v += (rnd() - 0.5) * 10.4;
                    const c = Math.max(0, Math.min(245, Math.round(v)));
                    const i = (y * W + x) * 4;
                    a[i] = c; a[i + 1] = c; a[i + 2] = c; a[i + 3] = 255;
                }
            }
            return a;
        };
        const beamScene = detectSources(render(true), W, H, {detectSmoothSigma: 0}).sources;
        const star = beamScene.find((s) => Math.abs(s.x - 64) < 3 && Math.abs(s.y - 48) < 4);
        const beam = beamScene.find((s) => s.height > 40);
        expect(star).toBeDefined();
        expect(beam).toBeDefined();

        // The beam really is elongated enough that its equal-area disk radius understates it.
        const equivalentCircleRadius = Math.sqrt(beam.area / Math.PI);
        const actualReach = Math.hypot(beam.maxX - beam.minX, beam.maxY - beam.minY) / 2;
        expect(actualReach).toBeGreaterThan(2 * equivalentCircleRadius);

        expect(star.apertureNeighbour).toBe(true);
        expect(star.apertureContaminated).toBe(true);
    });

    test("invalid (non-positive) aperture flux is never reported as clean photometry", () => {
        // A non-positive aperture flux is a FAILED measurement, not an uncontaminated one.
        // Computing the sky correction as `flux > 0 ? ... : 0` reported exactly zero correction
        // for it, presenting the worst photometry in the frame as the cleanest.
        //
        // Produced here by an annulus-shaped source: its centroid lands in its own hole. The
        // aperture there covers the other component's pixels (masked out) plus plain sky, which
        // contributes no background excess - so nothing is left to sum and the flux comes to zero.
        const W = 64, H = 64;
        const rgba = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                // A faint source sitting in a bright ring - the annulus reads far above the source.
                const d = Math.hypot(x - 32, y - 32);
                let v = 24;
                if (d < 2.5) v = 60;
                if (d > 9 && d < 14) v = 200;
                rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
            }
        }
        const ss = detectSources(rgba, W, H, {detectSmoothSigma: 0}).sources;
        const failed = ss.find((q) => !(q.apertureFlux > 0));
        expect(failed).toBeDefined();
        expect(failed.apertureSkyCorrection).toBe(Infinity);
        expect(failed.apertureContaminated).toBe(true);
    });

    test("a neutral source on a dark tile is not mistaken for a green laser", () => {
        // Sky subtraction can push a source's background-subtracted channels NEGATIVE where the
        // local sky sits below the frame median. A ratio test inverts on negative numbers, so a
        // perfectly neutral source at (-10,-10,-10) satisfies "g > 1.6 * max(r,b)" and is thrown
        // away as a laser. Here the right half of the frame is markedly darker than the left, and
        // the neutral sources on it must survive.
        // A smooth gradient, as real vignetting and light pollution produce. (A hard step is not
        // a fair test: the discontinuity inflates the sigma of whichever tile straddles it, and a
        // source sitting on it is legitimately not detected at all.)
        const W = 224, H = 96;
        const rnd = mulberry32(7);
        const rgba = new Uint8ClampedArray(W * H * 4);
        const centres = [32, 112, 192];
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                let v = 44 - 32 * (x / W);          // sky falls from 44 to 12 across the frame
                for (const cx of centres) v += 120 * Math.exp(-((x - cx) ** 2 + (y - 48) ** 2) / 4.0);
                v += (rnd() - 0.5) * 6;
                const c = Math.max(0, Math.min(245, Math.round(v)));
                rgba[i] = c; rgba[i + 1] = c; rgba[i + 2] = c; rgba[i + 3] = 255;
            }
        }
        const ss = detectSources(rgba, W, H).sources;
        for (const cx of centres) {
            const s = ss.find((q) => Math.abs(q.x - cx) < 3 && Math.abs(q.y - 48) < 3);
            expect(s).toBeDefined();
            expect(s.green).toBe(false);
            expect(rejectReason(s)).not.toBe("green");
        }
        // The darkest source sits well below the frame's median sky, which is exactly the
        // situation that drove the subtracted channels negative and inverted the ratio test.
        const darkest = ss.find((q) => Math.abs(q.x - centres[2]) < 3);
        expect(darkest.g).toBeGreaterThan(0);
    });

    test("hot pixels appear in the frame's ground truth", () => {
        expect(Array.isArray(frame.truth.hotPixels)).toBe(true);
        expect(frame.truth.hotPixels.length).toBe(scene.hotPixels.length);
    });

    test("hot pixels are detected as sources rather than silently dropped", () => {
        // They must survive detection - the later stage identifies them by being fixed in camera
        // coordinates. Dropping them here would make that impossible.
        const hp = scene.hotPixels[0];
        const near = sources.some((s) => Math.hypot(s.x - hp.x, s.y - hp.y) < 3.0);
        expect(near).toBe(true);
    });
});

describe("StarDetect calibration", () => {
    // Every pixel-denominated constant in the pipeline assumes one particular resolution, zoom
    // and exposure. calibrateDetection measures the blobs a frame actually contains and derives
    // the constants from them, so the same footage at twice the plate scale gets parameters that
    // are twice as big rather than parameters that reject its stars as "tiny".
    const render = (overrides) => {
        const scene = buildScene({
            frames: 1, seed: 7788, laser: false, movingObject: false,
            starCount: 140, fieldMargin: 120, ...overrides,
        });
        const r = renderFrame(scene, 0);
        return {rgba: r.rgba, W: scene.params.width, H: scene.params.height};
    };

    test("recommendations are sane on footage at the reference scale", () => {
        const {rgba, W, H} = render({});
        const cal = calibrateDetection(rgba, W, H);
        expect(cal.ok).toBe(true);
        expect(cal.count).toBeGreaterThan(10);
        // The defaults were hand-tuned on footage at this blob scale, so the measured
        // recommendations should land near them - a calibration that "corrects" the reference
        // case away from values verified on it would be measuring something else.
        expect(cal.minArea).toBeGreaterThanOrEqual(2);
        expect(cal.minArea).toBeLessThanOrEqual(8);
        expect(cal.apertureRadius).toBeGreaterThanOrEqual(4);
        expect(cal.apertureRadius).toBeLessThanOrEqual(9);
        expect(cal.annulusInner).toBe(cal.apertureRadius + 3);
        expect(cal.annulusOuter).toBe(cal.apertureRadius + 8);
    });

    test("recommendations scale with the size of the stars on the sensor", () => {
        const small = render({});
        const big = render({psfSigma: 3.2});
        const cs = calibrateDetection(small.rgba, small.W, small.H);
        const cb = calibrateDetection(big.rgba, big.W, big.H);
        expect(cs.ok).toBe(true);
        expect(cb.ok).toBe(true);
        expect(cb.medianArea).toBeGreaterThan(cs.medianArea * 1.3);
        expect(cb.minArea).toBeGreaterThan(cs.minArea);
        expect(cb.apertureRadius).toBeGreaterThan(cs.apertureRadius);
        expect(cb.trackRadius).toBeGreaterThanOrEqual(cs.trackRadius);
    });

    test("too few blobs refuses to calibrate rather than guessing", () => {
        // No stars AND no hot pixels: what remains is noise, and a handful of noise speckles
        // must produce a refusal, not a confident recommendation measured on nothing.
        const {rgba, W, H} = render({starCount: 0, hotPixels: 0});
        const cal = calibrateDetection(rgba, W, H);
        expect(cal.ok).toBe(false);
    });
});
