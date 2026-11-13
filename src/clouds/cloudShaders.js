// cloudShaders.js - GLSL for the volumetric cloud layers.
//
// One fragment program, compiled twice:
//
// - The MARCH (CLOUD_MRT defined) renders into a per-camera target at the
//   quality's resolution (half or quarter of the view's pixels per axis). Per
//   pixel it builds the displayed view ray, finds where it crosses each layer's
//   shell (camera-relative, stable quadratic, see CloudMath.js), sorts the
//   crossings front to back, ray-marches each volume segment (or shades each
//   sheet crossing), and writes premultiplied color + alpha, and in a second
//   target the distance to the first visible cloud. The opaque depth from
//   SoftDepth (read at one full-resolution pixel of each march pixel) is the far
//   limit. Haze is applied per segment at its mean scattering distance with the
//   same integral the terrain uses.
//
// - The SCENE material draws in the world scene. With cloudComposite on it
//   upsamples the march target to the full resolution, weighting the four
//   nearest march pixels by how well their opaque depth matches this pixel's,
//   so a cloud never bleeds onto a nearer ridge. With it off (full resolution,
//   or no readable depth) it runs the march itself, directly.
//
// Units: lengths in meters, extinction in 1/m, radiance linear (the view
// tone-maps later). Every position is camera-relative and ECEF-oriented.

import {ATMOSPHERE_PROJECTION_GLSL} from "../atmosphere/AtmosphereProjection";
import {ATMOSPHERE_HAZE_GLSL, MATERIAL_ATMOSPHERE_UNIFORMS_GLSL} from "../atmosphere/MaterialAtmosphere";
import {WEATHER_SIZE} from "./CloudNoise";

export const CLOUD_MAX_LAYERS = 4;
export const CLOUD_MAX_STEPS = 256;
export const CLOUD_MAX_SKIP_STEPS = 512;
export const CLOUD_MAX_LIGHT_STEPS = 6;

// Distances to the first visible cloud are stored in kilometers (a half float
// holds 65504); this value means "no cloud on this ray".
export const CLOUD_NO_FRONT_KM = 65000;

// The alpha a ray must collect before its cloud counts as "in front".
export const CLOUD_FRONT_ALPHA = 0.03;

// The key light that multiple scattering carries through a cloud, relative to
// the phase-weighted single scattering (tuned against reference photographs: a
// thin cumulus base about half as bright as its sunlit top).
export const CLOUD_DIFFUSE_WEIGHT = 0.06;

// The mean density, as a share of the layer's extinction, assumed in the cloud
// over a point when its sky light is shaded (calibrated so the quality levels,
// which once sampled it, give the same tone).
export const CLOUD_SKY_SHADE_DENSITY = 0.6;

export const CLOUD_VERTEX_SHADER = /* glsl */`
    varying vec2 vNdc;
    void main() {
        vNdc = position.xy;
        // Just inside the far plane: with depth testing on (the fallback when
        // the opaque depth cannot be read) only the sky passes.
        gl_Position = vec4(position.xy, 0.99999, 1.0);
    }
`;

export const CLOUD_FRAGMENT_SHADER = /* glsl */`
    precision highp float;
    precision highp sampler3D;

    #define MAX_LAYERS ${CLOUD_MAX_LAYERS}
    #define MAX_SEGMENTS ${CLOUD_MAX_LAYERS * 2}
    #define MAX_ITERATIONS ${CLOUD_MAX_STEPS + CLOUD_MAX_SKIP_STEPS}
    #define MAX_LIGHT_STEPS ${CLOUD_MAX_LIGHT_STEPS}
    #define NO_FRONT_KM ${CLOUD_NO_FRONT_KM.toFixed(1)}
    #define FRONT_ALPHA ${CLOUD_FRONT_ALPHA}
    #define PI 3.14159265359
    #define WEATHER_TEXELS ${WEATHER_SIZE.toFixed(1)}
    // Density (x the layer's extinction) assumed over a point for its sky shading.
    #define CLOUD_SKY_SHADE_DENSITY ${CLOUD_SKY_SHADE_DENSITY.toFixed(3)}
    // Weight of the diffusely transmitted key light (CLOUD_DIFFUSE_WEIGHT).
    #define CLOUD_DIFFUSE ${CLOUD_DIFFUSE_WEIGHT.toFixed(4)}

    varying vec2 vNdc;

    #ifdef CLOUD_MRT
        // The march target's second texture: distance to the first visible cloud (km).
        layout(location = 1) out highp vec4 cloudFrontOut;
        // The scene material gets these from SoftDepth; the march declares them itself
        // (the uniform objects are shared, so both read the same capture).
        uniform bool softDepthEnabled;
        uniform sampler2D softSceneDepth;
        uniform vec2 softDepthSize;
        uniform float softDepthLogFar;
        uniform float softDepthOrthoRange;
    #endif

    ${ATMOSPHERE_PROJECTION_GLSL}
    ${MATERIAL_ATMOSPHERE_UNIFORMS_GLSL}
    // The clouds' own airlight (dimmer than the terrain's at night, see CloudVolumeMaterial.js).
    uniform float cloudAirlightScale;
    #define ATMOSPHERE_AIRLIGHT_SCALE cloudAirlightScale
    ${ATMOSPHERE_HAZE_GLSL}

    uniform mat3 cloudViewToWorld;
    uniform vec3 cloudUp;          // geodetic up at the camera
    uniform float cloudR;          // local sphere radius (Gaussian radius at the camera)
    uniform float cloudR0;         // R + camera height
    uniform float cloudH0;         // camera height above the local sphere
    uniform float cloudGroundRadius; // sphere radius of the ground cap (refraction makes it larger)
    uniform float cloudCEarth;     // shell constant of the ground cap
    uniform float cloudNear;
    uniform float cloudTMax;
    uniform vec3 cloudSunDir;      // the key light: the sun, or the moon at night
    uniform float cloudSunIntensity;
    uniform float cloudSunGain;
    uniform vec3 cloudAmbientTop;
    uniform vec3 cloudAmbientBottom;
    uniform int cloudLayerCount;
    uniform int cloudSteps;
    uniform int cloudSkipSteps;
    uniform int cloudLightSteps;
    uniform int cloudDetailLevel;  // 0 no detail texture, 1 near-surface detail, 2 also in the first light sample
    uniform float cloudLodBias;    // added to the noise mip level (coarser reads are cheaper)
    uniform int cloudDebug;        // 1: show the work per pixel (red: march samples / 128, green: light samples / 256)
    int debugSamples = 0;
    int debugLight = 0;
    // The column state of the last full density sample, which the light march reuses.
    bool reuseColumn = false;
    float cachedCoverage = 0.0;
    float cachedPresence = 0.0;
    float cachedMask = 1.0;
    // The dome top (height fraction) of the column at the last density sample.
    float lastTop = 1.0;
    // The last density sample before its fine detail (0 outside the billowed shape).
    float lastSmooth = 0.0;
    // The last sample's distance below the carved surface, in profile units.
    float lastGap = 0.0;
    // The large lumps (0..1) at the last density sample that read the shape.
    float lastLumps = 0.5;
    uniform float cloudFineStep;
    uniform float cloudOpticalStep;
    uniform float cloudPixelAngle; // radians per march pixel (perspective)
    uniform float cloudPixelSize;  // meters per march pixel (orthographic)
    uniform bool cloudRefraction;
    uniform sampler3D cloudShapeTex;
    uniform sampler3D cloudDetailTex;
    uniform sampler3D cloudWeatherTex;
    uniform sampler2D cloudBlueNoise;
    uniform float cloudJitterOffset;
    uniform vec2 cloudMarchSize;   // pixels of the target the march renders into
    uniform bool cloudComposite;
    uniform sampler2D cloudMarchColor;
    uniform sampler2D cloudMarchFront;

    uniform vec4 cloudShell[MAX_LAYERS];      // c(base) or c(mid) for a sheet, c(top), base altitude, thickness
    uniform vec4 cloudParams[MAX_LAYERS];     // coverage, extinction (1/m), detail, render (0 volume, 1 sheet)
    uniform vec4 cloudGradient[MAX_LAYERS];   // four-point height gradient
    uniform vec4 cloudShapeInfo[MAX_LAYERS];  // domed, anvil, sheet pattern, sheet optical depth
    uniform vec4 cloudWind[MAX_LAYERS];       // wind direction (unit), skew distance at the top (m)
    uniform vec4 cloudDisc[MAX_LAYERS];       // disc center relative to the camera, radius (0 = global)
    uniform vec4 cloudDiscUp[MAX_LAYERS];     // up at the disc center, feather
    uniform vec4 cloudCoverageA[MAX_LAYERS];  // noise offset (camera - wind) mod period, 1 / period
    uniform vec4 cloudCoverageB[MAX_LAYERS];
    uniform vec4 cloudShapeA[MAX_LAYERS];
    uniform vec4 cloudDetailA[MAX_LAYERS];
    uniform vec4 cloudLayerExtra[MAX_LAYERS]; // stretch along the wind, unused, sphere radius (m)

    // The width of the pixel being marched at the current sample (m). The 3D
    // noise is read from the mip level whose texels match it: no shimmer, and
    // far samples stay in the texture cache. (Explicit levels: a march loop has
    // no usable screen derivatives.)
    float sampleFootprint = 1.0;
    float textureLodFor(float texelsPerMeter) {
        return max(0.0, log2(max(sampleFootprint * texelsPerMeter, 1e-6)) + cloudLodBias);
    }

    // The weather (coverage) texture read with C1 (smoothstep) interpolation
    // between texels. The coverage is amplified several times on its way to the
    // density and the dome height, and plain trilinear interpolation has creases
    // along every texel plane: amplified, they showed as straight tone edges on a
    // cloud's base. Same single read; only the coordinate changes. (Mip levels
    // above 0 are far away, where the creases are below a pixel.)
    vec4 weatherSample(vec3 coord, float lod) {
        if (lod > 0.5) return textureLod(cloudWeatherTex, coord, lod);
        vec3 p = coord * WEATHER_TEXELS + 0.5;
        vec3 cell = floor(p);
        vec3 f = p - cell;
        f = f * f * (3.0 - 2.0 * f);
        return textureLod(cloudWeatherTex, (cell + f - 0.5) / WEATHER_TEXELS, 0.0);
    }

    float remap01(float value, float low, float high) {
        return (value - low) / max(high - low, 1e-5);
    }

    // Per-pixel jitter of the march: blue noise (fine, even grain that the
    // upsample blurs away), shifted per whole frame so a paused frame is stable.
    float marchJitter() {
        float noise = texelFetch(cloudBlueNoise, ivec2(gl_FragCoord.xy) & 63, 0).r;
        return fract(noise + cloudJitterOffset);
    }

    float henyeyGreenstein(float cosTheta, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
    }

    // Forward lobe for the silver lining, weak back lobe for the backscatter.
    float cloudPhase(float cosTheta, float scale) {
        return 0.7 * henyeyGreenstein(cosTheta, 0.8 * scale) + 0.3 * henyeyGreenstein(cosTheta, -0.2 * scale);
    }

    // Height above a sphere of radius R at distance t (rationalized: no Earth-sized difference).
    float heightAt(float t, float b, float cE, float radius) {
        float numerator = cE + 2.0 * b * t + t * t;
        return numerator / (sqrt(radius * radius + numerator) + radius);
    }

    // The ray constants for a sphere of the given radius, centered below the
    // camera: a shell at height H is crossed where t^2 + 2 b t + cH + cOffset = 0,
    // and cE = c(0) + cOffset gives heightAt. With terrestrial refraction a layer
    // uses a larger sphere, which bends its shells down exactly as the scene's
    // lift bends the terrain up (CloudMath.refractedRadius).
    void rayConstants(float radius, vec3 origin, vec3 dir, out float b, out float cOffset, out float cE) {
        float r0 = radius + cloudH0;
        b = r0 * dot(dir, cloudUp) + dot(origin, dir);
        cOffset = 2.0 * r0 * dot(origin, cloudUp) + dot(origin, origin);
        cE = cloudH0 * (2.0 * radius + cloudH0) + cOffset;
    }

    // Roots of t^2 + 2 b t + c = 0 by the stable form. False when the ray misses.
    bool shellRoots(float b, float c, out float tNear, out float tFar) {
        float discriminant = b * b - c;
        if (discriminant < 0.0) return false;
        float root = sqrt(discriminant);
        float q = -(b + (b >= 0.0 ? root : -root));
        if (abs(q) < 1e-6) { tNear = 0.0; tFar = 0.0; return true; }
        float first = q, second = c / q;
        tNear = min(first, second);
        tFar = max(first, second);
        return true;
    }

    // The full-resolution depth pixel that a march pixel reads (the same one the
    // composite reads back for it).
    ivec2 cloudDepthPixel(vec2 marchPixel) {
        vec2 full = (marchPixel + 0.5) * softDepthSize / cloudMarchSize;
        return clamp(ivec2(full), ivec2(0), ivec2(softDepthSize) - 1);
    }

    // Distance along the view ray to the opaque scene at a depth pixel (log depth,
    // see SoftDepth.js); 1e9 for the sky.
    float sceneDistance(ivec2 depthPixel, vec3 viewDir) {
        float depth = texelFetch(softSceneDepth, depthPixel, 0).r;
        if (depth >= 1.0) return 1e9;
        if (softDepthOrthoRange > 0.0) return depth * softDepthOrthoRange + cloudNear;
        float w = exp2(depth * softDepthLogFar) - 1.0;
        return atmoFishOn ? w : w / max(-viewDir.z, 1e-4);
    }

    // The light reaching a point at height h whose key-light elevation has sine
    // sinE: the scene's own brightness curve (CNodeSunlight), measured from the
    // point's own horizon (so high clouds stay lit after sunset at the ground),
    // tinted by the air the light crossed (Rayleigh + aerosol, Kasten-Young air
    // mass), relative to a high sun. Zero in the Earth's shadow.
    vec3 sunColorAt(float sinE, float h) {
        float dip = sqrt(max(2.0 * max(h, 0.0) / cloudR, 0.0));
        float elevation = asin(clamp(sinE, -1.0, 1.0)) + dip;
        float degreesUp = degrees(elevation);
        float bright;
        if (degreesUp < -0.5) return vec3(0.0);
        if (degreesUp < 0.0) bright = 0.25 * (0.5 + degreesUp) / 0.5;
        else if (degreesUp > 10.0) bright = 1.0;
        else bright = 0.25 + 0.75 * cos(elevation) * (degreesUp / 10.0) * (degreesUp / 10.0);
        float up = max(degreesUp, 0.0);
        float airMass = 1.0 / (sin(radians(up)) + 0.50572 * pow(up + 6.07995, -1.6364));
        vec3 rayleigh = vec3(0.058, 0.135, 0.331);
        vec3 tau = rayleigh * exp(-max(h, 0.0) / 8000.0) + 0.04 * exp(-max(h, 0.0) / 1500.0);
        vec3 tint = exp(-(tau * airMass - (rayleigh + 0.04) * 1.15));
        tint /= max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
        tint = min(tint, vec3(4.0));
        return tint * bright;
    }

    // Disc extent mask (1 inside, 0 outside, feathered), and its distance from the
    // center. The distance is wobbled by large billows, so a storm cell's outline
    // bulges in lobes instead of being a smooth cylinder.
    float discMask(int layer, vec3 p, float radiusScale, out float distanceM) {
        vec4 disc = cloudDisc[layer];
        distanceM = 0.0;
        if (disc.w <= 0.0) return 1.0;
        vec4 discUp = cloudDiscUp[layer];
        vec3 v = p - disc.xyz;
        vec3 horizontal = v - discUp.xyz * dot(v, discUp.xyz);
        vec4 shapeA = cloudShapeA[layer];
        // (Only whole multiples of a period are safe here: the offset wraps at one period.)
        float lobes = textureLod(cloudShapeTex, (shapeA.xyz + p) * shapeA.w, textureLodFor(128.0 * shapeA.w)).g;
        distanceM = length(horizontal) * (1.0 + 0.6 * (0.5 - lobes));
        float radius = disc.w * radiusScale;
        return 1.0 - smoothstep(max(radius - discUp.w, 0.0), radius, distanceM);
    }

    // How strongly the layer covers this column (0 = clear), from the equalized
    // weather texture sampled on the base shell. presence runs linearly from 0 at
    // the edge of a cloudy patch to 1 at its middle; it shapes the domes.
    float layerCoverage(int layer, vec3 ps, float hf, float thickness, out float presence) {
        vec4 params = cloudParams[layer];
        vec3 pc = ps - cloudUp * (hf * thickness);
        vec4 coverageA = cloudCoverageA[layer];
        vec4 coverageB = cloudCoverageB[layer];
        float primary = weatherSample((coverageA.xyz + pc) * coverageA.w, textureLodFor(WEATHER_TEXELS * coverageA.w)).r;
        float edge = 1.0 - params.x;
        // An overcast layer is a continuous deck, not a pattern with holes.
        float overcast = smoothstep(0.85, 1.0, params.x);
        // The second octave moves the coverage by at most 0.15: far below the
        // edge the column is clear without reading it.
        presence = 0.0;
        if (primary + 0.15 <= edge && overcast <= 0.0) return 0.0;
        float secondary = weatherSample((coverageB.xyz + pc) * coverageB.w, textureLodFor(WEATHER_TEXELS * coverageB.w)).g;
        float weather = clamp(primary + (secondary - 0.5) * 0.3, 0.0, 1.0);
        presence = clamp((weather - edge) / max(params.x, 1e-3), 0.0, 1.0);
        presence = max(presence, overcast * 0.85);
        return weather > edge ? clamp(presence * 1.6, 0.0, 1.0) : overcast;
    }

    // Extinction (1/m) of a volume layer at camera-relative point p with height
    // fraction hf. detailFade (0..1) scales the fine detail (it fades out with
    // distance, smoothly, so there is no ring where it stops). coverageOut is 0
    // where the whole column is clear (two texture reads decide that), the
    // column's coverage (0..1) outside the smooth envelope, and 2 plus the
    // envelope's profile inside it.
    //
    // The shape, from large to small: the coverage pattern (cells of about the
    // layer's scale) times the height profile (a base that ramps in, a domed
    // top) gives a smooth envelope; large lumps (Perlin-Worley, 100-800 m at the
    // default scale) and round billows (inverted Worley at three scales, 50-800 m)
    // erode it deeply near its surface but never open its core; fine detail
    // (20-320 m) erodes only near the surface: wispy at the base, billowy above.
    float volumeDensity(int layer, vec3 p, float hf, float detailFade, float billowFade, out float coverageOut) {
        coverageOut = 0.0;
        lastSmooth = 0.0;
        lastGap = 0.0;
        if (hf < 0.0 || hf > 1.0) return 0.0;
        vec4 shell = cloudShell[layer];
        vec4 params = cloudParams[layer];
        vec4 info = cloudShapeInfo[layer];
        vec4 wind = cloudWind[layer];
        // Wind shear: the pattern at height hf is the base pattern moved downwind.
        vec3 ps = p - wind.xyz * (wind.w * hf);
        float presence, mask;
        float coverage;
        float anvil = info.y * smoothstep(0.68, 0.86, hf);
        if (reuseColumn) {
            // A light sample a short way from the last full sample: the column's
            // coverage (kilometer-sized cells) is the same, so skip its texture reads.
            coverage = cachedCoverage;
            presence = cachedPresence;
            mask = cachedMask;
        } else {
            coverage = layerCoverage(layer, ps, hf, shell.w, presence);
            float distanceM;
            mask = discMask(layer, ps, mix(1.0, 2.1, anvil), distanceM);
            if (info.y > 0.5 && cloudDisc[layer].w > 0.0) {
                // A storm cell: a solid core inside its disc, its anvil spreading at the top.
                float core = 1.0 - smoothstep(0.0, cloudDisc[layer].w * 0.75, distanceM);
                coverage = max(coverage, max(core, anvil));
                presence = max(presence, core);
            } else if (info.y > 0.5) {
                coverage = clamp(coverage + anvil * 0.5, 0.0, 1.0);
            }
            coverage *= mask;
            cachedCoverage = coverage;
            cachedPresence = presence;
            cachedMask = mask;
        }
        coverageOut = coverage;
        if (coverage <= 0.001) return 0.0;

        vec4 gradientPoints = cloudGradient[layer];
        // Domed types: tall where the coverage is strong, so each cell has a
        // rounded top over its flat base.
        float top = gradientPoints.w * mix(1.0, mix(0.3, 1.0, presence * mask), info.x);
        top = max(top, anvil);
        lastTop = top;
        if (hf >= top) return 0.0;
        float fadeStart = min(gradientPoints.z * top / max(gradientPoints.w, 1e-3), top - 0.02);

        vec4 shapeA = cloudShapeA[layer];
        vec4 shapeNoise = textureLod(cloudShapeTex, (shapeA.xyz + ps) * shapeA.w, textureLodFor(128.0 * shapeA.w));
        // A level base, but not a razor plane: the large lumps move it by a few
        // percent of the thickness (tens of meters), and its density ramps in.
        float baseShift = (shapeNoise.r - 0.75) * 0.08 * info.x;
        float gradient = smoothstep(gradientPoints.x, gradientPoints.y, hf - baseShift) * (1.0 - smoothstep(fadeStart, top, hf));
        gradient = max(gradient, anvil * (1.0 - smoothstep(0.93, 1.0, hf)));
        if (gradient <= 0.0) return 0.0;
        // Inside the smooth envelope: the march looks for the surface more closely here.
        coverageOut = 2.0 + coverage * gradient;

        // Each channel spread to about 0..1 over its 10th to 90th percentile.
        float lumps = clamp((shapeNoise.r - 0.55) * 2.8, 0.0, 1.0);
        lastLumps = lumps;
        // The smaller billows fade out where a pixel is wider than they are (no shimmer).
        float small = shapeNoise.b * 0.7 + shapeNoise.a * 0.3;
        float billows = clamp((mix(shapeNoise.g, shapeNoise.g * 0.5 + small * 0.5, billowFade) - 0.36) * 4.2, 0.0, 1.0);
        float shape = mix(lumps, billows, 0.6);
        // profile is 1 deep inside a cloud and falls to 0 at its smooth outline.
        // The noise is subtracted from it, so it carves lumps and billows into the
        // surface but never opens holes in a cloud's core.
        float profile = coverage * gradient;
        // Billows round the sides and the top; the base stays level (only its
        // fine detail is ragged), as a cumulus base is.
        float erosion = (1.0 - shape) * mix(0.85, mix(0.3, 0.85, smoothstep(0.04, 0.3, hf)), info.x);
        float base = clamp(remap01(profile, erosion, erosion + 0.25), 0.0, 1.0);
        lastSmooth = base;
        // How far below the carved surface this point is (0 at the surface): the
        // search takes longer steps where it is far from any cloud surface.
        lastGap = max(erosion - profile, 0.0);
        if (base <= 0.0) return 0.0;
        // Fine detail only near the surface: a solid core never reads it.
        float detailWeight = params.z * detailFade;
        if (cloudDetailLevel > 0 && detailWeight > 0.0 && base < 0.95) {
            vec4 detailA = cloudDetailA[layer];
            vec3 pd = (detailA.xyz + ps) * detailA.w;
            // Curl-like wisps: displace the detail lookup by the low shape channels.
            pd += (shapeNoise.gba - 0.5) * 0.35;
            vec4 detailNoise = textureLod(cloudDetailTex, pd, textureLodFor(32.0 * detailA.w));
            float detailFBM = clamp((detailNoise.r * 0.625 + detailNoise.g * 0.25 + detailNoise.b * 0.125 - 0.33) * 3.2, 0.0, 1.0);
            // Wispy at the base, billowy higher up, and strongest at the base.
            float lower = clamp(hf * 5.0, 0.0, 1.0);
            float erode = mix(detailFBM, 1.0 - detailFBM, lower);
            base = clamp(remap01(base, erode * detailWeight * mix(1.2, 0.8, lower), 1.0), 0.0, 1.0);
        }
        // Liquid water grows with height above the base: a thinner, lighter base.
        float heightDensity = mix(1.0, mix(0.4, 1.0, smoothstep(0.0, 0.5, hf)), info.x);
        return base * heightDensity * params.y;
    }

    // Optical depth toward the key light from a point, through its own layer:
    // exponentially spaced samples, then, if the last one is still inside cloud,
    // its density carried on to the layer top (so a thick cloud's base is darker
    // than a thin one's, with no extra texture reads).
    float sunOpticalDepth(int layer, vec3 p, float hf, float sunUp, float thickness, float detailFade, float billowFade) {
        float tau = 0.0;
        // Every quality level samples the same stretch toward the light (only more
        // or fewer samples along it), so the levels give the same mean shading.
        float reach = clamp(thickness * 0.4, 150.0, 1200.0);
        float stepLength = reach / (exp2(float(min(cloudLightSteps, MAX_LIGHT_STEPS))) - 1.0);
        float travelled = 0.0;
        float coverage;
        float last = 0.0, lastHf = hf;
        // (A storm's anvil changes the coverage with height: no reuse there.)
        reuseColumn = cloudShapeInfo[layer].y < 0.5;
        for (int index = 0; index < MAX_LIGHT_STEPS; index++) {
            if (index >= cloudLightSteps) break;
            float sampleAt = travelled + stepLength * 0.5;
            float sampleHf = hf + sampleAt * sunUp / thickness;
            if (sampleHf > 1.0 || sampleHf < 0.0) { last = 0.0; break; }
            // The detailed density only for the nearest sample, and only at the higher levels.
            float fade = index == 0 && cloudDetailLevel > 1 ? detailFade : 0.0;
            last = volumeDensity(layer, p + cloudSunDir * sampleAt, sampleHf, fade, billowFade, coverage);
            debugLight++;
            tau += last * stepLength;
            lastHf = sampleHf;
            travelled += stepLength;
            stepLength *= 2.0;
        }
        reuseColumn = false;
        // The rest of the way to the column's top, at part of the last density: a
        // thick cloud's base gets darker than a thin one's. (A low sun crosses the
        // column sideways, so the path is held to half a cell.)
        if (last > 0.0 && sunUp > 0.0) {
            float scale = 0.25 / max(cloudCoverageA[layer].w, 1e-9);
            tau += last * 0.6 * min(max(lastTop - lastHf, 0.0) * thickness / max(sunUp, 0.05), scale * 0.5);
        }
        return tau;
    }

    // Diffuse light that multiple scattering carries through cloud of optical
    // depth tau: the two-stream transmission 1 / (1 + 0.75 (1 - g) tau), g = 0.85.
    float diffuseTransmission(float tau) {
        return 1.0 / (1.0 + 0.1125 * tau);
    }

    // Composite one segment's premultiplied color with haze at its mean distance.
    void compositeSegment(vec3 segmentColor, float segmentT, float meanDistance, vec3 viewOrigin, vec3 viewDir,
                          inout vec3 color, inout float transmittance) {
        float alpha = 1.0 - segmentT;
        if (alpha > 1e-4) {
            vec3 viewPosition = viewOrigin + viewDir * meanDistance;
            segmentColor = atmosphereHaze(viewPosition, segmentColor / alpha) * alpha;
        }
        color += transmittance * segmentColor;
        transmittance *= segmentT;
    }

    // The sample point and its height fraction at distance t. With refraction
    // the point is moved down by the lift the scene gives that distance (the
    // straight view ray is the apparent path), so the cloud sits in the same
    // lifted world as the terrain. The lift is along the camera's zenith, as in
    // applyTerrestrialRefraction_chunk.
    vec3 samplePoint(float t, vec3 origin, vec3 dir, float b, float cE, float bL, float cEL, float radiusL,
                     float baseAltitude, float thickness, out float h, out float hf) {
        vec3 p = origin + dir * t;
        h = heightAt(t, bL, cEL, radiusL);
        hf = (h - baseAltitude) / thickness;
        if (cloudRefraction) p -= cloudUp * (heightAt(t, b, cE, cloudR) - h);
        return p;
    }

    // Fine detail and the smaller billows fade out as a pixel grows wider than
    // they are: they would only shimmer there, and skipping them is cheaper.
    float detailFadeAt(float footprint, float scale) {
        return 1.0 - smoothstep(scale * 0.006, scale * 0.018, footprint);
    }
    float billowFadeAt(float footprint, float scale) {
        return 1.0 - smoothstep(scale * 0.02, scale * 0.06, footprint);
    }

    void marchVolume(int layer, float tIn, float tOut, vec3 origin, vec3 dir, float b, float cE,
                     float cosTheta, float jitter, vec3 viewOrigin, vec3 viewDir,
                     inout vec3 color, inout float transmittance, inout float front,
                     inout int budget, inout int skipBudget) {
        vec4 shell = cloudShell[layer];
        float baseAltitude = shell.z, thickness = shell.w;
        float radiusL = cloudLayerExtra[layer].z;
        float bL, cOffsetL, cEL;
        rayConstants(radiusL, origin, dir, bL, cOffsetL, cEL);
        float scale = 0.25 / max(cloudCoverageA[layer].w, 1e-9);   // the layer's horizontal scale (m)
        // Steps grow with distance, as a pixel's footprint does, between a floor
        // that resolves the base and a ceiling below the billows' size.
        float minStep = max(thickness / 200.0, 3.0);
        float maxFine = max(minStep, min(thickness * 0.08, scale * 0.04));
        vec3 segmentColor = vec3(0.0);
        float segmentT = 1.0;
        float weightedDistance = 0.0, weightSum = 0.0;
        float phaseSun = cloudPhase(cosTheta, 1.0);
        float phaseSecond = cloudPhase(cosTheta, 0.5);
        float phaseThird = cloudPhase(cosTheta, 0.25);
        // false: searching for a cloud, true: inside one.
        bool inside = false;
        int emptySamples = 0;
        int insideSamples = 0;
        float tClear = tIn;   // the last point known to be outside every cloud
        float sigma = 0.0;    // extinction expected at the next step inside a cloud
        float h, hf, coverage;
        vec3 sunBase = vec3(-1.0), sunTop = vec3(0.0);
        // A jittered start no longer than the first search step (a camera inside the
        // layer starts at 0, where clouds can be a few meters away).
        float t = tIn + jitter * clamp(6.0 * (cloudPixelSize + tIn * cloudPixelAngle), minStep, scale * 0.04);
        for (int index = 0; index < MAX_ITERATIONS; index++) {
            if (t >= tOut || transmittance * segmentT < 0.02 || budget <= 0) break;
            debugSamples++;
            float footprint = cloudPixelSize + t * cloudPixelAngle;
            sampleFootprint = footprint;
            float fineStep = clamp(cloudFineStep * footprint, minStep, maxFine);
            float detailFade = detailFadeAt(footprint, scale);
            float billowFade = billowFadeAt(footprint, scale);
            if (!inside) {
                // The search finds the billowed shape without its fine detail, so
                // every pixel enters at the same smooth surface (fine wisps are not
                // skipped by some pixels and hit by others), and it costs less.
                vec3 p = samplePoint(t, origin, dir, b, cE, bL, cEL, radiusL, baseAltitude, thickness, h, hf);
                float density = volumeDensity(layer, p, hf, 0.0, billowFade, coverage);
                if (density <= 0.0) {
                    tClear = t;
                    if (coverage <= 0.001 && skipBudget > 0) {
                        // A clear column costs two texture reads: stride further there
                        // (cloud cells are rarely narrower than a tenth of the scale).
                        skipBudget--;
                        t += clamp(8.0 * footprint, scale * 0.08, scale * 0.16 + t * 0.01);
                    } else {
                        // Inside the envelope (coverage 2 and up) the surface is near:
                        // short steps; in a cloudy column above or below it, long ones.
                        budget--;
                        // (In the envelope the step grows with the depth below the carved
                        // surface: the profile changes over about half a cell.)
                        // Near the camera the steps shrink with the footprint, so a nearby
                        // cloud's edge is not skipped by some pixels and hit by others.
                        t += coverage >= 2.0
                            ? clamp(max(6.0 * footprint, lastGap * scale * 0.3), min(scale * 0.02, max(minStep, 2.0 * footprint)), scale * 0.08)
                            : clamp(10.0 * footprint, min(scale * 0.04, max(2.0 * minStep, 4.0 * footprint)), scale * 0.12);
                    }
                    continue;
                }
                // The ray entered a cloud between tClear and t: find the surface by
                // bisection, so every pixel starts at the surface and not at a
                // random depth below it (the cause of grain and stair steps).
                float near = tClear, far = t;
                for (int refine = 0; refine < 4; refine++) {
                    float middle = 0.5 * (near + far);
                    float hMiddle, hfMiddle;
                    vec3 pMiddle = samplePoint(middle, origin, dir, b, cE, bL, cEL, radiusL, baseAltitude, thickness, hMiddle, hfMiddle);
                    if (volumeDensity(layer, pMiddle, hfMiddle, 0.0, billowFade, coverage) > 0.0) far = middle;
                    else near = middle;
                }
                budget -= 3;
                sigma = density;
                t = near;
                inside = true;
                emptySamples = 0;
                insideSamples = 0;
                continue;
            }
            // Inside: steps short enough that each crosses at most cloudOpticalStep
            // of optical depth, sampled at their middle.
            budget--;
            // (Thin cloud takes longer steps, its light changes slowly; but not
            // just below the surface, where the light changes fastest.)
            float stepLength = sigma > 0.0
                ? clamp(cloudOpticalStep / sigma, 0.5 * minStep, insideSamples < 3 ? fineStep : maxFine) : fineStep;
            insideSamples++;
            stepLength = min(stepLength, tOut - t);
            float tMiddle = t + 0.5 * stepLength;
            vec3 p = samplePoint(tMiddle, origin, dir, b, cE, bL, cEL, radiusL, baseAltitude, thickness, h, hf);
            float density = volumeDensity(layer, p, hf, detailFade, billowFade, coverage);
            float columnTop = lastTop;
            float columnLumps = lastLumps;
            if (density > 0.0) {
                emptySamples = 0;
                sigma = density;
                // Light at this sample: the key light through the layer above it
                // (three scattering octaves, diffuse transmission, a powder edge
                // term) plus the sky from above and the ground from below.
                vec3 upLocal = normalize(cloudUp * cloudR0 + p);
                float sinE = dot(cloudSunDir, upLocal);
                if (sunBase.r < 0.0) {
                    // The key light's color at the layer's base and top, once per cloud crossing.
                    sunBase = sunColorAt(sinE, baseAltitude);
                    sunTop = sunColorAt(sinE, baseAltitude + thickness);
                }
                vec3 sunColor = mix(sunBase, sunTop, clamp(hf, 0.0, 1.0));
                vec3 light = vec3(0.0);
                float tau = 0.0;
                if (sunColor.r + sunColor.g + sunColor.b > 0.0) {
                    tau = sunOpticalDepth(layer, p, hf, sinE, thickness, detailFade, billowFade);
                    float scatter = exp(-tau) * phaseSun + 0.5 * exp(-0.5 * tau) * phaseSecond
                        + 0.25 * exp(-0.25 * tau) * phaseThird;
                    float powder = 1.0 - exp(-density * 60.0);
                    scatter *= mix(1.0, powder, 0.6 * clamp(0.5 - 0.5 * cosTheta, 0.0, 1.0));
                    scatter += CLOUD_DIFFUSE * diffuseTransmission(tau);
                    light = sunColor * (cloudSunIntensity * cloudSunGain * scatter);
                }
                // Sky light from above, shaded by the cloud over this point: estimated
                // from the layer's density and the depth to the column's dome top (the
                // same at every quality level), thicker or thinner with the large lumps
                // read at this sample, which mottles a large base softly.
                float depthAbove = max(columnTop - hf, 0.0) * thickness;
                float above = cloudParams[layer].y * CLOUD_SKY_SHADE_DENSITY * mix(0.5, 1.5, columnLumps);
                float skyShade = mix(0.15, 1.0, diffuseTransmission(above * depthAbove));
                // Light from below: the ground and the horizon sky. Under a dense field
                // both are partly shadowed by the other clouds of the layer, and the
                // ground under a thick cloud by the cloud itself.
                float coverageShade = mix(1.0, 0.4, cloudParams[layer].x * cloudParams[layer].x);
                float ownShadow = mix(0.3, 1.0, diffuseTransmission(tau));
                float groundShade = diffuseTransmission(density * hf * thickness * 0.5) * coverageShade * ownShadow;
                light += cloudAmbientTop * skyShade + cloudAmbientBottom * groundShade;
                float stepT = exp(-density * stepLength);
                float absorbed = segmentT * (1.0 - stepT);
                segmentColor += absorbed * 0.98 * light;
                weightedDistance += absorbed * tMiddle;
                weightSum += absorbed;
                segmentT *= stepT;
                if (front >= NO_FRONT_KM * 1000.0 && 1.0 - transmittance * segmentT > FRONT_ALPHA) front = tMiddle;
            } else {
                sigma = 0.0;
                // Out of the cloud (not only between its wisps): search again after
                // a few empty steps.
                if (lastSmooth <= 0.0 && ++emptySamples > 2) {
                    inside = false;
                    tClear = t + stepLength;
                }
            }
            t += stepLength;
        }
        // Nearly opaque: what is left behind is hidden; close it so nothing shows through.
        if (transmittance * segmentT < 0.02 && segmentT < 1.0) {
            segmentColor /= 1.0 - segmentT;
            segmentT = 0.0;
        }
        compositeSegment(segmentColor, segmentT, weightedDistance / max(weightSum, 1e-6),
            viewOrigin, viewDir, color, transmittance);
    }

    // A sheet layer: one crossing of its middle shell, a 2D pattern, a slant optical depth.
    float sheetPattern(int layer, vec3 p, float coverage) {
        vec4 info = cloudShapeInfo[layer];
        vec4 params = cloudParams[layer];
        float pattern = info.z;
        float value;
        if (pattern < 0.5) {
            // Cells (altocumulus, cirrocumulus): Worley puffs within the coverage.
            vec4 shapeA = cloudShapeA[layer];
            vec4 shapeNoise = textureLod(cloudShapeTex, (shapeA.xyz + p) * shapeA.w, textureLodFor(128.0 * shapeA.w));
            // Separate cloudlets: gaps between the cells even inside a patch.
            float cells = shapeNoise.g * 0.8 + shapeNoise.b * 0.2;
            float threshold = mix(0.66, 0.42, coverage);
            value = smoothstep(threshold, threshold + 0.18, cells);
        } else if (pattern < 1.5) {
            // Fibers (cirrus): FBM streaks stretched along the wind.
            vec4 wind = cloudWind[layer];
            float stretch = cloudLayerExtra[layer].x;
            vec3 pm = p - wind.xyz * (dot(p, wind.xyz) * (1.0 - 1.0 / stretch));
            vec4 shapeA = cloudShapeA[layer];
            vec4 detailA = cloudDetailA[layer];
            vec4 broad = textureLod(cloudShapeTex, (shapeA.xyz + pm) * shapeA.w, textureLodFor(128.0 * shapeA.w));
            // Bend the fine streaks with the broad pattern, as wind shear does.
            vec3 bend = (broad.gba - 0.5) * 0.6;
            float fine = textureLod(cloudDetailTex, (detailA.xyz + pm) * detailA.w + bend, textureLodFor(32.0 * detailA.w)).a;
            float strands = broad.r * 0.55 + fine * 0.6;
            value = smoothstep(0.62, 0.95, strands * (0.6 + 0.5 * coverage)) * coverage;
        } else {
            // Veil (cirrostratus): near uniform, slightly mottled.
            vec4 coverageA = cloudCoverageA[layer];
            float mottle = textureLod(cloudWeatherTex, (coverageA.xyz + p) * coverageA.w * 3.0, textureLodFor(192.0 * coverageA.w)).a;
            value = coverage * (0.65 + 0.35 * mottle);
        }
        if (params.z > 0.0 && pattern < 0.5) {
            vec4 detailA = cloudDetailA[layer];
            float detailNoise = textureLod(cloudDetailTex, (detailA.xyz + p) * detailA.w, textureLodFor(32.0 * detailA.w)).r;
            value = clamp(remap01(value, detailNoise * 0.35 * params.z, 1.0), 0.0, 1.0);
        }
        return value;
    }

    void shadeSheet(int layer, float t, vec3 origin, vec3 dir, float b, float cE, float cosTheta,
                    vec3 viewOrigin, vec3 viewDir, inout vec3 color, inout float transmittance, inout float front) {
        vec4 shell = cloudShell[layer];
        vec4 params = cloudParams[layer];
        vec4 info = cloudShapeInfo[layer];
        vec3 p = origin + dir * t;
        float h = shell.z + 0.5 * shell.w;
        // A grazing view stretches the pixel across the sheet.
        sampleFootprint = (cloudPixelSize + t * cloudPixelAngle) / max(abs(dot(dir, cloudUp)), 0.1);
        // With refraction, t is where the ray meets the layer's larger sphere: move
        // the point down by the lift the scene gives that distance.
        if (cloudRefraction) p -= cloudUp * (heightAt(t, b, cE, cloudR) - h);
        float presence;
        float coverage = layerCoverage(layer, p, 0.5, 0.0, presence);
        float distanceM;
        coverage *= discMask(layer, p, 1.0, distanceM);
        if (coverage <= 0.001) return;
        float value = sheetPattern(layer, p, coverage);
        if (value <= 0.0) return;
        vec3 upLocal = normalize(cloudUp * cloudR0 + p);
        float mu = max(abs(dot(dir, upLocal)), 0.03);
        // For a sheet, params.y is the density multiplier of its optical depth.
        float verticalTau = value * info.w * params.y;
        float tau = min(verticalTau / mu, 30.0);
        float alpha = 1.0 - exp(-tau);
        float sinE = dot(cloudSunDir, upLocal);
        vec3 sunColor = sunColorAt(sinE, h);
        vec3 light = vec3(0.0);
        if (sunColor.r + sunColor.g + sunColor.b > 0.0) {
            // Thin sheets are mostly single scattering; a thicker one shades itself.
            float sunTau = verticalTau / max(abs(sinE), 0.08);
            float scatter = cloudPhase(cosTheta, 1.0) * exp(-0.5 * sunTau) + 0.5 * cloudPhase(cosTheta, 0.5) * exp(-0.25 * sunTau);
            if (info.z < 0.5) {
                // Lumpy cells: darker where the pattern thickens toward the sun.
                vec3 toward = cloudSunDir - upLocal * sinE;
                float towardLength = length(toward);
                if (towardLength > 1e-4) {
                    vec3 offset = toward / towardLength / max(cloudShapeA[layer].w, 1e-9) * 0.02;
                    float ahead = sheetPattern(layer, p + offset, coverage);
                    scatter *= clamp(1.0 - 1.5 * (ahead - value), 0.35, 1.3);
                }
            } else if (info.z > 1.5) {
                // The 22 degree halo of an ice-crystal veil.
                float angle = degrees(acos(clamp(cosTheta, -1.0, 1.0)));
                scatter += 0.05 * exp(-pow((angle - 22.0) / 1.3, 2.0));
            }
            // A thin sheet scatters once; the multiple-scattering gain of a thick
            // cloud applies only as the sheet thickens.
            float gain = cloudSunGain * mix(0.15, 1.0, clamp(verticalTau / 4.0, 0.0, 1.0));
            light = sunColor * (cloudSunIntensity * gain * scatter);
        }
        light += mix(cloudAmbientBottom, cloudAmbientTop, 0.75) * 0.8;
        vec3 sheetColor = light * 0.98 * alpha;
        compositeSegment(sheetColor, 1.0 - alpha, t, viewOrigin, viewDir, color, transmittance);
        if (front >= NO_FRONT_KM * 1000.0 && 1.0 - transmittance > FRONT_ALPHA) front = t;
    }

    void writeClouds(vec3 color, float transmittance, float front, float tScene) {
        if (cloudDebug == 1) {
            color = vec3(float(debugSamples) / 128.0, float(debugLight) / 256.0, 0.0);
            transmittance = 0.0;
        }
        #ifdef CLOUD_MRT
            // Every pixel of the target is written, cloud or not.
            gl_FragColor = vec4(color, 1.0 - transmittance);
            // R: the first cloud's distance, G: the opaque distance this pixel was
            // marched to (both km; the sky is NO_FRONT_KM), for the upsample.
            cloudFrontOut = vec4(min(front / 1000.0, NO_FRONT_KM), min(tScene / 1000.0, NO_FRONT_KM), 0.0, 1.0);
        #else
            if (transmittance > 0.999) discard;
            gl_FragColor = vec4(color, 1.0 - transmittance);
        #endif
    }

    #ifndef CLOUD_MRT
    // Full-resolution composite of the march target. Each of the four nearest
    // march pixels is weighted by its bilinear share and by how closely the
    // opaque distance it was marched to matches this pixel's: across a ridge
    // line the samples from the other side of the edge drop out. A sample whose
    // first cloud lies behind this pixel's surface stands for "no cloud here",
    // which is exact for that ray; so a thin pole or an aircraft in front of a
    // cloud stays clear even when no march pixel landed on it.
    void compositeClouds(vec3 viewDir) {
        vec2 fullPixel = floor(gl_FragCoord.xy);
        vec2 marchCoord = (fullPixel + 0.5) * cloudMarchSize / softDepthSize - 0.5;
        vec2 cell = floor(marchCoord);
        vec2 fraction = marchCoord - cell;
        ivec2 last = ivec2(cloudMarchSize) - 1;
        ivec2 marchPixels[4];
        vec4 clouds[4];
        float coverage = 0.0;
        for (int corner = 0; corner < 4; corner++) {
            marchPixels[corner] = clamp(ivec2(cell + vec2(float(corner & 1), float(corner >> 1))), ivec2(0), last);
            clouds[corner] = texelFetch(cloudMarchColor, marchPixels[corner], 0);
            coverage += clouds[corner].a;
        }
        // Clear sky all round (most of the sky): nothing to draw, no depth to read.
        if (coverage < 1e-4) discard;
        float tFull = min(sceneDistance(ivec2(fullPixel), viewDir), NO_FRONT_KM * 1000.0);
        vec4 sum = vec4(0.0);
        float weightSum = 0.0;
        for (int corner = 0; corner < 4; corner++) {
            vec2 offset = vec2(float(corner & 1), float(corner >> 1));
            float bilinear = mix(1.0 - fraction.x, fraction.x, offset.x) * mix(1.0 - fraction.y, fraction.y, offset.y);
            vec4 cloud = clouds[corner];
            vec2 distances = texelFetch(cloudMarchFront, marchPixels[corner], 0).rg * 1000.0;
            float match;
            if (distances.r > tFull * 1.02 + 2.0) {
                cloud = vec4(0.0);
                match = 1.0;
            } else {
                float relative = abs(distances.g - tFull) / max(min(distances.g, tFull), 1.0);
                match = 1.0 / (1.0 + relative * relative * 2500.0);
            }
            float weight = bilinear * (match + 1e-4);
            sum += cloud * weight;
            weightSum += weight;
        }
        vec4 result = sum / max(weightSum, 1e-8);
        if (result.a < 1e-4 && result.r + result.g + result.b < 1e-5) discard;
        gl_FragColor = result;
    }
    #endif

    void main() {
        vec3 viewDir = atmosphereViewRay(vNdc);
        #ifndef CLOUD_MRT
            if (cloudComposite) {
                compositeClouds(viewDir);
                return;
            }
        #endif
        vec3 viewOrigin = vec3(0.0);
        if (atmoOrthographic && !atmoFishOn) {
            vec4 nearPoint = atmoInverseProjection * vec4(vNdc, 0.0, 1.0);
            viewOrigin = vec3(nearPoint.xy / nearPoint.w, 0.0);
        }
        vec3 dir = normalize(cloudViewToWorld * viewDir);
        vec3 origin = cloudViewToWorld * viewOrigin;
        float front = NO_FRONT_KM * 1000.0;

        // The opaque scene limits the march (log depth, see SoftDepth.js).
        float tScene = cloudTMax;
        if (softDepthEnabled) tScene = min(tScene, sceneDistance(cloudDepthPixel(floor(gl_FragCoord.xy)), viewDir));

        // Ray constants relative to the local sphere's center.
        float b, cOffset, cE;
        rayConstants(cloudR, origin, dir, b, cOffset, cE);

        // The ground: nothing below it is visible even where no terrain drew depth.
        float tNear, tFar;
        float bGround, cOffsetGround, cEGround;
        rayConstants(cloudGroundRadius, origin, dir, bGround, cOffsetGround, cEGround);
        if (shellRoots(bGround, cloudCEarth + cOffsetGround, tNear, tFar) && tFar > 0.0 && cloudCEarth + cOffsetGround > 0.0) {
            tScene = min(tScene, max(tNear, 0.0));
        }
        float tLimit = min(tScene, cloudTMax);

        float segmentIn[MAX_SEGMENTS];
        float segmentOut[MAX_SEGMENTS];
        int segmentLayer[MAX_SEGMENTS];
        int segmentCount = 0;
        for (int layer = 0; layer < MAX_LAYERS; layer++) {
            if (layer >= cloudLayerCount) break;
            vec4 shell = cloudShell[layer];
            float bL, cOffsetL, cEL;
            rayConstants(cloudLayerExtra[layer].z, origin, dir, bL, cOffsetL, cEL);
            if (cloudParams[layer].w > 0.5) {
                // Sheet: each crossing of the middle shell is a point event.
                if (shellRoots(bL, shell.x + cOffsetL, tNear, tFar)) {
                    if (tNear > 0.0 && tNear < tLimit) {
                        segmentIn[segmentCount] = tNear; segmentOut[segmentCount] = tNear;
                        segmentLayer[segmentCount] = layer; segmentCount++;
                    }
                    if (tFar > 0.0 && tFar < tLimit) {
                        segmentIn[segmentCount] = tFar; segmentOut[segmentCount] = tFar;
                        segmentLayer[segmentCount] = layer; segmentCount++;
                    }
                }
                continue;
            }
            float topIn, topOut;
            if (!shellRoots(bL, shell.y + cOffsetL, topIn, topOut)) continue;
            float baseIn, baseOut;
            float firstOut = topOut, secondIn = topOut;
            if (shellRoots(bL, shell.x + cOffsetL, baseIn, baseOut)) {
                firstOut = min(topOut, baseIn);
                secondIn = max(topIn, baseOut);
            }
            float startA = max(topIn, 0.0), endA = min(firstOut, tLimit);
            if (endA > startA) {
                segmentIn[segmentCount] = startA; segmentOut[segmentCount] = endA;
                segmentLayer[segmentCount] = layer; segmentCount++;
            }
            float startB = max(secondIn, 0.0), endB = min(topOut, tLimit);
            if (secondIn < topOut && endB > startB) {
                segmentIn[segmentCount] = startB; segmentOut[segmentCount] = endB;
                segmentLayer[segmentCount] = layer; segmentCount++;
            }
        }
        if (segmentCount == 0) {
            writeClouds(vec3(0.0), 1.0, front, tScene);
            return;
        }

        // Front to back (insertion sort of at most eight entries).
        for (int index = 1; index < MAX_SEGMENTS; index++) {
            if (index >= segmentCount) break;
            float keyIn = segmentIn[index], keyOut = segmentOut[index];
            int keyLayer = segmentLayer[index];
            int slot = index - 1;
            for (int guard = 0; guard < MAX_SEGMENTS; guard++) {
                if (slot < 0 || segmentIn[slot] <= keyIn) break;
                segmentIn[slot + 1] = segmentIn[slot];
                segmentOut[slot + 1] = segmentOut[slot];
                segmentLayer[slot + 1] = segmentLayer[slot];
                slot--;
            }
            segmentIn[slot + 1] = keyIn; segmentOut[slot + 1] = keyOut; segmentLayer[slot + 1] = keyLayer;
        }

        float cosTheta = dot(dir, cloudSunDir);
        float jitter = marchJitter();
        vec3 color = vec3(0.0);
        float transmittance = 1.0;
        // One budget per pixel, shared by every segment: near layers come first.
        int budget = cloudSteps;
        int skipBudget = cloudSkipSteps;
        for (int index = 0; index < MAX_SEGMENTS; index++) {
            if (index >= segmentCount || transmittance < 0.01) break;
            int layer = segmentLayer[index];
            if (cloudParams[layer].w > 0.5) {
                shadeSheet(layer, segmentIn[index], origin, dir, b, cE, cosTheta, viewOrigin, viewDir, color, transmittance, front);
            } else {
                marchVolume(layer, segmentIn[index], segmentOut[index], origin, dir, b, cE, cosTheta, jitter,
                    viewOrigin, viewDir, color, transmittance, front, budget, skipBudget);
            }
        }
        writeClouds(color, transmittance, front, tScene);
    }
`;
