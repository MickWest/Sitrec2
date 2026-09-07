// The video export filter chain: takes the exporter's composite canvas and returns a
// canvas carrying the same frame after an analog signal round trip and, optionally,
// a simulated pass through a phone camera pointed at a screen.
//
// Everything time-varying (tape wobble, auto-exposure, handheld sway) is driven by a
// frame counter this class owns rather than by wall-clock time, so an export renders
// identically however long the encoder takes per frame.

import {GLFilterContext} from "./GLFilterContext";
import {
    BLUR_SHADER,
    BRIGHT_SHADER,
    CHROMA_LOWPASS_SHADER,
    COPY_SHADER,
    DEMODULATE_SHADER,
    DOWNSAMPLE_SHADER,
    MODULATE_SHADER,
    RESAMPLE_SHADER,
    SCREEN_SHADER,
    TAPE_SHADER,
} from "./videoFilterShaders";
import {SIGNAL_FORMATS} from "./VideoFilterSettings";
import {mapSourceToOutputPixels} from "./screenGeometry";

// Deterministic 1D value noise for the slow drifts. Sines rather than a hash table so
// the motion is reproducible across runs and machines without carrying any state.
function hash1(n) {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

function vnoise(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

// Centred noise in -1..1.
function cnoise(x) {
    return vnoise(x) * 2 - 1;
}

export class AnalogVideoFilter {
    /**
     * @param {object} options
     * @param {number} options.width      output width in pixels (even)
     * @param {number} options.height     output height in pixels (even)
     * @param {object} options.settings   VideoFilterSettings-shaped object
     * @param {number} [options.fps]      output frame rate, for the time-based motion
     */
    constructor({width, height, settings, fps = 30}) {
        this.width = width;
        this.height = height;
        this.settings = settings;
        this.fps = fps || 30;
        this.frame = 0;

        this.signal = settings.signal;
        this.screen = settings.screen;
        this.format = SIGNAL_FORMATS[this.signal.format] ?? SIGNAL_FORMATS.digital;
        this.analogEnabled = this.signal.format !== "digital";
        this.screenEnabled = !!this.screen.enabled;

        this.ctx = new GLFilterContext(width, height);
        this.programs = {
            resample: this.ctx.program("resample", RESAMPLE_SHADER),
            copy: this.ctx.program("copy", COPY_SHADER),
        };
        this.t0 = this.ctx.createTarget(width, height);

        if (this.analogEnabled) {
            this.programs.modulate = this.ctx.program("modulate", MODULATE_SHADER);
            this.programs.demodulate = this.ctx.program("demodulate", DEMODULATE_SHADER);
            this.programs.chromaLowpass = this.ctx.program("chromaLowpass", CHROMA_LOWPASS_SHADER);
            this.programs.tape = this.ctx.program("tape", TAPE_SHADER);
            this.programs.downsample = this.ctx.program("downsample", DOWNSAMPLE_SHADER);

            // The analog chain runs on its own raster, wide enough to carry the colour
            // subcarrier at four samples per cycle - the rate a real digitiser uses.
            // At the export raster it can be far below that (a 640-wide NTSC frame has
            // only 3.4, and a small preview barely clears Nyquist), and an undersampled
            // subcarrier does not decode into softened colour, it decodes into garbage.
            // Only the width matters: every analog filter here works along the line, and
            // everything vertical is indexed by the signal's own line count.
            this.subcarrier = (this.format.subcarrierMHz ?? 3.579545) * (this.format.activeLineUs ?? 52.6);
            this.signalWidth = Math.max(width, Math.ceil(this.subcarrier * 4));
            this.sigA = this.ctx.createTarget(this.signalWidth, height);
            this.sigB = this.ctx.createTarget(this.signalWidth, height);
            this.sigC = this.ctx.createTarget(this.signalWidth, height);
            this.prev = this.ctx.createTarget(this.signalWidth, height);
            this.hasPrev = false;
        }

        if (this.screenEnabled) {
            this.programs.bright = this.ctx.program("bright", BRIGHT_SHADER);
            this.programs.blur = this.ctx.program("blur", BLUR_SHADER);
            this.programs.screen = this.ctx.program("screen", SCREEN_SHADER);
            const bw = Math.max(2, Math.floor(width / 2));
            const bh = Math.max(2, Math.floor(height / 2));
            this.b0 = this.ctx.createTarget(bw, bh);
            this.b1 = this.ctx.createTarget(bw, bh);

            // Auto-exposure state, and the small canvas it meters from.
            this.exposure = 1;
            this.meterCanvas = document.createElement("canvas");
            this.meterCanvas.width = 32;
            this.meterCanvas.height = 18;
            this.meterCtx = this.meterCanvas.getContext("2d", {willReadFrequently: true});
        }
    }

    get canvas() {
        return this.ctx.canvas;
    }

    // A bandwidth in MHz becomes a gaussian sigma in pixels of the working raster:
    // a B MHz limit cannot resolve a feature narrower than 1/(2B) seconds, and one
    // active line of the format lasts activeLineUs across the full raster width.
    // The narrowest feature a B MHz channel can resolve, in pixels of the signal raster:
    // it cannot carry anything narrower than 1/(2B) seconds, and one active line of the
    // format lasts activeLineUs across the full raster width.
    featurePxForBandwidth(mhz) {
        const activeLineUs = this.format.activeLineUs ?? 52.6;
        return this.signalWidth / (2 * Math.max(mhz, 0.05) * activeLineUs);
    }

    sigmaForBandwidth(mhz) {
        return Math.max(this.featurePxForBandwidth(mhz) / 2.4, 0.25);
    }

    // Fit the source into the working raster, preserving its aspect ratio.
    resampleTransform(sourceWidth, sourceHeight) {
        const srcAspect = sourceWidth / sourceHeight;
        const dstAspect = this.width / this.height;
        if (Math.abs(srcAspect - dstAspect) < 0.001) {
            return {scale: [1, 1], offset: [0, 0]};
        }
        if (srcAspect > dstAspect) {
            const h = dstAspect / srcAspect;
            return {scale: [1, h], offset: [0, (1 - h) / 2]};
        }
        const w = srcAspect / dstAspect;
        return {scale: [w, 1], offset: [(1 - w) / 2, 0]};
    }

    // Handheld camera motion for the current frame. Amplitude is itself modulated by a
    // slow noise, so the shot has calm stretches and unsteady ones rather than a
    // constant buzz - which is what actually distinguishes handheld from a bad shake filter.
    handheldTransform(t) {
        const s = this.screen;
        const shake = s.handheld * (0.35 + 0.65 * s.handheldVariation * vnoise(t * 0.37 + 11));
        const speed = Math.max(s.handheldSpeed, 0.05);

        const ox = shake * (0.012 * cnoise(t * 1.3 * speed + 3) + 0.005 * cnoise(t * 4.1 * speed + 17))
            + s.handheldDrift * 0.030 * cnoise(t * 0.17 + 41);
        const oy = shake * (0.012 * cnoise(t * 1.1 * speed + 23) + 0.005 * cnoise(t * 3.7 * speed + 29))
            + s.handheldDrift * 0.030 * cnoise(t * 0.13 + 53);
        const rot = s.handheldRotation * shake * 0.035 * cnoise(t * 0.9 * speed + 61);
        const breathe = 1 + shake * 0.004 * cnoise(t * 0.6 + 71);

        // Crop in far enough that the wobble never swings a frame edge into view. The
        // authored zoom wins when it is larger; this only ever raises it.
        const needed = 1 + 2.2 * Math.max(Math.abs(ox), Math.abs(oy)) + 0.6 * s.keystone + 0.6 * Math.abs(rot);
        const zoom = Math.max(s.zoom, needed) * breathe;

        return [ox, oy, rot, zoom];
    }

    // Meter the frame the way a phone does, and let the exposure chase the target rather
    // than snap to it - the lag is most of why AE looks like AE.
    //
    // Metering the SOURCE rather than the analog stage's output is an approximation: a
    // phone pointed at a screen sees the degraded picture, so with a dark tape format the
    // real thing would open up a little further than this does. Reading the filtered
    // picture back would mean a GPU stall every frame, and downscaling the source canvas
    // costs nothing, so the approximation is worth its error.
    updateExposure(sourceCanvas) {
        const s = this.screen;
        if (!s.autoExposure) {
            this.exposure = 1 + s.exposureBias;
            this.hunted = null;
            return;
        }

        let mean = 0.2;
        try {
            this.meterCtx.drawImage(sourceCanvas, 0, 0, this.meterCanvas.width, this.meterCanvas.height);
            const data = this.meterCtx.getImageData(0, 0, this.meterCanvas.width, this.meterCanvas.height).data;
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
                sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
            }
            mean = sum / (data.length / 4);
        } catch (e) {
            // A tainted or zero-sized canvas: hold the last exposure rather than fail the frame.
        }

        // Aim for a mid grey in linear light, biased brighter - a phone metering a
        // room full of darkness opens up until the bright screen in it clips.
        const meanLinear = Math.pow(Math.max(mean, 0.001), 2.2);
        const aim = 0.18 * (1 + 2.5 * s.exposureBias);
        const target = Math.min(Math.max(aim / Math.max(meanLinear, 0.002), 0.4), 8);

        const rate = 0.02 + 0.28 * s.exposureSpeed;
        if (this.frame === 0) this.exposure = target;
        else this.exposure += (target - this.exposure) * rate;

        // Auto-exposure never quite settles; it hunts around the target.
        const t = this.frame / this.fps;
        this.hunted = this.exposure * (1 + 0.05 * s.exposureSpeed * cnoise(t * 1.7 + 91));
    }

    runAnalog() {
        const sig = this.signal;
        const fmt = this.format;
        const lines = fmt.lines ?? 486;
        const isPal = fmt.system === "pal";
        const mono = !!fmt.mono || sig.chromaGain <= 0;

        // NTSC advances the subcarrier 180 degrees per line (fsc is an odd multiple of
        // half the line rate) and another 180 per frame, which is the four-field
        // sequence that makes dot crawl creep upward. PAL's advance is 90 degrees.
        const linePhase = isPal ? Math.PI / 2 : Math.PI;
        const framePhase = (isPal ? Math.PI / 2 : Math.PI) * this.frame;

        const lumaSigma = this.sigmaForBandwidth(sig.lumaMHz);
        const chromaSigma = this.sigmaForBandwidth(sig.chromaMHz);
        const chromaDelay = sig.chromaDelayPx * (this.signalWidth / 640);

        const raster = {
            uSize: [this.signalWidth, this.height],
            uLines: lines,
            uSubcarrier: this.subcarrier,
        };
        const carrier = {...raster, uLinePhase: linePhase, uFramePhase: framePhase};

        for (let generation = 0; generation < Math.max(1, Math.round(sig.generations)); generation++) {
            this.ctx.run(this.programs.modulate, {
                ...carrier,
                uSrc: this.sigA,
                uLumaSigma: lumaSigma,
                uChromaSigma: chromaSigma,
                uChromaDelay: chromaDelay,
                uSharpen: sig.sharpen,
                uJitter: sig.jitter,
                uHeadSwitch: sig.headSwitch,
                uHueError: sig.hueError ?? 0,
                uFrame: this.frame,
                uMono: mono,
                uPal: isPal,
            }, this.sigB);

            this.ctx.run(this.programs.demodulate, {
                ...carrier,
                uSignal: this.sigB,
                uComb: sig.comb,
                uYCSeparation: sig.ycSeparation,
            }, this.sigC);

            this.ctx.run(this.programs.chromaLowpass, {
                ...raster,
                uDemod: this.sigC,
                uSignal: this.sigB,
                uChromaSigma: chromaSigma,
                uChromaGain: sig.chromaGain,
                uYCSeparation: sig.ycSeparation,
                uMono: mono,
                uPal: isPal,
            }, this.sigA);

            this.ctx.run(this.programs.tape, {
                uSrc: this.sigA,
                // Before the first frame there is nothing to comb against; feeding the
                // current frame in makes interlace and ghosting no-ops for that frame.
                uPrev: this.hasPrev ? this.prev : this.sigA,
                uSize: [this.signalWidth, this.height],
                uLines: lines,
                uNoiseLevel: sig.noiseLevel,
                // Noise structure follows each channel's bandwidth, so a format's grain and
                // colour-smear widths come out of its own physics rather than a tuned number.
                uLumaNoiseCell: Math.max(this.featurePxForBandwidth(sig.lumaMHz), 1.5),
                uChromaNoiseCell: Math.max(this.featurePxForBandwidth(sig.chromaMHz), 4),
                uDropouts: sig.dropouts,
                uInterlace: sig.interlace,
                uGhosting: sig.ghosting,
                uScanlines: sig.scanlines,
                uChromaVBlur: sig.chromaVBlur,
                uFrame: this.frame,
                uMono: mono,
                uPal: isPal,
            }, this.sigB);

            // The tape output is this generation's picture, and the input to the next.
            [this.sigA, this.sigB] = [this.sigB, this.sigA];
        }

        this.ctx.run(this.programs.copy, {uSrc: this.sigA}, this.prev);
        this.hasPrev = true;

        this.ctx.run(this.programs.downsample, {
            uSrc: this.sigA,
            uRatio: this.signalWidth / this.width,
            uSrcWidth: this.signalWidth,
        }, this.t0);
    }

    runScreen(sourceCanvas) {
        const s = this.screen;
        const t = this.frame / this.fps;

        this.updateExposure(sourceCanvas);
        // Kept on the instance so mapSourceToOutput can invert this frame's geometry.
        this.lastHandheld = this.handheldTransform(t);

        this.ctx.run(this.programs.bright, {uSrc: this.t0, uThreshold: 0.6}, this.b0);
        this.ctx.run(this.programs.blur, {uSrc: this.b0, uDirection: [1 / this.b0.width, 0]}, this.b1);
        this.ctx.run(this.programs.blur, {uSrc: this.b1, uDirection: [0, 1 / this.b0.height]}, this.b0);

        this.ctx.run(this.programs.screen, {
            uSrc: this.t0,
            uBloom: this.b0,
            uSize: [this.width, this.height],
            uAspect: this.width / this.height,
            uHandheld: this.lastHandheld,
            uBarrel: s.barrel,
            uKeystone: s.keystone,
            uAberration: s.aberration,
            uEdgeSoftness: s.edgeSoftness,
            uGridPitch: s.gridPitch,
            uGridDepth: s.gridDepth,
            uBeat: s.beat,
            uBeatBars: s.beatBars,
            uBeatPos: this.frame * s.beatSpeed,
            uExposure: this.hunted ?? this.exposure,
            uKnee: s.knee,
            uClip: s.clip,
            uBlackCrush: s.blackCrush,
            uBlackLift: s.blackLift,
            uBloomAmount: s.bloom,
            uGlare: s.glare,
            // The reflection sits on the glass, so it slides about as the phone moves.
            uGlarePos: [0.5 + 0.25 * cnoise(t * 0.11 + 5), 0.55 + 0.2 * cnoise(t * 0.09 + 15)],
            uVignette: s.vignette,
            uNoise: s.noise,
            uFrame: this.frame,
        }, null);
    }

    /**
     * Where a point in the rendered frame ends up in the filtered frame, in pixels.
     *
     * The off-a-screen stage MOVES the picture (handheld sway, keystone, barrel, and the
     * crop that hides the sway), so a caller holding ground truth measured against the
     * rendered frame - the benchmark recorder's target pixel, say - must map it through
     * here or its labels no longer describe its video. Call it after filterFrame(), which
     * is what leaves this frame's geometry on the instance.
     *
     * Returns null when the off-a-screen stage is off (nothing moved) or when the point
     * maps nowhere sensible, both of which callers should treat as "no correction".
     */
    mapSourceToOutput(x, y) {
        if (!this.screenEnabled || !this.lastHandheld) return null;
        return mapSourceToOutputPixels(x, y, this.screen, this.lastHandheld, this.width, this.height);
    }

    /**
     * Filter one frame. Returns the canvas holding the result - reused every frame,
     * so copy it if you need to keep it past the next call.
     */
    filterFrame(sourceCanvas) {
        const fit = this.resampleTransform(sourceCanvas.width, sourceCanvas.height);
        this.ctx.uploadSource(sourceCanvas);
        // The analog chain owns its own wider raster, so the source lands there when it
        // is running and straight on the output raster when it is not. The aspect fit is
        // computed against the OUTPUT raster either way, since it is in normalised uv.
        this.ctx.run(this.programs.resample, {
            uSrc: {texture: this.ctx.sourceTexture},
            uScale: fit.scale,
            uOffset: fit.offset,
        }, this.analogEnabled ? this.sigA : this.t0);

        if (this.analogEnabled) this.runAnalog();

        if (this.screenEnabled) {
            this.runScreen(sourceCanvas);
        } else {
            this.ctx.run(this.programs.copy, {uSrc: this.t0}, null);
        }

        this.ctx.gl.flush();
        this.frame++;
        return this.ctx.canvas;
    }

    dispose() {
        if (this.ctx) this.ctx.dispose();
        this.ctx = null;
    }
}
