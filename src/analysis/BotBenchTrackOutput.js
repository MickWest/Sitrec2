import {rankAllHypotheses} from "../TraverseRanking";

export const TRACK_OUTPUT_DIR = "output";
export const TRACK_OUTPUT_COLUMNS = [
    "TrackID", "Time", "AlgorithmID",
    "EstimatedPositionX", "EstimatedPositionY", "EstimatedPositionZ",
    "CovarianceXX", "CovarianceYY", "CovarianceZZ",
    "CovarianceXY", "CovarianceXZ", "CovarianceYZ",
];

/** A parent handle exists only when the track folder was reached through it. */
export function trackOutputLocation(entry) {
    const beside = /^(all|input)$/i.test(entry.dirHandle?.name ?? "") && entry.parentHandle;
    const base = beside ? entry.parentHandle : entry.dirHandle;
    const dir = String(entry.dirPath ?? "").replace(/\/$/, "");
    const prefix = beside ? dir.replace(/(^|\/)[^/]+$/, "") : dir;
    return {base, path: [prefix, TRACK_OUTPUT_DIR, entry.name].filter(Boolean).join("/")};
}

export function canWriteTrackOutput(entry) {
    return !!entry.dirHandle && entry.cacheWritable !== false;
}

function csvCell(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Export the selected path in the analysis's input XYZ frame, in metres. */
export function buildTrackOutputCSV(results) {
    const {dataset, outputSamples} = results ?? {};
    if (!(dataset?.n > 0) || !outputSamples || outputSamples.times?.length !== dataset.n) {
        return {reason: "Source sample identifiers and times are unavailable."};
    }
    const top = rankAllHypotheses(results.hypotheses ?? [], {useTruth: false, dataset})[0]?.h;
    if (!top) return {reason: "No candidate was produced."};
    // Direction-only candidates carry a finite helper track for drawing. That
    // artificial range must never be presented as estimated target positions.
    if (top.atInfinity) return {reason: "The top candidate has no finite target position."};
    if (!top.track || top.track.length !== dataset.n * 3
        || !top.track.every(Number.isFinite)
        || !outputSamples.times.every(Number.isFinite)) {
        return {reason: "The top candidate has no complete finite track."};
    }
    const algorithmID = `sitrec_${top.key}`;
    const rows = [TRACK_OUTPUT_COLUMNS.join(",")];
    for (let f = 0; f < dataset.n; f++) {
        const i = f * 3;
        rows.push([outputSamples.trackId, outputSamples.times[f], algorithmID,
            top.track[i], top.track[i + 1], top.track[i + 2],
            // No calibrated positional covariance is available for these fits.
            "", "", "", "", "", ""].map(csvCell).join(","));
    }
    return {csv: rows.join("\r\n") + "\r\n", algorithmID, samples: dataset.n};
}

export async function writeTrackOutput(entry) {
    if (!canWriteTrackOutput(entry)) {
        return {written: false, reason: "Choose Folder (Caching) to give track output files write access."};
    }
    const output = buildTrackOutputCSV(entry.results);
    if (!output.csv) return {written: false, reason: output.reason};
    const {base, path} = trackOutputLocation(entry);
    const directory = await base.getDirectoryHandle(TRACK_OUTPUT_DIR, {create: true});
    const file = await directory.getFileHandle(entry.name, {create: true});
    const writable = await file.createWritable();
    try {
        await writable.write(output.csv);
        await writable.close();
    } catch (error) {
        try { await writable.abort(); } catch (_) { /* retain the original write error */ }
        throw error;
    }
    return {written: true, path, algorithmID: output.algorithmID, samples: output.samples};
}
