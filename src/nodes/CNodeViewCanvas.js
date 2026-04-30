// simple UI intermediate class that just has a canvas.
// we use this for the CNodeViewUI and the (upcoming) CNodeVideoView
// passing in an "overlayView" parameter will attache
import {CNodeView} from "./CNodeView";
import {guiMenus} from "../Globals";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {isKeyHeld} from "../KeyBoardHandler";


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
        }


       // this.adjustSize()

        this.div.appendChild(this.canvas)
    }

    dispose() {
        super.dispose()
        this.div.removeChild(this.canvas)
        this.canvas = null;
    }

    ignoreMouseEvents() {
        this.canvas.style.pointerEvents = 'none';
    }

    adjustSize() {

        let changed = false;

        let oldWidth = this.widthPx;
        let oldHeight = this.heightPx;

        let width, height;
        if (this.in.canvasWidth) {
            width = this.in.canvasWidth.v0;
        } else {
            width = this.div.clientWidth;
        }



        if (width !== oldWidth) {
            this.widthPx = width;
            changed = true;
        }

        if (this.in.canvasHeight) {
            height = this.in.canvasHeight.v0;
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
