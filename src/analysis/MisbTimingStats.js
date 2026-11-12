import * as Astronomy from "astronomy-engine";
import {MISB} from "../MISBFields";
import {maxOf, minOf} from "../SafeArrays";
import {DERIVED_KIND_NAMES, PLATFORM_NAME, streamTrackName} from "../MISBStreamTrackName";

const DEFAULT_GAP_FACTOR = 3;
const DEFAULT_MIN_GAP_S = 0.1;
const HIGH_CV = 0.05;
const SPAN_MISMATCH_WARN_S = 0.5;
const EXACT_PTS_EPSILON_US = 1;
// One tick of the 90 kHz PTS clock, rounded up. Two PTS within this are the same.
const PTS_TICK_US = 12;
// Below this many records a gap test means little: with 4 records, 3 times the
// mean interval is the whole span, so no interval can be a gap.
const GAP_TEST_MIN_RECORDS = 10;

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function fmtNumber(value, digits = 3) {
    return isFiniteNumber(value) ? value.toFixed(digits) : "n/a";
}

function fmtSeconds(value, digits = 3) {
    return isFiniteNumber(value) ? `${value.toFixed(digits)} s` : "n/a";
}

function fmtMs(valueS, digits = 3) {
    return isFiniteNumber(valueS) ? `${(valueS * 1000).toFixed(digits)} ms` : "n/a";
}

function fmtPct(value, digits = 2) {
    return isFiniteNumber(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values, average) {
    if (!values.length || !isFiniteNumber(average)) return null;
    const variance = values.reduce((sum, value) => sum + (value - average) * (value - average), 0) / values.length;
    return Math.sqrt(variance);
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function timelinePointsFromValues(values) {
    if (!Array.isArray(values)) return [];
    const points = [];
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (isFiniteNumber(value)) {
            points.push({index: i, value});
        }
    }
    return points;
}

export function timelineValuesFromMisb(misb, field = MISB.UnixTimeStamp) {
    if (!Array.isArray(misb)) return [];
    return misb.map(row => {
        const value = row?.[field];
        return isFiniteNumber(value) ? value : null;
    });
}

export function analyzeTimelineValues(values, {
    label = "Timeline",
    unitScale = 1,
    gapFactor = DEFAULT_GAP_FACTOR,
    minGapS = DEFAULT_MIN_GAP_S,
} = {}) {
    const points = timelinePointsFromValues(values);
    const intervals = [];
    const positiveIntervals = [];
    let duplicateCount = 0;
    let negativeCount = 0;

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        const dtS = (cur.value - prev.value) / unitScale;
        const interval = {
            index: cur.index,
            previousIndex: prev.index,
            dtS,
            tS: (cur.value - points[0].value) / unitScale,
        };
        intervals.push(interval);
        if (dtS > 0) {
            positiveIntervals.push(dtS);
        } else if (dtS === 0) {
            duplicateCount++;
        } else {
            negativeCount++;
        }
    }

    const meanS = mean(positiveIntervals);
    const stddevS = stddev(positiveIntervals, meanS);
    const cv = meanS > 0 && isFiniteNumber(stddevS) ? stddevS / meanS : null;
    const spanS = points.length >= 2 ? (points[points.length - 1].value - points[0].value) / unitScale : null;
    const minIntervalS = positiveIntervals.length ? minOf(positiveIntervals) : null;
    const maxIntervalS = positiveIntervals.length ? maxOf(positiveIntervals) : null;
    const gapThresholdS = meanS > 0 ? Math.max(minGapS, meanS * gapFactor) : null;
    const gaps = isFiniteNumber(gapThresholdS)
        ? intervals.filter(interval => interval.dtS > gapThresholdS)
        : [];
    const cumulativeExtraGapS = (meanS > 0)
        ? gaps.reduce((sum, gap) => sum + Math.max(0, gap.dtS - meanS), 0)
        : 0;

    return {
        label,
        valid: points.length >= 2 && spanS > 0,
        pointCount: points.length,
        missingCount: Array.isArray(values) ? Math.max(0, values.length - points.length) : 0,
        firstIndex: points[0]?.index ?? null,
        lastIndex: points[points.length - 1]?.index ?? null,
        firstValue: points[0]?.value ?? null,
        lastValue: points[points.length - 1]?.value ?? null,
        spanS,
        intervalCount: intervals.length,
        positiveIntervalCount: positiveIntervals.length,
        meanS,
        stddevS,
        cv,
        minIntervalS,
        maxIntervalS,
        gapThresholdS,
        gaps,
        gapCount: gaps.length,
        maxGapS: gaps.length ? maxOf(gaps.map(gap => gap.dtS)) : null,
        cumulativeExtraGapS,
        duplicateCount,
        negativeCount,
        intervals,
    };
}

function isNondecreasing(values) {
    let last = null;
    for (const value of values) {
        if (!isFiniteNumber(value)) continue;
        if (last !== null && value < last) return false;
        last = value;
    }
    return true;
}

function positiveIntervalsUs(values) {
    const intervals = [];
    let last = null;
    for (const value of values || []) {
        if (!isFiniteNumber(value)) continue;
        if (last !== null && value > last) {
            intervals.push(value - last);
        }
        last = value;
    }
    return intervals;
}

function nearestPoint(points, value) {
    if (!points.length || !isFiniteNumber(value)) return null;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (points[mid].ptsUs < value) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const after = points[lo];
    const before = lo > 0 ? points[lo - 1] : null;
    if (!before) return after;
    if (!after) return before;
    return Math.abs(before.ptsUs - value) <= Math.abs(after.ptsUs - value) ? before : after;
}

export function analyzePtsSync(misb, videoFramePTSus, {
    includeRows = false,
    sourceName = "",
    klvPid = null,
    videoPid = null,
    toleranceUs = null,
} = {}) {
    const recordCount = Array.isArray(misb) ? misb.length : 0;
    const pes = Array.isArray(misb?.pesPTSus) ? misb.pesPTSus : null;
    const video = Array.isArray(videoFramePTSus) ? videoFramePTSus : [];
    const klvPts = [];
    const rows = [];

    if (pes) {
        for (let i = 0; i < Math.min(recordCount, pes.length); i++) {
            if (isFiniteNumber(pes[i])) {
                klvPts.push({
                    recordIndex: i,
                    ptsUs: pes[i],
                    utsUs: misb[i]?.[MISB.UnixTimeStamp] ?? null,
                });
            }
        }
    }

    const videoPts = video.filter(isFiniteNumber);
    const videoIntervals = positiveIntervalsUs(videoPts);
    const klvIntervals = positiveIntervalsUs(klvPts.map(point => point.ptsUs));
    const medianVideoIntervalUs = median(videoIntervals);
    const medianKlvIntervalUs = median(klvIntervals);
    const pairToleranceUs = isFiniteNumber(toleranceUs)
        ? toleranceUs
        : Math.max(500, (medianVideoIntervalUs ?? medianKlvIntervalUs ?? 0) / 2);
    const fullRecordPts = !!pes && pes.length === recordCount;
    const klvPtsNonNull = klvPts.length;
    const videoPtsCount = videoPts.length;
    const klvPtsMonotonic = pes ? isNondecreasing(pes) : false;
    const videoPtsMonotonic = isNondecreasing(videoPts);
    const ptsAvailable = fullRecordPts
        && recordCount > 0
        && klvPtsNonNull === recordCount
        && videoPtsCount > 0
        && klvPtsMonotonic
        && videoPtsMonotonic;

    let pairedFrameCount = 0;
    let exactFrameCount = 0;
    let maxDeltaUs = null;
    let meanAbsDeltaUs = null;

    const sortedKlvPts = [...klvPts].sort((a, b) => a.ptsUs - b.ptsUs || a.recordIndex - b.recordIndex);
    const deltas = [];

    if (includeRows && sortedKlvPts.length > 0 && videoPtsCount > 0 && videoPtsMonotonic) {
        for (let frameIndex = 0; frameIndex < video.length; frameIndex++) {
            const videoPtsUs = video[frameIndex];
            if (!isFiniteNumber(videoPtsUs)) continue;
            const nearest = nearestPoint(sortedKlvPts, videoPtsUs);
            const deltaUs = nearest ? nearest.ptsUs - videoPtsUs : null;
            const absDeltaUs = isFiniteNumber(deltaUs) ? Math.abs(deltaUs) : null;
            const exact = isFiniteNumber(absDeltaUs) && absDeltaUs <= EXACT_PTS_EPSILON_US;
            const withinTolerance = isFiniteNumber(absDeltaUs) && absDeltaUs <= pairToleranceUs;
            if (withinTolerance) pairedFrameCount++;
            if (exact) exactFrameCount++;
            if (isFiniteNumber(absDeltaUs)) deltas.push(absDeltaUs);
            rows.push({
                sourceName,
                videoPid,
                klvPid,
                frameIndex,
                videoPtsUs,
                videoTimeS: videoPtsUs / 1e6,
                klvRecordIndex: nearest?.recordIndex ?? null,
                klvPesPtsUs: nearest?.ptsUs ?? null,
                klvUtsUs: nearest?.utsUs ?? null,
                deltaUs,
                absDeltaUs,
                pairingMethod: exact ? "exact_pes" : "nearest_pes",
                pairingQuality: withinTolerance ? "ok" : "outside_tolerance",
                ptsAvailable,
            });
        }
    } else if (!includeRows && sortedKlvPts.length > 0 && videoPtsCount > 0 && videoPtsMonotonic) {
        for (const videoPtsUs of videoPts) {
            const nearest = nearestPoint(sortedKlvPts, videoPtsUs);
            const deltaUs = nearest ? nearest.ptsUs - videoPtsUs : null;
            const absDeltaUs = isFiniteNumber(deltaUs) ? Math.abs(deltaUs) : null;
            if (isFiniteNumber(absDeltaUs)) {
                deltas.push(absDeltaUs);
                if (absDeltaUs <= pairToleranceUs) pairedFrameCount++;
                if (absDeltaUs <= EXACT_PTS_EPSILON_US) exactFrameCount++;
            }
        }
    }

    if (deltas.length > 0) {
        maxDeltaUs = maxOf(deltas);
        meanAbsDeltaUs = mean(deltas);
    }

    // The same pairing from the other side: each KLV record against its nearest
    // video frame. A low KLV rate leaves most frames with no record, so this is
    // the measure that does not depend on the rate. A record outside the video has
    // no nearest frame in any useful sense, so it is counted, not measured.
    let recordsOnFrame = 0;
    let recordsOutsideVideo = 0;
    let recordSumAbsUs = 0;
    let recordMaxAbsUs = null;
    if (klvPts.length > 0 && videoPts.length > 0) {
        const framePoints = [...videoPts].sort((a, b) => a - b).map(ptsUs => ({ptsUs}));
        const firstFrameUs = framePoints[0].ptsUs;
        const lastFrameUs = framePoints[framePoints.length - 1].ptsUs + (medianVideoIntervalUs ?? 0);
        for (const point of klvPts) {
            if (point.ptsUs < firstFrameUs - PTS_TICK_US || point.ptsUs > lastFrameUs) {
                recordsOutsideVideo++;
                continue;
            }
            const absUs = Math.abs(point.ptsUs - nearestPoint(framePoints, point.ptsUs).ptsUs);
            recordSumAbsUs += absUs;
            if (recordMaxAbsUs === null || absUs > recordMaxAbsUs) recordMaxAbsUs = absUs;
            if (absUs <= PTS_TICK_US) recordsOnFrame++;
        }
    }
    const recordsInsideVideo = klvPts.length - recordsOutsideVideo;

    return {
        stats: {
            ptsAvailable,
            fullRecordPts,
            klvPtsMonotonic,
            videoPtsMonotonic,
            recordCount,
            klvPtsNonNull,
            ptsRecordCoverage: recordCount > 0 ? klvPtsNonNull / recordCount : null,
            videoPtsCount,
            pairedFrameCount,
            exactFrameCount,
            ptsFrameCoverage: videoPtsCount > 0 ? pairedFrameCount / videoPtsCount : null,
            exactFrameCoverage: videoPtsCount > 0 ? exactFrameCount / videoPtsCount : null,
            medianVideoIntervalUs,
            medianKlvIntervalUs,
            pairToleranceUs,
            maxDeltaUs,
            meanAbsDeltaUs,
            firstRecordOffsetUs: klvPts.length > 0 && videoPts.length > 0 ? klvPts[0].ptsUs - videoPts[0] : null,
            recordsOnFrame,
            recordsOutsideVideo,
            recordMeanAbsUs: recordMaxAbsUs === null ? null : recordSumAbsUs / recordsInsideVideo,
            recordMaxAbsUs,
        },
        rows,
    };
}

function computeMisbSpansForAnalysis(misb) {
    if (!Array.isArray(misb) || misb.length < 2) return null;
    const havePes = Array.isArray(misb.pesPTSus);
    let firstUts = null;
    let lastUts = null;
    let firstPes = null;
    let lastPes = null;

    for (let i = 0; i < misb.length; i++) {
        const uts = misb[i]?.[MISB.UnixTimeStamp];
        const pes = havePes ? misb.pesPTSus[i] : null;
        if (!isFiniteNumber(uts)) continue;
        if (havePes && !isFiniteNumber(pes)) continue;
        if (firstUts === null) {
            firstUts = uts;
            firstPes = pes;
        }
        lastUts = uts;
        lastPes = pes;
    }

    if (!isFiniteNumber(firstUts) || !isFiniteNumber(lastUts) || lastUts <= firstUts) {
        return null;
    }

    return {
        utsSpanS: (lastUts - firstUts) / 1e6,
        pesSpanS: havePes && isFiniteNumber(firstPes) && isFiniteNumber(lastPes) && lastPes > firstPes
            ? (lastPes - firstPes) / 1e6
            : null,
    };
}

function computeFpsAnalysisForTiming({videoFrameCount, videoPesSpanS, klvUtsSpanS, klvPesSpanS} = {}) {
    if (!(videoFrameCount > 1) || !(videoPesSpanS > 0) || !(klvUtsSpanS > 0)) {
        return {valid: false};
    }
    const pcrFps = videoFrameCount / videoPesSpanS;
    const ratePesOverReal = (klvPesSpanS > 0) ? (klvPesSpanS / klvUtsSpanS) : 1.0;
    const realFps = pcrFps * ratePesOverReal;
    const fpsGap = Math.abs(realFps - pcrFps) / Math.max(realFps, 1e-6);
    return {valid: true, pcrFps, realFps, ratePesOverReal, fpsGap};
}

function addFlag(flags, id, severity, message, data = {}) {
    flags.push({id, severity, message, data});
}

function highestSeverity(flags) {
    const order = {ok: 0, info: 1, warn: 2, error: 3};
    let max = "ok";
    for (const flag of flags) {
        if ((order[flag.severity] ?? 0) > (order[max] ?? 0)) {
            max = flag.severity;
        }
    }
    return max;
}

export function analyzeMisbTiming(misb, {
    sourceName = "",
    container = "",
    videoFramePTSus = null,
    videoTimingLabel = "Video PES PTS",
    ptsSyncStats = null,
    buildVersion = (typeof process !== "undefined" ? process.env?.BUILD_VERSION_STRING : null) || "unknown",
} = {}) {
    const recordCount = Array.isArray(misb) ? misb.length : 0;
    const utsTimeline = analyzeTimelineValues(timelineValuesFromMisb(misb), {
        label: "KLV UnixTimeStamp",
        unitScale: 1e6,
    });
    const pesTimeline = Array.isArray(misb?.pesPTSus)
        ? analyzeTimelineValues(misb.pesPTSus, {
            label: "KLV PES PTS",
            unitScale: 1e6,
        })
        : null;
    const videoTimeline = Array.isArray(videoFramePTSus) && videoFramePTSus.length > 0
        ? analyzeTimelineValues(videoFramePTSus, {
            label: videoTimingLabel,
            unitScale: 1e6,
        })
        : null;
    const spans = computeMisbSpansForAnalysis(misb);
    const fpsAnalysis = computeFpsAnalysisForTiming({
        videoFrameCount: videoTimeline?.pointCount,
        videoPesSpanS: videoTimeline?.spanS,
        klvUtsSpanS: spans?.utsSpanS,
        klvPesSpanS: spans?.pesSpanS,
    });
    const ptsSync = ptsSyncStats || analyzePtsSync(misb, videoFramePTSus).stats;
    const flags = [];

    if (recordCount < 2) {
        addFlag(flags, "too_few_records", "error", "KLV data is missing or too short for timing analysis.");
    }
    if (!utsTimeline.valid) {
        addFlag(flags, "no_valid_uts", "error", "No usable MISB UnixTimeStamp timeline was found.");
    }
    if (utsTimeline.negativeCount > 0) {
        addFlag(flags, "klv_uts_non_monotonic", "warn", `KLV UnixTimeStamp has ${utsTimeline.negativeCount} reversed interval(s).`);
    }
    if (utsTimeline.duplicateCount > 0) {
        addFlag(flags, "klv_uts_duplicates", "info", `KLV UnixTimeStamp has ${utsTimeline.duplicateCount} duplicate interval(s).`);
    }
    if (utsTimeline.gapCount > 0) {
        addFlag(flags, "klv_uts_gaps", "warn", `KLV UnixTimeStamp has ${utsTimeline.gapCount} discrete gap(s).`, {
            maxGapS: utsTimeline.maxGapS,
            gapThresholdS: utsTimeline.gapThresholdS,
        });
    } else if ((utsTimeline.cv ?? 0) >= HIGH_CV) {
        const severity = pesTimeline?.valid ? "info" : "warn";
        addFlag(flags, "klv_uts_scatter", severity, `KLV UnixTimeStamp intervals have high scatter (CV ${fmtPct(utsTimeline.cv)}).`);
    }
    if (pesTimeline?.valid) {
        if (pesTimeline.negativeCount > 0) {
            addFlag(flags, "klv_pes_non_monotonic", "warn", `KLV PES PTS has ${pesTimeline.negativeCount} reversed interval(s).`);
        }
        if (pesTimeline.gapCount > 0) {
            addFlag(flags, "klv_pes_gaps", "warn", `KLV PES PTS has ${pesTimeline.gapCount} discrete gap(s).`, {
                maxGapS: pesTimeline.maxGapS,
                gapThresholdS: pesTimeline.gapThresholdS,
            });
        }
    }
    if (videoTimeline?.valid) {
        if ((videoTimeline.cv ?? 0) >= HIGH_CV || videoTimeline.gapCount > 0) {
            addFlag(flags, "video_pts_vfr", "warn", `${videoTimingLabel} is non-uniform.`);
        }
        if (utsTimeline.valid) {
            const spanDiffS = utsTimeline.spanS - videoTimeline.spanS;
            if (Math.abs(spanDiffS) > SPAN_MISMATCH_WARN_S && utsTimeline.gapCount === 0) {
                addFlag(flags, "klv_video_span_mismatch", "warn", `KLV and video spans differ by ${fmtSeconds(spanDiffS)}.`, {
                    spanDiffS,
                });
            }
        }
    }
    if (recordCount > 0 && (ptsSync.ptsRecordCoverage ?? 0) > 0 && !ptsSync.ptsAvailable) {
        addFlag(flags, "partial_pts", "info", `Partial KLV PES PTS coverage (${fmtPct(ptsSync.ptsRecordCoverage)} of records).`);
    }

    const severity = highestSeverity(flags);
    const verdict = severity === "ok"
        ? "No timing issues detected."
        : flags.find(flag => flag.severity === severity)?.message || "Timing issues detected.";

    return {
        sourceName,
        container,
        buildVersion,
        recordCount,
        severity,
        verdict,
        flags,
        timelines: {
            uts: utsTimeline,
            pes: pesTimeline,
            video: videoTimeline,
        },
        spans,
        fpsAnalysis,
        ptsSync,
    };
}

function pushTimeline(lines, timeline) {
    if (!timeline) {
        lines.push("  Not available");
        return;
    }
    lines.push(`  Records:          ${timeline.pointCount}`);
    lines.push(`  Span:             ${fmtSeconds(timeline.spanS)}`);
    lines.push(`  Mean interval:    ${fmtMs(timeline.meanS)}`);
    lines.push(`  Stddev:           ${fmtMs(timeline.stddevS)}`);
    lines.push(`  CV:               ${fmtPct(timeline.cv)}`);
    lines.push(`  Min interval:     ${fmtMs(timeline.minIntervalS)}`);
    lines.push(`  Max interval:     ${fmtMs(timeline.maxIntervalS)}`);
    lines.push(`  Gap threshold:    ${fmtSeconds(timeline.gapThresholdS)}`);
    lines.push(`  Gaps:             ${timeline.gapCount}`);
    if (timeline.gapCount > 0) {
        lines.push(`  Max gap:          ${fmtSeconds(timeline.maxGapS)}`);
        lines.push(`  Extra gap time:   ${fmtSeconds(timeline.cumulativeExtraGapS)}`);
        const firstGaps = timeline.gaps.slice(0, 10);
        lines.push("  First gaps:");
        for (const gap of firstGaps) {
            lines.push(`    record ${gap.previousIndex} -> ${gap.index}: ${fmtSeconds(gap.dtS)} at t=${fmtSeconds(gap.tS)}`);
        }
        if (timeline.gaps.length > firstGaps.length) {
            lines.push(`    ... ${timeline.gaps.length - firstGaps.length} more`);
        }
    }
}

export function renderMisbTimingReport(analysis) {
    const lines = [];
    lines.push("=== Sitrec MISB Timing Analysis ===");
    lines.push(`Build:            ${analysis.buildVersion || "unknown"}`);
    if (analysis.sourceName) lines.push(`Source:           ${analysis.sourceName}`);
    if (analysis.container) lines.push(`Container:        ${analysis.container}`);
    lines.push("");
    lines.push("SUMMARY");
    lines.push("------------------------------------------------------------");
    lines.push(`Verdict:          ${analysis.verdict}`);
    lines.push(`Severity:         ${analysis.severity}`);
    lines.push(`KLV records:      ${analysis.recordCount}`);
    lines.push(`PES PTS pairing:${analysis.ptsSync?.ptsAvailable ? "yes" : "no"}`);
    lines.push(`PES PTS records:${fmtPct(analysis.ptsSync?.ptsRecordCoverage)}`);
    lines.push(`Paired frames:  ${fmtPct(analysis.ptsSync?.ptsFrameCoverage)}`);
    lines.push(`KLV UTS span:     ${fmtSeconds(analysis.timelines.uts?.spanS)}`);
    lines.push(`KLV PES span:     ${fmtSeconds(analysis.timelines.pes?.spanS)}`);
    lines.push(`Video PTS span:   ${fmtSeconds(analysis.timelines.video?.spanS)}`);
    if (analysis.timelines.uts?.valid && analysis.timelines.video?.valid) {
        const spanDiffS = analysis.timelines.uts.spanS - analysis.timelines.video.spanS;
        lines.push(`Span difference:  ${fmtSeconds(spanDiffS)} (KLV - video)`);
    }
    if (analysis.fpsAnalysis?.valid) {
        lines.push(`PCR fps:          ${fmtNumber(analysis.fpsAnalysis.pcrFps, 4)}`);
        lines.push(`Real fps estimate:${fmtNumber(analysis.fpsAnalysis.realFps, 4)}`);
    }
    lines.push("");
    lines.push("FLAGS");
    lines.push("------------------------------------------------------------");
    if (analysis.flags.length === 0) {
        lines.push("  None");
    } else {
        for (const flag of analysis.flags) {
            lines.push(`  [${flag.severity}] ${flag.message}`);
        }
    }
    lines.push("");
    lines.push("KLV UNIX TIMESTAMP");
    lines.push("------------------------------------------------------------");
    pushTimeline(lines, analysis.timelines.uts);
    lines.push("");
    lines.push("KLV PES PTS");
    lines.push("------------------------------------------------------------");
    pushTimeline(lines, analysis.timelines.pes);
    lines.push("");
    lines.push("VIDEO PTS");
    lines.push("------------------------------------------------------------");
    pushTimeline(lines, analysis.timelines.video);
    lines.push("");
    return lines.join("\n");
}

export function summarizeTimingAnalysis(analysis) {
    const flagIds = analysis.flags.map(flag => flag.id);
    return {
        sourceName: analysis.sourceName,
        container: analysis.container,
        severity: analysis.severity,
        verdict: analysis.verdict,
        flags: flagIds.join(";"),
        recordCount: analysis.recordCount,
        klvUtsSpanS: analysis.timelines.uts?.spanS ?? null,
        klvUtsMeanIntervalS: analysis.timelines.uts?.meanS ?? null,
        klvUtsCv: analysis.timelines.uts?.cv ?? null,
        klvUtsGapCount: analysis.timelines.uts?.gapCount ?? null,
        klvUtsMaxGapS: analysis.timelines.uts?.maxGapS ?? null,
        klvPesSpanS: analysis.timelines.pes?.spanS ?? null,
        klvPesGapCount: analysis.timelines.pes?.gapCount ?? null,
        videoPtsCount: analysis.timelines.video?.pointCount ?? null,
        videoPtsSpanS: analysis.timelines.video?.spanS ?? null,
        videoPtsCv: analysis.timelines.video?.cv ?? null,
        spanDiffS: analysis.timelines.uts?.valid && analysis.timelines.video?.valid
            ? analysis.timelines.uts.spanS - analysis.timelines.video.spanS
            : null,
        pcrFps: analysis.fpsAnalysis?.valid ? analysis.fpsAnalysis.pcrFps : null,
        realFps: analysis.fpsAnalysis?.valid ? analysis.fpsAnalysis.realFps : null,
        ptsAvailable: analysis.ptsSync?.ptsAvailable ?? false,
        fullRecordPts: analysis.ptsSync?.fullRecordPts ?? false,
        ptsRecordCount: analysis.ptsSync?.klvPtsNonNull ?? null,
        ptsRecordCoverage: analysis.ptsSync?.ptsRecordCoverage ?? null,
        ptsFramePairCount: analysis.ptsSync?.pairedFrameCount ?? null,
        ptsFrameCoverage: analysis.ptsSync?.ptsFrameCoverage ?? null,
        exactFrameCoverage: analysis.ptsSync?.exactFrameCoverage ?? null,
        ptsPairToleranceUs: analysis.ptsSync?.pairToleranceUs ?? null,
        ptsMeanAbsDeltaUs: analysis.ptsSync?.meanAbsDeltaUs ?? null,
        ptsMaxDeltaUs: analysis.ptsSync?.maxDeltaUs ?? null,
    };
}

const LOCAL_VALUE_MAX_CHARS = 400;

function jsonText(value) {
    try {
        return JSON.stringify(value, (key, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value);
    } catch (e) {
        return String(value);
    }
}

// One value as report text. A nested local set (Security, RVT, VMTI) is parsed
// as a list of {key, name, value} items, written as "name=value; ...". Other
// objects are written as JSON. The text is also what values are compared by
// when finding unique values.
function localValueText(value) {
    const isItemList = Array.isArray(value) && value.length > 0
        && value.every(item => item && typeof item === "object" && "name" in item && "value" in item);
    const text = isItemList
        ? value.map(item => `${item.name}=${typeof item.value === "string" ? item.value : jsonText(item.value)}`).join("; ")
        : jsonText(value);
    return text.length > LOCAL_VALUE_MAX_CHARS ? text.slice(0, LOCAL_VALUE_MAX_CHARS - 1) + "…" : text;
}

// One field: the number of records that have a value, the first maxUnique unique
// values in record order, and all the unique values.
function fieldValues(misb, name, tag, maxUnique) {
    const rows = Array.isArray(misb) ? misb : [];
    const values = [];
    const seen = new Set();
    let recordCount = 0;
    for (const row of rows) {
        const value = row?.[tag];
        if (value === null || value === undefined || value === "") continue;
        recordCount++;
        const text = localValueText(value);
        if (seen.has(text)) continue;
        seen.add(text);
        if (values.length < maxUnique) values.push(text);
    }
    return {name, tag, recordCount, unique: seen, values};
}

// Every MISB field whose name contains "local".
export function localFieldValues(misb, maxUnique = 5) {
    return Object.entries(MISB)
        .filter(([name]) => /local/i.test(name))
        .map(([name, tag]) => fieldValues(misb, name, tag, maxUnique));
}

// MPEG-TS stream_type values that carry KLV (MISB ST 1402): 0x15 is metadata in
// PES packets (synchronous carriage), 0x06 is private data in PES packets
// (asynchronous carriage).
const KLV_CARRIAGE = {0x15: "sync", 0x06: "async"};

function hexId(n, digits = 0) {
    return "0x" + n.toString(16).padStart(digits, "0");
}

// Report names for MISB streams, from the container's ids, not from a stream's
// place in the list: "KLV #0:3 [0x1002], sync". #0:N is the stream's place in the
// PMT, the same number that ffprobe prints and ffmpeg -map uses; [0x1002] is its
// packet id (PID). A stream with no PID (a .klv or CSV file) is "MISB file",
// numbered when there are two or more. A derived track is "Frame Center (derived
// from KLV #0:3 [0x1002], sync)", its kind named as in its track name
// (DERIVED_KIND_NAMES). Names that are the same (two files with the same layout)
// get "(1 of 2)", "(2 of 2)".
export function klvStreamLabels(misbs) {
    const files = misbs.filter(misb => misb && !misb.derivedTrack && misb.klvPid == null);
    const streamLabel = (misb) => {
        if (misb?.klvPid == null) {
            const n = files.indexOf(misb);
            return files.length > 1 && n >= 0 ? `MISB file ${n + 1}` : "MISB file";
        }
        let label = "KLV ";
        if (Number.isInteger(misb.klvStreamIndex)) label += `#0:${misb.klvStreamIndex} `;
        label += `[${hexId(misb.klvPid)}]`;
        const mode = KLV_CARRIAGE[misb.klvStreamType];
        return mode ? `${label}, ${mode}` : label;
    };
    const labels = misbs.map(misb => {
        if (!misb?.derivedTrack) return streamLabel(misb);
        const key = misb.derivedTrack.charAt(0).toUpperCase() + misb.derivedTrack.slice(1);
        const kind = DERIVED_KIND_NAMES[key] ?? key;
        return `${kind} (derived from ${streamLabel(misb)})`;
    });
    const totals = new Map();
    for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
    const seen = new Map();
    return labels.map(label => {
        const total = totals.get(label);
        if (total < 2) return label;
        const n = (seen.get(label) ?? 0) + 1;
        seen.set(label, n);
        return `${label} (${n} of ${total})`;
    });
}

// ST 0601 fields that describe a stream, a platform or a sensor. These rows are
// always shown, so that the table has the same shape for every file. Version first:
// tag 65, "UAS Datalink Local Set Version Number", is the number people use to tell
// two streams apart.
const IDENTITY_FIELDS = [
    "UASDatalinkLSVersionNumber", "MissionID", "PlatformTailNumber", "PlatformCallSign",
    "PlatformDesignation", "ImageSourceSensor",
];

// Row names where one name is not the whole story. Tag 59 is also the column that
// Sitrec uses to split a stream into tracks.
const IDENTITY_ROW_NAMES = {PlatformCallSign: "PlatformCallSign / TrackID"};

// ST 0601 tags that misb.js has no name for. Names from the ST 0601 tag list.
const UNDECODED_TAG_NAMES = {
    97: "Range Image Local Set", 99: "Composite Imaging Local Set", 100: "Segment Local Set",
    101: "Amend Local Set", 106: "Stream Designator", 107: "Operational Base", 108: "Broadcast Source",
    129: "Target ID", 143: "Metadata Substream ID",
};

const IDENTITY_MAX_NUMBER = 65535;

// What the report prints in place of a name, when the user hides names.
const HIDDEN_VALUE = "hidden";

// What a cell says when the stream did not come from a TS.
const NOT_FROM_TS = "no TS";

// What the first stream's cell says in a row that compares each stream with it.
const COMPARED_WITH_THIS = "—";

// Keeps only small whole numbers. Text stays out even if it is all digits, as a
// tail number or a mission id can be. Each hidden value stays as one "hidden", so
// that the number of values can still be seen.
function withoutNames(values) {
    return values.map(text => (/^\d+$/.test(text) && Number(text) <= IDENTITY_MAX_NUMBER ? text : HIDDEN_VALUE));
}

// Raw hex as report text, with the text it spells if it is all printable ASCII.
// With hideNames, a raw value stays only if it can be a small number: not text of
// two or more bytes, and no longer than IDENTITY_MAX_NUMBER needs. A longer value
// can hold a name or a packed location.
function rawValueText(hex, hideNames) {
    const bytes = hex.match(/../g) ?? [];
    const isText = bytes.length > 0 && bytes.every(byte => {
        const code = parseInt(byte, 16);
        return code >= 0x20 && code <= 0x7E;
    });
    if (hideNames && ((isText && bytes.length > 1) || bytes.length > 2)) return HIDDEN_VALUE;
    if (!isText || hideNames) return hex;
    return `${hex} "${bytes.map(byte => String.fromCharCode(parseInt(byte, 16))).join("")}"`;
}

// A row of the table. cells: for each stream, its values as text, or null when the
// value is not known. Only rows with marked: true can get the differs mark: an id
// differs by its nature, and a measurement nearly always does. compare: what the
// mark is worked out from, when the cells are not the whole, true values.
function tableRow(name, cells, {marked = false, compare = null} = {}) {
    return {name, cells, marked, compare};
}

const CONTAINER_ROWS = ["ffprobe stream no (#0:N)", "PID", "stream_type", "PES stream_id", "Name in the PMT"];

// The rows of the TS layer, for one stream, as [name, values]. values is null when
// the id is not known (it was not saved with the stream).
function containerIds(misb, hideNames) {
    if (misb.klvPid == null) return CONTAINER_ROWS.map(name => [name, [NOT_FROM_TS]]);
    const ids = misb.tsIds ?? null;
    const one = value => (value === undefined || value === null ? null : [String(value)]);
    const pmtName = ids?.pmtName ? [hideNames ? HIDDEN_VALUE : ids.pmtName] : [];
    return [
        [CONTAINER_ROWS[0], one(misb.klvStreamIndex)],
        [CONTAINER_ROWS[1], [`${misb.klvPid} (${hexId(misb.klvPid)})`]],
        [CONTAINER_ROWS[2], misb.klvStreamType == null ? null : [hexId(misb.klvStreamType, 2)]],
        [CONTAINER_ROWS[3], ids ? (ids.pesStreamIds ?? []).map(id => hexId(id, 2)) : null],
        [CONTAINER_ROWS[4], ids ? pmtName : null],
    ];
}

// One stream's record count, gaps and alignment, from a MISB data node. A gap is an
// interval longer than DEFAULT_GAP_FACTOR times the mean, and at least
// DEFAULT_MIN_GAP_S. All of these intervals are on tag 2, UnixTimeStamp, not on PES
// PTS. videoPTSus: the video's framePTSus. These keep the clock origin of the file,
// and misb.pesPTSus are relative to the first video frame, so the comparison makes
// the frames relative too.
export function streamTiming(node, videoPTSus = null) {
    const records = node.misb?.length ?? 0;
    const hasRecordPTS = node.hasRecordPTS?.() === true;
    const framesFromFirst = videoPTSus?.length > 0 ? videoPTSus.map(ptsUs => ptsUs - videoPTSus[0]) : null;
    const sync = hasRecordPTS && framesFromFirst ? analyzePtsSync(node.misb, framesFromFirst).stats : null;
    const alignment = sync?.klvPtsNonNull > 0 ? sync : null;
    const timing = {records, hasRecordPTS, alignment, firstTimeMs: null, gaps: null, error: null};
    try {
        let first = 0;
        let last = records - 1;
        while (first < records && !node.isValid(first)) first++;
        while (last >= 0 && !node.isValid(last)) last--;
        if (first < records) timing.firstTimeMs = node.getTime(first);
        if (last <= first) return timing;
        const meanMs = (node.getTime(last) - node.getTime(first)) / (last - first);
        const thresholdMs = Math.max(DEFAULT_MIN_GAP_S * 1000, meanMs * DEFAULT_GAP_FACTOR);
        let count = 0;
        let maxIntervalMs = 0;
        let repeats = 0;
        for (let i = first + 1; i <= last; i++) {
            if (!node.isValid(i) || !node.isValid(i - 1)) continue;
            const intervalMs = node.getTime(i) - node.getTime(i - 1);
            if (intervalMs > maxIntervalMs) maxIntervalMs = intervalMs;
            if (intervalMs > thresholdMs) count++;
            if (intervalMs === 0) repeats++;
        }
        const tested = last - first + 1 >= GAP_TEST_MIN_RECORDS;
        // With repeats left out, the time between new values. An encoder that repeats
        // a record until the metadata changes makes the plain mean too small.
        const newValueMeanMs = (node.getTime(last) - node.getTime(first)) / Math.max(1, last - first - repeats);
        return {...timing, gaps: {count, tested, thresholdMs, meanMs, newValueMeanMs, maxIntervalMs, repeats}};
    } catch (e) {
        return {...timing, error: e.message};
    }
}

function signedMs(valueMs) {
    return `${valueMs >= 0 ? "+" : "-"}${Math.abs(valueMs).toFixed(3)} ms`;
}

// Whole hours and the rest of a clock offset, as the hours can be a time zone.
function hoursAndRest(offsetMs) {
    const hours = Math.round(offsetMs / 3600000);
    return {hours, restMs: offsetMs - hours * 3600000};
}

// A clock offset as whole hours and a remainder: "+7 h -0.82 s". Two decimals, as a
// stream that holds its values can read up to one update late.
function clockOffsetText(offsetMs) {
    const {hours, restMs} = hoursAndRest(offsetMs);
    const rest = `${restMs >= 0 ? "+" : "-"}${Math.abs(restMs / 1000).toFixed(2)} s`;
    return hours === 0 ? rest : `${hours >= 0 ? "+" : "-"}${Math.abs(hours)} h ${rest}`;
}

// A short name of a stream, for a row or a section that names it: "KLV #0:3" from
// "KLV #0:3 [0x1002], sync". A stream with no #0:N keeps its PID.
function shortStreamName(label) {
    const withoutCarriage = label.replace(/, a?sync/, "");
    return /#0:\d+/.test(withoutCarriage) ? withoutCarriage.replace(/ \[0x[0-9a-f]+\]/, "") : withoutCarriage;
}

// For each stream, whether the sitch start time is on its clock: the stream with the
// first time nearest to the start, if that is within a minute. A minute, as a sitch
// can start a little after the first record. Two streams can be seconds apart, and
// only the nearer one is the sitch's clock. firstTimesMs: each stream's first time,
// or null. Returns true, false, or null for a stream with no time.
export function streamsOnSitchClock(firstTimesMs, sitchStartMs) {
    const distances = firstTimesMs.filter(isFiniteNumber).map(timeMs => Math.abs(timeMs - sitchStartMs));
    const nearestMs = distances.length > 0 ? minOf(distances) : null;
    return firstTimesMs.map(timeMs => {
        if (!isFiniteNumber(timeMs)) return null;
        const distanceMs = Math.abs(timeMs - sitchStartMs);
        return distanceMs < 60000 && distanceMs === nearestMs;
    });
}

// The height of the sun above the horizon at a place and time, in degrees, with no
// refraction. Negative is below the horizon.
function sunHeightDeg(timeMs, latDeg, lonDeg) {
    const date = new Date(timeMs);
    const observer = new Astronomy.Observer(latDeg, lonDeg, 0);
    const sun = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true);
    return Astronomy.Horizon(date, observer, sun.ra, sun.dec).altitude;
}

// The sun's height for the first record of a stream that has a time and a position. A
// clock can be wrong by hours, and this is the one check that does not use the stream:
// compare it with the picture. It depends on the place and the time, so it counts as a
// name.
function sunHeightText(misb, firstTimeMs, hideNames) {
    const row = misb.find(rec => isFiniteNumber(rec?.[MISB.SensorLatitude]) && isFiniteNumber(rec?.[MISB.SensorLongitude]));
    if (!row || !isFiniteNumber(firstTimeMs)) return "n/a";
    if (hideNames) return HIDDEN_VALUE;
    const heightDeg = sunHeightDeg(firstTimeMs, row[MISB.SensorLatitude], row[MISB.SensorLongitude]);
    return `${heightDeg >= 0 ? "+" : "-"}${Math.abs(heightDeg).toFixed(1)}°`;
}

// Why a stream is the one analyzed: the platform track's stream, or the first with
// PES PTS, or the first. nodes: the streams to choose from, with no derived tracks.
export function chooseAnalyzedStream(nodes, platformNode) {
    const withPES = nodes.find(node => node.hasRecordPTS?.());
    if (platformNode) return {node: platformNode, reason: "platform track"};
    return withPES ? {node: withPES, reason: "first stream with PES PTS"} : {node: nodes[0], reason: "first stream"};
}

// The real stream behind a track's data node: the node itself, or for a derived
// track its source. nodes: every MISB data node. A file with no PID has nothing to
// match a derived track to its source by, so it gives null.
export function streamOfDataNode(dataNode, nodes) {
    if (!dataNode || !nodes.includes(dataNode)) return null;
    const misb = dataNode.misb;
    if (!misb?.derivedTrack) return dataNode;
    if (misb.klvPid == null) return null;
    return nodes.find(node => node.misb && !node.misb.derivedTrack
        && node.misb.klvPid === misb.klvPid && node.misb.sourceFile === misb.sourceFile) ?? null;
}

// The rows on how well each stream was decoded.
function decodingRows(misbs, timing) {
    const stats = misbs.map(misb => misb.klvDecodeStats ?? null);
    const row = (name, text) => tableRow(name, stats.map(stat => [stat ? text(stat) : "n/a"]));
    const faultText = stat => stat.tagFaults.map(fault => `tag ${fault.tag} ${fault.kind} ×${fault.count}`).join(" / ");
    return [
        tableRow("Records", timing.map(stream => [String(stream.records)])),
        row("Packets not decoded", stat => `${stat.rejected + stat.badLengths} of ${stat.packets + stat.badLengths}`),
        row("PES with no KLV packet", stat => String(stat.pesWithoutPacket ?? "n/a")),
        row("Bad or missing checksums", stat => String(stat.badChecksums)),
        row("Tag faults", stat => (stat.tagFaults.length > 0 ? faultText(stat) : "none")),
        tableRow("TS continuity errors", misbs.map(misb => {
            if (misb.klvPid == null) return [NOT_FROM_TS];
            return misb.tsIds?.continuityErrors === undefined ? null : [String(misb.tsIds.continuityErrors)];
        })),
    ];
}

// The rows on each stream's own clock, and on its PES PTS against the video. baseName:
// the short name of the first stream, which the others are compared with.
function timingRows(misbs, timing, hideNames, baseName) {
    const row = (name, text) => tableRow(name, timing.map(stream => [text(stream)]));
    const gapValue = (name, text) => row(name, ({gaps}) => (gaps ? text(gaps) : "n/a"));
    const alignmentValue = (name, text) => row(name, ({alignment}) => (alignment ? text(alignment) : "n/a"));
    const gapText = ({gaps, error}) => {
        if (error) return `survey failed: ${error}`;
        if (!gaps) return "n/a";
        return gaps.tested ? `${gaps.count} (> ${gaps.thresholdMs.toFixed(0)} ms)` : "too few records to test";
    };
    const firstTime = ({firstTimeMs}) => {
        if (firstTimeMs === null) return "n/a";
        return hideNames ? HIDDEN_VALUE : new Date(firstTimeMs).toISOString();
    };
    const offsetFromFirst = (column) => {
        const offset = clockOffset(misbs, timing, column);
        if (offset === null) return "n/a";
        return offset.sameMoment ? clockOffsetText(offset.ms) : `${clockOffsetText(offset.ms)} (first times)`;
    };
    const nearestFrame = ({recordMeanAbsUs, recordMaxAbsUs}) => (recordMaxAbsUs === null ? "n/a"
        : `mean ${(recordMeanAbsUs / 1000).toFixed(2)} ms, max ${(recordMaxAbsUs / 1000).toFixed(2)} ms`);
    // A stream that repeats records has two means. The first is the one that says how
    // often the metadata changes, and the plain mean would hide that.
    const meanInterval = ({meanMs, newValueMeanMs, repeats}) => (repeats > 0 && newValueMeanMs !== undefined
        ? `${newValueMeanMs.toFixed(0)} ms (repeats left out)` : `${meanMs.toFixed(0)} ms`);
    const rows = [row("First valid time (tag 2)", firstTime)];
    if (timing.length > 1) {
        rows.push(tableRow(`Clock offset from ${baseName}`, timing.map((stream, column) => (
            [column === 0 ? COMPARED_WITH_THIS : offsetFromFirst(column)]))));
        rows.push(row("Sitch time on this clock", ({onSitchClock}) => (
            onSitchClock === undefined || onSitchClock === null ? "n/a" : onSitchClock ? "yes" : "no")));
    }
    rows.push(tableRow("Sun height at first record", timing.map((stream, column) => (
        [sunHeightText(misbs[column], stream.firstTimeMs, hideNames)]))));
    rows.push(
        gapValue("Mean interval (tag 2)", meanInterval),
        gapValue("Max interval (tag 2)", gaps => `${gaps.maxIntervalMs.toFixed(0)} ms`),
        gapValue("Repeated times (tag 2)", gaps => String(gaps.repeats)),
        row("Gaps (tag 2)", gapText),
        row("hasRecordPTS", stream => (stream.hasRecordPTS ? "yes" : "no")),
        alignmentValue("First PTS minus first frame PTS", ({firstRecordOffsetUs}) => signedMs(firstRecordOffsetUs / 1000)),
        alignmentValue("PTS equal to a frame PTS", ({recordsOnFrame, klvPtsNonNull}) => `${recordsOnFrame} of ${klvPtsNonNull}`),
        alignmentValue("Offset to nearest frame", nearestFrame),
        alignmentValue("Records outside the video", ({recordsOutsideVideo}) => String(recordsOutsideVideo)),
        row("Analyzed below", stream => (stream.analyzed ? `yes: ${stream.analyzed}` : "no")),
    );
    return rows;
}

const METRES_PER_DEGREE = 111320;

// A UnixTimeStamp as ms since the epoch. KLV has it in microseconds and a CSV file
// in milliseconds or seconds, by the same test as CNodeMISBDataTrack.getTime.
function tag2Ms(value) {
    if (value > 31568461000000) return value / 1000;
    return value < 31568461000 ? value * 1000 : value;
}

function hasRecordPES(misb) {
    return Array.isArray(misb.pesPTSus) && misb.pesPTSus.length === misb.length;
}

// Each record's time in ms, to pair the records of two streams. PES PTS of two streams
// are on one PCR clock. Tag 2 clocks can be hours apart, in which case no records pair.
function sharedTimes(misb, usePES) {
    if (usePES) return misb.pesPTSus.map(us => (us === null ? null : us / 1000));
    return misb.map(row => (isFiniteNumber(row?.[MISB.UnixTimeStamp]) ? tag2Ms(row[MISB.UnixTimeStamp]) : null));
}

// The records of two streams that are at the same time: [[base row, other row], ...].
function pairedRecords(base, other, maxPairMs = 100) {
    const usePES = hasRecordPES(base) && hasRecordPES(other);
    const otherTimes = sharedTimes(other, usePES);
    // nearestPoint reads .ptsUs. Here it holds ms, as both sides are in ms.
    const points = sharedTimes(base, usePES)
        .flatMap((timeMs, i) => (timeMs === null ? [] : [{ptsUs: timeMs, row: base[i]}]))
        .sort((a, b) => a.ptsUs - b.ptsUs);
    if (points.length === 0) return [];
    return other.flatMap((row, i) => {
        if (otherTimes[i] === null) return [];
        const near = nearestPoint(points, otherTimes[i]);
        return Math.abs(near.ptsUs - otherTimes[i]) > maxPairMs ? [] : [[near.row, row]];
    });
}

// How far a stream's tag 2 clock is from the first stream's: {ms, sameMoment}, or null.
// With PES PTS on both, the clocks are read at the same moment. Otherwise this is only
// the first times, which include any difference in when the streams start, so
// sameMoment is false.
function clockOffset(misbs, timing, column) {
    if (hasRecordPES(misbs[0]) && hasRecordPES(misbs[column])) {
        const offsets = pairedRecords(misbs[0], misbs[column]).flatMap(([baseRow, row]) => {
            const [baseTime, time] = [baseRow[MISB.UnixTimeStamp], row[MISB.UnixTimeStamp]];
            return isFiniteNumber(baseTime) && isFiniteNumber(time) ? [tag2Ms(time) - tag2Ms(baseTime)] : [];
        });
        if (offsets.length > 0) return {ms: median(offsets), sameMoment: true};
    }
    const [baseMs, firstMs] = [timing[0].firstTimeMs, timing[column].firstTimeMs];
    return baseMs === null || firstMs === null ? null : {ms: firstMs - baseMs, sameMoment: false};
}

// A line on the clocks when they were read at the same moment and differ. Tag 2 is UTC,
// so whole hours can be a time zone that one stream applied. canCheck: the sun height
// row has values to check with.
function clockLines(misbs, timing, canCheck) {
    const offsets = misbs.slice(1).map((misb, i) => clockOffset(misbs, timing, i + 1))
        .filter(offset => offset?.sameMoment && Math.abs(offset.ms) > 1000);
    if (offsets.length === 0) return [];
    const check = canCheck ? "Compare the sun height with the picture to see which is right."
        : "The report cannot say which is right.";
    const wholeHours = offsets.every(offset => Math.abs(hoursAndRest(offset.ms).restMs) <= 1000);
    return wholeHours
        ? ["  The clocks differ by whole hours, which can be a time zone. Tag 2 is UTC, so they cannot both be right.",
            `  ${check}`]
        : [`  The clocks do not agree. ${check}`];
}

// The median horizontal distance between the positions of two streams, for records
// within 100 ms of each other. null when no records pair.
function medianDistanceM(base, other, latTag, lonTag) {
    const distances = pairedRecords(base, other).flatMap(([baseRow, row]) => {
        const [latA, lonA, latB, lonB] = [baseRow[latTag], baseRow[lonTag], row[latTag], row[lonTag]];
        if (![latA, lonA, latB, lonB].every(isFiniteNumber)) return [];
        const eastM = (lonB - lonA) * METRES_PER_DEGREE * Math.cos(latA * Math.PI / 180);
        return [Math.hypot((latB - latA) * METRES_PER_DEGREE, eastM)];
    });
    return distances.length > 0 ? median(distances) : null;
}

// Whether the streams say the same thing, for the second column on.
function comparedRows(misbs) {
    const row = (name, latTag, lonTag) => tableRow(name, misbs.map((misb, column) => {
        if (column === 0) return [COMPARED_WITH_THIS];
        const distanceM = medianDistanceM(misbs[0], misb, latTag, lonTag);
        return [distanceM === null ? "n/a" : `median ${distanceM.toFixed(1)} m`];
    }));
    return [
        row("Sensor position (horizontal)", MISB.SensorLatitude, MISB.SensorLongitude),
        row("Frame center (horizontal)", MISB.FrameCenterLatitude, MISB.FrameCenterLongitude),
    ];
}

// The widest a stream column can be. A longer value wraps inside its cell.
const IDENTIFIER_COLUMN_MAX = 30;

// Text as lines of at most width characters, split at spaces where it can be.
function wrapCell(text, width) {
    const lines = [];
    let rest = text;
    while (rest.length > width) {
        const space = rest.lastIndexOf(" ", width);
        const cut = space > 0 ? space : width;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    lines.push(rest);
    return lines;
}

function cellText(values) {
    if (values === null) return "?";
    return values.length > 0 ? values.join(" / ") : "none";
}

// One tag's cell: its first values, how many more there are, and how many records
// have it, if that is not all of them. Each hidden value stays as "hidden", and the
// counts stay, because they hold no name.
function tagCell(field, totalRecords, hideNames) {
    if (field.recordCount === 0) return [];
    let text = (hideNames ? withoutNames(field.values) : field.values).join(" / ");
    if (field.unique.size > field.values.length) text += ` +${field.unique.size - field.values.length} more`;
    if (field.recordCount < totalRecords) text += ` (in ${field.recordCount} of ${totalRecords})`;
    return [text];
}

const DIFFERS_MARK = "≠";

// A table with a Field column and a column for each stream, sized to its text. The
// mark is in the Field column, so that it stays on the screen with many streams.
// sections: [{title, rows}], with rows from tableRow.
function identifierTable(labels, sections) {
    const rows = sections.flatMap(section => section.rows.map(row => {
        const texts = row.cells.map(cellText);
        const compared = (row.compare ?? row.cells).map(cellText);
        return {section, field: row.name, texts, differs: row.marked && new Set(compared).size > 1};
    }));
    const fieldText = row => `${row.differs ? `${DIFFERS_MARK} ` : "  "}${row.field}`;
    const fieldWidth = Math.max("Field".length,
        ...sections.map(section => section.title.length), ...rows.map(row => fieldText(row).length));
    const widths = labels.map((label, column) => Math.min(IDENTIFIER_COLUMN_MAX,
        Math.max(label.length, ...rows.map(row => row.texts[column].length))));

    const rowLines = (field, texts) => {
        const cells = texts.map((text, column) => wrapCell(text, widths[column]));
        const height = Math.max(...cells.map(cell => cell.length));
        const lines = [];
        for (let i = 0; i < height; i++) {
            const columns = cells.map((cell, column) => (cell[i] ?? "").padEnd(widths[column]));
            lines.push(`  ${(i === 0 ? field : "").padEnd(fieldWidth)} │ ${columns.join(" │ ")}`.trimEnd());
        }
        return lines;
    };

    const lines = rowLines("Field", labels);
    lines.push(`  ${"─".repeat(fieldWidth)}─┼─${widths.map(width => "─".repeat(width)).join("─┼─")}`);
    for (const section of sections) {
        lines.push(...rowLines(section.title, labels.map(() => "")));
        for (const row of rows) {
            if (row.section === section) lines.push(...rowLines(fieldText(row), row.texts));
        }
    }
    return lines;
}

// The streams in the TS files that are not KLV. Sitrec does not read private data,
// so this is the only sign that it is there.
function otherStreamLines(misbs, hideNames) {
    const seen = new Set();
    const lines = [];
    for (const misb of misbs) {
        for (const stream of misb.tsIds?.otherStreams ?? []) {
            const id = `${misb.sourceFile}|${stream.pid}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const name = stream.name ? ` "${hideNames ? HIDDEN_VALUE : stream.name}"` : "";
            lines.push(`  ${hexId(stream.pid)} ${stream.codec}${name}, stream_type ${stream.streamType}: `
                + `${stream.packets.toLocaleString("en-US")} TS packets, ${stream.bytes.toLocaleString("en-US")} bytes`);
        }
    }
    return lines;
}

// One table of what each KLV stream is and holds, and how they compare. The second
// use is to name a stream: people call a stream by its tag 65 number. misbs: the real
// streams (no derived tracks). labels: their report names, from klvStreamLabels. This
// section prints tag values. hideNames: print "hidden" for each value that is not a
// small number, such as a tail number or a mission id. timing: for each stream,
// streamTiming with "analyzed": why that stream is the one analyzed, or null.
// derivedCount: the number of derived tracks that are not listed.
export function renderStreams(misbs, labels, {
    maxUnique = 5, hideNames = false, timing = null, derivedCount = 0,
} = {}) {
    if (misbs.length === 0) return [];
    const sections = [];

    if (misbs.some(misb => misb.klvPid != null)) {
        const perStream = misbs.map(misb => containerIds(misb, hideNames));
        sections.push({
            title: "In the TS file",
            rows: CONTAINER_ROWS.map((name, row) => tableRow(name, perStream.map(ids => ids[row][1]))),
        });
    }

    const undecoded = misbs.map(misb => new Map((misb.undecodedKLVTags ?? []).map(item => [item.tag, item])));
    const tagRow = (name, tag, label = name) => {
        const fields = misbs.map(misb => fieldValues(misb, name, tag, maxUnique));
        return tableRow(`${label} (tag ${tag})`,
            fields.map((field, column) => tagCell(field, misbs[column].length, hideNames)), {
                marked: true,
                compare: fields.map(field => [...field.unique].sort()),
            });
    };
    const klvRows = IDENTITY_FIELDS.map(name => tagRow(name, MISB[name], IDENTITY_ROW_NAMES[name]));

    // SecurityLocalSet is in most files, so its row is always there. A local set
    // that misb.js does not decode has only "Not Implemented" in its rows, so it
    // prints as raw hex below.
    for (const {name, tag} of localFieldValues([])) {
        if (undecoded.some(items => items.has(tag))) continue;
        const present = misbs.some(misb => misb.some(row => row?.[tag] !== null && row?.[tag] !== undefined));
        if (tag === MISB.SecurityLocalSet || present) klvRows.push(tagRow(name, tag));
    }

    const tagSets = misbs.map(misb => {
        const tags = new Set();
        for (const row of misb) {
            row?.forEach?.((value, tag) => {
                if (value !== null && value !== undefined && value !== "") tags.add(tag);
            });
        }
        return tags;
    });
    klvRows.push(tableRow("Tags in the stream", tagSets.map((tags, column) => {
        const only = [...tags].filter(tag => !tagSets.some((other, i) => i !== column && other.has(tag))).length;
        return misbs.length > 1 ? [`${tags.size} (${only} only here)`] : [String(tags.size)];
    })));
    sections.push({title: "In the KLV (ST 0601 tags)", rows: klvRows});

    if (timing) {
        const baseName = shortStreamName(labels[0]);
        sections.push({title: "Decoding", rows: decodingRows(misbs, timing)});
        sections.push({title: "Timing", rows: timingRows(misbs, timing, hideNames, baseName)});
        if (misbs.length > 1) sections.push({title: `Compared with ${baseName}`, rows: comparedRows(misbs)});
    }

    const undecodedTags = [...new Set(undecoded.flatMap(items => [...items.keys()]))].sort((a, b) => a - b);
    sections.push({
        title: "Tags Sitrec does not decode (raw hex)",
        rows: undecodedTags.map(tag => {
            const items = undecoded.map(found => found.get(tag));
            const label = items.find(item => item?.name)?.name ?? UNDECODED_TAG_NAMES[tag];
            return tableRow(label ? `${label} (tag ${tag})` : `tag ${tag}`,
                items.map(item => (item?.values ?? []).map(hex => rawValueText(hex, hideNames))), {
                    marked: true,
                    compare: items.map(item => item?.values ?? []),
                });
        }),
    });

    const packets = misbs.map(misb => new Map((misb.otherKLVPackets ?? []).map(packet => [packet.key, packet])));
    const packetKeys = new Map(packets.flatMap(found => [...found.values()].map(packet => [packet.key, packet.standard])));
    sections.push({
        title: "KLV packets that are not ST 0601",
        rows: [...packetKeys].map(([key, standard]) => tableRow(standard ?? `key ${key}`, packets.map(found => {
            const packet = found.get(key);
            return packet ? [`${packet.count} packet(s), ${packet.bytes} bytes`] : [];
        }))),
    });

    const usedSections = sections.filter(section => section.rows.length > 0);
    const lines = ["STREAMS", "─".repeat(60)];
    lines.push(`  (what each KLV stream holds; tag cells show the first ${maxUnique} different values)`, "");
    lines.push(...identifierTable(labels, usedSections));
    if (usedSections.some(section => section.rows.some(row => row.cells.includes(null)))) {
        lines.push("  ? = not saved with this stream. Load the TS file to read it.");
    }
    if (packetKeys.size === 0 && misbs.some(misb => Array.isArray(misb.otherKLVPackets))) {
        lines.push("  KLV packets that are not ST 0601: none");
    }
    if (misbs.length > 1) lines.push(`  ${DIFFERS_MARK} = the streams have different values for this tag.`);
    if (timing?.some(stream => !stream.hasRecordPTS)) {
        lines.push("  hasRecordPTS = no: Sitrec times these records by UnixTimeStamp (tag 2), not by PES PTS.");
    }
    if (timing) lines.push(...clockLines(misbs, timing, !hideNames));
    if (derivedCount > 0) {
        lines.push(`  ${derivedCount} derived track(s) not listed: their rows hold only time and position.`);
    }

    const others = otherStreamLines(misbs, hideNames);
    if (others.length > 0) lines.push("", "OTHER STREAMS IN THE TS", "─".repeat(60), ...others);
    return lines;
}

// Which stream each track uses, and how it is paired to the video. groups: one for
// each stream and pairing mode: {label, hasRecordPTS, mode, count}. video:
// {realPTS, wrapped}. names and hideNames: the track names, see renderTrackNames.
export function renderTracks(groups, {realPTS, wrapped}, {names = [], hideNames = false} = {}) {
    const lines = ["TRACKS (the stream that each track uses)", "─".repeat(60)];
    for (const {label, hasRecordPTS, mode, count} of groups) {
        const pairing = mode === "pts" ? "PES PTS pairing" : "UnixTimeStamp pairing (nominal rate)";
        lines.push(`  ${label} (hasRecordPTS ${hasRecordPTS ? "yes" : "no"}): ${count} track(s), ${pairing}`);
    }
    const framePTS = realPTS ? "real (honors dropped frames)" : "synthetic (uniform)";
    lines.push(`  Video frame PTS: ${framePTS};  patching: ${wrapped ? "WRAPPED (frame patching active)" : "not wrapped"}`, "");
    if (groups.some(group => group.mode !== "pts")) {
        lines.push("  One or more tracks pair by UnixTimeStamp. With frame patching ON (the default)");
        lines.push("  the video timeline is uniform, so the nominal-rate lookup follows true wall-clock");
        lines.push("  time. With patching OFF, such a track can go out of sync through dropped-frame");
        lines.push("  bursts. See docs/dev/misb-timing.md, sections 6c and 12.");
    } else {
        lines.push("  Every track pairs by PES PTS, so the UnixTimeStamp fallback is not used. Frame");
        lines.push("  patching affects playback cadence only, not how KLV pairs to the video.");
    }
    lines.push(...renderTrackNames(names, {hideNames}));
    return lines;
}

// What each derived kind in a track name is made from. Keyed as DERIVED_KIND_NAMES.
const DERIVED_KIND_SOURCES = {
    Center: "tags 23 and 24: where the line of sight through the image center meets the ground,\n"
        + "as the platform computed it",
    Target: "tags 40 to 42: where the platform says the target is",
    Truth: "the truth columns",
};

// The name of each track, and how Sitrec made it (MISBStreamTrackName.js). entries: one for
// each track, in the order of the streams: {label, name, parts}. label: the stream, from
// klvStreamLabels. name: the track's name now. parts: from streamTrackNameParts, or null for a
// track that is not from a TS stream. hideNames: a tail number, and a name that is not Sitrec's,
// print as "hidden".
export function renderTrackNames(entries, {hideNames = false} = {}) {
    if (entries.length === 0) return [];
    let changed = false;
    const shown = entries.map(({name, parts}) => {
        const made = parts ? streamTrackName(parts) : null;
        if (made !== null && name !== made) changed = true;
        if (!hideNames) return made !== null && name !== made ? `"${name}" (Sitrec's name: "${made}")` : `"${name}"`;
        if (made === null || name !== made) return HIDDEN_VALUE;
        return `"${streamTrackName({...parts, tail: parts.tail === null ? null : HIDDEN_VALUE})}"`;
    });
    const width = maxOf(shown.map(text => text.length));
    const lines = ["", "  Track names, as in the Contents menu:"];
    entries.forEach((entry, i) => lines.push(`    ${shown[i].padEnd(width)}  ${entry.label}`));
    const withParts = entries.filter(entry => entry.parts);
    if (withParts.length > 0) {
        lines.push("  A track from a KLV stream in a TS is named \"S<n> LS<v>\", then the tail number of the",
            "  platform track, or the kind of a derived track:");
        const kinds = [...new Set(withParts.map(entry => entry.parts.kind).filter(Boolean))];
        const parts = [
            ["S<n>", "the number of the stream in the TS: ffprobe and ffmpeg -map call it #0:<n>"],
            ["LS<v>", "tag 65, UAS Datalink LS Version Number: the \"local set\" number"],
            ["tail", `tag 4, Platform Tail Number. "${PLATFORM_NAME}" when the stream has none.`],
            ...kinds.map(kind => [DERIVED_KIND_NAMES[kind] ?? kind,
                `a track from ${DERIVED_KIND_SOURCES[kind] ?? "the same stream"}`]),
        ];
        const partWidth = maxOf(parts.map(([part]) => part.length));
        for (const [part, meaning] of parts) {
            // A meaning of two lines goes on under itself.
            const [first, ...rest] = meaning.split("\n");
            lines.push(`    ${part.padEnd(partWidth)}  ${first}`);
            for (const more of rest) lines.push(`    ${"".padEnd(partWidth)}  ${more}`);
        }
    }
    if (entries.some(entry => !entry.parts)) {
        lines.push("  A track that is not from a TS stream is named by its tail number (tag 4), or by its file.");
    }
    if (changed) {
        lines.push("  A name that is not Sitrec's name was changed with the Name control, or was saved by an",
            "  older Sitrec.");
    }
    return lines;
}

// The last part of a file name or URL, without a query, decoded.
function fileBaseName(name) {
    const base = String(name).split(/[?#]/)[0].split("/").pop();
    try {
        return decodeURIComponent(base);
    } catch (e) {
        return base;
    }
}

// The files that the MISB streams came from (sourceFile and sourceBytes, set
// when a KLV file or TS is parsed), each one time, with its size.
export function renderSourceFiles(misbs) {
    const files = new Map();
    for (const misb of misbs) {
        if (!misb || misb.derivedTrack || misb.sourceFile == null) continue;
        const name = fileBaseName(misb.sourceFile);
        if (!files.has(name)) files.set(name, misb.sourceBytes);
    }
    const lines = [...files].map(([name, bytes]) => {
        if (!Number.isFinite(bytes)) return name;
        const mb = bytes >= 1e6 ? `, ${(bytes / 1e6).toFixed(1)} MB` : "";
        return `${name} (${bytes.toLocaleString("en-US")} bytes${mb})`;
    });
    if (lines.length === 0) return [];
    if (lines.length === 1) return [`FILE: ${lines[0]}`];
    return ["FILES:", ...lines.map(line => `  ${line}`)];
}
