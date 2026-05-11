// Atmospheric refraction for celestial objects.
//
// Forward (geometric → apparent) Saemundsson formula with Stellarium's
// horizon taper, expressed in the equatorial-inertial frame the celestial
// sphere is built in (raDec2Celestial output, before the per-frame -GMST
// rotation that lands the sphere in ECEF).
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

// Shared uniforms — every material that opts in references the *same*
// objects, so updating refractionUniforms.uZenithECI.value (etc.) once per
// frame is visible on every shader without per-material work.
//
// uZenithECI is the local zenith expressed in the celestial-inertial frame
// raDec2Celestial emits in (used for stars/grid/constellation lines whose
// vertex positions are local to the celestialSphere group).
//
// uZenithECEF is the same zenith but in world space — i.e. *not* rotated
// by GMST — used for Sun/Moon vertex shaders that work on world positions
// (modelMatrix * position) and therefore need the world-space zenith.
export const refractionUniforms = {
    uRefractionEnabled: {value: REFRACTION_DEFAULTS.enabled ? 1.0 : 0.0},
    uZenithECI: {value: new Vector3(0, 0, 1)},
    uZenithECEF: {value: new Vector3(0, 0, 1)},
    uRefractionPress: {value: REFRACTION_DEFAULTS.pressureHPa},
    uRefractionTemp: {value: REFRACTION_DEFAULTS.tempC},
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Saemundsson forward refraction in degrees, with Stellarium-style taper
// from −3.54° down to −5°. Returns 0 below −5° and at and above the
// formula's natural fall-off. Pressure is clamped to ≥0 hPa and
// temperature to >−273°C so a malformed sitch can't produce negative or
// undefined refraction.
export function refractionDeltaDeg(altDeg, opts = {}) {
    const P = Math.max(0, opts.pressureHPa ?? REFRACTION_DEFAULTS.pressureHPa);
    const T = Math.max(-272, opts.tempC ?? REFRACTION_DEFAULTS.tempC);
    const ptDeg = (P / 1010) * 283 / (273 + T) / 60;

    if (altDeg >= -3.54) {
        const arg = (altDeg + 10.3 / (altDeg + 5.11)) * DEG2RAD;
        return ptDeg * (1.02 / Math.tan(arg) + 0.0019279);
    }
    if (altDeg >= -5) {
        const arg354 = (-3.54 + 10.3 / (-3.54 + 5.11)) * DEG2RAD;
        const d354 = ptDeg * (1.02 / Math.tan(arg354) + 0.0019279);
        const blend = (altDeg + 5) / ((-3.54) + 5);
        return d354 * blend;
    }
    return 0;
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
    };
}

// Refract a finite-distance world-space position as seen from a specific
// observer. Used for satellites: light from the satellite bends through the
// atmosphere on its way to the observer's eye, lifting the satellite's
// *apparent* direction toward the observer's zenith. Distance from observer
// is preserved.
const _obsZenith = new Vector3();
const _obsDir = new Vector3();
export function applyRefractionFromObserver(pos, observerECEF, opts = {}, target = null) {
    const out = target ?? new Vector3();
    out.copy(pos);
    const enabled = opts.enabled ?? REFRACTION_DEFAULTS.enabled;
    if (!enabled) return out;
    _obsDir.subVectors(pos, observerECEF);
    const dist = _obsDir.length();
    if (dist < 1) return out;
    _obsZenith.copy(observerECEF).normalize();
    // Bend the direction vector using the same routine as celestial bending.
    applyRefractionECI(_obsDir, _obsZenith, opts);
    out.copy(_obsDir).add(observerECEF);
    return out;
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

// Same vector but rotated by +GMST around Z so it lives in the celestial
// sphere group's local (ECI / equatorial-inertial) frame.
export function zenithECIFromLatLonGMST(latRad, lonRad, gmstDeg, target = new Vector3()) {
    zenithECEFFromLatLon(latRad, lonRad, target);
    const g = gmstDeg * DEG2RAD;
    const cg = Math.cos(g);
    const sg = Math.sin(g);
    const x = target.x;
    const y = target.y;
    target.x = cg * x - sg * y;
    target.y = sg * x + cg * y;
    return target;
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
        shader.uniforms.uRefractionEnabled = refractionUniforms.uRefractionEnabled;
        shader.uniforms.uZenithECI = refractionUniforms.uZenithECI;
        shader.uniforms.uZenithECEF = refractionUniforms.uZenithECEF;
        shader.uniforms.uRefractionPress = refractionUniforms.uRefractionPress;
        shader.uniforms.uRefractionTemp = refractionUniforms.uRefractionTemp;
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
