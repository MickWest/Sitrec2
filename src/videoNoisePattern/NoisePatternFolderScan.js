import {analyzeNoisePatternFile, checkNoisePatternAbort, isNoisePatternVideoName} from "./NoisePatternFile";
import {LAG_MIN} from "./NoisePatternMath";

// Only summaries survive a file. Feature arrays, decoded pictures and encoded video
// belong to that file's job and are released before the next video starts.
export function summarizeNoisePatternResult(result) {
    const offsetMatches = result.offset?.matches?.filter(m => m.screening?.passed === true) ?? [];
    const v = result.verdict ?? {};
    const isolated = (v.isolated ?? []).slice().sort((a, b) => b.z - a.z).slice(0, 10);
    return {
        status: result.status, error: result.error ?? "", kind: v.kind,
        period: v.period ?? null, strength: v.strength ?? isolated[0]?.z ?? null,
        strengthLabel: v.strengthLabel ?? "", curve: v.curve ?? isolated[0]?.curve ?? "",
        coverage: v.coverage ?? null, references: v.references ?? result.lags?.R ?? 0,
        frames: result.counts?.frames ?? result.video?.frames ?? 0, decoded: result.counts?.decoded ?? 0,
        failed: result.counts?.failed ?? 0, held: result.counts?.held ?? 0,
        usable: result.counts?.validAny ?? v.frames ?? null,
        validByPlane: result.counts?.valid ?? [], minUsableFrames: 8 * LAG_MIN,
        tested: result.precise?.tested ?? 0, matched: result.precise?.matched ?? 0,
        pictureRepeat: !!result.pictureRepeat?.repeats, pictureMode: !!result.picture,
        codec: result.video?.codec ?? "", elapsedMs: result.timings?.total ?? 0,
        runs: result.precise?.runs ?? [], longRange: result.longRange ?? null, isolated,
        limitMinutes: result.scan?.limitMinutes ?? null, analyzedSeconds: result.scan?.analyzedSeconds ?? null,
        capped: !!result.scan?.capped, autoReduced: !!result.scan?.autoReduced, videoDurationSeconds: result.scan?.videoDurationSeconds ?? null,
        offsetStatus: result.offset?.status ?? "disabled", offsetCandidates: offsetMatches.length,
        offsetSuppressed: (result.offset?.matches?.length ?? 0) - offsetMatches.length,
        offsetScore: offsetMatches[0]?.score ?? null, offsetPairs: result.offset?.pairs ?? 0,
        offsetError: result.offset?.error ?? "",
    };
}

export function noisePatternFolderCSV(rows) {
    const columns = ["path", "folder", "status", "kind", "period", "strength", "strengthLabel", "curve", "coverage", "references",
        "frames", "decoded", "failed", "held", "usable", "minUsableFrames", "tested", "matched", "pictureRepeat", "pictureMode", "codec", "elapsedMs",
        "limitMinutes", "analyzedSeconds", "capped", "autoReduced", "videoDurationSeconds", "error",
        "offsetStatus", "offsetCandidates", "offsetSuppressed", "offsetScore", "offsetPairs", "offsetError"];
    const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return [columns.join(","), ...rows.map(row => columns.map(c => quote(row[c])).join(","))].join("\r\n");
}

export function createNoisePatternFolderScan({analyze = analyzeNoisePatternFile, onUpdate = () => {}} = {}) {
    const controller = new AbortController();
    const state = {status: "idle", folder: "", folders: [], rows: [], errors: [], completed: 0, options: null};
    const update = () => onUpdate(state);
    async function walk(directory, path = "") {
        checkNoisePatternAbort(controller.signal);
        state.folders.push(path || ".");
        try {
            for await (const [name, handle] of directory.entries()) {
                checkNoisePatternAbort(controller.signal);
                const relativePath = path ? `${path}/${name}` : name;
                if (handle.kind === "directory") await walk(handle, relativePath);
                else if (handle.kind === "file" && isNoisePatternVideoName(name)) {
                    state.rows.push({path: relativePath, folder: path || ".", name, status: "queued", getFile: () => handle.getFile()});
                }
            }
        } catch (error) {
            checkNoisePatternAbort(controller.signal);
            state.errors.push({path: path || ".", error: error?.message ?? String(error)});
        }
        update();
    }
    return {
        state,
        stop() { controller.abort(); },
        async run(directory, options = {}) {
            if (state.status !== "idle") throw new Error("This scan has already started");
            state.status = "walking";
            state.folder = directory.name;
            state.options = {...options, frames: "all", range: null};
            update();
            try {
                await walk(directory);
                state.rows.sort((a, b) => a.path.localeCompare(b.path));
                state.status = "scanning";
                for (const row of state.rows) {
                    checkNoisePatternAbort(controller.signal);
                    row.status = "reading";
                    update();
                    try {
                        const file = await row.getFile();
                        checkNoisePatternAbort(controller.signal);
                        const result = await analyze(file, state.options, {signal: controller.signal, onProgress: progress => {
                            if (controller.signal.aborted) return;
                            row.status = progress.stage;
                            row.progress = {...progress.progress};
                            update();
                        }});
                        checkNoisePatternAbort(controller.signal);
                        Object.assign(row, summarizeNoisePatternResult(result));
                    } catch (error) {
                        checkNoisePatternAbort(controller.signal);
                        row.status = "error";
                        row.error = error?.message ?? String(error);
                    }
                    delete row.getFile;
                    delete row.progress;
                    state.completed++;
                    update();
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                state.status = "done";
            } catch (error) {
                state.status = controller.signal.aborted ? "stopped" : "error";
                if (!controller.signal.aborted) state.errors.push({path: ".", error: error?.message ?? String(error)});
            } finally {
                for (const row of state.rows) {
                    delete row.getFile;
                    delete row.progress;
                    if (!["done", "error"].includes(row.status)) row.status = "stopped";
                }
                update();
            }
            return state;
        },
    };
}
