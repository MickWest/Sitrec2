import {makeDemo} from "../src/doppler/DopplerDemo";
import {nearestApproach,nearestApproachFromObserver,observerTrack,prepareTrack,toECEF} from "../src/doppler/DopplerModel";
import {scoreCombination} from "../src/doppler/DopplerSearch";

test("direct observer CPA matches the view calculation across observers and navigation velocities",()=>{
    const demo=makeDemo();
    const tracks=demo.tracks.map(t=>prepareTrack(t));
    const points=Array.from({length:41},(_,i)=>({time:i*2,lat:40+0.01*Math.sin(i/10),lon:-100+i*0.001,
        altitudeM:1800+i*3,groundSpeedMS:90+i/2,headingDegrees:75+i,verticalSpeedMS:1.5}));
    tracks.push(prepareTrack({id:"navigation",points}));
    for(const track of tracks) for(let y=-8;y<=8;y++) for(let x=-8;x<=8;x++) {
        const origin=track.id==="navigation" ? [40,-100] : [37,-122];
        const observer=toECEF(origin[0]+y*0.01,origin[1]+x*0.01,(x+y+16)*100);
        for(const c of [300,343,375]) expect(nearestApproachFromObserver(track,observer,c))
            .toEqual(nearestApproach(observerTrack(track,observer,c),c));
    }
});

test("direct observer CPA preserves stationary segments, endpoint minima and first ties",()=>{
    const stationary={t0:0,t1:10,p0:[0,10,0],p1:[0,10,0],velocity:[0,0,0],speed:0};
    const moving={t0:20,t1:30,p0:[0,10,0],p1:[100,10,0],velocity:[10,0,0],speed:10,
        v0:[10,1,0],v1:[20,2,0]};
    const track={id:"ties",segments:[stationary,moving,{...stationary,t0:40,t1:50}]};
    for(const observer of [[0,0,0],[-100,0,0],[300,0,0],[0,10,0]]) {
        expect(nearestApproachFromObserver(track,observer)).toEqual(nearestApproach(observerTrack(track,observer,343)));
    }
    expect(nearestApproachFromObserver(track,[0,0,0]).time).toBe(0);
    expect(nearestApproachFromObserver({segments:[]},[0,0,0])).toBeNull();
});

test("bounded segment search preserves exact minima on turning tracks and range thresholds",()=>{
    const points=Array.from({length:501},(_,i)=>({time:2*i,lat:35+0.04*Math.sin(i/55),
        lon:-110+i*0.0004,altitudeM:1500+100*Math.sin(i/23)}));
    const track=prepareTrack({id:"turns",points});
    for(let i=0;i<100;i++) {
        const observer=toECEF(34.95+i%10*0.01,-110+Math.floor(i/10)*0.025,1000);
        const expected=nearestApproach(observerTrack(track,observer,343));
        expect(nearestApproachFromObserver(track,observer)).toEqual(expected);
        expect(nearestApproachFromObserver(track,observer,343,expected.range)).toEqual(expected);
        expect(nearestApproachFromObserver(track,observer,343,expected.range-0.001)).toBeNull();
    }
    const s={t0:0,t1:10,p0:[0,10,0],p1:[0,10,0],velocity:[0,0,0],speed:0};
    const ties={segments:Array.from({length:40},(_,i)=>({...s,t0:i*10,t1:i*10+10}))};
    expect(nearestApproachFromObserver(ties,[0,0,0]).time).toBe(0);
});

// Independent clock enumeration retains the previous exhaustive grid, gate and
// first-best tie rule. Each single-clock evaluation uses the production scorer.
function exhaustiveClock(pair,events,s,spec,approaches=[]) {
    const base=s.recordingStart ?? pair[0].cpa.arrival-events[0].cpa;
    const count=Math.ceil(2*s.timeTolerance/s.timeStep);
    let best=null;
    for(let i=0;i<=count;i++) {
        const shift=count ? -s.timeTolerance+2*s.timeTolerance*i/count : 0;
        const recordingStart=base+shift;
        if(pair.some((p,j)=>Math.abs(p.cpa.arrival-recordingStart-events[j].cpa)>s.cpaTolerance)) continue;
        const fit=scoreCombination(pair,events,{...s,recordingStart,timeTolerance:0},spec,approaches);
        if(fit && (!best || fit.score>best.score)) best=fit;
    }
    return best;
}

test("clipped clock sweep preserves exhaustive trace scores for known and unknown clocks",()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    const pair=demo.tracks.map(t=>{
        const track=observerTrack(prepareTrack(t),toECEF(37.002,-122.003,100),343);
        return {track,cpa:nearestApproach(track)};
    });
    for(const recordingStart of [null,clock,clock+0.1,clock+20]) {
        for(const timeTolerance of [0,0.1,3,12.3,60]) for(const cpaTolerance of [0,0.1,2.5,20,100]) {
            for(const length of [1,2]) {
                const p=pair.slice(0,length),events=demo.events.slice(0,length);
                const s={...demo.settings,recordingStart,timeTolerance,cpaTolerance,timeStep:0.7};
                expect(scoreCombination(p,events,s)).toEqual(exhaustiveClock(p,events,s));
            }
        }
    }
});

test("clock clipping preserves rounded UTC boundary decisions, silence and brightness scores",()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    const pair=demo.tracks.map(t=>{
        const track=observerTrack(prepareTrack(t),toECEF(37,-122,100),343);
        return {track,cpa:nearestApproach(track)};
    });
    const spec={columns:601,bins:400,hop:1,binHz:1,start:0,
        values:Float32Array.from({length:601*400},(_,i)=>Math.sin(i/19))};
    for(const mode of ["trace","brightness"]) for(const offset of [-0.1000001,-0.1,0,0.1,0.1000001]) {
        const s={...demo.settings,mode,recordingStart:clock+offset,timeTolerance:0.3,timeStep:0.1,cpaTolerance:0.1,
            silence:[[290,310]]};
        const approaches=[{cpa:{range:100,arrival:clock+300}}];
        expect(scoreCombination(pair,demo.events,s,spec)).toEqual(exhaustiveClock(pair,demo.events,s,spec));
        expect(scoreCombination(pair,demo.events,s,spec,approaches)).toEqual(exhaustiveClock(pair,demo.events,s,spec,approaches));
    }
});
