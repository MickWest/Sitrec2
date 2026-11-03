import {FlightArchive,readArchiveTrack,scanFlightArchive} from "./DopplerArchive";
import {closestApproaches,nearestApproachFromObserver,observerTrack,prepareTrack,toECEF} from "./DopplerModel";
import {makeGrid,scoreCombination,searchLocations} from "./DopplerSearch";
import {DopplerElevation} from "./DopplerElevation";
import {refineDopplerLocation} from "./DopplerOptimizer";
import {ARCHIVE_DEFAULTS} from "./DopplerArchiveOptions";

const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
let indexedArchive=null,indexedKey=null;

async function datasetFor(input,progress) {
    const options={...ARCHIVE_DEFAULTS,...input.archiveOptions};
    const key=JSON.stringify({files:input.files.map(f=>[f.name,f.size,f.lastModified]),bounds:options.bounds,
        step:options.sampleStep,jets:options.excludeJets,barometric:options.allowBarometric});
    if(key!==indexedKey || !indexedArchive) {
        indexedArchive=null;indexedKey=null;
        const dataset=await scanFlightArchive(new FlightArchive(input.files),input.events,options,progress);
        indexedArchive=dataset;indexedKey=key;
    }
    const a=indexedArchive.samples;
    for(let i=0;i<a.length;i++) {
        let flags=0;
        if(indexedArchive.flights[a.flight[i]].eventEligible!==false) input.events.forEach((e,j)=>{if(a.speedMax[i]>=e.speedMin && a.speedMin[i]<=e.speedMax) flags|=1<<j;});
        a.flags[i]=flags;
    }
    return indexedArchive;
}

export async function indexFlightArchive(input,progress=()=>{}) {
    const start=performance.now(),dataset=await datasetFor(input,progress);
    const indexBytes=Object.values(dataset.samples).filter(v=>ArrayBuffer.isView(v)).reduce((n,v)=>n+v.byteLength,0);
    return {stats:{...dataset.stats,samples:dataset.samples.length,indexBytes},
        dates:[...new Set(dataset.flights.map(f=>new Date(f.base*1000).toISOString().slice(0,10)))],elapsedSeconds:(performance.now()-start)/1000};
}

export async function archivePairs(dataset,events,settings,options,progress=()=>{}) {
    const a=dataset.samples;
    if(events.length===1) {
        if(settings.recordingStart===null) throw new Error("One archive event needs a known recording start UTC.");
        const expected=settings.recordingStart+events[0].cpa,margin=events[0].rangeMax/settings.soundSpeed+options.sampleStep+(settings.maxGap ?? 30)+settings.cpaTolerance+settings.timeTolerance;
        const representatives=new Map();
        for(let i=0;i<a.length;i++) if((a.flags[i]&1) && Math.abs(a.time[i]-expected)<margin) {
            const previous=representatives.get(a.flight[i]);
            if(previous===undefined || Math.abs(a.time[i]-expected)<Math.abs(a.time[previous]-expected)) representatives.set(a.flight[i],i);
        }
        return [...representatives.values()].map(i=>[i]);
    }
    if(events.length!==2) throw new Error("Archive discovery supports one known-time or two unknown-time flyovers. Add further events when validating the shortlisted tracks.");
    // A bucket's representative fix can precede the closest approach. Include
    // its possible motion before applying the exact track geometry.
    const padding=(options.sampleStep+(settings.maxGap ?? 30))*(events[0].speedMax+events[1].speedMax);
    const radius=events[0].rangeMax+events[1].rangeMax+padding;
    const latStep=radius/111320,lonStep=latStep/Math.cos(Math.max(Math.abs(options.bounds[0]),Math.abs(options.bounds[2]))*Math.PI/180);
    const lonCells=Math.ceil(360/lonStep)+2;
    const timeStep=Math.max(30,settings.cpaTolerance+settings.timeTolerance+(events[0].rangeMax+events[1].rangeMax)/settings.soundSpeed+2*(options.sampleStep+(settings.maxGap ?? 30)));
    const origin=Math.floor(dataset.flights.reduce((v,f)=>Math.min(v,f.base),Infinity)/86400)*86400;
    const timeCells=4096;
    const cell=i=>[Math.floor((a.lat[i]+90)/latStep),Math.floor((a.lon[i]+180)/lonStep),Math.floor((a.time[i]-origin)/timeStep)];
    const key=(y,x,t)=>(y*lonCells+x)*timeCells+t;
    const buckets=new Map(),delta=events[1].cpa-events[0].cpa;
    for(let i=0;i<a.length;i++) if(a.flags[i]&2) {
        const [y,x]=cell(i),t=Math.floor((a.time[i]-delta-origin)/timeStep),k=key(y,x,t);
        let bucket=buckets.get(k);if(!bucket) buckets.set(k,bucket=[]);bucket.push(i);
    }
    const best=new Map();
    for(let i=0;i<a.length;i++) {
        if(!(a.flags[i]&1)) continue;
        const [y,x,t]=cell(i);
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) for(let dt=-1;dt<=1;dt++) {
            const bucket=buckets.get(key(y+dy,x+dx,t+dt));if(!bucket) continue;
            for(const j of bucket) {
                if(a.flight[i]===a.flight[j] || Math.abs(a.time[j]-a.time[i]-delta)>timeStep) continue;
                const distance=Math.hypot(a.x[j]-a.x[i],a.y[j]-a.y[i],a.z[j]-a.z[i]);
                if(distance>radius) continue;
                const id=`${a.flight[i]}/${a.flight[j]}/${Math.floor(a.time[i]/options.timeBin)}`;
                const old=best.get(id);if(!old || distance<old.distance) best.set(id,{indices:[i,j],distance});
            }
        }
        if(i%10000===0) {progress({phase:"Pairing flyovers",done:i,total:a.length,pairs:best.size});await pause();}
    }
    return [...best.values()].map(p=>p.indices);
}

function anchorSegment(track,around) {
    return track.segments.reduce((best,s)=>Math.abs(s.t0-around)<Math.abs(best.t0-around) ? s : best);
}
export function silenceChecker(dataset,events,s,options) {
    if(!s.silence.length) return async()=>true;
    const a=dataset.samples,radius=Math.max(s.silenceRadiusM,...events.map(e=>e.rangeMax))+250*options.sampleStep;
    const latStep=radius/111320,lonStep=latStep/Math.cos(Math.max(Math.abs(options.bounds[0]),Math.abs(options.bounds[2]))*Math.PI/180);
    const columns=Math.ceil(360/lonStep)+2,key=(lat,lon)=>Math.floor((lat+90)/latStep)*columns+Math.floor((lon+180)/lonStep);
    const buckets=new Map(),tracks=new Map();
    for(let i=0;i<a.length;i++) {
        if(!options.silenceAllAircraft && dataset.flights[a.flight[i]].eventEligible===false) continue;
        const k=key(a.lat[i],a.lon[i]);let bucket=buckets.get(k);
        if(!bucket) buckets.set(k,bucket=[]);bucket.push(i);
    }
    return async result=>{
        const heardRadius=s.silenceRadiusM || Math.max(...result.events.map(e=>e.rangeM));
        const observer=toECEF(result.lat,result.lon,result.altitudeM);
        const cell=key(result.lat,result.lon),possible=new Set();
        const windows=s.silence.map(([a,b])=>[result.recordingStart+a,result.recordingStart+b]);
        for(let y=-1;y<=1;y++) for(let x=-1;x<=1;x++) {
            for(const i of buckets.get(cell+y*columns+x) ?? []) {
                if(!windows.some(([start,end])=>a.time[i]>=start-options.sampleStep && a.time[i]<=end+options.sampleStep)) continue;
                if(Math.hypot(a.x[i]-observer[0],a.y[i]-observer[1],a.z[i]-observer[2])>heardRadius+250*options.sampleStep) continue;
                possible.add(a.flight[i]);
            }
        }
        const from=Math.min(...windows.map(w=>w[0]))-120,to=Math.max(...windows.map(w=>w[1]))+120;
        for(const flight of possible) {
            const cacheKey=`${flight}/${from}/${to}`;
            let track=tracks.get(cacheKey);
            if(!track) {
                try {track=prepareTrack(await readArchiveTrack(dataset,flight,from,to),s.soundSpeed,s.maxGap);}
                catch {continue;}
                tracks.set(cacheKey,track);if(tracks.size>128) tracks.delete(tracks.keys().next().value);
            }
            const cpas=closestApproaches(observerTrack(track,observer,s.soundSpeed),s.soundSpeed);
            if(cpas.some(p=>p.range<heardRadius && windows.some(([start,end])=>p.arrival>start && p.arrival<end))) return false;
        }
        return true;
    };
}

export async function selectAudibleCandidates(candidates,limit,passes) {
    const results=[];let rejectedBySilence=0;
    for(const candidate of candidates) {
        if(await passes(candidate)) results.push(candidate);else rejectedBySilence++;
        if(results.length>=limit) break;
    }
    return {results,rejectedBySilence};
}

export function archiveCoarseSettings(events,s,options) {
    const measured=events.length>0 && events.every(e=>Array.isArray(e.trace) && e.trace.length>=4 && e.trace.every(p=>
        p && Number.isFinite(p.time) && Number.isFinite(p.frequency) && p.frequency>0 && p.time>=e.start && p.time<=e.end));
    // Traces propose seeds cheaply. Every surviving region still uses the
    // requested objective during continuous refinement and global ranking.
    return {...s,mode:s.mode==="brightness" && measured ? "trace" : s.mode,
        timeTolerance:s.timeTolerance+options.coarseStep/Math.max(20,events[0].speedMin),
        timeStep:Math.max(2,s.timeStep),cpaTolerance:s.cpaTolerance+2*options.coarseStep/Math.max(20,events[0].speedMin),silence:[]};
}

export function archiveTrackLoader(dataset,s) {
    const a=dataset.samples,cache=new Map();
    return async index=>{
        const flight=a.flight[index],time=a.time[index];
        // The key must identify the exact window. Two fixes in one minute can
        // have different usable segments, including after a cache eviction.
        const key=`${flight}/${time}`;
        if(cache.has(key)) return cache.get(key);
        const source=await readArchiveTrack(dataset,flight,time-240,time+240);
        let prepared;
        try {prepared=prepareTrack(source,s.soundSpeed,s.maxGap);} catch {dataset.stats.invalidTracks=(dataset.stats.invalidTracks ?? 0)+1;return null;}
        const value={source,prepared};cache.set(key,value);
        if(cache.size>128) cache.delete(cache.keys().next().value);
        return value;
    };
}

async function refineArchiveCandidate(dataset,candidate,events,s,options,spectrogram,geoidURL,progress) {
    const tracks=await Promise.all(candidate.events.map(async e=>{
        const index=dataset.flights.findIndex(f=>f.id===e.flight);
        if(index<0) throw new Error(`The selected archive does not contain flight ${e.flight}.`);
        const emission=e.cpaArrival-e.rangeM/s.soundSpeed;
        return readArchiveTrack(dataset,index,emission-240,emission+240);
    }));
    const terrain=new DopplerElevation(geoidURL);await terrain.initialize();
    const refined=await refineDopplerLocation({candidate,tracks,events,settings:s,spectrogram,
        elevationAt:(lat,lon)=>terrain.at(lat,lon),maxOffsetM:1000,stepM:Math.min(100,options.fineStep),maxIterations:160});
    const results=[],heat=[],passes=silenceChecker(dataset,events,s,options);
    if(refined && await passes(refined)) results.push(refined);
    if(results.length) {
        const local={...s,recordingStart:refined.recordingStart,timeTolerance:0,lat:refined.lat,lon:refined.lon,
            radiusM:500,spacingM:Math.max(20,options.fineStep/5)};
        const grid=makeGrid(local);
        for(const p of grid) p.altitudeM=await terrain.at(p.lat,p.lon);
        const mapped=await searchLocations({settings:local,events,tracks,spectrogram,grid},{progress});
        heat.push(...mapped.heat);
    }
    return {results,heat,tracks,bounds:options.bounds,stats:{...dataset.stats,points:heat.length,passed:results.length,
        combinations:1,rejectedBySilence:refined && !results.length ? 1 : 0}};
}

// Sparse whole-archive geometry proposes candidates. The same scoring function
// as the regional tool checks every surviving curve; both clocks stay locked.
export async function searchFlightArchive({files,settings:s,events,spectrogram,archiveOptions,geoidURL,refineCandidate},progress=()=>{}) {
    const options={...ARCHIVE_DEFAULTS,...archiveOptions};
    if(!files?.length) throw new Error("Select the daily flight archive and all its split parts.");
    if(options.keep<1 || options.keep>1000 || options.coarseStep<100 || options.coarseStep>2000 || options.fineStep<10 || options.refineCount<1 || options.refineCount>100) throw new Error("Check archive grid and shortlist sizes.");
    const started=performance.now(),dataset=await datasetFor({files,events,archiveOptions:options},progress);
    if(refineCandidate) {
        const result=await refineArchiveCandidate(dataset,refineCandidate,events,s,options,spectrogram,geoidURL,progress);
        return {...result,elapsedSeconds:(performance.now()-started)/1000};
    }
    const pairs=await archivePairs(dataset,events,s,options,progress);
    if(!pairs.length) throw new Error("No flight pairs satisfy the measured speeds and relative timing. Check the archive date and event bounds.");
    const a=dataset.samples,coarse=new Map(),load=archiveTrackLoader(dataset,s);
    const coarseSettings=archiveCoarseSettings(events,s,options);
    const traceSeeds=s.mode==="brightness" && coarseSettings.mode==="trace";
    const coarseEvents=events.map(e=>({...e,rangeMin:Math.max(0,e.rangeMin-options.coarseStep),rangeMax:e.rangeMax+options.coarseStep,
        trace:Array.isArray(e.trace) ? traceSeeds && e.trace.length<8 ? e.trace : e.trace.filter((_,i)=>i%2===0) : []}));
    const coarseSpectrogram=coarseSettings.mode==="brightness" ? spectrogram : null;
    for(let pi=0;pi<pairs.length;pi++) {
        const indices=pairs[pi],loaded=await Promise.all(indices.map(load));
        if(loaded.some(v=>!v)) continue;
        const segments=loaded.map((t,i)=>anchorSegment(t.prepared,a.time[indices[i]]));
        const views=loaded.map(t=>observerTrack(t.prepared,[0,0,0],s.soundSpeed));
        const radius=events[0].rangeMax+events[0].speedMax*(options.timeBin+options.sampleStep+s.maxGap);
        const n=Math.ceil(radius/options.coarseStep),anchor=indices[0];
        for(let y=-n;y<=n;y++) for(let x=-n;x<=n;x++) {
            const lat=a.lat[anchor]+y*options.coarseStep/111320;
            const lon=a.lon[anchor]+x*options.coarseStep/(111320*Math.cos(a.lat[anchor]*Math.PI/180));
            if(lat<options.bounds[0] || lat>options.bounds[2] || lon<options.bounds[1] || lon>options.bounds[3]) continue;
            for(const altitudeM of options.heightBands) {
                const observer=toECEF(lat,lon,altitudeM);
                const cpas=loaded.map((t,i)=>nearestApproachFromObserver(t.prepared,observer,s.soundSpeed,coarseEvents[i].rangeMax));
                if(cpas.some((p,i)=>!p || p.range<coarseEvents[i].rangeMin || p.range>coarseEvents[i].rangeMax)) continue;
                const base=coarseSettings.recordingStart ?? cpas[0].arrival-coarseEvents[0].cpa;
                if(cpas.some((p,i)=>Math.abs(p.arrival-base-coarseEvents[i].cpa)>coarseSettings.timeTolerance+coarseSettings.cpaTolerance)) continue;
                const combination=loaded.map((t,i)=>({track:observerTrack(t.prepared,observer,s.soundSpeed,views[i]),cpa:cpas[i]}));
                const scored=scoreCombination(combination,coarseEvents,coarseSettings,coarseSpectrogram);
                if(!scored) continue;
                const velocity=segments[0].velocity,la=a.lat[anchor]*Math.PI/180,lo=a.lon[anchor]*Math.PI/180;
                const east=-Math.sin(lo)*velocity[0]+Math.cos(lo)*velocity[1];
                const north=-Math.sin(la)*Math.cos(lo)*velocity[0]-Math.sin(la)*Math.sin(lo)*velocity[1]+Math.cos(la)*velocity[2];
                const side=x*north-y*east>=0 ? 1 : -1;
                const key=`${loaded.map(t=>t.source.id).join("/")}/${s.recordingStart===null ? Math.floor(scored.recordingStart/300) : "known"}/${altitudeM}/${side}`;
                const old=coarse.get(key);
                if(!old || scored.score>old.score) coarse.set(key,{lat,lon,altitudeM,...scored,indices,side});
            }
        }
        if(pi%10===0 || pi===pairs.length-1) {
            progress({phase:"Scoring archive candidates",done:pi+1,total:pairs.length,candidates:coarse.size});await pause();
        }
    }
    if(!coarse.size) throw new Error("No archive candidates matched the curves. Broaden measurement tolerances and inspect flight-data coverage.");
    const terrain=new DopplerElevation(geoidURL);await terrain.initialize();
    // Every viable flight-pair region gets continuous refinement before global
    // ranking. A coarse score alone cannot resolve a narrow spectral ridge.
    const regions=new Map();
    for(const candidate of coarse.values()) {
        const key=`${candidate.indices.map(i=>a.flight[i]).join("/")}/${s.recordingStart===null ? Math.floor(candidate.recordingStart/300) : "known"}/${candidate.side}`;
        let region=regions.get(key);if(!region) regions.set(key,region=[]);region.push(candidate);
    }
    const refined=[];
    let done=0;
    const refineRegion=async variants=>{
        const choices=[];
        for(const candidate of variants) {
            const height=await terrain.at(candidate.lat,candidate.lon);
            choices.push({candidate,error:Math.abs(candidate.altitudeM-height)});
        }
        choices.sort((a,b)=>a.error-b.error || b.candidate.score-a.candidate.score);
        const seeds=[];
        for(const {candidate} of choices) {
            if(seeds.some(p=>Math.hypot((p.lat-candidate.lat)*111320,(p.lon-candidate.lon)*111320*Math.cos(p.lat*Math.PI/180))<options.coarseStep*2)) continue;
            seeds.push(candidate);if(seeds.length===2) break;
        }
        for(const candidate of seeds) {
            const loaded=await Promise.all(candidate.indices.map(load));
            const common={tracks:loaded.map(t=>t.source),events,elevationAt:(lat,lon)=>terrain.at(lat,lon),
                maxOffsetM:Math.max(2000,options.coarseStep*4)};
            // A broad trace fit first locates the narrow ridge between coarse
            // cells. It supplies only a start; brightness decides the result.
            const initialized=traceSeeds ? await refineDopplerLocation({...common,candidate,settings:{...s,mode:"trace"},
                spectrogram:null,stepM:options.coarseStep}) : null;
            const result=await refineDopplerLocation({...common,candidate:initialized ?? candidate,settings:s,spectrogram,
                stepM:traceSeeds ? Math.min(200,options.coarseStep) : options.coarseStep});
            if(result) refined.push({...result,indices:candidate.indices});
        }
    };
    const regionList=[...regions.values()];
    // Overlap bounded terrain I/O. Each fit owns its observer views and retains
    // the same seeds, constraints and scoring as the serial calculation.
    for(let i=0;i<regionList.length;i+=4) {
        const batch=await Promise.allSettled(regionList.slice(i,i+4).map(refineRegion));
        const failed=batch.find(r=>r.status==="rejected");if(failed) throw failed.reason;
        done+=batch.length;
        progress({phase:"Refining flight regions",done,total:regions.size});await pause();
    }
    const shortlist=refined.sort((a,b)=>b.score-a.score);
    const heat=[],sources=new Map(),silencePass=silenceChecker(dataset,events,s,options);
    const {results,rejectedBySilence}=await selectAudibleCandidates(shortlist,options.keep,silencePass);
    for(let i=0;i<Math.min(options.refineCount,results.length);i++) {
        const candidate=results[i],loaded=await Promise.all(candidate.indices.map(load));
        const local={...s,recordingStart:candidate.recordingStart,timeTolerance:0,
            lat:candidate.lat,lon:candidate.lon,radiusM:options.coarseStep,spacingM:options.fineStep};
        const grid=makeGrid(local);
        for(const p of grid) p.altitudeM=await terrain.at(p.lat,p.lon);
        const result=await searchLocations({settings:local,events,tracks:loaded.map(t=>t.source),spectrogram,grid});
        heat.push(...result.heat);
        progress({phase:"Drawing refined score maps",done:i+1,total:Math.min(options.refineCount,results.length)});await pause();
    }
    // Every returned candidate needs its prediction tracks, independently of
    // how many optional score maps were requested.
    for(const candidate of results.slice(0,100)) {
        const loaded=await Promise.all(candidate.indices.map(load));
        for(const source of loaded.map(t=>t.source)) {
            const existing=sources.get(source.id);
            if(!existing) sources.set(source.id,{...source,points:[...source.points]});
            else {
                const times=new Set(existing.points.map(p=>p.time));
                existing.points.push(...source.points.filter(p=>!times.has(p.time)));existing.points.sort((a,b)=>a.time-b.time);
            }
        }
    }
    return {results:results.slice(0,100).map(({indices,...r})=>r),heat,tracks:[...sources.values()],bounds:options.bounds,
        stats:{...dataset.stats,points:heat.length,passed:results.length,combinations:pairs.length,regions:regions.size,rejectedBySilence},elapsedSeconds:(performance.now()-started)/1000};
}
