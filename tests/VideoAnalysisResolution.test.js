import {Globals} from '../src/Globals';
import {beginVideoAnalysis, getVideoDecodeResolution, registerVideoResolutionSource,
    unregisterVideoResolutionSource, setVideoAnalysisResolution, videoAnalysisResolution,
    notifyVideoResolutionSettingsChanged, videoResolutionDimensions} from '../src/VideoAnalysisResolution';

jest.mock('../src/Globals', () => ({Globals: {settings: {videoMaxSize: '720P'}}, setRenderOne: jest.fn()}));

let video;
beforeEach(() => {
    Globals.settings.videoMaxSize = '720P';
    setVideoAnalysisResolution('None');
    video = {onVideoResolutionChanged: jest.fn()};
    registerVideoResolutionSource(video);
});
afterEach(() => unregisterVideoResolutionSource(video));

test('analysis defaults to original pixels and playback keeps the Settings cap', () => {
    expect(videoAnalysisResolution.value).toBe('None');
    expect(getVideoDecodeResolution(video)).toBe('720P');
    const session = beginVideoAnalysis(video);
    expect(getVideoDecodeResolution(video)).toBe('None');
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(1);
    session.end();
    expect(getVideoDecodeResolution(video)).toBe('720P');
    expect(Globals.settings.videoMaxSize).toBe('720P');
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(2);
    session.end();
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(2);
});

test('overlapping analysis and preview keep their resolution until both finish', () => {
    const one = beginVideoAnalysis(video), two = beginVideoAnalysis(video);
    one.end();
    expect(getVideoDecodeResolution(video)).toBe('None');
    two.end();
    expect(getVideoDecodeResolution(video)).toBe('720P');
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(2);
});

test('changing Settings flushes even while an override takes priority', () => {
    const cancel = jest.fn();
    const session = beginVideoAnalysis(video, cancel);
    video.onVideoResolutionChanged.mockClear();
    Globals.settings.videoMaxSize = '480P';
    notifyVideoResolutionSettingsChanged();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(session.cancelled).toBe(true);
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(1);
    expect(getVideoDecodeResolution(video)).toBe('None');
    session.end();
    expect(getVideoDecodeResolution(video)).toBe('480P');
});

test('changing the analysis dropdown flushes inactive videos too', () => {
    setVideoAnalysisResolution('1080P');
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(1);
    expect(getVideoDecodeResolution(video)).toBe('720P');
    expect(getVideoDecodeResolution(video, true)).toBe('1080P');
});

test('Use Settings follows playback and never switches size just for analysis', () => {
    setVideoAnalysisResolution('settings');
    video.onVideoResolutionChanged.mockClear();
    const session = beginVideoAnalysis(video);
    expect(getVideoDecodeResolution(video)).toBe('720P');
    session.end();
    expect(video.onVideoResolutionChanged).not.toHaveBeenCalled();
});

test('a patched timeline applies its override to the underlying decoder', () => {
    const wrapper = {source: video, virtualToSource: v => v};
    const session = beginVideoAnalysis(wrapper);
    expect(getVideoDecodeResolution(video)).toBe('None');
    expect(getVideoDecodeResolution(wrapper)).toBe('None');
    session.end();
    expect(getVideoDecodeResolution(video)).toBe('720P');
});

test('dimensions preserve aspect ratio and never upscale a smaller source', () => {
    expect(videoResolutionDimensions(1920, 1080, '720P')).toEqual({width: 1280, height: 720});
    expect(videoResolutionDimensions(1080, 1920, '720P')).toEqual({width: 720, height: 1280});
    expect(videoResolutionDimensions(640, 480, '1080P')).toEqual({width: 640, height: 480});
    expect(videoResolutionDimensions(3840, 2160, 'None')).toEqual({width: 3840, height: 2160});
});

test('starting analysis on a small video reuses its already full-resolution cache', () => {
    video.originalVideoWidth = 640; video.originalVideoHeight = 480;
    const session = beginVideoAnalysis(video);
    session.end();
    expect(video.onVideoResolutionChanged).not.toHaveBeenCalled();
    setVideoAnalysisResolution('1080P');
    expect(video.onVideoResolutionChanged).toHaveBeenCalledTimes(1);
});
