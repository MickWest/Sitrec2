import {searchLocations} from "./DopplerSearch";
import {makeSpectrogram} from "./DopplerSpectrogram";

self.onmessage=async ({data})=>{
    try {
        const progress=value=>self.postMessage({type:"progress",value});
        if(data.type==="spectrogram") {
            const value=await makeSpectrogram(data.samples,data.sampleRate,data.options,progress);
            self.postMessage({type:"result",value},[value.values.buffer]);
        } else if(data.type==="search") {
            self.postMessage({type:"result",value:await searchLocations(data.input,{progress})});
        } else if(data.type==="archive-search") {
            const {searchFlightArchive}=await import(/* webpackChunkName: "doppler-archive" */ "./DopplerArchiveSearch");
            self.postMessage({type:"result",value:await searchFlightArchive(data.input,progress)});
        } else if(data.type==="archive-index") {
            const {indexFlightArchive}=await import(/* webpackChunkName: "doppler-archive" */ "./DopplerArchiveSearch");
            self.postMessage({type:"result",value:await indexFlightArchive(data.input,progress)});
        } else throw new Error("Unknown Doppler operation.");
    } catch(error) {self.postMessage({type:"error",message:error.message});}
};
