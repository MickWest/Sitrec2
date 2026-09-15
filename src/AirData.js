// Ideal dry-air pitot/static air data, shared by sensor HUDs and reconstructions.
// Isentropic and normal-shock relations:
// https://www.grc.nasa.gov/www/k-12/airplane/isentrop.html
// https://www.grc.nasa.gov/www/k-12/airplane/normal.html
const GAMMA = 1.4;
const R = 287.05287; // J/(kg K)
const P0 = 101325; // Pa
const T0 = 288.15; // K
const A0 = Math.sqrt(GAMMA * R * T0);
const G0 = 9.80665;
const LAPSE = 0.0065;
const GEOPOTENTIAL_RADIUS = 6356766; // m, standard-atmosphere reference radius
export const KNOT_MPS = 1852 / 3600;

// Standard atmosphere through 20 km geopotential altitude. The input is geometric
// height above MSL, not pressure altitude. This is an explicit weather assumption.
export function standardAtmosphere(altitudeMSL) {
    if (!Number.isFinite(altitudeMSL)) return null;
    const h = GEOPOTENTIAL_RADIUS * altitudeMSL / (GEOPOTENTIAL_RADIUS + altitudeMSL);
    if (h < -1000 || h > 20000) return null;
    const temperatureK = T0 - LAPSE * Math.min(h, 11000);
    const pressurePa = P0 * (temperatureK / T0) ** (G0 / (R * LAPSE))
        * Math.exp(-G0 * Math.max(0, h - 11000) / (R * temperatureK));
    return {pressurePa, temperatureK};
}

// Pitot impact pressure divided by ambient static pressure. At supersonic speed
// the flow first crosses a normal shock, then decelerates isentropically to rest.
export function pitotImpactPressureRatio(mach) {
    if (!Number.isFinite(mach) || mach < 0) return null;
    const m2 = mach * mach;
    if (mach <= 1) return Math.expm1(GAMMA / (GAMMA - 1) * Math.log1p((GAMMA - 1) / 2 * m2));
    const downstreamM2 = ((GAMMA - 1) * m2 + 2) / (2 * GAMMA * m2 - (GAMMA - 1));
    const staticRatio = (2 * GAMMA * m2 - (GAMMA - 1)) / (GAMMA + 1);
    return staticRatio * (1 + (GAMMA - 1) / 2 * downstreamM2) ** (GAMMA / (GAMMA - 1)) - 1;
}

function machFromImpactRatio(ratio) {
    if (ratio <= pitotImpactPressureRatio(1)) {
        return Math.sqrt(2 / (GAMMA - 1) * Math.expm1((GAMMA - 1) / GAMMA * Math.log1p(ratio)));
    }
    let lo = 1, hi = 2;
    while (pitotImpactPressureRatio(hi) < ratio) hi *= 2;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (pitotImpactPressureRatio(mid) < ratio) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// CAS is the standard sea-level speed giving the same pitot impact pressure.
// It includes compressibility; TAS * sqrt(density / seaLevelDensity) is EAS.
// Never substitute IAS, groundspeed, or target closing speed for TAS here.
export function airDataFromTAS(tasMPS, pressurePa, temperatureK) {
    if (!Number.isFinite(tasMPS) || tasMPS < 0 || !Number.isFinite(temperatureK) || temperatureK <= 0) {
        return {mach: null, casKnots: null};
    }
    const mach = tasMPS / Math.sqrt(GAMMA * R * temperatureK);
    const impactPa = pressurePa * pitotImpactPressureRatio(mach);
    const casKnots = Number.isFinite(pressurePa) && pressurePa > 0 && Number.isFinite(impactPa)
        ? A0 * machFromImpactRatio(impactPa / P0) / KNOT_MPS : null;
    return {mach, casKnots};
}
