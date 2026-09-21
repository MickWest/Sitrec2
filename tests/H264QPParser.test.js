// H264QPParser: the QP of every macroblock, read from the H.264 bitstream.
//
// The fixture holds a small stream (I, P and B pictures, two slices in each
// picture, CABAC, QP that changes from block to block) and the QP grid that
// FFmpeg's decoder printed for each picture ("-debug qp"). The expected values
// thus do not come from the parser under test.

import fs from "fs";
import path from "path";
import {H264QPParser, H264QPUnsupportedError} from "../src/H264QPParser";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/h264qpStream.json"), "utf8"));

const bytesOf = (base64) => new Uint8Array(Buffer.from(base64, "base64"));

// Annex B (start codes) -> [NAL unit, ...]
function nalUnits(annexB) {
    const nals = [];
    let start = -1;
    for (let i = 0; i + 2 < annexB.length; i++) {
        if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
            if (start >= 0) {
                let end = i;
                while (end > start && annexB[end - 1] === 0) end--;
                nals.push(annexB.subarray(start, end));
            }
            start = i + 3;
            i += 2;
        }
    }
    if (start >= 0) nals.push(annexB.subarray(start));
    return nals;
}

// the MP4 layout: each NAL unit has a 4-byte length in front of it
function toAvcc(nals) {
    const out = new Uint8Array(nals.reduce((n, nal) => n + 4 + nal.length, 0));
    let p = 0;
    for (const nal of nals) {
        new DataView(out.buffer).setUint32(p, nal.length);
        out.set(nal, p + 4);
        p += 4 + nal.length;
    }
    return out;
}

function avcCRecord(sps, pps) {
    const out = [1, sps[1], sps[2], sps[3], 0xFF, 0xE1, sps.length >> 8, sps.length & 255, ...sps,
        1, pps.length >> 8, pps.length & 255, ...pps];
    return new Uint8Array(out);
}

describe("H264QPParser", () => {
    test("gives the same QP as FFmpeg for every macroblock (Annex B input)", () => {
        const parser = new H264QPParser();
        const types = [];
        for (const picture of fixture.pictures) {
            const result = parser.parseAccessUnit(bytesOf(picture.data));
            expect(result.mbWidth).toBe(fixture.mbWidth);
            expect(result.mbHeight).toBe(fixture.mbHeight);
            expect(result.decoded).toBe(fixture.mbWidth * fixture.mbHeight);
            expect(Array.from(result.qp)).toEqual(picture.qp);
            expect(result.pictureType).toBe(picture.type);
            types.push(result.pictureType);
        }
        // the fixture must keep its cover of the three picture types
        expect(new Set(types)).toEqual(new Set(["I", "P", "B"]));
    });

    test("gives the mean, minimum and maximum of each picture", () => {
        const parser = new H264QPParser();
        for (const picture of fixture.pictures) {
            const result = parser.parseAccessUnit(bytesOf(picture.data));
            expect(result.min).toBe(Math.min(...picture.qp));
            expect(result.max).toBe(Math.max(...picture.qp));
            expect(result.mean).toBeCloseTo(picture.qp.reduce((a, b) => a + b, 0) / picture.qp.length, 10);
            expect(result.sliceQPs.length).toBe(2);
        }
    });

    test("reads the MP4 layout: avcC parameter sets and length-prefixed NAL units", () => {
        const first = nalUnits(bytesOf(fixture.pictures[0].data));
        const sps = first.find((nal) => (nal[0] & 31) === 7);
        const pps = first.find((nal) => (nal[0] & 31) === 8);
        const parser = new H264QPParser();
        parser.setAvcC(avcCRecord(sps, pps));
        for (const picture of fixture.pictures) {
            // an MP4 sample holds the slices only: the parameter sets are in the avcC record
            const slices = nalUnits(bytesOf(picture.data)).filter((nal) => (nal[0] & 31) === 1 || (nal[0] & 31) === 5);
            const result = parser.parseAccessUnit(toAvcc(slices));
            expect(Array.from(result.qp)).toEqual(picture.qp);
        }
    });

    test("returns null for data with no slice", () => {
        const first = nalUnits(bytesOf(fixture.pictures[0].data));
        const parameterSets = first.filter((nal) => (nal[0] & 31) === 7 || (nal[0] & 31) === 8);
        expect(new H264QPParser().parseAccessUnit(toAvcc(parameterSets))).toBeNull();
    });

    test("refuses CAVLC entropy coding with H264QPUnsupportedError", () => {
        const parser = new H264QPParser();
        expect(() => parser.parseAccessUnit(bytesOf(fixture.cavlcPicture))).toThrow(H264QPUnsupportedError);
    });
});
