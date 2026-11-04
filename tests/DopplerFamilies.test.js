import {atArrival,nearestApproach,observerTrack} from "../src/doppler/DopplerModel";
import {newEvent,scoreCombination,SEARCH_DEFAULTS,validateSearch} from "../src/doppler/DopplerSearch";
import {validateAnalysis} from "../src/doppler/DopplerAnalysis";
import {diagnoseDopplerReference} from "../src/doppler/DopplerDiagnostics";
import {makeDemo} from "../src/doppler/DopplerDemo";
import {familyFrequency,thinTrace,tracedFamilies,tracedHarmonics} from "../src/doppler/DopplerTrace";
import {addHarmonicTracePoint,spectrumHarmonicCounts} from "../src/doppler/DopplerSpectrumLayout";

// One source with two tone families: a rotor family at 112 Hz and an engine
// family at 88 Hz, both Doppler-shifted by the same flight geometry.
function fixture() {
    const track=observerTrack({id:"test",segments:[{t0:-200,t1:200,p0:[-18000,2000,0],
        p1:[18000,2000,0],velocity:[90,0,0],speed:90}]},[0,0,0],343);
    const point=(time,harmonic,family,hz)=>({time,harmonic,family,frequency:hz*harmonic*atArrival(track,time).factor});
    const trace=[0,10,20,30,40,50].flatMap(time=>[point(time,1,0,112),point(time,2,0,112),point(time,1,1,88),point(time,3,1,88)]);
    const event={...newEvent(25),start:0,end:60,frequency:100,frequencyTolerance:60,trace};
    const settings={...SEARCH_DEFAULTS,mode:"trace",recordingStart:0,timeTolerance:0,cpaTolerance:1e9};
    return {track,pair:[{track,cpa:nearestApproach(track)}],event,settings};
}

test("each tone family fits its own emitted fundamental on shared geometry",()=>{
    const {pair,event,settings}=fixture();
    const fit=scoreCombination(pair,[event],settings);
    expect(fit.events[0].frequency).toBeCloseTo(112,9);
    expect(fit.events[0].families).toEqual([{family:0,frequency:expect.closeTo(112,9)},{family:1,frequency:expect.closeTo(88,9)}]);
    expect(familyFrequency(fit.events[0],1)).toBeCloseTo(88,9);
    expect(fit.events[0].rmsHz).toBeLessThan(1e-9);
    // Without the family tag the engine lines would be forced onto the rotor fundamental.
    const untagged={...event,trace:event.trace.map(({family,...p})=>p)};
    expect(scoreCombination(pair,[untagged],settings).events[0].rmsHz).toBeGreaterThan(5);
    expect(scoreCombination(pair,[untagged],settings).events[0].families).toBeUndefined();
});

test("a family cannot move the geometry: a shifted clock still misfits both families",()=>{
    const {pair,event,settings}=fixture();
    const good=scoreCombination(pair,[event],settings).events[0].rmsHz;
    const shifted=scoreCombination(pair,[event],{...settings,recordingStart:6}).events[0].rmsHz;
    expect(good).toBeLessThan(1e-9);
    expect(shifted).toBeGreaterThan(1);
});

test("family tags are validated and preserved through saved analyses and searches",()=>{
    const demo=makeDemo();
    demo.events[0].trace[0].family=1;
    const saved=validateAnalysis(JSON.parse(JSON.stringify(demo)));
    expect(saved.events[0].trace[0].family).toBe(1);
    expect(saved.events[0].trace[1].family).toBeUndefined();
    expect(tracedFamilies(saved.events[0])).toEqual([0,1]);
    for(const family of [-1,8,1.5,"1"]) {
        demo.events[0].trace[0].family=family;
        expect(()=>validateAnalysis(JSON.parse(JSON.stringify(demo)))).toThrow(/trace points/);
        expect(()=>validateSearch({...demo,settings:{...demo.settings,recordingStart:null}})).toThrow(/families/);
    }
    demo.events[0].trace[0].family=7;demo.events[0].family=7;
    expect(()=>validateSearch({...demo,settings:{...demo.settings,recordingStart:null}})).not.toThrow();
    demo.events[0].family=8;
    expect(()=>validateSearch({...demo,settings:{...demo.settings,recordingStart:null}})).toThrow(/tone family/);
});

test("thinning keeps endpoints of every family and harmonic; counts and tags stay per family",()=>{
    const event={harmonic:1,family:0,trace:[0,1,2,3,4,5].flatMap(time=>[{time,frequency:100,harmonic:1},{time,frequency:88,harmonic:1,family:1}])};
    const thinned=thinTrace(event);
    expect(thinned.filter(p=>p.family===1).map(p=>p.time)).toEqual([0,2,4,5]);
    expect(thinned.filter(p=>p.family===undefined).map(p=>p.time)).toEqual([0,2,4,5]);
    expect(tracedHarmonics(event,1)).toEqual([1]);
    expect(tracedFamilies({harmonic:1,trace:[]})).toEqual([0]);
    expect(tracedFamilies({harmonic:1})).toEqual([0]);
    event.family=1;event.harmonic=2;
    expect(addHarmonicTracePoint(event,{time:9,frequency:180},.15)).toBe(true);
    expect(event.trace.at(-1)).toEqual({time:9,frequency:180,harmonic:2,family:1});
    event.family=0;
    expect(addHarmonicTracePoint(event,{time:9,frequency:200},.15)).toBe(true);
    expect(event.trace.at(-1)).toEqual({time:9,frequency:200,harmonic:2});
    expect(spectrumHarmonicCounts(event)).toEqual([{harmonic:1,count:6},{harmonic:2,count:1},{family:1,harmonic:1,count:6},{family:1,harmonic:2,count:1}]);
});

test("reference diagnostics fit one frequency per family at a fixed location",()=>{
    const settings={recordingStart:1000,lat:0,lon:0,altitudeM:0,soundSpeed:343,maxGap:12,cpaTolerance:30};
    const track={id:"synthetic",points:Array.from({length:13},(_,i)=>({time:940+i*10,lat:0,lon:(i-6)*.009,altitudeM:1000}))};
    const view=observerTrack(require("../src/doppler/DopplerModel").prepareTrack(track,343,12),require("../src/doppler/DopplerModel").toECEF(0,0,0),343);
    const trace=[5,15,25,35].flatMap(time=>[{time,harmonic:1,frequency:110*atArrival(view,1000+time,343).factor},
        {time,harmonic:2,family:1,frequency:2*77*atArrival(view,1000+time,343).factor}]);
    const event={name:"Two families",start:0,end:40,cpa:3,frequency:100,frequencyTolerance:50,harmonic:1,speedMin:0,speedMax:200,rangeMin:0,rangeMax:5000,trace};
    const row=diagnoseDopplerReference({settings,events:[event],tracks:[track]}).events[0].rows[0];
    expect(row.status).toBe("complete");
    expect(row.frequency).toBeCloseTo(110,9);
    expect(row.families).toEqual([{family:0,frequency:expect.closeTo(110,9)},{family:1,frequency:expect.closeTo(77,9)}]);
    expect(row.rmsHz).toBeLessThan(1e-9);
});
