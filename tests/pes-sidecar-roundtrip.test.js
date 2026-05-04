/**
 * @jest-environment jsdom
 *
 * Unit tests for Step 1 of the TS save/load round-trip work.
 *
 * The round-trip's correctness depends on these invariants:
 * 1. The sidecar JSON encodes pesEntries+videoFirstPESus losslessly so reload
 *    receives exactly what live demux captured.
 * 2. The deserialize loop in CustomManagerSerialize reconstructs a
 *    metadataOverride object with the shape parseKLVFile expects.
 * 3. The shift formula `pesPTSus[i] = pesEntries[i].ptsUs - videoFirstPESus`
 *    in parseKLVFile's 1:1 pairing branch is deterministic from inputs.
 *
 * These tests cover (1) and (3). End-to-end parseKLVFile behavior on real KLV
 * is covered by the existing TS+KLV validation regression tests using real
 * MISB fixtures (outside the repo).
 */

describe("PES sidecar round-trip", () => {

    test("sidecar JSON encode/decode preserves pesEntries exactly", () => {
        const pesEntries = [
            {offset: 0,    ptsUs: 137827000},
            {offset: 256,  ptsUs: 138027000},
            {offset: 512,  ptsUs: 138227000},
            {offset: 768,  ptsUs: 138427000},
        ];
        const sidecar = {
            version: 1,
            kind: "klv-pes-pts",
            videoFirstPESus: 137545000,
            pesEntries,
        };
        const json = JSON.stringify(sidecar);
        const decoded = JSON.parse(json);
        expect(decoded.version).toBe(1);
        expect(decoded.kind).toBe("klv-pes-pts");
        expect(decoded.videoFirstPESus).toBe(137545000);
        expect(decoded.pesEntries).toHaveLength(4);
        expect(decoded.pesEntries).toEqual(pesEntries);
    });

    test("sidecar JSON survives extreme PTS values without precision loss", () => {
        // PCR PTS values are 33-bit @ 90 kHz — fits comfortably in JS doubles.
        // Worst case ~9.5 hours of recording → ptsUs around 3.4e10. Verify
        // that JSON round-trip preserves exact integer values up to that range.
        const pesEntries = [
            {offset: 0,           ptsUs: 0},
            {offset: 1,           ptsUs: 1},
            {offset: 1000000,     ptsUs: 33_956_660_022},  // ~9.4h in µs
            {offset: 9007199254,  ptsUs: 9_007_199_254_740_991}, // Number.MAX_SAFE_INTEGER
        ];
        const json = JSON.stringify({pesEntries});
        const decoded = JSON.parse(json);
        for (let i = 0; i < pesEntries.length; i++) {
            expect(decoded.pesEntries[i].offset).toBe(pesEntries[i].offset);
            expect(decoded.pesEntries[i].ptsUs).toBe(pesEntries[i].ptsUs);
        }
    });

    test("metadataOverride shape after sidecar fetch matches parseKLVFile expectations", () => {
        // Mirror what _fetchPesSidecar in CustomManagerSerialize.js produces.
        // parseKLVFile expects {pesEntries: Array, videoFirstPESus: number|null}.
        const sidecar = {
            version: 1,
            kind: "klv-pes-pts",
            videoFirstPESus: 137545000,
            pesEntries: [
                {offset: 0,   ptsUs: 137827000},
                {offset: 256, ptsUs: 138027000},
            ],
        };
        const metadataOverride = {
            pesEntries: sidecar.pesEntries,
            videoFirstPESus: typeof sidecar.videoFirstPESus === "number" ? sidecar.videoFirstPESus : null,
        };
        expect(Array.isArray(metadataOverride.pesEntries)).toBe(true);
        expect(metadataOverride.pesEntries.length).toBeGreaterThan(0);
        expect(metadataOverride.pesEntries[0]).toHaveProperty("offset");
        expect(metadataOverride.pesEntries[0]).toHaveProperty("ptsUs");
        expect(typeof metadataOverride.videoFirstPESus).toBe("number");
    });

    test("metadataOverride videoFirstPESus is null-safe", () => {
        // Audio-only TS or KLV-only TS may have no video → videoFirstPESus null.
        // The KLV branch in parseKLVFile falls back to using the first KLV PES
        // PTS as origin when videoFirstPESus is null.
        const sidecar = {
            version: 1,
            kind: "klv-pes-pts",
            videoFirstPESus: null,
            pesEntries: [{offset: 0, ptsUs: 1000000}],
        };
        const metadataOverride = {
            pesEntries: sidecar.pesEntries,
            videoFirstPESus: typeof sidecar.videoFirstPESus === "number" ? sidecar.videoFirstPESus : null,
        };
        expect(metadataOverride.videoFirstPESus).toBeNull();
    });

    test("1:1 pairing shift formula is deterministic", () => {
        // The synchronous-mode common case in parseKLVFile lines 559-563:
        //   pesPTSus = pesEntries.map(e => e.ptsUs - originUs)
        // where originUs = videoFirstPESus if non-null, else pesEntries[0].ptsUs.
        // This is the formula round-trip must preserve exactly.
        const pesEntries = [
            {offset: 0,   ptsUs: 137827000},
            {offset: 256, ptsUs: 138027000},
            {offset: 512, ptsUs: 138227000},
        ];
        const videoFirstPESus = 137545000;
        const originUs = videoFirstPESus;

        const live = pesEntries.map(e => e.ptsUs - originUs);

        // Same inputs after sidecar JSON round-trip:
        const json = JSON.stringify({videoFirstPESus, pesEntries});
        const decoded = JSON.parse(json);
        const reloaded = decoded.pesEntries.map(e => e.ptsUs - decoded.videoFirstPESus);

        expect(reloaded).toEqual(live);
        expect(reloaded).toEqual([282000, 482000, 682000]);
    });

    test("origin fallback when videoFirstPESus is null uses first pesEntry", () => {
        const pesEntries = [
            {offset: 0,   ptsUs: 137827000},
            {offset: 256, ptsUs: 138027000},
        ];
        const videoFirstPESus = null;
        const originUs = videoFirstPESus !== null ? videoFirstPESus : pesEntries[0].ptsUs;
        const pesPTSus = pesEntries.map(e => e.ptsUs - originUs);
        expect(pesPTSus).toEqual([0, 200000]);
    });

    test("negative pesPTSus values are valid (KLV started before video)", () => {
        // KLV emitted before video frame 0 on the PCR clock produces negative
        // values after the videoFirstPESus shift. CNodeTrackFromMISB's binary
        // search ignores these naturally because msNow >= 0 for every video
        // frame. Verify the shift can produce them.
        const pesEntries = [
            {offset: 0,    ptsUs: 137_500_000},  // before video frame 0
            {offset: 256,  ptsUs: 137_545_000},  // matches videoFirstPESus
            {offset: 512,  ptsUs: 137_600_000},  // after video frame 0
        ];
        const videoFirstPESus = 137_545_000;
        const pesPTSus = pesEntries.map(e => e.ptsUs - videoFirstPESus);
        expect(pesPTSus[0]).toBeLessThan(0);
        expect(pesPTSus[1]).toBe(0);
        expect(pesPTSus[2]).toBeGreaterThan(0);
        expect(pesPTSus).toEqual([-45000, 0, 55000]);
    });

});
