const WORKER_CODE = `
'use strict';

let decoder = null;
let configured = false;
let flushing = false;
let currentGroupId = -1;
let pendingFrames = new Map();
let timestampToFrameNumber = new Map();
let effectiveRotation = 0;
let videoMaxSize = null;
let lastConfig = null;

const resolutionMap = {
    "1080P": 1920,
    "720P": 1280,
    "480P": 854,
    "360P": 640
};

function createDecoder() {
    if (decoder && decoder.state !== 'closed') {
        try { decoder.close(); } catch(e) {}
    }
    decoder = new VideoDecoder({
        output: handleDecodedFrame,
        error: (e) => {
            self.postMessage({ type: 'error', message: e.message, name: e.name });
            recoverDecoder();
        }
    });
    configured = false;
}

function recoverDecoder() {
    if (!lastConfig) return;
    try {
        createDecoder();
        decoder.configure(lastConfig);
        configured = true;
    } catch(e) {
        configured = false;
    }
}

function handleDecodedFrame(videoFrame) {
    const frameNumber = timestampToFrameNumber.get(videoFrame.timestamp);
    if (frameNumber === undefined) {
        videoFrame.close();
        return;
    }

    createImageBitmap(videoFrame).then(bitmap => {
        videoFrame.close();
        return applyTransforms(bitmap);
    }).then(finalBitmap => {
        self.postMessage({
            type: 'frame',
            groupId: currentGroupId,
            frameNumber: frameNumber,
            bitmap: finalBitmap,
            width: finalBitmap.width,
            height: finalBitmap.height,
        }, [finalBitmap]);
    }).catch(err => {
        try { videoFrame.close(); } catch(e) {}
        self.postMessage({
            type: 'frameError',
            groupId: currentGroupId,
            frameNumber: frameNumber,
            message: err.message,
        });
    });
}

async function applyTransforms(bitmap) {
    if (effectiveRotation !== 0) {
        bitmap = await applyRotation(bitmap, effectiveRotation);
    }
    bitmap = await resizeIfNeeded(bitmap);
    return bitmap;
}

async function applyRotation(image, degrees) {
    const width = image.width;
    const height = image.height;
    const swap = (degrees === 90 || degrees === 270);
    const outW = swap ? height : width;
    const outH = swap ? width : height;

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(image, 0, 0);
    image.close();
    return createImageBitmap(canvas);
}

async function resizeIfNeeded(image) {
    if (!videoMaxSize || videoMaxSize === "None") return image;
    const maxSize = resolutionMap[videoMaxSize];
    if (!maxSize) return image;
    const maxDim = Math.max(image.width, image.height);
    if (maxDim <= maxSize) return image;

    const scale = maxSize / maxDim;
    const newW = Math.round(image.width * scale);
    const newH = Math.round(image.height * scale);

    const canvas = new OffscreenCanvas(newW, newH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, newW, newH);
    image.close();
    return createImageBitmap(canvas);
}

self.onmessage = function(e) {
    const msg = e.data;
    switch (msg.type) {
        case 'configure': {
            createDecoder();
            const config = { codec: msg.codec };
            if (msg.description) {
                config.description = msg.description;
            }
            if (msg.codedWidth) config.codedWidth = msg.codedWidth;
            if (msg.codedHeight) config.codedHeight = msg.codedHeight;
            lastConfig = config;
            try {
                decoder.configure(config);
                configured = true;
                effectiveRotation = msg.effectiveRotation || 0;
                videoMaxSize = msg.videoMaxSize || null;
                self.postMessage({ type: 'configured' });
            } catch (configErr) {
                configured = false;
                self.postMessage({ type: 'configureError', message: configErr.message });
            }
            break;
        }
        case 'decodeGroup': {
            if (!decoder || !configured || decoder.state === 'closed') {
                recoverDecoder();
                if (!decoder || !configured || decoder.state === 'closed') {
                    self.postMessage({ type: 'groupError', groupId: msg.groupId, message: 'Decoder not configured' });
                    return;
                }
            }
            currentGroupId = msg.groupId;
            timestampToFrameNumber.clear();
            for (const mapping of msg.timestampMap) {
                timestampToFrameNumber.set(mapping.timestamp, mapping.frameNumber);
            }
            const chunks = msg.chunks;
            try {
                for (const chunkData of chunks) {
                    const chunk = new EncodedVideoChunk({
                        type: chunkData.type,
                        timestamp: chunkData.timestamp,
                        duration: chunkData.duration,
                        data: chunkData.data,
                    });
                    decoder.decode(chunk);
                }
                flushing = true;
                decoder.flush().then(() => {
                    flushing = false;
                    self.postMessage({ type: 'groupFlushed', groupId: currentGroupId });
                }).catch((err) => {
                    flushing = false;
                    self.postMessage({ type: 'groupError', groupId: currentGroupId, message: err.message });
                });
            } catch (err) {
                self.postMessage({ type: 'groupError', groupId: currentGroupId, message: err.message });
            }
            break;
        }
        case 'updateTransforms': {
            effectiveRotation = msg.effectiveRotation || 0;
            videoMaxSize = msg.videoMaxSize || null;
            break;
        }
        case 'reset': {
            if (decoder && decoder.state !== 'closed') {
                try { decoder.reset(); decoder.configure({ codec: msg.codec, description: msg.description }); } catch(e) {}
            }
            flushing = false;
            self.postMessage({ type: 'resetDone' });
            break;
        }
        case 'dispose': {
            if (decoder && decoder.state !== 'closed') {
                try { decoder.reset(); decoder.close(); } catch(e) {}
            }
            decoder = null;
            configured = false;
            self.close();
            break;
        }
    }
};
`;

let workerBlobUrl = null;

function getWorkerBlobUrl() {
    if (!workerBlobUrl) {
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        workerBlobUrl = URL.createObjectURL(blob);
    }
    return workerBlobUrl;
}

export class VideoDecodeWorkerManager {
    constructor(onFrame, onGroupFlushed, onError) {
        this.onFrame = onFrame;
        this.onGroupFlushed = onGroupFlushed;
        this.onError = onError;
        this.worker = null;
        this.configured = false;
        this.configFailed = false;
        this.busy = false;
        this._disposed = false;
    }

    init() {
        if (this.worker) return;
        this.worker = new Worker(getWorkerBlobUrl());
        this.worker.onmessage = (e) => this._handleMessage(e.data);
        this.worker.onerror = (e) => {
            console.warn("VideoDecodeWorker error:", e.message);
            if (this.onError) this.onError(e.message);
        };
    }

    configure(config, effectiveRotation, videoMaxSize) {
        if (!this.worker || this._disposed) return;
        const msg = {
            type: 'configure',
            codec: config.codec,
            effectiveRotation: effectiveRotation || 0,
            videoMaxSize: videoMaxSize || null,
        };
        if (config.codedWidth) msg.codedWidth = config.codedWidth;
        if (config.codedHeight) msg.codedHeight = config.codedHeight;
        if (config.description) {
            if (config.description instanceof ArrayBuffer) {
                msg.description = config.description.slice(0);
            } else if (config.description.buffer) {
                msg.description = config.description.buffer.slice(
                    config.description.byteOffset,
                    config.description.byteOffset + config.description.byteLength
                );
            }
        }
        this.configFailed = false;
        this.worker.postMessage(msg, msg.description ? [msg.description] : []);
    }

    decodeGroup(groupId, chunks, rawChunkDataArray, timestampMap) {
        if (!this.worker || this._disposed || !this.configured) return false;
        if (this.busy) return false;
        this.busy = true;

        const transferList = [];
        const chunkDataArray = [];
        for (let i = 0; i < rawChunkDataArray.length; i++) {
            const raw = rawChunkDataArray[i];
            const copy = raw.slice(0);
            chunkDataArray.push({
                type: chunks[i].type,
                timestamp: chunks[i].timestamp,
                duration: chunks[i].duration,
                data: copy,
            });
            transferList.push(copy);
        }

        this.worker.postMessage({
            type: 'decodeGroup',
            groupId: groupId,
            chunks: chunkDataArray,
            timestampMap: timestampMap,
        }, transferList);
        return true;
    }

    updateTransforms(effectiveRotation, videoMaxSize) {
        if (!this.worker || this._disposed) return;
        this.worker.postMessage({
            type: 'updateTransforms',
            effectiveRotation: effectiveRotation || 0,
            videoMaxSize: videoMaxSize || null,
        });
    }

    dispose() {
        this._disposed = true;
        if (this.worker) {
            this.worker.postMessage({ type: 'dispose' });
            this.worker.onmessage = null;
            this.worker.onerror = null;
            this.worker = null;
        }
        this.configured = false;
        this.busy = false;
    }

    _handleMessage(msg) {
        if (this._disposed) return;
        switch (msg.type) {
            case 'configured':
                this.configured = true;
                break;
            case 'configureError':
                this.configured = false;
                this.configFailed = true;
                console.warn("Worker decoder configure failed:", msg.message);
                break;
            case 'frame':
                if (this.onFrame) {
                    this.onFrame(msg.groupId, msg.frameNumber, msg.bitmap, msg.width, msg.height);
                }
                break;
            case 'frameError':
                console.debug(`Worker frame decode error: group=${msg.groupId} frame=${msg.frameNumber}: ${msg.message}`);
                if (this.onFrame) {
                    this.onFrame(msg.groupId, msg.frameNumber, null, 0, 0);
                }
                break;
            case 'groupFlushed':
                this.busy = false;
                if (this.onGroupFlushed) {
                    this.onGroupFlushed(msg.groupId);
                }
                break;
            case 'groupError':
                this.busy = false;
                console.debug(`Worker group error: group=${msg.groupId}: ${msg.message}`);
                if (this.onError) {
                    this.onError(msg.message, msg.groupId);
                }
                break;
            case 'error':
                console.debug(`Worker decoder error (recovered): ${msg.message}`);
                if (this.onError) {
                    this.onError(msg.message);
                }
                break;
            case 'resetDone':
                this.busy = false;
                break;
        }
    }
}
