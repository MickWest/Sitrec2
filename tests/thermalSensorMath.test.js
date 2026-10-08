import * as sensor from "../tools/thermal/sensorMath.js";
import {defaultSettings, normalizeSettings} from "../tools/thermal/thermalSchema.js";
const settings = {...defaultSettings(), opticsEnabled:false, scatterFraction:0, noiseEnabled:false,
    exposureMode:"manual", adcOffsetCounts:0, systemBlurHorizontalRmsUrad:0, systemBlurVerticalRmsUrad:0,
    displayCurve:"linear", shadingK:0, fixedPatternFraction:0,
    darkElectronsPerS:0, fillFactor:1, supersample:2};
const close = (actual,expected,tolerance=1e-6) => expect(Math.abs(actual-expected)).toBeLessThanOrEqual(tolerance);
const maximumError = (actual, expected) => Math.max(...actual.map((value,pixel)=>Math.abs(value-expected[pixel])));
const opticalSensor={focalM:0.675,apertureM:0.135,pitchM:20e-6};

test("normalized diffraction, skirt, footprint, crosstalk and Gaussian kernels", () => {
    const kernels=[sensor.diffractionKernel(opticalSensor,{radiusPx:12},4e-6,2),
        sensor.scatterKernel(opticalSensor,{tis:0.1,cutoffRad:100e-6},2),
        sensor.footprintKernel(2,0.9),sensor.footprintKernel(3,0.9),sensor.crosstalkKernel(0.02),sensor.gaussianKernel(1,4)];
    for(const kernel of kernels) {
        close(sensor.sum(kernel.data),1,1e-7);
        const width=129, input=new Float32Array(width*width);input[64*width+64]=1;
        close(sensor.sum(sensor.convolve(input,width,width,kernel)),1,3e-7);
    }
});
test("finite crop loses light and periodic convolution conserves it", () => {
    const input=new Float32Array(81);input[0]=1;
    const kernel=sensor.gaussianKernel(1,2);
    expect(sensor.sum(sensor.convolve(input,9,9,kernel))).toBeLessThan(0.6);
    close(sensor.sum(sensor.convolve(input,9,9,kernel,"wrap")),1,2e-7);
});
test("FFT and direct convolution agree for a contained field", () => {
    const width=49,input=new Float32Array(width*width),random=sensor.randomSequence(123);
    for(let row=15;row<34;row++) for(let column=15;column<34;column++) input[row*width+column]=random();
    const kernel=sensor.gaussianKernel(2,5);
    close(maximumError(sensor.convolve(input,width,width,kernel),sensor.convolve(input,width,width,kernel,"wrap")),0,2e-7);
});
test("Airy modulation matches the independent circular-aperture transfer function", () => {
    const factor=3,kernel=sensor.diffractionKernel(opticalSensor,{radiusPx:40},4e-6,factor);
    let real=0,imaginary=0;
    const frequency=0.4,center=(kernel.width-1)/2;
    for(let row=0;row<kernel.height;row++) for(let column=0;column<kernel.width;column++) {
        const phase=-2*Math.PI*frequency*(column-center)/factor,weight=kernel.data[row*kernel.width+column];
        real+=weight*Math.cos(phase);imaginary+=weight*Math.sin(phase);
    }
    const normalizedFrequency=frequency*4e-6*5/20e-6;
    const expected=2/Math.PI*(Math.acos(normalizedFrequency)-normalizedFrequency*Math.sqrt(1-normalizedFrequency**2));
    close(Math.hypot(real,imaginary),expected,0.015);
});
test("annular pupil and phase defocus keep unit flux; pupil resolution converges", () => {
    const clear=sensor.diffractionKernel(opticalSensor,{radiusPx:12},4e-6,3);
    const annular=sensor.diffractionKernel(opticalSensor,{radiusPx:12,obstruction:0.35},4e-6,3);
    expect(annular.data[(annular.data.length-1)/2]).toBeLessThan(clear.data[(clear.data.length-1)/2]);
    const coarse=sensor.diffractionKernel(opticalSensor,{radiusPx:12,defocusM:100e-6,pupilGrid:256},4e-6,3);
    const fine=sensor.diffractionKernel(opticalSensor,{radiusPx:12,defocusM:100e-6,pupilGrid:512},4e-6,3);
    close(sensor.sum(coarse.data),1,1e-7);close(sensor.sum(fine.data),1,1e-7);
    expect(sensor.sum(coarse.data.map((value,pixel)=>Math.abs(value-fine.data[pixel])))).toBeLessThan(0.04);
});
test("all effects off is a bit-exact independent Float32 image", () => {
    const image=Float32Array.from({length:63},(_,pixel)=>(pixel-8)/13);
    const result=sensor.runSensorChain(image,9,7,settings,{effectsOff:true});
    expect(result.image).toEqual(image);expect(result.image).not.toBe(image);
});
test("fine-to-native averaging conserves integrated radiance for even and odd factors", () => {
    for (const factor of [2,3,4,8]) {
        const width=3*factor,image=Float32Array.from({length:width*width},(_,pixel)=>pixel+1);
        close(sensor.sum(sensor.sampleDetector(image,width,width,factor))*factor*factor,sensor.sum(image),0.02);
        for (const value of sensor.sampleDetector(new Float32Array(width*width).fill(2),width,width,factor,0.5)) close(value,2);
    }
});
test("subpixel shift changes peak but conserves total full-fill flux", () => {
    const first=new Float32Array(28*28),second=first.slice();first[13*28+13]=1;second[13*28+14]=1;
    const kernel=sensor.gaussianKernel(0.8,4);
    const sample=image=>sensor.sampleDetector(sensor.convolve(image,28,28,kernel),28,28,2);
    close(sensor.sum(sample(first)),sensor.sum(sample(second)),1e-7);
    expect(maximumError(sample(first),sample(second))).toBeGreaterThan(0.01);
});
test("photon conversion equals independent aperture-area times pixel-solid-angle etendue", () => {
    const factor=sensor.electronsPerRadiance(settings);
    const independent=1e20*Math.PI*(settings.apertureM/2)**2*(settings.pixelPitchM/settings.focalLengthM)**2*
        settings.integrationTimeS*settings.opticalTransmission*settings.quantumEfficiency*settings.fillFactor;
    close(factor/independent,1,1e-12);
    close(sensor.electronsPerRadiance({...settings,fillFactor:0.9})/factor,0.9,1e-12);
    const input=new Float32Array([-1,0,2]);
    expect(sensor.exposureToElectrons(input,10,3)).toEqual(new Float32Array([3,3,23]));
});
test("shot noise has Poisson mean/variance in low and high count regimes", () => {
    for(const mean of [4,1000]) {
        const noise=sensor.shotNoise(new Float32Array(30000).fill(mean),19,42);
        const measured=sensor.sum(noise)/noise.length;
        const variance=sensor.sum(noise.map(value=>(value-measured)**2))/noise.length;
        close(measured,mean,mean===4?0.04:1);close(variance,mean,mean*0.04);
        expect(noise).toEqual(sensor.shotNoise(new Float32Array(30000).fill(mean),19,42));
        expect(noise).not.toEqual(sensor.shotNoise(new Float32Array(30000).fill(mean),20,42));
    }
});
test("read noise has the specified RMS and does not depend on mean signal", () => {
    const input=new Float32Array(30000),noise=sensor.readNoise(input,500,7,42);
    close(Math.sqrt(sensor.sum(noise.map(value=>value*value))/noise.length),500,10);
    expect(noise).toEqual(sensor.readNoise(input,500,7,42));
    const bright = sensor.readNoise(new Float32Array(30000).fill(3.5e6),500,7,42);
    // Float32 spacing at 3.5e6 electrons is .25 electron.
    close(maximumError(bright.map(value => value - 3.5e6), noise), 0, .125);
    close(Math.sqrt(sensor.sum(bright.map(value => (value - 3.5e6) ** 2)) / bright.length), 500, 10);
});
test("well clips before mean dark subtraction and read noise", () => {
    expect(sensor.wellLimit(new Float32Array([-10,50,10000]),100)).toEqual(new Float32Array([0,50,100]));
    const configuration={...settings,wellElectrons:1000,integrationTimeS:0.01,darkElectronsPerS:10000};
    const counts=sensor.detectorCounts(new Float32Array([0,1e6]),configuration);
    expect(counts).toEqual(new Float32Array([0,Math.round(0.9*16383)]));
    const noisy={...configuration,noiseEnabled:true,shotNoiseEnabled:false,readNoiseElectrons:30};
    const reference=sensor.quantizeADC(sensor.readNoise(new Float32Array([0,900]),30,8,noisy.noiseSeed),1000);
    expect(sensor.detectorCounts(new Float32Array([0,1e6]),noisy,8)).toEqual(reference);
});
test("ADC end points, half-LSB rounding and full 8-bit physical ramp", () => {
    expect(sensor.quantizeADC(new Float32Array([-1,0,50,100,200]),100)).toEqual(new Float32Array([0,0,8192,16383,16383]));
    const factor=sensor.electronsPerRadiance(settings);
    const radiance=Float32Array.from({length:256},(_,pixel)=>pixel/255*settings.wellElectrons/factor);
    const counts=sensor.detectorCounts(radiance,settings);
    expect(Math.min(...counts)).toBe(0);expect(Math.max(...counts)).toBe(16383);
    expect(sensor.processCounts(counts,16,16,settings).codes).toEqual(Float32Array.from({length:256},(_,pixel)=>pixel));
});
test("manual gain and level define a fixed count window", () => {
    const input=new Float32Array([0,100,200,16383]);
    expect(sensor.processCounts(input,4,1,{...settings,gainMode:"manual",fixedGain:16383/200,fixedLevel:100}).drive).toEqual(new Float32Array([0,0.5,1,1]));
});
test("automatic percentiles use an explicit exponential time constant", () => {
    const input=Float32Array.from({length:101},(_,pixel)=>pixel);
    const initial=sensor.automaticWindow(input,{lowPercentile:0.1,highPercentile:0.9,minimumSpan:1});
    expect(initial).toEqual({low:10,high:90});
    const next=sensor.automaticWindow(input.map(value=>value+100),{lowPercentile:0.1,highPercentile:0.9,
        minimumSpan:1,timeConstantS:2,deltaTimeS:2},initial);
    close(next.low,10+100*(1-Math.exp(-1)),1e-12);
    expect(sensor.automaticWindow(input,{deltaTimeS:0},initial)).toEqual(initial);
    // A uniform frame widens equally about its level, like a camera's maximum gain.
    expect(sensor.automaticWindow(new Float32Array([100,100]),{minimumSpan:32})).toEqual({low:84,high:116});
});
test("plateau equalization has the known capped histogram CDF", () => {
    // Histogram [6,2,1,1], cap=2.5, clipped [2.5,2,1,1]. CDF-min -> [0,.5,.75,1].
    const drive=new Float32Array([0,0,0,0,0,0,1/3,1/3,2/3,1]);
    const result=sensor.plateauEqualization(drive,1,4);
    expect(result).toEqual(new Float32Array([0,0,0,0,0,0,0.5,0.5,0.75,1]));
    expect(sensor.plateauEqualization(new Float32Array(10).fill(0.4))).toEqual(new Float32Array(10).fill(0.4));
});
test("local enhancement makes opposite-sign rings around hot and cold clipped cores", () => {
    const width=41,image=new Float32Array(width*width).fill(0.4),center=20*width+20,ring=center+4;
    image[center]=1;
    const hot=sensor.localEnhancement(image,width,width,1,3);
    expect(hot[ring]).toBeLessThan(0.4);expect(hot[center]).toBeGreaterThan(1);
    image[center]=0;
    const cold=sensor.localEnhancement(image,width,width,1,3);
    expect(cold[ring]).toBeGreaterThan(0.4);expect(cold[center]).toBeLessThan(0);
    expect(sensor.localEnhancement(image,width,width,0,3)).toEqual(image);
    close(maximumError(sensor.localMean(new Float32Array(81).fill(0.4),9,9,3),new Float32Array(81).fill(0.4)),0,1e-7);
});
test("response, display end points and polarity are exact inverses including half ties", () => {
    const input=new Float32Array([-1,0,0.5,1,2]);
    expect(sensor.quantize8Bit(input)).toEqual(new Float32Array([0,0,128,255,255]));
    expect(sensor.responseCurve(new Float32Array([0,0.25,1]),2)).toEqual(new Float32Array([0,0.5,1]));
    for(const gamma of [0.7,1,2.2]) {
        const white=sensor.displayCodes(input,{responseGamma:gamma,polarity:"whiteHot"});
        const black=sensor.displayCodes(input,{responseGamma:gamma,polarity:"blackHot"});
        for(let pixel=0;pixel<input.length;pixel++) expect(white[pixel]+black[pixel]).toBe(255);
    }
});
test("fixed radiometric scale is independent of scene statistics and follows exposure", () => {
    const fixed={...settings,gainMode:"fixedRadiometric",radiometricLow:0,radiometricHigh:3};
    const first=sensor.processCounts(sensor.detectorCounts(new Float32Array([1,1,1,1]),fixed),2,2,fixed).codes;
    const other=sensor.processCounts(sensor.detectorCounts(new Float32Array([1,2,0,3]),fixed),2,2,fixed).codes;
    expect(first[0]).toBe(other[0]);expect(first[0]).toBe(85);
    const longer={...fixed,integrationTimeS:settings.integrationTimeS*2};
    expect(sensor.processCounts(sensor.detectorCounts(new Float32Array([1]),longer),1,1,longer).codes[0]).toBe(first[0]);
});
test("all gain modes are monotonic before local enhancement", () => {
    const counts=Float32Array.from({length:100},(_,pixel)=>pixel<90?pixel:500+pixel);
    for(const gainMode of ["manual","automatic","plateau","fixedRadiometric"]) {
        const output=sensor.processCounts(counts,10,10,{...settings,gainMode}).codes;
        for(let pixel=1;pixel<output.length;pixel++) expect(output[pixel]).toBeGreaterThanOrEqual(output[pixel-1]);
    }
});
test("polychromatic core and scatter retain unit energy", () => {
    const config=normalizeSettings({...settings,opticsEnabled:true,opticsRadiusPx:4,psfTemperatureK:600});
    const kernels=sensor.opticalKernels(config);
    close(sensor.sum(kernels.core.data),1,1e-7);close(sensor.sum(kernels.scatter.data),1,1e-7);
});

test("optics keeps both kernel supports until the final finite crop", () => {
    const kernel={width:3,height:1,data:new Float32Array([0.25,0.5,0.25])};
    const combined=sensor.combineKernels(kernel,kernel);
    expect(combined.data).toEqual(new Float32Array([0.0625,0.25,0.375,0.25,0.0625]));
    close(sensor.sum(combined.data),1);
    // Two crops would give 0.3125 at the first pixel, losing light that returns from outside.
    const result=sensor.applyOptics(new Float32Array([1,0,0]),3,1,{core:kernel,scatter:kernel});
    expect(result).toEqual(new Float32Array([0.375,0.25,0.0625]));
});
