/**
 * Audio handler for MP4 video files using WebCodec AudioDecoder
 * Manages audio extraction, decoding, and synchronized playback
 * 
 * Key responsibilities:
 * - Decodes audio samples from MP4 demuxer using AudioDecoder
 * - Creates and manages Web Audio API context and nodes
 * - Synchronizes audio playback with video frame position
 * - Handles volume control and muting
 * - Manages audio buffer creation and playback timing
 * 
 * Synchronization approach:
 * - Waits for all audio samples to be decoded before playback
 * - Creates single AudioBuffer from all decoded chunks
 * - Uses AudioBufferSourceNode for precise timing control
 * - Restarts playback when frame position jumps
 * 
 * Disposal strategy:
 * - Immediately stops audio playback with stop(0)
 * - Disconnects audio nodes from graph
 * - Suspends AudioContext before closing
 * - Clears all timeouts and resources
 * 
 * Debug mode:
 * To enable debugging: videoNode.audioHandler.enableDebug()
 * This will log timestamp gaps and sample discontinuities at chunk boundaries
 */
export class CAudioMp4Data {
    constructor(videoData) {
        this.videoData = videoData;
        this.audioContext = null;
        this.audioDecoder = null;
        this.isPlaying = false;
        this.volume = 1.0;
        this.isMuted = true;
        this.decodedAudioData = [];
        this.sourceNode = null;
        this.gainNode = null;
        this.isInitialized = false;
        this.audioStartTime = 0;
        this.startFrame = 0;
        this.fps = 30;
        this.audioBuffer = null;
        this.audioBufferSource = null;
        this.lastCombinedSamples = 0;
        this.isBufferSourceStarted = false;
        this.expectedAudioSamples = 0;
        this.receivedEncodedSamples = 0;
        this.decodingComplete = false;
        this._playbackRetryTimeout = null;
        this._lastBufferDecodedCount = 0;
        this._bufferCreationInProgress = false;
        this._bufferCreatedSuccessfully = false;
        this.playbackStartTime = 0;
        this.playbackStartFrame = 0;
        this.debug = false;

        this.checkAudioSupport();
    }
    
    enableDebug() {
        this.debug = true;
        console.log("[Audio] Debug mode enabled");
    }

    checkAudioSupport() {
        try {
            if (AudioDecoder === undefined) {
                if (this.debug) console.warn("AudioDecoder not supported");
                return false;
            }
            return true;
        } catch (e) {
            if (this.debug) console.warn("Audio not supported:", e);
            return false;
        }
    }

    async initializeAudio(demuxer) {
        if (this.isInitialized) {
            if (this.debug) console.log("Audio already initialized");
            return;
        }

        try {
            const audioConfig = await demuxer.getAudioConfig();
            if (!audioConfig) {
                if (this.debug) console.log("No audio track found in video");
                return;
            }

            if (this.debug) console.log("Audio config:", audioConfig);

            if (!audioConfig.codec) {
                if (this.debug) console.warn("No codec specified in audio config");
                return;
            }

            try {
                const support = await AudioDecoder.isConfigSupported(audioConfig);
                if (!support.supported) {
                    if (this.debug) console.warn("Audio codec not supported:", audioConfig.codec);
                    if (this.debug) console.warn("Config details:", audioConfig);
                    return;
                }
            } catch (e) {
                if (this.debug) console.warn("Error checking audio codec support:", e);
                return;
            }

            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass({
                sampleRate: audioConfig.sampleRate
            });
            if (this.debug) console.log("AudioContext created with sampleRate:", audioConfig.sampleRate);

            this.audioDecoder = new AudioDecoder({
                output: audioData => {
                    if (this.debug) console.log("Audio frame decoded, numberOfFrames:", audioData.numberOfFrames);
                    this.handleDecodedAudio(audioData);
                },
                error: e => {
                    if (this.debug) console.error("Audio decoder error:", e);
                }
            });

            this.audioDecoder.configure(audioConfig);
            if (this.debug) console.log("Audio decoder configured successfully with codec:", audioConfig.codec);

            this.setupAudioNodes();

            this.isInitialized = true;
            if (this.debug) console.log("Audio initialized successfully");
        } catch (e) {
            if (this.debug) console.error("Error initializing audio:", e);
        }
    }

    setupAudioNodes() {
        if (!this.audioContext) return;

        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = this.volume;
        this.gainNode.connect(this.audioContext.destination);
    }

    handleDecodedAudio(audioData) {
        if (this.debug && this.decodedAudioData.length > 0) {
            const prev = this.decodedAudioData[this.decodedAudioData.length - 1];
            const prevDuration = prev.data.duration || (prev.data.numberOfFrames / prev.data.sampleRate * 1000000);
            const expectedNextTimestamp = prev.timestamp + prevDuration;
            const gap = audioData.timestamp - expectedNextTimestamp;
            if (Math.abs(gap) > 100) {
                console.warn(`[Audio] Timestamp gap: ${gap.toFixed(0)}μs between chunks ${this.decodedAudioData.length - 1} and ${this.decodedAudioData.length}`);
            }
        }
        
        const duration = audioData.duration || (audioData.numberOfFrames / audioData.sampleRate * 1000000);
        
        this.decodedAudioData.push({
            data: audioData,
            timestamp: audioData.timestamp,
            duration: duration
        });
        this.streamAudio?.append(audioData);
    }

    decodeAudioSamples(samples, demuxer) {
       // console.log("[Audio] decodeAudioSamples called with", samples?.length, "samples");
        
        if (!this.audioDecoder) {
            console.warn("[Audio] Audio decoder not initialized");
            return;
        }

        if (this.audioDecoder.state !== "configured") {
            console.warn("[Audio] Audio decoder state:", this.audioDecoder.state, "(expected: configured)");
            return;
        }

       // console.log("[Audio] Decoding", samples.length, "audio samples");
        this.receivedEncodedSamples += samples.length;

        for (const sample of samples) {
            const chunk = new EncodedAudioChunk({
                type: sample.is_sync ? "key" : "delta",
                timestamp: this.streamAudio && sample.timescale ? Math.round(sample.cts * 1e6 / sample.timescale) : sample.cts,
                duration: this.streamAudio && sample.timescale ? Math.round(sample.duration * 1e6 / sample.timescale) : sample.duration,
                data: sample.data
            });

            try {
                this.audioDecoder.decode(chunk);
            } catch (e) {
                if (this.debug) console.warn("Error decoding audio chunk:", e);
            }
        }
    }
    
    setExpectedAudioSamples(count) {
        this.expectedAudioSamples = count;
        if (this.debug) console.log("Expected audio samples set to:", count);
    }
    
    /**
     * Check if all audio samples have been decoded and are ready for playback
     * Uses multiple conditions to ensure decoding is truly complete:
     * - All expected samples received
     * - Decoder queue is empty
     * - Small time buffer to handle async operations
     * @returns {boolean} True when audio is fully decoded and ready
     */
    checkDecodingComplete() {
        if (this.decodingComplete) return true;
        
        // Decoding is complete when we've received all encoded samples AND the AudioDecoder queue is flushed
        const allSamplesReceived = this.expectedAudioSamples > 0 && this.receivedEncodedSamples >= this.expectedAudioSamples;
        const hasDecodedData = this.decodedAudioData.length > 0;
        const decoderIdle = this.audioDecoder && this.audioDecoder.state === "configured" && this.audioDecoder.decodeQueueSize === 0;
        
        if (allSamplesReceived && hasDecodedData && decoderIdle) {
            // Add a small buffer to ensure all async decoding is done
            if (!this._decodingCompleteCheckTime) {
                this._decodingCompleteCheckTime = Date.now();
                return false;
            }
            
            // Wait 100ms to ensure all audio chunks are decoded
            if (Date.now() - this._decodingCompleteCheckTime > 100) {
                this.decodingComplete = true;
                if (this.debug) console.log("Audio decoding complete: received", this.receivedEncodedSamples, "samples, decoded", this.decodedAudioData.length, "chunks");
                return true;
            }
        }
        return false;
    }

    /**
     * Start or resume audio playback synchronized with video frame
     * @param {number} startFrame - Current video frame number
     * @param {number} fps - Video frame rate for timing calculations
     */
    play(startFrame, fps, speed = 1) {
        if (this.streamAudio) {
            this.streamAudio.play(startFrame, fps, speed);
            return;
        }
        if (!this.isInitialized || !this.audioContext) {
//            console.warn("Audio not initialized or no context");
            return;
        }

        if (this.isMuted) {
            return;
        }

        try {
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }

            const wasPlaying = this.isPlaying;
            const frameJumped = Math.abs(startFrame - this.startFrame) > 5;


            this.isPlaying = true;
            this.fps = fps;
            const needsRestart = !wasPlaying || frameJumped;

            if (needsRestart) {
                if (this.debug) console.log("Restart needed Play called: wasPlaying=", wasPlaying, "frameJumped=", frameJumped, "decoded samples=", this.decodedAudioData.length);
                
                if (this._playbackRetryTimeout) {
                    clearTimeout(this._playbackRetryTimeout);
                    this._playbackRetryTimeout = null;
                }
                
                const hasOldSource = this.audioBufferSource !== null;
                if (hasOldSource) {
                    const oldSource = this.audioBufferSource;
                    this.audioBufferSource = null;
                    this.isBufferSourceStarted = false;
                    
                    const currentTime = this.audioContext.currentTime;
                    const quickFade = 0.003;
                    const currentGain = this.gainNode.gain.value;
                    
                    this.gainNode.gain.cancelScheduledValues(currentTime);
                    this.gainNode.gain.setValueAtTime(currentGain, currentTime);
                    this.gainNode.gain.linearRampToValueAtTime(0, currentTime + quickFade);
                    
                    try {
                        oldSource.stop(currentTime + quickFade);
                    } catch (e) {}
                    
                    setTimeout(() => {
                        try {
                            oldSource.disconnect();
                        } catch (e) {}
                    }, quickFade * 1000 + 10);
                    
                    setTimeout(() => {
                        this.playbackStartTime = this.audioContext.currentTime;
                        this.playbackStartFrame = startFrame;
                        this.playAudioBuffer(startFrame, fps);
                    }, quickFade * 1000);
                } else {
                    this.playbackStartTime = this.audioContext.currentTime;
                    this.playbackStartFrame = startFrame;
                    this.playAudioBuffer(startFrame, fps);
                }
            }

            this.startFrame = startFrame;
        } catch (e) {
            if (this.debug) console.warn("Error playing audio:", e);
        }
    }

    /**
     * Stop audio playback with optional fade-out to prevent clicks
     * @param {boolean} immediate - If true, stop immediately (for restarts). If false, apply 5ms fade-out (for pause/stop)
     */
    stopAudioSource(immediate = false) {
        this.streamAudio?.pause();
        if (this._playbackRetryTimeout) {
            clearTimeout(this._playbackRetryTimeout);
            this._playbackRetryTimeout = null;
        }
        if (this.audioBufferSource) {
            const sourceToStop = this.audioBufferSource;
            this.audioBufferSource = null;
            
            try {
                if (immediate) {
                    sourceToStop.stop(0);
                    sourceToStop.disconnect();
                } else {
                    const currentTime = this.audioContext.currentTime;
                    const fadeTime = 0.005;
                    const currentGain = this.gainNode.gain.value;
                    
                    this.gainNode.gain.cancelScheduledValues(currentTime);
                    this.gainNode.gain.setValueAtTime(currentGain, currentTime);
                    this.gainNode.gain.linearRampToValueAtTime(0.0001, currentTime + fadeTime);
                    
                    sourceToStop.stop(currentTime + fadeTime);
                    
                    setTimeout(() => {
                        try {
                            sourceToStop.disconnect();
                        } catch (e) {}
                        this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                        this.gainNode.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.audioContext.currentTime);
                    }, fadeTime * 1000 + 10);
                }
            } catch (e) {
                if (this.debug) console.warn("Error stopping audio source:", e);
            }
        }
        this.isBufferSourceStarted = false;
    }

    getAudioBufferForExport() {
        if (!this.decodingComplete || !this.decodedAudioData.length) {
            return null;
        }
        
        if (this.audioBuffer) {
            return this.audioBuffer;
        }
        
        try {
            const firstBuffer = this.decodedAudioData[0].data;
            const sampleRate = firstBuffer.sampleRate || 44100;
            const numberOfChannels = firstBuffer.numberOfChannels;
            
            let totalLength = 0;
            for (const item of this.decodedAudioData) {
                totalLength += Math.floor(item.duration / 1000000 * sampleRate);
            }
            
            const offlineCtx = new OfflineAudioContext(numberOfChannels, totalLength, sampleRate);
            const exportBuffer = offlineCtx.createBuffer(numberOfChannels, totalLength, sampleRate);
            
            let offset = 0;
            for (const item of this.decodedAudioData) {
                const audioData = item.data;
                const framesToCopy = Math.floor(item.duration / 1000000 * sampleRate);
                for (let ch = 0; ch < numberOfChannels; ch++) {
                    const srcBuffer = new Float32Array(audioData.numberOfFrames);
                    audioData.copyTo(srcBuffer, { planeIndex: ch });
                    exportBuffer.getChannelData(ch).set(srcBuffer.subarray(0, framesToCopy), offset);
                }
                offset += framesToCopy;
            }
            
            console.log(`[Audio] Created export buffer: ${exportBuffer.duration.toFixed(2)}s, ${numberOfChannels}ch, ${sampleRate}Hz`);
            return exportBuffer;
        } catch (e) {
            console.warn("[Audio] Error creating export buffer:", e);
            return null;
        }
    }

    createAudioBuffer() {
        if (this._bufferCreationInProgress) {
            if (this.debug) console.log("Buffer creation already in progress");
            return false;
        }

        if (!this.decodedAudioData.length) {
            if (this.debug) console.log("No decoded audio data to create buffer from");
            return false;
        }

        this._bufferCreationInProgress = true;

        try {
            let totalLength = 0;
            const audioBuffers = [];

            const firstBuffer = this.decodedAudioData[0].data;
            const sampleRate = firstBuffer.sampleRate || this.audioContext.sampleRate;

            for (const item of this.decodedAudioData) {
                const audioData = item.data;
                const framesToCopy = Math.floor(item.duration / 1000000 * sampleRate);
                totalLength += framesToCopy;
                audioBuffers.push({ data: audioData, framesToCopy: framesToCopy });
            }

            if (this.debug) console.log("Creating audio buffer with", audioBuffers.length, "chunks, totalLength=", totalLength, "frames");

            if (audioBuffers.length === 0) {
                return false;
            }

            const numberOfChannels = firstBuffer.numberOfChannels;

            if (this.debug) console.log("Audio buffer config: channels=", numberOfChannels, "sampleRate=", sampleRate, "totalFrames=", totalLength);

            this.audioBuffer = this.audioContext.createBuffer(
                numberOfChannels,
                totalLength,
                sampleRate
            );

            const discontinuityStats = {
                count: 0,
                maxJump: 0,
                avgJump: 0,
                boundaries: []
            };

            let offset = 0;
            for (let i = 0; i < audioBuffers.length; i++) {
                const { data: audioData, framesToCopy } = audioBuffers[i];
                for (let ch = 0; ch < numberOfChannels; ch++) {
                    const srcBuffer = new Float32Array(audioData.numberOfFrames);
                    audioData.copyTo(srcBuffer, { planeIndex: ch });
                    const dstBuffer = this.audioBuffer.getChannelData(ch);
                    
                    if (i > 0 && ch === 0 && this.debug) {
                        const prevSample = dstBuffer[offset - 1];
                        const currSample = srcBuffer[0];
                        const jump = Math.abs(currSample - prevSample);
                        
                        if (jump > 0.01) {
                            discontinuityStats.count++;
                            discontinuityStats.maxJump = Math.max(discontinuityStats.maxJump, jump);
                            discontinuityStats.avgJump += jump;
                            discontinuityStats.boundaries.push({
                                chunk: i,
                                offset: offset,
                                prevSample: prevSample,
                                currSample: currSample,
                                jump: jump
                            });
                        }
                    }
                    
                    dstBuffer.set(srcBuffer.subarray(0, framesToCopy), offset);
                }
                offset += framesToCopy;
            }

            if (this.debug && discontinuityStats.count > 0) {
                discontinuityStats.avgJump = discontinuityStats.avgJump / discontinuityStats.count;
                console.warn(`[Audio] Found ${discontinuityStats.count} discontinuities at chunk boundaries:`);
                console.warn(`  Max jump: ${discontinuityStats.maxJump.toFixed(6)}`);
                console.warn(`  Avg jump: ${discontinuityStats.avgJump.toFixed(6)}`);
                console.warn(`  Details:`, discontinuityStats.boundaries.slice(0, 5));
            } else if (this.debug) {
                console.log(`[Audio] No significant discontinuities detected (${audioBuffers.length - 1} boundaries checked)`);
            }

            this._lastBufferDecodedCount = this.decodedAudioData.length;
            if (this.debug) console.log("Audio buffer created successfully");
            return true;
        } catch (e) {
            if (this.debug) console.warn("Error creating audio buffer:", e);
            return false;
        } finally {
            this._bufferCreationInProgress = false;
        }
    }

    playAudioBuffer(startFrame, fps) {
        if (!this.isPlaying) {
            if (this.debug) console.log("Not playing");
            return;
        }

        if (!this.audioContext) {
            if (this.debug) console.log("No audio context");
            return;
        }
        
        // Ensure audio context is running during wait
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        
        // Wait for decoding to complete before playing
        if (!this.checkDecodingComplete()) {
            // Audio not yet fully decoded, retry in 50ms
            if (!this._playbackRetryTimeout) {
                if (this.debug) console.log("Waiting for audio decoding to complete. (received", this.receivedEncodedSamples, "/", this.expectedAudioSamples, ", decoded", this.decodedAudioData.length, "chunks)");
                this._playbackRetryTimeout = setTimeout(() => {
                    this._playbackRetryTimeout = null;
                    this.playAudioBuffer(startFrame, fps);
                }, 50);
            }
            return;
        }
        
        if (!this.decodedAudioData.length) {
            if (this.debug) console.log("No decoded audio data");
            return;
        }

        try {
            // Only create the buffer once after decoding is complete
            if (!this.audioBuffer || !this._bufferCreatedSuccessfully) {
                if (!this.createAudioBuffer()) {
                    return;
                }
                this._bufferCreatedSuccessfully = true;
            }

            this.stopAudioSource();

            this.audioBufferSource = this.audioContext.createBufferSource();
            this.audioBufferSource.buffer = this.audioBuffer;
            this.audioBufferSource.connect(this.gainNode);

            // Calculate offset time using original fps, then set playback rate based on fps ratio
            const originalFps = this.originalFps || fps;
            
            // Account for time elapsed while waiting for audio decoding
            const timeElapsed = this.audioContext.currentTime - (this.playbackStartTime || this.audioContext.currentTime);
            const currentFrame = this.playbackStartFrame + (timeElapsed * fps);
            
            // Use current frame to calculate offset, ensuring sync
            const offsetTime = Math.max(0, currentFrame / originalFps);
            const playbackRate = fps / originalFps;
            
            this.audioBufferSource.playbackRate.value = playbackRate;
            
            if (this.debug) console.log("Starting audio playback: currentFrame=", currentFrame, "offsetTime=", offsetTime.toFixed(3), "seconds, timeElapsed=", timeElapsed.toFixed(3), "originalFps=", originalFps, "playbackRate=", playbackRate);
            
            const currentTime = this.audioContext.currentTime;
            const fadeTime = offsetTime < 0.01 ? 0.01 : 0.005;
            const targetGain = this.isMuted ? 0 : this.volume;
            
            this.gainNode.gain.cancelScheduledValues(currentTime);
            this.gainNode.gain.setValueAtTime(0, currentTime);
            this.gainNode.gain.linearRampToValueAtTime(targetGain, currentTime + fadeTime);
            
            this.audioBufferSource.start(currentTime, offsetTime);
            this.isBufferSourceStarted = true;
        } catch (e) {
            if (this.debug) console.warn("Error playing audio buffer:", e);
            this.isPlaying = false;
        }
    }

    pause() {
        this.isPlaying = false;
        this.stopAudioSource();
    }

    stop() {
        this.pause();
        this.audioStartTime = 0;
        this.startFrame = 0;
    }

    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, volume));
        this.isMuted = this.volume === 0;
        if (this.gainNode) {
            this.gainNode.gain.value = this.volume;
        }
    }

    getVolume() {
        return this.volume;
    }

    setMuted(muted) {
        this.isMuted = muted;
        if (this.gainNode) {
            this.gainNode.gain.value = muted ? 0 : this.volume;
        }
        if (muted) {
            this.stopAudioSource();
        }
    }

    getMuted() {
        return this.isMuted;
    }

    /**
     * Complete cleanup of all audio resources
     * Ensures immediate audio stopping and proper resource release
     * Key steps:
     * 1. Stop playback immediately with stop(0)
     * 2. Disconnect all audio nodes
     * 3. Suspend AudioContext to halt processing
     * 4. Close AudioContext and decoder
     * 5. Clear all data and state
     */
    dispose() {
        if (this._playbackRetryTimeout) {
            clearTimeout(this._playbackRetryTimeout);
            this._playbackRetryTimeout = null;
        }
        
        // Immediately stop any playing audio source
        this.stopAudioSource();
        
        // Disconnect the gain node from the audio graph
        if (this.gainNode) {
            try {
                this.gainNode.disconnect();
            } catch (e) {
                // Ignore errors if already disconnected
            }
            this.gainNode = null;
        }
        
        // Suspend and close the audio context immediately to stop all audio processing
        if (this.audioContext) {
            try {
                // Set the state to closed immediately by suspending first
                if (this.audioContext.state !== 'closed') {
                    // Suspend immediately stops all audio processing
                    this.audioContext.suspend();
                }
                // Then close the context to release resources
                this.audioContext.close();
            } catch (e) {
                if (this.debug) console.warn("Error closing audio context:", e);
            }
            this.audioContext = null;
        }
        
        if (this.audioDecoder) {
            try {
                this.audioDecoder.close();
            } catch (e) {
                if (this.debug) console.warn("Error closing decoder:", e);
            }
            this.audioDecoder = null;
        }
        
        // Clear all audio data
        this.audioBuffer = null;
        this.streamAudio?.dispose();
        for (const item of this.decodedAudioData) item.data.close();
        this.decodedAudioData = [];
        this.isInitialized = false;
        this.isPlaying = false;
        this._bufferCreatedSuccessfully = false;
        this.decodingComplete = false;
        this.receivedEncodedSamples = 0;
        this.expectedAudioSamples = 0;
        this._decodingCompleteCheckTime = null;
    }
}
