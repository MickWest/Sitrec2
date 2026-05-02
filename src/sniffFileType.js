/**
 * Content-based file type detection.
 *
 * Returns a canonical lowercase extension string matching the cases in
 * CFileManagerParse.js parseAsset(), or null if no signature was matched.
 *
 * Only detects formats with strong magic-number signatures. Text formats
 * (CSV, JSON, KML, SRT, TLE, etc.) are intentionally not sniffed here —
 * their existing extension-driven branches do their own content detection
 * and false positives on text are easy to introduce. The principle is:
 * trust contents over filename extensions, but only when the contents
 * give us an unambiguous signal.
 */
export function sniffFileType(buffer) {
    if (!buffer) return null;
    const total = buffer.byteLength ?? buffer.length;
    if (total < 4) return null;

    const head = Math.min(total, 4096);
    const u8 = buffer instanceof Uint8Array
        ? buffer.subarray(0, head)
        : new Uint8Array(buffer, 0, head);

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return "png";

    // JPEG: FF D8 FF
    if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return "jpg";

    // GIF: "GIF8"
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return "gif";

    // TIFF / GeoTIFF: "II*\0" little-endian or "MM\0*" big-endian
    if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2A && u8[3] === 0x00) ||
        (u8[0] === 0x4D && u8[1] === 0x4D && u8[2] === 0x00 && u8[3] === 0x2A)) return "tif";

    // ZIP / KMZ / DOCX / etc.: local file header "PK\3\4" (also empty/spanned variants)
    if (u8[0] === 0x50 && u8[1] === 0x4B &&
        (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07)) return "zip";

    // GZIP: 1F 8B
    if (u8[0] === 0x1F && u8[1] === 0x8B) return "gz";

    // NITF / NSIF: "NITF" or "NSIF"
    if (u8[0] === 0x4E && u8[1] === 0x49 && u8[2] === 0x54 && u8[3] === 0x46) return "ntf";
    if (u8[0] === 0x4E && u8[1] === 0x53 && u8[2] === 0x49 && u8[3] === 0x46) return "ntf";

    // glTF binary: "glTF"
    if (u8[0] === 0x67 && u8[1] === 0x6C && u8[2] === 0x54 && u8[3] === 0x46) return "glb";

    // RIFF container: AVI or WebP — needs "RIFF" at 0 and form type at 8-11
    if (u8.length >= 12 &&
        u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) {
        if (u8[8] === 0x41 && u8[9] === 0x56 && u8[10] === 0x49 && u8[11] === 0x20) return "avi";
        if (u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return "webp";
    }

    // EBML (WebM / Matroska): 1A 45 DF A3
    if (u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return "webm";

    // ISO BMFF (MP4 / MOV / HEIC / 3GP / ...): bytes 4-7 = "ftyp"
    if (u8.length >= 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
        const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]).toLowerCase();
        if (brand === "heic" || brand === "heix" || brand === "hevc" ||
            brand === "mif1" || brand === "msf1") return "heic";
        if (brand.startsWith("qt")) return "mov";
        return "mp4";
    }

    // JPEG 2000 signature box: 00 00 00 0C "jP  "
    if (u8.length >= 12 &&
        u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0x00 && u8[3] === 0x0C &&
        u8[4] === 0x6A && u8[5] === 0x50 && u8[6] === 0x20 && u8[7] === 0x20) return "jp2";
    // JPEG 2000 codestream: FF 4F FF 51
    if (u8[0] === 0xFF && u8[1] === 0x4F && u8[2] === 0xFF && u8[3] === 0x51) return "jp2";

    // MPEG transport stream: 0x47 every 188 bytes (also M2TS variant: 192-byte spacing)
    if (isMpegTransportStream(u8)) return "ts";

    // MPEG-1/2 program stream: 00 00 01 BA pack header
    if (u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0x01 && u8[3] === 0xBA) return "mpg";

    // MPEG-1/2 video elementary stream: 00 00 01 B3 sequence header
    if (u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0x01 && u8[3] === 0xB3) return "m2v";

    return null;
}

/**
 * MPEG-TS sync pattern: byte 0x47 at offsets 0, 188, 376, 564 (PACKET=188).
 * Also handles Blu-ray M2TS, which prefixes each packet with a 4-byte
 * timecode → sync byte at offsets 4, 196, 388, 580 (PACKET=192).
 *
 * Requires at least 3 sync hits in a row, which gives essentially zero
 * false positives in practice — random data has a 1-in-256 chance of
 * matching a single byte, so 3 consecutive hits is ~1 in 16 million.
 */
function isMpegTransportStream(u8) {
    if (u8.length < 4) return false;

    if (u8[0] === 0x47) {
        const PACKET = 188;
        const required = Math.min(3, Math.floor(u8.length / PACKET));
        if (required < 2) return false;
        for (let i = 0; i < required; i++) {
            if (u8[i * PACKET] !== 0x47) return false;
        }
        return true;
    }

    if (u8.length >= 4 + 188 && u8[4] === 0x47) {
        const M2TS = 192;
        const required = Math.min(3, Math.floor((u8.length - 4) / M2TS));
        if (required < 2) return false;
        for (let i = 0; i < required; i++) {
            if (u8[4 + i * M2TS] !== 0x47) return false;
        }
        return true;
    }

    return false;
}
