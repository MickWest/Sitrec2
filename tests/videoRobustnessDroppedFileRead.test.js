import {CVideoMp4Data} from "../src/CVideoMp4Data";
import {showError} from "../src/showError";

const mockSources = [];
jest.mock("../src/Globals", () => ({FileManager: {}, Sit: {}, Globals: {settings: {}}, infoDiv: {}, setRenderOne: jest.fn()}));
jest.mock("../src/js/mp4-decode/mp4_demuxer", () => ({
    MP4Source: class { constructor() { this.file = {appendBuffer: jest.fn(), flush: jest.fn()}; mockSources.push(this); } },
    MP4Demuxer: class { getConfig() { return new Promise(() => {}); } },
}));
jest.mock("../src/CVideoAndAudio", () => ({CVideoAndAudio: class { constructor() { this._pendingPromises = []; } dispose() {} }}));
jest.mock("../src/utils", () => ({}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/configUtils", () => ({}));
jest.mock("../src/showError", () => ({showError: jest.fn(), showErrorOnce: jest.fn()}));
jest.mock("../src/CVideoDecodeWorker", () => ({VideoDecodeWorkerManager: class {}}));
jest.mock("../src/UpdateSitFrames", () => ({}));
jest.mock("../src/CEventManager", () => ({EventManager: {}}));
jest.mock("../src/CVideoLoadingManager", () => ({VideoLoadingManager: {setStatus: jest.fn()}}));
jest.mock("../src/H264Utils", () => ({}));

// A FileReader that finishes on the next timer tick with the given outcome
function readerReturning(outcome) {
    return class {
        readAsArrayBuffer() {
            setTimeout(() => { Object.assign(this, {result: null, error: null}, outcome); this.onloadend(); }, 0);
        }
    };
}

const saved = {};
beforeEach(() => {
    Object.assign(saved, {FileReader: global.FileReader, VideoDecoder: global.VideoDecoder});
    global.VideoDecoder = class {};
    showError.mockClear();
    jest.useFakeTimers();
});
afterEach(() => {
    jest.useRealTimers();
    Object.assign(global, saved);
});

test("an unreadable dropped file reports the read error at once, not a parser timeout two minutes later", () => {
    const error = new DOMException("The requested file could not be read", "NotReadableError");
    global.FileReader = readerReturning({error});
    const errorCallback = jest.fn();
    const video = new CVideoMp4Data({id: "video", dropFile: {name: "drone.mp4"}}, jest.fn(), errorCallback);
    jest.advanceTimersByTime(0);
    expect(errorCallback).toHaveBeenCalledWith(error);
    expect(showError).toHaveBeenCalledWith(expect.stringMatching(/drone\.mp4.*could not be read/));
    expect(video._getConfigTimer).toBeNull();
    jest.advanceTimersByTime(120000);
    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
});

test("a read that fails after the video was disposed shows nothing", () => {
    global.FileReader = readerReturning({error: new DOMException("The requested file could not be read", "NotReadableError")});
    const video = new CVideoMp4Data({id: "video", dropFile: {name: "drone.mp4"}}, jest.fn(), jest.fn());
    video.dispose();
    jest.advanceTimersByTime(120000);
    expect(showError).not.toHaveBeenCalled();
});

test("a readable dropped file still goes to the demuxer", () => {
    const buffer = new Uint8Array([0, 0, 0, 24, ..."ftypisom".split("").map(c => c.charCodeAt(0)), 0, 0, 0, 0]).buffer;
    global.FileReader = readerReturning({result: buffer});
    const errorCallback = jest.fn();
    new CVideoMp4Data({id: "video", dropFile: {name: "clip.mp4"}}, jest.fn(), errorCallback);
    jest.advanceTimersByTime(0);
    expect(mockSources.at(-1).file.appendBuffer).toHaveBeenCalledWith(buffer);
    expect(errorCallback).not.toHaveBeenCalled();
});
