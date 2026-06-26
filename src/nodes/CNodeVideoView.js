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
 * - Resolves Sitrec object references to temporary fetch URLs while preserving stable refs for serialization
 * 
 * Mouse controls:
 * - Wheel: Zoom in/out
 * - Left drag: Pan video
 * - Right drag: Scrub through frames
 * - Middle drag: Zoom
 * - Double click: Reset to default position
 * 
 * Video effects (optional inputs):
 * - brightness, contrast, blur
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
import {CustomManager, Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {CMouseHandler} from "../CMouseHandler";
import {CNodeViewUI} from "./CNodeViewUI";
import {CVideoMp4Data} from "../CVideoMp4Data";
import {CVideoH264Data} from "../CVideoH264Data";
import {CVideoAudioOnly} from "../CVideoAudioOnly";
import {CVideoImageData} from "../CVideoImageData";
import {CVideoPatchedData} from "../CVideoPatchedData";
import {isAudioOnlyFormat} from "../AudioFormats";
import {getFileExtension} from "../utils";
import {assert} from "../assert";
import {EventManager} from "../CEventManager";
import {getFlowAlignRotation} from "../FlowAlignment";
import {VideoLoadingManager} from "../CVideoLoadingManager";
import {updateSitFrames} from "../UpdateSitFrames";
import {applyImportedImageMetadata, extractJPEGImportMetadata} from "../EXIFUtils";
import {EXIFInfoPanel} from "../EXIFInfoPanel";
import {isResolvableSitrecReference, resolveURLForFetch} from "../SitrecObjectResolver";
import {t} from "../i18n";
import {setFilenameOverlaySource} from "../AttributionOverlay";
import {
    addFiltersToVideoNode,
    applyByteInvertToImage,
    applyCurvesToImage,
    applyConvolutionToImage,
    applyEchoEffect,
    applyLevelsToImage,
    applySourcePixelFilterToImage,
    applyTonalAdjustmentsToImage,
    clearEchoCache,
    getClipComparisonValue,
    hasActiveTonalAdjustments,
    guiVideoEffectsFolder,
} from "./CNodeVideoViewFilters";
import {analysisMethods} from "./CNodeVideoViewAnalysis";
import {CNodeVideoHistogramView} from "./CNodeVideoHistogramView";
import {CNodeVideoCurvesView} from "./CNodeVideoCurvesView";
import {CNodeVideoLevelsView} from "./CNodeVideoLevelsView";

// Re-export for external consumers (e.g. CMotionAnalysis).
export {addFiltersToVideoNode, applyConvolution} from "./CNodeVideoViewFilters";

// True if `img` is a usable, already-decoded drawable (HTMLImageElement, canvas,
// or ImageBitmap) — i.e. something CVideoImageData can read width/height from and
// draw. A raw ArrayBuffer, null/undefined, or a not-yet-loaded Image (width 0) all
// return false. Used to guard against handing CVideoImageData an undefined image.
function isDecodedImage(img) {
    return !!img && typeof img === 'object' &&
        typeof img.width === 'number' && img.width > 0 &&
        typeof img.height === 'number' && img.height > 0;
}

// Decode raw image bytes into a loaded HTMLImageElement, resolving only once the
// browser has actually decoded it (onload). Mirrors the safe decode the
// loadVideoFromEntry restore path already uses, so callers that only have bytes
// (or a stale/undecoded FileManager entry) can still get a guaranteed-ready image.
function decodeImageFromBytes(bytes, fileName) {
    return new Promise((resolve, reject) => {
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const mimeType = ext === 'png' ? 'image/png' :
            (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' :
            ext === 'gif' ? 'image/gif' :
            ext === 'webp' ? 'image/webp' :
            ext === 'bmp' ? 'image/bmp' : 'image/png';
        const blobURL = URL.createObjectURL(new Blob([bytes], {type: mimeType}));
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(blobURL); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(blobURL); reject(e); };
        img.src = blobURL;
    });
}


export class CNodeVideoView extends CNodeViewCanvas2D {
    constructor(v) {
        super(v);
        // this.canvas.addEventListener( 'wheel', e => this.handleMouseWheel(e) );

        // these no longer work with the new rendering pipeline
        // TODO: reimplement them as effects?
        this.optionalInputs(["brightness", "contrast", "levels", "levelsInputBlack", "levelsMidpoint", "levelsInputWhite", "levelsOutputBlack", "levelsOutputWhite", "showHistogram", "histogramOnScreen", "curves", "showCurves", "shadows", "highlights", "dehaze", "blur", "hue", "invert", "saturate", "enableVideoEffects", "convolutionFilter", "elaJpegQuality", "elaErrorScale", "elaOpacity", "elaExpandMethod", "elaContrastClipPercent", "noiseBlockSize", "noiseScale", "noiseOpacity", "noiseDisplayMode"])
        //

        //  if (this.overlayView === undefined)
        addFiltersToVideoNode(this)
        this.setupHistogramView();
        this.setupLevelsView();
        this.setupCurvesView();

        this.positioned = false;
        this.autoFill = v.autoFill ?? true; // default to autofill
        // Phase 1: the window-move gesture is unified to the edit key (Q) in CNodeView.
        // The old `this.shiftDrag = true` override is removed — it was already dead
        // (CNodeView wires makeDraggable with requiredKey "Q", which takes precedence
        // over shiftDrag in onDrag), and it only made this view's config look non-uniform.

        this.scrubFrame = 0; // storing fractiona accumulation of frames while scrubbing

        this.autoClear = (v.autoClear !== undefined) ? v.autoClear : false;

        this.input("zoom", true); // zoom input is optional

        this.videoSpeed = v.videoSpeed ?? 1; // default to 1x speed
        this.alwaysReplace = v.alwaysReplace ?? false;

        // Whether this view owns the global sitch timeline (Sit.frames/fps and the
        // playhead reset on load). The primary "video" view does; a secondary
        // "video2" view must not, so a second clip can't redefine the timeline.
        // Passed down to each videoData so the data-layer Sit.* writes are gated.
        // Defaults true so single-video behavior is unchanged.
        this.ownsTimeline = v.ownsTimeline ?? true;

        this.lastAudioSyncFrame = -1;
        this.wasPlayingLastFrame = false;

        this.videos = [];
        this.currentVideoIndex = -1;
        this.videoSelectorController = null;

        // When true, this video plays relative to the "in frame" (Sit.aFrame):
        // its own frame 0 is shown when the global playhead reaches Sit.aFrame.
        // Used mainly by the secondary video view to sync a second clip to the in point.
        this.lockToInFrame = v.lockToInFrame ?? false;
        this.lockToInFrameController = null;
        this.exifInfoButtonController = null;
        this.exifInfoPanel = new EXIFInfoPanel({
            onVisibilityChange: () => this.updateEXIFInfoButton(),
        });
        this._elaPendingKey = null;
        this._elaResultKey = null;
        this._elaResultCanvas = null;
        this._elaRequestToken = 0;
        this._elaRequestSeq = 0;
        this._elaActiveRequest = null;
        this._elaQueuedRequest = null;
        this._elaWorker = null;
        this._elaWorkerFailed = false;

        this._noisePendingKey = null;
        this._noiseResultKey = null;
        this._noiseResultCanvas = null;
        this._noiseRequestToken = 0;
        this._noiseRequestSeq = 0;
        this._noiseActiveRequest = null;
        this._noiseQueuedRequest = null;
        this._noiseWorker = null;
        this._noiseWorkerFailed = false;
        this.showShadowClipMask = false;
        this.showHighlightClipMask = false;
        this._clipOriginalCanvas = null;
        this._clipAdjustedCanvas = null;
        this._clipMaskCanvas = null;
        this._curvesCanvas = null;
        this._levelsMidpointCanvas = null;

        // Pan offset for zoom+pan mode (fraction of video dimensions, 0 = centered)
        this.panOffsetX = 0;
        this.panOffsetY = 0;

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

    setupHistogramView() {
        if (this.id !== "video") return;
        if (this.histogramView) return;

        this.histogramView = new CNodeVideoHistogramView({
            id: this.id + "Histogram",
            videoView: this,
            relativeTo: this.id,
            left: 0.68,
            top: 0.035,
            width: 0.30,
            height: -0.34,
        });

        this.updateHistogramVisibilityFromVideoAdjustments();
        this.setupVideoAdjustmentsVisibilityHandler();
    }

    isVideoAdjustmentsOpen() {
        const contextMenu = Globals.menuBar?.activeContextMenu || Globals.menuBar?.activePersistentMenu;
        const contextMenuTitle = contextMenu?._title?.textContent || contextMenu?.$title?.textContent;
        return !!(guiVideoEffectsFolder && !guiVideoEffectsFolder._closed)
            || (contextMenuTitle === "Video Adjustments");
    }

    updateHistogramVisibilityFromVideoAdjustments() {
        const showHistogram = this.in.showHistogram?.value !== false;
        this.histogramView?.setVisible(showHistogram && this.isVideoAdjustmentsOpen());
    }

    setupCurvesView() {
        if (this.id !== "video") return;
        if (this.curvesView) return;

        this.curvesView = new CNodeVideoCurvesView({
            id: this.id + "CurveEditor",
            videoView: this,
            relativeTo: this.id,
            left: 0.68,
            top: 0.38,
            width: 0.30,
            height: -1,
        });

        this.updateCurvesVisibility();
        this.setupVideoAdjustmentsVisibilityHandler();
    }

    setupLevelsView() {
        if (this.id !== "video") return;
        if (this.levelsView) return;

        this.levelsView = new CNodeVideoLevelsView({
            id: this.id + "LevelsEditor",
            videoView: this,
            relativeTo: this.id,
            left: 0.68,
            top: 0.38,
            width: 0.30,
            height: -1,
        });

        this.updateLevelsVisibility();
        this.setupVideoAdjustmentsVisibilityHandler();
    }

    setupVideoAdjustmentsVisibilityHandler() {
        if (guiVideoEffectsFolder) {
            guiVideoEffectsFolder.onOpenClose(() => {
                this.updateVideoAdjustmentHelperVisibility();
                setRenderOne(true);
            });
        }
    }

    updateVideoAdjustmentHelperVisibility() {
        this.updateHistogramVisibilityFromVideoAdjustments();
        this.updateLevelsVisibility();
        this.updateCurvesVisibility();
    }

    updateLevelsVisibility() {
        const levelsEnabled = this.in.levels?.value === true;
        const visible = levelsEnabled && this.isVideoAdjustmentsOpen();
        this.levelsView?.setVisible(visible);
        if (visible) this.moveEditorTowardCenterIfOverlapping(this.levelsView, this.curvesView);
    }

    updateCurvesVisibility() {
        const curvesEnabled = this.in.curves?.value === true;
        const showCurves = this.in.showCurves?.value !== false;
        const visible = curvesEnabled && showCurves && this.isVideoAdjustmentsOpen();
        this.curvesView?.setVisible(visible);
        if (visible) this.moveEditorTowardCenterIfOverlapping(this.curvesView, this.levelsView);
    }

    moveEditorTowardCenterIfOverlapping(editor, otherEditor) {
        if (!editor?.visible || !otherEditor?.visible) return;
        if (!this.editorRectsOverlap(editor, otherEditor)) return;

        const gap = 12;
        const containerLeft = editor.containerLeft();
        const containerRight = containerLeft + editor.containerWidth();
        const containerCenter = containerLeft + editor.containerWidth() / 2;
        const editorCenter = editor.leftPx + editor.widthPx / 2;
        const moveLeftTowardCenter = editorCenter >= containerCenter;
        const preferredLeft = moveLeftTowardCenter
            ? otherEditor.leftPx - editor.widthPx - gap
            : otherEditor.leftPx + otherEditor.widthPx + gap;
        const clampedLeft = Math.max(containerLeft, Math.min(containerRight - editor.widthPx, preferredLeft));

        editor.leftPx = clampedLeft;
        editor.left = (editor.leftPx - editor.containerLeft()) / editor.containerWidth();
        editor.div.style.left = `${editor.leftPx}px`;
    }

    editorRectsOverlap(a, b) {
        return a.leftPx < b.leftPx + b.widthPx &&
            a.leftPx + a.widthPx > b.leftPx &&
            a.topPx < b.topPx + b.heightPx &&
            a.topPx + a.heightPx > b.topPx;
    }

    invalidateLevelsResult() {
        this._levelsLastImage = undefined;
        this._levelsLastKey = undefined;
        this._levelsMidpointLUT = null;
        this.invalidateCurveResult();
    }

    getLevelsSettings() {
        return {
            inputBlack: this.in.levelsInputBlack?.v0 ?? 0,
            inputWhite: this.in.levelsInputWhite?.v0 ?? 255,
            midpoint: this.in.levelsMidpoint?.v0 ?? 1,
            outputBlack: this.in.levelsOutputBlack?.v0 ?? 0,
            outputWhite: this.in.levelsOutputWhite?.v0 ?? 255,
        };
    }

    hasActiveLevels() {
        const levels = this.getLevelsSettings();
        return this.in.levels?.value === true ||
            levels.inputBlack !== 0 ||
            levels.inputWhite !== 255 ||
            levels.midpoint !== 1 ||
            levels.outputBlack !== 0 ||
            levels.outputWhite !== 255;
    }

    invalidateCurveResult() {
        this._curvesLastImage = undefined;
        this._curvesLastFrame = undefined;
        this._curvesLastRevision = undefined;
    }

    setClipWarningMaskEnabled(shadowEnabled, highlightEnabled) {
        this.showShadowClipMask = shadowEnabled;
        this.showHighlightClipMask = highlightEnabled;
        setRenderOne(true);
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

    dispatchVideoAvailabilityChanged() {
        // Custom-sitch UI depends on whether the video view has a real pixel coordinate system yet.
        EventManager.dispatchEvent("videoAvailabilityChanged", {
            viewId: this.id,
            hasVideo: this.videoWidth > 0 &&
                this.videoHeight > 0 &&
                this.originalVideoWidth > 0 &&
                this.originalVideoHeight > 0
        });
    }

    /**
     * Loads a video (or image-as-video) into this view.
     *
     * Reference-aware behavior:
     * - If `fileName` is a Sitrec object reference and `storedRef` is omitted, the method first resolves
     *   a temporary fetch URL and then re-enters itself with `storedRef` set to the original reference.
     * - `staticURL` is set to the stable reference (`storedRef`) when available so serialization/share links
     *   preserve host-agnostic object identity instead of short-lived presigned URLs.
     *
     * @param {string} fileName - Concrete URL/path or resolvable Sitrec reference.
     * @param {boolean} [clearFrames=true] - Whether to invalidate global frame count.
     * @param {string|undefined} [storedRef=undefined] - Stable original ref for serialization/restoration.
     * @returns {void}
     */
    // restoreIndex: when this load is part of a multi-video restore, the source
    // slot index it fills. Carried through to the created videoData (_restoreIndex)
    // so the completion assigns itself to the correct slot by identity, and so a
    // restore-originated straggler never adds a duplicate entry. undefined for
    // normal (drag-drop / single) loads, which keep the add-on-load behavior.
    newVideo(fileName, clearFrames = true, storedRef = undefined, restoreIndex = undefined) {
        if (storedRef === undefined && isResolvableSitrecReference(fileName)) {
            resolveURLForFetch(fileName).then(resolvedUrl => {
                this.newVideo(resolvedUrl, clearFrames, fileName, restoreIndex);
            }).catch(error => {
                console.error(`[VideoNew] Failed to resolve video ref: ${fileName}`, error);
                this.errorCallback(error);
            });
            return;
        }

        if (clearFrames) {
            Sit.frames = undefined; // need to recalculate this
        }
        EventManager.dispatchEvent("videoImportStarted", {viewId: this.id, fileName});
        this.fileName = fileName;
        setFilenameOverlaySource(this.fileName);
        this.invalidateELAResult();
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
            if (restoreIndex !== undefined && this.videoData) {
                this.videoData._restoreIndex = restoreIndex;
            }
            this.positioned = false;
            if (this.ownsTimeline) {
                par.frame = 0;
                par.paused = false;
            }
            return;
        }

        Globals.pendingActions++;
        this.videoLoadPending = true;

        const videoIndex = this.videos.length;
        const videoDataId = this.id + "_data_" + videoIndex;
        console.log(`[VideoNew] Creating video[${videoIndex}]: "${fileName}", id="${videoDataId}"`);

        // Check if it's an image file — load as single-frame pseudo-video
        const fileExt = getFileExtension(fileName);
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(fileExt)) {
            console.log(`[VideoNew] Detected image file for video[${videoIndex}]`);
            const { FileManager } = require("../Globals");
            FileManager.loadAsset(fileName).then(async (result) => {
                const fileEntry = FileManager.list[fileName];
                const importMetadata = fileEntry?.original
                    ? await extractJPEGImportMetadata(fileEntry.original, fileName).catch(err => {
                        console.warn(`[EXIF] Failed to parse metadata for ${fileName}:`, err);
                        return null;
                    })
                    : null;
                // result.parsed is normally the decoded image (the FileManager entry's
                // .data), but under load contention loadAsset can resolve from a list
                // entry whose .data isn't populated yet, handing us an undefined image —
                // which trips CVideoImageData's `img is undefined` assert (the
                // intermittent Atremis Starlink load failure). Guard it: if we didn't get
                // a usable, already-decoded image, decode one from the original bytes
                // (same as the loadVideoFromEntry restore path) before continuing, and
                // fail gracefully rather than asserting if even that yields nothing.
                let img = result?.parsed;
                if (!isDecodedImage(img) && fileEntry?.original) {
                    img = await decodeImageFromBytes(fileEntry.original, fileName).catch(err => {
                        console.error(`[VideoNew] Fallback image decode failed for ${fileName}:`, err);
                        return null;
                    });
                }
                if (!isDecodedImage(img)) {
                    console.error(`[VideoNew] Image asset "${fileName}" produced no decoded image; skipping`);
                    Globals.pendingActions--;
                    this.videoLoadPending = false;
                    return;
                }
                this.makeImageVideo(fileName, img, false, undefined, importMetadata, true, restoreIndex);
                this.staticURL = fileName;
            }).catch(err => {
                console.error(`[VideoNew] Error loading image as video: ${fileName}`, err);
                Globals.pendingActions--;
                this.videoLoadPending = false;
            });
            return;
        }

        // Check if it's an audio-only file based on extension
        if (isAudioOnlyFormat(fileName)) {
            console.log(`[VideoNew] Using audio-only handler for video[${videoIndex}]`);
            this.videoData = new CVideoAudioOnly({ id: videoDataId, filename: fileName, videoSpeed: this.videoSpeed },
                this.loadedCallback.bind(this), this.errorCallback.bind(this))
        } else {
            // Pick the right codec class by filename extension. Without this,
            // a sitch saved with a `.h264` substream as videoFile (the unified
            // TS persistence model) routes to CVideoMp4Data which fails on
            // raw H.264 (no MP4 container) and shows an error dialog before
            // the upload-path fallback kicks in. Routing by extension here
            // avoids that wasted attempt.
            const ext = (getFileExtension(fileName) || "").toLowerCase();
            if (ext === "h264" || ext === "dad") {
                console.log(`[VideoNew] Using CVideoH264Data for video[${videoIndex}]`);
                this.videoData = new CVideoH264Data({ id: videoDataId, file: fileName, videoSpeed: this.videoSpeed, ownsTimeline: this.ownsTimeline },
                    this.loadedCallback.bind(this), this.errorCallback.bind(this));
            } else {
                console.log(`[VideoNew] Using CVideoMp4Data for video[${videoIndex}]`);
                this.videoData = new CVideoMp4Data({ id: videoDataId, file: fileName, videoSpeed: this.videoSpeed, ownsTimeline: this.ownsTimeline },
                    this.loadedCallback.bind(this), this.errorCallback.bind(this))
            }
        }

        console.log(`[VideoNew] Created videoData for video[${videoIndex}]: imageCache.length=${this.videoData?.imageCache?.length}`);

        VideoLoadingManager.registerLoading(videoDataId, fileName);
        this.videoData._loadingId = videoDataId;
        // Tag restore-originated loads so the completion lands in its own slot.
        if (restoreIndex !== undefined && this.videoData) {
            this.videoData._restoreIndex = restoreIndex;
        }

        // loaded from a URL, so we can set the staticURL
        this.staticURL = storedRef || this.fileName;

        // Add to videos array immediately only for NON-restore loads. A restore
        // pre-creates its slots and assigns by index in continueVideoRestore; a
        // restore-originated straggler (restoreIndex defined) must never push a
        // duplicate entry here even if it completes after restore has finished.
        if (restoreIndex === undefined && !this.pendingVideoRestore) {
            this.addVideoEntry(fileName, this.staticURL, false);
        }

        this.positioned = false;
        if (this.ownsTimeline) {
            par.frame = 0;
            par.paused = false; // unpause, otherwise we see nothing.
        }
        this.addLoadingMessage()
        this.addDownloadButton()


    }

    showOverlay() {
        if (this.overlay?.canvas) {
            this.overlay.canvas.style.display = '';
        }
    }

    hideOverlay() {
        if (this.overlay?.canvas) {
            this.overlay.canvas.style.display = 'none';
        }
    }

    addLoadingMessage() {
        if (this.overlay) {
            this.showOverlay();
            this.overlay.addText("videoLoading", "LOADING", 50, 50, 5, "#f0f000")
        }
    }


    removeText() {
        if (this.overlay) {
            this.overlay.removeText("videoLoading")
            this.overlay.removeText("videoError")
            this.overlay.removeText("videoErrorName")
            this.overlay.removeText("videoNo")
            this.hideOverlay();
        }
    }


    stopStreaming() {
        this.removeText()
        if (this.ownsTimeline) {
            par.frame = 0
            par.paused = false;
        }
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
        this.dispatchVideoAvailabilityChanged();
        setFilenameOverlaySource(this.fileName ?? videoData?.filename);

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

        let vd = videoData;
        console.log(`[VideoLoaded] ========== Video Load Complete ==========`);
        console.log(`[VideoLoaded]   filename: "${vd?.filename}"`);
        console.log(`[VideoLoaded]   dimensions: ${vd?.videoWidth}x${vd?.videoHeight}`);
        console.log(`[VideoLoaded]   frames: ${vd?.frames}, groups: ${vd?.groups?.length}, chunks: ${vd?.chunks?.length}`);
        console.log(`[VideoLoaded]   imageCache: length=${vd?.imageCache?.length}, type=${vd?.imageCache?.constructor?.name}`);
        console.log(`[VideoLoaded]   this.videos.length: ${this.videos.length}, pendingRestore: ${!!this.pendingVideoRestore}`);

        // Wrap dropped-frame video with a uniform-cadence virtual timeline so
        // KLV/RTC pairing stays drift-free without re-timing the unaltered
        // KLV stream. See docs/dev/misb-timing.md.
        if (Globals.useVideoPatching && Sit.fps && CVideoPatchedData.shouldWrap(vd, Sit.fps)) {
            const sourceFrames = vd.frames;
            const patched = new CVideoPatchedData(vd, {fps: Sit.fps, fillMode: "hold"});
            // Preserve the restore-slot tag so continueVideoRestore still routes this
            // (now-wrapped) completion to its own slot.
            if (vd._restoreIndex !== undefined) patched._restoreIndex = vd._restoreIndex;
            const stats = patched.getPatchStats();
            console.log(`[VideoPatch] wrapping: source=${sourceFrames} virtual=${patched.frames} held=${stats.heldFrames} longestHold=${stats.longestHoldFrames}f (${Math.round(stats.longestHoldMs)}ms)`);
            const idx = this.videos.findIndex(v => v.videoData === vd);
            if (idx >= 0) this.videos[idx].videoData = patched;
            this.videoData = patched;
            vd = patched;
            // The source video class already wrote Sit.videoFrames = sourceFrames.
            // Overwrite with the virtual count and re-run updateSitFrames so
            // Sit.frames is the virtual count BEFORE any recalc cascade runs
            // (otherwise CNodeTrackFromMISB asserts on Sit.frames === undefined).
            Sit.videoFrames = patched.frames;
            updateSitFrames();
        }

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
        this.setupLockToInFrameControl();

        // Apply EXIF metadata if present and not yet applied (single convergence point
        // for drag-drop, newVideo, and importMedia paths)
        const importMeta = videoData?.importMetadata;
        if (importMeta && !importMeta.applied) {
            importMeta.applied = applyImportedImageMetadata(
                importMeta,
                this.fileName ?? videoData?.filename ?? ""
            );
        }

        this.updateEXIFPositionButton();
        this.updateEXIFInfoButton();

        // Handle pending multi-video restore
        // Pass vd (the videoData from callback parameter) since this.videoData may not be set yet
        // (CVideoImageData calls loadedCallback synchronously from within its constructor)
        if (this.pendingVideoRestore) {
            this.continueVideoRestore(vd);
        }
    }

    // Pre-create one output slot per saved video, in order, with videoData=null.
    // This makes the restore IDENTITY-BASED rather than completion-order-based:
    // each saved entry has a FIXED slot, so out-of-order or duplicate async
    // completions (which happen because images load via mixed fast/URL-fallback
    // paths and shared S3 URLs) can no longer be mis-paired into the wrong slot,
    // and selection is stable from the start. Each load is tagged with its source
    // index (restoreIndex) and writes only to its own slot.
    _preCreateRestoreSlots() {
        const pr = this.pendingVideoRestore;
        if (!pr || pr._slotsCreated) return;
        this.videos = pr.videos.map(v => ({
            fileName: v.fileName,
            staticURL: v.staticURL,
            isImage: v.isImage || false,
            imageFileID: v.imageFileID,
            videoData: null,
        }));
        pr._slotsCreated = true;
        pr.loadingIndex = 0;
        const ti = pr.targetIndex;
        this.currentVideoIndex = (ti >= 0 && ti < this.videos.length) ? ti : 0;
        this.updateVideoSelector();
    }

    continueVideoRestore(loadedVideoData) {
        if (!this.pendingVideoRestore) return;
        const pr = this.pendingVideoRestore;
        const total = pr.videos.length;

        // Identity-based assignment: a completion carries the source index it was
        // started for (_restoreIndex). Write it ONLY to its own slot, never to a
        // positional "next" slot. A stale/duplicate completion for an
        // already-filled slot is simply dropped.
        const idx = loadedVideoData?._restoreIndex;
        console.log(`[VideoRestore] completion for slot ${idx}: filename=${loadedVideoData?.filename}, loadingIndex=${pr.loadingIndex}/${total}`);
        if (idx !== undefined && idx >= 0 && idx < this.videos.length && !this.videos[idx].videoData) {
            this.videos[idx].videoData = loadedVideoData;
        }

        // Only advance/start the next load when the slot we are CURRENTLY waiting
        // for (loadingIndex) is resolved. A straggler completion for a different
        // slot must not advance the chain or kick off a duplicate load.
        const cur = this.videos[pr.loadingIndex];
        if (!cur || !(cur.videoData || cur._restoreFailed)) {
            return; // straggler — keep waiting for loadingIndex's own completion
        }
        while (pr.loadingIndex < total &&
               (this.videos[pr.loadingIndex].videoData || this.videos[pr.loadingIndex]._restoreFailed)) {
            pr.loadingIndex++;
        }
        if (pr.loadingIndex < total) {
            this.loadVideoFromEntry(pr.videos[pr.loadingIndex], pr.loadingIndex);
        } else {
            this._finalizeVideoRestore();
        }
    }

    // Compact out any slots whose load failed, apply the (possibly shifted) target
    // selection, and clear restore state. Selection is authoritative here — the
    // saved currentVideoIndex always wins, never a late add.
    _finalizeVideoRestore() {
        const pr = this.pendingVideoRestore;
        if (!pr) return;
        const targetIndex = pr.targetIndex;
        let target = targetIndex;
        const kept = [];
        for (let i = 0; i < this.videos.length; i++) {
            const slot = this.videos[i];
            if (slot._restoreFailed && !slot.videoData) {
                if (i < targetIndex) target--; // a removed-before-target slot shifts target left
                continue;
            }
            delete slot._restoreFailed;
            kept.push(slot);
        }
        this.videos = kept;
        delete this.pendingVideoRestore;
        console.log(`[VideoRestore] All slots resolved. ${this.videos.length} kept, selecting targetIndex=${target}`);
        this.logVideoArrayState();
        const finalTarget = (target >= 0 && target < this.videos.length) ? target : 0;
        // Force selectVideo to (re)apply the videoData/selection unconditionally.
        this.currentVideoIndex = -1;
        if (this.videos.length > 0) {
            this.selectVideo(finalTarget);
        }
        this.ensureVideoSelectorUpdated();

        // Re-apply auto-tracking once videoData is available. finishDeserialization
        // runs deserializeAutoTracking before the async video load completes, so it
        // bails out early on the first pass (no videoData).
        if (Sit.autoTracking?.trackedPositions?.length > 0) {
            import("../CObjectTracking").then(m => {
                m.deserializeAutoTracking(Sit.autoTracking);
            });
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
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
            return true;
        }
        // Local working-folder videos are stored as relative paths like "local/media/foo.mp4".
        const {FileManager} = require("../Globals");
        return !!FileManager?.directoryHandle && typeof url === "string" && !url.startsWith("/");
    }
    
    /**
     * Restores/loads a video entry from serialized multi-video state.
     *
     * For remote media, `entry.staticURL` (or fallback `entry.fileName`) may be a Sitrec reference.
     * This method resolves it to a temporary fetch URL while preserving the original stable reference
     * for subsequent serialization (`staticURL`).
     *
     * @param {{
     *   fileName: string,
     *   staticURL?: string,
     *   isImage?: boolean,
     *   imageFileID?: string
     * }} entry
     * @returns {Promise<void>}
     */
    async loadVideoFromEntry(entry, restoreIndex = undefined) {
        // First restore load: pre-create all output slots so completions assign by
        // identity (their own source index) rather than by arrival order.
        if (this.pendingVideoRestore && !this.pendingVideoRestore._slotsCreated) {
            this._preCreateRestoreSlots();
        }
        // During a restore, every load carries the index of the slot it fills. The
        // initial trigger calls loadVideoFromEntry(videos[0]) with no index, so fall
        // back to the current loadingIndex (0 at the start).
        if (restoreIndex === undefined && this.pendingVideoRestore) {
            restoreIndex = this.pendingVideoRestore.loadingIndex ?? 0;
        }
        const nextIdx = restoreIndex ?? this.videos.length;
        const storedRef = entry.staticURL || Sit.loadedFiles?.[entry.fileName] || entry.fileName;
        console.log(`[VideoLoad] loadVideoFromEntry[${nextIdx}]: "${entry.fileName}", isImage=${entry.isImage}, source=${storedRef?.substring(0, 80)}...`);
        const { FileManager } = require("../Globals");

        if (entry.isImage) {
            const imageFileID = entry.imageFileID || entry.fileName;
            const fileEntry = FileManager.list[imageFileID] || FileManager.list[entry.fileName];

            // Use .original which contains the ArrayBuffer (not .data which may be the parsed Image object)
            if (fileEntry && fileEntry.original) {
                console.log(`[VideoLoad] Loading image[${nextIdx}] from FileManager (id=${imageFileID})`);
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
                    this.makeImageVideo(entry.fileName, img, false, imageFileID, undefined, false, restoreIndex);
                    this.imageFileID = imageFileID;
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
                return;
            }

            const url = await resolveURLForFetch(storedRef).catch(error => {
                console.error(`[VideoLoad] Failed to resolve image[${nextIdx}] "${entry.fileName}":`, error);
                return null;
            });
            if (this.isValidVideoURL(url)) {
                console.log(`[VideoLoad] Loading image[${nextIdx}] from URL fallback: ${url.substring(0, 80)}...`);
                this.newVideo(url, false, storedRef, restoreIndex);
            } else {
                console.warn(`[VideoLoad] Cannot restore image[${nextIdx}] "${entry.fileName}" - source unavailable`);
                this.skipCurrentVideoRestore();
            }
        } else {
            const isImportedLocalPath = FileManager?.isLikelyImportedLocalAssetPath?.(storedRef);
            if (isImportedLocalPath) {
                const hasWorkingFolder = await FileManager.ensureWorkingFolderForImportedLocalAsset(storedRef);
                if (!hasWorkingFolder) {
                    console.warn(`[VideoLoad] Cannot restore video[${nextIdx}] "${entry.fileName}" - Local Sitch Folder is required`);
                    this.skipCurrentVideoRestore();
                    return;
                }

                try {
                    await FileManager.getWorkingFolderFileHandle(storedRef, {create: false});
                } catch (error) {
                    if (error?.name === "NotFoundError") {
                        FileManager.showMissingLocalAssetInSelectedFolder(storedRef, error);
                        this.skipCurrentVideoRestore();
                        return;
                    }
                    throw error;
                }
            }

            const url = await resolveURLForFetch(storedRef).catch(error => {
                console.error(`[VideoLoad] Failed to resolve video[${nextIdx}] "${entry.fileName}":`, error);
                return null;
            });
            if (this.isValidVideoURL(url)) {
                console.log(`[VideoLoad] Loading video[${nextIdx}] from URL: ${url.substring(0, 80)}...`);
                this.newVideo(url, false, storedRef, restoreIndex);
            } else {
                console.warn(`[VideoLoad] Cannot restore video[${nextIdx}] "${entry.fileName}" - invalid URL (local files must be re-imported)`);
                this.skipCurrentVideoRestore();
            }
        }
    }

    skipCurrentVideoRestore() {
        if (!this.pendingVideoRestore) return;
        const pr = this.pendingVideoRestore;
        const total = pr.videos.length;

        // Mark the slot we were loading as failed so the index-based chain skips it
        // (it is compacted out at finalize). Then advance exactly like a completion.
        if (pr.loadingIndex < this.videos.length) {
            this.videos[pr.loadingIndex]._restoreFailed = true;
        }
        console.warn(`[VideoRestore] Skipping slot ${pr.loadingIndex} ("${pr.videos[pr.loadingIndex]?.fileName}")`);

        while (pr.loadingIndex < total &&
               (this.videos[pr.loadingIndex].videoData || this.videos[pr.loadingIndex]._restoreFailed)) {
            pr.loadingIndex++;
        }
        if (pr.loadingIndex < total) {
            this.loadVideoFromEntry(pr.videos[pr.loadingIndex], pr.loadingIndex);
        } else {
            this._finalizeVideoRestore();
        }
    }

    errorCallback(err, isDeferral = false) {
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
            this.showOverlay();
            if (isDeferral) {
                // The first attempt expectedly bailed (e.g. a URL pre-fetch on a
                // sitch reload that's about to be served via uploadFile from the
                // loadedFiles dispatch). Showing "Error Loading" here scares the
                // user when nothing is actually wrong — keep the LOADING text
                // until the deferred path either completes or genuinely fails.
                this.overlay.addText("videoLoading", "LOADING", 50, 50, 5, "#f0f000");
            } else {
                this.overlay.addText("videoError", "Error Loading", 50, 45, 5, "#f0f000", "center")
                this.overlay.addText("videoErrorName", this.fileName, 50, 55, 1.5, "#f0f000", "center")
            }
        }

        // If we are in a restore sequence, an error means we should probably skip this video
        // and try to load the rest, rather than stalling the entire chain.
        if (this.pendingVideoRestore && !isDeferral) {
            console.warn(`[VideoRestore] Error loading video "${this.fileName}", skipping and continuing restore...`);
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

        if (this.in.zoom !== undefined) {
            const oldZoom = this.in.zoom.v0 / 100;
            const newZoom = oldZoom * scale; // scale < 1 = scroll down = zoom out

            // Zoom around cursor: adjust panOffset to keep mouse position stable
            if (this.mouse && this.videoWidth > 0 && this.videoHeight > 0) {
                const [mouseVX, mouseVY] = this.canvasToVideoCoords(this.mouse.anchorX, this.mouse.anchorY);
                const mouseFracX = mouseVX / this.videoWidth;
                const mouseFracY = mouseVY / this.videoHeight;
                const ratio = oldZoom / newZoom;
                this.panOffsetX = (mouseFracX - 0.5) * (1 - ratio) + this.panOffsetX * ratio;
                this.panOffsetY = (mouseFracY - 0.5) * (1 - ratio) + this.panOffsetY * ratio;
            }

            const videoZoom = NodeMan.get("videoZoom", false);
            if (videoZoom !== undefined) {
                videoZoom.setValue(newZoom * 100);
            }
            this.clampPanOffset();
        } else {
            // Fallback to pos-based zoom when no zoom input
            this.zoomView(scale);
        }
    }


    // Check if mouse position is over a tracking overlay control point
    _isOverOverlayControl(canvasX, canvasY) {
        const trackingOverlay = NodeMan.get("trackingOverlay", false);
        if (!trackingOverlay || !trackingOverlay.draggable) return false;
        return trackingOverlay.draggable.some(d => d.isWithin(canvasX, canvasY));
    }

    // Check if a tracking overlay control is currently being dragged
    _isOverlayDragging() {
        const trackingOverlay = NodeMan.get("trackingOverlay", false);
        if (!trackingOverlay || !trackingOverlay.draggable) return false;
        return trackingOverlay.draggable.some(d => d.dragging);
    }

    // Check if the motion-analysis mask overlay is currently in paint-edit mode
    _isMaskEditing() {
        const maskOverlay = NodeMan.get("motionMaskOverlay", false);
        return maskOverlay !== undefined && maskOverlay.editing === true;
    }

    // Check if the annotation overlay is in edit mode — left-drag is then
    // owned by the annotation tools (drawing / selecting / moving / resizing),
    // not by video pan. Mirrors the mask overlay gate above. Uses the effective
    // predicate so when "Show Annotations" is off the gate is also off (even
    // if Edit Mode flag is still set).
    _isAnnotateEditing() {
        const annotateOverlay = NodeMan.get("annotateOverlay", false);
        if (!annotateOverlay) return false;
        return typeof annotateOverlay.isEditingActive === "function"
            ? annotateOverlay.isEditingActive()
            : annotateOverlay.editing === true;
    }

    setupMouseHandler() {
        this.mouse = new CMouseHandler(this, {

            down: (e) => {
                if (e.button === 0) {
                    this.fixCrosshair();
                }
            },

            move: (e) => {
                // Show grab cursor when hovering over a tracking overlay control point
                const overControl = this._isOverOverlayControl(this.mouse.x, this.mouse.y);
                this.canvas.style.cursor = overControl ? 'grab' : '';
            },

            wheel: (e) => {
                // When zoom input exists, zoom is handled by onMouseWheel (document-level)
                // which does zoom-around-cursor with panOffset.
                // When no zoom input, use pos-based zoom.
                if (this.in.zoom === undefined) {
                    var scale = 0.90;
                    if (e.deltaY > 0) {
                    } else {
                        scale = 1 / scale
                    }
                    this.zoomView(scale)
                }
                // Anchor position is already stored by CMouseHandler.newPosition
            },

            drag: (e) => {
                // Don't pan if a tracking overlay control point is being dragged
                if (this._isOverlayDragging()) {
                    this.canvas.style.cursor = 'grabbing';
                    return;
                }

                // Don't pan while painting the motion-analysis mask — left-drag paints instead
                if (this._isMaskEditing()) {
                    return;
                }

                // Don't pan while the annotate overlay is editing — left-drag is for drawing /
                // selecting / moving / resizing annotation strokes, not for panning the video.
                if (this._isAnnotateEditing()) {
                    return;
                }

                if (this.in.zoom !== undefined) {
                    // Pan via panOffset when using videoZoom
                    this.getSourceAndDestCoords();
                    // Convert mouse pixel delta to video-fraction delta
                    this.panOffsetX -= (this.mouse.dx / this.dWidth) * (this.sWidth / this.videoWidth);
                    this.panOffsetY -= (this.mouse.dy / this.dHeight) * (this.sHeight / this.videoHeight);
                    this.clampPanOffset();
                } else {
                    // Pos-based pan when no zoom input
                    const moveX = this.mouse.dx / this.widthPx;
                    const moveY = this.mouse.dy / this.widthPx
                    this.posLeft += moveX
                    this.posRight += moveX
                    this.posTop += moveY
                    this.posBot += moveY
                }
                setRenderOne(true);
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
                if (this.in.zoom !== undefined) {
                    // Zoom via videoZoom when using zoom input
                    var scale = 100 / (100 - this.mouse.dx);
                    const oldZoom = this.in.zoom.v0 / 100;
                    const newZoom = oldZoom * scale;
                    const videoZoom = NodeMan.get("videoZoom", false);
                    if (videoZoom !== undefined) {
                        videoZoom.setValue(newZoom * 100);
                    }
                    this.clampPanOffset();
                } else {
                    this.zoomView(100 / (100 - this.mouse.dx))
                }
            },

            dblClick: (e) => {
                this.panOffsetX = 0;
                this.panOffsetY = 0;
                if (this.in.zoom !== undefined) {
                    const videoZoom = NodeMan.get("videoZoom", false);
                    if (videoZoom !== undefined) {
                        videoZoom.setValue(100);
                    }
                }
                this.defaultPosition();
            },

            contextMenu: (e) => {
                // Show Video Adjustments as a context menu at click position
                if (!Globals.menuBar || !guiMenus.video || !CustomManager) return;
                const adjFolder = guiMenus.video.folders.find(
                    f => (f._title?.textContent || f.$title?.textContent) === 'Video Adjustments'
                );
                if (!adjFolder) return;
                const menu = Globals.menuBar.createStandaloneMenu(
                    "Video Adjustments", e.clientX, e.clientY, false
                );
                if (!menu) return;
                if (menu._escapeKeyHandler) {
                    document.removeEventListener('keydown', menu._escapeKeyHandler);
                    menu._escapeKeyHandler = null;
                }
                this.updateVideoAdjustmentHelperVisibility();
                const destroyMenu = menu.destroy.bind(menu);
                menu.destroy = (...args) => {
                    const result = destroyMenu(...args);
                    this.updateVideoAdjustmentHelperVisibility();
                    return result;
                };
                CustomManager.setupDynamicMirroring(adjFolder, menu);
                this.updateVideoAdjustmentHelperVisibility();
            }

        })
    }

    toSerializeCNodeVideoView = ["posLeft", "posRight", "posTop", "posBot", "panOffsetX", "panOffsetY", "lockToInFrame"]

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
        this.dispatchVideoAvailabilityChanged();
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
        setFilenameOverlaySource(this.fileName ?? vd?.filename);
        this.staticURL = entry.staticURL;
        this.videoData = entry.videoData;
        this.imageFileID = entry.imageFileID || null;
        this.invalidateELAResult();

        this.positioned = false;
        this.defaultPosition();
        this._lastSwitchDebug = true;
        setRenderOne(true);

        this.updateVideoSelector();
        this.updateRotationDropdown();
        this.updateEXIFPositionButton();
        this.updateEXIFInfoButton();
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
            .name(t("videoView.currentVideo.label") + this.viewMenuSuffix())
            .onChange((value) => {
                this.selectVideo(value);
            });
        console.log(`[VideoSelector] Selector created: ${!!this.videoSelectorController}`);
    }

    ensureVideoSelectorUpdated(retries = 10) {
        if (guiMenus.view) {
            this.updateVideoSelector();
            this.setupRotationDropdown();
            this.setupLockToInFrameControl();
            this.updateEXIFPositionButton();
            this.updateEXIFInfoButton();
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
            .name(t("videoView.videoRotation.label") + this.viewMenuSuffix())
            .onChange((value) => {
                if (this.videoData) {
                    this.videoData.setUserRotation(value);
                    this.positioned = false;  // Force layout recalculation
                    setRenderOne(true);
                }
            });
    }

    // Suffix used to distinguish this view's controls in the shared Video menu.
    // Empty for the primary "video" view, " (2)" etc. for secondary views.
    viewMenuSuffix() {
        return this.id === "video" ? "" : " (2)";
    }

    /**
     * Set up the "Lock to In Frame" checkbox in the Video menu.
     * Only shown for secondary video views (not the primary "video"),
     * since the primary defines the master timeline.
     */
    setupLockToInFrameControl() {
        if (!guiMenus.video) return;
        if (this.id === "video") return;       // primary defines the timeline
        if (this.lockToInFrameController) return;
        if (!this.videoData) return;

        this.lockToInFrameController = guiMenus.video.add(this, "lockToInFrame")
            .name("Lock to In Frame" + this.viewMenuSuffix())
            .tooltip("Play this video relative to the in frame (set with the I key). " +
                "Its first frame is shown when the playhead reaches the in frame.")
            .onChange(() => {
                setRenderOne(true);
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

    getCurrentImportMetadata() {
        return this.videoData?.importMetadata ?? null;
    }

    applyCurrentEXIFCameraPosition() {
        const metadata = this.getCurrentImportMetadata();
        if (!metadata) {
            console.log("[EXIF] No imported metadata is available for the current image");
            return;
        }

        const applied = applyImportedImageMetadata(
            metadata,
            this.fileName ?? this.videoData?.filename ?? ""
        );

        if (!applied) {
            return;
        }

        metadata.applied = {
            ...(metadata.applied ?? {}),
            ...applied,
        };

        this.updateEXIFPositionButton();
        this.updateEXIFInfoButton();
    }

    toggleEXIFInfoPanel() {
        this.syncEXIFInfoPanel();
        this.exifInfoPanel.toggle();
    }

    syncEXIFInfoPanel() {
        const metadata = this.getCurrentImportMetadata();
        this.exifInfoPanel.setMetadata(
            metadata,
            this.fileName ?? this.videoData?.filename ?? ""
        );
    }

    updateEXIFInfoButton() {
        if (!guiMenus.video) return;

        if (this.exifInfoButtonController) {
            this.exifInfoButtonController.destroy();
            this.exifInfoButtonController = null;
        }

        const metadata = this.getCurrentImportMetadata();
        if (!metadata) return;

        this.exifInfoButtonController = guiMenus.video.add(this, "toggleEXIFInfoPanel")
            .name(this.exifInfoPanel.visible ? "Hide EXIF Panel" : "Show EXIF Panel");
    }

    updateEXIFPositionButton() {
        if (!guiMenus.video) return;

        if (this.exifPositionController) {
            this.exifPositionController.destroy();
            this.exifPositionController = null;
        }

        const metadata = this.getCurrentImportMetadata();
        if (!metadata?.placement?.hasLocation) return;

        this.exifPositionController = guiMenus.video.add(this, "applyCurrentEXIFCameraPosition")
            .name(t("videoView.setCameraToExifGps.label"));
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

        this.invalidateELAResult();
        this.updateVideoSelector();
        this.updateEXIFPositionButton();
        this.updateEXIFInfoButton();
        this.dispatchVideoAvailabilityChanged();
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
        this.updateEXIFPositionButton();
        this.updateEXIFInfoButton();
        this.invalidateELAResult();
        this.updateVideoSelector();
        this.dispatchVideoAvailabilityChanged();
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
        this.disposeELAWorker();
        this.exifInfoPanel.destroy();
        // Call parent dispose
        super.dispose();
    }

    makeImageVideo(filename, img, deleteAfterUsing = false, imageFileID = undefined, importMetadata = undefined, pauseTimelineOnLoad = false, restoreIndex = undefined) {

        this.fileName = filename;
        setFilenameOverlaySource(this.fileName);
        this.imageFileID = imageFileID ?? null;
        this.invalidateELAResult();

        this.videoData = new CVideoImageData({
            id: this.id + "_data_" + this.videos.length,
            filename: filename,
            img: img,
            deleteAfterUsing: deleteAfterUsing,
            importMetadata: importMetadata,
        },
            this.loadedCallback.bind(this), this.errorCallback.bind(this))

        // Tag restore-originated loads so the completion (CVideoImageData queues
        // loadedCallback as a microtask, after this assignment) lands in its own
        // slot via continueVideoRestore.
        if (restoreIndex !== undefined) {
            this.videoData._restoreIndex = restoreIndex;
        }

        // Add to videos array immediately only for NON-restore loads. A restore
        // pre-creates its slots and assigns by index; a restore-originated straggler
        // (restoreIndex defined) must never push a duplicate entry here, even if it
        // completes after restore has finished and pendingVideoRestore is gone.
        if (restoreIndex === undefined && !this.pendingVideoRestore) {
            this.addVideoEntry(filename, undefined, true, imageFileID);
        }
        
        this.positioned = false;
        if (this.ownsTimeline) {
            par.frame = 0;
            par.paused = pauseTimelineOnLoad ? true : false;
        }
        EventManager.dispatchEvent("videoLoaded", {
            width: img.width, height: img.height,
            videoData: this
        });
        this.dispatchVideoAvailabilityChanged();
    }

    drawAdjustedSourceFrame(frame, canvas) {
        if (!this.videoData) return false;

        this.videoData.update();
        const image = this.videoData.getImage(frame);
        if (!image) return false;

        const sourceWidth = image.width || this.videoWidth;
        const sourceHeight = image.height || this.videoHeight;
        if (!sourceWidth || !sourceHeight) return false;

        const rotationSwapsDimensions = this.videoData.effectiveRotation === 90 || this.videoData.effectiveRotation === 270;
        const outputWidth = rotationSwapsDimensions
            ? (this.originalVideoHeight || sourceWidth)
            : (this.originalVideoWidth || sourceWidth);
        const outputHeight = rotationSwapsDimensions
            ? (this.originalVideoWidth || sourceHeight)
            : (this.originalVideoHeight || sourceHeight);

        canvas.width = outputWidth;
        canvas.height = outputHeight;

        const {sourceImage, filter, fullABOverlay} = this.getAdjustedVideoFrameSource(image, frame);

        const ctx = canvas.getContext("2d");
        let srcX = 0;
        let srcY = 0;
        let srcWidth = sourceWidth;
        let srcHeight = sourceHeight;

        if (this.in.zoom !== undefined && this.in.zoom.v0 > 100) {
            const zoom = this.in.zoom.v0 / 100;
            srcWidth = sourceWidth / zoom;
            srcHeight = sourceHeight / zoom;
            srcX = (sourceWidth - srcWidth) / 2 + this.panOffsetX * sourceWidth;
            srcY = (sourceHeight - srcHeight) / 2 + this.panOffsetY * sourceHeight;

            srcX = Math.max(0, Math.min(sourceWidth - srcWidth, srcX));
            srcY = Math.max(0, Math.min(sourceHeight - srcHeight, srcY));
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = quickToggle("Smooth", false, guiVideoEffectsFolder);
        ctx.filter = filter || "none";
        ctx.drawImage(sourceImage, srcX, srcY, srcWidth, srcHeight, 0, 0, outputWidth, outputHeight);
        if (fullABOverlay) {
            ctx.save();
            ctx.filter = "none";
            ctx.globalAlpha = fullABOverlay.opacity;
            ctx.drawImage(fullABOverlay.image, srcX, srcY, srcWidth, srcHeight, 0, 0, outputWidth, outputHeight);
            ctx.restore();
        }
        ctx.imageSmoothingEnabled = true;
        ctx.filter = "none";
        return true;
    }

    getAdjustedVideoFrameSource(image, frame) {
        let sourceImage = image;
        let filter = "";
        let invertSourceKey = "";
        const effectsEnabled = this.in.enableVideoEffects ? this.in.enableVideoEffects.v0 : true;

        if (effectsEnabled && this.in.convolutionFilter && this.in.convolutionFilter.value !== "none") {
            const filterType = this.in.convolutionFilter.value;
            const params = {
                amount: this.in.sharpenAmount?.v0 ?? 1,
                threshold: this.in.edgeDetectThreshold?.v0 ?? 0,
                strength: (filterType === "emboss" ? this.in.embossDepth?.v0 : 1) ?? 1
            };
            sourceImage = applyConvolutionToImage(image, filterType, params, this);
            invertSourceKey += `conv:${filterType}:${params.amount}:${params.threshold}:${params.strength}|`;
        }

        const hasFullABOverlay = this._fullABEchoResult && (this.in.fullABEcho?.value || this.in.fullABBlend?.value || this.in.fullABExposure?.value);
        if (hasFullABOverlay && this._fullABEchoRunning) {
            sourceImage = this._fullABEchoResult;
            invertSourceKey += `fullABRunning:${this.in.fullABEcho?.value}:${this.in.fullABBlend?.value}:${this.in.fullABExposure?.value}|`;
        } else if (!hasFullABOverlay) {
            const wantEchoMin = this.in.echoMin?.value ?? false;
            const wantEchoMax = this.in.echoMax?.value ?? false;
            if (effectsEnabled && (wantEchoMin || wantEchoMax)) {
                sourceImage = applyEchoEffect(this, sourceImage, frame, wantEchoMin, wantEchoMax);
                invertSourceKey += `echo:${wantEchoMin}:${wantEchoMax}:${Math.round(this.in.echoFrames?.v0 ?? 10)}|`;
            } else if (this._echoPixelCache) {
                clearEchoCache(this);
            }
        }

        if (effectsEnabled && this.hasActiveLevels()) {
            const levels = this.getLevelsSettings();
            sourceImage = applyLevelsToImage(sourceImage, levels, this);
            invertSourceKey += `levels:${levels.inputBlack}:${levels.inputWhite}:${levels.midpoint}:${levels.outputBlack}:${levels.outputWhite}|`;
        }

        if (effectsEnabled && this.in.curves?.value === true && this.curvesView) {
            sourceImage = applyCurvesToImage(sourceImage, this.curvesView.getCurveLUT(), this, frame);
            invertSourceKey += `curves:${this.curvesView.curveRevision ?? 0}|`;
        }

        const tonalAdjustments = {
            shadows: this.in.shadows?.v0 ?? 0,
            highlights: this.in.highlights?.v0 ?? 0,
            dehaze: this.in.dehaze?.v0 ?? 0,
        };
        if (effectsEnabled && hasActiveTonalAdjustments(tonalAdjustments)) {
            sourceImage = applyTonalAdjustmentsToImage(sourceImage, tonalAdjustments, this, frame);
            invertSourceKey += `tonal:${tonalAdjustments.shadows}:${tonalAdjustments.highlights}:${tonalAdjustments.dehaze}|`;
        }

        if (effectsEnabled && (this.in.invert?.value === true || this.in.invert?.value === 1)) {
            sourceImage = applyByteInvertToImage(sourceImage, this, frame, invertSourceKey);
        }

        const blurPx = effectsEnabled ? (this.in.blur?.v0 ?? 0) : 0;
        if (effectsEnabled && blurPx !== 0) {
            let sourceFilter = "";
            if (this.in.contrast && this.in.contrast.v0 !== 1) {
                sourceFilter += "contrast(" + this.in.contrast.v0 + ") ";
            }
            if (this.in.brightness && this.in.brightness.v0 !== 1) {
                sourceFilter += "brightness(" + this.in.brightness.v0 + ") ";
            }
            sourceFilter += "blur(" + blurPx + "px) ";
            sourceImage = applySourcePixelFilterToImage(sourceImage, sourceFilter, this);
        } else if (effectsEnabled) {
            if (this.in.contrast && this.in.contrast.v0 !== 1) {
                filter += "contrast(" + this.in.contrast.v0 + ") ";
            }
            if (this.in.brightness && this.in.brightness.v0 !== 1) {
                filter += "brightness(" + this.in.brightness.v0 + ") ";
            }
        }

        if (effectsEnabled) {
            if (this.in.hue && this.in.hue.v0 !== 0) {
                filter += "hue-rotate(" + this.in.hue.v0 + "deg) ";
            }
            if (this.in.saturate && this.in.saturate.v0 !== 1) {
                filter += "saturate(" + this.in.saturate.v0 + ") ";
            }
        }

        return {
            sourceImage,
            filter,
            invertActive: effectsEnabled && (this.in.invert?.value === true || this.in.invert?.value === 1),
            fullABOverlay: hasFullABOverlay && !this._fullABEchoRunning
                ? {image: this._fullABEchoResult, opacity: (this.in.fullABEchoOpacity?.v0 ?? 100) / 100}
                : null
        };
    }

    getClipWarningMask(image, adjusted) {
        if (!this.showShadowClipMask && !this.showHighlightClipMask) return null;

        const sourceImage = adjusted.sourceImage || image;
        const sourceWidth = sourceImage.videoWidth || sourceImage.naturalWidth || sourceImage.width || this.videoWidth;
        const sourceHeight = sourceImage.videoHeight || sourceImage.naturalHeight || sourceImage.height || this.videoHeight;
        if (!sourceWidth || !sourceHeight) return null;

        if (!this._clipOriginalCanvas) {
            this._clipOriginalCanvas = document.createElement("canvas");
            this._clipAdjustedCanvas = document.createElement("canvas");
            this._clipMaskCanvas = document.createElement("canvas");
            this._clipOriginalCtx = this._clipOriginalCanvas.getContext("2d", {willReadFrequently: true});
            this._clipAdjustedCtx = this._clipAdjustedCanvas.getContext("2d", {willReadFrequently: true});
            this._clipMaskCtx = this._clipMaskCanvas.getContext("2d");
        }

        for (const canvas of [this._clipOriginalCanvas, this._clipAdjustedCanvas, this._clipMaskCanvas]) {
            if (canvas.width !== sourceWidth || canvas.height !== sourceHeight) {
                canvas.width = sourceWidth;
                canvas.height = sourceHeight;
            }
        }

        this.drawClipComparisonFrame(this._clipOriginalCtx, image, sourceWidth, sourceHeight, "none", null);
        this.drawClipComparisonFrame(this._clipAdjustedCtx, sourceImage, sourceWidth, sourceHeight, adjusted.filter || "none", adjusted.fullABOverlay);

        const originalData = this._clipOriginalCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;
        const adjustedData = this._clipAdjustedCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;
        const maskImage = this._clipMaskCtx.createImageData(sourceWidth, sourceHeight);
        const maskData = maskImage.data;

        let shadowCount = 0;
        let highlightCount = 0;
        for (let i = 0; i < adjustedData.length; i += 4) {
            const adjustedR = adjustedData[i];
            const adjustedG = adjustedData[i + 1];
            const adjustedB = adjustedData[i + 2];
            const originalR = getClipComparisonValue(originalData[i], adjusted.invertActive);
            const originalG = getClipComparisonValue(originalData[i + 1], adjusted.invertActive);
            const originalB = getClipComparisonValue(originalData[i + 2], adjusted.invertActive);
            const shadowClipped = this.showShadowClipMask &&
                ((adjustedR === 0 && originalR !== 0) ||
                    (adjustedG === 0 && originalG !== 0) ||
                    (adjustedB === 0 && originalB !== 0));
            const highlightClipped = this.showHighlightClipMask &&
                ((adjustedR === 255 && originalR !== 255) ||
                    (adjustedG === 255 && originalG !== 255) ||
                    (adjustedB === 255 && originalB !== 255));

            if (highlightClipped) {
                maskData[i] = 255;
                maskData[i + 1] = 0;
                maskData[i + 2] = 0;
                maskData[i + 3] = 255;
                highlightCount++;
            } else if (shadowClipped) {
                maskData[i] = 0;
                maskData[i + 1] = 72;
                maskData[i + 2] = 255;
                maskData[i + 3] = 255;
                shadowCount++;
            }
        }

        this._clipMaskCtx.putImageData(maskImage, 0, 0);
        this._clipMaskShadowCount = shadowCount;
        this._clipMaskHighlightCount = highlightCount;
        return this._clipMaskCanvas;
    }

    drawClipComparisonFrame(ctx, image, width, height, filter, fullABOverlay) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = false;
        ctx.filter = filter;
        ctx.drawImage(image, 0, 0, width, height);
        if (fullABOverlay) {
            ctx.filter = "none";
            ctx.globalAlpha = fullABOverlay.opacity;
            ctx.drawImage(fullABOverlay.image, 0, 0, width, height);
        }
        ctx.restore();
    }

    drawClipWarningMask(maskCanvas, ctx) {
        if (!maskCanvas) return;

        ctx.save();
        ctx.filter = "none";
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = false;
        if (this.in.zoom !== undefined) {
            ctx.drawImage(maskCanvas, this.sx, this.sy, this.sWidth, this.sHeight,
                this.dx, this.dy, this.dWidth, this.dHeight);
        } else {
            ctx.drawImage(maskCanvas,
                0, 0, this.videoWidth, this.videoHeight,
                this.widthPx * (0.5 + this.posLeft), this.heightPx * 0.5 + this.widthPx * this.posTop,
                this.widthPx * (this.posRight - this.posLeft), this.widthPx * (this.posBot - this.posTop));
        }
        ctx.restore();
    }

    // Regression settle gate: is this view's CURRENT display frame decoded and
    // ready to render? A visible video view that is still loading its source, or
    // whose current frame hasn't decoded yet, must hold the settle open — otherwise
    // (especially under concurrent load, where decode is slower) the screenshot can
    // be captured over a stale or blank video region, producing a non-deterministic
    // diff. Mirrors the display-frame mapping used by renderCanvas(). Returns true
    // (ready, no gating) for hidden views and empty drop targets.
    isSettleVideoReady() {
        if (!this.visible) return true;
        if (this.videoLoadPending || this.pendingVideoRestore) return false;
        if (!this.videoData) return true;
        let frame = Math.round(par.frame ?? 0);
        if (this.lockToInFrame) frame = Math.max(0, frame - (Sit.aFrame ?? 0));
        if (typeof this.videoData.isFrameLoaded !== 'function') return true;
        return this.videoData.isFrameLoaded(frame);
    }

    renderCanvas(frame = 0) {
        super.renderCanvas(frame); // needed for setting window size

        if (!this.visible) return;

        // if no video file, this is just a drop target for now
        if (!this.videoData) return;

        // "Lock to in frame": play this video relative to the in point (Sit.aFrame)
        // so its first frame appears when the global playhead reaches the in frame.
        // Clamp to 0 so the video shows its first frame before the in point.
        if (this.lockToInFrame) {
            frame = Math.max(0, frame - (Sit.aFrame ?? 0));
        }

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

            ctx.imageSmoothingEnabled = quickToggle("Smooth", false, guiVideoEffectsFolder);

            const elaOverlay = this.getELAOverlayState(frame, image);
            if (elaOverlay.enabled) {
                this.requestELAOverlay(image, elaOverlay);
            }
            const noiseOverlay = this.getNoiseOverlayState(frame, image);
            if (noiseOverlay.enabled) {
                this.requestNoiseOverlay(image, noiseOverlay);
            }

            const adjustedFrame = this.getAdjustedVideoFrameSource(image, frame);
            const {sourceImage, filter, fullABOverlay} = adjustedFrame;

            ctx.filter = filter || 'none';

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

            if (fullABOverlay) {
                ctx.save();
                ctx.filter = 'none';
                ctx.globalAlpha = fullABOverlay.opacity;
                if (this.in.zoom !== undefined) {
                    ctx.drawImage(fullABOverlay.image, this.sx, this.sy, this.sWidth, this.sHeight,
                        this.dx, this.dy, this.dWidth, this.dHeight);
                } else {
                    ctx.drawImage(fullABOverlay.image,
                        0, 0, this.videoWidth, this.videoHeight,
                        this.widthPx * (0.5 + this.posLeft), this.heightPx * 0.5 + this.widthPx * this.posTop,
                        this.widthPx * (this.posRight - this.posLeft), this.widthPx * (this.posBot - this.posTop));
                }
                ctx.restore();
            }

            if (elaOverlay.enabled && this._elaResultCanvas) {
                ctx.save();
                ctx.filter = 'none';
                ctx.globalAlpha = elaOverlay.opacity;
                if (this.in.zoom !== undefined) {
                    ctx.drawImage(this._elaResultCanvas, this.sx, this.sy, this.sWidth, this.sHeight,
                        this.dx, this.dy, this.dWidth, this.dHeight);
                } else {
                    ctx.drawImage(this._elaResultCanvas,
                        0, 0, this.videoWidth, this.videoHeight,
                        this.widthPx * (0.5 + this.posLeft), this.heightPx * 0.5 + this.widthPx * this.posTop,
                        this.widthPx * (this.posRight - this.posLeft), this.widthPx * (this.posBot - this.posTop));
                }
                ctx.restore();
            }

            if (noiseOverlay.enabled && this._noiseResultCanvas) {
                ctx.save();
                ctx.filter = 'none';
                ctx.globalAlpha = noiseOverlay.opacity;
                if (this.in.zoom !== undefined) {
                    ctx.drawImage(this._noiseResultCanvas, this.sx, this.sy, this.sWidth, this.sHeight,
                        this.dx, this.dy, this.dWidth, this.dHeight);
                } else {
                    ctx.drawImage(this._noiseResultCanvas,
                        0, 0, this.videoWidth, this.videoHeight,
                        this.widthPx * (0.5 + this.posLeft), this.heightPx * 0.5 + this.widthPx * this.posTop,
                        this.widthPx * (this.posRight - this.posLeft), this.widthPx * (this.posBot - this.posTop));
                }
                ctx.restore();
            }

            this.drawClipWarningMask(this.getClipWarningMask(image, adjustedFrame), ctx);

            if (flowRotation !== 0) {
                ctx.restore();
            }



            ctx.filter = 'none';


        }

        this.drawCrosshairIfKeyHeld();
    }


    restartFullABEchoIfActive() {
        const isEcho = this.in.fullABEcho?.value;
        const isBlend = this.in.fullABBlend?.value;
        const isExposure = this.in.fullABExposure?.value;
        if (!isEcho && !isBlend && !isExposure) return;
        if (this._fullABEchoRunning) {
            this._fullABEchoRunning = false;
            Globals.justVideoAnalysis = false;
            par.paused = this._fullABEchoSavedPaused ?? false;
        }
        this._fullABEchoResult = null;

        if (isExposure) {
            this.startFullABExposure();
            return;
        }

        if (isBlend) {
            this.startFullABBlend();
            return;
        }

        const wantMin = this.in.echoMin?.value ?? false;
        const wantMax = this.in.echoMax?.value ?? false;
        if (!wantMin && !wantMax) {
            setRenderOne(true);
            return;
        }

        this.startFullABEcho();
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
        this.panOffsetX = 0;
        this.panOffsetY = 0;
        this.positioned = true;
        setRenderOne(true);
    }

    // Clamp panOffset so the source crop stays within the image bounds
    clampPanOffset() {
        if (this.in.zoom === undefined) return;
        const zoom = this.in.zoom.v0 / 100;
        if (zoom <= 1) {
            this.panOffsetX = 0;
            this.panOffsetY = 0;
            return;
        }
        // At zoom z, visible fraction is 1/z. Max panOffset = (1 - 1/z) / 2
        const maxPan = (1 - 1 / zoom) / 2;
        this.panOffsetX = Math.max(-maxPan, Math.min(maxPan, this.panOffsetX));
        this.panOffsetY = Math.max(-maxPan, Math.min(maxPan, this.panOffsetY));
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

            this.sWidth = sourceW / zoom;
            this.sHeight = sourceH / zoom;

            // Apply pan offset (panOffsetX/Y are fractions of video dimensions, 0 = centered)
            this.sx = (sourceW - this.sWidth) / 2 + this.panOffsetX * sourceW;
            this.sy = (sourceH - this.sHeight) / 2 + this.panOffsetY * sourceH;

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

// Install ELA, Noise and Full A-B analysis overlay methods on the prototype.
Object.assign(CNodeVideoView.prototype, analysisMethods);
