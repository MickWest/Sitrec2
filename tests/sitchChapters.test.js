const fs = require('fs');
const vm = require('vm');
const babel = require('@babel/core');

// Exercise the actual mixin with a small scene graph, independent of WebGL and the app singleton.
function harness() {
    const Globals = {loadGeneration:1, dontRecalculate:false};
    const par = {frame:0};
    const Sit = {frames:100, fps:30};
    const node = {value:{zoom:1}, modSerialize(){return {value:this.value};}, modDeserialize(data){this.value=data.value;}, recalculateCascade(){}};
    const NodeMan = {iterate:fn => fn('mainCamera',node), get:() => node, exists:() => true};
    let prompt = async () => null, confirm = async () => false;
    const views = {};
    const ViewMan = {fullscreenView:null, exists:id=>!!views[id], setFullscreenView(view){this.fullscreenView=view;}, restoreFullscreenFromMods(){this.fullscreenView=Object.values(views).find(v=>v.doubled)||null;}};
    const context = {structuredClone, Globals, par, Sit, NodeMan, ViewMan, console, setRenderOne(){}, UIChangedFrame(){}, markSitchDirty(){Globals.sitchDirty=true;}, showError:jest.fn(), showPrompt:(...args)=>prompt(...args), showConfirm:(...args)=>confirm(...args), textSitchToObject:JSON.parse, setNewSitchObject:data => {Globals.newSitchObject=data;}};
    const source = fs.readFileSync(require.resolve('../src/CustomManagerSubSitch.js'),'utf8');
    const code = babel.transformSync(source, {configFile:false, plugins:[() => ({visitor:{ImportDeclaration(path){path.remove();}, ExportNamedDeclaration(path){path.replaceWith(path.node.declaration);}}})]}).code;
    vm.createContext(context); vm.runInContext(code+';globalThis.methods=subSitchMethods;', context);
    const manager = {...context.methods,subIncludes:{Cameras:[1,'mainCamera']},subSaveEnabled:{Cameras:true},subLoadEnabled:{Cameras:true},subSitches:[],currentSubIndex:0,subSitchControllers:[],chapterBusy:false,rebuildSubSitchMenu:jest.fn(),rebuildTimelineEvents:jest.fn()};
    manager.initializeFirstSubSitch();
    return {manager,node,Globals,par,context,views,setPrompt:fn=>prompt=fn,setConfirm:fn=>confirm=fn};
}

test('switch captures outgoing edits, restores frame/events, and isolates mutable node values',()=>{
    const {manager:m,node,par}=harness();
    m.timelineEvents=[{name:'Flash',frame:5}]; par.frame=5; node.value.zoom=2;
    m.updateAndAddSubSitch(); node.value.zoom=3; par.frame=8; m.timelineEvents[0].name='Edited';
    m.switchToSubSitch(0);
    expect(node.value.zoom).toBe(2); expect(par.frame).toBe(5); expect(m.timelineEvents[0].name).toBe('Flash');
    node.value.zoom=9; expect(m.subSitches[0].state.mods.mainCamera.value.zoom).toBe(2);
    m.switchToSubSitch(1); expect(node.value.zoom).toBe(3); expect(m.timelineEvents[0].name).toBe('Edited');
});
test('legacy loading clamps invalid index and clears absent events',()=>{
    const {manager:m}=harness(); m.timelineEvents=[{name:'old',frame:2}];
    m.deserializeSubSitches({subSitches:[{name:'legacy',state:{mods:{}}}],currentSubIndex:999});
    expect(m.currentSubIndex).toBe(0); expect(m.timelineEvents).toEqual([]);
});
test('failed switch rolls scene back and preserves outgoing snapshot',()=>{
    const {manager:m,node,context}=harness(); m.updateAndAddSubSitch(); m.switchToSubSitch(0); node.value.zoom=7;
    const original=node.modDeserialize; node.modDeserialize=function(data){if(data.value.zoom===1) throw Error('bad state'); original.call(this,data);};
    m.switchToSubSitch(1); expect(m.currentSubIndex).toBe(0); expect(node.value.zoom).toBe(7); expect(context.showError).toHaveBeenCalled();
});
test('cancelled and stale event prompts make no changes; repeated clicks are gated',async()=>{
    const {manager:m,Globals,setPrompt}=harness(); let resolve; setPrompt(()=>new Promise(r=>resolve=r));
    const pending=m.addTimelineEvent(); await m.addTimelineEvent(); expect(m.chapterBusy).toBe(true);
    resolve(null); await pending; expect(m.timelineEvents).toBeUndefined(); expect(m.chapterBusy).toBe(false);
    const stale=m.addTimelineEvent(); Globals.loadGeneration++; m.timelineEvents=[]; resolve('stale'); await stale;
    expect(m.timelineEvents).toEqual([]); expect(Globals.sitchDirty).toBeUndefined();
});
test('revert cancellation preserves edits and confirmed revert uses full baseline',async()=>{
    const {manager:m,Globals,setConfirm}=harness(); m.markChapterBaseline('{"sitch":"saved"}');
    await m.revertSitchChapters(); expect(Globals.newSitchObject).toBeUndefined(); expect(m.chapterBusy).toBe(false);
    setConfirm(async()=>true); await m.revertSitchChapters(); expect(Globals.newSitchObject).toEqual({sitch:'saved'}); expect(m.chapterBusy).toBe(true);
});
test('restoring one version retains other chapters and a recovery copy',async()=>{
    const {manager:m,node,Globals,setConfirm}=harness(); m.updateAndAddSubSitch(); node.value.zoom=8;
    const other=structuredClone(m.subSitches[0]); m.chooseChapterOption=async()=>0; setConfirm(async()=>true);
    await m.restoreChapterFromData({subSitches:[{name:'historic',state:{mods:{mainCamera:{value:{zoom:3}}},events:[],frame:4}}]},m.subSitches[1],1);
    expect(m.subSitches[0]).toEqual(other); expect(node.value.zoom).toBe(3); expect(m.subSitches[2].state.mods.mainCamera.value.zoom).toBe(8); expect(Globals.sitchDirty).toBe(true);
});
test('cancelled version confirmation and stale delete preserve sitch',async()=>{
    const {manager:m,Globals,setConfirm}=harness(); m.updateAndAddSubSitch(); m.chooseChapterOption=async()=>0;
    const before=structuredClone(m.subSitches);
    await m.restoreChapterFromData({subSitches:[{name:'v',state:{mods:{}}}]},m.subSitches[1],1); expect(m.subSitches).toEqual(before);
    let resolve; setConfirm(()=>new Promise(r=>resolve=r)); const pending=m.deleteCurrentSubSitch(); Globals.loadGeneration++; resolve(true); await pending; expect(m.subSitches).toEqual(before);
});
test('failed delete and restore keep the chapter list and roll back scene',async()=>{
    const {manager:m,node,setConfirm}=harness(); m.updateAndAddSubSitch(); node.value.zoom=8; setConfirm(async()=>true);
    const original=node.modDeserialize; node.modDeserialize=function(data){if(data.value?.zoom===1) throw Error('broken'); original.call(this,data);};
    const before=structuredClone(m.subSitches); await m.deleteCurrentSubSitch(); expect(m.subSitches).toEqual(before); expect(node.value.zoom).toBe(8);
    m.chooseChapterOption=async()=>0;
    await expect(m.restoreChapterFromData({subSitches:[{state:{mods:{mainCamera:{value:{zoom:1}}}}}]},m.subSitches[1],1)).rejects.toThrow();
    expect(m.subSitches).toHaveLength(2); expect(node.value.zoom).toBe(8);
});
function serializeHarness() {
    const Globals={loadGeneration:1}; const Sit={isCustom:true}; let resolveSave;
    const saved=new Promise(r=>resolveSave=r);
    const context={Globals,Sit,console,Blob,assert(){},saveFileToHandle:()=>saved,FileManager:{rehostDynamicLinksLocal:async()=>{}},module:{exports:{}}};
    const source=fs.readFileSync(require.resolve('../src/CustomManagerSerialize.js'),'utf8');
    const code=babel.transformSync(source,{configFile:false,plugins:[()=>({visitor:{ImportDeclaration(p){p.remove();},ExportNamedDeclaration(p){p.replaceWith(p.node.declaration);}}})]}).code;
    vm.createContext(context);vm.runInContext(code+';globalThis.methods=serializeMethods;',context);
    const manager={...context.methods,getCustomSitchString:jest.fn(()=>'{"saved":true}'),markChapterBaseline:jest.fn()};
    return {manager,Globals,Sit,context,resolveSave};
}
test('baseline advances only after successful save using the submitted snapshot',async()=>{
    const {manager:m,resolveSave}=serializeHarness(); const pending=m.serialize('sitch','v',true,null,{name:'sitch.json'});
    expect(m.markChapterBaseline).not.toHaveBeenCalled(); resolveSave(); await pending;
    expect(m.markChapterBaseline).toHaveBeenCalledWith('{"saved":true}');
});
test('failed save preserves baseline and stale completion cannot rename new sitch',async()=>{
    const {manager:m,context}=serializeHarness(); context.saveFileToHandle=async()=>{throw Error('cancel');};
    await expect(m.serialize('sitch','v',true,null,{name:'sitch.json'})).rejects.toThrow('cancel'); expect(m.markChapterBaseline).not.toHaveBeenCalled();
    const h=serializeHarness();const pending=h.manager.serialize('A','v',true,null,{name:'A.json'});h.Globals.loadGeneration++;h.Sit.sitchName='B';h.resolveSave();await pending;
    expect(h.Sit.sitchName).toBe('B');expect(h.manager.markChapterBaseline).not.toHaveBeenCalled();
});
test('sitch change during asset hosting aborts before serialization',async()=>{
    const {manager:m,Globals,context}=serializeHarness();let finish;context.FileManager.rehostDynamicLinksLocal=()=>new Promise(r=>finish=r);
    const pending=m.serialize('A','v',true,{});Globals.loadGeneration++;finish();
    await expect(pending).rejects.toThrow('Sitch changed');expect(m.getCustomSitchString).not.toHaveBeenCalled();
});

test('chapter switching reconciles fullscreen ownership and preserves view restore scope',()=>{
    const {manager:m,node,context,views}=harness();
    views.mainCamera=node;
    node.doubled=false;
    node.modSerialize=function(){return {value:this.value,doubled:this.doubled};};
    node.modDeserialize=function(data){this.value=data.value;this.doubled=data.doubled;};
    m.saveCurrentSubSitch();
    m.updateAndAddSubSitch();
    node.doubled=true; context.ViewMan.setFullscreenView(node);
    m.switchToSubSitch(0);
    expect(node.doubled).toBe(false); expect(context.ViewMan.fullscreenView).toBeNull();
    m.switchToSubSitch(1);
    expect(node.doubled).toBe(true); expect(context.ViewMan.fullscreenView).toBe(node);
    m.subLoadEnabled.Cameras=false;
    m.switchToSubSitch(0);
    expect(node.doubled).toBe(true); expect(context.ViewMan.fullscreenView).toBe(node);
});

test('default camera capture includes FOV input and source switches that drive the restored camera',()=>{
    const {manager:m,node,context}=harness();
    const controller={listen(){return this;},name(){return this;},tooltip(){return this;}};
    m.subSitchFolder={addFolder:()=>({close(){return this;},tooltip(){return this;},add:()=>controller})};
    m.setupSubSitchDetails();
    const fov={value:31,modSerialize(){return {value:this.value};},modDeserialize(data){this.value=data.value;},recalculateCascade(){}};
    context.NodeMan.iterate=fn=>{fn('mainCamera',node);fn('fovUI',fov);};
    context.NodeMan.get=id=>id==='fovUI'?fov:node;
    m.saveCurrentSubSitch();m.updateAndAddSubSitch();fov.value=48;
    m.switchToSubSitch(0);expect(fov.value).toBe(31);
    m.switchToSubSitch(1);expect(fov.value).toBe(48);
    expect(m.shouldIncludeNodeForSave('fovSwitch')).toBe(true);
    expect(m.shouldIncludeNodeForSave('anglesSwitch')).toBe(true);
    const legacy={mods:{lookCamera:{fov:22}}};
    context.NodeMan.get=id=>id==='fovUI'?fov:{modDeserialize(){},recalculateCascade(){}};
    m.restoreSubSitchState(legacy);
    expect(fov.value).toBe(22);
    expect(legacy.mods.fovUI).toBeUndefined();
});

test('recovery retains values overwritten by restore even when excluded from capture scope',async()=>{
    const {manager:m,node,context,setConfirm}=harness();
    const lighting={value:8,modSerialize(){return {value:this.value};},modDeserialize(data){this.value=data.value;},recalculateCascade(){}};
    context.NodeMan.iterate=fn=>{fn('mainCamera',node);fn('lighting',lighting);};
    context.NodeMan.get=id=>id==='lighting'?lighting:node;
    m.subIncludes.Others=[0,'lighting'];m.subSaveEnabled.Others=false;m.subLoadEnabled.Others=true;
    m.chooseChapterOption=async()=>0;setConfirm(async()=>true);
    await m.restoreChapterFromData({subSitches:[{name:'historic',state:{mods:{lighting:{value:2}}}}]},m.subSitches[0],1);
    expect(lighting.value).toBe(2);
    expect(m.subSitches[1].state.mods.lighting.value).toBe(8);
    m.switchToSubSitch(1);
    expect(lighting.value).toBe(8);
});

function saveWrapperHarness() {
    const Globals={loadGeneration:1,sitchDirty:true};const par={paused:false};const Sit={sitchName:'A'};
    let finish;
    const pending=new Promise(resolve=>finish=resolve);
    const context={Globals,par,Sit,console,process,CustomManager:{serialize:()=>pending},Date:{now:()=>0},setTimeout:fn=>fn(),getDateTimeFilename:()=> 'version',disableAllInput:jest.fn(),enableAllInput:jest.fn(),updateDocumentTitle:jest.fn(),getEnvBool:()=>false,isAbortLikeError:()=>false};
    const source=fs.readFileSync(require.resolve('../src/CFileManagerSave.js'),'utf8');
    const code=babel.transformSync(source,{configFile:false,plugins:[()=>({visitor:{ImportDeclaration(p){p.remove();},ExportNamedDeclaration(p){p.replaceWith(p.node.declaration);}}})]}).code;
    vm.createContext(context);vm.runInContext(code+';globalThis.methods=saveMethods;',context);
    const manager={...context.methods,guiFolder:{close:jest.fn()},persistWorkingFolder:jest.fn(async()=>{})};
    return {manager,Globals,par,Sit,context,finish};
}

test('recovery remains complete after visiting, leaving and serializing with filtered capture',async()=>{
    const {manager:m,node,setConfirm}=harness();
    m.updateAndAddSubSitch(); node.value.zoom=9;
    m.subSaveEnabled.Cameras=false; m.chooseChapterOption=async()=>0; setConfirm(async()=>true);
    await m.restoreChapterFromData({subSitches:[{name:'saved',state:{mods:{mainCamera:{value:{zoom:3}}}}}]},m.subSitches[1],1);
    m.switchToSubSitch(2); expect(node.value.zoom).toBe(9);
    m.switchToSubSitch(1);
    expect(m.subSitches[2].state.mods.mainCamera.value.zoom).toBe(9);
    m.switchToSubSitch(2); node.value.zoom=11;
    const saved=m.serializeSubSitches();
    expect(saved.subSitches[2].captureAll).toBe(true);
    expect(saved.subSitches[2].state.mods.mainCamera.value.zoom).toBe(11);
    m.deserializeSubSitches(saved); m.switchToSubSitch(1); m.switchToSubSitch(2);
    expect(node.value.zoom).toBe(11);
});
test('stale save wrapper completion cannot arm old targets, clear dirty state, or restore pause',async()=>{
    const {manager:m,Globals,par,context,finish}=saveWrapperHarness();
    const pending=m.saveSitchNamed('A',true,null,{name:'A.json'});
    Globals.loadGeneration++;par.paused=true;
    m.localSitchEntry={name:'B.json'};m.directoryHandle={name:'B'};m.localSaveTargetArmed=false;
    finish({fileHandle:{name:'A.json'}});await pending;
    expect(m.localSitchEntry.name).toBe('B.json');expect(m.directoryHandle.name).toBe('B');
    expect(m.localSaveTargetArmed).toBe(false);expect(Globals.sitchDirty).toBe(true);
    expect(par.paused).toBe(true);expect(context.enableAllInput).not.toHaveBeenCalled();expect(m.guiFolder.close).not.toHaveBeenCalled();
});

test('sitch switch while refreshing the saved handle discards the delayed result',async()=>{
    const {manager:m,Globals,finish}=saveWrapperHarness();let resolveHandle;
    const directory={getFileHandle:()=>new Promise(resolve=>resolveHandle=resolve)};
    const pending=m.saveSitchNamed('A',true,directory);
    finish({});await Promise.resolve();await Promise.resolve();
    Globals.loadGeneration++;m.localSitchEntry={name:'B.json'};m.directoryHandle={name:'B'};
    resolveHandle({name:'A.json'});await pending;
    expect(m.localSitchEntry.name).toBe('B.json');expect(m.directoryHandle.name).toBe('B');
    expect(Globals.sitchDirty).toBe(true);expect(m.persistWorkingFolder).not.toHaveBeenCalled();
});

test('successful save wrapper still updates targets and releases input',async()=>{
    const {manager:m,Globals,par,context,finish}=saveWrapperHarness();const handle={name:'A.json'};
    const pending=m.saveSitchNamed('A',true,null,handle);finish({fileHandle:handle});await pending;
    expect(m.localSitchEntry).toBe(handle);expect(m.localSaveTargetArmed).toBe(true);expect(Globals.sitchDirty).toBe(false);
    expect(par.paused).toBe(false);expect(context.enableAllInput).toHaveBeenCalled();expect(m.guiFolder.close).toHaveBeenCalled();
});

test('stale overwrite confirmation does not start saving the new sitch',async()=>{
    const {manager:m,Globals,Sit}=saveWrapperHarness();let confirm;
    Sit.sitchName=undefined;m.inputSitchName=async()=>{Sit.sitchName='A';};
    m.confirmOverwriteForNamedSave=()=>new Promise(resolve=>confirm=resolve);
    m.saveSitchNamed=jest.fn();m.refreshVersions=jest.fn();
    const pending=m.saveSitch(true,{name:'A folder'});await Promise.resolve();await Promise.resolve();
    Globals.loadGeneration++;Sit.sitchName='B';confirm(true);await pending;
    expect(Sit.sitchName).toBe('B');expect(m.saveSitchNamed).not.toHaveBeenCalled();
});

test('stale local Save As failure does not rename new sitch or show its save error',async()=>{
    const {manager:m,Globals,Sit}=saveWrapperHarness();let reject;
    m.activateStorageFolder=()=>{};m.isDesktopLocalFsAvailable=()=>false;m.directoryHandle={name:'A folder'};
    m.saveSitch=()=>new Promise((resolve,r)=>reject=r);m.showLocalSaveError=jest.fn();m.updateLocalGUI=jest.fn();
    const pending=m.saveLocalAs();Globals.loadGeneration++;Sit.sitchName='B';reject(Error('Sitch changed'));
    expect(await pending).toBe(false);expect(Sit.sitchName).toBe('B');
    expect(m.showLocalSaveError).not.toHaveBeenCalled();expect(m.updateLocalGUI).not.toHaveBeenCalled();
});

function fileManagerEntryHarness() {
    const h=saveWrapperHarness();
    h.context.CManager=class {};
    h.context.sanitizeSitchName=name=>name.trim();
    const source=fs.readFileSync(require.resolve('../src/CFileManager.js'),'utf8');
    const code=babel.transformSync(source,{configFile:false,plugins:[()=>({visitor:{Program(p){
        const declaration=p.node.body.find(n=>n.type==='ExportNamedDeclaration'&&n.declaration?.id?.name==='CFileManager').declaration;
        declaration.body.body=declaration.body.body.filter(n=>['inputSitchName','saveLocalDesktopToTarget'].includes(n.key?.name));
        p.node.body=[declaration];
    }}})]}).code;
    vm.runInContext(code+';globalThis.entryMethods=CFileManager.prototype;',h.context);
    for (const name of ['inputSitchName','saveLocalDesktopToTarget']) h.manager[name]=h.context.entryMethods[name];
    return h;
}

test('stale name prompt cannot rename a newly loaded sitch',async()=>{
    const {manager:m,Globals,Sit,context}=fileManagerEntryHarness();let finish;
    context.promptForText=()=>new Promise(resolve=>finish=resolve);
    const pending=m.inputSitchName();Globals.loadGeneration++;Sit.sitchName='B';finish('A renamed');
    await expect(pending).rejects.toBe('Save Cancelled');expect(Sit.sitchName).toBe('B');
});

test('stale desktop save failure cannot roll back a newly loaded sitch name',async()=>{
    const {manager:m,Globals,Sit}=fileManagerEntryHarness();let reject;
    m.getLocalSitchNameFromFilename=()=> 'A local';m.saveSitchNamed=()=>new Promise((resolve,r)=>reject=r);
    m.showLocalSaveError=jest.fn();m.updateLocalGUI=jest.fn();
    const pending=m.saveLocalDesktopToTarget({name:'A.json'},null);
    Globals.loadGeneration++;Sit.sitchName='B';reject(Error('Sitch changed'));
    expect(await pending).toBe(false);expect(Sit.sitchName).toBe('B');expect(m.showLocalSaveError).not.toHaveBeenCalled();
});

test('predicted crossings convert simulation time into chapter frames and deduplicate events',()=>{
    const {manager:m,context,par}=harness();
    context.GlobalDateTimeNode={dateNow:new Date('2025-01-01T00:00:00Z')};
    context.Sit.fps=30;context.Sit.simSpeed=2;par.frame=10;
    const sat={name:'Test satellite',cachedEventTime:context.GlobalDateTimeNode.dateNow.getTime()+2000,cachedEventRising:true};
    const update=jest.fn();
    const ephemeris={updateEphemeris:update,nightSkyNode:{satellites:{TLEData:{satData:[sat,{name:'outside',cachedEventTime:sat.cachedEventTime+100000}]}}}};
    context.NodeMan.iterate=fn=>fn('ephemeris',ephemeris);
    m.addPredictedTimelineEvents();m.addPredictedTimelineEvents();
    expect(update).toHaveBeenCalledWith(true);
    expect(m.timelineEvents).toHaveLength(1);expect(m.timelineEvents[0].frame).toBe(40);
    expect(m.timelineEvents[0].name).toContain('rise (estimated, 30 s samples)');
    expect(m.subSitches[0].state.events).toEqual(m.timelineEvents);
});

test('ephemeris prediction records simulation crossing times and invalidates after seeks or observer movement',()=>{
    const base=new Date('2025-01-01T00:00:00Z');
    const position={value:[1,2,3],toArray(){return this.value;}};
    const calculate=jest.fn((sat,date)=>({time:date.getTime(),clone(){return {...this};},sub(){return this;},normalize(){return this;}}));
    const context={console,Date,CNodeViewText:class {},bestSat:()=>({}),getAzElFromPositionAndForward:(pos,forward)=>[0,forward.time<base.getTime()+60000?-1:1]};
    const source=fs.readFileSync(require.resolve('../src/nodes/CNodeViewEphemeris.js'),'utf8');
    const code=babel.transformSync(source,{configFile:false,plugins:[()=>({visitor:{ImportDeclaration(p){p.remove();},ExportNamedDeclaration(p){p.replaceWith(p.node.declaration);}}})]}).code;
    vm.createContext(context);vm.runInContext(code+';globalThis.methods=CNodeViewEphemeris.prototype;',context);
    const manager={nightSkyNode:{satellites:{calcSatECEF:calculate}},...context.methods};
    const sat={satrecs:[]};const camera={camera:{position}};
    const predict=context.methods.predictNextEvent;
    expect(predict.call(manager,sat,base,-1,camera)).toBe('AOS 1m 0s');
    expect(sat.cachedEventTime).toBe(base.getTime()+60000);expect(sat.cachedEventRising).toBe(true);
    const count=calculate.mock.calls.length;
    predict.call(manager,sat,new Date(base.getTime()+1000),-1,camera);expect(calculate).toHaveBeenCalledTimes(count);
    position.value=[4,5,6];predict.call(manager,sat,new Date(base.getTime()+1000),-1,camera);expect(calculate.mock.calls.length).toBeGreaterThan(count);
    const afterMove=calculate.mock.calls.length;
    predict.call(manager,sat,new Date(base.getTime()+30000),-1,camera);expect(calculate.mock.calls.length).toBeGreaterThan(afterMove);
});
