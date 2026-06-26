// Build-time extraction of the EGM96 15-arc-minute geoid grid into a compact
// little-endian binary asset (data/egm96/egm96-15.bin).
//
// WHY: the `egm96-universal` npm package embeds the grid as a 2.77MB base64
// STRING inside a JS module. Base64 inflates the binary ~33% AND scrambles the
// byte patterns gzip relies on, so it compresses to ~1.87MB — over HALF of the
// entire production JS bundle, all parsed on the main thread at startup. Shipping
// the raw Int16 grid as a binary asset that the browser fetches on demand removes
// it from the JS bundle entirely (no parse cost) and gzips far better (smooth
// numeric field). See src/EGM96Geoid.js for the runtime loader.
//
// The grid is 721 rows x 1440 cols of Int16 (geoid undulation in centimetres).
// egm96-universal stores it BIG-endian and reads it via DataView.getInt16(.,false).
//
// On-disk format of egm96-15.bin (decoded by src/EGM96Geoid.js):
//   gzip( planar( rowDelta( grid ) ) )
//   - rowDelta: per row, store (value - previousValueInRow) as wrapped int16; the
//     geoid is a smooth field so deltas are tiny and compress well.
//   - planar: emit all N low bytes, then all N high bytes, so gzip sees two smooth
//     byte planes instead of interleaved hi/lo noise.
//   - gzip: final entropy coding (~849KB vs 1.87MB for the base64-in-JS form, and
//     guaranteed on the wire regardless of server .bin compression config).
//
// Run: node scripts/extractEGM96Geoid.js
// The EGM96 geoid model is public-domain US Government (NGA/NASA) data; only the
// JS packaging in egm96-universal carries a library licence, which we drop here.

const fs = require('fs');
const path = require('path');

const NUM_ROWS = 721;
const NUM_COLS = 1440;
const NUM_VALUES = NUM_ROWS * NUM_COLS; // 1,038,240
const NUM_BYTES = NUM_VALUES * 2;       // 2,076,480

const SRC = path.resolve(__dirname, '../node_modules/egm96-universal/dist/egm96-universal.esm.js');
const OUT_DIR = path.resolve(__dirname, '../data/egm96');
const OUT = path.join(OUT_DIR, 'egm96-15.bin');

function extractBase64(jsSource) {
    const m = jsSource.match(/var data = "([^"]*)";/);
    if (!m) throw new Error('Could not find `var data = "..."` in egm96-universal source');
    return m[1];
}

function main() {
    const jsSource = fs.readFileSync(SRC, 'utf8');
    const b64 = extractBase64(jsSource);
    const beBuf = Buffer.from(b64, 'base64'); // big-endian Int16 grid, as packaged

    if (beBuf.length !== NUM_BYTES) {
        throw new Error(`Decoded grid is ${beBuf.length} bytes, expected ${NUM_BYTES} (721*1440*2)`);
    }

    // Reference grid (matches egm96-universal exactly): big-endian via DataView.
    const beView = new DataView(beBuf.buffer, beBuf.byteOffset, beBuf.byteLength);
    const grid = new Int16Array(NUM_VALUES);
    for (let i = 0; i < NUM_VALUES; i++) grid[i] = beView.getInt16(i * 2, false);

    // Encode: row-delta -> planar(lo|hi) -> gzip.
    const planar = new Uint8Array(NUM_BYTES);
    for (let r = 0; r < NUM_ROWS; r++) {
        let prev = 0;
        for (let c = 0; c < NUM_COLS; c++) {
            const i = r * NUM_COLS + c;
            const delta = (grid[i] - prev) & 0xffff;
            prev = grid[i];
            planar[i] = delta & 0xff;
            planar[NUM_VALUES + i] = (delta >> 8) & 0xff;
        }
    }
    const compressed = require('zlib').gzipSync(Buffer.from(planar.buffer), { level: 9 });

    // Round-trip validation: decode exactly as the browser loader will, and compare
    // every cell to the reference grid. Refuse to write a lossy asset.
    const back = require('zlib').gunzipSync(compressed);
    const decoded = new Int16Array(NUM_VALUES);
    for (let r = 0; r < NUM_ROWS; r++) {
        let acc = 0;
        for (let c = 0; c < NUM_COLS; c++) {
            const i = r * NUM_COLS + c;
            const delta = back[i] | (back[NUM_VALUES + i] << 8);
            acc = (acc + delta) & 0xffff;
            decoded[i] = (acc << 16) >> 16; // wrap to signed int16
        }
    }
    for (let i = 0; i < NUM_VALUES; i++) {
        if (decoded[i] !== grid[i]) {
            throw new Error(`Round-trip mismatch at index ${i}: ${decoded[i]} !== ${grid[i]}`);
        }
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, compressed);

    console.log(`Wrote ${OUT}`);
    console.log(`  grid ${NUM_ROWS}x${NUM_COLS} int16, ${NUM_BYTES} bytes uncompressed`);
    console.log(`  ${compressed.length} bytes on disk/wire (was ~1.87MB gzip as base64-in-JS)`);
    console.log(`  round-trip validated: all ${NUM_VALUES} cells exact`);
}

main();
