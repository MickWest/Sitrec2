// CNodeVideoNoisePatternView - the results window of Video > Forensics > Noise Pattern
// Detection. A text window (all numbers selectable and copyable), with:
//   1 the verdict          4 where the repeat is, along the timeline
//   2 the progress line    5 the pair viewer (images of the noise of two frames)
//   3 the lag chart        6 the details (every number, the timings and the benchmark)
// and an optional overlay on the video view that outlines the matching strips.
// Loaded on first use only (see VideoNoisePattern.js); never in src/nodes/.

import {CNodeViewText} from "../nodes/CNodeViewText";
import {NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {t} from "../i18n";
import {isLocal} from "../configUtils";
import {VideoLoadingManager} from "../CVideoLoadingManager";
import {displayIndexForFrame, frameForDisplayIndex, sourceVideoOf} from "../videoQP/VideoQPAnalysis";
import {goToTimelineFrame} from "../TimelineMenu";
import {showChoice} from "../showError";
import {clampNoisePatternOptions, setVideoNoisePatternTeardown} from "../VideoNoisePattern";
import {estimateFeatureBytes, NOISE_PATTERN_CACHE_LIMIT, startNoisePatternJob, terminateNoisePatternWorkers} from "./NoisePatternJob";
import {drawLagChart, drawPairImages, drawWhereStrip, residualCanvas, sizeCanvas, stripHue} from "./NoisePatternCharts";
import {CURVES, LAG_MIN, PLANES} from "./NoisePatternMath";

setVideoNoisePatternTeardown(terminateNoisePatternWorkers);

const tr = (key, values) => t(`videoNoisePattern.${key}`, values);
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
const int = (value) => Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
// matching strips pasted on each side of a picked strip on the video (frames one period apart)
const NEIGHBOR_STRIPS = 4;
const ms = (value) => Number.isFinite(value) ? (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`) : "—";

export class CNodeVideoNoisePatternView extends CNodeViewText {
    constructor(v) {
        v.idPrefix = "noise-pattern";
        v.hideOnFileDrop = false;
        v.manualScroll = true;
        v.maxMessages = 0;
        v.excludeFromViewsMenu = true;
        v.renderWhileWindowed = true;
        super(v);
        this.skipModSerialize = true;
        this.options = clampNoisePatternOptions(v.options);
        this.ui = this.ui ?? {blink: false, aligned: false, overlay: false, showSource: false, maxContrast: false};
        this.savedSelection = this.savedSelection ?? null;
        this.job = null;
        this.statusKey = "";
        this.changed = false;
        this.buildDOM();
        if (typeof ResizeObserver !== "undefined") {
            this.layoutObserver = new ResizeObserver(() => {
                if (this.refreshLayout()) setRenderOne();
            });
            this.layoutObserver.observe(this.outputArea);
        }
        this.exposeDebug();
    }

    // ---- saving

    modSerialize() {
        const selection = this.job?.result?.selection;
        const saved = selection ? {lag: selection.lag, source: selection.source, target: selection.target} : this.savedSelection;
        return {
            ...super.modSerialize(),
            noisePatternOptions: {...this.options},
            noisePatternSelection: saved ? {...saved, blink: !!this.ui?.blink, aligned: !!this.ui?.aligned, overlay: !!this.ui?.overlay} : undefined,
        };
    }

    modDeserialize(state) {
        super.modDeserialize(state);
        this.options = clampNoisePatternOptions(state.noisePatternOptions);
        const s = state.noisePatternSelection;
        this.ui = this.ui ?? {blink: false, aligned: false, overlay: false, showSource: false, maxContrast: false};
        if (s && Number.isFinite(s.source) && Number.isFinite(s.target)) {
            this.savedSelection = {source: Math.round(s.source), target: Math.round(s.target), lag: s.lag};
            this.ui.blink = !!s.blink; this.ui.aligned = !!s.aligned; this.ui.overlay = !!s.overlay;
        }
        this.refreshDisplay?.();
    }

    // ---- DOM

    addTabButtons() {}

    applyTheme() {
        super.applyTheme();
        this.refreshDisplay?.();
    }

    buildDOM() {
        const area = this.outputArea;
        Object.assign(area.style, {whiteSpace: "normal", overflowWrap: "anywhere", overflowX: "hidden",
            fontFamily: "sans-serif", fontSize: "12px", cursor: "default"});
        const el = (tag, style = {}, parent = area, text = null) => {
            const node = document.createElement(tag);
            Object.assign(node.style, style);
            if (text !== null) node.textContent = text;
            parent.appendChild(node);
            return node;
        };
        const selectable = {userSelect: "text", webkitUserSelect: "text", cursor: "text"};
        const heading = {fontWeight: "bold", margin: "8px 0 3px"};
        this.verdictEl = el("div", {display: "flex", gap: "8px", alignItems: "flex-start", margin: "2px 0 4px"});
        this.verdictDot = el("span", {width: "12px", height: "12px", borderRadius: "6px", flex: "0 0 12px", marginTop: "3px", background: "#888"}, this.verdictEl);
        this.verdictText = el("div", {minWidth: "0", whiteSpace: "pre-line", lineHeight: "1.35", fontSize: "13px", ...selectable}, this.verdictEl);
        this.progressEl = el("div", {display: "flex", alignItems: "center", gap: "6px", margin: "4px 0 2px", flexWrap: "wrap"});
        this.runButton = this.button(tr("view.run"), () => this.run(true), this.progressEl);
        this.stopButton = this.button(tr("view.stop"), () => this.stop(), this.progressEl);
        this.progressText = el("span", {minWidth: "0", fontFamily: "monospace", fontSize: "11px", ...selectable}, this.progressEl);
        el("div", heading, area, tr("view.lagChart"));
        this.chartCanvas = el("canvas", {display: "block", cursor: "crosshair"});
        this.hoverText = el("div", {fontFamily: "monospace", fontSize: "11px", minHeight: "14px", whiteSpace: "pre-wrap", ...selectable});
        el("div", heading, area, tr("view.where"));
        this.whereCanvas = el("canvas", {display: "block", cursor: "pointer"});
        this.whereLegend = el("div", {fontSize: "11px", opacity: "0.8", ...selectable}, area, tr("view.whereLegend"));
        el("div", heading, area, tr("view.pair"));
        this.pairLabel = el("div", {fontFamily: "monospace", fontSize: "11px", whiteSpace: "pre-wrap", ...selectable});
        const bar = el("div", {display: "flex", flexWrap: "wrap", gap: "4px", margin: "4px 0"});
        this.button(tr("view.previous"), () => this.stepPair(-1), bar);
        this.button(tr("view.next"), () => this.stepPair(1), bar);
        this.button(tr("view.goSource"), () => this.goTo("source"), bar);
        this.button(tr("view.goTarget"), () => this.goTo("target"), bar);
        this.blinkButton = this.button(tr("view.blink"), () => this.toggle("blink"), bar);
        this.alignedButton = this.button(tr("view.aligned"), () => this.toggle("aligned"), bar);
        this.overlayButton = this.button(tr("view.showOnVideo"), () => this.toggle("overlay"), bar);
        this.maxContrastButton = this.button(tr("view.maxContrast"), () => this.toggleMaxContrast(), bar);
        this.pairCanvas = el("canvas", {display: "block", cursor: "pointer"});
        el("div", heading, area, tr("view.details"));
        this.detailsEl = el("pre", {fontFamily: "monospace", fontSize: "11px", whiteSpace: "pre-wrap", margin: "2px 0 8px", ...selectable});

        this.chartCanvas.addEventListener("mousemove", (e) => this.hoverChart(e));
        this.chartCanvas.addEventListener("mouseleave", () => { this.hoverLag = null; this.drawChart(); });
        this.chartCanvas.addEventListener("click", (e) => this.clickChart(e));
        this.pairCanvas.addEventListener("click", (e) => this.clickPair(e));
        this.whereCanvas.addEventListener("mousedown", e => this.beginWhereDrag(e));
        this.refreshDisplay();
    }

    // ---- a picked strip: a click on a column in either pane picks it (a second click lets go)

    pickIndex(sel) {
        return this.pick && sel && this.pick.selection === sel ? this.pick.index : -1;
    }

    clickPair(e) {
        const g = this.pairGeometry, sel = this.job?.result?.selection, boxes = this.pairBoxes;
        if (!g || !sel || !boxes?.length) return;
        const rect = this.pairCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const panel = g.panels.find(p => x >= p.x0 && x <= p.x0 + p.dw && y >= p.y0 && y <= p.y0 + p.dh);
        if (!panel) return;
        const fx = (x - panel.x0) / panel.toPx;
        const k = boxes.findIndex(b => {
            const a = panel.which === "target" ? b.x0 : b.sx0, c = panel.which === "target" ? b.x1 : b.sx1;
            return Number.isFinite(a) && Number.isFinite(c) && fx >= Math.min(a, c) && fx < Math.max(a, c);
        });
        const again = k >= 0 && this.pickIndex(sel) === k;
        this.pick = k >= 0 && !again ? {selection: sel, index: k} : null;
        this.neighbors = null;
        this.drawPair();
        setRenderOne();
    }

    button(label, onClick, parent) {
        const b = document.createElement("button");
        b.textContent = label;
        Object.assign(b.style, {fontSize: "11px", padding: "2px 8px", borderRadius: "4px", cursor: "pointer",
            border: "1px solid var(--cnodeview-tab-border)", background: "var(--cnodeview-tab-bg)", color: "var(--cnodeview-tab-color)"});
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        parent.appendChild(b);
        return b;
    }

    // ---- running

    currentVideoData() { return NodeMan.get("video", false)?.videoData ?? null; }

    settingsChanged() {
        this.changed = true;
        this.refreshDisplay();
    }

    async run(force = false) {
        clearTimeout(this.waitTimer);
        this.waitTimer = null;
        if (!this.visible) return;
        const video = this.currentVideoData();
        if (this.analysisVideo !== video) {
            // Detach the old job before cancelling: its updates must not draw results
            // or restore a selected pair onto the replacement video.
            const previousJob = this.job;
            this.job = null;
            if (previousJob && !previousJob.result.complete) previousJob.cancel();
            if (this.analysisVideo) this.savedSelection = null;
            this.analysisVideo = video;
            this.pairImages = null;
            this.stopBlink();
            this.clearOverlay();
        }
        if (this.job && !this.job.result.complete) return;
        if (!force && this.job && this.job.result.status === "done" && !this.changed && this.job.videoData === video) return;
        const source = sourceVideoOf(video);
        let status = "";
        if (!source) status = "noVideo";
        else if (source._loadingId && VideoLoadingManager.isLoading(source._loadingId)) status = "loading";
        else if (source.downloadFinished === false) status = "downloading";
        else if (!source.chunks?.length || !source.config) status = "noFrames";
        else if (!source.groups?.length) status = "noKeyFrames";
        this.statusKey = status;
        if (status) {
            if (status === "loading" || status === "downloading") this.waitTimer = setTimeout(() => this.run(force), 500);
            this.refreshDisplay();
            return;
        }
        const options = {...this.options};
        const rangeFor = () => ({from: displayIndexForFrame(video, Sit.aFrame ?? 0),
            to: displayIndexForFrame(video, Sit.bFrame ?? (Sit.frames - 1))});
        let range = options.frames === "ab" ? rangeFor() : null;
        const frames = range ? range.to - range.from + 1 : source.chunks.length;
        const width = source.originalVideoWidth || video.originalVideoWidth || source.config.codedWidth || 1280;
        const bytes = estimateFeatureBytes(width, frames, options.detail);
        if (bytes > NOISE_PATTERN_CACHE_LIMIT && options.frames === "all") {
            const choice = await showChoice(tr("view.memory", {mb: Math.round(bytes / 1048576), limit: Math.round(NOISE_PATTERN_CACHE_LIMIT / 1048576)}), {
                title: tr("view.memoryTitle"),
                options: [
                    {label: tr("view.useAB"), value: "ab", primary: true},
                    {label: tr("view.analyzeAnyway"), value: "all"},
                    {label: tr("view.cancel"), value: null, cancel: true},
                ],
            });
            if (!choice || !this.visible || this.currentVideoData() !== video || this.analysisVideo !== video) return;
            if (choice === "ab") { this.options.frames = options.frames = "ab"; range = rangeFor(); }
        }
        this.changed = false;
        this.selectionApplied = false;
        this.pairImages = null;
        this.jobStarted = performance.now();
        this.job = startNoisePatternJob(video, {...options, range}, {onUpdate: () => this.refreshDisplay()});
        this.exposeDebug();
        const job = this.job;
        job.promise.then(() => {
            if (this.job !== job) return;
            this.applySavedSelection();
            this.refreshDisplay();
        });
        this.refreshDisplay();
    }

    async applySavedSelection() {
        const saved = this.savedSelection;
        if (!saved || this.selectionApplied || this.job?.result.status !== "done") return;
        this.selectionApplied = true;
        try { await this.job.selectPair(saved.source, saved.target); } catch (error) { console.warn("Noise pattern: saved pair", error); }
        if (this.ui.blink) this.startBlink();
        setRenderOne();
    }

    stop() {
        clearTimeout(this.waitTimer);
        this.waitTimer = null;
        if (this.job && !this.job.result.complete) this.job.cancel();
        this.statusKey = "";
        this.refreshDisplay();
    }

    async benchmark() {
        if (this.job?.result?.status !== "done") { this.statusKey = "benchmarkNeedsRun"; this.refreshDisplay(); return; }
        this.benchmarking = true;
        this.refreshDisplay();
        try {
            await this.job.benchmark();
        } catch (error) {
            this.benchmarkError = error.message;
        } finally {
            this.benchmarking = false;
            this.refreshDisplay();
        }
    }

    show(visible = true) {
        super.show(visible);
        if (visible) this.run(false);
        else this.release();
    }

    release() {
        this.whereDragCleanup?.();
        clearTimeout(this.waitTimer);
        this.waitTimer = null;
        this.stopBlink();
        if (this.job && !this.job.result.complete) this.job.cancel();
        terminateNoisePatternWorkers();
        this.clearOverlay();
    }

    dispose() {
        this.layoutObserver?.disconnect();
        this.restoreContrast();
        this.release();
        this.overlay?.remove();
        this.overlay = null;
        this.watchVideoClicks(null);
        if (isLocal && window._noisePattern?.view === this) delete window._noisePattern;
        super.dispose();
    }

    exposeDebug() {
        if (!isLocal || typeof window === "undefined") return;
        const view = this;
        window._noisePattern = {
            view,
            get job() { return view.job; },
            get result() { return view.job?.result; },
            analyzePair: (source, target) => view.job?.analyzePair(source, target),
            selectPair: (source, target) => view.selectPair(source, target),
            benchmark: () => view.benchmark(),
        };
    }

    // ---- interaction

    async selectPair(source, target) {
        if (!this.job || this.job.result.status !== "done") return null;
        this.pairImages = null;
        try {
            const pair = await this.job.selectPair(source, target);
            setRenderOne();
            return pair;
        } catch (error) {
            console.warn("Noise pattern: pair", error);
            return null;
        }
    }

    hoverChart(e) {
        if (!this.chartGeometry) return;
        const rect = this.chartCanvas.getBoundingClientRect();
        this.hoverLag = this.chartGeometry.lagAt(e.clientX - rect.left);
        this.drawChart();
    }

    clickChart(e) {
        if (!this.chartGeometry || !this.job) return;
        const rect = this.chartCanvas.getBoundingClientRect();
        const lag = this.chartGeometry.lagAt(e.clientX - rect.left);
        const pair = this.job.bestPairAtLag(this.job.result.verdict?.curve, lag);
        if (pair) this.selectPair(pair.source, pair.target);
    }

    scrubWhere(e) {
        const rect = this.whereCanvas.getBoundingClientRect();
        const frames = Sit.frames ?? 0;
        if (!frames || rect.width <= 0) return;
        const frame = Math.floor((e.clientX - rect.left) / rect.width * frames);
        goToTimelineFrame(frame);
    }

    beginWhereDrag(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.whereDragCleanup?.();
        // The canvas can be adopted into a popup. Its release events belong to
        // that window, and capture receives them before view handlers stop them.
        const owner = this.whereCanvas.ownerDocument.defaultView;
        const finish = (select = false) => {
            owner.removeEventListener("mousemove", move, true);
            owner.removeEventListener("mouseup", up, true);
            owner.removeEventListener("blur", blur);
            this.whereDragCleanup = null;
            if (select) this.selectAtCurrentFrame();
        };
        const move = event => {
            if (!(event.buttons & 1)) { finish(true); return; }
            this.scrubWhere(event);
        };
        const up = event => { if (event.button === 0) finish(true); };
        const blur = () => finish();
        this.whereDragCleanup = () => finish();
        owner.addEventListener("mousemove", move, true);
        owner.addEventListener("mouseup", up, true);
        owner.addEventListener("blur", blur);
        this.scrubWhere(e);
    }

    selectAtCurrentFrame() {
        if (!this.job) return;
        const display = displayIndexForFrame(this.currentVideoData(), par.frame);
        const pair = this.job.pairForDisplay(display);
        if (pair) this.selectPair(pair.source, pair.target);
    }

    stepPair(direction) {
        const sel = this.job?.result?.selection;
        if (!this.job) return;
        const pair = this.job.neighborPair(sel ? sel.source : (direction > 0 ? -1 : Infinity), direction);
        if (pair) this.selectPair(pair.source, pair.target);
    }

    goTo(which) {
        const sel = this.job?.result?.selection;
        if (!sel) return;
        goToTimelineFrame(frameForDisplayIndex(this.currentVideoData(), sel[which]));
    }

    toggle(key) {
        this.ui[key] = !this.ui[key];
        if (key === "blink") { if (this.ui.blink) this.startBlink(); else this.stopBlink(); }
        if (key === "aligned") this.pairImages = null;
        this.refreshDisplay();
        setRenderOne();
    }

    // "Max contrast": Video Adjustments contrast to 5 (its maximum), with the adjustments
    // turned on; toggling it off, or closing the window, puts the old values back. Set through
    // the nodes' own setValue, as the adjustments menu's Reset does, so the menu follows.
    toggleMaxContrast() {
        if (this.ui.maxContrast) {
            this.restoreContrast();
        } else {
            const contrast = NodeMan.get("videoContrast", false), effects = NodeMan.get("videoEnableEffects", false);
            if (!contrast) return;
            this.savedContrast = {contrast: contrast.value, effects: effects ? effects.value : null};
            if (effects && !effects.value) this.setNodeValue(effects, true);
            this.setNodeValue(contrast, 5);
            this.ui.maxContrast = true;
        }
        this.refreshDisplay();
        setRenderOne();
    }

    restoreContrast() {
        if (!this.ui?.maxContrast) return;
        const saved = this.savedContrast;
        const contrast = NodeMan.get("videoContrast", false), effects = NodeMan.get("videoEnableEffects", false);
        if (saved && contrast) this.setNodeValue(contrast, saved.contrast);
        if (saved && effects && saved.effects === false) this.setNodeValue(effects, false);
        this.savedContrast = null;
        this.ui.maxContrast = false;
    }

    setNodeValue(node, value) {
        if (typeof node.setValue === "function") node.setValue(value);
        else if (node.guiEntry) node.guiEntry.setValue(value);
        else node.value = value;
    }

    startBlink() {
        this.stopBlink();
        this.ui.blink = true;
        this.blinkTimer = setInterval(() => { this.ui.showSource = !this.ui.showSource; this.drawPair(); }, 250);
    }

    stopBlink() {
        clearInterval(this.blinkTimer);
        this.blinkTimer = null;
        if (this.ui) this.ui.showSource = false;
    }

    // ---- per render: the frame cursor and the video overlay

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.visible || !this.detailsEl) return;
        if (this.currentVideoData() !== this.analysisVideo) this.run();
        if (!this.refreshLayout() && Math.floor(frame) !== this.lastFrame) this.drawWhere();
        this.lastFrame = Math.floor(frame);
        this.drawOverlay(frame);
    }

    // ---- display

    refreshLayout() {
        const width = this.outputArea.clientWidth, height = this.outputArea.clientHeight;
        if (!this.visible || !this.detailsEl || !width || !height) return false;
        if (width === this.lastWidth && height === this.lastHeight) return false;
        this.lastWidth = width;
        this.lastHeight = height;
        this.refreshDisplay();
        return true;
    }

    refreshDisplay() {
        if (!this.detailsEl) return;
        const r = this.job?.result;
        this.setVerdict(r);
        this.progressText.textContent = this.progressLine(r);
        const running = !!r && !r.complete;
        this.runButton.disabled = running;
        this.stopButton.disabled = !running;
        for (const [button, on] of [[this.blinkButton, this.ui.blink], [this.alignedButton, this.ui.aligned], [this.overlayButton, this.ui.overlay],
            [this.maxContrastButton, this.ui.maxContrast]]) {
            button.style.outline = on ? "2px solid #4ea1ff" : "none";
            button.setAttribute("aria-pressed", on ? "true" : "false");
        }
        this.drawChart();
        this.drawWhere();
        this.drawPair();
        this.setDetails(this.detailsText(r));
    }

    setVerdict(r) {
        let text, color;
        const v = r?.verdict;
        if (this.statusKey && (!r || r.complete)) { text = tr(`status.${this.statusKey}`); color = "#888"; }
        else if (!r) { text = tr("verdict.idle"); color = "#888"; }
        else if (r.status === "error") { text = tr("verdict.failed", {reason: r.error}); color = "#888"; }
        else if (r.status === "stopped") { text = tr("verdict.stopped"); color = "#888"; }
        else if (!v || v.kind === "pending") { text = tr("verdict.analyzing"); color = "#888"; }
        else if (v.kind === "cannot") { text = tr("verdict.cannot", {reason: tr(`verdict.reason.${v.reason}`, {frames: v.frames})}); color = "#888"; }
        else if (v.kind === "none") {
            text = tr("verdict.none", {from: LAG_MIN, to: r.lags?.lmax ?? "—", unit: this.unit(r)});
            color = "#2e9d4a";
        } else if (v.kind === "isolated") {
            const list = v.isolated.slice(0, 6).map(s => `${s.lag} (${s.curve}, z ${fmt(s.z, 1)})`).join(", ");
            text = tr("verdict.isolated", {list, unit: this.unit(r)});
            color = "#e0a000";
        } else {
            const lines = [tr("verdict.repeat", {period: v.period, unit: this.unit(r)})];
            lines.push(tr("verdict.strength", {strength: fmt(v.strength, 1), label: tr(`verdict.label.${v.strengthLabel}`),
                coverage: v.coverage, references: v.references, plane: this.planeName(v)}));
            if (r.precise) {
                const runs = r.precise.runs.slice(0, 4).map(([a, b]) => `${this.frameOf(a)}–${this.frameOf(b)}`).join(", ");
                lines.push(tr("verdict.where", {runs: runs || "—", matched: int(r.precise.matched), tested: int(r.precise.tested)}));
            }
            const rule = r.refine?.rule, lattice = r.refine?.lattice;
            if (lattice?.accepted || rule?.kind && rule.kind !== "none") {
                const width = rule?.kind === "xor" ? rule.w : lattice?.w;
                lines.push(tr(`verdict.rule.${rule?.kind ?? "none"}`, {width: fmt(width, 2), fit: rule?.fitPairs ?? 0, total: rule?.total ?? 0}));
            }
            if (r.longRange) lines.push(tr("verdict.longest", {lag: int(r.longRange.lag)}));
            if (r.pictureRepeat?.repeats) lines.push(tr("verdict.pictureRepeat"));
            text = lines.join("\n");
            color = r.pictureRepeat?.repeats ? "#e0a000" : "#e53935";
        }
        // frames the decoder could not deliver are not covered by the verdict: say so, and a
        // "no repeat" on an incomplete video is not shown in green
        const failed = r?.counts?.failed;
        if (v && r?.status === "done" && failed > 0 && v.kind !== "pending" && v.kind !== "cannot") {
            text += "\n" + tr("verdict.incomplete", {failed: int(failed), frames: int(r.counts.frames), segments: int(r.counts.skippedSegments ?? 0)});
            if (v.kind === "none") color = "#e0a000";
        }
        if (this.changed) text += "\n" + tr("status.settingsChanged");
        if (this.verdictText.textContent !== text && !this.selectionIn(this.verdictText)) this.verdictText.textContent = text;
        this.verdictDot.style.background = color;
    }

    unit(r) { return r?.picture ? tr("view.pictures") : tr("view.frames"); }

    planeName(v) {
        if (!v) return "—";
        if (!v.strip) return v.curve === "A-Yfine" ? tr("view.planeYfine") : tr("view.planeCbmid");
        return tr(`view.plane${PLANES[v.plane]}`);
    }

    frameOf(display) {
        const video = this.currentVideoData();
        return video ? frameForDisplayIndex(video, display) : display;
    }

    progressLine(r) {
        if (this.changed) return tr("status.settingsChanged");
        if (this.benchmarking) return tr("status.benchmarking");
        if (!r) return this.statusKey ? tr(`status.${this.statusKey}`) : "";
        const elapsed = r.complete ? r.timings.total : performance.now() - (this.jobStarted ?? performance.now());
        const backend = r.backend.search ? tr(`view.backend.${r.backend.search}`) : "";
        if (r.status === "stopped") return tr("status.stopped");
        if (r.status === "error") return tr("status.failed", {reason: r.error});
        if (r.complete) return tr("status.done", {time: ms(r.timings.total), backend});
        const stage = tr(`status.stage.${r.stage}`);
        const counts = r.progress.total ? ` ${int(r.progress.done)} / ${int(r.progress.total)}` : "";
        return `${stage}${counts} · ${ms(elapsed)}${backend ? " · " + backend : ""}`;
    }

    contentWidth() {
        return Math.max(1, (this.outputArea.clientWidth || 400) - 16);
    }

    drawChart() {
        if (!this.chartCanvas) return;
        const r = this.job?.result;
        const width = this.contentWidth(), height = 190;
        const ctx = sizeCanvas(this.chartCanvas, width, height);
        this.chartGeometry = drawLagChart(ctx, width, height, {
            curves: r?.curves, lags: r?.lags, verdict: r?.verdict, hoverLag: this.hoverLag, dark: this.dark,
            labels: {empty: r?.verdict?.kind === "cannot" ? tr("chart.tooShort") : tr("chart.empty"),
                xAxis: r?.picture ? tr("chart.xLagPictures") : tr("chart.xLag"), yAxis: tr("chart.yScore")},
        });
        let hover = "";
        if (this.hoverLag && r?.curves) {
            const parts = CURVES.map(name => `${name} z ${fmt(r.curves[name]?.z?.[this.hoverLag - 1], 1)}`);
            hover = tr("view.hover", {lag: this.hoverLag, values: parts.join(" · ")});
            if (this.hoverLag < LAG_MIN) hover += " " + tr("view.notScored");
        }
        if (this.hoverText.textContent !== hover && !this.selectionIn(this.hoverText)) this.hoverText.textContent = hover;
    }

    drawWhere() {
        if (!this.whereCanvas) return;
        const r = this.job?.result;
        const width = this.contentWidth(), height = 26;
        const ctx = sizeCanvas(this.whereCanvas, width, height);
        const video = this.currentVideoData();
        drawWhereStrip(ctx, width, height, {byDisplay: r?.byDisplay, frames: Sit.frames, dark: this.dark,
            displayOf: (f) => displayIndexForFrame(video, f), currentFrame: par.frame});
    }

    selectionBoxes(sel) {
        if (!sel) return [];
        if (sel.assignment?.length) {
            return sel.assignment.map(row => ({x0: row.x0, x1: row.x1, sx0: row.sx0, sx1: row.sx1, hue: stripHue(row.target),
                label: `←${row.source}`, sourceLabel: String(row.source), share: row.share}));
        }
        return (sel.segments ?? []).map((s, i) => ({x0: s.x0, x1: s.x1, sx0: s.sx0, sx1: s.sx1, hue: stripHue(i),
            label: `←x${Math.round(s.sx0)}`, sourceLabel: `x${Math.round(s.sx0)}`}));
    }

    drawPair() {
        if (!this.pairCanvas) return;
        const r = this.job?.result, sel = r?.selection;
        const width = this.contentWidth();
        const aspect = sel?.images?.target ? sel.images.target.height / sel.images.target.width : 0.5625;
        const height = Math.round(this.ui.blink ? width * aspect + 16 : (width / 2) * aspect + 16);
        const canvasHeight = Math.max(60, Math.min(600, height));
        const ctx = sizeCanvas(this.pairCanvas, width, canvasHeight);
        if (sel && (!this.pairImages || this.pairImages.selection !== sel || this.pairImages.aligned !== this.ui.aligned)) {
            const image = sel.images?.source;
            let shiftAt = null;
            if (this.ui.aligned && sel.map && image) {
                const sx = image.sx || 1;
                const shifts = new Float32Array(image.width).fill(NaN);
                for (let x = 0; x < image.width; x++) {
                    const lx = (x + 0.5) * sx;
                    let best = Infinity;
                    for (let k = 0; k < sel.map.count; k++) {
                        if (!sel.map.confident[k]) continue;
                        const d = Math.abs(sel.map.x[k] - lx);
                        if (d < best) { best = d; shifts[x] = sel.map.dl[k] / sx; }
                    }
                    if (best > 16) shifts[x] = NaN;
                }
                shiftAt = (x) => Number.isFinite(shifts[x]) ? shifts[x] : -1e9;
            }
            this.pairImages = {selection: sel, aligned: this.ui.aligned,
                target: residualCanvas(sel.images?.target), source: residualCanvas(image, shiftAt)};
        }
        const pairBoxes = this.ui.aligned ? this.selectionBoxes(sel).map(b => ({...b, sx0: b.x0, sx1: b.x1})) : this.selectionBoxes(sel);
        this.pairBoxes = pairBoxes;
        this.pairGeometry = drawPairImages(ctx, width, canvasHeight, {
            target: this.pairImages?.target, source: this.pairImages?.source, blink: this.ui.blink, showSource: this.ui.showSource,
            boxes: pairBoxes, dark: this.dark, frameWidth: sel?.frameWidth ?? 1, selected: this.pickIndex(sel),
            labels: {empty: tr("view.noPair"), target: sel ? tr("view.targetImage", {frame: this.frameOf(sel.target)}) : "",
                source: sel ? tr(this.ui.aligned ? "view.sourceAligned" : "view.sourceImage", {frame: this.frameOf(sel.source)}) : ""},
        });
        let label = tr("view.noPair");
        if (sel) {
            const confident = sel.map ? Array.from(sel.map.confident).reduce((s, x) => s + x, 0) : 0;
            const valid = sel.map ? Array.from(sel.map.valid).reduce((s, x) => s + x, 0) : 0;
            label = tr("view.pairLabel", {source: this.frameOf(sel.source), target: this.frameOf(sel.target), lag: sel.lag,
                confident, valid, score: fmt(sel.C), tau: fmt(sel.tau)});
            if (sel.xor && sel.lattice) label += "\n" + tr("view.pairXor", {d: sel.xor.d, fit: Math.round(100 * sel.xor.fit), probes: sel.xor.probes});
            if (sel.translation) label += "\n" + tr("view.pairShift", {shift: fmt(sel.translation.shift, 0), fit: Math.round(100 * sel.translation.fit)});
        }
        if (this.pairLabel.textContent !== label && !this.selectionIn(this.pairLabel)) this.pairLabel.textContent = label;
    }

    clearOverlay() {
        if (this.overlay) this.overlay.getContext("2d").clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    drawOverlay(frame) {
        const videoView = NodeMan.get("video", false);
        const sel = this.job?.result?.selection;
        if (!this.visible || !this.ui.overlay || !sel || !videoView?.div) { this.clearOverlay(); return; }
        if (!this.overlay || this.overlay.parentElement !== videoView.div) {
            this.overlay?.remove();
            this.overlay = document.createElement("canvas");
            Object.assign(this.overlay.style, {position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
                pointerEvents: "none", zIndex: "100"});
            videoView.div.appendChild(this.overlay);
            this.watchVideoClicks(videoView.div);
        }
        const w = videoView.widthPx, h = videoView.heightPx;
        if (this.overlay.width !== w || this.overlay.height !== h) { this.overlay.width = w; this.overlay.height = h; }
        const ctx = this.overlay.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        const videoData = videoView.videoData;
        // the boxes are in the coded picture: hidden while the view shifts or turns it
        if (videoData?.stabilizationEnabled || (videoData?.effectiveRotation ?? 0) !== 0) return;
        const display = displayIndexForFrame(videoData, frame);
        const role = display === sel.target ? "target" : display === sel.source ? "source" : null;
        if (!videoView.videoToCanvasCoordsOriginal) return;
        if (!role) {
            // the overlay follows the playhead: on a paused frame outside the shown pair, the
            // pair the precise pass found for that frame is selected (its boxes come with the
            // next render); where nothing matched, the video says so
            this.followPlayhead(display);
            if (this.autoPair?.display === display && this.autoPair.none) {
                this.overlayCaption(ctx, w, h, tr("overlay.noMatch", {frame: this.frameOf(display)}));
            }
            return;
        }
        const height = sel.frameHeight || videoView.originalVideoHeight || 720;
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        for (const box of this.selectionBoxes(sel)) {
            const a = role === "target" ? box.x0 : box.sx0, b = role === "target" ? box.x1 : box.sx1;
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            const [x0, y0] = videoView.videoToCanvasCoordsOriginal(a, 0);
            const [x1, y1] = videoView.videoToCanvasCoordsOriginal(b, height);
            ctx.strokeStyle = `hsl(${box.hue}, 90%, 55%)`;
            ctx.lineWidth = 2;
            ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
            ctx.fillStyle = `hsl(${box.hue}, 90%, 65%)`;
            ctx.fillText(role === "target" ? box.label : box.sourceLabel, (x0 + x1) / 2, y0 + 14);
        }
        this.drawPickedStrip(ctx, w, videoView, sel, role, height);
        this.overlayCaption(ctx, w, h, tr("overlay.caption", {target: this.frameOf(sel.target), source: this.frameOf(sel.source), lag: sel.lag}));
    }

    overlayCaption(ctx, w, h, caption) {
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        const tw = ctx.measureText(caption).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(w / 2 - tw / 2 - 8, h - 30, tw + 16, 22);
        ctx.fillStyle = "#fff";
        ctx.fillText(caption, w / 2, h - 14);
    }

    // Select the pair of the frame under the playhead, once per frame, only while paused (a
    // pair selection decodes two frames; during playback the frame changes every render).
    followPlayhead(display) {
        if (!this.job || !par.paused || !Number.isFinite(display)) return;
        if (this.autoPair?.display === display) return;
        const pair = this.job.pairForDisplay(display);
        // only a pair the precise pass accepted (the green part of the strip); a weak one
        // would draw boxes that mean nothing
        const bd = this.job.result?.byDisplay;
        const ok = !!pair && (!bd || bd.matched[pair.source - bd.from] === 1);
        this.autoPair = {display, none: !ok};
        if (ok) this.selectPair(pair.source, pair.target);
    }

    // A click on a strip in the video view picks it, like a click in the pane. The views take
    // their input as pointer events through the interaction router, which cancels the default
    // of pointerdown (so no mouse events follow) and may capture the pointer elsewhere; these
    // listeners therefore sit on the document in the capture phase and only look: a press that
    // starts inside the video view and ends within 4 px of where it started is a click. A drag
    // is left alone, and nothing is prevented or stopped.
    watchVideoClicks(div) {
        if (this.videoClickDiv === div) return;
        if (this.videoClickDiv) {
            document.removeEventListener("pointerdown", this.videoDown, true);
            document.removeEventListener("pointerup", this.videoUp, true);
        }
        this.videoClickDiv = div;
        this.videoPress = null;
        if (!div) return;
        this.videoDown = (e) => {
            const inside = e.button === 0 && e.isPrimary !== false && this.videoClickDiv?.contains(e.target);
            this.videoPress = inside ? {id: e.pointerId, x: e.clientX, y: e.clientY} : null;
        };
        this.videoUp = (e) => {
            const press = this.videoPress;
            if (!press || press.id !== e.pointerId) return;
            this.videoPress = null;
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return;
            this.clickVideo(e);
        };
        document.addEventListener("pointerdown", this.videoDown, true);
        document.addEventListener("pointerup", this.videoUp, true);
    }

    clickVideo(e) {
        const videoView = NodeMan.get("video", false);
        const sel = this.job?.result?.selection;
        if (!this.visible || !this.ui.overlay || !sel || !this.overlay || !videoView?.canvasToVideoCoordsOriginal) return;
        const videoData = videoView.videoData;
        if (videoData?.stabilizationEnabled || (videoData?.effectiveRotation ?? 0) !== 0) return;
        const display = displayIndexForFrame(videoData, par.frame);
        const role = display === sel.target ? "target" : display === sel.source ? "source" : null;
        if (!role) return;
        const rect = this.overlay.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;
        const x = (e.clientX - rect.left) * this.overlay.width / rect.width;
        const y = (e.clientY - rect.top) * this.overlay.height / rect.height;
        const [vx, vy] = videoView.canvasToVideoCoordsOriginal(x, y);
        const height = sel.frameHeight || videoView.originalVideoHeight || 720;
        if (!(vy >= 0 && vy <= height)) return;
        const k = this.selectionBoxes(sel).findIndex(box => {
            const a = role === "target" ? box.x0 : box.sx0, b = role === "target" ? box.x1 : box.sx1;
            return Number.isFinite(a) && Number.isFinite(b) && vx >= Math.min(a, b) && vx < Math.max(a, b);
        });
        if (k < 0) return;
        const again = this.pickIndex(sel) === k;
        this.pick = again ? null : {selection: sel, index: k};
        this.neighbors = null;
        this.drawPair();
        setRenderOne();
    }

    // The picked strip on the video: a 2 px white outline just outside the column, and a row
    // of the SAME strip as it appears in the frames one period apart, pasted directly beside
    // it (+P, +2P ... to the right, -P, -2P ... to the left). Each pasted strip is that frame's
    // ORIGINAL pixels from the playback decoder's cache, drawn through the view's own Video
    // Adjustments so that it looks like the video; a frame outside the cache window is fetched
    // once and its strip kept. Where the strip lands in each frame comes from a pair match
    // between that frame and the frame on screen (the match also decodes the frame).
    adjustmentsKey(videoView) {
        const i = videoView.in ?? {};
        const v = (n) => { const x = i[n]; return x ? (x.v0 ?? x.value ?? "") : ""; };
        return ["enableVideoEffects", "contrast", "brightness", "hue", "saturate", "blur", "shadows", "highlights", "dehaze", "invert"]
            .map(v).join("|");
    }

    // The neighbor list for the pick (built once per pick and side; refreshed as pairs arrive).
    neighborItems(sel, k, role) {
        const nb = this.neighbors;
        if (nb && nb.selection === sel && nb.index === k && nb.role === role) return nb.list;
        const row = sel.assignment?.[k];
        const anchor = sel[role], other = role === "target" ? "source" : "target";
        const list = [];
        if (!row) {
            // no strip numbers (a translated layer): only the pair's other frame
            const box = this.selectionBoxes(sel)[k];
            const a = other === "source" ? box?.sx0 : box?.x0, b = other === "source" ? box?.sx1 : box?.x1;
            if (Number.isFinite(a) && Number.isFinite(b)) list.push({n: sel[other] > anchor ? 1 : -1, display: sel[other], a, b, state: "ready"});
            this.neighbors = {selection: sel, index: k, role, list};
            return list;
        }
        const P = this.job?.result?.verdict?.period || Math.abs(sel.lag) || 0;
        const range = this.job?.result?.range;
        for (let n = -NEIGHBOR_STRIPS; n <= NEIGHBOR_STRIPS; n++) {
            if (!n || !P) continue;
            const display = anchor + n * P;
            if (range && (display < range.from || display > range.to)) continue;
            list.push({n, display, a: NaN, b: NaN, state: "pending"});
        }
        this.neighbors = {selection: sel, index: k, role, list};
        const strip = role === "target" ? row.target : row.source;
        (async () => {
            for (const item of list) {
                if (this.neighbors?.list !== list || !this.job) return;
                try {
                    const before = item.display < anchor;
                    const pair = before ? await this.job.analyzePair(item.display, anchor) : await this.job.analyzePair(anchor, item.display);
                    const rows = pair?.assignment ?? [];
                    const match = before ? rows.find(r => r.target === strip) : rows.find(r => r.source === strip);
                    if (match) {
                        item.a = before ? match.sx0 : match.x0;
                        item.b = before ? match.sx1 : match.x1;
                        item.state = Number.isFinite(item.a) && Number.isFinite(item.b) ? "ready" : "none";
                    } else item.state = "none";
                } catch (error) {
                    item.state = "none";
                }
                setRenderOne();
            }
        })();
        return list;
    }

    // One pasted strip's pixels (original frame, adjusted), kept on the item; null until the
    // frame is available, in which case it is requested once.
    stripCanvas(item, videoView, videoData, key, height, frameWidth) {
        if (item.canvas && item.key === key) return item.canvas;
        const frame = frameForDisplayIndex(videoData, item.display);
        if (!Number.isFinite(frame)) return null;
        const copy = (image) => {
            let source = image, filter = "";
            try {
                const adjusted = videoView.getAdjustedVideoFrameSource?.(image, frame);
                if (adjusted) {
                    if (adjusted.fullABOverlay) return null;   // belongs to the frame on screen
                    source = adjusted.sourceImage || image;
                    filter = adjusted.filter || "";
                }
            } catch (error) { source = image; filter = ""; }
            const scaleX = (source.width || image.width) / (frameWidth || image.width);
            const scaleY = (source.height || image.height) / (height || image.height);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(Math.abs(item.b - item.a)));
            canvas.height = Math.max(1, Math.round(height));
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            ctx.filter = filter || "none";
            ctx.drawImage(source, Math.min(item.a, item.b) * scaleX, 0, Math.max(1, Math.abs(item.b - item.a) * scaleX), height * scaleY,
                0, 0, canvas.width, canvas.height);
            item.canvas = canvas;
            item.key = key;
            return canvas;
        };
        const image = videoData?.getImageNoPurge?.(frame) ?? null;
        if (image) return copy(image);
        if (!item.requested && videoData?.waitForFrame) {
            item.requested = true;
            // copy as soon as it lands: the playback cache may drop a distant frame again
            videoData.waitForFrame(frame).then(() => {
                const later = videoData.getImageNoPurge?.(frame);
                if (later) copy(later);
                setRenderOne();
            }, () => {}).finally(() => { item.requested = false; });
        }
        return null;
    }

    drawPickedStrip(ctx, w, videoView, sel, role, height) {
        const boxes = this.selectionBoxes(sel), k = this.pickIndex(sel);
        if (k < 0 || k >= boxes.length) return;
        const box = boxes[k];
        const a = role === "target" ? box.x0 : box.sx0, b = role === "target" ? box.x1 : box.sx1;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return;
        const [x0, y0] = videoView.videoToCanvasCoordsOriginal(Math.min(a, b), 0);
        const [x1, y1] = videoView.videoToCanvasCoordsOriginal(Math.max(a, b), height);
        const sw = x1 - x0, sh = y1 - y0;
        const videoData = videoView.videoData;
        const key = this.adjustmentsKey(videoView);
        const place = (n) => n > 0 ? x1 + 2 + (n - 1) * (sw + 2) : x0 - 2 - sw - (-n - 1) * (sw + 2);
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        for (const item of this.neighborItems(sel, k, role)) {
            const left = place(item.n);
            if (left < 0 || left + sw > w) continue;
            if (item.state !== "ready") {
                if (item.state === "pending") {
                    ctx.strokeStyle = "rgba(255,255,255,0.35)";
                    ctx.lineWidth = 1;
                    ctx.strokeRect(left - 0.5, y0 - 0.5, sw + 1, sh + 1);
                }
                continue;
            }
            const canvas = this.stripCanvas(item, videoView, videoData, key, height, sel.frameWidth);
            if (!canvas) {
                ctx.strokeStyle = "rgba(255,255,255,0.35)";
                ctx.lineWidth = 1;
                ctx.strokeRect(left - 0.5, y0 - 0.5, sw + 1, sh + 1);
                continue;
            }
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(canvas, left, y0, sw, sh);
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1;
            ctx.strokeRect(left - 0.5, y0 - 0.5, sw + 1, sh + 1);
            ctx.fillStyle = "#fff";
            ctx.fillText(String(this.frameOf(item.display)), left + sw / 2, y0 + 28);
        }
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 - 1, y0 - 1, sw + 2, sh + 2);
    }

    // ---- text

    selectionIn(node) {
        const selection = node.ownerDocument.getSelection();
        return !!selection && !selection.isCollapsed && node.contains(selection.anchorNode);
    }

    setDetails(text) {
        this.detailsTextValue = text;
        if (this.detailsEl.textContent === text || this.selectionIn(this.detailsEl)) return;
        this.detailsEl.textContent = text;
    }

    detailsText(r) {
        if (!r) return tr("details.none");
        const lines = [];
        const o = r.options;
        const push = (...xs) => lines.push(...xs);
        push(tr("details.video"));
        push(`  ${r.video.name || "—"}  ${r.video.width}x${r.video.height}  ${r.video.codec}  ${int(r.video.frames)} ${tr("view.frames")}`);
        push(`  ${tr("details.decoded", {mode: r.representation.mode === "display" ? tr("details.displayRGB") : tr("details.nativeYUV", {bits: r.representation.bits}),
            accel: r.representation.accel || "—"})}`);
        push(`  ${tr("details.range", {from: this.frameOf(r.range.from), to: this.frameOf(r.range.to)})}`);
        push(`  ${tr("details.settings", {lag: o.longestLag, detail: o.detail, vertical: o.vertical, held: o.held, frames: o.frames, search: o.searchOn})}`);
        push("", tr("details.frames"));
        const c = r.counts;
        push(`  ${tr("details.counts", {decoded: int(c.decoded), frames: int(c.frames), failed: int(c.failed), held: int(c.held),
            y: int(c.valid?.[0]), cb: int(c.valid?.[1]), cr: int(c.valid?.[2]), sequence: int(c.sequence), unit: this.unit(r)})}`);
        if (c.mergedKeyFrames) push(`  ${tr("details.mergedKeyFrames", {n: int(c.mergedKeyFrames)})}`);
        if (c.decodeErrors) push(`  ${tr("details.decodeErrors", {n: int(c.decodeErrors), skipped: int(c.skippedSegments),
            prerolled: int(c.prerolledSegments), error: c.lastDecodeError || "—"})}`);
        if (r.lags) {
            push("", tr("details.lagScan", {references: r.lags.R, lmax: r.lags.lmax, lagMin: LAG_MIN, unit: this.unit(r)}));
            push(`  ${"curve".padEnd(8)} ${"period".padStart(6)} ${"strength".padStart(8)} ${"coverage".padStart(8)}  peaks (lag z)`);
            for (const name of CURVES) {
                const cv = r.curves[name];
                if (!cv) continue;
                const peaks = (cv.peaks ?? []).slice(0, 8).map(p => `${p.lag} (${fmt(p.z, 1)})`).join(", ");
                push(`  ${name.padEnd(8)} ${String(cv.period ?? "—").padStart(6)} ${(cv.period ? fmt(cv.strength, 1) : "—").padStart(8)} ${(cv.period ? `${cv.coverage}/${r.lags.R}` : "—").padStart(8)}  ${peaks || "—"}`);
            }
        }
        const v = r.verdict;
        push("", tr("details.verdict"), `  ${this.verdictText.textContent.split("\n").join("\n  ")}`);
        if (v?.isolated?.length) push(`  ${tr("details.isolated", {list: v.isolated.slice(0, 12).map(s => `${s.lag} ${s.curve} z ${fmt(s.z, 1)}`).join("; ")})}`);
        if (r.precise) {
            const p = r.precise;
            push("", tr("details.matches"));
            push(`  ${tr("details.matchCounts", {tested: int(p.tested), matched: int(p.matched), raw: int(p.rawMatched), pairs: int(p.pairs), controls: int(p.controls), floor: p.floor})}`);
            push(`  ${tr("details.runs", {runs: p.runs.map(([a, b]) => `${this.frameOf(a)}–${this.frameOf(b)}`).join(", ") || "—"})}`);
            if (r.longRange) push(`  ${tr("details.longest", {lag: int(r.longRange.lag), source: this.frameOf(r.longRange.source), target: this.frameOf(r.longRange.target), score: fmt(r.longRange.C), tau: fmt(r.longRange.tau)})}`);
            if (r.pictureRepeat) push(`  ${tr("details.picture", {repeats: r.pictureRepeat.repeats ? tr("details.yes") : tr("details.no"),
                matched: fmt(r.pictureRepeat.matchedMedian), control: fmt(r.pictureRepeat.controlMedian)})}`);
        }
        if (r.refine) {
            const {lattice, rule, pairs} = r.refine;
            if (lattice) push("", tr("details.lattice"), `  ${tr("details.latticeLine", {w: fmt(lattice.w, 3), origin: fmt(lattice.origin, 2),
                n: lattice.n, R: fmt(lattice.R, 3), accepted: lattice.accepted ? tr("details.yes") : tr("details.no")})}`);
            if (rule) {
                push("", tr("details.rule"), `  ${tr("details.ruleLine", {kind: rule.kind, fit: rule.fitPairs, total: rule.total,
                    w: fmt(rule.w, 3), origin: fmt(rule.origin, 2), k0: rule.k0})}`);
                push(`  ${"target ← source".padEnd(18)} ${"lag".padStart(5)} ${"score".padStart(6)}  xor d (fit)   shift px (fit)`);
                for (const pair of pairs) {
                    const x = pair.fit?.xor, s = pair.fit?.translation;
                    push(`  ${`${this.frameOf(pair.target)} ← ${this.frameOf(pair.source)}`.padEnd(18)} ${String(pair.lag).padStart(5)} ${fmt(pair.C).padStart(6)}  ${x ? `${x.d} (${Math.round(100 * x.fit)}%)` : "—"}`.padEnd(48) + `${s ? `${fmt(s.shift, 0)} (${Math.round(100 * s.fit)}%)` : "—"}`);
                }
            }
        }
        const sel = r.selection;
        if (sel) {
            push("", tr("details.selected", {source: this.frameOf(sel.source), target: this.frameOf(sel.target), lag: sel.lag}));
            push(`  ${tr("details.selectedLine", {score: fmt(sel.C), tau: fmt(sel.tau), valid: sel.nValid, shift: fmt(sel.shift, 0),
                confident: sel.probes.confident, inStrip: sel.probes.inStrip, whole: fmt(100 * sel.probes.wholeStripFraction, 0)})}`);
            if (sel.xor) push(`  ${tr("details.selectedXor", {d: sel.xor.d, fit: Math.round(100 * sel.xor.fit), probes: sel.xor.probes})}`);
            if (sel.assignment?.length) {
                push(`  ${tr("details.stripMap")}`);
                push("  " + sel.assignment.map(a => `${a.target}←${a.source}${a.share < 0.7 ? "?" : ""}(${fmt(a.margin, 2)})`).join(" "));
            }
        }
        push("", tr("details.timings", {start: r.visibility.start, end: r.visibility.end ?? "—"}));
        const tm = r.timings;
        push(`  ${tr("details.timingSpawn", {spawn: ms(tm.spawn), lanes: r.backend.lanes, decodeLanes: r.backend.decodeLanes})}`);
        if (r.cached) push(`  ${tr("details.timingCached")}`);
        else push(`  ${tr("details.timingIngest", {time: ms(tm.ingest), fps: int(r.throughput.ingestFps), accel: r.representation.accel || "—"})}`,
            `  ${tr("details.timingPrep", {held: ms(tm.held), prep: ms(tm.prep)})}`);
        const cal = r.backend.calibration;
        if (tm.gpuSetup !== undefined) push(`  ${tr("details.timingGpuSetup", {time: ms(tm.gpuSetup)})}`);
        if (cal) push(`  ${tr("details.timingCalibration", {time: ms(tm.calibration), pairs: cal.pairs, cpu: int(cal.cpuPairsPerSec), gpu: int(cal.gpuPairsPerSec), delta: fmt(cal.maxDeltaC, 3)})}`);
        push(`  ${tr("details.timingCoarse", {time: ms(tm.coarse), search: ms(tm.coarseSearch), rate: int(r.throughput.coarsePairsPerSec), backend: r.throughput.coarseBackend ?? "—"})}`);
        push(`  ${tr("details.timingRest", {precise: ms(tm.precise), longRange: ms(tm.longRange), refine: ms(tm.refine)})}`);
        push(`  ${tr("details.timingTotal", {total: ms(tm.total), slice: fmt(r.mainThreadMaxMs, 1)})}`);
        push(`  ${tr("details.backend", {search: r.backend.search ?? "—", reason: r.backend.reason || "—"})}`);
        if (r.backend.adapter) push(`  ${tr("details.adapter", {vendor: r.backend.adapter.vendor || "—", architecture: r.backend.adapter.architecture || "—",
            packed: r.backend.adapter.packedDot ? tr("details.yes") : tr("details.no")})}`);
        if (r.benchmark || this.benchmarkError) {
            push("", tr("details.benchmark"));
            if (this.benchmarkError) push(`  ${this.benchmarkError}`);
            for (const row of r.benchmark?.rows ?? []) {
                push(`  ${row.stage.padEnd(8)} ${row.backend.padEnd(4)} ${ms(row.ms).padStart(9)} ${(int(row.rate) + " " + row.unit).padStart(18)}${row.maxDeltaC !== undefined ? `  max |ΔC| ${fmt(row.maxDeltaC, 3)}` : ""}${row.note ? `  ${row.note}` : ""}`);
            }
        }
        return lines.join("\n");
    }

    // ---- export

    async exportCSV() {
        const r = this.job?.result;
        if (!r) return;
        const lines = [];
        const csv = (...values) => lines.push(values.map(v => {
            const s = v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(","));
        csv("section", "noise pattern detection", r.video.name, `${r.video.width}x${r.video.height}`, JSON.stringify(r.options));
        csv("verdict", r.verdict?.kind, r.verdict?.curve, r.verdict?.period, r.verdict?.strength, r.verdict?.coverage);
        lines.push("");
        if (r.lags) {
            csv("section", "lag curves", `references ${r.lags.R}`, `unit ${r.picture ? "pictures" : "frames"}`);
            csv("lag", ...CURVES.flatMap(name => [name, `z ${name}`]), "S-Cb shift px");
            for (let L = 1; L <= r.lags.lmax; L++) {
                csv(L, ...CURVES.flatMap(name => [r.curves[name]?.values?.[L - 1], r.curves[name]?.z?.[L - 1]]),
                    medianShift(r.curves["S-Cb"], r.lags, L));
            }
            lines.push("");
        }
        if (r.byDisplay) {
            csv("section", "frames");
            csv("frame", "displayIndex", "decoded", "heldScore", "held", "tested", "score", "threshold", "matched");
            const bd = r.byDisplay;
            for (let row = 0; row < bd.rows; row++) {
                const d = bd.from + row;
                csv(this.frameOf(d), d, bd.decoded[row], bd.heldScore?.[row], bd.held[row], bd.tested[row], bd.score[row], bd.tau[row], bd.matched[row]);
            }
            lines.push("");
        }
        if (r.refine?.pairs?.length) {
            csv("section", "refined pairs", `rule ${r.refine.rule?.kind}`, `w ${r.refine.rule?.w}`, `origin ${r.refine.rule?.origin}`, `k0 ${r.refine.rule?.k0}`);
            csv("sourceFrame", "targetFrame", "lag", "score", "xorD", "xorFit", "shiftPx", "shiftFit");
            for (const p of r.refine.pairs) {
                csv(this.frameOf(p.source), this.frameOf(p.target), p.lag, p.C, p.fit?.xor?.d, p.fit?.xor?.fit, p.fit?.translation?.shift, p.fit?.translation?.fit);
            }
            lines.push("");
        }
        const sel = r.selection;
        if (sel?.map) {
            csv("section", "selected pair probes", `source ${this.frameOf(sel.source)}`, `target ${this.frameOf(sel.target)}`);
            csv("probeCenterPx", "offsetPx", "best", "margin", "valid", "confident");
            for (let k = 0; k < sel.map.count; k++) csv(sel.map.x[k], sel.map.dl[k], sel.map.c1[k], sel.map.margin[k], sel.map.valid[k], sel.map.confident[k]);
        }
        const {saveAs} = await import("file-saver");
        saveAs(new Blob([lines.join("\n")], {type: "text/csv;charset=utf-8"}), "VideoNoisePattern.csv");
    }
}

function medianShift(curve, lags, L) {
    if (!curve?.shift) return NaN;
    const values = [];
    for (let a = 0; a < lags.R; a++) { const v = curve.shift[a * lags.lmax + L - 1]; if (Number.isFinite(v)) values.push(v); }
    if (!values.length) return NaN;
    values.sort((x, y) => x - y);
    return values[values.length >> 1];
}

export function createVideoNoisePatternView(id, options) {
    return new CNodeVideoNoisePatternView({id, options, menuName: tr("view.title"),
        visible: true, left: 0.56, top: 0.06, width: 0.42, height: 0.86,
        draggable: true, resizable: true, freeAspect: true, shiftDrag: false});
}
