// CScriptedVideo.js
//
// A text-script driven "video" system for Sitrec.
//
// The user writes a simple line-based script in a textarea under the
// Video > "Scripted Video" menu. Each line is a command with a duration in
// seconds. The commands drive cinematic camera moves (zoom in on an object,
// orbit it, track it, change FOV), cut between views, and overlay on-screen
// text. The whole thing has its own timeline (independent of the sitch frame
// slider) shown as labelled blocks, can be previewed live, and rendered out
// to a 1080P60 MP4 via the existing Mediabunny encoder.
//
// The system is split across src/scriptedVideo/:
//   ScriptCommands.js       command registry — each command's parse/prepare/sample
//   ScriptParser.js         pure script-text → events parser (language docs here)
//   ScriptCameraEngine.js   camera pose computation (prepare/computeCamera)
//   ScriptTimelineWidget.js timeline canvas widget (draw, scrub, zoom, wheel-edit)
//   ScriptEditorWindow.js   floating script editor window (+ popout)
//   ScriptRenderer.js       offline 1080P60 MP4 render
//
// This file is the manager: it owns the parsed model (events/beats/duration),
// the preview and scrub modes (entering/leaving "scripted mode" — taking over
// the main camera and views — and restoring everything afterwards), the live
// caption overlay, and the menu.
//
// The sitch's own playhead advances linearly across the whole scripted
// duration, so the world (e.g. an aircraft flying its track) animates while
// the camera moves.

import {par} from "./par";
import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit} from "./Globals";
import {ViewMan} from "./CViewManager";
import {clamp} from "./scriptedVideo/ScriptMath";
import {VIEW_MAP} from "./scriptedVideo/ScriptCommands";
import {parseScript, activeViewAt} from "./scriptedVideo/ScriptParser";
import {prepareEvents, computeCamera, applyPoseToCam} from "./scriptedVideo/ScriptCameraEngine";
import {CScriptTimelineWidget} from "./scriptedVideo/ScriptTimelineWidget";
import {CScriptEditorWindow, STORAGE_KEY, DEFAULT_SCRIPT} from "./scriptedVideo/ScriptEditorWindow";
import {renderScriptedVideo} from "./scriptedVideo/ScriptRenderer";

class CScriptedVideoManager {
    constructor() {
        // parsed model
        this.events = [];          // all parsed events (camera beats + view + text)
        this.cameraBeats = [];     // just the time-consuming camera beats, in order
        this.totalDuration = 0;    // seconds
        this.parseErrors = [];
        this._numLanes = 1;        // timeline display lanes (overlapping events stack)
        this.defaultView = "main";

        this.outW = 1920;
        this.outH = 1080;
        this.outFps = 60;

        // render quality knobs (read by ScriptRenderer.js)
        this.waitForLoading = true;   // true (default) = settle each frame: subdivision
                                      // converges for that frame's camera + tiles finish
                                      // loading before capture (stable, no pop/toggle;
                                      // slower). false = fast/rough, terrain may pop.
        this.terrainDetail = 1;       // terrain LOD detail multiplier; <1 loads fewer
                                      // tiles → much faster render, slightly coarser.
        this.tilesErrorTarget = 80;   // 3D-tiles screen-space-error for the moving (main)
                                      // view during render; higher = coarser but settles
                                      // (stops the photorealistic-tile fade flicker).
        this.motionBlurSamples = 1;   // optional cinematic motion blur (1 = off)
        this.superSample = 1;         // optional render at N x resolution then downscale

        // live preview state
        this._previewing = false;
        this._previewRAF = null;
        this._previewStart = 0;
        this._currentT = 0;
        this._restore = null;        // function to undo scripted-mode changes
        this._activeViewId = null;   // currently-shown view during preview
        this._overlayCanvas = null;  // DOM canvas for live caption text

        // hover state SHARED between the editor (number under the mouse) and the
        // timeline widget (segment under the mouse) — each highlights the other
        this._hoverNum = null;       // number token under the mouse in the editor
        this._hoverSeg = null;       // timeline segment linked to the hovered number

        // UI components (built in setupMenu)
        this.timeline = new CScriptTimelineWidget(this);
        this.editor = new CScriptEditorWindow(this);
    }

    // -----------------------------------------------------------------------
    // SCRIPT MODEL  (parse + queries — the language lives in scriptedVideo/)
    // -----------------------------------------------------------------------

    getScriptText() { return this.editor.getText(); }

    parse() {
        const r = parseScript(this.getScriptText());
        this.events = r.events;
        this.cameraBeats = r.cameraBeats;
        this.totalDuration = r.totalDuration;
        this.parseErrors = r.errors;
        this._numLanes = r.numLanes;
        this._saveScript();
        return r.errors;
    }

    // Persist the script to localStorage, debounced — parse() runs on every keystroke
    // and there's no need to write the whole script each time.
    _saveScript() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            try { localStorage.setItem(STORAGE_KEY, this.getScriptText()); } catch (e) { /* ignore */ }
        }, 400);
    }

    // map a scripted-time t (seconds) to a fractional sitch frame
    sitFrameAt(t) {
        const frames = (Sit && Sit.frames) ? Sit.frames : 1;
        if (this.totalDuration <= 0) return 0;
        const progress = clamp(t / this.totalDuration, 0, 1);
        return clamp(progress * (frames - 1), 0, frames - 1);
    }

    // which friendly view name is active at time t
    activeViewAt(t) { return activeViewAt(this.events, this.defaultView, t); }

    // the current timed event on a (1-based) script line, or null
    _eventOnLine(line1) {
        if (!this.events) return null;
        return this.events.find((e) => e.line === line1 && e.dur > 0) || null;
    }

    // any event on a (1-based) script line (incl. zero-duration view lines), or null
    _anyEventOnLine(line1) {
        if (!this.events) return null;
        return this.events.find((e) => e.line === line1) || null;
    }

    // the duration number token of an event, as an editor hover descriptor
    _durTokenForEvent(e) {
        const s = e && e.spans && e.spans.dur;
        if (!s) return null;
        const lt = (this.getScriptText().split("\n")[e.line - 1]) || "";
        return {line: e.line - 1, start: s.start, end: s.end, text: lt.slice(s.start, s.end)};
    }

    // -----------------------------------------------------------------------
    // CAMERA  (computation lives in ScriptCameraEngine.js)
    // -----------------------------------------------------------------------

    // Capture per-beat params and start/end poses. Must be called after parse and
    // before preview/render so the cameras' "current" pose is the start point.
    prepare() { prepareEvents(this.events, this.defaultView, (t) => this.sitFrameAt(t)); }

    // Compute {camId, pose} at scripted time t. Returns null if no camera beats.
    computeCamera(t) { return computeCamera(this.cameraBeats, t, (tt) => this.sitFrameAt(tt)); }

    // apply the scripted camera for time t. We only drive mainCamera; lookCamera is
    // left to its own controllers so the look view stays matched to the witness video.
    applyCameraForTime(t) {
        const r = this.computeCamera(t);
        if (!r || r.camId !== "mainCamera") return;
        const camNode = NodeMan.get(r.camId, false);
        if (camNode && camNode.camera) applyPoseToCam(camNode, r.pose);
    }

    // -----------------------------------------------------------------------
    // TEXT OVERLAY (drawn directly to a 2D context, same for live & render)
    // -----------------------------------------------------------------------

    _drawTexts(ctx, w, h, t) {
        // collect captions active at t (stack multiple concurrent ones upward)
        const active = [];
        for (const e of this.events) {
            if (e.type !== "text" || !e.text) continue;
            if (t < e.start || t > e.start + e.dur) continue;
            const fade = 0.5;
            const upRamp = Math.min(1, (t - e.start) / fade);
            const dnRamp = Math.min(1, (e.start + e.dur - t) / fade);
            const alpha = clamp(Math.min(upRamp, dnRamp), 0, 1);
            if (alpha > 0) active.push({e, alpha});
        }
        const px = Math.round(h * 0.055);
        const lineH = px * 1.3;
        active.forEach(({e, alpha}, idx) => {
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.font = `bold ${px}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const x = w * 0.5, y = h * 0.85 - (active.length - 1 - idx) * lineH;
            ctx.lineWidth = Math.max(2, px * 0.14);
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.lineJoin = "round";
            ctx.strokeText(e.text, x, y);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(e.text, x, y);
            ctx.restore();
        });
    }

    // -----------------------------------------------------------------------
    // LIVE PREVIEW
    // -----------------------------------------------------------------------

    _ensureOverlayCanvas() {
        if (this._overlayCanvas) return this._overlayCanvas;
        const c = document.createElement("canvas");
        c.style.position = "fixed";
        c.style.pointerEvents = "none";
        c.style.zIndex = "1002";
        document.body.appendChild(c);
        this._overlayCanvas = c;
        return c;
    }

    _layoutOverlayCanvas() {
        const c = this._overlayCanvas;
        if (!c) return;
        const content = document.getElementById("Content");
        const base = content ? content.getBoundingClientRect() : {left: 0, top: 0};
        let left, top, w, h;
        if (this._previewBox) {
            // match the 16:9 preview box so captions land where the render puts them
            left = base.left + this._previewBox.left; top = base.top + this._previewBox.top;
            w = this._previewBox.bw; h = this._previewBox.bh;
        } else {
            const r = content ? content.getBoundingClientRect()
                : {left: 0, top: 0, width: window.innerWidth, height: window.innerHeight};
            left = r.left; top = r.top; w = r.width; h = r.height;
        }
        c.style.left = left + "px"; c.style.top = top + "px";
        c.style.width = w + "px"; c.style.height = h + "px";
        if (c.width !== Math.round(w)) c.width = Math.round(w);
        if (c.height !== Math.round(h)) c.height = Math.round(h);
    }

    // a centred box inside #Content with the render's aspect (16:9), so the preview
    // composition matches the exported video
    _computePreviewBox() {
        const content = document.getElementById("Content");
        const W = content ? content.clientWidth : window.innerWidth;
        const H = content ? content.clientHeight : window.innerHeight;
        const ar = this.outW / this.outH;
        let bw, bh;
        if (W / H > ar) { bh = H; bw = Math.round(H * ar); } else { bw = W; bh = Math.round(W / ar); }
        return {W, H, bw, bh, left: Math.round((W - bw) / 2), top: Math.round((H - bh) / 2)};
    }

    // Show ONLY the active view, sized to the 16:9 preview box (matches the render
    // layout) instead of filling the whole (often non-16:9) window.
    _setPreviewView(viewId) {
        const box = this._computePreviewBox();
        this._previewBox = box;
        for (const vid of ["mainView", "lookView"]) {
            const v = NodeMan.get(vid, false);
            if (!v) continue;
            if (vid === viewId) {
                v.setVisible(true);
                v.left = box.left / box.W; v.top = box.top / box.H;
                v.width = box.bw / box.W; v.height = box.bh / box.H;
                v.updateWH();
            } else {
                v.setVisible(false);
            }
        }
        ViewMan.fullscreenView = null;
        ViewMan.computeEffectiveVisibility();
        ViewMan.updateDOMVisibility();
        this._layoutOverlayCanvas();
    }

    // disable the things that would fight our scripted camera, return a restore fn.
    // NOTE: we only take over mainCamera. lookCamera stays native so the "look" view
    // keeps showing the real witness footage matched to its own camera controllers.
    _enterScriptedMode() {
        const disabledControllers = [];
        const savedVisible = {};
        const savedPreRender = {};
        const camIds = ["mainCamera"];
        for (const camId of camIds) {
            const camNode = NodeMan.get(camId, false);
            if (!camNode) continue;
            camNode.unlockCelestial?.();
            if (camNode.inputs) {
                for (const k in camNode.inputs) {
                    const inp = camNode.inputs[k];
                    if (inp && inp.isController && inp.enabled) { disabledControllers.push(inp); inp.enabled = false; }
                }
            }
        }
        // Disable 3D-tiles cross-fade. Its dithered LOD transition (fadeDuration)
        // is designed to be smoothed out by per-frame settling; during a continuous
        // scripted camera move (where we don't fully settle every frame for speed)
        // it is perpetually mid-fade, which shows as a flickering stipple in the
        // background. fadeDuration 0 makes LOD swaps instant (clean) instead.
        const fadeRestores = [];
        for (const entry of Object.values(NodeMan.list)) {
            const n = entry.data;
            if (n && n.fadePlugin && typeof n.fadePlugin.fadeDuration === "number") {
                fadeRestores.push([n.fadePlugin, n.fadePlugin.fadeDuration]);
                n.fadePlugin.fadeDuration = 0;
            }
        }

        // Only mainView is camera-scripted; lookView renders natively (witness match).
        const viewIds = ["mainView"];
        const savedControls = [];
        for (const viewId of viewIds) {
            const view = NodeMan.get(viewId, false);
            if (!view) continue;
            savedVisible[viewId] = view.visible;
            savedPreRender[viewId] = view.preRenderFunction;
            // re-apply our scripted camera right before this view renders
            view.preRenderFunction = () => this.applyCameraForTime(this._currentT);
            if (view.controls) { savedControls.push([view, view.controls.enabled]); view.controls.enabled = false; }
        }
        // we still toggle visibility of both views, save lookView's
        const lookV = NodeMan.get("lookView", false);
        if (lookV) savedVisible["lookView"] = lookV.visible;
        const savedFullscreen = ViewMan.fullscreenView;

        return () => {
            for (const inp of disabledControllers) inp.enabled = true;
            for (const viewId of viewIds) {
                const view = NodeMan.get(viewId, false);
                if (!view) continue;
                // restore verbatim — CNodeView3D always has a preRenderFunction, and
                // substituting our own empty fn would change the view's default behaviour
                view.preRenderFunction = savedPreRender[viewId];
                if (savedVisible[viewId] !== undefined) view.setVisible(savedVisible[viewId]);
            }
            if (lookV && savedVisible["lookView"] !== undefined) lookV.setVisible(savedVisible["lookView"]);
            for (const [view, en] of savedControls) if (view.controls) view.controls.enabled = en;
            for (const [fp, d] of fadeRestores) fp.fadeDuration = d;
            ViewMan.fullscreenView = savedFullscreen;
            ViewMan.computeEffectiveVisibility();
            ViewMan.updateDOMVisibility();
        };
    }

    // Fully exit preview AND scrub mode. Preview, scrub, and render each save/restore
    // overlapping state (controllers, views, paused, subdivision, bottom timeline), so
    // entering one while another is active would stack restore closures out of order —
    // always reconcile through here before entering a mode.
    _exitAllModes() {
        if (this._previewing) this.stopPreview();
        if (this._scrubbing) this._scrubExit();
    }

    startPreview() {
        this._exitAllModes();
        this.parse();
        this.prepare();
        if (this.totalDuration <= 0) { this.setStatus("Nothing to preview (no timed commands)."); return; }

        this._previewing = true;
        this._savedPaused = par.paused;
        par.paused = true;
        this._restore = this._enterScriptedMode();
        // Freeze terrain LOD during preview too, so the background doesn't flicker
        // as the camera moves (it keeps whatever detail is already loaded).
        const tu = NodeMan.get("terrainUI", false);
        this._previewSavedSubdiv = tu ? tu.disableDynamicSubdivision : undefined;
        if (tu) tu.disableDynamicSubdivision = true;
        this._ensureOverlayCanvas();
        this.timeline.showBottomStrip();   // scripted timeline replaces the normal frame slider
        this._activeViewId = null;
        this._previewBox = null;
        // remember the views' on-screen rects + visibility so we can restore them
        this._savedViewRects = ["mainView", "lookView"].map(vid => {
            const v = NodeMan.get(vid, false);
            if (!v) return null;
            return {v, left: v.left, top: v.top, width: v.width, height: v.height, visible: v.visible};
        }).filter(Boolean);

        this._previewStart = performance.now();
        const tick = () => {
            if (!this._previewing) return;
            // while dragging the playhead, hold the clock at the dragged position
            if (this.timeline._tlDragging) {
                this._previewStart = performance.now() - this._currentT * 1000;
                this._previewRAF = requestAnimationFrame(tick);
                return;
            }
            let t = (performance.now() - this._previewStart) / 1000;
            if (t >= this.totalDuration) t = this.totalDuration;
            this._currentT = t;

            // advance the world
            const sf = this.sitFrameAt(t);
            par.frame = sf;
            GlobalDateTimeNode?.update(sf);

            // switch the on-screen view if needed
            const vName = this.activeViewAt(t);
            const viewId = VIEW_MAP[vName].viewId;
            if (viewId !== this._activeViewId) { this._activeViewId = viewId; this._setPreviewView(viewId); }

            // position the camera now (preRenderFunction will also re-apply)
            this.applyCameraForTime(t);

            // captions
            this._layoutOverlayCanvas();
            const oc = this._overlayCanvas;
            const octx = oc.getContext("2d");
            octx.clearRect(0, 0, oc.width, oc.height);
            this._drawTexts(octx, oc.width, oc.height, t);

            this.timeline.draw();
            setRenderOne(true);

            if (t >= this.totalDuration) { this.stopPreview(); return; }
            this._previewRAF = requestAnimationFrame(tick);
        };
        this._previewRAF = requestAnimationFrame(tick);
        this.setStatus(`Previewing… ${this.totalDuration.toFixed(1)}s`);
    }

    stopPreview() {
        if (!this._previewing) return;
        this._previewing = false;
        if (this._previewRAF) cancelAnimationFrame(this._previewRAF);
        this._previewRAF = null;
        if (this._overlayCanvas) {
            const octx = this._overlayCanvas.getContext("2d");
            octx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
        }
        const tu = NodeMan.get("terrainUI", false);
        if (tu) tu.disableDynamicSubdivision = this._previewSavedSubdiv;
        // restore the views' original rects + visibility (we resized/hid them for the 16:9 box)
        if (this._savedViewRects) {
            for (const r of this._savedViewRects) {
                r.v.left = r.left; r.v.top = r.top; r.v.width = r.width; r.v.height = r.height;
                r.v.setVisible(r.visible);
                r.v.updateWH();
            }
            this._savedViewRects = null;
        }
        this._previewBox = null;
        ViewMan.computeEffectiveVisibility();
        ViewMan.updateDOMVisibility();
        this.timeline.hideBottomStrip();   // restore the normal frame slider
        if (this._restore) { this._restore(); this._restore = null; }
        if (this._savedPaused !== undefined) par.paused = this._savedPaused;
        this._hoverSeg = null; this._hoverNum = null;   // drop any hover from the bottom strip
        setRenderOne(true);
        this.timeline.draw();
        this.setStatus(`Ready — ${this.totalDuration.toFixed(1)}s, ${this.cameraBeats.length} beats`);
    }

    // -----------------------------------------------------------------------
    // OFFLINE RENDER  (1080P60 MP4 — lives in ScriptRenderer.js)
    // -----------------------------------------------------------------------

    async renderVideo() { return renderScriptedVideo(this); }

    // -----------------------------------------------------------------------
    // UI plumbing
    // -----------------------------------------------------------------------

    drawTimeline() { this.timeline.draw(); }
    setStatus(text) { this.editor.setStatus(text); }
    showWindow() { this.editor.show(); }
    hideWindow() { this.editor.hide(); }
    toggleWindow() { this.editor.toggle(); }
    stopAll() { this._exitAllModes(); }

    doParse() {
        const errs = this.parse();
        this.prepare();
        this.timeline.draw();
        this.editor._renderBackdrop();
        if (errs.length) this.setStatus("⚠ " + errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} more)` : ""));
        else this.setStatus(`Ready — ${this.totalDuration.toFixed(1)}s, ${this.cameraBeats.length} beats`);
    }

    // -----------------------------------------------------------------------
    // MENU
    // -----------------------------------------------------------------------

    setupMenu() {
        if (!guiMenus.video) return;
        this.editor.build();
        this.timeline.attachKeyZoom(window);

        const folder = guiMenus.video.addFolder("Scripted Video").close().perm();
        folder.add({ open: () => this.toggleWindow() }, "open").name("Script Window…").perm()
            .tooltip("Open/close the in-page Scripted Video script editor window.");
        folder.add({ pop: () => this.editor.openExternalWindow() }, "pop").name("Script Window (New Window)").perm()
            .tooltip("Open the script editor in a separate browser window (drag it to another monitor).");
        folder.add({ render: () => this.renderVideo() }, "render").name("Render Video (1080P60)").perm();

        // --- quality knobs ---
        const q = folder.addFolder("Render Quality").close().perm();
        q.add(this, "waitForLoading").name("Wait For Terrain").perm()
            .tooltip("ON (default) = settle each frame so terrain is stable & correct (no pop or edge-tile toggling), slower. OFF = fast/rough render, terrain may pop.");
        q.add(this, "terrainDetail", 0.25, 1, 0.05).name("Terrain Detail").perm()
            .tooltip("Terrain LOD detail. Lower loads far fewer tiles → much faster render, slightly coarser terrain. 1 = full detail.");
        q.add(this, "motionBlurSamples", 1, 16, 1).name("Motion Blur").perm()
            .tooltip("Optional cinematic motion blur: sub-frames averaged per output frame. 1 = off.");
        q.add(this, "superSample", 1, 3, 1).name("Super-sample").perm()
            .tooltip("Render at NxN resolution then downscale (extra anti-aliasing). Higher = crisper, much slower.");

        // initial parse so the timeline shows immediately (no prepare() here:
        // the scene/Sit may not exist yet at menu-build time — prepare() runs
        // on Parse/Preview/Render, once a sitch is loaded)
        this.parse();
        setTimeout(() => this.timeline.draw(), 0);
    }

    // -----------------------------------------------------------------------
    // SCRUB  (cursor-line / timeline-click → position the preview at that time)
    // -----------------------------------------------------------------------

    // Map the script editor's cursor line to its event time and scrub there.
    _scrubToCursorLine() {
        const lineNo = this.editor.cursorLine1();
        if (lineNo < 0) return;
        this.parse(); this.prepare();
        if (this.totalDuration <= 0) return;
        let best = null;
        for (const e of this.events) {
            if (e.line !== undefined && e.line <= lineNo && (!best || e.line > best.line)) best = e;
        }
        this._scrubTo(best ? best.start : 0);
    }

    // Scrub the timeline + viewport to scripted time t. While playing a preview this
    // re-anchors the clock; otherwise it enters a paused "scrub" mode that shows the
    // scripted camera/world/captions at t (and swaps in the scripted timeline).
    _scrubTo(t) {
        if (this.totalDuration <= 0) return;
        // reconcile against the (possibly just-shrunk) total so a wheel-edit of a late
        // beat during playback can't push the clock past the end and auto-stop preview
        t = clamp(t, 0, this.totalDuration);
        if (this._previewing) {
            if (t >= this.totalDuration) t = Math.max(0, this.totalDuration - 1e-3);
            this._previewStart = performance.now() - t * 1000;  // re-anchor running clock
        } else {
            this.parse(); this.prepare();
            if (!this._scrubbing) this._scrubEnter();
        }
        this._currentT = t;
        par.frame = this.sitFrameAt(t);
        GlobalDateTimeNode?.update(par.frame);
        this.applyCameraForTime(t);
        if (this._overlayCanvas) {
            this._layoutOverlayCanvas();
            const octx = this._overlayCanvas.getContext("2d");
            octx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
            this._drawTexts(octx, this._overlayCanvas.width, this._overlayCanvas.height, t);
        }
        setRenderOne(true);
        this.timeline.draw();
    }

    _scrubEnter() {
        this._scrubbing = true;
        this._scrubSavedPaused = par.paused;
        par.paused = true;
        this._scrubRestore = this._enterScriptedMode();
        const tu = NodeMan.get("terrainUI", false);
        this._scrubSavedSubdiv = tu ? tu.disableDynamicSubdivision : undefined;
        if (tu) tu.disableDynamicSubdivision = true;
        this._ensureOverlayCanvas();
        this.timeline.showBottomStrip();
    }

    _scrubExit() {
        if (!this._scrubbing) return;
        this._scrubbing = false;
        if (this._overlayCanvas) {
            const octx = this._overlayCanvas.getContext("2d");
            octx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
        }
        const tu = NodeMan.get("terrainUI", false);
        if (tu) tu.disableDynamicSubdivision = this._scrubSavedSubdiv;
        this.timeline.hideBottomStrip();
        if (this._scrubRestore) { this._scrubRestore(); this._scrubRestore = null; }
        if (this._scrubSavedPaused !== undefined) par.paused = this._scrubSavedPaused;
        setRenderOne(true);
        this.timeline.draw();
    }
}

// module-scope singleton
let scriptedVideo = null;

export function addScriptedVideoMenu() {
    if (scriptedVideo) return scriptedVideo;
    try {
        scriptedVideo = new CScriptedVideoManager();
        scriptedVideo.setupMenu();
        Globals.scriptedVideo = scriptedVideo;
    } catch (e) {
        console.error("addScriptedVideoMenu failed:", e);
        Globals.scriptedVideoError = (e && e.stack) ? e.stack : String(e);
    }
    return scriptedVideo;
}

// --- custom-sitch serialization (called from CustomManagerSerialize.js) ---
// The script travels with the saved sitch, so a shared/reloaded sitch carries
// its scripted video. Returns null when there's nothing worth saving (no manager,
// or the editor still holds the unmodified demo script).
export function serializeScriptedVideo() {
    if (!scriptedVideo) return null;
    const script = scriptedVideo.getScriptText();
    if (!script || script === DEFAULT_SCRIPT) return null;
    return {script};
}

export function deserializeScriptedVideo(data) {
    if (!scriptedVideo || !data || typeof data.script !== "string") return;
    const ta = scriptedVideo.editor.textarea;
    if (!ta) return;
    ta.value = data.script;
    scriptedVideo.doParse();
}
