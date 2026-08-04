// CNodeEclipse.js
//
// Solar-eclipse close-up visuals: the Moon's silhouette crossing the
// photosphere, Baily's beads and the diamond-ring glare around second/third
// contact, and the corona + chromospheric prominences during totality.
//
// Architecture mirrors CNodeAtmosphericOptics ("theHalos"): a singleton node
// ("theEclipse") whose meshes live in GlobalSunSkyScene, which renderSky()
// draws with the camera at the origin after the daytime sky quad — so these
// effects appear over the sky but are covered by terrain/objects in the main
// pass. renderSky() re-syncs the node per view so each view renders the
// eclipse for its own observer position.
//
// Everything is ANALYTIC in a quad-local angular frame: two tessellated quads
// centered on the geometric Sun direction (per-vertex refracted on the CPU
// with the same model the Sun/Moon disk shaders use, so the limbs stay
// aligned near the horizon). Fragment shaders work in units of the Sun's
// angular radius, where r=1 is the photosphere limb:
//   - darkMesh (normal blending, renderOrder 3): paints the Moon's disk
//     near-black ONLY where it overlaps the photosphere — the silhouette
//     "bite" during partial phases, the classic black disk at totality.
//   - glowMesh (additive blending, renderOrder 4): corona (with static
//     streamer structure), prominences, Baily's-beads glare and the
//     diamond-ring starburst. All gated by the exposed-photosphere width, so
//     they emerge and vanish at physically correct times.
// The Moon's limb is given a small deterministic roughness profile (sum of
// cosines) so the last sliver of photosphere breaks into discrete beads
// rather than a smooth thinning crescent. No time-based animation — fully
// deterministic per (date, observer), which regression capture requires.
//
// HARD NO-OP: when the Moon does not overlap the Sun at all
// (getEclipseState returns obscuration 0) the whole group is set invisible
// and nothing else is computed or rebuilt.

import {CNode} from "./CNode";
import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    DoubleSide,
    Group,
    Mesh,
    NormalBlending,
    ShaderMaterial,
    Vector2,
    Vector3,
} from "three";
import {GlobalSunSkyScene} from "../LocalFrame";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {getCelestialDirection} from "../CelestialMath";
import {eclipseVisualGates, getEclipseState, setEclipseLightingEnabled} from "../CEclipseCalc";
import {getLocalUpVector} from "../SphericalMath";
import {applyRefractionECI, refractionOptsFromUniforms, refractionUniforms} from "../atmosphere/refraction";

// Same celestial-sphere radius as CPlanets/CNodeAtmosphericOptics. Depth is
// irrelevant (depthTest off); matching keeps everything coplanar with the Sun.
const SPHERE_RADIUS = 100;

// Quad half-extent in Sun radii — far enough for the outer corona streamers
// plus a windowing band so the quad boundary never shows as a seam.
const EXTENT = 8.0;

// Grid tessellation (per side). Only needed so CPU per-vertex refraction can
// bend the quad like the Sun/Moon disks near the horizon.
const GRID = 40;

// Deterministic seed for the lunar-limb roughness and streamer phases.
const SEED = 3.7;

// GLSL: Moon angular radius as a function of position angle around its limb —
// a small deterministic roughness (sum of incommensurate cosines) standing in
// for lunar valleys/mountains. Shared by both fragment shaders so the
// silhouette edge and the bead glare agree about where the valleys are.
// Peak amplitude ±3.6 * 0.0012 ≈ ±0.4% of the radius ≈ ±4 arcsec — slightly
// exaggerated from the real limb (±2-3 arcsec) so beads read on screen, but
// small enough that a shallow (grazing) totality still fully covers them:
// the Mallorca 2026 event only has ~6 arcsec of margin at peak.
const LIMB_GLSL = `
    float limbR(vec2 rel) {
        // atan(0,0) is undefined in GLSL — dead center is trivially inside.
        if (dot(rel, rel) < 1e-9) return uMoonR;
        float th = atan(rel.y, rel.x);
        float b = cos(9.0 * th + uSeed) + cos(17.0 * th + 2.3 * uSeed)
                + cos(29.0 * th + 4.1 * uSeed) + 0.6 * cos(43.0 * th + 5.3 * uSeed);
        return uMoonR * (1.0 + 0.0012 * b);
    }
`;

const VERTEX_GLSL = `
    attribute vec2 aXY;
    varying vec2 vXY;
    void main() {
        vXY = aXY;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// will exist as a singleton node: "theEclipse"
export class CNodeEclipse extends CNode {
    constructor(v) {
        super(v);

        this.enabled = v.enabled ?? true;          // visuals master (hard no-op anyway without overlap)
        this.corona = v.corona ?? true;            // corona + streamers at totality
        this.prominences = v.prominences ?? true;  // red chromospheric loops on the limb
        this.beads = v.beads ?? true;              // Baily's beads + diamond-ring glare
        this.affectLighting = v.affectLighting ?? true;  // scene light / sky dimming (CNodeSunlight)
        this.intensity = v.intensity ?? 1.0;

        setEclipseLightingEnabled(this.affectLighting);

        this.addSimpleSerials([
            "enabled",
            "corona",
            "prominences",
            "beads",
            "affectLighting",
            "intensity",
        ]);

        this.group = new Group();
        this.group.name = "eclipseVisuals";
        this.group.visible = false;
        this._attached = false;

        // Working vectors (avoid per-frame allocation).
        this._S = new Vector3();
        this._U = new Vector3();
        this._V = new Vector3();
        this._tmp = new Vector3();
        this._refractionZenith = new Vector3(0, 0, 1);
        this._refractionOpts = refractionOptsFromUniforms();

        this._buildGeometry();
        this._buildMaterials();

        this.darkMesh = new Mesh(this.geometry, this.darkMaterial);
        this.darkMesh.renderOrder = 3;       // over the Sun disk (1) and Moon mesh (2)
        this.darkMesh.frustumCulled = false;
        this.group.add(this.darkMesh);

        this.glowMesh = new Mesh(this.geometry, this.glowMaterial);
        this.glowMesh.renderOrder = 4;
        this.glowMesh.frustumCulled = false;
        this.group.add(this.glowMesh);

        // GUI — submenu under Lighting, next to the Atmospheric Optics.
        this.gui = guiMenus.lighting ? guiMenus.lighting.addFolder("Solar Eclipse") : undefined;
        if (this.gui) {
            const addBool = (property, name) => this.gui.add(this, property).name(name).listen()
                .onChange(() => this.recalculate());
            addBool("enabled", "Eclipse Effects")
                .tooltip("Master toggle for solar-eclipse visuals: the Moon's silhouette, Baily's beads, the diamond ring, and the totality corona with prominences. Has no effect unless the Moon actually overlaps the Sun.");
            this.gui.add(this, "intensity", 0, 3, 0.01).name("Intensity").listen()
                .onChange(() => this.recalculate())
                .tooltip("Overall brightness of the corona, prominences and bead/diamond glare.");
            addBool("corona", "Corona")
                .tooltip("The pearly-white solar corona with streamers, visible only when the photosphere is essentially covered.");
            addBool("prominences", "Prominences")
                .tooltip("Pink-red chromospheric loops on the solar limb, peeking past the Moon's edge during totality.");
            addBool("beads", "Baily's Beads / Diamond Ring")
                .tooltip("The last sunlight shining through lunar valleys at second and third contact, and the diamond-ring flare.");
            this.gui.add(this, "affectLighting").name("Affect Lighting").listen()
                .onChange(() => {
                    setEclipseLightingEnabled(this.affectLighting);
                    this.recalculate();
                })
                .tooltip("Dim the scene lighting and sky with the eclipse: gradual attenuation through the partial phases, deep-twilight darkness and a 360° horizon glow at totality.");
        }
    }

    recalculate() {
        setRenderOne(true);
    }

    // One shared tessellated quad: static aXY (Sun-radius units), positions
    // recomputed each sync (Sun moves, refraction state changes).
    _buildGeometry() {
        const nVerts = (GRID + 1) * (GRID + 1);
        this._positions = new Float32Array(nVerts * 3);
        const aXY = new Float32Array(nVerts * 2);
        const indices = [];
        let p = 0;
        for (let i = 0; i <= GRID; i++) {
            for (let j = 0; j <= GRID; j++) {
                aXY[p * 2] = (i / GRID * 2 - 1) * EXTENT;
                aXY[p * 2 + 1] = (j / GRID * 2 - 1) * EXTENT;
                p++;
            }
        }
        const stride = GRID + 1;
        for (let i = 0; i < GRID; i++) {
            for (let j = 0; j < GRID; j++) {
                const a = i * stride + j;
                indices.push(a, a + 1, a + stride, a + stride, a + 1, a + stride + 1);
            }
        }
        this.geometry = new BufferGeometry();
        this._positionAttr = new BufferAttribute(this._positions, 3);
        this.geometry.setAttribute("position", this._positionAttr);
        this.geometry.setAttribute("aXY", new BufferAttribute(aXY, 2));
        this.geometry.setIndex(indices);
    }

    _buildMaterials() {
        const shared = () => ({
            uMoonOff: {value: new Vector2(10, 0)},
            uMoonR: {value: 1.0},
            uSeed: {value: SEED},
        });

        // The Moon's silhouette over the photosphere. Normal blending toward
        // near-black; alpha confined to (inside Moon) ∩ (over Sun disk), so
        // off the Sun the (dark, new-moon) Moon stays invisible against the
        // sky, exactly as in real partial-eclipse photos.
        this.darkMaterial = new ShaderMaterial({
            transparent: true,
            blending: NormalBlending,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
            uniforms: shared(),
            vertexShader: VERTEX_GLSL,
            fragmentShader: `
                uniform vec2 uMoonOff;
                uniform float uMoonR;
                uniform float uSeed;
                varying vec2 vXY;
                ${LIMB_GLSL}
                void main() {
                    vec2 rel = vXY - uMoonOff;
                    float dm = length(rel);
                    float rL = limbR(rel);
                    float aaM = fwidth(dm) + 1e-4;
                    float insideMoon = 1.0 - smoothstep(rL - aaM, rL + aaM, dm);
                    if (insideMoon <= 0.001) discard;
                    float r = length(vXY);
                    float aaS = fwidth(r) + 1e-4;
                    // Extend a hair past the limb so the Sun disk's own edge
                    // antialiasing can't rim-light the silhouette.
                    float overSun = 1.0 - smoothstep(1.0, 1.0 + 2.0 * aaS, r);
                    float a = insideMoon * overSun * 0.985;
                    if (a <= 0.002) discard;
                    gl_FragColor = vec4(vec3(0.004, 0.005, 0.007), a);
                }
            `,
        });

        // Additive light: corona, prominences, bead glare, diamond ring.
        this.glowMaterial = new ShaderMaterial({
            transparent: true,
            blending: AdditiveBlending,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
            uniforms: {
                ...shared(),
                uCorona: {value: 0},
                uProm: {value: 0},
                uBeads: {value: 0},
                uDiamond: {value: 0},
                uDiamondPos: {value: new Vector2(1, 0)},
                uGain: {value: 1},
            },
            vertexShader: VERTEX_GLSL,
            fragmentShader: `
                uniform vec2 uMoonOff;
                uniform float uMoonR;
                uniform float uSeed;
                uniform float uCorona;
                uniform float uProm;
                uniform float uBeads;
                uniform float uDiamond;
                uniform vec2 uDiamondPos;
                uniform float uGain;
                varying vec2 vXY;
                ${LIMB_GLSL}
                void main() {
                    float r = length(vXY);
                    vec2 rel = vXY - uMoonOff;
                    float dm = length(rel);
                    float rL = limbR(rel);
                    float aaM = fwidth(dm) + 1e-4;
                    float outsideMoon = smoothstep(rL, rL + 2.0 * aaM, dm);

                    vec3 col = vec3(0.0);

                    // ---- Prominences: pink-red chromospheric loops at fixed
                    // (seeded) position angles just off the limb, plus a thin
                    // chromosphere rim right at the photosphere edge that
                    // flashes at second/third contact. Density is computed
                    // FIRST because prominences are opaque plasma: they must
                    // locally SHADOW the white inner corona, or additive
                    // clipping bleaches their color to white.
                    float promDensity = 0.0;
                    if (uProm > 0.001) {
                        for (int i = 0; i < 6; i++) {
                            float fi = float(i + 1);
                            float ai = 6.2831853 * fract(sin(fi * 12.9898 + uSeed) * 43758.5453);
                            float s = 0.020 + 0.024 * fract(sin(fi * 78.233) * 12543.85);
                            vec2 ci = vec2(cos(ai), sin(ai)) * 1.016;
                            vec2 dp = vXY - ci;
                            promDensity += exp(-dot(dp, dp) / (s * s));
                        }
                        float rim = exp(-pow((r - 1.005) / 0.009, 2.0));
                        promDensity = (promDensity + rim * 0.4) * uProm * outsideMoon;
                    }

                    // ---- Corona: bright K-corona hugging the limb plus
                    // streamers with a static multi-lobed angular structure.
                    if (uCorona > 0.001) {
                        float cr = max(r, 1.0);
                        float th = atan(vXY.y, vXY.x);
                        float st = 0.62
                            + 0.20 * cos(2.0 * th + 1.7 + uSeed)
                            + 0.12 * cos(5.0 * th + 0.9)
                            + 0.06 * cos(9.0 * th + 3.4);
                        st = clamp(st, 0.15, 1.0);
                        float inner = 1.35 * exp(-(cr - 1.0) * 4.5);
                        // Streamers REACH farther where st is high — an
                        // angle-dependent radial decay reads as petals and
                        // polar brushes, not just brightness ripple.
                        float outer = 0.60 * st * pow(cr, -(1.8 + 1.6 * (1.0 - st)));
                        // r²-driven envelope: an infinitely-smooth gaussian
                        // tail that takes the glow to ~zero asymptotically —
                        // a windowing band alone leaves a visible brightness
                        // contour (Mach band) where the falloff rate changes.
                        outer *= exp(-cr * cr / 12.0);
                        // Hard-zero belt-and-suspenders before the quad edge;
                        // by here the envelope has it at ~1e-3 so this cut is
                        // invisible.
                        float win = 1.0 - smoothstep(5.5, 7.6, cr);
                        // Opaque prominences block the corona behind them.
                        float suppress = 1.0 / (1.0 + 6.0 * promDensity);
                        col += uCorona * outsideMoon * win * suppress * (inner + outer) * vec3(0.93, 0.96, 1.0);
                    }

                    col += promDensity * 2.8 * vec3(1.0, 0.24, 0.20);

                    // ---- Baily's beads: glare from photosphere exposed in a
                    // thin band at the Sun's limb; the limb-roughness profile
                    // breaks the band into discrete beads near contact.
                    if (uBeads > 0.001) {
                        float limbBand = exp(-pow((r - 0.997) / 0.020, 2.0));
                        col += uBeads * outsideMoon * limbBand * 2.2 * vec3(1.0, 0.94, 0.80);
                    }

                    // ---- Diamond ring: one dominant glare with a 4-point
                    // starburst at the center of the exposed sliver.
                    if (uDiamond > 0.001) {
                        vec2 dp = vXY - uDiamondPos;
                        float dd = length(dp);
                        float core = 1.8 * exp(-pow(dd / 0.10, 2.0));
                        float spikes = exp(-abs(dp.y) * 60.0) * exp(-abs(dp.x) * 2.6)
                                     + exp(-abs(dp.x) * 60.0) * exp(-abs(dp.y) * 2.6);
                        col += uDiamond * (core + 1.4 * spikes) * vec3(1.0, 0.97, 0.90);
                    }

                    col *= uGain;
                    if (col.r + col.g + col.b < 0.002) discard;
                    gl_FragColor = vec4(col, 1.0);
                }
            `,
        });
    }

    update(f) {
        super.update(f);

        // Lazily parent into the sun-sky scene once it exists.
        if (!this._attached && GlobalSunSkyScene !== undefined) {
            GlobalSunSkyScene.add(this.group);
            this._attached = true;
        }

        if (!this.enabled) {
            this.group.visible = false;
            return;
        }

        // Observer — match CNodeSunlight (lookCamera, falling back to mainCamera).
        let camera;
        if (NodeMan.exists("lookCamera")) {
            camera = NodeMan.get("lookCamera").camera;
        } else if (NodeMan.exists("mainCamera")) {
            camera = NodeMan.get("mainCamera").camera;
        } else {
            return;
        }
        this.syncToObserver(camera.position);
    }

    // Re-aim the quads and refresh uniforms for the given observer. Called
    // from update() and re-called per view by renderSky(), like theHalos, so
    // the shared sun-sky scene renders each view from its own observer.
    syncToObserver(observerPos, date = GlobalDateTimeNode.dateNow) {
        if (!this._attached || !observerPos) return;
        if (!this.enabled) {
            this.group.visible = false;
            return;
        }

        const state = getEclipseState(observerPos, date);
        if (state.obscuration === 0) {
            // HARD NO-OP: no overlap — nothing computed, nothing rendered.
            this.group.visible = false;
            return;
        }

        const sunDir = getCelestialDirection("Sun", date, observerPos);
        const moonDir = getCelestialDirection("Moon", date, observerPos);
        if (!sunDir || !moonDir) {
            this.group.visible = false;
            return;
        }
        this.group.visible = true;

        // Quad basis: U horizontal-ish (zenith x S), V completing it. The
        // diamond-ring starburst aligns to these axes, which keeps its spikes
        // roughly screen-horizontal/vertical for a level camera.
        const zenith = getLocalUpVector(observerPos);
        const S = this._S.copy(sunDir).normalize();
        const U = this._U.crossVectors(zenith, S);
        if (U.lengthSq() < 1e-8) {
            // Sun at the zenith — any horizontal will do.
            U.set(1, 0, 0).addScaledVector(S, -S.x);
        }
        U.normalize();
        const V = this._V.crossVectors(S, U).normalize();

        // Refraction state — same source the Sun/Moon disk shaders use.
        this._refractionOpts = refractionOptsFromUniforms();
        this._refractionZenith.copy(refractionUniforms.uZenithECEF.value);
        if (this._refractionZenith.lengthSq() < 0.5) {
            this._refractionZenith.copy(zenith);
        }
        this._refractionZenith.normalize();

        // Rebuild vertex positions: aXY (Sun radii) -> world direction ->
        // per-vertex refraction -> celestial sphere. ~1.7k verts, trivial.
        const rs = state.sunRad;
        const aXY = this.geometry.getAttribute("aXY").array;
        const pos = this._positions;
        const tmp = this._tmp;
        const refractionOn = this._refractionOpts?.enabled;
        const nVerts = (GRID + 1) * (GRID + 1);
        for (let i = 0; i < nVerts; i++) {
            const x = aXY[i * 2], y = aXY[i * 2 + 1];
            tmp.copy(S).addScaledVector(U, x * rs).addScaledVector(V, y * rs).normalize();
            if (refractionOn) {
                applyRefractionECI(tmp, this._refractionZenith, this._refractionOpts);
            }
            pos[i * 3] = tmp.x * SPHERE_RADIUS;
            pos[i * 3 + 1] = tmp.y * SPHERE_RADIUS;
            pos[i * 3 + 2] = tmp.z * SPHERE_RADIUS;
        }
        this._positionAttr.needsUpdate = true;

        // Moon center in quad space (Sun radii), via the GNOMONIC (tangent-
        // plane) projection: dividing by moonDir·S puts the center in the
        // same tan-space the quad vertices use (each vertex sits at angle
        // atan(rs·|aXY|) from S), so the analytic mask and the rendered
        // disks agree to the sub-milliarcsecond level rather than the
        // ~0.1 arcsec a bare sin-projection would leave.
        const su = Math.max(1e-6, moonDir.dot(S));
        const mx = moonDir.dot(U) / su / rs;
        const my = moonDir.dot(V) / su / rs;
        const moonR = state.moonRad / rs;

        for (const mat of [this.darkMaterial, this.glowMaterial]) {
            mat.uniforms.uMoonOff.value.set(mx, my);
            mat.uniforms.uMoonR.value = moonR;
        }

        // Visual gates — pure math in CEclipseCalc (unit-tested there), and
        // annular-aware: an annular eclipse never shows corona, prominences
        // or the diamond ring, and its beads fire only at the INTERNAL
        // contacts, not through the stable ring phase.
        const gates = eclipseVisualGates(state);

        const gu = this.glowMaterial.uniforms;
        gu.uCorona.value = this.corona ? gates.corona : 0;
        gu.uProm.value = this.prominences ? gates.corona : 0;
        gu.uBeads.value = this.beads ? gates.beads : 0;
        gu.uDiamond.value = this.beads ? gates.diamond : 0;
        gu.uGain.value = this.intensity;

        // Diamond sits at the center of the exposed sliver: the Sun-limb
        // point diametrically away from the Moon's center. Perfectly central
        // alignment has no preferred direction — use a fixed deterministic
        // fallback rather than whatever the previous sync left behind.
        const mlen = Math.hypot(mx, my);
        if (mlen > 1e-6) {
            gu.uDiamondPos.value.set(-mx / mlen, -my / mlen);
        } else {
            gu.uDiamondPos.value.set(1, 0);
        }

        this.glowMesh.visible =
            (gu.uCorona.value + gu.uProm.value + gu.uBeads.value + gu.uDiamond.value) > 0.001;
    }

    modSerialize() {
        return {...super.modSerialize()};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        setEclipseLightingEnabled(this.affectLighting);
    }

    dispose() {
        if (this._attached && GlobalSunSkyScene !== undefined) {
            GlobalSunSkyScene.remove(this.group);
        }
        this._attached = false;
        this.geometry?.dispose();
        this.darkMaterial?.dispose();
        this.glowMaterial?.dispose();
        super.dispose();
    }
}
