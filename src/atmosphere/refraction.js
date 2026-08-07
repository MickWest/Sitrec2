// Atmospheric refraction for celestial objects.
//
// Forward (geometric → apparent) Saemundsson formula with Stellarium's
// horizon taper, expressed in the EQJ (J2000/ICRS equatorial) frame the
// celestial sphere is built in (raDec2Celestial output, before the per-frame
// EQJ→ECEF rotation that lands the sphere on the ground).
//
// JS path: applyRefractionECI() — used for Sun/Moon/planets on the CPU.
// GPU path: REFRACTION_VERTEX_GLSL + installRefractionOnMaterial() — used
// for the star field, constellation lines and the equatorial grid via a
// shared uniforms object so one update per frame propagates to every
// material.

import {Vector3} from "three";

export const REFRACTION_DEFAULTS = {
    enabled: true,
    pressureHPa: 1010,
    tempC: 10,
};

// Effective scale height of atmospheric refractivity, in metres. Refraction is
// proportional to air density, which falls off close to exponentially, so this
// one number converts "how high is the ray" into "how much atmosphere is left".
//
// 7500 m, not the 8.4-8.5 km isothermal value: the real atmosphere has a lapse
// rate, so it thins faster than an isothermal column. Fitted against the US
// Standard Atmosphere the effective scale height ln(P0/P)/z runs ~8.0 km at
// 5 km, 7.44 km at 10 km, 6.88 km at 20 km and 7.0 km at 50 km. A single 7500
// tracks that to within a few percent through the altitudes anyone actually
// observes from (0.264 vs a true 0.261 pressure ratio at 10 km), where 8500
// would be 19% high.
export const REFRACTION_SCALE_HEIGHT_M = 7500;

// Mean Earth radius, used only to turn a look-down angle into a tangent
// height. Callers with the real local radius to hand should pass earthRadius.
const MEAN_EARTH_RADIUS_M = 6371000;

// Shared uniforms — every material that opts in references the *same*
// objects, so updating refractionUniforms.uZenithECI.value (etc.) once per
// frame is visible on every shader without per-material work.
//
// uZenithECI is the local zenith expressed in the EQJ frame raDec2Celestial
// emits in (used for stars/grid/constellation lines whose vertex positions
// are local to the celestialSphere group).
//
// uZenithECEF is the same zenith but in world space — i.e. *not* carried into
// the sphere's frame — used for Sun/Moon vertex shaders that work on world
// positions (modelMatrix * position) and therefore need the world-space zenith.
//
// uObserverHeight / uEarthRadius carry the observer's height above the
// ellipsoid and the Earth radius beneath it, so the shader can work out how
// much atmosphere each sightline actually crosses (see rayMinHeight).
//
// Materials take the WHOLE object — `Object.assign(uniforms, refractionUniforms)`
// or `...refractionUniforms` in a literal — never a hand-written subset. A
// material that misses one silently gets 0 for it, and 0 for uObserverHeight is
// indistinguishable from the sea-level behaviour this exists to correct.
export const refractionUniforms = {
    uRefractionEnabled: {value: REFRACTION_DEFAULTS.enabled ? 1.0 : 0.0},
    uZenithECI: {value: new Vector3(0, 0, 1)},
    uZenithECEF: {value: new Vector3(0, 0, 1)},
    uRefractionPress: {value: REFRACTION_DEFAULTS.pressureHPa},
    uRefractionTemp: {value: REFRACTION_DEFAULTS.tempC},
    uObserverHeight: {value: 0},
    uEarthRadius: {value: MEAN_EARTH_RADIUS_M},
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Height above the ellipsoid of the LOWEST point on a sightline, in metres.
//
// Looking up (altDeg ≥ 0) the ray only ever climbs, so the observer is its own
// lowest point. Looking down it dips to a perigee at (R+h)·cos(altDeg) before
// climbing away again — the "tangent height" of limb sounding. A negative
// result means the ray runs into the ground before it gets there.
//
// Written as h·cos(a) − 2R·sin²(a/2) rather than (R+h)·cos(a) − R: the two are
// algebraically identical but the second form subtracts two numbers near 6.4e6
// to get one near 1e4, which in the float32 the shader runs on loses most of
// the answer. Both paths use this form so CPU and GPU agree exactly.
export function rayMinHeight(altDeg, observerHeight, earthRadius = MEAN_EARTH_RADIUS_M) {
    if (altDeg >= 0) return observerHeight;
    const a = altDeg * DEG2RAD;
    const s = Math.sin(a * 0.5);
    return observerHeight * Math.cos(a) - 2 * earthRadius * s * s;
}

// How much of the sea-level refraction survives for a sightline that never
// gets lower than `zMin` metres. Refraction is proportional to air density, so
// this is the barometric factor — the same physical quantity as the pressure
// setting, just evaluated where the light actually travels instead of always
// at sea level.
//
// Returns exactly 1 for an observer at or below sea level, and for any ray
// that reaches the ground, so ground-level sitches are bit-for-bit unchanged.
function densityFactor(altDeg, opts) {
    const h = opts.observerHeight ?? 0;
    if (!(h > 0)) return 1;
    const zMin = rayMinHeight(altDeg, h, opts.earthRadius ?? MEAN_EARTH_RADIUS_M);
    if (zMin <= 0) return 1;
    return Math.exp(-zMin / REFRACTION_SCALE_HEIGHT_M);
}

// Saemundsson forward refraction in degrees, with Stellarium-style taper
// from −3.54° down to −5°. Returns 0 below −5° and at and above the
// formula's natural fall-off. Pressure is clamped to ≥0 hPa and
// temperature to >−273°C so a malformed sitch can't produce negative or
// undefined refraction.
//
// Saemundsson is a sea-level formula: it assumes the observer is standing at
// the bottom of the whole atmosphere. opts.observerHeight lifts that
// assumption by scaling the result to the air actually along the sightline.
// Without it an observer in orbit gets full ground-level refraction — and
// because the −5° cutoff then falls inside the field of view (the horizon is
// 21.8° down from 493 km) the sky tears into a bent band above an unbent one.
export function refractionDeltaDeg(altDeg, opts = {}) {
    const P = Math.max(0, opts.pressureHPa ?? REFRACTION_DEFAULTS.pressureHPa);
    const T = Math.max(-272, opts.tempC ?? REFRACTION_DEFAULTS.tempC);
    const ptDeg = (P / 1010) * 283 / (273 + T) / 60;

    let dDeg = 0;
    if (altDeg >= -3.54) {
        const arg = (altDeg + 10.3 / (altDeg + 5.11)) * DEG2RAD;
        dDeg = ptDeg * (1.02 / Math.tan(arg) + 0.0019279);
    } else if (altDeg >= -5) {
        const arg354 = (-3.54 + 10.3 / (-3.54 + 5.11)) * DEG2RAD;
        const d354 = ptDeg * (1.02 / Math.tan(arg354) + 0.0019279);
        const blend = (altDeg + 5) / ((-3.54) + 5);
        dDeg = d354 * blend;
    } else {
        return 0;
    }
    return dDeg * densityFactor(altDeg, opts);
}

const _axis = new Vector3();
const _d = new Vector3();
const _cross = new Vector3();

// Bend a position on the celestial sphere toward the local zenith. Both
// inputs are in the celestial-inertial frame (the same frame raDec2Celestial
// emits and that the celestialSphere group rotates by -GMST at draw time).
// Length-preserving — the sphere radius is unchanged.
export function applyRefractionECI(pos, zenithECI, opts = {}) {
    const enabled = opts.enabled ?? REFRACTION_DEFAULTS.enabled;
    if (!enabled) return pos;
    const r = pos.length();
    if (r < 1e-6) return pos;
    _d.copy(pos).divideScalar(r);
    let sinAlt = _d.dot(zenithECI);
    if (sinAlt > 1) sinAlt = 1;
    else if (sinAlt < -1) sinAlt = -1;
    const altDeg = Math.asin(sinAlt) * RAD2DEG;
    const dDeg = refractionDeltaDeg(altDeg, opts);
    if (dDeg <= 0) return pos;
    const dRad = dDeg * DEG2RAD;

    _axis.crossVectors(_d, zenithECI);
    const axisLen = _axis.length();
    if (axisLen < 1e-9) return pos; // already at zenith
    _axis.divideScalar(axisLen);

    const c = Math.cos(dRad);
    const s = Math.sin(dRad);
    _cross.crossVectors(_axis, _d);
    const adotd = _axis.dot(_d);
    pos.copy(_d).multiplyScalar(c)
        .addScaledVector(_cross, s)
        .addScaledVector(_axis, adotd * (1 - c))
        .multiplyScalar(r);
    return pos;
}

// Build a refraction options block from the current shared uniforms — for
// CPU paths (labels, mouse pickers) that must mirror exactly what the
// shader produced this frame.
export function refractionOptsFromUniforms() {
    return {
        enabled: refractionUniforms.uRefractionEnabled.value > 0.5,
        pressureHPa: refractionUniforms.uRefractionPress.value,
        tempC: refractionUniforms.uRefractionTemp.value,
        observerHeight: refractionUniforms.uObserverHeight.value,
        earthRadius: refractionUniforms.uEarthRadius.value,
    };
}

// Refract a finite-distance world-space position as seen from a specific
// observer. Used for satellites: light from the satellite bends through the
// atmosphere on its way to the observer's eye, lifting the satellite's
// *apparent* direction toward the observer's zenith. Distance from observer
// is preserved.
const _obsZenith = new Vector3();
const _obsDir = new Vector3();
const _obsOpts = {};
export function applyRefractionFromObserver(pos, observerECEF, opts = {}, target = null) {
    const out = target ?? new Vector3();
    out.copy(pos);
    const enabled = opts.enabled ?? REFRACTION_DEFAULTS.enabled;
    if (!enabled) return out;
    _obsDir.subVectors(pos, observerECEF);
    const dist = _obsDir.length();
    if (dist < 1) return out;
    // GEODETIC zenith, not the geocentric radial. Refraction is symmetric
    // about the local vertical — perpendicular to the local horizon — and on
    // an ellipsoid the two differ by up to 11.55' (11.5' at 45° latitude,
    // 10.8' at Copenhagen). Using the radial tilted the bend axis by that
    // much, which near the horizon is worth ~1.25' of satellite altitude at
    // 0.5° and ~1' at 1°. The celestial path already used geodetic; this one
    // had been left on the radial.
    //
    // Radii come from the caller because Sitrec's earth model is SELECTABLE
    // (Sit.useEllipsoid, false for legacy sitches): with a spherical earth the
    // observer ECEF is built on a sphere and the vertical IS the radial, so a
    // hard-coded WGS84 inversion would reintroduce the same ~11.5' tilt in the
    // opposite direction. Passing equal radii collapses this to the radial
    // exactly, which is what a sphere wants.
    zenithECEFFromPosition(observerECEF, _obsZenith, opts.equatorRadius, opts.polarRadius);
    // How much atmosphere the sightline crosses depends on how high the
    // observer is — and the observer's own ECEF position already says. Callers
    // don't have to supply a height (none did before this existed), but an
    // explicit opts.observerHeight still wins. Only the fields the bend itself
    // reads are forwarded, so nothing can leak between calls.
    const surfaceR = ellipsoidRadiusUnder(observerECEF, opts.equatorRadius, opts.polarRadius);
    _obsOpts.enabled = true;
    _obsOpts.pressureHPa = opts.pressureHPa;
    _obsOpts.tempC = opts.tempC;
    _obsOpts.observerHeight = opts.observerHeight ?? (observerECEF.length() - surfaceR);
    _obsOpts.earthRadius = opts.earthRadius ?? surfaceR;
    // Bend the direction vector using the same routine as celestial bending.
    applyRefractionECI(_obsDir, _obsZenith, _obsOpts);
    out.copy(_obsDir).add(observerECEF);
    return out;
}

// Bend a DIRECTION — a unit vector toward something effectively at infinity: a
// star, a planet, the Sun, the Moon — as seen from an observer. The finite-
// position form above needs a real distance; a celestial body has none that
// matters, because the bend is a function of apparent altitude and observer
// height ONLY, not of range. Used by the camera's Celestial Lock, so the camera
// points at where the body is DRAWN rather than where it geometrically is.
const _dirFar = new Vector3();
export function applyRefractionToDirection(dir, observerECEF, opts = {}, target = null) {
    const out = target ?? new Vector3();
    const enabled = opts.enabled ?? REFRACTION_DEFAULTS.enabled;
    if (!enabled) return out.copy(dir).normalize();
    // Any far sample along the ray gives the same bent direction. 1e9 m clears
    // the 1 m minimum applyRefractionFromObserver ignores by a wide margin,
    // while staying small enough that float64 keeps the subtraction exact.
    _dirFar.copy(dir).normalize().multiplyScalar(1e9).add(observerECEF);
    applyRefractionFromObserver(_dirFar, observerECEF, opts, _dirFar);
    return out.copy(_dirFar).sub(observerECEF).normalize();
}

// Geodetic zenith (ellipsoid normal) at an ECEF position, at any altitude.
// Bowring's closed-form inverse — good to well under a milliarcsecond, and
// self-contained so this module keeps its "three only" dependency and its unit
// tests stay free of the app's global graph.
//
// The radii are parameters, not constants, because Sitrec's earth model is
// selectable: pass Globals.equatorRadius / Globals.polarRadius so this tracks
// Sit.useEllipsoid. With equal radii (the spherical model) e2 collapses to 0
// and the result is exactly the geocentric radial, which is the correct
// vertical for that model. Defaults are WGS84.
const WGS84_A = 6378137.0;
const WGS84_B = WGS84_A * (1 - 1 / 298.257223563);

export function zenithECEFFromPosition(posECEF, target = new Vector3(),
                                       a = WGS84_A, b = WGS84_B) {
    const {x, y, z} = posECEF;
    const p = Math.hypot(x, y);
    if (p < 1e-9) {
        // On the spin axis: the normal is +/-Z and longitude is undefined.
        return target.set(0, 0, z >= 0 ? 1 : -1);
    }
    const lonRad = Math.atan2(y, x);
    const asqr = a * a, bsqr = b * b;
    const e2 = (asqr - bsqr) / asqr;
    if (e2 <= 0) {
        // Spherical earth model — the vertical is the radial. Take it directly
        // rather than through a latitude, so it is exact.
        return target.copy(posECEF).normalize();
    }
    const ep2 = (asqr - bsqr) / bsqr;
    const theta = Math.atan2(z * a, p * b);
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    const latRad = Math.atan2(
        z + ep2 * b * sinT * sinT * sinT,
        p - e2 * a * cosT * cosT * cosT,
    );
    return zenithECEFFromLatLon(latRad, lonRad, target);
}

// Geocentric radius of the ellipsoid surface directly beneath an ECEF point —
// where the line from the Earth's centre through that point crosses the
// ellipsoid. |pos| minus this is the radial height, which is what a scale
// height wants.
//
// This deliberately uses the GEOCENTRIC latitude, unlike everything else in
// this file. That is not the geodetic-vs-geocentric mistake: the ellipsoid
// radius is evaluated along the very ray the height is measured along, so the
// pair is self-consistent and returns exactly 0 for a point sitting on the
// ellipsoid at any latitude. Against the true geodetic height the difference is
// h·(1 − cos(φ − φ_c)) — under 7 cm at 10 km up, and it is about to be divided
// by a 7.5 km scale height.
export function ellipsoidRadiusUnder(posECEF, a = WGS84_A, b = WGS84_B) {
    const r = posECEF.length();
    if (r < 1e-9) return Math.min(a, b);
    const sinPhiC = posECEF.z / r;
    const sinSqr = sinPhiC * sinPhiC;
    return (a * b) / Math.sqrt(a * a * sinSqr + b * b * (1 - sinSqr));
}

// Geodetic local zenith in ECEF (X→Greenwich, Z→North) from observer
// latitude/longitude in radians. Geodetic — i.e. perpendicular to the WGS84
// horizon — which is what refraction is symmetric about.
export function zenithECEFFromLatLon(latRad, lonRad, target = new Vector3()) {
    const cosLat = Math.cos(latRad);
    target.set(
        cosLat * Math.cos(lonRad),
        cosLat * Math.sin(lonRad),
        Math.sin(latRad),
    );
    return target;
}

// Same vector, carried into the celestial sphere group's local EQJ frame by
// the caller-supplied ECEF→EQJ matrix (CelestialMath.getECEFToEQJMatrix).
//
// This must be the exact inverse of the matrix the celestialSphere is drawn
// with. A bare Rz(+GAST) is NOT enough: it would leave the zenith off by the
// precession since J2000 (22 arcmin in 2026), and refraction would then bend
// every star, line and grid vertex about the wrong axis — reintroducing
// several arcmin of altitude error into a pipeline that had just been fixed.
export function zenithEQJFromLatLon(latRad, lonRad, ecefToEQJ, target = new Vector3()) {
    zenithECEFFromLatLon(latRad, lonRad, target);
    return target.applyMatrix4(ecefToEQJ);
}

// GLSL counterpart of applyRefractionECI. Drop into a vertex shader with
// the refraction uniforms (uRefractionEnabled, uZenithECI, uZenithECEF,
// uRefractionPress, uRefractionTemp). Length-preserving.
//
// Both *_chunk wrappers exist so the shader picks the zenith matching the
// frame its vertex positions live in — local-celestial-sphere positions use
// uZenithECI, world-space positions (modelMatrix * position) use uZenithECEF.
export const REFRACTION_VERTEX_GLSL = /* glsl */`
uniform float uRefractionEnabled;
uniform vec3 uZenithECI;
uniform vec3 uZenithECEF;
uniform float uRefractionPress;
uniform float uRefractionTemp;
uniform float uObserverHeight;
uniform float uEarthRadius;

// Barometric falloff — the GLSL twin of densityFactor()/rayMinHeight() in
// refraction.js. The tangent height is written as h*cos(a) - 2R*sin^2(a/2)
// rather than (R+h)*cos(a) - R because the latter cancels two numbers near
// 6.4e6 down to one near 1e4, which float32 cannot hold on to.
float refractionDensityFactor(float altDeg) {
    if (uObserverHeight <= 0.0) return 1.0;
    float zMin = uObserverHeight;
    if (altDeg < 0.0) {
        float a = radians(altDeg);
        float s = sin(a * 0.5);
        zMin = uObserverHeight * cos(a) - 2.0 * uEarthRadius * s * s;
    }
    if (zMin <= 0.0) return 1.0;
    return exp(-zMin / ${REFRACTION_SCALE_HEIGHT_M.toFixed(1)});
}

vec3 applyRefraction_core(vec3 pos, vec3 zenith) {
    if (uRefractionEnabled < 0.5) return pos;
    float r = length(pos);
    if (r < 1e-6) return pos;
    vec3 d = pos / r;
    float sinAlt = clamp(dot(d, zenith), -1.0, 1.0);
    float altDeg = degrees(asin(sinAlt));
    float ptDeg = (uRefractionPress / 1010.0) * 283.0 / (273.0 + uRefractionTemp) / 60.0;
    float dDeg = 0.0;
    if (altDeg >= -3.54) {
        float arg = radians(altDeg + 10.3 / (altDeg + 5.11));
        dDeg = ptDeg * (1.02 / tan(arg) + 0.0019279);
    } else if (altDeg >= -5.0) {
        float arg354 = radians(-3.54 + 10.3 / (-3.54 + 5.11));
        float d354 = ptDeg * (1.02 / tan(arg354) + 0.0019279);
        float blend = (altDeg + 5.0) / ((-3.54) + 5.0);
        dDeg = d354 * blend;
    }
    dDeg *= refractionDensityFactor(altDeg);
    if (dDeg <= 0.0) return pos;
    float dRad = radians(dDeg);
    vec3 axis = cross(d, zenith);
    float axisLen = length(axis);
    if (axisLen < 1e-9) return pos;
    axis = axis / axisLen;
    float c = cos(dRad);
    float s = sin(dRad);
    vec3 dRot = d * c + cross(axis, d) * s + axis * dot(axis, d) * (1.0 - c);
    return dRot * r;
}

vec3 applyRefractionECI_chunk(vec3 pos) {
    return applyRefraction_core(pos, uZenithECI);
}

vec3 applyRefractionECEF_chunk(vec3 worldPos) {
    return applyRefraction_core(worldPos, uZenithECEF);
}
`;

// Inject refraction into a stock Three.js material's vertex shader by
// replacing #include <begin_vertex>. Works for LineBasicMaterial,
// SpriteMaterial, MeshBasicMaterial, etc. — anything that uses the standard
// shader chunks. Custom ShaderMaterials should bake the GLSL in directly.
export function installRefractionOnMaterial(material) {
    if (!material) return;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof prev === "function") prev(shader, renderer);
        Object.assign(shader.uniforms, refractionUniforms);
        shader.vertexShader = shader.vertexShader.replace(
            "void main() {",
            REFRACTION_VERTEX_GLSL + "\nvoid main() {",
        ).replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\n\ttransformed = applyRefractionECI_chunk(transformed);",
        );
    };
    material.needsUpdate = true;
}
