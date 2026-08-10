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
// (Sit.lat/lon), so the local terrain stays approximately where it was and
// the rest of the planet unwraps around it. RENDER ONLY: physics, tracks,
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

import {Material, Vector3} from "three";
import {Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {sampleGroundSurface} from "../raycastGround";
import {GlobalScene} from "../LocalFrame";
import {radians} from "../utils";
import {RLLAToECEF_radii} from "../LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";

// Shared uniforms — every patched material references these same objects.
// uFlatOn doubles as the morph factor: 0 = globe (exact no-op), 1 = fully flat.
export const flatEarthUniforms = {
    uFlatOn: {value: 0.0},
    uFlatOrigin: {value: new Vector3()},   // disc tangent point, ECEF
    uFlatEast: {value: new Vector3(1, 0, 0)},
    uFlatNorth: {value: new Vector3(0, 1, 0)},
    uFlatUp: {value: new Vector3(0, 0, 1)},
    uFlatLon0: {value: 0.0},               // origin longitude, radians
    uFlatRho0: {value: 0.0},               // R0 * (PI/2 - geocentric lat0)
    uFlatR0: {value: 6371008.8},           // AEP scale radius
    uFlatA: {value: 6378137.0},            // active ellipsoid radii, for altitude
    uFlatB: {value: 6356752.3},
};

const CHUNK_MARKER = "SITREC_FLAT_EARTH_CHUNK";

export const FLAT_EARTH_VERTEX_GLSL = /* glsl */`
// ${CHUNK_MARKER}
uniform float uFlatOn;
uniform vec3 uFlatOrigin;
uniform vec3 uFlatEast;
uniform vec3 uFlatNorth;
uniform vec3 uFlatUp;
uniform float uFlatLon0;
uniform float uFlatRho0;
uniform float uFlatR0;
uniform float uFlatA;
uniform float uFlatB;

// World-space displacement that takes an ECEF point to its position on the
// AEP disc, scaled by the morph factor. Geocentric latitude and a geocentric
// ellipsoid surface radius stand in for their geodetic twins — consistent
// everywhere, so local relative geometry survives; only the absolute map is
// approximate.
vec3 flatEarthDelta(vec3 p) {
    if (uFlatOn <= 0.0) return vec3(0.0);
    float r = length(p);
    // Deep-interior geometry (debug arrows and helpers buried at the earth's
    // centre, invisible inside the globe but often depthTest:false) has no
    // meaningful place on the disc — cull the whole primitive by making the
    // vertex NaN. sqrt of a negative uniform defeats constant folding.
    if (r < 1000.0) return vec3(sqrt(-uFlatOn));
    float s = clamp(p.z / r, -1.0, 1.0);
    float latgc = asin(s);
    float c = sqrt(max(1.0 - s * s, 0.0));
    float lon = atan(p.y, p.x);
    // geocentric radius of the ellipsoid surface at this latitude
    float re = (uFlatA * uFlatB) / sqrt(uFlatB * uFlatB * c * c + uFlatA * uFlatA * s * s);
    float alt = r - re;
    if (alt < -1000000.0) return vec3(sqrt(-uFlatOn));
    float rho = uFlatR0 * (1.5707963267948966 - latgc);
    float dlon = lon - uFlatLon0;
    vec3 flatPos = uFlatOrigin
        + uFlatEast  * (rho * sin(dlon))
        + uFlatNorth * (uFlatRho0 - rho * cos(dlon))
        + uFlatUp    * alt;
    return (flatPos - p) * uFlatOn;
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

// Disc frame from the current sitch origin. Cheap; refreshed on the sweep
// cadence so a sitch/terrain switch re-tangents the disc automatically.
function refreshFlatEarthOrigin() {
    if (Sit.lat === undefined || Sit.lon === undefined) {
        flatEarthUniforms.uFlatOn.value = 0.0;
        console.warn("Flat Earth: Sit.lat/lon undefined, disabling");
        return;
    }
    const O = RLLAToECEF_radii(radians(Sit.lat), radians(Sit.lon), 0);
    const u = flatEarthUniforms;
    u.uFlatOrigin.value.copy(O);
    u.uFlatEast.value.copy(getLocalEastVector(O));
    u.uFlatNorth.value.copy(getLocalNorthVector(O));
    u.uFlatUp.value.copy(getLocalUpVector(O));
    u.uFlatA.value = Globals.equatorRadius;
    u.uFlatB.value = Globals.polarRadius;
    u.uFlatR0.value = (2 * Globals.equatorRadius + Globals.polarRadius) / 3;
    u.uFlatLon0.value = Math.atan2(O.y, O.x);
    const lat0gc = Math.asin(O.z / O.length());
    u.uFlatRho0.value = u.uFlatR0.value * (Math.PI / 2 - lat0gc);
}

const SWEEP_INTERVAL_MS = 500;
let _lastSweepMs = -1e9;
let _sceneHookInstalled = null;

function installFlatEarthSceneHook(scene) {
    if (!scene || _sceneHookInstalled === scene) return;
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sceneArg, camera, renderTarget) {
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
    _sceneHookInstalled = scene;
}

// ── CPU twins of the shader warp ────────────────────────────────────

// Full (flatness=1) warp, the JS mirror of flatEarthDelta's flatPos.
function fullWarp(p, target) {
    const u = flatEarthUniforms;
    const r = p.length();
    if (r < 1000) return target.copy(p);
    const s = Math.min(1, Math.max(-1, p.z / r));
    const latgc = Math.asin(s);
    const c = Math.sqrt(Math.max(1 - s * s, 0));
    const lon = Math.atan2(p.y, p.x);
    const a = u.uFlatA.value, b = u.uFlatB.value;
    const re = (a * b) / Math.sqrt(b * b * c * c + a * a * s * s);
    const alt = r - re;
    const rho = u.uFlatR0.value * (Math.PI / 2 - latgc);
    const dlon = lon - u.uFlatLon0.value;
    const me = rho * Math.sin(dlon);
    const mn = u.uFlatRho0.value - rho * Math.cos(dlon);
    const O = u.uFlatOrigin.value, E = u.uFlatEast.value, N = u.uFlatNorth.value, UP = u.uFlatUp.value;
    return target.set(
        O.x + E.x * me + N.x * mn + UP.x * alt,
        O.y + E.y * me + N.y * mn + UP.y * alt,
        O.z + E.z * me + N.z * mn + UP.z * alt,
    );
}

// Exact analytic inverse of the full warp: disc-plane coordinates back
// through the AEP to geocentric lat/lon, then out to ECEF.
function fullUnwarp(f, target) {
    const u = flatEarthUniforms;
    const O = u.uFlatOrigin.value, E = u.uFlatEast.value, N = u.uFlatNorth.value, UP = u.uFlatUp.value;
    const dx = f.x - O.x, dy = f.y - O.y, dz = f.z - O.z;
    const me = dx * E.x + dy * E.y + dz * E.z;
    const mn = dx * N.x + dy * N.y + dz * N.z;
    const alt = dx * UP.x + dy * UP.y + dz * UP.z;
    const R0 = u.uFlatR0.value;
    const gz = u.uFlatRho0.value - mn;          // rho * cos(dlon)
    const rho = Math.min(Math.hypot(me, gz), R0 * Math.PI);
    const dlon = Math.atan2(me, gz);
    const latgc = Math.PI / 2 - rho / R0;
    const lon = u.uFlatLon0.value + dlon;
    const s = Math.sin(latgc), c = Math.cos(latgc);
    const a = u.uFlatA.value, b = u.uFlatB.value;
    const re = (a * b) / Math.sqrt(b * b * c * c + a * a * s * s);
    const r = re + alt;
    return target.set(r * c * Math.cos(lon), r * c * Math.sin(lon), r * s);
}

const _unwarpW = new Vector3();

// Rendered position of a globe point (honors the flatness morph).
export function flatEarthWarpPoint(p, target = new Vector3()) {
    const k = flatEarthUniforms.uFlatOn.value;
    fullWarp(p, target);
    if (k < 1) target.multiplyScalar(k).addScaledVector(p, 1 - k);
    return target;
}

// Globe point that renders at a given position. Exact at flatness 1; for a
// partial morph the blend has no closed inverse, so refine by fixed point:
// p ← f − k·(fullWarp(p) − p), seeded with the full-warp inverse.
export function flatEarthUnwarpPoint(f, target = new Vector3()) {
    const k = flatEarthUniforms.uFlatOn.value;
    fullUnwarp(f, target);
    if (k >= 1) return target;
    if (k <= 0) return target.copy(f);
    for (let i = 0; i < 8; i++) {
        fullWarp(target, _unwarpW);
        target.set(
            f.x - k * (_unwarpW.x - target.x),
            f.y - k * (_unwarpW.y - target.y),
            f.z - k * (_unwarpW.z - target.z),
        );
    }
    return target;
}

// ── Tile culling spheres ────────────────────────────────────────────

// Installed on Globals.flatEarthWarpSphere while enabled; the quadtree's
// calculateTileVisibility runs its frustum tests and screen-space error
// against the warped sphere, which is what makes the map subdivide out to
// the screen edges / the disc rim instead of stopping at the globe horizon.
//
// The AEP stretches parallels by σ(φ) = (π/2−φ)/cos φ (1 at the north pole,
// 1.57 at the equator, → ∞ at the south pole), so the radius is inflated by
// the stretch at the sphere's most southern latitude, capped where the rim
// singularity would take it to infinity — a fat sphere merely passes the
// frustum test, which is the conservative direction.
//
// Returns true when the warp is LOCALLY RIGID for this sphere — the centre
// barely moved relative to the tile's own size and the stretch is modest.
// That is the near field around the disc's tangent point, where the
// globe-space OBB narrow phase and OBB LOD distance are still valid; the
// quadtree keeps them there (tight LOD for the terrain underfoot) and only
// falls back to the fat warped sphere in the far field.
const _sphereP = new Vector3();

function flatEarthWarpSphere(sphere) {
    const k = flatEarthUniforms.uFlatOn.value;
    if (k <= 0) return true;
    const c = sphere.center;
    const r0 = c.length();
    if (r0 < 1000) return true;
    const latC = Math.asin(Math.min(1, Math.max(-1, c.z / r0)));
    const R0 = flatEarthUniforms.uFlatR0.value;
    const latSouth = Math.max(latC - sphere.radius / R0, -Math.PI / 2 + 0.002);
    const stretch = Math.min((Math.PI / 2 - latSouth) / Math.cos(latSouth), 2000);
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
const MAX_PICK_RANGE = 6e7;     // past the disc rim from any sane camera
const MAX_PICK_STEPS = 6000;

function flatEarthPickGround(origin, direction) {
    const terrainNode = NodeMan.exists("TerrainModel") ? NodeMan.get("TerrainModel") : null;
    const elevationMap = terrainNode ? terrainNode.elevationMap : null;
    const probe = {};
    const clearanceAt = (t) => {
        _pickF.copy(origin).addScaledVector(direction, t);
        // Beyond the AEP rim (rho > R0·π) there is no map — the unwarp
        // would clamp to the south pole and fabricate a surface there.
        // Report open sky so rays past the rendered Antarctica edge miss.
        const u = flatEarthUniforms;
        _pickD.copy(_pickF).sub(u.uFlatOrigin.value);
        const me = _pickD.dot(u.uFlatEast.value);
        const gz = u.uFlatRho0.value - _pickD.dot(u.uFlatNorth.value);
        if (Math.hypot(me, gz) > u.uFlatR0.value * Math.PI) return 1e9;
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
    flatness: 1.0,
};

function applyFlatEarthState() {
    if (flatEarth.enabled) {
        Globals.flatEarthRendering = true;
        Globals.flatEarthPickGround = flatEarthPickGround;
        Globals.flatEarthWarpSphere = flatEarthWarpSphere;
        refreshFlatEarthOrigin();
        installFlatEarthSceneHook(GlobalScene);
        flatEarthUniforms.uFlatOn.value = flatEarth.flatness;
        _lastSweepMs = -1e9;    // sweep on the next render
    } else {
        Globals.flatEarthRendering = false;
        Globals.flatEarthPickGround = null;
        Globals.flatEarthWarpSphere = null;
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
        folder.add(flatEarth, "enabled")
            .name("Flat Earth Rendering")
            .onChange(applyFlatEarthState)
            .tooltip("EXPERIMENTAL. Render the world as a flat disc: a polar azimuthal equidistant projection (the classic flat earth map), tangent to the globe at the current origin. Display only — physics, tracks and measurements stay on the globe.");
        folder.add(flatEarth, "flatness", 0, 1, 0.01)
            .name("Flatness")
            .onChange(applyFlatEarthState)
            .tooltip("Morph between the globe (0) and the fully flat disc (1). Watching geometry unfold is the quickest way to see what does and does not get warped.");
    }
    if (flatEarth.enabled) applyFlatEarthState();
}
