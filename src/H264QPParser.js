// H264QPParser - reads the quantization parameter (QP) of every macroblock
// from an H.264 bitstream.
//
// A browser video decoder does not give access to QP. The only way to get the
// QP of each 16x16 macroblock is to parse the macroblock layer of the
// bitstream. This module does the syntax parse only. It does not rebuild any
// pixels, so it needs no reference pictures and it is fast.
//
// QP of a macroblock = QP of the previous macroblock in the slice + mb_qp_delta
// (ITU-T H.264 clause 7.4.5). The first macroblock starts from the slice QP:
// 26 + pic_init_qp_minus26 + slice_qp_delta (clause 7.4.3). A macroblock with
// no mb_qp_delta (a skipped block, or one with no coded residual) keeps the
// running value. These are the same values that FFmpeg prints with "-debug qp".
// An I_PCM macroblock is reported as 0, as FFmpeg does.
//
// Supported: CABAC entropy coding, I / P / B slices, more than one slice per
// picture, the 8x8 transform, 4:2:0 and monochrome, all bit depths.
// Not supported (H264QPUnsupportedError): CAVLC entropy coding, interlaced
// streams (field pictures and MBAFF), 4:2:2 and 4:4:4, slice groups (FMO),
// data partitioning, SP / SI slices.
//
// This file has no Sitrec imports, so it runs in a worker and in Jest.

import {CABAC_CONTEXT_COUNT, CABAC_INIT_MN, CABAC_RANGE_LPS, CABAC_TRANS_LPS, CABAC_TRANS_MPS} from "./H264CabacTables";

export class H264QPUnsupportedError extends Error {
    constructor(reason) {
        super(reason);
        this.name = "H264QPUnsupportedError";
    }
}

// ---------------------------------------------------------------------------
// RBSP bit reader (headers). RBSP = the NAL payload with the emulation
// prevention bytes (00 00 03 -> 00 00) removed.

class RbspReader {
    constructor(buf) {
        this.buf = buf;
        this.pos = 0; // bit position
    }

    u1() {
        const p = this.pos++;
        return (this.buf[p >> 3] >> (7 - (p & 7))) & 1;
    }

    u(n) {
        let v = 0;
        while (n > 0) {
            const p = this.pos;
            const avail = 8 - (p & 7);
            const take = n < avail ? n : avail;
            const byte = this.buf[p >> 3] | 0;
            v = v * (1 << take) + ((byte >> (avail - take)) & ((1 << take) - 1));
            this.pos += take;
            n -= take;
        }
        return v;
    }

    ue() {
        let zeros = 0;
        while (this.u1() === 0) {
            zeros++;
            if (zeros > 32 || this.pos > this.buf.length * 8) throw new Error("bad Exp-Golomb code");
        }
        return zeros === 0 ? 0 : Math.pow(2, zeros) - 1 + this.u(zeros);
    }

    se() {
        const k = this.ue();
        return (k & 1) ? (k + 1) / 2 : -(k / 2);
    }

    // true when there is more data before the rbsp_stop_one_bit
    moreRbspData() {
        const buf = this.buf;
        let last = buf.length - 1;
        while (last >= 0 && buf[last] === 0) last--;
        if (last < 0) return false;
        let bit = 0;
        while (((buf[last] >> bit) & 1) === 0) bit++;
        const stopBitPos = last * 8 + (7 - bit);
        return this.pos < stopBitPos;
    }
}

function nalToRbsp(data, start, end) {
    let firstEscape = -1;
    for (let i = start + 2; i < end; i++) {
        if (data[i] === 3 && data[i - 1] === 0 && data[i - 2] === 0) {
            firstEscape = i;
            break;
        }
    }
    if (firstEscape < 0) return data.subarray(start, end);

    const out = new Uint8Array(end - start);
    let o = 0, zeros = 0;
    for (let i = start; i < end; i++) {
        const byte = data[i];
        if (zeros >= 2 && byte === 3) {
            zeros = 0;
            continue;
        }
        out[o++] = byte;
        zeros = byte === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, o);
}

// ---------------------------------------------------------------------------
// CABAC arithmetic decoder, ITU-T H.264 clause 9.3.3.2. A context state is one
// byte: (pStateIdx << 1) | valMPS.

const NEXT_STATE_MPS = new Uint8Array(128);
const NEXT_STATE_LPS = new Uint8Array(128);
for (let s = 0; s < 128; s++) {
    const pState = s >> 1;
    const mps = s & 1;
    NEXT_STATE_MPS[s] = (CABAC_TRANS_MPS[pState] << 1) | mps;
    NEXT_STATE_LPS[s] = (CABAC_TRANS_LPS[pState] << 1) | (pState === 0 ? mps ^ 1 : mps);
}

class CabacDecoder {
    constructor() {
        this.ctx = new Uint8Array(CABAC_CONTEXT_COUNT);
        this.buf = null;
        this.pos = 0;
        this.range = 0;
        this.offset = 0;
    }

    initContexts(sliceQP, variant) {
        const qp = Math.max(0, Math.min(51, sliceQP));
        for (let i = 0; i < CABAC_CONTEXT_COUNT; i++) {
            const m = CABAC_INIT_MN[(i * 4 + variant) * 2];
            const n = CABAC_INIT_MN[(i * 4 + variant) * 2 + 1];
            const pre = Math.max(1, Math.min(126, ((m * qp) >> 4) + n));
            this.ctx[i] = pre <= 63 ? ((63 - pre) << 1) : (((pre - 64) << 1) | 1);
        }
    }

    start(buf, bytePos) {
        this.buf = buf;
        this.pos = bytePos * 8;
        this.range = 510;
        this.offset = this.readBits(9);
    }

    // n <= 9. Bytes after the end of the buffer read as 0.
    readBits(n) {
        const p = this.pos;
        const b = p >> 3;
        const buf = this.buf;
        const window = (buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2];
        this.pos = p + n;
        return (window >> (24 - (p & 7) - n)) & ((1 << n) - 1);
    }

    decision(ctxIdx) {
        const ctx = this.ctx;
        const s = ctx[ctxIdx];
        const rangeLPS = CABAC_RANGE_LPS[((s >> 1) << 2) | ((this.range >> 6) & 3)];
        let range = this.range - rangeLPS;
        let bin;
        if (this.offset >= range) {
            this.offset -= range;
            range = rangeLPS;
            bin = (s ^ 1) & 1;
            ctx[ctxIdx] = NEXT_STATE_LPS[s];
        } else {
            bin = s & 1;
            ctx[ctxIdx] = NEXT_STATE_MPS[s];
        }
        if (range < 256) {
            const n = Math.clz32(range) - 23;
            this.offset = (this.offset << n) | this.readBits(n);
            range <<= n;
        }
        this.range = range;
        return bin;
    }

    bypass() {
        this.offset = (this.offset << 1) | this.readBits(1);
        if (this.offset >= this.range) {
            this.offset -= this.range;
            return 1;
        }
        return 0;
    }

    terminate() {
        this.range -= 2;
        if (this.offset >= this.range) return 1;
        if (this.range < 256) {
            const n = Math.clz32(this.range) - 23;
            this.offset = (this.offset << n) | this.readBits(n);
            this.range <<= n;
        }
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Tables

const MB_SKIP = 1, MB_INTRA = 2, MB_I16 = 4, MB_PCM = 8, MB_DIRECT = 16, MB_T8 = 32;

// position of each 4x4 luma block (in 4x4 units) inside the macroblock
const BLK_X = [0, 1, 0, 1, 2, 3, 2, 3, 0, 1, 0, 1, 2, 3, 2, 3];
const BLK_Y = [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3];

// ctxBlockCatOffset, Table 9-40. Index = ctxBlockCat 0..4.
const CBF_CAT_OFFSET = [0, 4, 8, 12, 16];
const SIG_CAT_OFFSET = [0, 15, 29, 44, 47];
const ABS_CAT_OFFSET = [0, 10, 20, 30, 39];

// Table 9-43, ctxIdxInc for an 8x8 block (frame coded)
const SIG_8x8 = [
    0, 1, 2, 3, 4, 5, 5, 4, 4, 3, 3, 4, 4, 4, 5, 5,
    4, 4, 4, 4, 3, 3, 6, 7, 7, 7, 8, 9, 10, 9, 8, 7,
    7, 6, 11, 12, 13, 11, 6, 7, 8, 9, 14, 10, 9, 8, 6, 11,
    12, 13, 11, 6, 9, 14, 10, 9, 11, 12, 13, 11, 14, 10, 12];
const LAST_8x8 = [
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
    5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8];

// Macroblock partitions as [x, y, w, h] in 4x4 units. Index: 0 = 16x16,
// 1 = 16x8, 2 = 8x16.
const MB_PARTS = [
    [[0, 0, 4, 4]],
    [[0, 0, 4, 2], [0, 2, 4, 2]],
    [[0, 0, 2, 4], [2, 0, 2, 4]],
];
// Sub-macroblock partitions. Index: 0 = 8x8, 1 = 8x4, 2 = 4x8, 3 = 4x4.
const SUB_PARTS = [
    [[0, 0, 2, 2]],
    [[0, 0, 2, 1], [0, 1, 2, 1]],
    [[0, 0, 1, 2], [1, 0, 1, 2]],
    [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]],
];

// Prediction lists used: 1 = list 0, 2 = list 1, 3 = both.
// B macroblock types 4..21 (Table 7-14), two partitions each. Index = (mb_type - 4) >> 1.
const B_PART_PRED = [[1, 1], [2, 2], [1, 2], [2, 1], [1, 3], [2, 3], [3, 1], [3, 2], [3, 3]];
// B sub-macroblock types (Table 7-18). Type 0 is B_Direct_8x8.
const B_SUB_PRED = [0, 1, 2, 3, 1, 1, 2, 2, 3, 3, 1, 2, 3];
const B_SUB_SHAPE = [0, 0, 0, 0, 1, 2, 1, 2, 1, 2, 3, 3, 3];

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// ---------------------------------------------------------------------------

export class H264QPParser {
    constructor() {
        this.spsById = new Map();
        this.ppsById = new Map();
        this.nalLengthSize = 4;
        this.cabac = new CabacDecoder();
        this.mbWidth = 0;
        this.mbHeight = 0;
        this.mbCount = 0;
    }

    // avcC = the AVCDecoderConfigurationRecord of an MP4 file (the WebCodecs
    // "description"). It holds the NAL length size and the SPS / PPS.
    setAvcC(avcC) {
        const d = avcC instanceof Uint8Array ? avcC : new Uint8Array(avcC);
        if (d.length < 7 || d[0] !== 1) throw new Error("bad avcC record");
        this.nalLengthSize = (d[4] & 3) + 1;
        let p = 5;
        const numSPS = d[p++] & 31;
        for (let i = 0; i < numSPS; i++) {
            const len = (d[p] << 8) | d[p + 1];
            p += 2;
            this.parseNal(d, p, p + len, null);
            p += len;
        }
        const numPPS = d[p++];
        for (let i = 0; i < numPPS; i++) {
            const len = (d[p] << 8) | d[p + 1];
            p += 2;
            this.parseNal(d, p, p + len, null);
            p += len;
        }
    }

    // One access unit = the coded data of one picture (one MP4 sample, one
    // EncodedVideoChunk). Length-prefixed (AVCC) and start-code (Annex B)
    // layouts are both accepted.
    //
    // Returns null if the data holds no slice. Otherwise returns:
    //   qp          Uint8Array, one value per macroblock in raster order.
    //               REUSED on the next call. Copy it to keep it.
    //   mbWidth, mbHeight
    //   decoded     number of macroblocks parsed (= mbWidth * mbHeight when complete)
    //   pictureType "I", "P" or "B"
    //   idr         true for an IDR picture
    //   sliceQPs    the start QP of each slice
    //   isReference, pocLsb, maxPocLsb   picture order count data (undefined unless
    //               pic_order_cnt_type is 0). Sitrec uses container timestamps for the
    //               display order. These are for tools that have no container.
    //   mean, min, max   over the parsed macroblocks
    parseAccessUnit(data) {
        const d = data instanceof Uint8Array ? data : new Uint8Array(data);
        const pic = {slices: 0, hasB: false, hasP: false, idr: false, sliceQPs: [], decoded: 0};
        this.sliceId = 0;
        this.pictureStarted = false;

        const nals = this.splitAvcc(d) || this.splitAnnexB(d);
        for (const [start, end] of nals) this.parseNal(d, start, end, pic);

        if (pic.slices === 0) return null;

        const qp = this.qp;
        const mbSlice = this.mbSlice;
        let sum = 0, min = 255, max = 0, n = 0;
        for (let i = 0; i < this.mbCount; i++) {
            if (mbSlice[i] < 0) continue;
            const v = qp[i];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
            n++;
        }
        return {
            qp, mbWidth: this.mbWidth, mbHeight: this.mbHeight, decoded: n,
            pictureType: pic.hasB ? "B" : (pic.hasP ? "P" : "I"),
            idr: pic.idr, sliceQPs: pic.sliceQPs,
            isReference: pic.isReference, pocLsb: pic.pocLsb, maxPocLsb: pic.maxPocLsb,
            mean: n ? sum / n : NaN, min: n ? min : NaN, max: n ? max : NaN,
        };
    }

    splitAvcc(d) {
        const size = this.nalLengthSize;
        const nals = [];
        let p = 0;
        while (p + size <= d.length) {
            let len = 0;
            for (let i = 0; i < size; i++) len = len * 256 + d[p + i];
            p += size;
            if (len === 0 || p + len > d.length) return null;
            nals.push([p, p + len]);
            p += len;
        }
        return (p === d.length && nals.length) ? nals : null;
    }

    splitAnnexB(d) {
        const nals = [];
        let start = -1;
        let i = 0;
        while (i + 2 < d.length) {
            if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
                if (start >= 0) {
                    let end = i;
                    while (end > start && d[end - 1] === 0) end--;
                    nals.push([start, end]);
                }
                start = i + 3;
                i += 3;
            } else {
                i++;
            }
        }
        if (start >= 0 && start < d.length) nals.push([start, d.length]);
        return nals;
    }

    parseNal(d, start, end, pic) {
        if (end <= start) return;
        const header = d[start];
        const nalRefIdc = (header >> 5) & 3;
        const nalType = header & 31;
        if (nalType === 7) {
            this.parseSPS(new RbspReader(nalToRbsp(d, start + 1, end)));
        } else if (nalType === 8) {
            this.parsePPS(new RbspReader(nalToRbsp(d, start + 1, end)));
        } else if ((nalType === 1 || nalType === 5) && pic) {
            this.parseSlice(new RbspReader(nalToRbsp(d, start + 1, end)), nalType, nalRefIdc, pic);
        } else if (nalType >= 2 && nalType <= 4 && pic) {
            throw new H264QPUnsupportedError("data partitioning");
        }
    }

    // --- parameter sets ------------------------------------------------------

    skipScalingList(r, size) {
        let lastScale = 8, nextScale = 8;
        for (let j = 0; j < size; j++) {
            if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256;
            lastScale = nextScale === 0 ? lastScale : nextScale;
        }
    }

    parseSPS(r) {
        const sps = {};
        sps.profileIdc = r.u(8);
        r.u(8); // constraint flags
        r.u(8); // level_idc
        sps.id = r.ue();
        sps.chromaFormatIdc = 1;
        sps.separateColourPlane = 0;
        sps.bitDepthLuma = 8;
        sps.bitDepthChroma = 8;
        if (HIGH_PROFILES.has(sps.profileIdc)) {
            sps.chromaFormatIdc = r.ue();
            if (sps.chromaFormatIdc === 3) sps.separateColourPlane = r.u1();
            sps.bitDepthLuma = 8 + r.ue();
            sps.bitDepthChroma = 8 + r.ue();
            r.u1(); // qpprime_y_zero_transform_bypass_flag
            if (r.u1()) { // seq_scaling_matrix_present_flag
                const lists = sps.chromaFormatIdc !== 3 ? 8 : 12;
                for (let i = 0; i < lists; i++) {
                    if (r.u1()) this.skipScalingList(r, i < 6 ? 16 : 64);
                }
            }
        }
        sps.log2MaxFrameNum = 4 + r.ue();
        sps.pocType = r.ue();
        if (sps.pocType === 0) {
            sps.log2MaxPocLsb = 4 + r.ue();
        } else if (sps.pocType === 1) {
            sps.deltaPicOrderAlwaysZero = r.u1();
            r.se();
            r.se();
            const cycle = r.ue();
            for (let i = 0; i < cycle; i++) r.se();
        }
        r.ue(); // max_num_ref_frames
        r.u1(); // gaps_in_frame_num_value_allowed_flag
        sps.mbWidth = r.ue() + 1;
        const heightInMapUnits = r.ue() + 1;
        sps.frameMbsOnly = r.u1();
        sps.mbaff = sps.frameMbsOnly ? 0 : r.u1();
        sps.direct8x8Inference = r.u1();
        sps.mbHeight = (2 - sps.frameMbsOnly) * heightInMapUnits;
        sps.chromaArrayType = sps.separateColourPlane ? 0 : sps.chromaFormatIdc;
        sps.qpBdOffset = 6 * (sps.bitDepthLuma - 8);
        this.spsById.set(sps.id, sps);
    }

    parsePPS(r) {
        const pps = {};
        pps.id = r.ue();
        pps.spsId = r.ue();
        pps.cabac = r.u1();
        pps.bottomFieldPicOrder = r.u1();
        pps.numSliceGroups = r.ue() + 1;
        if (pps.numSliceGroups > 1) {
            // The slice group syntax is not parsed. A slice that uses this PPS is refused.
            pps.unsupported = "slice groups (FMO)";
            this.ppsById.set(pps.id, pps);
            return;
        }
        pps.numRefIdxDefault = [r.ue() + 1, r.ue() + 1];
        pps.weightedPred = r.u1();
        pps.weightedBipredIdc = r.u(2);
        pps.picInitQp = 26 + r.se();
        r.se(); // pic_init_qs_minus26
        r.se(); // chroma_qp_index_offset
        pps.deblockingFilterControl = r.u1();
        r.u1(); // constrained_intra_pred_flag
        pps.redundantPicCnt = r.u1();
        pps.transform8x8 = 0;
        if (r.moreRbspData()) pps.transform8x8 = r.u1();
        this.ppsById.set(pps.id, pps);
    }

    // --- picture state ---------------------------------------------------------

    allocatePicture(sps) {
        if (this.mbWidth === sps.mbWidth && this.mbHeight === sps.mbHeight && this.qp) return;
        const W = this.mbWidth = sps.mbWidth;
        const H = this.mbHeight = sps.mbHeight;
        const count = this.mbCount = W * H;
        this.qp = new Uint8Array(count);
        this.mbSlice = new Int32Array(count);
        this.mbFlags = new Uint8Array(count);
        this.mbCbp = new Uint8Array(count);        // bits 0-3 luma, bits 4-5 chroma
        this.mbChromaPred = new Uint8Array(count);
        this.mbCbfDC = new Uint8Array(count);      // bit 0 luma DC, bit 1 Cb DC, bit 2 Cr DC
        this.cbfLuma = new Uint8Array(count * 16); // one per 4x4 luma block, picture raster
        this.cbfChroma = [new Uint8Array(count * 4), new Uint8Array(count * 4)];
        // |mvd| per 4x4 block: index = list * 2 + component
        this.mvdAbs = [0, 1, 2, 3].map(() => new Uint8Array(count * 16));
        // ref_idx > 0 per 8x8 block, per list
        this.refGt0 = [new Uint8Array(count * 4), new Uint8Array(count * 4)];
    }

    // Start of a picture: set every macroblock to the state of a skipped block (inter, no
    // residual, no motion data). The parse of a macroblock then writes only what is not zero.
    // One clear for each picture is much faster than a reset of each macroblock.
    clearPicture() {
        this.mbSlice.fill(-1);
        this.mbFlags.fill(0);
        this.mbCbp.fill(0);
        this.mbChromaPred.fill(0);
        this.mbCbfDC.fill(0);
        this.cbfLuma.fill(0);
        this.cbfChroma[0].fill(0);
        this.cbfChroma[1].fill(0);
        for (let k = 0; k < 4; k++) this.mvdAbs[k].fill(0);
        this.refGt0[0].fill(0);
        this.refGt0[1].fill(0);
    }

    // --- slice -----------------------------------------------------------------

    parseSlice(r, nalType, nalRefIdc, pic) {
        const firstMb = r.ue();
        const sliceTypeRaw = r.ue();
        const sliceType = sliceTypeRaw % 5; // 0 P, 1 B, 2 I, 3 SP, 4 SI
        const pps = this.ppsById.get(r.ue());
        if (!pps) throw new Error("slice refers to a missing PPS");
        if (pps.unsupported) throw new H264QPUnsupportedError(pps.unsupported);
        const sps = this.spsById.get(pps.spsId);
        if (!sps) throw new Error("PPS refers to a missing SPS");

        if (sliceType === 3 || sliceType === 4) throw new H264QPUnsupportedError("SP / SI slices");
        if (sps.chromaArrayType > 1 || sps.separateColourPlane) throw new H264QPUnsupportedError("4:2:2 / 4:4:4 chroma");
        if (!pps.cabac) throw new H264QPUnsupportedError("CAVLC entropy coding");

        r.u(sps.log2MaxFrameNum); // frame_num
        if (!sps.frameMbsOnly) {
            if (r.u1()) throw new H264QPUnsupportedError("interlaced video (field pictures)");
            if (sps.mbaff) throw new H264QPUnsupportedError("interlaced video (MBAFF)");
        }
        const idr = nalType === 5;
        if (idr) r.ue(); // idr_pic_id
        pic.isReference = nalRefIdc !== 0;
        if (sps.pocType === 0) {
            pic.pocLsb = r.u(sps.log2MaxPocLsb);
            pic.maxPocLsb = 1 << sps.log2MaxPocLsb;
            if (pps.bottomFieldPicOrder) r.se();
        } else if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
            r.se();
            if (pps.bottomFieldPicOrder) r.se();
        }
        if (pps.redundantPicCnt && r.ue() > 0) return; // a redundant picture: ignore it

        const isB = sliceType === 1;
        const isI = sliceType === 2;
        if (isB) r.u1(); // direct_spatial_mv_pred_flag
        const numRefIdx = [pps.numRefIdxDefault[0], pps.numRefIdxDefault[1]];
        if (!isI) {
            if (r.u1()) { // num_ref_idx_active_override_flag
                numRefIdx[0] = r.ue() + 1;
                if (isB) numRefIdx[1] = r.ue() + 1;
            }
            if (numRefIdx[0] > 32 || numRefIdx[1] > 32) throw new Error("bad num_ref_idx_active");
            // ref_pic_list_modification
            for (let list = 0; list < (isB ? 2 : 1); list++) {
                if (r.u1()) {
                    for (let guard = 0; ; guard++) {
                        const idc = r.ue();
                        if (idc === 3) break;
                        if (idc > 3 || guard > 66) throw new Error("bad ref_pic_list_modification");
                        r.ue();
                    }
                }
            }
            if ((pps.weightedPred && !isB) || (pps.weightedBipredIdc === 1 && isB)) {
                r.ue(); // luma_log2_weight_denom
                if (sps.chromaArrayType !== 0) r.ue();
                for (let list = 0; list < (isB ? 2 : 1); list++) {
                    for (let i = 0; i < numRefIdx[list]; i++) {
                        if (r.u1()) { r.se(); r.se(); }
                        if (sps.chromaArrayType !== 0 && r.u1()) { r.se(); r.se(); r.se(); r.se(); }
                    }
                }
            }
        }
        if (nalRefIdc !== 0) { // dec_ref_pic_marking
            if (idr) {
                r.u1();
                r.u1();
            } else if (r.u1()) {
                for (let guard = 0; ; guard++) {
                    const op = r.ue();
                    if (op === 0) break;
                    if (guard > 66) throw new Error("bad dec_ref_pic_marking");
                    if (op === 1 || op === 3) r.ue();
                    if (op === 2) r.ue();
                    if (op === 3 || op === 6) r.ue();
                    if (op === 4) r.ue();
                }
            }
        }
        const cabacInitIdc = isI ? -1 : r.ue();
        if (cabacInitIdc > 2) throw new Error("bad cabac_init_idc");
        const sliceQP = pps.picInitQp + r.se();
        if (pps.deblockingFilterControl) {
            if (r.ue() !== 1) { r.se(); r.se(); }
        }

        // First slice of the picture: clear the per-picture state.
        if (!this.pictureStarted) {
            this.allocatePicture(sps);
            this.clearPicture();
            this.pictureStarted = true;
        }

        pic.slices++;
        pic.sliceQPs.push(sliceQP + sps.qpBdOffset);
        if (isB) pic.hasB = true;
        else if (!isI) pic.hasP = true;
        if (idr) pic.idr = true;

        // slice_data(): CABAC data starts at the next byte boundary
        const cabac = this.cabac;
        cabac.initContexts(sliceQP, cabacInitIdc + 1);
        cabac.start(r.buf, (r.pos + 7) >> 3);

        this.sps = sps;
        this.pps = pps;
        this.isB = isB;
        this.isI = isI;
        this.numRefIdx = numRefIdx;
        this.qpY = sliceQP;
        this.lastDqp = 0;
        const sliceId = this.sliceId++;
        const endBit = r.buf.length * 8 + 16;

        let mbAddr = firstMb;
        for (;;) {
            if (mbAddr >= this.mbCount) throw new Error("macroblock address out of range");
            const mbX = mbAddr % this.mbWidth;
            const mbY = (mbAddr - mbX) / this.mbWidth;
            if (this.mbSlice[mbAddr] >= 0) throw new Error("macroblock coded two times in one picture");
            this.mbSlice[mbAddr] = sliceId;
            this.parseMacroblock(mbAddr, mbX, mbY, sliceId);
            if (cabac.pos > endBit) throw new Error("slice data overrun (parse lost sync)");
            mbAddr++;
            if (cabac.terminate()) break;
        }
    }

    // --- macroblock layer (CABAC) -------------------------------------------------

    parseMacroblock(mbAddr, mbX, mbY, sliceId) {
        const cabac = this.cabac;
        const flags = this.mbFlags;
        const W = this.mbWidth;
        const availA = mbX > 0 && this.mbSlice[mbAddr - 1] === sliceId;
        const availB = mbY > 0 && this.mbSlice[mbAddr - W] === sliceId;
        const flagsA = availA ? flags[mbAddr - 1] : 0;
        const flagsB = availB ? flags[mbAddr - W] : 0;
        const bdOffset = this.sps.qpBdOffset;

        if (!this.isI) {
            const inc = (availA && !(flagsA & MB_SKIP) ? 1 : 0) + (availB && !(flagsB & MB_SKIP) ? 1 : 0);
            if (cabac.decision((this.isB ? 24 : 11) + inc)) {
                flags[mbAddr] = MB_SKIP | (this.isB ? MB_DIRECT : 0);
                this.lastDqp = 0;
                this.qp[mbAddr] = this.qpY + bdOffset;
                return;
            }
        }

        // mb_type
        let intraType = -1;  // 0 = I_NxN, 1..24 = Intra 16x16, 25 = I_PCM
        let interType = -1;  // P: 0..3. B: 0..22.
        if (this.isI) {
            const inc = (availA && (flagsA & (MB_I16 | MB_PCM)) ? 1 : 0) + (availB && (flagsB & (MB_I16 | MB_PCM)) ? 1 : 0);
            intraType = this.decodeIntraMbType(3, inc, true);
        } else if (!this.isB) {
            if (cabac.decision(14) === 0) {
                if (cabac.decision(15) === 0) interType = 3 * cabac.decision(16);
                else interType = 2 - cabac.decision(17);
            } else {
                intraType = this.decodeIntraMbType(17, 0, false);
            }
        } else {
            const inc = (availA && !(flagsA & MB_DIRECT) ? 1 : 0) + (availB && !(flagsB & MB_DIRECT) ? 1 : 0);
            if (!cabac.decision(27 + inc)) {
                interType = 0;
            } else if (!cabac.decision(27 + 3)) {
                interType = 1 + cabac.decision(27 + 5);
            } else {
                let bits = cabac.decision(27 + 4) << 3;
                bits |= cabac.decision(27 + 5) << 2;
                bits |= cabac.decision(27 + 5) << 1;
                bits |= cabac.decision(27 + 5);
                if (bits < 8) interType = bits + 3;
                else if (bits === 13) intraType = this.decodeIntraMbType(32, 0, false);
                else if (bits === 14) interType = 11;
                else if (bits === 15) interType = 22;
                else interType = ((bits << 1) | cabac.decision(27 + 5)) - 4;
            }
        }

        if (intraType === 25) {
            this.parsePCM(mbAddr, mbX, mbY);
            return;
        }

        let cbpLuma, cbpChroma;
        let transform8x8 = 0;
        const isI16 = intraType > 0;
        const curIntra = intraType >= 0;

        if (curIntra) {
            flags[mbAddr] = MB_INTRA | (isI16 ? MB_I16 : 0);
            if (!isI16) {
                if (this.pps.transform8x8) {
                    transform8x8 = cabac.decision(399 + ((flagsA & MB_T8) ? 1 : 0) + ((flagsB & MB_T8) ? 1 : 0));
                }
                // prev_intra_pred_mode_flag / rem_intra_pred_mode for each block
                for (let i = transform8x8 ? 4 : 16; i > 0; i--) {
                    if (!cabac.decision(68)) {
                        cabac.decision(69);
                        cabac.decision(69);
                        cabac.decision(69);
                    }
                }
            }
            if (this.sps.chromaArrayType !== 0) {
                const inc = (availA && this.mbChromaPred[mbAddr - 1] ? 1 : 0) + (availB && this.mbChromaPred[mbAddr - W] ? 1 : 0);
                let mode = 0;
                if (cabac.decision(64 + inc)) {
                    mode = 1;
                    if (cabac.decision(64 + 3)) mode = 2 + cabac.decision(64 + 3);
                }
                this.mbChromaPred[mbAddr] = mode;
            }
        } else {
            let allSubPartsAre8x8 = true;
            const is8x8 = this.isB ? interType === 22 : interType === 3;
            if (is8x8) {
                allSubPartsAre8x8 = this.parseSubMbPred(mbAddr, mbX, mbY, sliceId);
            } else if (this.isB && interType === 0) {
                flags[mbAddr] = MB_DIRECT; // B_Direct_16x16: no motion syntax
            } else {
                this.parseMbPred(interType, mbX, mbY, sliceId);
            }
            this.interAllows8x8 = allSubPartsAre8x8
                && (!(flags[mbAddr] & MB_DIRECT) || this.sps.direct8x8Inference);
        }

        if (isI16) {
            cbpLuma = intraType > 12 ? 15 : 0;
            cbpChroma = (((intraType - 1) / 4) | 0) % 3;
        } else {
            const cbp = this.decodeCbp(mbAddr, availA, availB);
            cbpLuma = cbp & 15;
            cbpChroma = cbp >> 4;
            if (!curIntra && cbpLuma > 0 && this.pps.transform8x8 && this.interAllows8x8) {
                transform8x8 = cabac.decision(399 + ((flagsA & MB_T8) ? 1 : 0) + ((flagsB & MB_T8) ? 1 : 0));
            }
        }
        this.mbCbp[mbAddr] = cbpLuma | (cbpChroma << 4);
        if (transform8x8) flags[mbAddr] |= MB_T8;

        if (cbpLuma > 0 || cbpChroma > 0 || isI16) {
            // mb_qp_delta
            let dqp = 0;
            if (cabac.decision(60 + (this.lastDqp !== 0 ? 1 : 0))) {
                let val = 1;
                let ctx = 60 + 2;
                while (cabac.decision(ctx)) {
                    ctx = 60 + 3;
                    val++;
                    if (val > 2 * (52 + bdOffset)) throw new Error("bad mb_qp_delta");
                }
                dqp = (val & 1) ? (val + 1) >> 1 : -((val + 1) >> 1);
            }
            this.lastDqp = dqp;
            const range = 52 + bdOffset;
            this.qpY = ((this.qpY + dqp + 52 + 2 * bdOffset) % range) - bdOffset;
            this.parseResidual(mbAddr, mbX, mbY, availA, availB, curIntra, isI16, transform8x8, cbpLuma, cbpChroma);
        } else {
            this.lastDqp = 0;
        }
        this.qp[mbAddr] = this.qpY + bdOffset;
    }

    decodeIntraMbType(ctxBase, inc, intraSlice) {
        const cabac = this.cabac;
        let base = ctxBase;
        if (intraSlice) {
            if (cabac.decision(base + inc) === 0) return 0;
            base += 2;
        } else if (cabac.decision(base) === 0) {
            return 0;
        }
        if (cabac.terminate()) return 25;
        const k = intraSlice ? 1 : 0;
        let type = 1 + 12 * cabac.decision(base + 1);
        if (cabac.decision(base + 2)) type += 4 + 4 * cabac.decision(base + 2 + k);
        type += 2 * cabac.decision(base + 3 + k);
        type += cabac.decision(base + 3 + 2 * k);
        return type;
    }

    parsePCM(mbAddr, mbX, mbY) {
        const cabac = this.cabac;
        const sps = this.sps;
        // The last bit that the decoder read is the last bit of the encoder flush.
        // The PCM samples start at the next byte boundary.
        const chromaSamples = sps.chromaArrayType === 0 ? 0 : 128;
        const bits = 256 * sps.bitDepthLuma + chromaSamples * sps.bitDepthChroma;
        const bytePos = ((cabac.pos + 7) >> 3) + (bits >> 3);
        cabac.start(cabac.buf, bytePos);

        this.mbFlags[mbAddr] = MB_INTRA | MB_PCM;
        this.mbCbp[mbAddr] = 15 | (2 << 4);
        this.mbCbfDC[mbAddr] = 7;
        const W4 = this.mbWidth * 4;
        const W2 = this.mbWidth * 2;
        for (let y = 0; y < 4; y++) {
            const row = (mbY * 4 + y) * W4 + mbX * 4;
            this.cbfLuma.fill(1, row, row + 4);
        }
        for (let y = 0; y < 2; y++) {
            const row = (mbY * 2 + y) * W2 + mbX * 2;
            this.cbfChroma[0].fill(1, row, row + 2);
            this.cbfChroma[1].fill(1, row, row + 2);
        }
        this.lastDqp = 0;
        this.qp[mbAddr] = 0;
    }

    // --- motion syntax ---------------------------------------------------------------

    // ref_idx for the partition whose top-left 8x8 block is (qx, qy), picture 8x8 units
    decodeRefIdx(list, qx, qy, mbX, mbY, sliceId) {
        const cabac = this.cabac;
        const W = this.mbWidth;
        const W2 = W * 2;
        const grid = this.refGt0[list];
        let inc = 0;
        if (qx > 0 && ((qx & 1) || (mbX > 0 && this.mbSlice[mbY * W + mbX - 1] === sliceId))) {
            if (grid[qy * W2 + qx - 1]) inc += 1;
        }
        if (qy > 0 && ((qy & 1) || (mbY > 0 && this.mbSlice[(mbY - 1) * W + mbX] === sliceId))) {
            if (grid[(qy - 1) * W2 + qx]) inc += 2;
        }
        let ref = 0;
        let ctx = 54 + inc;
        while (cabac.decision(ctx)) {
            ref++;
            ctx = ref === 1 ? 54 + 4 : 54 + 5;
            if (ref >= 32) throw new Error("bad ref_idx");
        }
        return ref;
    }

    // One mvd component for the partition whose top-left 4x4 block is (bx, by), picture
    // 4x4 units. Returns |mvd|, limited to 64 (the context rule only needs "more than 32").
    decodeMvd(list, comp, bx, by, mbX, mbY, sliceId) {
        const cabac = this.cabac;
        const W = this.mbWidth;
        const W4 = W * 4;
        const grid = this.mvdAbs[list * 2 + comp];
        let sum = 0;
        if (bx > 0 && ((bx & 3) || (mbX > 0 && this.mbSlice[mbY * W + mbX - 1] === sliceId))) {
            sum += grid[by * W4 + bx - 1];
        }
        if (by > 0 && ((by & 3) || (mbY > 0 && this.mbSlice[(mbY - 1) * W + mbX] === sliceId))) {
            sum += grid[(by - 1) * W4 + bx];
        }
        const base = comp === 0 ? 40 : 47;
        if (!cabac.decision(base + (sum < 3 ? 0 : (sum > 32 ? 2 : 1)))) return 0;
        let mvd = 1;
        let ctx = base + 3;
        while (mvd < 9 && cabac.decision(ctx)) {
            if (mvd < 4) ctx++;
            mvd++;
        }
        if (mvd >= 9) {
            let k = 3;
            while (cabac.bypass()) {
                mvd += 1 << k;
                k++;
                if (k > 24) throw new Error("bad mvd");
            }
            while (k--) mvd += cabac.bypass() << k;
        }
        cabac.bypass(); // sign
        return mvd > 64 ? 64 : mvd;
    }

    fillMvd(list, comp, bx, by, w, h, value) {
        if (value === 0) return;
        const W4 = this.mbWidth * 4;
        const grid = this.mvdAbs[list * 2 + comp];
        for (let y = 0; y < h; y++) grid.fill(value, (by + y) * W4 + bx, (by + y) * W4 + bx + w);
    }

    fillRef(list, qx, qy, w, h) {
        const W2 = this.mbWidth * 2;
        const grid = this.refGt0[list];
        for (let y = 0; y < h; y++) grid.fill(1, (qy + y) * W2 + qx, (qy + y) * W2 + qx + w);
    }

    // 16x16, 16x8 and 8x16 macroblocks
    parseMbPred(interType, mbX, mbY, sliceId) {
        let shape, pred;
        if (!this.isB) {
            shape = interType; // 0 = 16x16, 1 = 16x8, 2 = 8x16
            pred = [1, 1];
        } else if (interType <= 3) {
            shape = 0;
            pred = [interType, interType]; // 1 = L0, 2 = L1, 3 = Bi
        } else {
            shape = (interType & 1) ? 2 : 1;
            pred = B_PART_PRED[(interType - 4) >> 1];
        }
        const parts = MB_PARTS[shape];
        const lists = this.isB ? 2 : 1;
        for (let list = 0; list < lists; list++) {
            if (this.numRefIdx[list] <= 1) continue;
            for (let i = 0; i < parts.length; i++) {
                if (!(pred[i] & (1 << list))) continue;
                const part = parts[i];
                const qx = mbX * 2 + (part[0] >> 1), qy = mbY * 2 + (part[1] >> 1);
                if (this.decodeRefIdx(list, qx, qy, mbX, mbY, sliceId) > 0) {
                    this.fillRef(list, qx, qy, part[2] >> 1, part[3] >> 1);
                }
            }
        }
        for (let list = 0; list < lists; list++) {
            for (let i = 0; i < parts.length; i++) {
                if (!(pred[i] & (1 << list))) continue;
                const part = parts[i];
                const bx = mbX * 4 + part[0], by = mbY * 4 + part[1];
                const mx = this.decodeMvd(list, 0, bx, by, mbX, mbY, sliceId);
                const my = this.decodeMvd(list, 1, bx, by, mbX, mbY, sliceId);
                this.fillMvd(list, 0, bx, by, part[2], part[3], mx);
                this.fillMvd(list, 1, bx, by, part[2], part[3], my);
            }
        }
    }

    // P_8x8 and B_8x8. Returns true when no sub-macroblock is smaller than 8x8
    // (one condition for transform_size_8x8_flag).
    parseSubMbPred(mbAddr, mbX, mbY, sliceId) {
        const cabac = this.cabac;
        const subShape = [0, 0, 0, 0];
        const subPred = [0, 0, 0, 0];
        let all8x8 = true;
        for (let k = 0; k < 4; k++) {
            if (!this.isB) {
                let type;
                if (cabac.decision(21)) type = 0;
                else if (!cabac.decision(22)) type = 1;
                else type = cabac.decision(23) ? 2 : 3;
                subShape[k] = type;
                subPred[k] = 1;
                if (type !== 0) all8x8 = false;
            } else {
                let type;
                if (!cabac.decision(36)) {
                    type = 0;
                } else if (!cabac.decision(37)) {
                    type = 1 + cabac.decision(39);
                } else {
                    type = 3;
                    let done = false;
                    if (cabac.decision(38)) {
                        if (cabac.decision(39)) {
                            type = 11 + cabac.decision(39);
                            done = true;
                        } else {
                            type += 4;
                        }
                    }
                    if (!done) {
                        type += 2 * cabac.decision(39);
                        type += cabac.decision(39);
                    }
                }
                subShape[k] = B_SUB_SHAPE[type];
                subPred[k] = B_SUB_PRED[type];
                if (type === 0) {
                    if (!this.sps.direct8x8Inference) all8x8 = false;
                } else if (subShape[k] !== 0) {
                    all8x8 = false;
                }
            }
        }
        const lists = this.isB ? 2 : 1;
        for (let list = 0; list < lists; list++) {
            if (this.numRefIdx[list] <= 1) continue;
            for (let k = 0; k < 4; k++) {
                if (!(subPred[k] & (1 << list))) continue;
                const qx = mbX * 2 + (k & 1), qy = mbY * 2 + (k >> 1);
                if (this.decodeRefIdx(list, qx, qy, mbX, mbY, sliceId) > 0) this.fillRef(list, qx, qy, 1, 1);
            }
        }
        for (let list = 0; list < lists; list++) {
            for (let k = 0; k < 4; k++) {
                if (!(subPred[k] & (1 << list))) continue;
                const parts = SUB_PARTS[subShape[k]];
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    const bx = mbX * 4 + (k & 1) * 2 + part[0];
                    const by = mbY * 4 + (k >> 1) * 2 + part[1];
                    const mx = this.decodeMvd(list, 0, bx, by, mbX, mbY, sliceId);
                    const my = this.decodeMvd(list, 1, bx, by, mbX, mbY, sliceId);
                    this.fillMvd(list, 0, bx, by, part[2], part[3], mx);
                    this.fillMvd(list, 1, bx, by, part[2], part[3], my);
                }
            }
        }
        return all8x8;
    }

    // --- coded block pattern -----------------------------------------------------------

    decodeCbp(mbAddr, availA, availB) {
        const cabac = this.cabac;
        const W = this.mbWidth;
        // A macroblock that is not available counts as "all luma bits set, chroma 0".
        const cbpA = availA ? this.mbCbp[mbAddr - 1] : 15;
        const cbpB = availB ? this.mbCbp[mbAddr - W] : 15;
        let cbp = 0;
        cbp |= cabac.decision(73 + ((cbpA & 2) ? 0 : 1) + ((cbpB & 4) ? 0 : 2));
        cbp |= cabac.decision(73 + ((cbp & 1) ? 0 : 1) + ((cbpB & 8) ? 0 : 2)) << 1;
        cbp |= cabac.decision(73 + ((cbpA & 8) ? 0 : 1) + ((cbp & 1) ? 0 : 2)) << 2;
        cbp |= cabac.decision(73 + ((cbp & 4) ? 0 : 1) + ((cbp & 2) ? 0 : 2)) << 3;
        if (this.sps.chromaArrayType !== 0) {
            const chromaA = cbpA >> 4, chromaB = cbpB >> 4;
            if (cabac.decision(77 + (chromaA > 0 ? 1 : 0) + (chromaB > 0 ? 2 : 0))) {
                const chroma = 1 + cabac.decision(77 + 4 + (chromaA === 2 ? 1 : 0) + (chromaB === 2 ? 2 : 0));
                cbp |= chroma << 4;
            }
        }
        return cbp;
    }

    // --- residual ------------------------------------------------------------------------

    parseResidual(mbAddr, mbX, mbY, availA, availB, curIntra, isI16, transform8x8, cbpLuma, cbpChroma) {
        const W = this.mbWidth;
        const W4 = W * 4;
        const W2 = W * 2;
        const cbfLuma = this.cbfLuma;
        // The coded_block_flag of a block in a macroblock that is not available
        // counts as 1 for an intra macroblock and 0 for an inter macroblock.
        const unavailable = curIntra ? 1 : 0;

        if (isI16) {
            const a = availA ? (this.mbCbfDC[mbAddr - 1] & 1) : unavailable;
            const b = availB ? (this.mbCbfDC[mbAddr - W] & 1) : unavailable;
            if (this.residualBlock(0, 16, a + 2 * b)) this.mbCbfDC[mbAddr] |= 1;
        }

        const lumaCat = isI16 ? 1 : 2;
        const lumaCoeffs = isI16 ? 15 : 16;
        for (let i8 = 0; i8 < 4; i8++) {
            if (!(cbpLuma & (1 << i8))) continue; // clearPicture already set these flags to 0
            if (transform8x8) {
                this.residualBlock(5, 64, -1);
                const bx = mbX * 4 + (i8 & 1) * 2, by = mbY * 4 + (i8 >> 1) * 2;
                cbfLuma[by * W4 + bx] = cbfLuma[by * W4 + bx + 1] = 1;
                cbfLuma[(by + 1) * W4 + bx] = cbfLuma[(by + 1) * W4 + bx + 1] = 1;
                continue;
            }
            for (let i4 = 0; i4 < 4; i4++) {
                const blk = i8 * 4 + i4;
                const bx = mbX * 4 + BLK_X[blk], by = mbY * 4 + BLK_Y[blk];
                const a = (BLK_X[blk] > 0 || availA) ? cbfLuma[by * W4 + bx - 1] : unavailable;
                const b = (BLK_Y[blk] > 0 || availB) ? cbfLuma[(by - 1) * W4 + bx] : unavailable;
                cbfLuma[by * W4 + bx] = this.residualBlock(lumaCat, lumaCoeffs, a + 2 * b);
            }
        }

        if (cbpChroma === 0) return;
        for (let c = 0; c < 2; c++) {
            const a = availA ? ((this.mbCbfDC[mbAddr - 1] >> (1 + c)) & 1) : unavailable;
            const b = availB ? ((this.mbCbfDC[mbAddr - W] >> (1 + c)) & 1) : unavailable;
            if (this.residualBlock(3, 4, a + 2 * b)) this.mbCbfDC[mbAddr] |= 2 << c;
        }
        if (cbpChroma !== 2) return;
        for (let c = 0; c < 2; c++) {
            const grid = this.cbfChroma[c];
            for (let blk = 0; blk < 4; blk++) {
                const cx = mbX * 2 + (blk & 1), cy = mbY * 2 + (blk >> 1);
                const a = ((blk & 1) || availA) ? grid[cy * W2 + cx - 1] : unavailable;
                const b = ((blk >> 1) || availB) ? grid[(cy - 1) * W2 + cx] : unavailable;
                grid[cy * W2 + cx] = this.residualBlock(4, 15, a + 2 * b);
            }
        }
    }

    // residual_block_cabac(). cat = ctxBlockCat. cbfInc < 0 means there is no
    // coded_block_flag in the bitstream (an 8x8 block, flag inferred as 1).
    // Returns the coded_block_flag.
    residualBlock(cat, maxNumCoeff, cbfInc) {
        const cabac = this.cabac;
        let sigBase, lastBase, absBase;
        if (cat === 5) {
            sigBase = 402;
            lastBase = 417;
            absBase = 426;
        } else {
            if (!cabac.decision(85 + CBF_CAT_OFFSET[cat] + cbfInc)) return 0;
            sigBase = 105 + SIG_CAT_OFFSET[cat];
            lastBase = 166 + SIG_CAT_OFFSET[cat];
            absBase = 227 + ABS_CAT_OFFSET[cat];
        }

        // significance map
        const lastIdx = maxNumCoeff - 1;
        let numSig = 0;
        let sawLast = false;
        for (let i = 0; i < lastIdx; i++) {
            const inc = cat === 5 ? SIG_8x8[i] : (cat === 3 && i > 2 ? 2 : i);
            if (cabac.decision(sigBase + inc)) {
                numSig++;
                const lastInc = cat === 5 ? LAST_8x8[i] : (cat === 3 && i > 2 ? 2 : i);
                if (cabac.decision(lastBase + lastInc)) {
                    sawLast = true;
                    break;
                }
            }
        }
        if (!sawLast) numSig++; // the last coefficient of the block is significant by inference

        // levels
        const gt1Max = cat === 3 ? 3 : 4;
        let eq1 = 0, gt1 = 0;
        for (let k = 0; k < numSig; k++) {
            const ctx0 = absBase + (gt1 !== 0 ? 0 : (eq1 < 3 ? 1 + eq1 : 4));
            if (!cabac.decision(ctx0)) {
                eq1++;
            } else {
                const ctxN = absBase + 5 + (gt1 < gt1Max ? gt1 : gt1Max);
                let v = 1;
                while (v < 14 && cabac.decision(ctxN)) v++;
                if (v === 14) { // Exp-Golomb suffix, bypass coded
                    let k0 = 0;
                    while (cabac.bypass()) {
                        k0++;
                        if (k0 > 24) throw new Error("bad coeff_abs_level");
                    }
                    while (k0--) cabac.bypass();
                }
                gt1++;
            }
            cabac.bypass(); // sign
        }
        return 1;
    }
}
