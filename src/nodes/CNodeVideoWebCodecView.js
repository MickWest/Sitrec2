/**
 * Module: WebCodec-backed video view node.
 *
 * Responsibilities:
 * - Extend CNodeVideoView with codec-specific upload/open/download behavior.
 * - Instantiate the appropriate video data implementation for media type.
 * - Resolve stored Sitrec object references when downloading/restoring remote video assets.
 */
import {CNodeVideoView} from "./CNodeVideoView";
import {par} from "../par";
import {FileManager, Globals} from "../Globals";

import {SITREC_APP} from "../configUtils";
import {CVideoMp4Data, detectVideoContainer} from "../CVideoMp4Data";
import {CVideoH264Data} from "../CVideoH264Data";
import {CVideoAudioOnly} from "../CVideoAudioOnly";
import {isAudioOnlyFormat} from "../AudioFormats";
import {VideoLoadingManager} from "../CVideoLoadingManager";
import {resolveURLForFetch} from "../SitrecObjectResolver";
import {showError} from "../showError";
import {TSParser} from "../TSParser";
import {t} from "../i18n";
import {EventManager} from "../CEventManager";

export class CNodeVideoWebCodecView extends CNodeVideoView {
    constructor(v) {
        super(v);


    }

    toSerializeCNodeVideoCodecView = ["fileName"]

    modSerialize() {
        return {
            ...super.modSerialize(),
            ...this.simpleSerialize(this.toSerializeCNodeVideoCodecView)

        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.simpleDeserialize(v, this.toSerializeCNodeVideoCodecView)
        this.positioned = true;
    }



    addDownloadButton() {
        this.removeDownloadButton()
        // make a URL from the name, adding


        // url is either absolute or relative
        // if absolte, then we just return it
        // if it's a relative URL, then we need to add the domain
        // and account for ../
        // a relative path would be something like
        // ../sitrec-videos/private/Area6-1x-speed-08-05-2023 0644UTC.mp4
        // and the root would be something like
        // https://www.metabunk.org/sitrec/
        function getAbsolutePath(url, root) {
            if (url.startsWith("http")) {
                return url;
            }
            if (url.startsWith("../")) {
                // trim the root to the second to last /
                let lastSlash = root.lastIndexOf("/", root.length - 2);
                root = root.slice(0, lastSlash + 1);
                return root + url.slice(3);
            }
            return root + url;
        }

        // add a gui link to the file manager gui
        // this will allow the user to download the file
        // or delete it.
        // this will be removed when the node is disposed
        // so we don't need to worry about it.

        // Define an object to hold button functions
        const obj = {
            openURL: async () => {
                // we have a url to the video file and want to let the user download it
                // so we create a link and click it.
                // this will download the file.
                
                // Temporarily set flag to allow unload without dialog
                Globals.allowUnload = true;
                
                // `staticURL` may now hold an object ref (sitrec:// or raw key), so resolve it before download.
                const storedRef = this.staticURL || getAbsolutePath(this.fileName, SITREC_APP);
                const url = await resolveURLForFetch(storedRef).catch(() => storedRef);
                const link = document.createElement('a');

                // Don't encode the URL if it's already encoded (e.g., from S3)
                // Only encode if it contains unencoded spaces or special characters
                // Check if URL is already encoded by looking for % followed by hex digits
                const isAlreadyEncoded = /%[0-9A-Fa-f]{2}/.test(url);
                const sanitizedUrl = isAlreadyEncoded ? url : encodeURI(url);
                // Resolve relative URLs, then block dangerous schemes like javascript:
                const resolved = new URL(sanitizedUrl, window.location.href);
                if (!/^(https?:|blob:|data:)$/i.test(resolved.protocol)) {
                    console.warn('Blocked download with unsupported URL scheme:', sanitizedUrl);
                    return;
                }
                link.href = resolved.href;

                link.download = this.videos?.[this.currentVideoIndex]?.fileName || this.fileName;

                console.log("Downloading: " + link.href + " as " + link.download)

                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                // Restore the beforeunload protection after a short delay
                setTimeout(() => {
                    Globals.allowUnload = false;
                }, 100);

            }
        };

        // Add a button to the GUI
        this.button = FileManager.guiFolder.add(obj, 'openURL').name(t("misc.downloadVideo.label"));
    }

    removeDownloadButton() {
        if (this.button) {
            this.button.destroy();
            this.button = undefined;
        }
    }




    async uploadFile(file, autoAdd = false) {
        const hasExistingVideo = this.videoData !== null && this.videoData !== undefined;
        
        if (hasExistingVideo && !autoAdd) {
            if (this.alwaysReplace) {
                this.disposeAllVideos();
            } else {
                const action = await this.promptAddOrReplace();
                if (action === "replace") {
                    this.disposeAllVideos();
                } else {
                    this.updateCurrentVideoEntry();
                    this.videoData?.stopStreaming?.();
                }
            }
        } else if (hasExistingVideo && autoAdd) {
            this.updateCurrentVideoEntry();
            this.videoData?.stopStreaming?.();
        }

        await this._doUploadFile(file);
    }

    async _doUploadFile(file) {
        this.fileName = file.name;
        this.staticURL = undefined;
        EventManager.dispatchEvent("videoImportStarted", {viewId: this.id, fileName: file.name});

        this.addLoadingMessage()

        Globals.pendingActions++;
        this.videoLoadPending = true;

        const fileName = file.name.toLowerCase();

        // Audio-only files bypass container detection
        if (isAudioOnlyFormat(fileName) ||
            (fileName.endsWith('.mp4') && file.type && file.type.startsWith('audio/'))) {
            console.log("Using audio-only handler for: " + file.name);
            this.videoData = new CVideoAudioOnly({id: this.id + "_data_" + this.videos.length, dropFile: file},
                this.loadedCallback.bind(this), this.errorCallback.bind(this));
            this._finishUploadSetup(file);
            return;
        }

        // Peek at magic bytes to identify the real container — extensions lie
        // (e.g. a .mpg file that is actually MPEG-TS inside). Only 512 bytes
        // are read here; File.slice() does not pull the rest into memory.
        let detection = null;
        try {
            const headerBuf = await file.slice(0, 512).arrayBuffer();
            detection = detectVideoContainer(headerBuf);
            console.log(`[Upload] Container detected as "${detection.format}" for "${file.name}"`);
        } catch (err) {
            console.warn(`[Upload] Could not read header for "${file.name}":`, err);
        }

        // MPEG-TS: extract the H.264 elementary stream via TSParser and hand
        // it to CVideoH264Data. Works regardless of file extension, so a .mpg
        // that is actually TS loads transparently.
        if (detection && detection.format === "MPEG-TS") {
            await this._loadTsFileAsVideo(file);
            return;
        }

        // Clearly-unsupported containers (MPEG-PS, AVI, MKV, WebM, FLV, Ogg,
        // MPEG-1 video ES): fail fast with a single clear error. Unknown
        // signatures fall through to the MP4 path where the watchdog catches
        // genuine parse hangs.
        if (detection && !detection.supported &&
            detection.format !== "Raw H.264 (Annex-B)" &&
            detection.format !== "unknown") {
            this._abortUnsupportedUpload(file, detection);
            return;
        }

        // Raw H.264 Annex-B stream (by extension, MIME, or magic bytes)
        if ((detection && detection.format === "Raw H.264 (Annex-B)") ||
            fileName.endsWith('.h264') || fileName.endsWith('.dad') ||
            file.type === 'video/h264') {
            console.log("Using H.264 specialized handler for: " + file.name);
            this.videoData = new CVideoH264Data({id: this.id + "_data_" + this.videos.length, dropFile: file, ownsTimeline: this.ownsTimeline},
                this.loadedCallback.bind(this), this.errorCallback.bind(this));
        } else {
            // Default: MP4 / ISO-BMFF path (with internal getConfig watchdog)
            this.videoData = new CVideoMp4Data({id: this.id + "_data_" + this.videos.length, dropFile: file, ownsTimeline: this.ownsTimeline},
                this.loadedCallback.bind(this), this.errorCallback.bind(this));
        }

        this._finishUploadSetup(file);
    }

    /**
     * Complete the per-file setup common to every upload path: register the
     * load with VideoLoadingManager, stamp _loadingId so the pending-actions
     * diagnostic can track it, and add the video entry to the menu.
     */
    _finishUploadSetup(file) {
        const videoDataId = this.videoData.id;
        VideoLoadingManager.registerLoading(videoDataId, file.name);
        this.videoData._loadingId = videoDataId;
        // Replay any milestone set before _loadingId was assigned so the
        // diagnostic reflects the latest known state.
        if (this.videoData._lastStatus) {
            VideoLoadingManager.setStatus(videoDataId, this.videoData._lastStatus);
        }

        this.addVideoEntry(file.name, undefined, false);

        // Only the timeline-owning (primary) view resets the playhead on load.
        // A secondary "video2" view must not, or dropping a second clip yanks
        // the shared playhead back to 0 (see C1 in the 2.70.0 merge review).
        if (this.ownsTimeline) {
            par.frame = 0;
            par.paused = false;
        }
    }

    /**
     * Abort the load with a single, user-focused error for a container type
     * Sitrec can't handle. No videoData is created, so we decrement
     * pendingActions directly and update the overlay to show the error state.
     */
    _abortUnsupportedUpload(file, detection) {
        const lines = [
            `Cannot load "${file.name}" — ${detection.format} not supported.`,
            ``,
            detection.description,
            `Sitrec needs an MP4/MOV container.`,
        ];
        if (detection.hint) lines.push(``, `Fix: ${detection.hint}`);
        const message = lines.join("\n");

        console.error(
            `[Upload] Rejecting "${file.name}" — container "${detection.format}". ` +
            `First 32 bytes: ${detection.headerHex}`
        );
        showError(message);

        Globals.pendingActions--;
        this.videoLoadPending = false;
        this._showUploadError(file.name);
    }

    /**
     * Auto-extract H.264 from an MPEG-TS container and hand it to the H.264
     * video data class. The TSParser is the same one CFileManager uses for
     * .ts files — we reuse it here so .mpg-with-TS-inside (common from some
     * cameras/recorders) loads transparently instead of hanging MP4Box.
     */
    async _loadTsFileAsVideo(file) {
        console.log(`[Upload] Auto-extracting H.264 from MPEG-TS container "${file.name}"`);
        try {
            const buffer = await file.arrayBuffer();
            const streams = TSParser.extractTSStreams(buffer);

            if (!streams || streams.length === 0) {
                throw new Error("no elementary streams found in MPEG-TS container");
            }

            console.log(`[Upload] TSParser extracted ${streams.length} stream(s):`);
            streams.forEach((s, i) => console.log(
                `  [${i}] PID ${s.pid} type=${s.type} codec_type=${s.codec_type} ` +
                `size=${s.data.byteLength} bytes` +
                (s.fps ? ` @ ${s.fps.toFixed(2)} fps` : "")
            ));

            const videoStream = streams.find(s =>
                s.codec_type === "video" &&
                (s.type === "h264" || s.extension === "h264")
            );

            if (!videoStream) {
                const foundTypes = streams
                    .map(s => `${s.type || "?"}/${s.codec_type || "?"}`)
                    .join(", ");
                throw new Error(
                    `no H.264 video stream found in the MPEG-TS container ` +
                    `(streams present: ${foundTypes}). Only H.264 auto-extraction ` +
                    `is supported — re-encode with ffmpeg to MP4:\n` +
                    `  ffmpeg -i "${file.name}" -c:v libx264 -c:a aac -movflags +faststart output.mp4`
                );
            }

            console.log(
                `[Upload] Feeding H.264 stream to CVideoH264Data: PID ${videoStream.pid}, ` +
                `${videoStream.data.byteLength.toLocaleString()} bytes` +
                (videoStream.fps ? `, ${videoStream.fps.toFixed(2)} fps` : "")
            );

            this.videoData = new CVideoH264Data({
                id: this.id + "_data_" + this.videos.length,
                buffer: videoStream.data,
                filename: file.name,
                fps: videoStream.fps || undefined,
                ownsTimeline: this.ownsTimeline,
            }, this.loadedCallback.bind(this), this.errorCallback.bind(this));

            this._finishUploadSetup(file);
        } catch (err) {
            console.error(`[Upload] MPEG-TS extraction failed for "${file.name}":`, err);
            showError(
                `Cannot load "${file.name}" — MPEG-TS extraction failed.\n\n` +
                (err.message || String(err))
            );
            Globals.pendingActions--;
            this.videoLoadPending = false;
            this._showUploadError(file.name);
        }
    }

    /**
     * Update the overlay to the "Error Loading" state used by errorCallback.
     * Factored out so _abortUnsupportedUpload and _loadTsFileAsVideo can
     * share it without creating a dummy videoData first.
     */
    _showUploadError(fileName) {
        if (!this.overlay) return;
        this.overlay.removeText("videoLoading");
        if (this.overlay.canvas) this.overlay.canvas.style.display = '';
        this.overlay.addText("videoError", "Error Loading", 50, 45, 5, "#f0f000", "center");
        this.overlay.addText("videoErrorName", fileName, 50, 55, 1.5, "#f0f000", "center");
    }



    requestAndLoadFile() {
        par.paused = true;
        var input = document.createElement('input');
        input.type = 'file';

        input.onchange = e => {
            var file = e.target.files[0];
            this.uploadFile(file)
            input.remove();
        }

        input.click();
    }


    dispose() {
        super.dispose()
        this.removeDownloadButton();
    }


}
