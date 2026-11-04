import {atArrival,nearestApproach,observerTrack} from "../src/doppler/DopplerModel";
import {newEvent,scoreCombination,SEARCH_DEFAULTS,validateSearch} from "../src/doppler/DopplerSearch";
import {validateAnalysis} from "../src/doppler/DopplerAnalysis";
import {makeDemo} from "../src/doppler/DopplerDemo";
import {thinTrace,tracedHarmonics} from "../src/doppler/DopplerTrace";

function fixture() {
    const track=observerTrack({id:"test",segments:[{t0:-200,t1:200,p0:[-18000,2000,0],
        p1:[18000,2000,0],velocity:[90,0,0],speed:90}]},[0,0,0],343);
    const trace=[[0,1],[8,1],[16,1],[32,2],[40,2],[48,2]].map(([time,harmonic])=>({time,harmonic,
        frequency:131.25*harmonic*atArrival(track,time).factor}));
    const event={...newEvent(20),start:0,end:60,frequency:130,frequencyTolerance:8,trace};
    const settings={...SEARCH_DEFAULTS,mode:"trace",recordingStart:0,timeTolerance:0,cpaTolerance:1e9};
    return {pair:[{track,cpa:nearestApproach(track)}],event,settings};
}

test("separate visible harmonic segments share one emitted frequency without filling gaps",()=>{
    const {pair,event,settings}=fixture();
    const fit=scoreCombination(pair,[event],settings);
    expect(fit.events[0].frequency).toBeCloseTo(131.25,10);
    expect(fit.events[0].rmsHz).toBeLessThan(1e-10);
    // An unrelated line cannot acquire its own convenient frequency scale.
    const wrong={...event,trace:event.trace.map(p=>({...p,frequency:p.frequency+(p.harmonic===2 ? 20 : 0)}))};
    expect(scoreCombination(pair,[wrong],settings).events[0].rmsHz).toBeGreaterThan(5);
    expect(event.trace).toHaveLength(6);
});

test("tagged brightness scores observed harmonic segments rather than silent gaps",()=>{
    const {pair,event,settings}=fixture();settings.mode="brightness";
    const spec={columns:61,bins:2001,hop:1,binHz:.25,start:0,values:new Float32Array(61*2001).fill(-20)};
    for(const p of event.trace) {
        const bin=p.frequency/spec.binHz;
        for(const y of [Math.floor(bin),Math.ceil(bin)]) spec.values[p.time*spec.bins+y]=1;
    }
    const fit=scoreCombination(pair,[event],settings,spec);
    expect(Math.abs(fit.events[0].frequency-131.25)).toBeLessThan(.15);
    expect(fit.score).toBeGreaterThan(.9);
    // Legacy untagged brightness still examines the whole event window.
    const legacy={...event,trace:event.trace.map(({harmonic,...point})=>point)};
    expect(scoreCombination(pair,[legacy],settings,spec).score).toBeLessThan(-10);
});

test("saved analyses preserve explicit harmonic assignments and legacy event-wide traces",()=>{
    const state=makeDemo();state.events[0].harmonic=2;
    state.events[0].trace[0].harmonic=1;
    const saved=validateAnalysis(JSON.parse(JSON.stringify(state)));
    expect(saved.events[0].trace[0].harmonic).toBe(1);
    expect(saved.events[0].trace[1].harmonic).toBeUndefined();
    expect(tracedHarmonics(saved.events[0])).toEqual([1,2]);
    for(const harmonic of [0,1.5,17,"2",null]) {
        state.events[0].trace[0].harmonic=harmonic;
        expect(()=>validateAnalysis(state)).toThrow(/trace points/);
    }
});

test("tagged brightness needs coverage only at measured points; legacy brightness ignores unused traces",()=>{
    const {event,settings}=fixture();settings.mode="brightness";
    event.trace=[10,20,30,40].map(time=>({time,frequency:200,harmonic:1}));
    const input={settings,events:[event],tracks:[{id:"test"}],spectrogram:{start:1,columns:59,hop:1}};
    expect(()=>validateSearch(input)).not.toThrow();
    event.trace[0].time=0;
    expect(()=>validateSearch(input)).toThrow(/coverage/);
    event.start=2;event.end=58;delete event.trace;
    expect(()=>validateSearch(input)).not.toThrow();
    event.trace=[{time:-20,frequency:200}];
    expect(()=>validateSearch(input)).not.toThrow();
});

test("coarse proposals retain interleaved harmonics and their observed endpoints",()=>{
    const event={harmonic:1,trace:[0,1,2,3,4,5].flatMap(time=>[{time,frequency:100,harmonic:1},{time,frequency:200,harmonic:2}])};
    const trace=thinTrace(event);
    for(const harmonic of [1,2]) expect(trace.filter(p=>p.harmonic===harmonic).map(p=>p.time)).toEqual([0,2,4,5]);
});
