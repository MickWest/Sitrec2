import {FileManager, Sit} from "./Globals";
import {MP4Demuxer, MP4Source} from "./js/mp4-decode/mp4_demuxer";
import {CVideoWebCodecBase} from "./CVideoWebCodecBase";
import {updateSitFrames} from "./UpdateSitFrames";
import {EventManager} from "./CEventManager";
import {showError} from "./showError";
import {VideoLoadingManager} from "./CVideoLoadingManager";
import {sanitizeAvcDescription} from "./H264Utils";

/**
 * Inspect the leading bytes of a video file and identify its container.
 * The MP4 loader only understands ISO-BMFF (files with an "ftyp" box at
 * offset 4). Detecting common unsupported formats up front lets us fail fast
 * with an actionable error rather than handing the buffer to MP4Box and
 * waiting for a timeout that may or may not arrive.
 *
 * Returns { format, description, supported, hint, headerHex }.
 */
export function detectVideoContainer(arrayBuffer) {
    const view = new Uint8Array(arrayBuffer, 0, Math.min(512, arrayBuffer.byteLength));
    const asAscii = (off, len) => {
        let s = "";
        for (let i = 0; i < len && off + i < view.length; i++) {
            const c = view[off + i];
            s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : ".";
        }
        return s;
    };
    const hex = (off, len) => Array.from(view.slice(off, off + len))
        .map(x => x.toString(16).padStart(2, "0")).join(" ");
    const headerHex = hex(0, Math.min(32, view.length));

    // ISO-BMFF (MP4/MOV/3GP/F4V): "ftyp" box at offset 4, major brand at 8.
    if (view.length >= 12 && asAscii(4, 4) === "ftyp") {
        const brand = asAscii(8, 4).trim();
        return {
            format: "ISO-BMFF",
            description: `MP4/MOV-family container (major brand "${brand}")`,
            supported: true,
            hint: "",
            headerHex,
        };
    }

    // MPEG Program Stream: Pack header 00 00 01 BA. Common for .mpg/.mpeg/.vob.
    if (view[0] === 0x00 && view[1] === 0x00 && view[2] === 0x01 && view[3] === 0xBA) {
        return {
            format: "MPEG-PS",
            description: "MPEG-1/2 Program Stream (typical .mpg / .mpeg / .vob / DVD rips)",
            supported: false,
            hint: 'ffmpeg -i input.mpg -c:v libx264 -c:a aac -movflags +faststart output.mp4',
            headerHex,
        };
    }

    // MPEG-1 video elementary stream: Sequence header 00 00 01 B3.
    if (view[0] === 0x00 && view[1] === 0x00 && view[2] === 0x01 && view[3] === 0xB3) {
        return {
            format: "MPEG-1 video ES",
            description: "Raw MPEG-1 video elementary stream (no container)",
            supported: false,
            hint: 'ffmpeg -i input.m1v -c:v libx264 output.mp4',
            headerHex,
        };
    }

    // MPEG Transport Stream: 0x47 sync byte every 188 bytes.
    if (view[0] === 0x47 && view.length >= 189 && view[188] === 0x47) {
        return {
            format: "MPEG-TS",
            description: "MPEG Transport Stream (.ts / .m2ts / broadcast capture)",
            supported: false,
            hint: 'ffmpeg -i input.ts -c copy output.mp4',
            headerHex,
        };
    }

    // Matroska / WebM: EBML header 1A 45 DF A3.
    if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
        const ascii = asAscii(0, Math.min(view.length, 256));
        const isWebm = ascii.includes("webm");
        return {
            format: isWebm ? "WebM" : "Matroska (MKV)",
            description: isWebm ? "WebM container" : "Matroska container",
            supported: false,
            hint: 'ffmpeg -i input.mkv -c copy output.mp4',
            headerHex,
        };
    }

    // AVI: "RIFF" + size + "AVI ".
    if (asAscii(0, 4) === "RIFF" && asAscii(8, 4) === "AVI ") {
        return {
            format: "AVI",
            description: "Microsoft AVI container",
            supported: false,
            hint: 'ffmpeg -i input.avi -c:v libx264 -c:a aac output.mp4',
            headerHex,
        };
    }

    // Adobe Flash Video: "FLV" signature.
    if (asAscii(0, 3) === "FLV") {
        return {
            format: "FLV",
            description: "Adobe Flash Video",
            supported: false,
            hint: 'ffmpeg -i input.flv -c:v libx264 -c:a aac output.mp4',
            headerHex,
        };
    }

    // Ogg (Theora/Vorbis): "OggS".
    if (asAscii(0, 4) === "OggS") {
        return {
            format: "Ogg",
            description: "Ogg container (Theora/Vorbis)",
            supported: false,
            hint: 'ffmpeg -i input.ogv -c:v libx264 -c:a aac output.mp4',
            headerHex,
        };
    }

    // Raw H.264 Annex-B: start code 00 00 00 01 or 00 00 01.
    if (view[0] === 0x00 && view[1] === 0x00 &&
        (view[2] === 0x01 || (view[2] === 0x00 && view[3] === 0x01))) {
        return {
            format: "Raw H.264 (Annex-B)",
            description: "Raw H.264 elementary stream (no container)",
            supported: false,
            hint: 'Rename to .h264 to use the raw-stream handler, or wrap: ffmpeg -i input.264 -c copy output.mp4',
            headerHex,
        };
    }

    return {
        format: "unknown",
        description: "unrecognised container signature",
        supported: false,
        hint: 'Re-encode: ffmpeg -i input.xxx -c:v libx264 -c:a aac -movflags +faststart output.mp4',
        headerHex,
    };
}

/**
 * MP4 video data handler using WebCodec API
 * Handles MP4/MOV files with demuxing and frame caching
 * 
 * Key responsibilities:
 * - Demuxes MP4/MOV containers using MP4Demuxer
 * - Manages video decoding through WebCodec VideoDecoder
 * - Handles audio extraction and synchronization via CAudioMp4Data
 * - Implements on-demand frame group decoding for memory efficiency
 * - Supports drag-and-drop file loading
 * 
 * Async operation management:
 * - Tracks promises in _pendingPromises array with proper error handling
 * - Manages audio wait timeout with _audioWaitTimeout
 * - Properly cancels demuxer operations on disposal
 * - Clears callbacks to prevent post-disposal execution
 */
export class CVideoMp4Data extends CVideoWebCodecBase {


    constructor(v, loadedCallback, errorCallback) {
        super(v, loadedCallback, errorCallback);

        if (this.incompatible) {
            console.warn(`[CVideoMp4Data] Incompatible, returning early`);
            return;
        }

        this.demuxer = null;

        // Abort handle for the FileManager.loadAsset byte-fetch. The getConfig
        // watchdog and dispose() abort this so a stalled or slow-but-unfinished
        // fetch is torn down — which lets loadAsset's catch run and unwind
        // Globals.parsing/pendingActions instead of leaking them forever.
        this._fetchAbort = new AbortController();

        let source = new MP4Source()

        // here v.file, if defined is a file name
        // either a URL or a local file
        // check for local file (i.e. file on the user's computer loaded with a file picker)
        // if it's got no forward slashes, then it's a local file


        // FileManager handles URL resolution, caching, and path normalization

        if (v.file !== undefined ) {
            console.log(`[CVideoMp4Data] Loading video file: ${v.file}`);
            this._markStatus("fetching remote file");
            const loadPromise = FileManager.loadAsset(v.file, "video", null, {abortSignal: this._fetchAbort.signal}).then(result => {
                this._markStatus(`file fetched (${result.parsed.byteLength} bytes), inspecting container`);
                const detection = detectVideoContainer(result.parsed);
                this._detectedContainer = detection;
                if (!detection.supported) {
                    this._reportUnsupportedContainer(detection, result.parsed.byteLength);
                    FileManager.disposeRemove("video");
                    return;
                }
                this._markStatus(`container ok (${detection.format}), demuxing`);
                // the file.appendBuffer expects an ArrayBuffer with a fileStart value (a byte offset) and
                // and byteLength (total byte length)
                result.parsed.fileStart = 0;        // patch in the fileStart of 0, as this is the whole thing
                this.videoDroppedData = result.parsed;
                source.file.appendBuffer(result.parsed)
                source.file.flush();

                // Remove it from the file manager
                // as we only need it for the initial load
                FileManager.disposeRemove("video");
            }).catch(err => {
                // The byte-fetch failed (network error, our quickFetch/resolver
                // stall-timeout, or a deliberate teardown abort). Cancel the
                // getConfig watchdog and mark aborted so it can't fire a second,
                // duplicate error 120s later (getConfig never resolves once the
                // buffer was never appended).
                this._aborted = true;
                if (this._getConfigTimer) {
                    clearTimeout(this._getConfigTimer);
                    this._getConfigTimer = null;
                }
                // An intentional abort (dispose / watchdog already reported) is not a
                // load error to surface to the user.
                if (err && err.name === 'AbortError') return;
                // Error will be ignored if callbacks are cleared
                if (this.errorCallback) {
                    console.error(`Error loading video file: ${v.file}`, err);
                    this.errorCallback(err);
                }
            });
            this._pendingPromises.push(loadPromise);
        } else {

            // Handle drag and drop files
            // v.dropFile is a File object, which comes from DragDropHandler
            if (v.dropFile !== undefined) {
                this._markStatus("reading dropped file");
                let reader = new FileReader()
                reader.readAsArrayBuffer(v.dropFile)
                // could maybe do partial loads, but this is local, so it's loading fast
                // however would be a faster start.
                reader.onloadend = () => {
                    this._markStatus(`dropped file read (${reader.result.byteLength} bytes), inspecting container`);
                    const detection = detectVideoContainer(reader.result);
                    this._detectedContainer = detection;
                    if (!detection.supported) {
                        this._reportUnsupportedContainer(detection, reader.result.byteLength);
                        return;
                    }
                    this._markStatus(`container ok (${detection.format}), demuxing`);
                    // reader.result will be an ArrayBuffer
                    // the file.appendBuffer expects an ArrayBuffer with a fileStart value (a byte offset) and
                    // and byteLength (total byte length)
                    this.videoDroppedData = reader.result;
                    this.videoDroppedURL = null;
                    reader.result.fileStart = 0;        // patch in the fileStart of 0, as this is the whole thing
                    source.file.appendBuffer(reader.result)
                    source.file.flush();
                }
            }
        }

        this.demuxer = new MP4Demuxer(source);
        this.startWithDemuxer(this.demuxer)

    }

    /**
     * Override decoder callbacks for MP4-specific logic
     */
    createDecoderCallbacks() {
        return {
            output: videoFrame => {
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
            },
            error: e => showError(e),
        };
    }

    /**
     * Override group completion handling for MP4-specific nextRequest logic
     */
    handleGroupComplete() {
        if (this.groupsPending === 0 && this.nextRequest != null) {
            const group = this.nextRequest;
            this.nextRequest = null;
            this.requestGroup(group);
        }
    }

    handleBusyDecoder(group) {
        this.nextRequest = group;
    }

    /**
     * Push a milestone to the VideoLoadingManager so the pending-actions
     * diagnostic can surface where a stalled load is stuck. `_loadingId` is
     * assigned by CNodeVideoView *after* this constructor runs, so early
     * milestones (set in the constructor body) fall through to a direct
     * console.log so they are still visible in the trace.
     */
    _markStatus(status) {
        this._lastStatus = status;
        if (this._loadingId) {
            VideoLoadingManager.setStatus(this._loadingId, status);
        } else {
            console.log(`[VideoLoad] (pre-register) ${this.filename}: ${status}`);
        }
    }

    /**
     * Build a user-facing error for an unsupported container, show it, mark
     * the load failed, and decrement pendingActions. The console gets the
     * full diagnostic (header hex, size) for developers; the on-screen
     * message stays focused on what the user needs to act on.
     */
    _reportUnsupportedContainer(detection, fileSize) {
        // Mark aborted so the getConfig watchdog (scheduled synchronously by
        // startWithDemuxer before the async file-read completed) does not
        // fire a second error 10s later.
        this._aborted = true;
        if (this._getConfigTimer) {
            clearTimeout(this._getConfigTimer);
            this._getConfigTimer = null;
        }

        const userLines = [
            `Cannot load "${this.filename}" — ${detection.format} not supported.`,
            ``,
            detection.description,
            `Sitrec needs an MP4/MOV container.`,
        ];
        if (detection.hint) {
            userLines.push(``, `Fix: ${detection.hint}`);
        }
        const userMessage = userLines.join("\n");

        console.error(
            `[CVideoMp4Data] Unsupported container "${detection.format}" for ` +
            `"${this.filename}" (${fileSize.toLocaleString()} bytes). ` +
            `First 32 bytes: ${detection.headerHex}`
        );
        this._markStatus(`error: unsupported container (${detection.format})`);
        showError(userMessage);
        if (this.errorCallback) {
            const err = new Error(`Unsupported container: ${detection.format}`);
            err.detection = detection;
            this.errorCallback(err);
        }
    }

    /**
     * Initialize video processing with demuxer
     * Sets up decoder, processes video/audio tracks, and manages loading callbacks
     * @param {MP4Demuxer} demuxer - The MP4 demuxer instance
     */
    startWithDemuxer(demuxer) {
        this.initializeCommonVariables();
        this.nextRequest = null;

        this.demuxFrame = 0;

        this._markStatus("awaiting demuxer getConfig()");

        // Watchdog: if MP4Box never fires onReady (e.g. corrupt/truncated MP4
        // that passed the magic-byte check), fail loudly instead of hanging
        // pendingActions forever. Kept generous (2 min) because large MP4s
        // over slow connections can legitimately take tens of seconds before
        // the moov atom has been read and parsed — a healthy MP4Box still
        // resolves in milliseconds to a few hundred ms on fast loads.
        const GET_CONFIG_TIMEOUT_MS = 120000;
        let configTimedOut = false;
        this._getConfigTimer = setTimeout(() => {
            this._getConfigTimer = null;
            if (this._aborted) return; // already reported (unsupported container)
            configTimedOut = true;
            const det = this._detectedContainer;
            const fmt = det ? det.format : "unknown";
            const userMessage = [
                `Cannot load "${this.filename}" — MP4 parser timed out after ${GET_CONFIG_TIMEOUT_MS / 1000}s.`,
                ``,
                `The file looks like ${fmt} but couldn't be parsed — it's likely corrupt, truncated, or uses an unsupported MP4 variant.`,
                ``,
                `Fix: ffmpeg -i input -c:v libx264 -c:a aac -movflags +faststart output.mp4`,
            ].join("\n");
            console.error(
                `[CVideoMp4Data] getConfig watchdog fired after ${GET_CONFIG_TIMEOUT_MS / 1000}s ` +
                `for "${this.filename}". Detected: ${fmt}. First 32 bytes: ${det ? det.headerHex : "(no data)"}`
            );
            this._markStatus(`error: getConfig() timed out after ${GET_CONFIG_TIMEOUT_MS / 1000}s`);
            showError(userMessage);
            if (this.errorCallback) {
                const err = new Error(`MP4 demuxer timeout (${fmt})`);
                err.detection = det;
                this.errorCallback(err);
            }
            // Tear down the underlying byte-fetch too — a fetch that was still
            // in flight (e.g. slow-but-progressing past the watchdog) would
            // otherwise keep a socket open and leak loadAsset's pendingActions
            // behind the error the user already saw. The loadAsset catch treats
            // this AbortError as intentional and won't re-report it.
            try { this._fetchAbort?.abort(new DOMException("video getConfig watchdog", "AbortError")); } catch (e) {}
        }, GET_CONFIG_TIMEOUT_MS);

        const configPromise = demuxer.getConfig().then((config) => {
            if (configTimedOut) return; // watchdog already failed this load
            if (this._getConfigTimer) {
                clearTimeout(this._getConfigTimer);
                this._getConfigTimer = null;
            }
            this._markStatus(`got config (${config.codec} ${config.codedWidth}x${config.codedHeight}), configuring decoder`);
            this.videoWidth = config.codedWidth;
            this.videoHeight = config.codedHeight;
            
            this.originalVideoWidth = config.codedWidth;
            this.originalVideoHeight = config.codedHeight;

            console.log("🍿Setting Video width and height to ", config.codedWidth, "x", config.codedHeight )

            this.config = config;

            // Defend against already-broken files (e.g. a Firefox/Media-Foundation export whose
            // avcC has duplicated SPS/PPS NAL header bytes and zeroed reserved bits). mp4box
            // re-emits that malformed avcC verbatim into config.description; strict browser
            // decoders (Firefox/Safari) would then reject the stream. Repair it before the worker
            // configures its VideoDecoder so the file decodes in any browser. No-op for valid files.
            if (config.description && typeof config.codec === "string" && config.codec.startsWith("avc")) {
                const {bytes, repaired, warning} = sanitizeAvcDescription(config.description);
                if (warning) console.warn("[CVideoMp4Data] " + warning);
                if (repaired) {
                    console.warn("[CVideoMp4Data] Repaired malformed H.264 avcC in imported file " +
                        "(duplicated SPS/PPS NAL header bytes / zeroed reserved bits)");
                    config.description = bytes;
                }
            }

            this.metadataRotation = getRotationAngleFromVideoMatrix(demuxer.videoTrack.matrix);

            if (this.metadataRotation === 90 || this.metadataRotation === 270) {
                [this.videoWidth, this.videoHeight] = [this.videoHeight, this.videoWidth];
                console.log("🍿Swapped dimensions for metadata rotation: ", this.videoWidth, "x", this.videoHeight);
            }

            this.configureWorker(config);

            // Store the original fps from the video (will be needed for audio sync)
            this.originalFps = demuxer.source.fps;

            // Dispatch videoLoaded event early with video dimensions for view setup
            // This allows the view presets to be configured immediately
            console.log("🍿🍿🍿Dispatching videoLoaded event early for view setup")
            EventManager.dispatchEvent("videoLoaded", {videoData: this, width: config.codedWidth, height: config.codedHeight});

            // Initialize audio handler
            console.log("Creating audio handler");
            this.initializeAudioHandler(this);
            if (this.audioHandler) {
                this.audioHandler.originalFps = this.originalFps;
            }
            
            const completeExtraction = () => {
                this._markStatus(`demux complete (${this.frames} video chunks), waiting for audio decode`);
                this.buildTimestampMap();

                const audioWaitStartTime = Date.now();
                const audioWaitTimeout = 15000;

                const waitForAudioDecoding = () => {
                    // Check if audio decoding is complete
                    if (this.audioHandler && this.audioHandler.checkDecodingComplete()) {
                        console.log(`[CVideoMp4Data] Audio decoding confirmed complete, proceeding with video load`);
                        finishLoading();
                    } else if (Date.now() - audioWaitStartTime > audioWaitTimeout) {
                        console.warn(`[CVideoMp4Data] Audio decoding timeout after ${audioWaitTimeout}ms, proceeding with video load`);
                        this._markStatus(`audio decode timed out after ${audioWaitTimeout}ms, finishing anyway`);
                        finishLoading();
                    } else if (this.audioHandler && this.audioHandler.expectedAudioSamples > 0) {
                        // Still waiting for audio decoding, check again in 50ms
                        // console.log(`[CVideoMp4Data] Waiting for audio decoding... received`, this.audioHandler.receivedEncodedSamples, "/", this.audioHandler.expectedAudioSamples, "encoded, decoded", this.audioHandler.decodedAudioData.length);
                        this._audioWaitTimeout = setTimeout(waitForAudioDecoding, 50);
                    } else {
                        // No audio, proceed immediately
                        console.log(`[CVideoMp4Data] No audio or audio not initialized, proceeding with video load`);
                        finishLoading();
                    }
                };
                
                const finishLoading = () => {
                    this._markStatus("finalizing, invoking loadedCallback");
                    // at this point demuxing should be done, so we should have an accurate frame count
                    // note, that's only true if we are not loading the video async
                    // (i.e. the entire video is loaded before we start decoding)
                    console.log(`[CVideoMp4Data] Demuxing done (assuming not async loading), frames = ` + this.frames + `, Sit.videoFrames = ` + Sit.videoFrames)
                    console.log(`[CVideoMp4Data] Demuxer calculated frames as ` + demuxer.source.totalFrames)
                    //assert(this.frames === demuxer.source.totalFrames, "Frames mismatch between demuxer and decoder"+this.frames+"!="+demuxer.source.totalFrames)

                    // use the demuxer frame count, as it's more accurate.
                    // Only the timeline-owning (primary) video defines the sitch
                    // timeline; a secondary "video2" must not (see C1, 2.70.0 review).
                    if (this.ownsTimeline) {
                        Sit.videoFrames = demuxer.source.totalFrames * this.videoSpeed;

                        // also update the fps (use the stored original fps)
                        Sit.fps = this.originalFps;

                        updateSitFrames()
                    }

                    // Only call the callback if it hasn't been cleared (disposed)
                    // Pass this so the callback knows which videoData loaded
                    // (important when multiple videos are loading concurrently)
                    if (this.loadedCallback) {
                        this.loadedCallback(this);
                    }

                    // videoLoaded event already dispatched earlier for view setup
                };
                
                waitForAudioDecoding();
            };

            this._markStatus("initializing audio");
            this.audioHandler.initializeAudio(demuxer).then(() => {
                console.log(`[CVideoMp4Data] Audio handler initialized, starting extraction with both video and audio`);
                this._markStatus("audio ready, starting demuxer.start()");

                // Set expected audio sample count for the audio handler
                if (demuxer.audioTrack) {
                    this.audioHandler.setExpectedAudioSamples(demuxer.audioTrack.nb_samples);
                }

                // Now start extraction with both video and audio callbacks
                demuxer.start(
                    (chunk) => {
                        this._addChunkToGroups(chunk, demuxer);
                    },
                    (track_id, samples) => {
                        // Audio samples callback
//                        console.log("Audio samples callback received with", samples.length, "samples");
                        if (this.audioHandler) {
                            this.audioHandler.decodeAudioSamples(samples, demuxer);
                        }
                    },
                    completeExtraction
                );
            }).catch(e => {
                console.warn(`[CVideoMp4Data] Audio initialization failed:`, e);
                console.log(`[CVideoMp4Data] Proceeding with video-only extraction...`);
                this._markStatus(`audio init failed (${e?.message || e}), video-only demux`);
                demuxer.start((chunk) => {
                    this._addChunkToGroups(chunk, demuxer);
                }, null, completeExtraction);
            }).catch(err => {
                // Error will be ignored if callbacks are cleared
                if (this.errorCallback) {
                    console.error("Error initializing audio:", err);
                    this._markStatus(`error: audio init rejected (${err?.message || err})`);
                    this.errorCallback(err);
                }
            });

        }).catch(err => {
            if (this._getConfigTimer) {
                clearTimeout(this._getConfigTimer);
                this._getConfigTimer = null;
            }
            if (configTimedOut) return; // already reported by watchdog
            console.error("Error getting config:", err);
            this._markStatus(`error: getConfig rejected (${err?.message || err})`);
            showError("Video loading error:\n\n" + (err.message || err));
            if (this._loadingId) {
                VideoLoadingManager.completeLoading(this._loadingId);
            }
            if (this.errorCallback) {
                this.errorCallback(err);
            }
        });
        
        this._pendingPromises.push(configPromise);

    }



    /**
     * Shared chunk-to-group logic used by both the normal and audio-fallback extraction paths.
     * Handles leading delta frames in clips without an stss table (e.g. VLC exports
     * that start mid-stream before the first keyframe).
     */
    _addChunkToGroups(chunk, demuxer) {
        chunk.frameNumber = this.demuxFrame++;
        this.chunks.push(chunk);
        // No rawChunkData retention — bytes are extracted on demand at decode
        // time via chunk.copyTo() in CVideoWebCodecBase._requestGroupViaWorker.

        if (chunk.type === "key") {
            this.groups.push({
                frame: this.chunks.length - 1,
                length: 1,
                pending: 0,
                loaded: false,
                timestamp: chunk.timestamp,
            });
        } else {
            const lastGroup = this.groups[this.groups.length - 1];
            if (lastGroup) {
                lastGroup.length++;
            } else if (demuxer.source._hasStssTable !== false) {
                // Some MP4 files have the first sample not marked as a key frame
                // (e.g. certain screen recorders). Create a synthetic group so we
                // don't crash. But when stss is MISSING (VLC exports), leading delta
                // frames genuinely can't be decoded (no reference frames exist),
                // so skip them — they'll show the nearest cached/keyframe via
                // the fallback logic in CVideoWebCodecBase.getImage().
                this.groups.push({
                    frame: this.chunks.length - 1,
                    length: 1,
                    pending: 0,
                    loaded: false,
                    timestamp: chunk.timestamp,
                });
            }
            // else: leading delta frame with no stss — undecodable, not added to any group
        }

        this.frames++;
        // Secondary ("video2") views keep their own frame count but must not
        // overwrite the global sitch timeline (see C1, 2.70.0 review).
        if (this.ownsTimeline) {
            Sit.videoFrames = this.frames * this.videoSpeed;
        }

        if (this._loadingId && demuxer.source.totalFrames > 0) {
            const progress = (this.frames / demuxer.source.totalFrames) * 100;
            VideoLoadingManager.updateProgress(this._loadingId, progress);
        }

        // Every ~500 frames (~every 16s at 30fps) refresh the diagnostic milestone
        // so a stalled demuxer can be distinguished from a merely slow one.
        if ((this.frames & 0x1FF) === 0) {
            this._markStatus(`demuxing (${this.frames}/${demuxer.source.totalFrames || "?"} frames)`);
        }
    }

    // Container/stream facts for the EXIF/Metadata panel. MP4Box has already parsed all of
    // this at onReady, so it is a read of retained state, not a re-parse. Note fps comes from
    // the demuxer's measured samples/duration (this.fps is not set on this class), and the
    // track bitrate/size are MP4Box's per-track figures rather than the whole-file size.
    getMediaInfo() {
        const source = this.demuxer?.source;
        const videoTrack = this.demuxer?.videoTrack;
        const audioTrack = this.demuxer?.audioTrack;
        return {
            ...super.getMediaInfo(),
            fps: this.originalFps ?? source?.fps,
            durationSeconds: source?.durationInSeconds,
            container: source?.info?.brands?.[0],
            videoCodec: videoTrack?.codec ?? this.config?.codec,
            videoBitrate: videoTrack?.bitrate,
            videoBytes: videoTrack?.size,
            audioCodec: audioTrack?.codec,
            audioBitrate: audioTrack?.bitrate,
            audioSampleRate: audioTrack?.audio?.sample_rate,
            audioChannels: audioTrack?.audio?.channel_count,
        };
    }

    /**
     * Override config info to show MP4-specific properties
     */
    getDebugConfigInfo() {
        const fps = Sit.fps ? ` @ ${Sit.fps}fps` : '';
        return "Config: Codec: " + this.config.codec + "  format:" + this.format + " " + this.config.codedWidth + "x" + this.config.codedHeight + fps;
    }

    /**
     * Override group info to show MP4-specific format with timestamps
     */
    getDebugGroupInfo(groupIndex, group, images, imageDatas, framesCaches, currentGroup) {
        return "Group " + groupIndex + " f = " + group.frame + " l = " + group.length + " ts = " + group.timestamp
            + " i = " + images + " id = " + imageDatas + " fc = "
            + framesCaches
            + (group.loaded ? " Loaded " : "")
            + (currentGroup === group ? "*" : " ")
            + (group.pending ? "pending = " + group.pending : "");
    }

    /**
     * Clean up all resources and cancel pending operations
     * Critical for preventing audio playback and callbacks after switching videos
     * Implements proper async cancellation rather than flag-checking
     */
    dispose() {
        // Abort any in-flight byte-fetch so a disposal mid-load tears down the
        // socket and lets loadAsset unwind its pendingActions.
        try { this._fetchAbort?.abort(new DOMException("video disposed", "AbortError")); } catch (e) {}

        // Clear pending audio wait polling timeout
        if (this._audioWaitTimeout) {
            clearTimeout(this._audioWaitTimeout);
            this._audioWaitTimeout = null;
        }

        // Clear demuxer getConfig watchdog
        if (this._getConfigTimer) {
            clearTimeout(this._getConfigTimer);
            this._getConfigTimer = null;
        }

        // Clear callbacks to prevent them from firing after disposal
        this.loadedCallback = null;
        this.errorCallback = null;
        
        // Stop the demuxer if it exists
        if (this.demuxer) {
            // Stop extraction if in progress
            if (this.demuxer.source && this.demuxer.source.file) {
                try {
                    // Stop any ongoing operations
                    this.demuxer.source.file.stop();
                } catch (e) {
                    // Ignore errors during cleanup
                }
            }
            this.demuxer = null;
        }
        
        super.dispose();
    }

}


function getRotationAngleFromVideoMatrix(matrix) {
    // Extract matrix elements and normalize by dividing by 65536
    const a = matrix[0] / 65536;
    const b = matrix[1] / 65536;
    const c = matrix[3] / 65536;
    const d = matrix[4] / 65536;

    if (a === 0 && b === 1 && c === -1 && d === 0) {
        return 90;
    } else if (a === -1 && b === 0 && c === 0 && d === -1) {
        return 180;
    } else if (a === 0 && b === -1 && c === 1 && d === 0) {
        return 270;
    } else {
        return 0;
    }
}
