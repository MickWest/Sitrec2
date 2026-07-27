// exportInterchange.js — write a BotScenario as the generic BOT interchange
// file set, so algorithms outside Sitrec can be run against these scenarios
// and scored against the same truth.
//
// Four forms per scenario (spec: benchmarks/botbench/BOT-Interchange-Format.html):
//
//   <name>.input.csv      sensor positions + LOS unit vectors + declared error
//   <name>.scenario.json  ENU origin, datum, surface model, epoch, timing
//   <name>.truth.csv      truth positions (or directions) on the same grid
//   <name>.truth.json     object class, envelope, events, realized noise stats
//
// The first two are the challenge; the last two are the answer key. They are
// written to SEPARATE directories so a challenge set can ship without truth.
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

export const INTERCHANGE_SPEC_VERSION = "1.0";

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
    if (params.startAGL != null) return `${kind}-${num(params.startAGL)}m`;
    return kind;
}

function observationPart(o) {
    if (o.kind === "clean") return "clean";
    if (o.kind === "white") {
        // A matched-white member's sigma is set from its partner's realized
        // RMS, so name it by that instead of the (absent) requested sigma.
        if (o.matchedRealizedRmsDeg != null) return `matchwhite${num(o.matchedRealizedRmsDeg)}deg`;
        return `white${num(o.gaussianSigmaDeg)}deg`;
    }
    if (o.kind === "wobble") return `wobble${num(o.wobble?.amplitude ?? 0)}deg`;
    return o.kind;
}

/**
 * Descriptive basename for a scenario spec. Stable for a given spec+seed, so
 * regenerating overwrites in place rather than accumulating near-duplicates.
 */
export function scenarioBaseName(spec, scenarioSeed) {
    return [
        platformPart(spec.platform),
        fmtRange(spec.initialHorizontalRangeM),
        `${num(spec.durationSeconds)}s-${num(spec.fps)}fps`,
        targetPart(spec.target),
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
    return {model: "unknown", sigmaDeg: null, correlated: null};
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

const INPUT_HEADER = [
    "TrackID", "TrackSource", "Time", "Valid",
    "SensorPosE", "SensorPosN", "SensorPosU",
    "LosE", "LosN", "LosU",
    "LosSigmaDeg", "MinRange", "MaxRange",
];

export function buildInputCsv(scenario, trackId, trackSource) {
    const {n, times, platform, observation, constraints} = scenario;
    const S = platform.positionENU;
    const D = observation.observedDirectionENU;
    const targetValid = scenario.target.valid ?? null;
    // LosSigmaDeg is defined by the spec as a per-axis WHITE 1-sigma. A
    // correlated model has no such quantity — emitting its deadband amplitude
    // there published a number that is neither a sigma nor in those units, and
    // a consumer weighting by it (or feeding it to fitMonteCarlo2 as
    // losUncertaintyDeg) was silently misled. Leave the field EMPTY for
    // correlated models; scenario.json's losError carries the model and its
    // scale, and the empty field is the spec's missing-value representation.
    const declared = declaredLosError(scenario.spec.observation);
    const sigmaStr = declared.correlated ? "" : f(declared.sigmaDeg);
    const minR = f(constraints.minRangeM);
    const maxR = f(constraints.maxRangeM);

    const rows = [];
    for (let i = 0; i < n; i++) {
        const b = i * 3;
        // Valid=0 keeps the row. Deleting out-of-frame rows would break the
        // uniform time grid that per-frame wind and fps-derived quantities
        // depend on (adapters.js makes the same refusal).
        const valid = (observation.inFov[i] && (!targetValid || targetValid[i])) ? 1 : 0;
        rows.push([
            trackId, trackSource, f(times[i]), valid,
            f(S[b]), f(S[b + 1]), f(S[b + 2]),
            f(D[b]), f(D[b + 1]), f(D[b + 2]),
            sigmaStr, minR, maxR,
        ]);
    }
    return csv(INPUT_HEADER, rows);
}

const TRUTH_POS_HEADER = [
    "TrackID", "Time",
    "TruthPosE", "TruthPosN", "TruthPosU",
    "TruthVelE", "TruthVelN", "TruthVelU",
];
const TRUTH_DIR_HEADER = ["TrackID", "Time", "TruthDirE", "TruthDirN", "TruthDirU"];

export function buildTruthCsv(scenario, trackId) {
    const {n, times, target} = scenario;

    // Direction-kind truth (venus and other effectively-infinite targets): the
    // answer is a bearing, so there is no finite position to score against.
    if (target.kind === "direction") {
        const Dt = target.directionENU;
        const rows = [];
        for (let i = 0; i < n; i++) {
            const b = i * 3;
            rows.push([trackId, f(times[i]), f(Dt[b]), f(Dt[b + 1]), f(Dt[b + 2])]);
        }
        return csv(TRUTH_DIR_HEADER, rows);
    }

    const P = target.positionENU;
    // Velocity by central difference (one-sided at the ends). The balloon and
    // bird truths come out of a numeric integration with no analytic velocity,
    // so this is derived rather than exact — truth.json records that.
    const rows = [];
    for (let i = 0; i < n; i++) {
        const b = i * 3;
        const iA = i === 0 ? 0 : i - 1;
        const iB = i === n - 1 ? n - 1 : i + 1;
        const dt = times[iB] - times[iA];
        const vel = [0, 1, 2].map((k) => (dt > 0 ? (P[iB * 3 + k] - P[iA * 3 + k]) / dt : 0));
        rows.push([
            trackId, f(times[i]),
            f(P[b]), f(P[b + 1]), f(P[b + 2]),
            f(vel[0]), f(vel[1]), f(vel[2]),
        ]);
    }
    return csv(TRUTH_POS_HEADER, rows);
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
        losError: declaredLosError(scenario.spec.observation),
        wind: windEstimate,
        sensor: {
            fovFullDeg: scenario.observation.fovFullDeg,
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
        anomalous: scenario.spec.target.parameters?.anomalous === true,
        velocityDerivation: t.kind === "direction" ? null : "central-difference",
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
 * Write the four files for one scenario.
 *
 * The challenge (input.csv + scenario.json) and the answer key (truth.csv +
 * truth.json) go to SEPARATE roots, so a sealed set can be distributed by
 * shipping one directory. Defaulting answersDir to challengeDir keeps the
 * convenient side-by-side layout for development.
 *
 * @param scenario   generated BotScenario
 * @param challengeDir root for input/; input/ is created under it
 * @param opts.answersDir      root for truth/ (defaults to challengeDir)
 * @param opts.basename        override the descriptive name (opaque ids)
 * @param opts.trackId         override the in-file TrackID (defaults to basename)
 * @param opts.trackSource     provenance string for the input rows
 * @param opts.designIntent    editorial label for the cell; see buildTruthJson
 * @param opts.windEstimate    analyst-available wind for scenario.json
 * @param opts.sealSaltHex     REQUIRED for a sealed release; see saltedCommit
 * @returns {{basename, trackId, inputFile, scenarioFile, truthFile,
 *            truthJsonFile, digests}}
 */
export function writeInterchange(scenario, challengeDir, opts = {}) {
    const basename = opts.basename
        ?? scenarioBaseName(scenario.spec, scenario.scenarioSeed);
    const trackId = opts.trackId ?? basename;
    const trackSource = opts.trackSource ?? "botbench";
    const answersDir = opts.answersDir ?? challengeDir;
    const saltHex = opts.sealSaltHex ?? null;

    const inputDir = path.join(challengeDir, "input");
    const truthDir = path.join(answersDir, "truth");
    fs.mkdirSync(inputDir, {recursive: true});
    fs.mkdirSync(truthDir, {recursive: true});

    const inputFile = path.join(inputDir, `${basename}.input.csv`);
    const scenarioFile = path.join(inputDir, `${basename}.scenario.json`);
    const truthFile = path.join(truthDir, `${basename}.truth.csv`);
    const truthJsonFile = path.join(truthDir, `${basename}.truth.json`);

    const inputCsv = buildInputCsv(scenario, trackId, trackSource);
    const truthCsv = buildTruthCsv(scenario, trackId);
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
        // enumerable content is not a commitment (see saltedCommit).
        salted: Boolean(saltHex),
        truthCsvCommit: saltHex ? saltedCommit(truthCsv, saltHex) : sha256(truthCsv),
        truthJsonCommit: saltHex ? saltedCommit(truthJson, saltHex) : sha256(truthJson),
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

    return {
        basename, trackId, inputFile, scenarioFile, truthFile, truthJsonFile,
        digests: {
            inputCsvSha256: seal.inputCsvSha256,
            scenarioJsonSha256: sha256(scenarioJson),
            truthCsvCommit: seal.truthCsvCommit,
            truthJsonCommit: seal.truthJsonCommit,
            salted: seal.salted,
        },
    };
}
