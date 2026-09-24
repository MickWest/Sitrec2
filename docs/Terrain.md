# Terrain and Elevation

**Terrain menu**

The terrain is not just scenery. Every ground-relative number Sitrec prints — an AGL altitude,
a "does this line of sight clear the ridge" answer, a terrain traverse — comes from it. This
document covers what the controls do and, more importantly, **which surface a given number
actually came from**, because there is more than one and they disagree.

---

## Two dropdowns that are easy to confuse

| Control | What it changes |
|---|---|
| **Map Type** | The *imagery* painted onto the ground. Purely cosmetic |
| **Elevation Type** | The *shape* of the ground — the digital elevation model. This drives every measurement |

Changing Map Type changes what you see. Changing Elevation Type changes your results.

### Map Type

The available list depends on the installation's configuration. A typical Metabunk install
offers ESRI World Imagery (the default), ESRI World Hillshade, World Topo Map and Shaded Relief;
MapBox; Open Streetmap; MapTiler; EOX; USGS Topographic, Imagery and Shaded Relief; the Naval
Research Laboratory WMS layers; Black Marble city lights; and daily MODIS and VIIRS true-color
mosaics. A few built-in types are always present as well: Blue Marble (No Clouds), Wireframe,
Flat Shading, Ocean Surface, Elevation Pseudo-Color and some debug views.

The daily mosaics are useful for a specific reason: they let you see roughly what the ground
cover actually looked like on the date of the event — snow, flooding, fires.

### Elevation Type

| Source | Native datum | Effective resolution |
|---|---|---|
| **AWS Terrarium** (the Metabunk default) | mixed — SRTM (EGM96), 3DEP (NAVD88), GMTED, ETOPO1 | ~3.7 m posts at 40° N at full zoom |
| **National Map 3DEP GeoTIFF** (US only) | NAVD88 | ~7.3 m posts |
| **Flat** | the WGS84 ellipsoid | no relief — the default when an install configures no elevation source |
| **Local** | as the stored tiles | elevation tiles stored with an offline install |

Two things the numbers do not tell you:

- Above the maximum zoom, tiles are **upsampled from their parent**. Zooming further in gives
  you a smoother picture, not better data.
- Terrarium is a mosaic. Its vertical datum is not uniform, and Sitrec applies a single EGM96
  correction to all of it. The result is approximate where the source datum is not EGM96.

Vertical accuracy depends on the source data, and that error goes directly into every AGL number.

---

## Which surface did that number come from?

The interface does not show which surface a number came from.

There are **four** surfaces in play:

1. **The WGS84 ellipsoid** — HAE = 0. "Flat" terrain is built here.
2. **The EGM96 geoid** — sea level. The ocean mesh sits here, and every terrain query is
   clamped *up* to it.
3. **The elevation model surface** — the DEM, i.e. `max(DEM, geoid)`.
4. **The rendered 3D-tile surface** — Google Photorealistic or Cesium geometry, which
   includes **buildings and trees** and is a different surface again.

When 3D buildings are on, the visible ground is (4), but many queries still use (3). Sitrec
resolves this by raycasting the loaded tile meshes, picking the hit nearest the elevation-map
ground, and **rejecting the tile answer entirely if the best hit is more than 40 m from it** —
a gate that exists because the tiles are natively ellipsoidal while the DEM is
geoid-corrected. A spot measurement over a single city block in Athens (recorded in the
source, `threeExt.js`) had the DEM about 12 m above the tile surface in most columns and up
to 6 m below it in a fifth of them — indicative of the scale of the disagreement rather than
a general figure.

**Things you place on the ground follow the visible surface.** A synthetic building snaps its
base to (4) while the 3D tiles are the rendered ground, and to (3) otherwise. No tile has
streamed in at the moment a saved sitch loads, so the first snap can only reach (3); the base
drops onto the tile surface as soon as the tileset settles, and re-snaps again each time you
toggle the tiles on or off. Measured under the synthetic buildings of an Arizona test site,
(3) sat 1.7-2.3 m **above** (4) — most of a small building's own height, which is why a base
left on the DEM visibly floats.

Also worth knowing: the fast ray-marcher used for long line-of-sight queries **never sees 3D
tiles at all**. It works against the elevation model only.

**Summary.** Under Google 3D tiles, different parts of the app can give up to three different
heights for the same point. Tip: compare an AGL number with a known reference — a building of
known height, a runway elevation.

---

## The sea

Sitrec's sea is the **geoid**, not HAE = 0. Terrarium encodes negative seafloor elevations
from global bathymetry, and Sitrec discards them: every ground query clamps to
`max(terrain, geoid)`, so over water the ground is sea level and depth is thrown away. Water
is detected as terrain within about 2 m of the geoid.

The separate **Ocean Surface (Beta)** mesh renders only when Google 3D tiles are active.

Note the asymmetry: "Flat" terrain is built at HAE = 0 (the ellipsoid), while the ocean mesh
is built at the geoid. Two surfaces both reasonably called "sea level", separated by the geoid
undulation — which is 20–40 m in the continental US.

---

## The controls

The top level of the Terrain menu holds the main controls. The rest are in the **Terrain
Tweaks** sub-folder, which is closed by default. Some controls show their internal property
names (`lat`, `lon`, `zoom`, `nTiles`, `elevationScale`) rather than a formatted label.

| Control | Where | Notes |
|---|---|---|
| **Map Type** / **Elevation Type** | top | See above |
| **`lat` / `lon` / `zoom` / `nTiles`** | top | Where the terrain square sits and how big it is. Lower zoom covers more ground per tile; `nTiles` (1–8) sets how many tiles across, so the two together decide the area |
| **Refresh** | top | Re-request the tiles. Use after a network glitch |
| **Zoom to track** | top | Move the terrain to the extents of the selected track over the sitch's frames |
| **3D Buildings** | top | Cesium Ion or Google tiles. Turning this on forces the ellipsoid Earth model, because the tiles are true-ECEF, and forces Dynamic Subdivision on |
| **Buildings Source** | top | Which provider supplies the 3D building tiles |
| **Ocean Surface (Beta)** | top | Sea-level water surface under Google 3D tiles |
| **Debug Grids** | Tweaks | Green = ground texture tiles, blue = elevation tiles. Shows which tiles are loaded |
| **`elevationScale`** | Tweaks | **Visual only — see the warning below** |
| **Terrain Opacity** | Tweaks | Useful for seeing tracks that pass underground |
| **Dynamic Subdivision** | Tweaks | Camera-adaptive tiling for globe-scale viewing. With it off, you can drag the terrain square with `T` held. Cannot be turned off while 3D Buildings is on |
| **Building Edges** / **Tile Edges** | Tweaks | Wireframe edges on the 3D building tiles |
| **Building Material** / **Building Flat Colour** | Tweaks | Photo, Flat or Half-photo shading for the building tiles, and the color used for Flat. Applies to newly loaded tiles |
| **Use Ellipsoid Earth Model** | Tweaks | Sphere (fast, legacy) or the WGS84 ellipsoid. Forced on while 3D Buildings is on. See [GIS](GIS.md) |
| **`textureDetail` / `elevationDetail`**, **Disable Dynamic Subdivision** | Tweaks | Subdivision multipliers (1 is normal) and a level-of-detail freeze. **Local development builds only** — not present on the public site |

Three more sub-folders sit at the bottom of the menu:

- **Remove Geometry** (Google 3D tiles only) — **Manual Remove** paints over the tiles to snap
  geometry down to the ground or delete it (**Edit Action**), with **Brush Radius (m)**,
  **Apply Edits** and **Restore Geometry**. The **Automatic Tree Removal** sub-folder
  (**Flatten Trees**, plus its tuning parameters) detects and flattens trees automatically.
- **Paint On Ground** — **Paint Mode** paints a color (**Paint Color**, **Brush Radius (m)**)
  onto the ground imagery and the 3D tiles; **Apply Paint** turns the saved strokes on and off.
  Works with any map type and needs no API key.
- **Street View Pano** — fetch a Google Street View panorama at a location (or at the camera)
  and show it as a background sphere, with heading, elevation and opacity adjustments. Not
  available in serverless builds.

Geometry edits and paint strokes save with the sitch.

> ### Elevation Scale is for looking, not measuring
>
> Exaggerating the relief with `elevationScale` is a good way to see subtle terrain. But the scale factor is applied
> to the *whole* elevation value, including the geoid correction baked into it — so with the
> scale at 2, sea level itself moves by the geoid undulation (about 35 m in Los Angeles), and
> the clamp that is supposed to hold the sea flat fires at the wrong height. The 3D-tile
> surface is not scaled at all, so the 40 m gate above starts rejecting genuine ground.
>
> **Set it back to 1 before taking any measurement.**

---

## Settings that change elevation without looking like they do

- **The graphics quality preset** (Sitrec → Settings → Performance Preset) caps the maximum
  elevation zoom. On the lowest preset that is roughly 150 m posts. Switching preset for
  frame rate silently changes every ground elevation, every AGL readout and every terrain
  intersection.

---

## Common problems

| Symptom | Likely cause |
|---|---|
| Object is underground | An altitude datum mismatch, not a terrain problem. See [GIS](GIS.md) |
| Ground height changed when nothing else did | Quality preset changed the elevation zoom cap |
| AGL disagrees with what you can see | Under 3D tiles, the visible surface includes buildings and trees; the query may have used the bare-earth DEM |
| Terrain never loads | Network — try Refresh; check Debug Grids to see which tiles are missing |
| Sea is not flat | Elevation Scale is not 1 |

---

## See also

- [GIS, Geodesy and Altitude](GIS.md) — datums, and recognising a datum error
- [Atmospheric Refraction](Refraction.md) — why distant terrain renders higher than geometry
- [Custom Terrain Sources](dev/CustomTerrainSources.md) — configuring your own elevation and
  imagery sources
