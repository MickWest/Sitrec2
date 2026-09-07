// Add synchronous KLV to the single-program H.264 TS produced by the runners.
// The default is one record at each video PTS. An explicit sparse schedule can
// instead exercise uneven metadata timing and optional AAC audio carriage.
// Preserve video/audio payloads and PCR/PTS; this is not a general-purpose muxer.
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
export function encodePTS(pts) {
    if (!Number.isSafeInteger(pts) || pts < 0 || pts >= 2 ** 33) throw new Error("PTS outside 33-bit clock");
    return Buffer.from([0x21 | (Math.floor(pts / 2 ** 29) & 14), Math.floor(pts / 2 ** 22) & 255,
        1 | (Math.floor(pts / 2 ** 14) & 254), Math.floor(pts / 128) & 255, 1 | ((pts % 128) * 2)]);
}

export function muxVideoKlv(input, records, fps = 30, {klvPID = 0x101, metadataSamples,
    allowAudio = false, sequenceCounter = true, tablePacketPeriod = 0} = {}) {
    const ts = Buffer.from(input);
    if (!ts.length || ts.length % 188) throw new Error("Expected 188-byte TS packets");
    const output = [], seen = new Set();
    if (metadataSamples && (!metadataSamples.length || metadataSamples.some((s, i) =>
        !Number.isSafeInteger(s.ptsOffset90k) || s.ptsOffset90k < 0
        || s.ptsOffset90k > (records.length - 1) * 90000 / fps
        || (i && s.ptsOffset90k <= metadataSamples[i - 1].ptsOffset90k)))) throw new Error("Invalid metadata schedule");
    let pmtPID, videoPID, firstPTS, cc = 0, pmtCount = 0, emitted = 0;
    function emit(klvBytes, pts) {
        const klv = Buffer.from(klvBytes);
        if (klv.length > 65522) throw new Error("KLV record exceeds one PES packet");
        // Complete, random-access metadata AU; service zero, reserved bits set.
        const au = Buffer.from([0, sequenceCounter ? emitted & 255 : 0, 0xdf, klv.length >> 8, klv.length & 255]);
        const header = Buffer.from([0,0,1,0xfc,0,0,0x84,0x80,5]);
        header.writeUInt16BE(8 + au.length + klv.length, 4);
        const pes = Buffer.concat([header, encodePTS(pts), au, klv]);
        for (let at = 0; at < pes.length;) {
            const take = Math.min(184, pes.length - at), out = Buffer.alloc(188, 255);
            out[0] = 0x47; out[1] = (at === 0 ? 0x40 : 0) | (klvPID >> 8); out[2] = klvPID & 255;
            out[3] = (take < 184 ? 0x30 : 0x10) | (cc++ & 15);
            const dest = 188 - take;
            if (take < 184) { out[4] = 183 - take; if (out[4]) out[5] = 0; }
            pes.copy(out, dest, at, at + take); output.push(out); at += take;
        }
        emitted++;
    }
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
            let videos = 0, audio = 0;
            for (let es = 12 + (section.readUInt16BE(10) & 4095); es < section.length;) {
                if (section[es] === 0x1b) { videoPID = section.readUInt16BE(es + 1) & 0x1fff; videos++; }
                else if (allowAudio && section[es] === 0x0f) audio++;
                else throw new Error("Expected H.264 with optional AAC audio");
                es += 5 + (section.readUInt16BE(es + 3) & 4095);
                if (es > section.length) throw new Error("Invalid elementary stream descriptor length");
            }
            if (videos !== 1 || audio > 1) throw new Error("Expected one video and at most one audio stream");
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
        const pts = ptsValue(packet.subarray(p + 9, p + 14));
        firstPTS ??= pts;
        const f = Math.round((pts - firstPTS) * fps / 90000);
        if (f < 0 || f >= records.length || seen.has(f) || Math.abs(pts - firstPTS - f * 90000 / fps) > 1) {
            throw new Error(`Unexpected video frame timing at PTS ${pts}`);
        }
        seen.add(f);
        if (!metadataSamples) emit(records[f].klv, pts);
        else while (emitted < metadataSamples.length && metadataSamples[emitted].ptsOffset90k <= pts - firstPTS) {
            const sample = metadataSamples[emitted];
            emit(sample.klv, firstPTS + sample.ptsOffset90k);
        }
    }
    if (!pmtCount || seen.size !== records.length) throw new Error(`Muxed ${seen.size} frames for ${records.length} metadata records`);
    if (metadataSamples && emitted !== metadataSamples.length) throw new Error("Unemitted metadata samples");
    if (tablePacketPeriod) {
        if (!Number.isInteger(tablePacketPeriod) || tablePacketPeriod < 1) throw new Error("Invalid table packet period");
        const tables = [output.find(p => pidOf(p) === 0), output.find(p => pidOf(p) === pmtPID)];
        const repeated = [];
        let count = 0, tableCC = 0;
        for (const packet of output) {
            const pid = pidOf(packet);
            if (pid === 0 || pid === pmtPID || pid === 0x11) continue;
            if (count++ % tablePacketPeriod === 0) {
                for (const table of tables) {
                    const next = Buffer.from(table); next[3] = (next[3] & 0xf0) | (tableCC & 15); repeated.push(next);
                }
                tableCC++;
            }
            repeated.push(packet);
        }
        return Buffer.concat(repeated);
    }
    return Buffer.concat(output);
}
