const fs = require('fs');
const vm = require('vm');
const babel = require('@babel/core');
import {TimelineMarkers} from "../src/TimelineMarkers";
import {t} from "../src/i18n";
import {findHorizonCrossings} from "../src/HorizonCrossings";
import {migrateChapterEventsToMarkers} from "../src/SitchMigrations";

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
    const editTimelineMarkers = jest.fn((description, change) => change());
    const UndoManager = {clear:jest.fn()};
    const context = {structuredClone, Globals, par, Sit, NodeMan, ViewMan, console, TimelineMarkers, editTimelineMarkers, UndoManager, t, setRenderOne(){}, UIChangedFrame(){}, markSitchDirty(){Globals.sitchDirty=true;}, showError:jest.fn(), showPrompt:(...args)=>prompt(...args), showConfirm:(...args)=>confirm(...args), textSitchToObject:JSON.parse, setNewSitchObject:data => {Globals.newSitchObject=data;}};
    const source = fs.readFileSync(require.resolve('../src/CustomManagerSubSitch.js'),'utf8');
    const code = babel.transformSync(source, {configFile:false, plugins:[() => ({visitor:{ImportDeclaration(path){path.remove();}, ExportNamedDeclaration(path){path.replaceWith(path.node.declaration);}}})]}).code;
    vm.createContext(context); vm.runInContext(code+';globalThis.methods=subSitchMethods;', context);
    const manager = {...context.methods,subIncludes:{cameras:[1,'mainCamera'],markers:[1]},subSaveEnabled:{cameras:true,markers:true},subLoadEnabled:{cameras:true,markers:true},subSitches:[],currentSubIndex:0,chapterBusy:false,rebuildSubSitchMenu:jest.fn()};
    TimelineMarkers.clear();
    manager.initializeFirstSubSitch();
    return {manager,node,Globals,par,context,views,UndoManager,setPrompt:fn=>prompt=fn,setConfirm:fn=>confirm=fn};
}

test('a chapter switch clears undo, so an undo cannot put one chapter\'s markers into another',()=>{
    const {manager:m,UndoManager}=harness();
    TimelineMarkers.add(5,'Chapter 1'); m.updateAndAddSubSitch();
    UndoManager.clear.mockClear();
    m.switchToSubSitch(0);
    expect(UndoManager.clear).toHaveBeenCalledTimes(1);
    m.switchToSubSitch(0);    // already current: nothing is restored, so undo is kept
    expect(UndoManager.clear).toHaveBeenCalledTimes(1);
});

test('switch captures outgoing edits, restores frame and markers, and isolates mutable node values',()=>{
    const {manager:m,node,par}=harness();
    TimelineMarkers.add(5,'Flash'); par.frame=5; node.value.zoom=2;
    m.updateAndAddSubSitch(); node.value.zoom=3; par.frame=8; TimelineMarkers.rename(5,'Edited'); TimelineMarkers.add(9,'Only in chapter 2');
    m.switchToSubSitch(0);
    expect(node.value.zoom).toBe(2); expect(par.frame).toBe(5); expect(TimelineMarkers.list()).toEqual([{frame:5,label:'Flash'}]);
    node.value.zoom=9; expect(m.subSitches[0].state.mods.mainCamera.value.zoom).toBe(2);
    TimelineMarkers.add(1,'Live edit'); expect(m.subSitches[0].state.markers).toEqual([{frame:5,label:'Flash'}]);
    m.switchToSubSitch(1); expect(node.value.zoom).toBe(3);
    expect(TimelineMarkers.list()).toEqual([{frame:5,label:'Edited'},{frame:9,label:'Only in chapter 2'}]);
    m.switchToSubSitch(0); expect(TimelineMarkers.list()).toEqual([{frame:1,label:'Live edit'},{frame:5,label:'Flash'}]);
});
test('markers follow the capture and restore scope',()=>{
    const {manager:m}=harness();
    TimelineMarkers.add(3,'Shared');
    m.subSaveEnabled.markers=false;
    m.updateAndAddSubSitch();
    expect(m.subSitches[0].state.markers).toBeUndefined();
    TimelineMarkers.add(4,'Added later');
    m.switchToSubSitch(0);
    // Chapter 1 captured no markers, so they stay as they are.
    expect(TimelineMarkers.frames()).toEqual([3,4]);
    m.subSaveEnabled.markers=true; m.switchToSubSitch(1); TimelineMarkers.clear(); m.switchToSubSitch(0);
    m.subLoadEnabled.markers=false; m.switchToSubSitch(1);
    expect(TimelineMarkers.frames()).toEqual([3,4]);
});
test('loading a chapter list restores the current chapter; a chapter without markers keeps the current ones',()=>{
    const {manager:m}=harness(); TimelineMarkers.add(2,'old');
    m.deserializeSubSitches({subSitches:[{name:'legacy',state:{mods:{}}}]});
    expect(m.currentSubIndex).toBe(0); expect(TimelineMarkers.list()).toEqual([{frame:2,label:'old'}]);
    m.deserializeSubSitches({subSitches:[{name:'a',state:{mods:{},markers:[]}},{name:'b',state:{mods:{},markers:[{frame:7,label:'b'}]}}],currentSubIndex:1});
    expect(m.currentSubIndex).toBe(1); expect(TimelineMarkers.list()).toEqual([{frame:7,label:'b'}]);
});
test('an old save with chapter events loads with those events as the markers of each chapter',()=>{
    const {manager:m}=harness();
    const saved={name:'custom',timelineMarkers:[{frame:1,label:'Shared'}],subSitchesData:{currentSubIndex:0,subSitches:[
        {name:'Chapter 1',state:{frame:0,mods:{},events:[{name:'Flash begins',frame:12}]}},
        {name:'Chapter 2',state:{frame:0,mods:{},events:[]}}]}};
    migrateChapterEventsToMarkers(saved);
    m.deserializeSubSitches(saved.subSitchesData);
    expect(TimelineMarkers.list()).toEqual([{frame:1,label:'Shared'},{frame:12,label:'Flash begins'}]);
    m.switchToSubSitch(1);
    expect(TimelineMarkers.list()).toEqual([{frame:1,label:'Shared'}]);
});
test('an error while restoring a chapter surfaces, and the current chapter does not change',()=>{
    const {manager:m,node}=harness(); m.updateAndAddSubSitch(); m.switchToSubSitch(0);
    const original=node.modDeserialize; node.modDeserialize=function(data){if(data.value.zoom===1) throw Error('bad state'); original.call(this,data);};
    expect(()=>m.switchToSubSitch(1)).toThrow('bad state'); expect(m.currentSubIndex).toBe(0);
});
test('cancelled and stale rename prompts make no changes; repeated clicks are gated',async()=>{
    const {manager:m,Globals,setPrompt}=harness(); let resolve; setPrompt(()=>new Promise(r=>resolve=r));
    const name=m.subSitches[0].name;
    const pending=m.renameCurrentSubSitch(); await m.renameCurrentSubSitch(); expect(m.chapterBusy).toBe(true);
    resolve(null); await pending; expect(m.subSitches[0].name).toBe(name); expect(m.chapterBusy).toBe(false);
    const stale=m.renameCurrentSubSitch(); Globals.loadGeneration++; resolve('stale'); await stale;
    expect(m.subSitches[0].name).toBe(name); expect(Globals.sitchDirty).toBeUndefined();
    Globals.loadGeneration--; m.chapterBusy=false;
    const renamed=m.renameCurrentSubSitch(); resolve('  Approach  '); await renamed;
    expect(m.subSitches[0].name).toBe('Approach'); expect(Globals.sitchDirty).toBe(true);
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
test('an error in delete or restore surfaces and leaves the chapter list as it was',async()=>{
    const {manager:m,node,setConfirm}=harness(); m.updateAndAddSubSitch(); node.value.zoom=8; setConfirm(async()=>true);
    const original=node.modDeserialize; node.modDeserialize=function(data){if(data.value?.zoom===1) throw Error('broken'); original.call(this,data);};
    const before=structuredClone(m.subSitches);
    await expect(m.deleteCurrentSubSitch()).rejects.toThrow('broken'); expect(m.subSitches).toEqual(before); expect(m.chapterBusy).toBe(false);
    m.chooseChapterOption=async()=>0;
    await expect(m.restoreChapterFromData({subSitches:[{state:{mods:{mainCamera:{value:{zoom:1}}}}}]},m.subSitches[1],1)).rejects.toThrow('broken');
    expect(m.subSitches).toHaveLength(2);
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
    m.subLoadEnabled.cameras=false;
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
    m.subIncludes.others=[0,'lighting'];m.subSaveEnabled.others=false;m.subLoadEnabled.others=true;
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
    m.subSaveEnabled.cameras=false; m.chooseChapterOption=async()=>0; setConfirm(async()=>true);
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

test('satellite markers go on the frames of the crossings, keep user labels, and are not added twice',()=>{
    const {manager:m,context}=harness();
    const start=Date.parse('2025-01-01T00:00:00Z');
    context.Sit.fps=30;context.Sit.simSpeed=2;
    context.GlobalDateTimeNode={frameToMS:frame=>start+frame*1000*2/30,msToFrame:ms=>(ms-start)*30/(1000*2)};
    const horizonCrossings=jest.fn(()=>[
        {sat:{name:'Test satellite'},timeMS:start+2000,rising:true},
        {sat:{number:44713},timeMS:start+4010,rising:false},
    ]);
    context.NodeMan.get=id=>id==='ephemerisView'?{horizonCrossings}:undefined;
    TimelineMarkers.add(60,'Flash');
    m.addSatelliteMarkers();m.addSatelliteMarkers();
    expect(horizonCrossings).toHaveBeenCalledWith(start,start+99*1000*2/30);
    expect(TimelineMarkers.list()).toEqual([{frame:30,label:'Test satellite rises'},{frame:60,label:'Flash; 44713 sets'}]);
    expect(context.editTimelineMarkers).toHaveBeenCalledWith('Add satellite rise / set markers',expect.any(Function));
});

test('satellite markers report when there is no satellite data or no crossing',()=>{
    const {manager:m,context}=harness();
    context.NodeMan.get=()=>undefined;
    m.addSatelliteMarkers();
    expect(context.showError).toHaveBeenLastCalledWith('Load satellite data first, then try again.');
    context.GlobalDateTimeNode={frameToMS:frame=>frame,msToFrame:ms=>ms};
    context.NodeMan.get=id=>id==='ephemerisView'?{horizonCrossings:()=>[]}:undefined;
    m.addSatelliteMarkers();
    expect(context.showError).toHaveBeenCalledTimes(2);
    expect(TimelineMarkers.count()).toBe(0);
});

function ephemerisHarness() {
    const position={x:1,y:2,z:3};
    const calculate=jest.fn((sat,date)=>({time:date.getTime(),clone(){return {...this};},sub(){return this;},normalize(){return this;}}));
    const base=new Date('2025-01-01T00:00:00Z');
    const context={console,Date,CNodeViewText:class {},bestSat:()=>({}),findHorizonCrossings,
        NodeMan:{get:id=>id==='lookCamera'?{camera:{position}}:undefined},
        getAzElFromPositionAndForward:(pos,forward)=>[0,forward.time<base.getTime()+60000?-1:1]};
    const source=fs.readFileSync(require.resolve('../src/nodes/CNodeViewEphemeris.js'),'utf8');
    const code=babel.transformSync(source,{configFile:false,plugins:[()=>({visitor:{ImportDeclaration(p){p.remove();},ExportNamedDeclaration(p){p.replaceWith(p.node.declaration);}}})]}).code;
    vm.createContext(context);vm.runInContext(code+';globalThis.methods=CNodeViewEphemeris.prototype;globalThis.observerCacheKey=observerCacheKey;',context);
    const view=Object.assign(Object.create(context.methods),{nightSkyNode:{satellites:{calcSatECEF:calculate}}});
    return {view,context,position,calculate,base};
}

test('ephemeris predictions are cached per 1 km of observer movement and 10 s of sitch time',()=>{
    const {view,context,position,calculate,base}=ephemerisHarness();
    const sat={satrecs:[]};const camera={camera:{position}};
    const predict=(date)=>view.predictNextEvent(sat,date,-1,camera,context.observerCacheKey(position));
    expect(predict(base)).toBe('AOS 1m 0s');
    const count=calculate.mock.calls.length;
    predict(new Date(base.getTime()+1000));expect(calculate).toHaveBeenCalledTimes(count);
    // A move of 300 m keeps the cached prediction; a move of 2 km does not.
    position.x+=300;predict(new Date(base.getTime()+1000));expect(calculate).toHaveBeenCalledTimes(count);
    position.x+=2000;predict(new Date(base.getTime()+1000));expect(calculate.mock.calls.length).toBeGreaterThan(count);
    const afterMove=calculate.mock.calls.length;
    predict(new Date(base.getTime()+30000));expect(calculate.mock.calls.length).toBeGreaterThan(afterMove);
});

test('horizon crossings cover the given range for each satellite shown in the sky',()=>{
    const {view,base}=ephemerisHarness();
    const shown={name:'shown',visible:true,satrecs:[]},hidden={name:'hidden',visible:false,satrecs:[]};
    view.nightSkyNode.satellites.TLEData={satData:[shown,hidden]};
    const start=base.getTime()-120000;
    // The elevation steps from -1 to +1 at base + 60 s; the samples at 30 s and 60 s put the crossing midway.
    expect(view.horizonCrossings(start,start+600000)).toEqual([{sat:shown,timeMS:base.getTime()+45000,rising:true}]);
    expect(view.horizonCrossings(start,start+100000)).toEqual([]);
});
