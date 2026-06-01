// flarePhysics.js — the CANONICAL Starlink flare brightness model, shared by:
//   * the live Sitrec night sky  (src/nodes/CNodeDisplayNightSky.js), and
//   * the standalone SHF tool      (tools/shf/flareEngine.js + app.js).
//
// Both used to inline the same cone ramp, penumbra fade, and magic numbers; keeping them
// here means the prediction tool can't drift from what Sitrec actually renders. It lives
// under tools/shf/ (served as a raw ES module so SHF can import it); bundled Sitrec imports
// it via a relative path. Pure functions + constants only — no dependencies, no Three.js,
// no import.meta tricks — so it bundles cleanly AND loads standalone.
//
// Vectors are plain { x, y, z }. Distances must be in CONSISTENT units within a call
// (Sitrec works in metres; SHF converts its km to metres before calling the shadow helper,
// so the canonical penumbraDepth below — metres — applies to both).

// Defaults mirror src: CSatellite (flareAngle 5°, penumbraDepth 5000 m) and CSituation
// (flareScale 0.2, satCutOff 0.06). These are the GUI-adjustable defaults; callers pass
// their live value where one exists. base/darknessMult are the fixed inline constants from
// CNodeDisplayNightSky.updateSatelliteBrightness.
export const FLARE = {
    angleDeg: 5,          // flare cone half-angle: glint < this => flaring
    rampFraction: 0.25,   // outer falloff band width = angleDeg * this
    scale: 0.2,           // Sit.flareScale — glint brightness multiplier
    base: 0.04,           // brightness of a lit (un-flaring) satellite
    darknessMult: 0.3,    // base multiplier for a fully-shadowed satellite
    penumbraDepthM: 5000, // chord-depth (m) over which lit -> shadow fades
    satCutOff: 0.06,      // Sit.satCutOff; brightness below satCutOff/5 renders as nothing
};
export const VISIBLE_CUTOFF = FLARE.satCutOff / 5;   // 0.012 — a satellite dimmer than this is not drawn

// Glint cone ramp (0..1): full (1) inside the core, falling off as a square to 0 at the
// cone edge. EXACTLY the factor used in CNodeDisplayNightSky (lines ~1144-1151) and the
// SHF makeFlare intensity. glintDeg = angle between the panel-reflected view ray and the Sun.
export function flareRamp(glintDeg, spreadDeg = FLARE.angleDeg) {
    if (glintDeg >= spreadDeg) return 0;
    const ramp = spreadDeg * FLARE.rampFraction;
    const middle = spreadDeg - ramp;
    if (glintDeg < middle) return 1;
    const r = ramp - (glintDeg - middle);
    return (r * r) / (ramp * ramp);
}

// Glint angle (deg) below which the flare is at FULL brightness (the flat "core" where
// flareRamp == 1). A flare whose glint dips below this holds at peak brightness for a
// while — the plateau of the ramp-hold-ramp profile. Above it, flareRamp falls off.
export function flareCoreAngle(spreadDeg = FLARE.angleDeg) {
    return spreadDeg * (1 - FLARE.rampFraction);
}

// Penumbra fade (0..1) from how deep the Sun-ray's shadow chord sits below the surface.
//   occludedDist <= 0  -> ray misses Earth, fully lit (1)
//   0 < occludedDist < depth -> partial (1 - occludedDist/depth)
//   occludedDist >= depth   -> full shadow (0)
// Matches CNodeDisplayNightSky lines ~1113-1118 (which only runs the partial/full branch,
// as its caller has already confirmed a shadow intersection => occludedDist > 0).
export function penumbraFade(occludedDist, depth = FLARE.penumbraDepthM) {
    if (occludedDist <= 0) return 1;
    if (occludedDist >= depth) return 0;
    return 1 - occludedDist / depth;
}

// Depth (same units as inputs) by which a satellite at `pos` is occluded by the spherical
// shadow of radius `radius` (centred at the origin) looking toward unit `sunDir`. Returns
// the chord-midpoint depth below the sphere surface, or -1 if the forward Sun-ray misses
// the sphere (satellite is lit). Mirrors Sitrec's intersectSphere2 + midpoint depth, but as
// plain math so SHF (which has no Three.js) can compute the same fade Sitrec does.
export function shadowOcclusion(pos, sunDir, radius) {
    const b = pos.x * sunDir.x + pos.y * sunDir.y + pos.z * sunDir.z;   // sunDir is unit
    const c = pos.x * pos.x + pos.y * pos.y + pos.z * pos.z - radius * radius;
    const disc = b * b - c;
    if (disc <= 0) return -1;                  // misses the sphere -> lit
    const sq = Math.sqrt(disc);
    const t1 = -b - sq, t2 = -b + sq;
    if (t2 <= 0) return -1;                     // sphere is behind the satellite -> lit
    const tm = (t1 + t2) / 2;                   // chord midpoint along the ray
    const mx = pos.x + tm * sunDir.x, my = pos.y + tm * sunDir.y, mz = pos.z + tm * sunDir.z;
    return radius - Math.sqrt(mx * mx + my * my + mz * mz);
}

// Total brightness of a satellite, reproducing CNodeDisplayNightSky.updateSatelliteBrightness:
// a faded base, plus the glint contribution when flaring & above the horizon, then the
// satCutOff floor. fade = penumbraFade(...); glintDeg only matters when aboveHorizon.
export function satBrightness({ fade, glintDeg, aboveHorizon, spreadDeg = FLARE.angleDeg, flareScale = FLARE.scale }) {
    let b = FLARE.base;
    if (fade <= 0) b *= FLARE.darknessMult;
    else if (fade < 1) b *= FLARE.darknessMult + (1 - FLARE.darknessMult) * fade;
    if (aboveHorizon && fade > 0 && glintDeg < spreadDeg) {
        b += fade * flareScale * flareRamp(glintDeg, spreadDeg);
    }
    return b < VISIBLE_CUTOFF ? 0 : b;
}

// The glint's added brightness alone (no base) — fade · flareScale · ramp.
export function flareContribution(fade, glintDeg, spreadDeg = FLARE.angleDeg, flareScale = FLARE.scale) {
    return fade > 0 && glintDeg < spreadDeg ? fade * flareScale * flareRamp(glintDeg, spreadDeg) : 0;
}

// Will a flare actually be SEEN? In Sitrec every lit satellite is already a faint base dot
// (brightness FLARE.base); a flare is only noticeable when its glint contribution makes the
// satellite meaningfully brighter than that baseline. We call it visible when the glint adds
// at least `contrast` × the base brightness (default 1 => the satellite at least doubles in
// brightness). This is the single, shared definition of "a visible flare".
export function isFlareVisible(fade, glintDeg, spreadDeg = FLARE.angleDeg, flareScale = FLARE.scale, contrast = 1) {
    return flareContribution(fade, glintDeg, spreadDeg, flareScale) >= contrast * FLARE.base;
}
