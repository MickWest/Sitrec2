import {Box3, Vector3} from "three";
import {PRESETS, normalizeParameters, parameterFile, readParameterFile, isRoad, parameterGroups} from "../tools/vehicles/vehicleParameters.js";
import {kiteLiftingArea} from "../tools/vehicles/kiteFlight.js";
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
    // A kite or a bird has no surface for the lettering: tests/Kites.test.js and tests/Birds.test.js check that they have none.
    test.each(PRESETS.filter(p=>!["kite","bird"].includes(p.vehicleType)).map(p=>p.id))("SITREC markings adapt to %s without texture dependencies", id=> {
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
    // One preset of each type of object: each has its own list of fields and its own builder.
    const firstOf = type => PRESETS.find(p => p.vehicleType === type).id;
    const EACH_TYPE = ["737", "heli-s76", firstOf("car"), firstOf("truck"), "drone-mini4", firstOf("balloon"), "kite-diamond", firstOf("bird")];
    const parametersOf = id => PRESETS.find(p => p.id === id).parameters;
    const lengthFields = parameters => parameterGroups(parameters).flatMap(group => group.fields)
        .filter(field => field.type === "number" && /· ?m$/.test(field.label));
    function expectFiniteModel(parameters) {
        const m = buildVehicle(parameters);
        expect(m.bounds.isEmpty()).toBe(false);
        expect(m.stats.size.toArray().every(Number.isFinite)).toBe(true);
        m.root.traverse(o => {if (o.isMesh) expect(Array.from(o.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);});
        disposeVehicle(m.root);
    }
    test.each(EACH_TYPE)("no length of %s has a lower limit above 0.01 m", id => {
        const fields = lengthFields(parametersOf(id));
        expect(fields.length).toBeGreaterThan(1);
        for (const field of fields) expect(field.min).toBeLessThanOrEqual(0.01);
    });
    // The doors and the lettering of an airliner have a fixed size, and the gear and the engines have
    // offsets in metres. On a short body they are beyond its ends, which gave a model that was not finite.
    test.each([...EACH_TYPE, "a380", "biplane"])("%s is a finite model with each length at its least value", id => {
        const parameters = parametersOf(id), fields = lengthFields(parameters);
        for (const field of fields) expectFiniteModel({...parameters, [field.key]: field.min});
        expectFiniteModel({...parameters, ...Object.fromEntries(fields.map(field => [field.key, field.min]))});
    });
    test("an engine that is offset to behind the tail gives a finite model", () => {
        expectFiniteModel({...parametersOf("mil-a10"), engineOffset: -4});
    });
    test("Overall scale is the first control of each type, from 0.01 to 100 with a default of 1", () => {
        for (const id of EACH_TYPE) {
            const parameters = parametersOf(id), field = parameterGroups(parameters)[0].fields[0];
            expect(field).toMatchObject({key: "overallScale", min: 0.01, max: 100, value: 1, log: true});
            expect(parameters.overallScale).toBe(1);
            // A design that was saved before the control existed has no scale.
            const {overallScale, ...saved} = parameters;
            expect(normalizeParameters(saved).overallScale).toBe(1);
            expect(normalizeParameters({...parameters, overallScale: 0.001}).overallScale).toBe(0.01);
            expect(normalizeParameters({...parameters, overallScale: 1000}).overallScale).toBe(100);
        }
    });
    test.each(EACH_TYPE)("Overall scale makes a scale model of %s", id => {
        const parameters = parametersOf(id), full = buildVehicle(parameters);
        const size = full.stats.size.clone(), stats = {...full.stats};
        const lights = full.root.children.filter(o => o.isLight).map(o => ({name: o.name, position: o.position.clone(), intensity: o.intensity}));
        const parts = full.root.children.length - lights.length;
        // At a scale of 1 the model has no added group: it is the same model as before the control existed.
        expect(full.root.getObjectByName("Overall scale")).toBeUndefined();
        disposeVehicle(full.root);
        for (const scale of [0.01, 0.1, 100]) {
            const m = buildVehicle({...parameters, overallScale: scale});
            // The scale is inside the root. Sitrec measures a model with the scale of its root set to 1.
            expect(m.root.scale.toArray()).toEqual([1, 1, 1]);
            const group = m.root.getObjectByName("Overall scale");
            expect(group.parent).toBe(m.root);
            expect(group.children).toHaveLength(parts);
            // The lamps stay on the root: Sitrec reads the position of a lamp in the root only.
            const scaledLights = m.root.children.filter(o => o.isLight);
            expect(scaledLights).toHaveLength(lights.length);
            expect(m.root.children).toHaveLength(lights.length + 1);
            for (const [index, light] of scaledLights.entries()) {
                expect(light.name).toBe(lights[index].name);
                expect(light.position.distanceTo(lights[index].position.clone().multiplyScalar(scale))).toBeLessThan(1e-9 * Math.max(1, scale));
                expect(light.intensity / lights[index].intensity / scale ** 2).toBeCloseTo(1, 9);
            }
            for (const axis of ["x", "y", "z"]) expect(m.stats.size[axis] / size[axis] / scale).toBeCloseTo(1, 5);
            for (const key of ["wingspan", "width", "height", "wheelbase", "bodyLength"])
                if (stats[key]) expect(m.stats[key] / stats[key] / scale).toBeCloseTo(1, 9);
            for (const key of ["area", "wingArea"]) if (stats[key]) expect(m.stats[key] / stats[key] / scale ** 2).toBeCloseTo(1, 9);
            if (m.sweepBounds) expect(m.sweepBounds.containsBox(m.bounds)).toBe(true);
            disposeVehicle(m.root);
        }
    });
    test("Overall scale multiplies the lifting area of a kite by its square, with or without a set area", () => {
        const kite = parametersOf("kite-diamond"), area = kiteLiftingArea(kite);
        expect(kiteLiftingArea({...kite, overallScale: 3})).toBeCloseTo(area * 9, 9);
        expect(kiteLiftingArea({...kite, kiteArea: 2, overallScale: 0.5})).toBeCloseTo(0.5, 9);
    });
    test("steering and tipper controls move connected assemblies", () => {
        const p=PRESETS.find(p=>p.id==="road-dump").parameters,m=buildVehicle({...p,steering:25,dumpTilt:40});
        expect(m.root.getObjectByName("Cargo bed").rotation.x).toBeCloseTo(-40*Math.PI/180);
        expect(m.root.getObjectByName("Wheel mount 1 0").rotation.y).toBeCloseTo(25*Math.PI/180);
        expect(m.propellers).toHaveLength(10);disposeVehicle(m.root);
    });
});
