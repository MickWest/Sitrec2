import {analyzeErrors, angularResidual, directionWithError, estimateTrackingDelay, fitErrorModel, fitOperatorErrorModel, generateErrors,
    sampleAtRate, serializeErrorModel, summarizeErrors, validateErrorModel} from "../src/LOSErrorModel";

const white={schema:"sitrec-los-error-model",version:1,basis:"local-up-cross-clean-los",sampleRateHz:30,
    meanDeg:[.07,-.04],reflection:[[],[]],innovationSigmaDeg:[.2,.3],innovationCorrelation:.4,innovationDistribution:"gaussian"};
const times=(n,hz=30)=>Array.from({length:n},(_,i)=>i/hz);

test("spherical residual inverts fresh directions at different viewing geometries",()=>{
    for(const up of [[0,0,1],[1,0,0]]) for(const target of [[100,1000,200],[0,0,1000],[0,0,-1000]]) {
        const error=[.2,-.6],d=directionWithError([0,0,0],target,error,up);
        const recovered=angularResidual([0,0,0],target,d,up);
        expect(recovered[0]).toBeCloseTo(error[0],9);expect(recovered[1]).toBeCloseTo(error[1],9);
    }
    expect(angularResidual([0,0,0],[0,0,0],[1,0,0])).toBeNull();
    expect(angularResidual([0,0,0],[0,1,0],[0,-1,0])).toBeNull();
    expect(angularResidual([0,0,0],[0,1,0],[0,NaN,0])).toBeNull();
});

test("white noise keeps per-sample amplitude, loses observations, and is not a random walk",()=>{
    const errors=generateErrors(white,times(30000),"white-independent-test"),analysis=analyzeErrors(errors);
    expect(analysis.views.map(v=>v.summary.n)).toEqual([30000,10000,1000]);
    for(const {summary:s} of analysis.views) {
        expect(s.sigma[0]).toBeCloseTo(.2,1);expect(s.sigma[1]).toBeCloseTo(.3,1);
        expect(Math.abs(s.acf.find(a=>a.seconds===1).axes[0])).toBeLessThan(.1);
    }
    expect(analysis.views[0].summary.mean[0]).toBeCloseTo(.07,2);
    expect(analysis.views[0].summary.axisCorrelation).toBeCloseTo(.4,1);
    const model=fitErrorModel(errors);
    expect(model.reflection).toEqual([[],[]]);
    expect(model.innovationSigmaDeg[0]).toBeCloseTo(.2,2);
});

test("fits temporal memory and reproduces its physical-time correlation on a fresh seed",()=>{
    const known={...white,sampleRateHz:10,meanDeg:[0,0],reflection:[[.9],[.8]],innovationSigmaDeg:[.05,.08],innovationCorrelation:0};
    const source=generateErrors(known,times(12000,10),"colored-calibration");
    const fitted=fitErrorModel(source),fresh=generateErrors(fitted,times(12000,10),"unseen-realization");
    expect(fitted.reflection[0][0]).toBeCloseTo(.9,1);
    const actual=summarizeErrors(source),synthetic=summarizeErrors(fresh);
    expect(synthetic.sigma[0]/actual.sigma[0]).toBeGreaterThan(.9);
    expect(synthetic.sigma[0]/actual.sigma[0]).toBeLessThan(1.1);
    expect(Math.abs(synthetic.acf.find(a=>a.seconds===1).axes[0]-actual.acf.find(a=>a.seconds===1).axes[0])).toBeLessThan(.08);
    expect(fresh[0].e).not.toEqual(source[0].e);
    expect(generateErrors(fitted,times(12000,10),"unseen-realization")).toEqual(fresh);
});

test("downsampling uses the same latent realization, never newly drawn output-frame jitter",()=>{
    const full=generateErrors(white,times(301),"same-latent-draw");
    const one=generateErrors(white,times(11,1),"same-latent-draw");
    expect(one).toEqual(sampleAtRate(full,1));
    expect(sampleAtRate(one,10)).toBeNull();
    expect(()=>generateErrors({...white,sampleRateHz:1},times(20,10),"x")).toThrow(/higher recording rate/);
});

test("bad times and gaps are excluded; short clips get an amplitude-only portable model",()=>{
    const source=times(61).filter(t=>t<.7||t>1.2).map(t=>({t,e:[t,t/2]}));
    const sampled=sampleAtRate(source,10);
    expect(sampled.filter(r=>r.t>.7&&r.t<1.2)).toHaveLength(0);
    const result=analyzeErrors([...source,{t:NaN,e:[0,0]},source.at(-1)]);
    expect(result.rejected).toEqual({invalid:1,nonIncreasingTime:1});
    expect(result.views[0].summary.gaps).toBe(1);
    const short=source.slice(0,10),fitted=fitErrorModel(short);
    expect(fitted.reflection).toEqual([[],[]]);
    expect(fitted.meanDeg).toEqual(summarizeErrors(short).mean);
    expect(fitted.innovationSigmaDeg).toEqual(summarizeErrors(short).sigma);
    expect(generateErrors(fitted,short.map(r=>r.t),"new-short-clip")).toHaveLength(short.length);
    expect(()=>fitErrorModel(source.slice(0,1))).toThrow(/two valid/);
});

test("portable model is an allowlist, with no measured sequence or geometry",()=>{
    const poisoned={...white,positions:[[1,2,3]],timestamps:[1234],samples:[.4,.8],sourceName:"private-sample",seed:"source-seed"};
    const json=serializeErrorModel(poisoned);
    expect(JSON.parse(json)).toEqual(white);
    expect(json).not.toMatch(/positions|timestamps|samples|private-sample|source-seed/);
    expect(()=>validateErrorModel({...white,reflection:[[1.01],[]]})).toThrow(/Invalid/);
    expect(()=>validateErrorModel({...white,innovationSigmaDeg:[NaN,1]})).toThrow(/Invalid/);
});

test("exact clean LOS yields a zero-noise portable model and a zero-noise realization",()=>{
    const clean=times(100).map(t=>({t,e:[0,0]}));
    const fitted=fitErrorModel(clean);
    expect(fitted.innovationSigmaDeg).toEqual([0,0]);
    expect(generateErrors(fitted,times(100),"new-seed")).toEqual(clean);
});

const operator={schema:"sitrec-los-error-model",version:1,basis:"local-up-cross-clean-los",modelType:"operator-feedback",
    sampleRateHz:10,simulationRateHz:10,meanDeg:[.01,-.02],axisScale:[1,1],axisCorrelation:0,
    jitterSigmaDeg:[0,0],trackingDelaySeconds:0,
    operator:{amplitude:.2,driftSpeed:.14,reactionTime:.4,correctionSpeed:1.2,accuracy:.8}};

test("human feedback is correlated wandering followed by corrections, with fresh decimatable realizations",()=>{
    const source=generateErrors(operator,times(3001,10),"human-feedback-test");
    const summary=summarizeErrors(source);
    expect(summary.acf.find(r=>r.seconds===1).axes[0]).toBeGreaterThan(.2);
    expect(summary.radialRms).toBeGreaterThan(.08);expect(summary.radialRms).toBeLessThan(.22);
    expect(generateErrors(operator,times(301,1),"human-feedback-test")).toEqual(sampleAtRate(source,1));
    const poisoned={...operator,samples:source,sourceName:"private-source",operator:{...operator.operator,seed:12345}};
    expect(JSON.parse(serializeErrorModel(poisoned))).toEqual(operator);
});

test("effective following delay is recovered from changing target bearings, without storing the geometry",()=>{
    const t=times(2001,20),geometry=t.map(t=>({t,sensor:[0,0,0],target:[100*Math.sin(t/3),1000,70*Math.cos(t/4)],up:[0,0,1]}));
    const delayed={...operator,sampleRateHz:20,simulationRateHz:20,trackingDelaySeconds:.3,meanDeg:[0,0],
        operator:{...operator.operator,amplitude:0,driftSpeed:0}};
    const source=generateErrors(delayed,t,"new-delay-test",geometry),estimated=estimateTrackingDelay(source,geometry);
    expect(estimated.seconds).toBeCloseTo(.3,1);expect(estimated.explainedFraction).toBeGreaterThan(.95);
    expect(()=>generateErrors(delayed,t,"x")).toThrow(/geometry/);
});

test("operator fit estimates an aggregate analogue on unseen calibration and output seeds",async()=>{
    const source=generateErrors(operator,times(1801,10),"unseen-operator-source");
    const fitted=await fitOperatorErrorModel(source.filter(r=>r.t<90));
    const synthetic=generateErrors(fitted.model,times(1801,10),"independent-operator-output");
    const actual=summarizeErrors(source),generated=summarizeErrors(synthetic);
    expect(fitted.model.modelType).toBe("operator-feedback");
    expect(fitted.candidates).toBeGreaterThan(1);
    expect(generated.centeredRms/actual.centeredRms).toBeGreaterThan(.8);
    expect(generated.centeredRms/actual.centeredRms).toBeLessThan(1.2);
    expect(Math.abs(generated.acf.find(r=>r.seconds===1).axes[0]-actual.acf.find(r=>r.seconds===1).axes[0])).toBeLessThan(.2);
},15000);

test("operator errors scale to small angles without inheriting a controller speed floor",()=>{
    const a=generateErrors(operator,times(300,10),"scale-invariance");
    const b=generateErrors({...operator,meanDeg:operator.meanDeg.map(x=>x*.001),
        operator:{...operator.operator,amplitude:.0002,driftSpeed:.00014,correctionSpeed:.0012}},times(300,10),"scale-invariance");
    for(let i=0;i<a.length;i++) for(let axis=0;axis<2;axis++) expect(b[i].e[axis]).toBeCloseTo(a[i].e[axis]*.001,10);
});
