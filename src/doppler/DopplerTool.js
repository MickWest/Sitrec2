import {BufferGeometry,Float32BufferAttribute,Points,PointsMaterial} from "three";
import {saveAs} from "file-saver";
import {GlobalDateTimeNode,markSitchDirty,NodeMan,setRenderOne,Sit,TrackManager} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {LLAToECEF,ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {blockViewEvents} from "../DragResizeUtils";
import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {getInteractionRouter} from "../InteractionRouter";
import {isAdmin,SITREC_APP} from "../configUtils";
import {atArrival,idealFrequency,observerTrack,prepareTrack,toECEF} from "./DopplerModel";
import {makeGrid,newEvent,SEARCH_DEFAULTS,validateSearch} from "./DopplerSearch";
import {parseFlightCSV,resultsCSV} from "./DopplerImport";
import {makeDemo} from "./DopplerDemo";
import {canPreserveAudioResult,compactSearchResult,resultMapViewport,validateAnalysis} from "./DopplerAnalysis";
import "./doppler.css";

function el(tag,parent,text,className) {
    const e=document.createElement(tag);
    if(text!==undefined) e.textContent=text;
    if(className) e.className=className;
    parent?.append(e);return e;
}
const copy=x=>JSON.parse(JSON.stringify(x));

export class DopplerTool {
    constructor() {
        const initial={version:1,settings:{...SEARCH_DEFAULTS,lat:Sit.lat ?? 37,lon:Sit.lon ?? -122},events:[newEvent()],tracks:[]};
        let restoreError;
        try {this.state=validateAnalysis(Sit.dopplerGeolocation ?? initial);}
        catch(error) {this.state=validateAnalysis(initial);restoreError=error.message;}
        this.selectedEvent=0;this.cleanups=[];this.revision=0;
        this.save();this.build();
        this.restoreResults();
        if(restoreError) this.status(`${restoreError} Open a valid analysis file to restore the work.`);
    }
    save() {
        if(this.result) this.state.savedResult=compactSearchResult(this.result,Math.max(0,this.result.results.indexOf(this.selectedResult)),this.result.completedAtUTC);
        Sit.dopplerGeolocation=this.state;
    }
    changed() {
        this.stop();this.result=null;this.selectedResult=null;this.archiveRefinement=null;delete this.state.savedResult;
        this.clearMarker();this.save();markSitchDirty();this.draw();
        this.resultSummary.textContent="Inputs changed. Run the search to update results.";
        this.table.replaceChildren();
    }
    status(text) {if(!this.disposed) this.statusElement.textContent=text;}
    button(parent,label,action) {
        const b=el("button",parent,label);b.type="button";
        b.onclick=()=>Promise.resolve().then(action).catch(e=>this.status(e.message));return b;
    }
    field(parent,object,key,label,{type="number",step="any",changed=true}={}) {
        const row=el("label",parent,undefined,"dp-field");el("span",row,label);
        const input=el("input",row);input.type=type;input.step=step;input.value=object[key] ?? "";
        input.onchange=()=>{
            if(type==="number" && (!input.value.trim() || !Number.isFinite(input.valueAsNumber))) {input.value=object[key];return;}
            object[key]=type==="number" ? input.valueAsNumber : input.value;
            if(changed) this.changed();else {this.save();markSitchDirty();}this.draw();
        };return input;
    }
    select(parent,label,object,key,choices,action=()=>this.changed()) {
        const row=el("label",parent,undefined,"dp-field");el("span",row,label);
        const input=el("select",row);
        for(const [value,text] of Object.entries(choices)) {const o=el("option",input,text);o.value=value;}
        input.value=object[key];input.onchange=()=>{object[key]=input.value;action();};return input;
    }
    fileButton(parent,label,accept,action,multiple=false) {
        const input=el("input",parent);input.type="file";input.accept=accept;input.hidden=true;
        input.multiple=multiple;
        this.button(parent,label,()=>input.click());
        input.onchange=async()=>{
            try {if(input.files[0]) await action(multiple ? [...input.files] : input.files[0]);}
            catch(e) {this.status(e.message);}
            finally {input.value="";}
        };
    }
    build() {
        const panel=this.panel=el("section",document.getElementById("Content") ?? document.body,undefined,"doppler-tool");
        panel.setAttribute("role","dialog");panel.setAttribute("aria-label","Doppler geolocation");panel.tabIndex=-1;
        blockViewEvents(panel);
        panel.addEventListener("keydown",e=>{e.stopPropagation();if(e.key==="Escape") this.hide();});
        const header=el("header",panel);
        el("h2",header,"Doppler geolocation");el("span",header,"Admin preview","dp-badge");
        this.button(header,"×",()=>this.hide()).setAttribute("aria-label","Close Doppler geolocation");
        this.cleanups.push(registerSurfaceInteraction(header,{
            model:this,intent:{zIndex:1200},capture:()=>header,
            begin:e=>{const r=panel.getBoundingClientRect();this.drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};},
            move:e=>{panel.style.left=`${Math.max(0,Math.min(window.innerWidth-100,this.drag.left+e.clientX-this.drag.x))}px`;panel.style.top=`${Math.max(30,Math.min(window.innerHeight-50,this.drag.top+e.clientY-this.drag.y))}px`;},
            end:()=>{this.drag=null;},
        }));
        const toolbar=el("div",panel,undefined,"dp-toolbar");
        this.fileButton(toolbar,"Load audio","audio/*,video/*,.aac",file=>this.loadAudio(file));
        this.fileButton(toolbar,"Flight CSV",".csv,text/csv",async file=>{
            const tracks=parseFlightCSV(await file.text());
            if(this.disposed) return;
            this.state.tracks=tracks;this.state.settings.source="tracks";
            (this.state.provenance ??= {}).flightCSV=this.fileInfo(file);this.changed();this.updateDataSummary();
        });
        this.fileButton(toolbar,"Daily flight archive",".tar,.aa,.ab,.ac,.ad",files=>{
            const sameFiles=this.state.settings.source==="archive" && this.sameFiles(files,this.state.provenance?.archiveFiles);
            this.archiveFiles=files;this.state.settings.source="archive";
            (this.state.provenance ??= {}).archiveFiles=files.map(file=>this.fileInfo(file));
            if(sameFiles && this.result) {this.stop();this.save();} else this.changed();
            this.buildData(this.pages["Data & search"].page);this.updateDataSummary();
            this.status("Daily archive selected. Mark the flyovers and set broad speed/slant bounds before searching.");
        },true);
        this.button(toolbar,"Use Sitrec tracks",()=>this.useSitrecTracks());
        this.fileButton(toolbar,"Load analysis",".json,application/json",file=>this.loadAnalysis(file));
        this.button(toolbar,"Save analysis",()=>{this.save();saveAs(new Blob([JSON.stringify(this.state)],{type:"application/json"}),"DopplerAnalysis.json");});
        this.button(toolbar,"Demo",()=>{this.replaceState(makeDemo());this.status("Synthetic exercise loaded. Search should recover 37°, −122° within one grid step.");});
        const nav=el("nav",panel), body=el("div",panel,undefined,"dp-body");
        this.pages={};
        for(const name of ["Data & search","Flyovers","Results"]) {
            const button=this.button(nav,name,()=>this.showPage(name));
            const page=el("div",body);this.pages[name]={page,button};
        }
        this.buildData(this.pages["Data & search"].page);
        this.buildEvents(this.pages.Flyovers.page);
        this.buildResults(this.pages.Results.page);
        const footer=el("footer",panel);
        this.statusElement=el("div",footer,"Load local audio and flight tracks, then mark the flyovers. Audio stays in this browser.","dp-status");
        this.runButton=this.button(footer,"Search locations",()=>this.run());
        this.stopButton=this.button(footer,"Stop",()=>{this.stop();this.status("Stopped.");});
        this.stopButton.disabled=true;
        this.resizeObserver=new ResizeObserver(()=>this.draw());this.resizeObserver.observe(panel);
        this.showPage("Data & search");
    }
    showPage(name) {
        for(const [key,{page,button}] of Object.entries(this.pages)) {page.hidden=key!==name;button.setAttribute("aria-pressed",String(key===name));}
        this.draw();
    }
    buildData(parent) {
        parent.replaceChildren();
        el("p",parent,"Match stationary-listener aircraft sound to timestamped 3D flight tracks. Start with broad speed and slant-range bounds; refine only after the flight data ranks candidates.","dp-hint");
        this.dataSummary=el("p",parent);this.updateDataSummary();
        el("p",parent,"CSV: flight,time,lat,lon,altitudeM. Time is ISO UTC (with Z) or Unix seconds; altitude is metres above the WGS84 ellipsoid (HAE). Convert pressure or sea-level altitude before importing.","dp-hint");
        const fields=el("div",parent,undefined,"dp-fields"),s=this.state.settings;
        this.select(fields,"Flight data source",s,"source",{tracks:"Loaded or CSV tracks",archive:"Daily readsb archive"},()=>{
            this.changed();this.buildData(parent);
        });
        for(const [key,label] of Object.entries({lat:"Search centre latitude",lon:"Longitude",radiusM:"Radius (m)",spacingM:"Grid step (m)",altitudeM:"Listener altitude HAE (m)",soundSpeed:"Sound speed (m/s)"})) this.field(fields,s,key,label);
        this.select(fields,"Elevation",s,"elevation",{fixed:"Fixed listener height",terrain:"Loaded Sitrec terrain"});
        this.field(fields,s,"recordingStart","Recording start UTC (blank = unknown)",{type:"text"});
        this.select(fields,"Scoring",s,"mode",{trace:"Traced frequency ridge",brightness:"Spectrogram brightness"});
        if(s.source==="archive") {
            el("p",parent,"Select all .tar parts of one daily readsb archive. The browser scans local files in a worker, searches the bounds below, then refines leading candidates with terrain. The aircraft type lookup and terrain tiles load when the search needs them.","dp-hint");
            const archiveFields=el("div",parent,undefined,"dp-fields"),o=this.state.archiveOptions;
            this.button(parent,"Index archive",async()=>{
                if(!this.archiveFiles?.length) throw new Error("Select all daily archive parts first.");
                const result=await this.job({type:"archive-index",input:{files:this.archiveFiles,
                    events:this.state.events,archiveOptions:o}},"Indexing archive");
                this.status(`Archive ready · ${result.dates.join(", ")} · ${result.stats.flights.toLocaleString()} aircraft · ${result.stats.samples.toLocaleString()} sparse fixes · ${(result.stats.indexBytes/1e6).toFixed(0)} MB index · ${result.elapsedSeconds.toFixed(1)} s. Index stays in memory while this window is open.`);
            });
            ["South latitude","West longitude","North latitude","East longitude"].forEach((label,i)=>this.field(archiveFields,o.bounds,i,label));
            for(const [key,label] of Object.entries({coarseStep:"Coarse grid step (m)",fineStep:"Final grid step (m)",keep:"Reported candidate limit",refineCount:"Candidate score maps"})) this.field(archiveFields,o,key,label);
            for(const [key,label] of [["excludeJets","Exclude known jet types; retain unknown types"],["allowBarometric","Allow approximate pressure altitude when geometric altitude is missing"]]) {
                const row=el("label",parent,undefined,"dp-field");el("span",row,label);
                const input=el("input",row);input.type="checkbox";input.checked=o[key];
                input.onchange=()=>{o[key]=input.checked;this.changed();};
            }
        }
        for(const [key,label] of Object.entries({timeTolerance:"Shared clock sweep ± seconds",timeStep:"Clock sweep step (s)",cpaTolerance:"CPA measurement tolerance (s)",maxGap:"Maximum flight fix gap (s)",traceSigma:"Trace error scale (Hz)",frequencySteps:"Minimum frequency samples (brightness)"})) this.field(fields,s,key,label);
        const silence=el("details",parent);el("summary",silence,"Optional silence constraint");
        el("p",silence,"Reject candidates with another close approach in these recording-time intervals. This assumes complete flight coverage and audible flights inside the chosen radius.","dp-hint");
        if(s.source==="archive") {
            const row=el("label",silence,undefined,"dp-field");
            el("span",row,"Include excluded aircraft types in silence checks (otherwise use event type filter)");
            const input=el("input",row);input.type="checkbox";input.checked=this.state.archiveOptions.silenceAllAircraft;
            input.onchange=()=>{this.state.archiveOptions.silenceAllAircraft=input.checked;this.changed();};
        }
        this.field(silence,s,"silenceRadiusM","Audible slant radius (m; 0 = furthest matched CPA)");
        const input=el("textarea",silence);input.rows=2;input.placeholder="For example: 120,900 (one start,end interval per line)";
        input.value=s.silence.map(w=>w.join(",")).join("\n");
        input.onchange=()=>{
            try {const windows=input.value.trim() ? input.value.trim().split(/\n/).map(l=>l.split(",").map(Number)) : [];
                if(windows.some(w=>w.length!==2 || !w.every(Number.isFinite) || w[0]>=w[1])) throw new Error("Use start,end seconds on each silence line.");
                s.silence=windows;this.changed();
            } catch(e) {this.status(e.message);}
        };
        const details=el("details",parent);el("summary",details,"Spectrogram settings (apply when loading audio)");
        this.audioOptions=this.state.audioOptions;
        for(const [key,label] of Object.entries({windowSeconds:"FFT window (s)",hop:"Time step (s)",maxHz:"Maximum frequency (Hz)"})) this.field(details,this.audioOptions,key,label,{changed:false});
    }
    updateDataSummary() {
        if(this.dataSummary) this.dataSummary.textContent=`${this.audioName ?? "No audio loaded"} · ${this.state.tracks.length} flights · ${this.state.tracks.reduce((n,t)=>n+t.points.length,0).toLocaleString()} fixes${this.archiveFiles ? ` · ${this.archiveFiles.length} archive parts (${(this.archiveFiles.reduce((n,f)=>n+f.size,0)/1e9).toFixed(2)} GB)` : ""}`;
    }
    buildEvents(parent) {
        parent.replaceChildren();
        const bar=el("div",parent,undefined,"dp-toolbar");
        const select=el("select",bar);
        this.state.events.forEach((e,i)=>{const o=el("option",select,`Event ${i+1} · ${e.cpa.toFixed(1)} s`);o.value=i;});
        select.value=this.selectedEvent;select.onchange=()=>{this.selectedEvent=Number(select.value);this.buildEvents(parent);this.draw();};
        this.button(bar,"Add event",()=>{
            if(this.state.events.length>=4) throw new Error("Use at most four events.");
            this.state.events.push(newEvent(this.state.events.at(-1).cpa+120));this.selectedEvent=this.state.events.length-1;
            this.changed();this.buildEvents(parent);this.draw();
        });
        this.button(bar,"Remove event",()=>{
            if(this.state.events.length===1) return;
            this.state.events.splice(this.selectedEvent,1);this.selectedEvent=0;this.changed();this.buildEvents(parent);this.draw();
        });
        const e=this.state.events[this.selectedEvent],fields=el("div",parent,undefined,"dp-fields");
        for(const [key,label] of Object.entries({cpa:"Heard CPA (recording seconds)",start:"Window start (s)",end:"Window end (s)",frequency:"Emitted fundamental (Hz)",frequencyTolerance:"Fundamental sweep ± Hz",harmonic:"Traced harmonic number",speedMin:"Minimum speed (m/s)",speedMax:"Maximum speed (m/s)",rangeMin:"Minimum CPA slant (m)",rangeMax:"Maximum CPA slant (m)"})) this.field(fields,e,key,label);
        const plotbar=el("div",parent,undefined,"dp-toolbar");
        this.traceButton=this.button(plotbar,"Trace ridge",()=>{this.tracing=!this.tracing;this.traceButton.setAttribute("aria-pressed",String(this.tracing));});
        this.button(plotbar,"Undo point",()=>{e.trace.pop();this.changed();});
        this.button(plotbar,"Clear trace",()=>{e.trace=[];this.changed();});
        this.traceInfo=el("span",plotbar);
        this.flightInfo=el("p",parent,undefined,"dp-flight-info");
        this.canvas=el("canvas",parent,undefined,"dp-spectrum");this.canvas.height=330;this.canvas.width=1000;
        // Pointer capture makes a stroke continue cleanly through a panel edge.
        this.traceCleanup?.();
        this.traceCleanup=registerSurfaceInteraction(this.canvas,{
            model:this,intent:{zIndex:1201},capture:()=>this.canvas,
            hitTest:()=>this.tracing ? {} : null,
            begin:event=>this.addTracePoint(event),move:event=>this.addTracePoint(event),end:()=>{},
        });
        el("p",parent,"Enable Trace ridge, then click or drag along one harmonic. Cyan points are your observations. Amber is an ideal curve using the midpoint of your bounds; red is the selected flight prediction. Each event uses seconds from the start of the same recording.","dp-hint");
    }
    addTracePoint(event) {
        const r=this.canvas.getBoundingClientRect(),x=(event.clientX-r.left)*this.canvas.width/r.width,y=(event.clientY-r.top)*this.canvas.height/r.height;
        const axes=this.axes;if(!axes || x<55 || x>980 || y<15 || y>295) return;
        const e=this.state.events[this.selectedEvent];
        const time=e.start+(x-55)/925*(e.end-e.start), frequency=axes.high-(y-15)/280*(axes.high-axes.low);
        e.trace=e.trace.filter(p=>Math.abs(p.time-time)>Math.max(0.15,(e.end-e.start)/300));
        e.trace.push({time,frequency});this.changed();
    }
    buildResults(parent) {
        this.resultSummary=el("p",parent,"No search has run.");
        const bar=el("div",parent,undefined,"dp-toolbar");
        this.button(bar,"Export result CSV",()=>{
            if(!this.result?.results.length) throw new Error("Run a successful search first.");
            saveAs(new Blob([resultsCSV(this.result.results)],{type:"text/csv"}),"DopplerLocations.csv");
        });
        this.button(bar,"Export labelled PNG",async()=>{
            if(!this.selectedResult) throw new Error("Select a candidate result first.");
            if(!this.spectrogram) throw new Error("Load the original audio before exporting its spectrogram.");
            const revision=this.revision;
            this.status("Rendering labelled candidate report…");
            const {renderDopplerReport}=await import(/* webpackChunkName: "doppler-report" */ "./DopplerReport");
            if(this.disposed || revision!==this.revision) return;
            const canvas=renderDopplerReport({state:this.state,result:this.result,selectedResult:this.selectedResult,spectrogram:this.spectrogram,audioName:this.audioName});
            const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value ? resolve(value) : reject(new Error("Could not encode the candidate report image.")),"image/png"));
            if(this.disposed) return;
            saveAs(blob,"DopplerCandidateReport.png");this.status("Labelled candidate report exported.");
        });
        this.button(bar,"Refine selected",()=>{
            const r=this.selectedResult;if(!r) throw new Error("Select a result first.");
            if(this.state.settings.source==="archive") {
                if(!this.archiveFiles?.length) throw new Error("Reselect the saved daily archive files before refining this candidate.");
                this.changed();this.archiveRefinement={candidate:copy(r)};
                return this.run();
            }
            const s=this.state.settings;s.lat=r.lat;s.lon=r.lon;s.radiusM=s.spacingM*2;s.spacingM=Math.max(10,s.spacingM/5);
            s.altitudeM=r.altitudeM;s.recordingStart=new Date(r.recordingStart*1000).toISOString();
            this.changed();this.buildData(this.pages["Data & search"].page);return this.run();
        });
        this.button(bar,"Clear scene marker",()=>this.clearMarker());
        this.map=el("canvas",parent,undefined,"dp-map");this.map.width=1000;this.map.height=300;
        this.table=el("div",parent,undefined,"dp-results");
        el("p",parent,"Scores rank the supplied flight data and measurements; they are not probabilities or location-accuracy guarantees. Compare multiple flight pairs and inspect both curve overlays before refining.","dp-hint");
    }
    async job(data,label,transfer=[]) {
        if(!isAdmin()) throw new Error("Doppler geolocation is available to admins only.");
        this.stop();const revision=this.revision;
        this.runButton.disabled=true;this.stopButton.disabled=false;
        return new Promise((resolve,reject)=>{
            const persistent=data.type.startsWith("archive-");
            const worker=(persistent && this.archiveWorker) || new Worker(new URL("./DopplerWorker.js",import.meta.url));
            if(persistent) this.archiveWorker=worker;
            this.activeJob={worker,reject};
            const finish=()=>{if(!persistent) worker.terminate();if(this.activeJob?.worker===worker) this.activeJob=null;this.runButton.disabled=false;this.stopButton.disabled=true;};
            worker.onmessage=({data:message})=>{
                if(revision!==this.revision) return;
                if(message.type==="progress") this.status(`${message.value.phase ?? label}: ${message.value.done.toLocaleString()} / ${message.value.total.toLocaleString()}${message.value.combinations!==undefined ? ` · ${message.value.combinations.toLocaleString()} flight combinations` : ""}`);
                else {finish();if(message.type==="error") reject(new Error(message.message));else resolve(message.value);}
            };
            worker.onerror=error=>{finish();reject(new Error(error.message || "Doppler worker failed."));};
            worker.postMessage(data,transfer);
        });
    }
    stop() {
        this.revision++;
        if(this.activeJob) {
            if(this.archiveWorker===this.activeJob.worker) this.archiveWorker=null;
            this.activeJob.worker.terminate();this.activeJob.reject(new Error("Stopped."));this.activeJob=null;
        }
        if(this.runButton) this.runButton.disabled=false;
        if(this.stopButton) this.stopButton.disabled=true;
    }
    async loadAudio(file) {
        this.stop();const revision=this.revision;
        this.status("Decoding audio…");
        const context=new AudioContext();let decoded;
        try {decoded=await context.decodeAudioData(await file.arrayBuffer());} finally {await context.close();}
        if(revision!==this.revision || this.disposed) return;
        if(decoded.duration>7200) throw new Error("Load at most two hours of audio at once.");
        // Browser resampling includes an anti-alias filter before the low-rate
        // FFT. Simply keeping every Nth sample would create false ridges.
        const sampleRate=4096;
        const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*sampleRate),sampleRate);
        const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
        const buffer=await offline.startRendering();
        if(revision!==this.revision || this.disposed) return;
        const samples=buffer.getChannelData(0).slice();
        const options={...this.audioOptions};
        this.spectrogram=await this.job({type:"spectrogram",samples,sampleRate,options},"Analysing audio",[samples.buffer]);
        this.loadedAudioOptions=options;
        const preserveResult=canPreserveAudioResult(this.result,this.state.settings.mode,
            this.sameFiles([file],[this.state.provenance?.audio]),options);
        this.audioName=file.name;(this.state.provenance ??= {}).audio=this.fileInfo(file);
        if(preserveResult) {this.save();markSitchDirty();this.draw();} else this.changed();
        this.updateDataSummary();
        this.status(`Audio ready · ${this.spectrogram.duration.toFixed(1)} s · ${this.spectrogram.binHz.toFixed(3)} Hz bins. Mark each flyover in the Flyovers tab.`);
        this.showPage("Flyovers");
    }
    useSitrecTracks() {
        const tracks=[];
        TrackManager.iterate((id,entry)=>{
            const node=entry.trackNode;if(!node || node.frames<2) return;
            const span=node.getDataFrameSpan?.() ?? {first:0,last:node.frames-1};
            const first=Math.max(0,Math.ceil(span.first)),last=Math.min(node.frames-1,Math.floor(span.last));
            const stride=Math.max(1,Math.round(Sit.fps/(Sit.simSpeed ?? 1)));
            const points=[];
            const read=f=>{
                const value=node.v(f);if(!value?.position) return;
                const lla=ECEFToLLAVD_radii(value.position);
                points.push({time:GlobalDateTimeNode.frameToMS(f)/1000,lat:lla.x,lon:lla.y,altitudeM:lla.z});
            };
            for(let f=first;f<=last;f+=stride) read(f);
            if((last-first)%stride) read(last);
            if(points.length>=2) tracks.push({id:String(id),points});
        });
        if(!tracks.length) throw new Error("No loaded data tracks. Import flight tracks through Sitrec first, or load a flight CSV here.");
        this.state.settings.source="tracks";
        this.state.tracks=tracks;this.changed();this.updateDataSummary();this.buildData(this.pages["Data & search"].page);
        this.status(`Copied ${tracks.length} tracks with the current Sitrec time offsets.`);
    }
    async loadAnalysis(file) {
        const state=JSON.parse(await file.text());if(this.disposed) return;
        this.replaceState(state);
        this.status(`${this.result ? "Analysis and saved candidate results restored." : "Analysis restored."} Reload audio for the spectrogram; reselect archive files before another archive search.`);
    }
    replaceState(state) {
        const validated=validateAnalysis(state);
        this.stop();this.spectrogram=null;this.loadedAudioOptions=null;this.audioName=null;this.archiveFiles=null;
        this.state=validated;this.selectedEvent=0;this.result=null;this.selectedResult=null;this.archiveRefinement=null;this.clearMarker();
        this.save();markSitchDirty();this.table.replaceChildren();this.resultSummary.textContent="No search has run.";
        this.buildData(this.pages["Data & search"].page);this.buildEvents(this.pages.Flyovers.page);this.restoreResults();this.draw();
    }
    fileInfo(file) {return {name:file.name,size:file.size,lastModified:file.lastModified};}
    sameFiles(files,saved) {return saved?.length===files.length && files.every(file=>saved.some(f=>f && f.name===file.name && f.size===file.size && f.lastModified===file.lastModified));}
    restoreResults() {
        const saved=this.state.savedResult;if(!saved) return;
        this.result={...copy(saved),heat:[],tracks:this.state.tracks};
        this.renderResults(saved.selectedIndex);this.showPage("Results");
    }
    async run() {
        const settings={...this.state.settings};
        const raw=String(settings.recordingStart ?? "").trim();
        settings.recordingStart=raw ? /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? Date.parse(raw)/1000 : NaN : null;
        const input={settings,events:copy(this.state.events),tracks:this.state.tracks};
        if(settings.mode==="brightness") input.spectrogram=this.spectrogram;
        if(settings.source==="archive") {
            if(!this.archiveFiles?.length) throw new Error("Select the daily archive and all its split parts first.");
            // Validate measurements before scanning gigabytes. Discovery supplies
            // tracks later; this placeholder is never passed to the solver.
            validateSearch({...input,tracks:[{}]});
            const refineCandidate=this.archiveRefinement?.candidate;
            try {
                this.result=await this.job({type:"archive-search",input:{...input,files:this.archiveFiles,refineCandidate,
                    archiveOptions:this.state.archiveOptions,geoidURL:SITREC_APP+"data/egm96/egm96-15.bin"}},"Searching archive");
            } finally {this.archiveRefinement=null;}
            this.result.completedAtUTC=new Date().toISOString();
            if(this.loadedAudioOptions) this.result.audioOptions={...this.loadedAudioOptions};
            this.state.tracks=this.result.tracks;this.save();markSitchDirty();this.updateDataSummary();
            this.renderResults();this.showPage("Results");
            this.status(`Archive search finished in ${this.result.elapsedSeconds.toFixed(1)} s · ${this.result.stats.flights.toLocaleString()} flights · ${this.result.stats.combinations.toLocaleString()} candidate pairs.`);
            return;
        }
        validateSearch(input);
        if(settings.elevation==="terrain") {
            const map=NodeMan.get("TerrainModel",false)?.elevationMap;
            if(!map) throw new Error("No terrain loaded. Load terrain covering the search or choose a fixed HAE altitude.");
            input.grid=makeGrid(settings).map(p=>{
                const info=map.getElevationWithTileInfo(p.lat,p.lon);
                if(info.tileZ<8) throw new Error("The whole search needs loaded terrain at zoom 8 or finer. Reduce the region or load more terrain.");
                return {...p,altitudeM:info.elevation};
            });
        }
        this.result=await this.job({type:"search",input},"Searching locations");
        this.result.completedAtUTC=new Date().toISOString();
        if(this.loadedAudioOptions) this.result.audioOptions={...this.loadedAudioOptions};
        this.renderResults();this.showPage("Results");
        this.status(`Finished · ${this.result.stats.passed.toLocaleString()} grid points scored · ${this.result.stats.combinations.toLocaleString()} flight combinations.`);
    }
    renderResults(selectedIndex=0) {
        const results=this.result.results;
        this.resultSummary.textContent=`${this.result.stats.passed.toLocaleString()} candidate points scored. ${results.length ? "Select a row to show its prediction and scene marker." : "No match. Check track coverage, event windows and filtering bounds."}`;
        this.table.replaceChildren();
        const table=el("table",this.table),head=el("tr",el("thead",table));
        for(const title of ["Rank","Latitude","Longitude","Score","Flights","Recording start UTC"]) el("th",head,title);
        const body=el("tbody",table);
        results.forEach((r,i)=>{
            const row=el("tr",body);row.tabIndex=0;
            for(const text of [i+1,r.lat.toFixed(6),r.lon.toFixed(6),r.score.toFixed(3),r.events.map(e=>e.flight).join(" / "),new Date(r.recordingStart*1000).toISOString()]) el("td",row,text);
            row.onclick=()=>this.selectResult(r,row);
            row.onkeydown=e=>{if(e.key==="Enter") this.selectResult(r,row);};
        });
        if(results.length) this.selectResult(results[selectedIndex] ?? results[0],body.children[selectedIndex] ?? body.firstChild);
        else this.save();
        this.drawMap();
    }
    selectResult(result,row) {
        this.selectedResult=result;
        for(const r of this.table.querySelectorAll("tr")) r.classList.toggle("selected",r===row);
        this.clearMarker();
        const p=LLAToECEF(result.lat,result.lon,result.altitudeM+20);
        const geometry=new BufferGeometry();geometry.setAttribute("position",new Float32BufferAttribute([p.x,p.y,p.z],3));
        this.marker=new Points(geometry,new PointsMaterial({color:0xff6363,size:15,sizeAttenuation:false,depthTest:false}));
        this.marker.layers.enableAll();this.marker.renderOrder=999;GlobalScene.add(this.marker);setRenderOne(true);this.draw();
        this.save();markSitchDirty();
    }
    clearMarker() {if(this.marker) {this.marker.removeFromParent();this.marker.geometry.dispose();this.marker.material.dispose();this.marker=null;setRenderOne(true);}}
    draw() {if(this.canvas) this.drawSpectrum();if(this.map) this.drawMap();}
    drawSpectrum() {
        const ctx=this.canvas.getContext("2d"),e=this.state.events[this.selectedEvent];
        ctx.fillStyle="#0b1220";ctx.fillRect(0,0,1000,330);
        const low=Math.max(0,e.frequency*e.harmonic*0.55),high=e.frequency*e.harmonic*1.6;
        this.axes={low,high};
        const x=t=>55+(t-e.start)/(e.end-e.start)*925,y=f=>15+(high-f)/(high-low)*280;
        const spec=this.spectrogram;
        if(spec && e.start<e.end) {
            const image=ctx.createImageData(925,280);
            for(let px=0;px<925;px++) {
                const column=Math.round((e.start+(px/925)*(e.end-e.start)-spec.start)/spec.hop);
                for(let py=0;py<280;py++) {
                    const bin=Math.round((high-py/280*(high-low))/spec.binHz),i=(py*925+px)*4;
                    const v=column>=0 && column<spec.columns && bin>=0 && bin<spec.bins ? Math.max(0,Math.min(1,(spec.values[column*spec.bins+bin]+1)/5)) : 0;
                    image.data[i]=255*v;image.data[i+1]=230*v;image.data[i+2]=Math.min(255,20+150*v);image.data[i+3]=255;
                }
            }
            ctx.putImageData(image,55,15);
        }
        ctx.save();ctx.beginPath();ctx.rect(55,15,925,280);ctx.clip();
        const line=(color,fn)=>{
            ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();let started=false;
            for(let i=0;i<=250;i++) {const t=e.start+(e.end-e.start)*i/250,f=fn(t);
                if(!Number.isFinite(f)) {started=false;continue;}
                if(!started) ctx.moveTo(x(t),y(f));else ctx.lineTo(x(t),y(f));started=true;
            }ctx.stroke();
        };
        if(e.rangeMax>0 && e.speedMax>0 && e.speedMin>=0 && e.speedMax<this.state.settings.soundSpeed*0.98 && this.state.settings.soundSpeed>0) line("#e7b66c",t=>idealFrequency(t-e.cpa,e.frequency,(e.speedMin+e.speedMax)/2,Math.max(1,(e.rangeMin+e.rangeMax)/2),this.state.settings.soundSpeed)*e.harmonic);
        const r=this.selectedResult,re=r?.events[this.selectedEvent];
        if(this.flightInfo) {this.flightInfo.hidden=true;this.flightInfo.textContent="";}
        if(re) {
            const track=this.state.tracks.find(t=>t.id===re.flight);
            if(track) {
                const identity=[track.callsign,track.aircraftType,track.registration,track.id.toUpperCase()].filter(Boolean).join(" · ");
                const details=[`${re.frequency.toFixed(2)} Hz fundamental`,
                    Number.isFinite(re.rangeM) ? `${Math.round(re.rangeM).toLocaleString()} m closest slant` : null,
                    Number.isFinite(re.speedMS) ? `${re.speedMS.toFixed(1)} m/s` : null,
                    Number.isFinite(re.cpaArrival) ? `Sound CPA ${new Date(re.cpaArrival*1000).toISOString()}` : null].filter(Boolean);
                if(this.flightInfo) {this.flightInfo.hidden=false;this.flightInfo.textContent=`Selected candidate: ${identity}\n${details.join(" · ")}`;}
                const c=this.state.settings.soundSpeed,view=observerTrack(prepareTrack(track,c,this.state.settings.maxGap),toECEF(r.lat,r.lon,r.altitudeM),c);
                line("#ff6363",t=>atArrival(view,r.recordingStart+t,c)?.factor*re.frequency*e.harmonic);
            }
        }
        ctx.fillStyle="#5cf4eb";
        for(const p of e.trace) {ctx.beginPath();ctx.arc(x(p.time),y(p.frequency),3,0,2*Math.PI);ctx.fill();}
        ctx.restore();ctx.fillStyle="#d6dfed";ctx.font="13px system-ui";
        for(let i=0;i<=5;i++) {const t=e.start+(e.end-e.start)*i/5;ctx.fillText(`${t.toFixed(1)}s`,x(t)-15,318);const f=low+(high-low)*i/5;ctx.fillText(f.toFixed(0),5,y(f)+4);}
        if(this.traceInfo) this.traceInfo.textContent=`${e.trace.length} trace points${re?.rmsHz!==undefined ? ` · fit RMS ${re.rmsHz.toFixed(3)} Hz` : ""}`;
    }
    drawMap() {
        const ctx=this.map.getContext("2d"),s=this.state.settings;
        ctx.fillStyle="#0b1220";ctx.fillRect(0,0,1000,300);
        const heat=this.result?.heat?.length ? this.result.heat : this.result?.results;if(!heat?.length) return;
        const scores=heat.map(p=>p.score).sort((a,b)=>a-b),min=scores[Math.floor(scores.length*0.1)],max=scores.at(-1);
        const view=resultMapViewport(this.result,s),step=s.source==="archive" ? this.state.archiveOptions.fineStep : s.spacingM;
        const size=Math.min(24,Math.max(3,step/view.metresPerPixel));
        for(const p of heat) {const {x,y}=view.project(p),v=Math.max(0,Math.min(1,(p.score-min)/(max-min || 1)));ctx.fillStyle=`hsl(${240-v*240} 90% ${25+v*35}%)`;ctx.fillRect(x-size/2,y-size/2,size,size);}
        if(this.selectedResult) {const {x,y}=view.project(this.selectedResult);ctx.strokeStyle="white";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,7,0,2*Math.PI);ctx.stroke();}
        ctx.fillStyle="white";ctx.font="13px system-ui";ctx.fillText("North ↑ · red = better fit · unscored points are blank",15,25);
        const scale=10**Math.floor(Math.log10(view.metresPerPixel*100)),width=scale/view.metresPerPixel;
        ctx.strokeStyle="white";ctx.beginPath();ctx.moveTo(15,277);ctx.lineTo(15+width,277);ctx.stroke();
        ctx.fillText(scale>=1000 ? `${scale/1000} km` : `${scale} m`,15,294);
        ctx.textAlign="right";ctx.fillText(`Centre ${view.lat.toFixed(4)}°, ${view.lon.toFixed(4)}°`,985,294);ctx.textAlign="left";
    }
    show() {if(!isAdmin()) return;this.panel.hidden=false;this.panel.focus();this.draw();}
    hide() {this.stop();this.archiveWorker?.terminate();this.archiveWorker=null;getInteractionRouter(this.panel.ownerDocument).cancelOwner(this);this.panel.hidden=true;this.clearMarker();}
    dispose() {
        this.disposed=true;this.stop();this.archiveWorker?.terminate();this.archiveWorker=null;this.clearMarker();this.resizeObserver?.disconnect();this.traceCleanup?.();
        getInteractionRouter(this.panel.ownerDocument).cancelOwner(this);
        this.cleanups.forEach(fn=>fn());this.panel.remove();this.spectrogram=null;
    }
}
