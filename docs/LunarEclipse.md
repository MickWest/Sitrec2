# Lunar Eclipses

**Lighting menu → Lunar Eclipse**

When the Moon passes into the Earth's shadow, Sitrec shades it: the long soft gradient of
the penumbra, the feathered edge of the umbra, and the deep red of totality. It happens by
itself — set the time to a lunar eclipse and the Moon is eclipsed. There is nothing to
switch on.

There is also an option to ring **the whole of the Earth's shadow** out at the Moon's
distance, so you can see how big it is and watch the Moon cross it.

---

## Reaching an eclipse

Set the date and time as usual (press `G` for the Go To box, or use the Time menu). The
*Eclipse* readout at the bottom of the Lunar Eclipse folder tells you what the current
moment is: `none`, or the kind of eclipse with its umbral magnitude.

Some recent and forthcoming ones, in UTC:

| Date and time of greatest eclipse | Kind |
|---|---|
| 2025-03-14 06:59 | Total |
| 2025-09-07 18:12 | Total |
| 2026-03-03 11:34 | Total |
| 2026-08-28 04:13 | Partial (96.6% covered — nearly total) |
| 2028-12-31 16:52 | Total |
| 2029-06-26 03:22 | Total (51 minutes of totality) |

The Moon has to be above your horizon to see it. A lunar eclipse can only happen at full
Moon, so the Moon is opposite the Sun: if it is night where you are standing, the eclipse
is visible.

---

## What you are looking at

**The penumbra** is the region that can see *part* of the Sun past the Earth. It is huge
and its shading is very gradual — the gradient runs about two lunar radii — so a purely
penumbral eclipse is subtle, and even during a total eclipse most people never notice the
penumbral phase beginning.

**The umbra** is the region that can see *none* of the Sun. Its edge is not sharp: because
the Sun is a disc and not a point, and because the Earth has an atmosphere, the light dies
away over a few hundred kilometres. Sitrec renders that softness from the geometry rather
than blurring it.

**The colour** is the interesting part. No direct sunlight reaches the umbra at all, so
every photon landing there was bent into the shadow by the Earth's atmosphere — refracted
around the limb, through a slant path so long that it strips out the blue. What survives is
the copper red of a "blood moon". Look for the **turquoise fringe** just inside the umbral
edge as well: it is ozone, which absorbs from green through to red and so leaves blue behind
on the ray paths that ran high through the stratosphere.

---

## The controls

| Control | What it does |
|---|---|
| **Eclipse Shading** | Master switch. On by default; has no effect at all except during an eclipse. |
| **Blood Moon Color** | The physical colour of the refracted light. Off renders the same brightness in grey. |
| **Atmospheric Clarity** | How clear the Earth's atmosphere is around the limb — see below. |
| **Auto Exposure** | Brighten the shadowed part enough to see it. On by default. |
| **Exposure (stops)** | Manual exposure. 0 is physically correct. Touching it turns Auto off. |
| **Shadow Outlines** | Ring the umbra (gold) and penumbra (orange) at the Moon's distance. Off by default. |
| **Eclipse** | Read-only: the kind of eclipse, the umbral magnitude, the Moon's visual magnitude, and the Danjon number. |

### Atmospheric Clarity, and why eclipses differ

Two total eclipses with almost identical geometry can look completely different, and the
reason is the state of the Earth's atmosphere. Volcanic aerosol high in the stratosphere,
and cloud along the limb, both cut the light that would otherwise reach the umbra. After
the 1991 Pinatubo eruption the December 1992 eclipse was so dark the Moon nearly vanished.

*Atmospheric Clarity* is that one variable. Sliding it from 0 to 1 walks the whole
**Danjon scale**, the traditional 0-to-4 rating of how a total eclipse looked:

| Danjon | Appearance |
|---|---|
| L0 | Very dark; the Moon almost invisible at mid-totality |
| L1 | Dark grey or brownish; surface detail hard to make out |
| L2 | Deep red or rust-coloured, with a darker centre |
| L3 | Brick red, with a bright grey or yellow rim to the umbra |
| L4 | Bright copper-red or orange, with a very bright bluish rim |

0.5 is typical. The *Eclipse* readout reports the Danjon number the model predicts, which
is a prediction from an assumed atmosphere, not an observation.

### Exposure

A totally eclipsed Moon is around ten magnitudes — a factor of ten thousand — fainter than a
full Moon. At true brightness it renders black, which is correct and useless.

**Auto Exposure** picks one exposure from the deepest phase of the eclipse you are looking
at, and then holds it for the whole event. That is exactly how a photographer shooting a
sequence through totality works, and it matters: the Moon still visibly *darkens* as it
enters the shadow, instead of the picture quietly levelling itself out. The sunlit part
costs nothing — illumination rolls off smoothly near the top rather than clipping flat, so
the uneclipsed Moon looks the same as it always did.

Turn Auto Exposure off, or set **Exposure (stops)** to 0, for true relative brightness.

---

## Shadow Outlines

**Shadow Outlines** rings the Earth's umbra in gold and its penumbra in orange, out at the
Moon's distance — the same colour convention **Show Moon's Shadow** uses for the Moon's own
shadow cone, so the two read as a set.

The rings come from the same geometry that shades the Moon, so the gold one passes precisely
along the shadow's edge on the Moon's face. Turn them on during a partial eclipse and that
match is the easiest way to see that the curve of the shadow on the Moon really is an arc of
a circle 4,600 km in radius — nearly three times the Moon's own.

They are off by default: they are a diagram over an otherwise photographic sky, and the
eclipse itself is usually what you came to look at.

This is not the same thing as **Show Moon's Shadow** (in the Show/Hide menu), which draws
the *Moon's* shadow falling on the *Earth* — the footprint of a solar eclipse.

---

## Accuracy

**Geometry.** The shadow model is astronomy-engine's own, reproduced exactly: the same
umbral and penumbral cone radii, the same geocentric Moon and aberration-corrected Sun. Our
contact times therefore match that library's published semi-durations to about a second,
which is as closely as they can be checked — its own search runs to a one-second tolerance.
The kind of eclipse and the peak obscuration match to six decimal places.

**Shadow enlargement.** The Earth's atmosphere makes the planet's shadow slightly bigger than
the solid globe would, and how much bigger is the one genuinely disputed number in
lunar-eclipse prediction. There are three traditional answers: Chauvenet's 1/50 of the
Earth's radius (127 km), Danjon's 1/85 (75 km), and the **88 km** used by
[astronomy-engine](https://github.com/cosinekitty/astronomy), which supplies Sitrec's
ephemeris. Sitrec uses 88 km, which is what makes those contact times line up. It is also
the altitude above which the atmosphere no longer measurably bends or absorbs anything — the
bend there displaces a ray by 130 m at the Moon's distance — so the same number cleanly
divides the refracted light below it from the plain geometric shadow above.

**The soft edges are geometry, not a blur.** For each point on the Moon, Sitrec works out
how much of the Sun's disc the Earth is hiding, and how much light that leaves after limb
darkening. The place where that first reaches zero is, algebraically, the umbral cone
radius — so the penumbral gradient and the feathered umbral edge come out of the same
calculation as the contact times, with no smoothing parameter anywhere.

**The colour** is computed rather than tinted. For rays grazing the Earth at every altitude
from the ground to 88 km, Sitrec integrates the slant path through a US Standard Atmosphere:
Rayleigh scattering, ozone in the Chappuis band, and stratospheric and tropospheric aerosol.
It works out how much each ray is bent, follows it to where it lands in the shadow, and adds
up the light — then blurs the result by the Sun's own angular size, and integrates 36
wavelengths through the CIE colour matching functions. The red of the umbra, the way the
centre is darker than the rim, and the turquoise ozone fringe are all consequences of that,
not settings.

**What is not modelled.** Light *scattered* into the umbra, as opposed to refracted, is
ignored; the real umbra is a little less saturated than Sitrec's for that reason. Cloud along
the limb is a statistical average, not that day's weather — which is a real limitation,
since cloud is one of the largest terms. And the Earth's shadow is treated as circular; its
slight oblateness moves the umbral edge by a few kilometres out of 4,600.

---

## See also

- **Historic Skies** — how far back the ephemeris is good for, and to what accuracy.
- **Atmospheric Refraction** — the same physics applied to your own sightlines.
