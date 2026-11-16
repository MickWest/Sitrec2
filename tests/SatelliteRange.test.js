/** @jest-environment jsdom */
import {Vector3} from 'three';
import {json2satrec, propagate} from 'satellite.js';
import {CSatellite} from '../src/nodes/CSatellite';
import {satelliteECEF} from '../src/SatelliteBrightness';
import {Globals, setSit} from '../src/Globals';

const date = new Date('2024-09-19T20:50:26.970Z');
const a = 6378137, b = 6356752.314245;
function record(number, motion, eccentricity=0.001, anomaly=0) {
    return json2satrec({OBJECT_NAME:'TEST '+number,NORAD_CAT_ID:number,
        EPOCH:date.toISOString().replace('Z',''),MEAN_MOTION:motion,ECCENTRICITY:eccentricity,
        INCLINATION:30,RA_OF_ASC_NODE:0,ARG_OF_PERICENTER:0,MEAN_ANOMALY:anomaly,
        BSTAR:0,MEAN_MOTION_DOT:0,MEAN_MOTION_DDOT:0});
}
function setup() {
    setSit({refractionEnabled:false});
    Globals.equatorRadius=a; Globals.polarRadius=b;
    const sats=new CSatellite();
    sats._getCameraSatelliteState=()=>null;
    sats.removeSatSunArrows=jest.fn(); sats.removeSatelliteArrows=jest.fn();
    sats.lightCloud={setBrightness:jest.fn(),setPosition:jest.fn(),
        markPositionsNeedUpdate:jest.fn(),markBrightnessNeedUpdate:jest.fn()};
    const satData=[record(1,15),record(2,1.0027),record(3,2,0.72,180),record(4,0.25,0.4,180)]
        .map(satrec=>({name:'TEST '+satrec.satnum,number:Number(satrec.satnum),
            visible:true,satrecs:[satrec],ecef:new Vector3()}));
    sats.TLEData={satData};
    return {sats,satData};
}

test('all selected orbit classes count, including slow eccentric and high orbits',()=>{
    const {sats,satData}=setup();
    const eccentric=propagate(satData[2].satrecs[0],date);
    expect(Math.hypot(...Object.values(eccentric.velocity))*1000).toBeLessThan(2500);
    const high=satelliteECEF(satData[3].satrecs[0],date,a,b);
    expect(high.length()-a).toBeGreaterThan(40000000);
    expect(sats.updateAllSatellites(date)).toEqual({validCount:4,visibleCount:4});
    expect(satData.every(s=>!s.invalidPosition)).toBe(true);
});

test('category/search selection changes the denominator without counting hidden bad data',()=>{
    const {sats,satData}=setup();
    satData[1].satrecs[0].no=NaN;
    expect(sats.updateAllSatellites(date)).toEqual({validCount:3,visibleCount:4});
    satData[1].visible=false;
    expect(sats.updateAllSatellites(date)).toEqual({validCount:3,visibleCount:3});
    satData.forEach(s=>s.visible=false); satData[2].visible=true;
    expect(sats.updateAllSatellites(date)).toEqual({validCount:1,visibleCount:1});
    satData[2].visible=false;
    expect(sats.updateAllSatellites(date)).toEqual({validCount:0,visibleCount:0});
});

test('time-dependent TLE filters exclude hidden objects, even when their propagation fails',()=>{
    const {sats,satData}=setup();
    satData[1].satrecs[0].no=NaN;
    sats.tleFilterFrameData={sampleTimesMS:[+date,+date+1000],perSat:['on','off',[false,true],'off']};
    expect(sats.updateAllSatellites(date)).toEqual({validCount:1,visibleCount:1});
    expect(sats.updateAllSatellites(new Date(+date+1000))).toEqual({validCount:2,visibleCount:2});
    expect(satData[1].tleFrameHidden).toBe(true);
});

test('stale and not-yet-launched selected objects stay out of range',()=>{
    const {sats,satData}=setup();
    satData[2].launchDate=+date+86400000;
    expect(sats.updateAllSatellites(date)).toEqual({validCount:3,visibleCount:4});
    expect(sats.updateAllSatellites(new Date(+date+91*86400000))).toEqual({validCount:0,visibleCount:4});
});

test('the shared propagator still rejects failures, nonfinite positions, and atmospheric heights',()=>{
    const bad=record(5,15); bad.no=NaN;
    expect(satelliteECEF(bad,date,a,b)).toBeNull();
    const lowMotion=Math.sqrt(398600.4418/6428**3)*86400/(2*Math.PI);
    expect(satelliteECEF(record(6,lowMotion,0),date,a,b)).toBeNull();
    const decayedMotion=Math.sqrt(398600.4418/6000**3)*86400/(2*Math.PI);
    expect(satelliteECEF(record(7,decayedMotion,0),date,a,b)).toBeNull();
});
