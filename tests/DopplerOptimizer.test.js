import {maximizeBounded,refineDopplerLocation} from "../src/doppler/DopplerOptimizer";
import {makeDemo} from "../src/doppler/DopplerDemo";
import {atArrival,closestApproaches,observerTrack,prepareTrack,toECEF} from "../src/doppler/DopplerModel";

test("bounded optimizer recovers a sub-grid optimum and handles a fixed coordinate",async()=>{
    const result=await maximizeBounded(async([x,y,z])=>({score:-((x-123)**2+2*(y+87)**2+z*z)}),{
        initial:[0,0,0],steps:[200,200,0],bounds:[[-500,500],[-500,500],[0,0]],tolerance:0.001,maxIterations:200});
    expect(result.x[0]).toBeCloseTo(123,2);expect(result.x[1]).toBeCloseTo(-87,2);expect(result.x[2]).toBe(0);
});

test("continuous physical refinement recovers a listener between coarse grid points",async()=>{
    const demo=makeDemo(),lat=37.002,lon=-122.003,observer=toECEF(lat,lon,100),clock=Date.UTC(2026,0,1)/1000;
    const candidate={lat,lon,altitudeM:100,recordingStart:clock,events:demo.tracks.map(t=>{
        const view=observerTrack(prepareTrack(t),observer,343),cpa=closestApproaches(view)[0];
        return {cpaArrival:cpa.arrival,rangeM:cpa.range};
    })};
    const refined=await refineDopplerLocation({candidate,tracks:demo.tracks,events:demo.events,
        settings:{...demo.settings,recordingStart:clock,timeTolerance:0,cpaTolerance:30},
        elevationAt:async()=>100,maxOffsetM:1000,stepM:200,maxIterations:150});
    expect(refined).not.toBeNull();
    const error=Math.hypot((refined.lat-37)*111320,(refined.lon+122)*111320*Math.cos(37*Math.PI/180));
    expect(error).toBeLessThan(5);expect(refined.score).toBeGreaterThan(-0.001);
});

test("refinement re-centres its box when the best fit sits on the edge",async()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    // Seed 1.8 km east of the true listener with a 1 km box: the optimum is outside.
    const candidate={lat:37,lon:-122+1800/(111320*Math.cos(37*Math.PI/180)),altitudeM:100,recordingStart:clock};
    const common={candidate,tracks:demo.tracks,events:demo.events,settings:{...demo.settings,recordingStart:clock,timeTolerance:0,cpaTolerance:30},
        elevationAt:async()=>100,maxOffsetM:1000,stepM:200,maxIterations:150};
    const error=r=>Math.hypot((r.lat-37)*111320,(r.lon+122)*111320*Math.cos(37*Math.PI/180));
    const stuck=await refineDopplerLocation({...common,recenter:0});
    expect(stuck).not.toBeNull();expect(error(stuck)).toBeGreaterThan(700);expect(stuck.optimization.recentered).toBe(0);
    const freed=await refineDopplerLocation(common);
    expect(freed).not.toBeNull();expect(error(freed)).toBeLessThan(5);expect(freed.optimization.recentered).toBeGreaterThan(0);
    expect(freed.score).toBeGreaterThan(stuck.score);
});

test("refinement retains a feasible trial when its penalized optimum violates a range bound",async()=>{
    const demo=makeDemo(),clock=Date.UTC(2026,0,1)/1000;
    const view=observerTrack(prepareTrack(demo.tracks[0]),toECEF(37,-122,100),343);
    const rangeMax=closestApproaches(view)[0].range-10;
    const events=demo.events.map((e,i)=>({...e,rangeMax:i===0 ? rangeMax : e.rangeMax}));
    const refined=await refineDopplerLocation({candidate:{lat:37,lon:-122,altitudeM:100,recordingStart:clock},
        tracks:demo.tracks,events,settings:{...demo.settings,recordingStart:clock,timeTolerance:0,cpaTolerance:30},
        elevationAt:async()=>100,maxOffsetM:1000,stepM:100,maxIterations:150});
    expect(refined).not.toBeNull();
    expect(refined.events[0].rangeM).toBeLessThanOrEqual(rangeMax);
    expect(refined.score).toBeGreaterThan(-0.1);
});
