// exportInterchange.js — write a BotScenario as the generic BOT interchange
// file set, so algorithms outside Sitrec can be run against these scenarios
// and scored against the same truth.
//
// THREE FOLDERS per release (spec: benchmarks/botbench/BOT-Interchange-Format.html):
//
//   Input/<name>.input.csv       sensor positions + LOS unit vectors + declared
//                                error. THE CHALLENGE.
//   Input/<name>.scenario.json   ENU origin, datum, surface model, epoch, timing
//   Truth/<name>.truth.csv       true positions on the same time grid
//   Truth/<name>.truth.json      object class, events, realized noise, geometry
//   All/<name>.all.csv           input.csv and truth.csv joined column-wise
//   All/<name>.scenario.json     copies of both sidecars, so All/ is self-
//   All/<name>.truth.json        contained
//
// With opts.sidecarDir (the botset trees pass "meta") the two sidecars move to
// one shared folder instead and the All/ duplicates are not written:
//
//   Input/<name>.input.csv       Truth/<name>.truth.csv    All/<name>.all.csv
//   meta/<name>.scenario.json    meta/<name>.truth.json
//
// That trades folder-level blinding for a tidier tree, so it is for LOCAL
// benchmark sets only. A sealed release keeps the default layout.
//
// All/ IS ANSWER-KEY MATERIAL. It carries TruePosition columns, so it ships
// with Truth/ and never with Input/. The convenience of one row per frame with
// the answer beside the measurement is exactly what makes it unshippable to an
// entrant. A sealed release puts Input/ under challenge/ and both All/ and
// Truth/ under answers/.
//
// v1.2 CHANGES FROM v1.1. One measurement column and two sidecar fields, all
// additive — a v1.1 reader that selects columns by NAME reads a v1.2 file
// unchanged, and the major version is untouched because nothing already there
// means anything different.
//
//   AngularDiameterMaxDeg  (input.csv, all.csv) an UPPER BOUND on the target's
//                  observed angular diameter, degrees. With a minimum plausible
//                  diameter for an assumed object class it gives a range FLOOR,
//                  R >= D_min / theta. It is the only quantity in the format
//                  that opposes the scale degeneracy described at the top of the
//                  spec. Blank where the scenario declares no target size.
//   sensor.pixelsAcross    (scenario.json) frame width in pixels, the resolution
//                  the bound was computed against — its floor is one IFOV, so a
//                  consumer assuming a different sensor misreads how tight it is.
//   objectDiameterM        (truth.json) the TRUE physical diameter. Answer-key
//                  material: the challenge file publishes only the bound.
//
// v1.1 CHANGES FROM v1.0. Column names are frame-neutral (X/Y/Z rather than
// E/N/U, with the axis mapping declared in scenario.json), the Valid and
// MinRange columns are gone, and truth carries position only:
//
//   Valid       -> scenario.json invalidFrames[]. The column had to be read to
//                  know a row was out of frame; the row itself is still there,
//                  because deleting it would break the uniform time grid.
//   MinRange    -> nothing. It was blank in every shipped scenario anyway, and
//                  the floor that keeps a solver off the sensor is the SOLVER's
//                  business, not a property of the measurements.
//   TruthVel*   -> nothing. It was a central difference of the position column
//                  a consumer already has; publishing a derived quantity as if
//                  it were measured truth invited scoring against it.
//
// NAMING. Default names are descriptive of the setup and its numbers:
//
//   orbit-70ms-3000m_r5km_60s-10fps_partyneutral-500m_wfixed_white0p03deg_s101
//
// which is what you want while developing and eyeballing results. Note that
// such a name IS truth leakage — it names the target family, its altitude and
// the wind. For a sealed public challenge set, pass {basename, trackId} to
// override with an opaque id (bot-0001); the driver then writes the
// opaque -> descriptive mapping into the truth directory, so the answer key
// stays recoverable without the challenge set advertising it.
// See interchange.bench.test.js (BOTBENCH_OPAQUE=1).
//
// PRECISION. Every float is written with String(x), which in ECMAScript is the
// shortest decimal string that round-trips to the same float64. ENU positions
// span tens of km and the CV/stationary solves difference near-equal large
// values — LOSFitting.js documents float32's 0.5-4 m quantization at those
// magnitudes as the largest error source in an otherwise double-precision
// pipeline. A %.6f CSV writer would reintroduce exactly that error.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import {WIND_CONFIGS} from "./wind";
import {angularDiameterMaxDeg, SENSOR_PIXELS} from "./angularSize";

export const INTERCHANGE_SPEC_VERSION = "1.2";

// ---------------------------------------------------------------------------
// Integrity commitments
// ---------------------------------------------------------------------------

// input.csv is public by definition, so a plain digest is right: an entrant
// must be able to verify the challenge file they scored against is the one
// everybody else got.
export function sha256(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

// Truth commitments MUST be salted. A plain sha256 of truth.csv is NOT a
// commitment when the generator is public: the spec space is small and fully
// enumerable (blocks.js is 855 scenarios), so an entrant generates every
// candidate, hashes each truth, and matches the published digest to recover
// the exact spec. HMAC under a release secret that is withheld until scoring
// removes the precomputation; releasing the salt with the answers lets anyone
// verify after the fact that truth was fixed in advance.
export function saltedCommit(text, saltHex) {
    return crypto.createHmac("sha256", Buffer.from(saltHex, "hex"))
        .update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Descriptive naming
// ---------------------------------------------------------------------------

// 5000 -> "5km", 1500 -> "1p5km", 800 -> "800m"
function fmtRange(m) {
    if (m == null) return "rNA";
    if (m >= 1000) {
        const km = m / 1000;
        return `r${String(Number(km.toFixed(3))).replace(".", "p")}km`;
    }
    return `r${Math.round(m)}m`;
}

// Decimal points are replaced with "p" so a name never carries a bare "." —
// the only dots in a filename are the extension separators.
function num(x) {
    return String(Number(Number(x).toFixed(4))).replace(".", "p").replace("-", "neg");
}

function platformPart(p) {
    const kind = p.kind.replace(/-/g, "");
    const bits = [kind];
    if (p.rangeErrorFactor != null) bits.push(`e${num(p.rangeErrorFactor)}`);
    if (p.speedMS != null) bits.push(`${num(p.speedMS)}ms`);
    if (p.altitudeAGL != null) bits.push(`${num(p.altitudeAGL)}m`);
    return bits.join("-");
}

function targetPart(t) {
    const params = t.parameters ?? {};
    if (t.kind === "anomalous") {
        const id = (params.tupleId ?? "unknown").replace(/-/g, "");
        return `${params.anomalous === false ? "ctrl" : "anom"}-${id}`;
    }
    const kind = t.kind.replace(/-/g, "");
    if (t.family === "real") {
        // Real-segment targets are named by their scenario label; the
        // anomalous flag is part of the truth, so it is part of the name
        // (anom- for the spliced member, ctrl- for its raw-segment twin).
        const label = String(params.label ?? "segment").replace(/[^a-z0-9]/gi, "").toLowerCase();
        // First 8 hex chars of the source-file sha (the segmentKey prefix):
        // two same-labelled segments from different files/windows must not
        // share a name (audit F8).
        const src = String(params.segmentKey ?? "").slice(0, 8) || "nosrc";
        if (params.anomalous === true) return `anom-real-${label}-${src}`;
        if (params.paired === true) return `ctrl-real-${label}-${src}`;
        return `real-${label}-${src}`;
    }
    if (t.family === "maneuver") {
        // The anomalous flag is part of the truth (truth.json reads it from
        // the spec), so it must be part of the name — an anomalous member and
        // its mundane twin share kind and seed, and without a marker the twin
        // would silently overwrite it. Same anom/ctrl vocabulary as the
        // anomaly tuples: anom- when anomalous; ctrl- when a shape whose
        // DEFAULT is anomalous is generated with mundane parameters; bare
        // name for naturally mundane shapes.
        // eslint-disable-next-line global-require
        const {MANEUVER_ANOMALOUS} = require("./maneuverTargets");
        const dflt = MANEUVER_ANOMALOUS[t.kind] ?? false;
        const resolved = params.anomalous ?? dflt;
        // Variant label (M1 parameter sweeps): two variants of one kind are
        // different truths and must not share a name. Hyphens survive — they
        // are the in-field sub-part separator.
        const v = params.variant
            ? `-${String(params.variant).replace(/[^a-z0-9-]/gi, "").toLowerCase()}`
            : "";
        if (resolved) return `anom-${kind}${v}`;
        if (dflt) return `ctrl-${kind}${v}`;
        return kind + v;
    }
    if (params.startAGL != null) return `${kind}-${num(params.startAGL)}m`;
    return kind;
}

function observationPart(o) {
    if (o.kind === "clean") return "clean";
    // PERCENT-OF-FOV LADDERS NAME THEMSELVES BY THE RUNG, not by the angle it
    // resolved to. The field of view varies per scenario, so one rung produces
    // a different absolute amplitude in every variant, and naming by degrees
    // would give the same rung a different suffix in every file — destroying
    // the property that a variant's error levels differ ONLY by their folder.
    // The degrees are still published, in scenario.json's losError.
    if (o.pctOfFov != null) return `${o.kind}${num(o.pctOfFov)}pct`;
    if (o.kind === "white") {
        // A matched-white member's sigma is set from its partner's realized
        // RMS, so name it by that instead of the (absent) requested sigma.
        if (o.matchedRealizedRmsDeg != null) return `matchwhite${num(o.matchedRealizedRmsDeg)}deg`;
        return `white${num(o.gaussianSigmaDeg)}deg`;
    }
    if (o.kind === "wobble") return `wobble${num(o.wobble?.amplitude ?? 0)}deg`;
    // The angle REACHED at the end of the clip, which is what the drift level
    // means. Without it the two non-zero levels of a set share a basename and
    // are told apart only by which folder they sit in.
    if (o.kind === "drift") return `drift${num(o.driftDeg ?? 0)}deg`;
    return o.kind;
}

/**
 * Descriptive basename for a scenario spec. Stable for a given spec+seed, so
 * regenerating overwrites in place rather than accumulating near-duplicates.
 * The TARGET leads: a directory listing sorts into "what is it" first
 * (anom-zigzag, straightca, ...), with the observing geometry after it.
 */
export function scenarioBaseName(spec, scenarioSeed) {
    return [
        targetPart(spec.target),
        platformPart(spec.platform),
        fmtRange(spec.initialHorizontalRangeM),
        `${num(spec.durationSeconds)}s-${num(spec.fps)}fps`,
        `w${(spec.wind.kind ?? spec.wind).replace(/-/g, "")}`,
        observationPart(spec.observation),
        `s${scenarioSeed}`,
    ].join("_");
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

// Shortest round-trip decimal. -0 is normalized to 0 so a diff of two runs is
// not noise; non-finite values are written as an empty field (the spec's
// missing-value representation) rather than "NaN".
function f(x) {
    if (x == null || !Number.isFinite(x)) return "";
    return Object.is(x, -0) ? "0" : String(x);
}

function csv(header, rows) {
    return `${header.join(",")}\n${rows.map((r) => r.join(",")).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Declared LOS error model
// ---------------------------------------------------------------------------

// What the ANALYST is told about the sensor, as distinct from what the
// generator actually drew (that lives in truth.json). For the wobble model
// there is no white 1-sigma: the error is a seeded random walk with
// reaction-delayed recentering, so the declared scale is the operator deadband
// amplitude and the model is flagged "correlated". Treating it as white is
// precisely the mistake the MATCHED-NOISE block exists to expose.
function declaredLosError(obsSpec) {
    if (obsSpec.kind === "clean") {
        return {model: "none", sigmaDeg: 0, correlated: false};
    }
    if (obsSpec.kind === "white") {
        const sigma = obsSpec.matchedRealizedRmsDeg != null
            ? obsSpec.matchedRealizedRmsDeg / Math.SQRT2
            : obsSpec.gaussianSigmaDeg;
        return {
            model: "white", sigmaDeg: sigma, correlated: false,
            note: "per-axis 1-sigma in the pan/tilt tangent plane; "
                + "total angular RMS = sigmaDeg * sqrt(2)",
        };
    }
    if (obsSpec.kind === "wobble") {
        return {
            model: "correlated",
            sigmaDeg: obsSpec.wobble?.amplitude ?? null,
            correlated: true,
            note: "operator tracking wobble: seeded random walk in pan/tilt with "
                + "reaction-delayed recentering. sigmaDeg is the deadband "
                + "amplitude, NOT a white 1-sigma.",
        };
    }
    if (obsSpec.kind === "drift") {
        const d = obsSpec.driftDeg ?? 0;
        return {
            model: "systematic",
            // The RMS of a linear 0 -> d ramp is d/sqrt(3). Quoted because a
            // solver needs a scale, but the model field is what matters: this
            // error has a MEAN, and any weighting that assumes zero-mean noise
            // will read the bias as signal and put the target where the drift
            // points.
            sigmaDeg: d / Math.sqrt(3),
            correlated: true,
            note: "operator drift: a deterministic one-way ramp in pan/tilt "
                + `reaching ${d} deg on sky at the last frame. sigmaDeg is the `
                + "RMS of that ramp, NOT a white 1-sigma, and the error is not "
                + "zero-mean.",
        };
    }
    return {model: "unknown", sigmaDeg: null, correlated: null};
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

// The three headers are ONE schema in three projections: Input is the leading
// columns of All, Truth is the TrackID/Time key plus the trailing columns. A
// consumer that can read All can read the other two by ignoring what is absent,
// and a scorer joins Truth to an algorithm's output on (TrackID, Time).
const INPUT_COLUMNS = [
    "TrackID", "TrackSource", "Time",
    "SensorPositionX", "SensorPositionY", "SensorPositionZ",
    "LOSUnitVectorX", "LOSUnitVectorY", "LOSUnitVectorZ",
    "MaxRange", "LOSUncertainty",
    // v1.2. An UPPER BOUND on the target's observed angular diameter, degrees.
    // A measurement, so it belongs in the challenge file: combined with a
    // minimum plausible diameter for an assumed object class it gives a range
    // FLOOR, R >= D_min / AngularDiameterMax. That floor is the only thing in
    // the format that opposes the scale degeneracy of bearings-only geometry.
    // It is a BOUND, never the exact D/R — publishing the exact angle would let
    // a consumer that assumes a diameter read range straight off. Empty where
    // the scenario declares no target size. See lib/angularSize.js.
    "AngularDiameterMaxDeg",
];
const TRUTH_COLUMNS = ["TruePositionX", "TruePositionY", "TruePositionZ"];

const INPUT_HEADER = INPUT_COLUMNS;
const TRUTH_HEADER = ["TrackID", "Time", ...TRUTH_COLUMNS];
const ALL_HEADER = [...INPUT_COLUMNS, ...TRUTH_COLUMNS];

/**
 * The measurement row for one frame, without the TrackID/Time key. Shared by
 * the input and all builders so the two files cannot drift: a joined file whose
 * measurement columns disagreed with the challenge file would be a silently
 * different problem wearing the same name.
 */
function measurementFields(scenario, i, trackSource, sigmaStr, maxR) {
    const b = i * 3;
    const S = scenario.platform.positionENU;
    const D = scenario.observation.observedDirectionENU;
    return [
        trackSource,
        f(scenario.times[i]),
        f(S[b]), f(S[b + 1]), f(S[b + 2]),
        f(D[b]), f(D[b + 1]), f(D[b + 2]),
        maxR, sigmaStr,
        angularDiameterMaxField(scenario, i),
    ];
}

/**
 * The angular-diameter bound for frame i.
 *
 * Uses the TRUE range to compute the true subtended angle and then widens it to
 * a bound (see angularSize.angularDiameterMaxDeg). Truth is used to MANUFACTURE
 * the measurement, exactly as the LOS directions are; what ships is the bound,
 * not the range.
 *
 * A target with no declared diameter, and a direction-kind target (no finite
 * position, so no range), both yield the empty field — the spec's missing-value
 * representation — rather than a fabricated number.
 */
function angularDiameterMaxField(scenario, i) {
    const diameterM = scenario.spec.target?.diameterM;
    const fov = scenario.observation?.fovFullDeg;
    if (!(diameterM > 0) || !(fov > 0)) return "";
    if (scenario.target.kind === "direction") return "";
    const P = scenario.target.positionENU;
    if (!P) return "";
    const b = i * 3, S = scenario.platform.positionENU;
    const R = Math.hypot(P[b] - S[b], P[b + 1] - S[b + 1], P[b + 2] - S[b + 2]);
    const bound = angularDiameterMaxDeg(diameterM, R, fov, SENSOR_PIXELS);
    return bound === null ? "" : f(bound);
}

// LOSUncertainty is defined by the spec as a per-axis WHITE 1-sigma in degrees.
// A correlated model has no such quantity — emitting its deadband amplitude
// there published a number that is neither a sigma nor in those units, and a
// consumer weighting by it (or feeding it to fitMonteCarlo2 as
// losUncertaintyDeg) was silently misled. Leave the field EMPTY for correlated
// models; scenario.json's losError carries the model and its scale, and the
// empty field is the spec's missing-value representation.
function declaredSigmaField(scenario) {
    const declared = declaredLosError(scenario.spec.observation);
    return declared.correlated ? "" : f(declared.sigmaDeg);
}

/**
 * True position for frame i, as three CSV fields.
 *
 * Direction-kind truth (venus and other effectively-infinite targets) has NO
 * finite position, so all three fields are empty. The bearings live in
 * truth.json's directionTruth, and truthKind says which shape applies — the
 * CSV header stays identical across the whole release rather than mutating
 * per scenario, so a scorer parses one schema and gates on truthKind.
 */
function truthFields(scenario, i) {
    if (scenario.target.kind === "direction") return ["", "", ""];
    const P = scenario.target.positionENU;
    const b = i * 3;
    return [f(P[b]), f(P[b + 1]), f(P[b + 2])];
}

export function buildInputCsv(scenario, trackId, trackSource) {
    const sigmaStr = declaredSigmaField(scenario);
    const maxR = f(scenario.constraints.maxRangeM);
    const rows = [];
    // Every frame gets a row, including frames where the target left the field
    // of view: deleting them would break the uniform time grid that per-frame
    // wind and fps-derived quantities depend on (adapters.js makes the same
    // refusal). scenario.json's invalidFrames lists them.
    for (let i = 0; i < scenario.n; i++) {
        rows.push([trackId, ...measurementFields(scenario, i, trackSource, sigmaStr, maxR)]);
    }
    return csv(INPUT_HEADER, rows);
}

export function buildTruthCsv(scenario, trackId) {
    const rows = [];
    for (let i = 0; i < scenario.n; i++) {
        rows.push([trackId, f(scenario.times[i]), ...truthFields(scenario, i)]);
    }
    return csv(TRUTH_HEADER, rows);
}

export function buildAllCsv(scenario, trackId, trackSource) {
    const sigmaStr = declaredSigmaField(scenario);
    const maxR = f(scenario.constraints.maxRangeM);
    const rows = [];
    for (let i = 0; i < scenario.n; i++) {
        rows.push([
            trackId,
            ...measurementFields(scenario, i, trackSource, sigmaStr, maxR),
            ...truthFields(scenario, i),
        ]);
    }
    return csv(ALL_HEADER, rows);
}

/**
 * Frames where the target was outside the sensor's field of view or otherwise
 * unmeasurable. v1.0 carried this as a per-row Valid column; it moves to
 * scenario.json because it is a property of a handful of frames in a handful of
 * scenarios, not of every row in every file. The rows themselves stay.
 */
export function invalidFrames(scenario) {
    const targetValid = scenario.target.valid ?? null;
    const out = [];
    for (let i = 0; i < scenario.n; i++) {
        if (!(scenario.observation.inFov[i] && (!targetValid || targetValid[i]))) out.push(i);
    }
    return out;
}

/**
 * Public manifest. Deliberately excludes scenarioSeed, generatorVersion and
 * the spec: with a public generator those three REGENERATE THE TRUTH EXACTLY.
 * They live in truth.json instead.
 *
 * The wind reported here is the analyst-available estimate, not the
 * generator's exact field — see the sigmaMS note.
 */
export function buildScenarioJson(scenario, trackId, {
    label, windEstimate = null, trackSource = "botbench", seal = null,
} = {}) {
    const site = scenario.site;
    return {
        specVersion: INTERCHANGE_SPEC_VERSION,
        trackId,
        label,
        frame: {
            type: "ENU",
            // The CSV columns are named X/Y/Z so the schema does not presume a
            // frame. THIS is what they mean. A consumer that assumes the more
            // common X=North/Y=East gets a mirrored scene that still fits its
            // own bearings, so the error survives every internal consistency
            // check it might run.
            axisOrder: "X=East, Y=North, Z=Up",
            originLLA: [site.latDeg, site.lonDeg, site.groundElevationMSL],
            ellipsoid: "WGS84",
            // The generator places truth on a FLAT plane; the ellipsoid does
            // not fall away beneath it, so U is height above the SITE GROUND.
            // originLLA[2] is that ground's MSL elevation, so geodetic altitude
            // is U + groundElevationMSL — equal to U only at a zero-elevation
            // site such as "ocean". A "wgs84-tangent" set would additionally
            // need alt -= (E^2+N^2)/2R (~2 m at 5 km, ~240 m at 55 km).
            surfaceModel: site.surfaceModel === "flat-elevation-proxy"
                ? "flat-plane" : site.surfaceModel,
            groundElevationMSL: site.groundElevationMSL,
            // The whole scene is ONE tangent frame anchored at originLLA.
            // Every direction — LOS and celestial truth alike — is expressed
            // in the ENU basis AT THAT ORIGIN, not in the sensor's own local
            // basis. The two diverge as the sensor moves away from the origin
            // (the local vertical tilts by about d/R_earth), which matters for
            // astronomical cross-checks: at a 30 km offset it is ~0.16 deg,
            // several times a typical pointing sigma. Compute ephemerides at
            // originLLA.
            directionBasis: "originLLA",
            // U is height above the site ground, NOT above the ellipsoid.
            geodeticAltitudeRule: "altitude = U + groundElevationMSL",
        },
        epochISO: site.epochISO,
        nominalFps: scenario.fps,
        frameCount: scenario.n,
        durationSeconds: scenario.durationSeconds,
        timeIsUniform: true,
        // Frames whose LOS is not a valid measurement (target out of the field
        // of view). The rows are still present so the time grid stays uniform;
        // drop these indices from a fit rather than the rows from the file.
        // Empty means every row is a measurement.
        invalidFrames: invalidFrames(scenario),
        losError: declaredLosError(scenario.spec.observation),
        wind: windEstimate,
        sensor: {
            fovFullDeg: scenario.observation.fovFullDeg,
            // The frame width the AngularDiameterMaxDeg column was computed
            // against. Stated rather than assumed: the bound's floor is one
            // IFOV, so a consumer that assumed a different sensor would
            // misread how tight the bound is.
            pixelsAcross: SENSOR_PIXELS,
            // The caller's provenance label, NOT scenario.spec.blockId — the
            // block id names the experimental cell this scenario came from,
            // which is a truth hint in a sealed set.
            trackSource,
        },
        seal,
    };
}

/**
 * Answer key. Everything a scorer needs that a positions table cannot carry —
 * plus the provenance that makes the run reproducible.
 *
 * The geometry block is the scorer's degenerate-cell gate. Without it a mixed
 * set scores algorithms on scenario mix rather than on skill: a straight-flying
 * sensor collapses every FREE solver onto itself (relSep 1.0), and averaging
 * that in rewards whoever drew easier cells.
 *
 * The gate is THREE fields, not one flag, because a single boolean conflated
 * three unrelated claims:
 *
 *   rangeDefined              STRUCTURAL. Does a finite range exist at all? A
 *                             direction-kind target sits at effective infinity,
 *                             so there is no range to recover — categorically
 *                             different from a range that exists but is badly
 *                             conditioned, and a scorer must not treat the two
 *                             alike.
 *   cvConditioningBucket      MEASURED, from the CV design matrix. Says nothing
 *                             about whether CV DESCRIBES the target: a rising
 *                             balloon in shear can be well-conditioned under CV
 *                             and still badly modelled by it. Truth's own motion
 *                             class is targetKind / objectClass.
 *   designIntent              THE AUTHOR'S INTENT for the cell, not a
 *                             measurement. Kept separate so nobody reads an
 *                             editorial label as evidence.
 *
 * And none of it is observability in the abstract. On the straight-platform
 * cells the CV and Kalman fits fail at a rate of 1.00 while a fixed-point fit
 * succeeds on every one at 0.08-0.09 relative separation — same geometry,
 * opposite verdicts, because a stationary target is over-determined by a
 * straight baseline.
 */

// Buckets over the CV design matrix conditioning, from the benchmark's measured
// collapse rates: log10 rcond around -3 / -2 / -1 carried 84% / 8% / 0%.
// The raw value ships alongside so a scorer can pick its own thresholds.
export function cvConditioningBucket(log10Rcond) {
    if (!Number.isFinite(log10Rcond)) return null;
    if (log10Rcond <= -2.5) return "degenerate";
    if (log10Rcond <= -1.5) return "marginal";
    return "well-posed";
}
export function buildTruthJson(scenario, trackId,
    {label, designIntent, placement} = {}) {
    const obs = scenario.observation;
    const t = scenario.target;
    return {
        specVersion: INTERCHANGE_SPEC_VERSION,
        trackId,
        label,
        truthKind: t.kind === "direction" ? "direction" : "position",
        objectClass: t.family ?? null,
        targetKind: scenario.spec.target.kind,
        // The TRUE physical diameter, in metres. Answer-key material: the
        // challenge file publishes only the angular BOUND derived from it, so a
        // scorer needs this to check whether a solver's assumed class size was
        // defensible. Null where the scenario declares no size.
        objectDiameterM: scenario.spec.target?.diameterM ?? null,
        anomalous: scenario.spec.target.parameters?.anomalous === true,
        // The whole answer for a direction-kind target, because truth.csv's
        // position columns are empty for one: at effective infinity there is no
        // position to write. Flat [x,y,z, x,y,z, ...] unit vectors in the frame
        // declared by scenario.json, one triple per frame, same time grid.
        // Null for a position target — its answer is in the CSV.
        directionTruth: t.kind === "direction"
            ? Array.from(t.directionENU) : null,
        // v1.0 shipped a central-difference velocity in truth.csv. It is gone:
        // it was derived from the position column a consumer already has, and
        // scoring against a derived quantity as though it were measured truth
        // penalised the numerical scheme rather than the estimate. Difference
        // the positions yourself if you want it.
        events: scenario.events ?? [],
        // Scorer stratification: cvDesignLog10Rcond buckets -3/-2/-1 carry
        // measured collapse rates of 84%/8%/0%.
        geometry: {
            // Structural: derived from the truth kind, never hand-set.
            rangeDefined: t.kind !== "direction",
            // Measured: conditioning of the CONSTANT-VELOCITY design matrix.
            // Not a statement about whether CV suits this target.
            observabilityBasis: "constant-velocity",
            // A conditioning VERDICT is only meaningful where a range exists to
            // be conditioned. A direction-truth target has none, and its LOS
            // series is near-singular for that reason rather than from weak
            // geometry — so emitting "degenerate" there would bin it alongside
            // the straight-platform cells and re-create the very conflation
            // this block was split up to end. Gate on this before stratifying.
            cvConditioningApplicable: t.kind !== "direction",
            cvConditioningBucket: t.kind === "direction" ? null
                : cvConditioningBucket(scenario.diagnostics.cvDesignLog10RcondObserved),
            // Intended: the author's reason for including the cell. Editorial,
            // not evidence.
            designIntent: designIntent ?? null,
            observabilityNote: "rangeDefined is structural; cvConditioningBucket "
                + "is measured under a constant-velocity model and says nothing "
                + "about whether CV describes this target; designIntent is "
                + "editorial. A solver imposing stricter dynamics can recover "
                + "range where CV cannot — on straight-platform cells the CV and "
                + "Kalman fits fail at a rate of 1.00 while a fixed-point fit "
                + "succeeds on every one. No set of bearings is observable in "
                + "the abstract. Where cvConditioningApplicable is false there is "
                + "no range to condition: the raw rcond below is still the "
                + "measured conditioning of the LOS series, but reading it as "
                + "weak geometry would mis-bin the cell.",
            cvDesignLog10RcondObserved: scenario.diagnostics.cvDesignLog10RcondObserved,
            cvDesignRcondCleanOracle: scenario.diagnostics.cvDesignRcondCleanOracle,
            sensorPathLengthM: scenario.diagnostics.sensorPathLengthM,
            sensorSpanM: scenario.diagnostics.sensorSpanM,
            losSweepDeg: scenario.diagnostics.losSweepDeg,
        },
        // What the generator ACTUALLY drew, vs what scenario.json declared.
        realizedNoise: {
            rmsDegAllFrames: obs.realizedRmsDegAllFrames,
            rmsDegActiveFrames: obs.realizedRmsDegActiveFrames,
            meanDeg: obs.realizedMeanDeg,
            maxDeg: obs.realizedMaxDeg,
            outOfFrameCount: obs.outOfFrameCount,
            outOfFrameFraction: obs.outOfFrameFraction,
        },
        // Truth-side wind. NOT the full field: the mean vector below is a
        // single mid-clip sample of the BASE wind, which for a layered/gusty
        // config says nothing about the shear, veer or gust content the target
        // actually flew through. The config parameters are included so the
        // field is reconstructible; grading recovered wind against the mean
        // alone would penalise a solver that correctly recovers the profile.
        windTruth: {
            note: "mid-clip sample of the base wind; see config for shear/veer/gusts",
            config: WIND_CONFIGS[scenario.spec.wind.kind ?? scenario.spec.wind] ?? null,
            kind: scenario.spec.wind.kind ?? scenario.spec.wind,
            sampledVelocityENUMidClip: [
                scenario.wind.sampledVelocityENU[(scenario.n >> 1) * 3],
                scenario.wind.sampledVelocityENU[(scenario.n >> 1) * 3 + 1],
                scenario.wind.sampledVelocityENU[(scenario.n >> 1) * 3 + 2],
            ],
        },
        provenance: {
            generator: "botbench",
            generatorVersion: scenario.generatorVersion,
            scenarioId: scenario.scenarioId,
            scenarioGroupId: scenario.scenarioGroupId,
            scenarioSeed: scenario.scenarioSeed,
            blockId: scenario.blockId,
            pairId: scenario.pairId,
            spec: scenario.spec,
            // Rigid placement applied AFTER generateScenario. Without it,
            // spec + seed + generatorVersion rebuild a scene that was never
            // shipped, so the provenance would not verify. Null means the
            // scenario was written exactly as generated.
            placement: placement ?? null,
        },
    };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write the three folders for one scenario.
 *
 *   <challengeDir>/Input/  input.csv + scenario.json      THE CHALLENGE
 *   <answersDir>/Truth/    truth.csv + truth.json         THE ANSWER KEY
 *   <answersDir>/All/      all.csv + both sidecars        JOINED, answer key
 *
 * All/ goes to the ANSWERS root, not the challenge root. Its rows carry
 * TruePosition beside the measurement, which is the whole point of the file and
 * exactly what an entrant must not have. Getting this wrong ships the answers
 * inside the challenge, so the sealed-release test greps the challenge tree for
 * the truth column names.
 *
 * Defaulting answersDir to challengeDir keeps all three side by side for
 * development, which is the mode you want while writing a reader.
 *
 * @param scenario   generated BotScenario
 * @param challengeDir root for Input/
 * @param opts.answersDir      root for Truth/ and All/ (defaults to challengeDir)
 * @param opts.basename        override the descriptive name (opaque ids)
 * @param opts.trackId         override the in-file TrackID (defaults to basename)
 * @param opts.trackSource     provenance string for the measurement rows
 * @param opts.designIntent    editorial label for the cell; see buildTruthJson
 * @param opts.windEstimate    analyst-available wind for scenario.json
 * @param opts.sealSaltHex     REQUIRED for a sealed release; see saltedCommit
 * @returns {{basename, trackId, inputFile, scenarioFile, truthFile,
 *            truthJsonFile, allFile, digests}}
 */
export function writeInterchange(scenario, challengeDir, opts = {}) {
    const basename = opts.basename
        ?? scenarioBaseName(scenario.spec, scenario.scenarioSeed);
    const trackId = opts.trackId ?? basename;
    const trackSource = opts.trackSource ?? "botbench";
    const answersDir = opts.answersDir ?? challengeDir;
    const saltHex = opts.sealSaltHex ?? null;

    // SIDECAR LAYOUT. By default each sidecar sits beside the CSV it describes,
    // and All/ carries its own copy of both — the layout a SEALED RELEASE needs,
    // because blinding is then a property of which FOLDER you ship.
    //
    // opts.sidecarDir switches to a single shared directory (the botset trees
    // use "meta"): the CSV folders hold only CSVs and one meta/ folder holds one
    // copy of each sidecar. That is tidier and removes the duplicate scenario
    // .json, but it gives up folder-level blinding, so it must never be combined
    // with descriptiveName — see the throw below.
    const sidecarDirName = opts.sidecarDir ?? null;
    if (sidecarDirName && opts.descriptiveName) {
        throw new Error("writeInterchange: sidecarDir collapses the challenge and "
            + "answer-key copies of scenario.json into one file, so a "
            + "descriptiveName written there would leak into the challenge. "
            + "Use the default layout for any release that needs blinding.");
    }

    const inputDir = path.join(challengeDir, "Input");
    const truthDir = path.join(answersDir, "Truth");
    const allDir = path.join(answersDir, "All");
    const metaDir = sidecarDirName
        ? path.join(answersDir, sidecarDirName) : null;
    fs.mkdirSync(inputDir, {recursive: true});
    fs.mkdirSync(truthDir, {recursive: true});
    fs.mkdirSync(allDir, {recursive: true});
    if (metaDir) fs.mkdirSync(metaDir, {recursive: true});

    const inputFile = path.join(inputDir, `${basename}.input.csv`);
    const scenarioFile = path.join(metaDir ?? inputDir, `${basename}.scenario.json`);
    const truthFile = path.join(truthDir, `${basename}.truth.csv`);
    const truthJsonFile = path.join(metaDir ?? truthDir, `${basename}.truth.json`);
    const allFile = path.join(allDir, `${basename}.all.csv`);

    const inputCsv = buildInputCsv(scenario, trackId, trackSource);
    const truthCsv = buildTruthCsv(scenario, trackId);
    const allCsv = buildAllCsv(scenario, trackId, trackSource);
    const truthJson = JSON.stringify(buildTruthJson(scenario, trackId, {
        label: basename,
        designIntent: opts.designIntent ?? null,
        placement: opts.placement ?? null,
    }), null, 2) + "\n";

    // The seal commits to EVERY file, not just truth.csv. truth.json carries
    // the object class, the events, the range-observability gate and the spec
    // — most of the answer key — and an unsealed answer key can be edited
    // after submissions close. input.csv is sealed too so an entrant can
    // verify the challenge they scored against is the one everyone got.
    const seal = {
        // Public file, public digest: entrants must be able to check this one.
        inputCsvSha256: sha256(inputCsv),
        // Answer-key files get SALTED commitments — a plain digest over
        // enumerable content is not a commitment (see saltedCommit). all.csv
        // is committed on the same terms as truth.csv because it CONTAINS
        // truth.csv; a plain digest of it would be brute-forceable in exactly
        // the same way.
        salted: Boolean(saltHex),
        truthCsvCommit: saltHex ? saltedCommit(truthCsv, saltHex) : sha256(truthCsv),
        truthJsonCommit: saltHex ? saltedCommit(truthJson, saltHex) : sha256(truthJson),
        allCsvCommit: saltHex ? saltedCommit(allCsv, saltHex) : sha256(allCsv),
    };

    const scenarioJson = JSON.stringify(buildScenarioJson(scenario, trackId, {
        label: basename,
        windEstimate: opts.windEstimate ?? null,
        trackSource, seal,
    }), null, 2) + "\n";

    fs.writeFileSync(inputFile, inputCsv);
    fs.writeFileSync(truthFile, truthCsv);
    fs.writeFileSync(truthJsonFile, truthJson);
    fs.writeFileSync(scenarioFile, scenarioJson);
    fs.writeFileSync(allFile, allCsv);
    // All/ is self-contained: a consumer handed that folder alone still gets
    // the frame declaration (without which X/Y/Z are unanchored numbers) and
    // the class/events/geometry metadata that no CSV column can carry. Its
    // sidecar copy ADDITIONALLY carries the human-meaningful scenario name —
    // All/ is answer-key material by definition, so the name leaks nothing
    // the folder does not already contain, while the challenge-side sidecar
    // stays name-free (the sealed-release leak test enforces it).
    if (!metaDir) {
        const allScenarioJson = opts.descriptiveName
            ? JSON.stringify({
                ...JSON.parse(scenarioJson),
                descriptiveName: opts.descriptiveName,
            }, null, 2) + "\n"
            : scenarioJson;
        fs.writeFileSync(path.join(allDir, `${basename}.scenario.json`), allScenarioJson);
        fs.writeFileSync(path.join(allDir, `${basename}.truth.json`), truthJson);
    }

    return {
        basename, trackId, inputFile, scenarioFile, truthFile, truthJsonFile,
        allFile, metaDir,
        digests: {
            inputCsvSha256: seal.inputCsvSha256,
            scenarioJsonSha256: sha256(scenarioJson),
            truthCsvCommit: seal.truthCsvCommit,
            truthJsonCommit: seal.truthJsonCommit,
            allCsvCommit: seal.allCsvCommit,
            salted: seal.salted,
        },
    };
}
