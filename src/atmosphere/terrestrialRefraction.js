// Terrestrial refraction of the SOLID scene — terrain, 3D tiles, buildings,
// the ocean and the globe.
//
// This is a DIFFERENT model from the celestial refraction in ./refraction.js
// and the two must not be confused:
//
//   ./refraction.js      light from an effectively infinite source, integrated
//                        through the WHOLE atmosphere. Saemundsson, parameterised
//                        by apparent altitude alone. ~29' at the horizon.
//
//   this file            light from a target a finite distance away, which has
//                        only traversed the part of the atmosphere between the
//                        observer and the target. Parameterised by RANGE.
//                        ~0.72' at 20 km.
//
// The classic surveying result: a ray through a horizontally stratified lower
// atmosphere has near-constant curvature 1/rho = k/R, where k is the refraction
// coefficient (~0.13 in the standard atmosphere). Over a path of horizontal
// length d the total bend is k*d/R, and the angle between the chord to the
// target and the tangent at the observer — which is what the observer actually
// sees — is half of that:
//
//     dTheta = k*d / (2R)              apparent elevation gain
//     dh     = d*dTheta = k*d^2 / (2R) equivalent vertical lift at the target
//
// which is the same first-order geometry as the "effective Earth radius"
// R_eff = R/(1-k) used by surveyors and radar engineers. (Note the traditional
// "7/6 Earth" is k = 1/7 = 0.1429, not 0.13 — close, but not the same number.)
//
// k is NOT independent of the celestial refraction controls. Refractivity goes
// as P/T, and differentiating that through the hydrostatic relation gives
//
//     k = 503 * (P / T^2) * (0.0342 + dT/dh)      P hPa, T Kelvin, dT/dh K/m
//
// so two of k's three inputs are the SAME pressure and temperature the
// Saemundsson path already uses. Only the surface temperature gradient is new,
// and that is where the two models genuinely part company: the astronomical
// integral is dominated by the free troposphere, where the lapse rate is
// climatologically dull, while a terrestrial ray never leaves the surface layer,
// where dT/dh runs from -34 K/km (autoconvective, mirage) to +50 K/km (strong
// inversion) and swings k from 0 to over 0.5.
//
// So k is DERIVED from pressure, temperature and a surface-gradient control,
// with an explicit override for fitting it directly to an observation.
//
// Note the traditional surveying k = 0.13 is not "the standard atmosphere" — it
// implies dT/dh = -13.7 K/km, a strongly superadiabatic sun-warmed LAND surface.
// A standard 6.5 K/km lapse gives 0.176.
//
// Validity: near-horizontal rays with both endpoints in the lower troposphere.
// Beyond that the constant-k assumption fails, so the bend angle is smoothly
// saturated at maxBendRad (see terrestrialBendAngle) rather than being allowed
// to grow without limit — distant geometry then converges on a bend comparable
// to the astronomical one instead of ballooning off the top of the screen.

import {Material, Matrix4, Vector3} from "three";
import {zenithECEFFromPosition} from "./refraction";

export const TERRESTRIAL_REFRACTION_DEFAULTS = {
    enabled: false,
    // Surface temperature gradient, K per km. -6.5 is the standard lapse rate,
    // which at 1010 hPa / 10 °C derives k = 0.176.
    lapseRateKPerKm: -6.5,
    // Only used when overrideK is set — the traditional surveying value.
    overrideK: false,
    k: 0.13,
    // Saturation ceiling for the bend angle, in radians. 34' is roughly the
    // astronomical refraction at the horizon — a finite target can never be
    // lifted by more than the whole atmosphere would lift a star.
    maxBendRad: 34 / 60 * Math.PI / 180,
};

// WGS84, matching ./refraction.js. Callers should pass the ACTIVE radii
// (Globals.equatorRadius / Globals.polarRadius) so this tracks Sit.useEllipsoid.
const WGS84_A = 6378137.0;
const WGS84_B = WGS84_A * (1 - 1 / 298.257223563);

// Shared uniforms. Every patched material references these same objects, so one
// update per view render propagates everywhere with no per-material work.
//
// uTerrK of 0 disables the effect inside the shader, and the arithmetic then
// reduces EXACTLY to the unpatched `projectionMatrix * mvPosition`, so a
// patched-but-disabled material renders bit-identically to an unpatched one.
export const terrestrialRefractionUniforms = {
    uTerrK: {value: 0.0},
    uTerrZenithView: {value: new Vector3(0, 1, 0)},
    uTerrInvR: {value: 1 / WGS84_A},
    uTerrMaxBend: {value: TERRESTRIAL_REFRACTION_DEFAULTS.maxBendRad},
};

// k from the state of the air. Same P and T the celestial refraction uses, plus
// the surface temperature gradient. Clamped at 0 below the autoconvective
// gradient (-34.2 K/km), where the density gradient reverses and the model has
// left the regime it describes — that is mirage territory, not a bend angle.
export function terrestrialKFromAtmosphere(pressureHPa, tempC, lapseRateKPerKm) {
    const T = Math.max(1, tempC + 273.15);
    const k = 503 * (pressureHPa / (T * T)) * (0.0342 + lapseRateKPerKm / 1000);
    return Math.max(0, k);
}

// Resolve the coefficient actually in force from a Sit-like settings object.
// Plain property reads, so this stays testable without the app's global graph.
export function resolveTerrestrialK(sit) {
    if (sit.terrestrialRefractionOverrideK) {
        return sit.terrestrialRefractionK ?? TERRESTRIAL_REFRACTION_DEFAULTS.k;
    }
    return terrestrialKFromAtmosphere(
        sit.refractionPressure ?? 1010,
        sit.refractionTemp ?? 10,
        sit.terrestrialLapseRate ?? TERRESTRIAL_REFRACTION_DEFAULTS.lapseRateKPerKm,
    );
}

// Per-view options block. Sit and Globals are passed in rather than imported so
// this module keeps its "three only" dependency, as ./refraction.js does.
export function terrestrialOptsFrom(sit, globals) {
    return {
        enabled: sit.terrestrialRefraction ?? TERRESTRIAL_REFRACTION_DEFAULTS.enabled,
        k: resolveTerrestrialK(sit),
        equatorRadius: globals.equatorRadius,
        polarRadius: globals.polarRadius,
    };
}

// Gaussian radius of curvature sqrt(M*N) at a geodetic latitude, from sin(lat).
// Using the Gaussian mean rather than a direction-resolved M/N pair costs at
// most 0.3% at this latitude, far below the uncertainty in k itself. With equal
// radii (the legacy spherical earth) this returns that sphere's radius exactly.
export function gaussianRadius(sinLat, a = WGS84_A, b = WGS84_B) {
    const asqr = a * a, bsqr = b * b;
    const e2 = (asqr - bsqr) / asqr;
    if (e2 <= 0) return a;
    return a * Math.sqrt(1 - e2) / (1 - e2 * sinLat * sinLat);
}

// Apparent elevation gain, in radians, for a target at horizontal range d.
// Linear in d at short range (the surveying law) and smoothly saturating at
// maxBendRad. The saturator is the algebraic sigmoid u/sqrt(1+u^2) rather than
// tanh: same shape, no exp, and available in every GLSL version Sitrec targets.
export function terrestrialBendAngle(d, k, R, maxBendRad = TERRESTRIAL_REFRACTION_DEFAULTS.maxBendRad) {
    if (!k || d <= 0) return 0;
    const linear = k * d / (2 * R);
    if (!maxBendRad) return linear;
    const u = linear / maxBendRad;
    return maxBendRad * u / Math.sqrt(1 + u * u);
}

// Equivalent vertical lift, in metres, at horizontal range d.
export function terrestrialLift(d, k, R, maxBendRad = TERRESTRIAL_REFRACTION_DEFAULTS.maxBendRad) {
    return d * terrestrialBendAngle(d, k, R, maxBendRad);
}

const _camPos = new Vector3();
const _zenith = new Vector3();
const _viewInverse = new Matrix4();

// Recompute the shared uniforms for one camera. Must be called immediately
// before that camera's render, because the effect is observer-relative and
// Sitrec renders several views with different cameras from the same scene.
//
// opts: {enabled, k, maxBendRad, equatorRadius, polarRadius}
export function updateTerrestrialRefractionUniforms(camera, opts = {}) {
    const enabled = opts.enabled ?? TERRESTRIAL_REFRACTION_DEFAULTS.enabled;
    const k = enabled ? (opts.k ?? TERRESTRIAL_REFRACTION_DEFAULTS.k) : 0;
    terrestrialRefractionUniforms.uTerrK.value = k;
    if (!k || !camera) return;

    const a = opts.equatorRadius ?? WGS84_A;
    const b = opts.polarRadius ?? WGS84_B;
    terrestrialRefractionUniforms.uTerrMaxBend.value =
        opts.maxBendRad ?? TERRESTRIAL_REFRACTION_DEFAULTS.maxBendRad;

    camera.updateMatrixWorld();
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    // Geodetic zenith (ellipsoid normal), not the geocentric radial — the same
    // vertical the celestial refraction bends about. Scene coordinates are ECEF.
    zenithECEFFromPosition(_camPos, _zenith, a, b);
    // The geodetic zenith's Z component IS sin(latitude) by construction.
    terrestrialRefractionUniforms.uTerrInvR.value = 1 / gaussianRadius(_zenith.z, a, b);
    // Carry it into view space. The view matrix is inverted from matrixWorld
    // here rather than read from camera.matrixWorldInverse, because callers run
    // BEFORE renderer.render() — which is where Three refreshes that cached
    // inverse. Trusting it would leave the bend axis one frame stale on a moving
    // camera, and flat wrong for an offscreen pass that re-points the camera
    // before rendering (the long-exposure occlusion mask does exactly that).
    _viewInverse.copy(camera.matrixWorld).invert();
    terrestrialRefractionUniforms.uTerrZenithView.value
        .copy(_zenith)
        .transformDirection(_viewInverse);
}

// GLSL counterpart. Operates in VIEW space — camera at the origin — deliberately:
// scene coordinates are ECEF, ~6.4e6 m, where a float32 resolves about half a
// metre. A 4 m lift added in world space would be quantised into nothing. In
// view space the values are camera-relative and the lift survives.
// Marks the chunk as already present. Guarding on the FUNCTION NAME instead
// would be wrong: a shader that *calls* applyTerrestrialRefraction_chunk (the
// synth-cloud billboards do) would look like it already had the definition, and
// injection would silently skip — leaving "no matching overloaded function
// found" and a mesh that never draws.
const CHUNK_MARKER = "SITREC_TERRESTRIAL_REFRACTION_CHUNK";

export const TERRESTRIAL_REFRACTION_VERTEX_GLSL = /* glsl */`
// ${CHUNK_MARKER}
uniform float uTerrK;
uniform vec3 uTerrZenithView;
uniform float uTerrInvR;
uniform float uTerrMaxBend;

vec3 applyTerrestrialRefraction_chunk(vec3 viewPos) {
    if (uTerrK == 0.0) return viewPos;
    float upComponent = dot(viewPos, uTerrZenithView);
    vec3 horizontal = viewPos - upComponent * uTerrZenithView;
    float d = length(horizontal);
    float u = uTerrK * d * 0.5 * uTerrInvR / uTerrMaxBend;
    float bend = uTerrMaxBend * u * inversesqrt(1.0 + u * u);
    return viewPos + uTerrZenithView * (d * bend);
}

// The one line every hand-written vertex shader needs: swap
//     gl_Position = projectionMatrix * mvPosition;
// for
//     gl_Position = applyTerrestrialRefraction_clip(mvPosition);
// Anything derived from gl_Position afterwards — manual log depth, a vDepth
// varying — then picks up the apparent depth for free, which is what keeps
// colour and fragment depth agreeing.
vec4 applyTerrestrialRefraction_clip(vec4 mvPosition) {
    return projectionMatrix * vec4(applyTerrestrialRefraction_chunk(mvPosition.xyz), mvPosition.w);
}
`;

// Insert the chunk into a hand-written vertex shader. Idempotent.
export function injectTerrestrialRefractionChunk(vertexShader) {
    if (vertexShader.includes(CHUNK_MARKER)) return vertexShader;
    return vertexShader.replace("void main() {",
        TERRESTRIAL_REFRACTION_VERTEX_GLSL + "\nvoid main() {");
}

// For Sitrec's own hand-written ShaderMaterials. Wires the shared uniforms in
// (by reference, mutating in place so anyone holding the uniforms object keeps
// working) and injects the chunk:
//
//     const m = new ShaderMaterial({uniforms, vertexShader, ...});
//     installTerrestrialRefractionOnShaderMaterial(m);
//
// The shader itself still opts in by calling applyTerrestrialRefraction_clip
// where it builds gl_Position — deliberately explicit, because these shaders
// each compute their view position differently and a textual rewrite of
// arbitrary source is exactly the kind of thing that breaks quietly.
export function installTerrestrialRefractionOnShaderMaterial(material) {
    if (!material || _installed.has(material)) return;
    if (!material.uniforms) material.uniforms = {};
    addTerrestrialRefractionUniforms({uniforms: material.uniforms});
    material.vertexShader = injectTerrestrialRefractionChunk(material.vertexShader);
    _installed.add(material);
    material.needsUpdate = true;
}

// Point a shader's uniform slots at the shared objects.
export function addTerrestrialRefractionUniforms(shader) {
    shader.uniforms.uTerrK = terrestrialRefractionUniforms.uTerrK;
    shader.uniforms.uTerrZenithView = terrestrialRefractionUniforms.uTerrZenithView;
    shader.uniforms.uTerrInvR = terrestrialRefractionUniforms.uTerrInvR;
    shader.uniforms.uTerrMaxBend = terrestrialRefractionUniforms.uTerrMaxBend;
}

// Patch a vertex shader that uses Three's stock <project_vertex> chunk.
//
// ONLY gl_Position is rewritten. mvPosition, vViewPosition, worldPosition,
// normals and shadow coordinates are all left physical, because refraction
// bends light — it does not move the land. That also keeps the shadow map (a
// separate depth-material pass that never sees this patch) consistent with the
// geometry it is shadowing.
//
// Returns {vertexShader, matched}. `matched` false means this shader builds its
// clip position some other way and is NOT warped — the caller must not treat
// that as success, or a custom shader ends up silently and permanently
// geometric while everything around it lofts.
// Three's own vertex shaders build their clip position in three different ways,
// so there are three patterns. Everything in ShaderLib except sprite, vsm and
// background goes through <project_vertex>; sprites billboard around the object
// origin; fat lines (Line2/LineSegments2) extrude a quad from two endpoints.
//
// In the two bespoke cases the PHYSICAL view position is kept and restored
// before <clipping_planes_vertex> and <fog_vertex>, so those stay geometric like
// every stock material's. Only gl_Position — and the log-depth derived from it —
// becomes apparent.
const SPRITE_ANCHOR = "vec4 mvPosition = modelViewMatrix[ 3 ];";
const FATLINE_ENDPOINTS = "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );";
const FATLINE_APPROX_MV = "vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation";

export function patchTerrestrialRefractionVertexShader(vertexShader) {
    if (vertexShader.includes(CHUNK_MARKER)) {
        return {vertexShader, matched: true};
    }

    let out = vertexShader;
    let matched = false;

    // (a) stock <project_vertex>: meshes, LineBasic/LineDashed, points, depth
    if (out.includes("#include <project_vertex>")) {
        out = out.replace(
            "#include <project_vertex>",
            "#include <project_vertex>\n\tgl_Position = applyTerrestrialRefraction_clip(mvPosition);",
        );
        matched = true;
    }

    // (b) sprites: loft the billboard's anchor, then build the quad around it
    if (out.includes(SPRITE_ANCHOR)) {
        out = out.replace(SPRITE_ANCHOR,
            SPRITE_ANCHOR
            + "\n\tvec4 sitrecPhysicalMV = mvPosition;"
            + "\n\tmvPosition.xyz = applyTerrestrialRefraction_chunk(mvPosition.xyz);");
        // restore after log depth has consumed the apparent gl_Position
        out = out.replace("#include <clipping_planes_vertex>",
            "\tmvPosition = sitrecPhysicalMV;\n\t#include <clipping_planes_vertex>");
        matched = true;
    }

    // (c) fat lines: both endpoints, before everything downstream derives from
    // them — clip positions, NDC, extrusion basis, endcaps and trimSegment.
    // Dash phase keys off instanceDistanceStart/End and so stays physical.
    if (out.includes(FATLINE_ENDPOINTS)) {
        out = out.replace(FATLINE_ENDPOINTS,
            FATLINE_ENDPOINTS
            + "\n\t\t\tvec4 sitrecPhysicalStart = start;"
            + "\n\t\t\tvec4 sitrecPhysicalEnd = end;"
            + "\n\t\t\tstart.xyz = applyTerrestrialRefraction_chunk(start.xyz);"
            + "\n\t\t\tend.xyz = applyTerrestrialRefraction_chunk(end.xyz);");
        out = out.replace(FATLINE_APPROX_MV,
            "vec4 mvPosition = ( position.y < 0.5 ) ? sitrecPhysicalStart : sitrecPhysicalEnd;");
        matched = true;
    }

    if (!matched) return {vertexShader, matched: false};
    return {matched: true, vertexShader: injectTerrestrialRefractionChunk(out)};
}

// Install on a stock Three material (MeshPhongMaterial, MeshBasicMaterial, …).
// Idempotent, and chains any existing onBeforeCompile rather than replacing it.
//
// Installation state lives in a WeakSet, NOT in userData: Material.copy()
// JSON-copies userData but does not copy an instance's onBeforeCompile, so a
// clone of a patched material would inherit the marker without the patch and be
// skipped forever. Materials are cloned in CNode3DObject and CNodeDisplayATFLIR.
const _installed = new WeakSet();
const _warnedUnmatched = new WeakSet();
const TERRESTRIAL_PROGRAM_KEY = "sitrecTerrestrialRefraction.v1";

export function installTerrestrialRefractionOnMaterial(material) {
    if (!material || _installed.has(material)) return;

    const prev = material.onBeforeCompile;

    // Three's DEFAULT customProgramCacheKey returns this.onBeforeCompile
    // .toString(), which is how two otherwise-identical materials that carry
    // different onBeforeCompile patches (e.g. patchMaterialForLinearOutput) get
    // different programs. Wrapping onBeforeCompile would make every patched
    // material report the SAME key and silently share a program. Capture the
    // pre-wrap identity now; call through instead for materials that define
    // their own key, since theirs may depend on mutable state.
    const ownsCacheKey = material.customProgramCacheKey !== _defaultCacheKey;
    const prevCacheKeyFn = ownsCacheKey ? material.customProgramCacheKey : null;
    const frozenDefaultKey = ownsCacheKey ? null : String(prev ?? "");

    // A normal function, not an arrow: Three invokes onBeforeCompile with the
    // material as `this`, and chained callbacks rely on it —
    // StableShadowReceiver's reads this.userData through getPendingStableUniforms.
    material.onBeforeCompile = function (shader, renderer) {
        if (typeof prev === "function") prev.call(this, shader, renderer);
        addTerrestrialRefractionUniforms(shader);
        const result = patchTerrestrialRefractionVertexShader(shader.vertexShader);
        if (result.matched) {
            shader.vertexShader = result.vertexShader;
        } else if (!_warnedUnmatched.has(this)) {
            _warnedUnmatched.add(this);
            console.warn("Terrestrial refraction: no supported clip-position pattern in "
                + `${this.type}${this.name ? " '" + this.name + "'" : ""} (${this.uuid}) — `
                + "it will render at its geometric position while the rest of the scene lofts.");
        }
    };

    material.customProgramCacheKey = function () {
        const base = prevCacheKeyFn ? prevCacheKeyFn.call(this) : frozenDefaultKey;
        return `${base}.${TERRESTRIAL_PROGRAM_KEY}`;
    };

    _installed.add(material);
    material.needsUpdate = true;
}

// Captured once so installTerrestrialRefractionOnMaterial can tell "this
// material uses Three's default cache key" from "it defines its own".
const _defaultCacheKey = Material.prototype.customProgramCacheKey;

// Exposed for tests: is this specific material instance patched?
export function isTerrestrialRefractionInstalled(material) {
    return _installed.has(material);
}

// Mark a subtree as neither lofted nor an occluder. The sweep does not descend
// into it at all, so this is also how the big already-handled subtrees (terrain,
// 3D tiles) are kept out of a per-sweep walk of thousands of meshes.
export const NO_TERRESTRIAL_REFRACTION = "sitrecNoTerrestrialRefraction";

export function excludeFromTerrestrialRefraction(object3D) {
    if (!object3D) return;
    if (!object3D.userData) object3D.userData = {};
    object3D.userData[NO_TERRESTRIAL_REFRACTION] = true;
}

const _asMaterials = m => (Array.isArray(m) ? m : [m]);

// Walk the scene, installing the patch on anything not yet covered and tagging
// solid opaque meshes as occluders.
//
// Object3D.traverse() cannot prune — it recurses unconditionally after the
// callback — so this is an explicit stack. Pruning is the whole point: the
// terrain and 3D-tile groups hold thousands of meshes whose materials are
// already patched at creation, and walking them repeatedly would dwarf the
// cost of everything else here.
//
// Returns the number of materials newly installed, so the caller can tell a
// settled scene from one that is still streaming in.
export function sweepTerrestrialRefraction(root, occluderBit = -1) {
    if (!root) return 0;
    let installedCount = 0;
    const stack = [root];
    while (stack.length) {
        const o = stack.pop();
        if (o.userData && o.userData[NO_TERRESTRIAL_REFRACTION]) continue;

        const material = o.material;
        if (material) {
            let opaque = false;
            for (const m of _asMaterials(material)) {
                if (!m) continue;
                if (!_installed.has(m)) {
                    installTerrestrialRefractionOnMaterial(m);
                    installedCount++;
                }
                if (!m.transparent) opaque = true;
            }
            // Only solid geometry occludes. A Line2 quad, a billboard sprite or
            // a translucent cloud must not mask a star or clamp haze depth —
            // and the single override material used by those passes could not
            // reproduce their vertex transforms anyway.
            if (occluderBit >= 0 && o.isMesh) {
                if (opaque) o.layers.enable(occluderBit);
                else o.layers.disable(occluderBit);
            }
        }

        const children = o.children;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return installedCount;
}
