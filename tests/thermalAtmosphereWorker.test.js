import {Vector3} from "three";
import {workerRayGeometry, buildRangeDomain} from "../tools/thermal/atmosphereWorker.js";
import {createAtmosphere, createRangeLUT, RangeTableCache} from "../tools/thermal/atmosphere.js";
import {liftCameraRelative} from "../src/atmosphere/terrestrialRefraction";

test("worker rays retain the host's altitude-dependent terrestrial projection", () => {
    for (const sensorAltitudeM of [21, 1382, 6000]) {
        const spec = {sensorAltitudeM, earthRadiusM:6370059, k:.176, maxBendRad:.02, scaleHeightM:8000, maxLiftM:10000, domainKey:"fixture"};
        const geometry = workerRayGeometry(spec);
        const ctx = {...spec, obsAlt:sensorAltitudeM, R:spec.earthRadiusM, zenith:new Vector3(0,1,0)};
        for (const elevation of [-.01, .04, .15]) for (const range of [1000, 100000, 200000]) {
            const ray = geometry.rangePath(elevation, range), point = new Vector3();
            // rangePath returns the physical chord direction. Reproject it with the host's actual helper.
            point.set(range*Math.cos(ray.elevationRad), range*Math.sin(ray.elevationRad), 0);
            const projected = liftCameraRelative(ctx,point);
            expect(Math.atan2(projected.y,projected.x)).toBeCloseTo(elevation,10);
        }
    }
});

test("worker domain tables meet the existing exact foreground-transfer limits", async () => {
    const options={maxRangeM:20000,size:12,sensorAltitudeM:1382,elevationRad:.04};
    const domain=await buildRangeDomain({options,atmosphere:{options:{surfaceTemperatureK:288.15}},reuse:null});
    const cache=new RangeTableCache(); cache.domain=domain; cache.key=JSON.stringify([options.maxRangeM,options.size,options.band,null,options.segments]);
    const atmosphere=createAtmosphere(); cache.atmosphere=atmosphere;
    const actual=cache.request(options,atmosphere), exact=createRangeLUT({...options,atmosphere});
    expect(actual).not.toBeNull();
    for (let i=0;i<exact.transmission.length;i++) expect(Math.abs(actual.transmission[i]-exact.transmission[i])).toBeLessThan(.0001);
    cache.dispose();
});

test("obsolete worker results cannot replace a new atmospheric profile, and disposal ignores late messages", async () => {
    const worker={postMessage:jest.fn(),terminate:jest.fn()},ready=jest.fn();
    const cache=new RangeTableCache(ready,{createWorker:()=>worker}),atmosphere=createAtmosphere();
    const options={maxRangeM:2000,size:4,sensorAltitudeM:1382,elevationRad:.04,
        initialHalfElevationRad:.0005,initialHalfAltitudeM:32,band:{minUm:3,maxUm:5},workerAtmosphere:{options:{}}};
    cache.request(options,atmosphere);await cache.workerPromise;await Promise.resolve();
    const old=worker.postMessage.mock.calls[0][0];
    cache.request({...options,band:{minUm:3.1,maxUm:4.9}},atmosphere);await Promise.resolve();
    const current=worker.postMessage.mock.calls[1][0];
    worker.onmessage({data:{serial:old.serial,domain:{}}});expect(cache.domain).toBeUndefined();
    const domain=await buildRangeDomain(current);
    worker.onmessage({data:{serial:current.serial,domain}});
    expect(cache.domain).toBe(domain);expect(ready).toHaveBeenCalledTimes(1);expect(cache.pending).toBeNull();
    cache.dispose();worker.onmessage({data:{serial:current.serial,domain}});
    expect(cache.domain).toBeNull();expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test("worker startup failure retains the cooperative exact builder", async () => {
    const cache=new RangeTableCache(()=>{},{createWorker:()=>Promise.reject(Error('unavailable'))});
    const options={maxRangeM:2000,size:4,sensorAltitudeM:1382,elevationRad:.04,workerAtmosphere:{options:{}}};
    cache.request(options,createAtmosphere());
    await cache.workerPromise.catch(()=>{});await Promise.resolve();
    expect(cache.createWorker).toBeNull();expect(cache.pending.steps).toBeDefined();cache.dispose();
});
