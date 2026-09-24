# Atmospheric Refraction

**View → Atmospheric Refraction**

Air bends light. Distant things therefore appear slightly *higher* than straight-line geometry
says they should — including things below the geometric horizon, which is why you can
sometimes see land that "should" be hidden by the Earth's curvature.

Refraction changes the answer to *could the observer have seen X from Y?* The tables below
give the size of the change.

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
crossed the air between you and it. At Sitrec's default *k* of 0.176 (see below):

- about **0.95 arcminutes at 20 km**
- about **4.7 arcminutes at 100 km**

At the traditional surveying value k = 0.13 these are about 0.7′ and 3.5′.

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

The bend is applied to everything drawn in the scene: terrain, 3D tiles, buildings, the sea,
3D models, tracks and line-of-sight lines all rise together, so a track stays on the terrain it
sits on. Satellites and their tracks are the exception — they are already bent by the Sky model.

**This is display only.** Ground elevations, altitude readouts and line-of-sight geometry stay
geometric — refraction bends light, it does not raise the land.

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

The term that matters most is the temperature gradient:

| Gradient | Situation | Resulting *k* |
|---|---|---|
| −9.8 K/km | Dry adiabatic — strong daytime heating | low |
| −6.5 K/km | Standard atmosphere | ≈ 0.176 |
| −13.7 K/km | Gives the traditional surveying value | 0.13 |
| **positive** | **Inversion** (temperature increases with height) | **sharply higher**, can exceed 0.5 |

An inversion is the cause of superior mirages and looming — distant ships and coastlines
appearing well above where geometry puts them.

*k* depends on the temperature gradient, which is usually not measured. Tip: to see the range
of the effect, compare the result at −6.5 K/km with the result at a positive gradient.

The bend is capped at 34′, on the reasoning that a finite target can never be lifted by more
than the whole atmosphere would lift a star.

**Elevated observers get less bend.** A ray only curves where there is air, so Sitrec scales
*k* by the mean air density along the sight line (an 8.5 km scale height). An observer on the
ground is unchanged; a camera at airliner altitude sees a smaller effective *k* than the
textbook value, and a camera in orbit lifts the scene almost not at all. The apparent lift is
also capped at 25.5 km, a guard that never applies to real ground-level geometry. So the
30,000 ft row of the horizon table above, which uses a constant k = 0.13, overstates what the
render shows from that height.

### Fitting k to an observation

If you have a photograph showing a landmark at a known distance and known height, you can
work backwards: tick **Override k** and adjust it until the render matches. That gives you a
measured *k* for those conditions, which you can then apply to another object in the same
scene.

---

## What is *not* refracted

Refraction changes where things are *drawn*, not the numbers Sitrec computes:

- Ground elevations and AGL readouts — geometric
- Line-of-sight and traverse calculations — geometric (the lines are drawn lifted, like
  everything else in the scene)
- The horizon calculations exposed to other parts of the app — geometric

---

## Ray-traced Refraction

**Effects → Ray-traced Refraction**

The two models above use one constant *k*. For non-uniform air — mirages, ducting, folds in
the horizon — use the separate ray-traced tool. Tick **Enable Ray-traced Refraction** to apply
it to one chosen 3D view, and click **Profiles, Rays & Lasers…** to open its editor. There you
pick a temperature profile preset, drag the temperature and humidity curves, and add laser
beams to see where light really goes. The settings save with the sitch.

---

## See also

- [GIS, Geodesy and Altitude](GIS.md) — the Earth model the curvature comes from
- [Haze and Aerial Perspective](AtmosphericAerialPerspective.md) — the other way the
  atmosphere changes what a distant object looks like
