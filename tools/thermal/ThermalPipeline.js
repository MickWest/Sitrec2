import {
    AddEquation, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, Box3, Color, DataTexture, FloatType, GLSL3, Matrix4, Mesh, NearestFilter,
    NoBlending, NoColorSpace, OrthographicCamera, PlaneGeometry, RGBAFormat, RedFormat, RGFormat,
    Raycaster, ShaderMaterial, Vector2, Vector3, Vector4, WebGLRenderTarget,
} from "three";
import {apparentTemperature, grayBodyRadiance, inBandRadiance, PHOTON_SCALE, solarIrradiance} from "./radiometry.js";
import {BANDS, clearSky, createAtmosphere, createRangeLUT, seaBackground, evaluatePhotonPath,
    skyElevationRange, skyViewGeometry, sourceRangeLUT, createSkyElevationLUT} from "./atmosphere.js";
import {atmosphereFromSounding} from "./sounding.js";
import {resolveSignatures} from "./signatures.js";
import {normalizeSettings} from "./thermalSchema.js";
import {displayCurveLUT, detectorWindowScale, detectorPresentation, temporalHistoryKey, electronsPerRadiance, fixedPatternMap, gaussianKernel, integrationTime, nextPow2, processingParameters, shadingResponsivity} from "./sensorMath.js";
import {OpticalKernelCache, opticalKernelError, OPTICS_L1_TOLERANCE} from "./sensorMath.js";
import {SkyBackgroundCache, thermalSeaDistance} from "./atmosphere.js";
import {OpticsScheduler, coarseOpticalKernels} from "./sensorMath.js";
import {RangeTableCache} from "./atmosphere.js";
import * as shaders from "./shaders.js";
import {createStatisticalSea, createSeaSkyTable, seaRayAzimuth, cloudRadianceTable, createCloudRadianceDomain,
    sortCloudSheets, createThermalDepthTable} from "./atmosphere.js";

const COVERAGE_SAMPLES = 128; // samples per detector-pixel side for small meshes
const COVERAGE_TILE = 4; // native pixels per tile side; bounds texture allocation
// Estimated budget: every refinement tile redraws the whole scene at COVERAGE_SAMPLES per pixel, so one frame
// refines at most this many tiles. The rest keep the normal supersampled radiance; the overflow is reported.
const COVERAGE_TILE_LIMIT = 64;

// The sky shader's lookup (rowRadiance in shaders.js): the bracketing samples by binary search, then clamped linear
// interpolation. elevation in rad; returns photon radiance in the table's units.
export function skyTableRadiance(table, elevation) {
    const elevations = table.elevations, radiances = table.photonRadiances;
    let lo = 0, hi = table.sampleCount - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (elevations[mid] <= elevation) lo = mid; else hi = mid;
    }
    const t = elevations[hi] > elevations[lo] ? Math.min(1, Math.max(0, (elevation - elevations[lo]) / (elevations[hi] - elevations[lo]))) : 1;
    return radiances[lo] + t * (radiances[hi] - radiances[lo]);
}

/** Layout of the near-field optical convolution. All lengths are fine samples. reach is the kernel support
 * {low: [x, y], high: [x, y]}: how far the combined core and scatter kernels extend toward lower and higher indices.
 *
 * The reference transforms the whole zero-padded image in one complex FFT (the plan's own reference sizes). Packed
 * overlap-add cuts the image into up to 2 × 2 tiles. Each tile is padded by the kernel support, so its circular
 * convolution equals its linear convolution, and the sum of the tiles' convolutions is the image's convolution
 * (linearity): the same full linear convolution with zero circular wrap, which differs from the reference only by
 * float rounding. Two real tiles form one complex image (real and imaginary parts), and the kernel is real, so one
 * RGBA FFT carries four tiles. A live 640 × 512 detector at 4× needs 3328 × 2816 for one image, so 4096², but
 * 1280 + 768 = 2048 per tile: one 2048² RGBA transform, a quarter of the texels and half of the bytes.
 * mode: false keeps the reference; true selects the cheapest layout; {tiles: [x, y]} forces one (tests).
 */
export function nearConvolutionPlan(width, height, reach, reference, mode = true) {
    const single = {packed: false, tilesX: 1, tilesY: 1, tileWidth: width, tileHeight: height,
        fftWidth: reference.fftWidth, fftHeight: reference.fftHeight, reach};
    if (!mode) return single;
    const layout = (tilesX, tilesY) => {
        const tileWidth = Math.ceil(width / tilesX), tileHeight = Math.ceil(height / tilesY);
        return {packed: true, tilesX, tilesY, tileWidth, tileHeight, reach,
            fftWidth: nextPow2(tileWidth + reach.low[0] + reach.high[0]),
            fftHeight: nextPow2(tileHeight + reach.low[1] + reach.high[1])};
    };
    if (mode.tiles) return layout(...mode.tiles);
    // Calculated cost of one transform: texels × butterfly stages × bytes per texel (RG 8, RGBA 16).
    const cost = plan => plan.fftWidth * plan.fftHeight * Math.log2(plan.fftWidth * plan.fftHeight) * (plan.packed ? 16 : 8);
    return [layout(2, 2), layout(2, 1), layout(1, 2)].reduce((best, plan) => cost(plan) < cost(best) ? plan : best, single);
}

/** Support of the near convolution's kernels (core, then scatter), as nearConvolutionPlan takes it. A kernel of
 * width w is centered at floor(w / 2), as fftPrepareFragment centers it. */
export function kernelReach(kernels) {
    const low = axis => kernels.reduce((total, kernel) => total + Math.floor(kernel[axis] / 2), 0);
    const high = axis => kernels.reduce((total, kernel) => total + kernel[axis] - 1 - Math.floor(kernel[axis] / 2), 0);
    return {low: [low("width"), low("height")], high: [high("width"), high("height")]};
}
const scalarTexture = (values, width = values.length, height = 1) =>
    dataTexture(Float32Array.from(values), width, height, RedFormat);
// rgba is row-major Float32 data; physical units are supplied by the owning pass.
function dataTexture(rgba, width, height, format = RGBAFormat) {
    const texture = new DataTexture(rgba, width, height, format, FloatType);
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}
// width/height are pixels. R stores physical scalar data, RG complex FFT data.
function floatTarget(width, height, depthBuffer = false, format = RedFormat) {
    const target = new WebGLRenderTarget(width, height, {type: FloatType, format,
        minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer, stencilBuffer: false});
    target.texture.colorSpace = NoColorSpace;
    target.texture.generateMipmaps = false;
    return target;
}
// Uniform values carry units at their corresponding declarations in shaders.js.
function material(fragmentShader, values = {}, vertexShader = shaders.fullscreenVertex) {
    return new ShaderMaterial({glslVersion: GLSL3, vertexShader, fragmentShader,
        uniforms: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {value}])),
        depthTest: false, depthWrite: false, blending: NoBlending, toneMapped: false});
}

export class ThermalPipeline {
    /** renderer is a shared WebGLRenderer. No GPU resources or Three objects yet. */
    constructor(renderer, {analysis = true, synchronous = analysis, gpuTiming = false, createOpticsWorker, onReady = () => {},
        packedOptics = !analysis} = {}) {
        this.renderer = renderer;
        // Analysis explicitly requests same-render gain for reference captures.
        // Interactive rendering never performs a synchronous pixel readback.
        this.analysis = analysis;
        // Near convolution layout (nearConvolutionPlan). Live views use packed overlap-add when it is cheaper; analysis
        // keeps the single-FFT reference, so reference captures are unchanged and the self-test compares the two.
        this.packedOptics = packedOptics;
        // Offline callers get a complete reference render by default. Live hosts
        // explicitly opt into asynchronous preparation and fenced gain.
        this.synchronous = synchronous;
        this.onReady = onReady;
        this.hasFrame = false;
        this.gpuTiming = gpuTiming;
        this.renderSerial = 0;
        this.opticalCache = new OpticalKernelCache();
        this.opticsScheduler = new OpticsScheduler({createWorker: createOpticsWorker, onReady});
        this.rangeCache = new RangeTableCache(onReady);
        this.skyCache = new SkyBackgroundCache(onReady);
        this.resources = null;
        this.lastFrame = null;
        this.window = null;
        this.disposed = false;
    }

    _initialize() {
        if (this.resources) return;
        const renderer = this.renderer;
        if (!renderer.extensions.has("EXT_color_buffer_float"))
            throw new Error("ThermalPipeline requires WebGL 2 with EXT_color_buffer_float; float radiance targets are unavailable.");
        this.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(), textures: new Set(), checkedSizes: new WeakMap()};
        this.quad = new Mesh(new PlaneGeometry(1, 1), null);
        this.quad.frustumCulled = false;
        this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.emptyTexture = this._ownTexture(scalarTexture(new Float32Array([0])));
        if (this.gpuTiming) this.gpuTimer = new ThermalGpuTimer(renderer.getContext());
    }

    _ownTexture(texture) { this.resources.textures.add(texture); return texture; }
    _stage(name, operation) {
        const start = performance.now();
        // CPU-only preparation must not inflate a GPU query with idle time.
        const timed = !["atmosphere", "prepareOptics", "skyTable", "gainStatistics"].includes(name) && this.gpuTimer?.begin(this.renderSerial, name);
        try {return operation();}
        finally {
            if (timed) this.gpuTimer.end();
            if (this.cpuStages) this.cpuStages[name] = (this.cpuStages[name] ?? 0) + performance.now() - start;
        }
    }
    _removeTexture(texture) {
        if (!texture) return;
        texture.dispose();
        this.resources.textures.delete(texture);
    }
    _target(name, width, height, depth = false) {
        const maximum = this.renderer.capabilities.maxTextureSize;
        if (width > maximum || height > maximum)
            throw new Error(`Thermal ${name} requires ${width} × ${height} texels; GPU limit is ${maximum}. Reduce optical sampling or kernel support.`);
        let target = this.resources.targets.get(name);
        if (!target) {
            const format = /^packedFft[AB]$/.test(name) ? RGBAFormat : /Fft[AB]$|Spectrum$/.test(name) ? RGFormat :
                /Readback$/.test(name) ? RGBAFormat : RedFormat;
            target = floatTarget(width, height, depth, format);
            this.resources.targets.set(name, target);
        } else if (target.width !== width || target.height !== height) target.setSize(width, height);
        return target;
    }

    // target is a float target or the output canvas; viewport is lower-left pixels.
    _pass(name, fragment, uniforms, target, viewport = null) {
        let pass = this.resources.materials.get(name);
        if (!pass) {
            pass = material(fragment, uniforms);
            if (name === "seaDepth") {pass.depthTest = pass.depthWrite = true; pass.colorWrite = false;}
            this.resources.materials.set(name, pass);
        }
        for (const [key, value] of Object.entries(uniforms)) pass.uniforms[key].value = value;
        this.quad.material = pass;
        if (target) {
            target.viewport.set(...(viewport ?? [0, 0, target.width, target.height]));
            target.scissorTest = false;
        }
        this.renderer.setRenderTarget(target);
        if (target && this.resources.checkedSizes.get(target) !== `${target.width},${target.height}`) {
            const gl = this.renderer.getContext();
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
                throw new Error(`Thermal float framebuffer allocation failed at ${target.width} × ${target.height}; reduce the grid or optical support.`);
            this.resources.checkedSizes.set(target, `${target.width},${target.height}`);
        }
        if (!target) {
            const size = this.renderer.getSize(new Vector2());
            this.renderer.setViewport(0, 0, size.x, size.y);
            this.renderer.setScissorTest(false);
        }
        this.renderer.render(this.quad, this.quadCamera);
    }

    // RG complex FFT, with separate bit reversal and butterflies on each axis.
    // All dimensions are padded pixels; mode 0 subtracts scaled photon background.
    _fft(texture, width, height, mode, sourceSize, center = [0, 0], background = 0, pool = "fine") {
        const first = this._target(`${pool}FftA`, width, height), second = this._target(`${pool}FftB`, width, height);
        let output = texture === first.texture ? second : first;
        this._pass("fftPrepare", shaders.fftPrepareFragment, {tInput: texture,
            fftSize: [width, height], sourceSize, kernelCenter: center, mode, background}, output);
        for (const axis of [0, 1]) {
            const size = axis === 0 ? width : height;
            for (let span = 2; span <= size; span *= 2) {
                const input = output;
                output = input === first ? second : first;
                this._pass("fftButterfly", shaders.fftButterflyFragment,
                    {tInput: input.texture, axis, span, inverse: mode === 2}, output);
            }
        }
        return output;
    }

    // Packed RGBA FFT of the near convolution (nearConvolutionPlan). Forward gathers the tiles from the scalar
    // contrast image; inverse takes the filtered packed spectrum. Same radix-2 stages as _fft.
    _fftPacked(texture, plan, inverse) {
        const width = plan.fftWidth, height = plan.fftHeight;
        const first = this._target("packedFftA", width, height), second = this._target("packedFftB", width, height);
        let output = texture === first.texture ? second : first;
        if (inverse) this._pass("fftReversePacked", shaders.fftReversePackedFragment, {tInput: texture, fftSize: [width, height]}, output);
        else this._pass("fftPack", shaders.fftPackFragment, {tInput: texture, fftSize: [width, height],
            sourceSize: plan.sourceSize, tileSize: [plan.tileWidth, plan.tileHeight], tiles: [plan.tilesX, plan.tilesY]}, output);
        for (const axis of [0, 1]) {
            const size = axis === 0 ? width : height;
            for (let span = 2; span <= size; span *= 2) {
                const input = output;
                output = input === first ? second : first;
                this._pass("fftButterflyPacked", shaders.fftButterflyPackedFragment, {tInput: input.texture, axis, span, inverse}, output);
            }
        }
        return output;
    }

    _convolvePacked(texture, plan) {
        const transformed = this._fftPacked(texture, plan, false);
        const product = this.resources.targets.get(transformed === this.resources.targets.get("packedFftA") ? "packedFftB" : "packedFftA");
        this._pass("multiplyPacked", shaders.multiplyPackedFragment,
            {tInput: transformed.texture, tKernel: this.resources.targets.get("opticalSpectrum").texture}, product);
        return this._fftPacked(product.texture, plan, true);
    }

    // The near convolution layout for these kernels at this image size; the spectrum is built at its FFT size.
    _nearPlan(kernels, width, height) {
        const plan = nearConvolutionPlan(width, height, kernelReach([kernels.core, kernels.scatter]),
            kernels.split, this.packedOptics);
        return {...plan, sourceSize: [width, height]};
    }

    _prepareOptics(settings, width, height) {
        const synchronous = this.analysis || this.synchronous;
        const request = synchronous ? null : this.opticsScheduler.request(settings, width, height, this.atmosphere);
        let kernels = synchronous ? this.opticalCache.candidate(settings, width, height, this.atmosphere) : request.kernels;
        const key = synchronous ? this.opticalCache.key : request.key;
        if (!kernels) {
            // A finite positive, unit-mass optical response differs from another
            // by at most 2 in L1. This explicit transient bound applies only
            // outside the validated domain while a replacement is constructed.
            const compatible = this.activeKernels && this.opticsSize?.[0] === width && this.opticsSize?.[1] === height;
            if (compatible) {
                this.opticsReport = {status: "calculated", pending: true, workerPending: true,
                    basisRebuilt: false, spectraRebuilt: false, errorL1: 2, toleranceL1: OPTICS_L1_TOLERANCE,
                    outsideValidatedDomain: true, quality: this.activeKernels.quality ?? "retained",
                    appliedRangeM: this.activeKernels.spectrum.rangeM, requestedRangeM: settings.psfRangeM,
                    message: this.activeKernels.quality === "coarse" ? "Coarse optical preview; full kernel pending. Calculated kernel L1 bound: 2; radiance error ≤ 2 × maximum scene contrast." :
                        "Previous optical kernel retained while rebuilding. Calculated kernel L1 bound: 2; radiance error ≤ 2 × maximum scene contrast."};
                return true;
            }
            kernels = coarseOpticalKernels(settings, width, height, this.atmosphere);
        }
        const interpolationError = kernels.interpolationErrorL1 ?? 0;
        const error = this.opticsKey === null ? Infinity : opticalKernelError(kernels, this.activeKernels) + interpolationError;
        const tolerance = synchronous ? 0 : OPTICS_L1_TOLERANCE;
        this.opticsReport = {status: "calculated", toleranceL1: tolerance, errorL1: error,
            basisRebuilt: synchronous && this.opticalCache.basisRebuilt, spectraRebuilt: false, pending: false,
            interpolationErrorL1: interpolationError, workerPending: request?.pending ?? false, workerBuildMs: request?.buildMs,
            firstKernelMs: request?.firstKernelMs, fallback: request?.fallback ?? false,
            quality: kernels.quality ?? "full", outsideValidatedDomain: kernels.quality === "coarse",
            message: kernels.quality === "coarse" ? "Coarse optical preview; diffraction and turbulence pending. Calculated kernel L1 bound: 2; radiance error ≤ 2 × maximum scene contrast." : ""};
        this.psfSpectrum = kernels.spectrum;
        // Changed support has no valid stale-kernel certificate and rebuilds
        // immediately. All other edits compare the actual finite kernels, even
        // while a refresh is pending; no unbounded stale kernel is displayed.
        if (error > tolerance) {
            this.opticsKey = null; this.pendingOptics = null;
            this._installOptics(kernels, key, width, height);
            this.opticsReport.errorL1 = interpolationError;
        } else if (!synchronous && error > tolerance / 2 && !this.pendingOptics) {
            const retained = this._retainKernels(kernels);
            this.pendingOptics = {kernels: retained, key, steps: this._buildOptics(retained, width, height, true)};
        }
        if (this.pendingOptics) {
            const pending = this.pendingOptics;
            // Submit one complete spectrum per render. GPU work remains queued;
            // the active spectra stay untouched until both branches are ready.
            let completed;
            try {completed = pending.steps.next().done;}
            catch (error) {this.pendingOptics = null; throw error;}
            if (completed) {
                // Pending kernels have the active kernels' support (opticalKernelError is Infinity for any other
                // split or kernel size, which installs immediately), so nearPlan and the FFT sizes stay valid.
                if (pending.key === key && opticalKernelError(kernels, pending.kernels) <= tolerance) {
                    for (const name of ["opticalSpectrum", ...(pending.kernels.farScatter ? ["farSpectrum"] : [])]) {
                        const staging = `pending${name[0].toUpperCase()}${name.slice(1)}`;
                        const old = this.resources.targets.get(name);
                        this.resources.targets.set(name, this.resources.targets.get(staging));
                        if (old) this.resources.targets.set(staging, old); else this.resources.targets.delete(staging);
                    }
                    this.activeKernels = pending.kernels;
                    this.opticsKey = pending.key;
                    this.opticsReport.errorL1 = opticalKernelError(kernels, pending.kernels) + interpolationError;
                    this.opticsReport.spectraRebuilt = true;
                }
                this.pendingOptics = null;
            }
        }
        this.opticsReport.pending = !!this.pendingOptics || (request?.pending ?? false);
        if (this.pendingOptics) this.onReady();
        this.opticsReport.appliedRangeM = this.activeKernels.spectrum.rangeM;
        this.opticsReport.requestedRangeM = kernels.spectrum.rangeM;
        return true;
    }

    _retainKernels(kernels) {
        return {...kernels, core: {...kernels.core, data: kernels.core.data.slice()}};
    }

    *_buildOptics(kernels, width, height, pending = false) {
        const name = value => pending ? `pending${value[0].toUpperCase()}${value.slice(1)}` : value;
        const plan = this._nearPlan(kernels, width, height);
        this._prepareSpectrum(name("opticalSpectrum"), [kernels.core, kernels.scatter], plan.fftWidth, plan.fftHeight);
        yield;
        if (kernels.farScatter) {
            const fw = nextPow2(Math.ceil(width / kernels.split.factor) + kernels.farCore.width + kernels.farScatter.width - 2);
            const fh = nextPow2(Math.ceil(height / kernels.split.factor) + kernels.farCore.height + kernels.farScatter.height - 2);
            this._prepareSpectrum(name("farSpectrum"), [kernels.farCore, kernels.farScatter], fw, fh);
            yield;
        }
    }

    _installOptics(kernels, key, width, height) {
        for (const step of this._buildOptics(kernels, width, height)) void step;
        this.nearPlan = this._nearPlan(kernels, width, height);
        this.fftWidth = this.nearPlan.fftWidth; this.fftHeight = this.nearPlan.fftHeight;
        this.farWidth = kernels.farScatter ? nextPow2(Math.ceil(width / kernels.split.factor) + kernels.farCore.width + kernels.farScatter.width - 2) : 0;
        this.farHeight = kernels.farScatter ? nextPow2(Math.ceil(height / kernels.split.factor) + kernels.farCore.height + kernels.farScatter.height - 2) : 0;
        this.scatterSplit = {...kernels.split, farMass: kernels.farMass};
        this.activeKernels = this._retainKernels(kernels); this.opticsKey = key; this.opticsReport.spectraRebuilt = true;
        this.opticsSize = [width, height];
    }

    _prepareSpectrum(name, kernels, fftWidth, fftHeight) {
        return this._stage("kernelSpectrum", () => this._prepareSpectrumPasses(name, kernels, fftWidth, fftHeight));
    }

    _prepareSpectrumPasses(name, kernels, fftWidth, fftHeight) {
        const spectrum = this._target(name, fftWidth, fftHeight);
        const pool = /[fF]arSpectrum$/.test(name) ? "far" : "fine";
        let first = true;
        for (const kernel of kernels) {
            const texture = scalarTexture(kernel.data, kernel.width, kernel.height);
            try {
                const transformed = this._fft(texture, fftWidth, fftHeight, 1,
                    [kernel.width, kernel.height], [Math.floor(kernel.width / 2), Math.floor(kernel.height / 2)], 0, pool);
                if (first) this._pass("copy", shaders.copyFragment, {tInput: transformed.texture}, spectrum);
                else {
                    const product = this.resources.targets.get(transformed === this.resources.targets.get(`${pool}FftA`) ? `${pool}FftB` : `${pool}FftA`);
                    this._pass("multiply", shaders.multiplyFragment,
                        {tInput: transformed.texture, tKernel: spectrum.texture}, product);
                    this._pass("copy", shaders.copyFragment, {tInput: product.texture}, spectrum);
                }
            } finally { texture.dispose(); }
            first = false;
        }
    }

    _convolve(texture, width, height, spectrumName, fftWidth, fftHeight, background = 0) {
        const pool = spectrumName === "farSpectrum" ? "far" : "fine";
        let transformed = this._fft(texture, fftWidth, fftHeight, 0, [width, height], [0, 0], background, pool);
        const product = this.resources.targets.get(transformed === this.resources.targets.get(`${pool}FftA`) ? `${pool}FftB` : `${pool}FftA`);
        this._pass("multiply", shaders.multiplyFragment,
            {tInput: transformed.texture, tKernel: this.resources.targets.get(spectrumName).texture}, product);
        return this._fft(product.texture, fftWidth, fftHeight, 2, [fftWidth, fftHeight], [0, 0], 0, pool);
    }

    _optics(radiance, optics, background) {
        // Reuse the near image as contrast scratch until its forward FFT is done.
        const nearImage = this._target("nearOptics", radiance.width, radiance.height);
        this._pass("contrast", shaders.contrastFragment,
            {tInput: radiance.texture, tBackground: background.texture}, nearImage);
        const plan = this.nearPlan;
        const near = plan.packed ? this._convolvePacked(nearImage.texture, plan) :
            this._convolve(nearImage.texture, radiance.width, radiance.height, "opticalSpectrum", this.fftWidth, this.fftHeight);
        // The far branch must consume contrast before this scratch is overwritten.
        let farTexture = this.emptyTexture;
        this.farResult = null;
        if (this.scatterSplit.farMass > 0) {
            let reduced = nearImage;
            for (let factor = 1; factor < this.scatterSplit.factor; factor *= 2) {
                const output = this._target(`scatterReduce${factor}`, Math.ceil(reduced.width / 2), Math.ceil(reduced.height / 2));
                this._pass("scatterReduce", shaders.scatterReduceFragment,
                    {tInput: reduced.texture, sourceSize: [reduced.width, reduced.height], background: 0}, output);
                reduced = output;
            }
            this.farResult = this._convolve(reduced.texture, reduced.width, reduced.height,
                "farSpectrum", this.farWidth, this.farHeight);
            const far = this._target("farScatter", radiance.width, radiance.height);
            this._pass("farUpsample", shaders.farUpsampleFragment, {tInput: this.farResult.texture,
                fftSize: [this.farWidth, this.farHeight], factor: this.scatterSplit.factor}, far);
            farTexture = far.texture;
        }
        if (plan.packed) this._pass("overlapAdd", shaders.overlapAddFragment, {tInput: near.texture,
            fftSize: [plan.fftWidth, plan.fftHeight], sourceSize: plan.sourceSize, tileSize: [plan.tileWidth, plan.tileHeight],
            tiles: [plan.tilesX, plan.tilesY], reachLow: plan.reach.low, reachHigh: plan.reach.high}, nearImage);
        else this._pass("copy", shaders.copyFragment, {tInput: near.texture}, nearImage);
        this._pass("opticsSum", shaders.opticsSumFragment, {tInput: nearImage.texture,
            tFar: farTexture, hasFar: this.scatterSplit.farMass > 0, tBackground: background.texture}, optics);
    }

    _prepareFixedPattern(settings) {
        const key = JSON.stringify([settings.detectorWidth, settings.detectorHeight, settings.noiseSeed, settings.fixedPatternFraction]);
        if (key === this.fixedPatternKey) return;
        this._removeTexture(this.fixedPatternTexture);
        this.fixedPatternTexture = this._ownTexture(scalarTexture(fixedPatternMap(settings), settings.detectorWidth, settings.detectorHeight));
        this.fixedPatternKey = key;
    }

    _prepareAtmosphere(settings, sounding = null) {
        this.seaEnvironmentRebuilt = false;
        const options = {visibilityM: settings.visibilityM, densityScale: settings.atmosphereEnabled ? 1 : 0};
        const measured = sounding ? atmosphereFromSounding(sounding, options) : null;
        const contentKey = measured?.contentKey ?? JSON.stringify(["standard-v1", options,
            settings.surfaceTemperatureK, settings.waterVaporDensityKgM3]);
        if (contentKey !== this.profileKey) {
            this.atmosphere = measured?.atmosphere ?? createAtmosphere({...options,
                surfaceWaterVaporDensityKgM3: settings.waterVaporDensityKgM3, surfaceTemperatureK: settings.surfaceTemperatureK});
            this.profileKey = contentKey;
        }
        this.atmosphereProfile = Object.freeze({source: measured ? "sounding" : "standard", contentKey,
            ...(measured ? {stationId: sounding.stationId ?? null, time: sounding.time ?? null,
                year: sounding.year ?? null, month: sounding.month ?? null, day: sounding.day ?? null,
                hour: sounding.hour ?? null, assumptions: measured.assumptions} : {})});
        const geometry = {sensorAltitudeM: settings.sensorAltitudeM, elevationRad: settings.pathElevationDeg * Math.PI / 180};
        const band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm};
        // Center-ray reference and foreground transfer. The background elevation
        // table uses the same atmosphere, photon band and 96-segment quadrature.
        const accuracy = {segments: 96, quantity: "photon", band};
        // Interactive views with the sky gradient draw the background from the validated sky table and ignore this
        // centre value, so its path integral (the slowest step of a moving frame) is deferred: _prepareSkyBackground
        // reads it from that table, as the sky shader does (within the table's bound), or integrates it exactly when
        // the table is a rough-sea table. Analysis and synchronous renders integrate it here as before.
        const deferSky = !this.analysis && !this.synchronous && settings.skyGradient;
        const skyKey = JSON.stringify([contentKey, geometry, band, this.rayGeometry?.key, deferSky]);
        if (settings.skySource === "atmosphere" && skyKey !== this.skyKey) {
            const mapped = this.rayGeometry?.ray(geometry.elevationRad, this.atmosphere.options.topAltitudeM);
            const atmosphere = this.atmosphere;
            const exact = mapped ? () => ({...mapped, radiance: evaluatePhotonPath(mapped, atmosphere, accuracy).pathRadiance}) :
                () => clearSky(geometry, atmosphere, accuracy);
            // The surface test is geometric and cheap; only a sky ray's path integral is deferred.
            const surfaceRay = mapped ? mapped.kind === "surface" :
                Number.isFinite(thermalSeaDistance(geometry.sensorAltitudeM, Math.sin(geometry.elevationRad)));
            this.skyRay = mapped?.kind === "surface" ? mapped :
                deferSky && !surfaceRay ? {...(mapped ?? {kind: "sky"}), radiance: null, exact} : exact();
            this.skyKey = skyKey;
        }
        const sky = settings.skySource === "manual" ? null : this.skyRay;
        const surface = sky?.kind === "surface";
        this.seaSettingsKey = JSON.stringify([settings.seaMode, settings.seaWindMps, settings.seaWindDirectionRad,
            settings.seaSkinTemperatureK, settings.seaSwellHeightM, settings.seaSwellPeriodS, settings.seaSwellDirectionRad]);
        const backgroundKey = JSON.stringify([skyKey, settings.skySource, this.seaSettingsKey, this.seaWind,
            this.skyView?.up,
            settings.skySource === "manual" ? settings.skyTemperatureK : surface ? settings.surfaceTemperatureK : null]);
        if (backgroundKey !== this.backgroundKey) {
            const azimuthRad = this.skyView && this.seaWind ? seaRayAzimuth([0, 0, -1], this.skyView.up, this.seaWind) : 0;
            const physical = this.rayGeometry ? sky : geometry;
            const result = surface ? (settings.seaMode === "statistical" ? this._statisticalSea(settings).evaluate({...physical, azimuthRad}) :
                seaBackground({...physical, temperatureK: settings.surfaceTemperatureK}, this.atmosphere, accuracy)) : sky;
            const deferred = !surface && sky?.radiance === null;
            const photonRadiance = deferred ? null : result ? result.radiance.reduce((total, value) => total + value, 0) :
                inBandRadiance(settings.skyTemperatureK, band).photon;
            this.background = Object.freeze({source: settings.skySource, kind: surface ? "sea" : sky ? "sky" : "manual",
                photonRadiance, scaledPhotonRadiance: deferred ? null : photonRadiance / PHOTON_SCALE,
                brightnessTemperatureK: deferred ? null : apparentTemperature(photonRadiance, {quantity: "photon", band}),
                deferredRadiance: deferred,
                ...(surface ? {surfaceDistanceM: sky.distanceM, status: "estimated",
                    seaMode: settings.seaMode, skinTemperatureK: settings.seaMode === "statistical" ? settings.seaSkinTemperatureK : settings.surfaceTemperatureK,
                    reason: settings.seaMode === "statistical" ? "Estimated ensemble mean, gray water, directional clear sky, independent Smith hiding and black-cavity closure; no moving crest occlusion." :
                        "Smooth comparison sea at surface air temperature."} : {})});
            this.backgroundKey = backgroundKey;
        }
        // A surface background limits foreground transfer to the first intersection.
        const maxRangeM = Math.min(settings.atmosphereMaxRangeM, this.background.surfaceDistanceM ?? Infinity);
        const synchronous = this.analysis || this.synchronous;
        const key = JSON.stringify([synchronous, contentKey, geometry, band, maxRangeM, this.rayGeometry?.key]);
        if (this.atmosphereKey === key) return true;
        const vacuum = !settings.atmosphereEnabled || maxRangeM === 0;
        const rangeOptions = {maxRangeM, ...geometry, band, atmosphere: this.atmosphere, rayGeometry: this.rayGeometry,
            surfaceLimited: Number.isFinite(this.background.surfaceDistanceM), rangeLimitM: settings.atmosphereMaxRangeM};
        const cachedRange = !vacuum && !synchronous ? this.rangeCache.request(rangeOptions, this.atmosphere) : null;
        const rangeLUT = vacuum ? {size: 2, maxRangeM,
            transmission: new Float32Array(24).fill(1), pathRadiance: new Float32Array(24)} :
            cachedRange ?? createRangeLUT(rangeOptions);
        this.rangeLUT = rangeLUT;
        this.rangeReport = cachedRange ? this.rangeCache.report :
            {status: "calculated", transmissionError: 0, pathErrorK: 0, pending: !!this.rangeCache.pending};
        // A new range table changes only each surface's small range texture. Keep the materials and recompute those
        // textures from the cached source spectra, with the same arithmetic as a new surface; surfaces without a
        // range texture do not depend on the table.
        for (const surface of this.resources.surfaces.values()) {
            if (!surface.spectrum || !surface.texture) continue;
            const data = this._surfaceRangeData(surface.spectrum);
            if (surface.texture.image?.data?.length === data.length) {
                surface.texture.image.data.set(data); surface.texture.needsUpdate = true;
            } else {
                this._removeTexture(surface.texture);
                surface.texture = this._ownTexture(dataTexture(data, this.rangeLUT.size, 1));
                surface.material.uniforms.rangeTexture.value = surface.texture;
            }
            surface.material.uniforms.rangeMaxM.value = this.rangeLUT.maxRangeM;
            surface.material.uniforms.rangeSamples.value = this.rangeLUT.size;
        }
        this.atmosphereKey = key;
        return true;
    }

    // Per-sample surface source radiance (red) and reflected sunlight (green) along the current range table.
    _surfaceRangeData({emission, reflectedSun}) {
        const thermal = sourceRangeLUT(this.rangeLUT, emission);
        const rgba = new Float32Array(this.rangeLUT.size * 4);
        for (let sample = 0; sample < this.rangeLUT.size; sample++) {
            rgba[sample * 4] = thermal[sample];
            for (let band = 0; band < 12; band++) rgba[sample * 4 + 1] +=
                reflectedSun[band] / PHOTON_SCALE * this.rangeLUT.transmission[sample * 12 + band];
        }
        return rgba;
    }

    _statisticalSea(settings) {
        const key = JSON.stringify([this.profileKey, this.seaSettingsKey, settings.bandMinUm, settings.bandMaxUm]);
        if (key !== this.statisticalSeaKey) {
            const start = performance.now();
            this.statisticalSea = createStatisticalSea(settings, this.atmosphere); this.statisticalSeaKey = key;
            this.seaEnvironmentBuildMs = performance.now() - start; this.seaEnvironmentRebuilt = true;
        }
        return this.statisticalSea;
    }

    _prepareSkyBackground(settings, view) {
        this.skyView = view;
        this.skySensorAltitudeM = settings.sensorAltitudeM;
        const range = skyElevationRange(view);
        const horizonRad = this.rayGeometry?.horizonRad ?? -Math.acos(6371000 / (6371000 + settings.sensorAltitudeM));
        const depthKey = JSON.stringify([this.rayGeometry?.key, range.minRad]);
        if (this.rayGeometry && depthKey !== this.seaDepthKey) {
            const table = createThermalDepthTable(this.rayGeometry, Math.min(range.minRad, horizonRad));
            this._removeTexture(this.seaDepthTexture);
            this.seaDepthTexture = this._ownTexture(dataTexture(table.data, table.sampleCount));
            this.seaDepthTable = table; this.seaDepthKey = depthKey;
        }
        const gradient = settings.skySource === "atmosphere" && settings.skyGradient;
        this.skyCacheRebuilt = false;
        const rough = gradient && settings.seaMode === "statistical" && range.minRad < horizonRad;
        if (gradient) {
            const key = JSON.stringify([this.analysis || this.synchronous, this.profileKey, settings.sensorAltitudeM, range, this.seaSettingsKey, rough ? [this.seaWind, view] : null,
                settings.surfaceTemperatureK, settings.bandMinUm, settings.bandMaxUm, this.rayGeometry?.key]);
            if (key !== this.skyTableKey) {
                const started = performance.now();
                const options = {view, sensorAltitudeM: settings.sensorAltitudeM,
                    rayGeometry: this.rayGeometry,
                    temperatureK: settings.surfaceTemperatureK,
                    band: {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}};
                const table = rough ? createSeaSkyTable(view, this.seaWind, settings, this.atmosphere, this._statisticalSea(settings), this.rayGeometry) :
                    this.analysis || this.synchronous ? createSkyElevationLUT(options, this.atmosphere) : this.skyCache.table(options, this.atmosphere);
                const data = table.data ?? new Float32Array(table.sampleCount * 4);
                if (!rough) table.elevations.forEach((value, i) => {
                    data[i * 4] = value; data[i * 4 + 1] = table.photonRadiances[i] / PHOTON_SCALE;
                });
                if (table !== this.skyTable) {
                    this._removeTexture(this.skyTableTexture);
                    this.skyTableTexture = this._ownTexture(dataTexture(data, table.width ?? table.sampleCount, table.rows?.length ?? 1));
                    this.skyBuildMs = performance.now() - started; this.skyCacheRebuilt = true;
                }
                this.skyTable = table; this.skyTableKey = key;
            }
        }
        this.skyGradient = gradient; this.roughSky = rough;
        if (this.background?.deferredRadiance) {
            // The deferred centre value (see _prepareAtmosphere): the sky shader's own lookup in the table just prepared,
            // or the exact path integral where the table is a rough-sea table.
            const band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm};
            const offset = (this.rayGeometry?.horizonRad ?? -Math.acos(6371000 / (6371000 + settings.sensorAltitudeM))) - this.skyTable.horizonRad;
            const photonRadiance = gradient && !rough ? skyTableRadiance(this.skyTable, range.centerRad - offset) :
                this.skyRay.exact().radiance.reduce((total, value) => total + value, 0);
            this.background = Object.freeze({...this.background, deferredRadiance: false, photonRadiance,
                scaledPhotonRadiance: photonRadiance / PHOTON_SCALE,
                brightnessTemperatureK: apparentTemperature(photonRadiance, {quantity: "photon", band})});
        }
        this.frameBackground = Object.freeze({...this.background, gradient,
            ...(rough ? {sea: {spectrum: this.statisticalSea.spectrum, hiding: this.statisticalSea.hiding,
                environment: this.statisticalSea.environment, quadrature: this.statisticalSea.quadrature,
                altitudeInterpolation: this.skyTable.altitudeDomain ?? null,
                environmentBuildMs: this.seaEnvironmentRebuilt ? this.seaEnvironmentBuildMs : 0,
                azimuthRows: this.skyTable.rows.length, azimuthInterpolation: this.skyTable.azimuthInterpolation,
                cacheBuildMs: this.skyCacheRebuilt ? this.skyBuildMs : 0, lastBuildMs: this.skyBuildMs, textureBytes: this.skyTable.data.byteLength, gpuMs: null}} : {}),
            elevationRangeDeg: [range.minRad * 180 / Math.PI, range.maxRad * 180 / Math.PI],
            rangeConvention: "enclosing frame diagonal plus margin",
            photonRadianceRange: gradient ? this.skyTable.photonRadianceRange :
                [this.background.photonRadiance, this.background.photonRadiance],
            sampleCount: gradient ? this.skyTable.sampleCount : 1,
            ...(gradient ? {interpolation: {...this.skyTable.interpolation,
                altitudeErrorK: this.skyTable.altitudeDomain?.maxErrorK ?? 0,
                ...(this.skyTable.interpolation.toleranceK ? {
                    maxErrorK: this.skyTable.interpolation.maxErrorK + (this.skyTable.altitudeDomain?.maxErrorK ?? 0), toleranceK: .005} : {}),
                mode: this.analysis || this.synchronous ? "reference table" : "bounded angular and altitude reuse"},
                horizonElevationDeg: horizonRad * 180 / Math.PI} : {})});
    }

    // Thermal attributes are dimensionless emissivity plus K; ancestry ends at scene.
    _attributes(mesh, scene, settings) {
        let nearest = null;
        for (let ancestor = mesh; ancestor; ancestor = ancestor.parent) {
            if (ancestor.userData?.thermal === false) return false;
            if (!nearest && ancestor.userData?.thermal && typeof ancestor.userData.thermal === "object") nearest = ancestor.userData.thermal;
            if (ancestor === scene) break;
        }
        if (!nearest) return resolveSignatures({}, settings.ambientTemperatureK).airframe;
        if (nearest.profile || nearest.parameters || nearest.presetId) {
            const resolved = resolveSignatures(nearest, settings.ambientTemperatureK);
            return nearest.zone ? resolved.resolveZone(nearest.zone) : resolved.airframe;
        }
        const resolved = resolveSignatures(nearest, settings.ambientTemperatureK);
        return nearest.zone && nearest.temperatureK === undefined && nearest.emissivity === undefined
            ? resolved.resolveZone(nearest.zone) : resolved.airframe;
    }

    _surfaceSpectrum(attributes, settings) {
        const interactive = !this.analysis && !this.synchronous;
        // Calculated reuse error is zero: all inputs to the spectral integration
        // are matched exactly. Range transfer is always applied to the current LUT.
        // Keep these CPU arrays separate from surfaces, which atmosphere updates dispose.
        // Nonstandard solar inputs and invalid attributes take the original
        // evaluation path, including its input validation.
        const cacheable = interactive && attributes.solar === undefined && attributes.cosIncidence === undefined &&
            Number.isFinite(attributes.temperatureK) && Number.isFinite(attributes.emissivity);
        const key = cacheable ? JSON.stringify([attributes.temperatureK, attributes.emissivity,
            settings.environmentTemperatureK, settings.solarScale, settings.bandMinUm, settings.bandMaxUm]) : null;
        const cache = cacheable ? (this.resources.surfaceSpectra ??= new Map()) : null;
        let spectrum = cache?.get(key);
        if (!spectrum) {
            const illuminationKey = JSON.stringify([settings.environmentTemperatureK, settings.bandMinUm, settings.bandMaxUm]);
            let illumination = interactive ? this.resources.surfaceIllumination : null;
            if (interactive && illumination?.key !== illuminationKey) {
                illumination = {key: illuminationKey, bands: []};
                this.resources.surfaceIllumination = illumination;
            }
            const emission = new Float64Array(12), reflectedSun = new Float64Array(12);
            BANDS.forEach((band, index) => {
                const minUm = Math.max(settings.bandMinUm, band.minM * 1e6);
                const maxUm = Math.min(settings.bandMaxUm, band.maxM * 1e6);
                if (maxUm <= minUm) return;
                const response = {minUm, maxUm};
                // Calculated zero-error reuse of the same environment and solar
                // integrals across different temperatures and emissivities.
                const incident = illumination?.bands[index];
                const environment = incident?.environment ?? inBandRadiance(settings.environmentTemperatureK, response);
                const gray = grayBodyRadiance({...attributes, environment}, response);
                emission[index] = gray.total.photon;
                const solar = incident?.solar ?? solarIrradiance({}, response);
                reflectedSun[index] = (1 - attributes.emissivity) * solar.photon * settings.solarScale / Math.PI;
                if (illumination && !incident) illumination.bands[index] = {environment, solar};
            });
            spectrum = {emission, reflectedSun};
            cache?.set(key, spectrum);
        }
        spectrum.used = true;
        return spectrum;
    }

    _surface(attributes, original, settings, sunDirection) {
        if (attributes.sea) {
            const key = JSON.stringify(["statistical-sea", original.side, this.radianceAdapter?.materialKey]);
            let surface = this.resources.surfaces.get(key);
            if (!surface) {
                const fragment = shaders.skyFragment.replace("in vec2 vUv;", "in vec3 vViewPosition;\nin vec3 vProjectedPosition;")
                    .replace("vec3 ray=orthographic ? vec3(0.0,0.0,-1.0) : normalize((inverseProjection*vec4(vUv*2.0-1.0,0.0,1.0)).xyz);", "vec3 ray=normalize(vViewPosition); if (projectedSea) ray=normalize(vProjectedPosition);")
                    .replace("void main() {", "void main() {\n#include <logdepthbuf_fragment>\n");
                const pass = material("#include <logdepthbuf_pars_fragment>\n" + fragment, this._skyUniforms(null, this.background.scaledPhotonRadiance), shaders.radianceVertex);
                pass.depthTest = pass.depthWrite = true; pass.side = original.side; pass.visible = original.visible;
                this.radianceAdapter?.prepareMaterial?.(pass);
                surface = {material: pass, texture: null}; this.resources.surfaces.set(key, surface);
            }
            for (const [key, value] of Object.entries(this._skyUniforms(null, this.background.scaledPhotonRadiance))) surface.material.uniforms[key].value = value;
            surface.used = true; return surface.material;
        }
        const key = JSON.stringify([attributes.temperatureK, attributes.emissivity, original.side, original.visible,
            settings.environmentTemperatureK, settings.solarScale, this.radianceAdapter?.materialKey]);
        let surface = this.resources.surfaces.get(key);
        if (!surface) {
            const spectrum = this._surfaceSpectrum(attributes, settings);
            const texture = this._ownTexture(dataTexture(this._surfaceRangeData(spectrum), this.rangeLUT.size, 1));
            const pass = material(shaders.radianceFragment, {rangeTexture: texture,
                rangeMaxM: this.rangeLUT.maxRangeM, rangeSamples: this.rangeLUT.size,
                sunViewDirection: sunDirection}, shaders.radianceVertex);
            pass.side = original.side;
            pass.visible = original.visible;
            pass.depthTest = pass.depthWrite = true;
            try {
                this.radianceAdapter?.prepareMaterial?.(pass);
            } catch (error) {
                pass.dispose(); this._removeTexture(texture); throw error;
            }
            surface = {texture, material: pass, spectrum};
            this.resources.surfaces.set(key, surface);
        }
        surface.used = true;
        if (surface.spectrum) surface.spectrum.used = true;
        surface.material.uniforms.sunViewDirection.value = sunDirection;
        return surface.material;
    }

    _camera(camera, settings) {
        camera.updateWorldMatrix(true, false);
        const result = camera.clone(false);
        result.matrixAutoUpdate = false;
        result.matrixWorldAutoUpdate = false;
        result.matrix.copy(camera.matrixWorld);
        result.matrixWorld.copy(camera.matrixWorld);
        result.matrixWorldInverse.copy(camera.matrixWorldInverse);
        if (result.isPerspectiveCamera) {
            result.fov = settings.verticalFovDeg;
            result.aspect = settings.detectorWidth / settings.detectorHeight;
            result.zoom = 1;
            result.clearViewOffset();
            result.updateProjectionMatrix();
        }
        return result;
    }

    // Scene/camera positions are m; target is a float texture; sky is scaled photon radiance.
    _skyUniforms(camera, sky) {
        return {sky, useGradient: this.skyGradient, projectedSea: !!this.rayGeometry,
            tSky: this.skyTableTexture ?? this.emptyTexture, skySamples: this.skyTable?.sampleCount ?? 1,
            directionalSea: this.roughSky ?? false, seaWind: this.seaWind ?? [1, 0, 0],
            azimuthRows: this.roughSky ? this.skyTable.rows.length : 1,
            azimuthRange: this.roughSky ? [this.skyTable.minAzimuth, this.skyTable.maxAzimuth] : [0, 1],
            skyUp: this.skyView.up, inverseProjection: camera?.projectionMatrixInverse ?? new Matrix4(),
            skyElevationOffset: this.skyGradient ? (this.rayGeometry?.horizonRad ?? -Math.acos(6371000 / (6371000 + this.skySensorAltitudeM))) - this.skyTable.horizonRad : 0,
            orthographic: !!camera?.isOrthographicCamera};
    }

    _drawSky(camera, target, sky) {
        this._pass("sky", shaders.skyFragment, this._skyUniforms(camera, sky), target);
    }

    _seaGeometryUniforms() {
        return {mappedSea: !!this.rayGeometry, tSeaGeometry: this.seaDepthTexture ?? this.emptyTexture,
            seaGeometrySamples: this.seaDepthTable?.sampleCount ?? 2,
            apparentHorizon: this.rayGeometry?.horizonRad ?? 0};
    }

    _drawRadiance(scene, camera, target, sky) {
        this._drawSky(camera, target, sky);
        this.renderer.clear(false, true, false);
        if (this.thermalSeaEnabled) {
            this._pass("seaDepth", shaders.seaDepthFragment, {inverseProjection: camera.projectionMatrixInverse,
                cameraProjection: camera.projectionMatrix, skyUp: this.skyView.up,
                sensorAltitudeM: this.thermalSensorAltitudeM, cameraFar: camera.far,
                orthographic: !!camera.isOrthographicCamera,
                logarithmicDepth: !!this.renderer.capabilities?.logarithmicDepthBuffer, ...this._seaGeometryUniforms()}, target);
        }
        this.renderer.render(scene, camera);
        this.cloudPass?.draw(camera, target, this.forceCloudShaderComposite);
    }

    // Mesh bounds projected to detector pixels. Refinement draws the whole scene at
    // each tile, so foreground occlusion and background replacement remain correct.
    _coverageTiles(meshes, camera, settings) {
        const tiles = new Map();
        // The surface skip and the tile budget bound the cost of an interactive frame. Analysis and offline renders
        // keep the complete refinement, so their results do not change.
        const interactive = !this.analysis && !this.synchronous;
        for (const mesh of meshes) {
            if (!mesh.geometry.attributes.position) continue;
            // Ground and sea are extended backgrounds. Edge-on near the horizon a surface tile is thin enough to
            // qualify, and each refinement tile redraws the whole scene, so surfaces are not refined interactively.
            if (interactive && this.radianceAdapter?.isSurface?.(mesh)) continue;
            const bounds = new Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
            const instances = mesh.isInstancedMesh ? mesh.count : 1;
            for (let instance = 0; instance < instances; instance++) {
                const world = mesh.matrixWorld.clone();
                if (mesh.isInstancedMesh) { const transform = new Matrix4(); mesh.getMatrixAt(instance, transform); world.multiply(transform); }
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, crossesNear = false;
                let maxRangeM = 0, behind = 0, outLeft = 0, outRight = 0, outBelow = 0, outAbove = 0, outFar = 0;
                // Combine transforms in CPU double precision before GPU-sized coordinates.
                const toCamera = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, world);
                for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
                    const corner = new Vector3(x, y, z).applyMatrix4(toCamera);
                    if (-corner.z < camera.near) crossesNear = true;
                    if (-corner.z <= 0) behind++;
                    maxRangeM = Math.max(maxRangeM, corner.length());
                    this.radianceAdapter?.projectPoint?.(corner, camera);
                    corner.applyMatrix4(camera.projectionMatrix);
                    outLeft += corner.x < -1; outRight += corner.x > 1; outBelow += corner.y < -1; outAbove += corner.y > 1; outFar += corner.z > 1;
                    const column = (corner.x + 1) * settings.detectorWidth / 2;
                    const row = (corner.y + 1) * settings.detectorHeight / 2;
                    minX = Math.min(minX, column); maxX = Math.max(maxX, column);
                    minY = Math.min(minY, row); maxY = Math.max(maxY, row);
                }
                // A mesh wholly outside the image (every corner beyond one edge, behind the camera or past the far
                // plane, after the same apparent-position correction) draws nothing, so it needs neither coverage
                // nor range validation: a far object elsewhere in the scene must not stop the frame. A box that
                // straddles an edge or the camera plane is kept.
                if (behind === 8 || (behind === 0 && [outLeft, outRight, outBelow, outAbove, outFar].includes(8))) continue;
                if (!this.radianceAdapter?.allowRangeClamping?.(mesh) && maxRangeM > (this.rangeLUT?.maxRangeM ?? settings.atmosphereMaxRangeM) && settings.atmosphereEnabled)
                    throw new RangeError(`Thermal mesh ${mesh.name || mesh.id} exceeds atmospheric range table (${this.rangeLUT?.maxRangeM ?? settings.atmosphereMaxRangeM} m)`);
                if (crossesNear || Math.min(maxX - minX, maxY - minY) > 2) continue;
                const left = Math.max(0, Math.floor((minX - 1) / COVERAGE_TILE) * COVERAGE_TILE);
                const bottom = Math.max(0, Math.floor((minY - 1) / COVERAGE_TILE) * COVERAGE_TILE);
                const right = Math.min(settings.detectorWidth, Math.ceil(maxX + 1));
                const top = Math.min(settings.detectorHeight, Math.ceil(maxY + 1));
                for (let row = bottom; row < top; row += COVERAGE_TILE) for (let column = left; column < right; column += COVERAGE_TILE)
                    tiles.set(`${column},${row}`, [column, row, Math.min(COVERAGE_TILE, settings.detectorWidth - column),
                        Math.min(COVERAGE_TILE, settings.detectorHeight - row)]);
            }
        }
        const all = [...tiles.values()], limit = interactive ? COVERAGE_TILE_LIMIT : Infinity;
        this.coverageReport = {tiles: all.length, refined: Math.min(all.length, limit), limit};
        return all.slice(0, limit);
    }

    _radiance(scene, camera, settings, target, sky) {
        const changed = [], meshes = [];
        const savedBackground = scene.background, savedOverride = scene.overrideMaterial;
        const sun = new Vector3(settings.sunDirectionX, settings.sunDirectionY, settings.sunDirectionZ)
            .normalize().transformDirection(camera.matrixWorldInverse);
        for (const surface of this.resources.surfaces.values()) surface.used = false;
        for (const spectrum of this.resources.surfaceSpectra?.values() ?? []) spectrum.used = false;
        try {
            scene.background = null;
            scene.overrideMaterial = null;
            scene.updateMatrixWorld(true);
            const cloudHostStart = performance.now();
            const clouds = this.radianceAdapter?.cloudSheets?.(camera, settings, this.atmosphere);
            const hostPrepareMs = performance.now() - cloudHostStart;
            this.thermalSeaEnabled = settings.skySource === "atmosphere";
            this.thermalSensorAltitudeM = settings.sensorAltitudeM;
            this.cloudDiagnostics = clouds?.diagnostics ?? [];
            scene.traverse(object => {
                if (object.isLine || object.isLine2 || object.isLineSegments2 || object.isWireframe || object.isPoints || object.isSprite || object.isLight ||
                    object.type?.endsWith("Helper") || object.userData?.thermal === false) {
                    changed.push({object, visible: object.visible}); object.visible = false; return;
                }
                if (!object.isMesh) return;
                let visible = true;
                for (let ancestor = object; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) visible = false;
                if (!visible || !object.layers.test(camera.layers)) return;
                const attributes = this.radianceAdapter?.attributes?.(object, settings) ?? this._attributes(object, scene, settings);
                changed.push({object, visible: object.visible, material: object.material,
                    frustumCulled: object.frustumCulled, onBeforeRender: object.onBeforeRender, onAfterRender: object.onAfterRender});
                if (attributes === false) { object.visible = false; return; }
                // The analytic mean sea supplies full-frame radiance and depth.
                // Its boundary cannot depend on host ocean mesh tessellation.
                if ((attributes.sea || this.radianceAdapter?.isSea?.(object)) && this.thermalSeaEnabled) {object.visible = false; return;}
                // Visible-material callbacks may write uniforms or start RGB reflection captures.
                if (this.radianceAdapter) {
                    object.onBeforeRender = () => {};
                    object.onAfterRender = () => {};
                    object.frustumCulled = false; // apparent positions can be outside the physical frustum
                }
                const originals = Array.isArray(object.material) ? object.material : [object.material];
                const replacements = originals.map(original => this._surface(attributes, original, settings, sun));
                object.material = Array.isArray(object.material) ? replacements : replacements[0];
                meshes.push(object);
            });
            if (clouds?.sheets.length || this.cloudPass) {
                this.cloudPass ??= new ThermalCloudPass(this);
                const raycaster = new Raycaster(), origin = new Vector3().setFromMatrixPosition(camera.matrixWorld);
                raycaster.layers.mask = camera.layers.mask;
                const firstHitM = meshes.length && !this.rayGeometry ? point => {
                    const direction = new Vector3(...point).transformDirection(camera.matrixWorld);
                    raycaster.set(origin, direction); raycaster.far = Math.hypot(...point);
                    return raycaster.intersectObjects(meshes, false)[0]?.distance ?? Infinity;
                } : undefined;
                this.cloudPass.prepare(clouds?.sheets ?? [], camera, settings, clouds?.diagnostics ?? [], firstHitM);
                this.cloudPass.report.hostPrepareMs = hostPrepareMs;
            }
            this._drawRadiance(scene, camera, target, sky);
            const cropCamera = camera.clone(false);
            cropCamera.matrixAutoUpdate = false; cropCamera.matrixWorldAutoUpdate = false;
            for (const [column, row, width, height] of this._coverageTiles(meshes, camera, settings)) {
                const scaleX = settings.detectorWidth / width, scaleY = settings.detectorHeight / height;
                const centerX = (column + width / 2) * 2 / settings.detectorWidth - 1;
                const centerY = (row + height / 2) * 2 / settings.detectorHeight - 1;
                const crop = new Matrix4().set(scaleX, 0, 0, -centerX * scaleX,
                    0, scaleY, 0, -centerY * scaleY, 0, 0, 1, 0, 0, 0, 0, 1);
                cropCamera.projectionMatrix.multiplyMatrices(crop, camera.projectionMatrix);
                cropCamera.projectionMatrixInverse.copy(cropCamera.projectionMatrix).invert();
                const patch = this._target("coverage", width * COVERAGE_SAMPLES, height * COVERAGE_SAMPLES, true);
                this._drawRadiance(scene, cropCamera, patch, sky);
                const factor = COVERAGE_SAMPLES / settings.supersample;
                this._pass("average", shaders.averageFragment, {tInput: patch.texture, factor, fillFactor: 1,
                    outputOrigin: [column * settings.supersample, row * settings.supersample]}, target,
                [column * settings.supersample, row * settings.supersample, width * settings.supersample, height * settings.supersample]);
            }
        } finally {
            for (const entry of changed) {
                entry.object.visible = entry.visible;
                if (entry.material !== undefined) entry.object.material = entry.material;
                if (entry.frustumCulled !== undefined) {
                    entry.object.frustumCulled = entry.frustumCulled;
                    entry.object.onBeforeRender = entry.onBeforeRender;
                    entry.object.onAfterRender = entry.onAfterRender;
                }
            }
            for (const [key, surface] of this.resources.surfaces) if (!surface.used) {
                surface.material.dispose(); this._removeTexture(surface.texture); this.resources.surfaces.delete(key);
            }
            // Bound CPU cache lifetime to spectra used by the current scene.
            // dispose() releases these arrays with the owning resources object.
            for (const [key, spectrum] of this.resources.surfaceSpectra ?? [])
                if (!spectrum.used) this.resources.surfaceSpectra.delete(key);
            if (!this.resources.surfaces.size) this.resources.surfaceIllumination = null;
            scene.background = savedBackground;
            scene.overrideMaterial = savedOverride;
            target.viewport.set(0, 0, target.width, target.height);
        }
    }

    // Calculated reuse error: zero detector/display texels change. Only a completed,
    // settled interactive sample is eligible; queued redundant gain readbacks do not
    // need another settle once this frame's statistics have already been applied.
    _reuseState(frame) {
        if (this.analysis || this.synchronous || !this.hasFrame || !this.lastFrame ||
            this.lastFrame.held || !this.resources?.targets.has("display") || this.pendingOptics || this.opticsScheduler?.pending ||
            this.rangeCache?.pending || this.skyCache?.pending || this.gainSettle != null) return null;
        // Automatic gain must have settled on this frame's statistics of the scene now shown (see _gainParameters).
        if (["automatic", "plateau"].includes(this.settings?.gainMode) &&
            (this.gainReport?.settled !== true || this.gainReport.statisticsFrame !== frame)) return null;
        return [this.opticsScheduler?.domain, this.rangeCache?.domain, this.skyCache?.cached,
            this.activeKernels, this.skyTable, this.gainParameters];
    }

    /** scene geometry and camera positions are meters. settings use thermalSchema.js.
     * skyUp is optional local up in camera coordinates (array or Vector3).
     * target is an output render target, null for the canvas; frame is an integer index.
     * reuseKey is an opaque string covering all image inputs; null disables reuse.
     * holdFrame: true during playback; a draw inside a frame that already rendered shows that frame's image.
     * pace: true only when the host draws again on its next animation frame (GPU pacing, see below). A caller that
     * reads the image after this call (export, screenshot, comparison) leaves it false and always gets its frame.
     * Analysis and synchronous renders always evaluate the complete pipeline.
     * All internal targets are Float32; final output is normalized 8-bit display drive.
     */
    render({scene, camera, settings: input = {}, sounding = null, skyUp = null, target = null, frame = 0,
        radianceAdapter = null, presentation = null, psfRangeM = undefined, reuseKey = null, holdFrame = false, pace = false}) {
        const renderStart = performance.now();
        if (this.disposed) throw new Error("ThermalPipeline has been disposed");
        if (!scene || !camera) throw new TypeError("ThermalPipeline requires a scene and camera");
        if (!Number.isInteger(frame) || frame < 0 || frame > 4294967295) throw new RangeError("Thermal frame must be an unsigned 32-bit integer");
        this._initialize();
        // A sensor delivers one image per frame. During playback a host can draw several times inside one frame;
        // re-rendering would restart that frame's temporal filter and gain, so those draws show the frame's image.
        // GPU pacing: a live host asks for frames faster than the GPU completes them (about 200 ms of GPU time per
        // frame, measured live), so submitted frames queued up and each synchronous WebGL call waited behind the
        // queue. A paced render therefore starts only after the previous one has completed on the GPU. Until then a
        // draw shows the last image, and the host is asked for a render when the fence signals.
        const paced = pace === true && !this.analysis && !this.synchronous && this.hasFrame && this._gpuBusy();
        const hold = paced || holdFrame === true && !this.analysis && !this.synchronous && this.hasFrame &&
            this.lastFrame?.frame === frame && !this.lastFrame.held;
        const reuseState = this._reuseState(frame), completed = this.completedReuse;
        const reuse = hold || typeof reuseKey === "string" && completed?.key === reuseKey &&
            completed.frame === this.lastFrame && this.lastFrame.frame === frame &&
            reuseState && completed.state && reuseState.every((value, i) => value === completed.state[i]);
        const settings = reuse ? this.settings : normalizeSettings(psfRangeM === undefined ? input : {...input, psfRangeM});
        if (!reuse) {
            this.completedReuse = null;
            if (this.lastFrame) this.lastFrame.reused = false;
            this.renderSerial++;
            // The host's scene identity for this interactive render; gain samples carry it so that statistics recorded
            // before a paused edit never count as this scene's own. Analysis and synchronous renders ignore it.
            this.renderSceneKey = typeof reuseKey === "string" && !this.analysis && !this.synchronous ? reuseKey : null;
        }
        this.cpuStages = {};
        this.gpuTimer?.poll();
        const renderer = this.renderer;
        const saved = {target: renderer.getRenderTarget(), cubeFace: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
            viewport: renderer.getViewport(new Vector4()), scissor: renderer.getScissor(new Vector4()),
            scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear,
            shadow: renderer.shadowMap.enabled, xr: renderer.xr.enabled,
            clear: renderer.getClearColor(new Color()), alpha: renderer.getClearAlpha(),
            outputViewport: target?.viewport.clone(), outputScissorTest: target?.scissorTest,
            radianceAdapter: this.radianceAdapter};
        try {
            // Surface programs belong to their host adapter for the pipeline lifetime.
            this.radianceAdapter = radianceAdapter;
            renderer.autoClear = false; renderer.shadowMap.enabled = false; renderer.xr.enabled = false;
            if (reuse) {
                this._present(this.settings, presentation, target);
                this.lastFrame.reused = true; this.lastFrame.paced = paced;
                if (paced) this._awaitGpu();
                return;
            }
            // Read completed gain statistics before this frame's passes are queued. The read is a synchronous
            // round trip to the GPU process; issued after the passes it waited for them (up to 182 ms live).
            // A sample read before a render that returned early (caches not ready) stays until a newer one arrives.
            this.earlyGainSample = this.gainReadback?.poll() ?? this.earlyGainSample ?? null;
            const width = settings.detectorWidth, height = settings.detectorHeight, factor = settings.supersample;
            const fineWidth = width * factor, fineHeight = height * factor;
            const thermalCamera = this._camera(camera, settings);
            const skyView = skyViewGeometry(settings, skyUp, thermalCamera);
            this.rayGeometry = this.radianceAdapter?.rayGeometry?.(settings, skyView) ?? null;
            const axisElevationDeg = skyElevationRange(skyView).centerRad * 180 / Math.PI;
            this.skyView = skyView;
            // Generic hosts use image-right as zero bearing; Sitrec supplies true
            // geodetic north/east in camera coordinates through its lazy adapter.
            const up = new Vector3(...skyView.up);
            const base = new Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
            if (base.lengthSq() === 0) base.set(0, 0, 1);
            this.seaWind = this.radianceAdapter?.seaWind?.(settings) ?? base.applyAxisAngle(up, settings.seaWindDirectionRad).toArray();
            const pathSettings = {...settings, pathElevationDeg: axisElevationDeg};
            const atmosphereReady = this._stage("atmosphere", () => this._prepareAtmosphere(pathSettings, sounding));
            // The optical spectrum uses the same profile and ray as scene transfer.
            const opticsReady = this._stage("prepareOptics", () => this._prepareOptics(pathSettings, fineWidth, fineHeight));
            if (atmosphereReady === false || opticsReady === false) {
                if (this.hasFrame) {
                    this._present(this.settings, presentation, target);
                    this.lastFrame.held = true;
                    this.lastFrame.opticsCache = this.opticsReport;
                }
                return false;
            }
            this.hasFrame = false;
            const radiance = this._target("radiance", fineWidth, fineHeight, true);
            const optics = this._target("optics", fineWidth, fineHeight);
            const sampled = this._target("sampled", width, height);
            const counts = this._target("counts", width, height);
            const drive = this._target("drive", width, height);
            const display = this._target("display", width, height);
            this._stage("skyTable", () => this._prepareSkyBackground(settings, skyView));
            const sky = this.background.scaledPhotonRadiance;
            this._stage("radiance", () => this._radiance(scene, thermalCamera, settings, radiance, sky));
            // Checked once per allocation, as _pass does. The call waits for all queued GPU work, so checking on every
            // frame stalled each interactive frame by the GPU's whole frame time (measured 43 ms per call).
            const radianceSize = `${radiance.width},${radiance.height}`;
            if (this.resources.checkedSizes?.get(radiance) !== radianceSize) {
                const gl = renderer.getContext();
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
                    throw new Error("Thermal float framebuffer is incomplete; this GPU cannot allocate the requested radiance grid.");
                this.resources.checkedSizes?.set(radiance, radianceSize);
            }
            const skyBackground = this._target("skyBackground", fineWidth, fineHeight);
            this._stage("sky", () => this._drawSky(thermalCamera, skyBackground, sky));
            this._stage("optics", () => this._optics(radiance, optics, skyBackground));
            this._stage("sample", () => this._pass("average", shaders.averageFragment, {tInput: optics.texture, factor,
                fillFactor: settings.fillFactor, outputOrigin: [0, 0]}, sampled));
            const integrationTimeS = integrationTime(settings);
            this._prepareFixedPattern(settings);
            this._stage("detector", () => this._pass("detector", shaders.detectorFragment, {tInput: sampled.texture,
                exposureFactor: electronsPerRadiance(settings), darkCharge: settings.darkElectronsPerS * integrationTimeS,
                tFixedPattern: this.fixedPatternTexture, imageSize: [width, height],
                shadingAmplitude: settings.shadingK * shadingResponsivity(settings), shadingWidth: settings.shadingWidth,
                wellElectrons: settings.wellElectrons, adcOffsetCounts: settings.adcOffsetCounts, readSigma: settings.readNoiseElectrons,
                noiseEnabled: settings.noiseEnabled, shotEnabled: settings.shotNoiseEnabled,
                frame, noiseSeed: settings.noiseSeed, imageWidth: width}, counts));
            const historyKey = temporalHistoryKey(settings);
            const previous = this.temporalState;
            // A re-render of the same frame and the same host scene (for example the render that settles the gain)
            // repeats that frame's temporal step from the history it started from, so it shows the same image. An
            // edited scene, a backward seek or a host without a scene identity still resets, so paused edits
            // respond without ghosting.
            const repeat = !!previous && previous.key === historyKey && frame === previous.frame &&
                this.renderSceneKey != null && previous.sceneKey === this.renderSceneKey;
            const temporalBase = repeat ? previous.base :
                previous && previous.key === historyKey && frame > previous.frame ? {frame: previous.frame, target: previous.target} : null;
            const temporalReset = !temporalBase;
            const memory = temporalBase ? settings.temporalFilterAlpha ** (frame - temporalBase.frame) : 0;
            const filtered = repeat ? previous.target :
                this._target(previous?.target === this.resources.targets.get("temporalA") ? "temporalB" : "temporalA", width, height);
            this._stage("temporal", () => this._pass("temporal", shaders.temporalFragment, {tInput: counts.texture,
                tPrevious: memory ? temporalBase.target.texture : counts.texture, memory}, filtered));
            const gainKey = JSON.stringify([historyKey, settings.agcDynamics, settings.agcTimeConstantS, width, height, settings.gainMode, settings.sensorPreset,
                settings.gainRegion, settings.gainRegion === "displayed" ? [settings.digitalZoom, detectorPresentation(settings, presentation)] : null,
                settings.lowPercentile, settings.highPercentile, settings.minimumWindowCounts]);
            const reset = gainKey !== this.gainKey || this.lastFrame === null || frame <= this.lastFrame.frame;
            const deltaTimeS = reset ? 0 : (frame - this.lastFrame.frame) / settings.frameRateHz;
            const parameters = this._stage("gainStatistics", () => this._gainParameters(filtered, settings,
                {gainKey, reset, deltaTimeS, width, height, presentation, frame}));
            this._removeTexture(this.plateauTexture);
            this.plateauTexture = parameters.lut ? this._ownTexture(scalarTexture(parameters.lut.values, 256, 64)) : null;
            this._stage("processing", () => this._pass("processing", shaders.processingFragment, {tInput: filtered.texture,
                countWindow: [parameters.window.low, parameters.window.high], tPlateau: this.plateauTexture ?? this.emptyTexture,
                usePlateau: !!parameters.lut && !parameters.lut.constant}, drive));
            let mean = drive;
            if (settings.localAmount !== 0 && settings.localRadiusPx > 0) {
                if (this.localRadius !== settings.localRadiusPx) {
                    this._removeTexture(this.localWeights);
                    const kernel = gaussianKernel(settings.localRadiusPx, Math.ceil(4 * settings.localRadiusPx), true);
                    this.localWeights = this._ownTexture(scalarTexture(kernel.data));
                    this.localRadius = settings.localRadiusPx;
                }
                const horizontal = this._target("localHorizontal", width, height);
                mean = this._target("localVertical", width, height);
                const uniforms = {imageSize: [width, height], tWeights: this.localWeights,
                    radius: Math.ceil(4 * settings.localRadiusPx)};
                this._stage("localContrast", () => {
                    this._pass("localMean", shaders.localMeanFragment, {...uniforms, tInput: drive.texture, axis: 0}, horizontal);
                    this._pass("localMean", shaders.localMeanFragment, {...uniforms, tInput: horizontal.texture, axis: 1}, mean);
                });
            }
            const curveKey = `${settings.sensorPreset}:${settings.displayCurve}`;
            if (this.displayCurveKey !== curveKey) {
                this._removeTexture(this.displayCurveTexture);
                const lut = displayCurveLUT(settings);
                this.displayCurveTexture = lut ? this._ownTexture(scalarTexture(lut)) : null;
                this.displayCurveKey = curveKey;
            }
            this._stage("display", () => this._pass("display", shaders.displayFragment, {tInput: drive.texture, tMean: mean.texture,
                localAmount: settings.localAmount, responseGamma: settings.responseGamma,
                tDisplayCurve: this.displayCurveTexture ?? this.emptyTexture, useDisplayCurve: settings.displayCurve === "measured",
                polarityAffine: [settings.polarityAffineGain, settings.polarityAffineOffset],
                blackHot: settings.polarity === "blackHot"}, display));
            this._present(settings, presentation, target);
            this.temporalState = {frame, key: historyKey, target: filtered, base: temporalBase, sceneKey: this.renderSceneKey};
            this.window = parameters.window; this.gainKey = gainKey; this.lastFrame = {frame, integrationTimeS,
                opticsCache: this.opticsReport, rangeCache: this.rangeReport, coverage: this.coverageReport ?? null,
                psfSpectrum: this.psfSpectrum, detectorWindow: settings.detectorWindow,
                temporal: {alpha: settings.temporalFilterAlpha, memory, reset: temporalReset},
                opticalSampling: settings.opticalSampling, atmosphere: this.atmosphereProfile,
                clouds: this.cloudPass?.report ?? {sheets: 0, diagnostics: this.cloudDiagnostics},
                background: this.frameBackground, backgroundTemperatureK: this.background.brightnessTemperatureK,
                gain: {region: settings.gainRegion, statisticsCount: parameters.statisticsCount, window: {...parameters.window},
                    ...this.gainReport},
                blur: {turbulence: "long-exposure Kolmogorov", turbulenceR0M: settings.turbulenceR0M,
                    referenceWavelengthM: 4e-6, systemBlurHorizontalRmsUrad: settings.systemBlurHorizontalRmsUrad,
                    systemBlurVerticalRmsUrad: settings.systemBlurVerticalRmsUrad,
                    jitterRmsUrad: settings.jitterRmsUrad, diffusionSigmaPx: settings.diffusionSigmaPx},
                scatter: {...this.scatterSplit, farFFTWidth: this.scatterSplit.farMass ? this.farWidth : 0,
                    farFFTHeight: this.scatterSplit.farMass ? this.farHeight : 0,
                    // fftWidth/fftHeight above are the single-image reference sizes; this is the layout that ran.
                    nearConvolution: this.nearPlan ? {method: this.nearPlan.packed ? "packed overlap-add" : "single FFT",
                        tiles: [this.nearPlan.tilesX, this.nearPlan.tilesY],
                        fftWidth: this.nearPlan.fftWidth, fftHeight: this.nearPlan.fftHeight} : null}};
            this.settings = settings; this.hasFrame = true;
            this.lastFrame.reused = false; this.lastFrame.paced = false;
            this._fenceFrame();
            this.completedReuse = {key: typeof reuseKey === "string" ? reuseKey : null,
                frame: this.lastFrame, state: this._reuseState(frame)};
        } finally {
            this.radianceAdapter = saved.radianceAdapter;
            renderer.autoClear = saved.autoClear; renderer.shadowMap.enabled = saved.shadow; renderer.xr.enabled = saved.xr;
            renderer.setClearColor(saved.clear, saved.alpha);
            if (target) { target.viewport.copy(saved.outputViewport); target.scissorTest = saved.outputScissorTest; }
            renderer.setViewport(saved.viewport); renderer.setScissor(saved.scissor); renderer.setScissorTest(saved.scissorTest);
            renderer.setRenderTarget(saved.target, saved.cubeFace, saved.mip);
            if (this.hasFrame) this.lastFrame.timing = {status: "measured", tier: this.analysis ? "analysis" : "interactive",
                cpuMs: performance.now() - renderStart, stages: {...this.cpuStages},
                // Estimated frame budget. CPU submission is not completed GPU time.
                targetMs: 1000 / 30, gpuAvailable: !!this.gpuTimer?.extension,
                stagesAreInclusive: true,
                gpuSamples: this.gpuTimer?.samples.slice() ?? [], disjointSamples: this.gpuTimer?.disjointSamples ?? 0,
                targetBytes: [...this.resources.targets.values()].reduce((total, t) => total + t.width * t.height *
                    ((t.texture.format === RGBAFormat ? 16 : t.texture.format === RGFormat ? 8 : 4) + (t.depthBuffer ? 4 : 0)), 0)};
        }
    }

    _present(settings, presentation, target) {
        const diagnostic = settings.diagnosticView;
        const source = this.resources.targets.get(diagnostic === "radiance" ? "sampled" : diagnostic === "detectorCounts" ? "counts" : "display");
        const outputWindow = diagnostic === "radiance" ? [settings.radiometricLow, settings.radiometricHigh] :
            diagnostic === "detectorCounts" ? [0, 16383] : [0, 255];
        const mapping = detectorPresentation(settings, presentation), renderer = this.renderer;
        const outputSize = target ? new Vector2(target.width, target.height) :
            (renderer.getDrawingBufferSize?.(new Vector2()) ?? renderer.getSize(new Vector2()));
        this._stage("output", () => this._pass("enlarge", shaders.enlargeFragment, {tInput: source.texture,
            imageSize: [source.width, source.height], zoom: settings.digitalZoom, fieldScale: mapping.scale, fieldOffset: mapping.offset,
            outputSize: [outputSize.x, outputSize.y], windowScale: detectorWindowScale(settings), linearSampling: settings.sampling !== "nearest",
            sampleCentered: settings.sampling === "sampleCentered", outputWindow}, target));
    }

    _gainParameters(filtered, settings, {gainKey, reset, deltaTimeS, width, height, presentation, frame}) {
        const needsStatistics = ["automatic", "plateau"].includes(settings.gainMode);
        if (this.analysis || !needsStatistics) {
            const codes = needsStatistics ? this._read(filtered) : new Float32Array(0);
            this.gainReport = {mode: this.analysis ? "analysis" : "fixed", latencyFrames: 0, held: false};
            return processingParameters(codes, settings, reset ? null : this.window, deltaTimeS, width, height, presentation);
        }
        this.gainReadback ??= new FencedReadback(this.renderer.getContext());
        // A sample completed during this frame's submission is newer than the one read at its start.
        const ready = this.gainReadback.poll() ?? this.earlyGainSample ?? null;
        this.earlyGainSample = null;
        // A re-render of the same frame or a backward seek recomputes the window from this frame's own
        // statistics, as an analysis render does. An advancing frame applies the newest unused sample of an
        // earlier frame (normally the previous render's). A sample applies once, in render order, never across
        // a gain-key change and never from a later frame.
        const revisit = !!this.lastFrame && frame <= this.lastFrame.frame;
        const usable = ready?.key === gainKey && ready.serial > (this.gainSample?.serial ?? 0) &&
            (revisit ? ready.frame === frame : ready.frame <= frame);
        const historyValid = !reset && this.gainHistoryKey === gainKey;
        let parameters;
        if (usable) {
            // Elapsed time runs from the frame where the last sample applied, so held renders do not slow the response.
            const elapsedS = historyValid ? (frame - this.gainSample.appliedFrame) / settings.frameRateHz : deltaTimeS;
            parameters = processingParameters(ready.counts, settings, historyValid ? this.window : null,
                elapsedS, width, height, presentation);
            this.gainParameters = parameters; this.gainParametersKey = gainKey; this.gainHistoryKey = gainKey;
            this.gainSample = {serial: ready.serial, frame: ready.frame, appliedFrame: frame};
        } else {
            // No synchronous bootstrap. Hold the last valid window, also through a re-render or a seek, where it
            // is the best estimate until this frame's statistics arrive. Show the full ADC interval only before
            // the first sample and after a gain-key change: a re-render must not switch to a different picture.
            parameters = this.gainParametersKey === gainKey && this.gainParameters ? this.gainParameters :
                {window: {low: 0, high: 16383}, lut: null, statisticsCount: 0};
            if (!historyValid) this.gainHistoryKey = null;
        }
        const sceneTag = this.renderSceneKey == null ? null : `${this.renderSceneKey}#${this._imageStateEpoch()}`;
        const staging = this._target("gainReadback", width, height);
        const queued = this._stage("gainReadback", () => {
            this._pass("readback", shaders.copyFragment, {tInput: filtered.texture}, staging);
            return this.gainReadback.enqueue(width, height, {serial: this.renderSerial, key: gainKey, frame, scene: sceneTag});
        });
        // Settled: the window came from statistics of this frame and, when the host identifies its scene, of the
        // image now shown: the same scene and the same optics, range and sky state. A paused edit or newly arrived
        // kernels change that identity, so samples taken before do not settle the view. A host that renders on
        // demand may not render again, so ask for one more render once this render's samples are ready. Without a
        // scene identity the frame match is the only test available.
        const settled = !!usable && ready.frame === frame && (sceneTag == null || ready.scene === sceneTag);
        if (!settled) this._settleGain();
        this.gainReport = {mode: "fenced", latencyFrames: usable ? this.renderSerial - ready.serial : null, held: !usable,
            queued, missedDeadline: !usable && this.renderSerial > 1, statisticsFrame: this.gainSample?.frame ?? null, settled};
        return parameters;
    }

    // Counts changes of the prepared state that shapes the image beyond the host's scene: kernels, interpolation
    // domains and sky table. Any change starts a new epoch, so gain samples rendered before it cannot settle.
    _imageStateEpoch() {
        const state = [this.activeKernels, this.opticsScheduler?.domain, this.rangeCache?.domain, this.skyCache?.cached, this.skyTable];
        if (!this.imageState || state.some((value, i) => value !== this.imageState[i])) {
            this.imageState = state; this.imageStateEpochCount = (this.imageStateEpochCount ?? 0) + 1;
        }
        return this.imageStateEpochCount;
    }

    // Marks the end of a live frame's GPU work for pacing (see render). Analysis and synchronous renders never wait.
    _fenceFrame() {
        const gl = this.renderer.getContext?.();
        if (this.analysis || this.synchronous || typeof gl?.fenceSync !== "function") return;
        if (this.frameFence) gl.deleteSync(this.frameFence);
        this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this.frameFenceTime = performance.now();
    }

    // Non-blocking: the browser updates a fence's status between tasks. An estimated 2 s bound keeps a lost context
    // or a stalled GPU from holding the view; at most one more frame is then queued.
    _gpuBusy() {
        const fence = this.frameFence;
        if (!fence) return false;
        const gl = this.renderer.getContext();
        if (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED && performance.now() - this.frameFenceTime < 2000) return true;
        gl.deleteSync(fence); this.frameFence = null;
        return false;
    }

    _awaitGpu() {
        if (this.gpuWait != null) return;
        const check = () => {
            this.gpuWait = null;
            if (this.disposed) return;
            if (this._gpuBusy()) this.gpuWait = setTimeout(check, 8);
            else this.onReady();
        };
        this.gpuWait = setTimeout(check, 8);
    }

    _settleGain() {
        // Only the newest render waits; its sample is the one that settles the view.
        clearTimeout(this.gainSettle);
        const serial = this.renderSerial;
        const check = () => {
            this.gainSettle = null;
            // A newer render has its own sample in flight; nothing is waiting any more.
            if (this.disposed || this.renderSerial !== serial || !this.gainReadback?.pending?.length) return;
            if (this.gainReadback.signaled?.()) this.onReady();
            else this.gainSettle = setTimeout(check, 16);
        };
        this.gainSettle = setTimeout(check, 16);
    }

    // Read R, bottom row first, no normalization or color conversion.
    _read(target) {
        // RGBA/FLOAT readPixels is portable across float color-buffer formats.
        // Scalar/complex stages remain compact; staging exists only during readback.
        const renderer = this.renderer;
        let staging = null;
        const saved = {target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
            viewport: renderer.getViewport(new Vector4()), scissor: renderer.getScissor(new Vector4()),
            scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear};
        try {
            if (target.texture.format !== RGBAFormat) {
                staging = floatTarget(target.width, target.height, false, RGBAFormat);
                renderer.autoClear = false;
                this._pass("readback", shaders.copyFragment, {tInput: target.texture}, staging);
            }
            const rgba = new Float32Array(target.width * target.height * 4);
            renderer.readRenderTargetPixels(staging ?? target, 0, 0, target.width, target.height, rgba);
            return Float32Array.from({length: target.width * target.height}, (_, pixel) => rgba[pixel * 4]);
        } finally {
            staging?.dispose();
            renderer.autoClear = saved.autoClear;
            renderer.setRenderTarget(saved.target, saved.face, saved.mip);
            renderer.setViewport(saved.viewport); renderer.setScissor(saved.scissor); renderer.setScissorTest(saved.scissorTest);
        }
    }
    /** Fresh Float32Array of integer 14-bit codes, native grid, bottom row first. */
    readDetectorCounts() {
        if (!this.hasFrame) throw new Error("No completed thermal frame to read");
        return this._read(this.resources.targets.get("counts"));
    }
    /** Fresh native count image after the temporal recursion, before gain. */
    readFilteredCounts() {
        if (!this.hasFrame) throw new Error("No completed thermal frame to read");
        return this._read(this.temporalState.target);
    }
    /** Diagnostic readback. name: radiance/optics (fine scaled photon radiance),
     * farScatter (fine signed contrast, only when the far branch is active),
     * sampled (native scaled photon radiance), drive ([0,1]), display (8-bit codes).
     * Width/height are pixels; rows start at the lower-left, as in WebGL readPixels.
     */
    readStage(name) {
        if (!this.hasFrame || !["radiance", "optics", "sampled", "drive", "display", "farScatter"].includes(name) ||
            (name === "farScatter" && !this.scatterSplit?.farMass))
            throw new RangeError(`Thermal stage is unavailable: ${name}`);
        const target = this.resources.targets.get(name);
        return {image: this._read(target), width: target.width, height: target.height};
    }
    dispose() {
        clearTimeout(this.gainSettle); this.gainSettle = null;
        clearTimeout(this.gpuWait); this.gpuWait = null;
        if (this.frameFence) this.renderer.getContext?.()?.deleteSync?.(this.frameFence);
        this.frameFence = null;
        this.gainReadback?.dispose(); this.gpuTimer?.dispose();
        this.opticsScheduler?.dispose(); this.rangeCache?.dispose(); this.skyCache?.dispose?.();
        this.pendingOptics = null; this.activeKernels = null; this.opticalCache = null; this.skyCache = null;
        this.cloudPass?.dispose(); this.cloudPass = null;
        if (this.resources) {
            for (const target of this.resources.targets.values()) target.dispose();
            for (const pass of this.resources.materials.values()) pass.dispose();
            for (const surface of this.resources.surfaces.values()) surface.material.dispose();
            for (const texture of this.resources.textures) texture.dispose();
            this.quad?.geometry.dispose();
            this.resources = null;
        }
        this.counts = null; this.filteredCounts = null; this.temporalState = null; this.hasFrame = false; this.disposed = true;
    }
}

/** Conservative screen bound, also used for bounded shader composites. The
 * returned rectangle is in lower-left pixels; offscreen sheets need no CPU LUT.
 */
export function cloudScreenBounds(sheet, camera, width, height) {
    const center = sheet.apparentCenter ?? sheet.center;
    if (-center[2] <= camera.near || -center[2] >= camera.far) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [-.5, .5]) for (const y of [-.5, .5]) {
        const p = new Vector3(center[0] + x * sheet.size[0], center[1] + y * sheet.size[1], center[2]).applyMatrix4(camera.projectionMatrix);
        minX = Math.min(minX, (p.x + 1) * width / 2); maxX = Math.max(maxX, (p.x + 1) * width / 2);
        minY = Math.min(minY, (p.y + 1) * height / 2); maxY = Math.max(maxY, (p.y + 1) * height / 2);
    }
    const x = Math.max(0, Math.floor(minX)), y = Math.max(0, Math.floor(minY));
    const w = Math.min(width, Math.ceil(maxX)) - x, h = Math.min(height, Math.ceil(maxY)) - y;
    return w > 0 && h > 0 ? [x, y, w, h] : null;
}

export class ThermalCloudPass {
    constructor(pipeline) {
        this.pipeline = pipeline; this.cache = new Map();
        this.material = new ShaderMaterial({glslVersion: GLSL3, vertexShader: shaders.cloudVertex, fragmentShader: shaders.cloudFragment,
            uniforms: Object.fromEntries(["center", "apparentCenter", "size", "skyUp", "sensorAltitudeM", "maskTexture", "radianceTexture", "behindTexture", "tableSize", "opticalDepth", "semantics", "shaderComposite",
                "mappedSea", "tSeaGeometry", "seaGeometrySamples", "apparentHorizon"].map(k => [k, {value: null}])),
            depthTest: true, depthWrite: false, toneMapped: false, transparent: true,
            blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor});
        this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material); this.mesh.frustumCulled = false;
    }
    prepare(sheets, camera, settings, diagnostics = [], firstHitM) {
        this.sensorAltitudeM = settings.sensorAltitudeM;
        const start = performance.now(), sortStart = start;
        this.sheets = sortCloudSheets(sheets).map(sheet => ({...sheet}));
        const sortMs = performance.now() - sortStart;
        const p = this.pipeline, band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm};
        const domainKey = JSON.stringify([p.profileKey, band]);
        if (domainKey !== this.domainKey || this.domainAtmosphere !== p.atmosphere) {
            for (const entry of this.cache.values()) entry.texture.dispose(); this.cache.clear();
            this.domains = [false, true].map(isothermal => createCloudRadianceDomain(p.atmosphere, band, {isothermal}));
            this.domainKey = domainKey; this.domainAtmosphere = p.atmosphere;
        }
        const beforeEvaluations = this.domains.reduce((n, d) => n + d.evaluations, 0);
        const used = new Set(); let evaluations = 0, maxErrorK = 0, uploadedBytes = 0, visible = 0;
        for (const sheet of this.sheets) {
            sheet.table = null;
            // Calibrated opacity is already alpha; its opticalDepth is irrelevant.
            if (sheet.opticalDepth === 0 && sheet.maskSemantics !== "calibratedOpacity") continue;
            const maskData = sheet.mask?.image?.data;
            if (maskData && maskData.every((value, i) => i % 4 !== 3 || value === 0)) continue;
            if (!cloudScreenBounds(sheet, camera, 1, 1)) continue;
            used.add(sheet.id);
            const key = JSON.stringify([domainKey, sheet.center, sheet.apparentCenter, sheet.size, sheet.temperaturePolicy, sheet.temperatureK, settings.sensorAltitudeM, p.skyView.up, p.rayGeometry?.key]);
            let cached = this.cache.get(sheet.id);
            if (cached?.key !== key || firstHitM) {
                const table = cloudRadianceTable(sheet, p.atmosphere, {sensorAltitudeM: settings.sensorAltitudeM, up: p.skyView.up, band,
                    domain: this.domains[Number(sheet.temperaturePolicy === "isothermal")], firstHitM, rayGeometry: p.rayGeometry});
                if (table.empty) {cached?.texture.dispose(); this.cache.delete(sheet.id); continue;}
                if (!table.toleranceMet) throw new Error(`Cloud radiance interpolation exceeds ${table.toleranceK} K: ${sheet.id}`);
                const texture = new DataTexture(table.data, table.size, table.size, RedFormat, FloatType);
                texture.minFilter = texture.magFilter = NearestFilter; texture.colorSpace = NoColorSpace;
                texture.generateMipmaps = false; texture.needsUpdate = true;
                cached?.texture.dispose(); cached = {key, texture, table}; this.cache.set(sheet.id, cached);
                uploadedBytes += table.data.byteLength;
            }
            visible++;
            sheet.table = cached;
            maxErrorK = Math.max(maxErrorK, cached.table.maxErrorK);
        }
        for (const [id, entry] of this.cache) if (!used.has(id)) {entry.texture.dispose(); this.cache.delete(id);}
        evaluations = this.domains.reduce((n, d) => n + d.evaluations, 0) - beforeEvaluations;
        this.report = {sheets: sheets.length, visible, sortMs, prepareMs: performance.now() - start, evaluations,
            uploadedBytes, maxErrorK, drawCalls: 0, fragmentBound: 0, submitMs: 0, diagnostics,
            scattering: "absorptionOnly", temperature: "airAtAltitudeOrExplicitIsothermal", path: "straightSpherical",
            status: "calculated", gpuMs: null};
    }
    draw(camera, target, forceShaderComposite = false) {
        const p = this.pipeline, renderer = p.renderer, started = performance.now();
        const fallback = forceShaderComposite || !renderer.extensions.has("EXT_float_blend");
        this.report.composition = fallback ? "boundedShader" : "floatBlend";
        this.material.blending = fallback ? NoBlending : CustomBlending;
        this.mesh.layers.mask = camera.layers.mask;
        for (const sheet of this.sheets) {
            if (!sheet.table) continue;
            const bounds = cloudScreenBounds(sheet, camera, target.width, target.height);
            if (!bounds) continue;
            let behind;
            if (fallback) {
                behind = p._target("cloudBehind", target.width, target.height);
                p._pass("cloudCopy", shaders.cloudCopyFragment, {tInput: target.texture}, behind, bounds);
                this.report.drawCalls++;
            }
            const values = {center: sheet.center, apparentCenter: sheet.apparentCenter ?? sheet.center, size: sheet.size, maskTexture: sheet.mask,
                skyUp: p.skyView.up, sensorAltitudeM: this.sensorAltitudeM,
                mappedSea: false, tSeaGeometry: p.emptyTexture ?? sheet.table.texture, seaGeometrySamples: 2, apparentHorizon: 0,
                ...p._seaGeometryUniforms?.(),
                radianceTexture: sheet.table.texture, behindTexture: behind?.texture ?? p.emptyTexture,
                tableSize: sheet.table.table.size, opticalDepth: sheet.opticalDepth,
                semantics: ["normalizedColumn", "calibratedOpacity", "coverage"].indexOf(sheet.maskSemantics ?? "normalizedColumn"), shaderComposite: fallback};
            for (const [key, value] of Object.entries(values)) this.material.uniforms[key].value = value;
            target.viewport.set(0, 0, target.width, target.height); target.scissor.set(...bounds); target.scissorTest = true;
            renderer.setRenderTarget(target);
            renderer.render(this.mesh, camera);
            this.report.drawCalls++; this.report.fragmentBound += bounds[2] * bounds[3];
        }
        target.scissorTest = false; renderer.setScissorTest(false);
        this.report.submitMs += performance.now() - started;
    }
    dispose() {
        this.material.dispose(); this.mesh.geometry.dispose();
        for (const entry of this.cache.values()) entry.texture.dispose(); this.cache.clear();
    }
}

/** WebGL 2 pixel-pack readback. The fence is polled with zero timeout; no buffer
 * is copied until signaled. Tags bind statistics to the submitted render, so a
 * seek, resize or processing edit cannot consume unrelated samples.
 */
export class FencedReadback {
    constructor(gl) { this.gl = gl; this.pending = []; this.free = []; }
    enqueue(width, height, tag) {
        // Estimated bounded queue: two in-flight frames. A busy GPU causes a
        // reported missed statistic, never an unbounded queue or a blocking wait.
        if (this.pending.length >= 2) return false;
        const gl = this.gl, buffer = this.free.pop() ?? gl.createBuffer();
        const binding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        let fence;
        try {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 16, gl.STREAM_READ);
            // Set the pack state this read needs without querying it first. Chrome answers a pack-state query with a
            // synchronous round trip to the GPU process, which waited 110-128 ms behind the queued optics passes
            // (measured live). Zero is the WebGL default, which three.js restores in resetState and no other Sitrec
            // code changes. RGBA/FLOAT rows are a multiple of 16 bytes, so every PACK_ALIGNMENT reads them unpadded.
            for (const name of [gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS]) gl.pixelStorei(name, 0);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, 0);
            fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (!fence) throw new Error("Thermal gain fence allocation failed");
            this.pending.push({buffer, fence, width, height, tag});
            gl.flush();
            return true;
        } catch (error) {
            if (fence) gl.deleteSync(fence);
            gl.deleteBuffer(buffer);
            throw error;
        } finally {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, binding);
        }
    }
    /** True when the oldest in-flight readback has completed; it is not consumed. */
    signaled() {
        const item = this.pending[0], gl = this.gl;
        return !!item && gl.getSyncParameter(item.fence, gl.SYNC_STATUS) === gl.SIGNALED;
    }
    poll() {
        const gl = this.gl; let latest = null;
        while (this.pending.length) {
            const item = this.pending[0], state = gl.clientWaitSync(item.fence, 0, 0);
            if (state === gl.TIMEOUT_EXPIRED) break;
            this.pending.shift();
            gl.deleteSync(item.fence);
            if (state === gl.WAIT_FAILED) {gl.deleteBuffer(item.buffer); throw new Error("Thermal gain fence failed");}
            const binding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
            try {
                const rgba = new Float32Array(item.width * item.height * 4);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, item.buffer);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, rgba);
                const counts = new Float32Array(item.width * item.height);
                for (let pixel = 0; pixel < counts.length; pixel++) counts[pixel] = rgba[pixel * 4];
                latest = {counts, ...item.tag};
            } finally {
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, binding);
                this.free.push(item.buffer);
            }
        }
        return latest;
    }
    dispose() {
        for (const item of this.pending) {this.gl.deleteSync(item.fence); this.gl.deleteBuffer(item.buffer);}
        for (const buffer of this.free) this.gl.deleteBuffer(buffer);
        this.pending = []; this.free = [];
    }
}

/** Nonblocking elapsed GPU queries, grouped by render and stage. Disjoint
 * samples are discarded, never reported as timings. Enable only for diagnostics.
 */
export class ThermalGpuTimer {
    constructor(gl) {
        this.gl = gl; this.extension = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        this.pending = []; this.samples = []; this.disjointSamples = 0;
    }
    begin(frame, stage) {
        const gl = this.gl, ext = this.extension;
        if (!ext || this.pending.length >= 256 || gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return false;
        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        this.active = {query, frame, stage};
        return true;
    }
    end() {
        if (!this.active) return;
        this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
        this.pending.push(this.active); this.active = null;
    }
    poll() {
        if (!this.extension) return;
        const gl = this.gl;
        const disjoint = gl.getParameter(this.extension.GPU_DISJOINT_EXT);
        this.pending = this.pending.filter(item => {
            if (!disjoint && !gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) return true;
            if (disjoint) this.disjointSamples++;
            else this.samples.push({frame: item.frame, stage: item.stage,
                ms: gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6}); // calculated ns to ms
            gl.deleteQuery(item.query); return false;
        });
        if (this.samples.length > 4096) this.samples.splice(0, this.samples.length - 4096);
    }
    dispose() {
        this.end();
        for (const item of this.pending) this.gl.deleteQuery(item.query);
        this.pending = [];
    }
}
