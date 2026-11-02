// Approximate visible-band satellite photometry, shared by live and exposure renders.
// Output is linear flux relative to a magnitude-zero star, BEFORE observer-path
// extinction, camera exposure/PSF, and any display brightness control.
//
// Horizon curves: Mallama & Cole (2024), Figure 3, https://arxiv.org/pdf/2405.13091 .
// The paper plots m1000 = intercept + slope*log10(off-specular degrees), but does
// not print the coefficients. The values below are rounded digitizations of the
// FITTED LINES in the original embedded figure, not fits to a scene photograph.
// They describe empirical total horizon-flare brightness, not a component BRDF.
// About 2-20 degrees is supported by the plot (the end range varies by design).
// The paper does not explicitly remove eclipse/solar-limb attenuation from those
// observations. Treating its curves as an unobscured solar reference and applying
// a separate illumination fraction is an assumption; calibration samples near
// shadow could already contain some of that dimming. Absolute flux is uncertain.
//
// The finite core and the 20-60 degree blend into an estimated diffuse baseline
// are explicit extrapolations. A 5-degree analysis cone is not a flux cutoff.
// Exact attitudes, articulated parts, flight state and Earthshine are unavailable.
// A full component BRDF needs those extra inputs: Lu (2024),
// https://arxiv.org/pdf/2403.05831 ; Kandula et al. (2025),
// https://arxiv.org/html/2506.19092v1 (especially its near-horizon limitations).

const REFERENCE_RANGE_M = 1e6;
const SUN_VISUAL_MAGNITUDE = -26.74;
const SUPPORTED_WING_DEG = 20;
const BASELINE_ONLY_DEG = 60;
const SOLAR_RADIUS_DEG = 0.266;

export const SATELLITE_PHOTOMETRY = Object.freeze({
    label: "Estimated satellite photometry",
    // Provenance only, never fetched: written as the arXiv identifier, not a URL, so the
    // egress scan does not take a citation for a network destination.
    source: "arXiv:2405.13091",
    curveProvenance: "Approximate digitization of Figure 3 fitted lines at 1000 km",
    supportedOffSpecularDeg: Object.freeze([2, 20]),
    // A modelling caution, not a Gaussian confidence interval: even the more
    // complete 2025 V2 model has 0.89-mag RMS near the Sun direction, while
    // unknown flight state or hardware can change brightness by much more.
    uncertainty: "At least about 1 magnitude; unknown attitude or design can change brightness by several magnitudes",
    unknownProfile: "Equal-weight flux mixture of four measured designs; not a population estimate",
    core: "Estimated smooth finite core; the V1.5 on-beam extension is about magnitude -5 at 1000 km",
    illuminationCalibration: "Published flare fits do not state an eclipse correction; treating them as unobscured references may repeat some calibration dimming",
    wing: "Estimated smooth blend from 20 to 60 degrees into diffuse brightness",
    diffuse: "Estimated Lambert phase law through each Starlink design's published magnitude at 90 degrees and 1000 km",
    other: "Other satellites: mean projected area from the GCAT size (or the radar size class), 0.2 diffuse albedo; attitude is not known",
});

// Diffuse brightness of each design: its published phase polynomial (1000-km
// magnitude against phase angle in degrees) evaluated at 90 degrees. Only that one
// value is used, through the Lambert phase shape, as before for the V2 Mini.
//   V1.0, VisorSat, V1.5: Mallama et al. (2022), arXiv:2210.17268, Table 1:
//     4.774 + .02496a - .0001023a^2 = 6.19; 3.493 + .09481a - .0005412a^2 = 7.64;
//     3.944 + .06893a - .0004089a^2 = 6.84 ("Post-VisorSat" is V1.5).
//   V2 Mini: the DARKNESS polynomial, 7.50 (see satelliteFlux).
//   Direct to Cell: Mallama et al. (2025), arXiv:2502.03651, Table 1, "DTC Late"
//     (brightness mitigation on, observed after 2024 June 30):
//     3.365 + .06376a - 1.716e-4a^2 - 1.139e-6a^3 = 6.88.
// No horizon-flare curve is published for Direct to Cell, so it uses the V2 Mini
// curve: the same chassis carries the extra antenna. That is an assumption.
const MINI_DIFFUSE_AT_90 = 7.501719;
export const STARLINK_PROFILES = Object.freeze({
    unknown: Object.freeze({label: "Unknown design (estimated mixture)"}),
    "v1.0": Object.freeze({label: "Original V1.0", intercept: -1.10, slope: 4.78, diffuseMagnitudeAt90Deg: 6.192}),
    visor: Object.freeze({label: "VisorSat", intercept: -3.54, slope: 8.52, diffuseMagnitudeAt90Deg: 7.642}),
    "v1.5": Object.freeze({label: "V1.5", intercept: -2.16, slope: 6.02, diffuseMagnitudeAt90Deg: 6.836}),
    mini: Object.freeze({label: "V2 Mini", intercept: -2.40, slope: 5.59, diffuseMagnitudeAt90Deg: MINI_DIFFUSE_AT_90}),
    dtc: Object.freeze({label: "V2 Mini Direct to Cell", intercept: -2.40, slope: 5.59, diffuseMagnitudeAt90Deg: 6.883}),
});

const MEASURED_PROFILES = [STARLINK_PROFILES["v1.0"], STARLINK_PROFILES.visor,
    STARLINK_PROFILES["v1.5"], STARLINK_PROFILES.mini];

// The unknown design takes the same equal-weight mixture for its diffuse flux as for
// its flare: about magnitude 6.88 at 90 degrees.
const UNKNOWN_DIFFUSE_FLUX_AT_90 = MEASURED_PROFILES.reduce(
    (sum, profile) => sum + 10 ** (-0.4 * profile.diffuseMagnitudeAt90Deg), 0) / MEASURED_PROFILES.length;

// The Starlink Design value that takes each satellite's design from the catalog
// (GCAT, see src/SatelliteSizes.js) instead of one design for all.
export const STARLINK_PER_SATELLITE = "catalog";

// GCAT design (scripts/buildSatelliteSizes.js) -> STARLINK_PROFILES key. A design
// that is not listed (V0.9, test flights) is unknown. V2 Mini Optimized has no
// published photometry under that name, so the V2 Mini profile is assumed for it.
export const STARLINK_DESIGN_PROFILES = Object.freeze({
    "v1.0": "v1.0", visor: "visor", "v1.5": "v1.5", v2m: "mini", v2mo: "mini", v2md: "dtc",
});

export function starlinkProfileForDesign(design) {
    return STARLINK_DESIGN_PROFILES[design] ?? "unknown";
}

// Kuiper (Amazon Leo): an ESTIMATE. No horizon-flare curve is published for these
// spacecraft. Mallama et al. (2026), arXiv:2601.07708, report a partly mirror-faced
// nadir panel and reflective characteristics "similar to Version 1 Starlink
// spacecraft", so the V1.0 curve is assumed. It is not scaled for panel size, which is
// not published. It assumes the operational attitude; the paper shows a different
// attitude during orbit raising. The diffuse reference is read by eye from the
// operational points near 90 degrees phase in the paper's Figure 8. The paper's 6.8
// mean is not used, because it averages over the bright ends of the phase curve.
export const KUIPER_PHOTOMETRY = Object.freeze({
    label: "Kuiper (Amazon Leo) estimate",
    source: "arXiv:2601.07708",
    flareProfile: "v1.0",
    diffuseMagnitudeAt90Deg: 7.1,
});

export function magnitudeToFlux(magnitude) {
    return magnitude === Infinity ? 0 : 10 ** (-0.4 * magnitude);
}

export function fluxToMagnitude(flux) {
    return flux > 0 ? -2.5 * Math.log10(flux) : Infinity;
}

// Normalized disk-integrated phase function of a Lambert sphere. This is an
// estimated baseline for a complex spacecraft, not a claim that it is spherical.
export function lambertPhaseFunction(phaseAngleRad) {
    if (!Number.isFinite(phaseAngleRad)) return 0;
    const angle = Math.max(0, Math.min(Math.PI, phaseAngleRad));
    if (angle === Math.PI) return 0;
    return Math.max(0, (Math.sin(angle) + (Math.PI - angle) * Math.cos(angle)) / Math.PI);
}

function wingWeight(angleDeg) {
    if (angleDeg <= SUPPORTED_WING_DEG) return 1;
    if (angleDeg >= BASELINE_ONLY_DEG) return 0;
    const x = (angleDeg - SUPPORTED_WING_DEG) / (BASELINE_ONLY_DEG - SUPPORTED_WING_DEG);
    return 1 - x * x * (3 - 2 * x);
}

function fittedFlareFlux(angleDeg, coefficients) {
    // The log fit diverges on-axis. A quartic soft core preserves the digitized
    // 2-20 degree fit while bounding the extrapolation. The -5 mag extension is
    // motivated by the V1.5 discussion/Figure 5, not measured for every design.
    // Other profiles use the same estimated bound and at least the solar radius.
    const core = Math.max(SOLAR_RADIUS_DEG, 10 ** ((-5 - coefficients.intercept) / coefficients.slope));
    const effectiveAngle = (angleDeg ** 4 + core ** 4) ** 0.25;
    return magnitudeToFlux(coefficients.intercept + coefficients.slope * Math.log10(effectiveAngle));
}

function flareFluxAt1000km(glintAngleDeg, profile) {
    if (!Number.isFinite(glintAngleDeg) || glintAngleDeg < 0) return 0;
    const weight = wingWeight(glintAngleDeg);
    if (weight === 0) return 0;
    const selected = STARLINK_PROFILES[profile];
    if (selected?.slope !== undefined) return weight * fittedFlareFlux(glintAngleDeg, selected);
    // Unknown really means unknown: no catalogue-number or orbit-family guess.
    // This unweighted mixture is a transparent rendering assumption, not an
    // inference about the constellation's design fractions at the scene date.
    let flux = 0;
    for (const coefficients of MEASURED_PROFILES) flux += fittedFlareFlux(glintAngleDeg, coefficients);
    return weight * flux / MEASURED_PROFILES.length;
}

// Reference horizon contribution, including estimated core/wing continuation.
// Within the bright observed lobe it closely approximates Figure 3's TOTAL
// magnitude. Adding the faint diffuse estimate is negligible for bright flares,
// but is a phenomenological continuation, not a separately measured component.
export function starlinkFlareMagnitude(glintAngleDeg, profile = "unknown") {
    return fluxToMagnitude(flareFluxAt1000km(glintAngleDeg, profile));
}

/**
 * Instantaneous flux, in magnitude-zero-star units.
 *
 * rangeM: observer-to-satellite range in metres.
 * phaseAngleRad: Sun-satellite-observer angle, 0=fully lit, pi=backlit.
 * glintAngleDeg: angle from the nadir-chassis specular ray, in degrees.
 * starlink/profile: explicitly supplied classification, never inferred here.
 * flareProfile: a STARLINK_PROFILES key that gives a satellite that is not a
 *   Starlink an assumed flare curve, independent of the selected Starlink design.
 * illumination: solar flux fraction, including eclipse/limb transmission, 0..1.
 * diffuseMagnitudeAt90Deg: optional assumed magnitude at 1000 km/90-degree
 *   phase, for known large objects or a sensitivity study. No built-in ISS
 *   area/attitude guess is made. A Starlink without it uses its design's value.
 *   Otherwise generic satellites use the optional diffuseAreaM2 (mean projected
 *   area; 1 square metre when nothing is known) and diffuseAlbedo (Lambert
 *   reflectance).
 *
 * Missing phase defaults to 90 degrees, an explicit estimated geometry. Invalid
 * geometry produces zero flux so a failed orbit cannot contaminate HDR buffers.
 * Caller applies observer atmosphere, obscuration and detector integration once.
 */
export function satelliteFlux({
    rangeM,
    phaseAngleRad = Math.PI / 2,
    glintAngleDeg,
    starlink = false,
    profile = "unknown",
    flareProfile,
    illumination = 1,
    diffuseMagnitudeAt90Deg,
    diffuseAreaM2 = 1,
    diffuseAlbedo = 0.2,
} = {}) {
    if (!(rangeM > 0) || !Number.isFinite(rangeM) || !Number.isFinite(phaseAngleRad)
        || !Number.isFinite(illumination)) return 0;
    const lit = Math.max(0, Math.min(1, illumination));
    if (lit === 0) return 0;
    const phase = lambertPhaseFunction(phaseAngleRad);
    let baseline;
    if (Number.isFinite(diffuseMagnitudeAt90Deg) || starlink) {
        // The V2 Mini's 7.501719 comes from the published Mini DARKNESS polynomial
        // at 90 deg: 6.657 - .05474*a + .001438*a^2 - .000008061*a^3.
        // Mallama et al. (2024), Table 1, https://arxiv.org/pdf/2401.01546 .
        // The other designs are listed with STARLINK_PROFILES. The Lambert shape is
        // an estimate; we do not add the polynomials' forward-scatter rise a second time.
        const flux90 = Number.isFinite(diffuseMagnitudeAt90Deg) ? magnitudeToFlux(diffuseMagnitudeAt90Deg)
            : Number.isFinite(STARLINK_PROFILES[profile]?.diffuseMagnitudeAt90Deg)
                ? magnitudeToFlux(STARLINK_PROFILES[profile].diffuseMagnitudeAt90Deg)
                : UNKNOWN_DIFFUSE_FLUX_AT_90;
        baseline = flux90 * Math.PI * phase;
    } else {
        if (!(diffuseAreaM2 >= 0) || !Number.isFinite(diffuseAreaM2)
            || !(diffuseAlbedo >= 0) || !Number.isFinite(diffuseAlbedo)) return 0;
        // Lambert sphere geometric albedo = 2*rho/3, projected area = pi*r^2.
        // Multiply its solar-flux fraction by the magnitude-zero solar flux.
        baseline = magnitudeToFlux(SUN_VISUAL_MAGNITUDE) * (2 / 3) * diffuseAlbedo
            * (diffuseAreaM2 / Math.PI) / REFERENCE_RANGE_M ** 2 * phase;
    }
    const curve = starlink ? profile : flareProfile;
    const horizon = curve === undefined ? 0 : flareFluxAt1000km(glintAngleDeg, curve);
    return lit * (baseline + horizon) * (REFERENCE_RANGE_M / rangeM) ** 2;
}

export function satelliteMagnitude(options) {
    return fluxToMagnitude(satelliteFlux(options));
}
