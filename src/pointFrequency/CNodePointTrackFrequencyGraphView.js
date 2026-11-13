import {CNodeCustomGraphView} from '../nodes/CNodeCustomGraphView';
import {CNodeTabbedCanvasView} from '../nodes/CNodeTabbedCanvasView';
import {NodeMan, setRenderOne, Sit} from '../Globals';
import {t} from '../i18n';
import {VideoLoadingManager} from '../CVideoLoadingManager';
import {getObjectTracker} from '../CObjectTracking';
import {abFrameRange} from '../TraverseAnalysisData';
import {displayIndexForFrame, sourceVideoOf} from '../videoQP/VideoQPAnalysis';
import {startTonalAnalysis} from '../videoTonal/VideoTonalAnalysis';
import {clampApertureRadius, clampPeakFloor, FREQUENCY_DEFAULTS, pointFrequencyTargetColor, sharedPointTrackFrequencyMaxY} from '../PointTrackFrequencyGraph';
import {amplitudeSpectrum, captureFrequencyTargets, frequencySampling, searchedMaximum} from './PointFrequencyStatistics';
import {maxOf} from '../SafeArrays';

const MARGIN = 60;
// The side of the square that holds the × of the warning box, and takes its press.
const CLOSE_SIZE = 18;
// alert: the warning about frames with no tracked point, in the red of those frames on the timeline.
const DARK = {bg: '#000', text: '#ddd', grid: '#333', target: pointFrequencyTargetColor(true), background: '#ff86d2', warning: '#ffb84d', alert: '#ff5c5c'};
const LIGHT = {bg: '#fff', text: '#222', grid: '#ddd', target: pointFrequencyTargetColor(false), background: '#ad246e', warning: '#a45a00', alert: '#c2181f'};
const sameTarget = (one, other) => !!one && !!other && one.u === other.u && one.v === other.v && one.rx === other.rx && one.ry === other.ry;

export class CNodePointTrackFrequencyGraphView extends CNodeCustomGraphView {
    constructor(v) {
        super(v);
        this.skipModSerialize = true;
        this.trackId = v.trackId ?? 'track1';
        this.options = {...FREQUENCY_DEFAULTS, ...v.options};
        this.isFrameX = false;
        this.series = [];
        this.menuName = this.graphTitle;
        this.refreshAnalysis();
    }

    modSerialize() { return {...super.modSerialize(), frequencyOptions: {...this.options}}; }
    modDeserialize(state) {
        super.modDeserialize(state);
        this.options = {...FREQUENCY_DEFAULTS, ...state.frequencyOptions};
        this.options.radius = clampApertureRadius(this.options.radius);
        this.options.percent = !!this.options.percent;
        this.options.showBackground = !!this.options.showBackground;
        this.options.perMinute = !!this.options.perMinute;
        this.options.minPeakHz = clampPeakFloor(this.options.minPeakHz);
        this.refreshAnalysis();
    }
    refreshAnalysis() {
        this.job?.cancel(); this.job = null;
        this._inputs = null; this._pollAt = 0;
        this.spectrum = null; this.backgroundSpectrum = null;
        this._plotKey = '';
        setRenderOne();
    }
    // The red box about frames with no tracked point shows until the user
    // closes it with its ×. After that it stays away for as long as In and Out
    // are where they were, also when the track or the radius changes. A change
    // of In or Out is a new selection of frames, so the box shows again.
    untrackedWarningShows(range) {
        const closed = this.warningClosed;
        if (closed && (closed.frame0 !== range.frame0 || closed.frame1 !== range.frame1)) this.warningClosed = null;
        return !this.warningClosed;
    }
    closeUntrackedWarning() {
        const range = this._inputs?.range;
        if (range) this.warningClosed = {frame0: range.frame0, frame1: range.frame1};
        this._plotKey = '';
        setRenderOne();
    }
    // The × of the warning box, in canvas pixels, while the box shows. A press
    // there closes the box; any other press is the graph window's own.
    overWarningClose(e) {
        const close = this._warningClose;
        if (!close) return false;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        return x >= close.x && x <= close.x + close.size && y >= close.y && y <= close.y + close.size;
    }
    onMouseDown(e) {
        if (e.button === 0 && this.overWarningClose(e)) {
            this.closeUntrackedWarning();
            e.stopPropagation(); e.preventDefault();
            return;
        }
        super.onMouseDown(e);
    }
    onMouseMove(e) {
        // Not during a drag of the window that happens to pass over the ×.
        const over = !this.isDragging && this.overWarningClose(e);
        if (over !== !!this._overWarningClose) {
            this._overWarningClose = over;
            this.canvas.style.cursor = over ? 'pointer' : 'default';
        }
        if (!over) super.onMouseMove(e);
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

    // True when In/Out changed and both ends are frames that the finished job
    // measured. Such a change needs no video decode, so ensureAnalysis() does
    // not make it wait for the next poll: the graph follows a drag of the In
    // or Out marker frame by frame.
    regionMovedInsideMeasurement() {
        const input = this._inputs, done = this.job?.result;
        if (!input || !done?.complete || done.error) return false;
        const range = abFrameRange(Sit.frames, 1);
        if (range.frame0 === input.range.frame0 && range.frame1 === input.range.frame1) return false;
        return !!this.job.targets[displayIndexForFrame(input.video, range.frame0)]
            && !!this.job.targets[displayIndexForFrame(input.video, range.frame1)];
    }

    ensureAnalysis() {
        if (!this._pollTimer) this._pollTimer = setTimeout(() => {
            this._pollTimer = null;
            if (this.visible) this.ensureAnalysis();
        }, 500);
        if (performance.now() < this._pollAt && !this.regionMovedInsideMeasurement()) return;
        this._pollAt = performance.now() + 250;
        const video = NodeMan.get('video', false)?.videoData, source = sourceVideoOf(video);
        const tracker = getObjectTracker(this.trackId);
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
            const message = error.unpositioned ? t('pointFrequency.unpositioned', error.unpositioned) : error.message;
            if (this.message !== message) { this.message = message; setRenderOne(); }
            return;
        }
        this.message = '';
        const pixels = enabled ? mask?.maskImageData : null, rotation = source.effectiveRotation ?? 0;
        const trackKey = JSON.stringify([range, plan.targets, sampling.fps, tracker.smoothingFrames, plan.untracked?.indices]);
        const old = this._inputs;
        if (old && old.video === video && old.chunks === source.chunks && old.frames === source.chunks.length
            && old.pixels === pixels && old.rotation === rotation && old.trackKey === trackKey) return;
        const inputs = {video, chunks: source.chunks, frames: source.chunks.length, pixels, rotation, trackKey, range, plan, sampling,
            smoothing: tracker.smoothingFrames || 0};
        // The measurement of a frame does not depend on In/Out. If the finished
        // job holds every frame of the new region, measured at the same place,
        // only the spectrum changes: no video is decoded again. This keeps a
        // render that moves In/Out for each output frame (Render Widening Video) fast.
        const done = this.job?.result;
        if (old && done?.complete && !done.error && old.video === video && old.chunks === source.chunks
            && old.frames === source.chunks.length && old.pixels === pixels && old.rotation === rotation
            && plan.indices.every(i => sameTarget(this.job.targets[i], plan.targets[i]))) {
            this._inputs = inputs;
            this.updateSpectrum();
            return;
        }
        this.refreshAnalysis();
        this._inputs = inputs;
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
            this.job.targets = plan.targets;
        } catch (error) { this.message = t('videoTonal.failed', {reason: error.message}); }
    }

    // Bring the spectrum up to date with the In/Out region now, and wait for
    // it. A render that changes In/Out for each output frame awaits this before
    // it draws the frame; the normal poll would be up to 250 ms late.
    async settleAnalysis() {
        this._pollAt = 0;
        this.ensureAnalysis();
        await this.job?.promise;
    }

    updateSpectrum() {
        this.spectrum = null; this.backgroundSpectrum = null; this.spectrumError = '';
        const result = this.job?.result, input = this._inputs;
        if (result?.complete && !result.error && input) {
            const flux = input.plan.indices.map(i => result.flux[i]);
            if (flux.some(value => !Number.isFinite(value))) this.spectrumError = t('pointFrequency.invalidAperture');
            else {
                const {fps, irregular, times} = input.sampling, peakOptions = {minPeakHz: this.options.minPeakHz};
                this.spectrum = amplitudeSpectrum(flux, fps, irregular ? times : null, peakOptions);
                const area = input.plan.indices.reduce((sum, i) => sum + result.area[i], 0) / flux.length;
                this.backgroundSpectrum = amplitudeSpectrum(input.plan.indices.map(i => result.background[i] * area), fps, irregular ? times : null, peakOptions);
            }
        }
        this._plotKey = '';
        setRenderOne();
    }

    get trackName() { return getObjectTracker(this.trackId)?.trackName ?? ''; }
    get graphTitle() { return this.trackName ? t('pointFrequency.trackTitle', {name: this.trackName}) : t('pointFrequency.title'); }

    get percent() { return this.options.percent && Math.abs(this.spectrum?.mean ?? 0) > 1e-6; }
    get scale() { return this.percent ? 100 / Math.abs(this.spectrum.mean) : 1; }
    statusMessage() {
        const result = this.job?.result;
        if (this.message) return this.message;
        if (result?.error) return t('videoTonal.failed', {reason: result.error});
        if (result && !result.complete) return t('videoTonal.analyzing', {percent: Math.floor(100 * result.done / result.frames)});
        return this.spectrumError || '';
    }
    requiredMaxY() {
        let maximum = 0;
        // The peak-search floor applies to every graph, including its Y range.
        for (const spectrum of [this.spectrum, this.options.showBackground ? this.backgroundSpectrum : null]) {
            if (spectrum) maximum = Math.max(maximum, searchedMaximum(spectrum) * this.scale * 1.1);
        }
        if (maximum < 1e-9) maximum = 1;
        const {height: warningsHeight} = this.warningLayout();
        const h = this.heightPx - 2 * MARGIN;
        if (warningsHeight && h > 0) maximum = Math.max(maximum, maximum / 1.1 / (1 - Math.min(.5, (warningsHeight + 10) / h)));
        return maximum;
    }
    autoScale() {
        this.minX = 0; this.maxX = this.spectrum?.nyquist || 15;
        this.minY = 0; this.maxY = sharedPointTrackFrequencyMaxY(this);
        this.hasY2 = false; this.hasY3 = false;
    }
    point(x, y) { return this.graphToScreenAxis(x, y, this.minY, this.maxY); }
    renderCanvas(frame) {
        if (!this.visible) return;
        this.ensureAnalysis();
        this.menuName = this.graphTitle;
        this.autoScale();
        const key = [this.maxY, this.trackName, this.widthPx, this.heightPx, this.dark, this.job?.result.version, JSON.stringify(this.options), this.statusMessage()].join('|');
        if (key !== this._plotKey) { this._plot = this.drawPlot(); this._plotKey = key; }
        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);
        if (this._plot) this.ctx.drawImage(this._plot, 0, 0);
    }
    wrapText(ctx, text, limit) {
        const lines = []; let line = '';
        for (const word of text.split(/\s+/)) {
            if (line && ctx.measureText(line + ' ' + word).width > limit) { lines.push(line); line = word; }
            else line += (line ? ' ' : '') + word;
        }
        if (line) lines.push(line);
        return lines;
    }
    warningLayout() {
        const ctx = this.ctx;
        if (!ctx || !(this.heightPx >= 180 && this.widthPx >= 180)) return {warnings: [], height: 0};
        const key = [this.widthPx, this.heightPx, this.job?.result.version, this._inputs?.trackKey,
            this.spectrum, JSON.stringify(this.options), this.statusMessage(), !!this.warningClosed];
        if (this._warningLayoutKey?.every((value, i) => value === key[i])) return this._warningLayout;
        const w = this.widthPx - 2 * MARGIN;
        const s = this.spectrum, input = this._inputs, status = this.statusMessage();
        const perMinute = this.options.perMinute, xUnit = perMinute ? 60 : 1;
        const frequencyUnit = t(perMinute ? 'pointFrequency.perMinuteUnit' : 'pointFrequency.hz');
        const frequencyText = hz => (hz * xUnit).toFixed(perMinute ? 1 : 2);
        // Warnings about the samples, at the top of the plot. Frames with no
        // tracked point come first, in a box in the red that those frames have on
        // the timeline and on the trail: their samples are measured at a position
        // that is a guess, and nothing else on the graph shows that.
        const warnings = [];
        if (!status && s && input.plan.untracked && this.untrackedWarningShows(input.range)) {
            const untracked = input.plan.untracked, radius = this.options.radius;
            warnings.push({alert: true, text: t('pointFrequency.interpolated', untracked) + ' '
                + (untracked.trial !== null ? t('pointFrequency.interpolatedTrial', {error: untracked.trial.toFixed(1), radius})
                    : t('pointFrequency.interpolatedMove', {move: untracked.move.toFixed(1), radius}))});
        }
        if (!status && s && input.sampling.irregular) {
            const {minFps, maxFps} = input.sampling;
            warnings.push({text: t('pointFrequency.irregularTiming', {min: minFps.toFixed(2), max: maxFps.toFixed(2),
                limit: frequencyText(minFps / 2), frequencyUnit})});
        }
        if (!status && s) {
            const fractions = input.plan.indices.map(i => this.job.result.clippedFraction[i]).filter(fraction => fraction > 0);
            if (fractions.length) warnings.push({text: t('pointFrequency.clipped', {frames: fractions.length, total: input.plan.indices.length,
                max: (100 * maxOf(fractions)).toFixed(0)})});
        }
        let warningsHeight = 0;
        for (const warning of warnings) {
            ctx.font = warning.alert ? 'bold 12px sans-serif' : '11px sans-serif';
            // The box keeps its top right corner free for the ×.
            warning.lines = this.wrapText(ctx, warning.text, w - 36 - (warning.alert ? 2 * CLOSE_SIZE : 0));
            warning.step = warning.alert ? 16 : 14;
            warning.height = warning.lines.length * warning.step + (warning.alert ? 10 : 2);
            warningsHeight += warning.height + 4;
        }
        this._warningLayoutKey = key;
        return this._warningLayout = {warnings, height: warningsHeight};
    }
    drawPlot() {
        const width = this.widthPx, height = this.heightPx;
        if (width < 180 || height < 180) return null;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'), c = this.dark ? DARK : LIGHT;
        const w = width - 2 * MARGIN, h = height - 2 * MARGIN;
        ctx.fillStyle = c.bg; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.font = '14px sans-serif';
        ctx.fillText(this.graphTitle, width / 2, 18, width - 20);
        ctx.font = '11px sans-serif';
        const s = this.spectrum, input = this._inputs;
        const status = this.statusMessage();
        // Flashes per minute relabel the same axis: frequencies stay in Hz, only
        // the printed values and units change.
        const perMinute = this.options.perMinute, xUnit = perMinute ? 60 : 1;
        const frequencyUnit = t(perMinute ? 'pointFrequency.perMinuteUnit' : 'pointFrequency.hz');
        const frequencyText = hz => (hz * xUnit).toFixed(perMinute ? 1 : 2);
        ctx.fillText(status ? t('pointFrequency.unavailable') : (s ? t('pointFrequency.window', {a: input.range.frame0, b: input.range.frame1,
            count: s.count, duration: s.duration.toFixed(2), fps: s.fps.toFixed(3), resolution: (s.binSpacing * xUnit).toPrecision(3),
            frequencyUnit}) : ''), width / 2, 34, width - 20);
        // The peak search floor is stored in Hz and printed in the chosen unit.
        const peak = s?.peak, floor = s?.peakFloor ?? 0;
        let peakText = '';
        if (!status && s) {
            if (s.peakFloorAboveNyquist) peakText = t('pointFrequency.floorAboveNyquist', {floor: frequencyText(floor), nyquist: frequencyText(s.nyquist), frequencyUnit});
            else if (peak) peakText = t(floor > 0 ? 'pointFrequency.peakAboveFloor' : 'pointFrequency.peak', {floor: frequencyText(floor),
                frequency: frequencyText(peak.frequency), frequencyUnit, amplitude: (peak.amplitude * this.scale).toFixed(2), unit: this.percent ? '%' : 'DN·px'});
            else peakText = t('pointFrequency.flat');
        }
        ctx.fillText(peakText, width / 2, 49, width - 20);
        this._warningClose = null;
        const {warnings} = this.warningLayout();
        ctx.font = '11px sans-serif';
        const xs = this.calculateStep(this.maxX * xUnit, w) / xUnit, ys = this.calculateStep(this.maxY, h);
        ctx.save(); ctx.beginPath(); ctx.rect(MARGIN, MARGIN, w, h); ctx.clip(); ctx.strokeStyle = c.grid;
        for (let x = 0; x <= this.maxX; x += xs) { const p = this.point(x, 0); ctx.beginPath(); ctx.moveTo(p.x, MARGIN); ctx.lineTo(p.x, height - MARGIN); ctx.stroke(); }
        for (let y = 0; y <= this.maxY; y += ys) { const p = this.point(0, y); ctx.beginPath(); ctx.moveTo(MARGIN, p.y); ctx.lineTo(width - MARGIN, p.y); ctx.stroke(); }
        // In the text color at half strength: in the grid color it vanishes on a grid line.
        if (!status && s && floor > 0) {
            const p = this.point(floor, 0);
            ctx.save(); ctx.strokeStyle = c.text; ctx.globalAlpha = .5; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(p.x, MARGIN); ctx.lineTo(p.x, height - MARGIN); ctx.stroke(); ctx.restore();
        }
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
        let warningY = MARGIN + 6;
        ctx.textAlign = 'center';
        for (const {alert, lines, step, height: boxHeight} of warnings) {
            ctx.font = alert ? 'bold 12px sans-serif' : '11px sans-serif';
            if (alert) {
                // The background color first, so that a curve behind the text does not make it hard to read.
                ctx.globalAlpha = .7; ctx.fillStyle = c.bg; ctx.fillRect(MARGIN + 8, warningY, w - 16, boxHeight);
                ctx.globalAlpha = .22; ctx.fillStyle = c.alert; ctx.fillRect(MARGIN + 8, warningY, w - 16, boxHeight);
                ctx.globalAlpha = 1; ctx.strokeStyle = c.alert; ctx.lineWidth = 1.5; ctx.strokeRect(MARGIN + 8, warningY, w - 16, boxHeight);
                // The ×: two strokes in a square at the top right corner. onMouseDown tests the same square.
                const close = this._warningClose = {x: MARGIN + w - 8 - CLOSE_SIZE - 3, y: warningY + 3, size: CLOSE_SIZE};
                ctx.beginPath();
                ctx.moveTo(close.x + 5, close.y + 5); ctx.lineTo(close.x + close.size - 5, close.y + close.size - 5);
                ctx.moveTo(close.x + close.size - 5, close.y + 5); ctx.lineTo(close.x + 5, close.y + close.size - 5);
                ctx.lineWidth = 2; ctx.stroke();
            }
            ctx.fillStyle = alert ? c.alert : c.warning;
            lines.forEach((line, n) => ctx.fillText(line, width / 2, warningY + (alert ? 5 : 0) + step * (n + 1) - 4));
            warningY += boxHeight + 4;
        }
        ctx.lineWidth = 1;
        if (status) {
            ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
            const lines = this.wrapText(ctx, status, w - 20);
            ctx.fillStyle = c.bg; ctx.fillRect(MARGIN + 5, height / 2 - 15, w - 10, lines.length * 18 + 8);
            ctx.fillStyle = c.text;
            lines.forEach((text, i) => ctx.fillText(text, width / 2, height / 2 + i * 18));
        }
        ctx.fillStyle = c.text; ctx.font = '12px sans-serif';
        for (let x = 0; x <= this.maxX; x += xs) { ctx.textAlign = 'center'; ctx.fillText(Number((x * xUnit).toFixed(3)).toString(), this.point(x, 0).x, height - MARGIN + 17); }
        for (let y = 0; y <= this.maxY; y += ys) { ctx.textAlign = 'right'; ctx.fillText(Number(y.toPrecision(3)).toString(), MARGIN - 5, this.point(0, y).y + 4); }
        ctx.textAlign = 'center'; ctx.fillText(t(perMinute ? 'pointFrequency.xLabelPerMinute' : 'pointFrequency.xLabel'), width / 2, height - 5);
        ctx.save(); ctx.translate(15, height / 2); ctx.rotate(-Math.PI / 2);
        ctx.fillText(t(this.percent ? 'pointFrequency.yPercent' : 'pointFrequency.yFlux'), 0, 0, h + 30); ctx.restore();
        if (!status && s) {
            ctx.font = '10px sans-serif';
            ctx.fillStyle = c.target; ctx.fillText(t('pointFrequency.targetLegend') + (this.options.showBackground ? '  ·  ' : ''), width / 2 - (this.options.showBackground ? 65 : 0), height - 37, w);
            if (this.options.showBackground) { ctx.fillStyle = c.background; ctx.fillText(t('pointFrequency.backgroundLegend'), width / 2 + 95, height - 37, w / 2); }
            ctx.fillStyle = c.text;
            ctx.fillText(t('pointFrequency.method', {radius: this.options.radius, smoothing: input.smoothing}), width / 2, height - 23, width - 12);
        }
        return canvas;
    }

    async exportCSV() {
        const s = this.spectrum, input = this._inputs, result = this.job?.result;
        if (!s || !input || !result) return;
        const rows = ['frequency_hz,object_semi_amplitude_dn_px,background_semi_amplitude_dn_px,object_semi_amplitude_percent'];
        s.frequencies.forEach((f, i) => rows.push([f, s.amplitude[i], this.backgroundSpectrum.amplitude[i],
            Math.abs(s.mean) > 1e-6 ? s.amplitude[i] * 100 / Math.abs(s.mean) : ''].join(',')));
        // The frames that were measured at a position that was not tracked.
        const interpolated = new Set(input.plan.untracked?.indices);
        rows.push('', 'scene_in,scene_out,samples,fps,duration_s,bin_spacing_hz,nyquist_hz,radius_px,position_smoothing_frames,mean_signed_flux_dn_px,representation,source_bits,mask_enabled,irregular_timing,min_fps,max_fps,peak_floor_hz,interpolated_frames',
            [input.range.frame0, input.range.frame1, s.count, s.fps, s.duration, s.binSpacing, s.nyquist, this.options.radius,
                input.smoothing, s.mean, result.mode, result.bits, result.masked,
                input.sampling.irregular, input.sampling.minFps, input.sampling.maxFps, s.peakFloor, interpolated.size].join(','), '',
            'source_frame,time_s,x_original_px,y_original_px,signed_flux_dn_px,local_background_dn,aperture_area_px,clipped_fraction,position');
        input.plan.indices.forEach((i, n) => {
            const target = input.plan.targets[i], video = input.video;
            rows.push([i, input.sampling.times[n], target.u * (video.originalVideoWidth || video.videoWidth),
                target.v * (video.originalVideoHeight || video.videoHeight), result.flux[i], result.background[i], result.area[i], result.clippedFraction[i],
                interpolated.has(i) ? 'interpolated' : 'tracked'].join(','));
        });
        const {saveAs} = await import('file-saver');
        saveAs(new Blob([rows.join('\n')], {type: 'text/csv;charset=utf-8'}), `PointTrackFrequency-${this.trackName.replace(/[^a-zA-Z0-9_-]+/g, '_') || this.trackId}.csv`);
    }
}

export function createPointTrackFrequencyGraphView(id, options, trackId) {
    const offset = ((Number(trackId?.replace(/^track/, '')) || 1) - 1) % 6 * .035;
    return new CNodePointTrackFrequencyGraphView({id, options, trackId, menuName: t('pointFrequency.title'),
        visible: true, alwaysOnTop: true, left: .23 + offset, top: .28 + offset, width: .62, height: .46,
        draggable: true, resizable: true, freeAspect: true, shiftDrag: false});
}
