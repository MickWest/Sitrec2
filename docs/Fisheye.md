# Fisheye (Allsky) Projection

Sitrec normally renders the look view as a pinhole camera — the same
rectilinear projection as a telephoto lens, where straight lines stay
straight. A pinhole cannot represent a field of view of 180° or more, and it
becomes badly distorted long before that. Real all-sky cameras — the fisheye
cameras that watch the whole sky for meteors and satellites — use lenses with
a completely different radial mapping, and matching their footage needs that
mapping in the renderer.

**Camera → FOV (Zoom) → Fisheye** switches the look view to a true fisheye
projection, with fields of view up to and beyond 180°. Stars, satellites,
planets, tracks and terrain all render through the fisheye, and the night-sky
name labels follow.

## Controls

- **Fisheye Lens** — enable the fisheye projection for the look view. The
  normal Zoom / VFOV sliders are ignored while this is on; the field of view
  comes from **Fisheye FOV** below, and the scroll wheel (or pinch, or the
  keyboard zoom) in the look view adjusts that instead of the normal FOV.
- **Projection** — the lens's radial mapping r(θ): how far from the image
  centre a ray θ degrees off-axis lands.
  - *Equidistant* (r = fθ): image radius proportional to angle. Common for
    scientific all-sky lenses.
  - *Equisolid-angle* (r = 2f·sin(θ/2)): equal areas of sky get equal areas of
    image. Most cheap board-camera fisheyes (the usual allsky hardware) are
    close to this or equidistant.
  - *Stereographic* (r = 2f·tan(θ/2)): preserves shapes locally; fields
    approaching 360° stay usable.
  - *Orthographic* (r = f·sin(θ)): compresses strongly toward the edge; caps
    at 180°.
  - *Rectilinear* (r = f·tan(θ)): the pinhole itself, included as a sanity
    check — at the same FOV it matches the normal render exactly.

  These are the same lens models Star Track uses for its camera calibration,
  so a lens fitted there tells you which projection to pick here.
- **Fisheye FOV °** — the full field of view across the image circle's
  *diameter*. 180 puts the horizon exactly on the circle's edge for a camera
  pointing straight up. Values past 180 image sky (or ground) *behind* the
  camera plane. Many allsky cameras stop a little short of the horizon —
  if the real image's circle edge is above the horizon, use less than 180.
- **Circle Size %** — the image circle's diameter as a percentage of the view
  height. 100 fits the circle exactly top-to-bottom. A 16:9 allsky frame
  usually *crops* the circle's top and bottom — the STLS/D'Antonio frame is
  about 155.
- **Center X % / Center Y %** — offset of the image circle's centre from the
  frame centre, in percent of view height (both axes use height units, so
  equal numbers are equal pixels). Real allsky sensors are rarely perfectly
  centred behind the lens.
- **Roll °** — rotate the fisheye image about its centre, matching a camera
  that was not mounted north-aligned. This is an image-plane rotation,
  independent of the camera's own orientation controls.
- **Show Image Circle** — mask everything outside the image circle to black,
  like the unexposed border of a real allsky frame. Turn it off to see the
  sky beyond the configured FOV (out to the projection's own limit).
- **Point Straight Up (Allsky)** — aim the look camera at the zenith in the
  allsky convention: **north at the top, east on the LEFT**. East and west
  are mirrored compared to a map because the camera looks *up*, not down —
  lie on your back with your head toward north and east is on your left.
  Use **Roll** afterwards to match a camera that was not north-aligned.

## Matching an allsky video

1. Load the video and set the camera location and time as usual.
2. Press **Point Straight Up (Allsky)**, enable **Fisheye Lens**.
3. Set **Circle Size %** so the rendered circle matches the video's image
   circle (155 for a circle whose diameter is 1.55× the frame height), and
   the Center offsets if the video's circle is off-centre.
4. Pick the star pattern up with Night Sky star names / constellation lines,
   and adjust **Roll** until the cardinal directions line up.
5. Fine-tune **Fisheye FOV** and the **Projection** type until stars match
   from the centre all the way to the edge. If the centre matches but the
   edge drifts, it is the projection type (or the FOV) that is wrong —
   different lens curves agree on-axis and diverge toward the rim.

## Limitations

- Geometry is still projected per-vertex, so a *line* spanning tens of
  degrees (constellation stick figures, the equatorial grid) draws as a
  straight chord rather than the gentle curve a real fisheye would show.
  Star and satellite *positions* are exact.
- Mouse picking and a few HUD overlays still use the pinhole projection, so
  clicking in a fisheye view may not land where expected. The night-sky name
  labels are fisheye-aware.
- Terrain tile selection still uses the pinhole field of view, so ground
  detail near the edges of a very wide field may load at reduced resolution.
- Fisheye and the Flat Earth scenario are not supported together.
