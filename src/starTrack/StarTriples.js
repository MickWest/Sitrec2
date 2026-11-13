/**
 * Bright-triple identification, for a clip with too few stars for the quad solver. It runs in a
 * worker (StarTriplesOffThread.js, workers/BrightTriplesWorker.js).
 *
 * A twilight clip can show only a few bright dots: planets and the brightest stars. The quad
 * solver needs four stars per code and many codes to agree, and its catalog has no planets.
 * This works on THREE points, and its catalog is built for the sitch's time and place: the
 * planets and the stars brighter than a magnitude limit, over the whole sky or only above the horizon.
 *
 * The code of a triple: the two points farthest apart go to (0,0) and (1,1), and the third
 * point's position there is the code. A shift, a rotation and a change of scale leave it the
 * same, so a triple in the video has the code of the same triple on the sky. Of the two ways
 * to put the far pair, the one with the third point nearer the first (x + y <= 1) is used.
 *
 * Each catalog triple that is no wider than the camera's widest angle gets a code. Each image
 * triple from the brightest candidate stars is compared with them all; a close code proposes
 * three names. The proposal is fitted as a pinhole camera (fitManualPlate), and the fit then
 * projects every bright object into the frame: one that lands on another candidate star
 * supports it, and one that lands in the frame with no star there counts against it.
 */
import {gnomonic, raDecToVec, tangentBasis} from "./StarIdentify";
import {fitManualPlate} from "./StarManualFit";
import {applyTransform, invertTransform} from "./StarMatch";

const D2R = Math.PI / 180;

export const TRIPLE_DEFAULTS = {
    // The brightest candidate stars that form image triples. 12 stars give 220 triples.
    maxImageStars: 12,
    // A side within this fraction of the longest one may be the longest in the other picture,
    // so the image triple is also tried with that side as the far pair.
    sideTol: 0.15,
    // How close two codes must be, in units of the far pair's length. The catalog triple is
    // drawn on a tangent plane about its own centre and the video through a lens, so a true
    // match is not exact.
    codeTol: 0.05,
    // The video may show a narrower field than the camera's widest angle allows, never a wider one.
    fovMargin: 1.1,
    // The three-point fit must be this good, as a fraction of the frame height (the manual
    // fit's "a name may be wrong" line).
    fitTolFrac: 0.01,
    // A projected object within this fraction of the frame height of a candidate star is on it.
    matchTolFrac: 0.012,
    // Candidates kept for the report.
    keep: 5,
};

/** The code of C when A goes to (0,0) and B to (1,1), or null when A and B are the same point. */
export function tripleCode(A, B, C) {
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const d2 = dx * dx + dy * dy;
    if (!d2) return null;
    const wx = C[0] - A[0], wy = C[1] - A[1];
    // (C - A) / (B - A) as complex numbers, then times (1 + i), which takes 1 to (1, 1).
    const qx = (wx * dx + wy * dy) / d2, qy = (wy * dx - wx * dy) / d2;
    return [qx - qy, qx + qy];
}

/** The sides of a triple of points, longest first: {i, j, k (the third), len}. */
function sides(P) {
    return [[0, 1, 2], [0, 2, 1], [1, 2, 0]]
        .map(([i, j, k]) => ({i, j, k, len: Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1])}))
        .sort((a, b) => b.len - a.len);
}

/**
 * The code of a triple, by the rule in the header: {code, order, len}, where order lists the
 * points as [first of the far pair, second, third].
 */
export function canonicalTriple(P) {
    const s = sides(P)[0];
    if (!s.len) return null;
    const code = tripleCode(P[s.i], P[s.j], P[s.k]);
    if (code[0] + code[1] <= 1) return {code, order: [s.i, s.j, s.k], len: s.len};
    return {code: [1 - code[0], 1 - code[1]], order: [s.j, s.i, s.k], len: s.len};
}

/**
 * Every way an image triple could match a catalog code: each side within sideTol of the
 * longest, taken in both directions. A near-tie for the longest side, or a third point near the
 * middle, would otherwise give the image a different code from the sky.
 */
export function imageCodes(P, sideTol) {
    const all = sides(P);
    const out = [];
    for (const s of all) {
        if (s.len < (1 - sideTol) * all[0].len || !s.len) continue;
        for (const [a, b] of [[s.i, s.j], [s.j, s.i]]) {
            out.push({code: tripleCode(P[a], P[b], P[s.k]), order: [a, b, s.k], len: s.len});
        }
    }
    return out;
}

/**
 * The catalog triples no wider than maxSepDeg, each with its code on the tangent plane about
 * the triple's mean direction. objects: [{dir: unit vector}], in any order.
 *
 * Stored as typed arrays, one entry per triple: the code (codeX, codeY), the three objects in
 * code order (ids, three per triple) and the widest angle (sepDeg). 18 bytes a triple, where an
 * object with two small arrays took about 230: the whole sky to magnitude 3 within a 101 deg
 * field is 255,000 triples, 4.6 MB rather than 56 MB.
 *
 * @param {function(number)} [onProgress] - the fraction done, 0 to 1
 * @returns {{n: number, codeX: Float32Array, codeY: Float32Array, ids: Uint16Array, sepDeg: Float32Array}}
 */
export function catalogTriples(objects, maxSepDeg, onProgress = null) {
    const cosMax = Math.cos(maxSepDeg * D2R);
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let cap = 1024, count = 0;
    let codeX = new Float32Array(cap), codeY = new Float32Array(cap);
    let ids = new Uint16Array(3 * cap), sepDeg = new Float32Array(cap);
    const grow = () => {
        cap *= 2;
        const more = (a, size) => { const b = new a.constructor(size); b.set(a); return b; };
        codeX = more(codeX, cap); codeY = more(codeY, cap);
        ids = more(ids, 3 * cap); sepDeg = more(sepDeg, cap);
    };
    const n = objects.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const cij = dot(objects[i].dir, objects[j].dir);
            if (cij < cosMax) continue;
            for (let k = j + 1; k < n; k++) {
                const cik = dot(objects[i].dir, objects[k].dir), cjk = dot(objects[j].dir, objects[k].dir);
                if (cik < cosMax || cjk < cosMax) continue;
                const tri = [i, j, k];
                const c = [0, 0, 0];
                for (const id of tri) for (let a = 0; a < 3; a++) c[a] += objects[id].dir[a];
                const len = Math.hypot(c[0], c[1], c[2]);
                const centre = [c[0] / len, c[1] / len, c[2] / len];
                const basis = tangentBasis(centre);
                const Q = tri.map((id) => gnomonic(objects[id].dir, centre, basis));
                if (Q.some((q) => !q)) continue;
                const t = canonicalTriple(Q);
                if (!t) continue;
                if (count === cap) grow();
                codeX[count] = t.code[0];
                codeY[count] = t.code[1];
                for (let m = 0; m < 3; m++) ids[3 * count + m] = tri[t.order[m]];
                sepDeg[count] = Math.acos(Math.min(cij, cik, cjk)) / D2R;
                count++;
            }
        }
        // The work left after object i goes as the cube of the objects left.
        if (onProgress) onProgress(1 - ((n - 1 - i) / n) ** 3);
    }
    return {n: count, codeX, codeY, ids, sepDeg};
}

/**
 * Where a fitted plate puts each object, in reference-chart pixels, or null when it is behind
 * the tangent plane. The inverse of fitManualPlate's refToSky.
 */
function projectObjects(model, objects) {
    const inv = invertTransform(model.T);
    if (!inv) return objects.map(() => null);
    return objects.map((o) => {
        const q = gnomonic(o.dir, model.c0, model.b0);
        if (!q) return null;
        const [x, y] = applyTransform(inv, q[0], q[1]);
        return [x, model.mirrored ? -y : y];
    });
}

/**
 * Identify a few bright dots by triples.
 *
 * @param {object} args
 * @param {Array<{x:number, y:number, mag:number, index:number}>} args.stars - candidate stars in
 *   reference-chart pixels; mag is instrumental (smaller is brighter), NaN for a star added by hand
 * @param {Array<{label:string, raDeg:number, decDeg:number, mag:number}>} args.objects - the
 *   planets and bright stars above the horizon, in J2000 (catalog-frame) positions
 * @param {number} args.width - frame width, px
 * @param {number} args.height - frame height, px
 * @param {number} args.maxFovDeg - the camera's widest angle (its diagonal field of view)
 * @param {object} [args.options] - overrides of TRIPLE_DEFAULTS
 * @param {function(string, number)} [args.onProgress] - stage "catalog" (building the catalog
 *   triples) then "match", each with the fraction of that stage done
 * @returns {{ok: boolean, reason?: string, best?: object, candidates: object[], counts: object}}
 *   A candidate is {matches: [{star, object}], rmsPx, nMatched, nMissing, codeDist, fovDeg}:
 *   plain data, so a worker can post it.
 */
export function identifyBrightTriples({stars, objects, width, height, maxFovDeg, options = {}, onProgress = null}) {
    const o = {...TRIPLE_DEFAULTS, ...options};
    const counts = {imageStars: 0, objects: objects.length, catalogTriples: 0, imageTriples: 0,
        codeMatches: 0, fitted: 0};
    // Brightest first; a star added by hand has no magnitude and goes last.
    const byMag = (a, b) => (Number.isFinite(a.mag) ? a.mag : Infinity) - (Number.isFinite(b.mag) ? b.mag : Infinity);
    const img = [...stars].sort(byMag).slice(0, o.maxImageStars);
    counts.imageStars = img.length;
    if (img.length < 3) return {ok: false, reason: `needs 3 candidate stars, found ${img.length}`, candidates: [], counts};
    const objs = objects.map((ob) => ({...ob, dir: raDecToVec(ob.raDeg * D2R, ob.decDeg * D2R)}));
    if (objs.length < 3) return {ok: false, reason: `only ${objs.length} bright objects above the horizon`, candidates: [], counts};
    const cat = catalogTriples(objs, maxFovDeg, onProgress && ((f) => onProgress("catalog", f)));
    counts.catalogTriples = cat.n;
    if (!cat.n) return {ok: false, reason: "no three bright objects fit in the camera's field", candidates: [], counts};
    const nImageTriples = img.length * (img.length - 1) * (img.length - 2) / 6;

    const diagPx = Math.hypot(width, height);
    const center = [width / 2, height / 2];
    const fitTol = o.fitTolFrac * height, matchTol = o.matchTolFrac * height;
    const tried = new Set();
    const candidates = [];
    for (let a = 0; a < img.length; a++) {
        for (let b = a + 1; b < img.length; b++) {
            for (let c = b + 1; c < img.length; c++) {
                counts.imageTriples++;
                const tri = [img[a], img[b], img[c]];
                const P = tri.map((s) => [s.x, s.y]);
                for (const ic of imageCodes(P, o.sideTol)) {
                    for (let t = 0; t < cat.n; t++) {
                        const codeDist = Math.hypot(ic.code[0] - cat.codeX[t], ic.code[1] - cat.codeY[t]);
                        if (codeDist > o.codeTol) continue;
                        // The field this pairing implies. A pinhole lens maps angle by its tangent,
                        // so the focal length is the far pair's length over 2 tan(half its angle) -
                        // exact for a pair centred in the frame, and longer for one off centre,
                        // which makes the field smaller, so the check never throws out a true
                        // pair. Pixels in proportion to angle saw the 61 deg Jupiter clip as
                        // 138 deg wide. Wider than the camera can see contradicts the limit the
                        // triples were chosen by.
                        const focalPx = ic.len / (2 * Math.tan(cat.sepDeg[t] * D2R / 2));
                        if (2 * Math.atan(diagPx / 2 / focalPx) / D2R > maxFovDeg * o.fovMargin) continue;
                        counts.codeMatches++;
                        const pairs = ic.order.map((m, q) => ({star: tri[m], object: objs[cat.ids[3 * t + q]]}));
                        const key = pairs.map((p) => `${p.star.index}:${p.object.label}`).sort().join("|");
                        if (tried.has(key)) continue;
                        tried.add(key);
                        const fit = fitManualPlate(pairs.map((p) => ({x: p.star.x, y: p.star.y,
                            raDeg: p.object.raDeg, decDeg: p.object.decDeg})), center, width);
                        counts.fitted++;
                        if (!fit.ok || fit.rmsPx > fitTol) continue;
                        candidates.push({...verify(fit, pairs, stars, objs, width, height, matchTol), codeDist});
                    }
                }
                if (onProgress) onProgress("match", counts.imageTriples / nImageTriples);
            }
        }
    }
    candidates.sort((p, q) => q.nMatched - p.nMatched || p.nMissing - q.nMissing || p.rmsPx - q.rmsPx);
    // Different starting triples of one field end at the same names: one answer, kept at its
    // best fit, so the count of answers says how much doubt there is.
    const answers = new Map();
    for (const c of candidates) {
        const key = c.matches.map((m) => `${m.star.index}:${m.object.label}`).sort().join("|");
        if (!answers.has(key)) answers.set(key, c);
    }
    const distinct = [...answers.values()];
    const kept = distinct.slice(0, o.keep);
    if (!kept.length) return {ok: false, reason: `no triple fits (${counts.codeMatches} close codes tried)`, candidates: kept, counts};
    return {ok: true, best: kept[0], candidates: kept, counts, nFitting: distinct.length};
}

/**
 * Project every bright object with the fit, and pair each one inside the frame with the nearest
 * candidate star within matchTol, nearest pairs first, one star to one object. The three fitted
 * pairs stay as they are.
 */
function verify(fit, pairs, stars, objs, width, height, matchTol) {
    const proj = projectObjects(fit.model, objs);
    const usedStar = new Set(pairs.map((p) => p.star.index));
    const usedObj = new Set(pairs.map((p) => p.object.label));
    const near = [];
    let inFrame = 0;
    objs.forEach((ob, k) => {
        const p = proj[k];
        if (!p || p[0] < 0 || p[1] < 0 || p[0] > width || p[1] > height) return;
        if (usedObj.has(ob.label)) return;
        inFrame++;
        for (const s of stars) {
            if (usedStar.has(s.index)) continue;
            const d = Math.hypot(s.x - p[0], s.y - p[1]);
            if (d <= matchTol) near.push({d, star: s, object: ob});
        }
    });
    near.sort((p, q) => p.d - q.d);
    const matches = [...pairs];
    for (const m of near) {
        if (usedStar.has(m.star.index) || usedObj.has(m.object.label)) continue;
        usedStar.add(m.star.index);
        usedObj.add(m.object.label);
        matches.push({star: m.star, object: m.object});
    }
    const extra = matches.length - pairs.length;
    // Not the fit itself: it carries a function (refToSky), which a worker cannot post. The
    // names are what is used; applyManualLabels fits the camera to them again.
    return {matches, rmsPx: fit.rmsPx, nMatched: matches.length, nMissing: inFrame - extra,
        fovDeg: fit.fovDeg};
}

// ---------------------------------------------------------------------------------------------
// Worker job
// ---------------------------------------------------------------------------------------------

const PROGRESS_INTERVAL_MS = 100;

/**
 * The worker's message handler, here so the tests can drive it without a Worker. In:
 * {type: "run", args} with identifyBrightTriples's arguments (plain data). Out: any number of
 * {type: "progress", stage, fraction}, at most one per stage every 100 ms, then one
 * {type: "done", result} or {type: "error", message}.
 */
export function handleBrightTriplesMessage(msg, post) {
    if (msg?.type !== "run") return;
    try {
        let last = -Infinity, lastStage = null;
        const onProgress = (stage, fraction) => {
            const now = Date.now();
            if (stage === lastStage && fraction < 1 && now - last < PROGRESS_INTERVAL_MS) return;
            last = now;
            lastStage = stage;
            post({type: "progress", stage, fraction});
        };
        post({type: "done", result: identifyBrightTriples({...msg.args, onProgress})});
    } catch (e) {
        post({type: "error", message: e?.message ?? String(e)});
    }
}
