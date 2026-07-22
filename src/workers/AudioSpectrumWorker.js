// Web Worker for CNodeAudioSpectrumView: windows and FFTs audio sample data off
// the main thread. The view sends the decoded channel data once per audio load
// ("init"), then per-playhead-move "compute" requests; each reply carries one dB
// spectrum per channel (up to stereo), with the big arrays transferred, not copied.
//
// The 32768-point FFT (~1.5 Hz bins at 48 kHz, resolving down to the view's 3 Hz
// left edge) takes a few ms per channel — cheap enough for per-frame updates, but
// long enough that doing it on the main thread would eat into the render budget.

let channels = [];
let fftSize = 32768;
let win = null;     // Blackman window — matches the scaling convention of the Web
                    // Audio AnalyserNode (window, FFT, |X|/N, then dB)
let re = null;
let im = null;

function buildTables() {
    win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
        const t = 2 * Math.PI * i / fftSize;
        win[i] = 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
    }
    re = new Float32Array(fftSize);
    im = new Float32Array(fftSize);
}

// In-place iterative radix-2 complex FFT (Cooley-Tukey). fftSize is a power of two.
function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let k = 0; k < half; k++) {
                const a = i + k;
                const b = a + half;
                const tRe = re[b] * curRe - im[b] * curIm;
                const tIm = re[b] * curIm + im[b] * curRe;
                re[b] = re[a] - tRe;
                im[b] = im[a] - tIm;
                re[a] += tRe;
                im[a] += tIm;
                const nRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = nRe;
            }
        }
    }
}

// dB spectrum of the fftSize samples starting at `start` (the view chooses where —
// currently centered on the playhead). Samples outside the channel are zeros, which
// handles clips shorter than the FFT and windows overlapping the start or end of
// the audio.
function computeDb(ch, start) {
    const total = ch.length;
    for (let i = 0; i < fftSize; i++) {
        const s = start + i;
        re[i] = (s >= 0 && s < total ? ch[s] : 0) * win[i];
        im[i] = 0;
    }
    fftInPlace(re, im);
    const bins = fftSize >> 1;
    const out = new Float32Array(bins);
    const scale = 1 / fftSize;
    for (let i = 0; i < bins; i++) {
        out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) * scale + 1e-12);
    }
    return out;
}

self.onmessage = (e) => {
    const d = e.data;
    if (d.type === "init") {
        channels = d.channels;
        fftSize = d.fftSize;
        buildTables();
    } else if (d.type === "compute") {
        if (!channels.length || !win) return;
        const dbs = channels.map(ch => computeDb(ch, d.start));
        self.postMessage(
            {type: "spectrum", gen: d.gen, start: d.start, dbs},
            dbs.map(a => a.buffer)
        );
    }
};
