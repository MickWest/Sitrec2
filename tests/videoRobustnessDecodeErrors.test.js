import vm from "node:vm";
import {VideoDecodeWorkerManager} from "../src/CVideoDecodeWorker";
import {CVideoWebCodecBase} from "../src/CVideoWebCodecBase";
import {showError} from "../src/showError";

jest.mock("../src/Globals", () => ({Globals: {settings: {}}, Sit: {}, infoDiv: {}, setRenderOne: jest.fn()}));
jest.mock("../src/CVideoAndAudio", () => ({CVideoAndAudio: class {}}));
jest.mock("../src/utils", () => ({}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/configUtils", () => ({isAdmin: () => false, isLocal: false}));
jest.mock("../src/showError", () => ({showError: jest.fn(), showErrorOnce: jest.fn()}));

let source;
const saved = {};
beforeAll(() => {
    Object.assign(saved, {Blob: global.Blob, Worker: global.Worker, document: global.document, createObjectURL: URL.createObjectURL});
    global.Blob = class { constructor(parts) { source = parts.join(""); } };
    global.Worker = class {};
    URL.createObjectURL = () => "blob:worker-test";
    new VideoDecodeWorkerManager().init();
    // _onAllDecodeFailed draws its message on a canvas
    global.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};
});
afterAll(() => {
    Object.assign(global, {Blob: saved.Blob, Worker: saved.Worker, document: saved.document});
    URL.createObjectURL = saved.createObjectURL;
});
beforeEach(() => showError.mockClear());

const tick = () => new Promise(resolve => setImmediate(resolve));

// Runs the worker source with a VideoDecoder that queues chunks without output,
// and reports an unsupported config asynchronously, after configure() returns.
function runWorker(unsupported = () => false, now = () => performance.now()) {
    const decoders = [], posted = [], timers = [];
    const self = {postMessage: m => posted.push(m)};
    class Decoder {
        constructor({error}) { decoders.push(this); this.error = error; this.state = "unconfigured"; this.decodeQueueSize = 0; }
        configure(config) {
            this.state = "configured";
            if (unsupported(config)) setImmediate(() => this.fail("NotSupportedError"));
        }
        decode() { this.decodeQueueSize++; }
        flush() { return new Promise((resolve, reject) => { this.rejectFlush = reject; }); }
        // As in WebCodecs: pending flushes reject, then the error callback runs.
        fail(name) {
            if (this.state === "closed") return;
            this.state = "closed";
            const e = Object.assign(new Error(name + " from decoder"), {name});
            this.rejectFlush?.(e);
            this.error(e);
        }
        reset() {}
        close() { this.state = "closed"; }
    }
    vm.runInNewContext(source, {self, VideoDecoder: Decoder, EncodedVideoChunk: class { constructor(c) { Object.assign(this, c); } },
        createImageBitmap: async frame => frame, performance: {now}, clearTimeout,
        setTimeout: (...args) => { const timer = setTimeout(...args); timers.push(timer); return timer; }});
    const send = data => self.onmessage({data});
    const group = (id, count) => {
        const chunks = Array.from({length: count}, (_, i) => ({timestamp: i, data: []}));
        send({type: "decodeGroup", groupId: id, chunks, timestampMap: chunks.map(c => ({timestamp: c.timestamp, frameNumber: c.timestamp}))});
    };
    return {self, decoders, posted, send, group, cleanup: () => timers.forEach(clearTimeout)};
}

function makeVideo(frameCount) {
    const chunks = Array.from({length: frameCount}, (_, i) => ({
        timestamp: i * 1000, type: i === 0 ? "key" : "delta", duration: 1000, byteLength: 4, copyTo() {},
    }));
    const group = {frame: 0, length: frameCount, pending: 0, loaded: false, index: 0, timestamp: 0};
    const v = Object.assign(Object.create(CVideoWebCodecBase.prototype), {
        filename: "clip.mov", videoSpeed: 1, effectiveRotation: 0, isAudioActive: () => false,
    });
    v.initializeCommonVariables();
    v.chunks = chunks;
    v.groups = [group];
    v.timestampToChunkIndex = new Map(chunks.map((c, i) => [c.timestamp, i]));
    return {v, group};
}

// Wires a video's real worker manager to the worker source through message queues.
function connect(v, unsupported) {
    const w = runWorker(unsupported);
    const toWorker = [];
    const savedWorker = global.Worker;
    global.Worker = class { postMessage(m) { toWorker.push(m); } };
    try { v.initWorker(); } finally { global.Worker = savedWorker; }
    const port = v._workerManager.worker;
    const toMain = [];
    w.self.postMessage = m => { w.posted.push(m); toMain.push(m); };
    // Each round is one render (which requests the group again) and one exchange of messages.
    const pump = async (rounds, render = () => {}) => {
        for (let i = 0; i < rounds; i++) {
            render();
            while (toWorker.length) w.send(toWorker.shift());
            await tick();
            while (toMain.length) port.onmessage({data: toMain.shift()});
        }
    };
    return {...w, toWorker, pump, cleanup: () => { w.cleanup(); v._clearAllDecodeTimers(); }};
}

test("an unsupported codec fails the video with a message instead of recreating the decoder forever", async () => {
    const {v, group} = makeVideo(2);
    const w = connect(v, config => config.codec.startsWith("hvc1"));
    try {
        v.configureWorker({codec: "hvc1.1.6.L93.B0"});
        await w.pump(30, () => v.requestGroup(group));
        // One decoder for hardware, one for the software fallback, then give up
        expect(w.decoders).toHaveLength(2);
        expect(w.posted.filter(m => m.type === "error").map(m => m.fatal)).toEqual([true, true]);
        expect(v._softwareDecoderMode).toBe(true);
        expect(v._allGroupsFailed).toBe(true);
        expect(v.errorImage).toBeTruthy();
        expect(showError).toHaveBeenCalledWith(expect.stringContaining("hvc1"));
        expect(v._activeGroupMap.size).toBe(0);
        expect(v._workerManager.busy).toBe(false);
    } finally { w.cleanup(); }
});

test("a decoder error mid-group reaches the main thread at once instead of after the 45s timeout", async () => {
    const {v, group} = makeVideo(26);
    const w = connect(v);
    try {
        v.configureWorker({codec: "avc1.640028"});
        await w.pump(2, () => v.requestGroup(group));
        // The worker waits on backpressure with half the group queued
        expect(w.decoders[0].decodeQueueSize).toBe(13);
        expect(v._activeGroupMap.size).toBe(1);
        w.decoders[0].fail("EncodingError");
        await w.pump(1);
        expect(w.posted.filter(m => m.type === "groupError").map(m => m.groupId)).toEqual([0]);
        expect(w.posted.some(m => m.type === "groupFlushed")).toBe(false);
        expect(v._activeGroupMap.has(0)).toBe(false);
        // The failure counts, so it falls back to software (and is bounded from there)
        expect(v._softwareDecoderMode).toBe(true);
        expect(w.toWorker.map(m => [m.type, m.hardwareAcceleration])).toEqual([["configure", "prefer-software"]]);
    } finally { w.cleanup(); }
});

test("a fatal error from the hardware decoder being replaced does not fail the software decoder", async () => {
    const {v, group} = makeVideo(26);
    const w = connect(v);
    try {
        v.configureWorker({codec: "avc1.640028"});
        await w.pump(2, () => v.requestGroup(group));
        w.decoders[0].fail("OperationError");
        await w.pump(1);
        expect(w.toWorker.map(m => [m.type, m.hardwareAcceleration])).toEqual([["configure", "prefer-software"]]);
        // Before the worker reaches that configure, the recreated hardware decoders fail too
        w.decoders[1].fail("OperationError");
        w.decoders[2].fail("OperationError");
        await w.pump(3, () => v.requestGroup(group));
        expect(w.posted.filter(m => m.type !== "log").map(m => m.fatal ? "fatal" : m.type))
            .toEqual(["configured", "groupError", "error", "error", "fatal", "configured"]);
        expect(v._softwareDecoderMode).toBe(true);
        expect(v._allGroupsFailed).toBe(false);
        expect(showError).not.toHaveBeenCalled();
        // The group is decoding again, on the software decoder
        expect(v._workerManager.configured).toBe(true);
        expect(w.decoders).toHaveLength(4);
        expect(w.decoders[3].decodeQueueSize).toBe(13);
        expect(v._activeGroupMap.size).toBe(1);
    } finally { w.send({type: "reset"}); w.cleanup(); }
});

test.each([[26, "backpressure"], [2, "flush"]])("a decoder error answers a %i-chunk group waiting on %s exactly once", async count => {
    const w = runWorker();
    try {
        w.send({type: "configure", codec: "avc1.640028"});
        w.group(5, count);
        await tick();
        w.decoders[0].fail("EncodingError");
        await tick();
        await tick();
        expect(w.posted.filter(m => m.type === "groupError" || m.type === "groupFlushed"))
            .toEqual([{type: "groupError", groupId: 5, message: "EncodingError from decoder"}]);
        // Recovered: the next group decodes on a new decoder
        expect(w.decoders).toHaveLength(2);
        expect(w.decoders[1].state).toBe("configured");
    } finally { w.send({type: "reset"}); w.cleanup(); }
});

test("a decoder that fails again as soon as it is recreated is left down until the next configure", async () => {
    const w = runWorker();
    try {
        w.send({type: "configure", codec: "avc1.640028"});
        for (let i = 0; i < 5; i++) w.decoders[w.decoders.length - 1].fail("OperationError");
        expect(w.decoders).toHaveLength(3);
        expect(w.posted.filter(m => m.type === "error").map(m => !!m.fatal)).toEqual([false, false, true]);
        w.group(1, 2);
        expect(w.decoders).toHaveLength(3);
        expect(w.posted.at(-1)).toEqual({type: "groupError", groupId: 1, message: "Decoder not configured"});
        w.send({type: "configure", codec: "avc1.640028", hardwareAcceleration: "prefer-software"});
        expect(w.decoders).toHaveLength(4);
        expect(w.posted.at(-1)).toEqual({type: "configured", hardwareAcceleration: "prefer-software"});
    } finally { w.cleanup(); }
});

// Chrome reclaims an idle decoder (e.g. a paused video in a background tab)
// about every 30s, and several at once under codec pressure.
test.each([["QuotaExceededError", 0], ["OperationError", 6000]])("%s errors %ims apart keep recovering the decoder", (name, gap) => {
    let now = 0;
    const w = runWorker(undefined, () => now);
    try {
        w.send({type: "configure", codec: "avc1.640028"});
        for (let i = 0; i < 5; i++) {
            now += gap;
            w.decoders[w.decoders.length - 1].fail(name);
        }
        expect(w.decoders).toHaveLength(6);
        expect(w.decoders[5].state).toBe("configured");
        expect(w.posted.filter(m => m.type === "error").map(m => !!m.fatal)).toEqual(Array(5).fill(false));
    } finally { w.cleanup(); }
});

test("a fatal error during a group carries the group, so the manager frees it", () => {
    const onError = jest.fn();
    const manager = new VideoDecodeWorkerManager(null, null, onError);
    Object.assign(manager, {configured: true, busy: true});
    manager._handleMessage({type: "error", fatal: true, name: "NotSupportedError", message: "unsupported", groupId: 3});
    expect(manager.configured).toBe(false);
    expect(manager.busy).toBe(false);
    expect(onError).toHaveBeenCalledWith("unsupported", 3, true);
});

test("a fatal error that arrives while a configure is pending only frees its group", () => {
    const onError = jest.fn();
    const manager = new VideoDecodeWorkerManager(null, null, onError);
    Object.assign(manager, {configured: false, busy: true});
    manager._handleMessage({type: "error", fatal: true, name: "OperationError", message: "old decoder", groupId: 3});
    expect(manager.busy).toBe(false);
    expect(onError).toHaveBeenCalledWith("old decoder", 3);
    manager._handleMessage({type: "configured", hardwareAcceleration: "prefer-software"});
    expect(manager.configured).toBe(true);
});

test("a group that times out counts as a failure, so it is not re-requested forever", () => {
    jest.useFakeTimers();
    try {
        const {v, group} = makeVideo(2);
        v._workerManager = {configured: true, busy: false, decodeGroup() { this.busy = true; return true; }};
        let dispatched = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
            const before = v._groupIdCounter;
            v.requestGroup(group);
            if (v._groupIdCounter > before) dispatched++;
            jest.advanceTimersByTime(45000);
        }
        expect(dispatched).toBe(3);
        expect(group._decodeFailures).toBe(3);
        expect(group._permanentlyFailed).toBe(true);
    } finally { jest.useRealTimers(); }
});
