/**
 * Repair a malformed H.264 `decoderConfig.description` — the AVCDecoderConfigurationRecord
 * that becomes the MP4 `avcC` box (codec config the decoder reads before any frames).
 *
 * Observed bug: Firefox's WebCodecs `VideoEncoder` (and Opera's) can forward the underlying
 * platform encoder's extradata verbatim, and on at least the Windows Media Foundation encoder
 * ("Microsoft H.264 Encoder V1.5.3") that extradata is malformed in two consistent ways:
 *   1. Each stored SPS and PPS NAL unit has its single-byte NAL header DUPLICATED, e.g. an SPS
 *      is stored as `67 67 64 00 28 …` instead of `67 64 00 28 …` and a PPS as `68 68 ce 3c 30`
 *      instead of `68 ce 3c 30`.
 *   2. The avcC fixed-header reserved bits are ZEROED: byte[4]=0x03 (should be 0xFF) and
 *      byte[5]=0x01 (should be 0xE1).
 *
 * mediabunny (export) and mp4box (import) both write/parse the description verbatim, so the
 * corruption survives into the file and back out. Strict decoders (ffmpeg, Safari/QuickTime,
 * Firefox) parse the shifted SPS bits and fail with "sps_id out of range" / "too many reference
 * frames"; Chromium browsers play it anyway because they fall back to the correct in-band
 * SPS/PPS that precede each keyframe — hence "plays in Chrome/Opera but nowhere else".
 *
 * Repair strategy: the malformed record ALWAYS has non-compliant reserved bits, while every
 * correctly-serialized record sets them. We therefore use the reserved bits as the gate — a
 * record with compliant reserved bits is left byte-for-byte untouched (so valid Chrome/Firefox/
 * Safari descriptions, and any PPS whose first RBSP byte legitimately equals 0x68, can never be
 * altered). Only a non-compliant record is rebuilt: duplicated SPS/PPS header bytes are stripped,
 * length fields recomputed, and the reserved bits restored.
 *
 * References — NOTE: this exact symptom (duplicated SPS/PPS header byte + zeroed reserved bits)
 * is NOT documented in any public bug report as of 2026-05; the attribution below rests on direct
 * evidence (the broken file carries an in-band SEI fingerprint "Microsoft H.264 Encoder V1.5.3",
 * i.e. Windows Media Foundation, which Firefox-on-Windows uses for WebCodecs H.264) plus the
 * documented forwarding mechanism. These links establish the mechanism and precedent, not the
 * specific defect:
 *   - W3C AVC (H.264) WebCodecs registration — `description` MUST be a valid
 *     AVCDecoderConfigurationRecord: https://www.w3.org/TR/webcodecs-avc-codec-registration/
 *   - Firefox Bug 1749047 ("[WebCodecs] Implement VideoEncoder on Linux") — Firefox's WebCodecs
 *     VideoEncoder *forwards* the platform encoder's H.264 AVCC extradata rather than
 *     re-serializing it, so a malformed avcC from the OS encoder reaches JS verbatim:
 *     https://bugzilla.mozilla.org/show_bug.cgi?id=1749047
 *   - Firefox Bug 1924070 — precedent: a confirmed (fixed in Fx138) Firefox H.264 avcC extradata
 *     defect (lengthSizeMinusOne mismatch): https://bugzilla.mozilla.org/show_bug.cgi?id=1924070
 *
 * @param {BufferSource} description - the AVCDecoderConfigurationRecord bytes
 * @returns {{bytes: (Uint8Array|*), repaired: boolean, warning: (string|null)}}
 *   `bytes`: sanitized bytes, or the original (unchanged) when no repair is applied;
 *   `repaired`: true when the record was rebuilt;
 *   `warning`: a human-readable note for records that look malformed but cannot be repaired
 *   (e.g. an Annex-B description, or a truncated record), otherwise null.
 */
export function sanitizeAvcDescription(description) {
    if (!description) {
        return { bytes: description, repaired: false, warning: null };
    }

    const src = description instanceof Uint8Array
        ? description
        : ArrayBuffer.isView(description)
            ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
            : new Uint8Array(description);

    // Drop a duplicated leading NAL-header byte from one parameter-set NAL. The loop tolerates
    // more than one duplicate, but the condition can only ever match the corruption.
    const stripDuplicateHeader = (nal, expectedType) => {
        let out = nal;
        while (out.length >= 2 && out[0] === out[1] && (out[0] & 0x1f) === expectedType) {
            out = out.subarray(1);
        }
        return out;
    };

    try {
        if (src.length < 7) {
            return { bytes: src, repaired: false, warning: src.length ? 'H.264 avcC description too short to be valid' : null };
        }
        // A valid record begins with configurationVersion == 1. Anything else (e.g. an Annex-B
        // description starting 00 00 00 01) is not an avcC we know how to repair.
        if (src[0] !== 0x01) {
            return { bytes: src, repaired: false, warning: 'H.264 decoderConfig.description is not an avcC record (configurationVersion != 1); cannot repair' };
        }

        const lengthSizeByte = src[4]; // 0xFC | lengthSizeMinusOne
        const numSpsByte = src[5];     // 0xE0 | numSPS
        // Gate: the known corruption zeroes these reserved bits; a good serializer always sets
        // them. Compliant reserved bits => well-formed record => leave it completely untouched.
        const reservedBitsCompliant = (lengthSizeByte & 0xFC) === 0xFC && (numSpsByte & 0xE0) === 0xE0;
        if (reservedBitsCompliant) {
            return { bytes: src, repaired: false, warning: null };
        }

        const numSps = numSpsByte & 0x1f;
        let off = 6;
        const spsList = [];
        for (let i = 0; i < numSps; i++) {
            if (off + 2 > src.length) return { bytes: src, repaired: false, warning: 'avcC SPS table truncated; left unchanged' };
            const len = (src[off] << 8) | src[off + 1];
            off += 2;
            if (off + len > src.length) return { bytes: src, repaired: false, warning: 'avcC SPS length overruns description; left unchanged' };
            spsList.push(stripDuplicateHeader(src.subarray(off, off + len), 7));
            off += len;
        }

        if (off + 1 > src.length) return { bytes: src, repaired: false, warning: 'avcC PPS count missing; left unchanged' };
        const numPps = src[off++];
        const ppsList = [];
        for (let i = 0; i < numPps; i++) {
            if (off + 2 > src.length) return { bytes: src, repaired: false, warning: 'avcC PPS table truncated; left unchanged' };
            const len = (src[off] << 8) | src[off + 1];
            off += 2;
            if (off + len > src.length) return { bytes: src, repaired: false, warning: 'avcC PPS length overruns description; left unchanged' };
            ppsList.push(stripDuplicateHeader(src.subarray(off, off + len), 8));
            off += len;
        }

        // Any High-profile trailing block (chroma_format, bit depths, SPS-ext) is copied verbatim.
        const trailing = src.subarray(off);

        const out = [
            src[0], src[1], src[2], src[3],
            0xFC | (lengthSizeByte & 0x03), // restore spec-compliant reserved bits
            0xE0 | (spsList.length & 0x1f),
        ];
        for (const sps of spsList) out.push((sps.length >> 8) & 0xff, sps.length & 0xff, ...sps);
        out.push(ppsList.length & 0xff);
        for (const pps of ppsList) out.push((pps.length >> 8) & 0xff, pps.length & 0xff, ...pps);
        for (let i = 0; i < trailing.length; i++) out.push(trailing[i]);

        return { bytes: new Uint8Array(out), repaired: true, warning: null };
    } catch (e) {
        // Never let sanitization break an otherwise-working pipeline.
        return { bytes: src, repaired: false, warning: 'H.264 avcC sanitization failed: ' + (e && e.message ? e.message : e) };
    }
}
