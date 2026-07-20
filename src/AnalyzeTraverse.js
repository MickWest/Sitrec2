/**
 * AnalyzeTraverse.js — one-button traverse analysis with a generated HTML report.
 *
 * Adds an "Analyze Traverse Methods..." button to the Traverse menu which runs the
 * full suite of LOS-traversal analyzers from TraverseAnalysis.js against the
 * current sitch's lines of sight:
 *
 *   - sweepConstAirSpeed: grid search (start range x air speed) of the
 *     constant-air-speed traverse, scored by flight smoothness.
 *   - rangeProfile (fast + slow object): the smoothest possible LOS-riding
 *     trajectory at each assumed range — how much maneuvering does each
 *     distance REQUIRE?
 *   - fitAircraft: parametric fixed-wing fit (differential evolution).
 *
 * Results are rendered into a fully self-contained dark-theme HTML report
 * (charts pre-rendered to PNG data-URLs, works offline) opened in a new tab,
 * and the best constant-air-speed solution can be applied straight back to
 * the "Tgt Start Dist" / "Target Speed" sliders.
 *
 * Exports:
 *   addAnalyzeButton(folder)       — idempotently add the menu button
 *   runTraverseAnalysis()          — run everything; returns the results object
 */

import {GlobalDateTimeNode, Globals, NodeMan, Sit, TrackManager, setRenderOne} from "./Globals";
import {EventManager} from "./CEventManager";
import {addOptionToGUIMenu, removeOptionFromGUIMenu} from "./lil-gui-extras";
import {showError} from "./showError";
import {t} from "./i18n";
import {abFrameRange, buildAnalysisDataset, unpackTrackToECEF} from "./TraverseAnalysisData";
import {getPointBelow, calculateAltitude} from "./threeExt";
import {
    compareTrackToTruth,
    constAirSpeedTrack,
    fitAircraft,
    fitConstAltitude,
    fitFixedDirection,
    fitFixedPoint,
    fitGroundPoint,
    fitGroundVehicle,
    fitPlausibleBestRange,
    EARTH_RADIUS_M,
    KNOTS_TO_MS,
    meanAngularError,
    METERS_PER_NM,
    isRangeUnobservable,
    pickConstAirRegime,
    rangeProfile,
    sensorMotionStats,
    straightFlightScore,
    sweepConstAirSpeed,
    trackMetrics,
    traverseMinSpeed,
    traversePlausible,
} from "./TraverseAnalysis";
import {fitAlternatingLSQ, fitConstantAcceleration, fitConstantVelocity, fitKalmanFilter, fitMonteCarlo, fitMonteCarlo2, fitPhysicsModel} from "./LOSFitting";
import {DroneControlModel, knotsForDuration} from "./DroneControlFit";
import {SkyLanternModel} from "./SkyLanternModel";
import {QuadcopterModel} from "./QuadcopterModel";
import {classifyFixedWing, classifyQuadcopter} from "./VehicleModels";
import {isLocal} from "./configUtils";
import {getCelestialDirection, getCelestialDirectionFromRaDec, getGeocentricBodyDirectionECEF} from "./CelestialMath";
import {ECEF2ENU_radii} from "./LLA-ECEF-ENU";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";
import * as Astronomy from "astronomy-engine";
import {applyRefractionECI, refractionOptsFromUniforms} from "./atmosphere/refraction";
import {loadLEOSatrecsForDate, findBestSatellite, satelliteTrackENU, satelliteECEF, satelliteSunlit} from "./SatelliteSearch";
import {Chart3D, Chart3DGroup} from "./Chart3D";
import {
    completenessBadges,
    formatRawLosResidual,
    groupAndRankHypotheses,
    rankAllHypotheses,
    rankingExplanation,
    tierBadge,
} from "./TraverseRanking";
import {
    terrainAnalysisConfigScalars,
    terrainDependencyMismatch,
    terrainDependencyRecordsMatch,
} from "./TraverseAnalysisCache";

const MS_TO_FPM = 60 / 0.3048;      // m/s -> feet per minute

// --- Sky-object brightness / visibility model -------------------------------
// An astronomical object only explains a sighting if it (a) points where the
// sensor is looking AND (b) is bright enough to register. Naked-eye limit ~6
// mag at a ~40° field; a narrow sensor FOV concentrates the view and pushes the
// limiting magnitude deeper — a 1° FOV can reveal a body several magnitudes
// fainter (e.g. Mercury near the Sun). We treat FOV as a brightness multiplier.
const AO_REF_FOV = 40;          // deg, the naked-eye reference field
const AO_VISIBLE_LIMIT = 6.0;   // limiting magnitude at AO_REF_FOV

// Current sensor (look camera) field of view in degrees.
function sensorFOVDeg() {
    const cam = NodeMan.get("lookCamera", false);
    const fov = cam && cam.camera ? cam.camera.fov : null;
    return (Number.isFinite(fov) && fov > 0) ? fov : 30;
}
// Magnitude gain from a narrow FOV (0 at the reference field, larger as FOV
// shrinks): a factor (REF_FOV/fov) more light-gathering per resolution element.
function fovMagBoost(fovDeg) {
    return 2.5 * Math.log10(Math.max(1, AO_REF_FOV / Math.max(0.01, fovDeg)));
}
// Apparent visual magnitude of a solar-system body (Illumination is undefined
// for the Sun; fall back for anything astronomy-engine rejects).
function bodyMagnitude(name, date) {
    if (name === "Sun") return -26.7;
    try { return Astronomy.Illumination(name, date).mag; } catch (e) { return 6; }
}
// Apply atmospheric refraction to a celestial ECEF direction IF the View-menu
// refraction toggle is on (opts.enabled mirrors it; applyRefractionECI is a
// no-op when disabled). zenith = geocentric up at the observer.
function refractDir(dirECEF, sensorECEF) {
    const opts = refractionOptsFromUniforms();
    if (!opts.enabled) return dirECEF;
    const zen = sensorECEF.clone().normalize();
    return applyRefractionECI(dirECEF.clone(), zen, opts);
}

// Distance (m) at which "object at infinity" astronomical hypotheses are
// planted along their mean direction so the gallery has a real track to draw.
const FAR_ASTRO = 200 * METERS_PER_NM;

// Monte Carlo polynomial-order sweep. Matches the upper bound of the sitch's
// "MC Polynomial Order" slider (mcOrder, 1..5 — see JetStuff.js), so the sweep
// covers exactly the orders a user could have selected by hand. Each order
// costs a full MC run per variant, so this is the main cost knob of the sweep.
// Knots for the drone control-input fit: the number of held inputs a flight
// over one clip is assumed to be describable by. Raising it approaches the free
// model (and its overfitting); lowering it approaches a single rigid manoeuvre.
// 4 under-recovers a sharp mid-clip course change (~39 deg of a 90 deg truth,
// measured) — adaptive knot placement is the known next step.
const DRONE_CONTROL_KNOTS = 4;

// True only if every element of a numeric array is finite. Used to keep a
// non-finite fit result (e.g. a Kalman seed that went NaN) out of the physical
// fits and the gallery — see the TA-01/TA-02 seed and hypothesis guards.
function allFinite(arr) {
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) return false;
    }
    return true;
}

const MC_SWEEP_MAX_ORDER = 5;
const ORDER_NAMES = {
    1: "linear (constant velocity)",
    2: "quadratic (constant acceleration)",
    3: "cubic",
    4: "quartic",
    5: "quintic",
};

// The three curve-fitting strategies swept over polynomial order. They all fit
// the same sightlines with the same degree of curve; they differ only in HOW
// they search for it, so putting them side by side at matching orders shows how
// much of a result is the data and how much is the method.
const SWEEP_VARIANTS = [
    {key: "gfMC1", name: "Global Fit: Monte Carlo 1", fit: fitMonteCarlo,
        color: "#b79be0", flavour: "best-of-N sampled polynomial"},
    {key: "gfMC2", name: "Global Fit: Monte Carlo 2", fit: fitMonteCarlo2,
        color: "#9b7fd0", flavour: "least-squares over perturbed frames"},
    // Deterministic alternative. Ignores numTrials/losUncertainty (it doesn't
    // sample at all), and unlike the two above it lets range move freely rather
    // than staying within 0.9-1.1x of the constant-velocity seed — so a far or
    // fast solution stays reachable if the sightlines support one.
    {key: "gfPolyALS", name: "Global Fit: Polynomial LSQ", fit: fitAlternatingLSQ,
        color: "#7fc4d0", flavour: "deterministic alternating least squares"},
];

// Set up the shared inputs for the order sweep. Cheap and synchronous; the
// actual fits are driven by sweepPolynomialOrders so they can report progress.
function prepareSweep(dataset) {
    const times = new Float64Array(dataset.n);
    for (let f = 0; f < dataset.n; f++) times[f] = f / dataset.fps;
    const ds = {
        sensorPos: dataset.S, losDir: dataset.D, times,
        count: dataset.n, maxRange: null,
        // The closed-form fits minimise PERPENDICULAR DISTANCE IN METRES, and
        // that objective falls monotonically as a trajectory scales toward the
        // sensor — the sensor's own path is an exact zero-residual solution
        // whenever the sensor flies a CV-representable trajectory (see the
        // contract at LOSFitting.js:80-88). Without this floor the seed below
        // can collapse onto the camera, and because the Monte Carlo fits sample
        // range only within 0.9-1.1x of that seed, a collapsed seed silently
        // pins ALL of their tiles to a near-zero range. 500 m matches the
        // existing noise-floor caller and sits below every model's own floor,
        // so it excludes the degenerate optimum without foreclosing any
        // physically plausible near-field solution.
        minRange: 500,
    };
    const opts = {};
    const trialsNode = NodeMan.get("mcNumTrials", false);
    const uncertNode = NodeMan.get("mcLOSUncertainty", false);
    if (trialsNode) opts.numTrials = trialsNode.v0;
    if (uncertNode) opts.losUncertaintyDeg = uncertNode.v0;
    // Per-frame range estimates from a constant-velocity fit focus the random
    // range sampling, exactly as CNodeLOSFitMonteCarlo does — without them the
    // sampler draws blindly out to 10x the scene extent and the higher orders
    // degenerate into noise. (Only the Monte Carlo fits use these; the
    // alternating fit derives and then freely moves its own ranges.)
    let seedMedian = null;
    const cv = fitConstantVelocity(ds, new Set());
    if (cv) {
        const rangeEstimates = new Float32Array(dataset.n);
        for (let i = 0; i < dataset.n; i++) {
            const b = i * 3;
            rangeEstimates[i] = Math.max(1,
                (cv.positions[b] - dataset.S[b]) * dataset.D[b]
                + (cv.positions[b + 1] - dataset.S[b + 1]) * dataset.D[b + 1]
                + (cv.positions[b + 2] - dataset.S[b + 2]) * dataset.D[b + 2]);
        }
        opts.rangeEstimates = rangeEstimates;
        // Median seed range, so the Monte Carlo tiles can name the range their
        // sampling window is actually centred on instead of referring vaguely
        // to "the constant-velocity fit". A visibly tiny median is the symptom
        // of the collapse the minRange floor above guards against.
        const sorted = Array.from(rangeEstimates).sort((a, b) => a - b);
        seedMedian = sorted[Math.floor(sorted.length / 2)];
    }
    return {ds, opts, seedMedian};
}

// Run every (strategy, order) fit, reporting progress between each one.
//
// This is async purely so the progress bar can move: each individual fit is a
// synchronous number-crunch that locks the main thread (Monte Carlo 2 alone is
// ~5 s per order on a 20,000-frame clip, because its cost is trials x frames),
// and without a yield in between the whole sweep would appear as one long
// freeze with a stalled bar and a dead Cancel button.
//
// `report(done, total, label)` is awaited between fits — that await is what
// actually lets the browser repaint.
async function sweepPolynomialOrders(dataset, report) {
    const {ds, opts, seedMedian} = prepareSweep(dataset);
    const results = [];
    const total = SWEEP_VARIANTS.length * MC_SWEEP_MAX_ORDER;
    let done = 0;
    for (const variant of SWEEP_VARIANTS) {
        for (let order = 1; order <= MC_SWEEP_MAX_ORDER; order++) {
            await report(done, total, `${variant.name} (order ${order})`);
            let res = null;
            try {
                // A short clip can't support the higher orders (needs order + 1
                // points); the fit returns null rather than guessing.
                res = variant.fit(ds, new Set(), {...opts, order});
            } catch (e) {
                res = null;
            }
            done++;
            if (res && res.positions) results.push({variant, order, result: res});
        }
    }
    return {results, numTrials: opts.numTrials, losUncertaintyDeg: opts.losUncertaintyDeg, seedMedian};
}

// User toggles for the extra physical-interpretation hypotheses, surfaced in the
// "Traverse Analysis Tweaks" menu folder (see addAnalyzeTweaks). The two
// ephemeris-backed astronomical tests default OFF (each costs a planet/star
// sweep per analysis); the cheap geometric fixed-point test defaults ON.
export const analyzeTweaks = {
    windMode: "Sitch wind",
    aoFixedPoint: true,
    aoKnownNow: false,
    aoKnownOther: false,
    satellite: false,   // loads the LEO catalogue for the date (network, slow first time)
    groundMode: "Airborne (any)",   // ground-contact constraint (see GROUND_MODES)
    truthTrack: "-",    // track NODE id of the ground-truth reference track ("-" = none)
};

// "no truth track selected" sentinel for the Truth Track dropdown
const TRUTH_NONE = "-";

// Ground-contact constraint modes for the traverse analysis. In every mode,
// any candidate whose trajectory passes underground (below the terrain) is
// rejected — underground is never a valid solution. The non-"Airborne" modes
// additionally require ground contact and add a dedicated Ground Vehicle
// candidate / bias the physics fits toward the surface.
export const GROUND_MODES = [
    "Airborne (any)",      // no ground contact required (underground still rejected)
    "On the ground",       // ground-based vehicle: the whole track rides the surface
    "Starts on ground",    // takeoff / released balloon: begins on the surface
    "Ends on ground",      // landing / descending balloon: ends on the surface
];

// A trajectory more than this many metres below the terrain surface (sampled
// along the track) is treated as underground and rejected. Generous, because
// the elevation map / coarse 3D tiles can themselves be tens of metres off
// (see reference_tile_ground_robustness) — only a clear, sustained dip counts.
const UNDERGROUND_TOL = 40;

// A point within this many metres AGL counts as "on the ground" for the
// ground-contact modes. Generous because elevation products, geoid conversion,
// and the candidate's constant-elevation curved shell can differ by tens of
// metres. Ground-native candidates are still checked against the actual sampled
// terrain; the tolerance prevents map-resolution noise becoming a false reject.
const GROUND_CONTACT_TOL = 150;

// ---------------------------------------------------------------------------
// Report palette (dark surface). Categorical slots validated for CVD
// separation and >=3:1 contrast on the surface; entity colors are fixed
// across every chart (const-air is always blue, etc).
// ---------------------------------------------------------------------------
const VIZ = {
    surface: "#14161a",
    ink: "#e8eaed",
    ink2: "#b9bfc7",
    muted: "#8a9099",
    grid: "#262b33",
    axis: "#3c434c",
    constAir: "#3987e5",   // constant-air-speed traverse (sweep best)
    aircraft: "#199e70",   // parametric aircraft fit
    slowObj: "#c98500",    // slow-object plausible trajectory / profile
    fastObj: "#9085e9",    // fast-object plausible profile
    sensor: "#c3c2b7",     // sensor (jet) path
    ray: "#4a5058",        // LOS rays
    truth: "#e0569f",      // ground-truth reference track (dashed in 3D graphs)
};

// single-hue blue ramp for the heatmap: dark (recedes into surface) = low
// score = plausible, bright = high score = implausible
const HEAT_STOPS = ["#10141c", "#0d366b", "#1c5cab", "#3987e5", "#86b6ef", "#cde2fb"];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const toNM = (m) => m / METERS_PER_NM;
const toKt = (ms) => ms / KNOTS_TO_MS;
const nm1 = (m) => toNM(m).toFixed(1);
const kt1 = (ms) => toKt(ms).toFixed(1);
const fpm0 = (ms) => (ms * MS_TO_FPM).toFixed(0);
const ft0 = (m) => (m / 0.3048).toFixed(0);          // ENU-up meters -> feet

// compact numeric label: strips trailing zeros, sensible precision
function fmtNum(v) {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return String(+v.toFixed(1));
    if (a >= 1) return String(+v.toFixed(2));
    return String(+v.toPrecision(2));
}

// A macrotask yield that is NOT subject to background-tab timer throttling
// (unlike setTimeout). Returns a function returning a Promise that resolves on
// the next MessageChannel tick. Falls back to setTimeout if MessageChannel is
// unavailable.
function makeYield() {
    if (typeof MessageChannel === "undefined") {
        return () => new Promise((resolve) => setTimeout(resolve, 0));
    }
    const channel = new MessageChannel();
    let pending = null;
    channel.port1.onmessage = () => { const r = pending; pending = null; if (r) r(); };
    return () => new Promise((resolve) => { pending = resolve; channel.port2.postMessage(0); });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g,
        (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

// largest |value| of a min/max stat — "the spike"
const statSpike = (s) => Math.max(Math.abs(s.min), Math.abs(s.max));

// ---------------------------------------------------------------------------
// Astronomical / fixed-object hypothesis helpers
// ---------------------------------------------------------------------------

// Real-world Date for a clip frame (frame 0 = the sitch's start time), matching
// how the rest of Sitrec maps frame number to time.
function dateAtFrame(f) {
    return new Date(GlobalDateTimeNode.dateStart.valueOf() + f * 1000 * (Sit.simSpeed ?? 1) / Sit.fps);
}

function dateAtDatasetFrame(dataset, f) {
    return dateAtFrame((dataset.frame0 ?? 0) + f);
}

// Angle (degrees) between two ECEF vectors (auto-normalized).
function angleBetweenDeg(ax, ay, az, bx, by, bz) {
    const al = Math.hypot(ax, ay, az) || 1, bl = Math.hypot(bx, by, bz) || 1;
    let d = (ax * bx + ay * by + az * bz) / (al * bl);
    d = Math.min(1, Math.max(-1, d));
    return Math.acos(d) * 180 / Math.PI;
}

// Mean angular error (degrees) between a fixed ECEF direction and the per-frame
// LOS heading — how well an object in that direction fits the sightlines.
function losMeanAngleDeg(losNode, dir, frame0 = 0, frame1 = losNode.frames - 1) {
    const n = frame1 - frame0 + 1;
    let sum = 0;
    for (let f = frame0; f <= frame1; f++) {
        const h = losNode.v(f).heading;
        sum += angleBetweenDeg(dir.x, dir.y, dir.z, h.x, h.y, h.z);
    }
    return sum / n;
}

// Unit mean LOS heading in ECEF (normalized sum of the per-frame headings).
function meanLOSDir(losNode, frame0 = 0, frame1 = losNode.frames - 1) {
    const n = frame1 - frame0 + 1;
    let sx = 0, sy = 0, sz = 0;
    for (let f = frame0; f <= frame1; f++) {
        const h = losNode.v(f).heading;
        const hl = Math.hypot(h.x, h.y, h.z) || 1;
        sx += h.x / hl; sy += h.y / hl; sz += h.z / hl;
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    return [sx / l, sy / l, sz / l];
}

// Represent an "object at infinity" as a far fixed point along its mean ENU
// direction, planted FAR_ASTRO from the sensor each frame (rides the far ray).
function farAstroTrack(dataset, dirECEF, originLat, originLon) {
    const {n, S} = dataset;
    const enu = ECEF2ENU_radii(dirECEF, originLat, originLon, true);
    const dl = Math.hypot(enu.x, enu.y, enu.z) || 1;
    const ex = enu.x / dl, ey = enu.y / dl, ez = enu.z / dl;
    const track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        track[f * 3] = S[f * 3] + FAR_ASTRO * ex;
        track[f * 3 + 1] = S[f * 3 + 1] + FAR_ASTRO * ey;
        track[f * 3 + 2] = S[f * 3 + 2] + FAR_ASTRO * ez;
    }
    return track;
}

// Per-frame LOS angular rate (deg/s): how fast the sightline is sweeping. The
// "saddle" is the stretch where this is smallest — the object is barely moving
// in bearing, so its apparent motion in the video is mostly the sensor's own
// parallax, and range there is weakly constrained.
function losAngularRateSeries(dataset) {
    const {n, D, fps} = dataset;
    const rate = new Float64Array(n);
    for (let f = 1; f < n; f++) {
        let d = D[f * 3] * D[(f - 1) * 3] + D[f * 3 + 1] * D[(f - 1) * 3 + 1] + D[f * 3 + 2] * D[(f - 1) * 3 + 2];
        d = d > 1 ? 1 : d < -1 ? -1 : d;
        rate[f] = Math.acos(d) * fps * 180 / Math.PI;
    }
    if (n > 1) rate[0] = rate[1];
    return rate;
}

function sliceAnalysisDataset(dataset, f0, f1) {
    const lo = Math.max(0, Math.min(dataset.n - 1, f0));
    const hi = Math.max(lo, Math.min(dataset.n - 1, f1));
    const n = hi - lo + 1;
    const copy = (src) => {
        const out = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const a = (lo + f) * 3, b = f * 3;
            out[b] = src[a];
            out[b + 1] = src[a + 1];
            out[b + 2] = src[a + 2];
        }
        return out;
    };
    return {
        n,
        fps: dataset.fps,
        S: copy(dataset.S),
        D: copy(dataset.D),
        W: copy(dataset.W),
    };
}

function syncRangeProfile(dataset, ranges, options = {}) {
    const out = [];
    const vTarget = options.vTarget ?? null;
    const vSigma = options.vSigma ?? 50 * KNOTS_TO_MS;
    const scoreSpeedWeight = options.scoreSpeedWeight ?? 0;
    for (const startDist of ranges) {
        const {track, lam} = traversePlausible(dataset, startDist, options);
        const m = trackMetrics(dataset, track);
        let score = straightFlightScore(m);
        if (vTarget !== null && scoreSpeedWeight > 0) {
            score += scoreSpeedWeight * ((m.airSpeed.mean - vTarget) / vSigma) ** 2;
        }
        out.push({
            startDist,
            endDist: lam[dataset.n - 1],
            minDist: Math.min(...lam),
            score,
            metrics: m,
        });
    }
    return out;
}

// The "saddle traversal": the family of slow/near-static objects consistent with
// the region of least LOS motion. Locates that low-motion window, then reads the
// FAMILY off the slow-object cost curve — the contiguous range band whose
// smoothness cost stays in the low-cost valley (many ranges fit about equally,
// because a barely-moving bearing doesn't pin range). Returns a representative
// (slowest-fitting) traversal plus the window/family descriptors, or null.
function computeSaddle(dataset, slowProfile, slowOpts) {
    const {n, fps} = dataset;
    if (!slowProfile || slowProfile.length < 3 || n < 4) return null;

    // 1) Low-motion window: smooth the LOS rate, find its minimum, and grow a
    //    contiguous window around it while the rate stays near that minimum.
    const rate = losAngularRateSeries(dataset);
    const W = Math.max(1, Math.round(fps));           // ~1 s smoothing
    const sm = new Float64Array(n);
    for (let f = 0; f < n; f++) {
        let s = 0, c = 0;
        for (let k = -W; k <= W; k++) { const g = f + k; if (g >= 0 && g < n) { s += rate[g]; c++; } }
        sm[f] = s / c;
    }
    let fStar = 0;
    for (let f = 1; f < n; f++) if (sm[f] < sm[fStar]) fStar = f;
    const sorted = Array.from(sm).sort((a, b) => a - b);
    const minRate = sm[fStar];
    const medRate = sorted[Math.floor(n / 2)];
    const cut = minRate + 0.35 * (medRate - minRate);
    let f0 = fStar, f1 = fStar;
    while (f0 > 0 && sm[f0 - 1] <= cut) f0--;
    while (f1 < n - 1 && sm[f1 + 1] <= cut) f1++;

    // Genuine-window gate: a saddle window only means something if the LOS
    // rate genuinely DIPS (min well below the median) for a sustained stretch.
    // On a continuously rotating LOS (a sensor orbiting a crossing object) the
    // "minimum" is just the boxcar-smoothing tail at the clip edge — a
    // sub-second window over which EVERY range trivially fits, yielding a
    // bogus "all ranges fit equally" family.
    const genuineWindow = (minRate < 0.35 * medRate) && ((f1 - f0 + 1) / fps >= 2);

    // 2) Family band: score the same range grid over ONLY the low-motion window.
    //    The full-clip slow profile can reject the visually obvious saddle
    //    because later high-rate frames force any close, slow object into a hard
    //    maneuver. For the saddle interpretation, the family lives where the
    //    bearing barely moves. Without a genuine window, the family comes from
    //    the FULL-CLIP slow profile (already computed by the caller — free).
    let rows;
    if (genuineWindow) {
        const ranges = slowProfile.map((p) => p.startDist).filter((v) => isFinite(v) && v > 0);
        const windowDataset = sliceAnalysisDataset(dataset, f0, f1);
        const windowOpts = {
            ...slowOpts,
            K: Math.min(slowOpts.K ?? 25, Math.max(7, Math.floor(windowDataset.n / 2))),
        };
        rows = syncRangeProfile(windowDataset, ranges, windowOpts).filter((p) => isFinite(p.score));
    } else {
        rows = slowProfile.filter((p) => isFinite(p.score) && isFinite(p.startDist) && p.startDist > 0);
    }
    if (rows.length < 3) return null;
    let bi = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].score < rows[bi].score) bi = i;
    const sBest = rows[bi].score;
    const sSorted = rows.map((p) => p.score).sort((a, b) => a - b);
    const sMed = sSorted[Math.floor(sSorted.length / 2)];
    const sThresh = sBest + 0.5 * (sMed - sBest);
    let lo = bi, hi = bi;
    while (lo > 0 && rows[lo - 1].score <= sThresh) lo--;
    while (hi < rows.length - 1 && rows[hi + 1].score <= sThresh) hi++;
    // 3) Representative traversal: the SLOWEST object consistent with the whole
    //    clip (minimum air speed on the rays). The saddle exists precisely
    //    because a sensor orbiting a slow object shows mostly parallax, so the
    //    minimum-speed member is the natural representative — a barely-drifting
    //    lantern/balloon — not the fast least-maneuvering path a fixed range
    //    would force outside the low-motion window. (Anchoring one range and
    //    minimizing maneuvering gave tens of kt here; minimizing speed gives
    //    the ~10 kt drift that actually matches these cases.)
    const {track, lam} = traverseMinSpeed(dataset, {minDist: 120});
    let windowMetrics = null;
    if (genuineWindow) {
        const windowDataset = sliceAnalysisDataset(dataset, f0, f1);
        const windowTrack = new Float64Array(windowDataset.n * 3);
        for (let f = 0; f < windowDataset.n; f++) {
            const s = (f0 + f) * 3, d = f * 3;
            windowTrack[d] = track[s]; windowTrack[d + 1] = track[s + 1]; windowTrack[d + 2] = track[s + 2];
        }
        windowMetrics = trackMetrics(windowDataset, windowTrack);
    }
    const errDeg = meanAngularError(dataset, track) * 180 / Math.PI;
    // headline range = the min-speed track's median slant range (lam = range on ray)
    const lamSorted = Array.from(lam).sort((a, b) => a - b);
    const medRange = lamSorted[Math.floor(lamSorted.length / 2)];

    return {
        track, errDeg,
        window: genuineWindow
            ? {f0, f1, fStar, t0: f0 / fps, t1: f1 / fps, minRateDegS: minRate, medRateDegS: medRate}
            : null,
        family: {
            loM: rows[lo].startDist, hiM: rows[hi].startDist, repM: medRange,
            count: hi - lo + 1, total: rows.length,
        },
        boundaryLimited: lo === 0 || hi === rows.length - 1 || !!slowProfile.boundaryLimited,
        boundarySides: {
            lo: lo === 0 || !!slowProfile.boundarySides?.lo,
            hi: hi === rows.length - 1 || !!slowProfile.boundarySides?.hi,
        },
        windowMetrics,
    };
}

// ---------------------------------------------------------------------------
// Normalize the analyzer outputs into a uniform list of candidate hypotheses,
// one per distinct physical interpretation. Each entry:
//   {key, name, subtitle, color, track (Float64Array n*3 ENU | null),
//    metricsFull (trackMetrics(dataset, track) | null), errDeg, params, notes}
// The ray-riding interpretations sit exactly on the sightlines (errDeg = 0);
// the two physics models (aircraft, lantern) carry a real residual LOS error
// that says how well an object of THAT TYPE can explain the sightlines. The
// fixed/astronomical interpretations are stationary or at-infinity objects
// whose residual LOS error says whether the object could really be sitting
// still (or be a known bright body).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ground-contact analysis: terrain-aware underground rejection + ground modes.
// ---------------------------------------------------------------------------

// Signed height-above-ground (metres, negative = underground) for an ECEF
// point, using the loaded terrain model where present and sea level otherwise
// (getPointBelow falls back to the sphere). Mirrors clampAboveGround's math.
function signedAGL(ecefPoint) {
    const out = {};
    const ground = getPointBelow(ecefPoint, false, out);
    const pAlt = out.altitudeHAE !== undefined ? out.altitudeHAE : calculateAltitude(ecefPoint);
    return pAlt - calculateAltitude(ground);
}

// Sample an ENU track's height above the terrain. Returns worst (min) AGL,
// max AGL, start/end AGL and the fraction of sampled points more than
// UNDERGROUND_TOL below the surface. The ENU->ECEF conversion runs once for
// the whole track; the pricier terrain lookup is sampled.
function trackGroundStats(track, n, originLat, originLon, samples = 48) {
    if (!track || n < 1) return null;
    const ecef = unpackTrackToECEF(track, n, originLat, originLon);
    const step = Math.max(1, Math.floor((n - 1) / samples) || 1);
    let minAGL = Infinity, maxAGL = -Infinity, below = 0, tested = 0;
    for (let f = 0; f < n; f += step) {
        const agl = signedAGL(ecef[f].position);
        if (agl < minAGL) minAGL = agl;
        if (agl > maxAGL) maxAGL = agl;
        if (agl < -UNDERGROUND_TOL) below++;
        tested++;
    }
    return {
        minAGL, maxAGL,
        startAGL: signedAGL(ecef[0].position),
        endAGL: signedAGL(ecef[n - 1].position),
        fracBelow: tested ? below / tested : 0,
    };
}

// Local terrain elevation (ENU up, ~HAE metres) near the scene — the height of
// the flat "ground plane" the Ground Vehicle candidate rides. Sampled at the
// frame-0 sightline's sea-level intersection (≈0 over ocean). Exported so the
// live "Ground Vehicle" traverse method computes the same plane the gallery
// fitted — applying the tile reproduces its track.
export function localGroundZ(dataset, originLat, originLon) {
    const ecef = localGroundProbeECEF(dataset, originLat, originLon);
    const out = {};
    const ground = getPointBelow(ecef, false, out);
    return calculateAltitude(ground);
}

function localGroundProbeECEF(dataset, originLat, originLon) {
    const S = dataset.S, D = dataset.D;
    let hx = 0, hy = 0;
    if (D[2] < -1e-4) {
        const t = -S[2] / D[2];
        if (t > 0) { hx = S[0] + t * D[0]; hy = S[1] + t * D[1]; }
    }
    return unpackTrackToECEF(new Float64Array([hx, hy, 0]), 1,
        originLat, originLon)[0].position;
}

function terrainDependencySample(key, ecefPoint) {
    const terrain = NodeMan.get("TerrainModel", false);
    const queryECEF = typeof ecefPoint.clone === "function" ? ecefPoint.clone() : ecefPoint;
    if (terrain && typeof terrain.getPointBelowWithTileInfo === "function") {
        const info = terrain.getPointBelowWithTileInfo(ecefPoint, 0);
        return {
            key,
            groundAltitudeM: calculateAltitude(info.point),
            tileZ: Number.isFinite(info.tileZ) ? info.tileZ : -1,
            queryECEF,
        };
    }
    return {key, groundAltitudeM: calculateAltitude(getPointBelow(ecefPoint)), tileZ: -1, queryECEF};
}

function resampleTerrainDependencies(records) {
    if (!Array.isArray(records) || records.some((record) => !record?.queryECEF)) return null;
    return records.map((record) => terrainDependencySample(record.key, record.queryECEF));
}

// Capture only terrain values that contributed to the cached interpretation:
// the local ground prior/shell and the same candidate-corridor samples used by
// underground/contact grading. Render-camera LOD elsewhere is intentionally
// absent, so orbiting mainView cannot invalidate expensive physics fits.
function captureTerrainDependencies(dataset, hypotheses, originLat, originLon, samples = 48) {
    const records = [terrainDependencySample("local-ground",
        localGroundProbeECEF(dataset, originLat, originLon))];
    for (let hi = 0; hi < (hypotheses || []).length; hi++) {
        const h = hypotheses[hi];
        if (!h?.track || h.atInfinity || h.identity) continue;
        if (h.params && (h.params.object !== undefined || h.params.satellite !== undefined)) continue;
        const n = h.track.length / 3;
        if (!(n >= 1)) continue;
        const ecef = unpackTrackToECEF(h.track, n, originLat, originLon);
        const step = Math.max(1, Math.floor((n - 1) / samples) || 1);
        const frames = new Set([0, n - 1]);
        for (let f = 0; f < n; f += step) frames.add(f);
        for (const f of Array.from(frames).sort((a, b) => a - b)) {
            records.push(terrainDependencySample(
                `${h.key || hi}:${hi}:${f}`, ecef[f].position));
        }
    }
    return records;
}

// Whether a hypothesis's ground stats violate the requested ground-contact
// mode. Returns a short reason string, or null if consistent with the mode.
function groundContactViolation(stats, mode) {
    if (!stats) return null;
    switch (mode) {
        case "On the ground":
            return stats.maxAGL > GROUND_CONTACT_TOL ? "airborne (not a ground vehicle)" : null;
        case "Starts on ground":
            return stats.startAGL > GROUND_CONTACT_TOL ? "does not start on the ground" : null;
        case "Ends on ground":
            return stats.endAGL > GROUND_CONTACT_TOL ? "does not end on the ground" : null;
        default:
            return null;
    }
}

// Physics models that solve their own wind must be evaluated in that solved
// air mass. Using the external sitch-wind dataset here makes a perfect wind
// tracer report the full ground-drift speed as "air speed" and can change its
// plausibility tier. Return a lightweight dataset view with the model's own
// per-frame wind displacement.
function datasetForSolvedModelWind(dataset, track, solved, modelKind) {
    if (!solved || !Number.isFinite(solved.windE) || !Number.isFinite(solved.windN)) {
        return dataset;
    }
    const W = new Float64Array(dataset.n * 3);
    const dt = 1 / dataset.fps;
    const x0 = track[0], y0 = track[1], z0 = track[2];
    const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_RADIUS_M);
    const nm1 = Math.max(1, dataset.n - 1);   // normalised time runs 0..1 over the clip
    for (let f = 0; f < dataset.n; f++) {
        let we = solved.windE, wn = solved.windN, mult = 1;
        if (modelKind === "lantern") {
            // Reconstruct the SAME wind the model integrated, including its
            // time-varying part (SkyLanternModel._windAt): base + drift·s +
            // curve·s². Omitting it made the balloon's air-relative metrics
            // (airspeed, etc.) subtract the wrong wind — see TA-04.
            const s = f / nm1;
            we += (solved.windDriftE || 0) * s + (solved.windCurveE || 0) * s * s;
            wn += (solved.windDriftN || 0) * s + (solved.windCurveN || 0) * s * s;
            const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
            const h = z + (x * x + y * y) / (2 * EARTH_RADIUS_M);
            mult = Math.max(0.25, Math.min(3, 1 + (solved.shearPerM || 0) * (h - h0)));
        }
        W[f * 3] = we * mult * dt;
        W[f * 3 + 1] = wn * mult * dt;
    }
    return {...dataset, W};
}

function pinLabel(pin) {
    return pin.name + (pin.side === "lo" ? " (min)" : " (max)");
}

function splitBoundPins(records, include, constraintId = (p) => p.name) {
    const active = new Map();
    const inactive = new Map();
    const unstable = new Map();
    for (const pin of records || []) {
        if (!include(pin)) continue;
        const target = pin.inwardBetter ? unstable : pin.loadBearing === false ? inactive : active;
        const id = constraintId(pin);
        if (!target.has(id)) target.set(id, pinLabel(pin));
    }
    return {active, inactive, unstable};
}

function physicsBoundSubtitle(base, active, inactive, unstable = []) {
    const parts = [];
    if (active.length) parts.push(`locally load-bearing limit${active.length === 1 ? "" : "s"}: ${active.join(", ")}`);
    if (inactive.length) parts.push(`unconstrained at bound: ${inactive.join(", ")}`);
    if (unstable.length) parts.push(`inward probe improved the fit: ${unstable.join(", ")}`);
    return parts.length ? `${base} — ${parts.join("; ")}` : base;
}

// Build a Sky Lantern / Balloon hypothesis from a fitPhysicsModel result.
// Used for BOTH the free-wind fit and the measured-wind fit (same model, the
// wind either inferred or softly pinned), so the two reconstructions appear as
// distinct hypotheses that share grouping/apply/prose (both keyed "lantern").
function lanternHypothesis(fit, dataset, errFloor, {key, name, notes, windPolicy}) {
    if (!fit || !fit.positions) {
        return {
            key, name, subtitle: "Wind-drift model unavailable", color: VIZ.slowObj,
            track: null, metricsFull: null, errDeg: NaN, params: {},
            notes: "Fit failed — no plausible buoyant-object trajectory converged.",
        };
    }
    const S = dataset.S;
    const track = fit.positions;
    const range0 = Math.hypot(track[0] - S[0], track[1] - S[1], track[2] - S[2]);
    const solved = fit.params.solved || {};
    const lanternMetrics = trackMetrics(
        datasetForSolvedModelWind(dataset, track, solved, "lantern"), track);
    // Side-aware bound pins: a pin at a natural ZERO (vRise/vSink lo bound =
    // "not rising/sinking") is physical for a becalmed balloon; only capability
    // MAX pins and range/wind extremes mean "the data wants more than a balloon".
    const lanSplit = splitBoundPins(fit.params.pinned,
        (p) => (["initialRange", "windE", "windN", "shearPerM",
            "windDriftE", "windDriftN", "windCurveE", "windCurveN"].includes(p.name))
            || (["vRise", "vSink"].includes(p.name) && p.side === "hi"),
        (p) => p.name === "shearPerM" ? "windShear" : p.name);
    const lanClamps = [];
    if (Number.isFinite(solved.shearPerM)) {
        const x0 = track[0], y0 = track[1], z0 = track[2];
        const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_RADIUS_M);
        let hitsShearClamp = false;
        for (let f = 0; f < dataset.n; f++) {
            const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
            const h = z + (x * x + y * y) / (2 * EARTH_RADIUS_M);
            const raw = 1 + solved.shearPerM * (h - h0);
            if (raw <= 0.25 * 1.001 || raw >= 3 / 1.001) { hitsShearClamp = true; break; }
        }
        if (hitsShearClamp) lanClamps.push("wind shear multiplier (0.25–3× clamp)");
    }
    const lanPins = Array.from(lanSplit.active.values());
    const lanInactive = Array.from(lanSplit.inactive.values());
    const lanUnstable = Array.from(lanSplit.unstable.values());
    return {
        key, name,
        subtitle: physicsBoundSubtitle("Bounded wind-drift/life-cycle model", lanPins, lanInactive, lanUnstable)
            + (lanClamps.length ? `; internal clamp reached: ${lanClamps.join(", ")}` : ""),
        color: VIZ.slowObj,
        track,
        metricsFull: lanternMetrics,
        errDeg: fit.params.errDeg,
        boundPinned: lanPins,
        boundInactive: lanInactive,
        modelClamps: lanClamps,
        optimizerWarnings: lanUnstable,
        params: {
            range: range0,
            windE: solved.windE, windN: solved.windN, shearPerM: solved.shearPerM,
            // Time-varying wind coefficients (linear + quadratic change in each
            // component across the clip), disclosed so the fit is reproducible
            // from the visible parameters — see TA-04.
            windDriftE: solved.windDriftE, windDriftN: solved.windDriftN,
            windCurveE: solved.windCurveE, windCurveN: solved.windCurveN,
            vRise: solved.vRise, vSink: solved.vSink, tBurn: solved.tBurn, tauCool: solved.tauCool,
            clipT: (dataset.n - 1) / dataset.fps,
            windPolicy,
            // Soft-prior cost at the solution, so a tile that says its wind was
            // INFERRED can be checked against what the calm-wind prior paid.
            priors: fit.params.priors,
            errFloor,
        },
        notes,
    };
}

function buildHypotheses({dataset, sweep, ca, plausible, aircraft, lantern, lanternMeasured, quad, satellite,
    slowProfile, slowOpts, losNode, originLat, originLon, provenance = null, failures = null,
    windPrior = null, mcSweep = null, droneCtl = null}) {
    const S = dataset.S;
    const globalFrame = (f) => (dataset.frame0 ?? 0) + f;
    const dateForDatasetFrame = (f) => dateAtDatasetFrame(dataset, f);
    const list = [];
    // Surface motion is constrained relative to Earth, not the air mass. Use a
    // zero-wind metric view so road speed, acceleration/g and headings are
    // ground-relative; otherwise a head/tailwind changes the vehicle verdict.
    const groundMetricDataset = {...dataset, W: new Float64Array(dataset.W.length)};

    // Generic reference residual (degrees): the mean angular error left by a
    // deterministic constant-acceleration path with no object-type assumption.
    // It combines pointing error, real target maneuver, and model mismatch; it
    // is useful scale context but is not a measured sensor-noise floor.
    let errFloor = NaN;
    try {
        const fTimes = new Float64Array(dataset.n);
        for (let f = 0; f < dataset.n; f++) fTimes[f] = f / dataset.fps;
        // minRange keeps the free fit off its degenerate optimum: on a
        // straight-and-level sensor the unconstrained CA fit collapses onto
        // the sensor's own path (zero perpendicular residual, ~90 deg angular
        // error) and the floor annotation would silently lie.
        const caFree = fitConstantAcceleration(
            {sensorPos: dataset.S, losDir: dataset.D, times: fTimes, count: dataset.n,
                maxRange: null, minRange: 500},
            new Set());
        if (caFree && caFree.positions) {
            errFloor = meanAngularError(dataset, caFree.positions) * 180 / Math.PI;
        }
    } catch (e) { /* annotation degrades gracefully; floor stays NaN */ }

    // 1. Constant air speed — smoothest ray-following path that holds a fixed
    //    air speed (QP solve; honest small residual). The sweep's family
    //    representative is prior-anchored on the Target Speed GUI value (a
    //    fast-jet default), so a genuinely SLOW object (balloon, drifting
    //    debris) can live in the slow range-profile valley the sweep never
    //    represents. Build an honest constant-air-speed candidate at the slow
    //    valley's best range too, re-score both on the same neutral metric
    //    (their internal scores use different priors/smoothing and must never
    //    be compared raw), and keep the fast pick unless the slow candidate
    //    wins DECISIVELY (see slowRegimeWins).
    {
        const regimePick = pickConstAirRegime(dataset, sweep, slowProfile);
        const fastTrack = regimePick.fast.track;
        const fastScored = regimePick.fast.scored;
        const slowPick = regimePick.useSlow
            ? {...regimePick.slow, fastScore: fastScored.score}
            : null;

        const boundaryPins = [];
        if (slowPick) {
            if (slowProfile.boundaryLimited) boundaryPins.push("range (slow-profile search edge)");
        } else {
            if (sweep.boundaryAxes?.range) {
                const rLo = Math.min(...sweep.ranges), rHi = Math.max(...sweep.ranges);
                if (sweep.familyBand?.rangeLo <= rLo * 1.001) boundaryPins.push("range (lower search edge)");
                if (sweep.familyBand?.rangeHi >= rHi * 0.999) boundaryPins.push("range (upper search edge)");
            }
            if (sweep.boundaryAxes?.speed) {
                const vLo = Math.min(...sweep.speeds), vHi = Math.max(...sweep.speeds);
                if (sweep.familyBand?.speedLo <= vLo * 1.001) boundaryPins.push("speed (lower search edge)");
                if (sweep.familyBand?.speedHi >= vHi * 0.999) boundaryPins.push("speed (upper search edge)");
            }
        }

        if (slowPick) {
            list.push({
                key: "constAir",
                name: "Constant Air Speed",
                subtitle: `Slow-drift valley: ~${kt1(slowPick.speed)} kt near ${nm1(slowPick.row.startDist)} NM`,
                color: VIZ.constAir,
                track: slowPick.track,
                metricsFull: slowPick.scored.metrics,
                errDeg: slowPick.scored.errDeg,
                searchBounds: boundaryPins.length ? boundaryPins : undefined,
                params: {
                    range: slowPick.row.startDist, airSpeed: slowPick.speed, errFloor,
                    regime: "slow",
                    slowScore: slowPick.scored.score, fastScore: slowPick.fastScore,
                    boundaryLimited: slowProfile.boundaryLimited ? 1 : 0,
                },
                notes: "The smoothest path following the LOS rays while holding air speed fixed. "
                    + `The slow-object range valley (${nm1(slowPick.row.startDist)} NM at ~${kt1(slowPick.speed)} kt) `
                    + `outscored the fast sweep's prior-anchored representative on the shared smoothness metric `
                    + `(${slowPick.scored.score.toFixed(2)} vs ${slowPick.fastScore.toFixed(2)}, lower is better) — `
                    + `the evidence prefers a slow drifting object over anything near the Target Speed prior.`,
            });
        } else {
            list.push({
                key: "constAir",
                name: "Constant Air Speed",
                subtitle: (sweep.familyBand && sweep.familyBand.count > 1)
                    ? `Family: ${kt1(sweep.familyBand.speedLo)}–${kt1(sweep.familyBand.speedHi)} kt at ` +
                      `${nm1(sweep.familyBand.rangeLo)}–${nm1(sweep.familyBand.rangeHi)} NM fit about equally`
                    : "Fixed airspeed, wind-corrected",
                color: VIZ.constAir,
                track: fastTrack,
                metricsFull: fastScored.metrics,
                errDeg: fastScored.errDeg,
                searchBounds: boundaryPins.length ? boundaryPins : undefined,
                params: {
                    range: sweep.best.startDist, airSpeed: sweep.best.speed, errFloor,
                    familyRangeLo: sweep.familyBand?.rangeLo, familyRangeHi: sweep.familyBand?.rangeHi,
                    familySpeedLo: sweep.familyBand?.speedLo, familySpeedHi: sweep.familyBand?.speedHi,
                    familyCount: sweep.familyBand?.count,
                    boundaryLimited: sweep.boundaryLimited ? 1 : 0,
                },
                notes: "The smoothest path following the LOS rays while holding air speed fixed."
                    + ((sweep.familyBand && sweep.familyBand.count > 1)
                        ? ` ${sweep.familyBand.count} grid cells fit about equally — the shown cell is the`
                          + ` family member closest to the Target Speed prior, not a uniquely determined answer.`
                        : "")
                    + (sweep.boundaryLimited
                        ? ` The supported family reaches the ${[
                            sweep.boundaryAxes?.range ? "range" : null,
                            sweep.boundaryAxes?.speed ? "speed" : null,
                        ].filter(Boolean).join(" and ")} search boundary — treat the affected value as a bound, not a resolved optimum.`
                        : ""),
            });
        }
    }

    // 2. Constant altitude — level flight crossing each ray at a fixed height.
    //    The displayed track is the lightly SMOOTHED ray-rider (honest small
    //    errDeg); near-horizontal sightlines never cross a constant-altitude
    //    plane, in which case the fit reports failure and gets a null tile.
    if (ca && !ca.failed) {
        const track = ca.track;
        list.push({
            key: "constAlt",
            name: "Constant Altitude",
            subtitle: "Level flight at a fixed height",
            color: "#d05fb0",
            track,
            metricsFull: trackMetrics(dataset, track),
            errDeg: ca.errDeg ?? 0,
            params: {range: ca.startDist, altZ: ca.altZ, errFloor,
                boundaryLimited: ca.boundaryLimited ? 1 : 0},
            notes: "Object held at a fixed geodetic altitude, following the sightlines to a small residual."
                + (ca.boundaryLimited ? " The selected altitude reaches the search edge and is unresolved." : ""),
        });
    } else {
        list.push({
            key: "constAlt",
            name: "Constant Altitude",
            subtitle: "Level flight at a fixed height",
            color: "#d05fb0",
            track: null,
            metricsFull: null,
            errDeg: NaN,
            params: {},
            notes: "Fit failed — the sightlines are near-horizontal and never cross a constant-altitude plane.",
        });
    }

    // 3. Least-maneuvering plausible path — smoothest ray-riding trajectory.
    //    Two-stage: geometry-decisive scenes pick the range purely by
    //    smoothness; narrow-baseline scenes fall back to the soft speed target.
    {
        const track = plausible.track;
        list.push({
            key: "plausible",
            name: "Minimum Acceleration",
            subtitle: plausible.usedSpeedTarget
                ? "Acceleration-minimizing path at any range (soft speed target)"
                : "Acceleration-minimizing path at any range (geometry-picked)",
            color: VIZ.fastObj,
            track,
            metricsFull: trackMetrics(dataset, track),
            errDeg: meanAngularError(dataset, track) * 180 / Math.PI,
            searchBounds: plausible.boundaryLimited ? [
                plausible.boundarySides?.lo ? "range (lower search edge)" : null,
                plausible.boundarySides?.hi ? "range (upper search edge)" : null,
            ].filter(Boolean) : undefined,
            params: {
                range: plausible.startDist,
                usedSpeedTarget: plausible.usedSpeedTarget,
                decisiveness: plausible.decisiveness,
                boundaryLimited: plausible.boundaryLimited ? 1 : 0,
                errFloor,
            },
            notes: (plausible.usedSpeedTarget
                ? "The smoothest trajectory that follows every line of sight; the geometry left the range " +
                  "ambiguous, so the soft speed target picked the representative member."
                : "The smoothest trajectory that follows every line of sight; the smoothness-vs-range " +
                  "profile picks the range on its own, so no speed assumption was needed.")
                + (plausible.boundaryLimited
                    ? " The selected range is on the search edge and is therefore unresolved."
                    : ""),
        });
    }

    // 3b. Saddle traversal — the slow/near-static family anchored on the region
    //     of least LOS motion (a sensor orbiting a slow object). Represents the
    //     "it's a mundane slow thing and the motion is parallax" reading, and
    //     the family (range band) that the low-motion geometry leaves open.
    {
        const saddle = computeSaddle(dataset, slowProfile, slowOpts);
        if (saddle) {
            const m = trackMetrics(dataset, saddle.track);
            const w = saddle.window, fam = saddle.family;
            // Window params/notes only when a GENUINE low-motion window exists
            // (w is null on a continuously rotating LOS — then the family band
            // comes from the full-clip slow profile and the range is pinned
            // rather than ambiguous).
            const windowParams = w ? {
                saddleT0: w.t0, saddleT1: w.t1, saddleFStar: w.fStar,
                minRateDegS: w.minRateDegS, medRateDegS: w.medRateDegS,
                windowAirMean: saddle.windowMetrics.airSpeed.mean,
                windowAirMax: saddle.windowMetrics.airSpeed.max,
                windowGMax: saddle.windowMetrics.gLoad.max,
            } : {};
            const familyNote = w
                ? `Over the ${w.t0.toFixed(1)}–${w.t1.toFixed(1)} s low-motion window the bearing barely moves, `
                    + `so a whole range band (${nm1(fam.loM)}–${nm1(fam.hiM)} NM) fits about equally.`
                : `The slow-object cost valley pins the range to ${nm1(fam.loM)}–${nm1(fam.hiM)} NM `
                    + `(${fam.count} of ${fam.total} grid ranges); no low-motion window exists in this clip.`;
            list.push({
                key: "saddle",
                name: "Minimum Speed",
                subtitle: "Slowest object consistent with the sightlines",
                color: "#e0a35e",
                track: saddle.track,
                metricsFull: m,
                errDeg: saddle.errDeg,
                params: {
                    range: fam.repM,
                    ...windowParams,
                    familyLoM: fam.loM, familyHiM: fam.hiM, familyCount: fam.count, familyTotal: fam.total,
                    boundaryLimited: saddle.boundaryLimited ? 1 : 0,
                    errFloor,
                },
                searchBounds: saddle.boundaryLimited ? [
                    saddle.boundarySides?.lo ? "range (lower search edge)" : null,
                    saddle.boundarySides?.hi ? "range (upper search edge)" : null,
                ].filter(Boolean) : undefined,
                notes: `The slowest object that stays on the sightlines (${kt1(m.airSpeed.mean)} kt mean). `
                    + familyNote
                    + (saddle.boundaryLimited ? " The supported family reaches the search boundary and is incomplete." : ""),
            });
        }
    }

    // 4. Fixed-wing aircraft model — parametric fit with a small residual error.
    {
        const track = aircraft.track;
        const aircraftMetrics = trackMetrics(dataset, track);
        // Only locally load-bearing bounds demote the model. Coordinates that
        // happen to sit at a bound in a flat/inactive direction are reported as
        // unresolved rather than misrepresented as capability violations.
        const fwSplit = splitBoundPins(aircraft.pinned,
            (p) => ["startDist", "tas", "turnRate", "turnAccel", "climb"].includes(p.name));
        const fwPins = Array.from(fwSplit.active.values());
        const fwInactive = Array.from(fwSplit.inactive.values());
        const fwUnstable = Array.from(fwSplit.unstable.values());
        // Name the nearest common fixed-wing type from the solved TAS/climb —
        // a closest PERFORMANCE ENVELOPE, never an identification.
        const totalAirSpeed = Math.hypot(aircraft.params.tas, aircraft.params.climb);
        const fwClass = classifyFixedWing(totalAirSpeed, aircraft.params.climb,
            aircraftMetrics.gLoad.max, aircraftMetrics.altitude.max);
        const nearFW = !fwPins.length && fwClass.compatible ? fwClass.model : null;
        list.push({
            key: "aircraft",
            name: "Fixed-Wing Aircraft (generic prior)",
            subtitle: physicsBoundSubtitle(
                nearFW ? "Closest containing envelope: " + nearFW.name + " (not an ID)"
                    : "Generic fixed-wing fit; no named catalog envelope contains the solved motion",
                fwPins, fwInactive, fwUnstable),
            color: VIZ.aircraft,
            track,
            metricsFull: aircraftMetrics,
            errDeg: aircraft.errDeg,
            boundPinned: fwPins,
            boundInactive: fwInactive,
            optimizerWarnings: fwUnstable,
            params: {
                range: aircraft.params.startDist,
                heading: aircraft.params.heading,
                tas: aircraft.params.tas,
                totalAirSpeed,
                turn: aircraft.params.turnRate,
                climb: aircraft.params.climb,
                closest: nearFW ? nearFW.name : null,
                priors: aircraft.params.priors,
                errFloor,
            },
            notes: "Constant horizontal-air-speed fixed-wing model fit to the sightlines by differential evolution."
                + (fwPins.length ? " Locally load-bearing parameters reach the generic prior limits (" + fwPins.join(", ")
                    + ") — treat this model test as incomplete, not as excluding every fixed-wing aircraft."
                    : (nearFW ? " Closest common type by performance envelope: " + nearFW.name + " (not an identification)." : "")),
        });
    }

    // 5. balloon (Sky Lantern / Balloon) — TWO reconstructions from the same
    //    wind-tracer model, the two ways of treating wind:
    //      (a) FINDING the wind: fitted freely, no wind input at all;
    //      (b) USING the existing wind: drift softly pinned to the sitch's wind.
    //    Both keyed "lantern" so they share the forward-model group, apply path,
    //    and prose. The pinned variant is named for its PROVENANCE — a measured
    //    sounding/GFS profile and a hand-set constant are both usable, but they
    //    are not equally good evidence, so the label says which one it was.
    const windMeasured = windPrior ? windPrior.measured : false;
    const pinnedWindLabel = windMeasured ? "measured wind" : "sitch wind";
    list.push(lanternHypothesis(lantern, dataset, errFloor, {
        key: "lantern",
        name: lanternMeasured ? "Sky Lantern / Balloon (free wind)" : "Sky Lantern / Balloon",
        windPolicy: "free-diagnostic: wind fitted by this model, no wind input",
        notes: "FREE reconstruction: wind-drift lantern kinematics (rise, buoyancy decay, terminal "
            + "sink; altitude-sheared wind) fit to the sightlines with the wind INFERRED, not assumed. "
            + "The inferred wind is what a plausible balloon here would require.",
    }));
    if (lanternMeasured) {
        const windDesc = windPrior && windPrior.statusText ? ` (${windPrior.statusText})` : "";
        list.push(lanternHypothesis(lanternMeasured, dataset, errFloor, {
            key: "lantern",
            name: `Sky Lantern / Balloon (${pinnedWindLabel})`,
            windPolicy: windMeasured
                ? `measured-corrected: drift wind pinned loosely to the loaded ${windPrior.source} profile`
                : "assumed-wind: drift wind pinned loosely to the hand-set sitch wind (an assumption, not a measurement)",
            notes: windMeasured
                ? "MEASURED-wind reconstruction: the same model with its drift wind softly anchored "
                    + `to the loaded winds aloft${windDesc} (kept loose — a sonde can be 200+ mi and 12 h away). `
                    + "Compare its residual and inferred profile against the free fit."
                : "SITCH-wind reconstruction: the same model with its drift wind softly anchored to the "
                    + `sitch's hand-set wind${windDesc}. That wind is an ASSUMPTION, not a measurement, so `
                    + "treat this as \"what a balloon would look like IF the wind is as set\" — the free fit, "
                    + "which infers the wind the sightlines actually require, is the stronger evidence.",
        }));
    }

    // 5b. Quadcopter (multirotor drone) physics model — a hover-capable
    //     near-field object. Its range is capped at 20 km, so far-field
    //     scenes give a poor (correctly implausible) fit. Degrade gracefully.
    if (quad && quad.positions) {
        const track = quad.positions;
        const range0 = Math.hypot(track[0] - S[0], track[1] - S[1], track[2] - S[2]);
        const solved = quad.params.solved || {};
        const quadMetrics = trackMetrics(
            datasetForSolvedModelWind(dataset, track, solved, "quadcopter"), track);
        const T = (dataset.n - 1) / dataset.fps;
        const peakSpeed = Math.max(Math.abs(solved.speed || 0),
            Math.abs((solved.speed || 0) + (solved.accel || 0) * T));
        // Side-aware: zero air-relative speed is passive drift and is not a
        // capability violation; speed MAX, range extremes, and climb extremes are.
        const quadSplit = splitBoundPins(quad.params.pinned,
            (p) => (p.name === "initialRange")
                || (p.name === "speed" && p.side === "hi")
                || ["accel", "turnRate", "turnAccel", "climb", "windE", "windN"].includes(p.name),
            (p) => p.name === "speed" ? "speedEnvelope" : p.name);
        // Acceleration can drive the derived speed beyond the model envelope
        // even when the initial-speed parameter itself is not pinned.
        if (peakSpeed > 60 * 1.001) {
            quadSplit.active.set("speedEnvelope", "derived speed (above max)");
            quadSplit.inactive.delete("speedEnvelope");
        }
        const quadPins = Array.from(quadSplit.active.values());
        const quadInactive = Array.from(quadSplit.inactive.values());
        const quadUnstable = Array.from(quadSplit.unstable.values());
        // Signed climb: a descent must be checked against maxDescent, not
        // Math.max(ascent, descent) — see classifyQuadcopter.
        const quadClass = classifyQuadcopter(peakSpeed, solved.climb || 0);
        const near = !quadPins.length && quadClass.compatible ? quadClass.model : null;
        list.push({
            key: "quadcopter",
            name: "Quadcopter",
            subtitle: physicsBoundSubtitle(
                near ? "Closest containing envelope: " + near.name + " (not an ID)"
                    : "Generic multirotor fit; no named catalog envelope contains the solved motion",
                quadPins, quadInactive, quadUnstable),
            color: "#5bb1c9",
            track,
            metricsFull: quadMetrics,
            errDeg: quad.params.errDeg,
            boundPinned: quadPins,
            boundInactive: quadInactive,
            optimizerWarnings: quadUnstable,
            params: {
                range: range0,
                speed: solved.speed,
                peakSpeed,
                climb: solved.climb,
                windE: solved.windE,
                windN: solved.windN,
                closest: near ? near.name : null,
                windPolicy: "wind fitted by this model",
                // Nothing wires a wind prior into this model, so its calm-wind
                // fallback is ALWAYS the active branch — worth showing.
                priors: quad.params.priors,
                errFloor,
            },
            notes: "Hover-capable multirotor kinematics (bounded/penalized air-relative speed, climb and turn rate) "
                + "fit to the sightlines"
                + (quadPins.length ? "; the solve rammed the model's own limits (" + quadPins.join(", ")
                    + ") — this generic multirotor test is boundary-limited."
                    : (near ? "; closest common model by envelope: " + near.name + " (not an identification)." : ".")),
        });
    } else {
        list.push({
            key: "quadcopter",
            name: "Quadcopter",
            subtitle: "Multirotor model unavailable",
            color: "#5bb1c9",
            track: null,
            metricsFull: null,
            errDeg: NaN,
            params: {},
            notes: "Fit failed — no plausible multirotor trajectory converged "
                + "(e.g. the object is too far or too fast for a drone).",
        });
    }

    // 5c. Drone as CONTROL INPUTS — the plausible-flight counterpart to the
    //     free multirotor above. Same object class, different question: not
    //     "is there ANY path inside the drone envelope that fits?" (almost
    //     always yes, which is why the free fit produced a 61-revolution
    //     corkscrew on Aguadilla) but "is there a path a drone is actually
    //     FLOWN along that fits?" — a few held inputs with occasional changes.
    //     Plausibility is priced in the control effort, so nothing is
    //     foreclosed: an aggressive manoeuvre is affordable if the sightlines
    //     genuinely demand it, and only motion that buys nothing is priced out.
    if (droneCtl && droneCtl.positions) {
        const track = droneCtl.positions;
        const m = droneCtl.model;
        const pv = droneCtl.solvedVector || [];
        const dm = trackMetrics(dataset, track);
        const range0 = Math.hypot(track[0] - S[0], track[1] - S[1], track[2] - S[2]);
        const headingTravel = m ? m.headingTravelDeg(pv) : NaN;
        // The comparison that makes this hypothesis mean something: how much
        // better the UNCONSTRAINED multirotor did. A small gap says an ordinary
        // flight explains the sightlines as well as any contortion; a large one
        // says they demand motion outside ordinary drone flight, which is a
        // finding rather than something to hide behind a contorted "fit".
        const freeErr = (quad && quad.params && Number.isFinite(quad.params.errDeg))
            ? quad.params.errDeg : null;
        const ownErr = droneCtl.params.errDeg;
        const gap = freeErr !== null ? ownErr - freeErr : null;
        list.push({
            key: "droneControl",
            name: "Drone (flown inputs)",
            subtitle: m ? m.describe(pv) : "Control-input fit",
            color: "#7fc4d0",
            track,
            metricsFull: dm,
            errDeg: ownErr,
            params: {
                range: range0,
                headingTravelDeg: headingTravel,
                knots: m ? m.K : DRONE_CONTROL_KNOTS,
                freeModelErrDeg: freeErr,
                plausibleVsPossibleGapDeg: gap,
                priors: droneCtl.params.priors,
                errFloor,
            },
            notes: (m ? `Fitted as the control inputs a drone would be flown with — ${m.describe(pv)}. ` : "")
                + "Seeded from the best geometric path (Kalman smoother or least-manoeuvring track), "
                + "inverted into the speed, heading and climb history needed to fly it, then refined "
                + "against the sightlines. "
                + "Holding an input costs nothing; changing one costs, so an ordinary flight is free "
                + "and only motion that buys no residual is priced out. Nothing is forbidden — an "
                + "aggressive manoeuvre remains reachable if the sightlines require it.\n\n"
                + (Number.isFinite(headingTravel)
                    ? `Total heading change over the clip: ${headingTravel.toFixed(0)}°`
                        + (headingTravel > 720 ? ` (${(headingTravel / 360).toFixed(1)} revolutions — unusual for a deliberate flight).` : ".")
                    : "")
                + (gap !== null
                    ? ` The unconstrained multirotor reaches ${freeErr.toFixed(3)}°, so an ordinary flight `
                        + (gap <= 0
                            ? "matches or beats it — the sightlines need no unusual motion."
                            : `costs ${gap.toFixed(3)}° more. Compare that against the scene's own `
                                + `${Number.isFinite(errFloor) ? errFloor.toFixed(2) : "?"}° reference before reading it as significant.`)
                    : ""),
        });
    }

    // 6. Ground object — a stationary light pinned to the LOCAL SURFACE height
    //    (terrain where loaded, sea level over ocean — localGroundZ), not raw
    //    ENU z=0: over land a z=0 pin sits below the terrain and was wrongly
    //    auto-flagged Underground. Always runs; cheap closed-form fit.
    {
        const groundZ0 = localGroundZ(dataset, originLat, originLon);
        const ground = fitGroundPoint(dataset, groundZ0);
        list.push({
            key: "ground",
            name: "Ground Object",
            subtitle: "A fixed light on the surface",
            color: "#8a6f4a",
            track: ground.track,
            metricsFull: trackMetrics(groundMetricDataset, ground.track),
            errDeg: ground.errDeg,
            params: {distance: ground.distance, groundZ: groundZ0, motionFrame: "ground"},
            notes: "A stationary light on the local surface; high LOS error means the sightlines don't converge on a ground point.",
        });
    }

    // 7. Fixed point in space — a stationary object at an unknown location, or a
    //    fixed (parallax-free / astronomical) direction if very distant. Cheap;
    //    gated only so the user can hide it (default on).
    if (analyzeTweaks.aoFixedPoint) {
        const fixedPt = fitFixedPoint(dataset, {});
        const fixedDir = fitFixedDirection(dataset);
        // A stationary object is either a finite point (sightlines converge on
        // it) or — if the fixed-DIRECTION fit is as good — an object so distant
        // the sightlines stay parallel: a "fixed point in the sky" like the Moon
        // or a star, effectively at infinity. Draw the latter as parallel rays,
        // not a converging point.
        const atInfinity = fixedDir.errDeg <= fixedPt.errDeg;
        list.push({
            key: "fixedPoint",
            name: atInfinity ? "Fixed Point in the Sky" : "Stationary Point in Space",
            subtitle: atInfinity ? "Distant light, effectively at infinity (e.g. the Moon)"
                                 : "Stationary object at a fixed location",
            color: "#9aa0a8",
            track: fixedPt.track,
            atInfinity,
            identity: atInfinity,   // a point at infinity has no finite traverse to apply
            metricsFull: trackMetrics(dataset, fixedPt.track),
            errDeg: Math.min(fixedPt.errDeg, fixedDir.errDeg),
            params: {distance: fixedPt.distance, dirErrDeg: fixedDir.errDeg},
            notes: atInfinity
                ? "A fixed point in the sky — a light so far the sightlines stay parallel (like the Moon or a star). The LOS error says whether one fixed direction explains the sightlines."
                : "A single stationary point in space; the LOS error says whether the object could be sitting still at one location.",
        });
    }

    // 7b. Satellite (LEO pass) — a real catalogued object propagated by SGP4,
    //     the best match out of the whole LEO catalogue for the sitch's date.
    if (satellite && satellite.best) {
        const b = satellite.best;
        const track = satelliteTrackENU(b.satrec, dataset.n, dateForDatasetFrame, originLat, originLon);
        const midF = Math.floor(dataset.n / 2);
        const satEcefMid = satelliteECEF(b.satrec, dateForDatasetFrame(midF));
        const sunlit = satEcefMid ? satelliteSunlit(satEcefMid, dateForDatasetFrame(midF)) : null;
        const altKm = satEcefMid ? Math.round((satEcefMid.length() - 6371000) / 1000) : null;
        list.push({
            key: "satellite",
            name: "Satellite: " + b.name,
            subtitle: `Best LEO pass of ${satellite.loaded} checked`,
            color: "#6fd3c9",
            track,
            identity: true,   // an identification, not a selectable traverse method
            metricsFull: trackMetrics(dataset, track),
            errDeg: b.errDeg,
            params: {satellite: b.name, satnum: b.satnum, offsetDeg: b.errDeg, sunlit,
                altitudeKm: altKm, loaded: satellite.loaded},
            notes: `${b.name} passes ${b.errDeg.toFixed(2)}° from the sightlines`
                + (sunlit === false ? ", but is in Earth's shadow (not sunlit)"
                    : sunlit ? " and is sunlit" : "") + ".",
        });
    }

    // 8. Astronomical — known object, at the clip's time. Ephemeris sweep over
    //    the bright planets/stars for whichever best fits the sightlines NOW.
    //    Gated OFF by default (ephemeris + star loop is the cost).
    if (analyzeTweaks.aoKnownNow && losNode) {
        try {
            const midF = Math.floor(dataset.n / 2);
            const date = dateForDatasetFrame(midF);
            const sensorECEF = losNode.v(globalFrame(midF)).position;   // topocentric + refraction anchor
            const fovDeg = sensorFOVDeg();
            const boost = fovMagBoost(fovDeg);
            // Combined cost = angular miss + a penalty for faintness (so a dim
            // body like Neptune isn't reported as "the object" over a bright,
            // similarly-placed one). Brightness = FOV-boosted apparent magnitude.
            const consider = (name, dirRaw, mag) => {
                if (!dirRaw) return;
                const dir = refractDir(dirRaw, sensorECEF);
                const errDeg = losMeanAngleDeg(losNode, dir, dataset.frame0 ?? 0, dataset.frame1 ?? (losNode.frames - 1));
                const effMag = mag - boost;
                const cost = errDeg + Math.max(0, effMag) * 0.4;
                if (!best || cost < best.cost) best = {name, dir, errDeg, mag, effMag, cost};
            };
            let best = null;
            const PLANETS = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
            for (const name of PLANETS) {
                // Moon: ~1° of parallax -> use topocentric direction; far bodies negligible.
                const dirRaw = name === "Moon"
                    ? getCelestialDirection(name, date, sensorECEF)
                    : getGeocentricBodyDirectionECEF(name, date);
                consider(name, dirRaw, bodyMagnitude(name, date));
            }
            // Stars — only when the sitch loaded the night sky. Consider anything
            // the FOV-boosted sensor could see (bounded), not just naked-eye stars.
            const sf = NodeMan.get("NightSkyNode", false)?.starField;
            if (sf && sf.BSC_NumStars) {
                const starMagCut = Math.min(7, AO_VISIBLE_LIMIT + boost);
                for (let i = 0; i < sf.BSC_NumStars; i++) {
                    if (!(sf.BSC_MAG[i] < starMagCut)) continue;
                    consider(sf.getStarName(i + 1) || ("HIP" + sf.BSC_HIP[i]),
                        getCelestialDirectionFromRaDec(sf.BSC_RA[i], sf.BSC_DEC[i], date), sf.BSC_MAG[i]);
                }
            }
            if (best) {
                const visible = best.effMag < AO_VISIBLE_LIMIT;
                const track = farAstroTrack(dataset, best.dir, originLat, originLon);
                list.push({
                    key: "astroNow",
                    name: "Astronomical: " + best.name,
                    subtitle: "Best bright object at the clip's time",
                    color: "#c9d4e5",
                    track,
                    atInfinity: true,
                    identity: true,
                    metricsFull: trackMetrics(dataset, track),
                    errDeg: best.errDeg,
                    params: {object: best.name, offsetDeg: best.errDeg, mag: best.mag,
                        effMag: best.effMag, visible, fovDeg},
                    notes: `${best.name} (mag ${best.mag.toFixed(1)}) would sit ${best.errDeg.toFixed(2)}° `
                        + `from the sightlines; ${visible ? "bright enough" : "too faint"} to see at the `
                        + `${fovDeg.toFixed(fovDeg < 2 ? 2 : 1)}° sensor FOV${refractionOptsFromUniforms().enabled ? " (refraction applied)" : ""}.`,
                });
            }
        } catch (e) {
            console.warn("Astronomical (known object, this time) hypothesis skipped:", e);
        }
    }

    // 9. Astronomical — known object, find the time ("when would Venus solve
    //    it"). For each bright planet, search a time window for when it best
    //    aligns with the mean sightline. Gated OFF by default (time search).
    if (analyzeTweaks.aoKnownOther && losNode) {
        try {
            const m = meanLOSDir(losNode, dataset.frame0 ?? 0, dataset.frame1 ?? (losNode.frames - 1));
            const sensorECEF = losNode.v(globalFrame(Math.floor(dataset.n / 2))).position;
            const fovDeg = sensorFOVDeg();
            const boost = fovMagBoost(fovDeg);
            const baseMs = dateForDatasetFrame(Math.floor(dataset.n / 2)).valueOf();
            const DAY = 86400000, HOUR = 3600000;
            const BODIES = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"];
            const angleAt = (body, ms) => {
                const dir = refractDir(getGeocentricBodyDirectionECEF(body, new Date(ms)), sensorECEF);
                return angleBetweenDeg(dir.x, dir.y, dir.z, m[0], m[1], m[2]);
            };
            let best = null;
            for (const body of BODIES) {
                // coarse: +/-180 days at 1-day steps
                let coarse = null;
                for (let d = -180; d <= 180; d++) {
                    const ms = baseMs + d * DAY;
                    const a = angleAt(body, ms);
                    if (!coarse || a < coarse.a) coarse = {ms, a};
                }
                // refine: +/-1 day at hourly steps
                let fine = coarse;
                for (let hh = -24; hh <= 24; hh++) {
                    const ms = coarse.ms + hh * HOUR;
                    const a = angleAt(body, ms);
                    if (a < fine.a) fine = {ms, a};
                }
                // Rank by alignment AND brightness at that time (a faint
                // planet aligning is a worse explanation than a bright one).
                const mag = bodyMagnitude(body, new Date(fine.ms));
                const cost = fine.a + Math.max(0, mag - boost) * 0.4;
                if (!best || cost < best.cost) best = {body, ms: fine.ms, a: fine.a, mag, cost};
            }
            if (best) {
                const bestDate = new Date(best.ms);
                const dir = refractDir(getGeocentricBodyDirectionECEF(best.body, bestDate), sensorECEF);
                const effMag = best.mag - boost;
                const visible = effMag < AO_VISIBLE_LIMIT;
                const track = farAstroTrack(dataset, dir, originLat, originLon);
                list.push({
                    key: "astroTime",
                    name: "Astronomical (best time): " + best.body,
                    subtitle: "When a bright planet would align",
                    color: "#b7a2e0",
                    track,
                    atInfinity: true,
                    identity: true,
                    metricsFull: trackMetrics(dataset, track),
                    errDeg: best.a,
                    params: {object: best.body, timeUTC: bestDate.toISOString(), offsetDeg: best.a,
                        mag: best.mag, effMag, visible, fovDeg},
                    notes: `${best.body} (mag ${best.mag.toFixed(1)}) aligns best on ${bestDate.toDateString()} `
                        + `(residual ${best.a.toFixed(2)}°); ${visible ? "bright enough" : "too faint"} at the `
                        + `${fovDeg.toFixed(fovDeg < 2 ? 2 : 1)}° sensor FOV.`,
                });
            }
        } catch (e) {
            console.warn("Astronomical (find time) hypothesis skipped:", e);
        }
    }

    // Every OTHER selectable traverse method, read straight off its live node so
    // it competes on the same footing and "Use" re-selects exactly it. (Constant
    // Speed/Altitude, Minimum Acceleration, Physics and Minimum Speed above
    // already map to their methods; these are the global statistical fits and
    // the straight line. Monte Carlo uses a fixed seed, so it is a stable,
    // reproducible contender.)
    const sel = resolveTraverseSelect();
    const extraMethods = [
        {key: "gfCV", label: "Global Fit: Constant Velocity", subtitle: "Least-squares constant-velocity fit", color: "#8bd17c"},
        // label = the switch-inputs KEY (never renamed, saved sitches store it);
        // display = what the user sees, matching the menu's display label.
        {key: "gfCA", label: "Global Fit: Const Acceleration", display: "Global Fit: Constant Acceleration", subtitle: "Least-squares constant-acceleration fit", color: "#67b89a"},
        {key: "gfKalman", label: "Global Fit: Kalman Smoother", subtitle: "Kalman-smoothed LOS fit", color: "#57a8c6"},
        // Monte Carlo 1/2 are NOT read off their live nodes here — they are
        // swept over polynomial order below (see the MC sweep block).
        {key: "straightLine", label: "Straight Line", subtitle: "Straight constant-velocity line", color: "#cf8fae"},
    ];
    if (provenance?.measuredSubstituted) {
        // The live method nodes fit the JetLOS switch's CURRENT (constructed)
        // sightlines; grading those fits against the substituted measured
        // dataset would mix evidence — the tiles would look wrong for the
        // wrong reason and their "apply" would re-fit different rays. Skip
        // them and say so, rather than counting them silently.
        failures?.push({
            method: "Live-method contenders (Global Fit family, Straight Line)",
            error: "they fit the currently selected constructed LOS; this analysis used the "
                + "measured sensor LOS instead",
        });
    } else if (sel && sel.inputs) {
        // LOS-only signature: a method node's cached fit is stale if the LOS
        // changed, even when its own GUI params did not.
        const losSig = String(analysisFingerprint(losNode, [], dataset.frame0 ?? 0,
            dataset.frame1 ?? ((dataset.frame0 ?? 0) + dataset.n - 1)));
        for (const meth of extraMethods) {
            let node = sel.inputs[meth.label];
            if (typeof node === "string") node = NodeMan.get(node, false);
            if (!node || typeof node.p !== "function") continue;
            const h = methodNodeHypothesis(meth, node, dataset, originLat, originLon, losSig);
            if (h) list.push(h);
        }
    }

    // ---- Curve-fit polynomial-order sweep tiles ---------------------------
    // Each fitting strategy is swept over polynomial order and every order gets
    // its own tile. The sitch's single shared "MC Polynomial Order" control
    // (mcOrder) is almost always left at its default 1 — where the curve is a
    // straight line in time, i.e. constant velocity — so without the sweep the
    // Monte Carlo tiles were near-duplicates of the constant-velocity fit and
    // the effect of order was invisible.
    //
    // Swept here rather than read off the live CNodeLOSFitMonteCarlo nodes (as
    // the other Global Fit methods are), because driving them would mean
    // mutating that shared GUI value once per order and firing its change
    // handlers. Every strategy is still reproducible — the Monte Carlo pair via
    // a fixed random seed, the alternating fit because it uses no randomness —
    // and "Use exact" installs the reviewed trajectory via applyContext below.
    //
    // READ THESE AS A METHOD DIAGNOSTIC, NOT A RANKING. A higher-order curve can
    // always hug the sightlines more closely simply because it bends more, so a
    // low residual high in the sweep is arithmetic rather than evidence about
    // the object. Measured on a real sitch, one strategy beat another on
    // residual at every order while being FURTHER from the truth track at every
    // order. What the sweep genuinely shows is how much curvature the
    // sightlines admit, and where extra order stops buying anything.
    //
    // The fits themselves run in runTraverseAnalysis (far too slow to do
    // synchronously here — see sweepPolynomialOrders); this only turns the
    // finished results into tiles.
    {
        const mcTrials = mcSweep?.numTrials;
        for (const {variant, order, result: res} of (mcSweep?.results ?? [])) {
            {
                const track = Float64Array.from(res.positions);
                const m = trackMetrics(dataset, track);
                const errDeg = meanAngularError(dataset, track) * 180 / Math.PI;
                const nonPhysical = !isFinite(m.airSpeed.mean)
                    || m.airSpeed.mean / KNOTS_TO_MS > 20000 || !(m.gLoad.max < 2000);
                const ranges = new Float64Array(dataset.n);
                for (let f = 0; f < dataset.n; f++) {
                    ranges[f] = Math.hypot(track[f * 3] - S[f * 3],
                        track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
                }
                const sortedR = Array.from(ranges).sort((a, b) => a - b);
                list.push({
                    key: variant.key,
                    name: `${variant.name} (order ${order})`,
                    subtitle: `${ORDER_NAMES[order] ?? ("order " + order)} — ${variant.flavour}`
                        + (variant.key === "gfPolyALS" ? "" : ", fixed seed"),
                    color: variant.color,
                    track, metricsFull: m, errDeg, nonPhysical,
                    params: {
                        range: sortedR[Math.floor(dataset.n / 2)],
                        mcOrder: order,
                        // The alternating fit doesn't sample, so the trial count
                        // and LOS-uncertainty settings don't apply to it.
                        ...(variant.key === "gfPolyALS" ? {} : {
                            mcTrials,
                            mcLOSUncertaintyDeg: mcSweep?.losUncertaintyDeg,
                        }),
                    },
                    notes: (variant.key === "gfPolyALS"
                        ? `A curve of degree ${order} (${ORDER_NAMES[order] ?? "higher order"}) fitted to `
                            + "the sightlines by repeated best-fit: guess how far away the object was on each "
                            + "sightline, draw the best curve through those points, slide each point along its "
                            + "own sightline to sit nearest that curve, and repeat. No random guessing, so it "
                            + "gives the same answer every time. Its distances are free to move well away from "
                            + "the constant-velocity starting guess, unlike the Monte Carlo fits."
                        : `Monte-Carlo curve fit of degree ${order} `
                            + `(${ORDER_NAMES[order] ?? "higher order"}) to the sightlines, `
                            + `${mcTrials ?? 500} random trials at a fixed seed. Its distances are only `
                            + "ever sampled within 0.9x to 1.1x of the constant-velocity fit"
                            + (Number.isFinite(mcSweep?.seedMedian)
                                ? ` (median ${(mcSweep.seedMedian / METERS_PER_NM).toFixed(2)} NM)`
                                : "")
                            + ", so it cannot propose a much nearer or further object than that fit "
                            + "already found.")
                        + " "
                        + (order === 1
                            ? "Degree 1 is a straight line in time — a constant-speed, constant-direction path — "
                                + "so this tile should closely match the constant-velocity fit."
                            : "A higher degree can always hug the sightlines more closely, simply because it has "
                                + "more freedom to bend, so a lower error here is NOT by itself proof of a better "
                                + "answer — in testing, higher degrees sometimes matched the sightlines better "
                                + "while drifting further from the real path. Compare against the lower degrees: "
                                + "a large improvement suggests the sightlines genuinely require a curved path, a "
                                + "small one suggests the extra freedom is just absorbing noise. Note also that a "
                                + `degree-${order} curve can only change direction about ${Math.max(1, Math.floor(order / 2))} `
                                + "time(s) across the whole clip.")
                        + " Shown as a fitting-method diagnostic, not an independent object hypothesis.",
                });
            }
        }
    }

    // Ground Vehicle — where the sightlines meet a curved constant-elevation shell at the
    // local terrain height. A moving ground point, distinct from the stationary
    // Ground Object. Offered when the analysis is constrained to on-ground
    // solutions; only meaningful if most sightlines actually reach the ground.
    if (analyzeTweaks.groundMode === "On the ground") {
        const groundZ = localGroundZ(dataset, originLat, originLon);
        const gv = fitGroundVehicle(dataset, groundZ);
        if (gv.fracValid >= 0.98) {
            const track = gv.track;
            list.push({
                key: "groundVehicle",
                name: "Ground Vehicle",
                subtitle: "A vehicle moving on the surface",
                color: "#9c7a4a",
                track,
                metricsFull: trackMetrics(groundMetricDataset, track),
                errDeg: meanAngularError(dataset, track) * 180 / Math.PI,
                params: {groundZ, fracValid: gv.fracValid, errFloor, motionFrame: "ground"},
                notes: "The moving point where each sightline meets the ground. A high implied speed means "
                    + "no ordinary ground vehicle can be the object.",
            });
        } else {
            list.push({
                key: "groundVehicle",
                name: "Ground Vehicle",
                subtitle: "A vehicle moving on the surface",
                color: "#9c7a4a",
                track: null, metricsFull: null, errDeg: NaN,
                params: {fracValid: gv.fracValid},
                notes: `Only ${(100 * gv.fracValid).toFixed(0)}% of sightlines reach the ground surface. `
                    + "A track made by holding the last intersection through invalid frames would be artificial, "
                    + "so this candidate is rejected.",
            });
        }
    }

    // Ground-contact / underground flagging. In EVERY mode, reject candidates
    // that pass underground (never a valid solution). In a constrained mode,
    // additionally flag candidates that don't meet the requested ground
    // contact. Only near-field physical tracks are tested — not points at
    // infinity, astronomical bodies, or satellite identifications.
    {
        const mode = analyzeTweaks.groundMode;
        for (const h of list) {
            if (!h.track || h.atInfinity || h.identity) continue;
            if (h.params && (h.params.object !== undefined || h.params.satellite !== undefined)) continue;
            const stats = trackGroundStats(h.track, h.track.length / 3, originLat, originLon);
            if (!stats) continue;
            h.groundStats = stats;
            // Even ground-native solvers use an idealized curved shell sampled
            // from one terrain point. Validate them against the actual terrain;
            // otherwise a shell can pass through a ridge and still be promoted.
            if (stats.minAGL < -UNDERGROUND_TOL && stats.fracBelow >= 0.05) {
                h.underground = {depth: -stats.minAGL, frac: stats.fracBelow};
            }
            const violation = groundContactViolation(stats, mode);
            if (violation) h.groundMismatch = {mode, reason: violation};
        }
    }

    // Metadata needed to install the exact reviewed ENU trajectory into the
    // live scene without re-running a different solver.
    for (const h of list) {
        if (h.track) {
            h.applyContext = {
                originLat,
                originLon,
                frame0: dataset.frame0 ?? 0,
            };
        }
    }
    return list;
}

// A live fit node's cached array can be stale (its params or the LOS changed),
// but the recalculate cascade does NOT dirty an *unselected* fit node, so we
// can't trust its own _dirty flag. Remember the input signature (LOS hash + the
// node's GUI params) each analysis last force-freshed it at, and recompute only
// when that changes — so an unchanged Monte Carlo fit isn't re-run every time.
const _methodNodeSig = new Map();
function methodNodeParamSig(node) {
    let sig = "";
    const inp = node.in || {};
    for (const k of Object.keys(inp).sort()) {
        const v = inp[k] ? inp[k].v0 : undefined;
        if (typeof v === "number" && isFinite(v)) sig += k + "=" + v + ";";
    }
    return sig;
}

// Read an existing traverse-method node's own output track over the analysis
// frame range and package it as a hypothesis, in the analysis ENU frame, so a
// selectable method competes like any fitted contender. Returns null if the
// node has no usable track (e.g. a manual method left at a degenerate default).
function methodNodeHypothesis(meth, node, dataset, originLat, originLon, losSig) {
    const {n, S} = dataset;
    const f0 = dataset.frame0 ?? 0;
    // Recompute this node ONLY when its own inputs changed since the last
    // analysis (the LOS, its GUI params, or the physical-time scale that
    // enters fit datasets via buildLOSDataset); otherwise reuse its cached
    // array. Two refresh mechanisms: the fit nodes use the _dirty pattern,
    // the CNodeTrack traverses (e.g. Straight Line) use the lazy
    // _needsRecalculate bake honored by ensureRecalculated() on read — a
    // "_dirty"-only check left Straight Line serving a stale baked track
    // (packaged AND installable via "Use exact") after its inputs changed.
    const sigKey = node.id || meth.label;
    const sig = losSig + "|" + methodNodeParamSig(node)
        + "|t=" + (Sit.simSpeed ?? 1) + "/" + Sit.fps;
    if (_methodNodeSig.get(sigKey) !== sig) {
        if ("_dirty" in node) {
            node._dirty = true;
        } else if ("_needsRecalculate" in node) {
            node._needsRecalculate = true;
        } else {
            try { node.recalculate(); } catch (e) { /* read below reports null */ }
        }
        _methodNodeSig.set(sigKey, sig);
    }
    const track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        let pos;
        try { pos = node.p(f0 + f); } catch (e) { return null; }
        if (!pos || !isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) return null;
        const enu = ECEF2ENU_radii(pos, originLat, originLon);
        track[f * 3] = enu.x; track[f * 3 + 1] = enu.y; track[f * 3 + 2] = enu.z;
    }
    const m = trackMetrics(dataset, track);
    // A method whose finite track is non-physical (e.g. a manual Straight Line
    // left at its default endpoints -> absurd speed/g) is still shown as a
    // contender for completeness, but flagged so it ranks dead last. Real
    // traverses here are well under these bounds.
    const nonPhysical = !isFinite(m.airSpeed.mean) || m.airSpeed.mean / KNOTS_TO_MS > 20000 || !(m.gLoad.max < 2000);
    const errDeg = meanAngularError(dataset, track) * 180 / Math.PI;
    const ranges = new Float64Array(n);
    for (let f = 0; f < n; f++) {
        ranges[f] = Math.hypot(track[f * 3] - S[f * 3], track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
    }
    const sorted = Array.from(ranges).sort((a, b) => a - b);
    const shown = meth.display ?? meth.label;
    return {
        key: meth.key, name: shown, subtitle: meth.subtitle, color: meth.color,
        track, metricsFull: m, errDeg, nonPhysical,
        params: {range: sorted[Math.floor(n / 2)], methodLabel: meth.label},
        notes: nonPhysical
            ? `The ${shown} method's current track is non-physical (its endpoints/parameters don't fit the sightlines) — shown for completeness; selecting it applies exactly this path.`
            : `The ${shown} traverse fit, read straight from the sitch — selecting it applies exactly this path.`,
    };
}

// Data-driven verdict paragraph (HTML): group-specific screening results plus
// a diagnostic head-to-head of the two forward-integrated physics models.
// Residuals are never converted into object-type probabilities.
// meters → "412 m" / "2.4 NM" for truth-separation displays
function fmtSepMeters(v) {
    if (!isFinite(v)) return "n/a";
    if (v >= METERS_PER_NM) {
        const nm = v / METERS_PER_NM;
        return `${nm >= 10 ? nm.toFixed(0) : nm.toFixed(1)} NM`;
    }
    return `${Math.round(v)} m`;
}

function buildVerdict(hypotheses, capturedProvenance = null, truth = null) {
    const withTrack = (hypotheses || []).filter((h) => h.track && h.metricsFull);
    const groups = groupAndRankHypotheses(withTrack);

    let out = "";
    // Constructed-LOS gate: conclusions from target-derived sightlines are
    // internal-consistency checks, and must never read as discovery.
    const prov = capturedProvenance || losProvenance();
    if (prov.circular) {
        out += `<strong>⚠ Constructed LOS — validation only:</strong> ${escapeHtml(prov.reason)} ` +
            `Everything below describes the scene's internal consistency, not independent inference. `;
    }
    if (prov.measuredSubstituted) {
        out += `<strong>Measured sensor LOS used:</strong> ${escapeHtml(prov.substitutionNote ?? "")} `;
    }
    if (prov.rangeUnobservable) {
        out += `<strong>⛔ Range not determined by the evidence:</strong> the sensor's motion over the ` +
            `analysis window (baseline ${Math.round(prov.sensorSpan ?? 0)} m) is negligible at the assumed ` +
            `working distance, so the sightlines contain no usable parallax — every distance along them ` +
            `fits equally well, and each method's range reflects its own priors, not measurement. `;
    }

    // Truth mode: the summary is about closeness to the reference track.
    // All methods are measured against the same external reference with the
    // same metric, so unlike the screening tiers this comparison IS
    // meaningful across groups.
    if (truth) {
        out += `<strong>Scored against the truth track "${escapeHtml(truth.label)}".</strong> ` +
            `Every method is measured by its mean 3D separation from the reference trajectory ` +
            `over the analysis window — smaller means it reproduces the truth more closely — and ` +
            `ordered by that separation. `;
        const comparable = groups.flatMap((g) => g.items)
            .filter((item) => item.h.truthComparison?.comparable)
            .sort((a, b) => a.h.truthComparison.score - b.h.truthComparison.score);
        if (comparable.length) {
            const best = comparable[0];
            out += `Overall, <strong>${escapeHtml(best.h.name)}</strong> comes closest to the truth, ` +
                `at a mean 3D separation of <strong>${escapeHtml(fmtSepMeters(best.h.truthComparison.score))}</strong>. `;
        }
        for (const group of groups) {
            const leader = group.items[0];
            if (!leader) continue;
            const groupName = escapeHtml(group.shortLabel);
            const tc = leader.h.truthComparison;
            if (tc?.comparable) {
                const second = group.items[1];
                const stc = second?.h?.truthComparison;
                const secondText = stc?.comparable
                    ? ` (next: <strong>${escapeHtml(second.h.name)}</strong> at ${escapeHtml(fmtSepMeters(stc.score))})`
                    : "";
                out += `Within ${groupName}, <strong>${escapeHtml(leader.h.name)}</strong> is closest at ` +
                    `<strong>${escapeHtml(fmtSepMeters(tc.score))}</strong>${secondText}. `;
            } else {
                out += `Within ${groupName}, no candidate could be compared against the truth track. `;
            }
        }
        out += `The per-method breakdowns below report where each candidate agrees with or diverges from ` +
            `the truth (location, altitude, speed, heading). Screening tiers (maneuvering, speed, LOS ` +
            `residual) are shown only as context; they do not control the order.`;
        return out;
    }

    out += `<strong>No global object winner is computed.</strong> The panels answer different questions and are ` +
        `ranked only within comparable groups. `;
    for (const group of groups) {
        const leader = group.items[0];
        if (!leader) continue;
        const ties = group.items.filter((item) => item.tied);
        const groupName = escapeHtml(group.shortLabel);
        if (leader.r.eligible) {
            if (ties.length > 1) {
                out += `Within ${groupName}, ${ties.map((item) => `<strong>${escapeHtml(item.h.name)}</strong>`).join(" and ")} ` +
                    `fall within the 0.05 display-score threshold; this is not a statistical tie. `;
            } else {
                out += `Within ${groupName}, <strong>${escapeHtml(leader.h.name)}</strong> has the lowest ` +
                    `within-group score among results that pass the broad screen. `;
            }
        } else {
            const incomplete = leader.r.boundaryLimited ? " and its search is incomplete" : "";
            out += `Within ${groupName}, no complete result passes the broad screen; the first displayed result is ` +
                `<strong>${escapeHtml(leader.h.name)}</strong> (${escapeHtml(leader.r.label)}${incomplete}). `;
        }
    }

    const aircraftHyp = withTrack.find((h) => h.key === "aircraft");
    const lanternHyp = withTrack.find((h) => h.key === "lantern");
    if (aircraftHyp && lanternHyp && isFinite(aircraftHyp.errDeg) && isFinite(lanternHyp.errDeg)) {
        const ae = aircraftHyp.errDeg, le = lanternHyp.errDeg;
        const pinNote = (aircraftHyp.boundPinned?.length || lanternHyp.boundPinned?.length)
            ? ` (note: ${[aircraftHyp.boundPinned?.length ? "the aircraft fit" : null,
                          lanternHyp.boundPinned?.length ? "the lantern fit" : null]
                    .filter(Boolean).join(" and ")} hit model limits — treat that side's residual as a lower bound)`
            : "";
        out += `Comparing the two physics-based models head to head, the fixed-wing model fits the ` +
            `sightlines to <strong>${ae.toFixed(3)}°</strong> versus the lantern's ` +
            `<strong>${le.toFixed(3)}°</strong>${pinNote}. These residuals are <strong>not a ` +
            `like-for-like object-type probability</strong>: the models have different parameters, bounds, ` +
            `wind treatment, and priors, so the smaller training residual does not identify the object. `;
        // Put those residuals beside a flexible reference fit without claiming
        // that the reference isolates sensor noise.
        const floor = (lanternHyp.params && lanternHyp.params.errFloor)
            ?? (aircraftHyp.params && aircraftHyp.params.errFloor);
        if (isFinite(floor) && floor >= 0.02) {
            out += `(For scale, a free constant-acceleration reference path ` +
                `leaves <strong>${floor.toFixed(2)}°</strong> on these sightlines. That is a model-reference ` +
                `residual, not an estimate of sensor noise.) `;
        }
    } else if (aircraftHyp && isFinite(aircraftHyp.errDeg)) {
        out += `The fixed-wing model fits the sightlines to ` +
            `<strong>${aircraftHyp.errDeg.toFixed(3)}°</strong> (the lantern fit did not converge, ` +
            `so no head-to-head is available). `;
    }

    out += `These criteria are deliberately soft, and LOS-only data often do not uniquely resolve range. ` +
        `Treat each group as a sensitivity and compatibility screen, not a cross-group probability or definitive answer.`;
    return out;
}

// ---------------------------------------------------------------------------
// Menu button
// ---------------------------------------------------------------------------

// controller per folder object; the traverse menu is rebuilt per sitch, so a
// stale entry is detected by checking the folder still lists the controller
const analyzeButtons = new WeakMap();

/**
 * Idempotently add the "Analyze Traverse Methods..." button to a lil-gui folder
 * (normally guiMenus.traverse). Safe to call again after the menu has been
 * destroyed and rebuilt for a new sitch.
 * @returns the lil-gui controller (or null if no folder)
 */
export function addAnalyzeButton(folder) {
    if (!folder) return null;
    // Local-only debug hook so MCP / console can reach the module-scoped
    // analysis internals (mirrors window._objectTracker in CObjectTracking.js).
    // Checked here, not at module scope: isLocal is a mutable binding that is
    // still false when the bundle initializes (checkLocal() runs later).
    if (isLocal && !window._traverseDebug) {
        window._traverseDebug = {
            buildAnalysisDataset,
            resolveLOSNode,
            fitPhysicsModel,
            SkyLanternModel,
            QuadcopterModel,
            DroneControlModel,
            knotsForDuration,
            fitKalmanFilter,
            fitPlausibleBestRange,
            datasetForSolvedModelWind,
            traverseMinSpeed,
            trackMetrics,
            meanAngularError,
            runTraverseAnalysis,
        };
    }
    const existing = analyzeButtons.get(folder);
    if (existing && folder.controllers && folder.controllers.includes(existing)) {
        return existing;   // already present in this incarnation of the folder
    }
    const proxy = {
        analyze: () => {
            runTraverseAnalysis().catch((error) => {
                showError("Traverse analysis failed: " + (error && error.message), error);
            });
        },
    };
    const controller = folder.add(proxy, "analyze")
        .name(t("traverseAnalysis.analyzeButton", {defaultValue: "Analyze Traverse Methods..."}));
    if (controller.tooltip) {
        controller.tooltip("Search for physically plausible object trajectories consistent " +
            "with the lines of sight, and generate an HTML report");
    }
    analyzeButtons.set(folder, controller);
    return controller;
}

// The traverse menu (guiMenus.traverse) persists across sitches while its
// contents are rebuilt, so track the tweaks subfolder per parent folder and
// destroy the previous incarnation before recreating it.
const tweaksFolders = new WeakMap();

// --- "Truth Track" reference dropdown -------------------------------------
// Populated with the loaded data tracks; the selected track (if any) becomes
// the ground-truth reference the gallery scores every method against.
let _truthTrackCtrl = null;            // current lil-gui controller (rebuilt per sitch)
let _truthTrackListener = null;        // our live tracksChanged hook, so we can unregister it
const _autoSelectedTruthIDs = new Set();  // Truth_ tracks we already auto-selected once
let _autoSelectTruthGen = -1;             // sitch generation the set above belongs to (TA-20)

// Current {label → trackID} options for the dropdown, from the loaded tracks.
function truthTrackOptions() {
    const options = {};
    if (!TrackManager) return options;
    TrackManager.iterate((key, trackOb) => {
        if (trackOb?.trackID && trackOb?.trackNode) {
            options[trackOb.menuText ?? trackOb.trackID] = trackOb.trackID;
        }
    });
    return options;
}

// Rebuild the dropdown's option list in place from the currently loaded
// tracks. Runs on tweaks-folder construction and on every tracksChanged
// event (imports AND removals — deserialization re-adds tracks through the
// same path). Auto-selects a newly appearing "Truth_" track exactly once,
// so the user can still deselect it without the refresh fighting them.
function refreshTruthTrackOptions() {
    const ctrl = _truthTrackCtrl;
    if (!ctrl || !ctrl._names) return;

    const options = truthTrackOptions();

    // sync the option list in place (keep the leading "-" none entry)
    for (const name of [...ctrl._names]) {
        if (name !== TRUTH_NONE && options[name] === undefined) {
            removeOptionFromGUIMenu(ctrl, name);
        }
    }
    for (const [label, id] of Object.entries(options)) {
        if (!ctrl._names.includes(label)) {
            addOptionToGUIMenu(ctrl, label, id);
        }
    }

    // drop a selection whose track no longer exists
    if (analyzeTweaks.truthTrack !== TRUTH_NONE
        && !Object.values(options).includes(analyzeTweaks.truthTrack)) {
        analyzeTweaks.truthTrack = TRUTH_NONE;
    }

    // auto-select a newly loaded Truth_ track (once per track id, PER SITCH).
    // The "already auto-selected" memory is scoped to the sitch generation
    // (bumped on every teardown) — otherwise, after a reload or a switch to a
    // different sitch that happens to reuse a truth id, the reset controls would
    // never re-auto-select it because the id was seen in a previous sitch (TA-20).
    if (Globals.loadGeneration !== _autoSelectTruthGen) {
        _autoSelectedTruthIDs.clear();
        _autoSelectTruthGen = Globals.loadGeneration;
    }
    if (analyzeTweaks.truthTrack === TRUTH_NONE) {
        for (const [label, id] of Object.entries(options)) {
            if (/^truth_/i.test(label) && !_autoSelectedTruthIDs.has(id)) {
                _autoSelectedTruthIDs.add(id);
                analyzeTweaks.truthTrack = id;
                break;
            }
        }
    }
    ctrl.updateDisplay();
}

// Resolve the selected truth track to its live nodes, or null if none/gone.
function resolveTruthTrack() {
    const id = analyzeTweaks.truthTrack;
    if (!id || id === TRUTH_NONE || !NodeMan.exists(id)) return null;
    let found = null;
    TrackManager.iterate((key, trackOb) => {
        if (!found && trackOb?.trackID === id) found = trackOb;
    });
    if (!found || !found.trackNode) return null;
    return {
        trackID: id,
        label: found.menuText ?? id,
        trackNode: found.trackNode,
        dataNode: found.trackDataNode ?? null,
    };
}

// Sample the selected truth track onto the analysis dataset's frame grid, in
// the dataset's local ENU frame, with a per-frame validity mask limited to
// the track's own time span (the track node clamps/holds outside its data,
// which must not be scored as if it were real positions).
// Returns {track, valid, label, trackID} or null if none selected / unusable.
function buildTruthReference(dataset, originLat, originLon) {
    const truthSel = resolveTruthTrack();
    if (!truthSel) return null;
    const {n, frame0} = dataset;
    const track = new Float64Array(n * 3);
    const valid = new Uint8Array(n);

    // valid time window from the track's DATA node (ms since epoch)
    let t0 = -Infinity, t1 = Infinity;
    const dataNode = truthSel.dataNode;
    if (dataNode && typeof dataNode.getTrackStartTime === "function") {
        t0 = dataNode.getTrackStartTime();
        if (typeof dataNode.getTrackEndTime === "function") t1 = dataNode.getTrackEndTime();
    }

    let anyValid = false;
    for (let f = 0; f < n; f++) {
        const pos = truthSel.trackNode.p(frame0 + f);
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
            valid[f] = 0;
            continue;
        }
        const enu = ECEF2ENU_radii(pos, originLat, originLon);
        track[f * 3] = enu.x;
        track[f * 3 + 1] = enu.y;
        track[f * 3 + 2] = enu.z;
        const tMs = dateAtDatasetFrame(dataset, f).valueOf();
        valid[f] = (tMs >= t0 && tMs <= t1) ? 1 : 0;
        if (valid[f]) anyValid = true;
    }
    if (!anyValid) {
        console.warn("Traverse analysis: truth track has no time overlap with the analysis window");
    }
    return {track, valid, label: truthSel.label, trackID: truthSel.trackID};
}

/**
 * Idempotently add the "Traverse Analysis Tweaks" subfolder to the traverse
 * menu. Holds the Min/Max analysis-distance GUI values plus the three
 * astronomical/fixed-object hypothesis checkboxes (bound to analyzeTweaks).
 * Safe to call again after the menu has been rebuilt for a new sitch.
 * @returns the lil-gui folder (or null if no parent menu)
 */
export function addAnalyzeTweaks(traverseMenu) {
    if (!traverseMenu) return null;

    // destroy any previous incarnation of the folder (menu rebuilt per sitch)
    const prev = tweaksFolders.get(traverseMenu);
    if (prev) { try { prev.destroy(); } catch (e) { /* already gone */ } }

    const folder = traverseMenu.addFolder("Traverse Analysis Tweaks").close();
    tweaksFolders.set(traverseMenu, folder);

    // Min/Max distance envelope for the traverse analysis lives here now. The
    // traverse menu is rebuilt per sitch, so dispose any existing node of that
    // id first so the new controller lands on the new folder.
    if (NodeMan.exists("analysisMinDist")) NodeMan.unlinkDisposeRemove("analysisMinDist");
    if (NodeMan.exists("analysisMaxDist")) NodeMan.unlinkDisposeRemove("analysisMaxDist");

    new CNodeGUIValue({
        id: "analysisMinDist",
        value: 0, start: 0, end: 1000, step: 1,
        desc: "Min Dist",
        color: "#C0E0FF",
        unitType: "big",
        tooltip: "Lower bound on start range used by the traverse analysis (0 = no limit).",
    }, folder);

    new CNodeGUIValue({
        id: "analysisMaxDist",
        value: 1000, start: 0, end: 1000, step: 1,
        desc: "Max Dist",
        color: "#C0E0FF",
        unitType: "big",
        tooltip: "Upper bound on start range used by the traverse analysis.",
    }, folder);

    const groundMode = folder.add(analyzeTweaks, "groundMode", GROUND_MODES).name("Ground contact");
    if (groundMode.tooltip) {
        groundMode.tooltip("Constrain the solution space by how the object touches the ground. Underground " +
            "trajectories are always rejected. 'On the ground' adds a Ground Vehicle candidate and demotes " +
            "airborne solutions; 'Starts/Ends on ground' models takeoff/release or landing/descent (a portion " +
            "on the surface) and biases the physics fits toward the ground.");
    }

    // Ground-truth reference track. When set, the gallery scores and orders
    // every method by its closeness to this track, and draws the track
    // (dashed) in each 3D graph. A loaded "Truth_" track auto-selects.
    _truthTrackCtrl = folder.add(analyzeTweaks, "truthTrack", {[TRUTH_NONE]: TRUTH_NONE}).name("Truth Track");
    if (_truthTrackCtrl.tooltip) {
        _truthTrackCtrl.tooltip("Reference track the analysis results are compared against. When selected, " +
            "methods are scored and ordered by mean 3D separation from this track, each rank basis reports " +
            "where they agree/diverge (location, altitude, speed, heading), and the track is drawn dashed " +
            "in the 3D graphs. A loaded \"Truth_\" track (e.g. from truth_lat/truth_long CSV columns) is " +
            "selected automatically.");
    }
    refreshTruthTrackOptions();
    // Re-register the tracksChanged hook on EVERY rebuild. EventManager.removeAll()
    // runs on sitch dispose (index.js), so a "once per session" guard would leave
    // the dropdown permanently unpopulated from the second sitch onwards: the
    // build-time refresh above runs before the sitch's tracks have loaded, and the
    // later tracksChanged that would fill it in has no listener. Drop our previous
    // registration first so repeat calls within one sitch don't accumulate.
    // The listener must not return a truthy value — dispatchEvent deletes any
    // callback that does.
    if (_truthTrackListener) EventManager.removeEventListener("tracksChanged", _truthTrackListener);
    _truthTrackListener = () => { refreshTruthTrackOptions(); };
    EventManager.addEventListener("tracksChanged", _truthTrackListener);

    const cbFixed = folder.add(analyzeTweaks, "aoFixedPoint").name("AO: Stationary / sky-fixed object");
    const cbKnownNow = folder.add(analyzeTweaks, "aoKnownNow").name("AO: Known object (this time)");
    const cbKnownOther = folder.add(analyzeTweaks, "aoKnownOther").name("AO: Known object (find time)");
    const cbSat = folder.add(analyzeTweaks, "satellite").name("Satellite: LEO pass for date");
    const windMode = folder.add(analyzeTweaks, "windMode", ["Sitch wind", "Zero wind"]).name("Wind for analysis");
    if (windMode.tooltip) {
        windMode.tooltip("Choose the shared wind used by ray-following metrics and the fixed-wing gallery fit, " +
            "or ignore it and treat motion as ground-relative. Lantern and quadcopter models solve their own " +
            "wind and are evaluated in that solved air mass. This does not change the sitch wind controls.");
    }
    if (cbFixed.tooltip) {
        cbFixed.tooltip("Include the stationary-object interpretation: either a fixed point in space (sightlines " +
            "converge) or a fixed point in the sky at infinity like the Moon (parallel sightlines), whichever fits.");
    }
    if (cbSat.tooltip) {
        cbSat.tooltip("Load the historical LEO satellite catalogue for the sitch's date (via the server, cached " +
            "permanently — slow the first time) and find the satellite whose pass best matches the sightlines. " +
            "Needs a real sitch date.");
    }
    if (cbKnownNow.tooltip) {
        cbKnownNow.tooltip("Ephemeris: at the clip's time, find the nearest bright planet or star to the sightlines.");
    }
    if (cbKnownOther.tooltip) {
        cbKnownOther.tooltip("Ephemeris: search a time window for when a bright planet would best align with the mean sightline.");
    }

    return folder;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Result cache: the analysis (sweep + several DE fits) takes ~15 s, but nothing
// changes between clicks unless the LOS data or an analysis input moves. We
// fingerprint the inputs and reuse the last result when the fingerprint
// matches, so re-running the traverse analysis is instant when nothing changed.
let _analysisCache = null;   // {fp, results}
// True while a run is in flight. A second Analyze click would otherwise start a
// concurrent run that races the shared _analysisCache / window.lastTraverseAnalysis
// and stacks a second gallery overlay (see TA-22).
let _analysisRunning = false;
const _terrainMapEpochs = new WeakMap();
let _nextTerrainMapEpoch = 1;

// Camera-driven subdivision mutates one elevation-map object's tile set. An
// explicit Refresh/source reload replaces the map object. Give only that data
// generation a stable epoch so view LOD cannot invalidate analysis, while a
// same-configuration reload still can.
function terrainDataEpoch(terrain) {
    const map = terrain?.elevationMap;
    if (!map || (typeof map !== "object" && typeof map !== "function")) return 0;
    let epoch = _terrainMapEpochs.get(map);
    if (epoch === undefined) {
        epoch = _nextTerrainMapEpoch++;
        _terrainMapEpochs.set(map, epoch);
    }
    return epoch;
}

// Bit-level float hash so ANY change to an input flips the fingerprint (a false
// "changed" just recomputes — safe; a false "unchanged" would serve stale
// results, which the bit hash makes vanishingly unlikely).
const _fpBuf = new ArrayBuffer(8);
const _fpF64 = new Float64Array(_fpBuf);
const _fpI32 = new Int32Array(_fpBuf);
function _mixFloat(h, v) {
    _fpF64[0] = Number.isFinite(v) ? v : 0;
    h = Math.imul(h ^ _fpI32[0], 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ _fpI32[1], 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 13)) >>> 0);
}
function _mixStr(h, s) {
    s = String(s);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h >>> 0;
}
// Fingerprint = hash of every LOS frame (sensor position + heading) plus the
// scalar inputs that steer the fits. losNode.v(f) reads the baked track (cheap
// array access), so even 7000 frames hash in a few ms — instant on a cache hit.
function analysisFingerprint(losNode, scalars, frame0 = 0, frame1 = (losNode.frames ?? 1) - 1) {
    let h = 0x811c9dc5;
    const n = losNode.frames;
    frame0 = Math.max(0, Math.min(n - 1, Math.round(frame0)));
    frame1 = Math.max(frame0, Math.min(n - 1, Math.round(frame1)));
    h = _mixFloat(h, frame0);
    h = _mixFloat(h, frame1);
    for (let f = frame0; f <= frame1; f++) {
        const l = losNode.v(f);
        const p = l.position, d = l.heading;
        h = _mixFloat(h, p.x); h = _mixFloat(h, p.y); h = _mixFloat(h, p.z);
        h = _mixFloat(h, d.x); h = _mixFloat(h, d.y); h = _mixFloat(h, d.z);
    }
    for (const s of scalars) {
        if (typeof s === "string") h = _mixStr(h, s);
        else h = _mixFloat(h, typeof s === "boolean" ? (s ? 1 : 0) : s);
    }
    return h >>> 0;
}

// Assemble the full analysis fingerprint from the CURRENT state of every
// input that steers the analysis. Single authority for the cache key: used
// to decide a cache hit at Analyze time. Applying an exact snapshot is output
// selection only: it must not change this key or feed an answer back into the
// next analysis assumptions.
function computeAnalysisFingerprint(losNode, capturedProvenance = null) {
    const analysisFrames = analysisFrameRange(losNode);
    const windNode = NodeMan.get("targetWind", false) || null;
    const analysisWindNode = analyzeTweaks.windMode === "Zero wind" ? null : windNode;
    const startDistNode = NodeMan.get("startDistance", false) || null;
    const speedNode = NodeMan.get("speedScaled", false) || null;
    // v0 of a CNodeGUIValue is in SI units (getValueFrame applies unitType)
    const anchorDist = startDistNode ? startDistNode.v0 : 20 * METERS_PER_NM;
    const speedTarget = speedNode ? speedNode.v0 : 380 * KNOTS_TO_MS;
    const userMin = NodeMan.get("analysisMinDist", false)?.v0 ?? 0;
    const userMax = NodeMan.get("analysisMaxDist", false)?.v0 ?? (1000 * METERS_PER_NM);
    const refr = refractionOptsFromUniforms();
    const astroEnabled = analyzeTweaks.aoKnownNow || analyzeTweaks.aoKnownOther;
    const datedSkyCheckEnabled = astroEnabled || analyzeTweaks.satellite;
    const guiVal = (id) => { const nd = NodeMan.get(id, false); return nd ? (nd.v0 ?? nd.value ?? 0) : 0; };
    const terrain = NodeMan.get("TerrainModel", false);
    const terrainState = terrainAnalysisConfigScalars(
        terrain, Globals.equatorRadius, Globals.polarRadius, terrainDataEpoch(terrain));
    const windSeries = [];
    if (analysisWindNode) {
        windSeries.push(analysisWindNode.trackSource ?? "");
        if (typeof analysisWindNode.trackWindAt === "function" && analysisWindNode.trackSource) {
            for (let f = analysisFrames.frame0; f <= analysisFrames.frame1; f++) {
                const sample = analysisWindNode.trackWindAt(f);
                windSeries.push(sample ? sample.from : analysisWindNode.from,
                    sample ? sample.knots : analysisWindNode.knots);
            }
        } else {
            windSeries.push(analysisWindNode.from, analysisWindNode.knots);
        }
    }
    // The wind FIELD (altitude-resolved profile, separate node from the
    // targetWind above) steers the wind-pinned balloon hypothesis, so a change
    // of source or of the underlying data must invalidate a cached analysis.
    // _windDataVersion is bumped by the field whenever its data is refetched.
    // Gated on windMode for the same reason the prior is: under "Zero wind" the
    // field doesn't reach the analysis at all, so it must not affect the key.
    if (analyzeTweaks.windMode !== "Zero wind") {
        const wf = NodeMan.get("windField", false);
        if (wf) {
            windSeries.push("field", wf.source ?? "", wf.statusText ?? "", wf._windDataVersion ?? 0);
        }
    }
    const provenance = capturedProvenance || losProvenance();
    // Truth-track reference: both WHICH track is selected and its actual
    // positions steer the scoring/ordering (e.g. the altitude-units toggle
    // re-derives a Truth track in place), so sample them into the key.
    const truthSeries = [];
    const truthSel = resolveTruthTrack();
    if (truthSel) {
        truthSeries.push(truthSel.trackID);
        for (let f = analysisFrames.frame0; f <= analysisFrames.frame1; f++) {
            const p = truthSel.trackNode.p(f);
            if (p) truthSeries.push(p.x, p.y, p.z);
        }
    }
    return analysisFingerprint(losNode, [
        analysisFrames.frame0, analysisFrames.frame1,
        analyzeTweaks.windMode,
        ...windSeries,
        ...truthSeries,
        provenance.circular ? 1 : 0, provenance.losSource, provenance.cameraHeading,
        // Measured-LOS substitution changes which sightlines the whole run
        // consumes; the frame hash usually differs too, but a perfectly
        // aligned constructed/measured pair must still get a distinct key.
        provenance.measuredSubstituted ? 1 : 0, provenance.measuredLOSId ?? "",
        speedTarget, anchorDist, userMin, userMax,
        // Ground-contact mode reshapes the candidate set (adds/removes the
        // Ground Vehicle, changes underground/mode flags and the ground priors).
        analyzeTweaks.groundMode,
        ...terrainState,
        analyzeTweaks.aoFixedPoint, analyzeTweaks.aoKnownNow, analyzeTweaks.aoKnownOther,
        Sit.name || "", Sit.frames || 0, Sit.fps || 0,
        // Astronomical fits depend on the sensor FOV (brightness boost) and the
        // View-menu refraction settings — the refracted directions bend with
        // pressure and temperature, not just the on/off toggle, so all three
        // must re-run the analysis. When both astronomy checks are disabled,
        // camera FOV/refraction are view-only and must not bust this cache.
        astroEnabled ? sensorFOVDeg() : 0,
        astroEnabled && refr.enabled ? 1 : 0,
        astroEnabled && refr.enabled ? refr.pressureHPa : 0,
        astroEnabled && refr.enabled ? refr.tempC : 0,
        // The known-object sweep also checks bright STARS, but only once the
        // async-loaded star catalog is present. Without this term an Analyze
        // run before the catalog finished loading cached a planets-only
        // result and served it forever.
        astroEnabled ? (NodeMan.get("NightSkyNode", false)?.starField?.BSC_NumStars || 0) : 0,
        // Satellite search depends on the flag and the sitch's date (which
        // catalogue is loaded); the date also gates the astro ephemeris.
        analyzeTweaks.satellite ? 1 : 0,
        datedSkyCheckEnabled && GlobalDateTimeNode && GlobalDateTimeNode.dateStart
            ? GlobalDateTimeNode.dateStart.valueOf() : 0,
        // simSpeed scales the per-frame dates (dateAtFrame), so it changes the
        // satellite and astro-time fits even when dateStart is unchanged.
        Sit.simSpeed ?? 1,
        // The gallery reads the live global-fit method nodes as contenders, so
        // their GUI parameters change the results and must invalidate the cache.
        // (CV/CA are parameter-free; the seeded Monte Carlo is otherwise
        // deterministic, so its trial count / uncertainty / order fully pin it.)
        guiVal("kalmanProcessNoise"), guiVal("kalmanMeasurementNoise"),
        guiVal("mcNumTrials"), guiVal("mcLOSUncertainty"), guiVal("mcOrder"),
        // The Straight Line contender reads the target-heading slider; without
        // it a heading change would serve a stale cached gallery.
        guiVal("targetActualHeading"),
    ], analysisFrames.frame0, analysisFrames.frame1);
}

function terrainElevationIsLoading() {
    const terrain = NodeMan.get("TerrainModel", false);
    // Tile data can already be installed while the coalesced revision/event is
    // waiting for the next animation frame. Treat that pending notification as
    // unstable too; otherwise a report can be cached in the narrow gap between
    // the fetch flag clearing and elevationRevision incrementing.
    if (terrain?._elevationChangedPending) return true;
    // currentStats is populated by view rendering and can lag behind an
    // elevation request.  The tile flags are the authoritative source used by
    // the render/export settlers, so check them first when available.
    const tiles = terrain?.elevationMap?.getAllTiles?.();
    if (Array.isArray(tiles) && tiles.some((tile) => tile?.isLoadingElevation)) return true;
    const stats = terrain?.elevationMap?.currentStats;
    if (!(stats instanceof Map)) return false;
    for (const value of stats.values()) {
        if ((value?.pendingLoads ?? 0) > 0) return true;
    }
    return false;
}

/**
 * Run the full traverse analysis. Shows a cancellable progress overlay, then
 * a summary dialog with Open Report / Apply Best Solution choices.
 * Returns the results object (also stored on window.lastTraverseAnalysis),
 * or null if there was no LOS data or the user cancelled.
 */
export async function runTraverseAnalysis() {
    // One run at a time: a second concurrent run would race the shared cache and
    // last-result globals and stack a second gallery (TA-22).
    if (_analysisRunning) {
        showError("Traverse analysis is already running. Wait for it to finish, or Cancel it, before starting another.");
        return null;
    }
    let losNode = resolveLOSNode();
    if (!losNode) {
        showError("Traverse analysis: no LOS node found.\n" +
            "Need a 'JetLOS' node or a Const Air Spd traverse with an LOS input.");
        return null;
    }
    // LOS provenance, with measured-sensor substitution. When the selected LOS
    // is CONSTRUCTED from the target being tested (camera aimed "To Target"),
    // any fit that recovers the target is only an internal-consistency check.
    // If the camera track carries independently recorded sensor angles (MISB
    // az/el — its Track_<name>_LOS node), those ARE the measurement: analyze
    // them instead of the constructed centerline, and say so prominently.
    let provenance = losProvenance();
    // Substitute ONLY when the selected source is the plain camera-center
    // boresight. Tracking-derived sources ("Camera + Point Track") are also
    // flagged circular, but they carry a real measured pixel offset that the
    // recorded boresight angles do NOT contain — swapping would silently
    // discard that measurement while claiming measurement-grade sightlines.
    if (provenance.circular && provenance.selectedIsCameraCenter) {
        const measured = resolveMeasuredLOSNode(losNode);
        if (measured) {
            const constructedSource = provenance.losSource;
            provenance = {
                ...provenance,
                circular: false,
                reason: undefined,
                measuredSubstituted: true,
                measuredLOSId: measured.id,
                constructedSource,
                losSource: `Measured sensor angles (${measured.id})`,
                substitutionNote: `The selected "${constructedSource}" sightlines are re-derived from the ` +
                    `target-aimed camera attitude (circular), but the camera track carries independently ` +
                    `recorded sensor angles — the analysis used those measured sightlines (${measured.id}) instead.`,
            };
            losNode = measured;
            console.log("Traverse analysis: substituted measured sensor LOS " + measured.id
                + " for circular '" + constructedSource + "' sightlines");
        }
    }
    const analysisFrames = analysisFrameRange(losNode);
    if (!losNode.frames || analysisFrames.count < 10) {
        showError("Traverse analysis: not enough LOS frames to analyze in the A-B/In-Out range.");
        return null;
    }
    // Readiness: an analysis triggered before the LOS is fully baked (video /
    // tracks still loading) can contain null or non-finite frames, which used
    // to crash deep inside the fingerprint hash. Validate up front and give a
    // friendly retry message instead.
    for (let f = analysisFrames.frame0; f <= analysisFrames.frame1; f++) {
        const l = losNode.v(f);
        const p = l && l.position;
        const d = l && l.heading;
        if (!p || !d
            || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)
            || !Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)
            || Math.hypot(d.x, d.y, d.z) < 1e-9) {
            showError("Traverse analysis: the line-of-sight data is not ready yet (frame "
                + f + " is incomplete). Wait for the sitch to finish loading and try again.");
            return null;
        }
    }

    const windNode = NodeMan.get("targetWind", false) || null;
    const analysisWindNode = analyzeTweaks.windMode === "Zero wind" ? null : windNode;
    const startDistNode = NodeMan.get("startDistance", false) || null;
    const speedNode = NodeMan.get("speedScaled", false) || null;

    // v0 of a CNodeGUIValue is in SI units (getValueFrame applies unitType)
    const anchorDist = startDistNode ? startDistNode.v0 : 20 * METERS_PER_NM;
    const speedTarget = speedNode ? speedNode.v0 : 380 * KNOTS_TO_MS;

    // Range-of-interest envelope. Two optional GUI values ("analysisMinDist" /
    // "analysisMaxDist", unitType "big", .v0 in SI meters) let the user pin a
    // rough distance band. Left at their defaults (0 .. ~1000 NM) we fall back
    // to the adaptive envelope centered on the current start distance, so the
    // sweep and profiles resolve the plausible valley at whatever scale the
    // sitch works at (Gimbal ~30 NM vs Aguadilla ~2 NM). The nodes are optional
    // — older sitches without them behave exactly as before.
    const userMin = NodeMan.get("analysisMinDist", false)?.v0 ?? 0;
    const userMax = NodeMan.get("analysisMaxDist", false)?.v0 ?? (1000 * METERS_PER_NM);
    const rangeIsDefault = userMin <= 1 && userMax >= 999 * METERS_PER_NM;

    let ranges, fitRangeMin, fitRangeMax, caRangeMin, caRangeMax, plausRangeMin, plausRangeMax;
    if (rangeIsDefault) {
        ranges = adaptiveRangeList(anchorDist);
        // The aircraft-fit DE search gets a GENEROUS envelope, never narrower
        // than the default 1-45 NM — coupling it to the (possibly tight) display
        // grid lets the optimizer ram into an artificial boundary (GoFast wanted
        // >8 NM).
        fitRangeMin = Math.min(ranges[0], 1 * METERS_PER_NM);
        fitRangeMax = Math.max(ranges[ranges.length - 1], 45 * METERS_PER_NM);
        // constant-altitude and least-maneuvering fits keep their own defaults.
        caRangeMin = fitRangeMin;
        caRangeMax = fitRangeMax;
        plausRangeMin = 0.5 * METERS_PER_NM;
        plausRangeMax = 55 * METERS_PER_NM;
    } else {
        // User pinned a rough band: honor it everywhere. Sample it uniformly so
        // the sweep and profiles have even resolution across the requested window.
        const lo = Math.max(0.1 * METERS_PER_NM, userMin);
        // If only the MIN was set (max left at its ~1000 NM default), don't
        // spread 44 samples over 1000 NM — cap the top to a sane envelope
        // around the anchor so resolution stays useful.
        const maxIsDefault = userMax >= 999 * METERS_PER_NM;
        const hi = maxIsDefault
            ? Math.max(lo * 3, anchorDist * 2.5, 45 * METERS_PER_NM)
            : Math.max(lo * 1.2, userMax);
        ranges = uniformRangeList(lo, hi);
        fitRangeMin = lo;
        fitRangeMax = hi;
        caRangeMin = lo;
        caRangeMax = hi;
        plausRangeMin = lo;
        plausRangeMax = hi;
    }

    // Cache hit → show the previous gallery instantly, skipping the whole fit
    // battery. The main fingerprint covers evidence/configuration; the scoped
    // terrain check covers only elevations actually used by candidate grading.
    const fp = computeAnalysisFingerprint(losNode, provenance);
    if (_analysisCache && _analysisCache.fp === fp) {
        const cached = _analysisCache.results;
        const currentTerrainDependencies = resampleTerrainDependencies(
            _analysisCache.terrainDependencies);
        const terrainDrift = terrainDependencyMismatch(
            _analysisCache.terrainDependencies, currentTerrainDependencies);
        if (terrainDrift) {
            // A truthy mismatch is AUTHORITATIVE, not view-only: terrainDependency-
            // Mismatch already returns null for a render-camera lower-resolution
            // fallback (bz < az). So an equal-or-higher-resolution ground height
            // that actually changed means this cached grading is STALE — recompute
            // rather than re-serve it (which is what made the "rerun after terrain
            // settles" instruction a no-op). Drop the stale entry and fall through
            // to a full run. (Stage-level regrading without a full refit is the
            // larger TA-28 follow-up.)
            console.log("Traverse analysis cache: terrain grading is stale, recomputing", terrainDrift);
            _analysisCache = null;
        } else {
            console.log("Traverse analysis cache: hit (evidence and assumptions unchanged)");
            window.lastTraverseAnalysis = cached;
            showResultGallery(cached);
            return cached;
        }
    } else if (_analysisCache) {
        console.log("Traverse analysis cache: evidence/configuration changed", {
            cached: _analysisCache.fp, current: fp,
        });
    }

    // A valid cached result is safe to show while unrelated render-camera
    // tiles load. Only a fresh computation waits for global terrain settling;
    // its publication checks below are scoped to the ground samples it uses.
    if (Globals.loadingTerrain || terrainElevationIsLoading()) {
        showError("Traverse analysis: terrain/elevation data are still loading. Wait for loading to finish and try again.");
        return null;
    }

    _analysisRunning = true;
    const overlay = createProgressOverlay("Analyzing Traverse Methods");
    // Yield via MessageChannel, not setTimeout: a backgrounded tab clamps
    // setTimeout to ~1/minute (Chrome intensive throttling), which would drag a
    // multi-second analysis out to many minutes; MessageChannel macrotasks are
    // not throttled, so the compute proceeds at full speed whether the tab is
    // foreground or hidden (and still yields to repaint/cancel when visible).
    const yieldToDOM = makeYield();
    // progress callback for one phase occupying [base, base+span] of the bar
    const phase = (base, span, label) => async (frac) => {
        overlay.setStatus(label);
        overlay.setFraction(base + span * Math.min(1, Math.max(0, frac)));
        await yieldToDOM();
        if (overlay.isCancelled()) throw new Error("cancelled");
    };

    let results = null;
    try {
        overlay.setStatus("Building LOS dataset...");
        await yieldToDOM();
        const {dataset, originLat, originLon} = buildAnalysisDataset(losNode, analysisWindNode, anchorDist, analysisFrames);
        const failures = [];
        // Terrain tiles can finish loading WHILE the analysis runs. The elevation
        // that actually feeds the fits is sampled once at the start, so a later
        // change means the report's ground samples and the fits are marginally
        // inconsistent — but "marginally" is the operative word: a camera tile
        // arriving elsewhere in the quadtree, or a slightly refined height under
        // the object, does not change which object it looks like. So we NOTE the
        // change and finish the run rather than discarding minutes of work and
        // asking the analyst to try again (which, while terrain streams in, could
        // loop). Set at the sample points below; surfaced as a caveat.
        let terrainChangedDuringRun = false;
        // Sensor-baseline observability: with a (near-)static LOS origin no
        // free-range method can determine distance — every range along the ray
        // fan admits a trajectory, and smoothness scoring then collapses the
        // solution toward the sensor. Detect it here and warn everywhere.
        const sensorStats = sensorMotionStats(dataset);
        provenance = {
            ...provenance,
            sensorPathLen: sensorStats.pathLen,
            sensorSpan: sensorStats.span,
            rangeUnobservable: isRangeUnobservable(sensorStats, anchorDist),
        };
        const terrainAtStart = NodeMan.get("TerrainModel", false);
        const terrainConfigAtStart = terrainAnalysisConfigScalars(terrainAtStart,
            Globals.equatorRadius, Globals.polarRadius, terrainDataEpoch(terrainAtStart));
        const groundPriorDependencyAtStart = analyzeTweaks.groundMode !== "Airborne (any)"
            ? [terrainDependencySample("local-ground",
                localGroundProbeECEF(dataset, originLat, originLon))]
            : null;

        // Ground-contact solver prior (from the ground mode): bias the fixed-wing,
        // lantern and quadcopter fits toward the surface at the relevant
        // endpoint(s). Gated so the default "Airborne" mode leaves every fit
        // byte-identical. groundZ is the local terrain height (≈0 over ocean).
        let groundPrior = null;
        if (analyzeTweaks.groundMode !== "Airborne (any)") {
            const gz = groundPriorDependencyAtStart[0].groundAltitudeM;
            groundPrior = {sigma: 40};
            if (analyzeTweaks.groundMode === "Starts on ground") groundPrior.startZ = gz;
            else if (analyzeTweaks.groundMode === "Ends on ground") groundPrior.endZ = gz;
            else { groundPrior.startZ = gz; groundPrior.endZ = gz; }   // "On the ground"
        }

        const sweep = await sweepConstAirSpeed(dataset, {
            ranges,
            speedTarget,
            // Auto-expand the range bracket when the winner sits on a grid
            // edge (only when the user hasn't pinned an explicit band).
            expand: rangeIsDefault,
            progress: phase(0.00, 0.18, "Sweeping constant-air-speed grid..."),
        });
        // Expansion is part of the search result, not a display-only detail.
        // Every downstream profile/model must inspect the same resolved bracket.
        const resolvedRanges = sweep.ranges;
        fitRangeMin = Math.min(fitRangeMin, resolvedRanges[0]);
        fitRangeMax = Math.max(fitRangeMax, resolvedRanges[resolvedRanges.length - 1]);
        caRangeMin = Math.min(caRangeMin, resolvedRanges[0]);
        caRangeMax = Math.max(caRangeMax, resolvedRanges[resolvedRanges.length - 1]);
        plausRangeMin = Math.min(plausRangeMin, resolvedRanges[0]);
        plausRangeMax = Math.max(plausRangeMax, resolvedRanges[resolvedRanges.length - 1]);
        const fastProfile = await rangeProfile(dataset, {
            ranges: resolvedRanges,
            vTarget: speedTarget,
            vSigma: 60 * KNOTS_TO_MS,
            progress: phase(0.18, 0.12, "Range profile: fast object..."),
        });
        const slowOpts = {vTarget: 5 * KNOTS_TO_MS, vSigma: 20 * KNOTS_TO_MS, scoreSpeedWeight: 0.2};
        const slowProfile = await rangeProfile(dataset, {
            ...slowOpts,
            ranges: resolvedRanges,
            progress: phase(0.30, 0.12, "Range profile: slow object..."),
        });
        const aircraft = await fitAircraft(dataset, {
            tasTarget: speedTarget,
            rangeMin: fitRangeMin, rangeMax: fitRangeMax,
            runs: 3,
            groundPrior,
            progress: phase(0.42, 0.34, "Fitting fixed-wing aircraft model..."),
        });

        // --- Extra interpretation fits for the hypothesis gallery ---------
        await phase(0.76, 0.02, "Fitting constant-altitude path...")(0);
        const ca = fitConstAltitude(dataset, {rangeMin: caRangeMin, rangeMax: caRangeMax});

        await phase(0.79, 0.02, "Fitting least-maneuvering path...")(0);
        const plausible = fitPlausibleBestRange(dataset, {
            vTarget: speedTarget,
            vSigma: 60 * KNOTS_TO_MS,
            rangeMin: plausRangeMin,
            rangeMax: plausRangeMax,
        });

        // Wind input for the wind-tracer fits (Sky Lantern / Balloon and
        // Quadcopter): sample the sitch's wind at the analysis origin and the
        // plausible object altitude, and pin their solved wind loosely to it.
        // A wind tracer's drift SHOULD match the winds aloft, not slide slow to
        // trade range against an invented calm (the coupled range/wind
        // unobservable pair).
        //
        // This is what makes "using existing wind" a hypothesis distinct from
        // "finding wind" — the two are fitted separately and both reported.
        // It is deliberately NOT restricted to measured sources: a hand-set
        // ("manual") constant is an assumption rather than a measurement, but
        // excluding it made the split invisible on every manual-wind sitch,
        // which is most of them. Instead the provenance is carried on the prior
        // and LABELLED in the hypothesis name/notes, so the analyst can see
        // whether the pinned wind was measured or asserted.
        //
        // Honours the analysis-wide "Wind for analysis" toggle: "Zero wind"
        // means the analyst asked for no wind input at all, so no wind-pinned
        // variant is built (the free fit still runs and infers its own wind).
        let windPrior = null;
        const windFieldNode = NodeMan.get("windField", false);
        if (analyzeTweaks.windMode !== "Zero wind"
            && windFieldNode && windFieldNode.source
            && typeof windFieldNode.sampleWindAtAltitude === "function"
            && plausible && plausible.track) {
            let sumAlt = 0;
            for (let f = 0; f < dataset.n; f++) {
                const x = plausible.track[f * 3], y = plausible.track[f * 3 + 1], z = plausible.track[f * 3 + 2];
                sumAlt += z + (x * x + y * y) / (2 * EARTH_RADIUS_M);  // geodetic; ENU origin at MSL
            }
            const meanAltM = sumAlt / dataset.n;
            // originLat/originLon are RADIANS here; sampleWindAtAltitude wants
            // DEGREES. The wind field resolves every source, including a manual
            // constant, to an East/North vector at this altitude.
            //
            // Wrapped: the wind field is shared, user-configurable state that
            // varies a lot between sitches (a legacy sitch may carry a wind node
            // whose grid was never built at all). A wind problem must degrade to
            // "no wind-pinned hypothesis", never abort the whole analysis — the
            // free-wind fit doesn't need wind input and still runs.
            let s = null;
            try {
                s = windFieldNode.sampleWindAtAltitude(
                    originLat * 180 / Math.PI, originLon * 180 / Math.PI, meanAltM);
            } catch (e) {
                console.warn("Wind sample for the balloon prior failed; "
                    + "continuing with the free-wind fit only:", e);
                s = null;
            }
            if (s && Number.isFinite(s.u) && Number.isFinite(s.v)) {
                windPrior = {
                    E: s.u, N: s.v, altM: meanAltM,
                    source: windFieldNode.source,
                    // "manual" is a hand-set constant; every other source
                    // (gfs / custom / uwyo / igra2 / manual-soundings /
                    // openmeteo) is measured or modelled data.
                    measured: windFieldNode.source !== "manual",
                    statusText: windFieldNode.statusText ?? null,
                };
            }
        }

        // Shared physics-fit dataset shape (frame-0-indexed sensor/LOS arrays +
        // uniform times) reused by the lantern and quadcopter model fits.
        const physicsTimes = new Float64Array(dataset.n);
        for (let f = 0; f < dataset.n; f++) physicsTimes[f] = f / dataset.fps;
        const physicsDS = {
            sensorPos: dataset.S, losDir: dataset.D, times: physicsTimes,
            count: dataset.n, maxRange: null,
        };
        const clipDurationSec = (dataset.n - 1) / dataset.fps;
        const physicsOpts = {
            optimizer: "de", sampleStride: 5, dePop: 48, deGens: 120,
            // let the overlay's Cancel button actually stop the DE search
            shouldCancel: () => overlay.isCancelled(),
        };
        if (groundPrior) physicsOpts.groundPrior = groundPrior;

        // Geometric SEED for the physically-based fits, so they start on a path
        // that already fits the sightlines and refine from there (the balloon's
        // time-varying wind and the drone's control inputs are otherwise
        // unsearchable at the shipping DE budget — see SkyLanternModel.seedFromTrack
        // and DroneControlFit).
        //
        // Seed from the KALMAN SMOOTHER specifically — not "whichever geometric
        // track has the lowest LOS residual". An LOS fit is degenerate along
        // range: a track that collapses toward the sensor and speeds up rides the
        // rays with an arbitrarily small residual while being physically
        // meaningless (measured here: a 222 m / 255 kt "plausible" member scored
        // 0.05 deg but seeded the drone into a 24-revolution corkscrew). The
        // Kalman smoother is regularised (it penalises acceleration) AND we give
        // its constant-velocity seed an explicit range floor (minRange), because
        // that seed treats the sensor's own path as a zero-residual solution for
        // a CV-representable sensor motion unless a floor is supplied
        // (LOSFitting.js fitConstantVelocity). Regularisation alone does not
        // create the missing radial observability. With both, the smoother stays
        // a good basin to refine from; the least-manoeuvring track is only a
        // fallback for the rare case it returns nothing. The seed carries NO truth
        // and NO object assumptions, so it only decides where the search starts,
        // not which object wins; the free quadcopter is deliberately NOT seeded
        // (the unconstrained, anomaly-reachable envelope fit).
        const KS_SEED_MIN_RANGE = 500;   // metres; matches the sweep floor, below every physical model's own floor
        let seedTrack = null;
        try {
            // The kalmanProcessNoise / kalmanMeasurementNoise GUI sliders hold
            // log10 EXPONENTS, not variances — the live Kalman node converts them
            // with Math.pow(10, v0) (see CNodeLOSFitKalman._doCompute). Passing the
            // raw exponent here made processNoise negative at the default -4, which
            // produced an all-non-finite smoother track and a NaN drone seed. Undefined
            // (no node) leaves fitKalmanFilter on its own 1e-4 / 1.0 defaults.
            const kNoise = (id) => {
                const nd = NodeMan.get(id, false);
                const v = nd ? (nd.v0 ?? nd.value) : undefined;
                return Number.isFinite(v) ? Math.pow(10, v) : undefined;
            };
            const ks = fitKalmanFilter({...physicsDS, minRange: KS_SEED_MIN_RANGE}, new Set(), {
                processNoise: kNoise("kalmanProcessNoise"),
                measurementNoise: kNoise("kalmanMeasurementNoise"),
            });
            // Only seed from a finite smoother track. A non-finite result must
            // fall through to the plausible track (or no seed), never poison the
            // physical fits with NaN initial parameters.
            if (ks && ks.positions && allFinite(ks.positions)) {
                seedTrack = Float64Array.from(ks.positions);
            } else if (ks && ks.positions) {
                console.warn("Kalman seed produced a non-finite track; "
                    + "falling back to the least-manoeuvring track.");
            }
        } catch (e) {
            // Non-fatal: a seeding failure must never abort the analysis.
            console.warn("Kalman seed for the physics fits failed; "
                + "falling back to the least-manoeuvring track:", e);
        }
        // Fall back to the least-manoeuvring plausible track only if the smoother
        // is unavailable.
        if (!seedTrack && plausible && plausible.track) seedTrack = plausible.track;
        // Build a {name: value} initial-guess override from a seeded model's
        // seedParams() vector (feeds fitPhysicsModel's paramOverrides, which
        // becomes the DE seed and the Nelder-Mead start).
        const seededOverrides = (model) => {
            const v = model.seedParams();
            if (!v) return null;
            const o = {};
            model.getParameterDefs().forEach((d, i) => { o[d.name] = v[i]; });
            return o;
        };

        await phase(0.82, 0.05, "Fitting balloon model (free wind)...")(0);
        let lantern = null;
        try {
            // FREE reconstruction: fit wind + lift together with NO measured-wind
            // input — "does a plausible balloon fit these sightlines?" — and yield
            // the inferred wind + lift profile.
            const freeModel = new SkyLanternModel();
            // lets the model's wind vary across the clip in duration-invariant
            // units (see SkyLanternModel._windAt)
            freeModel.clipDuration = clipDurationSec;
            // Seed the time-varying wind from the best geometric path so DE
            // starts in the right basin instead of scattering in 12-D.
            let freeOpts = physicsOpts;
            if (seedTrack) {
                freeModel.seedFromTrack(seedTrack, physicsDS);
                const ov = seededOverrides(freeModel);
                if (ov) freeOpts = {...physicsOpts, paramOverrides: ov};
            }
            lantern = await fitPhysicsModel(physicsDS, new Set(), freeModel, freeOpts);
        } catch (e) {
            if ((e && e.message === "cancelled") || overlay.isCancelled()) throw new Error("cancelled");
            failures.push({method: "Sky Lantern / Balloon (free wind)", error: (e && e.message) || "fit failed"});
            lantern = null;
        }
        if (overlay.isCancelled()) throw new Error("cancelled");
        if (!lantern && !failures.some((f) => f.method === "Sky Lantern / Balloon (free wind)")) {
            failures.push({method: "Sky Lantern / Balloon (free wind)", error: "fit returned no solution"});
        }

        // "USING EXISTING WIND" reconstruction: a second balloon fit whose drift
        // wind is softly pinned to the sitch's wind (kept loose — even a real
        // sounding is only loosely representative). Runs whenever the sitch has
        // a wind and the analyst hasn't selected "Zero wind"; the prior carries
        // its provenance so the hypothesis can say whether that wind was
        // measured or hand-set. Kept SEPARATE from the free fit so both modes
        // coexist and the inferred-vs-existing wind comparison is available.
        let lanternMeasured = null;
        if (windPrior) {
            await phase(0.87, 0.02,
                `Fitting balloon model (${windPrior.measured ? "measured" : "sitch"} wind)...`)(0);
            try {
                const m = new SkyLanternModel();
                m.clipDuration = clipDurationSec;
                m.windPriorE = windPrior.E; m.windPriorN = windPrior.N;
                let measuredOpts = physicsOpts;
                if (seedTrack) {
                    m.seedFromTrack(seedTrack, physicsDS);
                    const ov = seededOverrides(m);
                    if (ov) measuredOpts = {...physicsOpts, paramOverrides: ov};
                }
                lanternMeasured = await fitPhysicsModel(physicsDS, new Set(), m, measuredOpts);
            } catch (e) {
                if ((e && e.message === "cancelled") || overlay.isCancelled()) throw new Error("cancelled");
                lanternMeasured = null;  // non-fatal — the free fit is the primary
            }
            if (overlay.isCancelled()) throw new Error("cancelled");
        }

        // Quadcopter (multirotor drone) — hover-capable near-field object. Runs
        // the generic multirotor envelope; the hypothesis classifies the solved
        // trajectory to the nearest common model. May fail / be implausible for
        // far-field scenes (its range is capped at 20 km) — degrade gracefully.
        await phase(0.89, 0.04, "Fitting quadcopter (drone) model...")(0);
        let quad = null;
        try {
            quad = await fitPhysicsModel(physicsDS, new Set(), new QuadcopterModel(), physicsOpts);
        } catch (e) {
            if ((e && e.message === "cancelled") || overlay.isCancelled()) throw new Error("cancelled");
            failures.push({method: "Quadcopter", error: (e && e.message) || "fit failed"});
            quad = null;
        }
        if (overlay.isCancelled()) throw new Error("cancelled");
        if (!quad && !failures.some((f) => f.method === "Quadcopter")) {
            failures.push({method: "Quadcopter", error: "fit returned no solution"});
        }

        // Drone as CONTROL INPUTS — the plausible-flight counterpart to the
        // free quadcopter above. Seeded from the best geometric path (Kalman
        // smoother or least-manoeuvring track; geometry only, no drone
        // assumptions and no truth), inverted into the speed/heading/climb
        // history a drone would need to fly it, compressed onto a few knots,
        // then refined against the sightlines while paying for control EFFORT
        // rather than for path shape.
        //
        // The knot count scales with clip length (knotsForDuration): 4 knots on
        // a 667 s clip is one held input per 167 s, too coarse to describe any
        // real flight let alone follow the seeded path, so the seed's detail was
        // thrown away before the fit began.
        //
        // Run alongside, never instead of, the free fit: the difference between
        // the two residuals is the informative quantity (an ordinary flight
        // explaining the rays as well as a contorted one, versus not), and
        // keeping the free fit means nothing is foreclosed.
        let droneCtl = null;
        if (seedTrack) {
            await phase(0.93, 0.01, "Fitting drone control inputs...")(0);
            try {
                const m = new DroneControlModel(knotsForDuration(clipDurationSec));
                m.seedFromTrack(seedTrack, physicsDS);
                const seeded = m.seedParams();
                const defs = m.getParameterDefs();
                const paramOverrides = {};
                defs.forEach((d, i) => { paramOverrides[d.name] = seeded[i]; });
                // This is the highest-dimensional fit in the analysis (1 + 3K
                // params, K up to 12 => 37), and the seed already sits on the
                // smoother path — so it is a LOCAL-REFINEMENT problem, not a
                // global search. Skip differential evolution entirely (optimizer
                // "nm" runs Nelder-Mead straight from the seed) and integrate the
                // search cost coarsely (fitMaxDt 1 s — the controls are linear
                // over ~60 s knots, so a 1 s step is plenty; the final
                // full-resolution trajectory still uses the model's 0.25 s step)
                // on a wider stride.
                //
                // maxIter is deliberately low. Nelder-Mead makes almost all its
                // progress from a good seed in the first few hundred iterations
                // (measured: 1500 iters -> 0.199 deg in 3.6 s, 400 -> 0.23 deg in
                // 1.2 s, 150 -> 0.36 deg in 0.5 s — all plausible flights), and
                // unlike the DE phases NM does not yield, so every iteration is
                // frozen UI. 400 keeps the fit well under a couple of seconds and
                // the residual excellent; the drone's exact residual is not the
                // deciding factor anyway (see balloonConsistency ranking). Safe:
                // NM is monotonic from the seed, so it can never return worse than
                // the seed — a corkscrew (huge residual) can't appear.
                droneCtl = await fitPhysicsModel(physicsDS, new Set(), m,
                    {...physicsOpts, paramOverrides, optimizer: "nm",
                        sampleStride: 20, fitMaxDt: 1.0, maxIter: 400});
                if (droneCtl) {
                    droneCtl.model = m;
                    droneCtl.solvedVector = defs.map((d) => droneCtl.params.solved[d.name]);
                }
            } catch (e) {
                if ((e && e.message === "cancelled") || overlay.isCancelled()) throw new Error("cancelled");
                failures.push({method: "Drone (control inputs)", error: (e && e.message) || "fit failed"});
                droneCtl = null;
            }
            if (overlay.isCancelled()) throw new Error("cancelled");
            // A null return means the fit produced no finite solution (fail-closed
            // in fitPhysicsModel); record it as a typed failure rather than
            // silently omitting the candidate.
            if (!droneCtl && !failures.some((f) => f.method === "Drone (control inputs)")) {
                failures.push({method: "Drone (control inputs)", error: "fit returned no finite solution"});
            }
        }

        // Polynomial-order sweep across the three curve-fitting strategies. This
        // is the longest single block in the analysis (Monte Carlo 2 is ~5 s per
        // order on a 20,000-frame clip), so it gets a real slice of the progress
        // bar and reports which fit is running — the progress callback awaits a
        // DOM yield, which is what keeps the bar moving and Cancel responsive.
        let mcSweep = null;
        if (!provenance?.measuredSubstituted) {
            mcSweep = await sweepPolynomialOrders(dataset, async (done, total, label) => {
                await phase(0.93, 0.05,
                    `Sweeping curve fits (${done + 1}/${total}): ${label}...`)(done / total);
            });
            if (overlay.isCancelled()) throw new Error("cancelled");
        }

        // Satellite (LEO pass) — gated OFF: loads the historical catalogue for the
        // sitch's date through the server (network, slow first time) and finds the
        // pass best matching the sightlines. Degrades to a note on any failure.
        let satellite = null;
        if (analyzeTweaks.satellite) {
            await phase(0.98, 0.01, "Loading LEO satellites for the date...")(0);
            try {
                const date0 = dateAtDatasetFrame(dataset, Math.floor(dataset.n / 2));
                const sats = await loadLEOSatrecsForDate(date0);
                await yieldToDOM();
                const best = findBestSatellite(sats,
                    losFrameView(losNode, analysisFrames.frame0, analysisFrames.frame1),
                    (f) => dateAtFrame(analysisFrames.frame0 + f), 12);
                satellite = {loaded: sats.length, best};
            } catch (e) {
                console.warn("Satellite search skipped:", e);
                satellite = {error: (e && e.message) || "failed", loaded: 0, best: null};
                failures.push({method: "Satellite catalogue", error: satellite.error});
            }
        }

        // A non-airborne fit includes local ground height in its optimizer
        // cost. Re-run only if that actual sample improved/changed—not because
        // an unrelated camera tile arrived elsewhere in the quadtree.
        if (groundPriorDependencyAtStart) {
            const groundPriorDependencyNow = [terrainDependencySample("local-ground",
                localGroundProbeECEF(dataset, originLat, originLon))];
            if (!terrainDependencyRecordsMatch(groundPriorDependencyAtStart,
                groundPriorDependencyNow)) {
                terrainChangedDuringRun = true;
                console.warn("Traverse analysis: local ground elevation changed during the run; "
                    + "keeping the start-of-run sample (change is unlikely to be significant).");
            }
        }

        const hypotheses = buildHypotheses({
            dataset, sweep, ca, plausible, aircraft, lantern, lanternMeasured, quad, satellite,
            slowProfile, slowOpts,
            losNode, originLat, originLon,
            provenance, failures, windPrior, mcSweep, droneCtl,
        });

        // Ground-truth reference: when a truth track is selected in the Tweaks,
        // score every candidate by its closeness to it. The comparison record
        // rides on each hypothesis; TraverseRanking orders by it and folds it
        // into the rank-basis text. Direction-only (at infinity) hypotheses
        // have arbitrary helper-track ranges, so 3D separation is meaningless
        // for them — mark them not-comparable instead.
        const truth = buildTruthReference(dataset, originLat, originLon);
        if (truth) {
            // The truth track's OWN LOS residual: what a perfect answer scores
            // against these rays. This is the real achievable floor, MEASURED
            // rather than inferred — and it is nothing like the "generic
            // reference" (params.errFloor), which is just a free
            // constant-acceleration fit and can be many times worse than
            // achievable (measured 0.58° where truth scores 0.051°). Quoting
            // the generic reference makes a mediocre fit look respectable;
            // where truth exists, quote truth instead.
            //
            // Only meaningful if the truth track covers essentially the whole
            // analysis window — a partially-overlapping truth would contribute
            // garbage angles on the frames it does not cover.
            let validFrac = 0;
            for (let f = 0; f < dataset.n; f++) if (truth.valid[f]) validFrac++;
            validFrac /= Math.max(1, dataset.n);
            // Average the truth track's own residual over ONLY its valid frames —
            // the up-to-1% held/clamped frames outside its coverage are not part
            // of what a perfect answer scores.
            const truthResidualDeg = validFrac > 0.99
                ? meanAngularError(dataset, truth.track, truth.valid) * 180 / Math.PI
                : NaN;

            for (const h of hypotheses) {
                if (!h.track) continue;
                h.truthComparison = h.atInfinity
                    ? {comparable: false, note: "direction-only hypothesis (at infinity); 3D separation is not meaningful"}
                    : compareTrackToTruth(dataset, h.track, truth);
                if (Number.isFinite(truthResidualDeg)) h.truthResidualDeg = truthResidualDeg;
            }
        }

        const terrainDependenciesAtBuild = captureTerrainDependencies(
            dataset, hypotheses, originLat, originLon);

        overlay.setStatus("Rendering report...");
        overlay.setFraction(0.98);
        await yieldToDOM();
        if (overlay.isCancelled()) throw new Error("cancelled");
        const terrainAtPublish = NodeMan.get("TerrainModel", false);
        const terrainConfigAtPublish = terrainAnalysisConfigScalars(terrainAtPublish,
            Globals.equatorRadius, Globals.polarRadius, terrainDataEpoch(terrainAtPublish));
        if (terrainConfigAtPublish.length !== terrainConfigAtStart.length
            || terrainConfigAtPublish.some((value, i) => !Object.is(value, terrainConfigAtStart[i]))) {
            terrainChangedDuringRun = true;
            console.warn("Traverse analysis: terrain configuration changed during the run; "
                + "reporting results computed at the start-of-run terrain.");
        }
        const terrainDependenciesAtPublish = resampleTerrainDependencies(
            terrainDependenciesAtBuild);
        if (!terrainDependencyRecordsMatch(terrainDependenciesAtBuild,
            terrainDependenciesAtPublish)) {
            terrainChangedDuringRun = true;
            console.warn("Traverse analysis: sampled elevation changed during the run; "
                + "reporting results computed at the start-of-run elevation.");
        }

        // detailed per-frame series. The sweep's best is always computed (the
        // report's sweep paragraph quotes it), but the SELECTED constant-air
        // representative — what the charts and plan view draw — follows the
        // regime pick: the slow-drift valley when it demoted the sweep best.
        const bestTrav = constAirSpeedTrack(dataset, sweep.best.startDist, sweep.best.speed);
        const sweepBestMetrics = trackMetrics(dataset, bestTrav.track);
        const constAirHyp = hypotheses.find((h) => h.key === "constAir" && h.track && h.metricsFull);
        const constAirIsSlow = constAirHyp?.params?.regime === "slow";
        const bestTrack = constAirIsSlow ? constAirHyp.track : bestTrav.track;
        const bestMetrics = constAirIsSlow ? constAirHyp.metricsFull : sweepBestMetrics;
        const constAirPick = constAirIsSlow ? {
            range: constAirHyp.params.range,
            airSpeed: constAirHyp.params.airSpeed,
            slowScore: constAirHyp.params.slowScore,
            fastScore: constAirHyp.params.fastScore,
        } : null;

        // slow-object plausible track at ITS best range, for the plan view
        const slowBestRow = slowProfile.reduce((a, b) => (b.score < a.score ? b : a));
        const slowTrack = traversePlausible(dataset, slowBestRow.startDist, slowOpts).track;

        let windText = "zero / ignored";
        if (analysisWindNode && isFinite(analysisWindNode.knots)) {
            if (analysisWindNode.trackSource && typeof analysisWindNode.trackWindAt === "function") {
                const speeds = [];
                for (let f = analysisFrames.frame0; f <= analysisFrames.frame1; f++) {
                    const sample = analysisWindNode.trackWindAt(f);
                    if (sample && Number.isFinite(sample.knots)) speeds.push(sample.knots);
                }
                speeds.sort((a, b) => a - b);
                if (speeds.length) {
                    const median = speeds[Math.floor(speeds.length / 2)];
                    windText = `time-varying track wind (${analysisWindNode.trackSource}): ` +
                        `${speeds[0].toFixed(0)}–${median.toFixed(0)}–${speeds[speeds.length - 1].toFixed(0)} kt ` +
                        `(min/median/max; direction sampled by timestamp)`;
                } else {
                    windText = `track wind (${analysisWindNode.trackSource}); no valid historical samples`;
                }
            } else {
                windText = `${Number(analysisWindNode.knots).toFixed(0)} kt from ` +
                    `${Number(analysisWindNode.from).toFixed(0)}°`;
            }
        }

        // "Cost of proximity" window over the DISPLAY grid: 6-8 NM for
        // far-field sitches (the classic Gimbal question), else an adaptive
        // close-end window for close scenes.
        const gridLo = resolvedRanges[0];
        const gridHi = resolvedRanges[resolvedRanges.length - 1];
        let closeLoM, closeHiM;
        if (gridHi > 12 * METERS_PER_NM && gridLo <= 6 * METERS_PER_NM) {
            closeLoM = 6 * METERS_PER_NM;
            closeHiM = 8 * METERS_PER_NM;
        } else {
            const span = gridHi - gridLo;
            closeLoM = gridLo + span * 0.12;
            closeHiM = gridLo + span * 0.30;
        }

        // LAZY report: the full HTML report (dozens of 2x PNG chart encodes,
        // ~10 MB of string) used to be built eagerly inside every analysis run
        // even though it is only seen when the user clicks "Open Full Report".
        // Build it on demand instead — several seconds off every analysis.
        // provenance was resolved (and possibly measured-substituted) up front,
        // then annotated with the sensor-baseline stats after the dataset build.
        const manifest = Object.freeze({
            inputFingerprint: `0x${fp.toString(16).padStart(8, "0")}`,
            situation: Sit.name ?? "unnamed sitch",
            frames: {start: dataset.frame0, end: dataset.frame1, count: dataset.n},
            timing: {
                sourceFps: Sit.fps,
                simSpeed: Sit.simSpeed ?? 1,
                physicalFps: dataset.fps,
            },
            assumptions: {
                speedTargetKt: speedTarget / KNOTS_TO_MS,
                windMode: analyzeTweaks.windMode,
                windSummary: windText,
                fittedWindModels: ["Sky Lantern / Balloon", "Quadcopter"],
                groundMode: analyzeTweaks.groundMode,
                truthTrack: truth ? truth.label : null,
                constructedLOS: provenance.circular,
                losSource: provenance.losSource,
                cameraHeading: provenance.cameraHeading,
                measuredLOSSubstituted: provenance.measuredSubstituted
                    ? provenance.measuredLOSId : null,
                rangeUnobservable: !!provenance.rangeUnobservable,
                sensorBaselineM: Number.isFinite(provenance.sensorSpan)
                    ? Math.round(provenance.sensorSpan) : null,
            },
            searchBounds: {
                userSpecified: !rangeIsDefault,
                constantAirRangeM: [resolvedRanges[0], resolvedRanges[resolvedRanges.length - 1]],
                constantAirSpeedMS: [sweep.speeds[0], sweep.speeds[sweep.speeds.length - 1]],
                aircraftRangeM: [fitRangeMin, fitRangeMax],
                constantAltitudeRangeM: [caRangeMin, caRangeMax],
                minimumAccelerationRangeM: [plausRangeMin, plausRangeMax],
            },
            completeness: {
                constantAirBoundaryAxes: sweep.boundaryAxes,
                fastProfileBoundaryLimited: !!fastProfile.boundaryLimited,
                slowProfileBoundaryLimited: !!slowProfile.boundaryLimited,
                minimumAccelerationBoundaryLimited: !!plausible.boundaryLimited,
            },
            optimizers: {
                aircraftRuns: aircraft.runs.map((r) => ({
                    seed: r.de?.seed,
                    deGenerations: r.de?.generations,
                    deEvaluations: r.de?.evaluations,
                    deStopReason: r.de?.stopReason,
                    polishIterations: r.polishIterations,
                    polishStopReason: r.polishStopReason,
                })),
                lantern: lantern?.params?.optimizer ?? null,
                quadcopter: quad?.params?.optimizer ?? null,
            },
            checks: {
                stationary: analyzeTweaks.aoFixedPoint,
                astronomyAtTime: analyzeTweaks.aoKnownNow,
                astronomyTimeSearch: analyzeTweaks.aoKnownOther,
                satellite: analyzeTweaks.satellite,
                failures: failures.map((f) => ({...f})),
            },
        });
        const buildHtml = () => buildReportHTML({
            sitName: Sit.name ?? "unnamed sitch",
            dataset, windText, speedTarget,
            sweep, fastProfile, slowProfile, aircraft,
            bestTrack, bestMetrics, sweepBestMetrics, constAirPick,
            slowBestRow, slowTrack,
            closeLoM, closeHiM,
            hypotheses, provenance, failures, manifest,
            truth, terrainChangedDuringRun,
        });

        const terrainDependencies = terrainDependenciesAtBuild;
        results = {
            dataset, sweep, fastProfile, slowProfile, aircraft,
            best: sweep.best, bestMetrics, slowBestRow, hypotheses,
            truth,
            buildHtml, html: null,
            provenance, failures, manifest,
            terrainChangedDuringRun,
        };
        window.lastTraverseAnalysis = results;
        // View-dependent global tile LOD is not an analysis input. Preserve the
        // precise ground samples that did affect candidate grading instead.
        _analysisCache = {fp, terrainDependencies, results};
    } catch (error) {
        if (error && error.message === "cancelled") return null;
        // Elevation changing mid-run no longer aborts — it is noted and the run
        // finishes (see terrainChangedDuringRun). Any other error is a real fault.
        throw error;
    } finally {
        overlay.remove();
        _analysisRunning = false;
    }

    const b = results.sweep.best;
    const a = results.aircraft.params;
    console.log(`Traverse analysis: best const-air ${nm1(b.startDist)} NM @ ${kt1(b.speed)} kt ` +
        `(score ${b.score.toFixed(2)}); aircraft fit ${nm1(a.startDist)} NM, hdg ${a.heading.toFixed(0)}, ` +
        `horizontal airspeed ${kt1(a.tas)} kt, err ${results.aircraft.errDeg.toFixed(3)} deg`);

    // The primary result is now a full-screen interactive gallery of candidate
    // interpretations (each with a "Use This" apply button); the full HTML
    // report is one click away from its footer.
    showResultGallery(results);
    return results;
}

// ---------------------------------------------------------------------------
// Node plumbing
// ---------------------------------------------------------------------------

// ~44 uniform start ranges spanning the plausible band around the user's
// current start-distance hypothesis. Centered so both close-range (Aguadilla
// ~2 NM) and far (Gimbal ~30 NM) sitches get good resolution of the valley.
function adaptiveRangeList(centerMeters, count = 44) {
    const cNM = Math.max(0.5, centerMeters / METERS_PER_NM);
    const loNM = Math.max(0.3, 0.1 * cNM);
    const hiNM = Math.min(90, Math.max(8, 2 * cNM));
    const ranges = [];
    for (let i = 0; i < count; i++) {
        const nm = loNM + (hiNM - loNM) * i / (count - 1);
        ranges.push(nm * METERS_PER_NM);
    }
    return ranges;
}

// The analysis fits the In/Out (A-B) window. abFrameRange is the shared
// authority — the live LOS fit methods use the same window, so an applied
// gallery tile reproduces the same fit.
function analysisFrameRange(losNode) {
    // Preserve the user's exact A/B selection here so the explicit <10-frame
    // readiness error can fire. The shared helper's default protects standalone
    // live fit nodes from degenerate windows by falling back to the full clip.
    return abFrameRange(losNode.frames, 1);
}

function losFrameView(losNode, frame0, frame1) {
    return {
        frames: frame1 - frame0 + 1,
        v: (f) => losNode.v(frame0 + f),
    };
}

// `count` uniform start ranges (meters) spanning the explicit [lo, hi] band the
// user pinned via the analysisMinDist / analysisMaxDist GUI values.
function uniformRangeList(loMeters, hiMeters, count = 44) {
    const ranges = [];
    for (let i = 0; i < count; i++) {
        ranges.push(loMeters + (hiMeters - loMeters) * i / (count - 1));
    }
    return ranges;
}

function resolveLOSNode() {
    const jetLOS = NodeMan.get("JetLOS", false);
    if (jetLOS) return jetLOS;
    const constAir = NodeMan.get("LOSTraverseConstantAirSpeed", false);
    if (constAir && constAir.in && constAir.in.LOS) return constAir.in.LOS;
    return null;
}

// The camera track's MEASURED sensor LOS, if it has one: a MISB import with
// sensor az/el gets a CNodeLOSTrackMISB node ("Track_<shortName>_LOS") whose
// per-frame origin is the platform position and whose direction is the
// recorded (independently measured) sensor attitude. Only offered when the
// camera actually follows that track — a camera parked elsewhere makes the
// track's sightlines someone else's evidence.
function resolveMeasuredLOSNode(selectedLOSNode) {
    const camShort = NodeMan.get("cameraTrackSwitch", false)?.choice;
    if (!camShort) return null;
    const node = NodeMan.get("Track_" + camShort + "_LOS", false);
    if (!node || typeof node.v !== "function" || !node.frames) return null;
    // Defensive: the measured LOS must cover the same frame grid as the
    // selected LOS or the A-B window / readiness checks would silently shift.
    if (selectedLOSNode?.frames && node.frames !== selectedLOSNode.frames) return null;
    return node;
}

// LOS provenance: detect CIRCULAR (target-derived) sightlines. In the custom
// sitch family the look camera can be aimed straight at the current target
// track ("Camera Heading" = To Target) while the analysis LOS is the raw
// camera centerline ("LOS Source" = Camera Center) — the sightlines are then
// CONSTRUCTED from the very target the analysis is asked to find, and any fit
// recovering it (e.g. a perfect Stationary Point) is an internal-consistency
// check, not an independent discovery. Video-tracking LOS sources (manual /
// auto object track) re-derive the direction from the video pixels, so they
// are treated as measurements even when the camera base pose is To Target.
function losProvenance() {
    const jetLOS = NodeMan.get("JetLOS", false);
    const camCtrl = NodeMan.get("CameraLOSController", false);
    const losChoice = jetLOS && jetLOS.choice;
    const ctrlChoice = camCtrl && camCtrl.choice;
    let selectedLOS = jetLOS && jetLOS.choice && jetLOS.inputs
        ? jetLOS.inputs[jetLOS.choice] : jetLOS;
    if (typeof selectedLOS === "string") selectedLOS = NodeMan.get(selectedLOS, false);
    // The PLAIN camera-center boresight, as opposed to a tracking-derived LOS
    // ("Camera + Point Track" etc.) that adds a real measured per-pixel offset
    // to the centreline. Only the plain boresight may be swapped for the
    // recorded sensor angles — substituting under a tracking source would
    // discard the pixel offset while claiming measurement.
    const selectedIsCameraCenter = selectedLOS?.id === "JetLOSCameraCenter";
    const dependsOn = (node, targetID, seen = new Set()) => {
        if (!node || seen.has(node)) return false;
        if (node.id === targetID) return true;
        seen.add(node);
        const deps = node.in || node.inputs || {};
        return Object.values(deps).some((dep) => dependsOn(dep, targetID, seen));
    };
    // Manual/auto pixel tracking supplies an offset from the camera centreline;
    // it does not independently determine the camera's absolute attitude. If
    // that base centreline is aimed "To Target", every derived LOS remains
    // target-dependent even when the tracked pixel is off-centre.
    if (ctrlChoice === "To Target" && dependsOn(selectedLOS, "JetLOSCameraCenter")) {
        return {
            circular: true,
            selectedIsCameraCenter,
            losSource: losChoice,
            cameraHeading: ctrlChoice,
            reason: `Camera Heading is "To Target" and the selected ${losChoice || "camera-derived"} ` +
                "LOS still depends on that target-aimed camera attitude. Pixel tracking adds only a relative " +
                "offset, so these sightlines are not independent of the target being tested.",
        };
    }
    return {circular: false, selectedIsCameraCenter,
        losSource: losChoice ?? "unknown", cameraHeading: ctrlChoice ?? "n/a"};
}

function openReport(html) {
    const blob = new Blob([html], {type: "text/html"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // revoke once the new tab has had time to load it (the HTML embeds large
    // PNG data-URLs; not revoking retains the blob for the tab's lifetime).
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Progress overlay (same idiom as FeaturePanoramaExporter, plus a bar)
// ---------------------------------------------------------------------------

function createProgressOverlay(titleText) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;" +
        "background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;" +
        "justify-content:center;flex-direction:column;font-family:sans-serif;";

    const title = document.createElement("div");
    title.textContent = titleText;
    title.style.cssText = "color:#fff;font-size:20px;font-weight:600;";

    const status = document.createElement("div");
    status.style.cssText = "color:#ccc;font-size:15px;margin-top:12px;min-height:18px;";

    const barOuter = document.createElement("div");
    barOuter.style.cssText = "width:420px;max-width:80vw;height:14px;margin-top:14px;" +
        "background:#222;border:1px solid #555;border-radius:7px;overflow:hidden;";
    const barInner = document.createElement("div");
    barInner.style.cssText = "width:0%;height:100%;background:" + VIZ.constAir + ";";
    barOuter.appendChild(barInner);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "margin-top:16px;padding:6px 18px;font-size:15px;cursor:pointer;";
    let cancelled = false;
    cancelBtn.onclick = () => {
        cancelled = true;
        cancelBtn.disabled = true;
        cancelBtn.textContent = "Cancelling…";
    };

    overlay.appendChild(title);
    overlay.appendChild(status);
    overlay.appendChild(barOuter);
    overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);

    return {
        setStatus(s) { status.textContent = s; },
        setFraction(f) { barInner.style.width = (100 * Math.min(1, Math.max(0, f))).toFixed(1) + "%"; },
        isCancelled() { return cancelled; },
        remove() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); },
    };
}

// ---------------------------------------------------------------------------
// Full-screen result gallery — the primary interactive result of an analysis.
// A grid of tiles (one per candidate interpretation with a track), each with an
// overhead thumbnail, key stats, a plausibility tier badge, and a "Use This"
// button that applies that interpretation to the live scene. The full HTML
// report is reachable from the footer.
// ---------------------------------------------------------------------------

// Brief, non-blocking, self-removing confirmation toast (no native dialogs).
// Fully inline-styled so it survives the overlay (and its scoped <style>) being
// removed first.
function showGalleryToast(text) {
    const toast = document.createElement("div");
    toast.textContent = text;
    toast.style.cssText = "position:fixed;left:50%;bottom:34px;transform:translateX(-50%);" +
        "background:#1c2128;color:#e8eaed;border:1px solid rgba(255,255,255,0.14);" +
        "padding:10px 18px;border-radius:8px;font:14px system-ui,-apple-system,sans-serif;" +
        "z-index:10001;box-shadow:0 6px 24px rgba(0,0,0,0.5);pointer-events:none;";
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 2200);
}

// Angular sweep of the sightlines and the sensor baseline — the geometry that
// determines whether range is observable at all. A narrow azimuth sweep over a
// short baseline means many ranges fit the rays about equally (degenerate).
function describeSceneGeometry(dataset) {
    const {n, S, D} = dataset;
    const azd = (f) => Math.atan2(D[f * 3], D[f * 3 + 1]) * 180 / Math.PI;   // E,N
    const eld = (f) => Math.asin(Math.max(-1, Math.min(1, D[f * 3 + 2]))) * 180 / Math.PI;
    let prev = azd(0), azMin = prev, azMax = prev, elMin = eld(0), elMax = eld(0);
    for (let f = 0; f < n; f++) {
        let a = azd(f);
        while (a - prev > 180) a -= 360;
        while (a - prev < -180) a += 360;
        prev = a;
        if (a < azMin) azMin = a; if (a > azMax) azMax = a;
        const e = eld(f);
        if (e < elMin) elMin = e; if (e > elMax) elMax = e;
    }
    const baselineNM = toNM(Math.hypot(
        S[(n - 1) * 3] - S[0], S[(n - 1) * 3 + 1] - S[1], S[(n - 1) * 3 + 2] - S[2]));
    return {azSweep: azMax - azMin, elSweep: elMax - elMin, baselineNM};
}

// How peaked the smoothness-vs-range curve is: contrast = median/min score.
// ~1 => flat (range unobservable, a degenerate family); large => a real valley
// (the data genuinely prefer one range). Returns null if the profile is unusable.
function describeRangeConvergence(profile) {
    if (!profile || profile.length < 3) return null;
    const rows = profile.filter((p) => isFinite(p.score));
    if (rows.length < 3) return null;
    let best = rows[0];
    for (const p of rows) if (p.score < best.score) best = p;
    const scores = rows.map((p) => p.score).sort((a, b) => a - b);
    const med = scores[Math.floor(scores.length / 2)];
    const min = scores[0];
    const contrast = min > 1e-9 ? med / min : Infinity;
    return {bestRangeNM: toNM(best.startDist), contrast, min, med,
        loNM: toNM(rows[0].startDist), hiNM: toNM(rows[rows.length - 1].startDist)};
}

// One-time solution-space context shared by every Details pane.
function analyzeSolutionSpace(results) {
    const geo = describeSceneGeometry(results.dataset);
    const conv = describeRangeConvergence(results.fastProfile);
    // Degenerate range if the sightlines barely sweep AND the profile is flat.
    const flat = !conv || !isFinite(conv.contrast) ? false : conv.contrast < 1.4;
    const narrow = geo.azSweep < 6;
    return {geo, conv, degenerate: narrow && flat, narrow, flat};
}

// The six headline stats for one hypothesis (shared by tile and Details pane).
function hypothesisStats(h) {
    const m = h.metricsFull;
    // Always show the raw residual. The old "≤ reference fit" replacement hid
    // the very number used to grade forward models (GoFast Balloon: 0.297°),
    // making its Low tier inexplicable. The generic reference remains context,
    // never a substitute or a noise estimate.
    const losErr = formatRawLosResidual(h);
    const errLabel = (h.params && (h.params.object || h.params.satellite)) ? "LOS offset" : "LOS error";
    const stats = [
        // slant range over the clip, not an uncertainty interval — label it so
        ["Slant range (min–max)", `${nm1(m.range.min)}–${nm1(m.range.max)} NM`],
        [h.params?.motionFrame === "ground" ? "Ground speed (mean / max)" : "Air speed (mean / max)",
            `${kt1(m.airSpeed.mean)} / ${kt1(m.airSpeed.max)} kt`],
        ["Altitude (geodetic)", `${ft0(m.altitude.min)}–${ft0(m.altitude.max)} ft`],
        ["Climb", `${fpm0(m.verticalSpeed.mean)} fpm`],
        ["Max kinematic accel", `${m.gLoad.max.toFixed(2)} g`],
        [errLabel, losErr],
    ];
    // What the model's soft priors cost at the solution, in the same units as
    // the residual above. Shown only when it is worth noticing (0.005°, an
    // order of magnitude below the tier boundaries) so a fit the priors barely
    // touched stays uncluttered. This exists because the LOS error above is
    // pure angular error by construction and excludes these terms, so without
    // it a tile can say a value was inferred from the sightlines when a prior
    // helped choose it — including the aircraft model's priors against
    // maneuvering, not just the balloon's toward calm air.
    const priors = h.params?.priors;
    if (priors && priors.total > 0.005) {
        const parts = Object.entries(priors.terms)
            .filter(([, v]) => v > 0.0005)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v.toFixed(3)}°`);
        stats.push(["Model priors cost",
            `${priors.total.toFixed(3)}°${parts.length ? ` (${parts.join(", ")})` : ""}`]);
    }
    // Truth-mode headline: the separation that actually orders this group
    const tc = h.truthComparison;
    if (tc) {
        const fmtSep = (v) => (v >= METERS_PER_NM ? `${nm1(v)} NM` : `${Math.round(v)} m`);
        stats.push(["Truth Δ (mean 3D)",
            tc.comparable ? fmtSep(tc.sep3D.mean) : "n/a"]);
    }
    return stats;
}

function graphPoint(arr, f) {
    return [toNM(arr[f * 3]), toNM(arr[f * 3 + 1]), toNM(arr[f * 3 + 2])];
}

function growGraphBounds(b, p) {
    if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) return;
    if (p[0] < b.minX) b.minX = p[0];
    if (p[0] > b.maxX) b.maxX = p[0];
    if (p[1] < b.minY) b.minY = p[1];
    if (p[1] > b.maxY) b.maxY = p[1];
    if (p[2] < b.minZ) b.minZ = p[2];
    if (p[2] > b.maxZ) b.maxZ = p[2];
}

function padAxisRange(lo, hi, frac, fallback) {
    const span = hi - lo;
    const pad = (span > 0 ? span : fallback) * frac;
    const mid = (lo + hi) / 2;
    if (span > 0) return [lo - pad, hi + pad];
    return [mid - fallback / 2, mid + fallback / 2];
}

function padGraphBounds(b) {
    if (!isFinite(b.minX)) return {minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 0, maxZ: 1};
    const [minX, maxX] = padAxisRange(b.minX, b.maxX, 0.08, 1);
    const [minY, maxY] = padAxisRange(b.minY, b.maxY, 0.08, 1);
    const minZ = 0;
    const zMax = Math.max(0, b.maxZ);
    const maxZ = zMax + Math.max(zMax, 1) * 0.14;
    return {minX, maxX, minY, maxY, minZ, maxZ};
}

// Tight bounds for the per-chart "zoom to tracks" view (units NM). Unlike
// padGraphBounds the floor is NOT forced to z = 0: the graph z is a RELATIVE
// altitude (tracks routinely straddle 0), and because zoom mode clips series
// to its bounds, forcing the floor up would delete the below-reference
// segments rather than merely restyle the box. Returns null when nothing was
// accumulated.
function padZoomBounds(b) {
    if (!isFinite(b.minX)) return null;
    const [minX, maxX] = padAxisRange(b.minX, b.maxX, 0.08, 1);
    const [minY, maxY] = padAxisRange(b.minY, b.maxY, 0.08, 1);
    const [minZ, maxZ] = padAxisRange(b.minZ, b.maxZ, 0.08, 0.25);
    return {minX, maxX, minY, maxY, minZ, maxZ};
}

function sampledFrames(n, target) {
    const step = Math.max(1, Math.floor((n - 1) / Math.max(1, target - 1)));
    const out = [];
    for (let f = 0; f < n; f += step) out.push(f);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
}

function sampledPolyline(arr, n, target = 520) {
    return sampledFrames(n, target).map((f) => graphPoint(arr, f));
}

function rayEndPoint(dataset, f, lenM) {
    const {S, D} = dataset;
    return [
        toNM(S[f * 3] + D[f * 3] * lenM),
        toNM(S[f * 3 + 1] + D[f * 3 + 1] * lenM),
        toNM(S[f * 3 + 2] + D[f * 3 + 2] * lenM),
    ];
}

function meanLOSDirection(dataset) {
    const {n, D} = dataset;
    let x = 0, y = 0, z = 0;
    for (let f = 0; f < n; f++) {
        x += D[f * 3];
        y += D[f * 3 + 1];
        z += D[f * 3 + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
}

function hypothesisVolumeScene(dataset, hyp, opts = {}) {
    const {n, S, D} = dataset;
    const b = {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity};
    // Second accumulator for the magnifier ("zoom to tracks") view: grown ONLY
    // over the traverse track and the truth track, never the sensor path or
    // ray endpoints, so a distant platform stops dictating the scale.
    const zb = {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity};
    const series = [];
    const sensorPts = sampledPolyline(S, n, opts.compact ? 260 : 520);
    for (const p of sensorPts) growGraphBounds(b, p);

    if (hyp.atInfinity) {
        const dir = meanLOSDirection(dataset);
        let sensorSpanM = 0;
        for (const f of sampledFrames(n, 30)) {
            sensorSpanM = Math.max(sensorSpanM,
                Math.hypot(S[f * 3] - S[0], S[f * 3 + 1] - S[1], S[f * 3 + 2] - S[2]));
        }
        const lenM = Math.max(sensorSpanM * 1.15, 3 * METERS_PER_NM);
        const segs = [];
        for (const f of sampledFrames(n, opts.compact ? 6 : 9)) {
            const a = graphPoint(S, f);
            const c = [
                toNM(S[f * 3] + dir[0] * lenM),
                toNM(S[f * 3 + 1] + dir[1] * lenM),
                toNM(S[f * 3 + 2] + dir[2] * lenM),
            ];
            growGraphBounds(b, a);
            growGraphBounds(b, c);
            segs.push([...a, ...c]);
        }
        series.push({type: "rays", segs, color: hyp.color || VIZ.ink2, alpha: 0.72, width: opts.compact ? 1.4 : 1.8});
    } else {
        const trackPts = sampledPolyline(hyp.track, n, opts.compact ? 360 : 720);
        for (const p of trackPts) { growGraphBounds(b, p); growGraphBounds(zb, p); }

        let maxRange = 0;
        for (const f of sampledFrames(n, 60)) {
            maxRange = Math.max(maxRange, Math.hypot(
                hyp.track[f * 3] - S[f * 3],
                hyp.track[f * 3 + 1] - S[f * 3 + 1],
                hyp.track[f * 3 + 2] - S[f * 3 + 2]));
        }
        const rayLenM = Math.max(maxRange * 1.06, METERS_PER_NM);
        const segs = [];
        for (const f of sampledFrames(n, opts.compact ? 7 : 11)) {
            const a = graphPoint(S, f);
            const c = rayEndPoint(dataset, f, rayLenM);
            growGraphBounds(b, c);
            segs.push([...a, ...c]);
        }
        series.push({type: "rays", segs, color: VIZ.ray, alpha: 0.52, width: 1});
        series.push({type: "line", pts: trackPts, color: hyp.color, width: opts.compact ? 2.2 : 2.8,
            startDot: true, endRing: true});
    }

    series.push({type: "line", pts: sensorPts, color: VIZ.sensor, width: opts.compact ? 1.8 : 2.4,
        startDot: true, endRing: false});

    // Ground-truth reference track (dashed, fixed truth color). Only frames
    // inside the truth track's own time span are drawn; validity is a
    // contiguous window, so the filtered polyline stays one segment.
    if (opts.truth) {
        const tv = opts.truth.valid;
        const truthPts = sampledFrames(n, opts.compact ? 360 : 720)
            .filter((f) => !tv || tv[f] === 1)
            .map((f) => graphPoint(opts.truth.track, f));
        if (truthPts.length > 1) {
            for (const p of truthPts) { growGraphBounds(b, p); growGraphBounds(zb, p); }
            series.push({type: "line", pts: truthPts, color: VIZ.truth,
                width: opts.compact ? 1.8 : 2.2, dash: [6, 4],
                startDot: true, endRing: true});
        }
    }

    return {
        bounds: padGraphBounds(b),
        zoomBounds: padZoomBounds(zb),
        series,
        labels: {x: "East (NM)", y: "North (NM)", z: "Alt (NM)"},
        fmt: {x: (v) => fmtNum(v), y: (v) => fmtNum(v), z: (v) => fmtNum(v)},
    };
}

// Reference sentence for off-ray physics fits. A flexible constant-acceleration
// residual mixes measurement error with model mismatch; it is not sensor noise.
function floorContext(err, floor) {
    if (!isFinite(floor) || floor < 0.02 || !isFinite(err)) return "";
    const ratio = err / floor;
    const rel = ratio < 1.35
        ? `similar to that reference residual`
        : `${ratio.toFixed(1)}× that reference residual`;
    return ` For context: a flexible constant-acceleration fit leaves ${floor.toFixed(2)}° on these ` +
        `sightlines, and this fit's ${err.toFixed(2)}° is ${rel}. The reference combines pointing error ` +
        `and trajectory-model mismatch; it is not a sensor-noise estimate.`;
}

// Method-specific prose: how the numbers were derived, and what constrains the
// result / makes it (im)plausible. Returns {lead, derived, constraint}.
function detailProse(h, r, ss) {
    const m = h.metricsFull;
    const p = h.params || {};
    const g = m.gLoad.max, spdKt = toKt(m.airSpeed.mean);
    const rMin = nm1(m.range.min), rMax = nm1(m.range.max);
    const err = Number.isFinite(h.errDeg) ? h.errDeg : Infinity;
    const onRay = err < 1e-3;
    const screenContext = (subject) => {
        const label = escapeHtml(r?.label ?? "Not scored");
        const reasons = Array.isArray(r?.reasons) && r.reasons.length
            ? `: ${escapeHtml(r.reasons.join("; "))}` : "";
        const outcome = r?.eligible
            ? `${subject} passes the current broad screen`
            : `${subject} is rated <b>${label}</b> by the current broad screen`;
        return `${outcome}${reasons}. This is a heuristic kinematic/model-fit screen, not an ` +
            `object-identification probability.`;
    };
    const inactiveBoundContext = () => {
        const inactive = Array.isArray(h.boundInactive) ? h.boundInactive : [];
        if (!inactive.length) return "";
        return ` ${inactive.length === 1 ? "A parameter is" : "Parameters are"} at a model bound but ` +
            `locally inactive over this clip (${escapeHtml(inactive.join(", "))}); ` +
            `${inactive.length === 1 ? "it is" : "they are"} reported as unresolved, not as a physical failure.`;
    };
    switch (h.key) {
        case "constAir":
            return {
                lead: `An object holding a constant air speed of about ${kt1(p.airSpeed)} kt ` +
                    `(achieved ${kt1(m.airSpeed.mean)} kt), starting near ${nm1(p.range)} NM.`,
                derived: p.regime === "slow"
                    ? `The fast grid search (anchored on the Target Speed prior) and the slow-object ` +
                      `range profile were both solved, then re-scored on the same neutral smoothness ` +
                      `metric. The slow-drift valley won decisively (${(p.slowScore ?? 0).toFixed(2)} vs ` +
                      `${(p.fastScore ?? 0).toFixed(2)}, lower is better): the smoothest constant-air-speed ` +
                      `explanation is ~${kt1(p.airSpeed)} kt near ${nm1(p.range)} NM, not anything near the ` +
                      `Target Speed prior.`
                    : `A grid search over start range × air speed (15–650 kt, log-spaced) solves each ` +
                      `combination as the smoothest ray-following path that holds that air speed (wind ` +
                      `subtracted), scoring smoothness plus how well the speed could actually be held. ` +
                      `The selected family representative is ${nm1(p.range)} NM @ ${kt1(p.airSpeed)} kt; ` +
                      `it is prior-selected when several cells score about equally.`,
                constraint: onRay
                    ? `It sits on the sightlines by construction (0° error), so the LOS fit is automatic — ` +
                      `plausibility rests on the implied motion: ${kt1(m.airSpeed.mean)} kt, up to ${g.toFixed(2)} g.`
                    : `The displayed and applied snapshot follows the rays to ${err.toFixed(3)}° after smoothing.`,
            };
        case "constAlt":
            return {
                lead: `An object holding a constant altitude of about ${ft0(m.altitude.mean ?? m.altitude.min)} ft, ` +
                    `implying ${kt1(m.airSpeed.mean)} kt across ${rMin}–${rMax} NM.`,
                derived: `The altitude that best rides the rays at constant height is found by a 1-D search: ` +
                    `for each candidate altitude the object is placed where each ray crosses that height, the ` +
                    `path is lightly smoothed (so sensor pointing jitter can't poison the correct altitude), and ` +
                    `the speed/heading smoothness plus the residual LOS miss are scored. Best altitude ≈ ` +
                    `${ft0(p.altZ)} ft.`,
                constraint: onRay
                    ? `On the sightlines by construction; the tell is the implied ${kt1(m.airSpeed.mean)} kt and ` +
                      `${g.toFixed(2)} g.`
                    : `The displayed and applied snapshot misses the rays by ${err.toFixed(3)}° after smoothing.`,
            };
        case "plausible":
            return {
                lead: p.usedSpeedTarget
                    ? `The acceleration-minimizing path consistent with the rays at a soft speed target — ` +
                      `${kt1(m.airSpeed.mean)} kt near ${rMin}–${rMax} NM, peaking at ${g.toFixed(2)} g.`
                    : `The acceleration-minimizing path consistent with the rays — ${kt1(m.airSpeed.mean)} kt near ` +
                      `${rMin}–${rMax} NM, peaking at ${g.toFixed(2)} g. The smoothness-vs-range profile picked ` +
                      `the range on its own; no speed assumption was needed.`,
                derived: p.usedSpeedTarget
                    ? `A smooth B-spline trajectory is fit to ride the sightlines while penalising ` +
                      `acceleration and departures from the target speed (IRLS). The sightline geometry alone ` +
                      `left the range ambiguous (a flat smoothness-vs-range valley), so the target speed picks ` +
                      `the representative member — the classic narrow-baseline case.`
                    : `A smooth B-spline trajectory is fit to ride the sightlines while penalising acceleration. ` +
                      `The start range is chosen purely by geometry: the smoothness-vs-range valley is decisive ` +
                      `(margin ${isFinite(p.decisiveness) ? p.decisiveness.toFixed(2) : "?"}), so the speed target ` +
                      `was not used.`,
                constraint: `Follows the rays (residual ${err.toFixed(3)}° after light smoothing); plausibility ` +
                    `is set by how gentle that best path is (${g.toFixed(2)} g max, speed std ` +
                    `${kt1(m.airSpeed.std)} kt).`,
            };
        case "aircraft": {
            return {
                lead: `A fixed-wing aircraft on a near-straight course: ${kt1(p.tas)} kt horizontal airspeed at ` +
                    `about ${nm1(p.range)} NM and ${ft0(m.altitude.min)}–${ft0(m.altitude.max)} ft, ` +
                    `turning ${(p.turn ?? 0).toFixed(2)}°/s and climbing ${fpm0((p.climb ?? 0))} fpm. ` +
                    `It reproduces the sightlines to ${err.toFixed(3)}°.`,
                derived: `A constant-horizontal-airspeed flight model (range, heading, speed, turn rate, climb) is fit to the ` +
                    `sightlines by deterministically seeded differential-evolution restarts, then polished. ` +
                    `Its ${err.toFixed(3)}° residual is the in-sample angular mismatch for this model and its ` +
                    `priors; it is not an aircraft-identification probability.`,
                constraint: screenContext("This fixed-wing parameterization") +
                    ` Its solved motion is ${kt1(p.tas)} kt horizontal airspeed and ${g.toFixed(2)} g maximum ` +
                    `kinematic acceleration.` + inactiveBoundContext() + floorContext(err, p.errFloor),
            };
        }
        case "lantern": {
            // solved wind (at the initial altitude) in friendly units
            const windKt = p.windE !== undefined ? toKt(Math.hypot(p.windE, p.windN)) : NaN;
            const windFrom = p.windE !== undefined
                ? ((Math.atan2(-p.windE, -p.windN) * 180 / Math.PI + 360) % 360) : NaN;
            const windTxt = isFinite(windKt)
                ? `${windKt.toFixed(0)} kt from ${windFrom.toFixed(0)}°` : "?";
            const shearTxt = p.shearPerM !== undefined
                ? `${(p.shearPerM * 100 >= 0 ? "+" : "")}${(p.shearPerM * 100).toFixed(2)}%/m` : "?";
            // which life-cycle stages does the clip cover?
            const T = p.clipT ?? 0;
            const phaseTxt = p.tBurn === undefined ? "" :
                p.tBurn <= 0
                    ? ` The solved flame-out is ${(-p.tBurn).toFixed(0)} s before the clip — a lantern ` +
                      `already in its slow cooling descent (terminal sink ${(p.vSink ?? 0).toFixed(1)} m/s).`
                    : p.tBurn >= T
                        ? ` The flame burns for the whole clip — a lantern still rising at ` +
                          `${(p.vRise ?? 0).toFixed(1)} m/s.`
                        : ` The flame dies ${p.tBurn.toFixed(0)} s in: rise at ${(p.vRise ?? 0).toFixed(1)} m/s, ` +
                          `then a cooling transition toward a ${(p.vSink ?? 0).toFixed(1)} m/s sink.`;
            return {
                lead: `A buoyant sky lantern / balloon drifting with the wind — ` +
                    `${kt1(m.airSpeed.mean)} kt mean at ${ft0(m.altitude.min)}–${ft0(m.altitude.max)} ft, ` +
                    `reproducing the sightlines to ${err.toFixed(2)}°.`,
                derived: `Wind-drift kinematics: the lantern's horizontal velocity IS the wind at its ` +
                    `altitude (solved ${windTxt}, shear ${shearTxt}), and its vertical motion follows the ` +
                    `lantern life cycle (rise while lit, buoyancy decay after flame-out, terminal sink), ` +
                    `fit to the sightlines by differential evolution.${phaseTxt}`,
                constraint: screenContext("This bounded drift parameterization") +
                    ` The fitted priors limit initial wind components to ±20 m/s, clamp altitude shear to ` +
                    `0.25–3×, and limit vertical rates to 4 m/s; this test does not exclude balloon models ` +
                    `outside those assumptions.` + inactiveBoundContext() + floorContext(err, p.errFloor),
            };
        }
        case "quadcopter": {
            const peakKt = isFinite(p.peakSpeed) ? kt1(p.peakSpeed) : "?";
            const closeTxt = p.closest ? ` Its speed and climb are closest to a ${p.closest}.` : "";
            return {
                lead: `A quadcopter (multirotor drone) hovering and manoeuvring near the sensor — ` +
                    `about ${nm1(p.range)} NM out, peaking near ${peakKt} kt, ` +
                    `reproducing the sightlines to ${err.toFixed(2)}°.${closeTxt}`,
                derived: `Hover-capable multirotor kinematics (air-relative horizontal speed, wide turn-rate ` +
                    `budget, bounded climb/descent, and solved wind drift) are fit by differential evolution. ` +
                    `The ${err.toFixed(2)}° residual is an in-sample mismatch for this generic model, not a ` +
                    `drone-identification probability.`,
                constraint: screenContext("This bounded generic multirotor parameterization") +
                    ` Its fitted prior has a 20 km (${nm1(20000)} NM) range cap plus the displayed speed and ` +
                    `climb limits; this test does not exclude multirotor configurations outside those assumptions.` +
                    inactiveBoundContext() + floorContext(err, p.errFloor),
            };
        }
        case "groundVehicle": {
            const gvKt = kt1(m.airSpeed.mean);
            return {
                lead: `A vehicle moving on the surface: where each sightline meets the ground, the point tracks ` +
                    `at about ${gvKt} kt mean across ${rMin}–${rMax} NM, matching the angles to ${err.toFixed(2)}°.`,
                derived: `Each frame's sightline is intersected with a curved constant-elevation shell sampled ` +
                    `from the local terrain. Actual terrain is then sampled along the track to reject material ` +
                    `underground excursions; it is not a full slope-following terrain solve.`,
                constraint: (m.airSpeed.mean / KNOTS_TO_MS < 120)
                    ? `The implied ground speed (${gvKt} kt) is within reach of a real vehicle, so a surface ` +
                      `object is a consistent reading of these sightlines.`
                    : `The implied ground speed (${gvKt} kt) is far too fast for any ground vehicle — the apparent ` +
                      `motion needs altitude, so the object is not travelling along the surface.`,
            };
        }
        case "ground":
            return {
                lead: `A stationary light on the ground. The sightlines ${err < 0.2 ? "nearly" : "do not"} ` +
                    `converge on one ground point — residual ${err.toFixed(2)}°.`,
                derived: `The single surface point minimising the summed angular miss to every ray is found by ` +
                    `least squares pinned iteratively to a curved constant-elevation shell at the local ` +
                    `terrain height (sea level only where no terrain is loaded).`,
                constraint: err < 0.2
                    ? `A fixed ground point explains the angles to ${err.toFixed(2)}° — viable if the object were ` +
                      `a distant light and the platform's own motion produced the apparent movement.`
                    : `The ${err.toFixed(2)}° residual means no single ground point fits: the bearing changes too ` +
                      `much for a fixed surface light.`,
            };
        case "fixedPoint":
            return {
                lead: h.atInfinity
                    ? `A fixed point in the sky — a light so distant the sightlines stay parallel (like the Moon ` +
                      `or a star). One fixed direction fits the angles to ${err.toFixed(2)}°.`
                    : `A stationary object at a fixed location. The sightlines converge to ${err.toFixed(2)}°.`,
                derived: h.atInfinity
                    ? `The dominant eigenvector of Σ(dd·dᵀ) gives the single direction closest to every sightline; ` +
                      `its ${err.toFixed(2)}° residual is how nearly the rays are parallel.`
                    : `The nearest common stationary point to all rays is found in closed form; ${nm1(p.distance)} NM out.`,
                constraint: err < 0.1
                    ? `The rays are nearly ${h.atInfinity ? "parallel" : "convergent"} (${err.toFixed(2)}°), so a ` +
                      `${h.atInfinity ? "fixed sky direction (distant/astronomical light)" : "motionless object"} ` +
                      `is geometrically consistent.`
                    : `A ${err.toFixed(2)}° residual weakens the stationary interpretation.`,
            };
        case "astroNow":
        case "astroTime": {
            const vis = p.visible === false ? "too faint to see" : "bright enough to see";
            const magTxt = p.mag !== undefined ? `magnitude ${p.mag.toFixed(1)}` : "unknown brightness";
            return {
                lead: `The object would be ${p.object}${h.key === "astroTime" && p.timeUTC ?
                    " (only if the clip were on " + new Date(p.timeUTC).toDateString() + ")" : ""}: ` +
                    `${magTxt}, ${err.toFixed(2)}° off the sightlines, ${vis} at the ${p.fovDeg ? p.fovDeg.toFixed(p.fovDeg < 2 ? 2 : 1) : "?"}° sensor FOV.`,
                derived: `The ephemeris direction to ${p.object} is computed${h.key === "astroTime" ? " while sweeping the date to minimise the miss" : " at the clip's time"}` +
                    `, refraction applied if enabled, and compared to the mean sightline (${err.toFixed(2)}°). ` +
                    `Brightness is the body's apparent ${magTxt}, adjusted by a FOV boost (a narrow field sees fainter ` +
                    `objects): effective magnitude ${p.effMag !== undefined ? p.effMag.toFixed(1) : "?"} vs a ~6.0 limit.`,
                constraint: p.visible === false
                    ? `Even with the FOV boost, ${p.object} is fainter (eff. mag ${p.effMag !== undefined ? p.effMag.toFixed(1) : "?"}) ` +
                      `than the ~6.0 visibility limit — it could not appear in the video, so it is ruled out regardless of geometry.`
                    : `${p.object} is ${vis} and ${err < 0.5 ? "close to" : err.toFixed(1) + "° from"} the sightlines. ` +
                      `A body in the sky cannot track a sensor-relative sweep unless the apparent motion is the platform's own.`,
            };
        }
        case "saddle": {
            const famLo = nm1(p.familyLoM), famHi = nm1(p.familyHiM);
            // No genuine low-motion window (continuously rotating LOS): the
            // family comes from the full-clip slow-object cost valley and the
            // range is PINNED rather than ambiguous.
            if (p.saddleT0 === undefined) {
                return {
                    lead: `The slowest object consistent with the sightlines — ~${nm1(p.range)} NM out at `
                        + `${kt1(m.airSpeed.mean)} kt. The bearing rotates throughout the clip (no low-motion `
                        + `window), so the sensor's own motion actively triangulates the range.`,
                    derived: `The path shown is the <b>minimum-speed</b> object that rides the rays: range along `
                        + `each sightline is solved to minimize total motion, so it stays on them by construction `
                        + `(${m.gLoad.max.toFixed(2)} g max) and no speed larger than necessary is invented.`,
                    constraint: `The slow-object cost valley pins the range: only ${p.familyCount} of `
                        + `${p.familyTotal} grid ranges (${famLo}–${famHi} NM) fit comparably. Unlike the classic `
                        + `saddle case, this geometry leaves little range ambiguity.`,
                };
            }
            const winSpeed = isFinite(p.windowAirMean) ? kt1(p.windowAirMean) : kt1(m.airSpeed.mean);
            const winG = isFinite(p.windowGMax) ? p.windowGMax : m.gLoad.max;
            return {
                lead: `A slow or near-static object sitting where the sightlines move least — over `
                    + `${p.saddleT0.toFixed(1)}–${p.saddleT1.toFixed(1)} s the bearing barely changes, so most of `
                    + `the video's apparent motion is the sensor's own parallax. Here it sits ~${nm1(p.range)} NM out `
                    + `at ${winSpeed} kt during that saddle window.`,
                derived: `The LOS angular rate is tracked across the clip; it dips to ${p.minRateDegS.toFixed(2)}°/s `
                    + `in the saddle window versus a ${p.medRateDegS.toFixed(2)}°/s median. The path shown is then the `
                    + `<b>minimum-speed</b> object that rides the rays: range along each sightline is solved to minimize `
                    + `total motion, so it stays on them by construction (${winG.toFixed(2)} g max in the saddle window) `
                    + `and no speed larger than necessary is invented.`,
                constraint: `Because the bearing hardly moves at the saddle, the sightlines don't pin the range: `
                    + `this is a <b>family</b>, not a single answer — any range from ${famLo} to ${famHi} NM fits `
                    + `about as well. That degeneracy IS the saddle; an independent range cue is what would collapse it.`,
            };
        }
        case "satellite": {
            const sun = p.sunlit === false ? "in Earth's shadow (not sunlit)"
                : p.sunlit ? "sunlit" : "sunlit state unknown";
            return {
                lead: `A real LEO satellite — ${p.satellite} (NORAD ${p.satnum}), ~${p.altitudeKm} km up — `
                    + `whose pass sits ${err.toFixed(2)}° from the sightlines, and is ${sun}.`,
                derived: `The historical LEO catalogue for the sitch's date was loaded through the server `
                    + `(Space-Track, cached), and all ${p.loaded} objects were propagated with SGP4; ${p.satellite} `
                    + `is the closest match. The residual ${err.toFixed(2)}° is the mean angle between the `
                    + `observer→satellite direction and the sightlines. Sunlit is a cylindrical Earth-shadow test.`,
                constraint: p.sunlit === false
                    ? `It is in Earth's shadow during the clip, so it could not be the bright object on video — `
                      + `ruled out regardless of how well it lines up.`
                    : err < 0.5
                        ? `A ${err.toFixed(2)}° match from a catalogued, ${sun} satellite is a specific candidate `
                          + `worth checking against timestamp, catalogue, pointing, and visibility uncertainty; `
                          + `this angular match alone is not an identification.`
                        : `The closest catalogued satellite is still ${err.toFixed(2)}° off, so no LEO object cleanly `
                          + `explains these sightlines.`,
            };
        }
        default:
            return {lead: h.notes || "", derived: "", constraint: ""};
    }
}

function solutionSpaceHTML(h, ss) {
    // Ray-following methods carry a small honest smoothing residual now, so
    // classify them by key, not by errDeg === 0.
    const onRay = (h.errDeg || 0) < 1e-3
        || h.key === "constAir" || h.key === "constAlt" || h.key === "plausible";
    const conv = ss.conv, geo = ss.geo;
    const cTxt = conv && isFinite(conv.contrast) ? conv.contrast.toFixed(2) : "—";
    const bandTxt = conv ? `${conv.loNM.toFixed(0)}–${conv.hiNM.toFixed(0)} NM` : "the searched band";
    if (h.key === "saddle") {
        const p = h.params || {};
        const famLo = nm1(p.familyLoM), famHi = nm1(p.familyHiM);
        if (p.saddleT0 === undefined) {
            return `Unusually for a slow-object reading, this one is <b>pinned</b>: the bearing rotates all `
                + `clip long (no low-motion window), so the sensor's own motion triangulates the range — the `
                + `slow-object cost valley narrows to <b>${famLo}–${famHi} NM</b> (${p.familyCount} of `
                + `${p.familyTotal} sampled ranges). The track shown is the minimum-speed member of that band.`;
        }
        return `This IS the family — not a point. Over the low-motion window the slow-object cost curve stays `
            + `in its low-cost valley across <b>${famLo}–${famHi} NM</b> (${p.familyCount} of ${p.familyTotal} `
            + `sampled ranges), so every range in that band is about equally plausible for a slow object; the track `
            + `shown is just its least-maneuvering member. It's the geometric price of a sensor orbiting something `
            + `that barely moves — the sightlines can say "slow object, somewhere in here", not "here". Pin the range `
            + `with the Min/Max Dist inputs or an outside cue to collapse it.`;
    } else if (onRay && ss.narrow && h.key === "plausible"
        && h.params && h.params.usedSpeedTarget === false) {
        // Narrow baseline BUT the pure smoothness-vs-range profile was still
        // decisive (close ranges demand catastrophic maneuvering): a band-level
        // preference, not a triangulated fix — say so without invoking the
        // speed target, which was not used.
        return `Geometrically the sightlines sweep only <b>${geo.azSweep.toFixed(1)}°</b> of azimuth over a ` +
            `<b>${geo.baselineNM.toFixed(1)} NM</b> sensor baseline, which provides limited direct range leverage. ` +
            `The prior-free smoothness profile still ruled out the rest under this motion model — nearer ranges ` +
            `demand far more maneuvering — and preferred <b>${nm1(h.params.range)} NM</b> within the surviving ` +
            `band, with no speed assumption. Treat it as the least-maneuvering pocket of a broad family, not a ` +
            `triangulated fix.`;
    } else if (onRay && ss.narrow) {
        // Narrow angular baseline: range is NOT observable from geometry alone.
        // Whatever minimum exists is created by the soft speed/altitude prior.
        return `Geometrically the sightlines sweep only <b>${geo.azSweep.toFixed(1)}°</b> of azimuth over a ` +
            `<b>${geo.baselineNM.toFixed(1)} NM</b> sensor baseline, which provides limited direct range leverage; ` +
            `many ranges ride the rays about equally well. ` +
            (conv && isFinite(conv.contrast) && conv.contrast >= 1.4
                ? `The soft speed target breaks that tie: the maneuvering-vs-range curve dips near ` +
                  `<b>${conv.bestRangeNM.toFixed(1)} NM</b> (contrast ${cTxt}× across ${bandTxt}). Read that as the ` +
                  `most plausible range <i>given</i> the assumed speed, not a purely geometric fix — change the ` +
                  `target speed and the range moves with it.`
                : `The curve is nearly flat (contrast ${cTxt}×), so this is <b>one of many</b> solutions along the ` +
                  `sightline; the speed/altitude target is what pins this particular range. Treat it as an ` +
                  `assumption to test, not a measurement.`);
    } else if (onRay && conv && isFinite(conv.contrast) && conv.contrast >= 1.4) {
        return `The smoothness-vs-range score has a clear minimum near ` +
            `<b>${conv.bestRangeNM.toFixed(1)} NM</b> (contrast ${cTxt}× across ${bandTxt}) under the current ` +
            `motion and speed assumptions. This is a model-conditioned preference, not a triangulated range ` +
            `or an uncertainty interval; changing the assumptions is the required sensitivity test.`;
    } else if (onRay) {
        return `Even over a <b>${geo.azSweep.toFixed(1)}°</b> baseline the maneuvering-vs-range curve stays ` +
            `flat (contrast ${cTxt}×), so a wide family of ranges fits about equally — this is <b>one of many</b> ` +
            `on-ray solutions, selected here by the speed/altitude target.`;
    } else if (h.key === "aircraft" || h.key === "lantern" || h.key === "quadcopter") {
        const other = h.key === "aircraft" ? "lantern/balloon and drone"
            : h.key === "lantern" ? "aircraft and drone" : "aircraft and lantern/balloon";
        return `Unlike the on-ray traverses, this forward model leaves a real training residual ` +
            `(<b>${(h.errDeg || 0).toFixed(3)}°</b>). The ${other} models use different parameter counts, wind ` +
            `freedom, bounds, and priors, so their raw residuals are diagnostic values—not like-for-like object-type ` +
            `probabilities.`;
    } else if (h.params && h.params.object) {
        return `This is a <b>catalogue alignment check</b>, not a range fit or standalone identification: the ` +
            `named body must line up with the sightlines and be bright enough. It's checked against other bright bodies for the ` +
            `best match, and against the ~6.0 magnitude visibility limit (FOV-adjusted).`;
    } else if (h.params && h.params.satellite) {
        return `This is a catalogue <b>candidate match</b>: the closest of <b>${h.params.loaded}</b> ` +
            `LEO satellites propagated for the date. There isn't a continuous trajectory family here, only the best ` +
            `catalogue match and how far off it is (${(h.errDeg || 0).toFixed(2)}°). A clean, ` +
            `sunlit sub-degree match merits follow-up against timing/catalogue uncertainty; a large residual means no known satellite fits.`;
    } else if (h.key === "straightLine" || String(h.key || "").startsWith("gf")) {
        // The Global Fit family (constant velocity/acceleration, Kalman smoother,
        // Monte Carlo, Polynomial LSQ) and the straight line are curve fits to the
        // rays, NOT object-type tests — do not let them fall through to the
        // stationary-object prose below.
        const isSwept = /order/i.test(String(h.key || "")) || /Monte Carlo|Polynomial/i.test(String(h.name || ""));
        return `This is a <b>geometric curve fit</b> to the sightlines (residual ` +
            `<b>${(h.errDeg || 0).toFixed(3)}°</b>), shown for comparison and exact application — it does not test a ` +
            `specific object type or infer a range from physics. ` +
            (isSwept
                ? `A lower residual higher in a polynomial-order sweep is largely arithmetic — a more flexible curve ` +
                  `hugs the rays more closely regardless of the object — so read the sweep as a diagnostic of how much ` +
                  `curvature the sightlines admit, not as evidence for one interpretation.`
                : `Read it as a smooth baseline the physical and LOS-constrained candidates can be compared against.`);
    }
    return `No method-specific solution-space explanation is available for this candidate (residual ` +
        `<b>${(h.errDeg || 0).toFixed(2)}°</b>).`;
}

// Magnifier button placed on every interactive 3D chart shell: toggles the
// chart's "zoom to tracks" view (extents of the traverse + truth tracks only,
// sightlines clipped into the volume). Hidden when the scene has no zoomable
// tracks (a direction-only hypothesis with no truth track).
const ZOOM_TITLE_OFF = "Zoom to the truth and traverse tracks";
const ZOOM_TITLE_ON = "Show the full volume (sensor path and full sightlines)";
const ZOOM_BUTTON_HTML =
    `<button class="tg-chart-zoom" type="button" title="${ZOOM_TITLE_OFF}" ` +
    `aria-label="${ZOOM_TITLE_OFF}" aria-pressed="false">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ` +
    `stroke-linecap="round" aria-hidden="true">` +
    `<circle cx="10.5" cy="10.5" r="6.6"/><path d="M15.4 15.4 21 21"/></svg></button>`;

// Full Details-pane HTML for one selected hypothesis: big plan view, headline
// stats, a plain-English verdict, then progressively deeper explanation
// (how the numbers were derived, what constrains it, where it sits in the
// solution space) — written for a UAP analyst deciding what the object is.
// The balloon plausibility bridge: a balloon fit's INFERRED wind profile (the
// wind its solved drift requires at each altitude) next to the loaded MEASURED
// wind at the same altitudes. A plausible balloon should need winds close to
// what was actually measured nearby; big disagreement weakens the balloon
// reading — though measured winds are themselves only loosely representative
// (a sonde can be 200+ mi and up to 12 h away).
function windProfileComparisonHTML(h) {
    const p = h.params || {};
    if (!Number.isFinite(p.windE) || !Number.isFinite(p.windN) || !h.track) return "";
    const t = h.track;
    const h0 = t[2] + (t[0] * t[0] + t[1] * t[1]) / (2 * EARTH_RADIUS_M);
    const shear = Number.isFinite(p.shearPerM) ? p.shearPerM : 0;
    const inferredAt = (altM) => {
        let m = 1 + shear * (altM - h0);
        if (m < 0.25) m = 0.25; else if (m > 3) m = 3;
        return {u: p.windE * m, v: p.windN * m};
    };
    const wf = NodeMan.get("windField", false);
    const canMeasure = wf && wf.source && wf.source !== "manual"
        && typeof wf.sampleWindAtAltitude === "function";
    const fmt = (s) => {
        if (!s || !Number.isFinite(s.u) || !Number.isFinite(s.v)) return "—";
        const kt = Math.hypot(s.u, s.v) * 1.94384;
        const dir = ((Math.atan2(s.u, s.v) * 180 / Math.PI + 180) % 360 + 360) % 360;
        return `${kt.toFixed(0)} kt @ ${dir.toFixed(0)}°`;
    };
    const alt = h.metricsFull && h.metricsFull.altitude;
    const loM = alt && Number.isFinite(alt.min) ? alt.min : h0;
    const hiM = alt && Number.isFinite(alt.max) ? alt.max : h0 + 3000;
    const rows = [];
    for (let i = 0; i <= 6; i++) {
        const altM = loM + (hiM - loM) * i / 6;
        const meas = canMeasure ? wf.sampleWindAtAltitude(Sit.lat, Sit.lon, altM) : null;
        rows.push(`<tr><td>${(altM / 304.8).toFixed(1)}</td><td>${fmt(inferredAt(altM))}</td>`
            + `<td>${fmt(meas)}</td></tr>`);
    }
    return `<h4 class="tg-d-h">Inferred wind profile${canMeasure ? " vs measured" : ""}</h4>`
        + `<table class="tg-wind"><thead><tr><th>Alt (kft)</th><th>Inferred (fit)</th>`
        + `<th>Measured</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        + `<p class="tg-d-p" style="font-size:12px;margin-top:6px">`
        + (canMeasure
            ? "A plausible balloon should need winds close to those measured nearby; large "
            + "disagreement weakens the balloon interpretation. Measured winds are themselves only "
            + "loosely representative (a sonde can be 200+ mi and 12 h away)."
            : "The wind this free fit inferred. Load a sounding/GFS wind field to compare it against "
            + "measured winds aloft.")
        + "</p>";
}

function buildDetailHTML(h, r, groupIndex, groupSize, category, ctx, tied = false) {
    const {ss} = ctx;
    const stats = hypothesisStats(h);
    const statsHTML = stats.map(([k, v]) =>
        `<div class="tg-d-st"><div class="tg-d-stk">${escapeHtml(k)}</div>` +
        `<div class="tg-d-stv">${escapeHtml(v)}</div></div>`).join("");

    const prose = detailProse(h, r, ss);
    const spaceHTML = solutionSpaceHTML(h, ss);
    const badges = [tierBadge(r), ...completenessBadges(r)];
    const badgesHTML = badges.map((badge) =>
        `<span class="tg-badge" style="background:${badge.color}">${escapeHtml(badge.label)}</span>`).join("");
    const tieText = tied ? " · within the 0.05 display-score tie threshold" : "";

    // per-frame diagnostics: g-force, speed, LOS error over the clip
    const sc = hypothesisSeriesCharts(ctx.dataset, h);
    const seriesHTML = sc ? `
        <h4 class="tg-d-h">Frame-by-frame behaviour</h4>
        <div class="tg-d-series">
            <img src="${sc.gURL}" alt="Kinematic acceleration over the clip, expressed in g">
            <img src="${sc.spdURL}" alt="Speed over the clip">
            <img src="${sc.errURL}" alt="LOS fit error over the clip">
        </div>` : "";

    return `
        <div class="tg-chart-shell tg-d-chart-shell">
            <canvas class="tg-d-chart tg-chart-3d" data-chart-role="detail" role="img"
                title="Drag to rotate"
                aria-label="3D volume view of the ${escapeHtml(h.name)} interpretation"></canvas>
            <button class="tg-chart-fullscreen" type="button" title="Fullscreen graph"
                aria-label="Fullscreen graph">⛶</button>
            ${ZOOM_BUTTON_HTML}
        </div>
        <div class="tg-d-head">
            <span class="tg-d-name">${escapeHtml(h.name)}</span>
            <span class="tg-badges">${badgesHTML}</span>
        </div>
        <div class="tg-d-sub">${escapeHtml(h.subtitle || "")}</div>
        <div class="tg-d-order">#${groupIndex + 1} of ${groupSize} within ${escapeHtml(category.shortLabel)}${escapeHtml(tieText)}</div>
        <div class="tg-d-metrics">${statsHTML}</div>
        <div class="tg-d-rank"><strong>Why it is screened and ordered here:</strong> ${escapeHtml(rankingExplanation(h, r))}</div>
        <p class="tg-d-lead">${escapeHtml(prose.lead)}</p>
        ${seriesHTML}
        ${h.key === "lantern" ? windProfileComparisonHTML(h) : ""}
        <h4 class="tg-d-h">How these numbers were derived</h4>
        <p class="tg-d-p">${prose.derived}</p>
        <h4 class="tg-d-h">What constrains it — and its plausibility</h4>
        <p class="tg-d-p">${prose.constraint}</p>
        <h4 class="tg-d-h">Where it sits in the solution space</h4>
        <p class="tg-d-p">${spaceHTML}</p>`;
}

/**
 * Build and show the full-screen interactive result gallery for a completed
 * analysis. Removable via the X, the Close button, Escape, or a click on the
 * dark backdrop. Does not leak listeners.
 */
function showResultGallery(results) {
    const {dataset, hypotheses} = results;

    // One flat, best-first ordering. Each tile carries its category as a
    // coloured corner label rather than sitting under a section heading, so the
    // strongest candidate leads regardless of which question it answers — a
    // physically-based "looks like a balloon" result is what an analyst is
    // after, and section order used to bury it. The categories still cannot be
    // compared by a calibrated cross-model likelihood; see the comparator in
    // rankAllHypotheses for exactly which keys are and are not commensurable.
    const tiles = rankAllHypotheses(hypotheses);

    const overlay = document.createElement("div");
    overlay.className = "traverse-gallery-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;" +
        "align-items:flex-start;justify-content:center;padding:24px 16px;box-sizing:border-box;" +
        "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;";

    const chartGroup = new Chart3DGroup({syncScale: true});
    const pendingTileCharts = [];
    const tileCharts = [];
    const liveCharts = new Set();
    const chartByCanvas = new Map();
    let detailChart = null;
    let resizeObserver = null;
    let selected = -1;
    let fullscreenView = null;
    // Shared "zoom to tracks" state: the magnifier toggles ALL graphs together
    // (each to its own zoomBounds), like Sync Orientation / Sync Scale. New
    // charts (detail/tile/fullscreen) adopt it on creation.
    let groupZoomed = false;

    const currentChart = () => detailChart || (selected >= 0 ? tileCharts[selected] : null);

    function registerChart(chart) {
        liveCharts.add(chart);
        chartByCanvas.set(chart.canvas, chart);
        if (resizeObserver) resizeObserver.observe(chart.canvas);
        return chart;
    }

    function disposeChart(chart) {
        if (!chart) return;
        if (resizeObserver) resizeObserver.unobserve(chart.canvas);
        chartByCanvas.delete(chart.canvas);
        liveCharts.delete(chart);
        chart.dispose();
    }

    // Reflect a chart's zoom state onto the magnifier button in its shell,
    // hiding the button entirely when the scene has nothing to zoom to.
    function syncZoomButton(chart) {
        const shell = chart.canvas.closest(".tg-chart-shell, .tg-chart-fullscreen-shell");
        const btn = shell ? shell.querySelector(".tg-chart-zoom") : null;
        if (!btn) return;
        if (!chart.scene.zoomBounds) { btn.style.display = "none"; return; }
        btn.classList.toggle("on", chart.zoomed);
        btn.title = chart.zoomed ? ZOOM_TITLE_ON : ZOOM_TITLE_OFF;
        btn.setAttribute("aria-label", btn.title);
        btn.setAttribute("aria-pressed", chart.zoomed ? "true" : "false");
    }

    function disposeDetailChart() {
        if (!detailChart) return;
        disposeChart(detailChart);
        detailChart = null;
    }

    function closeChartFullscreen() {
        if (!fullscreenView) return;
        const {layer, chart, sourceChart} = fullscreenView;
        fullscreenView = null;
        if (sourceChart && liveCharts.has(sourceChart)) {
            if (!chartGroup.syncOrientation) {
                sourceChart.localMatrix = chart.localMatrix.slice();
                sourceChart.draw();
            }
            // zoom is per-chart display state — carry it back like orientation
            if (sourceChart.zoomed !== chart.zoomed) {
                sourceChart.setZoom(chart.zoomed);
                syncZoomButton(sourceChart);
            }
        }
        disposeChart(chart);
        if (layer.parentNode) layer.parentNode.removeChild(layer);
    }

    function disposeAllCharts() {
        closeChartFullscreen();
        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = null;
        for (const chart of Array.from(liveCharts)) chart.dispose();
        liveCharts.clear();
        chartByCanvas.clear();
        detailChart = null;
        tileCharts.length = 0;
    }

    function onResize() {
        for (const chart of liveCharts) chart.resize();
    }

    // removal wiring (defined before the DOM so every handler can close cleanly)
    let removed = false;
    // Capture-phase keydown: the gallery is modal, so swallow ALL keys before
    // Sitrec's global document.onkeydown handler sees them (else bare keys step
    // frames / move the camera and Cmd+N would start a new sitch behind the
    // overlay). Escape closes.
    // SELF-HEALING: if the overlay is ever detached without remove() being
    // called (a stray removeChild, a sitch reload, an exception), a leaked
    // capture listener would swallow every keystroke forever and kill the
    // keyboard. So the first thing onKey does is verify the overlay is still in
    // the DOM; if not, it unhooks itself and lets the key through normally.
    const onKey = (e) => {
        if (!overlay.isConnected) { document.removeEventListener("keydown", onKey, true); return; }
        e.stopImmediatePropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            if (fullscreenView) closeChartFullscreen();
            else remove();
        }
    };
    const remove = () => {
        if (removed) return;
        removed = true;
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", onResize);
        disposeAllCharts();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    document.addEventListener("keydown", onKey, true);

    // Dedicated backdrop element BEHIND the scrolling panel: clicking the dark
    // area closes, but the panel (which owns the scrollbar) is on top, so
    // grabbing the scrollbar never closes the gallery.
    const backdrop = document.createElement("div");
    backdrop.className = "tg-backdrop";
    backdrop.addEventListener("click", remove);
    overlay.appendChild(backdrop);

    const style = document.createElement("style");
    style.textContent = `
        .traverse-gallery-overlay .tg-backdrop { position:absolute; inset:0; background:rgba(0,0,0,0.93); }
        .traverse-gallery-overlay .tg-panel { position:relative; z-index:1; width:96vw; max-width:1720px;
            height:100%; display:flex; flex-direction:column; padding:20px 22px 16px 22px; box-sizing:border-box; }
        .traverse-gallery-overlay .tg-titlerow { display:flex; align-items:center; justify-content:space-between;
            gap:16px; flex:0 0 auto; }
        .traverse-gallery-overlay .tg-title { color:#e8eaed; font-size:21px; font-weight:700; }
        .traverse-gallery-overlay .tg-x { background:none; border:none; color:#b9bfc7; font-size:26px;
            line-height:1; cursor:pointer; padding:2px 9px; border-radius:6px; }
        .traverse-gallery-overlay .tg-x:hover { color:#fff; background:rgba(255,255,255,0.08); }
        .traverse-gallery-overlay .tg-explain { color:#8a9099; font-size:13px; margin:6px 0 14px 0; max-width:100ch;
            flex:0 0 auto; }
        .traverse-gallery-overlay .tg-toolbar { flex:0 0 auto; display:flex; gap:10px; align-items:center;
            margin:0 0 14px 0; flex-wrap:wrap; }
        .traverse-gallery-overlay .tg-toggle { padding:7px 12px; border-radius:8px;
            border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.05);
            color:#cfd5dd; font-size:13px; font-weight:700; cursor:pointer; }
        .traverse-gallery-overlay .tg-toggle:hover { border-color:rgba(120,170,240,0.55); color:#fff; }
        .traverse-gallery-overlay .tg-toggle.on { background:rgba(57,135,229,0.24);
            border-color:#3987e5; color:#eef6ff; }
        .traverse-gallery-overlay .tg-body { flex:1 1 auto; min-height:0; display:flex; gap:18px; }
        .traverse-gallery-overlay .tg-tiles { flex:2 1 0; min-width:0; overflow-y:auto; padding-right:4px; }
        .traverse-gallery-overlay .tg-details { flex:1 1 0; min-width:360px; overflow-y:auto;
            background:#101216; border:1px solid rgba(255,255,255,0.09); border-radius:12px;
            display:flex; flex-direction:column; }
        .traverse-gallery-overlay .tg-grid { display:grid;
            grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; }
        /* Category label, upper-left of each tile. Colour-coded so the kind of
           question a tile answers is readable at a glance in a flat list.
           Right-padded to clear the set-aside X, which is upper-RIGHT. */
        .traverse-gallery-overlay .tg-cat { font-size:11px; font-weight:700;
            letter-spacing:0.06em; text-transform:uppercase; margin:0 34px 7px 1px;
            line-height:1.2; }
        .traverse-gallery-overlay .tg-tile { position:relative; background:#14161a;
            border:1px solid rgba(255,255,255,0.09);
            border-radius:12px; padding:12px; display:flex; flex-direction:column; cursor:pointer;
            transition:border-color .12s, box-shadow .12s; }
        .traverse-gallery-overlay .tg-tile:hover { border-color:rgba(120,170,240,0.5); }
        /* Dismiss ("X") — top-LEFT, mirroring the fullscreen/zoom buttons on the
           right so the two corners read as separate concerns. */
        /* Positioned against the CHART SHELL, not the tile: the category label
           now occupies the tile's top-left corner. */
        .traverse-gallery-overlay .tg-tile-dismiss { position:absolute; top:8px; left:8px; z-index:4;
            width:30px; height:30px; display:grid; place-items:center; padding:0; border-radius:7px;
            border:1px solid rgba(255,255,255,0.28); background:rgba(7,10,14,0.72);
            color:#e8eaed; font-size:16px; line-height:1; cursor:pointer; }
        .traverse-gallery-overlay .tg-tile-dismiss:hover { background:rgba(224,86,78,0.9);
            border-color:#ef8b84; color:#fff; }
        /* In the set-aside area the button restores rather than removes, so it
           must not hover destructive-red. */
        .traverse-gallery-overlay .tg-tile-dismiss.restore { font-size:17px; }
        .traverse-gallery-overlay .tg-tile-dismiss.restore:hover { background:rgba(57,135,229,0.88);
            border-color:#7fb0ee; color:#fff; }
        /* A set-aside tile stays fully readable — it is excluded from
           consideration, not hidden, so a reader can still see what was put
           aside and why. */
        .traverse-gallery-overlay .tg-tile.dismissed { opacity:0.55;
            border-style:dashed; border-color:rgba(255,255,255,0.16); }
        .traverse-gallery-overlay .tg-tile.dismissed:hover { opacity:0.8; }
        .traverse-gallery-overlay .tg-sep { grid-column:1 / -1; margin:18px 0 2px;
            border-top:1px dashed rgba(255,255,255,0.22); padding-top:10px; }
        .traverse-gallery-overlay .tg-sep-title { color:#c9cfd7; font-weight:700; font-size:13px; }
        .traverse-gallery-overlay .tg-sep-desc { color:#8a9099; font-size:11.5px; margin-top:2px; }
        .traverse-gallery-overlay .tg-tile.selected { border-color:#3987e5;
            box-shadow:0 0 0 2px rgba(57,135,229,0.45); }
        .traverse-gallery-overlay .tg-chart-shell { position:relative; width:100%; min-width:0; }
        .traverse-gallery-overlay .tg-thumb-shell { height:240px; }
        .traverse-gallery-overlay .tg-d-chart-shell { height:420px; }
        .traverse-gallery-overlay .tg-thumb { width:100%; height:100%; display:block; border-radius:7px;
            border:1px solid rgba(255,255,255,0.06); background:#0c0e11; }
        .traverse-gallery-overlay .tg-chart-fullscreen,
        .traverse-gallery-overlay .tg-chart-zoom { position:absolute; top:8px; right:8px; z-index:3;
            width:30px; height:30px; display:grid; place-items:center; padding:0; border-radius:7px;
            border:1px solid rgba(255,255,255,0.28); background:rgba(7,10,14,0.72);
            color:#e8eaed; font-size:17px; line-height:1; cursor:pointer; }
        .traverse-gallery-overlay .tg-chart-fullscreen:hover,
        .traverse-gallery-overlay .tg-chart-zoom:hover { background:rgba(57,135,229,0.88);
            border-color:#7fb0ee; color:#fff; }
        .traverse-gallery-overlay .tg-chart-zoom { top:44px; }
        .traverse-gallery-overlay .tg-chart-zoom svg { width:15px; height:15px; }
        .traverse-gallery-overlay .tg-chart-zoom.on { background:rgba(57,135,229,0.55);
            border-color:#7fb0ee; color:#fff; }
        .traverse-gallery-overlay .tg-tile-h { display:flex; align-items:center; justify-content:space-between;
            gap:8px; margin-top:10px; }
        .traverse-gallery-overlay .tg-name { font-weight:700; color:#e8eaed; font-size:15px; }
        .traverse-gallery-overlay .tg-badge { display:inline-block; padding:2px 10px; border-radius:999px;
            font-size:11px; font-weight:700; color:#0d0f12; white-space:nowrap; }
        .traverse-gallery-overlay .tg-badges { display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end; }
        .traverse-gallery-overlay .tg-sub { color:#8a9099; font-size:12px; margin:3px 0 9px 0; }
        .traverse-gallery-overlay .tg-order { color:#7fb0ee; font-size:11px; margin:-4px 0 8px; }
        .traverse-gallery-overlay .tg-rank-basis { color:#b8c0ca; font-size:11.5px; line-height:1.45;
            margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.07); }
        .traverse-gallery-overlay .tg-stats { display:grid; grid-template-columns:1fr 1fr; gap:6px 14px; }
        .traverse-gallery-overlay .tg-st { display:flex; flex-direction:column; }
        .traverse-gallery-overlay .tg-stk { font-size:10px; color:#8a9099; text-transform:uppercase;
            letter-spacing:0.04em; }
        .traverse-gallery-overlay .tg-stv { font-size:12.5px; color:#e8eaed; font-variant-numeric:tabular-nums;
            margin-top:1px; }
        .traverse-gallery-overlay .tg-empty { color:#b9bfc7; font-size:14px; padding:26px 0; }
        /* details pane */
        .traverse-gallery-overlay .tg-d-actions { flex:0 0 auto; padding:13px 15px;
            border-bottom:1px solid rgba(255,255,255,0.08); display:flex; gap:10px; align-items:center;
            position:sticky; top:0; background:#101216; z-index:2; }
        .traverse-gallery-overlay .tg-use { flex:1 1 auto; padding:10px 12px; font-size:14px; font-weight:700;
            color:#fff; background:#3987e5; border:none; border-radius:8px; cursor:pointer; }
        .traverse-gallery-overlay .tg-use:hover { background:#4f97ec; }
        .traverse-gallery-overlay .tg-use:disabled { background:#2a2f37; color:#8a9099;
            cursor:default; font-weight:600; }
        .traverse-gallery-overlay .tg-d-content { padding:15px 16px 20px 16px; }
        .traverse-gallery-overlay .tg-d-chart { width:100%; height:100%; display:block; border-radius:8px;
            border:1px solid rgba(255,255,255,0.07); background:#0c0e11; }
        .traverse-gallery-overlay .tg-d-head { display:flex; align-items:center; justify-content:space-between;
            gap:10px; margin-top:13px; }
        .traverse-gallery-overlay .tg-d-name { font-weight:700; color:#f2f4f7; font-size:17px; }
        .traverse-gallery-overlay .tg-d-sub { color:#8a9099; font-size:12.5px; margin-top:3px; }
        .traverse-gallery-overlay .tg-d-order { color:#7fb0ee; font-size:12px; margin-top:4px; }
        .traverse-gallery-overlay .tg-d-rank { color:#d8dde4; font-size:13px; line-height:1.55;
            margin:12px 0 4px; padding:10px 11px; background:#171b20; border-left:3px solid #7fb0ee;
            border-radius:5px; }
        .traverse-gallery-overlay .tg-d-metrics { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px 12px;
            margin:13px 0 4px 0; padding:11px; background:#15181d; border-radius:8px; }
        .traverse-gallery-overlay .tg-d-st { display:flex; flex-direction:column; }
        .traverse-gallery-overlay .tg-d-stk { font-size:9.5px; color:#8a9099; text-transform:uppercase;
            letter-spacing:0.04em; }
        .traverse-gallery-overlay .tg-d-stv { font-size:13px; color:#e8eaed; font-variant-numeric:tabular-nums;
            margin-top:1px; }
        .traverse-gallery-overlay .tg-d-lead { color:#dfe3e8; font-size:14.5px; line-height:1.5; margin:14px 0 4px 0; }
        .traverse-gallery-overlay .tg-d-h { color:#7fb0ee; font-size:11.5px; font-weight:700; text-transform:uppercase;
            letter-spacing:0.05em; margin:18px 0 5px 0; }
        .traverse-gallery-overlay .tg-d-p { color:#c2c8d0; font-size:13px; line-height:1.62; margin:0; }
        .traverse-gallery-overlay .tg-d-series img { display:block; width:100%; height:auto;
            border-radius:6px; border:1px solid #262b33; margin:0 0 8px 0; }
        .traverse-gallery-overlay .tg-d-p b { color:#eef1f5; }
        .traverse-gallery-overlay .tg-wind { width:100%; border-collapse:collapse; font-size:12.5px;
            font-variant-numeric:tabular-nums; margin:4px 0; }
        .traverse-gallery-overlay .tg-wind th, .traverse-gallery-overlay .tg-wind td {
            padding:3px 8px; text-align:right; border-bottom:1px solid rgba(255,255,255,0.08); }
        .traverse-gallery-overlay .tg-wind th { color:#8a9099; font-weight:600; }
        .traverse-gallery-overlay .tg-wind td:first-child, .traverse-gallery-overlay .tg-wind th:first-child { text-align:left; }
        .traverse-gallery-overlay .tg-wind td { color:#dfe3e8; }
        .traverse-gallery-overlay .tg-footer { flex:0 0 auto; display:flex; justify-content:flex-end; gap:12px;
            margin-top:12px; flex-wrap:wrap; }
        .traverse-gallery-overlay .tg-btn { padding:9px 18px; font-size:14px; font-weight:600; cursor:pointer;
            border-radius:8px; border:1px solid rgba(255,255,255,0.16); }
        .traverse-gallery-overlay .tg-btn-primary { background:#3987e5; color:#fff; border-color:#3987e5; }
        .traverse-gallery-overlay .tg-btn-ghost { background:rgba(255,255,255,0.06); color:#e8eaed; }
        .traverse-gallery-overlay .tg-chart-fullscreen-layer { position:fixed; inset:0; z-index:10002;
            background:#05070a; padding:0; box-sizing:border-box; display:flex; }
        .traverse-gallery-overlay .tg-chart-fullscreen-shell { position:relative; flex:1 1 auto; min-width:0; min-height:0; }
        .traverse-gallery-overlay .tg-chart-fullscreen-canvas { width:100vw; height:100vh; display:block;
            background:#0c0e11; }
        .traverse-gallery-overlay .tg-chart-fullscreen-layer .tg-chart-fullscreen {
            top:14px; right:14px; width:40px; height:40px; font-size:23px; background:rgba(7,10,14,0.82);
        }
        .traverse-gallery-overlay .tg-chart-fullscreen-layer .tg-chart-zoom {
            top:62px; right:14px; width:40px; height:40px; background:rgba(7,10,14,0.82);
        }
        .traverse-gallery-overlay .tg-chart-fullscreen-layer .tg-chart-zoom svg { width:20px; height:20px; }
    `;
    overlay.appendChild(style);

    function openChartFullscreen(sourceChart) {
        if (!sourceChart) return;
        closeChartFullscreen();
        const layer = document.createElement("div");
        layer.className = "tg-chart-fullscreen-layer";
        layer.innerHTML =
            `<div class="tg-chart-fullscreen-shell">` +
                `<canvas class="tg-chart-fullscreen-canvas tg-chart-3d" data-chart-role="fullscreen" role="img" ` +
                `title="Drag to rotate" aria-label="Fullscreen 3D volume graph"></canvas>` +
                `<button class="tg-chart-fullscreen" type="button" title="Exit fullscreen graph" ` +
                `aria-label="Exit fullscreen graph">⛶</button>` +
                ZOOM_BUTTON_HTML +
            `</div>`;
        overlay.appendChild(layer);
        const canvas = layer.querySelector("canvas");
        const chart = registerChart(new Chart3D(canvas, sourceChart.scene, chartGroup,
            {pad: sourceChart.pad ?? 0.1, scaleBoost: sourceChart.scaleBoost}));
        chart.localMatrix = sourceChart.localMatrix.slice();
        if (groupZoomed && chart.scene.zoomBounds) chart.setZoom(true);
        syncZoomButton(chart);
        fullscreenView = {layer, chart, sourceChart};
        requestAnimationFrame(() => chart.resize());
    }

    overlay.addEventListener("click", (e) => {
        const btn = e.target.closest(".tg-chart-fullscreen");
        if (!btn || !overlay.contains(btn)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (fullscreenView && btn.closest(".tg-chart-fullscreen-layer")) {
            closeChartFullscreen();
            return;
        }
        const shell = btn.closest(".tg-chart-shell");
        const canvas = shell ? shell.querySelector("canvas.tg-chart-3d") : null;
        openChartFullscreen(canvas ? chartByCanvas.get(canvas) : null);
    }, true);

    // Magnifier: toggle the chart's "zoom to tracks" view. Capture-phase (like
    // the fullscreen delegate) so the click never falls through to the tile's
    // select handler.
    overlay.addEventListener("click", (e) => {
        const btn = e.target.closest(".tg-chart-zoom");
        if (!btn || !overlay.contains(btn)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const shell = btn.closest(".tg-chart-shell, .tg-chart-fullscreen-shell");
        const canvas = shell ? shell.querySelector("canvas.tg-chart-3d") : null;
        const chart = canvas ? chartByCanvas.get(canvas) : null;
        if (!chart || !chart.scene.zoomBounds) return;
        // Toggle EVERY graph together (each to its own zoomBounds), so the
        // magnifier is a single "show tracks / show full volume" for the set.
        groupZoomed = !chart.zoomed;
        for (const c of liveCharts) {
            if (c.scene.zoomBounds) c.setZoom(groupZoomed);
            syncZoomButton(c);
        }
    }, true);

    const panel = document.createElement("div");
    panel.className = "tg-panel";
    overlay.appendChild(panel);

    // title row + close X
    const titleRow = document.createElement("div");
    titleRow.className = "tg-titlerow";
    const title = document.createElement("div");
    title.className = "tg-title";
    title.textContent = `Traverse Analysis — ${Sit.name ?? "unnamed sitch"}`;
    const xBtn = document.createElement("button");
    xBtn.className = "tg-x";
    xBtn.textContent = "×";
    xBtn.title = "Close";
    xBtn.addEventListener("click", remove);
    titleRow.appendChild(title);
    titleRow.appendChild(xBtn);
    panel.appendChild(titleRow);

    // one-line explainer
    const explain = document.createElement("div");
    explain.className = "tg-explain";
    explain.textContent = "Candidates are shown in one flat, best-first screening order, each labelled with the " +
        "question it answers (physically based, LOS constrained, geometric, geometric approximation, known object). " +
        "This is a screening order, not a calibrated 'most likely object' probability: it is decided by keys that ARE " +
        "comparable across categories — screen pass, completeness, broad-screen tier — before any within-category " +
        "score that is not, with category priority only breaking otherwise-equal ties. Each tile also shows its rank " +
        "within its own category; open a tile for the exact rank basis.";
    panel.appendChild(explain);

    // Truth-mode banner: ordering is by separation from the reference track
    if (results.truth) {
        const truthNote = document.createElement("div");
        truthNote.style.cssText = "margin:8px 0 4px; padding:8px 12px; border-radius:6px;" +
            "background:#3a1e2e; color:#f4a6cd; border:1px solid #7a3b5c; font-size:13px;";
        truthNote.textContent = `Truth track "${results.truth.label}" selected — comparable candidates are ` +
            "GLOBALLY ordered by mean 3D separation from it (across categories, not within), and each rank basis " +
            "reports where they agree or diverge (location, altitude, speed, heading). The truth track is the dashed " +
            "pink line in the 3D graphs.";
        panel.appendChild(truthNote);
    }

    // Circular-LOS provenance banner: when the sightlines are CONSTRUCTED from
    // the target being tested (camera aimed To Target + raw camera-center LOS),
    // the whole gallery is an internal-consistency check, not discovery — say
    // so where it cannot be missed.
    if (results.provenance && results.provenance.circular) {
        const warn = document.createElement("div");
        warn.style.cssText = "margin:8px 0 4px; padding:8px 12px; border-radius:6px;" +
            "background:#4a3a12; color:#ffd479; border:1px solid #8a6d2a; font-size:13px;";
        warn.textContent = "⚠ Constructed LOS — validation only. " + results.provenance.reason +
            " Fits that recover the target confirm the scene's internal consistency; they are NOT " +
            "independent evidence of what the object is. Use independently measured camera attitude " +
            "and video tracking before treating the result as inference.";
        panel.appendChild(warn);
    }
    // Measured-LOS substitution: the analysis silently upgrading its evidence
    // is only acceptable if it is not silent.
    if (results.provenance && results.provenance.measuredSubstituted) {
        const note = document.createElement("div");
        note.style.cssText = "margin:8px 0 4px; padding:8px 12px; border-radius:6px;" +
            "background:#16321f; color:#9fd8ae; border:1px solid #2f6a42; font-size:13px;";
        note.textContent = "✓ Measured sensor LOS used. " + results.provenance.substitutionNote;
        panel.appendChild(note);
    }
    // Static sensor: range is NOT determined by the evidence — free-range
    // methods below are placeholders, not findings. This must be impossible
    // to miss; it invalidates most of the gallery.
    if (results.provenance && results.provenance.rangeUnobservable) {
        const warn = document.createElement("div");
        warn.style.cssText = "margin:8px 0 4px; padding:10px 12px; border-radius:6px;" +
            "background:#4a1512; color:#ffab9e; border:2px solid #a03a2e; font-size:13.5px; font-weight:600;";
        warn.textContent = "⛔ Range is NOT determined by this evidence. The sensor's motion over the " +
            "analysis window (baseline " + Math.round(results.provenance.sensorSpan ?? 0) + " m) is " +
            "negligible at the assumed working distance, so the sightlines contain no usable parallax: " +
            "every distance along them fits equally well, and each method's range reflects its own " +
            "priors, not measurement. Use a moving sensor, or treat all ranges below as arbitrary.";
        panel.appendChild(warn);
    }
    if (results.failures && results.failures.length) {
        const warn = document.createElement("div");
        warn.style.cssText = "margin:8px 0 4px; padding:8px 12px; border-radius:6px;" +
            "background:#3b2420; color:#ffb4a8; border:1px solid #704039; font-size:13px;";
        warn.textContent = `${results.failures.length} analysis check(s) failed or were unavailable: ` +
            results.failures.map((f) => `${f.method} (${f.error})`).join("; ") +
            ". They were not silently counted as evidence.";
        panel.appendChild(warn);
    }
    if (results.terrainChangedDuringRun) {
        // A calmer note than the failures banner: nothing failed, the run simply
        // observed terrain finish loading while it worked.
        const note = document.createElement("div");
        note.style.cssText = "margin:8px 0 4px; padding:8px 12px; border-radius:6px;" +
            "background:#2a2b22; color:#d7d08a; border:1px solid #55572f; font-size:13px;";
        note.textContent = "ℹ︎ Elevation data finished loading while this analysis ran. Results use the "
            + "elevation sampled at the start and are unlikely to be materially affected; re-run once "
            + "terrain has settled if you need the ground samples exact.";
        panel.appendChild(note);
    }

    const toolbar = document.createElement("div");
    toolbar.className = "tg-toolbar";
    const syncOrientationBtn = document.createElement("button");
    syncOrientationBtn.className = "tg-toggle on";
    syncOrientationBtn.type = "button";
    syncOrientationBtn.textContent = "Sync Orientation";
    syncOrientationBtn.title = "When on, dragging one 3D graph rotates every graph to match.";
    syncOrientationBtn.setAttribute("aria-pressed", "true");
    const syncScaleBtn = document.createElement("button");
    syncScaleBtn.className = "tg-toggle on";
    syncScaleBtn.type = "button";
    syncScaleBtn.textContent = "Sync Scale";
    syncScaleBtn.title = "When on, compare every graph using the selected graph's size scale.";
    syncScaleBtn.setAttribute("aria-pressed", "true");
    const setToggleState = (button, on) => {
        button.classList.toggle("on", on);
        button.setAttribute("aria-pressed", on ? "true" : "false");
    };
    syncOrientationBtn.addEventListener("click", () => {
        const on = !chartGroup.syncOrientation;
        chartGroup.setSyncOrientation(on, currentChart());
        setToggleState(syncOrientationBtn, on);
    });
    syncScaleBtn.addEventListener("click", () => {
        const on = !chartGroup.syncScale;
        chartGroup.setSyncScale(on, currentChart());
        setToggleState(syncScaleBtn, on);
    });
    // Restore every set-aside tile. Disabled (and count-less) while nothing has
    // been set aside, so the control also reports how many are currently out.
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "tg-toggle";
    restoreBtn.type = "button";
    restoreBtn.textContent = "Restore set-aside";
    restoreBtn.title = "Bring every set-aside candidate back into consideration.";
    restoreBtn.disabled = true;
    toolbar.appendChild(syncOrientationBtn);
    toolbar.appendChild(syncScaleBtn);
    toolbar.appendChild(restoreBtn);
    panel.appendChild(toolbar);

    // two-pane body: tiles (2/3) + details (1/3)
    const body = document.createElement("div");
    body.className = "tg-body";
    panel.appendChild(body);

    const tilesCol = document.createElement("div");
    tilesCol.className = "tg-tiles";
    const grid = document.createElement("div");
    grid.className = "tg-grid";
    tilesCol.appendChild(grid);
    body.appendChild(tilesCol);

    const detailsCol = document.createElement("div");
    detailsCol.className = "tg-details";
    body.appendChild(detailsCol);

    // shared solution-space context for every Details pane
    const ctx = {dataset, ss: analyzeSolutionSpace(results)};

    if (tiles.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tg-empty";
        empty.textContent = "No candidate trajectories were produced for this geometry.";
        grid.appendChild(empty);
        detailsCol.innerHTML = `<div class="tg-d-content"><p class="tg-d-lead">Nothing to detail.</p></div>`;
    }

    // details pane scaffold: sticky Use-This action bar + scrolling content
    const dActions = document.createElement("div");
    dActions.className = "tg-d-actions";
    const useBtn = document.createElement("button");
    useBtn.className = "tg-use";
    useBtn.textContent = "Use exact result";
    useBtn.title = "Install the exact trajectory shown here as an analysis-result snapshot. " +
        "Change assumptions, then run Analyze again to produce a new snapshot.";
    dActions.appendChild(useBtn);
    const dContent = document.createElement("div");
    dContent.className = "tg-d-content";
    if (tiles.length > 0) { detailsCol.appendChild(dActions); detailsCol.appendChild(dContent); }

    const tileEls = [];
    const selectTile = (i) => {
        if (i < 0 || i >= tiles.length) return;
        selected = i;
        tileEls.forEach((el, k) => el.classList.toggle("selected", k === i));
        const {h, r, category, groupIndex, groupSize, tied} = tiles[i];
        disposeDetailChart();
        dContent.innerHTML = buildDetailHTML(h, r, groupIndex, groupSize, category, ctx, tied);
        const detailCanvas = dContent.querySelector("canvas[data-chart-role='detail']");
        if (detailCanvas) {
            detailChart = registerChart(new Chart3D(detailCanvas,
                hypothesisVolumeScene(dataset, h, {truth: results.truth}),
                chartGroup, {pad: 0.13}));
            if (chartGroup.syncScale) chartGroup.setSyncScale(true, detailChart);
            if (groupZoomed && detailChart.scene.zoomBounds) detailChart.setZoom(true);
            syncZoomButton(detailChart);
        }
        detailsCol.scrollTop = 0;
        if (h.identity) {
            // An identification (astronomical body, satellite, point at infinity),
            // not a selectable traverse method — nothing to apply.
            useBtn.textContent = "Identification — not a traverse";
            useBtn.disabled = true;
            useBtn.onclick = null;
        } else {
            useBtn.textContent = `Use exact “${h.name}”`;
            useBtn.disabled = false;
            useBtn.onclick = () => {
                let applied = null;
                try { applied = applyHypothesis(h); } finally { remove(); }
                // Name the traverse method actually selected when it isn't
                // simply the candidate's own name (e.g. Minimum Acceleration →
                // Global Fit: Minimum Acceleration, or an air-speed candidate
                // landing on Constant Ground Speed in a sitch with no
                // air-speed method). A null return means no live method
                // matched — say so instead of claiming success.
                // Under measured-LOS substitution the applied track was fitted
                // to the recorded sensor angles, while the scene still draws
                // the constructed (target-aimed) sightline fan — the track will
                // visibly sit beside those rays. Say so at the moment the
                // divergence becomes visible, not only in the analysis banner.
                const subNote = window.lastTraverseAnalysis?.provenance?.measuredSubstituted
                    ? " (fitted to the measured sensor LOS; the displayed sightlines are the constructed camera aim and will not lie on the track)"
                    : "";
                showGalleryToast(applied
                    ? (applied !== h.name ? `Applied: ${h.name} (method: ${applied})${subNote}`
                                          : `Applied: ${h.name}${subNote}`)
                    : `No matching traverse method to apply for: ${h.name}`);
            };
        }
    };

    // Layout model for the tile grid. Tiles can be SET ASIDE (the X button),
    // which moves them below a separator at the end rather than deleting them —
    // the reader can still see what was excluded, and "Restore set-aside" brings
    // them all back. There are no group headings: the tiles are in one flat
    // best-first order and each carries its category as a coloured corner label.
    const dismissed = new Set();

    const relayout = () => {
        while (grid.firstChild) grid.removeChild(grid.firstChild);
        tiles.forEach((_, i) => {
            if (dismissed.has(i)) return;
            grid.appendChild(tileEls[i]);
        });
        if (dismissed.size > 0) {
            const sep = document.createElement("div");
            sep.className = "tg-sep";
            sep.innerHTML = `<div class="tg-sep-title">Set aside (${dismissed.size})</div>`
                + `<div class="tg-sep-desc">Excluded from consideration. They are still shown, and `
                + `still ranked as they were, so nothing is silently dropped — use "Restore set-aside" `
                + `to bring them back.</div>`;
            grid.appendChild(sep);
            tiles.forEach((_, i) => { if (dismissed.has(i)) grid.appendChild(tileEls[i]); });
        }
        restoreBtn.disabled = dismissed.size === 0;
        restoreBtn.textContent = dismissed.size === 0
            ? "Restore set-aside" : `Restore set-aside (${dismissed.size})`;
    };

    // ---- Dismissal animation ----------------------------------------------
    // Two beats, deliberately sequential rather than simultaneous: the tile
    // first drops away on its own while the grid holds still (so you can see
    // WHICH one left and the hole it came from), and only then do the survivors
    // close the gap. Doing both at once reads as an unexplained shuffle.
    const FLY_MS = 300;      // beat 1: the tile drops out of the list
    const REFLOW_MS = 300;   // beat 2: everything else slides into place

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const reducedMotion = () => typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // FLIP: measure where things are, change the layout, then start each moved
    // element back at its old position and let it transition to the new one.
    // Animating real layout changes this way keeps the grid authoritative — no
    // parallel "animation layout" to drift out of sync.
    const reflowAnimated = async (mutate, skipEl = null) => {
        if (reducedMotion()) { mutate(); return; }
        const first = new Map();
        for (const el of tileEls) first.set(el, el.getBoundingClientRect());
        mutate();
        const moved = [];
        for (const el of tileEls) {
            if (el === skipEl) continue;             // it already flew away
            const a = first.get(el), b = el.getBoundingClientRect();
            if (!a || !b.width) continue;            // not laid out
            const dx = a.left - b.left, dy = a.top - b.top;
            if (!dx && !dy) continue;
            el.style.transition = "none";
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            moved.push(el);
        }
        if (moved.length === 0) return;
        void grid.offsetHeight;                      // flush the inverted state
        for (const el of moved) {
            el.style.transition = `transform ${REFLOW_MS}ms ease`;
            el.style.transform = "";
        }
        await wait(REFLOW_MS);
        for (const el of moved) { el.style.transition = ""; el.style.transform = ""; }
    };

    // Clicks are queued rather than dropped, so impatient double-clicks still
    // land instead of being silently swallowed mid-animation.
    let animQueue = Promise.resolve();
    const queueAnimation = (fn) => { animQueue = animQueue.then(fn).catch(() => {}); };

    // The per-tile button is a toggle, so it states what it will DO next: an X
    // while the tile is in play, an up-arrow once it has been set aside.
    // Direction is meaningful here — the tile leaves downwards and comes back
    // upwards — so the arrow doubles as a hint about the motion.
    const syncDismissButton = (i) => {
        const btn = tileEls[i].querySelector(".tg-tile-dismiss");
        const aside = dismissed.has(i);
        const name = tiles[i].h.name;
        btn.textContent = aside ? "↑" : "✕";
        btn.title = aside
            ? "Restore — bring back into consideration"
            : "Set aside — exclude from consideration";
        btn.setAttribute("aria-label", `${aside ? "Restore" : "Set aside"} ${name}`);
        btn.classList.toggle("restore", aside);
    };

    // Where selection goes when the SELECTED tile is set aside. Follows what
    // the eye does: first the tile that slides up into the vacated slot, then
    // the one to its left, then whatever is nearest on screen. Group headings
    // span the full grid width, so only tiles in the SAME group actually shift
    // into that slot — hence the same-group scan before the geometric fallback.
    // Returns -1 when nothing is left in play, in which case the caller leaves
    // the set-aside tile selected rather than selecting nothing.
    const pickSuccessor = (i, vacatedRect) => {
        const group = tiles[i].category.key;
        const inPlay = (k) => k !== i && !dismissed.has(k);
        for (let k = i + 1; k < tiles.length && tiles[k].category.key === group; k++) {
            if (inPlay(k)) return k;          // slides into the vacated slot
        }
        for (let k = i - 1; k >= 0 && tiles[k].category.key === group; k--) {
            if (inPlay(k)) return k;          // the one to its left
        }
        let best = -1, bestDist = Infinity;
        const cx = vacatedRect.left + vacatedRect.width / 2;
        const cy = vacatedRect.top + vacatedRect.height / 2;
        for (let k = 0; k < tiles.length; k++) {
            if (!inPlay(k)) continue;
            const r = tileEls[k].getBoundingClientRect();
            if (!r.width) continue;           // not laid out
            const dx = (r.left + r.width / 2) - cx, dy = (r.top + r.height / 2) - cy;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = k; }
        }
        return best;
    };

    const setAside = async (i) => {
        const tile = tileEls[i];
        const dismissing = !dismissed.has(i);
        const wasSelected = selected === i;
        // Measured before the fly transform is applied, so it is the slot the
        // tile actually vacated rather than wherever it flew to.
        const vacatedRect = tile.getBoundingClientRect();
        if (!reducedMotion()) {
            // Beat 1. The grid is untouched, so the tile's slot stays open and
            // nothing else budges yet. Leaves downwards, returns upwards, so
            // the two directions read as opposites rather than a generic move.
            const rect = tile.getBoundingClientRect();
            const dy = dismissing
                ? window.innerHeight - rect.top + 40    // out through the bottom
                : -(rect.bottom + 40);                  // back out through the top
            tile.style.transition = `transform ${FLY_MS}ms cubic-bezier(0.35, 0, 0.9, 0.55), `
                + `opacity ${FLY_MS}ms linear`;
            tile.style.transform = `translateY(${dy}px)`;
            tile.style.opacity = "0";
            await wait(FLY_MS);
        }
        // Drop the fly transform before re-measuring, or the FLIP below would
        // read the off-screen position as this tile's "old" position.
        tile.style.transition = "none";
        tile.style.transform = "";
        tile.style.opacity = "";
        if (dismissing) dismissed.add(i); else dismissed.delete(i);
        tile.classList.toggle("dismissed", dismissing);
        syncDismissButton(i);
        if (dismissing && wasSelected) {
            const successor = pickSuccessor(i, vacatedRect);
            if (successor >= 0) selectTile(successor);
        }
        // Beat 2. The tile that just flew is excluded in BOTH directions — it
        // should be waiting at its destination, not slide there from the slot
        // it visibly just left.
        await reflowAnimated(relayout, tile);
        tile.style.transition = "";
    };

    restoreBtn.addEventListener("click", () => {
        if (dismissed.size === 0) return;
        queueAnimation(() => reflowAnimated(() => {
            const restoring = Array.from(dismissed);
            restoring.forEach((i) => tileEls[i].classList.remove("dismissed"));
            dismissed.clear();
            // Bulk restore has no fly beat — everything simply slides home
            // together — but the buttons still have to flip back to X.
            restoring.forEach(syncDismissButton);
            relayout();
        }));
    });

    tiles.forEach(({h, r, category, groupIndex, groupSize, tied}, i) => {
        const badges = [tierBadge(r), ...completenessBadges(r)];
        const badgesHTML = badges.map((badge) =>
            `<span class="tg-badge" style="background:${badge.color}">${escapeHtml(badge.label)}</span>`).join("");
        const statsHTML = hypothesisStats(h).map(([k, v]) =>
            `<div class="tg-st"><div class="tg-stk">${escapeHtml(k)}</div>` +
            `<div class="tg-stv">${escapeHtml(v)}</div></div>`).join("");
        const tieText = tied ? " · display-score tie" : "";

        const tile = document.createElement("div");
        tile.className = "tg-tile";
        tile.innerHTML =
            `<div class="tg-cat" style="color:${category.color}" title="${escapeHtml(category.description)}">` +
                `${escapeHtml(category.label)}</div>` +
            `<div class="tg-chart-shell tg-thumb-shell">` +
                `<button class="tg-tile-dismiss" type="button" title="Set aside — exclude from consideration" ` +
                `aria-label="Set aside ${escapeHtml(h.name)}">✕</button>` +
                `<canvas class="tg-thumb tg-chart-3d" data-chart-role="tile" role="img" title="Drag to rotate" ` +
                `aria-label="3D volume view of the ${escapeHtml(h.name)} trajectory"></canvas>` +
                `<button class="tg-chart-fullscreen" type="button" title="Fullscreen graph" ` +
                `aria-label="Fullscreen graph">⛶</button>` +
                ZOOM_BUTTON_HTML +
            `</div>` +
            `<div class="tg-tile-h">` +
                `<span class="tg-name">${escapeHtml(h.name)}</span>` +
                `<span class="tg-badges">${badgesHTML}</span>` +
            `</div>` +
            `<div class="tg-sub">${escapeHtml(h.subtitle)}</div>` +
            `<div class="tg-order">#${groupIndex + 1} of ${groupSize} within ${escapeHtml(category.shortLabel)}${escapeHtml(tieText)}</div>` +
            `<div class="tg-stats">${statsHTML}</div>` +
            `<div class="tg-rank-basis"><strong>Rank basis:</strong> ${escapeHtml(rankingExplanation(h, r))}</div>`;
        tile.addEventListener("click", () => selectTile(i));
        // stopPropagation so setting a tile aside doesn't also select it
        tile.querySelector(".tg-tile-dismiss").addEventListener("click", (ev) => {
            ev.stopPropagation();
            queueAnimation(() => setAside(i));
        });
        tileEls.push(tile);
        pendingTileCharts.push({canvas: tile.querySelector("canvas[data-chart-role='tile']"), h, i});
    });
    // Guarded: with no tiles the grid holds the "no candidates" message, and
    // relayout() would clear it.
    if (tiles.length > 0) relayout();

    // footer
    const footer = document.createElement("div");
    footer.className = "tg-footer";
    const reportBtn = document.createElement("button");
    reportBtn.className = "tg-btn tg-btn-primary";
    reportBtn.textContent = "Open Full Report";
    reportBtn.addEventListener("click", () => {
        // built lazily on first open (and cached) — see runTraverseAnalysis
        if (!results.html && typeof results.buildHtml === "function") {
            reportBtn.textContent = "Building report…";
            reportBtn.disabled = true;
            // yield a frame so the label paints before the heavy chart encodes
            requestAnimationFrame(() => setTimeout(() => {
                try {
                    if (!results.html) results.html = results.buildHtml();
                    openReport(results.html);
                } catch (err) {
                    // Keep the gallery open and tell the user, rather than leaving
                    // an uncaught async error with no explanation (TA-23).
                    console.error("Traverse report generation failed:", err);
                    showError("Full report generation failed while building or opening the report: "
                        + ((err && err.message) || err)
                        + "\n\nThe gallery is still available; see the browser console for the full stack.");
                } finally {
                    reportBtn.textContent = "Open Full Report";
                    reportBtn.disabled = false;
                }
            }, 0));
            return;
        }
        openReport(results.html);
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "tg-btn tg-btn-ghost";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", remove);
    footer.appendChild(reportBtn);
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    document.body.appendChild(overlay);

    if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const chart = chartByCanvas.get(entry.target);
                if (chart) chart.resize();
            }
        });
    }
    window.addEventListener("resize", onResize);

    for (const {canvas, h, i} of pendingTileCharts) {
        if (!canvas) continue;
        tileCharts[i] = registerChart(new Chart3D(canvas,
            hypothesisVolumeScene(dataset, h, {compact: true, truth: results.truth}),
            chartGroup, {pad: 0.14}));
        if (groupZoomed && tileCharts[i].scene.zoomBounds) tileCharts[i].setZoom(true);
        syncZoomButton(tileCharts[i]);
    }

    // Start with the first trajectory-family result. This is only the leader of
    // that comparison group, not a global object winner.
    if (tiles.length > 0) selectTile(0);
}

/**
 * Apply a hypothesis to the live app so the scene displays that interpretation.
 * Uses robust option-label fallbacks so it works across sitches (Gimbal uses
 * "Const Air Spd" / "Constant Altitude", Aguadilla uses "Constant Speed", ...).
 * The physics fits (aircraft / lantern) kick off an async solve that updates the
 * view a few seconds later — the app propagates that on its own.
 */
// The traverse-method switch id varies by sitch flavor: legacy jet sitches use
// "LOSTraverseSelect", the data-driven/custom setup passes its own id
// (custom = "LOSTraverseSelectTrack"). Without this, custom sitches silently
// got NO live-method contender tiles and "Use This" set the sliders but never
// switched the method.
function resolveTraverseSelect() {
    return NodeMan.get("LOSTraverseSelect", false)
        ?? NodeMan.get("LOSTraverseSelectTrack", false)
        ?? null;
}

function applyHypothesis(hyp) {
    const setBig = (id, m) => {
        const nd = NodeMan.get(id, false);
        if (nd && nd.setValueWithUnits) nd.setValueWithUnits(m / METERS_PER_NM, "nautical", "big");
    };
    const setSpeed = (id, ms) => {
        const nd = NodeMan.get(id, false);
        if (nd && nd.setValueWithUnits) nd.setValueWithUnits(ms / KNOTS_TO_MS, "nautical", "speed");
    };
    const sel = resolveTraverseSelect();
    let snapshotNode = sel && sel.inputs ? sel.inputs["Analysis Result Snapshot"] : null;
    if (typeof snapshotNode === "string") snapshotNode = NodeMan.get(snapshotNode, false);
    const canApplySnapshot = !!(snapshotNode && typeof snapshotNode.setAnalysisTrack === "function"
        && hyp.track && hyp.applyContext);
    // Select the first available option (matching on the switch's KEYS — the
    // per-sitch spellings) and return its DISPLAY label, or null if none matched.
    const selectFirst = (opts) => {
        if (!sel || !sel.inputs) return null;
        for (const o of opts) {
            if (sel.inputs[o] !== undefined) {
                sel.selectOption(o);
                return sel.guiLabels?.[o] ?? o;
            }
        }
        return null;
    };
    // Every historical per-sitch spelling of the two speed traverses. The switch
    // stores these as keys (saved sitches serialize them), so matching must try
    // them all; the display is unified via the labels map in MakeTraverseNodesMenu.
    const GROUND_SPEED_KEYS = ["Constant Ground Speed", "Constant Ground Speed - ", "Constant Speed", "Const Ground Spd"];
    const AIR_SPEED_KEYS = ["Constant Air Speed", "Const Air Spd"];
    const setModel = (names) => {
        const pm = NodeMan.get("physicsModelChoice", false);
        if (pm && pm.inputs) {
            for (const n of names) {
                if (pm.inputs[n] !== undefined) { pm.selectOption(n); return; }
            }
        }
    };
    // The gallery's physics fits always run the generic AUTO envelope, so make
    // the live fit match: reset the make/model sub-dropdown to AUTO (its first
    // option). A previously selected specific airframe would otherwise bound
    // the applied fit differently from the tile the user chose.
    const setAutoSubModel = (switchId) => {
        const n = NodeMan.get(switchId, false);
        if (n && n.inputs) n.selectOption(Object.keys(n.inputs)[0]);
    };
    let applied = null;
    // Contenders read straight off a live method node carry the exact switch
    // label — selecting it re-applies that method's own fit.
    if (hyp.params && hyp.params.methodLabel && !canApplySnapshot) {
        applied = selectFirst([hyp.params.methodLabel]);
        setRenderOne(true);
        return applied;
    }
    // Snapshot application is intentionally assumption-neutral: installing a
    // reviewed trajectory must not also overwrite start-distance/speed priors
    // and bias the next analysis toward the just-selected answer. Explicit GUI
    // tweaks remain available to the user after the snapshot is displayed.
    if (canApplySnapshot && snapshotNode.setAnalysisTrack(hyp.track,
        hyp.applyContext.originLat, hyp.applyContext.originLon,
        hyp.applyContext.frame0, hyp.name)) {
        const wasSelected = sel.choice === "Analysis Result Snapshot";
        applied = selectFirst(["Analysis Result Snapshot"]);
        // CNodeSwitch.selectOption() is a no-op when this option is already
        // selected. Cascade explicitly so applying result B after result A
        // refreshes every display/graph that cached A.
        if (wasSelected) snapshotNode.recalculateCascade();
        setRenderOne(true);
        return applied;
    }
    switch (hyp.key) {
        case "constAir":
            setBig("startDistance", hyp.params.range);
            setSpeed("speedScaled", hyp.params.airSpeed);
            // A true air-speed traverse reproduces the fitted track; only if the
            // sitch has none, fall back to ground speed (identical in zero wind).
            if (!canApplySnapshot) {
                applied = selectFirst(AIR_SPEED_KEYS) ?? selectFirst(GROUND_SPEED_KEYS);
            }
            break;
        case "constAlt":
            // "Constant Altitude" derives its held altitude from startDistance,
            // reproducing the fitted track. (Not "Starting Altitude", which reads
            // a separate startAltitude slider we don't set here.)
            setBig("startDistance", hyp.params.range);
            if (!canApplySnapshot) applied = selectFirst(["Constant Altitude"]);
            break;
        case "plausible":
            if (!canApplySnapshot) applied = selectFirst(["Global Fit: Plausible"]);
            break;
        case "saddle":
            if (!canApplySnapshot) applied = selectFirst(["Global Fit: Minimum Speed"]);
            break;
        case "ground":
        case "fixedPoint":
            // A stationary object: the dedicated stationary-point method holds
            // the SAME least-squares fixed point the tile shows (sea-level
            // pinned for the Ground Object). No on-ray traverse can represent
            // it — walking rays at ground speed 0 still moves by the rays'
            // closest-approach distance each frame, drifting off the point and
            // flagging over-speed (white) segments. A point "at infinity" (the
            // Moon-like reading) has no finite traverse: leave the method be.
            if (hyp.atInfinity) break;
            setBig("startDistance", hyp.params.distance);
            if (!canApplySnapshot) {
                applied = selectFirst(hyp.key === "ground"
                    ? ["Global Fit: Ground Object"] : ["Global Fit: Stationary Point"]);
            }
            if (!applied && !canApplySnapshot) {
                // Legacy sitch without the stationary methods: best effort is
                // the old ground-speed-0 hold (drifts; kept only as fallback).
                setSpeed("speedScaled", 0);
                applied = selectFirst(GROUND_SPEED_KEYS) ?? selectFirst(AIR_SPEED_KEYS);
            }
            break;
        case "groundVehicle":
            // The moving sightline-meets-ground point; the live method computes
            // the same plane/track the gallery fitted.
            if (!canApplySnapshot) applied = selectFirst(["Ground Vehicle"]);
            break;
        case "aircraft":
            setModel(["Fixed Wing Aircraft"]);
            setAutoSubModel("fixedWingModelChoice");
            if (!canApplySnapshot) applied = selectFirst(["Global Fit: Physics"]);
            break;
        case "lantern":
            setModel(["Sky Lantern"]);
            if (!canApplySnapshot) applied = selectFirst(["Global Fit: Physics"]);
            break;
        case "quadcopter":
            setModel(["Quadcopter"]);
            setAutoSubModel("quadModelChoice");
            if (!canApplySnapshot) applied = selectFirst(["Global Fit: Physics"]);
            break;
    }
    setRenderOne(true);
    return applied;
}

// ---------------------------------------------------------------------------
// Chart helper — minimal canvas-2D chart frame (axes, ticks, series, legend)
// rendered at 2x for crisp PNGs
// ---------------------------------------------------------------------------

class CReportChart {
    constructor(o) {
        this.w = o.width ?? 900;
        this.h = o.height ?? 500;
        const scale = 2;
        this.canvas = document.createElement("canvas");
        this.canvas.width = this.w * scale;
        this.canvas.height = this.h * scale;
        this.ctx = this.canvas.getContext("2d");
        this.ctx.scale(scale, scale);
        this.m = o.margin ?? {left: 64, right: 20, top: 40, bottom: 48};
        this.xLabel = o.xLabel ?? "";
        this.yLabel = o.yLabel ?? "";

        this.ctx.fillStyle = VIZ.surface;
        this.ctx.fillRect(0, 0, this.w, this.h);
        if (o.title) {
            this.ctx.fillStyle = VIZ.ink;
            this.ctx.font = "600 14px system-ui, sans-serif";
            this.ctx.textAlign = "left";
            this.ctx.textBaseline = "alphabetic";
            this.ctx.fillText(o.title, this.m.left, 24);
        }
    }

    get plotW() { return this.w - this.m.left - this.m.right; }
    get plotH() { return this.h - this.m.top - this.m.bottom; }

    setRange(x0, x1, y0, y1) {
        this.x0 = x0; this.x1 = x1 === x0 ? x0 + 1 : x1;
        this.y0 = y0; this.y1 = y1 === y0 ? y0 + 1 : y1;
    }

    px(x) { return this.m.left + (x - this.x0) / (this.x1 - this.x0) * this.plotW; }
    py(y) { return this.m.top + this.plotH - (y - this.y0) / (this.y1 - this.y0) * this.plotH; }

    axes(o = {}) {
        const {xTicks = [], yTicks = [], xFmt = fmtNum, yFmt = fmtNum, grid = true} = o;
        const ctx = this.ctx;
        ctx.save();
        ctx.font = "11px system-ui, sans-serif";
        ctx.lineWidth = 1;
        for (const tx of xTicks) {
            const x = Math.round(this.px(tx)) + 0.5;
            if (grid) {
                ctx.strokeStyle = VIZ.grid;
                ctx.beginPath();
                ctx.moveTo(x, this.m.top);
                ctx.lineTo(x, this.m.top + this.plotH);
                ctx.stroke();
            }
            ctx.fillStyle = VIZ.muted;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(xFmt(tx), x, this.m.top + this.plotH + 6);
        }
        for (const ty of yTicks) {
            const y = Math.round(this.py(ty)) + 0.5;
            if (grid) {
                ctx.strokeStyle = VIZ.grid;
                ctx.beginPath();
                ctx.moveTo(this.m.left, y);
                ctx.lineTo(this.m.left + this.plotW, y);
                ctx.stroke();
            }
            ctx.fillStyle = VIZ.muted;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(yFmt(ty), this.m.left - 7, y);
        }
        ctx.strokeStyle = VIZ.axis;
        ctx.strokeRect(this.m.left + 0.5, this.m.top + 0.5, this.plotW - 1, this.plotH - 1);
        ctx.fillStyle = VIZ.ink2;
        ctx.font = "12px system-ui, sans-serif";
        if (this.xLabel) {
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            ctx.fillText(this.xLabel, this.m.left + this.plotW / 2, this.h - 10);
        }
        if (this.yLabel) {
            ctx.save();
            ctx.translate(15, this.m.top + this.plotH / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = "center";
            ctx.fillText(this.yLabel, 0, 0);
            ctx.restore();
        }
        ctx.restore();
    }

    // xs/ys: array-likes (Array or Float64Array); non-finite values break the line
    polyline(xs, ys, color, o = {}) {
        const ctx = this.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.m.left, this.m.top, this.plotW, this.plotH);
        ctx.clip();
        ctx.strokeStyle = color;
        ctx.lineWidth = o.width ?? 2;
        ctx.globalAlpha = o.alpha ?? 1;
        ctx.lineJoin = "round";
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < xs.length; i++) {
            const x = xs[i], y = ys[i];
            if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
            const X = this.px(x), Y = this.py(y);
            if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
        }
        ctx.stroke();
        ctx.restore();
    }

    marker(x, y, color, label) {
        const ctx = this.ctx;
        const X = this.px(x), Y = this.py(y);
        ctx.save();
        ctx.beginPath();
        ctx.arc(X, Y, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = VIZ.surface;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X, Y, 7.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = VIZ.ink;
        ctx.stroke();
        if (label) {
            ctx.font = "600 11px system-ui, sans-serif";
            ctx.fillStyle = VIZ.ink;
            ctx.textBaseline = "middle";
            const left = X > this.m.left + this.plotW * 0.7;
            ctx.textAlign = left ? "right" : "left";
            ctx.fillText(label, left ? X - 12 : X + 12, Y);
        }
        ctx.restore();
    }

    legend(entries, corner = "tr") {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = "12px system-ui, sans-serif";
        const lineH = 17, pad = 9, swatch = 16;
        let maxW = 0;
        for (const e of entries) maxW = Math.max(maxW, ctx.measureText(e.label).width);
        const boxW = pad * 2 + swatch + 6 + maxW;
        const boxH = pad * 2 + entries.length * lineH - 5;
        const bx = corner.includes("l") ? this.m.left + 10
            : this.m.left + this.plotW - boxW - 10;
        const by = corner.includes("b") ? this.m.top + this.plotH - boxH - 10
            : this.m.top + 10;
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = VIZ.surface;
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = VIZ.axis;
        ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
        entries.forEach((e, i) => {
            const y = by + pad + i * lineH + 5;
            ctx.strokeStyle = e.color;
            ctx.lineWidth = e.width ?? 2.5;
            ctx.globalAlpha = e.alpha ?? 1;
            ctx.beginPath();
            ctx.moveTo(bx + pad, y);
            ctx.lineTo(bx + pad + swatch, y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = VIZ.ink2;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(e.label, bx + pad + swatch + 6, y);
        });
        ctx.restore();
    }

    dataURL() { return this.canvas.toDataURL("image/png"); }
}

function niceTicks(lo, hi, target = 6) {
    if (!(hi > lo)) hi = lo + 1;
    const span = hi - lo;
    const step0 = Math.pow(10, Math.floor(Math.log10(span / target)));
    const err = span / target / step0;
    const step = err >= 7.5 ? step0 * 10 : err >= 3.5 ? step0 * 5 : err >= 1.5 ? step0 * 2 : step0;
    const ticks = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) {
        ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    }
    return ticks;
}

// ticks (in log10 space) for a log axis
function logTicks(lo, hi) {
    const ticks = [];
    const mantissas = (hi - lo) <= 2.5 ? [1, 2, 5] : [1];
    for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
        for (const m of mantissas) {
            const v = e + Math.log10(m);
            if (v >= lo - 1e-9 && v <= hi + 1e-9) ticks.push(v);
        }
    }
    return ticks;
}
const fmtLogTick = (v) => fmtNum(Math.pow(10, v));

/**
 * Generic line chart -> PNG data URL.
 * o: {title, xLabel, yLabel, width, height, series: [{xs, ys, color, label,
 *     width, alpha}], logY, markers: [{x, y, color, label}], legendCorner}
 */
function lineChart(o) {
    const chart = new CReportChart(o);
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    let minPos = Infinity;
    for (const s of o.series) {
        for (let i = 0; i < s.xs.length; i++) {
            const x = s.xs[i], y = s.ys[i];
            if (!isFinite(x) || !isFinite(y)) continue;
            if (x < xMin) xMin = x;
            if (x > xMax) xMax = x;
            if (y < yMin) yMin = y;
            if (y > yMax) yMax = y;
            if (y > 0 && y < minPos) minPos = y;
        }
    }
    if (!isFinite(xMin)) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }
    if (!isFinite(minPos)) minPos = 1e-3;

    const tf = o.logY
        ? (y) => Math.log10(Math.max(y, minPos / 2))
        : (y) => y;

    let ticksY, y0, y1;
    if (o.logY) {
        y0 = tf(yMin); y1 = tf(yMax);
        const padY = (y1 - y0) * 0.06 || 0.1;
        y0 -= padY; y1 += padY;
        ticksY = logTicks(y0, y1);
    } else {
        const padY = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.1 || 1;
        y0 = yMin - padY; y1 = yMax + padY;
        if (o.zeroBased && yMin >= 0) y0 = 0;
        ticksY = niceTicks(y0, y1);
    }
    chart.setRange(xMin, xMax, y0, y1);
    chart.axes({
        xTicks: niceTicks(xMin, xMax, 8),
        yTicks: ticksY,
        yFmt: o.logY ? fmtLogTick : fmtNum,
    });
    for (const s of o.series) {
        chart.polyline(s.xs, Array.from(s.ys, tf), s.color,
            {width: s.width, alpha: s.alpha});
    }
    for (const mk of o.markers ?? []) {
        chart.marker(mk.x, tf(mk.y), mk.color, mk.label);
    }
    if (o.series.length > 1 || (o.markers ?? []).length) {
        chart.legend(o.series.map((s) => ({color: s.color, label: s.label})),
            o.legendCorner ?? "tr");
    }
    return chart.dataURL();
}

// Per-frame LOS angular error (degrees) of a track against the sightlines.
function losErrorSeriesDeg(dataset, track) {
    const {n, S, D} = dataset;
    const out = new Float64Array(n);
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const rx = track[b] - S[b], ry = track[b + 1] - S[b + 1], rz = track[b + 2] - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-9) { out[f] = 180; continue; }
        const dot = Math.min(1, Math.max(-1, (rx * D[b] + ry * D[b + 1] + rz * D[b + 2]) / rl));
        out[f] = Math.acos(dot) * 180 / Math.PI;
    }
    return out;
}

// The three per-frame diagnostic charts for one hypothesis — maneuvering
// g-force, speed, and LOS fit error over the clip — rendered to PNG data
// URLs (the report's offline idiom; the gallery Details pane reuses them).
// Returns null when the hypothesis has no track/series (e.g. a failed fit).
function hypothesisSeriesCharts(dataset, h, o = {}) {
    const m = h.metricsFull;
    if (!h.track || !m || !m.series) return null;
    const {n, fps} = dataset;
    // trim the velocity smoothing window's edge artifacts, downsample to a
    // plottable point count
    const trim = Math.min(9, n >> 3);
    const step = Math.max(1, Math.ceil((n - 2 * trim) / 700));
    // Downsample as a per-bucket MIN/MAX envelope, not by point-sampling every
    // `step`-th frame. On a long clip step reaches ~29 frames (~1 s), so plain
    // point sampling aliases: a quadcopter fit spinning at up to 4.7 rev/s drew
    // a slow "beat" pattern that looked like a real low-frequency oscillation
    // rather than the fast one it was. Two samples per bucket (min then max)
    // makes sub-sample variation read honestly as a filled band, and collapses
    // to the original line wherever the data is smooth (min == max).
    const xs = [];
    for (let f = trim; f < n - trim; f += step) {
        xs.push(f / fps);
        xs.push(Math.min(f + step / 2, n - trim - 1) / fps);
    }
    const pick = (arr, scale = 1) => {
        const ys = [];
        for (let f = trim; f < n - trim; f += step) {
            let lo = Infinity, hi = -Infinity;
            for (let k = f; k < Math.min(f + step, n - trim); k++) {
                const v = arr[k];
                if (!isFinite(v)) continue;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            if (lo === Infinity) { ys.push(NaN); ys.push(NaN); continue; }
            ys.push(lo * scale);
            ys.push(hi * scale);
        }
        return ys;
    };
    const base = {
        width: o.width ?? 560, height: o.height ?? 230,
        xLabel: "Time (s)", zeroBased: true,
        margin: {left: 56, right: 14, top: 34, bottom: 40},
    };
    const color = h.color || VIZ.constAir;

    const gURL = lineChart({...base, title: "Kinematic acceleration", yLabel: "acceleration (g)",
        series: [{xs, ys: pick(m.series.gLoad), color, label: "g-force"}]});

    // speed: air speed always; ground speed too when the wind makes them differ
    const airKt = pick(m.series.airSpeed, 1 / KNOTS_TO_MS);
    const gndKt = pick(m.series.groundSpeed, 1 / KNOTS_TO_MS);
    let windMatters = false;
    for (let i = 0; i < airKt.length; i++) {
        if (Math.abs(airKt[i] - gndKt[i]) > 1) { windMatters = true; break; }
    }
    const spdURL = lineChart({...base, title: "Speed", yLabel: "kt",
        series: windMatters
            ? [{xs, ys: airKt, color, label: "air speed"},
               {xs, ys: gndKt, color: VIZ.muted, label: "ground speed", width: 1.5}]
            : [{xs, ys: airKt, color, label: "air speed"}]});

    // LOS error, with the flexible generic-fit residual as a reference line
    // on the physics fits that carry one
    const errSeries = [{xs, ys: pick(losErrorSeriesDeg(dataset, h.track)),
        color, label: "LOS error"}];
    const floor = h.params && h.params.errFloor;
    if (isFinite(floor) && floor >= 0.02) {
        errSeries.push({xs: [xs[0], xs[xs.length - 1]], ys: [floor, floor],
            color: VIZ.muted, label: "generic-fit reference", width: 1.5, alpha: 0.9});
    }
    const errURL = lineChart({...base, title: "LOS fit error", yLabel: "degrees",
        series: errSeries});

    return {gURL, spdURL, errURL};
}

function heatColor(tRaw) {
    const t = Math.min(1, Math.max(0, tRaw));
    const seg = t * (HEAT_STOPS.length - 1);
    const i = Math.min(HEAT_STOPS.length - 2, Math.floor(seg));
    const f = seg - i;
    const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    const a = hex(HEAT_STOPS[i]), b = hex(HEAT_STOPS[i + 1]);
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Sweep-score heatmap (range NM x speed kt), log color scale (dark = good),
 * with the best point marked and a color scale bar.
 */
function sweepHeatmap(sweep) {
    const xs = sweep.ranges.map(toNM);                       // NM
    const yl = sweep.speeds.map((v) => Math.log10(toKt(v))); // log10(kt)
    const nx = xs.length, ny = yl.length;
    // per-cell edges from midpoints between neighboring grid values (the
    // speed grid is log-spaced, so plot the y axis in log10 space where the
    // cells are uniform again; midpoint edges also tolerate any custom grid)
    const dx = nx > 1 ? xs[1] - xs[0] : 1;
    const xEdge = (i, side) => (side < 0)
        ? (i > 0 ? (xs[i - 1] + xs[i]) / 2 : xs[0] - dx / 2)
        : (i < nx - 1 ? (xs[i] + xs[i + 1]) / 2 : xs[nx - 1] + dx / 2);
    const dyl = ny > 1 ? yl[1] - yl[0] : 0.1;
    const yEdge = (i, side) => (side < 0)
        ? (i > 0 ? (yl[i - 1] + yl[i]) / 2 : yl[0] - dyl / 2)
        : (i < ny - 1 ? (yl[i] + yl[i + 1]) / 2 : yl[ny - 1] + dyl / 2);

    const chart = new CReportChart({
        width: 940, height: 560,
        margin: {left: 64, right: 118, top: 40, bottom: 48},
        title: "Constant-air-speed sweep: plausibility score over (start range, air speed)",
        xLabel: "start range (NM)", yLabel: "air speed (kt, log scale)",
    });
    chart.setRange(xEdge(0, -1), xEdge(nx - 1, +1), yEdge(0, -1), yEdge(ny - 1, +1));

    let logMin = Infinity, logMax = -Infinity;
    const logScore = (s) => Math.log10(Math.max(s, 1e-3));
    for (const r of sweep.results) {
        const l = logScore(r.score);
        if (l < logMin) logMin = l;
        if (l > logMax) logMax = l;
    }
    if (!(logMax > logMin)) logMax = logMin + 1;
    const tOf = (s) => (logScore(s) - logMin) / (logMax - logMin);

    const ctx = chart.ctx;
    for (let ri = 0; ri < nx; ri++) {
        for (let si = 0; si < ny; si++) {
            const r = sweep.results[ri * ny + si];
            ctx.fillStyle = heatColor(tOf(r.score));
            const X = chart.px(xEdge(ri, -1));
            const Y = chart.py(yEdge(si, +1));
            ctx.fillRect(X, Y, chart.px(xEdge(ri, +1)) - X + 0.5, chart.py(yEdge(si, -1)) - Y + 0.5);
        }
    }
    chart.axes({
        xTicks: niceTicks(chart.x0, chart.x1, 9),
        yTicks: logTicks(chart.y0, chart.y1),
        yFmt: fmtLogTick,
        grid: false,
    });
    chart.marker(toNM(sweep.best.startDist), Math.log10(toKt(sweep.best.speed)), VIZ.constAir,
        `selected family representative: ${nm1(sweep.best.startDist)} NM @ ${kt1(sweep.best.speed)} kt`);

    // color scale bar (log): dark bottom = low score = plausible
    const bx = chart.w - chart.m.right + 34;
    const bw = 16, bTop = chart.m.top, bH = chart.plotH;
    for (let i = 0; i < bH; i++) {
        ctx.fillStyle = heatColor(1 - i / (bH - 1));
        ctx.fillRect(bx, bTop + i, bw, 1.5);
    }
    ctx.strokeStyle = VIZ.axis;
    ctx.strokeRect(bx + 0.5, bTop + 0.5, bw - 1, bH - 1);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = VIZ.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const barVals = [[0, logMax], [0.5, (logMin + logMax) / 2], [1, logMin]];
    for (const [f, lv] of barVals) {
        ctx.fillText(fmtNum(Math.pow(10, lv)), bx + bw + 5, bTop + f * (bH - 1));
    }
    ctx.save();
    ctx.translate(bx + bw + 38, bTop + bH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = VIZ.ink2;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("score (log scale)", 0, 0);
    ctx.restore();

    return chart.dataURL();
}

/**
 * Plan view (E/N in NM, equal aspect): sensor path, LOS rays, candidate tracks.
 * tracks: [{track: Float64Array(n*3) ENU meters, color, label}]
 * opts (all optional): {width, height, title (null suppresses), margin,
 *   legend (false suppresses), compact (drops axis titles, fewer ticks)} —
 *   defaults reproduce the original 940x720 combined plan view.
 */
function planViewChart(dataset, tracks, opts = {}) {
    const {n, S, D} = dataset;
    const compact = opts.compact ?? false;
    const chart = new CReportChart({
        width: opts.width ?? 940,
        height: opts.height ?? 720,
        title: opts.title !== undefined ? opts.title
            : "Plan view: sensor path, lines of sight, and candidate trajectories",
        xLabel: compact ? "" : "East (NM)",
        yLabel: compact ? "" : "North (NM)",
        margin: opts.margin ?? {left: 64, right: 20, top: 40, bottom: 48},
    });

    // Object at infinity (a fixed point in the sky / astronomical body): the
    // sightlines are effectively PARALLEL, so drawing a converging point or a
    // 200-NM "track" is misleading. Show parallel arrows from the sensor path
    // pointing in the object's fixed direction instead.
    if (opts.atInfinity) {
        return planViewAtInfinity(dataset, tracks[0] || {}, chart, opts, compact);
    }

    // per-frame ray length: just past the farthest displayed track
    const rangeAt = (tr, f) => Math.hypot(
        tr[f * 3] - S[f * 3], tr[f * 3 + 1] - S[f * 3 + 1], tr[f * 3 + 2] - S[f * 3 + 2]);
    const rays = [];
    for (let f = 0; f < n; f += 100) rays.push(f);
    if (rays[rays.length - 1] !== n - 1) rays.push(n - 1);

    // bounds over everything drawn (in NM)
    let eMin = Infinity, eMax = -Infinity, nMin = Infinity, nMax = -Infinity;
    const grow = (e, nn) => {
        if (e < eMin) eMin = e;
        if (e > eMax) eMax = e;
        if (nn < nMin) nMin = nn;
        if (nn > nMax) nMax = nn;
    };
    for (let f = 0; f < n; f++) grow(toNM(S[f * 3]), toNM(S[f * 3 + 1]));
    for (const trk of tracks) {
        for (let f = 0; f < n; f++) grow(toNM(trk.track[f * 3]), toNM(trk.track[f * 3 + 1]));
    }
    const rayEnds = rays.map((f) => {
        let L = 0;
        for (const trk of tracks) L = Math.max(L, rangeAt(trk.track, f));
        L *= 1.08;
        const e = toNM(S[f * 3] + D[f * 3] * L);
        const nn = toNM(S[f * 3 + 1] + D[f * 3 + 1] * L);
        grow(e, nn);
        return [e, nn];
    });

    // equal-aspect mapping
    const padF = 0.06;
    const cE = (eMin + eMax) / 2, cN = (nMin + nMax) / 2;
    const spanE = (eMax - eMin) * (1 + padF * 2) || 1;
    const spanN = (nMax - nMin) * (1 + padF * 2) || 1;
    const scale = Math.min(chart.plotW / spanE, chart.plotH / spanN);
    const halfE = chart.plotW / scale / 2, halfN = chart.plotH / scale / 2;
    chart.setRange(cE - halfE, cE + halfE, cN - halfN, cN + halfN);

    const nTicks = compact ? 5 : 9;
    chart.axes({
        xTicks: niceTicks(chart.x0, chart.x1, nTicks),
        yTicks: niceTicks(chart.y0, chart.y1, nTicks),
    });

    // LOS rays (thin, faint)
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chart.m.left, chart.m.top, chart.plotW, chart.plotH);
    ctx.clip();
    ctx.strokeStyle = VIZ.ray;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    rays.forEach((f, i) => {
        ctx.beginPath();
        ctx.moveTo(chart.px(toNM(S[f * 3])), chart.py(toNM(S[f * 3 + 1])));
        ctx.lineTo(chart.px(rayEnds[i][0]), chart.py(rayEnds[i][1]));
        ctx.stroke();
    });
    ctx.restore();

    // sensor path + tracks
    const enOf = (tr) => {
        const es = new Float64Array(n), ns = new Float64Array(n);
        for (let f = 0; f < n; f++) { es[f] = toNM(tr[f * 3]); ns[f] = toNM(tr[f * 3 + 1]); }
        return [es, ns];
    };
    const [se, sn] = enOf(S);
    chart.polyline(se, sn, VIZ.sensor, {width: 2.5});
    for (const trk of tracks) {
        const [te, tn] = enOf(trk.track);
        chart.polyline(te, tn, trk.color, {width: 2});
        // start dot / end tick
        ctx.save();
        ctx.fillStyle = trk.color;
        ctx.beginPath();
        ctx.arc(chart.px(te[0]), chart.py(tn[0]), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = trk.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(chart.px(te[n - 1]), chart.py(tn[n - 1]), 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
    // sensor start dot
    ctx.save();
    ctx.fillStyle = VIZ.sensor;
    ctx.beginPath();
    ctx.arc(chart.px(se[0]), chart.py(sn[0]), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (opts.legend !== false) {
        chart.legend([
            {color: VIZ.sensor, label: "sensor (jet) path", width: 2.5},
            {color: VIZ.ray, label: "lines of sight (every ~100 frames)", width: 1, alpha: 0.7},
            ...tracks.map((trk) => ({color: trk.color, label: trk.label})),
        ], "tl");
    }

    return chart.dataURL();
}

/**
 * Plan view for an object at infinity (fixed point in the sky / astronomical
 * body): parallel arrows from along the sensor path, all pointing in the
 * object's fixed direction — the geometric signature of a light so distant the
 * sightlines don't converge. No track polyline (it would be off at ~200 NM).
 */
function planViewAtInfinity(dataset, trk, chart, opts, compact) {
    const {n, S, D} = dataset;
    // Mean horizontal LOS direction (unit E/N) — the direction to the object.
    let de = 0, dn = 0;
    for (let f = 0; f < n; f++) { de += D[f * 3]; dn += D[f * 3 + 1]; }
    const dl = Math.hypot(de, dn) || 1; de /= dl; dn /= dl;

    // Sensor-path bounds (NM); the arrows extend a fraction of its span.
    let eMin = Infinity, eMax = -Infinity, nMin = Infinity, nMax = -Infinity;
    for (let f = 0; f < n; f++) {
        const e = toNM(S[f * 3]), nn = toNM(S[f * 3 + 1]);
        if (e < eMin) eMin = e; if (e > eMax) eMax = e;
        if (nn < nMin) nMin = nn; if (nn > nMax) nMax = nn;
    }
    const pathSpan = Math.max(eMax - eMin, nMax - nMin, 1);
    const arrowLen = pathSpan * 0.9;   // NM, in the object's direction

    // Grow bounds to include the arrow tips.
    const sampleF = [];
    const NARROWS = 7;
    for (let i = 0; i < NARROWS; i++) sampleF.push(Math.round((n - 1) * i / (NARROWS - 1)));
    const grow = (e, nn) => {
        if (e < eMin) eMin = e; if (e > eMax) eMax = e;
        if (nn < nMin) nMin = nn; if (nn > nMax) nMax = nn;
    };
    for (const f of sampleF) {
        grow(toNM(S[f * 3]) + de * arrowLen, toNM(S[f * 3 + 1]) + dn * arrowLen);
    }

    const padF = 0.08;
    const cE = (eMin + eMax) / 2, cN = (nMin + nMax) / 2;
    const spanE = (eMax - eMin) * (1 + padF * 2) || 1;
    const spanN = (nMax - nMin) * (1 + padF * 2) || 1;
    const scale = Math.min(chart.plotW / spanE, chart.plotH / spanN);
    const halfE = chart.plotW / scale / 2, halfN = chart.plotH / scale / 2;
    chart.setRange(cE - halfE, cE + halfE, cN - halfN, cN + halfN);
    chart.axes({
        xTicks: niceTicks(chart.x0, chart.x1, compact ? 5 : 9),
        yTicks: niceTicks(chart.y0, chart.y1, compact ? 5 : 9),
    });

    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chart.m.left, chart.m.top, chart.plotW, chart.plotH);
    ctx.clip();
    // Parallel arrows toward the object.
    const col = trk.color || "#c9d4e5";
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 2;
    for (const f of sampleF) {
        const x0 = chart.px(toNM(S[f * 3])), y0 = chart.py(toNM(S[f * 3 + 1]));
        const x1 = chart.px(toNM(S[f * 3]) + de * arrowLen);
        const y1 = chart.py(toNM(S[f * 3 + 1]) + dn * arrowLen);
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        // arrowhead (pixel space)
        const ang = Math.atan2(y1 - y0, x1 - x0), hs = compact ? 7 : 11;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - hs * Math.cos(ang - 0.4), y1 - hs * Math.sin(ang - 0.4));
        ctx.lineTo(x1 - hs * Math.cos(ang + 0.4), y1 - hs * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();

    // Sensor path on top.
    const se = new Float64Array(n), sn = new Float64Array(n);
    for (let f = 0; f < n; f++) { se[f] = toNM(S[f * 3]); sn[f] = toNM(S[f * 3 + 1]); }
    chart.polyline(se, sn, VIZ.sensor, {width: 2.5});
    ctx.save();
    ctx.fillStyle = VIZ.sensor;
    ctx.beginPath();
    ctx.arc(chart.px(se[0]), chart.py(sn[0]), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (opts.legend !== false) {
        chart.legend([
            {color: VIZ.sensor, label: "sensor (jet) path", width: 2.5},
            {color: col, label: (trk.label || "object") + " — parallel sightlines (at infinity)", width: 2},
        ], "tl");
    }
    return chart.dataURL();
}

/**
 * Small overhead (plan) thumbnail for one hypothesis card: that hypothesis's
 * track riding the lines of sight over the sensor path. Reuses planViewChart
 * at a compact size with no title/legend (the card header already names it).
 * An "at infinity" hypothesis is drawn as parallel arrows, not a point/track.
 * Returns a PNG data URL.
 */
function hypothesisThumbnail(dataset, hyp) {
    return planViewChart(dataset, [{track: hyp.track, color: hyp.color, label: hyp.name}], {
        width: 460, height: 380,
        title: null,
        compact: true,
        legend: false,
        atInfinity: !!hyp.atInfinity,
        margin: {left: 46, right: 12, top: 12, bottom: 28},
    });
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

// lowest-score row of a profile within [loM, hiM] start range
function bestRowInWindow(profile, loM, hiM) {
    let best = null;
    for (const r of profile) {
        if (r.startDist >= loM - 1 && r.startDist <= hiM + 1) {
            if (!best || r.score < best.score) best = r;
        }
    }
    return best;
}

// contiguous region around the profile minimum with score <= factor * min
function minRegion(profile, factor = 1.5) {
    let bi = 0;
    profile.forEach((r, i) => { if (r.score < profile[bi].score) bi = i; });
    let lo = bi, hi = bi;
    while (lo > 0 && profile[lo - 1].score <= profile[bi].score * factor) lo--;
    while (hi < profile.length - 1 && profile[hi + 1].score <= profile[bi].score * factor) hi++;
    return {best: profile[bi], loM: profile[lo].startDist, hiM: profile[hi].startDist};
}

function buildReportHypothesisDetails(dataset, rankedHyps, ss) {
    return rankedHyps.map(({h, r, tied, category, groupIndex, groupSize}) => {
        const statsHTML = hypothesisStats(h).map(([k, v]) =>
            `<div class="st"><div class="stk">${escapeHtml(k)}</div>` +
            `<div class="stv">${escapeHtml(v)}</div></div>`).join("");
        const prose = detailProse(h, r, ss);
        const spaceHTML = solutionSpaceHTML(h, ss);
        const badgesHTML = [tierBadge(r), ...completenessBadges(r)].map((badge) =>
            `<span class="pill" style="background:${badge.color}">${escapeHtml(badge.label)}</span>`).join("");
        const tieText = tied ? " · within the 0.05 display-score tie threshold" : "";
        return `
        <article class="solution-detail">
            <div class="solution-head">
                <div>
                    <h3>${escapeHtml(h.name)}</h3>
                    <div class="solution-sub">${escapeHtml(h.subtitle || "")}</div>
                </div>
                <span class="solution-pills">${badgesHTML}</span>
            </div>
            <div class="solution-order">#${groupIndex + 1} of ${groupSize} within ${escapeHtml(category.shortLabel)}${escapeHtml(tieText)}</div>
            <div class="solution-metrics">${statsHTML}</div>
            <p class="rank-basis"><strong>Why it is screened and ordered here:</strong> ${escapeHtml(rankingExplanation(h, r))}</p>
            <p class="solution-lead">${escapeHtml(prose.lead)}</p>
            <h4>How these numbers were derived</h4>
            <p>${prose.derived}</p>
            <h4>What constrains it — and its plausibility</h4>
            <p>${prose.constraint}</p>
            <h4>Where it sits in the solution space</h4>
            <p>${spaceHTML}</p>
        </article>`;
    }).join("");
}

// Truth-mode executive summary: every method ranked by mean 3D separation
// from the truth track, with the per-aspect deltas that the rank bases cite.
// Cross-group ordering is deliberate here — all methods are measured against
// the same external reference with the same metric.
function buildTruthSummaryHTML(rankedHyps, truth) {
    const comparable = rankedHyps
        .filter((item) => item.h.truthComparison?.comparable)
        .sort((a, b) => a.h.truthComparison.score - b.h.truthComparison.score);
    const notComparable = rankedHyps.filter((item) => item.h.truthComparison
        && !item.h.truthComparison.comparable);

    const rows = comparable.map(({h, category}, i) => {
        const tc = h.truthComparison;
        const altSide = Math.abs(tc.altitude.meanSigned) > 0.5 * tc.altitude.meanAbs
            ? (tc.altitude.meanSigned > 0 ? " ↑" : " ↓") : "";
        return `
        <tr${i === 0 ? ' class="best"' : ""}>
            <td>${i + 1}</td>
            <td>${escapeHtml(h.name)}</td>
            <td>${escapeHtml(category.shortLabel)}</td>
            <td>${escapeHtml(fmtSepMeters(tc.sep3D.mean))}</td>
            <td>${escapeHtml(fmtSepMeters(tc.sep3D.max))}</td>
            <td>${escapeHtml(fmtSepMeters(tc.horizontal.mean))}</td>
            <td>${escapeHtml(fmtSepMeters(tc.altitude.meanAbs))}${altSide}</td>
            <td>${tc.speed ? (tc.speed.meanAbsDiff / KNOTS_TO_MS).toFixed(0) : "—"}</td>
            <td>${tc.heading ? tc.heading.meanAbsDiff.toFixed(0) : "—"}</td>
        </tr>`;
    }).join("");

    const notCompHTML = notComparable.length
        ? `<p class="sub">Not comparable against the truth track: ${notComparable.map(({h}) =>
            `${escapeHtml(h.name)} (${escapeHtml(h.truthComparison.note || "insufficient overlap")})`).join("; ")}.</p>`
        : "";

    return `
    <h3>Closeness to the truth track "${escapeHtml(truth.label)}"</h3>
    <div class="tablebox">
    <table class="truthtab">
        <thead><tr>
            <th>#</th><th>Interpretation</th><th>Group</th>
            <th>Mean 3D sep</th><th>Max sep</th><th>Horiz offset</th>
            <th>Alt Δ</th><th>Speed Δ (kt)</th><th>Heading Δ (°)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>
    </div>
    <p class="sub">All methods measured against the same reference over the analysis window, ordered by mean 3D
    separation (this cross-group ordering is valid because the metric is external to every method's own
    assumptions). Alt Δ arrows mark a consistent bias above (↑) or below (↓) the truth. Speed and heading
    deltas use ~0.5 s smoothed motion; heading is only compared while both tracks are moving.</p>
    ${notCompHTML}`;
}

function buildReportHTML(ctx) {
    const {
        sitName, dataset, windText, speedTarget,
        sweep, fastProfile, slowProfile, aircraft,
        bestTrack, bestMetrics, slowBestRow, slowTrack,
        sweepBestMetrics = ctx.bestMetrics, constAirPick = null,
        closeLoM, closeHiM, hypotheses, provenance, failures = [], manifest = {},
        truth = null, terrainChangedDuringRun = false,
    } = ctx;
    const {n, fps, D} = dataset;
    const globalFrame0 = dataset.frame0 ?? 0;
    const globalFrame1 = dataset.frame1 ?? (globalFrame0 + n - 1);
    const durationS = (n - 1) / fps;
    const b = sweep.best;
    const bRaw = sweep.bestRaw ?? b;
    const ap = aircraft.params;

    // LOS az/el at first/last frame (ENU: az from North, clockwise)
    const azOf = (f) => {
        let az = Math.atan2(D[f * 3], D[f * 3 + 1]) * 180 / Math.PI;
        if (az < 0) az += 360;
        return az;
    };
    const elOf = (f) => Math.asin(Math.max(-1, Math.min(1, D[f * 3 + 2]))) * 180 / Math.PI;

    // ---- charts ----
    const chartA = sweepHeatmap(sweep);

    const profX = (p) => p.map((r) => toNM(r.startDist));
    const profY = (p) => p.map((r) => r.score);
    const fastBest = fastProfile.reduce((a2, b2) => (b2.score < a2.score ? b2 : a2));
    const chartB = lineChart({
        width: 940, height: 500, logY: true,
        title: "Required maneuvering vs assumed start range (smoothest plausible trajectory)",
        xLabel: "start range (NM)", yLabel: "score (lower = more plausible, log scale)",
        series: [
            {xs: profX(fastProfile), ys: profY(fastProfile), color: VIZ.fastObj,
                label: `fast object (target ${kt1(speedTarget)} kt)`},
            {xs: profX(slowProfile), ys: profY(slowProfile), color: VIZ.slowObj,
                label: "slow object (target 5 kt)"},
        ],
        markers: [
            {x: toNM(fastBest.startDist), y: fastBest.score, color: VIZ.fastObj,
                label: `min @ ${nm1(fastBest.startDist)} NM`},
            {x: toNM(slowBestRow.startDist), y: slowBestRow.score, color: VIZ.slowObj,
                label: `min @ ${nm1(slowBestRow.startDist)} NM`},
        ],
    });

    // time series: best const-air vs aircraft fit
    const tSec = Array.from({length: n}, (_, f) => f / fps);
    const bs = bestMetrics.series;
    const as = aircraft.series;
    const tsChart = (title, yLabel, yA, yB, transform = (v) => v) => lineChart({
        width: 620, height: 340, title, xLabel: "time (s)", yLabel,
        series: [
            {xs: tSec, ys: Array.from(yA, transform), color: VIZ.constAir,
                label: constAirPick ? "const air spd (slow valley)" : "const air spd (sweep best)"},
            {xs: tSec, ys: Array.from(yB, transform), color: VIZ.aircraft, label: "aircraft fit"},
        ],
    });
    const chartC1 = tsChart("Air speed", "air speed (kt)", bs.airSpeed, as.airSpeed, toKt);
    const chartC2 = tsChart("Kinematic acceleration", "acceleration (g)", bs.gLoad, as.gLoad);
    const chartC3 = tsChart("Turn rate", "turn rate (°/s)", bs.turnRate, as.turnRate);

    const chartD = planViewChart(dataset, [
        {track: bestTrack, color: VIZ.constAir,
            label: constAirPick
                ? `const air spd (slow valley): ${nm1(constAirPick.range)} NM @ ${kt1(constAirPick.airSpeed)} kt`
                : `const air spd: ${nm1(b.startDist)} NM @ ${kt1(b.speed)} kt`},
        {track: aircraft.track, color: VIZ.aircraft,
            label: `aircraft fit: ${nm1(ap.startDist)} NM, hdg ${ap.heading.toFixed(0)}°`},
        {track: slowTrack, color: VIZ.slowObj,
            label: `plausible slow object: ${nm1(slowBestRow.startDist)} NM`},
        ...(truth ? [{track: truth.track, color: VIZ.truth,
            label: `truth: ${truth.label}`}] : []),
    ]);

    // ---- executive summary ----
    const fastRegion = minRegion(fastProfile);
    const slowRegion = minRegion(slowProfile);
    const cLo = closeLoM ?? 6 * METERS_PER_NM;
    const cHi = closeHiM ?? 8 * METERS_PER_NM;
    const closeFast = bestRowInWindow(fastProfile, cLo, cHi);
    const closeSlow = bestRowInWindow(slowProfile, cLo, cHi);
    const closeLabel = `${nm1(cLo)}–${nm1(cHi)} NM`;
    const top = sweep.sorted.slice(0, 10);
    const topRangeLo = Math.min(...top.map((r) => r.startDist));
    const topRangeHi = Math.max(...top.map((r) => r.startDist));
    const topSpeedLo = Math.min(...top.map((r) => r.speed));
    const topSpeedHi = Math.max(...top.map((r) => r.speed));

    const closeRangeHTML = (closeFast && closeSlow) ? `
        <p><strong>The cost of proximity (${closeLabel}):</strong>
        Forcing the object to a start range of ${closeLabel}, even the most benign trajectory under the
        fast-object target needs an air speed peaking at
        <strong>${kt1(closeFast.metrics.airSpeed.max)} kt</strong>, with turn-rate spikes of
        <strong>${statSpike(closeFast.metrics.turnRate).toFixed(2)} °/s</strong> and kinematic acceleration up to
        <strong>${closeFast.metrics.gLoad.max.toFixed(2)} g</strong> (score ${closeFast.score.toFixed(2)}).
        Under the slow-object hypothesis (soft target ~5 kt) the smoothest ${closeLabel} solution still requires
        a peak air speed of <strong>${kt1(closeSlow.metrics.airSpeed.max)} kt</strong>, turn-rate spikes of
        <strong>${statSpike(closeSlow.metrics.turnRate).toFixed(2)} °/s</strong>, and up to
        <strong>${closeSlow.metrics.gLoad.max.toFixed(2)} g</strong> (score ${closeSlow.score.toFixed(2)}).
        This quantifies what an object at that range would have to do to stay consistent with the
        sightline data.</p>` : "";

    const sweepEdges = [];
    if (sweep.boundaryAxes?.range) {
        const loR = Math.min(...sweep.ranges), hiR = Math.max(...sweep.ranges);
        if (sweep.familyBand.rangeLo <= loR * 1.001) sweepEdges.push("lower range");
        if (sweep.familyBand.rangeHi >= hiR * 0.999) sweepEdges.push("upper range");
    }
    if (sweep.boundaryAxes?.speed) {
        const loV = Math.min(...sweep.speeds), hiV = Math.max(...sweep.speeds);
        if (sweep.familyBand.speedLo <= loV * 1.001) sweepEdges.push("lower speed");
        if (sweep.familyBand.speedHi >= hiV * 0.999) sweepEdges.push("upper speed");
    }
    // The regime pick can demote the fast sweep representative: say so right
    // where the sweep numbers appear, or the summary (fast NM/kt) and the
    // candidate card (slow NM/kt) would silently disagree under one name.
    const constAirDemotionHTML = constAirPick ? `
        <p><strong>Demoted:</strong> this fast-sweep representative was outscored by the slow-drift range
        valley. The reported <em>Constant Air Speed</em> candidate is
        <strong>${nm1(constAirPick.range)} NM / ${kt1(constAirPick.airSpeed)} kt</strong>
        (neutral score ${Number(constAirPick.slowScore ?? NaN).toFixed(2)} vs
        ${Number(constAirPick.fastScore ?? NaN).toFixed(2)}, lower is better); the time-series and
        plan-view charts show that selected slow representative.</p>` : "";
    const sweepResultHTML = (sweep.boundaryLimited ? `
        <p><strong>Constant-air-speed search incomplete at the ${escapeHtml(sweepEdges.join(" and ") || "tested")} boundary.</strong>
        A family spanning <strong>${nm1(sweep.familyBand.rangeLo)}–${nm1(sweep.familyBand.rangeHi)} NM</strong> and
        <strong>${kt1(sweep.familyBand.speedLo)}–${kt1(sweep.familyBand.speedHi)} kt</strong> scores similarly.
        The displayed <strong>${nm1(b.startDist)} NM / ${kt1(b.speed)} kt</strong> member is a deterministic,
        prior-selected representative; an edge value is a tested floor or ceiling, not an estimated optimum.
        Its full-resolution track reaches ${sweepBestMetrics.gLoad.rms.toFixed(2)} g RMS and
        ${sweepBestMetrics.gLoad.max.toFixed(2)} g maximum kinematic acceleration.</p>` : `
        <p>The constant-air-speed grid search selects a family representative at a start range of
        <strong>${nm1(b.startDist)} NM</strong> and <strong>${kt1(b.speed)} kt</strong> air speed
        (grid score ${b.score.toFixed(2)}). Its full-resolution displayed track reaches
        ${sweepBestMetrics.gLoad.rms.toFixed(2)} g RMS and
        <strong>${sweepBestMetrics.gLoad.max.toFixed(2)} g</strong> maximum kinematic acceleration. The raw score minimum is
        <strong>${nm1(bRaw.startDist)} NM / ${kt1(bRaw.speed)} kt</strong>
        (score ${bRaw.score.toFixed(2)}). The ten lowest-score grid cells fall
        between ${nm1(topRangeLo)}–${nm1(topRangeHi)} NM and ${kt1(topSpeedLo)}–${kt1(topSpeedHi)} kt.</p>`)
        + constAirDemotionHTML;

    const geometryHTML = `
        <p>Over <strong>${n}</strong> frames (${globalFrame0}–${globalFrame1}, ${durationS.toFixed(1)} s) the sensor's line of sight swept
        from azimuth ${azOf(0).toFixed(1)}° / elevation ${elOf(0).toFixed(1)}° to azimuth
        ${azOf(n - 1).toFixed(1)}° / elevation ${elOf(n - 1).toFixed(1)}° (wind: ${escapeHtml(windText)}).</p>`;

    // Metric-centric summary paragraphs (sweep / range profiles / aircraft fit /
    // cost of proximity). In truth mode these move out of the executive summary
    // — the summary is then about closeness to the truth track — while the
    // underlying detail sections (heatmap, profiles, time series) remain below.
    const metricsSummaryHTML = `
        <p>Lines of sight alone often do not uniquely determine a trajectory, so each analyzer below asks a different
        question of the same data; the interesting output is the <em>family</em> of plausible solutions and the
        maneuvering cost of everything else.</p>

        ${sweepResultHTML}

        <p>Sweeping the globally smoothest LOS-riding trajectory across assumed start ranges: the fast-object
        profile (soft target ${kt1(speedTarget)} kt) reaches its minimum at
        <strong>${nm1(fastRegion.best.startDist)} NM</strong>, with scores within 1.5× of that minimum
        across <strong>${nm1(fastRegion.loM)}–${nm1(fastRegion.hiM)} NM</strong>. The slow-object profile
        (soft target 5 kt) reaches its minimum at <strong>${nm1(slowRegion.best.startDist)} NM</strong>
        (region ${nm1(slowRegion.loM)}–${nm1(slowRegion.hiM)} NM).</p>

        <p>The parametric fixed-wing fit (constant horizontal airspeed, slowly varying turn rate, constant climb, advected by
        the wind) returned its lowest-cost deterministic solution at a start range of <strong>${nm1(ap.startDist)} NM</strong>, heading
        <strong>${ap.heading.toFixed(1)}° in the sensor-origin ENU frame</strong>, horizontal airspeed <strong>${kt1(ap.tas)} kt</strong>,
        turn rate ${ap.turnRate.toFixed(3)} °/s, climb ${fpm0(ap.climb)} fpm, with a mean LOS error of
        <strong>${aircraft.errDeg.toFixed(3)}°</strong>.</p>
        ${closeRangeHTML}`;

    // ---- candidate-interpretation gallery, comparison, verdict ----
    const rankedGroups = groupAndRankHypotheses(hypotheses);
    const rankedHyps = rankedGroups.flatMap((group) => group.items);
    const cardsHTML = rankedGroups.map((group) => {
        const cards = group.items.map(({h, r, tied, groupIndex, groupSize}) => {
            const thumb = hypothesisThumbnail(dataset, h);
            const statsHTML = hypothesisStats(h).map(([k, v]) =>
                `<div class="st"><div class="stk">${escapeHtml(k)}</div>` +
                `<div class="stv">${escapeHtml(v)}</div></div>`).join("");
            const badgesHTML = [tierBadge(r), ...completenessBadges(r)].map((badge) =>
                `<span class="pill" style="background:${badge.color}">${escapeHtml(badge.label)}</span>`).join("");
            const tieText = tied ? " · display-score tie" : "";
            return `
            <div class="card">
                <div class="card-h">
                    <span class="card-name">${escapeHtml(h.name)}</span>
                    <span class="card-pills">${badgesHTML}</span>
                </div>
                <div class="card-sub">${escapeHtml(h.subtitle)}</div>
                <div class="card-order">#${groupIndex + 1} of ${groupSize} within ${escapeHtml(group.shortLabel)}${escapeHtml(tieText)}</div>
                <img class="card-thumb" src="${thumb}" alt="Overhead view of the ${escapeHtml(h.name)} trajectory">
                <div class="card-stats">${statsHTML}</div>
                <p class="rank-basis"><strong>Rank basis:</strong> ${escapeHtml(rankingExplanation(h, r))}</p>
            </div>`;
        }).join("");
        return `<div class="candidate-group"><h3>${escapeHtml(group.label)}</h3>` +
            `<p class="sub">${escapeHtml(group.description)}</p><div class="cards">${cards}</div></div>`;
    }).join("");

    // Compact residual for the comparison table — the full string (with the
    // generic-reference multiplier) is on every candidate card; repeating it
    // here made the column, and the table, wider than the page.
    const losErrShort = (h) => {
        const err = h?.errDeg;
        if (!Number.isFinite(err)) return "—";
        return err < 0.1 ? `${err.toFixed(3)}°` : `${err.toFixed(2)}°`;
    };
    const compRows = rankedHyps.map(({h, r, category, groupIndex}) => {
        const m = h.metricsFull;
        const tc = h.truthComparison;
        const truthCell = truth
            ? `<td>${tc?.comparable ? escapeHtml(fmtSepMeters(tc.sep3D.mean)) : "n/a"}</td>`
            : "";
        return `
        <tr${r.rank >= 3 ? ' class="best"' : ""}>
            <td>${escapeHtml(category.shortLabel)}</td>
            <td>${groupIndex + 1}</td>
            <td>${escapeHtml(h.name)}</td>
            <td>${nm1(m.range.min)}–${nm1(m.range.max)}</td>
            <td>${kt1(m.airSpeed.mean)}</td>
            <td>${(Math.abs(m.altitude.mean) < 15.24 ? 0 : m.altitude.mean / 304.8).toFixed(1)}</td>
            <td>${fpm0(m.verticalSpeed.mean)}</td>
            <td>${m.gLoad.max.toFixed(2)}</td>
            <td>${escapeHtml(losErrShort(h))}</td>
            ${truthCell}
            <td><span class="pill" style="background:${r.color}">${escapeHtml(r.label)}</span></td>
        </tr>`;
    }).join("");

    const verdictHTML = buildVerdict(hypotheses, provenance, truth);
    const truthSummaryHTML = truth ? buildTruthSummaryHTML(rankedHyps, truth) : "";
    const reportSS = analyzeSolutionSpace({dataset, fastProfile});
    const solutionDetailsHTML = buildReportHypothesisDetails(dataset, rankedHyps, reportSS);

    // ---- tables ----
    const sweepRows = top.map((r, i) => `
        <tr${i === 0 ? ' class="best"' : ""}>
            <td>${i + 1}</td><td>${nm1(r.startDist)}</td><td>${kt1(r.speed)}</td>
            <td>${r.score.toFixed(3)}</td>
            <td>${r.metrics.gLoad.rms.toFixed(3)}</td><td>${r.metrics.gLoad.max.toFixed(3)}</td>
            <td>${r.metrics.turnRate.std.toFixed(2)}</td>
            <td>${fpm0(r.metrics.verticalSpeed.mean)}</td>
            <td>${r.spdErr !== undefined ? kt1(r.spdErr) : "—"}</td>
        </tr>`).join("");

    const runRows = aircraft.runs.map((r, i) => `
        <tr${i === 0 ? ' class="best"' : ""}>
            <td>${i + 1}</td><td>${r.cost.toFixed(2)}</td><td>${nm1(r.startDist)}</td>
            <td>${r.heading.toFixed(1)}</td><td>${kt1(r.tas)}</td>
            <td>${r.turnRate.toFixed(3)}</td><td>${r.turnAccel.toFixed(4)}</td>
            <td>${fpm0(r.climb)}</td>
            <td>${r.de?.seed !== undefined ? `0x${r.de.seed.toString(16).padStart(8, "0")}` : "—"}</td>
            <td>${r.de?.evaluations ?? "—"}</td>
            <td>${escapeHtml(`${r.de?.stopReason ?? "unknown"} / ${r.polishStopReason ?? "unknown"}`)}</td>
        </tr>`).join("");
    const manifestJSON = escapeHtml(JSON.stringify(manifest, null, 2));

    // ---- footer / version ----
    let version = "";
    try { version = process.env.BUILD_VERSION_STRING || ""; } catch (e) { version = ""; }

    const scoreNote = "score = 4·g<sub>RMS</sub> + g<sub>max</sub> + 0.05·turn σ " +
        "+ 0.02·max(0, |VS<sub>mean</sub>|−5) + 0.2·((v−v<sub>target</sub>)/250 kt)² " +
        "+ (speed-hold error/10 kt)² — lower is a better match to this heuristic";

    const fileName = "Traverse-Analysis-" +
        String(sitName).replace(/[^A-Za-z0-9._-]+/g, "_") + ".html";

    const downloadScript =
        '<script>\n' +
        'document.getElementById("dl-report").addEventListener("click", function () {\n' +
        '    var html = "<!DOCTYPE html>\\n" + document.documentElement.outerHTML;\n' +
        '    this.href = URL.createObjectURL(new Blob([html], {type: "text/html"}));\n' +
        '});\n' +
        '<\/script>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traverse Analysis — ${escapeHtml(sitName)}</title>
<style>
:root { color-scheme: dark; }
body { background: #0d0f12; color: #d8dce2; margin: 0; padding: 32px 20px;
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width: 1020px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px 0; color: #e8eaed; }
h2 { font-size: 18px; margin: 40px 0 12px 0; color: #e8eaed;
    border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; }
.sub { color: #8a9099; font-size: 13px; margin-bottom: 20px; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px; margin: 18px 0; }
.meta > div { background: #14161a; border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 10px 12px; }
.meta .k { font-size: 11px; color: #8a9099; text-transform: uppercase; letter-spacing: 0.05em; }
.meta .v { font-size: 15px; color: #e8eaed; font-variant-numeric: tabular-nums; margin-top: 2px; }
figure { margin: 16px 0; background: #14161a; border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 12px; }
figure img { width: 100%; height: auto; display: block; border-radius: 4px; }
figcaption { font-size: 13px; color: #8a9099; margin-top: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; }
.row figure { flex: 1 1 300px; margin: 0; min-width: 280px; }
.tablebox { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px;
    font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; text-align: right;
    border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
/* Headers may wrap onto two lines ("Horizontal / airspeed (kt)") so a long
   unit-bearing header never forces its column wider than the values need —
   that, not the data, is what made tables overflow into scrollbars. */
th { color: #8a9099; font-weight: 600; white-space: normal; vertical-align: bottom; }
td:first-child, th:first-child { text-align: left; }
tr.best td { color: #e8eaed; font-weight: 600; }
.summary p, .methods p { max-width: 78ch; }
strong { color: #e8eaed; }
a { color: #3987e5; }
footer { margin-top: 44px; color: #8a9099; font-size: 13px;
    border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;
    display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 14px; margin: 18px 0; }
.candidate-group { margin: 26px 0 34px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
.candidate-group h3 { color:#dce3eb; font-size:16px; margin:0 0 3px; }
.card { background: #14161a; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
    padding: 12px; display: flex; flex-direction: column; }
.card-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-name { font-weight: 700; color: #e8eaed; font-size: 15px; }
.card-pills, .solution-pills { display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end; }
.card-sub { color: #8a9099; font-size: 12px; margin: 3px 0 9px 0; }
.card-order, .solution-order { color:#7fb0ee; font-size:12px; margin:0 0 9px; }
.card-thumb { width: 100%; height: auto; display: block; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.06); }
.card-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; margin-top: 11px; }
.st { display: flex; flex-direction: column; }
.stk { font-size: 10.5px; color: #8a9099; text-transform: uppercase; letter-spacing: 0.04em; }
.stv { font-size: 13px; color: #e8eaed; font-variant-numeric: tabular-nums; margin-top: 1px; }
.solution-detail { margin: 22px 0 34px 0; padding-bottom: 28px;
    border-bottom: 1px solid rgba(255,255,255,0.08); }
.solution-detail figure { margin: 14px 0 16px 0; }
.solution-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.solution-head h3 { margin: 0; color: #e8eaed; font-size: 17px; line-height: 1.25; }
.solution-sub { color: #8a9099; font-size: 13px; margin-top: 3px; }
.solution-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px 14px; margin: 12px 0; padding: 11px; background: #15181d; border-radius: 8px; }
.solution-series { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.solution-series img { flex: 1 1 30%; min-width: 260px; max-width: 100%; height: auto;
    border-radius: 6px; border: 1px solid rgba(255,255,255,0.06); }
.solution-lead { color: #e0e4ea; font-size: 15px; }
.rank-basis { color:#c7ced7; font-size:13px; line-height:1.5; padding:9px 11px;
    background:#171b20; border-left:3px solid #7fb0ee; border-radius:5px; }
.solution-detail h4 { color: #7fb0ee; font-size: 11.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; margin: 18px 0 5px 0; }
.solution-detail p { max-width: 78ch; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px;
    font-weight: 700; color: #0d0f12; white-space: nowrap; }
td .pill { color: #0d0f12; }
table.comp td:nth-child(3), table.comp th:nth-child(3),
table.truthtab td:nth-child(2), table.truthtab th:nth-child(2),
table.truthtab td:nth-child(3), table.truthtab th:nth-child(3) { text-align: left; }
.warning { margin: 16px 0; padding: 12px 14px; border-radius: 8px;
    background: #4a3a12; color: #ffd479; border: 1px solid #8a6d2a; }
details.manifest { background:#14161a; border:1px solid rgba(255,255,255,0.08);
    border-radius:8px; padding:10px 12px; }
details.manifest summary { cursor:pointer; color:#e8eaed; font-weight:600; }
details.manifest pre { white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.45 ui-monospace, monospace;
    color:#b9bfc7; }
</style>
</head>
<body>
<div class="wrap">
<header>
    <h1>Traverse Analysis — ${escapeHtml(sitName)}</h1>
    <div class="sub">Generated ${escapeHtml(new Date().toLocaleString())}</div>
    <div class="meta">
        <div><div class="k">Frame range</div><div class="v">${globalFrame0}–${globalFrame1}</div></div>
        <div><div class="k">Frames</div><div class="v">${n} @ ${fps} fps</div></div>
        <div><div class="k">Duration</div><div class="v">${durationS.toFixed(1)} s</div></div>
        <div><div class="k">LOS azimuth</div><div class="v">${azOf(0).toFixed(1)}° → ${azOf(n - 1).toFixed(1)}°</div></div>
        <div><div class="k">LOS elevation</div><div class="v">${elOf(0).toFixed(1)}° → ${elOf(n - 1).toFixed(1)}°</div></div>
        <div><div class="k">Wind used</div><div class="v">${escapeHtml(windText)}</div></div>
        <div><div class="k">Speed target</div><div class="v">${kt1(speedTarget)} kt</div></div>
        ${truth ? `<div><div class="k">Truth track</div><div class="v">${escapeHtml(truth.label)}</div></div>` : ""}
        <div><div class="k">Analysis coverage</div><div class="v">${hypotheses.filter((h) => h.track).length} results · ${failures.length} failed/unavailable</div></div>
    </div>
</header>

${provenance?.circular ? `<div class="warning"><strong>Constructed LOS — validation only.</strong> ` +
    `${escapeHtml(provenance.reason)} Fits below test internal consistency, not independent object inference.</div>` : ""}

${provenance?.measuredSubstituted ? `<div class="warning" style="background:#16321f;color:#9fd8ae;border-color:#2f6a42">` +
    `<strong>Measured sensor LOS used.</strong> ${escapeHtml(provenance.substitutionNote ?? "")}</div>` : ""}

${provenance?.rangeUnobservable ? `<div class="warning" style="background:#4a1512;color:#ffab9e;border-color:#a03a2e">` +
    `<strong>⛔ Range is NOT determined by this evidence.</strong> The sensor's motion over the analysis ` +
    `window (baseline ${Math.round(provenance.sensorSpan ?? 0)} m) is negligible at the assumed working ` +
    `distance: the sightlines contain no usable parallax, every distance along them fits equally well, ` +
    `and each method's range reflects its own priors, not measurement.</div>` : ""}

${truth ? `<div class="warning" style="background:#3a1e2e;color:#f4a6cd;border-color:#7a3b5c">` +
    `<strong>Truth track "${escapeHtml(truth.label)}" selected.</strong> Every method is scored and ` +
    `ordered by its mean 3D separation from this reference track; the usual screening metrics are ` +
    `shown as context only.</div>` : ""}

<section class="summary">
    <h2>Executive summary</h2>
    <p><strong>Overall interpretation.</strong> ${verdictHTML}</p>
    ${geometryHTML}
    ${truth ? truthSummaryHTML : metricsSummaryHTML}
    ${failures.length ? `<p><strong>Unavailable checks:</strong> ${failures.map((f) =>
        `${escapeHtml(f.method)} (${escapeHtml(f.error)})`).join("; ")}.</p>` : ""}
    ${terrainChangedDuringRun ? `<p><strong>Terrain note:</strong> elevation data finished loading while this
        analysis ran. Results use the elevation sampled during the run and are unlikely to be materially affected;
        re-run once terrain has settled if you need the ground samples exact.</p>` : ""}
</section>

<section>
    <h2>Run audit manifest</h2>
    <p class="sub">Frozen headline inputs, effective timing, search bounds, completeness flags, optimizer seeds,
    termination metadata, and check coverage for this run. This is an audit summary, not a self-contained input archive;
    source files, full wind/terrain fields, and the exact application revision must also be retained for reproduction.</p>
    <details class="manifest"><summary>Show machine-readable manifest</summary><pre>${manifestJSON}</pre></details>
</section>

<section>
    <h2>Candidate interpretations</h2>
    <p class="sub">Panels include trajectory constraints, fitting algorithms, and forward physical models;
    they are not independent object identifications and there is no global winner. Each path is shown against the same
    sightlines and ordered only within its comparison group. Screening pills summarize maneuvering, peak speed,
    completeness, active model limits, and raw LOS residual under the stated assumptions.</p>
    ${cardsHTML}
</section>

<section>
    <h2>Candidate details</h2>
    <p class="sub">Expanded derivation, constraints, and solution-space notes for each candidate above.
    Repeated per-candidate charts are omitted here; the shared comparison plots and full-resolution series below
    provide the same evidence on common axes without duplicating dozens of large images.</p>
    ${solutionDetailsHTML}
</section>

<section>
    <h2>Comparison</h2>
    <div class="tablebox">
    <table class="comp">
        <thead><tr>
            <th>Group</th><th>#</th><th>Interpretation</th><th>Range (NM)</th><th>Air spd (kt)</th><th>Alt (kft)</th>
            <th>Climb (fpm)</th><th>Max accel (g)</th><th>Raw LOS residual</th>${truth ? "<th>Truth Δ</th>" : ""}<th>Screen</th>
        </tr></thead>
        <tbody>${compRows}</tbody>
    </table>
    </div>
    ${truth ? `<p class="sub">Grouped first, then ordered by mean 3D separation from the truth track
    ("Truth Δ" — the quantity that controls order); the screening tier is context only. Rows passing the
    broad screen are highlighted. Alt and air speed are means; max accel is kinematic. The candidate cards
    above give each LOS residual against the generic reference.</p>` : `<p class="sub">Grouped first, then ordered by completeness, broad screening tier, and within-group score.
    No order across groups is implied. Rows passing the broad screen are highlighted. Alt and air speed are means;
    max accel is kinematic. Each candidate card above states the rank basis that actually controls its order,
    and gives its LOS residual against the generic reference.</p>`}
</section>

<section>
    <h2>Details</h2>
    <p class="sub">The full sweep heatmap, range profile, best-solution time series, combined plan view,
    and solution tables behind the gallery above.</p>
</section>

<section>
    <h2>Constant-air-speed sweep</h2>
    <figure>
        <img src="${chartA}" alt="Heatmap of plausibility score over start range and air speed">
        <figcaption>Score for every (start range, air speed) combination of the constant-air-speed
        traverse; log color scale — darker = lower score = more plausible. ${scoreNote}.</figcaption>
    </figure>
</section>

<section>
    <h2>Range profile</h2>
    <figure>
        <img src="${chartB}" alt="Score versus assumed start range for fast and slow object hypotheses">
        <figcaption>For each assumed start range, the score of the globally smoothest LOS-riding
        trajectory (B-spline, soft speed target). A flat-bottomed valley means the data cannot
        distinguish ranges within it; steep walls show ranges the data punishes.</figcaption>
    </figure>
</section>

<section>
    <h2>Selected constant-air representative: time series</h2>
    <div class="row">
        <figure><img src="${chartC1}" alt="Air speed time series"></figure>
        <figure><img src="${chartC2}" alt="G-load time series"></figure>
        <figure><img src="${chartC3}" alt="Turn rate time series"></figure>
    </div>
    <figure style="background:none;border:none;padding:0">
        <figcaption>Per-frame physical demands of the selected constant-air-speed family representative and the
        aircraft fit. Values near the clip ends use shortened smoothing windows.</figcaption>
    </figure>
</section>

<section>
    <h2>Plan view</h2>
    <figure>
        <img src="${chartD}" alt="Plan view of sensor path, lines of sight, and candidate trajectories">
        <figcaption>Local East/North (NM), equal aspect. Filled dot = start of each path, open
        circle = end.</figcaption>
    </figure>
</section>

<section>
    <h2>10 lowest-score constant-air grid cells</h2>
    <div class="tablebox">
    <table>
        <thead><tr>
            <th>#</th><th>Range (NM)</th><th>Speed (kt)</th><th>Score</th>
            <th>g RMS</th><th>g max</th><th>Turn σ (°/s)</th>
            <th>VS mean (fpm)</th><th>Speed-hold err (kt)</th>
        </tr></thead>
        <tbody>${sweepRows}</tbody>
    </table>
    </div>
</section>

<section>
    <h2>Aircraft fit runs</h2>
    <div class="tablebox">
    <table>
        <thead><tr>
            <th>Run</th><th>Cost</th><th>Range (NM)</th><th>Heading (ENU °)</th>
            <th>Horizontal airspeed (kt)</th><th>Turn (°/s)</th><th>Turn accel (°/s²)</th>
            <th>Climb (fpm)</th><th>Seed</th><th>DE evals</th><th>Stop (DE / polish)</th>
        </tr></thead>
        <tbody>${runRows}</tbody>
    </table>
    </div>
    <p class="sub">Deterministically seeded differential-evolution restarts, each polished with a pattern search.
    Agreement is a useful stability diagnostic, but is not proof of global convergence.</p>
</section>

<section class="methods">
    <h2>Method notes</h2>
    <p><strong>Constant-air-speed sweep.</strong> Solves a smoothed spline-QP trajectory over a grid of start
    ranges and air speeds, scoring each track by flight smoothness and speed fidelity. Applying a card installs
    that exact solved track as an analysis-result snapshot; it does not substitute the legacy sequential ray walker.</p>
    <p><strong>Plausible traverse &amp; range profile.</strong> For a given start range, solves for the
    smoothest trajectory that stays exactly on every line of sight, as a B-spline in range-along-ray,
    minimizing squared acceleration with a soft airspeed target (iteratively reweighted least squares).
    Swept over range, this shows how much maneuvering each assumed distance <em>requires</em> — a lower
    bound no real object at that range can beat.</p>
    <p><strong>Aircraft fit.</strong> Fits a simple fixed-wing model — constant horizontal airspeed through the air
    mass, linearly varying turn rate, constant climb, positions advected by the wind — by differential
    evolution plus pattern-search polish. The cost blends LOS angular error with loose penalties for
    turning, climbing, and straying from the preferred speed.</p>
    <p><strong>Forward physical models.</strong> Several interpretations are forward-integrated models fit
    to the sightlines rather than paths pinned to the rays:
    the fixed-wing aircraft (constant horizontal airspeed, slowly varying turn rate, constant climb); the sky
    lantern / balloon (a wind tracer: horizontal velocity equals the bounded altitude-sheared wind — which may
    also vary smoothly across the clip — with a rise / buoyancy-decay / terminal-sink vertical life cycle);
    the quadcopter (a hover-capable multirotor, free ground speed and steep climb within a bounded envelope);
    and the drone flown-inputs fit (the same object described as a few held control inputs, priced by control
    effort rather than path shape). Because none is forced onto the lines of sight, each leaves a training
    residual. Those residuals are not object-type probabilities and are not directly comparable without
    accounting for parameter count, priors, bounds, wind freedom, and measurement covariance. A flexible
    constant-acceleration residual is shown only as a generic reference; it combines pointing error and model
    mismatch and is not a sensor-noise estimate.</p>
    <p><strong>Scoring.</strong> The plausibility <em>priors</em> — a preferred speed, roughly level flight,
    low g — are deliberately <em>soft</em>, so LOS-only data (which admits infinitely many exact solutions) is
    characterized as a plausible family rather than a unique answer. The physical models additionally carry
    <em>hard</em> parameter and search bounds (range, speed, climb, turn envelopes); a solution resting on one
    of those bounds is flagged, because there the bound, not the data, is shaping the result.
    Metrics use ~0.5 s central differences, so scores reflect sustained maneuvering, not solver noise.</p>
</section>

<footer>
    <div>Generated by Sitrec Traverse Analysis${version ? " — " + escapeHtml(version) : ""}</div>
    <div><a id="dl-report" href="#" download="${escapeHtml(fileName)}">Download this report</a></div>
</footer>
</div>
${downloadScript}
</body>
</html>`;
}
