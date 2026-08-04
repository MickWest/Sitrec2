# Atmospheric Refraction

**View → Atmospheric Refraction**

Air bends light. Distant things therefore appear slightly *higher* than straight-line geometry
says they should — including things below the geometric horizon, which is why you can
sometimes see land that "should" be hidden by the Earth's curvature.

This matters in Sitrec because a large class of arguments turns on exactly that question:
*could the observer have seen X from Y?* Answered with refraction off, the answer is wrong by
a knowable and often decisive amount.

> **Refraction is ON by default.** Sitrec bends light the way the atmosphere does unless you
> turn it off. Switch it off only when you deliberately want straight-line geometry — to
> isolate the size of the effect, or to reproduce a result computed without it.

---

## How much does it matter?

The refracted horizon is further away than the geometric one by a factor of √(1/(1−k)), where
*k* is the refraction coefficient:

| From | Geometric horizon | Refracted (k = 0.13) |
|---|---|---|
| 2 m (eye level at the shore) | 5.0 km | 5.4 km |
| 100 m | 35.7 km | 38.3 km |
| 30,000 ft | 184.4 nm | **197.7 nm** |

Thirteen nautical miles at airliner altitude. At the standard-lapse value of k ≈ 0.176 it is
about +10 %.

For a *terrestrial* target the lift depends on how far away it is, because the light has only
crossed the air between you and it:

- about **0.7 arcminutes at 20 km**
- about **3.4 arcminutes at 100 km**

For a *star*, which is seen through the whole atmosphere, the lift at the horizon is about
**29 arcminutes** — roughly the diameter of the Sun. This is why the Sun is already
geometrically below the horizon when you watch it set.

---

## The two models

Sitrec implements refraction twice, because the two cases are genuinely different physics.

**Sky (celestial).** For the Sun, Moon, planets and stars, whose light has traversed the
entire atmosphere. Uses Saemundsson's formula, bending apparent positions toward the zenith.
About 29′ at the horizon, falling rapidly with altitude.

**Terrain and Buildings (terrestrial).** For things a finite distance away — distant coastline,
mountains, buildings, the sea surface, and Google Photorealistic or Cesium 3D tiles. The bend
is range-dependent:

```
angular lift  dθ = k·d / (2R)
height lift   dh = k·d² / (2R)
```

where *d* is the range and *R* the Earth's radius.

**This is display only.** Ground elevations, altitude readouts and line-of-sight geometry stay
geometric — refraction bends light, it does not raise the land. Note also that 3D models,
tracks and line-of-sight lines are not currently lifted, so a track drawn against refracted
terrain is drawn on the unrefracted geometry.

---

## The controls

| Control | Default | Notes |
|---|---|---|
| **Enable Refraction** | on | Master switch. Off means light travels in straight lines |
| **Terrain and Buildings** | on | The terrestrial model |
| **Sky** | on | The celestial model |
| **Refraction Pressure (hPa)** | 1010 | Feeds both models |
| **Refraction Temperature (°C)** | 10 | Feeds both models |
| **Surface Temp Gradient (K/km)** | −6.5 | Feeds the terrestrial *k*. See below |
| **Refraction Coefficient k** | derived | Shows the *k* actually in force. Editable only with Override on |
| **Override k** | off | Set *k* by hand instead of deriving it |

All three default on, so a fresh sitch runs both models. The sub-switches exist to take one
half back out when you are deliberately isolating an effect.

---

## Understanding *k* — and why it is not a constant

The terrestrial coefficient is derived, not assumed:

```
k = 503 · (P / T²) · (0.0342 + dT/dh)
```

with *P* in hPa, *T* in kelvin, and *dT/dh* the temperature gradient in K/m. So *k* is **not**
independent of the pressure and temperature above it — changing those changes it.

The term that matters is the temperature gradient, and it is also the one you are least likely
to know:

| Gradient | Situation | Resulting *k* |
|---|---|---|
| −9.8 K/km | Dry adiabatic — strong daytime heating | low |
| −6.5 K/km | Standard atmosphere | ≈ 0.176 |
| −13.7 K/km | A sun-warmed land surface | 0.13, the traditional surveying value |
| **positive** | **Inversion** — routine over water at night | **sharply higher**, can exceed 0.5 |

That last row is the important one. Over water at night an inversion can nearly triple the
refraction, which is the mechanism behind superior mirages and looming — distant ships and
coastlines appearing well above where geometry puts them.

**Practical consequence: refraction is a bounded-uncertainty term, not a fixed correction.**
If your argument depends on it, do not quote one number. Run it at the standard gradient and
again at a plausible inversion, and report both. If the conclusion flips between them, the
honest finding is that the observation does not settle the question.

The bend is capped at 34′, on the reasoning that a finite target can never be lifted by more
than the whole atmosphere would lift a star.

### Fitting k to an observation

If you have a photograph showing a landmark at a known distance and known height, you can
work backwards: tick **Override k** and adjust it until the render matches. That gives you a
measured *k* for those conditions, which you can then apply to the object you actually care
about. This is far stronger than assuming a textbook value — but state that you did it, since
it is a fitted parameter.

---

## What is *not* refracted

- Ground elevations and AGL readouts — geometric
- Line-of-sight lines and traverse geometry — geometric
- 3D models and tracks — not lifted
- The horizon calculations exposed to other parts of the app — geometric

So if you turn refraction on and the distant terrain rises but the aircraft track sitting on
it does not, that is expected. Do not read the resulting mismatch as a data problem.

---

## See also

- [GIS, Geodesy and Altitude](GIS.md) — the Earth model the curvature comes from
- [Haze and Aerial Perspective](AtmosphericAerialPerspective.md) — the other way the
  atmosphere changes what a distant object looks like
- [Doing Defensible Analysis](DefensibleAnalysis.md) — reporting a bounded-uncertainty term
  honestly
