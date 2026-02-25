import {Globals, infoDiv, setRenderOne, Sit} from "./Globals";
import {assert} from "./assert";
import {loadImage} from "./utils";
import {CVideoAndAudio} from "./CVideoAndAudio";
import {par} from "./par";
import {isLocal} from "./configUtils";
import {showError, showErrorOnce} from "./showError";
import {VideoDecodeWorkerManager} from "./CVideoDecodeWorker";

/**
 * Base class for WebCodec-based video data handlers
 * Provides common frame caching, group management, and decoder functionality
 * 
 * Key responsibilities:
 * - Manages VideoDecoder instance and configuration
 * - Implements frame group system for efficient memory usage
 * - Handles on-demand decoding of frame groups (keyframe + deltas)
 * - Manages ImageBitmap cache with automatic purging
 * - Provides frame resizing based on videoMaxSize setting
 * - Handles decoder errors and recreation
 * 
 * Frame group system:
 * - Groups start with keyframes and include following delta frames
 * - Only decodes groups when needed (on-demand)
 * - Keeps configurable cache window around current frame
 * - Automatically purges distant groups to save GPU memory
 * 
 * Memory management:
 * - Converts VideoFrames to ImageBitmaps for GPU efficiency
 * - Properly closes ImageBitmaps when purging
 * - Tracks GPU memory usage estimates
 * - Implements cache window based on available device memory
 * 
 * Subclass responsibilities:
 * - MP4: Handles demuxed chunks from MP4Demuxer
 * - H264: Processes raw H.264 elementary streams
 * - Both override specific methods for their format
 */
export class CVideoWebCodecBase extends CVideoAndAudio {

    constructor(v, loadedCallback, errorCallback) {
        super(v);
        
        this.format = "";
        this.error = false;
        this.loaded = false;
        this.loadedCallback = loadedCallback;
        this.errorCallback = errorCallback;
        
        // Store filename for debugging
        this.filename = v.dropFile ? v.dropFile.name : (v.filename || "Unknown");

        // Check WebCodec compatibility
        this.incompatible = true;
        try {
            if (VideoDecoder !== undefined) {
                this.incompatible = false;
            }
        } catch (e) {
        }

        if (this.incompatible) {
            console.log("Video Playback Requires up-to-date WebCodec Browser (Chrome/Edge/Safari)");
            this.errorImage = null;
            loadImage('./data/images/errorImage.png').then(result => {
                this.errorImage = result;
                if (errorCallback) errorCallback("WebCodec not supported");
            });
            return;
        }

        // Initialize common caching variables
        this.initializeCommonVariables();
    }

    initializeCommonVariables() {
        this.frames = 0;
        this.lastGetImageFrame = 0;
        this.chunks = [];
        this.rawChunkData = [];
        this.groups = [];
        this.imageCache = [];
        this.imageDataCache = [];
        this.frameCache = [];
        this.groupsPending = 0;
        this.nextRequest = null;
        this.requestQueue = [];
        this.incomingFrame = 0;
        this.lastTimeStamp = -1;
        this.lastDecodeInfo = "";
        this.blankFrame = null;
        this.blankFrameCanvas = null;
        this.blankFramePending = false;
        this.lastGoodFrame = null;
        this.lastGoodFrameIndex = -1;
        this.decodeFrameIndex = 0;
        this.flushing = false;
        this.c_tmp = null;
        this.ctx_tmp = null;
        this._groupIdCounter = 0;
        this._activeGroupMap = new Map();
    }

    initWorker() {
        if (this._workerManager) return;
        this._workerManager = new VideoDecodeWorkerManager(
            (groupId, frameNumber, bitmap, width, height) => this._onWorkerFrame(groupId, frameNumber, bitmap, width, height),
            (groupId) => this._onWorkerGroupFlushed(groupId),
            (message, groupId) => this._onWorkerError(message, groupId),
        );
        this._workerManager.init();
    }

    configureWorker(config) {
        if (!this._workerManager) this.initWorker();
        this._workerConfig = config;
        this._workerManager.configure(config, this.effectiveRotation, Globals.settings?.videoMaxSize);
    }

    _onWorkerFrame(groupId, frameNumber, bitmap, width, height) {
        if (!this.imageCache) return;
        const group = this._activeGroupMap.get(groupId);
        if (!group) {
            if (bitmap) bitmap.close();
            return;
        }

        if (!bitmap) {
            if (group.pending > 0) {
                group.pending--;
                if (group.pending === 0) {
                    group.loaded = true;
                    this.groupsPending--;
                    this.handleGroupComplete();
                }
            }
            return;
        }

        const existingFrame = this.imageCache[frameNumber];
        if (existingFrame && existingFrame !== this.lastGoodFrame && typeof existingFrame.close === 'function') {
            try { existingFrame.close(); } catch (e) {}
        }

        this.imageCache[frameNumber] = bitmap;
        if (this.videoWidth !== width || this.videoHeight !== height) {
            this.videoWidth = width;
            this.videoHeight = height;
        }

        if (this.c_tmp === undefined || this.c_tmp === null) {
            this.c_tmp = document.createElement("canvas");
            this.c_tmp.setAttribute("width", this.videoWidth);
            this.c_tmp.setAttribute("height", this.videoHeight);
            this.ctx_tmp = this.c_tmp.getContext("2d");
        }

        if (frameNumber === this.lastGetImageFrame) {
            setRenderOne(true);
        }

        if (!group.decodeOrder) group.decodeOrder = [];
        group.decodeOrder.push(frameNumber);

        if (group.pending <= 0) return;
        group.pending--;
        if (group.pending === 0) {
            group.loaded = true;
            this.groupsPending--;
            this.handleGroupComplete();
        }
    }

    _onWorkerGroupFlushed(groupId) {
        const group = this._activeGroupMap.get(groupId);
        if (!group) return;
        this.flushing = false;
        const droppedFrames = group._expectedLength - (group.decodeOrder ? group.decodeOrder.length : 0);
        if (droppedFrames > 0 && group.pending > 0) {
            group.pending = Math.max(0, group.pending - droppedFrames);
            if (group.pending === 0 && !group.loaded) {
                group.loaded = true;
                this.groupsPending--;
            }
        }
        this._activeGroupMap.delete(groupId);
        this.handleGroupComplete();
    }

    _onWorkerError(message, groupId) {
        this.flushing = false;
        if (groupId !== undefined) {
            const group = this._activeGroupMap.get(groupId);
            if (group) {
                group.pending = 0;
                group.loaded = false;
                this.groupsPending = Math.max(0, this.groupsPending - 1);
                this._activeGroupMap.delete(groupId);
            }
        }
        console.debug("Worker decode error (non-fatal): " + message);
        this.handleGroupComplete();
    }

    createDecoder() {
        assert(0, "Creating a main thread decoder");
        const callbacks = this.createDecoderCallbacks();
        this.decoder = new VideoDecoder(callbacks);
        return this.decoder;
    }

    ensureMainThreadDecoder() {
        if (this.decoder) return true;
        if (!this.config) return false;
        this.createDecoder();
        try {
            this.decoder.configure(this.config);
            return true;
        } catch (e) {
            console.warn("Failed to configure fallback main-thread decoder:", e);
            this.decoder = null;
            return false;
        }
    }

    /**
     * Create decoder callbacks - can be overridden by subclasses
     */
    createDecoderCallbacks() {
        return {
            output: videoFrame => {
                this.format = videoFrame.format;
                this.lastDecodeInfo = "last frame.timestamp = " + videoFrame.timestamp + "<br>";

                const frameNumber = this.timestampToChunkIndex?.get(videoFrame.timestamp);
                if (frameNumber === undefined) {
                    console.warn(`[DECODE] No chunk found for timestamp ${videoFrame.timestamp}, skipping frame`);
                    videoFrame.close();
                    return;
                }

                const group = this.getGroup(frameNumber);
                if (!group) {
                    console.warn(`[DECODE] No group found for frame ${frameNumber}, skipping`);
                    videoFrame.close();
                    return;
                }

                group.decodePending++;
                if (this._debugDecode) {
                    console.log(`[DECODE] frame=${frameNumber} decodePending=${group.decodePending}/${group.length} pending=${group.pending} ts=${videoFrame.timestamp}`);
                }
                
                this.processDecodedFrame(frameNumber, videoFrame, group);
            },
            error: e => {
                showError("Decoder error:", e);
                this.handleDecoderError(e);
            }
        };
    }

    /**
     * Called when rotation changes - reset decoder groups and flush caches
     * @override
     */
    onRotationChanged() {
        super.onRotationChanged();
        if (this.groups) {
            for (let group of this.groups) {
                group.loaded = false;
                group.pending = 0;
                group.decodeOrder = [];
            }
        }
        this.groupsPending = 0;
        this.nextRequest = null;
        if (this.requestQueue) {
            this.requestQueue = [];
        }
        this._activeGroupMap?.clear();

        if (this.originalVideoWidth && this.originalVideoHeight) {
            const swap = (this.effectiveRotation === 90 || this.effectiveRotation === 270);
            this.videoWidth = swap ? this.originalVideoHeight : this.originalVideoWidth;
            this.videoHeight = swap ? this.originalVideoWidth : this.originalVideoHeight;
        }

        if (this._workerManager) {
            this._workerManager.updateTransforms(this.effectiveRotation, Globals.settings?.videoMaxSize);
        }
    }

    /**
     * Apply rotation to an image using canvas 2D transforms
     * @param {ImageBitmap} image - Source image to rotate
     * @param {number} degrees - Rotation in degrees (90, 180, or 270)
     * @returns {Promise<ImageBitmap>} Rotated image as ImageBitmap
     */
    applyRotation(image, degrees) {
        const width = image.width;
        const height = image.height;
        // For 90° and 270° rotations, width and height are swapped
        const swap = (degrees === 90 || degrees === 270);
        const outW = swap ? height : width;
        const outH = swap ? width : height;

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');

        // Move to center, rotate, then draw image centered
        ctx.translate(outW / 2, outH / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.translate(-width / 2, -height / 2);
        ctx.drawImage(image, 0, 0);

        return createImageBitmap(canvas);
    }

    /**
     * Resize a video frame based on videoMaxSize setting
     * Returns the original frame if no resizing needed
     */
    resizeFrameIfNeeded(image) {
        // Check if videoMaxSize is set
        const videoMaxSize = Globals.settings?.videoMaxSize;
        if (!videoMaxSize || videoMaxSize === "None") {
            return image;
        }
        
        // Map resolution names to longest edge dimensions
        const resolutionMap = {
            "1080P": 1920,  // 1920x1080
            "720P": 1280,   // 1280x720
            "480P": 854,    // 854x480
            "360P": 640     // 640x360
        };
        
        const maxSize = resolutionMap[videoMaxSize];
        if (!maxSize || isNaN(maxSize)) {
            return image;
        }
        
        // Check if resizing is needed
        const maxDimension = Math.max(image.width, image.height);
        if (maxDimension <= maxSize) {
            return image; // No resizing needed
        }
        
        // Calculate new dimensions maintaining aspect ratio
        const scaleFactor = maxSize / maxDimension;
        const newWidth = Math.round(image.width * scaleFactor);
        const newHeight = Math.round(image.height * scaleFactor);
        
        let canvas = null;
        try {
            // Create a canvas for resizing
            canvas = document.createElement("canvas");
            canvas.width = newWidth;
            canvas.height = newHeight;
            const ctx = canvas.getContext("2d");
            
            // Draw the image scaled down
            ctx.drawImage(image, 0, 0, newWidth, newHeight);
            
            // Store reference for cleanup in the Promise chain
            const tempCanvas = canvas;
            
            // Create ImageBitmap from the resized canvas
            return createImageBitmap(canvas).then(resizedImage => {
                // Close the original image to free GPU memory
                try {
                    image.close();
                } catch (e) {
                    console.warn("Error closing original frame:", e);
                }
                
                // Clean up temporary canvas - remove from DOM if attached and dereferenced
                if (tempCanvas && tempCanvas.parentNode) {
                    tempCanvas.parentNode.removeChild(tempCanvas);
                }
                
                return resizedImage;
            }).catch(error => {
                // Clean up on error
                try {
                    image.close();
                } catch (e) {
                    console.warn("Error closing original frame on resize error:", e);
                }
                if (tempCanvas && tempCanvas.parentNode) {
                    tempCanvas.parentNode.removeChild(tempCanvas);
                }
                throw error;
            });
        } catch (error) {
            showError("Error resizing video frame:", error);
            // Ensure canvas cleanup on synchronous errors
            if (canvas && canvas.parentNode) {
                canvas.parentNode.removeChild(canvas);
            }
            return image; // Return original on error
        }
    }

    /**
     * Process a decoded video frame and convert it to ImageBitmap
     * Handles frame resizing, caching, and group completion tracking
     * @param {number} frameNumber - Frame index in the video
     * @param {VideoFrame} videoFrame - Decoded frame from VideoDecoder
     * @param {Object} group - Frame group this frame belongs to
     */
    processDecodedFrame(frameNumber, videoFrame, group) {
        // Check if imageCache is still valid (video might have been disposed)
        if (!this.imageCache) {
            videoFrame.close();
            return;
        }

        // Close any existing frame at this position to avoid memory leaks
        const existingFrame = this.imageCache[frameNumber];
        if (existingFrame && existingFrame !== this.lastGoodFrame && typeof existingFrame.close === 'function') {
            try {
                existingFrame.close();
            } catch (e) {
                // Ignore errors when closing already-closed frames
            }
        }

        createImageBitmap(videoFrame).then(image => {
            // Double-check imageCache still exists (video might have been disposed during async operation)
            if (!this.imageCache) {
                if (typeof image.close === 'function') {
                    try {
                        image.close();
                    } catch (e) {
                        console.warn("Error closing image on cache invalidation:", e);
                    }
                }
                return;
            }

            // Apply rotation if needed
            const rotation = this.effectiveRotation;
            let rotationPromise;
            if (rotation !== 0) {
                rotationPromise = this.applyRotation(image, rotation).then(rotatedImage => {
                    // Close original image to free memory
                    if (image !== rotatedImage && typeof image.close === 'function') {
                        try {
                            image.close();
                        } catch (e) {
                            console.warn("Error closing original image after rotation:", e);
                        }
                    }
                    return rotatedImage;
                });
            } else {
                rotationPromise = Promise.resolve(image);
            }

            return rotationPromise.then(rotatedImage => {
                // Resize frame if needed based on videoMaxSize setting
                return this.resizeFrameIfNeeded(rotatedImage);
            });
        }).then(processedImage => {
            // Handle the final processed image (rotated and/or resized)
            if (!processedImage) return;

            // Double-check imageCache still exists after async operations
            if (!this.imageCache) {
                if (typeof processedImage.close === 'function') {
                    try {
                        processedImage.close();
                    } catch (e) {
                        console.warn("Error closing processed image on cache invalidation:", e);
                    }
                }
                return;
            }

            this.imageCache[frameNumber] = processedImage;
            if (this.videoWidth !== processedImage.width || this.videoHeight !== processedImage.height) {
                console.log("New per-frame video dimensions detected: width=" + processedImage.width + ", height=" + processedImage.height);
                this.videoWidth = processedImage.width;
                this.videoHeight = processedImage.height;
            }

            if (this.c_tmp === undefined) {
                this.c_tmp = document.createElement("canvas");
                this.c_tmp.setAttribute("width", this.videoWidth);
                this.c_tmp.setAttribute("height", this.videoHeight);
                this.ctx_tmp = this.c_tmp.getContext("2d");
            }

            // if it's the last one we wanted, then tell the system to render a frame
            if (frameNumber === this.lastGetImageFrame) {
                setRenderOne(true);
            }

            if (!group.decodeOrder) {
                group.decodeOrder = [];
            }
            group.decodeOrder.push(frameNumber);

            if (group.pending <= 0) {
                return;
            }

            group.pending--;
            if (group.pending === 0) {
                group.loaded = true;
                this.groupsPending--;
                this.handleGroupComplete();
            }
        }).catch(error => {
            showError("Error during frame processing/rotation/resizing:", error);
            if (this.imageCache && this.imageCache[frameNumber] instanceof ImageBitmap) {
                try {
                    this.imageCache[frameNumber].close();
                } catch (e) {
                    console.warn("Error closing frame on processing error:", e);
                }
                this.imageCache[frameNumber] = null;
            }
            // Decrement pending count even on error
            if (group && group.pending > 0) {
                group.pending--;
                if (group.pending === 0) {
                    group.loaded = false;
                    this.groupsPending--;
                }
            }
        }).catch(error => {
            showError("Error creating ImageBitmap:", error);
            // Ensure we still close the videoFrame on error
            try {
                videoFrame.close();
            } catch (e) {
                console.warn("Error closing videoFrame on ImageBitmap creation error:", e);
            }
            // Decrement pending count on error
            if (group && group.pending > 0) {
                group.pending--;
                if (group.pending === 0) {
                    group.loaded = false;
                    this.groupsPending--;
                }
            }
        });

        videoFrame.close();
    }

    handleGroupComplete() {
        if (this.groupsPending === 0) {
            if (this.nextRequest != null) {
                const group = this.nextRequest;
                this.nextRequest = null;
                this.requestGroup(group);
            } else if (this.requestQueue && this.requestQueue.length > 0) {
                const nextGroup = this.requestQueue.shift();
                this.requestGroup(nextGroup);
            }
        }
    }

    /**
     * Handle decoder errors - can be overridden by subclasses
     */
    handleDecoderError(error) {
        showError("Decoder error:", error);
    }

    buildTimestampMap() {
        this.timestampToChunkIndex = new Map();

        for (let g = 0; g < this.groups.length; g++) {
            const group = this.groups[g];
            const nextGroup = g + 1 < this.groups.length ? this.groups[g + 1] : null;
            group.openGopExtra = 0;
            if (nextGroup) {
                for (let i = nextGroup.frame + 1; i < nextGroup.frame + nextGroup.length; i++) {
                    if (i < this.chunks.length && this.chunks[i].timestamp < nextGroup.timestamp) {
                        group.openGopExtra++;
                    } else {
                        break;
                    }
                }
            }

            const timestamps = [];
            for (let i = group.frame; i < group.frame + group.length; i++) {
                timestamps.push(this.chunks[i].timestamp);
            }
            timestamps.sort((a, b) => a - b);
            for (let i = 0; i < timestamps.length; i++) {
                this.timestampToChunkIndex.set(timestamps[i], group.frame + i);
            }
        }
    }

    processChunksIntoGroups(encodedChunks, rawDataArray) {
        for (let i = 0; i < encodedChunks.length; i++) {
            const chunk = encodedChunks[i];
            chunk.frameNumber = this.frames++;
            this.chunks.push(chunk);

            if (rawDataArray && rawDataArray[i]) {
                this.rawChunkData.push(rawDataArray[i]);
            } else {
                const buf = new ArrayBuffer(chunk.byteLength);
                chunk.copyTo(buf);
                this.rawChunkData.push(buf);
            }

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
                    assert(chunk.timestamp >= lastGroup.timestamp, "out of group chunk timestamp");
                    lastGroup.length++;
                }
            }
        }

        this.buildTimestampMap();
    }

    // find the group object for a given frame
    getGroup(frame) {
        for (let g = 0; g < this.groups.length; g++) {
            const group = this.groups[g];
            if (frame >= group.frame && frame < (group.frame + group.length)) {
                return group;
            }
        }
        // if not found, this might mean the first group has a missing keyframe
        // which means we need to just skip the orphaned delta frames until we get to the next group (which will start with a keyframe)
        // const last = this.groups[this.groups.length - 1];
        // if (last) {
        //     console.warn("(frame = "+frame+" Last frame = " + last.frame + ", length = " + last.length + ", i.e. up to " + (last.frame + last.length - 1));
        // }
        return null;
    }

    getGroupsBetween(start, end) {
        const groups = [];
        for (let g = 0; g < this.groups.length; g++) {
            const group = this.groups[g];
            if (group.frame + group.length >= start && group.frame < end) {
                groups.push(group);
            }
        }
        return groups;
    }

    /**
     * Request that a specific frame be loaded into cache
     * Finds the appropriate group and requests its decoding
     * @param {number} frame - Frame number to request
     */
    requestFrame(frame) {
        if (!this.groups || this.groups.length === 0 || !this.chunks) {
            return; // Not initialized yet
        }

        if (frame > Sit.videoFrames - 1) frame = Sit.videoFrames - 1;
        if (frame < 0) frame = 0;

        const group = this.getGroup(frame);
        if (group === null) {
            return; // No group found
        }
        this.requestGroup(group);
    }

    requestGroup(group) {
        if (!group || typeof group !== "object") {
            console.warn("requestGroup: invalid group", group);
            return;
        }

        if (!this.chunks) return;

        if (group.loaded || group.pending > 0) return;

        if (this._workerManager && this._workerManager.configured) {
            this._requestGroupViaWorker(group);
        } else if (this._workerManager && !this._workerManager.configFailed) {
            this.handleBusyDecoder(group);
        } else if (this.ensureMainThreadDecoder()) {
            this._requestGroupMainThread(group);
        }
    }

    _requestGroupViaWorker(group) {
        if (this.isAudioActive() && !this.isAudioReady()) {
            this.handleBusyDecoder(group);
            return;
        }

        if (this.flushing || this._workerManager.busy) {
            this.handleBusyDecoder(group);
            return;
        }

        const extraChunks = group.openGopExtra || 0;
        group.pending = group.length;
        group.decodePending = 0;
        group.loaded = false;
        group.decodeOrder = [];
        group._expectedLength = group.length;
        this.groupsPending++;

        const groupId = this._groupIdCounter++;
        this._activeGroupMap.set(groupId, group);

        const decodeEnd = group.frame + group.length + (extraChunks > 0 ? extraChunks + 1 : 0);
        const chunksToSend = [];
        const rawDataToSend = [];
        const timestampMap = [];

        for (let i = group.frame; i < decodeEnd && i < this.chunks.length; i++) {
            chunksToSend.push(this.chunks[i]);
            rawDataToSend.push(this.rawChunkData[i]);
        }

        for (let i = group.frame; i < group.frame + group.length; i++) {
            if (i < this.chunks.length) {
                const frameNumber = this.timestampToChunkIndex?.get(this.chunks[i].timestamp);
                if (frameNumber !== undefined) {
                    timestampMap.push({ timestamp: this.chunks[i].timestamp, frameNumber: frameNumber });
                }
            }
        }

        if (extraChunks > 0) {
            for (let i = group.frame + group.length; i < decodeEnd && i < this.chunks.length; i++) {
                const frameNumber = this.timestampToChunkIndex?.get(this.chunks[i].timestamp);
                if (frameNumber !== undefined) {
                    timestampMap.push({ timestamp: this.chunks[i].timestamp, frameNumber: frameNumber });
                }
            }
        }

        this.flushing = true;
        const sent = this._workerManager.decodeGroup(groupId, chunksToSend, rawDataToSend, timestampMap);
        if (!sent) {
            this.flushing = false;
            group.pending = 0;
            group.loaded = false;
            this.groupsPending--;
            this._activeGroupMap.delete(groupId);
            this.handleBusyDecoder(group);
        }
    }

    _requestGroupMainThread(group) {
        if (this.isAudioActive() && !this.isAudioReady()) {
            this.handleBusyDecoder(group);
            return;
        }

        if (this.flushing || this.decoder.decodeQueueSize > 0) {
            this.handleBusyDecoder(group);
            return;
        }
        const extraChunks = group.openGopExtra || 0;
        group.pending = group.length;
        group.decodePending = 0;
        group.loaded = false;
        group.decodeOrder = [];
        this.groupsPending++;

        try {
            const decodeEnd = group.frame + group.length + (extraChunks > 0 ? extraChunks + 1 : 0);
            for (let i = group.frame; i < decodeEnd; i++) {
                if (i < this.chunks.length) {
                    this.decoder.decode(this.chunks[i]);
                }
            }

            this.flushing = true;
            this.decoder.flush().then(() => {
                this.flushing = false;
                const droppedFrames = group.length - group.decodePending;
                if (droppedFrames > 0) {
                    group.pending -= droppedFrames;
                    if (group.pending <= 0) {
                        group.pending = 0;
                        group.loaded = true;
                        this.groupsPending--;
                    }
                }
                this.handleGroupComplete();
            }).catch(() => {
                this.flushing = false;
            });
        } catch (error) {
            group.pending = 0;
            group.loaded = false;
            this.groupsPending--;
            if (error.message && error.message.includes("key") && this.config) {
                try {
                    this.decoder.reset();
                    this.decoder.configure(this.config);
                } catch (resetError) {
                    console.warn("Failed to reset decoder after key frame error:", resetError);
                }
            } else {
                showErrorOnce("GROUPDECODEERROR", "Error during group decode:", error);
            }
        }
    }

    /**
     * Handle busy decoder - different strategies for different subclasses
     */
    handleBusyDecoder(group) {
        // CVideoMp4Data uses nextRequest
        if (this.nextRequest !== undefined) {
            this.nextRequest = group;
        }
        // CVideoH264Data uses requestQueue
        if (this.requestQueue && !this.requestQueue.includes(group)) {
            this.requestQueue.push(group);
        }
    }

    purgeGroupsExcept(keep) {
        for (let g in this.groups) {
            const group = this.groups[g];
            if (!keep.has(group) && group.loaded && group.pending <= 0) {
                assert(this.imageCache, "imageCache is undefined when purging groups but groups.length = " + this.groups.length);

                for (let i = group.frame; i < group.frame + group.length; i++) {
                    // release all the frames in this group
                    // Close imageCache (ImageBitmap for WebCodec videos)
                    if (this.imageCache[i]) {
                        // Don't close the lastGoodFrame - we need it as fallback
                        if (this.imageCache[i] === this.lastGoodFrame) {
                            this.imageCache[i] = null;
                            continue;
                        }
                        // Only close ImageBitmap objects, not regular images
                        if (this.imageCache[i] instanceof ImageBitmap) {
                            try {
                                this.imageCache[i].close(); // Close ImageBitmap to free GPU memory
                            } catch (e) {
                                console.warn("Error closing ImageBitmap during purge:", e);
                            }
                        }
                        this.imageCache[i] = null; // Use null instead of undefined for better garbage collection
                    }
                    
                    // Clean up data caches
                    if (this.imageDataCache && this.imageDataCache[i]) {
                        this.imageDataCache[i] = null;
                    }
                    if (this.frameCache && this.frameCache[i]) {
                        this.frameCache[i] = null;
                    }
                }
                group.loaded = false;
                group.pending = 0; // Reset pending count to prevent stale data
                group.decodeOrder = []; // Clear decode order to free memory
            }
        }
    }

    /**
     * Get the image for a specific frame, loading it if necessary
     * Implements intelligent caching with lookahead/behind windows
     * Returns closest available frame if exact frame not ready
     * @param {number} frame - Frame number to retrieve
     * @returns {ImageBitmap|Canvas|null} The frame image or blank frame
     */
    getImage(frame) {
        frame = Math.floor(frame / this.videoSpeed);

        if (this.incompatible || this.fallbackMode) {
            return this.errorImage;
        }

        if (this._loadingId && (!this.groups || this.groups.length === 0 || !this.imageCache || !this.chunks)) {
            if (!this._loadingPlaceholder) {
                const {VideoLoadingManager} = require("./CVideoLoadingManager");
                this._loadingPlaceholder = VideoLoadingManager.createLoadingImageForVideo(
                    this.filename,
                    this.videoWidth || 640,
                    this.videoHeight || 480
                );
            }
            return this._loadingPlaceholder;
        }

        if (!this.groups || this.groups.length === 0 || !this.imageCache || !this.chunks) {
            return this.createBlankFrame();
        }

        // Check for invalid frame numbers - return blank frame instead of null
        if (frame < 0 || frame >= this.chunks.length) {
            return this.createBlankFrame();
        }

        // Detect concurrent frame requests from different timeline positions (thrashing)
        // Skip if this is just normal playback (frame === par.frame)
        const now = performance.now();
        if (this.lastGetImageFrame !== undefined && this.lastGetImageTime !== undefined && frame !== par.frame) {
            const frameDelta = Math.abs(frame - this.lastGetImageFrame);
            const timeDelta = now - this.lastGetImageTime;
            if (frameDelta > 100 && timeDelta < 100) {
                console.warn(`[Video thrashing] Large frame jump: ${this.lastGetImageFrame} -> ${frame} (delta=${frameDelta}) in ${timeDelta.toFixed(0)}ms. Multiple systems may be requesting different frames.`);
            }
        }
        this.lastGetImageTime = now;

        let cacheWindow = 30; // how much we seek ahead (and keep behind)
        const mem = navigator.deviceMemory;
        if (mem !== undefined && mem >= 8) {
            cacheWindow = 100;

            if (isLocal || Globals.userID === 1) {
         //       cacheWindow = 300;
            }
        }

        const echoNeeded = this.echoFramesNeeded || 0;
        const backwardKeep = Math.max(cacheWindow, echoNeeded);

        this.lastGetImageFrame = frame;

        const groupsToKeep = new Set();
        const groupsToRequest = new Set();
        const currentGroup = this.getGroup(frame);

        for (let g in this.groups) {
            const group = this.groups[g];
            const groupEnd = group.frame + group.length;
            if (groupEnd > frame - backwardKeep && group.frame <= frame + cacheWindow) {
                groupsToKeep.add(group);
            }
        }

        if (currentGroup) groupsToRequest.add(currentGroup);
        if (echoNeeded > 0) {
            const echoStart = Math.max(0, frame - echoNeeded);
            for (const group of groupsToKeep) {
                const groupEnd = group.frame + group.length;
                if (groupEnd > echoStart && group.frame <= frame) {
                    groupsToRequest.add(group);
                }
            }
        }
        const lookaheadGroup = this.getGroup(Math.min(frame + cacheWindow, this.chunks.length - 1));
        if (lookaheadGroup) groupsToRequest.add(lookaheadGroup);

        this.purgeGroupsExcept(groupsToKeep);

        for (const group of groupsToRequest) {
            if (group !== currentGroup) {
                this.requestGroup(group);
            }
        }
        if (currentGroup) {
            this.requestGroup(currentGroup);
        }

        assert(this.imageCache, "imageCache is " + this.imageCache + " for frame " + frame + " but groups.length = " + this.groups.length);

        // return the closest frame that has been loaded
        let A = frame;
        let B = frame;
        let bestFrame = frame;
        let foundFrame = false;
        
        while (A >= 0 && B < this.chunks.length) {
            if (A >= 0 && A < this.imageCache.length) {
                const frameA = this.imageCache[A];
                if (frameA && frameA.width && frameA.width > 0) {
                    bestFrame = A;
                    foundFrame = true;
                    break;
                }
            }
            A--;
            
            if (B < this.chunks.length && B < this.imageCache.length) {
                const frameB = this.imageCache[B];
                if (frameB && frameB.width && frameB.width > 0) {
                    bestFrame = B;
                    foundFrame = true;
                    break;
                }
            }
            B++;
        }

        // Check if bestFrame is valid and accessible
        if (foundFrame && bestFrame >= 0 && bestFrame < this.imageCache.length) {
            const image = this.imageCache[bestFrame];
            if (image && image.width && image.width > 0) {
                this.setLastGoodFrame(image, bestFrame);
                return this.getStabilizedImage(frame, image, bestFrame);
            }
        }

        // If no valid frame found, return last good frame if available
        if (this.lastGoodFrame && this.lastGoodFrame.width && this.lastGoodFrame.width > 0) {
            return this.getStabilizedImage(frame, this.lastGoodFrame, this.lastGoodFrameIndex);
        }

        // Only return blank frame as last resort
        return this.createBlankFrame();
    }

    getCachedImage(frame) {
        frame = Math.floor(frame / this.videoSpeed);
        if (!this.imageCache || frame < 0 || frame >= this.imageCache.length) return null;
        const img = this.imageCache[frame];
        return (img && img.width > 0) ? img : null;
    }

    /**
     * Set the last good frame for fallback display
     * Uses O(1) index-based lookup instead of O(n) .includes() scan
     * @param {ImageBitmap} image - The frame to set as lastGoodFrame
     * @param {number} frameIndex - The cache index this frame came from
     */
    setLastGoodFrame(image, frameIndex) {
        if (this.lastGoodFrame === image) return;

        // Check if old lastGoodFrame is orphaned (not in imageCache)
        // O(1) lookup using stored index instead of O(n) .includes() scan
        if (this.lastGoodFrame && this.imageCache) {
            const stillInCache = this.lastGoodFrameIndex >= 0 &&
                                 this.lastGoodFrameIndex < this.imageCache.length &&
                                 this.imageCache[this.lastGoodFrameIndex] === this.lastGoodFrame;
            if (!stillInCache && typeof this.lastGoodFrame.close === 'function') {
                try {
                    this.lastGoodFrame.close();
                } catch (e) {
                    // Already closed
                }
            }
        }
        this.lastGoodFrame = image;
        this.lastGoodFrameIndex = frameIndex;
    }

    isFrameCached(frame) {
        frame = Math.floor(frame / this.videoSpeed);
        if (!this.imageCache || frame < 0 || frame >= this.imageCache.length) {
            return false;
        }
        const cachedFrame = this.imageCache[frame];
        return cachedFrame && cachedFrame.width && cachedFrame.width > 0;
    }

    getImageNoPurge(frame) {
        frame = Math.floor(frame / this.videoSpeed);
        if (!this.imageCache || frame < 0 || frame >= this.imageCache.length) {
            return null;
        }
        const cachedFrame = this.imageCache[frame];
        if (cachedFrame && cachedFrame.width && cachedFrame.width > 0) {
            return cachedFrame;
        }
        return null;
    }

    async waitForFrame(frame, timeout = 10000) {
        const actualFrame = Math.floor(frame / this.videoSpeed);
        const startTime = Date.now();
        
        while (!this.config || !this.chunks || !this.groups || this.groups.length === 0) {
            if (Date.now() - startTime > timeout) {
                console.warn(`waitForFrame: timeout waiting for video initialization, frame ${frame}`);
                return false;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        
        if (this.isFrameCached(frame)) {
            return true;
        }
        
        const group = this.getGroup(actualFrame);
        if (!group) {
            console.warn(`waitForFrame: no group for frame ${frame}`);
            return false;
        }
        
        if (group.loaded) {
            return this.isFrameCached(frame);
        }
        
        while (!group.loaded) {
            if (Date.now() - startTime > timeout) {
                console.warn(`waitForFrame timeout waiting for group to load, frame ${frame}`);
                return false;
            }
            await new Promise(r => setTimeout(r, 10));
        }
        
        return this.isFrameCached(frame);
    }

    createBlankFrame() {
        if (!this.videoWidth || !this.videoHeight) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = 1; 
            tempCanvas.height = 1;
            const ctx = tempCanvas.getContext('2d');
            ctx.fillStyle = 'black'; 
            ctx.fillRect(0, 0, 1, 1);
            return tempCanvas;
        }

        // if the desired dimensions of the blank frame haven't changed, just return it
        // but if they have, dispose of it, so it gets recreated
        if (this.blankFrame &&
             (this.blankFrame.width !== this.videoWidth ||
            this.blankFrame.height !== this.videoHeight)) {
            // Dispose of old blank frame
            if (typeof this.blankFrame.close === 'function') {
                try {
                    this.blankFrame.close();
                } catch (e) {
                    console.warn("Error closing old blank frame:", e);
                }
            }
            this.blankFrame = null;
            this.blankFramePending = false;
        }

        // If we already have a blank frame or it's pending creation, return it
        if (this.blankFrame) {
            return this.blankFrame;
        }
        
        // If blank frame creation is already pending, return a temporary canvas
        if (this.blankFramePending) {
            if (!this.blankFrameCanvas) {
                this.blankFrameCanvas = document.createElement('canvas');
                this.blankFrameCanvas.width = this.videoWidth;
                this.blankFrameCanvas.height = this.videoHeight;
                const ctx = this.blankFrameCanvas.getContext('2d');
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, this.videoWidth, this.videoHeight);
            }
            return this.blankFrameCanvas;
        }

        // Create a blank canvas with video dimensions
        const canvas = document.createElement('canvas');
        canvas.width = this.videoWidth;
        canvas.height = this.videoHeight;
        const ctx = canvas.getContext('2d');

        // Fill with black
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, this.videoWidth, this.videoHeight);

        // Store canvas for return while ImageBitmap is being created
        this.blankFrameCanvas = canvas;
        this.blankFramePending = true;

        // Convert to ImageBitmap for consistency with decoded frames
        createImageBitmap(canvas).then(bitmap => {
            this.blankFrame = bitmap;
            this.blankFramePending = false;
            // Clean up temporary canvas once we have the bitmap
            this.blankFrameCanvas = null;
        }).catch(error => {
            console.warn("Error creating blank frame ImageBitmap:", error);
            // Fallback to canvas - keep using the canvas
            this.blankFrame = canvas;
            this.blankFramePending = false;
        });

        // Return canvas immediately while ImageBitmap is being created
        return canvas;
    }

    update() {
        super.update();
        if (this.incompatible) return;

        // Ensure rendering continues while groups are pending
        for (let g in this.groups) {
            const group = this.groups[g];
            if (group.pending > 0)
                setRenderOne(true);
        }

        if (isLocal) {
        //     this.debugVideo()
        }
    }

    /**
     * Get GPU memory usage estimate for debugging
     * Note: This is an estimate based on cached frames
     */
    getGPUMemoryEstimate() {
        let cachedCount = 0;
        let cachedBytes = 0;
        
        if (this.imageCache) {
            for (let i = 0; i < this.imageCache.length; i++) {
                const frame = this.imageCache[i];
                if (frame && frame.width && frame.height) {
                    cachedCount++;
                    // Estimate: 4 bytes per pixel (RGBA)
                    cachedBytes += frame.width * frame.height * 4;
                }
            }
        }
        
        const estimatedMB = (cachedBytes / (1024 * 1024)).toFixed(2);
        return { count: cachedCount, estimatedMB: estimatedMB };
    }

    debugVideo() {
        let d = "";

        // Start with filename
        d += "<strong>File: " + this.filename + "</strong><br>";
        
        if (this.config !== undefined && this.groups) {
            // Get config info - allow subclasses to override
            const configInfo = this.getDebugConfigInfo();
            d += configInfo + "<br>";
            
            // Add GPU memory estimate
            const gpuMem = this.getGPUMemoryEstimate();
            d += "GPU Memory (est): " + gpuMem.count + " frames = " + gpuMem.estimatedMB + " MB<br>";
            
            d += "CVideoView: " + this.videoWidth + "x" + this.videoHeight + "<br>";
            d += "par.frame = " + par.frame + ", Sit.frames = " + Sit.frames + ", chunks = " + this.chunks.length + "<br>";
            d += this.lastDecodeInfo;
            if (this.decoder) {
                d += "Decode Queue Size = " + this.decoder.decodeQueueSize + " State = " + this.decoder.state + "<br>";
            }

            // Add any additional debug info from subclasses
            const additionalInfo = this.getAdditionalDebugInfo();
            if (additionalInfo) {
                d += additionalInfo + "<br>";
            }

            const currentGroup = this.getGroup(par.frame);

            for (let _g in this.groups) {
                const g = this.groups[_g];

                // count how many images and imageDatas we have
                let images = 0;
                let imageDatas = 0;
                let framesCaches = 0;
                if (this.imageCache) {
                    for (let i = g.frame; i < g.frame + g.length; i++) {
                        if (this.imageCache[i] !== undefined && this.imageCache[i].width !== 0)
                            images++;
                        if (this.imageDataCache[i] !== undefined && this.imageDataCache[i].width !== 0)
                            imageDatas++;
                        if (this.frameCache[i] !== undefined)
                            framesCaches++;
                    }
                }

                // Get group info - allow subclasses to customize format
                const groupInfo = this.getDebugGroupInfo(_g, g, images, imageDatas, framesCaches, currentGroup);
                d += groupInfo + "<br>";
            }
        }

        infoDiv.style.display = 'block';
        infoDiv.style.fontSize = "13px";
        infoDiv.style.zIndex = '1001';
        infoDiv.innerHTML = d;
    }

    /**
     * Get config information for debug display - can be overridden by subclasses
     */
    getDebugConfigInfo() {
        const fps = Sit.fps ? ` @ ${Sit.fps}fps` : '';
        return "Config: Codec: " + this.config.codec + "  format:" + this.format + " " + this.videoWidth + "x" + this.videoHeight + fps;
    }

    /**
     * Get additional debug information - can be overridden by subclasses
     */
    getAdditionalDebugInfo() {
        return "";
    }

    /**
     * Get group information for debug display - can be overridden by subclasses
     */
    debugCacheIntegrity() {
        const cache = this.imageCache;
        const totalFrames = this.chunks.length;
        let totalGaps = 0;
        for (let gi = 0; gi < this.groups.length; gi++) {
            const g = this.groups[gi];
            let cached = 0;
            const gapFrames = [];
            for (let i = g.frame; i < g.frame + g.length; i++) {
                if (cache[i] && cache[i].width > 0) {
                    cached++;
                } else {
                    gapFrames.push(i - g.frame);
                }
            }
            if (gapFrames.length > 0) {
                console.log(`[CACHE] Group ${gi}: frame ${g.frame}, len ${g.length}, loaded=${g.loaded}, pending=${g.pending}, decodePending=${g.decodePending}, cached=${cached}/${g.length}, gap offsets: ${gapFrames.join(',')}`);
                totalGaps += gapFrames.length;
            } else {
                console.log(`[CACHE] Group ${gi}: frame ${g.frame}, len ${g.length}, loaded=${g.loaded} - OK (${cached}/${g.length})`);
            }
        }
        console.log(`[CACHE] Total: ${totalFrames} frames, ${totalGaps} gaps`);
        return totalGaps;
    }

    getDebugGroupInfo(groupIndex, group, images, imageDatas, framesCaches, currentGroup) {
        return "Group " + groupIndex + ": frame " + group.frame + " length " + group.length + " images " + images + " imageDatas " + imageDatas + " framesCaches "
            + framesCaches
            + (group.loaded ? " Loaded " : "")
            + (currentGroup === group ? "*" : " ")
            + (group.pending ? "pending = " + group.pending : "");
    }

    flushEntireCache() {
        // Close lastGoodFrame first since we're clearing everything
        if (this.lastGoodFrame && typeof this.lastGoodFrame.close === 'function') {
            try {
                this.lastGoodFrame.close();
            } catch (e) {
                // Ignore
            }
        }
        this.lastGoodFrame = null;
        this.lastGoodFrameIndex = -1;

        if (this.imageCache) {
            // Close all ImageBitmap objects to free memory
            for (let i = 0; i < this.imageCache.length; i++) {
                if (this.imageCache[i]) {
                    if (typeof this.imageCache[i].close === 'function') {
                        try {
                            this.imageCache[i].close();
                        } catch (e) {
                            console.warn("Error closing ImageBitmap during flush:", e);
                        }
                    }
                    this.imageCache[i] = null;
                }
            }
        }

        // Close blank frame if it's an ImageBitmap
        if (this.blankFrame) {
            if (typeof this.blankFrame.close === 'function') {
                try {
                    this.blankFrame.close();
                } catch (e) {
                    console.warn("Error closing blank frame:", e);
                }
            }
            this.blankFrame = null;
        }

        // Clean up blank frame canvas
        if (this.blankFrameCanvas) {
            // Remove from DOM if attached
            if (this.blankFrameCanvas.parentNode) {
                this.blankFrameCanvas.parentNode.removeChild(this.blankFrameCanvas);
            }
            this.blankFrameCanvas = null;
        }

        // Clean up temporary canvas and context
        if (this.c_tmp) {
            // Remove from DOM if attached
            if (this.c_tmp.parentNode) {
                this.c_tmp.parentNode.removeChild(this.c_tmp);
            }
            this.c_tmp = null;
        }
        if (this.ctx_tmp) {
            this.ctx_tmp = null;
        }

        // Reset cache arrays
        this.imageCache = [];
        this.imageDataCache = [];
        this.frameCache = [];

        // Reset groups
        if (this.groups) {
            for (let group of this.groups) {
                group.loaded = false;
                group.pending = 0;
                group.decodeOrder = [];
            }
        }

        this.groupsPending = 0;
        this.nextRequest = null;
        this.requestQueue = [];
        this._activeGroupMap?.clear();
        
        this.decodeFrameIndex = 0;
    }

    stopStreaming() {
        this.flushEntireCache();
        // Note: We don't close the decoder here to allow continued scrubbing
        // The decoder will be closed only when the video object is destroyed
    }

    // Only call this when completely done with the video (switching videos, etc.)
    destroy() {
        this.closeDecoder();
        this.flushEntireCache();
    }

    closeDecoder() {
        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
                console.log("VideoDecoder closed");
            } catch (error) {
                console.warn("Error closing decoder:", error);
            }
        }
    }

    /**
     * Clean up all resources and cancel pending operations
     * Properly resets decoder, clears callbacks, and releases memory
     * Critical for preventing decoder operations after disposal
     */
    dispose() {
        this.loadedCallback = null;
        this.errorCallback = null;
        
        this.groupsPending = 0;
        this.nextRequest = null;
        this.requestQueue = [];
        this._activeGroupMap?.clear();

        if (this._workerManager) {
            this._workerManager.dispose();
            this._workerManager = null;
        }
        
        if (this.decoder) {
            const decoder = this.decoder;
            this.decoder = null;
            
            if (decoder.state !== 'closed') {
                try {
                    decoder.reset();
                    decoder.close();
                } catch (e) {
                    console.warn("Error closing decoder:", e);
                }
            }
        }
        
        this.flushEntireCache();
        
        super.dispose();

        delete Sit.videoFile;
        delete Sit.videoFrames;
    }
}