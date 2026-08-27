// CLunarEclipseCalc.js
//
// Lunar-eclipse geometry: where the Earth's umbra and penumbra fall, and how
// much sunlight survives at any point on the Moon.
//
// Design constraints, mirroring CEclipseCalc.js (its solar counterpart):
//
// - HARD NO-OP away from an eclipse. When the Moon is clear of the penumbra,
//   getLunarEclipseState() returns the shared frozen NO_LUNAR_ECLIPSE object
//   and consumers must change nothing about lighting or rendering.
//
// - EXACT parity with astronomy-engine's own shadow model. The library's
//   internal CalcShadow(), which SearchLunarEclipse() is built on, is
//
//       u = (dir.target)/(dir.dir)                  dir = Earth->antisun
//       r = |target - u*dir|                        perpendicular miss distance
//       k = Rsun - (1+u)(Rsun - Rshadow)            umbral radius at the target
//       p = -Rsun + (1+u)(Rsun + Rshadow)           penumbral radius
//
//   with Rshadow = EARTH_MEAN_RADIUS_KM + EARTH_ATMOSPHERE_KM, the geocentric
//   Moon from GeoMoon() (no aberration) and the Sun from GeoVector(Sun, t,
//   true) (aberration on). We reproduce that exactly, so our contact times
//   agree with the library's sd_penum / sd_partial / sd_total to the second.
//   That is the accuracy criterion the unit tests assert.
//
// - FEATHERED EDGES FOR FREE. From a point on the Moon, Earth is a disc of
//   angular radius asin(Rshadow/dE) and the Sun a disc of asin(Rsun/dS); the
//   surviving sunlight is the two-circle lens area already unit-tested as
//   sunDiskObscuration(), fed through the limb-darkened eclipseLightFraction().
//   The locus where those discs are internally tangent works out algebraically
//   to r = Re - z(Rsun-Re)/D - identically the cone radius k - so this is not
//   an approximation to the cone model, it IS the cone model, with the
//   penumbral gradient and the soft umbral edge included. No blur parameter.
//
//   (The separation must be measured between the true directions to the two
//   CENTRES. Measuring the Earth direction against the shadow AXIS instead is
//   wrong by z*Re/D, about 16 km at the Moon.)
//
// The light INSIDE the umbra - which is entirely refracted sunlight, and is
// what makes a "blood moon" - lives in atmosphere/umbralLight.js.

import * as Astronomy from "astronomy-engine";
import {Vector3} from "three";
import {sunDiskObscuration, eclipseLightFraction} from "./CEclipseCalc";
import {ATMOSPHERE_TOP_KM, buildUmbralProfile, UMBRA_ATMOSPHERE_DEFAULTS} from "./atmosphere/umbralLight";
import {assert} from "./assert";

// Radii, in km, matching astronomy-engine's internal constants exactly.
export const SUN_RADIUS_KM = 695700.0;
export const EARTH_MEAN_RADIUS_KM = 6371.0;
export const EARTH_ATMOSPHERE_KM = ATMOSPHERE_TOP_KM;   // 88.0
export const MOON_MEAN_RADIUS_KM = 1737.4;

const KM_PER_AU = Astronomy.KM_PER_AU;

// Shared result for "the Moon is nowhere near the shadow" - the hard no-op.
// Consumers should test `state.kind === "none"` and change nothing when it holds.
export const NO_LUNAR_ECLIPSE = Object.freeze({
    kind: "none",
    obscuration: 0,
    umbralMag: -Infinity,
    penumbralMag: -Infinity,
    rKm: Infinity,
    umbraKm: 0,
    penumbraKm: 0,
    alongKm: 0,
    u: 0,
    moonDistKm: 0,
    sunDistKm: 0,
    shadowRadiusKm: 0,
    axisEQJ: Object.freeze(new Vector3(0, 0, 1)),
    moonEQJ: Object.freeze(new Vector3()),
    sunEQJ: Object.freeze(new Vector3()),
});

/**
 * Umbral and penumbral radii at a point `u` of the way from the Earth to the
 * Sun's distance along the shadow axis. Exported for tests and for the
 * shadow-disc display.
 */
export function shadowRadiiKm(u, shadowRadiusKm) {
    return {
        umbraKm: SUN_RADIUS_KM - (1 + u) * (SUN_RADIUS_KM - shadowRadiusKm),
        penumbraKm: -SUN_RADIUS_KM + (1 + u) * (SUN_RADIUS_KM + shadowRadiusKm),
    };
}

/**
 * Fraction of DIRECT sunlight reaching a point, as a limb-darkened flux
 * fraction in [0,1]. This is the whole of the geometric shadow: 1 in full
 * sunlight, 0 anywhere inside the umbra, and a smooth gradient between.
 *
 * @param {Vector3} pointKm  position relative to the EARTH's centre, km, in
 *                           the same frame as sunEQJ
 * @param {Vector3} sunEQJ   the Sun's geocentric position, km
 * @param {number} shadowRadiusKm  Earth's opaque radius (surface + atmosphere)
 */
export function directSunlightAt(pointKm, sunEQJ, shadowRadiusKm) {
    const dE = pointKm.length();
    if (dE <= shadowRadiusKm) return 0;                 // inside the Earth
    // Direction to the Earth's centre, and to the Sun's centre.
    const ex = -pointKm.x / dE, ey = -pointKm.y / dE, ez = -pointKm.z / dE;
    let sx = sunEQJ.x - pointKm.x, sy = sunEQJ.y - pointKm.y, sz = sunEQJ.z - pointKm.z;
    const dS = Math.hypot(sx, sy, sz);
    sx /= dS; sy /= dS; sz /= dS;

    const rhoE = Math.asin(Math.min(1, shadowRadiusKm / dE));
    const rhoS = Math.asin(Math.min(1, SUN_RADIUS_KM / dS));

    // atan2 form: the two directions are nearly parallel during an eclipse, so
    // acos(dot) loses precision exactly where it matters.
    const dot = ex * sx + ey * sy + ez * sz;
    const cx = ey * sz - ez * sy, cy = ez * sx - ex * sz, cz = ex * sy - ey * sx;
    const sep = Math.atan2(Math.hypot(cx, cy, cz), dot);

    if (sep >= rhoE + rhoS) return 1;                   // Earth misses the Sun entirely
    return eclipseLightFraction(sunDiskObscuration(rhoS, rhoE, sep));
}

// Memo caches, keyed on time. During playback these hold one entry per frame
// touched; clearing on growth drops stale frames, like CEclipseCalc's.
const _geomCache = new Map();
const _stateCache = new Map();

/**
 * The Earth-Moon-Sun shadow geometry at a given time, WITHOUT the
 * is-there-an-eclipse gate. Always returns numbers, so contact times can be
 * bracketed by searching across the moment the eclipse begins.
 *
 * @param {Date|number} date
 * @param {object} [opts]
 * @param {number} [opts.atmosphereKm] Earth's atmospheric enlargement. 88 km is
 *        astronomy-engine's value and the default; the classical alternatives
 *        are Danjon's 1/85 of the radius (~75 km) and Chauvenet's 1/50 (~127 km).
 * @returns {object|null} null only if the ephemeris call itself failed.
 */
export function getShadowGeometry(date, opts = {}) {
    const t = (date && typeof date.getTime === "function") ? date.getTime() : date;
    if (!Number.isFinite(t)) return null;

    const atmosphereKm = opts.atmosphereKm ?? EARTH_ATMOSPHERE_KM;
    const key = `${t}|${atmosphereKm}`;
    const cached = _geomCache.get(key);
    if (cached !== undefined) return cached;

    let geom = null;
    try {
        const d = (date && typeof date.getTime === "function") ? date : new Date(t);
        // Same two calls, with the same aberration flags, that
        // astronomy-engine's own EarthShadow() makes.
        const s = Astronomy.GeoVector(Astronomy.Body.Sun, d, true);
        const m = Astronomy.GeoMoon(d);

        const sunEQJ = new Vector3(s.x, s.y, s.z).multiplyScalar(KM_PER_AU);
        const moonEQJ = new Vector3(m.x, m.y, m.z).multiplyScalar(KM_PER_AU);

        // The shadow axis: the path of sunlight through the Earth's centre.
        const dir = sunEQJ.clone().negate();
        const sunDistKm = sunEQJ.length();
        const u = moonEQJ.dot(dir) / dir.dot(dir);
        const alongKm = u * sunDistKm;

        // Perpendicular miss distance of the Moon's centre from the axis.
        const rKm = moonEQJ.clone().addScaledVector(dir, -u).length();

        const shadowRadiusKm = EARTH_MEAN_RADIUS_KM + atmosphereKm;
        const {umbraKm, penumbraKm} = shadowRadiiKm(u, shadowRadiusKm);

        geom = {
            rKm, umbraKm, penumbraKm, alongKm, u, shadowRadiusKm,
            moonDistKm: moonEQJ.length(),
            sunDistKm,
            axisEQJ: dir.clone().normalize(),
            moonEQJ,
            sunEQJ,
        };
    } catch {
        geom = null;
    }

    if (_geomCache.size > 512) _geomCache.clear();
    _geomCache.set(key, geom);
    return geom;
}

/**
 * Lunar-eclipse circumstances at a given time. Geocentric: unlike a solar
 * eclipse, where the Moon sits between the observer and the Sun, this geometry
 * is a fact about the Earth-Moon-Sun triangle and does not depend on where on
 * Earth you are standing.
 *
 * Returns the shared frozen NO_LUNAR_ECLIPSE when the Moon is clear of the
 * penumbra - the hard no-op.
 *
 * @param {Date|number} date
 * @param {object} [opts] see getShadowGeometry
 */
export function getLunarEclipseState(date, opts = {}) {
    const t = (date && typeof date.getTime === "function") ? date.getTime() : date;
    // Same contract as getEclipseState: defaulting an undefined date belongs to
    // the caller, and letting it through here would silently produce
    // "no eclipse" for every frame.
    assert(Number.isFinite(t), "getLunarEclipseState: non-finite time — caller must default the date before calling");
    if (!Number.isFinite(t)) return NO_LUNAR_ECLIPSE;

    const atmosphereKm = opts.atmosphereKm ?? EARTH_ATMOSPHERE_KM;
    const key = `${t}|${atmosphereKm}`;
    const cached = _stateCache.get(key);
    if (cached !== undefined) return cached;

    let state = NO_LUNAR_ECLIPSE;
    const g = getShadowGeometry(date, opts);
    if (g && g.rKm < g.penumbraKm + MOON_MEAN_RADIUS_KM) {
        // Standard eclipse magnitudes: how far the Moon's diameter has entered
        // each shadow, in units of that diameter. Negative until first contact,
        // 1 at the moment of complete immersion.
        const penumbralMag = (g.penumbraKm + MOON_MEAN_RADIUS_KM - g.rKm) / (2 * MOON_MEAN_RADIUS_KM);
        const umbralMag = (g.umbraKm + MOON_MEAN_RADIUS_KM - g.rKm) / (2 * MOON_MEAN_RADIUS_KM);

        let kind = "penumbral";
        let obscuration = 0;
        if (g.rKm < g.umbraKm + MOON_MEAN_RADIUS_KM) {
            kind = "partial";
            if (g.rKm + MOON_MEAN_RADIUS_KM < g.umbraKm) {
                kind = "total";
                obscuration = 1;
            } else {
                // Fraction of the Moon's disc area inside the umbra.
                obscuration = sunDiskObscuration(MOON_MEAN_RADIUS_KM, g.umbraKm, g.rKm);
            }
        }
        state = {...g, kind, obscuration, umbralMag, penumbralMag};
    }

    if (_stateCache.size > 256) _stateCache.clear();
    _stateCache.set(key, state);
    return state;
}

// ---------------------------------------------------------------------------
// Umbral radiance profile, cached
// ---------------------------------------------------------------------------

// The profile depends on the Moon's distance and on the atmosphere settings,
// and costs ~25 ms to build. The Moon's distance moves by well under 0.1% over
// a whole eclipse, so a rebuild is only warranted when it moves further than
// that (or when the user changes an atmosphere control).
const DIST_REBUILD_TOLERANCE = 1e-3;

let _profileCache = null;

/**
 * The refracted-light (blood-moon) radial profile for this eclipse, rebuilt
 * only when the geometry or the atmosphere has meaningfully changed.
 *
 * @returns {{rMaxKm:number, rgb:Float32Array, peak:number, meanUmbra:number}}
 */
export function getUmbralProfile(state, atmo = UMBRA_ATMOSPHERE_DEFAULTS, samples = 256) {
    // The refracted-light integration must stop exactly where the geometric
    // shadow's blocking disc starts, or the band between the two is double
    // counted. state.shadowRadiusKm carries the enlargement actually in use.
    const topKm = state.shadowRadiusKm - EARTH_MEAN_RADIUS_KM;
    const atmoKey = `${atmo.ozoneDU}|${atmo.stratAerosolTau}|${atmo.tropAerosolTau}|${atmo.angstromExponent}|${atmo.cloudiness}|${samples}|${topKm}`;
    const c = _profileCache;
    if (c && c.atmoKey === atmoKey
        && Math.abs(c.moonDistKm - state.moonDistKm) / state.moonDistKm < DIST_REBUILD_TOLERANCE
        && Math.abs(c.penumbraKm - state.penumbraKm) / state.penumbraKm < DIST_REBUILD_TOLERANCE) {
        return c.profile;
    }
    const profile = buildUmbralProfile({
        moonDistKm: state.alongKm,
        sunDistKm: state.sunDistKm,
        sunRadiusKm: SUN_RADIUS_KM,
        penumbraKm: state.penumbraKm,
        umbraKm: state.umbraKm,
        topKm,
        atmo,
        samples,
    });
    _profileCache = {
        atmoKey,
        moonDistKm: state.moonDistKm,
        penumbraKm: state.penumbraKm,
        profile,
    };
    return profile;
}

/** Sample the umbral profile at a radius, in linear sRGB. */
export function sampleUmbralProfile(profile, rKm, out = [0, 0, 0]) {
    const n = profile.rgb.length / 3;
    const x = rKm / profile.rMaxKm * (n - 1);
    if (!(x > 0)) { out[0] = profile.rgb[0]; out[1] = profile.rgb[1]; out[2] = profile.rgb[2]; return out; }
    if (x >= n - 1) { out[0] = out[1] = out[2] = 0; return out; }
    const i = x | 0, f = x - i;
    for (let c = 0; c < 3; c++) {
        out[c] = profile.rgb[i * 3 + c] * (1 - f) + profile.rgb[(i + 1) * 3 + c] * f;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Disc-averaged illumination
// ---------------------------------------------------------------------------

const _pt = new Vector3();
const _rgb = [0, 0, 0];

/**
 * Mean illumination over the Moon's Earth-facing disc, as a fraction of
 * unattenuated sunlight, counting BOTH the direct term and the refracted
 * (umbral) term. 1.0 is an uneclipsed full Moon.
 *
 * Used for the scene lighting in Moonlight mode and for the magnitude readout.
 * The disc is sampled on a polar grid over the projected face; area weighting
 * is uniform, which is right to a few per cent for a full Moon (the opposition
 * surge makes the visible disc close to uniformly bright).
 *
 * @param {object} state    from getLunarEclipseState
 * @param {object} [profile] from getUmbralProfile; omit to count direct light only
 * @param {number} [rings=16]
 * @param {number} [spokes=24]
 */
export function lunarDiskIllumination(state, profile = null, rings = 16, spokes = 24) {
    if (state.kind === "none") return 1;

    // Basis for the Moon's projected disc: perpendicular to the Earth-Moon
    // line, which is what we see from here.
    const n = state.moonEQJ.clone().normalize();
    const a = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    const e1 = new Vector3().crossVectors(n, a).normalize();
    const e2 = new Vector3().crossVectors(n, e1).normalize();

    let sum = 0, wSum = 0;
    for (let i = 0; i < rings; i++) {
        // Equal-area radial sampling of the disc.
        const frac = Math.sqrt((i + 0.5) / rings);
        const rad = frac * MOON_MEAN_RADIUS_KM;
        // Bulge toward the observer, so limb points sit at their true 3-D place.
        const bulge = Math.sqrt(Math.max(0, MOON_MEAN_RADIUS_KM * MOON_MEAN_RADIUS_KM - rad * rad));
        for (let j = 0; j < spokes; j++) {
            const th = 2 * Math.PI * (j + 0.5) / spokes;
            _pt.copy(state.moonEQJ)
                .addScaledVector(e1, rad * Math.cos(th))
                .addScaledVector(e2, rad * Math.sin(th))
                .addScaledVector(n, -bulge);

            let lum = directSunlightAt(_pt, state.sunEQJ, state.shadowRadiusKm);
            if (profile) {
                // Perpendicular distance of this surface point from the axis.
                const along = _pt.dot(state.axisEQJ);
                const px = _pt.x - state.axisEQJ.x * along;
                const py = _pt.y - state.axisEQJ.y * along;
                const pz = _pt.z - state.axisEQJ.z * along;
                sampleUmbralProfile(profile, Math.hypot(px, py, pz), _rgb);
                lum += 0.2126 * _rgb[0] + 0.7152 * _rgb[1] + 0.0722 * _rgb[2];
            }
            sum += lum;
            wSum++;
        }
    }
    return wSum > 0 ? sum / wSum : 1;
}

// ---------------------------------------------------------------------------
// Render parameters shared with the Moon shader
// ---------------------------------------------------------------------------

/**
 * What the Moon's fragment shader needs to draw the eclipse this frame.
 *
 * This is MODULE state, published by CNodeLunarEclipse and consumed by
 * CPlanets.updateMoonMesh - the same arrangement CEclipseCalc uses for the
 * solar-eclipse lighting switch, and for the same reason: the renderer should
 * not have to know that a GUI node exists.
 *
 * `active: false` is the hard no-op for the RENDER path. CPlanets must leave
 * every eclipse uniform alone (and the master uniform at 0) while it holds.
 *
 * `enabled` and `atmo` are deliberately SEPARATE from `active`, and are
 * published as soon as they change rather than during the per-frame sync.
 * `active` answers "has this frame's state been synced yet", which is a fact
 * about ordering; consumers that run BEFORE the sync - the lighting path does -
 * must not read it as "is there an eclipse", or the first frame after a jump
 * into an eclipse is lit as though there were none. That frame is invisible
 * when scrubbing and decisive when exporting a single image.
 */
export const lunarEclipseRender = {
    /** GUI master for the eclipse shading. Independent of the per-frame sync. */
    enabled: true,
    /** atmosphere parameters in force, with stable identity for cache keys */
    atmo: UMBRA_ATMOSPHERE_DEFAULTS,
    /** true only once this frame's state has been synced for rendering */
    active: false,
    state: NO_LUNAR_ECLIPSE,
    /** the umbral radiance profile behind lutTexture, for CPU-side queries */
    profile: null,
    /** DataTexture, 256x1, sqrt-encoded linear sRGB (see CNodeLunarEclipse) */
    lutTexture: null,
    /** multiply the SQUARED texel by this to recover physical irradiance */
    lutGain: 1,
    /** radius, km, that maps to texture coordinate 1 */
    lutScaleKm: 1,
    /** linear gain on the total illumination, before the soft shoulder */
    exposure: 1,
    /** 1 = physical colour, 0 = desaturated to luminance */
    bloodMoon: 1,
};

// Small cache, so the lighting path can ask every frame (and every view)
// without repeating the 384-sample disc integration.
let _dimCache = {key: null, atmo: null, value: 1};

/**
 * How much a lunar eclipse dims the Moon at the given time, as a factor on its
 * uneclipsed brightness. Exactly 1 - and free - whenever the shading is off or
 * there is no eclipse, which is the hard no-op the lighting path depends on.
 *
 * Reads the published render state rather than taking a dependency on the GUI
 * node, the same arrangement CEclipseCalc uses for solar-eclipse lighting.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. It derives everything from `date` and
 * from settings that are published outside the per-frame sync, and never from
 * `r.state`/`r.profile`, which belong to whichever frame last synced. The
 * lighting node updates before this one, so reading those would mean the first
 * frame after a jump into an eclipse is lit by an uneclipsed full Moon - about
 * ten magnitudes too bright, and the whole image when exporting one frame.
 */
export function lunarEclipseDimming(date) {
    const r = lunarEclipseRender;
    if (!r.enabled) return 1;
    const t = (date && typeof date.getTime === "function") ? date.getTime() : date;
    if (!Number.isFinite(t)) return 1;

    // The overwhelmingly common case, and it costs one memoised ephemeris call.
    const state = getLunarEclipseState(date);
    if (state.kind === "none") return 1;

    if (_dimCache.key === t && _dimCache.atmo === r.atmo) return _dimCache.value;
    const value = lunarDiskIllumination(state, getUmbralProfile(state, r.atmo));
    _dimCache = {key: t, atmo: r.atmo, value};
    return value;
}

/**
 * The Danjon L value implied by a disc-mean illumination during totality.
 * Danjon's scale is a visual one (0 = almost invisible, 4 = bright coppery
 * orange), so this is a calibration against the magnitudes those descriptions
 * correspond to, not a measured quantity - it is a readout, not an input.
 */
export function danjonFromIllumination(meanIllumination) {
    if (!(meanIllumination > 0)) return 0;
    // Visual magnitude of the eclipsed Moon, from the -12.74 of a full Moon.
    const mag = -12.74 - 2.5 * Math.log10(meanIllumination);
    // L4 ~ -3, L3 ~ -1.5, L2 ~ 0, L1 ~ +2, L0 ~ +4 and fainter.
    const L = 4 - (mag + 3) / 1.6;
    return Math.min(4, Math.max(0, L));
}
