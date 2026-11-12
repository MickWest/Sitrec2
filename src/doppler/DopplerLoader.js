// Only this small entry point is part of Sitrec startup. The UI, acoustic model,
// FFT and search worker are fetched when the user opens the addon.
import {canUseDopplerGeolocation} from "./DopplerAccess";
import {par} from "../par";

let instance=null, pending=null, generation=0;

export async function openDopplerGeolocation() {
    if(!canUseDopplerGeolocation()) return null;
    par.paused=true;
    if(instance) {instance.show();return instance;}
    if(!pending) {
        const token=generation;
        const operation=import(/* webpackChunkName: "doppler-geolocation" */ "./DopplerTool")
            .then(({DopplerTool})=>{
                if(token!==generation || !canUseDopplerGeolocation()) return null;
                instance=new DopplerTool();return instance;
            }).finally(()=>{if(pending===operation) pending=null;});
        pending=operation;
    }
    const tool=await pending;
    tool?.show();return tool;
}

export function addDopplerGeolocationMenu(folder) {
    if(!canUseDopplerGeolocation()) return;
    folder.add({open:()=>openDopplerGeolocation().catch(error=>{
        console.error("Could not open Doppler geolocation",error);
        window.alert(`Could not open Doppler geolocation: ${error.message}`);
    })},"open").name("Doppler Geolocation…").tooltip("Locate a recording by matching aircraft sound to flight tracks.").perm();
}

export function disposeDopplerGeolocation() {
    generation++;pending=null;
    instance?.dispose();instance=null;
}
