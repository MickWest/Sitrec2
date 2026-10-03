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
// Measured from the IB6830 video: target-independent temporal noise and fixed-pattern
// gain. Uniform drive nodes u=i/256; warm-increasing response A=(255-T)/255.
// Calculated storage conversion clips the measured table's terminal -1 code to 0.
// U-depth uncertainty is ±20% in ln(gain); algorithm unidentified.
export const IB6830_DISPLAY_CURVE = Object.freeze([
    0, 0.006529677904997662, 0.01305935580999521, 0.01958903371499287, 0.02611871161999054, 0.03264838952498809,
    0.03917806742998575, 0.0457077453349833, 0.05223742323998096, 0.05876569766790712, 0.06528973110914113, 0.07180114057068014,
    0.07824318750101722, 0.08460005854016764, 0.09082215838522228, 0.09685067589759042, 0.1027033379154969, 0.1083337127459291,
    0.113772621650626, 0.1189882687316367, 0.1239993024659607, 0.1288175070203772, 0.1334510661590291, 0.1379342102536278,
    0.1422921838425148, 0.1465309599006124, 0.1506540024050925, 0.1546635365220466, 0.158565470577117, 0.1623654785605465,
    0.1660793868313087, 0.1697266813168898, 0.1733100030112611, 0.1768319159260101, 0.1802930007325677, 0.1837253823689444,
    0.1871326430923647, 0.1905152475109939, 0.1938736541307438, 0.1971843266333531, 0.2004170492444557, 0.2035664627205171,
    0.2066331992251017, 0.2096348015649588, 0.2125867684406374, 0.21550347998314, 0.2183749382461965, 0.221216298652787,
    0.2240288453113073, 0.22680310406517, 0.2295196661231386, 0.2321956910281984, 0.2348214403009668, 0.2373887686920436,
    0.2399235294751412, 0.2424087191618795, 0.2448825738427178, 0.247349837569254, 0.2498030588014867, 0.2522480472246111,
    0.2546854387726908, 0.2571084999119002, 0.259517871974782, 0.2618974110106748, 0.2642503034015496, 0.2665884502326526,
    0.2688872854574335, 0.2711743835233373, 0.2734318934787226, 0.2756806911468113, 0.2779215275828392, 0.2801495792602834,
    0.2823737107826584, 0.2845815687123198, 0.2867856235686673, 0.2889771746989542, 0.2911677601700529, 0.2933571354949142,
    0.2955450922220158, 0.2977322939016243, 0.2999176288106427, 0.3021025181476688, 0.304285379008714, 0.3064571462068773,
    0.30859867499286, 0.310722475444764, 0.3128234547710399, 0.3149017323116887, 0.3169629299749334, 0.3189980530895759,
    0.321020222348374, 0.3230639527948796, 0.3251157064147725, 0.3271919984269471, 0.3292737692275011, 0.3313839774848941,
    0.3334985874267236, 0.33564171646856, 0.337773898034487, 0.3398727547126474, 0.3419551855190576, 0.3440106844038487,
    0.3460461835473028, 0.3480592203160072, 0.3500505116512185, 0.3520219634783829, 0.3540073909173622, 0.3560050271472807,
    0.3580178035286943, 0.3600419719370205, 0.3620831652931606, 0.3641342182746301, 0.3662049201840299, 0.3682832148138099,
    0.3703524013658195, 0.3724197798301302, 0.3744769782928655, 0.3765331674976308, 0.3785788853401065, 0.3806233822669076,
    0.3826583550522813, 0.3846981052922099, 0.3867586890625208, 0.3888266224495862, 0.3909131395298079, 0.3930102635238593,
    0.3951230402955604, 0.3972503832510488, 0.3993897502034465, 0.4015477644974011, 0.4037132206909824, 0.4059025435098216,
    0.4080974712947044, 0.4103160643129861, 0.4125440467672539, 0.414789695176046, 0.4170330642475201, 0.4192749184916426,
    0.4215135474787698, 0.4237512385440604, 0.4259855236794547, 0.4282185098307217, 0.4304490200004137, 0.4327026317356913,
    0.4349725673224636, 0.4372769416231401, 0.4395935626440876, 0.4419444519761734, 0.4443158110824858, 0.446708253595403,
    0.4490987346872592, 0.4514883905698858, 0.4538762389339489, 0.4562627788404426, 0.4586483334394001, 0.4610317647697428,
    0.4634263689610982, 0.4658499779490664, 0.4683007902817927, 0.4707684279081053, 0.473274789394234, 0.47580267334807,
    0.4783514647025953, 0.4809212093917302, 0.483501296290601, 0.4860935342508963, 0.4887062365173792, 0.4913300174325091,
    0.4939664425878541, 0.4966293234958313, 0.4993071695017718, 0.5020004418553038, 0.5047219625561509, 0.5074601018525703,
    0.5102164640869202, 0.513006659352534, 0.5158267547579792, 0.5186718082521653, 0.5215431378306153, 0.5244555471011655,
    0.5273899467447146, 0.5303469015139697, 0.5333271329782379, 0.5363416037342814, 0.5393803369800352, 0.5424696533110752,
    0.5456329759723513, 0.5488803416492514, 0.552227089252129, 0.5556626119913426, 0.5591828334130025, 0.5627893993773848,
    0.5664873420480833, 0.5702819045044148, 0.5741734326605147, 0.5781596183591633, 0.5822450549414776, 0.5864345024939159,
    0.5907282554358367, 0.5951268046057444, 0.5996346327447637, 0.6042661273623264, 0.6090655446425073, 0.614033451843326,
    0.6191789239673515, 0.6244971701892746, 0.6299737459709235, 0.6356152267800622, 0.6415339576882232, 0.6477348729249831,
    0.6542869366863255, 0.6612703038148072, 0.6686895093315272, 0.6763826275465824, 0.6843243920407497, 0.6924452166198385,
    0.7007464649251286, 0.7092792650628355, 0.7180661434441975, 0.7271227165741513, 0.736463814677345, 0.7461210693111331,
    0.7559827286469371, 0.7660100948011027, 0.7761860938186039, 0.7861540831558815, 0.7958102486023179, 0.8053571508143886,
    0.8147868764242804, 0.8240523893385683, 0.8330734876281726, 0.8418478851250087, 0.850413956494964, 0.8587304403171392,
    0.8666365983079131, 0.874170829945295, 0.881388505307138, 0.8883267741122833, 0.895045224817134, 0.9015573385102055,
    0.9078657243687843, 0.9140031631125883, 0.9199977234802458, 0.9259922838479033, 0.9319868442155609, 0.9379814045832183,
    0.9439759649508759, 0.9499705253185332, 0.9559650856861908, 0.9619596460538483, 0.9679542064215058, 0.9739487667891633,
    0.979943327156821, 0.9859378875244784, 0.991932447892136, 0.9979270082597934, 1,
]);
// Measured recording profile, not a sensor default: white=1.05*(255-black)+55.
// Gain uncertainty ±0.01; offset uncertainty ±1 code. Operator setting unresolved.
export const POLARITY_PROFILES = Object.freeze({
    IB6830: Object.freeze({polarityAffine: Object.freeze({gain: 1.05, offset: 55}),
        status: "measured", source: "Measured from the IB6830 video; recording-specific output affine, possibly an operator setting"}),
});
const mxBlurBasis = "measured from the IB6830 video at both lens steps (seven lobe-shape measures; 34 ± 3 µrad under a linear display law, about 40 under the measured curve); horizontal bound ≤ 8 µrad; angle-fixed; acts before the detector noise; origin unresolved (optical anisotropy leading, fast elevation vibration still possible; sensor and readout effects ruled out)";
const mxVerticalBlur = Object.freeze({...value(40, "urad RMS", "measured", mxBlurBasis),
    statusDetail: "Measured residual; approximately 40 µrad is the estimated conversion to the measured display curve"});
const mxHorizontalBlur = Object.freeze({...value(0, "urad RMS", "measured", mxBlurBasis),
    statusDetail: "Nominal zero within the measured horizontal upper bound of 8 µrad"});
const noSystemBlur = estimated(0, "urad RMS", "No measured residual system blur assigned to this sensor or step");
const mxSteps = Object.freeze(Object.fromEntries([27, 135, 675, 1012].map(mm => [String(mm), Object.freeze({
    focalLengthM: published(mm / 1000, "m", mxManual),
    windowWidth: calculated(mm === 1012 ? 480 : 640, "pixel", `${mxVideo}; active width / measured 2× enlargement`),
    windowHeight: calculated(mm === 1012 ? 384 : 512, "pixel", `${mxVideo}; active height / measured 2× enlargement`),
    systemBlurHorizontalRmsUrad: mm >= 675 ? mxHorizontalBlur : noSystemBlur,
    systemBlurVerticalRmsUrad: mm >= 675 ? mxVerticalBlur : noSystemBlur,
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
    systemBlurHorizontalRmsUrad: noSystemBlur,
    systemBlurVerticalRmsUrad: noSystemBlur,
    displayCurve: calculated("linear", "1", "Identity lookup response; no measured display curve assigned"),
    polarityAffineGain: calculated(1, "1", "Identity output gain; recording-specific affine is opt-in"),
    polarityAffineOffset: calculated(0, "code", "Zero output offset; default white/black codes sum to 255"),
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
    MX15: Object.freeze({label: "MX-15 class (stepped optics)", displayCurveLUT: IB6830_DISPLAY_CURVE, focalSteps: mxSteps, pupilReferenceFocalM: mxSteps["675"].focalLengthM.value, parameters: Object.freeze({...common,
        focalStep: published("675", "1", mxManual),
        systemBlurHorizontalRmsUrad: mxHorizontalBlur,
        systemBlurVerticalRmsUrad: mxVerticalBlur,
        displayCurve: Object.freeze({...value("measured", "1", "measured",
            "measured from the IB6830 video (target-independent noise and fixed-pattern gain); algorithm unidentified"),
            uncertainty: "U depth ±20% in ln(gain); fixed, scene-independent curve"}),
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
