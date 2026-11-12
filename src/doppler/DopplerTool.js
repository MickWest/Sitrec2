import {BufferGeometry,Float32BufferAttribute,Points,PointsMaterial} from "three";
import {saveAs} from "file-saver";
import {GlobalDateTimeNode,markSitchDirty,NodeMan,setRenderOne,Sit,TrackManager} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {LLAToECEF,ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {blockViewEvents} from "../DragResizeUtils";
import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {getInteractionRouter} from "../InteractionRouter";
import {SITREC_APP} from "../configUtils";
import {canUseDopplerGeolocation} from "./DopplerAccess";
import {par} from "../par";
import {atArrival,idealFrequency,observerTrack,prepareTrack,toECEF} from "./DopplerModel";
import {makeGrid,newEvent,SEARCH_DEFAULTS,validateSearch} from "./DopplerSearch";
import {parseFlightCSV,resultsCSV} from "./DopplerImport";
import {makeDemo} from "./DopplerDemo";
import {canPreserveAudioResult,compactSearchResult,resultMapViewport,validateAnalysis} from "./DopplerAnalysis";
import {candidateRows} from "./DopplerCandidates";
import {addHarmonicTracePoint,materializeTraceHarmonics,spectrumFrequencyRange,spectrumHarmonicCounts,spectrumLayout,spectrumTracePoint} from "./DopplerSpectrumLayout";
import {familyFrequency} from "./DopplerTrace";
import {soundSpeedText,verdictText} from "./DopplerVerdict";
import "./doppler.css";

// The bundled ICAO type list (Mictronics aircraft database, ODC-By; see data/aircraft/README.md).
// The archive worker cannot read SITREC_APP, so each archive request carries the URL.
const aircraftTypesURL=()=>SITREC_APP+"data/aircraft/icao_aircraft_types.json";

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
        this.selectedEvent=0;this.cleanups=[];this.revision=0;this.frequencyView=null;
        // Display-only overlay switches; never saved with the analysis.
        this.overlays={trace:true,preview:true,candidate:true,reference:true};
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
        this.referenceResult=null;this.referenceSelection=null;this.referenceOutput?.replaceChildren();
        this.clearMarker();this.save();markSitchDirty();this.draw();
        this.resultSummary.textContent="Inputs changed. Run the search to update results.";
        this.table.replaceChildren();
    }
    status(text) {if(!this.disposed) this.statusElement.textContent=text;}
    button(parent,label,action) {
        const b=el("button",parent,label);b.type="button";
        b.onclick=()=>Promise.resolve().then(action).catch(e=>this.status(e.message));return b;
    }
    field(parent,object,key,label,{type="number",step="any",changed=true,beforeChange}={}) {
        const row=el("label",parent,undefined,"dp-field");el("span",row,label);
        const input=el("input",row);input.type=type;input.step=step;input.value=object[key] ?? "";
        input.onchange=()=>{
            if(type==="number" && (!input.value.trim() || !Number.isFinite(input.valueAsNumber))) {input.value=object[key];return;}
            const next=type==="number" ? input.valueAsNumber : input.value;
            try {beforeChange?.(next,object[key]);} catch(error) {input.value=object[key];this.status(error.message);return;}
            object[key]=next;
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
        panel.setAttribute("role","dialog");panel.setAttribute("aria-label","Doppler geolocation");panel.setAttribute("aria-modal","true");panel.tabIndex=-1;
        blockViewEvents(panel);
        panel.addEventListener("keydown",e=>{e.stopPropagation();if(e.key==="Escape") this.hide();});
        const header=el("header",panel);
        el("h2",header,"Doppler geolocation");el("span",header,"Preview","dp-badge");
        this.button(header,"×",()=>this.hide()).setAttribute("aria-label","Close Doppler geolocation");
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
            const page=el("div",body,undefined,name==="Flyovers" ? "dp-events-page" : name==="Results" ? "dp-results-page" : "dp-data-page");this.pages[name]={page,button};
        }
        this.buildData(this.pages["Data & search"].page);
        this.buildEvents(this.pages.Flyovers.page);
        this.buildResults(this.pages.Results.page);
        const footer=el("footer",panel);
        this.statusElement=el("div",footer,"Load local audio and flight tracks, then mark the flyovers. Audio stays in this browser.","dp-status");
        this.runButton=this.button(footer,"Search locations",()=>this.run());
        this.stopButton=this.button(footer,"Stop",()=>{this.stop();this.status("Stopped.");});
        this.stopButton.disabled=true;
        this.resizeObserver=new ResizeObserver(()=>this.draw());this.resizeObserver.observe(panel);this.resizeObserver.observe(this.canvas);
        this.showPage("Data & search");
    }
    showPage(name) {
        if(name!=="Flyovers") this.cancelSpectrogramDetail();
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
        this.select(fields,"Trace residuals",s,"traceLoss",{squared:"Squared (least squares)",robust:"Robust (limits outlying points)"});
        if(s.source==="archive") {
            el("p",parent,"Select all .tar parts of one daily readsb archive. The browser scans local files in a worker, searches the bounds below, then refines leading candidates with terrain. The aircraft type list and terrain tiles load when the search needs them. Aircraft types: Mictronics aircraft database, ODC Attribution License.","dp-hint");
            const archiveFields=el("div",parent,undefined,"dp-fields"),o=this.state.archiveOptions;
            this.button(parent,"Index archive",async()=>{
                if(!this.archiveFiles?.length) throw new Error("Select all daily archive parts first.");
                const result=await this.job({type:"archive-index",input:{files:this.archiveFiles,
                    events:this.state.events,archiveOptions:{...o,typesURL:aircraftTypesURL()}}},"Indexing archive");
                this.status(`Archive ready · ${result.dates.join(", ")} · ${result.stats.flights.toLocaleString()} aircraft · ${result.stats.samples.toLocaleString()} sparse fixes · ${(result.stats.indexBytes/1e6).toFixed(0)} MB index · ${result.elapsedSeconds.toFixed(1)} s. Index stays in memory while this window is open.`);
            });
            ["South latitude","West longitude","North latitude","East longitude"].forEach((label,i)=>this.field(archiveFields,o.bounds,i,label));
            for(const [key,label] of Object.entries({coarseStep:"Coarse grid step (m)",fineStep:"Final grid step (m)",keep:"Reported candidate limit",refineCount:"Candidate score maps",
                soundSpeedCheck:"Sound-speed check (± m/s, 0 = off)",soundSpeedCheckPairs:"Pairs in sound-speed check"})) this.field(archiveFields,o,key,label);
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
        const reference=el("details",parent);el("summary",reference,"Check a known location");
        el("p",reference,"Use the search centre, listener height and recording UTC above as a supplied reference. This checks every loaded track against each traced event and shows failures of speed, slant and timing bounds. It does not find a location or identify the sound source. Archive files must first supply loaded tracks.","dp-hint");
        const referenceBar=el("div",reference,undefined,"dp-toolbar");
        this.button(referenceBar,"Check reference",()=>this.checkReference());
        this.button(referenceBar,"Clear reference overlay",()=>{this.referenceSelection=null;this.draw();});
        this.button(referenceBar,"Export reference check",()=>{
            if(!this.referenceResult) throw new Error("Check a known reference first.");
            saveAs(new Blob([JSON.stringify(this.referenceResult,null,2)],{type:"application/json"}),"DopplerReferenceCheck.json");
        });
        this.referenceOutput=el("div",reference,undefined,"dp-reference-results");
        if(this.referenceResult) this.renderReference();
    }
    updateDataSummary() {
        if(this.dataSummary) this.dataSummary.textContent=`${this.audioName ?? "No audio loaded"} · ${this.state.tracks.length} flights · ${this.state.tracks.reduce((n,t)=>n+t.points.length,0).toLocaleString()} fixes${this.archiveFiles ? ` · ${this.archiveFiles.length} archive parts (${(this.archiveFiles.reduce((n,f)=>n+f.size,0)/1e9).toFixed(2)} GB)` : ""}`;
    }
    buildEvents(parent) {
        parent.replaceChildren();
        const bar=el("div",parent,undefined,"dp-toolbar dp-event-selector");
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
        const controls=el("aside",parent,undefined,"dp-event-controls");
        el("p",controls,"Mark flyover windows manually. Loading audio does not detect or count aircraft.","dp-hint");
        const e=this.state.events[this.selectedEvent],fields=el("div",controls,undefined,"dp-fields");
        e.family??=0;
        const integerLimits={harmonic:[1,16,"Choose an integer harmonic from 1 to 16."],family:[0,7,"Choose an integer tone family from 0 (main) to 7."]};
        for(const [key,label] of Object.entries({cpa:"Heard CPA (recording seconds)",start:"Window start (s)",end:"Window end (s)",frequency:"Emitted fundamental (Hz)",frequencyTolerance:"Fundamental sweep ± Hz",harmonic:"New point harmonic",family:"New point tone family (0 = main)",speedMin:"Minimum speed (m/s)",speedMax:"Maximum speed (m/s)",rangeMin:"Minimum CPA slant (m)",rangeMax:"Maximum CPA slant (m)"})) {
            const limits=integerLimits[key];
            const input=this.field(fields,e,key,label,limits ? {step:1,beforeChange:next=>{
                if(!Number.isInteger(next)||next<limits[0]||next>limits[1]) throw new Error(limits[2]);
                materializeTraceHarmonics(e);
            }} : {});
            if(limits) {input.min=limits[0];input.max=limits[1];}
        }
        const help=el("details",controls,undefined,"dp-help");el("summary",help,"How to mark flyovers");
        el("p",help,"Set each event window around a flyover. Choose the harmonic for new points, enable Trace ridge, then follow a narrow observed line. Change the harmonic to mark a companion; earlier points retain their tags. All harmonics in one family share one emitted fundamental. A second tone family from the same aircraft, such as an engine beside a rotor, gets its own fitted fundamental but shares the flight geometry and clock. View min/max only change the display. All times use seconds from the start of the recording.","dp-hint");
        const workspace=el("div",parent,undefined,"dp-event-workspace");
        const plotbar=el("div",workspace,undefined,"dp-toolbar");
        this.traceButton=this.button(plotbar,"Trace ridge",()=>{this.tracing=!this.tracing;this.traceButton.setAttribute("aria-pressed",String(this.tracing));});
        this.button(plotbar,"Undo point",()=>{e.trace.pop();this.changed();});
        this.button(plotbar,"Clear trace",()=>{e.trace=[];this.changed();});
        this.traceInfo=el("span",plotbar);
        const viewbar=el("div",workspace,undefined,"dp-spectrum-view");
        const rangeInput=label=>{const row=el("label",viewbar,undefined,"dp-field");el("span",row,label);const input=el("input",row);input.type="number";input.min=0;input.step="any";return input;};
        this.viewMin=rangeInput("View min Hz");this.viewMax=rangeInput("View max Hz");
        this.viewMin.onchange=this.viewMax.onchange=()=>this.changeFrequencyView();
        this.button(viewbar,"Full FFT band",()=>{this.frequencyView=null;this.spectrumBackground=null;this.draw();});
        this.frequencyViewInfo=el("span",viewbar,undefined,"dp-view-range");
        this.flightInfo=el("p",workspace,undefined,"dp-flight-info");
        const plot=el("div",workspace,undefined,"dp-spectrum-wrap");
        if(this.canvas) this.resizeObserver?.unobserve(this.canvas);
        this.canvas=el("canvas",plot,undefined,"dp-spectrum");this.canvas.height=330;this.canvas.width=1000;
        this.resizeObserver?.observe(this.canvas);this.spectrumBackground=null;
        this.detailInfo=el("p",workspace,undefined,"dp-hint dp-detail-info");
        // Pointer capture makes a stroke continue cleanly through a panel edge.
        this.traceCleanup?.();
        this.traceCleanup=registerSurfaceInteraction(this.canvas,{
            model:this,intent:{zIndex:1201},capture:()=>this.canvas,
            hitTest:()=>this.tracing ? {} : null,
            begin:event=>this.addTracePoint(event),move:event=>this.addTracePoint(event),end:()=>{},
        });
        // The legend doubles as the overlay switches, so the raw spectrogram can be inspected.
        const legend=el("div",workspace,undefined,"dp-spectrum-legend");
        for(const [key,text,className] of [["trace","● Your trace, tagged by harmonic","dp-legend-trace"],["preview","━ Yellow: model preview, not a detection","dp-legend-model"],
            ["candidate","━ Red: selected search candidate","dp-legend-candidate"],["reference","━ Purple: supplied-reference check","dp-legend-reference"]]) {
            const item=el("label",legend,undefined,className),input=el("input",item);
            input.type="checkbox";input.checked=this.overlays[key];input.title="Show or hide this overlay";
            input.onchange=()=>{this.overlays[key]=input.checked;this.draw();};
            el("span",item,text);
        }
    }
    addTracePoint(event) {
        const r=this.canvas.getBoundingClientRect(),axes=this.axes;if(!axes) return;
        const borderX=this.canvas.clientLeft,borderY=this.canvas.clientTop;
        const x=(event.clientX-r.left-borderX)*axes.width/Math.max(1,r.width-2*borderX),y=(event.clientY-r.top-borderY)*axes.height/Math.max(1,r.height-2*borderY);
        const e=this.state.events[this.selectedEvent];
        const point=spectrumTracePoint(axes,e,x,y,axes.low,axes.high);if(!point) return;
        if(addHarmonicTracePoint(e,point,Math.max(0.15,(e.end-e.start)/300))) this.changed();
    }
    changeFrequencyView() {
        const band=spectrumFrequencyRange(this.spectrogram,null,this.audioOptions.maxHz),low=this.viewMin.valueAsNumber,high=this.viewMax.valueAsNumber;
        if(!Number.isFinite(low)||!Number.isFinite(high)||low<0||low>=high||high>band.recordedMaximum) {
            const current=spectrumFrequencyRange(this.spectrogram,this.frequencyView,this.audioOptions.maxHz);
            this.viewMin.value=current.low;this.viewMax.value=current.high;
            this.status(`Use 0 ≤ view minimum < maximum ≤ ${band.recordedMaximum.toFixed(2)} Hz.`);this.draw();return;
        }
        this.frequencyView={low,high};this.spectrumBackground=null;this.draw();
    }
    buildResults(parent) {
        this.resultSummary=el("p",parent,"No search has run.");
        this.resultContext=el("p",parent,"","dp-hint");
        const bar=el("div",parent,undefined,"dp-toolbar");
        this.button(bar,"View selected in Sitrec",()=>this.viewSelectedCandidate());
        this.button(bar,"Inspect curves",()=>this.showPage("Flyovers"));
        const grouping=el("label",bar,undefined,"dp-candidate-grouping"),distinct=el("input",grouping);
        distinct.type="checkbox";distinct.checked=true;this.distinctCandidates=true;
        el("span",grouping,"Group nearby matches for the same flights");
        distinct.onchange=()=>{this.distinctCandidates=distinct.checked;if(this.result) this.renderResults(this.result.results.indexOf(this.selectedResult));};
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
        this.map.onclick=event=>{
            if(!this.displayedCandidates?.length) return;
            const rect=this.map.getBoundingClientRect(),x=(event.clientX-rect.left)*1000/rect.width,y=(event.clientY-rect.top)*300/rect.height;
            const view=resultMapViewport(this.result,this.state.settings);
            const nearest=this.displayedCandidates.map(row=>{const p=view.project(row.candidate);return {row,distance:Math.hypot(x-p.x,y-p.y)};}).sort((a,b)=>a.distance-b.distance)[0];
            if(nearest.distance<20) this.selectResult(nearest.row.candidate,this.candidateElements.get(nearest.row.candidate));
        };
        this.table=el("div",parent,undefined,"dp-results");
        el("p",parent,"Scores rank the supplied flight data and measurements; they are not probabilities or location-accuracy guarantees. Compare multiple flight pairs and inspect both curve overlays before refining.","dp-hint");
    }
    async job(data,label,transfer=[]) {
        if(!canUseDopplerGeolocation()) throw new Error("Log in to use Doppler geolocation.");
        this.stop();const revision=this.revision;
        this.runButton.disabled=true;this.stopButton.disabled=false;
        return new Promise((resolve,reject)=>{
            const archive=data.type.startsWith("archive-"),audio=data.type==="spectrogram",persistent=archive || audio;
            const worker=(archive ? this.archiveWorker : audio ? this.audioWorker : null) || new Worker(new URL("./DopplerWorker.js",import.meta.url));
            if(archive) this.archiveWorker=worker;if(audio) this.audioWorker=worker;
            this.activeJob={worker,reject};
            const finish=()=>{if(!persistent) worker.terminate();if(this.activeJob?.worker===worker) this.activeJob=null;this.runButton.disabled=false;this.stopButton.disabled=true;};
            worker.onmessage=({data:message})=>{
                if(revision!==this.revision) return;
                if(message.type==="progress") this.status(`${message.value.phase ?? label}: ${message.value.done.toLocaleString()} / ${message.value.total.toLocaleString()}${message.value.combinations!==undefined ? ` · ${message.value.combinations.toLocaleString()} flight combinations` : ""}`);
                else {
                    finish();
                    if(message.type==="error") {
                        if(audio) {worker.terminate();if(this.audioWorker===worker) this.audioWorker=null;}
                        reject(new Error(message.message));
                    } else resolve(message.value);
                }
            };
            worker.onerror=error=>{finish();if(audio) {worker.terminate();if(this.audioWorker===worker) this.audioWorker=null;}reject(new Error(error.message || "Doppler worker failed."));};
            worker.postMessage(data,transfer);
        });
    }
    stop() {
        this.revision++;
        if(this.activeJob) {
            if(this.archiveWorker===this.activeJob.worker) this.archiveWorker=null;
            if(this.audioWorker===this.activeJob.worker) this.audioWorker=null;
            this.activeJob.worker.terminate();this.activeJob.reject(new Error("Stopped."));this.activeJob=null;
        }
        if(this.runButton) this.runButton.disabled=false;
        if(this.stopButton) this.stopButton.disabled=true;
    }
    async loadAudio(file) {
        this.stop();this.releaseAudioDetail();const revision=this.revision;
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
        this.loadedAudioOptions=options;this.frequencyView=null;
        this.bindAudioDetailWorker(this.audioWorker);
        const preserveResult=canPreserveAudioResult(this.result,this.state.settings.mode,
            this.sameFiles([file],[this.state.provenance?.audio]),options);
        this.audioName=file.name;(this.state.provenance ??= {}).audio=this.fileInfo(file);
        if(preserveResult) {this.save();markSitchDirty();this.draw();} else this.changed();
        this.updateDataSummary();
        this.status(`Audio ready · ${this.spectrogram.duration.toFixed(1)} s · ${this.spectrogram.binHz.toFixed(3)} Hz bins. Event 1 is a manual starting window; set its times and add the flyovers you want to compare.`);
        this.showPage("Flyovers");
    }
    cancelSpectrogramDetail() {
        clearTimeout(this.detailTimer);this.detailTimer=null;this.detailPending=null;
        this.detailRequestId=(this.detailRequestId ?? 0)+1;
        try {this.audioWorker?.postMessage({type:"spectrogram-detail-cancel"});} catch { /* A failed worker is released below. */ }
    }
    releaseAudioDetail() {
        this.cancelSpectrogramDetail();this.audioWorker?.terminate();this.audioWorker=null;
        this.detailSpectrogram=null;this.detailFailure=null;this.spectrumBackground=null;
    }
    bindAudioDetailWorker(worker) {
        if(!worker) return;
        worker.onmessage=({data:message})=>{
            const pending=this.detailPending;
            if(this.disposed || this.audioWorker!==worker || !pending || message.requestId!==pending.id) return;
            if(message.type==="spectrogram-detail") {
                this.detailSpectrogram={...message.value,key:pending.key};this.detailFailure=null;this.detailPending=null;
            } else if(message.type==="spectrogram-detail-error") {
                this.detailFailure={key:pending.key,message:message.message};this.detailPending=null;
            } else return;
            this.drawSpectrum();
        };
        worker.onerror=error=>{
            if(this.audioWorker!==worker) return;
            this.releaseAudioDetail();
            if(this.detailInfo) this.detailInfo.textContent=`Visible detail unavailable: ${error.message || "audio worker failed"}. Reload audio to retry.`;
        };
    }
    spectrumDetailKey(event) {return `${event.start}/${event.end}/${this.axes?.columns ?? 925}`;}
    queueSpectrogramDetail(event) {
        const whole=this.spectrogram,key=this.spectrumDetailKey(event),span=event.end-event.start;
        if(this.detailPending && this.detailPending.key!==key) this.cancelSpectrogramDetail();
        if(!whole || !Number.isFinite(span) || span<=0 || this.panel.hidden || this.pages.Flyovers.page.hidden) return;
        const columns=this.axes?.columns ?? 925;
        if(!this.audioWorker || whole.hop<=span/(columns-1) || this.detailSpectrogram?.key===key || this.detailPending?.key===key || this.detailFailure?.key===key) return;
        this.cancelSpectrogramDetail();
        const id=this.detailRequestId,worker=this.audioWorker;this.detailPending={key,id};
        this.detailTimer=setTimeout(()=>{
            this.detailTimer=null;
            if(this.disposed || this.audioWorker!==worker || this.detailPending?.id!==id || !canUseDopplerGeolocation()) {this.detailPending=null;return;}
            worker.postMessage({type:"spectrogram-detail",requestId:id,view:{start:event.start,end:event.end,columns}});
        },140);
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
        this.stop();this.releaseAudioDetail();this.spectrogram=null;this.loadedAudioOptions=null;this.audioName=null;this.archiveFiles=null;this.frequencyView=null;
        this.state=validated;this.selectedEvent=0;this.result=null;this.selectedResult=null;this.archiveRefinement=null;this.referenceResult=null;this.referenceSelection=null;this.clearMarker();
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
    async checkReference() {
        if(!this.state.tracks.length) throw new Error("Load flight tracks before checking a reference.");
        const settings={...this.state.settings},raw=String(settings.recordingStart ?? "").trim();
        settings.recordingStart=/(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? Date.parse(raw)/1000 : NaN;
        if(!Number.isFinite(settings.recordingStart)) throw new Error("Enter the known recording start UTC before checking a reference.");
        if(settings.elevation==="terrain") {
            const map=NodeMan.get("TerrainModel",false)?.elevationMap,info=map?.getElevationWithTileInfo(settings.lat,settings.lon);
            if(!info || info.tileZ<8) throw new Error("Load terrain at the reference, or choose Fixed listener height and supply its HAE altitude.");
            settings.altitudeM=info.elevation;
        }
        this.referenceResult=await this.job({type:"reference-check",input:{settings,events:copy(this.state.events),tracks:this.state.tracks}},"Checking reference");
        this.referenceSelection=null;
        this.renderReference();
        this.status("Reference check complete. Location and clock were fixed; failed bounds and missing coverage remain visible.");
    }
    renderReference() {
        this.referenceOutput.replaceChildren();
        const result=this.referenceResult;
        el("p",this.referenceOutput,"Calibration at supplied coordinates and UTC; no location search or source identification. Select a complete row to overlay its prediction in Flyovers.","dp-hint");
        for(const event of result.events) {
            el("strong",this.referenceOutput,event.name || `Event ${event.eventIndex+1}`);
            const wrap=el("div",this.referenceOutput,undefined,"dp-results dp-reference-table"),table=el("table",wrap),head=el("tr",el("thead",table));
            for(const title of ["Flight","RMS Hz","Source Hz","CPA slant km","CPA speed m/s","Bounds / coverage"]) el("th",head,title);
            const body=el("tbody",table),number=(v,n=2)=>Number.isFinite(v)?v.toFixed(n):"—";
            for(const row of event.rows) {
                const tr=el("tr",body),failed=Object.entries(row.checks ?? {}).filter(([,v])=>v?.pass===false).map(([key])=>key);
                const identity=row.identity;
                const label=typeof identity==="string"?identity:[identity?.callsign,identity?.registration,identity?.aircraftType,row.id].filter(Boolean).join(" / ");
                const status=(!row.complete?row.status:failed.length?`Outside: ${failed.join(", ")}`:"Within bounds; association unverified")+
                    (row.frequencyBounded?"; frequency reached bound":"")+(row.approximateNavigation?"; velocity partly estimated":"");
                for(const value of [label,number(row.rmsHz),number(row.frequency),number(row.cpaActual?.rangeM/1000),number(row.cpaActual?.speedMS),status]) el("td",tr,value);
                if(row.complete) {
                    tr.dataset.complete="true";tr.tabIndex=0;
                    const select=()=>{this.referenceSelection={eventIndex:event.eventIndex,row};this.selectedEvent=event.eventIndex;this.buildEvents(this.pages.Flyovers.page);this.showPage("Flyovers");};
                    tr.onclick=select;tr.onkeydown=e=>{if(e.key==="Enter") select();};
                }
            }
        }
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
                    archiveOptions:{...this.state.archiveOptions,typesURL:aircraftTypesURL()},
                    geoidURL:SITREC_APP+"data/egm96/egm96-15.bin"}},"Searching archive");
            } finally {this.archiveRefinement=null;}
            this.result.completedAtUTC=new Date().toISOString();
            if(this.loadedAudioOptions) this.result.audioOptions={...this.loadedAudioOptions};
            this.state.tracks=this.result.tracks;this.referenceResult=null;this.referenceSelection=null;this.referenceOutput?.replaceChildren();
            this.save();markSitchDirty();this.updateDataSummary();
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
        const rows=this.displayedCandidates=candidateRows(results,this.state.tracks,{distinct:this.distinctCandidates});
        const verdict=[verdictText(this.result.stats),soundSpeedText(this.result.stats)].filter(Boolean).join(" ");
        this.resultSummary.textContent=`${rows.length} displayed hypotheses from ${results.length} retained fits. ${results.length ? "Select a row or map number, then inspect its curves or view it in Sitrec." : "No match. Check track coverage, event windows and filtering bounds."}${verdict ? ` ${verdict}` : ""}`;
        this.resultContext.textContent=this.state.provenance?.status ?? this.state.provenance?.purpose ?? "Rank is relative to the retained candidates, not a probability that the location is correct.";
        this.table.replaceChildren();
        this.candidateElements=new Map();
        const table=el("table",this.table),head=el("tr",el("thead",table));
        for(const title of ["Shortlist #","Global replay rank","RMS (Hz)","Latitude","Longitude","Candidate aircraft","Recording start UTC","Notes"]) el("th",head,title);
        const body=el("tbody",table);
        rows.forEach(item=>{
            const r=item.candidate;
            const row=el("tr",body);row.tabIndex=0;
            const notes=[item.reviewNote,item.grouped>1 ? `${item.grouped} neighbouring fits grouped` : ""].filter(Boolean).join(" · ");
            for(const text of [item.rank,item.originalRank ?? "—",item.rmsHz===null ? "—" : item.rmsHz.toFixed(3),r.lat.toFixed(6),r.lon.toFixed(6),item.flights.join("\n"),new Date(r.recordingStart*1000).toISOString(),notes]) el("td",row,text);
            this.candidateElements.set(r,row);
            row.onclick=()=>this.selectResult(r,row);
            row.onkeydown=e=>{if(e.key==="Enter") this.selectResult(r,row);};
        });
        if(rows.length) {
            const desired=results[selectedIndex],selected=rows.find(item=>item.candidate===desired) ?? rows[0];
            this.selectResult(selected.candidate,this.candidateElements.get(selected.candidate));
        }
        else this.save();
        this.drawMap();
    }
    async viewSelectedCandidate() {
        if(!canUseDopplerGeolocation() || !this.selectedResult) throw new Error("Select a candidate first.");
        const revision=this.revision,candidate=this.selectedResult;
        const {DopplerScene}=await import(/* webpackChunkName: "doppler-scene" */ "./DopplerScene");
        if(this.disposed || revision!==this.revision || candidate!==this.selectedResult || !canUseDopplerGeolocation()) return;
        this.scenePreview ??= new DopplerScene();
        const rank=this.result.results.indexOf(candidate)+1;
        const info=await this.scenePreview.show({candidate,rank,events:this.state.events,tracks:this.state.tracks,
            soundSpeed:this.state.settings.soundSpeed,maxGap:this.state.settings.maxGap});
        if(this.disposed || revision!==this.revision || candidate!==this.selectedResult) {this.scenePreview.clear();return;}
        par.paused=true;
        if(!this.previewDock) {
            const dock=this.previewDock=el("aside",document.getElementById("Content") ?? document.body,undefined,"dp-preview-dock");
            dock.setAttribute("aria-label","Doppler candidate scene preview");blockViewEvents(dock);
            this.previewTitle=el("strong",dock);this.previewDescription=el("p",dock);this.previewLegend=el("div",dock,undefined,"dp-preview-legend");
            const buttons=el("div",dock,undefined,"dp-preview-actions");
            this.previewPrevious=this.button(buttons,"Previous candidate",()=>this.stepSceneCandidate(-1));
            this.previewNext=this.button(buttons,"Next candidate",()=>this.stepSceneCandidate(1));
            this.button(buttons,"Back to shortlist",()=>this.show());
            this.button(buttons,"Clear preview",()=>this.clearMarker());
        }
        const item=this.displayedCandidates.find(row=>row.candidate===candidate),index=this.displayedCandidates.indexOf(item);
        this.previewTitle.textContent=`Doppler hypothesis · shortlist #${rank}${item?.originalRank ? ` · global replay rank ${item.originalRank}` : ""} · ${candidate.lat.toFixed(6)}, ${candidate.lon.toFixed(6)}`;
        this.previewDescription.textContent=[
            `Recording start ${new Date(candidate.recordingStart*1000).toISOString()}${item?.rmsHz!=null ? ` · RMS ${item.rmsHz.toFixed(3)} Hz` : ""}`,
            item?.reviewNote || this.state.provenance?.status || this.state.provenance?.purpose || "Candidate association; fit rank does not establish location or source identity."
        ].join("\n");
        this.previewLegend.replaceChildren();
        for(const event of info?.events ?? []) {
            const line=el("span",this.previewLegend,[event.name,event.identity,
                Number.isFinite(event.speedMS) ? `${event.speedMS.toFixed(1)} m/s` : "",
                Number.isFinite(event.rangeM) ? `${(event.rangeM/1000).toFixed(2)} km CPA slant` : "",
                event.status==="shown" ? "" : event.message ?? event.status].filter(Boolean).join(" · "));
            line.style.borderLeftColor=event.color;
        }
        this.previewPrevious.disabled=index<=0;this.previewNext.disabled=index>=this.displayedCandidates.length-1;
        this.hide({keepScene:true});this.previewDock.hidden=false;
    }
    async stepSceneCandidate(direction) {
        const index=this.displayedCandidates.findIndex(row=>row.candidate===this.selectedResult),item=this.displayedCandidates[index+direction];
        if(!item) return;
        this.selectResult(item.candidate,this.candidateElements.get(item.candidate),{preserveScene:true});
        await this.viewSelectedCandidate();
    }
    selectResult(result,row,{preserveScene=false}={}) {
        this.referenceSelection=null;
        this.selectedResult=result;
        for(const r of this.table.querySelectorAll("tr")) r.classList.toggle("selected",r===row);
        this.clearMarker({keepScene:preserveScene});
        const p=LLAToECEF(result.lat,result.lon,result.altitudeM+20);
        const geometry=new BufferGeometry();geometry.setAttribute("position",new Float32BufferAttribute([p.x,p.y,p.z],3));
        this.marker=new Points(geometry,new PointsMaterial({color:0xff6363,size:15,sizeAttenuation:false,depthTest:false}));
        this.marker.layers.enableAll();this.marker.renderOrder=999;GlobalScene.add(this.marker);setRenderOne(true);this.draw();
        this.save();markSitchDirty();
    }
    clearMarker({keepScene=false}={}) {
        if(!keepScene) {this.scenePreview?.clear();if(this.previewDock) this.previewDock.hidden=true;}
        if(this.marker) {this.marker.removeFromParent();this.marker.geometry.dispose();this.marker.material.dispose();this.marker=null;setRenderOne(true);}
    }
    draw() {if(this.canvas) this.drawSpectrum();if(this.map) this.drawMap();}
    drawSpectrum() {
        if(!this.canvas.clientWidth || !this.canvas.clientHeight) return;
        const layout=spectrumLayout(this.canvas.clientWidth,this.canvas.clientHeight,window.devicePixelRatio);
        if(this.canvas.width!==layout.nativeWidth || this.canvas.height!==layout.nativeHeight) {this.canvas.width=layout.nativeWidth;this.canvas.height=layout.nativeHeight;this.spectrumBackground=null;}
        const ctx=this.canvas.getContext("2d"),e=this.state.events[this.selectedEvent];
        ctx.setTransform(layout.dpr,0,0,layout.dpr,0,0);
        ctx.fillStyle="#0b1220";ctx.fillRect(0,0,layout.width,layout.height);
        const {low,high,recordedMaximum}=spectrumFrequencyRange(this.spectrogram,this.frequencyView,this.audioOptions.maxHz);
        if(this.viewMin) {this.viewMin.max=recordedMaximum;this.viewMax.max=recordedMaximum;
            if(document.activeElement!==this.viewMin) this.viewMin.value=low;
            if(document.activeElement!==this.viewMax) this.viewMax.value=high;}
        if(this.frequencyViewInfo) this.frequencyViewInfo.textContent=`View ${low.toFixed(1)}–${high.toFixed(1)} Hz${this.spectrogram ? ` · FFT 0–${recordedMaximum.toFixed(1)} Hz` : " · load audio for recorded data"}`;
        this.axes={...layout,low,high};
        const x=t=>layout.left+(t-e.start)/(e.end-e.start)*layout.plotWidth,y=f=>layout.top+(high-f)/(high-low)*layout.plotHeight;
        const key=this.spectrumDetailKey(e),spec=this.detailSpectrogram?.key===key ? this.detailSpectrogram : this.spectrogram;
        if(spec && e.start<e.end) {
            const width=Math.max(1,Math.round(layout.plotWidth*layout.dpr)),height=Math.max(1,Math.round(layout.plotHeight*layout.dpr));
            const backgroundKey=`${e.start}/${e.end}/${low}/${high}/${width}/${height}`;
            if(this.spectrumBackground?.key!==backgroundKey || this.spectrumBackground?.spec!==spec) {
                const background=document.createElement("canvas");background.width=width;background.height=height;
                const image=ctx.createImageData(width,height);
                for(let px=0;px<width;px++) {
                    const column=Math.round((e.start+(px/width)*(e.end-e.start)-spec.start)/spec.hop);
                    for(let py=0;py<height;py++) {
                        const bin=Math.round((high-py/height*(high-low))/spec.binHz),i=(py*width+px)*4;
                        const v=column>=0 && column<spec.columns && bin>=0 && bin<spec.bins ? Math.max(0,Math.min(1,(spec.values[column*spec.bins+bin]+1)/5)) : 0;
                        image.data[i]=255*v;image.data[i+1]=230*v;image.data[i+2]=Math.min(255,20+150*v);image.data[i+3]=255;
                    }
                }
                background.getContext("2d").putImageData(image,0,0);this.spectrumBackground={key:backgroundKey,spec,canvas:background};
            }
            ctx.drawImage(this.spectrumBackground.canvas,layout.left,layout.top,layout.plotWidth,layout.plotHeight);
        }
        ctx.save();ctx.beginPath();ctx.rect(layout.left,layout.top,layout.plotWidth,layout.plotHeight);ctx.clip();
        const line=(color,fn,label)=>{
            ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();let started=false,labelAt;
            for(let i=0;i<=250;i++) {const t=e.start+(e.end-e.start)*i/250,f=fn(t);
                if(!Number.isFinite(f)) {started=false;continue;}
                if(!labelAt&&f>=low&&f<=high) labelAt=[x(t),y(f)];
                if(!started) ctx.moveTo(x(t),y(f));else ctx.lineTo(x(t),y(f));started=true;
            }ctx.stroke();
            if(label&&labelAt) {ctx.fillStyle=color;ctx.font="11px system-ui";ctx.fillText(label,Math.min(labelAt[0]+4,layout.left+layout.plotWidth-95),Math.max(layout.top+12,labelAt[1]-4));}
        };
        const counts=spectrumHarmonicCounts(e),families=[...new Set([0,...counts.map(h=>h.family ?? 0)])].sort((a,b)=>a-b);
        const harmonicsOf=family=>[...new Set([...(family===0 ? [e.harmonic] : []),...counts.filter(h=>(h.family ?? 0)===family).map(h=>h.harmonic)])].sort((a,b)=>a-b);
        const tag=(family,harmonic)=>`${family ? `F${family} ` : ""}H${harmonic}`,harmonics=harmonicsOf(0);
        const fundamentals=fit=>Array.isArray(fit.families) ? `${fit.families.map(f=>f.frequency.toFixed(2)).join(" / ")} Hz fundamentals` : `${fit.frequency.toFixed(2)} Hz fundamental`;
        if(this.overlays.preview && e.rangeMax>0 && e.speedMax>0 && e.speedMin>=0 && e.speedMax<this.state.settings.soundSpeed*0.98 && this.state.settings.soundSpeed>0)
            for(const harmonic of harmonics) line("#e7b66c",t=>idealFrequency(t-e.cpa,e.frequency,(e.speedMin+e.speedMax)/2,Math.max(1,(e.rangeMin+e.rangeMax)/2),this.state.settings.soundSpeed)*harmonic,`Preview H${harmonic}`);
        // Every traced family draws its own fitted fundamental on the shared geometry.
        const familyLines=(color,view,start,fit,label)=>{
            for(const family of families) {
                const f0=familyFrequency(fit,family);if(!Number.isFinite(f0)) continue;
                for(const harmonic of harmonicsOf(family)) line(color,t=>atArrival(view,start+t,this.state.settings.soundSpeed)?.factor*f0*harmonic,`${label} ${tag(family,harmonic)}`);
            }
        };
        const r=this.selectedResult,re=r?.events[this.selectedEvent];
        if(this.flightInfo) {this.flightInfo.hidden=true;this.flightInfo.textContent="";}
        if(re) {
            const track=this.state.tracks.find(t=>t.id===re.flight);
            if(track) {
                const identity=[...new Set([track.callsign,track.aircraftType,track.registration,track.id.toUpperCase()].filter(Boolean))].join(" · ");
                const details=[fundamentals(re),
                    Number.isFinite(re.rangeM) ? `${Math.round(re.rangeM).toLocaleString()} m closest slant` : null,
                    Number.isFinite(re.speedMS) ? `${re.speedMS.toFixed(1)} m/s` : null,
                    Number.isFinite(re.cpaArrival) ? `Sound CPA ${new Date(re.cpaArrival*1000).toISOString()}` : null].filter(Boolean);
                if(this.flightInfo) {this.flightInfo.hidden=false;this.flightInfo.textContent=`Selected candidate: ${identity}\n${details.join(" · ")}`;}
                if(this.overlays.candidate) {
                    const c=this.state.settings.soundSpeed,view=observerTrack(prepareTrack(track,c,this.state.settings.maxGap),toECEF(r.lat,r.lon,r.altitudeM),c);
                    familyLines("#ff6363",view,r.recordingStart,re,"Candidate");
                }
            }
        }
        const reference=this.referenceSelection?.eventIndex===this.selectedEvent?this.referenceResult?.reference:null;
        if(reference) {
            const row=this.referenceSelection.row,track=this.state.tracks.find(t=>t.id===row.id),c=reference.soundSpeed;
            if(this.overlays.reference) {
                const view=observerTrack(prepareTrack(track,c,reference.maxGap),toECEF(reference.lat,reference.lon,reference.altitudeM),c);
                familyLines("#b2a0ff",view,reference.recordingStart,row,"Reference");
            }
            if(this.flightInfo) {
                const identity=[...new Set([row.identity.callsign,row.identity.registration,row.identity.aircraftType,row.id.toUpperCase()].filter(Boolean))].join(" · ");
                this.flightInfo.hidden=false;this.flightInfo.textContent=`Supplied-reference check: ${identity}\n${fundamentals(row).replace(/fundamental/,"reference")} · RMS ${row.rmsHz.toFixed(3)} Hz · location and clock fixed · source association unverified`;
            }
        }
        const labels=new Set(),traceColors=["#5cf4eb","#9be98c","#d6a2ff","#ffb57f"];
        for(const p of this.overlays.trace ? e.trace : []) {
            const harmonic=p.harmonic ?? e.harmonic,family=p.family ?? 0,label=tag(family,harmonic);
            ctx.fillStyle=ctx.strokeStyle=traceColors[(harmonic-1)%traceColors.length];ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x(p.time),y(p.frequency),3,0,2*Math.PI);
            if(family) ctx.stroke();else ctx.fill();
            if(!labels.has(label)&&p.frequency>=low&&p.frequency<=high) {ctx.font="11px system-ui";ctx.fillText(label,x(p.time)+5,y(p.frequency)+12);labels.add(label);}
        }
        ctx.restore();ctx.fillStyle="#d6dfed";ctx.font="13px system-ui";
        for(let i=0;i<=5;i++) {const t=e.start+(e.end-e.start)*i/5;ctx.fillText(`${t.toFixed(1)}s`,Math.min(layout.width-58,x(t)-15),layout.height-11);const f=low+(high-low)*i/5;ctx.fillText(f.toFixed(0),5,y(f)+4);}
        const shownFit=reference?this.referenceSelection.row:re;
        if(this.traceInfo) this.traceInfo.textContent=`${e.trace.length} trace points${counts.length ? ` · ${counts.map(h=>`${tag(h.family ?? 0,h.harmonic)}: ${h.count}`).join(" · ")}` : ""} · new points ${tag(e.family ?? 0,e.harmonic)}${shownFit?.rmsHz!==undefined ? ` · ${reference?"reference":"fit"} RMS ${shownFit.rmsHz.toFixed(3)} Hz` : ""}`;
        this.queueSpectrogramDetail(e);
        if(this.detailInfo && this.spectrogram) {
            const resolution=`${spec.hop.toFixed(4)} s between FFT columns · ${spec.binHz.toFixed(3)} Hz bins · ${(1/spec.binHz).toFixed(2)} s FFT window`;
            this.detailInfo.textContent=this.detailFailure?.key===key ? `Visible detail unavailable: ${this.detailFailure.message}` :
                this.detailPending?.key===key ? `Computing visible-window detail… Whole-record scoring stays at ${this.spectrogram.hop.toFixed(3)} s per column.` :
                `${spec===this.detailSpectrogram ? "Visible detail" : "Whole-record grid"}: ${resolution}.${!this.audioWorker && spec===this.spectrogram ? " Reload audio for finer visible detail." : ""}`;
        }
    }
    drawMap() {
        const ctx=this.map.getContext("2d"),s=this.state.settings;
        ctx.fillStyle="#0b1220";ctx.fillRect(0,0,1000,300);
        const heat=this.result?.heat?.length ? this.result.heat : this.result?.results;if(!heat?.length) return;
        const scores=heat.map(p=>p.score).sort((a,b)=>a-b),min=scores[Math.floor(scores.length*0.1)],max=scores.at(-1);
        const view=resultMapViewport(this.result,s),step=s.source==="archive" ? this.state.archiveOptions.fineStep : s.spacingM;
        const size=Math.min(24,Math.max(3,step/view.metresPerPixel));
        for(const p of heat) {const {x,y}=view.project(p),v=Math.max(0,Math.min(1,(p.score-min)/(max-min || 1)));ctx.fillStyle=`hsl(${240-v*240} 90% ${25+v*35}%)`;ctx.fillRect(x-size/2,y-size/2,size,size);}
        ctx.fillStyle="#f2f6ff";ctx.font="12px system-ui";
        for(const row of (this.displayedCandidates ?? []).slice(0,25)) {const {x,y}=view.project(row.candidate);ctx.fillText(String(row.rank),x+6,y-6);}
        if(this.selectedResult) {const {x,y}=view.project(this.selectedResult);ctx.strokeStyle="white";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,7,0,2*Math.PI);ctx.stroke();}
        ctx.fillStyle="white";ctx.font="13px system-ui";ctx.fillText("North ↑ · red = better fit · unscored points are blank",15,25);
        const scale=10**Math.floor(Math.log10(view.metresPerPixel*100)),width=scale/view.metresPerPixel;
        ctx.strokeStyle="white";ctx.beginPath();ctx.moveTo(15,277);ctx.lineTo(15+width,277);ctx.stroke();
        ctx.fillText(scale>=1000 ? `${scale/1000} km` : `${scale} m`,15,294);
        ctx.textAlign="right";ctx.fillText(`Centre ${view.lat.toFixed(4)}°, ${view.lon.toFixed(4)}°`,985,294);ctx.textAlign="left";
    }
    // The tool fills the window below the menu bar, as the sitch browser does. The menu bar is
    // on top of every other part of the page, so a tool that started at the top of the window
    // had its title under the bar, and only the lower edge of its close button showed.
    placeBelowMenuBar() {
        const bar=this.panel.ownerDocument.getElementById("menuBarBlackBar");
        this.panel.style.top=`${bar ? bar.offsetTop+bar.offsetHeight : 0}px`;
        this.panel.style.height="auto";
    }
    show() {if(!canUseDopplerGeolocation()) return;this.placeBelowMenuBar();this.scenePreview?.clear();if(this.previewDock) this.previewDock.hidden=true;this.panel.hidden=false;this.panel.focus();this.draw();}
    // Hiding keeps the decoded audio in its worker so visible-window detail
    // survives a close, a scene preview and the return to the shortlist. Only
    // dispose() and a new audio load release it.
    hide({keepScene=false}={}) {this.stop();this.cancelSpectrogramDetail();this.archiveWorker?.terminate();this.archiveWorker=null;getInteractionRouter(this.panel.ownerDocument).cancelOwner(this);this.panel.hidden=true;this.clearMarker({keepScene});}
    dispose() {
        this.disposed=true;this.stop();this.releaseAudioDetail();this.archiveWorker?.terminate();this.archiveWorker=null;this.clearMarker();this.resizeObserver?.disconnect();this.traceCleanup?.();
        getInteractionRouter(this.panel.ownerDocument).cancelOwner(this);
        this.cleanups.forEach(fn=>fn());this.scenePreview?.dispose();this.previewDock?.remove();this.panel.remove();this.spectrogram=null;
    }
}
