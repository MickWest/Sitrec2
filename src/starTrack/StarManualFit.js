// Manual identification for the Star Tracker: fit the plate model to circles the user has named.
//
// The blind solver (StarIdentify.solveField) needs enough stars to find a four-star pattern and
// then confirm it against the rest of the field. A short clip of a twilight sky - three dots that
// are Regulus, Jupiter and Mars - has nothing for it to confirm against. But a person can SEE
// which dot is which, and three named dots are enough. A pinhole camera's picture of the sky is
// the gnomonic projection about its optical axis followed by a similarity (roll, plate scale and
// a shift). A similarity has four unknowns, and three points give six equations, so three named
// dots fix the pointing, the roll and the field of view, with residuals left over as a check.
//
// The result has the same shape as an ok solveField result, so the camera sync, the overlay
// labels and the star chart take it without knowing it was made by hand.

import {fitSimilarityFree, gnomonic, raDecToVec, tangentBasis, unGnomonic, vecToRaDec} from "./StarIdentify";
import {applyTransform, invertTransform} from "./StarMatch";

/** Named points needed before a manual fit runs. */
export const MANUAL_FIT_MIN_POINTS = 3;

/** The solar-system bodies a circle can be labelled as. Their sky positions come from the
 * ephemeris at the sitch's time and place, not from the star catalog. */
export const PLANET_LABELS = ["Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];

const D2R = Math.PI / 180;

/**
 * Fit one parity. `mirrored` flips the image's y axis before the similarity, which is how a
 * mirror-image video is represented - the same convention solveField uses.
 *
 * The tangent point starts at the mean direction of the named stars and is moved, each round, to
 * where the model puts the frame centre: a pinhole camera's gnomonic projection is centred on its
 * OPTICAL AXIS, so only a fit about that point is a pinhole model. Three to five rounds converge.
 */
function fitParity(points, dirs, centerPx, mirrored) {
    const P = points.map((p) => [p.x, mirrored ? -p.y : p.y]);
    const C = [centerPx[0], mirrored ? -centerPx[1] : centerPx[1]];
    let c0 = [0, 0, 0];
    for (const d of dirs) { c0[0] += d[0]; c0[1] += d[1]; c0[2] += d[2]; }
    const len = Math.hypot(c0[0], c0[1], c0[2]);
    if (len < 1e-9) return null;
    c0 = [c0[0] / len, c0[1] / len, c0[2] / len];
    let b0 = tangentBasis(c0);
    const fitIn = () => {
        const Q = dirs.map((d) => gnomonic(d, c0, b0));
        if (Q.some((q) => !q)) return null;
        const T = fitSimilarityFree(P, Q);
        return T ? {T, Q} : null;
    };
    for (let round = 0; round < 12; round++) {
        const f = fitIn();
        if (!f) return null;
        const cPlane = applyTransform(f.T, C[0], C[1]);
        const next = unGnomonic(cPlane[0], cPlane[1], c0, b0);
        const moved = Math.hypot(next[0] - c0[0], next[1] - c0[1], next[2] - c0[2]);
        c0 = next;
        b0 = tangentBasis(c0);
        if (moved < 1e-12) break;
    }
    // Refit in the final basis, so T and (c0, b0) belong together.
    const f = fitIn();
    if (!f) return null;
    const inv = invertTransform(f.T);
    if (!inv) return null;
    const dPx = f.Q.map((q, k) => {
        const [x, y] = applyTransform(inv, q[0], q[1]);
        return Math.hypot(x - P[k][0], y - P[k][1]);
    });
    const rms = Math.sqrt(dPx.reduce((s, d) => s + d * d, 0) / dPx.length);
    return {T: f.T, c0, b0, mirrored, dPx, rms};
}

/**
 * Fit the plate model to hand-labelled stars.
 *
 * @param {Array<{x:number, y:number, raDeg:number, decDeg:number, hip?:number, mag?:number}>}
 *   points - reference-chart pixels and J2000 (catalog-frame) sky positions
 * @param {number[]} centerPx - the optical axis in chart pixels: the frame centre
 * @param {number} widthPx - the frame width, for the reported field
 * @returns {{ok: false, reason: string} | object} an ok result in solveField's shape, plus
 *   `manual: true` and `maxPx`, the largest residual
 */
export function fitManualPlate(points, centerPx, widthPx) {
    if (points.length < MANUAL_FIT_MIN_POINTS) {
        return {ok: false, reason: `needs ${MANUAL_FIT_MIN_POINTS} labelled stars`};
    }
    const dirs = points.map((p) => raDecToVec(p.raDeg * D2R, p.decDeg * D2R));
    const proper = fitParity(points, dirs, centerPx, false);
    const flipped = fitParity(points, dirs, centerPx, true);
    // A camera does not mirror the sky; only a flipped video does. Three dots that lie almost
    // in a line fit both parities about equally well, so the mirror image is taken only when it
    // fits clearly better.
    let fit = proper;
    if (flipped && (!proper || flipped.rms * 3 < proper.rms)) fit = flipped;
    if (!fit) return {ok: false, reason: "the labelled stars do not fit one camera view"};

    const {T, c0, b0, mirrored} = fit;
    const scale = Math.hypot(T.A[0], T.A[1]);              // tangent units per px
    const cPlane = applyTransform(T, centerPx[0], mirrored ? -centerPx[1] : centerPx[1]);
    const centre = vecToRaDec(unGnomonic(cPlane[0], cPlane[1], c0, b0));
    // Position angle of the image's up direction, east of north - as solveField reports it.
    const up = applyTransform({A: T.A, B: [0, 0]}, 0, mirrored ? 1 : -1);
    return {
        ok: true,
        manual: true,
        matches: points.map((p, k) => ({
            image: k, hip: p.hip ?? null, raDeg: p.raDeg, decDeg: p.decDeg,
            mag: p.mag ?? NaN, dPx: fit.dPx[k],
        })),
        centerRaDeg: centre.ra / D2R,
        centerDecDeg: centre.dec / D2R,
        fovDeg: 2 * Math.atan(widthPx * scale / 2) / D2R,
        rollDeg: Math.atan2(up[0], up[1]) / D2R,
        pxPerDeg: D2R / scale,
        mirrored,
        nImage: points.length,
        matchedFraction: 1,
        rmsPx: fit.rms,
        maxPx: Math.max(...fit.dPx),
        refToSky: (x, y) => {
            const pl = applyTransform(T, x, mirrored ? -y : y);
            const rd = vecToRaDec(unGnomonic(pl[0], pl[1], c0, b0));
            return {raDeg: rd.ra / D2R, decDeg: rd.dec / D2R};
        },
        model: {T, c0, b0, mirrored},
    };
}

const hipIndexCache = new WeakMap();

/** Catalog row of a Hipparcos number, or -1. */
export function catalogIndexOfHip(catalog, hip) {
    let map = hipIndexCache.get(catalog);
    if (!map) {
        map = new Map();
        for (let i = 0; i < catalog.n; i++) map.set(catalog.hip[i], i);
        hipIndexCache.set(catalog, map);
    }
    return map.get(hip) ?? -1;
}

/**
 * What a typed label refers to: a planet, a star by its proper name (a unique start of the name
 * is enough), or a star by Hipparcos number ("HIP 49669").
 *
 * @returns {{planet: string, label: string}
 *   | {hip: number, label: string, named: boolean, raDeg: number, decDeg: number, mag: number}
 *   | {error: string}}
 */
export function resolveSkyLabel(text, catalog, names) {
    const s = String(text ?? "").trim();
    if (!s) return {error: "no name given"};
    const lower = s.toLowerCase();
    const planet = PLANET_LABELS.find((p) => p.toLowerCase() === lower);
    if (planet) return {planet, label: planet};

    const hipMatch = /^hip\s*(\d+)$/i.exec(s);
    let hip;
    if (hipMatch) {
        hip = parseInt(hipMatch[1], 10);
    } else {
        const exact = [], prefix = [];
        for (const [h, nm] of names) {
            const n = nm?.name?.toLowerCase();
            if (!n) continue;
            if (n === lower) exact.push(h);
            else if (n.startsWith(lower)) prefix.push(h);
        }
        const found = exact.length ? exact : prefix;
        if (found.length !== 1) {
            return {error: found.length
                ? `"${s}" starts ${found.length} star names - type more of it`
                : `no star or planet named "${s}"`};
        }
        hip = found[0];
    }
    const i = catalogIndexOfHip(catalog, hip);
    if (i < 0) return {error: `HIP ${hip} is not in the star catalog`};
    const nm = names.get(hip);
    return {
        hip,
        label: nm?.name || `HIP ${hip}`,
        named: !!nm?.name,
        raDeg: catalog.ra[i] / D2R,
        decDeg: catalog.dec[i] / D2R,
        mag: catalog.mag[i],
    };
}

/** The stars with a proper name brighter than `magLimit`, by name. */
export function brightNamedStars(catalog, names, magLimit) {
    const out = [];
    for (const [hip, nm] of names) {
        if (!nm?.name) continue;
        const i = catalogIndexOfHip(catalog, hip);
        if (i < 0 || !(catalog.mag[i] <= magLimit)) continue;
        out.push({hip, name: nm.name, mag: catalog.mag[i],
            raDeg: catalog.ra[i] / D2R, decDeg: catalog.dec[i] / D2R});
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
