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
    // A near-calm drift, for a balloon set that needs "slow" to be slow rather
    // than still: 2.2 m/s, about a fifth of "fixed".
    "light":        {u: 2, v: -1, variabilityPct: 0},
    "fixed":        {u: 6, v: -2, variabilityPct: 0},
    "fixed-gust":   {u: 6, v: -2, variabilityPct: 12},
    "layered-gust": {
        u: 4, v: -1, variabilityPct: 12,
        shearPerM: 8e-4, kinkAltM: 30, veerDeg: 25, veerSpanM: 60,
    },
    // HAB-LONG-RANGE block only: strong steady upper wind, no gusts.
    "hab-steady":   {u: 20, v: 8, variabilityPct: 0},
};

/**
 * The configuration a wind spec resolves to. A spec is either a string naming
 * one of WIND_CONFIGS, an object {kind} naming one, or an object that carries
 * its own numbers ({kind: "custom", u, v, variabilityPct?, shearPerM?,
 * kinkAltM?, veerDeg?, veerSpanM?}), which is how a set with a random wind per
 * scenario keeps the wind inside the spec, and so inside the truth key.
 */
export function windConfigFor(spec) {
    const kind = typeof spec === "string" ? spec : spec?.kind;
    const named = WIND_CONFIGS[kind];
    if (named) return {...named};
    if (spec && typeof spec === "object" && Number.isFinite(spec.u) && Number.isFinite(spec.v)) {
        const {kind: _k, ...numbers} = spec;
        return {variabilityPct: 0, ...numbers};
    }
    throw new Error(`botbench: unknown wind kind "${kind}"`);
}

// Build the wind sampler for a config. refAltMSL is the altitude the layered
// profile is anchored to (the target's start altitude) — shear/veer are
// relative to it, matching the balloon-recovery test's construction.
export function makeWind(kindOrSpec, refAltMSL = 0) {
    const kind = typeof kindOrSpec === "string" ? kindOrSpec : kindOrSpec?.kind;
    const cfg = windConfigFor(kindOrSpec);

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
