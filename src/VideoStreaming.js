import {toCanonicalSitrecRef} from './SitrecObjectResolver';

export function canStreamVideo(ref, sitch) {
    const canonical = toCanonicalSitrecRef(ref);
    if (typeof canonical !== 'string' || !/^(https?:\/\/|sitrec:\/\/)/i.test(canonical)) return false;
    if (!/\.(mp4|mov|m4v|h264|dad)(?:[?#]|$)/i.test(canonical)) return false;
    if (!Number.isFinite(sitch?.frames) || sitch.frames <= 0) return false;
    // Raw streams with explicit timing require full frame-count validation
    // against their sidecar before their timestamps can safely be paired.
    return !Object.entries(sitch.loadedFiles || {}).some(([id, source]) =>
        toCanonicalSitrecRef(source) === canonical && sitch.loadedFilesMetadata?.[id]?.pesSidecarURL);
}

export function isVideoRestoredByStreaming(ref, sitch) {
    if (!canStreamVideo(ref, sitch)) return false;
    const canonical = toCanonicalSitrecRef(ref);
    return [sitch.videoFile, sitch.videoFile2,
        ...(sitch.videos || []).map(v => v.staticURL || sitch.loadedFiles?.[v.fileName]),
        ...(sitch.videos2 || []).map(v => v.staticURL || sitch.loadedFiles?.[v.fileName]),
    ].some(source => source && toCanonicalSitrecRef(source) === canonical);
}

const bufferingViews = new Set();
export function registerBufferingView(view) { bufferingViews.add(view); }
export function unregisterBufferingView(view) { bufferingViews.delete(view); }
export function isVideoBuffering() {
    for (const view of bufferingViews) if (view.getStreamBufferingTarget() !== null) return true;
    return false;
}
