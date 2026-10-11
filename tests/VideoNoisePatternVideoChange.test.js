jest.mock("../src/nodes/CNodeViewText", () => ({CNodeViewText: class {
    renderCanvas() {}
    show(visible) { this.visible = visible; }
}}));
jest.mock("../src/Globals", () => ({NodeMan: {get: jest.fn()}, setRenderOne: jest.fn(), Sit: {frames: 100}}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/CVideoLoadingManager", () => ({VideoLoadingManager: {isLoading: jest.fn()}}));
jest.mock("../src/TimelineMenu", () => ({goToTimelineFrame: jest.fn()}));
jest.mock("../src/showError", () => ({showChoice: jest.fn()}));
jest.mock("../src/VideoNoisePattern", () => ({clampNoisePatternOptions: jest.fn(), setVideoNoisePatternTeardown: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternJob", () => ({
    estimateFeatureBytes: jest.fn(() => 100), NOISE_PATTERN_CACHE_LIMIT: 1000,
    startNoisePatternJob: jest.fn(), terminateNoisePatternWorkers: jest.fn(),
}));
jest.mock("../src/videoNoisePattern/NoisePatternCharts", () => ({}));

import {NodeMan} from "../src/Globals";
import {VideoLoadingManager} from "../src/CVideoLoadingManager";
import {showChoice} from "../src/showError";
import {CNodeVideoNoisePatternView} from "../src/videoNoisePattern/CNodeVideoNoisePatternView";
import {estimateFeatureBytes, startNoisePatternJob} from "../src/videoNoisePattern/NoisePatternJob";

const video = () => ({chunks: [{}], config: {codedWidth: 1280}, groups: [{}]});
let view, videoView, jobs;

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    estimateFeatureBytes.mockReturnValue(100);
    VideoLoadingManager.isLoading.mockReturnValue(false);
    videoView = {videoData: video()};
    NodeMan.get.mockImplementation(id => id === "video" ? videoView : null);
    jobs = [];
    startNoisePatternJob.mockImplementation((videoData, options, hooks) => {
        let finish;
        const result = {status: "running", complete: false};
        const promise = new Promise(resolve => { finish = () => {
            Object.assign(result, {status: "done", complete: true});
            resolve(result);
        }; });
        const job = {videoData, result, promise, finish, cancel: jest.fn(() => hooks.onUpdate())};
        jobs.push(job);
        return job;
    });
    view = Object.assign(Object.create(CNodeVideoNoisePatternView.prototype), {
        visible: true, detailsEl: {}, outputArea: {clientWidth: 400}, lastWidth: 400,
        options: {longestLag: 256, detail: 8, frames: "all"}, ui: {}, job: null,
        refreshDisplay: jest.fn(), exposeDebug: jest.fn(), applySavedSelection: jest.fn(),
        drawWhere: jest.fn(), drawOverlay: jest.fn(), clearOverlay: jest.fn(),
    });
});

afterEach(() => {
    view.release();
    jest.useRealTimers();
});

test("replacing a video reruns a visible completed analysis once with the current settings", async () => {
    await view.run();
    jobs[0].finish();
    await jobs[0].promise;
    view.savedSelection = {source: 10, target: 42};
    view.pairImages = {};
    videoView.videoData = video();
    view.options.longestLag = 512;

    view.renderCanvas(0);
    view.renderCanvas(1);

    expect(startNoisePatternJob).toHaveBeenCalledTimes(2);
    expect(jobs[1].videoData).toBe(videoView.videoData);
    expect(startNoisePatternJob.mock.calls[1][1].longestLag).toBe(512);
    expect(view.savedSelection).toBeNull();
    expect(view.pairImages).toBeNull();
    expect(jobs[0].cancel).not.toHaveBeenCalled();
});

test("replacement cancels an unfinished analysis and ignores its later completion", async () => {
    await view.run();
    const oldJob = jobs[0];
    videoView.videoData = video();
    view.renderCanvas(0);

    expect(oldJob.cancel).toHaveBeenCalledTimes(1);
    expect(view.job).toBe(jobs[1]);
    oldJob.finish();
    await oldJob.promise;
    expect(view.applySavedSelection).not.toHaveBeenCalled();
    expect(view.job).toBe(jobs[1]);
});

test("replacement clears old results while loading and starts when the video is ready", async () => {
    await view.run();
    videoView.videoData = {...video(), _loadingId: "replacement"};
    VideoLoadingManager.isLoading.mockReturnValue(true);
    view.renderCanvas(0);

    expect(view.job).toBeNull();
    expect(view.statusKey).toBe("loading");
    expect(startNoisePatternJob).toHaveBeenCalledTimes(1);
    VideoLoadingManager.isLoading.mockReturnValue(false);
    jest.advanceTimersByTime(500);
    expect(startNoisePatternJob).toHaveBeenCalledTimes(2);
    expect(view.job.videoData).toBe(videoView.videoData);
});

test("a hidden window waits until reopened to analyze the replacement", async () => {
    await view.run();
    view.show(false);
    videoView.videoData = video();
    view.renderCanvas(0);
    expect(startNoisePatternJob).toHaveBeenCalledTimes(1);
    view.show(true);
    expect(startNoisePatternJob).toHaveBeenCalledTimes(2);
    expect(view.job.videoData).toBe(videoView.videoData);
});

test("the initial video keeps the pair restored from the saved sitch", async () => {
    view.savedSelection = {source: 10, target: 42};
    await view.run();
    expect(view.savedSelection).toEqual({source: 10, target: 42});
});

test("a memory prompt for the old video cannot start an analysis after replacement", async () => {
    estimateFeatureBytes.mockReturnValueOnce(2000);
    let choose;
    showChoice.mockReturnValueOnce(new Promise(resolve => { choose = resolve; }));
    const oldRun = view.run();
    videoView.videoData = video();
    view.renderCanvas(0);
    choose("all");
    await oldRun;

    expect(startNoisePatternJob).toHaveBeenCalledTimes(1);
    expect(view.job.videoData).toBe(videoView.videoData);
});
