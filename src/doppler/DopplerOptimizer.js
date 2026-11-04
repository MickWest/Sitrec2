import {nearestApproach,observerTrack,prepareTrack,toECEF} from "./DopplerModel";
import {scoreCombination} from "./DopplerSearch";

// Small bounded simplex search. Moving continuously within a coarse cell avoids
// discarding a true match merely because a narrow Doppler ridge falls between
// coarse grid points. It also supports the spectrogram's non-smooth objective.
export async function maximizeBounded(evaluate,{initial,steps,bounds,maxIterations=100,tolerance=5}={}) {
    const active=bounds.map((b,i)=>b[1]>b[0] ? i : -1).filter(i=>i>=0);
    let evaluations=0;
    const trial=async x=>{
        x=x.map((v,i)=>Math.max(bounds[i][0],Math.min(bounds[i][1],v)));
        const value=await evaluate(x);evaluations++;
        return {x,value,score:Number.isFinite(value?.score) ? value.score : -1e30};
    };
    const vertices=[await trial(initial)];
    for(const i of active) {const x=[...initial];x[i]+=steps[i];if(x[i]>bounds[i][1]) x[i]=initial[i]-steps[i];vertices.push(await trial(x));}
    let iteration=0;
    for(;iteration<maxIterations && active.length;iteration++) {
        vertices.sort((a,b)=>b.score-a.score);
        if(vertices.slice(1).every(v=>Math.hypot(...v.x.map((x,i)=>x-vertices[0].x[i]))<tolerance)) break;
        const n=active.length,best=vertices[0],worst=vertices[n];
        const centre=initial.map((_,i)=>vertices.slice(0,n).reduce((sum,v)=>sum+v.x[i],0)/n);
        const reflected=await trial(centre.map((x,i)=>x+(x-worst.x[i])));
        if(reflected.score>best.score) {
            const expanded=await trial(centre.map((x,i)=>x+2*(reflected.x[i]-x)));
            vertices[n]=expanded.score>reflected.score ? expanded : reflected;
        } else if(reflected.score>vertices[n-1].score) vertices[n]=reflected;
        else {
            const outside=reflected.score>worst.score,point=outside ? reflected : worst;
            const contracted=await trial(centre.map((x,i)=>x+0.5*(point.x[i]-x)));
            if(contracted.score>(outside ? reflected.score : worst.score)) vertices[n]=contracted;
            else for(let i=1;i<=n;i++) vertices[i]=await trial(best.x.map((x,j)=>x+0.5*(vertices[i].x[j]-x)));
        }
    }
    vertices.sort((a,b)=>b.score-a.score);
    return {...vertices[0],evaluations,iterations:iteration};
}

// A best fit on the edge of its box usually means the optimum lies outside. The
// box is then re-centred on that fit and the search repeats a bounded number
// of times, so a coarse seed a few kilometres off still reaches the optimum.
export async function refineDopplerLocation({candidate,tracks,events,settings:s,spectrogram,elevationAt,
    maxOffsetM=2000,stepM=500,maxIterations=100,recenter=2}) {
    const prepared=tracks.map(t=>prepareTrack(t,s.soundSpeed,s.maxGap));
    const views=prepared.map(t=>observerTrack(t,[0,0,0],s.soundSpeed));
    let bestFeasible=null,evaluations=0,iterations=0,recentered=0;
    const run=async centre=>{
        const at=async q=>{
            const lat=centre.lat+q[1]/111320,lon=centre.lon+q[0]/(111320*Math.cos(centre.lat*Math.PI/180));
            const altitudeM=await elevationAt(lat,lon),observer=toECEF(lat,lon,altitudeM);
            const pair=prepared.map((track,i)=>{
                const view=observerTrack(track,observer,s.soundSpeed,views[i]),cpa=nearestApproach(view,s.soundSpeed);
                return cpa ? {track:view,cpa} : null;
            });
            if(pair.some(p=>!p)) return null;
            const base=s.recordingStart ?? pair[0].cpa.arrival-events[0].cpa;
            const recordingStart=base+q[2]/100;
            const fit=scoreCombination(pair,events,{...s,recordingStart,timeTolerance:0,cpaTolerance:1e9,silence:[]},spectrogram);
            if(!fit) return null;
            let penalty=0,valid=true;
            pair.forEach((p,i)=>{
                const e=events[i],rangeError=Math.max(e.rangeMin-p.cpa.range,p.cpa.range-e.rangeMax,0);
                const timeError=Math.max(Math.abs(p.cpa.arrival-recordingStart-e.cpa)-s.cpaTolerance,0);
                const speedError=Math.max(e.speedMin-p.cpa.speed,p.cpa.speed-e.speedMax,0);
                penalty+=(rangeError/250)**2+(timeError/3)**2+(speedError/5)**2;
                if(rangeError>0 || timeError>0 || p.cpa.speed<e.speedMin || p.cpa.speed>e.speedMax) valid=false;
            });
            const value={score:fit.score-penalty,fit:{lat,lon,altitudeM,...fit},valid};
            // A soft penalty can put the final optimum just outside a hard bound.
            // Keep the best valid trial even when the simplex prefers that point.
            if(valid && (!bestFeasible || fit.score>bestFeasible.score)) bestFeasible=value.fit;
            return value;
        };
        const seedObserver=toECEF(centre.lat,centre.lon,await elevationAt(centre.lat,centre.lon));
        const firstView=observerTrack(prepared[0],seedObserver,s.soundSpeed);
        const firstCPA=nearestApproach(firstView,s.soundSpeed);
        if(!firstCPA) return false;
        const base=s.recordingStart ?? firstCPA.arrival-events[0].cpa;
        const initialClock=Math.max(-s.timeTolerance,Math.min(s.timeTolerance,centre.recordingStart-base))*100;
        const result=await maximizeBounded(at,{initial:[0,0,initialClock],steps:[stepM,stepM,Math.min(200,s.timeTolerance*100)],
            bounds:[[-maxOffsetM,maxOffsetM],[-maxOffsetM,maxOffsetM],[-s.timeTolerance*100,s.timeTolerance*100]],maxIterations});
        evaluations+=result.evaluations;iterations+=result.iterations;
        return true;
    };
    let centre=candidate;
    for(let round=0;round<=recenter;round++) {
        const previous=bestFeasible;
        if(!await run(centre) || !bestFeasible || bestFeasible===previous) break;
        const east=(bestFeasible.lon-centre.lon)*111320*Math.cos(centre.lat*Math.PI/180),north=(bestFeasible.lat-centre.lat)*111320;
        if(Math.max(Math.abs(east),Math.abs(north))<maxOffsetM*0.95 || round===recenter) break;
        centre={...centre,lat:bestFeasible.lat,lon:bestFeasible.lon,recordingStart:bestFeasible.recordingStart};recentered++;
    }
    return bestFeasible ? {...bestFeasible,optimization:{evaluations,iterations,recentered}} : null;
}
