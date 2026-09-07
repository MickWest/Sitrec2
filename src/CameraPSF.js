// Loading a diffraction point spread function onto a camera.
//
// A .psf.json is produced by tools/psf (the Diffraction PSF Studio) and carries the PSF as an
// RGBE-encoded PNG plus the optics it was computed for. This module turns one into a texture
// the glare pass can splat, and nothing more - the rendering lives in CDiffractionGlarePass.
//
// TWO DECODE STEPS, AND WHY BOTH ARE NEEDED:
//
//   1. The PNG arrives as RGBE: three 8-bit mantissas and a shared 8-bit exponent, which is
//      how ~13 decades of range fit in four bytes. It MUST be uploaded unfiltered, because
//      interpolating between two texels with different exponents is meaningless - the
//      hardware would blend the mantissas and the exponents independently and produce a
//      value that is not between the two neighbours at all.
//
//   2. So it is decoded once, on the GPU, into a half-float render target. That target CAN
//      be filtered and mipmapped, which matters more than it might sound: the physical
//      angular size of this pattern is often only a few dozen pixels on screen, so the PSF
//      is usually MINIFIED, and minifying a one-pixel-wide spike without mipmaps makes it
//      strobe in and out as the camera moves.
//
// The format definition is imported from the tool rather than restated here, so the encoder
// and the decoder cannot drift apart.

import {
    ClampToEdgeWrapping,
    HalfFloatType,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    NearestFilter,
    OrthographicCamera,
    PlaneGeometry,
    RGBAFormat,
    Scene,
    ShaderMaterial,
    Texture,
    WebGLRenderTarget,
} from "three";

import { RGBE_DECODE_GLSL, validatePSFFile } from "../tools/psf/psfFile.js";

/** One decode of an RGBE texture into linear light, PEAK NORMALISED.
 *
 *  The normalisation is not cosmetic. The PSF is stored flux normalised - it sums to 1 over
 *  a quarter of a million pixels - so its typical value is around 1e-6 and its tail runs to
 *  1e-13. Half float flushes to zero below about 6e-8, so decoding the stored values
 *  directly produces an entirely black texture with an alpha channel: measured, and the
 *  reason this divides by the peak here and multiplies by it again in the splat shader. The
 *  texture then spans 1.0 down to the export floor, which half float holds comfortably, and
 *  the kernel is still exactly flux normalised by the time it is used. */
const DECODE_SHADER = {
    uniforms: { tRGBE: { value: null }, invPeak: { value: 1 } },
    vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
    fragmentShader: `
        uniform sampler2D tRGBE;
        uniform float invPeak;
        varying vec2 vUv;
        ${RGBE_DECODE_GLSL}
        void main() { gl_FragColor = vec4(decodeRGBE(texture2D(tRGBE, vUv)) * invPeak, 1.0); }`,
};

/** Load an <img> from a data URL. Kept separate because the error path matters: a truncated
 *  or non-image data URL otherwise fails as a silently black texture. */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("PSF image data could not be decoded"));
        img.src = src;
    });
}

/**
 * Parse a .psf.json and produce a renderable PSF.
 *
 * @param {object}          json      the parsed file contents
 * @param {WebGLRenderer}   renderer  needed for the one-time RGBE decode pass
 * @returns {Promise<object>} { texture, size, anglePerPixelRad, fieldRad, name, note, meta }
 * @throws if the file is not a PSF this build understands - the caller should surface it.
 */
export async function loadPSF(json, renderer) {
    const problem = validatePSFFile(json);
    if (problem) throw new Error(`Not a usable PSF file: ${problem}`);

    const img = await loadImage(json.image);
    const n = json.size;

    // Upload the RGBE bytes untouched: no filtering, no premultiplication, no colour space
    // conversion. Any of those would corrupt the exponent channel.
    const rgbe = new Texture(img);
    rgbe.magFilter = NearestFilter;
    rgbe.minFilter = NearestFilter;
    rgbe.generateMipmaps = false;
    rgbe.premultiplyAlpha = false;
    rgbe.flipY = false;
    rgbe.needsUpdate = true;

    const target = new WebGLRenderTarget(n, n, {
        format: RGBAFormat,
        type: HalfFloatType,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
        wrapS: ClampToEdgeWrapping,
        wrapT: ClampToEdgeWrapping,
        generateMipmaps: true,
        depthBuffer: false,
        stencilBuffer: false,
    });

    // A file with no recorded peak (or a zero one) is taken at face value rather than
    // scaled by a guess; it will simply be dark, which is at least honest.
    const peak = Number.isFinite(json.peak) && json.peak > 0 ? json.peak : 1;

    const material = new ShaderMaterial({
        uniforms: { tRGBE: { value: rgbe }, invPeak: { value: 1 / peak } },
        vertexShader: DECODE_SHADER.vertexShader,
        fragmentShader: DECODE_SHADER.fragmentShader,
        depthTest: false,
        depthWrite: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), material));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);

    material.dispose();
    scene.children[0].geometry.dispose();
    rgbe.dispose();

    return {
        texture: target.texture,
        renderTarget: target,             // kept so the caller can dispose it
        size: n,
        // The texture is peak normalised; multiplying by this restores the flux-normalised
        // kernel. See the note on DECODE_SHADER for why it cannot simply be baked in.
        peak,
        // The angular half-extent of the whole pattern. This, not a pixel count, is what
        // makes the PSF physical: it says how wide the pattern is ON THE SKY, so it can be
        // drawn correctly at any focal length instead of at a size someone guessed.
        anglePerPixelRad: json.anglePerPixelRad ?? 0,
        fieldRad: (json.anglePerPixelRad ?? 0) * n,
        name: json.name || "PSF",
        note: json.note || "",
        meta: json,
    };
}

/** Read a File (from a picker or a drop) and load it. */
export async function loadPSFFromFile(file, renderer) {
    return loadPSF(JSON.parse(await file.text()), renderer);
}

/** Free everything a loaded PSF holds. Textures owned by a render target are freed with it. */
export function disposePSF(psf) {
    if (psf?.renderTarget) psf.renderTarget.dispose();
}
