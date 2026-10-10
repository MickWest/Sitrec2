// Test doubles shared by the thermal pipeline tests: renderer stand-ins around the real ThermalPipeline, a small
// sensor configuration and a WebGL 2 stand-in for fences, pixel-pack buffers and timer queries.
import {Color, PerspectiveCamera, Scene, Vector4} from "three";
import {ThermalPipeline} from "../../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../../tools/thermal/thermalSchema.js";

// A 16 × 12 detector at a free 675 mm focal length, 2× sampling, without scatter.
export const compactSettings = extra => normalizeSettings({detectorWidth: 16, detectorHeight: 12,
    fieldMode: "focalLength", focalStep: "free", focalLengthM: .675,
    opticalSamplingMode: "manual", supersample: 2, opticsRadiusPx: 4,
    scatterFraction: 0, scatterPreset: "custom", ...extra});

// Exercise the real coordinator and scene/material scope with a renderer double.
// No GPU shader execution is asserted by these tests.
export function hostFixture() {
    let target = {id:"original"}, viewport = new Vector4(2,3,4,5), scissor = new Vector4(1,2,3,4),
        scissorTest = true, clear = new Color(.1,.2,.3), alpha = .4;
    const renderer = {autoClear:true,shadowMap:{enabled:true},xr:{enabled:true},capabilities:{maxTextureSize:16384},
        toneMapping:42,outputColorSpace:"original",
        getRenderTarget:()=>target,getActiveCubeFace:()=>2,getActiveMipmapLevel:()=>3,
        getViewport:v=>v.copy(viewport),getScissor:v=>v.copy(scissor),getScissorTest:()=>scissorTest,
        getClearColor:v=>v.copy(clear),getClearAlpha:()=>alpha,
        setRenderTarget:v=>{target=v;},setViewport:(...args)=>{viewport=args[0]?.isVector4?args[0].clone():new Vector4(...args);},
        setScissor:v=>{scissor=v.clone();},setScissorTest:v=>{scissorTest=v;},setClearColor:(c,a)=>{clear=new Color(c);alpha=a;},
        clear:jest.fn(),render:jest.fn(),getSize:v=>v.set(16,12),
        getContext:()=>({FRAMEBUFFER:1,FRAMEBUFFER_COMPLETE:2,checkFramebufferStatus:()=>2}),
    };
    const pipeline = new ThermalPipeline(renderer);
    pipeline.resources={targets:new Map(),materials:new Map(),surfaces:new Map(),textures:new Set(),checkedSizes:new WeakMap()};
    pipeline.emptyTexture={}; pipeline.quad={geometry:{dispose() {}}};
    pipeline._prepareOptics=()=>{pipeline.scatterSplit={farMass:0};};
    pipeline._optics=()=>{};pipeline._prepareFixedPattern=()=>{};
    pipeline._prepareSkyBackground=()=>{pipeline.background={scaledPhotonRadiance:0};};
    pipeline._pass=jest.fn();
    pipeline._coverageTiles=()=>{pipeline.coverageBounds=new Map();return [];};
    pipeline._read=()=>new Float32Array([100,200,300,400]);
    const settings=normalizeSettings({detectorWidth:2,detectorHeight:2,fieldMode:"focalLength",focalLengthM:.1,
        atmosphereEnabled:false,skySource:"manual",gainMode:"automatic",gainRegion:"detector",agcTimeConstantS:1});
    const scene=new Scene(),camera=new PerspectiveCamera(1,1,1,500000);
    const state=()=>({target:renderer.getRenderTarget(),viewport:renderer.getViewport(new Vector4()),
        scissor:renderer.getScissor(new Vector4()),scissorTest:renderer.getScissorTest(),clear:renderer.getClearColor(new Color()),
        alpha:renderer.getClearAlpha(),autoClear:renderer.autoClear,shadow:renderer.shadowMap.enabled,xr:renderer.xr.enabled,
        toneMapping:renderer.toneMapping,outputColorSpace:renderer.outputColorSpace});
    return {pipeline,renderer,settings,scene,camera,state};
}

// The coordinator and gain statistics are real; the renderer does not execute shaders.
export function coordinatorFixture({width = 2, height = 2, automatic = false} = {}) {
    let target = null, viewport = new Vector4(1, 2, 3, 4), scissor = new Vector4(2, 3, 4, 5);
    const renderer = {autoClear: true, shadowMap: {enabled: true}, xr: {enabled: true},
        capabilities: {maxTextureSize: 16384}, getRenderTarget: () => target,
        getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
        getViewport: v => v.copy(viewport), getScissor: v => v.copy(scissor), getScissorTest: () => false,
        getClearColor: v => v.copy(new Color()), getClearAlpha: () => 1,
        setRenderTarget: v => {target = v;}, setViewport: v => {viewport = v.clone();},
        setScissor: v => {scissor = v.clone();}, setScissorTest() {}, setClearColor() {},
        getSize: v => v.set(width, height), getContext: () => ({FRAMEBUFFER: 1,
            FRAMEBUFFER_COMPLETE: 2, checkFramebufferStatus: () => 2})};
    const pipeline = new ThermalPipeline(renderer, {analysis: false, synchronous: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(),
        textures: new Set(), checkedSizes: new WeakMap()};
    pipeline.emptyTexture = {};
    pipeline._prepareAtmosphere = jest.fn();
    pipeline._prepareOptics = jest.fn(() => {pipeline.scatterSplit = {farMass: 0};});
    pipeline._prepareSkyBackground = jest.fn(() => {pipeline.background = {scaledPhotonRadiance: 0};});
    pipeline._radiance = jest.fn(); pipeline._optics = jest.fn(); pipeline._prepareFixedPattern = jest.fn();
    pipeline._pass = jest.fn();
    const counts = Float32Array.from({length: width * height}, (_, i) => 1000 + (i * 7919 % 12000));
    // Like the real readback, a sample carries the scene and image-state identity of the render that queued it.
    pipeline.gainReadback = {poll: () => pipeline.gainKey ? {counts, key: pipeline.gainKey, serial: pipeline.renderSerial - 1, frame: 10,
        scene: pipeline.renderSceneKey == null ? null : `${pipeline.renderSceneKey}#${pipeline._imageStateEpoch()}`} : null,
    enqueue: () => true, dispose() {}};
    const inputs = {scene: new Scene(), camera: new PerspectiveCamera(1, width / height, 1, 500000),
        settings: normalizeSettings({detectorWidth: width, detectorHeight: height, gainMode: automatic ? "automatic" : "manual",
            atmosphereEnabled: false, skySource: "manual", gainRegion: "detector"}), frame: 10, reuseKey: "same"};
    const clear = () => {for (const name of ["_prepareAtmosphere", "_prepareOptics", "_prepareSkyBackground", "_radiance", "_optics", "_prepareFixedPattern", "_pass"]) pipeline[name].mockClear();};
    return {pipeline, inputs, clear, renderer};
}

export function fakeGl() {
    const gl = Object.fromEntries(["PIXEL_PACK_BUFFER_BINDING", "PACK_ALIGNMENT", "PACK_ROW_LENGTH", "PACK_SKIP_PIXELS",
        "PACK_SKIP_ROWS", "PIXEL_PACK_BUFFER", "STREAM_READ", "RGBA", "FLOAT", "SYNC_GPU_COMMANDS_COMPLETE",
        "TIMEOUT_EXPIRED", "WAIT_FAILED", "CONDITION_SATISFIED", "CURRENT_QUERY", "QUERY_RESULT_AVAILABLE", "QUERY_RESULT"].map((name, i) => [name, i + 1]));
    Object.assign(gl, {getParameter: jest.fn(() => 0), createBuffer: jest.fn(() => ({})), bindBuffer: jest.fn(),
        bufferData: jest.fn(), pixelStorei: jest.fn(), readPixels: jest.fn(), fenceSync: jest.fn(() => ({})),
        flush: jest.fn(), deleteBuffer: jest.fn(), deleteSync: jest.fn(),
        clientWaitSync: jest.fn(() => gl.TIMEOUT_EXPIRED),
        getBufferSubData: jest.fn((target, offset, data) => data.set([10, 0, 0, 1, 20, 0, 0, 1]))});
    return gl;
}
