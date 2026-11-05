import {atArrival, closestApproaches, observerTrack, prepareTrack, toECEF} from "./DopplerModel";
import {traceFamily, traceHarmonic, validTraceFamily, validTraceHarmonic} from "./DopplerTrace";

// A reference is supplied evidence, not a search result. Only one emitted
// frequency per tone family is fitted; observer position and UTC start remain fixed.
export function diagnoseDopplerReference({settings, events, tracks}) {
    const s=settings;
    if(!s || ![s.recordingStart,s.lat,s.lon,s.altitudeM,s.soundSpeed,s.maxGap].every(Number.isFinite) ||
        Math.abs(s.lat)>90 || Math.abs(s.lon)>180 || s.soundSpeed<280 || s.soundSpeed>380 || s.maxGap<=0) {
        throw new Error("Reference diagnostics require a known recording start in UTC seconds, finite observer coordinates/altitude, sound speed and maximum fix gap.");
    }
    const tolerance=s.cpaTolerance ?? 8;
    if(!Number.isFinite(tolerance) || tolerance<0) throw new Error("Check the reference CPA tolerance.");
    if(!Array.isArray(events) || !events.length || events.length>4 || !Array.isArray(tracks)) {
        throw new Error("Reference diagnostics require one to four traced events and a track array.");
    }
    for(const [index,e] of events.entries()) {
        if(!e || ![e.start,e.end,e.cpa,e.frequency,e.frequencyTolerance,e.speedMin,e.speedMax,e.rangeMin,e.rangeMax].every(Number.isFinite) ||
            e.start<0 || e.end<=e.start || e.cpa<e.start || e.cpa>e.end || e.frequency<=0 || e.frequencyTolerance<0 || e.frequencyTolerance>=e.frequency ||
            e.speedMin<0 || e.speedMax<e.speedMin || e.rangeMin<0 || e.rangeMax<e.rangeMin ||
            (e.family!==undefined && !validTraceFamily(e.family)) ||
            !Array.isArray(e.trace) || !e.trace.length || e.trace.some(p=>!p || !Number.isFinite(p.time) || !Number.isFinite(p.frequency) ||
                p.time<e.start || p.time>e.end || p.frequency<=0 || !validTraceHarmonic(traceHarmonic({...e,harmonic:e.harmonic ?? 1},p)) || !validTraceFamily(traceFamily(p)))) {
            throw new Error(`Check reference event ${index+1}'s narrow trace and explanatory bounds.`);
        }
    }
    const observer=toECEF(s.lat,s.lon,s.altitudeM);
    const prepared=tracks.map((track,index)=>{
        const identity={id:String(track?.id ?? ""),callsign:track?.callsign ?? "",registration:track?.registration ?? "",aircraftType:track?.aircraftType ?? ""};
        try {
            const view=observerTrack(prepareTrack(track,s.soundSpeed,s.maxGap),observer,s.soundSpeed);
            return {track,identity,index,view,approaches:closestApproaches(view,s.soundSpeed)};
        } catch(error) {return {track,identity,index,error:error.message};}
    });
    return {
        reference:{recordingStart:s.recordingStart,lat:s.lat,lon:s.lon,altitudeM:s.altitudeM,soundSpeed:s.soundSpeed,maxGap:s.maxGap},
        purpose:"Fixed-reference narrow-trace diagnostic; no source identification or location/clock optimization",
        optimizedParameters:["one emitted frequency per tone family of each event"],
        events:events.map((e,eventIndex)=>{
            const rows=prepared.map(item=>diagnoseEvent(item,e,s,tolerance));
            // Never promote incomplete coverage through an artificially small
            // residual. Unranked rows retain original input order after fits.
            rows.sort((a,b)=>a.complete && b.complete ? a.rmsHz-b.rmsHz || a.trackIndex-b.trackIndex :
                a.complete ? -1 : b.complete ? 1 : a.trackIndex-b.trackIndex);
            return {eventIndex,name:e.name ?? `Event ${eventIndex+1}`,rows};
        }),
    };
}

function diagnoseEvent(item,e,s,tolerance) {
    const base={id:item.identity.id,identity:item.identity,trackIndex:item.index,complete:false,
        rmsHz:null,partialRmsHz:null,frequency:null,gatePass:null,checks:null,reasons:[],navigationFallback:0,inferredNavigation:0,approximateNavigation:0};
    const harmonic=p=>traceHarmonic({...e,harmonic:e.harmonic ?? 1},p);
    const observations=e.trace.map(p=>({time:p.time,arrivalTime:s.recordingStart+p.time,observedHz:p.frequency,harmonic:harmonic(p),family:traceFamily(p)}));
    if(item.error) return {...base,status:"unusable_track",error:item.error,cpaActual:null,
        missingCoverage:observations.length,predictions:observations.map(p=>({...p,status:"unusable_track",predictedHz:null,sourceHz:null,sourceFundamentalHz:null,emissionTime:null}))};
    const predictions=observations.map(p=>{
        const sample=atArrival(item.view,p.arrivalTime,s.soundSpeed);
        if(!sample || !Number.isFinite(sample.factor) || sample.factor<=0) return {...p,status:"missing_track_coverage",
            predictedHz:null,sourceHz:null,sourceFundamentalHz:null,emissionTime:null};
        const segment=item.view.segments.find(segment=>sample.emissionTime>=segment.t0-1e-6 && sample.emissionTime<=segment.t1+1e-6);
        const navigationVelocity=Boolean(segment?.v0 && segment?.v1);
        const velocitySource=segment?.velocitySource ?? (navigationVelocity ? "reported_navigation" : "position_derived");
        const navigationApproximate=segment?.navigation?.approximate ?? !navigationVelocity;
        const endpoints=item.track.points.filter(fix=>fix.time===segment?.t0 || fix.time===segment?.t1);
        return {...p,status:"available",factor:sample.factor,emissionTime:sample.emissionTime,rangeM:sample.range,
            sourceHz:p.observedHz/sample.factor,sourceFundamentalHz:p.observedHz/(sample.factor*p.harmonic),
            navigationVelocity,velocitySource,navigationApproximate,
            verticalRateAssumedZero:navigationVelocity && (segment?.navigation ? segment.navigation.verticalSources.includes("assumed_zero") : endpoints.some(fix=>!Number.isFinite(fix.verticalSpeedMS))),
            verticalRateFromPositions:navigationVelocity && Boolean(segment?.navigation?.verticalSources.includes("position_derived")),
            approximateAltitude:endpoints.some(fix=>fix.approximateAltitude===true)};
    });
    const available=predictions.filter(p=>p.status==="available");
    const cpa=item.approaches.reduce((best,p)=>!best || Math.abs(p.arrival-s.recordingStart-e.cpa)<Math.abs(best.arrival-s.recordingStart-e.cpa) ? p : best,null);
    const cpaActual=cpa ? {emissionTime:cpa.time,arrivalTime:cpa.arrival,audioTime:cpa.arrival-s.recordingStart,rangeM:cpa.range,speedMS:cpa.speed,
        selection:"Local approach closest in arrival time to the expected event CPA; no time adjustment"} : null;
    const checks=cpa ? {
        speed:{actual:cpa.speed,min:e.speedMin,max:e.speedMax,pass:cpa.speed>=e.speedMin && cpa.speed<=e.speedMax},
        slantRange:{actual:cpa.range,min:e.rangeMin,max:e.rangeMax,pass:cpa.range>=e.rangeMin && cpa.range<=e.rangeMax},
        cpa:{actual:cpa.arrival-s.recordingStart,expected:e.cpa,deltaSeconds:cpa.arrival-s.recordingStart-e.cpa,toleranceSeconds:tolerance,
            pass:Math.abs(cpa.arrival-s.recordingStart-e.cpa)<=tolerance},
    } : null;
    const reasons=checks ? Object.entries(checks).filter(([,check])=>!check.pass).map(([key])=>`${key}_outside_bounds`) : ["no_usable_closest_approach"];
    const result={...base,status:available.length===predictions.length ? "complete" : "missing_track_coverage",predictions,cpaActual,checks,reasons,
        gatePass:checks ? reasons.length===0 : null,missingCoverage:predictions.length-available.length,
        navigationFallback:available.filter(p=>!p.navigationVelocity).length,
        inferredNavigation:available.filter(p=>p.velocitySource==="reported_speed_derived_direction").length,
        approximateNavigation:available.filter(p=>p.navigationApproximate).length,
        verticalRateAssumedZero:available.filter(p=>p.verticalRateAssumedZero).length};
    if(!available.length) return result;
    const lower=e.frequency-e.frequencyTolerance,upper=e.frequency+e.frequencyTolerance,fitted=[];
    for(const family of [...new Set(available.map(p=>p.family))].sort((a,b)=>a-b)) {
        let numerator=0,denominator=0;
        for(const p of available) if(p.family===family) {const k=p.factor*p.harmonic;numerator+=k*p.observedHz;denominator+=k*k;}
        const unconstrained=numerator/denominator;
        if(!Number.isFinite(unconstrained) || unconstrained<=0) return {...result,status:"nonfinite_frequency_fit"};
        // As in the search, only the main family is held to the event's sweep.
        fitted.push({family,frequency:family===0 ? Math.max(lower,Math.min(upper,unconstrained)) : unconstrained,frequencyUnconstrained:unconstrained});
    }
    for(const p of available) {const fit=fitted.find(f=>f.family===p.family);p.predictedHz=fit.frequency*p.factor*p.harmonic;p.residualHz=p.observedHz-p.predictedHz;}
    const rms=Math.sqrt(available.reduce((sum,p)=>sum+p.residualHz**2,0)/available.length);
    const complete=result.missingCoverage===0 && Number.isFinite(rms);
    return {...result,complete,frequency:fitted[0].frequency,frequencyUnconstrained:fitted[0].frequencyUnconstrained,frequencyBounds:[lower,upper],
        frequencyBounded:fitted.some(f=>f.frequency!==f.frequencyUnconstrained),
        ...(fitted.length>1 ? {families:fitted.map(({family,frequency})=>({family,frequency}))} : {}),
        rmsHz:complete ? rms : null,partialRmsHz:complete ? null : rms};
}
