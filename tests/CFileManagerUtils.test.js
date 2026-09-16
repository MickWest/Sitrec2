import {walkDirectoryForFiles} from "../src/CFileManagerUtils";
import {CACHE_BLOB_DIR} from "../src/analysis/BotBenchCacheIndex";

function file(name) {
    return {name, kind: "file", getFile: jest.fn()};
}

function directory(name, children) {
    return {
        name,
        kind: "directory",
        entries: jest.fn(async function* () {
            for (const child of children) yield [child.name, child];
        }),
    };
}

test("directory filtering skips cache contents without opening the cache folder", async () => {
    const cache = directory(CACHE_BLOB_DIR, [file("cached-fit.json"), file("misleading-track.csv")]);
    const batch = directory("batch", [file("nested.all.csv"), cache]);
    const root = directory("results", [file("root.all.csv"), batch]);

    const entries = await walkDirectoryForFiles(root, {
        accept: (name) => name.endsWith(".csv"),
        recursive: true,
        skipDirectory: (name) => name === CACHE_BLOB_DIR,
    });

    expect(entries.map(entry => entry.relativePath)).toEqual(["root.all.csv", "batch/nested.all.csv"]);
    expect(cache.entries).not.toHaveBeenCalled();
});
