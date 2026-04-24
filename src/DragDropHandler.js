//////////////////////////////////////////////////////
///  DRAG AND DROP FILES?
import {FileManager, Globals, markSitchDirty, NodeMan, Sit, Synth3DManager} from "./Globals";
import {cos, isSubdomain, radians} from "./utils";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {getLocalSouthVector, getLocalUpVector} from "./SphericalMath";
import {SITREC_DEV_DOMAIN, SITREC_DOMAIN} from "./configUtils";

import {EventManager} from "./CEventManager";
import {MP4_DEMUXER_EXTENSIONS, WEBAUDIO_SUPPORTED_EXTENSIONS} from "./AudioFormats";
import {ViewMan} from "./CViewManager";
import {quickFetch} from "./quickFetch";
import {isResolvableSitrecReference, resolveURLForFetch} from "./SitrecObjectResolver";
import {convertTiffBufferToBlobURL} from "./TIFFUtils";
import {extractJPEGImportMetadata} from "./EXIFUtils";

// Image file extensions
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'jp2', 'j2k', 'jpx', 'jpc', 'j2c'];

// The DragDropHandler is more like the local client file handler, with rehosting, and parsing
class CDragDropHandler {

    constructor() {
        this.dropAreas = [];
        this.dropQueue = []; // Queue for dropped files that need parsing
        this.pendingDropFiles = []; // Files dropped before a sitch was loaded (e.g. on sitch browser)
    }

    /**
     * Shows a modal dialog asking the user to choose between video image and ground overlay
     * @param {string} filename - The name of the image file
     * @returns {Promise<string>} Resolves with 'video' or 'overlay', or rejects if cancelled
     */
    showImageChoiceDialog(filename) {
        return new Promise((resolve, reject) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            // Create modal dialog
            const modal = document.createElement('div');
            modal.style.cssText = `
                background: #2a2a2a;
                border-radius: 8px;
                padding: 20px;
                min-width: 300px;
                max-width: 400px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                font-family: Arial, sans-serif;
                color: white;
            `;

            // Create title
            const title = document.createElement('h3');
            title.textContent = 'Import Image';
            title.style.cssText = `
                margin: 0 0 10px 0;
                font-size: 18px;
                color: #fff;
            `;

            // Create message
            const message = document.createElement('p');
            message.textContent = `How would you like to use "${filename}"?`;
            message.style.cssText = `
                margin: 0 0 20px 0;
                font-size: 14px;
                color: #ccc;
            `;

            // Button styles
            const buttonStyle = `
                padding: 10px 20px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                margin: 5px;
                width: calc(100% - 10px);
            `;

            // Create video image button
            const videoButton = document.createElement('button');
            videoButton.textContent = 'Video Image (static video source)';
            videoButton.style.cssText = buttonStyle + `
                background: #1976d2;
                color: white;
            `;
            videoButton.onclick = () => {
                document.body.removeChild(overlay);
                resolve('video');
            };

            // Create overlay button
            const overlayButton = document.createElement('button');
            overlayButton.textContent = 'Ground Overlay (map overlay)';
            overlayButton.style.cssText = buttonStyle + `
                background: #388e3c;
                color: white;
            `;
            overlayButton.onclick = () => {
                document.body.removeChild(overlay);
                resolve('overlay');
            };

            // Create cancel button
            const cancelButton = document.createElement('button');
            cancelButton.textContent = 'Cancel';
            cancelButton.style.cssText = buttonStyle + `
                background: #757575;
                color: white;
            `;
            cancelButton.onclick = () => {
                document.body.removeChild(overlay);
                reject(new Error('User cancelled'));
            };

            // Assemble the modal
            modal.appendChild(title);
            modal.appendChild(message);
            modal.appendChild(videoButton);
            modal.appendChild(overlayButton);
            modal.appendChild(cancelButton);
            overlay.appendChild(modal);

            // Add to document
            document.body.appendChild(overlay);
        });
    }

    /**
     * Check if a filename is an image file
     * @param {string} filename - The filename to check
     * @returns {boolean} True if the file is an image
     */
    isImageFile(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return IMAGE_EXTENSIONS.includes(ext);
    }

    addDropArea() {

        if (Globals.isMobile) {
            console.log("Mobile device detected, skipping drag-and-drop zone");
            return;
        }
        
        if (this.dropZone !== undefined) {
//            console.warn("DropZone already exists");
            return;
        }
        this.dropZone = document.createElement('div');
        const dropZone = this.dropZone;
        dropZone.style.position = 'fixed';
        dropZone.style.top = '0';
        dropZone.style.left = '0';
        dropZone.style.width = '100vw';
        dropZone.style.height = '100vh';
        dropZone.style.display = 'flex';
        dropZone.style.justifyContent = 'center';
        dropZone.style.alignItems = 'center';
        dropZone.style.fontSize = '48px';
        dropZone.style.color = '#fff';
        dropZone.style.transition = 'background-color 0.2s, opacity 5s';
        dropZone.style.pointerEvents = 'none';
        dropZone.style.zIndex = '9999'; // High z-index to overlay other elements
        dropZone.innerHTML = 'DROP FILES <br>OR URLS<br>HERE';

        if (!Sit.initialDropZoneAnimation || Globals.fixedFrame !== undefined) {
            dropZone.style.visibility = 'hidden'; // Initially hidden
        }
        // 10px red border
        dropZone.style.border = '2px solid red';
        dropZone.style.boxSizing = 'border-box';


        document.body.appendChild(dropZone);

        // make it transition over 2 seconds from visible to invisible
        requestAnimationFrame(() => {
            dropZone.style.opacity = '0';
        })

        function handleDragOver(event) {
            event.preventDefault(); // Necessary to allow a drop
        }

        document.body.addEventListener('dragenter', (event) => {
            this.showDropZone();
        });

        document.body.addEventListener('dragover', handleDragOver);

        document.body.addEventListener('dragleave', (event) => {
            // Hide only if the cursor leaves the document
            if (event.relatedTarget === null) {
                this.hideDropZone();
            }
        });

        document.body.addEventListener('drop', this.onDrop.bind(this));

        // Process any files that were dropped on the sitch browser before this sitch loaded
        if (this.pendingDropFiles.length > 0) {
            const pending = this.pendingDropFiles;
            this.pendingDropFiles = [];
            console.log("Processing " + pending.length + " deferred drop file(s)");
            for (const file of pending) {
                this.uploadDroppedFile(file, file.name);
            }
        }
    }

    showDropZone(message) {
        if (message !== undefined) {
            this.dropZone.innerHTML = message;
        }
        this.dropZone.style.opacity = '1';
        this.dropZone.style.transition = 'background-color 0.2s, opacity 0.2s';
        this.dropZone.style.visibility = 'visible';
        this.dropZone.style.backgroundColor = 'rgba(0,0,0,0.5)';
        this.dropZone.style.pointerEvents = 'all'; // Enable pointer events when showing
    }

    hideDropZone() {
        this.dropZone.style.visibility = 'hidden';
        this.dropZone.style.backgroundColor = 'transparent';
        this.dropZone.style.pointerEvents = 'none'; // Disable pointer events when hidden
    }

    handlerFunction(event) {
        event.preventDefault()
    }

    onDrop(e) {
        this.dropQueue = [];
        e.preventDefault();
        this.hideDropZone();
        // Don't mark dirty here — wait until a file is actually processed
        // (cancelled dialogs, unsupported files, or invalid drops shouldn't arm beforeunload)
        // we defer the checkDrop to a check in the main loop
        // to simplify debugging.
        const dt = e.dataTransfer;

        // If files were dragged and dropped
        if (dt.files && dt.files.length > 0) {
            console.log("LOADING DROPPED FILE:" + dt.files[0].name);
            for (const file of dt.files) {
                this.uploadDroppedFile(file, file.name);
            }
        }
// If a plain text snippet or URL was dragged and dropped
        else {
            let url = dt.getData('text/plain');
            if (url) {
                console.log("LOADING DROPPED text:" + url);
                // check if it's not a valid URL
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    this.uploadText(url);
                } else {

                    this.uploadURL(url);
                }
            }
        }

    }


    async uploadDroppedFile(file) {

        EventManager.dispatchEvent("fileDropped", {})

        // Check if it's an image file - ask user how to use it
        if (this.isImageFile(file.name)) {
            // If video node exists and has alwaysReplace, skip dialog and load as video
            if (NodeMan.exists("video") && NodeMan.get("video").alwaysReplace) {
                console.log("Loading image as video source (alwaysReplace): " + file.name);
                await this.loadImageAsVideoSource(file);
                return;
            }

            try {
                const choice = await this.showImageChoiceDialog(file.name);

                if (choice === 'video') {
                    // Load as video image source using makeImageVideo
                    console.log("Loading image as video source: " + file.name);
                    if (NodeMan.exists("video")) {
                        await this.loadImageAsVideoSource(file);
                    } else {
                        console.warn("No video node found to load image as video source");
                    }
                    return;
                } else if (choice === 'overlay') {
                    // Create ground overlay with the image
                    console.log("Creating ground overlay with image: " + file.name);
                    await this.createGroundOverlayFromImage(file);
                    return;
                }
            } catch (e) {
                // User cancelled
                console.log("Image import cancelled");
                return;
            }
        }

        // if it's a video or audio file, that's handled differently
        // as we might (in the future) want to stream it
        // NOTE: .ts files (MPEG Transport Stream) are NOT treated as video here
        // because they need special parsing in FileManager to extract multiple streams
        const isTSFile = /\.(ts|m2ts|mts)$/i.test(file.name);
        const allAudioExtensions = [...WEBAUDIO_SUPPORTED_EXTENSIONS, ...MP4_DEMUXER_EXTENSIONS];
        const audioExtPattern = new RegExp(`\\.(${allAudioExtensions.join('|')})$`, 'i');
        const isAudioFile = audioExtPattern.test(file.name) || file.type.startsWith("audio");

        if (!isTSFile && (file.type.startsWith("video") || isAudioFile)) {
            console.log("Loading dropped " + (isAudioFile ? "audio" : "video") + " file: " + file.name);
            if (!NodeMan.exists("video")) {
                console.warn("No video node found to load " + (isAudioFile ? "audio" : "video") + " file");
                return;
            }
            NodeMan.get("video").uploadFile(file);
            markSitchDirty();
            return;
        }

        console.log("")
        console.log("##############################################################")
        console.log("### Uploading dropped file: " + file.name)

        // otherwise we load and then parse the file with the FileManager
        // and then decide what to do with it based on the file extension

        let promise = new Promise((resolve, reject) => {
            let reader = new FileReader();
            reader.readAsArrayBuffer(file);
            reader.onloadend = () => {
                this.queueResult(file.name, reader.result, null);
            };
        });

        return promise;
    }

    /**
     * Load an image file and set it as the video source
     * Also registers it with FileManager for persistence
     * @param {File} file - The image file
     */
    async loadImageAsVideoSource(file) {
        const videoNode = NodeMan.get("video");
        const hasExistingVideo = videoNode.videoData !== null && videoNode.videoData !== undefined;
        
        if (hasExistingVideo) {
            if (videoNode.alwaysReplace) {
                videoNode.disposeAllVideos();
            } else {
                const action = await videoNode.promptAddOrReplace();
                if (action === "replace") {
                    videoNode.disposeAllVideos();
                }
            }
        }

        // Read file as ArrayBuffer for FileManager registration
        const arrayBuffer = await file.arrayBuffer();
        const importMetadata = await extractJPEGImportMetadata(arrayBuffer, file.name).catch(error => {
            console.warn(`[EXIF] Failed to parse metadata for ${file.name}:`, error);
            return null;
        });

        // Register with FileManager so it persists across saves
        FileManager.list[file.name] = {
            filename: file.name,
            data: arrayBuffer,
            original: arrayBuffer,
            dynamicLink: true,
            dataType: "videoImage",
            handled: true  // Mark as handled so it doesn't get processed again
        };

        const ext = file.name.split('.').pop().toLowerCase();
        let imageURL;

        const j2kExtensions = ['jp2', 'j2k', 'jpx', 'jpc', 'j2c'];
        if (j2kExtensions.includes(ext)) {
            // Browser can't decode JP2 natively — decode to Image directly
            const {decodeJPEG2000ToImage} = await import("./JPEG2000Utils");
            const img = await decodeJPEG2000ToImage(arrayBuffer);
            videoNode.makeImageVideo(file.name, img, false, file.name, importMetadata, true);
            videoNode.imageFileID = file.name;
            console.log(`Loaded J2K image "${file.name}" as video source (${img.width}x${img.height})`);
            markSitchDirty();
            return;
        }

        if (ext === 'tif' || ext === 'tiff') {
            imageURL = await convertTiffBufferToBlobURL(arrayBuffer);
        } else {
            const blob = new Blob([arrayBuffer], { type: file.type });
            imageURL = URL.createObjectURL(blob);
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                videoNode.makeImageVideo(file.name, img, false, file.name, importMetadata, true);
                videoNode.imageFileID = file.name;
                console.log(`Loaded image "${file.name}" as video source (${img.width}x${img.height})`);
                markSitchDirty();
                resolve();
            };
            img.onerror = () => {
                console.error("Failed to load image: " + file.name);
                reject(new Error("Failed to load image"));
            };
            img.src = imageURL;
        });
    }

    /**
     * Create a ground overlay from an image file
     * Also registers it with FileManager for persistence
     * Places the overlay at the center of the screen on the ground
     * @param {File} file - The image file
     */
    async createGroundOverlayFromImage(file) {
        // Read file as ArrayBuffer for FileManager registration
        const arrayBuffer = await file.arrayBuffer();

        let imageURL;
        const ext = file.name.split('.').pop().toLowerCase();

        const j2kExts = ['jp2', 'j2k', 'jpx', 'jpc', 'j2c'];
        if (ext === 'tif' || ext === 'tiff') {
            imageURL = await convertTiffBufferToBlobURL(arrayBuffer);
        } else if (j2kExts.includes(ext)) {
            const {decodeJPEG2000ToBlobURL} = await import("./JPEG2000Utils");
            imageURL = await decodeJPEG2000ToBlobURL(arrayBuffer);
        } else {
            const blob = new Blob([arrayBuffer], { type: file.type });
            imageURL = URL.createObjectURL(blob);
        }

        // Register with FileManager so it persists across saves
        FileManager.list[file.name] = {
            filename: file.name,
            data: arrayBuffer,
            original: arrayBuffer,
            dynamicLink: true,
            dataType: "groundOverlayImage",
            blobURL: imageURL,
            handled: true  // Mark as handled so it doesn't get processed again
        };

        // Find ground point at center of screen
        let centerLLA;
        const view = ViewMan.get("mainView");
        if (view) {
            // Calculate screen center coordinates
            const centerX = view.leftPx + view.widthPx / 2;
            const centerY = view.topPx + view.heightPx / 2;

            // Get ground point at screen center
            const groundPoint = Synth3DManager.getGroundPoint(view, centerX, centerY);
            if (groundPoint) {
                centerLLA = ECEFToLLAVD_radii(groundPoint);
            }
        }

        // Fallback to camera position if no ground intersection
        if (!centerLLA) {
            const mainCamera = NodeMan.get("mainCamera").camera;
            const cameraPos = mainCamera.position.clone();
            centerLLA = ECEFToLLAVD_radii(cameraPos);
        }

        // Create overlay at the ground point with a reasonable size
        // Default to about 1km square (0.01 degrees ≈ 1.1km at equator)
        const offset = 0.005;

        const overlay = Synth3DManager.addOverlay({
            name: file.name.replace(/\.[^/.]+$/, ""), // Remove extension for name
            north: centerLLA.x + offset,
            south: centerLLA.x - offset,
            east: centerLLA.y + offset,
            west: centerLLA.y - offset,
            rotation: 0,
            imageURL: imageURL,
            imageFileID: file.name  // Link to FileManager entry
        });

        if (overlay) {
            // Enter edit mode so user can adjust position/size
            overlay.setEditMode(true);
            console.log(`Created ground overlay "${overlay.name}" from image at screen center`);
            markSitchDirty();
        }
    }



    async uploadURL(url) {
        // Check if the URL is from the same domain we are hosting on
        // later we might support other domains, and load them via proxy
        const urlObject = new URL(url);
        if (!isSubdomain(urlObject.hostname, SITREC_DOMAIN)
            && !isSubdomain(urlObject.hostname, SITREC_DEV_DOMAIN)
            && !isSubdomain(urlObject.hostname, "amazonaws.com")
        ) {
            // console.warn('The provided URL ' + urlObject.hostname +' is not from ' + SITREC_DOMAIN + " or " + SITREC_DEV_DOMAIN + "or amazonaws.com");

            // for non-local URLS, we check for info in the URL itself, like a lat, lon, alt location

            let lat, lon;
            let alt = 30000;    // default altitude (meters)

            const mainCamera = NodeMan.get("mainCamera").camera;

            // check from Google Maps URLs, and extract the location
            if (urlObject.hostname === "www.google.com" && urlObject.pathname.startsWith("/maps")) {

                // example URL from Google Maps
                // https://www.google.com/maps/place/Santa+Monica,+CA/@33.9948301,-118.4615695,67a,35y,116.89h,8.32t/data

                // first get the string after the @ from the string url, and split it by the comma
                const afterAt = url.split("@")[1].split("/data")[0];
                const parts = afterAt.split(",");
                if (parts.length > 1) {
                    const lat = parseFloat(parts[0]);
                    const lon = parseFloat(parts[1]);


                    // if part[2] ends in "m" or "a" then it's the vertical span of the map
                    // from that we can work out the altitude
                    if (parts[2].endsWith("m") || parts[2].endsWith("a")) {
                        const span = parseFloat(parts[2].slice(0, -1));
                        // given the camera Vertical FOV, we can work out the altitude
                        const vFOV = mainCamera.fov * Math.PI / 180;
                        alt = span / 2 / Math.tan(vFOV / 2);
                    }

                    console.log("Google Maps URL detected, extracting location: " + lat + ", " + lon, " Altitude: " + alt);

                }
            }


            // ADSBx example URL
            // https://globe.adsbexchange.com/?replay=2024-12-30-23:54&lat=39.948&lon=-73.938&zoom=11.8
            if (urlObject.hostname === "globe.adsbexchange.com") {
                lat = parseFloat(urlObject.searchParams.get("lat"));
                lon = parseFloat(urlObject.searchParams.get("lon"));
                let zoom = parseFloat(urlObject.searchParams.get("zoom"));

                // convert zoom to altitude
                // by first converting it to a tile size in meters
                let circumference = 40075000*cos(radians(lat));
                let span = circumference/Math.pow(2,zoom-1)
                const vFOV = mainCamera.fov * Math.PI / 180;
                alt = span / 2 / Math.tan(vFOV / 2);

            }

            // FR24 example URL
            // https://www.flightradar24.com/38.73,-120.56/9
            if (urlObject.hostname === "www.flightradar24.com") {
                let latlon = urlObject.pathname.split("/")[1];
                lat = parseFloat(latlon.split(",")[0]);
                lon = parseFloat(latlon.split(",")[1]);
                let zoom = parseFloat(urlObject.pathname.split("/")[2]);

                // convert zoom to altitude
                // by first converting it to a tile size in meters
                let circumference = 40075000*cos(radians(lat));
                let span = circumference/Math.pow(2,zoom-1)
                const vFOV = mainCamera.fov * Math.PI / 180;
                alt = span / 2 / Math.tan(vFOV / 2);
            }




            if (lat !== undefined && lon !== undefined) {
                this.droppedLLA(lat, lon, alt)
            }

            return;
        }

        // Route legacy Sitrec S3 URLs through the resolver so they become
        // same-origin fetches (object.php returns either a local upload URL
        // or the s3-proxy.php stream). Avoids CORS failures when the S3
        // bucket does not whitelist this origin.
        const fetchUrl = isResolvableSitrecReference(url)
            ? await resolveURLForFetch(url)
            : url;

        return quickFetch(fetchUrl, { showLoading: true, loadingCategory: "File" })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.arrayBuffer();
            })
            .then(buffer => {
                console.log(`Fetched ${url} successfully, queueing result for parsing`)
                this.queueResult(url, buffer, url)
            })
            .catch(error => {
                console.log('There was a problem with the fetch operation:', error.message);
            });
    }

    // dragged in a text snippet
    // check if it's a lat, lon, alt or just a lat, lon
    // 38.73,-120.56,100000 , or 38.73,-120.56
    uploadText(text) {
        // most likely LL or LLA
        const numbers = text.split(/[\s,]+/).map(parseFloat);
        if (numbers.length === 2) {
            // it's a lat, lon
            this.droppedLLA(numbers[0], numbers[1], 0);
        } else
        if (numbers.length === 3) {
            // it's a lat, lon, alt
            this.droppedLLA(numbers[0], numbers[1], numbers[2]);
        } else {
            console.log("Unhandled text snippet: " + text);
        }
    }


    droppedLLA(lat, lon, alt) {
        const mainCamera = NodeMan.get("mainCamera").camera;
        const camPos = LLAToECEF(lat, lon, alt);

        const target = LLAToECEF(lat, lon, 0);

        const up = getLocalUpVector(camPos);
        const south = getLocalSouthVector(camPos);
        camPos.add(south.clone().multiplyScalar(100)); // move camera 100 meter south, just so we orient norht

        // set the position to the target
        mainCamera.position.copy(camPos);
        // Set up to local up
        mainCamera.up.copy(up);
        // and look at the track point
        mainCamera.lookAt(target);
    }

    // Add a loaded file to the drop queue for later parsing
    // we do this from within the dragDropHandler event handler,
    // so we can control when the parsing happens in the event loop
    // and make it easier to debug (PHPStorm tends to break on debugging async event calls)
    // @param {string} filename - The name of the file
    // @param {ArrayBuffer} result - The raw file data
    // @param {string|null} newStaticURL - The static URL for the file, if applicable
    queueResult(filename, result, newStaticURL) {
        console.log("queueResult: Queuing " + filename + " for parsing")
        this.dropQueue.push({filename: filename, result: result, newStaticURL: newStaticURL});
    }

    // If there are loaded files in the queue, then parse them
    // this is called from the main loop
    // to allow for debugging
    checkDropQueue() {
        if (this.dropQueue.length > 0) {
            // Reset batch-scoped TLE flags at the start of each batch
            FileManager._tleMergeAll = false;
            FileManager._tleReplacedInBatch = false;
        }
        while (this.dropQueue.length > 0) {
            const drop = this.dropQueue.shift();
            console.log("checkDropQueue: Parsing queued file " + drop.filename)
            FileManager.parseResult(drop.filename, drop.result, drop.newStaticURL, {returnMeta: true})
                .then(({changesSerializedState}) => {
                    if (changesSerializedState) {
                        markSitchDirty();
                    }
                })
                .catch((error) => {
                    console.error("checkDropQueue: Failed to parse dropped file " + drop.filename, error);
                });
        }
    }
}

export const DragDropHandler = new CDragDropHandler();
