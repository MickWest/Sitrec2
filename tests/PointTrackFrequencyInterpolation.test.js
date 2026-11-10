// Frequency Analysis over a track with gaps: the view measures the frames that
// have no tracked point on the track line, and keeps what the graph and the CSV
// need to say so. Only frames with no position at all stop it.
jest.mock("../src/Globals", () => ({
    Globals: {loadGeneration: 1}, NodeMan: {get: jest.fn()}, setRenderOne: jest.fn(), Sit: {frames: 1798},
}));
jest.mock("../src/i18n", () => ({t: (key, values) => values ? `${key} ${JSON.stringify(values)}` : key}));
jest.mock("../src/CViewManager", () => ({ViewMan: {fullscreenSuppressed: new Set()}}));
jest.mock("../src/nodes/CNodeCustomGraphView", () => ({CNodeCustomGraphView: class {
    constructor(v) { this.id = v.id; this.basePresses = 0; }
    modSerialize() { return {}; }
    modDeserialize() {}
    onMouseDown() { this.basePresses++; }
    onMouseMove() {}
}}));
jest.mock("../src/nodes/CNodeTabbedCanvasView", () => ({CNodeTabbedCanvasView: class {}}));
jest.mock("../src/CVideoLoadingManager", () => ({VideoLoadingManager: {isLoading: () => false}}));
jest.mock("../src/CObjectTracking", () => ({getObjectTracker: jest.fn()}));
jest.mock("../src/TraverseAnalysisData", () => ({abFrameRange: jest.fn()}));
jest.mock("../src/videoQP/VideoQPAnalysis", () => ({displayIndexForFrame: (video, frame) => frame, sourceVideoOf: jest.fn()}));
jest.mock("../src/videoTonal/VideoTonalAnalysis", () => ({startTonalAnalysis: jest.fn()}));
jest.mock("file-saver", () => ({saveAs: jest.fn()}));

import {NodeMan} from "../src/Globals";
import {saveAs} from "file-saver";
import {getObjectTracker} from "../src/CObjectTracking";
import {abFrameRange} from "../src/TraverseAnalysisData";
import {sourceVideoOf} from "../src/videoQP/VideoQPAnalysis";
import {startTonalAnalysis} from "../src/videoTonal/VideoTonalAnalysis";
import {FREQUENCY_DEFAULTS, resetPointTrackFrequencyGraph} from "../src/PointTrackFrequencyGraph";
import {CNodePointTrackFrequencyGraphView} from "../src/pointFrequency/CNodePointTrackFrequencyGraphView";

const GAPS = [927, 928, 929, 930, 931, 948, 949];
let view, positions;

// The user report: a track from 522 to 957 without 927–931 and 948–949, and In/Out on its ends.
function setup() {
    clearTimeout(view?._pollTimer);
    const video = {videoWidth: 40, videoHeight: 40};
    const chunks = Array.from({length: 1798}, (_, i) => ({timestamp: Math.round(i * 1e6 / 30), type: i % 30 ? 'delta' : 'key'}));
    positions = new Map();
    for (let frame = 522; frame <= 957; frame++) if (!GAPS.includes(frame)) positions.set(frame, {x: 20, y: 20});
    view = new CNodePointTrackFrequencyGraphView({id: 'pointTrackFrequencyGraph', options: {...FREQUENCY_DEFAULTS}});
    view.visible = true;
    NodeMan.get.mockImplementation(id => ({video: {videoData: video}, pointTrackFrequencyGraph: view}[id] ?? null));
    sourceVideoOf.mockReturnValue({chunks, config: {}});
    getObjectTracker.mockReturnValue({videoView: {videoData: video}, trackedPositions: positions,
        getOutputPositions: () => positions, smoothingFrames: 0});
    abFrameRange.mockReturnValue({frame0: 522, frame1: 957});
    startTonalAnalysis.mockImplementation(() => ({cancel() {}, promise: Promise.resolve(),
        result: {complete: false, done: 0, frames: 1, version: 0}}));
}
// Each call is a poll of the view; the 250 ms limit between polls is not under test.
const poll = () => { view._pollAt = 0; view.ensureAnalysis(); };

beforeEach(() => {
    jest.clearAllMocks();
    resetPointTrackFrequencyGraph();
    setup();
});
afterEach(() => clearTimeout(view?._pollTimer));

test('a gap does not stop the analysis: its frames are measured on the track line', () => {
    poll();
    expect(view.message).toBe('');
    expect(startTonalAnalysis).toHaveBeenCalledTimes(1);
    const {targets, first, last} = startTonalAnalysis.mock.calls[0][1];
    expect([first, last]).toEqual([522, 957]);
    for (const frame of GAPS) expect(targets[frame]).toEqual({u: .5, v: .5, rx: .1, ry: .1});
    // What the warning on the graph is made from.
    expect(view._inputs.plan.untracked).toMatchObject({count: 7, total: 436, runs: 2, longest: 5, trial: 0});
    // The setting that asked for this is gone: there is nothing to turn on.
    expect(FREQUENCY_DEFAULTS).not.toHaveProperty('interpolate');
});

test('a region with no gap has no warning, and a gap that comes into the region gets one', () => {
    abFrameRange.mockReturnValue({frame0: 522, frame1: 926});
    poll();
    expect(view._inputs.plan.untracked).toBeNull();
    abFrameRange.mockReturnValue({frame0: 522, frame1: 940});
    poll();
    expect(view.message).toBe('');
    expect(view._inputs.plan.untracked).toMatchObject({count: 5, total: 419, runs: 1});
});

test('frames with no position still stop the analysis, with the reason', () => {
    // Out is after the end of the track.
    abFrameRange.mockReturnValue({frame0: 522, frame1: 960});
    poll();
    expect(view.message).toBe('pointFrequency.unpositioned {"count":3,"total":439}');
    expect(startTonalAnalysis).not.toHaveBeenCalled();
    // The object was not found on a frame of a gap: nothing joins the points on each side.
    abFrameRange.mockReturnValue({frame0: 522, frame1: 957});
    positions.unmeasuredFrames = new Set([929]);
    poll();
    expect(view.message).toBe('pointFrequency.unpositioned {"count":5,"total":436}');
});

test('the warning box closes with its ×, and comes back only when In or Out changes', () => {
    poll();
    expect(view.untrackedWarningShows(view._inputs.range)).toBe(true);
    // The canvas is at (100, 50) on the page; the × is the square that the last draw left.
    view.canvas = {getBoundingClientRect: () => ({left: 100, top: 50}), style: {}};
    view._warningClose = {x: 800, y: 69, size: 18};
    const press = (x, y, button = 0) => {
        const e = {button, clientX: 100 + x, clientY: 50 + y, stopPropagation: jest.fn(), preventDefault: jest.fn()};
        view.onMouseDown(e);
        return e;
    };
    // A press beside the ×, or with another button, is the graph window's own.
    press(780, 75); press(805, 75, 2);
    expect(view.basePresses).toBe(2);
    expect(view.untrackedWarningShows(view._inputs.range)).toBe(true);
    // A press on the × closes the box and goes no further.
    expect(press(805, 75).stopPropagation).toHaveBeenCalled();
    expect(view.basePresses).toBe(2);
    expect(view.untrackedWarningShows({frame0: 522, frame1: 957})).toBe(false);
    // A change of the track or a new measurement does not bring it back.
    positions.delete(700);
    poll();
    expect(view._inputs.plan.untracked.count).toBe(8);
    expect(view.untrackedWarningShows(view._inputs.range)).toBe(false);
    // A change of In or Out does, and it then stays, also back at the old frames.
    abFrameRange.mockReturnValue({frame0: 522, frame1: 950});
    poll();
    expect(view.untrackedWarningShows(view._inputs.range)).toBe(true);
    expect(view.untrackedWarningShows({frame0: 522, frame1: 957})).toBe(true);
});

test('the CSV marks the frames that were measured at an interpolated position', async () => {
    poll();
    const indices = view._inputs.plan.indices;
    Object.assign(view.job.result, {complete: true, flux: [], area: [], background: [], clippedFraction: [], mode: 'luma', bits: 8, masked: false});
    for (const index of indices) {
        view.job.result.flux[index] = 100 + Math.sin(index); view.job.result.area[index] = 50;
        view.job.result.background[index] = 20; view.job.result.clippedFraction[index] = 0;
    }
    view.updateSpectrum();
    expect(view.spectrum.count).toBe(436);
    await view.exportCSV();
    const rows = (await saveAs.mock.calls.at(-1)[0].text()).split('\n');
    const settings = rows.findIndex(row => row.startsWith('scene_in,'));
    expect(rows[settings + 1].split(',')[rows[settings].split(',').indexOf('interpolated_frames')]).toBe('7');
    const frames = rows.slice(rows.findIndex(row => row.startsWith('source_frame,')) + 1);
    expect(frames.length).toBe(436);
    expect(frames.filter(row => row.endsWith(',interpolated')).map(row => Number(row.split(',')[0]))).toEqual(GAPS);
    expect(frames.filter(row => row.endsWith(',tracked')).length).toBe(429);
});
