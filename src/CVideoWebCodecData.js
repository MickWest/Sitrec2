import {FileManager, infoDiv, setRenderOne, Sit} from "./Globals";
import {assert} from "./assert";
import {loadImage, versionString} from "./utils";
import {MP4Demuxer, MP4Source} from "./js/mp4-decode/mp4_demuxer";
import {par} from "./par";
import {isLocal} from "./configUtils";
import {CVideoData} from "./CVideoData";
import {updateSitFrames} from "./UpdateSitFrames";
import {showError} from "./showError";

export class CVideoWebCodecData extends CVideoData {


    constructor(v, loadedCallback, errorCallback) {
        super(v);


        this.format = ""
        this.error = false;
        this.loaded = false;

        this.incompatible = true;
        try {
            if (VideoDecoder !== undefined) {
                this.incompatible = false;
            }
        } catch (e) {
        }

        if (this.incompatible) {
            console.log("Video Playback Requires up-to-date WebCodec Browser (Chrome/Edge/Safari")
            this.errorImage = null;
            loadImage('./data/images/errorImage.png').then(result => {
                this.errorImage = result;
            })
            return;
        }

        let source = new MP4Source()

        // here v.file, if defined is a file name
        // either a URL or a local file
        // check for local file (i.e. file on the user's computer loaded with a file picker)
        // if it's got no forward slashes, then it's a local file


        // FileManager handles URL resolution, caching, and path normalization

        if (v.file !== undefined ) {
            FileManager.loadAsset(v.file, "video").then(result => {
                // the file.appendBuffer expects an ArrayBuffer with a fileStart value (a byte offset) and
                // and byteLength (total byte length)
                result.parsed.fileStart = 0;        // patch in the fileStart of 0, as this is the whole thing
                this.videoDroppedData = result.parsed;
                source.file.appendBuffer(result.parsed)
                source.file.flush();

                // Remove it from the file manager
                // as we only need it for the initial load
                FileManager.disposeRemove("video");

                loadedCallback();

            })
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
                    loadedCallback();
                }

            }
        }

        // RGB filters need to make an ImageData copy to get the RGBA values
        // rather expensive.
        // this was used as a testbed for workers, see PixelFilterWorker.js
        this.RGBFilters = false;


        // YUVFilters, if we want to manipulate or inspect the raw per-frame YUV values
        // like for motion tracking in near real-time
        // or ad-hoc filters (that hopefully we'd be able to do in WebGL shaders, as YUV extraction and recoding is slow)
        this.YUVFilters = false;

        if (this.RGBFilters) {
            this.numWorkers = 16;           // 16, really dude?
            this.filterWorkers = []
        }
        let demuxer = new MP4Demuxer(source);
        this.startWithDemuxer(demuxer)

    }

    killWorkers() {
        for (let i = 0; i < this.numWorkers; i++) {
            if (this.filterWorkers[i] !== undefined) {
                this.filterWorkers[i].terminate()
                this.filterWorkers[i] = undefined;
            }
        }
    }

    // this handles messages from the worker threads.
    handleWorker(e) {
        // create new cached frame from the cached data
        const frameNumber = e.data[0]
        createImageBitmap(e.data[1]).then(recreatedImage => {
            this.imageCache[frameNumber] = recreatedImage
        })
    }

    restartWorker() {


        this.killWorkers()

        for (let i = 0; i < this.numWorkers; i++) {
            this.filterWorkers[i] = new Worker('./src/workers/PixelFilterWorker.js?=' + versionString);
            this.filterWorkers[i].onmessage = (e) => {
                this.handleWorker(e)
            }
        }
        this.nextWorker = 0;

    }



    startWithDemuxer(demuxer) {

        //        let demuxer = new MP4Demuxer(v.file);
        this.frames = 0;

        this.lastGetImageFrame = 0


        this.chunks = [] // per frame chunks
        this.groups = [] // groups for frames+delta

        // if a group is pending, then we don't accept any more requests
        // until that group has finished loading
        // at that point we just request the very last frame that was requestes
        this.groupsPending = 0;
        this.nextRequest = null


        this.incomingFrame = 0;
        this.lastTimeStamp = -1;

        this.restartWorker()


        this.decoder = new VideoDecoder({
            output: videoFrame => {

                this.format = videoFrame.format;


                this.lastDecodeInfo = "last frame.timestamp = " + videoFrame.timestamp + "<br>";

                const frameNumber = this.timestampToChunkIndex?.get(videoFrame.timestamp);
                if (frameNumber === undefined) {
                    videoFrame.close();
                    return;
                }

                var group = this.getGroup(frameNumber);
                if (!group) {
                    videoFrame.close();
                    return;
                }

                group.decodePending++;
//                console.log(frameNumber+ " Timestamp: "+frame.timestamp)
                createImageBitmap(videoFrame).then(image => {
                    this.imageCache[frameNumber] = image
                    this.videoWidth = image.width;
                    this.videoHeight = image.height;
                    if (this.c_tmp === undefined) {
                        this.c_tmp = document.createElement("canvas")
                        this.c_tmp.setAttribute("width", this.videoWidth)
                        this.c_tmp.setAttribute("height", this.videoHeight)
                        this.ctx_tmp = this.c_tmp.getContext("2d")
                    }


                    // a new raw frame has been decoded into an ImageBitmap
                    // so we want to update the ImageData and fltered versions
                    if (this.RGBFilters) {
                        this.updateFilter(frameNumber)
                    }
                    if (this.YUVFilters) {
                        this.updateYUVFilter(frameNumber)
                    }

                    // if it's the last one we wanted, then tell the system to render a frame
                    // so we update the video display
                    if (frameNumber === this.lastGetImageFrame) {
                        setRenderOne(true);
                    }

                    const group = this.getGroup(frameNumber);

                    if (group.decodeOrder !== undefined)
                        group.decodeOrder.push(frameNumber)

                    if (group.pending > 0) {
                        group.pending--;
                        if (group.pending === 0) {
                            group.loaded = true;
                            this.groupsPending--;
                            if (this.groupsPending === 0 && this.nextRequest != null) {
                                const req = this.nextRequest;
                                this.nextRequest = null;
                                this.requestGroup(req)
                            }
                        }
                    }

                    if (this.decoder.decodeQueueSize === 0) {
                        if (this.nextRequest != null) {
                            const req = this.nextRequest;
                            this.nextRequest = null;
                            this.requestGroup(req)
                        }
                    }

                    videoFrame.close();

                })

                if (this.YUVFilters) {
                    // also make a raw copy of the YUV videoframe.
                    // note the actual format might vary with different implementation of WebCOded
                    // so check for NV
                    let buffer = new Uint8Array(videoFrame.allocationSize());

                    videoFrame.copyTo(buffer).then(
                        this.frameCache[frameNumber] = buffer
                    );
                }
            },
            error: e => showError(e),
        });

        this.demuxFrame = 0;

        demuxer.getConfig().then((config) => {
//            offscreen.height = config.codedHeight;
//            offscreen.width = config.codedWidth;

            this.config = config;

            this.decoder.configure(config);
            demuxer.start((chunk) => {
                // The demuxer will call this for each chunk it demuxes
                // essentiall it's iterating through the frames
                // each chunk is either a key frame or a delta frame
                chunk.frameNumber = this.demuxFrame++
                this.chunks.push(chunk)

                if (chunk.type === "key") {
                    this.groups.push({
                            frame: this.chunks.length - 1,  // first frame of this group
                            length: 1,                      // for now, increase with each delta demuxed
                            pending: 0,                     // how many frames requested and pending
                            loaded: false,                  // set when all the frames in the group are loaded
                            timestamp: chunk.timestamp,
                        }
                    )
                } else {
                    const lastGroup = this.groups[this.groups.length - 1]
                    assert(chunk.timestamp >= lastGroup.timestamp, "out of group chunk timestamp")
                    lastGroup.length++;
                }

                // console.log(this.chunks.length - 1 + ": Demuxer got a " + chunk.type + " chunk, timestamp=" + chunk.timestamp +
                //      ", duration = " + chunk.duration + ", byteLength = " + chunk.byteLength)

                this.frames++;
                Sit.videoFrames = this.frames * this.videoSpeed;
                // Sit.aFrame = 0;
                // Sit.bFrame = Sit.videoFrames-1;

                // decoding is now deferred
                //            decoder.decode(chunk);
            })
            this.buildTimestampMap();

            console.log("Demuxing done (assuming not async loading), frames = " + this.frames + ", Sit.videoFrames = " + Sit.videoFrames)
            console.log("Demuxer calculated frames as " + demuxer.source.totalFrames)
            //assert(this.frames === demuxer.source.totalFrames, "Frames mismatch between demuxer and decoder"+this.frames+"!="+demuxer.source.totalFrames)

            // use the demuxer frame count, as it's more accurate
            Sit.videoFrames = demuxer.source.totalFrames * this.videoSpeed;

            // also update the fps
            Sit.fps = demuxer.source.fps;

            updateSitFrames()
        });

    }


    // find the group object for a given frame
    getGroup(frame) {
        for (let g = 0; g < this.groups.length; g++) {
            const group = this.groups[g]
            if (frame >= group.frame && frame < (group.frame + group.length)) {
                return group;
            }
        }
        const last = this.groups[this.groups.length - 1];
        assert(last !== undefined, "last groups is undefined, I've loaded " + this.groups.length)
        console.warn("Last frame = " + last.frame + ", length = " + last.length + ", i.e. up to " + (last.frame + last.length - 1))
        //assert(0,"group not found for frame "+frame)
        return null;
    }

    // request that a frame be loaded
    // which currently means finding what group the frame is in, and then loading that
    requestFrame(frame) {

        if (frame > Sit.videoFrames - 1) frame = Sit.videoFrames - 1;
        if (frame < 0) frame = 0

        // if it's already loading, then we are good, don't need to do anything with this request
        const group = this.getGroup(frame);
        assert(group !== null, "group not found for frame " + frame)
        this.requestGroup(group);
    }

    requestGroup(group) {
        if (group.loaded || group.pending > 0)
            return;

//        console.log("requestFrame " + frame +" group.loaded = " + group.loaded + " group.pending = " + group.pending)


        // if some OTHER group is currently pending, then we just store the request for when it has finished
        // note this does not queue the requests, so only the most recent one will be honored
//        if (this.groupsPending > 0) {
        if (this.flushing || this.decoder.decodeQueueSize > 0) {
            this.nextRequest = group;
            return;
        }

        const extraChunks = group.openGopExtra || 0;
        group.pending = group.length;
        group.decodePending = 0;
        group.loaded = false;
        group.decodeOrder = []
        this.groupsPending++;
        const decodeEnd = group.frame + group.length + (extraChunks > 0 ? extraChunks + 1 : 0);
        for (let i = group.frame; i < decodeEnd; i++) {
            if (i < this.chunks.length) {
                this.decoder.decode(this.chunks[i])
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

//        console.log ("decodeQueuesize = "+this.decoder.decodeQueueSize+" added "+addedToDecodeQueue)
    }

    purgeGroupsExcept(keep) {
        let numPending = 0;
        for (let g in this.groups) {
            const group = this.groups[g]
            if (group.pending > 0)
                numPending++;
            if (keep.find(keeper => keeper === group) === undefined && group.loaded) {
//                console.log("Purging group at frame "+group.frame+" group pending = "+group.pending)
                for (let i = group.frame + 1; i < group.frame + group.length; i++) {
                    // release all the frames in this group
                    this.imageCache[i] = new Image()    // TODO, maybe better as null, but other code expect an empty Image when not loaded
                    this.imageDataCache[i] = undefined;      // the imageData versions used for filtering
                    this.frameCache[i] = undefined;          // the imageData versions used for filtering
                }
                group.loaded = false;
            }
        }
        if (numPending > 0) {
//            console.log("numPending = " + numPending + " this.groupsPending = " + this.groupsPending)
        }
    }

    debugVideo() {
        let d = "";

        // Start with filename (if available)
        const filename = this.v?.file || this.v?.dropFile?.name || "Unknown";
        d += "<strong>File: " + filename + "</strong><br>";

        if (this.config !== undefined) {
            const fps = Sit.fps ? ` @ ${Sit.fps}fps` : '';
            d += "Config: Codec: " + this.config.codec + "  format:" + this.format + " " + this.config.codedWidth + "x" + this.config.codedHeight + fps + "<br>";
            d += "CVideoView: " + this.videoWidth + "x" + this.videoHeight + "<br>";
            d += "par.frame = " + par.frame + ", Sit.frames = " + Sit.frames + ", chunks = " + this.chunks.length + "<br>";
            d += this.lastDecodeInfo;
            d += "Decode Queue Size = " + this.decoder.decodeQueueSize + " State = " + this.decoder.state + "<br>";

            for (let _g in this.groups) {
                const g = this.groups[_g];

                // count how many images and imageDatas we have
                var images = 0;
                var imageDatas = 0;
                var framesCaches = 0;
                for (var i = g.frame; i < g.frame + g.length; i++) {
                    if (this.imageCache[i] !== undefined && this.imageCache[i].width !== 0)
                        images++;
                    if (this.imageDataCache[i] !== undefined && this.imageDataCache[i].width !== 0)
                        imageDatas++;
                    if (this.frameCache[i] !== undefined)
                        framesCaches++;
                }

                const currentGroup = this.getGroup(par.frame);

                d += "Group " + _g + " f = " + g.frame + " l = " + g.length + " ts = " + g.timestamp
                    + " i = " + images + " id = " + imageDatas + " fc = "
                    + framesCaches
                    + (g.loaded ? " Loaded " : "")
                    + (currentGroup === g ? "*" : " ")
                    + (g.pending ? "pending = " + g.pending : "")
                    + "<br>";
            }
        }

        infoDiv.style.display = 'block';
        infoDiv.style.fontSize = "13px";
        infoDiv.style.zIndex = '1001';
        infoDiv.innerHTML = d;
    }

    getCachedImage(frame) {
        frame = Math.floor(frame / this.videoSpeed);
        if (!this.imageCache || frame < 0 || frame >= this.imageCache.length) return null;
        const img = this.imageCache[frame];
        return (img && img.width !== 0) ? img : null;
    }

    isFrameLoaded(frame) {
        frame = Math.floor(frame / this.videoSpeed);
        return this.imageCache[frame] !== undefined && this.imageCache[frame].width !== 0;
    }

    async waitForFrame(frame, timeout = 10000) {
        frame = Math.floor(frame / this.videoSpeed);
        const start = performance.now();
        
        // Wait for video initialization (decoder + chunks + groups must be ready)
        while (!this.decoder || !this.chunks || !this.groups || this.groups.length === 0) {
            if (performance.now() - start > timeout) {
                console.warn(`waitForFrame: timeout waiting for video initialization, frame ${frame}`);
                return false;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        
        if (frame < 0) frame = 0;
        if (frame >= this.chunks.length) frame = this.chunks.length - 1;
        
        if (this.isFrameLoaded(frame * this.videoSpeed)) {
            return true;
        }
        
        const group = this.getGroup(frame);
        if (!group) {
            console.warn(`waitForFrame: no group for frame ${frame}`);
            return false;
        }
        
        // If group is already loaded, return immediately
        if (group.loaded) {
            return this.isFrameLoaded(frame * this.videoSpeed);
        }
        
        // If group is already being decoded, just wait for it
        if (group.pending > 0) {
            while (!group.loaded) {
                if (performance.now() - start > timeout) {
                    console.warn(`waitForFrame timeout waiting for pending group, frame ${frame}`);
                    return false;
                }
                await new Promise(r => setTimeout(r, 10));
            }
            return this.isFrameLoaded(frame * this.videoSpeed);
        }
        
        // Group not loaded and not pending - need to request it
        // Wait only for decoder to be idle, not for all groups
        while (this.decoder && this.decoder.decodeQueueSize > 0) {
            if (performance.now() - start > timeout) {
                console.warn(`waitForFrame timeout waiting for decoder queue, frame ${frame}`);
                return false;
            }
            await new Promise(r => setTimeout(r, 10));
        }
        
        // Request our group
        this.requestGroup(group);
        
        // Wait for our group to load
        while (!group.loaded) {
            if (performance.now() - start > timeout) {
                console.warn(`waitForFrame timeout waiting for group to load, frame ${frame}`);
                return false;
            }
            await new Promise(r => setTimeout(r, 10));
        }
        
        return this.isFrameLoaded(frame * this.videoSpeed);
    }

    getImage(frame) {

        frame = Math.floor(frame / this.videoSpeed); // videoSpeed will normally be 1, but for timelapse will be


        if (this.incompatible) {
            // incompatible browser (i.e. does not support WebCodec)
            return this.errorImage
        } else {

            // if not loaded any groups yet, then don't try to render anything
            if (this.groups.length === 0)
                return null;

            const cacheWindow = 30;
            const echoNeeded = this.echoFramesNeeded || 0;
            const backwardKeep = Math.max(cacheWindow, echoNeeded);

            this.lastGetImageFrame = frame

            const groupsToKeep = [];
            const groupsToRequest = [];

            const currentGroup = this.getGroup(frame);
            if (currentGroup) {
                groupsToKeep.push(currentGroup);
                groupsToRequest.push(currentGroup);
            }

            for (const group of this.groups) {
                const groupEnd = group.frame + group.length;
                if (groupEnd > frame - backwardKeep && group.frame <= frame + cacheWindow) {
                    if (!groupsToKeep.includes(group)) groupsToKeep.push(group);
                }
            }

            if (echoNeeded > 0) {
                const echoStart = Math.max(0, frame - echoNeeded);
                for (const group of groupsToKeep) {
                    const groupEnd = group.frame + group.length;
                    if (groupEnd > echoStart && group.frame <= frame && !groupsToRequest.includes(group)) {
                        groupsToRequest.push(group);
                    }
                }
            }

            const lookaheadFrame = Math.min(frame + cacheWindow, this.chunks.length - 1);
            const lookaheadGroup = this.getGroup(lookaheadFrame);
            if (lookaheadGroup && !groupsToRequest.includes(lookaheadGroup)) {
                groupsToRequest.push(lookaheadGroup);
            }

            this.purgeGroupsExcept(groupsToKeep)

            for (const group of groupsToRequest) {
                if (group !== currentGroup) this.requestFrame(group.frame);
            }
            this.requestFrame(frame)

            // return the closest frame that has been loaded
            // usually this just mean it returns the one indicated by "frame"
            // but if we've rapidly scrubbed then we might not have this frame
            // Note when purging we currently don't removed the key frames
            // so we'll have a sparsely populated set of frames for scrubbing
            let A = frame;
            let B = frame;
            let bestFrame = frame;
            while (A >= 0 && B < this.chunks.length) {
                if (A >= 0) {
                    if (this.imageCache[A] !== undefined && this.imageCache[A].width !== 0) {
                        bestFrame = A;
                        break;
                        //return this.imageCache[A];
                    }
                    A--
                }
                if (B < this.chunks.length) {
                    if (this.imageCache[B] !== undefined && this.imageCache[B].width !== 0) {
                        bestFrame = B;
                        break;
                        //    return this.imageCache[B];
                    }
                    B++
                }
            }

            let image = this.imageCache[bestFrame]
            return image;


            // return super.getImage(frame)
        }

    }


    updateYUVFilter(frameNumber) {
        const image = this.imageCache[frameNumber]
        const YUV = this.frameCache[frameNumber]
        const len = this.videoWidth * this.videoHeight
        if (image && YUV) {
            var newData = new Uint8ClampedArray(len * 4)
            for (let i = 0; i < len; i++) {


                // calculate offset of the CbCr byte pair (one per 2x2 pixels)
                // TODO: the row stride might differ for odd dimension videos
                var row = Math.floor(i / this.videoWidth)
                var col = (i % this.videoWidth) & 0xfffffffe
                let uvOffset = len + this.videoWidth * (row >> 1) + col

                // this is the YCbCr to RGB conversion matrix.
                // for BT.709 HDTV
                // TODO - extract the matrix from the video  -at least ot assert it's the same
                var y = YUV[i] - 16
                var u = YUV[uvOffset + 0] - 128
                var v = YUV[uvOffset + 1] - 128
                const r = 1.164 * y + 1.596 * v;
                const g = 1.164 * y - 0.392 * u - 0.813 * v;
                const b = 1.164 * y + 2.017 * u + 100;


                // var r = y + 1.402 * v;
                // var g = y - 0.34414 * u - 0.71414 * v;
                // var b = y + 1.772 * u;
                /*
                                // Clamp to 0..1
                                if (r < 0) r = 0;
                                if (g < 0) g = 0;
                                if (b < 0) b = 0;
                                if (r > 255) r = 255;
                                if (g > 255) g = 255;
                                if (b > 255) b = 255;
                */

                newData[i * 4 + 0] = r
                newData[i * 4 + 1] = g // YUV[len+(i>>2)+0]
                newData[i * 4 + 2] = b // YUV[i]
                newData[i * 4 + 3] = 255
            }

            // creating an ImageData isn't that slow
            var newImageData = new ImageData(newData, this.videoWidth, this.videoHeight)

            const localFrameNumber = frameNumber;
            createImageBitmap(newImageData).then(
                imageBitmap => this.imageCache[localFrameNumber] = imageBitmap
            )

        }
    }

    updateFilter(frameNumber) {
        const image = this.imageCache[frameNumber]
        if (image) {
            // handle creating filtered images
            // if there's no imageData, then make it from this image
            // this gets us the raw bytes from which we can either recreate the image
            // or create a filtered version
            if (!this.imageDataCache[frameNumber]) {
                // extract the pixel data in RGBA by rendering on a canvas
                // and then getting the ImageData from that
                // store them in a matching array
                // i.e. we have the usable images in this.imageCache
                // and the ImageData version in this.imageDataCache
                this.ctx_tmp.drawImage(image, 0, 0)
                const imageData = this.ctx_tmp.getImageData(0, 0, this.videoWidth, this.videoHeight)
                this.imageDataCache[frameNumber] = imageData
            }

            // a test filter

            // make a copy of the imagedata, so we can modify the array
            var clonedImageData = new ImageData(
                new Uint8ClampedArray(this.imageDataCache[frameNumber].data),
                this.imageDataCache[frameNumber].width,
                this.imageDataCache[frameNumber].height
            )


            for (let i = 0; i < clonedImageData.data.length / 4; i++) {
                //            clonedImageData.data[i*4 + 0] += Math.random()*255
            }

            this.filterWorkers[this.nextWorker].postMessage([frameNumber, clonedImageData], [clonedImageData.data.buffer]);
            this.nextWorker++
            if (this.nextWorker >= this.numWorkers)
                this.nextWorker = 0;


            // TODO - empty data from cache
        }

    }


    update() {
        super.update()
        if (this.incompatible) return;

        // TODO - seems like this should be simpler
        // note this just ensure ONE MORE group will be loaded
        // as update is not called when not rendering
        // but it seems to work
        for (let g in this.groups) {
            const group = this.groups[g]
            if (group.pending > 0)
                setRenderOne(true);
        }

        // // if we've decoded all the frames, then make sure they get to where they are going
        // if (this.decoder.decodeQueueSize === 0 && this.decoder.state !== "unconfigured")
        //     this.decoder.flush()

        if (isLocal) {
        //     this.debugVideo()
        }
    }

    dispose() {
        if (this.decoder) {
            // flush is asynchronous, so we need to wait for it to finish
            // before we close the decoder
            // we create a local variable to avoid the "this" context changing
            const decoder = this.decoder;
            // Check decoder state before attempting operations
            if (decoder.state !== 'closed') {
                decoder.flush()
                    .catch(() => {})   // swallow any flush errors we don't care about
                    .finally(() => {
                        try {
                            if (decoder.state !== 'closed') {
                                decoder.close();
                            }
                        } catch (e) {
                            console.warn("Error closing decoder:", e);
                        }
                    });
            }
            this.decoder = null;
        }
        this.killWorkers();
        super.dispose();

        delete Sit.videoFile;
        delete Sit.videoFrames;
    }

    stopStreaming() {
        this.killWorkers()
        super.stopStreaming()
    }

}


