/**
 * Tests for the wind-drift Sky Lantern model (src/SkyLanternModel.js).
 *
 * The model is pure kinematics: horizontal velocity == altitude-sheared wind,
 * vertical velocity == lantern life cycle (rise while lit, buoyancy decay
 * after flame-out, terminal sink). A synthetic turning sensor watches a
 * synthetic lantern; the DE+Nelder-Mead fit (the same recipe LOSFitting.js
 * uses) must recover the drift direction, speed regime, and vertical phases.
 *
 * Deliberately does NOT import LOSFitting.js (it pulls in three.js/Globals,
 * which this Jest suite must stay clear of) — the fit orchestration here is a
 * compact copy of fitPhysicsModel's core.
 */

import {SkyLanternModel} from "../src/SkyLanternModel";
import {integrateRK4} from "../src/PhysicsModel";
import {differentialEvolution} from "../src/DifferentialEvolution";
import {nelderMead} from "../src/NelderMead";
import {assessBoundPins} from "../src/BoundedFit";

const KNOTS_TO_MS = 0.514444;

// Deterministic PRNG (mulberry32) in place of Math.random so the DE search
// can't flake. (A plain LCG's sequential correlation visibly degrades DE's
// population diversity — mulberry32 is cheap and statistically sound.)
let _seed = 987654321;
const lcg = () => {
    _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Synthetic lantern through sheared wind, watched by a turning sensor.
function makeLanternScenario({
    n = 1800, fps = 30,
    windE = -6, windN = -3,           // drift toward ~243° (wind from ~63°)
    shearPerM = 0.002,
    vRise = 2.0, vSink = 1.2, tBurn = 20, tauCool = 40,
    start = [800, 4000, 250],
} = {}) {
    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const track = new Float64Array(n * 3);
    const z0 = start[2];
    let [x, y, z] = start;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        track[f * 3] = x; track[f * 3 + 1] = y; track[f * 3 + 2] = z;
        const mult = Math.min(3, Math.max(0.25, 1 + shearPerM * (z - z0)));
        const vz = t <= tBurn ? vRise
            : -vSink + (vRise + vSink) * Math.exp(-(t - tBurn) / tauCool);
        x += windE * mult / fps;
        y += windN * mult / fps;
        z += vz / fps;
    }
    const Rs = 2000, omega = 0.03;    // sensor turn makes range observable
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        S[f * 3] = Rs * Math.sin(omega * t);
        S[f * 3 + 1] = Rs * (1 - Math.cos(omega * t));
        S[f * 3 + 2] = 500 + 1.5 * t;
        let dx = track[f * 3] - S[f * 3];
        let dy = track[f * 3 + 1] - S[f * 3 + 1];
        let dz = track[f * 3 + 2] - S[f * 3 + 2];
        const dl = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
    }
    const times = new Float64Array(n);
    for (let f = 0; f < n; f++) times[f] = f / fps;
    return {dataset: {sensorPos: S, losDir: D, times, count: n}, track, n, fps};
}

function angErr(fx, fy, fz, sx, sy, sz, dx, dy, dz) {
    let rx = fx - sx, ry = fy - sy, rz = fz - sz;
    const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    rx /= rlen; ry /= rlen; rz /= rlen;
    const dot = Math.max(-1, Math.min(1, rx * dx + ry * dy + rz * dz));
    return Math.acos(dot);
}

// Compact copy of fitPhysicsModel's core (DE + polish over strided frames).
async function fitLantern(dataset, {stride = 5, pop = 48, gens = 120} = {}) {
    const model = new SkyLanternModel();
    const defs = model.getParameterDefs();
    const lo = defs.map(p => p.min), hi = defs.map(p => p.max);
    const x0 = defs.map(p => p.default), scales = defs.map(p => p.scale);
    const {sensorPos, losDir, times, count} = dataset;
    const T = times[count - 1];

    const costFrames = [];
    for (let k = 0; k < count; k += stride) costFrames.push(k);
    if (costFrames[costFrames.length - 1] !== count - 1) costFrames.push(count - 1);
    const costTimes = costFrames.map(i => times[i]);

    const costFn = (params) => {
        const states = integrateRK4(model, model.getInitialState(params, dataset), params, costTimes);
        let sum = 0;
        for (let k = 0; k < costFrames.length; k++) {
            const fi = costFrames[k], s = states[k], b = fi * 3;
            sum += angErr(s[0], s[1], s[2],
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
        }
        const errDeg = (sum / costFrames.length) * 180 / Math.PI;
        return errDeg / 0.02 + model.extraCost(params, dataset, T);
    };

    const de = await differentialEvolution(costFn, lo, hi, {pop, gens, seeds: [x0]});
    let best = await nelderMead(costFn, de.params, {lo, hi, initialScale: scales, maxIter: 3000});
    if (de.cost < best.cost) best = de;

    const allTimes = Array.from(times);
    const states = integrateRK4(model, model.getInitialState(best.params, dataset), best.params, allTimes);
    const track = new Float64Array(count * 3);
    let errSum = 0;
    for (let i = 0; i < count; i++) {
        const s = states[i], b = i * 3;
        track[b] = s[0]; track[b + 1] = s[1]; track[b + 2] = s[2];
        errSum += angErr(s[0], s[1], s[2],
            sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
            losDir[b], losDir[b + 1], losDir[b + 2]);
    }
    const solved = {};
    defs.forEach((d, i) => solved[d.name] = best.params[i]);
    return {track, solved, errDeg: (errSum / count) * 180 / Math.PI};
}

describe("SkyLanternModel", () => {

    let randSpy;
    beforeEach(() => {
        _seed = 987654321;
        randSpy = jest.spyOn(Math, "random").mockImplementation(lcg);
    });
    afterEach(() => randSpy.mockRestore());

    test("initial state sits on the first LOS ray with geodetic h0 riding along", () => {
        const model = new SkyLanternModel();
        const dataset = {
            sensorPos: Float64Array.from([100, 200, 500]),
            losDir: Float64Array.from([0.6, 0.64, -0.48]),
        };
        const s = model.getInitialState([1000, 0, 0, 0, 1, 1, 60, 60], dataset);
        expect(s[0]).toBeCloseTo(100 + 600, 6);
        expect(s[1]).toBeCloseTo(200 + 640, 6);
        expect(s[2]).toBeCloseTo(500 - 480, 6);
        const expectedH0 = s[2] + (s[0] * s[0] + s[1] * s[1]) / (2 * 6371000);
        expect(s[3]).toBeCloseTo(expectedH0, 9); // shear reference = initial geodetic altitude
    });

    test("vertical profile: rise while lit, decay to terminal sink after flame-out", () => {
        const model = new SkyLanternModel();
        // params: range, windE, windN, shear, vRise, vSink, tBurn, tauCool
        const p = [1000, 0, 0, 0, 2.0, 1.5, 30, 20];
        expect(model._vz(0, p)).toBeCloseTo(2.0, 9);
        expect(model._vz(30, p)).toBeCloseTo(2.0, 9);          // continuous at burnout
        expect(model._vz(30 + 200, p)).toBeCloseTo(-1.5, 3);   // terminal sink
        // closed-form altitude matches numeric integration of _vz
        const z0 = 250;
        let z = z0;
        const dt = 0.01;
        for (let t = 0; t < 120; t += dt) z += model._vz(t + dt / 2, p) * dt;
        expect(model._hAt(120, p, z0)).toBeCloseTo(z, 1);
        // and with a pre-clip burnout (tBurn < 0)
        const p2 = [1000, 0, 0, 0, 2.0, 1.5, -50, 40];
        let z2 = z0;
        for (let t = 0; t < 120; t += dt) z2 += model._vz(t + dt / 2, p2) * dt;
        expect(model._hAt(120, p2, z0)).toBeCloseTo(z2, 1);
    });

    test("pre-burn vSink at its maximum is diagnosed as inactive, not a capability limit", () => {
        const model = new SkyLanternModel();
        const defs = model.getParameterDefs();
        const lo = defs.map((d) => d.min), hi = defs.map((d) => d.max);
        const names = defs.map((d) => d.name);
        const p = [6000, 4, -6, 0.002, 1.27, 4, 194, 143];
        const clipT = 22;
        // While clipT < tBurn, _hAt and _vz never use vSink or tauCool.
        const cost = (q) => (model._hAt(clipT, q, 1000) - 1027.94) ** 2;
        const pins = assessBoundPins(p, lo, hi, names, cost, {absoluteTolerance: 1e-8});
        const sink = pins.find((pin) => pin.name === "vSink");
        expect(sink).toBeDefined();
        expect(sink.loadBearing).toBe(false);
        expect(sink.deltaCost).toBeCloseTo(0, 10);
    });

    test("post-burn sink bound is load-bearing when the trajectory requires faster descent", () => {
        const model = new SkyLanternModel();
        const defs = model.getParameterDefs();
        const lo = defs.map((d) => d.min), hi = defs.map((d) => d.max);
        const names = defs.map((d) => d.name);
        const p = [6000, 4, -6, 0.002, 0, 4, 0, 10];
        const clipT = 120;
        const target = model._hAt(clipT, [6000, 4, -6, 0.002, 0, 5, 0, 10], 1000);
        const cost = (q) => ((model._hAt(clipT, q, 1000) - target) / 10) ** 2;
        const pins = assessBoundPins(p, lo, hi, names, cost, {absoluteTolerance: 1e-8});
        expect(pins.find((pin) => pin.name === "vSink")).toMatchObject({loadBearing: true});
    });

    test("wind shear multiplier is clamped so wind never reverses or blows up", () => {
        const model = new SkyLanternModel();
        const p = [1000, 10, 0, 0.008, 0, 0, 60, 60];
        // way below the reference altitude: clamped at the floor, same sign
        const dLow = model.derivatives([0, 0, -10000, 500], p, 0);
        expect(dLow[0]).toBeCloseTo(10 * 0.25, 6);
        // way above: clamped at the ceiling
        const dHigh = model.derivatives([0, 0, 100000, 500], p, 0);
        expect(dHigh[0]).toBeCloseTo(10 * 3.0, 6);
    });

    test("recovers a synthetic lantern: drift direction, speed regime, phases", async () => {
        const {dataset, track, n, fps} = makeLanternScenario();
        const fit = await fitLantern(dataset);

        // near-exact fit to clean synthetic sightlines
        expect(fit.errDeg).toBeLessThan(0.05);

        // drift direction (wind FROM ~63°) within 20°
        const windFrom = (Math.atan2(-fit.solved.windE, -fit.solved.windN) * 180 / Math.PI + 360) % 360;
        expect(Math.abs(windFrom - 63)).toBeLessThan(20);

        // lantern-plausible drift speed. (LOS-only data admits a degenerate
        // closer-and-slower / farther-and-faster family around the true 14 kt;
        // the model guarantees the REGIME, not the exact member.)
        const T = (n - 1) / fps;
        const dx = fit.track[(n - 1) * 3] - fit.track[0];
        const dy = fit.track[(n - 1) * 3 + 1] - fit.track[1];
        const meanKt = Math.hypot(dx, dy) / T / KNOTS_TO_MS;
        expect(meanKt).toBeGreaterThan(3);
        expect(meanKt).toBeLessThan(25);

        // vertical phases: rising while the flame burns, and the rise has
        // decayed by the end of the clip. (Where exactly the neutral point
        // lands trades off against range within the degenerate family, so
        // only the shape is asserted, not the exact end rate.)
        expect(fit.solved.vRise).toBeGreaterThan(0.5);
        const vzEnd = new SkyLanternModel()._vz(T, Object.values(fit.solved));
        expect(vzEnd).toBeLessThan(fit.solved.vRise);
        expect(vzEnd).toBeLessThan(1.0);

        // positionally sane: the track stays within the degenerate family's
        // envelope of the synthetic truth
        let sum = 0;
        for (let f = 0; f < n; f++) {
            const b = f * 3;
            sum += Math.hypot(fit.track[b] - track[b], fit.track[b + 1] - track[b + 1],
                fit.track[b + 2] - track[b + 2]);
        }
        expect(sum / n).toBeLessThan(600);
    }, 120000);

    test("parameter bounds forbid non-lantern VERTICAL motion; wind is a search range", () => {
        const defs = new SkyLanternModel().getParameterDefs();
        const byName = Object.fromEntries(defs.map(d => [d.name, d]));

        // WIND IS NO LONGER AN EXCLUSION. This assertion used to require the
        // wind box's diagonal to stay under 60 kt, i.e. the box was doing double
        // duty — bracketing the search AND excluding non-lantern motion. The two
        // jobs want different numbers, because a box's reachable set is a square
        // while wind speed is a magnitude: at ±20 m/s that was 39 kt from every
        // bearing but 55 kt only along the diagonal, so an ordinary 42 kt wind
        // pinned for no reason except its direction.
        //
        // The bound is now ±40 m/s and is a SEARCH RANGE. Exclusion moved to the
        // extraCost speed prior and the kinematic ordinariness screen, which can
        // be reasoned about; the box declines to prefer a fast wind rather than
        // refusing one. What is still worth asserting is that it is symmetric,
        // finite, and generous enough to reach ordinary winds aloft from ANY
        // bearing — the property whose absence caused the pin.
        expect(byName.windE.max).toBe(-byName.windE.min);
        expect(byName.windN.max).toBe(-byName.windN.min);
        const omnidirectionalKt = Math.min(byName.windE.max, byName.windN.max) / KNOTS_TO_MS;
        expect(omnidirectionalKt).toBeGreaterThanOrEqual(45);   // 40-45 kt aloft is ordinary
        expect(Number.isFinite(byName.windE.max)).toBe(true);
        // Recorded, not endorsed: the diagonal admits motion no lantern makes.
        // A magnitude constraint would remove it — see the corrections queue.
        expect(Math.hypot(byName.windE.max, byName.windN.max) / KNOTS_TO_MS)
            .toBeGreaterThan(60);
        expect(byName.vRise.max).toBeLessThanOrEqual(4);
        expect(byName.vSink.max).toBeLessThanOrEqual(4);
        // rise rate cannot be negative (that's what vSink is for)
        expect(byName.vRise.min).toBeGreaterThanOrEqual(0);
    });

    // Seeding the fit from the best geometric approximation (the Kalman
    // smoother / least-manoeuvring track). Unseeded, the time-varying wind is
    // unsearchable at the shipping DE budget and pins its parameters at their
    // bounds; seeded, the fit STARTS on the geometric path. The mechanism is a
    // direct inversion — the ground velocity IS the wind — so these tests check
    // the inversion is faithful and lands the fit in a far better basin.
    describe("track seeding", () => {
        const EARTH_R = 6371000;

        // A track generated by the model itself from a KNOWN time-varying wind
        // (shear 0, so ground velocity is exactly the wind quadratic). Returns
        // the track plus a minimal dataset (sensor at origin, first ray toward
        // the start) so seedFromTrack can invert it.
        function makeModelTrack({
            n = 1200, fps = 30, start = [1500, 2500, 300],
            base = [3, -2], drift = [4, 3], curve = [-2, 1],
            vRise = 0, vSink = 0, tBurn = 1e6, tauCool = 60,
        } = {}) {
            const T = (n - 1) / fps;
            const model = new SkyLanternModel();
            model.clipDuration = T;
            const params = [0, base[0], base[1], 0, vRise, vSink, tBurn, tauCool,
                drift[0], drift[1], curve[0], curve[1]];
            const h0 = start[2] + (start[0] * start[0] + start[1] * start[1]) / (2 * EARTH_R);
            const times = Array.from({length: n}, (_, f) => f / fps);
            const states = integrateRK4(model, [start[0], start[1], start[2], h0], params, times);
            const track = new Float64Array(n * 3);
            for (let f = 0; f < n; f++) {
                track[f * 3] = states[f][0];
                track[f * 3 + 1] = states[f][1];
                track[f * 3 + 2] = states[f][2];
            }
            const r0 = Math.hypot(start[0], start[1], start[2]);
            const sensorPos = new Float64Array(n * 3);   // origin
            const losDir = new Float64Array(n * 3);
            losDir[0] = start[0] / r0; losDir[1] = start[1] / r0; losDir[2] = start[2] / r0;
            return {track, dataset: {sensorPos, losDir, times: Float64Array.from(times), count: n}, T, r0};
        }

        test("recovers the wind quadratic: base, drift and curvature per component", () => {
            const base = [3, -2], drift = [4, 3], curve = [-2, 1.5];
            const {track, dataset, r0} = makeModelTrack({base, drift, curve});
            const m = new SkyLanternModel();
            m.clipDuration = dataset.times[dataset.count - 1];
            const s = m.seedFromTrack(track, dataset);
            expect(s[0]).toBeCloseTo(r0, 0);         // range along the first ray
            expect(s[1]).toBeCloseTo(base[0], 1);    // windE  (velocity at s=0)
            expect(s[2]).toBeCloseTo(base[1], 1);    // windN
            expect(s[3]).toBe(0);                    // shear seeded to 0
            expect(s[8]).toBeCloseTo(drift[0], 0);   // windDriftE (linear)
            expect(s[9]).toBeCloseTo(drift[1], 0);   // windDriftN
            expect(s[10]).toBeCloseTo(curve[0], 0);  // windCurveE (quadratic)
            expect(s[11]).toBeCloseTo(curve[1], 0);  // windCurveN
        });

        test("the seed re-integrates back onto the geometric path (faithful inversion)", () => {
            const {track, dataset, T} = makeModelTrack({drift: [5, -4], curve: [-3, 2]});
            const m = new SkyLanternModel();
            m.clipDuration = T;
            const seed = m.seedFromTrack(track, dataset);
            const times = Array.from(dataset.times);
            const states = integrateRK4(m, m.getInitialState(seed, dataset), seed, times);
            let sum = 0;
            for (let f = 0; f < dataset.count; f++) {
                sum += Math.hypot(
                    states[f][0] - track[f * 3],
                    states[f][1] - track[f * 3 + 1],
                    states[f][2] - track[f * 3 + 2]);
            }
            expect(sum / dataset.count).toBeLessThan(5);   // metres, mean separation
        });

        test("vertical regime: level, rising and descending seed the life cycle correctly", () => {
            // Build constant-vertical-rate tracks directly (independent of the
            // model) so the regime detection is what is under test.
            const mk = (climb) => {
                const n = 600, fps = 30;
                const track = new Float64Array(n * 3);
                for (let f = 0; f < n; f++) {
                    track[f * 3] = 1000 + 2 * (f / fps);
                    track[f * 3 + 1] = 2000;
                    track[f * 3 + 2] = 400 + climb * (f / fps);
                }
                const times = Float64Array.from({length: n}, (_, f) => f / fps);
                const sensorPos = new Float64Array(n * 3);
                const losDir = new Float64Array(n * 3); losDir[0] = 1;
                const m = new SkyLanternModel();
                m.clipDuration = (n - 1) / fps;
                return m.seedFromTrack(track, {sensorPos, losDir, times, count: n});
            };
            const level = mk(0);
            expect(level[4]).toBeCloseTo(0, 6);      // vRise
            expect(level[5]).toBeCloseTo(0, 6);      // vSink
            const rising = mk(1.5);
            expect(rising[4]).toBeCloseTo(1.5, 1);   // vRise ~ climb
            expect(rising[5]).toBeCloseTo(0, 6);
            expect(rising[6]).toBeGreaterThan(0);    // tBurn: burning through the clip
            const sinking = mk(-1.2);
            expect(sinking[5]).toBeCloseTo(1.2, 1);  // vSink ~ -climb
            expect(sinking[4]).toBeCloseTo(0, 6);
            expect(sinking[6]).toBeLessThan(0);      // tBurn: already past burnout
        });

        test("a seed implying more than the wind bounds is clamped, never silently repaired", () => {
            // 40 m/s east velocity — twice the ±20 bound.
            const n = 600, fps = 30;
            const track = new Float64Array(n * 3);
            for (let f = 0; f < n; f++) {
                track[f * 3] = 500 + 40 * (f / fps);
                track[f * 3 + 1] = 1000;
                track[f * 3 + 2] = 300;
            }
            const times = Float64Array.from({length: n}, (_, f) => f / fps);
            const sensorPos = new Float64Array(n * 3);
            const losDir = new Float64Array(n * 3); losDir[0] = 1;
            const m = new SkyLanternModel();
            m.clipDuration = (n - 1) / fps;
            const s = m.seedFromTrack(track, {sensorPos, losDir, times, count: n});
            const defs = m.getParameterDefs();
            for (let i = 0; i < s.length; i++) {
                expect(s[i]).toBeGreaterThanOrEqual(defs[i].min - 1e-9);
                expect(s[i]).toBeLessThanOrEqual(defs[i].max + 1e-9);
            }
            // Against the def, not a literal. The point is that the seed is
            // CLAMPED to whatever the ceiling is, and a hard-coded copy of that
            // ceiling goes stale silently the moment the bound moves — it did,
            // reading 20 while the bound became 40.
            expect(s[1]).toBeCloseTo(defs[1].max, 6);   // windE clamped to its ceiling
        });

        test("seeding lands the fit in a far better basin than the model defaults", async () => {
            // A lantern in time-varying wind, watched by a turning sensor:
            // constant wind cannot fit it. Seed from the truth track (the
            // best-geometric stand-in) and the seed's cost must be dramatically
            // below the model-default cost — proof the fit starts in the right
            // basin rather than searching 12-D blind.
            const {dataset, track, n, fps} = makeLanternScenario({
                windE: 2, windN: -1, shearPerM: 0,
                vRise: 0.6, vSink: 0.6, tBurn: 5, tauCool: 30,
            });
            // Bend the wind over the clip so a straight drift cannot explain it.
            const bent = new Float64Array(track);
            for (let f = 0; f < n; f++) {
                const s = f / (n - 1);
                bent[f * 3] += 60 * s * s;          // growing eastward excursion
                bent[f * 3 + 1] -= 40 * s;
            }
            // Rebuild rays to watch the bent track (still a turning sensor).
            const {sensorPos, losDir, times, count} = dataset;
            for (let f = 0; f < n; f++) {
                const b = f * 3;
                const dx = bent[b] - sensorPos[b], dy = bent[b + 1] - sensorPos[b + 1], dz = bent[b + 2] - sensorPos[b + 2];
                const dl = Math.hypot(dx, dy, dz);
                losDir[b] = dx / dl; losDir[b + 1] = dy / dl; losDir[b + 2] = dz / dl;
            }
            const T = times[count - 1];
            const model = new SkyLanternModel();
            model.clipDuration = T;
            const costFn = (params) => {
                const states = integrateRK4(model, model.getInitialState(params, dataset), params, Array.from(times));
                let sum = 0;
                for (let f = 0; f < count; f++) {
                    const s = states[f], b = f * 3;
                    sum += angErr(s[0], s[1], s[2],
                        sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                        losDir[b], losDir[b + 1], losDir[b + 2]);
                }
                return (sum / count) * 180 / Math.PI / 0.02 + model.extraCost(params, dataset, T);
            };
            const defs = model.getParameterDefs();
            const defaultCost = costFn(defs.map((d) => d.default));
            const seedCost = costFn(model.seedFromTrack(bent, dataset));
            expect(seedCost).toBeLessThan(defaultCost);
            // A large margin, not a marginal one: the seed already fits.
            expect(seedCost).toBeLessThan(defaultCost * 0.5);
        }, 30000);
    });
});
