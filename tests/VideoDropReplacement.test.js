/** @jest-environment jsdom */
jest.mock("../src/showError", () => ({...jest.requireActual("../src/showError"), showChoice: jest.fn()}));

import {DragDropHandler} from "../src/DragDropHandler";
import {FileManager, Globals, NodeMan, setFileManager, setNodeMan} from "../src/Globals";
import {showChoice} from "../src/showError";

let previous, primary, secondary;
beforeEach(() => {
    previous = {fileManager: FileManager, nodes: NodeMan, debug: window._mcpDebug,
        reserved: DragDropHandler.reservedImportNames, dirty: Globals.sitchDirty};
    DragDropHandler.reservedImportNames = new Set();
    primary = {videoData: {}, disposeAllVideos: jest.fn(), uploadFile: jest.fn()};
    secondary = {uploadFile: jest.fn()};
    setNodeMan({exists: id => ["video", "video2"].includes(id), get: id => id === "video" ? primary : secondary});
    setFileManager({exists: () => false});
    showChoice.mockReset();
    delete window._mcpDebug;
});
afterEach(() => {
    setFileManager(previous.fileManager);
    setNodeMan(previous.nodes);
    if (previous.debug === undefined) delete window._mcpDebug;
    else window._mcpDebug = previous.debug;
    DragDropHandler.reservedImportNames = previous.reserved;
    Globals.sitchDirty = previous.dirty;
    jest.restoreAllMocks();
});

const video = () => new File([new Uint8Array([0])], "clip.mp4", {type: "video/mp4"});

test("a repeated replaceVideo import replaces the primary video without either video import prompt", async () => {
    FileManager.exists = () => true;
    const file = video();
    await DragDropHandler.uploadDroppedFile(file, {}, {replaceVideo: true});
    expect(showChoice).not.toHaveBeenCalled();
    expect(primary.disposeAllVideos).toHaveBeenCalledTimes(1);
    expect(primary.uploadFile).toHaveBeenCalledWith(file);
    expect(primary.disposeAllVideos.mock.invocationCallOrder[0]).toBeLessThan(primary.uploadFile.mock.invocationCallOrder[0]);
    expect(secondary.uploadFile).not.toHaveBeenCalled();
    expect(Globals.sitchDirty).toBe(true);
});

test("a drop by hand asks both questions, also in a tab with the bridge attached", async () => {
    // The bridge sets _mcpDebug in every tab it attaches to, so it does not mean a script
    // is importing. A drop by hand must never replace the user's videos without asking.
    window._mcpDebug = true;
    FileManager.exists = () => true;
    showChoice.mockResolvedValueOnce("replace").mockResolvedValueOnce(null);
    await DragDropHandler.uploadDroppedFile(video());
    expect(showChoice.mock.calls.map(call => call[1].title)).toEqual(["Name Already Used", "Second Video"]);
    expect(primary.disposeAllVideos).not.toHaveBeenCalled();
    expect(primary.uploadFile).not.toHaveBeenCalled();
});

test("replaceVideo: the first video loads without disposing and audio retains its existing route", async () => {
    primary.videoData = null;
    await DragDropHandler.importDroppedFile(video(), {replaceVideo: true});
    primary.videoData = {};
    const audio = new File([new Uint8Array([0])], "sound.wav", {type: "audio/wav"});
    await DragDropHandler.importDroppedFile(audio, {replaceVideo: true});
    expect(primary.disposeAllVideos).not.toHaveBeenCalled();
    expect(primary.uploadFile).toHaveBeenLastCalledWith(audio);
    expect(showChoice).not.toHaveBeenCalled();
});

test.each(["add", "replace", null])("interactive second-video choice remains %s", async choice => {
    showChoice.mockResolvedValue(choice);
    const file = video();
    await DragDropHandler.importDroppedFile(file);
    expect(showChoice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({title: "Second Video"}));
    if (choice === "add") expect(primary.uploadFile).toHaveBeenCalledWith(file, true);
    if (choice === "replace") {
        expect(primary.disposeAllVideos).toHaveBeenCalledTimes(1);
        expect(primary.uploadFile).toHaveBeenCalledWith(file);
    }
    if (choice === null) expect(primary.uploadFile).not.toHaveBeenCalled();
});

test("interactive side-by-side import still uses the second view", async () => {
    showChoice.mockResolvedValue("secondView");
    jest.spyOn(DragDropHandler, "revealSecondVideoView").mockImplementation(() => {});
    const file = video();
    await DragDropHandler.importDroppedFile(file);
    expect(secondary.uploadFile).toHaveBeenCalledWith(file);
    expect(primary.uploadFile).not.toHaveBeenCalled();
    expect(primary.disposeAllVideos).not.toHaveBeenCalled();
});

test("interactive Extra Video View import uses the second view as an inset", async () => {
    showChoice.mockResolvedValue("extraView");
    jest.spyOn(DragDropHandler, "revealExtraVideoView").mockImplementation(() => {});
    jest.spyOn(DragDropHandler, "revealSecondVideoView").mockImplementation(() => {});
    const file = video();
    await DragDropHandler.importDroppedFile(file);
    expect(secondary.uploadFile).toHaveBeenCalledWith(file);
    expect(DragDropHandler.revealExtraVideoView).toHaveBeenCalledTimes(1);
    expect(DragDropHandler.revealSecondVideoView).not.toHaveBeenCalled();
    expect(primary.uploadFile).not.toHaveBeenCalled();
});

test.each([false, true])("filename collisions outside replaceVideo video imports remain interactive (replaceVideo=%s)", async replaceVideo => {
    FileManager.exists = () => true;
    showChoice.mockResolvedValue(null);
    const files = replaceVideo
        ? [new File(["data"], "track.csv", {type: "text/csv"}), new File(["data"], "track.ts", {type: "video/mp2t"})]
        : [video()];
    for (const file of files) expect(await DragDropHandler.resolveNameCollision(file, {replaceVideo})).toBeNull();
    expect(showChoice).toHaveBeenCalledTimes(files.length);
});

test("replaceVideo does not suppress the unrelated image-use choice", async () => {
    showChoice.mockResolvedValue(null);
    await DragDropHandler.importDroppedFile(new File([new Uint8Array([0])], "map.png", {type: "image/png"}), {replaceVideo: true});
    expect(showChoice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({title: "Import Image"}));
    expect(primary.uploadFile).not.toHaveBeenCalled();
});
