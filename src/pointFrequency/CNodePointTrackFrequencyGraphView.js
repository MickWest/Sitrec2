import {CNodeCustomGraphView} from '../nodes/CNodeCustomGraphView';
import {CNodeTabbedCanvasView} from '../nodes/CNodeTabbedCanvasView';
import {NodeMan, setRenderOne, Sit} from '../Globals';
import {t} from '../i18n';
import {VideoLoadingManager} from '../CVideoLoadingManager';
import {getObjectTracker} from '../CObjectTracking';
import {abFrameRange} from '../TraverseAnalysisData';
import {displayIndexForFrame, sourceVideoOf} from '../videoQP/VideoQPAnalysis';
import {startTonalAnalysis} from '../videoTonal/VideoTonalAnalysis';
import {clampApertureRadius, FREQUENCY_DEFAULTS, pointFrequencyTargetColor} from '../PointTrackFrequencyGraph';
import {amplitudeSpectrum, captureFrequencyTargets, frequencySampling} from './PointFrequencyStatistics';

const MARGIN = 60;
const DARK = {bg: '#000', text: '#ddd', grid: '#333', target: pointFrequencyTargetColor(true), background: '#ff86d2'};
const LIGHT = {bg: '#fff', text: '#222', grid: '#ddd', target: pointFrequencyTargetColor(false), background: '#ad246e'};

export class CNodePointTrackFrequencyGraphView extends CNodeCustomGraphView {
    constructor(v) {
        super(v);
        this.skipModSerialize = true;
        this.options = {...FREQUENCY_DEFAULTS, ...v.options};
        this.isFrameX = false;
        this.series = [];
        this.refreshAnalysis();
    }

    modSerialize() { return {...super.modSerialize(), frequencyOptions: {...this.options}}; }
    modDeserialize(state) {
        super.modDeserialize(state);
        this.options = {...FREQUENCY_DEFAULTS, ...state.frequencyOptions};
        this.options.radius = clampApertureRadius(this.options.radius);
        this.options.percent = !!this.options.percent;
        this.options.showBackground = !!this.options.showBackground;
        this.refreshAnalysis();
    }
    refreshAnalysis() {
        this.job?.cancel(); this.job = null;
        this._inputs = null; this._pollAt = 0;
        this.spectrum = null; this.backgroundSpectrum = null;
        this._plotKey = '';
        setRenderOne();
    }
    dispose() {
        clearTimeout(this._pollTimer);
        this.job?.cancel(); this.job = null; this._plot = null;
        super.dispose();
    }
    show(visible) {
        super.show(visible);
        if (!visible) {
            clearTimeout(this._pollTimer); this._pollTimer = null;
            if (this.job && !this.job.result.complete) this.refreshAnalysis();
        }
    }

    ensureAnalysis() {
        if (!this._pollTimer) this._pollTimer = setTimeout(() => {
            this._pollTimer = null;
            if (this.visible) this.ensureAnalysis();
        }, 500);
        if (performance.now() < this._pollAt) return;
        this._pollAt = performance.now() + 250;
        const video = NodeMan.get('video', false)?.videoData, source = sourceVideoOf(video);
        const tracker = getObjectTracker();
        const mask = NodeMan.get('videoMask', false) ?? NodeMan.get('motionMaskOverlay', false);
        mask?.ensureMaskInitialized();
        const enabled = mask?.maskEnabled !== false;
        let plan, sampling, range;
        try {
            if (!source) throw new Error(t('videoTonal.noVideo'));
            if (source._loadingId && VideoLoadingManager.isLoading(source._loadingId)) throw new Error(t('videoTonal.loading'));
            if (!source.chunks?.length || !source.config) throw new Error(t('videoTonal.noFrames'));
            if (enabled && mask?.maskData && !mask.maskImageData) throw new Error(t('videoTonal.loadingMask'));
            if (tracker?.videoView?.videoData !== video || !tracker.trackedPositions?.size) throw new Error(t('pointFrequency.noTrack'));
            range = abFrameRange(Sit.frames, 1);
            plan = captureFrequencyTargets({...range, positions: tracker.getOutputPositions(), rawPositions: tracker.trackedPositions,
                width: video.originalVideoWidth || video.videoWidth, height: video.originalVideoHeight || video.videoHeight,
                radius: this.options.radius, displayIndex: frame => displayIndexForFrame(video, frame)});
            sampling = frequencySampling(source, plan.indices);
        } catch (error) {
            if (this.job) this.refreshAnalysis();
            if (this.message !== error.message) { this.message = error.message; setRenderOne(); }
            return;
        }
        this.message = '';
        const pixels = enabled ? mask?.maskImageData : null, rotation = source.effectiveRotation ?? 0;
        const trackKey = JSON.stringify([range, plan.targets, sampling.fps, tracker.smoothingFrames]);
        const old = this._inputs;
        if (old && old.video === video && old.chunks === source.chunks && old.frames === source.chunks.length
            && old.pixels === pixels && old.rotation === rotation && old.trackKey === trackKey) return;
        this.refreshAnalysis();
        this._inputs = {video, chunks: source.chunks, frames: source.chunks.length, pixels, rotation, trackKey, range, plan, sampling,
            smoothing: tracker.smoothingFrames || 0};
        let snapshot = null;
        if (pixels) {
            const alpha = new Uint8Array(pixels.width * pixels.height);
            for (let i = 0; i < alpha.length; i++) alpha[i] = pixels.data[i * 4 + 3];
            snapshot = {width: pixels.width, height: pixels.height, alpha};
        }
        try {
            let lastPaint = 0;
            this.job = startTonalAnalysis(video, {pointFrequency: true, first: plan.indices[0], last: plan.indices.at(-1),
                targets: plan.targets, rotation, mask: snapshot}, result => {
                if (result.complete) this.updateSpectrum();
                if (result.complete || performance.now() - lastPaint > 150) { lastPaint = performance.now(); setRenderOne(); }
            });
        } catch (error) { this.message = t('videoTonal.failed', {reason: error.message}); }
    }

    updateSpectrum() {
        this.spectrum = null; this.backgroundSpectrum = null; this.spectrumError = '';
        const result = this.job?.result, input = this._inputs;
        if (result?.complete && !result.error && input) {
            const flux = input.plan.indices.map(i => result.flux[i]);
            if (flux.some(value => !Number.isFinite(value))) this.spectrumError = t('pointFrequency.invalidAperture');
            else {
                this.spectrum = amplitudeSpectrum(flux, input.sampling.fps);
                const area = input.plan.indices.reduce((sum, i) => sum + result.area[i], 0) / flux.length;
                this.backgroundSpectrum = amplitudeSpectrum(input.plan.indices.map(i => result.background[i] * area), input.sampling.fps);
            }
        }
        this._plotKey = '';
        setRenderOne();
    }

    get percent() { return this.options.percent && Math.abs(this.spectrum?.mean ?? 0) > 1e-6; }
    get scale() { return this.percent ? 100 / Math.abs(this.spectrum.mean) : 1; }
    statusMessage() {
        const result = this.job?.result;
        if (this.message) return this.message;
        if (result?.error) return t('videoTonal.failed', {reason: result.error});
        if (result && !result.complete) return t('videoTonal.analyzing', {percent: Math.floor(100 * result.done / result.frames)});
        return this.spectrumError || '';
    }
    autoScale() {
        this.minX = 0; this.maxX = this.spectrum?.nyquist || 15;
        this.minY = 0; this.maxY = 0;
        for (const spectrum of [this.spectrum, this.options.showBackground ? this.backgroundSpectrum : null]) {
            if (spectrum) for (const value of spectrum.amplitude) this.maxY = Math.max(this.maxY, value * this.scale * 1.1);
        }
        if (this.maxY < 1e-9) this.maxY = 1;
        this.hasY2 = false; this.hasY3 = false;
    }
    point(x, y) { return this.graphToScreenAxis(x, y, this.minY, this.maxY); }
    renderCanvas(frame) {
        if (!this.visible) return;
        this.ensureAnalysis();
        const key = [this.widthPx, this.heightPx, this.dark, this.job?.result.version, JSON.stringify(this.options), this.statusMessage()].join('|');
        if (key !== this._plotKey) { this.autoScale(); this._plot = this.drawPlot(); this._plotKey = key; }
        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);
        if (this._plot) this.ctx.drawImage(this._plot, 0, 0);
    }
    drawPlot() {
        const width = this.widthPx, height = this.heightPx;
        if (width < 180 || height < 180) return null;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'), c = this.dark ? DARK : LIGHT;
        const w = width - 2 * MARGIN, h = height - 2 * MARGIN;
        ctx.fillStyle = c.bg; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.font = '14px sans-serif';
        ctx.fillText(t('pointFrequency.title'), width / 2, 18, width - 20);
        ctx.font = '11px sans-serif';
        const s = this.spectrum, input = this._inputs;
        const status = this.statusMessage();
        ctx.fillText(status ? t('pointFrequency.unavailable') : (s ? t('pointFrequency.window', {a: input.range.frame0, b: input.range.frame1,
            count: s.count, duration: s.duration.toFixed(2), fps: s.fps.toFixed(3), resolution: s.binSpacing.toPrecision(3)}) : ''), width / 2, 34, width - 20);
        const peak = s?.peak;
        ctx.fillText(!status && s ? (peak ? t('pointFrequency.peak', {frequency: peak.frequency.toFixed(2),
            amplitude: (peak.amplitude * this.scale).toFixed(2), unit: this.percent ? '%' : 'DN·px'}) : t('pointFrequency.flat')) : '', width / 2, 49, width - 20);
        const xs = this.calculateStep(this.maxX, w), ys = this.calculateStep(this.maxY, h);
        ctx.save(); ctx.beginPath(); ctx.rect(MARGIN, MARGIN, w, h); ctx.clip(); ctx.strokeStyle = c.grid;
        for (let x = 0; x <= this.maxX; x += xs) { const p = this.point(x, 0); ctx.beginPath(); ctx.moveTo(p.x, MARGIN); ctx.lineTo(p.x, height - MARGIN); ctx.stroke(); }
        for (let y = 0; y <= this.maxY; y += ys) { const p = this.point(0, y); ctx.beginPath(); ctx.moveTo(MARGIN, p.y); ctx.lineTo(width - MARGIN, p.y); ctx.stroke(); }
        for (const [spectrum, color] of [[this.spectrum, c.target], [this.options.showBackground ? this.backgroundSpectrum : null, c.background]]) {
            if (!spectrum) continue;
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
            spectrum.frequencies.forEach((frequency, i) => {
                const p = this.point(frequency, spectrum.amplitude[i] * this.scale);
                if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
            });
            ctx.stroke();
        }
        ctx.restore(); ctx.strokeStyle = c.grid; ctx.strokeRect(MARGIN, MARGIN, w, h);
        if (status) {
            const lines = []; let line = '';
            ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
            for (const word of status.split(/\s+/)) {
                if (line && ctx.measureText(line + ' ' + word).width > w - 20) { lines.push(line); line = word; }
                else line += (line ? ' ' : '') + word;
            }
            if (line) lines.push(line);
            ctx.fillStyle = c.bg; ctx.fillRect(MARGIN + 5, height / 2 - 15, w - 10, lines.length * 18 + 8);
            ctx.fillStyle = c.text;
            lines.forEach((text, i) => ctx.fillText(text, width / 2, height / 2 + i * 18));
        }
        ctx.fillStyle = c.text; ctx.font = '12px sans-serif';
        for (let x = 0; x <= this.maxX; x += xs) { ctx.textAlign = 'center'; ctx.fillText(Number(x.toFixed(3)).toString(), this.point(x, 0).x, height - MARGIN + 17); }
        for (let y = 0; y <= this.maxY; y += ys) { ctx.textAlign = 'right'; ctx.fillText(Number(y.toPrecision(3)).toString(), MARGIN - 5, this.point(0, y).y + 4); }
        ctx.textAlign = 'center'; ctx.fillText(t('pointFrequency.xLabel'), width / 2, height - 5);
        ctx.save(); ctx.translate(15, height / 2); ctx.rotate(-Math.PI / 2);
        ctx.fillText(t(this.percent ? 'pointFrequency.yPercent' : 'pointFrequency.yFlux'), 0, 0, h + 30); ctx.restore();
        if (!status && s) {
            ctx.font = '10px sans-serif';
            ctx.fillStyle = c.target; ctx.fillText(t('pointFrequency.targetLegend') + (this.options.showBackground ? '  ·  ' : ''), width / 2 - (this.options.showBackground ? 65 : 0), height - 37, w);
            if (this.options.showBackground) { ctx.fillStyle = c.background; ctx.fillText(t('pointFrequency.backgroundLegend'), width / 2 + 95, height - 37, w / 2); }
            ctx.fillStyle = c.text;
            const clipped = input.plan.indices.some(i => this.job.result.clippedFraction[i] > 0);
            ctx.fillText(t(clipped ? 'pointFrequency.clipped' : 'pointFrequency.method', {radius: this.options.radius, smoothing: input.smoothing}), width / 2, height - 23, width - 12);
        }
        return canvas;
    }

    async exportCSV() {
        const s = this.spectrum, input = this._inputs, result = this.job?.result;
        if (!s || !input || !result) return;
        const rows = ['frequency_hz,object_semi_amplitude_dn_px,background_semi_amplitude_dn_px,object_semi_amplitude_percent'];
        s.frequencies.forEach((f, i) => rows.push([f, s.amplitude[i], this.backgroundSpectrum.amplitude[i],
            Math.abs(s.mean) > 1e-6 ? s.amplitude[i] * 100 / Math.abs(s.mean) : ''].join(',')));
        rows.push('', 'scene_in,scene_out,samples,fps,duration_s,bin_spacing_hz,nyquist_hz,radius_px,position_smoothing_frames,mean_signed_flux_dn_px,representation,source_bits,mask_enabled',
            [input.range.frame0, input.range.frame1, s.count, s.fps, s.duration, s.binSpacing, s.nyquist, this.options.radius,
                input.smoothing, s.mean, result.mode, result.bits, result.masked].join(','), '',
            'source_frame,time_s,x_original_px,y_original_px,signed_flux_dn_px,local_background_dn,aperture_area_px,clipped_fraction');
        input.plan.indices.forEach((i, n) => {
            const target = input.plan.targets[i], video = input.video;
            rows.push([i, input.sampling.times[n], target.u * (video.originalVideoWidth || video.videoWidth),
                target.v * (video.originalVideoHeight || video.videoHeight), result.flux[i], result.background[i], result.area[i], result.clippedFraction[i]].join(','));
        });
        const {saveAs} = await import('file-saver');
        saveAs(new Blob([rows.join('\n')], {type: 'text/csv;charset=utf-8'}), 'PointTrackFrequency.csv');
    }
}

export function createPointTrackFrequencyGraphView(id, options) {
    return new CNodePointTrackFrequencyGraphView({id, options, menuName: t('pointFrequency.title'),
        visible: true, alwaysOnTop: true, left: .23, top: .48, width: .62, height: .46,
        draggable: true, resizable: true, freeAspect: true, shiftDrag: false});
}
