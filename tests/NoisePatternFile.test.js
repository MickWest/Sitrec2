import {noisePatternSourceFromPackets, isNoisePatternVideoName, normalizeNoisePatternFolderLimit} from "../src/videoNoisePattern/NoisePatternFile";

test("demux adapter preserves B-frame decode order and maps timestamps to displayed frames", () => {
    const packets = [
        {timestamp: 0, duration: 1 / 30, type: "key", data: Uint8Array.of(1, 2)},
        {timestamp: 2 / 30, duration: 1 / 30, type: "delta", data: Uint8Array.of(3)},
        {timestamp: 1 / 30, duration: 1 / 30, type: "delta", data: Uint8Array.of(4)},
        {timestamp: 3 / 30, duration: 1 / 30, type: "key", data: Uint8Array.of(5)},
    ];
    const source = noisePatternSourceFromPackets({codec: "avc1.640028"}, packets, "bframes.mp4");
    expect(source.groups).toEqual([{frame: 0}, {frame: 3}]);
    expect(source.chunks.map(c => source.timestampToChunkIndex.get(c.timestamp))).toEqual([0, 2, 1, 3]);
    expect(source.chunks[1].timestamp).toBe(66667);
    const buffer = new ArrayBuffer(2);
    source.chunks[0].copyTo(buffer);
    expect([...new Uint8Array(buffer)]).toEqual([1, 2]);
});

test("recognizes video candidates without selecting images, metadata or audio", () => {
    expect(["a.MP4", "b.mov", "c.webm", "d.m2ts"].every(isNoisePatternVideoName)).toBe(true);
    expect(["a.jpg", "b.mp4.txt", "c.m4a", "d.json"].some(isNoisePatternVideoName)).toBe(false);
});

test("folder limit defaults to two minutes and bounds invalid values", () => {
    for (const value of [undefined, null, "", "bad", 0, -2]) expect(normalizeNoisePatternFolderLimit(value)).toBe(2);
    expect(normalizeNoisePatternFolderLimit("0.5")).toBe(0.5);
    expect(normalizeNoisePatternFolderLimit(999)).toBe(120);
});
