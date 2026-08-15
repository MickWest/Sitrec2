// The "traverse fit" test group: the numerical fitting suites, and the source they cover.
//
// WHY THIS EXISTS. These suites run real optimizers — differential evolution populations,
// Nelder-Mead polishing, RK4 integration over whole trajectories — against synthetic scenes,
// and that compute IS the assertion: they prove a fit converges to the right answer, that a
// corkscrew is priced out, that a manoeuvre stays recoverable. They cannot be made cheap
// without weakening what they prove, and they cover code that changes rarely.
//
// Measured 2026-08-15: these nine files are 348.5s of the suite's 1048 suite-seconds — a third
// of all the work — and one of them (DroneControlFit) is the single slowest file and sets the
// whole suite's wall clock. Skipping them when nothing they cover has changed is the largest
// safe saving available on a routine ship.
//
// The other ~18 fit-adjacent tests (TraverseRanking, LOSFittingObservability, ExecutiveVerdict,
// and so on) are deliberately NOT in this list: together they take about 3 seconds, so removing
// them would buy nothing and lose the cheap protection they give. They always run.
//
// KEEPING THIS HONEST. tests/fitTestGroup.test.js asserts every path here exists and that the
// jest pattern matches exactly this list, so a rename cannot silently drop a suite from both
// the fast run AND the slow run — which would be the dangerous failure: a test that never runs
// anywhere, while both commands still report success.

// CommonJS on purpose, and NOT named .mjs. The Jest config maps every ".mjs" import to the
// Three.js addons stub (moduleNameMapper: ".+\\.mjs$"), so a .mjs version of this file reaches
// the guard test as a stub with undefined exports — and the guard's loops then iterate over
// nothing and pass while asserting nothing. A .js CommonJS module is read correctly by both
// babel-jest and Node's ESM loader (which default-imports it).

// The expensive suites. Paths are repo-relative.
const FIT_TESTS = [
    "tests/DroneControlFit.test.js",
    "tests/QuadcopterModel.test.js",
    "tests/SkyLanternModel.test.js",
    "tests/TraverseAnalysis.test.js",
    "tests/TraverseBalloonRecovery.test.js",
    "tests/botbench/capabilityGate.test.js",
    "tests/botbench/fitAircraftBasin.test.js",
    "tests/botbench/headlessHypotheses.test.js",
    "tests/botbench/verdictRunner.test.js",
];

// Jest testPathIgnorePatterns fragment that excludes exactly the files above.
// Anchored on the basename so it cannot accidentally catch a neighbour: "TraverseAnalysis"
// unanchored would also swallow TraverseAnalysisData and TraverseAnalysisCache, which are
// fast and must keep running.
const FIT_TEST_IGNORE_PATTERN =
    `/(${FIT_TESTS.map((p) => p.split("/").pop().replace(".test.js", "")).join("|")})\\.test\\.js$`;

// Source paths whose modification means the fit suites must run. Derived from what the nine
// files actually import, not from a guess at what sounds related.
//
// src/Globals is deliberately EXCLUDED even though several of them import it: nearly every
// change touches Globals, so including it would mean the fit suites always run and this whole
// mechanism would do nothing. The ~18 fast fit-adjacent tests still run on every ship and would
// catch a Globals change that broke the fitting path.
const FIT_SOURCES = [
    "src/BalloonPhysics",
    "src/BoundedFit",
    "src/DifferentialEvolution",
    "src/DroneControlFit",
    "src/LOSFitting",
    "src/NelderMead",
    "src/PhysicsModel",
    "src/QuadcopterModel",
    "src/SkyLanternModel",
    "src/TrackExportMath",
    "src/Traverse",              // prefix: TraverseAnalysis, TraverseBattery, TraverseHypotheses, TraverseRanking, ...
    "src/VehicleModels",
    "benchmarks/botbench/",      // the whole bot-bench library and its scenario generators
    ...FIT_TESTS,                // editing a fit test obviously means running it
];

/** True if `file` (a repo-relative path) is one the fit suites cover. */
function touchesFitCode(file) {
    return FIT_SOURCES.some((p) => file === p || file.startsWith(p));
}

module.exports = {FIT_TESTS, FIT_TEST_IGNORE_PATTERN, FIT_SOURCES, touchesFitCode};
