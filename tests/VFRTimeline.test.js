/**
 * @jest-environment jsdom
 */
jest.mock('../src/Globals', () => ({Globals: {}, Sit: {}}));
jest.mock('../src/assert', () => ({
    assert: (cond, msg) => { if (!cond) throw new Error("assert: " + msg); },
}));

import {Sit} from '../src/Globals';
import {par} from '../src/par';
import {CVideoPatchedData} from '../src/CVideoPatchedData';
import {TimelineMarkers} from '../src/TimelineMarkers';
import {
    analyzeFrameTiming, registerFrameRemap, remapFrameEntries, remapFrameNumber, remapTimelineFrames,
    unsupportedFrameData,
} from '../src/VFRTimeline';

// The step pattern of a real phone clip (915 frames): 30 fps at frames 0–59 and 256–328,
// 24 fps elsewhere, and two 43.3 ms steps.
function phoneClipPTS() {
    const steps = [];
    for (let i = 1; i < 915; i++) {
        if (i <= 59 || (i > 256 && i <= 328)) steps.push(1e6 / 30);
        else if (i === 176 || i === 618) steps.push(43333);
        else steps.push(1e6 / 24);
    }
    const pts = [0];
    for (const step of steps) pts.push(pts.at(-1) + step);
    return pts.map(Math.round);
}

function fakeSource(framePTSus) {
    return {
        id: 'fake-source', frames: framePTSus.length, framePTSus, originalFps: 24.705,
        videoWidth: 1920, videoHeight: 1080, originalVideoWidth: 1920, originalVideoHeight: 1080,
        hasRealFramePTS: () => true, getMediaInfo: () => ({}),
    };
}

test('a variable-frame-rate phone clip is detected, with its steady rates and drift', () => {
    const timing = analyzeFrameTiming(phoneClipPTS());
    expect(timing.variable).toBe(true);
    expect(timing.steadyMaxFps).toBe(30);
    // The slowest 8 frames include a 43.3 ms step: 23.88 fps, nearest standard 23.976.
    expect(timing.steadyMinFps).toBeCloseTo(24, 0);
    expect(timing.meanFps).toBeCloseTo(24.7, 1);
    expect(timing.maxDriftS).toBeGreaterThan(0.6);
    expect(timing.maxDriftS).toBeLessThan(0.8);
});

test('constant-rate video is not variable, even with timestamp jitter', () => {
    let seed = 3;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [fps, standard] of [[30, 30], [30000 / 1001, 29.97], [24000 / 1001, 23.976], [25, 25], [60, 60]]) {
        const clean = Array.from({length: 2000}, (_, i) => Math.round(i * 1e6 / fps));
        expect(analyzeFrameTiming(clean)).toMatchObject({variable: false, steadyMaxFps: standard, steadyMinFps: standard});
        // ±1 ms of jitter, as phone files have, does not accumulate.
        const jittered = clean.map((time, i) => i ? time + Math.round((random() - .5) * 2000) : 0);
        expect(analyzeFrameTiming(jittered).variable).toBe(false);
    }
});

test('the VFR Fix timeline keeps every frame of the clip, and converts frame numbers both ways', () => {
    const source = fakeSource(phoneClipPTS());
    const wrapper = new CVideoPatchedData(source, {fps: 30, vfr: true});
    expect(wrapper.frames).toBeGreaterThan(1100);
    expect(wrapper.frames).toBeLessThan(1120);
    for (let s = 0; s < source.frames; s++) expect(wrapper.virtualToSource(wrapper.sourceToVirtual(s))).toBe(s);
    // Source frame 117 is at 4.38 s, so frame 131 or 132 of a 30 fps timeline.
    expect([131, 132]).toContain(wrapper.sourceToVirtual(117));
    // VFR holds are normal frames, so they get no debug marker.
    expect(wrapper.heldMarker).toBe(false);
    expect(new CVideoPatchedData(source, {fps: 30}).heldMarker).toBe(true);
});

test('audio of a wrapped video plays at its real time and rate', () => {
    const wrapper = new CVideoPatchedData(fakeSource(phoneClipPTS()), {fps: 30, vfr: true});
    const audio = wrapper.audioTiming(300, 30);
    expect(audio.frame / 24.705).toBeCloseTo(10, 9);   // virtual frame 300 at 30 fps is 10 s
    expect(audio.fps / 24.705).toBeCloseTo(1, 9);       // and plays at normal speed
});

test('frame numbers convert with the end of the timeline kept at the end', () => {
    const context = {oldFrames: 100, newFrames: 200};
    const double = frame => frame * 2;
    expect(remapFrameNumber(10, double, context)).toBe(20);
    expect(remapFrameNumber(99, double, context)).toBe(199);
    expect(remapFrameNumber(150, double, context)).toBe(199);
    expect(remapFrameNumber(undefined, double, context)).toBeUndefined();
    expect([...remapFrameEntries([[1, 'a'], [2, 'b'], [3, 'c']], frame => Math.floor(frame / 2))])
        .toEqual([[0, 'a'], [1, 'b']]);
});

test('one conversion moves the timeline, the markers, registered kinds and nodes', () => {
    Object.assign(Sit, {aFrame: 10, bFrame: 99});
    par.frame = 30;
    TimelineMarkers.restore([{frame: 40, label: 'flash'}]);
    const seen = [];
    registerFrameRemap('testKind', remap => seen.push(remap(5)));
    const node = {remapFrames: jest.fn()};
    remapTimelineFrames(frame => frame * 2, {oldFrames: 100, newFrames: 200}, [node, {}]);
    expect([Sit.aFrame, Sit.bFrame, par.frame]).toEqual([20, 199, 60]);
    expect(TimelineMarkers.list()).toEqual([{frame: 80, label: 'flash'}]);
    expect(seen).toEqual([10]);
    expect(node.remapFrames).toHaveBeenCalledTimes(1);
    TimelineMarkers.restore([]);
});

test('frame data with no converter yet is found in a saved sitch, defaults are not', () => {
    expect(unsupportedFrameData({})).toEqual([]);
    expect(unsupportedFrameData({subSitchesData: {subSitches: [{}]}, mods: {fovSwitch: {choice: 'userFOV'},
        lookCamera: {switchToGroundTrackFrame: 0}, videoInfo: {offsetFrameValue: 0}}, pars: {trackToTrackStopAt: 0}}))
        .toEqual([]);
    expect(unsupportedFrameData({subSitchesData: {subSitches: [{}, {}]}, syntheticTracks: [{}],
        mods: {fovSwitch: {choice: 'FOV Editor'}, LOSFitAnalysisResult1: {}, groundTrack: {keyframes: [{frame: 3}]}}}))
        .toEqual(['chapters', 'groundTrack', 'fovEditor', 'syntheticTracks', 'losFit']);
});
