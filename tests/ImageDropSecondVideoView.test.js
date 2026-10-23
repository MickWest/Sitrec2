/** @jest-environment jsdom */
// An image dropped while a video is loaded can go to the second video view ("video2"),
// as a second dropped video can, and it stays there through a save and reload.
jest.mock("../src/showError", () => ({...jest.requireActual("../src/showError"), showChoice: jest.fn()}));

import {DragDropHandler} from "../src/DragDropHandler";
import {parseMethods} from "../src/CFileManagerParse";
import {saveMethods} from "../src/CFileManagerSave";
import {FileManager, Globals, NodeMan, setFileManager, setNodeMan, setSit, Sit} from "../src/Globals";
import {showChoice} from "../src/showError";

const viewNode = (videoData) => ({
    videoData, videos: [], pendingVideoRestore: null,
    disposeAllVideos: jest.fn(), makeImageVideo: jest.fn(), promptAddOrReplace: jest.fn(),
});

let previous, primary, secondary, nodeIds;
beforeEach(() => {
    previous = {fileManager: FileManager, nodes: NodeMan, sit: Sit, dirty: Globals.sitchDirty,
        deserializing: Globals.deserializing, reserved: DragDropHandler.reservedImportNames,
        Image: global.Image, createObjectURL: URL.createObjectURL};
    DragDropHandler.reservedImportNames = new Set();
    primary = viewNode({});
    secondary = viewNode(null);
    nodeIds = ["video", "video2"];
    setNodeMan({exists: id => nodeIds.includes(id), get: id => ({video: primary, video2: secondary})[id]});
    setFileManager({exists: () => false, list: {}});
    setSit({});
    // jsdom does not decode images: load every one at once, at a fixed size.
    global.Image = class { width = 4; height = 3; set src(value) { queueMicrotask(() => this.onload()); } };
    URL.createObjectURL = jest.fn(() => "blob:image-test");
    showChoice.mockReset();
    jest.spyOn(DragDropHandler, "revealSecondVideoView").mockImplementation(() => {});
});
afterEach(() => {
    setFileManager(previous.fileManager);
    setNodeMan(previous.nodes);
    setSit(previous.sit);
    Globals.sitchDirty = previous.dirty;
    Globals.deserializing = previous.deserializing;
    DragDropHandler.reservedImportNames = previous.reserved;
    global.Image = previous.Image;
    URL.createObjectURL = previous.createObjectURL;
    jest.restoreAllMocks();
});

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47];
const image = () => {
    const file = new File([new Uint8Array(PNG_BYTES)], "frame.png", {type: "image/png"});
    // The jsdom File here has no arrayBuffer().
    file.arrayBuffer = async () => new Uint8Array(PNG_BYTES).buffer;
    return file;
};

// The first dialog is Import Image; answer it, then the question about where the image goes.
async function drop(useAs, where) {
    showChoice.mockResolvedValueOnce(useAs).mockResolvedValueOnce(where);
    await DragDropHandler.importDroppedFile(image());
}

describe("an image dropped while a video is loaded", () => {
    test("is offered the second video view, and choosing it shows the image there", async () => {
        await drop("video", "secondView");

        expect(showChoice.mock.calls.map(call => call[1].title)).toEqual(["Import Image", "Second Video"]);
        const offered = showChoice.mock.calls[1][1].options.map(option => option.value);
        expect(offered).toEqual(["secondView", "add", "replace", null]);
        expect(showChoice.mock.calls[1][0]).toContain("frame.png");

        expect(secondary.makeImageVideo).toHaveBeenCalledTimes(1);
        expect(secondary.makeImageVideo.mock.calls[0][0]).toBe("frame.png");
        expect(secondary.makeImageVideo.mock.calls[0][3]).toBe("frame.png");
        expect(secondary.imageFileID).toBe("frame.png");
        expect(DragDropHandler.revealSecondVideoView).toHaveBeenCalledTimes(1);
        expect(primary.makeImageVideo).not.toHaveBeenCalled();
        expect(primary.disposeAllVideos).not.toHaveBeenCalled();
        expect(primary.promptAddOrReplace).not.toHaveBeenCalled();
        // Registered for saving like an image in the main view.
        expect(FileManager.list["frame.png"]).toMatchObject({dataType: "videoImage", dynamicLink: true, handled: true});
        expect(Globals.sitchDirty).toBe(true);
    });

    test("asks add or replace for the second view when it already holds media", async () => {
        secondary.videoData = {};
        secondary.promptAddOrReplace.mockResolvedValue("replace");
        await drop("video", "secondView");
        expect(secondary.disposeAllVideos).toHaveBeenCalledTimes(1);
        expect(secondary.disposeAllVideos.mock.invocationCallOrder[0])
            .toBeLessThan(secondary.makeImageVideo.mock.invocationCallOrder[0]);

        showChoice.mockReset();
        secondary.makeImageVideo.mockClear();
        secondary.promptAddOrReplace.mockResolvedValue("cancel");
        await drop("video", "secondView");
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
    });

    test.each(["add", "replace", null])("the %s choice still goes to the main video view", async where => {
        await drop("video", where);
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
        expect(DragDropHandler.revealSecondVideoView).not.toHaveBeenCalled();
        if (where === null) {
            expect(primary.makeImageVideo).not.toHaveBeenCalled();
            expect(primary.disposeAllVideos).not.toHaveBeenCalled();
            return;
        }
        expect(primary.makeImageVideo).toHaveBeenCalledTimes(1);
        expect(primary.makeImageVideo.mock.calls[0][0]).toBe("frame.png");
        if (where === "add") expect(primary.disposeAllVideos).not.toHaveBeenCalled();
        if (where === "replace") {
            expect(primary.disposeAllVideos).toHaveBeenCalledTimes(1);
            expect(primary.disposeAllVideos.mock.invocationCallOrder[0])
                .toBeLessThan(primary.makeImageVideo.mock.invocationCallOrder[0]);
        }
    });
});

describe("other image drops are unchanged", () => {
    test("with no video loaded, the image goes straight into the main view", async () => {
        primary.videoData = null;
        showChoice.mockResolvedValueOnce("video");
        await DragDropHandler.importDroppedFile(image());
        expect(showChoice).toHaveBeenCalledTimes(1);
        expect(primary.makeImageVideo).toHaveBeenCalledTimes(1);
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
        expect(DragDropHandler.revealSecondVideoView).not.toHaveBeenCalled();
    });

    test("without a second video view, the Media Already Loaded question is asked", async () => {
        nodeIds = ["video"];
        primary.promptAddOrReplace.mockResolvedValue("add");
        showChoice.mockResolvedValueOnce("video");
        await DragDropHandler.importDroppedFile(image());
        expect(showChoice).toHaveBeenCalledTimes(1);
        expect(primary.promptAddOrReplace).toHaveBeenCalledTimes(1);
        expect(primary.makeImageVideo).toHaveBeenCalledTimes(1);
    });

    test("a ground overlay is not offered the second view", async () => {
        const overlay = jest.spyOn(DragDropHandler, "createGroundOverlayFromImage").mockResolvedValue();
        showChoice.mockResolvedValueOnce("overlay");
        await DragDropHandler.importDroppedFile(image());
        expect(showChoice).toHaveBeenCalledTimes(1);
        expect(overlay).toHaveBeenCalledTimes(1);
        expect(primary.makeImageVideo).not.toHaveBeenCalled();
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
    });

    test("a view that always replaces still replaces without a question", async () => {
        primary.alwaysReplace = true;
        await DragDropHandler.importDroppedFile(image());
        expect(showChoice).not.toHaveBeenCalled();
        expect(primary.disposeAllVideos).toHaveBeenCalledTimes(1);
        expect(primary.makeImageVideo).toHaveBeenCalledTimes(1);
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
    });
});

describe("saving and reloading an image in the second view", () => {
    const savedEntry = {fileName: "frame.png", isImage: true, imageFileID: "frame.png"};

    // The reload hands each saved file to handleParsedFile, with its saved dataType.
    async function reloadImage() {
        const fm = {...parseMethods, list: {"frame.png": {dataType: "videoImage", original: new ArrayBuffer(4), filename: "frame.png"}}};
        Globals.deserializing = true;
        expect(await fm.handleParsedFile("frame.png", {})).toBe(false);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    test("a reloaded image listed in videos2 is restored into the second view", async () => {
        setSit({videos2: [savedEntry]});
        await reloadImage();
        expect(secondary.makeImageVideo).toHaveBeenCalledTimes(1);
        expect(secondary.makeImageVideo.mock.calls[0][0]).toBe("frame.png");
        expect(primary.makeImageVideo).not.toHaveBeenCalled();
    });

    test("it is left to the second view's own restore while that is under way", async () => {
        setSit({videos2: [savedEntry]});
        secondary.pendingVideoRestore = {videos: [savedEntry]};
        await reloadImage();
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
        expect(primary.makeImageVideo).not.toHaveBeenCalled();
    });

    test("an image not in videos2 is still restored into the main view", async () => {
        setSit({videos2: [{fileName: "other.png", isImage: true, imageFileID: "other.png"}]});
        await reloadImage();
        expect(primary.makeImageVideo).toHaveBeenCalledTimes(1);
        expect(secondary.makeImageVideo).not.toHaveBeenCalled();
    });

    test("an uploaded save gives the second view's entry the hosted URL", async () => {
        secondary.videos = [{...savedEntry}];
        secondary.imageFileID = "frame.png";
        const fm = {...saveMethods,
            list: {"frame.png": {filename: "frame.png", original: new ArrayBuffer(4), dynamicLink: true, dataType: "videoImage"}},
            rehoster: {rehostFile: jest.fn(async () => "https://objects.example/frame.png")}};
        await fm.rehostDynamicLinks(false);
        expect(secondary.videos[0].staticURL).toBe("https://objects.example/frame.png");
        expect(secondary.staticURL).toBe("https://objects.example/frame.png");
        expect(primary.staticURL).toBeUndefined();
    });

    test("a local save gives the second view's entry the local file path", async () => {
        secondary.videos = [{...savedEntry}];
        const fm = {...saveMethods,
            list: {"frame.png": {filename: "frame.png", original: new ArrayBuffer(4), dynamicLink: true, dataType: "videoImage"}},
            chooseLocalRehostPath: jest.fn(async path => ({path, reusedExisting: true}))};
        await fm.rehostDynamicLinksLocal({}, false);
        expect(secondary.videos[0].localStaticURL).toBe("local/media/frame.png");
    });
});
