import {diagnoseDopplerReference} from "../src/doppler/DopplerDiagnostics";
import {atArrival, observerTrack, prepareTrack, toECEF} from "../src/doppler/DopplerModel";

const settings={recordingStart:1000,lat:0,lon:0,altitudeM:0,soundSpeed:343,maxGap:12,cpaTolerance:1};
const track={id:"synthetic",callsign:"TEST",points:Array.from({length:13},(_,i)=>({time:940+i*10,lat:0,lon:(i-6)*.009,altitudeM:1000}))};
const event=(source=track)=>{
    const view=observerTrack(prepareTrack(source,343,12),toECEF(0,0,0),343);
    return {name:"Measured family",start:0,end:40,cpa:3,frequency:100,frequencyTolerance:20,harmonic:1,
        speedMin:0,speedMax:200,rangeMin:0,rangeMax:5000,
        trace:[5,15,25,35].flatMap(time=>[1,2,4].map(harmonic=>({time,harmonic,frequency:110*harmonic*atArrival(view,1000+time,343).factor})))};
};

test("true trajectory remains visible when explanatory speed, range and CPA gates fail",()=>{
    const measured={...event(),speedMax:50,rangeMax:500,cpa:20};
    const row=diagnoseDopplerReference({settings,events:[measured],tracks:[track]}).events[0].rows[0];
    expect(row.status).toBe("complete");expect(row.rmsHz).toBeLessThan(1e-10);
    expect(row.gatePass).toBe(false);expect(row.reasons).toEqual(expect.arrayContaining(["speed_outside_bounds","slantRange_outside_bounds","cpa_outside_bounds"]));
    expect(row.identity.callsign).toBe("TEST");expect(row.cpaActual.arrivalTime).toBeCloseTo(1000+1000/343,2);
});

test("tagged harmonics fit one analytic source frequency and honor its bounds",()=>{
    const measured=event();let row=diagnoseDopplerReference({settings,events:[measured],tracks:[track]}).events[0].rows[0];
    expect(row.frequency).toBeCloseTo(110,10);expect(row.predictions).toHaveLength(12);
    expect(row.predictions.every(p=>Math.abs(p.sourceFundamentalHz-110)<1e-10)).toBe(true);
    expect(row.predictions.every(p=>p.emissionTime<p.arrivalTime)).toBe(true);expect(row.navigationFallback).toBe(12);
    const legacy={...measured,harmonic:2,trace:measured.trace.filter(p=>p.harmonic===2).map(({time,frequency})=>({time,frequency}))};
    expect(diagnoseDopplerReference({settings,events:[legacy],tracks:[track]}).events[0].rows[0].frequency).toBeCloseTo(110,10);
    row=diagnoseDopplerReference({settings,events:[{...measured,frequency:100,frequencyTolerance:5}],tracks:[track]}).events[0].rows[0];
    expect(row.frequency).toBe(105);expect(row.frequencyBounded).toBe(true);expect(row.rmsHz).toBeGreaterThan(1);
});

test("missing gaps remain explicit and do not rank above a complete fit",()=>{
    const measured=event();const gapped={...track,id:"gap",points:track.points.filter(p=>p.time<=1010 || p.time>=1030)};
    const invalid={id:"broken",points:[]};
    const rows=diagnoseDopplerReference({settings,events:[measured],tracks:[gapped,invalid,track]}).events[0].rows;
    expect(rows.map(r=>r.id)).toEqual(["synthetic","gap","broken"]);
    expect(rows[1].status).toBe("missing_track_coverage");expect(rows[1].rmsHz).toBeNull();expect(rows[1].partialRmsHz).not.toBeNull();
    const missing=rows[1].predictions.filter(p=>p.status==="missing_track_coverage");expect(missing.length).toBeGreaterThan(0);
    expect(missing.every(p=>p.predictedHz===null && p.emissionTime===null)).toBe(true);
    expect(rows[2].status).toBe("unusable_track");expect(rows[2].rmsHz).toBeNull();
});

test("a known finite UTC start is required and inputs remain unchanged",()=>{
    const input={settings,events:[event()],tracks:[track]},before=JSON.stringify(input);
    for(const recordingStart of [null,undefined,"2020-01-01T00:00:00Z",NaN]) {
        expect(()=>diagnoseDopplerReference({...input,settings:{...settings,recordingStart}})).toThrow(/known recording start/);
    }
    diagnoseDopplerReference(input);expect(JSON.stringify(input)).toBe(before);
});
