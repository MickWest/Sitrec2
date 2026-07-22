// wind.js — the four wind configurations (PLAN.md "Wind configurations").
//
// A wind config produces:
//  - windAt(lat, lon, altMSL, frame) -> {u, v}  m/s mean wind (the closure
//    BalloonPhysics.integrateBalloonPositions consumes; gusts are BalloonPhysics'
//    own seeded model, driven by variabilityPct — NOT added here);
//  - variabilityPct for that gust model;
//  - a helper to sample the mean velocity at an arbitrary altitude for the
//    scenario record's sampledVelocityENU series.
//
// The layered profile mirrors tests/TraverseBalloonRecovery.test.js: a linear
// speed shear clamped to [0.25, 3]x below/above, and a directional veer that
// engages above a kink altitude over the following 60 m. A non-climbing target
// samples only its local layer — the benchmark does not claim vertical-shear
// coverage for those cells (PLAN.md).

const DEG = Math.PI / 180;

export const WIND_CONFIGS = {
    "zero":         {u: 0, v: 0,  variabilityPct: 0},
    "fixed":        {u: 6, v: -2, variabilityPct: 0},
    "fixed-gust":   {u: 6, v: -2, variabilityPct: 12},
    "layered-gust": {
        u: 4, v: -1, variabilityPct: 12,
        shearPerM: 8e-4, kinkAltM: 30, veerDeg: 25, veerSpanM: 60,
    },
    // HAB-LONG-RANGE block only: strong steady upper wind, no gusts.
    "hab-steady":   {u: 20, v: 8, variabilityPct: 0},
};

// Build the wind sampler for a config. refAltMSL is the altitude the layered
// profile is anchored to (the target's start altitude) — shear/veer are
// relative to it, matching the balloon-recovery test's construction.
export function makeWind(kind, refAltMSL = 0) {
    const cfg = WIND_CONFIGS[kind];
    if (!cfg) throw new Error(`botbench: unknown wind kind "${kind}"`);

    const meanAt = (altMSL) => {
        let u = cfg.u, v = cfg.v;
        if (cfg.shearPerM) {
            const dAlt = altMSL - refAltMSL;
            const mult = Math.max(0.25, Math.min(3, 1 + cfg.shearPerM * dAlt));
            u *= mult;
            v *= mult;
            if (dAlt > cfg.kinkAltM) {
                const frac = Math.min(1, (dAlt - cfg.kinkAltM) / cfg.veerSpanM);
                const th = frac * cfg.veerDeg * DEG;
                const c = Math.cos(th), s = Math.sin(th);
                [u, v] = [u * c - v * s, u * s + v * c];
            }
        }
        return {u, v};
    };

    return {
        kind,
        variabilityPct: cfg.variabilityPct,
        // BalloonPhysics signature: (lat, lon, altMSL, frame) -> {u, v}
        windAt: (lat, lon, altMSL) => meanAt(altMSL),
        meanAt,
        parameters: {...cfg},
    };
}
