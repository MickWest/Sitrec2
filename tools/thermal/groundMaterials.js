// Ground material classes for Ground temperature source = Material classes. Each class's surface temperature is the
// near-surface air temperature plus an offset that depends on the sun, the time since sunset, cloud, wind and climate.
// Estimated from published surface measurements, a published urban pavement model and radiative-balance physics:
//   day:   excess = reference clear-midday excess x S(sun elevation) x day cloud factor x wind factor
//   night: offset = stored day heat x exp(-hours after sunset / tau) - deficit x climate x night cloud factor x wind factor
// Heavy surfaces (asphalt, concrete, soil) store heat and lag the sun; thin ones (grass, trees, roofs) follow the
// radiation balance. The class order is the row order of the terrain shader.

// Clear-day reference excess (K) at sun elevation 60-90 deg and 2 m/s wind, by climate; the stored fraction of that
// excess left at sunset; its night decay time (h); the calm clear-night radiative deficit (K, temperate). Emissivity 3-5 um.
export const GROUND_CLASSES = Object.freeze([
    Object.freeze({id: "grass", emissivity: 0.97, dayK: {humid: 1, temperate: 1, dry: 2}, stored: 0, tauH: 0, deficitK: 3,
        status: "estimated; night values measured in grassland, frost-night grass 3-6 K below screen air"}),
    Object.freeze({id: "trees", emissivity: 0.98, dayK: {humid: 0, temperate: 0, dry: 1}, stored: 0, tauH: 0, deficitK: 1.5,
        status: "estimated; forests cool less than grass at night (measured)"}),
    Object.freeze({id: "asphalt", emissivity: 0.93, dayK: {humid: 15, temperate: 20, dry: 25}, stored: 0.4, tauH: 11, deficitK: 0,
        status: "estimated; day excess measured, night from a published pavement model"}),
    Object.freeze({id: "concrete", emissivity: 0.95, dayK: {humid: 10, temperate: 12, dry: 18}, stored: 0.35, tauH: 11, deficitK: 0,
        status: "estimated; walls and paving cool at the ground's rate"}),
    Object.freeze({id: "roof", emissivity: 0.88, dayK: {humid: 5, temperate: 5, dry: 6}, stored: 0, tauH: 0, deficitK: 5,
        status: "estimated; painted roof day excess measured, night from the radiative balance"}),
    Object.freeze({id: "soil", emissivity: 0.80, dayK: {humid: 6, temperate: 10, dry: 25}, stored: 0.2, tauH: 6, deficitK: 2,
        status: "estimated; desert day excess measured, night thinly documented; emissivity 0.55-0.92"}),
]);

// Night deficit scale by climate: humid air radiates back, dry air lets surfaces cool further (estimated).
const CLIMATE_DEFICIT = Object.freeze({humid: 0.7, temperate: 1, dry: 1.3});
// Heavy surfaces follow the sun about 1.5 h late (published pavement model: peak 1-3 h after the sun).
export const GROUND_SUN_LAG_H = 1.5;
// The manual conditions are the table's reference states.
const CONDITIONS = Object.freeze({
    day: {sunElevationDeg: 70, laggedSunElevationDeg: 70, hoursSinceSunset: 18, cloudFraction: 0},
    overcast: {sunElevationDeg: 70, laggedSunElevationDeg: 70, hoursSinceSunset: 18, cloudFraction: 1},
    evening: {sunElevationDeg: -15, laggedSunElevationDeg: -5, hoursSinceSunset: 2, cloudFraction: 0},
    night: {sunElevationDeg: -40, laggedSunElevationDeg: -40, hoursSinceSunset: 10, cloudFraction: 0},
});

// Published heat-transfer form h_c = 5.7 + 3.8 V (W m-2 K-1) with h_r about 5: offsets scale as 12.6 / (10.7 + 3.8 V),
// which is 1 at 0.5 m/s; the clear-day references contain 2 m/s.
const windFactor = windMps => 12.6 / (10.7 + 3.8 * Math.max(0, windMps));
// Published cloud factors: long-wave loss (1 - 0.84 n); clear-sky sunlight (1 - 0.75 n^3.4).
const nightCloud = n => 1 - 0.84 * n;
const dayCloud = n => 1 - 0.75 * n ** 3.4;
const sunFactor = elevationDeg => Math.max(0, Math.sin(elevationDeg * Math.PI / 180)) / Math.sin(70 * Math.PI / 180);

/** Surface temperature minus air temperature (K) for one class. Inputs: climate ("humid", "temperate", "dry"),
 * sunElevationDeg, laggedSunElevationDeg (the elevation GROUND_SUN_LAG_H earlier, for heavy surfaces),
 * hoursSinceSunset (hours since the last sunset, also by day), cloudFraction 0-1, windMps (near-surface).
 */
export function groundClassOffset(groundClass, {climate, sunElevationDeg, laggedSunElevationDeg = sunElevationDeg,
    hoursSinceSunset, cloudFraction, windMps}) {
    const n = Math.min(1, Math.max(0, cloudFraction)), wind = windFactor(windMps);
    const reference = groundClass.dayK[climate];
    const day = sun => reference * sun * dayCloud(n) * wind / windFactor(2);
    // Stored heat after sunset; the full day's reference excess is the end-of-day state (estimated).
    const hours = Number.isFinite(hoursSinceSunset) ? Math.max(0, hoursSinceSunset) : Infinity;
    const stored = groundClass.stored > 0 ? groundClass.stored * reference * Math.exp(-hours / groundClass.tauH) : 0;
    const night = stored - groundClass.deficitK * CLIMATE_DEFICIT[climate] * nightCloud(n) * wind;
    if (sunElevationDeg <= 0) return night;
    // By day: the sunlit excess plus the night state weighted by (1 - S), so that low sun leaves the surface near its
    // night state (calculated blend: equal to the forms above at midday and at night, continuous at sunrise and
    // sunset). Heavy surfaces follow the sun GROUND_SUN_LAG_H late.
    const sun = sunFactor(groundClass.stored > 0 ? laggedSunElevationDeg : sunElevationDeg);
    return day(sun) + night * (1 - Math.min(1, sun));
}

// Calculated from the profile's surface state: published liquid-water saturation fit, R_v = 461.5 J/(kg K).
export function surfaceHumidity({temperatureK, waterVaporDensityKgM3}) {
    const tC = temperatureK - 273.15, vaporPa = waterVaporDensityKgM3 * 461.5 * temperatureK;
    const ratio = Math.max(vaporPa, 1e-6) / 611.2, logRatio = Math.log(ratio);
    return {relativeHumidity: vaporPa / (611.2 * Math.exp(17.67 * tC / (tC + 243.5))),
        dewPointK: 273.15 + 243.5 * logRatio / (17.67 - logRatio)};
}

// Estimated: a dew point of 18 C or more is tropical air; below 35% relative humidity, dry air.
export function groundClimateFromSurface(surface) {
    const {relativeHumidity, dewPointK} = surfaceHumidity(surface);
    return dewPointK >= 291.15 ? "humid" : relativeHumidity < 0.35 ? "dry" : "temperate";
}

/** The classes for the current settings and scene. context: sunElevationDeg, laggedSunElevationDeg, hoursSinceSunset
 * (from the scene date, time and place) and surface ({temperatureK, waterVaporDensityKgM3} of the profile). Returns
 * {condition, climate, airK, inputs, classes: [{id, offsetK, emissivity}]} in shader row order.
 */
export function resolveGroundClasses(settings, context) {
    const condition = settings.groundCondition ?? "automatic";
    const climate = !settings.groundClimate || settings.groundClimate === "automatic"
        ? groundClimateFromSurface(context.surface) : settings.groundClimate;
    const inputs = {climate, windMps: settings.groundWindMps ?? 2,
        ...(condition === "automatic" ? {sunElevationDeg: context.sunElevationDeg,
            laggedSunElevationDeg: context.laggedSunElevationDeg ?? context.sunElevationDeg,
            hoursSinceSunset: context.hoursSinceSunset, cloudFraction: settings.groundCloudFraction ?? 0.3} : CONDITIONS[condition])};
    return {condition, climate, airK: context.surface.temperatureK, inputs,
        classes: GROUND_CLASSES.map(groundClass => ({id: groundClass.id, emissivity: groundClass.emissivity,
            offsetK: groundClassOffset(groundClass, inputs)}))};
}
