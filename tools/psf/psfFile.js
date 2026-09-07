// The .psf.json interchange format, and the RGBE-PNG encoder that carries the pixels.
//
// A PSF spans a dozen decades of intensity, so 8-bit-per-channel is hopeless on its own and
// float is 3 MB before base64. RGBE is the standard answer: three 8-bit mantissas plus one
// shared 8-bit exponent, giving roughly 1% relative accuracy over the whole range in the
// same four bytes an ordinary pixel costs.
//
// WHY THE PNG IS BUILT BYTE BY BYTE INSTEAD OF WITH canvas.toDataURL. A canvas is allowed to
// store its pixels premultiplied by alpha. RGBE puts the EXPONENT in alpha, where a typical
// value is around 110/255 - so a canvas round trip would multiply every mantissa by 0.43,
// round it to 8 bits, and divide it back out, destroying the low bits of every pixel. Going
// straight to PNG bytes sidesteps that completely, and CompressionStream gives us the zlib
// stream PNG wants for free.
//
// THE FILE ALSO CARRIES ITS OWN GENERATOR SPEC. That is deliberate: the image is what Sitrec
// consumes, and the spec is what lets the tool reopen a saved PSF and keep editing it. A few
// hundred bytes buys a file that is never a dead end.

export const PSF_FORMAT = "sitrec-psf";
export const PSF_VERSION = 1;

/** GLSL that decodes an RGBE texel. Exported as a string so the shader and the encoder
 *  below cannot drift apart - there is exactly one statement of the convention.
 *
 *  NOTE THE 255. rgbeDecode() below works on RAW BYTES, but a GLSL texture read hands back
 *  0..1, so the mantissas have to be scaled back to byte range before the exponent is
 *  applied. Leaving it out decodes every pixel 255 times too dark - which looks like "the
 *  glare does not work" rather than like a scale error, and is exactly the bug that shipped
 *  in the first draft of this file. The exponent is rounded rather than truncated for the
 *  same reason: 127.0/255.0*255.0 is not always exactly 127.0. */
export const RGBE_DECODE_GLSL = `
vec3 decodeRGBE(vec4 t) {
    // Alpha holds exponent+128; a zero alpha means a zero pixel, not exponent -128.
    if (t.a == 0.0) return vec3(0.0);
    float e = floor(t.a * 255.0 + 0.5);
    return t.rgb * 255.0 * exp2(e - 128.0 - 8.0);
}`;

/** Encode linear RGB floats as RGBE bytes. Layout is RGBA8, row-major, top row first.
 *
 *  `floor` discards any pixel whose mean channel falls below it. That is not a rounding
 *  convenience, it is most of the file size: the deep tail of a PSF is incompressible
 *  low-order mantissa noise spread over most of the image, and it is far below anything a
 *  display or a sensor can represent. Measured on the 512^2 Chandelier preset - flooring at
 *  1e-7 of the peak takes the PNG from 635 kB to 80 kB and costs 0.11% of the total flux,
 *  while the faintest structure anyone looks at (the inter-spike background) sits at 1e-6. */
export function rgbeEncode(rgb, w, h, floor = 0) {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0, e = w * h; i < e; i++) {
        const r = Math.max(0, rgb[i * 3]), g = Math.max(0, rgb[i * 3 + 1]), b = Math.max(0, rgb[i * 3 + 2]);
        if (floor > 0 && (r + g + b) / 3 < floor) continue;
        const m = Math.max(r, g, b);
        if (!(m > 1e-38)) continue;                    // leaves RGBA at 0,0,0,0
        // e chosen so the mantissas land in [0, 256): m / 2^e is in [0.5, 1).
        let ex = Math.floor(Math.log2(m)) + 1;
        if (ex < -127) ex = -127; else if (ex > 127) ex = 127;
        const s = 256 / Math.pow(2, ex);
        // Round, not truncate: truncation biases every mantissa down by half a step, which
        // over a 512^2 kernel is a systematic ~0.2% flux loss rather than random noise.
        out[i * 4]     = Math.min(255, Math.round(r * s));
        out[i * 4 + 1] = Math.min(255, Math.round(g * s));
        out[i * 4 + 2] = Math.min(255, Math.round(b * s));
        out[i * 4 + 3] = ex + 128;
    }
    return out;
}

/** Decode RGBE bytes back to linear floats. The exact inverse of rgbeEncode, and the JS twin
 *  of RGBE_DECODE_GLSL - used to verify a round trip rather than in the render path. */
export function rgbeDecode(bytes, w, h) {
    const out = new Float32Array(w * h * 3);
    for (let i = 0, e = w * h; i < e; i++) {
        const a = bytes[i * 4 + 3];
        if (a === 0) continue;
        const s = Math.pow(2, a - 128 - 8);
        out[i * 3]     = bytes[i * 4] * s;
        out[i * 3 + 1] = bytes[i * 4 + 1] * s;
        out[i * 3 + 2] = bytes[i * 4 + 2] * s;
    }
    return out;
}

// ── Minimal PNG writer ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

async function deflate(bytes) {
    // PNG's IDAT is a zlib stream, which is what CompressionStream("deflate") produces
    // ("deflate-raw" is the one without the zlib wrapper - the names are the wrong way round
    // from what you would guess).
    const cs = new CompressionStream("deflate");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Write RGBA8 pixels as a PNG. Returns a Blob. */
export async function encodePNG(rgba, w, h) {
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // colour type: RGBA
    // 10, 11, 12 stay 0: deflate, adaptive filtering, no interlace.

    // Filter byte 0 (None) per scanline. The PSF is smooth, so Paeth would compress better,
    // but "None" keeps this readable and deflate still gets the file to a few hundred KB.
    const raw = new Uint8Array(h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
        raw[y * (1 + w * 4)] = 0;
        raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
    }

    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", await deflate(raw)),
        chunk("IEND", new Uint8Array(0)),
    ];
    return new Blob(parts, { type: "image/png" });
}

function blobToDataURL(blob) {
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
    });
}

/** Build the .psf.json object for a computed PSF.
 *
 *  `anglePerPixelRad` is the field that makes the file mean something physically: it says how
 *  wide one PSF pixel is on the sky, so a consumer can draw the pattern at its true angular
 *  size for any focal length instead of guessing a pixel count. */
export async function buildPSFFile(result, spec, meta = {}) {
    const n = result.n;
    const floorFraction = meta.floorFraction ?? 1e-7;
    const rgba = rgbeEncode(result.rgb, n, n, result.peak * floorFraction);
    const png = await encodePNG(rgba, n, n);
    return {
        format: PSF_FORMAT,
        version: PSF_VERSION,
        name: meta.name || "Untitled PSF",
        note: meta.note || "",
        created: new Date().toISOString(),
        size: n,
        encoding: "rgbe",
        // The kernel sums to 1 in the mean channel, so it neither creates nor destroys light.
        fluxNormalised: true,
        peak: result.peak,
        floorFraction,                            // what was discarded, so it is not a mystery
        anglePerPixelRad: result.sampling.anglePerPixelRad,
        anglePerPixelArcsec: result.sampling.anglePerPixelArcsec,
        fieldHalfWidthRad: result.sampling.fieldHalfWidthRad,
        optics: { ...spec.optics, fNumber: result.sampling.fNumber },
        spectrumNm: [spec.spectrum.nm0, spec.spectrum.nm1],
        spec,                                     // so the tool can reopen and keep editing
        image: await blobToDataURL(png),
    };
}

/** Validate a parsed .psf.json enough to give a useful error instead of a broken texture. */
export function validatePSFFile(o) {
    if (!o || typeof o !== "object") return "not an object";
    if (o.format !== PSF_FORMAT) return `not a ${PSF_FORMAT} file (format="${o.format}")`;
    if (o.version > PSF_VERSION) return `version ${o.version} is newer than this build understands (${PSF_VERSION})`;
    if (o.encoding !== "rgbe") return `unknown encoding "${o.encoding}"`;
    if (!Number.isFinite(o.size) || o.size < 8) return `bad size ${o.size}`;
    if (typeof o.image !== "string" || !o.image.startsWith("data:image/")) return "missing image";
    return null;
}
