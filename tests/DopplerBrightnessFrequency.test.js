import {atArrival,nearestApproach,observerTrack} from "../src/doppler/DopplerModel";
import {newEvent,sampleSpectrogram,scoreCombination,SEARCH_DEFAULTS} from "../src/doppler/DopplerSearch";

function fixture({moving=false,harmonic=1,frequency=131.25}={}) {
    const velocity=moving ? [90,0,0] : [0,0,0];
    const track=observerTrack({id:"synthetic",segments:[{t0:-200,t1:200,p0:moving ? [-18000,2000,0] : [0,2000,0],
        p1:moving ? [18000,2000,0] : [0,2000,0],velocity,speed:moving ? 90 : 0}]},[0,0,0],343);
    const spec={columns:101,bins:2001,hop:1,binHz:0.25,start:-50,values:new Float32Array(101*2001)};
    for(let column=0;column<spec.columns;column++) {
        const observed=frequency*atArrival(track,spec.start+column).factor*harmonic;
        for(let bin=Math.max(0,Math.floor(observed/spec.binHz)-1);bin<=Math.min(spec.bins-1,Math.ceil(observed/spec.binHz)+1);bin++) {
            spec.values[column*spec.bins+bin]=Math.max(0,1-Math.abs(bin*spec.binHz-observed)/spec.binHz);
        }
    }
    const event={...newEvent(0),start:-30,end:30,frequency:130,frequencyTolerance:8,harmonic};
    const settings={...SEARCH_DEFAULTS,mode:"brightness",recordingStart:0,timeTolerance:0,cpaTolerance:1e9};
    return {pair:[{track,cpa:nearestApproach(track)}],event,settings,spec};
}

function legacyBrightness({pair,event,settings,spec}) {
    const countSamples=Math.min(200,Math.max(8,Math.ceil((event.end-event.start)/spec.hop)));
    let best=-Infinity;
    for(let j=0;j<settings.frequencySteps;j++) {
        const frequency=event.frequency-event.frequencyTolerance+2*event.frequencyTolerance*j/(settings.frequencySteps-1);
        let sum=0;
        for(let i=0;i<countSamples;i++) {
            const time=event.start+(event.end-event.start)*i/(countSamples-1);
            sum+=sampleSpectrogram(spec,time,frequency*atArrival(pair[0].track,time).factor*event.harmonic);
        }
        best=Math.max(best,sum/countSamples);
    }
    return best;
}

test("brightness finds an isolated one-bin ridge between the old frequency trials",()=>{
    const input=fixture(),fit=scoreCombination(input.pair,[input.event],input.settings,input.spec);
    expect(legacyBrightness(input)).toBe(0);
    expect(fit.events[0].frequency).toBe(131.25);
    expect(fit.score).toBeCloseTo(1,12);
});

test("brightness frequency density includes Doppler scale and harmonic",()=>{
    const input=fixture({moving:true,harmonic:2,frequency:131.3125});
    const fit=scoreCombination(input.pair,[input.event],input.settings,input.spec);
    const maxScale=Math.max(...[-30,30].map(t=>atArrival(input.pair[0].track,t).factor*2));
    expect(Math.abs(fit.events[0].frequency-131.3125)*maxScale).toBeLessThan(input.spec.binHz/2);
    expect(fit.score).toBeGreaterThan(3*legacyBrightness(input));
});

test("zero frequency tolerance preserves a fixed frequency and unavailable bands are rejected",()=>{
    const input=fixture(),event={...input.event,frequency:131.25,frequencyTolerance:0};
    const fit=scoreCombination(input.pair,[event],input.settings,input.spec);
    expect(fit.events[0].frequency).toBe(131.25);expect(fit.score).toBeCloseTo(1,12);
    expect(scoreCombination(input.pair,[{...event,frequency:600}],input.settings,input.spec)).toBeNull();
});
