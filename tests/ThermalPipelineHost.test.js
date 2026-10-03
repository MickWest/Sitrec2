import {BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector2, Vector4, WebGLRenderTarget} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {buildOpticalDomain, displayCurveLUT, processingParameters} from "../tools/thermal/sensorMath.js";
import {thermalSceneAtmosphere} from "../src/rendering/ThermalSceneAdapters";

// Exercise the real coordinator and scene/material scope with a renderer double.
// No GPU shader execution is asserted by these tests.
function fixture() {
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
    pipeline._prepareSkyBackground=()=>{pipeline.background={scaledPhotonRadiance:0};pipeline.skyView={up:[0,1,0]};};
    pipeline._pass=jest.fn();
    pipeline._coverageTiles=()=>[];
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

test("paused, revisited and backward frames recompute gain; advancing frames still settle",()=>{
    const {pipeline,settings,scene,camera}=fixture();
    pipeline.render({scene,camera,settings,frame:10});const old={...pipeline.window};
    const codes=new Float32Array([1100,1200,1300,1400]);pipeline._read=()=>codes;
    pipeline.render({scene,camera,settings,frame:11});
    expect(pipeline.window.low).toBeGreaterThan(old.low);expect(pipeline.window.low).toBeLessThan(1100);
    const fresh=processingParameters(codes,settings).window;
    pipeline.render({scene,camera,settings,frame:11});expect(pipeline.window).toEqual(fresh);
    pipeline._read=()=>new Float32Array([2100,2200,2300,2400]);camera.position.x=20;
    pipeline.render({scene,camera,settings,frame:11});expect(pipeline.window.low).toBe(2100);
    pipeline._read=()=>codes;pipeline.render({scene,camera,settings,frame:3});expect(pipeline.window).toEqual(fresh);
    pipeline.dispose();
});

test("interactive render restores the host and never performs a synchronous gain read", () => {
    const {pipeline, settings, scene, camera, state} = fixture(), before = state();
    pipeline.analysis = false;
    pipeline._read = () => {throw new Error("synchronous frame read");};
    pipeline.gainReadback = {poll: jest.fn(() => null), enqueue: jest.fn(() => true), dispose() {}};
    pipeline.render({scene, camera, settings, frame: 10});
    expect(pipeline.lastFrame.gain).toMatchObject({mode: "fenced", held: true, queued: true});
    pipeline.gainReadback.poll.mockReturnValue({counts: new Float32Array([100, 200, 300, 400]),
        key: pipeline.gainKey, serial: 1, frame: 10});
    pipeline.render({scene, camera, settings, frame: 11});
    expect(pipeline.lastFrame.gain).toMatchObject({mode: "fenced", held: false, latencyFrames: 1});
    expect(state()).toEqual(before); expect(pipeline.gainReadback.enqueue).toHaveBeenCalledTimes(2);
    pipeline.dispose();
});

test("a paused interactive render keeps drawing with its last valid kernel during a worker rebuild", async () => {
    const {pipeline, settings, scene, camera, state} = fixture(), before = state();
    const worker = {postMessage: jest.fn(), terminate: jest.fn()};
    pipeline.analysis = false; pipeline.synchronous = false;
    pipeline.opticsScheduler.createWorker = () => worker;
    pipeline._prepareOptics = ThermalPipeline.prototype._prepareOptics;
    pipeline._prepareSpectrum = jest.fn();
    const configured = {...settings, gainMode: "manual", opticsRadiusPx: 2};
    try {
        pipeline.render({scene, camera, settings: configured, frame: 10});
        expect(pipeline.hasFrame).toBe(true);
        expect(pipeline.lastFrame.opticsCache.quality).toBe("coarse");
        await pipeline.opticsScheduler.workerPromise;
        await Promise.resolve();
        const message = worker.postMessage.mock.calls[0][0];
        worker.onmessage({data: {id: message.id, domain: buildOpticalDomain(message.settings,
            message.width, message.height, message.spectrum)}});
        pipeline.render({scene, camera, settings: configured, frame: 11});
        const kernel = pipeline.activeKernels;
        pipeline._pass.mockClear();
        pipeline.render({scene, camera, settings: {...configured, defocusM: 1e-5}, frame: 11});
        expect(pipeline.activeKernels).toBe(kernel);
        expect(pipeline.hasFrame).toBe(true);
        expect(pipeline.lastFrame.opticsCache).toMatchObject({pending: true, quality: "retained", errorL1: 2});
        expect(pipeline._pass.mock.calls.some(([name]) => name === "enlarge")).toBe(true);
        expect(() => pipeline.readStage("display")).not.toThrow();
        expect(state()).toEqual(before);
    } finally {pipeline.dispose();}
});

test("deferred preparation redraws the completed display and preserves readback", () => {
    const {pipeline, settings, scene, camera, state} = fixture(), before = state();
    try {
        pipeline.render({scene, camera, settings, frame: 10});
        const display = pipeline.resources.targets.get("display"), previous = pipeline.lastFrame;
        pipeline._prepareAtmosphere = () => false;
        pipeline._pass.mockClear();
        expect(pipeline.render({scene, camera, settings, frame: 10})).toBe(false);
        expect(pipeline.hasFrame).toBe(true);
        expect(pipeline.lastFrame).toBe(previous);
        expect(pipeline.lastFrame.held).toBe(true);
        expect(pipeline._pass.mock.calls.at(-1)[2].tInput).toBe(display.texture);
        expect(() => pipeline.readStage("display")).not.toThrow();
        expect(state()).toEqual(before);
    } finally {pipeline.dispose();}
});

test("offline renders complete synchronously without constructing a worker", () => {
    const {pipeline, settings, scene, camera} = fixture();
    pipeline._prepareOptics = ThermalPipeline.prototype._prepareOptics;
    pipeline._prepareSpectrum = jest.fn();
    pipeline.opticsScheduler.createWorker = () => {throw Error("offline render requested a worker");};
    try {
        for (const frame of [0, 1, 1]) {
            pipeline.render({scene, camera, settings: {...settings, opticsRadiusPx: 2,
                atmosphereEnabled: true, atmosphereMaxRangeM: 2000}, frame});
            expect(pipeline.hasFrame).toBe(true);
            expect(pipeline.lastFrame.opticsCache).toMatchObject({pending: false, quality: "full", errorL1: 0});
            expect(() => pipeline.readStage("display")).not.toThrow();
        }
    } finally {pipeline.dispose();}
});

test("display shader receives the CPU LUT and affine; curve changes release cached textures", () => {
    const {pipeline, settings, scene, camera} = fixture();
    const configured = {...settings, displayCurve: "measured", polarityAffine: {gain: 1.05, offset: 55},
        systemBlurHorizontalRmsUrad: 8, systemBlurVerticalRmsUrad: 40};
    const draw = extra => pipeline.render({scene, camera, settings: {...configured, ...extra}, frame: 3});
    try {
        draw();
        const uniforms = pipeline._pass.mock.calls.find(([name]) => name === "display")[2];
        const texture = uniforms.tDisplayCurve;
        expect(texture.image.data).toEqual(displayCurveLUT(configured));
        expect(uniforms).toMatchObject({useDisplayCurve: true, polarityAffine: [1.05, 55], blackHot: false});
        expect(pipeline.lastFrame.blur).toMatchObject({systemBlurHorizontalRmsUrad: 8, systemBlurVerticalRmsUrad: 40});
        const dispose = jest.spyOn(texture, "dispose");
        draw({polarity: "blackHot"});
        expect(pipeline.displayCurveTexture).toBe(texture);
        draw({displayCurve: "linear"});
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(pipeline.resources.textures.has(texture)).toBe(false);
        expect(pipeline._pass.mock.calls.filter(([name]) => name === "display").at(-1)[2])
            .toMatchObject({useDisplayCurve: false, tDisplayCurve: pipeline.emptyTexture});
        draw();
        expect(pipeline.displayCurveTexture).not.toBe(texture);
    } finally {pipeline.dispose();}
});

test("host vehicle and pipeline use identical standard and sounding profiles, including edited contents",()=>{
    const {pipeline,settings}=fixture();
    // Estimated synthetic sounding, with a deliberately different sea-level setting.
    const sounding={levels:[{geopotentialHeightM:0,pressurePa:101325,temperatureK:295,relativeHumidityPct:50},
        {geopotentialHeightM:4000,pressurePa:60000,temperatureK:265,relativeHumidityPct:30}]};
    try {
        for(const supplied of [null,sounding]) {
            const configured={...settings,surfaceTemperatureK:300,waterVaporDensityKgM3:.005};
            pipeline._prepareAtmosphere(configured,supplied);
            const host=thermalSceneAtmosphere(configured,supplied);
            for(const altitudeM of [0,1000,3200,4000,12000]) expect(host.sample(altitudeM)).toEqual(pipeline.atmosphere.sample(altitudeM));
        }
        sounding.levels[1].temperatureK=270;
        pipeline._prepareAtmosphere(settings,sounding);
        expect(thermalSceneAtmosphere(settings,sounding).sample(3200)).toEqual(pipeline.atmosphere.sample(3200));
    } finally {pipeline.dispose();}
});

test.each(["surface", "scene", "optics", "output"])("renderer, materials, visibility and callbacks restore after %s failure",stage=>{
    const {pipeline,renderer,settings,scene,camera,state}=fixture();
    const originalMaterial=new MeshBasicMaterial(), mesh=new Mesh(new BoxGeometry(),originalMaterial);
    const excluded=new Mesh(new BoxGeometry(),new MeshBasicMaterial());scene.add(mesh,excluded);
    const background=scene.background=new Color("red"), override=scene.overrideMaterial=new MeshBasicMaterial();
    const before=mesh.onBeforeRender=jest.fn(),after=mesh.onAfterRender=jest.fn();
    const target=new WebGLRenderTarget(10,10);target.viewport.set(2,3,4,5);target.scissorTest=true;
    const originalState=state();
    const adapter={attributes:object=>object===excluded?false:undefined,prepareMaterial:()=>{if(stage==="surface")throw Error("surface");}};
    renderer.render.mockImplementation(()=>{
        expect(mesh.material).not.toBe(originalMaterial);expect(excluded.visible).toBe(false);
        expect(mesh.frustumCulled).toBe(false);expect(mesh.onBeforeRender).not.toBe(before);
        if(stage==="scene")throw Error("scene");
    });
    if(stage==="optics")pipeline._optics=()=>{throw Error("optics");};
    pipeline._pass.mockImplementation(name=>{if(name==="enlarge"&&stage==="output")throw Error("output");});
    expect(()=>pipeline.render({scene,camera,settings,target,radianceAdapter:adapter})).toThrow(stage);
    expect(state()).toEqual(originalState);expect(mesh.material).toBe(originalMaterial);expect(mesh.visible).toBe(true);
    expect(excluded.visible).toBe(true);expect(mesh.frustumCulled).toBe(true);
    expect(mesh.onBeforeRender).toBe(before);expect(mesh.onAfterRender).toBe(after);
    expect(scene.background).toBe(background);expect(scene.overrideMaterial).toBe(override);
    expect(target.viewport).toEqual(new Vector4(2,3,4,5));expect(target.scissorTest).toBe(true);
    expect(pipeline.hasFrame).toBe(false);pipeline.dispose();target.dispose();
});

test("ECEF native coverage uses double precision and apparent lift while physical range validation stays unchanged",()=>{
    const {pipeline,settings}=fixture();
    const root=new Group(),mesh=new Mesh(new BoxGeometry(.01,.01,.01),new MeshBasicMaterial());root.add(mesh);
    root.position.set(6378137,125000,0);root.updateMatrixWorld(true);
    const camera=new PerspectiveCamera(1,1,1,300000);camera.position.set(6378137,0,0);camera.up.set(1,0,0);camera.lookAt(root.position);camera.updateMatrixWorld(true);
    const sample={...settings,detectorWidth:640,detectorHeight:512,atmosphereMaxRangeM:200000,atmosphereEnabled:true};
    const coverage=ThermalPipeline.prototype._coverageTiles.call(pipeline,[mesh],camera,sample);
    expect([...coverage].length).toBeGreaterThan(0);
    const project=jest.fn(point=>{point.x+=100;});pipeline.radianceAdapter={projectPoint:project};
    const shifted=[...ThermalPipeline.prototype._coverageTiles.call(pipeline,[mesh],camera,sample)];
    expect(project).toHaveBeenCalledTimes(8);expect(shifted[0][0]).toBeGreaterThan(320);
    expect(()=>ThermalPipeline.prototype._coverageTiles.call(pipeline,[mesh],camera,{...sample,atmosphereMaxRangeM:100000})).toThrow(/range/i);
    pipeline.dispose();
});
