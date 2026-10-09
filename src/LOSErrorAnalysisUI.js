import {Globals, NodeMan, Sit, TrackManager} from "./Globals";
import {resolveLOSNode, resolveTruthTrack, truthTrackOptions} from "./AnalyzeTraverse";
import {withUnfilteredAnalysisAngles} from "./AnalysisAngleSmoothing";
import {abFrameRange} from "./TraverseAnalysisData";
import {collectLOSErrorSamples, syntheticLOSCSV} from "./LOSErrorData";
import {analyzeErrors, directionWithError, fitErrorModel, fitOperatorErrorModel, generateErrors, serializeErrorModel, validateErrorModel} from "./LOSErrorModel";
import {drawFigure, purgeFigure} from "./analysis/charts/PlotlyLoader";
import {makeDraggable, removeDraggable} from "./DragResizeUtils";
import {saveAs} from "file-saver";

let closeOpen=null;
const buttons=new WeakMap();
const el=(tag,text,css="")=>{
    const n=document.createElement(tag); if(text!==undefined) n.textContent=text; n.style.cssText=css; return n;
};
const fmt=x=>Number.isFinite(x) ? (Math.abs(x)<.001 && x!==0 ? x.toExponential(2) : x.toFixed(4)) : "—";
const freshSeed=()=>String(crypto.getRandomValues(new Uint32Array(1))[0]);

export function addLOSErrorButton(folder) {
    const existing=buttons.get(folder);
    if(existing && folder.controllers.includes(existing)) return existing;
    const action={analyzeLOSError:()=>openLOSErrorAnalysis()};
    const ctrl=folder.add(action,"analyzeLOSError").name("Analyze LOS Error…");
    ctrl.tooltip?.("Compare pointing against a truth track at the original, 10 Hz and 1 Hz rates; fit and export a statistical noise model.");
    buttons.set(folder,ctrl); return ctrl;
}

function truthNode(id) {
    let track=null;
    TrackManager?.iterate((key,t)=>{if(t.trackID===id) track=t.trackNode;});
    return track ?? NodeMan.get(id,false);
}

export function openLOSErrorAnalysis() {
    closeOpen?.();
    const panel=el("section",undefined,"position:fixed;z-index:10000;left:3vw;top:35px;width:94vw;max-width:1450px;max-height:calc(100vh - 55px);overflow:auto;background:#18212d;color:#eef3fa;padding:18px;box-sizing:border-box;border:1px solid #536477;border-radius:8px;font:14px Arial,sans-serif;box-shadow:0 5px 28px #0009;");
    panel.id="los-error-analysis"; panel.dataset.interactionNative="true";
    const title=el("div",undefined,"display:flex;align-items:center;gap:12px;cursor:move;position:sticky;top:-18px;background:#18212d;z-index:2;padding:12px 0;");
    title.append(el("strong","LOS error analysis","font-size:21px;flex:1;")); panel.append(title);
    const button=(parent,label,fn)=>{
        const b=el("button",label,"padding:7px 11px;cursor:pointer;background:#30445d;border:1px solid #687c94;border-radius:4px;color:white;font:inherit;");
        b.type="button"; b.onclick=fn;parent.append(b);return b;
    };
    const charts=[];
    const close=()=>{
        clearInterval(lifecycle); charts.forEach(c=>purgeFigure(c)); removeDraggable(panel);panel.remove();
        if(closeOpen===close) closeOpen=null;
    };
    button(title,"Close",close); makeDraggable(panel,{handle:title}); closeOpen=close;
    const generation=Globals.loadGeneration;
    const lifecycle=setInterval(()=>{if(Globals.loadGeneration!==generation) close();},500);
    panel.addEventListener("keydown",e=>{e.stopPropagation();if(e.key==="Escape") close();});
    panel.addEventListener("keyup",e=>e.stopPropagation());
    panel.append(el("p","Compare the selected pointing LOS with platform-to-truth bearings in A–B. Check time alignment first: track errors and timing offsets also contribute to this residual. Analysis stays in this browser.","line-height:1.5;margin:6px 0 12px;"));
    const controls=el("div",undefined,"display:flex;align-items:center;flex-wrap:wrap;gap:10px;"); panel.append(controls);
    controls.append(el("label","Truth track"));
    const truth=el("select",undefined,"max-width:270px;padding:6px;"); truth.setAttribute("aria-label","LOS error truth track");
    truth.append(el("option","Choose a truth track"));truth.options[0].value="";
    for(const [label,id] of Object.entries(truthTrackOptions())) {const o=el("option",label);o.value=id;truth.append(o);}
    truth.value=resolveTruthTrack()?.trackID ?? ""; controls.append(truth);
    controls.append(el("label","Pointing LOS"));
    const pointing=el("select",undefined,"max-width:270px;padding:6px;");pointing.setAttribute("aria-label","LOS error pointing source");
    const current=el("option","Current traverse LOS");current.value="";pointing.append(current);
    NodeMan.iterate((id,node)=>{
        if(!node.in?.cameraTrack || !node.in?.sensorAz || !node.in?.platformHeading) return;
        const option=el("option",`Recorded angles: ${id}`);option.value=id;pointing.append(option);
    });controls.append(pointing);
    controls.append(el("label","Original Hz override (optional)"));
    const hz=el("input",undefined,"width:80px;padding:6px;");hz.type="number";hz.min="0.01";hz.step="any";
    hz.placeholder="auto";hz.setAttribute("aria-label","Original recording rate override");
    hz.title="For LOS without recorded timestamps. Use only when the source cadence is known. Recorded attitude timestamps take precedence.";controls.append(hz);
    controls.append(el("label","Noise model"));
    const modelChoice=el("select",undefined,"padding:6px;");modelChoice.setAttribute("aria-label","LOS error model family");
    for(const [value,label] of [["operator","Operator: drift, reaction, correction"],["ar","Statistical: Gaussian autoregression"]]) {const o=el("option",label);o.value=value;modelChoice.append(o);}controls.append(modelChoice);
    const message=el("p","Choose a truth track, then Analyze.","line-height:1.5;color:#cad8eb;"); panel.append(message);
    const content=el("div");panel.append(content);
    let captured,observed,generated,generatedSeed,model,modelFit,editor,comparison,ratePicker,scale,includeBias;
    const reportError=error=>{message.textContent=error.message;message.style.color="#ffb3a7";};
    const safe=fn=>async()=>{try {await fn();}catch(error){reportError(error);}};
    const generatePreview=(parameters,seed=freshSeed())=>{
        generated=analyzeErrors(generateErrors(parameters,observed.samples.map(r=>r.t),seed,captured.geometry));
        generatedSeed=seed;
    };
    const analyzeButton=button(controls,"Analyze",safe(async()=>{
        const los=pointing.value ? NodeMan.get(pointing.value,false) : resolveLOSNode(), target=truthNode(truth.value);
        if(!los || !truth.value || !target) throw new Error("Select a loaded truth track and a pointing LOS.");
        analyzeButton.disabled=true;
        try {
            const range=abFrameRange(Math.min(Sit.frames,los.frames),2);
            captured=await withUnfilteredAnalysisAngles(los,()=>collectLOSErrorSamples({losNode:los,truthNode:target,
                frame0:range.frame0,frame1:range.frame1,originalHz:hz.value==="" ? null : Number(hz.value)}));
            if(!panel.isConnected || generation!==Globals.loadGeneration) return;
            observed=analyzeErrors(captured.samples); generated=null;
            modelFit=null;model=null;
            if(observed.samples.length>=20) {
                if(modelChoice.value==="operator") {
                    modelFit=await fitOperatorErrorModel(observed.samples,captured.geometry,{cancelled:()=>!panel.isConnected||generation!==Globals.loadGeneration,
                        onProgress:(done,total)=>{message.textContent=`Fitting operator feedback statistics: ${done} / ${total} parameter combinations…`;}});
                    model=modelFit.model;
                } else model=fitErrorModel(observed.samples);
            } else model=fitErrorModel(observed.samples);
            if(!panel.isConnected || generation!==Globals.loadGeneration) return;
            generatePreview(model);
            render();
            const skipped=Object.values(captured.counts).reduce((s,x)=>s+x,0)+Object.values(observed.rejected).reduce((s,x)=>s+x,0);
            message.style.color="#cad8eb";
            message.textContent=`${captured.cadenceSource}. ${fmt(captured.cadence.hz)} Hz; ${observed.samples.length} valid samples; ${skipped} excluded; ${captured.cadence.gaps} time gaps. LOS: ${captured.losLabel}. Lower rates select nearest original samples without filtering or new noise draws. If pointing was constructed by aiming at the truth target, this measures that construction rather than independent pointing error.`;
        } finally {analyzeButton.disabled=false;}
    }));

    function render() {
        charts.splice(0).forEach(c=>purgeFigure(c));content.replaceChildren();
        content.append(el("h3","Measured errors and fresh synthetic errors"));
        comparison=el("div",undefined,"overflow-x:auto;");content.append(comparison);renderTable();
        const row=el("div",undefined,"display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0;");content.append(row);
        row.append(el("label","Plot samples at"));ratePicker=el("select",undefined,"padding:6px;");
        ratePicker.setAttribute("aria-label","LOS error plot rate");
        observed.views.forEach((v,i)=>{const o=el("option",v.label+(v.summary ? "" : " (unavailable)"));o.value=String(i);o.disabled=!v.summary;ratePicker.append(o);});
        row.append(ratePicker);ratePicker.onchange=safe(renderCharts);
        const grid=el("div",undefined,"display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:10px;");content.append(grid);
        for(let i=0;i<3;i++) {const chart=el("div",undefined,"height:280px;min-width:0;");grid.append(chart);charts.push(chart);}
        content.append(el("p","Solid lines show measurements. Dashed lines at 50% opacity show a fresh realization of the portable model; they are generated automatically and do not replay the measured errors.","font-size:12px;line-height:1.5;color:#b4c4d9;"));
        content.append(el("p","H/V are angular offsets in a local horizontal/vertical tangent frame, not Euler azimuth/elevation differences. Bias is the clip mean; σ and correlation are demeaned. Near zenith/nadir, horizontal orientation is ambiguous. 10 Hz and 1 Hz are decimation, so high-frequency error can alias.","font-size:12px;line-height:1.5;color:#b4c4d9;"));
        content.append(el("h3","Portable statistical noise model"));
        content.append(el("p",model?.modelType==="operator-feedback" ?
            "Operator model: smooth wandering error accumulates until a notice threshold is crossed; after a reaction delay, a correction slews toward the center with imperfect accuracy. It also supports independent jitter, anisotropy, mean bias and a delay in following the target’s changing bearing. Parameters fit aggregate statistics using independent simulations, not the observed sequence. They are descriptive equivalents, not uniquely identified human reaction times." :
            "This stationary Gaussian autoregressive model estimates amplitude, cross-axis coupling and temporal memory. It does not reproduce operator corrections, non-Gaussian tails or changing regimes exactly. Use the comparisons above to assess the approximation; a new seed generates a different sequence. The calibration rate is part of the model.","line-height:1.5;"));
        if(modelFit) content.append(el("p",`Operator fit: ${modelFit.candidates} combinations, two calibration seeds each, up to the first 90 seconds. Effective following delay ${fmt(modelFit.delay.seconds)} s; motion explains ${(100*modelFit.delay.explainedFraction).toFixed(1)}% of demeaned error variance in the delay diagnostic. Clock skew can produce the same signature. At 1 Hz, subsecond reaction details are weakly constrained.`,"font-size:12px;line-height:1.5;color:#b4c4d9;"));
        if(observed.samples.length<20) content.append(el("p","Short clip: the portable model estimates bias, amplitude and cross-axis correlation only, with independent Gaussian samples. At least 20 original samples are needed to fit operator behavior or temporal memory.","font-size:12px;line-height:1.5;color:#ffc071;"));
        const tools=el("div",undefined,"display:flex;align-items:center;gap:10px;flex-wrap:wrap;");content.append(tools);
        tools.append(el("label","Noise amplitude multiplier"));scale=el("input",undefined,"width:70px;padding:6px;");scale.type="number";scale.min="0";scale.max="100";scale.step="0.1";scale.value="1";tools.append(scale);
        const biasLabel=el("label","Include measured mean bias ");includeBias=el("input");includeBias.type="checkbox";includeBias.checked=true;biasLabel.append(includeBias);tools.append(biasLabel);
        const seed=el("input",undefined,"width:120px;padding:6px;");seed.value=generatedSeed;seed.setAttribute("aria-label","Synthetic noise seed");tools.append(el("label","New seed"),seed);
        const currentModel=()=>{
            const m=validateErrorModel(JSON.parse(editor.value)), amplitude=Number(scale.value);
            if(!Number.isFinite(amplitude)||amplitude<0||amplitude>100) throw new Error("Amplitude multiplier must be between 0 and 100.");
            if(m.modelType==="operator-feedback") {
                for(const key of ["amplitude","driftSpeed","correctionSpeed"]) m.operator[key]*=amplitude;
                m.jitterSigmaDeg=m.jitterSigmaDeg.map(x=>x*amplitude);
            } else m.innovationSigmaDeg=m.innovationSigmaDeg.map(x=>x*amplitude);
            if(!includeBias.checked) m.meanDeg=[0,0];
            return validateErrorModel(m);
        };
        button(tools,"Generate with seed",safe(async()=>{
            generatePreview(currentModel(),seed.value);
            renderTable();await renderCharts();
        }));
        button(tools,"Fresh seed",safe(async()=>{seed.value=freshSeed();generatePreview(currentModel(),seed.value);renderTable();await renderCharts();}));
        button(tools,"Export parameter model",safe(()=>saveAs(new Blob([serializeErrorModel(currentModel())],{type:"application/json"}),"LOSNoiseModel.json")));
        const input=el("input");input.type="file";input.accept=".json,application/json";input.hidden=true;tools.append(input);
        button(tools,"Import model",()=>input.click());
        input.onchange=safe(async()=>{
            if(!input.files[0]) return;
            if(input.files[0].size>100000) throw new Error("Model file is too large.");
            model=validateErrorModel(JSON.parse(await input.files[0].text()));
            modelFit=null; generatePreview(model);
            // An imported model may use a different family. Rebuild its
            // explanation and tuning controls as well as the JSON editor.
            render();
        });
        button(tools,"Export synthetic LOS CSV",safe(()=>{
            if(!generated) throw new Error("Generate a fresh realization first.");
            saveAs(new Blob([syntheticLOSCSV(captured.geometry,generated.samples,directionWithError)],{type:"text/csv"}),"SyntheticLOS.csv");
        }));
        content.append(el("p","Parameter JSON contains only statistical model parameters and rates. It excludes track geometry, dates, names, original seeds and measured samples. Synthetic CSV includes the current platform and truth positions in ECEF meters and newly generated LOS directions; handle that file according to the source data’s access rules.","font-size:12px;line-height:1.5;color:#b4c4d9;"));
        const details=el("details");details.append(el("summary","Edit model parameters (advanced)"));editor=el("textarea",undefined,"width:100%;height:250px;box-sizing:border-box;background:#101824;color:#d9e6f8;font:12px monospace;padding:10px;");
        editor.value=serializeErrorModel(model);editor.setAttribute("aria-label","LOS statistical model parameters");details.append(editor);content.append(details);
        if(model?.modelType==="operator-feedback") {
            const tuning=el("div",undefined,"display:flex;gap:12px;flex-wrap:wrap;margin:12px 0;");details.before(tuning);
            for(const [key,label] of [["amplitude","Notice threshold °"],["driftSpeed","Wander °/s"],["reactionTime","Reaction delay s"],["correctionSpeed","Correction °/s"],["accuracy","Centering accuracy 0–1"],["trackingDelaySeconds","Following delay s"]]) {
                const labelNode=el("label",label+" "),input=el("input",undefined,"width:90px;padding:5px;");input.type="number";input.step="any";input.min="0";
                input.value=String(key==="trackingDelaySeconds" ? model[key] : model.operator[key]);
                input.onchange=safe(()=>{const edited=JSON.parse(editor.value);if(key==="trackingDelaySeconds")edited[key]=Number(input.value);else edited.operator[key]=Number(input.value);editor.value=serializeErrorModel(edited);});
                labelNode.append(input);tuning.append(labelNode);
            }
        }
        const blocks=observed.views[0].summary.blocks;
        content.append(el("p",`Stationarity check, successive thirds: radial RMS ${blocks.map(b=>fmt(b.rms)+"°").join(" / ")}; H/V means ${blocks.map(b=>b.mean.map(fmt).join(" / ")+"°").join("; ")}. Large changes suggest segmentation instead of one stationary model. Finite clips give uncertain means, tails and long-lag correlations; this is a statistical characterization, not a guarantee of anonymity or a physical sensor calibration.`,"font-size:12px;line-height:1.5;color:#b4c4d9;"));
        renderCharts().catch(reportError);
    }

    function renderTable() {
        comparison.replaceChildren();const table=el("table",undefined,"width:100%;border-collapse:collapse;text-align:right;font-size:12px;");comparison.append(table);
        const head=el("tr");for(const label of ["Series / rate","N","Bias H / V °","σ H / V °","Radial RMS °","Radial p95 / p99 °","Step RMS °","H/V 1 s correlation","H/V excess kurtosis"]) head.append(el("th",label,"padding:8px;border-bottom:1px solid #75879d;"));table.append(head);
        for(const [name,result] of [["Measured",observed],["Synthetic",generated]]) if(result) for(const v of result.views) {
            const tr=el("tr"),s=v.summary;
            const values=s ? [`${name} ${v.label}`,s.n,s.mean.map(fmt).join(" / "),s.sigma.map(fmt).join(" / "),fmt(s.radialRms),[s.radialP95,s.radialP99].map(fmt).join(" / "),fmt(s.incrementRms),s.acf.find(a=>Math.abs(a.seconds-1)<.001)?.axes.map(fmt).join(" / ")??"—",s.excessKurtosis.map(fmt).join(" / ")] : [`${name} ${v.label}`,"Unavailable: fewer than two samples, or above source rate"];
            values.forEach(x=>tr.append(el("td",String(x),"padding:7px;border-bottom:1px solid #384a60;")));table.append(tr);
        }
    }

    async function renderCharts() {
        const index=Number(ratePicker.value),v=observed.views[index],g=generated?.views[index];
        if(!v.summary) return;
        const style={paper_bgcolor:"#1e2b3b",plot_bgcolor:"#1e2b3b",font:{color:"#dce7f5",size:11},margin:{t:38,l:55,r:15,b:80},height:280,autosize:true,legend:{orientation:"h",y:-.43,font:{size:10}},hovermode:"closest"};
        // Plot thinning is display-only; all statistics use all valid samples.
        const thin=rows=>rows.filter((r,i)=>i%Math.max(1,Math.ceil(rows.length/6000))===0);
        const traces=[];
        for(const [name,view,dash,opacity] of [["Measured",v,"solid",1],["Model",g,"dash",.5]]) if(view?.summary) {
            const rows=thin(view.samples);
            for(let a=0;a<2;a++) traces.push({type:"scatter",mode:"lines",name:`${name} ${a?"V":"H"}`,opacity,x:rows.map(r=>r.t),y:rows.map(r=>r.e[a]),line:{color:a?"#ffc071":"#78baff",dash,width:1}});
        }
        const distributions=[];
        for(const [name,view,dash,opacity] of [["Measured",v,"solid",1],["Model",g,"dash",.5]]) if(view?.summary) {
            const radial=view.samples.map(r=>Math.hypot(...r.e)).sort((a,b)=>a-b),stride=Math.max(1,Math.ceil(radial.length/3000));
            distributions.push({type:"scatter",mode:"lines",name,opacity,line:{color:"#78baff",dash},x:radial.filter((_,i)=>i%stride===0),y:radial.map((_,i)=>(i+1)/radial.length).filter((_,i)=>i%stride===0)});
        }
        const acf=[];
        for(const [name,view,dash,opacity] of [["Measured",v,"solid",1],["Model",g,"dash",.5]]) if(view?.summary) for(let a=0;a<2;a++) acf.push({type:"scatter",mode:"lines+markers",name:`${name} ${a?"V":"H"}`,opacity,x:view.summary.acf.map(r=>r.seconds),y:view.summary.acf.map(r=>r.axes[a]),line:{color:a?"#ffc071":"#78baff",dash}});
        await Promise.all([
            drawFigure(charts[0],{data:traces,layout:{...style,title:{text:`Angular error · ${v.label}`},xaxis:{title:{text:"Time from first valid sample (s)"}},yaxis:{title:{text:"Degrees"}}},config:{responsive:true,displayModeBar:false}}),
            drawFigure(charts[1],{data:distributions,layout:{...style,title:{text:"Radial error distribution"},xaxis:{title:{text:"Angular separation (°)"}},yaxis:{title:{text:"Cumulative fraction"},range:[0,1]}},config:{responsive:true,displayModeBar:false}}),
            drawFigure(charts[2],{data:acf,layout:{...style,title:{text:"Demeaned temporal correlation"},xaxis:{title:{text:"Lag (s)"},type:"log",tickvals:[.001,.01,.1,1,10,100],ticktext:["0.001","0.01","0.1","1","10","100"]},yaxis:{range:[-1,1]}},config:{responsive:true,displayModeBar:false}}),
        ]);
    }
    document.body.append(panel);truth.focus();return panel;
}
