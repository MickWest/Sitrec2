// The duplicate-frame check of motion analysis waits for the previous frame.
//
// A video's getImage gives the closest decoded frame when the one asked for is not decoded
// yet, which is often the frame being analyzed. Compared with itself, every frame is an
// exact duplicate, and its zero motion was cached as the final result: an analysis that
// showed no motion vectors on a moving video, depending on decode timing.

import {MotionAnalyzer, setCv} from '../src/CMotionAnalysis';

jest.mock('../src/Globals', () => ({Globals: {}, Sit: {frames: 1}}));
jest.mock('../src/par', () => ({}));
jest.mock('../src/VideoAnalysisResolution', () => ({}));
jest.mock('../src/CMotionAnalysisShared', () => ({}));
jest.mock('../src/nodes/CNodeMaskOverlay', () => ({}));
jest.mock('../src/nodes/CNodeSpeedOverlay', () => ({}));
jest.mock('../src/openCVLoader', () => ({}));
jest.mock('../src/nodes/CNodeVideoView', () => ({}));
jest.mock('../src/FlowAlignment', () => ({}));
jest.mock('../src/RedactionDetect', () => ({}));
jest.mock('../src/i18n', () => ({t: key => key}));

// A video whose decoded frames are the ones listed; getImage of any other frame gives a
// decoded one instead, as the WebCodec video does.
function video(decoded) {
    const image = {width: 640, height: 480};
    return {
        isFrameLoaded: frame => decoded.includes(frame),
        getImage: jest.fn(() => image),
    };
}

function analyzer(videoData) {
    return Object.assign(Object.create(MotionAnalyzer.prototype), {
        params: {skipDuplicateFrames: true, blurSize: 1},
        duplicateFrameCache: new Map(),
        resultCache: new Map(),
        videoView: {videoData},
        active: true,
        suspendAnalysis: false,
    });
}

describe("the duplicate check before the previous frame is decoded", () => {
    test("is pending, asks for the previous frame, and caches nothing", () => {
        const videoData = video([10]);
        const motion = analyzer(videoData);
        const result = motion.detectDuplicateFrame(10, {});
        expect(result).toMatchObject({pending: true, isDuplicate: false});
        expect(videoData.getImage).toHaveBeenCalledWith(9);
        expect(motion.duplicateFrameCache.has(10)).toBe(false);
    });

    test("frame 0 has no previous frame and is never a duplicate", () => {
        const motion = analyzer(video([]));
        expect(motion.detectDuplicateFrame(0, {})).toMatchObject({isDuplicate: false});
        expect(motion.detectDuplicateFrame(0, {}).pending).toBeUndefined();
    });
});

describe("whether the analysis of a frame is still pending", () => {
    beforeAll(() => setCv({}));
    afterAll(() => setCv(null));

    test("no result yet, or a result that waits for a frame: pending", () => {
        const motion = analyzer(video([10]));
        expect(motion.isResultPending(10)).toBe(true);
        motion.resultCache.set(10, {flowData: null, incomplete: true});
        expect(motion.isResultPending(10)).toBe(true);
    });

    test("a finished result: not pending", () => {
        const motion = analyzer(video([9, 10]));
        motion.resultCache.set(10, {flowData: {vectors: []}});
        expect(motion.isResultPending(10)).toBe(false);
    });

    test("analysis off or suspended: never pending", () => {
        const off = analyzer(video([10]));
        off.active = false;
        expect(off.isResultPending(10)).toBe(false);
        const suspended = analyzer(video([10]));
        suspended.suspendAnalysis = true;
        expect(suspended.isResultPending(10)).toBe(false);
    });
});
