# Lunar Eclipses

**Show → Celestial → Eclipses → Lunar Eclipse**

When the Moon passes into the Earth's shadow, Sitrec shades it: the long soft gradient of
the penumbra (the outer, partial shadow), the feathered edge of the umbra (the inner, full
shadow), and the deep red of totality. It happens by itself — set the time to a lunar
eclipse and the Moon is eclipsed. There is nothing to switch on.

There is also an option to ring **the whole of the Earth's shadow** out at the Moon's
distance during an eclipse, so you can see how big it is and watch the Moon cross it.

![The look view with a red, orange and yellow Moon in a black sky, darker at the upper right and brighter at the lower left. The Lunar Eclipse folder floats at the lower left with Auto Exposure ticked and Atmospheric Clarity at 0.5, and its Eclipse row reads Total, umbral mag 1.16. The clock at the lower right reads 2026-03-03 11:33:40.000 UTC](docimages/lunar-eclipse-total.jpg)

*The total eclipse of 2026-03-03 at greatest eclipse, with the default Lunar Eclipse settings. The clock at the lower right reads 11:33:40 UTC. The Moon is dark red on the side toward the centre of the umbra, and shades through orange to a brighter yellow toward the rim of the umbra. The Lunar Eclipse folder is shown detached; it now opens from Show → Celestial → Eclipses. Its Eclipse row is cut off after `mV`: the full text at this moment is `Total, umbral mag 1.16, mV -2.3, Danjon L3.6`.*

---

## Reaching an eclipse

Press `G` for the Go To box and type the time with `UTC` after it, for example
`2026-08-28 04:13 UTC`. Without `UTC`, the box reads the time in the time zone that the Time
menu shows. To enter UTC times in the Time menu, turn off **Use Time Zone in UI** first.

The *Eclipse* readout at the bottom of the Lunar Eclipse folder gives the phase at the
current moment: `none`, `Penumbral`, `Partial` or `Total`, with a magnitude. Umbral magnitude
is how far the Moon's diameter has entered the umbra, as a fraction of that diameter. It is
not a brightness, and 1 or more means the Moon is fully inside. Penumbral magnitude is the
same measure for the penumbra.

Some recent and forthcoming eclipses, in UTC:

| Date and time of greatest eclipse | Kind |
|---|---|
| 2025-03-14 06:59 | Total |
| 2025-09-07 18:12 | Total |
| 2026-03-03 11:34 | Total |
| 2026-08-28 04:13 | Partial (umbral magnitude 0.93 — nearly total) |
| 2028-12-31 16:52 | Total |
| 2029-06-26 03:22 | Total (about 1 h 42 min of totality) |

The Moon has to be above your horizon to see it. A lunar eclipse can only happen at full
Moon, so the Moon is opposite the Sun: the eclipse is visible from wherever the Moon is above
the horizon during it.

To look at the Moon, set **Camera → Heading → Camera Heading** to **Celestial Lock**, with
**Celestial Object** set to Moon. Then set **Camera → FOV (Zoom) → VFOV (deg)** to about 1.2:
the Moon is only about 0.5° across. If the Moon does not appear, it is below the horizon at
that place and time.

---

## What you are looking at

**The penumbra** is the region that can see *part* of the Sun past the Earth. It is huge
and its shading is very gradual — the gradient runs about two lunar radii — so a purely
penumbral eclipse is subtle, and the early penumbral phase is too faint to see. During a
partial or total eclipse, the default Auto Exposure hides this gradient. Turn Auto Exposure
off to see it.

**The umbra** is the region that can see *none* of the Sun. Its edge is not sharp: because
the Sun is a disc and not a point, and because the Earth has an atmosphere, the light dies
away over a few hundred kilometres. Sitrec renders that softness from the geometry rather
than blurring it.

**The color** is the interesting part. No direct sunlight reaches the umbra at all, so
every photon landing there was bent into the shadow by the Earth's atmosphere — refracted
around the limb (the edge of the Earth's disc as seen from the Moon), through a slant path so
long that it strips out the blue. What survives is the copper red of a "blood moon". Look for
the **turquoise fringe** just inside the umbral edge as well: it is ozone, which absorbs from
green through to red and so leaves blue behind on the ray paths that ran high through the
stratosphere. On a deep eclipse, where the Moon passes near the centre of the umbra, Auto
Exposure can clip the fringe to white. To see it then, turn Auto Exposure off and set
**Exposure (stops)** to about 10 during a partial phase.

![Two views of the same partly eclipsed Moon side by side. In the left view the lower right of the Moon is grey, and it fades smoothly to black toward the upper left. In the right view the lower right is bright, the upper left is a dark olive and red, and a pale turquoise band runs along the edge between them](docimages/lunar-eclipse-partial-exposures.jpg)

*The same moment in a partial phase, with Auto Exposure off, at two exposures. Left: true relative brightness. The penumbra darkens gradually toward the umbra, and the umbra is black. Right: the high exposure given above. The umbra shows its color, and the pale turquoise band along its edge is the ozone fringe.*

---

## The controls

| Control | What it does |
|---|---|
| **Eclipse Shading** (the checkbox on the Lunar Eclipse title bar) | Master switch. On by default. It changes the picture only during an eclipse. Off also blanks the *Eclipse* readout. |
| **Blood Moon Color** | The physical color of the refracted light. Off renders the same brightness in grey. |
| **Atmospheric Clarity** | How clear the Earth's atmosphere is around the limb — see below. |
| **Auto Exposure** | Brighten the shadowed part enough to see it. On by default. |
| **Exposure (stops)** | Manual exposure. 0 is physically correct. Touching it turns Auto off. |
| **Shadow Outlines** | Ring the umbra and penumbra at the Moon's distance, while the Moon is in the shadow. Off by default. |
| **Eclipse** | Read-only: the phase at the current moment. `Penumbral` gives the penumbral magnitude. `Partial` gives the umbral magnitude and the Moon's visual magnitude (mV). `Total` adds the Danjon number. The row is too narrow for the whole text: it cuts off the mV value and the Danjon number, and no control shows them. |

### Atmospheric Clarity, and why eclipses differ

Two total eclipses with almost identical geometry can look completely different, and the
reason is the state of the Earth's atmosphere. Volcanic aerosol high in the stratosphere,
and cloud along the limb, both cut the light that would otherwise reach the umbra. After
the 1991 Pinatubo eruption the December 1992 eclipse was so dark the Moon nearly vanished.

*Atmospheric Clarity* is that one variable. Sliding it from 0 to 1 moves along the
**Danjon scale**, the traditional 0-to-4 rating of how a total eclipse looked:

| Danjon | Appearance |
|---|---|
| L0 | Very dark; the Moon almost invisible at mid-totality |
| L1 | Dark grey or brownish; surface detail hard to make out |
| L2 | Deep red or rust-colored, with a darker centre |
| L3 | Brick red, with a bright grey or yellow rim to the umbra |
| L4 | Bright copper-red or orange, with a very bright bluish rim |

The default is 0.5. The *Eclipse* readout ends with the Danjon number the model predicts, which
is a prediction from an assumed atmosphere, not an observation. The menu row is too narrow to
show this number. The number changes during totality, because it uses the brightness of the
disc at that moment: on 2029-06-26 at the default clarity it goes from L4.0 at the start of
totality to L2.3 at greatest eclipse. The scale rates mid-totality, so the value at greatest
eclipse is the one to compare with the table.

### Exposure

At greatest eclipse and the default clarity, the total eclipses above are about 10.5 to 12.5
magnitudes fainter than a full Moon, a factor of about 15,000 to 100,000. At true brightness
such a Moon renders black, which is correct but shows nothing.

**Auto Exposure** picks one exposure from the deepest phase of the eclipse you are looking
at, and then holds it for the whole event. One exposure for the whole event means the Moon
still visibly *darkens* as it enters the umbra, instead of the picture quietly levelling
itself out. That exposure is high: about 10 to 13 stops (one stop doubles the brightness) at
the default clarity for the partial and total eclipses above. The whole penumbra therefore
renders at full brightness, like the uneclipsed Moon, and on a deep eclipse the partial
phases can show only a pale tint. A purely penumbral eclipse gets no boost.

For true relative brightness, turn Auto Exposure off and set **Exposure (stops)** to 0. This
also shows the penumbral gradient during a partial or total eclipse.

---

## Shadow Outlines

**Shadow Outlines** rings the Earth's shadow out at the Moon's distance. The inner ring is the
umbra, and the outer ring is the penumbra. Both rings look yellow on screen.

The rings come from the same geometry that shades the Moon, so the inner one follows the
umbra's geometric edge across the Moon's face. The match is clearest at an exposure of about
10 stops. On a deep eclipse Auto Exposure clips the rim, and the visible edge then lies
inside the ring. Turn them on during a partial eclipse and that match is the easiest way to
see that the curve of the shadow on the Moon really is an arc of a circle about 4,700 km in
radius — nearly three times the Moon's own.

![Two thin yellow circles, one inside the other, on a black sky with white stars. The Moon sits at the lower right of the inner circle, partly inside it. The part inside is dark, and the line of the inner circle runs across the Moon's face along the edge of the dark part](docimages/lunar-eclipse-shadow-outlines.jpg)

*Shadow Outlines on, at the same moment and exposure as the right view above. The inner ring is the umbra, and the outer ring is the penumbra. The inner ring runs along the edge of the shadow on the Moon's face. The white dots are stars.*

They are off by default: they are a diagram over an otherwise photographic sky. They appear
only while the Moon is in the penumbra or umbra, so nothing shows while the *Eclipse* readout
says `none`.

This is not the same thing as **Show Moon's Shadow** (in **Show → Celestial**), which draws
the *Moon's* shadow falling on the *Earth* — the footprint of a solar eclipse.

---

## Accuracy

**Geometry.** The shadow model is astronomy-engine's own, reproduced exactly: the same
umbral and penumbral cone radii, the same geocentric Moon and aberration-corrected Sun.
Sitrec's contact times (the moments the Moon enters and leaves each shadow) therefore match
that library's published semi-durations (half the length of each phase) to about a second,
which is as closely as they can be checked — its own search runs to a one-second tolerance.
The kind of eclipse matches, and the peak obscuration (the fraction of the Moon's disc area in
the umbra) matches to six decimal places.

**Shadow enlargement.** The Earth's atmosphere makes the planet's shadow slightly bigger than
the solid globe would, and different methods are in use for how much bigger. Chauvenet's
method enlarges the shadow radii by 1/50, about 90 km on the umbra and 165 km on the penumbra
at the Moon. Danjon's method adds 1/85 of the Earth's radius (75 km) to the Earth.
[astronomy-engine](https://github.com/cosinekitty/astronomy), which supplies Sitrec's
ephemeris, adds **88 km** to the Earth. Sitrec uses 88 km, which is what makes those contact
times line up. Sitrec also uses 88 km as the top of the atmosphere in the color calculation,
so the refracted light and the geometric shadow meet at the same radius.

**The soft edges are geometry, not a blur.** For each point on the Moon, Sitrec works out
how much of the Sun's disc the Earth is hiding, and how much light that leaves after limb
darkening (the Sun's disc is dimmer toward its edge). The place where that first reaches zero
is, algebraically, the umbral cone radius — so the penumbral gradient and the feathered
umbral edge come out of the same calculation as the contact times, with no smoothing
parameter in the direct light.

**The color** is computed rather than tinted. For rays grazing the Earth at every altitude
from the ground to 88 km, Sitrec integrates the slant path through a US Standard Atmosphere:
Rayleigh scattering, ozone in the Chappuis band (its absorption band in visible light), and
stratospheric and tropospheric aerosol. It works out how much each ray is bent, integrates 36
wavelengths through the CIE color matching functions, follows the ray to where it lands in
the shadow, and adds up the light — then averages the result over the Sun's disc, which has a
real angular size. The red of the umbra, the way the centre is darker than the rim, and the
turquoise ozone fringe are all consequences of that, not settings.

**What is not modelled.** Light *scattered* into the umbra, as opposed to refracted, is
ignored; the real umbra is a little less saturated than Sitrec's for that reason. Cloud along
the limb is a statistical average, not that day's weather — which is a real limitation,
since cloud is one of the largest terms. And the Earth's shadow is treated as circular; its
slight oblateness moves the umbral edge by up to about 14 km out of 4,700.

---

## See also

- [Historic Skies](HistoricSkies.md) — how far back the ephemeris is good for, and to what accuracy.
- [Atmospheric Refraction](Refraction.md) — the same physics applied to your own sightlines.
