import {atArrival,observerTrack,prepareTrack,toECEF} from "./DopplerModel";
import {familyFrequency,tracedFamilies,tracedHarmonics} from "./DopplerTrace";

const C={background:"#0b1424",panel:"#142137",border:"#30435f",text:"#eef3fb",muted:"#afbed2",prediction:"#ff865e",trace:"#64d7ff"};
const finite=Number.isFinite;
const number=(value,digits=1)=>finite(value) ? value.toFixed(digits) : "unavailable";
const utc=seconds=>finite(seconds) ? new Date(seconds*1000).toISOString().replace("T"," ").replace("Z"," UTC") : "unavailable";
const clean=value=>String(value ?? "").replace(/\s+/g," ").trim();

export function reportElapsed(seconds) {
    const value=Math.max(0,Math.round(seconds)),hours=Math.floor(value/3600),minutes=Math.floor(value/60)%60,s=value%60;
    return `${hours ? `${hours}:` : ""}${String(hours ? minutes : Math.floor(value/60)).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

export function buildDopplerReportData({state,result,selectedResult,spectrogram,audioName}) {
    if(!selectedResult || !result?.results?.length) throw new Error("Select a candidate result before exporting an image.");
    if(!spectrogram?.values?.length) throw new Error("Load the original audio before exporting its spectrogram.");
    const candidate=selectedResult,c=state.settings.soundSpeed;
    const events=state.events.map((event,index)=>{
        if(event.end<spectrogram.start || event.start>spectrogram.start+(spectrogram.columns-1)*spectrogram.hop) throw new Error(`Event ${index+1} is outside the loaded audio. Reload the original recording before exporting.`);
        const fitted=candidate.events[index],track=state.tracks.find(t=>t.id===fitted?.flight);
        if(!track) throw new Error(`Reload the flight data for event ${index+1} before exporting.`);
        const view=observerTrack(prepareTrack(track,c,state.settings.maxGap),toECEF(candidate.lat,candidate.lon,candidate.altitudeM),c);
        const harmonics=tracedHarmonics(event),families=tracedFamilies(event);
        const predictions=families.flatMap(family=>tracedHarmonics(event,family).map(harmonic=>({family,harmonic,points:Array.from({length:501},(_,i)=>{
            const time=event.start+(event.end-event.start)*i/500;
            return {time,frequency:atArrival(view,candidate.recordingStart+time,c)?.factor*familyFrequency(fitted,family)*harmonic};
        })})));
        const prediction=(predictions.find(p=>p.family===0 && p.harmonic===event.harmonic) ?? predictions[0]).points;
        const frequencies=[...predictions.flatMap(p=>p.points),...event.trace].map(p=>p.frequency).filter(finite);
        if(!frequencies.length) throw new Error(`Event ${index+1} has no usable prediction in its selected time window.`);
        const min=Math.min(...frequencies),max=Math.max(...frequencies),pad=Math.max(5,(max-min)*0.18);
        const low=Math.max(0,min-pad),high=max+pad,maximumHz=(spectrogram.bins-1)*spectrogram.binHz;
        if(low>=maximumHz) throw new Error(`Event ${index+1} is above the loaded spectrogram. Reload audio with a higher maximum frequency.`);
        const id=clean(track.id),callsign=clean(track.callsign),registration=clean(track.registration),type=clean(track.aircraftType);
        return {event,fitted,track,prediction,predictions,harmonics,families,low,high,title:callsign || registration || id,
            identity:`Type: ${type || "unavailable"}   ·   Registration: ${registration || "unavailable"}   ·   ${/^[a-f0-9]{6}$/i.test(id) ? "ICAO" : "Flight ID"}: ${id.toUpperCase()}${callsign ? `   ·   Callsign: ${callsign}` : ""}`};
    });
    return {candidate,events,spectrogram,rank:Math.max(0,result.results.indexOf(candidate))+1,total:result.results.length,
        mode:state.settings.mode,audioName:audioName || state.provenance?.audio?.name || "local audio",
        provenance:state.provenance ?? {},settings:state.settings,result};
}

function text(ctx,value,x,y,size=22,color=C.text,weight=400) {
    ctx.font=`${weight} ${size}px system-ui, sans-serif`;ctx.fillStyle=color;ctx.fillText(value,x,y);
}
function fittedText(ctx,value,x,y,width,size=22,color=C.text,weight=400) {
    ctx.font=`${weight} ${size}px system-ui, sans-serif`;
    let line=clean(value);
    while(line.length && ctx.measureText(line).width>width) line=line.slice(0,-1);
    if(line!==clean(value)) line=line.slice(0,-1)+"…";
    text(ctx,line,x,y,size,color,weight);
}
function panel(ctx,x,y,width,height) {
    ctx.fillStyle=C.panel;ctx.fillRect(x,y,width,height);ctx.strokeStyle=C.border;ctx.lineWidth=1;ctx.strokeRect(x,y,width,height);
}
function curve(ctx,points,x,y,color,width) {
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin="round";ctx.beginPath();let drawing=false;
    for(const p of points) {
        if(!finite(p.frequency)) {drawing=false;continue;}
        if(drawing) ctx.lineTo(x(p.time),y(p.frequency));else ctx.moveTo(x(p.time),y(p.frequency));drawing=true;
    }
    ctx.stroke();
}
function contrastBounds(spec,event,low,high) {
    const values=[],lastBin=spec.bins-1,first=Math.max(0,Math.floor((event.start-spec.start)/spec.hop)),last=Math.min(spec.columns-1,Math.ceil((event.end-spec.start)/spec.hop));
    const stride=Math.max(1,Math.ceil((last-first)/250)),lo=Math.max(0,Math.floor(low/spec.binHz)),hi=Math.min(lastBin,Math.ceil(high/spec.binHz));
    for(let column=first;column<=last;column+=stride) for(let bin=lo;bin<=hi;bin+=Math.max(1,Math.ceil((hi-lo)/120))) {
        const value=spec.values[column*spec.bins+bin];if(finite(value)) values.push(value);
    }
    values.sort((a,b)=>a-b);
    return [values[Math.floor(values.length*0.05)] ?? -1,Math.max((values[Math.floor(values.length*0.05)] ?? -1)+0.5,values[Math.floor(values.length*0.995)] ?? 4)];
}
function spectrum(ctx,data,top) {
    const {event,spectrogram:spec,prediction,low,high}=data,left=150,width=1500,height=290;
    const x=time=>left+(time-event.start)/(event.end-event.start)*width,y=hz=>top+height-(hz-low)/(high-low)*height;
    const [floor,ceiling]=contrastBounds(spec,event,low,high),image=ctx.createImageData(width,height);
    const colors=[[11,20,36],[60,38,91],[160,69,104],[242,151,95],[255,240,181]];
    for(let px=0;px<width;px++) {
        const column=Math.round((event.start+px/width*(event.end-event.start)-spec.start)/spec.hop);
        for(let py=0;py<height;py++) {
            const bin=Math.round((high-py/height*(high-low))/spec.binHz),offset=(py*width+px)*4;
            const value=column>=0 && column<spec.columns && bin>=0 && bin<spec.bins ? spec.values[column*spec.bins+bin] : NaN;
            const v=finite(value) ? Math.max(0,Math.min(1,(value-floor)/(ceiling-floor)))*4 : 0,i=Math.min(3,Math.floor(v)),fraction=v-i;
            for(let channel=0;channel<3;channel++) image.data[offset+channel]=colors[i][channel]*(1-fraction)+colors[i+1][channel]*fraction;
            image.data[offset+3]=255;
        }
    }
    ctx.putImageData(image,left,top);
    ctx.save();ctx.beginPath();ctx.rect(left,top,width,height);ctx.clip();
    ctx.strokeStyle="#f0f4ff26";ctx.lineWidth=1;
    for(let i=0;i<=5;i++) {ctx.beginPath();ctx.moveTo(left+i*width/5,top);ctx.lineTo(left+i*width/5,top+height);ctx.stroke();ctx.beginPath();ctx.moveTo(left,top+i*height/5);ctx.lineTo(left+width,top+i*height/5);ctx.stroke();}
    ctx.setLineDash([6,7]);ctx.strokeStyle="#c8d6e6";ctx.beginPath();ctx.moveTo(x(event.cpa),top);ctx.lineTo(x(event.cpa),top+height);ctx.stroke();ctx.setLineDash([]);
    for(const item of data.predictions ?? [{points:prediction}]) {
        curve(ctx,item.points,x,y,"#07101fcc",7);curve(ctx,item.points,x,y,C.prediction,3.5);
    }
    for(const p of event.trace) {ctx.beginPath();ctx.arc(x(p.time),y(p.frequency),4.5,0,Math.PI*2);ctx.fillStyle=C.trace;ctx.fill();ctx.strokeStyle="#07101f";ctx.lineWidth=1.7;ctx.stroke();}
    ctx.restore();
    ctx.strokeStyle=C.border;ctx.strokeRect(left,top,width,height);ctx.textAlign="center";
    for(let i=0;i<=5;i++) text(ctx,reportElapsed(event.start+(event.end-event.start)*i/5),left+i*width/5,top+height+31,19,C.muted);
    text(ctx,"Audio elapsed time (mm:ss; h:mm:ss for long recordings)",left+width/2,top+height+61,20,C.muted);
    ctx.textAlign="right";for(let i=0;i<=5;i++) text(ctx,number(low+(high-low)*i/5,0),left-15,y(low+(high-low)*i/5)+7,19,C.muted);
    ctx.textAlign="left";text(ctx,"Hz",left-49,top-12,20,C.muted);
    text(ctx,"Heard CPA",Math.min(left+width-125,Math.max(left+10,x(event.cpa)+10)),top+25,17,C.text);
}

// Everything is drawn from the selected search result and the original browser
// spectrogram. This module is fetched only when the export action is invoked.
export function renderDopplerReport(input) {
    const data=buildDopplerReportData(input),{candidate,events,result}=data;
    const canvas=document.createElement("canvas"),width=1800,eventHeight=610,eventTop=460;
    canvas.width=width;canvas.height=eventTop+events.length*eventHeight+430;
    const ctx=canvas.getContext("2d");ctx.fillStyle=C.background;ctx.fillRect(0,0,width,canvas.height);
    text(ctx,"SITREC  /  ACOUSTIC GEOLOCATION",60,50,18,"#85b8dd",600);
    text(ctx,"Aircraft sound · candidate match",60,106,42,C.text,650);
    text(ctx,"Observed audio, matched flight predictions and one shared recording clock",60,143,23,C.muted);
    panel(ctx,60,174,1680,172);
    text(ctx,"CANDIDATE LISTENER POSITION",85,205,17,C.muted,600);
    text(ctx,`${candidate.lat.toFixed(6)}°, ${candidate.lon.toFixed(6)}°`,85,244,31,C.text,600);
    text(ctx,`Listener height ${number(candidate.altitudeM,1)} m HAE (WGS84 ellipsoid)`,85,276,21,C.muted);
    text(ctx,`Shared recording start  ${utc(candidate.recordingStart)}`,85,316,23,C.text);
    text(ctx,`RANK ${data.rank} / ${data.total} RETAINED CANDIDATES`,1110,206,18,C.muted,600);
    text(ctx,`Fit score ${number(candidate.score,4)}`,1110,249,30,C.text,600);
    text(ctx,`${data.mode==="trace" ? "Traced ridge" : "Spectrogram brightness"} scoring · higher is better`,1110,280,20,C.muted);
    text(ctx,"Candidate rank is not a probability.",1110,316,20,C.muted);
    fittedText(ctx,`Audio: ${data.audioName}`,60,383,1680,21,C.text);
    const archives=data.provenance.archiveFiles,source=archives?.length ? `${archives.length} local archive part${archives.length===1 ? "" : "s"}: ${archives.slice(0,3).map(f=>f.name).join(", ")}${archives.length>3 ? ` (+${archives.length-3} more)` : ""}` : data.provenance.flightCSV?.name || "Loaded Sitrec / retained flight tracks";
    fittedText(ctx,`Flight data: ${source}`,60,415,1680,20,C.muted);
    text(ctx,"Candidate associations depend on track coverage, timing and measurement assumptions; identity is not established by this image.",60,445,20,C.muted);
    events.forEach((entry,index)=>{
        const top=eventTop+index*eventHeight,{event,fitted}=entry;
        panel(ctx,60,top,1680,eventHeight-20);
        fittedText(ctx,`EVENT ${String(index+1).padStart(2,"0")}  /  ${entry.title}`,85,top+38,1600,27,C.text,650);
        fittedText(ctx,entry.identity,85,top+73,1600,20,C.muted);
        const fit=finite(fitted.rmsHz) ? `Trace RMS ${number(fitted.rmsHz,3)} Hz` : `Brightness score ${number(fitted.score,3)}`;
        const speed=finite(fitted.speedMS) ? `${number(fitted.speedMS,1)} m/s (${number(fitted.speedMS*1.943844,0)} kt)` : "unavailable";
        const fundamentals=entry.families.length>1 ? `Fitted fundamentals ${entry.families.map(family=>number(familyFrequency(fitted,family),3)).join(" / ")} Hz (${entry.families.length} tone families)` : `Fitted fundamental ${number(fitted.frequency,3)} Hz`;
        fittedText(ctx,`${fundamentals}   ·   Traced harmonics ${entry.harmonics.map(h=>`×${h}`).join(", ")}   ·   ${fit}   ·   CPA slant ${number(fitted.rangeM,0)} m`,85,top+108,1600,21,C.text);
        text(ctx,`CPA sound arrival ${utc(fitted.cpaArrival)}   ·   Speed at CPA ${speed}`,85,top+142,21,C.muted);
        spectrum(ctx,{...entry,spectrogram:data.spectrogram},top+178);
        ctx.strokeStyle=C.prediction;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(150,top+560);ctx.lineTo(192,top+560);ctx.stroke();text(ctx,"Flight prediction",205,top+567,20,C.text);
        ctx.fillStyle=C.trace;ctx.beginPath();ctx.arc(430,top+560,5,0,Math.PI*2);ctx.fill();text(ctx,`Traced observations (${event.trace.length})`,445,top+567,20,C.text);
        text(ctx,"Background: normalized spectral contrast",1070,top+567,19,C.muted);
    });
    const bottom=eventTop+events.length*eventHeight;
    text(ctx,"CANDIDATE COMPARISON",60,bottom+15,19,C.muted,600);
    const alternatives=result.results.slice(0,5);
    if(!alternatives.includes(candidate)) alternatives[4]=candidate;
    text(ctx,"Rank",85,bottom+54,19,C.muted);text(ctx,"Listener latitude / longitude",190,bottom+54,19,C.muted);text(ctx,"Fit score",760,bottom+54,19,C.muted);text(ctx,"Flight IDs (event order)",980,bottom+54,19,C.muted);
    alternatives.forEach((r,index)=>{
        const y=bottom+90+index*37,selected=r===candidate;if(selected) {ctx.fillStyle="#28435b";ctx.fillRect(60,y-25,1680,35);}
        text(ctx,`${result.results.indexOf(r)+1}${selected ? " ●" : ""}`,85,y,20,C.text,selected ? 650 : 400);
        text(ctx,`${r.lat.toFixed(6)}°, ${r.lon.toFixed(6)}°`,190,y,20,C.text);
        text(ctx,number(r.score,4),760,y,20,C.text);fittedText(ctx,r.events.map(e=>e.flight.toUpperCase()).join(" / "),980,y,720,20,C.text);
    });
    const footer=canvas.height-113;
    text(ctx,`Sound speed ${number(data.settings.soundSpeed,1)} m/s · FFT bins ${number(data.spectrogram.binHz,3)} Hz · Time step ${number(data.spectrogram.hop,2)} s · Baseline removed; local display contrast`,60,footer,19,C.muted);
    text(ctx,"Fixed listener; subsonic 3D flight geometry; sound propagation delay included. Heights and data gaps affect the fit.",60,footer+32,19,C.muted);
    text(ctx,`Search completed ${result.completedAtUTC || "time not retained"} · Image generated ${new Date().toISOString()}`,60,footer+64,18,C.muted);
    return canvas;
}
