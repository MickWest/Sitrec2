// CNodeLunarEclipse.js
//
// Lunar eclipses: the Earth's shadow falling on the Moon.
//
// Two things live here.
//
// 1. The SHADING of the Moon itself. The per-fragment work is in the lunar
//    shader in CPlanets; this node computes the geometry each frame, builds the
//    umbral radiance profile texture (the blood-moon colour), works out the
//    exposure, and publishes all of it through `lunarEclipseRender`.
//
// 2. The optional EARTH SHADOW DISC drawn at the Moon's distance - the whole
//    umbra and penumbra as a screen would catch them, so you can watch the
//    Moon crawl through it. Architecturally this mirrors CNodeEclipse (the
//    solar-eclipse visuals): a tessellated quad in GlobalSunSkyScene whose
//    vertices are refracted on the CPU with the same model the Sun and Moon
//    disc shaders use, so it stays registered with the Moon near the horizon,
//    and an analytic fragment shader that reproduces exactly the same shadow
//    physics the Moon is shaded with.
//
// HARD NO-OP: away from an eclipse, getLunarEclipseState() returns its frozen
// NO_LUNAR_ECLIPSE object, this node publishes `active: false`, the group is
// hidden, and the Moon shader takes its early-out. Nothing is computed, no
// texture is built, and no uniform outside the master switch is written.

import {CNode} from "./CNode";
import {
    BufferAttribute,
    BufferGeometry,
    ClampToEdgeWrapping,
    DataTexture,
    DataUtils,
    AdditiveBlending,
    DoubleSide,
    Group,
    HalfFloatType,
    LinearFilter,
    Matrix4,
    Mesh,
    RGBAFormat,
    ShaderMaterial,
    Vector3,
} from "three";
import * as Astronomy from "astronomy-engine";
import {GlobalSunSkyScene} from "../LocalFrame";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {getEQJToECEFMatrix} from "../CelestialMath";
import {
    MOON_MEAN_RADIUS_KM,
    SUN_RADIUS_KM,
    danjonFromIllumination,
    directSunlightAt,
    getLunarEclipseState,
    getUmbralProfile,
    lunarDiskIllumination,
    lunarEclipseRender,
    sampleUmbralProfile,
} from "../CLunarEclipseCalc";
import {atmosphereFromClarity} from "../atmosphere/umbralLight";
import {applyRefractionECI, refractionOptsFromUniforms, refractionUniforms} from "../atmosphere/refraction";

// Same celestial-sphere radius as CPlanets / CNodeEclipse.
const SPHERE_RADIUS = 100;

// Quad half-extent, in penumbral radii. Just enough to carry the outer ring
// plus its antialiasing.
const EXTENT = 1.08;

// Quad tessellation per side. Only needed so CPU per-vertex refraction can bend
// the rings the way it bends the Moon near the horizon.
const GRID = 48;

// Resolution of the umbral radiance profile texture.
const LUT_SAMPLES = 256;

// Auto exposure puts the MEAN brightness of the shadowed part of the Moon, at
// the deepest phase of the eclipse, at this display level.
//
// The mean rather than the peak: the umbral rim is a hundred times brighter
// than the umbra's middle, so exposing for the rim leaves the whole interior
// black. Exposing for the mean lets the rim clip - which is exactly what a
// long exposure of totality does - and shows the colour across the disc.
// The soft shoulder in the shader means none of this costs the sunlit part
// anything: illumination above 0.8 rolls off toward 1 instead of clipping,
// and the surface texture still modulates it.
const AUTO_EXPOSURE_TARGET = 0.30;

// Outline colours, matching CNodeDisplayMoonShadow's convention for the Moon's
// own shadow cone so the two shadow displays read as a set.
const UMBRA_OUTLINE = [1.0, 0.843, 0.0];      // gold
const PENUMBRA_OUTLINE = [1.0, 0.647, 0.0];   // orange

const VERTEX_GLSL = /* glsl */`
    attribute vec2 aXY;
    varying vec2 vXY;
    void main() {
        vXY = aXY;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// will exist as a singleton node: "theLunarEclipse"
export class CNodeLunarEclipse extends CNode {
    constructor(v) {
        super(v);

        this.enabled = v.enabled ?? true;              // master for the Moon shading
        // OFF by default. The rings cost nothing away from an eclipse, and
        // nothing is taken from the sky during one - but they are a DIAGRAM
        // over an otherwise photographic scene, and the eclipse itself is what
        // people came to look at. One click in this folder turns them on.
        this.showOutlines = v.showOutlines ?? false;   // the umbra/penumbra rings
        this.bloodMoon = v.bloodMoon ?? true;
        this.clarity = v.clarity ?? 0.5;               // atmospheric clarity -> Danjon
        this.autoExposure = v.autoExposure ?? true;
        this.exposureStops = v.exposureStops ?? 0;
        this.info = "";

        this.addSimpleSerials([
            "enabled",
            "showOutlines",
            "bloodMoon",
            "clarity",
            "autoExposure",
            "exposureStops",
        ]);

        this.group = new Group();
        this.group.name = "lunarEclipseShadowRings";
        this.group.visible = false;
        this._attached = false;

        // Working state (avoid per-frame allocation).
        this._A = new Vector3();
        this._U = new Vector3();
        this._V = new Vector3();
        this._centre = new Vector3();
        this._tmp = new Vector3();
        this._obsKm = new Vector3();
        this._eqjToECEF = new Matrix4();
        this._refractionZenith = new Vector3(0, 0, 1);
        this._refractionOpts = refractionOptsFromUniforms();

        // Umbral profile texture, allocated once and refilled in place.
        this._lutData = new Uint16Array(LUT_SAMPLES * 4);
        this._lutTexture = new DataTexture(this._lutData, LUT_SAMPLES, 1, RGBAFormat, HalfFloatType);
        this._lutTexture.minFilter = LinearFilter;
        this._lutTexture.magFilter = LinearFilter;
        this._lutTexture.wrapS = ClampToEdgeWrapping;
        this._lutTexture.wrapT = ClampToEdgeWrapping;
        this._lutTexture.generateMipmaps = false;
        this._lutSourceProfile = null;      // identity of the profile currently uploaded
        this._lutGain = 1;

        // Auto-exposure is keyed to the eclipse EVENT, not to the current
        // frame, so the Moon still visibly darkens as it enters the shadow
        // instead of the picture self-levelling. Cached per peak time.
        this._autoExposureCache = {peakMs: null, key: null, gain: 1};

        // Publish the settings the lighting path needs BEFORE any sync happens,
        // and again whenever they change. See lunarEclipseRender's comment: the
        // lighting node updates before this one, so it must not have to wait for
        // a frame's sync to learn that an eclipse is switched on.
        this._publishSettings();

        this._buildGeometry();
        this._buildMaterial();

        this.ringMesh = new Mesh(this.geometry, this.material);
        // Below the Moon (2) and the Sun (1), so the Moon always draws over the
        // rings rather than being cut by one.
        this.ringMesh.renderOrder = 0;
        this.ringMesh.frustumCulled = false;
        this.group.add(this.ringMesh);

        this._buildGUI();
    }

    _buildGUI() {
        this.gui = guiMenus.lighting ? guiMenus.lighting.addFolder("Lunar Eclipse") : undefined;
        if (!this.gui) return;
        const g = this.gui;

        g.add(this, "enabled").name("Eclipse Shading").listen()
            .onChange(() => this.recalculate())
            .tooltip("Master toggle for the Earth's shadow on the Moon: the penumbral shading, the"
                + " umbra with its feathered edge, and the refracted 'blood moon' light inside it."
                + " Has no effect unless a lunar eclipse is actually in progress.");

        g.add(this, "bloodMoon").name("Blood Moon Color").listen()
            .onChange(() => this.recalculate())
            .tooltip("Colour the umbra with the sunlight refracted through the Earth's atmosphere —"
                + " deep red at the centre, with the ozone-blue fringe near the edge. Off renders the"
                + " same brightness in grey.");

        g.add(this, "clarity", 0, 1, 0.01).name("Atmospheric Clarity").listen()
            .onChange(() => this.recalculate())
            .tooltip("How clear the Earth's atmosphere is around the limb, which is what decides how"
                + " bright and how red totality looks (the Danjon scale). Low means heavy volcanic"
                + " aerosol and cloud — an almost invisible Moon, as after Pinatubo. High is an"
                + " exceptionally clear, bright coppery eclipse. 0.5 is typical.");

        g.add(this, "autoExposure").name("Auto Exposure").listen()
            .onChange(() => this.recalculate())
            .tooltip("A total eclipse is ~10 magnitudes below a full Moon, so at true brightness it"
                + " renders black. Auto picks one exposure from the deepest phase of THIS eclipse and"
                + " holds it, the way a fixed-exposure photo sequence of totality works — the Moon"
                + " still visibly darkens as it enters the shadow. Turn off for physical brightness.");

        g.add(this, "exposureStops", -4, 20, 0.1).name("Exposure (stops)").listen()
            .onChange(() => { this.autoExposure = false; this.recalculate(); })
            .tooltip("Manual exposure for the shadowed part, in stops. 0 is physically correct."
                + " Changing this turns Auto Exposure off. The sunlit part is unaffected: the"
                + " shader rolls illumination off smoothly above 0.8 rather than clipping it.");

        g.add(this, "showOutlines").name("Shadow Outlines").listen()
            .onChange(() => this.recalculate())
            .tooltip("Ring the Earth's umbra (gold) and penumbra (orange) out at the Moon's distance,"
                + " so you can see the whole shadow the Moon is crossing. Drawn from the same"
                + " geometry that shades the Moon, so the gold ring passes exactly along the shadow's"
                + " edge on the Moon's face. The same colour convention as Show Moon's Shadow, which"
                + " draws the Moon's shadow on the Earth.");

        g.add(this, "info").name("Eclipse").listen().disable()
            .tooltip("What the current time works out to: the kind of eclipse, the umbral magnitude"
                + " (how far the Moon's diameter has entered the umbra), and — during totality — the"
                + " Moon's visual magnitude and the Danjon L number the model predicts.");
    }

    recalculate() {
        this._publishSettings();
        setRenderOne(true);
    }

    // The atmosphere object is rebuilt only when the clarity actually changes,
    // so its identity is stable and can be used as a cache key downstream.
    _publishSettings() {
        if (this._atmoClarity !== this.clarity) {
            this._atmoClarity = this.clarity;
            this._atmo = atmosphereFromClarity(this.clarity);
        }
        lunarEclipseRender.enabled = !!this.enabled;
        lunarEclipseRender.atmo = this._atmo;
    }

    // One shared tessellated quad. aXY is a fixed grid in units of the
    // penumbral radius; positions are rebuilt each sync.
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

    _buildMaterial() {
        this.material = new ShaderMaterial({
            transparent: true,
            // ADDITIVE, so the disc only ever adds light and never dims a star
            // behind it. With ordinary alpha blending a 30% veil over the whole
            // quad would knock every star inside it down by a third - and the
            // umbra, where the disc contributes nothing, is exactly where you
            // most want the star field intact.
            blending: AdditiveBlending,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
            uniforms: {
                uPenumbraKm: {value: 8263},
                uUmbraKm: {value: 4688},
            },
            vertexShader: VERTEX_GLSL,
            fragmentShader: /* glsl */`
                uniform float uPenumbraKm;
                uniform float uUmbraKm;
                varying vec2 vXY;

                void main() {
                    // vXY is in penumbral radii; the rings are in km.
                    float rKm = length(vXY) * uPenumbraKm;

                    // Two hairlines, antialiased by the screen-space rate of
                    // change of rKm - so they stay one pixel wide at any zoom,
                    // from a whole-sky view down to a close-up of the Moon.
                    float aa = fwidth(rKm) * 1.5 + 1.0;
                    float inner = 1.0 - smoothstep(0.0, aa, abs(rKm - uUmbraKm));
                    float outer = 1.0 - smoothstep(0.0, aa, abs(rKm - uPenumbraKm));
                    float a = max(inner, outer);
                    if (a <= 0.004) discard;

                    // Gold for the umbra, orange for the penumbra - the same
                    // convention Show Moon's Shadow uses for the Moon's own
                    // shadow cone, so the two read as a set.
                    vec3 col = inner >= outer
                        ? vec3(${UMBRA_OUTLINE.join(", ")})
                        : vec3(${PENUMBRA_OUTLINE.join(", ")});
                    gl_FragColor = vec4(col, a);
                }
            `,
        });
    }

    // Called every frame by the node manager. Does the observer-independent
    // work (state, profile, exposure, Moon uniforms) and then aims the shadow
    // disc at the default camera; renderSky() re-aims it per view.
    update() {
        if (!this._attached && GlobalSunSkyScene !== undefined) {
            GlobalSunSkyScene.add(this.group);
            this._attached = true;
        }

        let camera;
        if (NodeMan.exists("lookCamera")) camera = NodeMan.get("lookCamera").camera;
        else if (NodeMan.exists("mainCamera")) camera = NodeMan.get("mainCamera").camera;
        this.syncToObserver(camera?.position);
    }

    /**
     * Recompute the eclipse for this frame and aim the shadow disc at the given
     * observer. Called from update() and re-called per view by renderSky(),
     * before the Moon meshes are synced, because the Moon shader reads what
     * this publishes.
     */
    syncToObserver(observerPos, date = GlobalDateTimeNode?.dateNow) {
        const r = lunarEclipseRender;

        this._publishSettings();

        if (!this.enabled || !date) {
            r.active = false;
            this.group.visible = false;
            this.info = "";
            return;
        }

        const state = getLunarEclipseState(date);
        if (state.kind === "none") {
            // HARD NO-OP: no eclipse, nothing computed, nothing rendered.
            r.active = false;
            this.group.visible = false;
            this.info = "none";
            return;
        }

        const atmo = this._atmo;
        const profile = getUmbralProfile(state, atmo, LUT_SAMPLES);
        this._uploadProfile(profile);

        r.active = true;
        r.state = state;
        r.profile = profile;
        r.lutTexture = this._lutTexture;
        r.lutGain = this._lutGain;
        r.lutScaleKm = profile.rMaxKm;
        r.exposure = this._exposureFor(state, atmo);
        r.bloodMoon = this.bloodMoon ? 1 : 0;

        this._updateInfo(state, profile);

        if (!this.showOutlines || !this._attached || !observerPos) {
            this.group.visible = false;
            return;
        }
        this._updateShadowRings(state, observerPos, date);
    }

    // Re-encode the profile into the half-float texture. Values span three
    // decades, so they are stored as sqrt(v/max) and squared on read: that
    // keeps the darkest umbra well inside the half-float normal range instead
    // of falling into the subnormals some GPUs flush to zero.
    _uploadProfile(profile) {
        if (this._lutSourceProfile === profile) return;
        this._lutSourceProfile = profile;

        let max = 0;
        for (let i = 0; i < profile.rgb.length; i++) {
            if (profile.rgb[i] > max) max = profile.rgb[i];
        }
        this._lutGain = max > 0 ? max : 0;
        const inv = max > 0 ? 1 / max : 0;
        const one = DataUtils.toHalfFloat(1);
        for (let n = 0; n < LUT_SAMPLES; n++) {
            for (let c = 0; c < 3; c++) {
                const v = Math.sqrt(Math.max(0, profile.rgb[n * 3 + c] * inv));
                this._lutData[n * 4 + c] = DataUtils.toHalfFloat(v);
            }
            this._lutData[n * 4 + 3] = one;
        }
        this._lutTexture.needsUpdate = true;
    }

    // Exposure gain applied to the total illumination before the soft shoulder.
    _exposureFor(state, atmo) {
        if (!this.autoExposure) return Math.pow(2, this.exposureStops);

        // Key the exposure to the eclipse EVENT so it holds steady while the
        // Moon moves through the shadow.
        const peakMs = this._peakTimeFor();
        const key = `${peakMs}|${this.clarity}`;
        if (this._autoExposureCache.key === key) return this._autoExposureCache.gain;

        let gain = 1;
        try {
            const peak = peakMs !== null ? getLunarEclipseState(new Date(peakMs)) : state;
            if (peak.kind === "partial" || peak.kind === "total") {
                const profile = getUmbralProfile(peak, atmo, LUT_SAMPLES);
                const level = this._meanShadowedRadiance(peak, profile);
                if (level > 0) {
                    gain = Math.min(1e6, Math.max(1, AUTO_EXPOSURE_TARGET / level));
                }
            }
        } catch {
            gain = 1;
        }
        this._autoExposureCache = {peakMs, key, gain};
        return gain;
    }

    // Time of this eclipse's peak, cached. SearchLunarEclipse walks forward
    // through full moons, so it is far too expensive to call per frame.
    _peakTimeFor() {
        const t = GlobalDateTimeNode?.dateNow?.getTime?.();
        if (!Number.isFinite(t)) return null;
        // Eclipses are months apart and no penumbral phase lasts six hours, so
        // a cached peak within half a day of now is certainly this same event.
        if (this._peakCache !== undefined && this._peakCache !== null
            && Math.abs(t - this._peakCache) < 12 * 3600e3) {
            return this._peakCache;
        }
        let peakMs = null;
        try {
            const found = Astronomy.SearchLunarEclipse(new Date(t - 26 * 3600e3));
            const ms = found.peak.date.getTime();
            if (Math.abs(ms - t) < 24 * 3600e3) peakMs = ms;
        } catch {
            peakMs = null;
        }
        this._peakCache = peakMs;
        return peakMs;
    }

    // Mean refracted radiance over the part of the Moon's disc that is getting
    // no direct sunlight at all - the umbral region. Equal-area sampling, so a
    // plain average over the samples IS the disc average. Taken on the
    // strongest channel (the red one, in practice) because that is the level
    // the eye reads a blood moon by.
    _meanShadowedRadiance(state, profile) {
        const n = state.moonEQJ.clone().normalize();
        const a = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
        const e1 = new Vector3().crossVectors(n, a).normalize();
        const e2 = new Vector3().crossVectors(n, e1).normalize();
        const pt = new Vector3();
        const rgb = [0, 0, 0];
        let sum = 0, count = 0;
        const RINGS = 12, SPOKES = 24;
        for (let i = 0; i < RINGS; i++) {
            const frac = Math.sqrt((i + 0.5) / RINGS);
            const rad = frac * MOON_MEAN_RADIUS_KM;
            const bulge = Math.sqrt(Math.max(0, MOON_MEAN_RADIUS_KM ** 2 - rad * rad));
            for (let j = 0; j < SPOKES; j++) {
                const th = 2 * Math.PI * (j + 0.5) / SPOKES;
                pt.copy(state.moonEQJ)
                    .addScaledVector(e1, rad * Math.cos(th))
                    .addScaledVector(e2, rad * Math.sin(th))
                    .addScaledVector(n, -bulge);
                if (directSunlightAt(pt, state.sunEQJ, state.shadowRadiusKm) > 0) continue;
                const along = pt.dot(state.axisEQJ);
                const px = pt.x - state.axisEQJ.x * along;
                const py = pt.y - state.axisEQJ.y * along;
                const pz = pt.z - state.axisEQJ.z * along;
                sampleUmbralProfile(profile, Math.hypot(px, py, pz), rgb);
                sum += Math.max(rgb[0], rgb[1], rgb[2]);
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    }

    _updateInfo(state, profile) {
        const kind = state.kind[0].toUpperCase() + state.kind.slice(1);
        if (state.kind === "penumbral") {
            this.info = `${kind}, pen. mag ${state.penumbralMag.toFixed(2)}`;
            return;
        }
        const lit = lunarDiskIllumination(state, profile);
        const mag = -12.74 - 2.5 * Math.log10(Math.max(1e-12, lit));
        let s = `${kind}, umbral mag ${state.umbralMag.toFixed(2)}, mV ${mag.toFixed(1)}`;
        if (state.kind === "total") s += `, Danjon L${danjonFromIllumination(lit).toFixed(1)}`;
        this.info = s;
    }

    _updateShadowRings(state, observerPos, date) {
        // Everything here is done in the ECEF render frame, like CNodeEclipse:
        // the group hangs off GlobalSunSkyScene directly rather than off the
        // EQJ-authored celestial sphere.
        getEQJToECEFMatrix(date, this._eqjToECEF);

        const axis = this._A.copy(state.axisEQJ).applyMatrix4(this._eqjToECEF).normalize();
        // Centre of the shadow cross-section in the Moon's plane, geocentric.
        this._centre.copy(axis).multiplyScalar(state.alongKm);

        // Observer, ECEF metres -> km, so it can be subtracted from the shadow
        // geometry. Parallax matters: the Moon and the shadow are both only
        // 384,000 km away, and they shift together, which is exactly why the
        // disc stays registered with the Moon.
        this._obsKm.copy(observerPos).multiplyScalar(0.001);

        // A basis in the shadow plane.
        this._helper ??= new Vector3();
        this._helper.set(0, 0, 1);
        if (Math.abs(axis.z) >= 0.9) this._helper.set(1, 0, 0);
        const U = this._U.crossVectors(axis, this._helper).normalize();
        const V = this._V.crossVectors(axis, U).normalize();

        this._refractionOpts = refractionOptsFromUniforms();
        this._refractionZenith.copy(refractionUniforms.uZenithECEF.value);
        if (this._refractionZenith.lengthSq() < 0.5) {
            this._refractionZenith.copy(observerPos).normalize();
        }
        this._refractionZenith.normalize();
        const refractionOn = this._refractionOpts?.enabled;

        const aXY = this.geometry.getAttribute("aXY").array;
        const pos = this._positions;
        const tmp = this._tmp;
        const scale = state.penumbraKm;
        const nVerts = (GRID + 1) * (GRID + 1);
        for (let i = 0; i < nVerts; i++) {
            const x = aXY[i * 2] * scale, y = aXY[i * 2 + 1] * scale;
            tmp.copy(this._centre)
                .addScaledVector(U, x)
                .addScaledVector(V, y)
                .sub(this._obsKm)
                .normalize();
            if (refractionOn) {
                applyRefractionECI(tmp, this._refractionZenith, this._refractionOpts);
            }
            pos[i * 3] = tmp.x * SPHERE_RADIUS;
            pos[i * 3 + 1] = tmp.y * SPHERE_RADIUS;
            pos[i * 3 + 2] = tmp.z * SPHERE_RADIUS;
        }
        this._positionAttr.needsUpdate = true;

        const u = this.material.uniforms;
        u.uPenumbraKm.value = state.penumbraKm;
        u.uUmbraKm.value = state.umbraKm;

        this.group.visible = true;
    }

    modSerialize() {
        return {...super.modSerialize()};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        // A saved sitch can restore `enabled` and `clarity` at any point in the
        // load, including after the lighting node has already run once.
        this._publishSettings();
    }

    dispose() {
        if (this._attached && GlobalSunSkyScene !== undefined) {
            GlobalSunSkyScene.remove(this.group);
        }
        this._attached = false;
        lunarEclipseRender.enabled = false;
        lunarEclipseRender.active = false;
        lunarEclipseRender.profile = null;
        lunarEclipseRender.lutTexture = null;
        this.geometry?.dispose();
        this.material?.dispose();
        this._lutTexture?.dispose();
        super.dispose();
    }
}
