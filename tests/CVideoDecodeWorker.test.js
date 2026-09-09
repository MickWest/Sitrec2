import vm from "node:vm";
import {VideoDecodeWorkerManager} from "../src/CVideoDecodeWorker";

let source;
beforeAll(() => {
    const saved = {Blob: global.Blob, Worker: global.Worker, createObjectURL: URL.createObjectURL};
    try {
        global.Blob = class { constructor(parts) { source = parts.join(""); } };
        global.Worker = class {};
        URL.createObjectURL = () => "blob:worker-test";
        new VideoDecodeWorkerManager().init();
    } finally {
        Object.assign(global, {Blob: saved.Blob, Worker: saved.Worker});
        URL.createObjectURL = saved.createObjectURL;
    }
});

function worker({queueOnly = false} = {}) {
    const messages = [], bitmaps = [], timers = [];
    let decoder;
    const self = {postMessage: m => messages.push(m)};
    class Decoder {
        constructor(callbacks) { decoder = this; this.output = callbacks.output; this.state = "unconfigured"; this.decodeQueueSize = 0; this.queued = []; }
        configure() { this.state = "configured"; }
        decode(chunk) {
            if (queueOnly) { this.queued.push(chunk); this.decodeQueueSize++; }
            else this.output({timestamp: chunk.timestamp, close() {}});
        }
        drainQueue() { this.decodeQueueSize = 0; this.ondequeue?.(); }
        flush() {
            if (queueOnly) for (const chunk of this.queued) this.output({timestamp: chunk.timestamp, close() {}});
            return Promise.resolve();
        }
        reset() {}
        close() { this.state = "closed"; }
    }
    vm.runInNewContext(source, {self, VideoDecoder: Decoder, EncodedVideoChunk: class { constructor(c) { Object.assign(this, c); } },
        createImageBitmap: () => new Promise(resolve => bitmaps.push(resolve)), performance,
        setTimeout: (...args) => { const timer = setTimeout(...args); timers.push(timer); return timer; }, clearTimeout});
    const send = data => self.onmessage({data});
    const group = id => send({type: "decodeGroup", groupId: id, chunks: [{timestamp: id, data: []}], timestampMap: [{timestamp: id, frameNumber: id}]});
    return {messages, bitmaps, send, group, get decoder() { return decoder; }, cleanup: () => timers.forEach(clearTimeout)};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const bitmap = () => ({width: 640, height: 480, close: jest.fn()});

test("a group remains open until its final bitmap has been posted", async () => {
    const w = worker();
    try {
        await w.send({type: "configure", codec: "avc1.test"});
        await w.group(599);
        await tick(); // VideoDecoder.flush has resolved; bitmap conversion has not.
        expect(w.messages.map(m => m.type)).toEqual(["configured"]);
        w.bitmaps[0](bitmap());
        await tick();
        expect(w.messages.slice(1).map(m => [m.type, m.groupId])).toEqual([["frame", 599], ["groupFlushed", 599]]);
    } finally { w.cleanup(); }
});

test("a bitmap completing after reset cannot leak into the next group", async () => {
    const w = worker();
    try {
        await w.send({type: "configure", codec: "avc1.test"});
        await w.group(1);
        await w.send({type: "reset", codec: "avc1.test"});
        await w.group(2);
        const stale = bitmap();
        w.bitmaps[0](stale);
        await tick();
        expect(stale.close).toHaveBeenCalledTimes(1);
        expect(w.messages.filter(m => m.type === "frame" || m.type === "groupFlushed")).toEqual([]);
        w.bitmaps[1](bitmap());
        await tick();
        expect(w.messages.filter(m => m.type === "frame" || m.type === "groupFlushed").map(m => m.groupId)).toEqual([2, 2]);
    } finally { w.cleanup(); }
});

test("decoder queue progress unblocks input even before any bitmap is produced", async () => {
    const w = worker({queueOnly: true});
    try {
        await w.send({type: "configure", codec: "avc1.test"});
        const chunks = Array.from({length: 26}, (_, i) => ({timestamp: i, data: []}));
        const pending = w.send({type: "decodeGroup", groupId: 7, chunks,
            timestampMap: chunks.map(c => ({timestamp: c.timestamp, frameNumber: c.timestamp}))});
        await tick();
        expect(w.decoder.queued).toHaveLength(13);
        expect(w.bitmaps).toHaveLength(0);
        w.decoder.drainQueue();
        await tick();
        expect(w.decoder.queued).toHaveLength(26);
        await pending;
        expect(w.bitmaps).toHaveLength(26);
        for (const resolve of w.bitmaps) resolve(bitmap());
        await tick();
        expect(w.messages.filter(m => m.type === "frame")).toHaveLength(26);
        expect(w.messages.filter(m => m.type === "groupFlushed").map(m => m.groupId)).toEqual([7]);
    } finally { await w.send({type: "reset"}); w.cleanup(); }
});
