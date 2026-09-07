// Diffraction glare: convolving the rendered frame with a camera's point spread function.
//
// An incoherent imaging system is a convolution, image = scene * PSF, and diffraction glare
// is simply the non-core part of that. The difficulty is that a useful PSF is 512x512, so a
// gather convolution would need 262,144 texture reads per output pixel. That is not a
// tractable shader.
//
// THE WAY ROUND IT IS TO SCATTER RATHER THAN GATHER. A convolution can be written either way
// - "for each output pixel, sum over the kernel" or "for each input pixel, add a scaled copy
// of the kernel" - and they give the same answer. Written as a scatter it becomes a drawing
// problem the GPU is built for: one instanced, additively blended quad per bright input
// texel, textured with the PSF. The cost is then set by how many texels are BRIGHT, not by
// how big the kernel is, and in a frame with a handful of bright sources that is a few dozen
// quads. This is the same technique used for bokeh and anamorphic streak rendering.
//
// The bright pass runs at 1/8 resolution, so the worst case - an entirely blown-out frame -
// is bounded at (w/8)*(h/8) quads rather than w*h. Texels below the threshold collapse to a
// degenerate triangle in the vertex shader and cost no fragments at all.
//
// WHAT THIS IS NOT. The core of the PSF is not removed from the source before splatting, so
// the bright core is added on top of a scene that already contains it. That is the standard
// bloom compromise and it is what the threshold is for: raising it subtracts the part of the
// source that is already correctly drawn. The preview in tools/psf composes the same way, so
// what that shows is what this produces.

import {
    AdditiveBlending,
    BufferAttribute,
    Color,
    HalfFloatType,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    LinearFilter,
    Mesh,
    NoBlending,
    OrthographicCamera,
    RGBAFormat,
    Scene,
    ShaderMaterial,
    Vector2,
    WebGLRenderTarget,
} from "three";

/** Rec. 709 luminance, matching the tool's glare preview so the two agree about which
 *  pixels glare. Restated in GLSL rather than shared, because there is nowhere sensible to
 *  put three constants that both a JS module and a shader can read. */
const LUMA = "vec3(0.2126, 0.7152, 0.0722)";

const BRIGHT_FS = `
    uniform sampler2D tDiffuse;
    uniform vec2 texelSize;        // one FULL-resolution texel, in uv
    uniform float threshold;
    uniform int boxSteps;          // the downsample factor, so the box matches it exactly
    varying vec2 vUv;

    void main() {
        // THRESHOLD FIRST, AT FULL RESOLUTION, THEN SUM. The order matters enormously and
        // the obvious order is wrong: averaging the 8x8 box first turns a one-pixel star at
        // 1.0 into 0.016, which no useful threshold survives - so the very sources that
        // produce diffraction spikes are precisely the ones that get averaged away. Measured
        // on a night sky: with the average taken first, not one texel in the frame cleared a
        // threshold of 0.5 even though the stars were at 0.999.
        //
        // Summing rather than averaging is also what conserves flux: the result is the total
        // over-threshold light in this box, which is exactly what one PSF copy should carry.
        vec3 sum = vec3(0.0);
        for (int j = 0; j < 16; j++) {
            if (j >= boxSteps) break;
            for (int i = 0; i < 16; i++) {
                if (i >= boxSteps) break;
                vec2 o = (vec2(float(i), float(j)) - float(boxSteps - 1) * 0.5) * texelSize;
                vec3 c = texture2D(tDiffuse, vUv + o).rgb;
                // Threshold on LUMINANCE and keep the original hue: thresholding each
                // channel separately would tint a just-over-threshold source toward
                // whichever channel cleared it first.
                float L = dot(c, ${LUMA});
                sum += c * (L > 0.0 ? max(0.0, L - threshold) / L : 0.0);
            }
        }
        gl_FragColor = vec4(sum, 1.0);
    }`;

const SPLAT_VS = `
    attribute vec2 aCell;          // instanced: which bright-buffer texel this quad is for
    uniform sampler2D tBright;
    uniform vec2 brightSize;
    uniform vec2 outSize;
    uniform float psfPixels;       // PSF footprint across, in output pixels
    varying vec2 vPsfUv;
    varying vec3 vColor;

    void main() {
        vec2 uv = (aCell + 0.5) / brightSize;
        vec3 c = texture2D(tBright, uv).rgb;

        // Dark texels are the overwhelming majority. Collapsing them to a degenerate
        // position outside the clip volume means they cost one vertex shader invocation and
        // ZERO fragments, which is what keeps this affordable at full kernel size.
        if (dot(c, ${LUMA}) <= 0.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vColor = vec3(0.0);
            vPsfUv = vec2(0.0);
            return;
        }

        vColor = c;
        vPsfUv = position.xy + 0.5;                     // PlaneGeometry spans -0.5..0.5
        vec2 centreNdc = uv * 2.0 - 1.0;
        gl_Position = vec4(centreNdc + position.xy * 2.0 * psfPixels / outSize, 0.0, 1.0);
    }`;

const SPLAT_FS = `
    uniform sampler2D tPsf;
    uniform float psfPeak;
    varying vec2 vPsfUv;
    varying vec3 vColor;
    void main() {
        // The PSF has already been decoded to linear half-float by CameraPSF.loadPSF, so it
        // can simply be read - and, unlike the RGBE original, filtered and mipmapped. It is
        // stored PEAK NORMALISED because the flux-normalised values underflow half float;
        // psfPeak puts the scale back, so the kernel here still sums to one.
        gl_FragColor = vec4(vColor * texture2D(tPsf, vPsfUv).rgb * psfPeak, 1.0);
    }`;

const COMPOSITE_FS = `
    uniform sampler2D tDiffuse;
    uniform sampler2D tGlare;
    uniform float gain;
    varying vec2 vUv;
    void main() {
        gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb + texture2D(tGlare, vUv).rgb * gain, 1.0);
    }`;

const FULLSCREEN_VS = `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`;

/** A custom pass in a CNodeEffect chain. Flagged `isCustomPass` so CNodeView3D calls
 *  render() instead of drawing its material on the shared fullscreen quad - this pass needs
 *  three draws and two intermediate targets, which the shared quad cannot express. */
export class CDiffractionGlarePass {
    isCustomPass = true;

    constructor(params = {}) {
        this.downsample = params.downsample ?? 8;
        this.threshold = params.threshold ?? 1.0;
        this.gain = params.gain ?? 1.0;
        this.sizeScale = params.sizeScale ?? 1.0;
        this.psf = null;                 // set by the owning CNodeEffect each frame

        this.width = 0;
        this.height = 0;
        this.step = 0;          // the downsample factor the targets were actually built for
        this.brightTarget = null;
        this.glareTarget = null;
        this.instanceCapacity = 0;

        this.scene = new Scene();
        this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._savedClear = new Color();

        this.brightMaterial = new ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                texelSize: { value: new Vector2() },
                threshold: { value: 1 },
                boxSteps: { value: 8 },
            },
            vertexShader: FULLSCREEN_VS,
            fragmentShader: BRIGHT_FS,
            depthTest: false, depthWrite: false, blending: NoBlending,
        });

        this.splatMaterial = new ShaderMaterial({
            uniforms: {
                tBright: { value: null },
                tPsf: { value: null },
                brightSize: { value: new Vector2() },
                outSize: { value: new Vector2() },
                psfPixels: { value: 64 },
                psfPeak: { value: 1 },
            },
            vertexShader: SPLAT_VS,
            fragmentShader: SPLAT_FS,
            transparent: true,
            blending: AdditiveBlending,
            depthTest: false, depthWrite: false,
        });

        this.compositeMaterial = new ShaderMaterial({
            uniforms: { tDiffuse: { value: null }, tGlare: { value: null }, gain: { value: 1 } },
            vertexShader: FULLSCREEN_VS,
            fragmentShader: COMPOSITE_FS,
            depthTest: false, depthWrite: false, blending: NoBlending,
        });

        this.splatMesh = null;
    }

    /** Rebuild the instanced quad grid. One instance per bright-buffer texel. */
    _buildSplatMesh(cellsX, cellsY) {
        const count = cellsX * cellsY;
        if (this.splatMesh && this.instanceCapacity === count) return;

        if (this.splatMesh) {
            this.splatMesh.geometry.dispose();
            this.scene.remove(this.splatMesh);
        }

        const geometry = new InstancedBufferGeometry();
        // Two triangles spanning -0.5..0.5, matching what the vertex shader assumes.
        geometry.setAttribute("position", new BufferAttribute(new Float32Array([
            -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
        ]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);

        const cells = new Float32Array(count * 2);
        for (let y = 0, i = 0; y < cellsY; y++) {
            for (let x = 0; x < cellsX; x++, i++) {
                cells[i * 2] = x;
                cells[i * 2 + 1] = y;
            }
        }
        geometry.setAttribute("aCell", new InstancedBufferAttribute(cells, 2));
        geometry.instanceCount = count;

        this.splatMesh = new Mesh(geometry, this.splatMaterial);
        this.splatMesh.frustumCulled = false;    // positions come from a texture, not the bounds
        this.instanceCapacity = count;
    }

    /** (Re)allocate the intermediate targets and the instance grid.
     *
     *  The downsample factor is part of the identity here, not just of the shader: it sets
     *  the bright target's resolution AND the number of splat instances. Testing only the
     *  view size meant that moving "Bright Pass" changed the box the shader averages over
     *  while leaving the target and the instance grid at the old factor - so sources were
     *  missed and the splat positions no longer matched the texels they were reading. */
    setSize(width, height) {
        const step = Math.max(1, Math.min(16, Math.round(this.downsample)));
        if (width === this.width && height === this.height && step === this.step) return;
        this.width = width;
        this.height = height;
        this.step = step;

        const bw = Math.max(1, Math.ceil(width / step));
        const bh = Math.max(1, Math.ceil(height / step));

        this.brightTarget?.dispose();
        this.glareTarget?.dispose();

        const opts = {
            format: RGBAFormat,
            // Half float throughout: a bright source is far above 1.0 in linear light, and an
            // 8-bit intermediate would clamp it to white and throw away exactly the
            // information that decides how far the spikes reach.
            type: HalfFloatType,
            minFilter: LinearFilter, magFilter: LinearFilter,
            depthBuffer: false, stencilBuffer: false,
        };
        this.brightTarget = new WebGLRenderTarget(bw, bh, opts);
        this.glareTarget = new WebGLRenderTarget(width, height, opts);

        this._buildSplatMesh(bw, bh);
    }

    /** Draw one full-screen material into `target`. */
    _blit(renderer, material, target) {
        if (!this.quad) {
            const geometry = new InstancedBufferGeometry();
            geometry.setAttribute("position", new BufferAttribute(new Float32Array([
                -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
            ]), 3));
            geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
            geometry.setIndex([0, 1, 2, 0, 2, 3]);
            geometry.instanceCount = 1;
            this.quad = new Mesh(geometry, material);
            this.quad.frustumCulled = false;
        }
        this.quad.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.quad, this.camera);
    }

    /**
     * @param {WebGLRenderer}     renderer
     * @param {WebGLRenderTarget} writeTarget where the composited result goes
     * @param {WebGLRenderTarget} readTarget  the frame so far
     * @param {number}            psfPixels   PSF footprint across, in output pixels
     */
    render(renderer, writeTarget, readTarget, psfPixels) {
        const size = renderer.getDrawingBufferSize(new Vector2());
        const w = writeTarget?.width || size.x;
        const h = writeTarget?.height || size.y;
        this.setSize(w, h);
        const step = this.step;

        // Cost is (bright texels) x (psfPixels squared), so an over-enthusiastic size
        // multiplier on a narrow field of view can ask for billions of fragments. Past about
        // twice the frame the pattern is mostly off screen anyway, so clamping there costs
        // nothing visible and removes the cliff.
        psfPixels = Math.min(psfPixels, 2 * Math.max(w, h));

        // 1. Bright pass, downsampled.
        this.brightMaterial.uniforms.tDiffuse.value = readTarget.texture;
        this.brightMaterial.uniforms.texelSize.value.set(1 / w, 1 / h);
        this.brightMaterial.uniforms.threshold.value = this.threshold;
        this.brightMaterial.uniforms.boxSteps.value = step;
        this._blit(renderer, this.brightMaterial, this.brightTarget);

        // 2. Splat one PSF copy per bright texel, additively.
        this.splatMaterial.uniforms.tBright.value = this.brightTarget.texture;
        this.splatMaterial.uniforms.tPsf.value = this.psf.texture;
        this.splatMaterial.uniforms.brightSize.value.set(this.brightTarget.width, this.brightTarget.height);
        this.splatMaterial.uniforms.outSize.value.set(w, h);
        this.splatMaterial.uniforms.psfPixels.value = psfPixels;
        this.splatMaterial.uniforms.psfPeak.value = this.psf.peak ?? 1;

        this.scene.clear();
        this.scene.add(this.splatMesh);
        renderer.setRenderTarget(this.glareTarget);
        // Save and restore the clear colour. The renderer is shared with the rest of the
        // view's rendering, and leaving it set to transparent black here would silently
        // change what every later clear does.
        renderer.getClearColor(this._savedClear);
        const savedAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.render(this.scene, this.camera);
        renderer.setClearColor(this._savedClear, savedAlpha);

        // 3. Composite back over the frame.
        this.compositeMaterial.uniforms.tDiffuse.value = readTarget.texture;
        this.compositeMaterial.uniforms.tGlare.value = this.glareTarget.texture;
        this.compositeMaterial.uniforms.gain.value = this.gain;
        this._blit(renderer, this.compositeMaterial, writeTarget);
    }

    dispose() {
        this.brightTarget?.dispose();
        this.glareTarget?.dispose();
        this.splatMesh?.geometry.dispose();
        this.quad?.geometry.dispose();
        this.brightMaterial.dispose();
        this.splatMaterial.dispose();
        this.compositeMaterial.dispose();
    }
}

/**
 * The PSF's footprint in output pixels, from its angular size and the camera's field of view.
 *
 * This is the number that makes the glare physical rather than decorative: the pattern has a
 * real angular size, fixed by the aperture and the wavelength, so zooming in must make it
 * BIGGER on screen, exactly as it does for everything else in the frame.
 *
 * @param {object} psf         from CameraPSF.loadPSF; needs fieldRad
 * @param {number} vFovDeg     the camera's vertical field of view
 * @param {number} heightPx    the view height in pixels
 * @param {number} scale       user multiplier; 1 is the physically correct size
 */
export function psfScreenPixels(psf, vFovDeg, heightPx, scale = 1) {
    if (!psf || !psf.fieldRad || !vFovDeg || !heightPx) return 0;
    const radiansPerPixel = (vFovDeg * Math.PI) / 180 / heightPx;
    return (psf.fieldRad / radiansPerPixel) * scale;
}
