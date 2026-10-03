import {solvePath} from "./atmosphere.js";

// Published model from a published turbulence study. Applying a statistical
// profile to a scene is estimated.
export const TURBULENCE_MODEL = Object.freeze({
    status: "estimated",
    source: "Published turbulence study; coherence diameter as in a published sensor-modeling library",
    referenceWavelengthM: 4e-6, // calculated reference convention, mid-band 3–5 um
    groundCn2: 1.7e-14, // published HV 5/7, m^(-2/3)
    windSpeedMS: 21, // published HV 5/7 upper-air parameter, m/s; not pupil wind
});

/** Hufnagel–Valley Cn² [m^(-2/3)], height above sea level [m]. Parameters:
 * groundCn2 [m^(-2/3)], windSpeedMS [m/s], multiplier [1]. The sea-level
 * height reference and any transfer to a particular path are estimated.
 */
export function hufnagelValley(altitudeM, {groundCn2 = TURBULENCE_MODEL.groundCn2,
    windSpeedMS = TURBULENCE_MODEL.windSpeedMS, multiplier = 1} = {}) {
    for (const value of [altitudeM, groundCn2, windSpeedMS, multiplier])
        if (!Number.isFinite(value) || value < 0) throw new RangeError("HV parameters must be finite and nonnegative");
    return multiplier * (0.00594 * (windSpeedMS / 27) ** 2 * (1e-5 * altitudeM) ** 10 * Math.exp(-altitudeM / 1000) +
        2.7e-16 * Math.exp(-altitudeM / 1500) + groundCn2 * Math.exp(-altitudeM / 100));
}

/** Calculated Fried coherence diameter [m], r0(lambda)=r0(ref)(lambda/ref)^(6/5).
 * Infinity is the physical zero-turbulence limit; the renderer uses 0 as off.
 */
export function scaleR0(r0M, wavelengthM, referenceWavelengthM = TURBULENCE_MODEL.referenceWavelengthM) {
    if (!(r0M > 0) || !(wavelengthM > 0 && Number.isFinite(wavelengthM)) ||
        !(referenceWavelengthM > 0 && Number.isFinite(referenceWavelengthM))) throw new RangeError("Invalid r0 or wavelength");
    return r0M * (wavelengthM / referenceWavelengthM) ** (6 / 5);
}

/** Integrate along a spherical, unrefracted ray from receiver s=0 to source s=L.
 * geometry uses solvePath SI units. A caller can supply cn2(h,s) [m^(-2/3)]
 * for layers or alternative profiles; HV parameters are otherwise passed through.
 * Calculated trapezoid quadrature: 20000 intervals (20001 samples), a numerical
 * choice. Js=integral Cn²(1-s/L)^(5/3) ds; Jtheta=integral Cn² s^(5/3) ds.
 * Fried constants 0.423 and 2.91: published study; spherical weighting as in a
 * published sensor-modeling library.
 */
export function integrateTurbulence(geometry, {wavelengthM = TURBULENCE_MODEL.referenceWavelengthM,
    referenceWavelengthM = TURBULENCE_MODEL.referenceWavelengthM, segments = 20000,
    cn2 = null, ...profile} = {}) {
    scaleR0(1, wavelengthM, referenceWavelengthM);
    if (!Number.isInteger(segments) || segments < 2) throw new RangeError("At least two turbulence intervals required");
    const path = solvePath(geometry), length = path.slantRangeM;
    if (path.occluded) throw new RangeError("Turbulence path crosses the surface");
    let planeIntegral = 0, sphericalIntegral = 0, angularIntegral = 0;
    for (let i = 0; i <= segments; i++) {
        const fraction = i / segments, distanceM = fraction * length;
        // solvePath already rejects real surface crossings; clamp its accepted
        // endpoint roundoff with the same convention as atmosphere.sample().
        const altitudeM = Math.max(0, path.altitudeAt(distanceM));
        const value = cn2 ? cn2(altitudeM, distanceM) : hufnagelValley(altitudeM, profile);
        if (!Number.isFinite(value) || value < 0) throw new RangeError("Cn² must be finite and nonnegative");
        const weight = value * length / segments * (i === 0 || i === segments ? 0.5 : 1);
        planeIntegral += weight;
        sphericalIntegral += weight * (1 - fraction) ** (5 / 3);
        angularIntegral += weight * distanceM ** (5 / 3);
    }
    const k2 = (2 * Math.PI / wavelengthM) ** 2;
    const r0M = (0.423 * k2 * sphericalIntegral) ** (-3 / 5);
    return {r0M, r0ReferenceM: scaleR0(r0M, referenceWavelengthM, wavelengthM),
        planeR0M: (0.423 * k2 * planeIntegral) ** (-3 / 5),
        isoplanaticAngleRad: (2.91 * k2 * angularIntegral) ** (-3 / 5),
        wavelengthM, referenceWavelengthM, planeIntegral, sphericalIntegral, angularIntegral,
        sampleCount: segments + 1, status: "calculated", source: TURBULENCE_MODEL.source,
        profileStatus: "estimated", geometry: path};
}

/** Long-exposure Kolmogorov MTF, angular frequency in cycles/radian.
 * r0 is in m at 4 um. Published Fried form exp[-3.44(lambda*f/r0)^(5/3)].
 * No finite-exposure wind or tilt-removal correction is inferred.
 */
export function turbulenceMTF(frequencyPerRad, wavelengthM, r0ReferenceM = 0) {
    if (!Number.isFinite(frequencyPerRad) || frequencyPerRad < 0 ||
        !Number.isFinite(r0ReferenceM) || r0ReferenceM < 0) throw new RangeError("Invalid turbulence MTF controls");
    if (r0ReferenceM === 0) return 1;
    return Math.exp(-3.44 * (wavelengthM * frequencyPerRad / scaleR0(r0ReferenceM, wavelengthM)) ** (5 / 3));
}
