/**
 * Analysis-overlay prototype methods for CNodeVideoView.
 *
 * Covers three forensic/analysis pipelines that each run independently of the
 * base canvas render:
 * - Error Level Analysis (ELA): JPEG re-encode + delta, worker-backed with
 *   main-thread fallback.
 * - Noise heatmap / residual overlay: Laplacian high-pass, block-stats, worker
 *   or main-thread computation.
 * - Full A→B frame-range effects: Echo (min/max/average), Blend (linear average),
 *   Exposure (summed brightness).
 *
 * Installed on CNodeVideoView.prototype via Object.assign (see CNodeVideoView.js).
 */

import {Globals, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {
    checkVideoEncodingSupport,
    createVideoExporter,
    getBestFormatForResolution,
    getVideoExtension,
} from "../VideoExporter";
import {decodeImageBlob} from "./CNodeVideoViewFilters";
import {
    applyELAOutputExpansion,
    canvasToBlobAsync,
    clampByte,
    guiVideoELAFolder,
    guiVideoForensicsFolder,
    guiVideoNoiseFolder,
    noiseRatioToColor,
} from "./CNodeVideoViewFilters";

export const analysisMethods = {
    invalidateELAResult() {
        this._elaRequestToken++;
        this._elaResultKey = null;
        // Keep _elaResultCanvas as stale display while recomputing
        this._elaQueuedRequest = null;
        if (!this._elaActiveRequest) {
            this._elaPendingKey = null;
        }
    },

    getELAOverlayState(frame, image) {
        const foldersExpanded = Boolean(
            guiVideoForensicsFolder &&
            guiVideoELAFolder &&
            !guiVideoForensicsFolder._closed &&
            !guiVideoELAFolder._closed
        );

        if (!foldersExpanded || !image || !image.width || !image.height) {
            return { enabled: false, key: null, opacity: 0 };
        }

        const jpegQuality = Math.max(1, Math.min(100, this.in.elaJpegQuality?.v0 ?? 90));
        const errorScale = Math.max(0.1, this.in.elaErrorScale?.v0 ?? 20);
        const opacity = Math.max(0, Math.min(100, this.in.elaOpacity?.v0 ?? 65)) / 100;
        const expandMethod = this.in.elaExpandMethod?.value ?? 'none';
        const clipPercent = Math.max(0, Math.min(20, this.in.elaContrastClipPercent?.v0 ?? 0.5));

        if (opacity <= 0) {
            return { enabled: false, key: null, opacity: 0 };
        }

        const quantizedScale = Math.round(errorScale * 100) / 100;
        const quantizedClip = Math.round(clipPercent * 100) / 100;
        const key = `${this.currentVideoIndex}|${frame}|${image.width}x${image.height}|q${jpegQuality}|s${quantizedScale}|m${expandMethod}|c${quantizedClip}`;

        return {
            enabled: true,
            key,
            jpegQuality: jpegQuality / 100,
            errorScale: quantizedScale,
            expandMethod,
            clipPercent: quantizedClip,
            opacity
        };
    },

    requestELAOverlay(image, overlayState) {
        if (!overlayState.enabled) return;
        if (this._elaResultKey === overlayState.key || this._elaPendingKey === overlayState.key) return;

        const requestToken = this._elaRequestToken;
        if (this._elaPendingKey !== null) {
            // Keep only the latest pending request to avoid backlog while scrubbing.
            this._elaQueuedRequest = { image, overlayState, requestToken };
            return;
        }

        this.startELARequest(image, overlayState, requestToken);
    },

    startELARequest(image, overlayState, requestToken) {
        const request = {
            requestId: ++this._elaRequestSeq,
            requestToken,
            key: overlayState.key,
            image,
            overlayState
        };

        this._elaPendingKey = request.key;
        this._elaActiveRequest = request;

        if (this.canUseELAWorker()) {
            this.computeELAOverlayWorker(request);
            return;
        }

        this.computeELAOverlayMain(request).catch((err) => {
            this.handleELARequestError(request, err);
        });
    },

    isELARequestActive(request) {
        return Boolean(
            request &&
            this._elaActiveRequest &&
            this._elaActiveRequest.requestId === request.requestId &&
            this._elaActiveRequest.key === request.key &&
            request.requestToken === this._elaRequestToken &&
            this._elaPendingKey === request.key
        );
    },

    setELAResult(resultCanvasOrBitmap, key) {
        if (this._elaResultCanvas && this._elaResultCanvas !== resultCanvasOrBitmap && this._elaResultCanvas.close) {
            this._elaResultCanvas.close();
        }
        this._elaResultCanvas = resultCanvasOrBitmap;
        this._elaResultKey = key;
    },

    finalizeELARequest(request, resultCanvasOrBitmap = null) {
        const isActive = this.isELARequestActive(request);

        if (isActive && resultCanvasOrBitmap) {
            this.setELAResult(resultCanvasOrBitmap, request.key);
            setRenderOne(true);
        } else if (resultCanvasOrBitmap?.close) {
            resultCanvasOrBitmap.close();
        }

        // Clear only if this request is still the active one
        if (this._elaActiveRequest && this._elaActiveRequest.requestId === request.requestId) {
            this._elaActiveRequest = null;
            this._elaPendingKey = null;
        }

        this.processQueuedELARequest();
    },

    processQueuedELARequest() {
        if (this._elaPendingKey !== null) return;
        const queued = this._elaQueuedRequest;
        this._elaQueuedRequest = null;
        if (!queued) return;
        if (queued.requestToken !== this._elaRequestToken) return;
        this.startELARequest(queued.image, queued.overlayState, queued.requestToken);
    },

    handleELARequestError(request, err) {
        console.warn("[ELA] Failed to compute overlay:", err);
        this.finalizeELARequest(request, null);
    },

    canUseELAWorker() {
        if (this._elaWorkerFailed) return false;
        return (
            typeof Worker === "function" &&
            typeof OffscreenCanvas !== "undefined" &&
            typeof createImageBitmap === "function"
        );
    },

    ensureELAWorker() {
        if (!this.canUseELAWorker()) return null;
        if (this._elaWorker) return this._elaWorker;

        this._elaWorker = new Worker(new URL("../workers/ELAWorker.js", import.meta.url));
        this._elaWorker.onmessage = (event) => {
            const data = event.data;
            if (!this._elaActiveRequest) {
                data?.bitmap?.close?.();
                return;
            }
            if (data.type === "progress") {
                if (data.requestId !== this._elaActiveRequest.requestId) {
                    data?.bitmap?.close?.();
                    return;
                }
                // Show partial result without finalizing (worker still running)
                if (this._elaResultCanvas && this._elaResultCanvas !== data.bitmap && this._elaResultCanvas.close) {
                    this._elaResultCanvas.close();
                }
                this._elaResultCanvas = data.bitmap;
                setRenderOne(true);
                return;
            }
            if (data.type === "result") {
                if (data.requestId !== this._elaActiveRequest.requestId) {
                    data?.bitmap?.close?.();
                    return;
                }
                this.finalizeELARequest(this._elaActiveRequest, data.bitmap || null);
                return;
            }
            if (data.type === "error") {
                if (data.requestId !== this._elaActiveRequest.requestId) return;
                this.handleELARequestError(this._elaActiveRequest, data.message || "ELA worker error");
            }
        };
        this._elaWorker.onerror = (event) => {
            console.warn("[ELA] Worker error:", event.message || event);
            this._elaWorkerFailed = true;
            this.disposeELAWorker();
            if (this._elaActiveRequest) {
                const fallbackRequest = this._elaActiveRequest;
                this.computeELAOverlayMain(fallbackRequest).catch((err) => this.handleELARequestError(fallbackRequest, err));
            }
        };
        return this._elaWorker;
    },

    disposeELAWorker() {
        if (this._elaWorker) {
            this._elaWorker.onmessage = null;
            this._elaWorker.onerror = null;
            this._elaWorker.terminate();
            this._elaWorker = null;
        }
    },

    async computeELAOverlayWorker(request) {
        const worker = this.ensureELAWorker();
        if (!worker) {
            this.computeELAOverlayMain(request).catch((err) => this.handleELARequestError(request, err));
            return;
        }

        try {
            const bitmap = await createImageBitmap(request.image);
            if (!this.isELARequestActive(request)) {
                bitmap?.close?.();
                this.finalizeELARequest(request, null);
                return;
            }

            worker.postMessage({
                type: "process",
                requestId: request.requestId,
                key: request.key,
                bitmap,
                jpegQuality: request.overlayState.jpegQuality,
                errorScale: request.overlayState.errorScale,
                expandMethod: request.overlayState.expandMethod,
                clipPercent: request.overlayState.clipPercent
            }, [bitmap]);
        } catch (err) {
            this._elaWorkerFailed = true;
            this.disposeELAWorker();
            this.computeELAOverlayMain(request).catch((fallbackErr) => this.handleELARequestError(request, fallbackErr || err));
        }
    },

    ensureELABuffers(width, height) {
        if (!this._elaSourceCanvas) {
            this._elaSourceCanvas = document.createElement('canvas');
            this._elaSourceCtx = this._elaSourceCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (!this._elaRecompressedCanvas) {
            this._elaRecompressedCanvas = document.createElement('canvas');
            this._elaRecompressedCtx = this._elaRecompressedCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (!this._elaOutputCanvas) {
            this._elaOutputCanvas = document.createElement('canvas');
            this._elaOutputCtx = this._elaOutputCanvas.getContext('2d', { willReadFrequently: true });
        }

        if (this._elaSourceCanvas.width !== width || this._elaSourceCanvas.height !== height) {
            this._elaSourceCanvas.width = width;
            this._elaSourceCanvas.height = height;
            this._elaRecompressedCanvas.width = width;
            this._elaRecompressedCanvas.height = height;
            this._elaOutputCanvas.width = width;
            this._elaOutputCanvas.height = height;
        }
    },

    async computeELAOverlayMain(request) {
        const { image, overlayState } = request;
        const width = image.width;
        const height = image.height;

        this.ensureELABuffers(width, height);

        this._elaSourceCtx.clearRect(0, 0, width, height);
        this._elaSourceCtx.drawImage(image, 0, 0, width, height);
        const sourcePixels = this._elaSourceCtx.getImageData(0, 0, width, height).data;

        const jpegBlob = await canvasToBlobAsync(this._elaSourceCanvas, 'image/jpeg', overlayState.jpegQuality);
        if (!jpegBlob || !this.isELARequestActive(request)) {
            this.finalizeELARequest(request, null);
            return;
        }

        const recompressedImage = await decodeImageBlob(jpegBlob);
        if (!this.isELARequestActive(request)) {
            recompressedImage?.close?.();
            this.finalizeELARequest(request, null);
            return;
        }

        this._elaRecompressedCtx.clearRect(0, 0, width, height);
        this._elaRecompressedCtx.drawImage(recompressedImage, 0, 0, width, height);
        recompressedImage?.close?.();

        const recompressedPixels = this._elaRecompressedCtx.getImageData(0, 0, width, height).data;
        const outputImageData = this._elaOutputCtx.createImageData(width, height);
        const outputPixels = outputImageData.data;
        const scale = overlayState.errorScale;

        // ELA: absolute per-channel error between original and JPEG-recompressed frame.
        for (let i = 0; i < outputPixels.length; i += 4) {
            outputPixels[i] = Math.min(255, Math.abs(sourcePixels[i] - recompressedPixels[i]) * scale);
            outputPixels[i + 1] = Math.min(255, Math.abs(sourcePixels[i + 1] - recompressedPixels[i + 1]) * scale);
            outputPixels[i + 2] = Math.min(255, Math.abs(sourcePixels[i + 2] - recompressedPixels[i + 2]) * scale);
            outputPixels[i + 3] = 255;
        }

        applyELAOutputExpansion(outputPixels, width, height, overlayState.expandMethod, overlayState.clipPercent);

        this._elaOutputCtx.putImageData(outputImageData, 0, 0);
        this.finalizeELARequest(request, this._elaOutputCanvas);
    },

    // ── Noise Analysis overlay methods ──────────────────────────────────

    invalidateNoiseResult() {
        this._noiseRequestToken++;
        this._noiseResultKey = null;
        // Keep _noiseResultCanvas as stale display while recomputing
        this._noiseQueuedRequest = null;
        if (!this._noiseActiveRequest) {
            this._noisePendingKey = null;
        }
    },

    getNoiseOverlayState(frame, image) {
        const foldersExpanded = Boolean(
            guiVideoForensicsFolder &&
            guiVideoNoiseFolder &&
            !guiVideoForensicsFolder._closed &&
            !guiVideoNoiseFolder._closed
        );

        if (!foldersExpanded || !image || !image.width || !image.height) {
            return { enabled: false, key: null, opacity: 0 };
        }

        const blockSize = Math.max(4, Math.min(128, this.in.noiseBlockSize?.v0 ?? 16));
        const noiseScale = Math.max(0.1, this.in.noiseScale?.v0 ?? 5);
        const opacity = Math.max(0, Math.min(100, this.in.noiseOpacity?.v0 ?? 65)) / 100;
        const displayMode = this.in.noiseDisplayMode?.value ?? 'heatmap';

        if (opacity <= 0) {
            return { enabled: false, key: null, opacity: 0 };
        }

        const quantizedScale = Math.round(noiseScale * 100) / 100;
        const key = `noise|${this.currentVideoIndex}|${frame}|${image.width}x${image.height}|b${blockSize}|s${quantizedScale}|m${displayMode}`;

        return {
            enabled: true,
            key,
            blockSize,
            noiseScale: quantizedScale,
            displayMode,
            opacity
        };
    },

    requestNoiseOverlay(image, overlayState) {
        if (!overlayState.enabled) return;
        if (this._noiseResultKey === overlayState.key || this._noisePendingKey === overlayState.key) return;

        const requestToken = this._noiseRequestToken;
        if (this._noisePendingKey !== null) {
            this._noiseQueuedRequest = { image, overlayState, requestToken };
            return;
        }

        this.startNoiseRequest(image, overlayState, requestToken);
    },

    startNoiseRequest(image, overlayState, requestToken) {
        const request = {
            requestId: ++this._noiseRequestSeq,
            requestToken,
            key: overlayState.key,
            image,
            overlayState
        };

        this._noisePendingKey = request.key;
        this._noiseActiveRequest = request;

        if (this.canUseNoiseWorker()) {
            this.computeNoiseOverlayWorker(request);
            return;
        }

        this.computeNoiseOverlayMain(request).catch((err) => {
            this.handleNoiseRequestError(request, err);
        });
    },

    isNoiseRequestActive(request) {
        return Boolean(
            request &&
            this._noiseActiveRequest &&
            this._noiseActiveRequest.requestId === request.requestId &&
            this._noiseActiveRequest.key === request.key &&
            request.requestToken === this._noiseRequestToken &&
            this._noisePendingKey === request.key
        );
    },

    setNoiseResult(resultCanvasOrBitmap, key) {
        if (this._noiseResultCanvas && this._noiseResultCanvas !== resultCanvasOrBitmap && this._noiseResultCanvas.close) {
            this._noiseResultCanvas.close();
        }
        this._noiseResultCanvas = resultCanvasOrBitmap;
        this._noiseResultKey = key;
    },

    finalizeNoiseRequest(request, resultCanvasOrBitmap = null) {
        const isActive = this.isNoiseRequestActive(request);

        if (isActive && resultCanvasOrBitmap) {
            this.setNoiseResult(resultCanvasOrBitmap, request.key);
            setRenderOne(true);
        } else if (resultCanvasOrBitmap?.close) {
            resultCanvasOrBitmap.close();
        }

        if (this._noiseActiveRequest && this._noiseActiveRequest.requestId === request.requestId) {
            this._noiseActiveRequest = null;
            this._noisePendingKey = null;
        }

        this.processQueuedNoiseRequest();
    },

    processQueuedNoiseRequest() {
        if (this._noisePendingKey !== null) return;
        const queued = this._noiseQueuedRequest;
        this._noiseQueuedRequest = null;
        if (!queued) return;
        if (queued.requestToken !== this._noiseRequestToken) return;
        this.startNoiseRequest(queued.image, queued.overlayState, queued.requestToken);
    },

    handleNoiseRequestError(request, err) {
        console.warn("[Noise] Failed to compute overlay:", err);
        this.finalizeNoiseRequest(request, null);
    },

    canUseNoiseWorker() {
        if (this._noiseWorkerFailed) return false;
        return (
            typeof Worker === "function" &&
            typeof OffscreenCanvas !== "undefined" &&
            typeof createImageBitmap === "function"
        );
    },

    ensureNoiseWorker() {
        if (!this.canUseNoiseWorker()) return null;
        if (this._noiseWorker) return this._noiseWorker;

        this._noiseWorker = new Worker(new URL("../workers/NoiseWorker.js", import.meta.url));
        this._noiseWorker.onmessage = (event) => {
            const data = event.data;
            if (!this._noiseActiveRequest) {
                data?.bitmap?.close?.();
                return;
            }
            if (data.type === "progress") {
                if (data.requestId !== this._noiseActiveRequest.requestId) {
                    data?.bitmap?.close?.();
                    return;
                }
                // Show partial result without finalizing (worker still running)
                if (this._noiseResultCanvas && this._noiseResultCanvas !== data.bitmap && this._noiseResultCanvas.close) {
                    this._noiseResultCanvas.close();
                }
                this._noiseResultCanvas = data.bitmap;
                setRenderOne(true);
                return;
            }
            if (data.type === "result") {
                if (data.requestId !== this._noiseActiveRequest.requestId) {
                    data?.bitmap?.close?.();
                    return;
                }
                this.finalizeNoiseRequest(this._noiseActiveRequest, data.bitmap || null);
                return;
            }
            if (data.type === "error") {
                if (data.requestId !== this._noiseActiveRequest.requestId) return;
                this.handleNoiseRequestError(this._noiseActiveRequest, data.message || "Noise worker error");
            }
        };
        this._noiseWorker.onerror = (event) => {
            console.warn("[Noise] Worker error:", event.message || event);
            this._noiseWorkerFailed = true;
            this.disposeNoiseWorker();
            if (this._noiseActiveRequest) {
                const fallbackRequest = this._noiseActiveRequest;
                this.computeNoiseOverlayMain(fallbackRequest).catch((err) => this.handleNoiseRequestError(fallbackRequest, err));
            }
        };
        return this._noiseWorker;
    },

    disposeNoiseWorker() {
        if (this._noiseWorker) {
            this._noiseWorker.onmessage = null;
            this._noiseWorker.onerror = null;
            this._noiseWorker.terminate();
            this._noiseWorker = null;
        }
    },

    async computeNoiseOverlayWorker(request) {
        const worker = this.ensureNoiseWorker();
        if (!worker) {
            this.computeNoiseOverlayMain(request).catch((err) => this.handleNoiseRequestError(request, err));
            return;
        }

        try {
            const bitmap = await createImageBitmap(request.image);
            if (!this.isNoiseRequestActive(request)) {
                bitmap?.close?.();
                this.finalizeNoiseRequest(request, null);
                return;
            }

            worker.postMessage({
                type: "process",
                requestId: request.requestId,
                key: request.key,
                bitmap,
                blockSize: request.overlayState.blockSize,
                noiseScale: request.overlayState.noiseScale,
                displayMode: request.overlayState.displayMode
            }, [bitmap]);
        } catch (err) {
            this._noiseWorkerFailed = true;
            this.disposeNoiseWorker();
            this.computeNoiseOverlayMain(request).catch((fallbackErr) => this.handleNoiseRequestError(request, fallbackErr || err));
        }
    },

    ensureNoiseBuffers(width, height) {
        if (!this._noiseSourceCanvas) {
            this._noiseSourceCanvas = document.createElement('canvas');
            this._noiseSourceCtx = this._noiseSourceCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (!this._noiseOutputCanvas) {
            this._noiseOutputCanvas = document.createElement('canvas');
            this._noiseOutputCtx = this._noiseOutputCanvas.getContext('2d', { willReadFrequently: true });
        }

        if (this._noiseSourceCanvas.width !== width || this._noiseSourceCanvas.height !== height) {
            this._noiseSourceCanvas.width = width;
            this._noiseSourceCanvas.height = height;
            this._noiseOutputCanvas.width = width;
            this._noiseOutputCanvas.height = height;
        }
    },

    async computeNoiseOverlayMain(request) {
        const { image, overlayState } = request;
        const width = image.width;
        const height = image.height;

        this.ensureNoiseBuffers(width, height);

        this._noiseSourceCtx.clearRect(0, 0, width, height);
        this._noiseSourceCtx.drawImage(image, 0, 0, width, height);
        const sourcePixels = this._noiseSourceCtx.getImageData(0, 0, width, height).data;

        if (!this.isNoiseRequestActive(request)) {
            this.finalizeNoiseRequest(request, null);
            return;
        }

        // Convert to greyscale luminance
        const grey = new Float32Array(width * height);
        for (let i = 0; i < grey.length; i++) {
            const idx = i * 4;
            grey[i] = 0.299 * sourcePixels[idx] + 0.587 * sourcePixels[idx + 1] + 0.114 * sourcePixels[idx + 2];
        }

        // Apply 3x3 Laplacian high-pass filter
        const laplacian = new Float32Array(width * height);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                laplacian[idx] =
                    4 * grey[idx]
                    - grey[idx - 1]
                    - grey[idx + 1]
                    - grey[idx - width]
                    - grey[idx + width];
            }
        }

        const outputImageData = this._noiseOutputCtx.createImageData(width, height);
        const outputPixels = outputImageData.data;

        if (overlayState.displayMode === 'residual') {
            // Render amplified noise residual centered at grey (128)
            for (let i = 0; i < laplacian.length; i++) {
                const val = clampByte(128 + laplacian[i] * overlayState.noiseScale);
                const idx = i * 4;
                outputPixels[idx] = val;
                outputPixels[idx + 1] = val;
                outputPixels[idx + 2] = val;
                outputPixels[idx + 3] = 255;
            }
        } else {
            // Heatmap mode: block-based noise level visualization
            const blockSize = overlayState.blockSize;
            const blocksX = Math.ceil(width / blockSize);
            const blocksY = Math.ceil(height / blockSize);
            const blockStdDevs = new Float32Array(blocksX * blocksY);

            for (let by = 0; by < blocksY; by++) {
                for (let bx = 0; bx < blocksX; bx++) {
                    const x0 = bx * blockSize;
                    const y0 = by * blockSize;
                    const x1 = Math.min(x0 + blockSize, width);
                    const y1 = Math.min(y0 + blockSize, height);

                    let sum = 0;
                    let sumSq = 0;
                    let count = 0;

                    for (let y = y0; y < y1; y++) {
                        for (let x = x0; x < x1; x++) {
                            const val = laplacian[y * width + x];
                            sum += val;
                            sumSq += val * val;
                            count++;
                        }
                    }

                    if (count > 0) {
                        const mean = sum / count;
                        const variance = sumSq / count - mean * mean;
                        blockStdDevs[by * blocksX + bx] = Math.sqrt(Math.max(0, variance));
                    }
                }
            }

            const sorted = Array.from(blockStdDevs).filter(v => v > 0).sort((a, b) => a - b);
            const medianNoise = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1;

            for (let by = 0; by < blocksY; by++) {
                for (let bx = 0; bx < blocksX; bx++) {
                    const stdDev = blockStdDevs[by * blocksX + bx];
                    const ratio = medianNoise > 0 ? stdDev / medianNoise : 1;
                    const rgb = noiseRatioToColor(ratio);

                    const x0 = bx * blockSize;
                    const y0 = by * blockSize;
                    const x1 = Math.min(x0 + blockSize, width);
                    const y1 = Math.min(y0 + blockSize, height);

                    for (let y = y0; y < y1; y++) {
                        for (let x = x0; x < x1; x++) {
                            const idx = (y * width + x) * 4;
                            outputPixels[idx] = rgb[0];
                            outputPixels[idx + 1] = rgb[1];
                            outputPixels[idx + 2] = rgb[2];
                            outputPixels[idx + 3] = 255;
                        }
                    }
                }
            }
        }

        this._noiseOutputCtx.putImageData(outputImageData, 0, 0);
        this.finalizeNoiseRequest(request, this._noiseOutputCanvas);
    },

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
    },

    stopFullABEcho() {
        this._fullABEchoRunning = false;
        Globals.justVideoAnalysis = false;
        this._fullABEchoMinPixels = null;
        this._fullABEchoMaxPixels = null;
        this._fullABEchoSumPixels = null;
        this._fullABEchoResult = null;
        par.paused = this._fullABEchoSavedPaused ?? false;
        setRenderOne(true);
    },

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
    },

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
    },

    onFullABEchoComplete(bFrame) {
        this._fullABEchoRunning = false;
        Globals.justVideoAnalysis = false;
        par.paused = true;
        if (bFrame !== undefined) {
            par.frame = bFrame;
        }
        setRenderOne(true);
    },

    async makeProcessedVideo() {
        const isEcho = this.in.fullABEcho?.value;
        const isBlend = this.in.fullABBlend?.value;
        const isExposure = this.in.fullABExposure?.value;

        if (!isEcho && !isBlend && !isExposure) {
            alert("No processing active. Enable Full A-B Echo, Blend, or Exposure first.");
            return;
        }

        if (!this.videoData) {
            alert("No video loaded.");
            return;
        }

        if (typeof VideoEncoder === 'undefined') {
            alert("VideoEncoder API not available in this browser.");
            return;
        }

        const aFrame = Sit.aFrame ?? 0;
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const totalFrames = bFrame - aFrame + 1;
        const videoData = this.videoData;

        // Determine process type for naming
        const processType = isEcho ? "echo" : isBlend ? "blend" : "exposure";

        // Get video dimensions from first available frame
        let width = 0, height = 0;
        for (let f = aFrame; f <= bFrame; f++) {
            const img = videoData.getImage(f);
            if (img && img.width > 0) {
                width = img.width;
                height = img.height;
                break;
            }
        }
        if (width === 0 || height === 0) {
            alert("Could not determine video dimensions.");
            return;
        }

        // Ensure even dimensions for video encoding
        const encodeWidth = Math.ceil(width / 2) * 2;
        const encodeHeight = Math.ceil(height / 2) * 2;

        const encodingSupport = await checkVideoEncodingSupport();
        if (!encodingSupport.supported) {
            alert("Video encoding not supported: " + (encodingSupport.reason || "unknown"));
            return;
        }

        const preferredFormat = encodingSupport.h264 ? 'mp4-h264' : 'webm-vp8';
        const bestFormat = await getBestFormatForResolution(preferredFormat, encodeWidth, encodeHeight);
        if (!bestFormat.formatId) {
            alert("No codec supports this resolution: " + (bestFormat.reason || "unknown"));
            return;
        }

        const extension = getVideoExtension(bestFormat.formatId);
        const fps = Sit.fps || 30;

        let exporter;
        try {
            exporter = await createVideoExporter(bestFormat.formatId, {
                width: encodeWidth,
                height: encodeHeight,
                fps,
                bitrate: 10_000_000,
                keyFrameInterval: 30,
                hardwareAcceleration: bestFormat.hardwareAcceleration,
            });
            await exporter.initialize();
        } catch (e) {
            alert("Failed to create video exporter: " + e.message);
            return;
        }

        // Everything that can refuse the job has now agreed, so it is safe to take
        // the range over from the A-B preview loop. This must happen AFTER the
        // preflight above: cancelling earlier meant any `alert(); return` left the
        // Full A-B toggle switched on with no loop running and no result on screen.
        //
        // The two cannot overlap — both drive par.frame and both own
        // Globals.justVideoAnalysis — and the preview is redundant regardless, since
        // the export recomputes the same accumulation over the same range.
        if (this._fullABEchoRunning) {
            this._fullABEchoRunning = false;
            this._fullABEchoResult = null;
            // Hand back what that loop commandeered, BEFORE the snapshot below.
            // Otherwise the snapshot captures the loop's blanked state and the
            // finally faithfully restores it, leaving every viewport but the video
            // one dark for good. All three A-B loops share these fields.
            Globals.justVideoAnalysis = false;
            par.paused = this._fullABEchoSavedPaused ?? false;
        }

        // Save state. justVideoAnalysis suppresses every viewport except the video
        // one, so it must be RESTORED rather than forced false — that is what the
        // other exporters do, and forcing it was how a nested run could hand back a
        // half-blanked app.
        const savedPaused = par.paused;
        const savedFrame = par.frame;
        const savedJVA = Globals.justVideoAnalysis;
        par.paused = true;
        Globals.justVideoAnalysis = true;

        // Set up canvases
        const canvas = document.createElement('canvas');
        canvas.width = encodeWidth;
        canvas.height = encodeHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = width;
        tmpCanvas.height = height;
        const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

        let pixelCount = width * height * 4;
        let minPixels = null, maxPixels = null, sumPixels = null;
        let frameCount = 0;
        let initialized = false;

        const wantMin = isEcho ? (this.in.echoMin?.value ?? false) : false;
        const wantMax = isEcho ? (this.in.echoMax?.value ?? true) : false;

        if (isEcho) {
            if (wantMin) minPixels = new Uint8ClampedArray(pixelCount);
            if (wantMax) maxPixels = new Uint8ClampedArray(pixelCount);
            if (wantMin && wantMax) sumPixels = new Float32Array(pixelCount);
        } else {
            // blend and exposure both use sumPixels
            sumPixels = new Float32Array(pixelCount);
        }

        const targetRenderInterval = 40;
        let lastRenderTime = performance.now();

        console.log(`[MakeVideo] Starting ${processType} export: ${totalFrames} frames, ${encodeWidth}x${encodeHeight}`);

        try {
            for (let f = aFrame; f <= bFrame; f++) {
                par.frame = f;

                videoData.getImage(f);
                if (videoData.waitForFrame) {
                    await videoData.waitForFrame(f, 5000);
                }

                const frameImage = videoData.getImage(f);
                if (!frameImage || frameImage.width === 0) continue;

                tmpCtx.drawImage(frameImage, 0, 0, width, height);
                const frameData = tmpCtx.getImageData(0, 0, width, height).data;

                if (!initialized) {
                    if (isEcho) {
                        if (minPixels) minPixels.set(frameData);
                        if (maxPixels) maxPixels.set(frameData);
                        if (sumPixels) { for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i]; }
                    } else {
                        for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i];
                    }
                    initialized = true;
                } else {
                    if (isEcho) {
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
                    } else {
                        for (let i = 0; i < pixelCount; i += 4) {
                            for (let c = 0; c < 3; c++) {
                                sumPixels[i + c] += frameData[i + c];
                            }
                        }
                    }
                }
                frameCount++;

                // Build the progressive result image
                let resultPixels;
                if (isEcho) {
                    resultPixels = new Uint8ClampedArray(pixelCount);
                    if (wantMin && wantMax) {
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
                } else if (isBlend) {
                    resultPixels = new Uint8ClampedArray(pixelCount);
                    for (let i = 0; i < pixelCount; i += 4) {
                        for (let c = 0; c < 3; c++) {
                            resultPixels[i + c] = sumPixels[i + c] / frameCount;
                        }
                        resultPixels[i + 3] = 255;
                    }
                } else {
                    // exposure: divide by total frames (not frameCount) so it brightens progressively
                    resultPixels = new Uint8ClampedArray(pixelCount);
                    for (let i = 0; i < pixelCount; i += 4) {
                        for (let c = 0; c < 3; c++) {
                            resultPixels[i + c] = sumPixels[i + c] / totalFrames;
                        }
                        resultPixels[i + 3] = 255;
                    }
                }

                // Draw result to encoding canvas
                const outputImageData = new ImageData(resultPixels, width, height);
                tmpCtx.putImageData(outputImageData, 0, 0);
                ctx.clearRect(0, 0, encodeWidth, encodeHeight);
                ctx.drawImage(tmpCanvas, 0, 0, encodeWidth, encodeHeight);

                await exporter.addFrame(canvas, f - aFrame);

                // Periodic render update for progress display
                const now = performance.now();
                if ((f - aFrame) % 10 === 0 || f === bFrame || now - lastRenderTime >= targetRenderInterval) {
                    this._fullABEchoResult = tmpCanvas;
                    this.renderCanvas(f);
                    lastRenderTime = performance.now();
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            console.log(`[MakeVideo] Encoding complete, finalizing...`);
            const blob = await exporter.finalize();

            // SAVE the file, the same as every other export in the app — the video
            // menu's viewport render and exportVideoFrame both hand the blob straight
            // to the user. This used to load the result back in as the active video
            // instead, which was the odd one out and did real damage: Sit.framesFromVideo
            // means the loaded video DEFINES the sitch length, so a clip covering only
            // the A-B range silently reshaped the timeline (788 frames to 340 here),
            // stranded the A/B markers at absolute frame numbers that no longer meant
            // the same thing, and left the camera track, MISB data and date/time mapped
            // onto a timeline that no longer matched the footage.
            let baseName = this.fileName || "video";
            if (baseName.includes('/')) baseName = baseName.split('/').pop();
            if (baseName.includes('.')) baseName = baseName.substring(0, baseName.lastIndexOf('.'));
            const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const outName = `${baseName}-${processType}-${stamp}.${extension}`;

            const {saveAs} = await import("file-saver");
            saveAs(blob, outName);

            console.log(`[MakeVideo] Saved ${outName}, ${(blob.size / 1024 / 1024).toFixed(1)} MB`);

        } catch (e) {
            console.error("[MakeVideo] Error:", e);
            alert("Make Video failed: " + e.message);
        } finally {
            // Restore state
            this._fullABEchoResult = null;
            Globals.justVideoAnalysis = savedJVA;
            par.paused = savedPaused;
            par.frame = savedFrame;
            setRenderOne(true);

            // The export took the range over from the A-B preview loop, so put the
            // preview back: the toggles are still on, the video on screen is still
            // the source, and the user should be looking at the same accumulation
            // they were before they clicked. No-op if no A-B toggle is on.
            this.restartFullABEchoIfActive();
        }
    },

    startFullABBlend() {
        if (this._fullABEchoRunning) return;
        if (!this.videoData) return;

        this._fullABEchoRunning = true;
        this._fullABEchoSavedPaused = par.paused;
        this._fullABEchoSavedFrame = par.frame;
        par.paused = true;
        Globals.justVideoAnalysis = true;

        this.runFullABBlendLoop();
    },

    stopFullABBlend() {
        this._fullABEchoRunning = false;
        Globals.justVideoAnalysis = false;
        this._fullABEchoResult = null;
        par.paused = this._fullABEchoSavedPaused ?? false;
        setRenderOne(true);
    },

    async runFullABBlendLoop() {
        const aFrame = Sit.aFrame ?? 0;
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const videoData = this.videoData;

        if (!videoData) {
            this.onFullABEchoComplete();
            return;
        }

        let width = 0, height = 0, pixelCount = 0;
        let sumPixels = null;
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
                sumPixels = new Float32Array(pixelCount);
            }

            this._fullABEchoTmpCtx.drawImage(frameImage, 0, 0, width, height);
            const frameData = this._fullABEchoTmpCtx.getImageData(0, 0, width, height).data;

            if (!initialized) {
                for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i];
                initialized = true;
            } else {
                for (let i = 0; i < pixelCount; i += 4) {
                    for (let c = 0; c < 3; c++) {
                        sumPixels[i + c] += frameData[i + c];
                    }
                }
            }
            frameCount++;

            const framesProcessed = f - aFrame + 1;
            const now = performance.now();
            const shouldRender = (framesProcessed % 10 === 0) || (f === bFrame) || (now - lastRenderTime >= targetRenderInterval);

            if (shouldRender && initialized) {
                this.buildFullABBlendResult(sumPixels, frameCount, width, height);
                this.renderCanvas(f);
                lastRenderTime = performance.now();
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (initialized) {
            this.buildFullABBlendResult(sumPixels, frameCount, width, height);
        }

        this.onFullABEchoComplete(bFrame);
    },

    buildFullABBlendResult(sumPixels, divisor, width, height) {
        const pixelCount = width * height * 4;
        const resultPixels = new Uint8ClampedArray(pixelCount);
        for (let i = 0; i < pixelCount; i += 4) {
            for (let c = 0; c < 3; c++) {
                resultPixels[i + c] = sumPixels[i + c] / divisor;
            }
            resultPixels[i + 3] = 255;
        }
        const outputData = new ImageData(resultPixels, width, height);
        this._fullABEchoCtx.putImageData(outputData, 0, 0);
        this._fullABEchoResult = this._fullABEchoCanvas;
    },

    startFullABExposure() {
        if (this._fullABEchoRunning) return;
        if (!this.videoData) return;

        this._fullABEchoRunning = true;
        this._fullABEchoSavedPaused = par.paused;
        this._fullABEchoSavedFrame = par.frame;
        par.paused = true;
        Globals.justVideoAnalysis = true;

        this.runFullABExposureLoop();
    },

    stopFullABExposure() {
        this._fullABEchoRunning = false;
        Globals.justVideoAnalysis = false;
        this._fullABEchoResult = null;
        par.paused = this._fullABEchoSavedPaused ?? false;
        setRenderOne(true);
    },

    async runFullABExposureLoop() {
        const aFrame = Sit.aFrame ?? 0;
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const totalFrames = bFrame - aFrame + 1;
        const videoData = this.videoData;

        if (!videoData) {
            this.onFullABEchoComplete();
            return;
        }

        let width = 0, height = 0, pixelCount = 0;
        let sumPixels = null;
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
                sumPixels = new Float32Array(pixelCount);
            }

            this._fullABEchoTmpCtx.drawImage(frameImage, 0, 0, width, height);
            const frameData = this._fullABEchoTmpCtx.getImageData(0, 0, width, height).data;

            if (!initialized) {
                for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i];
                initialized = true;
            } else {
                for (let i = 0; i < pixelCount; i += 4) {
                    for (let c = 0; c < 3; c++) {
                        sumPixels[i + c] += frameData[i + c];
                    }
                }
            }

            const framesProcessed = f - aFrame + 1;
            const now = performance.now();
            const shouldRender = (framesProcessed % 10 === 0) || (f === bFrame) || (now - lastRenderTime >= targetRenderInterval);

            if (shouldRender && initialized) {
                this.buildFullABBlendResult(sumPixels, totalFrames, width, height);
                this.renderCanvas(f);
                lastRenderTime = performance.now();
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (initialized) {
            this.buildFullABBlendResult(sumPixels, totalFrames, width, height);
        }

        this.onFullABEchoComplete(bFrame);
    },
};
