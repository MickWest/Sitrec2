import {Globals, setRenderOne} from './Globals';

export const VIDEO_RESOLUTIONS = ['None', '1080P', '720P', '480P', '360P'];
const maxSides = {'1080P': 1920, '720P': 1280, '480P': 854, '360P': 640};
const sources = new Set();
const sessions = new Map();
// Session-local: analysis choices do not change the user's playback preference.
export const videoAnalysisResolution = {value: 'None'};

function sourceOf(video) {
    while (video?.source && typeof video.virtualToSource === 'function') video = video.source;
    return video;
}

function globalResolution() {
    return Globals.settings?.videoMaxSize || 'None';
}

export function getVideoDecodeResolution(video, forAnalysis = false) {
    const active = forAnalysis || sessions.get(sourceOf(video))?.size > 0;
    return active && videoAnalysisResolution.value !== 'settings'
        ? videoAnalysisResolution.value : globalResolution();
}

export function videoResolutionDimensions(width, height, limit) {
    const scale = Math.min(1, (maxSides[limit] || Infinity) / Math.max(width, height));
    return {width: Math.round(width * scale), height: Math.round(height * scale)};
}

export function registerVideoResolutionSource(video) {
    sources.add(video);
    video._settingsResolution = globalResolution();
}

export function unregisterVideoResolutionSource(video) {
    sources.delete(video);
    sessions.delete(video);
}

function refresh(video) {
    if (sources.has(video)) video.onVideoResolutionChanged();
}

function changesDimensions(video, before, after) {
    if (before === after) return false;
    const w = video?.originalVideoWidth, h = video?.originalVideoHeight;
    if (!w || !h) return true;
    const a = videoResolutionDimensions(w, h, before);
    const b = videoResolutionDimensions(w, h, after);
    return a.width !== b.width || a.height !== b.height;
}

// Both user controls flush, even if an active override happens to make the
// effective resolution the same. In-flight jobs are cancelled before they can
// mix measurements made at different pixel scales.
function invalidate(video) {
    const active = [...(sessions.get(video) || [])];
    for (const session of active) {
        session.cancelled = true;
        session.onChange?.();
    }
    refresh(video);
}

export function notifyVideoResolutionSettingsChanged() {
    for (const video of sources) {
        if (video._settingsResolution === globalResolution()) continue;
        video._settingsResolution = globalResolution();
        invalidate(video);
    }
    setRenderOne(true);
}

export function setVideoAnalysisResolution(value) {
    if (value !== 'settings' && !VIDEO_RESOLUTIONS.includes(value)) return;
    if (videoAnalysisResolution.value === value) return;
    videoAnalysisResolution.value = value;
    for (const video of sources) invalidate(video);
    setRenderOne(true);
}

export function beginVideoAnalysis(video, onChange) {
    const source = sourceOf(video);
    const before = getVideoDecodeResolution(source);
    const session = {cancelled: false, onChange};
    if (!sessions.has(source)) sessions.set(source, new Set());
    sessions.get(source).add(session);
    if (changesDimensions(source, before, getVideoDecodeResolution(source))) refresh(source);
    let ended = false;
    session.end = () => {
        if (ended) return;
        ended = true;
        const beforeEnd = getVideoDecodeResolution(source);
        sessions.get(source)?.delete(session);
        if (!sessions.get(source)?.size) sessions.delete(source);
        if (changesDimensions(source, beforeEnd, getVideoDecodeResolution(source))) refresh(source);
    };
    return session;
}

export function addVideoAnalysisResolutionMenu(folder, getVideo) {
    const choice = {
        get analysisResolution() { return videoAnalysisResolution.value; },
        set analysisResolution(value) { setVideoAnalysisResolution(value); },
    };
    folder.add(choice, 'analysisResolution', {
        'Use Settings': 'settings', 'Original (no limit)': 'None',
        '1080p': '1080P', '720p': '720P', '480p': '480P', '360p': '360P',
    }).name('Analysis Resolution').listen().perm()
        .tooltip('Shared by video analysis tools in this tab. Overrides Settings only during analysis. Changing either resolution clears decoded frames; restart a running analysis after changing it.');
    const status = {get resolutionStatus() {
        const video = getVideo?.();
        if (!video) return 'No video loaded';
        const w = video.originalVideoWidth || video.videoWidth;
        const h = video.originalVideoHeight || video.videoHeight;
        const size = videoResolutionDimensions(w, h, getVideoDecodeResolution(video, true));
        return size.width < w || size.height < h
            ? `Reduced: ${size.width}×${size.height} (source ${w}×${h})`
            : `Source resolution: ${w}×${h}`;
    }};
    folder.add(status, 'resolutionStatus').name('Analysis pixels').listen().disable().perm()
        .tooltip('Reduced resolution can hide small objects and shift measured positions. Choose Original above to analyse every source pixel.');
}
