// Statistics and synthesis only: this module has no scene, file or network access.
import {generateWobbleOffsets} from "./TrackingWobbleMath";
// Angles use the spherical log map, in degrees, in a local horizontal/vertical
// tangent frame. The portable model deliberately has no empirical samples.
const DEG = Math.PI / 180;
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => {
    const l = Math.hypot(...a);
    return l > 1e-12 && a.every(Number.isFinite) ? a.map(x => x/l) : null;
};
export const quantile = (values, q) => {
    if (!values.length) return null;
    const a = [...values].sort((x, y) => x-y), p = (a.length-1)*q, i = Math.floor(p);
    return a[i] + (a[Math.min(i+1, a.length-1)]-a[i])*(p-i);
};

function basis(direction, up) {
    let horizontal = unit(cross(up, direction));
    // Deterministic fallback at zenith/nadir; the horizontal axis is ambiguous there.
    if (!horizontal) horizontal = unit(cross(Math.abs(direction[0]) < .9 ? [1,0,0] : [0,1,0], direction));
    return [horizontal, cross(direction, horizontal)];
}

/** Exact angular residual; null for invalid geometry or antipodal ambiguity. */
export function angularResidual(sensor, target, observed, up = [0,0,1]) {
    const clean = unit(target.map((v, i) => v-sensor[i])), measured = unit(observed);
    if (!clean || !measured || !unit(up)) return null;
    const cosine = Math.max(-1, Math.min(1, dot(clean, measured)));
    const sine = Math.hypot(...cross(clean, measured));
    const angle = Math.atan2(sine, cosine);
    if (Math.PI-angle < 1e-6) return null;
    const [h,v] = basis(clean, up), scale = sine > 1e-12 ? angle / sine / DEG : 1/DEG;
    return [dot(measured, h)*scale, dot(measured, v)*scale];
}

/** Apply a new error realization to arbitrary sensor/target positions. */
export function directionWithError(sensor, target, error, up = [0,0,1]) {
    const clean = unit(target.map((v, i) => v-sensor[i]));
    if (!clean || !error.every(Number.isFinite) || !unit(up)) return null;
    const radius = Math.hypot(...error), angle = radius*DEG;
    if (angle >= Math.PI) return null;
    if (radius < 1e-12) return clean;
    const [h,v] = basis(clean, up);
    return clean.map((d, i) => d*Math.cos(angle) + (h[i]*error[0]+v[i]*error[1])/radius*Math.sin(angle));
}

export function cadence(samples) {
    const intervals = samples.slice(1).map((s,i) => s.t-samples[i].t).filter(x => x > 0 && Number.isFinite(x));
    const dt = quantile(intervals, .5);
    return {hz: dt ? 1/dt : null, dt, gaps: dt ? intervals.filter(x => x > 1.5*dt).length : 0,
        intervalP05: quantile(intervals,.05), intervalP95: quantile(intervals,.95)};
}

/** Nearest recorded samples, anchored at the first sample. No averaging,
 * interpolation, duplicate reuse, or gap filling. Upsampling is unavailable. */
export function sampleAtRate(samples, hz) {
    const c = cadence(samples);
    if (!(hz > 0) || !c.hz || hz > c.hz*1.01) return null;
    if (Math.abs(hz-c.hz)/hz < .001) return [...samples];
    const out = [], t0 = samples[0].t, end = samples.at(-1).t;
    let i = 0, previous = -1;
    for (let k = 0; t0+k/hz <= end+1e-8; k++) {
        const t = t0+k/hz;
        while (i+1 < samples.length && Math.abs(samples[i+1].t-t) < Math.abs(samples[i].t-t)) i++;
        if (i !== previous && Math.abs(samples[i].t-t) <= c.dt*.55) {
            out.push(samples[i]); previous = i;
        }
    }
    return out;
}

function correlation(samples, lag, means, dt) {
    let j=0, xx=[0,0], yy=[0,0], xy=[0,0], pairs=0;
    for (let i=0; i<samples.length; i++) {
        j = Math.max(j, i+1);
        const wanted = samples[i].t+lag;
        while (j+1 < samples.length && Math.abs(samples[j+1].t-wanted) < Math.abs(samples[j].t-wanted)) j++;
        if (j>=samples.length || Math.abs(samples[j].t-wanted) > dt*.25) continue;
        pairs++;
        for (let a=0;a<2;a++) {
            const x=samples[i].e[a]-means[a], y=samples[j].e[a]-means[a];
            xx[a]+=x*x; yy[a]+=y*y; xy[a]+=x*y;
        }
    }
    return {seconds:lag, pairs, axes:xy.map((x,a) => pairs>=5 && xx[a]*yy[a]>1e-20 ? x/Math.sqrt(xx[a]*yy[a]) : null)};
}

export function summarizeErrors(samples) {
    if (samples.length < 2) throw new Error("Need at least two valid LOS/truth samples.");
    const n=samples.length, c=cadence(samples), mean=[0,1].map(a => samples.reduce((s,r)=>s+r.e[a],0)/n);
    const variance=[0,1].map(a => samples.reduce((s,r)=>s+(r.e[a]-mean[a])**2,0)/n);
    const sigma=variance.map(Math.sqrt), radial=samples.map(r=>Math.hypot(...r.e));
    const centered=samples.map(r=>Math.hypot(r.e[0]-mean[0],r.e[1]-mean[1]));
    const covariance=samples.reduce((s,r)=>s+(r.e[0]-mean[0])*(r.e[1]-mean[1]),0)/n;
    const moments = power => [0,1].map(a => sigma[a]>1e-12 ?
        samples.reduce((s,r)=>s+((r.e[a]-mean[a])/sigma[a])**power,0)/n : null);
    const lags=[...new Set([c.dt, .1,.2,.5,1,2,5,10,20,30].filter(x=>x>=c.dt*.99 && x <= (samples.at(-1).t-samples[0].t)/3))];
    const acf=lags.sort((a,b)=>a-b).map(lag=>correlation(samples,lag,mean,c.dt));
    const increments=[];
    for(let i=1;i<n;i++) if(samples[i].t-samples[i-1].t <= 1.5*c.dt) {
        increments.push(Math.hypot(samples[i].e[0]-samples[i-1].e[0],samples[i].e[1]-samples[i-1].e[1]));
    }
    const blocks=Array.from({length:3},(_,i)=>{
        const rows=samples.slice(Math.floor(i*n/3),Math.floor((i+1)*n/3));
        return {mean:[0,1].map(a=>rows.reduce((s,r)=>s+r.e[a],0)/rows.length),
            rms:Math.sqrt(rows.reduce((s,r)=>s+dot(r.e,r.e),0)/rows.length)};
    });
    return {n, ...c, duration:samples.at(-1).t-samples[0].t, mean, sigma, covariance,
        axisCorrelation:sigma[0]*sigma[1]>1e-20 ? covariance/(sigma[0]*sigma[1]) : null,
        radialRms:Math.sqrt(radial.reduce((s,x)=>s+x*x,0)/n), radialMean:radial.reduce((s,x)=>s+x,0)/n,
        radialP50:quantile(radial,.5), radialP95:quantile(radial,.95), radialP99:quantile(radial,.99), radialMax:radial.reduce((m,x)=>Math.max(m,x),0),
        centeredRms:Math.sqrt(variance[0]+variance[1]), centeredP95:quantile(centered,.95),
        skewness:moments(3), excessKurtosis:moments(4).map(x=>x===null ? null : x-3),
        incrementRms:increments.length ? Math.sqrt(increments.reduce((s,x)=>s+x*x,0)/increments.length) : null,
        acf, blocks};
}

export function analyzeErrors(samples) {
    const valid=[], rejected={invalid:0, nonIncreasingTime:0};
    for(const s of samples) {
        if(!Number.isFinite(s.t) || !s.e || s.e.length!==2 || !s.e.every(Number.isFinite)) {rejected.invalid++;continue;}
        if(valid.length && s.t<=valid.at(-1).t) {rejected.nonIncreasingTime++;continue;}
        valid.push(s);
    }
    const views=[{label:"Original",samples:valid}, ...[10,1].map(hz=>({label:`${hz} Hz`,samples:sampleAtRate(valid,hz)}))]
        .map(view=>({...view, summary:view.samples?.length>=2 ? summarizeErrors(view.samples) : null}));
    return {samples:valid,rejected,views};
}

// Burg lattice fits each axis, choosing a small stationary AR order by BIC.
// Missing records split segments; never manufacture adjacency across a gap.
function fitAxis(samples, axis, mean, dt) {
    let forward=samples.map(r=>r.e[axis]-mean), backward=[...forward];
    let coeff=[], variance=dot(forward,forward)/samples.length;
    let best={reflection:[], coeff:[], variance, bic:samples.length*Math.log(Math.max(variance,1e-30))};
    const reflections=[], maxOrder=Math.min(20,Math.floor(samples.length/20),Math.max(1,Math.round(2/dt)));
    for(let order=1;order<=maxOrder;order++) {
        let num=0,den=0,count=0;
        for(let i=order;i<samples.length;i++) if(samples[i].t-samples[i-order].t < dt*(order+.25)) {
            num+=forward[i]*backward[i-1]; den+=forward[i]**2+backward[i-1]**2; count++;
        }
        if(count<20 || den<1e-24) break;
        const k=Math.max(-.98,Math.min(.98,2*num/den));
        const old=[...coeff]; coeff=old.map((x,i)=>x-k*old[old.length-1-i]); coeff.push(k); reflections.push(k);
        const f=[...forward], b=[...backward];
        for(let i=order;i<samples.length;i++) {forward[i]=f[i]-k*b[i-1];backward[i]=b[i-1]-k*f[i];}
        variance*=1-k*k;
        const bic=samples.length*Math.log(Math.max(variance,1e-30))+order*Math.log(samples.length);
        if(bic<best.bic) best={reflection:[...reflections],coeff:[...coeff],variance,bic};
    }
    return best;
}

export function fitErrorModel(samples) {
    const summary=summarizeErrors(samples);
    const {mean,dt,hz}=summary;
    const amplitudeOnly=()=>validateErrorModel({schema:"sitrec-los-error-model",version:1,basis:"local-up-cross-clean-los",sampleRateHz:hz,
        meanDeg:mean,reflection:[[],[]],innovationSigmaDeg:summary.sigma,
        innovationCorrelation:summary.axisCorrelation ?? 0,innovationDistribution:"gaussian"});
    // A short clip still has a portable amplitude/bias model, but does not
    // provide enough observations to estimate temporal memory reliably.
    if(samples.length<20) return amplitudeOnly();
    const axes=[0,1].map(a=>fitAxis(samples,a,mean[a],dt));
    const order=Math.max(...axes.map(a=>a.coeff.length));
    const innovations=[];
    for(let i=order;i<samples.length;i++) {
        if(i>0 && samples[i].t-samples[Math.max(0,i-order-1)].t > dt*(order+1.25)) continue;
        innovations.push([0,1].map(a=>{
            let value=samples[i].e[a]-mean[a];
            axes[a].coeff.forEach((co,j)=>value-=co*(samples[i-j-1].e[a]-mean[a]));
            return value;
        }));
    }
    if(innovations.length<10) return amplitudeOnly();
    const residual=summarizeErrors(innovations.map((e,i)=>({t:i*dt,e})));
    const model={schema:"sitrec-los-error-model",version:1,basis:"local-up-cross-clean-los",sampleRateHz:hz,
        meanDeg:mean,reflection:axes.map(a=>a.reflection),innovationSigmaDeg:residual.sigma,
        innovationCorrelation:residual.axisCorrelation ?? 0,
        // A Gaussian innovation model is a hypothesis, not a claim about tails.
        innovationDistribution:"gaussian"};
    return validateErrorModel(model);
}

/** Allowlist copy for BOTH import and export; ignore arbitrary extra metadata. */
export function validateErrorModel(value) {
    const finite=(x,lo,hi)=>typeof x==="number" && Number.isFinite(x) && x>=lo && x<=hi;
    const pair=(a,lo,hi)=>Array.isArray(a)&&a.length===2&&a.every(x=>finite(x,lo,hi));
    if(value?.modelType==="operator-feedback") {
        const p=value.operator;
        if(value.schema!=="sitrec-los-error-model" || value.version!==1 || value.basis!=="local-up-cross-clean-los"
            || !finite(value.sampleRateHz,.01,1000) || !finite(value.simulationRateHz,10,1000)
            || value.simulationRateHz<value.sampleRateHz || !pair(value.meanDeg,-90,90)
            || !pair(value.axisScale,0,10) || !pair(value.jitterSigmaDeg,0,90)
            || !finite(value.axisCorrelation,-1,1) || !finite(value.trackingDelaySeconds,0,2)
            || !p || !finite(p.amplitude,0,90) || !finite(p.driftSpeed,0,900)
            || !finite(p.reactionTime,0,5) || !finite(p.correctionSpeed,0,900) || !finite(p.accuracy,0,1)) {
            throw new Error("Invalid operator feedback model.");
        }
        return {schema:value.schema,version:1,basis:value.basis,modelType:"operator-feedback",
            sampleRateHz:value.sampleRateHz,simulationRateHz:value.simulationRateHz,meanDeg:[...value.meanDeg],
            axisScale:[...value.axisScale],axisCorrelation:value.axisCorrelation,jitterSigmaDeg:[...value.jitterSigmaDeg],
            trackingDelaySeconds:value.trackingDelaySeconds,
            operator:{amplitude:p.amplitude,driftSpeed:p.driftSpeed,reactionTime:p.reactionTime,
                correctionSpeed:p.correctionSpeed,accuracy:p.accuracy}};
    }
    if(value?.schema!=="sitrec-los-error-model" || value.version!==1 || value.basis!=="local-up-cross-clean-los"
        || !finite(value.sampleRateHz,.01,1000) || !pair(value.meanDeg,-90,90)
        || !pair(value.innovationSigmaDeg,0,90) || !finite(value.innovationCorrelation,-1,1)
        || !Array.isArray(value.reflection) || value.reflection.length!==2
        || !value.reflection.every(a=>Array.isArray(a)&&a.length<=20&&a.every(x=>finite(x,-.98,.98)))
        || value.innovationDistribution!=="gaussian") throw new Error("Invalid or unsupported LOS noise model.");
    return {schema:value.schema,version:1,basis:value.basis,sampleRateHz:value.sampleRateHz,
        meanDeg:[...value.meanDeg],reflection:value.reflection.map(a=>[...a]),
        innovationSigmaDeg:[...value.innovationSigmaDeg],innovationCorrelation:value.innovationCorrelation,
        innovationDistribution:"gaussian"};
}

export const serializeErrorModel = model => JSON.stringify(validateErrorModel(model),null,2)+"\n";

// Seeded PRNG is only for NEW realizations. No source seed is inferred or retained.
function seedNumber(seed) {
    let state=2166136261;
    for(const c of String(seed)) state=Math.imul(state^c.charCodeAt(0),16777619);
    return state>>>0;
}
function normalRandom(seed) {
    let state=seedNumber(seed);
    const uniform=()=>{state+=0x6D2B79F5;let t=Math.imul(state^(state>>>15),1|state);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
    return ()=>Math.sqrt(-2*Math.log(Math.max(1e-15,uniform())))*Math.cos(2*Math.PI*uniform());
}

/** Generate at the fitted internal cadence, then sample this SAME realization
 * at requested times. Never redraw per output frame when downsampling. */
export function generateErrors(inputModel, times, seed, geometry=null) {
    const model=validateErrorModel(inputModel);
    if(!times.length || times.some((t,i)=>!Number.isFinite(t)||(i>0&&t<=times[i-1]))) throw new Error("Generation times must increase.");
    const outCadence=times.length>1 ? cadence(times.map(t=>({t}))) : null;
    if(outCadence?.hz>model.sampleRateHz*1.01) throw new Error("This model cannot synthesize a higher recording rate than its calibration rate.");
    if(model.modelType==="operator-feedback") {
        const hz=model.simulationRateHz,burn=Math.ceil(60*hz),n=Math.round((times.at(-1)-times[0])*hz)+1;
        if(n+burn>5e6) throw new Error("Requested operator realization is too large.");
        const offsets=generateWobbleOffsets({...model.operator,minCorrectionSpeed:0,seed:seedNumber(seed)},n+burn,hz);
        const jitter=normalRandom(`${seed}:jitter`),rho=model.axisCorrelation,other=Math.sqrt(Math.max(0,1-rho*rho));
        const lag=trackingDelayErrors(geometry,times,model.trackingDelaySeconds);
        // Jitter is drawn on the internal grid too, so decimation of the same
        // seed preserves the SAME realization rather than redrawing at 1 Hz.
        const output=[];let at=-1,e;
        for(let i=0;i<times.length;i++) {
            const wanted=Math.round((times[i]-times[0])*hz);
            while(at<wanted) {
                at++;const w=offsets[burn+at];
                e=[w.pan*model.axisScale[0]+jitter()*model.jitterSigmaDeg[0],
                    (rho*w.pan+other*w.tilt)*model.axisScale[1]+jitter()*model.jitterSigmaDeg[1]];
            }
            output.push({t:times[i],e:e.map((v,a)=>v+model.meanDeg[a]+lag[i][a])});
        }
        return output;
    }
    const coeff=model.reflection.map(ks=>{
        let a=[];
        for(const k of ks) {const old=a;a=old.map((x,i)=>x-k*old[old.length-1-i]);a.push(k);}
        return a;
    });
    const history=coeff.map(a=>Array(a.length).fill(0)), random=normalRandom(seed);
    const rho=model.innovationCorrelation, other=Math.sqrt(Math.max(0,1-rho*rho));
    const step=()=>{
        const z=random(), z2=rho*z+other*random();
        return [z,z2].map((v,a)=>{
            let x=v*model.innovationSigmaDeg[a];
            coeff[a].forEach((c,i)=>x+=c*history[a][i]);
            if(history[a].length) {history[a].pop();history[a].unshift(x);}
            return x+model.meanDeg[a];
        });
    };
    // Burn in the stationary process. Discard all these values.
    const burn=Math.max(2000,Math.ceil(60*model.sampleRateHz));
    const lastIndex=Math.round((times.at(-1)-times[0])*model.sampleRateHz);
    if(lastIndex>5e6 || burn>1e6) throw new Error("Requested synthetic realization is too large.");
    for(let i=0;i<burn;i++) step();
    const out=[];let at=-1,e;
    for(const t of times) {
        const wanted=Math.round((t-times[0])*model.sampleRateHz);
        while(at<wanted) {e=step();at++;}
        out.push({t,e:[...e]});
    }
    return out;
}

/** Lag follows past world-space bearings, including platform motion. It is an
 * effective tracking delay; pointing alone cannot separate it from clock skew. */
export function trackingDelayErrors(geometry,times,seconds) {
    if(!seconds) return times.map(()=>[0,0]);
    if(!geometry || geometry.length!==times.length) throw new Error("A tracking-delay model needs synchronized platform and target geometry.");
    const clean=geometry.map(r=>unit(r.target.map((v,a)=>v-r.sensor[a])));
    let j=0;
    return geometry.map((r,i)=>{
        const wanted=times[i]-seconds;
        while(j+1<times.length && times[j+1]<=wanted) j++;
        const k=Math.min(j+1,times.length-1),fraction=Math.max(0,Math.min(1,(wanted-times[j])/(times[k]-times[j]||1)));
        const past=unit(clean[j].map((v,a)=>v+(clean[k][a]-v)*fraction));
        return angularResidual(r.sensor,r.target,past,r.up) ?? [0,0];
    });
}

export function estimateTrackingDelay(samples,geometry) {
    if(!geometry || samples.length!==geometry.length) return {seconds:0,explainedFraction:0};
    const dt=cadence(samples).dt,velocity=[],errors=[];
    for(let i=1;i<samples.length;i++) {
        const delta=samples[i].t-samples[i-1].t;
        if(delta>1.5*dt) continue;
        const previous=unit(geometry[i-1].target.map((v,a)=>v-geometry[i-1].sensor[a]));
        const e=angularResidual(geometry[i].sensor,geometry[i].target,previous,geometry[i].up);
        if(e) {velocity.push(e.map(x=>x/delta));errors.push(samples[i].e);}
    }
    if(velocity.length<20) return {seconds:0,explainedFraction:0};
    const vm=[0,1].map(a=>velocity.reduce((s,v)=>s+v[a],0)/velocity.length);
    const em=[0,1].map(a=>errors.reduce((s,v)=>s+v[a],0)/errors.length);
    let vv=0,ve=0,ee=0;
    velocity.forEach((v,i)=>v.forEach((x,a)=>{vv+=(x-vm[a])**2;ve+=(x-vm[a])*(errors[i][a]-em[a]);ee+=(errors[i][a]-em[a])**2;}));
    const seconds=vv>1e-12 ? Math.max(0,Math.min(2,ve/vv)) : 0;
    const explainedFraction=ee>1e-20 ? Math.max(0,(2*seconds*ve-seconds*seconds*vv)/ee) : 0;
    // Require varying angular motion and useful explanatory power. With almost
    // constant target angular velocity, lag and a fixed bias are inseparable.
    return {seconds:explainedFraction>=.1 ? seconds : 0,explainedFraction};
}

/** Fit aggregate statistics over an ensemble of fixed, independent simulation
 * seeds. No measured residuals are replayed and no source seed is recovered.
 * Parameters are a descriptive feedback analogue, not uniquely identified
 * human reaction times. Yield periodically so the panel remains cancellable. */
export async function fitOperatorErrorModel(samples,geometry=null,{onProgress=()=>{},cancelled=()=>false}={}) {
    if(samples.length<20) throw new Error("Need at least 20 valid samples to estimate operator error.");
    const source=summarizeErrors(samples),delay=estimateTrackingDelay(samples,geometry);
    const lag=trackingDelayErrors(geometry,samples.map(r=>r.t),delay.seconds);
    const residual=samples.map((r,i)=>({t:r.t,e:r.e.map((x,a)=>x-lag[i][a])}));
    const summary=summarizeErrors(residual),hz=source.hz;
    // Limit calibration duration, retaining a contiguous prefix; the report
    // still evaluates fresh realizations over the whole selected A–B window.
    const window=residual.filter(r=>r.t-residual[0].t<=90),times=window.map(r=>r.t);
    const target=summarizeErrors(window),sigma=summary.sigma;
    const prototype={schema:"sitrec-los-error-model",version:1,basis:"local-up-cross-clean-los",modelType:"operator-feedback",
        sampleRateHz:hz,simulationRateHz:Math.max(10,hz),meanDeg:summary.mean,
        axisScale:sigma.map(x=>summary.centeredRms>1e-12 ? Math.SQRT2*x/summary.centeredRms : 1),
        axisCorrelation:summary.axisCorrelation ?? 0,jitterSigmaDeg:[0,0],trackingDelaySeconds:delay.seconds,
        operator:{amplitude:0,driftSpeed:0,reactionTime:.4,correctionSpeed:0,accuracy:.8}};
    if(summary.centeredRms<1e-10) return {model:validateErrorModel(prototype),score:0,delay,candidates:0};
    // Independent per-frame jitter floor from second differences (white noise
    // has variance 6*sigma^2 here). Feedback curvature may also contribute.
    const second=[];
    for(let i=2;i<window.length;i++) if(window[i].t-window[i-2].t<target.dt*2.25) second.push(window[i].e.map((x,a)=>x-2*window[i-1].e[a]+window[i-2].e[a]));
    const floor=[0,1].map(a=>Math.min(sigma[a],Math.sqrt(second.reduce((s,v)=>s+v[a]**2,0)/Math.max(1,second.length)/6)));
    const lagOne=target.acf.find(r=>Math.abs(r.seconds-target.dt)<target.dt*.01)?.axes ?? [null,null];
    if(lagOne.every(x=>x!==null && Math.abs(x)<.12)) {
        prototype.jitterSigmaDeg=sigma;
        return {model:validateErrorModel(prototype),score:0,delay,candidates:0};
    }
    const candidates=[];
    for(const drift of [.3,.7,1.5]) for(const correction of [2,6,12]) for(const reaction of [.15,.4,.8]) for(const accuracy of [.5,.8]) {
        candidates.push({amplitude:1,driftSpeed:drift,reactionTime:reaction,correctionSpeed:correction,accuracy});
    }
    const ratioLoss=(a,b)=>Math.log(Math.max(a,1e-8)/Math.max(b,1e-8))**2;
    let best=null;
    for(let c=0;c<candidates.length;c++) {
        if(cancelled()) throw new Error("Operator fit cancelled.");
        const p=candidates[c],trial={...prototype,meanDeg:[0,0],trackingDelaySeconds:0,operator:p};
        const ensemble=[0,1].map(seed=>generateErrors(trial,times,`operator-calibration-${seed}`));
        const rms=Math.sqrt(ensemble.reduce((s,rows)=>s+summarizeErrors(rows).centeredRms**2,0)/2);
        const amplitude=Math.sqrt(Math.max(0,target.centeredRms**2-dot(floor,floor)))/Math.max(rms,1e-12);
        const scaled=ensemble.map((rows,seed)=>{
            const jitter=normalRandom(`operator-floor-${seed}`);
            return rows.map(r=>({t:r.t,e:r.e.map((x,a)=>x*amplitude+floor[a]*jitter())}));
        }).map(summarizeErrors);
        let score=0;
        for(const s of scaled) {
            score+=ratioLoss(s.centeredP95/Math.max(s.centeredRms,1e-12),target.centeredP95/target.centeredRms);
            if(target.incrementRms) score+=ratioLoss(s.incrementRms,target.incrementRms);
            for(const ac of target.acf.filter(r=>r.seconds<=5)) {
                const predicted=s.acf.find(r=>Math.abs(r.seconds-ac.seconds)<target.dt*.01);
                if(predicted) for(let a=0;a<2;a++) if(ac.axes[a]!==null && predicted.axes[a]!==null) score+=(predicted.axes[a]-ac.axes[a])**2;
            }
        }
        if(!best || score<best.score) best={score,model:{...prototype,jitterSigmaDeg:floor,
            operator:{...p,amplitude,driftSpeed:p.driftSpeed*amplitude,correctionSpeed:p.correctionSpeed*amplitude}}};
        if(c%6===0) {onProgress(c+1,candidates.length);await new Promise(resolve=>setTimeout(resolve,0));}
    }
    return {model:validateErrorModel(best.model),score:best.score/2,delay,candidates:candidates.length};
}
