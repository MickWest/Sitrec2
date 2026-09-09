import {buildAssetURL} from './release/assetURL';
let jsfeatLib = null;
let jsfeatLoadPromise = null;

export function loadJsfeat() {
    if (jsfeatLib) return Promise.resolve();
    if (jsfeatLoadPromise) return jsfeatLoadPromise;

    jsfeatLoadPromise = new Promise((resolve, reject) => {
        if (window.jsfeat) {
            jsfeatLib = window.jsfeat;
            resolve();
            return;
        }

        const script = document.createElement("script");
        script.src = buildAssetURL("./libs/jsfeat.js");
        script.async = true;

        script.onerror = () => {
            jsfeatLoadPromise = null;
            reject(new Error("Failed to load jsfeat.js script"));
        };

        script.onload = () => {
            if (window.jsfeat) {
                jsfeatLib = window.jsfeat;
                resolve();
            } else {
                jsfeatLoadPromise = null;
                reject(new Error("jsfeat loaded but not available on window"));
            }
        };

        document.head.appendChild(script);
    });

    return jsfeatLoadPromise;
}

export function getJsfeat() {
    return jsfeatLib;
}
