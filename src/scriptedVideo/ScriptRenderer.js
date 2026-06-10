// ScriptRenderer.js — offline render of a scripted video to a 1080P60 MP4.
//
// Renders every output frame deterministically (settling terrain/tiles per frame
// when waitForLoading is on), composites into a fixed-size canvas (letterboxed,
// with captions), and encodes via the existing Mediabunny encoder. The live
// viewport is covered with an opaque div during generation — the camera jumps and
// tile streaming would otherwise show as flashing; captured frames are unaffected.
//
// Takes the CScriptedVideoManager `sv` for the parsed model, the quality knobs
// (waitForLoading / terrainDetail / motionBlurSamples / superSample /
// tilesErrorTarget), and the scripted-mode enter/restore machinery.

import {GlobalDateTimeNode, Globals, NodeMan, setRenderOne} from "../Globals";
import {par} from "../par";
import {MediabunnyExporter} from "../MediabunnyExporter";
import {getBestFormatForResolution, getVideoExtension} from "../VideoExporter";
import {waitForExportFrameSettled} from "../ExportFrameSettler";
import {ExportProgressWidget, getExportPrefix} from "../utils";

// Render the scene at scripted time t into the view's own canvas (no compositing).
// superSample (>=1) renders at a multiple of the output resolution for SSAA.
async function renderViewAt(sv, view, sf, t, width, height) {
    par.frame = sf;
    GlobalDateTimeNode?.update(sf);
    // tame the 3D photorealistic tiles before the per-node update selects LODs
    tame3DTiles(sv);
    // run every node's per-frame update + await any video decode
    for (const entry of Object.values(NodeMan.list)) {
        const n = entry.data;
        if (n.isController && !n.allowUpdate) continue;
        if (n.update !== undefined) n.update(sf);
        if (n.videoData && n.videoData.waitForFrame) { try { await n.videoData.waitForFrame(sf); } catch (e) {} }
    }
    if (!view) return;
    view.setVisible(true);
    // Force the target (super-sampled) render size: camera.aspect & render size
    // derive from widthPx/heightPx, divided by the renderer's devicePixelRatio so
    // the backing lands on width*ss x height*ss. The look view's own video-aspect
    // match letterboxes the witness footage correctly within that frame.
    const ss = sv.superSample || 1;
    const pr = (view.renderer && view.renderer.getPixelRatio) ? (view.renderer.getPixelRatio() || 1) : 1;
    view.widthPx = Math.max(2, Math.round((width * ss) / pr));
    view.heightPx = Math.max(2, Math.round((height * ss) / pr));
    if (view.camera) {
        // 3D view: position the scripted camera and run the full render hooks
        sv.applyCameraForTime(t);
        view.camera.updateMatrix();
        view.camera.updateMatrixWorld(true);
        for (const pn of NodeMan.getPreRenderNodes()) pn.preRender(view);
        view.renderCanvas(sf);
        for (const pn of NodeMan.getPostRenderNodes()) pn.postRender(view);
    } else {
        // 2D view (witness video): no camera, just draw its canvas at this frame
        view.renderCanvas(sf);
    }
}

// The Google-photorealistic 3D tiles (buildings3DTiles) get their own per-view
// TilesRenderer (created lazily). Under a MOVING camera at full render resolution
// the mainView renderer demands far more fine-LOD tiles than it can fetch within
// budget, so its load queue never drains and the TilesFadePlugin keeps ~70 tiles
// perpetually cross-fading (a dithered flicker) — and the per-frame settle never
// quiesces. Raising errorTarget on the moving (main) view makes it request coarser,
// already-available tiles so the tileset settles; the look view keeps full detail
// (its camera is static during a `wait`, so it settles on its own). fadeDuration 0
// removes the dithered cross-fade entirely.
function tame3DTiles(sv) {
    const b = NodeMan.get("buildings3DTiles", false);
    if (!b || !b._perView) return;
    for (const [vid, pv] of Object.entries(b._perView)) {
        if (pv.fadePlugin) pv.fadePlugin.fadeDuration = 0;
        if (pv.renderer && vid === "mainView" && sv.tilesErrorTarget) {
            pv.renderer.errorTarget = sv.tilesErrorTarget;
        }
    }
}

// Composite the view's canvas into a destination rect of the output ctx
// (letterboxed within it), at the given alpha (used for running-average
// accumulation / motion blur).
function compositeView(ctx, view, dx, dy, dw, dh, alpha = 1) {
    if (!view || !view.canvas) return;
    const cw = view.canvas.width, ch = view.canvas.height;
    if (cw <= 0 || ch <= 0) return;
    const s = Math.min(dw / cw, dh / ch);
    const w = cw * s, h = ch * s;
    ctx.globalAlpha = alpha;
    ctx.drawImage(view.canvas, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
    ctx.globalAlpha = 1;
}

export async function renderScriptedVideo(sv) {
    sv._exitAllModes();
    await sv.parse();
    sv.prepare();
    if (sv.totalDuration <= 0) { alert("Scripted Video: nothing to render (no timed commands)."); return; }

    const width = sv.outW, height = sv.outH, fps = sv.outFps;
    const totalFrames = Math.max(1, Math.round(sv.totalDuration * fps));

    const best = await getBestFormatForResolution("mp4-h264", width, height);
    if (!best.formatId) { alert("Scripted Video: " + (best.reason || "no codec for 1920x1080")); return; }
    const extension = getVideoExtension(best.formatId);
    const format = best.formatId === "webm-vp8" ? "webm" : "mp4";
    const codec = format === "mp4" ? "avc" : "vp8";

    const out = document.createElement("canvas");
    out.width = width; out.height = height;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";   // good SSAA downsample
    const mbSamples = Math.max(1, sv.motionBlurSamples || 1);

    // save / clobber state
    const savedFrame = par.frame, savedPaused = par.paused;
    par.paused = true;
    Globals.scriptedVideoRendering = true;   // take exclusive control of rendering
    const restore = sv._enterScriptedMode();
    // neutralise the preRender hooks for offline (we position the camera explicitly)
    const mainV = NodeMan.get("mainView", false), lookV = NodeMan.get("lookView", false);
    if (mainV) mainV.preRenderFunction = () => {};
    if (lookV) lookV.preRenderFunction = () => {};

    // Force every rendered view to a true 16:9 render, independent of the
    // on-screen window shape (which may be portrait / side-by-side). The view's
    // camera.aspect and render size come from widthPx/heightPx, so we drive
    // those to 1920x1080 right before each renderCanvas (see renderViewAt). We
    // save the live values here and restore them at the end.
    const videoV = NodeMan.get("video", false);   // witness-video view ("view video")
    const sizedViews = [mainV, lookV, videoV].filter(Boolean);
    const savedViewSize = sizedViews.map((v) => ({v, wp: v.widthPx, hp: v.heightPx}));

    const progress = new ExportProgressWidget("Rendering scripted video (1080P60)…", totalFrames);
    sv._renderProgress = {i: 0, total: totalFrames, done: false, error: null, blobSize: 0, filename: null};

    // Opaque cover over the viewport during generation. The render drives the
    // live view (camera jumps, terrain streams in) which would otherwise be
    // visible as flashing/popping while it works. Covering it hides that churn;
    // the captured frames are unaffected (WebGL renders to the buffer regardless
    // of what's drawn on top). The progress widget sits above this cover.
    const cover = document.createElement("div");
    cover.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483646;" +
        "display:flex;align-items:center;justify-content:center;color:#777;font-family:sans-serif;font-size:18px;";
    cover.textContent = "Rendering scripted video…";
    document.body.appendChild(cover);

    let exporter = null;
    let restoreTerrain = null;
    try {
        exporter = new MediabunnyExporter({
            width, height, fps, format, codec,
            bitrate: 16_000_000, keyFrameInterval: fps,
            hardwareAcceleration: best.hardwareAcceleration,
        });
        await exporter.initialize();

        // --- Terrain handling ---
        // The on-screen churn during generation (camera jumps + tiles streaming)
        // is hidden by the opaque cover and does not affect captured frames.
        //
        // When waitForLoading is on (default) we SETTLE each frame: subdivision
        // stays live and converges for THAT frame's actual camera, and tiles finish
        // loading, before we capture. That keeps the terrain stable and correct per
        // frame — no LOD pop and no edge-tile toggling as the camera moves.
        // (A previous "freeze the LOD" speed hack broke on big moves like orbits:
        // it froze one viewpoint's tile set whose edge tiles then flipped in and out
        // of the moving frustum.) waitForLoading off = fast/rough, may pop.
        const terrainUINode = NodeMan.get("terrainUI", false);
        // make sure subdivision is live (in case a prior aborted run left it frozen)
        if (terrainUINode) terrainUINode.disableDynamicSubdivision = false;

        // Optional: trade terrain detail for render speed (fewer tiles to stream).
        const savedTexDetail = terrainUINode ? terrainUINode.textureDetail : undefined;
        const savedEleDetail = terrainUINode ? terrainUINode.elevationDetail : undefined;
        if (terrainUINode && sv.terrainDetail && sv.terrainDetail !== 1) {
            if (savedTexDetail !== undefined) terrainUINode.textureDetail = savedTexDetail * sv.terrainDetail;
            if (savedEleDetail !== undefined) terrainUINode.elevationDetail = savedEleDetail * sv.terrainDetail;
        }
        restoreTerrain = () => {
            if (!terrainUINode) return;
            if (savedTexDetail !== undefined) terrainUINode.textureDetail = savedTexDetail;
            if (savedEleDetail !== undefined) terrainUINode.elevationDetail = savedEleDetail;
        };

        const settleAt = async (view, viewId, sf, t, cap, vw, vh) => {
            if (!view) return;
            const r = async () => { await renderViewAt(sv, view, sf, t, vw, vh); };
            await r();
            // Don't gate the settle on the video frame: renderViewAt already awaits
            // videoData.waitForFrame(sf), and video.isFrameCached() can return null
            // (treated as "pending" forever by the settler). Pass frame=null so the
            // settle waits only on terrain + 3D tiles + async work.
            await waitForExportFrameSettled({
                frame: null, viewIds: [viewId], renderFrame: r,
                maxWaitMs: cap, stableChecks: 2, postSettleRenders: 1,
                logPrefix: "Scripted video",
            });
        };

        for (let i = 0; i < totalFrames; i++) {
            if (progress.shouldStop()) break;
            const t = i / fps;
            sv._currentT = t;
            const sf = sv.sitFrameAt(t);
            sv.applySettingsForTime(t);   // scripted set/show/hide at this time
            // the active layout: one or more views, each in a sub-rect of the frame
            const layout = sv.activeLayoutAt(t);

            ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
            for (const [viewId, rect] of Object.entries(layout)) {
                const view = NodeMan.get(viewId, false);
                if (!view) continue;
                // scripted opacity (fade command); fully faded views are skipped
                const opacity = sv.viewOpacityAt(viewId, t);
                if (opacity <= 0.004) continue;
                const px = rect.left * width, py = rect.top * height;
                const pw = Math.max(2, Math.round(rect.width * width));
                const ph = Math.max(2, Math.round(rect.height * height));

                // Settle this frame's terrain (subdivide for this camera + finish
                // loading) before capture. Consecutive frames mostly hit cache, so
                // after the first frame of a shot this is fast.
                if (sv.waitForLoading) await settleAt(view, viewId, sf, t, 8000, pw, ph);

                // Composite. Optional accumulation motion blur (mbSamples>1)
                // averages sub-frames across the shutter for a cinematic look; it
                // is NOT the flicker fix (that's the settle above) — default off.
                if (mbSamples === 1 && sv.waitForLoading) {
                    // settleAt() already left the view rendered at exactly (sf, t) —
                    // composite it directly instead of paying for another full render
                    compositeView(ctx, view, px, py, pw, ph, opacity);
                } else {
                    for (let k = 0; k < mbSamples; k++) {
                        const subT = t + (mbSamples > 1 ? (k / mbSamples) / fps : 0);
                        sv._currentT = subT;
                        await renderViewAt(sv, view, sv.sitFrameAt(subT), subT, pw, ph);
                        // running average; ×opacity is approximate when blur is on
                        compositeView(ctx, view, px, py, pw, ph, (1 / (k + 1)) * opacity);
                    }
                }
            }
            sv._currentT = t;
            sv._drawTexts(ctx, width, height, t);   // captions stay crisp

            await exporter.addFrame(out, i);
            sv._renderProgress.i = i + 1;
            if (i % 5 === 0) { progress.update(i + 1); await new Promise(r => setTimeout(r, 0)); }
        }

        progress.update(totalFrames);
        if (progress.shouldSave()) {
            const blob = await exporter.finalize(
                (c, tot) => progress.setFinalizeProgress(c, tot),
                (st) => progress.setStatus(st));
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
            const filename = `${getExportPrefix()}_scripted_${stamp}.${extension}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = filename; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            sv._renderProgress.blobSize = blob.size;
            sv._renderProgress.filename = filename;
        }
    } catch (e) {
        console.error("Scripted video render failed:", e);
        if (sv._renderProgress) sv._renderProgress.error = (e && e.stack) ? e.stack : String(e);
        alert("Scripted video render failed: " + (e.message || e));
    } finally {
        if (sv._renderProgress) sv._renderProgress.done = true;
        progress.remove();
        if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
        if (restoreTerrain) restoreTerrain();
        for (const {v, wp, hp} of savedViewSize) { v.widthPx = wp; v.heightPx = hp; }
        restore();
        Globals.scriptedVideoRendering = false;   // return control to the main loop
        par.frame = savedFrame; par.paused = savedPaused;
        setRenderOne(true);
    }
}
