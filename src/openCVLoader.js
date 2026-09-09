import {buildAssetURL} from './release/assetURL';
let cv = null;
let cvLoadPromise = null;

export function loadOpenCV() {
    if (cv) return Promise.resolve();
    if (cvLoadPromise) return cvLoadPromise;

    cvLoadPromise = new Promise((resolve, reject) => {
        let done = false;

        const fail = (err) => {
            if (done) return;
            done = true;
            cvLoadPromise = null;
            reject(err);
        };

        const succeed = () => {
            if (done) return;
            done = true;
            cv = window.cv;
            resolve();
        };

        const timeout = setTimeout(() => {
            fail(new Error("OpenCV.js load timeout (60s)"));
        }, 60000);

        if (window.cv && window.cv.onRuntimeInitialized == null && window.cv.Mat) {
            clearTimeout(timeout);
            succeed();
            return;
        }

        window.cv = window.cv || {};
        if (typeof window.cv.locateFile !== "function") {
            window.cv.locateFile = (file) => buildAssetURL("./libs/" + file);
        }

        const existing = document.querySelector('script[data-opencvjs="1"]');
        if (existing) {
            clearTimeout(timeout);
            if (window.cv && window.cv.Mat) {
                succeed();
            } else {
                const prevCallback = window.cv.onRuntimeInitialized;
                window.cv.onRuntimeInitialized = () => {
                    try { if (typeof prevCallback === "function") prevCallback(); } catch {}
                    succeed();
                };
            }
            return;
        }

        const script = document.createElement("script");
        script.src = buildAssetURL("./libs/opencv.js");
        script.async = true;
        script.dataset.opencvjs = "1";

        script.onerror = () => {
            clearTimeout(timeout);
            fail(new Error("Failed to load OpenCV.js script"));
        };

        script.onload = () => {
            const prevOnInit = window.cv?.onRuntimeInitialized;
            window.cv.onRuntimeInitialized = () => {
                try { if (typeof prevOnInit === "function") prevOnInit(); } catch {}
                clearTimeout(timeout);
                succeed();
            };
            
            const start = performance.now();
            const poll = () => {
                if (done) return;
                if (window.cv && window.cv.Mat) {
                    clearTimeout(timeout);
                    succeed();
                    return;
                }
                if (performance.now() - start > 60000) {
                    return;
                }
                setTimeout(poll, 50);
            };
            setTimeout(poll, 100);
        };

        document.head.appendChild(script);
    });

    return cvLoadPromise;
}

export function getCV() {
    return cv;
}
