"use strict";

/**
 * Web Worker for parallel JPEG 2000 tile decoding.
 * Loads OpenJPEG WASM and decodes individual J2K tiles.
 *
 * Protocol:
 *   init → {type:'init', mainHeader, sizOffset, sizParams,
 *            reduceLevel, isYCbCr, componentMap}
 *   ready ← {type:'ready'}
 *   decodeTile → {type:'decodeTile', tileIndex, tileData, tileCol, tileRow}
 *   tileResult ← {type:'tileResult', tileIndex, rgba, width, height} (rgba is transferred)
 *   tileError ← {type:'tileError', tileIndex, error}
 *
 * NOTE: buildSingleTileJ2K, convertSYCCtoRGB, and looksLikeYCbCr are duplicated
 * from JPEG2000Utils.js (pure byte/math manipulation).
 * If you change the logic there, update it here too.
 */

let Module = null;
let mainHeader = null;
let sizOffset = 0;
let sizParams = null;
let reduceLevel = 0;
let isYCbCr = false;
let componentMap = null;

/**
 * Build a single-tile J2K codestream from the main header + one tile's data.
 * Rewrites SIZ marker for a 1-tile image and patches all SOT tile indices to 0.
 * (Duplicated from JPEG2000Utils.js — keep in sync.)
 */
function buildSingleTileJ2K(mainHeaderBytes, tileData, sizOff, siz, tileCol, tileRow) {
    const {Xsiz, Ysiz, XTsiz, YTsiz, XTOsiz, YTOsiz} = siz;

    const tileX0 = XTOsiz + tileCol * XTsiz;
    const tileY0 = YTOsiz + tileRow * YTsiz;
    const tileW = Math.min(XTsiz, Xsiz - tileX0);
    const tileH = Math.min(YTsiz, Ysiz - tileY0);

    const header = new Uint8Array(mainHeaderBytes);
    const write32 = (arr, off, val) => {
        arr[off] = (val >>> 24) & 0xFF;
        arr[off + 1] = (val >>> 16) & 0xFF;
        arr[off + 2] = (val >>> 8) & 0xFF;
        arr[off + 3] = val & 0xFF;
    };
    write32(header, sizOff + 6, tileW);
    write32(header, sizOff + 10, tileH);
    write32(header, sizOff + 14, 0);
    write32(header, sizOff + 18, 0);
    write32(header, sizOff + 22, tileW);
    write32(header, sizOff + 26, tileH);
    write32(header, sizOff + 30, 0);
    write32(header, sizOff + 34, 0);

    const tile = new Uint8Array(tileData);
    for (let i = 0; i < tile.length - 5; i++) {
        if (tile[i] === 0xFF && tile[i + 1] === 0x90) {
            tile[i + 4] = 0;
            tile[i + 5] = 0;
            i += 11;
        }
    }

    const eoc = new Uint8Array([0xFF, 0xD9]);
    const result = new Uint8Array(header.length + tile.length + eoc.length);
    result.set(header, 0);
    result.set(tile, header.length);
    result.set(eoc, header.length + tile.length);
    return result;
}

/**
 * Convert sYCC (YCbCr) pixel data to RGB in-place.
 * (Duplicated from JPEG2000Utils.js — keep in sync.)
 */
function convertSYCCtoRGB(items, nc, pixelCount, cMap) {
    const yIdx  = cMap ? cMap[0] : 0;
    const cbIdx = cMap ? cMap[1] : 1;
    const crIdx = cMap ? cMap[2] : 2;
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
 * Check if decoded data looks like YCbCr by examining Cb channel mean.
 * (Duplicated from JPEG2000Utils.js — keep in sync.)
 */
function looksLikeYCbCr(decoded, nc, pixelCount, cbIdx) {
    const sampleCount = Math.min(pixelCount, 10000);
    const step = Math.max(1, Math.floor(pixelCount / sampleCount));
    let cbSum = 0, n = 0;
    for (let i = 0; i < pixelCount; i += step) {
        cbSum += decoded[i * nc + cbIdx];
        n++;
    }
    const cbMean = cbSum / n;
    return {isYCbCr: Math.abs(cbMean - 128) < 15, cbMean};
}

function decodeTile(tileIndex, tileData, tileCol, tileRow) {
    const miniJ2K = buildSingleTileJ2K(mainHeader, tileData, sizOffset, sizParams, tileCol, tileRow);

    const decoder = new Module.J2KDecoder();
    try {
        const encodedBuffer = decoder.getEncodedBuffer(miniJ2K.length);
        encodedBuffer.set(miniJ2K);

        if (reduceLevel > 0 && typeof decoder.decodeSubResolution === 'function') {
            decoder.decodeSubResolution(reduceLevel, 0);
        } else {
            decoder.decode();
        }

        const fi = decoder.getFrameInfo();
        // decodeSubResolution does NOT update frameInfo — use actual tile dims.
        // Edge tiles may be smaller than nominal XTsiz×YTsiz.
        const {Xsiz, Ysiz, XTsiz, YTsiz, XTOsiz, YTOsiz} = sizParams;
        const tileX0 = XTOsiz + tileCol * XTsiz;
        const tileY0 = YTOsiz + tileRow * YTsiz;
        const actualTileW = Math.min(XTsiz, Xsiz - tileX0);
        const actualTileH = Math.min(YTsiz, Ysiz - tileY0);
        const width = reduceLevel > 0 ? Math.ceil(actualTileW / (1 << reduceLevel)) : fi.width;
        const height = reduceLevel > 0 ? Math.ceil(actualTileH / (1 << reduceLevel)) : fi.height;
        if (!width || !height) throw new Error('0×0 decode');

        const rawDecoded = decoder.getDecodedBuffer();
        const bps = fi.bitsPerSample;
        const nc = fi.componentCount;
        const pixelCount = width * height;

        // Step 1: Convert >8-bit samples to 8-bit (all components, not just first)
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
        if (isYCbCr && nc >= 3) {
            if (samples === rawDecoded) {
                samples = new Uint8Array(rawDecoded.subarray(0, pixelCount * nc));
            }
            const cbIdx = componentMap ? componentMap[1] : 1;
            const check = looksLikeYCbCr(samples, nc, pixelCount, cbIdx);
            if (check.isYCbCr) {
                convertSYCCtoRGB(samples, nc, pixelCount, componentMap);
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

        return {rgba, width, height};
    } finally {
        decoder.delete();
    }
}

self.onmessage = async (e) => {
    const msg = e.data;

    if (msg.type === 'init') {
        try {
            const wasmBase = new URL('../../libs/openjpeg/', self.location).href;
            importScripts(wasmBase + 'openjpegwasm_decode.js');
            Module = await self.OpenJPEGWASM({
                locateFile: (filename) => wasmBase + filename,
                print: () => {},
                printErr: () => {},
            });
            mainHeader = new Uint8Array(msg.mainHeader);
            sizOffset = msg.sizOffset;
            sizParams = msg.sizParams;
            reduceLevel = msg.reduceLevel || 0;
            isYCbCr = msg.isYCbCr || false;
            componentMap = msg.componentMap || null;
            self.postMessage({type: 'ready'});
        } catch (err) {
            self.postMessage({type: 'initError', error: err.message});
        }
    } else if (msg.type === 'decodeTile') {
        try {
            const result = decodeTile(msg.tileIndex, msg.tileData, msg.tileCol, msg.tileRow);
            self.postMessage(
                {type: 'tileResult', tileIndex: msg.tileIndex,
                 rgba: result.rgba, width: result.width, height: result.height},
                [result.rgba.buffer] // transfer
            );
        } catch (err) {
            self.postMessage({type: 'tileError', tileIndex: msg.tileIndex, error: err.message});
        }
    }
};
