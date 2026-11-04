import {atArrival, closestApproaches, observerTrack, prepareTrack, toECEF} from "./DopplerModel";
import {hasTaggedTrace,traceFamily,traceHarmonic,validTraceFamily,validTraceHarmonic} from "./DopplerTrace";

export const SEARCH_DEFAULTS={lat:37,lon:-122,radiusM:3000,spacingM:200,altitudeM:0,soundSpeed:343,
    maxGap:30,timeTolerance:3,timeStep:0.5,cpaTolerance:8,frequencySteps:9,traceSigma:1,
    recordingStart:"",elevation:"fixed",source:"tracks",mode:"trace",silenceRadiusM:0,silence:[]};
export const newEvent=(cpa=60)=>({cpa,start:cpa-30,end:cpa+30,frequency:130,frequencyTolerance:3,
    harmonic:1,family:0,speedMin:0,speedMax:300,rangeMin:0,rangeMax:20000,trace:[]});

export function makeGrid(settings) {
    const {lat,lon,radiusM,spacingM,altitudeM}=settings;
    if (![lat,lon,radiusM,spacingM,altitudeM].every(Number.isFinite) || Math.abs(lat)>85 || Math.abs(lon)>180 ||
        radiusM<spacingM || spacingM<10 || radiusM>100000) throw new Error("Use a radius between one grid step and 100 km, a step of at least 10 m, and a latitude between −85° and 85°.");
    const n=Math.floor(radiusM/spacingM);
    if((2*n+1)**2>65000) throw new Error("This grid is too large. Increase the step or reduce the radius (limit 50,000 points).");
    const points=[];
    for(let y=-n;y<=n;y++) for(let x=-n;x<=n;x++) {
        if(Math.hypot(x,y)*spacingM>radiusM) continue;
        const p=lat+y*spacingM/111320;
        let l=lon+x*spacingM/(111320*Math.cos(lat*Math.PI/180));
        l=((l+540)%360)-180;
        if(Math.abs(p)>85) throw new Error("The search grid extends beyond latitude 85°.");
        points.push({lat:p,lon:l,altitudeM});
    }
    if(points.length>50000) throw new Error("Limit the grid to 50,000 points.");
    return points;
}

export function validateSearch({settings:s,events,tracks,spectrogram}) {
    makeGrid(s);
    if (!Array.isArray(tracks) || !tracks.length) throw new Error("Import flight tracks first.");
    if(!events?.length || events.length>4) throw new Error("Use one to four flyover events.");
    if(s.recordingStart !== null && !Number.isFinite(s.recordingStart)) throw new Error("Recording start must be UTC seconds.");
    if(s.recordingStart === null && events.length<2) throw new Error("An unknown recording time needs at least two flyovers. Enter the recording start UTC for a single event.");
    if (![s.soundSpeed,s.maxGap,s.timeTolerance,s.timeStep,s.cpaTolerance,s.traceSigma,s.frequencySteps,s.silenceRadiusM].every(Number.isFinite) ||
        s.soundSpeed<280 || s.soundSpeed>380 || s.maxGap<=0 || s.timeTolerance<0 || s.timeTolerance>120 || s.timeStep<0.1 ||
        s.cpaTolerance<0 || s.traceSigma<=0 || s.frequencySteps<1 || s.frequencySteps>41 || s.silenceRadiusM<0) throw new Error("Invalid sound speed, time sweep, frequency sweep, gap or scoring settings.");
    if(!["trace","brightness"].includes(s.mode)) throw new Error("Choose trace or spectrogram scoring.");
    if(s.mode==="brightness" && !spectrogram) throw new Error("Load audio for spectrogram scoring.");
    if(!Array.isArray(s.silence) || s.silence.some(w=>w.length!==2 || !w.every(Number.isFinite) || w[0]>=w[1])) throw new Error("Silence windows must be [start, end] in recording seconds.");
    for(const [i,e] of events.entries()) {
        if(![e.cpa,e.start,e.end,e.frequency,e.frequencyTolerance,e.harmonic,e.speedMin,e.speedMax,e.rangeMin,e.rangeMax].every(Number.isFinite) ||
            e.start<0 || e.start>=e.end || e.cpa<e.start || e.cpa>e.end || e.frequency<=0 || e.frequencyTolerance<0 ||
            e.frequencyTolerance>=e.frequency || !Number.isInteger(e.harmonic) || e.harmonic<1 || e.harmonic>16 ||
            e.speedMin<0 || e.speedMin>e.speedMax || e.rangeMin<0 || e.rangeMin>e.rangeMax) throw new Error(`Check event ${i+1}'s time, frequency, speed and slant range bounds.`);
        const usesTrace=s.mode==="trace" || hasTaggedTrace(e);
        if(e.family!==undefined && !validTraceFamily(e.family)) throw new Error(`Check event ${i+1}'s tone family (0 to 7).`);
        if(usesTrace && (!Array.isArray(e.trace) || e.trace.some(p=>!p || !Number.isFinite(p.time) || !Number.isFinite(p.frequency) || p.time<e.start || p.time>e.end || p.frequency<=0 || !validTraceHarmonic(traceHarmonic(e,p)) || !validTraceFamily(traceFamily(p))))) throw new Error(`Check event ${i+1}'s narrow-ridge points, harmonic numbers and tone families.`);
        if(usesTrace && e.trace.length<4) throw new Error(`Trace at least four points inside event ${i+1}'s window.`);
        if(s.mode==="brightness") {
            const first=spectrogram.start,last=first+(spectrogram.columns-1)*spectrogram.hop;
            if(usesTrace ? e.trace.some(p=>p.time<first||p.time>last) : e.start<first||e.end>last) throw new Error(`Event ${i+1} extends outside the spectrogram's time coverage.`);
        }
    }
}

export function sampleSpectrogram(spec,time,frequency) {
    const x=(time-spec.start)/spec.hop, y=frequency/spec.binHz;
    if(x<0 || y<0 || x>spec.columns-1 || y>spec.bins-1) return null;
    const x0=Math.floor(x), y0=Math.floor(y), x1=Math.min(x0+1,spec.columns-1), y1=Math.min(y0+1,spec.bins-1);
    const a=spec.values[x0*spec.bins+y0]*(1-(y-y0))+spec.values[x0*spec.bins+y1]*(y-y0);
    const b=spec.values[x1*spec.bins+y0]*(1-(y-y0))+spec.values[x1*spec.bins+y1]*(y-y0);
    return a*(1-(x-x0))+b*(x-x0);
}

function scoreBrightness(samples,factors,e,s,spec,lower,upper) {
    const rows=[];
    let maxScale=0;
    for(let i=0;i<samples.length;i++) {
        const x=(samples[i].time-spec.start)/spec.hop,scale=factors[i]*traceHarmonic(e,samples[i])/spec.binHz;
        if(x<0 || x>spec.columns-1 || scale<=0) return null;
        const x0=Math.floor(x);
        rows.push({a:x0*spec.bins,b:Math.min(x0+1,spec.columns-1)*spec.bins,mix:x-x0,scale});
        maxScale=Math.max(maxScale,scale);
        upper=Math.min(upper,(spec.bins-1)/scale);
    }
    if(upper<lower) return null;
    // Cover the entire band: no trial may jump over half a spectral bin at
    // any sampled time or harmonic. frequencySteps remains a minimum density.
    const count=upper===lower ? 1 : Math.max(Math.floor(s.frequencySteps),Math.ceil(2*(upper-lower)*maxScale)+1);
    let best=null;
    for(let j=0;j<count;j++) {
        const frequency=count===1 ? lower : lower+(upper-lower)*j/(count-1);
        let sum=0,valid=true;
        for(const row of rows) {
            const y=frequency*row.scale;
            if(y<0 || y>spec.bins-1) {valid=false;break;}
            const y0=Math.floor(y),y1=Math.min(y0+1,spec.bins-1),mix=y-y0;
            const a=spec.values[row.a+y0]*(1-mix)+spec.values[row.a+y1]*mix;
            const b=spec.values[row.b+y0]*(1-mix)+spec.values[row.b+y1]*mix;
            sum+=a*(1-row.mix)+b*row.mix;
        }
        const score=sum/rows.length;
        if(valid && (!best || score>best.score)) best={frequency,score};
    }
    return best;
}

function scoreEvent(track,e,recordingStart,s,spec) {
    const countSamples=spec ? Math.min(200,Math.max(8,Math.ceil((e.end-e.start)/spec.hop))) : 0;
    // Explicitly tagged narrow traces also restrict brightness scoring to the
    // marked times/harmonics. Missing segments are not invented or interpolated.
    // Untagged saved analyses retain their original whole-window brightness score.
    const samples=s.mode==="trace" || hasTaggedTrace(e) ? e.trace : Array.from({length:countSamples},(_,i)=>({time:e.start+(e.end-e.start)*i/(countSamples-1)}));
    if(!samples.length) return null;
    const factors=samples.map(p=>atArrival(track,recordingStart+p.time,s.soundSpeed,true));
    if(factors.some(v=>!Number.isFinite(v))) return null;
    const lower=e.frequency-e.frequencyTolerance, upper=e.frequency+e.frequencyTolerance;
    // Each tone family fits its own emitted fundamental analytically. Geometry,
    // clock and harmonic numbers stay shared, so a family cannot drift on its own.
    const groups=new Map();
    samples.forEach((p,i)=>{const family=traceFamily(p);if(!groups.has(family)) groups.set(family,[]);groups.get(family).push(i);});
    const ordered=[...groups.keys()].sort((a,b)=>a-b);
    if(s.mode==="trace") {
        const frequencies=new Map();
        for(const family of ordered) {
            let numerator=0, denominator=0;
            for(const i of groups.get(family)) {const k=factors[i]*traceHarmonic(e,samples[i]); numerator+=k*samples[i].frequency;denominator+=k*k;}
            frequencies.set(family,Math.max(lower,Math.min(upper,numerator/denominator)));
        }
        const mse=samples.reduce((sum,p,i)=>sum+((p.frequency-frequencies.get(traceFamily(p))*factors[i]*traceHarmonic(e,p))/s.traceSigma)**2,0)/samples.length;
        const result={frequency:frequencies.get(ordered[0]),score:-mse,rmsHz:Math.sqrt(mse)*s.traceSigma};
        if(ordered.length>1) result.families=ordered.map(family=>({family,frequency:frequencies.get(family)}));
        return result;
    }
    if(ordered.length===1) return scoreBrightness(samples,factors,e,s,spec,lower,upper);
    let total=0;
    const families=[];
    for(const family of ordered) {
        const indices=groups.get(family),best=scoreBrightness(indices.map(i=>samples[i]),indices.map(i=>factors[i]),e,s,spec,lower,upper);
        if(!best) return null;
        total+=best.score*indices.length;families.push({family,frequency:best.frequency});
    }
    return {frequency:families[0].frequency,score:total/samples.length,families};
}

// All events share recordingStart. Only the emitted fundamental is fitted
// separately, so a mismatched inter-flight delay cannot be hidden by alignment.
export function scoreCombination(pair,events,s,spec,approaches=[]) {
    const base=s.recordingStart ?? pair[0].cpa.arrival-events[0].cpa;
    const silenceRadius=s.silenceRadiusM || Math.max(...pair.map(p=>p.cpa.range));
    let best=null;
    const count=Math.ceil(2*s.timeTolerance/s.timeStep);
    const shiftAt=i=>count ? -s.timeTolerance+2*s.timeTolerance*i/count : 0;
    let first=0,last=count;
    // The CPA residual decreases with the clock index. Clip the original grid,
    // using the same arithmetic as its gate to preserve floating-point edges.
    for(let j=0;j<pair.length && first<=last;j++) {
        const residual=i=>pair[j].cpa.arrival-(base+shiftAt(i))-events[j].cpa;
        if(residual(first)>s.cpaTolerance) {
            let lo=first,hi=last+1;
            while(lo<hi) {const mid=Math.floor((lo+hi)/2);if(residual(mid)>s.cpaTolerance) lo=mid+1;else hi=mid;}
            first=lo;
        }
        if(first>last) return null;
        if(residual(last)<-s.cpaTolerance) {
            let lo=first,hi=last+1;
            while(lo<hi) {const mid=Math.floor((lo+hi)/2);if(residual(mid)>=-s.cpaTolerance) lo=mid+1;else hi=mid;}
            last=lo-1;
        }
    }
    for(let i=first;i<=last;i++) {
        const shift=shiftAt(i);
        const recordingStart=base+shift;
        if(pair.some((p,j)=>Math.abs(p.cpa.arrival-recordingStart-events[j].cpa)>s.cpaTolerance)) continue;
        if(s.silence.some(([a,b])=>approaches.some(p=>p.cpa.range<silenceRadius && p.cpa.arrival>recordingStart+a && p.cpa.arrival<recordingStart+b))) continue;
        const scored=pair.map((p,j)=>scoreEvent(p.track,events[j],recordingStart,s,spec));
        if(scored.some(v=>!v)) continue;
        const score=scored.reduce((a,b)=>a+b.score,0)/scored.length;
        if(!best || score>best.score) best={score,recordingStart,events:scored.map((v,j)=>({...v,
            flight:pair[j].track.id,cpaArrival:pair[j].cpa.arrival,rangeM:pair[j].cpa.range,speedMS:pair[j].cpa.speed}))};
    }
    return best;
}

export async function searchLocations(input,{progress=()=>{},cancelled=()=>false}={}) {
    validateSearch(input);
    const {settings:s,events,spectrogram}=input;
    const tracks=input.tracks.map(t=>prepareTrack(t,s.soundSpeed,s.maxGap));
    if(new Set(tracks.map(t=>t.id)).size!==tracks.length) throw new Error("Flight IDs must be unique.");
    const grid=input.grid ?? makeGrid(s);
    if(!grid.length || grid.length>50000 || grid.some(p=>![p.lat,p.lon,p.altitudeM].every(Number.isFinite))) throw new Error("Invalid search grid or terrain heights.");
    const results=[], heat=[], stats={points:grid.length,combinations:0,passed:0};
    let evaluations=0;
    for(let index=0;index<grid.length;index++) {
        if(cancelled()) return {cancelled:true,results:[],heat:[],stats};
        const point=grid[index], observer=toECEF(point.lat,point.lon,point.altitudeM);
        const approaches=[];
        for(const track of tracks) {
            const view=observerTrack(track,observer,s.soundSpeed);
            for(const cpa of closestApproaches(view,s.soundSpeed)) approaches.push({track:view,cpa});
        }
        const candidates=events.map(e=>approaches.filter(p=>p.cpa.speed>=e.speedMin && p.cpa.speed<=e.speedMax && p.cpa.range>=e.rangeMin && p.cpa.range<=e.rangeMax));
        let best=null;
        const visit=async pair=>{
            if(pair.length===events.length) {
                stats.combinations++;
                if(++evaluations>2000000) throw new Error("Over two million flight combinations. Tighten speed, range, time or geographic bounds.");
                const scored=scoreCombination(pair,events,s,spectrogram,approaches);
                if(scored && (!best || scored.score>best.score)) best=scored;
                if(evaluations%256===0) {await new Promise(resolve=>setTimeout(resolve,0));}
                return;
            }
            const n=pair.length;
            for(const p of candidates[n]) {
                if(cancelled()) return;
                if(pair.some(q=>q.track.id===p.track.id && q.cpa.time===p.cpa.time)) continue;
                const base=s.recordingStart ?? (pair[0] ?? p).cpa.arrival-events[0].cpa;
                if(Math.abs(p.cpa.arrival-base-events[n].cpa)>s.cpaTolerance+s.timeTolerance) continue;
                await visit([...pair,p]);
            }
        };
        await visit([]);
        if(best) {
            stats.passed++;
            const result={...point,...best};
            heat.push({lat:point.lat,lon:point.lon,score:best.score});
            results.push(result);results.sort((a,b)=>b.score-a.score);
            if(results.length>100) results.length=100;
        }
        if(index%16===0 || index===grid.length-1) {
            progress({done:index+1,total:grid.length,...stats});
            await new Promise(resolve=>setTimeout(resolve,0));
        }
    }
    return {results,heat,stats};
}
