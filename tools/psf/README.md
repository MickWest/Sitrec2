# Diffraction PSF Studio

A standalone page that builds an aperture mask, computes its polychromatic diffraction point
spread function by FFT, previews the glare that PSF produces, and exports it for import into a
Sitrec camera.

It is a JavaScript reimplementation of the Maskulator + FFTW workflow used in the Metabunk
analysis of the "Chandelier" image, with the sensitivity checks that analysis ran folded in as
live controls rather than as a series of separate runs.

Open it at `tools/psf/`. Nothing is installed, nothing is uploaded, and it works offline.

The user-facing guide is `docs/DiffractionGlare.md`. This file is about the code.

---

## The physics, stated once

In the Fraunhofer (far-field) regime the image-plane amplitude of a point source is the Fourier
transform of the complex pupil. So

```
PSF = |FFT(mask · e^{iφ})|²        φ = 2π · W20 · ρ² / λ
```

where `mask` is the aperture transmission, `ρ` is the normalised pupil radius, and `W20` is the
wavefront error at the rim from a longitudinal focus shift `δz` in a beam of focal ratio `F`:
`W20 = δz / (8F²)`.

Everything the tool shows follows from that one line.

### Why the FFT normally runs once, not once per wavelength

In dimensionless pupil coordinates the transform does not depend on wavelength at all.
Wavelength only sets the *scale* at which the result lands on the detector, with the pattern
radius proportional to λ. An in-focus polychromatic PSF is therefore **one** transform resampled
at 32 different scales — about 30× cheaper than 32 transforms, and exact.

Defocus breaks this, because the phase term carries a `1/λ`, so the pupil itself becomes
wavelength dependent. That path really does transform once per sample, and reports its progress
accordingly.

The output grid is pitched for the **longest** wavelength in the band, since that makes the
widest pattern. Every shorter wavelength is read from further out in the transform — which is
exactly the statement that blue diffracts less — and rescaled by `(λ_ref/λ)²` so each wavelength
carries the same total flux.

---

## Modules

All pure ES modules with no dependencies, because `tools/` is served raw and no bundler ever
sees it. Every import has to resolve over plain HTTP.

| File | What it is |
|---|---|
| `fft.js` | Radix-2 complex FFT, 1D and square 2D, plus `fftshift` |
| `cie.js` | Wavelength → linear sRGB (CIE 1931, Wyman/Sloan/Shirley fit), source spectra |
| `aperture.js` | Parametric pupil rasteriser: shape, obstruction, vanes, apodisation |
| `psf.js` | The polychromatic PSF, and `describeSampling` |
| `presets.js` | The built-in starting points, and localStorage user presets |
| `display.js` | Tone-mapping curves (gamma, log, asinh) |
| `glare.js` | Exact FFT convolution of a scene with the PSF, for the preview |
| `psfFile.js` | The `.psf.json` format: RGBE encoding and a minimal PNG writer |
| `psfWorker.js` | Runs `computePSF` off the UI thread |
| `app.js` | Schema-driven controls, three canvases, export |

`src/CameraPSF.js` in the main app imports `psfFile.js` directly — including the GLSL decode
snippet — so the encoder and the decoder cannot drift apart. Webpack resolves that cross-import
at build time; the same file is also served raw for this page.

---

## Conventions that will bite you if you assume otherwise

**Lengths in a stop spec are fractions of the pupil RADIUS**, so the pupil edge is at 1.0. The
two exceptions are named as such: `obstruction` and vane `width` are fractions of the
**diameter**, because that is how instrument specifications quote them. `obstruction` converts
one-for-one into radius units (the ratio is the same either way); vane `width` becomes the
half-width. An earlier version doubled the obstruction and made every one twice the size it
claimed.

**The pupil is centred on pixel `n/2`, not `(n-1)/2`.** That is where `fftshift` puts DC.
Centring it half a pixel off is a linear phase ramp, and the PSF comes out shifted half a pixel
diagonally — visible as an Airy core that peaks at pixel 1 rather than 0.

**Brightness sliders are in decades.** The spikes sit around a millionth of the peak, so a
linear slider that reached the useful range would spend 99% of its travel below 100.

**`stretchParam` maps the Curve slider differently per curve** — the exponent itself for gamma,
a power of ten for log and asinh. Seeding the slider with a curve-space value gives `10^10000`
and a uniformly black canvas.

---

## The `.psf.json` format

```jsonc
{
  "format": "sitrec-psf", "version": 1,
  "name": "...", "note": "...",
  "size": 512,
  "encoding": "rgbe",
  "fluxNormalised": true,     // the kernel sums to 1 in the mean channel
  "peak": 0.44,               // peak of the mean channel
  "floorFraction": 1e-7,      // what was discarded below this fraction of the peak
  "anglePerPixelRad": 1.2e-6, // what makes it physical: how wide one pixel is on the sky
  "optics": { "apertureM": 0.4, "focalM": 3.0, "fNumber": 7.5 },
  "spec": { /* the full generator spec, so the tool can reopen and keep editing */ },
  "image": "data:image/png;base64,..."
}
```

**RGBE, and why the PNG is hand-built.** A PSF spans ~13 decades, so 8 bits per channel is
hopeless and float is 3 MB before base64. RGBE gives three 8-bit mantissas plus a shared 8-bit
exponent — about 1% relative accuracy over the whole range, in four bytes.

The PNG is written byte by byte rather than through `canvas.toDataURL` because a canvas may
store its pixels premultiplied by alpha. RGBE puts the *exponent* in alpha, where a typical
value is around 110/255, so a canvas round trip would multiply every mantissa by 0.43, round it
to 8 bits, and divide it back out. `CompressionStream("deflate")` supplies the zlib stream PNG
wants. (Note the naming: `"deflate"` is the zlib-wrapped format, `"deflate-raw"` is the one
without.)

**The range floor** is most of the file size. The deep tail is incompressible low-order mantissa
noise spread over most of the image, far below anything a display or sensor can show. Measured
on the 512² Chandelier preset:

| Floor (of peak) | PNG | Flux lost |
|---|---|---|
| none | 635 kB | 0 |
| 1e-9 | 416 kB | 0.0005% |
| 1e-8 | 257 kB | 0.014% |
| **1e-7** (default) | **80 kB** | **0.11%** |
| 1e-6 | 23 kB | 0.41% |

The faintest structure anyone looks at — the background between the spikes — sits at 1e-6, so
1e-7 keeps everything visible.

**Decoding.** `rgbeDecode()` works on raw bytes. The GLSL twin must multiply by 255 first,
because a texture read hands back 0..1. Leaving that out decodes every pixel 255× too dark,
which presents as "the glare does not work" rather than as a scale error.

---

## Testing

`tests/DiffractionPSF.test.js` covers the whole pure engine — 24 tests, ~2 s.

The assertions are physical rather than golden-value, because a snapshot would pass just as
happily with the transform subtly wrong: an Airy pattern has its first zero at `1.22λ/D`, N
vanes throw a known *number* of spikes in known *directions*, a convolution kernel conserves
flux, and blue's Airy zero lands inside red's at the predicted ratio.

One trap worth knowing if you extend them: sample the PSF **bilinearly**, and average over a
radial band. Rounding a polar offset to whole pixels quantises the sampling radius by up to half
a pixel, and on the steep flank of an Airy ring that is enough to invent local maxima in a
perfectly circular pattern — a spike detector built on nearest sampling reports spikes in an
unobstructed circle.

Two probes render things you can actually look at, without a browser:

```bash
node private/probes/renderPSFPresets.mjs <outDir>              # every preset: pupil | PSF PNG,
                                                               # plus a spike-direction table
node private/probes/exportPSFFile.mjs <preset> <out> [n] [floor]  # a .psf.json from the CLI
```

---

## Debugging via MCP

Same two hooks as `tools/shf`, gated to local hosts so no eval gadget ships to production:

```js
sitrec_eval({ expression: "psfTool.result.peak" })
sitrec_eval({ expression: "psfTool.psfAt(28, 28)" })          // peak-normalised, at an offset
sitrec_eval({ expression: "psfTool.set('stops.0.vanes.count', 3)" })
sitrec_eval({ expression: "psfEval('computePSF({...spec, n:128})').peak" })   // module scope
```

`psfTool.radialProfile(angleDeg, rMax)` returns a profile along one direction, which is usually
what you want rather than pulling a 3 MB array through the bridge.

Reload the tab after any rebuild: the module graph is cache-busted by an import map stamped at
build time (`webpackCopyPatterns.js`), and the worker carries the same stamp separately because
a module worker does not inherit the document's import map.
