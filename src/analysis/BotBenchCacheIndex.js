/**
 * BotBenchCacheIndex.js — the shape and rules of BOTBench's per-folder result
 * cache, with no file system in it.
 *
 * The cache is one `.botbench-cache.json` index per leaf folder plus a
 * `.botbench-cache/` folder of blobs. Schema 3 stores FIT UNITS, one blob each,
 * and remembers finished ROWS per solver selection:
 *
 *   results[fileName] = {
 *     hash, hashes, savedAt,
 *     units: {unitId: {blob, version, options, appVersion, elapsedMs, failures,
 *                      adopted, adoptedFrom, adoptedAt, legacyBatteryMs, savedAt}},
 *     rows:  {selectionKey: {row, chartData, elapsedMs, appVersion, solvers,
 *                            unitVersions, savedAt}},
 *   }
 *
 * WHY UNITS. A run that adds one solver must fit one unit and read the rest; a
 * change to one fitter must invalidate one unit and nothing else; and a run that
 * takes hours must never have to start again because the code around the fits
 * moved. So the expensive things are stored one by one, keyed by the input
 * hashes, the unit's own version and the options that shape it, and everything
 * cheap — the candidate set, its grading, the verdict, the row — is rebuilt from
 * them. The row of the last few selections is kept too, so a repeated run shows
 * its table without opening a blob.
 *
 * Every blob is self-describing: its `meta` repeats the index record, so an index
 * lost between batched writes can be recovered from the blobs on disk (see
 * unitMetaFromBlob), and a blob whose index entry is gone is still a fit.
 *
 * Schema 2 stored one blob per file holding the whole battery. Those entries are
 * still read: the expensive fits are split out of the old blob (legacyUnitsFromBattery)
 * and written as units the first time the file is run, so nothing that took hours
 * is fitted again on account of the schema.
 *
 * Pure functions only, so the browser dialog, the worker, an offline script and
 * the tests all share one rule set.
 */

import {UNIT_VERSIONS, sameOptions, unitOptions} from "./BotBenchSolvers";
import {packForCache, unpackFromCache} from "./BotBenchCacheCodec";
import {PHYSICAL_ENVELOPE_REVISION} from "../PhysicalEnvelopes";

// Bump when metrics, screening, ranking, or interpretation change. Fits keep
// their independent unit versions; a sampled adoption cannot validate old rows.
export const ROW_ASSESSMENT_REVISION = `2:${PHYSICAL_ENVELOPE_REVISION}`;

export const CACHE_SCHEMA = 3;
export const CACHE_FILENAME = ".botbench-cache.json";
export const CACHE_BLOB_DIR = ".botbench-cache";

/** How many finished rows one file keeps, one per solver selection, newest last. */
export const ROW_MEMOS_KEPT = 6;

/** The units a schema-2 blob holds as raw fits. The rest of the battery is refitted. */
export const LEGACY_UNITS = Object.freeze(["constAir", "profiles", "aircraft", "plausible",
    "lantern", "quadcopter", "families"]);

export const combinedHash = (h) => [h.csv, h.sidecar ?? "-", h.truth ?? "-"].join("|");

/**
 * Blob names are content-addressed over ALL THREE input hashes, not just the
 * first: two copies of one CSV with different sidecars are different files.
 */
function hashStem(hash) {
    const [csv = "", sidecar = "-", truth = "-"] = String(hash).split("|");
    return `${csv.slice(0, 32)}-${sidecar.slice(0, 12)}-${truth.slice(0, 12)}`;
}

/** The schema-2 blob name, kept to find and remove an old blob once it is split. */
export const legacyBlobName = (hash) => `${hashStem(hash)}.json`;

/** One blob per unit per file. */
export const unitBlobName = (hash, unitId) => `${hashStem(hash)}.${unitId}.json`;

export function emptyIndex() {
    return {schema: CACHE_SCHEMA, results: {}};
}

/**
 * Whether parsed index text is an index this build reads: schema 2 or 3, with
 * results. Anything else — a damaged file, another program's JSON, an index that a
 * newer build wrote under a schema this one does not know — is not an empty index,
 * and must never be overwritten as though it were one.
 */
export function isReadableIndex(parsed) {
    return !!parsed && typeof parsed === "object" && !!parsed.results
        && (parsed.schema === 2 || parsed.schema === CACHE_SCHEMA);
}

/**
 * An index as read from disk, in schema-3 shape. Schema 2 is accepted as it is:
 * its entries are recognised by isLegacyEntry. Anything else starts fresh.
 */
export function normalizeIndex(parsed) {
    if (!isReadableIndex(parsed)) return emptyIndex();
    return {...parsed, schema: CACHE_SCHEMA, results: parsed.results};
}

/**
 * The index as compact JSON text, in pieces of about `chunkChars` characters, for a
 * writable stream. Joined, the pieces parse to what JSON.stringify(data) parses to;
 * only the place of `results` among the top-level keys differs.
 *
 * WHY PIECES. An index holds about 12 KB for every file in its folder (measured on
 * rock_v3: 3.5 MB for 300 files), so a folder of a few thousand files is tens of
 * megabytes of text. One JSON.stringify makes that as a single string, and the
 * browser copies it again to send it to the file. Built one file's record at a time,
 * the largest string is one piece. Compact rather than indented: the one-space
 * indent added a third to the size (4.7 MB for the same 300 files).
 */
export function* indexTextChunks(data, chunkChars = 1 << 20) {
    const {results = {}, ...head} = data ?? {};
    const headText = JSON.stringify(head);
    let text = (headText === "{}" ? "{" : headText.slice(0, -1) + ",") + "\"results\":{";
    let first = true;
    for (const name of Object.keys(results)) {
        const value = JSON.stringify(results[name]);
        if (value === undefined) continue;
        text += (first ? "" : ",") + JSON.stringify(name) + ":" + value;
        first = false;
        if (text.length >= chunkChars) {
            yield text;
            text = "";
        }
    }
    yield text + "}}";
}

export const INDEX_WRITE_BATCH = 25;
export const INDEX_WRITE_DELAY_MS = 3000;
export const INDEX_WRITE_MAX_DELAY_MS = 60000;

/**
 * When a run writes a folder's index, for an index holding `entries` files: after
 * `batch` changed results, or `delayMs` after the first unwritten change.
 *
 * Every write is the WHOLE index, so fixed thresholds make the writing grow with the
 * square of the folder. At 25 results or 3 seconds, a folder of 3,000 files wrote an
 * index of about 47 MB as often as every 3 seconds for the rest of the run. Both
 * thresholds therefore grow with the index, which holds the timer's writing to about
 * a megabyte a second up to 5,000 files. What a later write can lose is cheap: the
 * unit records are found again from their blobs, and a row is rebuilt from its units.
 */
export function indexWritePolicy(entries) {
    const n = Number.isFinite(entries) && entries > 0 ? entries : 0;
    return {
        batch: Math.max(INDEX_WRITE_BATCH, Math.ceil(n / 10)),
        delayMs: Math.min(INDEX_WRITE_MAX_DELAY_MS, Math.max(INDEX_WRITE_DELAY_MS, n * 12)),
    };
}

/** A schema-2 entry: one blob for the whole battery, and no units yet. */
export function isLegacyEntry(hit) {
    return !!hit && typeof hit.battery === "string" && !hit.units;
}

/**
 * Whether a stored unit record may stand in for a fresh fit of that unit under
 * these options: a blob is named, the unit's version is this build's, the options
 * that shape the fit match, and the build matches — or the caller has checked
 * this unit under this build and says another build's fit may be adopted.
 */
export function unitRecordUsable(record, {unitId, options, appVersion, adoptable = false}) {
    return !!record && typeof record.blob === "string"
        && record.version === UNIT_VERSIONS[unitId]
        && sameOptions(record.options, unitOptions(unitId, options))
        && ((record.appVersion ?? null) === appVersion || adoptable);
}

/**
 * Whether a remembered row may be shown as it is: made by this build (or adopted
 * after a checked sample), from units of the versions this build has.
 */
export function rowMemoUsable(memo, {appVersion, unitVersions, adoptable = false}) {
    if (!memo || !memo.row) return false;
    if (memo.assessmentRevision !== ROW_ASSESSMENT_REVISION) return false;
    if ((memo.appVersion ?? null) !== appVersion && !adoptable) return false;
    const stored = memo.unitVersions ?? {};
    for (const [unitId, version] of Object.entries(unitVersions ?? {})) {
        if (stored[unitId] !== version) return false;
    }
    return true;
}

/**
 * The text of a unit blob: its index record as `meta`, and the result in the
 * codec's encoding. The constant-air sweep's `sorted` list is a copy of its
 * `results` in score order and is rebuilt on reading rather than stored twice —
 * it is 2.4 MB of the 7.5 MB a 120 s scenario's battery took.
 */
export function packUnitBlob(meta, result) {
    let stored = result;
    if (meta.unitId === "constAir" && result && Array.isArray(result.sorted)) {
        // Nulled in place rather than removed, so the key order — which the
        // fidelity comparison reads — survives the round trip.
        stored = {...result, sorted: null};
    }
    return JSON.stringify({meta, result: packForCache(stored)});
}

/** The inverse of packUnitBlob. */
export function readUnitBlob(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.meta) {
        throw new Error("BotBench cache: not a unit blob");
    }
    const result = unpackFromCache(parsed.result);
    if (parsed.meta.unitId === "constAir" && result && Array.isArray(result.results) && result.sorted === null) {
        result.sorted = result.results.slice().sort((a, b) => a.score - b.score);
    }
    return {meta: parsed.meta, result};
}

/** Only the `meta` of a unit blob, read without decoding the fit. */
export function unitMetaFromBlob(text) {
    // The meta comes first in the text and is small; a full parse would decode
    // megabytes of fit for a record of a few hundred bytes.
    const start = text.indexOf("{\"meta\":");
    if (start !== 0) return JSON.parse(text).meta ?? null;
    let depth = 0, i = 8;
    for (; i < text.length; i++) {
        const c = text[i];
        if (c === "\"") {
            i++;
            while (i < text.length && text[i] !== "\"") { if (text[i] === "\\") i++; i++; }
        } else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) break; }
    }
    return JSON.parse(text.slice(8, i + 1));
}

/**
 * The index record for a unit, from what the run knows about it. The same
 * record is written into the blob as its `meta`, with the file's hash added.
 */
export function unitRecord({unitId, blob, options, appVersion, elapsedMs = null, failures = [],
    adopted = false, adoptedFrom = null, adoptedAt = null, legacyBatteryMs = null, savedAt = null}) {
    return {
        blob, version: UNIT_VERSIONS[unitId],
        options: unitOptions(unitId, options),
        appVersion, elapsedMs, failures: (failures ?? []).map((f) => ({...f})),
        adopted, adoptedFrom, adoptedAt, legacyBatteryMs,
        savedAt: savedAt ?? new Date().toISOString(),
    };
}

/** A record recovered from a blob's meta, for an index that lost its entry. */
export function unitRecordFromMeta(meta) {
    const {unitId, hash, ...rest} = meta ?? {};
    return rest.blob ? rest : null;
}

/** Put a unit record on a file's index entry, making the entry when it is new. */
export function recordUnit(results, name, {hash, hashes}, unitId, record) {
    const entry = results[name] && results[name].hash === hash ? results[name]
        : {hash, hashes, savedAt: new Date().toISOString(), units: {}, rows: {}};
    entry.units ??= {};
    entry.rows ??= {};
    entry.units[unitId] = record;
    entry.savedAt = new Date().toISOString();
    results[name] = entry;
    return entry;
}

/** Remember a finished row under its selection key, keeping the newest few. */
export function recordRowMemo(results, name, {hash, hashes}, key, memo, keep = ROW_MEMOS_KEPT) {
    const entry = results[name] && results[name].hash === hash ? results[name]
        : {hash, hashes, savedAt: new Date().toISOString(), units: {}, rows: {}};
    entry.units ??= {};
    entry.rows ??= {};
    delete entry.rows[key];
    entry.rows[key] = {...memo, assessmentRevision: ROW_ASSESSMENT_REVISION, savedAt: new Date().toISOString()};
    const keys = Object.keys(entry.rows);
    for (const old of keys.slice(0, Math.max(0, keys.length - keep))) delete entry.rows[old];
    entry.savedAt = new Date().toISOString();
    results[name] = entry;
    return entry;
}

/** Mark a unit or row record adopted from another build under this one. */
export function adoptRecord(record, appVersion) {
    if (!record || (record.appVersion ?? null) === appVersion) return record;
    record.adoptedFrom = record.adoptedFrom ?? record.appVersion ?? "unknown";
    record.adopted = true;
    record.adoptedAt = new Date().toISOString();
    record.appVersion = appVersion;
    return record;
}

// The failures a schema-2 battery recorded, by the unit they belong to. The
// measured-wind note is made afresh when the battery is assembled, and the
// drone-control fit is refitted, so neither is carried over.
const LEGACY_FAILURE_UNIT = [
    ["Fixed-Wing Aircraft", "aircraft"],
    ["Sky Lantern / Balloon (free wind)", "lantern"],
    ["Quadcopter", "quadcopter"],
    ["Solution families", "families"],
];

/**
 * Split a schema-2 battery blob into the units it holds as raw fits. The result
 * is what TraverseBattery accepts as `units.cached`, plus the marks a caller
 * needs to write them out as units: `migrated`, and the old battery's whole time
 * as `legacyBatteryMs`, since the old blob timed the fits together.
 */
export function legacyUnitsFromBattery(battery, {elapsedMs = null} = {}) {
    if (!battery || typeof battery !== "object") return {};
    const failures = Array.isArray(battery.failures) ? battery.failures : [];
    const failuresFor = (unitId) => failures
        .filter((f) => LEGACY_FAILURE_UNIT.some(([method, unit]) => unit === unitId
            && (f.method === method || (unitId === "families" && /range band$/.test(f.method ?? "")))))
        .map((f) => ({...f}));
    const unit = (unitId, result) => ({result, failures: failuresFor(unitId), elapsedMs: null,
        legacyBatteryMs: elapsedMs, migrated: true, cacheable: true});
    const out = {};
    if (battery.sweep) out.constAir = unit("constAir", battery.sweep);
    if (battery.fastProfile && battery.slowProfile) {
        out.profiles = unit("profiles", {fastProfile: battery.fastProfile, slowProfile: battery.slowProfile});
    }
    // A fit that failed is a null result with its failure beside it: the same
    // thing a fresh run of that unit returns, so the failure tile comes back.
    out.aircraft = unit("aircraft", battery.aircraft ?? null);
    if (battery.plausible) out.plausible = unit("plausible", battery.plausible);
    out.lantern = unit("lantern", battery.lantern ?? null);
    out.quadcopter = unit("quadcopter", battery.quad ?? null);
    if (battery.families) out.families = unit("families", battery.families);
    return out;
}

/**
 * The fit time a row reports: every unit's own time, and one old battery's time
 * where units came out of a schema-2 blob that timed them together.
 */
export function elapsedFromUnits(records) {
    let total = 0, legacy = 0;
    for (const record of Object.values(records ?? {})) {
        if (!record) continue;
        if (Number.isFinite(record.elapsedMs)) total += record.elapsedMs;
        if (Number.isFinite(record.legacyBatteryMs)) legacy = Math.max(legacy, record.legacyBatteryMs);
    }
    return total + legacy;
}

/**
 * Compare a freshly fitted unit with a stored one, through the codec, so NaN and
 * Infinity compare as themselves. Both sides are the codec's encoding of the
 * result as stored, so the sweep's rebuilt `sorted` is left out of both.
 */
export function sameUnitResult(freshResult, storedText) {
    let stored;
    try { stored = JSON.parse(storedText); } catch (e) { return false; }
    const meta = stored?.meta ?? {};
    return packUnitBlob(meta, freshResult) === JSON.stringify({meta, result: stored.result});
}

/**
 * Whether two results agree to within floating-point noise: every number within
 * `rel` of the larger magnitude or `abs` absolutely, NaN equal to NaN, and every
 * other value, key and length equal. Keys named in `ignore` are skipped.
 *
 * WHY NOT EXACT EQUALITY. A fit is deterministic on one engine, but the same
 * code on another build of V8 — Node against Chrome, or Chrome after an update —
 * lands a few units in the last place apart (measured: 2.5e-11 m on a 5,700 m
 * altitude, 1e-16 on a drone-control position, the same solved parameters and
 * iteration counts). Refusing a stored fit for that would refit a folder that
 * took hours for a difference nothing downstream can see. The default tolerance
 * is nine orders of magnitude below the value, far under any change a fitter
 * could make on purpose.
 */
export function valuesAgree(a, b, {rel = 1e-9, abs = 1e-9, ignore = ["elapsedMs"]} = {}) {
    const skip = new Set(ignore);
    const same = (x, y) => {
        if (x === y) return true;
        if (typeof x === "number" && typeof y === "number") {
            if (Number.isNaN(x) && Number.isNaN(y)) return true;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
            return Math.abs(x - y) <= abs + rel * Math.max(Math.abs(x), Math.abs(y));
        }
        if (x === null || y === null || typeof x !== "object" || typeof y !== "object") return false;
        if (ArrayBuffer.isView(x) || ArrayBuffer.isView(y)) {
            if (!ArrayBuffer.isView(x) || !ArrayBuffer.isView(y)) return false;
            if (x.constructor !== y.constructor || x.length !== y.length) return false;
            for (let i = 0; i < x.length; i++) if (!same(x[i], y[i])) return false;
            return true;
        }
        if (x instanceof Map || y instanceof Map) {
            if (!(x instanceof Map) || !(y instanceof Map) || x.size !== y.size) return false;
            for (const [k, v] of x) { if (!y.has(k) || !same(v, y.get(k))) return false; }
            return true;
        }
        if (Array.isArray(x) !== Array.isArray(y)) return false;
        const kx = Object.keys(x).filter((k) => !skip.has(k)), ky = Object.keys(y).filter((k) => !skip.has(k));
        if (kx.length !== ky.length) return false;
        for (const k of kx) {
            if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
            if (!same(x[k], y[k])) return false;
        }
        return true;
    };
    return same(a, b);
}

/** Whether a fresh unit result reproduces a stored blob's, to floating-point noise. */
export function unitResultAgrees(freshResult, storedText) {
    let stored;
    try { stored = readUnitBlob(storedText); } catch (e) { return false; }
    let fresh = freshResult;
    const unitId = stored.meta?.unitId;
    if (unitId === "constAir" && fresh && Array.isArray(fresh.sorted)) {
        // Both sides carry the rebuilt copy; compare the stored form of each.
        fresh = {...fresh, sorted: null};
        stored.result = {...stored.result, sorted: null};
    }
    if (unitId === "droneControl") return droneControlAgrees(fresh, stored.result);
    return valuesAgree(fresh, stored.result);
}

/**
 * The drone-control fit is the one unit whose optimizer stops at an iteration
 * budget (400 Nelder-Mead steps) rather than at convergence. A last-bit
 * difference between two engines — Node against Chrome, or Chrome after an
 * update — moves where the descent stands after 400 steps, so the same code
 * lands centimetres apart: measured, up to 0.3 m on a 5 km track with the same
 * residual to five decimals, on about 1.5% of the rock_v3 files. Nothing
 * downstream can tell those two fits apart, but the floating-point tolerance
 * above can, and one such file in a ten-file sample had every file's drone
 * control fitted again. So this unit is reproduced when its positions agree
 * within DRONE_CONTROL_POSITION_TOLERANCE_M and its residual within
 * DRONE_CONTROL_RESIDUAL_TOLERANCE_DEG; the solved vector, iteration counts and
 * description follow the positions and are not compared.
 */
export const DRONE_CONTROL_POSITION_TOLERANCE_M = 1;
export const DRONE_CONTROL_RESIDUAL_TOLERANCE_DEG = 1e-3;

function droneControlAgrees(fresh, stored) {
    if (fresh === null || stored === null) return fresh === stored;
    if (!fresh || !stored) return false;
    const a = fresh.positions, b = stored.positions;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 3) {
        const d = Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
        if (!(d <= DRONE_CONTROL_POSITION_TOLERANCE_M)) return false;
    }
    const ea = fresh.params?.errDeg, eb = stored.params?.errDeg;
    if (Number.isFinite(ea) !== Number.isFinite(eb)) return false;
    return !Number.isFinite(ea) || Math.abs(ea - eb) <= DRONE_CONTROL_RESIDUAL_TOLERANCE_DEG;
}

// ---------------------------------------------------------------------------
// what is on disk, for Flush Cache
// ---------------------------------------------------------------------------

/**
 * What a folder's cache holds on disk: its index file and its fit blobs, counted
 * and sized. Reading needs no write grant, so a read-only folder can be measured
 * even though it cannot be flushed. `onBlob(bytes)` is called per blob, for a
 * progress line over a large tree.
 */
export async function measureCacheOnDisk(handle, onBlob = null) {
    const out = {indexFiles: 0, indexBytes: 0, blobs: 0, blobBytes: 0};
    try {
        const file = await (await handle.getFileHandle(CACHE_FILENAME)).getFile();
        out.indexFiles++;
        out.indexBytes += file.size;
    } catch (e) { /* no index in this folder */ }
    try {
        const dir = await handle.getDirectoryHandle(CACHE_BLOB_DIR);
        for await (const [, child] of dir.entries()) {
            if (child.kind !== "file") continue;
            const size = (await child.getFile()).size;
            out.blobs++;
            out.blobBytes += size;
            onBlob?.(size);
        }
    } catch (e) { /* no blobs in this folder */ }
    return out;
}

/** "1.3 GB", "340 MB", "12 KB", "900 bytes". */
export function formatBytes(bytes) {
    if (!(bytes > 0)) return "0 bytes";
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} bytes`;
}

/** "about 3.2 hours", "about 12 minutes", "about 40 seconds". */
export function describeDuration(ms) {
    if (!(ms > 0)) return "no recorded time";
    if (ms >= 3600000) return `about ${(ms / 3600000).toFixed(1)} hours`;
    if (ms >= 60000) return `about ${Math.round(ms / 60000)} minutes`;
    return `about ${Math.round(ms / 1000)} seconds`;
}

/**
 * The fitting time an index records, in milliseconds: each unit's own time; for
 * units split from one schema-2 battery, that battery's time once per file (every
 * unit of the split carries the same legacyBatteryMs); and a schema-2 entry not
 * yet split, its own time.
 */
export function recordedFitMs(data) {
    let total = 0;
    for (const entry of Object.values(data?.results ?? {})) {
        if (isLegacyEntry(entry)) {
            if (Number.isFinite(entry.elapsedMs)) total += entry.elapsedMs;
            continue;
        }
        let legacy = 0;
        for (const unit of Object.values(entry?.units ?? {})) {
            if (Number.isFinite(unit?.elapsedMs)) total += unit.elapsedMs;
            if (Number.isFinite(unit?.legacyBatteryMs)) legacy = Math.max(legacy, unit.legacyBatteryMs);
        }
        total += legacy;
    }
    return total;
}
