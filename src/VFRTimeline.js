// Variable frame rate (VFR) video, and the VFR Fix.
//
// Sitrec maps a frame number to time on a straight line: time = start + frame / Sit.fps.
// The frames of a VFR video (common from phones) are not evenly spaced, so at the mean
// rate some parts play slow and others fast, and the time of a frame can be wrong by a
// large part of a second. The VFR Fix wraps such a video in CVideoPatchedData at its
// fastest steady rate: a constant-rate timeline in which each frame number shows the
// video frame nearest its real time, and a frame is held where the video is slower.
//
// Turning the Fix on or off changes the image that each frame number shows, so every
// saved frame number must change with it. The owner of each kind of frame data
// registers a converter here, or (for a node) has a remapFrames(remap, context) method.
// Kinds that have no converter yet are found in the saved sitch (unsupportedFrameData);
// while one of them holds data, the Fix stays off for that sitch.

import {Sit} from "./Globals";
import {par} from "./par";
import {snapFps} from "./FrameRates";
import {TimelineMarkers} from "./TimelineMarkers";

// Frames over which a rate must hold to count as steady, so timestamp jitter averages out.
const STEADY_RUN = 8;

// Timing of a video's frames from their presentation times (microseconds, display
// order). variable: somewhere the times drift more than half a frame from a constant
// rate. Jitter does not accumulate, so a constant-rate video never qualifies.
export function analyzeFrameTiming(timestamps, frames = timestamps?.length ?? 0) {
    if (!timestamps || frames <= STEADY_RUN || timestamps.length < frames) return null;
    const t0 = timestamps[0], step = (timestamps[frames - 1] - t0) / (frames - 1);
    if (!(step > 0)) return null;
    let maxDrift = 0, fastest = Infinity, slowest = 0;
    for (let i = 1; i < frames; i++) {
        if (!(timestamps[i] > timestamps[i - 1])) return null;
        maxDrift = Math.max(maxDrift, Math.abs(timestamps[i] - (t0 + i * step)));
        if (i >= STEADY_RUN) {
            const run = (timestamps[i] - timestamps[i - STEADY_RUN]) / STEADY_RUN;
            fastest = Math.min(fastest, run);
            slowest = Math.max(slowest, run);
        }
    }
    return {
        variable: maxDrift > step / 2,
        frames,
        meanFps: 1e6 / step,
        steadyMinFps: snapFps(1e6 / slowest),
        steadyMaxFps: snapFps(1e6 / fastest),
        maxDriftS: maxDrift / 1e6,
    };
}

const converters = new Map();

// convert(remap, context) changes one kind of frame data. remap(oldFrame) gives the
// frame in the new timeline. context: {oldFrames, newFrames, from, to} (timeline
// lengths and the video data before and after).
export function registerFrameRemap(name, convert) {
    converters.set(name, convert);
}

// A frame in the new timeline. A frame at or past the old last frame (an Out marker
// at the end) stays at the end; others go through map.
export function remapFrameNumber(frame, map, {oldFrames, newFrames}) {
    if (!Number.isFinite(frame)) return frame;
    if (frame >= oldFrames - 1) return newFrames - 1;
    return map(Math.max(0, Math.round(frame)));
}

// Frame-keyed entries [[frame, value], …] in the new timeline. Where two frames land on
// one (at a lower rate), the first is kept.
export function remapFrameEntries(entries, remap) {
    const out = new Map();
    for (const [frame, value] of entries) {
        const next = remap(frame);
        if (!out.has(next)) out.set(next, value);
    }
    return out;
}

export function remapTimelineFrames(map, context, nodes = []) {
    const remap = frame => remapFrameNumber(frame, map, context);
    for (const convert of converters.values()) convert(remap, context);
    for (const node of nodes) node.remapFrames?.(remap, context);
}

// The timeline itself: the current frame and the In/Out markers.
registerFrameRemap("timeline", remap => {
    par.frame = remap(par.frame);
    Sit.aFrame = remap(Sit.aFrame);
    Sit.bFrame = remap(Sit.bFrame);
});

// Timeline markers. TimelineMarkers.js keeps no Globals imports, so it is converted here.
registerFrameRemap("timelineMarkers", remap => {
    const markers = TimelineMarkers.list();
    if (markers.length) TimelineMarkers.restore(markers.map(marker => ({...marker, frame: remap(marker.frame)})));
});

// Saved frame data that has no converter yet, by id, tested on a saved sitch object
// (CustomManager.getCustomSitchString). Each test is false for the default state.
const UNSUPPORTED = {
    chapters: s => (s.subSitchesData?.subSitches?.length ?? 0) > 1,
    groundTrack: s => s.mods?.groundTrack?.keyframes?.length > 0,
    cameraState: s => s.mods?.cameraState?.modeKeys?.length > 0 || s.mods?.cameraState?.cameraState !== undefined,
    fovEditor: s => s.mods?.fovSwitch?.choice === "FOV Editor",
    syntheticTracks: s => s.syntheticTracks?.length > 0,
    groundTrackSwitch: s => Object.values(s.mods ?? {}).some(m => m?.switchToGroundTrackFrame > 0),
    starTracker: s => Object.values(s.mods ?? {}).some(m => Array.isArray(m?.poseTrack)),
    losFit: s => Object.keys(s.mods ?? {}).some(id => id.startsWith("LOSFitAnalysisResult")),
    elevationCache: s => Object.values(s.mods ?? {}).some(m => m?.elevationCache?.length > 0),
    frameOffset: s => Number(s.mods?.videoInfo?.offsetFrameValue ?? 0) !== 0,
    trackToTrackStop: s => Number(s.pars?.trackToTrackStopAt ?? 0) > 0,
};

export function unsupportedFrameData(sitch) {
    return Object.keys(UNSUPPORTED).filter(id => UNSUPPORTED[id](sitch ?? {}));
}
