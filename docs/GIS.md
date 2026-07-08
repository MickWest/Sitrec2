# GIS Concepts in Sitrec

Sitrec models the Earth as either a sphere or an oblate ellipsoid depending on the `useEllipsoid` setting. This document explains the reference surfaces and vertical datums involved, and how Sitrec converts between them.

## The WGS84 Ellipsoid

The **World Geodetic System 1984 (WGS84)** defines a reference ellipsoid that approximates the shape of the Earth. It is the coordinate system used by GPS and by most mapping services (Google Earth, Mapbox, Cesium, etc.).

Key parameters used in Sitrec (`LLA-ECEF-ENU.ts`):

| Parameter | Value |
|-----------|-------|
| Semi-major axis (equatorial radius, *a*) | 6,378,137 m |
| Inverse flattening (1/*f*) | 298.257223563 |
| Flattening (*f*) | 1/298.257223563 |
| Semi-minor axis (polar radius, *b = a(1-f)*) | 6,356,752.314 m |

The difference between the equatorial and polar radii is about 21.4 km. This is small relative to the Earth's size, but large enough to matter for precision work. Around mid-latitudes, a simple sphere can differ from the WGS84 ellipsoid by on the order of 10 km in radial distance.

When `useEllipsoid` is **false** (legacy mode), Sitrec treats both radii as equal to *a*, degenerating to a sphere. When **true**, the real WGS84 polar radius is used.

## The EGM96 Geoid

The ellipsoid is a smooth mathematical surface. The actual shape of sea level — driven by gravity variations from uneven mass distribution inside the Earth — is an irregular surface called the **geoid**.

**EGM96** (Earth Gravitational Model 1996) is a spherical harmonic model of the geoid. It defines the **geoid undulation** *N* at any point on Earth: the signed vertical distance between the geoid and the WGS84 ellipsoid. Typical values range from about -105 m to +85 m.

Sitrec uses the `egm96-universal` npm package to look up *N* at any latitude/longitude (`EGM96Geoid.js`).

## Three Kinds of Height

There are three common ways to express the height of a point:

```
Ellipsoid height (h)   — height above the WGS84 ellipsoid
Orthometric height (H) — height above the geoid (i.e. above mean sea level)
Geoid undulation (N)   — height of the geoid above the ellipsoid

h = H + N
```

In plain terms:
- **Orthometric height (H)** is what most people mean by "altitude above sea level" (MSL). It is what you see on a topographic map or an altimeter.
- **Ellipsoid height (h)** is the height above the WGS84 reference ellipsoid. It is what GPS receivers natively measure.
- **Geoid undulation (N)** is the difference. It varies smoothly across the Earth's surface and is provided by models like EGM96.

## AWS Terrain Tiles (Terrarium Format)

Sitrec loads elevation data from the **AWS Open Data Terrain Tiles** in Terrarium PNG format:

```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

The elevation is encoded in the RGB channels of each pixel:

```
elevation = R * 256 + G + B / 256 - 32768   (meters)
```

These elevations are **orthometric heights** — heights above the EGM96 geoid (approximately MSL). They are *not* heights above the WGS84 ellipsoid.

### The Geoid Correction

Sitrec works internally in ECEF — a Cartesian coordinate system (x, y, z meters from the Earth's center). ECEF coordinates are just Cartesian positions, but LLA-to-ECEF conversion depends on the geodetic surface and altitude reference. When altitude is HAE (height above the WGS84 ellipsoid), conversion is direct. When terrain tiles provide orthometric heights (MSL-like), Sitrec first converts to HAE by adding the geoid undulation:

```
h_ellipsoid = h_terrarium + N
```

This is done per-pixel in `QuadTreeTile.js` (`computeElevationFromRGBA`). The geoid undulation is looked up at the four corners of each tile and bilinearly interpolated across the tile's pixels:

```javascript
const geoidCorners = geoidCorrectionForTile(mapProjection, z, x, y);
// ...
elevation[ij] = R * 256 + G + B / 256 - 32768
              + interpolateGeoidOffset(geoidCorners, xFrac, yFrac);
```

The same correction is currently applied to Mapbox Terrain-RGB tiles (`computeElevationFromRGBA_MB`) for consistency with Sitrec's EGM96-based altitude handling.

Mapbox's own documentation states Terrain-RGB is built from mixed vertical datums (for example NAVD88, EGM96, and local datums), so this correction should be treated as a practical approximation, not a universal truth for every tile.

Without this correction, terrain would be displaced vertically by up to ~100 m depending on location, causing visible misalignment with GPS tracks, satellite imagery, and 3D building tiles (all of which derive their positions from HAE, not MSL).

## Coordinate Systems

Sitrec uses several coordinate systems internally:

| System | Description |
|--------|-------------|
| **LLA** | Latitude, Longitude, Altitude (geodetic, WGS84) |
| **ECEF** | Earth-Centered Earth-Fixed (Cartesian, origin at Earth's center) |
| **ENU** | East-North-Up (local tangent plane) |

The conversion chain is: **LLA <-> ECEF <-> ENU**, implemented in `LLA-ECEF-ENU.ts`. The LLA-to-ECEF conversion depends on the Earth model (sphere or WGS84 ellipsoid) because geodetic latitude and altitude are defined relative to that surface. ECEF itself is just Cartesian — no ellipsoid needed to interpret the coordinates.

## 3D Tiles (Cesium / Google)

Cesium Ion and Google Photorealistic 3D Tiles are delivered as 3D Tiles in Cartesian coordinates. For global geospatial tilesets this is typically WGS84 ECEF (often EPSG:4978 per the 3D Tiles spec). Sitrec uses these directly in ECEF (`CNodeBuildings3DTiles.js`). No geoid correction is needed because there is no separate "MSL altitude" field to reinterpret.


# (In Depth) Altitude Naming Conventions & the MSL Confusion Problem

## The Three Surfaces

| Surface | Description |
|---|---|
| **WGS84 Ellipsoid** | A smooth mathematical oblate spheroid. Pure geometry, no physical meaning. Reference for GPS. |
| **Geoid** | An equipotential gravitational surface approximating mean sea level. Irregular shape, physically meaningful. |
| **Mean Sea Level (MSL)** | Approximated by the geoid, but also used loosely for barometric altitude — the source of most confusion. |

---

## Standard Terms

### Ellipsoidal Height (geometric)
- **HAE** — Height Above Ellipsoid *(most common in military/DoD)*
- **Ellipsoidal height / ellipsoid height**
- **h** *(lowercase, formal geodetic literature)*
- *"GPS altitude"* *(informal)*

### Geoid / Orthometric Height (physical)
- **MSL** — Mean Sea Level *(aviation, colloquial — ambiguous, see below)*
- **AMSL** — Above Mean Sea Level *(aviation — same ambiguity)*
- **Orthometric height** *(formal geodetic term)*
- **H** *(uppercase, formal geodetic literature)*

### Geoid Undulation (the separation between the two)
- **N** — geoid undulation *(formal geodetic literature)*
- **Geoid separation** *(NMEA $GPGGA sentence field name)*
- **Geoid height** *(less precise — easily confused with "height above geoid")*

---

## The Fundamental Relationship

```
h (HAE) = H (orthometric/MSL) + N (geoid undulation)
```

The geoid undulation **N** ranges globally from approximately **−107 m** to **+85 m** (EGM96). In the continental US, EGM96 values are typically **negative** (roughly −55 m to −10 m).

---

## Geoid Models

| Model | Resolution | Notes |
|---|---|---|
| EGM96 | 15′ | Used in Sitrec today (via `egm96-universal`) |
| EGM2008 | 2.5′ / 1′ | Newer global model with finer resolution |

---

## The MSL Confusion Problem

"MSL" is used to mean **three different things** in practice:

### 1. Geodetic / GPS MSL (orthometric height)
Height above the geoid (EGM96 or EGM2008). Derived by GPS receiver applying a geoid model to the raw ellipsoidal height. This is the geodetically correct meaning.

### 2. Barometric / Aviation MSL
Height derived from atmospheric pressure, calibrated to the ISA (International Standard Atmosphere) model. Reported by altimeters and used in ATC. **Not the same as geodetic MSL** — deviates by tens of meters under non-standard temperature/pressure conditions.

### 3. "GPS altitude" mislabeled as MSL
Many GPS devices, NMEA sentences, and flight logs report the raw ellipsoidal height (HAE) but label it "altitude" or "MSL" — especially when the onboard geoid model is absent or low quality.

---

## NMEA $GPGGA Sentence
The NMEA standard correctly separates these:
```
$GPGGA,...,<MSL altitude>,M,<geoid separation>,M,...
```
- **MSL altitude** = orthometric height (H) above geoid
- **Geoid separation** = N (geoid height above ellipsoid)
- **Ellipsoidal height** = MSL altitude + geoid separation (h = H + N)

However, the geoid separation field is often populated from a coarse onboard table (sometimes just a single global constant), making it unreliable on many consumer devices.

---

## MISB ST 0601 (Military UAV Metadata)

| Tag | Name | Meaning |
|---|---|---|
| 15 | SensorTrueAltitude | MSL (orthometric, assumed EGM96) |
| 75 | SensorEllipsoidHeight | HAE (WGS84 ellipsoid) |
| 104 | SensorEllipsoidHeightExtended | HAE, extended precision |

The standard defines Tag 15 as "MSL" but **does not explicitly specify EGM96**. In practice, DoD platforms of the Predator/Reaper era use EGM96 as the geoid model. Tag 75 was added later specifically because Tag 15's ambiguity was a known problem.

---

# Altitude in KML, ADS-B, and Flight Tracking Services

## KML Altitude Modes (OGC Standard)

KML defines altitude through the `<altitudeMode>` element. The standard (non-extended) values are:

| Mode | Meaning |
|---|---|
| `clampToGround` | **Default.** Ignores altitude value entirely; places feature on terrain surface. |
| `relativeToGround` | Altitude in meters above the terrain surface (AGL). |
| `absolute` | Altitude in meters above sea level. In OGC KML geodetic CRS definitions, this corresponds to the EGM96 geoid vertical datum. |

Google's `gx:` extension namespace adds two sea-floor variants (`clampToSeaFloor`, `relativeToSeaFloor`) not relevant to aviation.

**Spec point:** KML `absolute` altitude is sea-level referenced (OGC KML: EGM96 geoid vertical datum in the standard geodetic CRS definition).

**Sitrec implementation note:** Sitrec treats KML `absolute` altitude as **MSL** (EGM96 geoid), per the OGC KML vertical datum. KML feature import (`CNodeTrackFromLLAArray`, absolute mode) passes `altitudeReference: "MSL"` and the track KML exporters (`CNodeTrack.exportTrackKML`, `CNode3DObject.exportToKML`) convert HAE→MSL on the way out, so exported tracks and objects open at the correct height in Google Earth. (`CNodeTrackFromLLAArray` / `CNodeTrack` still default `altitudeReference` to `"HAE"` for non-KML callers that supply raw ellipsoidal data.)

---

## ADS-B Altitude: What Gets Transmitted

ADS-B Extended Squitter (1090ES) mandates two altitude fields per FAR 91.227(d):

**Barometric (pressure) altitude** — always required, always referenced to **1013.25 hPa (QNE)**. This is the raw transponder Mode C output. It is *never* QNH-corrected in the transmitted data stream — QNH correction only happens onboard the aircraft and in ATC systems on the ground.

**Geometric (GNSS) altitude** — also required, transmitted as **HAE (height above WGS84 ellipsoid)**. This is GPS-derived. Not used for ATC separation — only as a cross-check and for EGPWS/terrain systems.

These two values are almost never the same. The difference at cruising altitude can easily be hundreds of feet.

---

## ADSBexchange: Three KML Export Options

When exporting a KML track from globe.adsbexchange.com, three altitude options are offered:

### 1. Geometric altitude (EGM96)
- Takes the raw `alt_geom` field (HAE, WGS84 ellipsoid) and **adds the EGM96 geoid undulation** for the aircraft's position
- Result: orthometric height (MSL, EGM96)
- This is the **correct option for Google Earth** since KML `absolute` mode uses EGM96
- The aircraft will appear at the right height above the terrain model

### 2. Baro + avg.(EGM96 − baro)
- Takes the `alt_baro` field (QNE pressure altitude) and adds a **regional average offset** between EGM96 and barometric altitude
- Compensates for the aggregate effect of geoid undulation and local atmospheric pressure deviation from standard
- A reasonable approximation when geometric altitude is unavailable or noisy, but not precise

### 3. Uncorrected pressure altitude
- Raw `alt_baro` field: pressure altitude at **1013.25 hPa standard**, no correction
- This is what ATC Mode C radar sees before QNH correction
- Looks wrong in Google Earth because it doesn't account for geoid undulation or non-standard pressure
- Lowest quality for 3D reconstruction; use only when the others are unavailable

### ADSBexchange API fields (for reference):
- `alt_baro` — barometric pressure altitude, feet, QNE (1013.25 hPa), or `"ground"`
- `alt_geom` — geometric/GNSS altitude, feet, referenced to **WGS84 ellipsoid** (HAE)

---

## FlightRadar24

FR24 displays **barometric altitude only** — specifically the raw QNE (1013.25 hPa standard pressure) altitude from the ADS-B transponder. It is **not** corrected for local QNH.

Consequences:
- At high-altitude airports (e.g., Denver KDEN, elevation 5,433 ft), aircraft on the ground will show ~5,400 ft, then jump to 0 ft when the "on ground" bit is set, creating a discontinuous step.
- FR24 does show GPS altitude separately where available (aircraft transmitting geometric altitude), displayed as a secondary field.
- The primary altitude shown is always the raw QNE pressure altitude — not true MSL, not HAE, not EGM96.

**FR24 statement:** *"ADS-B only reports altitude values based on the standard pressure of 1013 hectopascals."*

---

## FlightAware

FlightAware similarly displays **barometric pressure altitude at 29.92 inHg (QNE)**. It is uncorrected for local altimeter setting.

This means the altitude shown is the same datum as FR24 — raw QNE pressure altitude. Not true MSL in the geodetic sense; not HAE; not EGM96-corrected.

FlightAware can show geometric altitude when available from ADS-B, but it is not the primary displayed value.

**Practical implication:** A flight at 5,500 ft indicated (with a local altimeter setting of, say, 30.15 inHg) may appear on FlightAware at ~5,125 ft because FlightAware uses QNE, not QNH.

---

## Barometric Altimetry and the 18,000 ft Rule

### Below the transition altitude (US: 18,000 ft / FL180)
Pilots set their altimeter to **QNH** — the local sea-level pressure at the nearest reporting station. The altimeter reads altitude AMSL. This is a reasonable approximation of geodetic MSL but is meteorologically influenced (varies with weather). Each reporting station issues a new QNH ~hourly.

### At and above 18,000 ft MSL (FL180 and above)
All aircraft set altimeters to the **standard pressure setting: 29.92 inHg / 1013.25 hPa (QNE)**. The altitude indicated becomes a **Flight Level** — a pressure surface, not a true altitude.

This means:
- FL350 (35,000 ft) is the pressure level corresponding to 35,000 ft in the **International Standard Atmosphere (ISA)**, not necessarily 35,000 ft above the geoid.
- On a cold day, the atmosphere is denser and FL350 is geometrically *lower* than 35,000 ft.
- On a hot day, FL350 is geometrically *higher* than 35,000 ft.
- The divergence between pressure altitude and geometric altitude at cruise altitudes can easily exceed **1,000 ft** in extreme temperature conditions.

### Why the transition exists
The purpose of QNE above FL180 is not accuracy — it's **uniformity**. Every aircraft uses the same datum above the transition, so vertical separation is consistent even if the absolute altitude is off. ATC radar works with Mode C (QNE) codes and applies its own QNH correction to convert to displayed altitude for controllers.

### Temperature error — the key non-obvious effect
A barometric altimeter is calibrated to ISA (15°C at sea level, lapse rate of 2°C/1000 ft). It has no temperature compensation for real-world conditions. On a cold day:
- Air is denser; a given pressure is reached at a *lower* geometric altitude
- The aircraft is physically lower than the altimeter indicates
- **Cold temperature correction** is required for obstacle clearance; it is safety-critical and commonly neglected

At cruise altitude, ISA deviations of ±20–30°C are routine, producing geometric altitude errors of several hundred to over 1,000 feet.

---

## Summary: What Each Source's Altitude Actually Means

| Source | Altitude type | Reference | Notes |
|---|---|---|---|
| ADS-B `alt_baro` | Pressure altitude | QNE (1013.25 hPa) | Never QNH-corrected in the data stream |
| ADS-B `alt_geom` | Geometric / HAE | WGS84 ellipsoid | GPS-derived; not used by ATC |
| ADSBx KML: geometric (EGM96) | Orthometric | EGM96 geoid | Best for Google Earth / 3D reconstruction |
| ADSBx KML: baro + avg | Approximate MSL | EGM96 approximate | Good fallback; regional correction only |
| ADSBx KML: uncorrected pressure | Pressure altitude | QNE | Raw; worst for 3D reconstruction |
| FlightRadar24 | Pressure altitude | QNE (1013.25 hPa) | Same as raw ADS-B baro |
| FlightAware | Pressure altitude | QNE (1013.25 hPa) | Same as raw ADS-B baro |
| KML `absolute` mode | Orthometric | EGM96 geoid | Assumed by Google Earth renderer |
| MISB ST0601 Tag 15 | Orthometric (MSL) | EGM96 (assumed) | Sensor true altitude in military KLV |
| MISB ST0601 Tag 75/104 | HAE | WGS84 ellipsoid | Explicitly defined |

---

## Relevance to UAP/ADS-B Analysis

When reconstructing aircraft geometry (e.g., in Sitrec) from ADS-B data:

1. Use `alt_geom` (HAE) if available — it's geometrically clean and can be used directly with WGS84 lat/lon.
2. If only `alt_baro` (QNE) is available, you need to apply two corrections to get HAE:
    - **QNH correction**: convert from QNE to orthometric height using local pressure (requires meteorological data for that time/place)
    - **Geoid correction**: add EGM96 undulation N to convert from orthometric to HAE
3. ADSBx's "geometric (EGM96)" KML export already does this correctly and is suitable for Google Earth rendering and 3D reconstruction.
4. The uncorrected QNE baro altitude can be off by hundreds to over a thousand feet from true geometric altitude at cruise — never use it for precision geometry without correction.



---

## Summary of What to Assume

| Source | What "altitude" likely means           |
|---|----------------------------------------|
| Raw GPS / GNSS receiver output | HAE (ellipsoidal)                      |
| NMEA $GPGGA "MSL altitude" field | Orthometric (geoid), quality varies    |
| Aviation altimeter / ATC reports | Barometric MSL                         |
| Military KLV/MISB Tag 15 | EGM96 orthometric MSL                  |
| Military KLV/MISB Tag 75/104 | HAE (WGS84)                            |
| ArcGIS / web mapping elevation | EGM96 orthometric MSL                  |
| KML ADSB Tracks | Commonly sea-level referenced; in Sitrec today, imported absolute values are treated as HAE unless explicitly handled as MSL |
| SRTM terrain data | EGM96 orthometric MSL                  |
