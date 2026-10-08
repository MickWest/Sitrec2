import {BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector2, Vector4, WebGLRenderTarget} from "three";
import {projectedSurfaceBounds, projectedSurfaceOutside, ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
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

test("coverage refinement skips meshes outside the image and surfaces, and bounds its tiles",()=>{
    const {pipeline,settings}=fixture();
    const sample={...settings,detectorWidth:640,detectorHeight:512,atmosphereMaxRangeM:200000,atmosphereEnabled:true};
    const camera=new PerspectiveCamera(1,640/512,1,1e7);camera.updateMatrixWorld(true);
    const tiles=meshes=>[...ThermalPipeline.prototype._coverageTiles.call(pipeline,meshes,camera,sample)];
    const mesh=new Mesh(new BoxGeometry(10,10,10),new MeshBasicMaterial());
    const at=(x,z)=>{mesh.position.set(x,0,z);mesh.updateMatrixWorld(true);return tiles([mesh]);};
    // 250 km away and 5 degrees outside a 1 degree field: before the fix this stopped every frame.
    expect(at(250000*Math.sin(5*Math.PI/180),-250000*Math.cos(5*Math.PI/180))).toEqual([]);
    expect(at(0,250000)).toEqual([]); // behind the camera
    expect(()=>at(0,-250000)).toThrow(/range/i); // in the image: still an explicit error
    // A long, thin surface across the image (edge-on ground) would need ~160 full-scene tiles; interactively it gets none.
    const strip=new Mesh(new BoxGeometry(2000,1,1),new MeshBasicMaterial());strip.position.set(0,0,-50000);strip.updateMatrixWorld(true);
    pipeline.analysis=false;pipeline.synchronous=false;
    pipeline.radianceAdapter={isSurface:candidate=>candidate===strip};
    expect(tiles([strip])).toEqual([]);
    expect(pipeline.coverageBounds.get(strip)).toHaveLength(4);
    // A flat ground tile straddles the camera but lies wholly below a narrow, upward-pointing field.
    const ground=new Mesh(new BoxGeometry(2000,1,2000),new MeshBasicMaterial());
    ground.position.set(0,-100,0);ground.updateMatrixWorld(true);
    camera.rotation.x=.04;camera.updateMatrixWorld(true);
    expect(tiles([ground])).toEqual([]);
    expect(pipeline.coverageBounds.get(ground)).toEqual([]);
    ground.geometry.dispose();ground.material.dispose();
    camera.rotation.x=0;camera.updateMatrixWorld(true);
    // As a non-surface the same strip is refined, but never beyond the per-frame budget.
    pipeline.radianceAdapter={};
    const refined=tiles([strip]);
    expect(pipeline.coverageReport.tiles).toBeGreaterThan(64);expect(refined).toHaveLength(64);
    expect(pipeline.coverageReport).toMatchObject({refined:64,limit:64});
    // Analysis renders keep the complete refinement, surfaces included, so their results do not change.
    pipeline.analysis=true;pipeline.radianceAdapter={isSurface:candidate=>candidate===strip};
    expect(tiles([strip]).length).toBe(pipeline.coverageReport.tiles);expect(pipeline.coverageReport.tiles).toBeGreaterThan(64);
    for (const item of [mesh,strip]) {item.geometry.dispose();item.material.dispose();}
    pipeline.dispose();
});

test("cached coverage geometry follows position uploads and retains a near-plane occluder",()=>{
    const {pipeline,settings}=fixture(), camera=new PerspectiveCamera(10,1,1,10000);
    camera.updateMatrixWorld(true);
    const mesh=new Mesh(new BoxGeometry(2,2,2),new MeshBasicMaterial());
    mesh.position.z=-1;mesh.updateMatrixWorld(true);
    const run=()=>ThermalPipeline.prototype._coverageTiles.call(pipeline,[mesh],camera,{...settings,atmosphereEnabled:false});
    run();expect(pipeline.coverageBounds.get(mesh)).toBeNull();
    const first=pipeline.geometryBounds.get(mesh.geometry).bounds;
    run();expect(pipeline.geometryBounds.get(mesh.geometry).bounds).toBe(first);
    mesh.geometry.attributes.position.setX(0,20);mesh.geometry.attributes.position.needsUpdate=true;
    run();expect(pipeline.geometryBounds.get(mesh.geometry).bounds).not.toBe(first);
    expect(pipeline.geometryBounds.get(mesh.geometry).bounds.max.x).toBe(20);
    mesh.geometry.dispose();mesh.material.dispose();pipeline.dispose();
});

test("surface vertex clipping excludes a loose-box false positive, keeps an intersecting triangle and applies apparent lift",()=>{
    const camera=new PerspectiveCamera(10,1,1,10000);camera.updateMatrixWorld(true);
    const geometry=new BufferGeometry();
    // Its box combines y=-10 with z=-150 (inside the field); all actual vertices are below the bottom plane.
    geometry.setAttribute("position",new Float32BufferAttribute([-10,-20,-150,10,-20,-150,0,-10,-50],3));
    const position=geometry.attributes.position;
    expect(projectedSurfaceOutside(position,new Matrix4(),camera,null,640,512)).toBe(true);
    expect(projectedSurfaceBounds(geometry,new Matrix4(),camera,null,640,512)).toEqual([]);
    expect(projectedSurfaceOutside(position,new Matrix4(),camera,p=>{p.y+=15;},640,512)).toBe(false);
    position.setY(2,0);
    expect(projectedSurfaceOutside(position,new Matrix4(),camera,null,640,512)).toBe(false);
    const bounds=projectedSurfaceBounds(geometry,new Matrix4(),camera,null,640,512);
    expect(bounds[0]).toBeLessThan(320);expect(bounds[2]).toBeGreaterThan(320);
    expect(bounds[1]).toBeLessThan(0);expect(bounds[3]).toBeGreaterThan(256);
    geometry.dispose();
});

test("surface triangle clipping keeps an image-spanning triangle whose vertices are all offscreen",()=>{
    const camera=new PerspectiveCamera(10,1,1,10000),geometry=new BufferGeometry();
    geometry.setAttribute("position",new Float32BufferAttribute([-2,-2,-10,2,-2,-10,0,2,-10],3));
    const bounds=projectedSurfaceBounds(geometry,new Matrix4(),camera,null,640,512);
    expect(bounds[0]).toBeLessThan(0);expect(bounds[1]).toBeLessThan(0);
    expect(bounds[2]).toBeGreaterThan(640);expect(bounds[3]).toBeGreaterThan(512);
    geometry.dispose();
});

test("sea depth skips an all-sky view, keeps a horizon crossing and respects the apparent horizon",()=>{
    const {pipeline,settings,scene,camera}=fixture(),configured={...settings,skySource:"atmosphere",sensorAltitudeM:1000};
    const run=e=>{
        pipeline._pass.mockClear();
        pipeline.render({scene,camera,settings:configured,frame:1,skyUp:[0,Math.cos(e),-Math.sin(e)]});
        return pipeline._pass.mock.calls.some(([name])=>name==="seaDepth");
    };
    expect(run(0)).toBe(false);
    const horizon=-Math.acos(6371000/(6371000+1000));
    expect(run(horizon)).toBe(true);expect(run(-.05)).toBe(true);
    pipeline._prepareSkyBackground=()=>{pipeline.background={scaledPhotonRadiance:0};pipeline.rayGeometry={horizonRad:.01};};
    expect(run(0)).toBe(true);
    pipeline.dispose();
});

test.each([2048,16384])("GPU histogram stacks fit a %i-pixel texture limit",maximum=>{
    const {pipeline,renderer,settings}=fixture();
    pipeline.analysis=false;renderer.capabilities.maxTextureSize=maximum;
    pipeline._scatter=jest.fn();
    pipeline._gpuGain({texture:{}},{...settings,gainMode:"automatic"},
        {reset:true,deltaTimeS:0,width:2,height:2,presentation:null,frame:0});
    for(const [uniforms,target,samples] of pipeline._scatter.mock.calls) {
        expect(target.height).toBeLessThanOrEqual(maximum);
        expect(uniforms.copies).toBe(Math.min(32,Math.floor(maximum/uniforms.histogramSize[1])));
        expect(samples).toBe(4);
    }
    expect(pipeline._scatter).toHaveBeenCalledTimes(2);
    pipeline.dispose();
});
