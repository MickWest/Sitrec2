import {Box3, Color, Vector3} from "three";
import {PRESETS, normalizeParameters, parameterGroups, parameterFile, readParameterFile, isBird} from "../tools/vehicles/vehicleParameters.js";
import {buildVehicle, disposeVehicle} from "../tools/vehicles/vehicle.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {createVehicleRecipe} from "../tools/vehicles/recipe.js";
import {collectVehicleSpinners, poseVehicleSpinners, wingbeatAt} from "../tools/vehicles/motion.js";
import {VEHICLE_TYPES, createVehicleFilter} from "../tools/vehicles/catalog.js";
import {BIRD_FLIGHT_STYLES, BIRD_WING_TIPS, BIRD_TAIL_SHAPES, BIRD_BILL_SHAPES, BIRD_WING_PATTERNS} from "../tools/vehicles/birdParameters.js";
import {resolveVehicleThermal} from "../tools/vehicles/thermalPreview.js";

const birds = PRESETS.filter(item => isBird(item.parameters));
const preset = id => PRESETS.find(item => item.id === id).parameters;
// The world position of the tip of a wing: the point of the outer wing that is farthest out.
function wingTip(model, side) {
    model.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(model.root.getObjectByName(`${side} outer wing`));
    return new Vector3(side === "Left" ? box.max.x : box.min.x, (box.min.y + box.max.y) / 2, 0);
}

describe("Bird designs", () => {
    test("the catalog has a Birds type, with the common species and each kind of shape", () => {
        expect(VEHICLE_TYPES.bird).toBe("Birds");
        expect(PRESETS.filter(createVehicleFilter({kind: "bird"}))).toHaveLength(birds.length);
        expect(birds.length).toBeGreaterThanOrEqual(30);
        for (const word of ["gull", "pelican", "crane", "raven", "pigeon", "dove", "goose", "eagle"])
            expect(PRESETS.filter(createVehicleFilter({kind: "bird", query: word})).length).toBeGreaterThanOrEqual(1);
        const used = key => new Set(birds.map(item => item.parameters[key]));
        expect(used("flightStyle")).toEqual(new Set(Object.keys(BIRD_FLIGHT_STYLES)));
        expect(used("wingTip")).toEqual(new Set(Object.keys(BIRD_WING_TIPS)));
        expect(used("tailShape")).toEqual(new Set(Object.keys(BIRD_TAIL_SHAPES)));
        expect(used("billShape")).toEqual(new Set(Object.keys(BIRD_BILL_SHAPES)));
        expect(used("wingPattern")).toEqual(new Set(Object.keys(BIRD_WING_PATTERNS)));
    });

    test.each(birds.map(item => [item.id, item.parameters]))("%s builds finite geometry and round-trips its parameters", (_, p) => {
        const model = buildVehicle(p), file = parameterFile(p, "Bird example");
        expect(readParameterFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
        expect(normalizeParameters(p)).toEqual(p);
        expect(model.bounds.isEmpty()).toBe(false);
        expect(model.stats.size.toArray().every(n => Number.isFinite(n) && n > 0)).toBe(true);
        expect(model.stats.triangles).toBeGreaterThan(500);
        expect(model.stats.triangles).toBeLessThan(6000);
        expect(model.stats.wingArea).toBeGreaterThan(0);
        model.root.traverse(part => {
            if (part.isMesh) for (const attribute of [part.geometry.attributes.position, part.geometry.attributes.normal, part.geometry.attributes.color])
                expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        });
        expect(model.lamps).toHaveLength(0);
        expect(model.propellers).toHaveLength(0);
        // A body and two wing joints on each side move, but not on a bird that only glides.
        expect(model.waves).toHaveLength(p.flightStyle === "glide" ? 0 : 5);
        expect(model.sweepBounds.containsBox(model.bounds)).toBe(true);
        disposeVehicle(model.root);
    });

    test.each(birds.map(item => [item.id, item.parameters]))("%s has the length and the wingspan of its design", (_, p) => {
        // Flat wings, and no legs behind the tail: the model is then as long and as wide as the two values.
        const model = buildVehicle({...p, glideAngle: 0, wristDroop: 0, legs: "tucked"});
        expect(Math.abs(model.stats.size.z / p.length - 1)).toBeLessThan(0.03);
        expect(Math.abs(model.stats.size.x / p.wingspan - 1)).toBeLessThan(0.03);
        disposeVehicle(model.root);
    });

    test("a bird has no light or livery controls, and the SITREC livery does not break it", () => {
        const p = preset("bird-gull-herring");
        expect(parameterGroups(p).map(group => group.name)).toEqual(["Scale", "Bird", "Wings", "Tail", "Wing motion", "Plumage", "Thermal"]);
        const model = buildVehicle({...p, brandLivery: "sitrec"});
        expect(model.root.getObjectByName("SITREC livery")).toBeUndefined();
        expect(model.lamps).toHaveLength(0);
        disposeVehicle(model.root);
    });

    test("in the IR preview a bird has no engine: its thermal profile is unpowered", () => {
        const p = preset("bird-goose-canada");
        expect(p.thermalPower).toBe(0);
        expect(p.thermalMach).toBe(0);
        expect(resolveVehicleThermal(createVehicleRecipe(p, "Goose")).profile).toBe("unpowered");
    });

    test("each preset has a species page, and says if its wingbeat rate is a measured value", () => {
        for (const item of birds) {
            expect(item.reference.source).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\/[A-Za-z_-]+$/);
            expect(item.reference.description).toContain(`${item.parameters.wingbeatRate} per second`);
            expect(item.reference.description).toContain(item.reference.wingbeatSource ? `a measured value (${item.reference.wingbeatSource})` : "an estimate");
        }
        expect(birds.filter(item => item.reference.wingbeatSource).length).toBe(24);
    });

    test("the bill points forward, and trailing legs go behind the tail", () => {
        const crane = buildVehicle(preset("bird-crane-sandhill")), tucked = buildVehicle({...preset("bird-crane-sandhill"), legs: "tucked"});
        const p = preset("bird-crane-sandhill");
        // The long neck puts most of the length in front of the wings.
        expect(crane.bounds.max.z).toBeGreaterThan(-tucked.bounds.min.z);
        expect(tucked.bounds.min.z - crane.bounds.min.z).toBeCloseTo(p.length * p.legLength / 100, 2);
        disposeVehicle(crane.root); disposeVehicle(tucked.root);
    });

    test("the plumage is vertex colors on one material", () => {
        const p = preset("bird-gull-herring"), model = buildVehicle(p);
        const materials = new Set(), seen = new Set();
        model.root.traverse(part => {
            if (!part.isMesh) return;
            materials.add(part.material);
            const colors = part.geometry.attributes.color;
            for (let vertex = 0; vertex < colors.count; vertex++) seen.add(new Color(colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)).getHexString());
        });
        expect(materials.size).toBe(1);
        expect([...materials][0].vertexColors).toBe(true);
        // The round trip through the linear color space can change the last digit.
        const has = hex => [...seen].some(color => Math.abs(parseInt(color, 16) - parseInt(hex.slice(1), 16)) <= 0x010101 &&
            new Color(`#${color}`).getHexString().length === 6 && Math.abs(new Color(`#${color}`).r - new Color(hex).r) < 0.01);
        for (const key of ["wingColor", "underwingColor", "markColor", "billColor", "eyeColor"]) expect(has(p[key])).toBe(true);
        disposeVehicle(model.root);
    });

    test("the wing marks are where the pattern puts them", () => {
        const tipColors = (changes) => {
            const model = buildVehicle({...preset("bird-gull-herring"), ...changes});
            const hand = model.root.getObjectByName("Left outer wing").geometry, position = hand.attributes.position, colors = hand.attributes.color;
            // The vertex that is farthest along the outer wing is at its tip.
            let tip = 0;
            for (let vertex = 1; vertex < position.count; vertex++) if (position.getX(vertex) > position.getX(tip)) tip = vertex;
            const color = new Color(colors.getX(tip), colors.getY(tip), colors.getZ(tip));
            disposeVehicle(model.root);
            return color;
        };
        const mark = new Color("#102030"), wing = new Color("#c0c0c0");
        const close = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.01;
        const changes = {markColor: "#102030", wingColor: "#c0c0c0", underwingColor: "#c0c0c0"};
        expect(close(tipColors({...changes, wingPattern: "tips"}), mark)).toBe(true);
        expect(close(tipColors({...changes, wingPattern: "plain"}), wing)).toBe(true);
    });
});

describe("Bird wing motion", () => {
    test("a steady wingbeat counts beats from the time, and a burst is followed by a glide", () => {
        expect(wingbeatAt({rate: 4}, 2.5)).toEqual({beats: 10, strength: 1});
        const burst = {rate: 4, burst: [6, 2]};         // 1.5 s of flapping, then 2 s of glide
        expect(wingbeatAt(burst, 0.75)).toEqual({beats: 3, strength: 1});
        expect(wingbeatAt(burst, 2)).toEqual({beats: 0, strength: 0});
        expect(wingbeatAt(burst, 3.5 + 0.75)).toEqual({beats: 3, strength: 1});
        // The wings start and stop smoothly.
        expect(wingbeatAt(burst, 0).strength).toBe(0);
        expect(wingbeatAt(burst, 0.05).strength).toBeGreaterThan(0);
        expect(wingbeatAt(burst, 0.05).strength).toBeLessThan(1);
        expect(wingbeatAt(burst, 1.49).strength).toBeLessThan(0.1);
    });

    test("the wings go up and down, repeat for the same time, and rest in the glide position", () => {
        const p = preset("bird-gull-herring"), model = generateVehicle(createVehicleRecipe(p, "Gull"));
        const parts = collectVehicleSpinners(model.scene);
        expect(parts).toHaveLength(5);
        const pose = () => parts.map(part => [...part.rotation.toArray().slice(0, 3), ...part.position.toArray()]);
        const rest = pose(), period = 1 / p.wingbeatRate;
        poseVehicleSpinners(parts, 0, true); const up = pose(), tipUp = wingTip(model, "Left").y;
        poseVehicleSpinners(parts, period / 2, true); const tipDown = wingTip(model, "Left").y;
        expect(tipUp).toBeGreaterThan(0.2);
        expect(tipDown).toBeLessThan(-0.1);
        poseVehicleSpinners(parts, period * 7, true);
        pose().forEach((values, index) => values.forEach((value, axis) => expect(value).toBeCloseTo(up[index][axis], 9)));
        // One moment of the wingbeat can be set directly, for a still picture.
        poseVehicleSpinners(parts, 123.4, true, {beats: 0});
        pose().forEach((values, index) => values.forEach((value, axis) => expect(value).toBeCloseTo(up[index][axis], 9)));
        poseVehicleSpinners(parts, 5, false);
        expect(pose()).toEqual(rest);
        disposeVehicle(model.scene);
    });

    test("the two wings move as mirror images, and the body goes down as the wings go up", () => {
        const model = buildVehicle(preset("bird-pigeon-blue")), body = model.root.getObjectByName("Bird body");
        for (const beats of [0, 0.2, 0.5, 0.8]) {
            poseVehicleSpinners(model.waves, 0, true, {beats});
            const left = wingTip(model, "Left"), right = wingTip(model, "Right");
            expect(right.x).toBeCloseTo(-left.x, 9); expect(right.y).toBeCloseTo(left.y, 9);
        }
        poseVehicleSpinners(model.waves, 0, true, {beats: 0.25}); const middleOfDownstroke = body.position.y;
        poseVehicleSpinners(model.waves, 0, true, {beats: 0.75}); const middleOfUpstroke = body.position.y;
        expect(middleOfDownstroke).toBeLessThan(0);
        expect(middleOfUpstroke).toBeCloseTo(-middleOfDownstroke, 9);
        disposeVehicle(model.root);
    });

    test("a faster wingbeat rate gives more wingbeats in the same time", () => {
        const beats = rate => {
            const model = buildVehicle({...preset("bird-gull-herring"), wingbeatRate: rate}), shoulder = model.root.getObjectByName("Left shoulder");
            const angle = seconds => {poseVehicleSpinners(model.waves, seconds, true); return shoulder.rotation.z;};
            let count = 0;
            // The wing is at the top of its stroke where its angle is larger than just before and just after.
            for (let step = 5; step < 995; step++)
                if (angle(step / 500) > angle((step - 1) / 500) && angle(step / 500) >= angle((step + 1) / 500)) count++;
            disposeVehicle(model.root);
            return count;           // the times the wing is at the top, from 0.01 s to 1.99 s
        };
        expect(beats(3)).toBe(5);
        expect(beats(6)).toBe(11);
    });

    test("a gliding bird has no moving parts, and a bird that flaps in bursts holds its wings still in the glide", () => {
        const glider = generateVehicle(createVehicleRecipe(preset("bird-eagle-golden"), "Eagle"));
        expect(collectVehicleSpinners(glider.scene)).toHaveLength(0);
        disposeVehicle(glider.scene);
        const p = preset("bird-pelican-white"), model = buildVehicle(p);
        expect(p.flightStyle).toBe("bursts");
        const flapping = p.burstBeats / p.wingbeatRate;
        const pose = seconds => {poseVehicleSpinners(model.waves, seconds, true); return model.waves.map(part => part.rotation.toArray().slice(0, 3));};
        const rest = model.waves.map(part => part.userData.vehicleFlap.rest);
        expect(pose(flapping + p.glideSeconds / 2)).toEqual(rest);
        expect(pose(flapping / 2)).not.toEqual(rest);
        disposeVehicle(model.root);
    });

    test("the joint records are plain data, so a frozen GLB copy keeps its wing motion", () => {
        const model = buildVehicle(preset("bird-stork-white"));
        for (const part of model.waves) {
            const record = part.userData.vehicleFlap;
            expect(JSON.parse(JSON.stringify(record))).toEqual(record);
            expect(record.order).toBe("ZYX");
            expect(record.burst).toEqual([6, 3]);
        }
        disposeVehicle(model.root);
    });
});
