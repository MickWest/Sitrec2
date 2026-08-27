// umbralLight.js
//
// The light inside the Earth's umbra — i.e. the colour of a "blood moon".
//
// No direct sunlight reaches the umbra by definition, so every photon that
// lands there has grazed the Earth and been REFRACTED into the shadow by the
// atmosphere. On the way it crossed a very long slant path (a tangent ray at
// 10 km altitude sees ~70x the vertical air column), which strips the blue by
// Rayleigh scattering and takes a further bite out of 500-700 nm through the
// ozone Chappuis band. What survives is the deep copper red of totality, with
// the well-known turquoise fringe just inside the umbral edge where the ray
// path was high enough that ozone dominates over Rayleigh.
//
// This module computes that from first principles rather than tinting:
//
//   1. US Standard Atmosphere 1976 -> number density n(z).
//   2. Slant columns for a tangent ray, via the substitution r = sqrt(b^2+s^2)
//      which removes the integrable 1/sqrt(r^2-b^2) singularity entirely.
//   3. Refractive bending omega(b) from the same density profile
//      (refractivity is proportional to density - Gladstone-Dale).
//   4. Map perigee altitude -> landing radius in the shadow plane,
//      rho(h) = b - d*omega(h), depositing each interval's annulus power over
//      the annulus it maps to. Flux-conserving, gap-free, and it handles both
//      the caustic and the crossing of the shadow axis.
//   5. Convolve with the limb-darkened solar disc (radius d*theta_sun,
//      ~1787 km at the Moon) - this is what softens everything.
//   6. Integrate 36 spectral bins through the CIE 1931 2-deg observer into
//      linear sRGB, normalised so zero extinction is exactly white.
//
// WHERE THE SPLIT IS. Only rays with perigee BELOW the top of the atmosphere
// are handled here. Above it the atmosphere neither bends nor absorbs
// measurably (at 88 km the bend is 3.3e-7 rad = 0.13 km at the Moon, and the
// transmission is 0.9999), so those rays are the plain geometric shadow, which
// CLunarEclipseCalc handles analytically with Earth's blocking disc at
// R + ATMOSPHERE_TOP_KM. The two halves therefore tile the sky exactly, with
// no double counting and no gap - and that is also what physically justifies
// astronomy-engine's EARTH_ATMOSPHERE_KM = 88 constant.
//
// Deliberately dropped: refractive DISPERSION in the bending. Blue bends about
// 1% more than red, which separates their landing radii by ~77 km at the Moon
// - against 3575 km of solar-disc smearing. It would be noise.

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0;         // matches astronomy-engine's EARTH_MEAN_RADIUS_KM

// Default top of the modelled atmosphere: rays with a higher perigee are the
// geometric shadow and belong to the analytic term, not to this module.
//
// This MUST be the same number the geometric shadow uses for Earth's blocking
// radius, or the band between the two is either counted twice or dropped. The
// caller passes its own value (the user's Shadow Enlargement) into
// buildUmbralProfile for exactly that reason; 88 km is astronomy-engine's
// EARTH_ATMOSPHERE_KM, and the default everywhere.
export const ATMOSPHERE_TOP_KM = 88.0;

// The tables run higher than the default split so a raised Shadow Enlargement
// is still covered. Above ~90 km there is nothing left to bend or absorb, so
// the extra range costs one-time work and changes no result.
const TABLE_TOP_KM = 160.0;

// Integrate a little above the split altitude so the slant integrals for a ray
// perigeeing AT the split altitude still have air above them to cross.
const INTEGRATION_TOP_KM = 220.0;

const DOBSON_PER_CM2 = 2.6867e16;       // molecules cm^-2 in one Dobson Unit

// Sea-level (288.15 K, 1013.25 hPa) air number density, cm^-3.
const N_AIR_SEA_LEVEL = 2.546899e19;

// King correction factor for the depolarisation of air. Weakly wavelength
// dependent (1.048 at 550 nm); the constant is well inside our other errors.
const KING_FACTOR = 1.048;

// ---------------------------------------------------------------------------
// US Standard Atmosphere 1976, geopotential layers to 84.852 km'
// ---------------------------------------------------------------------------

const G0 = 9.80665;              // m s^-2
const R_STAR = 8.31432;          // J mol^-1 K^-1
const M_AIR = 0.0289644;         // kg mol^-1
const R_GEOPOTENTIAL_KM = 6356.766;

// base geopotential height (km), base temperature (K), lapse rate (K/km)
const USSA_LAYERS = [
    [0.0, 288.15, -6.5],
    [11.0, 216.65, 0.0],
    [20.0, 216.65, 1.0],
    [32.0, 228.65, 2.8],
    [47.0, 270.65, 0.0],
    [51.0, 270.65, -2.8],
    [71.0, 214.65, -2.0],
];

// Base pressures, built once by integrating the barometric law up the layers.
const USSA_BASE_P = (() => {
    const p = [101325.0];
    for (let i = 0; i < USSA_LAYERS.length - 1; i++) {
        const [hb, tb, lb] = USSA_LAYERS[i];
        const hTop = USSA_LAYERS[i + 1][0];
        const dh = (hTop - hb) * 1000;
        if (lb === 0) {
            p.push(p[i] * Math.exp(-G0 * M_AIR * dh / (R_STAR * tb)));
        } else {
            const lbPerM = lb / 1000;
            p.push(p[i] * Math.pow(tb / (tb + lbPerM * dh), G0 * M_AIR / (R_STAR * lbPerM)));
        }
    }
    return p;
})();

// Top of the tabulated model. The 1976 standard atmosphere ends here; above it
// we continue isothermally. That is not the real thermosphere, but the density
// is already below 1e-6 of sea level and contributes nothing to either the
// bending or the extinction - whereas extrapolating the last layer's -2 K/km
// lapse instead runs the temperature through zero and negative by ~178 km,
// which is a NaN, not a small error.
const USSA_TOP_H_KM = 84.852;

// Air number density at geometric altitude z (km), in cm^-3.
export function airNumberDensity(z) {
    if (z < 0) z = 0;
    // geometric -> geopotential
    let h = R_GEOPOTENTIAL_KM * z / (R_GEOPOTENTIAL_KM + z);
    let isothermalAbove = 0;
    if (h > USSA_TOP_H_KM) {
        isothermalAbove = h - USSA_TOP_H_KM;
        h = USSA_TOP_H_KM;
    }
    let i = USSA_LAYERS.length - 1;
    for (let j = 0; j < USSA_LAYERS.length; j++) {
        if (h >= USSA_LAYERS[j][0]) i = j; else break;
    }
    const [hb, tb, lb] = USSA_LAYERS[i];
    const dh = (h - hb) * 1000;
    const T = tb + lb * (h - hb);
    let P;
    if (lb === 0) {
        P = USSA_BASE_P[i] * Math.exp(-G0 * M_AIR * dh / (R_STAR * tb));
    } else {
        const lbPerM = lb / 1000;
        P = USSA_BASE_P[i] * Math.pow(tb / T, G0 * M_AIR / (R_STAR * lbPerM));
    }
    if (isothermalAbove > 0) {
        P *= Math.exp(-G0 * M_AIR * isothermalAbove * 1000 / (R_STAR * T));
    }
    // n = P/(kT), converted from m^-3 to cm^-3
    return P / (1.380649e-23 * T) * 1e-6;
}

// Ozone: a Gaussian layer, normalised to unit column here and scaled by the
// caller's Dobson total. Mid-latitude peak near 22 km. The real profile is
// skewed and season/latitude dependent; the width is chosen so the peak number
// density comes out at the standard ~5e12 cm^-3 for a 300 DU column.
const OZONE_PEAK_KM = 22.0;
const OZONE_WIDTH_KM = 8.0;
// Integral of exp(-((z-z0)/w)^2) dz over z>=0, in cm (w in km -> 1e5 cm/km).
const OZONE_NORM_CM = OZONE_WIDTH_KM * 1e5 * Math.sqrt(Math.PI);

function ozoneShape(z) {
    const t = (z - OZONE_PEAK_KM) / OZONE_WIDTH_KM;
    return Math.exp(-t * t) / OZONE_NORM_CM;      // cm^-1, integrates to 1
}

// Aerosol. Two populations, both normalised to unit vertical column:
//  - stratospheric (Junge layer ~20 km): the one that actually matters for
//    umbral rays, and the one a volcanic eruption loads up. This is why the
//    Danjon brightness of an eclipse varies so much between events.
//  - tropospheric (scale height 1.5 km): almost entirely BELOW the perigee of
//    any ray that reaches the umbra, so it barely participates. Included for
//    completeness and because it does bite for the deepest rays.
const STRAT_AEROSOL_KM = 20.0;
const STRAT_AEROSOL_WIDTH_KM = 5.0;
const STRAT_NORM_CM = STRAT_AEROSOL_WIDTH_KM * 1e5 * Math.sqrt(Math.PI);
const TROP_AEROSOL_H_KM = 1.5;

function stratAerosolShape(z) {
    const t = (z - STRAT_AEROSOL_KM) / STRAT_AEROSOL_WIDTH_KM;
    return Math.exp(-t * t) / STRAT_NORM_CM;
}

function tropAerosolShape(z) {
    return Math.exp(-z / TROP_AEROSOL_H_KM) / (TROP_AEROSOL_H_KM * 1e5);
}

// Statistical clear-sky fraction for a ray whose perigee is at altitude z.
// Roughly two thirds of Earth's limb is cloudy at any moment, and cloud tops
// reach the tropopause, so low rays are usually blocked outright. This is a
// STATISTICAL model of the whole limb, not a weather forecast - but it is a
// real and large effect, and leaving it out makes the deep umbra come out
// several magnitudes too bright.
function clearFraction(z, cloudiness) {
    // 1 - cloudiness at the surface, rising to 1 by the tropopause.
    const t = Math.min(1, Math.max(0, z / 13.0));
    const clear = (1 - cloudiness) + cloudiness * (t * t * (3 - 2 * t));
    return Math.min(1, Math.max(0, clear));
}

// ---------------------------------------------------------------------------
// Spectral data - 380..730 nm in 10 nm steps
// ---------------------------------------------------------------------------

const LAMBDA_START = 380, LAMBDA_STEP = 10, N_LAMBDA = 36;

// CIE 1931 2-degree standard observer.
const CIE_X = [
    0.001368, 0.004243, 0.014310, 0.043510, 0.134380, 0.283900, 0.348280, 0.336200,
    0.290800, 0.195360, 0.095640, 0.032010, 0.004900, 0.009300, 0.063270, 0.165500,
    0.290400, 0.433450, 0.594500, 0.762100, 0.916300, 1.026300, 1.062200, 1.002600,
    0.854450, 0.642400, 0.447900, 0.283500, 0.164900, 0.087400, 0.046770, 0.022700,
    0.011359, 0.005790, 0.002899, 0.001440,
];
const CIE_Y = [
    0.000039, 0.000120, 0.000396, 0.001210, 0.004000, 0.011600, 0.023000, 0.038000,
    0.060000, 0.090980, 0.139020, 0.208020, 0.323000, 0.503000, 0.710000, 0.862000,
    0.954000, 0.994950, 0.995000, 0.952000, 0.870000, 0.757000, 0.631000, 0.503000,
    0.381000, 0.265000, 0.175000, 0.107000, 0.061000, 0.032000, 0.017000, 0.008210,
    0.004102, 0.002091, 0.001047, 0.000520,
];
const CIE_Z = [
    0.006450, 0.020050, 0.067850, 0.207400, 0.645600, 1.385600, 1.747060, 1.772110,
    1.669200, 1.287640, 0.812950, 0.465180, 0.272000, 0.158200, 0.078250, 0.042160,
    0.020300, 0.008750, 0.003900, 0.002100, 0.001650, 0.001100, 0.000800, 0.000340,
    0.000190, 0.000050, 0.000020, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
];

// Ozone Chappuis-band absorption cross-section, 1e-21 cm^2 per molecule, near
// 240 K. Smoothed envelope of the Bogumil/Serdyuchenko measurements: the real
// band has a few per cent of fine structure that 10 nm bins cannot carry, and
// which is invisible after the CIE integration. Peak 5.03e-21 near 603 nm
// gives a vertical optical depth of 0.041 for a 300 DU column, as observed.
const OZONE_XSEC = [
    0.000, 0.003, 0.010, 0.024, 0.045, 0.073, 0.110, 0.160,
    0.225, 0.310, 0.425, 0.570, 0.755, 0.980, 1.245, 1.560,
    1.910, 2.290, 2.720, 3.180, 3.640, 4.310, 5.030, 4.860,
    4.470, 4.130, 3.410, 2.760, 2.240, 1.780, 1.430, 1.180,
    0.870, 0.630, 0.460, 0.340,
];

// Refractivity (n-1) of dry air at 15 C / 1013.25 hPa, Edlen dispersion
// formula, with sigma = 1/lambda in um^-1.
function refractivitySeaLevel(lambdaNm) {
    const s2 = 1.0 / Math.pow(lambdaNm / 1000, 2);
    return (8060.51 + 2480990 / (132.274 - s2) + 17455.7 / (39.32957 - s2)) * 1e-8;
}

// Rayleigh scattering cross-section, cm^2 per molecule.
function rayleighXsec(lambdaNm) {
    const nu = refractivitySeaLevel(lambdaNm);
    const n2m1 = 2 * nu + nu * nu;             // n^2 - 1
    const ratio = n2m1 / (n2m1 + 3);           // (n^2-1)/(n^2+2)
    const lamCm = lambdaNm * 1e-7;
    return 24 * Math.PI ** 3 * ratio * ratio
        / (N_AIR_SEA_LEVEL * N_AIR_SEA_LEVEL * Math.pow(lamCm, 4)) * KING_FACTOR;
}

// Blackbody spectral radiance shape at the Sun's effective temperature. Only
// the SHAPE matters: the result is normalised so that zero extinction is
// exactly white, so this only sets how the extinction is weighted across the
// visible band.
function solarSpectrum(lambdaNm) {
    const T = 5772, lam = lambdaNm * 1e-9;
    const h = 6.62607015e-34, c = 2.99792458e8, kB = 1.380649e-23;
    return (2 * h * c * c) / (Math.pow(lam, 5) * (Math.exp(h * c / (lam * kB * T)) - 1));
}

// Per-bin spectral constants, built once.
const SPECTRUM = (() => {
    const lam = new Float64Array(N_LAMBDA);
    const sigR = new Float64Array(N_LAMBDA);
    const sigO3 = new Float64Array(N_LAMBDA);
    const angstrom = new Float64Array(N_LAMBDA);
    const src = new Float64Array(N_LAMBDA);
    for (let i = 0; i < N_LAMBDA; i++) {
        const l = LAMBDA_START + i * LAMBDA_STEP;
        lam[i] = l;
        sigR[i] = rayleighXsec(l);
        sigO3[i] = OZONE_XSEC[i] * 1e-21;
        angstrom[i] = 550 / l;                 // base for the Angstrom power law
        src[i] = solarSpectrum(l);
    }
    return {lam, sigR, sigO3, angstrom, src};
})();

// Linear sRGB primaries (sRGB / Rec.709, D65).
function xyzToLinearSRGB(X, Y, Z, out) {
    out[0] = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    out[1] = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    out[2] = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    return out;
}

// The white point of the unattenuated source in this pipeline. Dividing by it
// makes transmission == 1 come out as exactly (1,1,1).
const SOURCE_WHITE = (() => {
    let X = 0, Y = 0, Z = 0;
    for (let i = 0; i < N_LAMBDA; i++) {
        X += SPECTRUM.src[i] * CIE_X[i];
        Y += SPECTRUM.src[i] * CIE_Y[i];
        Z += SPECTRUM.src[i] * CIE_Z[i];
    }
    return xyzToLinearSRGB(X, Y, Z, new Float64Array(3));
})();

// ---------------------------------------------------------------------------
// Tangent-ray integrals - computed once, independent of eclipse geometry
// ---------------------------------------------------------------------------

// Sampling of perigee altitude for the precomputed tables. omega and the
// columns are near-exponential in h, so the tables are stored as logs and
// interpolated linearly, which is accurate to ~1e-4 at this spacing.
const TABLE_STEP_KM = 0.25;
const TABLE_N = Math.round(TABLE_TOP_KM / TABLE_STEP_KM) + 1;

// Number of Simpson intervals along the chord for each tangent ray.
const CHORD_STEPS = 600;

// Everything a tangent ray needs, as a function of its perigee altitude:
//   colAir   slant air column           (cm^-2)
//   colO3    slant ozone column         (per unit vertical column)
//   colStrat slant stratospheric aerosol(per unit vertical optical depth)
//   colTrop  slant tropospheric aerosol (per unit vertical optical depth)
//   omega    total refractive bending   (rad), for 550 nm
function buildRayTable() {
    const colAir = new Float64Array(TABLE_N);
    const colO3 = new Float64Array(TABLE_N);
    const colStrat = new Float64Array(TABLE_N);
    const colTrop = new Float64Array(TABLE_N);
    const omega = new Float64Array(TABLE_N);

    const rTop = EARTH_RADIUS_KM + INTEGRATION_TOP_KM;
    const nuOverRho = refractivitySeaLevel(550) / airNumberDensity(0);

    // d(density)/dz by central difference, in cm^-3 per km.
    // Central difference, collapsing to one-sided at the ground so the very
    // first chord sample does not read a clamped (and so halved) gradient.
    const dnDz = (z) => {
        const lo = Math.max(0, z - 0.05), hi = z + 0.05;
        return (airNumberDensity(hi) - airNumberDensity(lo)) / (hi - lo);
    };

    for (let i = 0; i < TABLE_N; i++) {
        const h = i * TABLE_STEP_KM;
        const b = EARTH_RADIUS_KM + h;
        const sMax = Math.sqrt(Math.max(0, rTop * rTop - b * b));
        const ds = sMax / CHORD_STEPS;

        let sAir = 0, sO3 = 0, sStrat = 0, sTrop = 0, sOmega = 0;
        for (let j = 0; j <= CHORD_STEPS; j++) {
            // Simpson weights
            const w = (j === 0 || j === CHORD_STEPS) ? 1 : (j % 2 ? 4 : 2);
            const s = j * ds;
            const r = Math.sqrt(b * b + s * s);
            const z = r - EARTH_RADIUS_KM;
            sAir += w * airNumberDensity(z);
            sO3 += w * ozoneShape(z);
            sStrat += w * stratAerosolShape(z);
            sTrop += w * tropAerosolShape(z);
            // omega integrand: (-dnu/dr)/r, with nu proportional to density
            sOmega += w * (-nuOverRho * dnDz(z)) / r;
        }
        const simp = ds / 3;
        // Half-chord doubled (the ray crosses the atmosphere twice), and the
        // columns converted from per-km to per-cm of path.
        colAir[i] = 2 * sAir * simp * 1e5;
        colO3[i] = 2 * sO3 * simp * 1e5;
        colStrat[i] = 2 * sStrat * simp * 1e5;
        colTrop[i] = 2 * sTrop * simp * 1e5;
        omega[i] = 2 * b * sOmega * simp;
    }
    return {colAir, colO3, colStrat, colTrop, omega};
}

// Built on first use, not at module load: it is ~200k chord samples, and the
// overwhelming majority of sessions never render a lunar eclipse.
let _rayTable = null;
function rayTable() {
    if (_rayTable === null) _rayTable = buildRayTable();
    return _rayTable;
}

// Log-space linear interpolation into the ray table.
function rayLookup(tbl, h) {
    const x = h / TABLE_STEP_KM;
    if (x <= 0) return tbl[0];
    if (x >= TABLE_N - 1) return tbl[TABLE_N - 1];
    const i = x | 0, f = x - i;
    const a = tbl[i], b = tbl[i + 1];
    if (a > 0 && b > 0) return Math.exp(Math.log(a) * (1 - f) + Math.log(b) * f);
    return a * (1 - f) + b * f;
}

/**
 * Total refractive bending, in radians, of a ray whose perigee is at altitude
 * h km. Exported for tests: the surface value must come out near 1.12 deg.
 */
export function tangentRayBending(h) {
    return rayLookup(rayTable().omega, h);
}

/**
 * Slant air column, cm^-2, for a tangent ray perigeeing at h km. Exported so
 * the ~70x enhancement over the vertical column can be asserted in tests.
 */
export function tangentRayAirColumn(h) {
    return rayLookup(rayTable().colAir, h);
}

// ---------------------------------------------------------------------------
// Atmosphere parameters
// ---------------------------------------------------------------------------

export const UMBRA_ATMOSPHERE_DEFAULTS = Object.freeze({
    ozoneDU: 300,              // Dobson Units, global mean
    stratAerosolTau: 0.005,    // background; 0.05-0.3 after a large eruption
    tropAerosolTau: 0.10,      // vertical AOD at 550 nm
    angstromExponent: 1.3,     // aerosol wavelength dependence
    cloudiness: 0.66,          // fraction of the limb blocked by cloud at the surface
});

/**
 * Map a single 0..1 "atmospheric clarity" control onto the aerosol and cloud
 * parameters. 0 = a heavily loaded, very dark eclipse (Danjon L0-L1, of the
 * kind seen after Pinatubo); 1 = an exceptionally clear, bright, coppery one
 * (L3-L4). 0.5 is a typical modern eclipse.
 */
export function atmosphereFromClarity(clarity, base = UMBRA_ATMOSPHERE_DEFAULTS) {
    const c = Math.min(1, Math.max(0, clarity));
    return {
        ...base,
        // Log-interpolated, because aerosol loading spans two decades.
        stratAerosolTau: 0.003 * Math.pow(80, 1 - c),
        tropAerosolTau: 0.05 * Math.pow(6, 1 - c),
        cloudiness: 0.82 - 0.34 * c,
    };
}

// ---------------------------------------------------------------------------
// The umbral radiance profile
// ---------------------------------------------------------------------------

// Radial bins for the point-source pattern before the solar-disc convolution.
// 25 km is far finer than the ~1787 km convolution kernel that follows.
const PT_BIN_KM = 15;

// Perigee sampling for the flux deposition. Fine enough that consecutive
// samples never jump a bin near the steepest part of the mapping
// (drho/dh peaks around 220 km per km at h ~ 12 km).
const DEPOSIT_STEP_KM = 0.05;

// Solar-disc convolution quadrature.
const CONV_RADIAL = 32, CONV_AZIMUTH = 64;

// Linear limb darkening of the photosphere in the visual, the same u = 0.6
// that CEclipseCalc's eclipseLightFraction is built on.
const LIMB_U = 0.6;

/**
 * Compute the refracted (umbral) irradiance profile in the shadow plane.
 *
 * @param {object} p
 * @param {number} p.moonDistKm    geocentric distance to the shadow plane
 * @param {number} p.sunDistKm     Earth-Sun distance
 * @param {number} p.sunRadiusKm
 * @param {number} p.penumbraKm    penumbral radius at the plane - the profile's extent
 * @param {number} p.umbraKm       umbral radius, used only for the mean-radiance summary
 * @param {number} [p.topKm]       perigee altitude at which this module stops and the
 *                                 analytic geometric shadow takes over. MUST equal the
 *                                 enlargement the geometric shadow was built with.
 * @param {object} p.atmo          atmosphere parameters (see the defaults above)
 * @param {number} [p.samples=256] output LUT length
 * @returns {{rMaxKm:number, rgb:Float32Array, peak:number, meanUmbra:number}}
 *          rgb is linear sRGB irradiance as a fraction of the unattenuated
 *          solar irradiance, so 1.0 means "as bright as full sunlight".
 */
export function buildUmbralProfile({
                                       moonDistKm, sunDistKm, sunRadiusKm,
                                       penumbraKm, umbraKm,
                                       topKm = ATMOSPHERE_TOP_KM,
                                       atmo = UMBRA_ATMOSPHERE_DEFAULTS,
                                       samples = 256,
                                   }) {
    const d = moonDistKm;
    // Clamped to the tables. 0 means "no atmosphere": the bare geometric
    // shadow, with no refracted light in the umbra at all.
    const top = Math.min(TABLE_TOP_KM, Math.max(0, topKm));

    // --- 1. Point-source radial pattern, per spectral bin -------------------
    const nBins = Math.ceil(penumbraKm / PT_BIN_KM) + 1;
    const ptRGB = new Float64Array(nBins * 3);

    // Per-bin extinction coefficients, pre-scaled by the caller's amounts.
    const o3Col = atmo.ozoneDU * DOBSON_PER_CM2;
    const tau = new Float64Array(N_LAMBDA);
    const rgbW = new Float64Array(N_LAMBDA * 3);   // CIE->sRGB weight per bin
    {
        const tmp = new Float64Array(3);
        for (let i = 0; i < N_LAMBDA; i++) {
            xyzToLinearSRGB(SPECTRUM.src[i] * CIE_X[i], SPECTRUM.src[i] * CIE_Y[i],
                SPECTRUM.src[i] * CIE_Z[i], tmp);
            rgbW[i * 3] = tmp[0] / SOURCE_WHITE[0];
            rgbW[i * 3 + 1] = tmp[1] / SOURCE_WHITE[1];
            rgbW[i * 3 + 2] = tmp[2] / SOURCE_WHITE[2];
        }
    }

    // Deposit an annulus of power into the radial bins, spread uniformly over
    // [ra, rb]. `power` is the total power in the annulus (units of irradiance
    // x area), so the irradiance it produces there is power / (pi(rb^2-ra^2)).
    const deposit = (ra, rb, r, g, b) => {
        if (rb < ra) { const t = ra; ra = rb; rb = t; }
        // A caustic maps a finite interval to a point; spread over one bin so
        // the density stays finite (the solar convolution washes it out anyway).
        if (rb - ra < PT_BIN_KM * 0.5) {
            const mid = 0.5 * (ra + rb);
            ra = Math.max(0, mid - PT_BIN_KM * 0.25);
            rb = ra + PT_BIN_KM * 0.5;
        }
        const spreadArea = Math.PI * (rb * rb - ra * ra);
        if (!(spreadArea > 0)) return;
        const i0 = Math.max(0, Math.floor(ra / PT_BIN_KM));
        const i1 = Math.min(nBins - 1, Math.floor(rb / PT_BIN_KM));
        for (let i = i0; i <= i1; i++) {
            const b0 = i * PT_BIN_KM, b1 = b0 + PT_BIN_KM;
            const lo = Math.max(ra, b0), hi = Math.min(rb, b1);
            if (hi <= lo) continue;
            // Fraction of this bin's area that the uniform patch covers.
            const binArea = Math.PI * (b1 * b1 - b0 * b0);
            const overlapArea = Math.PI * (hi * hi - lo * lo);
            const frac = overlapArea / spreadArea;      // share of the power
            const e = frac / binArea;                   // -> irradiance in the bin
            ptRGB[i * 3] += r * e;
            ptRGB[i * 3 + 1] += g * e;
            ptRGB[i * 3 + 2] += b * e;
        }
    };

    // Walk perigee altitude from the ground up to the split altitude.
    const nSteps = Math.round(top / DEPOSIT_STEP_KM);
    let prevRho = null, prevH = 0;
    for (let s = 0; s <= nSteps; s++) {
        const h = s * DEPOSIT_STEP_KM;
        const b = EARTH_RADIUS_KM + h;
        const rho = b - d * rayLookup(rayTable().omega, h);
        if (prevRho === null) { prevRho = rho; prevH = h; continue; }

        // Transmission at the interval midpoint.
        const hm = 0.5 * (h + prevH);
        const colAir = rayLookup(rayTable().colAir, hm);
        const colO3 = rayLookup(rayTable().colO3, hm) * o3Col;
        const colStrat = rayLookup(rayTable().colStrat, hm) * atmo.stratAerosolTau;
        const colTrop = rayLookup(rayTable().colTrop, hm) * atmo.tropAerosolTau;
        const clear = clearFraction(hm, atmo.cloudiness);

        // Annulus power for this interval, per unit incident irradiance.
        // (The 2*pi*b*db of the incoming beam's projected area.)
        const bm = EARTH_RADIUS_KM + hm;
        const power = 2 * Math.PI * bm * (h - prevH) * clear;
        if (power <= 0) { prevRho = rho; prevH = h; continue; }

        let R = 0, G = 0, B = 0;
        for (let i = 0; i < N_LAMBDA; i++) {
            const aer = Math.pow(SPECTRUM.angstrom[i], atmo.angstromExponent);
            tau[i] = SPECTRUM.sigR[i] * colAir
                + SPECTRUM.sigO3[i] * colO3
                + (colStrat + colTrop) * aer;
            const T = Math.exp(-tau[i]);
            R += rgbW[i * 3] * T;
            G += rgbW[i * 3 + 1] * T;
            B += rgbW[i * 3 + 2] * T;
        }
        R *= power; G *= power; B *= power;

        // Split the interval where it crosses the shadow axis, so both halves
        // land at their true |rho| instead of being smeared across the origin.
        if ((rho < 0) !== (prevRho < 0)) {
            const f = Math.abs(prevRho) / (Math.abs(prevRho) + Math.abs(rho));
            deposit(0, Math.abs(prevRho), R * f, G * f, B * f);
            deposit(0, Math.abs(rho), R * (1 - f), G * (1 - f), B * (1 - f));
        } else {
            deposit(Math.abs(prevRho), Math.abs(rho), R, G, B);
        }
        prevRho = rho;
        prevH = h;
    }

    // --- 2. Convolve with the limb-darkened solar disc ----------------------
    // Angular radius of the Sun as seen from the shadow plane, projected back
    // to a linear radius there. This is the whole reason the shadow has soft
    // edges rather than a knife edge.
    const tMax = d * Math.asin(sunRadiusKm / (sunDistKm + d));

    // Precompute the kernel: radius samples and limb-darkened weights.
    const kt = new Float64Array(CONV_RADIAL), kw = new Float64Array(CONV_RADIAL);
    let kwSum = 0;
    for (let i = 0; i < CONV_RADIAL; i++) {
        const frac = (i + 0.5) / CONV_RADIAL;
        kt[i] = frac * tMax;
        const mu = Math.sqrt(Math.max(0, 1 - frac * frac));
        // limb darkening x the annulus area element
        kw[i] = (1 - LIMB_U * (1 - mu)) * frac;
        kwSum += kw[i];
    }
    for (let i = 0; i < CONV_RADIAL; i++) kw[i] /= kwSum * CONV_AZIMUTH;

    const cosPsi = new Float64Array(CONV_AZIMUTH);
    for (let k = 0; k < CONV_AZIMUTH; k++) {
        cosPsi[k] = Math.cos(2 * Math.PI * (k + 0.5) / CONV_AZIMUTH);
    }

    // Linear sample of the binned point pattern (bin centres).
    const samplePt = (r, out) => {
        const x = r / PT_BIN_KM - 0.5;
        if (x <= 0) { out[0] = ptRGB[0]; out[1] = ptRGB[1]; out[2] = ptRGB[2]; return; }
        if (x >= nBins - 1) { out[0] = out[1] = out[2] = 0; return; }
        const i = x | 0, f = x - i;
        for (let c = 0; c < 3; c++) {
            out[c] = ptRGB[i * 3 + c] * (1 - f) + ptRGB[(i + 1) * 3 + c] * f;
        }
    };

    const rMaxKm = penumbraKm;
    const rgb = new Float32Array(samples * 3);
    const tmp = new Float64Array(3);
    let peak = 0;
    for (let n = 0; n < samples; n++) {
        const r = rMaxKm * n / (samples - 1);
        let R = 0, G = 0, B = 0;
        for (let i = 0; i < CONV_RADIAL; i++) {
            const t = kt[i], w = kw[i];
            for (let k = 0; k < CONV_AZIMUTH; k++) {
                const rr = Math.sqrt(Math.max(0, r * r + t * t - 2 * r * t * cosPsi[k]));
                samplePt(rr, tmp);
                R += w * tmp[0]; G += w * tmp[1]; B += w * tmp[2];
            }
        }
        // Gamut clip: the deepest umbra can fall slightly outside sRGB.
        rgb[n * 3] = Math.max(0, R);
        rgb[n * 3 + 1] = Math.max(0, G);
        rgb[n * 3 + 2] = Math.max(0, B);
        peak = Math.max(peak, R, G, B);
    }

    // The convolution guarantees a profile that is smooth on scales well below
    // 100 km, so any sample-to-sample jitter left in a 32 km-per-sample LUT is
    // quadrature noise, not structure. A 5-tap binomial (effective sigma of one
    // sample) removes it; the narrowest real feature - the ozone fringe at the
    // umbral edge - is ~17 samples wide and passes through untouched.
    {
        const src = rgb.slice();
        for (let n = 0; n < samples; n++) {
            for (let c = 0; c < 3; c++) {
                let acc = 0, wt = 0;
                for (let o = -2; o <= 2; o++) {
                    const m = n + o;
                    if (m < 0 || m >= samples) continue;
                    const w = [1, 4, 6, 4, 1][o + 2];
                    acc += w * src[m * 3 + c];
                    wt += w;
                }
                rgb[n * 3 + c] = acc / wt;
            }
        }
    }

    // Area-weighted mean radiance INSIDE the umbra - the scalar the exposure
    // and the Danjon-style brightness estimate are built on. Weighting by r is
    // the annulus area element, so this is a true disc average.
    const rUmbra = umbraKm ?? rMaxKm;
    let meanUmbra = 0, wSum = 0;
    for (let n = 0; n < samples; n++) {
        const r = rMaxKm * n / (samples - 1);
        if (r > rUmbra) break;
        const lum = 0.2126 * rgb[n * 3] + 0.7152 * rgb[n * 3 + 1] + 0.0722 * rgb[n * 3 + 2];
        meanUmbra += lum * r;
        wSum += r;
    }
    if (wSum > 0) meanUmbra /= wSum;

    return {rMaxKm, rgb, peak, meanUmbra};
}
