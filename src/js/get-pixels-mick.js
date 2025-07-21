"use strict"
var ndarray = require("ndarray")

class ImageQueueManager {
    constructor() {
        this.queue = [];
        this.activeRequests = 0;
        this.maxActiveRequests = 5;
        this.maxRetries = 3;
        this.errorOccurred = false; // New flag to track if an error has occurred
    }

    dispose() {
        this.queue = [];
        this.activeRequests = 0;
    }

    enqueueImage(url, cb, retries = 0) {
        this.queue.push({ url, cb, retries });
        this.processQueue();
//        console.log("Enqueued " + url);
    }

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

        this.defaultImage(url, (err, result) => {
            this.activeRequests--;
            if (err) {
                console.log("Err..... " + url);
                this.errorOccurred = true; // Set the flag on error
                if (retries < this.maxRetries) {
                    console.warn("Retrying (re-queueing) " + url);
                    this.enqueueImage(url, cb, retries + 1);
                } else {
                    cb(err, null);
                }
            } else {
                cb(null, result);
            }

            if (this.queue.length === 0) {
                this.errorOccurred = false; // Reset the flag when the queue is empty
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
        }, 100); // Delay by 0.1 second
    } else {
        img.src = url;
    }
}
}

// Usage
export const imageQueueManager = new ImageQueueManager();

export function getPixels(url, cb) {
    imageQueueManager.enqueueImage(url, cb);
}
