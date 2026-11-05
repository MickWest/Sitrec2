import {makeDemo} from "../src/doppler/DopplerDemo";
import {atArrival,nearestApproach,nearestApproachFromObserver,observerTrack,prepareTrack,toECEF} from "../src/doppler/DopplerModel";
import {traceFamily,traceHarmonic} from "../src/doppler/DopplerTrace";
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

test("the parabola clock step only improves on the grid best and lands nearer the true clock",()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    const pair=demo.tracks.map(t=>{
        const track=observerTrack(prepareTrack(t),toECEF(37,-122,100),343);
        return {track,cpa:nearestApproach(track)};
    });
    for(const offset of [-1.7,-0.4,0.9,1.3]) {
        const s={...demo.settings,recordingStart:clock+offset,timeTolerance:6,timeStep:4,cpaTolerance:20};
        const grid=scoreCombination(pair,demo.events,s),refined=scoreCombination(pair,demo.events,{...s,clockRefine:true});
        // Without the flag the sweep is the exhaustive grid.
        expect(grid).toEqual(exhaustiveClock(pair,demo.events,s));
        expect(refined.score).toBeGreaterThan(grid.score);
        expect(Math.abs(refined.recordingStart-grid.recordingStart)).toBeLessThanOrEqual(2);
        expect(Math.abs(refined.recordingStart-clock)).toBeLessThan(Math.abs(grid.recordingStart-clock));
        // The reported fit is the production single-clock fit at the refined clock.
        expect(refined).toEqual(scoreCombination(pair,demo.events,{...s,recordingStart:refined.recordingStart,timeTolerance:0}));
    }
    // An edge or one-clock sweep has no neighbours to fit, so the grid result stands.
    const single={...demo.settings,recordingStart:clock+0.4,timeTolerance:0,cpaTolerance:20};
    expect(scoreCombination(pair,demo.events,{...single,clockRefine:true})).toEqual(scoreCombination(pair,demo.events,single));
});

// The trace scorer before its per-event tables were hoisted out of the clock
// loop, kept as the arithmetic reference (with the main-family-only sweep).
function directTraceFit(track,e,recordingStart,s) {
    const factors=e.trace.map(p=>atArrival(track,recordingStart+p.time,s.soundSpeed,true));
    if(factors.some(v=>!Number.isFinite(v))) return null;
    const groups=new Map();
    e.trace.forEach((p,i)=>{const family=traceFamily(p);if(!groups.has(family)) groups.set(family,[]);groups.get(family).push(i);});
    const ordered=[...groups.keys()].sort((a,b)=>a-b),frequencies=new Map();
    for(const family of ordered) {
        let numerator=0,denominator=0;
        for(const i of groups.get(family)) {const k=factors[i]*traceHarmonic(e,e.trace[i]);numerator+=k*e.trace[i].frequency;denominator+=k*k;}
        const fitted=numerator/denominator;
        frequencies.set(family,family===0 ? Math.max(e.frequency-e.frequencyTolerance,Math.min(e.frequency+e.frequencyTolerance,fitted)) : fitted);
    }
    const mse=e.trace.reduce((sum,p,i)=>sum+((p.frequency-frequencies.get(traceFamily(p))*factors[i]*traceHarmonic(e,p))/s.traceSigma)**2,0)/e.trace.length;
    const result={frequency:frequencies.get(ordered[0]),score:-mse,rmsHz:Math.sqrt(mse)*s.traceSigma};
    if(ordered.length>1) result.families=ordered.map(family=>({family,frequency:frequencies.get(family)}));
    return result;
}

test("hoisted trace scoring is bit-identical to the direct per-sample fit",()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    // Mixed tags: a second family and a second harmonic on part of each trace.
    const events=demo.events.map(e=>({...e,trace:e.trace.map((p,i)=>i%3===1 ? {...p,family:2,frequency:p.frequency*0.8}
        : i%3===2 ? {...p,harmonic:2,frequency:p.frequency*2} : p)}));
    let compared=0;
    for(const [lat,lon,altitudeM] of [[37,-122,100],[37.004,-122.006,400],[36.99,-121.99,0]]) {
        const pair=demo.tracks.map(t=>{
            const track=observerTrack(prepareTrack(t),toECEF(lat,lon,altitudeM),343);
            return {track,cpa:nearestApproach(track)};
        });
        for(const shift of [-2.3,0,0.37,5]) for(const [traceSigma,frequencyTolerance] of [[1,2],[0.7,0.01],[2,40]]) {
            const s={...demo.settings,recordingStart:clock+shift,timeTolerance:0,cpaTolerance:1e9,traceSigma};
            const scored=events.map(e=>({...e,frequencyTolerance}));
            const fit=scoreCombination(pair,scored,s);
            const direct=pair.map((p,j)=>directTraceFit(p.track,scored[j],s.recordingStart,s));
            expect(fit.score).toBe(direct.reduce((a,b)=>a+b.score,0)/direct.length);
            expect(fit.events.map(({flight,cpaArrival,rangeM,speedMS,...v})=>v)).toEqual(direct);
            compared++;
        }
    }
    expect(compared).toBe(36);
});
