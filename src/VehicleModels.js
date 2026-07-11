// VehicleModels.js — curated performance envelopes for the LOS physics-fit
// model catalogs (Quadcopter and Fixed-Wing "make/model" dropdowns).
//
// These are APPROXIMATE published maxima, used only to BOUND the fit's
// parameter search and to classify a solved trajectory against the nearest
// common airframe. They are deliberately NOT exact/classified figures — a fit
// bound just needs to bracket the physically possible, and several of these
// numbers (fighter climb rates, min flying speeds) are estimates or approach
// speeds. All speeds/rates are m/s, altitudes are meters (HAE).
//
// Kept dependency-free (no three.js / node graph) so it stays unit-testable
// and can be imported by both the physics models and the analysis gallery.
//
// Sources (accessed 2026-07): DJI product spec pages (dji.com); Wikipedia +
// USAF/USN fact sheets + militaryfactory.com for the fixed-wing figures;
// Cessna 172S POH and Boeing 737-800 performance tables.

const KT = 0.514444;          // knots -> m/s
const FPM = 0.00508;          // feet/min -> m/s
const FT = 0.3048;            // feet -> m

// ---------------------------------------------------------------------------
// Quadcopter (multirotor) catalog.
//
// A multirotor is hover-capable (min ground speed 0). The discriminating
// envelope is its max horizontal speed and its max ascent/descent rate — a
// solution demanding more than a given drone can do simply is not that drone.
//   maxSpeed   - max horizontal speed (sport mode), m/s
//   maxAscent  - max climb rate, m/s
//   maxDescent - max descent rate, m/s
//   ceiling    - practical max operating altitude AGL, m (soft; regulatory/RF)
// ---------------------------------------------------------------------------
export const QUADCOPTER_MODELS = [
    // Auto = the generic multirotor envelope: covers everything from a slow
    // camera drone to a fast FPV racer. The fit runs against THIS when the
    // dropdown is AUTO, then classifyQuadcopter() names the nearest real model.
    {id: "auto",   name: "Auto (any multirotor)", auto: true, maxSpeed: 60, maxAscent: 30, maxDescent: 30, ceiling: 6000},
    {id: "mini4",  name: "DJI Mini 4 Pro",     maxSpeed: 16, maxAscent: 5,  maxDescent: 5,  ceiling: 4000},
    {id: "air3",   name: "DJI Air 3",          maxSpeed: 21, maxAscent: 10, maxDescent: 10, ceiling: 6000},
    {id: "mavic3", name: "DJI Mavic 3",        maxSpeed: 21, maxAscent: 8,  maxDescent: 6,  ceiling: 6000},
    {id: "p4p",    name: "DJI Phantom 4 Pro",  maxSpeed: 20, maxAscent: 6,  maxDescent: 4,  ceiling: 6000},
    {id: "djifpv", name: "DJI FPV",            maxSpeed: 39, maxAscent: 15, maxDescent: 10, ceiling: 6000},
    {id: "racer",  name: "Racing FPV",         maxSpeed: 55, maxAscent: 30, maxDescent: 30, ceiling: 6000},
];

// ---------------------------------------------------------------------------
// Fixed-wing catalog.
//
//   tasMin   - minimum sustainable TAS (~stall / approach speed), m/s
//   tasMax   - maximum level TAS (Vne for GA, ~max-Mach TAS at altitude for jets), m/s
//   cruise   - typical cruise TAS, m/s (used to pick the nearest model)
//   climbMax - maximum |vertical speed|, m/s
//   gMax     - structural / sustained turn g limit (plausibility only)
//   ceiling  - service ceiling, m (HAE)
// ---------------------------------------------------------------------------
export const FIXED_WING_MODELS = [
    // Auto = the generic conventional-flight prior used before catalogs
    // (25..360 m/s horizontal speed). It is not the union of every fighter
    // envelope below; AUTO preserves prior behavior.
    {id: "auto",  name: "Auto (generic conventional prior)", auto: true, tasMin: 25, tasMax: 360, cruise: 195, climbMax: 40,  gMax: 9,   ceiling: 20000},
    {id: "c172",  name: "Cessna 172",            tasMin: 25, tasMax: 84,  cruise: 64,  climbMax: 4,   gMax: 3.8, ceiling: 4267},
    {id: "mq9",   name: "MQ-9 Reaper",           tasMin: 28, tasMax: 123, cruise: 92,  climbMax: 8,   gMax: 2.5, ceiling: 15240},
    {id: "b737",  name: "Boeing 737-800",        tasMin: 60, tasMax: 257, cruise: 230, climbMax: 13,  gMax: 2.5, ceiling: 12500},
    {id: "fa18",  name: "F/A-18E/F Super Hornet",tasMin: 62, tasMax: 530, cruise: 235, climbMax: 228, gMax: 7.5, ceiling: 15000},
    {id: "f35",   name: "F-35 Lightning II",     tasMin: 67, tasMax: 500, cruise: 235, climbMax: 230, gMax: 9,   ceiling: 15000},
    {id: "f16",   name: "F-16 Fighting Falcon",  tasMin: 71, tasMax: 600, cruise: 240, climbMax: 254, gMax: 9,   ceiling: 18000},
];

// Lookup helpers ------------------------------------------------------------

export function quadcopterById(id) {
    return QUADCOPTER_MODELS.find(m => m.id === id) || QUADCOPTER_MODELS[0];
}

export function fixedWingById(id) {
    return FIXED_WING_MODELS.find(m => m.id === id) || FIXED_WING_MODELS[0];
}

// Names for building the UI dropdown (display name -> id kept elsewhere).
export function quadcopterNames() { return QUADCOPTER_MODELS.map(m => m.name); }
export function fixedWingNames() { return FIXED_WING_MODELS.map(m => m.name); }

// ---------------------------------------------------------------------------
// Classification: given a SOLVED trajectory's characteristic numbers, name the
// nearest real airframe in the catalog. Used when the dropdown is AUTO, to
// answer "what common model is this solution most like?".
// ---------------------------------------------------------------------------

// Fixed-wing: nearest by cruise TAS, with a strong penalty for a solved TAS
// that falls outside a model's [tasMin, tasMax] envelope (that model simply
// can't fly that speed) and a milder penalty for climb beyond its capability.
// Skips the AUTO entry. Returns the best model plus a fit score (0 = bang on).
export function classifyFixedWing(tasMs, climbMs = 0, maneuverAccelG = 0, altitudeM = 0) {
    // trackMetrics reports maneuver acceleration/g with steady 1 g removed.
    // Approximate the resulting load factor before comparing with catalog
    // structural g limits; comparing the raw acceleration directly was a
    // dimensional/semantic mismatch.
    const loadFactor = Math.hypot(1, maneuverAccelG);
    let best = null, bestScore = Infinity;
    for (const m of FIXED_WING_MODELS) {
        if (m.auto) continue;
        const clampedTas = Math.min(Math.max(tasMs, m.tasMin), m.tasMax);
        const outOfEnv = Math.abs(tasMs - clampedTas);       // m/s outside speed envelope
        const climbOver = Math.max(0, Math.abs(climbMs) - m.climbMax);
        const gOver = Math.max(0, loadFactor - m.gMax);
        const altitudeOver = Math.max(0, altitudeM - m.ceiling);
        // out-of-envelope dominates; then proximity to this type's cruise TAS
        const score = outOfEnv * 4 + climbOver * 4 + gOver * 20
            + altitudeOver / 500 + Math.abs(tasMs - m.cruise);
        if (score < bestScore) { bestScore = score; best = m; }
    }
    const compatible = !!best && tasMs >= best.tasMin && tasMs <= best.tasMax
        && Math.abs(climbMs) <= best.climbMax && loadFactor <= best.gMax && altitudeM <= best.ceiling;
    return {model: best, score: bestScore, compatible};
}

// Quadcopter: pick the least-capable common drone whose envelope still covers
// the observed peak speed and climb (a snug fit), heavily penalizing any model
// that can't reach the observed motion. climbMs is SIGNED (+climb / -descent)
// and is checked against the matching maxAscent/maxDescent capability:
// descent capability is usually the SMALLER of the two, so folding the sign
// away validated descents against ascent capability and produced false
// "containing envelope" labels (e.g. a 5.5 m/s descent "contained" by a
// Phantom 4 Pro that can only descend at 4 m/s). Optional altitudeM checks
// the (soft) ceiling, mirroring classifyFixedWing. Skips AUTO.
export function classifyQuadcopter(maxSpeedMs, climbMs = 0, altitudeM = 0) {
    let best = null, bestScore = Infinity;
    const vertCapOf = m => (climbMs >= 0 ? m.maxAscent : m.maxDescent);
    for (const m of QUADCOPTER_MODELS) {
        if (m.auto) continue;
        const overSpeed = Math.max(0, maxSpeedMs - m.maxSpeed);
        const overClimb = Math.max(0, Math.abs(climbMs) - vertCapOf(m));
        const overCeiling = Math.max(0, altitudeM - m.ceiling);
        const spare = Math.max(0, m.maxSpeed - maxSpeedMs);  // unused capability (prefer snug)
        const score = (overSpeed + overClimb) * 10 + overCeiling / 500 + spare;
        if (score < bestScore) { bestScore = score; best = m; }
    }
    const compatible = !!best && maxSpeedMs <= best.maxSpeed
        && Math.abs(climbMs) <= vertCapOf(best)
        && altitudeM <= best.ceiling;
    return {model: best, score: bestScore, compatible};
}
