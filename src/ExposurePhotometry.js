// ExposurePhotometry.js
//
// Photometry and sampling shared by the long-exposure render (LongExposure.js)
// and its live preview (TimelapsePreview.js). Both must agree exactly on where
// the samples fall, how bright each source is and how the atmosphere dims it,
// or the preview would not show what the render will record.
//
// Pure functions, no scene access: unit-tested in tests/ExposurePhotometry.test.js.

import {degrees, radians} from "./mathUtils";
import {flareRamp} from "../tools/shf/flarePhysics.js";
import {satelliteAppearance, satelliteSunlitFraction} from "./SatelliteBrightness";

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
export function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
}

// ---------------------------------------------------------------------------
// Point spread

// The PSF sigma in pixels, as the splat uses it.
export function psfSigmaPx(psfSigma) {
    return Math.max(0.2, psfSigma);
}

// Half-size of the splat kernel in pixels: the kernel is (2r+1) pixels square.
export function psfRadiusPx(psfSigma) {
    return Math.min(7, Math.max(1, Math.ceil(3 * psfSigmaPx(psfSigma))));
}

// Fraction of a point source's energy that falls in a one-pixel-wide band
// centred on it, along one axis.
export function psfCentreFraction(psfSigma) {
    return erf(0.5 / (Math.SQRT2 * psfSigmaPx(psfSigma)));
}

// u*erf(u) + exp(-u^2)/sqrt(pi): the integral of erf.
function erfIntegral(u) {
    return u * erf(u) + Math.exp(-u * u) / Math.sqrt(Math.PI);
}

// A source that moves `lengthPx` pixels in a straight line during one exposure
// window spreads its energy along that path. This is the fraction of the energy
// that the pixel at the middle of the path receives, along the path. The same
// fraction across the path is psfCentreFraction. A static source gives
// psfCentreFraction; a long streak gives about 1 / lengthPx.
export function alongTrackFraction(lengthPx, psfSigma) {
    const k = 1 / (Math.SQRT2 * psfSigmaPx(psfSigma));
    const L = Math.abs(lengthPx);
    if (L < 1e-3) return erf(0.5 * k);
    return (erfIntegral(k * (0.5 + L / 2)) - erfIntegral(k * (0.5 - L / 2))) / (k * L);
}

// ---------------------------------------------------------------------------
// Sampling

// Frame offsets (from the exposure start) at which the render samples the world.
// Continuous exposure: every `step` frames, ending exactly on numFrames.
// Brightest-pixel stack: the same, merged with the exact boundaries of the
// stack windows, so that no interval straddles two windows.
export function exposureSampleOffsets({numFrames, step, stackMode, stackFrames}) {
    if (!stackMode) {
        const n = Math.ceil(numFrames / step) + 1;
        const offsets = new Array(n);
        for (let s = 0; s < n; s++) offsets[s] = Math.min(s * step, numFrames);
        return offsets;
    }
    const offsets = [0];
    const frameEpsilon = Math.max(1, numFrames) * 1e-12;
    let regular = step, boundaryIndex = 1;
    while (offsets.at(-1) < numFrames) {
        const boundary = Math.min(numFrames, boundaryIndex * stackFrames);
        const next = Math.abs(regular - boundary) <= frameEpsilon ? boundary : Math.min(regular, boundary);
        if (next - offsets.at(-1) > frameEpsilon) offsets.push(next);
        else offsets[offsets.length - 1] = next;
        if (regular <= next + frameEpsilon) regular += step;
        if (boundary <= next + frameEpsilon) boundaryIndex++;
    }
    return offsets;
}

// ---------------------------------------------------------------------------
// Atmospheric extinction

// Kasten-Young 1989 airmass at apparent altitude. Capped at the grazing-ray
// tangent value (~28, including refraction path-shortening) rather than the
// plane-parallel 38: a horizon ray grazes the limb and rises out of the air,
// it does not keep accumulating column. Below 0° apparent (a dipped horizon
// seen from altitude) the airmass HOLDS at the horizon value — extrapolating
// the plane-parallel fit below 0° badly over-counts a rising grazing ray.
const AIRMASS_TANGENT = 28;
export function airmassKY(sinAlt) {
    const altDeg = Math.max(0, degrees(Math.asin(Math.min(1, Math.max(-1, sinAlt)))));
    const s = Math.sin(radians(altDeg));
    const am = 1 / (s + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
    return Math.min(AIRMASS_TANGENT, Math.max(1, am));
}

// Chromatic extinction: R/G/B multipliers on the base (V-band) coefficient at
// the effective sRGB primaries 620/550/460nm — Rayleigh (λ⁻⁴) + typical clear
// aerosol + ozone Chappuis (expert-reviewed clear-air breakdown).
export const EXT_RGB = [0.72, 1.00, 1.77];

// Heterochromatic (Forbes) correction: a wide sRGB channel does NOT extinct
// exponentially in airmass — as the column grows, the surviving flux shifts
// to the channel's red (low-extinction) edge, so the effective coefficient
// FALLS with airmass. Without this, a monochromatic law applied linearly to
// X≈30+ over-reddens the horizon by ~2.5 magnitudes of B−R differential.
// Modeled as a per-channel effective airmass X/(1 + a·X); a values for ~90nm
// channels at k_V = 0.16, scaled linearly with the actual coefficient.
const EXT_FORBES_A = [0.0012, 0.0030, 0.0058];

// Per-channel transmittance for a source at apparent altitude sinAlt.
// kAltScale is the observer's pressure-altitude factor exp(-h/8400m): an
// airborne camera sits above most of the extinction.
// Targets the observed horizon differential B−R ≈ 3.5-4 mag (B/R ~25-60),
// not the naive monochromatic ~6.7 mag (~470) which looks blood-red.
// Returns a SHARED buffer, overwritten by the next call: copy what you keep.
const _ext3 = new Float32Array(3);
export function extinctionRGB(sinAlt, kBase, kAltScale, chromatic) {
    if (kBase <= 0) { _ext3[0] = _ext3[1] = _ext3[2] = 1; return _ext3; }
    const X = airmassKY(sinAlt);
    const kEff = kBase * kAltScale;
    const aScale = kEff / 0.16;            // Forbes curvature scales with the coefficient
    if (!chromatic) {
        // achromatic: V-band dimming on all channels, no color shift
        const Xe = X / (1 + EXT_FORBES_A[1] * aScale * X);
        _ext3[0] = _ext3[1] = _ext3[2] = Math.pow(10, -0.4 * kEff * (Xe - 1));
        return _ext3;
    }
    for (let c = 0; c < 3; c++) {
        const a = EXT_FORBES_A[c] * aScale;
        const Xe = X / (1 + a * X);
        _ext3[c] = Math.pow(10, -0.4 * kEff * EXT_RGB[c] * (Xe - 1));
    }
    return _ext3;
}

// Pressure-altitude extinction scale and the dipped-horizon limit for an
// observer at altitude camAltM (metres above the ellipsoid, clamped at 0).
export function observerExtinction(camAltM) {
    const h = Math.max(0, camAltM);
    return {
        kAltScale: Math.exp(-h / 8400),
        horizonSin: -(Math.sqrt(2 * h / 6371000) + 0.01),
    };
}

// ---------------------------------------------------------------------------
// Source brightness

// Intrinsic blue-white tint of splatted stars (Star Tint dial): lerp from flat
// white toward the bright-star population average [.78, .90, 1.10].
export function starTintRGB(tint) {
    const tt = Math.max(0, tint ?? 1);
    return [1 + tt * (0.78 - 1), 1 + tt * (0.90 - 1), 1 + tt * (1.10 - 1)];
}

// Linear flux of a star or planet of magnitude `mag`; 1 = a source of satMag.
export function magnitudeFlux(mag, satMag) {
    return Math.pow(10, -0.4 * (mag - satMag));
}

// satellite splat calibration: apparent magnitude of a full (ramp=1) flare,
// and of the sunlit ISS. Only flaring satellites (+ the lit ISS) are splatted.
const SAT_FLARE_PEAK_MAG = -4;
const ISS_MAG = -2;
// The flare cone's falloff band fades the flare by this many MAGNITUDES.
// A linear ramp is photometrically instantaneous here (peak is ~1600x pixel
// saturation, so the square-law band crosses the whole visible range in its
// last ~1%) — streaks would start and end at full brightness. Fading in
// magnitude space makes the streak taper smoothly to zero at both ends
// while the core still flares at full peak.
const SAT_FLARE_TAPER_MAGS = 13;

// Linear flux of a satellite at `ecef`, seen from `observer` with the Sun in
// direction `toSun`, before observer-path extinction. `settings` holds the
// satellite models and the earth model (CSatellite.brightnessSettings);
// `satData` needs only name and number. 0 when the satellite is in shadow. A
// caller that knows the sunlit fraction already can pass it as `illumination`.
export function satelliteExposureFlux(settings, satData, ecef, observer, toSun, satMag, illumination = undefined) {
    illumination ??= satelliteSunlitFraction(ecef, toSun, settings);
    if (!(illumination > 0)) return 0;
    const appearance = satelliteAppearance(satData, ecef, observer, toSun, illumination, settings);
    if (settings.brightnessModel === "Photometric estimate") {
        return appearance.flux * Math.pow(10, 0.4 * satMag);
    }
    // Explicit compatibility mode for older cone renders.
    let flux = satData.number === 25544 ? magnitudeFlux(ISS_MAG, satMag) : 0;
    if (appearance.glintAngleDeg < settings.flareAngle) {
        flux += magnitudeFlux(SAT_FLARE_PEAK_MAG, satMag) * Math.pow(10,
            -0.4 * SAT_FLARE_TAPER_MAGS * (1 - flareRamp(appearance.glintAngleDeg, settings.flareAngle)));
    }
    return flux * illumination;
}

// ---------------------------------------------------------------------------
// Trail vertices for the preview

// Choose where a trail's `segments` straight segments start and end. `times`
// and `bright` are the samples of one source (bright = displayed brightness,
// 0..1, any monotonic display scale). Only the visible span is drawn: from the
// last dark sample before the source becomes visible to the first dark sample
// after it fades, so the drawn line fades in and out like the render. Inside
// that span the vertices are spaced half by time and half by change of
// brightness, so a short bright peak gets vertices on its rise, top and fall.
// Returns sorted unique sample indices, or null when nothing is visible.
export function chooseTrailVertices(times, bright, segments, threshold) {
    const n = bright.length;
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
        if (bright[i] >= threshold) {
            if (first < 0) first = i;
            last = i;
        }
    }
    if (first < 0) return null;
    const i0 = Math.max(0, first - 1), i1 = Math.min(n - 1, last + 1);
    if (i1 === i0) return [i0];
    const span = times[i1] - times[i0];
    let variation = 0;
    for (let i = i0 + 1; i <= i1; i++) variation += Math.abs(bright[i] - bright[i - 1]);
    // cumulative measure, 0..1 over the span
    const measure = new Float64Array(i1 - i0 + 1);
    for (let i = i0 + 1; i <= i1; i++) {
        const dt = span > 0 ? (times[i] - times[i - 1]) / span : 1 / (i1 - i0);
        const db = variation > 0 ? Math.abs(bright[i] - bright[i - 1]) / variation : dt;
        measure[i - i0] = measure[i - i0 - 1] + 0.5 * dt + 0.5 * db;
    }
    const total = measure[i1 - i0];
    const out = [i0];
    const nSeg = Math.max(1, Math.round(segments));
    let j = i0;
    for (let k = 1; k < nSeg; k++) {
        const target = total * k / nSeg;
        while (j < i1 && measure[j + 1 - i0] < target) j++;
        // the nearer of the two samples around the target
        const pick = (j < i1 && measure[j + 1 - i0] - target < target - measure[j - i0]) ? j + 1 : j;
        if (pick > out.at(-1) && pick < i1) out.push(pick);
    }
    out.push(i1);
    // A sharp step puts several targets on the same sample. Give the vertices
    // that lost out to the longest segments, so the trail keeps its count.
    while (out.length - 1 < nSeg) {
        let longest = -1, longestSpan = 0;
        for (let k = 0; k + 1 < out.length; k++) {
            if (out[k + 1] - out[k] < 2) continue;
            const s = times[out[k + 1]] - times[out[k]];
            if (s > longestSpan) { longestSpan = s; longest = k; }
        }
        if (longest < 0) break;
        out.splice(longest + 1, 0, Math.round((out[longest] + out[longest + 1]) / 2));
    }
    return out;
}
