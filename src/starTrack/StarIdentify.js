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

    // How many of the brightest image stars may form quads, and how many nearest neighbours
    // each draws its quad partners from. Bounded because quad count grows as C(k,3) per star.
    imageQuadStars: 25,
    imageNeighbors: 7,

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
    maxHypotheses: 3000,
    // Stop early once a hypothesis explains this fraction of the image stars.
    earlyExitFraction: 0.85,

    refineRounds: 2,

    // When the caller KNOWS the plate scale - camera optics metadata gives the field of view
    // exactly - hypotheses whose implied scale strays beyond this relative tolerance are
    // discarded before verification. Set `scalePrior` (radians per pixel) in the options.
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
 * @returns {{ok: boolean, reason?: string} | {ok: true, matches, centerRaDeg, centerDecDeg,
 *   fovDeg, rollDeg, pxPerDeg, mirrored, nImage, matchedFraction, rmsPx}}
 */
export function solveField(imageStars, catalog, indexes, opts = {}) {
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

    // The brightest sky-like image stars, each with its nearest bright neighbours, form the
    // image quads - the same generator the catalog index used, so the two populations overlap.
    const brightIdx = imageStars
        .map((s, i) => [s.mag ?? 0, i])
        .filter(([, i]) => neighborCounts[i] <= clutterMax)
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
                if (code) imageQuads.push({quad, code, mirrored, diam});
            }
        }
    }
    // Large quads first: their codes are the least noise-sensitive.
    imageQuads.sort((p, q) => q.diam - p.diam);

    let best = null;
    let tried = 0;

    for (const index of indexes) {
        const codeTol = index.tier?.codeTolerance ?? O.codeTolerance;
        for (const iq of imageQuads) {
            if (tried >= O.maxHypotheses) break;
            const hits = lookupCode(index, iq.code, codeTol);
            for (const h of hits) {
                if (tried >= O.maxHypotheses) break;
                tried++;

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
                if (degenerate) continue;
                const T = fitSimilarityFree(P, Q);
                if (!T) continue;
                // The four points must actually agree with the fitted model before the
                // expensive verification runs.
                const scale = Math.hypot(T.A[0], T.A[1]);       // rad per px
                // A known plate scale is the strongest single prune there is: any hypothesis
                // whose implied scale is not the camera's is wrong regardless of how well its
                // four points agree.
                if (O.scalePrior
                    && Math.abs(scale - O.scalePrior) > O.scalePriorTolerance * O.scalePrior) {
                    continue;
                }
                let quadRms = 0;
                for (let j = 0; j < 4; j++) {
                    const e = applySim(T, P[j][0], P[j][1]);
                    quadRms += (e[0] - Q[j][0]) ** 2 + (e[1] - Q[j][1]) ** 2;
                }
                if (Math.sqrt(quadRms / 4) > 2 * tolPx * scale) continue;

                const cand = verifyHypothesis(imageStars, iq.mirrored, T, c0, b0, P, catStars,
                    catalog, deep, deepVec, tolPx, width, centerPx, O);
                if (!cand) continue;
                if (!best || cand.matches.length > best.matches.length) best = cand;
                if (cand.matches.length >= O.earlyExitFraction * nImage) break;
            }
            if (best && best.matches.length >= O.earlyExitFraction * nImage) break;
        }
        if (best) break;      // a verified solve from a coarser tier needs no deeper one
    }

    if (!best) {
        return {ok: false, reason: `no verified match (${tried} hypotheses tried)`};
    }
    return finishSolve(best, imageStars, catalog, deep, deepVec, tolPx, width, centerPx, O);
}

/**
 * Project the in-field catalog into image pixels under (T, c0, b0) and greedily match the
 * detected stars against it, tolerance-gated. This is BOTH the verifier's evidence and the
 * refiner's rematch - the same projection, the same gate - so a pairing can never survive
 * refinement with a residual the verification tolerance would have rejected.
 *
 * @returns {{matches: Array, centre: number[]}|null} null when the geometry is not a camera
 *   field at all (implausible scale, or nothing in view)
 */
function projectAndMatch(imageStars, mirrored, T, c0, b0, deep, deepVec, tolPx, width, centerPx,
    catalog, maxProjected) {
    const inv = invertSim(T);
    const scale = Math.hypot(T.A[0], T.A[1]);              // rad per px
    const fovRadiusRad = width * scale * 0.75;             // generous half-diagonal
    if (fovRadiusRad > 1.2) return null;                   // >70 deg radius: not a camera field
    const minDot = Math.cos(Math.min(fovRadiusRad * 1.2, 1.4));

    // Where is the image centre on the sky, under this hypothesis?
    const cPlane = applySim(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
    const centre = unGnomonic(cPlane[0], cPlane[1], c0, b0);

    // Project the in-field catalog into image pixels.
    let proj = [];
    for (let k = 0; k < deep.length; k++) {
        const v = deepVec[k];
        if (v[0] * centre[0] + v[1] * centre[1] + v[2] * centre[2] < minDot) continue;
        const g = gnomonic(v, c0, b0);
        if (!g) continue;
        const p = applySim(inv, g[0], g[1]);
        proj.push([p[0], mirrored ? -p[1] : p[1], deep[k]]);
    }
    if (proj.length < 4) return null;
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
    return {matches, centre, nProjected: proj.length};
}

/** The consensus a match set must reach: a fraction of what COULD have matched. An image far
 * deeper than the verification catalog - a 12-megapixel astrophoto against a mag-7 pool - has
 * hundreds of stars with no possible counterpart, and a fraction of the raw image count would
 * be unreachable by any correct solve. Matching most of what the catalog can show in the field
 * is the evidence; the image's surplus depth is not evidence against. */
function consensusNeeded(nImage, nProjected, fraction) {
    return fraction * Math.min(nImage, nProjected);
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
function verifyHypothesis(imageStars, mirrored, T, c0, b0, P, catQ, catalog, deep, deepVec, tolPx, width, centerPx, O) {
    // Where does this hypothesis put the image centre? Re-anchor there and refit the quad.
    const cPlane = applySim(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
    const c1 = unGnomonic(cPlane[0], cPlane[1], c0, b0);
    const b1 = tangentBasis(c1);
    const Q1 = [];
    for (const ci of catQ) {
        const g = gnomonic(raDecToVec(catalog.ra[ci], catalog.dec[ci]), c1, b1);
        if (!g) return null;
        Q1.push(g);
    }
    const T1 = fitSimilarityFree(P, Q1);
    if (!T1) return null;

    const pm = projectAndMatch(imageStars, mirrored, T1, c1, b1, deep, deepVec, tolPx, width, centerPx);
    if (!pm) return null;
    const {matches} = pm;
    if (matches.length < O.minMatches) return null;
    if (matches.length < consensusNeeded(imageStars.length, pm.nProjected, O.provisionalMatchFraction)) return null;
    return {matches, mirrored, T: T1, c0: c1, b0: b1};
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
function finishSolve(best, imageStars, catalog, deep, deepVec, tolPx, width, centerPx, O) {
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
    let nProjected = Math.min(deep.length, maxProjected) || matches.length;

    for (let round = 0; round < O.refineRounds; round++) {
        // The round either completes wholly or leaves no trace: a break after the refit would
        // pair the NEW transform with the OLD matches and residuals - the exact stale mixture
        // this loop exists to prevent - so every failure path restores the last triple that
        // was verified together.
        const prev = {T, c0, b0, matches};

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
        const refit = fitSimilarityFree(P, Q);
        if (!refit) {
            ({T, c0, b0, matches} = prev);
            break;
        }
        T = refit;

        // 3. Rematch, tolerance-gated, under the refit model against the deep pool. A rematch
        // is only COMMITTED if it would itself pass the acceptance gates - both of them.
        // Committing on the count alone lets a rematch that kept eight stars but lost the
        // required consensus through, and the final gate then rejects a solve that was valid
        // before refinement touched it, instead of the failed round being rolled back.
        const pm = projectAndMatch(imageStars, mirrored, T, c0, b0, allIdx, allVec, tolPx,
            width, centerPx, catalog, maxProjected);
        if (!pm || pm.matches.length < O.minMatches
            || pm.matches.length < consensusNeeded(imageStars.length, pm.nProjected, O.minMatchFraction)) {
            ({T, c0, b0, matches} = prev);
            break;
        }
        matches = pm.matches;
        nProjected = pm.nProjected;
    }

    // Refinement only ever rematches with the verification gate, but hold the acceptance
    // criteria at the end regardless - a solve that degrades below them must not ship.
    if (matches.length < O.minMatches
        || matches.length < consensusNeeded(imageStars.length, nProjected, O.minMatchFraction)) {
        return {ok: false, reason: "refinement lost the match consensus"};
    }

    const scale = Math.hypot(T.A[0], T.A[1]);              // rad per px
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
        fovDeg: width * scale * 180 / Math.PI,
        rollDeg,
        pxPerDeg: (Math.PI / 180) / scale,
        mirrored,
        nImage: imageStars.length,
        matchedFraction: matches.length / imageStars.length,
        rmsPx: Math.sqrt(sse / matches.length),
    };
}
