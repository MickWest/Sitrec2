import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {Sit, setRenderOne} from "../Globals";

/**
 * Real-time audio spectrum analyzer view for the loaded video/audio soundtrack.
 *
 * A classic analyzer plot: logarithmic frequency on X (3 Hz – 20 kHz), dB on Y
 * with a 6 dB grid. Stereo sources draw one trace per channel (bright = left,
 * darker = right); mono draws a single trace. The strongest peaks are labeled
 * with their frequency in Hz.
 *
 * All spectra come from a 32768-point FFT (~1.5 Hz bins at 48 kHz — needed to
 * resolve the 3 Hz bottom end) of the decoded AudioBuffer, windowed CENTERED on
 * the playhead. Centered, not trailing: the Blackman window weights the middle
 * of its 0.68 s span most heavily, so a window that merely ended at the playhead
 * would effectively show the audio as it was ~0.34 s earlier — a visible lag
 * when the content sweeps in frequency. That one path serves playback,
 * scrubbing, paused stepping, and muted playback alike, and it runs in a Web
 * Worker (AudioSpectrumWorker.js) so
 * the per-frame FFTs never block the render loop: the view posts the playhead
 * sample offset, the worker replies with per-channel dB arrays, and a
 * latest-wins backpressure scheme drops intermediate positions if the worker
 * falls behind.
 *
 * Costs nothing while hidden: the render loop only calls renderCanvas() on
 * effectively-visible views, so no worker requests are made. poppable /
 * renderWhileWindowed: can pop out into its own browser window and keeps
 * animating there via the popup's own requestAnimationFrame loop.
 */

const DB_TOP = -18;         // dB at the top edge of the plot
const DB_BOTTOM = -90;      // dB at the bottom edge of the plot
const DB_GRID_STEP = 6;     // horizontal gridline spacing in dB
const FREQ_MIN = 3;         // Hz at the left edge
const FREQ_MAX_CAP = 20000; // Hz cap for the right edge (min with Nyquist)
const FFT_SIZE = 32768;     // power of two; ~1.5 Hz bins at 48 kHz
const SMOOTH = 0.5;         // blend factor for successive spectra (analyser-like)
const LABEL_TOP = 26;       // y of the frequency axis labels — below the ~24px view header
const PEAK_LABELS = 3;      // how many spectral peaks get a frequency readout
const PEAK_MIN_DIP_DB = 6;  // required dB dip between two labeled peaks (prominence)
const PEAK_FLOOR_DB = DB_BOTTOM + 3;  // ignore "peaks" at the noise floor
const PEAK_MAX_CANDIDATES = 200;      // bound the distinctness scans on noisy spectra
// Blackman-window leakage envelope: peak sidelobe -58 dB re the mainlobe at ~4 bins
// out, decaying ~18 dB per octave of bin distance beyond that. Candidates at or
// below a picked peak's envelope (+margin) are indistinguishable from that peak's
// own spectral leakage, so they never get a label.
const PEAK_SIDELOBE_DB = 58;
const PEAK_SIDELOBE_FIRST_BIN = 4;
const PEAK_SIDELOBE_ROLLOFF = 18;   // dB per octave of bin distance
const PEAK_SIDELOBE_MARGIN = 6;

export class CNodeAudioSpectrumView extends CNodeViewCanvas2D {
    constructor(v) {
        super({
            visible: false,
            background: [0, 0, 0, 0],
            draggable: true,
            resizable: true,
            freeAspect: true,
            doubleClickFullScreen: false,
            alwaysOnTop: true,
            poppable: true,
            dockable: true,
            renderWhileWindowed: true,
            ...v,
        });

        this.videoView = v.videoView;
        this.chanDb = null;      // per-channel smoothed dB arrays (display state)
        this.haveData = false;   // true once at least one spectrum has arrived
        this.lastHandler = null;
        this.worker = null;
        this._workerBuffer = null;
        this._workerGen = 0;
        this._sampleRate = 48000;
        this._inFlight = false;
        this._pendingStart = null;
        this._lastRequestedStart = null;
        this._lastAppliedStart = null;
        this._combined = null;   // max(L,R) scratch for peak picking
        this.div.style.border = "1px solid rgba(255,255,255,0.22)";
        this.div.style.boxShadow = "0 2px 8px rgba(0,0,0,0.45)";
    }

    dispose() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.chanDb = null;
        this._combined = null;
        this.lastHandler = null;
        this._workerBuffer = null;
        super.dispose();
    }

    // The audio handler lives on the current videoData and is replaced whenever a
    // new video loads, so re-resolve every render.
    getAudioHandler() {
        const handler = this.videoView?.videoData?.audioHandler;
        return (handler && handler.audioContext) ? handler : null;
    }

    // Full decoded AudioBuffer. The MP3/WAV handler exposes it directly; the MP4
    // handler builds it lazily on first playback, so if the user opens the analyzer
    // before ever playing, build it here once decoding has finished (same call +
    // success flag that playAudioBuffer uses).
    getScrubBuffer(handler) {
        if (handler.audioBuffer) return handler.audioBuffer;
        if (handler.createAudioBuffer && handler.checkDecodingComplete && handler.checkDecodingComplete()) {
            if (handler.createAudioBuffer()) {
                handler._bufferCreatedSuccessfully = true;
                return handler.audioBuffer;
            }
        }
        return null;
    }

    // Drop all spectrum state AND invalidate any in-flight worker replies. Must be
    // used for every reset — a reply computed from the previous audio can arrive
    // after the source changed, and without the gen bump it would repopulate
    // chanDb/haveData with the old source's spectrum.
    resetSpectrumState() {
        this._workerGen++;
        this._workerBuffer = null;
        this._inFlight = false;
        this._pendingStart = null;
        this._lastRequestedStart = null;
        this._lastAppliedStart = null;
        this.haveData = false;
        this.chanDb = null;
    }

    // Send the audio to the worker (copies of up to two channels) when it changes.
    ensureWorkerFor(buffer) {
        if (this._workerBuffer === buffer) return;
        if (!this.worker) {
            this.worker = new Worker(new URL("../workers/AudioSpectrumWorker.js", import.meta.url));
            this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
        }
        this.resetSpectrumState();
        this._workerBuffer = buffer;
        this._sampleRate = buffer.sampleRate;
        const channels = [];
        for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
            channels.push(buffer.getChannelData(c).slice());
        }
        this.worker.postMessage(
            {type: "init", channels, fftSize: FFT_SIZE},
            channels.map(ch => ch.buffer)
        );
    }

    // Latest-wins backpressure: at most one FFT request in flight; if the playhead
    // moves again meanwhile, only the newest position is kept for the next round.
    requestSpectrum(start) {
        if (!this.worker || start === this._lastRequestedStart) return;
        if (this._inFlight) {
            this._pendingStart = start;
            return;
        }
        this._inFlight = true;
        this._lastRequestedStart = start;
        this.worker.postMessage({type: "compute", start, gen: this._workerGen});
    }

    onWorkerMessage(msg) {
        if (msg.type !== "spectrum" || msg.gen !== this._workerGen) return;  // stale audio
        this._inFlight = false;

        const bins = msg.dbs[0].length;
        if (!this.chanDb || this.chanDb.length !== msg.dbs.length || this.chanDb[0].length !== bins) {
            this.chanDb = msg.dbs.map(() => new Float32Array(bins).fill(DB_BOTTOM));
            this._lastAppliedStart = null;
        }
        // Smooth successive spectra like an analyser would, but snap on big playhead
        // jumps so scrubbing across the timeline shows the new position immediately.
        const jump = this._lastAppliedStart === null || Math.abs(msg.start - this._lastAppliedStart) > FFT_SIZE;
        for (let c = 0; c < this.chanDb.length; c++) {
            const src = msg.dbs[c];
            const dst = this.chanDb[c];
            for (let i = 0; i < bins; i++) {
                let v = src[i];
                if (!(v > DB_BOTTOM)) v = DB_BOTTOM;
                dst[i] = jump ? v : dst[i] + (v - dst[i]) * SMOOTH;
            }
        }
        this._lastAppliedStart = msg.start;
        this.haveData = true;

        if (this._pendingStart !== null) {
            const s = this._pendingStart;
            this._pendingStart = null;
            this.requestSpectrum(s);
        }
        setRenderOne(true);   // repaint even when paused/scrubbing
    }

    xForFreq(f, w, freqMax) {
        return Math.log(f / FREQ_MIN) / Math.log(freqMax / FREQ_MIN) * w;
    }

    yForDb(db, h) {
        return (DB_TOP - db) / (DB_TOP - DB_BOTTOM) * h;
    }

    // dB value for the pixel column covering frequencies [fA, fB): peak of the FFT
    // bins in range, or linear interpolation where a column spans less than one bin
    // (the low end of a log axis).
    sampleDb(data, binHz, fA, fB) {
        const n = data.length;
        const a = fA / binHz;
        const b = fB / binHz;
        if (b - a <= 1) {
            const c = (a + b) * 0.5;
            const i = Math.max(0, Math.min(n - 1, Math.floor(c)));
            const j = Math.min(n - 1, i + 1);
            const frac = c - i;
            return data[i] + (data[j] - data[i]) * frac;
        }
        const lo = Math.max(0, Math.floor(a));
        const hi = Math.min(n - 1, Math.ceil(b));
        let m = -Infinity;
        for (let i = lo; i <= hi; i++) {
            if (data[i] > m) m = data[i];
        }
        return m;
    }

    drawGrid(ctx, w, h, freqMax) {
        const hairline = 1 / this.devicePixelRatio;
        // The hover-reveal/pinnable view header overlays the top ~24px of the canvas
        // (it does not inset the content), so keep labels below that strip (LABEL_TOP).
        ctx.font = "10px sans-serif";

        // Vertical lines: 1-2-...-9 steps per decade, brighter at 10/100/1k/10k.
        // Labels adapt to the panel width: majors always, then 2/5 steps, then every
        // step — each drawn only where it doesn't collide with an already-placed label,
        // so a wide panel gets the full 4/5/…/900/1k/2k/… detail automatically.
        const labelTiers = [[], [], []];
        for (let decade = 1; decade < freqMax; decade *= 10) {
            for (let mult = 1; mult < 10; mult++) {
                const f = decade * mult;
                if (f < FREQ_MIN || f > freqMax) continue;
                const major = mult === 1 && f >= 10;
                const x = this.xForFreq(f, w, freqMax);
                ctx.strokeStyle = major ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)";
                ctx.lineWidth = hairline;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
                labelTiers[major ? 0 : (mult === 2 || mult === 5 ? 1 : 2)].push({f, x});
            }
        }

        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const placed = [];
        for (let tier = 0; tier < 3; tier++) {
            ctx.fillStyle = tier === 0 ? "rgba(255,255,255,0.60)" : "rgba(255,255,255,0.42)";
            for (const {f, x} of labelTiers[tier]) {
                if (x < 14 || x > w - 14) continue;
                const text = f >= 1000 ? (f / 1000) + "k" : String(f);
                const halfWidth = ctx.measureText(text).width / 2 + 4;
                if (placed.some(p => x - halfWidth < p[1] && x + halfWidth > p[0])) continue;
                placed.push([x - halfWidth, x + halfWidth]);
                ctx.fillText(text, x, LABEL_TOP);
            }
        }

        // Horizontal lines every 6 dB, labeled on the left
        for (let db = DB_TOP - DB_GRID_STEP; db >= DB_BOTTOM; db -= DB_GRID_STEP) {
            const y = this.yForDb(db, h);
            ctx.strokeStyle = "rgba(255,255,255,0.12)";
            ctx.lineWidth = hairline;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
            if (y > LABEL_TOP + 12 && y < h - 2) {
                ctx.fillStyle = "rgba(255,255,255,0.55)";
                ctx.textAlign = "left";
                ctx.textBaseline = "bottom";
                ctx.fillText(String(db), 3, y - 1);
            }
        }
    }

    // Label the strongest spectral peaks with their frequency in Hz (1 decimal place).
    // Peaks are local maxima of the (channel-max) trace, taken strongest-first. Two
    // filters make the picks physically meaningful, both computed in bin space so the
    // picked set does not change with panel size:
    // - prominence: the trace must dip at least PEAK_MIN_DIP_DB below the weaker of
    //   two peaks somewhere between them, so shoulder bumps on one mountain don't
    //   spend all the labels;
    // - leakage: candidates at or below a stronger picked peak's Blackman sidelobe
    //   envelope at that bin distance are that peak's own FFT leakage, not signal
    //   (a dip test alone can never reject sidelobes — the nulls between them are
    //   arbitrarily deep).
    // Sub-bin frequency precision comes from parabolic interpolation of the dB values
    // around the peak bin. Overlapping labels stack upward at draw time.
    drawPeakLabels(ctx, data, binHz, w, h, freqMax) {
        const loBin = Math.max(1, Math.ceil(FREQ_MIN / binHz));
        const hiBin = Math.min(data.length - 2, Math.floor(freqMax / binHz));

        const candidates = [];
        for (let i = loBin; i <= hiBin; i++) {
            const v = data[i];
            if (v <= PEAK_FLOOR_DB) continue;
            if (v >= data[i - 1] && v > data[i + 1]) candidates.push({i, v});
        }
        candidates.sort((a, b) => b.v - a.v);
        if (candidates.length > PEAK_MAX_CANDIDATES) candidates.length = PEAK_MAX_CANDIDATES;

        const picked = [];
        for (const c of candidates) {
            if (picked.length >= PEAK_LABELS) break;
            let distinct = true;
            for (const p of picked) {
                // candidates are strongest-first, so c is the weaker of the pair
                const d = Math.abs(c.i - p.i);
                const octaves = d > PEAK_SIDELOBE_FIRST_BIN ? Math.log2(d / PEAK_SIDELOBE_FIRST_BIN) : 0;
                const envelope = p.v - PEAK_SIDELOBE_DB - PEAK_SIDELOBE_ROLLOFF * octaves;
                if (c.v < envelope + PEAK_SIDELOBE_MARGIN) {
                    distinct = false;
                    break;
                }
                const lo = Math.min(p.i, c.i);
                const hi = Math.max(p.i, c.i);
                let minBetween = Infinity;
                for (let i = lo; i <= hi; i++) {
                    if (data[i] < minBetween) minBetween = data[i];
                }
                if (minBetween > c.v - PEAK_MIN_DIP_DB) {
                    distinct = false;
                    break;
                }
            }
            if (!distinct) continue;
            const y0 = data[c.i - 1], y1 = data[c.i], y2 = data[c.i + 1];
            const denom = y0 - 2 * y1 + y2;
            let offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
            if (!(offset > -0.5 && offset < 0.5)) offset = 0;
            picked.push({i: c.i, v: c.v, freq: (c.i + offset) * binHz});
        }
        if (!picked.length) return;

        ctx.save();
        ctx.font = "15px sans-serif";    // 1.5x the axis label font
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(228,246,255,0.95)";
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 3;
        picked.sort((a, b) => a.i - b.i);
        const boxes = [];
        for (const p of picked) {
            const peakY = this.yForDb(Math.min(DB_TOP, p.v), h);
            const text = p.freq.toFixed(1);
            const halfWidth = ctx.measureText(text).width / 2 + 2;
            const lx = Math.max(halfWidth, Math.min(w - halfWidth, this.xForFreq(p.freq, w, freqMax)));
            // just above the peak, kept clear of the frequency axis labels / header;
            // if it would overlap an already-drawn label, stack it above that one
            let ly = Math.max(LABEL_TOP + 26, peakY - 4);
            for (const b of boxes) {
                if (lx - halfWidth < b.x1 && lx + halfWidth > b.x0 && ly > b.y - 16) {
                    ly = b.y - 16;
                }
            }
            ly = Math.max(12, ly);
            boxes.push({x0: lx - halfWidth, x1: lx + halfWidth, y: ly});
            ctx.fillText(text, lx, ly);
        }
        ctx.restore();
    }

    drawTrace(ctx, data, binHz, w, h, freqMax, color) {
        const logRange = Math.log(freqMax / FREQ_MIN);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (let px = 0; px <= w; px++) {
            const fA = FREQ_MIN * Math.exp(logRange * px / w);
            const fB = FREQ_MIN * Math.exp(logRange * (px + 1) / w);
            let v = this.sampleDb(data, binHz, fA, fB);
            if (!(v > DB_BOTTOM)) v = DB_BOTTOM;    // also catches -Infinity/NaN
            if (v > DB_TOP) v = DB_TOP;
            const y = this.yForDb(v, h);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }
        ctx.stroke();
    }

    renderCanvas(frame = 0) {
        super.renderCanvas(frame);
        if (!this.visible) return;

        const ctx = this.ctx;
        const w = this.widthPx;
        const h = this.heightPx;
        if (!ctx || w <= 0 || h <= 0) return;

        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(30,32,34,0.94)";
        ctx.fillRect(0, 0, w, h);

        const handler = this.getAudioHandler();
        if (handler !== this.lastHandler) {
            // new video/audio loaded (or removed) — drop the old spectrum and
            // invalidate any in-flight worker reply from the old audio
            this.lastHandler = handler;
            this.resetSpectrumState();
        }

        const buffer = handler ? this.getScrubBuffer(handler) : null;
        if (buffer) {
            this.ensureWorkerFor(buffer);
            const fps = handler.originalFps || Sit.fps || 30;
            // Window centered on the playhead (see class comment); the worker
            // zero-pads any part outside the audio.
            const center = Math.floor(frame / fps * this._sampleRate);
            let start = center - (FFT_SIZE >> 1);
            // Fully outside the audio the window is all zeros — clamp for a stable key.
            if (start < -FFT_SIZE) start = -FFT_SIZE;
            if (start > buffer.length) start = buffer.length;
            this.requestSpectrum(start);
        }

        const sampleRate = this._sampleRate;
        const freqMax = Math.min(FREQ_MAX_CAP, sampleRate / 2);
        this.drawGrid(ctx, w, h, freqMax);

        if (this.haveData && this.chanDb) {
            const binHz = sampleRate / FFT_SIZE;
            // right channel behind in darker blue, left on top in bright cyan-white
            if (this.chanDb.length > 1) {
                this.drawTrace(ctx, this.chanDb[1], binHz, w, h, freqMax, "rgba(96,140,168,0.95)");
            }
            this.drawTrace(ctx, this.chanDb[0], binHz, w, h, freqMax, "rgba(214,240,250,0.95)");

            // peak labels from the loudest of the channels at each bin
            let peakSource = this.chanDb[0];
            if (this.chanDb.length > 1) {
                const bins = peakSource.length;
                if (!this._combined || this._combined.length !== bins) {
                    this._combined = new Float32Array(bins);
                }
                const L = this.chanDb[0], R = this.chanDb[1], M = this._combined;
                for (let i = 0; i < bins; i++) M[i] = L[i] > R[i] ? L[i] : R[i];
                peakSource = M;
            }
            this.drawPeakLabels(ctx, peakSource, binHz, w, h, freqMax);
        } else {
            const msg = !handler ? "No audio" : "Waiting for audio to decode…";
            ctx.fillStyle = "rgba(255,255,255,0.4)";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(msg, w / 2, h / 2);
        }

        ctx.restore();
    }
}
