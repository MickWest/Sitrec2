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
// Script language (one command per line, '#' starts a comment):
//
//   view  <main|look>            cut to a view (instant, 0s)
//   text  "caption"  <secs>      overlay caption (does NOT advance the timeline)
//   zoom  <object>   <secs> [m]  dolly the camera in toward an object over <secs>
//   orbit <object>   <secs> [deg]orbit the camera around an object over <secs>
//   track <object>   <secs>      hold position, keep looking at a (moving) object
//   fov   <degrees>  <secs>      change the camera FOV (optical zoom) over <secs>
//   wait  <secs>                 hold the current camera
//
// <object> is a track short-name (e.g. OE-LNC, resolved to node "Track_OE-LNC")
// or a "lat,lon,alt" triple.
//
// The sitch's own playhead advances linearly across the whole scripted
// duration, so the world (e.g. an aircraft flying its track) animates while
// the camera moves.

import {Vector3} from "three";
import {par} from "./par";
import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit} from "./Globals";
import {ViewMan} from "./CViewManager";
import {getLocalUpVector} from "./SphericalMath";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {MediabunnyExporter} from "./MediabunnyExporter";
import {getBestFormatForResolution, getVideoExtension} from "./VideoExporter";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {ExportProgressWidget, getExportPrefix} from "./utils";
import {makeDraggable, blockViewEvents, clampBelowMenuBar} from "./DragResizeUtils";
import {getControlsContainer} from "./PageStructure";

// ---------------------------------------------------------------------------
// small math helpers
const radians = (d) => d * Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }; // smoothstep ease

// map a friendly view name to {viewId, camId}
const VIEW_MAP = {
    main: {viewId: "mainView", camId: "mainCamera"},
    mainview: {viewId: "mainView", camId: "mainCamera"},
    look: {viewId: "lookView", camId: "lookCamera"},
    lookview: {viewId: "lookView", camId: "lookCamera"},
};

const STORAGE_KEY = "sitrec_scripted_video_script";

const DEFAULT_SCRIPT =
`# Scripted Video demo  (Parse, then Preview or Render)
# no & = wait for previous line;  & = start with it;  &N = N s after it
view main
zoom OE-LNC 6
& text "OE-LNC" 4
orbit OE-LNC 9 110
&1 text "tracking inbound" 4
track OE-LNC 4
view look
wait 2`;

// types of command that consume time on the main timeline (the "spine")
const CAMERA_BEATS = new Set(["zoom", "orbit", "track", "fov", "wait"]);

// keys that move the text cursor (used to sync the timeline to the cursor's line)
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

// colours for the timeline blocks, per command
const BEAT_COLORS = {
    zoom: "#3a7bd5", orbit: "#5db04a", track: "#c79a30",
    fov: "#9b59b6", wait: "#555a66", view: "#888888", text: "#d05a8c",
};

// ---------------------------------------------------------------------------

class CScriptedVideoManager {
    constructor() {
        this.events = [];          // all parsed events (camera beats + view + text)
        this.cameraBeats = [];     // just the time-consuming camera beats, in order
        this.totalDuration = 0;    // seconds
        this.defaultView = "main";

        this.outW = 1920;
        this.outH = 1080;
        this.outFps = 60;

        // render quality knobs
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
        this._hoverNum = null;       // number token under the mouse in the editor
        this._hoverSeg = null;       // timeline segment linked to the hovered number

        // dom refs (filled in by setupMenu / buildWindow)
        this.textarea = null;
        this.statusEl = null;
        this.timelineCanvas = null;   // tall timeline in the script window
        this.window = null;           // the floating script-editor window
        this.bottomTimeline = null;   // compact timeline shown in #ControlsBottom during preview
        this._hiddenControls = null;  // saved frame-slider children while replaced

        // timeline view (zoom/scroll)
        this.tlZoom = 1;              // 1 = whole timeline visible; >1 = zoomed in
        this.tlOffset = 0;           // left-edge time (seconds) of the visible window
        this._tlDragging = false;    // dragging the playhead
        this._dragCanvas = null;
    }

    // -----------------------------------------------------------------------
    // SCRIPT PARSING
    // -----------------------------------------------------------------------

    getScriptText() {
        return (this.textarea && this.textarea.value !== undefined)
            ? this.textarea.value : DEFAULT_SCRIPT;
    }

    // split a line into tokens, treating "quoted strings" as one token
    tokenize(line) {
        const out = [];
        const re = /"([^"]*)"|(\S+)/g;
        let m;
        while ((m = re.exec(line)) !== null) {
            out.push(m[1] !== undefined ? m[1] : m[2]);
        }
        return out;
    }

    // Like tokenize() but also returns each token's character span within `line`
    // ({text,start,end}). Used so the parser can record exactly where each editable
    // number lives, enabling number<->timeline-segment cross-highlighting and
    // scroll-wheel duration editing from the timeline.
    tokenizeWithPos(line) {
        const out = [];
        const re = /"([^"]*)"|(\S+)/g;
        let m;
        while ((m = re.exec(line)) !== null) {
            out.push({text: m[1] !== undefined ? m[1] : m[2], start: m.index, end: m.index + m[0].length});
        }
        return out;
    }

    parse() {
        const text = this.getScriptText();
        const events = [];
        const cameraBeats = [];
        // "spine" = the sequential backbone. A line with NO leading & is a spine line
        // and starts when the previous spine line finished. A line WITH a leading & is
        // concurrent and attaches to the current spine line's start:
        //   "&"   → starts at the spine line's start (immediate / parallel)
        //   "&N"  → starts N seconds after the spine line's start
        // Concurrent lines don't advance the spine.
        let spineStart = 0;   // start time of the most recent spine line
        let spineEnd = 0;     // end time of the most recent spine line
        let maxEnd = 0;
        const errors = [];

        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const fullLine = lines[i];
            const hash = fullLine.indexOf("#");
            const body = hash >= 0 ? fullLine.slice(0, hash) : fullLine;
            const leadWS = (body.match(/^\s*/) || [""])[0].length;
            let raw = body.slice(leadWS);
            if (raw.trim().length === 0) continue;

            // leading & concurrency prefix. contentStart = char offset (within the
            // ORIGINAL line) where the command tokens begin, so token spans map back
            // to the textarea text. offSpan = the &N offset number's span (if any).
            let concurrent = false, start, contentStart = leadWS, offSpan = null;
            const amp = raw.match(/^&(\d*\.?\d*)\s*(.*)$/);
            if (amp) {
                concurrent = true;
                const off = amp[1] === "" ? 0 : parseFloat(amp[1]);
                start = spineStart + (isNaN(off) ? 0 : off);
                contentStart = leadWS + (amp[0].length - amp[2].length);
                if (amp[1] !== "") offSpan = {start: leadWS + 1, end: leadWS + 1 + amp[1].length};
                raw = amp[2];
            } else {
                start = spineEnd;   // wait until previous (spine) line completed
            }

            const tokensP = this.tokenizeWithPos(raw)
                .map((t) => ({text: t.text, start: t.start + contentStart, end: t.end + contentStart}));
            const tokens = tokensP.map((t) => t.text);
            if (tokens.length === 0) continue;
            const cmd = tokens[0].toLowerCase();
            const num = (s) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
            // span of token idx, but only if it's a CLEAN numeric token — a malformed
            // token like "4hen" parses (parseFloat=4) yet must not be wheel-editable,
            // or editing it would silently truncate the line.
            const numSpan = (idx) => {
                const t = tokensP[idx];
                return (t && /^\d*\.?\d+$/.test(t.text)) ? {start: t.start, end: t.end} : null;
            };

            let ev = null, dur = 0;
            if (cmd === "view") {
                const name = (tokens[1] || "").toLowerCase();
                if (!VIEW_MAP[name]) { errors.push(`line ${i + 1}: unknown view "${tokens[1]}"`); continue; }
                ev = {type: "view", view: name, start, dur: 0, line: i + 1, concurrent};
                ev.spans = {};
            } else if (cmd === "text" || cmd === "title") {
                const str = tokens[1] ?? "";
                dur = num(tokens[2]) ?? 3;
                ev = {type: "text", text: str, start, dur, line: i + 1, concurrent};
                ev.spans = {dur: numSpan(2)};
            } else if (cmd === "zoom" || cmd === "orbit" || cmd === "track") {
                const target = tokens[1];
                dur = num(tokens[2]);
                if (!target || dur === null) { errors.push(`line ${i + 1}: "${cmd}" needs <object> <secs>`); continue; }
                ev = {type: cmd, target, start, dur, line: i + 1, concurrent};
                if (cmd === "zoom") ev.endDist = num(tokens[3]);
                if (cmd === "orbit") ev.degrees = num(tokens[3]) ?? 90;
                ev.spans = {dur: numSpan(2)};
                if (cmd === "zoom") ev.spans.dist = numSpan(3);
                if (cmd === "orbit") ev.spans.deg = numSpan(3);
                cameraBeats.push(ev);
            } else if (cmd === "fov") {
                const fov = num(tokens[1]);
                dur = num(tokens[2]) ?? 1;
                if (fov === null) { errors.push(`line ${i + 1}: "fov" needs <degrees> <secs>`); continue; }
                ev = {type: "fov", fov: clamp(fov, 1, 120), start, dur, line: i + 1, concurrent};
                ev.spans = {fov: numSpan(1), dur: numSpan(2)};
                cameraBeats.push(ev);
            } else if (cmd === "wait") {
                dur = num(tokens[1]);
                if (dur === null) { errors.push(`line ${i + 1}: "wait" needs <secs>`); continue; }
                ev = {type: "wait", start, dur, line: i + 1, concurrent};
                ev.spans = {dur: numSpan(1)};
                cameraBeats.push(ev);
            } else {
                errors.push(`line ${i + 1}: unknown command "${tokens[0]}"`);
                continue;
            }

            ev.offSpan = offSpan;
            events.push(ev);
            maxEnd = Math.max(maxEnd, start + dur);
            if (!concurrent) { spineStart = start; spineEnd = start + dur; }  // advance the spine
        }

        // camera beats sorted by start (for latest-start-wins resolution)
        cameraBeats.sort((a, b) => a.start - b.start);

        this.events = events;
        this.cameraBeats = cameraBeats;
        this.totalDuration = maxEnd;
        this.parseErrors = errors;
        this._assignLanes();

        try { localStorage.setItem(STORAGE_KEY, text); } catch (e) { /* ignore */ }

        return errors;
    }

    // Assign each timed event to a horizontal "lane" so overlapping events stack on
    // separate rows in the timeline display.
    _assignLanes() {
        const timed = this.events.filter((e) => e.dur > 0).sort((a, b) => a.start - b.start || a.line - b.line);
        const laneEnds = [];
        for (const e of timed) {
            let placed = false;
            for (let i = 0; i < laneEnds.length; i++) {
                if (e.start >= laneEnds[i] - 1e-6) { e._lane = i; laneEnds[i] = e.start + e.dur; placed = true; break; }
            }
            if (!placed) { e._lane = laneEnds.length; laneEnds.push(e.start + e.dur); }
        }
        this._numLanes = Math.max(1, laneEnds.length);
    }

    // -----------------------------------------------------------------------
    // OBJECT / POSITION RESOLUTION
    // -----------------------------------------------------------------------

    // Resolve a target name to an ECEF Vector3 at fractional sitch-frame sf.
    // Returns null if it can't be resolved.
    targetPos(target, sf) {
        if (!target) return null;

        // "lat,lon,alt" literal
        if (target.includes(",")) {
            const p = target.split(",").map(parseFloat);
            if (p.length >= 2 && !isNaN(p[0]) && !isNaN(p[1])) {
                return LLAToECEF(p[0], p[1], isNaN(p[2]) ? 0 : p[2]);
            }
        }

        // try a few node-id conventions
        const candidates = ["Track_" + target, target, target + "_ob"];
        for (const id of candidates) {
            const node = NodeMan.get(id, false);
            if (!node) continue;
            try {
                if (typeof node.p === "function") {
                    const v = node.p(sf);
                    if (v) return v.clone ? v.clone() : v;
                }
                if (typeof node.getValueFrame === "function") {
                    const v = node.getValueFrame(sf);
                    if (v && v.position) return v.position.clone();
                }
            } catch (e) { /* try next */ }
        }
        return null;
    }

    // map a scripted-time t (seconds) to a fractional sitch frame
    sitFrameAt(t) {
        const frames = (Sit && Sit.frames) ? Sit.frames : 1;
        if (this.totalDuration <= 0) return 0;
        const progress = clamp(t / this.totalDuration, 0, 1);
        return clamp(progress * (frames - 1), 0, frames - 1);
    }

    // which friendly view name is active at time t
    activeViewAt(t) {
        let v = this.defaultView;
        for (const e of this.events) {
            if (e.type === "view" && e.start <= t + 1e-6) v = e.view;
        }
        return v;
    }

    // -----------------------------------------------------------------------
    // CAMERA POSE COMPUTATION
    // -----------------------------------------------------------------------

    _poseFromCamNode(camId) {
        const camNode = NodeMan.get(camId, false);
        if (!camNode || !camNode.camera) return null;
        const cam = camNode.camera;
        const fwd = new Vector3();
        cam.getWorldDirection(fwd);
        return {
            position: cam.position.clone(),
            up: cam.up.clone(),
            lookTarget: cam.position.clone().addScaledVector(fwd, 1000),
            fov: cam.fov,
        };
    }

    _pose(position, lookTarget, fov) {
        return {position: position.clone(), up: getLocalUpVector(position), lookTarget: lookTarget.clone(), fov};
    }

    // Walk the beats once, in order, computing each beat's captured params and
    // start/end poses (per-camera continuity). Must be called after parse and
    // before preview/render so the cameras' "current" pose is the start point.
    prepare() {
        const camPose = {};   // camId -> running pose
        let activeView = this.defaultView;

        for (const e of this.events) {
            if (e.type === "view") { activeView = e.view; continue; }
            if (e.type === "text") continue;

            const camId = VIEW_MAP[activeView].camId;
            if (!camPose[camId]) camPose[camId] = this._poseFromCamNode(camId);
            const startPose = camPose[camId] || this._pose(new Vector3(0, 0, 1), new Vector3(), 30);
            e.camId = camId;
            e.startPose = startPose;

            const sfStart = this.sitFrameAt(e.start);
            const sfEnd = this.sitFrameAt(e.start + e.dur);
            let endPose = startPose;

            if (e.type === "zoom") {
                const objStart = this.targetPos(e.target, sfStart);
                if (objStart) {
                    const offset = startPose.position.clone().sub(objStart);
                    const d0 = offset.length() || 1;
                    const dir0 = offset.clone().multiplyScalar(1 / d0);
                    const dEnd = (e.endDist != null && e.endDist > 0)
                        ? e.endDist : clamp(d0 * 0.05, 150, 700);
                    e._zoom = {dir0, d0, dEnd};
                    const objEnd = this.targetPos(e.target, sfEnd) || objStart;
                    endPose = this._pose(objEnd.clone().addScaledVector(dir0, dEnd), objEnd, startPose.fov);
                } else { e.invalid = true; }
            } else if (e.type === "orbit") {
                const objStart = this.targetPos(e.target, sfStart);
                if (objStart) {
                    const offset0 = startPose.position.clone().sub(objStart);
                    const axis = getLocalUpVector(objStart);
                    e._orbit = {offset0, axis};
                    const objEnd = this.targetPos(e.target, sfEnd) || objStart;
                    const offEnd = offset0.clone().applyAxisAngle(axis, radians(e.degrees));
                    endPose = this._pose(objEnd.clone().add(offEnd), objEnd, startPose.fov);
                } else { e.invalid = true; }
            } else if (e.type === "track") {
                const objEnd = this.targetPos(e.target, sfEnd);
                if (objEnd) {
                    endPose = {position: startPose.position.clone(), up: getLocalUpVector(startPose.position),
                        lookTarget: objEnd, fov: startPose.fov};
                } else { e.invalid = true; }
            } else if (e.type === "fov") {
                e._fov = {fov0: startPose.fov, fovEnd: e.fov};
                endPose = {position: startPose.position.clone(), up: startPose.up.clone(),
                    lookTarget: startPose.lookTarget.clone(), fov: e.fov};
            } else if (e.type === "wait") {
                endPose = startPose;
            }

            e.endPose = {position: endPose.position.clone(), up: endPose.up.clone(),
                lookTarget: endPose.lookTarget.clone(), fov: endPose.fov};
            camPose[camId] = e.endPose;
        }
    }

    // Compute {camId, pose} at scripted time t. Returns null if no camera beats.
    computeCamera(t) {
        const beats = this.cameraBeats;
        if (beats.length === 0) return null;

        if (t < beats[0].start) return {camId: beats[0].camId, pose: beats[0].startPose};

        // among camera beats active at t, the latest-starting one takes control
        // (so a concurrent "&" camera move overrides the one it overlaps)
        let beat = null;
        for (const b of beats) {
            if (t >= b.start && t < b.start + b.dur) {
                if (!beat || b.start >= beat.start) beat = b;
            }
        }
        if (!beat) {
            // between/after beats: hold the most recent beat that has started
            let last = beats[0];
            for (const b of beats) if (b.start <= t && b.start >= last.start) last = b;
            return {camId: last.camId, pose: last.endPose};
        }

        if (beat.invalid) return {camId: beat.camId, pose: beat.startPose};

        const localT = beat.dur > 0 ? (t - beat.start) / beat.dur : 1;
        const sf = this.sitFrameAt(t);
        const sp = beat.startPose;
        let pose = sp;

        if (beat.type === "zoom") {
            const obj = this.targetPos(beat.target, sf) || sp.lookTarget;
            const d = lerp(beat._zoom.d0, beat._zoom.dEnd, smooth(localT));
            pose = this._pose(obj.clone().addScaledVector(beat._zoom.dir0, d), obj, sp.fov);
        } else if (beat.type === "orbit") {
            const obj = this.targetPos(beat.target, sf) || sp.lookTarget;
            const off = beat._orbit.offset0.clone().applyAxisAngle(beat._orbit.axis, radians(beat.degrees) * localT);
            pose = this._pose(obj.clone().add(off), obj, sp.fov);
        } else if (beat.type === "track") {
            const obj = this.targetPos(beat.target, sf) || sp.lookTarget;
            pose = {position: sp.position.clone(), up: getLocalUpVector(sp.position), lookTarget: obj, fov: sp.fov};
        } else if (beat.type === "fov") {
            pose = {position: sp.position.clone(), up: sp.up.clone(), lookTarget: sp.lookTarget.clone(),
                fov: lerp(beat._fov.fov0, beat._fov.fovEnd, smooth(localT))};
        } else { // wait
            pose = sp;
        }
        return {camId: beat.camId, pose};
    }

    _applyPoseToCam(camNode, pose) {
        const cam = camNode.camera;
        cam.position.copy(pose.position);
        cam.up.copy(pose.up);
        cam.lookAt(pose.lookTarget);
        if (pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
        cam.updateMatrix();
        cam.updateMatrixWorld(true);
    }

    // apply the scripted camera for time t. We only drive mainCamera; lookCamera is
    // left to its own controllers so the look view stays matched to the witness video.
    applyCameraForTime(t) {
        const r = this.computeCamera(t);
        if (!r || r.camId !== "mainCamera") return;
        const camNode = NodeMan.get(r.camId, false);
        if (camNode && camNode.camera) this._applyPoseToCam(camNode, r.pose);
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

    _setFullscreen(viewId) {
        const view = NodeMan.get(viewId, false);
        if (!view) return;
        view.setVisible(true);
        ViewMan.fullscreenView = view;
        ViewMan.computeEffectiveVisibility();
        ViewMan.updateDOMVisibility();
    }

    // Render the scene at scripted time t into the view's own canvas (no compositing).
    // superSample (>=1) renders at a multiple of the output resolution for SSAA.
    async _renderViewAt(view, sf, t, width, height) {
        par.frame = sf;
        GlobalDateTimeNode?.update(sf);
        // tame the 3D photorealistic tiles before the per-node update selects LODs
        this._tame3DTiles(view);
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
        const ss = this.superSample || 1;
        const pr = (view.renderer && view.renderer.getPixelRatio) ? (view.renderer.getPixelRatio() || 1) : 1;
        view.widthPx = Math.max(2, Math.round((width * ss) / pr));
        view.heightPx = Math.max(2, Math.round((height * ss) / pr));
        this.applyCameraForTime(t);
        view.camera.updateMatrix();
        view.camera.updateMatrixWorld(true);
        for (const pn of NodeMan.getPreRenderNodes()) pn.preRender(view);
        view.renderCanvas(sf);
        for (const pn of NodeMan.getPostRenderNodes()) pn.postRender(view);
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
    _tame3DTiles(activeView) {
        const b = NodeMan.get("buildings3DTiles", false);
        if (!b || !b._perView) return;
        for (const [vid, pv] of Object.entries(b._perView)) {
            if (pv.fadePlugin) pv.fadePlugin.fadeDuration = 0;
            if (pv.renderer && vid === "mainView" && this.tilesErrorTarget) {
                pv.renderer.errorTarget = this.tilesErrorTarget;
            }
        }
    }

    // Composite the view's canvas into the fixed-size output ctx (letterboxed),
    // at the given alpha (used for running-average accumulation / motion blur).
    _compositeView(ctx, view, width, height, alpha = 1) {
        if (!view || !view.canvas) return;
        const cw = view.canvas.width, ch = view.canvas.height;
        if (cw <= 0 || ch <= 0) return;
        const s = Math.min(width / cw, height / ch);
        const dw = cw * s, dh = ch * s;
        ctx.globalAlpha = alpha;
        ctx.drawImage(view.canvas, (width - dw) / 2, (height - dh) / 2, dw, dh);
        ctx.globalAlpha = 1;
    }

    // Render + composite a single frame (used by the warm-up pass). ctx may be null.
    async _renderSceneFrame(view, sf, t, ctx, width, height) {
        await this._renderViewAt(view, sf, t, width, height);
        if (!ctx || !view) return;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
        this._compositeView(ctx, view, width, height, 1);
        this._drawTexts(ctx, width, height, t);
    }

    // The scripted time at which the camera is nearest its look target — where the
    // terrain needs the most detail. Used to warm up terrain LOD before freezing it.
    closestApproachTime() {
        let best = 0, bestD = Infinity;
        const N = 60;
        for (let k = 0; k <= N; k++) {
            const t = (this.totalDuration * k) / N;
            const r = this.computeCamera(t);
            if (!r) continue;
            const d = r.pose.position.distanceTo(r.pose.lookTarget);
            if (d < bestD) { bestD = d; best = t; }
        }
        return best;
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
                view.preRenderFunction = savedPreRender[viewId] ?? (() => {});
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

    startPreview() {
        if (this._previewing) { this.stopPreview(); }
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
        this._showBottomTimeline();   // scripted timeline replaces the normal frame slider
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
            if (this._tlDragging) {
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

            this.drawTimeline();
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
        this._hideBottomTimeline();   // restore the normal frame slider
        if (this._restore) { this._restore(); this._restore = null; }
        if (this._savedPaused !== undefined) par.paused = this._savedPaused;
        this._hoverSeg = null; this._hoverNum = null;   // drop any hover from the bottom strip
        setRenderOne(true);
        this.drawTimeline();
        this.setStatus(`Ready — ${this.totalDuration.toFixed(1)}s, ${this.cameraBeats.length} beats`);
    }

    // -----------------------------------------------------------------------
    // OFFLINE RENDER  (1080P60 MP4)
    // -----------------------------------------------------------------------

    async renderVideo() {
        if (this._previewing) this.stopPreview();
        this.parse();
        this.prepare();
        if (this.totalDuration <= 0) { alert("Scripted Video: nothing to render (no timed commands)."); return; }

        const width = this.outW, height = this.outH, fps = this.outFps;
        const totalFrames = Math.max(1, Math.round(this.totalDuration * fps));

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
        const mbSamples = Math.max(1, this.motionBlurSamples || 1);

        // save / clobber state
        const savedFrame = par.frame, savedPaused = par.paused;
        par.paused = true;
        Globals.scriptedVideoRendering = true;   // take exclusive control of rendering
        const restore = this._enterScriptedMode();
        // neutralise the preRender hooks for offline (we position the camera explicitly)
        const mainV = NodeMan.get("mainView", false), lookV = NodeMan.get("lookView", false);
        if (mainV) mainV.preRenderFunction = () => {};
        if (lookV) lookV.preRenderFunction = () => {};

        // Force every rendered view to a true 16:9 render, independent of the
        // on-screen window shape (which may be portrait / side-by-side). The view's
        // camera.aspect and render size come from widthPx/heightPx, so we drive
        // those to 1920x1080 right before each renderCanvas (see renderFrame). We
        // save the live values here and restore them at the end.
        const sizedViews = [mainV, lookV].filter(Boolean);
        const savedViewSize = sizedViews.map((v) => ({v, wp: v.widthPx, hp: v.heightPx}));

        const progress = new ExportProgressWidget("Rendering scripted video (1080P60)…", totalFrames);
        this._renderProgress = {i: 0, total: totalFrames, done: false, error: null, blobSize: 0, filename: null};

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
            if (terrainUINode && this.terrainDetail && this.terrainDetail !== 1) {
                if (savedTexDetail !== undefined) terrainUINode.textureDetail = savedTexDetail * this.terrainDetail;
                if (savedEleDetail !== undefined) terrainUINode.elevationDetail = savedEleDetail * this.terrainDetail;
            }
            this._restoreTerrain = () => {
                if (!terrainUINode) return;
                if (savedTexDetail !== undefined) terrainUINode.textureDetail = savedTexDetail;
                if (savedEleDetail !== undefined) terrainUINode.elevationDetail = savedEleDetail;
            };

            const settleAt = async (view, viewId, sf, t, cap) => {
                if (!view) return;
                const r = async () => { await this._renderViewAt(view, sf, t, width, height); };
                await r();
                // Don't gate the settle on the video frame: _renderViewAt already awaits
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
                this._currentT = t;
                const sf = this.sitFrameAt(t);
                const vName = this.activeViewAt(t);
                const viewId = VIEW_MAP[vName].viewId;
                const view = NodeMan.get(viewId, false);

                // Settle this frame's terrain (subdivide for this camera + finish
                // loading) before capture. Consecutive frames mostly hit cache, so
                // after the first frame of a shot this is fast.
                if (this.waitForLoading) await settleAt(view, viewId, sf, t, 8000);

                // Composite the frame. Optional accumulation motion blur (mbSamples>1)
                // averages sub-frames across the shutter for a cinematic look; it is
                // NOT the flicker fix (that's the settle above) — default off.
                ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
                for (let k = 0; k < mbSamples; k++) {
                    const subT = t + (mbSamples > 1 ? (k / mbSamples) / fps : 0);
                    this._currentT = subT;
                    await this._renderViewAt(view, this.sitFrameAt(subT), subT, width, height);
                    this._compositeView(ctx, view, width, height, 1 / (k + 1)); // running average
                }
                this._drawTexts(ctx, width, height, t);   // captions stay crisp

                await exporter.addFrame(out, i);
                this._renderProgress.i = i + 1;
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
                this._renderProgress.blobSize = blob.size;
                this._renderProgress.filename = filename;
            }
        } catch (e) {
            console.error("Scripted video render failed:", e);
            if (this._renderProgress) this._renderProgress.error = (e && e.stack) ? e.stack : String(e);
            alert("Scripted video render failed: " + (e.message || e));
        } finally {
            if (this._renderProgress) this._renderProgress.done = true;
            progress.remove();
            if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
            if (this._restoreTerrain) { this._restoreTerrain(); this._restoreTerrain = null; }
            for (const {v, wp, hp} of savedViewSize) { v.widthPx = wp; v.heightPx = hp; }
            restore();
            Globals.scriptedVideoRendering = false;   // return control to the main loop
            par.frame = savedFrame; par.paused = savedPaused;
            setRenderOne(true);
        }
    }

    // -----------------------------------------------------------------------
    // TIMELINE WIDGET
    // -----------------------------------------------------------------------

    drawTimeline() {
        if (this._previewing) this._followPlayhead();
        if (this.timelineCanvas && this.timelineCanvas.clientWidth > 0) this._drawTimelineTo(this.timelineCanvas);
        if (this.bottomTimeline && this.bottomTimeline.clientWidth > 0) this._drawTimelineTo(this.bottomTimeline);
    }

    // Shared timeline geometry so the draw and the hit-test never drift apart.
    _timelineGeom(c) {
        const w = c.clientWidth || 320, h = c.clientHeight || 40;
        const total = this.totalDuration || 1;
        const span = total / this.tlZoom;                 // visible time window
        const x = (t) => ((t - this.tlOffset) / span) * w;
        const compact = h < 44;
        const numLanes = this._numLanes || 1;
        const padTop = compact ? 1 : 3;
        const padBot = compact ? 1 : 13;   // room for duration label when not compact
        const gap = compact ? 1 : 2;
        const laneH = Math.max(3, (h - padTop - padBot - gap * (numLanes - 1)) / numLanes);
        return {w, h, total, span, x, compact, numLanes, padTop, padBot, gap, laneH};
    }

    // The timeline segment (event bar) at a client position, or null.
    _segAtTimeline(c, clientX, clientY) {
        if (this.totalDuration <= 0 || !this.events) return null;
        const r = c.getBoundingClientRect();
        const px = clientX - r.left - (c.clientLeft || 0);   // strip the canvas border
        const py = clientY - r.top - (c.clientTop || 0);
        const g = this._timelineGeom(c);
        // the bottom strip is the scrollbar when zoomed — don't treat it as a segment
        const sb = this.tlZoom > 1.001 ? CScriptedVideoManager.SCROLLBAR_H : 0;
        if (py < 0 || py > g.h - sb) return null;
        for (const e of this.events) {
            if (!(e.dur > 0)) continue;
            const y0 = g.padTop + (e._lane || 0) * (g.laneH + g.gap);
            const x0 = g.x(e.start), bw = Math.max(2, g.x(e.start + e.dur) - x0);
            if (px >= x0 && px <= x0 + bw && py >= y0 && py <= y0 + g.laneH) return e;
        }
        return null;
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

    // the duration number token of an event, as an editor hover descriptor
    _durTokenForEvent(e) {
        const s = e && e.spans && e.spans.dur;
        if (!s || !this.textarea) return null;
        const lt = (this.textarea.value.split("\n")[e.line - 1]) || "";
        return {line: e.line - 1, start: s.start, end: s.end, text: lt.slice(s.start, s.end)};
    }

    _drawTimelineTo(c) {
        const w = c.clientWidth || 320, h = c.clientHeight || 40;
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#16181d"; ctx.fillRect(0, 0, w, h);

        const g = this._timelineGeom(c);
        const total = g.total, span = g.span, x = g.x, compact = g.compact;
        const padTop = g.padTop, gap = g.gap, laneH = g.laneH;

        const label = (e) => {
            if (e.type === "text") return '"' + (e.text || "") + '"';
            if (e.type === "fov") return "fov " + e.fov;
            if (e.type === "wait") return "wait";
            return e.type + (e.target ? " " + e.target : "");
        };

        for (const e of this.events) {
            if (!(e.dur > 0)) continue;
            const lane = e._lane || 0;
            const y = padTop + lane * (laneH + gap);
            const x0 = x(e.start), bw = Math.max(2, x(e.start + e.dur) - x0);
            ctx.fillStyle = e.invalid ? "#7a2a2a" : (BEAT_COLORS[e.type] || "#3a7bd5");
            ctx.fillRect(x0, y, bw, laneH);
            ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y + 0.5, bw - 1, laneH - 1);
            // highlight the segment linked to the hovered number / hovered segment
            if (this._hoverSeg && e.line === this._hoverSeg.line) {
                ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 2;
                ctx.strokeRect(x0 + 1, y + 1, Math.max(1, bw - 2), Math.max(1, laneH - 2));
            }
            if (bw > 24 && laneH >= 11) {
                ctx.fillStyle = "#fff"; ctx.font = "10px sans-serif";
                ctx.textBaseline = "middle"; ctx.textAlign = "left";
                ctx.save(); ctx.beginPath(); ctx.rect(x0, y, bw, laneH); ctx.clip();
                ctx.fillText(label(e), x0 + 3, y + laneH / 2);
                ctx.restore();
            }
        }

        // view cuts (full-height markers)
        for (const e of this.events) {
            if (e.type !== "view") continue;
            const xx = x(e.start);
            ctx.strokeStyle = "#cfd3da"; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h); ctx.stroke();
            if (!compact) {
                ctx.fillStyle = "#cfd3da"; ctx.font = "9px sans-serif";
                ctx.textBaseline = "top"; ctx.textAlign = "left";
                ctx.fillText(e.view, xx + 2, 1);
            }
        }

        // playhead (always shown so scrubbing position is visible too)
        const px = x(this._currentT);
        if (px >= -1 && px <= w + 1) {
            // grab handle at the top so it's clear it can be dragged
            ctx.fillStyle = "#ffd24a";
            ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 4, 0); ctx.lineTo(px, 6); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
        }

        // scrollbar showing/controlling the visible window when zoomed in
        if (this.tlZoom > 1.001) {
            const sbH = CScriptedVideoManager.SCROLLBAR_H;
            const bx0 = (this.tlOffset / total) * w, bw = (span / total) * w;
            ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(0, h - sbH, w, sbH);
            ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fillRect(bx0, h - sbH, Math.max(10, bw), sbH);
        }

        // current-time / duration label (only where there's room)
        if (!compact) {
            ctx.fillStyle = "#aab"; ctx.font = "10px sans-serif";
            ctx.textAlign = "right"; ctx.textBaseline = "bottom";
            ctx.fillText(this._currentT.toFixed(1) + " / " + total.toFixed(1) + "s"
                + (this.tlZoom > 1.001 ? "  ×" + this.tlZoom.toFixed(1) : ""), w - 3, h - 1);
        }
    }

    // time at a pixel x on a timeline canvas (accounts for zoom/scroll). Strips the
    // canvas border and divides by the content-box width so it lands exactly on the
    // drawn bars/playhead (same convention as _segAtTimeline / _drawTimelineTo).
    _timeAtX(c, clientX) {
        const r = c.getBoundingClientRect();
        const px = clientX - r.left - (c.clientLeft || 0);
        const frac = clamp(px / (c.clientWidth || r.width), 0, 1);
        const span = this.totalDuration / this.tlZoom;
        return clamp(this.tlOffset + frac * span, 0, this.totalDuration);
    }

    // height (px) of the draggable scrollbar strip at the bottom of the timeline
    static get SCROLLBAR_H() { return 6; }

    // attach mousedown (scrub or scrollbar-pan) + wheel-to-scroll handlers
    _attachTimelineHandlers(c) {
        c.style.cursor = "ew-resize";
        c.addEventListener("mousedown", (ev) => this._onTimelineMouseDown(c, ev));
        c.addEventListener("wheel", (ev) => this._onTimelineWheel(c, ev), { passive: false });
        c.addEventListener("mousemove", (ev) => this._updateTimelineHover(c, ev.clientX, ev.clientY));
        c.addEventListener("mouseleave", () => this._onTimelineLeave(c));
    }

    // Hovering a timeline segment highlights it + its duration number in the editor,
    // and arms the wheel to edit that duration. Hovering elsewhere = scrub/pan cursor.
    _updateTimelineHover(c, clientX, clientY) {
        if (this._tlDragging) return;
        const seg = this._segAtTimeline(c, clientX, clientY);
        // only show the wheel-edit affordance when there's a duration token to edit
        c.style.cursor = (seg && seg.spans && seg.spans.dur) ? "ns-resize" : "ew-resize";
        const prevLine = this._hoverSeg ? this._hoverSeg.line : null;
        const newLine = seg ? seg.line : null;
        // the boxed duration only changes via a wheel edit (which re-renders itself),
        // so a same-line mousemove needs no rebuild
        if (prevLine !== newLine) {
            this._hoverSeg = seg;
            this._hoverNum = seg ? this._durTokenForEvent(seg) : null;
            this._renderBackdrop();
            this.drawTimeline();
        }
    }

    _onTimelineLeave(c) {
        if (this._tlDragging) return;
        c.style.cursor = "ew-resize";
        if (this._hoverSeg || this._hoverNum) {
            this._hoverSeg = null; this._hoverNum = null;
            this._renderBackdrop(); this.drawTimeline();
        }
    }

    _onTimelineMouseDown(c, ev) {
        const r = c.getBoundingClientRect();
        const y = ev.clientY - r.top;
        // bottom strip drags the scrollbar (only meaningful when zoomed in)
        if (this.tlZoom > 1.001 && y >= r.height - CScriptedVideoManager.SCROLLBAR_H) {
            this._beginScrollDrag(c, ev);
        } else {
            this._beginTimelineDrag(c, ev);
        }
    }

    // NOTE: listeners are added in the CAPTURE phase because the in-page panel calls
    // blockViewEvents() which stopPropagation()s mouseup in the bubble phase — without
    // capture the mouseup never reaches the document and the drag never ends.
    _beginTimelineDrag(c, ev) {
        ev.preventDefault();
        if (this.totalDuration <= 0) { this.parse(); this.prepare(); }
        if (this.totalDuration <= 0) return;
        this._tlDragging = true;
        this._dragCanvas = c;
        this._scrubTo(this._timeAtX(c, ev.clientX));
        const doc = c.ownerDocument || document;   // may live in a popped-out window
        const move = (e) => { if (this._dragCanvas) this._scrubTo(this._timeAtX(this._dragCanvas, e.clientX)); };
        const up = (e) => {
            this._tlDragging = false; this._dragCanvas = null;
            doc.removeEventListener("mousemove", move, true);
            doc.removeEventListener("mouseup", up, true);
            // re-evaluate hover at the release point (clears a stale highlight if the
            // drag ended off a bar / off the canvas)
            if (e) this._updateTimelineHover(c, e.clientX, e.clientY);
        };
        doc.addEventListener("mousemove", move, true);
        doc.addEventListener("mouseup", up, true);
    }

    _beginScrollDrag(c, ev) {
        ev.preventDefault();
        if (this.totalDuration <= 0) return;
        const doc = c.ownerDocument || document;
        const pan = (e) => {
            const r = c.getBoundingClientRect();
            const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
            const span = this.totalDuration / this.tlZoom;
            this.tlOffset = clamp(fx * this.totalDuration - span / 2, 0, Math.max(0, this.totalDuration - span));
            this.drawTimeline();
        };
        pan(ev);
        const up = () => {
            doc.removeEventListener("mousemove", pan, true);
            doc.removeEventListener("mouseup", up, true);
        };
        doc.addEventListener("mousemove", pan, true);
        doc.addEventListener("mouseup", up, true);
    }

    // Cmd/Ctrl + '=' / '-' zoom the timeline (and suppress the browser's own zoom).
    _attachKeyZoom(win) {
        const handler = (e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const editorOpen = (this.window && this.window.style.display !== "none")
                || (this.external && !this.external.closed) || this._previewing || this._scrubbing;
            if (!editorOpen) return;
            const k = e.key, code = e.code;
            if (k === "=" || k === "+" || code === "Equal" || code === "NumpadAdd") {
                e.preventDefault(); e.stopPropagation(); this._zoomTimeline(1.5);
            } else if (k === "-" || k === "_" || code === "Minus" || code === "NumpadSubtract") {
                e.preventDefault(); e.stopPropagation(); this._zoomTimeline(1 / 1.5);
            } else if (k === "0" || code === "Digit0") {
                e.preventDefault(); e.stopPropagation(); this.tlZoom = 1; this.tlOffset = 0; this.drawTimeline();
            }
        };
        win.addEventListener("keydown", handler, true);   // capture phase to beat the browser
    }

    _onTimelineWheel(c, ev) {
        if (this.totalDuration <= 0) return;
        // over a segment → the wheel edits that segment's duration (like the editor)
        const seg = this._segAtTimeline(c, ev.clientX, ev.clientY);
        if (seg && seg.spans && seg.spans.dur) {
            ev.preventDefault();
            this._adjustNumberToken(seg.line - 1, seg.spans.dur, ev.deltaY, ev.shiftKey, 0.1);
            // events were rebuilt by doParse(); re-resolve the hovered segment + number
            this._hoverSeg = this._eventOnLine(seg.line);
            this._hoverNum = this._durTokenForEvent(this._hoverSeg);
            c.style.cursor = "ns-resize";
            this._renderBackdrop();
            this.drawTimeline();
            if (this._scrubbing || this._previewing) this._scrubTo(this._currentT);
            return;
        }
        // otherwise pan the visible window
        ev.preventDefault();
        const span = this.totalDuration / this.tlZoom;
        const d = (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY);
        this.tlOffset = clamp(this.tlOffset + d * span / (c.clientWidth || 300),
            0, Math.max(0, this.totalDuration - span));
        this.drawTimeline();
    }

    // zoom the timeline about the playhead (or visible centre if it's off-screen)
    _zoomTimeline(factor) {
        const total = this.totalDuration || 1;
        const span = total / this.tlZoom;
        let centerT = this._currentT;
        if (centerT < this.tlOffset || centerT > this.tlOffset + span) centerT = this.tlOffset + span / 2;
        const frac = span > 0 ? (centerT - this.tlOffset) / span : 0.5;
        const maxZoom = Math.max(1, total / 0.5);
        this.tlZoom = clamp(this.tlZoom * factor, 1, maxZoom);
        const newSpan = total / this.tlZoom;
        this.tlOffset = clamp(centerT - frac * newSpan, 0, Math.max(0, total - newSpan));
        this.drawTimeline();
    }

    // keep the playhead in view while previewing if zoomed in
    _followPlayhead() {
        if (this.tlZoom <= 1.001) return;
        const span = this.totalDuration / this.tlZoom;
        if (this._currentT < this.tlOffset || this._currentT > this.tlOffset + span) {
            this.tlOffset = clamp(this._currentT - span / 2, 0, Math.max(0, this.totalDuration - span));
        }
    }

    // Replace the normal bottom frame slider with the scripted timeline during preview.
    _showBottomTimeline() {
        const cc = getControlsContainer();
        if (!cc || this.bottomTimeline) return;
        this._hiddenControls = [];
        for (const child of Array.from(cc.children)) {
            this._hiddenControls.push([child, child.style.display]);
            child.style.display = "none";
        }
        const c = document.createElement("canvas");
        c.style.cssText = "display:block;width:100%;height:100%;z-index:1002;position:relative;";
        this._attachTimelineHandlers(c);
        cc.appendChild(c);
        this.bottomTimeline = c;
    }

    _hideBottomTimeline() {
        if (this.bottomTimeline && this.bottomTimeline.parentNode) {
            this.bottomTimeline.parentNode.removeChild(this.bottomTimeline);
        }
        this.bottomTimeline = null;
        if (this._hiddenControls) {
            for (const [el, d] of this._hiddenControls) el.style.display = d;
            this._hiddenControls = null;
        }
    }

    setStatus(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    // -----------------------------------------------------------------------
    // MENU
    // -----------------------------------------------------------------------

    setupMenu() {
        if (!guiMenus.video) return;
        this.buildWindow();
        this._attachKeyZoom(window);

        const folder = guiMenus.video.addFolder("Scripted Video").close().perm();
        folder.add({ open: () => this.toggleWindow() }, "open").name("Script Window…").perm()
            .tooltip("Open/close the in-page Scripted Video script editor window.");
        folder.add({ pop: () => this.openExternalWindow() }, "pop").name("Script Window (New Window)").perm()
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
        setTimeout(() => this.drawTimeline(), 0);
    }

    // -----------------------------------------------------------------------
    // SCRIPT WINDOW  (separate draggable/resizable floating panel)
    // -----------------------------------------------------------------------

    buildWindow() {
        const panel = document.createElement("div");
        panel.style.cssText = `position:fixed; top:70px; left:70px; width:400px; height:440px;
            min-width:280px; min-height:240px; display:none; flex-direction:column;
            background:rgba(20,24,29,0.96); color:#eef2f6; border:1px solid rgba(255,255,255,0.15);
            border-radius:9px; box-shadow:0 14px 40px rgba(0,0,0,0.5); overflow:hidden; resize:both; z-index:2000;`;

        // header / drag handle
        const header = document.createElement("div");
        header.style.cssText = `display:flex; align-items:center; gap:8px; padding:7px 10px; cursor:move;
            background:rgba(255,255,255,0.06); border-bottom:1px solid rgba(255,255,255,0.08);
            font:600 13px sans-serif; user-select:none; flex:0 0 auto;`;
        const title = document.createElement("div");
        title.textContent = "Scripted Video";
        title.style.cssText = "flex:1 1 auto;";
        const closeBtn = this._winButton("Close", () => this.hideWindow());
        header.appendChild(title); header.appendChild(closeBtn);
        this._header = header;

        // movable content container (adopted into a popup when popped out)
        const content = this._buildEditorContent();
        this._content = content;

        panel.appendChild(header);
        panel.appendChild(content);
        document.body.appendChild(panel);
        this.window = panel;

        // make it draggable by the header, and don't let the 3D view eat mouse events.
        // Dragging it up under the menu bar closes it (re-opening drops it back below).
        blockViewEvents(panel);
        makeDraggable(panel, { handle: header, excludeElements: [closeBtn], closeOnDragOffTop: () => this.hideWindow() });

        // redraw timeline when the window is resized
        try { new ResizeObserver(() => this.drawTimeline()).observe(panel); } catch (e) {}
    }

    // The editor content (toolbar + textarea + status + timeline) as a single div so it
    // can be moved between the in-page panel and a popped-out browser window.
    _buildEditorContent() {
        const content = document.createElement("div");
        content.style.cssText = "display:flex; flex-direction:column; flex:1 1 auto; min-height:0;";

        const toolbar = document.createElement("div");
        toolbar.style.cssText = "display:flex; gap:6px; padding:6px 8px; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,0.06); flex:0 0 auto;";
        toolbar.appendChild(this._winButton("Parse", () => this.doParse()));
        toolbar.appendChild(this._winButton("Preview", () => this.startPreview()));
        toolbar.appendChild(this._winButton("Stop", () => this.stopAll()));
        toolbar.appendChild(this._winButton("Render", () => this.renderVideo()));
        this._popoutBtn = this._winButton("⧉ New Window", () => this._togglePopout());
        this._popoutBtn.style.marginLeft = "auto";
        toolbar.appendChild(this._popoutBtn);

        // --- editor: a transparent textarea over a styled backdrop ---
        // The textarea keeps native caret/typing/selection but renders its text
        // transparent; the backdrop underneath renders the same text and adds the
        // styling a textarea can't: bold the current line, and box a hovered number.
        const editWrap = document.createElement("div");
        editWrap.style.cssText = "position:relative; flex:1 1 auto; min-height:80px; margin:8px;";
        // identical text-layout box for both layers so they line up exactly
        const EDIT_CSS = "position:absolute; inset:0; box-sizing:border-box; margin:0;" +
            " font:12px/1.4 monospace; padding:6px; border:1px solid; border-radius:4px;" +
            " white-space:pre; overflow:auto; letter-spacing:0; tab-size:4;";
        const backdrop = document.createElement("div");
        backdrop.style.cssText = EDIT_CSS + " color:#ddd; background:#111; border-color:#333; pointer-events:none; z-index:0;";
        this.backdrop = backdrop;

        const ta = document.createElement("textarea");
        ta.spellcheck = false;
        ta.wrap = "off";   // match the backdrop's white-space:pre so rows line up
        ta.style.cssText = EDIT_CSS + " color:transparent; background:transparent; caret-color:#fff;" +
            " border-color:transparent; resize:none; z-index:1;";
        let saved = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
        ta.value = saved || DEFAULT_SCRIPT;
        for (const ev of ["keydown", "keyup", "keypress"]) ta.addEventListener(ev, (e) => e.stopPropagation());
        ta.addEventListener("input", () => { this.doParse(); this._renderBackdrop(); });
        ta.addEventListener("click", () => { this._scrubToCursorLine(); this._renderBackdrop(); });
        ta.addEventListener("keyup", (e) => { if (NAV_KEYS.has(e.key)) this._scrubToCursorLine(); this._renderBackdrop(); });
        ta.addEventListener("scroll", () => { backdrop.scrollTop = ta.scrollTop; backdrop.scrollLeft = ta.scrollLeft; });
        ta.addEventListener("mousemove", (e) => this._onEditorHover(e));
        ta.addEventListener("mouseleave", () => { if (this._hoverNum || this._hoverSeg) { this._hoverNum = null; this._hoverSeg = null; ta.style.cursor = ""; this._renderBackdrop(); this.drawTimeline(); } });
        ta.addEventListener("wheel", (e) => this._onEditorWheel(e), { passive: false });
        this.textarea = ta;

        editWrap.appendChild(backdrop);
        editWrap.appendChild(ta);

        const st = document.createElement("div");
        st.style.cssText = "font:11px sans-serif; color:#9aa; padding:0 10px 4px; flex:0 0 auto;";
        st.textContent = "Press Parse";
        this.statusEl = st;

        const tl = document.createElement("canvas");
        tl.style.cssText = "display:block; width:calc(100% - 16px); height:60px; margin:0 8px 10px; border:1px solid #333; border-radius:4px; flex:0 0 auto;";
        this._attachTimelineHandlers(tl);
        this.timelineCanvas = tl;

        content.appendChild(toolbar);
        content.appendChild(editWrap);
        content.appendChild(st);
        content.appendChild(tl);
        setTimeout(() => this._renderBackdrop(), 0);
        return content;
    }

    // ---- editor backdrop: bold current line + box the hovered number ----
    _cursorLine() {
        const ta = this.textarea;
        if (!ta) return -1;
        return ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    }

    _escHtml(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    _renderBackdrop() {
        const ta = this.textarea, bd = this.backdrop;
        if (!ta || !bd) return;
        const lines = ta.value.split("\n");
        const cur = this._cursorLine();
        const hov = this._hoverNum;
        const box = '<span style="outline:1.5px solid #ffd24a;border-radius:2px;background:rgba(255,210,74,0.18)">';
        let html = "";
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let h;
            if (hov && hov.line === i) {
                h = this._escHtml(line.slice(0, hov.start)) + box + this._escHtml(line.slice(hov.start, hov.end))
                    + "</span>" + this._escHtml(line.slice(hov.end));
            } else {
                h = this._escHtml(line);
            }
            if (i === cur) h = "<b>" + h + "</b>";
            html += h + (i < lines.length - 1 ? "\n" : "");
        }
        bd.innerHTML = html;
        bd.scrollTop = ta.scrollTop; bd.scrollLeft = ta.scrollLeft;
    }

    _charMetrics() {
        const ta = this.textarea;
        const cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4);
        if (!this._charW) {
            const probe = document.createElement("span");
            probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:" + cs.font;
            probe.textContent = "0000000000";
            (ta.ownerDocument.body || document.body).appendChild(probe);
            this._charW = probe.getBoundingClientRect().width / 10;
            probe.remove();
        }
        return {cw: this._charW || 7.2, lh, padL: parseFloat(cs.paddingLeft), padT: parseFloat(cs.paddingTop)};
    }

    // The editable control-number under (row,col): ONLY a parser-recognised number
    // (duration / distance / degrees / fov / &offset) — never a digit inside a quoted
    // caption or a lat,lon,alt coordinate, which control nothing on the timeline.
    // Accepts the mouse up to `pad` chars to either side; nearest wins. Returns
    // {line,start,end,text,field} or null.
    _editableNumberAt(row, col, pad = 0) {
        const ev = this._anyEventOnLine(row + 1);
        if (!ev) return null;
        const lt = (this.textarea.value.split("\n")[row]) || "";
        const cands = [];
        if (ev.spans) for (const f of ["dur", "dist", "deg", "fov"]) if (ev.spans[f]) cands.push({s: ev.spans[f], field: f});
        if (ev.offSpan) cands.push({s: ev.offSpan, field: "off"});
        let best = null, bestDist = Infinity;
        for (const {s, field} of cands) {
            let dist = 0;
            if (col < s.start) dist = s.start - col;            // chars to the left
            else if (col >= s.end) dist = col - (s.end - 1);    // chars to the right
            if (dist <= pad && dist < bestDist) {
                best = {line: row, start: s.start, end: s.end, text: lt.slice(s.start, s.end), field};
                bestDist = dist;
            }
        }
        return best;
    }

    _onEditorHover(e) {
        const ta = this.textarea;
        const {cw, lh, padL, padT} = this._charMetrics();
        const rect = ta.getBoundingClientRect();
        const x = e.clientX - rect.left - padL + ta.scrollLeft;
        const y = e.clientY - rect.top - padT + ta.scrollTop;
        const row = Math.floor(y / lh);
        const col = Math.floor(x / cw);
        // accept the mouse up to 2 chars on either side of a control number
        const found = (y < 0) ? null : this._editableNumberAt(row, col, 2);
        const a = this._hoverNum;
        const same = (!a && !found) || (a && found && a.line === found.line && a.start === found.start && a.end === found.end);
        ta.style.cursor = found ? "ns-resize" : "";
        if (!same) {
            this._hoverNum = found;
            this._hoverSeg = found ? this._eventOnLine(found.line + 1) : null;
            this._renderBackdrop();
            this.drawTimeline();   // highlight (or clear) the linked timeline segment
        }
    }

    // per-field floor: a duration must stay > 0 (else its bar vanishes); fov ≥ 1;
    // distance / degrees / offset may legitimately be 0
    _minValForField(field) {
        if (field === "dist" || field === "deg" || field === "off") return 0;
        if (field === "fov") return 1;
        return 0.1;   // dur (and anything unlabelled)
    }

    _onEditorWheel(e) {
        if (!this._hoverNum) return;            // not over a control number → normal scroll
        e.preventDefault();
        const h = this._hoverNum;
        const res = this._adjustNumberToken(h.line, {start: h.start, end: h.end}, e.deltaY, e.shiftKey, this._minValForField(h.field));
        if (!res) return;
        h.start = res.start; h.end = res.end; h.text = res.text;
        this._hoverSeg = this._eventOnLine(h.line + 1);
        if (!this._hoverSeg) this._hoverNum = null;   // keep both highlight surfaces consistent
        this._renderBackdrop();
        this.drawTimeline();
        if (this._scrubbing || this._previewing) this._scrubTo(this._currentT);
    }

    // Increment/decrement the number token at lines[row][span.start..span.end] by a
    // mouse-wheel step (1 for ints, 0.1 for decimals, ×10 with Shift), never below
    // minVal. Rewrites the textarea, keeps the caret aligned across width changes,
    // re-parses, and returns the new {start,end,text} span (null if not a clean
    // number). Shared by the editor and the timeline-segment wheel.
    _adjustNumberToken(row, span, deltaY, shiftKey, minVal = 0) {
        const ta = this.textarea;
        if (!ta || !span) return null;
        const lines = ta.value.split("\n");
        const line = lines[row];
        if (line === undefined) return null;
        const cur = line.slice(span.start, span.end);
        if (!/^\d*\.?\d+$/.test(cur)) return null;     // only adjust a clean numeric token
        const hasDot = cur.includes(".");
        let step = hasDot ? 0.1 : 1;
        if (shiftKey) step *= 10;
        const dir = deltaY < 0 ? 1 : -1;
        let val = parseFloat(cur) + dir * step;
        if (!isFinite(val)) return null;
        if (val < minVal) val = minVal;
        // Keep a decimal token decimal (so the 0.1 step survives the whole-number
        // boundary, e.g. 0.9→1.0→1.1) and floor AFTER rounding so an integer step
        // can't collapse the value back below minVal (Math.round(0.1)=0 would).
        let out;
        if (hasDot) {
            out = (Math.round(val * 10) / 10).toFixed(1);
            if (parseFloat(out) < minVal) out = minVal.toFixed(1);
        } else {
            out = String(Math.round(val));
            if (parseFloat(out) < minVal) out = String(Math.ceil(minVal));
        }
        // adjust the caret for any change in the token's character width
        const delta = out.length - (span.end - span.start);
        let lineStart = 0;
        for (let r = 0; r < row; r++) lineStart += lines[r].length + 1;
        const absStart = lineStart + span.start, absEnd = lineStart + span.end;
        let caret = ta.selectionStart;
        if (caret >= absEnd) caret += delta;
        else if (caret > absStart) caret = absStart + out.length;
        lines[row] = line.slice(0, span.start) + out + line.slice(span.end);
        ta.value = lines.join("\n");
        try { ta.selectionStart = ta.selectionEnd = caret; } catch (e2) {}
        this.doParse();
        return {start: span.start, end: span.start + out.length, text: out};
    }

    _togglePopout() {
        if (this.external && !this.external.closed) this.dockWindow();
        else this.openExternalWindow();
    }

    // Pop the editor out into a real, separate browser window.
    openExternalWindow() {
        if (this.external && !this.external.closed) { this.external.focus(); return; }
        const win = window.open("", "SitrecScriptEditor", "popup,width=520,height=640");
        if (!win) { alert("Popup blocked — please allow popups for this site, then try again."); return; }
        this.external = win;
        try { win.document.title = "Sitrec — Scripted Video"; } catch (e) {}
        win.document.body.style.cssText = "margin:0; background:#14181d; color:#eef2f6; height:100vh; display:flex; flex-direction:column; overflow:hidden;";
        win.document.body.appendChild(win.document.adoptNode(this._content));
        if (this.window) this.window.style.display = "none";
        this._attachKeyZoom(win);
        win.addEventListener("resize", () => this.drawTimeline());
        this._setPopoutLabel(true);
        win.addEventListener("beforeunload", () => this._dockFromExternal());
        // fallback poll in case beforeunload doesn't fire
        this._extPoll = setInterval(() => {
            if (!this.external || this.external.closed) this._dockFromExternal();
        }, 600);
        setTimeout(() => this.drawTimeline(), 60);
    }

    dockWindow() {
        this._dockShow = true;   // explicit dock → bring the in-page panel back up
        if (this.external && !this.external.closed) this.external.close();   // → beforeunload → _dockFromExternal
        else this._dockFromExternal();
    }

    _dockFromExternal() {
        if (this._extPoll) { clearInterval(this._extPoll); this._extPoll = null; }
        if (this._content && this._content.ownerDocument !== document) {
            this.window.appendChild(document.adoptNode(this._content));
        }
        this.external = null;
        this._setPopoutLabel(false);
        // explicit Dock shows the panel; closing the popup just parks it hidden
        if (this.window) this.window.style.display = this._dockShow ? "flex" : "none";
        this._dockShow = false;
        setTimeout(() => this.drawTimeline(), 60);
    }

    _setPopoutLabel(popped) {
        if (this._popoutBtn) this._popoutBtn.textContent = popped ? "⧉ Dock" : "⧉ New Window";
    }

    _winButton(label, onClick) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = label;
        b.style.cssText = `border:0; border-radius:6px; padding:4px 10px; background:rgba(255,255,255,0.10);
            color:#eef2f6; cursor:pointer; font:12px sans-serif;`;
        b.addEventListener("mouseenter", () => b.style.background = "rgba(255,255,255,0.18)");
        b.addEventListener("mouseleave", () => b.style.background = "rgba(255,255,255,0.10)");
        b.addEventListener("click", onClick);
        return b;
    }

    doParse() {
        const errs = this.parse();
        this.prepare();
        this.drawTimeline();
        this._renderBackdrop();
        if (errs.length) this.setStatus("⚠ " + errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} more)` : ""));
        else this.setStatus(`Ready — ${this.totalDuration.toFixed(1)}s, ${this.cameraBeats.length} beats`);
    }

    showWindow() {
        if (this.external && !this.external.closed) { this.external.focus(); return; }
        if (this.window) {
            this.window.style.display = "flex";
            clampBelowMenuBar(this.window);   // never re-open off the top of the screen
            this.parse();
            setTimeout(() => { this.drawTimeline(); this._renderBackdrop(); }, 0);
        }
    }
    hideWindow() {
        if (this.external && !this.external.closed) { this.dockWindow(); return; }
        if (this._scrubbing) this._scrubExit();
        if (this.window) this.window.style.display = "none";
    }
    toggleWindow() {
        if (this.external && !this.external.closed) { this.external.focus(); return; }
        if (this.window) (this.window.style.display === "none" ? this.showWindow() : this.hideWindow());
    }
    stopAll() { if (this._previewing) this.stopPreview(); else if (this._scrubbing) this._scrubExit(); }

    // -----------------------------------------------------------------------
    // SCRUB  (cursor-line / timeline-click → position the preview at that time)
    // -----------------------------------------------------------------------

    // Map the script editor's cursor line to its event time and scrub there.
    _scrubToCursorLine() {
        const ta = this.textarea;
        if (!ta) return;
        this.parse(); this.prepare();
        if (this.totalDuration <= 0) return;
        const pos = ta.selectionStart;
        const lineNo = ta.value.slice(0, pos).split("\n").length; // 1-based
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
        this.drawTimeline();
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
        this._showBottomTimeline();
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
        this._hideBottomTimeline();
        if (this._scrubRestore) { this._scrubRestore(); this._scrubRestore = null; }
        if (this._scrubSavedPaused !== undefined) par.paused = this._scrubSavedPaused;
        setRenderOne(true);
        this.drawTimeline();
    }
}

// module-scope singleton
let scriptedVideo = null;

export function getScriptedVideo() {
    return scriptedVideo;
}

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
