# Diffraction PSF Studio

This tool shows how the shape of a camera's aperture spreads a bright point of light into glare
and spikes. That pattern is the point spread function (PSF). This standalone page builds an
aperture mask, computes its polychromatic diffraction PSF with a fast Fourier transform (FFT),
previews the glare that PSF produces, and exports it for import into a Sitrec camera.

![The three panels of the Studio. Pupil shows a white aperture on a gray square, crossed by a gray central disc and four gray diagonal vanes. Point spread function shows a bright core on black, with four thin spikes along the vertical and horizontal and four broad, faint, feathered spikes on the diagonals. Glare shows three bright points with the same spikes on a dark gray background. Point spread function and Glare each have their controls under them. Pupil has two lines of text under it and no controls.](psf-studio-views.jpg)

The three panels at startup, with the Chandelier preset. **Pupil** shows the aperture mask. This
preset has two stops, which are two openings along the light path: white is open in both stops,
and gray is open in one. **Point spread function** shows the PSF, and the lines under it give its
sampling. **Glare** shows three point sources convolved with that PSF. The controls under a panel
change that panel only, so the two **Curve** sliders are separate.
[Conventions](#conventions-that-will-bite-you-if-you-assume-otherwise) explains **Brightness**,
**Exposure**, **Glare gain** and **Curve**.

It is a JavaScript reimplementation of the workflow, with Maskulator and the FFTW Fourier
transform library, used in the Metabunk analysis
[PR038: The "Chandelier" UFO](https://www.metabunk.org/threads/pr038-the-chandelier-ufo.13307/).
The sensitivity checks that analysis ran are folded in as live controls rather than as a series
of separate runs.

Open it from **Sitrec → Extra Tools → Diffraction PSF Studio**, or at
<https://www.metabunk.org/sitrec/tools/psf/index.html>. Nothing is installed and nothing is
uploaded: all the computation runs in your browser. You can also open `index.html` from a web
server. It does not work from disk: Chrome blocks the module imports of a `file://` page.

The user-facing guide is
[Diffraction Glare](https://github.com/MickWest/Sitrec2/blob/main/docs/DiffractionGlare.md).
This file is about the code.

---

## The physics, stated once

In the Fraunhofer (far-field) regime the image-plane amplitude of a point source is the Fourier
transform of the complex pupil. So

```
PSF = |FFT(mask · e^{iφ})|²        φ = 2π · W20 · ρ² / λ
```

where `mask` is the aperture transmission, `ρ` is the normalized pupil radius, and `W20` is the
wavefront error at the rim from a longitudinal focus shift `δz` in a beam of focal ratio `F`:
`W20 = δz / (8F²)`.

Everything the tool shows follows from that one line.

### Why the FFT normally runs once, not once per wavelength

In dimensionless pupil coordinates the transform does not depend on wavelength at all.
Wavelength only sets the *scale* at which the result lands on the detector, with the pattern
radius proportional to λ. An in-focus polychromatic PSF is therefore **one** transform per stop,
resampled at 32 different scales. Both paths do all the resampling, so on the 512² Chandelier
preset the in-focus path runs about 7× faster than the defocused path, not 32×.

Defocus breaks this, because the phase term carries a `1/λ`, so the pupil itself becomes
wavelength dependent. That path really does transform once per sample, for each stop, and
reports its progress accordingly.

The output grid is pitched for the **longest** wavelength in the band, since that makes the
widest pattern. Every shorter wavelength is read from further out in the transform — which is
exactly the statement that blue diffracts less — and rescaled by `(λ_ref/λ)²` to correct for the
change in area.

The scale law is exact, but the read is bilinear, so the resampled result is an approximation.
The error grows with `fill`, the pupil diameter as a fraction of the FFT grid width. On the Airy
preset (`fill` 0.22) each wavelength stays within 3% of its true flux. On the Chandelier preset
(`fill` 0.62) the read overcounts the narrow core at short wavelengths: at 357 nm its two stops
read 1.54 and 2.22 times their true flux.

### Visible color and single-channel bands

`spectrum.detector` selects `"visible"` (the default when omitted) or `"band"`. Visible mode
applies color matching and white balance. Band mode bypasses both:
each wavelength contributes one scalar weight, repeated equally in the three stored channels.
The finite kernel is normalized so each band channel sums to 1.

The source `kind` is `"flat"` for constant spectral energy density per wavelength, or
`"blackbody"` at `kelvin`. In band mode, `quantity: "photon"` (the default) multiplies that
energy spectrum by wavelength, proportional to photon radiance `B_E λ/(hc)`. This represents a
detector with constant quantum efficiency, such as an idealized indium antimonide (InSb)
detector. `"energy"` uses the energy spectrum directly. Common factors cancel during normalization. A 300 K source
weights the long end of 3–5 µm more strongly than an 800 K source; photon weighting adds a
further preference for long wavelengths. No measured spectral response curve is included.

`nm0` and `nm1` are nanometers in every spec and file. The page displays and edits them in
µm for band mode, from 0.3 to 14 µm; visible mode edits them in nm, From 300–1000 and To
320–1400. When the detector changes, a wavelength range inside the new detector's limits stays
as it is; any other range is reset to that detector's default (visible 350–780 nm, band detector
3–5 µm). Samples are uniform bin centers, with one sample at the band center. Equal endpoints
specify a monochromatic calculation. A spectrum with all its weights at zero (for example 3–5 µm
with the visible color detector) cannot define a normalized PSF: `computePSF` throws, and the
page reports it and keeps **Download .psf.json** off. With no open stop the PSF is empty, and
**Download .psf.json** stays off too.

At fixed aperture diameter `D`, the Airy first-zero angle is `1.22 λ/D`. A 4 µm monochromatic
pattern therefore has about 7.27 times the angular radius of a 550 nm pattern. The FFT grid
pitch remains `nm1 * 1e-9 * fill / D`; changing only the Chandelier band from 350–780 nm to
3–5 µm increases that pitch by `5000/780 ≈ 6.41`. The integrated pattern also depends on the
relative bandwidth and spectral weights. `describeSampling` uses the band midpoint in
`2 λ (f/D)²` for depth of focus, while visible mode retains its 550 nm reference.

The unobstructed infrared preset (`mwirAiry`) uses an estimated 0.135 m pupil, a 0.675 m focal
length and a 3–5 µm band. The catadioptric variant adds an obstruction and vanes. `chandelierIR` has the two-stop geometry and optics of the visible
`chandelier` preset, with band detection over 3–5 µm.

A band PSF has the same value in its three channels, so its red channel is a single-channel
kernel, centered at `(n/2, n/2)` and summing to 1. `sampling.anglePerPixelRad` is radians per
kernel sample, not the detector's pixel pitch. One integrated kernel assumes the same source
spectrum across the image; sources with different spectra need separate kernels.

---

## Modules

All pure ES modules with no dependencies, because `tools/` is served raw and no bundler ever
sees it. Every import has to resolve over plain HTTP.

| File | What it is |
|---|---|
| `fft.js` | Radix-2 complex FFT, 1D and square 2D, plus `fftshift` |
| `cie.js` | Wavelength → linear sRGB (CIE 1931, Wyman/Sloan/Shirley fit), source spectra |
| `aperture.js` | Parametric pupil rasteriser: shape, obstruction, vanes, apodisation |
| `psf.js` | The polychromatic PSF and `describeSampling` |
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
exceptions are named as such: `obstruction` and vane `width` are fractions of the
**diameter**, because that is how instrument specifications quote them, and `apodAmplitude` is a
fraction of the local vane half-width. `obstruction` converts one-for-one into radius units (the
ratio is the same either way); vane `width` becomes the half-width. An earlier version doubled
the obstruction and made every one twice the size it claimed.

**The pupil is centered on pixel `n/2`, not `(n-1)/2`.** The rasteriser (`aperture.js`) and the
defocus phase (`psf.js`) both use that center, and they must agree. In focus, a shift of the
pupil only puts a phase ramp on the transform, and `|FFT|²` removes phase, so the core stays at
DC, which `fftshift` puts at pixel `n/2`. With defocus, a half-pixel mismatch between mask and
phase adds a tilt, and the pattern moves off center.

**Brightness and Exposure are in decades; Glare gain is linear.** The spikes sit around a
millionth of the peak, so seeing them takes gains in the thousands. A linear slider that reached
10,000 would give gains below 100 only 1% of its travel.

**`stretchParam` maps the Curve slider differently per curve** — the exponent itself for gamma,
a power of ten for log and asinh. Seeding the slider with a curve-space value gives `10^10000`
and a uniformly black canvas.

---

## The `.psf.json` format

```jsonc
{
  "format": "sitrec-psf", "version": 1,
  "name": "...", "note": "...", "created": "<ISO time>",
  "size": 512,
  "encoding": "rgbe",
  "fluxNormalised": true,     // the kernel sums to 1 in the mean channel
  "peak": 0.50,               // peak of the mean channel
  "floorFraction": 1e-7,      // what was discarded below this fraction of the peak
  "anglePerPixelRad": 1.2e-6, // what makes it physical: how wide one pixel is on the sky
  "anglePerPixelArcsec": 0.249, "fieldHalfWidthRad": 3.1e-4,
  "optics": { "apertureM": 0.4, "focalM": 3.0, "fNumber": 7.5 },
  "spectrumNm": [350, 780],
  "spec": { /* the full generator spec, so the tool can reopen and keep editing */ },
  "image": "data:image/png;base64,..."
}
```

**RGBE, and why the PNG is hand-built.** A PSF spans ~18 decades, so 8 bits per channel is
hopeless and float is 3 MB before base64. RGBE gives three 8-bit mantissas plus a shared 8-bit
exponent — about 1% relative accuracy over the whole range, in four bytes.

The PNG is written byte by byte rather than through `canvas.toDataURL` because a canvas may
store its pixels premultiplied by alpha. RGBE puts the *exponent* in alpha, where a typical
value is around 110/255, so a canvas round trip would multiply every mantissa by 0.43, round it
to 8 bits, and divide it back out. `CompressionStream("deflate")` supplies the zlib stream PNG
wants. (Note the naming: `"deflate"` is the zlib-wrapped format, `"deflate-raw"` is the one
without.)

**The range floor** is most of the file size. The deep tail is incompressible low-order mantissa
noise spread over most of the image, mostly below 1e-7 of the peak. Measured on the 512²
Chandelier preset, for each floor the page offers:

| Floor (of peak) | PNG | Flux lost |
|---|---|---|
| none | 641 kB | 0 |
| 1e-8 | 200 kB | 0.016% |
| **1e-7** (default) | **62 kB** | **0.10%** |
| 1e-6 | 18 kB | 0.35% |

On this preset the background between the spikes falls from about 2e-6 of the peak at 30 px from
the core to 4e-8 at 100 px. The 1e-7 floor keeps 8% of the pixels: that background to about 80
px, the diagonal spikes to about 90 px, and the vertical and horizontal spikes to about 200 px.

**Decoding.** `rgbeDecode()` works on raw bytes. The GLSL twin must multiply by 255 first,
because a texture read hands back 0..1. Leaving that out decodes every pixel 255× too dark,
which presents as "the glare does not work" rather than as a scale error.

Band files keep **version 1** and the RGBE encoding. Their generator `spec.spectrum` carries
`detector` and `quantity`; equal RGB channels preserve the scalar response through the existing
camera decode. Old specs without these fields remain visible. `validatePSFFile` accepts both
without a format migration or a change to the camera loader.

---

## Testing

Run the focused checks with `npx jest tests/DiffractionPSF.test.js`.

Apart from one guard test, the assertions are physical rather than golden-value, because a
snapshot would pass just as happily with the transform subtly wrong: an Airy pattern has its
first zero at `1.22λ/D`, N vanes throw a known *number* of spikes in known *directions*, a
convolution kernel conserves flux, and blue's Airy zero lands inside red's at the predicted
ratio.

Band checks cover unit flux, equal channels, infrared Airy angles and wavelength scaling,
blackbody and photon/energy weighting, focus scale, and export through the camera loader
with image and renderer doubles. The guard test catches unintended engine changes. For every
visible preset, the default spec and a defocused blackbody intersection, it compares the peak,
the three channel sums, the RMS radius and the mean channel at six offsets with stored values,
to a relative tolerance of 1e-9.

One trap worth knowing if you extend them: sample the PSF **bilinearly**, and average over a
radial band. Rounding a polar offset to whole pixels quantises the sampling radius by up to half
a pixel, and on the steep flank of an Airy ring that is enough to invent local maxima in a
perfectly circular pattern — a spike detector built on nearest sampling reports spikes in an
unobstructed circle.

---

## Debugging via MCP

Same two hooks as `tools/shf`, gated to local hosts so no eval gadget ships to production:

```js
sitrec_eval({ expression: "psfTool.result.peak" })
sitrec_eval({ expression: "psfTool.psfAt(28, 28)" })          // peak-normalized, at an offset
sitrec_eval({ expression: "psfTool.set('stops.0.vanes.count', 3)" })
sitrec_eval({ expression: "psfEval('computePSF({...spec, n:128})').peak" })   // module scope
```

`psfTool.radialProfile(angleDeg, rMax)` returns a profile along one direction, so you do not pull
a 3 MB array through the bridge. It rounds each point to a whole pixel, so use it to look at a
profile, not to detect rings or spikes: see the sampling trap under Testing.

Reload the tab after any rebuild: the module graph is cache-busted by an import map stamped at
build time (`webpackCopyPatterns.js`), and the worker carries the same stamp on `psfWorker.js`
and on its import of `psf.js`, because a module worker does not inherit the document's import
map.
