import {MISB} from "../MISBFields";

const DEFAULT_GAP_FACTOR = 3;
const DEFAULT_MIN_GAP_S = 0.1;
const HIGH_CV = 0.05;
const SPAN_MISMATCH_WARN_S = 0.5;
const EXACT_PTS_EPSILON_US = 1;

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
    const minIntervalS = positiveIntervals.length ? Math.min(...positiveIntervals) : null;
    const maxIntervalS = positiveIntervals.length ? Math.max(...positiveIntervals) : null;
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
        maxGapS: gaps.length ? Math.max(...gaps.map(gap => gap.dtS)) : null,
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
        maxDeltaUs = Math.max(...deltas);
        meanAbsDeltaUs = mean(deltas);
    }

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
