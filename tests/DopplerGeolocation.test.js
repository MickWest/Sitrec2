import {atArrival,closestApproaches,navigationVelocity,observerTrack,prepareTrack,toECEF} from "../src/doppler/DopplerModel";
import {makeDemo} from "../src/doppler/DopplerDemo";
import {makeGrid,scoreCombination,searchLocations} from "../src/doppler/DopplerSearch";
import {parseFlightCSV} from "../src/doppler/DopplerImport";
import {makeSpectrogram} from "../src/doppler/DopplerSpectrogram";

const straight=()=>({id:"flight",segments:[{t0:-200,t1:200,p0:[-18000,2000,0],p1:[18000,2000,0],velocity:[90,0,0],speed:90}]});

test("retarded time obeys propagation and the Doppler factor is its time derivative",()=>{
    const view=observerTrack(straight(),[0,0,0],343);
    for(const t of [-50,0,20,70]) {
        const sample=atArrival(view,t,343);
        expect(sample.emissionTime+sample.range/343).toBeCloseTo(t,9);
        const derivative=(atArrival(view,t+0.001).emissionTime-atArrival(view,t-0.001).emissionTime)/0.002;
        expect(sample.factor).toBeCloseTo(derivative,7);
    }
    expect(atArrival(view,-50).factor).toBeGreaterThan(1);
    expect(atArrival(view,70).factor).toBeLessThan(1);
    expect(atArrival(view,2000)).toBeNull();
});

test("closest approach includes 3D slant range and sound delay",()=>{
    const cpa=closestApproaches(observerTrack(straight(),[0,0,0],343))[0];
    expect(cpa.time).toBeCloseTo(0,10);
    expect(cpa.range).toBeCloseTo(2000,8);
    expect(cpa.arrival).toBeCloseTo(2000/343,8);
});

test("navigation velocity uses ground course and vertical speed in ECEF",()=>{
    expect(navigationVelocity(0,0,100,90,5)[0]).toBeCloseTo(5,8);
    expect(navigationVelocity(0,0,100,90,5)[1]).toBeCloseTo(100,8);
    expect(navigationVelocity(0,0,100,0,5)[2]).toBeCloseTo(100,8);
    const track=straight();track.segments[0].v0=[100,0,0];track.segments[0].v1=[120,0,0];
    const view=observerTrack(track,[0,0,0],343),sample=atArrival(view,50);
    const sourceX=90*sample.emissionTime,speed=100+20*(sample.emissionTime+200)/400;
    expect(sample.factor).toBeCloseTo(343/(343+speed*sourceX/sample.range),8);
});

test("fix gaps are not filled and position jumps are rejected",()=>{
    const track={id:"gap",points:[{time:0,lat:0,lon:0,altitudeM:1000},{time:10,lat:0,lon:0.001,altitudeM:1000},
        {time:100,lat:0,lon:0.002,altitudeM:1000},{time:110,lat:0,lon:0.003,altitudeM:1000}]};
    const view=observerTrack(prepareTrack(track),toECEF(0,0,0),343);
    expect(atArrival(view,50)).toBeNull();
    expect(()=>prepareTrack({...track,points:[track.points[0],{...track.points[1],lon:10}]})).toThrow(/near-sonic/);
});

test("flight CSV requires explicit timestamps and altitude units",()=>{
    const tracks=parseFlightCSV('flight,time,lat,lon,altitudeM\n"A,1",2026-09-08T20:00:00Z,37,-122,1000\n"A,1",1788897601,37.001,-122,1000');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe("A,1");
    expect(()=>parseFlightCSV('flight,time,lat,lon,altitudeM\nA,2026-09-08T20:00:00,37,-122,1000')).toThrow(/UTC/);
    expect(()=>parseFlightCSV('flight,time,lat,lon,altitudeM\nA,123,,4,100')).toThrow(/row 2/);
});

test("regional search recovers a withheld synthetic listener from two independently moving flights",async()=>{
    const demo=makeDemo();
    const settings={...demo.settings,recordingStart:null,radiusM:1000,spacingM:200};
    const result=await searchLocations({...demo,settings});
    const best=result.results[0];
    const distance=Math.hypot((best.lat-37)*111320,(best.lon+122)*111320*Math.cos(37*Math.PI/180));
    expect(distance).toBeLessThan(settings.spacingM);
    expect(best.events.map(e=>e.flight)).toEqual(["Demo 1","Demo 2"]);
});

test("events share one clock and cannot independently slide to conceal a bad second event",()=>{
    const demo=makeDemo(),s={...demo.settings,recordingStart:null,timeTolerance:0,cpaTolerance:30};
    const pair=demo.tracks.map(t=>{
        const track=observerTrack(prepareTrack(t),toECEF(37,-122,100),343);
        return {track,cpa:closestApproaches(track)[0]};
    });
    const correct=scoreCombination(pair,demo.events,s);
    expect(correct.score).toBeCloseTo(0,8);
    const changed=demo.events.map((e,i)=>({...e,trace:e.trace.map(p=>({...p,time:p.time+i*12}))}));
    expect(scoreCombination(pair,changed,s).score).toBeLessThan(-1);
});

test("single event requires a known UTC clock; a cancelled search returns no partial answer",async()=>{
    const demo=makeDemo(),settings={...demo.settings,recordingStart:null};
    await expect(searchLocations({...demo,settings,events:[demo.events[0]]})).rejects.toThrow(/at least two/);
    const result=await searchLocations({...demo,settings},{cancelled:()=>true});
    expect(result.cancelled).toBe(true);expect(result.results).toEqual([]);
    expect(()=>makeGrid({...settings,spacingM:10,radiusM:100000})).toThrow(/too large/);
});

test("silence windows reject an otherwise exact candidate",()=>{
    const demo=makeDemo(),s={...demo.settings,recordingStart:null,timeTolerance:0,cpaTolerance:30};
    const pair=demo.tracks.map(t=>{
        const track=observerTrack(prepareTrack(t),toECEF(37,-122,100),343);
        return {track,cpa:closestApproaches(track)[0]};
    });
    const start=pair[0].cpa.arrival-demo.events[0].cpa;
    const other={cpa:{range:1000,arrival:start+300}};
    expect(scoreCombination(pair,demo.events,{...s,silence:[[290,310]]},null,[other])).toBeNull();
});

test("a known clock supports a single flyover, while a wrong clock reduces the fit",async()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    const settings={...demo.settings,recordingStart:clock,timeTolerance:0,cpaTolerance:30};
    const grid=[{lat:37,lon:-122,altitudeM:100},{lat:37.004,lon:-122.004,altitudeM:100}];
    const correct=await searchLocations({...demo,settings,grid,events:[demo.events[1]]});
    expect(correct.results[0].score).toBeCloseTo(0,8);
    expect(correct.results[0].lat).toBe(37);
    const wrong=await searchLocations({...demo,settings:{...settings,recordingStart:clock+10},grid,events:[demo.events[1]]});
    expect(wrong.results[0].score).toBeLessThan(-1);
});

test("brightness scoring ranks actual Doppler ridges on the same physical model",async()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    const spec={columns:601,bins:400,hop:1,binHz:1,start:0,values:new Float32Array(601*400)};
    for(let j=0;j<2;j++) {
        const track=observerTrack(prepareTrack(demo.tracks[j]),toECEF(37,-122,100),343);
        const e=demo.events[j];
        for(let time=Math.floor(e.start);time<=Math.ceil(e.end);time++) {
            const f=atArrival(track,clock+time).factor*e.frequency;
            for(let bin=0;bin<400;bin++) spec.values[time*400+bin]+=Math.exp(-(((bin-f)/0.5)**2));
        }
    }
    const settings={...demo.settings,mode:"brightness",recordingStart:clock,timeTolerance:0};
    const result=await searchLocations({...demo,settings,spectrogram:spec,
        grid:[{lat:37,lon:-122,altitudeM:100},{lat:37.005,lon:-122.005,altitudeM:100}]});
    expect(result.results[0].lat).toBe(37);
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
});

test("spectrogram follows a synthetic chirp with calibrated time/frequency axes",async()=>{
    const rate=2048,duration=10;
    const samples=Float32Array.from({length:rate*duration},(_,i)=>{
        const t=i/rate;return Math.sin(2*Math.PI*(80*t+2*t*t));
    });
    const spec=await makeSpectrogram(samples,rate,{windowSeconds:1,hop:0.25,maxHz:200});
    for(const x of [4,12,24]) {
        const time=spec.start+x*spec.hop,expected=80+4*time;
        let best=0;
        for(let y=50;y<150;y++) if(spec.values[x*spec.bins+y]>spec.values[x*spec.bins+best]) best=y;
        expect(Math.abs(best*spec.binHz-expected)).toBeLessThan(3);
    }
});
