import {parseKLVFile} from "../MISBUtils";
import {MISB} from "../MISBFields";
import {analyzeMisbTiming, analyzePtsSync, renderMisbTimingReport, summarizeTimingAnalysis} from "./MisbTimingStats";
import {getPrimaryVideoPTSus, getPrimaryVideoStream, scanTransportStreamForMetadata} from "./TSMetadataScanner";

export const TRANSPORT_STREAM_EXTENSIONS = new Set(["ts", "mts", "m2ts", "mpg", "mpeg"]);
export const KLV_EXTENSIONS = new Set(["klv"]);
export const UNSUPPORTED_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm"]);
export const VIDEO_FOLDER_ANALYSIS_EXTENSIONS = new Set([
    ...TRANSPORT_STREAM_EXTENSIONS,
    ...KLV_EXTENSIONS,
    ...UNSUPPORTED_VIDEO_EXTENSIONS,
]);

function extensionForName(name = "") {
    const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
}

function fileSize(fileLike) {
    return fileLike?.size ?? fileLike?.byteLength ?? fileLike?.length ?? 0;
}

async function readWholeFile(fileLike) {
    if (fileLike instanceof ArrayBuffer) return fileLike;
    if (fileLike instanceof Uint8Array) {
        return fileLike.buffer.slice(fileLike.byteOffset, fileLike.byteOffset + fileLike.byteLength);
    }
    if (typeof fileLike?.arrayBuffer === "function") {
        return await fileLike.arrayBuffer();
    }
    if (typeof fileLike?.slice === "function") {
        const part = fileLike.slice(0, fileSize(fileLike));
        if (part instanceof ArrayBuffer) return part;
        if (part instanceof Uint8Array) return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
        if (typeof part.arrayBuffer === "function") return await part.arrayBuffer();
    }
    throw new Error("File-like object does not support arrayBuffer() or slice()");
}

function bestAnalysis(analyses) {
    if (!analyses.length) return null;
    const severityScore = {error: 0, warn: 1, info: 2, ok: 3};
    return [...analyses].sort((a, b) => {
        const severityDelta = (severityScore[b.analysis.severity] ?? 0) - (severityScore[a.analysis.severity] ?? 0);
        if (severityDelta !== 0) return severityDelta;
        return (b.analysis.recordCount ?? 0) - (a.analysis.recordCount ?? 0);
    })[0];
}

function makeUnsupportedResult({name, relativePath, size, ext}) {
    return {
        file: {name, relativePath, size, ext},
        status: "unsupported",
        container: ext ? ext.toUpperCase() : "unknown",
        message: ext
            ? `.${ext} files are not scanned yet. Current exact scan support is TS/MTS/M2TS and standalone KLV.`
            : "No supported extension found.",
        analyses: [],
        summary: {
            sourceName: relativePath || name,
            container: ext ? ext.toUpperCase() : "unknown",
            severity: "info",
            verdict: "Unsupported container for this scan.",
            flags: "unsupported_container",
            recordCount: null,
        },
        report: "",
    };
}

function normalizeVideoPts(scan) {
    const pts = getPrimaryVideoPTSus(scan);
    return Array.isArray(pts) ? pts : [];
}

// ---- Per-frame ("virtual frame") export support ----
// Reconstructs the §12 CVideoPatchedData virtual timeline from the video PES
// PTS array (no decoder needed) so a per-frame CSV can include the synthesized
// gap-fill "held" frames. The mapping mirrors CVideoPatchedData's algorithm
// exactly — keep in sync with src/CVideoPatchedData.js if that changes.

function medianUs(sortedAscending) {
    const n = sortedAscending.length;
    if (n === 0) return null;
    const mid = Math.floor(n / 2);
    return n % 2 ? sortedAscending[mid] : (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
}

function nominalFrameDurationUs(sortedPts) {
    const intervals = [];
    for (let i = 1; i < sortedPts.length; i++) {
        const d = sortedPts[i] - sortedPts[i - 1];
        if (d > 0) intervals.push(d);
    }
    intervals.sort((a, b) => a - b);
    return medianUs(intervals);
}

function buildVirtualFrames(videoFramePTSus) {
    const finite = (Array.isArray(videoFramePTSus) ? videoFramePTSus : [])
        .filter(v => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
    if (finite.length < 2) return null;
    const frameDuration_us = nominalFrameDurationUs(finite);
    if (!(frameDuration_us > 0)) return null;
    const halfStep = frameDuration_us / 2;
    const T0 = finite[0];
    const TN = finite[finite.length - 1];
    const map = [];
    const virtualPTSus = [];
    let S = 0;
    for (let V = 0; ; V++) {
        const targetPTS = T0 + V * frameDuration_us;
        if (targetPTS > TN + halfStep) break;
        while (S + 1 < finite.length && finite[S + 1] <= targetPTS + halfStep) S++;
        map.push(S);
        virtualPTSus.push(targetPTS);
        if (map.length > 10_000_000) break; // runaway guard
    }
    return {sourcePTSus: finite, map, virtualPTSus, frameDuration_us, T0};
}

function firstFiniteUts(misb) {
    for (let i = 0; i < misb.length; i++) {
        const u = misb[i]?.[MISB.UnixTimeStamp];
        if (typeof u === "number" && Number.isFinite(u)) return u;
    }
    return 0;
}

// One row per VIRTUAL video frame. Paired to the nearest KLV record on the PES
// PTS axis when present (synchronous), else on UnixTimeStamp relative to the
// recording start (asynchronous fallback) — the same dichotomy as
// CNodeTrackFromMISB. Decision 1A: nearest record, raw values (no interpolation).
// Decision 2A: only the MISB tags populated in this file, as named columns.
function buildFrameRows(misb, videoFramePTSus) {
    const vf = buildVirtualFrames(videoFramePTSus);
    if (!vf) return {rows: [], columns: []};

    const recordCount = misb.length;
    const pes = Array.isArray(misb.pesPTSus) ? misb.pesPTSus : null;
    const hasPes = !!pes && pes.length === recordCount && pes.some(v => Number.isFinite(v));

    const pairingMode = hasPes ? "pts" : "uts";
    const uts0 = hasPes ? 0 : firstFiniteUts(misb);
    const axis = [];
    for (let i = 0; i < recordCount; i++) {
        const raw = hasPes ? pes[i] : misb[i]?.[MISB.UnixTimeStamp];
        if (typeof raw === "number" && Number.isFinite(raw)) {
            axis.push({t: hasPes ? raw : raw - uts0, recordIndex: i});
        }
    }
    axis.sort((a, b) => a.t - b.t || a.recordIndex - b.recordIndex);

    // Populated MISB columns, ordered by tag number.
    const populated = Object.entries(MISB)
        .filter(([, tag]) => Number.isInteger(tag))
        .map(([name, tag]) => ({name, tag}))
        .sort((a, b) => a.tag - b.tag)
        .filter(({tag}) => misb.some(r => r && r[tag] !== undefined && r[tag] !== null && r[tag] !== ""));
    const columns = populated.map(e => e.name);

    const rows = [];
    let p = 0;
    for (let V = 0; V < vf.map.length; V++) {
        const S = vf.map[V];
        const isDuplicate = V > 0 && vf.map[V] === vf.map[V - 1];
        const frameTime = hasPes ? vf.virtualPTSus[V] : vf.virtualPTSus[V] - vf.T0;
        while (p + 1 < axis.length &&
               Math.abs(axis[p + 1].t - frameTime) <= Math.abs(axis[p].t - frameTime)) {
            p++;
        }
        const nearest = axis.length ? axis[p] : null;
        const recordIndex = nearest ? nearest.recordIndex : null;
        const rec = recordIndex != null ? misb[recordIndex] : null;
        const row = {
            frame: V,
            isDuplicate: isDuplicate ? 1 : 0,
            sourceFrame: S,
            virtualTimeS: (vf.virtualPTSus[V] - vf.T0) / 1e6,
            virtualPtsUs: Math.round(vf.virtualPTSus[V]),
            sourcePtsUs: Math.round(vf.sourcePTSus[S]),
            pairingMode,
            klvRecordIndex: recordIndex,
            klvPesPtsUs: pes && recordIndex != null && Number.isFinite(pes[recordIndex]) ? Math.round(pes[recordIndex]) : null,
            klvUtsUs: rec && Number.isFinite(rec[MISB.UnixTimeStamp]) ? rec[MISB.UnixTimeStamp] : null,
            klvDeltaUs: nearest ? Math.round(nearest.t - frameTime) : null,
            misb: {},
        };
        for (const e of populated) {
            const v = rec ? rec[e.tag] : undefined;
            row.misb[e.name] = v === undefined ? null : v;
        }
        rows.push(row);
    }
    return {rows, columns};
}

async function analyzeKlvBuffer(buffer, context) {
    const misb = parseKLVFile(buffer, context.pesEntries ?? null, context.videoFirstPESus ?? null, {silent: true});
    if (!Array.isArray(misb)) {
        return null;
    }
    const ptsSync = analyzePtsSync(misb, context.videoFramePTSus, {
        includeRows: false,
        sourceName: context.sourceName,
        klvPid: context.pid ?? null,
        videoPid: context.videoPid ?? null,
    });
    const analysis = analyzeMisbTiming(misb, {
        sourceName: context.sourceName,
        container: context.container,
        videoFramePTSus: context.videoFramePTSus ?? null,
        videoTimingLabel: context.videoTimingLabel ?? "Video PES PTS",
        ptsSyncStats: ptsSync.stats,
    });
    // Per-frame rows are only built on demand (the "Frames" export), since they
    // are large and the folder scan keeps every file's result in memory.
    let frameRows = [];
    let frameMisbColumns = [];
    if (context.includeFrameRows) {
        const fr = buildFrameRows(misb, context.videoFramePTSus);
        frameRows = fr.rows;
        frameMisbColumns = fr.columns;
    }
    return {
        pid: context.pid ?? null,
        codecName: context.codecName ?? "klv",
        analysis,
        summary: summarizeTimingAnalysis(analysis),
        report: renderMisbTimingReport(analysis),
        frameRows,
        frameMisbColumns,
        // The decoded records themselves, on request only — the folder scan
        // keeps every file's result in memory, and these arrays are large.
        // BotBench needs them because it reconstructs sightlines from the
        // platform/gimbal angles, which the timing summary does not carry.
        // NOTE the units of MISB.UnixTimeStamp here are MICROSECONDS (ST 0601
        // tag 2 as decoded); the CSV importers in MISBUtils write milliseconds
        // into the same column.
        misb: context.includeMisb ? misb : null,
    };
}

async function analyzeTransportStreamFile(fileLike, context, options) {
    const scan = await scanTransportStreamForMetadata(fileLike, options);
    const videoFramePTSus = normalizeVideoPts(scan);
    const primaryVideoStream = getPrimaryVideoStream(scan);
    const analyses = [];
    const parseErrors = [];

    for (const stream of scan.metadataStreams) {
        if (!stream.data || stream.data.byteLength === 0) continue;
        try {
            const streamAnalysis = await analyzeKlvBuffer(stream.data, {
                sourceName: context.relativePath || context.name,
                container: "MPEG-TS",
                pid: stream.pid,
                codecName: stream.codec_name,
                pesEntries: stream.pesEntries,
                videoFirstPESus: scan.videoFirstPESus,
                videoFramePTSus,
                videoPid: primaryVideoStream?.pid ?? null,
                videoTimingLabel: "Video PES PTS",
                includeFrameRows: options.includeFrameRows,
                includeMisb: options.includeMisb,
            });
            if (streamAnalysis) {
                analyses.push(streamAnalysis);
            } else {
                parseErrors.push(`PID ${stream.pid}: no MISB ST 0601 records decoded`);
            }
        } catch (error) {
            parseErrors.push(`PID ${stream.pid}: ${error.message || String(error)}`);
        }
    }

    const selected = bestAnalysis(analyses);
    const status = analyses.length > 0 ? "ok" : "no_misb";
    const message = analyses.length > 0
        ? selected.analysis.verdict
        : (scan.metadataStreams.length > 0
            ? "Metadata/private streams were found, but no MISB ST 0601 records decoded."
            : "No KLV/private metadata streams were found.");

    return {
        file: {
            name: context.name,
            relativePath: context.relativePath,
            size: context.size,
            ext: context.ext,
        },
        status,
        container: "MPEG-TS",
        message,
        scan: {
            layout: scan.layout,
            packetCount: scan.packetCount,
            streamCount: scan.streams.length,
            metadataStreamCount: scan.metadataStreams.length,
            videoStreamCount: scan.videoStreams.length,
            videoFirstPESus: scan.videoFirstPESus,
            streams: scan.streams.map(stream => ({
                pid: stream.pid,
                codec_name: stream.codec_name,
                codec_type: stream.codec_type,
                stream_type: stream.stream_type,
                pesCount: stream.pesEntries?.length ?? 0,
                capturedPayloadBytes: stream.capturedPayloadBytes ?? 0,
            })),
            parseErrors,
        },
        analyses,
        selectedAnalysis: selected,
        frameRows: selected?.frameRows ?? [],
        frameMisbColumns: selected?.frameMisbColumns ?? [],
        summary: selected?.summary ?? {
            sourceName: context.relativePath || context.name,
            container: "MPEG-TS",
            severity: "info",
            verdict: message,
            flags: status,
            recordCount: 0,
        },
        report: selected?.report ?? "",
    };
}

async function analyzeStandaloneKlvFile(fileLike, context, options = {}) {
    const buffer = await readWholeFile(fileLike);
    const analysis = await analyzeKlvBuffer(buffer, {
        sourceName: context.relativePath || context.name,
        container: "KLV",
        includeFrameRows: options.includeFrameRows,
        includeMisb: options.includeMisb,
    });
    const analyses = analysis ? [analysis] : [];
    return {
        file: {
            name: context.name,
            relativePath: context.relativePath,
            size: context.size,
            ext: context.ext,
        },
        status: analysis ? "ok" : "no_misb",
        container: "KLV",
        message: analysis ? analysis.analysis.verdict : "No MISB ST 0601 records decoded.",
        analyses,
        selectedAnalysis: analysis,
        frameRows: analysis?.frameRows ?? [],
        frameMisbColumns: analysis?.frameMisbColumns ?? [],
        summary: analysis?.summary ?? {
            sourceName: context.relativePath || context.name,
            container: "KLV",
            severity: "info",
            verdict: "No MISB ST 0601 records decoded.",
            flags: "no_misb",
            recordCount: 0,
        },
        report: analysis?.report ?? "",
    };
}

export async function analyzeVideoFileLike(fileLike, {
    name = fileLike?.name || "unnamed",
    relativePath = fileLike?.relativePath || fileLike?.webkitRelativePath || name,
    onProgress = null,
    chunkSize = undefined,
    includeFrameRows = false,
    includeMisb = false,
} = {}) {
    const ext = extensionForName(name || relativePath);
    const size = fileSize(fileLike);
    const context = {name, relativePath, size, ext};

    if (!VIDEO_FOLDER_ANALYSIS_EXTENSIONS.has(ext)) {
        return makeUnsupportedResult(context);
    }
    if (UNSUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
        return makeUnsupportedResult(context);
    }
    try {
        if (TRANSPORT_STREAM_EXTENSIONS.has(ext)) {
            return await analyzeTransportStreamFile(fileLike, context, {
                onProgress,
                chunkSize,
                includeFrameRows,
                includeMisb,
            });
        }
        if (KLV_EXTENSIONS.has(ext)) {
            return await analyzeStandaloneKlvFile(fileLike, context, {includeFrameRows, includeMisb});
        }
    } catch (error) {
        return {
            file: {name, relativePath, size, ext},
            status: "error",
            container: TRANSPORT_STREAM_EXTENSIONS.has(ext) ? "MPEG-TS" : ext.toUpperCase(),
            message: error.message || String(error),
            analyses: [],
            summary: {
                sourceName: relativePath || name,
                container: ext.toUpperCase(),
                severity: "error",
                verdict: error.message || String(error),
                flags: "error",
                recordCount: null,
            },
            report: "",
        };
    }
    return makeUnsupportedResult(context);
}

export function isVideoAnalysisCandidateName(name) {
    return VIDEO_FOLDER_ANALYSIS_EXTENSIONS.has(extensionForName(name));
}

export function extensionForVideoAnalysis(name) {
    return extensionForName(name);
}
