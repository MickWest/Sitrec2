"use strict"
const ndarray = require("ndarray")

function logNetwork(url, status) {
    // if (Globals.regression) {
    //     console.log(`[NET:${url}:${status}]`);
    // }
}

// Web Worker code for processing images.
// fetch() has no default timeout — in headless Chromium against external tile
// servers we hit indefinite stalls where the socket never errors and no
// response arrives. Without AbortController, the worker sits forever and the
// main-thread pending-request never fires its callback, leaving tiles stuck
// isLoadingElevation. WORKER_FETCH_TIMEOUT_MS converts that into an
// AbortError the existing catch block handles.
const WORKER_FETCH_TIMEOUT_MS = 10000;
const workerCode = `
const FETCH_TIMEOUT_MS = ${WORKER_FETCH_TIMEOUT_MS};
self.onmessage = async (event) => {
    const { url, id } = event.data;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(\`HTTP \${response.status}\`);
        }
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);

        self.postMessage({
            id,
            success: true,
            width: bitmap.width,
            height: bitmap.height,
            data: new Uint8Array(imageData.data),
            url
        });

        bitmap.close();
    } catch (err) {
        self.postMessage({
            id,
            success: false,
            error: err.message,
            url
        });
    } finally {
        clearTimeout(timer);
    }
};
`;

let workerBlobUrl = null;
try {
    const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(workerBlob);
} catch (err) {
    console.warn('Could not create worker blob:', err);
}

class ImageQueueManager {
    constructor(useWorkerPool = true, numWorkers = 4) {
        this.queue = [];
        this.activeRequests = 0;
        this.maxActiveRequests = 5;
        this.maxRetries = 3;
        this.errorOccurred = false;
        this.useWorkerPool = useWorkerPool && workerBlobUrl !== null;
        this.numWorkers = numWorkers;
        this.workers = [];
        this.workerId = 0;
        
        if (this.useWorkerPool) {
            this.initWorkerPool();
        }

        // Diagnostic escape hatch for debugging tile-load hangs (queueLen,
        // pendingRequests, workerBusy). Read-only state; always on.
        if (typeof window !== "undefined") {
            window.__imageQueueManager = this;
        }
    }

    initWorkerPool() {
        for (let i = 0; i < this.numWorkers; i++) {
            const worker = new Worker(workerBlobUrl);
            worker.busy = false;
            worker.currentRequestId = null;
            worker.stallTimer = null;
            worker.onmessage = (event) => this.handleWorkerMessage(event, i);
            worker.onerror = (err) => this.handleWorkerError(err, i);
            this.workers.push(worker);
        }
    }

    // Worker crashed (onerror). The in-flight request never got a response,
    // so fail it, free the slot, and drain the queue — otherwise the worker
    // stays busy=true forever and the pending-actions signal hangs.
    handleWorkerError(err, workerIndex) {
        console.error(`Worker ${workerIndex} error:`, err);
        this.errorOccurred = true;
        const worker = this.workers[workerIndex];
        if (!worker) return;
        const rid = worker.currentRequestId;
        if (worker.stallTimer) { clearTimeout(worker.stallTimer); worker.stallTimer = null; }
        worker.busy = false;
        worker.currentRequestId = null;
        if (rid != null) {
            const req = this.pendingRequests?.get(rid);
            this.pendingRequests?.delete(rid);
            this.activeRequests = Math.max(0, this.activeRequests - 1);
            if (req) {
                if (req.retries < this.maxRetries) {
                    console.warn(`Retrying (re-queueing after worker crash) ${req.url}`);
                    this.enqueueImage(req.url, req.cb, req.retries + 1);
                } else {
                    req.cb(new Error(`Worker crashed: ${err?.message || err}`));
                }
            }
        }
        this.processQueueWorker();
    }

    handleWorkerMessage(event, workerIndex) {
        const { id, success, width, height, data, error, url } = event.data;
        const request = this.pendingRequests?.get(id);
        
        if (!request) return;
        
        this.activeRequests--;
        this.pendingRequests.delete(id);

        if (success && data) {
            const pixelArray = new Uint8Array(data);
            const shape = [height, width, 4];
            const stride = [4 * width, 4, 1];
            logNetwork(url, 200);
            request.cb(null, ndarray(pixelArray, shape, stride, 0));
        } else {
            this.errorOccurred = true;
            if (request.retries < this.maxRetries) {
                console.warn(`Retrying (re-queueing) ${url}`);
                this.enqueueImage(url, request.cb, request.retries + 1);
            } else {
                logNetwork(url, 404);
                request.cb(new Error(error || 'Image load failed'));
            }
        }

        if (this.queue.length === 0 && this.activeRequests === 0) {
            this.errorOccurred = false;
        }
        
        // Mark worker as available and process next item
        const worker = this.workers[workerIndex];
        if (worker) {
            if (worker.stallTimer) { clearTimeout(worker.stallTimer); worker.stallTimer = null; }
            worker.currentRequestId = null;
            worker.busy = false;
        }
        this.processQueueWorker();
    }

    dispose() {
        this.queue = [];
        this.activeRequests = 0;
        this.errorOccurred = false;
        if (this.pendingRequests) {
            this.pendingRequests.clear();
        }
        if (this.useWorkerPool && this.workers.length > 0) {
            this.workers.forEach(w => {
                if (w.stallTimer) clearTimeout(w.stallTimer);
                w.terminate();
            });
            this.workers = [];
            // Reinitialize worker pool for next sitch
            this.initWorkerPool();
        }
    }

    enqueueImage(url, cb, retries = 0) {
        if (this.useWorkerPool) {
            if (!this.pendingRequests) {
                this.pendingRequests = new Map();
            }
            this.queue.push({ url, cb, retries });
            this.processQueueWorker();
        } else {
            this.queue.push({ url, cb, retries });
            this.processQueue();
        }
    }

    // Worker pool queue processing
    processQueueWorker() {
        const availableWorker = this.workers.find(w => !w.busy);
        
        if (!availableWorker || this.queue.length === 0) {
            return;
        }

        const { url, cb, retries } = this.queue.shift();
        this.activeRequests++;

        const requestId = this.workerId++;
        availableWorker.busy = true;
        availableWorker.currentRequestId = requestId;
        this.pendingRequests.set(requestId, { url, cb, retries });

        // Cheap insurance: if a worker stays busy for >60s (way past the
        // 10s fetch timeout + image decode), surface it so the next leak is
        // diagnosable without rerunning instrumentation.
        const workerIdx = this.workers.indexOf(availableWorker);
        if (availableWorker.stallTimer) clearTimeout(availableWorker.stallTimer);
        availableWorker.stallTimer = setTimeout(() => {
            console.warn(`[pixel-worker ${workerIdx}] stalled >60s on ${url}`);
        }, 60000);

        logNetwork(url, 'pending');
        availableWorker.postMessage({ url, id: requestId });
    }

    // Fallback queue processing (non-worker)
    processQueue() {
        while (this.activeRequests < this.maxActiveRequests && this.queue.length > 0) {
            this.processNext();
        }
    }

    processNext() {
        if (this.queue.length === 0) {
            return;
        }

        const { url, cb, retries } = this.queue.shift();
        this.activeRequests++;

        logNetwork(url, 'pending');
        this.defaultImage(url, (err, result) => {
            this.activeRequests--;
            if (err) {
                console.log("Err..... " + url);
                this.errorOccurred = true;
                if (retries < this.maxRetries) {
                    console.warn("Retrying (re-queueing) " + url);
                    this.enqueueImage(url, cb, retries + 1);
                } else {
                    logNetwork(url, 404);
                    cb(err, null);
                }
            } else {
                logNetwork(url, 200);
                cb(null, result);
            }

            if (this.queue.length === 0 && this.activeRequests === 0) {
                this.errorOccurred = false;
            }
            this.processQueue();
        });
    }

    defaultImage(url, cb) {
        const img = new Image();
        img.crossOrigin = "anonymous";

        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const context = canvas.getContext("2d");
            context.drawImage(img, 0, 0);
            const pixels = context.getImageData(0, 0, img.width, img.height);
            const pixelArray = new Uint8Array(pixels.data);
            const shape = [img.height, img.width, 4];
            const stride = [4 * img.width, 4, 1];
            cb(null, ndarray(pixelArray, shape, stride, 0));
        };

        img.onerror = (err) => {
            console.log(`img.onerror = ${err}  ${url}`);
            cb(err);
        };

        // If an error previously occurred, delay setting the image source
        if (this.errorOccurred) {
            setTimeout(() => {
                img.src = url;
            }, 100);
        } else {
            img.src = url;
        }
    }
}

// Usage - default instance with 4 workers
export const imageQueueManager = new ImageQueueManager(true, 4);

export function getPixels(url, cb) {
    imageQueueManager.enqueueImage(url, cb);
}

// Factory function to create custom manager instances
export function createImageQueueManager(useWorkerPool = true, numWorkers = 4) {
    return new ImageQueueManager(useWorkerPool, numWorkers);
}
