import {angularSizeFitEnabled} from "../AngularSize";
/** Shared scene-independent BOTBench fitting, used by the browser and workers. */
import {buildHypotheses as buildCoreHypotheses, flatTerrainProbes, trackGroundStats,
    UNDERGROUND_TOL} from "../TraverseHypotheses";
import {kinematicFamilyScreen, runTraverseBattery} from "../TraverseBattery";
import {KNOTS_TO_MS, METERS_PER_NM} from "../TraverseAnalysis";
import {includeSetFor, planUnits} from "./BotBenchSolvers";

export const DEFAULT_ANCHOR_M = 20 * METERS_PER_NM;
export const SPEED_TARGET_MS = 380 * KNOTS_TO_MS;

// The live analysis's adaptive bracket, verbatim from AnalyzeTraverse's
// adaptiveRangeList: 44 rungs linearly spaced from 0.1c to max(8, 2c) NM,
// clamped to [0.3, 90] NM. Expansion is left ON, as it is in the app whenever
// the user has not pinned a band.
function adaptiveRangeList(centerMeters, count = 44) {
    const cNM = Math.max(0.5, centerMeters / METERS_PER_NM);
    const loNM = Math.max(0.3, 0.1 * cNM);
    const hiNM = Math.min(90, Math.max(8, 2 * cNM));
    const ranges = [];
    for (let i = 0; i < count; i++) {
        ranges.push((loNM + (hiNM - loNM) * i / (count - 1)) * METERS_PER_NM);
    }
    return ranges;
}

/**
 * The range-band screen for a flat-plane dataset: the shared kinematic ceilings
 * plus "does not go underground", with ground a level surface at groundZ.
 *
 * The live app's screen additionally honours the ground-contact mode; there is
 * no such mode in a bulk run, so every member is judged as airborne-permitted.
 */
function makeFlatFamilyScreen(dataset, originLat, originLon, groundZ) {
    const {signedAGL} = flatTerrainProbes(groundZ);
    return (member) => {
        const kinematic = kinematicFamilyScreen(member);
        if (!kinematic.ok) return kinematic;
        const stats = trackGroundStats(member.track, dataset.n, originLat, originLon, signedAGL);
        if (stats && stats.minAGL < -UNDERGROUND_TOL) {
            return {ok: false, reason: "passes below the ground plane"};
        }
        return {ok: true, reason: null};
    };
}

export function botBenchRangeLimits(record) {
    const declaredMaxM = Number.isFinite(record.meta?.maxRangeM) && record.meta.maxRangeM > 0
        ? record.meta.maxRangeM : null;
    // Below this a range grid would span metres, every fit would be garbage,
    // and the failure would look like a solver problem rather than a metadata
    // one. Search the default bracket instead and let EVERY candidate be
    // reported as violating, which is the honest reading of "the file says the
    // target is within a few metres and no model can put it there".
    const MIN_SEARCHABLE_MAX_RANGE_M = 50;
    const gridMaxM = declaredMaxM !== null && declaredMaxM >= MIN_SEARCHABLE_MAX_RANGE_M
        ? declaredMaxM : null;

    return {declaredMaxM, gridMaxM};
}

/**
 * Where the battery's GPU-capable searches ran (physics and Monte Carlo):
 * "webgpu", "cpu", "mixed", or null when none was run successfully.
 */
export function searchBackendOf(battery) {
    const used = [];
    if (battery?.aircraft) used.push(battery.aircraft.runs?.[0]?.de?.backend === "webgpu");
    if (battery?.aircraftFreeWind) used.push(battery.aircraftFreeWind.runs?.[0]?.de?.backend === "webgpu");
    if (battery?.quad) used.push(battery.quad.params?.optimizer?.de?.backend === "webgpu");
    for (const fit of Object.values(battery?.monteCarlo ?? {})) {
        if (fit) used.push(fit.params?.backend === "webgpu");
    }
    if (!used.length) return null;
    if (used.every(Boolean)) return "webgpu";
    return used.some(Boolean) ? "mixed" : "cpu";
}

/**
 * A run that asked for the GPU search but whose fit used the CPU (no WebGPU in this
 * worker, or a GPU error) made a CPU result. Stored under the GPU options it would
 * be served to later GPU runs as though it were one, so it is kept for this run only.
 * The range bands start from those fits, so they follow them.
 */
function markGpuFallbacksUncacheable(units) {
    if (!units) return;
    let fellBack = false;
    const check = (unitId, usedGpu) => {
        const record = units[unitId];
        if (!record) return;
        if (!record.result || !usedGpu(record.result)) {
            record.cacheable = false;
            fellBack = true;
        }
    };
    check("aircraft", (fit) => fit.runs?.[0]?.de?.backend === "webgpu");
    check("aircraftFreeWind", (fit) => fit.runs?.[0]?.de?.backend === "webgpu");
    check("quadcopter", (fit) => fit.params?.optimizer?.de?.backend === "webgpu");
    if (fellBack && units.families) units.families.cacheable = false;
}

export function validateBotBenchRecord({dataset}) {
    // A LAST-LINE GUARD, not a redundant one. The ingest already refuses a file
    // with too few rows, but a bug BETWEEN that check and here (an aliasing
    // slip in the row filter emptied the array once, and n came out 0) hands
    // the fitters a degenerate dataset that dies several frames deep inside
    // traversePlausible with "undefined is not iterable" — a message that says
    // nothing about the real cause. Fail here, where the message can.
    if (!dataset || !(dataset.n >= 10) || !(dataset.fps > 0)
        || dataset.S?.length !== dataset.n * 3 || dataset.D?.length !== dataset.n * 3) {
        throw new Error(`Ingest produced an unusable dataset (n=${dataset?.n}, `
            + `fps=${dataset?.fps}, S=${dataset?.S?.length}, D=${dataset?.D?.length}). `
            + `This is an ingest bug, not a property of the file.`);
    }

}

export async function fitBotBenchRecord(record, {
    anchorM = DEFAULT_ANCHOR_M, solutionFamilies = false, mcOrderSweep = false,
    // Search the supported object-model fits on the GPU where WebGPU exists
    // (TraverseBattery `gpu`). Changes those fits, so their units are stored apart.
    gpuSearch = false, angularSizeOptions = null,
    // The solvers wanted (BotBenchSolvers ids; null for the default set) and, optionally,
    // stored fit units to use in place of fitting: {cached: {unitId: {result,
    // failures}}, onUnit}. The plan of units is derived from the solvers here,
    // so a caller never has to know which unit serves which candidate.
    solvers = null, units = null,
    onProgress = null, isCancelled = () => false, sweepWorkspaces = null,
} = {}) {
    const {dataset, originLat, originLon, groundZ} = record;
    dataset.groundLevelM = groundZ;
    dataset.angularSizeOptions = angularSizeOptions;
    validateBotBenchRecord(record);
    const include = includeSetFor(solvers, {mcOrderSweep});
    const plan = planUnits(solvers, {solutionFamilies});

    // Mirrors the live path's phase(base, span, label) contract, minus the
    // overlay: the caller gets a fraction and a label for its own row.
    const phase = (base, span, label) => async (frac) => {
        if (onProgress) {
            await onProgress(base + span * Math.min(1, Math.max(0, frac)), label);
        }
        if (isCancelled()) throw new Error("cancelled");
    };

    // MaxRange, when the file declares one, is a MEASUREMENT CONSTRAINT: the
    // producer is stating that the target cannot be beyond it (a sensor's
    // detection limit, a range gate).
    //
    // WHAT THIS DOES AND DOES NOT ENFORCE. It narrows the searched brackets —
    // the constant-air grid, the fixed-wing envelope, constant-altitude and
    // least-manoeuvring — and disables bracket expansion. It does NOT make the
    // constraint universal: the physics models carry their own initialRange
    // bounds, the polynomial and stationary fits take no range bound at all,
    // and every method is bounded only at the START range, so any track may
    // still run past the limit later in the clip. So the cap is applied where
    // it can be, and every hypothesis is CHECKED against the limit afterwards
    // and reported (see `maxRangeViolations` below). Claiming enforcement we do
    // not have would be worse than the gap itself.
    // THE CONSTRAINT IS ALWAYS HONOURED FOR REPORTING; only the SEARCH GRID can
    // decline to use it.
    //
    // An earlier version discarded any declared limit under 50 m outright — an
    // invented threshold no format validator imposes, and discarding it meant a
    // file declaring a tight envelope had its candidates escape the violation
    // check entirely. The two uses are separable: checking whether a track ever
    // exceeds a range needs no grid at all, while SPACING a search inside one
    // does. So the limit is kept for the check whatever its value, and only the
    // grid falls back when the limit is too small to search inside.
    const {gridMaxM} = botBenchRangeLimits(record);

    const capM = (v) => (gridMaxM === null ? v : Math.min(v, gridMaxM));

    let ranges = adaptiveRangeList(anchorM);
    if (gridMaxM !== null) {
        const inside = ranges.filter((r) => r <= gridMaxM);
        if (inside.length >= 8) {
            ranges = inside;
        } else {
            // The declared limit is tighter than the whole default bracket, so
            // re-space INSIDE it. Build the grid from the limit itself rather
            // than from a fixed floor: an earlier version used
            // max(300, declaredMax * 0.5) as the low end, which for a limit
            // under 300 m sits ABOVE the high end and yields a descending
            // grid — read downstream as a perfectly ordinary ascending one.
            const hi = gridMaxM;
            // Strictly ascending by construction: the low end is a FRACTION of
            // the high end, never a fixed floor that could exceed it.
            const lo = hi * 0.05;
            ranges = [];
            for (let i = 0; i < 44; i++) ranges.push(lo + (hi - lo) * i / 43);
        }
    }
    const terrainProbes = flatTerrainProbes(groundZ);

    const provenance = {
        // The sightlines are measured (BOT) or recorded gimbal angles (FMV) —
        // in neither case are they reconstructed from a target track, which is
        // what `circular` warns about.
        circular: false,
        losSource: record.kind === "bot" ? "BOT interchange LOS unit vectors"
            : "recorded MISB sensor angles",
        cameraHeading: null,
    };

    const battery = await runTraverseBattery({
        dataset, originLat, originLon, provenance,
        sweepWorkspaces,
        anchorDist: anchorM,
        speedTarget: SPEED_TARGET_MS,
        ranges,
        // A declared MaxRange is a hard limit, so the sweep must NOT be allowed
        // to expand past it — expansion extends the grid geometrically by up to
        // two rounds of x2.5, which would walk straight through the constraint.
        rangeIsDefault: gridMaxM === null,
        // The live path's defaults when the user has not pinned a band: a
        // generous fixed-wing envelope, never narrower than 1-45 NM, so the DE
        // search cannot ram into an artificial boundary — then capped by any
        // declared MaxRange.
        // Each min is floored under its own capped max, because capping the max
        // alone can push it BELOW a fixed min and hand the fitter an inverted
        // bracket — a declared limit under 0.5 NM did exactly that to the
        // least-manoeuvring bounds.
        fitRangeMin: Math.min(ranges[0], capM(1 * METERS_PER_NM)),
        fitRangeMax: capM(Math.max(ranges[ranges.length - 1], 45 * METERS_PER_NM)),
        caRangeMin: Math.min(ranges[0], capM(1 * METERS_PER_NM)),
        caRangeMax: capM(Math.max(ranges[ranges.length - 1], 45 * METERS_PER_NM)),
        plausRangeMin: Math.min(0.5 * METERS_PER_NM, capM(0.5 * METERS_PER_NM)),
        plausRangeMax: capM(55 * METERS_PER_NM),
        windCorrectionSigmaMS: record.meta?.windEstimate?.sigmaMS ?? undefined,
        solutionFamilies,
        mcOrderSweep,
        monteCarloData: record.losSamples ?? (record.meta?.maxRangeM > 0
            ? {maxRange: new Float64Array(dataset.n).fill(record.meta.maxRangeM)} : null),
        directFitData: record.losSamples ?? (record.meta?.maxRangeM > 0
            ? {maxRange: new Float64Array(dataset.n).fill(record.meta.maxRangeM)} : null),
        gpu: gpuSearch,
        familyScreen: makeFlatFamilyScreen(dataset, originLat, originLon, groundZ),
        buildHypotheses: (args) => buildCoreHypotheses({
            ...args,
            aoFixedPoint: true,
            groundMode: "Airborne (any)",
            clipStartMs: record.clipStartMs ?? null,
            ...terrainProbes,
            // Only the selected candidates, and the smoother as one of them:
            // there is no method node here to read it off.
            include,
            kalmanCandidate: true,
        }),
        // No wind field, no satellite catalogue, no scene to read Kalman
        // sliders off — the battery's own defaults apply.
        sampleWindPrior: null,
        searchSatellites: null,
        kalmanNoise: null,
        afterHypotheses: null,
        phase,
        isCancelled,
        units: {plan, cached: units?.cached ?? {}, onUnit: units?.onUnit ?? null},
    });
    if (gpuSearch && !angularSizeFitEnabled(dataset)) markGpuFallbacksUncacheable(battery.units);
    return battery;
}

export function cacheableBotBenchBattery(battery) {
    const {hypotheses, sweep, resolvedRanges, fastProfile, slowProfile,
        slowOpts, aircraft, families, executiveAssessment, failures} = battery;
    return {
        hypotheses, sweep, resolvedRanges, fastProfile, slowProfile,
        slowOpts, aircraft, families, executiveAssessment, failures,
        provenance: battery.provenance,
        monteCarlo: battery.monteCarlo,
        missingGpuSolvers: battery.missingGpuSolvers,
        // Which seed the physics fits started from, and whether that is the
        // seed a full battery would have used (see TraverseBattery).
        seedSource: battery.seedSource ?? null, seedComplete: battery.seedComplete ?? true,
        // The resolved search brackets, quoted by the manifest below.
        fitRangeMin: battery.fitRangeMin, fitRangeMax: battery.fitRangeMax,
        caRangeMin: battery.caRangeMin, caRangeMax: battery.caRangeMax,
        plausRangeMin: battery.plausRangeMin, plausRangeMax: battery.plausRangeMax,
        // Whole fit results, not the three scalars the manifest happens to read
        // off them today. Keeping the shape means a later line reading another
        // of their fields gets the same answer from a cached run as from a
        // fresh one; keeping only the scalars would make that the moment the
        // two silently parted company. The codec refuses anything it cannot
        // represent, so if one of these ever stops being plain data the write
        // fails loudly instead of storing a lie.
        plausible: battery.plausible, lantern: battery.lantern, quad: battery.quad,
        aircraftFreeWind: battery.aircraftFreeWind,
        freeBounds: battery.freeBounds,
        lanternSuppliedWind: battery.lanternSuppliedWind,
        lanternCorrectedWind: battery.lanternCorrectedWind,
        quadSuppliedWind: battery.quadSuppliedWind,
        sweepFreeWind: battery.sweepFreeWind,
        profilesFreeWind: battery.profilesFreeWind,
        caFreeWind: battery.caFreeWind,
        plausibleFreeWind: battery.plausibleFreeWind,
        constantVelocity: battery.constantVelocity,
        constantAcceleration: battery.constantAcceleration,
    };
}
