import {guiMenus, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {getTesseract, loadTesseract} from "./tesseractLoader";
import {isLocal} from "./configUtils";

let textExtractor = null;
let textExtractionFolder = null;

class TextRegion {
    constructor(x1, y1, x2, y2) {
        this.x1 = Math.min(x1, x2);
        this.y1 = Math.min(y1, y2);
        this.x2 = Math.max(x1, x2);
        this.y2 = Math.max(y1, y2);
        this.extractedText = new Map();
        this.displaySide = 'auto';
        this.numChars = 10;
    }

    get width() { return this.x2 - this.x1; }
    get height() { return this.y2 - this.y1; }
    get centerX() { return (this.x1 + this.x2) / 2; }
    get centerY() { return (this.y1 + this.y2) / 2; }

    contains(x, y) {
        return x >= this.x1 && x <= this.x2 && y >= this.y1 && y <= this.y2;
    }

    getTextForFrame(frame) {
        return this.extractedText.get(Math.floor(frame)) || '';
    }

    setTextForFrame(frame, text) {
        this.extractedText.set(Math.floor(frame), text);
    }
}

let renderHooked = false;

class TextExtractor {
    constructor(videoView) {
        this.videoView = videoView;
        this.enabled = false;
        this.regions = [];
        this.selectedRegion = null;
        this.overlayCreated = false;
        this.overlay = null;
        this.overlayCtx = null;

        this.isDefiningRegion = false;
        this.newRegionStart = null;
        this.newRegionEnd = null;

        this.isDragging = false;
        this.dragRegion = null;
        this.dragCorner = null;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.extracting = false;
        this.guiFolder = null;

        this.fixedWidthFont = false;

        this.templates = new Map();
        this.isLearning = false;
        this.useTemplates = true;
    }

    createOverlay() {
        if (this.overlayCreated) return;
        this.overlayCreated = true;

        this.overlay = document.createElement('canvas');
        this.overlay.style.position = 'absolute';
        this.overlay.style.top = '0';
        this.overlay.style.left = '0';
        this.overlay.style.width = '100%';
        this.overlay.style.height = '100%';
        this.overlay.style.pointerEvents = 'none';
        this.overlay.style.zIndex = '101';
        this.videoView.div.appendChild(this.overlay);
        this.overlayCtx = this.overlay.getContext('2d');

        this.hookMouseHandler();
    }

    hookMouseHandler() {
        const mouse = this.videoView.mouse;
        if (!mouse) return;

        const originalDown = mouse.handlers.down;
        const originalDrag = mouse.handlers.drag;
        const originalUp = mouse.handlers.up;

        mouse.handlers.down = (e) => {
            if (this.enabled && this.isLearning && this.selectedRegion) {
                const [vX, vY] = this.videoView.canvasToVideoCoords(mouse.x, mouse.y);
                const charIndex = this.getCharIndexAtPosition(vX, vY, this.selectedRegion);
                if (charIndex >= 0) {
                    this.promptLearnCharacter(charIndex);
                    return;
                }
            }
            if (this.enabled && this.isDefiningRegion) {
                const [vX, vY] = this.videoView.canvasToVideoCoords(mouse.x, mouse.y);
                this.newRegionStart = {x: vX, y: vY};
                this.newRegionEnd = {x: vX, y: vY};
                return;
            }
            if (this.enabled && !this.isDefiningRegion) {
                const [vX, vY] = this.videoView.canvasToVideoCoords(mouse.x, mouse.y);
                const hit = this.findRegionCorner(vX, vY);
                if (hit) {
                    this.isDragging = true;
                    this.dragRegion = hit.region;
                    this.dragCorner = hit.corner;
                    this.lastMouseX = vX;
                    this.lastMouseY = vY;
                    return;
                }
            }
            if (originalDown) originalDown(e);
        };

        mouse.handlers.drag = (e) => {
            if (this.enabled && this.isDefiningRegion && this.newRegionStart) {
                const [vX, vY] = this.videoView.canvasToVideoCoords(mouse.x, mouse.y);
                this.newRegionEnd = {x: vX, y: vY};
                setRenderOne(true);
                return;
            }
            if (this.enabled && this.isDragging && this.dragRegion) {
                const [vX, vY] = this.videoView.canvasToVideoCoords(mouse.x, mouse.y);
                const dx = vX - this.lastMouseX;
                const dy = vY - this.lastMouseY;
                this.lastMouseX = vX;
                this.lastMouseY = vY;

                if (this.dragCorner === 'move') {
                    this.dragRegion.x1 += dx;
                    this.dragRegion.y1 += dy;
                    this.dragRegion.x2 += dx;
                    this.dragRegion.y2 += dy;
                } else {
                    if (this.dragCorner.includes('1')) {
                        if (this.dragCorner.includes('x')) this.dragRegion.x1 += dx;
                        if (this.dragCorner.includes('y')) this.dragRegion.y1 += dy;
                    }
                    if (this.dragCorner.includes('2')) {
                        if (this.dragCorner.includes('x')) this.dragRegion.x2 += dx;
                        if (this.dragCorner.includes('y')) this.dragRegion.y2 += dy;
                    }
                }
                setRenderOne(true);
                return;
            }
            if (originalDrag) originalDrag(e);
        };

        mouse.handlers.up = (e) => {
            if (this.enabled && this.isDefiningRegion && this.newRegionStart && this.newRegionEnd) {
                const minWidth = 10;
                const minHeight = 10;
                const w = Math.abs(this.newRegionEnd.x - this.newRegionStart.x);
                const h = Math.abs(this.newRegionEnd.y - this.newRegionStart.y);
                if (w >= minWidth && h >= minHeight) {
                    const region = new TextRegion(
                        this.newRegionStart.x, this.newRegionStart.y,
                        this.newRegionEnd.x, this.newRegionEnd.y
                    );
                    this.regions.push(region);
                    this.selectedRegion = region;
                }
                this.newRegionStart = null;
                this.newRegionEnd = null;
                this.isDefiningRegion = false;
                if (addRegionMenuItem) addRegionMenuItem.name("Add Region");
                setRenderOne(true);
                return;
            }
            if (this.isDragging) {
                this.isDragging = false;
                this.dragRegion = null;
                this.dragCorner = null;
            }
            if (originalUp) originalUp(e);
        };
    }

    findRegionCorner(vX, vY) {
        const hitRadius = 15;
        for (const region of this.regions) {
            const corners = [
                {corner: 'x1y1', x: region.x1, y: region.y1},
                {corner: 'x2y1', x: region.x2, y: region.y1},
                {corner: 'x1y2', x: region.x1, y: region.y2},
                {corner: 'x2y2', x: region.x2, y: region.y2},
            ];
            for (const c of corners) {
                const dx = vX - c.x;
                const dy = vY - c.y;
                if (dx * dx + dy * dy < hitRadius * hitRadius) {
                    return {region, corner: c.corner};
                }
            }
            if (region.contains(vX, vY)) {
                return {region, corner: 'move'};
            }
        }
        return null;
    }

    showOverlay() {
        if (this.overlay) this.overlay.style.display = 'block';
    }

    hideOverlay() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
            if (this.overlayCtx) {
                this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
            }
        }
    }

    enable() {
        this.enabled = true;
        this.createOverlay();
        this.showOverlay();
        setRenderOne(true);
    }

    disable() {
        this.enabled = false;
        this.hideOverlay();
    }

    startAddRegion() {
        if (!this.enabled) return;
        this.isDefiningRegion = true;
        if (addRegionMenuItem) addRegionMenuItem.name("Click and drag on video...");
    }

    removeSelectedRegion() {
        if (this.selectedRegion) {
            const idx = this.regions.indexOf(this.selectedRegion);
            if (idx >= 0) this.regions.splice(idx, 1);
            this.selectedRegion = this.regions.length > 0 ? this.regions[this.regions.length - 1] : null;
            setRenderOne(true);
        }
    }

    clearAllRegions() {
        this.regions = [];
        this.selectedRegion = null;
        setRenderOne(true);
    }

    getCharIndexAtPosition(vX, vY, region) {
        if (!region.contains(vX, vY)) return -1;
        const charWidth = region.width / region.numChars;
        const relX = vX - region.x1;
        return Math.floor(relX / charWidth);
    }

    startLearning() {
        if (!this.enabled || !this.selectedRegion) return;
        this.isLearning = true;
        if (learnMenuItem) learnMenuItem.name("Click characters to learn...");
        setRenderOne(true);
    }

    stopLearning() {
        this.isLearning = false;
        if (learnMenuItem) learnMenuItem.name("Learn Templates");
        setRenderOne(true);
    }

    promptLearnCharacter(charIndex) {
        const char = prompt(`Enter character for cell ${charIndex + 1}:`);
        if (char && char.length === 1) {
            this.learnCharacter(charIndex, char);
        }
    }

    learnCharacter(charIndex, char) {
        const region = this.selectedRegion;
        if (!region) return;

        const videoData = this.videoView?.videoData;
        if (!videoData) return;

        const frame = Math.floor(par.frame);
        const image = videoData.getImage(frame);
        if (!image || !image.width) return;

        const charWidth = region.width / region.numChars;
        const x1 = Math.floor(region.x1 + charIndex * charWidth);
        const y1 = Math.floor(region.y1);
        const w = Math.floor(charWidth);
        const h = Math.floor(region.height);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, x1, y1, w, h, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);
        const normalized = this.normalizeTemplate(imageData);

        this.templates.set(char, normalized);
        console.log(`Learned template for '${char}' (${this.templates.size} templates total)`);
        setRenderOne(true);
    }

    normalizeTemplate(imageData) {
        const data = imageData.data;
        const w = imageData.width;
        const h = imageData.height;
        const gray = new Float32Array(w * h);

        for (let i = 0; i < w * h; i++) {
            const idx = i * 4;
            gray[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        }

        let min = 255, max = 0;
        for (let i = 0; i < gray.length; i++) {
            if (gray[i] < min) min = gray[i];
            if (gray[i] > max) max = gray[i];
        }
        const range = max - min || 1;
        for (let i = 0; i < gray.length; i++) {
            gray[i] = (gray[i] - min) / range;
        }

        return {data: gray, width: w, height: h};
    }

    matchTemplate(imageData) {
        if (this.templates.size === 0) return null;

        const test = this.normalizeTemplate(imageData);
        let bestChar = null;
        let bestScore = -Infinity;

        for (const [char, template] of this.templates) {
            const score = this.compareTemplates(test, template);
            if (score > bestScore) {
                bestScore = score;
                bestChar = char;
            }
        }

        return bestScore > 0.7 ? bestChar : null;
    }

    compareTemplates(a, b) {
        const scaleX = b.width / a.width;
        const scaleY = b.height / a.height;

        let sumAB = 0, sumA2 = 0, sumB2 = 0;

        for (let y = 0; y < a.height; y++) {
            for (let x = 0; x < a.width; x++) {
                const aVal = a.data[y * a.width + x];
                const bx = Math.floor(x * scaleX);
                const by = Math.floor(y * scaleY);
                const bVal = b.data[by * b.width + bx];

                sumAB += aVal * bVal;
                sumA2 += aVal * aVal;
                sumB2 += bVal * bVal;
            }
        }

        const denom = Math.sqrt(sumA2 * sumB2);
        return denom > 0 ? sumAB / denom : 0;
    }

    clearTemplates() {
        this.templates.clear();
        console.log("Templates cleared");
        setRenderOne(true);
    }

    async startExtraction() {
        if (!this.enabled || this.regions.length === 0) return;
        if (this.extracting) {
            this.extracting = false;
            return;
        }

        try {
            await loadTesseract();
        } catch (e) {
            console.error("Failed to load Tesseract:", e);
            alert("Failed to load Tesseract.js. Make sure it's installed: npm install tesseract.js");
            return;
        }

        this.extracting = true;
        if (startExtractMenuItem) startExtractMenuItem.name("Stop Extraction");

        const Tesseract = getTesseract();
        const videoData = this.videoView?.videoData;
        if (!videoData) {
            this.extracting = false;
            if (startExtractMenuItem) startExtractMenuItem.name("Start Extract");
            return;
        }

        const startFrame = Math.floor(par.frame);
        const endFrame = Sit.bFrame ?? (Sit.frames - 1);

        for (let frame = startFrame; frame <= endFrame && this.extracting; frame++) {
            par.frame = frame;
            videoData.getImage(frame);
            await videoData.waitForFrame(frame, 5000);

            const image = videoData.getImage(frame);
            if (!image || !image.width) continue;

            for (const region of this.regions) {
                const text = await this.extractTextFromRegion(Tesseract, image, region);
                region.setTextForFrame(frame, text);
            }

            if (this.videoView && this.videoView.renderCanvas) {
                this.videoView.renderCanvas(frame);
            }
            setRenderOne(true);

            if (frame % 5 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        this.extracting = false;
        if (startExtractMenuItem) startExtractMenuItem.name("Start Extract");
        setRenderOne(true);
    }

    async extractTextFromRegion(Tesseract, image, region) {
        const imgWidth = image.width || image.videoWidth;
        const imgHeight = image.height || image.videoHeight;

        const x1 = Math.max(0, Math.floor(region.x1));
        const y1 = Math.max(0, Math.floor(region.y1));
        const x2 = Math.min(imgWidth, Math.ceil(region.x2));
        const y2 = Math.min(imgHeight, Math.ceil(region.y2));
        const w = x2 - x1;
        const h = y2 - y1;

        if (w <= 0 || h <= 0) return '';

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, x1, y1, w, h, 0, 0, w, h);

        if (this.useTemplates && this.templates.size > 0 && region.numChars > 0) {
            const charWidth = w / region.numChars;
            let result = '';

            for (let i = 0; i < region.numChars; i++) {
                const charX = Math.floor(i * charWidth);
                const charW = Math.ceil(charWidth);
                const charImageData = ctx.getImageData(charX, 0, charW, h);
                const matched = this.matchTemplate(charImageData);
                result += matched || '?';
            }
            return result;
        }

        if (this.fixedWidthFont && region.numChars > 0) {
            const charWidth = w / region.numChars;
            let result = '';

            for (let i = 0; i < region.numChars; i++) {
                const charX = Math.floor(i * charWidth);
                const charW = Math.floor(charWidth);

                const charCanvas = document.createElement('canvas');
                const padding = 4;
                charCanvas.width = charW + padding * 2;
                charCanvas.height = h + padding * 2;
                const charCtx = charCanvas.getContext('2d');
                charCtx.fillStyle = 'black';
                charCtx.fillRect(0, 0, charCanvas.width, charCanvas.height);
                charCtx.drawImage(canvas, charX, 0, charW, h, padding, padding, charW, h);

                try {
                    const ocrResult = await Tesseract.recognize(charCanvas, 'eng', {
                        tessedit_pageseg_mode: 10,
                        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz°\'".,:;-+=%/'
                    });
                    const char = ocrResult.data.text.trim();
                    result += char.length === 1 ? char : (char.length > 1 ? char[0] : ' ');
                } catch (e) {
                    result += '?';
                }
            }
            return result;
        }

        try {
            const result = await Tesseract.recognize(canvas, 'eng', {
                tessedit_pageseg_mode: 7
            });
            return result.data.text.trim();
        } catch (e) {
            console.warn("OCR error:", e);
            return '';
        }
    }

    renderOverlay(frame) {
        if (!this.enabled || !this.overlay) return;

        const width = this.videoView.widthPx;
        const height = this.videoView.heightPx;

        if (this.overlay.width !== width || this.overlay.height !== height) {
            this.overlay.width = width;
            this.overlay.height = height;
        }

        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, width, height);

        if (this.isDefiningRegion && this.newRegionStart && this.newRegionEnd) {
            const [cx1, cy1] = this.videoView.videoToCanvasCoords(this.newRegionStart.x, this.newRegionStart.y);
            const [cx2, cy2] = this.videoView.videoToCanvasCoords(this.newRegionEnd.x, this.newRegionEnd.y);
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(cx1, cy1, cx2 - cx1, cy2 - cy1);
            ctx.setLineDash([]);
        }

        for (const region of this.regions) {
            this.renderRegion(ctx, region, frame, region === this.selectedRegion);
        }
    }

    renderRegion(ctx, region, frame, isSelected) {
        const [cx1, cy1] = this.videoView.videoToCanvasCoords(region.x1, region.y1);
        const [cx2, cy2] = this.videoView.videoToCanvasCoords(region.x2, region.y2);

        ctx.strokeStyle = isSelected ? '#ffff00' : '#00ff00';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(cx1, cy1, cx2 - cx1, cy2 - cy1);

        const cornerSize = 6;
        ctx.fillStyle = isSelected ? '#ffff00' : '#00ff00';
        ctx.fillRect(cx1 - cornerSize / 2, cy1 - cornerSize / 2, cornerSize, cornerSize);
        ctx.fillRect(cx2 - cornerSize / 2, cy1 - cornerSize / 2, cornerSize, cornerSize);
        ctx.fillRect(cx1 - cornerSize / 2, cy2 - cornerSize / 2, cornerSize, cornerSize);
        ctx.fillRect(cx2 - cornerSize / 2, cy2 - cornerSize / 2, cornerSize, cornerSize);

        if (region.numChars > 1) {
            const regionWidth = cx2 - cx1;
            const charWidth = regionWidth / region.numChars;
            ctx.strokeStyle = isSelected ? 'rgba(255, 255, 0, 0.5)' : 'rgba(0, 255, 0, 0.5)';
            ctx.lineWidth = 1;
            for (let i = 1; i < region.numChars; i++) {
                const x = cx1 + i * charWidth;
                ctx.beginPath();
                ctx.moveTo(x, cy1);
                ctx.lineTo(x, cy2);
                ctx.stroke();
            }
        }

        const text = region.getTextForFrame(frame);
        if (text) {
            const regionHeight = Math.abs(cy2 - cy1);
            const fontSize = Math.max(12, Math.min(24, regionHeight * 0.8));
            ctx.font = `${fontSize}px monospace`;

            const textMetrics = ctx.measureText(text);
            const textWidth = textMetrics.width;
            const padding = 5;

            const canvasWidth = this.overlay.width;
            const regionCenterX = (cx1 + cx2) / 2;
            let textX;

            if (region.displaySide === 'auto') {
                if (regionCenterX > canvasWidth / 2) {
                    textX = cx1 - textWidth - padding * 2;
                } else {
                    textX = cx2 + padding;
                }
            } else if (region.displaySide === 'left') {
                textX = cx1 - textWidth - padding * 2;
            } else {
                textX = cx2 + padding;
            }

            const textY = cy1 + (cy2 - cy1) / 2 + fontSize / 3;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(textX - padding, textY - fontSize, textWidth + padding * 2, fontSize + padding);

            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, textX, textY);
        }
    }
}

let addRegionMenuItem = null;
let startExtractMenuItem = null;
let learnMenuItem = null;

function toggleEnableExtraction() {
    const videoView = NodeMan.get("video", false);
    if (!videoView) {
        console.warn("Text extraction requires a video view");
        return;
    }

    if (!textExtractor) {
        textExtractor = new TextExtractor(videoView);
    }

    if (textExtractor.enabled) {
        textExtractor.disable();
        enableExtractMenuItem.name("Enable Text Extraction");
    } else {
        textExtractor.enable();
        enableExtractMenuItem.name("Disable Text Extraction");

        if (!renderHooked) {
            renderHooked = true;
            const originalRender = videoView.renderCanvas.bind(videoView);
            videoView.renderCanvas = function(frame) {
                originalRender(frame);
                if (textExtractor && textExtractor.enabled) {
                    textExtractor.renderOverlay(frame);
                }
            };
        }
    }
    setRenderOne(true);
}

let enableExtractMenuItem = null;

export function addTextExtractionMenu() {
    if (!guiMenus.view) return;
    if (!isLocal) return;

    textExtractionFolder = guiMenus.video.addFolder("[BETA] Text Extraction").close().perm();

    const menuActions = {
        enableExtraction: toggleEnableExtraction,
        addRegion: () => textExtractor?.startAddRegion(),
        removeRegion: () => textExtractor?.removeSelectedRegion(),
        clearRegions: () => textExtractor?.clearAllRegions(),
        startExtract: () => textExtractor?.startExtraction(),
    };

    enableExtractMenuItem = textExtractionFolder.add(menuActions, 'enableExtraction')
        .name("Enable Text Extraction")
        .tooltip("Toggle text extraction mode on video")
        .perm();

    addRegionMenuItem = textExtractionFolder.add(menuActions, 'addRegion')
        .name("Add Region")
        .tooltip("Click and drag on video to define a text extraction region")
        .perm();

    textExtractionFolder.add(menuActions, 'removeRegion')
        .name("Remove Selected Region")
        .tooltip("Remove the currently selected region")
        .perm();

    textExtractionFolder.add(menuActions, 'clearRegions')
        .name("Clear All Regions")
        .tooltip("Remove all text extraction regions")
        .perm();

    startExtractMenuItem = textExtractionFolder.add(menuActions, 'startExtract')
        .name("Start Extract")
        .tooltip("Run OCR on all regions from current frame to end")
        .perm();

    const fixedWidthParams = {
        get fixedWidthFont() { return textExtractor?.fixedWidthFont ?? false; },
        set fixedWidthFont(v) { if (textExtractor) textExtractor.fixedWidthFont = v; }
    };
    textExtractionFolder.add(fixedWidthParams, 'fixedWidthFont')
        .name("Fixed Width Font")
        .tooltip("Enable character-by-character detection for fixed-width fonts (better for FLIR/sensor overlays)")
        .perm();

    const numCharsParams = {
        get numChars() { return textExtractor?.selectedRegion?.numChars ?? 10; },
        set numChars(v) { 
            if (textExtractor?.selectedRegion) {
                textExtractor.selectedRegion.numChars = v;
                setRenderOne(true);
            }
        }
    };
    textExtractionFolder.add(numCharsParams, 'numChars', 1, 30, 1)
        .name("Num Characters")
        .tooltip("Number of characters in the selected region (divides region evenly)")
        .perm();

    const templateActions = {
        learnTemplates: () => {
            if (textExtractor?.isLearning) {
                textExtractor.stopLearning();
            } else {
                textExtractor?.startLearning();
            }
        },
        clearTemplates: () => textExtractor?.clearTemplates(),
    };

    learnMenuItem = textExtractionFolder.add(templateActions, 'learnTemplates')
        .name("Learn Templates")
        .tooltip("Click character cells to teach their values (for template matching)")
        .perm();

    textExtractionFolder.add(templateActions, 'clearTemplates')
        .name("Clear Templates")
        .tooltip("Remove all learned character templates")
        .perm();

    const useTemplatesParams = {
        get useTemplates() { return textExtractor?.useTemplates ?? true; },
        set useTemplates(v) { if (textExtractor) textExtractor.useTemplates = v; }
    };
    textExtractionFolder.add(useTemplatesParams, 'useTemplates')
        .name("Use Templates")
        .tooltip("Use learned templates for matching (faster & more accurate when trained)")
        .perm();
}

export function getTextExtractor() {
    return textExtractor;
}

export function renderTextExtractionOverlay(frame) {
    if (textExtractor && textExtractor.enabled) {
        textExtractor.renderOverlay(frame);
    }
}
