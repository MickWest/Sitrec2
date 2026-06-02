const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

const STREAM_TYPE_NAMES = {
    0x01: "MPEG1 Video",
    0x02: "MPEG2 Video",
    0x03: "MPEG1 Audio",
    0x04: "MPEG2 Audio",
    0x06: "PES Private Data",
    0x0F: "AAC",
    0x11: "AAC",
    0x15: "Metadata",
    0x1B: "H.264/AVC",
    0x24: "H.265/HEVC",
    0x81: "AC3",
    0x86: "SCTE-35",
    0x87: "E-AC3",
    0xF0: "ECM",
    0xF1: "EMM",
};

function fileSize(fileLike) {
    return fileLike?.size ?? fileLike?.byteLength ?? fileLike?.length ?? 0;
}

async function readSlice(fileLike, start, end) {
    if (!fileLike) {
        throw new Error("Missing file-like object");
    }
    if (typeof fileLike.slice === "function") {
        const part = fileLike.slice(start, end);
        if (part instanceof Uint8Array) {
            return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
        }
        if (part instanceof ArrayBuffer) {
            return part;
        }
        if (typeof part.arrayBuffer === "function") {
            return await part.arrayBuffer();
        }
    }
    if (fileLike instanceof Uint8Array) {
        return fileLike.slice(start, end).buffer;
    }
    if (fileLike instanceof ArrayBuffer) {
        return fileLike.slice(start, end);
    }
    if (typeof fileLike.arrayBuffer === "function" && start === 0 && end >= fileSize(fileLike)) {
        return await fileLike.arrayBuffer();
    }
    throw new Error("File-like object must provide size and slice(start, end).arrayBuffer()");
}

function scorePacketLayout(sample, stride, syncOffset) {
    let matches = 0;
    let checks = 0;
    for (let pos = syncOffset; pos < sample.length; pos += stride) {
        checks++;
        if (sample[pos] === TS_SYNC_BYTE) matches++;
        if (checks >= 64) break;
    }
    if (checks < 3) return 0;
    return matches / checks;
}

export async function detectTransportStreamLayout(fileLike) {
    const size = fileSize(fileLike);
    const sampleSize = Math.min(size, 1024 * 1024);
    if (sampleSize < TS_PACKET_SIZE * 3) {
        throw new Error("File is too small to be a transport stream");
    }
    const sample = new Uint8Array(await readSlice(fileLike, 0, sampleSize));
    const candidates = [];
    for (const stride of [188, 192]) {
        for (let offset = 0; offset < stride; offset++) {
            const score = scorePacketLayout(sample, stride, offset);
            if (score >= 0.85) {
                candidates.push({packetStride: stride, syncOffset: offset, score});
            }
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.syncOffset - b.syncOffset);
    const best = candidates[0];
    if (!best) {
        throw new Error("No MPEG transport-stream sync pattern found");
    }
    return {
        packetSize: TS_PACKET_SIZE,
        packetStride: best.packetStride,
        syncOffset: best.syncOffset,
        prefixBytes: Math.max(0, best.packetStride - TS_PACKET_SIZE),
        score: best.score,
    };
}

function parseTsHeader(packet) {
    if (!packet || packet.length < TS_PACKET_SIZE || packet[0] !== TS_SYNC_BYTE) {
        return null;
    }
    const header1 = packet[1];
    const header2 = packet[2];
    const header3 = packet[3];
    const transportErrorIndicator = (header1 & 0x80) !== 0;
    const payloadUnitStartIndicator = (header1 & 0x40) !== 0;
    const pid = ((header1 & 0x1F) << 8) | header2;
    const adaptationFieldControl = (header3 & 0x30) >> 4;
    if (transportErrorIndicator || pid === 0x1FFF) return null;

    let payloadStart = 4;
    if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
        const adaptationFieldLength = packet[4];
        payloadStart += 1 + adaptationFieldLength;
    }
    const hasPayload = (adaptationFieldControl === 1 || adaptationFieldControl === 3)
        && payloadStart < TS_PACKET_SIZE;

    return {
        pid,
        payloadUnitStartIndicator,
        adaptationFieldControl,
        payloadStart,
        hasPayload,
    };
}

async function scanTransportPackets(fileLike, layout, onPacket, {
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress = null,
    phase = "scan",
} = {}) {
    const size = fileSize(fileLike);
    const packetsPerChunk = Math.max(1, Math.floor(chunkSize / layout.packetStride));
    const alignedChunkSize = packetsPerChunk * layout.packetStride;
    let readOffset = layout.syncOffset;
    let packetCount = 0;

    while (readOffset + TS_PACKET_SIZE <= size) {
        const readEnd = Math.min(size, readOffset + alignedChunkSize);
        const chunk = new Uint8Array(await readSlice(fileLike, readOffset, readEnd));
        for (let local = 0; local + TS_PACKET_SIZE <= chunk.length; local += layout.packetStride) {
            const packet = chunk.subarray(local, local + TS_PACKET_SIZE);
            if (packet[0] === TS_SYNC_BYTE) {
                onPacket(packet, readOffset + local);
                packetCount++;
            }
        }
        readOffset += alignedChunkSize;
        if (onProgress) {
            onProgress({phase, loaded: Math.min(readOffset, size), total: size});
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return packetCount;
}

function createSectionCollector() {
    const seenSections = new Set();
    let current = null;
    let written = 0;

    function finish(section) {
        const key = `${section[0]}:${section[3]}:${section[4]}:${section.length}:${section[5]}`;
        if (seenSections.has(key)) return null;
        seenSections.add(key);
        return section;
    }

    return {
        push(packet, header) {
            const out = [];
            if (!header?.hasPayload) return out;
            let p = header.payloadStart;

            if (header.payloadUnitStartIndicator) {
                if (p >= TS_PACKET_SIZE) return out;
                const pointerField = packet[p];
                p += 1 + pointerField;
                current = null;
                written = 0;
                if (p >= TS_PACKET_SIZE || p + 3 > TS_PACKET_SIZE) return out;
                const sectionLen = ((packet[p + 1] & 0x0f) << 8) | packet[p + 2];
                current = new Uint8Array(3 + sectionLen);
            } else if (!current) {
                return out;
            }

            const toCopy = Math.min(current.length - written, TS_PACKET_SIZE - p);
            if (toCopy > 0) {
                current.set(packet.subarray(p, p + toCopy), written);
                written += toCopy;
            }
            if (written >= current.length) {
                const section = finish(current);
                if (section) out.push(section);
                current = null;
                written = 0;
            }
            return out;
        },
    };
}

function parsePAT(section) {
    if (!section || section[0] !== 0x00) return [];
    const sectionLen = ((section[1] & 0x0f) << 8) | section[2];
    const tsid = (section[3] << 8) | section[4];
    const entriesEnd = 3 + sectionLen - 4;
    const out = [];
    for (let i = 8; i + 3 < entriesEnd; i += 4) {
        const programNumber = (section[i] << 8) | section[i + 1];
        const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
        if (programNumber !== 0) {
            out.push({program_number: programNumber, pmt_pid: pid, ts_id: tsid});
        }
    }
    return out;
}

function parsePMT(section) {
    if (!section || section[0] !== 0x02) return null;
    const sectionLen = ((section[1] & 0x0f) << 8) | section[2];
    const programNumber = (section[3] << 8) | section[4];
    const pcrPid = ((section[8] & 0x1f) << 8) | section[9];
    const progInfoLen = ((section[10] & 0x0f) << 8) | section[11];
    let p = 12 + progInfoLen;
    const entriesEnd = 3 + sectionLen - 4;
    const streams = [];

    while (p + 5 <= entriesEnd) {
        const streamType = section[p];
        p += 1;
        const elementaryPid = ((section[p] & 0x1f) << 8) | section[p + 1];
        p += 2;
        const esInfoLen = ((section[p] & 0x0f) << 8) | section[p + 1];
        p += 2;
        const esEnd = p + esInfoLen;
        const descriptors = [];

        while (p + 2 <= esEnd) {
            const tag = section[p];
            const len = section[p + 1];
            const body = section.subarray(p + 2, p + 2 + len);
            if (tag === 0x05 && len >= 4) {
                descriptors.push({tag, name: "registration", format_identifier: String.fromCharCode(...body.subarray(0, 4))});
            } else if (tag === 0x0A && len >= 3) {
                descriptors.push({tag, name: "language", lang: String.fromCharCode(...body.subarray(0, 3))});
            } else {
                let foundKLVA = false;
                for (let i = 0; i <= len - 4; i++) {
                    if (String.fromCharCode(...body.subarray(i, i + 4)) === "KLVA") {
                        descriptors.push({tag, name: "registration", format_identifier: "KLVA"});
                        foundKLVA = true;
                        break;
                    }
                }
                if (!foundKLVA) {
                    descriptors.push({tag, length: len, data: len <= 16 ? Array.from(body) : undefined});
                }
            }
            p += 2 + len;
        }

        streams.push({
            stream_type_int: streamType,
            stream_type_name: STREAM_TYPE_NAMES[streamType] || "Unknown",
            elementary_pid: elementaryPid,
            descriptors,
        });
    }

    return {
        program_number: programNumber,
        pcr_pid: pcrPid,
        streams,
    };
}

function codecNameForStream(stream) {
    const registration = stream.descriptors.find(d => d.name === "registration")?.format_identifier;
    if (registration === "KLVA") return "klv";
    switch (stream.stream_type_int) {
        case 0x01: return "mpeg1video";
        case 0x02: return "mpeg2video";
        case 0x03:
        case 0x04: return "mp3";
        case 0x06: return registration || "private_data";
        case 0x0F:
        case 0x11: return "aac";
        case 0x15: return registration === "KLVA" ? "klv" : "timed_id3";
        case 0x1B: return "h264";
        case 0x24: return "hevc";
        case 0x81: return "ac3";
        case 0x87: return "eac3";
        case 0xF0: return "ecm";
        case 0xF1: return "emm";
        default: return "unknown";
    }
}

function codecTypeForName(codecName) {
    if (["h264", "hevc", "mpeg1video", "mpeg2video"].includes(codecName)) return "video";
    if (["aac", "mp3", "ac3", "eac3"].includes(codecName)) return "audio";
    if (["klv", "timed_id3", "ecm", "emm", "private_data"].includes(codecName)) return "data";
    return "unknown";
}

function normalizePrograms(patEntriesByProgram, pmtByPid) {
    const programs = [];
    for (const entry of patEntriesByProgram.values()) {
        const pmt = pmtByPid.get(entry.pmt_pid);
        if (!pmt) continue;
        const streams = pmt.streams.map((stream, index) => {
            const codec_name = codecNameForStream(stream);
            return {
                index,
                pid: stream.elementary_pid,
                id: `0x${stream.elementary_pid.toString(16)}`,
                codec_name,
                codec_type: codecTypeForName(codec_name),
                stream_type: `0x${stream.stream_type_int.toString(16).padStart(2, "0")}`,
                stream_type_int: stream.stream_type_int,
                stream_type_name: stream.stream_type_name,
                descriptors: stream.descriptors,
                program_number: entry.program_number,
                pmt_pid: entry.pmt_pid,
                ts_id: entry.ts_id,
            };
        });
        programs.push({
            program_id: entry.program_number,
            program_num: entry.program_number,
            pmt_pid: entry.pmt_pid,
            pcr_pid: pmt.pcr_pid,
            ts_id: entry.ts_id,
            nb_streams: streams.length,
            streams,
        });
    }
    const streams = programs.flatMap(program => program.streams);
    streams.forEach((stream, index) => {
        stream.index = index;
    });
    return {programs, streams};
}

export async function probeTransportStreamFile(fileLike, options = {}) {
    const layout = options.layout || await detectTransportStreamLayout(fileLike);
    const patCollector = createSectionCollector();
    const pmtCollectors = new Map();
    const patEntriesByProgram = new Map();
    const pmtByPid = new Map();

    await scanTransportPackets(fileLike, layout, (packet) => {
        const header = parseTsHeader(packet);
        if (!header) return;

        if (header.pid === 0x0000) {
            for (const section of patCollector.push(packet, header)) {
                for (const entry of parsePAT(section)) {
                    patEntriesByProgram.set(entry.program_number, entry);
                    if (!pmtCollectors.has(entry.pmt_pid)) {
                        pmtCollectors.set(entry.pmt_pid, createSectionCollector());
                    }
                }
            }
        } else if (pmtCollectors.has(header.pid)) {
            const collector = pmtCollectors.get(header.pid);
            for (const section of collector.push(packet, header)) {
                const pmt = parsePMT(section);
                if (pmt) pmtByPid.set(header.pid, pmt);
            }
        }
    }, {
        ...options,
        phase: "probe",
    });

    const analysis = normalizePrograms(patEntriesByProgram, pmtByPid);
    return {...analysis, layout};
}

function parsePesStart(packet, payloadStart) {
    if (payloadStart + 9 > TS_PACKET_SIZE) {
        return {pesHeaderSkip: 0, ptsUs: null, hasPesStart: false};
    }
    if (packet[payloadStart] !== 0x00 || packet[payloadStart + 1] !== 0x00 || packet[payloadStart + 2] !== 0x01) {
        return {pesHeaderSkip: 0, ptsUs: null, hasPesStart: false};
    }

    const streamId = packet[payloadStart + 3];
    if (!((streamId >= 0xE0 && streamId <= 0xEF) || (streamId >= 0xBD && streamId <= 0xFF))) {
        return {pesHeaderSkip: 0, ptsUs: null, hasPesStart: true};
    }

    const pesHeaderDataLength = packet[payloadStart + 8];
    const pesHeaderSkip = 9 + pesHeaderDataLength;
    const pesFlags = packet[payloadStart + 7];
    let ptsUs = null;

    if ((pesFlags & 0x80) && payloadStart + 14 <= TS_PACKET_SIZE) {
        const p0 = packet[payloadStart + 9];
        const p1 = packet[payloadStart + 10];
        const p2 = packet[payloadStart + 11];
        const p3 = packet[payloadStart + 12];
        const p4 = packet[payloadStart + 13];
        const ptsTicks =
            ((p0 & 0x0E) * (1 << 29)) +
            (p1 * (1 << 22)) +
            ((p2 & 0xFE) * (1 << 14)) +
            (p3 * (1 << 7)) +
            ((p4 & 0xFE) >> 1);
        ptsUs = (ptsTicks * 1000) / 90;
    }

    return {pesHeaderSkip, ptsUs, hasPesStart: true};
}

function isVideoStream(streamInfo) {
    return streamInfo?.codec_type === "video"
        || ["h264", "hevc", "mpeg1video", "mpeg2video"].includes(streamInfo?.codec_name);
}

function isKlvCandidateStream(streamInfo) {
    if (!streamInfo) return false;
    if (streamInfo.codec_name === "klv") return true;
    if (streamInfo.stream_type_int === 0x06) return true;
    return streamInfo.descriptors?.some(d => d.name === "registration" && d.format_identifier === "KLVA");
}

function concatChunks(chunks, totalLength) {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out.buffer;
}

export async function scanTransportStreamForMetadata(fileLike, options = {}) {
    const probe = options.probe || await probeTransportStreamFile(fileLike, options);
    if (!probe.streams.length) {
        return {
            ...probe,
            videoStreams: [],
            metadataStreams: [],
            videoFirstPESus: null,
            packetCount: 0,
        };
    }

    const streamsByPid = new Map(probe.streams.map(stream => [stream.pid, {
        ...stream,
        pesEntries: [],
        totalPayloadBytes: 0,
        capturedPayloadBytes: 0,
    }]));
    const klvCandidatePids = new Set(probe.streams.filter(isKlvCandidateStream).map(stream => stream.pid));
    const streamChunks = new Map();
    const streamAccLen = new Map();
    const pendingHeaderSkip = new Map();

    for (const stream of probe.streams) {
        streamAccLen.set(stream.pid, 0);
        if (klvCandidatePids.has(stream.pid)) {
            streamChunks.set(stream.pid, []);
        }
    }

    const packetCount = await scanTransportPackets(fileLike, probe.layout, (packet) => {
        const header = parseTsHeader(packet);
        if (!header?.hasPayload || !streamsByPid.has(header.pid)) return;
        const streamInfo = streamsByPid.get(header.pid);
        let payloadStart = header.payloadStart;
        let pesPtsUs = null;

        if (header.payloadUnitStartIndicator) {
            const pesInfo = parsePesStart(packet, payloadStart);
            if (pesInfo.hasPesStart) {
                pesPtsUs = pesInfo.ptsUs;
                const payloadBytesAvailable = Math.max(0, TS_PACKET_SIZE - payloadStart);
                if (pesInfo.pesHeaderSkip > payloadBytesAvailable) {
                    pendingHeaderSkip.set(header.pid, pesInfo.pesHeaderSkip - payloadBytesAvailable);
                    payloadStart = TS_PACKET_SIZE;
                } else {
                    payloadStart += pesInfo.pesHeaderSkip;
                    pendingHeaderSkip.set(header.pid, 0);
                }
            }
        } else {
            const skip = pendingHeaderSkip.get(header.pid) || 0;
            if (skip > 0) {
                const applied = Math.min(skip, Math.max(0, TS_PACKET_SIZE - payloadStart));
                payloadStart += applied;
                pendingHeaderSkip.set(header.pid, skip - applied);
            }
        }

        if (pesPtsUs !== null) {
            streamInfo.pesEntries.push({
                offset: streamAccLen.get(header.pid) || 0,
                ptsUs: pesPtsUs,
            });
        }

        if (payloadStart >= TS_PACKET_SIZE) return;
        const payload = packet.subarray(payloadStart, TS_PACKET_SIZE);
        if (!payload.length) return;

        streamInfo.totalPayloadBytes += payload.length;
        streamAccLen.set(header.pid, (streamAccLen.get(header.pid) || 0) + payload.length);
        if (klvCandidatePids.has(header.pid)) {
            streamChunks.get(header.pid).push(payload.slice());
            streamInfo.capturedPayloadBytes += payload.length;
        }
    }, {
        ...options,
        phase: "extract",
    });

    const streams = [...streamsByPid.values()];
    const metadataStreams = streams
        .filter(stream => klvCandidatePids.has(stream.pid))
        .map(stream => ({
            ...stream,
            data: concatChunks(streamChunks.get(stream.pid) || [], stream.capturedPayloadBytes),
        }));
    const videoStreams = streams.filter(isVideoStream);
    const firstVideoWithPTS = videoStreams.find(stream => stream.pesEntries.length > 0);
    const videoFirstPESus = firstVideoWithPTS?.pesEntries[0]?.ptsUs ?? null;

    return {
        ...probe,
        streams,
        metadataStreams,
        videoStreams,
        videoFirstPESus,
        packetCount,
    };
}

export function getPrimaryVideoPTSus(scan) {
    const primary = scan?.videoStreams?.find(stream => stream.pesEntries?.length > 0);
    if (!primary) return [];
    const origin = scan.videoFirstPESus ?? primary.pesEntries[0].ptsUs;
    return primary.pesEntries.map(entry => entry.ptsUs - origin);
}

export function getPrimaryVideoStream(scan) {
    return scan?.videoStreams?.find(stream => stream.pesEntries?.length > 0) || null;
}
