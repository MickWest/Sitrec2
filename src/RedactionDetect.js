// ---------------------------------------------------------------------------
// Redaction-box detection (used by MotionAnalyzer.autoMaskRedactions()).
//
// Redaction boxes are solid rectangles painted over the footage to hide content.
// They are detected by TWO primary signals — COLOUR IS DELIBERATELY IGNORED so a
// box of ANY colour (black, grey, white-ish, thermal palette, …) is caught:
//   (1) temporally INVARIANT — the box covers the moving scene, so its pixels do
//       not change across a short decoded-frame window (the primary discriminator),
//   (2) spatially FLAT — a solid fill, so a pixel barely differs from its
//       neighbours. This rejects textured terrain in the static-camera case, where
//       the terrain is momentarily invariant too.
// A brightness ceiling (maxLuma) is kept as a guard against flat, invariant bright
// sky; it is the only remaining colour-ish test.
//
// The hard part is the thin, NON-FLAT TRANSITION SEAMS: where two adjacent boxes
// meet (e.g. black next to grey) or a box's anti-aliased edge meets the footage,
// the boundary is neither flat nor a clean candidate, so it is left UNMASKED — a
// sliver that leaks redaction pixels into panos. We cannot just grow/close the
// whole candidate mask to fill these: in a near-static window a large fraction of
// the TERRAIN is also invariant, so any global dilation bridges a real box to an
// invariant-terrain blob; the merged shape is no longer rectangular, the
// rectangularity filter then REJECTS it, and the real box is deleted with it.
//
// So bridging is done in TWO passes:
//   Pass 1  classify the confident redaction MASSES: flat+invariant seed pixels ->
//           connected components -> keep only the large, rectangular ones. This is
//           the step that EXCLUDES textured-terrain blobs.
//   Pass 2  bridge ONLY between those qualified masses: grow them (gated to seed/
//           qualified pixels, so growth never enters footage) and close across the
//           non-flat seam. Because terrain was excluded in Pass 1, bridging can
//           never connect a box to terrain — which is what makes it safe.
// The bridged masses are decomposed into axis-aligned rectangles; nearby parallel
// rect edges that overlap are then snapped together (closing any residual rect
// sliver), and finally each rect is expanded by `spread` and frame-edge-snapped.
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

// Keep only the components that look like a redaction MASS: width AND height
// >= minSize, not essentially the whole frame, and whose axis-aligned rectangle
// decomposition covers at least `fill` of the component's area. Real terrain
// blobs decompose into many sub-minSize slivers and fail the coverage test; solid
// boxes, sidebars and L/T shapes pass. Returns [{comp, subRects}].
function _qualifyComponents(labels, components, width, minSize, fill, N) {
    const out = [];
    for (const c of components) {
        const w = c.maxX - c.minX + 1;
        const h = c.maxY - c.minY + 1;
        if (w < minSize || h < minSize) continue;
        if (w * h > N * 0.98) continue; // don't mask essentially the whole frame
        const subRects = _componentRects(labels, c, width, minSize);
        let covered = 0;
        for (const sr of subRects) covered += sr.w * sr.h;
        if (covered < fill * c.area) continue;
        out.push({comp: c, subRects});
    }
    return out;
}

// Rectangle edge-snap: close the thin slivers BETWEEN detected boxes. When two
// boxes have nearby parallel edges (a small gap) and overlap along those edges,
// BOTH edges are snapped to meet — each box is extended across the gap, so the
// sliver is covered from both sides (covering both is what fills it across the
// union of their extents). Iterated to a fixed point. `snapDist` is the max gap
// (px) to bridge; `minOverlap` the min overlap (px) along the edges, so boxes that
// merely clip a corner are not joined. Mutates and returns `rects`.
function _snapRects(rects, snapDist, minOverlap) {
    if (snapDist <= 0) return rects;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 50) {
        changed = false;
        for (let i = 0; i < rects.length; i++) {
            for (let j = 0; j < rects.length; j++) {
                if (i === j) continue;
                const A = rects[i], B = rects[j];
                const ax1 = A.x + A.w, ay1 = A.y + A.h;
                const bx1 = B.x + B.w, by1 = B.y + B.h;

                // A directly above B: snap A's bottom and B's top to each other.
                const ox = Math.min(ax1, bx1) - Math.max(A.x, B.x);
                if (ox > minOverlap) {
                    const gap = B.y - ay1;
                    if (gap > 0 && gap <= snapDist) {
                        A.h = B.y - A.y;              // A bottom -> B top
                        B.h = by1 - ay1; B.y = ay1;   // B top -> A's old bottom
                        changed = true;
                        continue;
                    }
                }
                // A directly left of B: snap A's right and B's left to each other.
                const oy = Math.min(ay1, by1) - Math.max(A.y, B.y);
                if (oy > minOverlap) {
                    const gap = B.x - ax1;
                    if (gap > 0 && gap <= snapDist) {
                        A.w = B.x - A.x;              // A right -> B left
                        B.w = bx1 - ax1; B.x = ax1;   // B left -> A's old right
                        changed = true;
                        continue;
                    }
                }
            }
        }
    }
    return rects;
}

// Detect redaction rectangles. `frames` is an array of ImageData-like objects
// ({data, width, height}), all width x height. Returns an array of {x, y, w, h}
// in pixel coords, already bridged, edge-snapped, expanded by opts.spread and
// clamped to bounds. See the file header for the two-pass design.
//
// opts:
//   invariance   max % luminance change across the window to count as invariant
//   maxLuma      ignore pixels brighter than this (bright-sky guard)
//   flatness     max local luminance variation to count as a flat solid fill
//   minSize      min rectangle width AND height (px)
//   fill         min fraction of a component its rectangles must cover
//   spread       expand each rectangle by this many px
//   snap         max sliver width (px) to bridge between adjacent boxes (0 = off)
//   edgeSnap     if an expanded edge lands within this fraction of the frame
//                size from the border, snap it to the border (avoids slivers)
export function detectRedactionRects(frames, width, height, opts) {
    const {
        invariance = 5,
        maxLuma = 180,
        flatness = 10,
        minSize = 12,
        fill = 0.6,
        spread = 3,
        snap = 6,
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

    // Seed = not-too-bright AND spatially flat AND temporally invariant. Colour /
    // saturation is intentionally NOT tested, so a box of any colour qualifies.
    // Flatness is checked before invariance because it is cheap and rejects most
    // textured pixels early.
    const seed = new Uint8Array(N);
    const r = 2; // flatness sample radius

    for (let y = 0; y < height; y++) {
        // Edge-clamped neighbour rows for the flatness test.
        const yu = y - r >= 0 ? y - r : 0;
        const yd = y + r < height ? y + r : height - 1;
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
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

            // (1) temporally invariant: luma range across the window is small.
            const i = p * 4;
            let lo = lp, hi = lp, invariant = true;
            for (let f = 1; f < nFrames; f++) {
                const d = frames[f].data;
                const lum = _luma(d[i], d[i + 1], d[i + 2]);
                if (lum < lo) lo = lum;
                if (lum > hi) hi = lum;
                if (hi - lo > tempThresh) { invariant = false; break; }
            }
            if (invariant) seed[p] = 1;
        }
    }

    // Despeckle the seed (drop single-pixel noise): erode x1 then dilate x1.
    const opened = _morphIterate(_morphIterate(seed, width, height, false, 1), width, height, true, 1);

    // PASS 1: classify the confident redaction masses (this excludes terrain blobs).
    const cc1 = _connectedComponents(opened, width, height);
    const qualified = new Uint8Array(N);
    for (const {comp} of _qualifyComponents(cc1.labels, cc1.components, width, minSize, fill, N)) {
        for (let y = comp.minY; y <= comp.maxY; y++) {
            const row = y * width;
            for (let x = comp.minX; x <= comp.maxX; x++) {
                if (cc1.labels[row + x] === comp.label) qualified[row + x] = 1;
            }
        }
    }

    // PASS 2: bridge the non-flat seams ONLY between qualified masses. Grow the
    // qualified mask gated to seed/qualified pixels (so growth never enters moving
    // footage), then a second dilation spans the non-flat seam, then erode back.
    // Terrain was removed in Pass 1, so this can never connect a box to terrain.
    let bridged = qualified;
    if (snap > 0) {
        const B = Math.max(1, Math.round(snap / 2));
        let q = _morphIterate(qualified, width, height, true, B);   // dilate B
        for (let p = 0; p < N; p++) q[p] = (q[p] && (seed[p] || qualified[p])) ? 1 : 0;
        q = _morphIterate(q, width, height, true, B);               // dilate B (spans the seam)
        q = _morphIterate(q, width, height, false, 2 * B);          // erode 2B back
        for (let p = 0; p < N; p++) if (qualified[p]) q[p] = 1;     // never lose a qualified pixel
        bridged = q;
    }

    // Decompose the bridged masses into axis-aligned rectangles.
    const cc2 = _connectedComponents(bridged, width, height);
    let rects = [];
    for (const {subRects} of _qualifyComponents(cc2.labels, cc2.components, width, minSize, fill, N)) {
        for (const sr of subRects) rects.push({x: sr.x, y: sr.y, w: sr.w, h: sr.h});
    }

    // Snap nearby parallel rect edges together (closes any residual sliver between
    // detected boxes), then expand + frame-edge-snap.
    rects = _snapRects(rects, snap, 2);

    const snapX = edgeSnap * width;
    const snapY = edgeSnap * height;
    const out = [];
    for (const sr of rects) {
        let x0 = Math.max(0, sr.x - spread);
        let y0 = Math.max(0, sr.y - spread);
        let x1 = Math.min(width, sr.x + sr.w + spread);
        let y1 = Math.min(height, sr.y + sr.h + spread);

        // Snap edges that land within `edgeSnap` of the frame border to the
        // border, so a near-edge redaction does not leave a thin unmasked sliver
        // (horizontal edges use the frame width, vertical the height).
        if (x0 <= snapX) x0 = 0;
        if (x1 >= width - snapX) x1 = width;
        if (y0 <= snapY) y0 = 0;
        if (y1 >= height - snapY) y1 = height;

        out.push({x: x0, y: y0, w: x1 - x0, h: y1 - y0});
    }

    return out;
}
