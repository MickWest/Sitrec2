import {FileManager, Sit} from "./Globals";
import {MP4Demuxer, MP4Source} from "./js/mp4-decode/mp4_demuxer";
import {CVideoWebCodecBase} from "./CVideoWebCodecBase";
import {updateSitFrames} from "./UpdateSitFrames";
import {EventManager} from "./CEventManager";
import {showError} from "./showError";
import {VideoLoadingManager} from "./CVideoLoadingManager";

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

        let source = new MP4Source()

        // here v.file, if defined is a file name
        // either a URL or a local file
        // check for local file (i.e. file on the user's computer loaded with a file picker)
        // if it's got no forward slashes, then it's a local file


        // FileManager handles URL resolution, caching, and path normalization

        if (v.file !== undefined ) {
            console.log(`[CVideoMp4Data] Loading video file: ${v.file}`);
            const loadPromise = FileManager.loadAsset(v.file, "video").then(result => {
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
                let reader = new FileReader()
                reader.readAsArrayBuffer(v.dropFile)
                // could maybe do partial loads, but this is local, so it's loading fast
                // however would be a faster start.
                reader.onloadend = () => {
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
     * Initialize video processing with demuxer
     * Sets up decoder, processes video/audio tracks, and manages loading callbacks
     * @param {MP4Demuxer} demuxer - The MP4 demuxer instance
     */
    startWithDemuxer(demuxer) {
        this.initializeCommonVariables();
        this.nextRequest = null;
        this.rawChunkData = [];

        this.demuxFrame = 0;

        const configPromise = demuxer.getConfig().then((config) => {
            this.videoWidth = config.codedWidth;
            this.videoHeight = config.codedHeight;
            
            this.originalVideoWidth = config.codedWidth;
            this.originalVideoHeight = config.codedHeight;

            console.log("🍿Setting Video width and height to ", config.codedWidth, "x", config.codedHeight )

            this.config = config;

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
                    // at this point demuxing should be done, so we should have an accurate frame count
                    // note, that's only true if we are not loading the video async
                    // (i.e. the entire video is loaded before we start decoding)
                    console.log(`[CVideoMp4Data] Demuxing done (assuming not async loading), frames = ` + this.frames + `, Sit.videoFrames = ` + Sit.videoFrames)
                    console.log(`[CVideoMp4Data] Demuxer calculated frames as ` + demuxer.source.totalFrames)
                    //assert(this.frames === demuxer.source.totalFrames, "Frames mismatch between demuxer and decoder"+this.frames+"!="+demuxer.source.totalFrames)

                    // use the demuxer frame count, as it's more accurate
                    Sit.videoFrames = demuxer.source.totalFrames * this.videoSpeed;

                    // also update the fps (use the stored original fps)
                    Sit.fps = this.originalFps;

                    updateSitFrames()

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

            this.audioHandler.initializeAudio(demuxer).then(() => {
                console.log(`[CVideoMp4Data] Audio handler initialized, starting extraction with both video and audio`);
                
                // Set expected audio sample count for the audio handler
                if (demuxer.audioTrack) {
                    this.audioHandler.setExpectedAudioSamples(demuxer.audioTrack.nb_samples);
                }
                
                // Now start extraction with both video and audio callbacks
                demuxer.start(
                    (chunk) => {
                        chunk.frameNumber = this.demuxFrame++
                        this.chunks.push(chunk)

                        const rawBuf = new ArrayBuffer(chunk.byteLength);
                        chunk.copyTo(rawBuf);
                        this.rawChunkData.push(rawBuf);

                        if (chunk.type === "key") {
                            this.groups.push({
                                    frame: this.chunks.length - 1,
                                    length: 1,
                                    pending: 0,
                                    loaded: false,
                                    timestamp: chunk.timestamp,
                                }
                            )
                        } else {
                            const lastGroup = this.groups[this.groups.length - 1]
                            lastGroup.length++;
                        }

                        this.frames++;
                        Sit.videoFrames = this.frames * this.videoSpeed;

                        if (this._loadingId && demuxer.source.totalFrames > 0) {
                            const progress = (this.frames / demuxer.source.totalFrames) * 100;
                            VideoLoadingManager.updateProgress(this._loadingId, progress);
                        }
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
                demuxer.start((chunk) => {
                    chunk.frameNumber = this.demuxFrame++
                    this.chunks.push(chunk)

                    const rawBuf = new ArrayBuffer(chunk.byteLength);
                    chunk.copyTo(rawBuf);
                    this.rawChunkData.push(rawBuf);

                    if (chunk.type === "key") {
                        this.groups.push({
                                frame: this.chunks.length - 1,
                                length: 1,
                                pending: 0,
                                loaded: false,
                                timestamp: chunk.timestamp,
                            }
                        )
                    } else {
                        const lastGroup = this.groups[this.groups.length - 1]
                        lastGroup.length++;
                    }
                    this.frames++;
                    Sit.videoFrames = this.frames * this.videoSpeed;

                    if (this._loadingId && demuxer.source.totalFrames > 0) {
                        const progress = (this.frames / demuxer.source.totalFrames) * 100;
                        VideoLoadingManager.updateProgress(this._loadingId, progress);
                    }
                }, null, completeExtraction);
            }).catch(err => {
                // Error will be ignored if callbacks are cleared
                if (this.errorCallback) {
                    console.error("Error initializing audio:", err);
                    this.errorCallback(err);
                }
            });

        }).catch(err => {
            console.error("Error getting config:", err);
            showError("Video loading error: " + (err.message || err));
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

