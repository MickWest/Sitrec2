import {CNodeActiveOverlay} from "./CNodeTrackingOverlay";
import {setRenderOne} from "../Globals";
import {mouseToCanvas} from "../ViewUtils";
import {undoManager} from "../UndoManager";
import {isKeyCodeHeld} from "../KeyBoardHandler";
import {getFlowAlignRotation} from "../FlowAlignment";
import {par} from "../par";

/**
 * The video exclusion mask, shared by every system that needs to ignore part of the frame:
 * motion analysis, the pano exporters, and the star tracker.
 *
 * FOUR INVARIANTS. These were implicit while the mask belonged to Motion Analysis, and each one
 * had somewhere it was assumed differently, so they are stated here rather than rediscovered.
 *
 * 1. POLARITY - a pixel is masked when its ALPHA exceeds 128, and masked means EXCLUDED from
 *    processing (isPointMasked below; motion analysis skips such points; the pano exporters
 *    write them transparent). Note this is the opposite of the "keep" masks OpenCV usually
 *    wants, and the opposite of CameraMotionFromVideo's own buildMask, where 255 means USABLE.
 *    Anything handing this mask to OpenCV must invert it, not pass it through.
 *
 * 2. COORDINATE SPACE - the canvas is in VIDEO pixels, sized to the view's current decoded
 *    frame. It is NOT canvas/display space, and it is not necessarily the size an analysis ran
 *    at: the star tracker may decode at a capped resolution, so a consumer holding detections in
 *    its own analysed space must rescale into this canvas before asking isPointMasked.
 *
 * 3. VIDEO IDENTITY - one view can switch between video sources while keeping this one canvas.
 *    A mask therefore belongs to whatever video was loaded when it was painted, and consumers
 *    that outlive a video swap must re-check rather than assume it still describes the frame.
 *
 * 4. COMPOSITION - automatic mask operations ADD to what is already there. A hand-painted mask,
 *    an OSD auto-mask and a detected ground region coexist; nothing silently replaces the
 *    user's own work.
 */
export class CNodeMaskOverlay extends CNodeActiveOverlay {
    constructor(v) {
        super(v);
        
        this.separateVisibility = true;
        
        this.brushSize = v.brushSize ?? 20;
        // Several systems read this mask - motion analysis, the pano exporters, the star
        // tracker - so change notification is a LIST, not the single callback it began as.
        // A single slot silently made whoever constructed the node its owner, which is what
        // tied masking to Motion Analysis in the first place.
        this.maskListeners = new Set();
        if (typeof v.onMaskChange === "function") this.maskListeners.add(v.onMaskChange);
        this.maskData = null;
        this.maskCanvas = null;
        this.maskCtx = null;
        this.maskImageData = null;
        this.isDrawing = false;
        this.lastDrawX = null;
        this.lastDrawY = null;
        this.isRectDragging = false;
        this.rectStartX = 0;
        this.rectStartY = 0;
        this.rectEndX = 0;
        this.rectEndY = 0;
        this.rectErase = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.preDrawMaskData = null;
        this.lastBrushAdjustTime = 0;
        this.showMaskPreview = false;
        this.editing = false;
        this.visible = false;
        
        this.loadMask();
    }

    unrotateCanvasCoords(cx, cy) {
        const rotation = getFlowAlignRotation(par.frame);
        if (rotation === 0) return [cx, cy];
        const centerX = this.widthPx / 2;
        const centerY = this.heightPx / 2;
        const dx = cx - centerX;
        const dy = cy - centerY;
        const cos = Math.cos(-rotation);
        const sin = Math.sin(-rotation);
        return [dx * cos - dy * sin + centerX, dx * sin + dy * cos + centerY];
    }
    
    modSerialize() {
        return {
            ...super.modSerialize(),
            maskData: this.maskData,
            // Saved WITH the mask, because it is the mask's setting. It used to be written by
            // the mask editor but read back off the motion analyser, so an edited brush size was
            // never actually restored - the two had drifted apart precisely because the mask was
            // owned by one system and configured through another.
            brushSize: this.brushSize,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.maskData !== undefined) {
            this.maskData = v.maskData;
            this.loadMask();
        }
        if (Number.isFinite(v.brushSize)) this.brushSize = v.brushSize;
    }
    
    setEditing(editing) {
        this.editing = editing;
        this.updateVisibility();
        if (this.overlayView && this.overlayView.div) {
            this.overlayView.div.style.cursor = editing ? 'none' : '';
            const handles = this.overlayView.div.querySelectorAll('.resize-handle');
            handles.forEach(handle => {
                handle.style.pointerEvents = editing ? 'none' : '';
            });
        }
    }
    
    setShowMaskPreview(show) {
        this.showMaskPreview = show;
        this.updateVisibility();
    }
    
    updateVisibility() {
        const shouldBeVisible = this.editing || this.showMaskPreview;
        if (this.visible !== shouldBeVisible) {
            this.visible = shouldBeVisible;
        }
    }
    
    /**
     * Subscribe to mask edits. Returns an unsubscribe function.
     *
     * Subscribers are independent: one throwing must not stop the others being told, or a
     * stale listener from a torn-down system would silently freeze everyone else's cache.
     */
    addMaskListener(fn) {
        if (typeof fn !== "function") return () => {};
        this.maskListeners.add(fn);
        return () => this.maskListeners.delete(fn);
    }

    notifyMaskChange() {
        for (const fn of this.maskListeners) {
            try {
                fn();
            } catch (e) {
                console.warn("mask listener failed", e);
            }
        }
    }
    
    loadMask() {
        if (this.maskData) {
            const img = new Image();
            img.onload = () => {
                if (this.maskCanvas) {
                    this.maskCtx.drawImage(img, 0, 0);
                    this.updateMaskImageData();
                }
            };
            img.src = this.maskData;
        }
    }
    
    saveMask() {
        if (this.maskCanvas) {
            // Bump a revision counter on every mask mutation. The additive auto-mask
            // tools use this to tell "the mask is exactly as I last left it" (safe to
            // replace my own contribution) from "something else edited it since"
            // (snapshot the current mask as the new baseline). See
            // MotionAnalyzer._applyAutoMaskLayer().
            this.maskRevision = (this.maskRevision || 0) + 1;
            this.maskData = this.maskCanvas.toDataURL('image/png');
            this.updateMaskImageData();
            this.notifyMaskChange();
        }
    }
    
    initMask(width, height) {
        if (this.maskCanvas && this.maskCanvas.width === width && this.maskCanvas.height === height) {
            return;
        }
        
        const oldData = this.maskCanvas ? this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height) : null;
        
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.width = width;
        this.maskCanvas.height = height;
        this.maskCtx = this.maskCanvas.getContext('2d', {willReadFrequently: true});
        
        if (oldData) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = oldData.width;
            tempCanvas.height = oldData.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(oldData, 0, 0);
            this.maskCtx.drawImage(tempCanvas, 0, 0, width, height);
            this.updateMaskImageData();
        } else if (this.maskData) {
            const img = new Image();
            img.onload = () => {
                this.maskCtx.drawImage(img, 0, 0, width, height);
                this.updateMaskImageData();
            };
            img.src = this.maskData;
        }
    }
    
    updateMaskImageData() {
        if (this.maskCanvas) {
            this.maskImageData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        }
    }
    
    isPointMasked(x, y) {
        if (!this.maskImageData) return false;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || ix >= this.maskCanvas.width || iy < 0 || iy >= this.maskCanvas.height) return false;
        const idx = (iy * this.maskCanvas.width + ix) * 4;
        return this.maskImageData.data[idx + 3] > 128;
    }
    
    getMaskMat() {
        if (!this.maskCanvas || !window.cv) return null;
        
        const cv = window.cv;
        const imageData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        const src = cv.matFromImageData(imageData);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        src.delete();
        
        const mask = new cv.Mat();
        cv.threshold(gray, mask, 128, 255, cv.THRESH_BINARY);
        gray.delete();
        
        return mask;
    }
    
    // Run `mutate(ctx, canvas)` on the mask as a single undoable edit: snapshots the
    // mask before/after and pushes an undo action holding both states. With
    // {coalesceKey, coalesce: true}, an immediately preceding action carrying the
    // same key has its post state updated instead of pushing a new action — used by
    // the auto-mask tools, which re-run on every tick of a slider drag.
    applyMaskEdit(description, mutate, {coalesceKey = null, coalesce = false} = {}) {
        this.ensureMaskInitialized();
        if (!this.maskCanvas) return false;

        const canvas = this.maskCanvas;
        const ctx = this.maskCtx;
        const preData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        mutate(ctx, canvas);
        const postData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        this.saveMask();
        setRenderOne(true);

        const top = undoManager.undoStack[undoManager.undoStack.length - 1];
        if (coalesce && coalesceKey && top && top.maskCoalesceKey === coalesceKey
            && undoManager.redoStack.length === 0) {
            top.postData = postData;
            return true;
        }

        const overlay = this;
        undoManager.add({
            description,
            maskCoalesceKey: coalesceKey,
            preData,
            postData,
            undo() {
                if (overlay.maskCanvas) {
                    overlay.maskCtx.putImageData(this.preData, 0, 0);
                    overlay.saveMask();
                    setRenderOne(true);
                }
            },
            redo() {
                if (overlay.maskCanvas) {
                    overlay.maskCtx.putImageData(this.postData, 0, 0);
                    overlay.saveMask();
                    setRenderOne(true);
                }
            }
        });
        return true;
    }

    clearMask() {
        if (this.maskCanvas) {
            this.applyMaskEdit("Clear mask", (ctx, canvas) => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            });
        }
    }
    
    ensureMaskInitialized() {
        const videoWidth = this.overlayView.videoWidth;
        const videoHeight = this.overlayView.videoHeight;
        if (videoWidth > 0 && videoHeight > 0) {
            this.initMask(videoWidth, videoHeight);
        }
    }
    
    drawBrushAt(vX, vY, erase) {
        this.ensureMaskInitialized();
        if (!this.maskCanvas) return;
        
        this.maskCtx.beginPath();
        this.maskCtx.arc(vX, vY, this.brushSize, 0, Math.PI * 2);
        
        if (erase) {
            this.maskCtx.globalCompositeOperation = 'destination-out';
        } else {
            this.maskCtx.globalCompositeOperation = 'source-over';
        }
        this.maskCtx.fillStyle = 'rgba(255, 0, 0, 1)';
        this.maskCtx.fill();
        this.maskCtx.globalCompositeOperation = 'source-over';
    }
    
    drawLineTo(vX, vY, erase) {
        if (this.lastDrawX === null || this.lastDrawY === null) {
            this.drawBrushAt(vX, vY, erase);
        } else {
            const dx = vX - this.lastDrawX;
            const dy = vY - this.lastDrawY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const step = this.brushSize / 4;
            const steps = Math.max(1, Math.ceil(dist / step));
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = this.lastDrawX + dx * t;
                const y = this.lastDrawY + dy * t;
                this.drawBrushAt(x, y, erase);
            }
        }
        this.lastDrawX = vX;
        this.lastDrawY = vY;
    }
    
    onMouseDown(e, mouseX, mouseY) {
        if (!this.editing) return false;
        
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const [ucx, ucy] = this.unrotateCanvasCoords(cx, cy);
        const [vX, vY] = this.overlayView.canvasToVideoCoords(ucx, ucy);

        this.ensureMaskInitialized();

        if (e.shiftKey) {
            // Shift-drag: rectangle fill (Opt-Shift-drag: rectangle erase).
            // Preview only while dragging; committed to the mask on release.
            this.isRectDragging = true;
            this.rectErase = e.altKey;
            this.rectStartX = vX;
            this.rectStartY = vY;
            this.rectEndX = vX;
            this.rectEndY = vY;
            setRenderOne(true);
            return true;
        }

        if (this.maskCanvas) {
            this.preDrawMaskData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        }

        this.isDrawing = true;
        this.lastDrawX = null;
        this.lastDrawY = null;
        this.drawLineTo(vX, vY, e.altKey);
        setRenderOne(true);
        return true;
    }
    
    onMouseDrag(e, mouseX, mouseY) {
        if (!this.editing) return;
        
        this.lastMouseX = mouseX;
        this.lastMouseY = mouseY;

        if (this.isRectDragging) {
            const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
            const [ucx, ucy] = this.unrotateCanvasCoords(cx, cy);
            const [vX, vY] = this.overlayView.canvasToVideoCoords(ucx, ucy);
            this.rectEndX = vX;
            this.rectEndY = vY;
            this.rectErase = e.altKey;
            setRenderOne(true);
            return;
        }

        if (!this.isDrawing) return;

        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const [ucx, ucy] = this.unrotateCanvasCoords(cx, cy);
        const [vX, vY] = this.overlayView.canvasToVideoCoords(ucx, ucy);

        this.drawLineTo(vX, vY, e.altKey);
        setRenderOne(true);
    }
    
    onMouseUp(e, mouseX, mouseY) {
        if (!this.editing) return;

        if (this.isRectDragging) {
            this.isRectDragging = false;
            const x = Math.min(this.rectStartX, this.rectEndX);
            const y = Math.min(this.rectStartY, this.rectEndY);
            const w = Math.abs(this.rectEndX - this.rectStartX);
            const h = Math.abs(this.rectEndY - this.rectStartY);
            if (w >= 1 && h >= 1) {
                const erase = this.rectErase;
                this.applyMaskEdit(erase ? "Mask rectangle erase" : "Mask rectangle fill", (ctx) => {
                    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
                    ctx.fillStyle = 'rgba(255, 0, 0, 1)';
                    ctx.fillRect(x, y, w, h);
                    ctx.globalCompositeOperation = 'source-over';
                });
            }
            setRenderOne(true);
            return;
        }

        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawX = null;
            this.lastDrawY = null;
            
            if (this.maskCanvas && this.preDrawMaskData) {
                const postDrawMaskData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
                const preData = this.preDrawMaskData;
                const overlay = this;
                
                undoManager.add({
                    description: "Mask paint",
                    undo: () => {
                        if (overlay.maskCanvas) {
                            overlay.maskCtx.putImageData(preData, 0, 0);
                            overlay.saveMask();
                            setRenderOne(true);
                        }
                    },
                    redo: () => {
                        if (overlay.maskCanvas) {
                            overlay.maskCtx.putImageData(postDrawMaskData, 0, 0);
                            overlay.saveMask();
                            setRenderOne(true);
                        }
                    }
                });
                
                this.preDrawMaskData = null;
            }
            
            this.saveMask();
        }
    }
    
    onMouseMove(e, mouseX, mouseY) {
        if (!this.editing) return;
        
        this.lastMouseX = mouseX;
        this.lastMouseY = mouseY;
        setRenderOne(true);
    }
    
    handleBrushSizeKeys() {
        const now = performance.now();
        const delay = 50;
        if (now - this.lastBrushAdjustTime < delay) return;


        let step = 1+(Math.sqrt(this.brushSize)/2);

        let changed = false;
        if (isKeyCodeHeld('BracketLeft')) {
            this.brushSize = Math.max(1, this.brushSize - step);
            changed = true;
        }
        if (isKeyCodeHeld('BracketRight')) {
            this.brushSize = Math.min(100, this.brushSize + step);
            changed = true;
        }
        if (changed) {
            this.lastBrushAdjustTime = now;
            setRenderOne(true);
        }
    }
    
    renderCanvas(frame) {
        if (!this.editing && !this.showMaskPreview) {
            return;
        }
        
        super.renderCanvas(frame);
        
        if (this.editing) {
            this.handleBrushSizeKeys();
        }
        
        this.ensureMaskInitialized();
        if (!this.maskCanvas) return;
        
        const ctx = this.ctx;
        const flowRotation = getFlowAlignRotation(frame);
        
        ctx.save();
        ctx.globalAlpha = this.editing ? 0.4 : 0.2;
        
        if (flowRotation !== 0) {
            ctx.translate(this.widthPx / 2, this.heightPx / 2);
            ctx.rotate(flowRotation);
            ctx.translate(-this.widthPx / 2, -this.heightPx / 2);
        }
        
        // Draw the mask with the SAME source-crop transform the video view uses to
        // draw the frame (see CNodeVideoView.renderCanvas), so the mask tracks the
        // video's pan and zoom exactly. The mask canvas is at video resolution, so
        // the source rect (sx,sy,sWidth,sHeight) selects the same visible sub-region
        // the zoomed/panned video shows; without this the mask stayed fixed while
        // the video moved underneath it.
        const ov = this.overlayView;
        ov.getSourceAndDestCoords();
        if (ov.in.zoom !== undefined) {
            ctx.drawImage(this.maskCanvas,
                ov.sx, ov.sy, ov.sWidth, ov.sHeight,
                ov.dx, ov.dy, ov.dWidth, ov.dHeight);
        } else {
            // Legacy zoomView path (zoom driven by posLeft/posTop, not in.zoom).
            ctx.drawImage(this.maskCanvas,
                0, 0, ov.videoWidth, ov.videoHeight,
                ov.widthPx * (0.5 + ov.posLeft), ov.heightPx * 0.5 + ov.widthPx * ov.posTop,
                ov.widthPx * (ov.posRight - ov.posLeft), ov.widthPx * (ov.posBot - ov.posTop));
        }
        ctx.restore();

        if (this.editing && this.isRectDragging) {
            // Rectangle drag preview: red for fill, blue for erase. The rect is held
            // in video coords; map through the same view transform as the mask so it
            // tracks zoom/pan, inside the same flow rotation the mask is drawn with.
            const [x1, y1] = ov.videoToCanvasCoords(this.rectStartX, this.rectStartY);
            const [x2, y2] = ov.videoToCanvasCoords(this.rectEndX, this.rectEndY);
            ctx.save();
            if (flowRotation !== 0) {
                ctx.translate(this.widthPx / 2, this.heightPx / 2);
                ctx.rotate(flowRotation);
                ctx.translate(-this.widthPx / 2, -this.heightPx / 2);
            }
            const rgb = this.rectErase ? '0, 128, 255' : '255, 0, 0';
            const rx = Math.min(x1, x2);
            const ry = Math.min(y1, y2);
            const rw = Math.abs(x2 - x1);
            const rh = Math.abs(y2 - y1);
            ctx.fillStyle = `rgba(${rgb}, 0.3)`;
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = `rgba(${rgb}, 1)`;
            ctx.lineWidth = 2;
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.restore();
        }

        if (this.editing && !this.isRectDragging) {
            this.drawBrushCursor(flowRotation);
        }
    }
    
    drawBrushCursor(flowRotation = 0) {
        const ctx = this.ctx;
        const [cx, cy] = mouseToCanvas(this, this.lastMouseX, this.lastMouseY);
        
        this.overlayView.getSourceAndDestCoords();
        const {dWidth} = this.overlayView;
        // The brush size is in video pixels; the video->canvas scale is dWidth/sWidth
        // (sWidth shrinks with zoom). sWidth == videoWidth when unzoomed, so this is
        // correct for both the zoom and legacy paths, and keeps the cursor matching
        // the area actually painted as you zoom.
        const sourceWidth = this.overlayView.sWidth || this.overlayView.videoWidth || 1;
        const brushRadius = this.brushSize * dWidth / sourceWidth;
        
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, brushRadius, 0, Math.PI * 2);
        ctx.stroke();
    }
}
