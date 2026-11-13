// CloudMath.js - the JavaScript mirror of the cloud shader math.
//
// Pure functions (no Three.js), unit-tested in tests/cloudMath.test.js. The
// shader (cloudShaders.js) uses the same formulas in float32; the CPU side
// uses them in double precision to build the per-camera uniforms.
//
// PRECISION. ECEF coordinates are ~6.4e6 m, where float32 keeps only ~0.5 m,
// and a ray-sphere quadratic written as -b +- sqrt(b*b - c) cancels
// catastrophically. So the shader never sees an ECEF position: the ray starts
// at the camera, and every constant that would need the difference of two
// Earth-sized numbers is formed here in double precision.
//
// THE LOCAL SPHERE. Near the camera the ellipsoid is replaced by the sphere of
// its Gaussian radius of curvature R, centered under the camera, so the
// camera's height above it is its exact ellipsoid height h0. A point at
// distance t along the unit ray d has, with mu = dot(d, up), r0 = R + h0,
//   r(t)^2 = r0^2 + 2 r0 mu t + t^2
//   h(t)   = r(t) - R = (c0 + 2 b t + t^2) / (r(t) + R),   c0 = h0 (2R + h0), b = r0 mu
// (the rationalized form; never r(t) - R directly). A shell at height H is
// crossed where t^2 + 2 b t + c = 0 with c = (h0 - H)(2R + h0 + H).

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const WGS84_A = 6378137;
export const WGS84_B = 6378137 * (1 - 1 / 298.257223563);

// Both roots of t^2 + 2 b t + c = 0, in increasing order, by the stable form
// q = -(b + sign(b) sqrt(b^2 - c)), roots q and c/q. Null when the ray misses.
export function stableQuadraticRoots(b, c) {
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const q = -(b + (b >= 0 ? root : -root));
    if (q === 0) return [0, 0];
    const first = q, second = c / q;
    return first < second ? [first, second] : [second, first];
}

// The shell constant for height H seen from a camera at h0 above a sphere of radius R.
export function shellConstant(h0, R, H) {
    return (h0 - H) * (2 * R + h0 + H);
}

// Height above the local sphere at distance t along the ray (rationalized form).
// cE = r0^2 - R^2 for this ray's origin, b = dot(origin from center, d).
export function heightAlongRay(R, cE, b, t) {
    const numerator = cE + 2 * b * t + t * t;
    const r = Math.sqrt(R * R + numerator);
    return numerator / (r + R);
}

// The direct (cancelling) formula, for tests only.
export function heightAlongRayDirect(R, h0, mu, t) {
    const r0 = R + h0;
    return Math.sqrt(r0 * r0 + 2 * r0 * mu * t + t * t) - R;
}

// The parts of the ray [0, tMax] that lie between the heights H0 < H1, as up to
// two segments [[tIn, tOut], ...] in ray order. b = r0 mu (perspective ray from
// the camera), cBase / cTop from shellConstant.
export function rayShellSegments(b, cBase, cTop, tMax = Infinity) {
    const top = stableQuadraticRoots(b, cTop);
    if (!top) return [];
    const [topIn, topOut] = top;
    const segments = [];
    const push = (start, end) => {
        const tIn = Math.max(0, start), tOut = Math.min(tMax, end);
        if (tOut > tIn) segments.push([tIn, tOut]);
    };
    const base = stableQuadraticRoots(b, cBase);
    if (!base) {
        push(topIn, topOut);
    } else {
        const [baseIn, baseOut] = base;
        push(topIn, Math.min(topOut, baseIn));
        push(Math.max(topIn, baseOut), topOut);
    }
    return segments;
}

// Brute-force reference for rayShellSegments: march the direct height formula.
export function rayShellSegmentsBrute(R, h0, mu, H0, H1, tMax, steps = 200000) {
    const segments = [];
    let inside = false, start = 0;
    for (let index = 0; index <= steps; index++) {
        const t = tMax * index / steps;
        const h = heightAlongRayDirect(R, h0, mu, t);
        const now = h >= H0 && h <= H1;
        if (now && !inside) { start = t; inside = true; }
        if (!now && inside) { segments.push([start, t]); inside = false; }
    }
    if (inside) segments.push([start, tMax]);
    return segments;
}

// Gaussian radius of curvature sqrt(M N) at a geodetic latitude, from sin(lat).
// (Same as terrestrialRefraction.gaussianRadius; repeated so this file stays pure.)
export function gaussianRadius(sinLat, a = WGS84_A, b = WGS84_B) {
    const e2 = (a * a - b * b) / (a * a);
    if (e2 <= 0) return a;
    return a * Math.sqrt(1 - e2) / (1 - e2 * sinLat * sinLat);
}

// Ellipsoid height of an ECEF point along the geocentric radial (as
// terrestrialRefraction.ellipsoidAltitude), and the geodetic up there.
// Writes {h0, R, up: [x,y,z]} into out (no allocation when out is reused).
export function localFrameAt(x, y, z, a = WGS84_A, b = WGS84_B, out = {h0: 0, R: a, up: [0, 0, 1]}) {
    const r = Math.sqrt(x * x + y * y + z * z);
    if (r < 1e-9) {
        out.h0 = -a; out.R = a; out.up[0] = 0; out.up[1] = 0; out.up[2] = 1;
        return out;
    }
    const ux = x / r, uy = y / r, uz = z / r;
    const surface = 1 / Math.sqrt((ux * ux + uy * uy) / (a * a) + (uz * uz) / (b * b));
    out.h0 = r - surface;
    // Outward normal of x^2/a^2 + y^2/a^2 + z^2/b^2 = 1 (geodetic up).
    let nx = x / (a * a), ny = y / (a * a), nz = z / (b * b);
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= length; ny /= length; nz /= length;
    out.up[0] = nx; out.up[1] = ny; out.up[2] = nz;
    out.R = gaussianRadius(nz, a, b);
    return out;
}

// East, north and up unit vectors at a geodetic latitude/longitude (degrees).
export function enuBasis(latDeg, lonDeg, out = {east: [0, 0, 0], north: [0, 0, 0], up: [0, 0, 0]}) {
    const lat = latDeg * DEG2RAD, lon = lonDeg * DEG2RAD;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
    out.east[0] = -sinLon; out.east[1] = cosLon; out.east[2] = 0;
    out.north[0] = -sinLat * cosLon; out.north[1] = -sinLat * sinLon; out.north[2] = cosLat;
    out.up[0] = cosLat * cosLon; out.up[1] = cosLat * sinLon; out.up[2] = sinLat;
    return out;
}

// Geodetic latitude/longitude (degrees) and height to ECEF on the ellipsoid (a, b).
export function llaToECEF(latDeg, lonDeg, altM, a = WGS84_A, b = WGS84_B, out = [0, 0, 0]) {
    const lat = latDeg * DEG2RAD, lon = lonDeg * DEG2RAD;
    const e2 = (a * a - b * b) / (a * a);
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    out[0] = (N + altM) * cosLat * Math.cos(lon);
    out[1] = (N + altM) * cosLat * Math.sin(lon);
    out[2] = (N * (1 - e2) + altM) * sinLat;
    return out;
}

// Wind "from" a heading (degrees, the meteorological convention) at a speed:
// the air moves TOWARD from + 180. Returns {east, north} in the speed's units.
export function windVelocityEN(fromDeg, speed, out = {east: 0, north: 0}) {
    const toward = (fromDeg + 180) * DEG2RAD;
    out.east = speed * Math.sin(toward);
    out.north = speed * Math.cos(toward);
    return out;
}

export const METERS_PER_SECOND_PER_KNOT = 1852 / 3600;

// x mod period, always in [0, period).
export function positiveModulo(x, period) {
    const m = x % period;
    return m < 0 ? m + period : m;
}

// The brightness of the sun against its elevation (degrees), as CNodeSunlight's
// brightnessOfSun: 1 above dropRegion, falling to 0.25 at the horizon, and to 0
// over the half degree below it.
export function sunBrightness(angleDeg, dropRegion = 10) {
    if (angleDeg < 0) {
        if (angleDeg < -0.5) return 0;
        return 0.25 * (0.5 + angleDeg) / 0.5;
    }
    if (angleDeg > dropRegion) return 1;
    const theta = angleDeg * DEG2RAD;
    const dropOff = Math.cos(theta) * Math.pow(angleDeg / dropRegion, 2);
    return 0.25 + 0.75 * dropOff;
}

// How far below the geometric horizon the sun can be and still light a point
// at height h (meters): the dip of the horizon, radians.
export function horizonDip(h, R) {
    return Math.sqrt(Math.max(0, 2 * h / R));
}

// Henyey-Greenstein phase function, normalized over the sphere (integral = 1).
export function henyeyGreenstein(cosTheta, g) {
    const g2 = g * g;
    return (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * cosTheta, 1.5));
}

// The cloud phase: a forward lobe and a weak back lobe (silver lining when the
// sun is behind the cloud, soft backscatter when it is behind the camera).
export const PHASE_FORWARD_G = 0.8;
export const PHASE_BACK_G = -0.2;
export const PHASE_FORWARD_WEIGHT = 0.7;

export function dualLobePhase(cosTheta, scale = 1) {
    return PHASE_FORWARD_WEIGHT * henyeyGreenstein(cosTheta, PHASE_FORWARD_G * scale)
        + (1 - PHASE_FORWARD_WEIGHT) * henyeyGreenstein(cosTheta, PHASE_BACK_G * scale);
}

// Wind displacement (meters east, north) after `frame` frames at `fps`, for a
// velocity in m/s. Linear in frame time: frame 0 is the set pattern.
export function windDisplacement(velocity, frame, fps, out = {east: 0, north: 0}) {
    const seconds = (Number.isFinite(frame) ? frame : 0) / (fps > 0 ? fps : 30);
    out.east = velocity.east * seconds;
    out.north = velocity.north * seconds;
    return out;
}

// Noise tile periods in meters, from a layer's horizontal scale. The shader
// samples each texture at (offset + p) / period, where p is the camera-relative
// position and offset = (camera - wind) mod period, formed here in double.
export const NOISE_PERIODS = {
    coverage: 4.0,      // weather texture, 4 cells per tile: one coverage cell per `scale`
    coverage2: 10.81,   // a second, larger octave at an irrational ratio
    shape: 0.8,         // shape texture: billows of about scale / 5
    detail: 0.16,       // detail texture
};

export function noisePeriod(scale, kind) {
    return scale * NOISE_PERIODS[kind];
}
