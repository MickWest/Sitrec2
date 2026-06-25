// CScriptedVideo.js
//
// A text-script driven "video" system for Sitrec.
//
// The user writes a JavaScript shot script (with optional flat one-line
// shortcuts like `zoom OE-LNC 6`) in a textarea under the Video > "Scripted
// Video" menu. The commands drive cinematic camera moves (zoom in on an
// object, orbit it, track it, change FOV), cut between views, and overlay
// on-screen text. The whole thing has its own timeline (independent of the sitch frame
// slider) shown as labelled blocks, can be previewed live, and rendered out
// to a 1080P60 MP4 via the existing Mediabunny encoder.
//
// The system is split across src/scriptedVideo/:
//   ScriptCommands.js       command registry — each command's args/prepare/sample
//   ScriptJSRunner.js       JS scheduling kernel (language docs here)
//   ScriptSugar.js          DSL-flavored one-line shortcuts → JS rewriting
//   ScriptJSCallSites.js    event → source-position mapping (wheel edit, errors)
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
import {CustomManager, GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit} from "./Globals";
import {ViewMan} from "./CViewManager";
import {clamp, smooth} from "./scriptedVideo/ScriptMath";
import {VIEW_MAP, layoutForViewEvent, isSettingEvent} from "./scriptedVideo/ScriptCommands";
import {runScriptJS} from "./scriptedVideo/ScriptJSRunner";
import {sitrecAPI} from "./CSitrecAPI";
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
        this._lastLayoutKey = null;      // JSON of the layout currently on-screen during preview
        this._overlayCanvas = null;  // DOM canvas for live caption text

        // hover state SHARED between the editor (number under the mouse) and the
        // timeline widget (segment under the mouse) — each highlights the other
        this._hoverNum = null;       // number token under the mouse in the editor
        this._hoverSeg = null;       // timeline segment linked to the hovered number
        this._selectedEventLine = null;
        this._selectedEventType = null;

        // UI components. The timeline widget persists with the manager; the editor is now a
        // CNodeView (sitch-scoped — disposed on sitch reload), so it is (re)created per sitch in
        // setupMenu rather than once here.
        this.timeline = new CScriptTimelineWidget(this);
        this.editor = null;
    }

    // -----------------------------------------------------------------------
    // SCRIPT MODEL  (parse + queries — the language lives in scriptedVideo/)
    // -----------------------------------------------------------------------

    getScriptText() { return this.ensureEditor().getText(); }

    // Run the script's scheduling pass and commit the resulting model. Async
    // because the script is JS (executed once, record-only, virtual clock) —
    // but it resolves in microtasks, so it completes before any timer/RAF
    // callback queued in the same tick. Latest-run-wins: a parse superseded by
    // a newer one (keystrokes) never commits a stale model.
    async parse() {
        const seq = (this._parseSeq = (this._parseSeq || 0) + 1);
        // VideoOverlay is a dynamic pseudo-preset (look view sized to the witness
        // video's aspect, video stacked on top) resolved in _resolveLayout
        const r = await runScriptJS(this.getScriptText(),
            {viewPresets: {...((CustomManager && CustomManager.viewPresets) || {}), VideoOverlay: {}}});
        if (seq !== this._parseSeq) return this.parseErrors;
        // A half-typed JS line is a syntax error on every keystroke: keep showing
        // the last good timeline, just surface the error (and still save the text).
        if (!r.events.length && this.events.length && r.errors.some((m) => m.startsWith("syntax error"))) {
            this.parseErrors = r.errors;
            this._saveScript();
            return r.errors;
        }
        this.events = r.events;
        this.cameraBeats = r.cameraBeats;
        this.totalDuration = r.totalDuration;
        this.parseErrors = r.errors;
        this._numLanes = r.numLanes;
        // validate set/show/hide targets against the live menus (the runner is
        // pure and can't) — bad paths get a line-tagged error and are skipped
        for (const e of this.events) {
            if (!isSettingEvent(e) || e.invalid) continue;
            const res = sitrecAPI._resolveControl(e.menu, e.path);
            if (!res.success) {
                e.invalid = true;
                this.parseErrors.push(`line ${e.line}: ${res.error}`);
            }
        }
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

    // the view event active at time t (last view cut at or before t), or null
    _activeViewEventAt(t) {
        let ev = null;
        for (const e of this.events) {
            if (e.type === "view" && e.start <= t + 1e-6) ev = e;
        }
        return ev;
    }

    // The witness video's aspect, fit ("contain") inside the output frame —
    // look view sized to the video aspect with the video stacked on top of it
    // (insertion order = draw order, so video composites over the look view).
    _videoOverlayLayout() {
        const vd = NodeMan.get("video", false)?.videoData;
        const frameAR = this.outW / this.outH;
        const ar = (vd && vd.videoWidth && vd.videoHeight) ? vd.videoWidth / vd.videoHeight : frameAR;
        let left = 0, top = 0, width = 1, height = 1;
        if (ar < frameAR) { width = ar / frameAR; left = (1 - width) / 2; }
        else if (ar > frameAR) { height = frameAR / ar; top = (1 - height) / 2; }
        return {
            lookView: {left, top, width, height},
            video: {left, top, width, height},
        };
    }

    // resolve one view event to a layout (dynamic pseudo-presets first)
    _resolveLayout(e) {
        if (e && e.preset === "VideoOverlay") return this._videoOverlayLayout();
        const layout = layoutForViewEvent(e, CustomManager && CustomManager.viewPresets);
        return layout && Object.keys(layout).length ? layout
            : {[VIEW_MAP[this.defaultView].viewId]: {left: 0, top: 0, width: 1, height: 1}};
    }

    // The concrete layout at time t: {viewId: {left,top,width,height}} with rects
    // as fractions of the output frame. Resolves single views, named presets
    // (CustomManager.viewPresets, looked up live), explicit layout objects, and
    // dynamic pseudo-presets; falls back to the default view full-frame. A view
    // event with a duration is an animated transition: rects tween from the
    // previous layout, views being left behind hold their rect (drawn on top)
    // until the transition completes.
    activeLayoutAt(t) {
        const evs = [];
        for (const e of this.events) {
            if (e.type === "view" && e.start <= t + 1e-6) evs.push(e);
        }
        const cur = evs[evs.length - 1] || null;
        const L1 = this._resolveLayout(cur);
        if (cur && cur.dur > 0 && t < cur.start + cur.dur) {
            const L0 = this._resolveLayout(evs[evs.length - 2] || null);
            const f = smooth(clamp((t - cur.start) / cur.dur, 0, 1));
            const out = {};
            for (const id of Object.keys(L1)) {
                const a = L0[id] || L1[id];   // not in the old layout → appears in place
                const b = L1[id];
                out[id] = {
                    left: a.left + (b.left - a.left) * f,
                    top: a.top + (b.top - a.top) * f,
                    width: a.width + (b.width - a.width) * f,
                    height: a.height + (b.height - a.height) * f,
                };
            }
            for (const id of Object.keys(L0)) {
                if (!out[id]) out[id] = {...L0[id]};   // leaving views hold (drawn on top)
            }
            return out;
        }
        return L1;
    }

    // scripted opacity of a view at time t — fade events chain; 1 if untouched
    viewOpacityAt(viewId, t) {
        const fades = this.events.filter((e) => e.type === "fade" && e.viewId === viewId)
            .sort((a, b) => a.start - b.start);
        let val = 1;
        for (const e of fades) {
            if (t >= e.start + e.dur - 1e-6) { val = e.to; continue; }
            if (t >= e.start - 1e-6) {
                const f = smooth(clamp((t - e.start) / Math.max(e.dur, 1e-6), 0, 1));
                return val + (e.to - val) * f;
            }
            break;
        }
        return val;
    }

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

    selectEvent(e) {
        this._selectedEventLine = e && e.line ? e.line : null;
        this._selectedEventType = e && e.type ? e.type : null;
        this.editor?.updateSelectionDetails();
        this.editor?._renderBackdrop();
        this.timeline?.draw();
    }

    selectedEvent() {
        if (!this._selectedEventLine || !this.events) return null;
        return this.events.find((e) => e.line === this._selectedEventLine
            && (!this._selectedEventType || e.type === this._selectedEventType))
            || this.events.find((e) => e.line === this._selectedEventLine)
            || null;
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

    // Apply the menu settings in effect at scripted time t: for each touched
    // control, the latest set/show/hide at or before t — or its pre-preview
    // snapshot if none has fired yet (so scrubbing backwards un-does them).
    // Only actually calls the API when a value changes (onChange can be costly).
    applySettingsForTime(t) {
        if (!this._settingEvents || this._settingEvents.length === 0) return;
        const want = new Map(this._settingSnapshots);
        for (const e of this._settingEvents) {
            if (!e.invalid && e.start <= t + 1e-6) {
                want.set(e._key, {menu: e.menu, path: e.path, value: e.value});
            }
        }
        for (const [key, s] of want) {
            if (this._appliedSettings.get(key) !== s.value) {
                this._appliedSettings.set(key, s.value);
                sitrecAPI._setMenuValue(s.menu, s.path, s.value);
            }
        }
    }

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

    // forceLine (1-based, preview-only): a text event on that script line is drawn
    // at full alpha even mid-fade or outside its window — so a paused preview with
    // the edit cursor on a caption line always shows that caption. The renderer
    // never passes it, so exported fades are untouched.
    _drawTexts(ctx, w, h, t, forceLine = -1) {
        // collect captions active at t (stack multiple concurrent ones upward)
        const active = [];
        for (const e of this.events) {
            if (e.type !== "text" || !e.text) continue;
            const forced = e.line === forceLine;
            if (!forced && (t < e.start || t > e.start + e.dur)) continue;
            const fade = 0.5;
            const upRamp = Math.min(1, (t - e.start) / fade);
            const dnRamp = Math.min(1, (e.start + e.dur - t) / fade);
            const alpha = forced ? 1 : clamp(Math.min(upRamp, dnRamp), 0, 1);
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

    // Apply a scripted layout ({viewId: rect}, rects as fractions of the output
    // frame) inside the 16:9 preview box — single views fill it, presets and
    // custom layouts subdivide it, everything else is hidden (matches the render).
    _applyPreviewLayout(layout) {
        const box = this._computePreviewBox();
        this._previewBox = box;
        // hide every root view not in the layout. Overlay children follow parents.
        this._previewHidden = this._previewHidden || [];
        ViewMan.iterate((vid, v) => {
            if (vid === "scriptEditor") return;   // the editor window stays open (and on top) during preview
            if (layout[vid]) return;
            if (v.overlayView && !v.separateVisibility) return;
            if (v.visible && typeof v.setVisible === "function") {
                // mainView/lookView restore via _savedViewRects; track the rest
                if (vid !== "mainView" && vid !== "lookView" && !this._previewHidden.includes(v)) {
                    this._previewHidden.push(v);
                }
                v.setVisible(false);
            }
        });
        for (const [vid, r] of Object.entries(layout)) {
            const v = NodeMan.get(vid, false);
            if (!v) continue;
            // first touch of a view outside the startPreview snapshot (e.g. the
            // video view): save its rect + visibility so stopPreview restores it
            if (this._savedViewRects && !this._savedViewRects.some((s) => s.v === v)) {
                this._savedViewRects.push({v, left: v.left, top: v.top, width: v.width, height: v.height,
                    visible: v.visible, z: v.div ? v.div.style.zIndex : undefined});
            }
            v.setVisible(true);
            v.left = (box.left + r.left * box.bw) / box.W;
            v.top = (box.top + r.top * box.bh) / box.H;
            v.width = (r.width * box.bw) / box.W;
            v.height = (r.height * box.bh) / box.H;
            v.updateWH();
        }
        // layout order = stacking order (e.g. VideoOverlay draws video over the
        // look view): scriptZ is a sort key ViewMan.updateZOrder respects
        let zi = 1;
        for (const vid of Object.keys(layout)) {
            const v = NodeMan.get(vid, false);
            if (v) v.scriptZ = zi++;
        }
        ViewMan.fullscreenView = null;
        ViewMan.computeEffectiveVisibility();
        ViewMan.updateDOMVisibility();
        ViewMan.updateZOrder();
        this._layoutOverlayCanvas();
    }

    // drive scripted view opacity (the fade command) on the previewed views
    _applyViewOpacities(layout, t) {
        if (!this._fadeTouched) this._fadeTouched = new Set();
        for (const vid of Object.keys(layout)) {
            const v = NodeMan.get(vid, false);
            if (!v || !v.div) continue;
            const o = this.viewOpacityAt(vid, t);
            if (o < 1 || this._fadeTouched.has(vid)) {
                this._fadeTouched.add(vid);
                v.div.style.opacity = o >= 1 ? "" : String(o);
            }
        }
    }

    // disable the things that would fight our scripted camera, return a restore fn.
    // NOTE: we only take over mainCamera. lookCamera stays native so the "look" view
    // keeps showing the real witness footage matched to its own camera controllers.
    _enterScriptedMode() {
        // Snapshot every menu setting the script touches (set/show/hide) so a
        // scripted change never permanently mutates the sitch. _appliedSettings
        // caches what's currently applied so applySettingsForTime() only calls
        // the (onChange-running) API when a value actually changes.
        this._settingEvents = this.events
            .filter((e) => isSettingEvent(e) && !e.invalid)
            .sort((a, b) => a.start - b.start);
        this._settingSnapshots = new Map();
        this._appliedSettings = new Map();
        for (const e of this._settingEvents) {
            e._key = (e.menu || "") + " " + e.path;
            if (!this._settingSnapshots.has(e._key)) {
                const r = sitrecAPI._getMenuValue(e.menu, e.path);
                if (r.success) this._settingSnapshots.set(e._key, {menu: e.menu, path: e.path, value: r.value});
                else e.invalid = true;
            }
        }

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
            // put back every menu setting the script changed
            for (const s of this._settingSnapshots.values()) {
                sitrecAPI._setMenuValue(s.menu, s.path, s.value);
            }
            this._settingSnapshots = new Map();
            this._appliedSettings = new Map();
            this._settingEvents = [];
            ViewMan.fullscreenView = savedFullscreen;
            ViewMan.computeEffectiveVisibility();
            ViewMan.updateDOMVisibility();
        };
    }

    // Fully exit preview mode. Preview and render each save/restore overlapping
    // state (controllers, views, paused, subdivision, bottom timeline), so
    // entering one while another is active would stack restore closures out of
    // order — always reconcile through here before entering a mode.
    _exitAllModes() {
        if (this._previewing) this.stopPreview();
    }

    // Start the preview at startAt seconds; startPaused = true enters it holding
    // (the scrub path: whenever the scripted timeline is visible we ARE in
    // preview mode, just possibly paused).
    async startPreview(startAt = 0, startPaused = false) {
        this._exitAllModes();
        await this.parse();
        this.prepare();
        if (this.totalDuration <= 0) { this.setStatus("Nothing to preview (no timed commands)."); return; }

        this._previewing = true;
        this._previewPaused = !!startPaused;
        this._lastActiveLineKey = null;
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
        this._lastLayoutKey = null;      // first tick always applies the layout
        this._fadeTouched = new Set();   // views whose DOM opacity we've scripted
        this._previewBox = null;
        // remember the views' on-screen rects + visibility so we can restore them
        this._savedViewRects = ["mainView", "lookView"].map(vid => {
            const v = NodeMan.get(vid, false);
            if (!v) return null;
            return {v, left: v.left, top: v.top, width: v.width, height: v.height,
                visible: v.visible, z: v.div ? v.div.style.zIndex : undefined};
        }).filter(Boolean);

        this._currentT = clamp(startAt, 0, Math.max(0, this.totalDuration - 1e-3));
        this._previewStart = performance.now() - this._currentT * 1000;
        this._lastTickT = null;
        const tick = () => {
            if (!this._previewing) return;
            // while dragging the playhead (or paused via space), hold the clock —
            // but still run one full update pass for the held time (so the right
            // view shows even if we paused before the first tick, and dragging
            // while paused updates the picture), then idle until t changes.
            const held = this.timeline._tlDragging || this._previewPaused;
            // while paused, the caption on the edit cursor's line is forced visible
            const forceLine = this._previewPaused ? this.editor.cursorLine1() : -1;
            let t;
            if (held) {
                this._previewStart = performance.now() - this._currentT * 1000;
                t = this._currentT;
                if (t === this._lastTickT && forceLine === this._lastForceLine) {
                    this._previewRAF = requestAnimationFrame(tick);
                    return;
                }
            } else {
                t = (performance.now() - this._previewStart) / 1000;
                if (t >= this.totalDuration) t = this.totalDuration;
                this._currentT = t;
            }
            this._lastTickT = t;
            this._lastForceLine = forceLine;

            // advance the world
            const sf = this.sitFrameAt(t);
            par.frame = sf;
            GlobalDateTimeNode?.update(sf);
            this.applySettingsForTime(t);

            // apply the on-screen layout whenever it changes (cuts AND animated
            // transitions, which produce a new blended layout every frame)
            const layout = this.activeLayoutAt(t);
            const lkey = JSON.stringify(layout);
            if (lkey !== this._lastLayoutKey) {
                this._lastLayoutKey = lkey;
                this._applyPreviewLayout(layout);
            }
            this._applyViewOpacities(layout, t);

            // position the camera now (preRenderFunction will also re-apply)
            this.applyCameraForTime(t);

            // captions
            this._layoutOverlayCanvas();
            const oc = this._overlayCanvas;
            const octx = oc.getContext("2d");
            octx.clearRect(0, 0, oc.width, oc.height);
            this._drawTexts(octx, oc.width, oc.height, t, forceLine);

            this.timeline.draw();
            setRenderOne(true);

            // refresh the editor's yellow current-time line highlight when it changes
            const lk = this._activeLineKey(t);
            if (lk !== this._lastActiveLineKey) {
                this._lastActiveLineKey = lk;
                this.editor._renderBackdrop();
            }

            if (!held && t >= this.totalDuration) { this.stopPreview(); return; }
            this._previewRAF = requestAnimationFrame(tick);
        };
        this._previewRAF = requestAnimationFrame(tick);
        this.setStatus(startPaused
            ? `Preview paused at ${this._currentT.toFixed(1)}s (space to play)`
            : `Previewing… ${this.totalDuration.toFixed(1)}s`);
    }

    // Space bar during preview (routed here by KeyBoardHandler): pause/resume.
    // The sim's own pause state is untouched — the script owns the clock.
    togglePreviewPause() {
        if (!this._previewing) return;
        this._previewPaused = !this._previewPaused;
        this.setStatus(this._previewPaused
            ? `Preview paused at ${this._currentT.toFixed(1)}s (space to play)`
            : `Previewing… ${this.totalDuration.toFixed(1)}s`);
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
        const rectRestored = new Set((this._savedViewRects || []).map((r) => r.v));
        if (this._savedViewRects) {
            for (const r of this._savedViewRects) {
                r.v.left = r.left; r.v.top = r.top; r.v.width = r.width; r.v.height = r.height;
                r.v.setVisible(r.visible);
                if (r.z !== undefined && r.v.div) r.v.div.style.zIndex = r.z;
                r.v.updateWH();
            }
            this._savedViewRects = null;
        }
        // clear any scripted view opacities (fade command)
        if (this._fadeTouched) {
            for (const vid of this._fadeTouched) {
                const v = NodeMan.get(vid, false);
                if (v && v.div) v.div.style.opacity = "";
            }
            this._fadeTouched = null;
        }
        // drop the scripted stacking order
        ViewMan.iterate((id, v) => { if (v.scriptZ) v.scriptZ = 0; });
        ViewMan.updateZOrder();
        // re-show the other root views (e.g. witness video) we hid for the preview;
        // a rect snapshot is authoritative, so skip views it already restored
        if (this._previewHidden) {
            for (const v of this._previewHidden) if (!rectRestored.has(v)) v.setVisible(true);
            this._previewHidden = null;
        }
        this._previewBox = null;
        ViewMan.computeEffectiveVisibility();
        ViewMan.updateDOMVisibility();
        this.timeline.hideBottomStrip();   // restore the normal frame slider
        if (this._restore) { this._restore(); this._restore = null; }
        if (this._savedPaused !== undefined) par.paused = this._savedPaused;
        this._hoverSeg = null; this._hoverNum = null;   // drop any hover from the bottom strip
        this._lastActiveLineKey = null;
        this.editor._renderBackdrop();                  // clear the current-time line highlight
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
    setStatus(text) { this.editor?.setStatus(text); }
    showWindow() { this.ensureEditor().show(); }
    hideWindow() { this.editor?.hide(); }
    toggleWindow() { this.ensureEditor().toggle(); }

    // The editor is a CNodeView, so it's disposed when the sitch reloads. Recreate it lazily
    // (registering a fresh 'scriptEditor' view, content built in its constructor) whenever it's
    // missing or has been disposed — the persistent manager outlives any single sitch.
    ensureEditor() {
        // The editor is a sitch-scoped CNodeView (disposed on reload). Reuse the registered view
        // if present (never double-register the id), (re)wire this manager into it, and build its
        // content lazily on first use.
        let ed = ViewMan.get("scriptEditor", false);
        if (!ed) ed = new CScriptEditorWindow(this);
        ed.sv = this;
        if (!ed._content) ed.build();
        this.editor = ed;
        return ed;
    }
    stopAll() { this._exitAllModes(); }

    async doParse() {
        const errs = await this.parse();
        this.prepare();
        this._lastTickT = null;   // model changed → a paused preview tick must re-draw
        this.timeline.draw();
        this.editor._renderBackdrop();
        this.editor.updateSelectionDetails();
        if (errs.length) this.setStatus("⚠ " + errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} more)` : ""));
        else this.setStatus(`Ready — ${this.totalDuration.toFixed(1)}s, ${this.cameraBeats.length} beats`);
    }

    // -----------------------------------------------------------------------
    // MENU
    // -----------------------------------------------------------------------

    setupMenu() {
        if (!guiMenus.video) return;
        // The editor is a CNodeView (disposed on sitch reload), created lazily on first use via
        // ensureEditor() — nothing to build here.
        this.timeline.attachKeyZoom(window);

        const folder = guiMenus.video.addFolder("Scripted Video").close().perm();
        folder.add({ open: () => this.toggleWindow() }, "open").name("Script Window…").perm()
            .tooltip("Open/close the Scripted Video script editor (use its ⧉ header icon to pop it out into a separate window).");
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
    async _scrubToCursorLine() {
        const lineNo = this.editor.cursorLine1();
        if (lineNo < 0) return;
        await this.parse(); this.prepare();
        if (this.totalDuration <= 0) return;
        let best = null;
        for (const e of this.events) {
            if (e.line !== undefined && e.line <= lineNo && (!best || e.line > best.line)) best = e;
        }
        await this._scrubTo(best ? best.start : 0);
    }

    // Scrub the timeline + viewport to scripted time t. The scripted timeline
    // being visible means we are ALWAYS in preview mode: if no preview is
    // running, enter one paused at t — so view layouts (e.g. full-screen video)
    // apply exactly as they do during playback. While previewing, this just
    // re-anchors the clock; the tick applies world/camera/layout/captions for
    // the new time (the held branch runs a full pass whenever t changes).
    async _scrubTo(t) {
        if (!this._previewing) {
            await this.startPreview(t, true);
            return;
        }
        if (this.totalDuration <= 0) return;
        // reconcile against the (possibly just-shrunk) total so a wheel-edit of a late
        // beat during playback can't push the clock past the end and auto-stop preview
        t = clamp(t, 0, this.totalDuration);
        if (t >= this.totalDuration) t = Math.max(0, this.totalDuration - 1e-3);
        this._previewStart = performance.now() - t * 1000;  // re-anchor running clock
        this._currentT = t;
        if (this._previewPaused) this.setStatus(`Preview paused at ${t.toFixed(1)}s (space to play)`);
        this.timeline.draw();
        setRenderOne(true);
    }

    // 1-based script lines "active" at time t — timed events spanning t, plus
    // the view cut in effect — for the editor's yellow current-time highlight.
    _activeLineSet(t) {
        const s = new Set();
        const ve = this._activeViewEventAt(t);
        if (ve && ve.line) s.add(ve.line);
        for (const e of this.events) {
            if (e.dur > 0 && e.line && t >= e.start - 1e-6 && t <= e.start + e.dur + 1e-6) s.add(e.line);
        }
        return s;
    }

    _activeLineKey(t) {
        return [...this._activeLineSet(t)].sort((a, b) => a - b).join(",");
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
