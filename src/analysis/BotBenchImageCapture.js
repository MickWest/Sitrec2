// BotBenchImageCapture.js — render one image per BOT interchange scenario.
//
// For each scenario this imports the "All" CSV exactly as a drag-and-drop would,
// lets the app frame the scene with its own fit-to-tracks pass, waits until the
// terrain has stopped loading, and reads the main view's canvas back as an image.
// The result is the same picture a person would see after dropping the file in:
// the sensor track, the truth track and the fan of sightlines over the terrain.
//
// The images are POSTed to a small local writer (private/probes/ImageWriterServer.mjs)
// which drops each one into a SitrecImage/ folder beside the scenario's All/ folder,
// so the Track Browser can show a real picture instead of a plotted plan view.
//
// LOCAL BUILDS ONLY. Exposed as window._botImages by addBotBenchMenu, alongside
// window._botBench, because a folder picker needs a user gesture and this has to
// run unattended over hundreds of files.
//
// Speed notes, measured 2026-09-12: every rock_v3 scenario georeferences to the
// same default BOT origin, so the terrain tiles are already cached from the second
// scenario onward and the settle wait collapses to its floor. The costs that
// remain are the parse, one framing pass, and the canvas read-back.

import {FileManager, Globals, NodeMan, Sit, TrackManager, setSitchEstablished} from "../Globals";
import {ViewMan} from "../CViewManager";
import {par} from "../par";

/**
 * Everything the settle gate looks at, in one read. Mirrors the probe the
 * fast-regression harness injects (tests_regression/fast-regression/run.mjs
 * settleStateFn); kept here rather than imported because src/ must not depend
 * on the test tree. Keep the two in step if either changes.
 */
function settleState() {
    const state = {
        pendingActions: Globals.pendingActions ?? 0,
        parsing: Globals.parsing ?? 0,
        deserializing: !!Globals.deserializing,
        loadingTerrain: !!Globals.loadingTerrain,
        texturePendingLoads: 0, textureLoading: 0, textureRecalc: 0,
        texturePendingAncestor: 0, textureNeedsHighRes: 0,
        elevationLoading: 0, elevationRecalc: 0, elevationPendingAncestor: 0,
        pending3DTiles: 0, visibleTiles: 0,
    };
    for (const entry of Object.values(NodeMan.list)) {
        const node = entry?.data;
        if (!node) continue;
        if (node.elevationMap && node.elevationMap.forEachTile) {
            node.elevationMap.forEachTile((tile) => {
                if ((tile.tileLayers ?? 0) === 0) return;
                if (tile.isLoadingElevation) state.elevationLoading++;
                if (tile.isRecalculatingCurve) state.elevationRecalc++;
                if (tile.pendingAncestorLoad) state.elevationPendingAncestor++;
            });
        }
        if (node.maps) {
            for (const mapID in node.maps) {
                const map = node.maps[mapID]?.map;
                if (!map || !map.forEachTile) continue;
                if (typeof map.pendingTileLoads?.size === "number") state.texturePendingLoads += map.pendingTileLoads.size;
                map.forEachTile((tile) => {
                    if ((tile.tileLayers ?? 0) === 0 || !tile.mesh?.visible) return;
                    state.visibleTiles++;
                    if (tile.isLoading) state.textureLoading++;
                    if (tile.isRecalculatingCurve) state.textureRecalc++;
                    if (tile.pendingAncestorLoad) state.texturePendingAncestor++;
                    if (tile.needsHighResLoad) state.textureNeedsHighRes++;
                });
            }
        }
        if (typeof node.getPendingLoadState === "function") {
            if (node.getPendingLoadState()?.hasPending) state.pending3DTiles++;
        }
    }
    return state;
}

function isPending(s) {
    return s.pendingActions > 0 || s.parsing > 0 || s.deserializing || s.loadingTerrain
        || s.texturePendingLoads > 0 || s.textureLoading > 0 || s.textureRecalc > 0
        || s.texturePendingAncestor > 0 || s.elevationLoading > 0 || s.elevationRecalc > 0
        || s.elevationPendingAncestor > 0 || s.pending3DTiles > 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until nothing is loading and the picture has stopped changing.
 *
 * `needsHighResLoad` is deliberately NOT a hard pending flag: a tile whose
 * server has no higher-res level keeps it set forever, so the gate keys off
 * PROGRESS (the count still falling) and gives up on it after hiResStall
 * quiet polls. Same reasoning as the regression harness.
 *
 * @returns {Promise<{settled: boolean, waitedMs: number, polls: number}>}
 */
export async function waitForSettle({
    maxMs = 20000, minMs = 150, pollMs = 50, stableChecks = 3, hiResStall = 12,
} = {}) {
    const t0 = performance.now();
    let stable = 0, polls = 0, lastHiRes = -1, hiResQuiet = 0;
    for (;;) {
        const s = settleState();
        polls++;
        const elapsed = performance.now() - t0;
        if (s.textureNeedsHighRes !== lastHiRes) { lastHiRes = s.textureNeedsHighRes; hiResQuiet = 0; }
        else hiResQuiet++;
        const hiResBlocking = s.textureNeedsHighRes > 0 && hiResQuiet < hiResStall;
        if (!isPending(s) && !hiResBlocking && elapsed >= minMs) {
            if (++stable >= stableChecks) return {settled: true, waitedMs: Math.round(elapsed), polls};
        } else {
            stable = 0;
        }
        if (elapsed > maxMs) return {settled: false, waitedMs: Math.round(elapsed), polls};
        await sleep(pollMs);
    }
}

/**
 * Render ONE view and read its canvas back as a Blob.
 *
 * The renderer has no preserveDrawingBuffer, so the read must follow the render
 * with nothing in between, and the view must be rendered exactly once — driving
 * renderTargetAndEffects()/renderSky() by hand corrupts the look view (see the
 * note in tools/SitrecBridge/extension/page-bridge.js).
 *
 * @param viewId    which view, e.g. "mainView"
 * @param width     output width in pixels; the height keeps the view's aspect.
 *                  0 or undefined keeps the view's own pixel size.
 * @param type      "image/jpeg" (default) or "image/png"
 * @param quality   JPEG quality 0..1
 */
export async function captureViewBlob(viewId = "mainView", {width = 0, type = "image/jpeg", quality = 0.85} = {}) {
    if (!ViewMan.exists(viewId)) throw new Error(`no view "${viewId}"`);
    const view = ViewMan.get(viewId);
    ViewMan.updateZOrder();
    ViewMan.computeEffectiveVisibility();

    const frame = Math.floor(par.frame);
    view.renderCanvas(frame);
    const src = view.canvas;
    if (!src || !src.width || !src.height) throw new Error(`view "${viewId}" has no canvas`);

    // Two kinds of thing sit on top of this view and both belong in the picture.
    // TRUE OVERLAYS declare overlayView and share the parent's rect: the altitude
    // and name labels, the night-sky layer. INSETS are ordinary views that merely
    // happen to be positioned inside the parent's rect with a higher zIndex: the
    // compass rose is one, and it declares neither overlayView nor relativeTo, so
    // only the geometry identifies it.
    const overlays = [];
    const insets = [];
    const l0 = view.leftPx, t0 = view.topPx, r0 = l0 + view.widthPx, b0 = t0 + view.heightPx;
    ViewMan.iterate((id, other) => {
        if (other === view || !other._effectivelyVisible || !other.canvas) return;
        if (other.overlayView === view) { overlays.push(other); return; }
        if (other.overlayView) return;                       // belongs to another view
        if ((other.zIndex || 0) <= (view.zIndex || 0)) return;
        const l = other.leftPx, t = other.topPx;
        if (l >= l0 && t >= t0 && l + other.widthPx <= r0 && t + other.heightPx <= b0) insets.push(other);
    });
    overlays.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    insets.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    const outW = width > 0 ? width : src.width;
    const outH = Math.max(1, Math.round(outW * view.heightPx / view.widthPx));
    const scale = outW / view.widthPx;               // CSS pixels -> output pixels
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(src, 0, 0, outW, outH);

    const drawOne = (other, x, y, w, h) => {
        const alpha = other.transparency !== undefined ? other.transparency : 1;
        if (alpha <= 0) return;
        const style = other.canvas.style;
        if (style.display === "none" || style.visibility === "hidden") return;
        other.renderCanvas(frame);
        if (!other.canvas.width || !other.canvas.height) return;
        ctx.globalAlpha = alpha;
        ctx.drawImage(other.canvas, x, y, w, h);
        ctx.globalAlpha = 1;
    };
    for (const overlay of overlays) drawOne(overlay, 0, 0, outW, outH);
    for (const inset of insets) {
        drawOne(inset, (inset.leftPx - l0) * scale, (inset.topPx - t0) * scale,
            inset.widthPx * scale, inset.heightPx * scale);
    }
    return new Promise((resolve) => out.toBlob(resolve, type, quality));
}

/** Remove every imported track, so the next import frames itself from scratch. */
export function clearImportedTracks() {
    for (const id of Object.keys(TrackManager.list)) TrackManager.disposeRemove(id);
    // disposeRemove() clears this itself once the last track goes, but a run that
    // started with none would otherwise keep a stale true and suppress framing.
    setSitchEstablished(false);
}

/**
 * Import one scenario's All CSV, frame it, and return the image.
 *
 * @param name  file name, e.g. "balloon_001.all.csv"
 * @param text  the CSV text
 * @returns {Promise<{blob: Blob, settled: boolean, waitedMs: number, ms: number}>}
 */
export async function captureScenarioImage(name, text, {
    viewId = "mainView", width = 1024, type = "image/jpeg", quality = 0.85, settle = {},
} = {}) {
    const t0 = performance.now();
    clearImportedTracks();
    // Both of these suppress the fit-to-tracks pass if left set by earlier work.
    Globals.dontAutoZoom = false;
    if (Sit) Sit.centerOnLoadedTracks = true;

    const buffer = new TextEncoder().encode(text).buffer;
    await FileManager.parseResult(name, buffer, null, {returnMeta: true});
    const settleResult = await waitForSettle(settle);
    const blob = await captureViewBlob(viewId, {width, type, quality});
    return {blob, settled: settleResult.settled, waitedMs: settleResult.waitedMs, ms: Math.round(performance.now() - t0)};
}

// ---------------------------------------------------------------------------
// writing into the scenario folder, for a BOT Bench folder run
// ---------------------------------------------------------------------------

export const IMAGE_DIR = "SitrecImage";
const IMAGE_EXT = ".jpg";
const IMAGE_TYPE = "image/jpeg";

/** "balloon_001.all.csv" -> "balloon_001.jpg". */
export function imageNameFor(fileName) {
    return String(fileName).replace(/\.all\.csv$/i, "").replace(/\.[^.]+$/, "") + IMAGE_EXT;
}

/**
 * Where the images for a scenario go: a SitrecImage folder BESIDE the All folder
 * when the scenarios sit in one (the interchange layout), and beside the files
 * themselves otherwise (a flat folder of CSVs).
 *
 * The File System Access API gives no way up from a handle, so the parent has to
 * have been recorded on the way down — walkDirectoryHandle puts it on the entry.
 */
export async function imageDirFor(entry, {create = false} = {}) {
    const leafIsAll = /(^|\/)All$/i.test(entry.dirPath ?? "") || entry.dirHandle?.name === "All";
    const base = (leafIsAll && entry.parentHandle) ? entry.parentHandle : entry.dirHandle;
    if (!base) return null;
    try {
        return await base.getDirectoryHandle(IMAGE_DIR, {create});
    } catch (e) {
        return null;                 // absent and not creating, or no permission
    }
}

/**
 * Is the stored image still good? An image counts as stale when it is missing,
 * or older than the scenario file that produced it. Dates, not hashes: the image
 * is a picture of the scene, so a change that does not move the tracks does not
 * need a new one, and re-reading every CSV to hash it would cost more than the
 * check saves.
 *
 * @returns {Promise<{stale: boolean, reason: string, imageMs: number|null, sourceMs: number|null}>}
 */
export async function imageStaleness(entry, imageDir) {
    let sourceMs = null;
    try { sourceMs = (await entry.getFile()).lastModified ?? null; } catch (e) { /* unreadable */ }
    if (!imageDir) return {stale: true, reason: "no image folder", imageMs: null, sourceMs};
    let imageMs = null;
    try {
        const fh = await imageDir.getFileHandle(imageNameFor(entry.name));
        imageMs = (await fh.getFile()).lastModified ?? null;
    } catch (e) {
        return {stale: true, reason: "missing", imageMs: null, sourceMs};
    }
    if (sourceMs == null || imageMs == null) return {stale: false, reason: "no dates to compare", imageMs, sourceMs};
    if (imageMs >= sourceMs) return {stale: false, reason: "up to date", imageMs, sourceMs};
    return {stale: true, reason: "older than the scenario", imageMs, sourceMs};
}

/**
 * A serial queue for captures.
 *
 * Captures drive the ONE live scene, so they must never overlap however
 * concurrently the analyses that request them are running. A plain promise
 * chain does that, but it was the wrong shape: it could not be cancelled and it
 * could not say how much was left, so cancelling a run left the dialog sitting
 * on "Finishing scenario screenshots..." for as many seconds as there were
 * queued captures, with nothing on screen moving. This is per-run state with a
 * cancel and a progress callback instead.
 */
export function createCaptureQueue({onProgress = null} = {}) {
    const pending = [];
    const queue = {
        done: 0, total: 0, cancelled: false, running: false, current: null,
        add(label, task) {
            if (queue.cancelled) return;
            queue.total++;
            pending.push({label, task});
            queue.pump();
        },
        /** Stop after the capture in flight and discard the rest. */
        cancel() {
            queue.cancelled = true;
            queue.skipped = pending.length;
            pending.length = 0;
        },
        get remaining() { return pending.length; },
        pump() {
            if (queue.running) return queue.chain;
            queue.running = true;
            queue.chain = (async () => {
                while (pending.length && !queue.cancelled) {
                    const item = pending.shift();
                    queue.current = item.label;
                    try { await item.task(); } catch (e) { /* the caller records it */ }
                    queue.done++;
                    onProgress?.(queue);
                }
                queue.running = false;
                queue.current = null;
            })();
            return queue.chain;
        },
        /** Resolve once the queue is empty or cancelled. */
        async idle() {
            while ((pending.length || queue.running) && !queue.cancelled) {
                await (queue.chain ?? Promise.resolve());
                if (!pending.length) break;
            }
            if (queue.cancelled && queue.chain) await queue.chain.catch(() => {});
        },
    };
    return queue;
}

// A process-wide chain kept for the standalone helpers below, which are driven
// from the debug bridge rather than from a run.
let captureChain = Promise.resolve();

export function queueCapture(task) {
    const run = captureChain.then(task, task);
    captureChain = run.catch(() => {});
    return run;
}

/**
 * Capture the image for one scenario and write it into its SitrecImage folder,
 * unless a current one is already there.
 *
 * @returns {Promise<{written: boolean, reason: string, bytes?: number, ms?: number}>}
 */
export async function captureEntryImage(entry, {
    force = false, width = 1024, quality = 0.85, viewId = "mainView", settle = {},
} = {}) {
    const probeDir = await imageDirFor(entry, {create: false});
    const freshness = await imageStaleness(entry, probeDir);
    if (!freshness.stale && !force) return {written: false, reason: freshness.reason};

    const imageDir = probeDir ?? await imageDirFor(entry, {create: true});
    if (!imageDir) return {written: false, reason: "no writable folder"};

    return queueCapture(async () => {
        const text = await (await entry.getFile()).text();
        const shot = await captureScenarioImage(entry.name, text,
            {viewId, width, type: IMAGE_TYPE, quality, settle});
        const fh = await imageDir.getFileHandle(imageNameFor(entry.name), {create: true});
        const writable = await fh.createWritable();
        await writable.write(shot.blob);
        await writable.close();
        return {written: true, reason: force ? "forced" : freshness.reason,
            bytes: shot.blob.size, ms: shot.ms, settled: shot.settled};
    });
}

/** Wait for every queued capture to finish. */
export function captureQueueIdle() {
    return captureChain;
}

/**
 * Capture an image for every entry and POST each one to the local writer.
 *
 * Each entry is {name, text | url, outPath}. `outPath` is the path the writer
 * puts the file at, relative to its own root. Supply `text` directly, or `url`
 * for the runner to fetch.
 *
 * Progress lands on the returned state object, so a caller driving this over a
 * debug bridge can poll it. Errors are collected per entry and never stop the run.
 */
export function runImageCapture(entries, {
    writerUrl = "http://127.0.0.1:9782/write", viewId = "mainView", width = 1024,
    type = "image/jpeg", quality = 0.85, settle = {}, onProgress = null,
} = {}) {
    const state = {
        started: Date.now(), done: 0, total: entries.length, errors: [], notSettled: 0,
        finished: null, lastName: null, msTotal: 0, bytes: 0, fatal: null,
    };
    state.promise = (async () => {
        const wasScreenshotting = Globals.screenshotting;
        // Suppresses the menu rebuild each import would otherwise trigger; the
        // sitch-thumbnail batch in CFileManager uses the same flag for the same reason.
        Globals.screenshotting = true;
        try {
            for (const entry of entries) {
                try {
                    const text = entry.text ?? await (await fetch(entry.url)).text();
                    const shot = await captureScenarioImage(entry.name, text, {viewId, width, type, quality, settle});
                    if (!shot.settled) state.notSettled++;
                    const response = await fetch(writerUrl, {
                        method: "POST",
                        headers: {"Content-Type": type, "X-Rel-Path": entry.outPath},
                        body: shot.blob,
                    });
                    if (!response.ok) throw new Error(`writer ${response.status}: ${(await response.text()).slice(0, 200)}`);
                    state.bytes += shot.blob.size;
                    state.msTotal += shot.ms;
                    state.lastName = entry.name;
                } catch (err) {
                    state.errors.push({name: entry.name, error: String(err?.message ?? err)});
                }
                state.done++;
                if (onProgress) onProgress(state);
            }
        } catch (err) {
            state.fatal = String(err?.message ?? err);
        } finally {
            Globals.screenshotting = wasScreenshotting;
            state.finished = Date.now();
        }
        return state;
    })();
    return state;
}
