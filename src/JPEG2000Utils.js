/**
 * JPEG2000Utils.js - Decode JPEG 2000 files using OpenJPEG WebAssembly
 *
 * Uses @cornerstonejs/codec-openjpeg (WASM port of OpenJPEG) for robust decoding.
 *
 * OpenJPEG handles:
 *  - Inverse MCT (RCT/ICT) when codestream has MCT=1
 *  - cdef box component reordering (JP2 containers)
 *
 * OpenJPEG does NOT handle:
 *  - sYCC→RGB color conversion (colr box EnumCS=18)
 *  - That's the application's responsibility (per the JPEG 2000 spec)
 *
 * So we detect sYCC from either:
 *  - JP2 colr box (EnumCS=18) — for standalone JP2 files
 *  - NITF IREP field (YCbCr601) — for NITF-wrapped J2K codestreams
 * and apply the conversion ourselves, with a Cb-mean heuristic to catch
 * mislabeled files that declare sYCC but actually contain RGB data.
 *
 * The WASM module is loaded lazily on first use and cached.
 * The .wasm file is copied to libs/openjpeg/ by webpackCopyPatterns.js.
 */

import {createImageFromArrayBuffer} from "./FileUtils";

let _openjpegWASM = null;
let _openjpegJS = null;

/**
 * Lazily load and cache the OpenJPEG WASM module.
 * The Emscripten-generated JS is IIFE/UMD, loaded via script tag.
 */
async function getOpenJPEGWASM() {
    if (_openjpegWASM) return _openjpegWASM;

    if (typeof window.OpenJPEGWASM === 'undefined') {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = './libs/openjpeg/openjpegwasm_decode.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load OpenJPEG WASM'));
            document.head.appendChild(script);
        });
    }

    _openjpegWASM = await window.OpenJPEGWASM({
        locateFile: (filename) => `./libs/openjpeg/${filename}`,
        print: () => {},       // suppress [INFO] log spam
        printErr: (msg) => {   // keep [ERROR] messages
            if (msg.includes('[ERROR]')) console.warn('OpenJPEG:', msg);
        },
    });

    return _openjpegWASM;
}

/**
 * Lazily load and cache the OpenJPEG asm.js (pure JavaScript) module.
 * Used as a fallback when the WASM decoder hits a runtime error
 * (e.g. "function signature mismatch" on certain J2K codestreams).
 */
async function getOpenJPEGJS() {
    if (_openjpegJS) return _openjpegJS;

    if (typeof window.OpenJPEGJS === 'undefined') {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = './libs/openjpeg/openjpegjs_decode.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load OpenJPEG JS fallback'));
            document.head.appendChild(script);
        });
    }

    _openjpegJS = await window.OpenJPEGJS({
        print: () => {},
        printErr: (msg) => {
            if (msg.includes('[ERROR]')) console.warn('OpenJPEG:', msg);
        },
    });

    return _openjpegJS;
}

/**
 * Parse JP2 container colr box to detect sYCC color space.
 * Returns EnumCS (16=sRGB, 18=sYCC, etc.) or null for raw J2K codestreams.
 */
function getJP2EnumCS(bytes) {
    if (bytes.length < 12 || bytes[4] !== 0x6A || bytes[5] !== 0x50) return null; // not JP2

    let pos = 0;
    const limit = Math.min(bytes.length, 1024);
    while (pos < limit - 8) {
        const boxLen = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        const boxType = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        if (boxLen < 8 || boxLen > bytes.length - pos) break;

        if (boxType === 'colr' && boxLen >= 15 && bytes[pos + 8] === 1) {
            return (bytes[pos + 11] << 24) | (bytes[pos + 12] << 16) |
                   (bytes[pos + 13] << 8) | bytes[pos + 14];
        }

        pos += (boxType === 'jp2h') ? 8 : boxLen;
    }
    return null;
}

/**
 * Extract TRC (Tone Reproduction Curve) LUTs from an ICC profile embedded
 * in a JP2 colr box (method=2). Returns an array of 3 LUTs [rTRC, gTRC, bTRC],
 * each a Uint16Array of values 0-65535, or null if no ICC profile / no curves.
 */
function extractICCTRCs(bytes) {
    if (bytes.length < 12 || bytes[4] !== 0x6A || bytes[5] !== 0x50) return null;

    // Find colr box with method=2 (ICC profile)
    let pos = 0;
    let profileStart = -1, profileLen = 0;
    const limit = Math.min(bytes.length, 50000); // ICC profiles can be large
    while (pos < limit - 8) {
        const boxLen = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        const boxType = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        if (boxLen < 8 || boxLen > bytes.length - pos) break;

        if (boxType === 'colr' && bytes[pos + 8] === 2) {
            profileStart = pos + 11; // skip box header(8) + method(1) + prec(1) + approx(1)
            profileLen = boxLen - 11;
            break;
        }
        pos += (boxType === 'jp2h') ? 8 : boxLen;
    }
    if (profileStart < 0) return null;

    const p = bytes.subarray(profileStart, profileStart + profileLen);
    if (p.length < 132) return null;

    const read32 = (off) => (p[off] << 24) | (p[off + 1] << 16) | (p[off + 2] << 8) | p[off + 3];
    const read16 = (off) => (p[off] << 8) | p[off + 1];

    const tagCount = read32(128);
    const tags = {};
    for (let i = 0; i < tagCount; i++) {
        const off = 132 + i * 12;
        const sig = String.fromCharCode(p[off], p[off + 1], p[off + 2], p[off + 3]);
        tags[sig] = {offset: read32(off + 4), length: read32(off + 8)};
    }

    function parseTRC(tag) {
        if (!tag || tag.offset + 12 > p.length) return null;
        const type = String.fromCharCode(p[tag.offset], p[tag.offset + 1], p[tag.offset + 2], p[tag.offset + 3]);
        if (type !== 'curv') return null;
        const count = read32(tag.offset + 8);
        if (count === 0) return null; // identity
        if (count === 1) {
            // Single gamma value (fixed 8.8)
            const gamma = read16(tag.offset + 12) / 256;
            const lut = new Uint16Array(256);
            for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, gamma) * 65535);
            return lut;
        }
        // Full LUT
        const lut = new Uint16Array(count);
        for (let i = 0; i < count; i++) lut[i] = read16(tag.offset + 12 + i * 2);
        return lut;
    }

    const rTRC = parseTRC(tags['rTRC']);
    const gTRC = parseTRC(tags['gTRC']);
    const bTRC = parseTRC(tags['bTRC']);
    if (!rTRC) return null;

    return [rTRC, gTRC || rTRC, bTRC || rTRC];
}

/** Linear light (0-1) to sRGB nonlinear (0-1) */
function linearToSRGB(v) {
    if (v <= 0.0031308) return 12.92 * v;
    return 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Convert sYCC (YCbCr) pixel data to RGB in-place.
 * componentMap: [indexOfY, indexOfCb, indexOfCr] or null for default [0,1,2].
 */
function convertSYCCtoRGB(items, nc, pixelCount, componentMap) {
    const yIdx  = componentMap ? componentMap[0] : 0;
    const cbIdx = componentMap ? componentMap[1] : 1;
    const crIdx = componentMap ? componentMap[2] : 2;

    for (let i = 0; i < pixelCount; i++) {
        const off = i * nc;
        const y  = items[off + yIdx];
        const cb = items[off + cbIdx] - 128;
        const cr = items[off + crIdx] - 128;
        items[off]     = Math.max(0, Math.min(255, Math.round(y + 1.402 * cr)));
        items[off + 1] = Math.max(0, Math.min(255, Math.round(y - 0.34414 * cb - 0.71414 * cr)));
        items[off + 2] = Math.max(0, Math.min(255, Math.round(y + 1.772 * cb)));
    }
}

/**
 * Check if decoded data actually contains YCbCr by examining the Cb channel.
 * Real sYCC has Cb centered near 128 (neutral chrominance). RGB data
 * mislabeled as sYCC will have Cb mean far from 128.
 * Returns true if the data appears to be genuine YCbCr.
 */
function looksLikeYCbCr(decoded, nc, pixelCount, cbIdx) {
    // Sample uniformly across the image (not just the start, which may be
    // biased by sky/ground regions with non-neutral chrominance).
    const sampleCount = Math.min(pixelCount, 10000);
    const step = Math.max(1, Math.floor(pixelCount / sampleCount));
    let cbSum = 0;
    let n = 0;
    for (let i = 0; i < pixelCount; i += step) {
        cbSum += decoded[i * nc + cbIdx];
        n++;
    }
    const cbMean = cbSum / n;
    const offset = Math.abs(cbMean - 128);
    return {isYCbCr: offset < 15, cbMean, offset};
}

/**
 * Convert raw decoded samples from OpenJPEG to RGBA buffer.
 * Handles >8-bit multi-component data, optional sYCC→RGB, and RGBA packing.
 * Used by the tiled decode paths (main-thread and worker) to match the
 * post-processing pipeline of the whole-image decoder.
 *
 * @param {Uint8Array} rawDecoded - Raw decoded buffer from OpenJPEG
 * @param {number} bps - Bits per sample
 * @param {number} nc - Component count
 * @param {number} pixelCount - Total pixels (width * height)
 * @param {Object} [options] - Color space options
 * @param {boolean} [options.isYCbCr] - Data is in YCbCr color space
 * @param {number[]} [options.componentMap] - [Y, Cb, Cr] → component indices
 * @returns {Uint8Array} RGBA buffer (pixelCount * 4 bytes)
 */
function rawSamplesToRGBA(rawDecoded, bps, nc, pixelCount, options) {
    // Step 1: Convert >8-bit samples to 8-bit (all components)
    let samples;
    if (bps > 8) {
        const maxVal = (1 << bps) - 1;
        const totalSamples = pixelCount * nc;
        samples = new Uint8Array(totalSamples);
        for (let i = 0; i < totalSamples; i++) {
            samples[i] = Math.round((rawDecoded[i * 2] | (rawDecoded[i * 2 + 1] << 8)) * 255 / maxVal);
        }
    } else {
        samples = rawDecoded;
    }

    // Step 2: sYCC→RGB conversion if needed
    if (options && options.isYCbCr && nc >= 3) {
        if (samples === rawDecoded) {
            samples = new Uint8Array(rawDecoded.subarray(0, pixelCount * nc));
        }
        const cbIdx = options.componentMap ? options.componentMap[1] : 1;
        const check = looksLikeYCbCr(samples, nc, pixelCount, cbIdx);
        if (check.isYCbCr) {
            convertSYCCtoRGB(samples, nc, pixelCount, options.componentMap);
        }
    }

    // Step 3: Pack to RGBA
    const rgba = new Uint8Array(pixelCount * 4);
    if (nc >= 3) {
        for (let i = 0; i < pixelCount; i++) {
            rgba[i * 4]     = samples[i * nc];
            rgba[i * 4 + 1] = samples[i * nc + 1];
            rgba[i * 4 + 2] = samples[i * nc + 2];
            rgba[i * 4 + 3] = nc >= 4 ? samples[i * nc + 3] : 255;
        }
    } else {
        for (let i = 0; i < pixelCount; i++) {
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = samples[i];
            rgba[i * 4 + 3] = 255;
        }
    }
    return rgba;
}

/**
 * Parse a J2K codestream to extract the main header and tile-part boundaries.
 * Used for per-tile decoding of very large tiled J2K images.
 *
 * J2K codestream structure:
 *   SOC | SIZ | COD | QCD | ... | SOT(tile0) | SOD | data | SOT(tile1) | ... | EOC
 *
 * @param {Uint8Array} data - Raw J2K codestream bytes
 * @returns {{mainHeader: Uint8Array, sizOffset: number, sizParams: Object,
 *            tiles: Array<{tileIndex, start, length}>}} or null
 */
function parseJ2KCodestream(data) {
    if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0x4F) return null; // no SOC

    const read16 = (off) => (data[off] << 8) | data[off + 1];
    const read32 = (off) => (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];

    let pos = 2; // past SOC
    let mainHeaderEnd = -1;
    let sizOffset = -1;
    let sizParams = null;

    // Parse main header markers until first SOT
    while (pos < data.length - 1) {
        if (data[pos] !== 0xFF) { pos++; continue; }
        const marker = data[pos + 1];

        if (marker === 0x90) { // SOT — end of main header
            mainHeaderEnd = pos;
            break;
        }

        if (marker === 0x51) { // SIZ marker
            sizOffset = pos;
            const Lsiz = read16(pos + 2);
            sizParams = {
                Lsiz,
                Rsiz: read16(pos + 4),
                Xsiz: read32(pos + 6),
                Ysiz: read32(pos + 10),
                XOsiz: read32(pos + 14),
                YOsiz: read32(pos + 18),
                XTsiz: read32(pos + 22),
                YTsiz: read32(pos + 26),
                XTOsiz: read32(pos + 30),
                YTOsiz: read32(pos + 34),
                Csiz: read16(pos + 38),
            };
            pos += 2 + Lsiz;
        } else {
            // Variable-length marker
            const Lmarker = read16(pos + 2);
            pos += 2 + Lmarker;
        }
    }

    if (mainHeaderEnd < 0 || !sizParams) return null;

    // Scan tile-parts via SOT markers
    const tiles = [];
    pos = mainHeaderEnd;
    while (pos + 12 <= data.length) {
        if (data[pos] !== 0xFF || data[pos + 1] !== 0x90) break;

        const Isot = read16(pos + 4);
        const Psot = read32(pos + 6);
        const tileLen = Psot > 0 ? Psot : (data.length - pos);

        tiles.push({tileIndex: Isot, start: pos, length: tileLen});
        pos += tileLen;
    }

    return {
        mainHeader: data.subarray(0, mainHeaderEnd),
        sizOffset,
        sizParams,
        tiles,
    };
}

/**
 * Build a single-tile J2K codestream from the main header + one tile's data.
 * Rewrites the SIZ marker to describe a 1-tile image with the tile's dimensions,
 * and resets the SOT tile index to 0.
 */
function buildSingleTileJ2K(mainHeader, tileData, sizOffset, sizParams, tileCol, tileRow) {
    const {Xsiz, Ysiz, XOsiz, YOsiz, XTsiz, YTsiz, XTOsiz, YTOsiz} = sizParams;

    // Calculate actual tile dimensions (edge tiles may be smaller)
    const tileX0 = XTOsiz + tileCol * XTsiz;
    const tileY0 = YTOsiz + tileRow * YTsiz;
    const tileW = Math.min(XTsiz, Xsiz - tileX0);
    const tileH = Math.min(YTsiz, Ysiz - tileY0);

    // Copy main header and patch the SIZ marker for a single-tile image
    const header = new Uint8Array(mainHeader);
    const write32 = (arr, off, val) => {
        arr[off] = (val >>> 24) & 0xFF;
        arr[off + 1] = (val >>> 16) & 0xFF;
        arr[off + 2] = (val >>> 8) & 0xFF;
        arr[off + 3] = val & 0xFF;
    };
    // Patch SIZ: image size = tile size, offsets = 0, single tile
    write32(header, sizOffset + 6, tileW);     // Xsiz = tile width
    write32(header, sizOffset + 10, tileH);    // Ysiz = tile height
    write32(header, sizOffset + 14, 0);        // XOsiz = 0
    write32(header, sizOffset + 18, 0);        // YOsiz = 0
    write32(header, sizOffset + 22, tileW);    // XTsiz = tile width
    write32(header, sizOffset + 26, tileH);    // YTsiz = tile height
    write32(header, sizOffset + 30, 0);        // XTOsiz = 0
    write32(header, sizOffset + 34, 0);        // YTOsiz = 0

    // Copy tile data and patch ALL SOT markers: set Isot=0.
    // Multi-part tiles have multiple SOT markers (one per tile-part),
    // each must be rewritten for our single-tile image.
    // 0xFF90 cannot appear in J2K entropy data (bit-stuffing rule: byte after 0xFF
    // must have MSB=0), so scanning for it is safe.
    const tile = new Uint8Array(tileData);
    for (let i = 0; i < tile.length - 5; i++) {
        if (tile[i] === 0xFF && tile[i + 1] === 0x90) {
            tile[i + 4] = 0;  // Isot high byte
            tile[i + 5] = 0;  // Isot low byte
            i += 11; // skip past SOT marker segment (2 marker + 10 body)
        }
    }

    // Assemble: header + tile + EOC
    const eoc = new Uint8Array([0xFF, 0xD9]);
    const result = new Uint8Array(header.length + tile.length + eoc.length);
    result.set(header, 0);
    result.set(tile, header.length);
    result.set(eoc, header.length + tile.length);
    return result;
}

/**
 * Decode a large tiled J2K codestream by decoding each tile individually.
 * This avoids the memory pressure of decoding the entire image at once.
 *
 * @param {ArrayBuffer} arrayBuffer - Raw J2K codestream
 * @param {Object} [options] - Color space options (passed to decodeJPEG2000ToCanvas)
 * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}>}
 */
export async function decodeJ2KTiledToCanvas(arrayBuffer, options) {
    const data = new Uint8Array(arrayBuffer);
    const cs = parseJ2KCodestream(data);
    if (!cs) throw new Error('Failed to parse J2K codestream');

    const {Xsiz, Ysiz, XTsiz, YTsiz, XTOsiz, YTOsiz} = cs.sizParams;
    const numTilesX = Math.ceil((Xsiz - XTOsiz) / XTsiz);
    const numTilesY = Math.ceil((Ysiz - YTOsiz) / YTsiz);

    // Group tile-parts by tile index
    const tilePartsMap = new Map();
    for (const tp of cs.tiles) {
        if (!tilePartsMap.has(tp.tileIndex)) tilePartsMap.set(tp.tileIndex, []);
        tilePartsMap.get(tp.tileIndex).push(tp);
    }

    const numUniqueTiles = tilePartsMap.size;

    // Calculate sub-resolution decode level to keep output under target size.
    // Each level halves both dimensions (wavelet decomposition levels).
    // Use user-chosen maxDimension if provided, otherwise default 10240.
    const MAX_EDGE = (options && options.maxDimension) || 10240;
    let reduceLevel = 0;
    let effW = Xsiz, effH = Ysiz;
    while ((effW > MAX_EDGE || effH > MAX_EDGE) && reduceLevel < 6) {
        reduceLevel++;
        effW = Math.ceil(Xsiz / (1 << reduceLevel));
        effH = Math.ceil(Ysiz / (1 << reduceLevel));
    }
    // Effective tile dimensions at this reduce level
    const effTileW = Math.ceil(XTsiz / (1 << reduceLevel));
    const effTileH = Math.ceil(YTsiz / (1 << reduceLevel));

    console.log(`JPEG2000Utils: Tiled decode: ${Xsiz}×${Ysiz}, ${numUniqueTiles} tiles `
        + `(${numTilesX}×${numTilesY} grid, ${XTsiz}×${YTsiz} each, `
        + `${cs.tiles.length} tile-parts)`
        + (reduceLevel > 0 ? `, reduce level ${reduceLevel} → ${effW}×${effH} (tiles ${effTileW}×${effTileH})` : ''));

    // Further downscale output canvas if still exceeds browser limits
    const MAX_PIXELS = 128 * 1024 * 1024;
    const MAX_DIM = 16384;
    let scale = 1;
    if (effW * effH > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (effW * effH));
    if (effW * scale > MAX_DIM) scale = MAX_DIM / effW;
    if (effH * scale > MAX_DIM) scale = MAX_DIM / effH;

    const outW = Math.round(effW * scale);
    const outH = Math.round(effH * scale);
    if (scale < 1) {
        console.log(`JPEG2000Utils: Tiled output scaled: ${effW}×${effH} → ${outW}×${outH}`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);

    // Prepare tile entries for dispatch
    const tileEntries = [...tilePartsMap.entries()];

    // Helper: concatenate tile-parts for a tile
    function buildTileData(tileParts) {
        const totalBytes = tileParts.reduce((s, tp) => s + tp.length, 0);
        const tileData = new Uint8Array(totalBytes);
        let off = 0;
        for (const tp of tileParts) {
            tileData.set(data.subarray(tp.start, tp.start + tp.length), off);
            off += tp.length;
        }
        return tileData;
    }

    // Helper: draw decoded RGBA tile onto output canvas.
    // Tile pixel coordinates are in the reduced-resolution space.
    const tileCanvas = document.createElement('canvas');
    const tileCtx = tileCanvas.getContext('2d');
    function drawTile(tileIndex, rgba, tileW, tileH) {
        const tileCol = tileIndex % numTilesX;
        const tileRow = Math.floor(tileIndex / numTilesX);
        const x = Math.round(tileCol * effTileW * scale);
        const y = Math.round(tileRow * effTileH * scale);
        // Edge tiles may be smaller
        const tileX0 = XTOsiz + tileCol * XTsiz;
        const tileY0 = YTOsiz + tileRow * YTsiz;
        const actualW = Math.ceil(Math.min(XTsiz, Xsiz - tileX0) / (1 << reduceLevel));
        const actualH = Math.ceil(Math.min(YTsiz, Ysiz - tileY0) / (1 << reduceLevel));
        tileCanvas.width = tileW;
        tileCanvas.height = tileH;
        const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), tileW, tileH);
        tileCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(tileCanvas,
            x, y, Math.round(actualW * scale), Math.round(actualH * scale));
    }

    const startTime = performance.now();

    // ── Try parallel decode with Web Workers ──────────────────────
    try {
        const onProgress = options && options.onProgress;
        const result = await _decodeWithWorkers(
            tileEntries, data, cs, numTilesX, numUniqueTiles, drawTile, buildTileData, startTime, reduceLevel, onProgress, options);
        const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
        console.log(`JPEG2000Utils: Tiled decode complete: ${result.decoded}/${numUniqueTiles} tiles `
            + `in ${totalTime}s (${result.failed} failed, ${result.workers} workers)`);
        return {canvas, width: outW, height: outH};
    } catch (workerError) {
        console.warn('JPEG2000Utils: Worker decode failed, falling back to sequential:', workerError.message);
    }

    // ── Fallback: sequential main-thread decode ───────────────────
    let Module;
    try {
        Module = await getOpenJPEGWASM();
    } catch (e) {
        Module = await getOpenJPEGJS();
    }

    let decoded = 0, failed = 0;
    for (const [tileIndex, tileParts] of tileEntries) {
        try {
            const tileData = buildTileData(tileParts);
            const tileCol = tileIndex % numTilesX;
            const tileRow = Math.floor(tileIndex / numTilesX);
            const miniJ2K = buildSingleTileJ2K(
                cs.mainHeader, tileData, cs.sizOffset, cs.sizParams, tileCol, tileRow);
            const decoder = new Module.J2KDecoder();
            try {
                const buf = decoder.getEncodedBuffer(miniJ2K.length);
                buf.set(miniJ2K);
                if (reduceLevel > 0 && typeof decoder.decodeSubResolution === 'function') {
                    decoder.decodeSubResolution(reduceLevel, 0);
                } else {
                    decoder.decode();
                }
                const fi = decoder.getFrameInfo();
                // decodeSubResolution does NOT update frameInfo — use actual tile dims
                // Edge tiles may be smaller than XTsiz×YTsiz
                const tileX0 = XTOsiz + tileCol * XTsiz;
                const tileY0 = YTOsiz + tileRow * YTsiz;
                const actualTileW = Math.min(XTsiz, Xsiz - tileX0);
                const actualTileH = Math.min(YTsiz, Ysiz - tileY0);
                const useW = reduceLevel > 0 ? Math.ceil(actualTileW / (1 << reduceLevel)) : fi.width;
                const useH = reduceLevel > 0 ? Math.ceil(actualTileH / (1 << reduceLevel)) : fi.height;
                if (!useW || !useH) throw new Error('0×0');
                const raw = decoder.getDecodedBuffer();
                const rgba = rawSamplesToRGBA(raw, fi.bitsPerSample, fi.componentCount, useW * useH, options);
                drawTile(tileIndex, rgba, useW, useH);
                decoded++;
            } finally { decoder.delete(); }
        } catch (e) {
            if (decoded === 0 && failed === 0)
                console.warn(`JPEG2000Utils: Tile ${tileIndex} failed:`, e.message);
            failed++;
        }
        const count = decoded + failed;
        if (count % 50 === 0) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            console.log(`JPEG2000Utils: Sequential: ${count}/${numUniqueTiles} (${elapsed}s)`);
            await new Promise(r => setTimeout(r, 0));
        }
    }
    const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(`JPEG2000Utils: Sequential decode complete: ${decoded}/${numUniqueTiles} tiles `
        + `in ${totalTime}s (${failed} failed)`);
    return {canvas, width: outW, height: outH};
}

/**
 * Decode tiles in parallel using a pool of Web Workers.
 * Each worker loads its own OpenJPEG WASM instance.
 */
async function _decodeWithWorkers(tileEntries, data, cs, numTilesX, totalTiles, drawTile, buildTileData, startTime, reduceLevel, onProgress, options) {
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 8);

    console.log(`JPEG2000Utils: Starting ${numWorkers} decode workers`);

    // Create workers and start them all compiling WASM in parallel.
    // Don't wait for all to be ready — dispatch tiles as each worker reports ready.
    const workers = [];
    for (let i = 0; i < numWorkers; i++) {
        workers.push(new Worker('./src/workers/J2KTileDecodeWorker.js'));
    }

    return new Promise((resolve, reject) => {
        let nextIdx = 0;
        let decoded = 0, failed = 0;
        let initFailed = 0;

        function dispatchNext(workerIdx) {
            if (nextIdx >= tileEntries.length) return;
            const [tileIndex, tileParts] = tileEntries[nextIdx++];
            const tileCol = tileIndex % numTilesX;
            const tileRow = Math.floor(tileIndex / numTilesX);
            const tileData = buildTileData(tileParts);
            workers[workerIdx].postMessage(
                {type: 'decodeTile', tileIndex, tileData, tileCol, tileRow},
                [tileData.buffer]
            );
        }

        function onTileComplete() {
            const count = decoded + failed;
            if (onProgress) onProgress(count, totalTiles);
            if (count % 50 === 0 && count > 0) {
                const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
                const rate = (count / (performance.now() - startTime) * 1000).toFixed(0);
                console.log(`JPEG2000Utils: Tiled decode: ${count}/${totalTiles} `
                    + `(${elapsed}s, ~${rate} tiles/s)`);
            }
            if (count >= totalTiles) {
                workers.forEach(w => w.terminate());
                resolve({decoded, failed, workers: numWorkers});
            }
        }

        workers.forEach((w, idx) => {
            w.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'ready') {
                    // Worker compiled WASM — immediately start it decoding
                    dispatchNext(idx);
                } else if (msg.type === 'initError') {
                    console.warn(`JPEG2000Utils: Worker ${idx} init failed:`, msg.error);
                    initFailed++;
                    if (initFailed >= numWorkers) {
                        workers.forEach(w2 => w2.terminate());
                        reject(new Error('All workers failed to init'));
                    }
                } else if (msg.type === 'tileResult') {
                    drawTile(msg.tileIndex, msg.rgba, msg.width, msg.height);
                    decoded++;
                    onTileComplete();
                    dispatchNext(idx);
                } else if (msg.type === 'tileError') {
                    if (failed === 0) console.warn(`JPEG2000Utils: Worker tile ${msg.tileIndex} failed:`, msg.error);
                    failed++;
                    onTileComplete();
                    dispatchNext(idx);
                }
            };
            w.onerror = (e) => {
                console.warn('JPEG2000Utils: Worker error:', e.message);
                failed++;
                onTileComplete();
                dispatchNext(idx);
            };

            // Send init — worker starts compiling WASM immediately
            w.postMessage({
                type: 'init',
                mainHeader: cs.mainHeader,
                sizOffset: cs.sizOffset,
                sizParams: cs.sizParams,
                reduceLevel,
                isYCbCr: !!(options && options.isYCbCr),
                componentMap: (options && options.componentMap) || null,
            });
        });
    });
}

/**
 * Decode a JPEG 2000 buffer to a canvas using OpenJPEG WASM.
 *
 * @param {ArrayBuffer} arrayBuffer - Raw JP2/J2K file data
 * @param {Object} [options] - Color space overrides for raw J2K codestreams
 *   (NITF IREP/IREPBAND). Not needed for JP2 containers — colr box is read.
 * @param {boolean} [options.isYCbCr] - Data is in YCbCr color space
 * @param {number[]} [options.componentMap] - [Y, Cb, Cr] → codestream indices
 * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}>}
 */
async function decodeJPEG2000ToCanvas(arrayBuffer, options) {
    const inputData = new Uint8Array(arrayBuffer);

    // Try WASM decoder first, fall back to asm.js on RuntimeError.
    // The WASM build can hit "function signature mismatch" traps on certain
    // J2K codestreams; the asm.js build compiles the same C code to JS where
    // indirect calls don't have WASM function-table type checking.
    let Module;
    let usingFallback = false;
    try {
        Module = await getOpenJPEGWASM();
    } catch (e) {
        console.warn('JPEG2000Utils: WASM module failed to load, trying JS fallback:', e.message);
        Module = await getOpenJPEGJS();
        usingFallback = true;
    }

    // Browser canvas limits — decoded image must fit within these constraints
    const MAX_PIXELS = 128 * 1024 * 1024;
    const MAX_DIM = 16384;

    // Prepare decoder and determine if sub-resolution decode is needed.
    // For very large J2K images (e.g. 35840×32768 satellite imagery),
    // decoding at full resolution would exceed browser memory limits.
    // OpenJPEG supports decoding at reduced wavelet decomposition levels,
    // each level halving both dimensions.
    function setupDecoder(mod) {
        const dec = new mod.J2KDecoder();
        const buf = dec.getEncodedBuffer(inputData.length);
        buf.set(inputData);
        return dec;
    }

    function decodeWithAutoReduce(dec) {
        // Read header to get full dimensions and decomposition info
        if (typeof dec.readHeader === 'function') {
            dec.readHeader();
        }
        const headerInfo = dec.getFrameInfo();
        const fullW = headerInfo.width;
        const fullH = headerInfo.height;

        // Check if sub-resolution decode is available and needed
        const canSubRes = typeof dec.decodeSubResolution === 'function'
            && typeof dec.calculateSizeAtDecompositionLevel === 'function';
        const needsReduce = fullW * fullH > MAX_PIXELS || fullW > MAX_DIM || fullH > MAX_DIM;

        if (needsReduce && canSubRes) {
            // Calculate minimum reduce level to fit within browser limits.
            // Most J2K imagery has 5-6 decomposition levels; cap at 8 as safety limit.
            const numDecomps = typeof dec.getNumDecomposition === 'function'
                ? dec.getNumDecomposition() : 8;
            let reduceLevel = 0;
            let w = fullW, h = fullH;
            while ((w * h > MAX_PIXELS || w > MAX_DIM || h > MAX_DIM) && reduceLevel < numDecomps) {
                reduceLevel++;
                w = Math.ceil(fullW / (1 << reduceLevel));
                h = Math.ceil(fullH / (1 << reduceLevel));
            }

            console.log(`JPEG2000Utils: Sub-resolution decode: level ${reduceLevel}/${numDecomps}, `
                + `${fullW}×${fullH} → ~${w}×${h}`);
            dec.calculateSizeAtDecompositionLevel(reduceLevel);
            dec.decodeSubResolution(reduceLevel, 0);
        } else {
            if (needsReduce) {
                console.warn(`JPEG2000Utils: Image is ${fullW}×${fullH} (${(fullW*fullH/1e6).toFixed(0)}M pixels) `
                    + `but sub-resolution decode is not available — attempting full decode`);
            }
            dec.decode();
        }
    }

    let decoder = setupDecoder(Module);
    try {
        try {
            decodeWithAutoReduce(decoder);
        } catch (wasmError) {
            if (usingFallback) throw wasmError; // already on fallback, re-throw
            console.warn('JPEG2000Utils: WASM decode failed, retrying with JS fallback:', wasmError.message);
            decoder.delete();
            Module = await getOpenJPEGJS();
            decoder = setupDecoder(Module);
            decodeWithAutoReduce(decoder);
            usingFallback = true;
        }

        const frameInfo = decoder.getFrameInfo();
        const width = frameInfo.width;
        const height = frameInfo.height;
        const nc = frameInfo.componentCount;
        const bps = frameInfo.bitsPerSample;

        if (!width || !height) {
            throw new Error(`JPEG 2000 decode produced invalid dimensions: ${width}×${height}`);
        }

        const rawDecoded = decoder.getDecodedBuffer();
        const pixelCount = width * height;

        // For >8-bit images, OpenJPEG stores each sample in 2 bytes (little-endian).
        // Convert to 8-bit, applying ICC TRC curves if present for correct tonality.
        let decoded;
        if (bps > 8) {
            const maxVal = (1 << bps) - 1;
            const trcs = nc >= 3 ? extractICCTRCs(inputData) : null;
            decoded = new Uint8Array(pixelCount * nc);

            if (trcs) {
                // Apply ICC TRC LUT → linear light → sRGB gamma
                for (let i = 0; i < pixelCount; i++) {
                    for (let c = 0; c < nc; c++) {
                        const idx = (i * nc + c) * 2;
                        const v16 = rawDecoded[idx] | (rawDecoded[idx + 1] << 8);
                        const trc = trcs[Math.min(c, 2)];
                        // Interpolate in TRC LUT
                        const lutIdx = v16 * (trc.length - 1) / maxVal;
                        const lo = Math.floor(lutIdx);
                        const hi = Math.min(lo + 1, trc.length - 1);
                        const frac = lutIdx - lo;
                        const linear = (trc[lo] * (1 - frac) + trc[hi] * frac) / 65535;
                        decoded[i * nc + c] = Math.max(0, Math.min(255, Math.round(linearToSRGB(linear) * 255)));
                    }
                }
                console.log(`JPEG2000Utils: OpenJPEG${usingFallback ? ' (JS)' : ''} decoded ${width}×${height}, ${nc} components, ${bps}-bit, ICC TRC applied`);
            } else {
                // Simple linear scale
                for (let i = 0; i < pixelCount * nc; i++) {
                    const lo = rawDecoded[i * 2];
                    const hi = rawDecoded[i * 2 + 1];
                    decoded[i] = Math.round((lo | (hi << 8)) * 255 / maxVal);
                }
                console.log(`JPEG2000Utils: OpenJPEG${usingFallback ? ' (JS)' : ''} decoded ${width}×${height}, ${nc} components, ${bps}-bit → 8-bit`);
            }
        } else {
            decoded = rawDecoded;
            console.log(`JPEG2000Utils: OpenJPEG${usingFallback ? ' (JS)' : ''} decoded ${width}×${height}, ${nc} components`);
        }

        // Determine if sYCC→RGB conversion is needed.
        // Source 1: caller-provided options (NITF IREP)
        // Source 2: JP2 colr box (EnumCS=18 = sYCC)
        let needsConvert = false;
        let componentMap = null;

        if (options && options.isYCbCr) {
            needsConvert = true;
            componentMap = options.componentMap || null;
        } else if (nc >= 3) {
            const enumCS = getJP2EnumCS(inputData);
            if (enumCS === 18) {
                needsConvert = true;
                // OpenJPEG already applied cdef reordering, so components
                // are in standard [Y, Cb, Cr] order after decoding.
            }
        }

        if (needsConvert && nc >= 3) {
            const cbIdx = componentMap ? componentMap[1] : 1;
            const check = looksLikeYCbCr(decoded, nc, pixelCount, cbIdx);
            if (check.isYCbCr) {
                convertSYCCtoRGB(decoded, nc, pixelCount, componentMap);
                console.log(`JPEG2000Utils: sYCC→RGB (Cb mean=${check.cbMean.toFixed(1)})`);
            } else {
                console.log(`JPEG2000Utils: Skipped sYCC→RGB — data is RGB despite metadata (Cb mean=${check.cbMean.toFixed(1)})`);
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        const rgba = imageData.data;

        if (nc >= 3) {
            for (let i = 0; i < pixelCount; i++) {
                rgba[i * 4]     = decoded[i * nc];
                rgba[i * 4 + 1] = decoded[i * nc + 1];
                rgba[i * 4 + 2] = decoded[i * nc + 2];
                rgba[i * 4 + 3] = nc >= 4 ? decoded[i * nc + 3] : 255;
            }
        } else {
            for (let i = 0; i < pixelCount; i++) {
                const v = decoded[i];
                rgba[i * 4] = v;
                rgba[i * 4 + 1] = v;
                rgba[i * 4 + 2] = v;
                rgba[i * 4 + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return {canvas, width, height};
    } finally {
        decoder.delete();
    }
}

/**
 * Decode a JPEG 2000 buffer and return an HTMLImageElement.
 */
export async function decodeJPEG2000ToImage(arrayBuffer, options) {
    const {canvas} = await decodeJPEG2000ToCanvas(arrayBuffer, options);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const pngBuffer = await blob.arrayBuffer();
    return createImageFromArrayBuffer(pngBuffer, 'image/png');
}

/**
 * Decode a JPEG 2000 buffer and return a persistent blob URL.
 */
export async function decodeJPEG2000ToBlobURL(arrayBuffer, options) {
    const {canvas} = await decodeJPEG2000ToCanvas(arrayBuffer, options);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return URL.createObjectURL(blob);
}

// Export pure functions for unit testing
export {linearToSRGB, convertSYCCtoRGB, looksLikeYCbCr, parseJ2KCodestream,
        buildSingleTileJ2K, getJP2EnumCS, extractICCTRCs};
