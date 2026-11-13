import {CNodeCustomGraphView} from '../nodes/CNodeCustomGraphView';
import {CNodeTabbedCanvasView} from '../nodes/CNodeTabbedCanvasView';
import {NodeMan, setRenderOne, Sit} from '../Globals';
import {t} from '../i18n';
import {VideoLoadingManager} from '../CVideoLoadingManager';
import {getObjectTracker} from '../CObjectTracking';
import {pointTracks} from '../PointTrackRegistry';
import {abFrameRange} from '../TraverseAnalysisData';
import {displayIndexForFrame, sourceVideoOf} from '../videoQP/VideoQPAnalysis';
import {startTonalAnalysis} from '../videoTonal/VideoTonalAnalysis';
import {clampApertureRadius, clampPeakFloor, FREQUENCY_DEFAULTS, pointFrequencyTargetColor, sharedPointTrackFrequencyMaxY} from '../PointTrackFrequencyGraph';
import {amplitudeSpectrum, captureFrequencyTargets, frequencySampling, searchedMaximum} from './PointFrequencyStatistics';
import {maxOf} from '../SafeArrays';

const MARGIN = 60;
// The side of the square that holds the × of the warning box, and takes its press.
const CLOSE_SIZE = 18;
// The height of one row of the list of tracks on the single graph.
const ROW = 14;
// alert: the warning about frames with no tracked point, in the red of those frames on the timeline.
// singleBackground: the local background line of the single graph, a grey that no track color is near.
const DARK = {bg: '#000', text: '#ddd', grid: '#333', target: pointFrequencyTargetColor(true), background: '#ff86d2', singleBackground: '#c8c8c8', warning: '#ffb84d', alert: '#ff5c5c'};
const LIGHT = {bg: '#fff', text: '#222', grid: '#ddd', target: pointFrequencyTargetColor(false), background: '#ad246e', singleBackground: '#8c8c8c', warning: '#a45a00', alert: '#c2181f'};
const sameTarget = (one, other) => !!one && !!other && one.u === other.u && one.v === other.v && one.rx === other.rx && one.ry === other.ry;
const trackIndex = id => {
    const index = pointTracks.findIndex(track => track.trackId === id);
    return index < 0 ? Infinity : index;
};
// The track colors are pastels made for the dark video. On a light background
// each channel is reduced, as LIGHT.target is a darker green than DARK.target.
function darken(color) {
    const match = /^#([0-9a-f]{6})$/i.exec(color ?? '');
    if (!match) return color;
    const value = parseInt(match[1], 16);
    const channel = shift => Math.round(((value >> shift) & 255) * .55).toString(16).padStart(2, '0');
    return `#${channel(16)}${channel(8)}${channel(0)}`;
}

// One track's measurement: the job that decodes the video and measures the
// aperture on each frame, the inputs it was started for, and the spectra it
// gave. A graph window has one for each track it draws.
class TrackAnalysis {
    constructor(view, trackId, radius) {
        this.view = view;
        this.trackId = trackId;
        this.radius = radius;
        this.message = '';
        this.reset();
    }
    reset() {
        this.job?.cancel(); this.job = null;
        this.inputs = null; this.pollAt = 0;
        this.spectrum = null; this.backgroundSpectrum = null; this.spectrumError = '';
    }
    // Drop the measurement and redraw: the next poll starts it again.
    restart() { this.reset(); this.view.spectrumChanged(); }
    get tracker() { return getObjectTracker(this.trackId); }
    get trackName() { return this.tracker?.trackName ?? ''; }
    get result() { return this.job?.result; }
    statusMessage() {
        const result = this.result;
        if (this.message) return this.message;
        if (result?.error) return t('videoTonal.failed', {reason: result.error});
        if (result && !result.complete) return t('videoTonal.analyzing', {percent: Math.floor(100 * result.done / result.frames)});
        return this.spectrumError || '';
    }

    // True when In/Out changed and both ends are frames that the finished job
    // measured. Such a change needs no video decode, so the poll does not make
    // it wait for the next poll: the graph follows a drag of the In or Out
    // marker frame by frame.
    regionMovedInsideMeasurement() {
        const input = this.inputs, done = this.result;
        if (!input || !done?.complete || done.error) return false;
        const range = abFrameRange(Sit.frames, 1);
        if (range.frame0 === input.range.frame0 && range.frame1 === input.range.frame1) return false;
        return !!this.job.targets[displayIndexForFrame(input.video, range.frame0)]
            && !!this.job.targets[displayIndexForFrame(input.video, range.frame1)];
    }

    // Start or continue the measurement for the scene that the window read
    // (video, source frames, mask). scene.error is the message when there is
    // nothing to measure yet.
    ensure({video, source, error, pixels, rotation}) {
        const tracker = this.tracker;
        let plan, sampling, range;
        try {
            if (error) throw new Error(error);
            if (tracker?.videoView?.videoData !== video || !tracker.trackedPositions?.size) throw new Error(t('pointFrequency.noTrack'));
            range = abFrameRange(Sit.frames, 1);
            plan = captureFrequencyTargets({...range, positions: tracker.getOutputPositions(), rawPositions: tracker.trackedPositions,
                width: video.originalVideoWidth || video.videoWidth, height: video.originalVideoHeight || video.videoHeight,
                radius: this.radius, displayIndex: frame => displayIndexForFrame(video, frame)});
            sampling = frequencySampling(source, plan.indices);
        } catch (problem) {
            if (this.job) this.restart();
            const message = problem.unpositioned ? t('pointFrequency.unpositioned', problem.unpositioned) : problem.message;
            if (this.message !== message) { this.message = message; setRenderOne(); }
            return;
        }
        this.message = '';
        const trackKey = JSON.stringify([range, plan.targets, sampling.fps, tracker.smoothingFrames, plan.untracked?.indices]);
        const old = this.inputs;
        const sameScene = !!old && old.video === video && old.chunks === source.chunks && old.frames === source.chunks.length
            && old.pixels === pixels && old.rotation === rotation;
        if (sameScene && old.trackKey === trackKey) return;
        const inputs = {video, chunks: source.chunks, frames: source.chunks.length, pixels, rotation, trackKey, range, plan, sampling,
            smoothing: tracker.smoothingFrames || 0};
        // The measurement of a frame does not depend on In/Out. If the finished
        // job holds every frame of the new region, measured at the same place,
        // only the spectrum changes: no video is decoded again. This keeps a
        // render that moves In/Out for each output frame (Render Widening Video) fast.
        const done = this.result;
        if (sameScene && done?.complete && !done.error && plan.indices.every(i => sameTarget(this.job.targets[i], plan.targets[i]))) {
            this.inputs = inputs;
            this.updateSpectrum();
            return;
        }
        this.restart();
        this.inputs = inputs;
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
        } catch (problem) { this.message = t('videoTonal.failed', {reason: problem.message}); }
    }

    updateSpectrum() {
        this.spectrum = null; this.backgroundSpectrum = null; this.spectrumError = '';
        const result = this.result, input = this.inputs;
        if (result?.complete && !result.error && input) {
            const flux = input.plan.indices.map(i => result.flux[i]);
            if (flux.some(value => !Number.isFinite(value))) this.spectrumError = t('pointFrequency.invalidAperture');
            else {
                const {fps, irregular, times} = input.sampling, peakOptions = {minPeakHz: this.view.options.minPeakHz};
                this.spectrum = amplitudeSpectrum(flux, fps, irregular ? times : null, peakOptions);
                const area = input.plan.indices.reduce((sum, i) => sum + result.area[i], 0) / flux.length;
                this.backgroundSpectrum = amplitudeSpectrum(input.plan.indices.map(i => result.background[i] * area), fps, irregular ? times : null, peakOptions);
            }
        }
        this.view.spectrumChanged();
    }
}

export class CNodePointTrackFrequencyGraphView extends CNodeCustomGraphView {
    constructor(v) {
        super(v);
        this.skipModSerialize = true;
        // null: the single graph, with a line for each track that setTracks gives it.
        this.trackId = v.trackId === undefined ? 'track1' : v.trackId;
        this.options = {...FREQUENCY_DEFAULTS, ...v.options};
        this.analyses = [];
        this.isFrameX = false;
        this.series = [];
        if (this.trackId !== null) this.setTracks([this.trackId]);
        this.menuName = this.graphTitle;
        this.refreshAnalysis();
    }
    get single() { return this.trackId === null; }
    get trackIds() { return this.analyses.map(analysis => analysis.trackId); }
    // The first track's measurement, the only one of a track's own window.
    get analysis() { return this.analyses[0]; }
    analysisFor(trackId) { return this.analyses.find(analysis => analysis.trackId === trackId) ?? null; }
    // The tracks to draw, in Track List order. A track that stays keeps its measurement.
    setTracks(ids) {
        const kept = new Set(ids);
        for (const analysis of this.analyses) if (!kept.has(analysis.trackId)) analysis.reset();
        this.analyses = [...kept].map(id => this.analysisFor(id) ?? new TrackAnalysis(this, id, this.options.radius))
            .sort((a, b) => trackIndex(a.trackId) - trackIndex(b.trackId));
        this.spectrumChanged();
    }
    setTrackRadius(trackId, radius) {
        const analysis = this.analysisFor(trackId);
        if (!analysis || analysis.radius === radius) return;
        analysis.radius = radius;
        analysis.restart();
    }
    spectrumChanged() { this._plotKey = ''; setRenderOne(); }

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
        for (const analysis of this.analyses) analysis.reset();
        this.spectrumChanged();
    }
    updateSpectrum() { for (const analysis of this.analyses) analysis.updateSpectrum(); }
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
        const range = this.analyses.find(analysis => analysis.inputs)?.inputs.range;
        if (range) this.warningClosed = {frame0: range.frame0, frame1: range.frame1};
        this.spectrumChanged();
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
        for (const analysis of this.analyses) analysis.reset();
        this._plot = null;
        super.dispose();
    }
    show(visible) {
        super.show(visible);
        if (!visible) {
            clearTimeout(this._pollTimer); this._pollTimer = null;
            let changed = false;
            for (const analysis of this.analyses) {
                if (analysis.job && !analysis.result.complete) { analysis.reset(); changed = true; }
            }
            if (changed) this.spectrumChanged();
        }
    }

    // What every track's measurement reads from the scene: the video, its
    // source frames and the mask. error is the message while there is nothing
    // to measure.
    sceneInputs() {
        const video = NodeMan.get('video', false)?.videoData, source = sourceVideoOf(video);
        const mask = NodeMan.get('videoMask', false) ?? NodeMan.get('motionMaskOverlay', false);
        mask?.ensureMaskInitialized();
        const enabled = mask?.maskEnabled !== false;
        let error = '';
        if (!source) error = t('videoTonal.noVideo');
        else if (source._loadingId && VideoLoadingManager.isLoading(source._loadingId)) error = t('videoTonal.loading');
        else if (!source.chunks?.length || !source.config) error = t('videoTonal.noFrames');
        else if (enabled && mask?.maskData && !mask.maskImageData) error = t('videoTonal.loadingMask');
        return {video, source, error, pixels: enabled ? mask?.maskImageData : null, rotation: source?.effectiveRotation ?? 0};
    }
    ensureAnalysis() {
        if (!this._pollTimer) this._pollTimer = setTimeout(() => {
            this._pollTimer = null;
            if (this.visible) this.ensureAnalysis();
        }, 500);
        const now = performance.now();
        const due = this.analyses.filter(analysis => now >= analysis.pollAt || analysis.regionMovedInsideMeasurement());
        if (!due.length) return;
        const scene = this.sceneInputs();
        for (const analysis of due) {
            analysis.pollAt = now + 250;
            analysis.ensure(scene);
        }
    }

    // Bring the spectra up to date with the In/Out region now, and wait for
    // them. A render that changes In/Out for each output frame awaits this
    // before it draws the frame; the normal poll would be up to 250 ms late.
    async settleAnalysis() {
        for (const analysis of this.analyses) analysis.pollAt = 0;
        this.ensureAnalysis();
        await Promise.all(this.analyses.map(analysis => analysis.job?.promise));
    }

    get trackName() { return this.single ? '' : this.analysis?.trackName ?? ''; }
    get graphTitle() { return this.trackName ? t('pointFrequency.trackTitle', {name: this.trackName}) : t('pointFrequency.title'); }

    // The measurements that have a spectrum, in Track List order; the first of
    // them gives the header, and its track gives the local background line.
    shownAnalyses() { return this.analyses.filter(analysis => analysis.spectrum); }
    backgroundAnalysis() {
        const first = this.analyses[0];
        return this.options.showBackground && first?.backgroundSpectrum ? first : null;
    }
    get backgroundColor() {
        const c = this.dark ? DARK : LIGHT;
        return this.single ? c.singleBackground : c.background;
    }
    // A track's semi-amplitude is a percent of its own mean flux, when that is not zero.
    // One axis has one unit: the single graph shows percent only when every
    // curve on it can be a percent, and otherwise shows every curve in DN·px.
    hasMean(analysis) { return Math.abs(analysis.spectrum?.mean ?? 0) > 1e-6; }
    percentOf(analysis) {
        if (!this.options.percent || !this.hasMean(analysis)) return false;
        return !this.single || this.shownAnalyses().every(shown => this.hasMean(shown));
    }
    scaleOf(analysis) { return this.percentOf(analysis) ? 100 / Math.abs(analysis.spectrum.mean) : 1; }
    unitOf(analysis) { return this.percentOf(analysis) ? '%' : 'DN·px'; }
    get percent() { return this.shownAnalyses().some(analysis => this.percentOf(analysis)); }
    lineColor(analysis) {
        const c = this.dark ? DARK : LIGHT;
        const color = this.single ? analysis.tracker?.displayColor : null;
        if (!color) return c.target;
        return this.dark ? color : darken(color);
    }
    // The messages of the tracks that have no spectrum, while no track has one.
    // When one track has a spectrum, the single graph shows the other tracks'
    // messages in its list instead.
    statusMessages() {
        if (this.shownAnalyses().length) return [];
        return [...new Set(this.analyses.map(analysis => analysis.statusMessage()).filter(Boolean))];
    }
    statusMessage() { return this.statusMessages().join('\n'); }
    stateKey() {
        return this.analyses.map(analysis => [analysis.trackName, analysis.radius, analysis.result?.version, analysis.statusMessage()].join(',')).join(';');
    }
    requiredMaxY() {
        let maximum = 0;
        // The peak-search floor applies to every graph, including its Y range.
        for (const analysis of this.shownAnalyses()) {
            maximum = Math.max(maximum, searchedMaximum(analysis.spectrum) * this.scaleOf(analysis) * 1.1);
        }
        const background = this.backgroundAnalysis();
        if (background) maximum = Math.max(maximum, searchedMaximum(background.backgroundSpectrum) * this.scaleOf(background) * 1.1);
        if (maximum < 1e-9) maximum = 1;
        const {height: overlayHeight} = this.overlayLayout();
        const h = this.heightPx - 2 * MARGIN;
        if (overlayHeight && h > 0) maximum = Math.max(maximum, maximum / 1.1 / (1 - Math.min(.5, (overlayHeight + 10) / h)));
        return maximum;
    }
    autoScale() {
        this.minX = 0; this.maxX = Math.max(0, ...this.shownAnalyses().map(analysis => analysis.spectrum.nyquist)) || 15;
        this.minY = 0; this.maxY = sharedPointTrackFrequencyMaxY(this);
        this.hasY2 = false; this.hasY3 = false;
    }
    point(x, y) { return this.graphToScreenAxis(x, y, this.minY, this.maxY); }
    renderCanvas(frame) {
        if (!this.visible) return;
        this.ensureAnalysis();
        this.menuName = this.graphTitle;
        this.autoScale();
        const key = [this.maxY, this.widthPx, this.heightPx, this.dark, JSON.stringify(this.options), this.stateKey()].join('|');
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
    // The same text as the window's own graph has, with the track name in
    // front of it on the single graph.
    trackLine(analysis, text) { return this.single ? t('pointFrequency.trackLine', {name: analysis.trackName, text}) : text; }
    // What lies over the top of the plot: the warnings about the samples, and
    // on the single graph the list of the tracks below them. The Y range keeps
    // the space for both.
    overlayLayout() {
        const ctx = this.ctx;
        if (!ctx || !(this.heightPx >= 180 && this.widthPx >= 180)) return {warnings: [], rows: [], height: 0};
        const key = [this.widthPx, this.heightPx, this.dark, JSON.stringify(this.options), this.statusMessage(), !!this.warningClosed,
            ...this.analyses.flatMap(analysis => [analysis.result?.version, analysis.inputs?.trackKey, analysis.spectrum,
                analysis.statusMessage(), analysis.trackName, analysis.radius])];
        if (this._overlayKey?.length === key.length && this._overlayKey.every((value, i) => value === key[i])) return this._overlay;
        const w = this.widthPx - 2 * MARGIN;
        const shown = this.shownAnalyses();
        const perMinute = this.options.perMinute, xUnit = perMinute ? 60 : 1;
        const frequencyUnit = t(perMinute ? 'pointFrequency.perMinuteUnit' : 'pointFrequency.hz');
        const frequencyText = hz => (hz * xUnit).toFixed(perMinute ? 1 : 2);
        // Warnings about the samples, at the top of the plot. Frames with no
        // tracked point come first, in one box in the red that those frames have on
        // the timeline and on the trail: their samples are measured at a position
        // that is a guess, and nothing else on the graph shows that.
        const warnings = [];
        const untracked = shown.filter(analysis => analysis.inputs.plan.untracked && this.untrackedWarningShows(analysis.inputs.range));
        if (untracked.length) warnings.push({alert: true, texts: untracked.map(analysis => {
            const gaps = analysis.inputs.plan.untracked, radius = analysis.radius;
            return this.trackLine(analysis, t('pointFrequency.interpolated', gaps) + ' '
                + (gaps.trial !== null ? t('pointFrequency.interpolatedTrial', {error: gaps.trial.toFixed(1), radius})
                    : t('pointFrequency.interpolatedMove', {move: gaps.move.toFixed(1), radius})));
        })});
        // The timing is the video's, the same for every track.
        const irregular = shown.find(analysis => analysis.inputs.sampling.irregular);
        if (irregular) {
            const {minFps, maxFps} = irregular.inputs.sampling;
            warnings.push({texts: [t('pointFrequency.irregularTiming', {min: minFps.toFixed(2), max: maxFps.toFixed(2),
                limit: frequencyText(minFps / 2), frequencyUnit})]});
        }
        const clipped = shown.map(analysis => {
            const fractions = analysis.inputs.plan.indices.map(i => analysis.result.clippedFraction[i]).filter(fraction => fraction > 0);
            return fractions.length ? {name: analysis.trackName, frames: fractions.length, total: analysis.inputs.plan.indices.length,
                max: (100 * maxOf(fractions)).toFixed(0)} : null;
        }).filter(Boolean);
        // The single graph puts every track in one line, so that the curves keep the space.
        if (this.single && clipped.length) warnings.push({texts: [t('pointFrequency.clippedTracks',
            {tracks: clipped.map(values => t('pointFrequency.clippedTrack', values)).join(', ')})]});
        else for (const values of clipped) warnings.push({texts: [t('pointFrequency.clipped', values)]});
        let height = 0;
        for (const warning of warnings) {
            ctx.font = warning.alert ? 'bold 12px sans-serif' : '11px sans-serif';
            // The box keeps its top right corner free for the ×.
            warning.lines = warning.texts.flatMap(text => this.wrapText(ctx, text, w - 36 - (warning.alert ? 2 * CLOSE_SIZE : 0)));
            warning.step = warning.alert ? 16 : 14;
            warning.height = warning.lines.length * warning.step + (warning.alert ? 10 : 2);
            height += warning.height + 4;
        }
        // The list of the tracks on the single graph: each track's line color,
        // its largest peak, and its own radius and smoothing; or its message.
        const rows = [];
        if (this.single) {
            for (const analysis of this.analyses) {
                const s = analysis.spectrum, status = analysis.statusMessage(), floor = s?.peakFloor ?? 0;
                let text;
                if (!s) text = this.trackLine(analysis, status || t('pointFrequency.unavailable'));
                else if (s.peakFloorAboveNyquist) text = this.trackLine(analysis, t('pointFrequency.floorAboveNyquist',
                    {floor: frequencyText(floor), nyquist: frequencyText(s.nyquist), frequencyUnit}));
                else if (s.peak) text = t('pointFrequency.trackRow', {name: analysis.trackName, frequency: frequencyText(s.peak.frequency),
                    frequencyUnit, amplitude: (s.peak.amplitude * this.scaleOf(analysis)).toFixed(2), unit: this.unitOf(analysis),
                    radius: analysis.radius, smoothing: analysis.inputs.smoothing});
                else text = this.trackLine(analysis, t('pointFrequency.flat'));
                rows.push({color: this.lineColor(analysis), text});
            }
            const background = this.backgroundAnalysis();
            if (background) rows.push({color: this.backgroundColor, text: t('pointFrequency.backgroundLegendOf', {name: background.trackName})});
            if (rows.length) height += rows.length * ROW + 10;
        }
        this._overlayKey = key;
        return this._overlay = {warnings, rows, height};
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
        const shown = this.shownAnalyses(), first = shown[0] ?? null;
        const s = first?.spectrum ?? null, input = first?.inputs ?? null;
        const statuses = this.statusMessages(), status = statuses.join('\n');
        // Flashes per minute relabel the same axis: frequencies stay in Hz, only
        // the printed values and units change.
        const perMinute = this.options.perMinute, xUnit = perMinute ? 60 : 1;
        const frequencyUnit = t(perMinute ? 'pointFrequency.perMinuteUnit' : 'pointFrequency.hz');
        const frequencyText = hz => (hz * xUnit).toFixed(perMinute ? 1 : 2);
        ctx.fillText(status ? t('pointFrequency.unavailable') : (s ? t('pointFrequency.window', {a: input.range.frame0, b: input.range.frame1,
            count: s.count, duration: s.duration.toFixed(2), fps: s.fps.toFixed(3), resolution: (s.binSpacing * xUnit).toPrecision(3),
            frequencyUnit}) : ''), width / 2, 34, width - 20);
        // The peak search floor is stored in Hz and printed in the chosen unit.
        // The single graph gives each track's peak in its list.
        const peak = s?.peak, floor = s?.peakFloor ?? 0;
        let peakText = '';
        if (!status && s) {
            if (s.peakFloorAboveNyquist) peakText = t('pointFrequency.floorAboveNyquist', {floor: frequencyText(floor), nyquist: frequencyText(s.nyquist), frequencyUnit});
            else if (this.single) peakText = t(floor > 0 ? 'pointFrequency.peakHeader' : 'pointFrequency.peakHeaderBin', {floor: frequencyText(floor), frequencyUnit});
            else if (peak) peakText = t(floor > 0 ? 'pointFrequency.peakAboveFloor' : 'pointFrequency.peak', {floor: frequencyText(floor),
                frequency: frequencyText(peak.frequency), frequencyUnit, amplitude: (peak.amplitude * this.scaleOf(first)).toFixed(2), unit: this.unitOf(first)});
            else peakText = t('pointFrequency.flat');
        }
        ctx.fillText(peakText, width / 2, 49, width - 20);
        this._warningClose = null;
        const {warnings, rows} = this.overlayLayout();
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
        const curves = shown.map(analysis => [analysis.spectrum, this.lineColor(analysis), this.scaleOf(analysis)]);
        const background = this.backgroundAnalysis();
        if (background) curves.push([background.backgroundSpectrum, this.backgroundColor, this.scaleOf(background)]);
        for (const [spectrum, color, scale] of curves) {
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
            spectrum.frequencies.forEach((frequency, i) => {
                const p = this.point(frequency, spectrum.amplitude[i] * scale);
                if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
            });
            ctx.stroke();
        }
        ctx.restore(); ctx.strokeStyle = c.grid; ctx.strokeRect(MARGIN, MARGIN, w, h);
        let overlayY = MARGIN + 6;
        ctx.textAlign = 'center';
        for (const {alert, lines, step, height: boxHeight} of warnings) {
            ctx.font = alert ? 'bold 12px sans-serif' : '11px sans-serif';
            if (alert) {
                // The background color first, so that a curve behind the text does not make it hard to read.
                ctx.globalAlpha = .7; ctx.fillStyle = c.bg; ctx.fillRect(MARGIN + 8, overlayY, w - 16, boxHeight);
                ctx.globalAlpha = .22; ctx.fillStyle = c.alert; ctx.fillRect(MARGIN + 8, overlayY, w - 16, boxHeight);
                ctx.globalAlpha = 1; ctx.strokeStyle = c.alert; ctx.lineWidth = 1.5; ctx.strokeRect(MARGIN + 8, overlayY, w - 16, boxHeight);
                // The ×: two strokes in a square at the top right corner. onMouseDown tests the same square.
                const close = this._warningClose = {x: MARGIN + w - 8 - CLOSE_SIZE - 3, y: overlayY + 3, size: CLOSE_SIZE};
                ctx.beginPath();
                ctx.moveTo(close.x + 5, close.y + 5); ctx.lineTo(close.x + close.size - 5, close.y + close.size - 5);
                ctx.moveTo(close.x + close.size - 5, close.y + 5); ctx.lineTo(close.x + 5, close.y + close.size - 5);
                ctx.lineWidth = 2; ctx.stroke();
            }
            ctx.fillStyle = alert ? c.alert : c.warning;
            lines.forEach((line, n) => ctx.fillText(line, width / 2, overlayY + (alert ? 5 : 0) + step * (n + 1) - 4));
            overlayY += boxHeight + 4;
        }
        // The list of the tracks: a short line in each track's color, then its text in that color.
        // The background color first, so that a curve behind the text does not make it hard to read.
        if (rows.length) {
            ctx.globalAlpha = .7; ctx.fillStyle = c.bg; ctx.fillRect(MARGIN + 8, overlayY, w - 16, rows.length * ROW + 6);
            ctx.globalAlpha = 1; overlayY += 3;
        }
        ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 2;
        for (const row of rows) {
            ctx.strokeStyle = row.color; ctx.beginPath();
            ctx.moveTo(MARGIN + 10, overlayY + ROW / 2); ctx.lineTo(MARGIN + 26, overlayY + ROW / 2); ctx.stroke();
            ctx.fillStyle = row.color; ctx.fillText(row.text, MARGIN + 32, overlayY + ROW - 3, w - 44);
            overlayY += ROW;
        }
        ctx.lineWidth = 1;
        if (status) {
            ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
            const lines = statuses.flatMap(message => this.wrapText(ctx, message, w - 20));
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
            if (this.single) {
                ctx.fillText(t('pointFrequency.methodShared'), width / 2, height - 23, width - 12);
            } else {
                ctx.fillStyle = c.target; ctx.fillText(t('pointFrequency.targetLegend') + (background ? '  ·  ' : ''), width / 2 - (background ? 65 : 0), height - 37, w);
                if (background) { ctx.fillStyle = c.background; ctx.fillText(t('pointFrequency.backgroundLegend'), width / 2 + 95, height - 37, w / 2); }
                ctx.fillStyle = c.text;
                ctx.fillText(t('pointFrequency.method', {radius: first.radius, smoothing: input.smoothing}), width / 2, height - 23, width - 12);
            }
        }
        return canvas;
    }

    // The spectrum and the measurement of each frame of one track: the given
    // one, or the first track of the window.
    async exportCSV(trackId) {
        const analysis = this.analysisFor(trackId) ?? this.analysis;
        const s = analysis?.spectrum, input = analysis?.inputs, result = analysis?.result;
        if (!s || !input || !result) return;
        const rows = ['frequency_hz,object_semi_amplitude_dn_px,background_semi_amplitude_dn_px,object_semi_amplitude_percent'];
        s.frequencies.forEach((f, i) => rows.push([f, s.amplitude[i], analysis.backgroundSpectrum.amplitude[i],
            Math.abs(s.mean) > 1e-6 ? s.amplitude[i] * 100 / Math.abs(s.mean) : ''].join(',')));
        // The frames that were measured at a position that was not tracked.
        const interpolated = new Set(input.plan.untracked?.indices);
        rows.push('', 'scene_in,scene_out,samples,fps,duration_s,bin_spacing_hz,nyquist_hz,radius_px,position_smoothing_frames,mean_signed_flux_dn_px,representation,source_bits,mask_enabled,irregular_timing,min_fps,max_fps,peak_floor_hz,interpolated_frames',
            [input.range.frame0, input.range.frame1, s.count, s.fps, s.duration, s.binSpacing, s.nyquist, analysis.radius,
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
        saveAs(new Blob([rows.join('\n')], {type: 'text/csv;charset=utf-8'}), `PointTrackFrequency-${analysis.trackName.replace(/[^a-zA-Z0-9_-]+/g, '_') || analysis.trackId}.csv`);
    }
}

// trackId null makes the single graph, which draws the tracks that setTracks gives it.
export function createPointTrackFrequencyGraphView(id, options, trackId) {
    const offset = trackId ? ((Number(trackId.replace(/^track/, '')) || 1) - 1) % 6 * .035 : 0;
    return new CNodePointTrackFrequencyGraphView({id, options, trackId, menuName: t('pointFrequency.title'),
        visible: true, alwaysOnTop: true, left: .23 + offset, top: .28 + offset, width: .62, height: .46,
        draggable: true, resizable: true, freeAspect: true, shiftDrag: false});
}
