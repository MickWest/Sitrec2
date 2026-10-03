// Presets describe conditional camera models. Every parameter includes provenance.
// Lengths are m, field angles degrees, exposure s, charge electrons/pixel/exposure.
const value = (number, unit, status, source) => Object.freeze({value: number, unit, status, source});
const estimated = (number, unit, source) => value(number, unit, "estimated", source);
const calculated = (number, unit, source) => value(number, unit, "calculated", source);
const published = (number, unit, source) => value(number, unit, "published", source);
// Estimated sensitivity cases, not measured camera/window specifications.
// Basis: published studies.
export const SCATTER_PRESETS = Object.freeze({
    clean: Object.freeze({scatterFraction: 0.003, scatterShoulderRad: 40e-6, scatterSlope: 2.5, scatterCutoffRad: 0.02}),
    dirty: Object.freeze({scatterFraction: 0.03, scatterShoulderRad: 0.002, scatterSlope: 1.7, scatterCutoffRad: 0.1}),
});
// Estimated clean ranges: fraction .0001–.02, shoulder 20e-6–.001 rad,
// slope 1.5–3.5, cutoff .005–.1 rad. Dirty: .003–.15, .0002–.02 rad,
// 1.2–3.0, .02–.3 rad. They are sensitivity bounds, not hardware tolerances.
const mxManual = "Published operations manual";
const mxVideo = "IB6830 recording (2014-11-11), fixed-pixel footprints and gain recovery";
const mxSystemBlur = Object.freeze({...value(30, "urad RMS/axis", "measured",
    "measured from the Chilean Navy IB6830 video (frames 10450–14200), see the thermal README"),
    statusDetail: "measured from the IB6830 video; origin estimated (long-step optics focus or wavefront error)"});
const noSystemBlur = estimated(0, "urad RMS/axis", "No measured residual optical blur assigned to this sensor or step");
const mxSteps = Object.freeze(Object.fromEntries([27, 135, 675, 1012].map(mm => [String(mm), Object.freeze({
    focalLengthM: published(mm / 1000, "m", mxManual),
    windowWidth: calculated(mm === 1012 ? 480 : 640, "pixel", `${mxVideo}; active width / measured 2× enlargement`),
    windowHeight: calculated(mm === 1012 ? 384 : 512, "pixel", `${mxVideo}; active height / measured 2× enlargement`),
    systemBlurRmsUrad: mm >= 675 ? mxSystemBlur : noSystemBlur,
    enlargement: calculated(2, "display pixel/native pixel", `${mxVideo}; native fixed-pixel spacing`),
})])));
const common = {
    focalStep: estimated("free", "1", "No verified stepped lens assigned; use fieldMode"),
    pupilPolicy: estimated("holdFNumber", "1", "Conditional pupil proportional to focal length; keepPupil is the alternative"),
    pupilReferenceM: estimated(0.150, "m", "MX-15 reference at 0.675 m; comparison f/4–f/5.5 optics, range 0.120–0.180 m; later published reconstruction"),
    psfRangeM: estimated(0, "m", "Zero retains the unattenuated blackbody PSF spectrum; finite range uses the selected atmosphere"),
    temporalFilterAlpha: estimated(0, "1", "No temporal memory assigned without camera evidence"),
    agcTimeConstantS: estimated(0.3, "s", "Unverified generic gain adaptation surrogate"),
    agcDynamics: estimated("endpoints", "1", "Exponential percentile-endpoint surrogate; camera law unknown"),
    sampling: estimated("linear", "1", "Half-pixel linear enlargement; camera resampling unverified"),
    opticalSamplingMode: calculated("nyquist", "1", "Fine sample interval <= bandMinUm × 1e-6 × focalLengthM / apertureM / 2; smallest fitting factor in 2, 4, 8"),
    skySource: estimated("atmosphere", "1", "Elevation-dependent clear sky through the selected atmosphere; surface intersection assumes sea at surface air temperature"),
    skyGradient: calculated(true, "1", "Ray elevation = asin(direction dot local up); radiance interpolated through the selected atmosphere"),
    turbulenceR0M: estimated(0, "m", "Off for an unspecified path; integrate HV or a supplied Cn² profile in turbulence.js at 4 um"),
    systemBlurRmsUrad: noSystemBlur,
    jitterRmsUrad: estimated(0, "urad RMS/axis", "Off without an intra-exposure line-of-sight motion estimate"),
    diffusionSigmaPx: estimated(0, "native pixel", "Off without a charge-spreading estimate; applied before pixel-area sampling"),
    gainRegion: estimated("detector", "1", "native-detector statistics are a model assumption; actual AUTO region and crop-before/after statistics are unverified"),
    bandMinUm: estimated(3, "um", "Common MWIR comparison window; exact legacy filter unknown"),
    bandMaxUm: estimated(5, "um", "Common MWIR comparison window; exact legacy filter unknown"),
    opticalTransmission: estimated(0.65, "1", "0.65 retained as a conditional scalar; filter/window/lens curves unknown; no new measured value"),
    quantumEfficiency: estimated(0.7, "electron/photon", "0.70 retained; estimated InSb midband bracket 0.5–0.9, not flat measured camera QE"),
    integrationTimeS: estimated(0.002, "s", "0.002 s retained as fixed-exposure comparison; estimated 0.0001–0.0165 s MX15 experiment range, 0.0001–0.010 s generic class starting range; neither is a camera limit"),
    // Estimated electronic headroom, not a measured camera pedestal. 256 codes
    // exceeds the default combined 3.5-count read/fixed-pattern RMS by >70 sigma.
    adcOffsetCounts: estimated(256, "count", "Electronic pedestal model: 256 / 16383 of ADC scale; removed by display windows, protects signed zero-signal noise"),
    wellElectrons: estimated(7000000, "electron/pixel", "7e6 retained; estimated 1e6–1e7 electron/pixel class bracket, select consistently with gain and read noise"),
    readNoiseElectrons: estimated(500, "electron RMS", "500 retained; estimated 100–1000 electron RMS/sample class bracket; no installed readout measurement"),
    darkElectronsPerS: estimated(100000, "electron/pixel/s", "1e5 retained as an unverified scenario assumption; detector temperature and cutoff unknown; class measurements do not validate this target value"),
    fillFactor: estimated(0.9, "1", "0.9 retained as assumed active square area fraction; pitch does not establish photosensitive width"),
    exposureMode: estimated("wellFill", "1", "conditional well-fill controller, not recovered camera control; 50% well at 293 K is a published detector NETD test condition; 300 K reference and chosen target fill are model assumptions"),
    wellFillFraction: estimated(0.5, "1", "conditional well-fill controller, not recovered camera control; 50% well at 293 K is a published detector NETD test condition; 300 K reference and chosen target fill are model assumptions"),
    wellFillReferenceK: estimated(300, "K", "conditional well-fill controller, not recovered camera control; 50% well at 293 K is a published detector NETD test condition; 300 K reference and chosen target fill are model assumptions"),
    surfaceTemperatureK: published(288.15, "K", "U.S. Standard Atmosphere 1976, sea-level temperature; not event weather"),
    // Estimated equivalent amplitude .05–.5 K at 300 K; width .5–1.5 half-widths.
    shadingK: estimated(0.30, "K", "Residual optical shading prior; published studies"),
    shadingWidth: estimated(0.9, "1", "Smooth radial residual shading model in detector half-widths; optical prescription unknown"),
    // Estimated RMS range .0001–.0004 of usable ADC range; offset only, not gain error.
    fixedPatternFraction: estimated(0.0002, "1", "Residual offset prior; published detector study and detector data sheet"),
    scatterPreset: estimated("clean", "1", "Clean-window sensitivity model; published studies"),
    scatterFraction: estimated(0.003, "1", "Clean-window sensitivity prior; published studies; not measured turret scatter"),
    scatterSlope: estimated(2.5, "1", "Finite power-law skirt; no measured turret PSF"),
    scatterShoulderRad: estimated(40e-6, "rad", "Conditional image-plane shoulder"),
    scatterCutoffRad: estimated(0.02, "rad", "Estimated accepted angular support; finite power-law normalization from a published study"),
};
export const SENSOR_PRESETS = Object.freeze({
    MX15: Object.freeze({label: "MX-15 class (stepped optics)", focalSteps: mxSteps, pupilReferenceFocalM: mxSteps["675"].focalLengthM.value, parameters: Object.freeze({...common,
        focalStep: published("675", "1", mxManual),
        systemBlurRmsUrad: mxSystemBlur,
        // Estimated alpha range .15–.55; decoded memory includes codec uncertainty.
        temporalFilterAlpha: estimated(0.30, "1", `${mxVideo}; pre-encode memory surrogate, range 0.15–0.55 at 30000/1001 frames/s`),
        agcTimeConstantS: estimated(0.12, "s", `${mxVideo}; displayed gain/offset recovery, range 0.10–0.15 s; not an endpoint time constant`),
        agcDynamics: estimated("gainOffset", "1", `${mxVideo}; common affine display recovery; histogram region unidentified`),
        sampling: calculated("sampleCentered", "1", `${mxVideo}; measured 2× footprint approximately 0.5/1/0.5`),
        apertureM: estimated(0.15, "m", "Published MX-15D reconstruction; estimated 0.150 m from comparison f/4–f/5.5 lens classes and later 0.160 m reconstruction; range 0.120–0.180 m; retain 0.135 m baseline and 0.1125–0.225 m wider sensitivity envelope"),
        bandMaxUm: published(5, "um", "Published manufacturer data sheet; legacy-family specification, installed assignment estimated"),
        bandMinUm: published(3, "um", "Published manufacturer data sheet; legacy-family specification, installed assignment estimated"),
        // Estimated intra-exposure sigma: 5 urad total axis RMS at 20 Hz over
        // .016 s times sqrt(1-sinc(pi*20*.016)^2) = 2.714 urad. The published
        // <5 urad stability scale has no stated bandwidth/RMS convention.
        jitterRmsUrad: estimated(2.714, "urad RMS/axis", "Published manufacturer data sheet; <5 µrad typical stability has unspecified bandwidth and RMS/peak convention; 2.714 µrad Gaussian fallback is estimated from 5 × sqrt(1-sinc(pi×20×0.016)^2), assuming 20 Hz motion, 0.016 s exposure and per-axis RMS"),
        // Estimated sigma range .1–.4 native pixel; 0 is the disabled control.
        diffusionSigmaPx: estimated(0.2, "native pixel", "InSb detector analogy, not MX-15 measurement; published detector studies"),
        detectorWidth: published(640, "pixel", "Published manufacturer data sheet; legacy-family specification, installed assignment estimated"),
        detectorHeight: published(512, "pixel", "Published manufacturer data sheet; legacy-family specification, installed assignment estimated"),
        pictureWidth: calculated(1280, "pixel", "Published first-person sensor integration account; calculated ordinary inset = 2 × native array; use separate 1012 mapping"),
        pictureHeight: calculated(1024, "pixel", "Published first-person sensor integration account; calculated ordinary inset = 2 × native array; use separate 1012 mapping"),
        verticalFovDeg: calculated(0.8691815266653029, "degree", "2 atan(512 × 20e-6 m / (2 × 0.675 m)) = 0.8691815266653029 deg (0.015170079437820425 rad); physical field; calibrated active field 0.8675574180516222 deg is a separate mapping"),
        focalLengthM: published(0.675, "m", "Published first-person sensor integration account; 675 readout interpreted as 0.675 m, practitioner testimony rather than metrology"),
        pixelPitchM: published(2e-05, "m", "Published manufacturer annual report and legacy company profile; legacy family; detector die/ROIC unidentified"),
        // Alternative .160 m: published MX-15D reconstruction, for a different
        // camera, not this legacy unit.
    })}),
    ATFLIR: Object.freeze({label: "ATFLIR (conditional narrow)", parameters: Object.freeze({...common,
        apertureM: estimated(0.18, "m", "0.180 m retained upper comparison choice in estimated 0.150–0.180 m exploration interval; production pupil unknown; 0.150 m literature design is not hardware metrology"),
        bandMinUm: published(3.7, "um", "Published manufacturer conference paper; extracted text says nm; µm is an explicit correction from MWIR/InSb context; nominal edges, not flat response"),
        bandMaxUm: published(5, "um", "Published manufacturer conference paper; extracted text says nm; µm is an explicit correction from MWIR/InSb context; nominal edges, not flat response"),
        detectorWidth: published(640, "pixel", "Published manufacturer conference paper"),
        detectorHeight: published(480, "pixel", "Published manufacturer conference paper"),
        pictureWidth: estimated(640, "pixel", "Reference presentation raster"),
        pictureHeight: estimated(480, "pixel", "Reference presentation raster"),
        verticalFovDeg: estimated(0.7, "degree", "NAR 1.0 nominal 0.7 deg (0.012217304763960306 rad) recalled from unverified brochure leads; estimated vertical/full-480-row assignment; NAR 2.0 is a separate electronic state"),
        pixelPitchM: estimated(2e-05, "m", "20 µm conditional baseline in estimated 20–30 µm interval; survey midpoint 25 µm is not a measured improvement"),
        focalLengthM: calculated(0.7857609165970034, "m", "480 × 20e-6 m / (2 tan(0.7 deg / 2)) = 0.7857609165970034 m; conditional 480-row axis and 20 µm pitch; no physical focal measurement"),
    })}),
    OMAHA: Object.freeze({label: "USS Omaha candidate (SAFIRE III)", parameters: Object.freeze({...common,
        apertureM: estimated(0.2, "m", "Published manufacturer data sheet; 0.200 m modeling choice; entrance pupil not specified, turret/window diameter is not pupil diameter"),
        bandMinUm: published(3, "um", "Published manufacturer data sheet; candidate identification; later airborne 512-row array does not apply"),
        bandMaxUm: published(5, "um", "Published manufacturer data sheet; candidate identification; later airborne 512-row array does not apply"),
        detectorWidth: published(640, "pixel", "Published manufacturer data sheet; candidate identification; later airborne 512-row array does not apply"),
        detectorHeight: published(480, "pixel", "Published manufacturer data sheet; candidate identification; later airborne 512-row array does not apply"),
        pictureWidth: estimated(640, "pixel", "Reference presentation raster before secondary capture"),
        pictureHeight: estimated(480, "pixel", "Reference presentation raster before secondary capture"),
        pixelPitchM: estimated(2e-05, "m", "Published manufacturer data sheet; 20 µm modeling choice; pitch not specified; no defensible narrow device-specific interval"),
        // The data sheet publishes 25–.35 degrees and 71× total magnification;
        // axis and optical/electronic allocation are unspecified. The .7 degree
        // horizontal optical branch below remains estimated, not a published field.
        verticalFovDeg: calculated(0.5250028569848855, "degree", "Published manufacturer data sheet; conditional 640×480 square samples at p=20 µm and assumed horizontal optical field 0.7 deg; f=640p/(2 tan(0.7 deg/2)); V=2 atan(480p/(2f)); advertised 25–0.35 deg has unspecified axis and optical/electronic allocation"),
        focalLengthM: calculated(1.0476812221293377, "m", "Published manufacturer data sheet; conditional 640×480 square samples at p=20 µm and assumed horizontal optical field 0.7 deg; f=640p/(2 tan(0.7 deg/2)); V=2 atan(480p/(2f)); advertised 25–0.35 deg has unspecified axis and optical/electronic allocation"),
    })}),
});

/** name is a preset identifier; returns raw parameter values in each field's stated unit. */
export function presetValues(name) {
    const preset = SENSOR_PRESETS[name];
    if (!preset) throw new RangeError(`Unknown thermal sensor preset: ${name}`);
    return Object.fromEntries(Object.entries(preset.parameters).map(([key, parameter]) => [key, parameter.value]));
}
