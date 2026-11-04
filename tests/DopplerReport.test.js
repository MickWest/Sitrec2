import {buildDopplerReportData,reportElapsed} from "../src/doppler/DopplerReport";
import {makeDemo} from "../src/doppler/DopplerDemo";

function fixture() {
    const state=makeDemo();state.tracks[0].callsign="TEST 123";state.tracks[0].registration="TEST-REG";state.tracks[0].aircraftType="Test aircraft";
    const selectedResult={lat:37,lon:-122,altitudeM:100,recordingStart:Date.UTC(2026,0,1)/1000,score:0,
        events:state.events.map((e,i)=>({flight:state.tracks[i].id,frequency:e.frequency,score:0,rmsHz:0}))};
    return {state,selectedResult,result:{results:[selectedResult],stats:{passed:1}},
        spectrogram:{values:new Float32Array(2),columns:1000,bins:801,binHz:1,hop:1,start:0},audioName:"Example.aac"};
}

test("report curves align with observed audio time and keep fundamental separate from the traced harmonic",()=>{
    const input=fixture();input.state.events[0].harmonic=2;
    input.state.events[0].trace.forEach(p=>{p.frequency*=2;});
    const report=buildDopplerReportData(input),first=report.events[0];
    for(const [sample,trace] of [[0,0],[250,15],[500,30]]) expect(first.prediction[sample].frequency).toBeCloseTo(first.event.trace[trace].frequency,8);
    expect(first.fitted.frequency).toBe(130);expect(first.title).toBe("TEST 123");
    expect(first.identity).toContain("TEST-REG");expect(first.identity).toContain("Test aircraft");
    expect(first.low).toBeLessThan(first.prediction[250].frequency);expect(first.high).toBeGreaterThan(first.prediction[250].frequency);
    expect(report.audioName).toBe("Example.aac");expect(report.rank).toBe(1);
});

test("report accepts one to four event panels and rejects missing audio or retained flight data",()=>{
    const input=fixture();input.state.events=Array(4).fill(input.state.events[0]);input.selectedResult.events=Array(4).fill(input.selectedResult.events[0]);
    expect(buildDopplerReportData(input).events).toHaveLength(4);
    input.state.events=input.state.events.slice(0,1);input.selectedResult.events=input.selectedResult.events.slice(0,1);
    expect(buildDopplerReportData(input).events).toHaveLength(1);
    expect(()=>buildDopplerReportData({...input,spectrogram:null})).toThrow(/original audio/);
    input.state.tracks=[];expect(()=>buildDopplerReportData(input)).toThrow(/flight data for event 1/);
});

test("brightness-mode events without traced points still export one prediction curve",()=>{
    const input=fixture();input.state.settings.mode="brightness";
    for(const event of input.state.events) event.trace=[];
    const report=buildDopplerReportData(input);
    expect(report.events[0].families).toEqual([0]);
    expect(report.events[0].predictions).toHaveLength(1);
    expect(report.events[0].prediction[250].frequency).toBeCloseTo(130*report.events[0].predictions[0].points[250].frequency/130,10);
    expect(Number.isFinite(report.events[0].low)).toBe(true);
});

test("elapsed axis labels carry minutes and hours without wrapping the recording clock",()=>{
    expect(reportElapsed(2140)).toBe("35:40");expect(reportElapsed(3671)).toBe("1:01:11");
});

test("report shows every measured harmonic using one fitted fundamental",()=>{
    const input=fixture(),event=input.state.events[0];
    event.trace=event.trace.flatMap(p=>[{...p,harmonic:1},{...p,harmonic:2,frequency:p.frequency*2}]);
    const report=buildDopplerReportData(input).events[0];
    expect(report.harmonics).toEqual([1,2]);
    expect(report.predictions).toHaveLength(2);
    expect(report.predictions[1].points[250].frequency).toBeCloseTo(2*report.predictions[0].points[250].frequency,10);
    expect(report.high).toBeGreaterThan(report.predictions[1].points[250].frequency);
});
