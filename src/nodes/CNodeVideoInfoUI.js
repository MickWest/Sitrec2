import {CNodeViewUI} from "./CNodeViewUI";
import {CustomManager, GlobalDateTimeNode, Globals, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {t} from "../i18n";
import {getDisplayFilename} from "../FilenameUtils";

const DEFAULT_X = 50;
const DEFAULT_Y = 8;

export class CNodeVideoInfoUI extends CNodeViewUI {

    constructor(v) {
        super(v);

        this.doubleClickFullScreen = false;

        this.showInfo = v.showInfo ?? true;
        this.showFilename = v.showFilename ?? false;
        this.showFrameCounter = v.showFrameCounter ?? false;
        this.showSourceFrame = v.showSourceFrame ?? false;
        this.showOffsetFrame = v.showOffsetFrame ?? false;
        this.offsetFrameValue = v.offsetFrameValue ?? 0;
        this.showTimecode = v.showTimecode ?? false;
        this.showTimestamp = v.showTimestamp ?? false;
        this.showDateLocal = v.showDateLocal ?? false;
        this.showTimeLocal = v.showTimeLocal ?? false;
        this.showDateTimeLocal = v.showDateTimeLocal ?? false;
        this.showDateUTC = v.showDateUTC ?? false;
        this.showTimeUTC = v.showTimeUTC ?? false;
        this.showDateTimeUTC = v.showDateTimeUTC ?? false;
        this.fontSize = v.fontSize ?? 30;

        this.filenameX = v.filenameX ?? DEFAULT_X;
        this.filenameY = v.filenameY ?? DEFAULT_Y;
        this.frameCounterX = v.frameCounterX ?? DEFAULT_X;
        this.frameCounterY = v.frameCounterY ?? DEFAULT_Y;
        this.sourceFrameX = v.sourceFrameX ?? DEFAULT_X;
        this.sourceFrameY = v.sourceFrameY ?? DEFAULT_Y;
        this.offsetFrameX = v.offsetFrameX ?? DEFAULT_X;
        this.offsetFrameY = v.offsetFrameY ?? DEFAULT_Y;
        this.timecodeX = v.timecodeX ?? DEFAULT_X;
        this.timecodeY = v.timecodeY ?? DEFAULT_Y;
        this.timestampX = v.timestampX ?? DEFAULT_X;
        this.timestampY = v.timestampY ?? DEFAULT_Y;
        this.dateLocalX = v.dateLocalX ?? DEFAULT_X;
        this.dateLocalY = v.dateLocalY ?? DEFAULT_Y;
        this.timeLocalX = v.timeLocalX ?? DEFAULT_X;
        this.timeLocalY = v.timeLocalY ?? DEFAULT_Y;
        this.dateTimeLocalX = v.dateTimeLocalX ?? DEFAULT_X;
        this.dateTimeLocalY = v.dateTimeLocalY ?? DEFAULT_Y;
        this.dateUTCX = v.dateUTCX ?? DEFAULT_X;
        this.dateUTCY = v.dateUTCY ?? DEFAULT_Y;
        this.timeUTCX = v.timeUTCX ?? DEFAULT_X;
        this.timeUTCY = v.timeUTCY ?? DEFAULT_Y;
        this.dateTimeUTCX = v.dateTimeUTCX ?? DEFAULT_X;
        this.dateTimeUTCY = v.dateTimeUTCY ?? DEFAULT_Y;

        this.addSimpleSerial("showInfo");
        this.addSimpleSerial("showFilename");
        this.addSimpleSerial("showFrameCounter");
        this.addSimpleSerial("showSourceFrame");
        this.addSimpleSerial("showOffsetFrame");
        this.addSimpleSerial("offsetFrameValue");
        this.addSimpleSerial("showTimecode");
        this.addSimpleSerial("showTimestamp");
        this.addSimpleSerial("showDateLocal");
        this.addSimpleSerial("showTimeLocal");
        this.addSimpleSerial("showDateTimeLocal");
        this.addSimpleSerial("showDateUTC");
        this.addSimpleSerial("showTimeUTC");
        this.addSimpleSerial("showDateTimeUTC");
        this.addSimpleSerial("fontSize");
        this.addSimpleSerial("filenameX");
        this.addSimpleSerial("filenameY");
        this.addSimpleSerial("frameCounterX");
        this.addSimpleSerial("frameCounterY");
        this.addSimpleSerial("sourceFrameX");
        this.addSimpleSerial("sourceFrameY");
        this.addSimpleSerial("offsetFrameX");
        this.addSimpleSerial("offsetFrameY");
        this.addSimpleSerial("timecodeX");
        this.addSimpleSerial("timecodeY");
        this.addSimpleSerial("timestampX");
        this.addSimpleSerial("timestampY");
        this.addSimpleSerial("dateLocalX");
        this.addSimpleSerial("dateLocalY");
        this.addSimpleSerial("timeLocalX");
        this.addSimpleSerial("timeLocalY");
        this.addSimpleSerial("dateTimeLocalX");
        this.addSimpleSerial("dateTimeLocalY");
        this.addSimpleSerial("dateUTCX");
        this.addSimpleSerial("dateUTCY");
        this.addSimpleSerial("timeUTCX");
        this.addSimpleSerial("timeUTCY");
        this.addSimpleSerial("dateTimeUTCX");
        this.addSimpleSerial("dateTimeUTCY");

        this.canvas.style.pointerEvents = 'none';

        this.dragging = null;
        this.dragOffsetX = 0;
        this.dragOffsetY = 0;

        this.boundHandleMouseDown = (e) => this.handleMouseDown(e);
        this.boundHandleMouseMove = (e) => this.handleMouseMove(e);
        this.boundHandleMouseUp = (e) => this.handleMouseUp(e);

        document.addEventListener('mousemove', this.boundHandleMouseMove);
        document.addEventListener('mouseup', this.boundHandleMouseUp);
        this.canvas.addEventListener('mousedown', this.boundHandleMouseDown);
        
        this.boundHandleClick = (e) => this.handleClick(e);
        this.canvas.addEventListener('click', this.boundHandleClick);

        this.boundHandleDblClick = (e) => this.handleDblClick(e);
        this.canvas.addEventListener('dblclick', this.boundHandleDblClick);

        this.boundHandleContextMenu = (e) => this.handleContextMenu(e);
        this.canvas.addEventListener('contextmenu', this.boundHandleContextMenu);
        
        this._osdDataSeriesBboxes = {};

        this.updateVisibility();
    }

    hasAnyInfoItem() {
        return this.showFilename || this.showFrameCounter || this.showSourceFrame || this.showOffsetFrame ||
            this.showTimecode || this.showTimestamp ||
            this.showDateLocal || this.showTimeLocal || this.showDateTimeLocal ||
            this.showDateUTC || this.showTimeUTC || this.showDateTimeUTC;
    }

    hasAnyOSDDataSeries() {
        const controller = NodeMan.get("osdDataSeriesController", false);
        return controller && controller.getVisibleTracks().length > 0;
    }

    shouldBeVisible() {
        if (!this.showInfo) return false;
        return this.hasAnyInfoItem() || this.hasAnyOSDDataSeries();
    }

    updateVisibility() {
        this.show(this.shouldBeVisible());
    }

    isVideoReady() {
        const videoView = this.in.relativeTo;
        if (!videoView) return true;
        return videoView.videoWidth > 0 && videoView.videoHeight > 0 &&
            videoView.positioned && this.widthPx > 0 && this.heightPx > 0;
    }

    getAllItemIds() {
        return ['filename', 'frameCounter', 'sourceFrame', 'offsetFrame', 'timecode', 'timestamp', 'dateLocal', 'timeLocal',
            'dateTimeLocal', 'dateUTC', 'timeUTC', 'dateTimeUTC'];
    }

    getShowProp(id) {
        const map = {
            filename: 'showFilename',
            frameCounter: 'showFrameCounter',
            sourceFrame: 'showSourceFrame',
            offsetFrame: 'showOffsetFrame',
            timecode: 'showTimecode',
            timestamp: 'showTimestamp',
            dateLocal: 'showDateLocal',
            timeLocal: 'showTimeLocal',
            dateTimeLocal: 'showDateTimeLocal',
            dateUTC: 'showDateUTC',
            timeUTC: 'showTimeUTC',
            dateTimeUTC: 'showDateTimeUTC',
        };
        return map[id];
    }

    isItemMoved(id) {
        const pos = this.getElementPos(id);
        if (!pos) return false;
        return this[pos[0]] !== DEFAULT_X || this[pos[1]] !== DEFAULT_Y;
    }

    isItemVisibleOrMoved(id) {
        const showProp = this.getShowProp(id);
        return this[showProp] || this.isItemMoved(id);
    }

    estimateItemHeight() {
        const rect = this.getVideoRect();
        const referenceHeight = 1080;
        const scaledFontSize = Math.round(this.fontSize * rect.h / referenceHeight);
        const padding = Math.round(6 * rect.h / referenceHeight);
        return (scaledFontSize + padding * 2) / rect.h * 100;
    }

    getItemYPosition(id) {
        const pos = this.getElementPos(id);
        return pos ? this[pos[1]] : DEFAULT_Y;
    }

    setItemYPosition(id, y) {
        const pos = this.getElementPos(id);
        if (pos) this[pos[1]] = y;
    }

    positionItemToAvoidOverlaps(id) {
        const pos = this.getElementPos(id);
        if (!pos) return;
        this[pos[0]] = DEFAULT_X;
        this[pos[1]] = DEFAULT_Y;

        const itemHeight = this.estimateItemHeight();
        const margin = itemHeight * 0.2;

        const occupiedYRanges = [];
        for (const otherId of this.getAllItemIds()) {
            if (otherId === id) continue;
            if (this.isItemVisibleOrMoved(otherId)) {
                const otherY = this.getItemYPosition(otherId);
                occupiedYRanges.push({ start: otherY, end: otherY + itemHeight });
            }
        }

        let currentY = DEFAULT_Y;
        let foundPosition = false;
        while (!foundPosition && currentY < 90) {
            const newEnd = currentY + itemHeight;
            let hasOverlap = false;
            for (const range of occupiedYRanges) {
                if (!(newEnd + margin <= range.start || currentY >= range.end + margin)) {
                    hasOverlap = true;
                    currentY = range.end + margin;
                    break;
                }
            }
            if (!hasOverlap) {
                foundPosition = true;
            }
        }

        this[pos[1]] = Math.min(currentY, 90);
    }

    getElementBounds() {
        const bounds = [];
        const padding = 6;

        const addBbox = (id, show, bbox) => {
            if (show && bbox) {
                bounds.push({
                    id,
                    x: bbox.x - padding,
                    y: bbox.y - padding,
                    w: bbox.w + padding * 2,
                    h: bbox.h + padding * 2
                });
            }
        };

        addBbox('filename', this.showFilename, this._filenameBbox);
        addBbox('frameCounter', this.showFrameCounter, this._frameCounterBbox);
        addBbox('sourceFrame', this.showSourceFrame, this._sourceFrameBbox);
        addBbox('offsetFrame', this.showOffsetFrame, this._offsetFrameBbox);
        addBbox('timecode', this.showTimecode, this._timecodeBbox);
        addBbox('timestamp', this.showTimestamp, this._timestampBbox);
        addBbox('dateLocal', this.showDateLocal, this._dateLocalBbox);
        addBbox('timeLocal', this.showTimeLocal, this._timeLocalBbox);
        addBbox('dateTimeLocal', this.showDateTimeLocal, this._dateTimeLocalBbox);
        addBbox('dateUTC', this.showDateUTC, this._dateUTCBbox);
        addBbox('timeUTC', this.showTimeUTC, this._timeUTCBbox);
        addBbox('dateTimeUTC', this.showDateTimeUTC, this._dateTimeUTCBbox);
        
        for (const [id, bbox] of Object.entries(this._osdDataSeriesBboxes)) {
            addBbox(id, true, bbox);
        }

        return bounds;
    }

    getElementAtPosition(x, y) {
        const bounds = this.getElementBounds();
        for (const b of bounds) {
            if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
                return b.id;
            }
        }
        return null;
    }

    getElementPos(id) {
        const map = {
            filename: ['filenameX', 'filenameY'],
            frameCounter: ['frameCounterX', 'frameCounterY'],
            sourceFrame: ['sourceFrameX', 'sourceFrameY'],
            offsetFrame: ['offsetFrameX', 'offsetFrameY'],
            timecode: ['timecodeX', 'timecodeY'],
            timestamp: ['timestampX', 'timestampY'],
            dateLocal: ['dateLocalX', 'dateLocalY'],
            timeLocal: ['timeLocalX', 'timeLocalY'],
            dateTimeLocal: ['dateTimeLocalX', 'dateTimeLocalY'],
            dateUTC: ['dateUTCX', 'dateUTCY'],
            timeUTC: ['timeUTCX', 'timeUTCY'],
            dateTimeUTC: ['dateTimeUTCX', 'dateTimeUTCY'],
        };
        if (map[id]) return map[id];
        
        if (id && id.startsWith('osdDataSeries_')) {
            const trackIndex = parseInt(id.split('_')[1], 10);
            const controller = NodeMan.get("osdDataSeriesController", false);
            if (controller && controller.tracks[trackIndex]) {
                return { track: controller.tracks[trackIndex] };
            }
        }
        return null;
    }
    
    isOSDDataSeriesElement(id) {
        return id && id.startsWith('osdDataSeries_');
    }
    
    getOSDDataSeries(id) {
        if (!this.isOSDDataSeriesElement(id)) return null;
        const trackIndex = parseInt(id.split('_')[1], 10);
        const controller = NodeMan.get("osdDataSeriesController", false);
        if (controller && controller.tracks[trackIndex]) {
            return controller.tracks[trackIndex];
        }
        return null;
    }

    handleMouseDown(e) {
        if (!this.isVideoReady() || !this.shouldBeVisible()) return;

        const canvasRect = this.canvas.getBoundingClientRect();
        const x = e.clientX - canvasRect.left;
        const y = e.clientY - canvasRect.top;

        const element = this.getElementAtPosition(x, y);
        if (!element) return;

        if (e.button === 2 && this.isOSDDataSeriesElement(element)) {
            e.stopPropagation();
            e.preventDefault();
            this.showOSDDataSeriesContextMenu(element, e.clientX, e.clientY);
            return;
        }

        if (e.button !== 0) return;

        this.dragging = element;
        const pos = this.getElementPos(element);
        if (pos) {
            if (pos.track) {
                this.dragOffsetX = x - this.videoPx(pos.track.x);
                this.dragOffsetY = y - this.videoPy(pos.track.y);
            } else {
                this.dragOffsetX = x - this.videoPx(this[pos[0]]);
                this.dragOffsetY = y - this.videoPy(this[pos[1]]);
            }
        }
        this.canvas.style.pointerEvents = 'auto';
        e.stopPropagation();
        e.preventDefault();
    }
    
    handleClick(e) {
        if (!this.isVideoReady()) return;
        
        const canvasRect = this.canvas.getBoundingClientRect();
        const x = e.clientX - canvasRect.left;
        const y = e.clientY - canvasRect.top;
        
        const element = this.getElementAtPosition(x, y);
        const controller = NodeMan.get("osdDataSeriesController", false);
        if (element && this.isOSDDataSeriesElement(element)) {
            const track = this.getOSDDataSeries(element);
            if (track && !track.lock) {
                if (controller) {
                    controller.startEditing(track);
                    e.stopPropagation();
                    e.preventDefault();
                }
            }
        } else if (controller && controller.isEditing()) {
            controller.stopEditing();
        }
    }

    handleDblClick(e) {
        if (!this.isVideoReady()) return;

        const canvasRect = this.canvas.getBoundingClientRect();
        const x = e.clientX - canvasRect.left;
        const y = e.clientY - canvasRect.top;

        const element = this.getElementAtPosition(x, y);
        if (element && this.isOSDDataSeriesElement(element)) {
            e.stopPropagation();
            e.preventDefault();
        }
    }

    handleContextMenu(e) {
        if (!this.isVideoReady()) return;

        const canvasRect = this.canvas.getBoundingClientRect();
        const x = e.clientX - canvasRect.left;
        const y = e.clientY - canvasRect.top;

        const element = this.getElementAtPosition(x, y);
        if (element && this.isOSDDataSeriesElement(element)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    showOSDDataSeriesContextMenu(element, clientX, clientY) {
        const track = this.getOSDDataSeries(element);
        if (track && track.guiFolder) {
            const standaloneMenu = Globals.menuBar.createStandaloneMenu(
                track.name, clientX, clientY, true
            );
            if (!standaloneMenu) return;

            CustomManager.setupDynamicMirroring(track.guiFolder, standaloneMenu);
            standaloneMenu.refreshMirror = () => {
                CustomManager.updateMirror(standaloneMenu);
            };
            standaloneMenu.open();

            for (const ctrl of standaloneMenu.controllers) {
                if (ctrl.property === "show") {
                    const existingOnChange = ctrl._onChange;
                    ctrl.onChange((value) => {
                        if (existingOnChange) existingOnChange(value);
                        if (!value) standaloneMenu.destroy();
                    });
                    break;
                }
            }
        }
    }

    handleMouseMove(e) {
        if (!this.isVideoReady()) return;

        const canvasRect = this.canvas.getBoundingClientRect();
        const x = e.clientX - canvasRect.left;
        const y = e.clientY - canvasRect.top;

        if (this.dragging) {
            const newPctX = ((x - this.dragOffsetX) / canvasRect.width) * 100;
            const newPctY = ((y - this.dragOffsetY) / canvasRect.height) * 100;

            const pos = this.getElementPos(this.dragging);
            if (pos) {
                if (pos.track) {
                    pos.track.x = newPctX;
                    pos.track.y = newPctY;
                } else {
                    this[pos[0]] = newPctX;
                    this[pos[1]] = newPctY;
                }
            }
            return;
        }

        if (x >= 0 && x <= canvasRect.width && y >= 0 && y <= canvasRect.height) {
            const element = this.getElementAtPosition(x, y);
            if (element && this.shouldBeVisible()) {
                this.canvas.style.pointerEvents = 'auto';
                this.canvas.style.cursor = 'move';
            } else {
                this.canvas.style.pointerEvents = 'none';
                this.canvas.style.cursor = '';
            }
        } else {
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.cursor = '';
        }
    }

    handleMouseUp(e) {
        if (this.dragging) {
            this.dragging = null;

            const canvasRect = this.canvas.getBoundingClientRect();
            const x = e.clientX - canvasRect.left;
            const y = e.clientY - canvasRect.top;
            const element = this.getElementAtPosition(x, y);
            if (!element || !this.shouldBeVisible()) {
                this.canvas.style.pointerEvents = 'none';
                this.canvas.style.cursor = '';
            }
        }
    }

    formatTimecode(frame, fps, showHours) {
        const totalSeconds = frame / fps;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const frames = Math.floor(frame % fps);

        const mm = String(minutes).padStart(2, '0');
        const ss = String(seconds).padStart(2, '0');
        const ff = String(frames).padStart(2, '0');

        if (showHours) {
            const hh = String(hours).padStart(2, '0');
            return `${hh}:${mm}:${ss}:${ff}`;
        }
        return `${mm}:${ss}:${ff}`;
    }

    formatTimestamp(frame, fps, showHours) {
        const totalSeconds = frame / fps;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const mm = String(minutes).padStart(2, '0');
        const ssDecimal = seconds.toFixed(2).padStart(5, '0');

        if (showHours) {
            const hh = String(hours).padStart(2, '0');
            return `${hh}:${mm}:${ssDecimal}`;
        }
        return `${mm}:${ssDecimal}`;
    }

    getVideoFilename() {
        const videoView = this.in.relativeTo;
        return getDisplayFilename(videoView?.fileName ?? videoView?.videoData?.filename);
    }

    getVideoRect() {
        let vx = 0, vy = 0, vw = this.widthPx, vh = this.heightPx;
        const videoView = this.in.relativeTo;
        if (videoView && videoView.getSourceAndDestCoords &&
            videoView.videoWidth > 0 && videoView.videoHeight > 0) {
            videoView.getSourceAndDestCoords();
            if (!isNaN(videoView.dWidth) && !isNaN(videoView.dHeight) &&
                videoView.dWidth > 0 && videoView.dHeight > 0) {
                vx = videoView.dx;
                vy = videoView.dy;
                vw = videoView.dWidth;
                vh = videoView.dHeight;
            }
        }
        return { x: vx, y: vy, w: vw, h: vh };
    }

    videoPx(pct) {
        return (pct / 100) * this.widthPx;
    }

    videoPy(pct) {
        return (pct / 100) * this.heightPx;
    }

    snapPositionsToView() {
        for (const id of this.getAllItemIds()) {
            const pos = this.getElementPos(id);
            if (pos) {
                if (this[pos[0]] < 5) this[pos[0]] = 5;
                if (this[pos[0]] > 95) this[pos[0]] = 95;
                if (this[pos[1]] < 5) this[pos[1]] = 5;
                if (this[pos[1]] > 95) this[pos[1]] = 95;
            }
        }
    }

    renderCanvas(frame) {
        const shouldRender = this.isVideoReady() &&
            (!this.overlayView || this.overlayView.visible) &&
            (!this.in.relativeTo || this.in.relativeTo.visible) &&
            this.shouldBeVisible();

        if (!shouldRender) {
            if (this.ctx) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
            return;
        }

        const rect = this.getVideoRect();
        if (!rect.w || !rect.h) return;

        if (!this.dragging) {
            this.snapPositionsToView();
        }

        super.renderCanvas(frame);

        this.drawInfoToContext(this.ctx, this.widthPx, this.heightPx, rect, frame);
    }

    // Draws every enabled Video Info Display item plus the OSD Data Series
    // readouts into an arbitrary 2D context. Used both by the live overlay
    // (this.renderCanvas) and by the stabilized-video exporter, so the
    // exported video shows the same overlays the user configured in the UI.
    drawInfoToContext(c, widthPx, heightPx, rect, frame) {
        const fps = Sit.fps || 30;
        const totalSeconds = (Sit.frames || 1) / fps;
        const showHours = totalSeconds >= 3600;
        const referenceHeight = 1080;
        const scaledFontSize = Math.round(this.fontSize * rect.h / referenceHeight);
        c.font = `${scaledFontSize}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'alphabetic';

        const padding = Math.round(6 * rect.h / referenceHeight);

        const drawTextWithBg = (text, pctX, pctY) => {
            const x = (pctX / 100) * widthPx;
            const y = (pctY / 100) * heightPx;
            const metrics = c.measureText(text);
            const textHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
            const vPad = textHeight * 0.05;
            const bgX = x - metrics.width / 2 - padding;
            const bgY = y - metrics.actualBoundingBoxAscent - padding - vPad;
            const bgW = metrics.width + padding * 2;
            const bgH = textHeight + padding * 2 + vPad * 2;

            c.fillStyle = 'rgba(0, 0, 0, 0.5)';
            c.fillRect(bgX, bgY, bgW, bgH);
            c.fillStyle = '#FFFFFF';
            c.fillText(text, x, y);

            return { x: bgX, y: bgY, w: bgW, h: bgH };
        };

        if (this.showFilename) {
            const filename = this.getVideoFilename();
            if (filename) {
                this._filenameBbox = drawTextWithBg(filename, this.filenameX, this.filenameY);
            }
        }

        if (this.showFrameCounter) {
            this._frameCounterBbox = drawTextWithBg(`${Math.floor(par.frame)}`, this.frameCounterX, this.frameCounterY);
        }

        if (this.showSourceFrame) {
            // Source frame number: when the videoData is a CVideoPatchedData
            // wrapper, this differs from par.frame during held bursts (the
            // virtual timeline pads gaps with held copies of the same source
            // frame). When not wrapped, source == virtual, so we just show
            // the same number — keeps the readout meaningful regardless of
            // whether patching is active.
            const videoView = this.in.relativeTo;
            const videoData = videoView?.videoData;
            const sourceFrameIdx = (videoData && typeof videoData.virtualToSource === "function")
                ? videoData.virtualToSource(Math.floor(par.frame))
                : Math.floor(par.frame);
            this._sourceFrameBbox = drawTextWithBg(`${sourceFrameIdx}`, this.sourceFrameX, this.sourceFrameY);
        }

        if (this.showOffsetFrame) {
            this._offsetFrameBbox = drawTextWithBg(`${Math.floor(par.frame) + this.offsetFrameValue}`, this.offsetFrameX, this.offsetFrameY);
        }

        if (this.showTimecode) {
            this._timecodeBbox = drawTextWithBg(this.formatTimecode(par.frame, fps, showHours), this.timecodeX, this.timecodeY);
        }

        if (this.showTimestamp) {
            this._timestampBbox = drawTextWithBg(this.formatTimestamp(par.frame, fps, showHours), this.timestampX, this.timestampY);
        }

        const nowDate = GlobalDateTimeNode?.dateNow;
        if (nowDate) {
            if (this.showDateLocal) {
                this._dateLocalBbox = drawTextWithBg(this.formatDateLocal(nowDate), this.dateLocalX, this.dateLocalY);
            }
            if (this.showTimeLocal) {
                this._timeLocalBbox = drawTextWithBg(this.formatTimeLocal(nowDate), this.timeLocalX, this.timeLocalY);
            }
            if (this.showDateTimeLocal) {
                this._dateTimeLocalBbox = drawTextWithBg(this.formatDateTimeLocal(nowDate), this.dateTimeLocalX, this.dateTimeLocalY);
            }
            if (this.showDateUTC) {
                this._dateUTCBbox = drawTextWithBg(this.formatDateUTC(nowDate), this.dateUTCX, this.dateUTCY);
            }
            if (this.showTimeUTC) {
                this._timeUTCBbox = drawTextWithBg(this.formatTimeUTC(nowDate), this.timeUTCX, this.timeUTCY);
            }
            if (this.showDateTimeUTC) {
                this._dateTimeUTCBbox = drawTextWithBg(this.formatDateTimeUTC(nowDate), this.dateTimeUTCX, this.dateTimeUTCY);
            }
        }

        this.drawOSDDataSeries(c, widthPx, heightPx, padding);
    }

    drawOSDDataSeries(c, widthPx, heightPx, padding) {
        const controller = NodeMan.get("osdDataSeriesController", false);
        if (!controller) return;

        this._osdDataSeriesBboxes = {};

        const frame = Math.floor(par.frame);

        for (let i = 0; i < controller.tracks.length; i++) {
            const track = controller.tracks[i];
            if (!track.show) continue;

            let text;
            let isEditing = controller.isEditing() && controller.getEditingTrack() === track;
            let isKeyframe = false;

            let direction = 0;
            let cursorPos = -1;
            if (isEditing) {
                text = controller.getEditingText();
                cursorPos = controller.cursorPos;
                isKeyframe = track.isKeyframe(frame);
            } else {
                const displayInfo = track.getDisplayInfo(frame);
                text = displayInfo.value;
                isKeyframe = displayInfo.isKeyframe;
                direction = displayInfo.direction;
            }

            const indicator = (isKeyframe && !isEditing)
                ? (direction > 0 ? "▲" : direction < 0 ? "▼" : "=")
                : null;

            const x = (track.x / 100) * widthPx;
            const y = (track.y / 100) * heightPx;
            const metrics = c.measureText(text);
            // Always use "0" as the minimum height reference so the box
            // doesn't shrink for short glyphs like "-" or ".".
            const refMetrics = c.measureText("0");
            const textHeight = Math.max(
                metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
                refMetrics.actualBoundingBoxAscent + refMetrics.actualBoundingBoxDescent
            );
            const vPad = textHeight * 0.05;
            const indicatorGap = padding;
            const indicatorMetrics = indicator ? c.measureText(indicator) : null;
            const indicatorWidth = indicatorMetrics ? indicatorGap + indicatorMetrics.width : 0;
            const boxWidth = Math.max(metrics.width, refMetrics.width);
            const bgX = x - boxWidth / 2 - padding;
            const boxAscent = Math.max(metrics.actualBoundingBoxAscent, refMetrics.actualBoundingBoxAscent);
            const bgY = y - boxAscent - padding - vPad;
            const bgW = boxWidth + padding * 2 + indicatorWidth;
            const bgH = textHeight + padding * 2 + vPad * 2;

            if (track.lock) {
                c.fillStyle = 'rgba(80, 80, 80, 0.7)';
            } else if (isEditing && isKeyframe) {
                c.fillStyle = 'rgba(0, 80, 50, 0.7)';
            } else if (isEditing) {
                c.fillStyle = 'rgba(0, 80, 120, 0.7)';
            } else if (isKeyframe) {
                c.fillStyle = 'rgba(0, 100, 0, 0.7)';
            } else {
                c.fillStyle = 'rgba(0, 60, 100, 0.6)';
            }
            c.fillRect(bgX, bgY, bgW, bgH);

            if (isEditing) {
                c.strokeStyle = isKeyframe ? '#00FF00' : '#00AAFF';
                c.lineWidth = 2;
                c.strokeRect(bgX, bgY, bgW, bgH);
            }

            c.fillStyle = track.lock ? '#BFBFBF' : '#FFFFFF';
            c.fillText(text, x, y);

            if (cursorPos >= 0) {
                const cursorVisible = Math.floor((Date.now() - controller.cursorBlinkEpoch) / 530) % 2 === 0;
                if (cursorVisible) {
                    const beforeCursor = text.slice(0, cursorPos);
                    const beforeWidth = c.measureText(beforeCursor).width;
                    const cursorX = x - boxWidth / 2 + beforeWidth;
                    const cursorTop = y - textHeight;
                    const cursorBottom = y + textHeight * 0.2;
                    c.strokeStyle = '#FFFFFF';
                    c.lineWidth = 1.5;
                    c.beginPath();
                    c.moveTo(cursorX, cursorTop);
                    c.lineTo(cursorX, cursorBottom);
                    c.stroke();
                }
                this.ensureCursorBlink(controller);
            }

            if (indicator) {
                const indicatorColor = direction > 0 ? '#00FF00' : direction < 0 ? '#FF4444' : '#FFFF00';
                c.fillStyle = indicatorColor;
                const indicatorX = x + boxWidth / 2 + indicatorGap;
                c.textAlign = 'left';
                c.fillText(indicator, indicatorX, y);
                c.textAlign = 'center';
            }

            this._osdDataSeriesBboxes[`osdDataSeries_${i}`] = { x: bgX, y: bgY, w: bgW, h: bgH };
        }
    }

    ensureCursorBlink(controller) {
        if (this._cursorBlinkTimer) return;
        this._cursorBlinkTimer = setInterval(() => {
            if (!controller.isEditing()) {
                clearInterval(this._cursorBlinkTimer);
                this._cursorBlinkTimer = null;
                return;
            }
            setRenderOne();
        }, 530);
    }

    getLocalDate(date) {
        const offsetHours = GlobalDateTimeNode?.getTimeZoneOffset() || 0;
        const offsetMs = offsetHours * 60 * 60 * 1000;
        const localOffset = date.getTimezoneOffset() * 60000;
        const utc = date.getTime() + localOffset;
        return new Date(utc + offsetMs);
    }

    formatDateLocal(date) {
        const d = this.getLocalDate(date);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    formatTimeLocal(date) {
        const d = this.getLocalDate(date);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    formatDateTimeLocal(date) {
        const tzName = GlobalDateTimeNode?.getTimeZoneName() || '';
        return `${this.formatDateLocal(date)} ${this.formatTimeLocal(date)} ${tzName}`;
    }

    formatDateUTC(date) {
        const pad = n => String(n).padStart(2, '0');
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }

    formatTimeUTC(date) {
        const pad = n => String(n).padStart(2, '0');
        return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    }

    formatDateTimeUTC(date) {
        return `${this.formatDateUTC(date)} ${this.formatTimeUTC(date)} UTC`;
    }

    dispose() {
        if (this._cursorBlinkTimer) {
            clearInterval(this._cursorBlinkTimer);
            this._cursorBlinkTimer = null;
        }
        if (this.boundHandleMouseMove) {
            document.removeEventListener('mousemove', this.boundHandleMouseMove);
        }
        if (this.boundHandleMouseUp) {
            document.removeEventListener('mouseup', this.boundHandleMouseUp);
        }
        if (this.canvas && this.boundHandleMouseDown) {
            this.canvas.removeEventListener('mousedown', this.boundHandleMouseDown);
        }
        if (this.canvas && this.boundHandleClick) {
            this.canvas.removeEventListener('click', this.boundHandleClick);
        }
        super.dispose();
    }

    setupMenu(parentFolder) {
        const folder = parentFolder.addFolder(t("videoInfo.folderTitle.label")).close()
            .tooltip(t("videoInfo.folderTitle.tooltip"));

        folder.add(this, "showInfo").name(t("videoInfo.showVideoInfo.label"))
            .tooltip(t("videoInfo.showVideoInfo.tooltip"))
            .listen()
            .onChange(() => this.updateVisibility());

        folder.add(this, "showFilename").name(t("videoInfo.filename.label"))
            .tooltip(t("videoInfo.filename.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('filename'); this.updateVisibility(); });

        folder.add(this, "showFrameCounter").name(t("videoInfo.frameCounter.label"))
            .tooltip(t("videoInfo.frameCounter.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('frameCounter'); this.updateVisibility(); });

        folder.add(this, "showSourceFrame").name(t("videoInfo.sourceFrame.label"))
            .tooltip(t("videoInfo.sourceFrame.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('sourceFrame'); this.updateVisibility(); });

        folder.add(this, "showOffsetFrame").name(t("videoInfo.offsetFrame.label"))
            .tooltip(t("videoInfo.offsetFrame.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('offsetFrame'); this.updateVisibility(); });

        folder.add(this, "offsetFrameValue", -10000, 10000, 1).name(t("videoInfo.offsetValue.label"))
            .tooltip(t("videoInfo.offsetValue.tooltip"))
            .listen();

        folder.add(this, "showTimecode").name(t("videoInfo.timecode.label"))
            .tooltip(t("videoInfo.timecode.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timecode'); this.updateVisibility(); });

        folder.add(this, "showTimestamp").name(t("videoInfo.timestamp.label"))
            .tooltip(t("videoInfo.timestamp.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timestamp'); this.updateVisibility(); });

        folder.add(this, "showDateLocal").name(t("videoInfo.dateLocal.label"))
            .tooltip(t("videoInfo.dateLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateLocal'); this.updateVisibility(); });

        folder.add(this, "showTimeLocal").name(t("videoInfo.timeLocal.label"))
            .tooltip(t("videoInfo.timeLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timeLocal'); this.updateVisibility(); });

        folder.add(this, "showDateTimeLocal").name(t("videoInfo.dateTimeLocal.label"))
            .tooltip(t("videoInfo.dateTimeLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateTimeLocal'); this.updateVisibility(); });

        folder.add(this, "showDateUTC").name(t("videoInfo.dateUTC.label"))
            .tooltip(t("videoInfo.dateUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateUTC'); this.updateVisibility(); });

        folder.add(this, "showTimeUTC").name(t("videoInfo.timeUTC.label"))
            .tooltip(t("videoInfo.timeUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timeUTC'); this.updateVisibility(); });

        folder.add(this, "showDateTimeUTC").name(t("videoInfo.dateTimeUTC.label"))
            .tooltip(t("videoInfo.dateTimeUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateTimeUTC'); this.updateVisibility(); });

        folder.add(this, "fontSize", 10, 80, 1).name(t("videoInfo.fontSize.label"))
            .tooltip(t("videoInfo.fontSize.tooltip"))
            .listen();

        return folder;
    }
}
