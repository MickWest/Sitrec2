import {rankAllHypotheses} from "../TraverseRanking";

export const TRACK_OUTPUT_DIR = "output";
// Inside output/, so the folder scan, which never enters output/, skips them too.
export const ALL_TRACKS_OUTPUT_DIR = "AllTracks";
export const SEPARATE_TRACKS_OUTPUT_DIR = "AllTracksSeparate";
export const TRACK_OUTPUT_COLUMNS = [
    "TrackID", "Time", "AlgorithmID",
    "EstimatedPositionX", "EstimatedPositionY", "EstimatedPositionZ",
    "CovarianceXX", "CovarianceYY", "CovarianceZZ",
    "CovarianceXY", "CovarianceXZ", "CovarianceYZ",
];

/**
 * The modes writeTrackOutput takes. "best" writes the top candidate,
 * "allCombined" every candidate in one file, and "allSeparate" one file for
 * each candidate in a folder for each source. The Parquet modes write the
 * same candidates as "best" and "allCombined", with typed columns.
 */
const MODE_FOLDERS = {
    best: [],
    allCombined: [ALL_TRACKS_OUTPUT_DIR],
    allSeparate: [SEPARATE_TRACKS_OUTPUT_DIR],
    bestParquet: [],
    allParquet: [ALL_TRACKS_OUTPUT_DIR],
};
const PARQUET_MODES = new Set(["bestParquet", "allParquet"]);

/** Preserve the source name, adding ".csv" or replacing its final ".csv" with ".parquet". */
export function trackOutputName(sourceName, mode = "best") {
    if (PARQUET_MODES.has(mode)) return `${trackOutputBase(sourceName)}.parquet`;
    return /\.csv$/i.test(sourceName) ? sourceName : `${sourceName}.csv`;
}

/** The output name without ".csv": the name of a source's folder of separate files. */
export function trackOutputBase(sourceName) {
    return trackOutputName(sourceName).replace(/\.csv$/i, "");
}

/** A separate file is the output name with "_<method>" before ".csv" (x.csv -> x_gfKalman.csv). */
export function separateTrackFileName(sourceName, method) {
    return `${trackOutputBase(sourceName)}_${method}.csv`;
}

/**
 * A parent handle exists only when the track folder was reached through it.
 * For "allSeparate" the path is the source's folder, not one file.
 */
export function trackOutputLocation(entry, mode = "best") {
    const beside = /^(all|input)$/i.test(entry.dirHandle?.name ?? "") && entry.parentHandle;
    const base = beside ? entry.parentHandle : entry.dirHandle;
    const dir = String(entry.dirPath ?? "").replace(/\/$/, "");
    const prefix = beside ? dir.replace(/(^|\/)[^/]+$/, "") : dir;
    const last = mode === "allSeparate" ? trackOutputBase(entry.name) : trackOutputName(entry.name, mode);
    return {base, path: [prefix, TRACK_OUTPUT_DIR, ...MODE_FOLDERS[mode], last].filter(Boolean).join("/")};
}

export function canWriteTrackOutput(entry) {
    return !!entry.dirHandle && entry.cacheWritable !== false;
}

function csvCell(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function missingSamplesReason({dataset, outputSamples} = {}) {
    if (!(dataset?.n > 0) || !outputSamples || outputSamples.times?.length !== dataset.n
        || !outputSamples.times.every(Number.isFinite)) {
        return "Source sample identifiers and times are unavailable.";
    }
    return null;
}

// Direction-only candidates carry a finite helper track for drawing. That
// artificial range must never be presented as estimated target positions.
function hasFinitePositions(h, n) {
    return !h.atInfinity && h.track?.length === n * 3 && h.track.every(Number.isFinite);
}

/**
 * The key alone does not name one candidate: the wind variants of a model
 * share it, and so do the orders of the Monte Carlo sweep. The wind mode and
 * the order are part of the identifier, so a candidate has the same name in
 * every output file and in every source's files.
 */
export function trackAlgorithmID(h) {
    return ["sitrec", h.key, h.windMode && `${h.windMode}Wind`,
        h.params?.mcOrder != null && `order${h.params.mcOrder}`].filter(Boolean).join("_");
}

function candidateRows({dataset, outputSamples}, h, algorithmID) {
    const rows = [];
    for (let f = 0; f < dataset.n; f++) {
        const i = f * 3;
        rows.push([outputSamples.trackId, outputSamples.times[f], algorithmID,
            h.track[i], h.track[i + 1], h.track[i + 2],
            // No calibrated positional covariance is available for these fits.
            "", "", "", "", "", ""].map(csvCell).join(","));
    }
    return rows;
}

function toCSV(rows) {
    return [TRACK_OUTPUT_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

function bestCandidate(results) {
    const missing = missingSamplesReason(results);
    if (missing) return {reason: missing};
    const top = rankAllHypotheses(results.hypotheses ?? [], {useTruth: false, dataset: results.dataset})[0]?.h;
    if (!top) return {reason: "No candidate was produced."};
    if (top.atInfinity) return {reason: "The top candidate has no finite target position."};
    if (!hasFinitePositions(top, results.dataset.n)) return {reason: "The top candidate has no complete finite track."};
    const algorithmID = trackAlgorithmID(top);
    return {candidates: [{h: top, algorithmID}], algorithmID, samples: results.dataset.n};
}

/** Export the selected path in the analysis's input XYZ frame, in metres. */
export function buildTrackOutputCSV(results) {
    const {candidates, ...facts} = bestCandidate(results);
    if (!candidates) return facts;
    return {csv: toCSV(candidateRows(results, candidates[0].h, facts.algorithmID)), ...facts};
}

/**
 * Every candidate that has finite positions, in the order of the ranking
 * without truth (best first). A reader groups rows by AlgorithmID, and the
 * separate files are named by it, so two candidates that would still share
 * one get a count added (_2, _3) rather than having their rows merged.
 */
function exportableCandidates(results) {
    const missing = missingSamplesReason(results);
    if (missing) return {reason: missing};
    const ranked = rankAllHypotheses(results.hypotheses ?? [], {useTruth: false, dataset: results.dataset})
        .map(item => item.h);
    if (!ranked.length) return {reason: "No candidate was produced."};
    const exported = ranked.filter(h => hasFinitePositions(h, results.dataset.n));
    if (!exported.length) return {reason: "No candidate has a complete finite track."};
    const counts = new Map();
    const candidates = exported.map(h => {
        const id = trackAlgorithmID(h);
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        return {h, algorithmID: count === 1 ? id : `${id}_${count}`};
    });
    return {candidates, algorithmIDs: candidates.map(c => c.algorithmID),
        samples: results.dataset.n, omitted: ranked.length - exported.length};
}

/** Every exportable candidate in one file: one block of rows per candidate, best first. */
export function buildAllTracksOutputCSV(results) {
    const {candidates, ...facts} = exportableCandidates(results);
    if (!candidates) return facts;
    return {csv: toCSV(candidates.flatMap(c => candidateRows(results, c.h, c.algorithmID))), ...facts};
}

/** Every exportable candidate in its own file; the method is the AlgorithmID without "sitrec_". */
export function buildSeparateTrackOutputCSVs(results) {
    const {candidates, ...facts} = exportableCandidates(results);
    if (!candidates) return facts;
    return {files: candidates.map(c => ({method: c.algorithmID.replace(/^sitrec_/, ""),
        csv: toCSV(candidateRows(results, c.h, c.algorithmID))})), ...facts};
}

async function buildParquetOutput(results, {candidates, ...facts}) {
    if (!candidates) return facts;
    // Keep the writer in a separate webpack chunk, loaded only for a Parquet export.
    const {parquetWriteBuffer} = await import(/* webpackChunkName: "parquet-writer" */ "hyparquet-writer");
    const count = results.dataset.n * candidates.length;
    const columnData = TRACK_OUTPUT_COLUMNS.map((name, i) => {
        const isString = i === 0 || i === 2;
        return {name, type: isString ? "STRING" : "DOUBLE", nullable: i >= 6,
            data: i >= 6 ? new Array(count).fill(null) : isString ? new Array(count) : new Float64Array(count)};
    });
    let row = 0;
    for (const {h, algorithmID} of candidates) {
        for (let f = 0; f < results.dataset.n; f++, row++) {
            columnData[0].data[row] = String(results.outputSamples.trackId);
            columnData[1].data[row] = results.outputSamples.times[f];
            columnData[2].data[row] = algorithmID;
            for (let axis = 0; axis < 3; axis++) columnData[3 + axis].data[row] = h.track[f * 3 + axis];
        }
    }
    return {parquet: parquetWriteBuffer({columnData}), ...facts};
}

/** The best-track columns, with null optional covariance and double-precision numbers. */
export function buildTrackOutputParquet(results) {
    return buildParquetOutput(results, bestCandidate(results));
}

/** Every finite candidate in one Parquet file, in the same order as combined CSV. */
export function buildAllTracksOutputParquet(results) {
    return buildParquetOutput(results, exportableCandidates(results));
}

async function outputDirectory(base, folders, create) {
    let directory = base;
    for (const name of folders) directory = await directory.getDirectoryHandle(name, {create});
    return directory;
}

/** The directory, or null when it does not exist. */
async function existingDirectory(base, folders) {
    try {
        return await outputDirectory(base, folders, false);
    } catch (error) {
        if (error?.name === "NotFoundError") return null;
        throw error;
    }
}

async function writeFile(directory, name, data) {
    const file = await directory.getFileHandle(name, {create: true});
    const writable = await file.createWritable();
    try {
        await writable.write(data);
        await writable.close();
    } catch (error) {
        try { await writable.abort(); } catch (_) { /* retain the original write error */ }
        throw error;
    }
}

// A file from an earlier run must not stay behind, to be read as this run's result.
async function removeEarlierOutput(entry, mode) {
    const directory = await existingDirectory(trackOutputLocation(entry, mode).base,
        [TRACK_OUTPUT_DIR, ...MODE_FOLDERS[mode]]);
    try {
        await directory?.removeEntry(trackOutputName(entry.name, mode));
        return !!directory;
    } catch (error) {
        if (error?.name === "NotFoundError") return false;
        throw error;
    }
}

/**
 * Removes this source's separate files that the current run did not write,
 * for example a method that a later run no longer fits. Only files named as
 * this source's separate files are removed; anything else in the folder stays.
 */
async function removeEarlierSeparateFiles(directory, sourceName, keep) {
    const prefix = `${trackOutputBase(sourceName)}_`;
    const earlier = [];
    for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "file" && name.startsWith(prefix) && /\.csv$/i.test(name) && !keep.has(name)) {
            earlier.push(name);
        }
    }
    for (const name of earlier) await directory.removeEntry(name);
    return earlier.length;
}

async function writeSeparateTrackOutput(entry) {
    const {files, reason, ...facts} = buildSeparateTrackOutputCSVs(entry.results);
    const {base, path} = trackOutputLocation(entry, "allSeparate");
    const folders = [TRACK_OUTPUT_DIR, SEPARATE_TRACKS_OUTPUT_DIR, trackOutputBase(entry.name)];
    const keep = new Set();
    const directory = files ? await outputDirectory(base, folders, true) : await existingDirectory(base, folders);
    for (const file of files ?? []) {
        const name = separateTrackFileName(entry.name, file.method);
        await writeFile(directory, name, file.csv);
        keep.add(name);
    }
    const removed = directory ? await removeEarlierSeparateFiles(directory, entry.name, keep) : 0;
    if (!files) {
        return {written: false, removed,
            reason: removed ? `${reason} ${removed} output file(s) from an earlier run were removed.` : reason};
    }
    return {written: true, path, files: files.length, removed, ...facts};
}

/** Writes the CSV or Parquet output that `mode` names. */
export async function writeTrackOutput(entry, {mode = "best"} = {}) {
    if (!canWriteTrackOutput(entry)) {
        return {written: false, reason: "Choose Folder (Caching) to give track output files write access."};
    }
    if (mode === "allSeparate") return writeSeparateTrackOutput(entry);
    const output = mode === "bestParquet" ? await buildTrackOutputParquet(entry.results)
        : mode === "allParquet" ? await buildAllTracksOutputParquet(entry.results)
        : mode === "allCombined" ? buildAllTracksOutputCSV(entry.results) : buildTrackOutputCSV(entry.results);
    const {csv, parquet, reason, ...facts} = output;
    const data = parquet ?? csv;
    if (!data) {
        const removed = await removeEarlierOutput(entry, mode);
        return {written: false, removed,
            reason: removed ? `${reason} The output file from an earlier run was removed.` : reason};
    }
    const {base, path} = trackOutputLocation(entry, mode);
    await writeFile(await outputDirectory(base, [TRACK_OUTPUT_DIR, ...MODE_FOLDERS[mode]], true),
        trackOutputName(entry.name, mode), data);
    return {written: true, path, ...facts};
}
