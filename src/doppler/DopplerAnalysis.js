import {SEARCH_DEFAULTS} from "./DopplerSearch";
import {ARCHIVE_DEFAULTS} from "./DopplerArchiveOptions";
import {traceFamily,traceHarmonic,validTraceFamily,validTraceHarmonic} from "./DopplerTrace";

const clone=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null && typeof value==="object" && !Array.isArray(value);
const finiteFields=(value,keys)=>object(value) && keys.every(key=>Number.isFinite(value[key]));
const fail=message=>{throw new Error(`Invalid Doppler analysis: ${message}`);};
const utc=value=>typeof value==="string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const eventNumbers=["cpa","start","end","frequency","frequencyTolerance","harmonic","speedMin","speedMax","rangeMin","rangeMax"];
const AUDIO_DEFAULTS={windowSeconds:2,hop:1,maxHz:800};
function audioOptions(value) {
    const options={...AUDIO_DEFAULTS,...value};
    if(value!==undefined && !object(value) || !finiteFields(options,["windowSeconds","hop","maxHz"]) ||
        options.windowSeconds<0.25 || options.windowSeconds>16 || options.hop<0.1 || options.maxHz<=0 || options.maxHz>=2048) fail("check spectrogram window, time step and frequency limit.");
    return options;
}

export function canPreserveAudioResult(result,mode,sameFile,options) {
    return !!result && sameFile && (mode==="trace" ||
        ["windowSeconds","hop","maxHz"].every(key=>result.audioOptions?.[key]===options[key]));
}

// This validates a saved draft, not a ready-to-run search. In particular, empty
// tracks and fewer than four traced observations are legitimate unfinished work.
export function validateAnalysis(value) {
    if(!object(value) || value.version!==1 || !object(value.settings) || !Array.isArray(value.events) ||
        !value.events.length || value.events.length>4 || !Array.isArray(value.tracks)) fail("expected a version 1 analysis with settings, events and tracks.");
    const settings={...clone(SEARCH_DEFAULTS),...value.settings};
    const numeric=Object.keys(SEARCH_DEFAULTS).filter(key=>typeof SEARCH_DEFAULTS[key]==="number");
    if(!finiteFields(settings,numeric) || settings.soundSpeed<=0 || !["tracks","archive"].includes(settings.source) ||
        !["fixed","terrain"].includes(settings.elevation) || !["trace","brightness"].includes(settings.mode) || !["squared","robust"].includes(settings.traceLoss) ||
        typeof settings.recordingStart!=="string" || (settings.recordingStart.trim() && !utc(settings.recordingStart.trim()))) fail("check search settings and the recording UTC time.");
    if(!Array.isArray(settings.silence) || settings.silence.some(w=>!Array.isArray(w) || w.length!==2 || !w.every(Number.isFinite) || w[0]>=w[1])) fail("silence windows need start and end seconds.");
    for(const [index,event] of value.events.entries()) {
        if(!finiteFields(event,eventNumbers) || event.start<0 || event.end<=event.start || event.cpa<event.start || event.cpa>event.end ||
            event.frequency<=0 || event.frequencyTolerance<0 || event.frequencyTolerance>=event.frequency || !Number.isInteger(event.harmonic) ||
            event.harmonic<1 || event.harmonic>16 || event.speedMin<0 || event.speedMax<event.speedMin || event.rangeMin<0 || event.rangeMax<event.rangeMin ||
            (event.family!==undefined && !validTraceFamily(event.family)) ||
            !Array.isArray(event.trace) || event.trace.some(p=>!finiteFields(p,["time","frequency"]) || p.time<event.start || p.time>event.end || p.frequency<=0 ||
                !validTraceHarmonic(traceHarmonic(event,p)) || !validTraceFamily(traceFamily(p)))) fail(`check event ${index+1}'s fields and trace points.`);
    }
    const ids=new Set();
    for(const track of value.tracks) {
        if(!object(track) || typeof track.id!=="string" || !track.id || ids.has(track.id) || !Array.isArray(track.points) || track.points.length<2) fail("each flight needs a unique ID and at least two fixes.");
        ids.add(track.id);
        for(const key of ["callsign","registration","aircraftType"]) if(track[key]!==undefined && typeof track[key]!=="string") fail("aircraft labels must be text.");
        for(const point of track.points) {
            if(!finiteFields(point,["time","lat","lon","altitudeM"]) || Math.abs(point.lat)>90 || Math.abs(point.lon)>180 ||
                ["groundSpeedMS","headingDegrees","verticalSpeedMS"].some(key=>point[key]!=null && !Number.isFinite(point[key]))) fail(`check fixes in flight ${track.id}.`);
        }
    }
    if(value.archiveOptions!==undefined && !object(value.archiveOptions)) fail("archive settings must be an object.");
    const archiveOptions={...clone(ARCHIVE_DEFAULTS),...value.archiveOptions};
    if(!finiteFields(archiveOptions,["sampleStep","timeBin","coarseStep","fineStep","keep","refineCount","soundSpeedCheck","soundSpeedCheckPairs"]) ||
        !Array.isArray(archiveOptions.bounds) || archiveOptions.bounds.length!==4 || !archiveOptions.bounds.every(Number.isFinite) ||
        !Array.isArray(archiveOptions.heightBands) || !archiveOptions.heightBands.length || !archiveOptions.heightBands.every(Number.isFinite) ||
        typeof archiveOptions.excludeJets!=="boolean" || typeof archiveOptions.allowBarometric!=="boolean" ||
        typeof archiveOptions.silenceAllAircraft!=="boolean") fail("check archive bounds, heights and options.");
    if(value.provenance!==undefined) {
        if(!object(value.provenance)) fail("source information must be an object.");
        if(value.provenance.archiveFiles!==undefined && !Array.isArray(value.provenance.archiveFiles)) fail("archive source information must be a list.");
        const files=[value.provenance.audio,value.provenance.flightCSV,...(value.provenance.archiveFiles ?? [])].filter(v=>v!==undefined);
        if(files.some(f=>!object(f) || typeof f.name!=="string" || !finiteFields(f,["size","lastModified"]) || f.size<0)) fail("check source file information.");
    }
    const state={version:1,settings:clone(settings),events:clone(value.events),tracks:clone(value.tracks),archiveOptions:clone(archiveOptions),
        audioOptions:audioOptions(value.audioOptions ?? value.savedResult?.audioOptions)};
    if(value.provenance) state.provenance=clone(value.provenance);
    if(value.savedResult!==undefined) {
        const saved=value.savedResult;
        if(!object(saved) || !Array.isArray(saved.results) || saved.results.length>100 || !object(saved.stats) ||
            Object.values(saved.stats).some(n=>!Number.isFinite(n)) || !Number.isFinite(saved.stats.passed)) fail("check saved result statistics.");
        for(const result of saved.results) {
            if(!finiteFields(result,["lat","lon","altitudeM","score","recordingStart"]) || Math.abs(result.lat)>90 || Math.abs(result.lon)>180 ||
                !Number.isFinite(new Date(result.recordingStart*1000).getTime()) || !Array.isArray(result.events) || result.events.length!==state.events.length ||
                result.events.some(e=>!finiteFields(e,["frequency","score"]) || typeof e.flight!=="string" || !ids.has(e.flight) ||
                    ["rmsHz","cpaArrival","rangeM","speedMS"].some(key=>e[key]!==undefined && !Number.isFinite(e[key])) ||
                    (e.families!==undefined && (!Array.isArray(e.families) || e.families.some(f=>!finiteFields(f,["family","frequency"]) || !validTraceFamily(f.family)))))) fail("check saved candidate locations and flights.");
        }
        if(!Number.isInteger(saved.selectedIndex) || saved.selectedIndex<0 || saved.selectedIndex>=Math.max(1,saved.results.length) ||
            (saved.completedAtUTC!==undefined && !utc(saved.completedAtUTC)) ||
            (saved.bounds!==undefined && (!Array.isArray(saved.bounds) || saved.bounds.length!==4 || !saved.bounds.every(Number.isFinite))) ||
            (saved.elapsedSeconds!==undefined && !Number.isFinite(saved.elapsedSeconds))) fail("check the saved candidate selection and search information.");
        state.savedResult=compactSearchResult(saved,saved.selectedIndex,saved.completedAtUTC);
        if(saved.audioOptions!==undefined) state.savedResult.audioOptions=audioOptions(saved.audioOptions);
    }
    return state;
}

// Heat maps are regenerated on a new search. Do not duplicate the retained flight
// fixes or include decoded audio/FFT arrays in a saved analysis or saved sitch.
export function compactSearchResult(result,selectedIndex=0,completedAtUTC=new Date().toISOString()) {
    const saved={results:clone(result.results.slice(0,100)),stats:clone(result.stats),selectedIndex,completedAtUTC};
    if(Number.isFinite(result.elapsedSeconds)) saved.elapsedSeconds=result.elapsedSeconds;
    if(Array.isArray(result.bounds)) saved.bounds=clone(result.bounds);
    if(result.audioOptions) saved.audioOptions=clone(result.audioOptions);
    return saved;
}

export function resultMapViewport(result,settings) {
    const points=[...(result?.heat ?? []),...(result?.results ?? [])];
    if(!points.length) points.push({lat:settings.lat,lon:settings.lon});
    const origin=points[0].lon,delta=lon=>((lon-origin+540)%360)-180;
    let south=Infinity,north=-Infinity,west=Infinity,east=-Infinity;
    for(const p of points) {south=Math.min(south,p.lat);north=Math.max(north,p.lat);west=Math.min(west,delta(p.lon));east=Math.max(east,delta(p.lon));}
    const lat=(south+north)/2,lonOffset=(west+east)/2,cos=Math.max(0.01,Math.cos(lat*Math.PI/180));
    const metresPerPixel=Math.max(200/210,(north-south)*111320/210,(east-west)*111320*cos/900)*1.1;
    return {lat,lon:((origin+lonOffset+540)%360)-180,metresPerPixel,
        project:p=>({x:500+(delta(p.lon)-lonOffset)*111320*cos/metresPerPixel,y:155-(p.lat-lat)*111320/metresPerPixel})};
}
