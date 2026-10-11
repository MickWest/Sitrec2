let mockPackets, mockConfig, mockDispose, mockJob, mockSession, mockDuration;
jest.mock("mediabunny", () => ({
    ALL_FORMATS: [], BlobSource: class {}, BufferSource: class {},
    Input: class {
        async getPrimaryVideoTrack() { return {getDecoderConfig: async () => mockConfig,
            getFirstTimestamp: async () => 0, getDurationFromMetadata: async () => mockDuration}; }
        dispose() { mockDispose(); }
    },
    EncodedPacketSink: class { async *packets() { yield* mockPackets; } },
}));
jest.mock("../src/videoNoisePattern/NoisePatternJob", () => ({
    NOISE_PATTERN_CACHE_LIMIT: 384 * 1024 * 1024,
    estimateFeatureBytes: (width, frames) => width * frames,
    createNoisePatternWorkerSession: () => mockSession,
    startNoisePatternJob: jest.fn(() => mockJob),
}));
import {analyzeNoisePatternFile, readNoisePatternFile} from "../src/videoNoisePattern/NoisePatternFile";
import {startNoisePatternJob} from "../src/videoNoisePattern/NoisePatternJob";

beforeEach(() => {
    mockPackets = [{data: Uint8Array.of(1), type: "key", timestamp: 0, duration: 1 / 30, byteLength: 1}];
    mockConfig = {codec: "avc1.640028", codedWidth: 640};
    mockDuration = 1;
    mockDispose = jest.fn();
    mockSession = {hooks: {cache: false}, dispose: jest.fn()};
    mockJob = {promise: Promise.resolve({status: "done"}), cancel: jest.fn()};
    startNoisePatternJob.mockClear();
});
afterEach(() => { delete global.VideoDecoder; });
const file = {name: "test.mp4", arrayBuffer: async () => new ArrayBuffer(1)};

test("prefix analysis releases the demuxer and its own workers", async () => {
    const result = await analyzeNoisePatternFile(file, {frames: "ab", range: {from: 1, to: 2}, detail: 8});
    expect(result.status).toBe("done");
    expect(startNoisePatternJob.mock.calls[0][1]).toMatchObject({frames: "all", range: {from: 0, to: 0}});
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
});

test("unsupported codecs are errors and still release demuxer resources", async () => {
    global.VideoDecoder = {isConfigSupported: async () => ({supported: false})};
    await expect(readNoisePatternFile(file, {})).rejects.toThrow("does not support avc1.640028");
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(startNoisePatternJob).not.toHaveBeenCalled();
});

test("memory budgets automatically reduce the region to a complete GOP and analyze it", async () => {
    mockConfig.codedWidth = 100 * 1024 * 1024;
    mockDuration = 5;
    mockPackets = Array.from({length: 5}, (_, i) => ({data: Uint8Array.of(i), type: i % 2 === 0 ? "key" : "delta", timestamp: i, duration: 1, byteLength: 1}));
    const result = await analyzeNoisePatternFile(file, {});
    expect(result.scan).toMatchObject({autoReduced: true, capped: true, analysisFrames: 2, analyzedSeconds: 2, limitMinutes: 2});
    expect(startNoisePatternJob.mock.calls[0][0].chunks).toHaveLength(2);
    expect(startNoisePatternJob.mock.calls[0][1].range).toEqual({from: 0, to: 1});
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
});

test("two-minute limit keeps B-frame reference packets but only analyzes timestamps before the cutoff", async () => {
    mockDuration = 240;
    mockPackets = [0, 119, 121, 119.5, 122, 123].map((timestamp, i) => ({
        data: Uint8Array.of(i), type: i === 0 || i === 4 ? "key" : "delta", timestamp, duration: 0.5, byteLength: 1,
    }));
    const result = await analyzeNoisePatternFile(file, {});
    const [source, options] = startNoisePatternJob.mock.calls[0];
    expect(source.chunks).toHaveLength(4);
    expect(source.chunks.map(c => source.timestampToChunkIndex.get(c.timestamp))).toEqual([0, 1, 3, 2]);
    expect(options.range).toEqual({from: 0, to: 2});
    expect(result.scan).toMatchObject({limitMinutes: 2, analysisFrames: 3, capped: true, autoReduced: false, analyzedSeconds: 120});
});

test("the encoded-byte budget also reduces a single-GOP prefix without failing", async () => {
    mockDuration = 5;
    mockPackets = Array.from({length: 5}, (_, i) => ({data: Uint8Array.of(i), type: i === 0 ? "key" : "delta", timestamp: i, duration: 1, byteLength: 256 * 1024 * 1024}));
    const source = await readNoisePatternFile(file, {});
    expect(source.chunks).toHaveLength(2);
    expect(source.scan).toMatchObject({autoReduced: true, analysisFrames: 2, analyzedSeconds: 2});
});

test("stop cancels both CPU and GPU work immediately and removes the abort listener", async () => {
    const controller = new AbortController();
    let resolve;
    mockJob.promise = new Promise(r => { resolve = r; });
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const promise = analyzeNoisePatternFile(file, {}, {signal: controller.signal});
    while (!startNoisePatternJob.mock.calls.length) await new Promise(r => setTimeout(r, 0));
    controller.abort();
    expect(mockJob.cancel).toHaveBeenCalledTimes(1);
    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
    resolve({status: "stopped"});
    await expect(promise).rejects.toMatchObject({name: "AbortError"});
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(mockSession.dispose).toHaveBeenCalledTimes(2);
});
