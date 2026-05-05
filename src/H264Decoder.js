/**
 * H264Decoder - Direct H.264 decoding using WebCodecs
 * 
 * This utility directly decodes raw H.264 elementary streams using the browser's
 * native WebCodecs API without requiring MP4 container conversion.
 */

import {showError} from "./showError";

/**
 * Bit reader for H.264 streams with Exponential-Golomb decoding support
 */
class H264BitReader {
    constructor(data) {
        this.data = new Uint8Array(data);
        this.byteOffset = 0;
        this.bitOffset = 0;
    }

    /**
     * Read specified number of bits
     */
    readBits(numBits) {
        let result = 0;
        
        for (let i = 0; i < numBits; i++) {
            if (this.byteOffset >= this.data.length) {
                throw new Error("Unexpected end of data");
            }
            
            const bit = (this.data[this.byteOffset] >> (7 - this.bitOffset)) & 1;
            result = (result << 1) | bit;
            
            this.bitOffset++;
            if (this.bitOffset === 8) {
                this.bitOffset = 0;
                this.byteOffset++;
            }
        }
        
        return result;
    }

    /**
     * Read unsigned Exponential-Golomb encoded value
     */
    readUE() {
        let leadingZeros = 0;
        
        // Count leading zeros with safety check
        while (this.hasMoreData() && this.readBits(1) === 0) {
            leadingZeros++;
            if (leadingZeros > 32) {
                throw new Error("Invalid Exponential-Golomb encoding: too many leading zeros");
            }
        }
        
        if (leadingZeros === 0) {
            return 0;
        }
        
        // Ensure we have enough bits remaining
        if (!this.hasMoreData()) {
            throw new Error("Unexpected end of data in Exponential-Golomb decoding");
        }
        
        // Read the remaining bits
        const value = this.readBits(leadingZeros);
        return (1 << leadingZeros) - 1 + value;
    }

    /**
     * Read signed Exponential-Golomb encoded value
     */
    readSE() {
        const ue = this.readUE();
        if (ue === 0) return 0;
        
        // Convert to signed: positive = 2k+1, negative = 2k
        return (ue % 2 === 1) ? Math.ceil(ue / 2) : -Math.floor(ue / 2);
    }

    /**
     * Check if more data is available
     */
    hasMoreData() {
        return this.byteOffset < this.data.length || 
               (this.byteOffset === this.data.length - 1 && this.bitOffset < 8);
    }

    /**
     * Get current bit position for debugging
     */
    getPosition() {
        return {
            byteOffset: this.byteOffset,
            bitOffset: this.bitOffset,
            totalBits: this.byteOffset * 8 + this.bitOffset
        };
    }
}

export class H264Decoder {
    
    /**
     * Create a WebCodecs VideoDecoder for H.264 data
     * @param {ArrayBuffer} h264Data - Raw H.264 elementary stream
     * @param {Object} options - Configuration options
     * @param {number} options.fps - Frame rate (default: 30)
     * @param {Function} options.onFrame - Callback for decoded frames
     * @param {Function} options.onError - Error callback
     * @returns {Promise<VideoDecoder>} Configured VideoDecoder
     */
    static async createDecoder(h264Data, options = {}) {
        console.log("Creating H.264 WebCodecs decoder...");

        // Parse H.264 to extract information
        const analysis = this.analyzeH264Stream(h264Data);
        
        console.log("H.264 Stream Analysis:", analysis);

        if (!analysis.hasSPS || !analysis.hasPPS) {
            throw new Error(
                `H.264 stream missing required parameters: ` +
                `${analysis.hasSPS ? 'has' : 'missing'} SPS, ` +
                `${analysis.hasPPS ? 'has' : 'missing'} PPS`
            );
        }

        const { 
            fps = 30,
            onFrame = (frame) => console.log("Decoded frame:", frame),
            onError = (error) => showError("Decoder error:", error)
        } = options;

        // Create decoder configuration from SPS/PPS
        const codecString = this.createH264CodecString(analysis.spsData);
        const config = {
            codec: codecString,
            description: this.createAVCDecoderConfig(analysis.spsData, analysis.ppsData)
        };

        console.log("Decoder config:", config);

        // Create VideoDecoder
        const decoder = new VideoDecoder({
            output: onFrame,
            error: onError
        });

        // Configure the decoder with error handling
        try {
            console.log("Configuring VideoDecoder...");
            
            // Check if codec is supported first
            if (!VideoDecoder.isConfigSupported) {
                console.warn("VideoDecoder.isConfigSupported not available, skipping codec check");
            } else {
                const supportCheck = await VideoDecoder.isConfigSupported(config);
                console.log("Codec support check:", supportCheck);
                
                if (!supportCheck.supported) {
                    throw new Error(`H.264 codec not supported: ${config.codec}`);
                }
            }
            
            await decoder.configure(config);
            console.log("H.264 decoder configured successfully");
            
        } catch (error) {
            showError("VideoDecoder configuration failed:", error);
            decoder.close();
            throw new Error(`Failed to configure VideoDecoder: ${error.message}`);
        }

        console.log("H.264 decoder created successfully");
        return decoder;
    }

    /**
     * Decode H.264 frames and render to canvas
     * @param {ArrayBuffer} h264Data - Raw H.264 elementary stream
     * @param {HTMLCanvasElement} canvas - Target canvas
     * @param {Object} options - Configuration options
     * @returns {Promise<void>}
     */
    static async decodeToCanvas(h264Data, canvas, options = {}) {
        const ctx = canvas.getContext('2d');
        let frameCount = 0;

        const decoder = await this.createDecoder(h264Data, {
            ...options,
            onFrame: (frame) => {
                // Draw frame to canvas
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                ctx.drawImage(frame, 0, 0);
                frame.close();
                frameCount++;
                //console.log(`Rendered frame ${frameCount}`);
            }
        });

        // Extract and decode NAL units
        const nalUnits = this.extractNALUnits(new Uint8Array(h264Data));
        const chunks = this.createEncodedVideoChunks(nalUnits, options.fps || 30);

        //console.log(`Decoding ${chunks.length} video chunks...`);

        // Decode all chunks
        for (const chunk of chunks) {
            decoder.decode(chunk);
        }

        // Wait for decoding to complete
        await decoder.flush();
        decoder.close();

        //console.log(`Decoding complete. Rendered ${frameCount} frames.`);
    }

    /**
     * Create H.264 codec string from SPS data
     * Format: avc1.PPCCLL where PP=profile, CC=compatibility, LL=level
     */
    static createH264CodecString(spsData) {
        if (spsData.length < 4) {
            throw new Error('SPS data too short for codec string generation');
        }
        
        const profileIdc = spsData[1];
        const profileCompatibility = spsData[2];
        const levelIdc = spsData[3];
        
        // Create codec string in format avc1.PPCCLL
        const codecString = `avc1.${profileIdc.toString(16).padStart(2, '0').toUpperCase()}${profileCompatibility.toString(16).padStart(2, '0').toUpperCase()}${levelIdc.toString(16).padStart(2, '0').toUpperCase()}`;
        
        //console.log('Generated H.264 codec string:', codecString);
        return codecString;
    }

    /**
     * Create AVC decoder configuration from SPS/PPS data
     */
    static createAVCDecoderConfig(spsData, ppsData) {
        // Create proper AVCC format configuration
        // Reference: ISO/IEC 14496-15 Section 5.2.4.1
        //console.log('Creating AVCC config with SPS:', spsData.length, 'bytes, PPS:', ppsData.length, 'bytes');
        
        // Parse SPS for profile/level information
        if (spsData.length < 4) {
            throw new Error('SPS data too short');
        }
        
        const profileIdc = spsData[1];
        const profileCompatibility = spsData[2]; 
        const levelIdc = spsData[3];
        
        //console.log('SPS Profile/Level:', {
        //     profile: profileIdc.toString(16),
        //     compatibility: profileCompatibility.toString(16),
        //     level: levelIdc.toString(16)
        // });

        // Calculate total size needed
        const configSize = 6 + // AVCC header
                          2 + spsData.length + // SPS
                          1 + 2 + ppsData.length; // PPS
                          
        const config = new Uint8Array(configSize);
        let offset = 0;

        // AVCC header (6 bytes)
        config[offset++] = 0x01; // configurationVersion
        config[offset++] = profileIdc; // AVCProfileIndication
        config[offset++] = profileCompatibility; // profile_compatibility
        config[offset++] = levelIdc; // AVCLevelIndication
        config[offset++] = 0xFF; // lengthSizeMinusOne (4-byte length fields)
        config[offset++] = 0xE1; // numOfSequenceParameterSets (1 SPS)

        // SPS data
        config[offset++] = (spsData.length >> 8) & 0xFF; // SPS length high byte
        config[offset++] = spsData.length & 0xFF;        // SPS length low byte
        config.set(spsData, offset);
        offset += spsData.length;

        // PPS data
        config[offset++] = 0x01; // numOfPictureParameterSets (1 PPS)
        config[offset++] = (ppsData.length >> 8) & 0xFF; // PPS length high byte
        config[offset++] = ppsData.length & 0xFF;        // PPS length low byte
        config.set(ppsData, offset);
        offset += ppsData.length;

        //console.log('Created AVCC config:', config.length, 'bytes');
        //console.log('AVCC header:', Array.from(config.slice(0, 6)).map(x => '0x' + x.toString(16).padStart(2, '0')).join(' '));
        
        return config.buffer;
    }

    /**
     * Create EncodedVideoChunk objects from NAL units with proper frame aggregation.
     *
     * When pesPtsUs is provided AND its length matches the parsed frame count,
     * each chunk's timestamp is the real per-frame PES PTS captured by TSParser
     * — preserving recording-time gaps caused by dropped/missing frames. Without
     * it (or on length mismatch) we fall back to synthetic uniform i × frameDuration
     * timestamps, which are wrong for any stream that lost frames mid-recording.
     */
    static createEncodedVideoChunks(nalUnits, fps, pesPtsUs = null) {
        const chunks = [];
        const frameDuration = 1000000 / fps; // Duration in microseconds

        // Group NAL units into frames
        const frames = this.groupNALUnitsIntoFrames(nalUnits);

        // Decide whether to use real per-frame PES PTS or synthetic uniform stamps.
        // Real PTS is used only when caller supplied an array AND its length matches
        // the parsed frame count exactly. Any mismatch falls back to synthetic with
        // a warning, since misaligned PTS pairing is worse than uniform-but-wrong.
        let useRealPTS = false;
        if (Array.isArray(pesPtsUs) && pesPtsUs.length === frames.length) {
            useRealPTS = true;
            console.log(`H264Decoder.createEncodedVideoChunks: using ${pesPtsUs.length} real per-frame PES PTS values`);
        } else if (Array.isArray(pesPtsUs) && pesPtsUs.length > 0) {
            console.warn(`H264Decoder.createEncodedVideoChunks: pesPtsUs length ${pesPtsUs.length} != frame count ${frames.length}; falling back to synthetic timestamps`);
        }

        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            if (frame.nalUnits.length === 0) continue;

            // Create aggregated frame data
            const frameData = this.createAggregatedFrame(frame.nalUnits);

            const presentationTimestamp = useRealPTS ? pesPtsUs[i] : (i * frameDuration);

            chunks.push(new EncodedVideoChunk({
                type: frame.type,
                timestamp: presentationTimestamp,
                duration: frameDuration,
                data: frameData
            }));
        }

        return chunks;
    }

    /**
     * Read first_mb_in_slice from a slice NAL unit header.
     * This is the first Exp-Golomb coded value after the NAL header byte.
     * Returns 0 for the first slice in a frame, non-zero for continuation slices.
     * @param {Uint8Array} nalData - NAL unit data (starting with NAL header byte)
     * @returns {number} first_mb_in_slice value, or 0 on parse error
     */
    static readFirstMbInSlice(nalData) {
        if (nalData.length < 2) return 0;
        try {
            const reader = new H264BitReader(nalData);
            reader.readBits(8); // skip NAL header byte
            return reader.readUE(); // first_mb_in_slice
        } catch (e) {
            return 0; // On parse error, treat as new frame (safe default)
        }
    }

    /**
     * Group NAL units into complete frames.
     * Handles multi-slice frames by checking first_mb_in_slice:
     * - first_mb_in_slice === 0 means start of a new frame
     * - first_mb_in_slice > 0 means a continuation slice of the current frame
     */
    static groupNALUnitsIntoFrames(nalUnits) {
        const frames = [];
        let currentFrame = {
            type: null,
            nalUnits: []
        };

        for (const nal of nalUnits) {
            const nalType = nal.data[0] & 0x1F;

            if (nalType === 5) {
                // IDR slice — check if this is a new frame or continuation slice
                const firstMb = this.readFirstMbInSlice(nal.data);
                if (firstMb === 0) {
                    // New IDR frame (first slice)
                    if (currentFrame.nalUnits.length > 0) {
                        frames.push(currentFrame);
                    }
                    currentFrame = {
                        type: 'key',
                        nalUnits: [nal]
                    };
                } else {
                    // Continuation slice of current IDR frame
                    currentFrame.nalUnits.push(nal);
                }

            } else if (nalType === 1) {
                // P/I slice — check if this is a new frame or continuation slice
                const firstMb = this.readFirstMbInSlice(nal.data);
                if (firstMb === 0) {
                    // New frame (first slice)
                    if (currentFrame.nalUnits.length > 0) {
                        frames.push(currentFrame);
                    }
                    currentFrame = {
                        type: 'delta',
                        nalUnits: [nal]
                    };
                } else {
                    // Continuation slice of current frame
                    currentFrame.nalUnits.push(nal);
                }

            } else if (nalType === 2) {
                // B slice — check if this is a new frame or continuation slice
                const firstMb = this.readFirstMbInSlice(nal.data);
                if (firstMb === 0) {
                    if (currentFrame.nalUnits.length > 0) {
                        frames.push(currentFrame);
                    }
                    currentFrame = {
                        type: 'delta',
                        nalUnits: [nal]
                    };
                } else {
                    currentFrame.nalUnits.push(nal);
                }

            } else if (nalType === 6) {
                // SEI - add to current frame if we have one with video data
                if (currentFrame.nalUnits.length > 0 && currentFrame.type !== null) {
                    currentFrame.nalUnits.push(nal);
                }
                // If no current frame or current frame has no video data, ignore orphaned SEI

            } else if (nalType === 9) {
                // Access Unit Delimiter - frame boundary marker
                if (currentFrame.nalUnits.length > 0) {
                    frames.push(currentFrame);
                    currentFrame = {
                        type: null,
                        nalUnits: []
                    };
                }
            }
            // Skip SPS/PPS (types 7, 8) - they go in decoder config only
        }

        // Add final frame
        if (currentFrame.nalUnits.length > 0) {
            frames.push(currentFrame);
        }

        // Filter out frames without video data
        return frames.filter(frame => frame.type !== null);
    }

    /**
     * Create aggregated frame data from multiple NAL units
     */
    static createAggregatedFrame(nalUnits) {
        // Try AVCC format first (length prefixes) - this should work with AVCC decoder config
        return this.createAVCCFrame(nalUnits);
    }

    /**
     * Create AVCC format frame (length prefixes)
     */
    static createAVCCFrame(nalUnits) {
        // Calculate total size needed
        let totalSize = 0;
        for (const nal of nalUnits) {
            totalSize += 4 + nal.data.length; // 4 bytes length prefix + NAL data
        }

        // Create aggregated buffer
        const frameBuffer = new ArrayBuffer(totalSize);
        const frameView = new Uint8Array(frameBuffer);
        const dataView = new DataView(frameBuffer);
        
        let offset = 0;
        for (const nal of nalUnits) {
            // Write length prefix (big-endian 32-bit) - AVCC format
            dataView.setUint32(offset, nal.data.length, false);
            offset += 4;
            
            // Write NAL unit data
            frameView.set(nal.data, offset);
            offset += nal.data.length;
        }

        return frameBuffer;
    }

    /**
     * Create Annex-B format frame (start codes) - fallback option
     */
    static createAnnexBFrame(nalUnits) {
        // Calculate total size needed
        let totalSize = 0;
        for (const nal of nalUnits) {
            totalSize += 4 + nal.data.length; // 4 bytes start code + NAL data
        }

        // Create aggregated buffer
        const frameBuffer = new ArrayBuffer(totalSize);
        const frameView = new Uint8Array(frameBuffer);
        
        let offset = 0;
        for (const nal of nalUnits) {
            // Write start code (0x00 0x00 0x00 0x01)
            frameView[offset] = 0x00;
            frameView[offset + 1] = 0x00;
            frameView[offset + 2] = 0x00;
            frameView[offset + 3] = 0x01;
            offset += 4;
            
            // Write NAL unit data
            frameView.set(nal.data, offset);
            offset += nal.data.length;
        }

        return frameBuffer;
    }





    /**
     * Extract individual NAL units from H.264 stream
     */
    static extractNALUnits(data) {
        const nalUnits = [];

        for (let i = 0; i < data.length - 4; i++) {
            // Look for NAL unit start codes
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                let nalStart = -1;
                let startCodeLength = 0;
                
                if (data[i + 2] === 0x01) {
                    nalStart = i + 3;
                    startCodeLength = 3;
                } else if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
                    nalStart = i + 4;
                    startCodeLength = 4;
                }

                if (nalStart !== -1 && nalStart < data.length) {
                    // Find end of this NAL unit
                    let nalEnd = data.length;
                    for (let j = nalStart + 1; j < data.length - 3; j++) {
                        if (data[j] === 0x00 && data[j + 1] === 0x00 && 
                            (data[j + 2] === 0x01 || (data[j + 2] === 0x00 && data[j + 3] === 0x01))) {
                            nalEnd = j;
                            break;
                        }
                    }

                    nalUnits.push({
                        start: i,
                        startCodeLength: startCodeLength,
                        data: data.slice(nalStart, nalEnd)
                    });

                    i = nalEnd - 1; // Skip to end of this NAL unit
                }
            }
        }

        return nalUnits;
    }

    /**
     * Analyze H.264 stream to extract metadata
     */
    static analyzeH264Stream(h264Data) {
        const data = new Uint8Array(h264Data);
        const analysis = {
            nalUnits: 0,
            hasSPS: false,
            hasPPS: false,
            hasIDR: false,
            spsData: null,
            ppsData: null,
            totalSize: h264Data.byteLength
        };

        for (let i = 0; i < data.length - 4; i++) {
            // Look for NAL unit start codes (0x00 0x00 0x01 or 0x00 0x00 0x00 0x01)
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                let nalStart = -1;
                if (data[i + 2] === 0x01) {
                    nalStart = i + 3;
                } else if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
                    nalStart = i + 4;
                }

                if (nalStart !== -1 && nalStart < data.length) {
                    const nalType = data[nalStart] & 0x1F;
                    analysis.nalUnits++;
                    
                    // Find end of this NAL unit
                    let nalEnd = data.length;
                    for (let j = nalStart + 1; j < data.length - 3; j++) {
                        if (data[j] === 0x00 && data[j + 1] === 0x00 && 
                            (data[j + 2] === 0x01 || (data[j + 2] === 0x00 && data[j + 3] === 0x01))) {
                            nalEnd = j;
                            break;
                        }
                    }

                    if (nalType === 7) { // SPS
                        analysis.hasSPS = true;
                        analysis.spsData = data.slice(nalStart, nalEnd);
                        // Try to parse VUI timing info from SPS
                        try {
                            analysis.vui = this.parseVUIFromSPS(analysis.spsData);
                        } catch (e) {
                            console.warn("Failed to parse VUI from SPS:", e.message);
                        }
                        // Try to parse dimensions from SPS
                        try {
                            const dimensions = this.parseDimensionsFromSPS(analysis.spsData);
                            if (dimensions) {
                                analysis.width = dimensions.width;
                                analysis.height = dimensions.height;
                            }
                        } catch (e) {
                            console.warn("Failed to parse dimensions from SPS:", e.message);
                        }
                    } else if (nalType === 8) { // PPS
                        analysis.hasPPS = true;
                        analysis.ppsData = data.slice(nalStart, nalEnd);
                    } else if (nalType === 5) { // IDR
                        analysis.hasIDR = true;
                    }
                }
            }
        }

        return analysis;
    }

    /**
     * Parse video dimensions from SPS data
     * Returns {width, height} or null if parsing fails
     */
    static parseDimensionsFromSPS(spsData) {
        try {
            // Create bit reader for SPS data
            const bitReader = new H264BitReader(spsData);
            
            // Skip NAL header (8 bits)
            bitReader.readBits(8);
            
            // Parse SPS header
            const profile_idc = bitReader.readBits(8);
            const constraint_flags = bitReader.readBits(8);
            const level_idc = bitReader.readBits(8);
            
            // seq_parameter_set_id (ue(v))
            const seq_parameter_set_id = bitReader.readUE();
            
            // Handle high profiles (100, 110, 122, 244, 44, 83, 86, 118, 128)
            if (profile_idc === 100 || profile_idc === 110 || profile_idc === 122 || 
                profile_idc === 244 || profile_idc === 44 || profile_idc === 83 || 
                profile_idc === 86 || profile_idc === 118 || profile_idc === 128) {
                
                const chroma_format_idc = bitReader.readUE();
                if (chroma_format_idc === 3) {
                    bitReader.readBits(1); // separate_colour_plane_flag
                }
                bitReader.readUE(); // bit_depth_luma_minus8
                bitReader.readUE(); // bit_depth_chroma_minus8
                bitReader.readBits(1); // qpprime_y_zero_transform_bypass_flag
                
                const seq_scaling_matrix_present_flag = bitReader.readBits(1);
                if (seq_scaling_matrix_present_flag) {
                    const scaling_list_count = (chroma_format_idc !== 3) ? 8 : 12;
                    for (let i = 0; i < scaling_list_count; i++) {
                        const seq_scaling_list_present_flag = bitReader.readBits(1);
                        if (seq_scaling_list_present_flag) {
                            // Skip scaling list parsing
                            this.skipScalingList(bitReader, i < 6 ? 16 : 64);
                        }
                    }
                }
            }
            
            // Continue parsing SPS
            const log2_max_frame_num_minus4 = bitReader.readUE();
            const pic_order_cnt_type = bitReader.readUE();
            
            if (pic_order_cnt_type === 0) {
                bitReader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
            } else if (pic_order_cnt_type === 1) {
                bitReader.readBits(1); // delta_pic_order_always_zero_flag
                bitReader.readSE(); // offset_for_non_ref_pic
                bitReader.readSE(); // offset_for_top_to_bottom_field
                const num_ref_frames_in_pic_order_cnt_cycle = bitReader.readUE();
                for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
                    bitReader.readSE(); // offset_for_ref_frame[i]
                }
            }
            
            bitReader.readUE(); // max_num_ref_frames
            bitReader.readBits(1); // gaps_in_frame_num_value_allowed_flag
            
            // These are the values we need for dimensions
            const pic_width_in_mbs_minus1 = bitReader.readUE();
            const pic_height_in_map_units_minus1 = bitReader.readUE();
            
            const frame_mbs_only_flag = bitReader.readBits(1);
            
            // Calculate dimensions
            // Width is in macroblocks (16 pixels each)
            const width = (pic_width_in_mbs_minus1 + 1) * 16;
            // Height calculation depends on frame_mbs_only_flag
            const height = (pic_height_in_map_units_minus1 + 1) * 16 * (frame_mbs_only_flag ? 1 : 2);
            
            //console.log(`Parsed dimensions from SPS: ${width}x${height}`);
            
            return { width, height };
            
        } catch (error) {
            console.warn("Failed to parse dimensions from SPS:", error.message);
            return null;
        }
    }

    /**
     * Parse VUI (Video Usability Information) from SPS data
     * This parser extracts timing information from H.264 SPS NAL units
     */
    static parseVUIFromSPS(spsData) {
        try {
            //console.log("Parsing VUI from SPS data...");
            
            // Create bit reader for SPS data
            const bitReader = new H264BitReader(spsData);
            
            // Skip NAL header (8 bits)
            bitReader.readBits(8);
            
            // Parse SPS header
            const profile_idc = bitReader.readBits(8);
            const constraint_flags = bitReader.readBits(8);
            const level_idc = bitReader.readBits(8);
            
            // seq_parameter_set_id (ue(v))
            const seq_parameter_set_id = bitReader.readUE();
            
            //console.log(`SPS: profile=${profile_idc}, level=${level_idc}, seq_id=${seq_parameter_set_id}`);
            
            // Handle high profiles (100, 110, 122, 244, 44, 83, 86, 118, 128)
            if (profile_idc === 100 || profile_idc === 110 || profile_idc === 122 || 
                profile_idc === 244 || profile_idc === 44 || profile_idc === 83 || 
                profile_idc === 86 || profile_idc === 118 || profile_idc === 128) {
                
                const chroma_format_idc = bitReader.readUE();
                if (chroma_format_idc === 3) {
                    bitReader.readBits(1); // separate_colour_plane_flag
                }
                bitReader.readUE(); // bit_depth_luma_minus8
                bitReader.readUE(); // bit_depth_chroma_minus8
                bitReader.readBits(1); // qpprime_y_zero_transform_bypass_flag
                
                const seq_scaling_matrix_present_flag = bitReader.readBits(1);
                if (seq_scaling_matrix_present_flag) {
                    const scaling_list_count = (chroma_format_idc !== 3) ? 8 : 12;
                    for (let i = 0; i < scaling_list_count; i++) {
                        const seq_scaling_list_present_flag = bitReader.readBits(1);
                        if (seq_scaling_list_present_flag) {
                            // Skip scaling list parsing - complex and not needed for VUI
                            this.skipScalingList(bitReader, i < 6 ? 16 : 64);
                        }
                    }
                }
            }
            
            // Continue parsing SPS
            const log2_max_frame_num_minus4 = bitReader.readUE();
            const pic_order_cnt_type = bitReader.readUE();
            
            if (pic_order_cnt_type === 0) {
                bitReader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
            } else if (pic_order_cnt_type === 1) {
                bitReader.readBits(1); // delta_pic_order_always_zero_flag
                bitReader.readSE(); // offset_for_non_ref_pic
                bitReader.readSE(); // offset_for_top_to_bottom_field
                const num_ref_frames_in_pic_order_cnt_cycle = bitReader.readUE();
                for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
                    bitReader.readSE(); // offset_for_ref_frame[i]
                }
            }
            
            bitReader.readUE(); // max_num_ref_frames
            bitReader.readBits(1); // gaps_in_frame_num_value_allowed_flag
            bitReader.readUE(); // pic_width_in_mbs_minus1
            bitReader.readUE(); // pic_height_in_map_units_minus1
            
            const frame_mbs_only_flag = bitReader.readBits(1);
            if (!frame_mbs_only_flag) {
                bitReader.readBits(1); // mb_adaptive_frame_field_flag
            }
            
            bitReader.readBits(1); // direct_8x8_inference_flag
            
            const frame_cropping_flag = bitReader.readBits(1);
            if (frame_cropping_flag) {
                bitReader.readUE(); // frame_crop_left_offset
                bitReader.readUE(); // frame_crop_right_offset
                bitReader.readUE(); // frame_crop_top_offset
                bitReader.readUE(); // frame_crop_bottom_offset
            }
            
            // Finally, check for VUI parameters
            const vui_parameters_present_flag = bitReader.readBits(1);
            //console.log(`VUI parameters present: ${vui_parameters_present_flag}`);
            
            if (vui_parameters_present_flag) {
                return this.parseVUIParameters(bitReader);
            }
            
            return null;
            
        } catch (error) {
            console.warn("Failed to parse VUI from SPS:", error.message);
            //console.log("SPS data length:", spsData.length, "bytes");
            if (spsData.length > 0) {
                //console.log("First few bytes:", Array.from(spsData.slice(0, Math.min(16, spsData.length))).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
            }
            return null;
        }
    }

    /**
     * Parse VUI parameters from bit stream
     */
    static parseVUIParameters(bitReader) {
        const vui = {};
        
        // aspect_ratio_info_present_flag
        const aspect_ratio_info_present_flag = bitReader.readBits(1);
        if (aspect_ratio_info_present_flag) {
            const aspect_ratio_idc = bitReader.readBits(8);
            if (aspect_ratio_idc === 255) { // Extended_SAR
                bitReader.readBits(16); // sar_width
                bitReader.readBits(16); // sar_height
            }
        }
        
        // overscan_info_present_flag
        const overscan_info_present_flag = bitReader.readBits(1);
        if (overscan_info_present_flag) {
            bitReader.readBits(1); // overscan_appropriate_flag
        }
        
        // video_signal_type_present_flag
        const video_signal_type_present_flag = bitReader.readBits(1);
        if (video_signal_type_present_flag) {
            bitReader.readBits(3); // video_format
            bitReader.readBits(1); // video_full_range_flag
            const colour_description_present_flag = bitReader.readBits(1);
            if (colour_description_present_flag) {
                bitReader.readBits(8); // colour_primaries
                bitReader.readBits(8); // transfer_characteristics
                bitReader.readBits(8); // matrix_coefficients
            }
        }
        
        // chroma_loc_info_present_flag
        const chroma_loc_info_present_flag = bitReader.readBits(1);
        if (chroma_loc_info_present_flag) {
            bitReader.readUE(); // chroma_sample_loc_type_top_field
            bitReader.readUE(); // chroma_sample_loc_type_bottom_field
        }
        
        // timing_info_present_flag - This is what we're looking for!
        vui.timing_info_present = bitReader.readBits(1);
        //console.log(`Timing info present: ${vui.timing_info_present}`);
        
        if (vui.timing_info_present) {
            vui.num_units_in_tick = bitReader.readBits(32);
            vui.time_scale = bitReader.readBits(32);
            vui.fixed_frame_rate_flag = bitReader.readBits(1);
            
            //console.log(`VUI Timing: num_units_in_tick=${vui.num_units_in_tick}, time_scale=${vui.time_scale}, fixed_frame_rate=${vui.fixed_frame_rate_flag}`);
            
            // Calculate frame rate
            if (vui.num_units_in_tick > 0 && vui.time_scale > 0) {
                // The formula depends on the video structure:
                // - For progressive video: fps = time_scale / (2 * num_units_in_tick)
                // - For interlaced video: fps = time_scale / num_units_in_tick
                // - Some encoders use different conventions
                
                // Try both formulas and pick the most reasonable one
                const fps_progressive = vui.time_scale / (2 * vui.num_units_in_tick);
                const fps_interlaced = vui.time_scale / vui.num_units_in_tick;
                
                // Choose the one that's in a reasonable range (1-240 fps)
                let fps = fps_progressive;
                if (fps_progressive < 1 || fps_progressive > 240) {
                    if (fps_interlaced >= 1 && fps_interlaced <= 240) {
                        fps = fps_interlaced;
                        //console.log(`Using interlaced formula for FPS calculation`);
                    }
                }
                
                vui.calculated_fps = fps;
                //console.log(`Calculated FPS from VUI: ${fps} (progressive: ${fps_progressive}, interlaced: ${fps_interlaced})`);
            }
        }
        
        return vui;
    }

    /**
     * Skip scaling list parsing (complex and not needed for timing info)
     */
    static skipScalingList(bitReader, sizeOfScalingList) {
        let lastScale = 8;
        let nextScale = 8;
        
        for (let j = 0; j < sizeOfScalingList; j++) {
            if (nextScale !== 0) {
                const delta_scale = bitReader.readSE();
                nextScale = (lastScale + delta_scale + 256) % 256;
            }
            lastScale = (nextScale === 0) ? lastScale : nextScale;
        }
    }



}