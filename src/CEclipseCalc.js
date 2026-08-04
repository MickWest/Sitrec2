// CEclipseCalc.js
//
// Solar-eclipse circumstances for an arbitrary observer position and time:
// how much of the Sun's disk the Moon covers (obscuration), and how much
// photospheric light remains (a limb-darkened flux fraction, which falls
// faster than plain area near totality).
//
// Design constraints:
// - HARD NO-OP away from an eclipse: when the Moon's disk does not overlap
//   the Sun's at all, getEclipseState() returns the shared frozen NO_ECLIPSE
//   object (obscuration 0, lightFraction 1) and consumers must change
//   nothing about lighting or rendering.
// - Frame/flag consistency with the renderer: the same astronomy-engine call
//   CPlanets uses (Astronomy.Equator(body, date, observer, ofdate=false,
//   aberration=true), topocentric) and the same physical radii, so the
//   lighting curve and the rendered contact geometry agree about when the
//   limbs touch.
// - Cheap per frame: results are memoized on (time, ~1km-quantized position),
//   mirroring getCelestialDirection's cache, because CNodeSunlight probes
//   sky brightness several times per frame per view.
//
// Refraction note: atmospheric refraction is deliberately ignored here. Both
// bodies sit within a solar diameter of each other during an eclipse, so
// differential refraction between their centers is at most a few arcseconds
// even at low altitude — far below the ~1% obscuration resolution that
// matters for lighting.

import * as Astronomy from "astronomy-engine";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {Sit} from "./Globals";
import {assert} from "./assert";

// Match CPlanets' physical radii so the lighting math and the rendered disks
// agree about the instant of contact. 695,700 km is the IAU nominal solar
// radius, and the value astronomy-engine's own eclipse machinery uses —
// with the old 696,000 km the geometric contact times ran ~0.7 s off the
// library's eclipse solution and totality came out ~1.3 s short.
export const SUN_RADIUS_M = 695700000;
export const MOON_RADIUS_M = 1737400;

// Shared result for "no overlap at all" — the hard no-op case. Consumers
// should test `state.obscuration === 0` and change nothing when it holds.
// exposedFrac is pinned at its geometric maximum (2 = first contact is a full
// Sun diameter away or more) so visual gates smoothly evaluate to zero.
export const NO_ECLIPSE = Object.freeze({
    obscuration: 0,
    lightFraction: 1,
    exposedFrac: 2,
    separation: Infinity,
    sunRad: 0,
    moonRad: 0,
    ratio: 0,
});

// Master switch for the lighting-side effect (scene light / sky brightness
// attenuation). The visuals node exposes it in the GUI; kept here as module
// state so CNodeSunlight does not need a dependency on the visuals node.
let _lightingEnabled = true;
export function setEclipseLightingEnabled(enabled) {
    _lightingEnabled = !!enabled;
}
export function isEclipseLightingEnabled() {
    return _lightingEnabled;
}

function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function smoothstep01(x) {
    x = clamp01(x);
    return x * x * (3 - 2 * x);
}

// Shared zero-gate result (also the hard no-op case for the visuals).
export const NO_GATES = Object.freeze({corona: 0, beads: 0, diamond: 0});

// Visual gates for the eclipse effects, from the eclipse state. Pure math —
// kept here (not in the render node) so the annular/total distinction is
// unit-testable against real ephemeris events.
//
// TOTAL-capable geometry (topocentric ratio > 1):
//   corona/prominences emerge as the last ~3.5% photosphere sliver vanishes,
//   Baily's beads and the diamond ring live around second/third contact
//   (exposedFrac ≈ 0), and both die once the Moon's limb is deeper inside
//   the Sun than the tallest limb-roughness bump (±0.45%).
// ANNULAR geometry (ratio <= 1): the photosphere ring stays blinding, so NO
//   corona, prominences, or diamond ring — ever. Beads still occur, but at
//   the INTERNAL contacts where the Moon's limb is tangent to the Sun's from
//   inside: annularGap = 2*(1 - ratio) - exposedFrac is 0 at those moments
//   and grows toward maximum annularity, where beads must be OFF (the 2023
//   Albuquerque annular has annularGap ≈ 0.046 at peak — far outside the
//   ±0.006 window).
export function eclipseVisualGates(state) {
    if (!state || !(state.obscuration > 0)) return NO_GATES;
    const ex = state.exposedFrac;
    if (state.ratio > 1) {
        const corona = 1 - smoothstep01(ex / 0.035);
        const contactT = smoothstep01((ex + 0.0045) / 0.003);
        const beads = (1 - smoothstep01((ex - 0.03) / 0.06)) * contactT;
        const diamond = Math.exp(-Math.pow((ex - 0.015) / 0.012, 2)) * contactT;
        if (corona === 0 && beads === 0 && diamond === 0) return NO_GATES;
        return {corona, beads, diamond};
    }
    const annularGap = 2 * (1 - state.ratio) - ex;
    const beads = Math.exp(-Math.pow(annularGap / 0.006, 2));
    if (beads < 1e-4) return NO_GATES;
    return {corona: 0, beads, diamond: 0};
}

// Fraction of the Sun's disk AREA covered by the Moon, from angular radii
// rs, rm and center separation d (all radians, or any consistent unit —
// the formula is planar, which at eclipse scales (~0.005 rad) matches the
// spherical result to better than 1e-5).
export function sunDiskObscuration(rs, rm, d) {
    if (!(rs > 0) || !(rm > 0)) return 0;
    if (d >= rs + rm) return 0;                     // no overlap
    if (d <= Math.abs(rm - rs)) {
        // One disk entirely inside the other: total (or annular) phase.
        return rm >= rs ? 1 : (rm * rm) / (rs * rs);
    }
    // Standard two-circle lens area.
    const rs2 = rs * rs;
    const rm2 = rm * rm;
    const d2 = d * d;
    const a1 = Math.acos(Math.min(1, Math.max(-1, (d2 + rs2 - rm2) / (2 * d * rs))));
    const a2 = Math.acos(Math.min(1, Math.max(-1, (d2 + rm2 - rs2) / (2 * d * rm))));
    const tri = 0.5 * Math.sqrt(Math.max(0,
        (-d + rs + rm) * (d + rs - rm) * (d - rs + rm) * (d + rs + rm)));
    const lens = rs2 * a1 + rm2 * a2 - tri;
    return clamp01(lens / (Math.PI * rs2));
}

// Remaining photospheric FLUX as a function of area obscuration, with a
// limb-darkening correction. The Moon covers limb first and uncovers limb
// last, and the limb is only ~40% as bright as disk center (linear limb
// darkening u≈0.6 in V), so flux falls SLOWER than area at the start and
// FASTER than area near totality. This closed form has slope -0.5 at both
// ends and -1.5 mid-eclipse (disk-center coverage), integrating to exactly
// F(0)=1, F(1)=0, and is smooth and monotonic throughout.
export function eclipseLightFraction(obscuration) {
    const O = clamp01(obscuration);
    return clamp01(1 - O + Math.sin(2 * Math.PI * O) / (4 * Math.PI));
}

// Memo cache, keyed on (time, ~1km-quantized position) like the
// getCelestialDirection cache. Within a frame it holds at most a few entries
// (one per distinct camera position); clearing on growth drops stale frames.
const _stateCache = new Map();

// Eclipse circumstances at a world (ECEF-frame) position and time.
// Returns NO_ECLIPSE (frozen, obscuration 0) whenever the disks do not
// overlap; otherwise:
//   obscuration   fraction of the Sun's disk area covered      (0..1]
//   lightFraction limb-darkened remaining photospheric flux    [0..1)
//   exposedFrac   (separation + sunRad - moonRad) / sunRad — the width of the
//                 exposed photosphere sliver in Sun radii along the center
//                 line. 0 at second/third contact, negative during totality,
//                 rising toward 2 at first/fourth contact. The visual gates
//                 (corona, Baily's beads, diamond ring) key off this.
//   separation    Sun-Moon center separation (radians)
//   sunRad/moonRad topocentric angular radii (radians)
//   ratio         moonRad / sunRad (>1 → total, <1 → annular)
export function getEclipseState(position, date) {
    const t = (date && typeof date.getTime === "function") ? date.getTime() : date;
    // A non-finite time here is a CALLER bug: the "undefined date means
    // current sim time" convention belongs to the CNodeSunlight entry points
    // (calculateEclipseLightFactor defaults it), and letting undefined leak
    // through is exactly how the sky-stayed-bright-through-totality bug hid
    // (astronomy-engine threw, the catch returned NO_ECLIPSE, silently).
    // Trip loudly in dev; asserts are stripped in production, so the guarded
    // return below still degrades safely there.
    assert(Number.isFinite(t), "getEclipseState: non-finite time — caller must default the date (dateNow) before calling");
    if (!Number.isFinite(t)) return NO_ECLIPSE;
    // Position must be on/above Earth's surface to derive an observer from it
    // (same guard as getCelestialDirection); otherwise fall back to Sit origin.
    const positioned = (position !== undefined && position.lengthSq() > 1e12);
    const qx = positioned ? Math.round(position.x / 1000) : 0;
    const qy = positioned ? Math.round(position.y / 1000) : 0;
    const qz = positioned ? Math.round(position.z / 1000) : 0;
    const key = `${t}|${qx}|${qy}|${qz}`;
    const cached = _stateCache.get(key);
    if (cached !== undefined) return cached;

    let state = NO_ECLIPSE;
    try {
        let lat, lon, alt;
        if (positioned) {
            const LLA = ECEFToLLAVD_radii(position);
            lat = LLA.x; lon = LLA.y; alt = LLA.z;
        } else {
            lat = Sit.lat; lon = Sit.lon; alt = 0;
        }
        const observer = new Astronomy.Observer(lat, lon, alt);

        // Topocentric apparent places, same flags as the rendered disks
        // (CPlanets.updatePlanetSprite / updateMoonMesh).
        const sunEq = Astronomy.Equator("Sun", date, observer, false, true);
        const moonEq = Astronomy.Equator("Moon", date, observer, false, true);

        const sv = sunEq.vec, mv = moonEq.vec;
        const sd = Math.hypot(sv.x, sv.y, sv.z);
        const md = Math.hypot(mv.x, mv.y, mv.z);
        const dot = (sv.x * mv.x + sv.y * mv.y + sv.z * mv.z) / (sd * md);
        const cx = sv.y * mv.z - sv.z * mv.y;
        const cy = sv.z * mv.x - sv.x * mv.z;
        const cz = sv.x * mv.y - sv.y * mv.x;
        const cross = Math.hypot(cx, cy, cz) / (sd * md);
        // atan2 form is robust where acos loses precision (dot ≈ 1).
        const separation = Math.atan2(cross, dot);

        const metersPerAU = Astronomy.KM_PER_AU * 1000;
        const sunRad = Math.asin(SUN_RADIUS_M / (sd * metersPerAU));
        const moonRad = Math.asin(MOON_RADIUS_M / (md * metersPerAU));

        if (separation < sunRad + moonRad) {
            const obscuration = sunDiskObscuration(sunRad, moonRad, separation);
            if (obscuration > 0) {
                state = {
                    obscuration,
                    lightFraction: eclipseLightFraction(obscuration),
                    exposedFrac: (separation + sunRad - moonRad) / sunRad,
                    separation,
                    sunRad,
                    moonRad,
                    ratio: moonRad / sunRad,
                };
            }
        }
    } catch {
        state = NO_ECLIPSE;
    }

    if (_stateCache.size > 128) _stateCache.clear();
    _stateCache.set(key, state);
    return state;
}
