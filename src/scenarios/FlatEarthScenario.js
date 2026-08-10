// FlatEarthScenario.js — Flat Earth rendering as a Scenario
// (Physics → Scenarios → Flat Earth).
//
// EXPERIMENTAL. Re-renders the scene as a flat disc under a north-polar
// azimuthal equidistant projection (the classic "flat earth map"): every
// world point's (lat, lon, alt) maps to
//
//     rho  = R0 * (90° - lat)         distance from the north pole
//     east = rho * sin(lon - lon0)
//     north= rho0 - rho * cos(lon - lon0)
//
// laid onto the plane tangent to the ellipsoid at the sitch origin
// (Sit.lat/lon) so the local terrain stays approximately where it was and
// the rest of the planet unwraps around it. "Center on Look Camera"
// switches to an OBLIQUE AEP centred on the camera's footprint — the
// observer-centred AE map (see refreshFlatEarthOrigin). RENDER ONLY: physics, tracks,
// LOS, picking and every CPU-side calculation stay on the globe. That
// mismatch is the point — this exists to see what the issues are.
//
// Mechanism is a copy of terrestrialRefraction.js's material patching:
// a chained onBeforeCompile injects the warp into every material the sweep
// finds, gated by the shared uniform uFlatOn. Disabled is a 100% no-op:
// this module is not even imported until the Scenarios menu is opened, no
// scene hook or patch exists until first enable, and after a disable
// uFlatOn=0 makes every patched shader take the original gl_Position path
// bit-identically while the sweep stops running.
//
// Precision: scene coordinates are ECEF (~6.4e6 m), where float32 resolves
// about half a metre. The warp is therefore applied as a DELTA added to the
// CPU-double-precision mvPosition, rotated by the view rotation only — the
// error is then a static sub-metre spatial distortion instead of per-frame
// jitter of the whole scene against the camera.
//
// The CAMERA is warped too, but only for the duration of each render
// (warpCameraPose / restoreCameraPose below): the world's image moves onto
// the disc, so the camera must move with it or a low-altitude camera far
// from the origin films the warped ground from underneath. Everything
// outside the render — physics, controls, readouts — only ever sees the
// physical globe-space pose.
//
// Known gaps (deliberate, bare minimum): sprites and the night/day sky
// scenes are not warped; shadows and reflections stay geometric.
//
// CPU side: while enabled, Globals.flatEarthPickGround routes
// raycastLocalGround — the single source of the ground point under the
// cursor (orbit/zoom anchor, V/B measure arrow, C/X camera placement) —
// through a sphere-trace of the FLAT-space ray against the served elevation
// surface, unwarping each sample back to globe coordinates. The grey polar
// caps are hidden via Globals.flatEarthRendering (they z-fight massively
// once flattened), and frustum culling is disabled on swept objects (their
// bounds stay at globe positions) and restored on disable.

import {Material, Matrix4, Quaternion, Vector3} from "three";
import {Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {CNode} from "../nodes/CNode";
import {sampleGroundSurface} from "../raycastGround";
import {GlobalScene} from "../LocalFrame";
import {radians} from "../utils";
import {ECEFToLLAVD_radii, RLLAToECEF_radii} from "../LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";

// Shared uniforms — every patched material references these same objects.
// uFlatOn is the binary gate (0 = exact no-op); the "Flatness" slider drives
// uFlatCurve, the per-view curvature drop described below.
//
// The warp is a GENERAL (oblique) azimuthal equidistant projection about an
// arbitrary center point C on the sphere:
//
//     Δ(P)  = great-circle angle from C to P
//     ρ     = R0 · Δ                       (distance from C's image)
//     θ(P)  = bearing of P from C
//     image = uFlatCImage + ρ·(sinθ·uFlatMapU + cosθ·uFlatMapV) + alt·uFlatUp
//
// Default mode centers on the NORTH POLE (the classic flat-earth map) with
// the disc anchored so the sitch origin maps to itself; "Center on Look
// Camera" centers on the camera's footprint, making distances and bearings
// true FROM THE CAMERA — the observer-centred AE map — with the tear at
// the camera's antipode. The polar case is algebraically identical to the
// dedicated polar formulas this replaced (Δ = colatitude, θ = longitude,
// stretch Δ/sinΔ = (π/2−lat)/cos lat).
export const flatEarthUniforms = {
    uFlatOn: {value: 0.0},                       // binary gate: 0 off, 1 on
    // Curvature amount c (= 1 − the "Flatness" slider): effective earth
    // radius r = R0/c for the drop below. 0 → r = ∞, zero drop, PERFECTLY
    // FLAT (the division is simply skipped); 1 → r = R0, the true earth's
    // drop re-created on the flat map. Purely per-view and in-shader:
    // every vertex sinks STRAIGHT DOWN by sqrt(r²+d²)−r at horizontal disc
    // distance d from the rendering camera, so changing it never slides
    // geometry sideways (the old lerp morph did, which made distant
    // mountains swim).
    uFlatCurve: {value: 0.0},
    uFlatCDir: {value: new Vector3(0, 0, 1)},    // projection center, unit ECEF
    uFlatCEast: {value: new Vector3(0, 1, 0)},   // bearing frame at the center
    uFlatCNorth: {value: new Vector3(1, 0, 0)},
    uFlatCImage: {value: new Vector3()},         // where the center maps to
    uFlatMapU: {value: new Vector3(1, 0, 0)},    // disc direction of bearing 90°
    uFlatMapV: {value: new Vector3(0, 1, 0)},    // disc direction of bearing 0°
    uFlatUp: {value: new Vector3(0, 0, 1)},      // disc plane normal (up at O)
    uFlatR0: {value: 6371008.8},                 // AEP scale radius
    uFlatA: {value: 6378137.0},                  // active ellipsoid radii, for altitude
    uFlatB: {value: 6356752.3},
};

const CHUNK_MARKER = "SITREC_FLAT_EARTH_CHUNK";

export const FLAT_EARTH_VERTEX_GLSL = /* glsl */`
// ${CHUNK_MARKER}
uniform float uFlatOn;
uniform float uFlatCurve;
uniform vec3 uFlatCDir;
uniform vec3 uFlatCEast;
uniform vec3 uFlatCNorth;
uniform vec3 uFlatCImage;
uniform vec3 uFlatMapU;
uniform vec3 uFlatMapV;
uniform vec3 uFlatUp;
uniform float uFlatR0;
uniform float uFlatA;
uniform float uFlatB;

// World-space displacement that takes an ECEF point to its position on the
// disc of a general azimuthal equidistant projection centred at uFlatCDir
// (see the uniform block comment): angular distance from the center scales
// to disc radius, bearing from the center to disc direction. Geocentric
// latitude and a geocentric ellipsoid surface radius stand in for their
// geodetic twins — consistent everywhere, so local relative geometry
// survives; only the absolute map is approximate.
vec3 flatEarthDelta(vec3 p) {
    if (uFlatOn <= 0.0) return vec3(0.0);
    float r = length(p);
    // Deep-interior geometry (debug arrows and helpers buried at the earth's
    // centre, invisible inside the globe but often depthTest:false) has no
    // meaningful place on the disc — cull the whole primitive by making the
    // vertex NaN. sqrt of a negative uniform defeats constant folding.
    if (r < 1000.0) return vec3(sqrt(-uFlatOn));
    vec3 pHat = p / r;
    float cosD = clamp(dot(pHat, uFlatCDir), -1.0, 1.0);
    float delta = acos(cosD);
    // The center's ANTIPODE is the projection's singular point: its image
    // is the ENTIRE rim circle, so triangles touching its neighborhood
    // tear into chords spanning the whole disc. Cull the degenerate cap
    // (0.5°, the outermost ~55 km of a 20,000 km disc) — selection-side
    // refinement (FlatAwareTilesRenderer's disc-space sagitta) shrinks
    // antipode-containing tiles until they fall inside this cap and die
    // cleanly.
    if (delta > 3.1328661) return vec3(sqrt(-uFlatOn));
    // bearing of p from the center, as (sin, cos) of the azimuth
    vec3 v = pHat - uFlatCDir * cosD;
    float vl = length(v);
    float st = 0.0;
    float ct = 1.0;
    if (vl > 1e-7) {
        st = dot(v, uFlatCEast);
        ct = dot(v, uFlatCNorth);
        float n = inversesqrt(st * st + ct * ct);
        st *= n;
        ct *= n;
    }
    // geocentric radius of the ellipsoid surface at this latitude
    float s = clamp(pHat.z, -1.0, 1.0);
    float c = sqrt(max(1.0 - s * s, 0.0));
    float re = (uFlatA * uFlatB) / sqrt(uFlatB * uFlatB * c * c + uFlatA * uFlatA * s * s);
    float alt = r - re;
    if (alt < -1000000.0) return vec3(sqrt(-uFlatOn));
    float rho = uFlatR0 * delta;
    vec3 flatPos = uFlatCImage
        + uFlatMapU * (rho * st)
        + uFlatMapV * (rho * ct)
        + uFlatUp   * alt;
    // Curvature drop ("Flatness" slider): sink the vertex STRAIGHT DOWN by
    // the tangent-plane drop of an effective earth of radius r = R0/f at
    // horizontal disc distance d from THIS view's (warped) camera —
    // sqrt(r²+d²)−r, evaluated as d²/(sqrt(r²+d²)+r) which is the same
    // quantity without the catastrophic fp32 cancellation at d ≪ r.
    // f = 0 skips everything: r = ∞, perfectly flat. Beyond d ≥ r the
    // effective earth has no surface under the plane — cull.
    if (uFlatCurve > 0.0) {
        float reff = uFlatR0 / uFlatCurve;
        vec3 dv = flatPos - cameraPosition;
        dv -= uFlatUp * dot(dv, uFlatUp);
        float dh = length(dv);
        if (dh >= reff) return vec3(sqrt(-uFlatOn));
        flatPos -= uFlatUp * (dh * dh / (sqrt(reff * reff + dh * dh) + reff));
    }
    return flatPos - p;
}
`;

function injectFlatEarthChunk(vertexShader) {
    if (vertexShader.includes(CHUNK_MARKER)) return vertexShader;
    return vertexShader.replace("void main() {",
        FLAT_EARTH_VERTEX_GLSL + "\nvoid main() {");
}

function addFlatEarthUniforms(shader) {
    for (const k of Object.keys(flatEarthUniforms)) {
        shader.uniforms[k] = flatEarthUniforms[k];
    }
}

// Recompute the world position the same way <project_vertex> built
// mvPosition, warp it, and fold the delta back in through the view rotation
// (translation-free, so no ECEF-scale float32 subtraction).
const PROJECT_VERTEX_APPEND = /* glsl */`
if (uFlatOn > 0.0) {
    vec4 feW = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
        feW = batchingMatrix * feW;
    #endif
    #ifdef USE_INSTANCING
        feW = instanceMatrix * feW;
    #endif
    feW = modelMatrix * feW;
    mvPosition.xyz += mat3( viewMatrix ) * flatEarthDelta( feW.xyz );
    gl_Position = projectionMatrix * mvPosition;
}`;

// Hand-written shader markers. (b) is TerrainDayNightMaterial — it already
// carries a physical world position in vWorldPosition; (c) is the globe's
// day/night ShaderMaterial; (d) is Three's fat lines (Line2/LineMaterial):
// warp both endpoints right where they are computed, BEFORE trimSegment and
// the WORLD_UNITS capture, so everything downstream — clip positions, NDC,
// extrusion basis — derives from the warped ends.
const TERRAIN_CLIP = "vPosition = projectionMatrix * mvPosition;";
const GLOBE_CLIP = "vPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);";
const FATLINE_ENDPOINTS = "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );";

// Returns {vertexShader, matched}, same contract as the refraction patcher.
export function patchFlatEarthVertexShader(vertexShader) {
    if (vertexShader.includes(CHUNK_MARKER)) {
        return {vertexShader, matched: true};
    }

    let out = vertexShader;
    let matched = false;

    // (a) stock <project_vertex>: meshes, 3D tiles, LineBasic, points, ocean
    if (out.includes("#include <project_vertex>")) {
        out = out.replace(
            "#include <project_vertex>",
            "#include <project_vertex>" + PROJECT_VERTEX_APPEND,
        );
        matched = true;
    }

    // (b) terrain tiles (TerrainDayNightMaterial)
    if (!matched && out.includes(TERRAIN_CLIP) && out.includes("vWorldPosition")) {
        out = out.replace(TERRAIN_CLIP,
            "mvPosition.xyz += mat3( viewMatrix ) * flatEarthDelta( vWorldPosition );\n"
            + "                " + TERRAIN_CLIP);
        matched = true;
    }

    // (d) fat lines (Line2/LineSegments2) — tracks, LOS, measurement lines
    if (!matched && out.includes(FATLINE_ENDPOINTS)) {
        out = out.replace(FATLINE_ENDPOINTS,
            FATLINE_ENDPOINTS
            + "\n\t\t\tstart.xyz += mat3( viewMatrix ) * flatEarthDelta( ( modelMatrix * vec4( instanceStart, 1.0 ) ).xyz );"
            + "\n\t\t\tend.xyz += mat3( viewMatrix ) * flatEarthDelta( ( modelMatrix * vec4( instanceEnd, 1.0 ) ).xyz );");
        matched = true;
    }

    // (c) the globe sphere
    if (!matched && out.includes(GLOBE_CLIP)) {
        out = out.replace(GLOBE_CLIP,
            "vec4 feMV = modelViewMatrix * vec4(position, 1.0);\n"
            + "            feMV.xyz += mat3( viewMatrix ) * flatEarthDelta( (modelMatrix * vec4(position, 1.0)).xyz );\n"
            + "            vPosition = projectionMatrix * feMV;");
        matched = true;
    }

    if (!matched) return {vertexShader, matched: false};
    return {vertexShader: injectFlatEarthChunk(out), matched: true};
}

// Install on a material. Idempotent, chains any existing onBeforeCompile —
// including the refraction patch — and keeps program cache keys distinct.
// Same WeakSet/cache-key reasoning as installTerrestrialRefractionOnMaterial.
const _installed = new WeakSet();
const _warnedUnmatched = new WeakSet();
const FLAT_EARTH_PROGRAM_KEY = "sitrecFlatEarth.v1";
const _defaultCacheKey = Material.prototype.customProgramCacheKey;

export function installFlatEarthOnMaterial(material) {
    if (!material || _installed.has(material)) return;

    const prev = material.onBeforeCompile;
    const ownsCacheKey = material.customProgramCacheKey !== _defaultCacheKey;
    const prevCacheKeyFn = ownsCacheKey ? material.customProgramCacheKey : null;
    const frozenDefaultKey = ownsCacheKey ? null : String(prev ?? "");

    material.onBeforeCompile = function (shader, renderer) {
        if (typeof prev === "function") prev.call(this, shader, renderer);
        addFlatEarthUniforms(shader);
        const result = patchFlatEarthVertexShader(shader.vertexShader);
        if (result.matched) {
            shader.vertexShader = result.vertexShader;
        } else if (!_warnedUnmatched.has(this)) {
            _warnedUnmatched.add(this);
            console.warn("Flat Earth: no supported clip-position pattern in "
                + `${this.type}${this.name ? " '" + this.name + "'" : ""} — `
                + "it will render at its globe position.");
        }
    };

    material.customProgramCacheKey = function () {
        const base = prevCacheKeyFn ? prevCacheKeyFn.call(this) : frozenDefaultKey;
        return `${base}.${FLAT_EARTH_PROGRAM_KEY}`;
    };

    _installed.add(material);
    material.needsUpdate = true;
}

const _asMaterials = m => (Array.isArray(m) ? m : [m]);

// Frustum culling tests the UNWARPED bounds, so an object whose globe
// position is off-screen would vanish even though its disc position is in
// view. Culling is switched off on every swept renderable (only ones that
// had it on) and switched back on from this set when the mode is disabled.
// Strong Sets, not WeakMaps restored by a scene walk: tile meshes routinely
// leave the scene during LOD churn, and a disable while they are detached
// must still restore them for when they re-enter. The strong references
// live only until the next disable; they hold no GPU resources.
const _culledOff = new Set();

// Objects that are pure garbage under the warp: the satellite flare-band
// circles are globe-girdling fat lines whose segments cross the antipode,
// where the AEP tears — they smear into giant polygons across the disc.
// Hidden by name during the sweep, restored on disable.
const FLAT_HIDE_NAMES = new Set(["globeCircle1", "globeCircle2"]);
const _hiddenByFlat = new Set();

// Walk the whole scene (explicit stack, no pruning — terrain and 3D-tile
// materials are exactly the ones we need) installing the patch on anything
// new and disabling frustum culling. Only runs while enabled, throttled below.
function sweepFlatEarth(root) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
        const o = stack.pop();
        if (o.material) {
            for (const m of _asMaterials(o.material)) {
                if (m && !_installed.has(m)) installFlatEarthOnMaterial(m);
            }
            if (o.frustumCulled) {
                _culledOff.add(o);
                o.frustumCulled = false;
            }
        }
        if (FLAT_HIDE_NAMES.has(o.name) && o.visible) {
            _hiddenByFlat.add(o);
            o.visible = false;
        }
        const children = o.children;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
}

function restoreSceneState() {
    for (const o of _culledOff) o.frustumCulled = true;
    _culledOff.clear();
    for (const o of _hiddenByFlat) o.visible = true;
    _hiddenByFlat.clear();
}

// Projection frame from the current settings. Cheap; refreshed on the
// sweep cadence so a sitch/terrain switch re-anchors the disc — and every
// render when centred on the look camera, so the projection follows it.
//
// Two modes:
//  - Default: the classic NORTH-POLAR AEP (bearing = longitude, radius =
//    colatitude), anchored so the sitch origin maps to itself. This is the
//    canonical flat-earth map.
//  - Center on Look Camera: an OBLIQUE AEP whose projection center is the
//    look camera's footprint — distances and bearings are true FROM THE
//    CAMERA (the observer-centred AE map), zero distortion at the camera,
//    and the tear at the camera's antipode.
function refreshFlatEarthOrigin() {
    let lat = Sit.lat;
    let lon = Sit.lon;
    const centerOnCamera = flatEarth.centerOnLookCamera && NodeMan.exists("lookCamera");
    if (centerOnCamera) {
        const p = NodeMan.get("lookCamera").camera?.position;
        if (p && p.lengthSq() > 1) {
            const LLA = ECEFToLLAVD_radii(p);
            lat = LLA.x;
            lon = LLA.y;
        }
    }
    if (lat === undefined || lon === undefined) {
        // Signal failure (and stop any live warp) — applyFlatEarthState
        // turns the mode fully off on a false return rather than running
        // with stale or default projection uniforms.
        flatEarthUniforms.uFlatOn.value = 0.0;
        console.warn("Flat Earth: no anchor point (Sit.lat/lon undefined), disabling");
        return false;
    }
    const O = RLLAToECEF_radii(radians(lat), radians(lon), 0);
    const u = flatEarthUniforms;
    const east = getLocalEastVector(O);
    const north = getLocalNorthVector(O);
    u.uFlatUp.value.copy(getLocalUpVector(O));
    u.uFlatA.value = Globals.equatorRadius;
    u.uFlatB.value = Globals.polarRadius;
    u.uFlatR0.value = (2 * Globals.equatorRadius + Globals.polarRadius) / 3;
    const R0 = u.uFlatR0.value;

    if (centerOnCamera) {
        // Oblique AEP centred at O itself. The projection vertical is the
        // GEOCENTRIC direction of O (the vertical the warp's altitude
        // preserves); the map is laid north-up on O's tangent plane.
        const cHat = u.uFlatCDir.value.copy(O).normalize();
        const eC = u.uFlatCEast.value.set(-cHat.y, cHat.x, 0).normalize();
        u.uFlatCNorth.value.crossVectors(cHat, eC);
        u.uFlatCImage.value.copy(O);
        u.uFlatMapU.value.copy(east);
        u.uFlatMapV.value.copy(north);
    } else {
        // North-polar AEP: bearing from the pole is longitude (frame chosen
        // so atan2 of the tangential components yields lon), and the pole's
        // image sits colatitude·R0 due north of the origin on the disc.
        // The map directions are rotated so bearing lon0 points from the
        // pole's image back toward the origin — which is what anchors the
        // origin to itself.
        u.uFlatCDir.value.set(0, 0, 1);
        u.uFlatCEast.value.set(0, 1, 0);
        u.uFlatCNorth.value.set(1, 0, 0);
        const lon0 = Math.atan2(O.y, O.x);
        const lat0gc = Math.asin(O.z / O.length());
        const rho0 = R0 * (Math.PI / 2 - lat0gc);
        u.uFlatCImage.value.copy(O).addScaledVector(north, rho0);
        const cl = Math.cos(lon0), sl = Math.sin(lon0);
        u.uFlatMapU.value.copy(east).multiplyScalar(cl).addScaledVector(north, -sl);
        u.uFlatMapV.value.copy(east).multiplyScalar(-sl).addScaledVector(north, -cl);
    }
    return true;
}

// ── Render-time camera warp ─────────────────────────────────────────
//
// The vertex warp moves the WORLD onto the disc; the camera must follow or
// it films the wrong ground. Concretely: the AEP unrolls the globe's
// curvature, so at D km from the tangent origin the ground's image is
// lifted ~D²/2R onto the disc plane (3.9 km at 230 km out) — an unwarped
// camera at low altitude there ends up UNDER the warped terrain, rendering
// it edge-on as smeared streaks. So each render of the world scene warps
// the camera pose (position through the point warp, orientation through
// the warp's Jacobian — see warpCameraPose) and restores it afterwards:
//
//  - scene.onBeforeRender fires BEFORE Three builds the view-projection
//    matrix and the render list (WebGLRenderer.render: onBeforeRender at
//    ~1629, _projScreenMatrix at ~1636), so a pose change plus
//    updateMatrixWorld(true) — which for cameras also refreshes
//    matrixWorldInverse — is fully effective for that render.
//  - scene.onAfterRender restores the exact saved pose, so physics, the
//    controls, HUD readouts and everything else outside the render only
//    ever see the physical globe-space camera.
//  - The save lives on the camera object, which makes the warp idempotent
//    per camera and safe for every render path that draws GlobalScene
//    (main view, look view, effects prepasses, video export, CubeCamera's
//    six faces — each face camera gets its own warp/restore).
//  - Cameras parented to anything but the scene are left alone: their
//    world pose is not freely settable through position/quaternion.
//
// Near the origin the warp is identity, so ordinary sitches render exactly
// as before; the camera warp only becomes visible where the world's image
// has genuinely moved.
// Orientation goes through the warp's NUMERICAL JACOBIAN, not just the
// local frame rotation. The AEP's Jacobian is a rotation plus an
// anisotropic stretch (radial scale 1, tangential scale σ), so directions
// SKEW: the image of a ray at 45° to the radial is not 45° from the
// radial's image. A camera warped with only the frame rotation films to
// the side of what its physical boresight hits — the main-view frustum
// (whose line geometry warps per-vertex, skew included) pointed at the
// target while the look view showed its flank. Pushing the camera's
// forward and up axes through directional derivatives of the warp keeps
// it aimed at the IMAGE of whatever it physically aims at, matching the
// frustum exactly to first order.
const _camQ = new Quaternion();
const _wcW0 = new Vector3(), _wcWa = new Vector3(), _wcP = new Vector3();
const _wcF = new Vector3(), _wcU = new Vector3(), _wcR = new Vector3();
const _wcM = new Matrix4();

// Directional derivative of the warp at p along dir (unit), into target.
// Returns false if degenerate. 1 m probe — CPU doubles, no precision issue.
function warpDirection(p, dir, target) {
    flatEarthWarpPoint(p, _wcW0);
    flatEarthWarpPoint(_wcP.copy(p).add(dir), _wcWa);
    target.copy(_wcWa).sub(_wcW0);
    if (target.lengthSq() < 1e-12) return false;
    target.normalize();
    return true;
}

function warpCameraPose(camera) {
    if (flatEarthUniforms.uFlatOn.value <= 0) return;
    if (!camera || camera._flatEarthSavedPose) return;
    if (camera.parent && !camera.parent.isScene) return;
    const saved = camera._flatEarthSavedPose = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
    };
    _wcF.set(0, 0, -1).applyQuaternion(saved.quaternion);
    _wcU.set(0, 1, 0).applyQuaternion(saved.quaternion);
    const okF = warpDirection(saved.position, _wcF, _wcF);
    const okU = warpDirection(saved.position, _wcU, _wcU);
    flatEarthWarpPoint(saved.position, camera.position);
    if (okF && okU) {
        _wcR.crossVectors(_wcF, _wcU);
        if (_wcR.lengthSq() > 1e-12) {
            _wcR.normalize();
            _wcU.crossVectors(_wcR, _wcF);
            _wcM.makeBasis(_wcR, _wcU, _wcF.negate());
            camera.quaternion.setFromRotationMatrix(_wcM);
            camera.updateMatrixWorld(true);
            return;
        }
    }
    // Degenerate Jacobian (projection center/antipode): fall back to the
    // pure frame rotation.
    flatEarthFrameQuat(saved.position, _camQ);
    camera.quaternion.premultiply(_camQ);
    camera.updateMatrixWorld(true);
}

function restoreCameraPose(camera) {
    const saved = camera?._flatEarthSavedPose;
    if (!saved) return;
    camera.position.copy(saved.position);
    camera.quaternion.copy(saved.quaternion);
    camera._flatEarthSavedPose = null;
    camera.updateMatrixWorld(true);
}

const SWEEP_INTERVAL_MS = 500;
let _lastSweepMs = -1e9;
let _sceneHookInstalled = null;

function installFlatEarthSceneHook(scene) {
    if (!scene || _sceneHookInstalled === scene) return;
    const previous = scene.onBeforeRender;
    const previousAfter = scene.onAfterRender;
    scene.onBeforeRender = function (renderer, sceneArg, camera, renderTarget) {
        // A look-camera-centred disc follows that camera, so its frame must
        // be current before this render's camera pose is warped. Idempotent
        // across the several renders of one frame (the look camera only
        // moves between frames).
        if (flatEarth.centerOnLookCamera && flatEarthUniforms.uFlatOn.value > 0) {
            refreshFlatEarthOrigin();
        }
        // Warp FIRST so chained hooks (terrestrial refraction re-points its
        // observer-relative uniforms here) see the pose the render will use.
        warpCameraPose(camera);
        if (typeof previous === "function") {
            previous.call(this, renderer, sceneArg, camera, renderTarget);
        }
        if (flatEarthUniforms.uFlatOn.value === 0.0) return;
        const now = performance.now();
        if (now - _lastSweepMs < SWEEP_INTERVAL_MS) return;
        _lastSweepMs = now;
        refreshFlatEarthOrigin();
        sweepFlatEarth(this);
    };
    scene.onAfterRender = function (renderer, sceneArg, camera) {
        if (typeof previousAfter === "function") {
            previousAfter.call(this, renderer, sceneArg, camera);
        }
        restoreCameraPose(camera);
    };
    _sceneHookInstalled = scene;
}

// ── CPU twins of the shader warp ────────────────────────────────────

// Full (flatness=1) warp, the JS mirror of flatEarthDelta's flatPos.
const _fwV = new Vector3();

function fullWarp(p, target) {
    const u = flatEarthUniforms;
    const r = p.length();
    if (r < 1000) return target.copy(p);
    const C = u.uFlatCDir.value;
    const px = p.x / r, py = p.y / r, pz = p.z / r;
    const cosD = Math.min(1, Math.max(-1, px * C.x + py * C.y + pz * C.z));
    const delta = Math.acos(cosD);
    // bearing (sin, cos) of p from the projection center
    _fwV.set(px - C.x * cosD, py - C.y * cosD, pz - C.z * cosD);
    let st = 0, ct = 1;
    if (_fwV.lengthSq() > 1e-14) {
        st = _fwV.dot(u.uFlatCEast.value);
        ct = _fwV.dot(u.uFlatCNorth.value);
        const n = 1 / Math.hypot(st, ct);
        st *= n;
        ct *= n;
    }
    const s = Math.min(1, Math.max(-1, pz));
    const c = Math.sqrt(Math.max(1 - s * s, 0));
    const a = u.uFlatA.value, b = u.uFlatB.value;
    const re = (a * b) / Math.sqrt(b * b * c * c + a * a * s * s);
    const alt = r - re;
    const rho = u.uFlatR0.value * delta;
    const me = rho * st, mn = rho * ct;
    const I = u.uFlatCImage.value, U = u.uFlatMapU.value, V = u.uFlatMapV.value, UP = u.uFlatUp.value;
    return target.set(
        I.x + U.x * me + V.x * mn + UP.x * alt,
        I.y + U.y * me + V.y * mn + UP.y * alt,
        I.z + U.z * me + V.z * mn + UP.z * alt,
    );
}

// Exact analytic inverse of the full warp: disc-plane coordinates back
// through the AEP (radius → angular distance from the center, direction →
// bearing) to a unit ECEF direction, then out along the geocentric radius.
function fullUnwarp(f, target) {
    const u = flatEarthUniforms;
    const I = u.uFlatCImage.value, U = u.uFlatMapU.value, V = u.uFlatMapV.value, UP = u.uFlatUp.value;
    const dx = f.x - I.x, dy = f.y - I.y, dz = f.z - I.z;
    const me = dx * U.x + dy * U.y + dz * U.z;
    const mn = dx * V.x + dy * V.y + dz * V.z;
    const alt = dx * UP.x + dy * UP.y + dz * UP.z;
    const R0 = u.uFlatR0.value;
    const rho = Math.min(Math.hypot(me, mn), R0 * Math.PI);
    let st = 0, ct = 1;
    if (rho > 1e-9) {
        st = me / rho;
        ct = mn / rho;
    }
    const delta = rho / R0;
    const sinD = Math.sin(delta), cosD = Math.cos(delta);
    const C = u.uFlatCDir.value, E = u.uFlatCEast.value, N = u.uFlatCNorth.value;
    const px = C.x * cosD + (E.x * st + N.x * ct) * sinD;
    const py = C.y * cosD + (E.y * st + N.y * ct) * sinD;
    const pz = C.z * cosD + (E.z * st + N.z * ct) * sinD;
    const s = Math.min(1, Math.max(-1, pz));
    const c = Math.sqrt(Math.max(1 - s * s, 0));
    const a = u.uFlatA.value, b = u.uFlatB.value;
    const re = (a * b) / Math.sqrt(b * b * c * c + a * a * s * s);
    const r = re + alt;
    return target.set(px * r, py * r, pz * r);
}

// ── Local-frame rotation between globe and disc ─────────────────────
//
// The warp moves POINTS, but an oriented thing at P (a camera) also needs
// the rotation between the local frames: on the globe the vertical at P is
// the (geocentric) radial and "north" points along the meridian; on the
// disc the vertical is up0 everywhere and "north" points at the disc's
// pole. The quaternion returned here maps globe-frame directions at P to
// disc-frame directions at warp(P); identity when the mode is off.
//
// The geocentric vertical is used deliberately — it is the vertical the
// warp itself preserves as altitude — so a camera pitched at its local
// horizon stays pitched at the disc's surface, which is what keeps a
// low-altitude look camera above the ground it is filming.
const _fqUg = new Vector3(), _fqNg = new Vector3(), _fqEg = new Vector3();
const _fqUd = new Vector3(), _fqNd = new Vector3(), _fqEd = new Vector3();
const _fqMg = new Matrix4(), _fqMd = new Matrix4();
const _fqQg = new Quaternion(), _fqQd = new Quaternion();

export function flatEarthFrameQuat(p, target = new Quaternion()) {
    const u = flatEarthUniforms;
    const k = u.uFlatOn.value;
    target.identity();
    if (k <= 0) return target;
    const r = p.length();
    if (r < 1000) return target;

    // globe frame at p: Ug radial, Ng the tangent direction toward the
    // projection CENTER (the great-circle bearing that the disc preserves),
    // Eg its perpendicular. At the center itself (or its antipode) the
    // bearing is undefined — fall back to the center's own frame so a
    // camera at the projection center gets a well-defined, consistent
    // rotation instead of noise.
    const C = u.uFlatCDir.value;
    _fqUg.copy(p).divideScalar(r);
    const cosD = _fqUg.dot(C);
    _fqNg.copy(C).addScaledVector(_fqUg, -cosD);
    let st = 0, ct = 1;
    if (_fqNg.lengthSq() > 1e-12) {
        _fqNg.normalize();
        // bearing of p from the center, for the disc-side frame below.
        // (toward-center bearing at p is the RECIPROCAL azimuth; both
        // frames rotate together so only consistency matters.)
        _fwV.copy(_fqUg).addScaledVector(C, -cosD);
        st = _fwV.dot(u.uFlatCEast.value);
        ct = _fwV.dot(u.uFlatCNorth.value);
        const n = 1 / Math.hypot(st, ct);
        st *= n;
        ct *= n;
    } else {
        _fqNg.copy(u.uFlatCNorth.value).addScaledVector(_fqUg, -_fqUg.dot(u.uFlatCNorth.value)).normalize();
    }
    _fqEg.crossVectors(_fqNg, _fqUg);

    // disc frame at warp(p): uFlatUp vertical, "toward the center's image"
    // = the negated radial map direction at bearing (st, ct)
    const U = u.uFlatMapU.value, V = u.uFlatMapV.value;
    _fqNd.set(
        -(U.x * st + V.x * ct),
        -(U.y * st + V.y * ct),
        -(U.z * st + V.z * ct),
    );
    if (_fqNd.lengthSq() < 1e-12) _fqNd.copy(u.uFlatMapV.value).negate();
    _fqNd.normalize();
    _fqUd.copy(u.uFlatUp.value);
    _fqEd.crossVectors(_fqNd, _fqUd);

    // globe "toward center" pairs with disc "toward center's image":
    // Ng maps to −n̂d's negation... both frames use toward-center as their
    // second axis, so build them the same way: globe (Eg, Ng, Ug) → disc
    // (êd, n̂d_towardCenter, ûd) with n̂d_towardCenter = _fqNd.
    _fqMg.makeBasis(_fqEg, _fqNg, _fqUg);
    _fqMd.makeBasis(_fqEd, _fqNd, _fqUd);
    _fqQg.setFromRotationMatrix(_fqMg).invert();
    _fqQd.setFromRotationMatrix(_fqMd);
    _fqQd.multiply(_fqQg);          // globe frame → disc frame
    return target.copy(_fqQd);
}

// Rendered disc position of a globe point. Deliberately EXCLUDES the
// per-view curvature drop (uFlatCurve): the drop is camera-relative eye
// candy applied in the shader, different for every view, so no single
// world-space position could honor it.
export function flatEarthWarpPoint(p, target = new Vector3()) {
    if (flatEarthUniforms.uFlatOn.value <= 0) return target.copy(p);
    return fullWarp(p, target);
}

// Globe point whose disc image is at a given position (inverse of the
// above; same curvature-drop caveat).
export function flatEarthUnwarpPoint(f, target = new Vector3()) {
    if (flatEarthUniforms.uFlatOn.value <= 0) return target.copy(f);
    return fullUnwarp(f, target);
}

// ── Tile culling spheres ────────────────────────────────────────────

// Installed on Globals.flatEarthWarpSphere while enabled; the quadtree's
// calculateTileVisibility runs its frustum tests and screen-space error
// against the warped sphere, which is what makes the map subdivide out to
// the screen edges / the disc rim instead of stopping at the globe horizon.
//
// The AEP stretches circles around its center by σ(Δ) = Δ/sin Δ (1 at the
// center, 1.57 a quarter-sphere out, → ∞ at the antipode; for the polar
// case this is the familiar (π/2−lat)/cos lat), so the radius is inflated
// by the stretch at the sphere's edge FARTHEST from the projection center,
// capped where the antipode singularity would take it to infinity — a fat
// sphere merely passes the frustum test, which is the conservative
// direction.
//
// Returns true when the warp is LOCALLY RIGID for this sphere — the centre
// barely moved relative to the tile's own size and the stretch is modest.
// That is the near field around the disc's tangent point, where the
// globe-space OBB narrow phase and OBB LOD distance are still valid; the
// quadtree keeps them there (tight LOD for the terrain underfoot) and only
// falls back to the fat warped sphere in the far field.
const _sphereP = new Vector3();

function flatEarthWarpSphere(sphere) {
    const u = flatEarthUniforms;
    const k = u.uFlatOn.value;
    if (k <= 0) return true;
    const c = sphere.center;
    const r0 = c.length();
    if (r0 < 1000) return true;
    const C = u.uFlatCDir.value;
    const cosD = Math.min(1, Math.max(-1, (c.x * C.x + c.y * C.y + c.z * C.z) / r0));
    const R0 = u.uFlatR0.value;
    const deltaFar = Math.min(Math.acos(cosD) + sphere.radius / R0, Math.PI - 0.002);
    const stretch = Math.min(deltaFar / Math.sin(deltaFar), 2000);
    flatEarthWarpPoint(_sphereP.copy(c), c);
    const moved = _sphereP.distanceTo(c);
    sphere.radius *= 1 + (stretch - 1) * k;
    return moved < sphere.radius && stretch < 1.5;
}

// ── Screen picking ──────────────────────────────────────────────────

// Flat-space replacement for raycastLocalGround, installed on
// Globals.flatEarthPickGround while enabled. The screen ray is straight in
// the WARPED space the user is looking at, so sphere-trace along it: at
// each sample, unwarp back to globe coordinates and measure clearance above
// the served elevation surface (sea level outside coverage). Returns the
// same {point, isTerrain} contract, with point in globe/physics coordinates
// — which is what every consumer (orbit anchor, V/B measure, C/X camera
// placement) wants, and the warp approaches identity as the camera closes
// in on the anchor.
const _pickF = new Vector3();
const _pickP = new Vector3();
const _pickD = new Vector3();
const _pickO = new Vector3();
const _pickDir = new Vector3();
const _pickQ = new Quaternion();
const MAX_PICK_RANGE = 6e7;     // past the disc rim from any sane camera
const MAX_PICK_STEPS = 6000;

function flatEarthPickGround(rayOrigin, rayDirection) {
    // The raycaster built this ray from the PHYSICAL camera pose, but the
    // screen shows the render-time WARPED pose (warpCameraPose above) — so
    // move the ray into the rendered space first: origin through the point
    // warp, direction through the same warp Jacobian the camera's
    // orientation got (falling back to the frame rotation if degenerate).
    const origin = flatEarthWarpPoint(rayOrigin, _pickO);
    if (!warpDirection(rayOrigin, rayDirection, _pickDir)) {
        flatEarthFrameQuat(rayOrigin, _pickQ);
        _pickDir.copy(rayDirection).applyQuaternion(_pickQ);
    }
    const direction = _pickDir;

    const terrainNode = NodeMan.exists("TerrainModel") ? NodeMan.get("TerrainModel") : null;
    const elevationMap = terrainNode ? terrainNode.elevationMap : null;
    const probe = {};
    const clearanceAt = (t) => {
        _pickF.copy(origin).addScaledVector(direction, t);
        // Beyond the AEP rim (ρ > R0·π) there is no map — the unwarp
        // would clamp to the projection center's antipode and fabricate a
        // surface there. Report open sky so rays past the rim miss.
        const u = flatEarthUniforms;
        _pickD.copy(_pickF).sub(u.uFlatCImage.value);
        const me = _pickD.dot(u.uFlatMapU.value);
        const mn = _pickD.dot(u.uFlatMapV.value);
        if (Math.hypot(me, mn) > u.uFlatR0.value * Math.PI) return 1e9;
        flatEarthUnwarpPoint(_pickF, _pickP);
        sampleGroundSurface(_pickP, elevationMap, probe);
        return probe.clearance;
    };
    let t = 0;
    let c = clearanceAt(0);
    if (c <= 0) return null;        // origin at/below the surface
    for (let i = 0; i < MAX_PICK_STEPS && t < MAX_PICK_RANGE; i++) {
        // Half-clearance steps never cross the surface while its slope
        // stays under ~45°; the 1 m floor guarantees progress and the cap
        // keeps the descent from orbital altitudes to a handful of steps.
        const step = Math.min(Math.max(c * 0.5, 1), 2e6);
        const tNext = t + step;
        const cNext = clearanceAt(tNext);
        if (cNext <= 0) {
            let lo = t, hi = tNext;
            for (let j = 0; j < 30; j++) {
                const mid = (lo + hi) / 2;
                if (clearanceAt(mid) > 0) lo = mid; else hi = mid;
            }
            clearanceAt(hi);
            return {point: _pickP.clone(), isTerrain: probe.tileKey !== "-1/-1/-1"};
        }
        t = tNext;
        c = cNext;
    }
    return null;
}

// ── GUI ─────────────────────────────────────────────────────────────

// Module state survives sitch switches; populate() rebuilds the controllers
// around it and re-arms the scene hook in case GlobalScene was recreated.
const flatEarth = {
    enabled: false,
    // 1 = perfectly flat (default); 0 = the true earth's curvature drop
    // re-created on the flat map (effective radius R/(1−f)).
    flatness: 1.0,
    centerOnLookCamera: false,
};

// Serialization. The scenario itself has no scene objects, but saves must
// carry the mode — so activation creates one tiny state node whose simple
// serials proxy the module state above. A save made with the mode ever
// enabled carries a "FlatEarth" entry; activeInMods (CScenarioManager) keys
// on flatEnabled===true so only saves actually USING the mode re-activate
// it, and modDeserialize applies the loaded state in one step.
class CNodeFlatEarth extends CNode {
    constructor(v) {
        super(v);
        this.addSimpleSerials(["flatEnabled", "flatness", "centerOnLookCamera"]);
    }

    get flatEnabled() { return flatEarth.enabled; }
    set flatEnabled(b) { flatEarth.enabled = !!b; }
    get flatness() { return flatEarth.flatness; }
    set flatness(x) { flatEarth.flatness = x; }
    get centerOnLookCamera() { return flatEarth.centerOnLookCamera; }
    set centerOnLookCamera(b) { flatEarth.centerOnLookCamera = !!b; }

    modDeserialize(v) {
        super.modDeserialize(v);
        applyFlatEarthState();
    }

    // A sitch switch disposes every node, including this one — and Flat
    // Earth must not leak into the next sitch. Turning the mode off here
    // makes sitch teardown the reset point: a save that was actually using
    // it re-activates through activeInMods → activate → modDeserialize,
    // and every other sitch (including saves carrying flatEnabled:false,
    // whose mods are dropped for the then-missing node) starts clean.
    dispose() {
        if (flatEarth.enabled) {
            flatEarth.enabled = false;
            applyFlatEarthState();
        }
        super.dispose();
    }
}

export function activateFlatEarth() {
    if (!NodeMan.exists("FlatEarth")) {
        new CNodeFlatEarth({id: "FlatEarth"});
    }
}

function applyFlatEarthState() {
    if (flatEarth.enabled) {
        // The state node is what makes a save carry the mode; nodes are
        // per-sitch, so re-create on first enable after any sitch load.
        activateFlatEarth();
        Globals.flatEarthRendering = true;
        Globals.flatEarthPickGround = flatEarthPickGround;
        Globals.flatEarthWarpSphere = flatEarthWarpSphere;
        Globals.flatEarthWarpPoint = flatEarthWarpPoint;
        // Pose pair for code that must see the RENDER camera outside a
        // render — the quadtree's tile selection tests warped spheres, so
        // its frustums/distances must come from the warped pose too.
        Globals.flatEarthWarpCamera = warpCameraPose;
        Globals.flatEarthRestoreCamera = restoreCameraPose;
        // Called by the tile material factories at CREATION: a tile that
        // activates on an LOD change must land on the disc on its first
        // frame — waiting for the 500 ms sweep left a hole where the new
        // tile still sat at its globe position while its parent was
        // already gone. Identical patched materials share a program via
        // the cache key, so this costs no per-tile shader compile.
        Globals.flatEarthPatchMaterial = installFlatEarthOnMaterial;
        if (!refreshFlatEarthOrigin()) {
            // No anchor point to build the projection from — hard-disable
            // (one-deep recursion into the else branch below) rather than
            // warping with stale or default uniforms. Previously the gate
            // was switched back on right after the refresh's warning.
            flatEarth.enabled = false;
            applyFlatEarthState();
            return;
        }
        installFlatEarthSceneHook(GlobalScene);
        flatEarthUniforms.uFlatOn.value = 1.0;
        // The slider means what it says: 1 = perfectly FLAT. The shader's
        // uFlatCurve is the curvature amount, so it gets the complement:
        // effective radius r = R/(1−f), infinite (division skipped) at f=1.
        flatEarthUniforms.uFlatCurve.value = 1 - flatEarth.flatness;
        _lastSweepMs = -1e9;    // sweep on the next render
    } else {
        Globals.flatEarthRendering = false;
        Globals.flatEarthPickGround = null;
        Globals.flatEarthWarpSphere = null;
        Globals.flatEarthWarpPoint = null;
        Globals.flatEarthWarpCamera = null;
        Globals.flatEarthRestoreCamera = null;
        Globals.flatEarthPatchMaterial = null;
        flatEarthUniforms.uFlatOn.value = 0.0;
        restoreSceneState();
    }
    // The grey polar caps z-fight massively once flattened; their visibility
    // logic reads Globals.flatEarthRendering.
    if (NodeMan.exists("TerrainModel")) {
        NodeMan.get("TerrainModel").updateGreySphereVisibility?.();
    }
    setRenderOne(true);
}

export function setupFlatEarth() {
    const folder = guiMenus.flatEarth;
    if (!folder) return;
    if (!(folder.controllers && folder.controllers.length > 0)) {
        folder.add(flatEarth, "enabled").listen()
            .name("Flat Earth Rendering")
            .onChange(applyFlatEarthState)
            .tooltip("EXPERIMENTAL. Render the world as a flat disc: a polar azimuthal equidistant projection (the classic flat earth map), tangent to the globe at the current origin. Display only — physics, tracks and measurements stay on the globe.");
        folder.add(flatEarth, "flatness", 0, 1, 0.01).listen()
            .name("Flatness")
            .onChange(applyFlatEarthState)
            .tooltip("How flat the earth is. 1 = perfectly flat. Below 1, everything sinks STRAIGHT DOWN by sqrt(r²+d²)−r at horizontal distance d from the view's camera, with effective radius r = R/(1−f) — at 0 that is the true earth's drop, locally reproducing the globe view. Per-view and vertical-only, so distant mountains drop in place instead of sliding sideways. Nothing draws beyond d ≥ r.");
        folder.add(flatEarth, "centerOnLookCamera").listen()
            .name("Center on Look Camera")
            .onChange(applyFlatEarthState)
            .tooltip("Recenter the azimuthal equidistant PROJECTION on the look camera instead of the north pole: distances and bearings become true from the camera (the observer-centred AE map), with zero distortion at the camera and the tear at its antipode. Re-centers continuously as the camera moves.");
    }
    if (flatEarth.enabled) applyFlatEarthState();
}
