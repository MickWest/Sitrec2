import {parseKLVFile} from "../MISBUtils";
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

async function analyzeKlvBuffer(buffer, context) {
    const misb = parseKLVFile(buffer, context.pesEntries ?? null, context.videoFirstPESus ?? null, {silent: true});
    if (!Array.isArray(misb)) {
        return null;
    }
    const ptsSync = analyzePtsSync(misb, context.videoFramePTSus, {
        includeRows: true,
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
    return {
        pid: context.pid ?? null,
        codecName: context.codecName ?? "klv",
        analysis,
        summary: summarizeTimingAnalysis(analysis),
        report: renderMisbTimingReport(analysis),
        ptsRows: ptsSync.rows,
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
        ptsRows: selected?.ptsRows ?? [],
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

async function analyzeStandaloneKlvFile(fileLike, context) {
    const buffer = await readWholeFile(fileLike);
    const analysis = await analyzeKlvBuffer(buffer, {
        sourceName: context.relativePath || context.name,
        container: "KLV",
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
        ptsRows: analysis?.ptsRows ?? [],
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
            });
        }
        if (KLV_EXTENSIONS.has(ext)) {
            return await analyzeStandaloneKlvFile(fileLike, context);
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
