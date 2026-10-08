import {SENSOR_PRESETS, SCATTER_PRESETS, presetValues} from "./sensorPresets.js";
import {opticalSampling, electronsPerRadiance, integrationTime, ADC_MAX} from "./sensorMath.js";

// One menu and serialization contract. Numeric arguments use the unit field below;
// choice values are stable identifiers, booleans are unitless. Defaults are estimates
// unless the selected sensor supplies more specific provenance.
function parameter(key, group, type, unit, defaultValue, min, max, step, label, tooltip, extra = {}) {
    return Object.freeze({key, group, type, unit, default: defaultValue, min, max, step,
        label, tooltip, ...extra});
}
const number = (key, group, unit, def, min, max, step, label, tooltip) =>
    parameter(key, group, "number", unit, def, min, max, step, label, tooltip);
const choice = (key, group, def, labels, label, tooltip) => parameter(key, group, "select", "1",
    def, null, null, null, label, tooltip,
    {options: Object.freeze(Object.entries(labels).map(([value, optionLabel]) => Object.freeze({value, label: optionLabel})))});
const boolean = (key, group, def, label, tooltip) => parameter(key, group, "boolean", "1", def, 0, 1, 1, label, tooltip);
// Estimated environmental defaults and numerical control limits. The optical
// depth is -ln(0.01), a residual-contrast policy, not a measured cloud property.
const environmentSources = {
    groundTemperatureMode: "Estimated visual proxy from unlit terrain colors; visible imagery does not measure surface temperature",
    groundCondition: "Estimated class temperatures relative to air from published surface measurements and radiative-balance estimates",
    groundClimate: "Estimated: humid air limits night cooling; the automatic choice uses the surface dew point and relative humidity of the profile",
    groundCloudFraction: "Estimated default 0.3 without a weather report; published cloud factors scale night cooling and day heating",
    groundWindMps: "Estimated default 2 m/s without a weather report; published convective heat-transfer form",
    groundTemperatureK: "Estimated terrain reference; the standard-atmosphere sea-level value is not an observed ground temperature",
    groundTemperatureSpanK: "Estimated illustrative 10 K span, adjustable 0–30 K; darker sRGB luminance maps to warmer ground, not measured thermal contrast",
    cloudOpticalDepth: "Gray absorbing column: q=-ln(0.01); estimated 1% residual-contrast policy",
    seaMode: "Estimated diagnostic mean surface; statistical visible normals (published study)",
    seaWindMps: "Estimated U10 preview 5 m/s; sensitivity 2–10 m/s; Cox–Munk slope statistics (published measurement)",
    seaWindDirectionRad: "Estimated wind toward azimuth from local north, clockwise; 0 rad is an arbitrary preview orientation",
    seaSkinTemperatureK: "Estimated skin SST preview 293 K; sensitivity 288–297 K; independent of surface air temperature",
    seaSwellHeightM: "Estimated independent swell significant height; zero omits swell; Hs=4 sqrt(variance)",
    seaSwellPeriodS: "Estimated optional monochromatic deep-water swell, 13 s; k=(2 pi/T)^2/9.80665",
    seaSwellDirectionRad: "Estimated swell toward azimuth from local north, clockwise; independent of wind",
};
const definitions = [
    number("cloudOpticalDepth", "scene", "1", Math.log(100), 0, 20, .01, "Cloud absorption depth", "Estimated core absorption optical depth; texture alpha is normalized column, not thermal opacity. Scattering is omitted."),
    choice("seaMode", "scene", "smooth", {smooth: "Smooth comparison", statistical: "Statistical rough sea"}, "Sea state model", "Statistical ensemble mean from wind slopes and optional independent swell. No moving waves or crest occlusion."),
    number("seaWindMps", "scene", "m/s", 5, 0, 14, .1, "Sea wind at 10 m", "Estimated neutral-profile surface wind; drives the named Gaussian slope model, not aircraft-altitude wind."),
    number("seaWindDirectionRad", "scene", "rad", 0, 0, 2 * Math.PI, .01, "Sea wind toward azimuth", "Clockwise from local north. Directional reflection uses each pixel ray."),
    number("seaSkinTemperatureK", "scene", "K", 293, 250, 330, .1, "Sea skin temperature", "Estimated radiating water skin temperature, independent of air and bulk water temperature."),
    number("seaSwellHeightM", "scene", "m", 0, 0, 20, .1, "Swell significant height", "Independent optional monochromatic swell; zero omits it. Averaged slopes only, no geometric wave occlusion."),
    number("seaSwellPeriodS", "scene", "s", 13, 1, 30, .1, "Swell period", "Estimated deep-water monochromatic sensitivity case; does not infer wind-wave development."),
    number("seaSwellDirectionRad", "scene", "rad", 0, 0, 2 * Math.PI, .01, "Swell toward azimuth", "Independent swell direction, clockwise from local north."),
    choice("sensorPreset", "detector", "MX15", Object.fromEntries(Object.entries(SENSOR_PRESETS).map(([key, preset]) => [key, preset.label])), "Sensor preset", "Conditional sensor model; inspect the status and source of each value."),
    number("ambientTemperatureK", "scene", "K", 293, 150, 350, 1, "Ambient fallback temperature", "Fallback for untagged surfaces and thermal signatures without a scene air temperature. Tracked vehicles use the air profile at their altitude."),
    choice("atmosphereProfile", "scene", "standard", {standard: "Standard profile", sounding: "Loaded sounding"}, "Atmosphere profile",
        "Standard: the U.S. Standard Atmosphere 1976 shape with the surface air temperature and water vapor below. Loaded sounding: the measured temperature and humidity levels of a radiosonde loaded into the scene, the launch nearest the scene time."),
    number("surfaceTemperatureK", "scene", "K", 288.15, 150, 350, 0.1, "Surface air temperature", "Sea-level air temperature for the standard profile, overridden by a loaded sounding. Also sets water temperature in the Smooth comparison sea model."),
    // Estimated ground/sea fallback, using the U.S. Standard Atmosphere 1976
    // sea-level temperature as a reference, not an observed surface temperature.
    choice("groundTemperatureMode", "scene", "color", {color: "Terrain color estimate", materials: "Material classes", uniform: "Uniform temperature"}, "Ground temperature source", "Terrain color estimate: darker colors warmer. Material classes: imagery colors classed as vegetation, asphalt, concrete, roof or soil, each at the air temperature plus a researched offset for the time of day, with its own emissivity. Uniform: one temperature. Visible imagery does not measure temperature or material."),
    choice("groundCondition", "scene", "automatic", {automatic: "From sun and time", day: "Day, clear", overcast: "Day, overcast", evening: "Evening", night: "Late night"}, "Ground condition",
        "Material classes only. Sets each class's temperature relative to air. Automatic uses the scene's sun elevation and the time since sunset, for a clear sky."),
    choice("groundClimate", "scene", "automatic", {automatic: "From humidity", humid: "Warm humid", temperate: "Temperate", dry: "Dry"}, "Ground climate",
        "Material classes only. Dry air lets surfaces cool further at night and heat further by day. Automatic uses the surface dew point and relative humidity of the atmosphere profile."),
    number("groundCloudFraction", "scene", "1", 0.3, 0, 1, 0.05, "Cloud cover",
        "Material classes with automatic condition. Fraction of sky covered: FEW 0.2, SCT 0.45, BKN 0.75, OVC 1 in a weather report. Cloud reduces night cooling and day heating."),
    boolean("groundMapData", "scene", false, "Mapped roads and buildings",
        "Material classes only. Loads open map road and building data around the target (network): road surfaces are asphalt, footpaths concrete and building footprints roofs; elsewhere the imagery colors decide. Widths are typical for each road class."),
    number("groundWindMps", "scene", "m/s", 2, 0, 15, 0.1, "Surface wind",
        "Material classes only. Near-surface wind speed. Wind mixes surfaces toward the air temperature by day and night."),
    number("groundTemperatureK", "scene", "K", 288.15, 150, 350, 0.1, "Ground temperature", "Estimated terrain reference temperature. Color mode spans equally above and below this value; uncolored terrain and manual-sky water use this fallback."),
    number("groundTemperatureSpanK", "scene", "K", 10, 0, 30, 0.1, "Terrain color temperature span", "Estimated warm-to-cool span: black is warmer and white is cooler. Uses unlit sRGB luminance; imagery shadows and colors are not measured temperatures. Zero gives uniform ground temperature."),
    number("groundEmissivity", "scene", "1", 1, 0, 1, 0.01, "Ground emissivity", "Estimated opaque terrain emissivity. Atmospheric water uses its sea model; manual-sky water uses this fallback."),
    choice("skySource", "scene", "atmosphere", {atmosphere: "Atmosphere", manual: "Manual temperature"}, "Sky source", "Elevation-dependent background from the range-table atmosphere, or a manual brightness temperature."),
    boolean("skyGradient", "scene", true, "Sky elevation gradient", "Use each camera ray elevation for atmospheric sky and sea; disable for a uniform center-ray background."),
    number("skyTemperatureK", "scene", "K", 240, 0, 1000, 1, "Sky brightness temperature", "Equivalent blackbody radiance for the background in manual sky mode only."),
    number("objectTemperatureK", "scene", "K", 500, 0, 3000, 1, "Object temperature", "Suggested temperature for authoring generic surface tags. Untagged meshes use ambient."),
    number("emissivity", "scene", "1", 0.85, 0, 1, 0.01, "Object emissivity", "Suggested emissivity for authoring tags; the remaining opaque fraction reflects the environment."),
    choice("environmentSource", "scene", "manual", {manual: "Manual temperature", skyGround: "Sky and ground"}, "Reflected environment source",
        "Manual: every surface reflects one temperature. Sky and ground: each surface reflects the clear sky above and the ground below, weighted by the way it faces, calculated at its own altitude."),
    number("environmentTemperatureK", "scene", "K", 240, 0, 1500, 1, "Reflected environment", "Cosine-weighted hemispheric incident radiance expressed as blackbody temperature."),
    number("solarScale", "scene", "1", 0, 0, 1, 0.01, "Solar transmission", "Estimated transmission of the 5772 K solar continuum for diffuse reflection by opaque surfaces. Look View uses the scene's actual Sun direction. Zero disables reflection; no surface heating or cloud scattering is modeled."),
    number("sunDirectionX", "scene", "1", 0, -1, 1, 0.01, "Sun direction X", "World direction toward the sun, normalized with Y and Z."),
    number("sunDirectionY", "scene", "1", 1, -1, 1, 0.01, "Sun direction Y", "World direction toward the sun."),
    number("sunDirectionZ", "scene", "1", 0, -1, 1, 0.01, "Sun direction Z", "World direction toward the sun."),
    boolean("atmosphereEnabled", "scene", true, "Atmosphere", "Apply the estimated 12-band transmission and thermal path emission."),
    number("sensorAltitudeM", "scene", "m", 1500, 0, 30000, 10, "Sensor altitude", "Altitude above the spherical surface for the atmospheric ray."),
    number("pathElevationDeg", "scene", "degree", 0, -90, 90, 0.01, "Atmospheric elevation", "Center ray elevation; one narrow-field range table is used for all pixels."),
    number("atmosphereMaxRangeM", "scene", "m", 200000, 1, 500000, 100, "Atmosphere range", "Maximum lookup range. Geometry beyond this range is rejected."),
    number("visibilityM", "scene", "m", 23000, 100, 200000, 100, "Visibility", "Estimated visible meteorological range used for the aerosol profile."),
    number("waterVaporDensityKgM3", "scene", "kg/m³", 0.01, 0, 0.03, 0.0001, "Surface water vapor", "Estimated surface density with a 2000 m scale height; capped at saturation."),
    number("bandMinUm", "optics", "um", 3, 3, 4.99, 0.01, "Band lower limit", "Flat photon response begins here; atmosphere supports 3–5 um."),
    number("bandMaxUm", "optics", "um", 5, 3.01, 5, 0.01, "Band upper limit", "Flat photon response ends here; must exceed the lower limit."),
    number("apertureM", "optics", "m", 0.150, 0.0001, 2, 0.001, "Aperture diameter", "Entrance pupil diameter for diffraction and photon collection."),
    choice("focalStep", "optics", "675", {free: "Free optical field", ...Object.fromEntries(Object.keys(SENSOR_PRESETS.MX15.focalSteps).map(key => [key, `${key} mm`]))}, "Focal step", "Preset optical lens step, pupil policy and displayed detector window. Free uses fieldMode; presets without steps always use Free."),
    choice("pupilPolicy", "optics", "holdFNumber", {holdFNumber: "Hold f-number (estimated)", keepPupil: "Keep pupil (estimated)"}, "Stepped pupil policy", "Hold f-number scales the reference pupil with focal length; Keep pupil retains its diameter. Neither policy is measured."),
    number("pupilReferenceM", "optics", "m", 0.150, 0.005, 1, 0.001, "Pupil at reference step", "Estimated MX-15 pupil at 675 mm, range 0.120–0.180 m. Sets aperture at each optical step."),
    choice("fieldMode", "optics", "fieldOfView", {fieldOfView: "Vertical field of view", focalLength: "Focal length"}, "Optical field control", "The other field is calculated using detector height and pitch."),
    number("focalLengthM", "optics", "m", 0.675, 0.005, 10, 0.001, "Focal length", "Effective focal length; linked to field of view and pitch."),
    number("verticalFovDeg", "optics", "degree", SENSOR_PRESETS.MX15.parameters.verticalFovDeg.value, 0.01, 60, 0.001, "Vertical field of view", "Native optical field before digital zoom."),
    number("opticalTransmission", "optics", "1", 0.65, 0, 1, 0.01, "Optical transmission", "Photon throughput excluding atmosphere and detector quantum efficiency."),
    boolean("opticsEnabled", "optics", true, "Diffraction", "Apply the normalized polychromatic circular pupil core."),
    number("psfRangeM", "optics", "m", 0, 0, 500000, 100, "PSF source range", "Source blackbody spectrum weighted by path transmission at this range; zero disables path weighting. A host may override per frame."),
    number("psfTemperatureK", "optics", "K", 500, 150, 3000, 1, "PSF spectral temperature", "Estimated common source spectrum for photon weighting of seven wavelength bins."),
    number("opticsRadiusPx", "optics", "pixel", 32, 2, 80, 1, "Core support radius", "Finite core radius in detector pixels; omitted tails are renormalized."),
    choice("scatterPreset", "optics", "clean", {clean: "Clean window", dirty: "Dirty window", custom: "Custom"}, "Scatter preset", "Estimated sensitivity cases; selecting a preset sets fraction, shoulder, slope and cutoff. Editing one selects Custom."),
    number("scatterFraction", "optics", "1", 0.003, 0, 1, 0.001, "Scatter fraction", "Estimated fraction redistributed into the normalized skirt."),
    number("scatterSlope", "optics", "1", 2.5, 0.5, 6, 0.1, "Scatter slope", "Estimated far-wing exponent in [1+(angle/shoulder)²]^(-slope/2)."),
    number("scatterShoulderRad", "optics", "rad", 40e-6, 1e-6, 0.02, 1e-6, "Scatter shoulder", "Estimated transition angle from flat core to power-law skirt."),
    number("scatterCutoffRad", "optics", "rad", 0.02, 1e-6, 0.3, 1e-6, "Scatter cutoff", "Finite support angle, required even for slopes at or below two."),
    number("turbulenceR0M", "optics", "m", 0, 0, 100, 0.001, "Turbulence coherence diameter", "Fried r0 at 4 um; zero disables. Wavelength-scaled long-exposure Kolmogorov MTF, with no finite-time correction."),
    choice("turbulenceMode", "optics", "manual", {manual: "Manual", geometry: "Camera to target"}, "Turbulence path", "A geometry-aware host integrates the estimated turbulence profile along the physical camera-to-target path. Manual uses the specified coherence diameter."),
    number("systemBlurHorizontalRmsUrad", "optics", "urad RMS", 0, 0, 100, 0.1, "Horizontal residual blur", "Independent Gaussian residual along display x, in angle before sampling and detector noise. Excludes turbulence, exposure jitter and charge diffusion."),
    number("systemBlurVerticalRmsUrad", "optics", "urad RMS", 0, 0, 100, 0.1, "Vertical residual blur", "Independent Gaussian residual along display y, in angle before sampling and detector noise. MX-15 long steps use about 40 µrad with the measured display curve; origin unresolved."),
    number("jitterRmsUrad", "optics", "urad RMS/axis", 0, 0, 100, 0.001, "Exposure jitter", "Estimated per-axis intra-exposure Gaussian RMS; excludes frame-to-frame centroid motion."),
    number("diffusionSigmaPx", "detector", "native pixel", 0, 0, 0.4, 0.01, "Charge diffusion", "Estimated Gaussian sigma before native sampling; zero disables. Pixel-area integration is separate."),
    number("defocusM", "optics", "m", 0, -0.002, 0.002, 1e-6, "Defocus", "Longitudinal detector displacement; computed as quadratic pupil phase."),
    choice("opticalSamplingMode", "optics", "nyquist", {nyquist: "Optical Nyquist", manual: "Manual"}, "Optical sampling policy", "Calculate sampling from the shortest wavelength and f-number within allocation limits. Editing the factor selects Manual."),
    choice("supersample", "optics", 4, {2: "2 ×", 4: "4 ×", 8: "8 ×"}, "Optical sampling", "Fine radiance grid factor; calculated in Nyquist mode. Small mesh coverage is independently refined to 128 samples per detector pixel (live views: up to 64 tiles per frame, overflow reported)."),
    number("detectorWidth", "detector", "pixel", 640, 1, 2048, 1, "Detector width", "Native sampling columns; independent of picture size."),
    number("detectorHeight", "detector", "pixel", 512, 1, 2048, 1, "Detector height", "Native sampling rows; independent of picture size."),
    number("pixelPitchM", "detector", "m", 20e-6, 1e-6, 100e-6, 0.01e-6, "Pixel pitch", "Geometric detector pixel spacing."),
    choice("exposureMode", "detector", "wellFill", {wellFill: "Reference well fill", manual: "Manual"}, "Exposure policy", "Calculate integration from a reference blackbody and mean dark current, or use manual integration time."),
    number("wellFillFraction", "detector", "1", 0.5, 0.01, 1, 0.01, "Reference well fraction", "Target fraction of full well before dark subtraction; 50% is a detector NETD comparison condition."),
    number("wellFillReferenceK", "detector", "K", 300, 150, 1000, 1, "Exposure reference temperature", "Unshaded blackbody temperature at the detector input, before integration."),
    number("shadingK", "detector", "K", 0.3, 0, 0.5, 0.01, "Edge shading", "Estimated edge-minus-center signal at a fixed 300 K reference; zero disables the detector-fixed shading map."),
    number("shadingWidth", "detector", "1", 0.9, 0.5, 1.5, 0.01, "Shading width", "Radial width in native detector half-widths; digital zoom crops this fixed signal."),
    number("fixedPatternFraction", "detector", "1", 0.0002, 0, 0.0004, 0.00001, "Residual fixed pattern", "Estimated pixel offset RMS as a fraction of ADC range; fixed across frames, independent of temporal noise switch. Zero disables."),
    number("integrationTimeS", "detector", "s", 0.002, 1e-6, 1, 1e-5, "Integration time", "Photon collection time in manual exposure mode only; reference well-fill mode reports its calculated time."),
    number("quantumEfficiency", "detector", "electron/photon", 0.7, 0, 1, 0.01, "Quantum efficiency", "Mean collected electrons per transmitted photon."),
    number("fillFactor", "detector", "1", 0.9, 0.1, 1, 0.01, "Fill factor", "Active square area fraction; affects sampling and electron collection once each."),
    number("wellElectrons", "detector", "electron/pixel", 7e6, 1, 1e9, 1000, "Well capacity", "Charge limit before read noise; also the ideal 14-bit ADC full scale."),
    boolean("noiseEnabled", "detector", true, "Detector noise", "Frame-seeded Poisson shot noise and Gaussian read noise."),
    boolean("shotNoiseEnabled", "detector", true, "Shot noise", "Exact Poisson below 64 expected electrons; Gaussian approximation above."),
    number("readNoiseElectrons", "detector", "electron RMS", 500, 0, 1e5, 1, "Read noise", "Gaussian charge uncertainty added after well clipping."),
    number("adcOffsetCounts", "detector", "count", 256, 0, 4096, 1, "ADC pedestal", "Estimated electronic offset before quantization. Raw counts retain it; manual and radiometric windows remove it, adaptive modes absorb it in their statistics."),
    number("darkElectronsPerS", "detector", "electron/pixel/s", 1e5, 0, 1e8, 100, "Dark current", "Mean is removed after well clipping; dark shot noise remains."),
    number("noiseSeed", "detector", "1", 12345, 0, 4294967295, 1, "Noise seed", "Combined with pixel index and frame for reproducible noise."),
    number("temporalFilterAlpha", "processing", "1", 0, 0, 0.99, 0.01, "Temporal noise memory", "Previous filtered-count weight per delivered frame: y = (1-alpha)x + alpha yPrevious. Zero is off; repeated/backward frames reset."),
    choice("agcDynamics", "processing", "endpoints", {endpoints: "Window endpoints", gainOffset: "Display gain and offset"}, "Gain dynamics", "Choose exponential relaxation of count endpoints or of the affine display gain and offset."),
    choice("gainMode", "processing", "manual", {manual: "Manual", automatic: "Automatic", plateau: "Plateau equalization", fixedRadiometric: "Fixed radiometric"}, "Gain mode", "Choose a fixed count window, adaptive statistics, capped histogram or fixed photon scale."),
    choice("gainRegion", "processing", "detector", {detector: "Whole detector", displayed: "Displayed crop"}, "Gain statistics region", "Automatic window and plateau histogram use the native detector or centers inside the digital zoom crop."),
    number("fixedGain", "processing", "1", 1, 0.001, 10000, 0.01, "Fixed gain", "Manual display drive = (counts - level) × gain / 16383 + 0.5."),
    number("fixedLevel", "processing", "count", 8191.5, 0, 16383, 0.5, "Fixed level", "Signal count after pedestal removal mapped to middle gray before response and polarity."),
    number("lowPercentile", "processing", "1", 0.01, 0, 0.99, 0.001, "Lower percentile", "Lower adaptive count-window quantile."),
    number("highPercentile", "processing", "1", 0.99, 0.01, 1, 0.001, "Upper percentile", "Upper adaptive count-window quantile."),
    number("agcTimeConstantS", "processing", "s", 0.3, 0, 30, 0.01, "Gain time constant", "Exponential settling time; zero responds immediately."),
    number("frameRateHz", "processing", "Hz", 30, 1, 240, 0.01, "Frame rate", "Converts frame deltas to seconds for adaptive gain; repeated frames recompute the current window without smoothing."),
    number("minimumWindowCounts", "processing", "count", 32, 1, 16383, 1, "Minimum window", "Like a camera's maximum gain: a scene with less spread than this is widened equally about its middle, so low contrast stays mid-gray. For the MX-15 preset near 295 K, about 250 counts per kelvin."),
    number("plateauFactor", "processing", "1", 4, 0.01, 100, 0.1, "Histogram plateau", "Cap per detector-level bin = factor × pixel count / 16384; discarded counts are not redistributed."),
    number("localAmount", "processing", "1", 0, 0, 5, 0.05, "Local enhancement", "Signed unsharp detail before output clipping; produces opposite-sign rings."),
    number("localRadiusPx", "processing", "pixel", 3, 0, 20, 0.1, "Local radius", "Gaussian sigma in detector pixels; finite support is four sigma."),
    number("radiometricLow", "processing", "1e20 photon/s/m²/sr", 0, 0, 1e5, 0.01, "Radiometric low", "Fixed lower photon-radiance endpoint, recovered from counts using the exposure factor."),
    // Calculated MX-15 initial endpoint: (7e6 * (1-256/16383)) / 8363835.07150155.
    // normalizeSettings derives it again from the selected exposure and detector.
    number("radiometricHigh", "processing", "1e20 photon/s/m²/sr", 0.8238587041668244, 0.001, 1e6, 0.01, "Radiometric high", "Defaults to available ADC signal headroom at the selected exposure; an explicit edit holds this radiance endpoint."),
    choice("polarity", "display", "whiteHot", {whiteHot: "White hot", blackHot: "Black hot"}, "Polarity", "Black hot is the exact 255-code inverse of white hot, including the response curve."),
    number("responseGamma", "display", "1", 1, 0.1, 5, 0.01, "Response gamma", "White-hot response = clamped drive^(1/gamma); invert after quantization."),
    choice("displayCurve", "display", "linear", {linear: "Linear", measured: "Measured preset curve"}, "Display curve", "Fixed lookup response after the count window and gamma, before quantization and polarity. Use gamma 1 for the measured law; MX-15 U depth uncertainty ±20%."),
    // Estimated gain-control range; offset range spans the full 8-bit code scale.
    number("polarityAffineGain", "display", "1", 1, 0, 10, .01, "White-hot output gain", "Output affine after the curve: white = gain × warm-increasing code + offset. Default 1 preserves exact inversion; the optional IB6830 recording profile uses 1.05."),
    number("polarityAffineOffset", "display", "code", 0, -255, 255, 1, "White-hot output offset", "Output offset in 8-bit codes before clipping and rounding. Default 0 preserves exact inversion; the optional IB6830 recording profile uses +55 codes."),
    number("digitalZoom", "display", "1", 1, 1, 16, 0.1, "Digital zoom", "Center crop after detector processing; does not alter optical field or counts."),
    choice("sampling", "display", "linear", {nearest: "Nearest neighbor", linear: "Linear (half-pixel)", sampleCentered: "Linear (sample-centered)"}, "Enlargement sampling", "Interpolate the final detector raster; float filtering is implemented explicitly."),
    choice("diagnosticView", "display", "display", {radiance: "Radiance", detectorCounts: "Detector counts", display: "Display"}, "Diagnostic view", "Radiance uses fixed radiometric endpoints; counts use 0–16383. Readbacks retain physical units."),
    number("pictureWidth", "display", "pixel", 1280, 1, 8192, 1, "Reference picture width", "Preset presentation metadata; the supplied output target determines actual size."),
    number("pictureHeight", "display", "pixel", 1024, 1, 8192, 1, "Reference picture height", "Preset presentation metadata; does not change native sampling."),
];
export const THERMAL_PARAMETERS = Object.freeze(definitions.map(definition => {
    const provenance = SENSOR_PRESETS.MX15.parameters[definition.key];
    // Numeric choices keep numeric serialized values.
    const options = definition.key === "supersample" ? definition.options.map(option => ({...option, value: Number(option.value)})) : definition.options;
    const derived = ["sensorAltitudeM", "pathElevationDeg", "frameRateHz"].includes(definition.key);
    return Object.freeze({...definition, owner: derived ? "geometry" : definition.group === "scene" ? "environment" : "sensor",
        labelKey: `thermal.parameters.${definition.key}.label`, tooltipKey: `thermal.parameters.${definition.key}.tooltip`,
        ...(options ? {options} : {}),
        ...(environmentSources[definition.key] ? {status: "estimated", source: environmentSources[definition.key]} : {}),
        ...(provenance ? {default: provenance.value, status: provenance.status, source: provenance.source,
            presetMetadata: Object.fromEntries(Object.entries(SENSOR_PRESETS).map(([name, preset]) => [name, preset.parameters[definition.key]]))} : {})});
}));

/** Fresh settings object, values in THERMAL_PARAMETERS units, including saved provenance. */
export function defaultSettings() { return normalizeSettings({}); }

/** Input settings in schema units. Unknown keys are discarded; NaN/Infinity and wrong
 * types throw. Numeric values clamp; integer pixel dimensions and seeds round. A UI step
 * is a control increment, not a forced loss of saved physical precision.
 */
export function normalizeSettings(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Thermal settings must be an object");
    const legacyBlur = input.systemBlurRmsUrad;
    if (legacyBlur !== undefined && (typeof legacyBlur !== "number" || !Number.isFinite(legacyBlur)))
        throw new RangeError("systemBlurRmsUrad must be finite");
    const name = input.sensorPreset ?? "MX15";
    const preset = presetValues(name);
    const result = {};
    for (const parameter of THERMAL_PARAMETERS) {
        const legacy = ["systemBlurHorizontalRmsUrad", "systemBlurVerticalRmsUrad"].includes(parameter.key) ? legacyBlur : undefined;
        const candidate = input[parameter.key] !== undefined ? input[parameter.key] : legacy ?? preset[parameter.key] ?? parameter.default;
        let resolved = candidate;
        if (parameter.type === "number") {
            if (typeof candidate !== "number" || !Number.isFinite(candidate)) throw new RangeError(`${parameter.key} must be finite`);
            resolved = Math.min(parameter.max, Math.max(parameter.min, candidate));
            if (parameter.step === 1 && ["detectorWidth", "detectorHeight", "pictureWidth", "pictureHeight", "opticsRadiusPx", "noiseSeed"].includes(parameter.key)) resolved = Math.round(resolved);
        } else if (parameter.type === "boolean") {
            if (typeof candidate !== "boolean") throw new TypeError(`${parameter.key} must be boolean`);
        } else if (!parameter.options.some(option => option.value === candidate)) throw new RangeError(`Invalid ${parameter.key}: ${candidate}`);
        result[parameter.key] = resolved;
    }
    if (result.displayCurve === "measured" && !SENSOR_PRESETS[name].displayCurveLUT)
        throw new RangeError("No measured display curve for this sensor");
    // Flat controls survive schema-based host saves. Expand the optional object
    // shorthand once, so later menu edits and preset changes have one authority.
    const affine = input.polarityAffine;
    if (affine !== undefined && (!affine || typeof affine !== "object" || Array.isArray(affine) ||
        !Number.isFinite(affine.gain) || affine.gain < 0 || !Number.isFinite(affine.offset)))
        throw new RangeError("polarityAffine requires a finite nonnegative gain and finite offset in codes");
    for (const [field, key] of [["gain", "polarityAffineGain"], ["offset", "polarityAffineOffset"]]) {
        if (affine) {
            const definition = THERMAL_PARAMETERS.find(p => p.key === key);
            result[key] = Math.min(definition.max, Math.max(definition.min, affine[field]));
        }
    }
    // A menu selection applies all four values; a numeric edit becomes Custom.
    const selected = SCATTER_PRESETS[result.scatterPreset];
    const selectionChanged = input.scatterPreset !== undefined &&
        input.scatterPreset !== input.presetMetadata?.scatterPreset?.value;
    if (selected && selectionChanged) Object.assign(result, selected);
    else if (selected && Object.keys(selected).some(key => result[key] !== selected[key])) result.scatterPreset = "custom";
    if (result.bandMaxUm <= result.bandMinUm) throw new RangeError("Band upper limit must exceed lower limit");
    if (result.highPercentile <= result.lowPercentile) throw new RangeError("Upper percentile must exceed lower percentile");
    const sensor = SENSOR_PRESETS[name];
    const priorStep = input.presetMetadata?.focalStep;
    const previousOptics = priorStep?.selection;
    const stepChanged = input.focalStep !== undefined && input.focalStep !== priorStep?.value;
    // Explicit legacy optical edits remain usable; menu edits leave the stepped mode.
    const freeEdit = !stepChanged && previousOptics &&
        ["fieldMode", "focalLengthM", "verticalFovDeg", "apertureM"].some(key =>
            input[key] !== undefined && input[key] !== previousOptics[key]);
    const legacyFree = input.focalStep === undefined &&
        ["fieldMode", "focalLengthM", "verticalFovDeg", "apertureM"].some(key => input[key] !== undefined);
    if (!sensor.focalSteps || freeEdit || legacyFree) result.focalStep = "free";
    const step = sensor.focalSteps?.[result.focalStep];
    if (step) {
        result.fieldMode = "focalLength";
        result.focalLengthM = step.focalLengthM.value;
        result.apertureM = result.pupilReferenceM * (result.pupilPolicy === "holdFNumber"
            ? result.focalLengthM / sensor.pupilReferenceFocalM : 1);
        result.pictureWidth = step.windowWidth.value * step.enlargement.value;
        result.pictureHeight = step.windowHeight.value * step.enlargement.value;
    }
    const blurDefaults = {};
    for (const key of ["systemBlurHorizontalRmsUrad", "systemBlurVerticalRmsUrad"]) {
        const fallback = {value: 0, unit: "urad RMS", status: "estimated", source: "No measured residual assigned to free optics"};
        // A legacy preset scalar, like a saved scalar, applies to both missing axes.
        const blurDefault = step?.[key] ?? step?.systemBlurRmsUrad ?? (sensor.focalSteps ? fallback :
            sensor.parameters[key] ?? sensor.parameters.systemBlurRmsUrad ?? fallback);
        blurDefaults[key] = blurDefault;
        if (legacyBlur === undefined && (input[key] === undefined ||
            (input.presetMetadata?.[key]?.overridden === false && input[key] === input.presetMetadata[key].value)))
            result[key] = blurDefault.value;
    }
    result.detectorWindow = {width: Math.min(result.detectorWidth, step?.windowWidth.value ?? result.detectorWidth),
        height: Math.min(result.detectorHeight, step?.windowHeight.value ?? result.detectorHeight)};
    const halfHeightM = result.detectorHeight * result.pixelPitchM / 2;
    const focalDefinition = THERMAL_PARAMETERS.find(parameter => parameter.key === "focalLengthM");
    const fieldDefinition = THERMAL_PARAMETERS.find(parameter => parameter.key === "verticalFovDeg");
    const focalMin = Math.max(focalDefinition.min, halfHeightM / Math.tan(fieldDefinition.max * Math.PI / 360));
    const focalMax = Math.min(focalDefinition.max, halfHeightM / Math.tan(fieldDefinition.min * Math.PI / 360));
    const requestedFocal = result.fieldMode === "fieldOfView"
        ? halfHeightM / Math.tan(result.verticalFovDeg * Math.PI / 360) : result.focalLengthM;
    result.focalLengthM = Math.min(focalMax, Math.max(focalMin, requestedFocal));
    if (result.fieldMode === "focalLength" || requestedFocal !== result.focalLengthM)
        result.verticalFovDeg = 2 * Math.atan(halfHeightM / result.focalLengthM) * 180 / Math.PI;
    if (result.apertureM > 2 * result.focalLengthM) throw new RangeError("Pupil aperture must not exceed twice the focal length (numerical aperture <= 1)");
    // Calculated upper received radiance from the smaller of charge-well and ADC
    // headroom. Saved derived defaults follow exposure; explicit endpoints remain fixed.
    const factor = electronsPerRadiance(result);
    const high = factor > 0 ? Math.max(0, Math.min(result.wellElectrons - result.darkElectronsPerS * integrationTime(result),
        result.wellElectrons * (1 - result.adcOffsetCounts / ADC_MAX))) / factor : 1;
    if (input.radiometricHigh === undefined || input.radiometricHigh === input.radiometricDefaults?.high)
        result.radiometricHigh = Math.max(Number.EPSILON, high);
    result.radiometricDefaults = {high: Math.max(Number.EPSILON, high), status: "calculated",
        source: "min(well - mean dark charge, ADC signal headroom) / electronsPerRadiance"};
    if (result.radiometricHigh <= result.radiometricLow) throw new RangeError("Radiometric high must exceed low");
    // A factor edit on normalized settings selects Manual. Legacy saves lack the
    // mode/derived record and start in Nyquist, regardless of their old factor.
    if (input.opticalSamplingMode === "nyquist" && input.opticalSampling?.mode === "nyquist" &&
        input.supersample !== undefined && input.supersample !== input.opticalSampling.factor)
        result.opticalSamplingMode = "manual";
    const sampling = opticalSampling(result);
    result.supersample = sampling.factor;
    Object.defineProperty(result, "opticalSampling", {value: sampling, enumerable: true});
    result.presetMetadata = Object.fromEntries(Object.entries(SENSOR_PRESETS[name].parameters).map(([key, parameter]) =>
        [key, {...parameter, overridden: typeof parameter.value === "number"
            ? Math.abs(result[key] - parameter.value) > 1e-12 * Math.max(1, Math.abs(parameter.value))
            : result[key] !== parameter.value}]));
    for (const [key, source] of Object.entries(environmentSources)) {
        const definition = THERMAL_PARAMETERS.find(p => p.key === key);
        result.presetMetadata[key] = {value: result[key], unit: definition.unit, status: "estimated", source,
            overridden: result[key] !== definition.default};
    }
    for (const [key, blurDefault] of Object.entries(blurDefaults)) {
        const migrated = (legacyBlur !== undefined && input[key] === undefined) ||
            input.presetMetadata?.[key]?.migratedFrom === "systemBlurRmsUrad";
        result.presetMetadata[key] = {...blurDefault, overridden: migrated || result[key] !== blurDefault.value,
            ...(migrated ? {migratedFrom: "systemBlurRmsUrad"} : {})};
    }
    result.presetMetadata.focalStep.value = result.focalStep;
    result.presetMetadata.focalStep.selection = Object.fromEntries(
        ["fieldMode", "focalLengthM", "verticalFovDeg", "apertureM"].map(key => [key, result[key]]));
    result.presetMetadata.scatterPreset.value = result.scatterPreset;
    if (result.scatterPreset === "dirty") for (const key of ["scatterPreset", ...Object.keys(SCATTER_PRESETS.dirty)])
        result.presetMetadata[key] = {value: result[key], unit: SENSOR_PRESETS[name].parameters[key].unit,
            status: "estimated", source: "Dirty-window sensitivity prior; published studies", overridden: true};
    return result;
}

/** name is one of SENSOR_PRESETS; settings and provenance are independent copies. */
export function settingsForPreset(name) { return normalizeSettings({sensorPreset: name}); }
