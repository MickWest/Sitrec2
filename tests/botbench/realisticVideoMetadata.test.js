import {realisticVideoMetadata} from "../../benchmarks/botbench/lib/realisticVideoMetadata";
import {videoLensAtFrame} from "../../benchmarks/botbench/lib/videoZoom";

const plan = {name: "02-party-rising-orbit", fps: 30, wobbleSeed: 12345};
const epoch = 1781553600000000;
const records = Array.from({length: 900}, (_, f) => ({values: {
    2: epoch + Math.round(f * 1e6 / 30), 5: 0, 6: 0, 7: 0,
    13: 37 + f/1e6, 14: -120, 15: 6000, 16: 3, 17: 2.25,
    18: (359+f/30)%360, 19: -45, 20: 0,
}}));

test("capture cadence is sparse, deterministic, and keeps acquisition and presentation clocks distinct", () => {
    const samples = realisticVideoMetadata(plan, records);
    expect(samples).toEqual(realisticVideoMetadata(plan, records));
    expect(samples.length).toBeGreaterThan(138);
    expect(samples.length).toBeLessThan(150);
    expect(samples[0].ptsOffset90k).toBe(7500);
    expect(samples.every(s => s.ptsOffset90k % 3000 === 1500)).toBe(true);
    expect(samples.every(s => s.klv.length > 184 && s.klv.length < 350)).toBe(true);
    const intervals = samples.slice(1).map((s,i) => s.ptsOffset90k-samples[i].ptsOffset90k);
    expect(Math.min(...intervals)).toBeGreaterThanOrEqual(12000);
    expect(Math.max(...intervals)).toBeLessThanOrEqual(27000);
    expect(new Set(intervals).size).toBeGreaterThan(2);
    const clockOffsets = samples.map(s => s.values[2]-epoch-s.ptsOffset90k/90*1000);
    expect(Math.max(...clockOffsets)-Math.min(...clockOffsets)).toBeGreaterThan(30000);
    for (const s of samples) {
        expect(s.values[2]).toBe(epoch+Math.round(s.sourceFrame/30*1e6));
        const expectedAz = (359+s.sourceFrame/30)%360;
        expect(Math.abs(((s.values[18]-expectedAz+540)%360)-180)).toBeLessThan(1e-8);
    }
});

test("sparse metadata preserves instantaneous zoom on every video frame despite clock jitter", () => {
    const zoomPlan = {...plan, zoomEvents: [{timeSeconds: 10, magnification: 2}, {timeSeconds: 20, magnification: 1}]};
    const zoomRecords = records.map((r, f) => {
        const lens = videoLensAtFrame(r.values[16], r.values[17], zoomPlan, f);
        return {values: {...r.values, 16: lens.hfov, 17: lens.vfov}};
    });
    // Several seeds exercise samples that straddle a switch in either clock.
    for (let wobbleSeed = 1; wobbleSeed <= 30; wobbleSeed++) {
        const samples = realisticVideoMetadata({...zoomPlan, wobbleSeed}, zoomRecords);
        expect(samples.filter(s => s.event === "zoom").map(s => s.ptsOffset90k)).toEqual([900000, 1800000]);
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i].ptsOffset90k).toBeGreaterThan(samples[i - 1].ptsOffset90k);
            expect(samples[i].values[2]).toBeGreaterThan(samples[i - 1].values[2]);
        }
        let slot = 0;
        for (let f = 0; f < 900; f++) {
            while (slot + 1 < samples.length && samples[slot + 1].ptsOffset90k <= f * 3000) slot++;
            expect(samples[slot].values[16]).toBe(zoomRecords[f].values[16]);
            expect(samples[slot].values[17]).toBe(zoomRecords[f].values[17]);
        }
    }
});
