import {commandModifier} from "../GestureActions";
import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {HANDLE_STYLE} from "../HandleStyle";
import {CNodeTrack} from "./CNodeTrack";
import {EventManager} from "../CEventManager";
import {NodeMan, setRenderOne, Sit, UndoManager} from "../Globals";
import {par} from "../par";
import {CNodeTabbedCanvasView} from "./CNodeTabbedCanvasView";
import {assert} from "../assert";
import {t} from "../i18n";

export class CNodeCurveEditorView2 extends CNodeTabbedCanvasView {
    constructor(v) {
        v.menuName = v.menuName ?? v.editorConfig.yLabel ?? "Curve Editor";
        super(v);
        
        const config = v.editorConfig;
        this.minX = config.minX ?? 0;
        this.maxX = config.maxX ?? 100;
        this.minY = config.minY ?? 0;
        this.maxY = config.maxY ?? 100;
        this.xLabel = config.xLabel ?? "X";
        this.yLabel = config.yLabel ?? "Y";
        this.xStep = config.xStep ?? 10;
        this.yStep = config.yStep ?? 10;
        
        this.points = [];
        if (config.points) {
            for (let i = 0; i < config.points.length; i += 2) {
                this.points.push({x: config.points[i], y: config.points[i + 1]});
            }
        }
        
        this.draggedPointIndex = null;
        this.draggedLineIndex = null;
        this.isDragging = false;
        this.isDraggingLine = false;
        this.isDraggingFrame = false;
        this.isDraggingAFrame = false;
        this.isDraggingBFrame = false;
        this.isDraggingWindow = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.stateBeforeDrag = null;
        this.dragStartPoint = null;
        this.dragPointerStart = null;
        this.dragStartLineP1 = null;
        this.dragStartLineP2 = null;
        this.lockAxis = null;
        this.snapToY = null;
        this.snapToX = null;
        this.defaultSnap = config.defaultSnap ?? false;
        this.pushPointsHorizontally = false;
        
        this.setupMouseHandlers();
        this.addMenuItems();
    }
    
    captureState() {
        return this.points.map(p => ({x: p.x, y: p.y}));
    }
    
    restoreState(state) {
        this.points = state.map(p => ({x: p.x, y: p.y}));
        if (this.onChange) {
            this.onChange();
        }
        setRenderOne(true);
    }
    
    isMenuInteraction(e) {
        if (!this.menuContainer) return false;
        
        let target = e.target;
        while (target) {
            if (target === this.menuContainer) {
                return true;
            }
            target = target.parentElement;
        }
        return false;
    }
    
    setupMouseHandlers() {
        this.unregisterInteraction = registerSurfaceInteraction(this.canvas, {
            model: this, view: this, profile: "curve",
            hitTest: e => this.isMenuInteraction(e) ? null : {},
            begin: e => { this.interactionRadius = e.pointerType === "touch" ? HANDLE_STYLE.touchRadius : 8; this.onMouseDown(e); }, move: e => this.onMouseMove(e),
            hover: e => { if (e) this.onMouseMove(e); },
            snapshot: () => ({points: this.captureState(), frame: par.frame, a: Sit.aFrame, b: Sit.bFrame,
                left: this.div.style.left, top: this.div.style.top}),
            restore: state => {
                this.stateBeforeDrag = null;
                this.limitsBeforeDrag = null;
                this.restoreState(state.points);
                Sit.aFrame = state.a; Sit.bFrame = state.b;
                const slider = NodeMan.get("frameSlider", false) || NodeMan.get("FrameSlider", false);
                if (slider) slider.setFrame(state.frame); else par.frame = state.frame;
                this.div.style.left = state.left; this.div.style.top = state.top;
                EventManager.dispatchEvent("abFrameChanged");
            },
            end: e => this.onMouseUp(e),
        });
    }

    addMenuItems() {
        const snapSettings = {
            defaultSnap: this.defaultSnap
        };

        this.tabMenu.add(snapSettings, 'defaultSnap')
            .name(t("misc.defaultSnap.label"))
            .onChange((value) => {
                this.defaultSnap = value;
            })
        .tooltip(t("misc.defaultSnap.tooltip"));

        this.createYRangeSlider();
    }

    createYRangeSlider() {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = 1;
        slider.max = 170;
        slider.step = 1;
        slider.value = this.maxY;

        slider.style.position = 'absolute';
        slider.style.right = '4px';
        slider.style.top = '60px';
        slider.style.bottom = '60px';
        slider.style.width = '20px';
        slider.style.zIndex = '100';
        slider.style.writingMode = 'vertical-lr';
        slider.style.direction = 'rtl';
        slider.style.margin = '0';
        slider.style.padding = '0';
        slider.style.cursor = 'pointer';

        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            this.maxY = Number(e.target.value);
        });
        slider.addEventListener('pointerdown', (e) => e.stopPropagation());

        this.div.appendChild(slider);
        this.yRangeSlider = slider;
    }
    
    screenToGraph(screenX, screenY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = screenX - rect.left;
        const y = screenY - rect.top;
        
        const margin = 60;
        const graphWidth = this.widthPx - margin * 2;
        const graphHeight = this.heightPx - margin * 2;
        
        const graphX = this.minX + (x - margin) / graphWidth * (this.maxX - this.minX);
        const graphY = this.maxY - (y - margin) / graphHeight * (this.maxY - this.minY);
        
        return {x: graphX, y: graphY};
    }
    
    graphToScreen(graphX, graphY) {
        const margin = 60;
        const graphWidth = this.widthPx - margin * 2;
        const graphHeight = this.heightPx - margin * 2;
        
        const x = margin + (graphX - this.minX) / (this.maxX - this.minX) * graphWidth;
        const y = margin + (this.maxY - graphY) / (this.maxY - this.minY) * graphHeight;
        
        return {x, y};
    }
    
    findPointAt(screenX, screenY) {
        const threshold = this.interactionRadius ?? 8;
        for (let i = 0; i < this.points.length; i++) {
            const screen = this.graphToScreen(this.points[i].x, this.points[i].y);
            const dx = screenX - screen.x;
            const dy = screenY - screen.y;
            if (Math.sqrt(dx * dx + dy * dy) < threshold) {
                return i;
            }
        }
        return null;
    }
    
    findLineAt(screenX, screenY) {
        const threshold = this.interactionRadius ?? 8;
        for (let i = 0; i < this.points.length - 1; i++) {
            const p1 = this.graphToScreen(this.points[i].x, this.points[i].y);
            const p2 = this.graphToScreen(this.points[i + 1].x, this.points[i + 1].y);
            
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            
            if (length === 0) continue;
            
            const dot = ((screenX - p1.x) * dx + (screenY - p1.y) * dy) / (length * length);
            
            if (dot < 0 || dot > 1) continue;
            
            const projX = p1.x + dot * dx;
            const projY = p1.y + dot * dy;
            
            const distX = screenX - projX;
            const distY = screenY - projY;
            const distance = Math.sqrt(distX * distX + distY * distY);
            
            if (distance < threshold) {
                return i;
            }
        }
        return null;
    }
    
    isNearFrame(screenX, screenY, frameX) {
        const threshold = this.interactionRadius ?? 8;
        const margin = 60;
        
        if (frameX === undefined || frameX < this.minX || frameX > this.maxX) return false;
        
        const screen = this.graphToScreen(frameX, this.minY);
        const distance = Math.abs(screenX - screen.x);
        
        return distance < threshold && screenY >= margin && screenY <= this.canvas.height - margin;
    }
    
    isNearFrameLine(screenX, screenY) {
        return this.isNearFrame(screenX, screenY, par.frame);
    }
    
    isNearAFrameLine(screenX, screenY) {
        return this.isNearFrame(screenX, screenY, Sit.aFrame);
    }
    
    isNearBFrameLine(screenX, screenY) {
        return this.isNearFrame(screenX, screenY, Sit.bFrame);
    }
    
    isInsideGraphArea(x, y) {
        const margin = 60;
        const width = this.canvas.width;
        const height = this.canvas.height;
        
        return x >= margin && x <= width - margin && 
               y >= margin && y <= height - margin;
    }
    
    updateCursor(x, y) {
        const pointIndex = this.findPointAt(x, y);
        const lineIndex = this.findLineAt(x, y);
        
        if (pointIndex !== null || lineIndex !== null) {
            this.canvas.style.cursor = 'grab';
        } else if (this.isNearAFrameLine(x, y) || this.isNearBFrameLine(x, y) || this.isNearFrameLine(x, y)) {
            this.canvas.style.cursor = 'ew-resize';
        } else if (this.isInsideGraphArea(x, y)) {
            this.canvas.style.cursor = 'default';
        } else {
            this.canvas.style.cursor = 'move';
        }
    }
    
    startFrameDrag(e, frameType) {
        e.preventDefault();
        e.stopPropagation();
        this.isDragging = true;
        this[frameType] = true;
        if (frameType === "isDraggingAFrame" || frameType === "isDraggingBFrame") {
            this.limitsBeforeDrag = {a: Sit.aFrame, b: Sit.bFrame};
        }
    }
    
    onMouseDown(e) {
        if (e.button !== 0) return;
        if (this.isMenuInteraction(e)) {
            return;
        }
        
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        this.draggedPointIndex = this.findPointAt(x, y);
        if (this.draggedPointIndex !== null) {
            if (e.altKey && this.points.length > 1) {
                e.preventDefault();
                e.stopPropagation();
                this.stateBeforeDrag = this.captureState();
                this.points.splice(this.draggedPointIndex, 1);
                if (this.onChange) {
                    this.onChange();
                }
                this.draggedPointIndex = null;
                this.isDragging = true;
                setRenderOne(true);
                return;
            }
            
            e.preventDefault();
            e.stopPropagation();
            this.stateBeforeDrag = this.captureState();
            this.dragStartPoint = {
                x: this.points[this.draggedPointIndex].x,
                y: this.points[this.draggedPointIndex].y
            };
            this.dragPointerStart = this.screenToGraph(e.clientX, e.clientY);
            this.lockAxis = null;
            this.isDragging = true;
            return;
        }
        
        if (commandModifier(e) && this.isInsideGraphArea(x, y)) {
            e.preventDefault();
            e.stopPropagation();
            this.stateBeforeDrag = this.captureState();
            const graph = this.screenToGraph(e.clientX, e.clientY);
            const newPoint = {x: graph.x, y: graph.y};
            
            let insertIndex = this.points.length;
            for (let i = 0; i < this.points.length; i++) {
                if (newPoint.x < this.points[i].x) {
                    insertIndex = i;
                    break;
                }
            }
            
            this.points.splice(insertIndex, 0, newPoint);
            
            this.draggedPointIndex = insertIndex;
            this.dragStartPoint = {x: newPoint.x, y: newPoint.y};
            this.lockAxis = null;
            this.isDragging = true;
            setRenderOne(true);
            return;
        }
        
        this.draggedLineIndex = this.findLineAt(x, y);
        if (this.draggedLineIndex !== null) {
            e.preventDefault();
            e.stopPropagation();
            this.stateBeforeDrag = this.captureState();
            const graph = this.screenToGraph(e.clientX, e.clientY);
            this.dragStartPoint = {x: graph.x, y: graph.y};
            const p1 = this.draggedLineIndex;
            const p2 = this.draggedLineIndex + 1;
            
            const aAndBHorizontal = this.points[p1].y === this.points[p2].y;
            const hasHorizontalA = p1 > 0 && this.points[p1].y === this.points[p1 - 1].y;
            const hasHorizontalB = p2 < this.points.length - 1 && this.points[p2].y === this.points[p2 + 1].y;
            
            let newP1 = p1;
            let newP2 = p2;
            
            if (aAndBHorizontal && hasHorizontalA) {
                const newX = this.points[p1].x + 1;
                const newY = this.points[p1].y;
                this.points.splice(p1 + 1, 0, {x: newX, y: newY});
                newP1 = p1 + 1;
                newP2 = p2 + 1;
            }
            
            if (aAndBHorizontal && hasHorizontalB) {
                const newX = this.points[newP2].x - 1;
                const newY = this.points[newP2].y;
                this.points.splice(newP2, 0, {x: newX, y: newY});
            }
            
            if (aAndBHorizontal && (hasHorizontalA || hasHorizontalB)) {
                this.dragStartLineP1 = {x: this.points[newP1].x, y: this.points[newP1].y};
                this.dragStartLineP2 = {x: this.points[newP2].x, y: this.points[newP2].y};
                this.draggedLineIndex = newP1;
                if (this.onChange) {
                    this.onChange();
                }
            } else {
                this.dragStartLineP1 = {x: this.points[p1].x, y: this.points[p1].y};
                this.dragStartLineP2 = {x: this.points[p2].x, y: this.points[p2].y};
            }
            
            this.lockAxis = null;
            this.isDragging = true;
            this.isDraggingLine = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }
        
        const abDistance = (Sit.aFrame !== undefined && Sit.bFrame !== undefined) 
            ? (Sit.bFrame - Sit.aFrame) 
            : Infinity;
        
        if (abDistance < 10) {
            if (this.isNearAFrameLine(x, y)) {
                this.startFrameDrag(e, 'isDraggingAFrame');
                return;
            }
            
            if (this.isNearBFrameLine(x, y)) {
                this.startFrameDrag(e, 'isDraggingBFrame');
                return;
            }
            
            if (this.isNearFrameLine(x, y)) {
                this.startFrameDrag(e, 'isDraggingFrame');
                return;
            }
        } else {
            if (this.isNearFrameLine(x, y)) {
                this.startFrameDrag(e, 'isDraggingFrame');
                return;
            }
            
            if (this.isNearAFrameLine(x, y)) {
                this.startFrameDrag(e, 'isDraggingAFrame');
                return;
            }
            
            if (this.isNearBFrameLine(x, y)) {
                this.startFrameDrag(e, 'isDraggingBFrame');
                return;
            }
        }

        // Click in the margin area (outside graph, not on any element):
        // start a window drag.
        if (!this.isInsideGraphArea(x, y)) {
            e.preventDefault();
            e.stopPropagation();
            this.isDragging = true;
            this.isDraggingWindow = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        }
    }
    
    onMouseMove(e) {
        if (this.isMenuInteraction(e)) {
            return;
        }
        
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        if (this.isDragging && this.isDraggingAFrame) {
            e.preventDefault();
            e.stopPropagation();
            
            this.canvas.style.cursor = 'ew-resize';
            
            const graph = this.screenToGraph(e.clientX, e.clientY);
            let newFrame = Math.round(Math.max(this.minX, Math.min(this.maxX, graph.x)));
            
            if (Sit.bFrame !== undefined) {
                newFrame = Math.min(newFrame, Sit.bFrame - 1);
            }
            
            Sit.aFrame = newFrame;
            setRenderOne(true);
        } else if (this.isDragging && this.isDraggingBFrame) {
            e.preventDefault();
            e.stopPropagation();
            
            this.canvas.style.cursor = 'ew-resize';
            
            const graph = this.screenToGraph(e.clientX, e.clientY);
            let newFrame = Math.round(Math.max(this.minX, Math.min(this.maxX, graph.x)));
            
            if (Sit.aFrame !== undefined) {
                newFrame = Math.max(newFrame, Sit.aFrame + 1);
            }
            
            Sit.bFrame = newFrame;
            setRenderOne(true);
        } else if (this.isDragging && this.isDraggingFrame) {
            e.preventDefault();
            e.stopPropagation();
            
            this.canvas.style.cursor = 'ew-resize';
            
            const graph = this.screenToGraph(e.clientX, e.clientY);
            const newFrame = Math.round(Math.max(this.minX, Math.min(this.maxX, graph.x)));
            par.frame = newFrame;
        } else if (this.isDragging && this.isDraggingLine && this.draggedLineIndex !== null) {
            e.preventDefault();
            e.stopPropagation();
            
            this.canvas.style.cursor = 'grabbing';
            
            const currentGraph = this.screenToGraph(e.clientX, e.clientY);
            let dx = currentGraph.x - this.dragStartPoint.x;
            let dy = currentGraph.y - this.dragStartPoint.y;

            if (this.defaultSnap !== e.shiftKey && this.dragStartPoint) {
                const currentScreen = this.graphToScreen(currentGraph.x, currentGraph.y);
                const startScreen = this.graphToScreen(this.dragStartPoint.x, this.dragStartPoint.y);
                
                const deltaX = Math.abs(currentScreen.x - startScreen.x);
                const deltaY = Math.abs(currentScreen.y - startScreen.y);
                
                if (this.lockAxis === null && (deltaX >= 5 || deltaY >= 5)) {
                    this.lockAxis = deltaX > deltaY ? 'X' : 'Y';
                }
                
                if (this.lockAxis === 'X') {
                    dy = 0;
                } else if (this.lockAxis === 'Y') {
                    dx = 0;
                }
            } else {
                this.lockAxis = null;
            }
            
            const p1 = this.draggedLineIndex;
            const p2 = this.draggedLineIndex + 1;
            
            this.points[p1].x = Math.max(this.minX, Math.min(this.maxX, this.dragStartLineP1.x + dx));
            this.points[p1].y = Math.max(this.minY, Math.min(this.maxY, this.dragStartLineP1.y + dy));
            this.points[p2].x = Math.max(this.minX, Math.min(this.maxX, this.dragStartLineP2.x + dx));
            this.points[p2].y = Math.max(this.minY, Math.min(this.maxY, this.dragStartLineP2.y + dy));
            
            if (this.defaultSnap !== e.shiftKey) {
                const p1Screen = this.graphToScreen(this.points[p1].x, this.points[p1].y);
                const p2Screen = this.graphToScreen(this.points[p2].x, this.points[p2].y);
                for (let i = 0; i < this.points.length; i++) {
                    if (i !== p1 && i !== p2) {
                        const otherScreen = this.graphToScreen(this.points[i].x, this.points[i].y);
                        if (Math.abs(p1Screen.y - otherScreen.y) < 4) {
                            this.points[p1].y = this.points[i].y;
                        }
                        if (Math.abs(p2Screen.y - otherScreen.y) < 4) {
                            this.points[p2].y = this.points[i].y;
                        }
                    }
                }
            }
            
            for (let i = p1 - 1; i >= 0; i--) {
                if (this.points[i].x >= this.points[i + 1].x - 1) {
                    this.points[i].x = this.points[i + 1].x - 1;
                }
            }
            
            for (let i = p2 + 1; i < this.points.length; i++) {
                if (this.points[i].x <= this.points[i - 1].x + 1) {
                    this.points[i].x = this.points[i - 1].x + 1;
                }
            }
            
            if (this.onChange) {
                this.onChange();
            }
        } else if (this.isDragging && this.draggedPointIndex !== null) {
            e.preventDefault();
            e.stopPropagation();
            
            this.canvas.style.cursor = 'grabbing';
            
            const graph = this.screenToGraph(e.clientX, e.clientY);
            if (this.dragPointerStart && this.dragStartPoint) {
                graph.x += this.dragStartPoint.x - this.dragPointerStart.x;
                graph.y += this.dragStartPoint.y - this.dragPointerStart.y;
            }
            let newX = Math.max(this.minX, Math.min(this.maxX, graph.x));
            let newY = Math.max(this.minY, Math.min(this.maxY, graph.y));
            
            if (this.defaultSnap !== e.shiftKey && this.dragStartPoint) {

                const newScreen = this.graphToScreen(newX, newY);
                const startScreen = this.graphToScreen(this.dragStartPoint.x, this.dragStartPoint.y);

                const deltaX = Math.abs(newScreen.x - startScreen.x);
                const deltaY = Math.abs(newScreen.y - startScreen.y);

                if (this.lockAxis === null && (deltaX >= 5 || deltaY >= 5)) {
                    this.lockAxis = deltaX > deltaY ? 'X' : 'Y';
                }

                if (this.lockAxis === 'X') {
                    newY = this.dragStartPoint.y;
                } else if (this.lockAxis === 'Y') {
                    newX = this.dragStartPoint.x;
                }
            } else {
                this.lockAxis = null;
            }
            
            this.snapToY = null;
            this.snapToX = null;
            if (this.defaultSnap === e.shiftKey) {
                const newScreen = this.graphToScreen(newX, newY);
                for (let i = 0; i < this.points.length; i++) {
                    if (i !== this.draggedPointIndex) {
                        const otherScreen = this.graphToScreen(this.points[i].x, this.points[i].y);
                        if (Math.abs(newScreen.y - otherScreen.y) < 4) {
                            newY = this.points[i].y;
                            this.snapToY = newY;
                            break;
                        }
                    }
                }
                // Snap X to current frame
                const currentFrame = Math.floor(par.frame);
                if (currentFrame >= this.minX && currentFrame <= this.maxX) {
                    const frameScreen = this.graphToScreen(currentFrame, newY);
                    if (Math.abs(newScreen.x - frameScreen.x) < 4) {
                        newX = currentFrame;
                        this.snapToX = newX;
                    }
                }
            }
            
            if (!this.pushPointsHorizontally) {
                if (this.draggedPointIndex > 0 && newX <= this.points[this.draggedPointIndex - 1].x) {
                    newX = Math.max(newX, this.points[this.draggedPointIndex - 1].x + 1);
                }
                if (this.draggedPointIndex < this.points.length - 1 && newX >= this.points[this.draggedPointIndex + 1].x) {
                    newX = Math.min(newX, this.points[this.draggedPointIndex + 1].x - 1);
                }
            }
            
            this.points[this.draggedPointIndex].x = newX;
            this.points[this.draggedPointIndex].y = newY;
            
            if (this.pushPointsHorizontally) {
                for (let i = this.draggedPointIndex - 1; i >= 0; i--) {
                    if (this.points[i].x >= this.points[i + 1].x - 1) {
                        this.points[i].x = this.points[i + 1].x - 1;
                    }
                }
                
                for (let i = this.draggedPointIndex + 1; i < this.points.length; i++) {
                    if (this.points[i].x <= this.points[i - 1].x + 1) {
                        this.points[i].x = this.points[i - 1].x + 1;
                    }
                }
            }
            
            if (this.onChange) {
                this.onChange();
            }
        } else if (this.isDragging && this.isDraggingWindow) {
            e.preventDefault();
            e.stopPropagation();
            this.canvas.style.cursor = 'move';
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;
            const currentLeft = parseInt(this.div.style.left || 0);
            const currentTop = parseInt(this.div.style.top || 0);
            this.div.style.left = (currentLeft + deltaX) + 'px';
            this.div.style.top = (currentTop + deltaY) + 'px';
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        } else {
            this.updateCursor(x, y);
        }
    }

    onMouseUp(e) {
        // Capture before the flags are cleared below: dragging the A/B In/Out
        // markers mutates Sit.aFrame/bFrame, and the A-B-windowed live fit
        // nodes only refresh on this event (same contract as the frame
        // slider's marker drag and the I/O keys).
        const wasAOrB = this.isDraggingAFrame || this.isDraggingBFrame;
        if (this.isDragging) {
            e.preventDefault();
            e.stopPropagation();

            if (!this.isDraggingFrame && !this.isDraggingAFrame && !this.isDraggingBFrame && this.stateBeforeDrag && UndoManager) {
                const stateAfter = this.captureState();
                
                const hasChanged = JSON.stringify(this.stateBeforeDrag) !== JSON.stringify(stateAfter);
                
                if (hasChanged) {
                    const stateBefore = this.stateBeforeDrag;
                    UndoManager.add({
                        undo: () => {
                            this.restoreState(stateBefore);
                        },
                        redo: () => {
                            this.restoreState(stateAfter);
                        },
                        description: "Edit curve points"
                    });
                }
            }
            
            this.stateBeforeDrag = null;
            
        }
        
        this.isDragging = false;
        this.isDraggingWindow = false;
        this.draggedPointIndex = null;
        this.draggedLineIndex = null;
        this.isDraggingLine = false;
        this.isDraggingFrame = false;
        this.isDraggingAFrame = false;
        this.isDraggingBFrame = false;
        this.dragStartPoint = null;
        this.dragPointerStart = null;
        this.dragStartLineP1 = null;
        this.dragStartLineP2 = null;
        this.lockAxis = null;
        this.snapToY = null;
        this.snapToX = null;

        if (wasAOrB) {
            const before = this.limitsBeforeDrag, after = {a: Sit.aFrame, b: Sit.bFrame};
            this.limitsBeforeDrag = null;
            const restore = state => {
                Sit.aFrame = state.a; Sit.bFrame = state.b;
                EventManager.dispatchEvent("abFrameChanged"); setRenderOne(true);
            };
            if (before && (before.a !== after.a || before.b !== after.b)) UndoManager?.add({
                description: "Change playback limits", undo: () => restore(before), redo: () => restore(after),
            });
            EventManager.dispatchEvent("abFrameChanged");
        }

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        this.updateCursor(x, y);
    }
    
    interpolateValue(frame, points) {
        if (points.length === 0) return 0;
        if (points.length === 1) return points[0].y;
        
        if (frame < points[0].x) {
            const dx = points[1].x - points[0].x;
            const dy = points[1].y - points[0].y;
            const slope = dy / dx;
            return points[0].y + slope * (frame - points[0].x);
        }
        
        if (frame > points[points.length - 1].x) {
            const lastIdx = points.length - 1;
            const dx = points[lastIdx].x - points[lastIdx - 1].x;
            const dy = points[lastIdx].y - points[lastIdx - 1].y;
            const slope = dy / dx;
            return points[lastIdx].y + slope * (frame - points[lastIdx].x);
        }
        
        for (let i = 0; i < points.length - 1; i++) {
            if (frame >= points[i].x && frame <= points[i + 1].x) {
                const t = (frame - points[i].x) / (points[i + 1].x - points[i].x);
                return points[i].y + t * (points[i + 1].y - points[i].y);
            }
        }
        
        return points[points.length - 1].y;
    }
    
    calculateStep(range, availablePixels) {
        const targetTicks = 8;
        const roughStep = range / targetTicks;
        
        if (roughStep <= 0) return 1;
        
        const power = Math.floor(Math.log10(roughStep));
        const normalized = roughStep / Math.pow(10, power);
        
        let niceStep;
        if (normalized < 1.5) {
            niceStep = 1;
        } else if (normalized < 3.5) {
            niceStep = 2;
        } else if (normalized < 7.5) {
            niceStep = 5;
        } else {
            niceStep = 10;
        }
        
        return niceStep * Math.pow(10, power);
    }
    
    renderCanvas(frame) {
        super.renderCanvas(frame);

        if (!this.visible) return;

        const ctx = this.ctx;
        const margin = 60;
        const width = this.widthPx;
        const height = this.heightPx;
        if (width < margin * 2 + 10 || height < margin * 2 + 10) return;
        const graphWidth = width - margin * 2;
        const graphHeight = height - margin * 2;
        
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        
        ctx.strokeStyle = '#444';
        ctx.fillStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.font = '12px sans-serif';
        
        ctx.beginPath();
        ctx.rect(margin, margin, graphWidth, graphHeight);
        ctx.stroke();
        
        const xRange = this.maxX - this.minX;
        const yRange = this.maxY - this.minY;
        const dynamicXStep = this.calculateStep(xRange, graphWidth);
        const dynamicYStep = this.calculateStep(yRange, graphHeight);
        
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        for (let x = Math.ceil(this.minX / dynamicXStep) * dynamicXStep; x <= this.maxX; x += dynamicXStep) {
            const screen = this.graphToScreen(x, this.minY);
            ctx.beginPath();
            ctx.moveTo(screen.x, margin);
            ctx.lineTo(screen.x, margin + graphHeight);
            ctx.stroke();
            
            ctx.fillText(x.toString(), screen.x - 10, margin + graphHeight + 20);
        }
        
        ctx.textAlign = 'right';
        for (let y = Math.ceil(this.minY / dynamicYStep) * dynamicYStep; y <= this.maxY; y += dynamicYStep) {
            const screen = this.graphToScreen(this.minX, y);
            ctx.beginPath();
            ctx.moveTo(margin, screen.y);
            ctx.lineTo(margin + graphWidth, screen.y);
            ctx.stroke();
            
            ctx.fillText(y.toString(), margin - 5, screen.y + 5);
        }
        ctx.textAlign = 'left';
        
        ctx.fillStyle = '#fff';
        ctx.font = '14px sans-serif';
        ctx.fillText(this.xLabel, width / 2 - 20, height - 10);
        
        ctx.save();
        ctx.translate(15, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(this.yLabel, 0, 0);
        ctx.restore();
        
        // Use only active points (x < Sit.frames) for curve drawing;
        // disabled points are rendered as faded dots but don't affect the curve.
        const activePoints = this.getActivePoints();

        if (activePoints.length >= 1) {
            const firstX = activePoints[0].x;
            const firstY = activePoints[0].y;
            const lastX = activePoints[activePoints.length - 1].x;
            const lastY = activePoints[activePoints.length - 1].y;

            ctx.strokeStyle = '#4af';
            ctx.lineWidth = 2;
            ctx.beginPath();

            // Flat hold before first active point
            if (this.minX < firstX) {
                const s = this.graphToScreen(this.minX, firstY);
                ctx.moveTo(s.x, s.y);
                const e = this.graphToScreen(firstX, firstY);
                ctx.lineTo(e.x, e.y);
            }

            // Active point segments
            for (let i = 0; i < activePoints.length; i++) {
                const screen = this.graphToScreen(activePoints[i].x, activePoints[i].y);
                if (i === 0 && this.minX >= firstX) {
                    ctx.moveTo(screen.x, screen.y);
                } else {
                    ctx.lineTo(screen.x, screen.y);
                }
            }

            // Flat hold after last active point
            if (this.maxX > lastX) {
                const e = this.graphToScreen(this.maxX, lastY);
                ctx.lineTo(e.x, e.y);
            }

            ctx.stroke();
        }

        for (let i = 0; i < this.points.length; i++) {
            const disabled = this.points[i].x >= Sit.frames;
            ctx.fillStyle = disabled ? 'rgba(74, 170, 255, 0.3)' : '#4af';
            const screen = this.graphToScreen(this.points[i].x, this.points[i].y);
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
            ctx.fill();
        }
        
        if (Sit.aFrame !== undefined && Sit.aFrame >= this.minX && Sit.aFrame <= this.maxX) {
            const frameScreen = this.graphToScreen(Sit.aFrame, this.minY);
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(frameScreen.x, margin);
            ctx.lineTo(frameScreen.x, height - margin);
            ctx.stroke();
        }
        
        if (Sit.bFrame !== undefined && Sit.bFrame >= this.minX && Sit.bFrame <= this.maxX) {
            const frameScreen = this.graphToScreen(Sit.bFrame, this.minY);
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(frameScreen.x, margin);
            ctx.lineTo(frameScreen.x, height - margin);
            ctx.stroke();
        }
        
        if (par.frame >= this.minX && par.frame <= this.maxX) {
            const frameScreen = this.graphToScreen(par.frame, this.minY);
            ctx.strokeStyle = '#ff0';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(frameScreen.x, margin);
            ctx.lineTo(frameScreen.x, height - margin);
            ctx.stroke();
        }
        
        if (this.snapToY !== null) {
            const snapScreen = this.graphToScreen(this.minX, this.snapToY);
            ctx.strokeStyle = 'red';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(margin, snapScreen.y);
            ctx.lineTo(width - margin, snapScreen.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (this.snapToX !== null) {
            const snapScreen = this.graphToScreen(this.snapToX, this.minY);
            ctx.strokeStyle = 'red';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(snapScreen.x, margin);
            ctx.lineTo(snapScreen.x, height - margin);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
    
    getPoints() {
        return this.points;
    }

    getActivePoints() {
        return this.points.filter(p => p.x < Sit.frames);
    }
    
    show(visible=true) {
        if (visible) {
            this.replaceDefaultSentinel();
        }
        super.show(visible);
    }

    replaceDefaultSentinel() {
        if (this.points.length === 1 && this.points[0].x === 99 && this.points[0].y === 99) {
            const currentFrame = Math.floor(par.frame);
            let currentFOV = 30;
            const lookView = NodeMan.get("lookView", false);
            if (lookView && lookView.camera) {
                currentFOV = lookView.camera.fov;
            }
            currentFOV = Math.round(currentFOV * 10) / 10;
            this.points = [{x: currentFrame, y: currentFOV}];
            if (this.onChange) {
                this.onChange();
            }
        }
    }

    setPoints(points) {
        this.points = points;
    }
}

export class CNodeOSDGraphView extends CNodeCurveEditorView2 {
    constructor(v) {
        v.editorConfig = {
            minX: 0, maxX: Sit.frames - 1,
            minY: 0, maxY: 1,
            xLabel: "Frame", yLabel: "",
            xStep: 10, yStep: 1,
        };
        v.menuName = v.menuName ?? "OSD Graph";
        super(v);
        this.series = [];
        this.hasY2 = false;
        this.minY2 = 0;
        this.maxY2 = 1;
        this.isFrameX = true;
    }

    addMenuItems() {
    }

    screenToGraphAxis(screenX, screenY, minY, maxY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = screenX - rect.left;
        const y = screenY - rect.top;
        const margin = 60;
        const rightMargin = this.hasY2 ? 60 : 60;
        const graphWidth = this.widthPx - margin - rightMargin;
        const graphHeight = this.heightPx - margin * 2;
        const graphX = this.minX + (x - margin) / graphWidth * (this.maxX - this.minX);
        const graphY = maxY - (y - margin) / graphHeight * (maxY - minY);
        return { x: graphX, y: graphY };
    }

    interpolateSeriesAtFrame(s, frame) {
        if (!s || s.data.length === 0) return null;
        const exact = s.data.find(p => p.frame === frame);
        if (exact) return { x: exact.x, y: exact.y };
        const sorted = [...s.data].sort((a, b) => a.frame - b.frame);
        let before = null, after = null;
        for (const p of sorted) {
            if (p.frame <= frame) before = p;
            if (p.frame >= frame && !after) after = p;
        }
        if (!before && !after) return null;
        if (!before) return { x: after.x, y: after.y };
        if (!after || before.frame === after.frame) return { x: before.x, y: before.y };
        const t = (frame - before.frame) / (after.frame - before.frame);
        return { x: before.x + t * (after.x - before.x), y: before.y + t * (after.y - before.y) };
    }

    getCrosshairScreenPos() {
        if (this.series.length === 0) return null;
        const currentFrame = Math.floor(par.frame);
        const s = this.series[0];
        const interp = this.interpolateSeriesAtFrame(s, currentFrame);
        if (!interp) return null;
        const interpX = this.isFrameX ? currentFrame : interp.x;
        const isY2 = s.yAxis === 2;
        const sMinY = isY2 ? this.minY2 : this.minY;
        const sMaxY = isY2 ? this.maxY2 : this.maxY;
        return this.graphToScreenAxis(interpX, interp.y, sMinY, sMaxY);
    }

    getAllDataSorted() {
        const all = [];
        for (const s of this.series) {
            for (const pt of s.data) {
                all.push(pt);
            }
        }
        return all;
    }

    interpolateAtFrame(sorted, frame) {
        const exact = sorted.find(p => p.frame === frame);
        if (exact) return { x: exact.x, y: exact.y };
        let before = null, after = null;
        for (const p of sorted) {
            if (p.frame <= frame) before = p;
            if (p.frame >= frame && !after) after = p;
        }
        if (!before && !after) return null;
        if (!before) return { x: after.x, y: after.y };
        if (!after || before.frame === after.frame) return { x: before.x, y: before.y };
        const t = (frame - before.frame) / (after.frame - before.frame);
        return { x: before.x + t * (after.x - before.x), y: before.y + t * (after.y - before.y) };
    }

    snapToNearestByAxis(screenX, screenY, axis) {
        const s = this.series[0];
        if (!s || s.data.length === 0) return;
        const isY2 = s.yAxis === 2;
        const sMinY = isY2 ? this.minY2 : this.minY;
        const sMaxY = isY2 ? this.maxY2 : this.maxY;
        const sorted = [...s.data].sort((a, b) => a.frame - b.frame);
        const minFrame = sorted[0].frame;
        const maxFrame = sorted[sorted.length - 1].frame;

        let bestDist = Infinity;
        let bestFrame = null;
        for (let f = minFrame; f <= maxFrame; f++) {
            const pt = this.interpolateAtFrame(sorted, f);
            if (!pt) continue;
            const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
            const dist = axis === 'h' ? Math.abs(screen.y - screenY) : Math.abs(screen.x - screenX);
            if (dist < bestDist) {
                bestDist = dist;
                bestFrame = f;
            }
        }
        if (bestFrame !== null) {
            const frameSlider = NodeMan.get("frameSlider", false);
            if (frameSlider) {
                frameSlider.setFrame(bestFrame);
            } else {
                par.frame = bestFrame;
            }
            setRenderOne();
        }
    }

    onMouseDown(e) {
        if (e.button !== 0) return;
        if (this.isFrameX) {
            super.onMouseDown(e);
            return;
        }
        const crosshair = this.getCrosshairScreenPos();
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        if (crosshair) {
            const threshold = this.interactionRadius ?? 8;
            const nearV = Math.abs(mx - crosshair.x) < threshold;
            const nearH = Math.abs(my - crosshair.y) < threshold;
            if (nearH || nearV) {
                this._draggingAxis = nearH ? 'h' : 'v';
                e.stopPropagation();
                e.preventDefault();
                return;
            }
        }

        // Click in margin area: start window drag
        if (!this.isInsideGraphArea(mx, my)) {
            e.preventDefault();
            e.stopPropagation();
            this.isDragging = true;
            this.isDraggingWindow = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        }
    }

    onMouseMove(e) {
        if (this._draggingAxis) {
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            this.snapToNearestByAxis(mx, my, this._draggingAxis);
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        super.onMouseMove(e);
    }

    onMouseUp(e) {
        if (this._draggingAxis) {
            this._draggingAxis = null;
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        super.onMouseUp(e);
    }

    setSeries(series) {
        this.series = series;
        this.autoScale();
        setRenderOne();
    }

    autoScale() {
        if (this.series.length === 0) return;

        let allMinX = Infinity, allMaxX = -Infinity;
        const yBounds = { 1: { min: Infinity, max: -Infinity }, 2: { min: Infinity, max: -Infinity } };

        for (const s of this.series) {
            const axis = s.yAxis || 1;
            for (const pt of s.data) {
                if (pt.x < allMinX) allMinX = pt.x;
                if (pt.x > allMaxX) allMaxX = pt.x;
                if (pt.y < yBounds[axis].min) yBounds[axis].min = pt.y;
                if (pt.y > yBounds[axis].max) yBounds[axis].max = pt.y;
            }
        }

        if (!isFinite(allMinX)) { allMinX = 0; allMaxX = Sit.frames - 1; }
        if (allMinX === allMaxX) { allMinX -= 1; allMaxX += 1; }

        const padAxis = (b) => {
            if (!isFinite(b.min)) { b.min = 0; b.max = 1; }
            if (b.min === b.max) { b.min -= 1; b.max += 1; }
            const p = (b.max - b.min) * 0.05;
            return { min: b.min - p, max: b.max + p };
        };

        const hasY1 = this.series.some(s => (s.yAxis || 1) === 1);
        const hasY2 = this.series.some(s => s.yAxis === 2);

        const y1 = hasY1 ? padAxis(yBounds[1]) : { min: 0, max: 1 };
        const y2 = hasY2 ? padAxis(yBounds[2]) : { min: 0, max: 1 };

        if (!this.isFrameX) {
            const margin = 60;
            const rightMargin = hasY2 ? 60 : 60;
            const graphWidth = this.widthPx - margin - rightMargin;
            const graphHeight = this.heightPx - margin * 2;

            const xPad = (allMaxX - allMinX) * 0.02;
            const yPad = (y1.max - y1.min) * 0.02;
            let xRange = (allMaxX - allMinX) + xPad * 2;
            let yRange = (y1.max - y1.min) + yPad * 2;

            const unitsPerPxX = xRange / graphWidth;
            const unitsPerPxY = yRange / graphHeight;
            const unitsPerPx = Math.max(unitsPerPxX, unitsPerPxY);

            xRange = unitsPerPx * graphWidth;
            yRange = unitsPerPx * graphHeight;

            const xMid = (allMinX + allMaxX) / 2;
            const yMid = (y1.min + y1.max) / 2;
            this.minX = xMid - xRange / 2;
            this.maxX = xMid + xRange / 2;
            this.minY = yMid - yRange / 2;
            this.maxY = yMid + yRange / 2;
        } else {
            const xPadding = (allMaxX - allMinX) * 0.02;
            this.minX = allMinX - xPadding;
            this.maxX = allMaxX + xPadding;
            this.minY = y1.min;
            this.maxY = y1.max;
        }

        this.minY2 = y2.min;
        this.maxY2 = y2.max;
        this.hasY2 = hasY2;
    }

    graphToScreenAxis(graphX, graphY, minY, maxY) {
        const margin = 60;
        const rightMargin = this.hasY2 ? 60 : 60;
        const graphWidth = this.widthPx - margin - rightMargin;
        const graphHeight = this.heightPx - margin * 2;
        const x = margin + (graphX - this.minX) / (this.maxX - this.minX) * graphWidth;
        const y = margin + (maxY - graphY) / (maxY - minY) * graphHeight;
        return { x, y };
    }

    renderCanvas(frame) {
        if (!this.visible) return;

        const currentA = Sit.aFrame ?? 0;
        const currentB = Sit.bFrame ?? (Sit.frames - 1);
        if (this._lastAFrame !== currentA || this._lastBFrame !== currentB) {
            this._lastAFrame = currentA;
            this._lastBFrame = currentB;
            const controller = NodeMan.get("osdDataSeriesController", false);
            if (controller) controller.updateGraph();
        }

        if (this._lastWidth !== this.widthPx || this._lastHeight !== this.heightPx) {
            this._lastWidth = this.widthPx;
            this._lastHeight = this.heightPx;
            this.autoScale();
        }

        const ctx = this.ctx;
        const margin = 60;
        const rightMargin = this.hasY2 ? 60 : 60;

        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);

        const width = this.widthPx;
        const height = this.heightPx;
        if (width < margin + rightMargin + 10 || height < margin * 2 + 10) return;
        const graphWidth = width - margin - rightMargin;
        const graphHeight = height - margin * 2;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = '#444';
        ctx.fillStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.font = '12px sans-serif';

        ctx.beginPath();
        ctx.rect(margin, margin, graphWidth, graphHeight);
        ctx.stroke();

        const xRange = this.maxX - this.minX;
        const y1Range = this.maxY - this.minY;
        const dynamicXStep = this.calculateStep(xRange, graphWidth);
        const dynamicY1Step = this.calculateStep(y1Range, graphHeight);

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        for (let x = Math.ceil(this.minX / dynamicXStep) * dynamicXStep; x <= this.maxX; x += dynamicXStep) {
            const screen = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.beginPath();
            ctx.moveTo(screen.x, margin);
            ctx.lineTo(screen.x, margin + graphHeight);
            ctx.stroke();
        }
        for (let y = Math.ceil(this.minY / dynamicY1Step) * dynamicY1Step; y <= this.maxY; y += dynamicY1Step) {
            const screen = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.beginPath();
            ctx.moveTo(margin, screen.y);
            ctx.lineTo(margin + graphWidth, screen.y);
            ctx.stroke();
        }

        ctx.fillStyle = '#ddd';
        ctx.textAlign = 'center';
        for (let x = Math.ceil(this.minX / dynamicXStep) * dynamicXStep; x <= this.maxX; x += dynamicXStep) {
            const screen = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.fillText(Math.round(x).toString(), screen.x, margin + graphHeight + 20);
        }

        const SERIES_COLORS = ['#4af', '#f44', '#4f4', '#fa4', '#f4f', '#4ff'];
        const y1Color = SERIES_COLORS[0];
        const y2Color = SERIES_COLORS[1];

        const formatLabel = (v) => Math.abs(v) < 1 ? v.toFixed(2) : Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toString();

        ctx.fillStyle = y1Color;
        ctx.textAlign = 'right';
        for (let y = Math.ceil(this.minY / dynamicY1Step) * dynamicY1Step; y <= this.maxY; y += dynamicY1Step) {
            const screen = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.fillText(formatLabel(y), margin - 5, screen.y + 4);
        }

        if (this.hasY2) {
            const y2Range = this.maxY2 - this.minY2;
            const dynamicY2Step = this.calculateStep(y2Range, graphHeight);
            ctx.fillStyle = y2Color;
            ctx.textAlign = 'left';
            for (let y = Math.ceil(this.minY2 / dynamicY2Step) * dynamicY2Step; y <= this.maxY2; y += dynamicY2Step) {
                const screen = this.graphToScreenAxis(this.maxX, y, this.minY2, this.maxY2);
                ctx.fillText(formatLabel(y), margin + graphWidth + 5, screen.y + 4);
            }
        }
        ctx.textAlign = 'left';

        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText(this.xLabel, margin + graphWidth / 2, height - 10);

        const y1Labels = [];
        const y2Labels = [];
        for (const s of this.series) {
            if (s.raw) continue;
            if (s.yAxis === 2) y2Labels.push(s.label);
            else y1Labels.push(s.label);
        }
        if (y1Labels.length > 0) {
            ctx.fillStyle = y1Color;
            ctx.textAlign = 'left';
            ctx.fillText(y1Labels.join(', '), 5, margin - 8);
        }
        if (y2Labels.length > 0) {
            ctx.fillStyle = y2Color;
            ctx.textAlign = 'right';
            ctx.fillText(y2Labels.join(', '), width - 5, margin - 8);
        }
        ctx.textAlign = 'left';

        for (let si = 0; si < this.series.length; si++) {
            const s = this.series[si];
            if (s.data.length === 0) continue;
            const isY2 = s.yAxis === 2;
            const sMinY = isY2 ? this.minY2 : this.minY;
            const sMaxY = isY2 ? this.maxY2 : this.maxY;
            const mainColor = isY2 ? SERIES_COLORS[1] : SERIES_COLORS[0];
            const rawStroke = 'rgba(255, 0, 0, 0.5)';

            if (this.isFrameX) {
                if (s.raw) {
                    ctx.strokeStyle = rawStroke;
                    ctx.lineWidth = 1;
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    let prev = null;
                    for (const pt of s.data) {
                        const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                        if (prev === null) {
                            ctx.moveTo(screen.x, screen.y);
                        } else {
                            ctx.lineTo(screen.x, prev.y);
                            ctx.lineTo(screen.x, screen.y);
                        }
                        prev = screen;
                    }
                    ctx.stroke();
                    ctx.setLineDash([]);
                } else {
                    ctx.strokeStyle = mainColor;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    let started = false;
                    for (const pt of s.data) {
                        const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                        if (!started) { ctx.moveTo(screen.x, screen.y); started = true; }
                        else ctx.lineTo(screen.x, screen.y);
                    }
                    ctx.stroke();
                }
            } else {
                const stroke = s.raw ? rawStroke : mainColor;
                ctx.fillStyle = stroke;
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1;
                if (s.raw) ctx.setLineDash([5, 5]);
                ctx.beginPath();
                let prev = null;
                for (const pt of s.data) {
                    const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                    if (prev) {
                        ctx.moveTo(prev.x, prev.y);
                        ctx.lineTo(screen.x, screen.y);
                    }
                    prev = screen;
                }
                ctx.stroke();
                ctx.setLineDash([]);
                if (!s.raw) {
                    for (const pt of s.data) {
                        const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                        ctx.beginPath();
                        ctx.arc(screen.x, screen.y, 3, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        }

        const currentFrame = Math.floor(par.frame);
        if (this.isFrameX) {
            if (currentFrame >= this.minX && currentFrame <= this.maxX) {
                const frameScreen = this.graphToScreenAxis(currentFrame, this.minY, this.minY, this.maxY);
                ctx.strokeStyle = '#ff0';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(frameScreen.x, margin);
                ctx.lineTo(frameScreen.x, height - margin);
                ctx.stroke();

                // Draw horizontal crosshair lines and dots at interpolated Y values
                for (let si = 0; si < this.series.length; si++) {
                    const s = this.series[si];
                    if (s.raw) continue;
                    const interp = this.interpolateSeriesAtFrame(s, currentFrame);
                    if (!interp) continue;
                    const isY2 = s.yAxis === 2;
                    const sMinY = isY2 ? this.minY2 : this.minY;
                    const sMaxY = isY2 ? this.maxY2 : this.maxY;
                    const yScreen = this.graphToScreenAxis(currentFrame, interp.y, sMinY, sMaxY);
                    ctx.strokeStyle = '#ff0';
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(margin, yScreen.y);
                    ctx.lineTo(margin + graphWidth, yScreen.y);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    const color = isY2 ? SERIES_COLORS[1] : SERIES_COLORS[0];
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(frameScreen.x, yScreen.y, 5, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        } else {
            for (const s of this.series) {
                if (s.raw) continue;
                const interp = this.interpolateSeriesAtFrame(s, currentFrame);
                if (!interp) continue;
                const isY2 = s.yAxis === 2;
                const sMinY = isY2 ? this.minY2 : this.minY;
                const sMaxY = isY2 ? this.maxY2 : this.maxY;
                const screen = this.graphToScreenAxis(interp.x, interp.y, sMinY, sMaxY);
                ctx.strokeStyle = '#ff0';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(screen.x, margin);
                ctx.lineTo(screen.x, margin + graphHeight);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(margin, screen.y);
                ctx.lineTo(margin + graphWidth, screen.y);
                ctx.stroke();
                break;
            }
        }
    }
}

export class CNodeCurveEditor2 extends CNodeTrack {
    constructor(v) {
        super(v);
        
        const config = v.editorConfig;
        
        this.useSitFrames = false;
        if (config.maxX === "Sit.frames") {
            this.useSitFrames = true;
            config.maxX = Sit.frames;
        }
        
        // This node owns a WINDOW the user opens and closes deliberately, which means its
        // visibility must not be driven by the dependency graph — see CNode.showActiveSources,
        // where selecting any switch downstream of the camera used to re-open this editor.
        this.isEditorWindow = true;

        const viewId = v.id + "View";
        this.editorView = new CNodeCurveEditorView2({
            ...v,
            id: viewId,
            editorConfig: config
        });
        
        this.editorView.onChange = () => this.onPointsChanged();
        
        this.frames = v.frames ?? Sit.frames;
        if (this.frames === -1) {
            this.frames = Sit.frames;
        }
        
        this.array = new Array(this.frames);
        this.recalculate();
    }
    
    onPointsChanged() {
        this.recalculate();
        this.recalculateCascade();
    }
    
    recalculate() {
        super.recalculate();

        const points = this.editorView.getActivePoints();

        if (points.length === 0) {
            this.array.fill(0);
            return;
        }

        // Hold flat beyond the active point range instead of extrapolating,
        // since disabled points beyond Sit.frames are excluded.
        const firstY = points[0].y;
        const lastY = points[points.length - 1].y;
        const firstX = points[0].x;
        const lastX = points[points.length - 1].x;

        for (let f = 0; f < this.frames; f++) {
            if (f < firstX) {
                this.array[f] = firstY;
            } else if (f > lastX) {
                this.array[f] = lastY;
            } else {
                this.array[f] = this.interpolateValue(f, points);
            }
        }
    }
    
    interpolateValue(frame, points) {
        if (points.length === 0) return 0;
        if (points.length === 1) return points[0].y;
        
        if (frame < points[0].x) {
            const dx = points[1].x - points[0].x;
            const dy = points[1].y - points[0].y;
            const slope = dy / dx;
            return points[0].y + slope * (frame - points[0].x);
        }
        
        if (frame > points[points.length - 1].x) {
            const lastIdx = points.length - 1;
            const dx = points[lastIdx].x - points[lastIdx - 1].x;
            const dy = points[lastIdx].y - points[lastIdx - 1].y;
            const slope = dy / dx;
            return points[lastIdx].y + slope * (frame - points[lastIdx].x);
        }
        
        for (let i = 0; i < points.length - 1; i++) {
            if (frame >= points[i].x && frame <= points[i + 1].x) {
                const t = (frame - points[i].x) / (points[i + 1].x - points[i].x);
                return points[i].y + t * (points[i + 1].y - points[i].y);
            }
        }
        
        return points[points.length - 1].y;
    }
    
    update(f) {
        super.update(f);
        
        if (this.useSitFrames) {
            if (Sit.frames !== this.frames) {
                this.frames = Sit.frames;
                this.array = new Array(this.frames);
                this.recalculate();
            }
            if (Sit.frames !== this.editorView.maxX) {
                this.editorView.maxX = Sit.frames;
            }
        }
    }
    
    show(visible=true) {
        super.show(visible);
        if (this.editorView) {
            this.editorView.show(visible);
        }
    }
    
    modSerialize() {
        const points = this.editorView.getPoints();
        const flatPoints = [];
        for (let i = 0; i < points.length; i++) {
            flatPoints.push(points[i].x, points[i].y);
        }
        
        return {
            ...super.modSerialize(),
            points: flatPoints,
            defaultSnap: this.editorView.defaultSnap,
            maxY: this.editorView.maxY,
        };
    }
    
    modDeserialize(v) {
        super.modDeserialize(v);
        
        if (v.points) {
            const points = [];
            for (let i = 0; i < v.points.length; i += 2) {
                points.push({x: v.points[i], y: v.points[i + 1]});
            }
            this.editorView.setPoints(points);
            this.recalculate();
        }
        
        if (v.defaultSnap !== undefined) {
            this.editorView.defaultSnap = v.defaultSnap;
        }

        if (v.maxY !== undefined) {
            this.editorView.maxY = v.maxY;
            if (this.editorView.yRangeSlider) {
                this.editorView.yRangeSlider.value = v.maxY;
            }
        }
    }
    
    getValueFrame(f) {
        return this.array[Math.floor(f)];
    }
}
