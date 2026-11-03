import {atArrival,closestApproaches,observerTrack,prepareTrack,toECEF} from "./DopplerModel";
import {newEvent,SEARCH_DEFAULTS} from "./DopplerSearch";

// A reproducible two-flight exercise, unrelated to any actual recording.
export function makeDemo() {
    const lat=37,lon=-122,altitudeM=100,time=Date.UTC(2026,0,1)/1000;
    const tracks=[0,1].map(f=>({id:`Demo ${f+1}`,points:Array.from({length:121},(_,i)=>{
        const t=i*2-120;
        return {time:time+180+f*300+t,lat:lat+(f ? t*80/111320 : 0.004+0.000002*t),
            lon:lon+(f ? -0.006+0.000001*t*t/120 : t*90/(111320*Math.cos(lat*Math.PI/180))),altitudeM:1300+f*200+0.8*t};
    })}));
    const events=tracks.map((track,i)=>{
        const view=observerTrack(prepareTrack(track),toECEF(lat,lon,altitudeM),343);
        const cpa=closestApproaches(view)[0].arrival-time;
        const event={...newEvent(cpa),frequency:130+i*25,frequencyTolerance:2};
        event.trace=Array.from({length:31},(_,j)=>{
            const t=cpa-30+j*2;
            return {time:t,frequency:atArrival(view,time+t).factor*event.frequency};
        });
        return event;
    });
    return {version:1,settings:{...SEARCH_DEFAULTS,lat:37.002,lon:-122.003,altitudeM,radiusM:1500,spacingM:100,
        timeTolerance:1,timeStep:0.5,recordingStart:"",mode:"trace"},tracks,events};
}
