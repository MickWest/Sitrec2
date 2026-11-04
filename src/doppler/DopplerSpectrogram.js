import {fftInPlace} from "../audio/AudioFFT";

export async function makeSpectrogram(samples,sampleRate,{windowSeconds=4,hop=1,maxHz=500,displayOnly=false,frequencyBaseline}={},progress=()=>{}) {
    if(![sampleRate,windowSeconds,hop,maxHz].every(Number.isFinite) || sampleRate<1000 || windowSeconds<0.25 || windowSeconds>16 || hop<(displayOnly ? 1/sampleRate : 0.1) || maxHz<=0 || maxHz>=sampleRate/2) throw new Error("Invalid spectrogram sample rate, window, hop or frequency limit.");
    const n=2**Math.ceil(Math.log2(windowSeconds*sampleRate));
    if(n>131072 || samples.length<n) throw new Error("Audio is shorter than the analysis window, or the FFT is too large.");
    const step=Math.max(1,Math.round(hop*sampleRate));
    const columns=1+Math.floor((samples.length-n)/step), binHz=sampleRate/n, bins=Math.min(n/2,1+Math.floor(maxHz/binHz));
    if(columns*bins>8000000) throw new Error("Spectrogram exceeds 8 million cells. Increase the hop or reduce the window or maximum frequency.");
    if(frequencyBaseline && (!displayOnly || frequencyBaseline.length!==bins || !frequencyBaseline.every(Number.isFinite))) throw new Error("The detail spectrogram needs the original frequency baseline and FFT bins.");
    const values=new Float32Array(columns*bins), re=new Float64Array(n), im=new Float64Array(n);
    const window=Float64Array.from({length:n},(_,i)=>0.5-0.5*Math.cos(2*Math.PI*i/(n-1)));
    for(let x=0;x<columns;x++) {
        for(let i=0;i<n;i++) re[i]=samples[x*step+i]*window[i];
        im.fill(0);fftInPlace(re,im);
        for(let y=0;y<bins;y++) values[x*bins+y]=10*Math.log10(1e-20+re[y]**2+im[y]**2);
        if(x%32===0) {progress({done:x+1,total:columns});await new Promise(resolve=>setTimeout(resolve,0));}
    }
    // Remove persistent tones and per-time broadband level. Transient ridges
    // then contribute contrast rather than rewarding louder recordings.
    const baseline=frequencyBaseline ?? new Float64Array(bins);
    for(let y=0;y<bins;y++) {
        let mean=frequencyBaseline?.[y] ?? 0;
        if(!frequencyBaseline) {for(let x=0;x<columns;x++) mean+=values[x*bins+y];mean/=columns;baseline[y]=mean;}
        for(let x=0;x<columns;x++) values[x*bins+y]-=mean;
    }
    for(let x=0;x<columns;x++) {
        let mean=0,variance=0;
        for(let y=0;y<bins;y++) mean+=values[x*bins+y];
        mean/=bins;
        for(let y=0;y<bins;y++) variance+=(values[x*bins+y]-mean)**2;
        const sigma=Math.max(1,Math.sqrt(variance/bins));
        for(let y=0;y<bins;y++) values[x*bins+y]=(values[x*bins+y]-mean)/sigma;
    }
    return {columns,bins,binHz,hop:step/sampleRate,start:n/(2*sampleRate),duration:samples.length/sampleRate,values,frequencyBaseline:baseline};
}
