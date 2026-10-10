import {createAtmosphere} from "./atmosphere.js";

// Published: radiosonde archive format description.
const COLUMNS = ["level_type", "pressure_Pa", "geopotential_height_m", "temperature_C",
    "relative_humidity_pct", "dewpoint_depression_C", "wind_dir_deg", "wind_speed_m_s"];

function numeric(text, name) {
    if (text.trim() === "") return null;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new RangeError(`Invalid sounding ${name}`);
    // The archive codes -9999 (not reported) and -8888 (rejected) are both absent values.
    return value === -9999 || value === -8888 ? null : value;
}
function level(type, p, z, tC, rh, dpd, dir, speed) {
    if (!/^[123][012]$/.test(type)) throw new RangeError(`Invalid sounding level type: ${type}`);
    return Object.freeze({levelType: type, pressurePa: p, geopotentialHeightM: z,
        temperatureK: tC === null ? null : tC + 273.15, relativeHumidityPct: rh,
        dewpointDepressionK: dpd, windDirectionDeg: dir, windSpeedMS: speed});
}
function parsed(levels, metadata, format) {
    if (!levels.length) throw new RangeError("Sounding has no levels");
    return Object.freeze({...metadata, format, levels: Object.freeze(levels)});
}

/** Numeric CSV with the eight named columns above. Blanks stay null, including
 * wind-only levels. metadata may supply stationId, time and stationElevationM.
 * Temperatures convert from degrees C to K; all lengths and pressures are SI.
 */
export function parseSoundingCSV(text, metadata = {}) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const header = lines.shift().split(",").map(value => value.trim());
    const indices = COLUMNS.map(name => header.indexOf(name));
    if (indices.some(index => index < 0)) throw new Error("Sounding CSV requires all eight named columns");
    const levels = lines.filter(line => line.trim()).map(line => {
        const cells = line.split(",");
        if (cells.length !== header.length) throw new Error("Incomplete sounding CSV row");
        const values = indices.map(index => cells[index].trim());
        return level(values[0], ...values.slice(1).map((value, i) => numeric(value, COLUMNS[i + 1])));
    });
    return parsed(levels, metadata, "csv");
}

/** Levels already parsed by a host (for example a radiosonde import), as objects with the CSV column names above and
 * the same units. Absent values are null. Validation is the same as for the CSV parser.
 */
export function soundingFromRecords(records, metadata = {}) {
    if (!Array.isArray(records)) throw new TypeError("Expected an array of sounding records");
    const value = (record, name) => {
        const entry = record[name];
        if (entry === null || entry === undefined) return null;
        if (!Number.isFinite(entry)) throw new RangeError(`Invalid sounding ${name}`);
        return entry;
    };
    return parsed(records.map(record => level(String(record.level_type),
        ...COLUMNS.slice(1).map(name => value(record, name)))), metadata, "records");
}

// Published constants in SI: dry-air R = 287.05 J/(kg K), water-vapor R =
// 461.5 J/(kg K), standard gravity = 9.80665 m/s² (meteorological convention).
const RD = 287.05, RV = 461.5, G = 9.80665;
// Published liquid-water saturation fit from a published meteorological study.
const saturationPa = tC => 611.2 * Math.exp(17.67 * tC / (tC + 243.5));
const assumption = (id, reason) => Object.freeze({id, status: "estimated", reason});

/** Build a measured-level profile plus an explicit estimated interpolation model.
 * options: stationElevationM (required if the lowest thermodynamic height is
 * absent), humidityScaleHeightM (estimated 1000 m), visibilityM (estimated
 * 23000 m), densityScale (1, or 0 for disabled transfer). The content key contains
 * canonical effective numeric content, not object identity or source filenames.
 */
export function atmosphereFromSounding(sounding, options = {}) {
    if (!Array.isArray(sounding?.levels)) throw new TypeError("Expected a parsed sounding");
    const humidityScaleHeightM = options.humidityScaleHeightM ?? 1000;
    const visibilityM = options.visibilityM ?? 23000, densityScale = options.densityScale ?? 1;
    if (!Number.isFinite(humidityScaleHeightM) || humidityScaleHeightM <= 0)
        throw new RangeError("Humidity decay scale must be positive meters");
    const rows = sounding.levels.filter(row => row.pressurePa > 0 && row.temperatureK !== null)
        .map(row => ({...row})).sort((a, b) => b.pressurePa - a.pressurePa);
    if (!rows.length) throw new RangeError("Sounding has no pressure and temperature levels");
    if (rows[0].geopotentialHeightM == null) rows[0].geopotentialHeightM = options.stationElevationM ?? sounding.stationElevationM;
    if (!Number.isFinite(rows[0].geopotentialHeightM)) throw new RangeError("Missing lowest height: supply stationElevationM");
    const assumptions = [
        assumption("selection", "Use pressure/temperature levels only; wind-only and non-pressure reports do not define thermodynamic states. If the lowest height is missing, anchor it at the supplied station elevation."),
        assumption("height", "Use geopotential height as geometric altitude; estimate missing heights by dry hypsometry with mean layer air temperature, ignoring virtual-temperature corrections."),
        assumption("interpolation", "Linear temperature and water density, logarithmic pressure between reports; hold the first report below its height because lower observations are absent."),
        assumption("humidity", "Prefer dew-point depression to relative humidity; use the published liquid-water saturation fit even below freezing, with air temperature in the vapor-density denominator."),
        assumption("humidityTail", `Above the last humidity report, decay density with ${humidityScaleHeightM} m scale height until the top temperature level; water is zero above that top because no upper humidity is measured.`),
        assumption("upperProfile", "Above the top level, shift U.S. Standard Atmosphere 1976 temperature (150 K floor) and scale its pressure to meet the top; this extrapolation is not an upper-air observation."),
        assumption("aerosol", "Visibility sets the existing aerosol model independently of measured thermodynamic levels; the sounding does not measure aerosol extinction."),
    ];
    const levels = [];
    for (const row of rows) {
        const previous = levels.at(-1);
        if (!Number.isFinite(row.temperatureK) || row.temperatureK < 150 || row.temperatureK > 350 || !Number.isFinite(row.pressurePa))
            throw new RangeError("Invalid sounding pressure or temperature");
        if (row.geopotentialHeightM == null) row.geopotentialHeightM = previous.geopotentialHeightM +
            RD * (previous.temperatureK + row.temperatureK) / (2 * G) * Math.log(previous.pressurePa / row.pressurePa);
        if (!Number.isFinite(row.geopotentialHeightM)) throw new RangeError("Invalid sounding height");
        // Estimated rejection: repeated/reversed heights cannot define a single
        // altitude profile. Wind-only rows have already been excluded.
        if (previous && row.geopotentialHeightM <= previous.geopotentialHeightM) continue;
        let vaporPressure = null;
        if (row.dewpointDepressionK != null) {
            if (!Number.isFinite(row.dewpointDepressionK) || row.dewpointDepressionK < 0) throw new RangeError("Invalid dew-point depression");
            vaporPressure = saturationPa(row.temperatureK - 273.15 - row.dewpointDepressionK);
        } else if (row.relativeHumidityPct != null) {
            if (!Number.isFinite(row.relativeHumidityPct) || row.relativeHumidityPct < 0 || row.relativeHumidityPct > 100) throw new RangeError("Invalid relative humidity");
            vaporPressure = row.relativeHumidityPct / 100 * saturationPa(row.temperatureK - 273.15);
        }
        row.waterVaporDensityKgM3 = vaporPressure === null ? null : vaporPressure / (RV * row.temperatureK);
        levels.push(row);
    }
    const humid = levels.filter(row => row.waterVaporDensityKgM3 !== null);
    if (!humid.length) throw new RangeError("Sounding has no humidity reports");
    if (levels.length < rows.length) assumptions.push(assumption("reversedHeights", "Omit repeated or reversed heights to keep a single-valued altitude profile."));
    const interpolate = (z, key, list) => {
        if (z <= list[0].geopotentialHeightM) return list[0][key];
        const i = list.findIndex(row => row.geopotentialHeightM >= z);
        const a = list[i - 1], b = list[i], f = (z - a.geopotentialHeightM) / (b.geopotentialHeightM - a.geopotentialHeightM);
        return key === "pressurePa" ? Math.exp(Math.log(a[key]) * (1 - f) + Math.log(b[key]) * f) : a[key] * (1 - f) + b[key] * f;
    };
    const top = levels.at(-1), humidTop = humid.at(-1), standard = createAtmosphere();
    const standardTop = standard.sample(top.geopotentialHeightM);
    const profile = z => {
        if (z > top.geopotentialHeightM) {
            const state = standard.sample(z);
            return {temperatureK: Math.max(150, state.temperatureK + top.temperatureK - standardTop.temperatureK),
                pressurePa: state.pressurePa * top.pressurePa / standardTop.pressurePa, waterVaporDensityKgM3: 0};
        }
        return {temperatureK: interpolate(z, "temperatureK", levels), pressurePa: interpolate(z, "pressurePa", levels),
            waterVaporDensityKgM3: z <= humidTop.geopotentialHeightM ? interpolate(z, "waterVaporDensityKgM3", humid) :
                humidTop.waterVaporDensityKgM3 * Math.exp(-(z - humidTop.geopotentialHeightM) / humidityScaleHeightM)};
    };
    const contentKey = JSON.stringify(["sounding-v1", humidityScaleHeightM, String(visibilityM), densityScale,
        levels.map(row => [row.geopotentialHeightM, row.pressurePa, row.temperatureK, row.waterVaporDensityKgM3])]);
    const atmosphere = createAtmosphere({profile, visibilityM, densityScale,
        layerAltitudesM: [...new Set([...levels.map(row => row.geopotentialHeightM),
            ...standard.layerAltitudesM.filter(height => height > top.geopotentialHeightM)])].sort((a, b) => a - b)});
    return Object.freeze({atmosphere, contentKey, assumptions: Object.freeze(assumptions),
        levels: Object.freeze(levels.map(Object.freeze))});
}
