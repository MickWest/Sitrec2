// Annotation overlay: a drawing surface sitting on top of CNodeVideoView.
// - Vector strokes stored in original-video pixel coordinates (resolution independent)
// - Toolbar with pencil/brush/line/arrow/rect/ellipse/text/eraser
// - Color, width, opacity controls
// - Adjustable fade so strokes vanish N frames after they were drawn (0 = persistent)
// - Fully serializable via modSerialize / modDeserialize
// - When Enabled is off: toolbar hidden, mouse passes through, render is a no-op

import {CNodeActiveOverlay} from "./CNodeTrackingOverlay";
import {NodeMan, setRenderOne, guiMenus} from "../Globals";
import {par} from "../par";
import {mouseToCanvas} from "../ViewUtils";
import {undoManager} from "../UndoManager";
import {assert} from "../assert";
import {CNodeVideoView} from "./CNodeVideoView";

const TOOLS = ["select", "pencil", "brush", "line", "arrow", "rect", "ellipse", "text", "image", "eraser"];

// SVG icons (24x24) for the toolbar buttons
const ICONS = {
    select: '<path d="M4 3l13 9-6 1-2 6-5-16z" fill="currentColor"/>',
    pencil: '<path d="M3 21l3.75-.75L20.71 6.29a1 1 0 000-1.41l-1.59-1.59a1 1 0 00-1.41 0L3.75 17.25 3 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    brush:  '<path d="M4 20c3 0 5-2 5-5 0-1.5-1-2.5-2.5-2.5S4 13.5 4 15v5zm5-5l9-9-3-3-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    line:   '<line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>',
    arrow:  '<line x1="4" y1="20" x2="19" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><polyline points="11,5 19,5 19,13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>',
    rect:   '<rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="2"/>',
    ellipse:'<ellipse cx="12" cy="12" rx="8" ry="6" fill="none" stroke="currentColor" stroke-width="2"/>',
    text:   '<text x="12" y="18" text-anchor="middle" font-family="serif" font-weight="bold" font-size="18" fill="currentColor">T</text>',
    image:  '<rect x="3" y="5" width="18" height="14" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="10" r="1.5" fill="currentColor"/><path d="M3 17l5-5 4 4 3-3 6 6" fill="none" stroke="currentColor" stroke-width="2"/>',
    eraser: '<path d="M16 3l5 5-9 9H7l-4-4 13-10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><line x1="9" y1="9" x2="17" y2="17" stroke="currentColor" stroke-width="2"/>',
    clear:  '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    undo:   '<path d="M9 14l-5-5 5-5M4 9h9a6 6 0 010 12h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
};

const TOOL_TITLES = {
    select: "Select / Move (S)",
    pencil: "Pencil (P)",
    brush: "Brush (B)",
    line: "Line (L)",
    arrow: "Arrow (A)",
    rect: "Rectangle (R)",
    ellipse: "Ellipse (E)",
    text: "Text (T)",
    image: "Image — click to pick, or drop a file (I)",
    eraser: "Eraser (X)",
};

const TOOL_HOTKEYS = {
    "KeyS": "select",
    "KeyP": "pencil",
    "KeyB": "brush",
    "KeyL": "line",
    "KeyA": "arrow",
    "KeyR": "rect",
    "KeyE": "ellipse",
    "KeyT": "text",
    "KeyI": "image",
    "KeyX": "eraser",
};

// Cache decoded images so we don't re-decode the dataURL every frame.
const IMAGE_CACHE = new Map(); // dataURL -> HTMLImageElement


export class CNodeAnnotateOverlay extends CNodeActiveOverlay {
    constructor(v) {
        super(v);
        assert(this.overlayView instanceof CNodeVideoView,
            "CNodeAnnotateOverlay: overlayView must be a CNodeVideoView");

        this.separateVisibility = true;
        this.doubleClickResizes = false;
        this.doubleClickFullScreen = false;

        this.strokes = [];

        // Two independent gates.
        //   show:    render existing annotations (read-only viewing)
        //   editing: toolbar visible + mouse captured for drawing
        // Both off  -> truly nop: no render work, no event capture, no DOM
        // Editing implies show (you can't edit invisibly).
        this.show = v.show ?? true;
        this.editing = v.editing ?? false;
        this.tool = v.tool ?? "pencil";
        this.color = v.color ?? "#ff0000";
        this.strokeWidth = v.strokeWidth ?? 3;    // in original-video pixels
        this.opacity = v.opacity ?? 1.0;
        this.fadeFrames = v.fadeFrames ?? 0; // 0 = no fade, otherwise # frames after which stroke is gone
        this.showWhileDrawing = true;

        this.activeStroke = null;  // in-progress stroke
        this.selectedStroke = null;
        this.dragMode = null;      // "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se" | null
        this.dragGrabOffset = null;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.visible = true;       // canvas always rendered; renderCanvas no-ops when disabled

        this._buildToolbar();
        this._setupGUI();
        this._installDropHandlers();
        this._updateToolbarVisibility();
        this._installKeyHandler();
    }

    // ---------- Serialization ----------

    modSerialize() {
        return {
            ...super.modSerialize(),
            show: this.show,
            editing: this.editing,
            tool: this.tool,
            color: this.color,
            strokeWidth: this.strokeWidth,
            opacity: this.opacity,
            fadeFrames: this.fadeFrames,
            strokes: this.strokes,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.show !== undefined) this.show = v.show;
        if (v.editing !== undefined) this.editing = v.editing;
        // Back-compat with the brief earlier "enabled" form.
        if (v.enabled !== undefined) this.editing = v.enabled;
        if (v.tool !== undefined) this.tool = v.tool;
        if (v.color !== undefined) this.color = v.color;
        if (v.strokeWidth !== undefined) this.strokeWidth = v.strokeWidth;
        if (v.opacity !== undefined) this.opacity = v.opacity;
        if (v.fadeFrames !== undefined) this.fadeFrames = v.fadeFrames;
        if (Array.isArray(v.strokes)) this.strokes = v.strokes;
        this._refreshToolButtons();
        this._refreshControls();
        this._updateToolbarVisibility();
        setRenderOne(true);
    }

    // ---------- GUI (lil-gui folder in Video menu) ----------

    _setupGUI() {
        // Place under the Video menu since this is a video-overlay feature.
        const parentMenu = guiMenus.video ?? guiMenus.view ?? guiMenus.main;
        if (!parentMenu) return;
        this.gui = parentMenu.addFolder("Annotate").close();
        this.gui.add(this, "show").name("Show Annotations").listen().onChange(() => {
            // Show is the master switch. Turning it off forces Edit Mode off too:
            // the toolbar hides, mouse stops being captured, and the canvas is
            // a no-op. Turning Show back on doesn't auto-enter Edit Mode — the
            // user re-enables Edit explicitly.
            this._updateToolbarVisibility();
            setRenderOne(true);
        }).tooltip("Master switch. When off, annotations are hidden, the toolbar disappears, mouse passes through, and editing is suppressed.");

        this.gui.add(this, "editing").name("Edit Mode").listen().onChange(() => {
            // Editing implies the strokes you're drawing must be visible.
            if (this.editing) this.show = true;
            this._updateToolbarVisibility();
            setRenderOne(true);
        }).tooltip("Show the drawing toolbar and capture mouse for drawing. Requires Show Annotations to be on.");

        this.gui.add(this, "fadeFrames", 0, 600, 1).name("Fade Frames").listen().onChange(() => {
            setRenderOne(true);
        }).tooltip("How many frames before a stroke fully fades out. 0 = strokes are persistent.");

        this.gui.add(this, "opacity", 0, 1, 0.01).name("Opacity").listen().onChange(() => {
            setRenderOne(true);
        });

        this.gui.add(this, "strokeWidth", 0.5, 60, 0.5).name("Line Width").listen();
        this.gui.addColor(this, "color").name("Color").listen();

        this.gui.add(this, "clearAll").name("Clear All").tooltip("Delete every annotation stroke (undoable).");
    }

    // ---------- Toolbar (DOM, lives inside the video view's div) ----------

    _buildToolbar() {
        const host = this.overlayView.div;
        const bar = document.createElement("div");
        bar.className = "annotate-toolbar";
        Object.assign(bar.style, {
            position: "absolute",
            top: "6px",
            left: "6px",
            zIndex: 50,
            display: "flex",
            flexDirection: "row",
            flexWrap: "wrap",
            gap: "2px",
            padding: "4px",
            background: "rgba(20,20,20,0.78)",
            borderRadius: "5px",
            border: "1px solid #444",
            font: "12px sans-serif",
            color: "#ddd",
            userSelect: "none",
            pointerEvents: "auto",
        });
        // Stop drags inside the toolbar from being interpreted as view drags/draws.
        ["mousedown","mouseup","mousemove","click","dblclick","wheel"].forEach(ev => {
            bar.addEventListener(ev, e => e.stopPropagation());
        });

        this._toolButtons = {};
        for (const tool of TOOLS) {
            const btn = this._makeIconButton(ICONS[tool], TOOL_TITLES[tool], () => this.setTool(tool));
            this._toolButtons[tool] = btn;
            bar.appendChild(btn);
        }

        bar.appendChild(this._makeSeparator());

        // Color swatch (native color input)
        this._colorInput = document.createElement("input");
        this._colorInput.type = "color";
        this._colorInput.value = this.color;
        this._colorInput.title = "Color";
        Object.assign(this._colorInput.style, {
            width: "28px", height: "28px", padding: "0", border: "1px solid #555",
            borderRadius: "3px", background: "transparent", cursor: "pointer",
        });
        this._colorInput.addEventListener("input", () => {
            this.color = this._colorInput.value;
            // If a stroke is selected, also recolor it in-place (user expects
            // the color picker to edit the selection, not just the next stroke).
            if (this.selectedStroke && this.selectedStroke.tool !== "image") {
                this.selectedStroke.color = this.color;
                setRenderOne(true);
            }
            this.gui?.controllersRecursive?.().forEach(c => c.updateDisplay?.());
        });
        bar.appendChild(this._colorInput);

        // Width control (number + slider)
        this._widthSlider = document.createElement("input");
        this._widthSlider.type = "range";
        this._widthSlider.min = "0.5";
        this._widthSlider.max = "60";
        this._widthSlider.step = "0.5";
        this._widthSlider.value = String(this.strokeWidth);
        this._widthSlider.title = "Line width";
        Object.assign(this._widthSlider.style, { width: "90px", verticalAlign: "middle" });
        this._widthSlider.addEventListener("input", () => {
            this.strokeWidth = parseFloat(this._widthSlider.value);
            // Apply width change to the selected stroke (if any & meaningful).
            if (this.selectedStroke && this.selectedStroke.tool !== "image") {
                this.selectedStroke.width = this.strokeWidth;
                setRenderOne(true);
            }
        });
        bar.appendChild(this._widthSlider);

        bar.appendChild(this._makeSeparator());

        bar.appendChild(this._makeIconButton(ICONS.undo, "Undo last stroke (Ctrl+Z)", () => {
            undoManager.undo();
        }));
        bar.appendChild(this._makeIconButton(ICONS.clear, "Clear all", () => this.clearAll()));

        // Done button (turn annotation mode off)
        const done = document.createElement("button");
        done.textContent = "Done";
        Object.assign(done.style, {
            marginLeft: "4px", padding: "2px 8px",
            background: "#345", color: "#fff", border: "1px solid #567",
            borderRadius: "3px", cursor: "pointer", font: "11px sans-serif",
        });
        done.addEventListener("click", () => {
            this.editing = false;
            this._updateToolbarVisibility();
            this.gui?.controllersRecursive?.().forEach(c => c.updateDisplay?.());
            setRenderOne(true);
        });
        bar.appendChild(done);

        host.appendChild(bar);
        this._toolbar = bar;
        this._refreshToolButtons();
    }

    _makeSeparator() {
        const s = document.createElement("div");
        Object.assign(s.style, {
            width: "1px", background: "#555", margin: "2px 4px",
        });
        return s;
    }

    _makeIconButton(svgInner, title, onClick) {
        const btn = document.createElement("button");
        btn.title = title;
        btn.dataset.icon = "1";
        Object.assign(btn.style, {
            width: "30px", height: "30px",
            background: "#222", color: "#ddd",
            border: "1px solid #444", borderRadius: "3px",
            cursor: "pointer", padding: "0",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
        });
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" style="display:block">${svgInner}</svg>`;
        btn.addEventListener("click", onClick);
        btn.addEventListener("mouseenter", () => { btn.style.background = "#333"; });
        btn.addEventListener("mouseleave", () => {
            btn.style.background = (btn.dataset.active === "1") ? "#0a64a4" : "#222";
        });
        return btn;
    }

    _refreshToolButtons() {
        if (!this._toolButtons) return;
        for (const t of TOOLS) {
            const btn = this._toolButtons[t];
            if (!btn) continue;
            const active = (t === this.tool);
            btn.dataset.active = active ? "1" : "0";
            btn.style.background = active ? "#0a64a4" : "#222";
            btn.style.borderColor = active ? "#3aa0e0" : "#444";
            btn.style.color = active ? "#fff" : "#ddd";
        }
    }

    _refreshControls() {
        if (this._colorInput) this._colorInput.value = this.color;
        if (this._widthSlider) this._widthSlider.value = String(this.strokeWidth);
    }

    // Pull color/width from the currently-selected stroke so the toolbar and
    // GUI reflect *its* appearance. Called on selection.
    _syncToolbarToSelection() {
        const s = this.selectedStroke;
        if (!s) return;
        if (s.tool === "image") return;       // image has no color/width
        if (s.color !== undefined) this.color = s.color;
        if (s.width !== undefined) this.strokeWidth = s.width;
        this._refreshControls();
        this.gui?.controllersRecursive?.().forEach(c => c.updateDisplay?.());
    }

    // Effective editing = Edit Mode AND Show. Show is the master switch:
    // when it's off, Edit Mode is suppressed even if the flag is set.
    isEditingActive() {
        return this.editing && this.show;
    }

    _updateToolbarVisibility() {
        if (this._toolbar) {
            this._toolbar.style.display = this.isEditingActive() ? "flex" : "none";
        }
    }

    // ---------- Public API ----------

    setTool(tool) {
        if (!TOOLS.includes(tool)) return;
        this.tool = tool;
        // Clear selection when switching away from select
        if (tool !== "select") this.selectedStroke = null;
        this._refreshToolButtons();
        setRenderOne(true);
    }

    // ---------- Image handling (drop, paste, file picker) ----------

    _installDropHandlers() {
        // Drop zone is the video div. We listen so we don't fight existing
        // global drop handlers (Sitrec accepts dropped files elsewhere).
        const host = this.overlayView.div;
        const onDragOver = (e) => {
            if (!this.isEditingActive()) return;
            if (!this._eventHasImage(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
        };
        const onDrop = (e) => {
            if (!this.isEditingActive()) return;
            if (!this._eventHasImage(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const file = [...e.dataTransfer.files].find(f => f.type.startsWith("image/"));
            if (!file) return;
            this._addImageFromFile(file, e.clientX, e.clientY);
        };
        host.addEventListener("dragover", onDragOver);
        host.addEventListener("drop", onDrop);
        this._dropHandlers = {host, onDragOver, onDrop};
    }

    _eventHasImage(e) {
        if (!e.dataTransfer) return false;
        if (e.dataTransfer.items) {
            for (const it of e.dataTransfer.items) {
                if (it.kind === "file" && it.type.startsWith("image/")) return true;
            }
        }
        if (e.dataTransfer.files) {
            for (const f of e.dataTransfer.files) {
                if (f.type.startsWith("image/")) return true;
            }
        }
        return false;
    }

    _addImageFromFile(file, clientX, clientY) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataURL = ev.target.result;
            const img = new Image();
            img.onload = () => {
                IMAGE_CACHE.set(dataURL, img);
                this._dropImageAtScreen(dataURL, img.naturalWidth, img.naturalHeight, clientX, clientY);
            };
            img.onerror = () => console.warn("Annotate: failed to load dropped image");
            img.src = dataURL;
        };
        reader.readAsDataURL(file);
    }

    _dropImageAtScreen(dataURL, natW, natH, clientX, clientY) {
        if (!this._hasGeometry()) return;
        // Convert screen coords to overlay-local canvas coords, then to original-video coords.
        const rect = this.canvas.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const [vCenterX, vCenterY] = this._canvasToStore(localX, localY);

        // Default size: ~30% of the video's longest dim, preserving aspect.
        const ov = this.overlayView;
        const targetMax = Math.max(ov.originalVideoWidth, ov.originalVideoHeight) * 0.3;
        const scale = Math.min(targetMax / natW, targetMax / natH);
        const w = natW * scale;
        const h = natH * scale;

        const stroke = {
            tool: "image",
            data: dataURL,
            points: [{x: vCenterX - w/2, y: vCenterY - h/2}],
            imgWidth: w,
            imgHeight: h,
            opacity: this.opacity,
            frame: par.frame,
        };
        this._commitStroke(stroke);
        this.selectedStroke = stroke;
        this.setTool("select");
    }

    _pickImageFile(clientX, clientY) {
        // Click on image tool opens a file picker; drop centered in the video.
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("change", () => {
            const f = input.files && input.files[0];
            document.body.removeChild(input);
            if (!f) return;
            const rect = this.canvas.getBoundingClientRect();
            const cx = clientX ?? (rect.left + rect.width / 2);
            const cy = clientY ?? (rect.top + rect.height / 2);
            this._addImageFromFile(f, cx, cy);
        });
        input.click();
    }

    _getImageElement(stroke) {
        if (!stroke.data) return null;
        let img = IMAGE_CACHE.get(stroke.data);
        if (!img) {
            img = new Image();
            img.onload = () => setRenderOne(true);
            img.src = stroke.data;
            IMAGE_CACHE.set(stroke.data, img);
        }
        return img;
    }

    // ---------- Selection / move / resize ----------

    // Returns one of: "move", "resize-nw", "resize-ne", "resize-sw", "resize-se", or null
    _hitTestSelection(cx, cy) {
        if (!this.selectedStroke) return null;
        const s = this.selectedStroke;
        const handle = this._handleHitRadius();

        // Line/Arrow: only 2 handles, at the actual endpoints.
        if ((s.tool === "line" || s.tool === "arrow") && s.points.length === 2) {
            const [x0, y0] = this._storeToCanvas(s.points[0].x, s.points[0].y);
            const [x1, y1] = this._storeToCanvas(s.points[1].x, s.points[1].y);
            if (Math.hypot(cx - x0, cy - y0) <= handle) return "endpoint-0";
            if (Math.hypot(cx - x1, cy - y1) <= handle) return "endpoint-1";
            // Allow "move" by clicking on the line segment itself.
            const tol = Math.max(8, (s.width || 4) * this._videoWidthScale());
            if (segDist2(cx, cy, x0, y0, x1, y1) <= tol * tol) return "move";
            return null;
        }

        // Image / rect / ellipse / polyline: 4 bbox corner handles + interior move.
        const corners = this._selectionCornersCanvas(s);
        if (!corners) return null;
        const {nw, ne, sw, se} = corners;
        if (Math.hypot(cx - nw[0], cy - nw[1]) <= handle) return "resize-nw";
        if (Math.hypot(cx - ne[0], cy - ne[1]) <= handle) return "resize-ne";
        if (Math.hypot(cx - sw[0], cy - sw[1]) <= handle) return "resize-sw";
        if (Math.hypot(cx - se[0], cy - se[1]) <= handle) return "resize-se";
        const minX = Math.min(nw[0], se[0]), maxX = Math.max(nw[0], se[0]);
        const minY = Math.min(nw[1], se[1]), maxY = Math.max(nw[1], se[1]);
        if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) return "move";
        return null;
    }

    _handleHitRadius() { return 10; }

    // Returns {nw,ne,sw,se} in canvas coords (axis-aligned bbox in video space).
    _selectionCornersCanvas(stroke) {
        const bbox = this._strokeVideoBBox(stroke);
        if (!bbox) return null;
        const [x0, y0] = this._storeToCanvas(bbox.minX, bbox.minY);
        const [x1, y1] = this._storeToCanvas(bbox.maxX, bbox.maxY);
        return {
            nw: [x0, y0], ne: [x1, y0],
            sw: [x0, y1], se: [x1, y1],
        };
    }

    _strokeVideoBBox(s) {
        if (s.tool === "image") {
            const p = s.points[0];
            return {minX: p.x, minY: p.y, maxX: p.x + s.imgWidth, maxY: p.y + s.imgHeight};
        }
        if (s.tool === "text" && s.text) {
            // Anchor (points[0]) is the left-baseline of the rendered string.
            // Compute bbox in video-pixel space so move/resize work like other shapes.
            const p = s.points[0];
            const fontVideoPx = Math.max(2, (s.width || 3) * 6);
            // Use the overlay's ctx for measurement; fall back to char-width estimate.
            let wV;
            if (this.ctx) {
                this.ctx.save();
                this.ctx.font = `${fontVideoPx}px sans-serif`;
                wV = this.ctx.measureText(s.text).width;
                this.ctx.restore();
            } else {
                wV = s.text.length * fontVideoPx * 0.55;
            }
            const hV = fontVideoPx;
            return {minX: p.x, minY: p.y - hV, maxX: p.x + wV, maxY: p.y + hV * 0.2};
        }
        if (!s.points || s.points.length === 0) return null;
        let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of s.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return {minX, minY, maxX, maxY};
    }

    _hitTestStrokes(cx, cy) {
        // top-most wins (last drawn = topmost)
        for (let i = this.strokes.length - 1; i >= 0; i--) {
            const s = this.strokes[i];
            if (s.tool === "image") {
                const p = s.points[0];
                const [x0, y0] = this._storeToCanvas(p.x, p.y);
                const [x1, y1] = this._storeToCanvas(p.x + s.imgWidth, p.y + s.imgHeight);
                const minX = Math.min(x0,x1), maxX = Math.max(x0,x1);
                const minY = Math.min(y0,y1), maxY = Math.max(y0,y1);
                if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) return s;
            } else if ((s.tool === "rect" || s.tool === "ellipse") && s.points.length === 2) {
                // Interior click selects too (otherwise users miss thin outlines).
                const [x0, y0] = this._storeToCanvas(s.points[0].x, s.points[0].y);
                const [x1, y1] = this._storeToCanvas(s.points[1].x, s.points[1].y);
                const minX = Math.min(x0,x1), maxX = Math.max(x0,x1);
                const minY = Math.min(y0,y1), maxY = Math.max(y0,y1);
                if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) return s;
            } else if (this._strokeHitsCanvasPoint(s, cx, cy, 8)) {
                return s;
            }
        }
        return null;
    }

    clearAll() {
        if (this.strokes.length === 0) return;
        const previous = this.strokes;
        this.strokes = [];
        setRenderOne(true);
        undoManager.add({
            description: "Clear annotations",
            undo: () => { this.strokes = previous; setRenderOne(true); },
            redo: () => { this.strokes = []; setRenderOne(true); },
        });
    }

    // ---------- Coordinate helpers ----------

    _hasGeometry() {
        const ov = this.overlayView;
        return ov && ov.originalVideoWidth > 0 && ov.originalVideoHeight > 0;
    }

    // Canvas (mouse-relative) -> stored original-video pixel coords
    _canvasToStore(cx, cy) {
        return this.overlayView.canvasToVideoCoordsOriginal(cx, cy);
    }

    // Stored original-video pixel coords -> canvas (drawing) coords
    _storeToCanvas(vx, vy) {
        return this.overlayView.videoToCanvasCoordsOriginal(vx, vy);
    }

    // ---------- Mouse handling ----------

    onMouseDown(e, mouseX, mouseY) {
        if (!this.isEditingActive()) return false;
        if (!this._hasGeometry()) return false;

        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const [vx, vy] = this._canvasToStore(cx, cy);
        this.lastMouseX = mouseX;
        this.lastMouseY = mouseY;

        // --- Select tool: pick / move / resize ---
        if (this.tool === "select") {
            // First check if we hit a handle of the current selection
            const handleHit = this._hitTestSelection(cx, cy);
            if (handleHit) {
                this.dragMode = handleHit;
                this._dragStart = {cx, cy, stroke: this.selectedStroke,
                    snapshot: this._snapshotStroke(this.selectedStroke)};
                return true;
            }
            // Otherwise try to pick a new stroke
            const hit = this._hitTestStrokes(cx, cy);
            this.selectedStroke = hit;
            if (hit) {
                this.dragMode = "move";
                this._dragStart = {cx, cy, stroke: hit, snapshot: this._snapshotStroke(hit)};
                // Sync toolbar/GUI to the selected stroke's appearance.
                this._syncToolbarToSelection();
            } else {
                this.dragMode = null;
                this._dragStart = null;
            }
            setRenderOne(true);
            return true;
        }

        if (this.tool === "image") {
            // Click on the image tool opens a file picker (drop is also handled)
            this._pickImageFile(e.clientX, e.clientY);
            return true;
        }

        if (this.tool === "eraser") {
            this._eraseAt(cx, cy);
            return true;
        }

        if (this.tool === "text") {
            const text = window.prompt("Annotation text:", "");
            if (text && text.trim().length > 0) {
                const stroke = {
                    tool: "text",
                    color: this.color,
                    width: this.strokeWidth,
                    opacity: this.opacity,
                    text: text,
                    points: [{x: vx, y: vy}],
                    frame: par.frame,
                };
                this._commitStroke(stroke);
            }
            return true;
        }

        // Start a new freehand or shape stroke
        this.activeStroke = {
            tool: this.tool,
            color: this.color,
            width: this.strokeWidth,
            opacity: this.opacity,
            points: [{x: vx, y: vy}],
            frame: par.frame,
        };
        setRenderOne(true);
        return true;
    }

    onMouseDrag(e, mouseX, mouseY) {
        if (!this.isEditingActive()) return;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const [vx, vy] = this._canvasToStore(cx, cy);

        // Select-tool drag → move or resize
        if (this.tool === "select" && this.dragMode && this._dragStart) {
            this._applySelectDrag(cx, cy, e.shiftKey);
            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;
            setRenderOne(true);
            return;
        }

        if (this.tool === "eraser") {
            this._eraseAt(cx, cy);
            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;
            return;
        }

        if (!this.activeStroke) return;

        const t = this.activeStroke.tool;
        if (t === "pencil" || t === "brush") {
            const last = this.activeStroke.points[this.activeStroke.points.length - 1];
            const dx = vx - last.x, dy = vy - last.y;
            // Skip subpixel jitter to keep stroke array tidy
            if (dx*dx + dy*dy > 0.25) {
                this.activeStroke.points.push({x: vx, y: vy});
            }
        } else {
            // line/arrow/rect/ellipse: always exactly 2 points (start, current)
            this.activeStroke.points[1] = {x: vx, y: vy};
        }
        this.lastMouseX = mouseX;
        this.lastMouseY = mouseY;
        setRenderOne(true);
    }

    onMouseUp(e, mouseX, mouseY) {
        if (!this.isEditingActive()) return;

        // Finalize a select-tool drag
        if (this.tool === "select" && this.dragMode && this._dragStart) {
            const ds = this._dragStart;
            const before = ds.snapshot;
            const after = this._snapshotStroke(ds.stroke);
            const stroke = ds.stroke;
            // Only push undo if something actually changed
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                undoManager.add({
                    description: this.dragMode === "move" ? "Move annotation" : "Resize annotation",
                    undo: () => { this._restoreStroke(stroke, before); setRenderOne(true); },
                    redo: () => { this._restoreStroke(stroke, after);  setRenderOne(true); },
                });
            }
            this.dragMode = null;
            this._dragStart = null;
            return;
        }

        if (!this.activeStroke) return;

        const t = this.activeStroke.tool;
        if (t === "pencil" || t === "brush") {
            // discard zero-length strokes (just a click without drag)
            if (this.activeStroke.points.length < 2) {
                this.activeStroke = null;
                setRenderOne(true);
                return;
            }
        } else {
            // shapes need 2 distinct points
            if (this.activeStroke.points.length < 2) {
                this.activeStroke = null;
                setRenderOne(true);
                return;
            }
            const a = this.activeStroke.points[0], b = this.activeStroke.points[1];
            if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1) {
                this.activeStroke = null;
                setRenderOne(true);
                return;
            }
        }

        const stroke = this.activeStroke;
        this.activeStroke = null;
        this._commitStroke(stroke);
    }

    onMouseMove(e, mouseX, mouseY) {
        if (!this.isEditingActive()) return;
        this.lastMouseX = mouseX;
        this.lastMouseY = mouseY;
    }

    _commitStroke(stroke) {
        this.strokes.push(stroke);
        setRenderOne(true);
        undoManager.add({
            description: "Add annotation",
            undo: () => {
                const idx = this.strokes.indexOf(stroke);
                if (idx >= 0) this.strokes.splice(idx, 1);
                setRenderOne(true);
            },
            redo: () => {
                this.strokes.push(stroke);
                setRenderOne(true);
            },
        });
    }

    _eraseAt(cx, cy) {
        // Erase any stroke whose drawn footprint passes within (this.strokeWidth) canvas pixels
        // of (cx,cy). Convert tolerance into video pixels for a consistent feel.
        if (!this.strokes.length) return;
        const [cx2, cy2] = [cx, cy];
        const tolCanvas = Math.max(6, this.strokeWidth);
        const removed = [];
        const kept = [];
        for (const s of this.strokes) {
            if (this._strokeHitsCanvasPoint(s, cx2, cy2, tolCanvas)) {
                removed.push(s);
            } else {
                kept.push(s);
            }
        }
        if (removed.length > 0) {
            this.strokes = kept;
            setRenderOne(true);
            const self = this;
            undoManager.add({
                description: "Erase annotations",
                undo: () => { self.strokes = self.strokes.concat(removed); setRenderOne(true); },
                redo: () => {
                    self.strokes = self.strokes.filter(s => !removed.includes(s));
                    setRenderOne(true);
                },
            });
        }
    }

    _strokeHitsCanvasPoint(stroke, cx, cy, tol) {
        const pts = stroke.points;
        if (!pts || pts.length === 0) return false;
        const tol2 = tol * tol;

        // Text: hit-test against a small box around the anchor
        if (stroke.tool === "text") {
            const [px, py] = this._storeToCanvas(pts[0].x, pts[0].y);
            const dx = cx - px, dy = cy - py;
            return dx*dx + dy*dy < (tol + 20) * (tol + 20);
        }

        // Shapes with 2 points: rect/ellipse — hit-test the outline
        if (stroke.tool === "rect" && pts.length === 2) {
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            const [x1, y1] = this._storeToCanvas(pts[1].x, pts[1].y);
            const xMin = Math.min(x0,x1), xMax = Math.max(x0,x1);
            const yMin = Math.min(y0,y1), yMax = Math.max(y0,y1);
            const onTop    = cx >= xMin - tol && cx <= xMax + tol && Math.abs(cy - yMin) < tol;
            const onBot    = cx >= xMin - tol && cx <= xMax + tol && Math.abs(cy - yMax) < tol;
            const onLeft   = cy >= yMin - tol && cy <= yMax + tol && Math.abs(cx - xMin) < tol;
            const onRight  = cy >= yMin - tol && cy <= yMax + tol && Math.abs(cx - xMax) < tol;
            return onTop || onBot || onLeft || onRight;
        }
        if (stroke.tool === "ellipse" && pts.length === 2) {
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            const [x1, y1] = this._storeToCanvas(pts[1].x, pts[1].y);
            const cxE = (x0 + x1) / 2, cyE = (y0 + y1) / 2;
            const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
            if (rx < 0.5 || ry < 0.5) return false;
            const nx = (cx - cxE) / rx, ny = (cy - cyE) / ry;
            const d = Math.sqrt(nx*nx + ny*ny);
            // outline within tol relative to radii — approximate
            return Math.abs(d - 1) < (tol / Math.min(rx, ry));
        }

        // Polylines (pencil/brush) and 2-point lines/arrows: distance to segments
        let prev = this._storeToCanvas(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            const cur = this._storeToCanvas(pts[i].x, pts[i].y);
            if (segDist2(cx, cy, prev[0], prev[1], cur[0], cur[1]) < tol2) return true;
            prev = cur;
        }
        return false;
    }

    // ---------- Export helpers ----------

    // Render strokes onto an arbitrary target canvas. The target represents
    // the same source-rect-of-the-original-video that the video exporter just
    // drew into it (via drawAdjustedSourceFrame), so we honor any zoom/pan
    // crop so annotations stay locked to the imagery.
    // Selection handles are intentionally NOT drawn — exports show the final
    // composition, not the editor UI.
    renderToVideoCanvas(targetCanvas, frame) {
        if (!this.show) return;
        if (!targetCanvas) return;
        const ov = this.overlayView;
        if (!ov || !ov.originalVideoWidth) return;

        const ctx = targetCanvas.getContext("2d");
        if (!ctx) return;

        // Mirror drawAdjustedSourceFrame's source-rect computation so the
        // strokes map onto the correct subregion of the exported frame.
        let srcX = 0, srcY = 0;
        let srcW = ov.originalVideoWidth, srcH = ov.originalVideoHeight;
        if (ov.in?.zoom !== undefined && ov.in.zoom.v0 > 100) {
            const zoom = ov.in.zoom.v0 / 100;
            srcW = ov.originalVideoWidth / zoom;
            srcH = ov.originalVideoHeight / zoom;
            srcX = (ov.originalVideoWidth - srcW) / 2 + (ov.panOffsetX || 0) * ov.originalVideoWidth;
            srcY = (ov.originalVideoHeight - srcH) / 2 + (ov.panOffsetY || 0) * ov.originalVideoHeight;
            srcX = Math.max(0, Math.min(ov.originalVideoWidth - srcW, srcX));
            srcY = Math.max(0, Math.min(ov.originalVideoHeight - srcH, srcY));
        }
        const dstW = targetCanvas.width;
        const dstH = targetCanvas.height;
        const sx = dstW / srcW;
        const sy = dstH / srcH;
        // Use the average scale for line widths; videos are normally square-pixel.
        const lwScale = (sx + sy) / 2;

        const origStoreToCanvas = this._storeToCanvas;
        const origVideoWidthScale = this._videoWidthScale;
        const origCtx = this.ctx;
        this._storeToCanvas = (vx, vy) => [(vx - srcX) * sx, (vy - srcY) * sy];
        this._videoWidthScale = () => lwScale;
        this.ctx = ctx;

        try {
            for (const stroke of this.strokes) {
                const a = this._strokeAlphaForFrame(stroke, frame);
                if (a <= 0) continue;
                this._drawStroke(stroke, a);
            }
            if (this.activeStroke) {
                this._drawStroke(this.activeStroke, this.activeStroke.opacity ?? 1);
            }
        } finally {
            this._storeToCanvas = origStoreToCanvas;
            this._videoWidthScale = origVideoWidthScale;
            this.ctx = origCtx;
        }
    }

    // Composite the overlay's screen-space rendered canvas onto a target
    // canvas at the same resolution as the live view canvas. Used by the
    // single-frame export when we want exactly what's on-screen.
    compositeOnto(targetCtx, dx = 0, dy = 0, dWidth, dHeight) {
        if (!this.show) return;
        if (!this.canvas) return;
        const w = dWidth ?? this.widthPx;
        const h = dHeight ?? this.heightPx;
        targetCtx.drawImage(this.canvas, dx, dy, w, h);
    }

    // ---------- Rendering ----------

    renderCanvas(frame) {
        // Always let the base allocate/scale the canvas, then bail out if disabled
        // (so toggling visibility doesn't leave a stale frame behind).
        super.renderCanvas(frame);

        if (!this.ctx) return;

        // Show is the master switch. Off => truly nop (no strokes, no selection
        // overlay, no geometry compute). Edit Mode without Show is also nop.
        if (!this.show) return;
        if (!this._hasGeometry()) return;

        // Draw stored strokes
        for (const stroke of this.strokes) {
            const a = this._strokeAlphaForFrame(stroke, frame);
            if (a <= 0) continue;
            this._drawStroke(stroke, a);
        }

        // Draw the in-progress stroke (always at full opacity)
        if (this.activeStroke) {
            this._drawStroke(this.activeStroke, this.activeStroke.opacity ?? 1);
        }

        // Selection overlay (handles, dashed bbox)
        if (this.isEditingActive() && this.tool === "select" && this.selectedStroke
            && this.strokes.indexOf(this.selectedStroke) >= 0) {
            this._drawSelection(this.selectedStroke);
        }
    }

    _strokeAlphaForFrame(stroke, frame) {
        // Persistent mode (fadeFrames === 0): strokes are visible at EVERY frame
        // regardless of when they were drawn. This is the default and what most
        // users expect — annotations should appear across the whole video, not
        // only from the frame they happened to be drawn on.
        const base = (stroke.opacity ?? 1) * (this.opacity ?? 1);
        if (!this.fadeFrames || this.fadeFrames <= 0) return base;
        // Fade mode: stroke appears at its creation frame, then fades out over
        // fadeFrames frames. Earlier frames don't show it. This makes sense for
        // animation-style annotations driven by playback.
        const start = stroke.frame ?? 0;
        if (frame < start) return 0;
        const age = frame - start;
        if (age >= this.fadeFrames) return 0;
        const t = age / this.fadeFrames;
        // ease-out so it's visible for most of its life then fades quickly
        return base * (1 - t * t);
    }

    _drawStroke(stroke, alpha) {
        const ctx = this.ctx;
        const pts = stroke.points;
        if (!pts || pts.length === 0) return;

        // Scale the stored video-pixel width to canvas pixels so strokes look consistent
        const widthScale = this._videoWidthScale();
        const lw = Math.max(0.5, stroke.width * widthScale);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = stroke.color;
        ctx.fillStyle = stroke.color;
        ctx.lineWidth = lw;
        ctx.lineCap = (stroke.tool === "brush") ? "round" : "round";
        ctx.lineJoin = "round";

        const tool = stroke.tool;
        if (tool === "pencil" || tool === "brush") {
            // brush ~ 2.2x thicker for a felt-tip feel
            if (tool === "brush") ctx.lineWidth = lw * 2.2;
            ctx.beginPath();
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            ctx.moveTo(x0, y0);
            for (let i = 1; i < pts.length; i++) {
                const [x, y] = this._storeToCanvas(pts[i].x, pts[i].y);
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        } else if (tool === "line" && pts.length >= 2) {
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            const [x1, y1] = this._storeToCanvas(pts[1].x, pts[1].y);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        } else if (tool === "arrow" && pts.length >= 2) {
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            const [x1, y1] = this._storeToCanvas(pts[1].x, pts[1].y);

            // Arrowhead geometry. Tip is AT (x1,y1). Base sits `head` back along
            // the line. Make it scale generously with line width so it stays
            // visible on thick lines.
            const dx = x1 - x0, dy = y1 - y0;
            const len = Math.hypot(dx, dy) || 1;
            const ang = Math.atan2(dy, dx);
            const head = Math.max(14, lw * 6);              // bigger
            const sweep = Math.PI / 7;
            // Where the two base corners are:
            const baseLx = x1 - head * Math.cos(ang - sweep);
            const baseLy = y1 - head * Math.sin(ang - sweep);
            const baseRx = x1 - head * Math.cos(ang + sweep);
            const baseRy = y1 - head * Math.sin(ang + sweep);
            // Center of the base (where the shaft should meet the triangle).
            const baseCx = (baseLx + baseRx) / 2;
            const baseCy = (baseLy + baseRy) / 2;
            // Stop the shaft at the base center so a thick rounded cap doesn't
            // poke through the triangle.
            let shaftX = baseCx, shaftY = baseCy;
            // Shaft must not invert if the user drew a stub shorter than the head.
            const headDepth = Math.hypot(x1 - baseCx, y1 - baseCy);
            if (headDepth >= len) {
                shaftX = x0; shaftY = y0;
            }
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(shaftX, shaftY);
            ctx.stroke();

            // Filled triangle head with tip exactly at (x1,y1).
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(baseLx, baseLy);
            ctx.lineTo(baseRx, baseRy);
            ctx.closePath();
            ctx.fill();
        } else if (tool === "rect" && pts.length >= 2) {
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            const [x1, y1] = this._storeToCanvas(pts[1].x, pts[1].y);
            ctx.strokeRect(Math.min(x0,x1), Math.min(y0,y1),
                           Math.abs(x1 - x0), Math.abs(y1 - y0));
        } else if (tool === "ellipse" && pts.length >= 2) {
            const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
            const [x1, y1] = this._storeToCanvas(pts[1].x, pts[1].y);
            ctx.beginPath();
            ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2,
                        Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2,
                        0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (tool === "text" && stroke.text) {
            const [x, y] = this._storeToCanvas(pts[0].x, pts[0].y);
            const fontPx = Math.max(8, lw * 6);
            ctx.font = `${fontPx}px sans-serif`;
            ctx.textBaseline = "alphabetic";
            // outline for legibility on bright backgrounds
            ctx.lineWidth = Math.max(2, fontPx / 8);
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.strokeText(stroke.text, x, y);
            ctx.fillStyle = stroke.color;
            ctx.fillText(stroke.text, x, y);
        } else if (tool === "image") {
            const img = this._getImageElement(stroke);
            if (img && img.complete && img.naturalWidth > 0) {
                const [x0, y0] = this._storeToCanvas(pts[0].x, pts[0].y);
                const [x1, y1] = this._storeToCanvas(pts[0].x + stroke.imgWidth, pts[0].y + stroke.imgHeight);
                const w = x1 - x0, h = y1 - y0;
                ctx.drawImage(img, x0, y0, w, h);
            }
        }

        ctx.restore();
    }

    _drawSelection(stroke) {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 1;

        // Line/Arrow: show two endpoint handles only.
        if ((stroke.tool === "line" || stroke.tool === "arrow") && stroke.points.length === 2) {
            const [x0, y0] = this._storeToCanvas(stroke.points[0].x, stroke.points[0].y);
            const [x1, y1] = this._storeToCanvas(stroke.points[1].x, stroke.points[1].y);
            const r = 6;
            for (const [x, y] of [[x0, y0], [x1, y1]]) {
                ctx.fillStyle = "#3aa0e0";
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
            return;
        }

        // Everything else: dashed bbox + 4 corner handles.
        const corners = this._selectionCornersCanvas(stroke);
        if (!corners) { ctx.restore(); return; }
        const {nw, ne, sw, se} = corners;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#3aa0e0";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(nw[0], nw[1]);
        ctx.lineTo(ne[0], ne[1]);
        ctx.lineTo(se[0], se[1]);
        ctx.lineTo(sw[0], sw[1]);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        const r = 5;
        for (const c of [nw, ne, sw, se]) {
            ctx.fillStyle = "#3aa0e0";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.rect(c[0] - r, c[1] - r, r*2, r*2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }

    // ---------- Select drag helpers ----------

    _snapshotStroke(s) {
        if (!s) return null;
        return JSON.parse(JSON.stringify({
            points: s.points,
            imgWidth: s.imgWidth,
            imgHeight: s.imgHeight,
        }));
    }

    _restoreStroke(s, snap) {
        if (!s || !snap) return;
        s.points = JSON.parse(JSON.stringify(snap.points));
        if (snap.imgWidth !== undefined) s.imgWidth = snap.imgWidth;
        if (snap.imgHeight !== undefined) s.imgHeight = snap.imgHeight;
    }

    _applySelectDrag(cx, cy, shift) {
        const ds = this._dragStart;
        const s = ds.stroke;
        const dxCanvas = cx - ds.cx;
        const dyCanvas = cy - ds.cy;
        // Convert canvas delta into stored-video delta (handles zoom/pan correctly).
        const [vx0, vy0] = this._canvasToStore(ds.cx, ds.cy);
        const [vx1, vy1] = this._canvasToStore(cx, cy);
        const dvx = vx1 - vx0;
        const dvy = vy1 - vy0;

        if (this.dragMode === "move") {
            // Move every point by the same delta.
            const snap = ds.snapshot.points;
            for (let i = 0; i < snap.length; i++) {
                s.points[i] = {x: snap[i].x + dvx, y: snap[i].y + dvy};
            }
            return;
        }

        // Resize: only images & 2-point shapes are resizable in v1.
        if (s.tool === "image") {
            const orig = ds.snapshot;
            const op = orig.points[0];
            const ow = orig.imgWidth, oh = orig.imgHeight;
            const aspect = ow / oh;
            // Compute the anchor (opposite corner) and the dragged corner.
            let anchorX, anchorY, newX, newY;
            switch (this.dragMode) {
                case "resize-nw":
                    anchorX = op.x + ow; anchorY = op.y + oh;
                    newX = anchorX - (anchorX - (op.x + dvx)); newY = anchorY - (anchorY - (op.y + dvy));
                    break;
                case "resize-ne":
                    anchorX = op.x;       anchorY = op.y + oh;
                    newX = op.x + ow + dvx; newY = op.y + dvy;
                    break;
                case "resize-sw":
                    anchorX = op.x + ow;  anchorY = op.y;
                    newX = op.x + dvx;    newY = op.y + oh + dvy;
                    break;
                case "resize-se":
                    anchorX = op.x;       anchorY = op.y;
                    newX = op.x + ow + dvx; newY = op.y + oh + dvy;
                    break;
            }
            // Compute new size based on dragged corner relative to anchor.
            let newW = Math.abs(newX - anchorX);
            let newH = Math.abs(newY - anchorY);
            // Preserve aspect unless shift held.
            if (!shift) {
                if (newW / newH > aspect) newW = newH * aspect; else newH = newW / aspect;
            }
            if (newW < 4) newW = 4;
            if (newH < 4) newH = 4;
            // Top-left corner of new rect = min of anchor & opposite based on which corner we dragged.
            const x = (this.dragMode === "resize-nw" || this.dragMode === "resize-sw") ? anchorX - newW : anchorX;
            const y = (this.dragMode === "resize-nw" || this.dragMode === "resize-ne") ? anchorY - newH : anchorY;
            s.points[0] = {x, y};
            s.imgWidth = newW;
            s.imgHeight = newH;
            return;
        }

        // Rect / Ellipse: 2 stored points are diagonal corners of the bbox.
        // All four handles should freely reshape the box. We rebuild the bbox by
        // moving the dragged corner; the opposite corner (anchor) stays fixed.
        if ((s.tool === "rect" || s.tool === "ellipse") && s.points.length === 2) {
            const op = ds.snapshot.points;
            const minX = Math.min(op[0].x, op[1].x), maxX = Math.max(op[0].x, op[1].x);
            const minY = Math.min(op[0].y, op[1].y), maxY = Math.max(op[0].y, op[1].y);
            // Build all four corners, then move the dragged one.
            let nw = {x: minX, y: minY};
            let ne = {x: maxX, y: minY};
            let sw = {x: minX, y: maxY};
            let se = {x: maxX, y: maxY};
            switch (this.dragMode) {
                case "resize-nw": nw = {x: nw.x + dvx, y: nw.y + dvy}; break;
                case "resize-ne": ne = {x: ne.x + dvx, y: ne.y + dvy}; break;
                case "resize-sw": sw = {x: sw.x + dvx, y: sw.y + dvy}; break;
                case "resize-se": se = {x: se.x + dvx, y: se.y + dvy}; break;
            }
            // Anchor (opposite) corner stays fixed; the dragged corner sets the
            // bbox's other extreme. Always rebuild from anchor + dragged.
            let anchor, dragged;
            switch (this.dragMode) {
                case "resize-nw": anchor = se; dragged = nw; break;
                case "resize-ne": anchor = sw; dragged = ne; break;
                case "resize-sw": anchor = ne; dragged = sw; break;
                case "resize-se": anchor = nw; dragged = se; break;
            }
            s.points[0] = {x: Math.min(anchor.x, dragged.x), y: Math.min(anchor.y, dragged.y)};
            s.points[1] = {x: Math.max(anchor.x, dragged.x), y: Math.max(anchor.y, dragged.y)};
            return;
        }

        // Line / Arrow: the 2 stored points are the actual endpoints. Handles
        // are rendered at the endpoints (not bbox corners). `dragMode` here
        // encodes the endpoint index: "endpoint-0" or "endpoint-1".
        if ((s.tool === "line" || s.tool === "arrow") && s.points.length === 2) {
            const m = this.dragMode;
            const idx = m === "endpoint-0" ? 0 : (m === "endpoint-1" ? 1 : -1);
            if (idx < 0) return;
            const op = ds.snapshot.points;
            s.points[idx] = {x: op[idx].x + dvx, y: op[idx].y + dvy};
            return;
        }

        // Text: corner drags translate (font size is changed via the width
        // slider — scaling a single-point anchor doesn't make geometric sense).
        if (s.tool === "text") {
            const snap = ds.snapshot.points;
            for (let i = 0; i < snap.length; i++) {
                s.points[i] = {x: snap[i].x + dvx, y: snap[i].y + dvy};
            }
            return;
        }

        // Polyline (pencil / brush): the 4 corner handles SCALE all
        // points around the opposite (anchor) corner of the original bbox.
        // Without this, corner drags would just move the stroke and users
        // would never have a way to resize it.
        if (s.points.length >= 1) {
            const op = ds.snapshot.points;
            let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of op) {
                if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
            }
            const w = Math.max(1e-6, maxX - minX);
            const h = Math.max(1e-6, maxY - minY);
            // Anchor (opposite corner that stays fixed) + dragged corner's new pos.
            let ax, ay, dx0, dy0;
            switch (this.dragMode) {
                case "resize-nw": ax = maxX; ay = maxY; dx0 = minX + dvx; dy0 = minY + dvy; break;
                case "resize-ne": ax = minX; ay = maxY; dx0 = maxX + dvx; dy0 = minY + dvy; break;
                case "resize-sw": ax = maxX; ay = minY; dx0 = minX + dvx; dy0 = maxY + dvy; break;
                case "resize-se": ax = minX; ay = minY; dx0 = maxX + dvx; dy0 = maxY + dvy; break;
                default: return; // unknown mode — leave alone
            }
            let sxn = (dx0 - ax) / (this.dragMode.endsWith("nw") || this.dragMode.endsWith("sw") ? (minX - ax) : (maxX - ax));
            let syn = (dy0 - ay) / (this.dragMode.endsWith("nw") || this.dragMode.endsWith("ne") ? (minY - ay) : (maxY - ay));
            // Prevent flips (negative scale) and total collapse — clamp to a
            // small positive floor so the user can still recover.
            if (!isFinite(sxn) || sxn < 0.02) sxn = 0.02;
            if (!isFinite(syn) || syn < 0.02) syn = 0.02;
            for (let i = 0; i < op.length; i++) {
                s.points[i] = {
                    x: ax + (op[i].x - ax) * sxn,
                    y: ay + (op[i].y - ay) * syn,
                };
            }
            return;
        }
    }

    // How much canvas-pixels per video-pixel (from current display geometry).
    _videoWidthScale() {
        const ov = this.overlayView;
        ov.getSourceAndDestCoords();
        const vw = ov.originalVideoWidth || ov.videoWidth || 1;
        // dWidth is canvas pixels covering sWidth video pixels. Scale by orig->display ratio.
        const dispToOrig = (ov.videoWidth || vw) / vw;
        const canvasPerDisplay = ov.dWidth / Math.max(1, ov.sWidth);
        return canvasPerDisplay * dispToOrig;
    }

    // ---------- Keyboard shortcuts ----------

    _installKeyHandler() {
        if (CNodeAnnotateOverlay._keyHandlerInstalled) return;
        CNodeAnnotateOverlay._keyHandlerInstalled = true;
        window.addEventListener("keydown", (e) => {
            // Ignore when typing in inputs
            const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
            if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;

            // Find any annotate overlay that's currently in edit mode
            let target = null;
            NodeMan.iterate((id, n) => {
                if (n instanceof CNodeAnnotateOverlay && n.editing) target = n;
            });
            if (!target) return;

            if (e.code in TOOL_HOTKEYS && !e.ctrlKey && !e.metaKey && !e.altKey) {
                target.setTool(TOOL_HOTKEYS[e.code]);
                e.preventDefault();
                return;
            }
            // Delete / Backspace removes the selected stroke
            if ((e.code === "Delete" || e.code === "Backspace")
                && target.tool === "select" && target.selectedStroke) {
                const stroke = target.selectedStroke;
                const idx = target.strokes.indexOf(stroke);
                if (idx >= 0) {
                    target.strokes.splice(idx, 1);
                    target.selectedStroke = null;
                    setRenderOne(true);
                    undoManager.add({
                        description: "Delete annotation",
                        undo: () => { target.strokes.splice(idx, 0, stroke); setRenderOne(true); },
                        redo: () => {
                            const i = target.strokes.indexOf(stroke);
                            if (i >= 0) target.strokes.splice(i, 1);
                            setRenderOne(true);
                        },
                    });
                }
                e.preventDefault();
                return;
            }
            // Escape clears selection
            if (e.code === "Escape" && target.selectedStroke) {
                target.selectedStroke = null;
                setRenderOne(true);
                e.preventDefault();
            }
        });
    }

    dispose() {
        if (this._toolbar && this._toolbar.parentNode) {
            this._toolbar.parentNode.removeChild(this._toolbar);
        }
        if (this._dropHandlers) {
            const {host, onDragOver, onDrop} = this._dropHandlers;
            host.removeEventListener("dragover", onDragOver);
            host.removeEventListener("drop", onDrop);
            this._dropHandlers = null;
        }
        this._toolbar = null;
        this._toolButtons = null;
        if (this.gui) {
            this.gui.destroy?.();
            this.gui = null;
        }
        super.dispose();
    }
}

// Squared distance from point (px,py) to segment (ax,ay)-(bx,by)
function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx*dx + dy*dy;
    if (len2 === 0) {
        const ex = px - ax, ey = py - ay;
        return ex*ex + ey*ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    return ex*ex + ey*ey;
}
