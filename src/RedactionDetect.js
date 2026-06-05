// ---------------------------------------------------------------------------
// Redaction-box detection (used by MotionAnalyzer.autoMaskRedactions()).
//
// Redaction boxes are solid black/grey rectangles painted over the footage. They
// are characterised by FOUR signals, all of which we require:
//   (1) low saturation ("grey": R≈G≈B) and not too bright (black .. mid-grey),
//   (2) spatially FLAT — a solid fill, so a pixel barely differs from its
//       neighbours. This is the key discriminator vs. real terrain, which is
//       textured even when it momentarily holds still (e.g. a slow/static camera).
//   (3) temporally INVARIANT — the box covers the moving scene, so it does not
//       change across a short window of frames (when ≥2 frames are available),
//   (4) RECTILINEAR — the connected region decomposes into a small number of
//       axis-aligned rectangles that cover most of it. Overlapping boxes (L/T
//       shapes) and a grey sidebar with embedded black boxes all satisfy this.
//
// Pipeline: per-pixel candidate test (1)+(2)+(3) -> morphological close (merge
// the thin grey/black tone boundaries inside a sidebar) -> open (despeckle) ->
// connected components -> per-component rectangle decomposition (4) -> expand +
// edge-snap.
//
// Deliberately has NO imports (pure JS, no OpenCV / DOM / Three) so it works
// with no dependency chain and is cheaply unit-testable. See
// tests/RedactionDetect.test.js.
// ---------------------------------------------------------------------------

// Rec.601 luma. r,g,b are 0..255.
export function _luma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

// 3x3 binary dilation: out[p]=1 iff any pixel in the (edge-clamped) 3x3
// neighbourhood is 1. src/dst are Uint8Array of width*height.
function _dilate3(src, dst, width, height) {
    for (let y = 0; y < height; y++) {
        const y0 = y > 0 ? y - 1 : 0;
        const y1 = y < height - 1 ? y + 1 : height - 1;
        for (let x = 0; x < width; x++) {
            const x0 = x > 0 ? x - 1 : 0;
            const x1 = x < width - 1 ? x + 1 : width - 1;
            let any = 0;
            for (let yy = y0; yy <= y1 && !any; yy++) {
                const row = yy * width;
                for (let xx = x0; xx <= x1; xx++) {
                    if (src[row + xx]) { any = 1; break; }
                }
            }
            dst[y * width + x] = any;
        }
    }
}

// 3x3 binary erosion: out[p]=1 iff the full (edge-clamped) 3x3 neighbourhood is
// 1. Clamping keeps solid regions that touch the frame edge (sidebars, letterbox
// bars) from being eaten away at the border.
function _erode3(src, dst, width, height) {
    for (let y = 0; y < height; y++) {
        const y0 = y > 0 ? y - 1 : 0;
        const y1 = y < height - 1 ? y + 1 : height - 1;
        for (let x = 0; x < width; x++) {
            const x0 = x > 0 ? x - 1 : 0;
            const x1 = x < width - 1 ? x + 1 : width - 1;
            let all = 1;
            for (let yy = y0; yy <= y1 && all; yy++) {
                const row = yy * width;
                for (let xx = x0; xx <= x1; xx++) {
                    if (!src[row + xx]) { all = 0; break; }
                }
            }
            dst[y * width + x] = all;
        }
    }
}

// Apply `iterations` passes of dilation (or erosion) without mutating `src`.
function _morphIterate(src, width, height, dilate, iterations) {
    if (iterations <= 0) return src;
    const N = width * height;
    let a = new Uint8Array(N);
    let b = new Uint8Array(N);
    const op = dilate ? _dilate3 : _erode3;
    op(src, a, width, height);
    for (let k = 1; k < iterations; k++) {
        op(a, b, width, height);
        const t = a; a = b; b = t;
    }
    return a;
}

// Iterative 8-connected component labelling. Returns {labels, components} where
// components[i] = {label, minX, minY, maxX, maxY, area}. `bin` is a Uint8Array.
function _connectedComponents(bin, width, height) {
    const labels = new Int32Array(width * height); // 0 = unlabelled
    const stack = new Int32Array(width * height);
    const components = [];

    for (let start = 0; start < bin.length; start++) {
        if (!bin[start] || labels[start]) continue;

        const label = components.length + 1;
        let sp = 0;
        stack[sp++] = start;
        labels[start] = label;

        let minX = width, minY = height, maxX = 0, maxY = 0, area = 0;

        while (sp > 0) {
            const p = stack[--sp];
            const px = p % width;
            const py = (p - px) / width;

            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            area++;

            const xLo = px > 0 ? px - 1 : 0;
            const xHi = px < width - 1 ? px + 1 : width - 1;
            const yLo = py > 0 ? py - 1 : 0;
            const yHi = py < height - 1 ? py + 1 : height - 1;
            for (let ny = yLo; ny <= yHi; ny++) {
                const row = ny * width;
                for (let nx = xLo; nx <= xHi; nx++) {
                    const q = row + nx;
                    if (bin[q] && !labels[q]) {
                        labels[q] = label;
                        stack[sp++] = q;
                    }
                }
            }
        }

        components.push({label, minX, minY, maxX, maxY, area});
    }

    return {labels, components};
}

// Decompose one labelled component into axis-aligned rectangles by merging
// vertically-stacked horizontal runs that share (within `tol` px) the same
// x-range. A solid box -> one rect; an L/T (overlapping boxes) -> a few rects
// that cover the shape exactly (without masking the empty notch); a grey sidebar
// with embedded black boxes -> one rect (both tones are foreground after close).
// Only rects with width AND height >= minSize are returned.
function _componentRects(labels, comp, width, minSize) {
    const {label, minX, minY, maxX, maxY} = comp;
    const tol = 2;
    const out = [];
    let active = []; // rects still being extended downward: {x0, x1, y0}

    const closeRect = (a, yEnd) => {
        const w = a.x1 - a.x0 + 1;
        const h = yEnd - a.y0 + 1;
        if (w >= minSize && h >= minSize) out.push({x: a.x0, y: a.y0, w, h});
    };

    for (let y = minY; y <= maxY; y++) {
        // Maximal horizontal runs of this label on row y.
        const runs = [];
        let x = minX;
        const row = y * width;
        while (x <= maxX) {
            if (labels[row + x] === label) {
                const x0 = x;
                while (x <= maxX && labels[row + x] === label) x++;
                runs.push([x0, x - 1]);
            } else {
                x++;
            }
        }

        const used = new Array(runs.length).fill(false);
        const next = [];
        for (const a of active) {
            let matched = -1;
            for (let i = 0; i < runs.length; i++) {
                if (!used[i] && Math.abs(runs[i][0] - a.x0) <= tol && Math.abs(runs[i][1] - a.x1) <= tol) {
                    matched = i;
                    break;
                }
            }
            if (matched >= 0) {
                used[matched] = true;
                next.push(a); // keep original x-range; tolerate minor raggedness
            } else {
                closeRect(a, y - 1);
            }
        }
        for (let i = 0; i < runs.length; i++) {
            if (!used[i]) next.push({x0: runs[i][0], x1: runs[i][1], y0: y});
        }
        active = next;
    }
    for (const a of active) closeRect(a, maxY);

    return out;
}

// Detect redaction rectangles. `frames` is an array of ImageData-like objects
// ({data, width, height}), all width x height. Returns an array of {x, y, w, h}
// in pixel coords, already expanded by opts.spread, edge-snapped, and clamped to
// bounds.
//
// opts:
//   invariance   max % luminance change across the window to count as invariant
//   maxLuma      ignore pixels brighter than this (keep black..mid-grey)
//   colorSpread  max RGB channel spread to count as "grey"
//   flatness     max local luminance variation to count as a flat solid fill
//   minSize      min rectangle width AND height (px)
//   fill         min fraction of a component its rectangles must cover
//   spread       expand each rectangle by this many px
//   edgeSnap     if an expanded edge lands within this fraction of the frame
//                size from the border, snap it to the border (avoids slivers)
export function detectRedactionRects(frames, width, height, opts) {
    const {
        invariance = 5,
        maxLuma = 180,
        colorSpread = 24,
        flatness = 10,
        minSize = 12,
        fill = 0.6,
        spread = 3,
        edgeSnap = 0.05,
    } = opts || {};

    // Require temporal evidence: with <2 frames there is no way to tell an
    // invariant redaction from a momentarily-still patch of real footage.
    if (!frames || frames.length < 2) return [];

    const N = width * height;
    const nFrames = frames.length;
    const tempThresh = (invariance / 100) * 255; // allowed luma range across frames
    const base = frames[0].data;

    // Precompute base-frame luma once (used by both flatness and invariance).
    const luma = new Float32Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 4) {
        luma[p] = _luma(base[i], base[i + 1], base[i + 2]);
    }

    const candidate = new Uint8Array(N);
    const r = 2; // flatness sample radius

    for (let y = 0; y < height; y++) {
        // Edge-clamped neighbour rows for the flatness test.
        const yu = y - r >= 0 ? y - r : 0;
        const yd = y + r < height ? y + r : height - 1;
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const i = p * 4;
            const r0 = base[i], g0 = base[i + 1], b0 = base[i + 2];

            // (1) low saturation ("grey") and not too bright.
            const mx = r0 > g0 ? (r0 > b0 ? r0 : b0) : (g0 > b0 ? g0 : b0);
            const mn = r0 < g0 ? (r0 < b0 ? r0 : b0) : (g0 < b0 ? g0 : b0);
            if (mx - mn > colorSpread) continue;
            const lp = luma[p];
            if (lp > maxLuma) continue;

            // (2) spatially flat: small luma difference to neighbours at radius r
            // (edge-clamped, so box pixels touching the frame border still count).
            const xl = x - r >= 0 ? x - r : 0;
            const xr = x + r < width ? x + r : width - 1;
            if (Math.abs(lp - luma[y * width + xl]) > flatness) continue;
            if (Math.abs(lp - luma[y * width + xr]) > flatness) continue;
            if (Math.abs(lp - luma[yu * width + x]) > flatness) continue;
            if (Math.abs(lp - luma[yd * width + x]) > flatness) continue;

            // (3) temporally invariant: luma range across the window is small.
            let lo = lp, hi = lp, invariant = true;
            for (let f = 1; f < nFrames; f++) {
                const d = frames[f].data;
                const lum = _luma(d[i], d[i + 1], d[i + 2]);
                if (lum < lo) lo = lum;
                if (lum > hi) hi = lum;
                if (hi - lo > tempThresh) { invariant = false; break; }
            }
            if (invariant) candidate[p] = 1;
        }
    }

    // Close (bridge the thin non-flat boundary lines between a grey sidebar and
    // its embedded black boxes so they form one solid component), then open
    // (drop single-pixel speckle). Solid boxes survive both.
    const closed = _morphIterate(candidate, width, height, true, 2);   // dilate x2
    const closedE = _morphIterate(closed, width, height, false, 2);    // erode x2
    const openedE = _morphIterate(closedE, width, height, false, 1);   // erode x1
    const cleaned = _morphIterate(openedE, width, height, true, 1);    // dilate x1

    const {labels, components} = _connectedComponents(cleaned, width, height);

    const snapX = edgeSnap * width;
    const snapY = edgeSnap * height;
    const rects = [];
    for (const c of components) {
        const w = c.maxX - c.minX + 1;
        const h = c.maxY - c.minY + 1;
        if (w < minSize || h < minSize) continue;
        if (w * h > N * 0.98) continue; // don't mask essentially the whole frame

        // (4) rectilinear: decompose into axis-aligned rectangles and require they
        // cover at least `fill` of the component. Real terrain blobs decompose into
        // many sub-minSize slivers and fail this; boxes/sidebars/L-shapes pass.
        const subRects = _componentRects(labels, c, width, minSize);
        let covered = 0;
        for (const sr of subRects) covered += sr.w * sr.h;
        if (covered < fill * c.area) continue;

        for (const sr of subRects) {
            let x0 = Math.max(0, sr.x - spread);
            let y0 = Math.max(0, sr.y - spread);
            let x1 = Math.min(width, sr.x + sr.w + spread);
            let y1 = Math.min(height, sr.y + sr.h + spread);

            // Snap edges that land within `edgeSnap` of the frame border to the
            // border, so a near-edge redaction does not leave a thin unmasked
            // sliver (horizontal edges use the frame width, vertical the height).
            if (x0 <= snapX) x0 = 0;
            if (x1 >= width - snapX) x1 = width;
            if (y0 <= snapY) y0 = 0;
            if (y1 >= height - snapY) y1 = height;

            rects.push({x: x0, y: y0, w: x1 - x0, h: y1 - y0});
        }
    }

    return rects;
}
