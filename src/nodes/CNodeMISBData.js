import {LLAToECEF} from "../LLA-ECEF-ENU";
import {FileManager, Globals, NodeMan, Sit} from "../Globals";
import {MISB, MISBFields, computeMisbSpans, computeFpsAnalysis} from "../MISBUtils";
import {decodeMISBTransition, MISBValueDecoders} from "../MISBValueDecoders";
import {CNodeEmptyArray} from "./CNodeArray";
import {saveAs} from "file-saver";

import {CNodeLOSTrackMISB} from "./CNodeLOSTrackMISB";
import {makeArrayNodeFromMISBColumn} from "./CNodeArrayFromMISBColumn";
import {assert} from "../assert";
import {EventManager} from "../CEventManager";
import {elevationAtLL} from "../threeExt";
import {parsePartialDateTime} from "../ParseUtils";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {isAGLLockActive, isAltitudeLockActive} from "../AltitudeLock";
import {t} from "../i18n";

//export const MISBFields = Object.keys(MISB).length;

// export const MISB_Aliases = {
//     // PrecisionTimeStamp uses microseconds not milliseconds
//     // so any conversion will have to detect this and multiply by 1000
//     PrecisionTimeStamp: MISB.UnixTimeStamp,
// }



export class CNodeMISBDataTrack extends CNodeEmptyArray {
    constructor(v) {
        super(v);
//        this.misb = FileManager.get(v.misbFile)

        // if v.misb is an array then it's the data, otherwise it's a file name
        // of an already converted MISB file
        if (Array.isArray(v.misb)) {
            this.misb = v.misb;
        } else {
            this.misb = FileManager.get(v.misb)
        }

        // For tracks with relative timestamps (e.g., seconds from 0), store metadata
        // to enable user override of start time via GUI
        if (v.trackFile && v.trackFile.isRelativeTime) {
            this.isRelativeTime = true;
            this.parsingBaseTime = v.trackFile.parsingBaseTime;
        }
        this.trackStartTime = "";       // user-entered ISO datetime string

        // G-force filter for removing spurious data points
        this.filterEnabled = false;
        this.filterMaxG = 10.0;  // 10g allows for sparse curved tracks where computed g can be high. Most spurious data will result in much higher values (like >100g)
        this.tryAltitudeFirst = true; // try replacing just altitude before removing the point
        this.filteredSlots = new Set();
        this.altitudeFixedSlots = new Map(); // slot -> corrected altitude

        // recalculate() (g-force filter + makeArrayForTrackDisplay) iterates
        // the raw misb rows and never reads Sit.frames/fps/aFrame/bFrame, so
        // a sitch-frame-count change can't alter its output — let
        // updateSitFramesChanged skip the rebake (this is per-aircraft-track
        // work that made the Sitch Frames slider laggy on multi-track sitches)
        this.framesInvariant = true;

        // Altitude datum of the raw column values. Normally MSL (orthometric), which the
        // pipeline converts to HAE by adding the geoid offset N. Set true by HAE sources
        // (e.g. STANAG cs="WGS_84") so that geoid add is skipped (see needsGeoidToHAE()).
        // Serialized so the datum survives save/reload of a custom sitch.
        this.altitudeIsHAE = v.altitudeIsHAE ?? false;
        this.addSimpleSerial("altitudeIsHAE");

        this.selectSourceColumns(v.columns || ["SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "AltitudeAGL"]);

        this.recalculate()

        this.exportable = v.exportable ?? false;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportMISBCSV")
            NodeMan.addExportButton(this, "exportTrackKML")
        }


        // Two terrain-dependent altitude paths need refreshing when terrain changes:
        //   useAGL          — raw KLV/CSV altitudes interpreted as AGL (column-driven)
        //   altitudeLockAGL — display-track-driven AGL lock that writes through to the
        //                     data track (see CNodeDisplayTrack altitudeLock GUI)
        //   note altitudeLockAGL only applies when altitudeLock >= 0, as a altitudeLock = -1 will disable it
        // The previous gate covered only useAGL, leaving altitudeLockAGL tracks frozen
        // against whatever incomplete terrain state existed at first recalculate.
        //
        // Coalesce multiple elevationChanged events within a single frame into one
        // cascade. Terrain tiles often settle in bursts (a dozen events over a few
        // frames as new tiles complete), and the full recalculateCascade through
        // the dependency graph is ~45 ms per call — running it for every tile
        // burst makes playback visibly jerky. One cascade per frame is plenty
        // since the per-frame visual update can't be finer than that anyway.
        EventManager.addEventListener("elevationChanged", () => {
            if (!this.isTerrainDependent()) return;
            if (this._elevRefreshScheduled) return;
            this._elevRefreshScheduled = true;
            // Bump pendingActions so the regression test framework's
            // waitForSceneToSettle (and any other "wait until idle" gate)
            // blocks until the rAF-scheduled cascade has actually run.
            // Without this, terrain tiles can finish loading + the scene
            // can mark itself "settled" while a cascade is still queued,
            // and the screenshot lands on stale track positions — the
            // visible camera angle then varies between runs.
            Globals.pendingActions++;
            requestAnimationFrame(() => {
                this._elevRefreshScheduled = false;
                this.makeArrayForTrackDisplay();
                this.recalculateCascade();
                Globals.pendingActions--;
            });
        });
    }

    // Build a comprehensive timing-analysis report as a plain-text string.
    // Used by the Time menu's "Timing Analysis" button. Designed to be
    // copy-pastable and self-contained — every section names what it shows
    // and what conclusion to draw from it.
    generateTimingAnalysis() {
        const lines = [];
        const sectionBreak = "─".repeat(60);
        const push = (s = "") => lines.push(s);
        const pad = (label, value, w = 32) => `  ${label.padEnd(w)} ${value}`;

        const fmtMs = (v) => (v == null ? "n/a" : `${v.toFixed(3)} ms`);
        const fmtS = (v) => (v == null ? "n/a" : `${v.toFixed(3)} s`);
        const fmtPct = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(2)}%`);

        // Gather video / KLV / Sit state.
        const videoView = NodeMan.get("video", false);
        const videoData = videoView?.videoData;
        // When wrapped in CVideoPatchedData, the wrapper's framePTSus is the
        // synthesized uniform virtual timeline; for diagnostic analysis we
        // want the underlying source PTS so dropped-frame bursts remain
        // visible in the Video Timing section.
        const ptsArr = videoData?.source?.framePTSus || videoData?.framePTSus;
        const isWrapped = videoData && typeof videoData.getPatchStats === "function";
        const hasPTS = Array.isArray(ptsArr) && ptsArr.length > 0;
        const len = this.misb ? this.misb.length : 0;

        // Anonymous header. The report is intended to be paste-safe in
        // any thread / bug tracker, so we deliberately omit anything that
        // could identify the file's flight time, location, platform tail
        // number, mission ID, or operating unit. That includes:
        //   - Generation timestamp (today's date, narrows down session)
        //   - Sit.name (often contains user-set descriptive text)
        //   - MISB node id (frequently contains a tail number, e.g.
        //     TrackData_CG2314, TrackData_N97826)
        //   - Sit.startTime / KLV UnixTimeStamp absolute values (the
        //     wall-clock moment of capture)
        //   - FileManager filenames (often contain date/time stamps in
        //     the encoder's filename convention, e.g.
        //     Livefeed_1_20260503_221555Z_000500.ts)
        //   - videoFirstPESus (PCR origin offset; could be cross-
        //     referenced)
        // Numeric-statistical signal (record counts, intervals, spans
        // in *seconds since stream start*, CV, gap counts, percent
        // coverage, distance spans in metres) is preserved because
        // none of it is tied to absolute time / location / identity.
        push("=== Sitrec MISB Timing Analysis ===");
        push(`Build:            ${process.env.BUILD_VERSION_STRING || "unknown"}`);
        push("");

        // ── SUMMARY ────────────────────────────────────────────────────
        push("SUMMARY");
        push(sectionBreak);

        if (!hasPTS) {
            push("Video data not yet available — load a video to see full analysis.");
            push("");
        }
        if (len < 2) {
            push("KLV data not loaded or too short for analysis.");
            return lines.join("\n");
        }

        // Find first/last valid records.
        let firstValid = -1, lastValid = -1;
        for (let i = 0; i < len; i++) if (this.isValid(i)) { firstValid = i; break; }
        for (let i = len - 1; i >= 0; i--) if (this.isValid(i)) { lastValid = i; break; }
        if (firstValid < 0 || lastValid <= firstValid) {
            push("No valid KLV records — cannot analyze.");
            return lines.join("\n");
        }
        const klvRecords = lastValid - firstValid + 1;
        const klvSpanMs = this.getTime(lastValid) - this.getTime(firstValid);
        const klvSpanS = klvSpanMs / 1000;
        const klvIntervalMean = klvSpanMs / (klvRecords - 1);

        // KLV interval stats.
        let klvMin = Infinity, klvMax = 0, klvSumSq = 0, klvCount = 0;
        const intervals = [];
        for (let i = firstValid + 1; i <= lastValid; i++) {
            if (!this.isValid(i) || !this.isValid(i - 1)) continue;
            const dt = this.getTime(i) - this.getTime(i - 1);
            intervals.push({ idx: i, dt, t: (this.getTime(i) - this.getTime(firstValid)) / 1000 });
            if (dt < klvMin) klvMin = dt;
            if (dt > klvMax) klvMax = dt;
            klvSumSq += (dt - klvIntervalMean) * (dt - klvIntervalMean);
            klvCount++;
        }
        const klvStddev = klvCount > 0 ? Math.sqrt(klvSumSq / klvCount) : 0;
        const klvCv = klvIntervalMean > 0 ? klvStddev / klvIntervalMean : 0;

        // Video PTS stats (only if video is loaded). ptsArr was set above to
        // the *source's* framePTSus when wrapped, so the interval analysis
        // here surfaces dropped-frame bursts instead of the wrapper's
        // uniform virtual timeline (which would always read as perfect CFR).
        let videoSpanS = null, videoFrameCount = 0;
        let ptsMin = null, ptsMax = null, ptsMean = null, ptsStddev = null;
        let videoIntervals = null;
        if (ptsArr && ptsArr.length > 0) {
            videoFrameCount = ptsArr.length;
            videoSpanS = (ptsArr[videoFrameCount - 1] - ptsArr[0]) / 1000 / 1000;
            ptsMin = Infinity; ptsMax = 0;
            let sum = 0;
            const pIntervals = [];
            for (let i = 1; i < videoFrameCount; i++) {
                const dt = (ptsArr[i] - ptsArr[i - 1]) / 1000;
                if (dt < ptsMin) ptsMin = dt;
                if (dt > ptsMax) ptsMax = dt;
                sum += dt;
                pIntervals.push({ idx: i, dt, t: (ptsArr[i] - ptsArr[0]) / 1000 / 1000 });
            }
            ptsMean = sum / pIntervals.length;
            const sq = pIntervals.reduce((a, x) => a + (x.dt - ptsMean) * (x.dt - ptsMean), 0);
            ptsStddev = Math.sqrt(sq / pIntervals.length);
            videoIntervals = pIntervals;
        }

        // Compute gap detection up-front so the headline, verdict, and
        // recommendations can all distinguish real stream gaps (discrete
        // emission pauses) from high CV without gaps (UnixTimeStamp
        // write-time scatter while emission cadence stays clean).
        const gapThresholdMs = Math.max(100, klvIntervalMean * 3);
        const gaps = intervals.filter(g => g.dt > gapThresholdMs);
        const hasRealGaps = gaps.length > 0;
        const highCv = klvCv >= 0.05;

        // Headline assessment.
        const cfrVideo = (ptsStddev !== null && ptsStddev < 0.05);
        const uniformKlv = !hasRealGaps && !highCv;
        const spanDiff = (videoSpanS !== null) ? (klvSpanS - videoSpanS) : null;
        const klvHasPES = this.hasRecordPTS();

        if (cfrVideo && uniformKlv && Math.abs(spanDiff || 0) < 0.5) {
            push("✓ Video and KLV are well-aligned — no timing issues detected.");
        } else if (hasRealGaps) {
            push(`⚠ KLV stream has ${gaps.length} discrete gap${gaps.length === 1 ? "" : "s"} (intervals > ${gapThresholdMs.toFixed(0)} ms).`);
            push("  Track positions are correct where KLV is contiguous; expect");
            push("  brief stale/interpolated values during gap periods.");
        } else if (highCv && klvHasPES) {
            push(`ℹ KLV UnixTimeStamp intervals scatter widely (CV ${(klvCv * 100).toFixed(2)}%) but PES PTS is clean.`);
            push("  Sync uses PES PTS, which is uniform on the PCR clock. The UTS");
            push("  scatter doesn't affect display. Possible causes vary (write-time");
            push("  vs sample-time stamping, RTC behavior, etc.) and aren't determined");
            push("  by this report alone.");
        } else if (highCv) {
            push(`⚠ KLV UnixTimeStamp intervals scatter widely (CV ${(klvCv * 100).toFixed(2)}%) and no PES PTS is available.`);
            push("  Sync falls back to UTS lookup; per-record pairing carries the");
            push("  scatter magnitude as its uncertainty. Usually below the visual");
            push("  threshold; cause not diagnosable from this report alone.");
        }
        if (!cfrVideo) {
            push("⚠ Video has variable frame rate (PTS not uniform).");
        }
        if (Math.abs(spanDiff || 0) > 0.5 && !hasRealGaps) {
            push(`⚠ KLV span and video span differ by ${spanDiff.toFixed(2)} s.`);
        }
        push("");
        push(`  Video frames:      ${videoFrameCount} (${videoSpanS !== null ? videoSpanS.toFixed(3) + " s" : "n/a"})`);
        push(`  KLV records:       ${klvRecords} (${klvSpanS.toFixed(3)} s)`);
        if (videoSpanS !== null) push(`  Span difference:   ${(klvSpanS - videoSpanS > 0 ? "+" : "")}${(klvSpanS - videoSpanS).toFixed(3)} s (KLV − Video)`);
        push(`  Sit.fps:           ${Sit.fps.toFixed(4)}`);
        // Sit.startTime omitted: would reveal absolute capture time.
        push("");

        // ── VIDEO TIMING ───────────────────────────────────────────────
        push(isWrapped
            ? "VIDEO TIMING (source PTS — pre-virtualization)"
            : "VIDEO TIMING (PTS from container)");
        push(sectionBreak);
        if (hasPTS) {
            const realPTS = (typeof videoData.hasRealFramePTS === "function")
                ? videoData.hasRealFramePTS() : "(unknown)";
            push(pad("Frames:", videoFrameCount));
            push(pad("Span:", fmtS(videoSpanS)));
            push(pad("Mean interval:", `${fmtMs(ptsMean)} (= ${(1000 / ptsMean).toFixed(4)} fps in PCR clock)`));
            push(pad("Stddev:", fmtMs(ptsStddev)));
            push(pad("Min interval:", fmtMs(ptsMin)));
            push(pad("Max interval:", fmtMs(ptsMax)));
            push(pad("Verdict:", cfrVideo ? "Constant frame rate (CFR) — reliable" : "Variable frame rate — non-uniform"));

            // Real-world frame-rate estimate via shared computeFpsAnalysis
            // helper (see MISBUtils.js for the full rationale and math).
            // Skip when KLV UTS is too scattered to trust (high CV).
            const _spans = klvCv < 0.5 ? computeMisbSpans(this.misb) : null;
            const _fps = _spans && _spans.pesSpanS > 0 ? computeFpsAnalysis({
                videoFrameCount,
                videoPesSpanS: videoSpanS,
                klvUtsSpanS: _spans.utsSpanS,
                klvPesSpanS: _spans.pesSpanS,
            }) : { valid: false };
            if (_fps.valid) {
                push(pad("Real-time fps (from KLV UTS):", `${_fps.realFps.toFixed(4)} fps`));
                if (_fps.fpsGap > 0.01) {
                    push(pad("  Labeled vs real fps gap:", `${(_fps.fpsGap * 100).toFixed(2)}% — encoder is writing PTS at the wrong cadence`));
                    push(pad("  Recommended Sit.fps:", `${_fps.realFps.toFixed(0)} (use real-time fps from KLV UTS)`));
                }
            }
            push(pad("Frame PTS source:", realPTS === true
                ? "real PES PTS (TSParser pesEntries[]) — honors dropped frames"
                : realPTS === false
                    ? "synthetic uniform (i × frameDuration) — DROPPED FRAMES INVISIBLE"
                    : String(realPTS)));

            // Patch layer (CVideoPatchedData) — reports whether the video is
            // wrapped in a virtual-frame timeline and how many held slots
            // were synthesized to fill dropped-frame bursts. See
            // docs/dev/misb-timing.md.
            if (videoData && typeof videoData.getPatchStats === "function") {
                const ps = videoData.getPatchStats();
                push(pad("Frame patching:", `WRAPPED (fillMode=${ps.fillMode})`));
                push(pad("  source frames:", ps.sourceFrames));
                push(pad("  virtual frames:", ps.virtualFrames));
                push(pad("  held frames:", `${ps.heldFrames} (${(ps.heldFrames * 100 / ps.virtualFrames).toFixed(2)}%)`));
                push(pad("  longest hold:", `${ps.longestHoldFrames} f (${ps.longestHoldMs.toFixed(0)} ms)`));
                push(pad("  total patches:", ps.patches.length));
                if (ps.patches.length > 0) {
                    push("");
                    const top = [...ps.patches].sort((a, b) => b.length - a.length).slice(0, 10);
                    const showAll = ps.patches.length <= 10;
                    push(showAll
                        ? `  PATCHES (all ${ps.patches.length}, by size):`
                        : `  TOP 10 PATCHES (of ${ps.patches.length}, by size):`);
                    // src gap = PCR interval between two consecutive source
                    // frames (matches the PTS Jumps table); held ms = the
                    // virtual time we actually synthesize, ≈ src gap − one
                    // frame duration (the canonical step that would have
                    // existed without a drop).
                    push("    #     src(N→N+1)        virtual range          held f   held ms   src gap ms");
                    push("    ───   ─────────────     ──────────────────     ──────   ───────   ──────────");
                    const srcPTS = videoData.source && Array.isArray(videoData.source.framePTSus)
                        ? videoData.source.framePTSus : null;
                    for (let i = 0; i < top.length; i++) {
                        const p = top[i];
                        const heldMs = (p.length * 1000 / ps.fps).toFixed(0);
                        const srcGap = srcPTS && p.sourceFrame + 1 < srcPTS.length
                            ? ((srcPTS[p.sourceFrame + 1] - srcPTS[p.sourceFrame]) / 1000).toFixed(0)
                            : "n/a";
                        const srcSpan = `${p.sourceFrame} → ${p.sourceFrame + 1}`.padEnd(13);
                        const virSpan = `${p.vStart}..${p.vEnd}`.padEnd(18);
                        push(`    ${String(i + 1).padStart(3)}   ${srcSpan}     ${virSpan}     ${String(p.length).padStart(6)}   ${heldMs.padStart(7)}   ${srcGap.padStart(10)}`);
                    }
                }
            } else {
                push(pad("Frame patching:", "not wrapped"));
            }

            // Per-frame outliers — anything significantly off the median interval
            // is a video-side gap or PTS jump worth flagging.
            const vidGapThresh = Math.max(1, ptsMean * 1.5);
            const vidGaps = videoIntervals.filter(g => g.dt > vidGapThresh);
            if (vidGaps.length > 0) {
                push("");
                push(`  Video PTS jumps (interval > ${vidGapThresh.toFixed(0)} ms): ${vidGaps.length}`);
                push("    frame     pts-time      gap (ms)");
                push("    ──────    ──────────    ────────");
                for (const g of vidGaps.slice(0, 20)) {
                    push(`    ${String(g.idx).padStart(6)}    ${g.t.toFixed(2).padStart(10)} s   ${g.dt.toFixed(0).padStart(8)}`);
                }
                if (vidGaps.length > 20) push(`    … and ${vidGaps.length - 20} more`);
            }
        } else {
            push("  (video not loaded)");
        }
        push("");

        // ── KLV TIMING ─────────────────────────────────────────────────
        // UnixTimeStamp (MISB ST 0601 Tag 2) is the wall-clock value the
        // camera wrote inside each KLV record. PES PTS (next section, when
        // available) is the encoder-emitted PCR-locked timestamp. They can
        // disagree in shape even when both clocks are accurate, because each
        // is captured at a different point in the camera's pipeline; this
        // report describes what the data shows rather than diagnosing why.
        push("KLV TIMING (UnixTimeStamp intervals)");
        push(sectionBreak);
        push(pad("Records:", klvRecords));
        push(pad("Span:", fmtS(klvSpanS)));
        push(pad("Mean interval:", `${fmtMs(klvIntervalMean)} (= ${(1000 / klvIntervalMean).toFixed(4)} eff. fps)`));
        push(pad("Stddev:", fmtMs(klvStddev)));
        push(pad("Min interval:", fmtMs(klvMin)));
        push(pad("Max interval:", fmtMs(klvMax)));
        push(pad("Coeff. of variation:", `${fmtPct(klvCv)} (stddev / mean) ${klvCv > 0.05 ? "(>5%, scattered)" : "(<5%, tight)"}`));
        push(pad("Max/mean ratio:", `${(klvMax / klvIntervalMean).toFixed(1)}× ${klvMax > 5 * klvIntervalMean ? "(>5×, gap likely)" : "(<5×, no gap)"}`));
        // Verdict distinguishes three observable states: uniform, real gaps
        // (any individual interval > gapThresholdMs), and scattered intervals
        // (high CV but no individual interval over the threshold). Cause of
        // the latter — write-time stamping, RTC behavior, etc. — is not
        // diagnosable from the report; we just describe what the data shows.
        let klvVerdict;
        if (!hasRealGaps && !highCv) {
            klvVerdict = "Uniform — tight intervals, no gaps";
        } else if (hasRealGaps && highCv) {
            klvVerdict = `Has gaps (${gaps.length}, max ${klvMax.toFixed(0)} ms) AND scattered intervals`;
        } else if (hasRealGaps) {
            klvVerdict = `Has ${gaps.length} gap${gaps.length === 1 ? "" : "s"} (max ${klvMax.toFixed(0)} ms)`;
        } else {
            // High CV without any individual interval crossing the threshold.
            klvVerdict = `Scattered intervals (CV ${(klvCv * 100).toFixed(1)}%, max ${klvMax.toFixed(0)} ms < gap threshold)`;
        }
        push(pad("Verdict:", klvVerdict));
        push("");

        // ── KLV GAPS ───────────────────────────────────────────────────
        push(`KLV GAPS (intervals > ${gapThresholdMs.toFixed(0)} ms)`);
        push(sectionBreak);
        if (gaps.length === 0) {
            if (highCv) {
                push("  None — no individual interval exceeds the gap threshold,");
                push(`  but UTS values scatter widely (CV ${(klvCv * 100).toFixed(2)}%).`);
                push("  Possible explanations include write-time vs sample-time stamping,");
                push("  per-record processing delay variation, or RTC behavior — this");
                push("  report can't distinguish among them.");
                push("  Compare to KLV PES PTS TIMING below: if that section's CV is");
                push("  low, the encoder-side emission cadence is clean and sync uses");
                push("  PES PTS as the anchor regardless of the UTS scatter.");
            } else {
                push("  None — KLV stream is contiguous.");
            }
        } else {
            const gapSum = gaps.reduce((a, g) => a + (g.dt - klvIntervalMean), 0);
            push(`  ${gaps.length} gaps detected, ${(gapSum / 1000).toFixed(2)} s of "missing" emissions:`);
            push("");
            push("    record    klv-time      gap (ms)");
            push("    ──────    ──────────    ────────");
            for (const g of gaps.slice(0, 50)) {
                push(`    ${String(g.idx).padStart(6)}    ${g.t.toFixed(2).padStart(10)} s   ${g.dt.toFixed(0).padStart(8)}`);
            }
            if (gaps.length > 50) push(`    … and ${gaps.length - 50} more`);
        }
        push("");

        // ── KLV PES PTS TIMING ────────────────────────────────────────
        // PES PTS is the synchronous-mode anchor on the same axis as video
        // PTS. If gaps appear here too, the camera really paused on the
        // PCR-locked clock; if they only appear in UnixTimeStamp, the camera
        // is fabricating wall-clock timestamps during sensor reconfiguration.
        push("KLV PES PTS AVAILABILITY (MISB ST 0604 sync anchor)");
        push(sectionBreak);
        const pesArr = this.misb && this.misb.pesPTSus;
        const pesIsArray = Array.isArray(pesArr);
        const pesLen = pesIsArray ? pesArr.length : 0;
        const pesNonNull = pesIsArray ? pesArr.filter(v => v !== null && v !== undefined).length : 0;
        // Surface sidecar fetch failures recorded by the deserialize loop. If
        // the sitch's loadedFilesMetadata advertised a sidecar URL but the
        // fetch failed, sync silently degrades to synthetic without anything
        // in the analysis that screams. Print *count* only, never URLs or
        // file IDs (URLs may contain origin/path identifying the source).
        if (typeof FileManager !== "undefined" && FileManager.pesSidecarFailures) {
            const failures = Object.entries(FileManager.pesSidecarFailures);
            if (failures.length > 0) {
                push(`  ⚠ PES SIDECAR FETCH FAILED for ${failures.length} entries during sitch reload.`);
                push("    (Sync will fall back to synthetic timestamps; the file's pesPTSus will be missing.)");
                push("");
            }
        }
        push(pad("hasRecordPTS():", String(this.hasRecordPTS())));
        push(pad("misb.pesPTSus is Array:", String(pesIsArray)));
        push(pad("misb.pesPTSus length:", `${pesLen} (vs record count = ${len})`));
        push(pad("Non-null entries:", `${pesNonNull} / ${pesLen}`));
        // misb constructor name omitted — class names like "Array" or
        // "CTrackFileMISB" aren't identifying themselves but they don't
        // affect the timing diagnosis either, and keeping the report
        // tightly anonymous matters more.
        // Walk FileManager looking for any entry whose .data refers to
        // this misb, but emit only structural booleans — never any
        // filenames, keys, or absolute PCR offsets.
        try {
            const list = (typeof FileManager !== "undefined") ? (FileManager.list ?? {}) : {};
            let matched = null;
            for (const [k, e] of Object.entries(list)) {
                if (!e) continue;
                if (e.data === this.misb || (e.data && e.data.data === this.misb) || (e.data && e.data.misb === this.misb)) {
                    matched = { key: k, entry: e };
                    break;
                }
            }
            if (matched) {
                const e = matched.entry;
                push(pad("FileManager match:", "yes"));
                push(pad("Has .tsParentFilename:", e.tsParentFilename ? "yes (TS-demuxed)" : "no"));
                push(pad("Has .pesEntries:", Array.isArray(e.pesEntries) ? `yes (length ${e.pesEntries.length})` : "no"));
                push(pad("Has .videoFirstPESus:", typeof e.videoFirstPESus === "number" ? "yes" : "no"));
            } else {
                push("  (no FileManager entry refers to this misb)");
                const klvCount = Object.values(list)
                    .filter(e => e && (e.dataType === "klv" || e.dataType === "trackfile")).length;
                if (klvCount > 0) {
                    push(pad("Loaded KLV/track entries:", `${klvCount} total`));
                }
            }
        } catch (e) {
            push(`  (FileManager probe failed: ${e.message})`);
        }
        push("");

        const hasPesPTS = this.hasRecordPTS();
        let pesIntervals = null;
        let pesGaps = null;
        let pesSpanS = null;
        if (hasPesPTS) {
            const pes = this.misb.pesPTSus;
            pesSpanS = (pes[lastValid] - pes[firstValid]) / 1e6;
            pesIntervals = [];
            let pesMin = Infinity, pesMax = 0, pesSum = 0, pesCount = 0;
            for (let i = firstValid + 1; i <= lastValid; i++) {
                const dt = (pes[i] - pes[i - 1]) / 1000; // ms
                if (!isFinite(dt)) continue;
                pesIntervals.push({ idx: i, dt, t: (pes[i] - pes[firstValid]) / 1e6 });
                if (dt < pesMin) pesMin = dt;
                if (dt > pesMax) pesMax = dt;
                pesSum += dt;
                pesCount++;
            }
            const pesMean = pesCount > 0 ? pesSum / pesCount : 0;
            const pesSq = pesIntervals.reduce((a, x) => a + (x.dt - pesMean) * (x.dt - pesMean), 0);
            const pesStddev = pesCount > 0 ? Math.sqrt(pesSq / pesCount) : 0;
            const pesCv = pesMean > 0 ? pesStddev / pesMean : 0;

            push("KLV PES PTS TIMING (synchronous-mode PCR anchor)");
            push(sectionBreak);
            push(pad("Records:", klvRecords));
            push(pad("Span:", fmtS(pesSpanS)));
            push(pad("Mean interval:", `${fmtMs(pesMean)} (= ${(1000 / pesMean).toFixed(4)} eff. fps)`));
            push(pad("Stddev:", fmtMs(pesStddev)));
            push(pad("Min interval:", fmtMs(pesMin)));
            push(pad("Max interval:", fmtMs(pesMax)));
            push(pad("Coeff. of variation:", `${fmtPct(pesCv)} ${pesCv > 0.05 ? "(FAIL: >5%)" : "(ok)"}`));
            if (videoSpanS !== null) {
                const pesVsVid = pesSpanS - videoSpanS;
                push(pad("Span vs Video:", `${pesVsVid >= 0 ? "+" : ""}${pesVsVid.toFixed(3)} s (PES − Video)`));
            }
            push(pad("Span vs UnixTime:", `${(pesSpanS - klvSpanS) >= 0 ? "+" : ""}${(pesSpanS - klvSpanS).toFixed(3)} s (PES − UTS)`));
            push("");

            const pesGapThresh = Math.max(100, pesMean * 3);
            pesGaps = pesIntervals.filter(g => g.dt > pesGapThresh);
            push(`KLV PES PTS GAPS (intervals > ${pesGapThresh.toFixed(0)} ms)`);
            push(sectionBreak);
            if (pesGaps.length === 0) {
                push("  None — PES PTS stream is contiguous on the PCR clock.");
                push("  → If KLV (UnixTimeStamp) intervals show gaps or high scatter,");
                push("    the encoder-side emission was uninterrupted regardless: the");
                push("    differences live in the UnixTimeStamp values written into");
                push("    successive records, not between record emissions. Possible");
                push("    causes include write-time scatter, RTC steps, or stream");
                push("    selection differences — distinguishing them needs more info");
                push("    than this report has.");
            } else {
                const pesGapSum = pesGaps.reduce((a, g) => a + (g.dt - pesMean), 0);
                push(`  ${pesGaps.length} gaps detected, ${(pesGapSum / 1000).toFixed(2)} s of "missing" emissions:`);
                push("");
                push("    record    pes-time      gap (ms)");
                push("    ──────    ──────────    ────────");
                for (const g of pesGaps.slice(0, 50)) {
                    push(`    ${String(g.idx).padStart(6)}    ${g.t.toFixed(2).padStart(10)} s   ${g.dt.toFixed(0).padStart(8)}`);
                }
                if (pesGaps.length > 50) push(`    … and ${pesGaps.length - 50} more`);
            }
            push("");
        }

        // ── QUARTILE DRIFT ─────────────────────────────────────────────
        if (hasPTS) {
            push("CUMULATIVE DRIFT (KLV vs. Video PTS at quartile points)");
            push(sectionBreak);
            const headerCols = hasPesPTS
                ? "    point     video-time     uts-time     pes-time      uts-diff    pes-diff"
                : "    point     video-time     klv-time      diff";
            push(headerCols);
            push(hasPesPTS
                ? "    ─────     ──────────     ──────────   ──────────    ────────    ────────"
                : "    ─────     ──────────     ──────────    ────");
            const pes = hasPesPTS ? this.misb.pesPTSus : null;
            for (const q of [0.25, 0.5, 0.75, 1.0]) {
                const f = Math.floor((videoFrameCount - 1) * q);
                const k = firstValid + Math.floor((klvRecords - 1) * q);
                const vidT = (ptsArr[f] - ptsArr[0]) / 1000 / 1000;
                const klvT = (this.getTime(k) - this.getTime(firstValid)) / 1000;
                const diff = klvT - vidT;
                if (hasPesPTS) {
                    const pesT = (pes[k] - pes[firstValid]) / 1e6;
                    const pesDiff = pesT - vidT;
                    push(`    q=${q.toFixed(2)}  ${vidT.toFixed(3).padStart(10)} s  ${klvT.toFixed(3).padStart(10)} s ${pesT.toFixed(3).padStart(10)} s  ${(diff >= 0 ? "+" : "")}${diff.toFixed(3)} s  ${(pesDiff >= 0 ? "+" : "")}${pesDiff.toFixed(3)} s`);
                } else {
                    push(`    q=${q.toFixed(2)}  ${vidT.toFixed(3).padStart(10)} s  ${klvT.toFixed(3).padStart(10)} s  ${(diff >= 0 ? "+" : "")}${diff.toFixed(3)} s`);
                }
            }
            push("");

            // Drift decomposition: separate the smooth clock-skew portion from
            // the discontinuous gap-jump portion. The naive approach of fitting
            // a line over all gap-free samples is contaminated, because every
            // sample AFTER a gap inherits the gap's cumulative shift in its
            // diff value. To get a clean clock-rate ratio we fit only over
            // the prefix BEFORE the first gap.
            push("DRIFT DECOMPOSITION");
            push(sectionBreak);
            const firstGapIdx = gaps.length > 0 ? Math.min(...gaps.map(g => g.idx)) : (lastValid + 1);
            const skewEnd = Math.min(firstGapIdx, lastValid + 1);
            // Pair record i with the proportionally-i-th video frame (same
            // pairing used by the CUMULATIVE DRIFT table). Pairing by t_uts
            // would self-align and zero out the slope.
            const klvCount = klvRecords;
            let sX = 0, sY = 0, sXX = 0, sXY = 0, n = 0;
            for (let i = firstValid + 1; i < skewEnd; i++) {
                const t_uts = (this.getTime(i) - this.getTime(firstValid)) / 1000;
                const fIdx = Math.min(videoFrameCount - 1,
                    Math.round((i - firstValid) * (videoFrameCount - 1) / (klvCount - 1)));
                const t_vid = (ptsArr[fIdx] - ptsArr[0]) / 1000 / 1000;
                const diff = t_uts - t_vid;
                sX += t_vid; sY += diff; sXX += t_vid * t_vid; sXY += t_vid * diff;
                n++;
            }
            const denom = n * sXX - sX * sX;
            const slope = (n >= 2 && denom > 0) ? (n * sXY - sX * sY) / denom : 0;
            const intercept = n > 0 ? (sY - slope * sX) / n : 0;
            const skewPpm = slope * 1e6;
            const cumGap = gaps.reduce((a, g) => a + (g.dt - klvIntervalMean), 0) / 1000;
            const observedTotal = klvSpanS - videoSpanS;
            const linearAtEnd = intercept + slope * videoSpanS;
            const residual = observedTotal - cumGap - linearAtEnd;
            const fitRangeS = (skewEnd > firstValid + 1)
                ? `${((this.getTime(skewEnd - 1) - this.getTime(firstValid)) / 1000).toFixed(0)} s`
                : "n/a";
            push(pad("Skew fit range:", `0 s → ${fitRangeS} (pre-first-gap, ${n} samples)`));
            push(pad("Linear clock skew:", `${slope >= 0 ? "+" : ""}${(slope * 1000).toFixed(3)} ms/s (${skewPpm >= 0 ? "+" : ""}${skewPpm.toFixed(0)} ppm)`));
            push(pad("Skew at end of run:", `${linearAtEnd >= 0 ? "+" : ""}${linearAtEnd.toFixed(3)} s (extrapolated)`));
            push(pad("Cumulative gap time:", `${cumGap >= 0 ? "+" : ""}${cumGap.toFixed(3)} s (${gaps.length} gaps)`));
            push(pad("Observed end drift:", `${observedTotal >= 0 ? "+" : ""}${observedTotal.toFixed(3)} s (KLV − Video span)`));
            push(pad("Unexplained residual:", `${residual >= 0 ? "+" : ""}${residual.toFixed(3)} s`));
            push("");
        }

        // ── GPS VELOCITY CONSISTENCY ───────────────────────────────────
        push("PLATFORM/SENSOR GPS VELOCITY CONSISTENCY");
        push(sectionBreak);
        try {
            const velReport = this._analyzeGpsVelocity(firstValid, lastValid, klvIntervalMean);
            for (const line of velReport) push(line);
        } catch (e) {
            push(`  (velocity analysis failed: ${e.message})`);
        }
        push("");

        // ── DUPLICATE/REVERSE TIMESTAMPS ───────────────────────────────
        const dupes = [];
        for (let i = firstValid + 1; i <= lastValid; i++) {
            if (!this.isValid(i) || !this.isValid(i - 1)) continue;
            const dt = this.getTime(i) - this.getTime(i - 1);
            if (dt <= 0) {
                dupes.push({
                    idx: i,
                    dt,
                    t: (this.getTime(i) - this.getTime(firstValid)) / 1000,
                });
            }
        }
        push("DUPLICATE / REVERSED TIMESTAMPS");
        push(sectionBreak);
        if (dupes.length === 0) {
            push("  None — every KLV record's timestamp is greater than the previous.");
        } else {
            push(`  ${dupes.length} record${dupes.length === 1 ? "" : "s"} with dt ≤ 0 (timestamp not strictly increasing):`);
            push("");
            push("    record    klv-time      dt (ms)");
            for (const d of dupes.slice(0, 30)) {
                push(`    ${String(d.idx).padStart(6)}    ${d.t.toFixed(2).padStart(10)} s   ${d.dt.toFixed(0).padStart(7)}`);
            }
            if (dupes.length > 30) push(`    … and ${dupes.length - 30} more`);
            push("");
            push("  Duplicate timestamps usually mean the camera retransmitted a record");
            push("  or the demuxer emitted the same KLV packet twice. Negative dt is");
            push("  worse — out-of-order delivery that the binary search can't handle");
            push("  cleanly. Cross-reference these with the gap clusters above.");
        }
        push("");

        // ── FIELD COVERAGE (per-tag presence over the stream) ─────────
        // Diagnoses cases like "angles look correct but the platform
        // marker stops moving 40% of the way through" — that pattern
        // means the platform-position tags are populated only in part
        // of the stream while the angle/corner-point tags are present
        // throughout, so the position track ends at its last valid
        // record while the angles continue. Per-tag presence stats
        // make this immediately visible without browser debugging.
        push("FIELD COVERAGE (key navigation tags)");
        push(sectionBreak);
        try {
            const coverage = this._analyzeFieldCoverage(firstValid, lastValid);
            for (const line of coverage) push(line);
        } catch (e) {
            push(`  (field coverage analysis failed: ${e.message})`);
        }
        push("");

        // ── EVENT CORRELATIONS WITH KLV GAPS ──────────────────────────
        push("EVENT CORRELATIONS WITH KLV GAPS");
        push(sectionBreak);
        try {
            const corrReport = this._analyzeGapCorrelations(gaps);
            for (const line of corrReport) push(line);
        } catch (e) {
            push(`  (correlation analysis failed: ${e.message})`);
        }
        push("");

        // ── RECOMMENDATIONS ────────────────────────────────────────────
        push("RECOMMENDATIONS");
        push(sectionBreak);
        if (cfrVideo && uniformKlv && Math.abs(spanDiff || 0) < 0.5) {
            push("  No action needed.");
        } else {
            if (hasRealGaps) {
                push("  • KLV stream has gap discontinuities. Track positions during gap");
                push("    periods will show linearly-interpolated values between bracketing");
                push("    records. No automatic correction is appropriate.");
            }
            if (highCv && !hasRealGaps && klvHasPES) {
                push("  • UnixTimeStamp interval scatter is high but PES PTS is uniform.");
                push("    Sync uses PES PTS, so the UTS scatter doesn't affect display.");
                push("    No action needed.");
            }
            if (highCv && !hasRealGaps && !klvHasPES) {
                push("  • UnixTimeStamp interval scatter is high and no PES PTS is");
                push("    available. Sync uses UTS lookup; per-record pairing carries");
                push("    the scatter as its uncertainty. Magnitude is typically below");
                push("    the visual-sync threshold.");
            }
            if (cfrVideo && Math.abs(spanDiff || 0) > 0.5 && !hasRealGaps && !highCv) {
                push("  • Span mismatch with uniform KLV — likely uniform clock-rate error.");
                push("    Consider applying KLV-derived fps via the Time menu.");
            }
            if (!cfrVideo) {
                push("  • Variable-rate video. Use video PTS for frame timing rather");
                push("    than relying on Sit.fps. (Sitrec does this automatically when");
                push("    framePTSus is real.)");
            }
            // Encoder PTS-cadence-mismatch driven Sit.fps recommendation.
            // Same shared helper as the VIDEO TIMING section above.
            const _recSpans = klvCv < 0.5 ? computeMisbSpans(this.misb) : null;
            const _recFps = _recSpans && _recSpans.pesSpanS > 0 ? computeFpsAnalysis({
                videoFrameCount,
                videoPesSpanS: videoSpanS,
                klvUtsSpanS: _recSpans.utsSpanS,
                klvPesSpanS: _recSpans.pesSpanS,
                currentSitFps: Sit.fps,
            }) : { valid: false };
            if (_recFps.valid && _recFps.fpsGap > 0.01 && _recFps.sitFpsDelta > 0.01) {
                const { pcrFps: labeledFps, realFps, fpsGap } = _recFps;
                push(`  • Encoder PTS-cadence mismatch detected (${(fpsGap * 100).toFixed(1)}% gap). PES-labeled fps is ${labeledFps.toFixed(2)},`);
                push(`    real-time fps from KLV UTS is ${realFps.toFixed(2)}, current Sit.fps is ${Sit.fps.toFixed(2)}.`);
                push(`    The encoder is writing PTS values at ${labeledFps.toFixed(0)} fps cadence while frames arrive at`);
                push(`    ${realFps.toFixed(0)} fps (a known ffmpeg ’-r N without fps filter’ footgun, or a similar`);
                push(`    misconfiguration). The PCR oscillator itself is fine; only the per-frame PTS`);
                push(`    increment is wrong. Set Sit.fps to ${Math.round(realFps)} so the platform track aligns to`);
                push(`    real-time playback. Without this, the platform marker reaches end-of-track at`);
                push(`    Sitrec frame ${Math.round(Sit.fps * klvSpanS)} of ${videoFrameCount} instead of ${Math.round(realFps * klvSpanS)}.`);
            }
        }

        return lines.join("\n");
    }

    // For each KLV gap, look at which other MISB fields are transitioning
    // (becoming defined, becoming undefined, or changing significantly) at
    // the boundary. Fields that transition at most/all gaps are correlated
    // with whatever is causing the gap. Useful for diagnosing sensor-mode
    // events (laser rangefinder firing, designator activation, target lock
    // changes) that produce telemetry hiccups.
    // Per-tag presence histogram for the navigation-relevant subset of
    // MISB fields. For each tag we report: count of populated records,
    // coverage % of the stream, the first and last record where the tag
    // is populated, and a coverage *shape* classification:
    //   FULL         — populated in ≥99% of records (incl. trailing/leading gaps ≤1%)
    //   EARLY-ONLY   — present from start, drops out, never resumes (last < 95% of stream)
    //   LATE-ONLY    — starts late, present through end (first > 5% of stream)
    //   GAP-MIDDLE   — present at both ends but missing some middle range
    //   SPARSE       — populated in <50% of records, scattered
    //   ABSENT       — never populated
    // The "EARLY-ONLY" classification specifically catches the
    // "platform marker stops moving partway through" symptom: tags
    // 13/14/15 (Sensor Lat/Lon/Alt) populated only for part of the
    // stream while corner-point and angle tags are populated
    // throughout. Knowing the cutoff record index/time tells you
    // exactly where the platform GPS data ran out.
    _analyzeFieldCoverage(firstValid, lastValid) {
        const lines = [];
        if (!this.misb || this.misb.length === 0) {
            lines.push("  No MISB data.");
            return lines;
        }

        // Curated set of tags whose presence/absence directly affects
        // visible track rendering. Group labels mirror the user's
        // mental model (platform vs sensor pointing vs corners).
        const groups = [
            ["Platform position",  [13, 14, 15]],          // Sensor Lat/Lon/Alt
            ["Platform attitude",  [5, 6, 7]],             // Heading/Pitch/Roll
            ["Sensor pointing",    [16, 17, 18, 19, 20]],  // HFOV/VFOV/Az/El/Roll
            ["Frame center",       [23, 24, 25]],          // FC Lat/Lon/Elev
            ["Corner points (Full)", [82, 83, 84, 85, 86, 87, 88, 89]],
            ["Corner offsets",     [26, 27, 28, 29, 30, 31, 32, 33]],
            ["Slant/Target",       [21, 22, 40, 41, 42]],
        ];

        const indexToName = {};
        for (const k in MISB) {
            // Prefer the first name we see for each numeric tag; the
            // MISB constants have a couple of aliases (TrackID==59 vs
            // PlatformCallSign), and we want the canonical one.
            if (indexToName[MISB[k]] === undefined) indexToName[MISB[k]] = k;
        }

        const N = lastValid - firstValid + 1;

        const isPopulated = (v) => v !== null && v !== undefined && v !== "";

        const classify = (count, firstIdx, lastIdx) => {
            if (count === 0) return "ABSENT";
            const cov = count / N;
            const firstFrac = (firstIdx - firstValid) / Math.max(1, N - 1);
            const lastFrac = (lastIdx - firstValid) / Math.max(1, N - 1);
            if (cov >= 0.99) return "FULL";
            if (firstFrac <= 0.05 && lastFrac < 0.95) return "EARLY-ONLY";
            if (firstFrac > 0.05 && lastFrac >= 0.95) return "LATE-ONLY";
            if (cov >= 0.5 && firstFrac <= 0.05 && lastFrac >= 0.95) return "GAP-MIDDLE";
            if (cov < 0.5) return "SPARSE";
            return "PARTIAL";
        };

        // Time-of-record helper: PES PTS first if available, else
        // UnixTimeStamp delta from firstValid. We want the user-facing
        // time not raw record index.
        const hasPES = this.hasRecordPTS();
        const pesArr = this.misb && this.misb.pesPTSus;
        const timeOfIdx = (i) => {
            if (hasPES && Array.isArray(pesArr) && pesArr[i] != null && pesArr[firstValid] != null) {
                return (pesArr[i] - pesArr[firstValid]) / 1e6;
            }
            return (this.getTime(i) - this.getTime(firstValid)) / 1000;
        };

        lines.push(`  Analyzed window: records ${firstValid}–${lastValid} (${N} records)`);
        lines.push(`  Time anchor: ${hasPES ? "PES PTS" : "UnixTimeStamp"}`);
        lines.push("");
        lines.push("    tag  name                              count    cov%  first→last (s)         shape");
        lines.push("    ───  ────────────────────────────────  ───────  ────  ─────────────────────  ───────────");

        const flagged = [];
        for (const [groupLabel, tags] of groups) {
            lines.push(`  [${groupLabel}]`);
            for (const tag of tags) {
                let count = 0;
                let firstIdx = -1;
                let lastIdx = -1;
                for (let i = firstValid; i <= lastValid; i++) {
                    const row = this.misb[i];
                    if (!row) continue;
                    if (isPopulated(row[tag])) {
                        count++;
                        if (firstIdx < 0) firstIdx = i;
                        lastIdx = i;
                    }
                }
                const cov = count / N;
                const shape = classify(count, firstIdx, lastIdx);
                const name = (indexToName[tag] || `Tag${tag}`).slice(0, 32);
                if (count === 0) {
                    lines.push(`    ${String(tag).padStart(3)}  ${name.padEnd(32)}  ${String(count).padStart(7)}  ${"  -".padStart(4)}  ${"-".padStart(21)}  ${shape}`);
                } else {
                    const tFirst = timeOfIdx(firstIdx);
                    const tLast = timeOfIdx(lastIdx);
                    const range = `${tFirst.toFixed(1).padStart(7)} → ${tLast.toFixed(1).padStart(7)}`;
                    lines.push(`    ${String(tag).padStart(3)}  ${name.padEnd(32)}  ${String(count).padStart(7)}  ${(cov * 100).toFixed(1).padStart(4)}  ${range}  ${shape}`);
                }
                if (shape === "EARLY-ONLY" || shape === "LATE-ONLY" || shape === "GAP-MIDDLE" || (shape === "SPARSE" && count > 0)) {
                    flagged.push({ tag, name, shape, count, cov, firstIdx, lastIdx, tFirst: timeOfIdx(firstIdx), tLast: timeOfIdx(lastIdx) });
                }
            }
        }

        if (flagged.length > 0) {
            lines.push("");
            lines.push("  Flagged coverage anomalies:");
            for (const f of flagged) {
                if (f.shape === "EARLY-ONLY") {
                    lines.push(`  • ${f.name} (tag ${f.tag}): present only in first ${(f.cov * 100).toFixed(1)}% of stream — ends at record ${f.lastIdx} (t=${f.tLast.toFixed(1)}s).`);
                    lines.push("    The track using this tag will stop updating at that point while");
                    lines.push("    other tracks (using continuously-populated tags) keep moving.");
                } else if (f.shape === "LATE-ONLY") {
                    lines.push(`  • ${f.name} (tag ${f.tag}): doesn't start until record ${f.firstIdx} (t=${f.tFirst.toFixed(1)}s).`);
                } else if (f.shape === "GAP-MIDDLE") {
                    lines.push(`  • ${f.name} (tag ${f.tag}): missing in middle of stream — coverage ${(f.cov * 100).toFixed(1)}%.`);
                } else if (f.shape === "SPARSE") {
                    lines.push(`  • ${f.name} (tag ${f.tag}): sparse — only ${f.count} records (${(f.cov * 100).toFixed(1)}%).`);
                }
            }
        }

        // ── Stuck-value detection ──────────────────────────────────────
        // Distinct from coverage: a tag can be 100% populated yet still
        // be useless if its value freezes at a constant for a long run.
        // The classic GPS-loss pattern is "encoder keeps emitting but
        // pads with the last valid lat/lon" — coverage stays FULL, the
        // track marker visibly stops moving, and Sitrec interpolates
        // nothing because consecutive records carry the same value.
        // We scan the platform-position triple (13/14/15) and frame-
        // center triple (23/24/25) for runs where ALL three components
        // hold within a tight epsilon for many consecutive records.
        const stuckGroups = [
            ["Platform position", [13, 14, 15], [1e-7, 1e-7, 0.5]],   // ~1 cm lat/lon, 50 cm alt
            ["Frame center",      [23, 24, 25], [1e-7, 1e-7, 0.5]],
        ];

        const stuckRuns = [];
        // A run is "interesting" if it lasts at least 1 second OR
        // 1% of the stream (whichever is larger). Below that we'd be
        // surfacing every momentary stationary hover.
        const minRunRecords = Math.max(30, Math.floor(N * 0.01));

        for (const [groupLabel, tags, eps] of stuckGroups) {
            let runStart = -1;
            let runLen = 0;
            const finalize = (endIdx) => {
                if (runStart >= 0 && runLen >= minRunRecords) {
                    const refRow = this.misb[runStart];
                    const v = tags.map(t => refRow ? refRow[t] : null);
                    stuckRuns.push({
                        groupLabel,
                        tags,
                        startIdx: runStart,
                        endIdx,
                        len: runLen,
                        tStart: timeOfIdx(runStart),
                        tEnd: timeOfIdx(endIdx),
                        values: v,
                    });
                }
                runStart = -1;
                runLen = 0;
            };
            for (let i = firstValid + 1; i <= lastValid; i++) {
                const cur = this.misb[i];
                const prev = this.misb[i - 1];
                if (!cur || !prev) { finalize(i - 1); continue; }
                let stuck = true;
                for (let k = 0; k < tags.length; k++) {
                    const a = prev[tags[k]];
                    const b = cur[tags[k]];
                    if (a == null || b == null) { stuck = false; break; }
                    if (Math.abs(Number(b) - Number(a)) > eps[k]) { stuck = false; break; }
                }
                if (stuck) {
                    if (runStart < 0) {
                        runStart = i - 1;
                        runLen = 2;
                    } else {
                        runLen++;
                    }
                } else {
                    finalize(i - 1);
                }
            }
            finalize(lastValid);
        }

        if (stuckRuns.length > 0) {
            lines.push("");
            lines.push("  Stuck-value runs (coverage is FULL but the value is frozen):");
            for (const r of stuckRuns) {
                const dur = r.tEnd - r.tStart;
                lines.push(`  • ${r.groupLabel}: frozen for ${r.len} records (${dur.toFixed(1)}s) starting at record ${r.startIdx} (t=${r.tStart.toFixed(1)}s).`);
                lines.push(`      Frozen until record ${r.endIdx} (t=${r.tEnd.toFixed(1)}s).`);
            }
            lines.push("");
            lines.push("  Frozen runs typically mean the encoder lost its GPS / nav source");
            lines.push("  and is padding records with the last-known value to keep the");
            lines.push("  KLV stream's structural cadence intact. The track will visibly");
            lines.push("  stop moving even though records keep arriving and the angle");
            lines.push("  tags (which come from a different sensor — usually the IMU)");
            lines.push("  continue updating normally.");
        } else {
            // Only mention the absence if we actually had populated data
            // to look at — silent pass otherwise.
            const anyChecked = stuckGroups.some(([_, tags]) =>
                this.misb[firstValid] && tags.every(t => this.misb[firstValid][t] != null));
            if (anyChecked) {
                lines.push("");
                lines.push("  ✓ No stuck-value runs detected in platform position or frame center.");
            }
        }

        // ── Stationary-period detection (motion-based, not value-based) ─
        // Looser cousin of the bit-frozen detector above. Catches the
        // case where the platform value isn't bit-identical between
        // records (e.g. GPS-noise dithering, last-fix-with-low-bit
        // jitter, encoder applying a microscopic velocity model to a
        // dead source) but the platform clearly isn't moving — total
        // displacement over many seconds stays inside a tight envelope.
        //
        // A real flying platform that's holding a tight orbit will move
        // tens to hundreds of meters per second; a platform that's
        // genuinely stopped reads inside the GPS noise floor (~5–15 m
        // horizontal, larger vertical). 25 m radius over a 5-second
        // window distinguishes the two cleanly while leaving GPS
        // jitter alone.
        const haversineM = (lat1, lon1, lat2, lon2) => {
            const R = 6371000;
            const toRad = Math.PI / 180;
            const dLat = (lat2 - lat1) * toRad;
            const dLon = (lon2 - lon1) * toRad;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(a));
        };

        const stationaryThresholdM = 25;
        const minStationarySeconds = 5;

        // Walk forward; for each starting record where the platform
        // position is populated, find the longest run from that point
        // where every subsequent record's position is within
        // stationaryThresholdM of the run's anchor. Then jump past it.
        const stationaryRuns = [];
        {
            let i = firstValid;
            while (i <= lastValid) {
                const anchor = this.misb[i];
                if (!anchor || anchor[13] == null || anchor[14] == null) { i++; continue; }
                const aLat = Number(anchor[13]);
                const aLon = Number(anchor[14]);
                let j = i + 1;
                let maxDist = 0;
                while (j <= lastValid) {
                    const r = this.misb[j];
                    if (!r || r[13] == null || r[14] == null) break;
                    const d = haversineM(aLat, aLon, Number(r[13]), Number(r[14]));
                    if (d > stationaryThresholdM) break;
                    if (d > maxDist) maxDist = d;
                    j++;
                }
                const tStart = timeOfIdx(i);
                const tEnd = timeOfIdx(j - 1);
                const dur = tEnd - tStart;
                if (dur >= minStationarySeconds && (j - i) >= 30) {
                    stationaryRuns.push({
                        startIdx: i,
                        endIdx: j - 1,
                        len: j - i,
                        tStart, tEnd, dur,
                        anchorLat: aLat,
                        anchorLon: aLon,
                        maxDist,
                    });
                    // Jump forward past this run so a 30-min stationary
                    // hold doesn't generate hundreds of overlapping
                    // sub-runs as the anchor advances by 1.
                    i = j;
                } else {
                    i++;
                }
            }
        }

        if (stationaryRuns.length > 0) {
            lines.push("");
            lines.push("  Stationary periods (platform stays within 25 m over multi-second window):");
            for (const r of stationaryRuns) {
                lines.push(`  • Stopped for ${r.dur.toFixed(1)}s (${r.len} records) starting at record ${r.startIdx} (t=${r.tStart.toFixed(1)}s).`);
                lines.push(`      Max wander in window: ${r.maxDist.toFixed(1)} m. Resumes / ends at record ${r.endIdx} (t=${r.tEnd.toFixed(1)}s).`);
            }
            lines.push("");
            lines.push("  A flying platform that goes stationary for several seconds is");
            lines.push("  unusual unless landed or in a tight hover. Combined with full");
            lines.push("  tag coverage and no bit-frozen run, this typically means the");
            lines.push("  encoder is applying micro-jitter to a dead GPS feed — the");
            lines.push("  values change every record but the platform isn't actually");
            lines.push("  moving in the world. The reported position usually fixates");
            lines.push("  near the platform's last known fix or a configured home base.");
        }

        // ── Position-spread health check (no coordinates emitted) ──────
        // Reports the *extent* of platform motion across the stream as a
        // bounding-box span in metres, and flags two failure modes:
        //   1. extent > 5° (~550 km) → likely sign/offset/decode bug
        //      or a stream that splices multiple flights
        //   2. extent ~0 with all positions near the equator → tags
        //      being decoded with the wrong scaling factor or the
        //      source is filling lat/lon with zero/null
        // We deliberately do NOT print actual coordinates: this report
        // gets pasted into bug threads and the file's location is
        // identifying information that shouldn't be in shared logs.
        // Spread alone is enough to spot decode bugs.
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;
        let minAlt = Infinity, maxAlt = -Infinity;
        let popCount = 0;
        for (let i = firstValid; i <= lastValid; i++) {
            const row = this.misb[i];
            if (!row) continue;
            const lat = Number(row[13]);
            const lon = Number(row[14]);
            const alt = Number(row[15]);
            if (isFinite(lat) && isFinite(lon)) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
                if (isFinite(alt)) {
                    if (alt < minAlt) minAlt = alt;
                    if (alt > maxAlt) maxAlt = alt;
                }
                popCount++;
            }
        }
        if (popCount > 0) {
            lines.push("");
            const latSpan = maxLat - minLat;
            const lonSpan = maxLon - minLon;
            const altSpan = (isFinite(minAlt) && isFinite(maxAlt)) ? (maxAlt - minAlt) : null;
            const midLat = (minLat + maxLat) / 2;
            const latM = latSpan * 111000;
            const lonM = lonSpan * 111000 * Math.cos(midLat * Math.PI / 180);
            lines.push(`  Platform position spread (over ${popCount} records):`);
            lines.push(`    latitude  span: ≈ ${latM.toFixed(0)} m`);
            lines.push(`    longitude span: ≈ ${lonM.toFixed(0)} m`);
            if (altSpan !== null) {
                lines.push(`    altitude  span: ${altSpan.toFixed(1)} m`);
            }
            if (latSpan > 5 || lonSpan > 5) {
                lines.push("    ⚠ Spread > 5° — suspect a sign/offset bug in one of");
                lines.push("      the lat or lon values, or a stream that splices multiple");
                lines.push("      flights together.");
            }
            if (Math.abs(minLat) < 0.01 && Math.abs(maxLat) < 0.01 && Math.abs(minLon) < 0.01 && Math.abs(maxLon) < 0.01) {
                lines.push("    ⚠ All positions cluster near (0,0) — the platform is");
                lines.push("      either being parsed with the wrong scaling factor or");
                lines.push("      the source is filling the tags with zero/null.");
            }
        }

        return lines;
    }

    _analyzeGapCorrelations(gaps) {
        const lines = [];
        if (!gaps || gaps.length === 0) {
            lines.push("  No gaps to analyze.");
            return lines;
        }

        // Build index → field-name lookup from the MISB constants.
        const indexToName = {};
        for (const k in MISB) indexToName[MISB[k]] = k;

        // Fields that are *expected* to change between every consecutive
        // record by construction, and so carry no signal about gap events:
        // - Checksum: structural, recomputed per record
        // - UnixTimeStamp: by definition increments every record
        // - PlatformHeadingAngle / PitchAngle / RollAngle and their (Full)
        //   variants at sub-degree noise levels — these fluctuate at every
        //   record from the IMU. They could be informative when they make
        //   *large* moves, so we don't drop them entirely; we raise their
        //   change threshold instead (handled in `transition`).
        const noiseFields = new Set(["Checksum", "UnixTimeStamp"]);
        const continuousNoiseFields = new Set([
            "PlatformHeadingAngle", "PlatformPitchAngle", "PlatformRollAngle",
            "PlatformPitchAngleFull", "PlatformRollAngleFull",
            "SensorRelativeAzimuthAngle", "SensorRelativeElevationAngle", "SensorRelativeRollAngle",
            "SensorLatitude", "SensorLongitude", "SensorTrueAltitude",
            "FrameCenterLatitude", "FrameCenterLongitude", "FrameCenterElevation",
        ]);

        // Fields known to be associated with active sensor / laser / target
        // operations — flagged with extra severity in the output. Any field
        // whose name contains one of these substrings is treated as
        // "interesting" regardless of how many gaps it correlates with.
        const interestingPatterns = [
            "Laser", "Slant", "Target", "Range", "Weapon",
            "OperationalMode", "ImageSourceSensor", "SensorFieldOfViewName",
            "FrameCenter",  // re-aims when laser-ranging changes target
            "UASLDSStatus",
        ];
        const isInteresting = (name) => interestingPatterns.some(p => name.toLowerCase().includes(p.toLowerCase()));

        // Detect a "transition" between two records' values for a field.
        // Returns a description string or null if no transition.
        const transition = (before, after) => {
            const bDefined = before !== null && before !== undefined && before !== "";
            const aDefined = after !== null && after !== undefined && after !== "";
            if (!bDefined && !aDefined) return null;
            if (!bDefined && aDefined) return `(none) → ${formatVal(after)}`;
            if (bDefined && !aDefined) return `${formatVal(before)} → (none)`;
            // Both defined — only flag if numerically different by > 5 % or
            // for non-numeric values, only flag actual string changes.
            const bn = Number(before), an = Number(after);
            if (isFinite(bn) && isFinite(an)) {
                if (bn === an) return null;
                const denom = Math.max(Math.abs(bn), Math.abs(an), 1e-6);
                if (Math.abs(an - bn) / denom < 0.05) return null;
                return `${formatVal(before)} → ${formatVal(after)}`;
            }
            if (String(before) === String(after)) return null;
            return `${formatVal(before)} → ${formatVal(after)}`;
        };

        function formatVal(v) {
            if (v === null || v === undefined) return "(none)";
            if (typeof v === "object") return "(complex)";
            const n = Number(v);
            if (isFinite(n)) {
                if (Math.abs(n) >= 1000 || Math.abs(n) < 0.01 && n !== 0) return n.toExponential(3);
                return n.toFixed(Math.abs(n) >= 100 ? 1 : 3);
            }
            const s = String(v);
            return s.length > 24 ? s.slice(0, 21) + "..." : s;
        }

        // Tally transitions per field across all gaps.
        const fieldHits = new Map();   // index → { name, count, examples: [] }

        // Per-gap detail accumulator.
        const perGap = [];

        for (const gap of gaps) {
            const before = this.misb[gap.idx - 1];
            const after = this.misb[gap.idx];
            if (!before || !after) continue;

            const transitions = [];
            for (let f = 0; f < before.length && f < after.length; f++) {
                const name = indexToName[f] || `Tag ${f}`;
                // Skip fields that change every record by construction.
                if (noiseFields.has(name)) continue;

                // Try the decoded-transition path first — for bitfields
                // and enums (GenericFlagData, SensorFieldofViewName,
                // OperationalMode, …) this surfaces the human-readable
                // bit/value names instead of opaque integers.
                let desc;
                if (MISBValueDecoders[f]) {
                    desc = decodeMISBTransition(f, before[f], after[f]);
                    if (!desc) continue;  // decoded but no actual change
                } else if (continuousNoiseFields.has(name)) {
                    // For fields that fluctuate continuously from sensor/IMU
                    // noise, only count *large* movements (10° for angles,
                    // 0.001° for lat/lon, 50 m for altitude). The default
                    // 5 % threshold is too generous when the absolute value
                    // is small or when the field is a heading near zero.
                    const bn = Number(before[f]), an = Number(after[f]);
                    if (!isFinite(bn) || !isFinite(an)) continue;
                    const delta = Math.abs(an - bn);
                    const threshold = name.endsWith("Latitude") || name.endsWith("Longitude")
                        ? 0.001
                        : name.endsWith("Altitude") || name.endsWith("Elevation")
                            ? 50
                            : 10;  // angle fields, in degrees
                    if (delta < threshold) continue;
                    desc = `${formatVal(before[f])} → ${formatVal(after[f])}`;
                } else {
                    desc = transition(before[f], after[f]);
                    if (!desc) continue;
                }
                transitions.push({ idx: f, name, desc });
                let entry = fieldHits.get(f);
                if (!entry) { entry = { name, count: 0, examples: [] }; fieldHits.set(f, entry); }
                entry.count++;
                if (entry.examples.length < 3) entry.examples.push({ gapTime: gap.t, desc });
            }
            perGap.push({ gap, transitions });
        }

        if (fieldHits.size === 0) {
            lines.push("  No field transitions detected at gap boundaries.");
            return lines;
        }

        // Sort by frequency, surface the most-correlated fields first.
        const sorted = [...fieldHits.values()].sort((a, b) => b.count - a.count);
        const total = gaps.length;

        lines.push(`  Examined ${total} gap${total !== 1 ? "s" : ""}; counted field transitions at each gap boundary.`);
        lines.push("");
        lines.push(`  ${"Field".padEnd(36)}${"Hits".padStart(10)}${"%".padStart(8)}${"  Note"}`);
        lines.push(`  ${"─".repeat(36)}${"─".repeat(10)}${"─".repeat(8)}  ${"─".repeat(8)}`);
        for (const f of sorted.slice(0, 25)) {
            const pct = (f.count / total) * 100;
            const sev = f.count === total ? "ALL"
                       : f.count >= total * 0.8 ? "HIGH"
                       : f.count >= total * 0.5 ? "MED"
                       : "LOW";
            const star = isInteresting(f.name) ? "★" : " ";
            lines.push(`  ${star} ${f.name.padEnd(34)}${String(f.count).padStart(10)}${pct.toFixed(0).padStart(7)}%  ${sev}`);
        }
        if (sorted.length > 25) lines.push(`  … and ${sorted.length - 25} more fields with at least one transition`);
        lines.push("");
        lines.push("  ★ = field associated with active sensor / laser / target operations");
        lines.push("");

        // Concrete examples — for the most-correlated interesting fields,
        // show what value transitioned at each gap. This is the "what was
        // the camera actually doing when the telemetry hiccupped" view.
        const interesting = sorted.filter(f => isInteresting(f.name) && f.count > 0).slice(0, 6);
        if (interesting.length > 0) {
            lines.push("  Top correlated sensor/laser fields — sample transitions:");
            lines.push("");
            for (const f of interesting) {
                lines.push(`    ${f.name}  (${f.count}/${total} gaps):`);
                for (const ex of f.examples) {
                    lines.push(`      @ klv-time ${ex.gapTime.toFixed(2)} s:  ${ex.desc}`);
                }
                lines.push("");
            }
        }

        // Per-gap summary — for each gap, list the top transitions, with
        // interesting fields highlighted. Helps the analyst see whether the
        // pattern repeats with the same field combinations or varies.
        if (perGap.length <= 25) {
            lines.push("  Per-gap detail (transitions at each boundary):");
            lines.push("");
            for (const g of perGap) {
                const interestingHere = g.transitions.filter(t => isInteresting(t.name));
                const otherHere = g.transitions.filter(t => !isInteresting(t.name));
                lines.push(`    Gap @ record ${g.gap.idx} (klv-time ${g.gap.t.toFixed(2)} s, ${g.gap.dt.toFixed(0)} ms):`);
                if (g.transitions.length === 0) {
                    lines.push("      (no field transitions detected)");
                } else {
                    for (const t of interestingHere.slice(0, 6)) {
                        lines.push(`      ★ ${t.name}: ${t.desc}`);
                    }
                    for (const t of otherHere.slice(0, 6 - Math.min(interestingHere.length, 6))) {
                        lines.push(`        ${t.name}: ${t.desc}`);
                    }
                    const shown = Math.min(interestingHere.length, 6) + Math.max(0, 6 - interestingHere.length);
                    if (g.transitions.length > shown) {
                        lines.push(`      … and ${g.transitions.length - shown} more`);
                    }
                }
                lines.push("");
            }
        } else {
            lines.push(`  ${perGap.length} gaps total — per-gap detail suppressed (>25). Most-correlated fields shown above.`);
        }

        // Interpretation hint based on what we found.
        const topInteresting = interesting[0];
        if (topInteresting && topInteresting.count >= total * 0.5) {
            lines.push(`  Interpretation: ${topInteresting.name} transitions at ${topInteresting.count}/${total} gaps.`);
            lines.push("    This is consistent with the user's report that gaps coincide with");
            lines.push("    active laser/rangefinder/sensor operations. The KLV emitter likely");
            lines.push("    pauses or stalls when these sensors engage — investigate the source");
            lines.push("    file's recording mode or the device's documented behavior.");
        }

        return lines;
    }

    // Compute great-circle distance between consecutive valid KLV records
    // and divide by reported time delta. Returns text lines for the report.
    // Catches "stamp jumps without position jumps" (timestamp wrong) and
    // "position jumps without stamp jumps" (lat/lon glitch) — both signal
    // data integrity issues.
    _analyzeGpsVelocity(firstValid, lastValid, klvMeanIntervalMs) {
        const lines = [];
        const samples = [];

        const R = 6371000;  // Earth radius (m)
        const toRad = (d) => d * Math.PI / 180;
        const haversine = (lat1, lon1, lat2, lon2) => {
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
        };

        let lastIdx = -1, lastLat = null, lastLon = null, lastAlt = null, lastT = null;
        let posValid = 0;
        for (let i = firstValid; i <= lastValid; i++) {
            if (!this.isValid(i)) continue;
            const lat = this.getLat(i);
            const lon = this.getLon(i);
            if (lat === undefined || lon === undefined) continue;
            const latN = Number(lat), lonN = Number(lon);
            if (!isFinite(latN) || !isFinite(lonN) || (latN === 0 && lonN === 0)) continue;
            posValid++;
            const altRaw = this.getAltMSL ? this.getAltMSL(i) : null;
            const altN = altRaw !== null && altRaw !== undefined ? Number(altRaw) : null;
            const t = this.getTime(i);
            if (lastT !== null) {
                const dt = (t - lastT) / 1000;
                if (dt > 0 && dt < 10) {  // skip across big gaps; not meaningful
                    const horizM = haversine(lastLat, lastLon, latN, lonN);
                    const vertM = (altN !== null && lastAlt !== null) ? Math.abs(altN - lastAlt) : 0;
                    const distM = Math.hypot(horizM, vertM);
                    samples.push({ i, dt, distM, vMps: distM / dt });
                }
            }
            lastIdx = i; lastLat = latN; lastLon = lonN; lastAlt = altN; lastT = t;
        }

        if (posValid < 10) {
            lines.push("  No usable Sensor lat/lon data — skipped.");
            return lines;
        }
        if (samples.length === 0) {
            lines.push(`  ${posValid} valid positions but no usable inter-record samples.`);
            return lines;
        }

        const vels = samples.map(s => s.vMps);
        const meanV = vels.reduce((a, b) => a + b, 0) / vels.length;
        const sortedV = [...vels].sort((a, b) => a - b);
        const median = sortedV[Math.floor(sortedV.length / 2)];
        const p95 = sortedV[Math.floor(sortedV.length * 0.95)];
        const maxV = sortedV[sortedV.length - 1];
        const sqV = vels.reduce((a, x) => a + (x - meanV) * (x - meanV), 0);
        const stddevV = Math.sqrt(sqV / vels.length);

        lines.push(`  Samples analyzed:   ${samples.length} inter-record steps`);
        lines.push(`  Median velocity:    ${median.toFixed(2)} m/s  (${(median * 3.6).toFixed(1)} km/h, ${(median * 1.944).toFixed(1)} kn)`);
        lines.push(`  Mean velocity:      ${meanV.toFixed(2)} m/s`);
        lines.push(`  Stddev:             ${stddevV.toFixed(2)} m/s`);
        lines.push(`  95th percentile:    ${p95.toFixed(2)} m/s`);
        lines.push(`  Max velocity:       ${maxV.toFixed(2)} m/s`);
        lines.push("");

        // Detect the "slow GPS source padded to fast KLV cadence"
        // pattern. Signature: a high fraction of inter-record steps
        // have ~0 displacement (held value) interleaved with periodic
        // "jump" steps where the encoder ingested a fresh fix. This
        // produces alarming-looking per-record velocities (each jump
        // covers the full inter-update distance in one KLV interval)
        // even though the platform's *true* velocity is moderate.
        // Without this section, the suspicious-velocity table flags
        // hundreds of normal-aircraft samples as "teleports".
        const zeroDistSamples = samples.filter(s => s.distM < 0.5);  // <0.5 m = quantization noise
        const zeroDistFrac = zeroDistSamples.length / samples.length;
        if (zeroDistFrac > 0.4) {
            // Estimate the real GPS update period: groups of held
            // records separated by jumps. Walk through samples and
            // measure intervals between non-zero-displacement steps.
            const jumpIntervals = [];
            let lastJumpI = null;
            for (const s of samples) {
                if (s.distM >= 0.5) {
                    if (lastJumpI !== null) jumpIntervals.push(s.i - lastJumpI);
                    lastJumpI = s.i;
                }
            }
            if (jumpIntervals.length >= 5) {
                const sortedJ = [...jumpIntervals].sort((a, b) => a - b);
                const medJump = sortedJ[Math.floor(sortedJ.length / 2)];
                const jumpDists = samples.filter(s => s.distM >= 0.5).map(s => s.distM);
                const sortedD = [...jumpDists].sort((a, b) => a - b);
                const medJumpDist = sortedD[Math.floor(sortedD.length / 2)];
                // Real GPS rate = KLV rate / records-per-jump
                const klvHz = klvMeanIntervalMs > 0 ? 1000 / klvMeanIntervalMs : null;
                const gpsHz = klvHz ? klvHz / medJump : null;
                const realVel = (medJumpDist / medJump) / (klvMeanIntervalMs / 1000);
                lines.push(`  ▣ Slow-GPS-padded-to-fast-KLV pattern detected:`);
                lines.push(`      ${(zeroDistFrac * 100).toFixed(1)}% of inter-record steps have ~0 m displacement.`);
                lines.push(`      Median jump every ${medJump} records → ~${gpsHz ? gpsHz.toFixed(1) : "?"} Hz GPS source padded to ~${klvHz ? klvHz.toFixed(1) : "?"} Hz KLV cadence.`);
                lines.push(`      Median jump distance: ${medJumpDist.toFixed(1)} m → real platform velocity ≈ ${realVel.toFixed(1)} m/s.`);
                lines.push(`      The per-record velocities below are inflated by ${medJump}×; the underlying motion is normal.`);
                lines.push("");
            }
        }

        // Flag samples that are >5× median AND > 500 m/s in absolute terms.
        // 500 m/s ≈ Mach 1.5 — well above any normal flying platform
        // (commercial aircraft cruise ~250 m/s, fighters in afterburner
        // ~600 m/s). The earlier 50 m/s threshold was too aggressive:
        // it flagged routine aircraft motion as suspicious. Real bad-
        // timestamp / teleport glitches are typically hundreds to
        // thousands of m/s and stand out clearly above 500.
        const threshold = Math.max(median * 5, 500);
        const suspicious = samples.filter(s => s.vMps > threshold);
        if (suspicious.length === 0) {
            lines.push("  ✓ No suspicious velocity spikes (no records with v > 5× median AND > 500 m/s).");
        } else {
            lines.push(`  ⚠ ${suspicious.length} suspicious velocity samples (v > ${threshold.toFixed(0)} m/s):`);
            lines.push("");
            lines.push("    record   dt (s)    dist (m)    velocity (m/s)");
            lines.push("    ──────   ──────    ────────    ──────────────");
            for (const s of suspicious.slice(0, 20)) {
                lines.push(`    ${String(s.i).padStart(6)}   ${s.dt.toFixed(3).padStart(6)}    ${s.distM.toFixed(1).padStart(8)}    ${s.vMps.toFixed(1).padStart(14)}`);
            }
            if (suspicious.length > 20) lines.push(`    … and ${suspicious.length - 20} more`);
            lines.push("");
            lines.push("  These usually indicate a bad timestamp (dt too small for the");
            lines.push("  distance covered) or a position glitch. Cross-reference these");
            lines.push("  records with the gap list above to see if they coincide.");
        }
        return lines;
    }

    // Add GUI text field for overriding the start time of relative-time tracks.
    // Uses onFinishChange to avoid parsing partial input while user is typing.
    // Supports partial datetime input (e.g., "10:30", "January 15") via chrono-node.
    setupTrackStartTimeGUI(guiFolder) {
        if (!this.isRelativeTime) return;

        this.trackStartTimeController = guiFolder.add(this, "trackStartTime").name(t("misbData.startTime.label")).listen()
            .onFinishChange(() => this.handleTrackStartTimeChange())
            .tooltip(t("misbData.startTime.tooltip"));

        this.addSimpleSerial("trackStartTime");
    }

    // Add GUI controls for the g-force filter
    setupFilterGUI(guiFolder) {
        const folder = guiFolder.addFolder("Filter Bad Data").close();
        folder.add(this, "filterEnabled").name(t("misbData.enableFilter.label")).listen().onChange(() => {
            this.runGForceFilter();
            this.recalculateCascade();
        });
        folder.add(this, "tryAltitudeFirst").name(t("misbData.tryAltitudeFirst.label")).listen().onChange(() => {
            this.runGForceFilter();
            this.recalculateCascade();
        });
        folder.add(this, "filterMaxG", 0.1, 10, 0.1).name(t("misbData.maxG.label")).listen().onChange(() => {
            this.runGForceFilter();
            this.recalculateCascade();
        });

        this.addSimpleSerial("filterEnabled");
        this.addSimpleSerial("tryAltitudeFirst");
        this.addSimpleSerial("filterMaxG");
    }

    // Compute acceleration at slot b given neighbors a and c.
    // Returns acceleration in m/s², or -1 if it can't be computed.
    _computeAccelAtSlot(a, b, c) {
        const posA = this.getPosition(a);
        const posB = this.getPosition(b);
        const posC = this.getPosition(c);

        const timeA = this.getTime(a);
        const timeBMs = this.getTime(b);
        const timeC = this.getTime(c);

        const dtAB = (timeBMs - timeA) / 1000;
        const dtBC = (timeC - timeBMs) / 1000;
        if (dtAB <= 0 || dtBC <= 0) return -1;

        const velAB = posB.clone().sub(posA).divideScalar(dtAB);
        const velBC = posC.clone().sub(posB).divideScalar(dtBC);

        const dtAC = (timeC - timeA) / 2000;
        return velBC.clone().sub(velAB).length() / dtAC;
    }

    // Multi-pass g-force filter: marks slots where acceleration exceeds filterMaxG * 9.81 m/s²
    // Uses wide-baseline velocity estimates (minDt = 0.5s) to avoid false positives from
    // timestamp quantization noise in high-frame-rate data.
    // When tryAltitudeFirst is enabled, bad points first get their altitude replaced with
    // an interpolated value from neighbors. Only if that doesn't fix it is the point removed.
    runGForceFilter() {
        this.filteredSlots.clear();
        this.altitudeFixedSlots.clear();
        if (!this.filterEnabled) return;

        const maxAccel = this.filterMaxG * 9.81;
        const minDt = 0.5; // minimum time span for velocity estimates (seconds)
        let changed = true;

        while (changed) {
            changed = false;

            const validSlots = [];
            for (let i = 0; i < this.misb.length; i++) {
                if (!this.filteredSlots.has(i) && this._isValidBasic(i)) {
                    validSlots.push(i);
                }
            }

            for (let idx = 1; idx < validSlots.length - 1; idx++) {
                const b = validSlots[idx];

                // Find wide-baseline neighbors before and after B
                let aBefore = idx - 1;
                const timeBMs = this.getTime(b);
                while (aBefore >= 0 && (timeBMs - this.getTime(validSlots[aBefore])) / 1000 < minDt) aBefore--;
                if (aBefore < 0) aBefore = 0;

                let cAfter = idx + 1;
                while (cAfter < validSlots.length && (this.getTime(validSlots[cAfter]) - timeBMs) / 1000 < minDt) cAfter++;
                if (cAfter >= validSlots.length) cAfter = validSlots.length - 1;

                const a = validSlots[aBefore];
                const c = validSlots[cAfter];
                if (a === b || c === b) continue;

                const accel = this._computeAccelAtSlot(a, b, c);
                if (accel < 0) continue;

                if (accel > maxAccel) {
                    // Try altitude fix first if enabled
                    if (this.tryAltitudeFirst && !this.altitudeFixedSlots.has(b)) {
                        const timeA = this.getTime(a);
                        const timeC = this.getTime(c);
                        const t = (timeBMs - timeA) / (timeC - timeA);
                        const altA = this.getAltMSL(a);
                        const altC = this.getAltMSL(c);
                        const interpolatedAlt = altA + (altC - altA) * t;

                        // Temporarily apply the fix and recheck
                        this.altitudeFixedSlots.set(b, interpolatedAlt);
                        const newAccel = this._computeAccelAtSlot(a, b, c);

                        if (newAccel >= 0 && newAccel <= maxAccel) {
                            // Altitude fix worked — keep the point with corrected altitude
                            changed = true;
                            continue;
                        }
                        // Altitude fix didn't help — remove the fix and filter the point
                        this.altitudeFixedSlots.delete(b);
                    }

                    this.filteredSlots.add(b);
                    changed = true;
                }
            }
        }

        if (this.altitudeFixedSlots.size > 0) {
            console.log(`Altitude-fixed ${this.altitudeFixedSlots.size} points in track ${this.id}`);
        }
        if (this.filteredSlots.size > 0) {
            console.log(`Filtered ${this.filteredSlots.size} points from track ${this.id} (max ${this.filterMaxG}g)`);
        }
    }

    // Scan the track and return the peak g-force value (without modifying filteredSlots)
    // Uses the same wide-baseline approach as runGForceFilter.
    getMaxGForce() {
        const validSlots = [];
        for (let i = 0; i < this.misb.length; i++) {
            if (this._isValidBasic(i)) {
                validSlots.push(i);
            }
        }

        const minDt = 0.5;
        let maxG = 0;
        for (let idx = 1; idx < validSlots.length - 1; idx++) {
            const b = validSlots[idx];
            const timeBMs = this.getTime(b);

            let aBefore = idx - 1;
            while (aBefore >= 0 && (timeBMs - this.getTime(validSlots[aBefore])) / 1000 < minDt) aBefore--;
            if (aBefore < 0) aBefore = 0;

            let cAfter = idx + 1;
            while (cAfter < validSlots.length && (this.getTime(validSlots[cAfter]) - timeBMs) / 1000 < minDt) cAfter++;
            if (cAfter >= validSlots.length) cAfter = validSlots.length - 1;

            const a = validSlots[aBefore];
            const c = validSlots[cAfter];
            if (a === b || c === b) continue;

            const posA = this.getPosition(a);
            const posB = this.getPosition(b);
            const posC = this.getPosition(c);

            const timeA = this.getTime(a);
            const timeC = this.getTime(c);

            const dtAB = (timeBMs - timeA) / 1000;
            const dtBC = (timeC - timeBMs) / 1000;
            if (dtAB <= 0 || dtBC <= 0) continue;

            const velAB = posB.clone().sub(posA).divideScalar(dtAB);
            const velBC = posC.clone().sub(posB).divideScalar(dtBC);
            const dtAC = (timeC - timeA) / 2000;
            const accel = velBC.clone().sub(velAB).length() / dtAC;
            const g = accel / 9.81;
            if (g > maxG) maxG = g;
        }
        return maxG;
    }

    // Basic validity check without the g-force filter (used by runGForceFilter to avoid circular dependency)
    _isValidBasic(slotNumber) {
        let lat = this.getLat(slotNumber)
        let lon = this.getLon(slotNumber)
        let alt = this.getAltMSL(slotNumber)
        let time = this.getTime(slotNumber)

        if (isNaN(time) || time < 0 || time > 4102444800000) return false
        if (isNaN(lat) || isNaN(lon) || isNaN(alt)) return false
        if (lat < -90 || lat > 90) return false
        if (lon < -360 || lon > 360) return false
        if (alt < -1000) return false
        if (alt > 36000000) return false

        if (lat === 0) {
            if (this.lastValidSlot === undefined || Math.abs(this.getLat(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }
        if (lon === 0) {
            if (this.lastValidSlot === undefined || Math.abs(this.getLon(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }

        return true;
    }

    // Parse trackStartTime using chrono-node with parsingBaseTime as reference.
    // Updates trackStartTime to the normalized ISO string if parsing succeeds.
    async handleTrackStartTimeChange() {
        if (!this.trackStartTime || this.trackStartTime.trim() === "") {
            this.recalculateCascade();
            return;
        }
        
        const referenceDate = new Date(this.parsingBaseTime);
        const parsed = await parsePartialDateTime(this.trackStartTime, referenceDate);
        
        if (parsed) {
            const isoString = parsed.toISOString();
            // Skip if already normalized to avoid setValue() triggering onFinishChange loop
            if (this.trackStartTime !== isoString) {
                // Use setValue() to update both value and display
                this.trackStartTimeController?.setValue(isoString);
            }
            this.recalculateCascade();
        }
    }

    // Per-record PES PTS in milliseconds (relative to first PES boundary
    // in the original TS), if available. Populated only when the KLV
    // substream came through Sitrec's TS demuxer with PES headers intact —
    // see parseKLVFile() and TSParser. Returns null when no PES timing was
    // captured (e.g. KLV loaded from a standalone .klv file). Callers
    // should treat null as "fall back to UnixTimeStamp lookup."
    getRecordPTSms(i) {
        const arr = this.misb && this.misb.pesPTSus;
        if (!arr || i < 0 || i >= arr.length) return null;
        const us = arr[i];
        return typeof us === "number" ? us / 1000 : null;
    }

    // True when this node has per-record PES PTS data (i.e. came through
    // the TS demuxer with synchronous-mode metadata). Used by track nodes
    // to decide whether to use the more accurate PES-PTS-based lookup.
    hasRecordPTS() {
        return Array.isArray(this.misb && this.misb.pesPTSus)
            && this.misb.pesPTSus.length === this.misb.length;
    }

    // Compute time offset in seconds from trackStartTime.
    // Used by CNodeTrackFromMISB.getValue() to combine with timeOffset.
    // Returns 0 if trackStartTime is empty or invalid.
    getTrackStartTimeOffsetSeconds() {
        if (!this.trackStartTime || this.trackStartTime.trim() === "") {
            return 0;
        }
        const parsed = Date.parse(this.trackStartTime);
        if (isNaN(parsed)) {
            return 0;
        }
        // parsingBaseTime is when track timestamps were computed
        // trackStartTime is when user says track actually started
        // Return offset in seconds (negative if track starts later than parsing base)
        return (this.parsingBaseTime - parsed) / 1000;
    }

    exportMISBCSV(inspect = false) {
        let csv = ""
        // MISB is an object of name -> index pairs, so we can get the column name from the index
        // but have to search for it.
        for (let i=0;i<MISBFields;i++) {
            let name = "unknown";
            for (let key in MISB) {
                if (MISB[key] === i) {
                    name = key;
                    break;
                }
            }
            csv = csv + name + (i<MISBFields-1?",":"\n");
        }

        // Datum-safe round trip: SensorTrueAltitude / FrameCenterElevation are MSL by
        // MISB convention, so an altitudeIsHAE track (e.g. STANAG cs="WGS_84") must not
        // dump its HAE values into them — a re-import would treat them as MSL and add
        // the geoid offset again (~16 m low in CONUS). Emit them in the matching
        // ellipsoid-height column (tag 75/78) instead; the datum-aware import
        // (selectSourceColumns) picks that column up and re-flags the track as HAE.
        let mslColOut = -1, haeColOut = -1;
        if (this.altitudeIsHAE && !this.useAGL) {
            if (this.altCol === MISB.SensorTrueAltitude) {
                mslColOut = MISB.SensorTrueAltitude;
                haeColOut = MISB.SensorEllipsoidHeight;
            } else if (this.altCol === MISB.FrameCenterElevation) {
                mslColOut = MISB.FrameCenterElevation;
                haeColOut = MISB.FrameCenterHeightAboveEllipsoid;
            }
        }

        for (let f=0;f<this.misb.length;f++) {
            for (let i=0;i<MISBFields;i++) {
                let value = this.misb[f][i];
                if (i === mslColOut) {
                    value = null;                                  // don't mislabel HAE as MSL
                } else if (i === haeColOut && (value === null || value === undefined)) {
                    value = this.misb[f][mslColOut];               // HAE value in the HAE column
                }
                // if not null and an object, then replace with "COMPLEX"
                // (null is considered an object - a quirk of JS)
                if (value !== null && typeof value === "object") {
                        value = "COMPLEX"
                }

                csv = csv + value + (i<MISBFields-1?",":"\n");
            }
        }
        if (inspect) {
            return {
                desc: "MISB CSV Export",
                csv: csv,
            }
        }
        else {
            saveAs(new Blob([csv]), "MISB-DATA" + this.id + ".csv")
        }
    }

    exportTrackKML(inspect = false) {
        const trackName = Sit.name + "-" + this.id;
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Folder>
<name>${trackName}</name>
<Placemark>
<name>${trackName}</name>
<Style>
<LineStyle><color>ff0000ff</color><width>4</width></LineStyle>
<IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle>
</Style>
<gx:Track>
<altitudeMode>absolute</altitudeMode>
<extrude>1</extrude>
`;
        const whenLines = [];
        const coordLines = [];

        for (let f = 0; f < this.misb.length; f++) {
            if (!this.isValid(f)) continue;
            const timeMS = this.getTime(f);
            const dateStr = new Date(timeMS).toISOString();
            whenLines.push(`<when>${dateStr}</when>`);

            const lat = this.getLat(f);
            const lon = this.getLon(f);
            const alt = this.getAltMSL(f);
            coordLines.push(`<gx:coord>${lon} ${lat} ${alt}</gx:coord>`);
        }

        kml += whenLines.join("\n") + "\n";
        kml += coordLines.join("\n") + "\n";
        kml += `</gx:Track>
</Placemark>
</Folder>
</kml>`;

        if (inspect) {
            return {
                desc: "KML Track Export",
                kml: kml,
            };
        } else {
            saveAs(new Blob([kml], {type: "application/vnd.google-earth.kml+xml"}), trackName + ".kml");
        }
    }

    // given an array of the MISB column names for lat,lon,alt
    // then store the column indices for the lat, lon, and alt
    // this is soe we can switch between the sensor LLA, the frame center LLA, and the corners
    selectSourceColumns(columns) {
        this.latCol = MISB[columns[0]]
        this.lonCol = MISB[columns[1]]
        this.altCol = MISB[columns[2]]
        this.useAGL = false;
        // check to see if we have data in altCol
        if (this.misb[0][this.altCol] === null) {
            // The MSL column is empty. Before falling back to AGL, try the matching
            // ellipsoid-height column (MISB ST0601 tag 75 / tag 78) — GPS-native
            // producers may emit HAE only. Using it means the values are already
            // ellipsoidal, so flag altitudeIsHAE to skip the MSL->HAE geoid add.
            const HAE_EQUIVALENT = {
                SensorTrueAltitude: "SensorEllipsoidHeight",
                FrameCenterElevation: "FrameCenterHeightAboveEllipsoid",
            };
            const haeName = HAE_EQUIVALENT[columns[2]];
            const haeCol = haeName !== undefined ? MISB[haeName] : undefined;
            if (haeCol !== undefined && this.misb[0][haeCol] !== null && this.misb[0][haeCol] !== undefined) {
                this.altCol = haeCol;
                this.altitudeIsHAE = true;
            } else {
                this.useAGL = true;
                this.altCol = MISB[columns[3]]; // this is the altitude column
                assert(this.misb[0][this.altCol] !== undefined, "CNodeMISBDataTrack: AGL altitude column not found in MISB data");
            }
        }
    }



    // to display the full length track of original source data, (like, for a KML)
    // we need to make an array of ECEF positions for each point in the track
    // NOTE: this is a DATA track, not a camera/position
    // and this array is just to display the shape of the track,
    makeArrayForTrackDisplay() {
        this.array = [];
        var points = this.misb.length
        for (var f = 0; f < points; f++) {
            // we only handle rows that have valid data
            if (this.isValid(f)) {
                var pos = LLAToECEF(this.getLat(f), this.getLon(f), this.getAltHAE(f));
                this.array.push({position: pos})
            } else if (this.filteredSlots.has(f)) {
                // Filtered out by g-force filter — skip silently
                this.array.push({})
            } else {
                // otherwise, just give it an empty structure
                console.warn("CNodeMISBDataTrack: invalid data at frame " + f + " in track " + this.id + " lat=" + this.getLat(f) + " lon=" + this.getLon(f) + " alt=" + this.getAltMSL(f));
                console.warn("Returning empty object {}")
                assert(0, "CNodeMISBDataTrack: invalid data at frame " + f + " in track " + this.id);
                this.array.push({})
            }

        }
        this.frames = points;

    }

    getTrackStartTime() {
        return this.getTime(0)
    }

    getLat(i) {
        return Number(this.misb[i][this.latCol]);
    }

    getLon(i) {
        return Number(this.misb[i][this.lonCol]);
    }

    getRawAlt(i) {
        let alt = Number(this.misb[i][this.altCol])
        if (!this.useAGL) {
            // if we are not using AGL, then the altitude is the true altitude
            return alt;
        }
        // if we are using AGL, then the altitude is the AGL altitude
        // so we need to adjust it to be the true altitude
        const lat = this.getLat(i);
        const lon = this.getLon(i);
       // const position = LLAToECEF(lat, lon, alt);
        // get the base altitude at this position
        const elevation = elevationAtLL(lat, lon);
        alt += elevation;
        return alt;


    }

    // True iff the track's altitude is locked to the ground AND the lock is
    // currently active. Delegates to the shared free function so the same
    // semantics are used by other track classes that have these fields.
    isAGLLockActive() {
        return isAGLLockActive(this);
    }

    // True iff this track's positions depend on terrain elevation. Either the
    // raw altitudes are AGL (column-driven), or the AGL lock is active.
    isTerrainDependent() {
        return this.useAGL || this.isAGLLockActive();
    }

    adjustAlt(a, lat, lon) {
        if (isAltitudeLockActive(this)) {
            if (this.altitudeLockAGL && lat !== undefined && lon !== undefined) {
                return elevationAtLL(lat, lon) + this.altitudeLock;
            }
            return this.altitudeLock;
        } else if (this.altitudeOffset !== undefined) {
            return a + this.altitudeOffset
        }
        return a;
    }


    // Whether the value produced by getRawAlt() + adjustAlt() still needs the geoid
    // offset N added to become HAE. True only for plain MSL/orthometric column data.
    // False whenever that value is ALREADY ellipsoidal (adding N again would raise the
    // track ~16-30 m above its true position in CONUS):
    //   - altitudeIsHAE: the raw column is HAE (STANAG cs="WGS_84", MISB tag 75/78,
    //     Custom1 TPHAE)
    //   - useAGL: getRawAlt() adds elevationAtLL(), which returns terrain height above
    //     the ellipsoid (the geoid is baked into tile elevations at decode)
    //   - altitude lock: the AGL lock goes through elevationAtLL() (HAE), and non-AGL
    //     lock values are HAE per the AltitudeLock.js schema -- matching how
    //     CNodeSplineEdit and CNodeOSDDataSeriesTrack apply them (adjustHeightHAE)
    needsGeoidToHAE() {
        return !this.altitudeIsHAE && !this.useAGL && !isAltitudeLockActive(this);
    }

    // Returns MSL altitude (orthometric). Use for exports (KML, CSV, GeoJSON).
    getAltMSL(i) {
        // If this slot had its altitude corrected by the filter, use that
        if (this.altitudeFixedSlots && this.altitudeFixedSlots.has(i)) {
            return this.altitudeFixedSlots.get(i);
        }
        const lat = this.getLat(i);
        const lon = this.getLon(i);
        let a = this.adjustAlt(this.getRawAlt(i), lat, lon);
        if (!this.needsGeoidToHAE()) {
            // Raw altitude is already HAE (ellipsoidal); convert to true MSL (H = h - N).
            a -= meanSeaLevelOffset(lat, lon);
        }
        return a;
    }

    // Returns HAE altitude (h = H + N). Use for ECEF conversions.
    getAltHAE(i) {
        const lat = this.getLat(i);
        const lon = this.getLon(i);
        return this.getAltMSL(i) + meanSeaLevelOffset(lat, lon);
    }

    // get time at frame i in milliseconds since epoch
    // MISB data (or converted CSV data) can be in seconds, milliseconds, or microseconds
    // so we have to detect which and convert to milliseconds
    getTime(i) {
        let time = Number(this.misb[i][MISB.UnixTimeStamp])
        // check to see if it's in milliseconds or microseconds
        if (time > 31568461000000) {   // 31568461000000 is 1971 using microseconds, but 2970 using milliseconds
            time = time / 1000
        } else if (time < 31568461000) { // <1971 in milliseconds, less than 2970 in seconds, so seconds
            time = time * 1000
        }
        return time
    }

    // given a time, find the first frame that is at or after that time
    getIndexAtTime(time) {
        let points = this.misb.length
        for (let f = 0; f < points; f++) {
            if (this.getTime(f) >= time) {
                return f;
            }
        }
        return 0
    }

    // get ECEF position at frame i
    getPosition(i) {
        return LLAToECEF(this.getLat(i), this.getLon(i), this.getAltHAE(i));
    }

    // given a time in ms (UNIX time), return the position at that time
    getPositionAtTime(time) {
        return this.getPosition(this.getIndexAtTime(time));
    }


    // a slot is valid if it has a valid timestamp
    // and the lat/lon/alt are not NaN
    isValid(slotNumber) {
        if (this.filteredSlots && this.filteredSlots.has(slotNumber)) return false;
        let lat = this.getLat(slotNumber)
        let lon = this.getLon(slotNumber)
        let alt = this.getAltMSL(slotNumber)
        let time = this.getTime(slotNumber)

        // time is in unix time, check its a number and from 1970 to 2100
        if (isNaN(time) || time < 0 || time > 4102444800000) return false
        // lat, lon, alt are floats, check they are not NaN
        if (isNaN(lat) || isNaN(lon) || isNaN(alt)) return false
        // check lat is -90 to 90
        if (lat < -90 || lat > 90) return false
        // and lon is -180 to 180, but allow to 360 as some data might be 0..360, or even (unlikely) -360..0
        // basically jsut checking they are reasonable numbers
        if (lon < -360 || lon > 360) return false
        // and alt is a positive number, allowing a little leeway for the ground
        if (alt < -1000) return false
        // nothing beyond geostationary orbit
        // not expecting anything out of the atmosphere, but just in case.
        // again just checking for reasonable numbers
        if (alt > 36000000) return false

        // check for zeros, as they are likely to be invalid
        if (lat ===0 ) {
            // check if the last valid slot's lat was near zero, if so we allow this
            if (this.lastValidSlot === undefined || Math.abs(this.getLat(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }

        if (lon ===0 ) {
            // check if the last valid slot's lon was near zero, if so we allow this
            if (this.lastValidSlot === undefined || Math.abs(this.getLon(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }

        if (alt ===0 ) {
            // always allow alt === 0, as it's common for grounded planes (ADS-B)
            // maybe we might want to check if it is on the ground and use terrain elevation?
            // // check if the last valid slot's alt was near zero, if so we allow this
            // if (this.lastValidSlot === undefined || Math.abs(this.getAltMSL(this.lastValidSlot)) > 1000) {
            //     return false;
            // }
            if (!this.warnedAboutZeroAltitude)
                console.warn("Altitude is zero at slot " + slotNumber + " (and maybe others) in track " + this.id+" (allowed, likely grounded plane)");
            this.warnedAboutZeroAltitude = true;
        }



        this.lastValidSlot = slotNumber;


        return true;

    }


    recalculate() {
        this.runGForceFilter();
        this.makeArrayForTrackDisplay()
    }
}


// given a track with MISB style platform and sensor Az/El/Roll
// extract them into arrays and then use those arrays
// to create CNodeLOSTrackMISB
export function makeLOSNodeFromTrackAngles(trackID, data) {
    const cameraTrackAngles = NodeMan.get(trackID);
    const smooth = data.smooth ?? 0;

    makeArrayNodeFromMISBColumn(trackID+"platformHeading", cameraTrackAngles, data.platformHeading ?? MISB.PlatformHeadingAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"platformPitch", cameraTrackAngles, data.platformPitch ?? MISB.PlatformPitchAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"platformRoll", cameraTrackAngles, data.platformRoll ?? MISB.PlatformRollAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"sensorAz", cameraTrackAngles, data.sensorAz ?? MISB.SensorRelativeAzimuthAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"sensorEl", cameraTrackAngles, data.sensorEl ?? MISB.SensorRelativeElevationAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"sensorRoll", cameraTrackAngles, data.sensorRoll ?? MISB.SensorRelativeRollAngle, smooth, true)

    const node = new CNodeLOSTrackMISB({
        id: data.id ?? trackID+"_LOS", cameraTrack: trackID,
        platformHeading: trackID+"platformHeading", platformPitch: trackID+"platformPitch", platformRoll: trackID+"platformRoll",
        sensorAz: trackID+"sensorAz", sensorEl: trackID+"sensorEl", sensorRoll: trackID+"sensorRoll"
    })

    return node;
}

export function removeLOSNodeColumnNodes(trackID) {
    console.log("removeLOSNodeColumnNodes: trackID="+trackID);
    NodeMan.disposeRemove(trackID+"platformHeading")
    NodeMan.disposeRemove(trackID+"platformPitch")
    NodeMan.disposeRemove(trackID+"platformRoll")
    NodeMan.disposeRemove(trackID+"sensorAz")
    NodeMan.disposeRemove(trackID+"sensorEl")
    NodeMan.disposeRemove(trackID+"sensorRoll")
}

