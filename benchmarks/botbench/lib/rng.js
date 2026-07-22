// rng.js — deterministic seed derivation and random streams for BOT Bench.
//
// Contract (benchmarks/botbench/PLAN.md, "Design laws"):
//  - every stochastic component gets its OWN stream, seeded from a stable hash
//    of (seedKey, scenarioSeed, componentLabel, generatorVersion), so adding a
//    random call in one generator never perturbs another;
//  - seed 0 maps to 1 (mulberry32, BalloonPhysics and the wobble generator all
//    treat 0 as 1 — keep that uniform rather than special-casing callers);
//  - no Math.random, no Date.now anywhere in the harness.

import {mulberry32} from "../../../src/DifferentialEvolution";

// FNV-1a 32-bit over a string. Stable across runs and platforms.
export function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Derive a component seed. seedKey is normally the scenario's canonical spec
// hash; paired scenarios (matched-noise, anomaly/control) pass their shared
// pair key for the observation component so both members get the EXACT same
// pointing-error realization.
export function deriveSeed(seedKey, scenarioSeed, componentLabel, generatorVersion) {
    const s = fnv1a32(`${seedKey}|${scenarioSeed}|${componentLabel}|${generatorVersion}`);
    return s === 0 ? 1 : s;
}

// A stream bundles the uniform PRNG with a Box-Muller gaussian that caches
// its spare value (the classic pair trick), so gaussian() costs one pair of
// uniforms every other call and stays deterministic per-stream.
export function makeStream(seed) {
    const rand = mulberry32((seed >>> 0) || 1);
    let spare = null;
    return {
        seed: (seed >>> 0) || 1,
        uniform: rand,
        gaussian() {
            if (spare !== null) {
                const v = spare;
                spare = null;
                return v;
            }
            // Box-Muller; u > 0 guaranteed by nudging zero.
            let u = rand();
            if (u <= 1e-12) u = 1e-12;
            const v = rand();
            const r = Math.sqrt(-2 * Math.log(u));
            const a = 2 * Math.PI * v;
            spare = r * Math.sin(a);
            return r * Math.cos(a);
        },
    };
}
