/**
 * Video view node for displaying and interacting with video content
 * Extends CNodeViewCanvas2D to provide video-specific rendering and controls
 * 
 * Key responsibilities:
 * - Manages video data objects (CVideoMp4Data, CVideoImageData, etc.)
 * - Handles video rendering with effects and filters
 * - Provides mouse-based zoom, pan, and scrubbing controls
 * - Synchronizes audio playback with video frames
 * - Manages video loading states and error display
 * - Supports drag-and-drop video file loading
 * 
 * Mouse controls:
 * - Wheel: Zoom in/out
 * - Left drag: Pan video
 * - Right drag: Scrub through frames
 * - Middle drag: Zoom
 * - Double click: Reset to default position
 * 
 * Video effects (optional inputs):
 * - brightness, contrast, blur, greyscale
 * - hue, invert, saturate
 * - convolutionFilter (sharpen, edge detect, emboss)
 * 
 * Audio synchronization:
 * - Calls audioHandler.play() when playing
 * - Calls audioHandler.pause() when paused
 * - Restarts audio on frame jumps
 */

import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {par} from "../par";
import {quickToggle} from "../KeyBoardHandler";
import {CNodeGUIFlag, CNodeGUIValue} from "./CNodeGUIValue";
import {CNodeConstant} from "./CNode";
import {Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {CMouseHandler} from "../CMouseHandler";
import {CNodeViewUI} from "./CNodeViewUI";
import {CVideoMp4Data} from "../CVideoMp4Data";
import {CVideoAudioOnly} from "../CVideoAudioOnly";
import {CVideoImageData} from "../CVideoImageData";
import {isAudioOnlyFormat} from "../AudioFormats";
import {assert} from "../assert";
import {EventManager} from "../CEventManager";
import {getFlowAlignRotation} from "../FlowAlignment";
import {VideoLoadingManager} from "../CVideoLoadingManager";
import {CNodeGridOverlay} from "./CNodeGridOverlay";


export class CNodeVideoView extends CNodeViewCanvas2D {
    constructor(v) {
        super(v);
        // this.canvas.addEventListener( 'wheel', e => this.handleMouseWheel(e) );

        // these no longer work with the new rendering pipeline
        // TODO: reimplement them as effects?
        this.optionalInputs(["brightness", "contrast", "blur", "greyscale", "hue", "invert", "saturate", "enableVideoEffects", "convolutionFilter"])
        //

        //  if (this.overlayView === undefined)
        addFiltersToVideoNode(this)

        this.positioned = false;
        this.autoFill = v.autoFill ?? true; // default to autofill
        this.shiftDrag = true;

        this.scrubFrame = 0; // storing fractiona accumulation of frames while scrubbing

        this.autoClear = (v.autoClear !== undefined) ? v.autoClear : false;

        this.input("zoom", true); // zoom input is optional

        this.videoSpeed = v.videoSpeed ?? 1; // default to 1x speed
        this.alwaysReplace = v.alwaysReplace ?? false;

        this.lastAudioSyncFrame = -1;
        this.wasPlayingLastFrame = false;

        this.videos = [];
        this.currentVideoIndex = -1;
        this.videoSelectorController = null;

        this.setupMouseHandler();

        // if it's an overlay view then we don't need to add the overlay UI view
        if (!v.overlayView) {
            // Add an overlay view to show status (mostly errors)
            this.overlay = new CNodeViewUI({ id: this.id + "_videoOverlay", overlayView: this })
            this.overlay.ignoreMouseEvents();
        }

        v.id = v.id + "_data"

        if (v.file !== undefined) {
            this.newVideo(v.file, false); // don't clear Sit.frames as legacy code sets it when passing in a video filename this way
        }


    }

    get videoWidth() {
        return this.videoData?.videoWidth || 0;
    }

    get videoHeight() {
        return this.videoData?.videoHeight || 0;
    }

    get originalVideoWidth() {
        return this.videoData?.originalVideoWidth || this.videoWidth;
    }

    get originalVideoHeight() {
        return this.videoData?.originalVideoHeight || this.videoHeight;
    }

    newVideo(fileName, clearFrames = true) {
        if (clearFrames) {
            Sit.frames = undefined; // need to recalculate this
        }
        this.fileName = fileName;
        if (this.pendingVideoRestore) {
            this.videoData = null;
            this.staticURL = undefined;
        } else {
            this.disposeVideoData()
        }

        // to make the quite test even quicker, we don't lad videos, just amke a red square.
        if (Globals.quickTerrain) {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FF0000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            this.videoData = new CVideoImageData({
                id: this.id + "_data_" + this.videos.length,
                filename: fileName,
                img: canvas,
                deleteAfterUsing: false
            },
                this.loadedCallback.bind(this), this.errorCallback.bind(this));
            this.positioned = false;
            par.frame = 0;
            par.paused = false;
            return;
        }

        Globals.pendingActions++;
        this.videoLoadPending = true;

        const videoIndex = this.videos.length;
        const videoDataId = this.id + "_data_" + videoIndex;
        console.log(`[VideoNew] Creating video[${videoIndex}]: "${fileName}", id="${videoDataId}"`);

        // Check if it's an audio-only file based on extension
        if (isAudioOnlyFormat(fileName)) {
            console.log(`[VideoNew] Using audio-only handler for video[${videoIndex}]`);
            this.videoData = new CVideoAudioOnly({ id: videoDataId, filename: fileName, videoSpeed: this.videoSpeed },
                this.loadedCallback.bind(this), this.errorCallback.bind(this))
        } else {
            console.log(`[VideoNew] Using CVideoMp4Data for video[${videoIndex}]`);
            this.videoData = new CVideoMp4Data({ id: videoDataId, file: fileName, videoSpeed: this.videoSpeed },
                this.loadedCallback.bind(this), this.errorCallback.bind(this))
        }

        console.log(`[VideoNew] Created videoData for video[${videoIndex}]: imageCache.length=${this.videoData?.imageCache?.length}`);

        VideoLoadingManager.registerLoading(videoDataId, fileName);
        this.videoData._loadingId = videoDataId;

        // loaded from a URL, so we can set the staticURL
        this.staticURL = this.fileName;

        // Add to videos array immediately (not during restore - that's handled by continueVideoRestore)
        if (!this.pendingVideoRestore) {
            this.addVideoEntry(fileName, this.staticURL, false);
        }

        this.positioned = false;
        par.frame = 0;
        par.paused = false; // unpause, otherwise we see nothing.
        this.addLoadingMessage()
        this.addDownloadButton()


    }

    addLoadingMessage() {
        if (this.overlay)
            this.overlay.addText("videoLoading", "LOADING", 50, 50, 5, "#f0f000")
    }


    removeText() {
        if (this.overlay) {
            this.overlay.removeText("videoLoading")
            this.overlay.removeText("videoError")
            this.overlay.removeText("videoErrorName")
            this.overlay.removeText("videoNo")
        }
    }


    stopStreaming() {
        this.removeText()
        par.frame = 0
        par.paused = false;
        if (this.videoData) {
            this.videoData.stopStreaming()
        }
        this.positioned = false;
    }



    loadedCallback(videoData) {
        this.removeText();


        // in the case where the videoData is immediately set up ina  constructor,
        // allow video data derived constructors to pass in "this" so we can get the width and height
        // Speicifically this handles the case where a "video" is a single image.
        if (videoData === undefined)
            videoData = this.videoData;

        assert(videoData, "CNodeVideoView loadedCallback called with no videoData, possibly because it's called in the constructor before the this.videoData is assigned");

        // Decrement pendingActions if this video was registered with the VideoLoadingManager
        // Use _loadingId to track per-video pending state (not videoLoadPending which is shared)
        console.log(`[VideoLoaded] _loadingId check: "${videoData._loadingId}", filename: "${videoData?.filename}"`);
        if (videoData._loadingId) {
            console.log(`[VideoLoaded] Calling completeLoading for: ${videoData._loadingId}`);
            VideoLoadingManager.completeLoading(videoData._loadingId);
            Globals.pendingActions--;
            console.log(`[VideoLoaded] pendingActions decremented to: ${Globals.pendingActions}`);
        } else if (this.videoLoadPending || this.pendingVideoRestore) {
            // Fallback for videos without _loadingId (legacy path)
            Globals.pendingActions--;
            console.log(`[VideoLoaded] pendingActions decremented (legacy) to: ${Globals.pendingActions}`);
        }
        this.videoLoadPending = false;

        const vd = videoData;
        console.log(`[VideoLoaded] ========== Video Load Complete ==========`);
        console.log(`[VideoLoaded]   filename: "${vd?.filename}"`);
        console.log(`[VideoLoaded]   dimensions: ${vd?.videoWidth}x${vd?.videoHeight}`);
        console.log(`[VideoLoaded]   frames: ${vd?.frames}, groups: ${vd?.groups?.length}, chunks: ${vd?.chunks?.length}`);
        console.log(`[VideoLoaded]   imageCache: length=${vd?.imageCache?.length}, type=${vd?.imageCache?.constructor?.name}`);
        console.log(`[VideoLoaded]   this.videos.length: ${this.videos.length}, pendingRestore: ${!!this.pendingVideoRestore}`);

        // if we loaded from a mod or custom
        // then we might want to set the frame nubmer
        if (Sit.pars !== undefined && Sit.pars.frame !== undefined) {
            par.frame = Sit.pars.frame;
        }


        // if we don't have a zoom input, then we are using the mouse zooming and panning
        // i.e. zoomView()
        // So we need to set the default position to get the right aspect ratio
        // this may not responde well to dynamic resizing, but that's a more complex problem to solve.
        if (!this.in.zoom) {
            this.defaultPosition();
        }

        // Setup/update rotation dropdown now that video is loaded
        this.setupRotationDropdown();

        // Handle pending multi-video restore
        // Pass vd (the videoData from callback parameter) since this.videoData may not be set yet
        // (CVideoImageData calls loadedCallback synchronously from within its constructor)
        if (this.pendingVideoRestore) {
            this.continueVideoRestore(vd);
        }
    }

    continueVideoRestore(loadedVideoData) {
        if (!this.pendingVideoRestore) return;

        const { videos, targetIndex } = this.pendingVideoRestore;
        const loadedCount = this.videos.length;
        const totalCount = videos.length;

        console.log(`[VideoRestore] Video loaded callback - loaded=${loadedCount}/${totalCount}, targetIndex=${targetIndex}`);
        console.log(`[VideoRestore] Loaded videoData: filename=${loadedVideoData?.filename}, frames=${loadedVideoData?.frames}, imageCache.length=${loadedVideoData?.imageCache?.length}, groups=${loadedVideoData?.groups?.length}`);

        // Add the just-loaded video to the array
        // Use the passed loadedVideoData since this.videoData may not be assigned yet
        // Add the just-loaded video to the array
        // Use the passed loadedVideoData since this.videoData may not be assigned yet
        if (loadedCount < totalCount) {
            const skippedCount = this.pendingVideoRestore.skippedCount || 0;
            const entryIndex = loadedCount + skippedCount;
            const entry = videos[entryIndex];
            if (entry) {
                console.log(`[VideoRestore] Adding video[${loadedCount}] (source index ${entryIndex}): "${entry.fileName}"`);
                this.addVideoEntry(entry.fileName, entry.staticURL, entry.isImage || false, entry.imageFileID, loadedVideoData);
            }
        }

        // Check if more videos need to be loaded
        // We need to check against totalCount, but remember that videos.length doesn't include skipped
        const skippedCount = this.pendingVideoRestore.skippedCount || 0;
        if (this.videos.length + skippedCount < totalCount) {
            const nextIdx = this.videos.length + skippedCount;
            const nextEntry = videos[nextIdx];
            if (nextEntry) {
                console.log(`[VideoRestore] Starting load for video[${nextIdx}]: "${nextEntry.fileName}"`);
                this.loadVideoFromEntry(nextEntry);
            }
        } else {
            // All videos loaded
            console.log(`[VideoRestore] All ${totalCount} videos loaded. Switching to targetIndex=${targetIndex}`);
            this.logVideoArrayState();
            delete this.pendingVideoRestore;
            if (targetIndex !== this.currentVideoIndex && targetIndex < this.videos.length) {
                this.selectVideo(targetIndex);
            }
            // Ensure video selector is updated after GUI is ready
            // (guiMenus.view might not exist yet during early restore)
            this.ensureVideoSelectorUpdated();
        }
    }

    logVideoArrayState() {
        console.log(`[VideoState] videos array (${this.videos.length} entries):`);
        this.videos.forEach((v, i) => {
            const vd = v.videoData;
            console.log(`  [${i}] "${v.fileName}" - hasVideoData=${!!vd}, frames=${vd?.frames}, imageCache=${vd?.imageCache?.length}, groups=${vd?.groups?.length}, loaded=${vd?.loaded}`);
        });
        console.log(`[VideoState] currentVideoIndex=${this.currentVideoIndex}, this.videoData.filename=${this.videoData?.filename}`);
    }

    isValidVideoURL(url) {
        if (!url) return false;
        return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:');
    }
    
    loadVideoFromEntry(entry) {
        const nextIdx = this.videos.length;
        console.log(`[VideoLoad] loadVideoFromEntry[${nextIdx}]: "${entry.fileName}", isImage=${entry.isImage}, staticURL=${entry.staticURL?.substring(0, 50)}...`);
        
        if (entry.isImage && entry.imageFileID) {
            const { FileManager } = require("../Globals");
            const fileEntry = FileManager.list[entry.imageFileID];
            // Use .original which contains the ArrayBuffer (not .data which may be the parsed Image object)
            if (fileEntry && fileEntry.original) {
                console.log(`[VideoLoad] Loading image[${nextIdx}] from FileManager`);
                Globals.pendingActions++;
                const ext = entry.fileName.split('.').pop().toLowerCase();
                const mimeType = ext === 'png' ? 'image/png' :
                                ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                ext === 'gif' ? 'image/gif' :
                                ext === 'webp' ? 'image/webp' : 'image/png';
                const blob = new Blob([fileEntry.original], { type: mimeType });
                const blobURL = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    console.log(`[VideoLoad] Image[${nextIdx}] loaded: ${img.width}x${img.height}`);
                    this.makeImageVideo(entry.fileName, img);
                    this.imageFileID = entry.imageFileID;
                    // NOTE: Don't call loadedCallback here - CVideoImageData constructor
                    // already queues it via queueMicrotask. Calling it twice would
                    // corrupt the video array by adding duplicate entries.
                };
                img.onerror = (err) => {
                    console.error(`[VideoLoad] Failed to load image[${nextIdx}] "${entry.fileName}":`, err);
                    Globals.pendingActions--;
                    this.skipCurrentVideoRestore();
                };
                img.src = blobURL;
            } else {
                console.warn(`[VideoLoad] Cannot restore image[${nextIdx}] "${entry.fileName}" - file original data not available`);
                this.skipCurrentVideoRestore();
            }
        } else {
            const url = entry.staticURL || entry.fileName;
            if (this.isValidVideoURL(url)) {
                console.log(`[VideoLoad] Loading video[${nextIdx}] from URL: ${url.substring(0, 80)}...`);
                this.newVideo(url, false);
            } else {
                console.warn(`[VideoLoad] Cannot restore video[${nextIdx}] "${entry.fileName}" - invalid URL (local files must be re-imported)`);
                this.skipCurrentVideoRestore();
            }
        }
    }

    skipCurrentVideoRestore() {
        if (!this.pendingVideoRestore) return;
        
        const { videos, targetIndex } = this.pendingVideoRestore;
        this.pendingVideoRestore.skippedCount = (this.pendingVideoRestore.skippedCount || 0) + 1;
        const skipped = this.pendingVideoRestore.skippedCount;
        
        console.log(`[VideoRestore] Skipped ${skipped} video(s) so far`);
        
        if (this.videos.length + skipped < videos.length) {
            const nextIdx = this.videos.length + skipped;
            const nextEntry = videos[nextIdx];
            if (nextEntry) {
                console.log(`[VideoRestore] Continuing to video[${nextIdx}] after skip`);
                this.loadVideoFromEntry(nextEntry);
            }
        } else {
            console.warn(`[VideoRestore] Restore complete with ${skipped} video(s) skipped - please re-import local files`);
            delete this.pendingVideoRestore;
        }
    }

    errorCallback() {
        if (this.videoData?._loadingId) {
            VideoLoadingManager.completeLoading(this.videoData._loadingId);
        }
        if (this.videoLoadPending || this.pendingVideoRestore) {
            Globals.pendingActions--;
            this.videoLoadPending = false;
        }
        if (this.videoData) {
            this.videoData.error = true;
        }
        if (this.overlay) {
            this.overlay.removeText("videoLoading")
            this.overlay.addText("videoError", "Error Loading", 50, 45, 5, "#f0f000", "center")
            this.overlay.addText("videoErrorName", this.fileName, 50, 55, 1.5, "#f0f000", "center")
        }

        // If we are in a restore sequence, an error means we should probably skip this video
        // and try to load the rest, rather than stalling the entire chain.
        if (this.pendingVideoRestore) {
            console.warn(`[VideoRestore] Error loading video "${this.fileName}", skipping and continuing restore...`);
            // Add a small delay so the user might see the error momentarily (optional), 
            // or just proceed immediately. For robustness, proceed.
            this.skipCurrentVideoRestore();
        }
    }

    onMouseWheel(e) {

        if (this.overlayView !== undefined) {
            // if this is an overlay view, then we don't want to zoom
            // as the overlay view is not zoomable
            // so we just pass the event to the overlaid view
            if (this.overlayView.onMouseWheel !== undefined) {
                this.overlayView.onMouseWheel(e);
            }
            return;
        }

        var scale = 0.90;  // zoom in/out by 10% on mouse wheel up/down
        if (e.deltaY < 0) {
            scale = 1 / scale
        }

        const videoZoom = NodeMan.get("videoZoom", false);
        if (videoZoom !== undefined) {
            let v = videoZoom.value;
            v *= scale;
            videoZoom.setValue(v);
        }
    }


    setupMouseHandler() {
        this.mouse = new CMouseHandler(this, {

            down: (e) => {
                if (e.button === 0) {
                    this.fixCrosshair();
                }
            },

            wheel: (e) => {

                //                console.log(e.deltaY)
                var scale = 0.90;
                if (e.deltaY > 0) {
                    //                    this.in.zoom.value *= 0.6666
                } else {
                    //                    this.in.zoom.value *= 1 / 0.6666
                    scale = 1 / scale
                }

                this.zoomView(scale)

            },

            drag: (e) => {
                const moveX = this.mouse.dx / this.widthPx; // px = mouse move as a fraction of the screen width
                const moveY = this.mouse.dy / this.widthPx
                this.posLeft += moveX
                this.posRight += moveX
                this.posTop += moveY
                this.posBot += moveY

            },


            rightDrag: (e) => {
                this.scrubFrame += this.mouse.dx / 4
                if (this.scrubFrame >= 1.0 || this.scrubFrame <= -1.0) {
                    const whole = Math.floor(this.scrubFrame)
                    par.frame += whole
                    this.scrubFrame -= whole;
                }

                setRenderOne(true);
            },


            centerDrag: (e) => {
                this.zoomView(100 / (100 - this.mouse.dx))
            },

            dblClick: (e) => {
                this.defaultPosition();
            },

            contextMenu: (e) => {
                // TODO: Implement actual video view context menu
                alert("Context menu triggered on video view.\nContext menus are not yet fully implemented for video views.");
            }

        })
    }

    toSerializeCNodeVideoView = ["posLeft", "posRight", "posTop", "posBot"]

    modSerialize() {
        const result = {
            ...super.modSerialize(),
            ...this.simpleSerialize(this.toSerializeCNodeVideoView)
        };
        if (this.videos && this.videos.length > 1) {
            result.currentVideoIndex = this.currentVideoIndex;
        }
        return result;
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.simpleDeserialize(v, this.toSerializeCNodeVideoView)
        this.positioned = true;
        if (v.currentVideoIndex !== undefined && this.videos && this.videos.length > 1) {
            this.selectVideo(v.currentVideoIndex);
        }
    }

    disposeVideoData() {
        if (this.videoData) {
            const isInArray = this.videos.some(v => v.videoData === this.videoData);
            if (isInArray) {
                this.videoData = null;
            } else {
                this.videoData.stopStreaming()
                this.videoData.dispose();
                this.videoData = null;
            }
        }
        this.staticURL = undefined; // clear the static URL, so we will rehost any dropped file
    }

    addVideoEntry(fileName, staticURL = undefined, isImage = false, imageFileID = undefined, videoData = undefined) {
        const vd = videoData || this.videoData;
        const newIndex = this.videos.length;
        console.log(`[VideoEntry] Adding video[${newIndex}]: "${fileName}"`);
        console.log(`[VideoEntry]   videoData: filename=${vd?.filename}, frames=${vd?.frames}, imageCache.length=${vd?.imageCache?.length}, groups=${vd?.groups?.length}`);

        const entry = {
            fileName: fileName,
            staticURL: staticURL,
            isImage: isImage,
            imageFileID: imageFileID,
            videoData: vd
        };
        this.videos.push(entry);
        this.currentVideoIndex = newIndex;
        console.log(`[VideoEntry] currentVideoIndex now ${this.currentVideoIndex}`);
        this.updateVideoSelector();
        return entry;
    }

    getCurrentVideoEntry() {
        if (this.currentVideoIndex >= 0 && this.currentVideoIndex < this.videos.length) {
            return this.videos[this.currentVideoIndex];
        }
        return null;
    }

    updateCurrentVideoEntry() {
        if (this.videoLoadPending || this.pendingVideoRestore) {
            return;
        }
        const entry = this.getCurrentVideoEntry();
        if (entry) {
            entry.staticURL = this.staticURL;
            entry.videoData = this.videoData;
            if (this.imageFileID) {
                entry.imageFileID = this.imageFileID;
            }
        }
    }

    selectVideo(index) {
        if (index < 0 || index >= this.videos.length) return;
        if (index === this.currentVideoIndex) return;

        console.log(`[VideoSwitch] ========== Switching from video[${this.currentVideoIndex}] to video[${index}] ==========`);
        this.logVideoArrayState();

        this.updateCurrentVideoEntry();

        this.currentVideoIndex = index;
        const entry = this.videos[index];
        const vd = entry.videoData;

        console.log(`[VideoSwitch] Target video[${index}]:`);
        console.log(`[VideoSwitch]   fileName: "${entry.fileName}"`);
        console.log(`[VideoSwitch]   videoData: filename=${vd?.filename}, frames=${vd?.frames}`);
        console.log(`[VideoSwitch]   imageCache: length=${vd?.imageCache?.length}, type=${vd?.imageCache?.constructor?.name}`);
        console.log(`[VideoSwitch]   groups: ${vd?.groups?.length}, chunks: ${vd?.chunks?.length}`);
        console.log(`[VideoSwitch]   loaded: ${vd?.loaded}, percentLoaded: ${vd?.percentLoaded}`);

        this.fileName = entry.fileName;
        this.staticURL = entry.staticURL;
        this.videoData = entry.videoData;
        this.imageFileID = entry.imageFileID || null;

        this.positioned = false;
        this.defaultPosition();
        this._lastSwitchDebug = true;
        setRenderOne(true);

        this.updateVideoSelector();
        this.updateRotationDropdown();
    }

    getVideoDisplayName(entry, index) {
        if (!entry || !entry.fileName) return `Video ${index + 1}`;
        let name = entry.fileName;
        if (name.includes('/')) {
            name = name.split('/').pop();
        }
        if (name.length > 30) {
            name = name.substring(0, 27) + "...";
        }
        return name;
    }

    updateVideoSelector() {
        console.log(`[VideoSelector] updateVideoSelector called: guiMenus.view=${!!guiMenus.view}, videos.length=${this.videos.length}`);

        if (!guiMenus.view) {
            console.log(`[VideoSelector] Skipping - guiMenus.view not available`);
            return;
        }

        if (this.videos.length <= 1) {
            console.log(`[VideoSelector] Skipping - only ${this.videos.length} video(s)`);
            if (this.videoSelectorController) {
                this.videoSelectorController.destroy();
                this.videoSelectorController = null;
            }
            return;
        }

        const options = {};
        for (let i = 0; i < this.videos.length; i++) {
            options[this.getVideoDisplayName(this.videos[i], i)] = i;
        }

        if (this.videoSelectorController) {
            this.videoSelectorController.destroy();
        }

        this.currentVideoSelection = this.currentVideoIndex;
        console.log(`[VideoSelector] Creating selector with ${Object.keys(options).length} options`);
        this.videoSelectorController = guiMenus.video.add(this, "currentVideoSelection", options)
            .name("Current Video")
            .onChange((value) => {
                this.selectVideo(value);
            });
        console.log(`[VideoSelector] Selector created: ${!!this.videoSelectorController}`);
    }

    ensureVideoSelectorUpdated(retries = 10) {
        if (guiMenus.view) {
            this.updateVideoSelector();
            this.setupRotationDropdown();
        } else if (retries > 0) {
            setTimeout(() => this.ensureVideoSelectorUpdated(retries - 1), 100);
        }
    }

    /**
     * Set up the video rotation dropdown in the View menu
     * Allows user to rotate video by 0°, 90° CW, 180°, or 90° CCW
     */
    setupRotationDropdown() {
        if (!guiMenus.view) return;

        // Destroy existing controller if it exists
        if (this.rotationController) {
            this.rotationController.destroy();
            this.rotationController = null;
        }

        // Only show rotation dropdown if we have video data
        if (!this.videoData) return;

        // Rotation options: display name -> degrees value
        const rotationOptions = {
            "0°": 0,
            "90° CW": 90,
            "180°": 180,
            "90° CCW": 270
        };

        // Get current rotation from video data
        this.currentRotation = this.videoData.userRotation || 0;

        this.rotationController = guiMenus.video.add(this, "currentRotation", rotationOptions)
            .name("Video Rotation")
            .onChange((value) => {
                if (this.videoData) {
                    this.videoData.setUserRotation(value);
                    this.positioned = false;  // Force layout recalculation
                    setRenderOne(true);
                }
            });
    }

    /**
     * Update rotation dropdown to reflect current video's rotation
     * Called when switching between videos
     */
    updateRotationDropdown() {
        if (this.rotationController && this.videoData) {
            this.currentRotation = this.videoData.userRotation || 0;
            this.rotationController.updateDisplay();
        }
    }

    async promptAddOrReplace() {
        return new Promise((resolve) => {
            const result = confirm(
                "A video/image is already loaded.\n\n" +
                "Click OK to ADD this as an additional video/image.\n" +
                "Click Cancel to REPLACE the current video/image."
            );
            resolve(result ? "add" : "replace");
        });
    }

    removeVideo(index) {
        if (index < 0 || index >= this.videos.length) return;

        const removedEntry = this.videos.splice(index, 1)[0];

        // Dispose the removed video's data
        if (removedEntry && removedEntry.videoData) {
            removedEntry.videoData.stopStreaming?.();
            removedEntry.videoData.dispose?.();
        }

        if (this.videos.length === 0) {
            this.currentVideoIndex = -1;
            this.videoData = null;
        } else if (this.currentVideoIndex >= this.videos.length) {
            this.currentVideoIndex = this.videos.length - 1;
            this.selectVideo(this.currentVideoIndex);
        } else if (index === this.currentVideoIndex) {
            this.selectVideo(this.currentVideoIndex);
        } else if (index < this.currentVideoIndex) {
            this.currentVideoIndex--;
        }

        this.updateVideoSelector();
    }

    disposeAllVideos() {
        for (const entry of this.videos) {
            if (entry.videoData) {
                entry.videoData.stopStreaming?.();
                entry.videoData.dispose?.();
            }
        }
        this.videos = [];
        this.currentVideoIndex = -1;
        this.videoData = null;
        this.updateVideoSelector();
    }

    /**
     * Synchronize audio playback with current video frame
     * Handles play/pause state changes and frame position jumps
     * @param {number} frame - Current video frame number
     */
    syncAudioWithVideo(frame) {
        if (!this.videoData || !this.videoData.audioHandler) {
            return;
        }

        const isPlaying = !par.paused;
        const frameChanged = Math.abs(frame - this.lastAudioSyncFrame) > 0.5;

        if (frameChanged || isPlaying !== this.wasPlayingLastFrame) {
            this.lastAudioSyncFrame = frame;
            this.wasPlayingLastFrame = isPlaying;

            if (isPlaying) {
                this.videoData.audioHandler.play(Math.floor(frame), Sit.fps);
            } else {
                this.videoData.audioHandler.pause();
            }
        }
    }

    /**
     * Clean up video view resources including video data and audio
     * Critical for stopping audio playback when switching views
     */
    dispose() {
        // Dispose of all video data including audio
        this.disposeAllVideos();
        // Call parent dispose
        super.dispose();
    }

    makeImageVideo(filename, img, deleteAfterUsing = false, imageFileID = undefined) {

        this.fileName = filename;

        this.videoData = new CVideoImageData({
            id: this.id + "_data_" + this.videos.length,
            filename: filename,
            img: img,
            deleteAfterUsing: deleteAfterUsing
        },
            this.loadedCallback.bind(this), this.errorCallback.bind(this))
        
        // Add to videos array immediately (not during restore - that's handled by continueVideoRestore)
        if (!this.pendingVideoRestore) {
            this.addVideoEntry(filename, undefined, true, imageFileID);
        }
        
        this.positioned = false;
        par.frame = 0;
        par.paused = false; // unpause, otherwise we see nothing.
        EventManager.dispatchEvent("videoLoaded", {
            width: img.width, height: img.height,
            videoData: this
        });
    }

    renderCanvas(frame = 0) {
        super.renderCanvas(frame); // needed for setting window size

        if (!this.visible) return;

        // if no video file, this is just a drop target for now
        if (!this.videoData) return;

        // While loading, don't render video - the loading message is shown via overlay
        if (this.videoLoadPending) return;

        this.syncAudioWithVideo(frame);

        const wantEcho = (this.in.echoMin?.value || this.in.echoMax?.value) &&
            (this.in.enableVideoEffects ? this.in.enableVideoEffects.v0 : true);
        this.videoData.echoFramesNeeded = wantEcho ? Math.round(this.in.echoFrames?.v0 ?? 10) : 0;

        this.videoData.update()
        this.updateCacheOverlay();
        const image = this.videoData.getImage(frame);
        if (this.videos.length > 1 && this._lastSwitchDebug) {
            const cachedCount = this.videoData?.imageCache?.filter(x => x && x.width > 0).length || 0;
            console.log(`[renderCanvas] frame=${frame}, image=`, image, 'cachedFrames:', cachedCount, '/', this.videoData?.imageCache?.length, 'groups:', this.videoData?.groups?.length);
            this._lastSwitchDebug = false;
        }
        if (image) {

            const ctx = this.ctx;

            // video width might change, for example, with the tiny images used by the old Gimbal video
            if (this.videoWidth !== image.width) {
                console.log("🍿🍿🍿Video width changed from " + this.videoWidth + " to " + image.width)
                this.videoData.videoWidth = image.width;
                this.videoData.videoHeight = image.height;
            }

            if (!this.positioned) {
                this.defaultPosition()
            }
            // positions are a PERCENTAGE OF THE WIDTH

            if (quickToggle("Smooth", false, guiVideoEffectsFolder) === false)
                ctx.imageSmoothingEnabled = false;

            var filter = ''
            const effectsEnabled = this.in.enableVideoEffects ? this.in.enableVideoEffects.v0 : true;

            let sourceImage = image;
            if (effectsEnabled && this.in.convolutionFilter && this.in.convolutionFilter.value !== 'none') {
                const filterType = this.in.convolutionFilter.value;
                const params = {
                    amount: this.in.sharpenAmount?.v0 ?? 1,
                    threshold: this.in.edgeDetectThreshold?.v0 ?? 0,
                    strength: (filterType === 'emboss' ? this.in.embossDepth?.v0 : 1) ?? 1
                };
                sourceImage = applyConvolutionToImage(image, filterType, params, this);
            }

            const hasFullABOverlay = this._fullABEchoResult && this.in.fullABEcho?.value;
            if (hasFullABOverlay && this._fullABEchoRunning) {
                sourceImage = this._fullABEchoResult;
            } else if (!hasFullABOverlay) {
                const wantEchoMin = this.in.echoMin?.value ?? false;
                const wantEchoMax = this.in.echoMax?.value ?? false;
                if (effectsEnabled && (wantEchoMin || wantEchoMax)) {
                    sourceImage = applyEchoEffect(this, sourceImage, frame, wantEchoMin, wantEchoMax);
                } else if (this._echoPixelCache) {
                    clearEchoCache(this);
                }
            }

            if (effectsEnabled) {
                if (this.in.contrast && this.in.contrast.v0 !== 1) {
                    filter += "contrast(" + this.in.contrast.v0 + ") "
                }
                if (this.in.brightness && this.in.brightness.v0 !== 1) {
                    filter += "brightness(" + this.in.brightness.v0 + ") "
                }
                if (this.in.blur && this.in.blur.v0 !== 0) {
                    filter += "blur(" + this.in.blur.v0 + "px) "
                }
                if (this.in.greyscale && this.in.greyscale.v0 !== 0) {
                    filter += "grayscale(" + this.in.greyscale.v0 + ") "
                }
                if (this.in.hue && this.in.hue.v0 !== 0) {
                    filter += "hue-rotate(" + this.in.hue.v0 + "deg) "
                }
                if (this.in.invert && this.in.invert.v0 !== 0) {
                    filter += "invert(" + this.in.invert.v0 + ") "
                }
                if (this.in.saturate && this.in.saturate.v0 !== 1) {
                    filter += "saturate(" + this.in.saturate.v0 + ") "
                }
            }

            ctx.filter = filter || 'none';

            const sourceW = this.videoWidth;
            const sourceH = this.videoHeight
            // rendering fill the view in at least one direction
            const aspectSource = sourceW / sourceH
            const aspectView = this.widthPx / this.heightPx

            const flowRotation = getFlowAlignRotation(frame);
            if (flowRotation !== 0) {
                ctx.save();
                ctx.translate(this.widthPx / 2, this.heightPx / 2);
                ctx.rotate(flowRotation);
                ctx.translate(-this.widthPx / 2, -this.heightPx / 2);
            }

            // TODO - combine this zoom input with the mouse zoom
            if (this.in.zoom !== undefined) {

                this.getSourceAndDestCoords();
                ctx.drawImage(sourceImage, this.sx, this.sy, this.sWidth, this.sHeight,
                    this.dx, this.dy, this.dWidth, this.dHeight);

            } else {
                // Here the zoom is being controlled by zoomView
                // which zooming in and out around the mouse
                ctx.drawImage(sourceImage,
                    0, 0, this.videoWidth, this.videoHeight,
                    this.widthPx * (0.5 + this.posLeft), this.heightPx * 0.5 + this.widthPx * this.posTop,
                    this.widthPx * (this.posRight - this.posLeft), this.widthPx * (this.posBot - this.posTop))
                ctx.imageSmoothingEnabled = true;

            }

            if (hasFullABOverlay && !this._fullABEchoRunning) {
                const opacity = (this.in.fullABEchoOpacity?.v0 ?? 100) / 100;
                ctx.save();
                ctx.filter = 'none';
                ctx.globalAlpha = opacity;
                if (this.in.zoom !== undefined) {
                    ctx.drawImage(this._fullABEchoResult, this.sx, this.sy, this.sWidth, this.sHeight,
                        this.dx, this.dy, this.dWidth, this.dHeight);
                } else {
                    ctx.drawImage(this._fullABEchoResult,
                        0, 0, this.videoWidth, this.videoHeight,
                        this.widthPx * (0.5 + this.posLeft), this.heightPx * 0.5 + this.widthPx * this.posTop,
                        this.widthPx * (this.posRight - this.posLeft), this.widthPx * (this.posBot - this.posTop));
                }
                ctx.restore();
            }

            if (flowRotation !== 0) {
                ctx.restore();
            }



            ctx.filter = 'none';


        }

        this.drawCrosshairIfKeyHeld();
    }


    restartFullABEchoIfActive() {
        if (!this.in.fullABEcho?.value) return;
        if (this._fullABEchoRunning) {
            this._fullABEchoRunning = false;
            Globals.justVideoAnalysis = false;
            par.paused = this._fullABEchoSavedPaused ?? false;
        }
        this._fullABEchoResult = null;

        const wantMin = this.in.echoMin?.value ?? false;
        const wantMax = this.in.echoMax?.value ?? false;
        if (!wantMin && !wantMax) {
            setRenderOne(true);
            return;
        }

        this.startFullABEcho();
    }

    startFullABEcho() {
        if (this._fullABEchoRunning) return;
        if (!this.videoData) return;

        const wantMin = this.in.echoMin?.value ?? false;
        const wantMax = this.in.echoMax?.value ?? false;
        if (!wantMin && !wantMax) return;

        this._fullABEchoRunning = true;
        this._fullABEchoSavedPaused = par.paused;
        this._fullABEchoSavedFrame = par.frame;
        par.paused = true;
        Globals.justVideoAnalysis = true;

        this.runFullABEchoLoop();
    }

    stopFullABEcho() {
        this._fullABEchoRunning = false;
        Globals.justVideoAnalysis = false;
        this._fullABEchoMinPixels = null;
        this._fullABEchoMaxPixels = null;
        this._fullABEchoSumPixels = null;
        this._fullABEchoResult = null;
        par.paused = this._fullABEchoSavedPaused ?? false;
        setRenderOne(true);
    }

    async runFullABEchoLoop() {
        const aFrame = Sit.aFrame ?? 0;
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const videoData = this.videoData;

        if (!videoData) {
            this.onFullABEchoComplete();
            return;
        }

        const wantMin = this.in.echoMin?.value ?? false;
        const wantMax = this.in.echoMax?.value ?? false;

        let width = 0, height = 0, pixelCount = 0;
        let minPixels = null, maxPixels = null, sumPixels = null;
        let frameCount = 0;
        let initialized = false;

        if (!this._fullABEchoCanvas) {
            this._fullABEchoCanvas = document.createElement('canvas');
            this._fullABEchoCtx = this._fullABEchoCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (!this._fullABEchoTmpCanvas) {
            this._fullABEchoTmpCanvas = document.createElement('canvas');
            this._fullABEchoTmpCtx = this._fullABEchoTmpCanvas.getContext('2d', { willReadFrequently: true });
        }

        const targetRenderInterval = 40;
        let lastRenderTime = performance.now();

        for (let f = aFrame; f <= bFrame; f++) {
            if (!this._fullABEchoRunning) return;

            par.frame = f;

            videoData.getImage(f);
            if (videoData.waitForFrame) {
                await videoData.waitForFrame(f, 5000);
            }

            const frameImage = videoData.getImage(f);
            if (!frameImage || frameImage.width === 0) continue;

            if (!initialized) {
                width = frameImage.width;
                height = frameImage.height;
                pixelCount = width * height * 4;
                this._fullABEchoCanvas.width = width;
                this._fullABEchoCanvas.height = height;
                this._fullABEchoTmpCanvas.width = width;
                this._fullABEchoTmpCanvas.height = height;
                minPixels = wantMin ? new Uint8ClampedArray(pixelCount) : null;
                maxPixels = wantMax ? new Uint8ClampedArray(pixelCount) : null;
                sumPixels = (wantMin && wantMax) ? new Float32Array(pixelCount) : null;
            }

            this._fullABEchoTmpCtx.drawImage(frameImage, 0, 0, width, height);
            const frameData = this._fullABEchoTmpCtx.getImageData(0, 0, width, height).data;

            if (!initialized) {
                if (minPixels) minPixels.set(frameData);
                if (maxPixels) maxPixels.set(frameData);
                if (sumPixels) { for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i]; }
                initialized = true;
            } else {
                for (let i = 0; i < pixelCount; i += 4) {
                    for (let c = 0; c < 3; c++) {
                        const idx = i + c;
                        const val = frameData[idx];
                        if (minPixels && val < minPixels[idx]) minPixels[idx] = val;
                        if (maxPixels && val > maxPixels[idx]) maxPixels[idx] = val;
                        if (sumPixels) sumPixels[idx] += val;
                    }
                    if (minPixels) minPixels[i + 3] = 255;
                    if (maxPixels) maxPixels[i + 3] = 255;
                }
            }
            frameCount++;

            const framesProcessed = f - aFrame + 1;
            const now = performance.now();
            const shouldRender = (framesProcessed % 10 === 0) || (f === bFrame) || (now - lastRenderTime >= targetRenderInterval);

            if (shouldRender && initialized) {
                this.buildFullABEchoResult(wantMin, wantMax, minPixels, maxPixels, sumPixels, frameCount, width, height);
                this.renderCanvas(f);
                lastRenderTime = performance.now();
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (initialized) {
            this.buildFullABEchoResult(wantMin, wantMax, minPixels, maxPixels, sumPixels, frameCount, width, height);
        }

        this.onFullABEchoComplete(bFrame);
    }

    buildFullABEchoResult(wantMin, wantMax, minPixels, maxPixels, sumPixels, frameCount, width, height) {
        const pixelCount = width * height * 4;
        let resultPixels;
        if (wantMin && wantMax) {
            resultPixels = new Uint8ClampedArray(pixelCount);
            for (let i = 0; i < pixelCount; i += 4) {
                for (let c = 0; c < 3; c++) {
                    const idx = i + c;
                    const avg = sumPixels[idx] / frameCount;
                    const minDev = Math.abs(minPixels[idx] - avg);
                    const maxDev = Math.abs(maxPixels[idx] - avg);
                    resultPixels[idx] = (maxDev >= minDev) ? maxPixels[idx] : minPixels[idx];
                }
                resultPixels[i + 3] = 255;
            }
        } else if (wantMin) {
            resultPixels = new Uint8ClampedArray(minPixels);
        } else {
            resultPixels = new Uint8ClampedArray(maxPixels);
        }
        const outputData = new ImageData(resultPixels, width, height);
        this._fullABEchoCtx.putImageData(outputData, 0, 0);
        this._fullABEchoResult = this._fullABEchoCanvas;
    }

    onFullABEchoComplete(bFrame) {
        this._fullABEchoRunning = false;
        Globals.justVideoAnalysis = false;
        par.paused = this._fullABEchoSavedPaused ?? false;
        if (bFrame !== undefined) {
            par.frame = bFrame;
        }
        setRenderOne(true);
    }

    // so we need to account for the mouse position, in this fractional system
    zoomView(scale) {
        var offX = (this.mouse.anchorX - this.widthPx / 2) / this.widthPx;
        var offY = (this.mouse.anchorY - this.heightPx / 2) / this.widthPx;

        this.posLeft -= offX;
        this.posRight -= offX;
        this.posTop -= offY;
        this.posBot -= offY;

        this.posLeft *= scale;
        this.posRight *= scale;
        this.posTop *= scale;
        this.posBot *= scale;

        this.posLeft += offX;
        this.posRight += offX;
        this.posTop += offY;
        this.posBot += offY;

        setRenderOne(true);
    }

    defaultPosition() {
        const sourceW = this.videoWidth;
        const sourceH = this.videoHeight
        // rendering fill the view in at least one direction
        const aspectSource = sourceW / sourceH
        const aspectView = this.widthPx / this.heightPx

        if (aspectSource > aspectView) {
            // fill for width
            this.posLeft = -0.5;
            this.posTop = this.posLeft / aspectSource;
        } else {
            // fill to height
            //this.posTop = -0.5;
            //this.posLeft = -0.5*sourceW/sourceH;

            // we want to distance to the top as a percentage of the width
            this.posTop = -0.5 / aspectView

            this.posLeft = this.posTop * aspectSource;

        }
        this.posRight = -this.posLeft;
        this.posBot = -this.posTop;
        this.positioned = true;
        setRenderOne(true);
    }


    // as per https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage

    getSourceAndDestCoords() {
        // Ensure dimensions are current - important when overlays call this before the video view renders
        if (this.div && (this.widthPx !== this.div.clientWidth || this.heightPx !== this.div.clientHeight)) {
            this.setFromDiv(this.div);
        }

        // videoWidth and videoHeight are the original video dimensions
        let sourceW = this.videoWidth;
        let sourceH = this.videoHeight

        if (sourceW <= 0 || sourceH <= 0) {
            sourceW = this.widthPx;
            sourceH = this.heightPx;
        }

        const aspectSource = sourceW / sourceH
        const aspectView = this.widthPx / this.heightPx

        if (this.in.zoom !== undefined) {
            const zoom = this.in.zoom.v0 / 100;

            const offsetW = (sourceW - sourceW / zoom) / 2;
            const offsetH = (sourceH - sourceH / zoom) / 2;

            this.sx = offsetW;
            this.sy = offsetH;
            this.sWidth = sourceW / zoom;
            this.sHeight = sourceH / zoom;

            if (aspectSource > aspectView) {
                this.fovCoverage = (this.widthPx / aspectSource) / this.heightPx;
                this.dx = 0;
                this.dy = (this.heightPx - this.widthPx / aspectSource) / 2;
                this.dWidth = this.widthPx;
                this.dHeight = this.widthPx / aspectSource;
            } else {
                this.fovCoverage = 1;
                this.dx = (this.widthPx - this.heightPx * aspectSource) / 2;
                this.dy = 0;
                this.dWidth = this.heightPx * aspectSource;
                this.dHeight = this.heightPx;
            }
        } else {
            this.sx = 0;
            this.sy = 0;
            this.sWidth = sourceW;
            this.sHeight = sourceH;
            this.dx = this.widthPx * (0.5 + this.posLeft);
            this.dy = this.heightPx * 0.5 + this.widthPx * this.posTop;
            assert(this.posRight !== undefined, "posRight is undefined in getSourceAndDestCoords, this=" + this.id);
            this.dWidth = this.widthPx * (this.posRight - this.posLeft);
            this.dHeight = this.widthPx * (this.posBot - this.posTop);
            this.fovCoverage = this.dHeight / this.heightPx;
        }
        assert(!isNaN(this.dWidth) && !isNaN(this.dHeight), "getSourceAndDestCoords returned NaN for dWidth or dHeight, this=" + this.id);

    }

    /**
     * Convert a canvas x,y point to relative video coordinates vX, vY
     * Returns values that can be outside [0,1]
     */
    canvasToVideoCoords(x, y) {
        this.getSourceAndDestCoords()

        // we have the source and destination coordinates s and d
        // as in // ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
        // so we can calculate the relative video coordinates
        const vX = (x - this.dx) / this.dWidth * this.sWidth + this.sx;
        const vY = (y - this.dy) / this.dHeight * this.sHeight + this.sy;
        // return as video pixels, not canvas pixels
        return [vX, vY];


    }

    // and the inverse, convert video coordinates to canvas coordinates
    videoToCanvasCoords(vX, vY) {
        this.getSourceAndDestCoords()

        // we have the source and destination coordinates s and d
        // as in // ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
        // so we can calculate the relative video coordinates
        const cX = (vX - this.sx) / this.sWidth * this.dWidth + this.dx;
        const cY = (vY - this.sy) / this.sHeight * this.dHeight + this.dy;
        // return as canvas pixels
        return [cX, cY];
    }

    /**
     * Convert canvas coordinates to ORIGINAL video coordinates.
     * Used for tracking/analysis to ensure coordinates are resolution-independent.
     * Keyframes should be stored in original video coordinates.
     */
    canvasToVideoCoordsOriginal(x, y) {
        // First convert to display video coordinates
        const [displayX, displayY] = this.canvasToVideoCoords(x, y);

        // Scale from display to original coordinates
        const scaleX = this.originalVideoWidth / this.videoWidth;
        const scaleY = this.originalVideoHeight / this.videoHeight;

        return [displayX * scaleX, displayY * scaleY];
    }

    /**
     * Convert ORIGINAL video coordinates to canvas coordinates.
     * Used for tracking/analysis to render overlays and calculate LOS.
     * Keyframes stored in original coordinates are converted for display.
     */
    videoToCanvasCoordsOriginal(vX, vY) {
        // Scale from original to display coordinates
        const scaleX = this.videoWidth / this.originalVideoWidth;
        const scaleY = this.videoHeight / this.originalVideoHeight;

        const displayX = vX * scaleX;
        const displayY = vY * scaleY;

        // Then convert display video coordinates to canvas
        return this.videoToCanvasCoords(displayX, displayY);
    }

    updateCacheOverlay() {
        const frameSlider = NodeMan.get("FrameSlider", false);
        if (!frameSlider) return;

        const showingCache = this.in.showCache?.value ?? false;
        if (!showingCache) {
            if (frameSlider.statusOverlay || frameSlider.groupOverlay) {
                frameSlider.statusOverlay = null;
                frameSlider.groupOverlay = null;
                frameSlider.needsCanvasRedraw = true;
            }
            return;
        }

        const vd = this.videoData;
        const cache = vd?.imageCache;
        if (!cache) return;

        const totalFrames = Sit.frames;
        if (!frameSlider.statusOverlay || frameSlider.statusOverlay.length !== totalFrames) {
            frameSlider.statusOverlay = new Uint8Array(totalFrames);
        }

        let changed = false;
        for (let i = 0; i < totalFrames; i++) {
            const loaded = (cache[i] && cache[i].width > 0) ? 1 : 0;
            if (frameSlider.statusOverlay[i] !== loaded) {
                frameSlider.statusOverlay[i] = loaded;
                changed = true;
            }
        }

        if (vd.groups && vd.groups.length > 0) {
            const newGroupOverlay = [];
            for (const group of vd.groups) {
                let status;
                if (group.pending > 0) {
                    status = 'requested';
                } else if (group.loaded) {
                    let allCached = true;
                    for (let i = group.frame; i < group.frame + group.length; i++) {
                        if (!cache[i] || !cache[i].width) { allCached = false; break; }
                    }
                    status = allCached ? 'cached' : 'partial';
                } else {
                    let anyCached = false;
                    for (let i = group.frame; i < group.frame + group.length; i++) {
                        if (cache[i] && cache[i].width > 0) { anyCached = true; break; }
                    }
                    status = anyCached ? 'partial' : null;
                }
                if (status) {
                    newGroupOverlay.push({ start: group.frame, end: group.frame + group.length, status });
                }
            }
            const newJSON = JSON.stringify(newGroupOverlay);
            if (newJSON !== this._lastGroupOverlayJSON) {
                frameSlider.groupOverlay = newGroupOverlay;
                this._lastGroupOverlayJSON = newJSON;
                changed = true;
            }
        }

        if (changed) {
            frameSlider.needsCanvasRedraw = true;
        }
    }

}

let guiVideoEffectsFolder = null;

export function addFiltersToVideoNode(videoNode) {

    if (guiVideoEffectsFolder === null) {
        guiVideoEffectsFolder = guiMenus.video.addFolder("Video Adjustments").close().perm();
    }

    let brightness, contrast, blur, greyscale, hue, invert, saturate, enableVideoEffects, convolutionFilter;
    let sharpenAmount, edgeDetectThreshold, embossDepth;
    let echoMin, echoMax, echoFrames, fullABEcho, fullABEchoOpacity;
    let showCache;
    let convolutionFilterDropdown, sharpenAmountControl, edgeDetectThresholdControl, embossDepthControl;

    const filterOptions = {
        convolutionFilterValue: 'none'
    };

    const updateConvolutionControlVisibility = () => {
        const filterType = filterOptions.convolutionFilterValue;
        sharpenAmount?.show(filterType === 'sharpen');
        edgeDetectThreshold?.show(filterType === 'edgeDetect');
        embossDepth?.show(filterType === 'emboss');
    };

    const reset = {
        resetFilters: () => {
            videoNode.inputs.brightness.value = 1;
            videoNode.inputs.contrast.value = 1;
            videoNode.inputs.blur.value = 0;
            videoNode.inputs.greyscale.value = 0;
            videoNode.inputs.hue.value = 0;
            videoNode.inputs.invert.value = 0;
            videoNode.inputs.saturate.value = 1;
            if (videoNode.inputs.enableVideoEffects) {
                videoNode.inputs.enableVideoEffects.value = true;
            }
            filterOptions.convolutionFilterValue = 'none';
            if (videoNode.inputs.sharpenAmount) videoNode.inputs.sharpenAmount.value = 1;
            if (videoNode.inputs.edgeDetectThreshold) videoNode.inputs.edgeDetectThreshold.value = 0;
            if (videoNode.inputs.embossDepth) videoNode.inputs.embossDepth.value = 1;
            if (videoNode.inputs.echoMin) videoNode.inputs.echoMin.value = false;
            if (videoNode.inputs.echoMax) videoNode.inputs.echoMax.value = false;
            if (videoNode.inputs.echoFrames) videoNode.inputs.echoFrames.value = 10;
            if (videoNode.inputs.fullABEcho) videoNode.inputs.fullABEcho.value = false;
            if (videoNode.inputs.fullABEchoOpacity) videoNode.inputs.fullABEchoOpacity.value = 100;
            if (videoNode.inputs.showCache) videoNode.inputs.showCache.value = false;
            updateConvolutionControlVisibility();
            setRenderOne(true);
        }
    }

    if (!NodeMan.exists("videoBrightness")) {
        brightness = new CNodeGUIValue({ id: "videoBrightness", value: 1, start: 0, end: 5, step: 0.01, desc: "Brightness" }, guiVideoEffectsFolder),
            contrast = new CNodeGUIValue({ id: "videoContrast", value: 1, start: 0, end: 5, step: 0.01, desc: "Contrast" }, guiVideoEffectsFolder),
            blur = new CNodeGUIValue({ id: "videoBlur", value: 0, start: 0, end: 200, step: 1, desc: "Blur Px" }, guiVideoEffectsFolder),
            greyscale = new CNodeGUIValue({ id: "videoGreyscale", value: 0, start: 0, end: 1, step: 0.01, desc: "Greyscale" }, guiVideoEffectsFolder),
            hue = new CNodeGUIValue({ id: "videoHue", value: 0, start: 0, end: 360, step: 1, desc: "Hue Rotate" }, guiVideoEffectsFolder),
            invert = new CNodeGUIValue({ id: "videoInvert", value: 0, start: 0, end: 1, step: 0.01, desc: "Invert" }, guiVideoEffectsFolder),
            saturate = new CNodeGUIValue({ id: "videoSaturate", value: 1, start: 0, end: 5, step: 0.01, desc: "Saturate" }, guiVideoEffectsFolder),
            enableVideoEffects = new CNodeGUIFlag({ id: "videoEnableEffects", value: true, desc: "Enable Video Effects" }, guiVideoEffectsFolder),
            sharpenAmount = new CNodeGUIValue({ id: "videoSharpenAmount", value: 1, start: 0, end: 5, step: 0.1, desc: "Sharpen Amount" }, guiVideoEffectsFolder),
            edgeDetectThreshold = new CNodeGUIValue({ id: "videoEdgeDetectThreshold", value: 0, start: 0, end: 255, step: 1, desc: "Edge Threshold" }, guiVideoEffectsFolder),
            embossDepth = new CNodeGUIValue({ id: "videoEmbossDepth", value: 1, start: 0, end: 3, step: 0.1, desc: "Emboss Depth" }, guiVideoEffectsFolder),
            echoMin = new CNodeGUIFlag({ id: "videoEchoMin", value: false, desc: "Echo Dark", onChange: () => {
                videoNode.restartFullABEchoIfActive();
            }}, guiVideoEffectsFolder),
            echoMax = new CNodeGUIFlag({ id: "videoEchoMax", value: false, desc: "Echo Light", onChange: () => {
                videoNode.restartFullABEchoIfActive();
            }}, guiVideoEffectsFolder),
            echoFrames = new CNodeGUIValue({ id: "videoEchoFrames", value: 10, start: 2, end: 100, step: 1, desc: "Echo Frames" }, guiVideoEffectsFolder),
            fullABEcho = new CNodeGUIFlag({ id: "videoFullABEcho", value: false, desc: "Full A-B Echo", onChange: () => {
                if (fullABEcho.value) {
                    if (!echoMin.value && !echoMax.value) {
                        echoMax.value = true;
                    }
                    videoNode.startFullABEcho();
                } else {
                    videoNode.stopFullABEcho();
                }
            }}, guiVideoEffectsFolder),
            fullABEchoOpacity = new CNodeGUIValue({ id: "videoFullABEchoOpacity", value: 100, start: 0, end: 100, step: 1, desc: "A-B Echo Opacity %" }, guiVideoEffectsFolder),
            showCache = new CNodeGUIFlag({ id: "videoShowCache", value: false, desc: "Show Cache" }, guiVideoEffectsFolder),
            convolutionFilter = new CNodeConstant({ id: "videoConvolutionFilter", value: 'none' }),
            convolutionFilterDropdown = guiVideoEffectsFolder.add(filterOptions, "convolutionFilterValue", ['none', 'sharpen', 'edgeDetect', 'emboss']).name("Convolution Filter").onChange(value => {
                convolutionFilter.value = value;
                updateConvolutionControlVisibility();
                setRenderOne(true);
            }),
            sharpenAmountControl = sharpenAmount.guiEntry,
            edgeDetectThresholdControl = edgeDetectThreshold.guiEntry,
            embossDepthControl = embossDepth.guiEntry,
            updateConvolutionControlVisibility(),
            guiVideoEffectsFolder.add(reset, "resetFilters").name("Reset Video Adjustments")
    } else {
        brightness = NodeMan.get("videoBrightness");
        contrast = NodeMan.get("videoContrast");
        blur = NodeMan.get("videoBlur");
        greyscale = NodeMan.get("videoGreyscale");
        hue = NodeMan.get("videoHue");
        invert = NodeMan.get("videoInvert");
        saturate = NodeMan.get("videoSaturate");
        enableVideoEffects = NodeMan.get("videoEnableEffects");
        sharpenAmount = NodeMan.get("videoSharpenAmount");
        edgeDetectThreshold = NodeMan.get("videoEdgeDetectThreshold");
        embossDepth = NodeMan.get("videoEmbossDepth");
        echoMin = NodeMan.get("videoEchoMin");
        echoMax = NodeMan.get("videoEchoMax");
        echoFrames = NodeMan.get("videoEchoFrames");
        fullABEcho = NodeMan.get("videoFullABEcho");
        fullABEchoOpacity = NodeMan.get("videoFullABEchoOpacity");
        showCache = NodeMan.get("videoShowCache");
        convolutionFilter = NodeMan.get("videoConvolutionFilter");
        if (convolutionFilter) {
            filterOptions.convolutionFilterValue = convolutionFilter.value;
        }
        sharpenAmountControl = sharpenAmount?.guiEntry;
        edgeDetectThresholdControl = edgeDetectThreshold?.guiEntry;
        embossDepthControl = embossDepth?.guiEntry;
        updateConvolutionControlVisibility();
    }


    videoNode.addMoreInputs({
        brightness: brightness,
        contrast: contrast,
        blur: blur,
        greyscale: greyscale,
        hue: hue,
        invert: invert,
        saturate: saturate,
        enableVideoEffects: enableVideoEffects,
        convolutionFilter: convolutionFilter,
        sharpenAmount: sharpenAmount,
        edgeDetectThreshold: edgeDetectThreshold,
        embossDepth: embossDepth,
        echoMin: echoMin,
        echoMax: echoMax,
        echoFrames: echoFrames,
        fullABEcho: fullABEcho,
        fullABEchoOpacity: fullABEchoOpacity,
        showCache: showCache
    });

    EventManager.addEventListener("abFrameChanged", () => {
        videoNode.restartFullABEchoIfActive();
    });

    if (!NodeMan.exists("videoGridOverlay")) {
        const gridFolder = guiMenus.video.addFolder("Grid").close();

        const gridOverlay = new CNodeGridOverlay({
            id: "videoGridOverlay",
            overlayView: videoNode,
        });

        gridFolder.add(gridOverlay, "gridShow").name("Show").listen().onChange((value) => {
            gridOverlay.setShow(value);
        });

        gridFolder.add(gridOverlay, "gridSize", 1, 128, 0.1).name("Size").listen().onChange(() => {
            setRenderOne(true);
        });

        gridFolder.add(gridOverlay, "gridSubdivisions", 1, 16, 1).name("Subdivisions").listen().onChange(() => {
            setRenderOne(true);
        });

        gridFolder.add(gridOverlay, "gridXOffset", 0,127,0.1).name("X Offset").listen().onChange(() => {
            setRenderOne(true);
        });

        gridFolder.add(gridOverlay, "gridYOffset",0,127,0.1).name("Y Offset").listen().onChange(() => {
            setRenderOne(true);
        });

        gridFolder.addColor(gridOverlay, "gridColor").name("Color").listen().onChange(() => {
            setRenderOne(true);
        });
    }

}

const CONVOLUTION_KERNELS = {
    none: { kernel: null, divisor: 1, offset: 0 },
    sharpen: {
        kernel: [
            0, -1, 0,
            -1, 5, -1,
            0, -1, 0
        ],
        divisor: 1,
        offset: 0
    },
    edgeDetect: {
        kernel: [
            -1, -1, -1,
            -1, 8, -1,
            -1, -1, -1
        ],
        divisor: 1,
        offset: 0
    },
    emboss: {
        kernel: [
            -2, -1, 0,
            -1, 1, 1,
            0, 1, 2
        ],
        divisor: 1,
        offset: 128
    }
};

export function applyConvolution(ctx, width, height, kernelName, params = {}) {
    if (kernelName === 'none' || !CONVOLUTION_KERNELS[kernelName]) return;

    let { kernel, divisor, offset } = CONVOLUTION_KERNELS[kernelName];
    if (!kernel) return;

    const amount = params.amount ?? 1;
    const threshold = params.threshold ?? 0;
    const strength = params.strength ?? 1;

    if (kernelName === 'sharpen') {
        kernel = [
            0, -1 * amount, 0,
            -1 * amount, 5 * amount, -1 * amount,
            0, -1 * amount, 0
        ];
        divisor = 1;
    } else if (kernelName === 'emboss') {
        const d = strength;
        kernel = [
            -2 * d, -1 * d, 0,
            -1 * d, 1 * d, 1 * d,
            0, 1 * d, 2 * d
        ];
        divisor = 1;
        offset = 128;
    }

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const output = new Uint8ClampedArray(data.length);

    const w = width;
    const h = height;

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const px = x + kx;
                        const py = y + ky;
                        const idx = (py * w + px) * 4 + c;
                        const kidx = (ky + 1) * 3 + (kx + 1);
                        sum += data[idx] * kernel[kidx];
                    }
                }
                const val = sum / divisor + offset;
                if (kernelName === 'edgeDetect') {
                    output[(y * w + x) * 4 + c] = val > threshold ? 255 : 0;
                } else {
                    output[(y * w + x) * 4 + c] = Math.min(255, Math.max(0, val));
                }
            }
            output[((y * w + x) * 4 + 3)] = data[((y * w + x) * 4 + 3)];
        }
    }

    for (let i = 0; i < data.length; i += 4) {
        if (output[i] !== 0 || output[i + 1] !== 0 || output[i + 2] !== 0 || output[i + 3] !== 0) {
            data[i] = output[i];
            data[i + 1] = output[i + 1];
            data[i + 2] = output[i + 2];
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

function getOrCachePixelData(videoView, frameImage, frame, width, height) {
    if (!videoView._echoPixelCache) {
        videoView._echoPixelCache = new Map();
    }

    const cached = videoView._echoPixelCache.get(frame);
    if (cached && cached.length === width * height * 4) {
        return cached;
    }

    const tmpCtx = videoView._echoTmpCtx;
    tmpCtx.drawImage(frameImage, 0, 0, width, height);
    const data = tmpCtx.getImageData(0, 0, width, height).data;
    videoView._echoPixelCache.set(frame, data);
    return data;
}

function pruneEchoPixelCache(videoView, startFrame, endFrame) {
    if (!videoView._echoPixelCache) return;
    for (const key of videoView._echoPixelCache.keys()) {
        if (key < startFrame || key > endFrame) {
            videoView._echoPixelCache.delete(key);
        }
    }
}

function clearEchoCache(videoView) {
    if (videoView._echoPixelCache) {
        videoView._echoPixelCache.clear();
    }
    videoView._lastEchoFrame = undefined;
    videoView._lastEchoResult = undefined;
    videoView._lastEchoWantMin = undefined;
    videoView._lastEchoWantMax = undefined;
    videoView._lastEchoNumFrames = undefined;
}

function applyEchoEffect(videoView, currentImage, currentFrame, wantMin, wantMax) {
    const numEchoFrames = Math.round(videoView.in.echoFrames?.v0 ?? 10);
    const startFrame = Math.max(0, currentFrame - numEchoFrames + 1);
    const width = currentImage.width;
    const height = currentImage.height;

    if (!videoView._echoCanvas || videoView._echoCanvas.width !== width || videoView._echoCanvas.height !== height) {
        videoView._echoCanvas = document.createElement('canvas');
        videoView._echoCanvas.width = width;
        videoView._echoCanvas.height = height;
        videoView._echoCtx = videoView._echoCanvas.getContext('2d', { willReadFrequently: true });
        videoView._echoTmpCanvas = document.createElement('canvas');
        videoView._echoTmpCanvas.width = width;
        videoView._echoTmpCanvas.height = height;
        videoView._echoTmpCtx = videoView._echoTmpCanvas.getContext('2d', { willReadFrequently: true });
        clearEchoCache(videoView);
    }

    if (videoView._lastEchoFrame === currentFrame &&
        videoView._lastEchoWantMin === wantMin &&
        videoView._lastEchoWantMax === wantMax &&
        videoView._lastEchoNumFrames === numEchoFrames &&
        videoView._lastEchoResult) {
        return videoView._lastEchoResult;
    }

    const echoCtx = videoView._echoCtx;

    const pixelCount = width * height * 4;
    const minPixels = wantMin ? new Uint8ClampedArray(pixelCount) : null;
    const maxPixels = wantMax ? new Uint8ClampedArray(pixelCount) : null;
    const sumPixels = (wantMin && wantMax) ? new Float32Array(pixelCount) : null;
    let frameCount = 0;
    let initialized = false;

    for (let f = startFrame; f <= currentFrame; f++) {
        let frameImage;
        if (f === currentFrame) {
            frameImage = currentImage;
        } else {
            frameImage = videoView.videoData.getCachedImage(f);
        }
        if (!frameImage || frameImage.width === 0) continue;

        const frameData = getOrCachePixelData(videoView, frameImage, f, width, height);

        if (!initialized) {
            if (minPixels) minPixels.set(frameData);
            if (maxPixels) maxPixels.set(frameData);
            if (sumPixels) { for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i]; }
            initialized = true;
        } else {
            for (let i = 0; i < pixelCount; i += 4) {
                for (let c = 0; c < 3; c++) {
                    const idx = i + c;
                    const val = frameData[idx];
                    if (minPixels && val < minPixels[idx]) minPixels[idx] = val;
                    if (maxPixels && val > maxPixels[idx]) maxPixels[idx] = val;
                    if (sumPixels) sumPixels[idx] += val;
                }
                if (minPixels) minPixels[i + 3] = 255;
                if (maxPixels) maxPixels[i + 3] = 255;
            }
        }
        frameCount++;
    }

    pruneEchoPixelCache(videoView, startFrame, currentFrame);

    if (!initialized) return currentImage;

    let resultPixels;
    if (wantMin && wantMax) {
        resultPixels = new Uint8ClampedArray(pixelCount);
        for (let i = 0; i < pixelCount; i += 4) {
            for (let c = 0; c < 3; c++) {
                const idx = i + c;
                const avg = sumPixels[idx] / frameCount;
                const minDev = Math.abs(minPixels[idx] - avg);
                const maxDev = Math.abs(maxPixels[idx] - avg);
                resultPixels[idx] = (maxDev >= minDev) ? maxPixels[idx] : minPixels[idx];
            }
            resultPixels[i + 3] = 255;
        }
    } else if (wantMin) {
        resultPixels = minPixels;
    } else {
        resultPixels = maxPixels;
    }

    const outputData = new ImageData(resultPixels, width, height);
    echoCtx.putImageData(outputData, 0, 0);

    videoView._lastEchoFrame = currentFrame;
    videoView._lastEchoWantMin = wantMin;
    videoView._lastEchoWantMax = wantMax;
    videoView._lastEchoNumFrames = numEchoFrames;
    videoView._lastEchoResult = videoView._echoCanvas;

    return videoView._echoCanvas;
}

function applyConvolutionToImage(image, kernelName, params, videoView) {
    if (kernelName === 'none' || !CONVOLUTION_KERNELS[kernelName]) return image;

    const width = image.width;
    const height = image.height;

    if (!videoView._convolutionCanvas || 
        videoView._convolutionCanvas.width !== width || 
        videoView._convolutionCanvas.height !== height) {
        videoView._convolutionCanvas = document.createElement('canvas');
        videoView._convolutionCanvas.width = width;
        videoView._convolutionCanvas.height = height;
        videoView._convolutionCtx = videoView._convolutionCanvas.getContext('2d');
    }

    const ctx = videoView._convolutionCtx;
    ctx.drawImage(image, 0, 0);
    applyConvolution(ctx, width, height, kernelName, params);
    return videoView._convolutionCanvas;
}