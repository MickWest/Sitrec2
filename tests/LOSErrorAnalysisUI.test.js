/** @jest-environment jsdom */
import {addLOSErrorButton,openLOSErrorAnalysis} from "../src/LOSErrorAnalysisUI";
import {Globals} from "../src/Globals";
import {collectLOSErrorSamples} from "../src/LOSErrorData";
import {saveAs} from "file-saver";
import {drawFigure} from "../src/analysis/charts/PlotlyLoader";

jest.mock("../src/Globals",()=>({Globals:{loadGeneration:1},Sit:{frames:301,fps:10},
    NodeMan:{get:jest.fn(()=>({frames:301,p:()=>({})})),iterate:jest.fn()},TrackManager:{iterate:jest.fn()}}));
jest.mock("../src/AnalyzeTraverse",()=>({resolveLOSNode:()=>({frames:301}),resolveTruthTrack:()=>({trackID:"truth"}),truthTrackOptions:()=>({Truth:"truth"})}));
jest.mock("../src/AnalysisAngleSmoothing",()=>({withUnfilteredAnalysisAngles:async(los,fn)=>fn()}));
jest.mock("../src/TraverseAnalysisData",()=>({abFrameRange:()=>({frame0:0,frame1:300})}));
jest.mock("../src/LOSErrorData",()=>({collectLOSErrorSamples:jest.fn(),syntheticLOSCSV:()=>"new synthetic CSV"}));
jest.mock("../src/analysis/charts/PlotlyLoader",()=>({drawFigure:jest.fn(async()=>{}),purgeFigure:jest.fn()}));
jest.mock("../src/DragResizeUtils",()=>({makeDraggable:jest.fn(),removeDraggable:jest.fn()}));
jest.mock("file-saver",()=>({saveAs:jest.fn()}));

const click=async(label)=>{
    const button=[...document.querySelectorAll("button")].find(b=>b.textContent===label);
    expect(button).toBeDefined();await button.onclick();
};
afterEach(async()=>{if(document.querySelector("#los-error-analysis"))await click("Close");jest.clearAllMocks();});

test("menu registration is idempotent across repeated traverse setup",()=>{
    const ctrl={name:jest.fn().mockReturnThis(),tooltip:jest.fn()},folder={controllers:[],add:jest.fn(()=>{folder.controllers.push(ctrl);return ctrl;})};
    addLOSErrorButton(folder);addLOSErrorButton(folder);
    expect(folder.add).toHaveBeenCalledTimes(1);
});

test("analysis automatically previews the portable model on all graphs; export stays explicit",async()=>{
    const samples=Array.from({length:301},(_,i)=>({t:i/10,e:[.1*Math.sin(i/12),.15*Math.cos(i/10)]}));
    collectLOSErrorSamples.mockReturnValue({samples,geometry:[],counts:{},cadenceSource:"Original timestamps",cadence:{hz:10,gaps:0},losLabel:"Recorded"});
    openLOSErrorAnalysis();await click("Analyze");
    expect(document.querySelector("table").textContent).toContain("Measured 1 Hz");
    expect(document.querySelector("table").textContent).toContain("Synthetic Original");
    expect(drawFigure).toHaveBeenCalledTimes(3);
    for(const [,figure] of drawFigure.mock.calls) {
        const models=figure.data.filter(trace=>trace.name.startsWith("Model"));
        expect(models.length).toBeGreaterThan(0);
        expect(models.every(trace=>trace.opacity===.5 && trace.line.dash==="dash")).toBe(true);
        expect(figure.data.filter(trace=>trace.name.startsWith("Measured")).every(trace=>trace.opacity===1 && trace.line.dash==="solid")).toBe(true);
    }
    expect(saveAs).not.toHaveBeenCalled();
    const before=document.querySelector("table").textContent;
    await click("Fresh seed");
    expect(document.querySelector("table").textContent).toContain("Synthetic Original");
    expect(document.querySelector("table").textContent).not.toBe(before);
    await click("Export parameter model");
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob),"LOSNoiseModel.json");
    expect(document.querySelector("textarea").value).not.toMatch(/Recorded|samples|geometry|timestamp/);
    const imported={schema:"sitrec-los-error-model",version:1,basis:"local-up-cross-clean-los",sampleRateHz:10,
        meanDeg:[0,0],reflection:[[],[]],innovationSigmaDeg:[.1,.1],innovationCorrelation:0,innovationDistribution:"gaussian"};
    const fileInput=document.querySelector('input[type="file"]');
    Object.defineProperty(fileInput,"files",{value:[{size:100,text:async()=>JSON.stringify(imported)}]});
    await fileInput.onchange();
    expect(document.querySelector("#los-error-analysis").textContent).toContain("This stationary Gaussian autoregressive model");
    expect(document.querySelector("#los-error-analysis").textContent).not.toContain("Notice threshold °");
    expect(document.querySelector("table").textContent).toContain("Synthetic Original");
    await click("Fresh seed");
    expect(document.querySelector("table").textContent).toContain("Synthetic Original");
    await click("Close");expect(document.querySelector("#los-error-analysis")).toBeNull();
});

test("short successful analysis still provides an exportable amplitude model and automatic overlay",async()=>{
    const samples=Array.from({length:8},(_,i)=>({t:i,e:[.1*Math.sin(i),.15*Math.cos(i)]}));
    collectLOSErrorSamples.mockReturnValue({samples,geometry:[],counts:{},cadenceSource:"Original timestamps",cadence:{hz:1,gaps:0},losLabel:"Recorded"});
    openLOSErrorAnalysis();await click("Analyze");
    expect(document.querySelector("#los-error-analysis").textContent).toContain("Short clip:");
    expect(document.querySelector("table").textContent).toContain("Synthetic Original");
    expect(JSON.parse(document.querySelector("textarea").value).reflection).toEqual([[],[]]);
    await click("Export parameter model");
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob),"LOSNoiseModel.json");
});

test("missing truth shows a useful error and scene replacement closes the private display",async()=>{
    jest.useFakeTimers();
    openLOSErrorAnalysis();document.querySelector('select[aria-label="LOS error truth track"]').value="";
    await click("Analyze");expect(document.querySelector("#los-error-analysis").textContent).toContain("Select a loaded truth track");
    Globals.loadGeneration++;jest.advanceTimersByTime(500);
    expect(document.querySelector("#los-error-analysis")).toBeNull();jest.useRealTimers();
});
