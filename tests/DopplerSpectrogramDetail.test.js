import {makeSpectrogram} from "../src/doppler/DopplerSpectrogram";
import {detailSpectrogramPlan,makeDetailSpectrogram} from "../src/doppler/DopplerSpectrogramDetail";
import {spectrumLayout,spectrumTracePoint} from "../src/doppler/DopplerSpectrumLayout";

const rate=2048,options={windowSeconds:1,hop:1,maxHz:256};
const signal=()=>Float32Array.from({length:rate*12},(_,i)=>{
    const t=i/rate;return 4*Math.sin(2*Math.PI*120*t)+Math.sin(2*Math.PI*(60*t+1.5*t*t));
});

test("dense visible detail computes additional FFT windows with original frequency bins, baseline and exact audio timing",async()=>{
    const samples=signal(),before=samples.slice(),whole=await makeSpectrogram(samples,rate,options);
    const detail=await makeDetailSpectrogram(samples,rate,options,{start:3,end:5,columns:257},whole.frequencyBaseline);
    expect(detail.columns).toBeGreaterThan(250);expect(detail.hop).toBe(1/128);expect(detail.start).toBe(3);
    expect(detail.binHz).toBe(whole.binHz);expect(detail.frequencyBaseline).toBe(whole.frequencyBaseline);
    // Both products include a window centred at 3.5 s. Their values must agree
    // exactly, including the persistent tone baseline and per-column scaling.
    expect([...detail.values.subarray(64*detail.bins,65*detail.bins)]).toEqual([...whole.values.subarray(3*whole.bins,4*whole.bins)]);
    const column=96,time=detail.start+column*detail.hop;let peak=50;
    for(let bin=50;bin<100;bin++) if(detail.values[column*detail.bins+bin]>detail.values[column*detail.bins+peak]) peak=bin;
    expect(Math.abs(peak*detail.binHz-(60+3*time))).toBeLessThan(3);
    expect(samples).toEqual(before);
    await expect(makeSpectrogram(samples,rate,{...options,hop:0.01})).rejects.toThrow(/Invalid spectrogram/);
});

test("detail extraction is limited to the visible window plus FFT context and respects the existing cell budget",()=>{
    const count=4096*1000,settings={windowSeconds:16,hop:1,maxHz:800};
    const plan=detailSpectrogramPlan(count,4096,settings,{start:100,end:160,columns:925});
    const n=65536,bins=12801,columns=1+Math.floor((plan.last-plan.first-n)/Math.round(plan.hop*4096));
    expect(plan.first).toBe(4096*92);expect(plan.last-plan.first).toBeLessThan(4096*77);
    expect(columns*bins).toBeLessThanOrEqual(8000000);expect(plan.targetColumns).toBeLessThan(925);
});

test("resized canvas backing store, pointer axes and detail sampling agree at fullscreen display sizes",()=>{
    const event={start:30,end:90};
    for(const [width,height] of [[742,500],[1584,620]]) {
        const layout=spectrumLayout(width,height,2);
        expect(layout.nativeWidth).toBe(width*2);expect(layout.nativeHeight).toBe(height*2);
        expect(layout.columns).toBe(Math.ceil(layout.plotWidth*2));
        expect(spectrumTracePoint(layout,event,layout.left,layout.top,80,160)).toEqual({time:30,frequency:160});
        expect(spectrumTracePoint(layout,event,layout.left+layout.plotWidth/2,layout.top+layout.plotHeight/2,80,160)).toEqual({time:60,frequency:120});
        expect(spectrumTracePoint(layout,event,layout.left+layout.plotWidth,layout.top+layout.plotHeight,80,160)).toEqual({time:90,frequency:80});
        expect(spectrumTracePoint(layout,event,layout.left-1,layout.top,80,160)).toBeNull();
        const plan=detailSpectrogramPlan(4096*1000,4096,{windowSeconds:2,hop:1,maxHz:800},{...event,columns:layout.columns});
        const columns=1+Math.floor((plan.last-plan.first-8192)/Math.round(plan.hop*4096));
        expect(columns*1601).toBeLessThanOrEqual(8000000);
    }
    expect(spectrumLayout(742,500,4).dpr).toBe(2);
});

test("cancelled detail work stops at an FFT yield without producing a replacement spectrogram",async()=>{
    const samples=signal(),whole=await makeSpectrogram(samples,rate,options);let checks=0;
    await expect(makeDetailSpectrogram(samples,rate,options,{start:3,end:5,columns:257},whole.frequencyBaseline,()=>++checks>=3)).rejects.toThrow(/cancelled/);
    expect(checks).toBe(3);
    expect(whole.hop).toBe(1);expect(whole.columns).toBe(12);
});

test("audio worker discards stale detail responses after cancellation while retaining the original scoring result",async()=>{
    const previous=global.self,target={postMessage:jest.fn()};global.self=target;
    try {
        jest.isolateModules(()=>{require("../src/doppler/DopplerWorker");});
        await target.onmessage({data:{type:"spectrogram",samples:signal(),sampleRate:rate,options}});
        expect(target.postMessage.mock.calls.at(-1)[0]).toMatchObject({type:"result",value:{hop:1,binHz:1}});
        target.postMessage.mockClear();
        const pending=target.onmessage({data:{type:"spectrogram-detail",requestId:7,view:{start:3,end:5,columns:257}}});
        await target.onmessage({data:{type:"spectrogram-detail-cancel"}});await pending;
        expect(target.postMessage).not.toHaveBeenCalled();
        await target.onmessage({data:{type:"spectrogram-detail",requestId:8,view:{start:3,end:5,columns:257}}});
        expect(target.postMessage.mock.calls.at(-1)[0]).toMatchObject({type:"spectrogram-detail",requestId:8,value:{hop:1/128,binHz:1,start:3}});
    } finally {if(previous===undefined) delete global.self;else global.self=previous;}
});
