import {canPreserveAudioResult,compactSearchResult,resultMapViewport,validateAnalysis} from "../src/doppler/DopplerAnalysis";
import {makeDemo} from "../src/doppler/DopplerDemo";

test("analysis validation accepts unfinished measurements but rejects malformed imported objects before mutation",()=>{
    const draft=makeDemo();draft.events.forEach(e=>{e.trace=[];});draft.tracks=[];
    expect(validateAnalysis(draft).events[0].trace).toEqual([]);
    const malformed={...draft,events:[{}]},before=JSON.stringify(malformed);
    expect(()=>validateAnalysis(malformed)).toThrow(/event 1/);
    expect(JSON.stringify(malformed)).toBe(before);
    expect(()=>validateAnalysis({...draft,settings:{...draft.settings,silence:{}}})).toThrow(/silence/);
    expect(()=>validateAnalysis({...draft,tracks:[{id:"broken",points:[null,null]}]})).toThrow(/fixes/);
    expect(()=>validateAnalysis({...draft,provenance:{archiveFiles:{}}})).toThrow(/source information/);
});

test("analysis round trip preserves candidate selection, aircraft labels and file provenance without heavy search arrays",()=>{
    const analysis=makeDemo();analysis.tracks[0].callsign="TEST123";analysis.tracks[0].aircraftType="Test aircraft";
    analysis.provenance={audio:{name:"recording.aac",size:12345,lastModified:100},archiveFiles:[{name:"day.tar",size:99999,lastModified:200}]};
    const candidate={lat:37,lon:-122,altitudeM:123,score:-0.3,recordingStart:Date.UTC(2026,0,1)/1000,
        events:analysis.events.map((e,i)=>({flight:analysis.tracks[i].id,frequency:e.frequency,score:-0.3,rmsHz:0.5,rangeM:1234,speedMS:95,cpaArrival:12345}))};
    const result={results:[candidate,{...candidate,lat:37.001}],heat:[{lat:37,lon:-122,score:-0.3}],tracks:analysis.tracks,
        stats:{passed:2,points:100,combinations:10},elapsedSeconds:4,bounds:[36,-123,38,-121]};
    analysis.savedResult=compactSearchResult(result,1,"2026-11-02T00:00:00Z");
    const restored=validateAnalysis(JSON.parse(JSON.stringify(analysis)));
    expect(restored.savedResult.selectedIndex).toBe(1);
    expect(restored.savedResult.results[1].altitudeM).toBe(123);
    expect(restored.savedResult.results[1].events[0].rangeM).toBe(1234);
    expect(restored.savedResult.completedAtUTC).toBe("2026-11-02T00:00:00Z");
    expect(restored.tracks[0].callsign).toBe("TEST123");expect(restored.provenance).toEqual(analysis.provenance);
    expect(restored.savedResult.heat).toBeUndefined();expect(restored.savedResult.tracks).toBeUndefined();
    const broken=JSON.parse(JSON.stringify(analysis));broken.savedResult.results[0].events[0].flight="missing";
    expect(()=>validateAnalysis(broken)).toThrow(/saved candidate/);
});

test("archive analysis round trip accepts unavailable navigation measurements as null",()=>{
    const analysis=makeDemo();
    for(const track of analysis.tracks) for(const point of track.points) {
        point.groundSpeedMS=null;point.headingDegrees=null;point.verticalSpeedMS=null;
    }
    const restored=validateAnalysis(JSON.parse(JSON.stringify(analysis)));
    expect(restored.tracks[0].points[0]).toMatchObject({groundSpeedMS:null,headingDegrees:null,verticalSpeedMS:null});
    restored.tracks[0].points[0].groundSpeedMS="unavailable";
    expect(()=>validateAnalysis(restored)).toThrow(/fixes/);
});

test("saved brightness results survive reloading the same audio with the original FFT settings",()=>{
    const analysis=makeDemo(),options={windowSeconds:4,hop:1,maxHz:240};
    analysis.audioOptions=options;
    const saved=compactSearchResult({results:[],stats:{passed:0},audioOptions:options});
    analysis.savedResult=saved;
    const restored=validateAnalysis(JSON.parse(JSON.stringify(analysis)));
    expect(restored.audioOptions).toEqual(options);
    expect(restored.savedResult.audioOptions).toEqual(options);
    expect(canPreserveAudioResult(restored.savedResult,"brightness",true,options)).toBe(true);
    expect(canPreserveAudioResult(restored.savedResult,"brightness",false,options)).toBe(false);
    expect(canPreserveAudioResult(restored.savedResult,"brightness",true,{...options,windowSeconds:2})).toBe(false);
    expect(canPreserveAudioResult({results:[]},"brightness",true,options)).toBe(false);
    expect(canPreserveAudioResult({results:[]},"trace",true,options)).toBe(true);
    expect(()=>validateAnalysis({...analysis,audioOptions:{...options,maxHz:Infinity}})).toThrow(/spectrogram/);
});

test("result viewport fits archive candidates far outside the ordinary search centre and handles the date line",()=>{
    const points=[{lat:41,lon:-74,score:-1},{lat:35,lon:-100,score:-2},{lat:47,lon:-120,score:-3}];
    const view=resultMapViewport({heat:points,results:[]},{lat:37,lon:-122,radiusM:3000});
    for(const p of points) {const q=view.project(p);expect(q.x).toBeGreaterThan(20);expect(q.x).toBeLessThan(980);expect(q.y).toBeGreaterThan(30);expect(q.y).toBeLessThan(270);}
    const dateline=resultMapViewport({results:[{lat:0,lon:179.99},{lat:0,lon:-179.99}]},{});
    expect(dateline.metresPerPixel).toBeLessThan(10);
    expect(Math.abs(dateline.project({lat:0,lon:179.99}).x-dateline.project({lat:0,lon:-179.99}).x)).toBeGreaterThan(500);
});
