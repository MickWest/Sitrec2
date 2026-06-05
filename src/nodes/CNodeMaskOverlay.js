import {CNodeActiveOverlay} from "./CNodeTrackingOverlay";
import {setRenderOne} from "../Globals";
import {mouseToCanvas} from "../ViewUtils";
import {undoManager} from "../UndoManager";
import {isKeyCodeHeld} from "../KeyBoardHandler";
import {getFlowAlignRotation} from "../FlowAlignment";
import {par} from "../par";

export class CNodeMaskOverlay extends CNodeActiveOverlay {
    constructor(v) {
        super(v);
        
        this.separateVisibility = true;
        
        this.brushSize = v.brushSize ?? 20;
        this.onMaskChange = v.onMaskChange ?? null;
        this.maskData = null;
        this.maskCanvas = null;
        this.maskCtx = null;
        this.maskImageData = null;
        this.isDrawing = false;
        this.lastDrawX = null;
        this.lastDrawY = null;
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
        };
    }
    
    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.maskData !== undefined) {
            this.maskData = v.maskData;
            this.loadMask();
        }
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
    
    notifyMaskChange() {
        if (typeof this.onMaskChange === 'function') {
            this.onMaskChange();
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
    
    clearMask() {
        if (this.maskCanvas) {
            const preData = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height);
            const overlay = this;
            
            this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
            this.updateMaskImageData();
            this.saveMask();
            
            undoManager.add({
                description: "Clear mask",
                undo: () => {
                    if (overlay.maskCanvas) {
                        overlay.maskCtx.putImageData(preData, 0, 0);
                        overlay.saveMask();
                        setRenderOne(true);
                    }
                },
                redo: () => {
                    if (overlay.maskCanvas) {
                        overlay.maskCtx.clearRect(0, 0, overlay.maskCanvas.width, overlay.maskCanvas.height);
                        overlay.saveMask();
                        setRenderOne(true);
                    }
                }
            });
            
            setRenderOne(true);
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
        
        if (!this.isDrawing) return;
        
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const [ucx, ucy] = this.unrotateCanvasCoords(cx, cy);
        const [vX, vY] = this.overlayView.canvasToVideoCoords(ucx, ucy);
        
        this.drawLineTo(vX, vY, e.altKey);
        setRenderOne(true);
    }
    
    onMouseUp(e, mouseX, mouseY) {
        if (!this.editing) return;
        
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
        
        this.overlayView.getSourceAndDestCoords();
        const {dx, dy, dWidth, dHeight} = this.overlayView;
        
        ctx.drawImage(this.maskCanvas, dx, dy, dWidth, dHeight);
        ctx.restore();
        
        if (this.editing) {
            this.drawBrushCursor(flowRotation);
        }
    }
    
    drawBrushCursor(flowRotation = 0) {
        const ctx = this.ctx;
        const [cx, cy] = mouseToCanvas(this, this.lastMouseX, this.lastMouseY);
        
        this.overlayView.getSourceAndDestCoords();
        const {dWidth} = this.overlayView;
        const videoWidth = this.overlayView.videoWidth || 1;
        const brushRadius = this.brushSize * dWidth / videoWidth;
        
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, brushRadius, 0, Math.PI * 2);
        ctx.stroke();
    }
}
