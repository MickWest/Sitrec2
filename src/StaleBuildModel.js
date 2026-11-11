// The rules for a page that runs a build which the server no longer has. They are pure
// functions with no imports, so Jest can test them. StaleBuildRecovery.js has the browser
// side: the hook on the chunk loader, the dialog and the three ways out.

// What a fresh read of build-info.json says about the build that this page runs.
//   "same"     the server still has this build, so the load failed for another reason
//   "replaced" another build is in its place
//   "gone"     the files of this build are not on the server
//   "unknown"  the server did not answer, or its answer was not a build record
// `status` is the HTTP status of the read, or 0 when the request itself failed.
export function classifyServerBuild(runningID, {status = 0, build = null} = {}) {
    if (status === 404 || status === 410) return "gone";
    if (status < 200 || status >= 300) return "unknown";
    if (!build || typeof build.id !== "string" || !build.id) return "unknown";
    if (!runningID) return "unknown";
    return build.id === runningID ? "same" : "replaced";
}

// A chunk file is one plain name in the build folder: no path, no scheme, no query. It can
// start with "_" (webpack names a chunk "_b520") but not with ".".
const CHUNK_FILE = /^[A-Za-z0-9_][A-Za-z0-9._~@+-]*\.(?:js|css)$/;
const GLOBAL_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Check app-chunks.json (scripts/channelBuild.js writes it) and return a clean copy, or null.
// Its file names go into script URLs, so each one must be a plain file name.
export function readChunkManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.chunkLoadingGlobal !== "string" || !GLOBAL_NAME.test(value.chunkLoadingGlobal)) return null;
    const names = (source, extension) => {
        if (source === undefined) return {};
        if (!source || typeof source !== "object" || Array.isArray(source)) return null;
        const out = {};
        for (const [chunkId, file] of Object.entries(source)) {
            if (typeof file !== "string" || !CHUNK_FILE.test(file) || !file.endsWith(extension)) return null;
            out[chunkId] = file;
        }
        return out;
    };
    const chunks = names(value.chunks, ".js"), styles = names(value.styles, ".css");
    if (!chunks || !styles || Object.keys(chunks).length === 0) return null;
    return {buildID: typeof value.build?.id === "string" ? value.build.id : null,
        chunkLoadingGlobal: value.chunkLoadingGlobal, chunks, styles};
}

// The global that the chunks of the running build register on: "webpackChunk" and the unique
// name of the build, in which webpack puts "_" for each character that an identifier cannot
// have. `keys` are the names of the globals that hold an array.
export function ownChunkGlobal(keys, runningID) {
    const candidates = keys.filter(key => key.startsWith("webpackChunk"));
    if (runningID) {
        const suffix = runningID.replace(/[^A-Za-z0-9_$]/g, "_");
        const exact = candidates.find(key => key.endsWith(suffix));
        if (exact) return exact;
    }
    return candidates.length === 1 ? candidates[0] : null;
}

// The files that are only in the memory of the page: the user loaded them from the computer
// and no save has put them on the server or in the working folder. A sitch file does not
// have them (CustomManagerSerialize.getCustomSitchString leaves them out), so a reload from a
// temporary save cannot keep them.
//   files   [{name, dynamicLink, staticURL, localStaticURL, skipSerialization}] (FileManager.list)
//   videos  [{name, staticURL, localStaticURL}] (the entries of the video node)
//   local   the sitch file is for a working folder (it uses localStaticURL)
export function unsavedLocalFiles({files = [], videos = [], local = false} = {}) {
    const names = [];
    for (const file of files) {
        if (file.skipSerialization || !file.dynamicLink) continue;
        // A working-folder sitch file names a file by its place in the folder, and a server
        // sitch file by its address on the server.
        if (local ? file.localStaticURL : file.staticURL) continue;
        names.push(file.name);
    }
    for (const video of videos) {
        // A working-folder sitch file can also name a video by its address on the server.
        if (!video.name || video.staticURL || local && video.localStaticURL) continue;
        names.push(video.name);
    }
    return [...new Set(names.filter(Boolean))];
}
