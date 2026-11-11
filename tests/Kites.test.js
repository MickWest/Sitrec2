import {PRESETS, normalizeParameters, parameterGroups, parameterFile, readParameterFile, isKite} from "../tools/vehicles/vehicleParameters.js";
import {buildVehicle, disposeVehicle} from "../tools/vehicles/vehicle.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {createVehicleRecipe} from "../tools/vehicles/recipe.js";
import {collectVehicleSpinners, poseVehicleSpinners} from "../tools/vehicles/motion.js";
import {VEHICLE_TYPES, createVehicleFilter} from "../tools/vehicles/catalog.js";
import {KITE_SHAPES} from "../tools/vehicles/kiteParameters.js";
import {
    KITE_FLIGHT_DEFAULTS, KITE_GRAVITY, KITE_REFERENCE_WIND,
    kiteFlightProperties, kiteLiftingArea, kiteMinimumWind, solveKiteLine,
} from "../tools/vehicles/kiteFlight.js";

const kites = PRESETS.filter(preset => isKite(preset.parameters));
const preset = id => PRESETS.find(item => item.id === id).parameters;
const degrees = radians => radians * 180 / Math.PI;

describe("Kite designs", () => {
    test("the catalog has a Kites type with every shape, and octopus kites", () => {
        expect(VEHICLE_TYPES.kite).toBe("Kites");
        expect(PRESETS.filter(createVehicleFilter({kind: "kite"}))).toHaveLength(kites.length);
        expect(new Set(kites.map(item => item.parameters.kiteShape))).toEqual(new Set(Object.keys(KITE_SHAPES)));
        expect(kites.filter(item => item.parameters.kiteShape === "octopus").length).toBeGreaterThanOrEqual(3);
        for (const shape of Object.keys(KITE_SHAPES)) expect(KITE_FLIGHT_DEFAULTS[shape]).toBeDefined();
    });

    test.each(kites.map(item => [item.id, item.parameters]))("%s builds finite geometry and round-trips its parameters", (_, p) => {
        const model = buildVehicle(p), file = parameterFile(p, "Kite example");
        expect(readParameterFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
        expect(normalizeParameters(p)).toEqual(p);
        expect(model.bounds.isEmpty()).toBe(false);
        expect(model.stats.size.toArray().every(n => Number.isFinite(n) && n > 0)).toBe(true);
        expect(model.stats.triangles).toBeGreaterThan(20);
        expect(model.stats.triangles).toBeLessThan(100000);
        model.root.traverse(part => {
            if (part.isMesh) for (const attribute of [part.geometry.attributes.position, part.geometry.attributes.normal])
                expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        });
        expect(model.lamps).toHaveLength(0);
        expect(model.propellers).toHaveLength(0);
        expect(model.waves).toHaveLength(p.tailCount * (p.tailStyle === "tube" ? 24 : 14));
        disposeVehicle(model.root);
    });

    test("a kite has no light or livery controls, and the SITREC livery does not break it", () => {
        const p = preset("kite-octopus-14");
        const names = parameterGroups(p).map(group => group.name);
        expect(names).toEqual(["Kite", "Tails & tentacles", "Colors & fabric", "Flight", "Thermal"]);
        const model = buildVehicle({...p, brandLivery: "sitrec"});
        expect(model.root.getObjectByName("SITREC livery")).toBeUndefined();
        disposeVehicle(model.root);
    });

    test("the nose points into the wind, the tails stream downwind, and the tow point is the origin", () => {
        const model = buildVehicle(preset("kite-octopus-14")), p = preset("kite-octopus-14");
        // The tentacles are much longer than the head, so the model extends far toward -Z.
        expect(model.bounds.min.z).toBeLessThan(-p.tailLength * 0.7);
        expect(model.bounds.max.z).toBeLessThan(p.height);
        // The head is above the tow point.
        expect(model.root.getObjectByName("Kite head").getWorldPosition(model.root.position.clone()).y).toBeGreaterThan(0);
        expect(model.root.getObjectByName("Kite eye")).toBeDefined();
        disposeVehicle(model.root);
    });

    test("tails move with the air that passes, repeat for the same air, and rest when animation is off", () => {
        const model = generateVehicle(createVehicleRecipe(preset("kite-octopus-14"), "Octopus"));
        const parts = collectVehicleSpinners(model.scene);
        expect(parts).toHaveLength(8 * 24);
        const pose = () => parts.map(part => part.rotation.toArray().slice(0, 3));
        poseVehicleSpinners(parts, 0, true, {air: 20, wind: 6}); const first = pose();
        poseVehicleSpinners(parts, 0, true, {air: 23, wind: 6}); const later = pose();
        expect(later).not.toEqual(first);
        poseVehicleSpinners(parts, 99, true, {air: 20, wind: 6});
        expect(pose()).toEqual(first);
        // Without a wind, time and the reference wind give the air.
        poseVehicleSpinners(parts, 20 / KITE_REFERENCE_WIND, true);
        expect(pose()).toEqual(first);
        poseVehicleSpinners(parts, 5, false);
        expect(pose()).toEqual(parts.map(part => part.userData.vehicleWave.rest));
        disposeVehicle(model.scene);
    });

    test("tails hang lower in a light wind and do not move in a calm", () => {
        const model = buildVehicle(preset("kite-diamond")), root = model.waves[0];
        const droop = root.userData.vehicleWave.droop;
        expect(droop).toBeGreaterThan(0);
        poseVehicleSpinners(model.waves, 0, true, {air: 0, wind: 0});
        const calm = root.rotation.x;
        poseVehicleSpinners(model.waves, 0, true, {air: 50, wind: 0});
        expect(root.rotation.x).toBe(calm);
        expect(-calm).toBeGreaterThan(droop + 0.5);
        poseVehicleSpinners(model.waves, 0, true, {air: 0, wind: 20});
        expect(-root.rotation.x).toBeLessThan(droop);
        disposeVehicle(model.root);
    });
});

describe("Kite flight statics", () => {
    const properties = {massKg: 0.25, areaM2: 1, liftCoefficient: 0.9, dragCoefficient: 0.45};

    test("lifting area comes from the shape unless the design gives it", () => {
        const p = preset("kite-diamond");
        expect(kiteLiftingArea(p)).toBeCloseTo(0.5 * p.width * p.height);
        expect(kiteLiftingArea({...p, kiteArea: 2.5})).toBe(2.5);
        expect(kiteFlightProperties(p)).toEqual({massKg: p.kiteMass, areaM2: kiteLiftingArea(p),
            liftCoefficient: p.liftCoefficient, dragCoefficient: p.dragCoefficient});
    });

    test("at the minimum wind, lift equals weight", () => {
        const wind = kiteMinimumWind(properties);
        const lift = 0.5 * 1.225 * wind * wind * properties.areaM2 * properties.liftCoefficient;
        expect(lift).toBeCloseTo(properties.massKg * KITE_GRAVITY, 9);
        expect(solveKiteLine({windSpeed: wind * 0.99, lineLength: 100, properties}).flying).toBe(false);
        expect(solveKiteLine({windSpeed: wind * 1.01, lineLength: 100, properties}).flying).toBe(true);
    });

    test("a weightless line is straight at the angle of the force balance", () => {
        const windSpeed = 8, pressure = 0.5 * 1.225 * windSpeed * windSpeed;
        const lift = pressure * 0.9, drag = pressure * 0.45, weight = 0.25 * KITE_GRAVITY;
        const result = solveKiteLine({windSpeed, lineLength: 100, properties});
        const angle = Math.atan2(lift - weight, drag);
        expect(result.lineAngleAtKite).toBeCloseTo(angle, 12);
        expect(result.downwind).toBeCloseTo(100 * Math.cos(angle), 9);
        expect(result.height).toBeCloseTo(100 * Math.sin(angle), 9);
        expect(result.tension).toBeCloseTo(Math.hypot(lift - weight, drag), 9);
        expect(result.points).toHaveLength(33);
        expect(result.points[0]).toEqual([0, 0]);
        expect(result.points[32][0]).toBeCloseTo(result.downwind, 9);
        expect(result.points[32][1]).toBeCloseTo(result.height, 9);
    });

    test("a strong wind takes the kite toward the angle of lift over drag, and never above it", () => {
        const limit = degrees(Math.atan2(properties.liftCoefficient, properties.dragCoefficient));
        let last = 0;
        for (const windSpeed of [3, 5, 8, 15, 40]) {
            const angle = degrees(solveKiteLine({windSpeed, lineLength: 50, properties}).lineAngleAtKite);
            expect(angle).toBeGreaterThan(last); expect(angle).toBeLessThan(limit); last = angle;
        }
        expect(last).toBeGreaterThan(limit - 0.5);
    });

    test("a heavy line sags: lower kite, same length, flattest at the anchor", () => {
        const light = solveKiteLine({windSpeed: 8, lineLength: 200, properties});
        const heavy = solveKiteLine({windSpeed: 8, lineLength: 200, properties, lineMassPerMetre: 0.004, lineDiameter: 0.002});
        expect(heavy.height).toBeLessThan(light.height);
        expect(heavy.lineAngleAtKite).toBeCloseTo(light.lineAngleAtKite, 12);
        let length = 0;
        for (let point = 1; point < heavy.points.length; point++)
            length += Math.hypot(heavy.points[point][0] - heavy.points[point - 1][0], heavy.points[point][1] - heavy.points[point - 1][1]);
        expect(length).toBeCloseTo(200, 9);
        const slope = index => Math.atan2(heavy.points[index + 1][1] - heavy.points[index][1], heavy.points[index + 1][0] - heavy.points[index][0]);
        expect(slope(0)).toBeLessThan(slope(31));
        for (const [, height] of heavy.points) expect(height).toBeGreaterThanOrEqual(0);
    });

    test("an octopus kite flies lower than a delta in the same wind", () => {
        const line = shape => solveKiteLine({windSpeed: 8, lineLength: 100,
            properties: kiteFlightProperties(kites.find(item => item.parameters.kiteShape === shape).parameters)});
        expect(line("octopus").height).toBeLessThan(line("delta").height);
        expect(line("octopus").flying).toBe(true);
    });
});
