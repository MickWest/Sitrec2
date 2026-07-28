#!/usr/bin/env node
/**
 * probeNoiseFloor.mjs — can a sightline noise floor be estimated from the data alone?
 *
 * Run: node benchmarks/botbench/probeNoiseFloor.mjs
 *
 * This exists because docs/TraverseInterchangeFindings.md (F1/P2) makes numerical
 * claims about noise estimation, and a claim presented as a measurement needs a
 * script anyone can re-run. Review correctly flagged that the first version of
 * those numbers had no committed source.
 *
 * It reads only the published interchange files. The declared noise in
 * scenario.json and the realized noise in truth.json are used ONLY to score the
 * estimators — never as an input to them.
 *
 * WHY COORDINATE-FREE. The obvious implementation works in azimuth/elevation and
 * is wrong: azimuth is undefined at the pole, and bot-0015's sightline reaches
 * -89.3 deg elevation, where that version returns 2.09 deg against a true 0.03 —
 * a 70x error. The second difference of the unit DIRECTION VECTOR has no pole and
 * no wrap-around. Sitrec routinely sees near-nadir sightlines, so this is a
 * requirement, not a nicety.
 *
 * THE RELATION. For a unit direction vector with per-axis tangent-plane noise
 * sigma, E||d(f+m) - 2d(f) + d(f-m)||^2 = 12 * sigma^2 (six coefficients squared
 * summing to 6, times two effective degrees of freedom in the tangent plane).
 * Note this is 12, not the 6 that holds for a SCALAR series — the report's
 * earlier text stated the scalar relation while the code used the vector one.
 *
 * UNITS. Two drafts of this script got this wrong, in the same way both times:
 * they converted between angular quantities using relations that only hold for
 * ISOTROPIC GAUSSIAN noise, and then applied them to the correlated cells — whose
 * whole point is that they are neither isotropic nor Gaussian. A deadband random
 * walk with reaction-delayed recentering has no per-axis sigma to recover, so
 *
 *     realized_sigma = rms_magnitude / sqrt(2)        <- INVALID for those cells
 *     mean_angle     = sigma * sqrt(pi/2)             <- INVALID for those cells
 *
 * are not available. Everything measured is therefore compared in ONE quantity
 * that needs no distributional assumption at all:
 *
 *     MEAN ANGULAR ERROR IN DEGREES — which is exactly what Sitrec's errDeg is
 *     (meanAngularError sums angles and divides by count), and which the truth
 *     sidecar publishes directly as realizedNoise.meanDeg.
 *
 * The estimators still return a per-axis sigma, because that is what a second
 * difference gives you. Turning that into a predicted floor DOES require the
 * isotropic-Gaussian step — so the script reports it as a PREDICTION and scores
 * it against the measured mean. For white cells the assumption holds and the
 * ratio lands near 1. For correlated cells it fails, and the ratio shows by how
 * much. That is the finding, and it is now stated without an invalid conversion
 * inside the comparison.
 *
 * TWO ESTIMATOR FORMS:
 *   mean   sqrt(mean(||D2||^2) / 12)          — efficient, not robust
 *   median sqrt(median(||D2||^2) / (12*ln2))  — 50% breakdown; ||D2||^2 is
 *                                               exponentially distributed, so the
 *                                               median is 12*sigma^2*ln2
 * The median form is the one that survives a manoeuvring target.
 *
 * MULTIPLE LAGS. Evaluating at m = 1,2,4,8 is the variogram / Allan-variance
 * construction: flat across lags means white noise, rising means structure at
 * that timescale. It is the only thing here that sees correlated operator wobble.
 */

import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, "results/interchange/answers/All");

const LAGS = [1, 2, 4, 8];
const DEG = 180 / Math.PI;

function readDirections(id) {
    const lines = fs.readFileSync(path.join(DIR, `${id}.all.csv`), "utf8").trim().split(/\r?\n/);
    const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const ix = ["losunitvectorx", "losunitvectory", "losunitvectorz"].map((c) => head.indexOf(c));
    return lines.slice(1).map((l) => {
        const c = l.split(",");
        return ix.map((i) => Number(c[i]));
    });
}

/** Squared second differences of the direction series at lag m, in rad^2. */
function secondDiffs(D, m) {
    const out = [];
    for (let f = m; f < D.length - m; f++) {
        let s = 0;
        for (let k = 0; k < 3; k++) {
            const d = D[f + m][k] - 2 * D[f][k] + D[f - m][k];
            s += d * d;
        }
        out.push(s);
    }
    return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function median(a) {
    const s = [...a].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Per-axis sigma in degrees, from squared second differences. */
const sigmaMean = (sq) => Math.sqrt(mean(sq) / 12) * DEG;
const sigmaMedian = (sq) => Math.sqrt(median(sq) / (12 * Math.LN2)) * DEG;

// Per-axis sigma -> predicted mean angular error, for ISOTROPIC GAUSSIAN noise
// only: the magnitude is then Rayleigh(sigma) with mean sigma*sqrt(pi/2). This
// is the estimator's own extrapolation and is the thing being tested — it is
// never used to convert a MEASURED quantity.
const SIGMA_TO_MEAN = Math.sqrt(Math.PI / 2);

const ids = fs.readdirSync(DIR).filter((f) => f.endsWith(".all.csv"))
    .map((f) => f.replace(/\.all\.csv$/, "")).sort();

const rows = [];
for (const id of ids) {
    const D = readDirections(id);
    const sc = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.scenario.json`), "utf8"));
    const tr = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.truth.json`), "utf8"));
    const sq1 = secondDiffs(D, 1);
    const white = (sc.losError?.model ?? "?") === "white";
    const est = sigmaMean(sq1);
    const estRobust = sigmaMedian(sq1);
    rows.push({
        id, n: D.length,
        model: sc.losError?.model ?? "?",
        // Only meaningful for white cells; a deadband amplitude is not a sigma.
        declaredSigma: white ? (sc.losError?.sigmaDeg ?? NaN) : NaN,
        // MEASURED mean angular error — no distributional assumption, and the
        // exact quantity Sitrec's errDeg computes. This is the reference.
        actualMeanDeg: tr.realizedNoise?.meanDeg ?? NaN,
        anomalous: !!tr.anomalous,
        est, estRobust,
        // The estimators' PREDICTED floor. The sqrt(pi/2) step assumes isotropic
        // Gaussian noise, which is what is under test.
        predMeanDeg: est * SIGMA_TO_MEAN,
        predMeanDegRobust: estRobust * SIGMA_TO_MEAN,
        lags: LAGS.map((m) => (D.length > 2 * m + 2 ? sigmaMedian(secondDiffs(D, m)) : NaN)),
    });
}

const f = (x, w = 6, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a").padStart(w);

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

say("");
say("DOES THE ESTIMATOR PREDICT THE FLOOR A PERFECT MODEL WOULD HIT?");
say("");
say("Everything is compared as MEAN ANGULAR ERROR IN DEGREES — the quantity");
say("Sitrec's errDeg measures, published directly as realizedNoise.meanDeg.");
say("No back-conversion of any measured value is performed, so the correlated");
say("cells (not isotropic, not Gaussian, no per-axis sigma to recover) are");
say("compared on the same footing as the rest.");
say("");
say("id".padEnd(9) + "model".padEnd(12) + "n".padStart(4)
    + "predicted".padStart(11) + "pred(robust)".padStart(13) + "ACTUAL".padStart(9)
    + "   pred/act  rob/act   note");
say("-".repeat(104));
for (const r of rows) {
    const note = r.anomalous ? "manoeuvring target"
        : r.model !== "white" ? "correlated wobble" : "";
    say(r.id.padEnd(9) + r.model.padEnd(12) + String(r.n).padStart(4)
        + f(r.predMeanDeg, 11, 4) + f(r.predMeanDegRobust, 13, 4)
        + f(r.actualMeanDeg, 9, 4)
        + `   ${f(r.predMeanDeg / r.actualMeanDeg, 6, 2)} `
        + `${f(r.predMeanDegRobust / r.actualMeanDeg, 8, 2)}   ${note}`);
}
say("");
say("The prediction step (per-axis sigma -> mean angle) assumes isotropic");
say("Gaussian noise. That assumption is the thing under test: it holds for the");
say("white cells and fails for the correlated ones, which is why they read low.");

say("");
say("MULTI-LAG PROFILE — same predicted-floor units as above (mean angular deg).");
say("Flat across lags = white noise. Rising = structure at that timescale, which");
say("may be correlated pointing error OR real target motion — not separable here.");
say("");
say("id".padEnd(9) + "model".padEnd(12) + LAGS.map((m) => `lag${m}`.padStart(8)).join("")
    + "ACTUAL".padStart(9) + "  slope  note");
say("-".repeat(104));
for (const r of rows) {
    const slope = Number.isFinite(r.lags[2]) && r.lags[0] > 0
        ? Math.log2(r.lags[2] / r.lags[0]) / 2 : NaN;
    const note = r.anomalous ? "manoeuvring target"
        : r.model !== "white" ? "correlated wobble" : "";
    say(r.id.padEnd(9) + r.model.padEnd(12)
        + r.lags.map((v) => f(v * SIGMA_TO_MEAN, 8, 4)).join("")
        + f(r.actualMeanDeg, 9, 4) + f(slope, 7, 2) + "  " + note);
}
say("");
say("Note the lag columns carry the same isotropic-Gaussian prediction step, so");
say("for the correlated cells read them as a SHAPE (does it rise?) rather than as");
say("a calibrated floor.");

// The summary the report quotes. Grouped by what the estimator is up against.
const white = rows.filter((r) => r.model === "white" && !r.anomalous);
const corr = rows.filter((r) => r.model !== "white");
const anom = rows.filter((r) => r.anomalous);
const span = (rs, key) => {
    const v = rs.map((r) => r[key] / r.actualMeanDeg).sort((a, b) => a - b);
    return `${v[0].toFixed(2)}-${v[v.length - 1].toFixed(2)}`;
};
say("");
say("SUMMARY — predicted floor / actual floor, both mean angular error in degrees");
say("");
say(`  ${String(white.length).padStart(2)} ordinary white-noise cells   plain ${span(white, "predMeanDeg")}   robust ${span(white, "predMeanDegRobust")}`);
say(`  ${String(anom.length).padStart(2)} manoeuvring-target cells    plain ${span(anom, "predMeanDeg")}   robust ${span(anom, "predMeanDegRobust")}`);
say(`  ${String(corr.length).padStart(2)} correlated-wobble cells     plain ${span(corr, "predMeanDeg")}   robust ${span(corr, "predMeanDegRobust")}`);
say("");
say("  The wobble cells read LOW by construction: a lag-1 second difference cannot");
say("  see error that drifts slowly. That is what the multi-lag profile is for.");
say("  The manoeuvring cells read HIGH in the mean form because the target really");
say("  does jerk. The median form reduces that — but it also WIDENS the ordinary");
say("  cells, so the two groups are no longer separable by the estimate alone.");

// What the F1 gate actually compares, in the units Sitrec's errDeg uses.
say("");
say("WHAT A PERFECT MODEL WOULD SCORE, against Sitrec's fixed 0.05 deg gate.");
say("This is the MEASURED realizedNoise.meanDeg — the same quantity errDeg is —");
say("so it involves no estimator, no assumption, and no conversion.");
say("");
say("id".padEnd(9) + "model".padEnd(12) + "perfect-model errDeg".padStart(21)
    + "  vs the 0.05 gate");
say("-".repeat(104));
for (const r of rows) {
    const verdict = r.actualMeanDeg < 0.05
        ? `passes, ${((1 - r.actualMeanDeg / 0.05) * 100).toFixed(0)}% margin`
        : `IMPOSSIBLE — floor is ${(r.actualMeanDeg / 0.05).toFixed(1)}x the gate`;
    say(r.id.padEnd(9) + r.model.padEnd(12) + f(r.actualMeanDeg, 21, 4) + "  " + verdict);
}

const OUT = path.resolve(__dirname, "results/noise-floor-probe.txt");
fs.writeFileSync(OUT, out.join("\n") + "\n");
say("");
say(`Written to ${path.relative(process.cwd(), OUT)}`);
say("");
