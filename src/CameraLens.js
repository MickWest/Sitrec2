// Camera lens model: the mapping between image pixels and unit rays in camera space.
//
// Sitrec's cameras have always been pinholes - a Three.js PerspectiveCamera and an FOV. That is
// exact for the narrow-field footage the app was built around, and wrong for anything wide. A
// measured case: a ~89 deg IR monocular clip, where Star Track's 2D-similarity sky model left a
// smooth 10-12 px residual at the left and right frame edges and reported ~70 real stars as
// moving. Fitting rays through a wide-angle lens plus ONE 3D rotation explained all 129 tested
// star correspondences to 0.75 px rms, against 84/129 and an 11.7 px worst case for the
// pixel-space similarity. A homography barely helped (11.4 px), which is diagnostic: K R K^-1
// models perspective, but radial lens compression is not a projective map.
//
// Pure module: plain objects in, plain arrays out. No THREE, no DOM, no Sitrec globals, so it can
// be unit tested directly and imported from anywhere.
//
//
// CONVENTIONS, stated once because getting them wrong is silent and expensive:
//
//   Camera space is +x RIGHT, +y DOWN, +z FORWARD. That is the IMAGE convention, chosen so a
//   pixel offset maps to a ray component without a sign flip. It is NOT the Three.js camera
//   convention (+y up, -z forward); anything handing a ray to Three.js must convert explicitly.
//
//   theta is the field angle from the optical axis, in radians. rho is the normalised image
//   radius, r / (focalPx * s). A lens is a radial curve theta(rho) plus its inverse.
//
//   `s` is the per-frame FOCAL SCALE (zoom). Effective focal length is focalPx * s. Callers that
//   do not model zoom pass nothing and get s = 1. The lens is defined at a REFERENCE ZOOM where
//   s = 1 by construction: without that gauge, (focalPx * a, s / a) is an exactly equivalent
//   solution for every a, and nothing downstream can identify either parameter.


/** Field angle (rad) at normalised image radius rho, and the inverse, per lens type.
 *
 * Named lenses use their CLOSED FORMS, never a polynomial approximation of themselves. Measured:
 * a best-fit two-term odd polynomial tracks a rectilinear lens only to 0.41 px at the corner of a
 * 1280x720 frame, and an orthographic one to 0.98 px - both larger than the 0.31 px solve rms
 * they would be feeding. The polynomial exists for `custom` and nothing else.
 *
 * `maxTheta` is the largest field angle the projection can represent. Beyond it a ray has no
 * image, which is a real case on a wide lens and must be returned as null rather than clamped.
 */
export const LENS_PRESETS = {
    // r = f tan(theta) - the pinhole. Sitrec's historical model, and the default.
    rectilinear: {
        label: "Rectilinear (pinhole)",
        theta: (rho) => Math.atan(rho),
        rho: (theta) => Math.tan(theta),
        maxTheta: Math.PI / 2,
        maxRho: Infinity,
    },
    // r = 2f tan(theta/2) - conformal; preserves shapes locally.
    stereographic: {
        label: "Stereographic",
        theta: (rho) => 2 * Math.atan(rho / 2),
        rho: (theta) => 2 * Math.tan(theta / 2),
        maxTheta: Math.PI,
        maxRho: Infinity,
    },
    // r = f theta - the "equidistant" or linear-angle fisheye.
    equidistantFisheye: {
        label: "Equidistant fisheye",
        theta: (rho) => rho,
        rho: (theta) => theta,
        maxTheta: Math.PI,
        maxRho: Math.PI,
    },
    // r = 2f sin(theta/2) - equal-area.
    equisolidFisheye: {
        label: "Equisolid-angle fisheye",
        theta: (rho) => 2 * Math.asin(clamp(rho / 2, -1, 1)),
        rho: (theta) => 2 * Math.sin(theta / 2),
        maxTheta: Math.PI,
        maxRho: 2,
    },
    // r = f sin(theta). Named "...Fisheye" deliberately: CNodeCamera already has an unrelated
    // `orthographic` RENDER mode, and two different meanings of the bare word in one settings
    // panel is a trap.
    orthographicFisheye: {
        label: "Orthographic fisheye",
        theta: (rho) => Math.asin(clamp(rho, -1, 1)),
        rho: (theta) => Math.sin(theta),
        maxTheta: Math.PI / 2,
        maxRho: 1,
    },
    // theta = rho + d3 rho^3 + d5 rho^5 + d7 rho^7, inverted numerically.
    //
    // The linear coefficient is pinned to 1 BY CONSTRUCTION so that focalPx alone sets the
    // paraxial scale. A free linear term would be an exact duplicate of focalPx (the paraxial
    // focal of c1*rho is focalPx/c1), and a fit with both wanders along that valley instead of
    // converging - measured, while diagnosing this: focalPx ran to 7.8e5 with coefficients to
    // match, fitting nothing.
    //
    // Three terms, not two: against a true orthographic lens over a 1280x720 frame, best-fit
    // d3,d5 leaves 0.98 px at the corner while d3,d5,d7 leaves 0.17 px. d9 would give 0.03 px,
    // which is below the noise and not worth the degree of freedom.
    custom: {
        label: "Custom (fitted)",
        theta: (rho, d) => customTheta(rho, d),
        rho: (theta, d) => customRho(theta, d),
        maxTheta: null,   // determined from the fitted curve, see lensMaxTheta / lensMaxRho
        maxRho: null,
    },
};

/** The pinhole Sitrec has always assumed. Any camera without an explicit lens behaves as this. */
export const DEFAULT_LENS_TYPE = "rectilinear";

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function customTheta(rho, d) {
    const [d3 = 0, d5 = 0, d7 = 0] = d || [];
    const r2 = rho * rho;
    return rho * (1 + r2 * (d3 + r2 * (d5 + r2 * d7)));
}

/** d(theta)/d(rho) for the custom curve - also the monotonicity test. */
function customThetaPrime(rho, d) {
    const [d3 = 0, d5 = 0, d7 = 0] = d || [];
    const r2 = rho * rho;
    return 1 + r2 * (3 * d3 + r2 * (5 * d5 + r2 * 7 * d7));
}

/** Invert the custom curve by Newton. Safe because monotonicity is validated on construction. */
function customRho(theta, d) {
    let rho = theta;                       // exact for the equidistant case, close otherwise
    for (let i = 0; i < 40; i++) {
        const g = customTheta(rho, d) - theta;
        const gp = customThetaPrime(rho, d);
        if (!(Math.abs(gp) > 1e-12)) break;
        const step = g / gp;
        rho -= step;
        if (Math.abs(step) < 1e-14) break;
    }
    return rho;
}

/**
 * A lens.
 *
 * `refSize` is load-bearing, not bookkeeping: Star Track analyses in DECODED pixel space under
 * the Max Resolution cap while the camera dialog talks about the source video size, so focalPx
 * and principal are meaningless without the size they were measured in. Every conversion goes
 * through it, and a mismatched ASPECT is refused rather than silently rescaled.
 */
export function makeLens(opts = {}) {
    const lens = {
        kind: opts.kind ?? "radial",
        type: opts.type ?? DEFAULT_LENS_TYPE,
        focalPx: opts.focalPx,
        principal: opts.principal ? [...opts.principal] : null,
        refSize: opts.refSize ? [...opts.refSize] : null,
        distortion: opts.distortion ? [...opts.distortion] : [0, 0, 0],
        source: opts.source ?? "default",
    };
    // Principal point defaults to the image centre, which is the right prior and the right
    // fallback - a fitted one lands near it (this clip: (636, 332) against a (640, 360) centre).
    if (!lens.principal && lens.refSize) {
        lens.principal = [lens.refSize[0] / 2, lens.refSize[1] / 2];
    }
    return lens;
}

/** Build the pinhole equivalent of a vertical FOV in degrees, which is what Sitrec stores today. */
export function lensFromVFOV(vfovDeg, size) {
    const [w, h] = size;
    const focalPx = (h / 2) / Math.tan(vfovDeg * Math.PI / 360);
    return makeLens({type: "rectilinear", focalPx, refSize: [w, h], source: "default"});
}

/**
 * Scale factor taking `size` pixels into the lens's own reference pixels.
 *
 * Returns null when the aspect ratios disagree by more than a rounding tolerance. A lens fitted
 * on a 1280x720 decode says nothing about a 1440x1080 source with a different crop, and quietly
 * applying a uniform scale would put the principal point in the wrong place while looking fine.
 */
export function lensScaleFor(lens, size) {
    if (!size || !lens.refSize) return 1;
    const [w, h] = size, [rw, rh] = lens.refSize;
    if (w === rw && h === rh) return 1;
    const kx = w / rw, ky = h / rh;
    // 0.5% covers integer rounding of odd dimensions; anything more is a different framing.
    if (Math.abs(kx - ky) > 0.005 * Math.max(kx, ky)) return null;
    return (kx + ky) / 2;
}

/** Largest normalised image radius this lens can interpret, i.e. rho at maxTheta. */
export function lensMaxRho(lens) {
    const preset = LENS_PRESETS[lens.type];
    if (!preset) return 0;
    if (lens.type !== "custom") return preset.maxRho;
    // The custom curve is only usable while it is strictly increasing.
    let rho = 0;
    const step = 0.005;
    while (rho < 8) {
        if (customThetaPrime(rho, lens.distortion) <= 0) break;
        rho += step;
    }
    return Math.max(0, rho - step);
}

/** Largest field angle this lens can image, accounting for a custom curve turning over. */
export function lensMaxTheta(lens) {
    const preset = LENS_PRESETS[lens.type];
    if (!preset) return 0;
    if (lens.type !== "custom") return preset.maxTheta;
    return customTheta(lensMaxRho(lens), lens.distortion);
}

/**
 * Is the lens usable over the whole image?
 *
 * A non-monotone theta(rho) is REJECTED, never clamped. Clamping makes the forward and inverse
 * mappings disagree, so rayToPixel(lensToRay(p)) stops returning p and every consumer silently
 * inherits the inconsistency. A free polynomial fit really does produce these - one turned over
 * past r=640 px while diagnosing this, which is physically meaningless.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateLens(lens, size = null) {
    const preset = LENS_PRESETS[lens.type];
    if (!preset) return {ok: false, reason: `unknown lens type "${lens.type}"`};
    if (!(lens.focalPx > 0)) return {ok: false, reason: "focal length must be positive"};
    if (!lens.refSize) return {ok: false, reason: "lens has no reference size"};
    if (size && lensScaleFor(lens, size) === null) {
        return {ok: false, reason: "image aspect does not match the lens reference size"};
    }
    if (lens.type === "custom") {
        // Check monotonicity across the radii the image actually uses, plus a margin.
        const [w, h] = lens.refSize;
        const [cx, cy] = lens.principal;
        const rMax = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
        const rhoMax = rMax / lens.focalPx;
        for (let i = 0; i <= 200; i++) {
            const rho = rhoMax * i / 200;
            if (customThetaPrime(rho, lens.distortion) <= 0) {
                return {ok: false, reason: `lens curve is not monotone at rho=${rho.toFixed(3)}`};
            }
        }
    }
    return {ok: true};
}

/**
 * Pixel -> unit ray in camera space (+x right, +y down, +z forward).
 *
 * @param {number} s per-frame focal scale (zoom). 1 at the lens's reference zoom.
 * @returns {number[]|null} null if the pixel lies outside what the lens can image
 */
export function lensToRay(lens, x, y, size = null, s = 1) {
    const k = lensScaleFor(lens, size);
    if (k === null) return null;
    const f = lens.focalPx * k * s;
    const cx = lens.principal[0] * k, cy = lens.principal[1] * k;
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    const rho = r / f;
    // Reject beyond the imageable radius rather than letting the preset's internal clamp fold it
    // back onto the limiting angle. Clamping here breaks invertibility: on an orthographic lens
    // at s=0.7 the frame corner sits at rho=1.15, a clamp would call it exactly 90 deg, and the
    // pixel would come back 94 px away. Measured - this is what the round-trip test caught.
    if (!(rho <= lensMaxRho(lens) + 1e-12)) return null;
    const preset = LENS_PRESETS[lens.type];
    const theta = lens.type === "custom"
        ? preset.theta(rho, lens.distortion)
        : preset.theta(rho);
    if (!isFinite(theta) || theta > lensMaxTheta(lens) + 1e-9) return null;
    // sin(theta)/rho, guarded at the axis where both go to zero together.
    const scale = rho > 1e-12 ? Math.sin(theta) / rho : 1;
    return [dx / f * scale, dy / f * scale, Math.cos(theta)];
}

/**
 * Unit ray in camera space -> pixel.
 *
 * @returns {number[]|null} null when the ray is behind the camera or beyond the lens's field.
 *   This is a FIRST-CLASS case, not an error: a 2D similarity always returned a point, a lens
 *   does not, and a caller that treats null as "no motion" or "zero offset" will silently
 *   mis-measure. Handle it explicitly.
 */
export function rayToPixel(lens, ray, size = null, s = 1) {
    const k = lensScaleFor(lens, size);
    if (k === null) return null;
    const f = lens.focalPx * k * s;
    const cx = lens.principal[0] * k, cy = lens.principal[1] * k;
    const theta = Math.acos(clamp(ray[2], -1, 1));
    if (theta > lensMaxTheta(lens) + 1e-9) return null;
    const preset = LENS_PRESETS[lens.type];
    const rho = lens.type === "custom"
        ? preset.rho(theta, lens.distortion)
        : preset.rho(theta);
    if (!isFinite(rho)) return null;
    const rho2 = Math.hypot(ray[0], ray[1]);
    // At the optical axis the azimuth is undefined but the answer is the principal point.
    if (rho2 < 1e-12) return [cx, cy];
    const m = f * rho / rho2;
    return [cx + ray[0] * m, cy + ray[1] * m];
}

/**
 * Local plate scale at a field angle, in pixels per radian, as a RADIAL/TANGENTIAL pair.
 *
 * These differ - often strongly - on a wide lens, which is why a single scalar "plate scale at
 * this direction" is not a valid way to convert an angular quantity to pixels. The Jacobian is a
 * 2x2, diagonal in the radial/tangential basis:
 *
 *   radial      d r / d theta          how much a radial nudge moves the image
 *   tangential  r / sin(theta)         how much an azimuthal nudge moves it
 *
 * Track classification needs this: fitting motion in a tangent plane and converting with one
 * scalar would recalibrate every sigma threshold as a function of where the star sits.
 */
export function lensJacobian(lens, theta, size = null, s = 1) {
    const k = lensScaleFor(lens, size);
    if (k === null) return null;
    const f = lens.focalPx * k * s;
    const preset = LENS_PRESETS[lens.type];
    const rhoOf = (t) => (lens.type === "custom" ? preset.rho(t, lens.distortion) : preset.rho(t));
    const h = 1e-6;
    const rho = rhoOf(theta);
    // Central difference, narrowing to one-sided at the axis. The SPAN has to match the points
    // actually used - dividing a 2h span by h silently doubles the reported scale at theta ~ 0.
    const lo = Math.max(0, theta - h), hi = theta + h;
    const radial = f * (rhoOf(hi) - rhoOf(lo)) / (hi - lo);
    const sinT = Math.sin(theta);
    const tangential = sinT > 1e-9 ? f * rho / sinT : radial;
    return {radial, tangential};
}

/** Horizontal, vertical and diagonal field of view in degrees. */
export function lensFOV(lens, size = null, s = 1) {
    const k = lensScaleFor(lens, size);
    if (k === null) return null;
    const [w, h] = size ?? lens.refSize;
    const cx = lens.principal[0] * k, cy = lens.principal[1] * k;
    const f = lens.focalPx * k * s;
    const preset = LENS_PRESETS[lens.type];
    const th = (r) => {
        const rho = r / f;
        return lens.type === "custom" ? preset.theta(rho, lens.distortion) : preset.theta(rho);
    };
    // Measured across the full extent, so an off-centre principal point is accounted for rather
    // than assumed away.
    const deg = 180 / Math.PI;
    return {
        hfov: (th(cx) + th(w - cx)) * deg,
        vfov: (th(cy) + th(h - cy)) * deg,
        dfov: (th(Math.hypot(cx, cy)) + th(Math.hypot(w - cx, h - cy))) * deg,
    };
}

export function serializeLens(lens) {
    if (!lens || lens.source === "default") return undefined;   // absent == rectilinear at camera.fov
    return {
        kind: lens.kind, type: lens.type, focalPx: lens.focalPx,
        principal: [...lens.principal], refSize: [...lens.refSize],
        distortion: [...lens.distortion], source: lens.source,
    };
}

export function deserializeLens(data) {
    if (!data) return null;      // old saves have no lens; caller falls back to the pinhole
    return makeLens(data);
}
