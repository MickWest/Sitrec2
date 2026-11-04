jest.mock("../src/Globals",()=>({NodeMan:{get:jest.fn()},setRenderOne:jest.fn()}));
jest.mock("../src/LocalFrame",()=>({GlobalScene:new (require("three").Group)()}));
jest.mock("../src/CoordinateInput",()=>({moveTerrainTo:jest.fn()}));
jest.mock("../src/LLA-ECEF-ENU",()=>({LLAToECEF:(lat,lon,alt)=>new (require("three").Vector3)(...require("../src/doppler/DopplerModel").toECEF(lat,lon,alt))}));
jest.mock("../src/MatLines",()=>({makeMatLine:jest.fn(()=>new (require("three").LineBasicMaterial)()),disposeMatLine:jest.fn()}));
jest.mock("three/addons/lines/Line2.js",()=>({Line2:class extends require("three").Object3D {constructor(geometry,material){super();this.geometry=geometry;this.material=material;}}}));
jest.mock("three/addons/lines/LineSegmentsGeometry.js",()=>({LineSegmentsGeometry:class extends require("three").BufferGeometry {setPositions(values){this.setAttribute("position",new (require("three").Float32BufferAttribute)(values,3));}}}));

import {Group, PerspectiveCamera} from "three";
import {DopplerScene} from "../src/doppler/DopplerScene";
import {GlobalScene} from "../src/LocalFrame";
import {NodeMan} from "../src/Globals";
import {moveTerrainTo} from "../src/CoordinateInput";
import {disposeMatLine} from "../src/MatLines";

const track={id:"source",callsign:"Test",points:[950,960,1000,1010,1100,1110,1200,1210].map((time,i)=>({time,lat:0,lon:i*.001,altitudeM:1000}))};
const candidate={lat:0,lon:0,altitudeM:0,recordingStart:1000,events:[{flight:"source",frequency:100,rmsHz:1}]};
const input={candidate,rank:2,events:[{name:"Measured",start:0,end:120}],tracks:[track],soundSpeed:343,maxGap:30};
beforeEach(()=>{GlobalScene.clear();jest.clearAllMocks();});

test("event-limited original segments preserve gaps, with relative ECEF buffers and camera focus",()=>{
    const camera=new PerspectiveCamera();camera.position.set(10,20,30);const initial=camera.position.clone();
    const goToPoint=jest.fn(()=>camera.position.set(50,60,70));NodeMan.get.mockReturnValue({goToPoint,camera});
    const before=JSON.stringify(input),scene=new DopplerScene(),legend=scene.show(input);
    expect(legend.events[0].sourceIntervals).toEqual([[1000,1010],[1100,1110]]);
    expect(legend.events[0].segmentCount).toBe(2);
    const line=scene.group.children.find(child=>child.name==="Measured");
    expect(line.geometry.getAttribute("position").count).toBe(4);
    expect(scene.group.position.x).toBe(6378137);
    expect(Math.max(...line.geometry.getAttribute("position").array.map(Math.abs))).toBeLessThan(10000);
    expect(moveTerrainTo).toHaveBeenCalledWith(0,0);expect(goToPoint).toHaveBeenCalledTimes(1);
    expect(NodeMan.get.mock.calls.every(([name])=>["mainCamera","terrainUI"].includes(name))).toBe(true);
    expect(JSON.stringify(input)).toBe(before);scene.dispose();expect(camera.position.equals(initial)).toBe(true);
});

test("clearing and replacement release only owned overlays; invalid source stays explicit",()=>{
    NodeMan.get.mockReturnValue(null);const userTrack=new Group();GlobalScene.add(userTrack);
    const scene=new DopplerScene();scene.show(input);const old=scene.group;
    const dispose=jest.spyOn(old.children[0].geometry,"dispose");scene.show({...input,tracks:[]});
    expect(scene.legend.events[0].status).toBe("missing_track");expect(dispose).toHaveBeenCalledTimes(1);
    expect(GlobalScene.children).toContain(userTrack);expect(GlobalScene.children).not.toContain(old);expect(disposeMatLine).toHaveBeenCalledTimes(1);
    scene.clear();scene.clear();expect(GlobalScene.children).toEqual([userTrack]);scene.dispose();
    expect(()=>scene.show(input)).toThrow(/disposed/);
});
