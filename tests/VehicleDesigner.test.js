import {Box3, Vector3} from "three";
import {PRESETS, normalizeParameters, parameterFile, readParameterFile, isRoad} from "../tools/vehicles/vehicleParameters.js";
import {parameterFile as oldFile} from "../tools/vehicles/parameters.js";
import {buildVehicle, disposeVehicle} from "../tools/vehicles/vehicle.js";
import {animateVehicleLights} from "../tools/vehicles/vehicleLights.js";

describe("Vehicle Designer", () => {
    test("catalog keeps old IDs and adds broad road and civil rotorcraft groups", () => {
        expect(new Set(PRESETS.map(p=>p.id)).size).toBe(PRESETS.length);
        expect(PRESETS.filter(p=>p.vehicleType==="car").length).toBeGreaterThanOrEqual(15);
        expect(PRESETS.filter(p=>p.vehicleType==="truck").length).toBeGreaterThanOrEqual(18);
        expect(PRESETS.filter(p=>p.id.startsWith("heli-")).length).toBe(15);
        expect(PRESETS.some(p=>p.id==="737")).toBe(true);
    });
    test.each(PRESETS.filter(p=>isRoad(p.parameters)||p.id.startsWith("heli-")).map(p=>[p.id,p]))("%s generates finite geometry and lights", (_,preset) => {
        const m=buildVehicle(preset.parameters);
        expect(m.bounds.isEmpty()).toBe(false);expect(m.stats.triangles).toBeGreaterThan(1000);expect(m.stats.triangles).toBeLessThan(120000);
        m.root.traverse(o=>{if(o.isMesh)for(const a of [o.geometry.attributes.position,o.geometry.attributes.normal])expect(Array.from(a.array).every(Number.isFinite)).toBe(true);});
        if(isRoad(preset.parameters))expect(m.bounds.min.y).toBeCloseTo(0,3);
        expect(m.lamps.length).toBeGreaterThan(0);disposeVehicle(m.root);
    });
    test("design files preserve road, aircraft, lighting and branding controls", () => {
        for(const id of ["road-dump","heli-r44","737"]) {
            const p=normalizeParameters({...PRESETS.find(p=>p.id===id).parameters,brandLivery:"sitrec",flashPeriod:1.7,dumpTilt:35});
            const saved=parameterFile(p,"Round trip");expect(readParameterFile(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
        }
        expect(readParameterFile(oldFile({length:31},"Legacy")).parameters.length).toBe(31);
        expect(()=>readParameterFile({format:"sitrec-procedural-vehicle",version:2})).toThrow();
    });
    test("lights use compatible strobe metadata and forward-facing exportable spotlights", () => {
        const m=buildVehicle(PRESETS.find(p=>p.id==="737").parameters);
        const left=m.root.getObjectByName("Left Position Red"),right=m.root.getObjectByName("Right Position Green");
        expect(left.position.x).toBeGreaterThan(0);expect(right.position.x).toBeLessThan(0);
        const strobe=m.root.getObjectByName("Left Strobe");expect(strobe.userData.strobeEvery).toBe(1);
        const spot=m.root.getObjectByName("Left Landing");expect(spot.isSpotLight).toBe(true);
        expect(spot.target.parent).toBe(spot);expect(spot.target.position.toArray()).toEqual([0,0,-1]);
        const direction=new Vector3(0,0,-1).applyQuaternion(spot.quaternion);expect(direction.z).toBeGreaterThan(0.9);expect(direction.y).toBeLessThan(0);
        animateVehicleLights(m,0.01,true);expect(strobe.intensity).toBeGreaterThan(0);
        animateVehicleLights(m,0.5,true);expect(strobe.intensity).toBe(0);expect(left.intensity).toBeGreaterThan(0);
        disposeVehicle(m.root);
    });
    test.each(PRESETS.map(p=>p.id))("SITREC markings adapt to %s without texture dependencies", id=> {
        const m=buildVehicle({...PRESETS.find(p=>p.id===id).parameters,brandLivery:"sitrec"});
        const group=m.root.getObjectByName("SITREC livery");expect(group.children.length).toBeGreaterThan(10);
        group.traverse(o=>{if(o.isMesh){expect(Array.from(o.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);expect(o.material.map).toBe(null);}});
        disposeVehicle(m.root);
    });
    test("reference corrections retain distinct airframe arrangements", () => {
        const preset=id=>PRESETS.find(p=>p.id===id).parameters;
        expect(preset("mil-an124").tailStyle).toBe("conventional");
        expect(preset("mil-j7").tailStyle).toBe("conventional");
        expect(preset("mil-b2").flyingWingShape).toBe("sawtooth");
        expect(preset("mil-neuron").flyingWingShape).toBe("lambda");
        for(const id of ["heli-h130","heli-h135","heli-h145","heli-h160","mil-z19"]) {
            const m=buildVehicle(preset(id));
            expect(m.root.getObjectByName("Tail rotor shroud")).toBeDefined();
            expect(m.root.getObjectByName("Vertical fin 1")).toBeUndefined();
            disposeVehicle(m.root);
        }
        const harrier=buildVehicle(preset("mil-harrier"));
        expect(harrier.root.children.filter(o=>o.name.startsWith("Vectoring nozzle"))).toHaveLength(4);
        expect(harrier.root.getObjectByName("Integrated exhaust 1")).toBeUndefined();
        disposeVehicle(harrier.root);
    });
    test("wing lettering reads in the same direction on both sides", () => {
        const m=buildVehicle({...PRESETS.find(p=>p.id==="mil-j20").parameters,brandLivery:"sitrec"});
        const markings=m.root.getObjectByName("SITREC livery").children;
        // Each word has eleven strokes followed by six globe strokes.
        for(const offset of [0,17]) {
            const first=new Box3().setFromObject(markings[offset]).getCenter(new Vector3());
            const last=new Box3().setFromObject(markings[offset+10]).getCenter(new Vector3());
            expect(last.x).toBeGreaterThan(first.x);
        }
        disposeVehicle(m.root);
    });
    test.each(["737","road-police"])("switching lights off extinguishes lenses in %s",id=>{
        const m=buildVehicle({...PRESETS.find(p=>p.id===id).parameters,lightsEnabled:false});
        expect(m.lamps).toHaveLength(0);
        m.root.traverse(o=>{if(/^(Navigation lens|Headlamp |Tail lamp |Front indicator |Emergency lamp)/.test(o.name))expect(o.material.emissiveIntensity).toBe(0);});
        disposeVehicle(m.root);
    });
    test("steering and tipper controls move connected assemblies", () => {
        const p=PRESETS.find(p=>p.id==="road-dump").parameters,m=buildVehicle({...p,steering:25,dumpTilt:40});
        expect(m.root.getObjectByName("Cargo bed").rotation.x).toBeCloseTo(-40*Math.PI/180);
        expect(m.root.getObjectByName("Wheel mount 1 0").rotation.y).toBeCloseTo(25*Math.PI/180);
        expect(m.propellers).toHaveLength(10);disposeVehicle(m.root);
    });
});
