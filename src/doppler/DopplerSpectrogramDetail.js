import {makeSpectrogram} from "./DopplerSpectrogram";

// Detail is a display product. Scoring keeps the original whole-record grid.
// FFT windows overlap more densely; their length and frequency precision do not change.
export function detailSpectrogramPlan(sampleCount,sampleRate,options,{start,end,columns=925}) {
    if(![sampleCount,sampleRate,start,end,columns,options.windowSeconds,options.maxHz].every(Number.isFinite) ||
        sampleCount<=0 || sampleRate<1000 || end<=start || columns<2) throw new Error("Choose a valid visible audio window for spectrogram detail.");
    const n=2**Math.ceil(Math.log2(options.windowSeconds*sampleRate)),bins=1+Math.floor(options.maxHz/(sampleRate/n));
    const from=Math.max(0,start),to=Math.min(sampleCount/sampleRate,end);
    if(from>=to || n>sampleCount) throw new Error("The visible window is outside the loaded audio.");
    const target=Math.max(2,Math.min(Math.ceil(columns),Math.floor(8000000/bins)-4));
    const step=Math.max(1,Math.round((to-from)*sampleRate/(target-1)));
    return {first:Math.max(0,Math.floor(from*sampleRate-n/2)),last:Math.min(sampleCount,Math.ceil(to*sampleRate+n/2)+step),
        hop:step/sampleRate,targetColumns:target};
}

export async function makeDetailSpectrogram(samples,sampleRate,options,view,frequencyBaseline,cancelled=()=>false) {
    const check=()=>{if(cancelled()) throw new Error("Spectrogram detail cancelled.");};
    check();
    if(!frequencyBaseline) throw new Error("Reload audio to restore the original spectrogram baseline.");
    const plan=detailSpectrogramPlan(samples.length,sampleRate,options,view);
    const value=await makeSpectrogram(samples.slice(plan.first,plan.last),sampleRate,
        {...options,hop:plan.hop,displayOnly:true,frequencyBaseline},check);
    check();
    value.start+=plan.first/sampleRate;value.duration=samples.length/sampleRate;
    return value;
}
