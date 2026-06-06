import { sanitizeAvcDescription } from "./H264Utils";

export class MediabunnyExporter {
    constructor(options = {}) {
        this.width = options.width || 640;
        this.height = options.height || 480;
        this.fps = options.fps || 30;
        this.bitrate = options.bitrate || 5_000_000;
        this.keyFrameInterval = options.keyFrameInterval || 30;
        this.format = options.format || 'mp4';
        this.codec = options.codec || (this.format === 'mp4' ? 'avc' : 'vp8');
        this.hardwareAcceleration = options.hardwareAcceleration || 'prefer-hardware';
        this.videoStartDate = options.videoStartDate || null;
        this.audioBuffer = options.audioBuffer || null;
        this.audioStartTime = options.audioStartTime || 0;
        this.audioDuration = options.audioDuration || null;
        this.originalFps = options.originalFps || this.fps;

        this.output = null;
        this.videoSource = null;
        this.audioSource = null;
        this.frameCount = 0;
        this.error = null;
        this.finalized = false;
    }

    async initialize() {
        const {
            Output,
            Mp4OutputFormat,
            WebMOutputFormat,
            BufferTarget,
            EncodedVideoPacketSource,
            EncodedPacket,
            AudioBufferSource,
        } = await import('mediabunny');

        this.EncodedPacket = EncodedPacket;

        const encodedWidth = Math.ceil(this.width / 2) * 2;
        const encodedHeight = Math.ceil(this.height / 2) * 2;

        const formatOptions = this.format === 'mp4'
            ? new Mp4OutputFormat({ fastStart: 'in-memory' })
            : new WebMOutputFormat();

        this.target = new BufferTarget();
        this.output = new Output({
            format: formatOptions,
            target: this.target,
        });

        this.videoSource = new EncodedVideoPacketSource(this.codec);
        this.output.addVideoTrack(this.videoSource, {
            frameRate: this.fps,
        });

        if (this.audioBuffer) {
            const audioCodec = this.format === 'mp4' ? 'aac' : 'opus';
            this.audioSource = new AudioBufferSource({
                codec: audioCodec,
                bitrate: 128_000,
            });
            this.output.addAudioTrack(this.audioSource);
        }

        await this.output.start();

        this.encoder = new VideoEncoder({
            output: async (chunk, meta) => {
                try {
                    // Some browsers (e.g. Opera) emit a malformed H.264 avcC description with
                    // duplicated SPS/PPS NAL-header bytes. Mediabunny writes the description
                    // verbatim into the MP4, producing a file that only plays in Chromium-based
                    // browsers. Repair it here so the export plays everywhere.
                    if (this.codec === 'avc' && meta?.decoderConfig?.description) {
                        const { bytes, repaired, warning } = sanitizeAvcDescription(meta.decoderConfig.description);
                        if (warning && !this._loggedAvccWarning) {
                            console.warn('MediabunnyExporter: ' + warning);
                            this._loggedAvccWarning = true;
                        }
                        if (repaired) {
                            if (!this._loggedAvccRepair) {
                                console.warn('MediabunnyExporter: repaired malformed H.264 avcC description ' +
                                    'from the browser encoder (duplicated SPS/PPS NAL header bytes / zeroed reserved bits).');
                                this._loggedAvccRepair = true;
                            }
                            meta = { ...meta, decoderConfig: { ...meta.decoderConfig, description: bytes } };
                        }
                    }
                    const packet = this.EncodedPacket.fromEncodedChunk(chunk);
                    await this.videoSource.add(packet, meta);
                } catch (e) {
                    console.error('Muxer error:', e);
                    this.error = e;
                }
            },
            error: (e) => {
                console.error('VideoEncoder error:', e);
                this.error = e;
            }
        });

        const config = {
            codec: 'vp8',
            width: encodedWidth,
            height: encodedHeight,
            framerate: this.fps,
            bitrate: this.bitrate,
        };

        if (this.codec === 'avc') {
            config.avc = { format: 'avc' };
            config.hardwareAcceleration = this.hardwareAcceleration;
            const pixels = encodedWidth * encodedHeight;
            let startLevel;
            if (pixels > 8294400) {
                startLevel = 3; // 5.2 for 4K+
            } else if (pixels > 3686400) {
                startLevel = 2; // 5.1 for up to ~4K
            } else if (pixels > 2073600) {
                startLevel = 1; // 5.0 for up to ~2.5K
            } else {
                startLevel = 0; // 4.1 for up to ~1080p
            }
            const levels = ['avc1.640029', 'avc1.640032', 'avc1.640033', 'avc1.640034'];
            let supported = false;
            for (let i = startLevel; i < levels.length; i++) {
                config.codec = levels[i];
                if ((await VideoEncoder.isConfigSupported(config)).supported) {
                    supported = true;
                    break;
                }
            }
            if (!supported) {
                throw new Error(`H.264 codec not supported for ${encodedWidth}x${encodedHeight}`);
            }
        } else {
            const support = await VideoEncoder.isConfigSupported(config);
            if (!support.supported) {
                throw new Error(`${this.codec} codec not supported for ${encodedWidth}x${encodedHeight}`);
            }
        }

        this.encoder.configure(config);
        this.encodedWidth = encodedWidth;
        this.encodedHeight = encodedHeight;
        this.frameCount = 0;
        this.timestampAccumulatorMicros = 0;

        this.baseFrameDurationMicros = Math.round(1_000_000 / this.fps);
    }

    async addFrame(canvas, frameIndex) {
        if (this.error) throw this.error;

        const timestampMicros = this.timestampAccumulatorMicros;
        const frameDurationMicros = this.baseFrameDurationMicros;

        let frameCanvas = canvas;
        if (canvas.width !== this.encodedWidth || canvas.height !== this.encodedHeight) {
            frameCanvas = document.createElement('canvas');
            frameCanvas.width = this.encodedWidth;
            frameCanvas.height = this.encodedHeight;
            const ctx = frameCanvas.getContext('2d');
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, this.encodedWidth, this.encodedHeight);
            ctx.drawImage(canvas, 0, 0);
        }

        const videoFrame = new VideoFrame(frameCanvas, {
            timestamp: timestampMicros,
            duration: frameDurationMicros,
        });

        const isKeyFrame = frameIndex % this.keyFrameInterval === 0;
        this.encoder.encode(videoFrame, { keyFrame: isKeyFrame });
        videoFrame.close();

        // Backpressure: limit encoder queue to prevent unbounded memory growth.
        // Without this, frames queue faster than encoding, causing massive memory use
        // and a very long "flushing encoder" stage at the end.
        while (this.encoder.encodeQueueSize > 5) {
            await new Promise(r => setTimeout(r, 1));
        }

        this.timestampAccumulatorMicros += frameDurationMicros;
        this.frameCount++;
    }

    async finalize(onProgress = null, onStatus = null) {
        if (onStatus) {
            onStatus('Flushing encoder...');
            await new Promise(r => setTimeout(r, 0));
        }

        await this.encoder.flush();
        this.encoder.close();
        this.videoSource.close();

        if (this.audioSource && this.audioBuffer) {
            if (onStatus) {
                onStatus('Encoding audio...');
                await new Promise(r => setTimeout(r, 0));
            }

            const srcSampleRate = this.audioBuffer.sampleRate;
            const startSample = Math.floor(this.audioStartTime * srcSampleRate);
            const totalSamples = this.audioDuration !== null 
                ? Math.floor(this.audioDuration * srcSampleRate)
                : this.audioBuffer.length - startSample;
            const endSample = Math.min(startSample + totalSamples, this.audioBuffer.length);
            const samplesToUse = endSample - startSample;

            if (samplesToUse > 0) {
                const numChannels = this.audioBuffer.numberOfChannels;
                
                const supportedRates = [48000, 44100];
                const needsResample = !supportedRates.includes(srcSampleRate);
                const targetSampleRate = needsResample ? 48000 : srcSampleRate;
                
                const trimDuration = samplesToUse / srcSampleRate;
                const targetSamples = needsResample 
                    ? Math.ceil(trimDuration * targetSampleRate)
                    : samplesToUse;

                const offlineCtx = new OfflineAudioContext(numChannels, targetSamples, targetSampleRate);
                
                if (needsResample) {
                    const srcBuffer = offlineCtx.createBuffer(numChannels, samplesToUse, srcSampleRate);
                    for (let ch = 0; ch < numChannels; ch++) {
                        const srcData = this.audioBuffer.getChannelData(ch);
                        const dstData = srcBuffer.getChannelData(ch);
                        for (let i = 0; i < samplesToUse; i++) {
                            dstData[i] = srcData[startSample + i];
                        }
                    }
                    const srcNode = offlineCtx.createBufferSource();
                    srcNode.buffer = srcBuffer;
                    srcNode.connect(offlineCtx.destination);
                    srcNode.start(0);
                    const resampledBuffer = await offlineCtx.startRendering();
                    console.log(`Resampled audio from ${srcSampleRate}Hz to ${targetSampleRate}Hz`);
                    await this.audioSource.add(resampledBuffer, 0);
                } else {
                    const trimmedBuffer = offlineCtx.createBuffer(numChannels, samplesToUse, srcSampleRate);
                    for (let ch = 0; ch < numChannels; ch++) {
                        const srcData = this.audioBuffer.getChannelData(ch);
                        const dstData = trimmedBuffer.getChannelData(ch);
                        for (let i = 0; i < samplesToUse; i++) {
                            dstData[i] = srcData[startSample + i];
                        }
                    }
                    await this.audioSource.add(trimmedBuffer, 0);
                }
            }
            this.audioSource.close();
        }

        if (onStatus) {
            onStatus(`Finalizing ${this.format.toUpperCase()}...`);
            await new Promise(r => setTimeout(r, 0));
        }

        await this.output.finalize();
        this.finalized = true;

        const buffer = this.target.buffer;
        const mimeType = this.format === 'mp4' ? 'video/mp4' : 'video/webm';

        return new Blob([buffer], { type: mimeType });
    }

    getFrameCount() {
        return this.frameCount;
    }

    // Release the WebCodecs encoder and abort the muxer when an export is
    // cancelled or errors before finalize() (a VideoEncoder holds a hardware
    // session that must be closed explicitly; GC won't reliably free it).
    // Idempotent and safe to call after a successful finalize().
    async dispose() {
        try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (_) { /* ignore */ }
        // finalize() consumes the output; only cancel it if we never got there.
        if (!this.finalized) {
            try { await this.output?.cancel(); } catch (_) { /* ignore */ }
        }
        this.encoder = null;
        this.videoSource = null;
        this.audioSource = null;
        this.output = null;
    }
}
