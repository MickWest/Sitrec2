// FisheyeProjection.js — fisheye (allsky) rendering for the look view.
//
// Camera → FOV (Zoom) → Fisheye. Built to recreate allsky/meteor cameras: a
// ~180° fisheye pointing at the zenith, its circular image cropped by a 16:9
// frame (e.g. the Thomas Jacquin "Allsky" software watermark cameras). A
// pinhole projection cannot even REPRESENT a 180° field — tan(90°) diverges —
// so this is not a post-process warp of the normal render. Instead the
// projection itself is replaced in every vertex shader: view-space direction →
// field angle theta → image radius through a LENS CURVE → NDC. The curves are
// the GLSL twins of CameraLens.js LENS_PRESETS (equidistant, equisolid,
// stereographic, orthographic, rectilinear), so Star Track analysis and the
// renderer share one lens vocabulary.
//
// Mechanism is a copy of FlatEarthScenario.js's material patching (itself a
// copy of terrestrialRefraction.js): a chained onBeforeCompile injects the
// projection into every material a periodic sweep finds, gated by the shared
// uniform uFishOn. The gate is set PER RENDER in scene.onBeforeRender: 1 only
// when the rendering camera is the look camera, so the main view, shadow
// passes, CubeCamera faces and XR all keep their pinhole. Disabled is a
// bit-identical no-op.
//
// Composition with the other gl_Position rewriters:
//  - Terrestrial refraction: composed. The patcher anchors AFTER refraction's
//    appended line when present and projects the refraction-BENT view position.
//  - Flat Earth: upstream family patches compose (they move mvPosition before
//    this projects it); on the stock <project_vertex> family both-on resolves
//    in Flat Earth's favor. Fisheye + Flat Earth together is not a supported
//    combination — each alone is unaffected by the other's presence.
//
// Depth: the renderer runs logarithmicDepthBuffer, whose chunks derive depth
// from gl_Position.w AFTER our overwrite — fisheyeClip sets w to the view-space
// DISTANCE, so log depth stays monotonic and consistent across materials. The
// classic clip z is also emitted (same near/far mapping as a pinhole) for
// hardware clipping.
//
// Known gaps (deliberate): primitives are still projected per-VERTEX, so a
// line segment spanning tens of degrees (constellation stick figures) draws as
// a chord rather than the curve a real fisheye would bend it into — star
// POSITIONS are exact, which is what matching a real image needs. CPU code
// that projects through camera.projectionMatrix (mouse picking, some HUD
// overlays) is not fisheye-aware except where routed through
// fisheyeProjectVector below (the night-sky label overlay is). Terrain tile
// LOD selection still tests the pinhole frustum.

import {Material, ShaderMaterial, Vector2, Vector3} from "three";
import {Globals, guiMenus, NodeMan, setRenderOne} from "./Globals";
import {CNode} from "./nodes/CNode";
import {GlobalScene, GlobalNightSkyScene, GlobalDaySkyScene, GlobalSunSkyScene} from "./LocalFrame";
import {LENS_PRESETS} from "./CameraLens";
import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";

// ── Shared uniforms ─────────────────────────────────────────────────
// Every patched material references these same objects, so one update per
// render call propagates everywhere. uFishOn is the binary per-render gate.
export const fisheyeUniforms = {
    uFishOn: {value: 0.0},                    // 1 only while the LOOK camera renders
    uFishType: {value: 3.0},                  // FISHEYE_TYPE_INDEX of the lens curve
    uFishRhoEdge: {value: Math.SQRT2},        // rho(fov/2): normalised radius of the circle edge
    uFishScaleY: {value: 1.0},                // circle radius in NDC half-heights (1 = inscribed)
    uFishAspect: {value: 16 / 9},             // render aspect, converts NDC-y radius to NDC-x
    uFishCenter: {value: new Vector2(0, 0)},  // circle centre offset, NDC
    uFishRoll: {value: 0.0},                  // image-plane rotation, radians
    uFishMaxTheta: {value: Math.PI},          // lens curve validity limit (clamped, not culled)
    uFishCullTheta: {value: Math.PI},         // beyond this, the whole primitive is culled
    uFishNear: {value: 1.0},                  // pinhole-compatible depth mapping
    uFishFar: {value: 1e9},
};

// GLSL branch indices for the lens curves. Names must exist in LENS_PRESETS;
// the GLSL in FISHEYE_VERTEX_GLSL must stay in agreement (tests/fisheye.test.js).
export const FISHEYE_TYPE_INDEX = {
    rectilinear: 0,
    stereographic: 1,
    equidistantFisheye: 2,
    equisolidFisheye: 3,
    orthographicFisheye: 4,
};

// Largest usable full FOV per curve, degrees. Rectilinear/stereographic have
// finite images only short of their poles (tan/2tan(θ/2) diverge); orthographic
// folds back past 90°; the equal-angle/equal-area curves genuinely reach 360.
const FISHEYE_FOV_CAP = {
    rectilinear: 160,
    stereographic: 340,
    equidistantFisheye: 360,
    equisolidFisheye: 360,
    orthographicFisheye: 180,
};

const CHUNK_MARKER = "SITREC_FISHEYE_CHUNK";

export const FISHEYE_VERTEX_GLSL = /* glsl */`
// ${CHUNK_MARKER}
uniform float uFishOn;
uniform float uFishType;
uniform float uFishRhoEdge;
uniform float uFishScaleY;
uniform float uFishAspect;
uniform vec2 uFishCenter;
uniform float uFishRoll;
uniform float uFishMaxTheta;
uniform float uFishCullTheta;
uniform float uFishNear;
uniform float uFishFar;

// rho(theta) — the forward radial curves, GLSL twins of CameraLens.js
// LENS_PRESETS (indices from FISHEYE_TYPE_INDEX).
float fisheyeRho(float theta) {
    if (uFishType < 0.5) return tan(theta);                 // rectilinear
    if (uFishType < 1.5) return 2.0 * tan(theta * 0.5);     // stereographic
    if (uFishType < 2.5) return theta;                      // equidistant
    if (uFishType < 3.5) return 2.0 * sin(theta * 0.5);     // equisolid
    return sin(theta);                                      // orthographic
}

// View-space position -> fisheye clip position. theta is the angle off the
// view axis (-z); the lens curve turns it into an image radius, laid out
// around the circle centre in NDC. w is the view DISTANCE, so both hardware
// clipping and the log-depth chunks (which read gl_Position.w downstream)
// stay monotonic in distance, matching a pinhole at the same near/far.
vec4 fisheyeClip(vec4 mvPosition) {
    vec3 v = mvPosition.xyz;
    float d = length(v);
    if (d < 1e-9) return vec4(0.0, 0.0, -1.0, 1.0);
    float theta = acos(clamp(-v.z / d, -1.0, 1.0));
    // Far outside the field the projection has nowhere sensible to put a
    // vertex — as theta nears 180° azimuths flip, and a coarse primitive
    // spanning that region (the ground tile directly under an up-pointing
    // camera) smears chords across the whole disc. Cull the primitive by
    // making the vertex NaN (sqrt of a negative uniform defeats constant
    // folding — same trick as Flat Earth's antipode cap).
    if (theta > uFishCullTheta) return vec4(sqrt(-uFishOn));
    // Within the margin between the FOV edge and the cull cap, clamp (not
    // cull) past the curve's validity: vertices pin to the rim circle, so
    // primitives crossing it stretch outward instead of leaving holes.
    theta = min(theta, uFishMaxTheta);
    float rho = fisheyeRho(theta);
    vec2 dir = vec2(0.0);
    float l = length(v.xy);
    if (l > 1e-9) dir = v.xy / l;
    float cr = cos(uFishRoll);
    float sr = sin(uFishRoll);
    dir = vec2(cr * dir.x - sr * dir.y, sr * dir.x + cr * dir.y);
    float rNdcY = (rho / uFishRhoEdge) * uFishScaleY;
    vec2 ndc = uFishCenter + vec2(rNdcY * dir.x / uFishAspect, rNdcY * dir.y);
    float zClip = ((uFishFar + uFishNear) * d - 2.0 * uFishFar * uFishNear)
        / (uFishFar - uFishNear);
    return vec4(ndc * d, zClip, d);
}
`;

function injectFisheyeChunk(vertexShader) {
    if (vertexShader.includes(CHUNK_MARKER)) return vertexShader;
    return vertexShader.replace("void main() {",
        FISHEYE_VERTEX_GLSL + "\nvoid main() {");
}

export function addFisheyeUniforms(shader) {
    for (const k of Object.keys(fisheyeUniforms)) {
        shader.uniforms[k] = fisheyeUniforms[k];
    }
}

// ── Vertex shader patching ──────────────────────────────────────────
// Same shader families as the refraction/Flat Earth patchers, with anchors
// chosen so the projection lands AFTER any upstream warp of the positions.

// Terrestrial refraction's appended overwrite (terrestrialRefraction.js). When
// present we anchor after it AND project the refraction-bent view position, so
// both effects compose in a single gl_Position.
const REFRACTION_APPEND = "gl_Position = applyTerrestrialRefraction_clip(mvPosition);";
const SPRITE_ANCHOR = "vec4 mvPosition = modelViewMatrix[ 3 ];";
const SPRITE_CLIP = "gl_Position = projectionMatrix * mvPosition;";
const FATLINE_CLIP_START = "vec4 clipStart = projectionMatrix * start;";
const FATLINE_CLIP_END = "vec4 clipEnd = projectionMatrix * end;";
const TERRAIN_CLIP = "vPosition = projectionMatrix * mvPosition;";
const GLOBE_CLIP = "vPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);";
const GLOBE_CLIP_FLAT = "vPosition = projectionMatrix * feMV;";   // Flat Earth's rewrite of the globe
const WORLDPOS_CLIP = "gl_Position = projectionMatrix * viewMatrix * worldPos;";   // CPlanets Sun/Moon

// Returns {vertexShader, matched}, same contract as the other patchers.
export function patchFisheyeVertexShader(vertexShader) {
    if (vertexShader.includes(CHUNK_MARKER)) {
        return {vertexShader, matched: true};
    }

    let out = vertexShader;
    let matched = false;

    // (a) stock <project_vertex>: meshes, 3D tiles, LineBasic, points, ocean.
    if (out.includes("#include <project_vertex>")) {
        const hasRefraction = out.includes(REFRACTION_APPEND);
        const overwrite = hasRefraction
            ? "\n\tif (uFishOn > 0.0) { gl_Position = fisheyeClip(vec4(applyTerrestrialRefraction_chunk(mvPosition.xyz), 1.0)); }"
            : "\n\tif (uFishOn > 0.0) { gl_Position = fisheyeClip(mvPosition); }";
        out = hasRefraction
            ? out.replace(REFRACTION_APPEND, REFRACTION_APPEND + overwrite)
            : out.replace("#include <project_vertex>", "#include <project_vertex>" + overwrite);
        matched = true;
    }

    // (b) sprites (planets, markers): billboard offsets are applied to
    // mvPosition in view space before the clip, so projecting the final
    // mvPosition fisheye-warps each corner — position exact, size approximate.
    if (!matched && out.includes(SPRITE_ANCHOR) && out.includes(SPRITE_CLIP)) {
        out = out.replace(SPRITE_CLIP,
            SPRITE_CLIP + "\n\tif (uFishOn > 0.0) { gl_Position = fisheyeClip(mvPosition); }");
        matched = true;
    }

    // (c) fat lines (Line2/LineSegments2) — tracks, LOS, measurement lines:
    // replace the two endpoint projections; the quad extrusion downstream then
    // works in fisheye NDC. Refraction/Flat Earth bend start/end BEFORE these
    // lines, so all three compose.
    if (!matched && out.includes(FATLINE_CLIP_START)) {
        out = out.replace(FATLINE_CLIP_START,
            "vec4 clipStart = ( uFishOn > 0.0 ) ? fisheyeClip( start ) : ( projectionMatrix * start );");
        out = out.replace(FATLINE_CLIP_END,
            "vec4 clipEnd = ( uFishOn > 0.0 ) ? fisheyeClip( end ) : ( projectionMatrix * end );");
        matched = true;
    }

    // (d) terrain tiles (TerrainDayNightMaterial). Keep the original line
    // intact — Flat Earth anchors on it — and overwrite after it.
    if (!matched && out.includes(TERRAIN_CLIP) && out.includes("vWorldPosition")) {
        out = out.replace(TERRAIN_CLIP,
            TERRAIN_CLIP + "\n\tif (uFishOn > 0.0) { vPosition = fisheyeClip(mvPosition); }");
        matched = true;
    }

    // (e) the globe sphere — in either its stock form or the form Flat Earth's
    // patch leaves behind (feMV holds the possibly-warped view position).
    if (!matched && out.includes(GLOBE_CLIP)) {
        out = out.replace(GLOBE_CLIP,
            GLOBE_CLIP + "\n\tif (uFishOn > 0.0) { vPosition = fisheyeClip(modelViewMatrix * vec4(position, 1.0)); }");
        matched = true;
    }
    if (!matched && out.includes(GLOBE_CLIP_FLAT)) {
        out = out.replace(GLOBE_CLIP_FLAT,
            GLOBE_CLIP_FLAT + "\n\tif (uFishOn > 0.0) { vPosition = fisheyeClip(feMV); }");
        matched = true;
    }

    // (f) hand-written ShaderMaterials that opted into terrestrial refraction
    // (ground grid, sprite groups, gradient objects, ...): their idiom is
    // `gl_Position = applyTerrestrialRefraction_clip(<view-space expr>);`.
    // Project the refraction-BENT position through the fisheye, keeping the
    // original line so the pinhole path is untouched when the gate is off.
    if (!matched) {
        const clipCall = /gl_Position\s*=\s*applyTerrestrialRefraction_clip\((.+)\);/g;
        if (clipCall.test(out)) {
            out = out.replace(clipCall, (line, expr) =>
                line + "\n\tif (uFishOn > 0.0) { gl_Position = "
                    + `fisheyeClip(vec4(applyTerrestrialRefraction_chunk((${expr}).xyz), 1.0)); }`);
            matched = true;
        }
    }

    // (g) shaders that project a WORLD-space position directly (the Sun/Moon
    // discs in CPlanets): viewMatrix * worldPos is the view-space position.
    if (!matched && out.includes(WORLDPOS_CLIP)) {
        out = out.replace(WORLDPOS_CLIP,
            WORLDPOS_CLIP + "\n\tif (uFishOn > 0.0) { gl_Position = fisheyeClip(viewMatrix * worldPos); }");
        matched = true;
    }

    if (!matched) return {vertexShader, matched: false};
    return {vertexShader: injectFisheyeChunk(out), matched: true};
}

// Install on a material. Idempotent, chains any existing onBeforeCompile
// (refraction, Flat Earth, linear-output) and keeps program cache keys
// distinct. Same WeakSet/cache-key reasoning as the refraction installer.
const _installed = new WeakSet();
const _warnedUnmatched = new WeakSet();
const FISHEYE_PROGRAM_KEY = "sitrecFisheye.v1";
const _defaultCacheKey = Material.prototype.customProgramCacheKey;

export function installFisheyeOnMaterial(material) {
    if (!material || _installed.has(material)) return;

    const prev = material.onBeforeCompile;
    const ownsCacheKey = material.customProgramCacheKey !== _defaultCacheKey;
    const prevCacheKeyFn = ownsCacheKey ? material.customProgramCacheKey : null;
    const frozenDefaultKey = ownsCacheKey ? null : String(prev ?? "");

    material.onBeforeCompile = function (shader, renderer) {
        if (typeof prev === "function") prev.call(this, shader, renderer);
        addFisheyeUniforms(shader);
        const result = patchFisheyeVertexShader(shader.vertexShader);
        if (result.matched) {
            shader.vertexShader = result.vertexShader;
        } else if (!_warnedUnmatched.has(this)) {
            _warnedUnmatched.add(this);
            console.warn("Fisheye: no supported clip-position pattern in "
                + `${this.type}${this.name ? " '" + this.name + "'" : ""} — `
                + "it will render with the pinhole projection.");
        }
    };

    material.customProgramCacheKey = function () {
        const base = prevCacheKeyFn ? prevCacheKeyFn.call(this) : frozenDefaultKey;
        return `${base}.${FISHEYE_PROGRAM_KEY}`;
    };

    _installed.add(material);
    material.needsUpdate = true;
}

const _asMaterials = m => (Array.isArray(m) ? m : [m]);

// Frustum culling tests bounds against the camera's PINHOLE matrix, which at a
// 180°+ field wrongly rejects everything beside/behind the camera — so culling
// is switched off on every swept renderable (only ones that had it on) and
// restored by a walk of the hooked scenes on disable. Same tradeoff and
// reasoning as Flat Earth's sweep.
function sweepFisheye(root) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
        const o = stack.pop();
        if (o.material) {
            for (const m of _asMaterials(o.material)) {
                if (m && !_installed.has(m)) installFisheyeOnMaterial(m);
            }
            if (o.frustumCulled) {
                o._fisheyeCulledOff = true;
                o.frustumCulled = false;
            }
        }
        const children = o.children;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
}

function restoreSceneState() {
    for (const scene of fisheyeScenes()) {
        const stack = [scene];
        while (stack.length) {
            const o = stack.pop();
            if (o._fisheyeCulledOff) {
                o.frustumCulled = true;
                o._fisheyeCulledOff = false;
            }
            const children = o.children;
            for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
    }
}

// ── Module state ────────────────────────────────────────────────────
// Survives sitch switches like Flat Earth's; the CNodeFisheye state node
// proxies it for serialization and force-disables it on sitch teardown.
export const fisheye = {
    enabled: false,
    lensType: "equisolidFisheye",   // typical cheap CS/M12 allsky lens behaviour
    fov: 180,                       // full angle across the image circle's diameter, degrees
    circlePct: 100,                 // circle DIAMETER as % of view height (155 ≈ the STLS crop)
    centerX: 0,                     // circle centre offset, % of view height
    centerY: 0,
    roll: 0,                        // image rotation, degrees
    showCircle: true,               // mask outside the image circle to black
};

function activePreset() {
    return LENS_PRESETS[fisheye.lensType] ?? LENS_PRESETS.equisolidFisheye;
}

function fovCap() {
    return FISHEYE_FOV_CAP[fisheye.lensType] ?? 180;
}

const FISHEYE_FOV_MIN = 10;   // the GUI slider's floor; also the wheel-zoom floor

// The requested FOV held to the range the current projection can image
// (same limits as the Fisheye FOV slider).
export function clampFisheyeFov(fov) {
    return Math.min(Math.max(fov, FISHEYE_FOV_MIN), fovCap());
}

// Set the fisheye FOV from a gesture (the look view's scroll wheel, pinch,
// keyboard zoom) — while the fisheye is on, those zoom the FISHEYE field,
// not the pinhole camera's fov, which the render ignores. Clamped like the
// slider; the slider itself follows via .listen().
export function setFisheyeFov(fov) {
    fisheye.fov = clampFisheyeFov(fov);
    applyFisheyeState();
}

// Derived projection constants for the current settings. Small enough to
// recompute on every gated render (a handful of trig calls).
function refreshFisheyeParams() {
    const u = fisheyeUniforms;
    const preset = activePreset();
    fisheye.fov = Math.min(fisheye.fov, fovCap());
    const halfFovRad = fisheye.fov * Math.PI / 360;
    u.uFishType.value = FISHEYE_TYPE_INDEX[fisheye.lensType] ?? 3;
    u.uFishRhoEdge.value = preset.rho(halfFovRad);
    u.uFishScaleY.value = fisheye.circlePct / 100;
    u.uFishRoll.value = fisheye.roll * Math.PI / 180;
    u.uFishMaxTheta.value = preset.maxTheta ?? Math.PI;
    // Cull well past the FOV edge (margin keeps rim-crossing primitives
    // alive to be clamped/masked), and normally short of the antipode —
    // whose image is the entire rim circle, so coarse primitives near it
    // smear chords across the disc. The antipode guard must never eat into
    // the REQUESTED field though: at a near-full-sphere FOV (>356°) it
    // steps aside so the whole selected field renders — stars and other
    // fine geometry image correctly right up to the antipode, and any
    // smear from coarse primitives there is the projection's honest
    // behaviour, not a silent crop of the saved FOV.
    const deg = Math.PI / 180;
    u.uFishCullTheta.value = Math.min(halfFovRad + 25 * deg,
        Math.max(178 * deg, halfFovRad + 0.5 * deg));
}

// Is this render's camera the one the fisheye applies to (the look camera)?
// CPU-side projections often work on a CLONE of the live camera (the sky
// overlay's displayedCamera), which would fail a bare identity test — clone
// sites tag the copy with `_fisheyeProxyFor` pointing at the live camera,
// and the gate unwraps it.
export function isFisheyeCamera(camera) {
    if (!fisheye.enabled || !camera) return false;
    const camNode = NodeMan.get("lookCamera", false);
    if (!camNode) return false;
    const live = camera._fisheyeProxyFor ?? camera;
    return camNode.camera === live;
}

// Per-render uniform update, called from the scene hooks. Aspect and depth
// range come from the camera AS RENDERED (Match Video Aspect adjusts
// camera.aspect before the render reaches here).
function updateFisheyeUniformsForRender(camera) {
    const u = fisheyeUniforms;
    if (!isFisheyeCamera(camera)) {
        u.uFishOn.value = 0.0;
        return;
    }
    refreshFisheyeParams();
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    u.uFishOn.value = 1.0;
    u.uFishAspect.value = aspect;
    u.uFishCenter.value.set(
        (fisheye.centerX / 100) * 2 / aspect,
        (fisheye.centerY / 100) * 2,
    );
    u.uFishNear.value = camera.near;
    u.uFishFar.value = camera.far;
}

// ── Scene hooks ─────────────────────────────────────────────────────
// Installed on the world scene AND the celestial scenes: the look view renders
// the night sky, sun sky and day sky with the same camera (CNodeView3D
// renderSky), and the stars are precisely what an allsky match needs warped.
const SWEEP_INTERVAL_MS = 500;

// The scenes the fisheye hooks/sweeps: the world plus the celestial scenes
// (renderSky draws them with the same camera). Read live — these module
// bindings are reassigned on a sitch rebuild, and keeping our own collection
// of hooked scenes would pin the dead ones (and their chained callbacks) in
// memory for the rest of the session.
function fisheyeScenes() {
    return [GlobalScene, GlobalNightSkyScene, GlobalDaySkyScene, GlobalSunSkyScene]
        .filter(Boolean);
}

function installFisheyeSceneHook(scene) {
    if (!scene || scene._fisheyeHooked) return;
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sceneArg, camera, renderTarget) {
        if (typeof previous === "function") {
            previous.call(this, renderer, sceneArg, camera, renderTarget);
        }
        updateFisheyeUniformsForRender(camera);
        if (!fisheye.enabled) return;
        const now = performance.now();
        if (now - (this._fishLastSweepMs ?? -1e9) < SWEEP_INTERVAL_MS) return;
        this._fishLastSweepMs = now;
        sweepFisheye(this);
    };
    scene._fisheyeHooked = true;
}

// Hook every live scene; `forceSweep` also schedules a full sweep on the next
// render (needed when the mode turns ON — materials created while it was off
// are unpatched). A newly hooked scene sweeps on its first render regardless.
function installAllSceneHooks(forceSweep) {
    for (const scene of fisheyeScenes()) {
        installFisheyeSceneHook(scene);
        if (forceSweep) scene._fishLastSweepMs = -1e9;
    }
}

// ── CPU twin ────────────────────────────────────────────────────────

// Mirror of fisheyeClip for a VIEW-SPACE Vector3: mutates `v` into NDC using
// the current fisheye state (no camera gating — the gated world-space wrapper
// below is what rendering code uses; this form is directly unit-testable).
export function fisheyeProjectView(v, aspect = 1, near = 1, far = 1e9) {
    refreshFisheyeParams();
    const d = v.length();
    if (d < 1e-9) {
        return v.set(0, 0, 2);   // degenerate: park it outside the -1..1 z window
    }
    const u = fisheyeUniforms;
    let theta = Math.acos(Math.min(1, Math.max(-1, -v.z / d)));
    if (theta > u.uFishCullTheta.value) {
        return v.set(0, 0, 2);   // culled in the render; park labels off-screen too
    }
    theta = Math.min(theta, u.uFishMaxTheta.value);
    const rho = activePreset().rho(theta);
    const l = Math.hypot(v.x, v.y);
    let dx = 0, dy = 0;
    if (l > 1e-9) {
        dx = v.x / l;
        dy = v.y / l;
    }
    const roll = fisheye.roll * Math.PI / 180;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const rx = cr * dx - sr * dy;
    const ry = sr * dx + cr * dy;
    const rNdcY = (rho / u.uFishRhoEdge.value) * (fisheye.circlePct / 100);
    return v.set(
        (fisheye.centerX / 100) * 2 / aspect + rNdcY * rx / aspect,
        (fisheye.centerY / 100) * 2 + rNdcY * ry,
        ((far + near) * d - 2 * far * near) / ((far - near) * d),
    );
}

// Mirror of fisheyeClip for CPU-side projections (night-sky label overlay).
// Mutates `v` (a WORLD-space Vector3) into NDC exactly like Vector3.project
// would, and returns true — or returns false untouched when the fisheye does
// not apply to this camera, so callers fall through to the pinhole path.
const _fpV = new Vector3();

export function fisheyeProjectVector(v, camera) {
    if (!isFisheyeCamera(camera)) return false;
    _fpV.copy(v).applyMatrix4(camera.matrixWorldInverse);
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    fisheyeProjectView(_fpV, aspect, camera.near, camera.far);
    // Outside the image circle the render is masked to black — park the
    // point outside the -1..1 z window so labels don't draw over the mask.
    if (fisheye.showCircle) {
        const rx = (_fpV.x - (fisheye.centerX / 100) * 2 / aspect) * aspect;
        const ry = _fpV.y - (fisheye.centerY / 100) * 2;
        if (Math.hypot(rx, ry) > fisheye.circlePct / 100) _fpV.z = 2;
    }
    v.copy(_fpV);
    return true;
}

// The pinhole VFOV with the same pixels-per-radian at the circle centre
// (ungated form, from the current state alone).
export function fisheyeEquivalentFOVDegRaw() {
    refreshFisheyeParams();
    const scaleY = Math.max(fisheye.circlePct / 100, 1e-6);
    return 2 * Math.atan(fisheyeUniforms.uFishRhoEdge.value / scaleY) * 180 / Math.PI;
}

// Gated form for point-sprite sizing (CNodeView.adjustPointScale): a star
// drawn through this equivalent focal length has the correct size where the
// plate scale matters most. Returns null when the fisheye does not apply to
// the camera.
export function fisheyeEquivalentFOVDeg(camera) {
    if (!isFisheyeCamera(camera)) return null;
    return fisheyeEquivalentFOVDegRaw();
}

// ── Image circle mask ───────────────────────────────────────────────
// A real allsky frame is black outside the lens's image circle. The vertex
// warp CLAMPS past the FOV edge rather than culling (no rim holes), so
// content past the configured FOV still lands outside the circle — this
// full-screen pass, drawn onto the finished frame, blacks it out with a
// ~1px anti-aliased rim. Optional (fisheye.showCircle).
let _maskMaterial = null;

function getMaskMaterial() {
    if (_maskMaterial) return _maskMaterial;
    _maskMaterial = new ShaderMaterial({
        uniforms: {
            uMaskAspect: {value: 16 / 9},
            uMaskCenter: {value: new Vector2(0, 0)},
            uMaskRadius: {value: 1.0},
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform float uMaskAspect;
            uniform vec2 uMaskCenter;
            uniform float uMaskRadius;
            varying vec2 vUv;
            void main() {
                vec2 ndc = vUv * 2.0 - 1.0;
                vec2 d = vec2((ndc.x - uMaskCenter.x) * uMaskAspect, ndc.y - uMaskCenter.y);
                float r = length(d);
                float w = fwidth(r) + 1e-6;
                float a = smoothstep(uMaskRadius - w, uMaskRadius + w, r);
                if (a <= 0.0) discard;
                gl_FragColor = vec4(0.0, 0.0, 0.0, a);
            }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    return _maskMaterial;
}

// Called by CNodeView3D at the end of renderTargetAndEffects, after the frame
// has been composited to the canvas. Radius/centre are in NDC-y units scaled
// by the aspect, matching the vertex warp's layout exactly.
export function renderFisheyeMask(view) {
    if (!fisheye.enabled || !fisheye.showCircle) return;
    if (!isFisheyeCamera(view.camera)) return;
    if (!view.fullscreenQuad || !view.fullscreenQuadCamera || !view.renderer) return;
    const m = getMaskMaterial();
    const aspect = view.camera.aspect > 0 ? view.camera.aspect : 1;
    m.uniforms.uMaskAspect.value = aspect;
    m.uniforms.uMaskCenter.value.set(
        (fisheye.centerX / 100) * 2 / aspect,
        (fisheye.centerY / 100) * 2,
    );
    m.uniforms.uMaskRadius.value = fisheye.circlePct / 100;
    const prevMaterial = view.fullscreenQuad.material;
    view.renderer.setRenderTarget(null);
    view.fullscreenQuad.material = m;
    view.renderer.render(view.fullscreenQuad, view.fullscreenQuadCamera);
    view.fullscreenQuad.material = prevMaterial;
}

// ── Allsky pose ─────────────────────────────────────────────────────
// Point the look camera straight up in the allsky convention: image up =
// NORTH, east on the LEFT (a camera on its back with its top edge toward
// north — matching the compass rose on typical allsky software overlays).
//
// When the manual PTZ angles node exists it is driven DIRECTLY in its
// satellite mode — the gimbal-lock-free representation of a zenith camera,
// and the authoritative pose while a Manual heading source re-applies it
// every frame. el=90/az=0/roll=180 is the verified N-up/E-left orientation
// (satellite roll carries the heading; 0 leaves north at the BOTTOM).
// Without a PTZ node the camera pose is set directly.
export function pointCameraStraightUp() {
    const camNode = NodeMan.get("lookCamera", false);
    if (!camNode || !camNode.camera) return;
    const cam = camNode.camera;
    const up = getLocalUpVector(cam.position);
    const north = getLocalNorthVector(cam.position);
    cam.up.copy(north);
    cam.lookAt(cam.position.clone().addScaledVector(up, 1000));
    cam.updateMatrixWorld(true);
    const ptz = NodeMan.get("ptzAngles", false);
    if (ptz) {
        ptz.satellite = true;
        ptz.az = 0;
        ptz.el = 90;
        if (ptz.roll !== undefined) ptz.roll = 180;
        ptz.rotation = 0;
        ptz._satQuatDirty = true;
        ptz.updateSatelliteSliderRanges?.();
        ptz.updateSatelliteSliderVisibility?.();
        ptz.refresh?.();
    }
    setRenderOne(true);
}

// ── Serialization ───────────────────────────────────────────────────
// A tiny state node whose simple serials proxy the module state, so custom
// saves carry the mode (mods.Fisheye). Created on every custom sitch load,
// BEFORE the save's mods apply. dispose() force-disables so the mode cannot
// leak into the next sitch; a save actually using it re-enables through
// modDeserialize.
class CNodeFisheye extends CNode {
    constructor(v) {
        super(v);
        this.addSimpleSerials(["fishEnabled", "fishLensType", "fishFov",
            "fishCirclePct", "fishCenterX", "fishCenterY", "fishRoll", "fishShowCircle"]);
    }

    get fishEnabled() { return fisheye.enabled; }
    set fishEnabled(b) { fisheye.enabled = !!b; }
    get fishLensType() { return fisheye.lensType; }
    set fishLensType(s) { if (LENS_PRESETS[s]) fisheye.lensType = s; }
    get fishFov() { return fisheye.fov; }
    set fishFov(x) { fisheye.fov = x; }
    get fishCirclePct() { return fisheye.circlePct; }
    set fishCirclePct(x) { fisheye.circlePct = x; }
    get fishCenterX() { return fisheye.centerX; }
    set fishCenterX(x) { fisheye.centerX = x; }
    get fishCenterY() { return fisheye.centerY; }
    set fishCenterY(x) { fisheye.centerY = x; }
    get fishRoll() { return fisheye.roll; }
    set fishRoll(x) { fisheye.roll = x; }
    get fishShowCircle() { return fisheye.showCircle; }
    set fishShowCircle(b) { fisheye.showCircle = !!b; }

    modDeserialize(v) {
        super.modDeserialize(v);
        applyFisheyeState();
    }

    dispose() {
        // Full reset, not just the gate: a later sitch whose save carries no
        // mods.Fisheye must start from defaults, not inherit this one's lens.
        // (A save that HAS mods sets every field again through modDeserialize.)
        const wasEnabled = fisheye.enabled;
        Object.assign(fisheye, {
            enabled: false, lensType: "equisolidFisheye", fov: 180, circlePct: 100,
            centerX: 0, centerY: 0, roll: 0, showCircle: true,
        });
        if (wasEnabled) applyFisheyeState();
        super.dispose();
    }
}

// Whether the scene hooks are armed for the ON state. Parameter changes
// (slider drags, the wheel, a continuous pinch — every gesture frame) only
// need the uniforms refreshed; the full renderable sweep is forced only on
// the OFF→ON transition, otherwise it keeps its 500 ms cadence.
let _fisheyeArmed = false;

export function applyFisheyeState() {
    if (fisheye.enabled) {
        refreshFisheyeParams();
        installAllSceneHooks(!_fisheyeArmed);
        _fisheyeArmed = true;
    } else {
        fisheyeUniforms.uFishOn.value = 0.0;
        restoreSceneState();
        _fisheyeArmed = false;
    }
    setRenderOne(true);
}

// ── GUI ─────────────────────────────────────────────────────────────
// The Fisheye sub-folder of Camera → FOV (Zoom). Rebuilt per sitch (the menu
// bar empties the permanent folder shells on a sitch switch).
export function setupFisheye() {
    if (!NodeMan.exists("Fisheye")) {
        new CNodeFisheye({id: "Fisheye"});
    }

    const parent = guiMenus.cameraFOV;
    if (!parent) return;

    // A stale folder from this session's previous sitch was destroyed with the
    // menu contents; guard anyway in case setup runs twice.
    const existing = (parent.folders ?? []).find(f => f._title === "Fisheye");
    if (existing) existing.destroy();

    const folder = parent.addFolder("Fisheye").close();

    folder.add(fisheye, "enabled").listen()
        .name("Fisheye Lens")
        .onChange(applyFisheyeState)
        .tooltip("Render the look view through a fisheye lens instead of the pinhole projection, "
            + "allowing fields of view of 180° and beyond — as an allsky/meteor camera sees the sky. "
            + "The normal Zoom/VFOV sliders are ignored while this is on; use Fisheye FOV below "
            + "(the scroll wheel in the look view adjusts it too).");

    const typeOptions = {};
    for (const type of Object.keys(FISHEYE_TYPE_INDEX)) {
        typeOptions[LENS_PRESETS[type].label] = type;
    }
    folder.add(fisheye, "lensType", typeOptions).listen()
        .name("Projection")
        .onChange(applyFisheyeState)
        .tooltip("The lens's radial mapping r(θ) — how far off-axis angles land from the image "
            + "centre. Cheap allsky board lenses are usually close to equisolid or equidistant. "
            + "Same curves as Star Track's camera lens model.");

    folder.add(fisheye, "fov", FISHEYE_FOV_MIN, 360, 0.1).listen()
        .name("Fisheye FOV °")
        .onChange(applyFisheyeState)
        .tooltip("Full field of view across the image circle's DIAMETER, in degrees. 180 puts the "
            + "horizon exactly on the circle's edge for a zenith-pointing camera. Capped per "
            + "projection (rectilinear 160, orthographic 180, stereographic 340).");

    folder.add(fisheye, "circlePct", 10, 400, 0.1).listen()
        .name("Circle Size %")
        .onChange(applyFisheyeState)
        .tooltip("Image circle diameter as a percentage of the view height. 100 inscribes the "
            + "circle vertically; larger values crop its top and bottom, as allsky cameras "
            + "framed 16:9 do (the STLS frame is about 155).");

    folder.add(fisheye, "centerX", -100, 100, 0.1).listen()
        .name("Center X %")
        .onChange(applyFisheyeState)
        .tooltip("Horizontal offset of the image circle's centre from the frame centre, as a "
            + "percentage of the view height (so X and Y move in the same physical units).");

    folder.add(fisheye, "centerY", -100, 100, 0.1).listen()
        .name("Center Y %")
        .onChange(applyFisheyeState)
        .tooltip("Vertical offset of the image circle's centre from the frame centre, as a "
            + "percentage of the view height. Positive moves the circle up.");

    folder.add(fisheye, "roll", -180, 180, 0.05).listen()
        .name("Roll °")
        .onChange(applyFisheyeState)
        .tooltip("Rotate the fisheye image about its centre, matching a camera rotated in its "
            + "mount. Applied in the image plane, independent of the camera's own orientation.");

    folder.add(fisheye, "showCircle").listen()
        .name("Show Image Circle")
        .onChange(applyFisheyeState)
        .tooltip("Mask everything outside the image circle to black, like the unexposed area of "
            + "a real allsky frame.");

    folder.add({allsky: pointCameraStraightUp}, "allsky")
        .name("Point Straight Up (Allsky)")
        .tooltip("Aim the look camera at the zenith in the allsky convention: north at the top "
            + "of the frame, east on the LEFT (the mirror of a map, because the camera looks up). "
            + "Use Roll to match a camera that wasn't mounted north-aligned.");

    // Published for MCP/console debugging; not used by any code path.
    Globals.fisheye = fisheye;

    if (fisheye.enabled) applyFisheyeState();
}
