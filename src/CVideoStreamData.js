import {CVideoWebCodecBase} from './CVideoWebCodecBase';
import {CVideoByteStream} from './CVideoByteStream';
import {H264StreamParser} from './H264StreamParser';
import {H264Decoder} from './H264Decoder';
import {MP4Demuxer, MP4Source} from './js/mp4-decode/mp4_demuxer';
import {CStreamingAudio} from './CStreamingAudio';
import {sanitizeAvcDescription} from './H264Utils';
import {getRotationAngleFromVideoMatrix} from './CVideoMp4Data';
import {NodeMan, setRenderOne, Sit} from './Globals';
import {VideoLoadingManager} from './CVideoLoadingManager';
import {LoadingManager} from './CLoadingManager';
import {EventManager} from './CEventManager';
import {updateSitFrames} from './UpdateSitFrames';
import {indexedDBManager} from './IndexedDBManager';
import {fetchBufferWithStall} from './quickFetch';

// Progressive remote playback, retaining the existing group-based decode/cache
// machinery. Download completion and playback readiness have separate lifetimes.
export class CVideoStreamData extends CVideoWebCodecBase {
    constructor(v, loadedCallback, errorCallback) {
        super(v, loadedCallback, errorCallback);
        if (this.incompatible) return;
        this.filename = v.file;
        this.sourceRef = v.sourceRef || v.file;
        this.viewId = v.viewId;
        this.frames = v.streamFrames;
        this.rawH264 = /\.(h264|dad)(?:[?#]|$)/i.test(this.sourceRef);
        this.framePTSFromPES = !this.rawH264;
        this.bufferedFrames = 0;
        this.downloadFinished = false;
        this.downloadId = `${v.id}_download`;
        this.disposed = false;
        this.source = new CVideoByteStream(v.file, {
            onChunk: (bytes, offset) => this.receiveBytes(bytes, offset),
            onProgress: () => this.updateDownloadProgress(),
        });
        if (this.rawH264) {
            this.parser = new H264StreamParser();
        } else {
            this.mp4 = new MP4Source();
            this.mp4.progressive = true;
            this.mp4.extractionBatchSize = 32;
            this.mp4.file.onError = message => { this.parseError = new Error(String(message)); };
            this.demuxer = new MP4Demuxer(this.mp4);
        }
        this.downloadComplete = this.runDownload(true);
    }

    updateDownloadProgress() {
        if (this.disposed) return;
        this.percentLoaded = this.source.total ? this.source.received / this.source.total * 100 : 0;
        // Avoid rebuilding the loading panel on every small network read.
        if (!this._lastProgressTime || performance.now() - this._lastProgressTime > 100 || this.source.status !== 'downloading') {
            LoadingManager.updateProgress(this.downloadId, this.percentLoaded);
            this._lastProgressTime = performance.now();
            setRenderOne(true);
        }
    }

    async runDownload(useCache = false) {
        LoadingManager.registerLoading(this.downloadId, this.sourceRef, 'Downloading video');
        this.streamError = null;
        try {
            let buffer;
            if (useCache) {
                try { buffer = await indexedDBManager.getCachedData(`quickfetch:${this.filename}`); } catch (_) { /* optional cache */ }
            }
            if (this.disposed) return;
            if (buffer instanceof ArrayBuffer) {
                this.source.total = buffer.byteLength;
                for (let offset = 0; offset < buffer.byteLength; offset += 1024 * 1024) {
                    if (this.disposed) return;
                    const bytes = new Uint8Array(buffer, offset, Math.min(1024 * 1024, buffer.byteLength - offset));
                    await this.receiveBytes(bytes, offset);
                    this.source.received += bytes.byteLength;
                }
            } else {
                buffer = await this.source.download();
            }
            if (this.disposed) return;
            if (this.rawH264) {
                for (const group of this.parser.finish()) await this.appendH264Group(group);
                this.frames = this.chunks.length;
            } else {
                this.mp4.file.flush();
                if (this.configuring) await this.configuring;
                if (!this.config || this.chunks.length !== this.mp4.totalFrames) {
                    throw new Error('Video ended before all frames could be read');
                }
                if (this.audioHandler?.audioDecoder?.state === 'configured') {
                    await this.audioHandler.audioDecoder.flush();
                    this.audioHandler.streamAudio.complete = true;
                    this.audioHandler.decodingComplete = this.audioHandler.receivedEncodedSamples === this.audioHandler.expectedAudioSamples;
                }
            }
            if (!this.groups.length) throw new Error('Video contains no decodable keyframe');
            this.downloadFinished = true;
            this.source.status = 'complete';
            this.videoDroppedData = buffer;
            if (this.rawH264) this.h264Data = buffer;
            this.publishGroups();
            if (this.loaded && this.ownsTimeline && NodeMan.get(this.viewId, false)?.videoData === this) {
                Sit.videoFrames = this.frames * this.videoSpeed;
                updateSitFrames();
            }
            LoadingManager.completeLoading(this.downloadId);
            // Cache only verified, complete files. Cache writes don't block playback.
            indexedDBManager.cacheData(`quickfetch:${this.filename}`, buffer, 7 * 86400000).catch(() => {});
        } catch (error) {
            if (this.disposed) return;
            this.streamError = error.message;
            LoadingManager.completeLoading(this.downloadId);
            if (!this.loaded && !this._loadFailureReported) {
                this._loadFailureReported = true;
                this.error = true;
                this.errorCallback?.(error);
            }
            setRenderOne(true);
        }
    }

    retryDownload() {
        if (this.source.status !== 'failed' || !this.source.canResume || !this.loaded) return;
        this.downloadComplete = this.runDownload();
    }

    get streamByteSource() { return this.source; }

    async receiveBytes(bytes, offset) {
        if (this.disposed) return;
        if (this.rawH264) {
            for (const group of this.parser.append(bytes)) await this.appendH264Group(group);
        } else {
            const buffer = bytes.slice().buffer;
            buffer.fileStart = offset;
            const nextOffset = this.mp4.file.appendBuffer(buffer);
            // A tail moov is reached by skipping the mdat body. MP4Box accepts
            // that metadata out of order, so the sequential media download can
            // still supply the first samples immediately afterwards.
            if (!this.mp4.info && nextOffset > offset + bytes.byteLength && !this._metadataProbeDone) {
                this._metadataProbeDone = true;
                await this.readMP4Metadata(nextOffset);
            }
            if (this.parseError) throw this.parseError;
            if (this.mp4.info && !this.configuring) this.configuring = this.configureMP4();
            if (this.configuring) await this.configuring;
            this.publishGroups();
        }
    }

    async readMP4Metadata(offset) {
        try {
            // Bound speculative metadata reads; unusual files can finish via
            // the normal sequential path without an unbounded extra download.
            for (let i = 0; i < 8 && !this.mp4.info && !this.disposed; i++) {
                const {response, buffer} = await fetchBufferWithStall(this.filename,
                    {headers: {Range: `bytes=${offset}-${offset + 512 * 1024 - 1}`}}, this.source.controller.signal);
                const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
                if (response.status !== 206 || !range || Number(range[1]) !== offset ||
                    buffer.byteLength !== Number(range[2]) - offset + 1) return;
                buffer.fileStart = offset;
                const next = this.mp4.file.appendBuffer(buffer);
                offset = Math.max(offset + buffer.byteLength, next);
            }
        } catch (error) {
            if (!this.disposed) console.warn('Video metadata range unavailable; continuing sequential download:', error.message);
        }
    }

    async configureMP4() {
        const config = await this.demuxer.getConfig();
        if (this.disposed) return;
        this.frames = this.mp4.totalFrames;
        this.originalFps = this.mp4.fps;
        this.metadataRotation = getRotationAngleFromVideoMatrix(this.demuxer.videoTrack.matrix);
        const samples = this.mp4.file.getTrackSamplesInfo(this.demuxer.videoTrack.id);
        const timestamps = samples.map(sample => Math.round(sample.cts * 1e6 / sample.timescale)).sort((a, b) => a - b);
        // The sample table describes the entire presentation timeline before
        // media bytes arrive. Timing repair can use it without waiting for EOF.
        if (timestamps.length === this.frames && timestamps.every(Number.isFinite)) {
            this.completeFramePTSus = timestamps;
        }
        await this.configureVideo(config);
        if (this.disposed) return;
        this.initializeAudioHandler(this);
        this.audioHandler.originalFps = this.originalFps;
        await this.audioHandler.initializeAudio(this.demuxer);
        if (this.disposed) return;
        this.audioHandler.streamAudio = new CStreamingAudio(this.audioHandler);
        if (this.demuxer.audioTrack) this.audioHandler.setExpectedAudioSamples(this.demuxer.audioTrack.nb_samples);
        this.demuxer.start(chunk => this.appendChunk(chunk),
            (_track, audio) => this.audioHandler.decodeAudioSamples(audio, this.demuxer));
    }

    async configureVideo(config) {
        if (config.codec?.startsWith('avc') && config.description) {
            config.description = sanitizeAvcDescription(config.description).bytes;
        }
        const support = await VideoDecoder.isConfigSupported(config);
        if (!support.supported) throw new Error(`Video codec ${config.codec} is not supported by this browser`);
        if (this.disposed) return;
        this.config = config;
        this.videoWidth = this.originalVideoWidth = config.codedWidth;
        this.videoHeight = this.originalVideoHeight = config.codedHeight;
        if (this.metadataRotation === 90 || this.metadataRotation === 270) {
            [this.videoWidth, this.videoHeight] = [this.videoHeight, this.videoWidth];
        }
        this.configureWorker(config);
    }

    async appendH264Group(buffer) {
        if (!this.config) {
            const analysis = H264Decoder.analyzeH264Stream(buffer);
            if (!analysis.hasSPS || !analysis.hasPPS) throw new Error('H.264 video is missing SPS/PPS configuration');
            this.originalFps = Math.round((analysis.vui?.calculated_fps || 30) * 100) / 100;
            this.detectedFps = this.originalFps;
            await this.configureVideo({
                codec: 'avc1.' + Array.from(analysis.spsData.slice(1, 4), b => b.toString(16).padStart(2, '0')).join(''),
                description: H264Decoder.createAVCDecoderConfig(analysis.spsData, analysis.ppsData),
                codedWidth: analysis.width, codedHeight: analysis.height,
            });
        }
        if (this.disposed) return;
        const nals = H264Decoder.extractNALUnits(new Uint8Array(buffer));
        const chunks = H264Decoder.createEncodedVideoChunks(nals, this.originalFps, null, this.chunks.length);
        for (const chunk of chunks) this.appendChunk(chunk);
        this.publishGroups();
    }

    appendChunk(chunk) {
        chunk.frameNumber = this.chunks.length;
        this.chunks.push(chunk);
        if (chunk.type === 'key') {
            this.groups.push({frame: chunk.frameNumber, length: 1, pending: 0, loaded: false, timestamp: chunk.timestamp});
        } else if (this.groups.length) {
            this.groups[this.groups.length - 1].length++;
        }
    }

    publishGroups() {
        // MP4 may have leading B frames in the following GOP. Keep that next
        // group complete too before publishing an immutable decode request.
        const count = this.downloadFinished || this.rawH264 ? this.groups.length : Math.max(0, this.groups.length - 2);
        if (count === this.readyGroups && !this.downloadFinished) return;
        this.readyGroups = count;
        this.buildTimestampMap();
        for (let i = 0; i < count; i++) this.groups[i].dataReady = true;
        const last = this.groups[count - 1];
        this.bufferedFrames = last ? last.frame + last.length : 0;
        this.maybeReady();
        setRenderOne(true);
    }

    maybeReady() {
        if (this.disposed || this.loaded || (this.error && !(this._loadFailureReported && this.downloadFinished)) ||
            !this.config || !this.bufferedFrames) return;
        if (!this.rawH264 && !this.completeFramePTSus && !this.downloadFinished) return;
        const first = this.groups[0];
        if (!this.isFrameCached(first.frame * this.videoSpeed)) {
            if (this.error) return;
            if (first.loaded || first._permanentlyFailed) { this.failInitialDecode(); return; }
            this.requestGroup(first);
            return;
        }
        // A delayed/retried decode can succeed after the startup timeout.
        // Its valid pixels must restore readiness rather than leave a sticky
        // failure flag that prevents every analysis wait from succeeding.
        if (this._loadFailureReported) {
            this.error = false;
            this.streamError = null;
            this._loadFailureReported = false;
        }
        this.loaded = true;
        clearTimeout(this._readyTimer);
        if (this.ownsTimeline) {
            Sit.videoFrames = this.frames * this.videoSpeed;
            Sit.fps = this.originalFps;
            updateSitFrames();
        }
        VideoLoadingManager.setStatus(this._loadingId, 'ready for playback; downloading in background');
        this.loadedCallback?.(this);
        EventManager.dispatchEvent('videoLoaded', {videoData: this, width: this.videoWidth, height: this.videoHeight});
    }

    _onWorkerConfigured(acceleration) {
        super._onWorkerConfigured(acceleration);
        this.maybeReady();
    }

    _onWorkerError(...args) {
        super._onWorkerError(...args);
        if (this._allGroupsFailed && !this.loaded) this.failInitialDecode();
    }

    failInitialDecode() {
        if (this.disposed || this.loaded || this._loadFailureReported) return;
        this._loadFailureReported = true;
        this.error = true;
        this.streamError = 'The first video frames could not be decoded';
        this.source.dispose();
        LoadingManager.completeLoading(this.downloadId);
        this.errorCallback?.(new Error(this.streamError));
        setRenderOne(true);
    }

    _onWorkerFrame(...args) {
        super._onWorkerFrame(...args);
        this.maybeReady();
    }

    handleGroupComplete() {
        super.handleGroupComplete();
        // Main-thread bitmap creation/rotation can finish after decoder output.
        this.maybeReady();
    }

    requestGroup(group) {
        if (!group?.dataReady || this.disposed) return;
        if (!this.loaded && !this._readyTimer) {
            this._readyTimer = setTimeout(() => this.failInitialDecode(), 45000);
        }
        super.requestGroup(group);
    }

    isStreamFrameReady(frame, audioFrame = Math.floor(frame / this.videoSpeed)) {
        if (this.incompatible) return true;
        const actual = Math.floor(frame / this.videoSpeed);
        if (actual < 0 || (this.downloadFinished && actual >= this.frames)) return true;
        // Clips cut between keyframes can begin with undecodable delta frames.
        // Match the normal player's nearest-frame fallback for that prefix.
        const first = this.groups[0];
        if (first?.dataReady && actual < first.frame) {
            this.requestGroup(first);
            return !!this.isFrameCached(first.frame * this.videoSpeed);
        }
        const group = this.getGroup(actual);
        if (!group?.dataReady) return false;
        this.requestGroup(group);
        return !!this.isFrameCached(frame) && (!this.audioHandler?.streamAudio ||
            this.audioHandler.streamAudio.isReady(audioFrame, this.originalFps));
    }

    getImage(frame) {
        if (Math.floor(frame / this.videoSpeed) >= this.bufferedFrames && !this.downloadFinished) {
            return this.lastGoodFrame || this.createBlankFrame();
        }
        return super.getImage(frame);
    }

    async waitForFrame(frame, timeout = 10000) {
        const started = performance.now();
        while (!this.disposed && performance.now() - started < timeout) {
            const group = this.getGroup(Math.floor(frame / this.videoSpeed));
            if (group?.dataReady) return super.waitForFrame(frame, Math.max(0, timeout - (performance.now() - started)));
            // A stream failure can leave a usable downloaded prefix. Test its
            // frame readiness first; only missing bytes make this wait futile.
            if (this.streamError) return false;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
    }

    getMediaInfo() {
        return {...super.getMediaInfo(), fps: this.originalFps, videoCodec: this.config?.codec,
            durationSeconds: this.frames / this.originalFps};
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this._readyTimer);
        this.source?.dispose();
        this.mp4?.file.stop();
        LoadingManager.completeLoading(this.downloadId);
        this.parser = null;
        super.dispose();
    }
}
