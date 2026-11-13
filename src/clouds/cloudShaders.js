// cloudShaders.js - GLSL for the volumetric cloud layers.
//
// One full-screen triangle in the world scene runs this fragment program per
// pixel: build the displayed view ray, find where it crosses each layer's
// shell (camera-relative, stable quadratic, see CloudMath.js), sort the
// crossings front to back, ray-march each volume segment (or shade each sheet
// crossing), and composite premultiplied color over the opaque scene with the
// opaque depth from SoftDepth as the far limit. Haze is applied per segment at
// its mean scattering distance with the same integral the terrain uses.
//
// Units: lengths in meters, extinction in 1/m, radiance linear (the view
// tone-maps later). Every position is camera-relative and ECEF-oriented.

import {ATMOSPHERE_PROJECTION_GLSL} from "../atmosphere/AtmosphereProjection";
import {ATMOSPHERE_HAZE_GLSL, MATERIAL_ATMOSPHERE_UNIFORMS_GLSL} from "../atmosphere/MaterialAtmosphere";

export const CLOUD_MAX_LAYERS = 4;
export const CLOUD_MAX_STEPS = 256;
export const CLOUD_MAX_LIGHT_STEPS = 6;

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
    #define MAX_STEPS ${CLOUD_MAX_STEPS}
    #define MAX_LIGHT_STEPS ${CLOUD_MAX_LIGHT_STEPS}
    #define PI 3.14159265359

    varying vec2 vNdc;

    ${ATMOSPHERE_PROJECTION_GLSL}
    ${MATERIAL_ATMOSPHERE_UNIFORMS_GLSL}
    ${ATMOSPHERE_HAZE_GLSL}

    uniform mat3 cloudViewToWorld;
    uniform vec3 cloudUp;          // geodetic up at the camera
    uniform float cloudR;          // local sphere radius (Gaussian radius at the camera)
    uniform float cloudR0;         // R + camera height
    uniform float cloudC0;         // h0 (2R + h0)
    uniform float cloudCEarth;     // shell constant of the ground cap
    uniform float cloudNear;
    uniform float cloudTMax;
    uniform vec3 cloudSunDir;
    uniform float cloudSunIntensity;
    uniform float cloudSunGain;
    uniform vec3 cloudAmbientTop;
    uniform vec3 cloudAmbientBottom;
    uniform float cloudFrame;
    uniform int cloudLayerCount;
    uniform int cloudSteps;
    uniform int cloudLightSteps;
    uniform sampler3D cloudShapeTex;
    uniform sampler3D cloudDetailTex;
    uniform sampler3D cloudWeatherTex;

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
    uniform vec4 cloudStretch[MAX_LAYERS];    // x = stretch along the wind (fibrous sheets)

    float remap01(float value, float low, float high) {
        return (value - low) / max(high - low, 1e-5);
    }

    // Per-pixel jitter of the march start (hides banding without temporal
    // accumulation), seeded by the whole frame so a paused frame is stable.
    float ditherNoise() {
        vec3 p3 = fract(vec3(gl_FragCoord.xy, mod(cloudFrame, 97.0)) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yxz + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    float henyeyGreenstein(float cosTheta, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
    }

    // Forward lobe for the silver lining, weak back lobe for the backscatter.
    float cloudPhase(float cosTheta, float scale) {
        return 0.7 * henyeyGreenstein(cosTheta, 0.8 * scale) + 0.3 * henyeyGreenstein(cosTheta, -0.2 * scale);
    }

    // Height above the local sphere at distance t (rationalized: no Earth-sized difference).
    float heightAt(float t, float b, float cE) {
        float numerator = cE + 2.0 * b * t + t * t;
        return numerator / (sqrt(cloudR * cloudR + numerator) + cloudR);
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

    // The light reaching a point at height h whose sun elevation has sine sinE:
    // the scene's own brightness curve (CNodeSunlight), measured from the
    // point's own horizon (so high clouds stay lit after sunset at the ground),
    // tinted by the air the sunlight crossed (Rayleigh + aerosol, Kasten-Young
    // air mass), relative to a high sun. Zero in the Earth's shadow.
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
        float lobes = texture(cloudShapeTex, (shapeA.xyz + p) * shapeA.w).g;
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
        float primary = texture(cloudWeatherTex, (coverageA.xyz + pc) * coverageA.w).r;
        float secondary = texture(cloudWeatherTex, (coverageB.xyz + pc) * coverageB.w).g;
        float weather = clamp(primary + (secondary - 0.5) * 0.3, 0.0, 1.0);
        float edge = 1.0 - params.x;
        presence = clamp((weather - edge) / max(params.x, 1e-3), 0.0, 1.0);
        // An overcast layer is a continuous deck, not a pattern with holes.
        float overcast = smoothstep(0.85, 1.0, params.x);
        presence = max(presence, overcast * 0.85);
        return weather > edge ? clamp(presence * 1.6, 0.0, 1.0) : overcast;
    }

    // Extinction (1/m) of a volume layer at camera-relative point p with height
    // fraction hf. coverageOut is 0 where the whole column is clear, which
    // the march uses to take longer steps.
    float volumeDensity(int layer, vec3 p, float hf, bool withDetail, out float coverageOut) {
        coverageOut = 0.0;
        if (hf < 0.0 || hf > 1.0) return 0.0;
        vec4 shell = cloudShell[layer];
        vec4 params = cloudParams[layer];
        vec4 info = cloudShapeInfo[layer];
        vec4 wind = cloudWind[layer];
        // Wind shear: the pattern at height hf is the base pattern moved downwind.
        vec3 ps = p - wind.xyz * (wind.w * hf);
        float presence;
        float coverage = layerCoverage(layer, ps, hf, shell.w, presence);
        float anvil = info.y * smoothstep(0.68, 0.86, hf);
        float distanceM;
        float mask = discMask(layer, ps, mix(1.0, 2.1, anvil), distanceM);
        if (info.y > 0.5 && cloudDisc[layer].w > 0.0) {
            // A storm cell: a solid core inside its disc, its anvil spreading at the top.
            float core = 1.0 - smoothstep(0.0, cloudDisc[layer].w * 0.75, distanceM);
            coverage = max(coverage, max(core, anvil));
            presence = max(presence, core);
        } else if (info.y > 0.5) {
            coverage = clamp(coverage + anvil * 0.5, 0.0, 1.0);
        }
        coverage *= mask;
        coverageOut = coverage;
        if (coverage <= 0.001) return 0.0;

        vec4 gradientPoints = cloudGradient[layer];
        // Domed types: tall where the coverage is strong, so each cell has a
        // rounded top over its flat base.
        float top = gradientPoints.w * mix(1.0, mix(0.3, 1.0, presence * mask), info.x);
        top = max(top, anvil);
        float fadeStart = min(gradientPoints.z * top / max(gradientPoints.w, 1e-3), top - 0.02);
        float gradient = smoothstep(gradientPoints.x, gradientPoints.y, hf) * (1.0 - smoothstep(fadeStart, top, hf));
        gradient = max(gradient, anvil * (1.0 - smoothstep(0.93, 1.0, hf)));
        if (gradient <= 0.0) return 0.0;

        vec4 shapeA = cloudShapeA[layer];
        vec4 shapeNoise = texture(cloudShapeTex, (shapeA.xyz + ps) * shapeA.w);
        float worley = shapeNoise.g * 0.625 + shapeNoise.b * 0.25 + shapeNoise.a * 0.125;
        float shape = remap01(shapeNoise.r, worley - 1.0, 1.0);
        // More contrast than the raw Perlin-Worley, so billows stand out.
        shape = clamp((shape - 0.4) / 0.6, 0.0, 1.0);
        // profile is 1 deep inside a cloud and falls to 0 at its smooth outline.
        // The noise is subtracted from it, so it billows the surface but never
        // opens holes in a cloud's core.
        float profile = coverage * gradient;
        float erosion = (1.0 - shape) * 0.7;
        // A short ramp above the eroded outline: crisp billows, a solid inside.
        float base = clamp(remap01(profile, erosion, erosion + 0.45), 0.0, 1.0);
        if (base <= 0.0) return 0.0;
        if (withDetail && params.z > 0.0) {
            vec4 detailA = cloudDetailA[layer];
            vec3 pd = (detailA.xyz + ps) * detailA.w;
            // Curl-like wisps: displace the detail lookup by the low shape channels.
            pd += (shapeNoise.gba - 0.5) * 0.35;
            vec4 detailNoise = texture(cloudDetailTex, pd);
            float detailFBM = detailNoise.r * 0.625 + detailNoise.g * 0.25 + detailNoise.b * 0.125;
            // Wispy near the base, billowy higher up.
            float erode = mix(detailFBM, 1.0 - detailFBM, clamp(hf * 4.0, 0.0, 1.0));
            base = clamp(remap01(base, erode * 0.6 * params.z, 1.0), 0.0, 1.0);
        }
        return base * params.y;
    }

    // Optical depth toward the sun from a point, through its own layer.
    float sunOpticalDepth(int layer, vec3 p, float hf, float sunUp, float thickness) {
        float tau = 0.0;
        float stepLength = clamp(thickness * 0.025, 15.0, 160.0);
        float travelled = 0.0;
        float coverage;
        for (int index = 0; index < MAX_LIGHT_STEPS; index++) {
            if (index >= cloudLightSteps) break;
            float sampleAt = travelled + stepLength * 0.5;
            float sampleHf = hf + sampleAt * sunUp / thickness;
            if (sampleHf > 1.0 || sampleHf < 0.0) break;
            tau += volumeDensity(layer, p + cloudSunDir * sampleAt, sampleHf, index < 2, coverage) * stepLength;
            travelled += stepLength;
            stepLength *= 2.0;
        }
        return tau;
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

    void marchVolume(int layer, float tIn, float tOut, vec3 origin, vec3 dir, float b, float cE, float cosTheta,
                     float jitter, vec3 viewOrigin, vec3 viewDir, inout vec3 color, inout float transmittance) {
        vec4 shell = cloudShell[layer];
        float baseAltitude = shell.z, thickness = shell.w;
        float scale = 0.25 / max(cloudCoverageA[layer].w, 1e-9);   // the layer's horizontal scale (m)
        float segmentLength = tOut - tIn;
        // Three step lengths, all growing with distance (a pixel's footprint does):
        // coarse strides cross clear columns, medium steps cross cloudy columns
        // with no cloud at this height, fine steps sample inside a cloud.
        float minStep = max(thickness / 96.0, 6.0);
        float maxFine = max(minStep, min(thickness * 0.12, scale * 0.05));
        float maxCoarse = max(maxFine, min(scale * 0.5, segmentLength * 0.25));
        float fineScale = 1.0 / (0.6 * float(cloudSteps) + 120.0);
        float coarseScale = 10.0 * fineScale;
        vec3 segmentColor = vec3(0.0);
        float segmentT = 1.0;
        float weightedDistance = 0.0, weightSum = 0.0;
        float phaseSun = cloudPhase(cosTheta, 1.0);
        float phaseSecond = cloudPhase(cosTheta, 0.5);
        float phaseThird = cloudPhase(cosTheta, 0.25);
        int mode = 0;          // 0 coarse, 1 medium, 2 fine
        int emptyFine = 0;
        float holdUntil = 0.0; // after stepping back, keep the closer steps past this point
        float t = tIn + clamp(tIn * coarseScale, minStep, maxCoarse) * jitter;
        for (int index = 0; index < MAX_STEPS; index++) {
            if (index >= cloudSteps || t >= tOut || transmittance * segmentT < 0.01) break;
            float coarseStep = clamp(t * coarseScale, 3.0 * minStep, maxCoarse);
            float fineStep = clamp(t * fineScale, minStep, min(maxFine, coarseStep));
            float mediumStep = clamp(t * 3.0 * fineScale, 2.0 * minStep, coarseStep);
            vec3 p = origin + dir * t;
            float h = heightAt(t, b, cE);
            float hf = (h - baseAltitude) / thickness;
            float coverage;
            float density = volumeDensity(layer, p, hf, mode > 0 && t < 60000.0, coverage);
            if (mode == 0) {
                if (coverage > 0.001) {
                    // Entered a cloudy column in the last stride: go back, then step closer.
                    mode = 1;
                    holdUntil = t;
                    t = max(tIn, t - coarseStep * (1.0 - jitter * 0.5));
                    continue;
                }
                t += coarseStep;
                continue;
            }
            if (mode == 1) {
                if (density > 0.0) {
                    // Entered a cloud in the last step: go back, then step finely.
                    mode = 2;
                    emptyFine = 0;
                    holdUntil = t;
                    t = max(tIn, t - mediumStep * (1.0 - jitter * 0.5));
                    continue;
                }
                if (coverage <= 0.001 && t > holdUntil) mode = 0;
                t += mediumStep;
                continue;
            }
            if (density > 0.0) {
                emptyFine = 0;
                float takeLength = min(fineStep, tOut - t);
                // Light at this sample: the sun through the layer above it (three
                // scattering octaves, a powder edge term) plus the sky.
                vec3 upLocal = normalize(cloudUp * cloudR0 + p);
                float sinE = dot(cloudSunDir, upLocal);
                vec3 sunColor = sunColorAt(sinE, h);
                vec3 light = vec3(0.0);
                if (sunColor.r + sunColor.g + sunColor.b > 0.0) {
                    float tau = sunOpticalDepth(layer, p, hf, sinE, thickness);
                    float scatter = exp(-tau) * phaseSun + 0.5 * exp(-0.5 * tau) * phaseSecond
                        + 0.25 * exp(-0.25 * tau) * phaseThird;
                    float powder = 1.0 - exp(-density * 60.0);
                    scatter *= mix(1.0, powder, 0.6 * clamp(0.5 - 0.5 * cosTheta, 0.0, 1.0));
                    light = sunColor * (cloudSunIntensity * cloudSunGain * scatter);
                }
                float above = volumeDensity(layer, p + upLocal * ((1.0 - hf) * thickness * 0.5), mix(hf, 1.0, 0.5), false, coverage);
                float ambientShade = 0.35 + 0.65 * exp(-above * (1.0 - hf) * thickness * 0.06);
                light += mix(cloudAmbientBottom, cloudAmbientTop, sqrt(clamp(hf, 0.0, 1.0))) * ambientShade;
                float stepT = exp(-density * takeLength);
                float absorbed = segmentT * (1.0 - stepT);
                segmentColor += absorbed * 0.98 * light;
                weightedDistance += absorbed * t;
                weightSum += absorbed;
                segmentT *= stepT;
            } else if (t > holdUntil && ++emptyFine > 3) {
                mode = coverage > 0.001 ? 1 : 0;
            }
            t += fineStep;
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
            vec4 shapeNoise = texture(cloudShapeTex, (shapeA.xyz + p) * shapeA.w);
            // Separate cloudlets: gaps between the cells even inside a patch.
            float cells = shapeNoise.g * 0.8 + shapeNoise.b * 0.2;
            float threshold = mix(0.66, 0.42, coverage);
            value = smoothstep(threshold, threshold + 0.18, cells);
        } else if (pattern < 1.5) {
            // Fibers (cirrus): FBM streaks stretched along the wind.
            vec4 wind = cloudWind[layer];
            float stretch = cloudStretch[layer].x;
            vec3 pm = p - wind.xyz * (dot(p, wind.xyz) * (1.0 - 1.0 / stretch));
            vec4 shapeA = cloudShapeA[layer];
            vec4 detailA = cloudDetailA[layer];
            vec4 broad = texture(cloudShapeTex, (shapeA.xyz + pm) * shapeA.w);
            // Bend the fine streaks with the broad pattern, as wind shear does.
            vec3 bend = (broad.gba - 0.5) * 0.6;
            float fine = texture(cloudDetailTex, (detailA.xyz + pm) * detailA.w + bend).a;
            float strands = broad.r * 0.55 + fine * 0.6;
            value = smoothstep(0.62, 0.95, strands * (0.6 + 0.5 * coverage)) * coverage;
        } else {
            // Veil (cirrostratus): near uniform, slightly mottled.
            vec4 coverageA = cloudCoverageA[layer];
            float mottle = texture(cloudWeatherTex, (coverageA.xyz + p) * coverageA.w * 3.0).a;
            value = coverage * (0.65 + 0.35 * mottle);
        }
        if (params.z > 0.0 && pattern < 0.5) {
            vec4 detailA = cloudDetailA[layer];
            float detailNoise = texture(cloudDetailTex, (detailA.xyz + p) * detailA.w).r;
            value = clamp(remap01(value, detailNoise * 0.35 * params.z, 1.0), 0.0, 1.0);
        }
        return value;
    }

    void shadeSheet(int layer, float t, vec3 origin, vec3 dir, float b, float cE, float cosTheta,
                    vec3 viewOrigin, vec3 viewDir, inout vec3 color, inout float transmittance) {
        vec4 shell = cloudShell[layer];
        vec4 params = cloudParams[layer];
        vec4 info = cloudShapeInfo[layer];
        vec3 p = origin + dir * t;
        float h = shell.z + 0.5 * shell.w;
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
    }

    void main() {
        vec3 viewDir = atmosphereViewRay(vNdc);
        vec3 viewOrigin = vec3(0.0);
        if (atmoOrthographic && !atmoFishOn) {
            vec4 nearPoint = atmoInverseProjection * vec4(vNdc, 0.0, 1.0);
            viewOrigin = vec3(nearPoint.xy / nearPoint.w, 0.0);
        }
        vec3 dir = normalize(cloudViewToWorld * viewDir);
        vec3 origin = cloudViewToWorld * viewOrigin;

        // The opaque scene limits the march (log depth, see SoftDepth.js).
        float tScene = cloudTMax;
        if (softDepthEnabled) {
            float depth = texture(softSceneDepth, gl_FragCoord.xy / softDepthSize).r;
            if (depth < 1.0) {
                if (softDepthOrthoRange > 0.0) {
                    tScene = depth * softDepthOrthoRange + cloudNear;
                } else {
                    float w = exp2(depth * softDepthLogFar) - 1.0;
                    tScene = atmoFishOn ? w : w / max(-viewDir.z, 1e-4);
                }
            }
        }

        // Ray constants relative to the local sphere's center.
        float originUp = dot(origin, cloudUp);
        float b = cloudR0 * dot(dir, cloudUp) + dot(origin, dir);
        float cOffset = 2.0 * cloudR0 * originUp + dot(origin, origin);
        float cE = cloudC0 + cOffset;

        // The ground: nothing below it is visible even where no terrain drew depth.
        float tNear, tFar;
        if (shellRoots(b, cloudCEarth + cOffset, tNear, tFar) && tFar > 0.0 && cloudCEarth + cOffset > 0.0) {
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
            if (cloudParams[layer].w > 0.5) {
                // Sheet: each crossing of the middle shell is a point event.
                if (shellRoots(b, shell.x + cOffset, tNear, tFar)) {
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
            if (!shellRoots(b, shell.y + cOffset, topIn, topOut)) continue;
            float baseIn, baseOut;
            float firstOut = topOut, secondIn = topOut;
            if (shellRoots(b, shell.x + cOffset, baseIn, baseOut)) {
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
        if (segmentCount == 0) discard;

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
        float jitter = ditherNoise();
        vec3 color = vec3(0.0);
        float transmittance = 1.0;
        for (int index = 0; index < MAX_SEGMENTS; index++) {
            if (index >= segmentCount || transmittance < 0.01) break;
            int layer = segmentLayer[index];
            if (cloudParams[layer].w > 0.5) {
                shadeSheet(layer, segmentIn[index], origin, dir, b, cE, cosTheta, viewOrigin, viewDir, color, transmittance);
            } else {
                marchVolume(layer, segmentIn[index], segmentOut[index], origin, dir, b, cE, cosTheta, jitter,
                    viewOrigin, viewDir, color, transmittance);
            }
        }
        if (transmittance > 0.999) discard;
        gl_FragColor = vec4(color, 1.0 - transmittance);
    }
`;
