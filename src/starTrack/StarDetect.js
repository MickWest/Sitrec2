// Point-source extraction for the Star Track analysis.
//
// Finds the points of light in a single video frame and measures each one well enough that the
// later stages can decide whether it is a star, a moving object, or an artifact.
//
// Deliberately pure: it takes a raw RGBA buffer and returns plain objects. No DOM, no THREE, no
// Sitrec globals - so it runs unchanged in the browser, in Jest, and in a standalone Node harness.
//
// Two properties of real night-sky video drive the design, both measured on the target clip:
//
//  1. Bright stars are BLOOMED SATURATED DISKS, not point sources. The luma profile across the
//     brightest star is flat at ~240 for over +/-10 px. Peak intensity therefore carries almost no
//     magnitude information once a star saturates - the AREA above threshold does. We measure both
//     and let the caller pick.
//
//  2. A saturated source washes out to white. A green laser's bright core has all three channels
//     high, so a color test run over the whole blob returns "not green" for exactly the blobs that
//     matter most. Color is therefore measured only over pixels that are BOTH fully unclipped in
//     every channel AND genuinely above the local background - and as an excess over the sky, not
//     as a raw mean. Each of those three conditions closes a distinct way the test fails open:
//     a clipped channel fakes white, a sky pixel dragged in by detection smoothing fakes grey,
//     and an unsubtracted sky floor washes out a faint source's true color.

/** Default tuning. All distances in pixels, all levels in 0..255 luma. */
export const STAR_DETECT_DEFAULTS = {
    // Background mesh. Tiles must be comfortably larger than the biggest star blob so that
    // sigma-clipping has plenty of genuine sky to work with.
    tileSize: 64,
    // Clip iterations for the per-tile background. Sources are positive excursions, so we clip
    // only the high side - clipping the low side too would bias the sky level upward.
    clipIterations: 3,
    clipSigma: 3.0,

    // Detection threshold in sigma above the local background.
    threshSigma: 5.0,
    // Matched-filter smoothing sigma used for DETECTION ONLY. Measurement always uses the
    // unsmoothed image, so smoothing improves faint-source recall without biasing photometry.
    // 0 disables it.
    detectSmoothSigma: 1.0,

    // A blob must have at least this many pixels to be a source. Single-pixel chroma speckle is
    // the dominant false positive in compressed night video.
    minArea: 3,
    // Above this, a blob is not a star - it is a laser streak, a cloud edge, or a building.
    maxArea: 4000,

    // Level at or above which a CHANNEL is treated as clipped. The target clip's codec tops out
    // near 243-248 rather than a clean 255, so this sits deliberately below 255.
    saturationLevel: 232,

    // Color rejection: green channel this much above both others (measured on unsaturated
    // pixels) marks a laser.
    greenRatio: 1.6,

    // Shape rejection: semi-major/semi-minor axis ratio above this is a streak, not a star.
    maxElongation: 2.5,
    // Colourless (all-channel-clipped) blobs are held to a stricter roundness than ordinary
    // sources: with no colour evidence, shape is the only witness left.
    noColorMaxElongation: 1.6,
    // A green blob bigger than this fraction of the whole frame is laser-scale, not
    // light-scale; smaller AND round, it is somebody's green light and is kept.
    greenMaxAreaFraction: 1e-3,

    // A blob whose peak barely clears the threshold but which covers a large area is a background
    // model failure, not a source. Require peak >= bg + peakSigma*sigma for blobs over minArea*4.
    peakSigma: 7.0,

    // Fixed aperture radius for unbiased photometry. Must comfortably contain the PSF: at the
    // target clip's scale a radius of 6 px holds >98% of a star's light even when it blooms.
    apertureRadius: 6,
    // Sky annulus around each aperture, used to remove a neighbour's sub-threshold wings. Inner
    // radius must clear the source's own PSF or the annulus eats the star's light; outer radius
    // must stay small enough that the wing level it measures is the one under the aperture.
    annulusInner: 9,
    annulusOuter: 14,
    // Share of an aperture's flux that the local-sky correction may account for before the
    // measurement is flagged as contaminated.
    apertureContaminationFrac: 0.05,

    // Clean (fully unclipped, above-threshold) pixels needed before a color judgement is
    // trusted. Capped at the source's own CORE pixel count - the pixels genuinely above the raw
    // threshold - so the smallest legitimate sources are not automatically declared
    // color-unknown. Capping against the mask area instead would break as soon as detection
    // smoothing dilates the mask beyond the source.
    minColorPixels: 4,

    // Deblending: a local maximum counts as separate if it is at least this many pixels from
    // another and rises this fraction of its own height above the saddle between them.
    deblendMinSeparation: 4,
    deblendContrast: 0.25,
};

/** Luma (Rec.601) from an RGBA buffer, as a Float32Array of length W*H. */
export function lumaFromRGBA(rgba, W, H) {
    const N = W * H;
    const L = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
        L[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
    return L;
}

/** Median of a Float64Array-like in place (partial sort is not worth it at these sizes). */
function medianOf(arr, n) {
    const a = Array.prototype.slice.call(arr, 0, n);
    a.sort((x, y) => x - y);
    return a[n >> 1];
}

/**
 * Per-tile sky level and noise, on a coarse mesh.
 *
 * Each tile's level is a sigma-clipped median: we repeatedly discard samples more than
 * clipSigma above the current median and re-measure. Without the clipping a big bright source
 * drags its own tile's background up until the source is thresholded away - which is exactly how
 * the prototype managed to slice a laser beam into one piece per tile row.
 *
 * Returns tile-centre samples; use {@link backgroundAt} to interpolate between them.
 */
export function estimateBackground(L, W, H, opts = {}) {
    const P = {...STAR_DETECT_DEFAULTS, ...opts};
    const TS = P.tileSize;
    const TX = Math.max(1, Math.ceil(W / TS));
    const TY = Math.max(1, Math.ceil(H / TS));
    const bg = new Float32Array(TX * TY);
    const sg = new Float32Array(TX * TY);

    // Sample on a stride-2 lattice: 4x fewer samples, no measurable change in the estimate.
    const cap = Math.ceil(TS / 2) * Math.ceil(TS / 2) + 4;
    const samples = new Float64Array(cap);

    for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
            const x0 = tx * TS, x1 = Math.min(W, x0 + TS);
            const y0 = ty * TS, y1 = Math.min(H, y0 + TS);
            let n = 0;
            for (let y = y0; y < y1; y += 2) {
                for (let x = x0; x < x1; x += 2) samples[n++] = L[y * W + x];
            }
            if (n === 0) { bg[ty * TX + tx] = 0; sg[ty * TX + tx] = 1; continue; }

            let med = medianOf(samples, n);
            let sigma = 1;
            let live = n;
            for (let it = 0; it <= P.clipIterations; it++) {
                // MAD -> sigma. 1.4826 makes it consistent with a Gaussian standard deviation.
                let m = 0;
                const dev = new Float64Array(live);
                for (let i = 0; i < live; i++) dev[i] = Math.abs(samples[i] - med);
                m = medianOf(dev, live);
                sigma = Math.max(0.5, 1.4826 * m);
                if (it === P.clipIterations) break;
                // Keep only the low side plus the bulk: sources are positive excursions.
                let k = 0;
                const hi = med + P.clipSigma * sigma;
                for (let i = 0; i < live; i++) if (samples[i] <= hi) samples[k++] = samples[i];
                if (k < 8 || k === live) { live = k > 0 ? k : live; break; }
                live = k;
                med = medianOf(samples, live);
            }
            bg[ty * TX + tx] = med;
            sg[ty * TX + tx] = sigma;
        }
    }
    return {bg, sigma: sg, TX, TY, tileSize: TS, W, H};
}

/**
 * Bilinearly interpolated background (or sigma) at a pixel.
 *
 * Nearest-tile lookup produces visible steps at tile boundaries, which show up as sources being
 * cut into pieces exactly one tile apart. Interpolating removes that.
 */
export function backgroundAt(model, field, x, y) {
    const {TX, TY, tileSize: TS} = model;
    // Tile centres sit at (t + 0.5) * TS.
    const fx = x / TS - 0.5;
    const fy = y / TS - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx0 = Math.min(TX - 1, Math.max(0, ix)), tx1 = Math.min(TX - 1, Math.max(0, ix + 1));
    const ty0 = Math.min(TY - 1, Math.max(0, iy)), ty1 = Math.min(TY - 1, Math.max(0, iy + 1));
    const wx = Math.min(1, Math.max(0, fx - ix));
    const wy = Math.min(1, Math.max(0, fy - iy));
    const a = field[ty0 * TX + tx0], b = field[ty0 * TX + tx1];
    const c = field[ty1 * TX + tx0], d = field[ty1 * TX + tx1];
    return (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
}

/** Separable Gaussian blur of a Float32 plane. Used for detection only, never for measurement. */
export function gaussianBlur(L, W, H, sigma) {
    if (!(sigma > 0)) return L;
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;

    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let acc = 0;
            for (let i = -r; i <= r; i++) {
                const xx = Math.min(W - 1, Math.max(0, x + i));
                acc += k[i + r] * L[y * W + xx];
            }
            tmp[y * W + x] = acc;
        }
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let acc = 0;
            for (let i = -r; i <= r; i++) {
                const yy = Math.min(H - 1, Math.max(0, y + i));
                acc += k[i + r] * tmp[yy * W + x];
            }
            out[y * W + x] = acc;
        }
    }
    return out;
}

/**
 * Count the significant local maxima inside one blob.
 *
 * Used to FLAG blended sources - a star sitting under the laser, or two stars merged by blooming.
 * A blended blob has a corrupted centroid and an inflated area, so the later stages must not
 * treat it as a clean measurement. We only count peaks here; splitting them is a later refinement.
 */
function countPeaks(pixels, L, W, P) {
    // Candidate maxima: pixels not lower than any 8-neighbour that is also in the blob.
    const inBlob = new Set(pixels);
    const peaks = [];
    for (const i of pixels) {
        const x = i % W, y = (i / W) | 0;
        const v = L[i];
        let isMax = true;
        for (let dy = -1; dy <= 1 && isMax; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const j = (y + dy) * W + (x + dx);
                if (inBlob.has(j) && L[j] > v) { isMax = false; break; }
            }
        }
        if (isMax) peaks.push({i, x, y, v});
    }
    if (peaks.length <= 1) return peaks.length;

    // Merge maxima that are close together or not separated by a deep enough saddle. Without this
    // every noisy flat-topped saturated core reports dozens of "peaks".
    peaks.sort((a, b) => b.v - a.v);
    const kept = [];
    for (const p of peaks) {
        let merged = false;
        for (const q of kept) {
            const d = Math.hypot(p.x - q.x, p.y - q.y);
            if (d < P.deblendMinSeparation) { merged = true; break; }
            // Saddle approximated by the lowest blob pixel on the straight line between them.
            let saddle = Infinity;
            const steps = Math.ceil(d);
            for (let s = 1; s < steps; s++) {
                const xx = Math.round(p.x + (q.x - p.x) * s / steps);
                const yy = Math.round(p.y + (q.y - p.y) * s / steps);
                const j = yy * W + xx;
                if (inBlob.has(j)) saddle = Math.min(saddle, L[j]);
            }
            if (!isFinite(saddle)) continue;
            if ((p.v - saddle) < P.deblendContrast * p.v) { merged = true; break; }
        }
        if (!merged) kept.push(p);
    }
    return kept.length;
}

/**
 * Extract point sources from one RGBA frame.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - W*H*4 RGBA pixels.
 * @param {number} W
 * @param {number} H
 * @param {object} [opts] - overrides for {@link STAR_DETECT_DEFAULTS}.
 * @returns {{sources: Array<object>, background: object}} sources are ordered brightest-first by
 *   flux. Each carries enough measurement for the caller to accept or reject it; nothing is
 *   silently discarded except sub-minArea specks, so the rejection policy stays with the caller.
 */
export function detectSources(rgba, W, H, opts = {}) {
    const P = {...STAR_DETECT_DEFAULTS, ...opts};
    const N = W * H;
    const L = lumaFromRGBA(rgba, W, H);
    const model = estimateBackground(L, W, H, P);

    // Detect on the matched-filtered image, measure on the raw one.
    const D = P.detectSmoothSigma > 0 ? gaussianBlur(L, W, H, P.detectSmoothSigma) : L;

    // Precompute per-pixel background and threshold once - backgroundAt() is too slow to call
    // inside the flood fill.
    const bgPix = new Float32Array(N);
    const sgPix = new Float32Array(N);
    const mask = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const b = backgroundAt(model, model.bg, x, y);
            const s = backgroundAt(model, model.sigma, x, y);
            bgPix[i] = b; sgPix[i] = s;
            // The smoothed image has reduced noise, so comparing it against the unsmoothed sigma
            // is conservative - it costs a little recall and buys a lower false-positive rate.
            if (D[i] > b + P.threshSigma * s) mask[i] = 1;
        }
    }

    // Global per-channel sky level. Color must be measured on BACKGROUND-SUBTRACTED values:
    // detection runs on the smoothed image, so a blob's mask spills outward onto raw sky pixels,
    // and those pixels are perfectly unclipped and would otherwise count as valid color samples.
    // On a small source they dominate - a 3-pixel green blob picked up 24 sky pixels and measured
    // a mean color of exactly the sky, reporting green=false. Subtracting the sky makes those
    // pixels contribute ~0 instead of dragging the mean, and it also makes the color of FAINT
    // sources meaningful, which a raw mean can never be when the sky is a large part of the signal.
    // A single global level is enough: the sky's COLOR varies far less across a frame than its
    // level does, and the level is already handled per-tile by the background mesh.
    const skyRGB = [0, 1, 2].map((c) => {
        const samp = [];
        for (let i = 0; i < N; i += 17) samp.push(rgba[i * 4 + c]);
        samp.sort((a, b) => a - b);
        return samp[samp.length >> 1];
    });
    // The sky's LEVEL does vary across the frame (vignetting, light-pollution gradients), and the
    // tile mesh already measures that in luma. Scaling the global per-channel sky by the local
    // luma background gives a per-channel sky that tracks the gradient, on the assumption that the
    // sky's COLOR is constant even where its level is not. Without this, a source on a tile darker
    // than the frame median subtracts too much and comes out with all three channels NEGATIVE -
    // and a ratio test on negative numbers is inverted, so an ordinary neutral source at
    // (-10,-10,-10) satisfies "g > 1.6 * max(r,b)" and is thrown away as a laser.
    const skyLuma = Math.max(1e-6,
        0.299 * skyRGB[0] + 0.587 * skyRGB[1] + 0.114 * skyRGB[2]);

    const labels = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const sources = [];
    // Component index per pixel, needed so aperture photometry can exclude pixels that belong to a
    // NEIGHBOURING source. Distinct from the source array index, because sub-minArea specks are
    // labelled during the flood fill but never become sources.
    let component = 0;

    for (let seed = 0; seed < N; seed++) {
        if (!mask[seed] || labels[seed] >= 0) continue;
        let sp = 0;
        stack[sp++] = seed;
        const myComponent = component++;
        labels[seed] = myComponent;
        const pixels = [];

        let area = 0, flux = 0, sx = 0, sy = 0, peak = 0, peakI = seed;
        let satCount = 0, edge = 0;
        // Color is accumulated only over pixels where NO channel is clipped, and only as an
        // excess over the sky.
        //
        // Averaging each channel independently over its own unclipped pixels looks tempting but is
        // wrong: on a source with a radial profile, green's unclipped pixels are the outer faint
        // ones while red and blue are still measurable further in, so the channels end up averaged
        // over DIFFERENT regions and the ratio is meaningless. Restricting to fully-clean pixels
        // keeps the comparison spatially consistent.
        // nCore counts pixels that are genuinely part of the SOURCE (above the raw threshold);
        // nClean counts how many of those are also unclipped. Detection runs on the smoothed
        // image, so the mask spills onto sky pixels - and sky pixels are unclipped, so counting
        // them as color samples means a blob whose every real pixel is clipped still reports
        // plenty of "clean" samples and a confident color of exactly nothing.
        let sr = 0, sg = 0, sb = 0, nClean = 0, nCore = 0;
        let srP = 0, sgP = 0, sbP = 0, nPartial = 0;
        let minX = W, maxX = -1, minY = H, maxY = -1;

        while (sp > 0) {
            const i = stack[--sp];
            const x = i % W, y = (i / W) | 0;
            const v = L[i];
            const w = Math.max(0, v - bgPix[i]);
            area++; flux += w; sx += w * x; sy += w * y;
            if (v > peak) { peak = v; peakI = i; }
            // Saturation must be a PER-CHANNEL test, not a luma test. A pixel like (200,245,200)
            // has a hard-clipped green channel but a luma of only 226 - a luma test calls it
            // unsaturated, then measures its color and reads a green ratio of 1.2 for what is
            // really a clipped green source. That is precisely how a laser core escapes color
            // rejection.
            const p = i * 4;
            const pr = rgba[p], pg = rgba[p + 1], pb = rgba[p + 2];
            const cr = pr >= P.saturationLevel, cg = pg >= P.saturationLevel, cb = pb >= P.saturationLevel;
            if (cr || cg || cb) satCount++;
            // A color sample must come from the source, not from sky the smoothing dragged in.
            if (v - bgPix[i] > P.threshSigma * sgPix[i]) {
                nCore++;
                const k = bgPix[i] / skyLuma;   // local sky level, in units of the global sky
                if (!cr && !cg && !cb) {
                    sr += pr - skyRGB[0] * k;
                    sg += pg - skyRGB[1] * k;
                    sb += pb - skyRGB[2] * k;
                    nClean++;
                }
                // PARTIAL evidence: red and blue readable, green possibly clipped. A clipped
                // green value is a LOWER BOUND on the truth, so these samples can still convict
                // a green source - they just can never acquit one.
                if (!cr && !cb) {
                    srP += pr - skyRGB[0] * k;
                    sgP += pg - skyRGB[1] * k;
                    sbP += pb - skyRGB[2] * k;
                    nPartial++;
                }
            }
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            pixels.push(i);

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= H) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= W) continue;
                    const j = ny * W + nx;
                    if (mask[j] && labels[j] < 0) { labels[j] = myComponent; stack[sp++] = j; }
                }
            }
        }

        if (area < P.minArea || flux <= 0) continue;

        const cx = sx / flux, cy = sy / flux;

        // Second moments -> elongation and orientation.
        let mxx = 0, myy = 0, mxy = 0;
        for (const i of pixels) {
            const x = i % W, y = (i / W) | 0;
            const w = Math.max(0, L[i] - bgPix[i]);
            mxx += w * (x - cx) * (x - cx);
            myy += w * (y - cy) * (y - cy);
            mxy += w * (x - cx) * (y - cy);
        }
        mxx /= flux; myy /= flux; mxy /= flux;
        const tr = mxx + myy, det = mxx * myy - mxy * mxy;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
        const elongation = l2 > 1e-6 ? Math.sqrt(l1 / l2) : Infinity;
        const orientation = 0.5 * Math.atan2(2 * mxy, mxx - myy);

        // Too few clean pixels to judge color. That happens for a source clipped in one channel
        // right out to its detection boundary - a hard-edged blob, not a real star or a real beam
        // (both fall off through a range where nothing clips). We report the fact rather than
        // inventing a color; rejectReason() then refuses to accept it, which closes the mirror of
        // the luma bug (a fully green-clipped blob previously read as "not green" and passed).
        //
        // The requirement is capped at the source's own core size: a flat 4-pixel minimum would
        // declare every legitimate minArea-sized source color-unknown and reject the lot, which
        // is what happened on the detectSmoothSigma:0 path where masks are not dilated. Capping
        // against nCore rather than area keeps that true whether or not smoothing is on.
        const needClean = Math.max(1, Math.min(P.minColorPixels, nCore));
        const colorUnknown = nClean < needClean;
        const r = colorUnknown ? 0 : sr / nClean;
        const g = colorUnknown ? 0 : sg / nClean;
        const b = colorUnknown ? 0 : sb / nClean;

        // With no clean pixels at all, the partial samples still testify: a green-clipped core
        // has readable red and blue and a green LOWER BOUND, and if even the bound exceeds the
        // green ratio, the source is green - clean pixels or none. This is what convicts a
        // saturated laser core as GREEN instead of letting it hide behind "no colour", and it
        // is what frees the no-colour rejection to mean what it says: all three channels
        // clipped, nothing readable anywhere.
        let partialGreen = false;
        if (colorUnknown && nPartial >= needClean) {
            const rP = srP / nPartial, gLB = sgP / nPartial, bP = sbP / nPartial;
            partialGreen = gLB > 0 && gLB > P.greenRatio * Math.max(rP, bP, 0);
        }

        sources.push({
            component: myComponent,
            x: cx, y: cy,
            area,
            flux,
            peak,
            peakX: peakI % W, peakY: (peakI / W) | 0,
            background: bgPix[peakI],
            sigma: sgPix[peakI],
            // Peak significance in sigma above the local background - the honest SNR of the
            // detection, and the cleanest way to spot a background-model failure.
            peakSNR: (peak - bgPix[peakI]) / Math.max(1e-6, sgPix[peakI]),
            elongation,
            orientation,
            saturatedFrac: satCount / area,
            r, g, b,
            colorUnknown,
            // Clamped at zero on both sides. These are background-subtracted excesses, so noise
            // and any residual sky mis-estimate can push them negative - and a ratio test on
            // negative numbers inverts, making a neutral source look green. A source with no
            // positive green excess at all cannot be a green laser.
            green: (!colorUnknown && g > 0 && g > P.greenRatio * Math.max(r, b, 0)) || partialGreen,
            edgeTouching: !!edge,
            width: maxX - minX + 1, height: maxY - minY + 1,
            // The frame's pixel count rides along so rejection policy can reason about size
            // RELATIVE to the image - absolute pixel areas mean different things at 720p and
            // 12 megapixels.
            imageArea: W * H,
            // Bounding box, kept so proximity tests can bound an ELONGATED component. An
            // equivalent-circle radius from the area badly under-states the reach of a streak.
            minX, minY, maxX, maxY,
            nPeaks: countPeaks(pixels, L, W, P),
        });
    }

    // Second pass: aperture photometry.
    //
    // `flux` above is isophotal - the sum over pixels that happened to clear the threshold. The
    // fraction of a source's light clearing a fixed threshold depends on how bright the source is
    // (a faint star loses proportionally more of its wings below the cut), so isophotal flux is a
    // BIASED magnitude estimator: against truth it gives a slope of ~1.55 rather than 1.00, i.e.
    // it stretches the whole magnitude range by 55%. A fixed aperture captures a constant fraction
    // of a given PSF whatever the brightness, so it differs from truth by a zero point only.
    //
    // This has to run AFTER every component is labelled, because a fixed aperture will happily
    // swallow a NEIGHBOURING source: two sources a few pixels apart would each report the pair's
    // combined light, destroying relative photometry precisely where it is most needed (a close
    // pair is exactly the case where good relative magnitudes matter). Pixels belonging to another
    // component are excluded, and the source is flagged so consumers can discount it.
    // Excluding a neighbour's labelled pixels is not enough on its own. A broad bright neighbour
    // whose detected footprint stays entirely outside the aperture still spills its sub-threshold
    // WINGS across it and inflates the flux, without a single foreign labelled pixel being
    // touched. Nor can that be caught by asking which source an aperture pixel is nearest to: at
    // a separation beyond twice the aperture radius EVERY aperture pixel is still nearest its own
    // source, so such a test reads zero contamination by construction while the flux is visibly
    // inflated.
    //
    // The standard photometric answer is to CORRECT it rather than flag it: re-measure the sky in
    // an annulus immediately around the source and subtract that local level. A neighbour's wings
    // raise the annulus by very nearly the amount they raise the aperture, so subtracting removes
    // the bulk of the contamination automatically, and for an isolated source the annulus level
    // sits at ~0 and nothing changes. Pixels belonging to any detected component are excluded from
    // the annulus so that a neighbouring source's CORE cannot set the level, and the estimate is a
    // median so any survivor is ignored anyway.
    const AR = P.apertureRadius;
    const AIN = P.annulusInner, AOUT = P.annulusOuter;
    for (const s of sources) {
        // Local sky from the annulus, over pixels not claimed by any source.
        const ring = [];
        const rx0 = Math.max(0, Math.floor(s.x - AOUT)), rx1 = Math.min(W - 1, Math.ceil(s.x + AOUT));
        const ry0 = Math.max(0, Math.floor(s.y - AOUT)), ry1 = Math.min(H - 1, Math.ceil(s.y + AOUT));
        for (let y = ry0; y <= ry1; y++) {
            for (let x = rx0; x <= rx1; x++) {
                const d2 = (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y);
                if (d2 < AIN * AIN || d2 > AOUT * AOUT) continue;
                const i = y * W + x;
                if (labels[i] >= 0) continue;
                ring.push(L[i] - bgPix[i]);
            }
        }
        let localSky = 0;
        if (ring.length >= 8) {
            ring.sort((a, b) => a - b);
            localSky = ring[ring.length >> 1];
        }

        let apFlux = 0;
        let complete = true;
        let foreignLabelled = false;
        let apPixels = 0;
        const ax0 = Math.floor(s.x - AR), ax1 = Math.ceil(s.x + AR);
        const ay0 = Math.floor(s.y - AR), ay1 = Math.ceil(s.y + AR);
        if (ax0 < 0 || ay0 < 0 || ax1 >= W || ay1 >= H) complete = false;
        for (let y = Math.max(0, ay0); y <= Math.min(H - 1, ay1); y++) {
            for (let x = Math.max(0, ax0); x <= Math.min(W - 1, ax1); x++) {
                if ((x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) > AR * AR) continue;
                const i = y * W + x;
                const lab = labels[i];
                if (lab >= 0 && lab !== s.component) { foreignLabelled = true; continue; }
                apFlux += L[i] - bgPix[i] - localSky;
                apPixels++;
            }
        }
        s.apertureFlux = apFlux;
        s.apertureComplete = complete;
        s.apertureLocalSky = localSky;
        s.aperturePixels = apPixels;
        // How much the local sky correction removed, as a share of the corrected flux. A large
        // value means the source sits on someone else's wings and even the corrected photometry
        // should be treated with suspicion.
        //
        // A non-positive flux is not "no correction needed" - it is a measurement that has failed
        // outright (the local sky came out above the source, which happens when a neighbour's
        // wings dominate the annulus). Reporting a correction of 0 there would present the worst
        // possible photometry as the cleanest, so it is flagged instead. -2.5*log10 of it is not
        // a number either way.
        const failed = !(apFlux > 0);
        s.apertureSkyCorrection = failed ? Infinity : (localSky * apPixels) / apFlux;

        // A neighbour whose own detected footprint reaches into our sky annulus compromises BOTH
        // measurements at once: the annulus samples its light instead of sky, and worse, the
        // pixels that would reveal that are the very ones excluded for being labelled - so the
        // ring ends up sampling only the far side and reads a local sky near zero while the flux
        // is inflated by ~20%. The correction cannot detect its own blind spot, so the geometry
        // is tested directly. This flags rather than corrects: photometry that is known-bad is
        // safe, photometry that is bad and labelled clean is not.
        // Measured against the neighbour's BOUNDING BOX, not an equivalent-circle radius from its
        // area. sqrt(area/PI) describes a disk, and a laser streak or any other elongated
        // component reaches far past that along its major axis - so a beam could lie across the
        // annulus while the circle test said it was comfortably distant.
        let neighbourIntrudes = false;
        for (const o of sources) {
            if (o === s) continue;
            const dx = Math.max(o.minX - s.x, 0, s.x - o.maxX);
            const dy = Math.max(o.minY - s.y, 0, s.y - o.maxY);
            if (dx * dx + dy * dy < AOUT * AOUT) { neighbourIntrudes = true; break; }
        }

        s.apertureNeighbour = neighbourIntrudes;
        // Magnitude, not signed value. A large NEGATIVE correction means the annulus read well
        // below the aperture - the source is sitting in a local dip, or the background mesh
        // disagrees with the annulus - and the photometry is just as suspect as when the
        // correction is large and positive. A signed comparison waves those through as clean.
        s.apertureContaminated = failed || foreignLabelled || neighbourIntrudes
            || Math.abs(s.apertureSkyCorrection) > P.apertureContaminationFrac;
    }

    sources.sort((a, b) => b.flux - a.flux);
    return {sources, background: model};
}

/**
 * The default accept/reject policy, kept separate from measurement so it can be tuned - or
 * overridden entirely - without touching the detector.
 *
 * Returns a reason string when the source should be rejected, or null to keep it.
 */
export function rejectReason(s, opts = {}) {
    const P = {...STAR_DETECT_DEFAULTS, ...opts};
    if (s.area < P.minArea) return "tiny";
    if (s.area > P.maxArea) return "huge";
    // Green convicts a LASER, and a laser is never a dot: its beam is elongated and its core
    // large. A COMPACT, ROUND green source is a light - an aircraft's starboard light is
    // exactly this, and on a twilight still two bright green lights were the only sources the
    // old unconditional rule deleted. So green only rejects a blob that is also non-round or
    // big relative to the image (a fixed pixel bound would mean different things at 720p and
    // 12 megapixels).
    if (s.green && (s.elongation > P.noColorMaxElongation
        || s.area > P.greenMaxAreaFraction * (s.imageArea || Infinity))) return "green";
    // Every channel clipped across the whole blob means colour has nothing to say - but
    // colourlessness alone is no longer a conviction, because on a deep exposure it is exactly
    // the BRIGHTEST stars that clip all three channels, and rejecting them deletes the most
    // recognisable objects in the image. Green-clipped cores are already convicted as "green"
    // by the partial-channel evidence above, so what reaches here is white-clipped - and there
    // SHAPE separates the cases: a star clips into a round disk, a beam's clipped core into a
    // streak. Only a colourless blob that is also non-round is refused.
    if (s.colorUnknown && s.elongation > P.noColorMaxElongation) return "noColor";
    if (s.elongation > P.maxElongation) return "elongated";
    if (s.nPeaks > 1) return "blended";
    if (s.edgeTouching) return "edge";
    // A large blob whose peak barely clears the detection threshold means the local background
    // was under-estimated, not that a faint extended source is present.
    if (s.area > P.minArea * 4 && s.peakSNR < P.peakSigma) return "lowPeak";
    return null;
}

/**
 * Measure the star blobs in one frame and derive the pixel-scale parameters from them.
 *
 * Every pixel-denominated constant in the pipeline - minimum blob area, aperture radii, the
 * association gate, the camera-fixed excursion bound - implicitly assumes one particular
 * resolution, zoom and exposure. On footage where a star spans four times as many pixels, the
 * same constants reject real stars as "tiny" and measure their flux through an aperture smaller
 * than the blob. This calibrates them from what the frame actually contains.
 *
 * Detection runs with minArea forced to 2, because the measurement must not be gated by the very
 * parameter it is trying to set - while a single pixel above threshold is a photosite artifact or
 * a noise spike at ANY plate scale, since a real PSF is wider than one pixel however the camera
 * is zoomed. Letting those in would drag the size statistics toward 1 px exactly on the sparse
 * frames where the median has the least protection. The size statistic is the MEDIAN blob area
 * of the accepted sources: bright saturated stars bloom large and the odd noise speckle is
 * small, and the median ignores both tails. Everything else scales from the equivalent radius of
 * that median blob:
 *
 *   - minArea: a SIXTEENTH of the median area, which is much further below the middle than
 *     intuition suggests because the calibration frame's population is not the tracking
 *     population. A single frame shows mostly the bright bloomed disks; the faint stars that
 *     matter for tracking flicker at the threshold and show tiny areas when they do appear.
 *     Measured across every confirmed star's observations on the target clip, the 5th
 *     percentile of area is one eighth of the single-frame median and the 1st percentile one
 *     thirty-sixth - so a quarter of the median (an earlier draft) would have amputated the
 *     faintest tenth of the star observations. A sixteenth keeps them while still refusing the
 *     1-3 px noise speckles minArea exists to stop.
 *   - apertureRadius: 2.5 equivalent radii captures essentially all of a Gaussian-ish PSF's flux
 *     (the blob's threshold radius understates its true extent); the sky annulus sits just
 *     outside it with the same 3 px standoff and 5 px width the defaults use, scaled up only
 *     when the aperture itself grows.
 *   - trackRadius: association must tolerate centroid jitter, which grows with blob size; three
 *     equivalent radii matches the default gate at the reference footage's blob scale.
 *   - cameraFixedMaxRawSpan: a stuck artifact's apparent excursion is centroid noise on a blob,
 *     so it too scales with blob size (3.5 radii ~ the default's 8 px at reference scale). The
 *     clamp keeps it far below the tens of pixels a hand-tracked target drifts.
 *
 * Pure and side-effect free: returns recommendations, applies nothing.
 *
 * @returns {{ok: boolean, count: number, medianArea?: number, rPsf?: number,
 *   minArea?: number, apertureRadius?: number, annulusInner?: number, annulusOuter?: number,
 *   trackRadius?: number, cameraFixedMaxRawSpan?: number}}
 */
export function calibrateDetection(rgba, W, H, opts = {}) {
    const O = {...STAR_DETECT_DEFAULTS, ...opts, minArea: 2};
    const {sources} = detectSources(rgba, W, H, O);
    const stars = sources.filter((s) => !rejectReason(s, O));
    // Below a handful of blobs the median is an anecdote, and applying it would replace a
    // suboptimal default with a confidently wrong measurement.
    if (stars.length < 5) return {ok: false, count: stars.length};

    const areas = stars.map((s) => s.area).sort((a, b) => a - b);
    const medianArea = areas[areas.length >> 1];
    const rPsf = Math.sqrt(medianArea / Math.PI);

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const apertureRadius = clamp(Math.ceil(2.5 * rPsf), 3, 20);
    return {
        ok: true,
        count: stars.length,
        medianArea,
        rPsf,
        minArea: clamp(Math.round(medianArea / 16), 2, 40),
        apertureRadius,
        annulusInner: apertureRadius + 3,
        annulusOuter: apertureRadius + 8,
        trackRadius: clamp(Math.round(3 * rPsf), 4, 16),
        cameraFixedMaxRawSpan: clamp(Math.round(3.5 * rPsf), 4, 16),
    };
}
