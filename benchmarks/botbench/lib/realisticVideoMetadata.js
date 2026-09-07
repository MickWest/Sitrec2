import {encodeMISBLocalSet} from "../../../src/MISBEncoder";

// A reproducible capture-like cadence: acquisition at about 4.8 Hz, with
// presentation times quantized between video frames and occasional one-frame
// timing variation. UTC describes acquisition; PES PTS describes presentation.
// Keep both clocks in the output so tests can distinguish their effects.
export function realisticVideoMetadata(plan, records) {
    let seed = plan.wobbleSeed >>> 0;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
    const samples = [];
    const fps = plan.fps, ticksPerFrame = 90000 / fps;
    if (!Number.isInteger(ticksPerFrame)) throw new Error("Expected an integer transport tick count per frame");
    let time = 2.5 / fps;
    while (time * fps < records.length - 1) {
        const frame = time * fps, lo = Math.floor(frame), fraction = frame - lo;
        const a = records[lo].values, b = records[lo + 1].values;
        const values = {};
        for (const tag of [5,6,7,13,14,15,16,17,18,19,20]) {
            const circular = [5,18,20].includes(tag);
            const delta = circular ? ((b[tag] - a[tag] + 540) % 360) - 180 : b[tag] - a[tag];
            const value = a[tag] + delta * fraction;
            values[tag] = circular ? (value + 360) % 360 : value;
        }
        values[2] = records[0].values[2] + Math.round(time * 1e6);
        // These meaningful synthetic identifiers also exercise BER long lengths
        // and KLV records spanning multiple TS packets, as capture files do.
        values[3] = `BotBench synthetic balloon tracking reference profile; ${plan.name}; calibrated one metre target`;
        values[4] = "SIM-0001";
        values[10] = "Simulated sensor platform";
        values[11] = "Synthetic monochrome";
        values[12] = "WGS-84";
        const jitter = samples.length === 0 ? 0 : random();
        const frameJitter = samples.length === 0 ? 0 : jitter < .06 ? -1 : jitter > .94 ? 1 : 0;
        const ptsOffset90k = Math.round((Math.round(frame - .5) + .5 + frameJitter) * ticksPerFrame);
        if (ptsOffset90k > (records.length - 1) * ticksPerFrame) break;
        const klv = Array.from(encodeMISBLocalSet(values));
        samples.push({sourceFrame: frame, ptsOffset90k, values, klv});
        time += .2 + (random() < .4 ? .02 : 0) + (random() - .5) * .002;
    }
    if (!plan.zoomEvents?.length) return samples;
    const eventFrames = plan.zoomEvents.map(e => Math.round(e.timeSeconds * fps));
    // Lens switches are discrete state changes. Drop a jittered sample if its
    // acquisition and presentation times fall on opposite sides of a switch;
    // it would otherwise undo the new lens state or announce it too early.
    const withZoom = samples.filter(s => eventFrames.every(f =>
        (s.sourceFrame < f) === (s.ptsOffset90k < f * ticksPerFrame)));
    for (const sample of withZoom) {
        const lens = records[Math.floor(sample.sourceFrame)].values;
        sample.values[16] = lens[16]; sample.values[17] = lens[17];
        sample.klv = Array.from(encodeMISBLocalSet(sample.values));
    }
    // Event-driven updates supplement the ordinary sparse cadence and anchor
    // each switch to its exact video frame in both clocks.
    for (const frame of eventFrames) {
        if (frame < 0 || frame >= records.length) throw new Error("Zoom event is outside the recording");
        const values = {...samples[0].values, ...records[frame].values};
        withZoom.push({sourceFrame: frame, ptsOffset90k: frame * ticksPerFrame,
            event: "zoom", values, klv: Array.from(encodeMISBLocalSet(values))});
    }
    return withZoom.sort((a, b) => a.ptsOffset90k - b.ptsOffset90k);
}
