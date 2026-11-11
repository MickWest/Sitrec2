// StaleBuildRecovery.js - what Sitrec does when a part of it cannot load because the server
// has a new build.
//
// Sitrec loads many parts only when they are first used: the Custom Object Designer, some
// tools, the workers. Each part is a "chunk" file whose name has a hash of its content. A new
// build has new names, and an in-place deploy removes the old files. A page that was opened
// before the deploy still asks for the old names, so its next lazy load fails.
//
// installStaleBuildRecovery() puts one hook on the function that loads every chunk. When a
// load fails, the hook reads build-info.json again, with no cache. If the server has another
// build (or does not have this one), the user gets a dialog with three ways out:
//
//   Save and reload                 the normal save, then a reload with the new build
//   Reload with a temporary save    the sitch goes to the storage of this browser, the page
//                                   reloads at the same address, and the sitch opens again
//   Try to continue                 the page reads app-chunks.json (scripts/channelBuild.js),
//                                   which has the file names of the new build, and loads the
//                                   new chunk into the old page
//
// A load that fails for another reason (no network, the same build still on the server) is
// not changed: the caller gets the same error as before.
//
// The rules are in StaleBuildModel.js, which has no imports and is tested by Jest.

// __webpack_chunk_load__, __webpack_get_script_filename__ and __webpack_require__ are names that
// webpack gives to module code (they are in the globals list of biome.json). The first two can
// be assigned: that is how a page changes the loader. They do not exist outside a webpack bundle.

import {CustomManager, FileManager, Globals, NodeMan, Sit} from "./Globals";
import {showChoice, showError} from "./showError";
import {t} from "./i18n";
import {saveChannelHandoff} from "./release/channelHandoff";
import {buildAssetURL} from "./release/assetURL";
import {buildLabel, cleanBuild} from "./release/channelModel";
import {classifyServerBuild, ownChunkGlobal, readChunkManifest, unsavedLocalFiles} from "./StaleBuildModel";

const running = cleanBuild(process.env.SITREC_BUILD_INFO);

// One dialog answers all the chunk loads that fail together (one import() can ask for
// several chunks).
let decision = null;
// The names of the build whose chunks this page now loads, after Try to continue.
let adopted = null;

// Read a small JSON file of the build folder, never from a cache.
async function readBuildFile(name) {
    try {
        const url = new URL(buildAssetURL(name), window.location.href);
        url.searchParams.set("t", String(Date.now()));
        const response = await fetch(url.href, {cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(8000)});
        return {status: response.status, value: response.ok ? await response.json().catch(() => null) : null};
    } catch {
        return {status: 0, value: null};
    }
}

function reloadPage() {
    Globals.allowUnload = true;         // the user chose this reload: no "Leave site?" question
    window.location.reload();
}

// The files that a sitch file cannot name, because no save has stored them anywhere.
function filesOnlyInMemory(local) {
    const files = Object.entries(FileManager?.list ?? {}).map(([id, file]) => ({
        name: file.filename || id, dynamicLink: !!file.dynamicLink, staticURL: file.staticURL,
        localStaticURL: file.localStaticURL, skipSerialization: !!file.skipSerialization,
    }));
    const videoNode = NodeMan?.exists?.("video") ? NodeMan.get("video") : null;
    let videos = [];
    if (videoNode?.videos?.length > 0) {
        // An image entry is a file of the FileManager, which the list above has.
        videos = videoNode.videos.filter(entry => !(entry.isImage && entry.imageFileID))
            .map(entry => ({name: entry.fileName, staticURL: entry.staticURL, localStaticURL: entry.localStaticURL}));
    } else if (videoNode?.fileName && videoNode.videoData) {
        videos = [{name: videoNode.fileName, staticURL: videoNode.staticURL, localStaticURL: videoNode.localStaticURL}];
    }
    return unsavedLocalFiles({files, videos, local});
}

// A sitch in a working folder names its files by their place in that folder.
const usesWorkingFolder = () => !!FileManager?.directoryHandle;

// Keep the sitch in the storage of this browser and reload. The startup code takes it from
// there (index.js, takeChannelHandoff) in place of the sitch of the page address, so the
// address does not change. This is the store that a change of release channel uses.
async function reloadWithTemporarySave(dirty = !!Globals.sitchDirty) {
    try {
        const text = CustomManager.getCustomSitchString(usesWorkingFolder());
        const sourceRef = FileManager.loadURL ?? null;
        await saveChannelHandoff(text, {
            sourceRef,
            sourceUserID: FileManager.sourceUserID ?? null,
            localFileHandle: FileManager.localSitchEntry ?? undefined,
            localDirectoryHandle: FileManager.directoryHandle ?? undefined,
            // the sitch had changes that were not saved, and it still has them after the reload
            restoreDirty: dirty,
        });
    } catch (error) {
        showError(t("staleBuild.temporaryFailed"), error);
        return false;
    }
    reloadPage();
    return true;
}

// The normal save (the same as Ctrl/Cmd+S), then a reload. A save to the server puts the
// address of the saved sitch in the address bar, so the reload opens that sitch. A save to a
// working folder has no address: the reload gets the saved sitch through the browser store.
async function saveAndReload() {
    let saved = false;
    try {
        saved = await FileManager.handleSaveShortcut();
    } catch (error) {
        console.warn("Save before the reload failed:", error);
    }
    if (!saved) return false;
    if (String(FileManager.lastSaveAction ?? "").startsWith("local")) return reloadWithTemporarySave(false);
    reloadPage();
    return true;
}

// Make this page load the chunks of the build that is on the server now.
async function adoptServerChunks() {
    try {
        const manifest = readChunkManifest((await readBuildFile("app-chunks.json")).value);
        if (!manifest) throw new Error("app-chunks.json is missing or not valid");
        // A chunk of the new build registers itself on the global of the NEW build. Point that
        // name at this page's own list, so the old loader gets the chunk.
        const own = ownChunkGlobal(Object.keys(self).filter(key => key.startsWith("webpackChunk") && Array.isArray(self[key])), running?.id);
        if (!own) throw new Error("the chunk list of this page was not found");
        if (manifest.chunkLoadingGlobal !== own) self[manifest.chunkLoadingGlobal] = self[own];
        const first = !adopted;
        adopted = manifest;
        if (first) {
            // The loader asks these two functions for the file name of a chunk. A worker gets
            // its file name from the first one too.
            const scriptName = __webpack_get_script_filename__;
            __webpack_get_script_filename__ = (chunkId) => adopted.chunks[chunkId] ?? scriptName(chunkId);
            if (typeof __webpack_require__.miniCssF === "function") {
                const styleName = __webpack_require__.miniCssF;
                __webpack_require__.miniCssF = (chunkId) => adopted.styles[chunkId] ?? styleName(chunkId);
            }
        }
        console.warn(`This page (${running?.id}) now loads the chunks of build ${manifest.buildID}.`);
        return true;
    } catch (error) {
        showError(t("staleBuild.cannotContinue"), error);
        return false;
    }
}

function askUser(state, serverBuild) {
    const canSave = !!(Sit?.canMod || Sit?.isCustom);
    const onlyInMemory = canSave ? filesOnlyInMemory(usesWorkingFolder()) : [];
    const lines = [t(state === "gone" ? "staleBuild.messageGone" : "staleBuild.message"), "",
        t("staleBuild.running", {build: buildLabel(running)})];
    if (cleanBuild(serverBuild)) lines.push(t("staleBuild.onServer", {build: buildLabel(serverBuild)}));
    if (canSave && Globals.sitchDirty) lines.push("", t("staleBuild.unsavedChanges"));
    if (onlyInMemory.length > 0) lines.push("", t("staleBuild.filesOnlyInMemory", {files: onlyInMemory.join(", ")}));

    const options = [];
    if (canSave) {
        options.push({value: "save", primary: true, label: t("staleBuild.save.label"), description: t("staleBuild.save.description")});
        options.push({value: "temporary", disabled: onlyInMemory.length > 0,
            label: t("staleBuild.temporary.label"), description: t("staleBuild.temporary.description")});
    } else {
        options.push({value: "reload", primary: true, label: t("staleBuild.reload.label"), description: t("staleBuild.reload.description")});
    }
    // The files of the new build are in the same folder only when it replaced this one.
    if (state === "replaced") {
        options.push({value: "continue", color: "#8a6d1c", label: t("staleBuild.continue.label"), description: t("staleBuild.continue.description")});
    }
    options.push({value: null, cancel: true, label: t("staleBuild.cancel.label"), description: t("staleBuild.cancel.description")});
    return showChoice(lines.join("\n"), {title: t("staleBuild.title"), options});
}

// Resolves to "continue" (load the chunk again), "reloading" (the page is going away) or
// "fail" (give the caller its error).
async function decide() {
    const server = await readBuildFile("build-info.json");
    const state = classifyServerBuild(running?.id, {status: server.status, build: server.value});
    if (state !== "replaced" && state !== "gone") return "fail";
    // This page already loads the chunks of that build, so this is a failure of another kind.
    if (adopted && state === "replaced" && server.value.id === adopted.buildID) return "fail";
    for (;;) {
        const choice = await askUser(state, server.value);
        if (choice === "save" && await saveAndReload()) return "reloading";
        if (choice === "temporary" && await reloadWithTemporarySave()) return "reloading";
        if (choice === "reload") { reloadPage(); return "reloading"; }
        if (choice === "continue" && await adoptServerChunks()) return "continue";
        if (choice === null || choice === undefined) return "fail";
        // The choice did not work (a cancelled save, a store that is full): ask again.
    }
}

async function recover(error, retry) {
    if (!decision) {
        decision = decide();
        const clear = () => { decision = null; };
        decision.then(clear, clear);
    }
    let choice;
    try {
        choice = await decision;
    } catch (failure) {
        console.warn("Stale build recovery failed:", failure);
        throw error;
    }
    if (choice === "continue") return retry();
    if (choice === "reloading") return new Promise(() => {});      // nothing more happens on this page
    throw error;
}

// Call once, at startup, from the main bundle.
export function installStaleBuildRecovery() {
    // Only a webpack bundle in a browser has the chunk loader (not Jest, not the console build).
    if (typeof window === "undefined" || typeof __webpack_chunk_load__ !== "function") return;
    const load = __webpack_chunk_load__;
    __webpack_chunk_load__ = (...args) => load(...args).catch(error => recover(error, () => load(...args)));
}
