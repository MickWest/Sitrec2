import {ColorManagement, Line3, Vector3} from "three";
import {PRESETS, parameterFile, readParameterFile} from "../tools/vehicles/vehicleParameters.js";
import {createVehicleRecipe, readVehicleRecipe} from "../tools/vehicles/recipe.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {disposeVehicle} from "../tools/vehicles/vehicle.js";
import {buildTransmissionTower, towerCapacity, towerClamp} from "../tools/vehicles/transmissionTower.js";

const ground = PRESETS.filter(p => p.vehicleType === "ground");
const towers = ground.filter(p => p.parameters.groundKind === "pylon");

test("the revised tower generator opens British pylons saved before the crossarm fix", () => {
    const p = towers.find(p => p.id === "ground-british-pylon");
    const current = createVehicleRecipe(p.parameters,p.name,p.id);
    expect(current.generatorRevision).toBe(2);
    const old = {...current,generatorRevision:1,parameters:{...current.parameters}};
    delete old.parameters.shaftDiameter;
    delete old.parameters.woodColor;
    expect(readVehicleRecipe(old).parameters).toEqual(current.parameters);
});

function towerMembers(p, simple) {
    const members = [];
    buildTransmissionTower(p, {simple, box() {}, beam(name,color,a,b) {members.push({name,a,b});}});
    return members;
}

test.each(towers.map(p => [p.id,p.parameters]))("%s has a physical insulator at every wire port in both detail levels", (_,p) => {
    const count = towerCapacity(p);
    for (const simple of [false,true]) {
        const strings = towerMembers(p,simple).filter(m => m.name === "Insulator strings");
        const unique = new Set();
        for (let i=0; i<count; i++) {
            const [x,level] = towerClamp(p,i), clamp = new Vector3(x,level*p.height,0);
            unique.add(clamp.toArray().join(","));
            expect(strings.some(({a,b}) => a.distanceTo(clamp)<1e-6 || b.distanceTo(clamp)<1e-6)).toBe(true);
        }
        expect(unique.size).toBe(count);
    }
});

const ukTowers = towers.filter(p => p.id.startsWith("ground-uk-"));
test.each(["ground-british-pylon","ground-pylon",...ukTowers.map(p => p.id)])("%s crossarm chords meet the modelled mast legs", id => {
    const preset = towers.find(p => p.id === id);
    for (const [simple,bays] of [[true,8],[false,4],[false,9],[false,14]]) {
        const p = {...preset.parameters,bays};
        const members = towerMembers(p,simple);
        const steel = members.filter(m => m.name === "Galvanized steel");
        const hangers = members.filter(m => m.name === "Insulator strings").map(m => m.a);
        // Mast corner legs run up within one quadrant, or from it to the apex.
        const legs = steel.filter(({a,b}) => b.y>a.y && Math.abs(a.x)===Math.abs(a.z) &&
            Math.abs(b.x)===Math.abs(b.z) && a.x*b.x>=0 && a.z*b.z>=0).map(({a,b}) => new Line3(a,b));
        const chords = steel.filter(({a,b}) => a.z!==0 && Math.abs(a.x)===Math.abs(a.z) &&
            hangers.some(tip => b.distanceTo(tip)<1e-6));
        expect(chords).toHaveLength(p.armLevels*8);
        const at = new Vector3();
        for (const {a} of chords) {
            expect(legs.some(leg => leg.closestPointToPoint(a,true,at).distanceTo(a)<1e-6)).toBe(true);
        }
    }
});

test("UK suspension towers keep six distinct clamps and the characteristic order of arm widths", () => {
    expect(ukTowers).toHaveLength(7);
    for (const {parameters} of ukTowers) {
        const p = {...parameters, armLevels:1};
        expect(towerCapacity(p)).toBe(6);
        const [top,middle,bottom] = [1,3,5].map(index => towerClamp(p,index));
        expect(top[1]).toBeGreaterThan(middle[1]);
        expect(middle[1]).toBeGreaterThan(bottom[1]);
        expect(middle[0]).toBeGreaterThan(top[0]);
        if (["ukL2","ukL3"].includes(p.towerStyle)) {
            expect(bottom[0]).toBeGreaterThan(middle[0]);
        } else {
            expect(middle[0]).toBeGreaterThan(bottom[0]);
        }
    }
});

test.each([false, true])("oak materials use linear RGB with host color management %s", enabled => {
    const oak = ground.find(p => p.id === "ground-oak");
    const recipe = createVehicleRecipe({...oak.parameters, woodColor: "#804020", leafColor: "#408020"});
    const previous = ColorManagement.enabled;
    let model;
    try {
        ColorManagement.enabled = enabled;
        model = generateVehicle(recipe);
        expect(ColorManagement.enabled).toBe(enabled);
        // IEC sRGB channels 128, 64 and 32, decoded before the foliage tint is applied.
        const bark = model.root.getObjectByName("Bark").material.color;
        expect(bark.r).toBeCloseTo(.215861, 6);
        expect(bark.g).toBeCloseTo(.051269, 6);
        expect(bark.b).toBeCloseTo(.014444, 6);
        const leaves = model.root.getObjectByName("Foliage 2").material.color;
        expect(leaves.r).toBeCloseTo(.051269 * .88, 6);
        expect(leaves.g).toBeCloseTo(.215861 * .88, 6);
        expect(leaves.b).toBeCloseTo(.014444 * .88, 6);
    } finally {
        ColorManagement.enabled = previous;
        if (model) disposeVehicle(model.root);
    }
});

test.each(ground.map(p => [p.id,p]))("%s restores its design in metres at ground level", (_,preset) => {
    const recipe = createVehicleRecipe(preset.parameters,preset.name,preset.id);
    const restored = readVehicleRecipe(JSON.parse(JSON.stringify(recipe)));
    expect(restored).toEqual(recipe);
    expect(readParameterFile(parameterFile(recipe.parameters)).parameters).toEqual(recipe.parameters);
    const model = generateVehicle(restored);
    try {
        expect(model.bounds.min.y).toBeCloseTo(0, 4);
        expect(Math.abs(model.stats.size.y - recipe.parameters.height)).toBeLessThan(.05);
        expect(model.stats.size.toArray().every(v => Number.isFinite(v) && v > 0)).toBe(true);
        expect(model.root.children.length).toBeLessThan(10);
        expect(model.lamps).toHaveLength(0);
        if (["pole","pylon"].includes(recipe.parameters.groundKind)) {
            const points = model.root.userData.connectionPoints;
            const incoming = points.filter(p => p.tag === "in"), outgoing = points.filter(p => p.tag === "out");
            expect(incoming.length).toBeGreaterThan(0);
            expect(incoming.map(p => p.position)).toEqual(outgoing.map(p => p.position));
            expect(points.every(p => p.position.every(Number.isFinite))).toBe(true);
        }
    } finally {disposeVehicle(model.root);}
});

test.each(ground.filter(p => p.parameters.seed).map(p => [p.id,p]))("%s regenerates the same shape from its saved seed", (_,preset) => {
    const shape = seed => {
        const model = generateVehicle(createVehicleRecipe({...preset.parameters, seed}));
        try {return model.root.children.flatMap(mesh => Array.from(mesh.geometry.attributes.position.array.slice(-30)));}
        finally {disposeVehicle(model.root);}
    };
    expect(shape(47)).toEqual(shape(47));
    expect(shape(48)).not.toEqual(shape(47));
});
