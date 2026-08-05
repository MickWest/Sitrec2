// Stage 5 of Star Track: naming the stars.
//
// The solved star map is a set of positions on an image plane with relative brightnesses, and
// nothing else - no location, no time, no pointing, no field of view. Identifying which real
// stars they are is therefore BLIND astrometric calibration, and this module implements the
// technique that solved that problem at scale: geometric hashing of star QUADS (Lang et al.
// 2010, "Astrometry.net: Blind astrometric calibration of arbitrary astronomical images").
//
// The idea: take four stars, let A and B be the most separated pair, and express the other two
// in the coordinate frame that maps A to (0,0) and B to (1,1). Those four numbers - the quad's
// CODE - are invariant to translation, rotation and scale, which is exactly the family of
// unknowns a camera with unknown pointing, roll and zoom applies. Codes are precomputed for the
// local quads of every bright catalog star; each image quad whose code matches one of them
// hypothesises a field (centre, roll, plate scale, via a four-point similarity onto the catalog
// quad's tangent plane), and the hypothesis is then VERIFIED by projecting the whole in-field
// catalog into the image and demanding that it lands on most of the detected stars. A quad
// match can be a coincidence; a whole field agreeing cannot.
//
// The quad index is built at runtime from the catalog Sitrec already ships for its night sky
// (a second, deeper tier is built only if the first fails - a narrow field's bright stars are
// too sparse for wide-field quads). Nothing here fetches or touches the DOM: the app layer
// loads the files and calls in.
//
// Pure: plain arrays in, plain objects out. No DOM, no THREE, no Sitrec globals.

export const STAR_IDENTIFY_DEFAULTS = {
    // Quad index tiers, tried in order. A tier is characterised by how faint its stars go and
    // how far apart quad members may be: wide fields are made of bright, well-separated stars,
    // narrow fields of fainter, tighter ones. neighbors=8 with 3 chosen per quad gives C(8,3)
    // = 56 quads per anchor star - enough overlap with the image's own quads that some survive
    // the two sets seeing slightly different stars.
    tiers: [
        {magLimit: 5.0, maxAngleDeg: 22, neighbors: 8},
        // The density-matched middle tier: a ~15-30 deg field detects stars to mag ~5.5-6.5,
        // and the 8-nearest-bright-neighbours rule couples magnitude depth to quad size, so
        // tier 0's mag-5 cut can leave a sparse stretch with no representable quad at all
        // while the mag-6.5 tier's quads are far too small to span the frame. Measured on a
        // 28-deg field whose sparser ranges (10-11 stars) refused at every other tier: this
        // one solves both, with every matched star verified real. 101,524 quads, ~126 ms to
        // build, and it changed no other corpus case's result.
        {magLimit: 5.5, maxAngleDeg: 22, neighbors: 8},
        {magLimit: 6.5, maxAngleDeg: 8, neighbors: 8},
        // The wide tier serves phone-lens fields (a 24mm-equivalent frame spans ~67 deg): only
        // the naked-eye-bright stars, quads up to 50 deg across, and a much looser code
        // tolerance - at these spans the gnomonic shear between the catalog quad's tangent
        // point and the camera's differs by several percent, which is exactly why wide-field
        // solves NEED the scale prior to prune what the loose tolerance lets through.
        {magLimit: 4.0, maxAngleDeg: 50, neighbors: 8, codeTolerance: 0.05},
    ],
    // Verification catalog depth. Deeper than the index: the index only needs the bright stars
    // that form quads, but verification wants every star the video could plausibly have seen.
    verifyMagLimit: 7.0,

    // How many image stars may form quads, and how many nearest neighbours each draws its quad
    // partners from. Bounded because quad count grows as C(k,3) per star.
    //
    // The neighbour depth must OUT-REACH the catalog side's pollution. The index builds quads
    // from each catalog star's 8 nearest BRIGHT neighbours, but the image list mixes in stars
    // the tier's index cannot contain - real stars past the magnitude cap, junk - and each
    // interloper displaces a bright partner from the list. Measured on a 42-frame clip whose
    // detector admitted two such stars at threshold sigma 5: at depth 7 the one quad family
    // the index shared with the image fell out of reach and NO true hypothesis was generated
    // at any tier (the clip solved at sigma 4 and 7, failing only in between); at depth 9 the
    // same input solves on tier 0 with 17/18 matched, and three neighbouring inputs that
    // previously slipped through to a confidently WRONG wide-field solve refuse or solve true
    // instead. Depth 8 fixed only one of the two failing inputs - 9 is the validated margin,
    // not a knife edge (10 behaves identically).
    imageQuadStars: 25,
    imageNeighbors: 9,

    // Quad anchors are held to a tighter standard than mere detection: they must look like POINT
    // SOURCES. Extent is capped relative to THIS image's median detection, so the bar carries
    // across sensors and focal lengths instead of encoding one camera's pixel scale; elongation
    // is capped below the detector's own admission limit, so an anchor must be rounder than
    // merely acceptable. See the anchor selection in solveFieldInner for what this is for.
    quadMaxExtentMedians: 1.75,
    quadMaxElongation: 2.0,

    // Code-space match tolerance (L-infinity, per axis). Code coordinates live in roughly the
    // unit square, and the noise of a code coordinate is the astrometric noise over the quad's
    // diameter - a percent or two for the small quads of a sparse field.
    codeTolerance: 0.015,

    // Hypothesis acceptance. `verifyPixelTolerance` is a fraction of the image width: the
    // similarity model ignores lens distortion and the gnomonic scale change across the field,
    // both of which grow with field size, so the tolerance should too.
    verifyPixelFraction: 0.005,
    verifyPixelMin: 4,
    minMatches: 8,
    // Acceptance is TWO-STAGE. A hypothesis transform comes from four stars, and no four-point
    // fit aligns a whole field to the pixel tolerance - on a dense field, demanding the full
    // consensus of it rejects every correct hypothesis. So a hypothesis is accepted
    // PROVISIONALLY on modest evidence (eight exclusive tolerance-matches is already no
    // coincidence), refinement then fits the full match set, and the FINAL model must carry
    // the strong consensus. A wrong provisional refines on garbage and dies at the final gate.
    provisionalMatchFraction: 0.15,
    minMatchFraction: 0.5,
    // The fraction rule is the NARROW-field standard. A star map mosaicked from a long panning
    // clip is stitched by per-frame similarities, and over a 20-degree span the gnomonic scale
    // variation those similarities cannot express warps the mosaic by tens of pixels at the
    // edges - capping the within-tolerance fraction near one half however correct the solve is.
    // So a solve also passes with strongMatchCount matches at the reduced fraction floor.
    //
    // An absolute count is NOT evidence by itself, though - that depends entirely on how dense
    // the projected catalog is. Measured on a 671-frame pan (123 image stars, 1220 px mosaic,
    // 6.1 px tolerance): a bogus 96-degree hypothesis projected 3,495 catalog stars into the
    // bounds, which puts a catalog star within tolerance of ~30 image stars by pure chance,
    // and the greedy matcher duly "matched" 44 - while the correct 15.6-degree solve, whose
    // sparse projection offers ~1.4 chance matches, earned 43 and lost the field to it by one.
    // Hence the chance gate below, which is the density-aware half of astrometry.net's
    // absolute-odds acceptance: a match count is only evidence in the amount it EXCEEDS what
    // coincidence would produce against this hypothesis' own projection.
    strongMatchCount: 25,
    // 0.30, not the 0.35 it shipped with: on that same clip the correct solve tops out at 34%
    // matched (the longer integration detects real stars fainter than anything the projection
    // pools offer, and they all sit in the denominator), so 0.35 rejected it by 0.05 matches.
    // The chance gate now does the discriminating; this floor only rules out a model that
    // explains a corner of the map and nothing else.
    strongMatchFraction: 0.30,
    // The chance gate: accept only when matches >= expected + max(chanceMarginMin,
    // chanceSigmas * sqrt(expected)), where `expected` is the chance-match count computed in
    // projectAndMatch from the projection the matches actually came from. The sigma term is
    // deliberately generous (4, not 3): thousands of hypotheses each get a shot at this gate,
    // so a per-test tail probability that looks safe in isolation is not safe across a sweep.
    // Both reference clips clear it with an order of magnitude to spare.
    chanceMarginMin: 5,
    chanceSigmas: 4,
    maxHypotheses: 3000,
    // Stop early once a hypothesis explains this fraction of the image stars.
    earlyExitFraction: 0.85,

    refineRounds: 2,

    // When the caller KNOWS the plate scale - camera optics metadata gives the field of view
    // exactly - hypotheses whose implied scale strays beyond this relative tolerance are
    // discarded before verification. Set `scalePrior` in the options, in GNOMONIC TANGENT UNITS
    // per pixel - what scalePriorFromFov returns, and what the solver's own scale is measured in.
    // (Not radians per pixel: the two agree only at the field centre.)
    scalePriorTolerance: 0.35,
};

// ---------------------------------------------------------------------------------------------
// Catalog file parsing
// ---------------------------------------------------------------------------------------------

/**
 * Parse Sitrec's repacked bright-star catalog (data/nightsky/sitrec_bsc_lite.bin).
 *
 * Layout, verified against the shipped file: a 28-byte header of seven int32s (the third is
 * -nStars, the seventh the 22-byte record length), then per star: int32 Hipparcos number,
 * float64 RA (radians, J2000), float64 Dec (radians), int16 magnitude*100. Records whose RA and
 * Dec are both exactly zero are placeholders and are DROPPED here - the night-sky renderer
 * keeps them as invisible mag-15 stars, but an identifier must not offer them as answers.
 *
 * The record count comes from the header, not from a byte-offset inequality: the night-sky
 * loader's `offset < -starn*nbent - 28` bound silently drops the last two stars of the file.
 */
export function parseStarCatalog(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const nStars = -view.getInt32(8, true);
    const nbent = view.getInt32(24, true);
    if (nStars <= 0 || nbent !== 22 || arrayBuffer.byteLength < 28 + nStars * nbent) {
        throw new Error("unrecognised star catalog format");
    }
    const ra = new Float64Array(nStars);
    const dec = new Float64Array(nStars);
    const mag = new Float32Array(nStars);
    const hip = new Int32Array(nStars);
    let n = 0;
    for (let i = 0; i < nStars; i++) {
        const off = 28 + i * nbent;
        const r = view.getFloat64(off + 4, true);
        const d = view.getFloat64(off + 12, true);
        if (r === 0 && d === 0) continue;
        ra[n] = r;
        dec[n] = d;
        mag[n] = view.getInt16(off + 20, true) / 100;
        hip[n] = view.getInt32(off, true);
        n++;
    }
    return {
        n,
        ra: ra.subarray(0, n),
        dec: dec.subarray(0, n),
        mag: mag.subarray(0, n),
        hip: hip.subarray(0, n),
    };
}

/**
 * Parse the IAU Catalog of Star Names (data/nightsky/IAU-CSN.txt) into a Map keyed by
 * Hipparcos number. The file carries more than the proper name - Bayer letter, constellation
 * and HR number sit in fixed columns nothing else in the codebase reads - and those make the
 * difference between labelling a star "Betelgeuse" and being able to say "alpha Ori" for the
 * hundreds of bright stars that have no proper name at all.
 */
export function parseStarNames(text) {
    const names = new Map();
    for (const line of text.split("\n")) {
        if (!line.trim() || line[0] === "#" || line[0] === "$") continue;
        // The HIP field is right-aligned in columns [89, 96): a six-digit number fills the
        // column, so a slice that starts late truncates "102098" to 2098 - hiding Deneb and
        // hanging its name on whatever star owns the truncated number.
        const hipStr = line.substring(89, 96).trim();
        const hip = parseInt(hipStr, 10);
        if (!Number.isFinite(hip)) continue;
        const designation = line.substring(36, 49).trim();
        const hrMatch = /^HR (\d+)/.exec(designation);
        names.set(hip, {
            name: line.substring(0, 18).trim(),
            greek: line.substring(55, 61).trim(),
            constellation: line.substring(61, 65).trim(),
            hr: hrMatch ? parseInt(hrMatch[1], 10) : null,
        });
    }
    return names;
}

// ---------------------------------------------------------------------------------------------
// Sphere and tangent-plane geometry
// ---------------------------------------------------------------------------------------------

/**
 * The plate-scale prior (tangent-plane units per pixel at the image centre) implied by a
 * camera's field of view. Two traps this exists to avoid: the solver's scale lives in GNOMONIC
 * tangent units, where half the frame spans tan(fov/2), not fov/2 - a linear conversion is 8%
 * off at phone-lens widths and worse beyond; and the metadata's vertical FOV describes the
 * sensor's SHORT axis, so it must be paired with the short pixel dimension - pairing it with
 * "height" breaks the moment the photo is portrait, and a 33% orientation error on top of the
 * 8% pushed valid fields straight through the prior gate.
 */
export function scalePriorFromFov(shortAxisFovDeg, widthPx, heightPx) {
    const short = Math.min(widthPx, heightPx);
    if (!(shortAxisFovDeg > 0) || !(short > 0)) return undefined;
    return 2 * Math.tan(shortAxisFovDeg * Math.PI / 360) / short;
}

/** RA/Dec (radians) to a unit vector in the equatorial frame. */
export function raDecToVec(ra, dec) {
    const c = Math.cos(dec);
    return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

/** Unit vector back to {ra, dec} in radians, RA in [0, 2pi). */
export function vecToRaDec(v) {
    const ra = Math.atan2(v[1], v[0]);
    return {ra: ra < 0 ? ra + 2 * Math.PI : ra, dec: Math.asin(Math.max(-1, Math.min(1, v[2])))};
}

/**
 * An east/north tangent basis at the unit vector `c`. Near the poles "east" degenerates, so any
 * perpendicular axis stands in - the solver never interprets the axes physically, it only needs
 * a consistent plane; roll is reported relative to north and simply loses meaning at the pole,
 * as it does on any mount.
 */
export function tangentBasis(c) {
    let ex = -c[1], ey = c[0], ez = 0;                 // z-hat cross c: east
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) { ex = 1; ey = 0; ez = 0; }
    else { ex /= len; ey /= len; }
    // north = c cross east
    const nx = c[1] * ez - c[2] * ey;
    const ny = c[2] * ex - c[0] * ez;
    const nz = c[0] * ey - c[1] * ex;
    return {e: [ex, ey, ez], n: [nx, ny, nz]};
}

/** Gnomonic projection of unit vector `s` about centre `c` with basis `b`; null if behind. */
export function gnomonic(s, c, b) {
    const d = s[0] * c[0] + s[1] * c[1] + s[2] * c[2];
    if (d < 0.05) return null;
    return [
        (s[0] * b.e[0] + s[1] * b.e[1] + s[2] * b.e[2]) / d,
        (s[0] * b.n[0] + s[1] * b.n[1] + s[2] * b.n[2]) / d,
    ];
}

/** Inverse gnomonic: tangent-plane (xi, eta) about centre `c` with basis `b` to a unit vector. */
export function unGnomonic(xi, eta, c, b) {
    const v = [
        c[0] + xi * b.e[0] + eta * b.n[0],
        c[1] + xi * b.e[1] + eta * b.n[1],
        c[2] + xi * b.e[2] + eta * b.n[2],
    ];
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
}

// ---------------------------------------------------------------------------------------------
// Quad codes
// ---------------------------------------------------------------------------------------------

/**
 * The astrometry.net quad code of four plane points, or null if the quad is unusable.
 *
 * A and B are the most separated pair; the frame maps A to (0,0) and B to (1,1); the code is
 * the positions of the other two stars in that frame, with two canonicalisations so each
 * geometric quad has exactly one code: the A/B labelling with cx+dx <= 1, and C before D by x.
 * Quads whose inner stars fall outside the circle with diameter AB are rejected - outside it,
 * which pair is "most separated" flips under noise and the code becomes unstable.
 */
export function quadCode(pts) {
    let ai = 0, bi = 1, best = -1;
    for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
            const dd = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
            if (dd > best) { best = dd; ai = i; bi = j; }
        }
    }
    if (best < 1e-12) return null;
    const rest = [0, 1, 2, 3].filter((k) => k !== ai && k !== bi);

    const A = pts[ai], B = pts[bi];
    const wx = B[0] - A[0], wy = B[1] - A[1];
    const ww = wx * wx + wy * wy;
    // z = (P - A) / (B - A), then times (1 + i) so B lands on (1,1).
    const frame = (P) => {
        const px = P[0] - A[0], py = P[1] - A[1];
        const zx = (px * wx + py * wy) / ww;
        const zy = (py * wx - px * wy) / ww;
        return [zx - zy, zx + zy];
    };
    let C = frame(pts[rest[0]]);
    let D = frame(pts[rest[1]]);
    // Inside the circle with diameter AB: centre (0.5, 0.5), radius sqrt(2)/2 in code space.
    const inside = (p) => (p[0] - 0.5) ** 2 + (p[1] - 0.5) ** 2 <= 0.5 + 1e-9;
    if (!inside(C) || !inside(D)) return null;
    // Canonical A/B orientation: swapping A and B maps a code point z to (1,1)-z.
    if (C[0] + D[0] > 1) {
        C = [1 - C[0], 1 - C[1]];
        D = [1 - D[0], 1 - D[1]];
    }
    if (C[0] > D[0]) { const t = C; C = D; D = t; }
    return [C[0], C[1], D[0], D[1]];
}

/** The C(k,3) index triples for k up to 8, precomputed once. */
function triples(k) {
    const out = [];
    for (let a = 0; a < k; a++) {
        for (let b = a + 1; b < k; b++) {
            for (let c = b + 1; c < k; c++) out.push([a, b, c]);
        }
    }
    return out;
}

/**
 * Build one tier of the quad index from the catalog.
 *
 * For every star brighter than the tier's limit, its `neighbors` nearest bright stars within
 * `maxAngleDeg` are found, the neighbourhood is projected onto the star's own tangent plane,
 * and a quad is coded for the star plus each triple of neighbours. Codes are sorted by their
 * first coordinate so lookup is a binary search plus a short scan rather than a full pass over
 * hundreds of thousands of codes.
 *
 * Deliberately built at RUNTIME rather than shipped as a data file: the source catalog is
 * already in the repo, the build is a couple of seconds once per session, and a computed index
 * cannot drift out of sync with the catalog or the code definition.
 */
export function buildQuadIndex(catalog, tier) {
    const {magLimit, maxAngleDeg, neighbors} = tier;
    const bright = [];
    for (let i = 0; i < catalog.n; i++) {
        if (catalog.mag[i] <= magLimit) bright.push(i);
    }
    const nb = bright.length;
    const vec = new Float64Array(nb * 3);
    for (let k = 0; k < nb; k++) {
        const v = raDecToVec(catalog.ra[bright[k]], catalog.dec[bright[k]]);
        vec[k * 3] = v[0]; vec[k * 3 + 1] = v[1]; vec[k * 3 + 2] = v[2];
    }
    const minDot = Math.cos(maxAngleDeg * Math.PI / 180);
    const tri = triples(neighbors);

    const codes = [];
    const quads = [];
    const near = [];
    for (let a = 0; a < nb; a++) {
        near.length = 0;
        const ax = vec[a * 3], ay = vec[a * 3 + 1], az = vec[a * 3 + 2];
        for (let b = 0; b < nb; b++) {
            if (b === a) continue;
            const dot = ax * vec[b * 3] + ay * vec[b * 3 + 1] + az * vec[b * 3 + 2];
            if (dot >= minDot) near.push([dot, b]);
        }
        if (near.length < 3) continue;
        near.sort((p, q) => q[0] - p[0]);
        const k = Math.min(neighbors, near.length);

        const c = [ax, ay, az];
        const basis = tangentBasis(c);
        const anchor = [0, 0];
        const proj = [];
        for (let j = 0; j < k; j++) {
            const b = near[j][1];
            proj.push(gnomonic([vec[b * 3], vec[b * 3 + 1], vec[b * 3 + 2]], c, basis));
        }
        for (const [i1, i2, i3] of tri) {
            if (i1 >= k || i2 >= k || i3 >= k) break;
            if (!proj[i1] || !proj[i2] || !proj[i3]) continue;
            const code = quadCode([anchor, proj[i1], proj[i2], proj[i3]]);
            if (!code) continue;
            codes.push(code);
            quads.push([bright[a], bright[near[i1][1]], bright[near[i2][1]], bright[near[i3][1]]]);
        }
    }

    // Sort by first code coordinate for windowed lookup.
    const order = codes.map((_, i) => i).sort((p, q) => codes[p][0] - codes[q][0]);
    const sortedCodes = new Float32Array(order.length * 4);
    const sortedQuads = new Int32Array(order.length * 4);
    for (let i = 0; i < order.length; i++) {
        const o = order[i];
        for (let j = 0; j < 4; j++) {
            sortedCodes[i * 4 + j] = codes[o][j];
            sortedQuads[i * 4 + j] = quads[o][j];
        }
    }
    return {n: order.length, codes: sortedCodes, quads: sortedQuads, tier};
}

/** All index entries whose codes match `code` within `tol` on every axis. */
function lookupCode(index, code, tol) {
    const {n, codes} = index;
    // Binary search the lower bound of the cx window.
    let lo = 0, hi = n;
    const target = code[0] - tol;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (codes[mid * 4] < target) lo = mid + 1;
        else hi = mid;
    }
    const out = [];
    for (let i = lo; i < n && codes[i * 4] <= code[0] + tol; i++) {
        if (Math.abs(codes[i * 4 + 1] - code[1]) <= tol
            && Math.abs(codes[i * 4 + 2] - code[2]) <= tol
            && Math.abs(codes[i * 4 + 3] - code[3]) <= tol) {
            out.push(i);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

/**
 * A recorder for WHY a solve went the way it did: how many quads were built, how many code hits
 * they drew, which guard threw each hypothesis away, and what the acceptance arithmetic actually
 * was at the end. A failed blind solve reports one sentence ("no verified match", "refinement
 * lost the match consensus") and those two sentences cover a dozen distinct causes; without this
 * the only way to tell them apart is to edit the module.
 *
 * Module-scoped rather than threaded through six signatures: solveField is synchronous with no
 * awaits, so exactly one solve is ever in flight. Null unless the caller passes `debug: true`,
 * and NOTHING IN THE SOLVE EVER READS IT - counters go in and never come out - so a debug run
 * takes bit-for-bit the same path as a normal one.
 */
let DIAG = null;

function newDiag() {
    return {counts: {}, max: {}, tiers: [], finalists: []};
}

/** Bump a named counter. `rej.*` keys are rejections, one per guard. */
function diagCount(key, n = 1) {
    if (DIAG) DIAG.counts[key] = (DIAG.counts[key] ?? 0) + n;
}

/** Record the largest value a quantity reached - the guards are all upper bounds, so the
 * maximum is what says whether one of them was ever close to firing. */
function diagMax(key, v) {
    if (DIAG && Number.isFinite(v) && (!(key in DIAG.max) || v > DIAG.max[key])) DIAG.max[key] = v;
}

// ---------------------------------------------------------------------------------------------
// The blind solve
// ---------------------------------------------------------------------------------------------

/** Least-squares similarity q = A*p + B with FREE scale, as complex numbers. */
function fitSimilarityFree(P, Q) {
    const n = P.length;
    let pbx = 0, pby = 0, qbx = 0, qby = 0;
    for (let i = 0; i < n; i++) {
        pbx += P[i][0]; pby += P[i][1];
        qbx += Q[i][0]; qby += Q[i][1];
    }
    pbx /= n; pby /= n; qbx /= n; qby /= n;
    let nre = 0, nim = 0, dd = 0;
    for (let i = 0; i < n; i++) {
        const px = P[i][0] - pbx, py = P[i][1] - pby;
        const qx = Q[i][0] - qbx, qy = Q[i][1] - qby;
        nre += qx * px + qy * py;
        nim += qy * px - qx * py;
        dd += px * px + py * py;
    }
    if (dd < 1e-12) return null;
    const ax = nre / dd, ay = nim / dd;
    return {
        A: [ax, ay],
        B: [qbx - (ax * pbx - ay * pby), qby - (ay * pbx + ax * pby)],
    };
}

function applySim(T, x, y) {
    return [T.A[0] * x - T.A[1] * y + T.B[0], T.A[1] * x + T.A[0] * y + T.B[1]];
}

/**
 * The same similarity fit, but not at the mercy of its worst correspondences.
 *
 * A hypothesis arrives backed by a four-point transform, and the match set it collected under
 * that transform is not clean - at a tolerance wide enough to admit the true pairings, some
 * chance neighbours come too. Plain least squares gives every one of them an equal vote, and a
 * handful of wrong pairs at the frame edge (where the lever arm is longest) tilt the model enough
 * that the rematch then loses the GOOD pairs. Measured on the reference clip's improved star set:
 * 58 provisional matches refit to a model that could only find 16.
 *
 * So: fit, measure, drop the tail, fit again. The cut is a multiple of the MEDIAN residual rather
 * than a fixed pixel figure, because the right scale is the one this solve is actually achieving
 * and that varies by orders of magnitude between a phone snapshot and a stacked astrophoto. The
 * median survives a minority of arbitrarily bad pairs, which a mean or an rms does not - and it
 * is a minority of bad pairs that this exists to handle.
 *
 * Never trims below `keepFloor` of the points: past that the "outliers" are more likely to be the
 * model, and a fit that discards most of its evidence to look tidy is how a wrong solve survives.
 */
export function fitSimilarityRobust(P, Q, rounds = 2, keepFloor = 0.6) {
    let T = fitSimilarityFree(P, Q);
    if (!T || P.length < 6) return T;
    const minKeep = Math.max(6, Math.ceil(keepFloor * P.length));
    for (let round = 0; round < rounds; round++) {
        const d2 = P.map((p, i) => {
            const e = applySim(T, p[0], p[1]);
            return (e[0] - Q[i][0]) ** 2 + (e[1] - Q[i][1]) ** 2;
        });
        const sorted = [...d2].sort((a, b) => a - b);
        const median = sorted[sorted.length >> 1];
        // A cut at 3x the median distance. With no real outliers this keeps everything, so a
        // clean solve is left exactly as least squares had it.
        const cut = Math.max(median * 9, sorted[minKeep - 1]);
        const kp = [], kq = [];
        for (let i = 0; i < P.length; i++) {
            if (d2[i] <= cut) { kp.push(P[i]); kq.push(Q[i]); }
        }
        if (kp.length === P.length || kp.length < minKeep) break;
        const next = fitSimilarityFree(kp, kq);
        if (!next) break;
        T = next;
    }
    return T;
}

function invertSim(T) {
    const d = T.A[0] * T.A[0] + T.A[1] * T.A[1];
    const ax = T.A[0] / d, ay = -T.A[1] / d;
    const bx = ax * T.B[0] - ay * T.B[1];
    const by = ay * T.B[0] + ax * T.B[1];
    return {A: [ax, ay], B: [-bx, -by]};
}

/**
 * Blind-solve the field: which catalog stars are these, and where is the camera pointing?
 *
 * @param {Array} imageStars - [{x, y, mag}] the solved star map (reference-frame px;
 *   `mag` is the instrumental magnitude, used only to pick the brightest for quads)
 * @param {object} catalog - from {@link parseStarCatalog}
 * @param {Array} indexes - quad index tiers from {@link buildQuadIndex}, tried in order
 * @param {object} [opts] - overrides of STAR_IDENTIFY_DEFAULTS. `debug: true` additionally
 *   attaches a `diag` record of the solve's internals to the result (see newDiag).
 *   `onYield` is awaited periodically through the hypothesis search so a caller can keep the
 *   page responsive; omit it and the search runs straight through as one burst.
 *   `onCandidate({points, mirrored, matched, nImage, fraction})` is called for each hypothesis
 *   that survives verification, with `points` the four quad stars in image coordinates.
 * @returns {Promise<{ok: boolean, reason?: string} | {ok: true, matches, centerRaDeg,
 *   centerDecDeg, fovDeg, rollDeg, pxPerDeg, mirrored, nImage, matchedFraction, rmsPx}>}
 */
export async function solveField(imageStars, catalog, indexes, opts = {}) {
    DIAG = opts.debug ? newDiag() : null;
    try {
        const out = await solveFieldInner(imageStars, catalog, indexes, opts);
        if (DIAG) out.diag = DIAG;
        return out;
    } finally {
        // Cleared even when the solve throws, so a later run can never inherit a stale recorder.
        // DIAG is module-scoped and this function now spans awaits, so two solves running at once
        // would share it - the caller is responsible for not starting a second while one runs.
        DIAG = null;
    }
}

async function solveFieldInner(imageStars, catalog, indexes, opts) {
    const O = {...STAR_IDENTIFY_DEFAULTS, ...opts};
    const nImage = imageStars.length;
    if (nImage < 5) return {ok: false, reason: "too few stars to identify"};

    // Image extent, for tolerances and the field-of-view report. The reported field CENTRE is
    // the caller's image centre when given (the frame midpoint, usually), else the middle of
    // the stars' bounding box - the centroid would drift toward whichever corner happens to
    // hold more stars.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of imageStars) {
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
    }
    const width = O.width ?? Math.max(maxX - minX, maxY - minY, 1);
    const tolPx = Math.max(O.verifyPixelMin, O.verifyPixelFraction * width);
    const centerPx = O.center ?? [(minX + maxX) / 2, (minY + maxY) / 2];
    // The image rectangle, for confining projected catalog stars to what the frame can
    // actually see. Callers that know the frame pass it; headless use falls back to the
    // detected stars' bounding box, padded.
    const bounds = O.bounds
        ?? [minX - 4 * tolPx, minY - 4 * tolPx, maxX + 4 * tolPx, maxY + 4 * tolPx];

    // Quad stars must look like SKY: isolated points, not texture. Terrestrial clutter - lit
    // foliage, a contrail - detects as dozens of bright blobs packed together, and on a real
    // twilight photo those blobs WERE the brightest "stars", so every quad the solver built
    // was anchored in a tree. A detection whose neighbourhood holds several times the image's
    // average density is excluded from quad building; it can still be matched and named by
    // verification and refinement. The bar is RELATIVE, so a genuinely rich star field - which
    // is dense everywhere - keeps its anchors.
    const clutterR2 = (0.04 * width) ** 2;
    const neighborCounts = imageStars.map((s) => {
        let c = 0;
        for (const t of imageStars) {
            if (t === s) continue;
            if ((t.x - s.x) ** 2 + (t.y - s.y) ** 2 < clutterR2) c++;
        }
        return c;
    });
    // The typical density is the MEDIAN, not the mean: the clutter's own inflated counts would
    // otherwise raise a mean-based bar right past themselves.
    const sortedCounts = [...neighborCounts].sort((a, b) => a - b);
    const medianNeighbors = sortedCounts[sortedCounts.length >> 1] ?? 0;
    const clutterMax = Math.max(4, 4 * medianNeighbors);

    // The image quads are built from the best POINT SOURCES, not the brightest detections.
    //
    // Measured on a twilight photo with a treeline (4032x3024, 1047 detections): taking the 25
    // brightest by flux put 24 of them in the foliage, and every surviving quad was anchored in
    // a tree. Lit leaves are bright because a clump is LARGE, and integrated flux rewards
    // exactly that, while a star is compact with a high peak. On that image, ranking by peakSNR
    // alone leaves 12 of 25 anchors in the trees; restricting to compact detections alone leaves
    // 19; doing both leaves 1. Both halves are therefore kept.
    //
    // This is a SEPARATE defence from the density test above, which that image defeats: the sky
    // was itself densely detected (median 14 neighbours), so the foliage at ~50 never reached
    // the 4x-median bar and nothing was excluded at all.
    //
    // `snr`, `extent` and `elongation` are optional. Callers that do not measure them - the
    // headless tests, anything feeding bare {x, y, mag} - fall back to ranking by magnitude and
    // to admitting every shape, which is exactly the previous behaviour.
    const extents = imageStars.map((s) => s.extent).filter((v) => Number.isFinite(v));
    const maxExtent = extents.length
        ? O.quadMaxExtentMedians * [...extents].sort((a, b) => a - b)[extents.length >> 1]
        : Infinity;
    const pointLike = (s) =>
        (!Number.isFinite(s.extent) || s.extent <= maxExtent)
        && (!Number.isFinite(s.elongation) || s.elongation <= O.quadMaxElongation);
    // Ascending sort throughout, so magnitude (smaller is brighter) and negated SNR agree on
    // "best first" without a second code path.
    const measuredSnr = imageStars.some((s) => Number.isFinite(s.snr));
    const rankOf = measuredSnr
        ? (s) => (Number.isFinite(s.snr) ? -s.snr : Infinity)
        : (s) => (s.mag ?? 0);

    const brightIdx = imageStars
        .map((s, i) => [rankOf(s), i])
        .filter(([, i]) => neighborCounts[i] <= clutterMax && pointLike(imageStars[i]))
        .sort((p, q) => p[0] - q[0])
        .slice(0, O.imageQuadStars)
        .map((p) => p[1]);
    const bpts = brightIdx.map((i) => [imageStars[i].x, imageStars[i].y]);
    const tri = triples(O.imageNeighbors);

    // Verification stars, deep, with unit vectors ready.
    const deep = [];
    for (let i = 0; i < catalog.n; i++) {
        if (catalog.mag[i] <= O.verifyMagLimit) deep.push(i);
    }
    const deepVec = deep.map((i) => raDecToVec(catalog.ra[i], catalog.dec[i]));

    // Every image quad, in both parities. Screen y grows downward while the tangent plane's
    // north grows upward, and which way the camera actually maps them is unknowable up front -
    // so each quad is coded as seen and mirrored, and a code hit remembers which one it was.
    const imageQuads = [];
    for (let a = 0; a < bpts.length; a++) {
        const near = [];
        for (let b = 0; b < bpts.length; b++) {
            if (b === a) continue;
            near.push([(bpts[a][0] - bpts[b][0]) ** 2 + (bpts[a][1] - bpts[b][1]) ** 2, b]);
        }
        near.sort((p, q) => p[0] - q[0]);
        const k = Math.min(O.imageNeighbors, near.length);
        for (const [i1, i2, i3] of tri) {
            if (i1 >= k || i2 >= k || i3 >= k) break;
            const quad = [a, near[i1][1], near[i2][1], near[i3][1]];
            const pts = quad.map((q) => bpts[q]);
            const diam = Math.max(...pts.map((p, i) => Math.max(...pts.map((q) =>
                (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2))));
            for (const mirrored of [false, true]) {
                const mp = mirrored ? pts.map((p) => [p[0], -p[1]]) : pts;
                const code = quadCode(mp);
                if (code) imageQuads.push({quad, code, mirrored, diam, reach: i3});
            }
        }
    }
    // Large quads first: their codes are the least noise-sensitive. But BANDED by neighbour
    // reach before size: quads drawn purely from each anchor's 7 nearest neighbours keep
    // exactly the sequence every solved clip was calibrated against, and the depth-9
    // extension quads follow. Without the banding the extension's quads - farther neighbours,
    // so LARGER - sort ahead of the old ones and push them past the hypothesis budget, which
    // turned two wide-field solves into refusals the moment the depth grew. Extension quads
    // only ever get budget the old sequence failed to convert.
    imageQuads.sort((p, q) =>
        (p.reach <= 6 ? 0 : p.reach) - (q.reach <= 6 ? 0 : q.reach) || q.diam - p.diam);

    if (DIAG) {
        Object.assign(DIAG, {
            nImage, nQuadStars: bpts.length, nImageQuads: imageQuads.length,
            width, tolPx, centerPx, bounds, nDeep: deep.length,
            scalePrior: O.scalePrior ?? null,
        });
    }

    const candidates = [];
    let tried = 0;

    for (const index of indexes) {
        const codeTol = index.tier?.codeTolerance ?? O.codeTolerance;
        const tierDiag = DIAG && {codes: index.n, tier: index.tier, codeTol, hits: 0, tried: 0,
            candidates: 0};
        if (tierDiag) DIAG.tiers.push(tierDiag);
        for (const iq of imageQuads) {
            if (tried >= O.maxHypotheses) break;
            const hits = lookupCode(index, iq.code, codeTol);
            if (tierDiag) tierDiag.hits += hits.length;
            for (const h of hits) {
                if (tried >= O.maxHypotheses) break;
                tried++;
                if (tierDiag) tierDiag.tried++;

                // Breathe every so often, so a caller showing progress can actually paint it.
                // Batched rather than per-hypothesis: most hypotheses are rejected within a few
                // microseconds by the cheap gates below, and awaiting on each would cost more
                // than the search itself.
                if (O.onYield && tried % 32 === 0) await O.onYield();

                // Hypothesis: similarity from image px (in this parity) to the tangent plane
                // about the catalog quad's anchor star.
                const catStars = [0, 1, 2, 3].map((j) => index.quads[h * 4 + j]);
                const c0 = raDecToVec(catalog.ra[catStars[0]], catalog.dec[catStars[0]]);
                const b0 = tangentBasis(c0);
                const P = [], Q = [];
                let degenerate = false;
                for (let j = 0; j < 4; j++) {
                    const s = iq.quad[j];
                    const sv = raDecToVec(catalog.ra[catStars[j]], catalog.dec[catStars[j]]);
                    const g = gnomonic(sv, c0, b0);
                    if (!g) { degenerate = true; break; }
                    P.push(iq.mirrored ? [bpts[s][0], -bpts[s][1]] : bpts[s]);
                    Q.push(g);
                }
                if (degenerate) { diagCount("rej.degenerateQuad"); continue; }
                const T = fitSimilarityFree(P, Q);
                if (!T) { diagCount("rej.similarityFit"); continue; }
                // The four points must actually agree with the fitted model before the
                // expensive verification runs.
                const scale = Math.hypot(T.A[0], T.A[1]);       // tangent units per px
                // A known plate scale is the strongest single prune there is: any hypothesis
                // whose implied scale is not the camera's is wrong regardless of how well its
                // four points agree.
                if (O.scalePrior
                    && Math.abs(scale - O.scalePrior) > O.scalePriorTolerance * O.scalePrior) {
                    diagCount("rej.scalePrior");
                    continue;
                }
                let quadRms = 0;
                for (let j = 0; j < 4; j++) {
                    const e = applySim(T, P[j][0], P[j][1]);
                    quadRms += (e[0] - Q[j][0]) ** 2 + (e[1] - Q[j][1]) ** 2;
                }
                if (Math.sqrt(quadRms / 4) > 2 * tolPx * scale) {
                    diagCount("rej.quadRms");
                    continue;
                }

                const cand = verifyHypothesis(imageStars, iq.mirrored, T, c0, b0, P, catStars,
                    catalog, deep, deepVec, tolPx, width, centerPx, bounds, O);
                if (!cand) continue;
                if (tierDiag) tierDiag.candidates++;
                // A quad that got this far passed the code lookup, the scale prior, the
                // four-point agreement gate AND full-field verification - so it is worth
                // showing. `fraction` is how much of the field this hypothesis explains, which
                // is the honest measure of how good it is: a wrong quad can fit its own four
                // points perfectly and still explain nothing else.
                if (O.onCandidate) {
                    O.onCandidate({
                        points: iq.quad.map((q) => [bpts[q][0], bpts[q][1]]),
                        mirrored: iq.mirrored,
                        matched: cand.matches.length,
                        nImage,
                        fraction: nImage ? cand.matches.length / nImage : 0,
                    });
                }
                candidates.push(cand);
                if (cand.matches.length >= O.earlyExitFraction * nImage) break;
            }
            if (candidates.length
                && candidates[candidates.length - 1].matches.length >= O.earlyExitFraction * nImage) {
                break;
            }
        }
        if (candidates.length) break;   // verified solves from a coarser tier need no deeper one
    }

    if (DIAG) { DIAG.tried = tried; DIAG.candidates = candidates.length; }
    if (!candidates.length) {
        return {ok: false, reason: `no verified match (${tried} hypotheses tried)`};
    }
    // Finalise candidates BEST-FIRST until one carries the full consensus. Refinement is the
    // stricter judge, and the best provisional is occasionally a lucky wrong one - discarding
    // the runners-up when it fails its finals would turn one impostor into a failed
    // identification of a perfectly solvable field.
    candidates.sort((a, b) => b.matches.length - a.matches.length);
    let lastFailure = null;
    for (const cand of candidates.slice(0, 5)) {
        const done = finishSolve(cand, imageStars, catalog, deep, deepVec, tolPx, width,
            centerPx, bounds, O);
        if (done.ok) return done;
        lastFailure = done;
    }
    return lastFailure;
}

/**
 * Project the in-field catalog into image pixels under (T, c0, b0) and greedily match the
 * detected stars against it, tolerance-gated. This is BOTH the verifier's evidence and the
 * refiner's rematch - the same projection, the same gate - so a pairing can never survive
 * refinement with a residual the verification tolerance would have rejected.
 *
 * @returns {{matches: Array, centre: number[], nProjected: number, expected: number}|null}
 *   null when the geometry is not a camera field at all (implausible scale, or nothing in
 *   view). `expected` is the chance-match count for THIS projection at THIS tolerance; it
 *   travels with the matches, exactly as nProjected does, so every later gate judges the
 *   evidence against the density it was actually collected at.
 */
function projectAndMatch(imageStars, mirrored, T, c0, b0, deep, deepVec, tolPx, width, centerPx,
    bounds, catalog, maxProjected) {
    const inv = invertSim(T);
    // TANGENT UNITS per pixel, not radians. Half a frame spans tan(fov/2), so an angle is the
    // ARCTANGENT of a tangent extent - the conversion scalePriorFromFov exists to get right at
    // the other end of the same pipeline. Treating the two as interchangeable is 8% off at
    // phone-lens widths and unbounded beyond, and because the next line is an UPPER BOUND the
    // error was one-directional: `width * scale * 0.75 > 1.2` rejected every centred gnomonic
    // field wider than about 77 degrees, however accurate, while claiming to allow 70 degrees
    // of RADIUS. The reference clip's own solve cleared it at 1.199 against the 1.2 ceiling.
    const scale = Math.hypot(T.A[0], T.A[1]);              // tangent units per px
    const fovRadiusRad = Math.atan(width * scale * 0.75);  // generous half-diagonal
    diagMax("fovRadiusRad", fovRadiusRad);
    if (fovRadiusRad > 1.2) {                              // >70 deg radius: not a camera field
        diagCount("rej.fovRadius");
        return null;
    }
    const minDot = Math.cos(Math.min(fovRadiusRad * 1.2, 1.4));

    // Where is the image centre on the sky, under this hypothesis?
    const cPlane = applySim(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
    const centre = unGnomonic(cPlane[0], cPlane[1], c0, b0);

    // Project the in-field catalog into image pixels - and keep only what lands INSIDE the
    // image. The angular gate is a circle around the centre, which for a letterboxed or
    // portrait frame covers far more sky than the rectangle sees; stars projecting off-frame
    // can match nothing, yet uncorrected they would consume the brightest-N cap and inflate
    // the consensus denominator until a valid narrow field fails identification.
    const bx0 = bounds[0] - tolPx, by0 = bounds[1] - tolPx;
    const bx1 = bounds[2] + tolPx, by1 = bounds[3] + tolPx;
    let proj = [];
    for (let k = 0; k < deep.length; k++) {
        const v = deepVec[k];
        if (v[0] * centre[0] + v[1] * centre[1] + v[2] * centre[2] < minDot) continue;
        const g = gnomonic(v, c0, b0);
        if (!g) continue;
        const p = applySim(inv, g[0], g[1]);
        const px = p[0], py = mirrored ? -p[1] : p[1];
        if (px < bx0 || px > bx1 || py < by0 || py > by1) continue;
        proj.push([px, py, deep[k]]);
    }
    diagMax("nProjectedRaw", proj.length);
    if (proj.length < 4) {
        diagCount("rej.tooFewProjected");
        return null;
    }
    // Cap the projected catalog at the brightest `maxProjected` stars in the field: matching
    // evidence depends on the catalog being SPARSE relative to the tolerance, and an uncapped
    // deep pool would let chance neighbours accumulate.
    if (maxProjected && proj.length > maxProjected) {
        proj.sort((a, b) => catalog.mag[a[2]] - catalog.mag[b[2]]);
        proj = proj.slice(0, maxProjected);
    }

    // Greedy nearest matching, image star to closest projected catalog star.
    const t2 = tolPx * tolPx;
    const usedCat = new Set();
    const matches = [];
    for (let i = 0; i < imageStars.length; i++) {
        let bd = t2, bj = -1;
        for (let j = 0; j < proj.length; j++) {
            if (usedCat.has(j)) continue;
            const dd = (proj[j][0] - imageStars[i].x) ** 2 + (proj[j][1] - imageStars[i].y) ** 2;
            if (dd < bd) { bd = dd; bj = j; }
        }
        if (bj >= 0) {
            usedCat.add(bj);
            matches.push({image: i, cat: proj[bj][2], dPx: Math.sqrt(bd)});
        }
    }
    // How many of these matches COINCIDENCE alone would produce: with the projected catalog
    // this dense and the tolerance this wide, each image star has a chance hit probability of
    // 1 - exp(-density * pi * tol^2). The match count is only evidence in the amount it
    // EXCEEDS this.
    const area = Math.max(1, (bx1 - bx0) * (by1 - by0));
    const pChance = 1 - Math.exp(-proj.length * Math.PI * t2 / area);
    const expected = imageStars.length * pChance;
    return {matches, centre, nProjected: proj.length, expected};
}

/** The consensus a match set must reach: a fraction of what COULD have matched. An image far
 * deeper than the verification catalog - a 12-megapixel astrophoto against a mag-7 pool - has
 * hundreds of stars with no possible counterpart, and a fraction of the raw image count would
 * be unreachable by any correct solve. Matching most of what the catalog can show in the field
 * is the evidence; the image's surplus depth is not evidence against. */
function consensusNeeded(nImage, nProjected, fraction) {
    return fraction * Math.min(nImage, nProjected);
}

/** The density-aware half of acceptance: does the match count EXCEED what coincidence would
 * produce against the projection these matches came from? `expected` must be the figure
 * projectAndMatch computed alongside the matches - pairing a match set with another
 * projection's expectation is a gate judging arithmetic that never happened. */
function chanceOK(O, nMatches, expected) {
    const e = expected ?? 0;
    return nMatches >= e + Math.max(O.chanceMarginMin, O.chanceSigmas * Math.sqrt(e));
}

/** Final acceptance: beat coincidence (chanceOK - no fraction can stand in for it, see the
 * defaults), AND carry the full narrow-field fraction OR the strong absolute count at the
 * reduced fraction floor (see strongMatchCount - wide similarity-stitched mosaics cap the
 * reachable fraction near one half regardless of correctness). */
function consensusMet(O, nImage, nMatches, nProjected, expected) {
    if (!chanceOK(O, nMatches, expected)) return false;
    if (nMatches >= consensusNeeded(nImage, nProjected, O.minMatchFraction)) return true;
    return nMatches >= O.strongMatchCount
        && nMatches >= consensusNeeded(nImage, nProjected, O.strongMatchFraction);
}

/** The acceptance arithmetic, spelled out for diagnostics. Both gates are quoted whether they
 * passed or not, because the interesting failure is the one that misses by a star or two - and
 * the denominator (min of the image count and what the catalog could even show) is the term
 * that moves when the caller changes the input star set. */
function consensusDetail(O, nImage, nMatches, nProjected, expected) {
    const denom = Math.min(nImage, nProjected);
    return {
        nMatches, nImage, nProjected, denom, expected,
        fraction: denom ? nMatches / denom : 0,
        needNarrow: consensusNeeded(nImage, nProjected, O.minMatchFraction),
        needStrong: consensusNeeded(nImage, nProjected, O.strongMatchFraction),
        strongCount: O.strongMatchCount,
        chanceOK: chanceOK(O, nMatches, expected),
        met: consensusMet(O, nImage, nMatches, nProjected, expected),
    };
}

/**
 * Verify one hypothesis PROVISIONALLY: the detected stars must be where the catalog says stars
 * are, in numbers coincidence does not produce - at the modest bar a four-point transform can
 * actually reach. Final acceptance happens after refinement, at full consensus.
 *
 * The tangent point is RE-CENTRED on the image centre before anything is projected. A pinhole
 * camera is exactly "gnomonic about the optical axis, then a similarity" - but the hypothesis
 * arrives projected about the CATALOG QUAD'S anchor, which on a phone-lens field can sit 30
 * degrees from the image centre, and about the wrong tangent point even a correct hypothesis
 * carries tens of pixels of pure projection distortion and dies here, never reaching the
 * refinement that would have re-centred it. About the right tangent point the model is exact,
 * for any field of view.
 */
function verifyHypothesis(imageStars, mirrored, T, c0, b0, P, catQ, catalog, deep, deepVec, tolPx, width, centerPx, bounds, O) {
    // Where does this hypothesis put the image centre? Re-anchor there and refit the quad.
    const cPlane = applySim(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
    const c1 = unGnomonic(cPlane[0], cPlane[1], c0, b0);
    const b1 = tangentBasis(c1);
    const Q1 = [];
    for (const ci of catQ) {
        const g = gnomonic(raDecToVec(catalog.ra[ci], catalog.dec[ci]), c1, b1);
        if (!g) { diagCount("rej.recentreBehind"); return null; }
        Q1.push(g);
    }
    const T1 = fitSimilarityFree(P, Q1);
    if (!T1) { diagCount("rej.recentreFit"); return null; }

    const pm = projectAndMatch(imageStars, mirrored, T1, c1, b1, deep, deepVec, tolPx, width, centerPx, bounds);
    if (!pm) return null;                                  // projectAndMatch counted its own
    const {matches} = pm;
    diagMax("provisionalMatches", matches.length);
    if (matches.length < O.minMatches) { diagCount("rej.minMatches"); return null; }
    if (!chanceOK(O, matches.length, pm.expected)) {
        diagCount("rej.provisionalChance");
        return null;
    }
    if (matches.length < consensusNeeded(imageStars.length, pm.nProjected, O.provisionalMatchFraction)) {
        diagCount("rej.provisionalFraction");
        return null;
    }
    // nProjected travels WITH the matches. It is the denominator every consensus test divides
    // by, so a match set and a projection count from different projections is a gate judging
    // arithmetic that never happened.
    return {matches, mirrored, T: T1, c0: c1, b0: b1, nProjected: pm.nProjected,
        expected: pm.expected};
}

/**
 * Refine the accepted hypothesis and package the answer. Each round keeps three things
 * mutually consistent - the tangent basis, the transform, and the match set:
 *
 *   1. the tangent point moves to where the current model puts the image centre (gnomonic
 *      distortion is smallest about its own tangent point);
 *   2. the transform is REFIT in that new basis - reusing a transform across a basis change
 *      would mix coordinate systems, and every reported quantity would inherit the mix;
 *   3. the catalog is REMATCHED under the refit transform with the verification tolerance -
 *      so wrong initial pairings are dropped the moment their residual exceeds it, and stars
 *      the four-point hypothesis missed are pulled in.
 *
 * The final numbers all come from the last consistent (basis, transform, matches) triple.
 */
function finishSolve(best, imageStars, catalog, deep, deepVec, tolPx, width, centerPx, bounds, O) {
    let {matches, mirrored} = best;
    let T = best.T, c0 = best.c0, b0 = best.b0;

    // The refinement rematches against a DEPTH-ADAPTIVE pool: the whole catalog, capped to the
    // brightest ~3x the image's star count within the field. Hypothesis verification stays on
    // the shallow pool - sparse is what makes its evidence strong - but once the field is
    // established, a deep image's fainter stars deserve names too, and the cap keeps the
    // catalog density bounded so tolerance matching stays honest.
    const byMag = new Int32Array(catalog.n);
    for (let i = 0; i < catalog.n; i++) byMag[i] = i;
    byMag.sort((a, b) => catalog.mag[a] - catalog.mag[b]);
    const allIdx = Array.from(byMag);
    const allVec = allIdx.map((i) => raDecToVec(catalog.ra[i], catalog.dec[i]));
    const maxProjected = Math.max(3 * imageStars.length, 100);
    // The count that came WITH these matches, from the projection that produced them. It used to
    // be `min(deep.length, maxProjected)` - the whole SKY's verification pool clipped by the cap,
    // a number no projection ever produced. Since the final gate divides by it, and it is only
    // reached when refinement rolled back, that stated a denominator far larger than the field
    // really held and so demanded more matches than the evidence could ever supply: conservative,
    // but conservative by accident, and it made the diagnostics quote a figure that was fiction.
    let nProjected = best.nProjected ?? matches.length;
    let expected = best.expected ?? 0;

    // One record per finalist: what refinement did to it, and the acceptance arithmetic it was
    // finally judged on. "refinement lost the match consensus" is the same sentence whether the
    // rematch collapsed, a round rolled back, or the match set never moved and the DENOMINATOR
    // grew - and those want completely different fixes.
    const fin = DIAG && {provisional: matches.length, rounds: [], nProjected, expected};
    if (fin) DIAG.finalists.push(fin);

    let committedAny = false;
    for (let round = 0; round < O.refineRounds; round++) {
        // The round either completes wholly or leaves no trace: a break after the refit would
        // pair the NEW transform with the OLD matches and residuals - the exact stale mixture
        // this loop exists to prevent - so every failure path restores the last triple that
        // was verified together.
        const prev = {T, c0, b0, matches, nProjected, expected};

        // 1. Re-centre the tangent point on the image centre, under the current model.
        const cPlane = applySim(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
        c0 = unGnomonic(cPlane[0], cPlane[1], c0, b0);
        b0 = tangentBasis(c0);

        // 2. Refit the transform in the NEW basis, over the current matches.
        const P = matches.map((m) => {
            const s = imageStars[m.image];
            return [s.x, mirrored ? -s.y : s.y];
        });
        const Q = matches.map((m) => {
            const g = gnomonic(raDecToVec(catalog.ra[m.cat], catalog.dec[m.cat]), c0, b0);
            return g || [0, 0];
        });
        // ROBUST here, plain least squares everywhere else: this is the one fit whose input is a
        // whole match set collected at tolerance rather than four hand-picked quad stars.
        const refit = fitSimilarityRobust(P, Q);
        if (!refit) {
            if (fin) fin.rounds.push({round, rolledBack: "refitFailed"});
            ({T, c0, b0, matches, nProjected} = prev);
            break;
        }
        T = refit;

        // 3. Rematch, tolerance-gated, under the refit model against the deep pool. A rematch
        // is only COMMITTED if it would itself pass the acceptance gates - both of them.
        // Committing on the count alone lets a rematch that kept eight stars but lost the
        // required consensus through, and the final gate then rejects a solve that was valid
        // before refinement touched it, instead of the failed round being rolled back.
        const pm = projectAndMatch(imageStars, mirrored, T, c0, b0, allIdx, allVec, tolPx,
            width, centerPx, bounds, catalog, maxProjected);
        // A FIRST-round rematch that cannot re-find even half the provisional matches under
        // its own refit is not a failed refinement to roll back from - it is the provisional
        // count confessing to being chance. Both wrong-field acceptances measured on the
        // Giddierone pan windows worked exactly this way: a dense wide-tier projection scraped
        // past the gates (chance bar cleared by under half a match), the rematch collapsed
        // 26->5 and 25->8, and the rollback let the final gate judge the unrefined arithmetic.
        // Disqualifying the CANDIDATE (not the solve - the caller tries the runners-up) closes
        // that path; a genuine field re-finds its matches, and did in every healthy solve of
        // both captured runs of that clip.
        if (round === 0 && (!pm || pm.matches.length < Math.ceil(prev.matches.length / 2))) {
            diagCount("rej.rematchCollapse");
            return {ok: false, reason: "round-0 rematch collapsed"};
        }
        if (!pm || pm.matches.length < O.minMatches
            || !consensusMet(O, imageStars.length, pm.matches.length, pm.nProjected, pm.expected)) {
            if (fin) {
                fin.rounds.push({round, rolledBack: !pm ? "projectNull" : "rematchBelowGates",
                    ...(pm ? consensusDetail(O, imageStars.length, pm.matches.length,
                        pm.nProjected, pm.expected) : {})});
            }
            ({T, c0, b0, matches, nProjected, expected} = prev);
            break;
        }
        if (fin) {
            fin.rounds.push({round, committed: pm.matches.length,
                ...consensusDetail(O, imageStars.length, pm.matches.length, pm.nProjected,
                    pm.expected)});
        }
        matches = pm.matches;
        nProjected = pm.nProjected;
        expected = pm.expected;
        committedAny = true;
    }

    // A final judged on PROVISIONAL arithmetic alone - no refinement round ever recommitted
    // the match set - has never had its count independently reproduced, so it must clear the
    // chance bar with margin rather than by a fraction of a match, which is precisely how the
    // measured wide-tier impostors survived (clearances of 0.34 and 0.46 matches).
    if (!committedAny
        && matches.length < expected
            + Math.max(O.chanceMarginMin, O.chanceSigmas * Math.sqrt(expected)) + 2) {
        diagCount("rej.provisionalFinalMargin");
        return {ok: false, reason: "provisional-only final lacks chance margin"};
    }

    // Refinement only ever rematches with the verification gate, but hold the acceptance
    // criteria at the end regardless - a solve that degrades below them must not ship.
    if (fin) {
        Object.assign(fin, {final: matches.length, nProjected},
            consensusDetail(O, imageStars.length, matches.length, nProjected, expected));
    }
    if (matches.length < O.minMatches
        || !consensusMet(O, imageStars.length, matches.length, nProjected, expected)) {
        return {ok: false, reason: "refinement lost the match consensus"};
    }

    const scale = Math.hypot(T.A[0], T.A[1]);              // tangent units per px
    const cPlane = applySim(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
    const centre = unGnomonic(cPlane[0], cPlane[1], c0, b0);
    const {ra, dec} = vecToRaDec(centre);

    // Roll: where does "image up" point on the sky? The angle of A maps image axes to
    // east/north; report the position angle of the image's up direction, east of north.
    const up = applySim({A: T.A, B: [0, 0]}, 0, mirrored ? 1 : -1);
    const rollDeg = Math.atan2(up[0], up[1]) * 180 / Math.PI;

    let sse = 0;
    for (const m of matches) sse += m.dPx * m.dPx;

    return {
        ok: true,
        matches: matches.map((m) => ({
            image: m.image,
            cat: m.cat,
            hip: catalog.hip[m.cat],
            raDeg: catalog.ra[m.cat] * 180 / Math.PI,
            decDeg: catalog.dec[m.cat] * 180 / Math.PI,
            mag: catalog.mag[m.cat],
            dPx: m.dPx,
        })),
        centerRaDeg: ra * 180 / Math.PI,
        centerDecDeg: dec * 180 / Math.PI,
        // The field the model implies IF the frame were rectilinear: half of it spans
        // width*scale/2 TANGENT units, so the half-angle is that arctangent. (A real fisheye
        // frame covers more sky than this over the same pixels - `scale` is the plate scale at
        // the centre and this extrapolates it, it does not measure the lens.)
        fovDeg: 2 * Math.atan(width * scale / 2) * 180 / Math.PI,
        rollDeg,
        // Pixels per degree AT THE FIELD CENTRE, where d(tangent)/d(theta) is 1. Consumers that
        // want a frame-wide angle must go back through the arctangent (starTrackVfovDeg does).
        pxPerDeg: (Math.PI / 180) / scale,
        mirrored,
        nImage: imageStars.length,
        matchedFraction: matches.length / imageStars.length,
        rmsPx: Math.sqrt(sse / matches.length),
        // The verification tolerance this solve matched at. Residuals are only comparable
        // ACROSS solves when normalised by it - it scales with the field width, so two windows
        // of one pan can hold the same star to different pixel standards.
        tolPx,
        // The full calibration as a function: any reference-frame pixel to its place on the
        // sky under the final model. This is the bridge a camera sync needs - the per-frame
        // transforms give each video frame's centre in reference pixels, and this turns that
        // into a celestial pointing.
        refToSky: (x, y) => {
            const pl = applySim(T, x, mirrored ? -y : y);
            const v = unGnomonic(pl[0], pl[1], c0, b0);
            const rd = vecToRaDec(v);
            return {raDeg: rd.ra * 180 / Math.PI, decDeg: rd.dec * 180 / Math.PI};
        },
        // The raw plate model, for certifySolve: re-verifying this pose against a DIFFERENT
        // star set needs the same projection the solve itself used, not a reconstruction.
        model: {T, c0, b0, mirrored},
    };
}

/**
 * Re-verify an accepted solve's pose against a (typically larger) star set, with the same
 * projection, matching, and acceptance arithmetic the solve itself was held to.
 *
 * Exists for solve attempts made on a REDUCED view of the evidence - the failure ladder caps
 * the input to the most persistent tracks when the full set will not solve. Capping shrinks
 * every consensus denominator, which makes acceptance structurally easier, so a capped view's
 * solve may not label stars or steer a camera until the pose has been certified against the
 * evidence that was actually collected: all of it.
 *
 * @param {object} solved - an ok solve from {@link solveField} (carries .model)
 * @param {Array} fullStars - the UNCAPPED star set, same coordinate frame as the solve input
 * @param {object} catalog - from {@link parseStarCatalog}
 * @param {object} [opts] - overrides of STAR_IDENTIFY_DEFAULTS (the caller's solve opts)
 * @returns {{ok: boolean, reason?: string, matches?: Array, rmsPx?: number, nImage?: number,
 *   matchedFraction?: number, tolPx?: number}} matches index into fullStars.
 */
export function certifySolve(solved, fullStars, catalog, opts = {}) {
    if (!solved?.ok || !solved.model) return {ok: false, reason: "nothing to certify"};
    const O = {...STAR_IDENTIFY_DEFAULTS, ...opts};
    const {T, c0, b0, mirrored} = solved.model;

    // The verification geometry of the FULL set: its own bounds, its own tolerance. Using the
    // capped view's smaller field here would understate the area the chance arithmetic
    // divides by, which is the exact laxity certification exists to remove.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const s of fullStars) {
        if (s.x < bx0) bx0 = s.x;
        if (s.x > bx1) bx1 = s.x;
        if (s.y < by0) by0 = s.y;
        if (s.y > by1) by1 = s.y;
    }
    const pad = 12;
    const bounds = opts.bounds ?? [bx0 - pad, by0 - pad, bx1 + pad, by1 + pad];
    const width = opts.width ?? Math.max(bx1 - bx0, by1 - by0);
    const centerPx = opts.center ?? [(bx0 + bx1) / 2, (by0 + by1) / 2];
    const tolPx = Math.max(O.verifyPixelMin, O.verifyPixelFraction * width);

    const deep = [];
    for (let i = 0; i < catalog.n; i++) {
        if (catalog.mag[i] <= O.verifyMagLimit) deep.push(i);
    }
    const deepVec = deep.map((i) => raDecToVec(catalog.ra[i], catalog.dec[i]));

    const pm = projectAndMatch(fullStars, mirrored, T, c0, b0, deep, deepVec, tolPx,
        width, centerPx, bounds, catalog, Math.max(3 * fullStars.length, 100));
    if (!pm) return {ok: false, reason: "pose does not project as a camera field"};
    if (pm.matches.length < O.minMatches
        || !consensusMet(O, fullStars.length, pm.matches.length, pm.nProjected, pm.expected)) {
        return {ok: false, reason: "pose does not hold the full set's consensus",
            matches: pm.matches, nImage: fullStars.length};
    }
    let sse = 0;
    for (const m of pm.matches) sse += m.dPx * m.dPx;
    return {
        ok: true,
        matches: pm.matches.map((m) => ({
            image: m.image,
            cat: m.cat,
            hip: catalog.hip[m.cat],
            raDeg: catalog.ra[m.cat] * 180 / Math.PI,
            decDeg: catalog.dec[m.cat] * 180 / Math.PI,
            mag: catalog.mag[m.cat],
            dPx: m.dPx,
        })),
        rmsPx: Math.sqrt(sse / pm.matches.length),
        nImage: fullStars.length,
        matchedFraction: pm.matches.length / fullStars.length,
        tolPx,
    };
}

// =============================================================================================
// WINDOWED identification, for panning clips.
//
// A pan's reference chart is stitched from per-frame similarities, and the stitching drift
// accumulates over TIME - measured at 1.3 degrees end to end on a 671-frame superzoom pan,
// against a 6 px verification tolerance. One plate model can only fit one stretch of such a
// chart: the full-chart solve of that clip matched 42 of 123 stars, all from the late pan, and
// the frames the video actually opens on (Vega among them) got nothing. Worse, the drift
// re-enters broken tracks as DUPLICATE chart entries (~17% of that clip's identify set), so a
// single model's consensus denominator is permanently inflated.
//
// The warp is invisible over a short enough time span: tracks observed TOGETHER are chart-
// consistent to a couple of pixels even when the whole chart is not. So: solve overlapping
// time windows of tracks with the ordinary solveField - every gate applies per window - and
// merge the labels. Validated on two independent captures of the same clip: 100/123 labeled
// (from 42) with a 25/25 per-label audit on the healthy capture; and on a degraded capture
// whose full chart does not solve at all, the one healthy window still labels Vega + 27 with
// a clean audit, where the single-model path would deliver nothing.
//
// Windows cannot be cut blindly. Blur bursts break every track at once - a "wall" - and the
// wall SPLITS the chart into two drift regimes. A window whose brightest stars straddle a wall
// mixes the regimes and generates zero correct-field quad hypotheses (measured: solving
// windows ride on exactly ONE viable quad each; the straddling window had none, while the
// correct field, force-fitted, would have passed every gate with 40 of 61 matches). Walls also
// MOVE between analyses of the same clip (~80 frames between the two captures), so boundaries
// are cut from the track-break structure of the run at hand, never at fixed frames.
// =============================================================================================

export const STAR_WINDOW_DEFAULTS = {
    // Parameter-swept on the Giddierone captures: any width in [160, 220] with any step and
    // any in-window floor in [8, 25] labels 100-106 of 123 with a clean audit; at >= 300 the
    // within-window drift breaks the rigid-fit assumption and coverage collapses to 71 with
    // outright mislabels. 220 is the top of the safe plateau.
    maxWindowFrames: 220,
    minWindowFrames: 60,        // walls closer than this to the clip ends are not worth a cut
    minWindowObs: 15,           // ACTUAL observed frames a track needs in-window to join it
    minWindowStars: 8,          // fewer and the window is skipped, not solved
    wallBinFrames: 20,
    // Windowing engages when the chart's robust span exceeds this factor of the video frame -
    // 3rd-lowest to 3rd-highest star coordinate, so a lone mis-tracked outlier (which a plain
    // bbox would follow) cannot trigger it; three tracks must support the excess.
    panSpanFactor: 1.25,
};

/** Does the chart say "pan"? Robust span (3rd-lowest..3rd-highest star coordinate) beyond
 *  panSpanFactor x the video frame on either axis. Under six stars there is no robust span. */
export function chartSpansBeyondFrame(stars, videoW, videoH, O = STAR_WINDOW_DEFAULTS) {
    if (stars.length < 6 || !videoW || !videoH) return false;
    const xs = stars.map((s) => s.x).sort((a, b) => a - b);
    const ys = stars.map((s) => s.y).sort((a, b) => a - b);
    const spanX = xs[xs.length - 3] - xs[2];
    const spanY = ys[ys.length - 3] - ys[2];
    return spanX > O.panSpanFactor * videoW || spanY > O.panSpanFactor * videoH;
}

/**
 * Wall frames, from the observation spans of the identify-eligible tracks: bin span starts and
 * ends, flag bins holding at least max(4, 3 x median) of them, merge adjacent flagged bins into
 * one wall at their mass-weighted centre. Spans touching the clip ends are not breaks.
 */
export function detectTrackWalls(spans, totalFrames, O = STAR_WINDOW_DEFAULTS) {
    const bin = O.wallBinFrames;
    const nBins = Math.max(1, Math.ceil(totalFrames / bin));
    const mass = new Array(nBins).fill(0);
    for (const [f0, f1] of spans) {
        if (f0 > 0) mass[Math.min(nBins - 1, Math.floor(f0 / bin))]++;
        if (f1 < totalFrames - 1) mass[Math.min(nBins - 1, Math.floor(f1 / bin))]++;
    }
    const sorted = [...mass].sort((a, b) => a - b);
    const thresh = Math.max(4, 3 * sorted[nBins >> 1]);
    const walls = [];
    for (let i = 0; i < nBins; i++) {
        if (mass[i] < thresh) continue;
        const frame = i * bin + bin / 2;
        const last = walls[walls.length - 1];
        if (last && frame - last.frame <= bin * 1.5) {
            last.frame = (last.frame * last.mass + frame * mass[i]) / (last.mass + mass[i]);
            last.mass += mass[i];
        } else {
            walls.push({frame, mass: mass[i]});
        }
    }
    return walls.map((w) => Math.round(w.frame));
}

/**
 * Cut [0, totalFrames) at the walls, then split any between-wall span longer than
 * maxWindowFrames into evenly-stepped windows of exactly maxWindowFrames that overlap by at
 * least half. Deterministic: with no walls a 671-frame clip yields six 220-frame windows
 * stepping ~90. Windows are half-open [w0, w1).
 */
export function planIdentifyWindows(walls, totalFrames, O = STAR_WINDOW_DEFAULTS) {
    const cuts = [0,
        ...walls.filter((w) => w > O.minWindowFrames && w < totalFrames - O.minWindowFrames),
        totalFrames];
    const windows = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
        const a = cuts[i], b = cuts[i + 1], span = b - a;
        if (span <= O.maxWindowFrames) {
            windows.push([a, b]);
            continue;
        }
        const n = Math.ceil((2 * span) / O.maxWindowFrames) - 1;
        const step = (span - O.maxWindowFrames) / (n - 1 || 1);
        for (let k = 0; k < n; k++) {
            const w0 = Math.round(a + k * step);
            windows.push([w0, Math.min(b, w0 + O.maxWindowFrames)]);
        }
    }
    return windows;
}

/**
 * Quarantine windows that contradict the consensus. Per-window gates are necessary but not
 * sufficient: a wide-tier hypothesis once passed every gate with a wholly wrong field and
 * would have shipped five labels up to 134 degrees wrong - two of them on tracks no other
 * window matched, invisible to any per-track check. Its signature was unmistakable at the
 * WINDOW level: 13 of its 13 labels shared with neighbours disagreed.
 *
 * Windows pair when they label >= 3 of the same tracks; a pair is compatible when agreements
 * outnumber disagreements. The largest connected component of compatible windows (ties broken
 * by total matches) is the chain; a window conflicting with any chain member is quarantined.
 * A chain needs two windows - a lone disagreeing PAIR is never arbitrated, because healthy
 * windows legitimately disagree on the odd drift-displaced fragment and per-track majority
 * voting is anti-signal there (correlated windows repeat the same fragment mislabel).
 */
export function quarantineWindows(accepted) {
    const n = accepted.length;
    const labelSets = accepted.map((w) => {
        const m = new Map();
        for (const match of w.solved.matches) m.set(w.sub[match.image].index, match.hip);
        return m;
    });
    const compatible = [], conflicting = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            let agree = 0, disagree = 0;
            for (const [index, hip] of labelSets[i]) {
                const other = labelSets[j].get(index);
                if (other === undefined) continue;
                if (other === hip) agree++; else disagree++;
            }
            if (agree + disagree < 3) continue;
            (agree > disagree ? compatible : conflicting).push([i, j]);
        }
    }
    const comp = accepted.map((_, i) => i);
    const find = (start) => {
        let i = start;
        while (comp[i] !== i) {
            comp[i] = comp[comp[i]];
            i = comp[i];
        }
        return i;
    };
    for (const [i, j] of compatible) comp[find(i)] = find(j);
    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(i);
    }
    let chain = [];
    let chainMatches = -1;
    for (const members of groups.values()) {
        const total = members.reduce((s, i) => s + accepted[i].solved.matches.length, 0);
        if (members.length > chain.length
            || (members.length === chain.length && total > chainMatches)) {
            chain = members;
            chainMatches = total;
        }
    }
    if (chain.length < 2) return accepted.map(() => false);
    const inChain = new Set(chain);
    const out = accepted.map(() => false);
    for (const [i, j] of conflicting) {
        if (inChain.has(i) && !inChain.has(j)) out[j] = true;
        if (inChain.has(j) && !inChain.has(i)) out[i] = true;
    }
    return out;
}

/**
 * One label per track from the surviving windows, decided LEXICOGRAPHICALLY: most in-window
 * observations first (the window that watched the track longest is the one whose chart regime
 * it belongs to), then residual normalised by that window's own tolerance. Never a weighted
 * score, and never a vote: measured across the captures, the coverage-first rule resolved
 * every cross-window disagreement correctly, while two correlated windows repeating one
 * fragment mislabel would have outvoted the single window that had it right.
 */
export function mergeWindowLabels(surviving) {
    const labels = new Map();
    const disputes = [];
    for (const w of surviving) {
        for (const m of w.solved.matches) {
            const star = w.sub[m.image];
            const cand = {hip: m.hip, cat: m.cat, raDeg: m.raDeg, decDeg: m.decDeg,
                mag: m.mag, dPx: m.dPx, cover: star.cover,
                norm: m.dPx / (w.solved.tolPx || 1), window: [w.w0, w.w1]};
            const prev = labels.get(star.index);
            if (!prev) {
                labels.set(star.index, cand);
                continue;
            }
            const better = cand.cover > prev.cover
                || (cand.cover === prev.cover && cand.norm < prev.norm);
            if (cand.hip !== prev.hip) {
                disputes.push({index: star.index, kept: better ? cand.hip : prev.hip,
                    dropped: better ? prev.hip : cand.hip});
            }
            if (better) labels.set(star.index, cand);
        }
    }
    return {labels, disputes};
}

/**
 * The windowed identification: plan wall-aware windows, solve each with the ordinary tier
 * cascade, quarantine inconsistent windows, merge labels.
 *
 * @param {Array} stars       identify-eligible tracks: {x, y, mag, index, obsF, ...}, where
 *                            obsF is the track's ACTUAL observation frames - tracks are gappy,
 *                            and span-based membership admits stars a window barely saw.
 * @param {Array} indexes     quad indexes in the order to try them (the caller owns tier order)
 * @param {Object} opts       {videoW, videoH, transforms, totalFrames, solveOpts, windowOpts,
 *                            onWindowStatus(k, n), shouldStop}
 * @returns {{ok: boolean, windows: Array, labels: Map, disputes: Array, primary, partial,
 *          covered: Array}|null}  null only when shouldStop asked for an abort.
 */
export async function solveFieldWindowed(stars, catalog, indexes, opts) {
    const O = {...STAR_WINDOW_DEFAULTS, ...(opts.windowOpts ?? {})};
    const totalFrames = opts.totalFrames ?? opts.transforms?.length ?? 0;
    const spans = stars.map((s) => [s.obsF[0], s.obsF[s.obsF.length - 1]]);
    const walls = detectTrackWalls(spans, totalFrames, O);
    const planned = planIdentifyWindows(walls, totalFrames, O);

    const windows = [];
    const accepted = [];
    for (let k = 0; k < planned.length; k++) {
        if (opts.shouldStop?.()) return null;
        const [w0, w1] = planned[k];
        const sub = [];
        for (const s of stars) {
            let cover = 0;
            for (const f of s.obsF) if (f >= w0 && f < w1) cover++;
            if (cover >= O.minWindowObs) sub.push({...s, cover});
        }
        const rec = {w0, w1, nStars: sub.length, ok: false};
        windows.push(rec);
        if (sub.length < O.minWindowStars) {
            rec.reason = "too few stars";
            continue;
        }
        // Bounds: where the video ACTUALLY looked during this window (the frame rectangle's
        // corners taken back into chart coordinates - transforms map chart to video, so via
        // the inverse), unioned with the member stars. Never the frame-0 rectangle: for a late
        // window that is an empty, temporally unrelated region whose area would only dilute
        // the chance arithmetic and widen the tolerance.
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        const take = (x, y) => {
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
            if (y < by0) by0 = y;
            if (y > by1) by1 = y;
        };
        const transforms = opts.transforms ?? [];
        const takeThrough = (S, x, y) =>
            take(S.A[0] * x - S.A[1] * y + S.B[0], S.A[1] * x + S.A[0] * y + S.B[1]);
        for (let f = w0; f < Math.min(w1, transforms.length); f++) {
            const T = transforms[f];
            // invertSim divides by |A|^2 - a degenerate similarity would poison the bounds
            // with infinities, so it is skipped rather than inverted.
            if (!T || T.A[0] * T.A[0] + T.A[1] * T.A[1] < 1e-12) continue;
            const inv = invertSim(T);
            takeThrough(inv, 0, 0);
            takeThrough(inv, opts.videoW, 0);
            takeThrough(inv, 0, opts.videoH);
            takeThrough(inv, opts.videoW, opts.videoH);
        }
        if (!Number.isFinite(bx0)) {
            // No usable transforms (fixture replay, or every in-window transform degenerate):
            // the untransformed video rectangle is the only footprint estimate left.
            take(0, 0);
            take(opts.videoW, opts.videoH);
        }
        for (const s of sub) take(s.x, s.y);
        const pad = 12;
        const windowSolveOpts = {
            ...(opts.solveOpts ?? {}),
            center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
            width: Math.max(bx1 - bx0, by1 - by0),
            bounds: [bx0 - pad, by0 - pad, bx1 + pad, by1 + pad],
        };
        opts.onWindowStatus?.(k + 1, planned.length);
        let solved = null;
        for (const index of indexes) {
            if (opts.shouldStop?.()) return null;
            const attempt = await solveField(sub, catalog, [index], windowSolveOpts);
            if (attempt.ok) {
                solved = attempt;
                break;
            }
            rec.reason = attempt.reason;
        }
        if (!solved) continue;
        rec.ok = true;
        delete rec.reason;
        rec.solved = solved;
        accepted.push({w0, w1, solved, sub, rec});
    }

    const quarantined = quarantineWindows(accepted);
    const surviving = accepted.filter((w, i) => {
        if (quarantined[i]) w.rec.quarantined = true;
        return !quarantined[i];
    });
    const {labels, disputes} = mergeWindowLabels(surviving);

    // Compatibility primary: the window the reference frame lives in, best-first, because its
    // refToSky is the one whose neighbourhood the video opens on. Deterministic fallback when
    // no surviving window contains frame 0.
    const byQuality = (a, b) => b.solved.matches.length - a.solved.matches.length || a.w0 - b.w0;
    const primary = surviving.filter((w) => w.w0 === 0).sort(byQuality)[0]
        ?? [...surviving].sort(byQuality)[0] ?? null;

    // Covered frame ranges, merged. Windowed pose and the partial flag both read from this.
    const covered = [];
    for (const w of [...surviving].sort((a, b) => a.w0 - b.w0)) {
        const last = covered[covered.length - 1];
        if (last && w.w0 <= last[1]) last[1] = Math.max(last[1], w.w1);
        else covered.push([w.w0, w.w1]);
    }
    const partial = covered.length !== 1 || covered[0][0] > 0 || covered[0][1] < totalFrames;

    return {ok: surviving.length > 0, windows, labels, disputes, primary, partial, covered,
        surviving};
}

/**
 * The vertical field of view at one analysed frame, from the surviving windows that cover it -
 * blended with the same triangular weights the pose uses, so a zoom that the windows resolved
 * as different plate scales bakes into a smoothly varying FOV rather than one window's
 * constant. Returns null on an uncovered frame (the pose is null there too).
 *
 * @param {Array} windows  [{w0, w1, solved}] surviving windows, solved.pxPerDeg present
 * @param {number} i       analysed-frame index
 * @param {number} videoH  decoded video height, px
 */
export function windowVfovDegAt(windows, i, videoH) {
    let sum = 0, wsum = 0;
    for (const w of windows) {
        if (i < w.w0 || i >= w.w1) continue;
        const wt = Math.min(i - w.w0 + 1, w.w1 - i);
        // Same tangent-space formula as starTrackVfovDeg: pxPerDeg holds at the field centre,
        // so half the frame spans (pi/180/pxPerDeg) * videoH/2 tangent units.
        const vfov = 2 * Math.atan((Math.PI / 180 / w.solved.pxPerDeg) * videoH / 2)
            * 180 / Math.PI;
        sum += wt * vfov;
        wsum += wt;
    }
    return wsum > 0 ? sum / wsum : null;
}
