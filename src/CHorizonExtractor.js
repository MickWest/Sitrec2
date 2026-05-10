import {Globals, guiMenus, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {EventManager} from "./CEventManager";
import {CNode} from "./nodes/CNode";

// Manual horizon-angle extractor. The user enables this and a cross overlay
// appears on the video view. They drag the cross center to position it on
// the horizon, or grab one of four handles (at ~40% of the smaller video
// dimension from the centre, at 0°/90°/180°/270° relative to the cross's
// current rotation) to rotate the cross so its horizontal arm matches the
// visible horizon. Each move/rotate writes a keyframe; per-frame horizon
// state is then linearly interpolated between keyframes (and linearly
// extrapolated past the ends).
//
// Per-frame state is exposed via getHorizonAt(frame) → {x, y, angle}.
// Keyframes persist in localStorage keyed by sitch+video so an analyst
// can come back to a long session without losing work. Future: integrate
// with the sitch serialisation path.

class HorizonExtractor {
    constructor(videoView) {
        this.videoView = videoView;
        this.enabled = false;

        this.overlay = null;
        this.overlayCtx = null;
        this.overlayCreated = false;

        // Cross state in original-video coords. Angle is degrees, sign
        // follows atan2 in video-coord space (+Y down): positive angle
        // rotates handle 0 from +X toward +Y (visually clockwise on screen).
        const dims = this.getDims();
        this.cx = dims.width / 2;
        this.cy = dims.height / 2;
        this.angle = 0;

        this.keyframes = new Map();

        // Interaction state
        this.dragMode = null;
        this.dragHandleIdx = -1;
        // Offset from cross centre to grab point in video coords. Lets the
        // user grab any point inside the centre-hit zone and translate
        // without the cross teleporting to the cursor.
        this.dragOffsetX = 0;
        this.dragOffsetY = 0;

        // Step size in frames for keyboard navigation. Sensible default for a
        // 30 fps video: half a second between checkpoints means an analyst
        // can scrub a 9000-frame clip with ~600 stops and let interpolation
        // fill in. Exposed in the menu folder.
        this.stepFrames = 15;
        // Show the on-screen onboarding hint until the user has interacted
        // (committed any keyframe). Avoids permanent screen clutter while
        // still helping the first-time user.
        this.showHint = this.keyframes.size === 0;

        this.hookMouseHandler();
        this.hookKeyboardHandler();
        this.loadFromStorage();
        if (this.keyframes.size > 0) this.showHint = false;
    }

    storageKey() {
        const sitch = Sit?.name || 'default';
        const vd = this.videoView?.videoData;
        const file = vd?.filename || vd?.id || 'none';
        return `sitrec_horizonExtractor_${sitch}_${file}`;
    }

    saveToStorage() {
        try {
            localStorage.setItem(this.storageKey(),
                JSON.stringify(Array.from(this.keyframes.entries())));
        } catch (e) {
            // Quota / disabled storage — silently degrade. The session
            // still works; we just lose persistence.
        }
    }

    loadFromStorage() {
        try {
            const raw = localStorage.getItem(this.storageKey());
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                this.keyframes = new Map(arr);
            }
        } catch (e) {
            // Bad data — ignore and start fresh.
        }
    }

    getDims() {
        const vd = this.videoView?.videoData;
        return {
            width: vd?.originalVideoWidth || 1920,
            height: vd?.originalVideoHeight || 1080,
        };
    }

    // Handle distance from cross centre, in *original-video coords*.
    // User spec: 80% of half the smallest dimension == 0.4 × min(w, h).
    getHandleRadius() {
        const d = this.getDims();
        return 0.4 * Math.min(d.width, d.height);
    }

    // Returns [right, up, left, down] handle centres in video coords.
    // "right" is the handle 0° from the cross's horizontal arm.
    getHandlePositions() {
        const r = this.getHandleRadius();
        const a = this.angle * Math.PI / 180;
        const ca = Math.cos(a), sa = Math.sin(a);
        return [
            {x: this.cx + ca * r, y: this.cy + sa * r},
            {x: this.cx - sa * r, y: this.cy + ca * r},
            {x: this.cx - ca * r, y: this.cy - sa * r},
            {x: this.cx + sa * r, y: this.cy - ca * r},
        ];
    }

    enable() {
        this.enabled = true;
        this.ensureOverlay();
        this.showOverlay();
        // Snap cross to interpolated state for the current frame
        this.applyInterpolation(Math.floor(par.frame));
        setRenderOne(true);
    }

    disable() {
        this.enabled = false;
        this.hideOverlay();
        setRenderOne(true);
    }

    ensureOverlay() {
        if (this.overlayCreated) return;
        this.overlayCreated = true;

        this.overlay = document.createElement('canvas');
        this.overlay.style.position = 'absolute';
        this.overlay.style.top = '0';
        this.overlay.style.left = '0';
        this.overlay.style.width = '100%';
        this.overlay.style.height = '100%';
        // pointerEvents: none — clicks pass through to the canvas below, which
        // dispatches to the videoView mouse handler chain we've hooked into.
        this.overlay.style.pointerEvents = 'none';
        this.overlay.style.zIndex = '99';
        this.videoView.div.appendChild(this.overlay);
        this.overlayCtx = this.overlay.getContext('2d');

        // renderHooked is module-level (see bottom of file) so resetting the
        // singleton on sitch reload clears it and the next instance re-hooks
        // the new videoView's renderCanvas. If we stored the flag on `this`
        // the new (post-reload) instance would think the patch was already
        // installed and never patch the new videoView.
        if (!renderHooked) {
            renderHooked = true;
            const originalRender = this.videoView.renderCanvas.bind(this.videoView);
            this.videoView.renderCanvas = (frame) => {
                originalRender(frame);
                if (horizonExtractor && horizonExtractor.enabled) {
                    horizonExtractor.renderOverlay(frame);
                }
            };
        }
    }

    showOverlay() { if (this.overlay) this.overlay.style.display = 'block'; }
    hideOverlay() { if (this.overlay) this.overlay.style.display = 'none'; }

    // Step playback by N frames or jump to neighbouring keyframes. Wired
    // to ←/→ (step), Shift+←/→ (single frame), J/K (jump prev/next keyframe)
    // when the overlay is enabled.
    hookKeyboardHandler() {
        EventManager.addEventListener("keydown", (data) => {
            if (!this.enabled) return;
            const ev = data.event;
            // Skip if a text input has focus (KeyBoardHandler upstream already
            // filters this for the main keydown dispatch, but be defensive).
            if (ev?.target?.tagName === "INPUT" || ev?.target?.tagName === "TEXTAREA") return;
            const key = data.key?.toLowerCase();
            const last = Sit?.frames ? Sit.frames - 1 : Math.max(0, par.frame);
            const step = ev?.shiftKey ? 1 : this.stepFrames;
            if (data.keyCode === "ArrowLeft") {
                par.frame = Math.max(0, Math.floor(par.frame) - step);
                ev?.preventDefault?.();
                setRenderOne(true);
            } else if (data.keyCode === "ArrowRight") {
                par.frame = Math.min(last, Math.floor(par.frame) + step);
                ev?.preventDefault?.();
                setRenderOne(true);
            } else if (key === "j") {
                // Jump to previous keyframe (strict <)
                const cur = Math.floor(par.frame);
                const prev = Array.from(this.keyframes.keys())
                    .filter(f => f < cur)
                    .sort((a, b) => b - a)[0];
                if (prev !== undefined) { par.frame = prev; setRenderOne(true); }
            } else if (key === "k") {
                // Jump to next keyframe (strict >)
                const cur = Math.floor(par.frame);
                const next = Array.from(this.keyframes.keys())
                    .filter(f => f > cur)
                    .sort((a, b) => a - b)[0];
                if (next !== undefined) { par.frame = next; setRenderOne(true); }
            }
        });
    }

    hookMouseHandler() {
        const mouse = this.videoView.mouse;
        if (!mouse) return;

        const origDown = mouse.handlers.down;
        const origDrag = mouse.handlers.drag;
        const origUp = mouse.handlers.up;

        mouse.handlers.down = (e) => {
            if (this.enabled) {
                // Shift+click on the cross centre deletes the keyframe at
                // the current frame (if any) and consumes the event — quick
                // alternative to the menu "Delete Keyframe at Current Frame".
                if (e?.shiftKey && this.isOverCentre()) {
                    this.deleteKeyframeAt(Math.floor(par.frame));
                    return;
                }
                if (this.tryHitTest()) return;
            }
            if (origDown) origDown(e);
        };

        mouse.handlers.drag = (e) => {
            if (this.enabled && this.dragMode) {
                this.handleDrag();
                return;
            }
            if (origDrag) origDrag(e);
        };

        mouse.handlers.up = (e) => {
            if (this.enabled && this.dragMode) {
                this.dragMode = null;
                this.dragHandleIdx = -1;
                return;
            }
            if (origUp) origUp(e);
        };
    }

    // Convert one of the videoView's `mouse.x/y` (canvas coords) to original-
    // video coords. Picks the same conversion the auto-tracker uses so the
    // hit-tests survive zoom and resolution-preset changes.
    mouseToVideo() {
        const m = this.videoView.mouse;
        return this.videoView.canvasToVideoCoordsOriginal(m.x, m.y);
    }

    // Sample 12 canvas pixels into original-video coords at the current
    // mouse position. Uses the live canvas-to-video transform so zoom and
    // resolution-preset changes both adjust the hit radius automatically.
    canvasPixelsToVideoUnits(canvasPx) {
        const m = this.videoView.mouse;
        const [a, _] = this.videoView.canvasToVideoCoordsOriginal(m.x, m.y);
        const [b, __] = this.videoView.canvasToVideoCoordsOriginal(m.x + canvasPx, m.y);
        return Math.abs(b - a);
    }

    // Quick predicate used by the shift+click-to-delete shortcut. Same
    // hit-zone as the centre-translate hit.
    isOverCentre() {
        const [vx, vy] = this.mouseToVideo();
        const hitR = this.canvasPixelsToVideoUnits(12);
        const dxc = vx - this.cx, dyc = vy - this.cy;
        return dxc * dxc + dyc * dyc <= hitR * hitR * 9;
    }

    // Hit-test mouse position against handles (priority) then centre. Returns
    // true if a drag was initiated and we should consume the event.
    tryHitTest() {
        const [vx, vy] = this.mouseToVideo();
        const hitR = this.canvasPixelsToVideoUnits(12);
        const hitR2 = hitR * hitR;

        const handles = this.getHandlePositions();
        for (let i = 0; i < handles.length; i++) {
            const dx = vx - handles[i].x, dy = vy - handles[i].y;
            if (dx * dx + dy * dy <= hitR2) {
                this.dragMode = 'rotate';
                this.dragHandleIdx = i;
                return true;
            }
        }

        // Centre: a bigger hit area (3× the radius). Save the grab offset
        // so translate-drag preserves the relative position of the cursor
        // to the cross centre — the cross won't teleport to the cursor on
        // grab.
        const dxc = vx - this.cx, dyc = vy - this.cy;
        if (dxc * dxc + dyc * dyc <= hitR2 * 9) {
            this.dragMode = 'translate';
            this.dragOffsetX = dxc;
            this.dragOffsetY = dyc;
            return true;
        }
        return false;
    }

    handleDrag() {
        const [vx, vy] = this.mouseToVideo();
        if (this.dragMode === 'translate') {
            // Preserve grab offset so the cross doesn't teleport.
            this.cx = vx - this.dragOffsetX;
            this.cy = vy - this.dragOffsetY;
        } else if (this.dragMode === 'rotate') {
            // Compute world angle from cross centre to mouse, then subtract
            // the handle's intrinsic offset so the grabbed handle follows
            // the cursor exactly.
            const dx = vx - this.cx, dy = vy - this.cy;
            if (dx * dx + dy * dy < 1e-6) return;
            const worldAngle = Math.atan2(dy, dx) * 180 / Math.PI;
            const handleOffset = this.dragHandleIdx * 90;
            this.angle = this.normaliseAngle(worldAngle - handleOffset);
        }
        this.commitKeyframe();
        setRenderOne(true);
    }

    normaliseAngle(a) {
        while (a > 180) a -= 360;
        while (a <= -180) a += 360;
        return a;
    }

    commitKeyframe() {
        const f = Math.floor(par.frame);
        this.keyframes.set(f, {x: this.cx, y: this.cy, angle: this.angle});
        this.saveToStorage();
        // First interaction dismisses the onboarding hint.
        if (this.showHint) this.showHint = false;
    }

    clearKeyframes() {
        this.keyframes.clear();
        this.saveToStorage();
        setRenderOne(true);
    }

    deleteKeyframeAt(frame) {
        this.keyframes.delete(frame);
        this.saveToStorage();
        setRenderOne(true);
    }

    // Linear interpolation between bracketing keyframes; linear extrapolation
    // from the nearest two outside the keyframe range. Angle interpolation
    // takes the shortest-arc path (handles wrap at ±180°).
    getHorizonAt(frame) {
        if (this.keyframes.size === 0) return null;
        const frames = Array.from(this.keyframes.keys()).sort((a, b) => a - b);
        if (this.keyframes.has(frame)) return {...this.keyframes.get(frame)};

        let prev = null, next = null;
        for (const f of frames) {
            if (f < frame) prev = f;
            else if (f > frame) { next = f; break; }
        }

        if (prev !== null && next !== null) {
            return this.lerpKeyframes(prev, next, frame);
        }
        if (prev === null) {
            // Before first keyframe; extrapolate from the first two if we
            // have them, else hold.
            if (frames.length >= 2) return this.lerpKeyframes(frames[0], frames[1], frame);
            return {...this.keyframes.get(frames[0])};
        }
        // After last
        if (frames.length >= 2) {
            return this.lerpKeyframes(frames[frames.length - 2], frames[frames.length - 1], frame);
        }
        return {...this.keyframes.get(prev)};
    }

    lerpKeyframes(fa, fb, frame) {
        const a = this.keyframes.get(fa);
        const b = this.keyframes.get(fb);
        const t = (frame - fa) / (fb - fa);
        let dAngle = b.angle - a.angle;
        if (dAngle > 180) dAngle -= 360;
        else if (dAngle < -180) dAngle += 360;
        return {
            x: a.x + t * (b.x - a.x),
            y: a.y + t * (b.y - a.y),
            angle: this.normaliseAngle(a.angle + t * dAngle),
        };
    }

    // Pull state from interpolation. Called per frame from renderOverlay so
    // the cross tracks playback when not being dragged.
    applyInterpolation(frame) {
        if (this.dragMode) return; // don't yank from under the user
        const s = this.getHorizonAt(frame);
        if (s) {
            this.cx = s.x;
            this.cy = s.y;
            this.angle = s.angle;
        }
    }

    renderOverlay(frame) {
        if (!this.enabled || !this.overlay) return;

        this.applyInterpolation(frame);

        const w = this.videoView.widthPx;
        const h = this.videoView.heightPx;
        if (this.overlay.width !== w || this.overlay.height !== h) {
            this.overlay.width = w;
            this.overlay.height = h;
        }
        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, w, h);

        // Centre and handles in canvas coords
        const [cxC, cyC] = this.videoView.videoToCanvasCoordsOriginal(this.cx, this.cy);
        const handles = this.getHandlePositions().map(p => {
            const [x, y] = this.videoView.videoToCanvasCoordsOriginal(p.x, p.y);
            return {x, y};
        });

        // Horizon arm direction (centre → handle 0)
        const dx = handles[0].x - cxC;
        const dy = handles[0].y - cyC;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return;
        const ux = dx / len, uy = dy / len;
        const px = -uy, py = ux; // perpendicular
        const L = Math.max(w, h) * 2; // long enough to exceed the canvas

        // Horizon line (horizontal arm)
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cxC - ux * L, cyC - uy * L);
        ctx.lineTo(cxC + ux * L, cyC + uy * L);
        ctx.stroke();

        // Vertical / perpendicular line
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cxC - px * L, cyC - py * L);
        ctx.lineTo(cxC + px * L, cyC + py * L);
        ctx.stroke();

        // Handles
        ctx.fillStyle = 'rgba(0, 255, 255, 0.95)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 1;
        for (const hc of handles) {
            ctx.beginPath();
            ctx.arc(hc.x, hc.y, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Centre disc
        ctx.fillStyle = 'rgba(255, 0, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(cxC, cyC, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.stroke();

        // Keyframe ring on this exact frame
        if (this.keyframes.has(Math.floor(frame))) {
            ctx.strokeStyle = 'rgba(255, 255, 0, 1)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cxC, cyC, 14, 0, Math.PI * 2);
            ctx.stroke();
        }

        // HUD text — angle and (#keyframes)
        ctx.font = '12px monospace';
        ctx.fillStyle = 'rgba(0, 255, 255, 0.95)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
        ctx.lineWidth = 3;
        const label = `${this.angle.toFixed(2)}°   keyframes: ${this.keyframes.size}`;
        ctx.strokeText(label, cxC + 18, cyC - 18);
        ctx.fillText(label, cxC + 18, cyC - 18);

        // Onboarding hint, visible until the user commits their first
        // keyframe. Drawn at the top of the video so it doesn't sit on
        // the very pixels being measured.
        if (this.showHint) {
            const hint = [
                "Horizon Extractor",
                "• Drag the magenta centre to position the cross",
                "• Drag a cyan handle to rotate; horizontal line = horizon",
                "• Each move/rotate writes a keyframe at the current frame",
                "• ← / → step " + this.stepFrames + " frames    Shift+← / → step 1",
                "• J / K jump to previous / next keyframe",
                "• Shift+click centre to delete current keyframe",
            ];
            ctx.font = '12px monospace';
            ctx.textBaseline = 'top';
            const pad = 8, lh = 16;
            const boxW = 460, boxH = hint.length * lh + pad * 2;
            const x = 10, y = 10;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
            ctx.fillRect(x, y, boxW, boxH);
            ctx.fillStyle = 'rgba(0, 255, 255, 0.95)';
            for (let i = 0; i < hint.length; i++) {
                ctx.fillText(hint[i], x + pad, y + pad + i * lh);
            }
            ctx.textBaseline = 'alphabetic';
        }
    }
}

// Data-graph node exposing the horizon extractor's per-frame angle (degrees,
// CW-positive in screen space — matches aircraft bank-angle sign for a pilot
// view: right-bank → horizon tilts CW → positive). Used by CNodeTurnRateBS
// to derive a "From Bank" turn-rate source for the Simple Flight Sim. When
// no keyframes exist the node returns 0 (straight & level).
export class CNodeHorizonAngle extends CNode {
    constructor(v) {
        super(v);
        this.frames = v.frames ?? Sit.frames ?? 0;
        this.isNumber = true;
    }

    getValueFrame(f) {
        if (!horizonExtractor) return 0;
        const s = horizonExtractor.getHorizonAt(f);
        return s ? s.angle : 0;
    }
}

// Module-level state (mirrors the ObjectTracker pattern). `horizonExtractor`
// is created lazily on first menu-action. `renderHooked` is module-level
// (not on the instance) so resetHorizonExtractor() can clear it and the
// next-loaded sitch's videoView gets its renderCanvas re-patched. The menu
// folder is also re-created on each sitch load — setupHorizonExtractorMenu
// is idempotent via the horizonFolder===null check.
let horizonExtractor = null;
let renderHooked = false;
let enableMenuItem = null;
let horizonFolder = null;

export function getHorizonExtractor() { return horizonExtractor; }

// Sitch-JSON round-trip. localStorage gives a session-survives-reload
// guarantee, but a saved sitch should also embed its keyframes so a
// shared/reloaded URL reproduces the analyst's work. Wired into
// CustomManagerSerialize (out.horizonExtractor = serializeHorizonExtractor()
// on save; deserializeHorizonExtractor(data.horizonExtractor) on load).
export function serializeHorizonExtractor() {
    if (!horizonExtractor || horizonExtractor.keyframes.size === 0) return null;
    return {
        keyframes: Array.from(horizonExtractor.keyframes.entries()),
    };
}

export function deserializeHorizonExtractor(data) {
    if (!data || !Array.isArray(data.keyframes)) return;
    const videoView = NodeMan.get("video", false);
    if (!videoView) return;
    if (!horizonExtractor) horizonExtractor = new HorizonExtractor(videoView);
    horizonExtractor.keyframes = new Map(data.keyframes);
    horizonExtractor.showHint = false; // returning user has prior work
    horizonExtractor.saveToStorage();
    setRenderOne(true);
}

// Called from index.js disposeAll() path (alongside resetObjectTracking)
// on every sitch reload so we don't leak handler closures or render-hook
// references pointing into the disposed videoView.
export function resetHorizonExtractor() {
    if (horizonExtractor) {
        horizonExtractor.disable();
        horizonExtractor = null;
    }
    renderHooked = false;
    enableMenuItem = null;
    horizonFolder = null;
}

function ensureExtractor() {
    if (horizonExtractor) return horizonExtractor;
    const videoView = NodeMan.get("video", false);
    if (!videoView) return null;
    horizonExtractor = new HorizonExtractor(videoView);
    return horizonExtractor;
}

function toggleEnable() {
    const he = ensureExtractor();
    if (!he) return;
    if (he.enabled) {
        he.disable();
        if (enableMenuItem) enableMenuItem.name("Enable Horizon Extractor");
    } else {
        he.enable();
        if (enableMenuItem) enableMenuItem.name("Disable Horizon Extractor");
    }
}

function clearAll() {
    if (!horizonExtractor) return;
    horizonExtractor.clearKeyframes();
}

function deleteCurrentKeyframe() {
    if (!horizonExtractor) return;
    horizonExtractor.deleteKeyframeAt(Math.floor(par.frame));
}

// Build the Horizon Extractor sub-folder in the Video menu. Called from
// CustomManagerSetup after setupOSDDataSeriesController so it appears
// immediately below the OSD Tracker controls.
export function setupHorizonExtractorMenu() {
    if (!guiMenus.video) return;
    if (horizonFolder) return; // idempotent (re-run on every sitch load)

    horizonFolder = guiMenus.video.addFolder("Horizon Extractor")
        .close()
        .tooltip("Manually mark the horizon angle on a video. Move the cross to position it; grab any of the four handles to rotate. Each move/rotate writes a keyframe.");

    const actions = {
        enable: toggleEnable,
        clearAll: clearAll,
        deleteCurrent: deleteCurrentKeyframe,
        showHintAgain: () => {
            const he = ensureExtractor();
            if (he) { he.showHint = true; setRenderOne(true); }
        },
    };

    enableMenuItem = horizonFolder.add(actions, "enable").name("Enable Horizon Extractor")
        .tooltip("Toggle the horizon-cross overlay on the video view");

    // Step size for ←/→ keyboard navigation. Wired to the singleton via a
    // proxy object so it survives the (lazy) extractor instantiation.
    const stepProxy = {
        get stepFrames() { return ensureExtractor()?.stepFrames ?? 15; },
        set stepFrames(v) {
            const he = ensureExtractor();
            if (he) he.stepFrames = Math.max(1, Math.floor(v));
        },
    };
    horizonFolder.add(stepProxy, "stepFrames", 1, 120, 1).name("Step Frames")
        .tooltip("How many frames the ← / → keys move when the overlay is enabled (Shift+arrow always steps 1)");

    horizonFolder.add(actions, "deleteCurrent").name("Delete Keyframe at Current Frame")
        .tooltip("Remove the keyframe at the current playback frame, if any (Shift+click on the cross centre does the same)");

    horizonFolder.add(actions, "clearAll").name("Clear All Keyframes")
        .tooltip("Remove all horizon keyframes (also wipes localStorage for this video)");

    horizonFolder.add(actions, "showHintAgain").name("Show Hint")
        .tooltip("Re-display the on-screen interaction hint");
}
