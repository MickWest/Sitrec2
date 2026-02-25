import {Sit} from "./Globals";
import {assert} from "./assert";
import {loadImage} from "./utils";
import {CVideoWebCodecBase} from "./CVideoWebCodecBase";
import {H264Decoder} from "./H264Decoder";
import {updateSitFrames} from "./UpdateSitFrames";
import {EventManager} from "./CEventManager";
import {showError} from "./showError";

/**
 * Video data handler for raw H.264 elementary streams with frame caching
 * These are typically extracted from TS files and lack MP4 container structure
 * Now implements on-demand frame decoding similar to CVideoMp4Data
 * 
 * Key responsibilities:
 * - Parses raw H.264 NAL units from elementary streams
 * - Extracts SPS/PPS for decoder configuration
 * - Creates EncodedVideoChunks from NAL units
 * - Handles orphaned delta frames before first keyframe
 * - Implements fallback strategies for incompatible streams
 * - Attempts VUI timing info extraction for FPS detection
 * 
 * H.264 stream requirements:
 * - Must contain SPS (Sequence Parameter Set) and PPS (Picture Parameter Set)
 * - Should start with keyframe (IDR) for proper decoding
 * - Orphaned delta frames before first keyframe are skipped
 * 
 * Decoder configuration strategy:
 * 1. Try exact codec string from SPS profile/level
 * 2. Fallback to common profiles (Main@3.1, Baseline@3.0)
 * 3. Attempt Annex-B format if AVCC fails
 * 4. Show informative error if all strategies fail
 * 
 * Constructor options:
 * - fps: Frame rate (optional, defaults to 30 if not detected from stream)
 * - dropFile: File object for dropped files
 * - buffer: ArrayBuffer containing H.264 data
 */
export class CVideoH264Data extends CVideoWebCodecBase {

    constructor(v, loadedCallback, errorCallback) {
        super(v, loadedCallback, errorCallback);
        this.format = "h264";

        if (this.incompatible) {
            return;
        }

        // Initialize frame caching system
        this.initializeCaching(v, loadedCallback, errorCallback);
    }





    getProfileName(profileIdc) {
        const profiles = {
            0x42: 'Baseline',
            0x4D: 'Main',
            0x58: 'Extended',
            0x64: 'High'
        };
        return profiles[profileIdc] || `Unknown (0x${profileIdc.toString(16)})`;
    }

    getLevelName(levelIdc) {
        const levels = {
            0x1E: '3.0',
            0x1F: '3.1',
            0x20: '3.2',
            0x28: '4.0',
            0x29: '4.1'
        };
        return levels[levelIdc] || `Unknown (0x${levelIdc.toString(16)})`;
    }



    /**
     * Override decoder callbacks for H.264-specific logic
     */
    createDecoderCallbacks() {
        return {
            output: videoFrame => {
                try {
                    this.format = videoFrame.format;
                    this.lastDecodeInfo = "last frame.timestamp = " + videoFrame.timestamp + "<br>";

                    const frameNumber = this.timestampToChunkIndex?.get(videoFrame.timestamp);
                    if (frameNumber === undefined) {
                        videoFrame.close();
                        return;
                    }

                    const group = this.getGroup(frameNumber);
                    if (!group) {
                        videoFrame.close();
                        return;
                    }

                    group.decodePending++;
                    this.processDecodedFrame(frameNumber, videoFrame, group);
                    
                } catch (error) {
                    showError("Error in decoder output callback:", error);
                    videoFrame.close();
                }
            },
            error: e => {
                this.handleDecoderError(e);
            }
        };
    }

    /**
     * Override processDecodedFrame to add H.264-specific first decode success logging
     */
    processDecodedFrame(frameNumber, videoFrame, group) {
        // If this is our first successful decode, mark success
        if (!this.firstDecodeSuccess) {
            this.firstDecodeSuccess = true;
            console.log(`H.264 decoder working - first frame decoded successfully (${videoFrame.codedWidth}x${videoFrame.codedHeight})`);
        }

        // Call base class implementation
        super.processDecodedFrame(frameNumber, videoFrame, group);
    }

    /**
     * Override decoder error handling for H.264-specific error recovery
     */
    handleDecoderError(e) {
        // If we're in alternative decoding mode, don't recreate - just log and continue
        if (this.alternativeDecoding) {
            return;
        }
        
        // Only mark as unusable for fatal errors, not decode errors
        if (e.name === 'NotSupportedError' || e.name === 'InvalidStateError') {
            this.decoderError = true;
            showError("Fatal H.264 decoder error:", e.message);
        } else if (e.name === 'EncodingError') {
            // Prevent infinite recreation loops
            if (!this.recreationAttempts) this.recreationAttempts = 0;
            if (this.recreationAttempts < 1) {
                this.recreationAttempts++;
                console.log("H.264 decode error, attempting to recreate decoder...");
                this.recreateDecoder();
            } else {
                console.log("H.264 decoder recreation failed, trying alternative format...");
                this.decoderError = true;
                this.alternativeDecoding = true;
                this.tryAlternativeDecoding().catch(error => {
                    console.warn("H.264 alternative decoding failed:", error.message);
                });
            }
        } else {
            console.warn("H.264 decoder error (non-fatal):", e.message);
        }
    }

    /**
     * Override group completion handling for H.264-specific nextRequest logic
     */
    handleGroupComplete() {
        if (this.groupsPending === 0 && this.nextRequest != null) {
            const group = this.nextRequest;
            this.nextRequest = null;
            this.requestGroup(group);
        }
    }

    /**
     * Override busy decoder handling for H.264-specific nextRequest logic
     */
    handleBusyDecoder(group) {
        this.nextRequest = group;
    }

    /**
     * Override to show H.264-specific additional debug information
     */
    getAdditionalDebugInfo() {
        let info = "";
        if (this.decoderError) {
            info += "⚠️ Decoder Error State: " + this.decoderError;
        }
        if (this.alternativeDecoding) {
            info += " | Alternative Decoding Mode";
        }
        if (this.recreationAttempts > 0) {
            info += " | Recreation Attempts: " + this.recreationAttempts;
        }
        return info;
    }

    async initializeCaching(v, loadedCallback, errorCallback) {
        try {
            console.log("Initializing H.264 frame caching system...");

            let h264Buffer;

            // Get the H.264 data from either file or buffer
            if (v.dropFile) {
                // Read the dropped file
                const arrayBuffer = await this.readFileAsArrayBuffer(v.dropFile);
                h264Buffer = arrayBuffer;
            } else if (v.buffer) {
                h264Buffer = v.buffer;
            } else {
                throw new Error("No H.264 data available");
            }

            console.log(`H.264 data size: ${h264Buffer.byteLength} bytes`);

            // Store h264 data for potential alternative decoding
            this.h264Data = h264Buffer;

            // Reset caching variables for this initialization
            this.frames = 0;
            this.chunks = [];
            this.groups = [];
            this.groupsPending = 0;
            this.nextRequest = null;
            this.decoderError = false; // Reset decoder error flag
            this.recreationAttempts = 0; // Reset recreation attempts

            // Analyze H.264 stream
            console.log("Analyzing H.264 stream...");
            const analysis = H264Decoder.analyzeH264Stream(h264Buffer);
            console.log("H.264 Stream Analysis:", analysis);

            if (!analysis.hasSPS || !analysis.hasPPS) {
                throw new Error(
                    `H.264 stream missing required parameters: ` +
                    `${analysis.hasSPS ? 'has' : 'missing'} SPS, ` +
                    `${analysis.hasPPS ? 'has' : 'missing'} PPS`
                );
            }

            // Set video dimensions from SPS if available
            if (analysis.width && analysis.height) {
                this.videoWidth = analysis.width;
                this.videoHeight = analysis.height;
                // Store original dimensions (never changed, used for tracking/analysis)
                this.originalVideoWidth = analysis.width;
                this.originalVideoHeight = analysis.height;
                console.log(`✓ Video dimensions from SPS: ${this.videoWidth}x${this.videoHeight}`);
            } else {
                console.warn("⚠️ Could not parse dimensions from SPS, will use default 100x100 until first frame is decoded");
            }

            // Validate SPS/PPS data
            if (!analysis.spsData || analysis.spsData.length < 4) {
                throw new Error(`Invalid SPS data: ${analysis.spsData ? analysis.spsData.length : 'null'} bytes`);
            }
            if (!analysis.ppsData || analysis.ppsData.length < 1) {
                throw new Error(`Invalid PPS data: ${analysis.ppsData ? analysis.ppsData.length : 'null'} bytes`);
            }

            console.log(`SPS data: ${analysis.spsData.length} bytes, PPS data: ${analysis.ppsData.length} bytes`);

            // Extract NAL units and create chunks
            const nalUnits = H264Decoder.extractNALUnits(new Uint8Array(h264Buffer));

            // Try to determine FPS from H.264 stream
            let fps = v.fps || 30; // Use provided FPS or default to 30
            
            // Log what timing info we have available
            console.log("H.264 Analysis timing info:", {
                hasVUI: !!analysis.vui,
                timingInfoPresent: analysis.vui?.timing_info_present,
                calculatedFPS: analysis.vui?.calculated_fps,
                providedFPS: v.fps,
                usingFPS: fps
            });
            
            if (v.fps) {
                console.log(`✓ Using provided FPS: ${fps}`);
            } else if (analysis.vui && analysis.vui.timing_info_present && analysis.vui.calculated_fps) {
                const calculatedFps = analysis.vui.calculated_fps;
                if (calculatedFps > 0 && calculatedFps <= 240) {
                    fps = Math.round(calculatedFps * 100) / 100; // Round to 2 decimal places
                    console.log(`✓ Detected FPS from VUI timing info: ${fps}`);
                } else {
                    console.warn(`⚠️ Invalid FPS calculated from VUI: ${calculatedFps}, using default ${fps}`);
                }
            } else {
                console.warn(`⚠️ No VUI timing info available in H.264 stream, using default ${fps} FPS`);
                console.log("💡 You can specify FPS in the constructor: new CVideoH264Data({..., fps: 25})");
                console.log("📺 Common frame rates: 24 (cinema), 25 (PAL), 29.97/30 (NTSC), 50/60 (high frame rate)");
            }

            const encodedChunks = H264Decoder.createEncodedVideoChunks(nalUnits, fps);
            console.log(`Created ${encodedChunks.length} video chunks`);

            // Diagnostic: Check for orphaned frames before first keyframe
            this.diagnosticCheckFrameStructure(encodedChunks);

            // Process chunks to create groups (similar to MP4 demuxer)
            this.processChunksIntoGroups(encodedChunks);



            let spsData = analysis.spsData;
            let ppsData = analysis.ppsData;

            // Keep SPS bytes unmodified; do not twiddle constraint flags.

            const description = H264Decoder.createAVCDecoderConfig(spsData, ppsData);

            // Create codec string from SPS data with compatibility fallbacks
            // SPS structure: [NAL_header, profile_idc, constraint_flags, level_idc, ...]
            const profile = spsData[1];        // profile_idc
            const compatibility = spsData[2];  // constraint_set_flags
            const level = spsData[3];          // level_idc

            // CRITICAL: Codec string MUST exactly match the SPS profile/level data
            // Using mismatched codec strings causes "Decoder error" in WebCodecs
            const actualCodec = `avc1.${profile.toString(16).padStart(2, '0')}${compatibility.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;

            const codecConfigs = [
                {
                    codec: actualCodec,
                    description: description,
                    name: `Actual SPS (${this.getProfileName(profile)}@${this.getLevelName(level)})`
                },
                {
                    codec: 'avc1.4d401f',
                    description: description,
                    name: 'Fallback Main@3.1'
                },
                {
                    codec: 'avc1.42001e',
                    description: description,
                    name: 'Fallback Baseline@3.0'
                }
            ];

            let config = null;

            // Try each configuration until one works
            for (const testConfig of codecConfigs) {
                try {
                    console.log(`Testing codec configuration: ${testConfig.name} (${testConfig.codec})`);
                    const isSupported = await VideoDecoder.isConfigSupported(testConfig);
                    console.log(`Codec support result:`, isSupported);

                    if (isSupported.supported) {
                        config = testConfig;
                        console.log(`✅ Using compatible codec: ${testConfig.name}`);
                        break;
                    } else {
                        console.log(`❌ Codec not supported: ${testConfig.name}`);
                    }
                } catch (supportError) {
                    console.warn(`Could not check support for ${testConfig.name}:`, supportError);
                    // If we can't check support, try it anyway (fallback for older browsers)
                    if (!config) {
                        config = testConfig;
                        console.log(`🔄 Fallback to: ${testConfig.name}`);
                    }
                }
            }

            if (!config) {
                // Ultimate fallback - use original config
                config = codecConfigs[0];
                console.warn('⚠️ No supported codec found, using original configuration');
            }

            console.log(`Decoder config: codec=${config.codec}, description=${config.description.byteLength} bytes`);
            console.log(`Profile: 0x${profile.toString(16)}, Compatibility: 0x${compatibility.toString(16)}, Level: 0x${level.toString(16)}`);

            // Debug: Validate AVCC configuration
            const avccData = new Uint8Array(config.description);
            console.log("🔍 AVCC Config validation:");
            console.log(`   Version: ${avccData[0]} (should be 1)`);
            console.log(`   Profile: 0x${avccData[1].toString(16)} (should match SPS)`);
            console.log(`   Compatibility: 0x${avccData[2].toString(16)}`);
            console.log(`   Level: 0x${avccData[3].toString(16)} (should match SPS)`);
            console.log(`   Length size: ${(avccData[4] & 0x03) + 1} bytes (should be 4)`);
            console.log(`   SPS count: ${avccData[5] & 0x1F} (should be 1)`);

            if (avccData[0] !== 1) {
                showError("   ❌ Invalid AVCC version");
            }
            if (avccData[1] !== profile) {
                showError(`   ❌ AVCC profile mismatch: config=0x${avccData[1].toString(16)}, SPS=0x${profile.toString(16)}`);
            }
            if (avccData[3] !== level) {
                showError(`   ❌ AVCC level mismatch: config=0x${avccData[3].toString(16)}, SPS=0x${level.toString(16)}`);
            }

            this.config = config;
            this.recreationAttempts = 0;

            this.configureWorker(config);

            console.log(`H.264 initialization complete: ${this.frames} frames`);
            console.log(`📊 Using decode order as frame sequence - frames will be numbered 0, 1, 2, 3... as decoded`);
            console.log(`🎯 This ensures consistent frame ordering regardless of H.264 internal timestamps`);

            // Set global video properties
            Sit.videoFrames = this.frames * this.videoSpeed;
            Sit.fps = fps;
            this.detectedFps = fps; // Store for debugging

            updateSitFrames();

            this.loaded = true;

            // Only call the callback if it hasn't been cleared (disposed)
            // Pass this so the callback knows which videoData loaded
            // (important when multiple videos are loading concurrently)
            if (this.loadedCallback) {
                this.loadedCallback(this);
            }

            EventManager.dispatchEvent("videoLoaded", {
                videoData: this,
                width: this.videoWidth,
                height: this.videoHeight
            });

        } catch (error) {
            showError("Failed to initialize H.264 caching:", error);
            console.warn("Falling back to error state");

            this.errorImage = null;
            loadImage('./data/images/errorImage.png').then(result => {
                this.errorImage = result;
                if (errorCallback) errorCallback(`H.264 initialization failed: ${error.message}`);
            });
        }
    }

    /**
     * Diagnostic function to check H.264 stream structure validity
     * Identifies orphaned frames and validates keyframe placement
     * @param {Array} encodedChunks - Array of EncodedVideoChunk objects
     */
    diagnosticCheckFrameStructure(encodedChunks) {
        if (encodedChunks.length === 0) {
            console.warn("⚠️ No encoded chunks found!");
            return;
        }

        // Check if frame 0 is a keyframe
        const frame0Type = encodedChunks[0].type;
        if (frame0Type !== 'key') {
            console.error(`❌ INVALID H.264 STREAM: Frame 0 is type '${frame0Type}', NOT a keyframe!`);
            console.error("   H.264 streams MUST start with a keyframe (IDR/type='key')");
            console.error("   This file was likely improperly extracted from a .TS container.");
        } else {
            console.log(`✓ Frame 0 is correctly a keyframe`);
        }

        // Find first keyframe
        let firstKeyframeIndex = -1;
        for (let i = 0; i < encodedChunks.length; i++) {
            if (encodedChunks[i].type === 'key') {
                firstKeyframeIndex = i;
                break;
            }
        }

        if (firstKeyframeIndex === -1) {
            console.error("❌ CRITICAL: No keyframe found in entire stream!");
            return;
        }

        if (firstKeyframeIndex > 0) {
            console.error(`❌ ORPHANED FRAMES: Frames 0-${firstKeyframeIndex - 1} are delta frames before first keyframe`);
            console.error(`   These ${firstKeyframeIndex} frames CANNOT be decoded and will be skipped`);
            
            // Show frame type sequence
            let frameSequence = [];
            for (let i = 0; i < Math.min(20, encodedChunks.length); i++) {
                frameSequence.push(encodedChunks[i].type === 'key' ? 'K' : 'D');
            }
            console.error(`   Frame sequence (first 20): ${frameSequence.join('')}${encodedChunks.length > 20 ? '...' : ''}`);
            
            // Count total orphaned vs usable
            let orphanedCount = firstKeyframeIndex;
            let usableCount = encodedChunks.length - orphanedCount;
            console.error(`   Total: ${orphanedCount} orphaned + ${usableCount} usable = ${encodedChunks.length} frames`);
            console.error(`   Usable video duration: ~${(usableCount / 30).toFixed(2)}s (at 30fps)`);
        }

        // General frame breakdown
        let keyframeCount = 0;
        let deltaCount = 0;
        for (const chunk of encodedChunks) {
            if (chunk.type === 'key') keyframeCount++;
            else deltaCount++;
        }
        console.log(`📊 Frame breakdown: ${keyframeCount} keyframes, ${deltaCount} delta frames (${((keyframeCount/encodedChunks.length)*100).toFixed(1)}% key)`);
    }

    /**
     * Process encoded chunks into frame groups for efficient decoding
     * Groups start at keyframes and include following delta frames
     * Handles orphaned delta frames that appear before first keyframe
     * @param {Array} encodedChunks - Array of EncodedVideoChunk objects
     */
    processChunksIntoGroups(encodedChunks) {
        // Process chunks similar to how MP4Demuxer does it
        let orphanedDeltaFrames = 0;
        
        for (let i = 0; i < encodedChunks.length; i++) {
            const chunk = encodedChunks[i];
            chunk.frameNumber = this.frames++;
            this.chunks.push(chunk);

            const rawBuf = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(rawBuf);
            this.rawChunkData.push(rawBuf);

            if (chunk.type === "key") {
                // Log first keyframe for diagnostic purposes
                if (this.groups.length === 0 && i > 0) {
                    console.log(`📍 First keyframe found at chunk index ${i} (frame ${i} in input, group frame ${this.chunks.length - 1} in output)`);
                    if (orphanedDeltaFrames > 0) {
                        console.warn(`   → This created Group 0 starting at frame ${this.chunks.length - 1}, skipping ${orphanedDeltaFrames} delta frames`);
                    }
                }
                
                this.groups.push({
                    frame: this.chunks.length - 1,  // first frame of this group
                    length: 1,                      // for now, increase with each delta
                    pending: 0,                     // how many frames requested and pending
                    loaded: false,                  // set when all the frames in the group are loaded
                    timestamp: chunk.timestamp,
                });
            } else {
                const lastGroup = this.groups[this.groups.length - 1];
                if (lastGroup) {
                    assert(chunk.timestamp >= lastGroup.timestamp, "out of group chunk timestamp");
                    lastGroup.length++;
                } else {
                    // Delta frame before any keyframe - this is orphaned
                    orphanedDeltaFrames++;
                    if (orphanedDeltaFrames <= 5) {
                        console.debug(`   Skipping orphaned delta frame ${i}`);
                    } else if (orphanedDeltaFrames === 6) {
                        console.debug(`   ... (skipping more orphaned frames)`);
                    }
                }
            }
        }
        
        // Log group structure for diagnostics
        console.log(`📋 Created ${this.groups.length} groups from ${encodedChunks.length} chunks`);
        for (let g = 0; g < this.groups.length; g++) {
            const group = this.groups[g];
            const endFrame = group.frame + group.length - 1;
            if (g<5) console.log(`   Group ${g}: frames ${group.frame}-${endFrame} (${group.length} frames total)`);
        }
        if (orphanedDeltaFrames > 0) {
            console.error(`   ⚠️ WARNING: ${orphanedDeltaFrames} frames were orphaned and not added to any group`);
        }

        this.buildTimestampMap();
    }







    async tryAlternativeDecoding() {
        console.log("Trying alternative H.264 decoding approach...");

        try {
            // Get the original NAL units and analysis
            const nalUnits = H264Decoder.extractNALUnits(new Uint8Array(this.h264Data));
            const analysis = H264Decoder.analyzeH264Stream(this.h264Data);
            const frames = H264Decoder.groupNALUnitsIntoFrames(nalUnits);
            
            // Recreate chunks with SPS/PPS included in keyframes (Annex-B format)
            const fps = 30;
            const frameDuration = 1000000 / fps;
            let timestamp = 0;
            
            this.chunks = [];
            for (const frame of frames) {
                if (frame.nalUnits.length === 0) continue;

                let frameNalUnits = [...frame.nalUnits];
                
                // For keyframes, prepend SPS and PPS
                if (frame.type === 'key') {
                    const spsNal = { data: analysis.spsData };
                    const ppsNal = { data: analysis.ppsData };
                    frameNalUnits = [spsNal, ppsNal, ...frameNalUnits];
                }

                // Create Annex-B format with start codes
                const frameData = H264Decoder.createAnnexBFrame(frameNalUnits);
                
                this.chunks.push(new EncodedVideoChunk({
                    type: frame.type,
                    timestamp: timestamp,
                    duration: frameDuration,
                    data: frameData
                }));
                timestamp += frameDuration;
            }
            
            console.log(`Recreated ${this.chunks.length} chunks in Annex-B format`);
            
            // Try Annex-B decoder configuration (no description needed)
            const annexBConfig = { codec: this.config.codec };
            
            // Close existing decoder
            if (this.decoder && this.decoder.state !== 'closed') {
                try {
                    this.decoder.close();
                } catch (e) {
                    console.warn("Error closing decoder:", e);
                }
            }
            
            // Create new decoder
            this.decoder = new VideoDecoder(this.decoderCallbacks);
            await this.decoder.configure(annexBConfig);
            
            // Try decoding the first keyframe
            this.recreationAttempts = 0;
            
            // Find first keyframe and try to decode it
            for (let i = 0; i < Math.min(5, this.chunks.length); i++) {
                if (this.chunks[i].type === 'key') {
                    try {
                        this.decoder.decode(this.chunks[i]);
                        
                        // Wait briefly to see if decode succeeds
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                        if (this.decoder.state === 'configured') {
                            console.log("Alternative H.264 format working");
                        } else {
                            console.log("Alternative H.264 format failed, showing error");
                            this.showDecoderError();
                            return;
                        }
                        
                        break;
                    } catch (error) {
                        console.log(`Keyframe ${i} decode failed:`, error.message);
                    }
                }
            }
            
        } catch (error) {
            console.log("Alternative H.264 decoding failed:", error.message);
            this.showDecoderError();
        }
    }
    
    showDecoderError() {
        console.log("H.264 stream incompatible with WebCodecs, showing error image");
        
        // Mark as decoder error
        this.decoderError = true;
        this.fallbackMode = true;
        
        // Create informative error image
        this.createInformativeErrorImage();
        
        // Set up basic video properties if we have them
        if (this.chunks && this.chunks.length > 0) {
            this.frames = this.chunks.length;
        }
        
        // Call loaded callback to indicate we're "ready" (even if in fallback mode)
        // Pass this so the callback knows which videoData loaded
        if (this.loadedCallback) {
            this.loadedCallback(this);
        }
    }
    
    createInformativeErrorImage() {
        // Create a more informative error image with details about the issue
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        
        // Black background
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // White text
        ctx.fillStyle = 'white';
        ctx.font = '24px Arial';
        ctx.textAlign = 'center';
        
        const centerX = canvas.width / 2;
        let y = 100;
        
        ctx.fillText('H.264 Video Decoding Failed', centerX, y);
        y += 40;
        
        ctx.font = '16px Arial';
        ctx.fillText('This H.264 stream is not compatible with WebCodecs', centerX, y);
        y += 30;
        ctx.fillText('The video format may be too old or use unsupported features', centerX, y);
        y += 40;
        
        ctx.fillText('Technical Details:', centerX, y);
        y += 25;
        ctx.font = '14px Arial';
        ctx.fillText(`• Profile: ${this.getProfileName(0x4D)} Level: ${this.getLevelName(0x29)}`, centerX, y);
        y += 20;
        ctx.fillText(`• Frames: ${this.chunks ? this.chunks.length : 'Unknown'}`, centerX, y);
        y += 20;
        ctx.fillText(`• Format: Raw H.264 Elementary Stream`, centerX, y);
        y += 40;
        
        ctx.fillText('Possible solutions:', centerX, y);
        y += 25;
        ctx.fillText('• Re-encode video with modern H.264 settings', centerX, y);
        y += 20;
        ctx.fillText('• Use MP4 container format instead of raw H.264', centerX, y);
        y += 20;
        ctx.fillText('• Try a different browser (Chrome/Edge/Safari)', centerX, y);
        
        this.errorImage = canvas;
    }

    async recreateDecoder() {
        try {
            // Close existing decoder if it exists
            if (this.decoder && this.decoder.state !== 'closed') {
                try {
                    this.decoder.close();
                } catch (e) {
                    // Ignore close errors
                }
            }

            // Create new decoder using base class method
            this.decoder = this.createDecoder();

            // Reconfigure with stored config
            if (this.config) {
                await this.decoder.configure(this.config);
            } else {
                throw new Error("No decoder configuration available");
            }

        } catch (error) {
            console.log("Failed to recreate H.264 decoder:", error.message);
            this.decoderError = true;
        }
    }

    readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Update FPS after loading (useful for manual correction)
     * @param {number} newFps - New frame rate
     */
    updateFPS(newFps) {
        if (newFps > 0 && newFps <= 240) {
            console.log(`Updating H.264 FPS from ${Sit.fps} to ${newFps}`);
            Sit.fps = newFps;
            this.detectedFps = newFps;
            
            // Update frame timing if needed
            updateSitFrames();
            
            console.log(`✓ FPS updated to ${newFps}`);
        } else {
            showError(`Invalid FPS value: ${newFps}. Must be between 0 and 240.`);
        }
    }

    /**
     * Get debug info including FPS detection details
     */
    getDebugFPSInfo() {
        return {
            detectedFps: this.detectedFps,
            currentFps: Sit.fps,
            wasProvided: !!this.v?.fps,
            providedFps: this.v?.fps
        };
    }
    
    dispose() {
        // Clear callbacks to prevent them from firing after disposal
        this.loadedCallback = null;
        this.errorCallback = null;
        
        // Call parent dispose
        super.dispose();
    }
}