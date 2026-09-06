// Add synchronous KLV to the single-program H.264 TS produced by this runner's
// ffmpeg remux. Preserve every video packet/PCR/PTS and interleave one metadata
// PES per video frame, using that video's exact PTS (including encoder delay).
// This intentionally rejects other layouts rather than acting as a general muxer.
import {Buffer} from "buffer";

export function mpegCRC(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte << 24;
        for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    return crc >>> 0;
}
const pidOf = p => ((p[1] & 31) << 8) | p[2];
const payloadAt = p => 4 + (p[3] & 0x20 ? 1 + p[4] : 0);
const ptsValue = b => (b[0] & 14) * 2 ** 29 + b[1] * 2 ** 22 + (b[2] & 254) * 2 ** 14 + b[3] * 128 + (b[4] >> 1);

export function muxVideoKlv(input, records, fps = 30) {
    const ts = Buffer.from(input);
    if (!ts.length || ts.length % 188) throw new Error("Expected 188-byte TS packets");
    const output = [], seen = new Set();
    const klvPID = 0x101;
    let pmtPID, videoPID, firstPTS, cc = 0, pmtCount = 0;
    for (let offset = 0; offset < ts.length; offset += 188) {
        let packet = ts.subarray(offset, offset + 188);
        if (packet[0] !== 0x47) throw new Error("TS sync byte missing");
        const pid = pidOf(packet), start = !!(packet[1] & 0x40), p = payloadAt(packet);
        if (pid === klvPID) throw new Error("Metadata PID already in use");
        if (pid === 0 && start) {
            const s = p + 1 + packet[p];
            if (packet.readUInt16BE(s + 8) !== 1) throw new Error("Expected program 1 PAT");
            pmtPID = packet.readUInt16BE(s + 10) & 0x1fff;
        }
        if (pid === pmtPID) {
            if (!start) throw new Error("Multi-packet PMT is unsupported");
            const s = p + 1 + packet[p], length = (packet.readUInt16BE(s + 1) & 4095) + 3;
            if (s + length > 188) throw new Error("Split PMT is unsupported");
            const section = packet.subarray(s, s + length - 4);
            const es = 12 + (section.readUInt16BE(10) & 4095);
            if (section[es] !== 0x1b) throw new Error("Expected H.264 video");
            if (es + 5 + (section.readUInt16BE(es + 3) & 4095) !== section.length) throw new Error("Expected only one video stream");
            videoPID = section.readUInt16BE(es + 1) & 0x1fff;
            // H.222.0 metadata_descriptor: application 0x0100, format KLVA,
            // service 0. Both registration and metadata descriptors aid readers.
            const descriptors = Buffer.from([5,4,75,76,86,65, 0x26,9,1,0,0xff,75,76,86,65,0,0x0f]);
            const entry = Buffer.from([0x15,0xe0 | (klvPID >> 8),klvPID & 255,0xf0,descriptors.length]);
            const replacement = Buffer.concat([section, entry, descriptors, Buffer.alloc(4)]);
            replacement.writeUInt16BE(0xb000 | (replacement.length - 3), 1);
            replacement.writeUInt32BE(mpegCRC(replacement.subarray(0, -4)), replacement.length - 4);
            if (replacement.length + 5 > 188) throw new Error("Expanded PMT does not fit one packet");
            const updated = Buffer.alloc(188, 255);
            packet.copy(updated, 0, 0, 4); updated[3] = 0x10 | (packet[3] & 15); updated[4] = 0;
            replacement.copy(updated, 5); packet = updated; pmtCount++;
        }
        output.push(packet);
        if (pid !== videoPID || !start) continue;
        if (packet.readUIntBE(p, 3) !== 1 || !(packet[p + 7] & 0x80)) throw new Error("Video PES lacks PTS");
        const ptsBytes = Buffer.from(packet.subarray(p + 9, p + 14));
        const pts = ptsValue(ptsBytes);
        firstPTS ??= pts;
        const f = Math.round((pts - firstPTS) * fps / 90000);
        if (f < 0 || f >= records.length || seen.has(f) || Math.abs(pts - firstPTS - f * 90000 / fps) > 1) {
            throw new Error(`Unexpected video frame timing at PTS ${pts}`);
        }
        seen.add(f);
        const klv = Buffer.from(records[f].klv);
        // Metadata AU cell: service 0, sequence, complete AU, no decoder
        // config, random access, reserved bits set (0xdf; H.222.0 2.12.4.2).
        // 16-bit AU length. Stream id 0xfc is synchronous metadata.
        if (klv.length > 65522) throw new Error("KLV record exceeds one PES packet");
        const au = Buffer.from([0, f & 255, 0xdf, klv.length >> 8, klv.length & 255]);
        const header = Buffer.from([0,0,1,0xfc,0,0,0x84,0x80,5]);
        header.writeUInt16BE(8 + au.length + klv.length, 4);
        ptsBytes[0] = (ptsBytes[0] & 15) | 0x20;
        const pes = Buffer.concat([header, ptsBytes, au, klv]);
        for (let at = 0; at < pes.length;) {
            const take = Math.min(184, pes.length - at), out = Buffer.alloc(188, 255);
            out[0] = 0x47; out[1] = (at === 0 ? 0x40 : 0) | (klvPID >> 8); out[2] = klvPID & 255;
            out[3] = (take < 184 ? 0x30 : 0x10) | (cc++ & 15);
            const dest = 188 - take;
            if (take < 184) { out[4] = 183 - take; if (out[4]) out[5] = 0; }
            pes.copy(out, dest, at, at + take); output.push(out); at += take;
        }
    }
    if (!pmtCount || seen.size !== records.length) throw new Error(`Muxed ${seen.size} frames for ${records.length} metadata records`);
    return Buffer.concat(output);
}
