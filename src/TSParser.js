import {showError} from "./showError";
import {hideProgress, initProgress, updateProgress} from "./CProgressIndicator";

/**
 * Transport Stream (TS) Parser
 * Handles parsing of MPEG Transport Stream files and extraction of individual streams
 */
export class TSParser {

    /**
     * Parse TS (Transport Stream) files and extract individual streams
     * @param {string} filename - The filename of the TS file
     * @param {string} id - The file ID
     * @param {ArrayBuffer} buffer - The TS file buffer
     * @param {Function} parseAssetCallback - Callback function to parse extracted streams
     * @returns {Promise} Promise that resolves to array of parsed streams
     */
    static async parseTSFile(filename, id, buffer, parseAssetCallback) {
        // Show a progress indicator covering the synchronous extraction phase.
        // For a 700 MB .ts file the per-packet scan can run ~10 seconds; without
        // an indicator the UI looks frozen between FileReader completion and the
        // video decoder taking over. The DragDropHandler's own indicator covers
        // the upstream FileReader read; this one covers the parse step.
        const shortName = filename.split('/').pop();
        initProgress({title: 'Parsing transport stream', filename: shortName});
        updateProgress({status: 'Extracting streams...', loaded: 0, total: buffer.byteLength});
        try {
            const streams = await TSParser.extractTSStreamsAsync(buffer);

            if (streams.length === 0) {
                hideProgress();
                return [];
            }

            updateProgress({status: 'Decoding substreams...', percent: 100});

            // Create promises for each extracted stream
            const streamPromises = streams.map(stream => {
                const streamFilename = filename + "_" + stream.type + "_" + stream.pid + "." + stream.extension;
                // Pass stream metadata along with the data
                return parseAssetCallback(streamFilename, id, stream.data, stream);
            });

            // Wait for all streams to be processed
            const results = await Promise.all(streamPromises);
            hideProgress();
            return results;

        } catch (error) {
            hideProgress();
            showError('Error parsing TS file:', error);
            throw error;
        }
    }

    /**
     * Extract streams from TS buffer using proper PSI parsing.
     * Async + yields periodically so big files don't lock the UI for the
     * full duration of the per-packet scan (~10 s on a 700 MB .ts on the
     * main thread). Updates the shared progress indicator if one is open;
     * the caller controls the surrounding initProgress / hideProgress.
     * @param {ArrayBuffer} buffer - The TS file buffer
     * @returns {Promise<Array>} Array of extracted streams
     */
    static async extractTSStreamsAsync(buffer) {
        try {
            // Use the new detailed analysis to get stream information
            const analysis = TSParser.probeTransportStreamBufferDetailed(buffer);
            
            if (!analysis.programs || analysis.programs.length === 0) {
                console.log('extractTSStreams: No programs found in transport stream');
                return [];
            }

            const streams = [];
            const uint8Array = new Uint8Array(buffer);
            const streamData = new Map(); // PID -> accumulated data
            
            // Get elementary stream PIDs and their types from analysis
            const elementaryStreams = new Map(); // PID -> stream info
            for (const program of analysis.programs) {
                for (const stream of program.streams) {
                    const pid = parseInt(stream.id, 16);
                    
                    // Parse FPS from r_frame_rate if available (format: "num/den")
                    let fps = null;
                    if (stream.r_frame_rate && stream.r_frame_rate !== "0/0") {
                        const [num, den] = stream.r_frame_rate.split('/').map(Number);
                        if (den && den !== 0) {
                            fps = num / den;
                        }
                    }
                    
                    elementaryStreams.set(pid, {
                        codec_name: stream.codec_name,
                        codec_type: stream.codec_type,
                        stream_type: stream.stream_type,
                        descriptors: stream.descriptors,
                        fps: fps,
                        width: stream.width,
                        height: stream.height
                    });
                }
            }

            console.log(`extractTSStreams: Found ${elementaryStreams.size} elementary streams to extract`);

            // Extract payload data for each elementary stream
            const packetSize = 188;
            // Yield to the event loop every ~100K packets (~18 MB scanned).
            // At ~100 ns per packet that's ~10 ms of work between yields —
            // close enough to a 60 fps frame budget that the UI stays
            // responsive and the progress bar can repaint.
            const YIELD_INTERVAL = 100000;
            let nextYieldOffset = YIELD_INTERVAL * packetSize;
            const totalBytes = uint8Array.length;
            for (let offset = 0; offset < uint8Array.length - packetSize; offset += packetSize) {
                if (offset >= nextYieldOffset) {
                    nextYieldOffset += YIELD_INTERVAL * packetSize;
                    updateProgress({status: 'Extracting streams...', loaded: offset, total: totalBytes});
                    await new Promise(r => setTimeout(r, 0));
                }
                // Check for sync byte (0x47)
                if (uint8Array[offset] !== 0x47) {
                    // Try to find next sync byte
                    let found = false;
                    for (let i = offset + 1; i < uint8Array.length - packetSize; i++) {
                        if (uint8Array[i] === 0x47) {
                            offset = i;
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                }

                // Parse TS header
                const header1 = uint8Array[offset + 1];
                const header2 = uint8Array[offset + 2];
                const header3 = uint8Array[offset + 3];

                const transportErrorIndicator = (header1 & 0x80) !== 0;
                const payloadUnitStartIndicator = (header1 & 0x40) !== 0;
                const pid = ((header1 & 0x1F) << 8) | header2;
                const adaptationFieldControl = (header3 & 0x30) >> 4;

                // Skip error packets and null packets
                if (transportErrorIndicator || pid === 0x1FFF) continue;

                // Only process elementary stream PIDs
                if (!elementaryStreams.has(pid)) continue;

                let payloadStart = 4;

                // Handle adaptation field
                if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
                    const adaptationFieldLength = uint8Array[offset + 4];
                    payloadStart += 1 + adaptationFieldLength;
                }

                // Skip if no payload
                if (adaptationFieldControl === 2 || payloadStart >= packetSize) continue;

                // Handle PES packet boundaries
                // When PAYLOAD_UNIT_START_INDICATOR is set, this packet starts a new PES packet
                // We need to skip the PES header to get the actual elementary stream data
                let pesHeaderSkip = 0;
                if (payloadUnitStartIndicator) {
                    // Check for PES start code: 0x00 0x00 0x01
                    if (offset + payloadStart + 3 <= uint8Array.length &&
                        uint8Array[offset + payloadStart] === 0x00 &&
                        uint8Array[offset + payloadStart + 1] === 0x00 &&
                        uint8Array[offset + payloadStart + 2] === 0x01) {
                        
                        const streamId = uint8Array[offset + payloadStart + 3];
                        // Check if this is a video stream (0xE0-0xEF) or private stream
                        if ((streamId >= 0xE0 && streamId <= 0xEF) || (streamId >= 0xBD && streamId <= 0xFF)) {
                            // PES packet structure: start_code(3) + stream_id(1) + length(2) + header_data
                            // Parse PES header length to know where ES data starts
                            if (offset + payloadStart + 9 <= uint8Array.length) {
                                const pesDataLength = uint8Array[offset + payloadStart + 8];
                                // Standard PES header: 6 (start_code + stream_id + length) + 3 (mandatory fields) + pesDataLength (optional)
                                pesHeaderSkip = 9 + pesDataLength;
                            }
                        }
                    }
                }

                // Extract payload data, skipping PES header if present
                const dataStart = offset + payloadStart + pesHeaderSkip;
                const dataEnd = offset + packetSize;
                
                if (dataStart < dataEnd) {
                    const payloadData = uint8Array.slice(dataStart, dataEnd);
                    if (payloadData.length > 0) {
                        if (!streamData.has(pid)) {
                            streamData.set(pid, []);
                        }
                        streamData.get(pid).push(payloadData);
                    }
                }
            }

            // Convert accumulated data to streams
            for (const [pid, dataChunks] of streamData.entries()) {
                if (dataChunks.length === 0) continue;

                const streamInfo = elementaryStreams.get(pid);
                if (!streamInfo) continue;

                // Concatenate all data chunks for this PID
                const totalLength = dataChunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const concatenatedData = new Uint8Array(totalLength);
                let offset = 0;

                for (const chunk of dataChunks) {
                    concatenatedData.set(chunk, offset);
                    offset += chunk.length;
                }

                // The concatenated data is already elementary stream data
                // PES headers were stripped during TS packet extraction (lines 136-156)
                let finalData = concatenatedData;
                console.log(`extractTSStreams: PID ${pid}, codec_type: ${streamInfo.codec_type}, codec_name: ${streamInfo.codec_name}, concatenated: ${concatenatedData.length} bytes`);

                // Determine file extension based on codec
                let extension;
                switch (streamInfo.codec_name) {
                    case 'mpeg1video':
                        extension = 'm1v';
                        break;
                    case 'mpeg2video':
                        extension = 'm2v';
                        break;
                    case 'h264':
                        extension = 'h264';
                        break;
                    case 'hevc':
                        extension = 'h265';
                        break;
                    case 'aac':
                        extension = 'aac';
                        break;
                    case 'mp3':
                        extension = 'mp3';
                        break;
                    case 'ac3':
                        extension = 'ac3';
                        break;
                    case 'eac3':
                        extension = 'eac3';
                        break;
                    case 'ecm':
                        extension = 'ecm';
                        break;
                    case 'emm':
                        extension = 'emm';
                        break;
                    case 'klv':
                        extension = 'klv';
                        break;
                    case 'timed_id3':
                        extension = 'id3';
                        break;
                    default:
                        extension = 'bin';
                }

//                console.log(`extractTSStreams: Extracted ${streamInfo.codec_name} stream (PID ${pid}): ${finalData.length} bytes${streamInfo.fps ? ` @ ${streamInfo.fps.toFixed(2)} fps` : ''}`);

                // Create a proper ArrayBuffer from the Uint8Array
                // Using .buffer directly can include extra data if the Uint8Array is a view
                const arrayBuffer = finalData.buffer.slice(finalData.byteOffset, finalData.byteOffset + finalData.byteLength);

                streams.push({
                    pid: pid,
                    type: streamInfo.codec_name,
                    extension: extension,
                    data: arrayBuffer,
                    codec_type: streamInfo.codec_type,
                    stream_type: streamInfo.stream_type,
                    descriptors: streamInfo.descriptors,
                    fps: streamInfo.fps,
                    width: streamInfo.width,
                    height: streamInfo.height
                });
            }

            console.log(`extractTSStreams: Successfully extracted ${streams.length} streams`);
            return streams;

        } catch (error) {
            showError('extractTSStreams: Error extracting streams:', error);
            return [];
        }
    }

    /**
     * Comprehensive Transport Stream analysis - ffprobe equivalent
     * Analyzes the entire stream for detailed codec information, timing, and metadata
     * @param {ArrayBuffer} buffer - The TS file buffer
     * @returns {Object} Detailed stream analysis with timing, codec info, etc.
     */
    static probeTransportStreamBufferDetailed(buffer) {
        return probeTransportStreamBufferDetailed(buffer);
    }

    /**
     * Basic Transport Stream analysis - PSI tables only
     * @param {ArrayBuffer} buffer - The TS file buffer  
     * @returns {Object} Basic stream structure from PAT/PMT tables
     */
    static probeTransportStreamBuffer(buffer) {
        return probeTransportStreamBuffer(buffer);
    }

    /**
     * Extract elementary stream data from PES packets
     * Removes PES headers to get the actual H.264/video stream data
     * @param {Uint8Array} pesData - Raw PES packet data
     * @returns {Uint8Array} Elementary stream data
     */
    static extractElementaryStreamFromPES(pesData) {
        const elementaryStreamChunks = [];
        let offset = 0;
        let pesPacketCount = 0;

        while (offset < pesData.length - 6) { // Need at least 6 bytes for PES header
            // Look for PES start code: 0x00 0x00 0x01
            if (pesData[offset] === 0x00 && pesData[offset + 1] === 0x00 && pesData[offset + 2] === 0x01) {
                const streamId = pesData[offset + 3];
                
                // Check if this is a video stream (0xE0-0xEF) or private stream (0xBD-0xFF)
                // Private streams include KLV data, subtitles, etc.
                if ((streamId >= 0xE0 && streamId <= 0xEF) || (streamId >= 0xBD && streamId <= 0xFF)) {
                    pesPacketCount++;
                    
                    // Parse PES packet header
                    const packetLength = (pesData[offset + 4] << 8) | pesData[offset + 5];
                    
                    // Basic PES header is 6 bytes minimum
                    let headerOffset = offset + 6;
                    
                    // If packet length is 0, this is an unbounded PES packet
                    let nextPesStart = pesData.length;
                    if (packetLength > 0) {
                        nextPesStart = Math.min(offset + 6 + packetLength, pesData.length);
                    } else {
                        // Find next PES start code
                        for (let i = headerOffset + 3; i < pesData.length - 2; i++) {
                            if (pesData[i] === 0x00 && pesData[i + 1] === 0x00 && pesData[i + 2] === 0x01) {
                                nextPesStart = i;
                                break;
                            }
                        }
                    }
                    
                    // Check for optional PES header fields (present in most streams)
                    if (headerOffset < pesData.length - 2) {
                        const pesHeaderDataLength = pesData[headerOffset + 2];
                        headerOffset += 3 + pesHeaderDataLength; // Skip fixed fields + optional fields
                    }
                    
                    // Extract elementary stream data (everything after PES header)
                    if (headerOffset < nextPesStart) {
                        const elementaryData = pesData.slice(headerOffset, nextPesStart);
                        elementaryStreamChunks.push(elementaryData);
                        
                        // Log first and last few PES packets for debugging
                        if (pesPacketCount <= 3 || pesPacketCount >= 103) {
//                            console.log(`PES packet ${pesPacketCount}: offset=${offset}, packetLength=${packetLength}, headerOffset=${headerOffset}, nextPesStart=${nextPesStart}, elementaryDataSize=${elementaryData.length}`);
//                            console.log(`  First 16 bytes: ${Array.from(elementaryData.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                        }
                    }
                    
                    offset = nextPesStart;
                } else {
                    // Not a supported stream type, skip this PES packet
                    offset += 6;
                    if (offset < pesData.length - 2) {
                        const packetLength = (pesData[offset - 2] << 8) | pesData[offset - 1];
                        if (packetLength > 0) {
                            offset += packetLength;
                        } else {
                            offset++;
                        }
                    } else {
                        break;
                    }
                }
            } else {
                offset++;
            }
        }

        // If no PES packets found, return original data (might be already elementary stream)
        if (elementaryStreamChunks.length === 0) {
            return pesData;
        }

        // Concatenate all elementary stream chunks
        const totalLength = elementaryStreamChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let resultOffset = 0;

        for (const chunk of elementaryStreamChunks) {
            result.set(chunk, resultOffset);
            resultOffset += chunk.length;
        }

        return result;
    }

}


// tsProbe.js
// Minimal MPEG-TS PSI parser in Node.js (no ffprobe). Focus: PAT/PMT → programs/streams.
// Handles 188-byte TS packets, PAT (PID 0x0000), PMT, PCR PID, stream types, and key descriptors.
// Good enough to label H.264, H.265, AAC, MP3, KLV (via registration desc “KLVA”), and generic private data.

const PACKET = 188;
const SYNC = 0x47;

const STREAM_TYPE = {
    0x01: "MPEG1 Video",
    0x02: "MPEG2 Video",
    0x03: "MPEG1 Audio (MP1/MP2/MP3)",
    0x04: "MPEG2 Audio (MP2/MP3)",
    0x06: "PES Private Data (e.g., KLV, DVB subtitles)",
    0x0F: "AAC (LATM)",
    0x11: "AAC (ADTS)",
    0x15: "Metadata (ID3, SCTE-35, etc.)",
    0x1B: "H.264/AVC",
    0x24: "H.265/HEVC",
    0x42: "AVS",
    0x81: "AC3 (ATSC)",
    0x86: "SCTE-35 (Digital Program Insertion)",
    0xF0: "ECM Stream (Entitlement Control Message)",
    0xF1: "EMM Stream (Entitlement Management Message)",
};

function* packets(buf) {
    for (let off = 0; off + PACKET <= buf.length; off += PACKET) {
        if (buf[off] !== SYNC) continue; // resync loosely
        yield buf.subarray(off, off + PACKET);
    }
}

// Very small PSI section reassembler for a given PID
function collectSections(buf, pidWanted) {
    const sections = [];
    const seenSections = new Set(); // Track unique sections by their content hash
    let cur = null;

    for (const pkt of packets(buf)) {
        const tei = (pkt[1] & 0x80) >>> 7;
        const pusi = (pkt[1] & 0x40) >>> 6;
        const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
        if (tei) continue;
        if (pid !== pidWanted) continue;

        let p = 4;
        const adapt = (pkt[3] & 0x30) >>> 4;
        if (adapt === 2 || adapt === 3) {
            const afl = pkt[p]; p += 1 + afl; // skip adaptation field
        }
        if (p >= PACKET) continue;

        if (pusi) {
            const pointerField = pkt[p]; p += 1;
            p += pointerField; // skip stuffing to section start
            if (p >= PACKET) continue;
            // New section begins
            const remaining = pkt.subarray(p);
            if (remaining.length >= 3) {
                const sectionLen = ((remaining[1] & 0x0f) << 8) | remaining[2];
                cur = new Uint8Array(3 + sectionLen);
                const copyLength = Math.min(cur.length, remaining.length);
                cur.set(remaining.subarray(0, copyLength), 0);
                // If not complete yet, wait for next packets
                if (remaining.length >= cur.length) {
                    // Create a simple hash of the section content for deduplication
                    const hash = Array.from(cur).join(',');
                    if (!seenSections.has(hash)) {
                        seenSections.add(hash);
                        sections.push(cur);
                    }
                    cur = null;
                } else {
                    cur._written = remaining.length;
                }
            }
        } else if (cur) {
            // Continuation of current section
            const toCopy = Math.min(cur.length - (cur._written ?? 0), PACKET - p);
            cur.set(pkt.subarray(p, p + toCopy), cur._written ?? 0);
            cur._written = (cur._written ?? 0) + toCopy;
            if (cur._written >= cur.length) {
                // Create a simple hash of the section content for deduplication
                const hash = Array.from(cur).join(',');
                if (!seenSections.has(hash)) {
                    seenSections.add(hash);
                    sections.push(cur);
                }
                cur = null;
            }
        }
    }
    return sections;
}

// Parse PAT → map program_number → PMT PID
function parsePAT(section) {
    const tableId = section[0];
    if (tableId !== 0x00) return [];
    const sectionLen = ((section[1] & 0x0f) << 8) | section[2];
    const tsid = (section[3] << 8) | section[4];
    const entriesEnd = 3 + sectionLen - 4; // minus CRC32
    const out = [];
    
    for (let i = 8; i < entriesEnd; i += 4) {
        const programNumber = (section[i] << 8) | section[i + 1];
        const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
        if (programNumber === 0) {
            // network PID (NIT) — ignore for this purpose
        } else {
            out.push({ program_number: programNumber, pmt_pid: pid, ts_id: tsid });
        }
    }
    return out;
}

// Parse PMT → PCR PID + ES list (pid, stream_type, descriptors)
function parsePMT(section) {
    const tableId = section[0];
    if (tableId !== 0x02) return null;
    const sectionLen = ((section[1] & 0x0f) << 8) | section[2];
    const programNumber = (section[3] << 8) | section[4];
    const pcrPid = ((section[8] & 0x1f) << 8) | section[9];
    const progInfoLen = ((section[10] & 0x0f) << 8) | section[11];
    let p = 12 + progInfoLen;
    const entriesEnd = 3 + sectionLen - 4;

    const streams = [];
    while (p + 5 <= entriesEnd) {
        const streamType = section[p]; p += 1;
        const elementaryPid = ((section[p] & 0x1f) << 8) | section[p + 1]; p += 2;
        const esInfoLen = ((section[p] & 0x0f) << 8) | section[p + 1]; p += 2;

        // Parse ES descriptors (very selectively)
        const descs = [];
        const esEnd = p + esInfoLen;
        while (p + 2 <= esEnd) {
            const tag = section[p], len = section[p + 1];
            const body = section.subarray(p + 2, p + 2 + len);
            if (tag === 0x05 && len >= 4) { // registration_descriptor
                const fourCC = String.fromCharCode(...body.subarray(0, 4));
                descs.push({ tag, name: "registration", format_identifier: fourCC });
            } else if (tag === 0x0A) { // ISO_639_language_descriptor
                const lang = String.fromCharCode(...body.subarray(0, 3));
                descs.push({ tag, name: "language", lang });
            } else if (tag === 0x26 && len >= 7) { // Check if tag 38 contains KLVA registration
                // Look for KLVA at different positions in the descriptor
                let foundKLVA = false;
                for (let i = 0; i <= len - 4; i++) {
                    const fourCC = String.fromCharCode(...body.subarray(i, i + 4));
                    if (fourCC === "KLVA") {
                        descs.push({ tag, name: "registration", format_identifier: fourCC });
                        foundKLVA = true;
                        break;
                    }
                }
                if (!foundKLVA) {
                    descs.push({ tag, length: len, data: Array.from(body) });
                }
            } else {
                descs.push({ tag, length: len, data: len <= 16 ? Array.from(body) : undefined });
            }
            p += 2 + len;
        }
        streams.push({
            stream_type: streamType,
            stream_type_name: STREAM_TYPE[streamType] || "Unknown",
            elementary_pid: elementaryPid,
            descriptors: descs,
        });
    }

    return {
        program_number: programNumber,
        pcr_pid: pcrPid,
        streams,
    };
}

// Public API

export function probeTransportStreamBuffer(buf) {
    // if ArrayBuffer, convert it to Uint8Array
    if (buf instanceof ArrayBuffer) {
        buf = new Uint8Array(buf);
    }
    

    if (!(buf instanceof Uint8Array)) {
        throw new TypeError("Expected Uint8Array.");
    }

    // 1) PAT on PID 0x0000 → PMT PIDs
    const patSections = collectSections(buf, 0x0000);
    const patEntries = patSections.flatMap(parsePAT);

    // Deduplicate programs by program_number (multiple PAT sections may contain same programs)
    const uniquePrograms = new Map();
    for (const entry of patEntries) {
        uniquePrograms.set(entry.program_number, entry);
    }

    // 2) For each unique PMT PID, parse PMT
    const programs = [];
    for (const { program_number, pmt_pid, ts_id } of uniquePrograms.values()) {
        const pmtSections = collectSections(buf, pmt_pid);
        
        // Use the last complete PMT section (newest version)
        const last = pmtSections[pmtSections.length - 1];
        if (!last) continue;
        const pmt = parsePMT(last);
        if (!pmt) continue;

        // Normalize to ffprobe-like shape
        const streams = pmt.streams.map((s, index) => {
            // Try to infer KLV when registration = "KLVA" or stream_type private
            const reg = s.descriptors.find(d => d.name === "registration")?.format_identifier;
            const codec_name =
                reg === "KLVA" ? "klv" :
                    (s.stream_type === 0x01 ? "mpeg1video" :
                        s.stream_type === 0x02 ? "mpeg2video" :
                            s.stream_type === 0x1B ? "h264" :
                                s.stream_type === 0x24 ? "hevc" :
                                    s.stream_type === 0x0F || s.stream_type === 0x11 ? "aac" :
                                        s.stream_type === 0x03 || s.stream_type === 0x04 ? "mp3" :
                                            s.stream_type === 0x81 ? "ac3" :
                                                s.stream_type === 0x87 ? "eac3" :
                                                    s.stream_type === 0xF0 ? "ecm" :
                                                        s.stream_type === 0xF1 ? "emm" :
                                                            s.stream_type === 0x15 && reg === "KLVA" ? "klv" :
                                                                s.stream_type === 0x15 ? "timed_id3" :
                                                                    s.stream_type === 0x06 && reg ? reg : "unknown");

            const codec_type = codec_name === "h264" || codec_name === "hevc" || codec_name === "mpeg1video" || codec_name === "mpeg2video" ? "video" :
                        codec_name === "aac" || codec_name === "mp3" || codec_name === "ac3" || codec_name === "eac3" ? "audio" :
                            codec_name === "klv" || codec_name === "timed_id3" || codec_name === "ecm" || codec_name === "emm" ? "data" : "unknown";

            return {
                index: index,
                codec_name,
                codec_long_name: codec_name === "mpeg1video" ? "MPEG-1 Video" :
                                codec_name === "mpeg2video" ? "MPEG-2 Video" :
                                codec_name === "h264" ? "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10" :
                                codec_name === "hevc" ? "H.265 / HEVC (High Efficiency Video Coding)" :
                                codec_name === "aac" ? "AAC (Advanced Audio Coding)" :
                                codec_name === "mp3" ? "MP3 (MPEG audio layer 3)" :
                                codec_name === "ac3" ? "AC-3 (Dolby Digital)" :
                                codec_name === "eac3" ? "E-AC-3 (Dolby Digital Plus)" :
                                codec_name === "ecm" ? "ECM Stream (Entitlement Control Message)" :
                                codec_name === "emm" ? "EMM Stream (Entitlement Management Message)" :
                                codec_name === "klv" ? "SMPTE 336M Key-Length-Value (KLV) metadata" :
                                codec_name === "timed_id3" ? "Timed ID3 metadata" :
                                "Unknown",
                codec_type,
                codec_tag_string: codec_name === "klv" ? "KLVA" : `[${s.stream_type.toString(16).padStart(2, '0')}][0][0][0]`,
                codec_tag: codec_name === "klv" ? "0x41564c4b" : "0x" + s.stream_type.toString(16).padStart(4, "0"),
                id: "0x" + s.elementary_pid.toString(16),
                ts_id: ts_id.toString(),
                ts_packetsize: "188",
                r_frame_rate: "0/0",
                avg_frame_rate: "0/0", 
                time_base: "1/90000",
                start_pts: 0,
                start_time: "0.000000",
                duration_ts: 0,
                duration: "0.000000",
                disposition: {
                    default: 0,
                    dub: 0,
                    original: 0,
                    comment: 0,
                    lyrics: 0,
                    karaoke: 0,
                    forced: 0,
                    hearing_impaired: 0,
                    visual_impaired: 0,
                    clean_effects: 0,
                    attached_pic: 0,
                    timed_thumbnails: 0,
                    non_diegetic: 0,
                    captions: 0,
                    descriptions: 0,
                    metadata: 0,
                    dependent: 0,
                    still_image: 0,
                    multilayer: 0
                },
                stream_type: "0x" + s.stream_type.toString(16).padStart(2, "0"),
                stream_type_name: s.stream_type_name,
                descriptors: s.descriptors,
            };
        });

        programs.push({
            program_id: program_number,
            program_num: program_number,
            nb_streams: streams.length,
            pmt_pid,
            pcr_pid: pmt.pcr_pid,
            ts_id,
            streams,
        });
    }

    // 3) Flatten “streams” (ffprobe prints both per-program and a top-level list)
    const flatStreams = programs.flatMap(p => p.streams);
    
    // Re-index streams globally for the flattened list
    flatStreams.forEach((stream, globalIndex) => {
        stream.index = globalIndex;
    });

    return { programs, streams: flatStreams };
}

// Elementary Stream Parsers for detailed codec information

/**
 * Parse H.264 SPS (Sequence Parameter Set) to extract video parameters
 */
function parseH264SPS(nalUnit) {
    try {
        if (nalUnit.length < 10) return null;
        
        // Skip NAL header and start parsing SPS
        let offset = 1;
        const profile_idc = nalUnit[offset];
        offset += 1;
        
        // Skip constraint flags
        offset += 1;
        
        const level_idc = nalUnit[offset];
        offset += 1;
        
        // This is a simplified SPS parser - full implementation would need
        // proper Exponential-Golomb decoding for width/height
        // For now, we'll use common resolutions based on level
        let width = 1920, height = 1080;
        
        // Try to guess resolution from level (very rough approximation)
        if (level_idc <= 30) { // Level 3.0 and below
            width = 1280; height = 720;
        } else if (level_idc <= 31) { // Level 3.1
            width = 1280; height = 720;
        } else if (level_idc <= 40) { // Level 4.0
            width = 1920; height = 1080;
        } else { // Level 4.1+
            width = 1920; height = 1080;
        }
        
        return {
            profile: profile_idc,
            level: level_idc,
            width,
            height
        };
    } catch (e) {
        return null;
    }
}

/**
 * Parse MPEG-2 sequence header to extract video parameters
 * MPEG-2 sequence header format:
 * - Start code: 0x000001B3
 * - 12 bits: horizontal_size_value (width)
 * - 12 bits: vertical_size_value (height)
 * - 4 bits: aspect_ratio_information
 * - 4 bits: frame_rate_code
 */
function parseMPEG2SequenceHeader(data) {
    try {
        // Look for sequence header start code (0x000001B3)
        let sequenceHeaderOffset = -1;
        for (let i = 0; i < data.length - 8; i++) {
            if (data[i] === 0x00 && data[i + 1] === 0x00 && 
                data[i + 2] === 0x01 && data[i + 3] === 0xB3) {
                sequenceHeaderOffset = i + 4; // Skip start code
                break;
            }
        }
        
        if (sequenceHeaderOffset === -1 || sequenceHeaderOffset + 4 > data.length) {
            return null;
        }
        
        // Parse width (12 bits)
        const byte0 = data[sequenceHeaderOffset];
        const byte1 = data[sequenceHeaderOffset + 1];
        const width = (byte0 << 4) | ((byte1 & 0xF0) >> 4);
        
        // Parse height (12 bits)
        const byte2 = data[sequenceHeaderOffset + 2];
        const height = ((byte1 & 0x0F) << 8) | byte2;
        
        // Parse frame rate code (4 bits)
        const byte3 = data[sequenceHeaderOffset + 3];
        const frameRateCode = byte3 & 0x0F;
        
        // MPEG-2 frame rate table
        const frameRates = [
            null,    // 0: forbidden
            23.976,  // 1: 24000/1001 (23.976 fps)
            24,      // 2: 24 fps
            25,      // 3: 25 fps
            29.97,   // 4: 30000/1001 (29.97 fps)
            30,      // 5: 30 fps
            50,      // 6: 50 fps
            59.94,   // 7: 60000/1001 (59.94 fps)
            60,      // 8: 60 fps
            null,    // 9-15: reserved
        ];
        
        const fps = frameRates[frameRateCode] || null;
        
        return {
            width,
            height,
            fps,
            frameRateCode
        };
    } catch (e) {
        return null;
    }
}

/**
 * Parse AAC ADTS header to extract audio parameters
 */
function parseAACHeader(data) {
    try {
        if (data.length < 7) return null;
        
        // Check for ADTS sync word (0xFFF)
        if ((data[0] & 0xFF) !== 0xFF || (data[1] & 0xF0) !== 0xF0) {
            return null;
        }
        
        const profile = ((data[2] & 0xC0) >> 6) + 1;
        const sampleRateIndex = (data[2] & 0x3C) >> 2;
        const channelConfig = ((data[2] & 0x01) << 2) | ((data[3] & 0xC0) >> 6);
        
        const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        const sampleRate = sampleRates[sampleRateIndex] || 48000;
        
        return {
            profile,
            sample_rate: sampleRate,
            channels: channelConfig || 2
        };
    } catch (e) {
        return null;
    }
}

/**
 * Parse PES packet to extract timing information
 */
function parsePESPacket(data) {
    try {
        if (data.length < 9) return null;
        
        // Check PES start code (0x000001)
        if (data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x01) {
            return null;
        }
        
        const streamId = data[3];
        const pesLength = (data[4] << 8) | data[5];
        
        // Skip if no PES header extension
        const noExtensionIds = new Set([0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xFF, 0xF2, 0xF8]);
        if (noExtensionIds.has(streamId)) {
            return { streamId, pts: null, dts: null };
        }
        
        if (data.length < 9) return null;
        
        const pesFlags = data[7];
        const pesHeaderLength = data[8];
        
        let pts = null, dts = null;
        let offset = 9;
        
        // Parse PTS
        if ((pesFlags & 0x80) && offset + 5 <= data.length) {
            pts = ((data[offset] & 0x0E) << 29) |
                  (data[offset + 1] << 22) |
                  ((data[offset + 2] & 0xFE) << 14) |
                  (data[offset + 3] << 7) |
                  ((data[offset + 4] & 0xFE) >> 1);
            offset += 5;
        }
        
        // Parse DTS
        if ((pesFlags & 0x40) && offset + 5 <= data.length) {
            dts = ((data[offset] & 0x0E) << 29) |
                  (data[offset + 1] << 22) |
                  ((data[offset + 2] & 0xFE) << 14) |
                  (data[offset + 3] << 7) |
                  ((data[offset + 4] & 0xFE) >> 1);
        }
        
        return { streamId, pts, dts, pesHeaderLength };
    } catch (e) {
        return null;
    }
}

/**
 * Comprehensive Transport Stream analysis - ffprobe equivalent
 * Analyzes the entire stream for detailed codec information, timing, and metadata
 */
export function probeTransportStreamBufferDetailed(buffer) {
    // First get basic structure from PSI tables
    const basicInfo = probeTransportStreamBuffer(buffer);
    
    // Now do detailed analysis of each stream
    const detailedStreams = [];
    const streamAnalysis = new Map(); // PID -> analysis data
    
    const uint8Array = new Uint8Array(buffer);
    const packetSize = 188;
    
    // Track timing and content for each stream
    for (const program of basicInfo.programs) {
        for (const stream of program.streams) {
            const pid = parseInt(stream.id, 16);
            streamAnalysis.set(pid, {
                ...stream,
                packets: [],
                firstPTS: null,
                lastPTS: null,
                pesPackets: [],
                elementaryData: [],
                frameCount: 0,
                totalBytes: 0
            });
        }
    }
    
    // Scan through all packets to collect stream data
    for (let offset = 0; offset < uint8Array.length - packetSize; offset += packetSize) {
        if (uint8Array[offset] !== 0x47) continue; // Skip non-sync packets
        
        // Parse TS header
        const header1 = uint8Array[offset + 1];
        const header2 = uint8Array[offset + 2];
        const header3 = uint8Array[offset + 3];
        
        const pid = ((header1 & 0x1F) << 8) | header2;
        const payloadUnitStartIndicator = (header1 & 0x40) !== 0;
        const adaptationFieldControl = (header3 & 0x30) >> 4;
        
        if (!streamAnalysis.has(pid)) continue;
        
        let payloadStart = 4;
        
        // Handle adaptation field
        if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
            const adaptationFieldLength = uint8Array[offset + 4];
            payloadStart += 1 + adaptationFieldLength;
        }
        
        // Skip if no payload
        if (adaptationFieldControl === 2) continue;
        
        if (payloadStart < packetSize) {
            const payloadData = uint8Array.slice(offset + payloadStart, offset + packetSize);
            const analysis = streamAnalysis.get(pid);
            
            analysis.packets.push({
                offset,
                payloadUnitStart: payloadUnitStartIndicator,
                payload: payloadData
            });
            
            analysis.totalBytes += payloadData.length;
            
            // If this starts a new PES packet, try to parse it
            if (payloadUnitStartIndicator) {
                const pesInfo = parsePESPacket(payloadData);
                if (pesInfo && pesInfo.pts !== null) {
                    if (analysis.firstPTS === null) {
                        analysis.firstPTS = pesInfo.pts;
                    }
                    analysis.lastPTS = pesInfo.pts;
                    analysis.pesPackets.push(pesInfo);
                }
                
                // Collect elementary stream data for codec analysis
                if (payloadData.length > 20) {
                    analysis.elementaryData.push(payloadData);
                }
            }
        }
    }
    
    // Analyze each stream in detail
    for (const [pid, analysis] of streamAnalysis.entries()) {
        const detailedStream = { ...analysis };
        
        // Calculate timing information
        if (analysis.firstPTS !== null && analysis.lastPTS !== null) {
            const startTime = analysis.firstPTS / 90000; // Convert from 90kHz to seconds
            const endTime = analysis.lastPTS / 90000;
            const duration = endTime - startTime;
            
            detailedStream.start_pts = analysis.firstPTS;
            detailedStream.start_time = startTime.toFixed(6);
            detailedStream.duration_ts = analysis.lastPTS - analysis.firstPTS;
            detailedStream.duration = duration.toFixed(6);
        }
        
        // Analyze elementary stream content based on codec
        if (analysis.codec_name === 'h264' && analysis.elementaryData.length > 0) {
            // Look for H.264 NAL units
            for (const data of analysis.elementaryData) {
                // Look for SPS NAL unit (type 7)
                for (let i = 0; i < data.length - 4; i++) {
                    if (data[i] === 0x00 && data[i+1] === 0x00 && data[i+2] === 0x01) {
                        const nalType = data[i+3] & 0x1F;
                        if (nalType === 7) { // SPS
                            const spsInfo = parseH264SPS(data.slice(i+3));
                            if (spsInfo) {
                                detailedStream.width = spsInfo.width;
                                detailedStream.height = spsInfo.height;
                                detailedStream.profile = spsInfo.profile;
                                detailedStream.level = spsInfo.level;
                            }
                            break;
                        }
                    }
                }
            }
            
            // Estimate frame rate from PES packets
            if (analysis.pesPackets.length > 1) {
                const frameInterval = (analysis.lastPTS - analysis.firstPTS) / (analysis.pesPackets.length - 1);
                const fps = 90000 / frameInterval;
                detailedStream.r_frame_rate = `${Math.round(fps * 1000)}/1000`;
                detailedStream.avg_frame_rate = detailedStream.r_frame_rate;
            }
        }
        
        if (analysis.codec_name === 'mpeg2video' && analysis.elementaryData.length > 0) {
            // Look for MPEG-2 sequence headers
            for (const data of analysis.elementaryData) {
                const mpeg2Info = parseMPEG2SequenceHeader(data);
                if (mpeg2Info) {
                    detailedStream.width = mpeg2Info.width;
                    detailedStream.height = mpeg2Info.height;
                    if (mpeg2Info.fps) {
                        // Convert fps to fractional format
                        if (mpeg2Info.fps === 23.976) {
                            detailedStream.r_frame_rate = "24000/1001";
                        } else if (mpeg2Info.fps === 29.97) {
                            detailedStream.r_frame_rate = "30000/1001";
                        } else if (mpeg2Info.fps === 59.94) {
                            detailedStream.r_frame_rate = "60000/1001";
                        } else {
                            detailedStream.r_frame_rate = `${mpeg2Info.fps}/1`;
                        }
                        detailedStream.avg_frame_rate = detailedStream.r_frame_rate;
                    }
                    break;
                }
            }
        }
        
        if (analysis.codec_name === 'aac' && analysis.elementaryData.length > 0) {
            // Look for AAC ADTS headers
            for (const data of analysis.elementaryData) {
                const aacInfo = parseAACHeader(data);
                if (aacInfo) {
                    detailedStream.sample_rate = aacInfo.sample_rate;
                    detailedStream.channels = aacInfo.channels;
                    detailedStream.profile = aacInfo.profile;
                    break;
                }
            }
        }
        
        // Clean up temporary analysis data
        delete detailedStream.packets;
        delete detailedStream.pesPackets;
        delete detailedStream.elementaryData;
        delete detailedStream.firstPTS;
        delete detailedStream.lastPTS;
        delete detailedStream.frameCount;
        delete detailedStream.totalBytes;
        
        detailedStreams.push(detailedStream);
    }
    
    // Update the programs with detailed stream info
    const detailedPrograms = basicInfo.programs.map(program => ({
        ...program,
        streams: detailedStreams.filter(s => 
            program.streams.some(ps => ps.id === s.id)
        )
    }));
    
    return {
        programs: detailedPrograms,
        streams: detailedStreams
    };
}


// ---- Example ----
// const info = TSParser.probeTransportStreamBufferDetailed(buffer);
// console.dir(info, { depth: null });


