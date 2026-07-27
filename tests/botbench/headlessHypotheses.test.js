/**
 * headlessHypotheses.test.js — locks the property the TraverseHypotheses
 * extraction exists to provide: the REAL production hypothesis builder, the one
 * the analysis gallery ranks, must stay reachable from a plain Node test with
 * no scene, no node graph and no three.js addons.
 *
 * If this ever fails to import, something GUI-coupled has crept back into
 * TraverseHypotheses.js and the benchmark has silently stopped measuring the
 * shipping code path.
 *
 * setSit() below is for the SCENARIO GENERATOR only — BalloonPhysics reaches
 * getLocalNorthVector, which asserts on Sit.lat. The builder itself is handed
 * nothing global: clip time arrives as clipStartMs and terrain as an injected
 * probe. An earlier version of this test let setSit() cover for the builder
 * reading GlobalDateTimeNode/Sit directly, which hid the fact that every
 * date-dependent hypothesis threw headless while the cheap ones passed.
 */
import {setSit} from "../../src/Globals";
import {buildHypotheses, flatTerrainProbes} from "../../src/TraverseHypotheses";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {toTraverseDataset} from "../../benchmarks/botbench/lib/adapters";
import {groupAndRankHypotheses} from "../../src/TraverseRanking";
import {compareTrackToTruth, sweepConstAirSpeed, fitPlausibleBestRange,
    fitConstAltitude, KNOTS_TO_MS, METERS_PER_NM} from "../../src/TraverseAnalysis";

test("HEADLESS: build + rank hypotheses on a botbench scenario", async () => {
    setSit({name:"headless",frames:10000,fps:10,simSpeed:1,lat:40,lon:-105});
    const sc = generateScenario({
        epochISO:"2025-02-01T20:00:00Z", durationSeconds:60, fps:10,
        initialHorizontalRangeM:5000, siteId:"ocean",
        platform:{kind:"orbit-point",speedMS:70,altitudeAGL:3000},
        target:{kind:"party-neutral",family:"balloon",parameters:{startAGL:500}},
        wind:{kind:"fixed"}, observation:{kind:"white",fovFullDeg:0.5,gaussianSigmaDeg:0.03},
    }, {scenarioSeed:101});
    const dataset = toTraverseDataset(sc);

    // The same constant-air-speed sweep AnalyzeTraverse runs first.
    const ranges = [];
    for (let nm = 0.5; nm <= 20; nm *= 1.3) ranges.push(nm * METERS_PER_NM);
    const sweep = await sweepConstAirSpeed(dataset, {
        ranges, speedTarget: 60 * KNOTS_TO_MS,
    });
    // The cheap fits the gallery also leads with. The expensive physics fits
    // (aircraft / balloon / quadcopter) are omitted here — this is a smoke test
    // for headless reachability, not a coverage run.
    const plausible = await fitPlausibleBestRange(dataset, {vTarget: 60 * KNOTS_TO_MS});
    const ca = fitConstAltitude(dataset, {});
    // BOTH terrain probes. Supplying only localGroundZ (as this test first did)
    // builds the ground hypotheses while leaving the underground and
    // ground-contact rejections inert, so a track diving below the surface
    // ranks as eligible headless but ineligible in the app.
    const common = {dataset, sweep, plausible, ca, originLat: 0.61, originLon: -2.18,
        ...flatTerrainProbes(0)};    // flat-plane: ground is exactly z=0

    // WITH a wall clock supplied — the date-dependent path is live.
    const hyps = buildHypotheses({...common,
        clipStartMs: Date.parse(sc.site.epochISO), simSpeed: 1});
    // ...and WITHOUT one, which must skip those hypotheses rather than throw.
    const noClock = buildHypotheses(common);
    console.log(`  with clock: ${hyps.length}   without: ${noClock.length}`);
    expect(noClock.length).toBeGreaterThan(0);
    console.log(`  hypotheses built: ${hyps.length}`);
    expect(hyps.length).toBeGreaterThan(0);

    const truth = {track: sc.target.positionENU, valid: sc.target.valid};
    const scored = hyps.filter(h=>h.track && !h.atInfinity).map(h => ({
        key: h.key, sep: compareTrackToTruth(dataset, h.track, truth)?.score,
    })).filter(x=>Number.isFinite(x.sep)).sort((a,b)=>a.sep-b.sep);
    for (const s of scored.slice(0,6)) console.log(`    ${s.key.padEnd(22)} ${s.sep.toFixed(0)} m from truth`);

    const ranked = groupAndRankHypotheses(hyps);
    console.log(`  ranking returned: ${Array.isArray(ranked)?ranked.length:Object.keys(ranked).length} groups/items`);
    expect(scored.length).toBeGreaterThan(0);
}, 120000);

test("terrain probes must be supplied together", () => {
    // Regression for the review finding: one probe alone silently disables
    // either the ground hypotheses or the underground/ground-contact gate.
    const ds = {n: 2, fps: 10, S: new Float64Array(6), D: new Float64Array(6),
        W: new Float64Array(6)};
    expect(() => buildHypotheses({dataset: ds, localGroundZ: () => 0}))
        .toThrow(/must be supplied together/);
    expect(() => buildHypotheses({dataset: ds, signedAGL: () => 0}))
        .toThrow(/must be supplied together/);
});

test("flatTerrainProbes reports height above a flat surface", () => {
    const {signedAGL, localGroundZ} = flatTerrainProbes(120);
    expect(localGroundZ()).toBe(120);
    expect(signedAGL(null, 500)).toBe(380);     // ENU height minus ground
    expect(signedAGL(null, 100)).toBe(-20);     // below ground -> negative
});
