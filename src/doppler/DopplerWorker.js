import {searchLocations} from "./DopplerSearch";
import {makeSpectrogram} from "./DopplerSpectrogram";
import {makeDetailSpectrogram} from "./DopplerSpectrogramDetail";

let audio=null,detailGeneration=0;

self.onmessage=async ({data})=>{
    if(data.type==="spectrogram-detail-cancel") {detailGeneration++;return;}
    try {
        const progress=value=>self.postMessage({type:"progress",value});
        if(data.type==="spectrogram") {
            const value=await makeSpectrogram(data.samples,data.sampleRate,data.options,progress);
            audio={samples:data.samples,sampleRate:data.sampleRate,options:data.options,frequencyBaseline:value.frequencyBaseline};
            self.postMessage({type:"result",value},[value.values.buffer]);
        } else if(data.type==="spectrogram-detail") {
            if(!audio) throw new Error("Reload audio to compute visible-window spectrogram detail.");
            const generation=++detailGeneration,cancelled=()=>generation!==detailGeneration;
            const value=await makeDetailSpectrogram(audio.samples,audio.sampleRate,audio.options,data.view,audio.frequencyBaseline,cancelled);
            if(cancelled()) return;
            delete value.frequencyBaseline;
            self.postMessage({type:"spectrogram-detail",requestId:data.requestId,value},[value.values.buffer]);
        } else if(data.type==="search") {
            self.postMessage({type:"result",value:await searchLocations(data.input,{progress})});
        } else if(data.type==="reference-check") {
            const {diagnoseDopplerReference}=await import(/* webpackChunkName: "doppler-diagnostics" */ "./DopplerDiagnostics");
            self.postMessage({type:"result",value:await diagnoseDopplerReference(data.input)});
        } else if(data.type==="archive-search") {
            const {searchFlightArchive}=await import(/* webpackChunkName: "doppler-archive" */ "./DopplerArchiveSearch");
            self.postMessage({type:"result",value:await searchFlightArchive(data.input,progress)});
        } else if(data.type==="archive-index") {
            const {indexFlightArchive}=await import(/* webpackChunkName: "doppler-archive" */ "./DopplerArchiveSearch");
            self.postMessage({type:"result",value:await indexFlightArchive(data.input,progress)});
        } else throw new Error("Unknown Doppler operation.");
    } catch(error) {
        if(data.type==="spectrogram-detail") {
            if(error.message!=="Spectrogram detail cancelled.") self.postMessage({type:"spectrogram-detail-error",requestId:data.requestId,message:error.message});
        } else self.postMessage({type:"error",message:error.message});
    }
};
