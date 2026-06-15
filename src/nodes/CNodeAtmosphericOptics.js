// CNodeAtmosphericOptics.js
//
// Renders ice-crystal atmospheric optics (halos, arcs and sun dogs) on the
// daytime celestial sphere, centered on the real Sun.
//
// The geometry is built in WORLD space directly from:
//   - the Sun direction:  getCelestialDirection("Sun", date, observerPos)
//   - the local zenith:    getLocalUpVector(observerPos)
// getCelestialDirection() already includes the GMST rotation, so the Sun
// direction (scaled to the celestial-sphere radius) lands exactly where the
// daytime Sun *sprite* is drawn. By adding our mesh group directly to
// GlobalSunSkyScene (an identity-transform sibling of the GMST-rotated
// celestialDaySphere) the halos stay perfectly centered on the Sun without
// us ever needing to know whether the world frame is ECEF or EUS.
//
// GlobalSunSkyScene is rendered by CNodeView3D.renderSky() with the camera at
// the origin (celestial-sphere style) and a clearDepth afterwards, so the
// halos draw over the daytime sky yet are correctly occluded by terrain and
// the horizon. No render-pipeline changes are required.
//
// Each optic is a reasonably-dense, indexed triangle mesh with per-vertex RGB
// colors, drawn additively (refracted/reflected sunlight ADDS to the sky).
// Brightness is premultiplied into the vertex RGB and faded to zero at the
// horizon so below-horizon portions vanish cleanly even without terrain.

import {CNode} from "./CNode";
import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    DoubleSide,
    Group,
    Mesh,
    MeshBasicMaterial,
    Vector3,
    MathUtils,
} from "three";
import {GlobalNightSkyScene, GlobalSunSkyScene} from "../LocalFrame";
import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {getCelestialDirection} from "../CelestialMath";
import {getLocalUpVector} from "../SphericalMath";
import {radians, degrees} from "../utils";

// Radius of the celestial sphere used for the Sun/Moon/star sprites. Matches
// CPlanets/CStarField sphereRadius. With the camera at the origin the exact
// value only affects depth (and we render depth-test-off), but matching keeps
// the halos coplanar with the Sun sprite.
const SPHERE_RADIUS = 100;

// A simple, hand-tuned spectral ramp for refraction colors.
// t = 0 -> deep red, t = 1 -> violet. Values are linear-ish RGB.
const SPECTRUM_STOPS = [
    [0.00, 1.00, 0.12, 0.08],  // red
    [0.18, 1.00, 0.45, 0.08],  // orange
    [0.34, 1.00, 0.85, 0.20],  // yellow
    [0.50, 0.45, 1.00, 0.30],  // green
    [0.66, 0.15, 0.80, 1.00],  // cyan-blue
    [0.84, 0.25, 0.40, 1.00],  // blue
    [1.00, 0.60, 0.20, 0.95],  // violet
];

// 22°-halo radial color profile (v = 0 inner edge -> 1 faint outer).
// Brightness ramps up from 0 at the inner edge so the red is a soft gradient
// rather than a hard wall. Columns: [position, r, g, b, brightness]
const HALO22_STOPS = [
    [0.00, 1.00, 0.20, 0.10, 0.00],  // soft start at the inner edge
    [0.12, 1.00, 0.26, 0.13, 0.55],  // red ramps in
    [0.24, 1.00, 0.42, 0.17, 1.00],  // red-orange peak
    [0.46, 1.00, 0.86, 0.44, 0.52],  // yellow
    [0.72, 0.85, 0.92, 1.00, 0.22],  // bluish white
    [1.00, 0.55, 0.70, 1.00, 0.00],  // fade to blue
];

// 46°-halo profile — fainter, redder, broader, soft inner edge.
const HALO46_STOPS = [
    [0.00, 1.00, 0.30, 0.18, 0.00],
    [0.16, 1.00, 0.42, 0.22, 0.80],
    [0.32, 1.00, 0.58, 0.28, 0.90],
    [0.62, 1.00, 0.90, 0.55, 0.40],
    [1.00, 0.70, 0.85, 1.00, 0.00],
];

// Lunar 22° halo — faint and nearly colorless (moonlight is too dim for the
// eye to see strong color), with only a hint of red inside. Soft inner edge.
const MOON22_STOPS = [
    [0.00, 0.95, 0.65, 0.55, 0.00],  // soft start
    [0.14, 0.95, 0.72, 0.62, 0.65],  // faint reddish inner
    [0.30, 0.92, 0.92, 0.90, 1.00],  // whitish peak
    [0.62, 0.82, 0.88, 1.00, 0.45],  // cool white
    [1.00, 0.72, 0.82, 1.00, 0.00],  // fade to blue
];

// Sun-dog color along the parhelic circle (u = 0 sunward red -> 1 bluish tail).
const SUNDOG_STOPS = [
    [0.00, 1.00, 0.20, 0.10, 0.85],  // red, toward the Sun
    [0.22, 1.00, 0.72, 0.30, 1.00],  // yellow-white core
    [0.50, 1.00, 1.00, 0.95, 0.85],  // bright white
    [1.00, 0.55, 0.75, 1.00, 0.15],  // faint blue tail away from Sun
];

// Moon-dog (paraselenae) color — the lunar counterpart of sun dogs: faint and
// nearly colorless, only a hint of red on the moonward side.
const MOONDOG_STOPS = [
    [0.00, 0.95, 0.60, 0.50, 0.75],  // faint reddish, toward the Moon
    [0.22, 0.95, 0.85, 0.78, 1.00],  // pale core
    [0.50, 0.92, 0.95, 0.95, 0.90],  // whitish
    [1.00, 0.72, 0.82, 1.00, 0.15],  // faint blue tail away from Moon
];

// Interpolate a stops table [[pos, c0, c1, ...], ...] at position x.
function evalStops(stops, x) {
    x = MathUtils.clamp(x, 0, 1);
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (x >= stops[i][0] && x <= stops[i + 1][0]) {
            lo = stops[i];
            hi = stops[i + 1];
            break;
        }
    }
    const span = hi[0] - lo[0];
    const f = span > 1e-9 ? (x - lo[0]) / span : 0;
    const out = [];
    for (let k = 1; k < lo.length; k++) {
        out.push(lo[k] + (hi[k] - lo[k]) * f);
    }
    return out;
}

// Smooth 0->1 bump that is 0 at the edges and 1 in the middle (sin lobe).
function bump(s) {
    return Math.sin(MathUtils.clamp(s, 0, 1) * Math.PI);
}

// Window that is 1 in the interior and ramps smoothly to 0 within a margin m
// of each end of [0,1]. Used to guarantee a feature's brightness reaches zero
// at its mesh boundary so there are no hard edges.
function edgeFade(x, m) {
    return MathUtils.smoothstep(x, 0, m) * (1 - MathUtils.smoothstep(x, 1 - m, 1));
}

// will exist as a singleton node: "theHalos"
export class CNodeAtmosphericOptics extends CNode {
    constructor(v) {
        super(v);

        // Master + tuning
        this.enabled = v.enabled ?? false;       // default OFF (no surprise pixels)
        this.intensity = v.intensity ?? 1.0;     // global brightness multiplier

        // Individual optics
        this.halo22 = v.halo22 ?? true;
        this.halo46 = v.halo46 ?? false;
        this.sunDogs = v.sunDogs ?? true;
        this.circumzenithal = v.circumzenithal ?? true;
        this.circumhorizontal = v.circumhorizontal ?? true;
        this.parhelicCircle = v.parhelicCircle ?? false;
        this.sunPillar = v.sunPillar ?? false;
        this.upperTangentArc = v.upperTangentArc ?? false;
        this.parryArc = v.parryArc ?? false;
        this.sunGlare = v.sunGlare ?? false;

        // Moon halo + moon dogs — render at night (in the night-sky scene).
        this.moonHalo = v.moonHalo ?? false;
        this.moonDogs = v.moonDogs ?? false;

        this.addSimpleSerial("enabled");
        this.addSimpleSerial("intensity");
        this.addSimpleSerial("halo22");
        this.addSimpleSerial("halo46");
        this.addSimpleSerial("sunDogs");
        this.addSimpleSerial("circumzenithal");
        this.addSimpleSerial("circumhorizontal");
        this.addSimpleSerial("parhelicCircle");
        this.addSimpleSerial("sunPillar");
        this.addSimpleSerial("upperTangentArc");
        this.addSimpleSerial("parryArc");
        this.addSimpleSerial("sunGlare");
        this.addSimpleSerial("moonHalo");
        this.addSimpleSerial("moonDogs");

        // GUI — a submenu under the existing Lighting menu. Guarded so the node
        // is still usable in headless/console contexts where the menu bar may
        // not exist (the optics still serialize via the properties above).
        this.gui = guiMenus.lighting ? guiMenus.lighting.addFolder("Atmospheric Optics (Halos)") : undefined;
        if (this.gui) {
            this.addGUIBoolean("enabled", "Show Halos")
                .tooltip("Master toggle for ice-crystal atmospheric optics: Sun halos/arcs by day, and an optional Moon halo at night.");
            this.addGUIValue("intensity", 0, 3, 0.01, "Intensity")
                .tooltip("Overall brightness of the halos, arcs and sun dogs.");
            this.addGUIBoolean("halo22", "22° Halo")
                .tooltip("The common ring 22° from the Sun (random-oriented hexagonal crystals). Reddish inside, bluish-white outside.");
            this.addGUIBoolean("sunDogs", "Sun Dogs (Parhelia)")
                .tooltip("Bright spots either side of the Sun at the same altitude, just outside the 22° halo. Red on the sunward side.");
            this.addGUIBoolean("circumzenithal", "Circumzenithal Arc")
                .tooltip("An 'upside-down rainbow' centered on the zenith, ~46° above the Sun. Only forms when the Sun is below ~32°; brightest near 22°.");
            this.addGUIBoolean("circumhorizontal", "Circumhorizontal Arc")
                .tooltip("A band parallel to the horizon ~46° below the Sun ('fire rainbow'). Only forms when the Sun is above ~58°.");
            this.addGUIBoolean("parhelicCircle", "Parhelic Circle")
                .tooltip("A white circle parallel to the horizon passing through the Sun at constant altitude.");
            this.addGUIBoolean("halo46", "46° Halo")
                .tooltip("A larger, fainter ring 46° from the Sun.");
            this.addGUIBoolean("sunPillar", "Sun Pillar")
                .tooltip("A vertical shaft of light through the Sun (reflection from horizontal plate crystals).");
            this.addGUIBoolean("upperTangentArc", "Tangent Arcs / Circumscribed")
                .tooltip("Tangent arcs from horizontal column crystals (physical refraction model): a narrow 'V' at low Sun, opening into gull-wings, then closing into the circumscribed halo (a drooping oval around the 22° halo) once the Sun rises above ~32°.");
            this.addGUIBoolean("parryArc", "Parry Arc")
                .tooltip("A suncave arc riding just above the upper tangent arc, from rare 'Parry-oriented' columns (c-axis horizontal with two side faces also horizontal). A sign of well-aligned crystals.");
            this.addGUIBoolean("sunGlare", "Sun Glare")
                .tooltip("A soft bright aureole of forward-scattered light around the Sun, as seen through thin ice cloud. Cosmetic — not a refraction optic.");
            this.addGUIBoolean("moonHalo", "Moon Halo (22°)")
                .tooltip("A faint 22° halo around the Moon, drawn on the night sky. The same ice-crystal physics as the Sun's halo, but nearly colorless because moonlight is dim.");
            this.addGUIBoolean("moonDogs", "Moon Dogs (Paraselenae)")
                .tooltip("Faint bright spots either side of the Moon at ±22°, the lunar counterpart of sun dogs. Rare and nearly colorless. Brightest near a full Moon.");
        }

        // Two scene groups, added lazily (the scenes are created by the
        // night-sky node and may not exist yet at construction time):
        //   sunGroup  -> GlobalSunSkyScene   (daytime celestial pass)
        //   moonGroup -> GlobalNightSkyScene (night celestial pass)
        // This is what makes the Sun optics day-only and the Moon halo night-
        // only — each scene is only rendered at the appropriate sky brightness.
        this.sunGroup = new Group();
        this.sunGroup.name = "atmosphericOpticsSun";
        this.moonGroup = new Group();
        this.moonGroup.name = "atmosphericOpticsMoon";
        this._sunAttached = false;
        this._moonAttached = false;

        // Set per-group while building: target group and a source-visibility
        // scalar (fades the whole group as its light source nears the horizon).
        this._activeGroup = this.sunGroup;
        this._sourceFade = 1;

        // One shared additive material for every optic.
        this.material = new MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            blending: AdditiveBlending,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
            toneMapped: false,
        });

        // Rebuild bookkeeping.
        this._dirty = true;
        this._lastSun = new Vector3();
        this._lastMoon = new Vector3();
        this._lastZenith = new Vector3();
        this._lastIntensity = -1;

        // Working basis (world space), set per source (Sun or Moon) each build.
        this._S = new Vector3();   // source (Sun/Moon) direction
        this._Z = new Vector3();   // local zenith (up)
        this._H = new Vector3();   // horizontal source azimuth direction
        this._W = new Vector3();   // horizontal, perpendicular to _H (source "side")
        this._Usun = new Vector3(); // in-ring "up" (zenith component perpendicular to source)
        this._Vsun = new Vector3(); // in-ring "side" (= S x Usun)
        this._elevDeg = 0;
    }

    // GUI changes route here (addGUIBoolean/addGUIValue call recalculate()).
    recalculate() {
        this._dirty = true;
        setRenderOne(true);
    }

    update(f) {
        super.update(f);

        // Lazily parent into the daytime and night sky scenes once they exist.
        if (!this._sunAttached && GlobalSunSkyScene !== undefined) {
            GlobalSunSkyScene.add(this.sunGroup);
            this._sunAttached = true;
        }
        if (!this._moonAttached && GlobalNightSkyScene !== undefined) {
            GlobalNightSkyScene.add(this.moonGroup);
            this._moonAttached = true;
        }

        this.sunGroup.visible = this.enabled;
        this.moonGroup.visible = this.enabled;
        if (!this.enabled) return;

        // Observer — match CNodeSunlight (lookCamera, falling back to mainCamera).
        let camera;
        if (NodeMan.exists("lookCamera")) {
            camera = NodeMan.get("lookCamera").camera;
        } else if (NodeMan.exists("mainCamera")) {
            camera = NodeMan.get("mainCamera").camera;
        } else {
            return;
        }

        const date = GlobalDateTimeNode.dateNow;
        const sunDir = getCelestialDirection("Sun", date, camera.position);
        if (!sunDir) return;
        const zenith = getLocalUpVector(camera.position);

        // Only compute the Moon direction when a Moon optic is enabled.
        const moonDir = (this.moonHalo || this.moonDogs)
            ? getCelestialDirection("Moon", date, camera.position) : null;

        const moved = sunDir.distanceToSquared(this._lastSun) > 1e-10
            || zenith.distanceToSquared(this._lastZenith) > 1e-10
            || (moonDir ? moonDir.distanceToSquared(this._lastMoon) > 1e-10 : false);
        if (this._dirty || moved || this.intensity !== this._lastIntensity) {
            this._rebuild(sunDir, moonDir, zenith);
            this._lastSun.copy(sunDir);
            if (moonDir) this._lastMoon.copy(moonDir);
            this._lastZenith.copy(zenith);
            this._lastIntensity = this.intensity;
            this._dirty = false;
        }
    }

    _clearGroup(group) {
        for (const child of group.children) {
            child.geometry?.dispose();
        }
        group.clear();
    }

    // Set the world-space orthonormal basis for a light source (Sun or Moon).
    _setBasis(dir, zenith) {
        const S = this._S.copy(dir).normalize();
        const Z = this._Z.copy(zenith).normalize();

        const sinE = MathUtils.clamp(S.dot(Z), -1, 1);
        this._elevDeg = degrees(Math.asin(sinE));

        // Horizontal azimuth direction H = normalize(S - (S·Z)Z).
        const H = this._H.copy(S).addScaledVector(Z, -sinE);
        if (H.lengthSq() < 1e-8) {
            // Source at (or very near) the zenith — pick an arbitrary horizontal.
            H.set(1, 0, 0).addScaledVector(Z, -Z.x).normalize();
        } else {
            H.normalize();
        }
        // W = Z x H : horizontal, perpendicular to the source azimuth.
        this._W.copy(Z).cross(H).normalize();

        // In-ring basis: Usun points from the source toward the zenith.
        const Usun = this._Usun.copy(Z).addScaledVector(S, -Z.dot(S));
        if (Usun.lengthSq() < 1e-8) {
            Usun.copy(H);
        }
        Usun.normalize();
        this._Vsun.copy(S).cross(Usun).normalize();
    }

    _rebuild(sunDir, moonDir, zenith) {
        this._clearGroup(this.sunGroup);
        this._clearGroup(this.moonGroup);

        // ---- Sun optics — daytime sky scene. ----------------------------
        // Faded out as the Sun sets so nothing renders at night.
        this._setBasis(sunDir, zenith);
        const sunVis = MathUtils.smoothstep(this._elevDeg, -3, 0);
        if (sunVis > 0.01) {
            this._activeGroup = this.sunGroup;
            this._sourceFade = sunVis;
            if (this.sunGlare) this._buildSunGlare();
            if (this.halo22) this._buildRing(22.0, 20.8, 25.5, HALO22_STOPS, 0.33, 240, 12);
            if (this.halo46) this._buildRing(46.0, 44.6, 50.0, HALO46_STOPS, 0.20, 280, 12);
            if (this.upperTangentArc) this._buildTangentArcs();
            if (this.parryArc) this._buildParryArc();
            if (this.parhelicCircle) this._buildParhelicCircle();
            if (this.sunPillar) this._buildSunPillar();
            if (this.sunDogs) this._buildDogs(SUNDOG_STOPS, 0.9);   // dogs read ≥2× the 22° halo
            if (this.circumzenithal) this._buildCircumzenithalArc();
            if (this.circumhorizontal) this._buildCircumhorizontalArc();
        }

        // ---- Moon optics — night sky scene. -----------------------------
        // The night-sky scene is only rendered when the sky is dark enough
        // (skyOpacity < 1), so the Moon halo/dogs are naturally night-only.
        if ((this.moonHalo || this.moonDogs) && moonDir) {
            this._setBasis(moonDir, zenith);
            const moonVis = MathUtils.smoothstep(this._elevDeg, -1.5, 2);
            if (moonVis > 0.01) {
                // Scale with how lit the Moon is: a thin crescent gives a much
                // fainter halo than a full Moon. k = illuminated fraction from
                // the Sun–Moon elongation. Floor at 0.35 so it never vanishes.
                const k = (1 - MathUtils.clamp(sunDir.dot(moonDir), -1, 1)) * 0.5;
                const illum = 0.35 + 0.65 * k;
                this._activeGroup = this.moonGroup;
                this._sourceFade = moonVis * illum;
                // Much fainter base than the Sun optics — the Moon halo sits on
                // a near-black sky, where additive blending reads far brighter.
                if (this.moonHalo) this._buildRing(22.0, 20.8, 25.5, MOON22_STOPS, 0.17, 240, 12);
                if (this.moonDogs) this._buildDogs(MOONDOG_STOPS, 0.20);
            }
        }
    }

    // ---- Generic band-mesh builder. -------------------------------------
    // dirFn(u, v) -> unit Vector3 (world space). colFn(u, v) -> [r,g,b] with
    // brightness/intensity already premultiplied. Builds an indexed grid mesh
    // ((nu+1) x (nv+1) vertices). A per-vertex horizon fade is applied so the
    // optic disappears smoothly below the horizon.
    _buildBand(nu, nv, dirFn, colFn) {
        const nVerts = (nu + 1) * (nv + 1);
        const positions = new Float32Array(nVerts * 3);
        const colors = new Float32Array(nVerts * 3);
        const indices = [];
        const Z = this._Z;
        const sinLo = Math.sin(radians(-0.6));
        const sinHi = Math.sin(radians(2.5));
        const sourceFade = this._sourceFade;

        let p = 0;
        for (let i = 0; i <= nu; i++) {
            const u = i / nu;
            for (let j = 0; j <= nv; j++) {
                const v = j / nv;
                const d = dirFn(u, v);
                positions[p * 3] = d.x * SPHERE_RADIUS;
                positions[p * 3 + 1] = d.y * SPHERE_RADIUS;
                positions[p * 3 + 2] = d.z * SPHERE_RADIUS;

                // Per-vertex horizon fade times the whole-group source fade.
                const fade = MathUtils.smoothstep(d.dot(Z), sinLo, sinHi) * sourceFade;
                const c = colFn(u, v);
                colors[p * 3] = c[0] * fade;
                colors[p * 3 + 1] = c[1] * fade;
                colors[p * 3 + 2] = c[2] * fade;
                p++;
            }
        }

        const stride = nv + 1;
        for (let i = 0; i < nu; i++) {
            for (let j = 0; j < nv; j++) {
                const a = i * stride + j;
                const b = a + stride;
                const c = a + 1;
                const dd = b + 1;
                indices.push(a, b, c, c, b, dd);
            }
        }

        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(positions, 3));
        geometry.setAttribute("color", new BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeBoundingSphere();

        const mesh = new Mesh(geometry, this.material);
        mesh.frustumCulled = false;
        this._activeGroup.add(mesh);
        return mesh;
    }

    // Direction at angle theta from the Sun, rotated by phi about the Sun.
    // phi = 0 -> toward the zenith (top of the ring).
    _ringDir(theta, phi, out) {
        const st = Math.sin(theta);
        const ct = Math.cos(theta);
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        return out.copy(this._S).multiplyScalar(ct)
            .addScaledVector(this._Usun, st * cp)
            .addScaledVector(this._Vsun, st * sp);
    }

    // Horizontal direction at azimuth offset az from the Sun, at elevation el.
    _azElDir(az, el, out) {
        const ce = Math.cos(el);
        return out.copy(this._H).multiplyScalar(ce * Math.cos(az))
            .addScaledVector(this._W, ce * Math.sin(az))
            .addScaledVector(this._Z, Math.sin(el));
    }

    // Direction at angle rho from the zenith, swept by psi (psi = 0 -> toward
    // the Sun's azimuth H). Used for the zenith-centered arcs.
    _zenithDir(rho, psi, out) {
        const sr = Math.sin(rho);
        return out.copy(this._Z).multiplyScalar(Math.cos(rho))
            .addScaledVector(this._H, sr * Math.cos(psi))
            .addScaledVector(this._W, sr * Math.sin(psi));
    }

    // ---- 22°/46° halos (full ring around the Sun). ----------------------
    _buildRing(angleDeg, innerDeg, outerDeg, stops, base, nu, nv) {
        const inner = radians(innerDeg);
        const outer = radians(outerDeg);
        const scale = base * this.intensity;
        const tmp = new Vector3();
        this._buildBand(
            nu, nv,
            (u, v) => this._ringDir(inner + (outer - inner) * v, u * Math.PI * 2, tmp),
            (u, v) => {
                const c = evalStops(stops, v); // [r,g,b,brightness]
                const b = c[3] * scale;
                return [c[0] * b, c[1] * b, c[2] * b];
            }
        );
    }

    // ---- Tangent arcs & circumscribed halo (physical refraction model). --
    // Formed by horizontally-oriented hexagonal COLUMN crystals (long c-axis
    // horizontal, random azimuth). Each column refracts through a 60° side-face
    // prism; both side faces are parallel to the c-axis, so the ray's component
    // ALONG the axis is preserved and only the perpendicular part is deviated.
    // Sweeping the crystal azimuth ψ traces the locus; the two refraction
    // branches (±D) are the UPPER and LOWER tangent arcs.
    //
    //   p   = S·a                              (skew: Sun component along the axis)
    //   nₑ  = √(n²−p²)/√(1−p²)                 (Bravais effective index)
    //   D   = 2·asin(nₑ·sin30°) − 60°          (minimum deviation, ≥ ~21.8°)
    //   r   = p·a + rot(S−p·a, ±D, a)          (refracted ray)
    // ψ=0 (axis ⟂ to the Sun azimuth) gives the bright tangent points at the top
    // (upper) and bottom (lower) of the 22° halo (D=21.8°). As the Sun rises the
    // upper arc opens from a narrow "V" into gull-wings; past ~32° the upper and
    // lower wings meet and close into the CIRCUMSCRIBED HALO — a drooping oval
    // that tightens onto the 22° halo as the Sun climbs. All of it falls out of
    // the geometry, no per-elevation tuning.
    _buildTangentArcs() {
        const N_ICE = 1.31, APEX = radians(60), SIN_HALF_APEX = 0.5;
        const D_MIN = radians(21.84), SIGMA = radians(15);
        const base = 0.5 * this.intensity;
        const S = this._S, H = this._H, W = this._W, Z = this._Z;
        const a = new Vector3(), sPerp = new Vector3(), out = new Vector3(), rad = new Vector3();

        // Refracted ray (and its deviation) for crystal azimuth ψ and branch sign
        // (+1/−1). null where total internal reflection ends the wing.
        const arc = (psi, sign, store) => {
            a.copy(W).multiplyScalar(Math.cos(psi)).addScaledVector(H, Math.sin(psi));
            const p = S.dot(a);
            const denom = Math.max(1e-6, 1 - p * p);
            const ne = Math.sqrt(Math.max(0, N_ICE * N_ICE - p * p) / denom);
            const arg = ne * SIN_HALF_APEX;
            if (arg >= 1) return null;
            const D = 2 * Math.asin(arg) - APEX;
            sPerp.copy(S).addScaledVector(a, -p);
            store.copy(sPerp).applyAxisAngle(a, sign * D).addScaledVector(a, p).normalize();
            return D;
        };

        // Which branch sign is the UPPER one at the tangent point (ψ=0).
        const rp = new Vector3(), rm = new Vector3();
        arc(0, 1, rp); arc(0, -1, rm);
        const upperSign = rp.dot(Z) >= rm.dot(Z) ? 1 : -1;

        const span = radians(90);
        const halfWidth = radians(0.85);
        const buildBranch = (sign) => this._buildBand(
            220, 4,
            (u, v) => {
                const psi = (u - 0.5) * 2 * span;
                if (arc(psi, sign, out) === null) return this._ringDir(D_MIN, 0, out);
                rad.copy(out).addScaledVector(S, -out.dot(S));   // radial (away from Sun) for width
                if (rad.lengthSq() < 1e-9) rad.copy(Z);
                rad.normalize();
                return out.addScaledVector(rad, (v - 0.5) * 2 * halfWidth).normalize();
            },
            (u, v) => {
                const psi = (u - 0.5) * 2 * span;
                const D = arc(psi, sign, out);
                const c = evalStops(HALO22_STOPS, v);
                if (D === null) return [0, 0, 0];
                // Brightest at minimum deviation (the tangent points); fades as the
                // wings spread (D grows) — soft ends, and faint sides on the oval.
                const dFade = Math.exp(-Math.pow((D - D_MIN) / SIGMA, 2));
                const b = c[3] * base * dFade * bump(v);
                return [c[0] * b, c[1] * b, c[2] * b];
            }
        );
        buildBranch(upperSign);    // upper tangent arc (top of the halo)
        buildBranch(-upperSign);   // lower tangent arc (bottom) — closes the oval at high Sun
    }

    // ---- Parry arc (suncave, just above the upper tangent arc). ----------
    // From rare "Parry-oriented" columns (c-axis horizontal AND two side faces
    // also horizontal). The common suncave Parry arc rides just above the upper
    // tangent arc and is flatter than the halo. Modelled here as a suncave arc
    // whose apex sits a touch above the 22° tangent point and droops gently to
    // the sides so it stays above the tangent arc. Approximate shape (not a
    // full ray-trace), but correctly placed and coloured (red lower edge).
    _buildParryArc() {
        const e = radians(this._elevDeg);
        const apex = radians(24.0);        // apex angular height above the Sun
        const droop = radians(12.0);       // sideways droop (suncave smile, flatter than the halo)
        const betaMax = radians(32);
        const halfW = radians(0.65);
        const base = 0.45 * this.intensity;
        const tmp = new Vector3();
        this._buildBand(
            140, 4,
            (u, v) => {
                const beta = (u - 0.5) * 2 * betaMax;
                const t = beta / betaMax;
                const h = apex - droop * t * t + (v - 0.5) * 2 * halfW;
                return this._azElDir(beta, e + h, tmp);
            },
            (u, v) => {
                // v = 0 lower (sunward) = red -> v = 1 upper = violet.
                const c = evalStops(SPECTRUM_STOPS, v);
                const b = base * bump(v) * bump(u);
                return [c[0] * b, c[1] * b, c[2] * b];
            }
        );
    }

    // ---- Sun glare (soft aureole of forward-scattered light). ------------
    // Cosmetic glow around the Sun seen through thin ice cloud — NOT a
    // refraction optic, so it has no toggle-dependent geometry. A warm radial
    // falloff: a tight bright core plus a broad faint aureole, filling the sky
    // inside the 22° halo the way a bright Sun in cirrus actually looks.
    _buildSunGlare() {
        const base = 0.7 * this.intensity;
        const rMax = radians(16);
        const tmp = new Vector3();
        this._buildBand(
            48, 26,
            (u, v) => this._ringDir(radians(0.15) + v * rMax, u * Math.PI * 2, tmp),
            (u, v) => {
                // v = 0 at the Sun -> 1 at the outer edge of the glow.
                const core = Math.exp(-v * v * 26);          // tight bright core
                const halo = Math.exp(-v * v * 2.2) * 0.32;  // broad faint aureole
                // The aureole term is still ~0.035 at the rim, which an additive
                // mesh paints as a hard ring; window it smoothly to zero so the
                // glow fades into the sky with no visible edge.
                const win = 1 - MathUtils.smoothstep(v, 0.45, 1.0);
                const b = base * (core + halo) * win;
                return [b, b * 0.96, b * 0.86];              // warm white
            }
        );
    }

    // ---- Parhelic circle (white circle at the Sun's altitude). ----------
    _buildParhelicCircle() {
        const el = radians(this._elevDeg);
        const half = radians(0.45);
        const base = 0.16 * this.intensity;
        const tmp = new Vector3();
        this._buildBand(
            360, 3,
            (u, v) => this._azElDir(u * Math.PI * 2, el + (v - 0.5) * 2 * half, tmp),
            (u, v) => {
                const b = base * bump(v);
                return [b, b, b];
            }
        );
    }

    // ---- Sun pillar (vertical shaft through the Sun). -------------------
    _buildSunPillar() {
        const el = radians(this._elevDeg);
        const len = radians(15);
        const half = radians(0.6);
        const base = 0.40 * this.intensity;
        const tmp = new Vector3();
        this._buildBand(
            48, 4,
            (u, v) => this._azElDir((v - 0.5) * 2 * half, el + (u - 0.5) * 2 * len, tmp),
            (u, v) => {
                const along = 1 - Math.abs(u - 0.5) * 2;       // 1 at the Sun
                const b = base * Math.pow(Math.max(0, along), 1.4) * bump(v);
                return [b, b * 0.92, b * 0.72];                 // warm white
            }
        );
    }

    // ---- Sun/Moon dogs (parhelia / paraselenae). ------------------------
    // Shared by sun dogs and moon dogs — uses the current source basis, so the
    // caller just supplies the color table and base brightness.
    _buildDogs(stops, baseBrightness) {
        const e = radians(this._elevDeg);
        const cosE = Math.cos(e);
        const sinE = Math.sin(e);
        if (cosE < 1e-4) return;                       // source at zenith
        // Sun dogs form in plate crystals (c-axis vertical) refracting through a
        // 60° side-face prism whose refracting edge is VERTICAL. By Bravais the
        // ray's vertical component (sin e) passes straight through; only its
        // HORIZONTAL projection is deviated, by an effective-index prism with
        //   nₑ   = √(n² − sin²e) / cos e
        //   Δaz  = 2·asin(nₑ·sin30°) − 60°      (the AZIMUTH offset of the dog)
        // The dog sits at the source's own altitude e and azimuth Δaz. Its
        // angular (great-circle) distance from the source then falls out of
        //   cos D = sin²e + cos²e·cos(Δaz),
        // which is SMALLER than Δaz: D = 22° only on the horizon, then grows
        // slowly outside the 22° halo as the Sun rises (≈22° at 10°, 23° at 20°,
        // 25° at 30°, 28° at 40°), the dog detaching from the halo and finally
        // lost to total internal reflection near 61°. (Δaz is the azimuth, NOT
        // the on-sky distance — conflating them pushes the dog ~2× too far out.)
        const N_ICE = 1.31;
        const ne = Math.sqrt(Math.max(0, N_ICE * N_ICE - sinE * sinE)) / cosE;
        const arg = ne * 0.5;                          // nₑ·sin(30°)
        if (arg >= 1) return;                          // TIR: Sun too high, no dogs
        const delta = 2 * Math.asin(arg) - radians(60); // azimuth offset of the parhelion

        const base = baseBrightness * this.intensity;
        const tmp = new Vector3();
        // Azimuth where the 22° halo crosses the source's own altitude
        // (cos22 = sin²e + cos²e·cosΔ). The dog patch starts ~3° INSIDE this so
        // its faint sunward base overlaps the halo and the two blend into a
        // single pointed brightening — on the horizon the head lands right on
        // the halo; as the Sun rises the head detaches outward but still tapers
        // back toward the ring rather than floating as a separate blob.
        const cosHalo = (Math.cos(radians(22)) - sinE * sinE) / (cosE * cosE);
        const deltaHalo = cosHalo > 1 ? delta : Math.acos(MathUtils.clamp(cosHalo, -1, 1));
        const azStart = deltaHalo - radians(1.5);      // just inside the halo
        const azEnd = delta + radians(3.0);            // brief tail away from the Sun
        const azSpan = azEnd - azStart;
        const uHead = (delta - azStart) / azSpan;      // bright reddish head = the sundog
        for (const sign of [1, -1]) {
            this._buildBand(
                28, 28,
                (u, v) => {
                    const az = sign * (azStart + u * azSpan);
                    const el = e + (v - 0.5) * radians(8.5);    // taller than wide (sundogs elongate vertically)
                    return this._azElDir(az, el, tmp);
                },
                (u, v) => {
                    // Teardrop: a sharp reddish head on the sunward side falling
                    // smoothly into a long bluish tail away from the Sun. Pure
                    // Gaussian falloff (additive) — no hard window, so nothing
                    // "darkens"; brightness simply reaches the sky value at the
                    // edges and blends with the halo on the sunward side.
                    const du = u - uHead;
                    const sig = du < 0 ? 0.11 : 0.17;           // compact head, brief tail
                    const gu = Math.exp(-(du * du) / (sig * sig));
                    const dv = v - 0.5;
                    const gv = Math.exp(-(dv * dv) / (0.20 * 0.20));
                    // Red at/sunward of the head, grading to a white-blue tail.
                    const cIdx = MathUtils.clamp(du / (1 - uHead), 0, 1);
                    const c = evalStops(stops, cIdx);
                    const b = c[3] * base * gu * gv;
                    return [c[0] * b, c[1] * b, c[2] * b];
                }
            );
        }
    }

    // ---- Circumzenithal arc. --------------------------------------------
    // A circle centered on the zenith passing 46° above the Sun. Forms only
    // when the Sun is below ~32°; brightest near 22°. Red on the outer (sun-
    // ward) edge, violet toward the zenith.
    _buildCircumzenithalArc() {
        const elev = this._elevDeg;
        // Vividness: peaks at 22°, fades out above 32° and below the horizon.
        const vivid = MathUtils.smoothstep(elev, -3, 2)
            * (1 - MathUtils.smoothstep(elev, 30, 34));
        if (vivid <= 0.001) return;
        const peak = 1 - MathUtils.clamp(Math.abs(elev - 22) / 26, 0, 0.7);

        const rho0 = radians(44 - elev);
        const halfW = radians(1.2);   // real CZA is a thin band (~1.5° wide)
        const span = radians(46);
        // The CZA is vivid but it was over-bright relative to the halo/arcs;
        // bring its base into line with the 22° halo (0.55) rather than 1.0.
        const base = 0.5 * this.intensity * vivid * peak;
        const tmp = new Vector3();
        this._buildBand(
            160, 10,
            (u, v) => {
                const psi = (u - 0.5) * 2 * span;
                const rho = rho0 + (v - 0.5) * 2 * halfW;
                return this._zenithDir(rho, psi, tmp);
            },
            (u, v) => {
                // v = 0 toward zenith (violet), v = 1 toward Sun (red).
                const c = evalStops(SPECTRUM_STOPS, 1 - v);
                const b = base * bump(v) * bump(u);
                return [c[0] * b, c[1] * b, c[2] * b];
            }
        );
    }

    // ---- Circumhorizontal arc. ------------------------------------------
    // A band parallel to the horizon ~46° below the Sun. Forms only when the
    // Sun is above ~58°. Red on top (toward the Sun), violet on the bottom.
    _buildCircumhorizontalArc() {
        const elev = this._elevDeg;
        const vivid = MathUtils.smoothstep(elev, 55, 60);
        if (vivid <= 0.001) return;
        const peak = 1 - MathUtils.clamp(Math.abs(elev - 70) / 30, 0, 0.6);

        const rho0 = radians(136 - elev); // zenith distance of the arc center
        const halfW = radians(1.9);
        const span = radians(60);
        const base = 1.0 * this.intensity * vivid * peak;
        const tmp = new Vector3();
        this._buildBand(
            200, 10,
            (u, v) => {
                const psi = (u - 0.5) * 2 * span;
                const rho = rho0 + (v - 0.5) * 2 * halfW;
                return this._zenithDir(rho, psi, tmp);
            },
            (u, v) => {
                // v = 0 smaller rho (higher, toward Sun) = red; v = 1 = violet.
                const c = evalStops(SPECTRUM_STOPS, v);
                const b = base * bump(v) * bump(u);
                return [c[0] * b, c[1] * b, c[2] * b];
            }
        );
    }

    modSerialize() {
        return {...super.modSerialize()};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this._dirty = true;
    }

    dispose() {
        this._clearGroup(this.sunGroup);
        this._clearGroup(this.moonGroup);
        if (this._sunAttached && GlobalSunSkyScene !== undefined) {
            GlobalSunSkyScene.remove(this.sunGroup);
        }
        if (this._moonAttached && GlobalNightSkyScene !== undefined) {
            GlobalNightSkyScene.remove(this.moonGroup);
        }
        this.material?.dispose();
        super.dispose();
    }
}
