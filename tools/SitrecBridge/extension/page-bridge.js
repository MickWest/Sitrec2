/**
 * SitrecBridge — Page Bridge
 *
 * Injected into the Sitrec page's MAIN WORLD (not the content script isolated world).
 * This script has direct access to all Sitrec globals:
 *   window.NodeMan, window.Sit, window.Globals, window.par,
 *   window.FileManager, window.LocalFrame, window.GlobalScene, etc.
 *
 * Receives commands from content-script.js via window.postMessage,
 * executes them against Sitrec's API, and sends results back.
 */

// ── MCP Debug Mode ──────────────────────────────────────────────────────────
// Tell Sitrec's assert() to capture asserts instead of hitting debugger.
// Asserts are collected in window._mcpAsserts and drained after each handler call.
window._mcpDebug = true;
window._mcpAsserts = [];

// ── Nonce Authentication ────────────────────────────────────────────────────
// The content script generates a random nonce per injection and sends it via
// postMessage after this module loads.  All subsequent messages must include
// the nonce to prevent spoofing by other scripts on the page.
let bridgeNonce = null;
let detectIntervalId = null;
let detectTimeoutId = null;

function drainAsserts() {
    const asserts = window._mcpAsserts;
    window._mcpAsserts = [];
    return asserts.length > 0 ? asserts : null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Tools pages (under /tools/) are standalone apps — always considered "ready"
const isToolsPage = /\/sitrec\/tools\//.test(window.location.pathname);

function isSitrecReady() {
    if (isToolsPage) return true;
    const el = document.getElementById("sitrec-objects-ready");
    return el && el.dataset.ready === "complete";
}

/**
 * Safely serialize a value, handling Three.js objects, circular refs, etc.
 */
function safeSerialize(val, depth = 0) {
    if (depth > 7) return "[max depth]";
    if (val === undefined) return undefined;
    if (val === null) return null;
    if (typeof val === "number" || typeof val === "boolean" || typeof val === "string") return val;

    // Three.js Vector3, Vector2, Euler, etc.
    if (val.isVector3) return { x: val.x, y: val.y, z: val.z, _type: "Vector3" };
    if (val.isVector2) return { x: val.x, y: val.y, _type: "Vector2" };
    if (val.isEuler) return { x: val.x, y: val.y, z: val.z, order: val.order, _type: "Euler" };
    if (val.isQuaternion) return { x: val.x, y: val.y, z: val.z, w: val.w, _type: "Quaternion" };
    if (val.isMatrix4) return { elements: Array.from(val.elements), _type: "Matrix4" };
    if (val.isColor) return { r: val.r, g: val.g, b: val.b, _type: "Color" };

    // Arrays
    if (Array.isArray(val)) {
        return val.slice(0, 100).map((v) => safeSerialize(v, depth + 1));
    }

    // Plain objects
    if (typeof val === "object") {
        const out = {};
        const keys = Object.keys(val).slice(0, 50);
        for (const k of keys) {
            try {
                out[k] = safeSerialize(val[k], depth + 1);
            } catch {
                out[k] = "[unserializable]";
            }
        }
        return out;
    }

    return String(val);
}

// ── Action Handlers ─────────────────────────────────────────────────────────

const handlers = {
    sitrec_get_sitch() {
        const Sit = window.Sit;
        if (!Sit) return { error: "Sit not available" };
        return {
            name: Sit.name,
            menuName: Sit.menuName,
            frames: Sit.frames,
            fps: Sit.fps,
            duration: Sit.frames / Sit.fps,
            lat: Sit.lat,
            lon: Sit.lon,
            alt: Sit.alt,
            startTime: Sit.startTime,
            isCustom: Sit.isCustom,
            canMod: Sit.canMod,
            buildTime: document.lastModified,
        };
    },

    async sitrec_load_sitch({ name }) {
        if (!name) return { error: "Missing 'name' parameter" };
        if (typeof window.newSitch !== "function") {
            return { error: "newSitch function not available" };
        }
        try {
            await window.newSitch(name);
            return { loaded: name, success: true };
        } catch (e) {
            return { error: `Failed to load sitch '${name}': ${e.message}` };
        }
    },

    sitrec_list_sitches() {
        const SitchMan = window.SitchMan;
        if (!SitchMan) {
            return { error: "SitchMan not available" };
        }
        // SitchMan.sitches is typically a map/object of sitch definitions
        const sitches = SitchMan.sitches || SitchMan.list || {};
        const result = [];
        for (const [key, val] of Object.entries(sitches)) {
            result.push({
                id: key,
                menuName: val.menuName || val.name || key,
                category: val.category,
            });
        }
        return result;
    },

    sitrec_list_nodes({ filter, typeFilter } = {}) {
        const NodeMan = window.NodeMan;
        if (!NodeMan) return { error: "NodeMan not available" };

        const nodes = [];
        const lowerFilter = filter?.toLowerCase();
        const lowerType = typeFilter?.toLowerCase();

        NodeMan.iterate((key, node) => {
            if (lowerFilter && !key.toLowerCase().includes(lowerFilter)) return;
            const className = node.constructor?.name || "CNode";
            if (lowerType && !className.toLowerCase().includes(lowerType)) return;

            nodes.push({
                id: key,
                type: className,
                visible: node.visible !== false,
                inputCount: node.inputs ? Object.keys(node.inputs).length : 0,
                outputCount: node.outputs ? node.outputs.length : 0,
            });
        });

        return { count: nodes.length, nodes };
    },

    sitrec_get_node({ id, frame } = {}) {
        const NodeMan = window.NodeMan;
        if (!NodeMan) return { error: "NodeMan not available" };
        if (!id) return { error: "Missing 'id' parameter" };

        const node = NodeMan.get(id);
        if (!node) return { error: `Node '${id}' not found` };

        const f = frame ?? window.par?.frame ?? 0;

        const inputs = {};
        if (node.inputs) {
            for (const [k, v] of Object.entries(node.inputs)) {
                inputs[k] = v?.id || String(v);
            }
        }

        const outputs = [];
        if (node.outputs) {
            for (const o of node.outputs) {
                outputs.push(o?.id || String(o));
            }
        }

        let value;
        try {
            const raw = node.getValue(f);
            value = safeSerialize(raw);
        } catch (e) {
            value = { error: e.message };
        }

        return {
            id: node.id,
            type: node.constructor?.name || "CNode",
            visible: node.visible !== false,
            inputs,
            outputs,
            frame: f,
            value,
        };
    },

    sitrec_get_frame() {
        const par = window.par;
        const Sit = window.Sit;
        return {
            frame: par?.frame ?? null,
            frames: Sit?.frames ?? null,
            fps: Sit?.fps ?? null,
            paused: par?.paused ?? null,
        };
    },

    sitrec_set_frame({ frame } = {}) {
        if (frame == null) return { error: "Missing 'frame' parameter" };
        const par = window.par;
        if (!par) return { error: "par not available" };
        par.frame = frame;
        par.renderOne = true;
        return { frame: par.frame };
    },

    sitrec_play_pause({ paused } = {}) {
        const par = window.par;
        if (!par) return { error: "par not available" };
        if (paused !== undefined) {
            par.paused = !!paused;
        } else {
            par.paused = !par.paused;
        }
        return { paused: par.paused };
    },

    sitrec_screenshot({ view, quality, maxWidth } = {}) {
        // quality: JPEG quality 0-100 (default 75). Use 100 or "png" for lossless PNG.
        // maxWidth: if set, downscale the captured image to this width (maintains aspect ratio).
        const usePng = quality === "png";
        const jpegQuality = usePng ? undefined : Math.min(100, Math.max(1, Number(quality) || 75)) / 100;
        const mimeType = usePng ? "image/png" : "image/jpeg";
        const dataUrlPrefix = usePng ? /^data:image\/png;base64,/ : /^data:image\/jpeg;base64,/;

        // Helper: optionally downscale a canvas, then export as data URL
        function exportCanvas(srcCanvas) {
            let canvas = srcCanvas;
            if (maxWidth && srcCanvas.width > maxWidth) {
                const scale = maxWidth / srcCanvas.width;
                const offscreen = document.createElement("canvas");
                offscreen.width = Math.round(srcCanvas.width * scale);
                offscreen.height = Math.round(srcCanvas.height * scale);
                const ctx = offscreen.getContext("2d");
                ctx.drawImage(srcCanvas, 0, 0, offscreen.width, offscreen.height);
                canvas = offscreen;
            }
            const dataUrl = usePng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", jpegQuality);
            const imageData = dataUrl.replace(dataUrlPrefix, "");
            return { imageData, mimeType };
        }

        const frame = Math.floor(window.par?.frame ?? 0);

        // If a specific view is requested, capture just that view's canvas
        // Accept shorthand: "main" → "mainView", "look" → "lookView"
        if (view) {
            const viewAliases = { main: "mainView", look: "lookView", videoView: "video" };
            const viewId = viewAliases[view] || view;
            const viewNode = window.NodeMan?.get(viewId);
            if (!viewNode) return { error: `View '${viewId}' not found` };
            // v.canvas, not renderer.domElement. For a 3D view the renderer draws into an
            // offscreen target and the result is composited onto v.canvas — which is also the
            // one surface the full-viewport path below reads, for every view, and it is correct
            // there for both the main and the look view.
            const baseCanvas = viewNode.canvas || viewNode.renderer?.domElement;
            if (!baseCanvas) return { error: `View '${viewId}' has no renderer or canvas` };
            if (!(baseCanvas.width > 0) || !(baseCanvas.height > 0)) {
                return { error: `View '${viewId}' has a zero-sized canvas` };
            }
            try {
                // ONE call, the same one the frame loop makes (see indexRender.js). renderCanvas()
                // IS the whole render for a 3D view: it calls renderTargetAndEffects(), which calls
                // renderSky() itself (CNodeView3D.js). The old code drove all three by hand, and
                // measurably wrecked the look view: sampling its canvas before and after gave
                // correct sky and terrain first — (100,153,174), (166,121,99) — and uniform R=G=B
                // grey after. Only the look view, which is the one carrying the IR/video effects
                // chain. The mechanism inside that chain was NOT pinned down, so no claim is made
                // here about which pass does it; what is established is that the extra calls cause
                // it and that a single renderCanvas() does not. Note the old code did not merely
                // return a wrong image — it wrote one to the LIVE canvas, where it stayed until
                // something else asked for a repaint.
                if (typeof viewNode.renderCanvas === "function") viewNode.renderCanvas(frame);
            } catch (e) {
                return { error: `Render error during screenshot: ${e.message}` };
            }

            // Composite the view's child views on top, mirroring the app's own single-view exporter
            // (CNodeView3D.js, "render this view to video"). Without them a single-view capture
            // silently drops everything drawn by an overlay — fit handles, measurement labels,
            // tracking cursors, the HUD — which is usually the thing it was taken to look at.
            //
            // The output frames the view's DIV, not the 3D canvas, because those are not the same
            // rectangle: under Match Video Aspect the 3D canvas is letterboxed inside the div
            // (measured on a 767x435 look view: canvas inset 2px and 4px shorter), while the
            // overlays cover the whole div. Stretching one onto the other puts every handle a few
            // pixels off the thing it is marking. So: size the output from the div, place the 3D
            // canvas in the sub-rectangle it actually occupies, and let the overlays span the rest.
            const rc = baseCanvas.getBoundingClientRect();
            const rd = (viewNode.div || baseCanvas).getBoundingClientRect();
            const usable = rc.width > 0 && rc.height > 0 && rd.width > 0 && rd.height > 0;
            // Backing-store pixels per CSS pixel, so the capture keeps the render's real resolution.
            const s = usable ? baseCanvas.width / rc.width : 1;

            const out = document.createElement("canvas");
            out.width = usable ? Math.max(1, Math.round(rd.width * s)) : baseCanvas.width;
            out.height = usable ? Math.max(1, Math.round(rd.height * s)) : baseCanvas.height;
            const outCtx = out.getContext("2d");
            outCtx.fillStyle = "#000000";
            outCtx.fillRect(0, 0, out.width, out.height);
            if (usable) {
                outCtx.drawImage(baseCanvas, (rc.left - rd.left) * s, (rc.top - rd.top) * s,
                    rc.width * s, rc.height * s);
            } else {
                outCtx.drawImage(baseCanvas, 0, 0, out.width, out.height);
            }

            const VM = window.Globals?.ViewMan || window.ViewMan;
            if (VM && typeof VM.iterate === "function") {
                if (typeof VM.computeEffectiveVisibility === "function") VM.computeEffectiveVisibility();
                VM.iterate((id, childView) => {
                    if (childView === viewNode || !childView.canvas) return;
                    // _effectivelyVisible, not .visible: a view can be hidden by an ancestor, and a
                    // hidden overlay's canvas keeps whatever it last drew — nothing clears it — so
                    // compositing it would paint stale handles back onto the image.
                    if (childView._effectivelyVisible === false) return;
                    const isOverlayChild = childView.overlayView === viewNode;
                    // relativeTo children are the HUDs (compass, Wescam MX, MQ9) — they are not
                    // overlays, but they are part of what this view looks like on screen.
                    if (!isOverlayChild && childView.in?.relativeTo !== viewNode) return;
                    if (childView.canvas.style.display === "none"
                        || childView.canvas.style.visibility === "hidden") return;
                    const alpha = childView.transparency !== undefined ? childView.transparency : 1;
                    if (alpha <= 0) return;
                    if (!(childView.canvas.width > 0) || !(childView.canvas.height > 0)) return;
                    childView.renderCanvas(frame);
                    outCtx.globalAlpha = alpha;
                    // Placed by its own offset within the parent, in CSS pixels scaled to backing
                    // pixels — a HUD does not necessarily fill the view.
                    outCtx.drawImage(childView.canvas,
                        (childView.leftPx - viewNode.leftPx) * s, (childView.topPx - viewNode.topPx) * s,
                        childView.widthPx * s, childView.heightPx * s);
                    outCtx.globalAlpha = 1;
                });
            }
            return exportCanvas(out);
        }

        // Default: composite all visible views (same as "Render Viewport Video")
        const ViewMan = window.Globals?.ViewMan || window.ViewMan;
        if (!ViewMan) return { error: "ViewMan not available" };

        try {
            if (typeof ViewMan.updateZOrder === "function") ViewMan.updateZOrder();
            ViewMan.computeEffectiveVisibility();
            const nonOverlays = [];
            const overlays = [];
            ViewMan.iterate((id, v) => {
                if (v._effectivelyVisible) {
                    if (v.overlayView) overlays.push(v);
                    else nonOverlays.push(v);
                }
            });
            // Match on-screen stacking: zIndex from updateZOrder (larger views
            // lower), not insertion order. Overlays stack with their parent div.
            nonOverlays.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

            // Build capture bounds from visible base views
            let minX = 0, minY = 0;
            let maxX = ViewMan.widthPx, maxY = ViewMan.heightPx;
            for (const v of nonOverlays) {
                if (!v.canvas) continue;
                const x = v.leftPx, y = v.topPx - ViewMan.topPx;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + v.widthPx);
                maxY = Math.max(maxY, y + v.heightPx);
            }

            const srcW = Math.max(1, Math.ceil(maxX - minX));
            const srcH = Math.max(1, Math.ceil(maxY - minY));
            const fullCanvas = document.createElement("canvas");
            fullCanvas.width = srcW;
            fullCanvas.height = srcH;
            const ctx = fullCanvas.getContext("2d");
            ctx.fillStyle = "#000000";
            ctx.fillRect(0, 0, srcW, srcH);

            // Re-render and composite each view bottom-up, its overlays right after it
            for (const v of nonOverlays) {
                v.renderCanvas(frame);
                if (v.canvas) {
                    ctx.drawImage(v.canvas, v.leftPx - minX, (v.topPx - ViewMan.topPx) - minY, v.widthPx, v.heightPx);
                }
                for (const ov of overlays) {
                    if (ov.overlayView !== v) continue;
                    const alpha = ov.transparency !== undefined ? ov.transparency : 1;
                    if (alpha <= 0 || !ov.canvas) continue;
                    if (ov.canvas.style.display === "none" || ov.canvas.style.visibility === "hidden") continue;
                    ov.renderCanvas(frame);
                    ctx.globalAlpha = alpha;
                    ctx.drawImage(ov.canvas, v.leftPx - minX, (v.topPx - ViewMan.topPx) - minY, v.widthPx, v.heightPx);
                    ctx.globalAlpha = 1;
                }
            }

            return exportCanvas(fullCanvas);
        } catch (e) {
            return { error: `Viewport composite error: ${e.message}` };
        }
    },

    sitrec_get_video_frame({ frame, quality, maxWidth } = {}) {
        const videoNode = window.NodeMan?.get("video", false);
        if (!videoNode) return { error: "No 'video' node found in this sitch" };
        const videoData = videoNode.videoData;
        if (!videoData) return { error: "Video node has no videoData (no video loaded)" };

        const targetFrame = (frame !== undefined) ? Math.floor(Number(frame)) : Math.floor(window.par?.frame ?? 0);
        const frameImage = videoData.getImage(targetFrame);
        if (!frameImage) return { error: `No image available for frame ${targetFrame}` };

        // Draw to a temporary canvas
        const w = frameImage.width || frameImage.videoWidth || videoData.videoWidth;
        const h = frameImage.height || frameImage.videoHeight || videoData.videoHeight;
        if (!w || !h) return { error: "Could not determine video frame dimensions" };

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(frameImage, 0, 0, w, h);

        // Quality / format
        const usePng = quality === "png";
        const jpegQuality = usePng ? undefined : Math.min(100, Math.max(1, Number(quality) || 75)) / 100;
        const mimeType = usePng ? "image/png" : "image/jpeg";
        const dataUrlPrefix = usePng ? /^data:image\/png;base64,/ : /^data:image\/jpeg;base64,/;

        // Optional downscale
        let exportCanvas = canvas;
        if (maxWidth && canvas.width > maxWidth) {
            const scale = maxWidth / canvas.width;
            const offscreen = document.createElement("canvas");
            offscreen.width = Math.round(canvas.width * scale);
            offscreen.height = Math.round(canvas.height * scale);
            offscreen.getContext("2d").drawImage(canvas, 0, 0, offscreen.width, offscreen.height);
            exportCanvas = offscreen;
        }

        const dataUrl = usePng
            ? exportCanvas.toDataURL("image/png")
            : exportCanvas.toDataURL("image/jpeg", jpegQuality);
        const imageData = dataUrl.replace(dataUrlPrefix, "");
        return { imageData, mimeType, frame: targetFrame, width: exportCanvas.width, height: exportCanvas.height };
    },

    sitrec_debug_log({ action, tail } = {}) {
        // Persistent console capture, independent of Sitrec's production-only debugLog.
        // Uses window._mcpDebugLog so state survives across handler calls.
        if (!window._mcpDebugLog) {
            window._mcpDebugLog = { buffer: [], enabled: false, originals: {} };
        }
        const state = window._mcpDebugLog;

        if (action === "enable") {
            if (state.enabled) return { status: "already enabled", entries: state.buffer.length };
            state.originals.log = console.log;
            state.originals.error = console.error;
            state.originals.warn = console.warn;
            const MAX_ENTRY_CHARS = 500;
            const capture = (level, args) => {
                let msg = args.map(a => {
                    if (a instanceof Error) return `${a.message}\n${a.stack}`;
                    if (typeof a === "object") { try { return JSON.stringify(a); } catch { return "[Unserializable]"; } }
                    return String(a);
                }).join(" ");
                if (msg.length > MAX_ENTRY_CHARS) msg = msg.slice(0, MAX_ENTRY_CHARS) + `… [truncated ${msg.length - MAX_ENTRY_CHARS} chars]`;
                state.buffer.push(`[${new Date().toISOString()}] ${level}: ${msg}`);
                if (state.buffer.length > 10000) state.buffer.shift();
            };
            console.log = new Proxy(state.originals.log, { apply(t, ctx, args) { capture("LOG", args); return Reflect.apply(t, ctx, args); } });
            console.error = new Proxy(state.originals.error, { apply(t, ctx, args) { capture("ERROR", args); return Reflect.apply(t, ctx, args); } });
            console.warn = new Proxy(state.originals.warn, { apply(t, ctx, args) { capture("WARN", args); return Reflect.apply(t, ctx, args); } });
            state.enabled = true;
            return { status: "enabled" };
        }

        if (action === "disable") {
            if (!state.enabled) return { status: "already disabled" };
            console.log = state.originals.log;
            console.error = state.originals.error;
            console.warn = state.originals.warn;
            state.enabled = false;
            return { status: "disabled", entries: state.buffer.length };
        }

        if (action === "clear") {
            state.buffer = [];
            return { status: "cleared" };
        }

        if (action === "export") {
            // tail: only return the last N entries (default: all)
            const entries = tail ? state.buffer.slice(-tail) : state.buffer;
            const log = entries.join("\n");
            return { enabled: state.enabled, entries: state.buffer.length, returned: entries.length, log };
        }

        // Default: status
        return { enabled: state.enabled, entries: state.buffer.length };
    },

    sitrec_eval({ expression } = {}) {
        if (!expression) return { error: "Missing 'expression' parameter" };
        try {
            // Evaluate in page context with access to all globals
            const result = new Function(`return (${expression})`)();
            return { result: safeSerialize(result) };
        } catch (e) {
            return { error: `Eval error: ${e.message}` };
        }
    },

    async sitrec_api_call({ fn, args } = {}) {
        if (!fn) return { error: "Missing 'fn' parameter" };
        const api = window.sitrecAPI;
        if (!api) return { error: "sitrecAPI not available (page may need rebuilding)" };
        try {
            const result = await api.handleAPICall({ fn, args: args || {} });
            return safeSerialize(result);
        } catch (e) {
            return { error: `API call error: ${e.message}` };
        }
    },

    sitrec_api_list() {
        const api = window.sitrecAPI;
        if (!api) return { error: "sitrecAPI not available (page may need rebuilding)" };
        try {
            return safeSerialize(api.getFullDocumentation());
        } catch (e) {
            return { error: `API list error: ${e.message}` };
        }
    },
};

// ── Message Listener ────────────────────────────────────────────────────────

window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (!event.data) return;

    // Handle nonce initialization from the content script. A fresh content
    // script context can reconnect after an extension reload, so we accept a
    // new nonce and restart detection instead of treating the bridge as
    // single-use for the lifetime of the page.
    if (event.data.source === "sitrec-bridge-init" && event.data.nonce) {
        bridgeNonce = event.data.nonce;
        console.log("[SitrecBridge:page] Nonce handshake complete, starting detection");
        startSitrecDetection();
        return;
    }

    if (event.data.source !== "sitrec-bridge-content") return;
    if (!bridgeNonce || event.data.nonce !== bridgeNonce) return; // reject unverified

    const { reqId, action, params } = event.data;

    // Check readiness for most actions (eval and status are allowed before ready)
    if (action !== "sitrec_eval" && !isSitrecReady()) {
        window.postMessage(
            {
                source: "sitrec-bridge-page",
                nonce: bridgeNonce,
                reqId,
                error: "Sitrec is not ready yet. Wait for the page to finish loading.",
            },
            "*"
        );
        return;
    }

    const handler = handlers[action];
    if (!handler) {
        window.postMessage(
            {
                source: "sitrec-bridge-page",
                nonce: bridgeNonce,
                reqId,
                error: `Unknown action: ${action}`,
            },
            "*"
        );
        return;
    }

    try {
        const result = await handler(params || {});
        const asserts = drainAsserts();
        const response = { source: "sitrec-bridge-page", nonce: bridgeNonce, reqId, result };
        if (asserts) response.asserts = asserts;
        window.postMessage(response, "*");
    } catch (e) {
        const asserts = drainAsserts();
        const response = { source: "sitrec-bridge-page", nonce: bridgeNonce, reqId, error: e.message };
        if (asserts) response.asserts = asserts;
        window.postMessage(response, "*");
    }
});

// ── Sitrec Detection ────────────────────────────────────────────────────────
// Tell the content script that this page is actually running Sitrec,
// so it can open the keepalive port and register the tab.
//
// Detection is deferred until the nonce handshake completes (startSitrecDetection
// is called from the message listener above).  Uses stronger checks than a bare
// window.Sit existence test to prevent trivial spoofing.

function isSitrecReal(log = false) {
    // Sitrec's ready marker — created by Sitrec's own initialization code
    const readyEl = document.getElementById("sitrec-objects-ready");
    if (readyEl) {
        if (log) console.log("[SitrecBridge:page] isSitrecReal: found #sitrec-objects-ready (data-ready=" + readyEl.dataset.ready + ")");
        return true;
    }
    // Core globals with expected internal structure (hard to convincingly fake)
    if (window.Sit && typeof window.Sit.name === "string" &&
        window.NodeMan && typeof window.NodeMan.iterate === "function") {
        if (log) console.log("[SitrecBridge:page] isSitrecReal: found Sit.name=" + window.Sit.name);
        return true;
    }
    if (log) {
        console.log("[SitrecBridge:page] isSitrecReal: NOT detected — "
            + "Sit=" + !!window.Sit
            + ", Sit.name=" + (window.Sit ? typeof window.Sit.name : "N/A")
            + ", NodeMan=" + !!window.NodeMan
            + ", #sitrec-objects-ready=" + !!readyEl);
    }
    return false;
}

function notifySitrecDetected() {
    const buildDir = window.__sitrecBuildDir || null;
    const pageType = isToolsPage ? "tool" : "sitrec";
    window.postMessage({ source: "sitrec-bridge-page", type: "sitrec-detected", nonce: bridgeNonce, buildDir, pageType }, "*");
    console.log("[SitrecBridge] Page bridge loaded — " + pageType + " detected" + (buildDir ? ` (build: ${buildDir})` : ""));
}

function startSitrecDetection() {
    console.log("[SitrecBridge:page] startSitrecDetection() — checking immediately...");

    if (detectIntervalId) {
        clearInterval(detectIntervalId);
        detectIntervalId = null;
    }
    if (detectTimeoutId) {
        clearTimeout(detectTimeoutId);
        detectTimeoutId = null;
    }

    // Tools pages are standalone apps — register immediately without Sitrec globals
    if (isToolsPage) {
        console.log("[SitrecBridge:page] Tools page detected:", window.location.pathname);
        notifySitrecDetected();
        return;
    }

    if (isSitrecReal(true)) {
        notifySitrecDetected();
    } else {
        console.log("[SitrecBridge:page] Sitrec not ready yet, polling every 500ms (30s timeout)...");
        let pollCount = 0;
        detectIntervalId = setInterval(() => {
            pollCount++;
            // Log every 5th poll (every 2.5s) to avoid spam
            const shouldLog = (pollCount % 5 === 0);
            if (shouldLog) {
                console.log("[SitrecBridge:page] Detection poll #" + pollCount + " (" + (pollCount * 0.5) + "s)...");
            }
            if (isSitrecReal(shouldLog)) {
                clearInterval(detectIntervalId);
                detectIntervalId = null;
                if (detectTimeoutId) {
                    clearTimeout(detectTimeoutId);
                    detectTimeoutId = null;
                }
                console.log("[SitrecBridge:page] Sitrec detected after " + (pollCount * 0.5) + "s");
                notifySitrecDetected();
            }
        }, 500);
        // Stop polling after 30 seconds — not a Sitrec page
        detectTimeoutId = setTimeout(() => {
            if (detectIntervalId) {
                clearInterval(detectIntervalId);
                detectIntervalId = null;
            }
            detectTimeoutId = null;
            if (!isSitrecReal(false)) {
                console.warn("[SitrecBridge:page] Detection TIMED OUT after 30s — giving up. "
                    + "Sit=" + !!window.Sit
                    + ", NodeMan=" + !!window.NodeMan
                    + ", #sitrec-objects-ready=" + !!document.getElementById("sitrec-objects-ready"));
            }
        }, 30000);
    }
}
