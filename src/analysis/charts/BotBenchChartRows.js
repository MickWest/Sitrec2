// BotBenchChartRows.js — turn BOTBench results into the rows the charts read.
//
// Pure data: no DOM and no charting library, so it runs under Jest, and the same
// row shape comes out whether the rows start as a finished run in the app or as a
// joined results JSONL from the offline pipeline.
//
// THE RULE THIS FILE LEARNED THE HARD WAY: read every field from the run itself
// before reaching for a sidecar or a folder name. A scenario's sidecars live in a
// meta folder BESIDE its All folder, so choosing All on its own pairs no sidecar
// at all. The first version of this adapter then lost the clip length, the class
// outcome and the aperture of 300 perfectly good results, and the chart window
// drew nothing. The clip length had been on every row the whole time.
//
// What genuinely needs the sidecar is the declared pointing error. The All CSV
// leaves its uncertainty column blank, so without the sidecar the rung is unknown.
// It is left null, and the figures say "unstated" rather than guess.

import {rankAllHypotheses} from "../../TraverseRanking";

const DEG = 180 / Math.PI;
const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** A dataset name when supplied by the picker, otherwise a recognizable path root. */
export function datasetLabelOf(rows) {
    const explicit = rows.find((row) => row.datasetLabel)?.datasetLabel;
    if (explicit) return explicit;
    const roots = new Set();
    for (const row of rows) {
        const root = String(row.set || (row.path?.includes("/") ? row.path : "") || "")
            .replace(/\\/g, "/").split("/")[0];
        // These describe a slice of a dataset, not its name.
        if (root && !/^(?:batch_\d+(?:sec|s)|\d+(?:\.\d+)?deg|All|Input|Truth|meta)$/i.test(root)) roots.add(root);
    }
    return roots.size === 1 ? [...roots][0] : "This run";
}

/** The requested duration encoded by a batch_<N>sec (or older batch_<N>s) folder. */
export function batchDurationSeconds(row) {
    if (fin(row?.d_batchDurationSeconds)) return row.d_batchDurationSeconds;
    for (const value of [row?.path, row?.batch, row?.set]) {
        const match = String(value ?? "").match(/(?:^|\/)batch_(\d+)(?:sec|s)(?:\/|$)/i);
        if (match) return Number(match[1]);
    }
    return null;
}

// The verdict's interpretation class each true class is judged against. Party and
// weather balloons are both the balloon class; a fixed-wing drone is fixed-wing.
const CLASS_KEY_BY_OBJECT = {balloon: "balloon", aircraft: "fixedWing", drone: "fixedWing"};
const CLASS_KEY_BY_NAME = {balloon: "balloon", weather_balloon: "balloon", drone: "fixedWing"};

/**
 * The target class of a scenario: from its answer key when there is one, else from
 * a file named by class (balloon_001, drone_042, weather_balloon_100). Any other
 * name gives null — never a guess.
 */
export function classOf(baseName, truth = null) {
    const kind = String(truth?.targetKind ?? "");
    if (kind.startsWith("weather")) return "weather_balloon";
    if (kind.startsWith("drone")) return "drone";
    if (truth?.objectClass === "balloon") return "balloon";
    const named = String(baseName ?? "").match(/^(weather_balloon|balloon|drone)_\d+$/);
    return named ? named[1] : null;
}

/**
 * Whether the verdict kept the true class viable: true, false, or null when the
 * true class is not known. Never false for "not known", which would count a
 * missing answer key as a wrong answer.
 */
export function classCorrectFor(cls, truth, viableClasses) {
    const key = CLASS_KEY_BY_OBJECT[truth?.objectClass] ?? CLASS_KEY_BY_NAME[cls] ?? null;
    if (!key) return null;
    return (viableClasses ?? []).includes(key);
}

/**
 * The parallax aperture: the angle at the target, at mid-clip, between the first
 * and the last sensor position. The same definition as the offline join
 * (private/probes/BotBenchScatterBrowserJoin.mjs) and the platform manifest, so
 * the in-app and offline figures plot the same quantity.
 *
 * Measured from positions the run already holds — its sensor track and its truth
 * track — so it needs no sidecar. Only frames with a valid truth position take
 * part, as in the join.
 *
 * Not the sightline sweep angle. The two agree only for a stationary target; for
 * anything that moves during the clip they differ, and an earlier version of this
 * adapter plotted the sweep under the aperture's name.
 *
 * @param S      flat sensor positions, 3 per frame
 * @param T      flat truth positions, 3 per frame
 * @param valid  optional per-frame truth validity flags
 * @returns {number|null} degrees
 */
export function apertureFromPositions(S, T, valid = null) {
    if (!S || !T) return null;
    const n = Math.min(Math.floor(S.length / 3), Math.floor(T.length / 3));
    const frames = [];
    for (let f = 0; f < n; f++) {
        if (valid && !valid[f]) continue;
        if (fin(T[f * 3]) && fin(T[f * 3 + 1]) && fin(T[f * 3 + 2])) frames.push(f);
    }
    if (frames.length < 2) return null;
    const first = frames[0];
    const last = frames[frames.length - 1];
    const mid = frames[Math.floor(frames.length / 2)];
    const ux = S[first * 3] - T[mid * 3], uy = S[first * 3 + 1] - T[mid * 3 + 1], uz = S[first * 3 + 2] - T[mid * 3 + 2];
    const vx = S[last * 3] - T[mid * 3], vy = S[last * 3 + 1] - T[mid * 3 + 1], vz = S[last * 3 + 2] - T[mid * 3 + 2];
    const nu = Math.hypot(ux, uy, uz);
    const nv = Math.hypot(vx, vy, vz);
    if (!(nu > 0 && nv > 0)) return null;
    const cosine = (ux * vx + uy * vy + uz * vz) / (nu * nv);
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * DEG;
}

/**
 * How far the sensor turned over the clip: the sum of the absolute changes of its
 * horizontal heading from one position to the next, in degrees.
 *
 * On rock_v3 this measures the confound behind the clip-length figures: a sensor
 * flying straight cannot fix the range of a constant-velocity target, and in that
 * holding pattern long clips always contain a turn. The horizontal plane is x-y; the
 * interchange frame is z-up. Steps shorter than `minStepM` are skipped, because a
 * heading taken from a near-zero step is noise. On a recorded track with jitter this
 * sum grows with the jitter; it is exact on a generated one.
 *
 * @param S  flat sensor positions, 3 per frame
 * @returns {number|null} degrees
 */
export function sensorTurnFromPositions(S, {minStepM = 0.5} = {}) {
    if (!S) return null;
    const n = Math.floor(S.length / 3);
    let total = 0, previous = null, turns = 0;
    for (let f = 1; f < n; f++) {
        const dx = S[f * 3] - S[(f - 1) * 3];
        const dy = S[f * 3 + 1] - S[(f - 1) * 3 + 1];
        if (!fin(dx) || !fin(dy) || Math.hypot(dx, dy) < minStepM) continue;
        const heading = Math.atan2(dx, dy);
        if (previous !== null) {
            let d = heading - previous;
            if (d > Math.PI) d -= 2 * Math.PI;
            else if (d < -Math.PI) d += 2 * Math.PI;
            total += Math.abs(d);
            turns++;
        }
        previous = heading;
    }
    return turns ? total * DEG : null;
}

/**
 * Every candidate's error against truth, in each unit the charts offer.
 *
 * Taken from a finished analysis while it is still in memory, because a long run
 * releases each file's full analysis once its row is done; the result cache keeps
 * the list beside the row, so a cached run can chart it without rebuilding the
 * analysis. Only candidates the truth scoring counted are listed: those it marked
 * comparable, which excludes a hypothesis at infinity. That is the rule the row's own
 * best-candidate error uses, so the two agree.
 *
 *   sepM        mean 3D separation from truth, metres: the truth scoring's own score
 *   relSep      sepM over the mean true range
 *   angDeg      mean angle, seen from the sensor, between the candidate and the truth
 *   losDeg      the candidate's mean line-of-sight residual against the measured sightlines
 *   headingDeg  mean difference between the candidate's and the truth's horizontal
 *               heading, degrees (see meanMotionErrors)
 *   velocityMS  mean magnitude of the difference between the candidate's and the
 *               truth's 3D velocity, metres per second
 *
 * `blindRank` records the result's truth-free ranking so the chart window can
 * recompute its top candidate after applying a Selected Solvers filter.
 *
 * @returns {Array<{key, name, relSep, sepM, angDeg, losDeg, headingDeg, velocityMS, blindRank, rangeBlind}>|null}
 */
export function candidateErrorsFrom(results) {
    const S = results?.dataset?.S;
    const fps = results?.dataset?.fps;
    const T = results?.truth?.track;
    const valid = results?.truth?.valid ?? null;
    const out = [];
    const blindRanks = new Map(rankAllHypotheses(results?.hypotheses, {useTruth: false})
        .map((item, index) => [item.h, index]));
    for (const h of results?.hypotheses ?? []) {
        const c = h?.truthComparison;
        if (!c || !c.comparable || !fin(c.score) || !(c.meanTruthRange > 0)) continue;
        const motion = meanMotionErrors(h.track, T, valid, fps);
        out.push({
            key: h.key ?? null,
            name: h.name ?? null,
            relSep: c.score / c.meanTruthRange,
            sepM: c.score,
            angDeg: meanAngleToTruth(S, h.track, T, valid),
            losDeg: fin(h.errDeg) ? h.errDeg : null,
            headingDeg: motion.headingDeg,
            velocityMS: motion.velocityMS,
            blindRank: blindRanks.get(h) ?? null,
            rangeBlind: String(h.key ?? "").startsWith("gf") || String(h.key ?? "").startsWith("mc_"),
        });
    }
    return out.length ? out : null;
}

/**
 * Restrict candidate-backed chart values to a solver selection. The selected
 * top is the highest truth-free ranked candidate and the selected best is the
 * candidate closest to truth. Verdict fields remain the result of the run that
 * produced the row; changing a chart filter does not re-run the analysis.
 */
export function filterRowsToSolvers(rows, solverIds) {
    const selected = new Set(solverIds ?? []);
    return (rows ?? []).map((row) => {
        const candidates = (row.r_candidates ?? []).filter((candidate) => selected.has(candidate?.key));
        const ranked = candidates.filter((candidate) => Number.isFinite(candidate.blindRank))
            .sort((a, b) => a.blindRank - b.blindRank);
        // Older joined JSONL may have candidate errors but no blind ranks. It is
        // safe to retain the original top only when that exact candidate remains;
        // inventing a new top from file order would falsely call generation order
        // a ranking.
        const top = ranked[0] ?? candidates.find((candidate) => candidate.key === row.r_topKey) ?? null;
        const best = candidates.filter((candidate) => fin(candidate.relSep))
            .reduce((winner, candidate) => !winner || candidate.relSep < winner.relSep ? candidate : winner, null);
        const filtered = {
            ...row,
            r_candidates: candidates,
            r_topKey: top?.key ?? null,
            r_topName: top?.name ?? null,
            r_topErr: fin(top?.losDeg) ? top.losDeg : null,
            r_topRange: null,
            r_topBlind: top ? (top.rangeBlind ? 1 : 0) : 0,
            r_topRelSep: fin(top?.relSep) ? top.relSep : null,
            r_topSepM: fin(top?.sepM) ? top.sepM : null,
            r_bestName: best?.name ?? null,
            r_bestRelSep: fin(best?.relSep) ? best.relSep : null,
            r_bestSepM: fin(best?.sepM) ? best.sepM : null,
        };
        if (row.entry) Object.defineProperty(filtered, "entry", {value: row.entry, enumerable: false});
        return filtered;
    });
}

/**
 * A track slower than this across the ground has no heading to compare. A hovering
 * drone, a stationary candidate and a balloon in still air all sit under it.
 */
export const HEADING_SPEED_FLOOR_MS = 0.5;

/**
 * How a candidate's motion compares with the truth's, frame by frame.
 *
 * Velocities are the differences between consecutive positions, times the frame
 * rate; a frame counts when it and the next are both valid. The velocity error is
 * the mean magnitude of the 3D velocity difference, in metres per second. The
 * heading error is the mean absolute difference between the two horizontal
 * headings (clockwise from north, east and north being the first two axes), from
 * 0 to 180 degrees, over the frames where BOTH tracks move faster than
 * HEADING_SPEED_FLOOR_MS across the ground; a slower track has no heading. Null
 * where no frame qualifies.
 *
 * A range error along the sightline scales a track's speed with its distance, so
 * the velocity error carries the range error as well as the shape; the heading
 * error does not, which is what makes it a shape-only comparison.
 */
export function meanMotionErrors(track, T, valid = null, fps = null) {
    const none = {headingDeg: null, velocityMS: null};
    if (!track || !T || !fin(fps) || !(fps > 0)) return none;
    const n = Math.min(Math.floor(track.length / 3), Math.floor(T.length / 3));
    let velSum = 0, velCount = 0, headSum = 0, headCount = 0;
    for (let f = 0; f + 1 < n; f++) {
        if (valid && (!valid[f] || !valid[f + 1])) continue;
        const a = f * 3, b = a + 3;
        const cx = (track[b] - track[a]) * fps, cy = (track[b + 1] - track[a + 1]) * fps, cz = (track[b + 2] - track[a + 2]) * fps;
        const tx = (T[b] - T[a]) * fps, ty = (T[b + 1] - T[a + 1]) * fps, tz = (T[b + 2] - T[a + 2]) * fps;
        if (![cx, cy, cz, tx, ty, tz].every(fin)) continue;
        velSum += Math.hypot(cx - tx, cy - ty, cz - tz);
        velCount++;
        if (Math.hypot(cx, cy) < HEADING_SPEED_FLOOR_MS || Math.hypot(tx, ty) < HEADING_SPEED_FLOOR_MS) continue;
        let diff = Math.abs(Math.atan2(cx, cy) - Math.atan2(tx, ty)) * DEG;
        if (diff > 180) diff = 360 - diff;
        headSum += diff;
        headCount++;
    }
    return {
        headingDeg: headCount ? headSum / headCount : null,
        velocityMS: velCount ? velSum / velCount : null,
    };
}

/**
 * The mean angle, seen from the sensor, between a track's position and the true
 * position, over the frames where both exist. Degrees.
 *
 * A range error along the sightline moves a position without changing its bearing,
 * so this measures how well a candidate follows the true bearings, not its distance.
 * The angle is taken with atan2 of the cross and dot products, which stays accurate
 * for the very small angles a good fit produces, where acos loses its precision.
 */
export function meanAngleToTruth(S, track, T, valid = null) {
    if (!S || !track || !T) return null;
    const n = Math.min(Math.floor(S.length / 3), Math.floor(track.length / 3), Math.floor(T.length / 3));
    let sum = 0, count = 0;
    for (let f = 0; f < n; f++) {
        if (valid && !valid[f]) continue;
        const b = f * 3;
        const ux = track[b] - S[b], uy = track[b + 1] - S[b + 1], uz = track[b + 2] - S[b + 2];
        const vx = T[b] - S[b], vy = T[b + 1] - S[b + 1], vz = T[b + 2] - S[b + 2];
        const nu = Math.hypot(ux, uy, uz), nv = Math.hypot(vx, vy, vz);
        if (!fin(nu) || !fin(nv) || !(nu > 0 && nv > 0)) continue;
        const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        sum += Math.atan2(cross, ux * vx + uy * vy + uz * vz);
        count++;
    }
    return count ? (sum / count) * DEG : null;
}

/**
 * Flatten BOTBench entries into the row shape the figures expect: the same field
 * names the offline join writes, so one set of figure code serves both.
 *
 * Each row also carries its entry, as a property that is not enumerable, so JSON and
 * exports never see it. The chart window uses it to find the scenario's screenshot.
 */
export function rowsFromBotBenchEntries(entries, {datasetLabel = null} = {}) {
    const out = [];
    for (const entry of entries ?? []) {
        const row = entry?.row;
        if (!row) continue;
        const path = String(entry.relativePath ?? entry.name ?? "");
        const base = String(entry.name ?? "").replace(/\.all\.csv$/i, "").replace(/\.[^.]+$/, "");
        let truth = null;
        try { truth = entry.labelsText ? JSON.parse(entry.labelsText) : null; } catch (e) { /* unreadable: absent */ }
        const quality = row.quality ?? {};

        // Clip length: the folder name when it carries one, the answer key next,
        // and the run's own measurement last. Rounded to 0.1 s, so floating-point
        // noise in frames/rate does not split one clip length into several.
        const lengthFromPath = batchDurationSeconds({path});
        const lengthFromKey = truth?.provenance?.spec?.durationSeconds;
        const measured = fin(quality.durationS) ? Math.round(quality.durationS * 10) / 10 : null;
        const duration = fin(lengthFromPath) ? lengthFromPath : (fin(lengthFromKey) ? lengthFromKey : measured);

        // Pointing-error rung: the folder name, else the declared sigma, which the
        // sidecar supplies. On a wobble rung that sigma IS the amplitude, and it is
        // 0 on the clean rung, so a finite zero must survive. Without the sidecar
        // neither exists and the rung is left unknown.
        const rungFromPath = Number(path.match(/(?:^|\/)(\d+(?:\.\d+)?)deg(?:\/|$)/)?.[1]);
        const declared = quality.declaredLosSigmaDeg;
        const rung = fin(rungFromPath) ? rungFromPath : (fin(declared) ? declared : null);

        // Sensor-turn level: the heading change the answer key's spec gave the
        // platform, which rock_v3 sets per track. Without the sidecar it is unknown.
        const turnFromKey = truth?.provenance?.spec?.platform?.turnDeg;
        const turn = fin(turnFromKey) ? turnFromKey : null;

        const cls = classOf(base, truth);
        const results = entry.results ?? null;

        out.push({
            base,
            // The file's path under the folder that was scanned, for the charts' hover labels.
            path: path || null,
            set: path.includes("/") ? path.split("/")[0] : null,
            datasetLabel,
            d_class: cls,
            d_durationSeconds: duration,
            // Keep the requested batch duration distinct from the measured clip
            // length. It is known only when the scanned path names a batch folder.
            d_batchDurationSeconds: lengthFromPath,
            d_errorDeg: rung,
            d_turnDeg: turn,
            d_classCorrect: classCorrectFor(cls, truth, row.viableClasses),
            in_sidecarPaired: entry.sidecarText != null,
            in_objectClass: truth?.objectClass ?? null,
            in_realizedRmsDeg: truth?.realizedNoise?.rmsDegAllFrames ?? null,
            in_trueRangeMeanM: row.truthScore?.meanTruthRangeM ?? null,
            // A long run releases each file's full analysis once it is done, keeping
            // only small facts on the entry, so the aperture measured at completion
            // is read first and the positions are the fallback.
            in_apertureDeg: fin(entry.apertureDeg) ? entry.apertureDeg
                : apertureFromPositions(results?.dataset?.S, results?.truth?.track, results?.truth?.valid),
            q_frames: quality.frames ?? null,
            q_log10Rcond: quality.log10Rcond ?? null,
            q_noiseEst: quality.noiseEstDeg ?? null,
            // How straight and how much the sensor turned: the confound behind the
            // clip-length figures on rock_v3 (see sensorTurnFromPositions).
            q_straightness: quality.straightness ?? null,
            in_sensorTurnDeg: fin(entry.sensorTurnDeg) ? entry.sensorTurnDeg
                : sensorTurnFromPositions(results?.dataset?.S),
            r_verdict: row.verdictCode ?? null,
            r_viable: (row.viableClasses ?? []).join("+"),
            r_topKey: row.top?.key ?? null,
            r_topName: row.top?.name ?? null,
            r_topErr: row.top?.errDeg ?? null,
            r_topRange: row.top?.rangeStartM ?? null,
            r_topBlind: row.topRangeBlind ? 1 : 0,
            r_topRelSep: row.truthScore?.topRelSep ?? null,
            r_bestRelSep: row.truthScore?.bestRelSep ?? null,
            // The same two errors in metres, for the charts' choice of error measure.
            r_topSepM: row.truthScore?.topSepM ?? null,
            r_bestSepM: row.truthScore?.bestSepM ?? null,
            r_bestName: row.truthScore?.bestName ?? null,
            // Every candidate's error, for the solver figure: kept on the entry when the
            // run finished it or cached beside the row, else read from the analysis.
            r_candidates: entry.candidateErrors ?? candidateErrorsFrom(results),
        });
        Object.defineProperty(out[out.length - 1], "entry", {value: entry, enumerable: false});
    }
    return out;
}

/** Parse a joined results JSONL, dropping the header line the pipeline writes. */
export function rowsFromJsonl(text) {
    const rows = [];
    for (const line of String(text ?? "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const row = JSON.parse(trimmed);
            if (!row.header) rows.push({...row, d_batchDurationSeconds: batchDurationSeconds(row)});
        } catch (e) { /* one bad line must not lose the file */ }
    }
    return rows;
}
