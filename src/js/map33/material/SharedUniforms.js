import {Matrix4, Vector3, Vector4} from "three";

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
    // coastline, so the colour test only passes in patches and the reflection
    // breaks into blotches. Beyond this the water mask fades out and the
    // reflection stops rather than degrading. 0 disables the fade.
    waterMaxTileSize: {value: 0.0},
    // ... other shared uniforms
};
