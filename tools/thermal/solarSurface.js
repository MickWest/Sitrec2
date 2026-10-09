// Estimated local steady-state surface model, SI units. No heat storage,
// inter-face conduction, shadow tracing, diffuse sunlight or spectral coating model.
// Solar absorptivity and bolometric cooling emissivity are distinct properties.
// Radiation physics reference: https://www.nasa.gov/wp-content/uploads/2021/10/7.soa_thermal_2021_0.pdf
// Coefficients below are authoring estimates, not measured properties of a craft.
export const SOLAR_SURFACE_DEFAULTS = Object.freeze({enabled: false, airTemperatureK: 293,
    mach: 0, recoveryFactor: 0.89, solarAbsorptivity: 0.6, solarIrradianceWm2: 1000,
    convectionWm2K: 20, radiationTemperatureK: 293, coolingEmissivity: 0.85,
    emissivityMWIR: 0.85, internalHeatFluxWm2: 0, internalHeatCenterFraction: 0,
    internalHeatSigmaFraction: 0.4, model: "localSteadyEquilibrium", status: "estimated"});
const ranges = {airTemperatureK: [100, 1000], mach: [0, 5], recoveryFactor: [0, 1],
    solarAbsorptivity: [0, 1], solarIrradianceWm2: [0, 1500], convectionWm2K: [0.1, 2000],
    radiationTemperatureK: [0, 1000], coolingEmissivity: [0, 1], emissivityMWIR: [0, 1],
    internalHeatFluxWm2: [0, 20000], internalHeatCenterFraction: [-1, 1], internalHeatSigmaFraction: [0.01, 2]};
export function solarSurfaceState(value = {}) {
    const out = {...SOLAR_SURFACE_DEFAULTS, enabled: value?.enabled === true};
    for (const [key, [lo, hi]] of Object.entries(ranges)) {
        const v = value?.[key] ?? out[key];
        if (!Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`Invalid solar surface ${key}`);
        out[key] = v;
    }
    return out;
}
export const STEFAN_BOLTZMANN = 5.670374419e-8;
export function surfaceRecoveryTemperature(settings) {
    return settings.airTemperatureK * (1 + settings.recoveryFactor * 0.2 * settings.mach ** 2);
}
// Estimated heat arriving at the surface, not engine power or identity evidence.
// Axial fraction is measured from the local geometry bounds' center along z,
// in units of half its z extent. World rotation never moves this body-fixed heat.
export function surfaceHeatingFlux(settings, cosine, axialFraction = 0) {
    if (!Number.isFinite(cosine) || !Number.isFinite(axialFraction)) throw new RangeError("Invalid surface coordinates");
    const solar = settings.solarAbsorptivity * settings.solarIrradianceWm2 * Math.max(0, Math.min(1, cosine));
    const peak = settings.internalHeatFluxWm2 ?? 0;
    const offset = (axialFraction - (settings.internalHeatCenterFraction ?? 0)) / (settings.internalHeatSigmaFraction ?? 0.4);
    return solar + peak * Math.exp(-0.5 * offset ** 2);
}
// h(T-Tr) + epsilon*sigma*(T^4-Tenv^4) = absorbed solar + supplied internal flux.
// Positive h guarantees a unique root, including emissivity=0. Bisection avoids
// a fragile linearized radiation coefficient at large temperature differences.
export function surfaceTemperatureForFlux(settings, absorbed) {
    if (!Number.isFinite(absorbed) || absorbed < 0) throw new RangeError("Invalid surface heat flux");
    const recovery = surfaceRecoveryTemperature(settings);
    const residual = t => settings.convectionWm2K * (t - recovery) +
        settings.coolingEmissivity * STEFAN_BOLTZMANN * (t ** 4 - settings.radiationTemperatureK ** 4) - absorbed;
    let low = 0, high = Math.max(recovery, settings.radiationTemperatureK) + absorbed / settings.convectionWm2K + 1;
    for (let i = 0; i < 60; i++) {
        const mid = (low + high) / 2;
        if (residual(mid) > 0) high = mid; else low = mid;
    }
    return (low + high) / 2;
}
export function solarSurfaceTemperature(settings, cosine, axialFraction = 0) {
    return surfaceTemperatureForFlux(settings, surfaceHeatingFlux(settings, cosine, axialFraction));
}
