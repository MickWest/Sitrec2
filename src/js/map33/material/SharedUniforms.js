import {Matrix4, Vector2, Vector3, Vector4} from "three";

// shared uniforms used by multiple materials in Sitrec
export const sharedUniforms = {
    nearPlane: {value: 0.1},
    farPlane: {value: 1000},
    cameraFocalLength: {value: 300},
    useDayNight: {value: true},
    sunGlobalTotal: {value: 1.0},
    sunAmbientIntensity: {value: 0.5},
    sunNightAmbientIntensity: {value: 0.5},
    showBuildingEdges: {value: false},
    showTileEdges: {value: false},

    // Water Reflection (CNodeWaterReflection). Scoped ON only around the
    // look view's GlobalScene render, so mainView never sees a reflection.
    // waterReflection is the master gate (0 = off); waterNightFactor is
    // separate so the effect can run by day (sun glitter on dark blue water)
    // as well as by night (stars and moonglade on near-black water).
    waterReflection: {value: 0.0},
    waterNightFactor: {value: 0.0},
    // What daytime water attenuates towards, in sRGB. Deep water is dark blue,
    // not the flat pale fill the map paints it.
    waterDayColor: {value: new Vector3(0.06, 0.13, 0.20)},
    waterSkyCube: {value: null},
    // Terrain silhouette from the observer: 1 = open sky, 0 = blocked. Without
    // it the lake reflects stars that are behind a hillside.
    waterOcclusionCube: {value: null},
    waterOcclusion: {value: 0.0},
    waterColor: {value: new Vector3(170 / 255, 211 / 255, 223 / 255)},
    waterTolerance: {value: 0.10},
    waterStrength: {value: 1.0},
    waterDarken: {value: 0.9},
    waterWaveStrength: {value: 0.02},
    waterWaveLength: {value: 30.0},
    waterWaveTime: {value: 0.0},
    // Wave phase origin, subtracted from vWorldPosition before the sine sum.
    // ECEF coordinates are ~6.4e6 m, which in float32 leaves no precision for
    // a 30 m wavelength; subtracting a nearby origin brings them back to
    // metres-scale where sin() still means something.
    waterWaveOrigin: {value: new Vector3()},
    // (a/b)^2 for the current earth model — turns the geocentric radial into
    // the geodetic up used as the water surface normal. 1.0 for a sphere.
    waterUpSquash: {value: 1.0},
    // xyz = view direction for an orthographic camera, w = 1 to use it.
    waterOrthoDir: {value: new Vector4(0, 0, 0, 0)},

    // Planar Mirror mode (CWaterPlanarMirror). An alternative to the sky cube
    // above: the whole world is re-rendered from a camera mirrored through the
    // lake's plane, and the water samples THAT instead of a celestial cube, so
    // hills, buildings and objects appear in the reflection too. waterMirror is
    // the gate; the two are mutually exclusive.
    waterMirror: {value: 0.0},
    waterMirrorMap: {value: null},
    // biasMatrix * mirrorProjection * mirrorView. Projecting a world point with
    // this gives where that point landed in the mirror render, which is exactly
    // what the water needs to look up — see the shader for why this beats
    // sampling by raw screen coordinate.
    waterMirrorMatrix: {value: new Matrix4()},
    // The matrix above expects positions RELATIVE TO this point, not raw ECEF:
    // cancelling a 6.4e6 m translation in float32 leaves metres of error on a
    // lookup that must be pixel-accurate.
    waterMirrorOrigin: {value: new Vector3()},
    // How far along the reflected ray the reflected scenery is ASSUMED to be.
    // Only affects how far ripples displace the image; see the shader.
    waterMirrorDistance: {value: 1500.0},
    // Width in metres of the largest terrain tile whose map texture is still
    // trusted to say "this is water". Distant water is drawn by very coarse
    // tiles — bounding radii run from 11 km to 7800 km at Santa Monica — whose
    // single 512px texture smears the flat OSM water fill together with the
    // coastline, so the color test only passes in patches and the reflection
    // breaks into blotches. Beyond this the water mask fades out and the
    // reflection stops rather than degrading. 0 disables the fade.
    waterMaxTileSize: {value: 0.0},

    // Water on the 3D TILES (Google Photorealistic), which replace the terrain
    // rather than sit on it — so with them on there is no terrain fragment left
    // for the block above to shade, and the sea reverts to Google's baked
    // photograph. These four say where the water is for a fragment that has no
    // map texture and no tile UV to look one up by. See WaterMaskGeo.js and the
    // water branch in DayNightStandardMaterial.
    //
    // waterGeoActive is the gate, raised by CNodeWaterReflection.push() only
    // while the look view renders and only while the tiles are what is drawing
    // the ground. Like every other water uniform it is shared BY REFERENCE with
    // every material, so pop() lowering it is what keeps mainView clean.
    waterGeoActive: {value: 0.0},
    // Coverage mask over a square of ground, indexed by the fragment's own
    // latitude and longitude rather than by any UV.
    waterGeoMask: {value: null},
    // The square that mask covers, in normalised Web Mercator:
    // (u0, v0, 1/side, unused). Reciprocal because the shader divides by it.
    waterGeoRect: {value: new Vector4(0, 0, 1, 0)},

    // The water plane, as a plane — a point on it and its normal, in ECEF.
    // The terrain path never needed this (a terrain fragment is water because
    // the map says so, wherever it happens to sit), but a photogrammetric mesh
    // has the pier deck, the boats and the hillside behind the beach all inside
    // the same patch of "water" on the map, and height above the sea is what
    // separates them. Also written in cube mode, where there is no mirror.
    waterPlaneOrigin: {value: new Vector3()},
    waterPlaneNormal: {value: new Vector3(0, 0, 1)},
    // Metres either side of the sea surface a tile fragment may sit and still
    // shade as water — it has to absorb the photogrammetry's own noise, which
    // measures a few metres over open water at Santa Monica.
    waterPlaneBand: {value: 4.0},
    // Earth radius for the sagitta term that bends the flat plane above back
    // onto the curved sea: at 12 km the sea has already dropped 11 m below its
    // own tangent plane, which a metres-wide height band would otherwise reject.
    waterPlaneRadius: {value: 6378137.0},

    // Ocean (spectral) mode (CNodeWaterReflection + src/ocean). A third method,
    // which differs from the two above in kind rather than in degree: instead of
    // perturbing a normal and looking up a mirror image, it treats the surface as
    // a slope DISTRIBUTION and shades it with a microfacet BRDF. That is the only
    // way distant water can be right, because past a few kilometres a single pixel
    // covers thousands of waves and there is no meaningful normal left to sample —
    // which is exactly why the other two methods go glassy at range.
    waterOcean: {value: 0.0},
    // Slope variance (along-wind, cross-wind), the quantity Cox & Munk measured
    // from sun-glitter photographs. Beckmann roughness would be sigma*sqrt(2);
    // this is the variance itself. Split in two because a real sea is measurably
    // more rutted along the wind than across it, and that anisotropy is visible in
    // the shape of a glitter path.
    waterSigma2: {value: new Vector2(0.01, 0.008)},
    // Wind direction as (east, north) in the local tangent frame. The wind-aligned
    // axes are built from this per fragment, since "east" rotates over a sea large
    // enough to see the curvature of.
    waterWindDir: {value: new Vector2(1, 0)},
    // Remote-sensing reflectance of the water body itself (Lee's relation, see
    // OceanSpectrum.waterLeavingReflectance). Without this term daylight water is
    // grey glass: the blue of the sea is light that went INTO it and came back.
    waterUpwelling: {value: new Vector3(0.0001, 0.0011, 0.0072)},
    // Downwelling irradiance in renderer units, driving both the upwelling term
    // and the whitecaps.
    waterIrradiance: {value: 0.0},
    // Fractional whitecap coverage from the wind, and the effective reflectance of
    // foam in the visible.
    waterWhitecap: {value: 0.0},
    // Sun and Moon as finite discs. Direction is world-space TOWARDS the body;
    // radiance is in renderer units, derived from the scene light intensity divided
    // by the solid angle, so no invented photometry enters the shader. These are
    // fed to an ANALYTIC glitter term rather than sampled from the reflection
    // render target, because a half-degree disc occupies a few pixels there and the
    // blur a rough surface applies would erase it — and that blurred-away disc is
    // the single most recognisable thing about real water.
    waterSunDir: {value: new Vector3(0, 0, 1)},
    waterSunRadiance: {value: new Vector3()},
    waterSunSolidAngle: {value: 6.8e-5},
    waterSunRadius: {value: 4.65e-3},
    // The Moon does not drive Sitrec's directional light — at night its intensity is
    // zero — so unlike the Sun there is no scene light to read a radiance from.
    //
    // The obvious substitute, sampling the Moon out of the sky cube, does NOT work,
    // and the reason is worth recording because it looks like it should. A rough
    // surface spreads a source's light over the whole reflection lobe, so the glade is
    // fainter than the source by roughly solidAngle/(8*pi*sigma^2) — about 1e-4 here,
    // which is correct, and matches the real ratio between the Moon's disc and a
    // moonlit sea. But the RENDERED Moon is not thousands of times brighter than the
    // rendered sea: it is clipped to about 1.0 like everything else on screen. Feeding
    // a display value into an energy relationship therefore lands the glade four
    // orders of magnitude too dark, which is exactly what it did.
    //
    // So the magnitude is reconstructed the same way the Sun's is: irradiance the body
    // delivers to the scene, divided by the solid angle it covers.
    waterMoonDir: {value: new Vector3(0, 0, 1)},
    waterMoonRadiance: {value: new Vector3()},
    waterMoonSolidAngle: {value: 6.4e-5},
    waterMoonRadius: {value: 4.52e-3},
    // Radians per pixel of the view being rendered, for the footprint that decides
    // how much of the wave spectrum this pixel can resolve.
    waterPixelAngle: {value: 0.001},
    // Exposure shoulder on the glitter term. Physically the specular reflection of
    // the solar disc is thousands of times brighter than the sky, so what sets the
    // APPARENT size of a glitter path in any real photograph is where it crosses
    // the sensor's saturation, not the width of the slope distribution. Without a
    // soft shoulder the physics renders either a clipped white wedge or nothing.
    waterGlitterExposure: {value: 1.0},
    // Sky radiance for the part of the reflection lobe the mirror render target
    // cannot cover. At any real sea state the lobe is TENS OF DEGREES wide — wider
    // than the look view's whole field of view — so most of the light the surface
    // reflects arrives from directions that were never rendered. Sampling ever
    // coarser mips of the render target for those is not an approximation, it is
    // just the average of the frame; and fading to nothing at the edge, which the
    // mirror method does, deletes the energy instead. Both give a flat sea.
    //
    // A single sky radiance is a crude sky model, but it is the RIGHT crude model:
    // with it, the surface radiance is F(theta)*G(theta)*L_sky, and the strong
    // brightening towards the horizon comes from the Fresnel and shadowing terms
    // rather than from any gradient in the sky itself.
    // Two-point sky for the reflection: zenith and horizon radiance, linear. Taken
    // from the same model the view draws its own sky and haze with, so the water
    // cannot disagree with the sky above it. The gradient between them is not a
    // decoration — it is what makes surface roughness visible at all, since with a
    // uniform sky every patch of water reflects the same radiance however rough it is.
    waterSkyZenith: {value: new Vector3(0.3, 0.4, 0.55)},
    waterSkyHorizon: {value: new Vector3(0.55, 0.62, 0.7)},
    // Vertical field of view of the mirror render, radians. The reflection lobe of a
    // real sea is comparable to or wider than a whole camera field of view, so the
    // render target can only ever supply PART of the light the surface reflects. This
    // is how the shader knows what fraction — the rest comes from the sky term.
    waterMirrorFov: {value: 1.0},
    // Strength of the gustiness patterning, 0 to 1. Real wind over water is gusty
    // and Langmuir circulation organises it into streaks, so a real sea is patchy on
    // scales of hundreds of metres. Without it a physically exact surface still reads
    // as a painted sheet, because every square metre of it is equally rough.
    waterGustiness: {value: 0.5},
    // Along-wind size of a gust patch, metres. Scales with the wind: Langmuir
    // circulation and gust cells grow with the wind that drives them, so light air
    // gives cat's-paws tens of metres across and a gale gives streaks hundreds of
    // metres long. A fixed size leaves a lake view sitting inside one cell.
    waterGustScale: {value: 300.0},
    // The resolved wave field: one travelling wave train per texel, packed as
    // (kx, ky, amplitude, phase) with the wavevector in the wind-aligned frame.
    // Sampled from the same spectrum that produced the slope variance above, so the
    // resolved waves and the statistical roughness are two halves of one model rather
    // than two models that happen to sit next to each other.
    waterWaveData: {value: null},
    waterWaveCount: {value: 0.0},
    waterWaveTexels: {value: 1.0},
    // Slope variance the wave trains do NOT represent: everything shorter than the
    // finest train and longer than the longest. It is roughly 39% of the total at
    // 5 m/s, because most of a sea's slope variance lives in centimetre ripples that
    // no camera in these scenes is close enough to resolve.
    //
    // It must be ADDED to whatever the trains leave unresolved, not replaced by it.
    // Dropping it silently removes about two fifths of the sea's roughness at every
    // distance, which makes far water too glossy and the glitter path too narrow —
    // the exact symptom this whole method exists to cure.
    waterResidualSigma2: {value: new Vector2()},
    // Debug visualisation for the ocean method, false-colored into the water:
    // 0 off, 1 gustiness multiplier, 2 resolved-wave slope, 3 unresolved roughness,
    // 4 mirror-vs-sky blend. Diagnosing a surface whose whole job is to look smooth is
    // otherwise guesswork — several real defects here were invisible until the
    // intermediate quantity was put on screen.
    waterDebug: {value: 0.0},
    // ... other shared uniforms
};
