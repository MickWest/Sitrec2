import fs from "fs";
import path from "path";
import {parse} from "@babel/parser";

// Exercise the real restore methods without loading the video decoder's
// import.meta worker graph into Jest's CommonJS runtime.
const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNodeVideoView.js"), "utf8");
const declaration = parse(source, {sourceType: "module"}).program.body
    .map(node => node.declaration).find(node => node?.id?.name === "CNodeVideoView");
const methods = declaration.body.body.filter(node => ["isValidVideoURL", "loadVideoFromEntry"].includes(node.key?.name))
    .map(node => source.slice(node.start, node.end)).join("\n");

function fixture() {
    const FileManager = {list: {}, directoryHandle: null, isLikelyImportedLocalAssetPath: () => false};
    const resolveURLForFetch = jest.fn(async value => value);
    const View = new Function("resolveURLForFetch", "Sit", "Globals", "require", `return class {${methods}}`)
        (resolveURLForFetch, {}, {}, () => ({FileManager}));
    const view = Object.assign(new View(), {videos: [], newVideo: jest.fn(), skipCurrentVideoRestore: jest.fn()});
    return {view, FileManager, resolveURLForFetch};
}

test.each(["/sitrec-videos/public/clip.mp4", "https://www.metabunk.org/sitrec-videos/public/clip.mp4"])
    ("saved video restores from %s without a local folder", async url => {
        const {view} = fixture();
        await view.loadVideoFromEntry({fileName: url, staticURL: url}, 2);
        expect(view.newVideo).toHaveBeenCalledWith(url, false, url, 2);
        expect(view.skipCurrentVideoRestore).not.toHaveBeenCalled();
    });

test("resolved preview path preserves the saved canonical video reference", async () => {
    const {view, resolveURLForFetch} = fixture();
    const ref = "sitrec://1234/video.mp4";
    resolveURLForFetch.mockResolvedValue("/__preview-assets/1234/video.mp4?signature=test");
    await view.loadVideoFromEntry({fileName: "video.mp4", staticURL: ref}, 0);
    expect(view.newVideo).toHaveBeenCalledWith("/__preview-assets/1234/video.mp4?signature=test", false, ref, 0);
    expect(view.skipCurrentVideoRestore).not.toHaveBeenCalled();
});

test("relative imported file paths still require the local working folder", () => {
    const {view, FileManager} = fixture();
    expect(view.isValidVideoURL("local/media/clip.mp4")).toBe(false);
    expect(view.isValidVideoURL("//unselected.example/clip.mp4")).toBe(false);
    expect(view.isValidVideoURL("file:///tmp/clip.mp4")).toBe(false);
    FileManager.directoryHandle = {};
    expect(view.isValidVideoURL("local/media/clip.mp4")).toBe(true);
});
