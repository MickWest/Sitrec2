# Historic Skies

**Time menu → Year**

Sitrec can reconstruct the sky for dates long before the modern UFO era. The Year slider
starts at 1947 — the Kenneth Arnold sighting — but that is only where it *starts*: type an
earlier year, or a historic date into the Go To box, and the range extends back to 1700.

That matters for the sighting waves that predate anything the slider was built for: the
November 1896 California airship wave, the spring 1897 wave across the midwest and Texas,
the 1909 "scareships" over Britain and New Zealand, and the 1913 reports. For most of these
the only physical evidence is a newspaper account giving a place, a rough time and a
direction — which is exactly the input Sitrec turns into a testable sky.

---

## Reaching a historic date

Any of these work:

| How | Example |
|---|---|
| **Go To box** — press `G` | `10 April 1897 7:30pm`, or `1897-04-10 01:30 UTC` |
| **Year field** — type into it, don't drag | `1897` |
| **URL** | `?datetime=1897-04-10T01:30:00Z` |
| **Sitch definition** | `startTime: "1897-04-10T01:30:00.000Z"` |

Once the date is historic the Year slider's floor drops to 1700 so you can drag around
freely; it returns to 1947 as soon as you come back to a modern date. Right-click the
slider and choose **Reset** to restore the default range at any time.

---

## What is accurate, and to what

Sitrec's positions come from [astronomy-engine](https://github.com/cosinekitty/astronomy),
which implements the same VSOP87 (planets) and ELP (Moon) theories as most serious
planetarium software. The frame transform, the precession and the clock corrections have all
been checked against independent solves at historic epochs:

| Quantity | Accuracy in 1700–2200 |
|---|---|
| Sun, Moon, planet positions | well under an arcminute |
| The EQJ→ECEF transform that lands the sky on the terrain | worst 0.004″, measured across 1700–2200 |
| Precession and nutation | applied rigorously (J2000→1896 is **1.45°** — over three lunar diameters, so this is not a detail) |
| ΔT, the Terrestrial-Time to Universal-Time offset | Espenak–Meeus polynomials: −5.6 s in 1896, +20 s in 1918 |

As a check on all of it: astronomy-engine reproduces the total solar eclipses of
**28 May 1900** and **8 June 1918** at the right minute and the right place on the globe.

## What is not

**Stellar proper motion is not applied.** Stars move across the sky at their own small rates,
and Sitrec's catalogue is frozen at its epoch of J1991.25. Going back to 1897 that is about
94 years of unmodelled motion:

| Star | Error in 1897 |
|---|---|
| A typical bright star | 1–2′ |
| Arcturus | ~3.6′ |
| Alpha Centauri | ~5.8′ |

For scale, the Moon is **30′** across, and a newspaper saying "about eight o'clock" is
±30 minutes — which is **±7.5° of sky rotation**, two orders of magnitude larger. Proper
motion is not what limits a historic reconstruction. It does mean a precise star-field match
(the Star Tracker) should be treated with a few arcminutes of slack at these dates.

**UT1−UTC is ignored.** Up to 0.9 s, so up to 0.0037° of Earth rotation. Negligible here.

**The legacy sidereal helpers bypass precession.** `calculateGST()` and `getLST()` return a
mean sidereal time referred to the equinox *of date*; pairing either with J2000 coordinates
omits precession entirely, which in 1897 is a 1.45° error. Everything user-facing goes
through `getEQJToECEFMatrix()` instead, which is correct. This only matters if you are
writing new code.

---

## Clocks before standard time

Time zones are the largest avoidable error in a historic reconstruction, because an hour is
15° of sky.

- **Set `Sit.timeZone` explicitly** on a historic sitch. Sitrec has no location→timezone
  lookup, so it otherwise falls back to the browser's own zone, which is only right if you
  happen to be sitting where the sighting happened.
- **The fallback zone is worked out once, from the sitch's own start time.** So if you load
  a modern sitch and *then* type an 1897 date, the zone stays whatever the modern date
  implied — possibly an hour out, since daylight saving may apply to one date and not the
  other. Pick the zone from the Time menu after changing the date, or put the historic date
  in the sitch.
- **There was no daylight saving.** Not anywhere before 1916 (Germany), and not in the US
  before 31 March 1918. Choosing `CDT` or `BST` for an 1897 date invents an hour that did
  not exist — use `CST UTC-6`, `GMT UTC+0` and so on.
- **US standard time zones date from 1883**, so for 1896–1918 American sightings the
  standard zones are the right choice. Earlier than that, or in places that kept local mean
  time longer, the nearest standard zone can be tens of minutes out — small against the
  vagueness of the source, but worth stating in the sitch Notes.
- The zone list holds fixed offsets only; there are no historical rules and no local mean
  time entries.

---

## What is anachronistic

The sky is period-correct. The world around it is not:

- **Terrain elevation is fine** — landforms have not moved. **Map imagery, 3D buildings and
  OSM data are modern**, so a townscape will be wrong even where the horizon profile is right.
- **No satellites existed before 1957.** The satellite layer draws nothing at these dates and
  the catalogue fetch will report an error if asked for one. This is expected, not a fault.
- **No aircraft, and no aircraft lighting.** In 1896–97 there was nothing in the sky but
  astronomical objects, birds, balloons and kites — which is precisely what makes these cases
  worth reconstructing.

The Time menu shows a one-line note when the date is outside 1700–2200, or before 1957.

---

## Worked example: Venus and the 1897 wave

The standard mundane explanation for the spring 1897 airship reports is Venus, and Sitrec
reproduces the case without any special handling. Set the location to Fort Worth, Texas, the
zone to `CST UTC-6`, and step through the spring at about 7:30 pm local:

| Date | Venus altitude | Azimuth | Magnitude |
|---|---|---|---|
| 1 March 1897 | 31.7° | 265° (W) | −4.64 |
| 22 March 1897 | 29.9° | 277° (W) | −4.78 |
| 5 April 1897 | 23.2° | 284° (WNW) | −4.72 |
| 19 April 1897 | 9.6° | 291° (WNW) | −4.27 |
| 26 April 1897 | 0.7° | 294° (WNW) | −4.17 |

Venus sat near greatest brilliancy, high in the western twilight, and sank to the horizon
through the second half of April — tracking the rise and collapse of the reports. Load it,
point the camera along the bearing the witness gave, and you can see what they had in front
of them.

That is the point of doing this in Sitrec rather than a planetarium app: the sky arrives on
top of the real terrain, seen from the position the account actually specifies, with the
horizon and the sightlines that go with it.
