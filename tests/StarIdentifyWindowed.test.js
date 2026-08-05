// WINDOWED star identification on a long panning clip - the regression suite for the
// time-indexed mosaic-warp failure, and for the two solver hardenings that came out of it.
//
// The fixtures are two independent captures of the SAME analysis (the 671-frame Giddierone
// pan whose 179-frame subset identifies Vega cleanly):
//
//   giddieroneLongRunB.json - a healthy run: per-track first/last observation frames.
//   giddieroneLongRunC.json - a second run of the same clip whose tracker output DEGRADED
//       (its full chart does not solve at all; only the first ~190 frames yield a solvable
//       chart). Carries real per-track observation frames AND the chart->video transforms.
//
// Between the two runs the blur-burst "walls" - frames where every track breaks at once -
// moved by ~80 frames, which is why windows are cut from each run's own track-break structure
// and never at fixed frames: a window whose bright stars straddle a wall mixes two chart-drift
// regimes and generates zero correct-field quad hypotheses (measured in the design
// investigation; windowed-identify-notes/ in the worktree holds the full record).
//
// What must hold, per run:
//   run B: every wall-aware window solves, ~100 of 123 stars labeled INCLUDING Vega, and
//          every label agrees with the independently-solved short segment.
//   run C: the degraded remainder is refused honestly - partial coverage, first window only -
//          but Vega is still named, where the single-model path delivers nothing at all.

import fs from "fs";
import path from "path";
import {
    STAR_IDENTIFY_DEFAULTS, STAR_WINDOW_DEFAULTS, buildQuadIndex, chartSpansBeyondFrame,
    detectTrackWalls, mergeWindowLabels, parseStarCatalog, planIdentifyWindows,
    quarantineWindows, solveField, solveFieldWindowed, windowVfovDegAt,
} from "../src/starTrack/StarIdentify";

const fixture = (name) => JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "fixtures", name), "utf8"));
const runB = fixture("giddieroneLongRunB.json");
const runC = fixture("giddieroneLongRunC.json");
const segments = fixture("giddieronePanSegments.json");
const catalog = parseStarCatalog((() => {
    const b = fs.readFileSync(path.resolve(__dirname, "..", "data/nightsky/sitrec_bsc_lite.bin"));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
})());

const HIP_VEGA = 91262;

// One index per tier, shared across tests - the build is seconds each and pure.
const indexes = STAR_IDENTIFY_DEFAULTS.tiers.map((t) => buildQuadIndex(catalog, t));

// Run B predates the obsF capture; its tracks carry only [first, last]. Spans are a proxy for
// observations (they overstate gappy tracks), which the integration bars below allow for.
const runBStars = runB.stars.map((s) => {
    const obsF = [];
    for (let f = s.first; f <= s.last; f++) obsF.push(f);
    return {...s, obsF};
});

/** identifyStars' single-solve bounds rule, for solving the SHORT segment as the label oracle. */
function shortOpts(seg) {
    let bx0 = 0, by0 = 0, bx1 = seg.videoW, by1 = seg.videoH;
    for (const s of seg.stars) {
        bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
        by0 = Math.min(by0, s.y); by1 = Math.max(by1, s.y);
    }
    return {
        center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
        width: Math.max(bx1 - bx0, by1 - by0),
        bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
    };
}

/**
 * Label-vs-label audit against the short segment's own solve. The runs share reference frame
 * 1235, so a long-chart star within `twinPx` of a short-chart star is the same physical track;
 * where the short solve named it, the windowed labels must agree. (Chart positions shift a
 * couple of px between ANALYSIS RUNS - run C needs the wider radius.)
 */
async function auditAgainstShort(labels, longStars, twinPx) {
    const S = await solveField(segments.short.stars, catalog, [indexes[2]],
        shortOpts(segments.short));
    expect(S.ok).toBe(true);
    let agree = 0, audited = 0;
    const disputes = [];
    for (const m of S.matches) {
        const s = segments.short.stars[m.image];
        let best = null, bestD = Infinity, second = Infinity;
        for (const l of longStars) {
            const d = Math.hypot(l.x - s.x, l.y - s.y);
            if (d < bestD) { second = bestD; bestD = d; best = l; }
            else if (d < second) second = d;
        }
        if (bestD > twinPx || second < 2 * bestD) continue;
        const got = labels.get(best.index);
        if (!got) continue;
        audited++;
        if (got.hip === m.hip) agree++;
        else disputes.push({want: m.hip, got: got.hip});
    }
    return {agree, audited, disputes};
}

describe("wall-aware window planning", () => {
    test("a chart that stays inside the frame does not trigger windowing", () => {
        // The short segment pans a little (its chart is ~14% taller than the frame) - below
        // the 25% robust-span threshold, so it keeps the single-solve path.
        expect(chartSpansBeyondFrame(segments.short.stars,
            segments.short.videoW, segments.short.videoH)).toBe(false);
        // Both long captures extend the chart nearly two frame heights - well past it.
        expect(chartSpansBeyondFrame(runBStars, runB.videoW, runB.videoH)).toBe(true);
        expect(chartSpansBeyondFrame(runC.stars, runC.videoW, runC.videoH)).toBe(true);
    });

    test("one far outlier cannot trigger the pan gate", () => {
        // A tight in-frame cluster plus a single mis-tracked star flung far below: the span
        // is measured 3rd-lowest to 3rd-highest coordinate, so it takes three supporting
        // tracks to claim a pan.
        const cluster = Array.from({length: 20}, (_, i) => ({x: 100 + i * 40, y: 300 + i * 10}));
        expect(chartSpansBeyondFrame([...cluster, {x: 500, y: 5000}], 1150, 642)).toBe(false);
        expect(chartSpansBeyondFrame(cluster, 1150, 642)).toBe(false);
        // ...and with three outliers it fires.
        expect(chartSpansBeyondFrame([...cluster,
            {x: 500, y: 5000}, {x: 520, y: 4980}, {x: 540, y: 5020}], 1150, 642)).toBe(true);
    });

    test("walls are the mass track breaks, and clip ends are not walls", () => {
        // Forty tracks span the whole clip: no wall.
        const whole = Array.from({length: 40}, () => [0, 670]);
        expect(detectTrackWalls(whole, 671)).toEqual([]);
        // A blur burst at ~300 breaks half of them: ends pile up just before it, restarts
        // just after - one wall, at the burst.
        const broken = [
            ...Array.from({length: 20}, () => [0, 670]),
            ...Array.from({length: 20}, () => [0, 298]),
            ...Array.from({length: 20}, () => [304, 670]),
        ];
        const walls = detectTrackWalls(broken, 671);
        expect(walls).toHaveLength(1);
        expect(Math.abs(walls[0] - 300)).toBeLessThan(20);
    });

    test("window plans are deterministic, capped, and half-overlapping", () => {
        // No walls: a 671-frame clip splits into six 220-frame windows stepping ~90. This
        // exact list is the documented no-wall fallback.
        expect(planIdentifyWindows([], 671)).toEqual(
            [[0, 220], [90, 310], [180, 400], [271, 491], [361, 581], [451, 671]]);
        // Run B's measured walls: cut at both, split only the long middle span.
        expect(planIdentifyWindows([190, 530], 671)).toEqual(
            [[0, 190], [190, 410], [250, 470], [310, 530], [530, 671]]);
        // A short clip is one window, untouched.
        expect(planIdentifyWindows([], 150)).toEqual([[0, 150]]);
        // Every planned window respects the sweep-validated cap.
        for (const [w0, w1] of planIdentifyWindows([190, 630], 671)) {
            expect(w1 - w0).toBeLessThanOrEqual(STAR_WINDOW_DEFAULTS.maxWindowFrames);
        }
    });
});

describe("label merging and window quarantine", () => {
    // Hand-built accepted-window records in the internal shape: solved.matches index into sub.
    const mkWindow = (w0, w1, entries, tolPx = 6) => ({
        w0, w1,
        sub: entries.map(([index, , , cover]) => ({index, cover})),
        solved: {
            tolPx,
            matches: entries.map(([, hip, dPx], i) => ({
                image: i, cat: hip, hip, raDeg: 0, decDeg: 0, mag: 5, dPx,
            })),
        },
    });

    test("merge prefers the window that observed the track longest, then the tighter fit", () => {
        const a = mkWindow(0, 220, [[7, 111, 3.0, 200]]);
        const b = mkWindow(110, 330, [[7, 222, 0.5, 40]]);
        // Coverage rules despite the worse residual...
        const {labels, disputes} = mergeWindowLabels([a, b]);
        expect(labels.get(7).hip).toBe(111);
        // ...and the disagreement is flagged, never voted on.
        expect(disputes).toEqual([{index: 7, kept: 111, dropped: 222}]);
        // Equal coverage: the normalised residual decides.
        const c = mkWindow(0, 220, [[9, 333, 3.0, 100]]);
        const d = mkWindow(110, 330, [[9, 444, 1.0, 100]]);
        expect(mergeWindowLabels([c, d]).labels.get(9).hip).toBe(444);
    });

    test("two fragments of one star may both carry its name", () => {
        // Drift re-enters a broken track as a second chart entry; both halves are the same
        // star and both deserve the label - this is not a conflict.
        const w = mkWindow(0, 220, [[1, 555, 1.0, 150], [2, 555, 2.0, 80]]);
        const {labels, disputes} = mergeWindowLabels([w]);
        expect(labels.get(1).hip).toBe(555);
        expect(labels.get(2).hip).toBe(555);
        expect(disputes).toEqual([]);
    });

    test("a zoom that changes between windows bakes a per-frame FOV, not one constant", () => {
        // Two overlapping windows whose plate scales differ 10% - a genuine mid-pan zoom.
        // Away from the overlap each window's own FOV holds; inside it the value blends
        // monotonically between them; an uncovered frame has no FOV at all (no pose either).
        const windows = [
            {w0: 0, w1: 220, solved: {pxPerDeg: 80}},
            {w0: 110, w1: 330, solved: {pxPerDeg: 72}},
        ];
        const videoH = 642;
        const vfovOf = (pxPerDeg) =>
            2 * Math.atan((Math.PI / 180 / pxPerDeg) * videoH / 2) * 180 / Math.PI;
        expect(windowVfovDegAt(windows, 50, videoH)).toBeCloseTo(vfovOf(80), 6);
        expect(windowVfovDegAt(windows, 300, videoH)).toBeCloseTo(vfovOf(72), 6);
        let prev = windowVfovDegAt(windows, 110, videoH);
        for (let f = 111; f < 220; f++) {
            const v = windowVfovDegAt(windows, f, videoH);
            expect(v).toBeGreaterThanOrEqual(prev);
            expect(v).toBeGreaterThanOrEqual(vfovOf(80) - 1e-9);
            expect(v).toBeLessThanOrEqual(vfovOf(72) + 1e-9);
            prev = v;
        }
        expect(windowVfovDegAt(windows, 400, videoH)).toBeNull();
    });

    test("a window that contradicts the chain is quarantined; a lone pair is never arbitrated", () => {
        const agreeSet = [[1, 101, 1, 50], [2, 102, 1, 50], [3, 103, 1, 50], [4, 104, 1, 50]];
        const wrongSet = [[1, 901, 1, 50], [2, 902, 1, 50], [3, 903, 1, 50], [4, 904, 1, 50]];
        const chainA = mkWindow(0, 220, agreeSet);
        const chainB = mkWindow(110, 330, agreeSet);
        const chainC = mkWindow(220, 440, agreeSet);
        const impostor = mkWindow(330, 550, wrongSet);
        // Three agreeing windows form the chain; the mass-disagreeing fourth is out. This is
        // the measured wide-tier failure shape: 13 of 13 shared labels changed.
        expect(quarantineWindows([chainA, chainB, chainC, impostor]))
            .toEqual([false, false, false, true]);
        // Two windows alone disagreeing is not decidable - quarantine neither.
        expect(quarantineWindows([chainA, impostor])).toEqual([false, false]);
        // Windows sharing fewer than three tracks cannot testify against each other.
        const tiny = mkWindow(440, 660, [[1, 901, 1, 50], [2, 902, 1, 50]]);
        expect(quarantineWindows([chainA, chainB, chainC, tiny]))
            .toEqual([false, false, false, false]);
    });
});

describe("windowed identification of the healthy capture (run B)", () => {
    let win = null;
    beforeAll(async () => {
        win = await solveFieldWindowed(runBStars, catalog, indexes, {
            videoW: runB.videoW, videoH: runB.videoH, totalFrames: runB.totalFrames,
        });
    }, 300000);

    test("every wall-aware window solves and the coverage is complete", () => {
        expect(win.ok).toBe(true);
        expect(win.windows.length).toBe(5);
        expect(win.surviving.length).toBe(5);
        expect(win.partial).toBe(false);
        expect(win.covered).toEqual([[0, 671]]);
        // Each window solve exposes the tolerance its residuals were collected at.
        for (const w of win.surviving) expect(w.solved.tolPx).toBeGreaterThan(0);
    });

    test("Vega and the bulk of the chart get labels - the single-model path managed 42", async () => {
        expect(win.labels.size).toBeGreaterThanOrEqual(90);
        const vega = [...win.labels.values()].find((v) => v.hip === HIP_VEGA);
        expect(vega).toBeDefined();
        expect(vega.dPx).toBeLessThan(3);
    });

    test("every label agrees with the independently-solved short segment", async () => {
        const {agree, audited, disputes} = await auditAgainstShort(win.labels, runB.stars, 1.5);
        expect(disputes).toEqual([]);
        expect(audited).toBeGreaterThanOrEqual(20);
        expect(agree).toBe(audited);
    });

    test("the compatibility primary is the reference-frame window", () => {
        expect(win.primary.w0).toBe(0);
        expect(win.primary.solved.ok).toBe(true);
    });
});

describe("windowed identification of the degraded capture (run C)", () => {
    let win = null;
    beforeAll(async () => {
        win = await solveFieldWindowed(runC.stars, catalog, indexes, {
            videoW: runC.videoW, videoH: runC.videoH, transforms: runC.transforms,
            totalFrames: runC.totalFrames,
        });
    }, 600000);

    test("most windows now solve, and the uncovered tail is reported honestly", () => {
        // This capture's tracker output degraded mid-clip, and originally only the first
        // window solved (its FULL chart never solves at all). The density-matched mag-5.5
        // tier and the depth-9 neighbour lists then rescued the middle windows too - four
        // windows marching with the pan, agreeing to a degree - leaving only the final
        // stretch behind the frame-630 track-break wall uncovered. Partial coverage remains
        // the honest truth of this data.
        expect(win.ok).toBe(true);
        expect(win.surviving.length).toBeGreaterThanOrEqual(3);
        expect(win.surviving[0].w0).toBe(0);
        // The windows must be ONE sky, marching: RA increases monotonically with the pan.
        const ras = win.surviving.map((w) => w.solved.centerRaDeg);
        for (let i = 1; i < ras.length; i++) expect(ras[i]).toBeGreaterThan(ras[i - 1] - 0.5);
        expect(win.partial).toBe(true);
        expect(win.covered[0][0]).toBe(0);
        expect(win.covered[0][1]).toBeLessThan(runC.totalFrames);
        expect(win.disputes).toHaveLength(0);
    });

    test("Vega is still named - the single-model path delivers nothing here", async () => {
        const vega = [...win.labels.values()].find((v) => v.hip === HIP_VEGA);
        expect(vega).toBeDefined();
        expect(vega.dPx).toBeLessThan(3);
        const {agree, audited, disputes} = await auditAgainstShort(win.labels, runC.stars, 5);
        expect(disputes).toEqual([]);
        expect(audited).toBeGreaterThanOrEqual(15);
        expect(agree).toBe(audited);
    });
});

describe("the solver hardenings hold on the deterministic impostor", () => {
    test("wide-tier-only late window refuses instead of shipping a wrong field", async () => {
        // Before the round-0 rematch-collapse rule, this exact input passed EVERY production
        // gate with RA 232.8 / Dec -50.7 / fov 66.6 deg - the truth is RA 288.6 / Dec +41.5 /
        // fov 15.6 - and shipped five labels up to 134 degrees wrong. Its rematch found 8 of
        // the provisional 25; the rollback then let the final gate accept the unrefined count.
        const sub = runC.stars.filter((s) =>
            s.obsF.filter((f) => f >= 440 && f < 660).length >= 15);
        let bx0 = 0, by0 = 0, bx1 = runC.videoW, by1 = runC.videoH;
        for (const s of sub) {
            bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
            by0 = Math.min(by0, s.y); by1 = Math.max(by1, s.y);
        }
        const solved = await solveField(sub, catalog, [indexes[3]], {
            center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
            width: Math.max(bx1 - bx0, by1 - by0),
            bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
        });
        expect(solved.ok).toBe(false);
    });
});
