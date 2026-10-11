import {createFileHandoffId, putFileHandoff, takeFileHandoff} from "../FileHandoff";
import {Globals, NodeMan, Sit, setRenderOne} from "../Globals";
import {VideoLoadingManager} from "../CVideoLoadingManager";
import {clampSitFrameRange} from "../UpdateSitFrames";
import {clampNoisePatternOptions, showVideoNoisePattern} from "../VideoNoisePattern";
import {frameForDisplayIndex, sourceVideoOf} from "../videoQP/VideoQPAnalysis";
import {readNoisePatternFile} from "./NoisePatternFile";

async function fileAtPath(directory, path) {
    let handle = directory;
    for (const name of path.split("/")) {
        let next;
        for await (const [entry, child] of handle.entries()) {
            if (entry === name) { next = child; break; }
        }
        if (!next) throw new Error(`File no longer exists: ${path}`);
        handle = next;
    }
    return handle.getFile();
}

// Allocate the URL before the click so native new-tab, middle-click and context-menu
// navigation all work. The destination waits while the selected local file is stored.
export function createNoisePatternFileLink(directory, row, options, location = window.location.href) {
    const key = createFileHandoffId();
    const url = new URL(location);
    url.search = "";
    url.hash = "";
    url.searchParams.set("action", "new");
    url.searchParams.set("handoff", key);
    url.searchParams.set("npd", "1");
    const settings = {...options};
    let pending;
    return {url: url.href, prepare() {
        if (!pending) pending = (async () => {
            const file = await fileAtPath(directory, row.path);
            const frames = row.status === "done" && row.frames > 0 ? row.frames
                : (await readNoisePatternFile(file, settings)).scan.analysisFrames;
            await putFileHandoff([file], {source: "npd-folder-scan", relativePath: row.path,
                noisePattern: {options: clampNoisePatternOptions(settings), frames}}, key);
        })().catch(error => { pending = null; throw error; });
        return pending;
    }};
}

export async function takeNoisePatternHandoff(key) {
    const deadline = Date.now() + 120000;
    do {
        const handoff = await takeFileHandoff(key);
        if (handoff) return handoff;
        await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    return null;
}

// The ordinary drop importer accepts the file before its video has finished loading.
// Wait for that source before setting A/B or the loader would overwrite the scan range.
export async function runNoisePatternHandoff(meta) {
    if (!meta?.noisePattern) return;
    const generation = Globals.loadGeneration;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (Globals.loadGeneration !== generation) return;
        const video = NodeMan.get("video", false)?.videoData;
        const source = sourceVideoOf(video);
        if (source?.chunks?.length && source.config && source.groups?.length
            && source.downloadFinished !== false
            && (!source._loadingId || !VideoLoadingManager.isLoading(source._loadingId))) {
            const frames = Math.max(1, Math.min(source.chunks.length, Math.floor(meta.noisePattern.frames)));
            Sit.aFrame = frameForDisplayIndex(video, 0);
            Sit.bFrame = frameForDisplayIndex(video, frames - 1);
            clampSitFrameRange();
            await showVideoNoisePattern(true, {noisePatternOptions: {...clampNoisePatternOptions(meta.noisePattern.options), frames: "ab"}});
            setRenderOne();
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("The video did not finish loading for Noise Pattern Detection.");
}
