import {Box3,Vector3} from "three";
import {PRESETS,normalizeParameters,parameterGroups,parameterFile,readParameterFile,isMultirotor,isBalloon} from "../tools/vehicles/vehicleParameters.js";
import {droneMotorLayout} from "../tools/vehicles/aerialParameters.js";
import {buildVehicle,disposeVehicle} from "../tools/vehicles/vehicle.js";

const aerial=PRESETS.filter(p=>isMultirotor(p.parameters)||isBalloon(p.parameters));
const preset=id=>PRESETS.find(p=>p.id===id).parameters;
describe("Drones and balloons",()=>{
    test("categories include multirotors, existing fixed-wing drones and balloons",()=>{
        expect(aerial.filter(p=>isMultirotor(p.parameters))).toHaveLength(29);
        expect(aerial.filter(p=>isBalloon(p.parameters))).toHaveLength(22);
        expect(PRESETS.find(p=>p.id==="mil-mq9").vehicleType).toBe("drone");
        expect(preset("mil-mq9").droneStyle).toBe("fixedwing");
        expect(parameterGroups(preset("mil-mq9")).some(g=>g.name==="Wings")).toBe(true);
    });
    test.each(aerial.map(p=>[p.id,p.parameters]))("%s exports finite geometry and round-trips parameters",(_,p)=>{
        const model=buildVehicle(p),file=parameterFile(p,"Aerial example");
        expect(readParameterFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
        expect(model.bounds.isEmpty()).toBe(false);
        expect(model.stats.size.toArray().every(n=>Number.isFinite(n)&&n>0)).toBe(true);
        expect(model.stats.triangles).toBeGreaterThan(500);
        expect(model.stats.triangles).toBeLessThan(100000);
        model.root.traverse(o=>{if(o.isMesh)for(const a of [o.geometry.attributes.position,o.geometry.attributes.normal])expect(Array.from(a.array).every(Number.isFinite)).toBe(true);});
        expect(model.root.userData.units).toBe("metres");
        if(isMultirotor(p))expect(model.propellers).toHaveLength(p.rotorCount*(p.coaxial?2:1));
        else {expect(model.propellers).toHaveLength(0);expect(model.lamps).toHaveLength(p.flame?1:0);}
        disposeVehicle(model.root);
    });
    test.each([4,6,8])("%i-arm frames keep spinning propeller discs and guards clear",count=>{
        const p=normalizeParameters({...preset("drone-mini4"),rotorCount:count,armSpan:.1,armLength:.1,rotorDiameter:.6,rotorGuards:true});
        const motors=droneMotorLayout(p);
        for(let i=0;i<motors.length;i++)for(let j=i+1;j<motors.length;j++)expect(Math.hypot(motors[i][0]-motors[j][0],motors[i][1]-motors[j][1])).toBeGreaterThan(p.rotorDiameter*1.1);
        expect(normalizeParameters(p)).toEqual(p);
    });
    test("camera articulation, paired rotors and downward lights remain attached",()=>{
        const p={...preset("drone-agras-t50"),camera:true,cameraPitch:60,cameraYaw:25,landingLights:true},m=buildVehicle(p);
        expect(m.propellers).toHaveLength(8);
        expect(m.root.getObjectByName("Payload tank")).toBeDefined();
        expect(m.root.getObjectByName("Camera gimbal").rotation.x).toBeCloseTo(Math.PI/3);
        const light=m.root.getObjectByName("Downward auxiliary light");
        expect(new Vector3(0,0,-1).applyQuaternion(light.quaternion).y).toBeCloseTo(-1);
        disposeVehicle(m.root);
    });
    test("lanterns have an open base, warm envelope and exportable light which can be switched off",()=>{
        for(const enabled of [true,false]) {
            const m=buildVehicle({...preset("balloon-lantern-box"),lightsEnabled:enabled});
            expect(m.root.getObjectByName("Open lantern rim")).toBeDefined();
            expect(m.root.getObjectByName("Lantern cross frame")).toBeDefined();
            expect(m.lamps).toHaveLength(enabled?1:0);
            const paper=m.root.getObjectByName("Balloon envelope");
            expect(paper.material[0].emissiveIntensity).toBe(enabled?.65:0);
            expect(paper.geometry.groups).toHaveLength(1);
            const glow=paper.material[0].emissiveMap.image.data;
            expect(glow[16*4]).toBeGreaterThan(glow[120*4]);
            // The first envelope row encloses an opening rather than a bottom cap.
            const pos=paper.geometry.attributes.position;
            for(let i=0;i<96;i++)expect(Math.hypot(pos.getX(i),pos.getZ(i))).toBeGreaterThan(.1);
            disposeVehicle(m.root);
        }
    });
    test("balloon patterns and equipment are selectable, and irrelevant aircraft controls are absent",()=>{
        const p=preset("balloon-hotair"),m=buildVehicle(p);
        expect(m.root.getObjectByName("Balloon envelope").material).toHaveLength(6);
        expect(m.root.getObjectByName("Balloon envelope").geometry.groups).toHaveLength(6);
        expect(m.root.getObjectByName("Basket floor")).toBeDefined();
        expect(parameterGroups(p).flatMap(g=>g.fields).some(f=>f.key==="landingLayout")).toBe(false);
        disposeVehicle(m.root);
    });
    test("box-lantern lettering uses the available surface width and reads correctly on both sides",()=>{
        const p={...preset("balloon-lantern-box"),brandLivery:"sitrec"},m=buildVehicle(p);
        const marks=m.root.getObjectByName("SITREC livery").children;
        for(const [offset,side] of [[0,-1],[17,1]]) {
            const a=new Box3().setFromObject(marks[offset]).getCenter(new Vector3());
            const b=new Box3().setFromObject(marks[offset+10]).getCenter(new Vector3());
            expect((a.z-b.z)*side).toBeGreaterThan(p.length*.28);
        }
        disposeVehicle(m.root);
    });
});
