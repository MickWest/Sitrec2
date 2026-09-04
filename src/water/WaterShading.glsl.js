// WaterShading.glsl.js
//
// The water surface shading, as a GLSL chunk two materials share.
//
// It began life inside the terrain tile shader, which was the only place that
// could tell water from land: water is found by testing the map imagery, and
// only a terrain tile carries map imagery. Google Photorealistic 3D Tiles
// REPLACE the terrain — CNodeTerrainUI hides the whole quadtree while they are
// active — so with them on there was no terrain fragment left to shade and the
// sea reverted to Google's baked photograph of it.
//
// Nothing in the shading itself was terrain-specific, though. Every quantity it
// needs is either a shared uniform or derived from the fragment's world
// position: the surface normal is the GEODETIC UP plus the analytic wave slope,
// never the mesh normal, and the reflection lookup projects the world position
// through the mirror camera's matrix. So the body moved here unchanged, and the
// tiles material (DayNightStandardMaterial) now calls the same function with a
// water mask of its own — see WaterMaskGeo.js for where that mask comes from.
//
// The split is at exactly the point where the two callers stop agreeing:
//
//   THE CALLER decides HOW MUCH WATER is at this fragment (0..1) — the terrain
//   from its per-tile mask or the OSM color test, the 3D tiles from a
//   geographic mask plus a height band around the water plane.
//
//   THIS CHUNK decides WHAT WATER LOOKS LIKE there, and is identical for both.
//
// Include order in a fragment shader: waterUniformsGLSL, then oceanBRDFChunk
// (the Ocean method's microfacet BRDF), then waterShadeGLSL. The function also
// reads three's built-in cameraPosition and Sitrec's earthCenter uniform, both
// of which every caller already declares.

import {oceanBRDFChunk} from "../ocean/OceanBRDF.glsl.js";

/**
 * Uniform declarations for everything sitrecWaterShade() reads.
 *
 * The per-tile mask uniforms (waterMaskMap, hasWaterMask, tileWaterAllowed,
 * waterMaxTileSize) are deliberately NOT here: they belong to the terrain's own
 * way of finding water, not to the shading, and the tiles material has no use
 * for them.
 */
export const waterUniformsGLSL = /* glsl */ `
uniform float waterReflection;
uniform float waterNightFactor;
uniform vec3 waterDayColor;
uniform samplerCube waterSkyCube;
uniform samplerCube waterOcclusionCube;
uniform float waterOcclusion;
uniform float waterStrength;
uniform float waterDarken;
uniform float waterWaveStrength;
uniform float waterWaveLength;
uniform float waterWaveTime;
uniform vec3 waterWaveOrigin;
uniform float waterUpSquash;
uniform vec4 waterOrthoDir;

uniform float waterMirror;
uniform sampler2D waterMirrorMap;
uniform mat4 waterMirrorMatrix;
uniform vec3 waterMirrorOrigin;
uniform float waterMirrorDistance;

uniform float waterOcean;
uniform vec2 waterSigma2;
uniform vec2 waterWindDir;
uniform vec3 waterUpwelling;
uniform float waterIrradiance;
uniform float waterWhitecap;
uniform vec3 waterSunDir;
uniform vec3 waterSunRadiance;
uniform float waterSunSolidAngle;
uniform float waterSunRadius;
uniform vec3 waterMoonDir;
uniform vec3 waterMoonRadiance;
uniform float waterMoonSolidAngle;
uniform float waterMoonRadius;
uniform float waterPixelAngle;
uniform float waterGlitterExposure;
uniform vec3 waterSkyZenith;
uniform vec3 waterSkyHorizon;
uniform float waterMirrorFov;
uniform float waterGustiness;
uniform float waterGustScale;
uniform sampler2D waterWaveData;
uniform float waterWaveCount;
uniform float waterWaveTexels;
uniform vec2 waterResidualSigma2;
uniform float waterDebug;
`;

/**
 * The shading itself, plus the ocean BRDF it depends on.
 *
 * sitrecWaterShade(baseRGB, waterMask, worldPos)
 *   baseRGB    the fragment's colour so far, in LINEAR radiance — not sRGB.
 *              Both callers convert before calling and the reflection is added
 *              as radiance, so a caller working in sRGB would add light in the
 *              wrong space and clip the Moon to the value of a bright star.
 *   waterMask  0..1, how much of this fragment is water. Also the blend weight,
 *              so a fractional shoreline texel gets a fractional reflection.
 *   worldPos   ECEF world position of the fragment.
 *
 * Returns the shaded colour. Callers guard with `if (waterMask > 0.0)`.
 */
export const waterShadeGLSL = /* glsl */ `
${oceanBRDFChunk}

vec3 sitrecWaterShade(vec3 baseRGB, float waterMask, vec3 worldPos) {
    vec3 outRGB = baseRGB;
    // Pull the flat map fill down towards what water really
    // looks like, so the reflection carries the surface
    // instead of being washed out by map blue. By day that
    // target is deep-water dark blue; by night it goes to
    // black, where only reflected light remains.
    vec3 waterBase = sRGBTransferEOTF(vec4(waterDayColor, 1.0)).rgb
                   * (1.0 - waterNightFactor);
    outRGB = mix(outRGB, waterBase, waterDarken * waterMask);

    // Geodetic up, not the geocentric radial: on WGS84 they
    // differ by up to 0.19deg, which would tilt the whole
    // reflected sky by twice that. waterUpSquash is (a/b)^2
    // for the active earth model (1.0 when it's a sphere).
    vec3 fromCenter = worldPos - earthCenter;
    vec3 up = normalize(vec3(fromCenter.x, fromCenter.y, fromCenter.z * waterUpSquash));

    // Pole-safe tangent basis for the wave field.
    vec3 ref = abs(up.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 east = normalize(cross(ref, up));
    vec3 north = cross(up, east);

    // Wave phase from a nearby origin — see waterWaveOrigin.
    vec3 wp = worldPos - waterWaveOrigin;
    float e = dot(wp, east);
    float n = dot(wp, north);
    float k = 6.2831853 / max(waterWaveLength, 0.1);
    float t = waterWaveTime;

    // Three octaves of directional ripples, differentiated
    // analytically to get the surface slope directly.
    float p1 = e * k + t;
    float p2 = (e * 0.6 + n * 0.8) * k * 1.7 - t * 1.3;
    float p3 = (n * 0.6 - e * 0.8) * k * 2.9 + t * 0.7;
    float slopeE = k * cos(p1)
                 + k * 1.7 * 0.6 * 0.5 * cos(p2)
                 - k * 2.9 * 0.8 * 0.25 * cos(p3);
    float slopeN = k * 1.7 * 0.8 * 0.5 * cos(p2)
                 + k * 2.9 * 0.6 * 0.25 * cos(p3);

    vec3 waveNormal = normalize(up + (slopeE * east + slopeN * north) * waterWaveStrength);

    // Orthographic cameras have no eye point, so the ray is
    // the constant view direction rather than a difference.
    vec3 viewDir = waterOrthoDir.w > 0.5
        ? normalize(waterOrthoDir.xyz)
        : normalize(worldPos - cameraPosition);

    vec3 reflected = reflect(viewDir, waveNormal);

    // Schlick Fresnel for water (F0 = 0.02): almost a
    // mirror at grazing angles, nearly nothing straight down.
    float cosTheta = max(dot(-viewDir, waveNormal), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

    if (waterOcean > 0.0) {
        // OCEAN (SPECTRAL) MODE.
        //
        // The other two methods perturb a normal and look up
        // what is along the reflected ray. That is right only
        // while a pixel is smaller than a wave. Past a few
        // kilometres one pixel spans thousands of waves, there
        // is no meaningful normal left, and averaging them gives
        // a flat one — which is why the sea goes glassy at range
        // in both other modes, and why the fix cannot be "more
        // ripple strength".
        //
        // Here the surface is a slope DISTRIBUTION instead, and
        // the shading is an integral over it: a microfacet BRDF
        // whose roughness is the mean square slope of the part of
        // the wave spectrum this pixel cannot resolve. The
        // variance comes from Cox & Munk's sun-glitter
        // measurements by way of the Elfouhaily spectrum, so the
        // wind speed control is a physical input, not a look
        // knob. See src/ocean/OceanSpectrum.js.

        // Wind-aligned tangent axes. Built per fragment from the
        // geodetic up, because over a sea wide enough to see the
        // horizon "east" has rotated appreciably from one side of
        // the view to the other.
        vec3 windX = normalize(east * waterWindDir.x + north * waterWindDir.y);
        vec3 windY = cross(up, windX);

        vec3 toEye = -viewDir;
        float cosView = dot(toEye, up);

        if (cosView > 1e-3) {
            // Starting point if there is no wave field loaded:
            // the whole spectrum as roughness, nothing resolved.
            vec2 sigma2 = waterSigma2;

            // Gustiness: patches of rougher and smoother water,
            // streaked along the wind. Relative to the wave origin
            // so the noise coordinate stays in metres — float32
            // cannot resolve a 300 m feature at ECEF magnitudes.
            vec3 gustOffset = worldPos - waterWaveOrigin;
            vec2 windCoords = vec2(dot(gustOffset, windX),
                                   dot(gustOffset, windY));
            float gust = oceanGustiness(windCoords, waterGustiness,
                                        waterWaveTime, waterGustScale);

            // The patch of sea this pixel covers. It is an ELLIPSE:
            // across the view a pixel spans dist*pixelAngle, but
            // along the view that is divided by the sine of the
            // depression angle, which at grazing incidence makes it
            // tens of times longer. Looking across a lake from 38 m
            // up the ratio reaches 53:1 by two kilometres.
            //
            // Both axes are kept, and each wave is tested against
            // the one that matters for its own direction of travel.
            // Collapsing this to the long axis stops the ripples
            // dead at a visible line a few hundred metres out.
            //
            // NOT from fwidth(worldPos): float32 quantises
            // ECEF to about 0.4 m, so its derivative is noise
            // rather than a footprint.
            float fragDistance = length(worldPos - cameraPosition);
            float footprintAcross = fragDistance * waterPixelAngle;
            float footprintAlong = footprintAcross / max(cosView, 0.002);

            // Along-view direction, flattened into the surface and
            // expressed in the wind frame the wavevectors use.
            vec3 viewFlat = viewDir - up * dot(viewDir, up);
            vec2 viewAxis = vec2(dot(viewFlat, windX), dot(viewFlat, windY));
            viewAxis = length(viewAxis) > 1e-6
                ? normalize(viewAxis) : vec2(1.0, 0.0);

            // Resolved waves, and the variance of everything this
            // pixel is too far away to resolve. The two are exact
            // complements — see oceanWaveSurface.
            vec3 oceanNormal = up;
            if (waterWaveCount > 0.0) {
                OceanSurface surface = oceanWaveSurface(
                    waterWaveData, waterWaveCount, waterWaveTexels,
                    windCoords, waterWaveTime,
                    footprintAlong, footprintAcross, viewAxis);
                // The trains' own unresolved part PLUS the band
                // they never covered. Assigning only the first
                // throws away about two fifths of the roughness.
                sigma2 = (surface.residualVariance
                        + waterResidualSigma2) * gust;
                oceanNormal = normalize(up
                    - windX * surface.slope.x
                    - windY * surface.slope.y);
            } else {
                sigma2 *= gust;
            }

            // --- reflected environment -------------------------
            // Sample the mirror render target through the width of
            // the reflection lobe, then weight it by the
            // DIRECTIONAL reflectance rather than by a point BRDF
            // value: the environment has already been integrated
            // over solid angle by the filtering, so multiplying by
            // a quantity per steradian again would be a category
            // error.
            vec3 reflectedDir = reflect(viewDir, oceanNormal);

            // How wide the reflection lobe is, in render-target
            // pixels. A slope deviation turns the reflected ray by
            // twice as much, and the target resolves
            // waterPixelAngle per pixel.
            float lobePixels = oceanLobeAngle(sigma2)
                             / max(waterPixelAngle, 1e-6);
            float lod = log2(max(lobePixels, 1.0));

            // THE RENDER TARGET CAN ONLY SUPPLY PART OF THE LOBE.
            // At any real sea state the reflection lobe is
            // comparable to a whole camera field of view — about
            // 14 degrees at 5 m/s of wind, against this view's 13 —
            // so most of the light this surface reflects arrives
            // from directions that were never rendered.
            //
            // Treating that as all-or-nothing gets it wrong both
            // ways: keep the render target and the "reflection"
            // becomes the average of the frame, drop it and the
            // sea stops reflecting the island next to it. So use it
            // for the FRACTION of the lobe it covers, and let the
            // sky supply the rest. At a glassy surface the fraction
            // goes to one and the reflection sharpens; in a fresh
            // breeze it falls away and the sea turns to sky.
            float lobeCoverage = clamp(
                waterMirrorFov / max(2.0 * oceanLobeAngle(sigma2), 1e-4),
                0.0, 1.0);
            // Never blur wider than the render itself: past that the
            // sample stops being a reflection and becomes the mean
            // of the frame.
            lod = min(lod, log2(max(waterMirrorFov / max(waterPixelAngle, 1e-6), 4.0)) - 1.0);
            float mirrorWeight = lobeCoverage;

            vec3 environment = oceanSkyRadiance(
                reflectedDir, up, waterSkyZenith, waterSkyHorizon,
                oceanLobeAngle(sigma2));
            if (mirrorWeight > 0.0) {
                vec4 mirrorClip = waterMirrorMatrix * vec4(
                    (worldPos - waterMirrorOrigin)
                        + reflectedDir * waterMirrorDistance, 1.0);
                if (mirrorClip.w > 0.0) {
                    vec2 muv = mirrorClip.xy / mirrorClip.w;
                    // Fade ACROSS the edge, and fade towards the
                    // sky rather than towards black. Fading to
                    // nothing — which the mirror method does —
                    // deletes energy and leaves a dark seam
                    // exactly where the water is brightest.
                    vec2 edge = smoothstep(vec2(0.0), vec2(0.04), muv)
                              * (1.0 - smoothstep(vec2(0.96), vec2(1.0), muv));
                    float inside = edge.x * edge.y;
                    // Bias rather than an explicit level:
                    // texture2D's bias form is core GLSL ES 1.00,
                    // whereas explicit-LOD sampling in a fragment
                    // shader needs an extension that is not
                    // available on every path this material
                    // compiles for.
                    vec3 mirrorEnv = texture2D(
                        waterMirrorMap, clamp(muv, 0.0, 1.0), lod).rgb;
                    environment = mix(environment, mirrorEnv,
                                      inside * mirrorWeight);
                }
            }

            // Fresnel, shadowing and the glitter geometry are all
            // measured against the LOCAL surface — the resolved
            // waves tilt it, and the unresolved ones are the
            // roughness about it. That split is the whole scheme:
            // waves big enough to see become geometry, waves too
            // small to see become a BRDF, and which is which
            // depends on how far away this pixel is.
            float reflectance = oceanEnvironmentReflectance(
                toEye, oceanNormal, sigma2, 1.34);

            vec3 oceanRadiance = environment * reflectance;

            // --- Sun and Moon glitter, analytic ----------------
            // Never sampled from the render target: at half a
            // degree the discs are a handful of pixels there, and
            // the blur just applied would erase them. The glitter
            // path is the most recognisable feature of real water,
            // so it is reintroduced as a quantity.
            vec3 glitter = vec3(0.0);
            if (dot(waterSunRadiance, waterSunRadiance) > 0.0) {
                glitter += oceanSourceGlitter(
                    toEye, waterSunDir, oceanNormal, windX, windY, sigma2,
                    waterSunRadiance, waterSunSolidAngle,
                    waterSunRadius, 1.34);
            }
            if (dot(waterMoonRadiance, waterMoonRadiance) > 0.0) {
                glitter += oceanSourceGlitter(
                    toEye, waterMoonDir, oceanNormal, windX, windY, sigma2,
                    waterMoonRadiance, waterMoonSolidAngle,
                    waterMoonRadius, 1.34);
            }
            // A specular highlight off the solar disc is orders of
            // magnitude brighter than the sky, so what sets the
            // apparent LENGTH of a glitter path in any photograph
            // is where it crosses saturation. Physics alone would
            // give a clipped white wedge; the shoulder restores
            // the roll-off a sensor provides.
            glitter = glitter * waterGlitterExposure;
            glitter = glitter / (1.0 + glitter);
            oceanRadiance += glitter;

            // --- water-leaving radiance ------------------------
            // The blue of the sea is light that went into it and
            // came back out. Without this the surface is grey
            // glass, however good the reflection is. The
            // reflectance already includes the air-water interface
            // transmission, so it must not be multiplied by
            // (1 - Fresnel) again.
            oceanRadiance += waterUpwelling * waterIrradiance
                           * (1.0 - reflectance);

            // --- whitecaps -------------------------------------
            oceanRadiance += vec3(waterWhitecap * 0.22
                           * waterIrradiance * 0.31830989);

            if (waterDebug > 0.5) {
                // False color, replacing the water entirely so a
                // dark night scene cannot hide the signal.
                vec3 probe = vec3(0.0);
                if (waterDebug < 1.5) {
                    probe = vec3(gust * 0.5);
                } else if (waterDebug < 2.5) {
                    probe = vec3(abs(oceanNormal - up) * 40.0);
                } else if (waterDebug < 3.5) {
                    probe = vec3(sigma2.x, sigma2.y, 0.0) * 20.0;
                } else {
                    probe = vec3(mirrorWeight, 1.0 - mirrorWeight, 0.0);
                }
                outRGB = mix(outRGB, probe, waterMask);
            } else {
                outRGB += oceanRadiance
                                 * (waterMask * waterStrength);
            }
        }
    } else if (waterMirror > 0.0) {
        // PLANAR MIRROR MODE. The whole world has been
        // re-rendered from a camera mirrored through the
        // lake's plane, so the answer to "what is along this
        // reflected ray" is already in a texture — the only
        // question is where in it.
        //
        // For a fragment exactly on the mirror plane with an
        // unperturbed normal, the mirror camera's ray THROUGH
        // THAT FRAGMENT is the reflected ray, so projecting
        // the fragment itself gives the exact lookup, and any
        // point along the ray gives the same answer.
        //
        // Waves break that: the reflected ray tilts away from
        // the mirror camera's ray. Walking waterMirrorDistance
        // along the TILTED ray and projecting that point picks
        // the mirror ray that meets ours at that distance —
        // exact if the reflected scenery really is that far
        // away, and gracefully wrong otherwise. It costs one
        // matrix multiply and gets the perspective for free:
        // near water ripples strongly, water near the horizon
        // barely moves, which is what real water does. A flat
        // screen-space offset would do the opposite.
        //
        // The same term quietly absorbs part of the Earth's
        // curvature: 'up' here is the geodetic up AT THIS
        // FRAGMENT, which tilts away from the plane normal by
        // (distance / earthRadius) as the lake recedes.
        // Relative to waterMirrorOrigin, never raw ECEF —
        // the matrix has the origin's translation already
        // folded in on the CPU in double precision, because
        // doing that cancellation here in float32 costs
        // metres of accuracy. Same reason waterWaveOrigin
        // exists for the wave phase above.
        vec4 mirrorClip = waterMirrorMatrix * vec4(
            (worldPos - waterMirrorOrigin)
                + reflected * waterMirrorDistance, 1.0);
        if (mirrorClip.w > 0.0) {
            vec2 muv = mirrorClip.xy / mirrorClip.w;
            // Ripples can push the lookup off the edge of the
            // render, where there is no information. Fade out
            // instead of clamping, which would smear the edge
            // pixel into a streak.
            vec2 fade = smoothstep(vec2(0.0), vec2(0.03), muv)
                      * (1.0 - smoothstep(vec2(0.97), vec2(1.0), muv));
            vec3 mirrorColor = texture2D(waterMirrorMap, clamp(muv, 0.0, 1.0)).rgb;
            outRGB += mirrorColor
                * (waterMask * fresnel * waterStrength * fade.x * fade.y);
        }
    } else if (dot(reflected, up) > 0.0) {
        // SKY CUBE MODE. Only sample the sky hemisphere — a
        // ray bent below the horizon by a steep wave would
        // otherwise pick up the (black) ground half of the
        // cube and punch holes.
        vec3 sky = textureCube(waterSkyCube, reflected).rgb;

        // Mask out sky the terrain is standing in front of.
        // The silhouette is captured from the observer, so
        // this is exact underfoot and approximate for the
        // far side of the lake — but it is the difference
        // between reflecting a star and reflecting a star
        // that is behind a hill. Bilinear filtering of the
        // mask softens the ridge line for free.
        if (waterOcclusion > 0.0) {
            float visible = textureCube(waterOcclusionCube, reflected).r;
            sky *= mix(1.0, visible, waterOcclusion);
        }

        // The cube already carries the right sources for the
        // time of day — stars and moon at night, the Sun's
        // disc when it is up — so no day/night term here.
        outRGB += sky * (waterMask * fresnel * waterStrength);
    }

    return outRGB;
}
`;
