// simple UI intermediate class that just has a canvas.
// we use this for the CNodeViewUI and the (upcoming) CNodeVideoView
// passing in an "overlayView" parameter will attache
import {CNodeView} from "./CNodeView";
import {guiMenus, setRenderOne} from "../Globals";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {isKeyHeld} from "../KeyBoardHandler";

// Largest possible RGB distance, sqrt(3 * 255^2) — the 100% end of Key Tolerance.
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);


export class CNodeViewCanvas extends CNodeView {
    constructor(v) {
        super(v)

        this.autoFill = v.autoFill;

        this.canvas = document.createElement('canvas')
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = 0 + 'px';
        this.canvas.style.left = 0 + 'px';

        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";

        // Single-pixel 25% transparent grey border so view edges are always visible.
        // Base (free-standing) views ONLY. The canvas fills the div and would otherwise
        // paint over the div's outline, so the inset outline is duplicated here. Skip it for
        // attached views: overlay views (overlayView) share the parent's already-bordered div,
        // and relativeTo views (e.g. the compass HUD) would otherwise draw their own distinct
        // grey sub-box. Predicate matches the codebase's "is a real base window" test
        // (DragResizeUtils/CLayoutManager/CViewManager). Offset -1px keeps it inside bounds.
        if (!this.overlayView && !this.in.relativeTo) {
            this.canvas.style.outline = '1px solid rgba(128, 128, 128, 0.25)';
            this.canvas.style.outlineOffset = '-1px';
        }

        // this.canvasWidth = v.canvasWidth;
        // this.canvasHeight = v.canvasHeight;

        this.optionalInputs(["canvasWidth", "canvasHeight"])
        
        this._pendingCanvasResize = false;

        if (v.transparency !== undefined) {
            this.transparency = v.transparency;
            this.canvas.style.opacity = this.transparency;
            new CNodeGUIValue({
                id: this.id+"_transparency",
                value: this.transparency, start: 0, end: 1, step: 0.01,
                desc: "Vid Overlay Trans %",
                tip: "If non-zero, then the video will overlay the look view, with this transparency (0-1)\nIf there's no video, it will use a black screen as overlay",
                onChange: (value) => {
                    this.transparency = value;
                    this.canvas.style.opacity = this.transparency;
                }
            }, guiMenus.view)

            // COLOUR KEY. The overlay blend above is uniform: the whole video canvas
            // is drawn over the look view at one opacity, so anything in the 3D view
            // is at best a ghost. The key punches specific colours back through at
            // full strength — every pixel of the UNDERLYING view within tolerance of
            // the key colour is copied on top of the video.
            //
            // Why that reads as full strength at ANY transparency: CSS composites
            // this canvas as t*overlay + (1-t)*underlying, and a keyed pixel has the
            // SAME colour in both (we copied it from the view below), so the two
            // terms sum back to that colour whatever t is.
            //
            // The intended use is annotation: paint magenta on the ground with
            // "Paint On Ground", key on magenta, and the painted region shows solid
            // over the video while everything else stays a faint blend. Tolerance
            // matters because the 3D view SHADES the paint (day/night lighting), so
            // the rendered pixels sit near the paint colour rather than on it.
            this.keyColor = v.keyColor ?? 0xff00ff;   // magenta: rare in real imagery
            this.addSimpleSerial("keyColor");
            guiMenus.view.addColor(this, "keyColor")
                .name("Key Color")
                .tooltip("Colour in the look view that comes through the video overlay at full strength. Works with Key Tolerance — at 0 tolerance nothing is keyed")
                .listen()
                .onChange(() => setRenderOne(true));

            // 0 = off, and off is free: the key pass returns before touching a pixel.
            this.keyToleranceNode = new CNodeGUIValue({
                id: this.id + "_keyTolerance",
                value: v.keyTolerance ?? 0, start: 0, end: 100, step: 0.5,
                desc: "Key Tolerance %",
                tip: "How far from Key Color a look-view pixel may be and still come through onto the video overlay, as a percentage of the largest possible colour difference. 0 = off. Raise it until the shaded/antialiased edges of the keyed area fill in",
                onChange: () => setRenderOne(true),
            }, guiMenus.view)
        }


       // this.adjustSize()

        this.div.appendChild(this.canvas)
    }

    dispose() {
        super.dispose()
        this.div.removeChild(this.canvas)
        this.canvas = null;
        this._keyCanvas = null;
        this._keyCtx = null;
        this._keyImageData = null;
    }

    // Copy every pixel of the UNDERLYING view that is within Key Tolerance of Key
    // Color on top of whatever this overlay canvas already holds. Call it LAST in a
    // subclass's renderCanvas, once the frame is fully drawn.
    //
    // The underlying view is a WebGL canvas with no preserveDrawingBuffer, so its
    // drawing buffer is only readable inside the animation frame that drew it. That
    // holds here: every view's renderCanvas runs in one frame (see indexRender), and
    // an overlay's parent is created before it, so the parent has already rendered.
    // If it ever hadn't, the read would come back empty and this would simply key
    // nothing — never an error.
    //
    // ALIGNMENT is measured, never assumed. The two canvases share a div but do NOT
    // generally cover the same rectangle: a 3D view is letterboxed inside its div to
    // hold the video's aspect ratio (e.g. canvas.style.left = 31px, 773 of the div's
    // 835 CSS px), the backing resolutions are unrelated (880x495 vs 1670x870 at
    // DPR 2), and the overlay's 2D context carries its own transform. Assuming a
    // full-canvas-to-full-canvas map stretched the keyed layer by the letterbox
    // ratio and shifted it by the inset, which showed up as a visible DOUBLE image
    // of anything keyed.
    //
    // So the mapping is derived from the two canvases' on-screen bounding rects,
    // converted into this canvas's BACKING pixels, and the composite is then done at
    // the identity transform 1:1. That is correct for any letterbox, any device
    // pixel ratio, any pair of backing resolutions, and whatever transform the
    // caller drew its frame with. It also covers the look view's video-matched
    // "pixel zoom" for free: that canvas holds the DISPLAYED magnified crop, and its
    // bounding rect is where that crop lands on screen.
    applyColorKeyFromUnderlyingView() {
        const tolerancePct = this.keyToleranceNode?.v0 ?? 0;
        if (!(tolerancePct > 0)) return;                 // off — costs nothing
        const source = this.overlayView?.canvas;
        if (!source || !source.width || !source.height) return;
        const w = this.canvas?.width, h = this.canvas?.height;
        if (!w || !h) return;

        // Screen geometry of both canvases, and the source's placement within this
        // canvas expressed in backing pixels.
        const dstRect = this.canvas.getBoundingClientRect();
        const srcRect = source.getBoundingClientRect();
        if (dstRect.width <= 0 || dstRect.height <= 0) return;
        if (srcRect.width <= 0 || srcRect.height <= 0) return;
        const scaleX = w / dstRect.width;
        const scaleY = h / dstRect.height;
        const dx = (srcRect.left - dstRect.left) * scaleX;
        const dy = (srcRect.top - dstRect.top) * scaleY;
        const dw = srcRect.width * scaleX;
        const dh = srcRect.height * scaleY;

        // Scratch canvas + ImageData, reused across frames — this runs per frame, and
        // reallocating a screen-sized buffer each time is what makes naive
        // per-pixel canvas work slow.
        if (!this._keyCanvas || this._keyCanvas.width !== w || this._keyCanvas.height !== h) {
            this._keyCanvas = document.createElement("canvas");
            this._keyCanvas.width = w;
            this._keyCanvas.height = h;
            this._keyCtx = this._keyCanvas.getContext("2d", {willReadFrequently: true});
            this._keyImageData = null;
        }
        const keyCtx = this._keyCtx;
        if (!keyCtx) return;

        keyCtx.setTransform(1, 0, 0, 1, 0, 0);
        keyCtx.clearRect(0, 0, w, h);
        // Nearest-neighbour on purpose: every key-canvas pixel then holds one real
        // rendered colour. Interpolation would invent blends of the key colour and
        // its surroundings along every edge, which the tolerance test cannot tell
        // apart from genuinely-near-key pixels, so the keyed area would creep
        // outwards as tolerance is raised to cope with lighting.
        keyCtx.imageSmoothingEnabled = false;
        try {
            keyCtx.drawImage(source, 0, 0, source.width, source.height, dx, dy, dw, dh);
        } catch (e) {
            return; // source canvas not readable this frame
        }

        // Only the sub-rect the source actually landed in needs testing; the
        // letterbox margins around it were cleared and must stay transparent.
        const ix = Math.max(0, Math.floor(dx));
        const iy = Math.max(0, Math.floor(dy));
        const iw = Math.min(w - ix, Math.ceil(dx + dw) - ix);
        const ih = Math.min(h - iy, Math.ceil(dy + dh) - iy);
        if (iw <= 0 || ih <= 0) return;

        const imageData = keyCtx.getImageData(ix, iy, iw, ih);
        const data = imageData.data;
        const key = this.keyColor & 0xffffff;
        const kr = (key >> 16) & 255, kg = (key >> 8) & 255, kb = key & 255;
        const threshold = (tolerancePct / 100) * MAX_RGB_DISTANCE;
        const threshold2 = threshold * threshold;

        // Knock out everything that ISN'T the key colour. Squared Euclidean distance
        // in RGB, with a per-channel box test first: the box rejects the overwhelming
        // majority of pixels in one comparison, and only survivors pay for the
        // multiplies.
        const box = threshold;
        for (let i = 0; i < data.length; i += 4) {
            const dr = data[i] - kr;
            if (dr > box || dr < -box) { data[i + 3] = 0; continue; }
            const dg = data[i + 1] - kg;
            if (dg > box || dg < -box) { data[i + 3] = 0; continue; }
            const db = data[i + 2] - kb;
            if (db > box || db < -box) { data[i + 3] = 0; continue; }
            if (dr * dr + dg * dg + db * db > threshold2) data[i + 3] = 0;
        }
        keyCtx.putImageData(imageData, ix, iy);

        // Composite the surviving pixels over the video, 1:1 in backing pixels so
        // nothing is resampled a second time. Identity transform and neutral state
        // defensively: the caller drew the frame with its own transform / filter /
        // alpha, and any of those leaking in would misplace or tint the keyed layer.
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = "none";
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._keyCanvas, ix, iy, iw, ih, ix, iy, iw, ih);
        ctx.restore();
    }

    ignoreMouseEvents() {
        this.canvas.style.pointerEvents = 'none';
    }

    adjustSize() {

        let changed = false;

        let oldWidth = this.widthPx;
        let oldHeight = this.heightPx;

        // While popped out (renderWhileWindowed views like the DAG), the in-page div is hidden so
        // its clientWidth/Height are 0; size the canvas from the popup window instead.
        const windowed = this.windowed && this._poppedWindow && !this._poppedWindow.closed;

        let width, height;
        if (this.in.canvasWidth) {
            width = this.in.canvasWidth.v0;
        } else if (windowed) {
            width = this._poppedWindow.innerWidth;
        } else {
            width = this.div.clientWidth;
        }



        if (width !== oldWidth) {
            this.widthPx = width;
            changed = true;
        }

        if (this.in.canvasHeight) {
            height = this.in.canvasHeight.v0;
        } else if (windowed) {
            height = this._poppedWindow.innerHeight;
        } else {
            height = this.div.clientHeight;
        }

        if (height !== oldHeight) {
            this.heightPx = height;
            changed = true;
        }




        // just keep the canvas the same size as its div
        // unless we specify canvas with and height
        // if (this.canvas.width !== this.div.clientWidth || this.canvas.height !== this.div.clientHeight || this.autoClear) {
        //     this.canvas.width = this.div.clientWidth
        //     this.canvas.height = this.div.clientHeight

        if (changed) {
            // Flag that canvas needs resizing, but defer the actual resize until applyPendingResize()
            // For WebGL: deferredResizeWebGL() will be called via changedSize() with a 100ms debounce
            // For 2D canvas: applyPendingResize() will be called immediately before render
            this._pendingCanvasResize = true;
            
            // bit of a patch to redraw the editor/graph, as resizing clears
            if (this.editor) {
                // this is just resizing, so don't need to recalculate, just redraw.
                this.editor.dirty = true;
            }
        } else {
            // Size hasn't changed, so context scaling is still valid
            this._contextScaled = true;
        }
    }
    
    applyPendingResize() {
        if (!this._pendingCanvasResize) {
            return;
        }

        // Scale canvas backing store by devicePixelRatio for high DPI displays
        // Logical dimensions (widthPx, heightPx) stay the same for coordinate calculations
        // Physical canvas size is scaled for better resolution
        if (this.canvas) {
            this.canvas.width = this.widthPx * this.devicePixelRatio;
            this.canvas.height = this.heightPx * this.devicePixelRatio;
            // Scale the 2D context so drawing commands work with logical coordinates
            // Setting canvas.width/height automatically resets the transform and clears the canvas
            if (this.ctx) {
                this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);
                this._contextScaled = true;
            }
        }

        this._pendingCanvasResize = false;
    }

    // Force the canvas backing store and 2D context scale transform to be
    // re-established on the next render, even if widthPx/heightPx have not
    // changed. Used after a WebGL context loss: the GPU crash silently wipes
    // the 2D context's transform state but leaves canvas.width/height intact,
    // so the normal "only resize when dimensions change" gate in adjustSize /
    // ensureContextScaled never re-applies ctx.scale(dpr, dpr) — drawings
    // then render unscaled into a DPR-sized backing store and CSS displays
    // them at half size on a 2× DPR display. Setting canvas.width = 0 here
    // forces the next applyPendingResize / ensureContextScaled to take the
    // size-changed branch and re-scale the context.
    forceContextRescale() {
        if (this.canvas) this.canvas.width = 0;
        this._pendingCanvasResize = true;
        this._contextScaled = false;
    }

}

class CNodeViewCanvas2D extends CNodeViewCanvas {
    constructor(v) {
        super(v)

        this.ctx = this.canvas.getContext('2d')
        this.ctx.font = '36px serif'
        this.ctx.fillStyle = '#FF00FF'
        this.ctx.strokeStyle = '#FF00FF'

        // this.canvas.style.backgroundColor = 'transparent';
        // this.ctx.globalAlpha = 0.5;

        this.autoClear = v.autoClear;
        this.autoFill = v.autoFill;
        this.autoFillColor = v.autoFillColor;

        this.devicePixelRatio = window.devicePixelRatio || 1;
        this._lastScaledWidth = 0;
        this._lastScaledHeight = 0;
    }

    // Helper method: ensures canvas dimensions and context scaling match current display requirements
    // This should be called before direct drawing operations when the context needs to be scaled
    // It will only re-scale if canvas dimensions have actually changed
    ensureContextScaled() {
        if (!this.widthPx || !this.heightPx) return;

        const requiredWidth = this.widthPx * this.devicePixelRatio;
        const requiredHeight = this.heightPx * this.devicePixelRatio;

        if (this.canvas.width !== requiredWidth || this.canvas.height !== requiredHeight) {
            this.canvas.width = requiredWidth;
            this.canvas.height = requiredHeight;
            this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);
            // Setting canvas.width clears the backing store. Mark the editor
            // dirty so the next editor.update() repaints — without this,
            // resizing the panel via the corner handle blanks the graph
            // (the user's resize path bypasses adjustSize's `changed`
            // detection because setFromDiv has already synced widthPx
            // to div.clientWidth before adjustSize runs, so editor.dirty
            // never gets set on the adjustSize path either).
            if (this.editor) this.editor.dirty = true;
        }
    }

    dispose() {
        // release the WebGL context
        this.ctx = null

        super.dispose()
    }

    renderCanvas(frame) {
        super.renderCanvas(frame)

        if (this.visible) {
            // 1. adjustSize() updates widthPx/heightPx based on container or canvasWidth input
            //    and sets _pendingCanvasResize flag if dimensions changed
            this.adjustSize()
            
            // 2. applyPendingResize() applies the deferred canvas.width/height update
            //    Setting canvas.width/height clears the canvas, so we do this before rendering
            this.applyPendingResize()

            // 3. Ensure context is properly scaled for high DPI displays
            //    This handles cases where canvas was just resized or context needs re-scaling
            this.ensureContextScaled()

            // autoClear clears to transparent before rendering
            if (this.autoClear) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }

            // autoFill fills with a solid color (after clear if both are set)
            if (this.autoFill) {
                this.ctx.fillStyle = this.autoFillColor ?? "black";
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            }
        }

    }

    drawCrosshairIfKeyHeld() {
        const slashHeld = isKeyHeld("/");

        if (slashHeld && !this._slashWasHeld && this._crosshairFixed) {
            this._crosshairFixed = false;
        }
        this._slashWasHeld = slashHeld;

        if (!slashHeld && !this._crosshairFixed) {
            return;
        }

        if (!this.mouse) return;

        let mx, my;
        if (this._crosshairFixed) {
            mx = this._crosshairFixedX;
            my = this._crosshairFixedY;
        } else {
            mx = this.mouse.x;
            my = this.mouse.y;
        }

        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1 / this.devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.lineTo(mx, this.heightPx);
        ctx.moveTo(0, my);
        ctx.lineTo(this.widthPx, my);
        ctx.stroke();
        ctx.restore();
    }

    fixCrosshair() {
        if (isKeyHeld("/") && this.mouse && !this._crosshairFixed) {
            this._crosshairFixed = true;
            this._crosshairFixedX = this.mouse.x;
            this._crosshairFixedY = this.mouse.y;
        }
    }
}

export {CNodeViewCanvas2D};
