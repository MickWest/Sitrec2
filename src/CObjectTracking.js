import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit, unregisterFrameBlocker} from "./Globals";
import {par} from "./par";
import {getCV, loadOpenCV} from "./openCVLoader";
import {getJsfeat, loadJsfeat} from "./jsfeatLoader";
import {interpolatePosition} from "./CVideoData";
import {EventManager} from "./CEventManager";
import {createVideoExporter, DefaultVideoFormat, getBestFormatForResolution, getVideoExtension} from "./VideoExporter";
import {drawVideoWatermark, ExportProgressWidget, getExportPrefix} from "./utils";

let cv = null;

// Auto Tracking - Automatic object tracking using OpenCV template matching or centroid tracking
// This is distinct from Manual Tracking (CNodeTrackingOverlay) which requires manual keyframe placement
class ObjectTracker {
    constructor(videoView) {
        this.videoView = videoView;
        this.enabled = false;
        this.tracking = false;
        this.overlayCreated = false;
        this.overlay = null;
        this.overlayCtx = null;

        this.trackX = 0;
        this.trackY = 0;
        this.trackRadius = 30;

        this.trackedPositions = new Map();
        this.manualKeyframes = new Set();

        this.isDragging = false;
        this.draggingKeyframe = null;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.tracker = null;
        this.trackerType = 'CSRT';

        // Centroid tracking for bright spots (stars, etc)
        this.centerOnBright = false;
        this.brightnessThreshold = 128;  // 0-255, pixels above this are considered "bright"

        // Search radius - how far from previous position to search for template match
        this.searchRadius = 50;  // pixels

        // Tracking method: 'template' (OpenCV template matching) or 'opticalflow' (jsfeat Lucas-Kanade)
        this.trackingMethod = 'template';

        // Optical flow state (for absolute tracking from initial frame)
        this.initialGrayImage = null;
        this.initialPyramid = null;
        this.initialKeypoints = null;
        this.initialKeypointCoords = null;
        this.initialCenter = null;

        // Store initial template for absolute tracking (prevents drift)
        this.initialTemplate = null;
        this.initialTemplateFrame = null;

        this.guiFolder = null;
        this.savedPaused = true;
        this.savedFrame = undefined;

        // Track video dimensions to detect when video changes
        this.lastVideoWidth = 0;
        this.lastVideoHeight = 0;
        
        this.thresholdPreview = false;
    }
    
    createOverlay() {
        if (this.overlayCreated) return;
        this.overlayCreated = true;
        
        this.overlay = document.createElement('canvas');
        this.overlay.style.position = 'absolute';
        this.overlay.style.top = '0';
        this.overlay.style.left = '0';
        this.overlay.style.width = '100%';
        this.overlay.style.height = '100%';
        this.overlay.style.pointerEvents = 'none';
        this.overlay.style.zIndex = '100';
        this.videoView.div.appendChild(this.overlay);
        this.overlayCtx = this.overlay.getContext('2d');
        
        this.hookMouseHandler();
        
        const {width, height} = this.getImageDimensions();
        this.trackX = width / 2;
        this.trackY = height / 2;
    }
    
    hookMouseHandler() {
        const mouse = this.videoView.mouse;
        if (!mouse) return;
        
        const originalDrag = mouse.handlers.drag;
        
        mouse.handlers.down = (e) => {
            if (this.enabled) {
                const x = mouse.x;
                const y = mouse.y;
                const [vX, vY] = this.videoView.canvasToVideoCoords(x, y);
                
                const clickedKeyframe = this.findClickedKeyframe(vX, vY);
                if (clickedKeyframe !== null) {
                    this.isDragging = true;
                    this.draggingKeyframe = clickedKeyframe;
                    this.lastMouseX = vX;
                    this.lastMouseY = vY;
                } else if (this.isWithinTrackPoint(vX, vY)) {
                    this.isDragging = true;
                    this.draggingKeyframe = null;
                    this.lastMouseX = vX;
                    this.lastMouseY = vY;
                }
            }
        };
        
        mouse.handlers.drag = (e) => {
            if (this.enabled && this.isDragging) {
                const x = mouse.x;
                const y = mouse.y;
                const [vX, vY] = this.videoView.canvasToVideoCoords(x, y);
                
                const dx = vX - this.lastMouseX;
                const dy = vY - this.lastMouseY;
                this.lastMouseX = vX;
                this.lastMouseY = vY;
                
                if (this.draggingKeyframe !== null) {
                    const pos = this.trackedPositions.get(this.draggingKeyframe);
                    if (pos) {
                        pos.x += dx;
                        pos.y += dy;
                        this.trackedPositions.set(this.draggingKeyframe, pos);
                    }
                } else {
                    this.trackX += dx;
                    this.trackY += dy;
                    const frame = Math.floor(par.frame);
                    this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
                    this.manualKeyframes.add(frame);
                }
                this.updateSliderStatus();
                
                setRenderOne(true);
                return;
            }
            if (originalDrag) originalDrag(e);
        };
        
        mouse.handlers.up = (e) => {
            if (this.isDragging) {
                this.isDragging = false;
                this.draggingKeyframe = null;
                if (this.tracking) {
                    this.initializeTracker();
                }
            }
        };
        
        EventManager.addEventListener("keydown", (data) => {
            if (!this.enabled) return;
            const key = data.key.toLowerCase();
            if (key === 'backspace' || key === 'delete') {
                const x = mouse.x;
                const y = mouse.y;
                const [vX, vY] = this.videoView.canvasToVideoCoords(x, y);
                const clickedKeyframe = this.findClickedKeyframe(vX, vY);
                if (clickedKeyframe !== null) {
                    this.trackedPositions.delete(clickedKeyframe);
                    this.manualKeyframes.delete(clickedKeyframe);
                    this.updateSliderStatus();
                    setRenderOne(true);
                }
            }
        });
    }
    
    getImageDimensions() {
        const videoData = this.videoView?.videoData;
        if (!videoData) return {width: 1920, height: 1080};
        // Get dimensions from videoData properties without requesting a specific frame
        return {
            width: videoData.videoWidth || 1920,
            height: videoData.videoHeight || 1080,
        };
    }
    
    showOverlay() {
        if (this.overlay) this.overlay.style.display = 'block';
    }
    
    hideOverlay() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
            if (this.overlayCtx) {
                this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
            }
        }
    }
    
    enable() {
        this.enabled = true;
        this.createOverlay();
        this.showOverlay();
        setRenderOne(true);
    }
    
    disable() {
        this.enabled = false;
        this.tracking = false;
        this.hideOverlay();
        this.clearSliderStatus();
        unregisterFrameBlocker('objectTracking');
    }
    
    startTracking() {
        if (!this.enabled) return;
        this.tracking = true;
        this.initializeTracker();
        this.updateSliderStatus();

        this.savedPaused = par.paused;
        this.savedFrame = par.frame;
        Globals.justVideoAnalysis = true;
        par.paused = true;  // Pause the animation loop

        // Start fast tracking loop
        this.runFastTrackingLoop();
    }
    
    async runFastTrackingLoop() {
        const startFrame = Math.floor(par.frame);
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const videoData = this.videoView?.videoData;

        if (!videoData) {
            this.onTrackingComplete();
            return;
        }

        // Target 25 FPS for visual updates (40ms per render)
        const targetRenderInterval = 40; // ms
        let lastRenderTime = performance.now();

        for (let frame = startFrame; frame <= bFrame; frame++) {
            if (!this.tracking) break;

            // Set current frame
            par.frame = frame;

            // Wait for video frame to be loaded (with timeout)
            videoData.getImage(frame);
            await videoData.waitForFrame(frame, 5000);

            // Track this frame
            this.trackFrame(frame);

            // Only render and yield if enough time has passed (target 25 FPS visual updates)
            const now = performance.now();
            const shouldRender = (now - lastRenderTime >= targetRenderInterval) || (frame === bFrame);

            if (shouldRender) {
                // Render the video viewport
                if (this.videoView && this.videoView.renderCanvas) {
                    this.videoView.renderCanvas(frame);
                }
                // Update slider status
                this.updateSliderStatus();

                lastRenderTime = now;

                // Only yield to browser when we render (keep UI responsive)
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // Tracking complete
        this.onTrackingComplete();
    }

    stopTracking() {
        this.tracking = false;
        if (this.tracker) {
            this.tracker = null;
        }
        par.paused = this.savedPaused;
        if (this.savedFrame !== undefined) {
            par.frame = this.savedFrame;
        }
        Globals.justVideoAnalysis = false;
        setRenderOne(true);
    }
    
    onTrackingComplete() {
        this.stopTracking();
        if (startMenuItem) startMenuItem.name("Start Auto Tracking");
        setRenderOne(true);
    }
    
    initializeTracker() {
        const frame = Math.floor(par.frame);
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        
        if (this.initialTemplate) {
            this.initialTemplate.delete();
        }
        this.initialTemplate = null;
        this.initialTemplateFrame = null;
        
        this.initialGrayImage = null;
        this.initialPyramid = null;
        this.initialKeypoints = null;
        this.initialKeypointCoords = null;
        this.initialCenter = null;
    }
    
    isWithinTrackPoint(vX, vY) {
        const dx = vX - this.trackX;
        const dy = vY - this.trackY;
        return (dx * dx + dy * dy) <= (this.trackRadius * this.trackRadius);
    }

    findClickedKeyframe(vX, vY) {
        const clickRadius = this.trackRadius * 0.5;
        for (const frame of this.manualKeyframes) {
            const pos = this.trackedPositions.get(frame);
            if (pos) {
                const dx = vX - pos.x;
                const dy = vY - pos.y;
                if (dx * dx + dy * dy <= clickRadius * clickRadius) {
                    return frame;
                }
            }
        }
        return null;
    }

    // Calculate centroid (center of mass) of bright pixels within radius
    // Returns {x, y} or null if no bright pixels found
    calculateBrightCentroid(image, centerX, centerY, radius) {
        const imgWidth = image.width || image.videoWidth;
        const imgHeight = image.height || image.videoHeight;

        // Define ROI bounds (rectangle that contains the circle)
        const minX = Math.max(0, Math.floor(centerX - radius));
        const maxX = Math.min(imgWidth - 1, Math.ceil(centerX + radius));
        const minY = Math.max(0, Math.floor(centerY - radius));
        const maxY = Math.min(imgHeight - 1, Math.ceil(centerY + radius));

        const roiWidth = maxX - minX + 1;
        const roiHeight = maxY - minY + 1;

        // Extract ONLY the ROI pixels
        const canvas = document.createElement('canvas');
        canvas.width = imgWidth;
        canvas.height = imgHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, imgWidth, imgHeight);

        // Only get pixels from the ROI rectangle
        const imageData = ctx.getImageData(minX, minY, roiWidth, roiHeight);
        const data = imageData.data;

        let totalBrightness = 0;
        let weightedX = 0;
        let weightedY = 0;
        let pixelCount = 0;

        const radiusSquared = radius * radius;

        // Scan pixels within the circular region
        // Note: coordinates are relative to ROI, need to convert to image coordinates
        for (let roiY = 0; roiY < roiHeight; roiY++) {
            for (let roiX = 0; roiX < roiWidth; roiX++) {
                // Convert ROI coordinates to image coordinates
                const imgX = minX + roiX;
                const imgY = minY + roiY;

                // Check if pixel is within circular radius
                const dx = imgX - centerX;
                const dy = imgY - centerY;
                if (dx * dx + dy * dy > radiusSquared) continue;

                // Index into the ROI data (not full image)
                const index = (roiY * roiWidth + roiX) * 4;
                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];

                // Calculate brightness (luminance)
                const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

                if (brightness > this.brightnessThreshold) {
                    // Weight by brightness for better centering on bright core
                    const weight = brightness - this.brightnessThreshold;
                    totalBrightness += weight;
                    weightedX += imgX * weight;
                    weightedY += imgY * weight;
                    pixelCount++;
                }
            }
        }

        // Calculate centroid
        if (totalBrightness > 0 && pixelCount > 0) {
            return {
                x: weightedX / totalBrightness,
                y: weightedY / totalBrightness
            };
        }

        return null;
    }

    trackFrame(frame) {
        if (!this.tracking || !this.enabled) return;

        frame = Math.floor(frame);

        if (this.trackedPositions.has(frame)) {
            const pos = this.trackedPositions.get(frame);
            this.trackX = pos.x;
            this.trackY = pos.y;
            return;
        }

        const prevPos = this.getInterpolatedPosition(frame - 1);
        if (!prevPos) return;

        const videoData = this.videoView?.videoData;
        if (!videoData) return;

        const currImage = videoData.getImage(frame);

        if (!currImage || !currImage.width) return;

        if (this.centerOnBright) {
            this.trackBrightCentroid(frame, currImage, prevPos);
        } else if (this.trackingMethod === 'opticalflow') {
            this.trackOpticalFlow(frame, currImage, prevPos, videoData);
        } else {
            this.trackTemplateMatch(frame, currImage, prevPos, videoData);
        }
    }

    trackBrightCentroid(frame, currImage, prevPos) {
        const centroid = this.calculateBrightCentroid(currImage, prevPos.x, prevPos.y, this.trackRadius);

        if (centroid) {
            this.trackX = centroid.x;
            this.trackY = centroid.y;
        } else {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
        }

        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
    }

    trackTemplateMatch(frame, currImage, prevPos, videoData) {
        if (!cv) return;

        const width = currImage.width || currImage.videoWidth;
        const height = currImage.height || currImage.videoHeight;

        const currCanvas = document.createElement('canvas');
        currCanvas.width = width;
        currCanvas.height = height;
        const currCtx = currCanvas.getContext('2d');
        currCtx.drawImage(currImage, 0, 0, width, height);
        const currImageData = currCtx.getImageData(0, 0, width, height);

        const currMat = cv.matFromImageData(currImageData);
        const currGray = new cv.Mat();
        cv.cvtColor(currMat, currGray, cv.COLOR_RGBA2GRAY);

        // Capture initial template on first tracking frame (prevents drift)
        if (!this.initialTemplate || this.initialTemplateFrame === null) {
            const templateSize = this.trackRadius * 2;
            const templateX = Math.max(0, Math.floor(prevPos.x - this.trackRadius));
            const templateY = Math.max(0, Math.floor(prevPos.y - this.trackRadius));
            const templateW = Math.min(templateSize, width - templateX);
            const templateH = Math.min(templateSize, height - templateY);

            const templateROI = currGray.roi(new cv.Rect(templateX, templateY, templateW, templateH));
            this.initialTemplate = templateROI.clone();
            templateROI.delete();
            this.initialTemplateFrame = frame;
            
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
            this.updateSliderStatus();
            currMat.delete();
            currGray.delete();
            return;
        }

        const templateW = this.initialTemplate.cols;
        const templateH = this.initialTemplate.rows;

        // Search area centered on previous position
        const searchX = Math.max(0, Math.floor(prevPos.x - this.searchRadius));
        const searchY = Math.max(0, Math.floor(prevPos.y - this.searchRadius));
        const searchW = Math.min(this.searchRadius * 2, width - searchX);
        const searchH = Math.min(this.searchRadius * 2, height - searchY);

        if (searchW <= templateW || searchH <= templateH) {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
            currMat.delete();
            currGray.delete();
            return;
        }

        const searchArea = currGray.roi(new cv.Rect(searchX, searchY, searchW, searchH));

        const result = new cv.Mat();
        cv.matchTemplate(searchArea, this.initialTemplate, result, cv.TM_CCOEFF_NORMED);

        const minMax = cv.minMaxLoc(result);
        
        const bestX = searchX + minMax.maxLoc.x + templateW / 2;
        const bestY = searchY + minMax.maxLoc.y + templateH / 2;

        this.trackX = bestX;
        this.trackY = bestY;
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();

        currMat.delete();
        currGray.delete();
        searchArea.delete();
        result.delete();
    }

    trackOpticalFlow(frame, currImage, prevPos, videoData) {
        const jsfeat = getJsfeat();
        if (!jsfeat) {
            console.warn("Optical flow: jsfeat not loaded");
            return;
        }

        const width = currImage.width || currImage.videoWidth;
        const height = currImage.height || currImage.videoHeight;

        const currCanvas = document.createElement('canvas');
        currCanvas.width = width;
        currCanvas.height = height;
        const currCtx = currCanvas.getContext('2d');
        currCtx.drawImage(currImage, 0, 0, width, height);
        const currImageData = currCtx.getImageData(0, 0, width, height);

        const currGray = new jsfeat.matrix_t(width, height, jsfeat.U8_t | jsfeat.C1_t);
        jsfeat.imgproc.grayscale(currImageData.data, width, height, currGray);

        if (!this.initialPyramid || !this.initialKeypoints) {
            const roiX = Math.max(0, Math.floor(prevPos.x - this.trackRadius));
            const roiY = Math.max(0, Math.floor(prevPos.y - this.trackRadius));
            const roiW = Math.min(this.trackRadius * 2, width - roiX);
            const roiH = Math.min(this.trackRadius * 2, height - roiY);

            if (roiW < 11 || roiH < 7) {
                this.trackX = prevPos.x;
                this.trackY = prevPos.y;
                this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
                this.updateSliderStatus();
                return;
            }

            this.initialGrayImage = currGray;
            const pyrLevels = 3;
            this.initialPyramid = new jsfeat.pyramid_t(pyrLevels);
            this.initialPyramid.allocate(width, height, jsfeat.U8_t | jsfeat.C1_t);
            this.initialPyramid.build(currGray, false);

            const cornerMat = new jsfeat.matrix_t(roiW, roiH, jsfeat.U8_t | jsfeat.C1_t);
            for (let y = 0; y < roiH; y++) {
                for (let x = 0; x < roiW; x++) {
                    cornerMat.data[y * roiW + x] = currGray.data[(roiY + y) * width + (roiX + x)];
                }
            }

            const maxCorners = Math.ceil((roiW * roiH) / 4);
            const cornersArray = [];
            for (let i = 0; i < maxCorners; i++) {
                cornersArray.push(new jsfeat.keypoint_t(0, 0, 0, 0));
            }

            jsfeat.yape06.laplacian_threshold = 30;
            jsfeat.yape06.min_eigen_value_threshold = 25;
            const detectedCount = jsfeat.yape06.detect(cornerMat, cornersArray, 5);
            const count = Math.min(detectedCount, 100);

            if (count === 0) {
                this.trackX = prevPos.x;
                this.trackY = prevPos.y;
                this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
                this.updateSliderStatus();
                this.initialPyramid = null;
                return;
            }

            this.initialKeypoints = new Float32Array(count * 2);
            for (let i = 0; i < count; i++) {
                this.initialKeypoints[i * 2] = roiX + cornersArray[i].x;
                this.initialKeypoints[i * 2 + 1] = roiY + cornersArray[i].y;
            }
            this.initialCenter = {x: prevPos.x, y: prevPos.y};

            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
            this.updateSliderStatus();
            return;
        }

        const pyrLevels = 3;
        const currPyr = new jsfeat.pyramid_t(pyrLevels);
        currPyr.allocate(width, height, jsfeat.U8_t | jsfeat.C1_t);
        currPyr.build(currGray, false);

        const count = this.initialKeypoints.length / 2;
        const currXY = new Float32Array(count * 2);
        const status = new Uint8Array(count);

        const winSize = 21;
        const maxIterations = 30;
        const epsilon = 0.01;
        const minEigen = 0.0001;

        jsfeat.optical_flow_lk.track(
            this.initialPyramid, currPyr,
            this.initialKeypoints, currXY,
            count,
            winSize, maxIterations, status, epsilon, minEigen
        );

        let sumX = 0, sumY = 0, validCount = 0;
        for (let i = 0; i < count; i++) {
            if (status[i] === 1) {
                const initialX = this.initialKeypoints[i * 2];
                const initialY = this.initialKeypoints[i * 2 + 1];
                const currX = currXY[i * 2];
                const currY = currXY[i * 2 + 1];
                const dx = currX - initialX;
                const dy = currY - initialY;
                if (Math.abs(dx) < this.searchRadius && Math.abs(dy) < this.searchRadius) {
                    sumX += currX;
                    sumY += currY;
                    validCount++;
                }
            }
        }

        if (validCount > 0) {
            const avgX = sumX / validCount;
            const avgY = sumY / validCount;
            const initialAvgX = this.initialKeypoints.reduce((sum, v, i) => i % 2 === 0 ? sum + v : sum, 0) / count;
            const initialAvgY = this.initialKeypoints.reduce((sum, v, i) => i % 2 === 1 ? sum + v : sum, 0) / count;
            this.trackX = this.initialCenter.x + (avgX - initialAvgX);
            this.trackY = this.initialCenter.y + (avgY - initialAvgY);
        } else {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
        }

        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
    }
    
    renderThresholdPreview(ctx, width, height) {
        const videoData = this.videoView?.videoData;
        if (!videoData) return;
        
        const frame = Math.floor(par.frame);
        const image = videoData.getImage(frame);
        if (!image || !image.width) return;
        
        const imgWidth = image.width || image.videoWidth;
        const imgHeight = image.height || image.videoHeight;
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imgWidth;
        tempCanvas.height = imgHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(image, 0, 0, imgWidth, imgHeight);
        
        const imageData = tempCtx.getImageData(0, 0, imgWidth, imgHeight);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            
            if (brightness > this.brightnessThreshold) {
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
            } else {
                data[i] = 0;
                data[i + 1] = 0;
                data[i + 2] = 0;
            }
        }
        
        tempCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(tempCanvas, 0, 0, width, height);
    }
    
    renderOverlay(frame) {
        if (!this.enabled || !this.overlay) return;

        const width = this.videoView.widthPx;
        const height = this.videoView.heightPx;

        if (this.overlay.width !== width || this.overlay.height !== height) {
            this.overlay.width = width;
            this.overlay.height = height;
        }

        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, width, height);
        
        if (this.thresholdPreview) {
            this.renderThresholdPreview(ctx, width, height);
            return;
        }

        // Check if video dimensions have changed (e.g., new video loaded)
        const videoDims = this.getImageDimensions();
        if (videoDims.width !== this.lastVideoWidth || videoDims.height !== this.lastVideoHeight) {
            // Video dimensions changed - recenter cursor
            if (videoDims.width > 0 && videoDims.height > 0) {
                this.trackX = videoDims.width / 2;
                this.trackY = videoDims.height / 2;
                this.lastVideoWidth = videoDims.width;
                this.lastVideoHeight = videoDims.height;
                // Clear any old tracking data since it's for a different video
                if (!this.tracking) {
                    this.trackedPositions.clear();
                    this.trackedPositions.set(Math.floor(par.frame), {x: this.trackX, y: this.trackY});
                }
            }
        }

        if (this.tracking) {
            this.trackFrame(frame);
        } else {
            const f = Math.floor(frame);
            const pos = this.getInterpolatedPosition(f);
            if (pos) {
                this.trackX = pos.x;
                this.trackY = pos.y;
            }
        }

        const videoData = this.videoView?.videoData;
        const stabEnabled = videoData?.stabilizationEnabled && videoData?.stabilizationData && videoData?.stabilizationReferencePoint;

        if (stabEnabled) return;
        
        const getStabOffset = (f) => {
            if (!stabEnabled) return {x: 0, y: 0};
            const trackPos = videoData.stabilizationData.get(Math.floor(f));
            if (!trackPos) return {x: 0, y: 0};
            if (videoData.stabilizationDirectOffset) {
                return {x: trackPos.x, y: trackPos.y};
            }
            return {
                x: videoData.stabilizationReferencePoint.x - trackPos.x,
                y: videoData.stabilizationReferencePoint.y - trackPos.y
            };
        };

        const stabOffset = getStabOffset(frame);
        const [cx, cy] = this.videoView.videoToCanvasCoords(this.trackX + stabOffset.x, this.trackY + stabOffset.y);
        
        const {dWidth} = this.videoView;
        const videoWidth = this.videoView.videoWidth || 1;
        const canvasRadius = this.trackRadius * dWidth / videoWidth;
        
        ctx.strokeStyle = this.tracking ? '#00ff00' : '#ffff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, canvasRadius, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.strokeStyle = this.tracking ? 'rgba(0, 255, 0, 0.5)' : 'rgba(255, 255, 0, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - canvasRadius - 5, cy);
        ctx.lineTo(cx + canvasRadius + 5, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - canvasRadius - 5);
        ctx.lineTo(cx, cy + canvasRadius + 5);
        ctx.stroke();
        
        ctx.font = '12px monospace';
        ctx.fillStyle = this.tracking ? '#00ff00' : '#ffff00';
        const status = this.tracking ? 'TRACKING' : 'ENABLED';
        ctx.fillText(`${status} (${Math.round(this.trackX)}, ${Math.round(this.trackY)})`, cx + canvasRadius + 10, cy);
        
        if (this.trackedPositions.size > 1) {
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            let started = false;
            
            const sortedFrames = Array.from(this.trackedPositions.keys()).sort((a, b) => a - b);
            for (const f of sortedFrames) {
                const pos = this.trackedPositions.get(f);
                const offset = getStabOffset(f);
                const [px, py] = this.videoView.videoToCanvasCoords(pos.x + offset.x, pos.y + offset.y);
                if (!started) {
                    ctx.moveTo(px, py);
                    started = true;
                } else {
                    ctx.lineTo(px, py);
                }
            }
            ctx.stroke();
        }

        const keyframeRadius = canvasRadius * 0.3;
        for (const f of this.manualKeyframes) {
            const pos = this.trackedPositions.get(f);
            if (pos) {
                const offset = getStabOffset(f);
                const [kx, ky] = this.videoView.videoToCanvasCoords(pos.x + offset.x, pos.y + offset.y);
                ctx.strokeStyle = '#ff00ff';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(kx, ky, keyframeRadius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(kx - keyframeRadius - 3, ky);
                ctx.lineTo(kx + keyframeRadius + 3, ky);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(kx, ky - keyframeRadius - 3);
                ctx.lineTo(kx, ky + keyframeRadius + 3);
                ctx.stroke();
            }
        }
    }
    
    clearTrack() {
        this.trackedPositions.clear();
        this.manualKeyframes.clear();
        const frame = Math.floor(par.frame);
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
        
        const videoData = this.videoView?.videoData;
        if (videoData) {
            videoData.setStabilizationEnabled(false);
            videoData.stabilizationData = null;
            videoData.stabilizationReferencePoint = null;
        }
        
        setRenderOne(true);
    }

    clearFromHere() {
        const currentFrame = Math.floor(par.frame);
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        for (const f of this.trackedPositions.keys()) {
            if (f >= currentFrame && f <= bFrame) {
                this.trackedPositions.delete(f);
                this.manualKeyframes.delete(f);
            }
        }
        this.updateSliderStatus();
        setRenderOne(true);
    }

    getInterpolatedPosition(frame) {
        return interpolatePosition(this.trackedPositions, frame);
    }
    
    getCacheStatusArray() {
        const status = new Array(Sit.frames).fill(0);
        for (const f of this.trackedPositions.keys()) {
            if (f >= 0 && f < Sit.frames) {
                status[f] = 1;
            }
        }
        return status;
    }
    
    updateSliderStatus() {
        const slider = NodeMan.get("FrameSlider", false);
        if (slider) {
            slider.setStatusOverlay(this.getCacheStatusArray(), 2);
        }
    }
    
    clearSliderStatus() {
        const slider = NodeMan.get("FrameSlider", false);
        if (slider) {
            slider.clearStatusOverlay();
        }
    }
}

let objectTracker = null;
let trackingFolder = null;
let enableMenuItem = null;
let startMenuItem = null;
let renderHooked = false;

export function resetObjectTracking() {
    if (objectTracker) {
        // Clear video stabilization
        const videoView = objectTracker.videoView;
        const videoData = videoView?.videoData;
        if (videoData) {
            videoData.setStabilizationEnabled(false);
            videoData.stabilizationData = null;
            videoData.stabilizationReferencePoint = null;
        }

        objectTracker.disable();
        objectTracker = null;
    }
    renderHooked = false;
    if (enableMenuItem) {
        enableMenuItem.name("Enable Auto Tracking");
    }
    if (startMenuItem) {
        startMenuItem.name("Start Auto Tracking");
    }
    if (stabilizeToggleMenuItem) {
        stabilizeToggleMenuItem.name("Enable Stabilization");
    }
}

function toggleEnableTracking() {
    const videoView = NodeMan.get("video", false);
    if (!videoView) {
        alert("No video view found");
        return;
    }

    if (objectTracker && objectTracker.enabled) {
        objectTracker.disable();
        if (enableMenuItem) enableMenuItem.name("Enable Auto Tracking");
        if (startMenuItem) startMenuItem.name("Start Auto Tracking");
        if (trackingFolder) trackingFolder.close();
        setRenderOne(true);
        return;
    }
    
    if (!objectTracker) {
        objectTracker = new ObjectTracker(videoView);
    }
    
    objectTracker.enable();
    if (enableMenuItem) enableMenuItem.name("Disable Auto Tracking");
    
    if (!renderHooked) {
        renderHooked = true;
        const originalRender = videoView.renderCanvas.bind(videoView);
        videoView.renderCanvas = function(frame) {
            originalRender(frame);
            if (objectTracker && objectTracker.enabled) {
                objectTracker.renderOverlay(frame);
            }
        };
    }
    
    setRenderOne(true);
}

function toggleStartTracking() {
    if (!objectTracker || !objectTracker.enabled) {
        toggleEnableTracking();
        if (!objectTracker || !objectTracker.enabled) {
            return;
        }
    }
    
    if (objectTracker.tracking) {
        objectTracker.stopTracking();
        if (startMenuItem) startMenuItem.name("Start Auto Tracking");
        setRenderOne(true);
        return;
    }

    // Centroid mode doesn't need external libraries
    if (objectTracker.centerOnBright) {
        objectTracker.startTracking();
        if (startMenuItem) startMenuItem.name("Stop Auto Tracking");
        setRenderOne(true);
        return;
    }

    // Optical flow mode requires jsfeat
    if (objectTracker.trackingMethod === 'opticalflow') {
        const jsfeat = getJsfeat();
        if (jsfeat) {
            objectTracker.startTracking();
            if (startMenuItem) startMenuItem.name("Stop Auto Tracking");
            setRenderOne(true);
            return;
        }

        if (startMenuItem) startMenuItem.name("Loading jsfeat...");

        loadJsfeat().then(() => {
            objectTracker.startTracking();
            if (startMenuItem) startMenuItem.name("Stop Auto Tracking");
            setRenderOne(true);
        }).catch(e => {
            console.error("Failed to load jsfeat:", e);
            alert("Failed to load jsfeat.js: " + e.message);
            if (startMenuItem) startMenuItem.name("Start Auto Tracking");
        });
        return;
    }

    // Template matching mode requires OpenCV
    if (cv) {
        objectTracker.startTracking();
        if (startMenuItem) startMenuItem.name("Stop Auto Tracking");
        setRenderOne(true);
        return;
    }

    if (startMenuItem) startMenuItem.name("Loading OpenCV...");

    loadOpenCV().then(() => {
        cv = getCV();
        objectTracker.startTracking();
        if (startMenuItem) startMenuItem.name("Stop Auto Tracking");
        setRenderOne(true);
    }).catch(e => {
        console.error("Failed to load OpenCV:", e);
        alert("Failed to load OpenCV.js: " + e.message);
        if (startMenuItem) startMenuItem.name("Start Auto Tracking");
    });
}

function clearTrack() {
    if (objectTracker) {
        objectTracker.clearTrack();
        if (stabilizeToggleMenuItem) {
            stabilizeToggleMenuItem.name("Enable Stabilization");
        }
    }
}

function clearFromHere() {
    if (objectTracker) {
        objectTracker.clearFromHere();
    }
}

function stabilizeVideo() {
    if (!objectTracker || !objectTracker.enabled) {
        alert("Please enable tracking first and track an object before stabilizing.");
        return;
    }

    if (objectTracker.trackedPositions.size === 0) {
        alert("No tracking data available. Please track an object first.");
        return;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData) {
        alert("No video data available.");
        return;
    }

    // Use the first tracked frame as the reference point
    const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
    const referencePoint = objectTracker.trackedPositions.get(firstFrame);

    if (!referencePoint) {
        alert("Could not determine reference point.");
        return;
    }

    // Pass tracking data to video system
    videoData.setStabilizationData(objectTracker.trackedPositions, referencePoint);
    videoData.setStabilizationEnabled(true);

    if (stabilizeToggleMenuItem) {
        stabilizeToggleMenuItem.name("Disable Stabilization");
    }

    setRenderOne(true);
}

function toggleStabilization() {
    if (!objectTracker || !objectTracker.enabled) {
        return;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData || !videoData.stabilizationData) {
        alert("No stabilization data available. Use 'Stabilize' first.");
        return;
    }

    const newState = !videoData.stabilizationEnabled;
    videoData.setStabilizationEnabled(newState);

    if (stabilizeToggleMenuItem) {
        stabilizeToggleMenuItem.name(newState ? "Disable Stabilization" : "Enable Stabilization");
    }

    setRenderOne(true);
}

// Calculate the stabilization offset bounds across all frames
function getStabilizationBounds() {
    if (!objectTracker || !objectTracker.trackedPositions || objectTracker.trackedPositions.size === 0) {
        return null;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;
    if (!videoData) return null;

    const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
    const referencePoint = objectTracker.trackedPositions.get(firstFrame);
    if (!referencePoint) return null;

    let minX = 0, maxX = 0, minY = 0, maxY = 0;

    for (const [frame, pos] of objectTracker.trackedPositions) {
        const shiftX = referencePoint.x - pos.x;
        const shiftY = referencePoint.y - pos.y;
        minX = Math.min(minX, shiftX);
        maxX = Math.max(maxX, shiftX);
        minY = Math.min(minY, shiftY);
        maxY = Math.max(maxY, shiftY);
    }

    return { minX, maxX, minY, maxY };
}

async function renderStabilizedVideo(expanded = false) {
    if (!objectTracker || !objectTracker.enabled) {
        alert("Please enable tracking first and track an object before rendering.");
        return;
    }

    if (objectTracker.trackedPositions.size === 0) {
        alert("No tracking data available. Please track an object first.");
        return;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData) {
        alert("No video data available.");
        return;
    }

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const totalFrames = endFrame - startFrame + 1;
    const fps = Sit.fps;

    // Get video dimensions
    let width = videoData.videoWidth;
    let height = videoData.videoHeight;
    let offsetX = 0;
    let offsetY = 0;

    // For expanded mode, calculate extra canvas size needed
    if (expanded) {
        const bounds = getStabilizationBounds();
        if (bounds) {
            // Expand canvas to fit all shifts
            const extraLeft = Math.ceil(Math.abs(Math.min(0, bounds.minX)));
            const extraRight = Math.ceil(Math.max(0, bounds.maxX));
            const extraTop = Math.ceil(Math.abs(Math.min(0, bounds.minY)));
            const extraBottom = Math.ceil(Math.max(0, bounds.maxY));

            width += extraLeft + extraRight;
            height += extraTop + extraBottom;
            offsetX = extraLeft;
            offsetY = extraTop;
        }
    }

    const bestFormat = await getBestFormatForResolution(DefaultVideoFormat, width, height);
    if (!bestFormat.formatId) {
        alert(`Video export failed: ${bestFormat.reason}`);
        return;
    }

    const formatId = bestFormat.formatId;
    const extension = getVideoExtension(formatId);
    const modeLabel = expanded ? "expanded" : "original size";

    console.log(`Starting stabilized video export (${modeLabel}, ${formatId}): ${totalFrames} frames at ${fps} fps, ${width}x${height}`);

    const savedFrame = par.frame;
    const savedPaused = par.paused;
    const savedStabilizationEnabled = videoData.stabilizationEnabled;
    par.paused = true;

    const progress = new ExportProgressWidget(`Exporting stabilized video (${modeLabel})...`, totalFrames);

    const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;

    // Get reference point for stabilization
    const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
    const referencePoint = objectTracker.trackedPositions.get(firstFrame);

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    const compositeCtx = compositeCanvas.getContext('2d');

    try {
        const exporter = await createVideoExporter(formatId, {
            width,
            height,
            fps,
            bitrate: 5_000_000,
            keyFrameInterval: 30,
            videoStartDate,
            hardwareAcceleration: bestFormat.hardwareAcceleration,
        });

        await exporter.initialize();

        for (let i = 0; i < totalFrames; i++) {
            if (progress.shouldStop()) break;

            const frame = startFrame + i;
            par.frame = frame;

            // Wait for video frame
            videoData.getImage(frame);
            await videoData.waitForFrame(frame);

            const originalImage = videoData.imageCache[frame];
            if (!originalImage || !originalImage.width) continue;

            // Calculate stabilization shift for this frame
            const trackPos = interpolatePosition(objectTracker.trackedPositions, frame);
            let shiftX = 0, shiftY = 0;
            if (trackPos && referencePoint) {
                shiftX = referencePoint.x - trackPos.x;
                shiftY = referencePoint.y - trackPos.y;
            }

            // Clear and draw stabilized frame
            compositeCtx.fillStyle = 'black';
            compositeCtx.fillRect(0, 0, width, height);
            compositeCtx.drawImage(originalImage, offsetX + shiftX, offsetY + shiftY);

            drawVideoWatermark(compositeCtx, width);

            await exporter.addFrame(compositeCanvas, i);

            if (i % 10 === 0) {
                progress.update(i + 1);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (progress.shouldSave()) {
            const blob = await exporter.finalize(
                (current, total) => progress.setFinalizeProgress(current, total),
                (status) => progress.setStatus(status)
            );

            const filename = `${getExportPrefix()}_stabilized_${expanded ? 'expanded_' : ''}${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);

            console.log(`Stabilized video export complete: ${filename}`);
        } else {
            console.log('Stabilized video export aborted by user');
        }

    } catch (e) {
        console.error('Export failed:', e);
        alert('Video export failed: ' + e.message);
    } finally {
        progress.remove();
        par.frame = savedFrame;
        par.paused = savedPaused;
        videoData.stabilizationEnabled = savedStabilizationEnabled;
        setRenderOne(true);
    }
}

let radiusController = null;
let stabilizeToggleMenuItem = null;

export function addObjectTrackingMenu() {
    if (!guiMenus.view) return;

    trackingFolder = guiMenus.video.addFolder("Auto Tracking").close().perm();

    const menuActions = {
        enableTracking: toggleEnableTracking,
        startTracking: toggleStartTracking,
        clearFromHere: clearFromHere,
        clearTrack: clearTrack,
        stabilizeVideo: stabilizeVideo,
        toggleStabilization: toggleStabilization,
        renderStabilized: () => renderStabilizedVideo(false),
        renderStabilizedExpanded: () => renderStabilizedVideo(true),
    };

    enableMenuItem = trackingFolder.add(menuActions, 'enableTracking')
        .name("Enable Auto Tracking")
        .tooltip("Toggle display of the auto tracking cursor on video")
        .perm();

    startMenuItem = trackingFolder.add(menuActions, 'startTracking')
        .name("Start Auto Tracking")
        .tooltip("Automatically track the object inside the cursor as video plays")
        .perm();

    trackingFolder.add(menuActions, 'clearFromHere')
        .name("Clear from Here")
        .tooltip("Clear all tracked positions from current frame to end")
        .perm();

    trackingFolder.add(menuActions, 'clearTrack')
        .name("Clear Track")
        .tooltip("Clear all auto-tracked positions and start fresh")
        .perm();

    trackingFolder.add(menuActions, 'stabilizeVideo')
        .name("Stabilize")
        .tooltip("Apply auto-tracked positions to stabilize the video")
        .perm();

    stabilizeToggleMenuItem = trackingFolder.add(menuActions, 'toggleStabilization')
        .name("Enable Stabilization")
        .tooltip("Toggle video stabilization on/off")
        .perm();

    trackingFolder.add(menuActions, 'renderStabilized')
        .name("Render Stabilized Video")
        .tooltip("Export stabilized video at original size (tracked point stays fixed, edges may show black)")
        .perm();

    trackingFolder.add(menuActions, 'renderStabilizedExpanded')
        .name("Render Stabilized Expanded")
        .tooltip("Export stabilized video with expanded canvas so no pixels are lost")
        .perm();

    const radiusParams = {
        get trackRadius() { return objectTracker?.trackRadius ?? 30; },
        set trackRadius(v) { 
            if (objectTracker) {
                objectTracker.trackRadius = v;
                setRenderOne(true);
            }
        }
    };
    
    radiusController = trackingFolder.add(radiusParams, 'trackRadius', 10, 100, 1)
        .name("Track Radius")
        .tooltip("Size of the template to match (object size)")
        .perm();

    const searchRadiusParams = {
        get searchRadius() { return objectTracker?.searchRadius ?? 50; },
        set searchRadius(v) { 
            if (objectTracker) {
                objectTracker.searchRadius = v;
                setRenderOne(true);
            }
        }
    };
    
    trackingFolder.add(searchRadiusParams, 'searchRadius', 20, 300, 1)
        .name("Search Radius")
        .tooltip("How far from previous position to search (increase for fast motion)")
        .perm();

    const trackingMethodOptions = {
        'Template Match': 'template',
        'Optical Flow': 'opticalflow'
    };
    
    const trackingMethodParams = {
        get trackingMethod() { 
            const method = objectTracker?.trackingMethod ?? 'template';
            return Object.keys(trackingMethodOptions).find(k => trackingMethodOptions[k] === method) || 'Template Match';
        },
        set trackingMethod(v) {
            if (objectTracker) {
                objectTracker.trackingMethod = trackingMethodOptions[v] || 'template';
                if (objectTracker.tracking) {
                    objectTracker.clearTrack();
                }
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(trackingMethodParams, 'trackingMethod', Object.keys(trackingMethodOptions))
        .name("Tracking Method")
        .tooltip("Template Match (OpenCV) or Optical Flow (jsfeat Lucas-Kanade)")
        .perm();

    const centerOnBrightParams = {
        get centerOnBright() { return objectTracker?.centerOnBright ?? false; },
        set centerOnBright(v) {
            if (objectTracker) {
                objectTracker.centerOnBright = v;
                // Clear track when switching modes to avoid confusion
                if (objectTracker.tracking) {
                    objectTracker.clearTrack();
                }
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(centerOnBrightParams, 'centerOnBright')
        .name("Center on Bright")
        .tooltip("Track centroid of bright pixels (better for stars/point lights)")
        .perm();

    const brightnessParams = {
        get brightnessThreshold() { return objectTracker?.brightnessThreshold ?? 128; },
        set brightnessThreshold(v) {
            if (objectTracker) {
                objectTracker.brightnessThreshold = v;
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(brightnessParams, 'brightnessThreshold', 0, 255, 1)
        .name("Brightness Threshold")
        .tooltip("Minimum brightness to consider (0-255). Only used in Center on Bright mode")
        .onChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = true;
                setRenderOne(true);
            }
        })
        .onFinishChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = false;
                setRenderOne(true);
            }
        })
        .perm();
}

export function getObjectTracker() {
    return objectTracker;
}
