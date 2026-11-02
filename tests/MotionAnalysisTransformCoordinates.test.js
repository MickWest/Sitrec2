import {MotionAnalyzer, setCv} from '../src/CMotionAnalysis';
import {MotionAnalysisCore} from '../src/MotionAnalysisCore';

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

const width = 320, height = 240;

// Supply an independently specified image transform at the OpenCV boundary.
// These tests check the conversion from a fitted matrix into Sitrec's centered,
// per-frame motion convention, without relying on noisy feature estimation.
function fittedTransform({angle = 0, scale = 1, dx = 0, dy = 0}) {
    const a = scale * Math.cos(angle), b = scale * Math.sin(angle);
    return [a, -b, width / 2 * (1 - a) + height / 2 * b + dx,
        b, a, height / 2 * (1 - a) - width / 2 * b + dy];
}

function cvWithFit(values) {
    class Mat {
        constructor(data = []) { this.values = data; this.data = new Uint8Array(4).fill(1); }
        static eye() { return new Mat([1, 0, 0, 0, 1, 0]); }
        floatAt(row, col) { return this.values[row * 3 + col]; }
        doubleAt(row, col) { return this.values[row * 3 + col]; }
        delete() {}
        empty() { return false; }
    }
    return {Mat, TermCriteria: class {}, matFromArray: () => new Mat(),
        findTransformECC: (_previous, _current, warp) => { warp.values = values; return 1; },
        estimateAffine2D: () => new Mat(values),
        estimateAffinePartial2D: () => new Mat(values)};
}

function analyzerFor(kind, cv) {
    setCv(cv);
    const analyzer = kind === 'browser' ? new MotionAnalyzer({}) : new MotionAnalysisCore(cv);
    analyzer.isPointMasked = () => false;
    analyzer.trackFeatures = () => ({prevPoints: [[20, 20], [300, 20], [20, 220], [300, 220]],
        nextPoints: [[20, 20], [300, 20], [20, 220], [300, 220]], qualities: [1, 1, 1, 1]});
    return analyzer;
}

describe.each(['browser', 'core'])('%s fitted motion coordinates', kind => {
    test.each([1, 3])('centered roll has zero translation over a %s-frame interval', gap => {
        const angle = Math.PI / 60;
        const analyzer = analyzerFor(kind, cvWithFit(fittedTransform({angle})));
        for (const method of ['computeECC', 'computeAffineRANSAC']) {
            const result = analyzer[method]({}, {}, width, height, gap);
            const motion = result.consensus ?? result;
            expect(motion.dx).toBeCloseTo(0, 10);
            expect(motion.dy).toBeCloseTo(0, 10);
            expect(motion.rotation).toBeCloseTo(angle / gap, 10);
            if (result.flowVectors && method === 'computeECC') {
                // Symmetric sample positions have zero mean motion under a
                // rotation about the center, so their arrows must do so too.
                const mean = key => result.flowVectors.reduce((sum, v) => sum + v[key], 0) / result.flowVectors.length;
                expect(mean('dx')).toBeCloseTo(0, 10);
                expect(mean('dy')).toBeCloseTo(0, 10);
            }
        }
    });

    test.each([1, 3])('zoom and roll preserve the center displacement over %s frames', gap => {
        const angle = -Math.PI / 30;
        const analyzer = analyzerFor(kind, cvWithFit(fittedTransform({angle, scale: 1.1, dx: 12, dy: -6})));
        const result = analyzer.computeAffineRANSAC({}, {}, width, height, gap);
        const motion = result.consensus ?? result;
        expect(motion.dx).toBeCloseTo(12 / gap, 10);
        expect(motion.dy).toBeCloseTo(-6 / gap, 10);
        expect(motion.rotation).toBeCloseTo(angle / gap, 10);
    });
});
