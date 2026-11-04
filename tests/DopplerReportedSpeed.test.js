import {atArrival,closestApproaches,navigationVelocity,nearestApproach,nearestApproachFromObserver,observerTrack,prepareTrack,toECEF} from "../src/doppler/DopplerModel";
import {diagnoseDopplerReference} from "../src/doppler/DopplerDiagnostics";

const soundSpeed=343;
const points=(extra={})=>[-10,0,10].map(time=>({time,lat:0,lon:time*.001,altitudeM:1000,groundSpeedMS:45,verticalSpeedMS:0,...extra}));
const view=track=>observerTrack(prepareTrack(track,soundSpeed,20),toECEF(0,0,0),soundSpeed);
const closeVector=(a,b)=>a.forEach((v,i)=>expect(v).toBeCloseTo(b[i],10));

test("reported speed with inferred direction gives consistent Doppler and CPA speed",()=>{
    const inferred=view({id:"inferred",points:points()}),reported=view({id:"reported",points:points({headingDegrees:90})});
    for(let i=0;i<inferred.segments.length;i++) {
        const s=inferred.segments[i];
        expect(s.velocitySource).toBe("reported_speed_derived_direction");expect(s.navigation.approximate).toBe(true);
        closeVector(s.v0,reported.segments[i].v0);closeVector(s.v1,reported.segments[i].v1);
        // The position derivative remains faster than the measured magnitude.
        expect(s.speed).toBeGreaterThan(100);
    }
    for(const arrival of [-3,3,8])expect(atArrival(inferred,arrival,soundSpeed).factor).toBeCloseTo(atArrival(reported,arrival,soundSpeed).factor,12);
    const cpa=nearestApproach(inferred,soundSpeed);
    expect(cpa.speed).toBeCloseTo(45,5);expect(cpa.speed<=60).toBe(true);
    expect(nearestApproachFromObserver(prepareTrack({id:"inferred",points:points()},soundSpeed,20),toECEF(0,0,0),soundSpeed).speed).toBeCloseTo(cpa.speed,10);
    expect(closestApproaches(inferred,soundSpeed).every(p=>p.speed<=60)).toBe(true);
    const legacy={...inferred,segments:inferred.segments.map(s=>({...s,v0:null,v1:null}))};
    expect(nearestApproach(legacy,soundSpeed).speed).toBeGreaterThan(60);
});

test("fully reported navigation keeps its exact endpoint velocities",()=>{
    const source={id:"reported",points:points({headingDegrees:20,verticalSpeedMS:2})},prepared=prepareTrack(source,soundSpeed,20);
    prepared.segments.forEach((s,i)=>{
        closeVector(s.v0,navigationVelocity(0,source.points[i].lon,45,20,2));
        closeVector(s.v1,navigationVelocity(0,source.points[i+1].lon,45,20,2));
        expect(s.velocitySource).toBe("reported_navigation");expect(s.navigation.exact).toBe(true);
    });
});

test("missing speed preserves the position derivative fallback",()=>{
    const source={id:"positions",points:points({groundSpeedMS:undefined})},prepared=prepareTrack(source,soundSpeed,20);
    for(const s of prepared.segments){expect(s.v0).toBeNull();expect(s.v1).toBeNull();expect(s.velocitySource).toBe("position_derived");}
    const track=observerTrack(prepared,toECEF(0,0,0),soundSpeed),sample=atArrival(track,3,soundSpeed);
    expect(sample.factor).toBeGreaterThan(0);expect(nearestApproach(track,soundSpeed).speed).toBeCloseTo(prepared.segments[0].speed,8);
});

test("vertical-only displacement does not invent a horizontal direction",()=>{
    const source={id:"vertical",points:[{time:0,lat:0,lon:0,altitudeM:1000,groundSpeedMS:45,verticalSpeedMS:3},
        {time:10,lat:0,lon:0,altitudeM:1100,groundSpeedMS:45,verticalSpeedMS:3}]};
    const s=prepareTrack(source,soundSpeed,20).segments[0];
    expect(s.v0).toBeNull();expect(s.v1).toBeNull();expect(s.navigation.degenerateHorizontal).toBe(true);
    expect(s.velocitySource).toBe("position_derived");expect(s.speed).toBeCloseTo(10,10);
});

test("one endpoint missing speed keeps the existing whole-segment fallback",()=>{
    const source={id:"partial",points:points().slice(0,2)};delete source.points[1].groundSpeedMS;
    const prepared=prepareTrack(source,soundSpeed,20),s=prepared.segments[0];
    expect(s.v0).not.toBeNull();expect(s.v1).toBeNull();expect(s.velocitySource).toBe("position_derived");
    const observer=toECEF(0,0,0),a=observerTrack(prepared,observer,soundSpeed),b=observerTrack({...prepared,segments:[{...s,v0:null,v1:null}]},observer,soundSpeed);
    expect(atArrival(a,-2,soundSpeed).factor).toBe(atArrival(b,-2,soundSpeed).factor);
    expect(nearestApproach(a,soundSpeed).speed).toBe(s.speed);
});

test("inferred direction retains reported vertical rate or derives missing vertical rate",()=>{
    const source={id:"climb",points:[{time:0,lat:0,lon:0,altitudeM:1000,groundSpeedMS:45,verticalSpeedMS:2},
        {time:10,lat:0,lon:.001,altitudeM:1100,groundSpeedMS:45,verticalSpeedMS:2}]};
    let s=prepareTrack(source,soundSpeed,20).segments[0];expect(s.v0[0]).toBeCloseTo(2,10);expect(s.navigation.verticalSources).toEqual(["reported","reported"]);
    source.points.forEach(p=>delete p.verticalSpeedMS);s=prepareTrack(source,soundSpeed,20).segments[0];
    expect(s.v0[0]).toBeCloseTo(s.velocity[0],10);expect(s.navigation.verticalSources).toEqual(["position_derived","position_derived"]);
});

test("reported magnitude cannot bypass near-sonic or position-jump guards",()=>{
    expect(()=>prepareTrack({id:"fast",points:points({groundSpeedMS:400})},soundSpeed,20)).toThrow(/reports a near-sonic/);
    const jumping={id:"jump",points:[{time:0,lat:0,lon:0,altitudeM:1000,groundSpeedMS:10},{time:1,lat:0,lon:.01,altitudeM:1000,groundSpeedMS:10}]};
    expect(()=>prepareTrack(jumping,soundSpeed,20)).toThrow(/near-sonic segment or a position jump/);
});

test("reference diagnostics expose inferred navigation without calling derived vertical zero",()=>{
    const track={id:"inferred",points:points({verticalSpeedMS:undefined})},prepared=view(track);
    const trace=[-3,0,3,6].map(time=>({time:time+10,frequency:100*atArrival(prepared,time,soundSpeed).factor,harmonic:1}));
    const settings={recordingStart:-10,lat:0,lon:0,altitudeM:0,soundSpeed,maxGap:20,cpaTolerance:20};
    const event={name:"Measured",start:0,end:20,cpa:10,frequency:100,frequencyTolerance:10,harmonic:1,speedMin:0,speedMax:60,rangeMin:0,rangeMax:5000,trace};
    const row=diagnoseDopplerReference({settings,events:[event],tracks:[track]}).events[0].rows[0];
    expect(row.rmsHz).toBeLessThan(1e-10);expect(row.inferredNavigation).toBe(4);expect(row.approximateNavigation).toBe(4);
    expect(row.verticalRateAssumedZero).toBe(0);expect(row.predictions.every(p=>p.verticalRateFromPositions)).toBe(true);
});
