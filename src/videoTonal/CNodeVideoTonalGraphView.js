import {CNodeCustomGraphView} from '../nodes/CNodeCustomGraphView';
import {CNodeTabbedCanvasView} from '../nodes/CNodeTabbedCanvasView';
import {NodeMan, setRenderOne, Sit} from '../Globals';
import {par} from '../par';
import {t} from '../i18n';
import {VideoLoadingManager} from '../CVideoLoadingManager';
import {getObjectTracker} from '../CObjectTracking';
import {displayIndexForFrame, sourceVideoOf} from '../videoQP/VideoQPAnalysis';
import {startTonalAnalysis} from './VideoTonalAnalysis';
import {TONAL_FIELDS} from './TonalStatistics';
import {TONAL_DEFAULTS} from '../VideoTonalGraph';

const MARGIN = 60;
const DARK = {bg: '#000', text: '#ddd', grid: '#333', median: '#fff', lower: '#4199ee', upper: '#f59c44',
    mean: '#bf9aff', target: '#54e2a8', local: '#ff86d2', cursor: '#ff0'};
const LIGHT = {bg: '#fff', text: '#222', grid: '#ddd', median: '#111', lower: '#165da5', upper: '#b45000',
    mean: '#703fa0', target: '#087a51', local: '#ad246e', cursor: '#ac6500'};

export class CNodeVideoTonalGraphView extends CNodeCustomGraphView {
    constructor(v) {
        super(v);
        this.skipModSerialize = true;
        this.options = {...TONAL_DEFAULTS, ...v.options};
        this.isFrameX = true;
        this.xLabel = t('videoTonal.frame');
        this.refreshAnalysis();
    }

    modSerialize() { return {...super.modSerialize(), tonalOptions: {...this.options}}; }

    modDeserialize(state) {
        super.modDeserialize(state);
        const saved = state.tonalOptions ?? {};
        this.options = {...TONAL_DEFAULTS, ...saved};
        if (!['percentiles', 'histogram', 'contrast', 'relativeContrast'].includes(this.options.mode)) this.options.mode = 'percentiles';
        this.options.targetRadius = Math.max(1, Math.min(100, Number(this.options.targetRadius) || 6));
        this.refreshAnalysis();
    }

    invalidatePlot() { this._plotKey = ''; }

    refreshAnalysis() {
        this.job?.cancel();
        this.job = null;
        this._inputs = null;
        this._pollAt = 0;
        this.invalidatePlot();
        setRenderOne();
    }

    dispose() {
        clearTimeout(this._pollTimer);
        this.job?.cancel();
        this.job = null;
        this._plot = null;
        super.dispose();
    }

    show(visible) {
        super.show(visible);
        if (!visible) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
            if (this.job && !this.job.result.complete) this.refreshAnalysis();
        }
    }

    get result() { return this.job?.result; }
    currentVideoData() { return NodeMan.get('video', false)?.videoData; }
    contrastMode() { return this.options?.mode === 'contrast' || this.options?.mode === 'relativeContrast'; }

    autoScale() {
        this.minX = 0;
        this.maxX = Math.max(1, (Sit.frames ?? 1) - 1);
        this.minY = 0; this.maxY = 255;
        if (this.contrastMode()) {
            let bound = this.options.mode === 'contrast' ? 16 : 1;
            const values = this.result?.[this.options.mode];
            if (values) for (const value of values) if (Number.isFinite(value)) bound = Math.max(bound, Math.abs(value));
            this.maxY = Math.ceil(bound * 1.1);
            this.minY = -this.maxY;
        }
        this.hasY2 = false; this.hasY3 = false;
    }

    captureTargets(video, frames) {
        if (!this.options.targetAnalysis && !this.contrastMode()) return null;
        const tracker = getObjectTracker();
        if (tracker?.videoView?.videoData !== video || !tracker.trackedPositions?.size) return null;
        const width = video.originalVideoWidth || video.videoWidth;
        const height = video.originalVideoHeight || video.videoHeight;
        const positions = tracker.trackedPositions;
        const targets = new Array(frames).fill(null);
        let any = false;
        for (const [f, point] of positions) {
            if (positions.unmeasuredFrames?.has(f) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
            const index = displayIndexForFrame(video, f);
            if (index < 0 || index >= frames || targets[index]) continue;
            targets[index] = {u: point.x / width, v: point.y / height,
                rx: this.options.targetRadius / width, ry: this.options.targetRadius / height};
            any = true;
        }
        return any ? targets : null;
    }

    ensureAnalysis() {
        if (!this._pollTimer) this._pollTimer = setTimeout(() => {
            this._pollTimer = null;
            // Check for mask/track edits without forcing a paused 3D scene to redraw.
            if (this.visible) this.ensureAnalysis();
        }, 500);
        if (performance.now() < this._pollAt) return;
        this._pollAt = performance.now() + 250;
        const video = this.currentVideoData();
        const source = sourceVideoOf(video);
        const mask = NodeMan.get('videoMask', false) ?? NodeMan.get('motionMaskOverlay', false);
        const enabled = mask?.maskEnabled !== false;
        mask?.ensureMaskInitialized();
        let message = '';
        if (!source) message = t('videoTonal.noVideo');
        else if (source._loadingId && VideoLoadingManager.isLoading(source._loadingId)) message = t('videoTonal.loading');
        else if (!source.chunks?.length || !source.config) message = t('videoTonal.noFrames');
        else if (enabled && mask?.maskData && !mask.maskImageData) message = t('videoTonal.loadingMask');
        if (message) {
            if (this.job) this.refreshAnalysis();
            if (message !== this.message) { this.invalidatePlot(); setRenderOne(); }
            this.message = message;
            return;
        }
        this.message = '';
        const pixels = enabled ? mask?.maskImageData : null;
        const rotation = source.effectiveRotation ?? 0;
        const targets = this.captureTargets(video, source.chunks.length);
        const trackKey = JSON.stringify(targets);
        const old = this._inputs;
        if (old && old.video === video && old.source === source && old.chunks === source.chunks
            && old.frames === source.chunks.length && old.pixels === pixels && old.rotation === rotation
            && old.trackKey === trackKey) return;
        this.refreshAnalysis();
        this._inputs = {video, source, chunks: source.chunks, frames: source.chunks.length, pixels, rotation, trackKey};
        let snapshot = null;
        if (pixels) {
            const alpha = new Uint8Array(pixels.width * pixels.height);
            for (let i = 0; i < alpha.length; i++) alpha[i] = pixels.data[i * 4 + 3];
            snapshot = {width: pixels.width, height: pixels.height, alpha};
        }
        try {
            let lastPaint = 0;
            this.job = startTonalAnalysis(video, {mask: snapshot, rotation, targets}, result => {
                if (result.complete || performance.now() - lastPaint > 150) {
                    lastPaint = performance.now();
                    setRenderOne();
                }
            });
        } catch (error) { this.message = t('videoTonal.failed', {reason: error.message}); }
    }

    statusMessage() {
        const result = this.result;
        if (this.message) return this.message;
        if (result?.error) return t('videoTonal.failed', {reason: result.error});
        if (result && !result.complete) return t('videoTonal.analyzing', {percent: Math.floor(100 * result.done / result.frames)});
        if ((this.options.targetAnalysis || this.contrastMode()) && !result?.hasTargets) return t('videoTonal.noTrack');
        if (result?.complete && !result.counts.some(count => count > 0)) return t('videoTonal.emptyMask');
        return '';
    }

    renderCanvas(frame) {
        if (!this.visible) return;
        this.ensureAnalysis();
        const key = [this.widthPx, this.heightPx, this.dark, this.result?.version,
            JSON.stringify(this.options), this.statusMessage(), Sit.frames, this.currentVideoData()?.videoSpeed, this.showLegend].join('|');
        if (key !== this._plotKey) {
            this.autoScale();
            this._plot = this.drawPlot();
            this._plotKey = key;
        }
        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);
        if (this._plot) this.ctx.drawImage(this._plot, 0, 0);
        this.drawCursor();
    }

    point(frame, value) { return this.graphToScreenAxis(frame, value, this.minY, this.maxY); }
    value(field, frame) { return this.result?.[field]?.[displayIndexForFrame(this.currentVideoData(), frame)]; }

    drawLine(ctx, field, color) {
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath();
        let active = false;
        for (let f = 0; f < (Sit.frames ?? 0); f++) {
            const value = this.value(field, f);
            if (!Number.isFinite(value)) { active = false; continue; }
            const p = this.point(f, value);
            if (active) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
            active = true;
        }
        ctx.stroke();
    }

    drawBand(ctx, low, high, color, alpha) {
        ctx.fillStyle = color; ctx.globalAlpha = alpha;
        let run = [];
        const flush = () => {
            if (!run.length) return;
            ctx.beginPath();
            run.forEach((f, i) => { const p = this.point(f, this.value(high, f)); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
            for (let i = run.length - 1; i >= 0; i--) { const p = this.point(run[i], this.value(low, run[i])); ctx.lineTo(p.x, p.y); }
            ctx.closePath(); ctx.fill(); run = [];
        };
        for (let f = 0; f < (Sit.frames ?? 0); f++) {
            if (Number.isFinite(this.value(low, f))) run.push(f); else flush();
        }
        flush(); ctx.globalAlpha = 1;
    }

    drawHistogram(ctx, width, height) {
        const result = this.result;
        if (!result) return;
        const columns = Math.max(1, Math.min(2048, Math.floor(width)));
        const canvas = document.createElement('canvas'); canvas.width = columns; canvas.height = 256;
        const hctx = canvas.getContext('2d');
        const image = hctx.createImageData(columns, 256);
        const palette = [[16, 12, 35], [70, 35, 110], [174, 53, 102], [241, 132, 80], [255, 239, 170]];
        for (let x = 0; x < columns; x++) {
            const bins = new Float64Array(256);
            let count = 0;
            const first = Math.floor(x * Sit.frames / columns), last = Math.max(first + 1, Math.floor((x + 1) * Sit.frames / columns));
            for (let f = first; f < last; f++) {
                const index = displayIndexForFrame(this.currentVideoData(), f);
                const n = result.counts[index];
                if (!n) continue;
                count += n;
                for (let y = 0; y < 256; y++) bins[y] += result.histograms[index * 256 + y];
            }
            for (let y = 0; y < 256; y++) {
                if (!bins[y] || !count) continue;
                const level = Math.max(0, Math.min(1, (Math.log10(bins[y] / count) + 5) / 4)) * 4;
                const a = Math.min(3, Math.floor(level)), fraction = level - a;
                const offset = ((255 - y) * columns + x) * 4;
                for (let c = 0; c < 3; c++) image.data[offset + c] = palette[a][c] * (1 - fraction) + palette[a + 1][c] * fraction;
                image.data[offset + 3] = 255;
            }
        }
        hctx.putImageData(image, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, MARGIN, MARGIN, width, height);
    }

    drawPlot() {
        const width = this.widthPx, height = this.heightPx;
        if (width < 150 || height < 150) return null;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        const c = this.dark ? DARK : LIGHT;
        const w = width - 2 * MARGIN, h = height - 2 * MARGIN;
        ctx.fillStyle = c.bg; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.font = '14px sans-serif';
        ctx.fillText(t('videoTonal.title') + ' — ' + t(this.result?.masked ? 'videoTonal.masked' : 'videoTonal.wholeFrame'), width / 2, 18, width - 20);
        ctx.font = '11px sans-serif';
        const subtitle = {percentiles: 'bandLegend', histogram: 'density',
            contrast: 'contrastLegend', relativeContrast: 'relativeLegend'}[this.options.mode];
        ctx.fillText(this.statusMessage() || t(`videoTonal.${subtitle}`), width / 2, 34, width - 20);
        ctx.save(); ctx.beginPath(); ctx.rect(MARGIN, MARGIN, w, h); ctx.clip();
        if (this.options.mode === 'histogram') this.drawHistogram(ctx, w, h);
        ctx.strokeStyle = c.grid;
        const xStep = this.calculateStep(this.maxX - this.minX, w);
        const yStep = this.calculateStep(this.maxY - this.minY, h);
        for (let x = 0; x <= this.maxX; x += xStep) {
            const p = this.point(x, 0); ctx.beginPath(); ctx.moveTo(p.x, MARGIN); ctx.lineTo(p.x, height - MARGIN); ctx.stroke();
        }
        for (let y = Math.ceil(this.minY / yStep) * yStep; y <= this.maxY; y += yStep) {
            const p = this.point(0, y); ctx.beginPath(); ctx.moveTo(MARGIN, p.y); ctx.lineTo(width - MARGIN, p.y); ctx.stroke();
        }
        if (this.result) {
            if (this.contrastMode()) this.drawLine(ctx, this.options.mode, c.target);
            else {
                if (this.options.mode !== 'histogram') {
                    this.drawBand(ctx, 'p05', 'p95', c.lower, .20);
                    this.drawBand(ctx, 'p25', 'p75', c.lower, .32);
                }
                this.drawLine(ctx, 'p05', c.lower);
                this.drawLine(ctx, 'p95', c.upper);
                this.drawLine(ctx, 'median', c.median);
                if (this.options.showMean) this.drawLine(ctx, 'mean', c.mean);
                if (this.options.showExtremes) {
                    this.drawLine(ctx, 'min', c.grid); this.drawLine(ctx, 'max', c.grid);
                }
                if (this.options.targetAnalysis) {
                    this.drawLine(ctx, 'target', c.target); this.drawLine(ctx, 'local', c.local);
                }
            }
        }
        ctx.restore();
        ctx.strokeStyle = c.grid; ctx.strokeRect(MARGIN, MARGIN, w, h);
        ctx.fillStyle = c.text; ctx.font = '12px sans-serif';
        for (let x = 0; x <= this.maxX; x += xStep) { ctx.textAlign = 'center'; ctx.fillText(String(Math.round(x)), this.point(x, 0).x, height - MARGIN + 20); }
        for (let y = Math.ceil(this.minY / yStep) * yStep; y <= this.maxY; y += yStep) { ctx.textAlign = 'right'; ctx.fillText(String(Math.round(y * 10) / 10), MARGIN - 5, this.point(0, y).y + 4); }
        ctx.textAlign = 'center'; ctx.fillText(this.xLabel, width / 2, height - 9);
        ctx.save(); ctx.translate(16, height / 2); ctx.rotate(-Math.PI / 2);
        const axis = this.contrastMode() ? t(`videoTonal.${this.options.mode}`)
            : this.result?.mode === 'display' ? t('videoTonal.displayGray')
                : this.result?.bits > 8 ? t('videoTonal.scaledLuma', {bits: this.result.bits}) : t('videoTonal.luma');
        ctx.fillText(axis, 0, 0, h + 40); ctx.restore();
        if (this.showLegend && !this.contrastMode()) {
            const legend = [['p05', c.lower], ['median', c.median], ['p95', c.upper]];
            if (this.options.showMean) legend.push(['mean', c.mean]);
            if (this.options.targetAnalysis) legend.push(['target', c.target], ['local', c.local]);
            let x = MARGIN;
            ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
            for (const [key, color] of legend) {
                const label = t(`videoTonal.${key}`), size = ctx.measureText(label).width + 26;
                if (x + size > width - 5) break;
                ctx.fillStyle = color; ctx.fillRect(x, height - 34, 12, 2);
                ctx.fillStyle = c.text; ctx.fillText(label, x + 17, height - 29); x += size;
            }
        }
        return canvas;
    }

    drawCursor() {
        if (!this._plot) return;
        const ctx = this.ctx, c = this.dark ? DARK : LIGHT;
        const f = Math.floor(par.frame), p = this.point(f, 0);
        ctx.strokeStyle = c.cursor; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, MARGIN); ctx.lineTo(p.x, this.heightPx - MARGIN); ctx.stroke();
        const index = displayIndexForFrame(this.currentVideoData(), f);
        const r = this.result;
        const fmt = value => Number.isFinite(value) ? value.toFixed(1) : '—';
        const message = this.contrastMode()
            ? t('videoTonal.targetReadout', {frame: f, target: fmt(r?.target[index]), local: fmt(r?.local[index]), contrast: fmt(r?.contrast[index]), relative: fmt(r?.relativeContrast[index])})
            : t('videoTonal.readout', {frame: f, low: fmt(r?.p05[index]), median: fmt(r?.median[index]), high: fmt(r?.p95[index]),
                span: fmt(r ? r.p95[index] - r.p05[index] : NaN), count: r?.counts[index] ?? 0});
        ctx.fillStyle = c.text; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(message, MARGIN, MARGIN - 8, this.widthPx - MARGIN - 8);
    }

    async exportCSV() {
        const r = this.result;
        if (!r) return;
        const fields = ['count', ...TONAL_FIELDS, 'span', 'targetCount', 'localCount'];
        const rows = [['frame', 'sourceFrame', 'representation', 'sourceBits', 'maskEnabled', ...fields].join(',')];
        for (let f = 0; f < Sit.frames; f++) {
            const i = displayIndexForFrame(this.currentVideoData(), f);
            const values = {count: r.counts[i], targetCount: r.targetCounts[i], localCount: r.localCounts[i], span: r.p95[i] - r.p05[i]};
            for (const field of TONAL_FIELDS) values[field] = r[field][i];
            rows.push([f, i, r.mode === 'luma' ? 'luma_scaled_0_255' : 'display_gray_0_255', r.bits, r.masked,
                ...fields.map(field => Number.isFinite(values[field]) ? values[field] : '')].join(','));
        }
        const {saveAs} = await import('file-saver');
        saveAs(new Blob([rows.join('\n')], {type: 'text/csv;charset=utf-8'}), 'VideoTonalRange.csv');
    }
}

export function createVideoTonalGraphView(id, options) {
    return new CNodeVideoTonalGraphView({id, options, menuName: t('videoTonal.title'),
        visible: true, showLegend: true, left: .25, top: .5, width: .55, height: .43,
        draggable: true, resizable: true, freeAspect: true, shiftDrag: false});
}
