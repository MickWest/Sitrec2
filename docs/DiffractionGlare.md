# Diffraction Glare

A bright point of light in a photograph rarely looks like a point. It grows spikes. Those
spikes are not in the sky — they are made by the camera, by the edges inside its aperture, and
their shape is a fingerprint of that particular optic.

Sitrec can reproduce this. You build a model of a camera's aperture in the **Diffraction PSF
Studio**, export it, and import it into a Sitrec camera. Every bright source the camera then
sees is drawn with that camera's own diffraction pattern.

This matters for analysis. If an unidentified object in footage has a distinctive spiked or
starburst shape, one of the first questions is whether that shape belongs to the object or to
the camera. Building the camera's pattern and comparing it with the footage answers that
question with something better than an impression.

---

## The short version

1. Open the **Diffraction PSF Studio** at `tools/psf/` (linked from the Tools index).
2. Pick a preset, or build the aperture: outer shape, central obstruction, spider vanes.
3. Press **Download .psf.json**.
4. In Sitrec: **Camera ▸ Camera Tweaks ▸ Diffraction Glare ▸ Import PSF…**
5. Turn on **Diffraction Glare** in **Effects On/Off**, and raise **Glare Gain**.

---

## Where the spikes come from

Light passing an edge spreads. The image of a point source is therefore not a point but a
pattern — the **point spread function**, or PSF — and its shape is set entirely by the shape of
the opening the light came through.

Three rules cover almost everything you will see:

**A straight edge throws a spike perpendicular to itself.** A hexagonal iris throws six spikes.
A square stop throws a vertical one and a horizontal one. A perfect circle has no straight edge
anywhere, and throws no spikes at all — only the faint concentric rings of the Airy pattern.

**Each spider vane throws one spike pair.** So N vanes give 2N spikes — *unless* they pair up
into straight lines. Four vanes at 90° are two straight lines, so they give four spikes, not
eight. Three vanes at 120° are not, so they give six. This is why a three-vane telescope
produces the six-pointed stars you see in a lot of astrophotography.

**A wavy or serrated vane edge smears its spike sideways.** A vane with a straight edge throws a
hairline. A vane whose edge waves has no single orientation, so its spike fans out into a broad
feather — an *aigrette*. Some instruments do this deliberately, to spread glare instead of
concentrating it.

And one more, which is why the spikes are coloured: **the pattern scales with wavelength.** Blue
light diffracts less than red, so the blue copy of the pattern sits inside the red one. A spike
is therefore a spectrum smeared along its own length, reddening outwards.

---

## The Diffraction PSF Studio

`tools/psf/` — a standalone page, no install, nothing sent anywhere.

Three panels: the **pupil** you are building, the **PSF** it produces, and a **glare** preview
showing a scene through that optic.

### Presets

Every preset is a complete, editable starting point. Loading one fills the controls; change
anything you like from there, and **Save** it under your own name to keep it.

| Preset | What it shows |
|---|---|
| Unobstructed circle (Airy) | The reference case — no spikes at all |
| Newtonian, 4 straight vanes | Four vanes, four hairline spikes |
| Cassegrain, 3 vanes | Three vanes, six spikes |
| Camera iris, 6 blades | Spikes from the diaphragm blades alone |
| Square iris only | One vertical and one horizontal spike |
| Segmented hexagon + 3 vanes | Hexagonal pupil plus vanes |
| Apodised vanes | Serrated edges, and the feathers they produce |
| Chandelier | A two-stop model of a gimballed camera housing |

### Controls worth understanding

**Pupil fill** is how much of the computation grid the aperture occupies. It sets a trade-off
you cannot avoid: a small fill samples the bright core finely but covers a narrow field, a large
fill covers a wide field with a core only a pixel or two across. The panel warns you when the
core has become too small to be real.

**Obstruction** is the central blockage — the secondary mirror — as a fraction of the aperture
*diameter*. A 30% obstruction blocks 9% of the light, and pushes energy out of the core into the
rings.

**Vane width** changes how *bright* a spike is, not how long. Length is set by the aperture
size, not the vane.

**Wave depth** (apodisation) has a limit worth knowing. It is measured as a fraction of the vane
half-width, and past about 0.4 the edge slope fans the spike so widely that it drops *below* the
light between the spikes and vanishes. If your spikes disappear when you turn up the serration,
that is why.

**Brightness** is in *decades*: 4 means a gain of ten thousand. It has to work this way. The
spikes are around a millionth of the peak, so nothing about them is visible at ordinary
exposures — the published images of patterns like these all have thoroughly blown-out cores.

### Two stops

Real instruments often have more than one aperture in the path — a housing window at the front
and an iris near the sensor. **Combine** decides how they are treated:

- **Sum the two PSFs** — for stops in *different planes*. They do not share a pupil, so their
  patterns add as intensities. This is the honest choice when the stops are separated, and it is
  what produces the eight-spike pattern in the Chandelier preset: four from the vanes, four from
  the iris.
- **Intersect into one pupil** — for stops in the *same* plane, which really are one aperture,
  so their transmissions multiply.

---

## Using a PSF in Sitrec

**Camera ▸ Camera Tweaks ▸ Diffraction Glare.**

The PSF belongs to the camera, not to the view, because it describes that camera's optics. It is
saved with the sitch, so a shared scenario keeps them.

Then enable **DiffractionGlare** under **Effects On/Off**. The controls:

**Glare Gain** is in decades — 3 means a thousand times. It needs to be this large, and the
reason is worth stating plainly: a real bright source outshines its own spikes by orders of
magnitude, but the render has already clipped it to white. This control stands in for the
dynamic range the frame no longer carries. It is the honest knob, not a fudge factor, but it is
also the one thing here that is *not* derived from the optics — so do not read the absolute
brightness of a simulated spike as a prediction.

**Threshold** is the luminance a pixel must exceed before it glares. Raising it also removes the
part of the source the frame already draws correctly.

**Size ×** is 1 for the pattern's true angular size at the current field of view. Zooming in
makes the pattern bigger on screen, exactly as it does for everything else, because the pattern
has a fixed angular size on the sky.

That true size is often *very small*. A 0.4 m aperture produces a pattern about two arcminutes
across — roughly one pixel in a 30° view, and about thirty in a 1° view. This is not a
limitation of the simulation, it is the physics: **real diffraction patterns are only prominent
in narrow fields of view, or in heavily cropped and stretched images.** If you have to raise
Size × far above 1 to see anything, that is telling you something real about the footage you are
trying to match.

**Bright Pass ÷** trades cost against how finely close-together sources are separated.

---

## Physical point sources

**View ▸ Physical Point Sources.** Off by default. Turn it on whenever you are using diffraction
glare.

Sitrec normally draws a star as a **disc whose radius grows with brightness**, with its colour
clamped at white. That is the right compromise when the frame is the finished image — a star is
a point source of essentially zero angular size, and you cannot see a sub-pixel dot, so
brightness has to be expressed as area to be visible at all.

It is the wrong compromise once a PSF is being convolved over the frame, because the convolution
then faithfully reproduces a source hundreds of times larger than the real thing. Measured on a
2° field: stars were rendered 68–203 arcseconds across, against a true angular diameter of
milliarcseconds. Worse, **every source had a peak brightness of exactly 1.0** — all of the
magnitude information was in the area, none in the intensity. Convolving that gives smeared,
multiplied spikes instead of one sharp pattern, and a bright star throws no more glare than a
faint one.

With the mode on, every star is drawn as a fixed 3-pixel point and its magnitude is carried by
**intensity**, on Pogson's true ratio — each magnitude is 2.512× in flux, so a first-magnitude
star really is a thousand times a sixth-magnitude one. The same 2° field then gives 2-pixel
sources with peak values spanning the real range. The apparent size of a star becomes something
the PSF produces, which is what produces it in a real instrument too.

Faint stars correctly stop throwing visible spikes, because they are faint. That is the point:
in real footage only the bright sources have spikes, and which sources do is evidence.

With no PSF active the mode looks *worse* — nothing is left to turn the intensity back into
apparent size, so most of the sky becomes very small dots. That is why it is off by default.

### Planets

Planets get the same treatment from the same switch, but they are handled differently, because
a planet is genuinely *resolved* — it really does have an angular size worth drawing.

Normally a planet is sized by magnitude too, and it is even further out than a star: Jupiter
rendered **1006 arcseconds** across against a true diameter of about 38, so 26× too wide and
roughly 700× too much area. Convolved with a PSF that produced a striped smear, not a pattern.

With the mode on, a planet is drawn at its true angular diameter and given a **surface
brightness** — total flux divided by solid angle. That is the physically invariant quantity: a
resolved object's surface brightness does not change when you zoom, while the total light it
delivers grows with the pixel area it covers, which is exactly how real imaging behaves.
Measured, Jupiter then renders 34 arcseconds across with a peak far above white, and convolves
into a clean pattern with a slightly extended core — which is what a resolved planet should do.

At a wide field a true-size planet goes sub-pixel, and a sub-pixel sprite can fall between
samples and vanish, so the drawn size is floored at 12 arcseconds with the light given back as
surface brightness. Total flux is unaffected either side of the floor. This mode is meant for
narrow fields; the floor only stops planets disappearing outside them.

---

## What it does and does not model

It models Fraunhofer diffraction from an aperture, polychromatically, with defocus. That covers
the spikes, the rings, the feathers and their colour.

It does **not** model lens flare (internal reflections between elements), scattering from dust
or scratches, sensor blooming or column bleed, or any smearing from the readout. Those produce
their own artefacts, and several of them also look like streaks. A pattern that fails to match
here has not been shown to be an object; it may just have a different instrumental cause.

Two more honest limits. The glare is *added* to a frame that already contains the source, rather
than replacing it — the standard compromise, and what Threshold is for. And the gain, as above,
is not derived from anything: the shape is physics, the absolute brightness is a setting.

---

## Reading a real image

The workflow that this feature was built to support:

1. Find what you can about the instrument — aperture, obstruction, vane count and angle, whether
   the vanes are straight or serrated. Photographs of the hardware are often enough for
   proportions.
2. Build the pupil from those proportions and generate the PSF.
3. Compare *feature by feature* against the image: the number of spikes, their angles, the
   relative brightness of the diagonal against the vertical, the presence and shape of feathers,
   the shape of the central region.
4. Where they disagree, ask what would have to change to fix it — a second stop, a different
   vane profile — and whether that change is plausible for the instrument.

Match the *structure*, not the brightness. The angles and the count of spikes are strong
evidence, because they follow from geometry alone. Brightness depends on exposure, compression
and the display curve, and proves much less.
