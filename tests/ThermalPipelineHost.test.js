// The real coordinator around a renderer double: host state restored, the radiance scope (materials, visibility,
// callbacks), coverage tiles, surface clipping, cloud occlusion, atmosphere sharing and GPU timing.
// No GPU shader execution is asserted by these tests.
import {BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector4, WebGLRenderTarget} from "three";
import {projectedSurfaceBounds, projectedSurfaceOutside, ThermalGpuTimer, ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {buildOpticalDomain, displayCurveLUT} from "../tools/thermal/sensorMath.js";
import {thermalSceneAtmosphere} from "../src/rendering/ThermalSceneAdapters";
import * as soundingModule from "../tools/thermal/sounding.js";
import {createAtmosphere} from "../tools/thermal/atmosphere.js";
import {fakeGl, hostFixture as fixture} from "./fixtures/thermalPipelineDoubles.js";

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

test("host vehicle and pipeline use identical standard and sounding profiles, including a replaced sounding",()=>{
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
        // A sounding is a value: an edited profile arrives as a new object.
        const edited={...sounding,levels:[sounding.levels[0],{...sounding.levels[1],temperatureK:270}]};
        pipeline._prepareAtmosphere(settings,edited);
        expect(thermalSceneAtmosphere(settings,edited).sample(3200)).toEqual(pipeline.atmosphere.sample(3200));
        expect(pipeline.atmosphere.sample(3200).temperatureK).not.toBe(thermalSceneAtmosphere(settings,sounding).sample(3200).temperatureK);
    } finally {pipeline.dispose();}
});

test("a loaded sounding's atmosphere is built once per sounding, not on every frame, and the host shares it",()=>{
    const {pipeline,settings}=fixture();
    const sounding={levels:[{geopotentialHeightM:0,pressurePa:101325,temperatureK:295,relativeHumidityPct:50},
        {geopotentialHeightM:4000,pressurePa:60000,temperatureK:265,relativeHumidityPct:30}]};
    const build=jest.spyOn(soundingModule,"atmosphereFromSounding");
    try {
        pipeline._prepareAtmosphere(settings,sounding);
        const atmosphere=pipeline.atmosphere, profileKey=pipeline.profileKey;
        for(let frame=0;frame<5;frame++) pipeline._prepareAtmosphere({...settings,sensorAltitudeM:100+frame},sounding);
        expect(build).toHaveBeenCalledTimes(1);
        expect(pipeline.atmosphere).toBe(atmosphere);expect(pipeline.profileKey).toBe(profileKey);
        // The cache keys name the profile by a short identity, not by the sounding's levels.
        expect(profileKey.length).toBeLessThan(32);
        expect(thermalSceneAtmosphere(settings,sounding)).toBe(atmosphere);expect(build).toHaveBeenCalledTimes(1);
        // Other extinction options are another atmosphere; a new sounding object is another profile.
        pipeline._prepareAtmosphere({...settings,visibilityM:settings.visibilityM/2},sounding);
        expect(build).toHaveBeenCalledTimes(2);expect(pipeline.profileKey).not.toBe(profileKey);
        pipeline._prepareAtmosphere(settings,{...sounding});expect(build).toHaveBeenCalledTimes(3);
    } finally {build.mockRestore();pipeline.dispose();}
});

// Without refraction the cloud pass tests each sheet sample against the opaque meshes on the CPU (raycasts).
function cloudOcclusionFixture() {
    const renderer={extensions:{has:()=>true},clear:jest.fn(),setRenderTarget:jest.fn(),setScissorTest:jest.fn(),render:jest.fn()};
    const pipeline=new ThermalPipeline(renderer);
    pipeline.resources={surfaces:new Map()};pipeline._drawSky=()=>{};pipeline._pass=()=>{};
    pipeline._coverageTiles=()=>{pipeline.coverageBounds=new Map();return [];};
    pipeline._surface=()=>opaque;
    pipeline.atmosphere=createAtmosphere();pipeline.profileKey="standard";pipeline.skyView={up:[0,1,0]};
    const scene=new Scene(),camera=new PerspectiveCamera(4,1,1,100000);camera.updateMatrixWorld();
    const opaque=new MeshBasicMaterial(),occluder=new Mesh(new BoxGeometry(20,100,10),new MeshBasicMaterial());
    occluder.position.set(20,0,-5000);scene.add(occluder);
    const raycast=jest.spyOn(occluder,"raycast");
    // An estimated sheet behind the occluder's edge, in camera coordinates.
    const sheets=[{id:"a",center:[0,0,-10000],size:[100,50],temperatureK:275,opticalDepth:1,mask:{}}];
    pipeline.radianceAdapter={attributes:()=>({temperatureK:300,emissivity:1}),cloudSheets:()=>({sheets,diagnostics:[]})};
    const settings=normalizeSettings({detectorWidth:8,detectorHeight:8,sensorAltitudeM:3000});
    const target=new WebGLRenderTarget(16,16);
    const draw=()=>{raycast.mockClear();pipeline._radiance(scene,camera,settings,target,0);
        return {texture:pipeline.cloudPass.sheets[0].table.texture,data:pipeline.cloudPass.sheets[0].table.texture.image.data,
            raycasts:raycast.mock.calls.length,report:{...pipeline.cloudPass.report}};};
    const dispose=()=>{pipeline.cloudPass?.dispose();target.dispose();occluder.geometry.dispose();occluder.material.dispose();opaque.dispose();};
    return {pipeline,scene,camera,occluder,draw,dispose};
}

test("without refraction, cloud occlusion is tested again only when the camera or an occluder changes, with the same table",()=>{
    const {occluder,camera,draw,dispose}=cloudOcclusionFixture(), fresh=cloudOcclusionFixture();
    try {
        const first=draw();
        expect(first.raycasts).toBeGreaterThan(0);expect(first.report.evaluations).toBeGreaterThan(0);
        // An unchanged frame keeps the table: no raycasts, no integration, no upload.
        const again=draw();
        expect(again).toMatchObject({texture:first.texture,raycasts:0,report:{evaluations:0,uploadedBytes:0}});
        // The kept table is the table a new build gives for the same state.
        expect(fresh.draw().data).toEqual(first.data);
        // Any change that can move a ray's first hit builds it again.
        for (const change of [()=>{occluder.position.x+=5;},()=>{occluder.geometry.attributes.position.needsUpdate=true;},
            ()=>{occluder.layers.enable(3);},()=>{occluder.geometry.setDrawRange(0,6);},()=>{camera.position.y+=.01;camera.updateMatrixWorld();}]) {
            change();
            const changed=draw();
            expect(changed.raycasts).toBeGreaterThan(0);expect(changed.report.uploadedBytes).toBeGreaterThan(0);
            expect(draw().raycasts).toBe(0);
        }
    } finally {dispose();fresh.dispose();}
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
    // 250 km away and 5 degrees outside a 1 degree field: outside the image, so it cannot stop the frame.
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

test("surface clipping with reused vertex lists gives the bounds of a per-vertex clip, bit for bit",()=>{
    // Reference: a new vector for every projected vertex and every clipped polygon vertex.
    const reference=(geometry,camera,width,height)=>{
        const position=geometry.attributes.position,points=[];
        for(let i=0;i<position.count;i++) points.push(new Vector4(position.getX(i),position.getY(i),position.getZ(i),1).applyMatrix4(camera.projectionMatrix));
        const distance=(v,side)=>side===0?v.w*(1+2/width)+v.x:side===1?v.w*(1+2/width)-v.x:side===2?v.w*(1+2/height)+v.y:v.w*(1+2/height)-v.y;
        let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
        for(let i=0;i+2<geometry.index.count;i+=3) {
            let polygon=[0,1,2].map(j=>points[geometry.index.getX(i+j)]);
            for(let side=0;side<4&&polygon.length;side++) {
                const clipped=[];
                polygon.forEach((a,j)=>{const b=polygon[(j+1)%polygon.length],da=distance(a,side),db=distance(b,side);
                    if(da>=0)clipped.push(a);if((da>=0)!==(db>=0))clipped.push(a.clone().lerp(b,da/(da-db)));});
                polygon=clipped;
            }
            for(const v of polygon) {const x=(v.x/v.w+1)*width/2,y=(v.y/v.w+1)*height/2;
                left=Math.min(left,x);bottom=Math.min(bottom,y);right=Math.max(right,x);top=Math.max(top,y);}
        }
        return left===Infinity?[]:[left-1,bottom-1,right+1,top+1];
    };
    const camera=new PerspectiveCamera(10,1.25,1,10000);
    // A seeded sheet of triangles around and partly behind the camera, as a terrain tile near the camera is.
    let seed=7;const random=()=>(seed=(seed*16807)%2147483647)/2147483647;
    for(let trial=0;trial<20;trial++) {
        const geometry=new BufferGeometry(),vertices=[];
        for(let i=0;i<60;i++) vertices.push((random()-.5)*400,(random()-.5)*300,-random()*800+50);
        geometry.setAttribute("position",new Float32BufferAttribute(vertices,3));
        geometry.setIndex(Array.from({length:90},()=>Math.floor(random()*60)));
        expect(projectedSurfaceBounds(geometry,new Matrix4(),camera,null,640,512)).toEqual(reference(geometry,camera,640,512));
        geometry.dispose();
    }
});

test("a sky or sea-depth table of the same size replaces the texture's data in place and keeps the earlier table intact",()=>{
    const {pipeline}=fixture();
    try {
        const first=new Float32Array(16).fill(1),second=new Float32Array(16).fill(2);
        const texture=pipeline._tableTexture(null,first,4);
        const version=texture.version;
        expect(pipeline._tableTexture(texture,second,4)).toBe(texture);
        expect(texture.image.data).toBe(second);expect(texture.version).toBeGreaterThan(version);
        expect(first.every(value=>value===1)).toBe(true);
        const dispose=jest.spyOn(texture,"dispose"),wider=pipeline._tableTexture(texture,new Float32Array(32),8);
        expect(wider).not.toBe(texture);expect(dispose).toHaveBeenCalledTimes(1);
        expect(pipeline.resources.textures.has(texture)).toBe(false);expect(pipeline.resources.textures.has(wider)).toBe(true);
    } finally {pipeline.dispose();}
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

test("GPU timer discards disjoint samples and converts valid ns to ms", () => {
    const gl = fakeGl(), extension = {TIME_ELAPSED_EXT: 100, GPU_DISJOINT_EXT: 101};
    Object.assign(gl, {getExtension: () => extension, getQuery: () => null, createQuery: () => ({}),
        beginQuery: jest.fn(), endQuery: jest.fn(), deleteQuery: jest.fn(),
        getQueryParameter: (query, key) => key === gl.QUERY_RESULT_AVAILABLE ? true : 2500000});
    const timer = new ThermalGpuTimer(gl);
    timer.begin(1, "optics"); timer.end(); timer.poll();
    expect(timer.samples).toEqual([{frame: 1, stage: "optics", ms: 2.5}]);
    timer.begin(2, "optics"); timer.end(); gl.getParameter.mockReturnValue(true); timer.poll();
    expect(timer.samples).toHaveLength(1); expect(timer.disjointSamples).toBe(1); timer.dispose();
});
