import {SeaSkyBackgroundCache, createAtmosphere, skyViewGeometry, sampleSeaSkyTable,packSeaSkyAzimuth} from "../tools/thermal/atmosphere.js";
import {inBandRadiance, apparentTemperature} from "../tools/thermal/radiometry.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";

const geometry = h => ({sensorAltitudeM:h, earthRadiusM:6371000, horizonRad:-.01, domainKey:"test",key:`test:${h}`,
    sea:e=>({kind:"surface",sensorAltitudeM:h,elevationRad:e}),
    ray:e=>({kind:"surface",sensorAltitudeM:h,elevationRad:e}),atAltitude:geometry});
function fixture() {
    const settings=normalizeSettings({sensorAltitudeM:600,pathElevationDeg:-6,verticalFovDeg:.8,focalStep:"free"});
    const view=skyViewGeometry(settings),wind=[1,0,0],atmosphere=createAtmosphere();
    const temperature=({sensorAltitudeM:h,elevationRad:e,azimuthRad:a})=>288+.0004*(h-600)+.3*e+.05*Math.cos(a);
    const sea={quadrature:{errorK:null},evaluate:g=>{
        const photonRadiance=inBandRadiance(temperature(g)).photon;
        return {kind:"sea",photonRadiance,radiance:[photonRadiance]};
    }};
    const options={settings,view,wind,rayGeometry:geometry(600)};
    const cache=new SeaSkyBackgroundCache();cache.start=jest.fn();
    const steps=cache.build(options,atmosphere,sea);let result;
    do{result=steps.next();}while(!result.done);
    cache.domain={...result.value,radius:6371000};
    cache.key=JSON.stringify([settings.bandMinUm,settings.bandMaxUm,"test"]);cache.sea=sea;
    return {cache,settings,view,wind,atmosphere,sea,temperature};
}

test("cubic sea reuse preserves off-grid height, elevation and wind-relative azimuth within the existing brightness budget",()=>{
    const f=fixture(),d=f.cache.domain;
    try {
        for(const y of [-.73,-.11,.39,.83]) {
            const h=d.h+y*d.dh,settings={...f.settings,sensorAltitudeM:h};
            const table=f.cache.table(f.view,f.wind,settings,f.atmosphere,f.sea,geometry(h));
            expect(table.interpolation.status).toBe("validated");
            for(const x of [.13,.47,.88])for(const a of [.19,.61,.91]) {
                const e=d.minRad+x*(d.maxRad-d.minRad),azimuth=d.minAzimuth+a*(d.maxAzimuth-d.minAzimuth);
                const photonRadiance=sampleSeaSkyTable(table,e,azimuth);
                const measured=apparentTemperature(photonRadiance,{quantity:"photon"});
                expect(Math.abs(measured-f.temperature({sensorAltitudeM:h,elevationRad:e,azimuthRad:azimuth}))).toBeLessThan(.005);
            }
        }
    } finally {f.cache.dispose();}
});

test("sea reuse survives camera rotation of local wind but expires when sea properties change",()=>{
    const f=fixture();
    try {
        const wind=[Math.cos(.0001),0,Math.sin(.0001)];
        expect(f.cache.table(f.view,wind,f.settings,f.atmosphere,f.sea,geometry(600)).interpolation.status).toBe("validated");
        const other={...f.sea};f.cache.table(f.view,wind,f.settings,f.atmosphere,other,geometry(600));
        expect(f.cache.domain).toBeNull();expect(f.cache.start).toHaveBeenCalled();
    }finally{f.cache.dispose();}
});

test("sea worker publication ignores an obsolete profile and messages after disposal",async()=>{
    const f=fixture(),worker={postMessage:jest.fn(),terminate:jest.fn()},ready=jest.fn();
    const cache=new SeaSkyBackgroundCache(ready,{createWorker:()=>worker});
    const rayGeometry={...geometry(600),workerSpec:{sensorAltitudeM:600}};
    const options={settings:f.settings,view:f.view,wind:f.wind,rayGeometry,workerAtmosphere:{options:{}}};
    try {
        cache.start(options,f.atmosphere,f.sea);await cache.workerPromise;await Promise.resolve();
        const old=worker.postMessage.mock.calls[0][0];
        cache.pending=null;cache.start(options,f.atmosphere,{...f.sea});await Promise.resolve();
        const current=worker.postMessage.mock.calls[1][0];
        expect(current.kind).toBe("seaSky");
        worker.onmessage({data:{serial:old.serial,domain:f.cache.domain}});expect(cache.domain).toBeUndefined();
        worker.onmessage({data:{serial:current.serial,domain:f.cache.domain}});expect(cache.builds).toBe(1);expect(ready).toHaveBeenCalledTimes(1);
        cache.dispose();worker.onmessage({data:{serial:current.serial,domain:f.cache.domain}});expect(cache.domain).toBeNull();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    }finally{cache.dispose();f.cache.dispose();}
});

test("moving sea views prefetch before a twelve-second build can exhaust height coverage",()=>{
    const f=fixture(),clock=jest.spyOn(performance,"now"),d=f.cache.domain;
    try {
        f.cache.buildWallMs=12000;
        clock.mockReturnValue(0);
        f.cache.table(f.view,f.wind,f.settings,f.atmosphere,f.sea,geometry(600));
        expect(f.cache.start).not.toHaveBeenCalled();
        // At 5 m/s, the old 75%-of-height trigger left less than two seconds.
        clock.mockReturnValue(5000);
        const settings={...f.settings,sensorAltitudeM:625};
        expect(f.cache.table(f.view,f.wind,settings,f.atmosphere,f.sea,geometry(625)).altitudeDomain.status).toBe("validated");
        expect(f.cache.start).toHaveBeenCalledTimes(1);
        const forecast=f.cache.start.mock.calls[0][0];
        expect(forecast.settings.sensorAltitudeM).toBeGreaterThan(625);
        expect(forecast.settings.sensorAltitudeM).toBeLessThanOrEqual(625+.4*d.dh);
        // The current domain must still cover all frames until publication.
        f.cache.pending={};clock.mockReturnValue(17000);
        expect(f.cache.table(f.view,f.wind,{...settings,sensorAltitudeM:685},f.atmosphere,f.sea,geometry(685)).altitudeDomain.status).toBe("validated");
    }finally{clock.mockRestore();f.cache.dispose();}
});

test("a late sea prefetch retains the completed domain serving the current camera",async()=>{
    const f=fixture(),worker={postMessage:jest.fn(),terminate:jest.fn()};
    const cache=new SeaSkyBackgroundCache(()=>{},{createWorker:()=>worker});
    Object.assign(cache,{domain:f.cache.domain,key:f.cache.key,sea:f.sea});
    try {
        cache.table(f.view,f.wind,f.settings,f.atmosphere,f.sea,geometry(600));
        cache.start({settings:f.settings,view:f.view,wind:f.wind,workerAtmosphere:{options:{}}},f.atmosphere,f.sea);
        await cache.workerPromise;await Promise.resolve();
        const message=worker.postMessage.mock.calls[0][0];
        const old=cache.domain;
        worker.onmessage({data:{serial:message.serial,domain:{...old,h:1000}}});
        expect(cache.previousDomain).toBe(old);
        const table=cache.table(f.view,f.wind,f.settings,f.atmosphere,f.sea,geometry(600));
        expect(table.altitudeDomain.status).toBe("validated");
        expect(table.altitudeDomain.minM).toBe(old.h-old.dh);
    }finally{cache.dispose();f.cache.dispose();}
});

test("sea prefetch predicts the angular sweep over the measured build time",()=>{
    const f=fixture(),clock=jest.spyOn(performance,"now");
    try {
        f.cache.buildWallMs=12000;clock.mockReturnValue(0);
        f.cache.table(f.view,f.wind,f.settings,f.atmosphere,f.sea,geometry(600));
        const settings={...f.settings,pathElevationDeg:-6.1};
        clock.mockReturnValue(1000);
        f.cache.table(skyViewGeometry(settings),[Math.cos(.04),0,Math.sin(.04)],settings,f.atmosphere,f.sea,geometry(600));
        expect(f.cache.start).toHaveBeenCalledTimes(1);
        const next=f.cache.start.mock.calls[0][0],current=f.cache.lastRequest;
        expect(next.elevationRange.centerRad).toBeLessThan(current.e-.02);
        expect(Math.abs(next.axisAzimuth-current.a)).toBeGreaterThan(.2);
        expect(next.elevationRange.maxRad-next.elevationRange.minRad).toBeCloseTo(
            f.cache.domain.maxRad-f.cache.domain.minRad-.08,4);
    }finally{clock.mockRestore();f.cache.dispose();}
});

test("packed cubic sea lookup preserves unequal elevation knots and interval boundaries",()=>{
    const rows=Array.from({length:5},(_,row)=>{
        const elevations=Float64Array.from([-.2,-.18+row*.003,-.1]);
        return {elevations,minRad:-.2,maxRad:-.1,photonRadiances:Float64Array.from(elevations,e=>(2+row*.1+e*e*(row+1))*1e20)};
    });
    const table={rows,minAzimuth:-1,maxAzimuth:1,azimuthOrder:3},packed=packSeaSkyAzimuth(rows);
    expect(packed.textureHeight).toBe(4);
    for(const e of [-.1999,-.17431,-.161,-.1001])for(const azimuth of [-1,-.913,-.5,-.29,.113,.5,.887,1]) {
        const p=(azimuth+1)*2,interval=Math.min(3,Math.floor(p)),first=Math.max(0,Math.min(1,interval-1)),x=p-first;
        const base=interval*packed.width*4,count=packed.data[base+2];
        const at=i=>packed.data[base+8*i];
        let low=0,high=count-1;
        while(high-low>1){const mid=Math.floor((low+high)/2);if(at(mid)<=e)low=mid;else high=mid;}
        const t=(e-at(low))/(at(high)-at(low));
        const values=Array.from({length:4},(_,i)=>packed.data[base+8*low+4+i]*(1-t)+packed.data[base+8*high+4+i]*t);
        const weights=[-(x-1)*(x-2)*(x-3)/6,x*(x-2)*(x-3)/2,-x*(x-1)*(x-3)/2,x*(x-1)*(x-2)/6];
        const actual=weights.reduce((sum,w,i)=>sum+w*values[i],0)*1e20,reference=sampleSeaSkyTable(table,e,azimuth);
        expect(Math.abs(actual-reference)/reference).toBeLessThan(2e-7);
    }
});

test("a wide sea field close to the horizon builds a smaller validated margin instead of permanent fallback",()=>{
    const f=fixture(),settings={...f.settings,verticalFovDeg:4,pathElevationDeg:-4.5},view=skyViewGeometry(settings);
    try {
        f.cache.domain=null;
        f.cache.table(view,f.wind,settings,f.atmosphere,f.sea,geometry(600));
        expect(f.cache.start).toHaveBeenCalledTimes(1);
        const options=f.cache.start.mock.calls[0][0],steps=f.cache.build(options,f.atmosphere,f.sea);
        let result;do{result=steps.next();}while(!result.done);
        const d=result.value;
        expect(d.maxRad).toBeLessThan(geometry(600).horizonRad);
        expect(d.maxRad-options.elevationRange.maxRad).toBeGreaterThan(0);
        expect(d.maxRad-options.elevationRange.maxRad).toBeLessThan(.04);
        expect(d.angularErrorK+d.altitudeErrorK).toBeLessThan(.005);
        f.cache.domain={...d,radius:6371000};
        const table=f.cache.table(view,f.wind,settings,f.atmosphere,f.sea,geometry(600));
        expect(table.altitudeDomain.status).toBe("validated");
        for(const y of [-.73,.21,.87])for(const e of [d.minRad+.003,(d.minRad+d.maxRad)/2,d.maxRad-.003]) {
            const h=d.h+y*d.dh,t=f.cache.table(view,f.wind,{...settings,sensorAltitudeM:h},f.atmosphere,f.sea,geometry(h));
            const azimuth=d.axisAzimuth+.137;
            const temperature=apparentTemperature(sampleSeaSkyTable(t,e,azimuth),{quantity:"photon"});
            expect(Math.abs(temperature-f.temperature({sensorAltitudeM:h,elevationRad:e,azimuthRad:azimuth}))).toBeLessThan(.005);
        }
    }finally{f.cache.dispose();}
});
