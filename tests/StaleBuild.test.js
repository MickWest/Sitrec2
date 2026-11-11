import {classifyServerBuild, ownChunkGlobal, readChunkManifest, unsavedLocalFiles} from "../src/StaleBuildModel";

const {chunkNames} = require("../scripts/channelBuild");

describe("What the server says about the build that a page runs", () => {
    const running = "shipped-20261111000000000-aaaaaaaaaaaa";

    test("the same build is still there: the load failed for another reason", () => {
        expect(classifyServerBuild(running, {status: 200, build: {id: running}})).toBe("same");
    });

    test("another build is in its place", () => {
        expect(classifyServerBuild(running, {status: 200, build: {id: "shipped-20261112000000000-bbbbbbbbbbbb"}})).toBe("replaced");
    });

    test("the files of the build are not on the server", () => {
        expect(classifyServerBuild(running, {status: 404})).toBe("gone");
        expect(classifyServerBuild(running, {status: 410})).toBe("gone");
    });

    test("no answer, a server error, or an answer that is not a build record is not a new build", () => {
        expect(classifyServerBuild(running, {status: 0})).toBe("unknown");
        expect(classifyServerBuild(running, {status: 503})).toBe("unknown");
        expect(classifyServerBuild(running, {status: 200, build: null})).toBe("unknown");       // a page in place of the file
        expect(classifyServerBuild(running, {status: 200, build: {id: 7}})).toBe("unknown");
        expect(classifyServerBuild(running)).toBe("unknown");
        expect(classifyServerBuild(null, {status: 200, build: {id: running}})).toBe("unknown");
    });
});

describe("The list of chunk files of a build", () => {
    const good = {build: {id: "shipped-20261112000000000-bbbbbbbbbbbb"},
        chunkLoadingGlobal: "webpackChunksitrec_shipped_20261112000000000_bbbbbbbbbbbb",
        chunks: {"vehicle-browser": "vehicle-browser.0123456789abcdef0123.bundle.js", 771: "771.aaaabbbbccccddddeeee.bundle.js",
            "_b520": "_b520.7e46bd4966d0c9e317a4.bundle.js",
            "vendors-Dropbox_sitrec-dev_sitrec_node_modules_three_examples_jsm_controls_OrbitControls_js":
                "vendors-Dropbox_sitrec-dev_sitrec_node_modules_three_examples_jsm_controls_OrbitControls_js.0d874e56b3647d8d46b2.bundle.js"},
        styles: {"refraction-tool": "refraction-tool.d392446e.css"}};

    test("a good list comes back clean", () => {
        expect(readChunkManifest(good)).toEqual({buildID: good.build.id, chunkLoadingGlobal: good.chunkLoadingGlobal,
            chunks: good.chunks, styles: good.styles});
        expect(readChunkManifest({...good, styles: undefined}).styles).toEqual({});
    });

    test.each([
        ["a path", "../other/evil.js"],
        ["a hidden file", ".hidden.js"],
        ["a folder", "builds/x/chunk.js"],
        ["another site", "https://example.com/chunk.js"],
        ["a protocol-relative address", "//example.com/chunk.js"],
        ["a query", "chunk.js?x=1"],
        ["a file that is not a script", "chunk.json"],
        ["a number", 5],
    ])("a file name that is %s makes the whole list not valid", (_, file) => {
        expect(readChunkManifest({...good, chunks: {...good.chunks, bad: file}})).toBeNull();
    });

    test("a list with no chunks, with a bad global name, or of the wrong type is not valid", () => {
        expect(readChunkManifest({...good, chunks: {}})).toBeNull();
        expect(readChunkManifest({...good, chunkLoadingGlobal: "alert(1)"})).toBeNull();
        expect(readChunkManifest({...good, chunkLoadingGlobal: undefined})).toBeNull();
        expect(readChunkManifest({...good, styles: {a: "a.js"}})).toBeNull();
        expect(readChunkManifest(null)).toBeNull();
        expect(readChunkManifest("text")).toBeNull();
        expect(readChunkManifest([good])).toBeNull();
    });

    test("the build writes the list from its chunks, and the page reads it", () => {
        const compilation = {
            outputOptions: {chunkLoadingGlobal: good.chunkLoadingGlobal},
            chunks: new Set([
                {id: "index", files: new Set(["index.11112222333344445555.bundle.js", "index.11112222333344445555.bundle.js.map"])},
                {id: "vehicle-browser", files: new Set(["vehicle-browser.0123456789abcdef0123.bundle.js"])},
                {id: "refraction-tool", files: new Set(["refraction-tool.99998888777766665555.bundle.js", "refraction-tool.d392446e.css"])},
                {id: null, files: new Set(["orphan.js"])},
            ]),
        };
        const written = JSON.parse(JSON.stringify(chunkNames(compilation, good.build)));
        expect(written.chunks).toEqual({index: "index.11112222333344445555.bundle.js",
            "vehicle-browser": "vehicle-browser.0123456789abcdef0123.bundle.js",
            "refraction-tool": "refraction-tool.99998888777766665555.bundle.js"});
        expect(written.styles).toEqual({"refraction-tool": "refraction-tool.d392446e.css"});
        expect(readChunkManifest(written)).toEqual({buildID: good.build.id, chunkLoadingGlobal: good.chunkLoadingGlobal,
            chunks: written.chunks, styles: written.styles});
    });
});

describe("The chunk list of the running page", () => {
    test("its name has the build id, with _ for each character that a name cannot have", () => {
        const keys = ["webpackChunksitrec_shipped_20261111000000000_aaaaaaaaaaaa", "webpackChunksitrec_shipped_20261112000000000_bbbbbbbbbbbb", "dataLayer"];
        expect(ownChunkGlobal(keys, "shipped-20261111000000000-aaaaaaaaaaaa")).toBe(keys[0]);
        expect(ownChunkGlobal(keys, "shipped-20261112000000000-bbbbbbbbbbbb")).toBe(keys[1]);
    });

    test("with no build id, one candidate is the answer and two are not", () => {
        expect(ownChunkGlobal(["webpackChunkother", "x"], null)).toBe("webpackChunkother");
        expect(ownChunkGlobal(["webpackChunka", "webpackChunkb"], null)).toBeNull();
        expect(ownChunkGlobal(["x"], "shipped-1-a")).toBeNull();
    });
});

describe("Files that are only in the memory of the page", () => {
    const files = [
        {name: "flight.kml", dynamicLink: true},                                            // dropped, never saved
        {name: "saved.csv", dynamicLink: true, staticURL: "https://example.com/u/saved.csv"},
        {name: "in-folder.csv", dynamicLink: true, localStaticURL: "local/in-folder.csv"},
        {name: "bundled.glb", dynamicLink: false},
        {name: "unused-bake.glb", dynamicLink: true, skipSerialization: true},
    ];
    const videos = [
        {name: "clip.mp4"},
        {name: "hosted.mp4", staticURL: "https://example.com/u/hosted.mp4"},
        {name: "folder.mp4", localStaticURL: "local/folder.mp4"},
    ];

    test("a server sitch file can name only what is on the server", () => {
        expect(unsavedLocalFiles({files, videos})).toEqual(["flight.kml", "in-folder.csv", "clip.mp4", "folder.mp4"]);
    });

    test("a working-folder sitch file names files in the folder, and videos there or on the server", () => {
        expect(unsavedLocalFiles({files, videos, local: true})).toEqual(["flight.kml", "saved.csv", "clip.mp4"]);
    });

    test("no files, or all saved, gives an empty list, and a name is listed once", () => {
        expect(unsavedLocalFiles()).toEqual([]);
        expect(unsavedLocalFiles({files: [files[1], files[3]], videos: [videos[1]]})).toEqual([]);
        expect(unsavedLocalFiles({files: [files[0], files[0]], videos: [{name: "flight.kml"}]})).toEqual(["flight.kml"]);
    });
});
