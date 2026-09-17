import {MediabunnyExporter} from "../src/MediabunnyExporter";

test.each([30, 30000 / 1001])("video timestamps stay on the absolute %s fps clock", async fps => {
    const frames = [];
    const oldFrame = global.VideoFrame;
    global.VideoFrame = class {
        constructor(canvas, timing) { frames.push(timing); }
        close() {}
    };
    try {
        const exporter = new MediabunnyExporter({fps});
        exporter.encodedWidth = 640; exporter.encodedHeight = 480;
        exporter.encoder = {encode() {}, encodeQueueSize: 0};
        for (let f = 0; f < 3000; f++) await exporter.addFrame({width: 640, height: 480}, f);
        expect(frames[0].timestamp).toBe(0);
        for (let f = 0; f < frames.length; f++) {
            expect(Math.abs(frames[f].timestamp - f * 1e6 / fps)).toBeLessThanOrEqual(0.5);
            if (f) expect(frames[f - 1].timestamp + frames[f - 1].duration).toBe(frames[f].timestamp);
        }
        expect(frames.at(-1).timestamp + frames.at(-1).duration).toBe(Math.round(3000 * 1e6 / fps));
    } finally { global.VideoFrame = oldFrame; }
});

test("MISB samples follow captured source frames while encoded timestamps remain sequential", async () => {
    const oldFrame = global.VideoFrame;
    const timings = [];
    global.VideoFrame = class {
        constructor(canvas, timing) { timings.push(timing); }
        close() {}
    };
    try {
        let sourceFrame = 0;
        const exporter = new MediabunnyExporter({fps: 30, sampleMISB: () => ({sourceFrame})});
        exporter.encodedWidth = 640; exporter.encodedHeight = 480;
        exporter.encoder = {encode() {}, encodeQueueSize: 0};
        const sourceFrames = [100, 102, 104, 102, 100];
        for (sourceFrame of sourceFrames) {
            await exporter.addFrame({width: 640, height: 480}, sourceFrame);
        }
        expect(exporter.misbRecords.map(record => record.sourceFrame)).toEqual(sourceFrames);
        expect(timings.map(t => t.timestamp)).toEqual([0, 33333, 66667, 100000, 133333]);
    } finally { global.VideoFrame = oldFrame; }
});
