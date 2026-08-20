// OceanBRDF.glsl.js
//
// GLSL for the physically based sea surface, as a string chunk so it can be shared
// between the terrain material and anything else that needs it later.
//
// The model is a Gaussian-slope microfacet BRDF — the standard treatment of a wind-
// roughened water surface in both the graphics and the ocean-optics literature:
//
//   Ross, V., Dion, D. & Potvin, G. (2005). Detailed analytical approach to the
//     Gaussian surface BRDF specular component applied to the sea surface.
//     JOSA A 22(11), 2442-2453.
//   Bruneton, E., Neyret, F. & Holzschuch, N. (2010). Real-time Realistic Ocean
//     Lighting using Seamless Transitions from Geometry to BRDF. CGF 29(2).
//
// The one idea that matters more than any other here: A ROUGH SURFACE SEEN FROM FAR
// AWAY IS NOT A MIRROR OF ITS AVERAGE NORMAL. Once a pixel covers many wavelengths,
// the right object is not a normal but a slope DISTRIBUTION, and the shading is an
// integral over it. Point-sampling a smoothed normal at that range is what makes
// computer-graphics water look like polished stone, and it is the specific bug this
// chunk exists to fix.
//
// Slope variance arrives as sigma2 = (along-wind, cross-wind) in a wind-aligned
// tangent frame. It is a VARIANCE, matching what Cox & Munk measured; the Beckmann
// roughness some formulations use is alpha = sigma * sqrt(2). The distinction is
// asserted on the CPU side in OceanSpectrum.test.js.

export const OCEAN_MAX_WAVES = 64;

export const oceanBRDFChunk = /* glsl */`
#define OCEAN_MAX_WAVES ${OCEAN_MAX_WAVES}


// Abramowitz & Stegun 7.1.26. Same approximation as the CPU side, so a shader result
// can be checked against a unit test without the two drifting apart.
float oceanErfc(float x) {
    float sign = x < 0.0 ? -1.0 : 1.0;
    float ax = abs(x);
    float t = 1.0 / (1.0 + 0.3275911 * ax);
    float poly = t * (0.254829592
               + t * (-0.284496736
               + t * (1.421413741
               + t * (-1.453152027 + t * 1.061405429))));
    float erf = 1.0 - poly * exp(-ax * ax);
    return 1.0 - sign * erf;
}

// Slope standard deviation in a given azimuth of a wind-aligned anisotropic surface.
// dir is the (along-wind, cross-wind) components of the horizontal ray direction,
// normalised. Using the isotropic total here instead would make an upwind view too
// dark and a crosswind view too bright — the sea is measurably more rutted along the
// wind than across it.
float oceanSigmaAzimuth(vec2 sigma2, vec2 dir) {
    return sqrt(max(sigma2.x * dir.x * dir.x + sigma2.y * dir.y * dir.y, 1e-9));
}

// Smith's shadowing-masking term for a Gaussian surface. cotTheta is measured from
// the macroscopic normal. This is the term that stops the surface returning more
// light than it receives near the horizon — which is exactly where a sea view lives,
// so it is not an optional refinement here.
float oceanSmithLambda(float cotTheta, float sigma) {
    float nu = cotTheta / (sigma * 1.41421356);
    if (nu > 6.0) return 0.0;          // saturated; also guards the 1/nu below
    nu = max(nu, 1e-4);
    return 0.5 * (exp(-nu * nu) / (nu * 1.77245385) - oceanErfc(nu));
}

// Exact unpolarised Fresnel. Schlick is within a couple of percent for a dielectric,
// so this is not about accuracy at moderate angles — it is that the whole subject of
// a seascape is the last few degrees before grazing, where being exactly right costs
// two square roots.
float oceanFresnel(float cosIncident, float ior) {
    float cosI = clamp(cosIncident, 0.0, 1.0);
    float sinT2 = (1.0 - cosI * cosI) / (ior * ior);
    if (sinT2 >= 1.0) return 1.0;
    float cosT = sqrt(1.0 - sinT2);
    float rs = (cosI - ior * cosT) / (cosI + ior * cosT);
    float rp = (ior * cosI - cosT) / (ior * cosI + cosT);
    return 0.5 * (rs * rs + rp * rp);
}

// Anisotropic Gaussian slope probability density. slope is (along-wind, cross-wind)
// components of the microfacet slope, i.e. the tangent of the tilt.
float oceanSlopePDF(vec2 slope, vec2 sigma2) {
    vec2 s2 = max(sigma2, vec2(1e-9));
    float exponent = 0.5 * (slope.x * slope.x / s2.x + slope.y * slope.y / s2.y);
    return exp(-exponent) / (6.28318531 * sqrt(s2.x * s2.y));
}

// Radiance reflected from a finite-solid-angle source (Sun or Moon) by the rough
// surface. This is the glitter path, and it is done ANALYTICALLY rather than by
// sampling the reflection render target, for a reason worth stating: the solar disc
// is half a degree across, so in a render target it is a handful of pixels, and the
// blur that a rough surface applies would smear those pixels into nothing. The disc's
// radiance has to be reintroduced as a quantity, not as an image.
//
//   L = D(h) * F * G / (4 cos_v cos_l) * L_source * solidAngle * cos_l
//
// with D = p(slope)/cos^4(theta_h) the slope-space to half-vector-space Jacobian.
//
// discRadius is the source's angular RADIUS in radians. Convolving the disc with the
// slope distribution (sigma_eff^2 = sigma^2 + (radius/2)^2) matters only in the glassy
// limit, but without it a dead-calm sea collapses the moon to a point instead of
// showing a moon-shaped reflection.
vec3 oceanSourceGlitter(
    vec3 toEye, vec3 toSource, vec3 up, vec3 windX, vec3 windY,
    vec2 sigma2, vec3 sourceRadiance, float sourceSolidAngle, float discRadius,
    float ior
) {
    float cosLight = dot(toSource, up);
    float cosView = dot(toEye, up);
    if (cosLight <= 0.0 || cosView <= 0.0) return vec3(0.0);

    vec3 halfVec = normalize(toEye + toSource);
    float cosHalfUp = dot(halfVec, up);
    if (cosHalfUp <= 1e-4) return vec3(0.0);

    // Microfacet slope that would reflect the source into the eye.
    vec2 slope = vec2(dot(halfVec, windX), dot(halfVec, windY)) / cosHalfUp;

    // Widen by the source's own angular size, halved because a slope error tilts the
    // reflected ray by twice as much.
    vec2 sigmaEff2 = sigma2 + vec2(discRadius * discRadius * 0.25);

    float pdf = oceanSlopePDF(slope, sigmaEff2);
    float cosHalf4 = cosHalfUp * cosHalfUp * cosHalfUp * cosHalfUp;
    float distribution = pdf / cosHalf4;

    float fresnel = oceanFresnel(dot(halfVec, toEye), ior);

    // Shadowing and masking, each evaluated with the slope roughness along its OWN
    // azimuth rather than an isotropic average.
    vec2 viewAz = normalize(vec2(dot(toEye, windX), dot(toEye, windY)) + vec2(1e-6));
    vec2 lightAz = normalize(vec2(dot(toSource, windX), dot(toSource, windY)) + vec2(1e-6));
    float cotView = cosView / max(sqrt(max(1.0 - cosView * cosView, 0.0)), 1e-4);
    float cotLight = cosLight / max(sqrt(max(1.0 - cosLight * cosLight, 0.0)), 1e-4);
    float geometry = 1.0 / (1.0
        + oceanSmithLambda(cotView, oceanSigmaAzimuth(sigmaEff2, viewAz))
        + oceanSmithLambda(cotLight, oceanSigmaAzimuth(sigmaEff2, lightAz)));

    float brdf = distribution * fresnel * geometry / (4.0 * cosView * cosLight);
    return sourceRadiance * (brdf * sourceSolidAngle * cosLight);
}

// Directional reflectance for the environment term: the fraction of incident radiance
// from the whole hemisphere that this surface sends towards the eye.
//
// This is the "split sum" factor. The environment is sampled ONCE, pre-filtered to the
// width of the reflection lobe, and multiplied by this. Multiplying a filtered
// environment sample by the point value of the BRDF instead would be a category error
// — the BRDF has units of inverse steradians and the solid-angle integral is precisely
// what has already been folded into the filtering.
//
// Masking only, not masking-and-shadowing: the incoming direction has been integrated
// over, so there is no single light ray left to shadow.
float oceanEnvironmentReflectance(vec3 toEye, vec3 up, vec2 sigma2, float ior) {
    float cosView = clamp(dot(toEye, up), 1e-4, 1.0);
    float sinView = sqrt(max(1.0 - cosView * cosView, 0.0));
    float cotView = cosView / max(sinView, 1e-4);
    float sigmaIso = sqrt(max(0.5 * (sigma2.x + sigma2.y), 1e-9));
    float masking = 1.0 / (1.0 + oceanSmithLambda(cotView, sigmaIso));
    return oceanFresnel(cosView, ior) * masking;
}

// Sky radiance along a direction, from a two-point sky: a zenith color and a
// horizon color. Crude as a sky model, but it captures the one thing that matters
// here — a clear sky is several times brighter and much less saturated near the
// horizon than overhead — and that gradient is what makes surface roughness VISIBLE.
//
// With a uniform sky, roughness changes almost nothing at ordinary view angles: the
// Fresnel term depends on the view direction, not on how rough the water is, so every
// patch of sea reflects the same radiance however choppy it is. Give the sky a
// gradient and a rough patch starts averaging over a wider spread of sky directions
// than a smooth one, so it lands on a different brightness. That is precisely how
// cat's-paws and wind streaks show up in a real photograph of the sea.
//
// lobeAngle widens the average: a rough surface pulls its sample towards the mean sky
// rather than the sky in one exact direction.
vec3 oceanSkyRadiance(vec3 dir, vec3 up, vec3 zenithColor, vec3 horizonColor,
                      float lobeAngle) {
    float elevation = clamp(dot(dir, up), 0.0, 1.0);
    // A wide lobe cannot tell one sky direction from another, so it converges on a
    // mid-sky average. 0.42 is the cosine-weighted mean elevation of a hemisphere.
    float soften = clamp(lobeAngle * 1.6, 0.0, 1.0);
    float effective = mix(elevation, 0.42, soften);
    return mix(horizonColor, zenithColor, pow(effective, 0.45));
}

// --- wind gustiness -------------------------------------------------------
//
// Real wind over water is not uniform, and neither is the sea it makes. Gusts and
// Langmuir circulation break the surface into patches of rougher and smoother water
// — "cat's-paws" — elongated ALONG the wind at roughly five to one, on scales of
// hundreds of metres. It is the most conspicuous large-scale structure on a real sea
// viewed from altitude, and without it a physically exact surface still reads as a
// painted sheet, because every square metre of it is equally rough.
//
// It also does useful work against repetition: modulating the variance destroys any
// residual regularity in the statistical term. (It cannot hide a repeating pattern in
// the RESOLVED waves — only lattice rotation and long-wave advection do that — but at
// any distance where a wave field is unresolved, this is the whole surface.)

float oceanHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float oceanValueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 frac = fract(p);
    vec2 smoothFrac = frac * frac * (3.0 - 2.0 * frac);
    float a = oceanHash(cell);
    float b = oceanHash(cell + vec2(1.0, 0.0));
    float c = oceanHash(cell + vec2(0.0, 1.0));
    float d = oceanHash(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, smoothFrac.x), mix(c, d, smoothFrac.x), smoothFrac.y);
}

// Multiplier on the slope variance at this point. Centred on 1 so the AREA-AVERAGED
// sea state still matches the wind speed that was asked for — gustiness redistributes
// roughness, it does not add any.
//
// windCoords is (along-wind, cross-wind) position in metres relative to a nearby
// origin. Anisotropic on purpose: streaks run with the wind.
float oceanGustiness(vec2 windCoords, float strength, float drift, float scale) {
    if (strength <= 0.0) return 1.0;
    // Stretched along the wind, so the patches become streaks rather than blobs.
    //
    // The SIZE of the patches has to scale with the wind. A fixed size is the obvious
    // thing to write and it is wrong at both ends: at 1600 m along-wind, a lake seen
    // from its own shore sits inside a single cell and the modulation vanishes
    // entirely — verified with the gustiness debug view, which showed one flat grey
    // field across the whole near shore. Cat's-paws in light air are tens of metres
    // across, not kilometres.
    vec2 streak = vec2(windCoords.x / scale, windCoords.y / (scale * 0.2));
    float noise = oceanValueNoise(streak + vec2(drift * 0.02, 0.0)) - 0.5;
    // A second, larger scale so the patches themselves vary in strength, which is
    // what stops the streaks reading as a regular corduroy.
    noise += 0.5 * (oceanValueNoise(streak * 0.31 + vec2(drift * 0.006, 11.3)) - 0.5);
    return max(0.25, 1.0 + strength * noise * 1.3);
}

// --- the resolved wave field ----------------------------------------------
//
// Slope of the sea surface at a point, summed over travelling wave trains, together
// with the slope variance of every train this pixel is too far away to resolve.
//
// The split is EXACT, which is the main reason for building the surface this way. Each
// component gets a weight from how its wavelength compares with the pixel footprint:
//
//   * fully resolved  -> weight 1, its slope enters the sum, none of its variance
//                        reaches the BRDF;
//   * fully unresolved-> weight 0, no slope, all of its variance reaches the BRDF;
//   * in between      -> amplitude scales by w, so variance scales by w^2, and the
//                        BRDF takes the remaining (1 - w^2). Nothing is counted twice
//                        and nothing is dropped.
//
// A grid-based method has to approximate the same split with per-mip variance tables,
// where it is easy to double-count the frequencies a trilinear tap already retained.
// Here there is nothing to approximate.
//
// waveData packs one component per texel: (kx, ky, amplitude, phase), with the
// wavevector in the wind-aligned frame. omega is recovered from |k| rather than stored
// so the texture stays four channels.
struct OceanSurface {
    vec2 slope;
    vec2 residualVariance;
};

// footprintAlong / footprintAcross are the semi-axes of the pixel's footprint ellipse
// on the water, and viewAxis is the along-view direction expressed in the wind frame.
//
// THE FOOTPRINT IS AN ELLIPSE, NOT A CIRCLE, and at grazing incidence it is a violently
// eccentric one: looking across a lake from 38 m up, a pixel covers 0.44 m across the
// view but 11.7 m along it at a kilometre, and 53:1 by two.
//
// Testing every wave against the LONG axis — the obvious scalar simplification —
// declares all of them unresolved past a few hundred metres, and the ripples stop dead
// at a visible line. But a wave whose crests run parallel to the view direction varies
// ACROSS the view, where the footprint is still centimetres. Those are perfectly
// resolvable, and they are what real water shows at grazing: long crests reaching away
// into the distance.
//
// So each wave is tested against the footprint measured ALONG ITS OWN direction of
// travel, which is the projection of the ellipse onto that direction. For a texture-
// based wave field this would need EWA filtering and would not be worth it; here every
// component carries its own wavevector, so it costs one dot product and is exact.
OceanSurface oceanWaveSurface(
    sampler2D waveData, float waveCount, float waveTexels,
    vec2 windCoords, float time,
    float footprintAlong, float footprintAcross, vec2 viewAxis
) {
    OceanSurface surface;
    surface.slope = vec2(0.0);
    surface.residualVariance = vec2(0.0);

    for (int index = 0; index < OCEAN_MAX_WAVES; index++) {
        if (float(index) >= waveCount) break;

        vec4 wave = texture2D(waveData, vec2((float(index) + 0.5) / waveTexels, 0.5));
        vec2 waveVector = wave.xy;
        float amplitude = wave.z;
        float phaseOffset = wave.w;

        float k = length(waveVector);
        float wavelength = 6.28318531 / max(k, 1e-6);

        // Footprint measured along THIS wave's direction of travel: the projection of
        // the footprint ellipse onto that direction.
        vec2 waveDir = waveVector / max(k, 1e-6);
        float alongComponent = dot(waveDir, viewAxis);
        float acrossComponent = dot(waveDir, vec2(-viewAxis.y, viewAxis.x));
        float footprint = sqrt(
              footprintAlong * footprintAlong * alongComponent * alongComponent
            + footprintAcross * footprintAcross * acrossComponent * acrossComponent);

        // Sampling theorem, with a couple of pixels of margin: a wave shorter than
        // about twice the footprint cannot be represented and would alias into
        // crawling noise, so it becomes roughness instead.
        float weight = smoothstep(1.0, 3.0, wavelength / max(footprint, 1e-4));

        // Variance this component carries, split onto the wind-aligned axes.
        vec2 axis = waveVector / max(k, 1e-6);
        float variance = 0.5 * amplitude * amplitude * k * k;
        vec2 axisVariance = variance * axis * axis;

        // Whatever the resolved sum does not carry, the BRDF does.
        surface.residualVariance += axisVariance * (1.0 - weight * weight);

        if (weight > 0.0) {
            // omega^2 = g k (1 + (k/km)^2)
            float omega = sqrt(9.81 * k * (1.0 + (k / 370.0) * (k / 370.0)));
            float phase = dot(waveVector, windCoords) - omega * time + phaseOffset;
            // d/dx of a*cos(phase) is -a*k*sin(phase): the slope comes out
            // analytically, with no differencing of a height map.
            surface.slope -= waveVector * (amplitude * weight * sin(phase));
        }
    }
    return surface;
}

// Half-angle of the reflection lobe, used to choose how hard to blur the environment.
// A slope deviation tilts the reflected ray by twice as much, hence the factor of two.
float oceanLobeAngle(vec2 sigma2) {
    return 2.0 * sqrt(max(0.5 * (sigma2.x + sigma2.y), 1e-9));
}
`;
