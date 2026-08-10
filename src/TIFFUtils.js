// Convert a TIFF image to an array of elevation values
// image is a TIFF image loaded by GeoTIFF
// the data is in an ArrayBufferSource with contains an arrayBuffer
import {assert} from "./assert";
import {loadGeoTIFF} from "./geotiffLoader";

export async function convertTiffBufferToBlobURL(buffer) {
    const {fromArrayBuffer} = await loadGeoTIFF();
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const rasters = await image.readRasters();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    const numBands = rasters.length;
    const extraSamples = image.fileDirectory.ExtraSamples;
    const hasAlpha = extraSamples && (extraSamples[0] === 1 || extraSamples[0] === 2);

    for (let i = 0; i < width * height; i++) {
        if (numBands >= 3) {
            imageData.data[i * 4] = rasters[0][i];
            imageData.data[i * 4 + 1] = rasters[1][i];
            imageData.data[i * 4 + 2] = rasters[2][i];
            imageData.data[i * 4 + 3] = (numBands >= 4 && hasAlpha) ? rasters[3][i] : 255;
        } else {
            const val = rasters[0][i];
            imageData.data[i * 4] = val;
            imageData.data[i * 4 + 1] = val;
            imageData.data[i * 4 + 2] = val;
            imageData.data[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(imageData, 0, 0);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return URL.createObjectURL(blob);
}

export async function convertTiffBufferToPngImage(buffer) {
    const blobURL = await convertTiffBufferToBlobURL(buffer);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = blobURL;
    });
}

export function convertTIFFToElevationArray(image) {

    if (!image.isTiled) {
        throw new Error("TIFF image is not tiled");
    }

    const width = image.fileDirectory.ImageWidth;
    const height = image.fileDirectory.ImageLength;
    const tileWidth = image.fileDirectory.TileWidth;
    const tileHeight = image.fileDirectory.TileLength;
    const tileCount = image.fileDirectory.TileOffsets.length;
    const tileOffsets = image.fileDirectory.TileOffsets;
    const tileByteCounts = image.fileDirectory.TileByteCounts;

    const buffer = image.source.arrayBuffer;

    const bufferView = new DataView(buffer);

    const output = new Float32Array(width * width);

    const numTilesX = Math.ceil(width / tileWidth);
    const numTilesY = Math.ceil(height / tileHeight);
    // iterate over the tiles by row and column
    for (let tileX = 0; tileX < numTilesX ; tileX += 1) {
        for (let tileY = 0; tileY< numTilesY; tileY+=1) {
            const tileIndex = tileY * numTilesX + tileX;
            const tileOffset = tileOffsets[tileIndex];
            const tileByteCount = tileByteCounts[tileIndex];

            if (tileByteCount !== 0) {
                // iterate over the tile data by row and column
                for (let x = 0; x < tileWidth; x += 1) {
                    for (let y = 0; y < tileHeight; y += 1) {
                        const index = y * tileWidth + x;
                        assert(index * 4 < tileByteCount, "index out of range, tileByteCount = " + tileByteCount + " index = " + index);

                        // the value at index*4 is a 32 bit float, little endian
                        const value = bufferView.getFloat32(tileOffset + index * 4, true);

                        assert(!isNaN(value), "value is NaN at " + x + "," + y + "offset = " + (tileOffset + index*4));
                        const outputX = tileX * tileWidth + x;
                        const outputY = tileY * tileHeight + y;
                        const outputIndex = outputY * width + outputX;
                        if (outputX < width && outputY < height) {
                            output[outputIndex] = value;
                        }
                    }
                }
            }
        }
    }




    return output;
}