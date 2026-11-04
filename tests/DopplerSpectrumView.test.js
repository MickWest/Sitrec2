import {addHarmonicTracePoint,materializeTraceHarmonics,spectrumFrequencyRange,spectrumHarmonicCounts,spectrumLayout,spectrumTracePoint} from "../src/doppler/DopplerSpectrumLayout";

test("full recorded frequency band and independent zoom preserve lower tones and pointer meaning",()=>{
    const spec={bins:188,binHz:4},view={low:20,high:600},event={start:580,end:760,frequency:360,harmonic:1};
    expect(spectrumFrequencyRange(spec,null)).toEqual({low:0,high:748,recordedMaximum:748});
    const band=spectrumFrequencyRange(spec,view),layout=spectrumLayout(1000,500,2);
    const x=layout.left+layout.plotWidth/2,y=layout.top+(band.high-180)/(band.high-band.low)*layout.plotHeight;
    expect(spectrumTracePoint(layout,event,x,y,band.low,band.high)).toEqual({time:670,frequency:180});
    const before=JSON.stringify(event);event.frequency=120;event.harmonic=3;
    expect(spectrumFrequencyRange(spec,view)).toEqual(band);
    expect(spectrumTracePoint(layout,event,x,y,band.low,band.high)).toEqual({time:670,frequency:180});
    expect(view).toEqual({low:20,high:600});expect(JSON.parse(before).frequency).toBe(360);
    expect(spectrumFrequencyRange(spec,{low:20,high:2000}).high).toBe(748);
    expect(spectrumFrequencyRange(spec,{low:800,high:900})).toEqual({low:0,high:748,recordedMaximum:748});
});

test("legacy points keep their old harmonic when selector changes and new tags begin",()=>{
    const event={harmonic:1,trace:[{time:10,frequency:150},{time:20,frequency:140}]};
    materializeTraceHarmonics(event);event.harmonic=2;
    expect(addHarmonicTracePoint(event,{time:10,frequency:300},.15)).toBe(true);
    expect(event.trace).toEqual([{time:10,frequency:150,harmonic:1},{time:20,frequency:140,harmonic:1},{time:10,frequency:300,harmonic:2}]);
    expect(spectrumHarmonicCounts(event)).toEqual([{harmonic:1,count:2},{harmonic:2,count:1}]);
    addHarmonicTracePoint(event,{time:10.05,frequency:299},.15);
    expect(event.trace).toHaveLength(3);expect(event.trace[0]).toMatchObject({time:10,harmonic:1});
    event.harmonic=3;addHarmonicTracePoint(event,{time:10,frequency:450},.15);
    expect(event.trace).toHaveLength(4);expect(spectrumHarmonicCounts(event)).toEqual([{harmonic:1,count:2},{harmonic:2,count:1},{harmonic:3,count:1}]);
});

test("first tagged addition materializes old points and rejects a zero-frequency click",()=>{
    const event={harmonic:2,trace:[{time:5,frequency:300}]};
    expect(addHarmonicTracePoint(event,{time:6,frequency:290},.15)).toBe(true);
    expect(event.trace.every(p=>p.harmonic===2)).toBe(true);
    const before=JSON.stringify(event);expect(addHarmonicTracePoint(event,{time:7,frequency:0},.15)).toBe(false);expect(JSON.stringify(event)).toBe(before);
});
