/**
 * BotBenchSolvers.js — the solvers a BOTBench run can select, and the fit units
 * behind them.
 *
 * A SOLVER is one candidate in the hypothesis set, named as the table and the
 * charts name it. A UNIT is one fit of the battery (TraverseBattery.BATTERY_UNITS).
 * The two are not the same list: the Ground Object and the stationary point are
 * closed-form fits made while the candidates are built and need no unit; the
 * Minimum Speed candidate is read off the slow range profile, which the Constant
 * Air Speed candidate also needs; and one polynomial sweep serves five candidates.
 * The folder cache stores UNITS, so a run that selects more solvers than the last
 * one fits only the units it lacks, and a change to one solver's code invalidates
 * one unit and nothing else. The per-unit versions live here, beside the solvers,
 * because a developer who changes a fitter has to bump one number in one place.
 *
 * No DOM and no analysis imports: the dialog, the worker, the cache index and the
 * tests all read this file.
 */

import {MONTE_CARLO_IDS, MONTE_CARLO_PRESETS, MONTE_CARLO_SEED, monteCarloName} from "../MonteCarloLOS";

/**
 * The units of the battery, in the order the battery runs them, each with the units
 * it needs finished first. A caller planning a subset closes over `needs`, so the
 * plan is always one the battery can run in order.
 *
 * `constAir` is the constant-air-speed sweep. Its resolved range bracket (the
 * search grid, widened when a winner sits on an edge) is what the profiles and the
 * range-bounded fits search inside, which is why they need it. `kalman` is the
 * smoother track the seeded physics fits start from.
 */
export const BATTERY_UNITS = Object.freeze({
    constAir: {needs: []},
    profiles: {needs: ["constAir"]},
    aircraft: {needs: ["constAir"]},
    constAlt: {needs: ["constAir"]},
    horizontalSpeed: {needs: []},
    plausible: {needs: ["constAir"]},
    gfCV: {needs: []},
    gfCA: {needs: []},
    kalman: {needs: []},
    lantern: {needs: ["kalman"]},
    quadcopter: {needs: []},
    droneControl: {needs: ["kalman"]},
    families: {needs: ["constAir", "aircraft", "lantern", "quadcopter", "kalman"]},
    polySweep: {needs: []},
    ...Object.fromEntries(MONTE_CARLO_IDS.map(id => [id, {needs: []}])),
});

/** The units in battery order. */
export const UNIT_ORDER = Object.freeze(Object.keys(BATTERY_UNITS));

/**
 * BUMP A UNIT'S VERSION WHEN ITS FIT CHANGES. A stored unit fitted under another
 * version is not reused. This is the deliberate half of cache invalidation; the
 * other half is the run's own check, which re-fits a sample of files under a new
 * build and reuses a unit only where the fresh fit reproduces the stored one.
 */
export const UNIT_VERSIONS = Object.freeze({
    constAir: 1,
    profiles: 1,
    aircraft: 1,
    constAlt: 1,
    horizontalSpeed: 1,
    plausible: 1,
    gfCV: 1,
    gfCA: 1,
    kalman: 1,
    lantern: 1,
    quadcopter: 2,
    droneControl: 1,
    families: 1,
    polySweep: 1,
    ...Object.fromEntries(MONTE_CARLO_IDS.map(id => [id, 1])),
});

/** The polynomial orders the curve-fit sweep produces (TraverseBattery.MC_SWEEP_MAX_ORDER). */
const POLY_ORDERS = [1, 2, 3, 4, 5];

/**
 * The solvers, in the order their candidates appear in the hypothesis set. `id` is
 * the candidate's key, with the polynomial order added for the sweep tiles, and it
 * is what the run's `solvers` option and the include filter carry.
 */
export const SOLVERS = Object.freeze([
    {id: "constAir", name: "Constant Air Speed", group: "Sightline fits", units: ["constAir", "profiles"],
        note: "The smoothest ray-following path at a fixed air speed; needs the sweep and the slow range profile."},
    {id: "constAlt", name: "Constant Altitude", group: "Sightline fits", units: ["constAlt"],
        note: "Level flight at a fixed height."},
    {id: "horizontalSpeed", name: "Horizontal Speed Valley", group: "Sightline fits",
        units: ["horizontalSpeed"],
        note: "Speculative level-flight solver: combines multi-scale speed consistency, cancellation of the dominant altitude-dependent speed waveform, and block-bootstrap basin confidence while heading may change."},
    {id: "plausible", name: "Minimum Acceleration", group: "Sightline fits", units: ["plausible"],
        note: "The acceleration-minimizing path at any range."},
    {id: "saddle", name: "Minimum Speed", group: "Sightline fits", units: ["profiles"],
        note: "The slowest object consistent with the sightlines; read off the slow range profile."},
    {id: "aircraft", name: "Fixed-Wing Aircraft", group: "Object models", units: ["aircraft"],
        note: "The fixed-wing model, differential evolution then polish. About a quarter of a file's time."},
    {id: "lantern", name: "Sky Lantern / Balloon", group: "Object models", units: ["lantern"],
        note: "The wind-drift model with the wind inferred, seeded from the Kalman smoother. About a third of a file's time."},
    {id: "quadcopter", name: "Quadcopter", group: "Object models", units: ["quadcopter"],
        note: "The free multirotor envelope fit."},
    {id: "droneControl", name: "Drone (flown inputs)", group: "Object models", units: ["droneControl"],
        note: "A drone flown with a few held inputs, refined from the Kalman smoother seed."},
    {id: "ground", name: "Ground Object", group: "Geometry checks", units: [],
        note: "A fixed light on the surface; a closed-form fit, no unit to cache."},
    {id: "fixedPoint", name: "Stationary Point / Fixed Point in the Sky", group: "Geometry checks", units: [],
        note: "A stationary object, or a fixed direction at infinity; closed-form."},
    {id: "gfCV", name: "Global Fit: Constant Velocity", group: "Curve fits", units: ["gfCV"],
        note: "Direct least-squares constant-velocity fit to all sightlines. Cheap."},
    {id: "gfCA", name: "Global Fit: Constant Acceleration", group: "Curve fits", units: ["gfCA"],
        note: "Direct least-squares constant-acceleration fit to all sightlines. Cheap."},
    {id: "gfKalman", name: "Global Fit: Kalman Smoother", group: "Curve fits", units: ["kalman"],
        note: "The Kalman-smoothed sightline fit, as the live analysis offers it. Cheap."},
    ...POLY_ORDERS.map((order) => ({
        id: `gfPolyALS:${order}`, name: `Global Fit: Polynomial LSQ (order ${order})`, group: "Curve fits",
        units: ["polySweep"], note: order === 1 ? "The deterministic alternating least-squares curve fits, one sweep for all five orders." : null,
    })),
    ...MONTE_CARLO_IDS.map(id => ({id, name: monteCarloName(id), group: "Monte Carlo (GPU)",
        units: [id], default: false,
        note: `${MONTE_CARLO_PRESETS[id].numTrials.toLocaleString("en-US")} blind-range trials, order 1, 0.1° LOS uncertainty. Requires WebGPU.`,
    })),
]);

/** The Monte Carlo sweep's candidates, present only when that option is on. */
const MC_SOLVER_IDS = Object.freeze(["gfMC1", "gfMC2"].flatMap((key) => POLY_ORDERS.map((order) => `${key}:${order}`)));

const SOLVER_BY_ID = new Map(SOLVERS.map((s) => [s.id, s]));

/** Every solver id, in candidate order. */
export function allSolverIds() {
    return SOLVERS.map((s) => s.id);
}

/** Keep GPU-only additions opt-in for existing/default CPU runs. */
export function defaultSolverIds() {
    return SOLVERS.filter(s => s.default !== false).map(s => s.id);
}

/** The solver for an id, or null. */
export function solverById(id) {
    return SOLVER_BY_ID.get(id) ?? null;
}

/**
 * A selection as the run carries it: the known ids, deduplicated, in candidate
 * order. An absent or empty selection retains the original default battery.
 * GPU-only Monte Carlo presets must be selected explicitly (or with All).
 */
export function normalizeSolvers(ids) {
    if (!ids) return defaultSolverIds();
    const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
    const kept = SOLVERS.filter((s) => wanted.has(s.id)).map((s) => s.id);
    return kept.length ? kept : defaultSolverIds();
}

/** Whether a selection is the whole battery. */
export function isEverySolver(ids) {
    return normalizeSolvers(ids).length === SOLVERS.length;
}

/**
 * The candidate keys the hypothesis builder should include for a selection: the
 * selected solvers, plus the Monte Carlo tiles when that sweep is on, since those
 * are an option of the run rather than solvers of their own.
 */
export function includeSetFor(ids, {mcOrderSweep = false} = {}) {
    const keys = new Set(normalizeSolvers(ids));
    if (mcOrderSweep) for (const id of MC_SOLVER_IDS) keys.add(id);
    return keys;
}

/**
 * The units a selection needs, in battery order: each selected solver's units and,
 * transitively, what those need. Range bands are traced only for the object models,
 * so that unit joins the plan only when the option is on and one of them is selected.
 */
export function planUnits(ids, {solutionFamilies = false} = {}) {
    const selected = normalizeSolvers(ids);
    const planned = new Set();
    const add = (unit) => {
        if (planned.has(unit)) return;
        if (!BATTERY_UNITS[unit]) throw new Error(`BotBench: unknown battery unit "${unit}"`);
        for (const need of BATTERY_UNITS[unit].needs) add(need);
        planned.add(unit);
    };
    for (const id of selected) for (const unit of SOLVER_BY_ID.get(id).units) add(unit);
    if (solutionFamilies && ["lantern", "quadcopter", "aircraft"].some((id) => selected.includes(id))) add("families");
    return UNIT_ORDER.filter((unit) => planned.has(unit));
}

/**
 * The units whose fit changes under the GPU search option. Range bands start
 * from the GPU-supported object-model fits, so that unit changes with them.
 */
export const GPU_SEARCH_UNITS = Object.freeze(["aircraft", "lantern", "quadcopter", "families"]);

/**
 * The run options one unit's fit depends on. Every unit searches inside the bracket
 * the range anchor sets; the range-band unit exists only under its option, and the
 * polynomial sweep adds the Monte Carlo strategies under its option. A stored unit
 * is reused only when these match.
 *
 * The GPU search flag is added ONLY when it is on, so every unit stored by a CPU
 * run keeps the options record it always had and stays reusable.
 */
export function unitOptions(unit, options = {}) {
    if (MONTE_CARLO_IDS.includes(unit)) {
        return {...MONTE_CARLO_PRESETS[unit], seed: MONTE_CARLO_SEED, backend: "webgpu"};
    }
    const out = {anchorM: options.anchorM ?? null};
    if (unit === "families") out.solutionFamilies = !!options.solutionFamilies;
    if (unit === "polySweep") out.mcOrderSweep = !!options.mcOrderSweep;
    if (options.gpuSearch && GPU_SEARCH_UNITS.includes(unit)) out.gpuSearch = true;
    return out;
}

/** Whether two option records say the same thing, whatever their key order. */
export function sameOptions(a, b) {
    const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort()));
    return norm(a) === norm(b);
}

/**
 * The key a finished row is stored under: the selection and the options that shape
 * the candidate set. The build is checked separately, because a row built by another
 * build is reused only after the run has checked a sample of them.
 */
export function selectionKey(ids, options = {}) {
    // The GPU flag is appended only when on, so rows remembered by CPU runs keep their keys.
    const flags = `a=${options.anchorM ?? "-"}|f=${options.solutionFamilies ? 1 : 0}|m=${options.mcOrderSweep ? 1 : 0}`
        + (options.gpuSearch ? "|g=1" : "");
    return `${normalizeSolvers(ids).join(",")}|${flags}`;
}

/**
 * Whether a finished row may be remembered under its selection key. A row made under
 * the GPU search option whose supported search ran on the CPU instead (no
 * WebGPU, or a GPU error) is a CPU row: remembered under the GPU key, it would be shown
 * to later GPU runs, which would then never fit. Its fits are not stored either
 * (BotBenchFit `markGpuFallbacksUncacheable`). A row with neither search is unaffected.
 */
export function rowMemoStorable(options, row) {
    // A failed GPU-only fit must be retried, even when GPU search for the
    // independent physics models was not selected.
    if (row?.missingGpuSolvers?.length) return false;
    if (!options?.gpuSearch) return true;
    const backend = row?.searchBackend ?? null;
    return backend === null || backend === "webgpu";
}

/** The unit versions a plan was made under, for the row memo to record and check. */
export function unitVersionsFor(units) {
    const out = {};
    for (const unit of units) out[unit] = UNIT_VERSIONS[unit];
    return out;
}

/** A short description of a selection for the status line. */
export function describeSolvers(ids) {
    const n = normalizeSolvers(ids).length;
    return n === SOLVERS.length ? `all ${n} solvers` : `${n} of ${SOLVERS.length} solvers`;
}
