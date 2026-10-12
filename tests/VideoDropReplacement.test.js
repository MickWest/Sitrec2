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

test("debug repeated drop replaces the primary video without either video import prompt", async () => {
    window._mcpDebug = true;
    FileManager.exists = () => true;
    const file = video();
    await DragDropHandler.uploadDroppedFile(file);
    expect(showChoice).not.toHaveBeenCalled();
    expect(primary.disposeAllVideos).toHaveBeenCalledTimes(1);
    expect(primary.uploadFile).toHaveBeenCalledWith(file);
    expect(primary.disposeAllVideos.mock.invocationCallOrder[0]).toBeLessThan(primary.uploadFile.mock.invocationCallOrder[0]);
    expect(secondary.uploadFile).not.toHaveBeenCalled();
    expect(Globals.sitchDirty).toBe(true);
});

test("debug first video loads without disposing and audio retains its existing route", async () => {
    window._mcpDebug = true;
    primary.videoData = null;
    await DragDropHandler.importDroppedFile(video());
    primary.videoData = {};
    const audio = new File([new Uint8Array([0])], "sound.wav", {type: "audio/wav"});
    await DragDropHandler.importDroppedFile(audio);
    expect(primary.disposeAllVideos).not.toHaveBeenCalled();
    expect(primary.uploadFile).toHaveBeenLastCalledWith(audio);
    expect(showChoice).not.toHaveBeenCalled();
});

test.each(["add", "replace", null])("interactive second-video choice remains %s", async choice => {
    window._mcpDebug = false;
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

test.each([false, true])("filename collisions outside debug primary-video imports remain interactive (debug=%s)", async debug => {
    window._mcpDebug = debug;
    FileManager.exists = () => true;
    showChoice.mockResolvedValue(null);
    const files = debug
        ? [new File(["data"], "track.csv", {type: "text/csv"}), new File(["data"], "track.ts", {type: "video/mp2t"})]
        : [video()];
    for (const file of files) expect(await DragDropHandler.resolveNameCollision(file)).toBeNull();
    expect(showChoice).toHaveBeenCalledTimes(files.length);
});

test("debug mode does not suppress the unrelated image-use choice", async () => {
    window._mcpDebug = true;
    showChoice.mockResolvedValue("overlay");
    expect(await DragDropHandler.showImageChoiceDialog("map.png")).toBe("overlay");
    expect(showChoice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({title: "Import Image"}));
});
