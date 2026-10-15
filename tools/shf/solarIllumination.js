// Sunlight reaching a satellite, separate from extinction between satellite and camera.
// Distances are metres, vectors are Earth-centred, and angular radii are radians.
//
// Geometry: finite solar disk and an oblate ellipsoid, with exact ray/ellipsoid
// intersections. A disk strip is integrated analytically across the shadow edge;
// 64-point Gaussian quadrature along the edge avoids noisy binary ray sampling.
//
// Atmosphere: the clear V-band eclipse model described by Mallama (2021),
// https://arxiv.org/abs/2112.08310, sections 3–6. The solar disk is integrated ONCE,
// after point-source transmission and refractive dilution. Table B already includes
// the solar disk and is a validation reference, not a second attenuation factor.
// Transmission uses U.S. Standard Atmosphere 1976 tangent density columns
// (https://ntrs.nasa.gov/citations/19770009539). Refraction uses the paper's smooth
// effective stratospheric exponential: H=6.583 km, rho=exp((3.973-h_km)/6.583),
// theta=(nu0/rho0)*rho*sqrt(2*pi*R/H). A ray of minimum altitude h reaches
// apparent tangent height y=h-D*theta, with dilution dh/dy=1/(1+D*theta/H).
// Transmission is 0.83^(M/Mvertical). This documented hybrid retains realistic
// standard-density absorption without differentiating ideal lapse-rate jumps
// into artificial narrow brightness structure. The solar limb coefficient is 0.69.
//
// Limits: a smooth, clear, horizontally stratified atmosphere; no clouds, terrain,
// aerosols varying with location, chromatic ray tracing, or multiple scattering.
// Refraction uses the small-bending thin-limb approximation, not a full ray tracer.
// Its constant scale height is the paper's approximation, chiefly applicable to
// stratospheric rays; extremely faint deep-shadow light is less well constrained.
// Local ellipsoid radius scales the spherical tangent column; atmospheric oblateness
// and horizontal refractive focusing are neglected. This is a physical approximation,
// not a fit to any particular satellite image or measured weather.

export const SOLAR_ILLUMINATION_DEFAULTS = Object.freeze({
    equatorRadius: 6378137,
    polarRadius: 6356752.314245179,
    solarAngularRadius: 0.2666 * Math.PI / 180,
    solarLimbDarkening: 0.69,
    atmosphere: true,
});

const PI = Math.PI;
const ATM_RADIUS = 6371000;
const ATM_STEP = 100;
const ATM_TOP = 120000;
const ATM_COUNT = ATM_TOP / ATM_STEP + 1;
const SEA_DENSITY = 1.225;
const SEA_REFRACTIVITY = 2.93e-4; // Mallama eq. 4, visible light
const REFRACTION_SCALE_HEIGHT = 6583;
const VERTICAL_COLUMN = 101325 / 9.80665; // hydrostatic sea-level air column, kg/m²
const LOG_V_TRANSMISSION = Math.log(0.83); // Mallama Table 1, per air mass

function gaussLegendre(n, lo, hi) {
    const nodes = [], weights = [];
    const mid = (lo + hi) / 2, half = (hi - lo) / 2;
    for (let i = 0; i < n; i++) {
        let z = Math.cos(PI * (i + 0.75) / (n + 0.5)), derivative;
        for (let k = 0; k < 12; k++) {
            let p0 = 1, p1 = z;
            for (let j = 2; j <= n; j++) {
                const p2 = ((2 * j - 1) * z * p1 - (j - 1) * p0) / j;
                p0 = p1; p1 = p2;
            }
            derivative = n * (z * p1 - p0) / (z * z - 1);
            const next = z - p1 / derivative;
            if (Math.abs(next - z) < 2e-15) { z = next; break; }
            z = next;
        }
        nodes.push(mid + half * z);
        weights.push(half * 2 / ((1 - z * z) * derivative * derivative));
    }
    return {nodes, weights};
}

const stripRule = gaussLegendre(64, -PI / 2, PI / 2);
const diskVertical = gaussLegendre(16, -PI / 2, PI / 2);
const diskHorizontal = gaussLegendre(8, -PI / 2, PI / 2);
const columnRule = gaussLegendre(12, 0, 1);

// Standard-atmosphere geopotential layers: lower boundary height, temperature,
// pressure, and lapse rate. The last layer is continued above 84.852 km, where
// its remaining contribution to visible extinction is negligible.
const layers = [
    [0, 288.15, 101325, -0.0065],
    [11000, 216.65, 22632.06, 0],
    [20000, 216.65, 5474.889, 0.001],
    [32000, 228.65, 868.0187, 0.0028],
    [47000, 270.65, 110.9063, 0],
    [51000, 270.65, 66.93887, -0.0028],
    [71000, 214.65, 3.956420, -0.002],
];

function standardDensity(height) {
    const h = ATM_RADIUS * height / (ATM_RADIUS + height);
    let layer = layers[0];
    for (let i = 1; i < layers.length && h >= layers[i][0]; i++) layer = layers[i];
    const [h0, t0, p0, lapse] = layer;
    const t = t0 + lapse * (h - h0);
    if (t <= 0) return 0;
    const pressure = lapse === 0
        ? p0 * Math.exp(-9.80665 * (h - h0) / (287.05287 * t0))
        : p0 * Math.pow(t0 / t, 9.80665 / (287.05287 * lapse));
    return pressure / (287.05287 * t);
}

let atmosphereTable;
function getAtmosphereTable() {
    if (atmosphereTable) return atmosphereTable;
    const mass = new Float64Array(ATM_COUNT + 2);
    for (let i = 0; i < mass.length; i++) {
        const h = i * ATM_STEP, radius = ATM_RADIUS + h;
        let column = 0, x0 = 0;
        // Split at atmospheric layer boundaries. A single coarse integral has
        // tiny column errors but differentiating them creates brightness ripples.
        const boundaries = layers.slice(1).map(layer => ATM_RADIUS * layer[0] / (ATM_RADIUS - layer[0]));
        boundaries.push(Math.hypot(radius, 1200000) - ATM_RADIUS);
        for (const boundary of boundaries) {
            if (boundary <= h) continue;
            const x1 = Math.sqrt((ATM_RADIUS + boundary) ** 2 - radius * radius);
            const width = x1 - x0;
            for (let k = 0; k < columnRule.nodes.length; k++) {
                const x = x0 + width * columnRule.nodes[k];
                // Straight tangent through a spherical atmosphere, before refractive
                // mapping. hypot avoids the small-height error of x²/(2R).
                const altitude = Math.hypot(radius, x) - ATM_RADIUS;
                column += 2 * width * columnRule.weights[k] * standardDensity(altitude);
            }
            x0 = x1;
        }
        mass[i] = column;
    }
    const bending = new Float64Array(ATM_COUNT);
    const bendAtZero = SEA_REFRACTIVITY / SEA_DENSITY * Math.exp(3.973 / 6.583) *
        Math.sqrt(2 * PI * ATM_RADIUS / REFRACTION_SCALE_HEIGHT);
    for (let i = 0; i < bending.length; i++) bending[i] = bendAtZero * Math.exp(-i * ATM_STEP / REFRACTION_SCALE_HEIGHT);
    atmosphereTable = {mass, bending};
    return atmosphereTable;
}

function atmosphericPointFlux(y, distance, radius) {
    if (y >= ATM_TOP) return 1;
    const {mass, bending} = getAtmosphereTable();
    const scale = Math.sqrt(radius / ATM_RADIUS);
    const ds = distance * scale;
    // Rays with a minimum altitude below the surface are blocked. Refraction
    // still supplies light to negative apparent tangent heights above this bound.
    if (y <= -ds * bending[0]) return 0;
    let lo = 0, hi = ATM_COUNT - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (mid * ATM_STEP - ds * bending[mid] <= y) lo = mid;
        else hi = mid;
    }
    const y0 = lo * ATM_STEP - ds * bending[lo];
    const y1 = hi * ATM_STEP - ds * bending[hi];
    const fraction = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
    const column = (mass[lo] + fraction * (mass[hi] - mass[lo])) * scale;
    const angle = (bending[lo] + fraction * (bending[hi] - bending[lo])) * scale;
    const dilution = 1 / (1 + distance * angle / REFRACTION_SCALE_HEIGHT);
    return Math.max(0, Math.min(1, dilution * Math.exp(LOG_V_TRANSMISSION * column / VERTICAL_COLUMN)));
}

function basis(sx, sy, sz, px, py, pz, ia, ib) {
    // The gradient of the ellipsoid discriminant is normal to its apparent limb.
    // Align the strip's vertical axis with it so a tiny solar crescent is resolved.
    const b = (px * sx + py * sy) * ia + pz * sz * ib;
    const c = (px * px + py * py) * ia + pz * pz * ib - 1;
    let vx = b * px * ia - c * sx * ia;
    let vy = b * py * ia - c * sy * ia;
    let vz = b * pz * ib - c * sz * ib;
    const dot = vx * sx + vy * sy + vz * sz;
    vx -= dot * sx; vy -= dot * sy; vz -= dot * sz;
    let length = Math.hypot(vx, vy, vz);
    if (length < 1e-15) {
        if (Math.abs(sz) < 0.9) { vx = -sy; vy = sx; vz = 0; }
        else { vx = 0; vy = -sz; vz = sy; }
        length = Math.hypot(vx, vy, vz);
    }
    vx /= length; vy /= length; vz /= length;
    return {vx, vy, vz, ux: sy * vz - sz * vy, uy: sz * vx - sx * vz, uz: sx * vy - sy * vx};
}

function stripPrimitive(v, r, limb) {
    const vv = Math.max(-r, Math.min(r, v));
    return (1 - limb) * vv + limb * 0.5 *
        (vv * Math.sqrt(Math.max(0, r * r - vv * vv)) + r * r * Math.asin(vv / r));
}

function geometricDisk(px, py, pz, sx, sy, sz, ia, ib, alpha, limb, axes) {
    const {ux, uy, uz, vx, vy, vz} = axes, tan = Math.tan(alpha);
    const c = (px * px + py * py) * ia + pz * pz * ib - 1;
    const dx = tan * vx, dy = tan * vy, dz = tan * vz;
    const bv = (px * dx + py * dy) * ia + pz * dz * ib;
    const av = (dx * dx + dy * dy) * ia + dz * dz * ib;
    const quadratic = bv * bv - c * av;
    let sum = 0;
    for (let i = 0; i < stripRule.nodes.length; i++) {
        const phi = stripRule.nodes[i], u = Math.sin(phi), r = Math.cos(phi);
        const wx = sx + tan * u * ux, wy = sy + tan * u * uy, wz = sz + tan * u * uz;
        const b = (px * wx + py * wy) * ia + pz * wz * ib;
        const a = (wx * wx + wy * wy) * ia + wz * wz * ib;
        const linear = 2 * (b * bv - c * ((wx * dx + wy * dy) * ia + wz * dz * ib));
        const constant = b * b - c * a;
        const cuts = [-r, r];
        const discriminant = linear * linear - 4 * quadratic * constant;
        if (discriminant >= 0 && quadratic !== 0) {
            const root = Math.sqrt(discriminant);
            // Stable quadratic roots, including the root nearest the solar disk.
            const q = -0.5 * (linear + (linear < 0 ? -root : root));
            for (const v of q === 0 ? [-linear / (2 * quadratic)] : [q / quadratic, constant / q]) {
                if (v > -r && v < r) cuts.push(v);
            }
        } else if (quadratic === 0 && linear !== 0) {
            const v = -constant / linear;
            if (v > -r && v < r) cuts.push(v);
        }
        if (bv !== 0) {
            const v = -b / bv;
            if (v > -r && v < r) cuts.push(v);
        }
        cuts.sort((a, b) => a - b);
        let strip = 0;
        for (let k = 1; k < cuts.length; k++) {
            const v = (cuts[k - 1] + cuts[k]) / 2;
            const blocked = (quadratic * v + linear) * v + constant >= 0 && b + bv * v < 0;
            if (!blocked) strip += stripPrimitive(cuts[k], r, limb) - stripPrimitive(cuts[k - 1], r, limb);
        }
        sum += stripRule.weights[i] * r * strip;
    }
    return Math.max(0, Math.min(1, sum / (PI * (1 - limb / 3))));
}

/**
 * Fraction of unobstructed sunlight reaching a satellite (0..1).
 * `pos` is Earth-centred metres; `toSun` is a direction (normalized defensively).
 * Options: WGS84 radii by default, solarAngularRadius in RADIANS (0 is a point
 * Sun), atmosphere=true, solarLimbDarkening=0.69. Set atmosphere=false and
 * solarLimbDarkening=0 for a uniform-disk geometric reference. No camera settings,
 * observer extinction, arbitrary penumbra depth, or flare brightness enter here.
 */
export function satelliteIllumination(pos, toSun, options = {}) {
    const a = options.equatorRadius ?? SOLAR_ILLUMINATION_DEFAULTS.equatorRadius;
    const b = options.polarRadius ?? SOLAR_ILLUMINATION_DEFAULTS.polarRadius;
    const alpha = options.solarAngularRadius ?? SOLAR_ILLUMINATION_DEFAULTS.solarAngularRadius;
    const limbInput = options.solarLimbDarkening ?? SOLAR_ILLUMINATION_DEFAULTS.solarLimbDarkening;
    const limb = Number.isFinite(limbInput) ? Math.max(0, Math.min(1, limbInput)) : SOLAR_ILLUMINATION_DEFAULTS.solarLimbDarkening;
    const atmosphere = options.atmosphere ?? true;
    const px = pos.x, py = pos.y, pz = pos.z;
    const length = Math.hypot(toSun.x, toSun.y, toSun.z);
    if (!(a > 0 && b > 0 && alpha >= 0 && alpha < PI / 2 && length > 0) ||
        !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(alpha) || !Number.isFinite(length) ||
        !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return 0;
    const sx = toSun.x / length, sy = toSun.y / length, sz = toSun.z / length;
    const ia = 1 / (a * a), ib = 1 / (b * b);
    const c = (px * px + py * py) * ia + pz * pz * ib - 1;
    if (!(c > 0)) return 0;
    const range = Math.hypot(px, py, pz), along = px * sx + py * sy + pz * sz;
    const spread = 2 * range * Math.sin(alpha / 2);
    // Clear states bypass all disk quadrature and atmospheric table work. The
    // enclosing/inscribed spheres and a conservative disk-ray displacement keep
    // these paths safe at either Earth axis and throughout both hemispheres.
    if (along >= spread) return 1;
    const tangentRadius = Math.sqrt(Math.max(0, range * range - along * along));
    const largestRadius = Math.max(a, b), smallestRadius = Math.min(a, b);
    if (tangentRadius - largestRadius > spread + (atmosphere ? ATM_TOP : 0)) return 1;
    if (tangentRadius - smallestRadius < -spread - (atmosphere ? Math.max(ATM_TOP, -along * 0.04) : 0)) return 0;

    const pointFlux = (wx, wy, wz) => {
        const qa = (wx * wx + wy * wy) * ia + wz * wz * ib;
        const qb = (px * wx + py * wy) * ia + pz * wz * ib;
        if (qb >= 0) return 1;
        if (!atmosphere) return qb * qb - qa * c >= 0 ? 0 : 1;
        const t = -qb / qa;
        const x = px + t * wx, y = py + t * wy, z = pz + t * wz;
        const metric = (x * x + y * y) * ia + z * z * ib;
        const r = Math.hypot(x, y, z), surfaceRadius = r / Math.sqrt(metric);
        // A central ray may pass through the centre in deep shadow; the fast
        // path normally catches it, and no atmosphere exists on that ray.
        if (!(metric > 0)) return 0;
        return atmosphericPointFlux(r - surfaceRadius, t * Math.hypot(wx, wy, wz), surfaceRadius);
    };
    if (alpha === 0) return pointFlux(sx, sy, sz);
    const axes = basis(sx, sy, sz, px, py, pz, ia, ib);
    if (!atmosphere) return geometricDisk(px, py, pz, sx, sy, sz, ia, ib, alpha, limb, axes);
    const tan = Math.tan(alpha), {ux, uy, uz, vx, vy, vz} = axes;
    let sum = 0, weightSum = 0;
    for (let i = 0; i < diskVertical.nodes.length; i++) {
        const phi = diskVertical.nodes[i], v = Math.sin(phi), radius = Math.cos(phi);
        for (let j = 0; j < diskHorizontal.nodes.length; j++) {
            const psi = diskHorizontal.nodes[j], cp = Math.cos(psi), u = radius * Math.sin(psi);
            const weight = diskVertical.weights[i] * diskHorizontal.weights[j] * radius * radius * cp *
                (1 - limb + limb * radius * cp);
            sum += weight * pointFlux(sx + tan * (u * ux + v * vx), sy + tan * (u * uy + v * vy), sz + tan * (u * uz + v * vz));
            weightSum += weight;
        }
    }
    return Math.max(0, Math.min(1, sum / weightSum));
}
