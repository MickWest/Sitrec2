# Handoff: celestial frame fix → main (Star Tracker impact)

Branch `moon`, three commits. **Merges cleanly into main** as of `85759fe4`
(verified with `git merge-tree --write-tree main moon`, no conflicts — main's
star-tracker commits `4489aab9` / `78965daa` touch the `CameraLens` import in
`StarTrackerUI.js`, not the lines changed here).

| commit | what |
|---|---|
| `47185a0d` | Precession on the celestial sphere; annual aberration on stars |
| `c9317dc9` | Satellite refraction bends about the geodetic vertical |
| `e8293023` | …and that vertical tracks the selectable earth model |

Delete this file after the merge lands.

---

## 1. The bug, in one paragraph

The night sky was drawn from J2000/ICRS (EQJ) coordinates but rotated onto the
Earth by `Rz(-GMST)` alone. GMST is referred to the mean equinox **of date**, so
pairing it with J2000 coordinates omitted precession entirely. The whole sky —
stars, Sun, Moon, planets, grid, constellation lines — sat rigidly rotated
against the terrain by the precession accumulated since 2000: ~50″/yr, reaching
**22.3′ (0.37°) by mid-2026**. It survived for years because the sky stayed
*self-consistent* — stars agreed with planets — so only sky-vs-**terrain**
alignment exposed it.

`CelestialMath.getEQJToECEFMatrix(date)` = `Rz(-GAST) · Rotation_EQJ_EQD(t)` is
now the single EQJ→ECEF transform, used by the celestial sphere, the day sphere,
`getCelestialDirectionFromRaDec`, the refraction zenith, and the star chart.

---

## 2. What this means for the Star Tracker — read this part

### 2.1 The blind solve is unaffected

`StarIdentify.js` maps pixels → **catalog** RA/Dec by quad geometric hashing.
That is a star-to-star process in the catalog frame and does not touch the
Earth-fixed frame at all. Nothing about the plate solve, the quad index,
verification, or the reported field centre/roll/rms changes.

**Do not "fix" `StarIdentify.js` to apply aberration or precession.** It would be
wrong: the quads must match the catalog as stored.

### 2.2 What did change: `CNodeControllerStarTrack.apply()`

`src/starTrack/StarTrackerUI.js` — the *only* star-tracker change:

```js
// was: getCelestialDirectionFromRaDec(...)
const fwd      = getStarDirectionECEF(pose.centre.raDeg * D2R, pose.centre.decDeg * D2R, date);
const aboveDir = getStarDirectionECEF(pose.above.raDeg  * D2R, pose.above.decDeg  * D2R, date);
```

The solve produces **catalog** RA/Dec. Recovering where the camera was actually
pointing needs the **apparent** direction — precession/nutation into the frame of
date (now in the matrix) plus annual aberration (≤20.5″). `getStarDirectionECEF()`
does both and is the single entry point for anything star-specific.

### 2.3 Previously published Sync-Camera results are wrong by ~22′

Every "Sync Camera to Star Field" azimuth solved for a 2020s photograph before
this fix carries the full frame error. The magnitude is ~22′ in 2026; how it
splits between azimuth and altitude depends on the **hour**, because the error
rotation is about the ecliptic pole — at Copenhagen at 20:06 UTC that pole sits
11.2° from the zenith, so it read as ~21.9′ azimuth / ~4.3′ altitude; at 09:00
UTC the same 22.3′ would read as ~18.9′ altitude / ~11.9′ azimuth.

If any solved pointing has been published or written into a saved sitch, it needs
re-deriving. This is the main reason to merge deliberately rather than quietly.

### 2.4 The three rules that are easy to break

1. **Body positions keep `ofdate=false`.** The precession lives in the group
   matrix; asking astronomy-engine for of-date coordinates *as well* applies it
   twice. `CNodeStarChartView.js` has a comment at the planet call saying so —
   it replaced an older comment that documented the bug as intended behaviour.
2. **The refraction zenith must be the exact inverse** (`getECEFToEQJMatrix`).
   Substituting GAST for GMST in `zenithEQJFromLatLon` looks right and is not —
   it leaves the bend axis 22′ off and reintroduces several arcmin of altitude
   error. `zenithECIFromLatLonGMST` was renamed to `zenithEQJFromLatLon` and now
   takes that inverse matrix explicitly, so the old call signature cannot survive
   a merge silently.
3. **Aberration is catalog-stars-only.** Sun/planets from
   `Astronomy.Equator(…, aberration=true)` arrive already aberrated; running it
   again double-counts. `tests/celestialFrame.test.js` has a guard for this.

---

## 3. Also in these commits

- **Annual aberration on stars** (up to 20.5″, previously not applied at all).
  Implemented as a shared uniform + GLSL chunk (`ABERRATION_VERTEX_GLSL`) rather
  than baked into positions — the star cloud is ~118k points and would otherwise
  re-upload on every time change. CPU consumers use `applyAnnualAberration()` /
  `getStarDirectionECEF()`.
  Deliberately **not** applied to the 3D constellation lines or equatorial grid:
  the grid is a coordinate reference, and 20″ between a line and its stars is
  well under the line width at any FOV those are drawn at.
- **Satellite refraction** bends about the geodetic vertical, not the geocentric
  radial (up to 11.55′ apart; ~1.25′ of satellite altitude error at 0.5°
  elevation). `zenithECEFFromPosition()` takes the earth radii as parameters so
  it tracks `Sit.useEllipsoid` — with the legacy spherical model it collapses
  exactly to the radial, which is correct for that model.
- **`ThirdPartyNotices.txt`**: the render catalog was credited to the Yale BSC5.
  It is not — it is a 117,955-entry Hipparcos/ICRS repack at epoch J1991.25,
  despite the `bsc` in the filename. Now credited to ESA, with the Yale entry
  scoped to `data/nightsky/BSC5.bin`, which still ships.

---

## 4. Verifying after the merge

```bash
npm run build
npx jest tests/celestialFrame.test.js tests/refraction.test.js   # 14 + 43 tests
npx jest tests/                                                   # full suite
```

`tests/celestialFrame.test.js` checks the transform against astronomy-engine's
independent `Horizon()` solve — sub-arcsecond for Moon/Sun/Mars/Jupiter at four
epochs from 2000 to 2035 — and includes a test that reproduces the old bare
`Rz(-GMST)` path and asserts it is 21–24′ wrong, so a future "simplification"
back to a sidereal spin fails with the reason attached.

**Visual regression** (`npm run test-fast`) — read `reference_fast_regression_harness`
notes first, and note two traps hit while doing this work:

- `tests_regression/fast-regression/baseline/` is **gitignored**, so a fresh
  worktree has none and a plain run silently *creates* them instead of comparing.
  Check `ls -lT baseline/` mtimes before believing a green result.
- Establish a noise floor before attributing anything: on unmodified code the
  pre-existing failures were `planes_Nashville` (byte-identical 6192px diff on
  untouched code) and `Rocket Launch Example`, with `Google 3d tiles shadow test`
  and `wind arrow test` intermittent (`wind arrow` is animation-phase vs settle
  time — ~60% diff between a 16s and a 3s settle, nothing to do with any code).

Expect ~14 sitches to shift. Every diff should be confined to sky bands and dark
pixels — stars, Sun/Moon disks, sky labels. Terrain, tracks, LOS lines, video
overlays and UI must be untouched. The Sun moving 22′ produces no visible terrain
shading change.

---

## 5. Still outstanding

**Stellar proper motion.** `data/nightsky/sitrec_bsc_lite.bin` is Hipparcos/ICRS
at epoch **J1991.25** with `mprop=0` — no proper-motion columns in the file and no
generator script in the repo. Applying it needs a regenerated data file
(22 → 30 byte records, 2.6 → 3.5 MB) plus matching treatment in `StarIdentify.js`,
which parses the catalog independently.

Residual as of 2026 (measured over 8,404 naked-eye stars in `BSC5.bin`, which does
carry PM): median **1.17″**, 90th pct 5.09″, 99th pct 22.5″, worst star **234″**.
About 14 naked-eye stars are already more than an arcminute out of place. For the
plate solve this is scatter rather than bias, so it matters far less than the 22′
frame error did — but a fast-moving star can be an outlier in a fit.

Remaining budget after that, ranked: near-horizon refraction model quality
(arcminutes, irreducible without a temperature profile), DUT1 (~5″), diurnal
aberration (0.2″), polar motion (0.3″), the omitted T² term in `getSiderealTime`
(0.09″).
