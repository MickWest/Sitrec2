// Star trails: turn a timelapse STACK (one image, every star drawn as an arc) into point stars.
//
// A fixed camera stacking its exposures sees each star sweep an arc about the celestial pole's
// image. The Star Tracker's detector looks for points, and on such an image it finds only the
// trails' fragments, elongated and rejected. But each trail holds two exact star positions - where
// the star was when the stack STARTED and where it was when it ENDED - and the arcs share one
// centre of rotation, which is what tells the two ends apart. So:
//
//   1. threshold the image against a local sky model, and label the connected pieces;
//   2. find the centre of rotation as the point every elongated piece's NORMAL passes closest to
//      (robustly - satellites and aircraft cross the arcs at angles and must not vote);
//   3. link pieces that lie on one circle about that centre, closing the gaps a dotted trail has;
//   4. measure each trail's two ends at the half-brightness point of its profile along the arc,
//      which is where the true end lies whatever the star's brightness;
//   5. order the ends by the sense of rotation: the sky turns counterclockwise about the north
//      pole as seen looking at it, clockwise about the south, so a trail ENDS at its
//      counterclockwise end round the north pole.
//
// On a wide lens the arcs are not exactly circles about one point - a diurnal circle's image is
// only circular when the pole sits on the optical axis - so the centre is an approximation used
// for ORDERING and LINKING, both of which tolerate a few pixels. The ends themselves are measured
// on the image, not on the circle.
//
// Pure: plain arrays in, plain objects out. No DOM, no THREE, no Sitrec globals.

import {backgroundAt, estimateBackground, gaussianBlur, lumaFromRGBA} from "./StarDetect";

export const STAR_TRAIL_DEFAULTS = {
    smoothSigma: 1.0,       // px: matched filter for a ~2 px wide trail (detection only)
    threshSigma: 3.0,       // detection threshold, in the smoothed plane's own noise sigma
    minArea: 4,             // px: smallest thresholded piece kept (centre pass)
    minRidgeArea: 2,        // px: smallest ridge piece kept (trail pass)
    minSegmentLength: 8,    // px: a piece shorter than this has no usable direction for the centre
    minElongation: 2.5,     // major/minor axis ratio for a piece to vote on the centre
    tangentTolDeg: 20,      // a piece more than this off the tangent of its circle is not a star
    linkRadialTol: 2.5,     // px: radial mismatch allowed between two pieces of one trail
    linkGapPx: 16,          // px: longest gap along the arc bridged between pieces of one trail
    minTrailLength: 8,      // px: shorter linked trails are dropped (unless near the centre)
    profileHalfWidth: 2,    // px: the profile sums this far either side of the trail's centreline
    profileStep: 0.5,       // px: profile sampling step along the arc
    minSnr: 8,              // trails below this significance are dropped as noise
    maxSpanFactor: 1.15,    // a linked trail may span at most this x the typical star's turn
};

/**
 * Extract star trails from an RGBA image.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} W
 * @param {number} H
 * @param {object} opts STAR_TRAIL_DEFAULTS overrides, plus:
 *   sense: -1 when the stars turn counterclockwise on screen (the north pole's image, the usual
 *          northern-hemisphere case), +1 when clockwise (the south pole's). Default -1.
 *   isMasked(x, y): optional predicate; pieces whose centroid it masks are dropped.
 * @returns {{centre:number[]|null, trails:Array, points:Array, spanRad:number|null,
 *            stats:object, reason?:string}}
 */
export function extractStarTrails(rgba, W, H, opts = {}) {
    const O = {...STAR_TRAIL_DEFAULTS, ...opts};
    const sense = opts.sense === 1 ? 1 : -1;
    const L = lumaFromRGBA(rgba, W, H);
    const model = estimateBackground(L, W, H);

    // Background-subtracted signal, and its noise-normalised twin for detection.
    const S = new Float32Array(W * H);
    const Z = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const b = backgroundAt(model, model.bg, x, y);
            const sg = backgroundAt(model, model.sigma, x, y);
            S[i] = L[i] - b;
            Z[i] = S[i] / Math.max(sg, 0.5);
        }
    }
    const Zs = gaussianBlur(Z, W, H, O.smoothSigma);
    // Smoothing lowers the noise by a factor that depends on how correlated it was (JPEG noise
    // is), so the threshold is set against the smoothed plane's OWN robust sigma.
    const sigmaS = robustSigma(Zs, W * H);
    const thresh = O.threshSigma * sigmaS;

    const timing = {};
    let tic = Date.now();
    const lap = (name) => { const now = Date.now(); timing[name] = now - tic; tic = now; };
    lap("prepare");

    // Pass 1: every piece above threshold, for the centre. Pieces that merged with a crossing
    // satellite or aircraft trail point the wrong way and are voted down by the robust fit.
    const unmasked = (list) => (opts.isMasked ? list.filter((p) => !opts.isMasked(p.cx, p.cy)) : list);
    const pass1 = unmasked(labelPieces(Zs, S, W, H, (i) => Zs[i] > thresh, O.minArea));
    lap("label1");
    const centreFit = fitRotationCentre(pass1, O);
    lap("centre");
    if (!centreFit) {
        return {centre: null, trails: [], points: [], spanRad: null,
            stats: {pieces: pass1.length, timing}, reason: "no centre of rotation: too few trail pieces"};
    }
    const C = centreFit.centre;

    // Pass 2: trail RIDGES. A pixel is kept only where it is a maximum across its circle (no
    // dimmer than the pixels one step in and out along the radius), and where the image's local
    // line direction runs ALONG that circle - or where it has no clear direction (a dot, a
    // trail's rounded end). Ridges keep two parallel trails a few pixels apart from touching,
    // which a plain threshold does not once one of them is bright; and the direction test cuts
    // each crossing satellite or aircraft line out of the trail it touches, instead of losing
    // the trail with it. The trail's small gap there is bridged by linking.
    const ridge = ridgeMask(Zs, W, H, C, thresh, O);
    lap("ridge");
    const kept = unmasked(labelPieces(Zs, S, W, H, (i) => ridge[i] === 1, O.minRidgeArea));
    lap("label2");

    // Polar description of every piece about the centre.
    const tanTol = Math.sin(O.tangentTolDeg * Math.PI / 180);
    const polar = [];
    for (const p of kept) {
        const pp = polarPiece(p, C);
        // A piece that is clearly a SEGMENT must lie along its circle; one too short to have a
        // direction (a dot of a dotted trail, or a star near the pole) may still join a trail.
        const radialDir = [(p.cx - C[0]) / pp.r, (p.cy - C[1]) / pp.r];
        const along = Math.abs(p.ux * radialDir[0] + p.uy * radialDir[1]);
        if (p.length >= O.minSegmentLength && p.elongation >= O.minElongation && along > tanTol) continue;
        polar.push(pp);
    }

    lap("polar");
    // The noise of one profile sample (a cross-trail sum), measured on the image itself at
    // random places and orientations: most of the frame is sky, and a robust sigma ignores the
    // trails it happens to land on.
    const profileSigma = measureProfileSigma(S, W, H, O);
    const measureAll = (groups) => {
        const out = [];
        for (const g of groups) {
            const t = measureTrail(g, C, S, W, H, O, sense);
            if (!t) continue;
            // Significance of the plateau: a median over about lengthPx/2 independent samples.
            t.snr = t.plateau * Math.sqrt(Math.max(1, t.lengthPx / 2)) / (1.25 * profileSigma);
            out.push(t);
        }
        return out;
    };
    // Linking runs twice. Stars at the same declination share a circle, so a trail can sit a few
    // pixels of arc from the next star's, and noise dots can bridge them. The first pass bridges
    // only small gaps, to MEASURE how far one star turns during the stack; the second bridges the
    // full gap but refuses any chain spanning clearly more than that.
    const firstPass = measureAll(linkPieces(polar, {...O, linkGapPx: Math.min(O.linkGapPx, 5)}));
    const firstSpans = firstPass.filter((t) => t.lengthPx >= 2 * O.minTrailLength && t.snr >= O.minSnr)
        .map((t) => t.spanRad);
    const maxSpanRad = firstSpans.length >= 5 ? O.maxSpanFactor * median(firstSpans) : Infinity;
    const groups = linkPieces(polar, O, maxSpanRad);
    lap("link");
    const trails = measureAll(groups).filter((t) => t.snr >= O.minSnr);
    lap("measure");
    // Intermediate stages, for diagnosis only.
    if (opts.debug) Object.assign(opts.debug, {pass1, kept, polar, groups, trailsAll: trails, S, C});

    // The typical angular span of a COMPLETE trail: the median of the long ones, since short ones
    // include trails cut by the frame edge or the skyline. Then the trails near the centre - too
    // close for their arc to be measured - are taken as points.
    const spans = trails.filter((t) => t.lengthPx >= 2 * O.minTrailLength).map((t) => t.spanRad);
    const spanRad = spans.length ? median(spans) : null;
    const out = [];
    const points = [];
    for (const t of trails) {
        const nearCentre = spanRad !== null && t.r * spanRad < O.minTrailLength;
        if (t.lengthPx >= O.minTrailLength) {
            t.completeness = spanRad ? t.spanRad / spanRad : null;
            out.push(t);
        } else if (nearCentre) {
            points.push({x: t.mid[0], y: t.mid[1], r: t.r, flux: t.flux, totalFlux: t.totalFlux,
                peakSNR: t.peakSNR, snr: t.snr});
        }
    }
    return {
        centre: C,
        centreRms: centreFit.rms,
        trails: out,
        points,
        spanRad,
        stats: {pieces: kept.length, centreVotes: centreFit.n, linked: groups.length,
            noiseSigma: sigmaS, profileSigma, timing},
    };
}

function median(a) {
    const s = [...a].sort((x, y) => x - y);
    const n = s.length;
    return n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** Robust sigma (1.4826 x MAD) of a plane, on a sparse lattice - it only sets a threshold. */
function robustSigma(P, n) {
    const step = Math.max(1, Math.floor(n / 200000));
    const v = [];
    for (let i = 0; i < n; i += step) v.push(P[i]);
    const m = median(v);
    for (let i = 0; i < v.length; i++) v[i] = Math.abs(v[i] - m);
    return Math.max(1e-6, 1.4826 * median(v));
}

/**
 * Pixels above threshold whose local line direction is tangential about C, as a 0/1 plane.
 *
 * The direction comes from the structure tensor (the smoothed outer product of the gradient):
 * across a thin line the gradient points along the normal, so the tensor's dominant eigenvector
 * is the line's normal. Where the tensor is nearly isotropic - a dot, a blob, the very end of a
 * trail - there is no direction to test and the pixel is kept.
 */
function ridgeMask(Zs, W, H, C, thresh, O) {
    const N = W * H;
    const jxx = new Float32Array(N), jyy = new Float32Array(N), jxy = new Float32Array(N);
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const gx = 0.5 * (Zs[i + 1] - Zs[i - 1]);
            const gy = 0.5 * (Zs[i + W] - Zs[i - W]);
            jxx[i] = gx * gx; jyy[i] = gy * gy; jxy[i] = gx * gy;
        }
    }
    const sxx = gaussianBlur(jxx, W, H, 1.5), syy = gaussianBlur(jyy, W, H, 1.5);
    const sxy = gaussianBlur(jxy, W, H, 1.5);
    const cosTol = Math.cos(O.tangentTolDeg * Math.PI / 180);
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
        if (!(Zs[i] > thresh)) continue;
        const a = sxx[i], c = syy[i], b = sxy[i];
        const tr = a + c;
        const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) / 4 + b * b));
        // Coherence: 0 isotropic, 1 a perfect line.
        const coherence = tr > 1e-12 ? 2 * disc / tr : 0;
        const x = i % W, y = (i - x) / W;
        const rx = x - C[0], ry = y - C[1];
        const r = Math.hypot(rx, ry);
        if (r < 3) { out[i] = 1; continue; }
        // A ridge across the circle: no dimmer than one step in or out along the radius.
        const ux = rx / r, uy = ry / r;
        const zi = Zs[i];
        if (sample(Zs, W, H, x + ux, y + uy) > zi || sample(Zs, W, H, x - ux, y - uy) > zi) continue;
        if (coherence < 0.4) { out[i] = 1; continue; }
        // Dominant eigenvector = the line's NORMAL; the line runs perpendicular to it.
        const ang = 0.5 * Math.atan2(2 * b, a - c);
        const lx = -Math.sin(ang), ly = Math.cos(ang);
        // Tangent about C is perpendicular to the radius.
        const tx = -ry / r, ty = rx / r;
        if (Math.abs(lx * tx + ly * ty) >= cosTol) out[i] = 1;
    }
    return out;
}

/**
 * Connected pieces of a pixel predicate (8-connected), each with its signal-weighted
 * centroid, principal axis, length along it, elongation, flux and pixel list.
 */
function labelPieces(Zs, S, W, H, keep, minArea) {
    const label = new Int32Array(W * H);
    const pieces = [];
    const stack = [];
    let next = 1;
    for (let start = 0; start < W * H; start++) {
        if (label[start] || !keep(start)) continue;
        const px = [];
        label[start] = next;
        stack.push(start);
        while (stack.length) {
            const i = stack.pop();
            px.push(i);
            const x = i % W, y = (i - x) / W;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= H) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= W || (dx === 0 && dy === 0)) continue;
                    const j = yy * W + xx;
                    if (!label[j] && keep(j)) { label[j] = next; stack.push(j); }
                }
            }
        }
        next++;
        if (px.length < minArea) continue;
        pieces.push(describePiece(px, S, W, Zs));
    }
    return pieces;
}

/** Signal-weighted centroid, principal axis, length, elongation, flux and peak of a pixel set. */
function describePiece(px, S, W, Zs) {
    {
        let sw = 0, sx = 0, sy = 0, flux = 0, peak = 0;
        for (const i of px) {
            const w = Math.max(S[i], 0) + 1e-3;
            const x = i % W, y = (i - x) / W;
            sw += w; sx += w * x; sy += w * y;
            flux += Math.max(S[i], 0);
            const z = Zs ? Zs[i] : S[i];
            if (z > peak) peak = z;
        }
        const cx = sx / sw, cy = sy / sw;
        let sxx = 0, syy = 0, sxy = 0;
        for (const i of px) {
            const w = Math.max(S[i], 0) + 1e-3;
            const x = i % W - cx, y = (i - (i % W)) / W - cy;
            sxx += w * x * x; syy += w * y * y; sxy += w * x * y;
        }
        sxx /= sw; syy /= sw; sxy /= sw;
        const tr = sxx + syy, det = sxx * syy - sxy * sxy;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        const ux = Math.cos(ang), uy = Math.sin(ang);
        let tMin = Infinity, tMax = -Infinity;
        for (const i of px) {
            const x = i % W - cx, y = (i - (i % W)) / W - cy;
            const t = x * ux + y * uy;
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
        }
        return {cx, cy, ux, uy, length: tMax - tMin + 1, elongation: Math.sqrt(l1 / l2),
            flux, peak, px, W};
    }
}

/**
 * The centre of rotation: the point every elongated piece's NORMAL passes closest to. A piece
 * at c with direction u constrains the centre C by (C - c) . u = 0, to within its direction
 * error - about its width over its length, which at distance d from the centre is a miss of
 * d * 2 / length. Residuals are judged in those units.
 *
 * Started robustly, because the pieces that do NOT belong - a long satellite or aircraft line,
 * fragments merged with one - are few but can be long, and one long wrong piece drags a plain
 * least-squares start far enough that reweighting never recovers. So the start is the best of
 * the pairwise intersections of the longest pieces' normals, scored by how many pieces agree
 * with it; then iteratively reweighted least squares (Cauchy) refines it.
 */
function fitRotationCentre(pieces, O) {
    const segs = pieces.filter((p) => p.length >= O.minSegmentLength && p.elongation >= O.minElongation);
    if (segs.length < 6) return null;
    const scaledResidual = (C, p) => {
        const dist = Math.hypot(C[0] - p.cx, C[1] - p.cy);
        return ((C[0] - p.cx) * p.ux + (C[1] - p.cy) * p.uy) / (1 + dist * 2 / p.length);
    };
    // Score on a bounded, evenly spread subset - the score only has to rank candidates.
    const step = Math.max(1, Math.floor(segs.length / 400));
    const scoreSet = segs.filter((_, k) => k % step === 0);
    const score = (C) => {
        let sc = 0;
        for (const p of scoreSet) { const z = scaledResidual(C, p) / 2; sc += 1 / (1 + z * z); }
        return sc;
    };
    const longest = [...segs].sort((a, b) => b.length - a.length).slice(0, 60);
    const minSin = Math.sin(5 * Math.PI / 180);
    let C = null, best = -1;
    for (let i = 0; i < longest.length; i++) {
        const a = longest[i];
        for (let j = i + 1; j < longest.length; j++) {
            const b = longest[j];
            const det = a.ux * b.uy - a.uy * b.ux;
            if (Math.abs(det) < minSin) continue;
            const da = a.ux * a.cx + a.uy * a.cy, db = b.ux * b.cx + b.uy * b.cy;
            const cand = [(da * b.uy - db * a.uy) / det, (a.ux * db - b.ux * da) / det];
            const sc = score(cand);
            if (sc > best) { best = sc; C = cand; }
        }
    }
    if (!C) return null;

    let rms = Infinity;
    for (let it = 0; it < 20; it++) {
        let a = 0, b = 0, c = 0, r0 = 0, r1 = 0;
        for (const p of segs) {
            const z = scaledResidual(C, p) / 2.5;
            const dist = Math.hypot(C[0] - p.cx, C[1] - p.cy);
            const sigma = 1 + dist * 2 / p.length;
            const wk = 1 / ((1 + z * z) * sigma * sigma);
            a += wk * p.ux * p.ux; b += wk * p.ux * p.uy; c += wk * p.uy * p.uy;
            const d = p.ux * p.cx + p.uy * p.cy;
            r0 += wk * p.ux * d; r1 += wk * p.uy * d;
        }
        const det = a * c - b * b;
        if (!(Math.abs(det) > 1e-12)) break;
        const Cn = [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
        const moved = Math.hypot(Cn[0] - C[0], Cn[1] - C[1]);
        C = Cn;
        if (moved < 1e-3) break;
    }
    let s2 = 0, n = 0;
    for (const p of segs) {
        const z = scaledResidual(C, p);
        if (Math.abs(z) < 5) { s2 += z * z; n++; }
    }
    rms = n ? Math.sqrt(s2 / n) : Infinity;
    return {centre: C, rms, n: segs.length, agreeing: n};
}

function wrapAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

/** A piece in polar form about C: angle range, radius, and a linear r(phi) for its ends. */
function polarPiece(p, C) {
    const W = p.W;
    const phiC = Math.atan2(p.cy - C[1], p.cx - C[0]);
    let dMin = Infinity, dMax = -Infinity, sr = 0, sw = 0, sd = 0, sdd = 0, sdr = 0;
    for (const i of p.px) {
        const x = i % W, y = (i - x) / W;
        const r = Math.hypot(x - C[0], y - C[1]);
        const d = wrapAngle(Math.atan2(y - C[1], x - C[0]) - phiC);
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
        sr += r; sw++; sd += d; sdd += d * d; sdr += d * r;
    }
    const rMean = sr / sw, dMean = sd / sw;
    const varD = sdd / sw - dMean * dMean;
    const slope = varD > 1e-12 ? (sdr / sw - dMean * rMean) / varD : 0;
    const rAt = (d) => rMean + slope * (d - dMean);
    return {piece: p, phiC, r: Math.hypot(p.cx - C[0], p.cy - C[1]), dMin, dMax,
        rMin: rAt(dMin), rMax: rAt(dMax)};
}

/**
 * Link pieces that lie on one circle into trails. A trail's ridge pieces follow one another
 * along the arc, so pieces join END TO END only: the end of one at the start of the next,
 * within linkGapPx of arc and with their radii agreeing there. Each end takes at most one
 * partner - the best by gap and radial mismatch - so a trail is a chain, never a tree; a union of
 * every compatible pair would drift across the neighbouring circles of a crowded field, a couple
 * of pixels per link. Pieces that OVERLAP in angle are parallel trails, not one.
 */
function linkPieces(polar, O, maxSpanRad = Infinity) {
    const n = polar.length;
    const order = polar.map((_, i) => i).sort((a, b) => polar[a].r - polar[b].r);
    const cands = [];
    for (let a = 0; a < n; a++) {
        const A = polar[order[a]];
        for (let b = a + 1; b < n; b++) {
            const B = polar[order[b]];
            if (B.r - A.r > O.linkRadialTol + O.linkGapPx + 0.5 * (A.piece.length + B.piece.length)) break;
            for (const [P, Q, ip, iq] of [[A, B, order[a], order[b]], [B, A, order[b], order[a]]]) {
                // Q follows P: Q's low end against P's high end, in P's angular frame.
                const off = wrapAngle(Q.phiC - P.phiC);
                const q0 = Q.dMin + off;
                const rr = Math.max(P.r, Q.r, 1);
                const gapPx = (q0 - P.dMax) * rr;
                if (gapPx < -1.5 || gapPx > O.linkGapPx) continue;
                const dr = Math.abs(P.rMax - Q.rMin);
                if (dr > O.linkRadialTol + 0.05 * Math.max(0, gapPx)) continue;
                cands.push({from: ip, to: iq, cost: Math.max(0, gapPx) + 4 * dr});
            }
        }
    }
    cands.sort((x, y) => x.cost - y.cost);
    const next = new Int32Array(n).fill(-1), prev = new Int32Array(n).fill(-1);
    // Chain heads, to refuse a link that would close a loop; and each chain's TAIL, for its span.
    const head = Array.from({length: n}, (_, i) => i);
    const headOf = (i) => { while (head[i] !== i) i = head[i]; return i; };
    const tailOf = (i) => { while (next[i] >= 0) i = next[i]; return i; };
    for (const {from, to} of cands) {
        if (next[from] >= 0 || prev[to] >= 0) continue;
        const h = headOf(from);
        if (h === headOf(to)) continue;
        if (maxSpanRad < Infinity) {
            // The joined chain runs from h's low end to to-chain's tail's high end.
            const H = polar[h], T = polar[tailOf(to)];
            const span = wrapAngle(T.phiC + T.dMax - (H.phiC + H.dMin));
            if (span > maxSpanRad) continue;
        }
        next[from] = to; prev[to] = from;
        head[headOf(to)] = h;
    }
    const groups = [];
    for (let i = 0; i < n; i++) {
        if (prev[i] >= 0) continue;
        const g = [];
        for (let j = i; j >= 0; j = next[j]) g.push(polar[j]);
        groups.push(g);
    }
    return groups;
}

/** Robust sigma of one profile sample (the cross-trail sum) at random places and angles. */
function measureProfileSigma(S, W, H, O) {
    // A fixed LCG, so the same image always gives the same answer.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const v = [];
    for (let n = 0; n < 4000; n++) {
        const x = 8 + rnd() * (W - 16), y = 8 + rnd() * (H - 16), a = rnd() * Math.PI;
        const nx = Math.cos(a), ny = Math.sin(a);
        let acc = 0;
        for (let o = -O.profileHalfWidth; o <= O.profileHalfWidth; o += 0.5) {
            acc += sample(S, W, H, x + o * nx, y + o * ny);
        }
        if (Number.isFinite(acc)) v.push(acc);
    }
    const m = median(v);
    return Math.max(1e-6, 1.4826 * median(v.map((z) => Math.abs(z - m))));
}

/** Bilinear sample of a plane; NaN outside. */
function sample(P, W, H, x, y) {
    if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) return NaN;
    const ix = Math.min(W - 2, Math.floor(x)), iy = Math.min(H - 2, Math.floor(y));
    const fx = x - ix, fy = y - iy, i = iy * W + ix;
    return (P[i] * (1 - fx) + P[i + 1] * fx) * (1 - fy) + (P[i + W] * (1 - fx) + P[i + W + 1] * fx) * fy;
}

/**
 * One linked group -> one trail: its centreline r(phi), its ends measured at half the plateau
 * brightness of the along-arc profile, and the ends ORDERED by the sense of rotation.
 */
function measureTrail(group, C, S, W, H, O, sense) {
    // The group's pixels in one angular frame (its brightest piece's).
    const ref = group.reduce((a, b) => (b.piece.flux > a.piece.flux ? b : a));
    const phi0 = ref.phiC;
    let dMin = Infinity, dMax = -Infinity, flux = 0, peak = 0;
    let sw = 0, sd = 0, sdd = 0, sddd = 0, sdddd = 0, sr = 0, sdr = 0, sddr = 0;
    for (const g of group) {
        const p = g.piece;
        flux += p.flux;
        if (p.peak > peak) peak = p.peak;
        for (const i of p.px) {
            const x = i % W, y = (i - x) / W;
            const w = Math.max(S[i], 0) + 1e-3;
            const r = Math.hypot(x - C[0], y - C[1]);
            const d = wrapAngle(Math.atan2(y - C[1], x - C[0]) - phi0);
            if (d < dMin) dMin = d;
            if (d > dMax) dMax = d;
            sw += w; sd += w * d; sdd += w * d * d; sddd += w * d * d * d; sdddd += w * d * d * d * d;
            sr += w * r; sdr += w * d * r; sddr += w * d * d * r;
        }
    }
    // r(phi) as a quadratic about the group's angle - an arc on a wide lens is not quite a
    // circle about the approximate centre, and the profile has to stay on its ridge.
    const rOf = fitQuadratic([sw, sd, sdd, sddd, sdddd], [sr, sdr, sddr], dMin, dMax);
    const rMid = rOf(0.5 * (dMin + dMax));
    if (!(rMid > 1)) return null;
    const pt = (d) => {
        const r = rOf(d), a = phi0 + d;
        return [C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)];
    };

    // The along-arc profile: signal summed across the trail, every profileStep px of arc,
    // reaching a few px past the detected extent at each end.
    const dStep = O.profileStep / rMid;
    const margin = 6 / rMid;
    const ds = [], prof = [];
    for (let d = dMin - margin; d <= dMax + margin + 1e-12; d += dStep) {
        const r = rOf(d), a = phi0 + d;
        const ca = Math.cos(a), sa = Math.sin(a);
        let acc = 0, ok = true;
        for (let o = -O.profileHalfWidth; o <= O.profileHalfWidth; o += 0.5) {
            const v = sample(S, W, H, C[0] + (r + o) * ca, C[1] + (r + o) * sa);
            if (Number.isNaN(v)) { ok = false; break; }
            acc += v;
        }
        ds.push(d);
        prof.push(ok ? acc : NaN);
    }
    // Plateau: the median over the trail's inner part.
    const inner = [];
    const span = dMax - dMin;
    for (let k = 0; k < ds.length; k++) {
        if (ds[k] >= dMin + 0.2 * span && ds[k] <= dMax - 0.2 * span && Number.isFinite(prof[k])) {
            inner.push(prof[k]);
        }
    }
    if (!inner.length) return null;
    const plateau = median(inner);
    if (!(plateau > 0)) return null;
    const half = 0.5 * plateau;
    // Walk outward from the detected extent to the half-plateau crossing, interpolating.
    const crossing = (from, step) => {
        let k = from;
        while (k + step >= 0 && k + step < ds.length) {
            const a = prof[k], b = prof[k + step];
            if (!Number.isFinite(b)) return {d: ds[k], clipped: true};
            if (a >= half && b < half) {
                const t = (a - half) / (a - b);
                return {d: ds[k] + t * (ds[k + step] - ds[k]), clipped: false};
            }
            k += step;
        }
        return {d: ds[k], clipped: true};
    };
    const kLo = ds.findIndex((d) => d >= dMin);
    let kHi = ds.length - 1;
    while (kHi > 0 && ds[kHi] > dMax) kHi--;
    // Start each search from the brightest sample near the extent, so a faint first sample does
    // not end the walk before it starts.
    // The inward walk may go as far as the trail's middle: a trail whose end tapers through more
    // than a few pixels below half level (measured: about 1 end in 20 on the Allsky stack) would
    // otherwise start the outward search below half, find no crossing, and put the end at the
    // edge of the padding - outside the trail.
    const kMid = Math.round((kLo + kHi) / 2);
    const loEnd = crossing(walkIn(prof, kLo, kMid, half), -1);
    const hiEnd = crossing(walkIn(prof, kHi, kMid, half), +1);

    // Time order. In image coordinates (y down) a counterclockwise turn on screen DECREASES
    // atan2; sense -1 is that case, so the trail starts at its high-angle end.
    const start = sense < 0 ? hiEnd : loEnd;
    const end = sense < 0 ? loEnd : hiEnd;
    const startPx = pt(start.d), endPx = pt(end.d);
    const spanRad = Math.abs(hiEnd.d - loEnd.d);
    // The whole trail's light: the profile integrated between the ends. Each profile sample
    // sums across the trail at 0.5 px steps, so it carries a factor 0.5 to be a width integral.
    // Proportional to the star's flux times the exposure, whatever its speed across the frame -
    // which is what makes it a magnitude, where a trail's surface brightness is not.
    let totalFlux = 0;
    for (let k = 0; k < ds.length; k++) {
        if (ds[k] >= loEnd.d && ds[k] <= hiEnd.d && Number.isFinite(prof[k])) {
            totalFlux += Math.max(0, prof[k]) * 0.5 * O.profileStep;
        }
    }
    return {
        startPx, endPx,
        mid: pt(0.5 * (loEnd.d + hiEnd.d)),
        r: rMid,
        spanRad,
        lengthPx: spanRad * rMid,
        startClipped: start.clipped, endClipped: end.clipped,
        flux, totalFlux, peakSNR: peak, plateau, pieces: group.length,
    };
}

/** Step from an extent index toward `stop` (the trail's middle) to the first sample at half level. */
function walkIn(prof, k, stop, half) {
    const step = stop >= k ? 1 : -1;
    for (let j = k; step > 0 ? j <= stop : j >= stop; j += step) {
        if (prof[j] >= half) return j;
    }
    return k;
}

/** Weighted least-squares quadratic from moment sums; falls back to linear, then constant. */
function fitQuadratic(m, rhs, dMin, dMax) {
    const [s0, s1, s2, s3, s4] = m, [t0, t1, t2] = rhs;
    const span = dMax - dMin;
    const solve3 = () => {
        const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], b = [t0, t1, t2];
        const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
            - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
            + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        const D = det(A);
        if (!(Math.abs(D) > 1e-18)) return null;
        const col = (k) => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
        return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
    };
    // A quadratic needs a long enough arc to be meaningful.
    if (span * Math.max(1, t0 / s0) > 20) {
        const c = solve3();
        if (c) return (d) => c[0] + c[1] * d + c[2] * d * d;
    }
    const D2 = s0 * s2 - s1 * s1;
    if (Math.abs(D2) > 1e-18) {
        const b1 = (s0 * t1 - s1 * t0) / D2, b0 = (t0 - b1 * s1) / s0;
        return (d) => b0 + b1 * d;
    }
    return () => t0 / s0;
}
