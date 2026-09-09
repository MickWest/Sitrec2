import {migrateViewColorSettings, splitViewEffects, viewColorPolicy} from '../src/rendering/ViewColorPipeline';
const view=(extra={})=>({id:'lookView',isIR:false,isXRPresenting:()=>false,toneMappingEnabled:true,viewExposure:.7,opticsBeforeSensor:true,...extra});
test('exposure and highlight rolloff do not depend on haze or target format',()=>{
    for(const atmosphereEnabled of [false,true])for(const useLookViewHDR of [false,true]){
        const p=viewColorPolicy(view({atmosphereEnabled,useLookViewHDR}),1.2,.5);
        expect(p.toneMapping).toBe(true);expect(p.exposure).toBeCloseTo(.84);
    }
    expect(viewColorPolicy(view({toneMappingEnabled:false}),1.2).exposure).toBeCloseTo(.84);
});
test.each([{id:'mainView'},{isIR:true},{isXRPresenting:()=>true}])('visible exposure does not alter diagnostic modes %j',extra=>{
    expect(viewColorPolicy(view(extra),2)).toEqual({active:false,toneMapping:false,exposure:1,opticsBeforeSensor:false});
});
test('saved appearance migrates output choice and keeps archived effect order',()=>{
    expect(migrateViewColorSettings({atmosphereHDR:true,atmosphereExposure:.8},true,.5)).toEqual({toneMappingEnabled:true,viewExposure:.8,opticsBeforeSensor:false,legacySkyExposure:true});
    const migrated=migrateViewColorSettings({atmosphereHDR:true},false,.25);
    expect(viewColorPolicy(view({...migrated,atmosphereEnabled:true}),.25).toneMapping).toBe(false);
    expect(viewColorPolicy(view(migrated),.25).exposure).toBe(1);
    expect(migrateViewColorSettings({atmosphereHDR:true},true,.25,false).toneMappingEnabled).toBe(false);
});
test('optics receive HDR before levels without reordering sensor effects',()=>{
    const names=['hBlur','StaticNoise','Levels','DiffractionGlare','Invert'];
    const effects=Object.fromEntries(names.map(effectName=>[effectName,{effectName,enabled:true}]));
    effects.disabled={effectName:'vBlur',enabled:false};
    const grouped=splitViewEffects(effects,true);
    expect(grouped.optical.map(e=>e.effectName)).toEqual(['hBlur','DiffractionGlare']);
    expect(grouped.sensor.map(e=>e.effectName)).toEqual(['StaticNoise','Levels','Invert']);
    expect(splitViewEffects(effects,false).optical.map(e=>e.effectName)).toEqual(names);
});
