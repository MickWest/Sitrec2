import {Box3, Raycaster, Vector3} from "three";
import {buildAircraft, disposeAircraft} from "../tools/vehicles/aircraft.js";
import {DEFAULTS, PRESETS, normalizeParameters, parameterFile, readParameterFile} from "../tools/vehicles/parameters.js";

describe("Procedural aircraft", () => {
    test("presets have unique stable IDs and researched families carry manufacturer references", () => {
        expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
        expect(PRESETS.filter(p => p.category.startsWith("Boeing"))).toHaveLength(22);
        expect(PRESETS.filter(p => p.category.startsWith("Airbus"))).toHaveLength(17);
        for (const preset of PRESETS.filter(p => p.reference && !p.military)) {
            expect(new URL(preset.reference.source).hostname).toMatch(/^(www\.boeing\.com|www\.aircraft\.airbus\.com)$/);
            expect(preset.reference.description.length).toBeGreaterThan(15);
        }
    });

    test.each(PRESETS.filter(p => p.reference && !p.military).map(p => [p.id, p]))("%s matches its published length and span envelope", (_, preset) => {
        const model = buildAircraft(preset.parameters);
        expect(model.stats.size.z).toBeCloseTo(preset.reference.length, 2);
        expect(Math.abs(model.stats.wingspan - preset.reference.wingspan)).toBeLessThan(0.10);
        expect(Math.abs(model.stats.size.x - preset.reference.wingspan)).toBeLessThan(0.10);
        disposeAircraft(model.root);
    });

    test("military catalog covers every region and major role with explicit references", () => {
        const military = PRESETS.filter(p => p.military);
        for (const region of ["US", "Europe", "China", "Iran", "Russia"]) {
            const items = military.filter(p => p.region === region);
            expect(items.length).toBeGreaterThanOrEqual(15);
            for (const role of ["Fighter", "Transport", "Trainer", "Helicopter", "Drone"])
                expect(items.some(p => p.role.includes(role))).toBe(true);
        }
        for (const p of military) {
            expect(new URL(p.reference.source).protocol).toBe("https:");
            expect(p.reference.description.length).toBeGreaterThan(30);
            expect(p.reference.quality).toBeTruthy();
            if (p.role === "Drone") {
                expect(p.parameters.cockpit).toBe(false);
                expect(p.parameters.windows).toBe(false);
            }
        }
    });

    test("rotor arrangements, glazing and mission shapes distinguish military families", () => {
        const model = id => buildAircraft(PRESETS.find(p => p.id === `mil-${id}`).parameters);
        const blackhawk = model("uh60"), chinook = model("ch47"), kamov = model("ka52"), osprey = model("v22");
        expect(blackhawk.root.getObjectByName("Wing 1")).toBeUndefined();
        expect(blackhawk.root.getObjectByName("Tail rotor")).toBeDefined();
        expect(blackhawk.propellers.every(p => p.userData.spinAxis === "y")).toBe(true);
        expect(chinook.propellers.filter(p => p.name === "Main rotor")).toHaveLength(2);
        expect(chinook.root.getObjectByName("Tail rotor")).toBeUndefined();
        expect(kamov.root.getObjectByName("Upper coaxial rotor")).toBeDefined();
        expect(kamov.root.getObjectByName("Tail rotor")).toBeUndefined();
        const aftKamov = buildAircraft({...PRESETS.find(p => p.id === "mil-ka52").parameters, rotorPosition: 65});
        for (const aircraft of [kamov, aftKamov]) expect(aircraft.root.getObjectByName("Main rotor").userData.spinDirection)
            .toBe(-aircraft.root.getObjectByName("Upper coaxial rotor").userData.spinDirection);
        expect(osprey.root.getObjectByName("Tilt nacelle 1")).toBeDefined();
        const bomber = model("b2"), hercules = model("c130h"), il76 = model("il76"), f16 = model("f16c"), f15 = model("f15e"), e2 = model("e2d");
        expect(bomber.root.children.some(p => p.name.startsWith("Vertical fin"))).toBe(false);
        expect(bomber.stats.size.x).toBeCloseTo(52.43, 2);
        expect(hercules.root.children.filter(p => p.name.startsWith("Windshield"))).toHaveLength(6);
        expect(il76.root.children.filter(p => p.name.startsWith("Lower nose glazing"))).toHaveLength(6);
        expect(f16.root.getObjectByName("Canopy frame")).toBeUndefined();
        expect(f15.root.getObjectByName("Canopy frame")).toBeDefined();
        expect(e2.root.children.filter(p => p.name.startsWith("Vertical fin") && !p.name.endsWith("tip"))).toHaveLength(4);
        expect(e2.root.getObjectByName("Radar fairing")).toBeDefined();
        for (const aircraft of [blackhawk, chinook, kamov, aftKamov, osprey, bomber, hercules, il76, f16, f15, e2]) disposeAircraft(aircraft.root);
    });

    test("new configuration controls survive JSON save and restore", () => {
        const p = normalizeParameters({rotorLayout: "tiltrotor", rotorTilt: 72, canopyFrame: "tandem", navigatorWindows: true,
            engineCount: 8, engineMount: "paired", radarStyle: "disc", windowShape: "round", tailStyle: "boom"});
        expect(readParameterFile(parameterFile(p)).parameters).toEqual(p);
    });

    test.each([
        ["mil-j20", {}], ["mil-f35a", {}], ["mil-su35", {}], ["mil-mig21", {}],
        ["mil-e2d", {}], ["mil-mohajer6", {}], ["737", {}],
        ["mil-j20", {diameter: 0.8, bodyHeight: 0.35, tailRadius: 0, tailLength: 45, tailPosition: 96, tailSpan: 12, finCant: 40}],
        ["mil-j20", {diameter: 5, tailRadius: 75, tailPosition: 66, finChord: 7, engineDiameter: 0.3, engineLength: 0.3}],
        ["mil-j20", {length: 8, engineCount: 4, engineDiameter: 3, engineLength: 9, intakeStyle: "chin"}],
        ["mil-f35a", {engineCount: 8, engineDiameter: 0.8, intakeStyle: "top"}],
    ])("%s keeps fin, intake and exhaust joints closed after edits %j", (id, changes) => {
        const aircraft = buildAircraft({...PRESETS.find(p => p.id === id).parameters, ...changes});
        const hull = aircraft.root.getObjectByName("Fuselage"), ray = new Raycaster();
        const point = (mesh, index) => new Vector3().fromBufferAttribute(mesh.geometry.attributes.position, index);
        const embedded = vertex => {
            // Test against the actual rendered triangles, not the same analytic
            // radius used by the generator or overlapping bounding boxes.
            for (const direction of [1, -1]) {
                ray.set(new Vector3(vertex.x, direction * 100, vertex.z), new Vector3(0, -direction, 0));
                const hit = ray.intersectObject(hull, false)[0];
                expect(hit).toBeDefined();
                expect(direction * (hit.point.y - vertex.y)).toBeGreaterThanOrEqual(-0.0001);
            }
        };
        for (const fin of aircraft.root.children.filter(m => /^Vertical fin [-\d.]+$/.test(m.name))) {
            const fairing = aircraft.root.getObjectByName(`Root fairing · ${fin.name}`);
            for (let i = 0; i <= 40; i++) {
                embedded(point(fairing ?? fin, i));
                if (fairing) expect(point(fin, i).distanceTo(point(fairing, 4 * 41 + i))).toBeLessThan(0.00001);
            }
        }
        for (const fairing of aircraft.root.children.filter(m => /^Engine fairing \d+$/.test(m.name))) {
            const index = fairing.name.split(" ").at(-1), nozzle = aircraft.root.getObjectByName(`Integrated exhaust ${index}`);
            for (let i = 0; i <= 32; i++) {
                embedded(point(fairing, i));
                expect(point(fairing, 24 * 33 + i).distanceTo(point(nozzle, i))).toBeLessThan(0.00001);
            }
        }
        for (const intake of aircraft.root.children.filter(m => m.name.startsWith("Intake fairing ")))
            for (let i = 0; i <= 32; i++) embedded(point(intake, 16 * 33 + i));
        disposeAircraft(aircraft.root);
    });

    test("transport and helicopter windscreens honor every pane-count setting", () => {
        for (const cockpitStyle of ["transport", "helicopter"]) for (const cockpitPanes of [2, 4, 6, 8]) {
            const aircraft = buildAircraft({...DEFAULTS, cockpitStyle, cockpitPanes});
            expect(aircraft.root.children.filter(p => p.name.startsWith("Windshield"))).toHaveLength(cockpitPanes);
            disposeAircraft(aircraft.root);
        }
    });

    test("airliner variants retain nose size while deck and tip geometry distinguish the families", () => {
        const preset = id => PRESETS.find(p => p.id === id).parameters;
        expect(preset("787-10").length * preset("787-10").noseLength / 100)
            .toBeCloseTo(preset("787-8").length * preset("787-8").noseLength / 100, 3);
        const jumbo = buildAircraft(preset("747")), flat = buildAircraft({...preset("747"), upperDeckRise: 0});
        const crown = model => new Box3().setFromObject(model.root.getObjectByName("Fuselage")).max.y;
        expect(crown(jumbo) - crown(flat)).toBeGreaterThan(1.5);
        const upper = jumbo.root.children.filter(p => p.name.startsWith("Upper window 1 "));
        expect(upper).toHaveLength(23);
        expect(Math.min(...upper.map(p => new Box3().setFromObject(p).min.z))).toBeGreaterThan(0);
        const dreamliner = buildAircraft(preset("787")), max = buildAircraft(preset("737-max-8")), airbus = buildAircraft(preset("a350-900"));
        expect(dreamliner.root.children.filter(p => p.name.startsWith("Windshield "))).toHaveLength(4);
        expect(dreamliner.root.getObjectByName("Raked tip 1")).toBeDefined();
        expect(max.root.getObjectByName("Lower winglet 1")).toBeDefined();
        expect(airbus.root.getObjectByName("Cockpit mask 0 1")).toBeDefined();
        for (const model of [jumbo, flat, dreamliner, max, airbus]) disposeAircraft(model.root);
    });

    test.each(PRESETS.map(preset => [preset.id, preset]))("%s builds finite, bounded exportable geometry", (_, preset) => {
        const model = buildAircraft(preset.parameters);
        expect(model.stats.triangles).toBeGreaterThan(5000);
        expect(model.stats.triangles).toBeLessThan(100000);
        expect(model.bounds.isEmpty()).toBe(false);
        model.root.traverse(object => {
            if (!object.isMesh) return;
            const geometry = object.geometry;
            for (const attribute of [geometry.attributes.position, geometry.attributes.normal]) {
                expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
            }
            if (geometry.index) expect(Math.max(...geometry.index.array)).toBeLessThan(geometry.attributes.position.count);
            else expect(geometry.attributes.position.count % 3).toBe(0);
        });
        const bodyBounds = new Box3().setFromObject(model.root.getObjectByName("Fuselage"));
        expect(bodyBounds.getSize(new Vector3()).z).toBeCloseTo(preset.parameters.length, 4);
        expect(model.stats.size.x).toBeGreaterThanOrEqual(preset.parameters.span - 0.001);
        expect(model.root.children.some(object => object.isLight || object.isCamera)).toBe(false);
        disposeAircraft(model.root);
    });

    test("wing changes affect symmetric tips and leave the fuselage unchanged", () => {
        const base = buildAircraft({...DEFAULTS, winglet: 0, navLights: false});
        const changed = buildAircraft({...DEFAULTS, span: 45, dihedral: 12, sweep: 35, winglet: 0, navLights: false});
        const port = changed.root.getObjectByName("Wing 1").geometry.attributes.position;
        const starboard = changed.root.getObjectByName("Wing -1").geometry.attributes.position;
        for (let i = 0; i < port.count; i++) {
            expect(port.getX(i)).toBeCloseTo(-starboard.getX(i));
            expect(port.getY(i)).toBeCloseTo(starboard.getY(i));
            expect(port.getZ(i)).toBeCloseTo(starboard.getZ(i));
        }
        const tip = 10 * 41;
        expect(port.getX(tip)).toBeCloseTo(22.5);
        expect(port.getY(tip)).toBeGreaterThan(base.root.getObjectByName("Wing 1").geometry.attributes.position.getY(tip));
        expect(Array.from(changed.root.getObjectByName("Fuselage").geometry.attributes.position.array))
            .toEqual(Array.from(base.root.getObjectByName("Fuselage").geometry.attributes.position.array));
        disposeAircraft(base.root); disposeAircraft(changed.root);
    });

    test("engine counts, propellers, gear, canards and tail layouts change topology", () => {
        const model = buildAircraft({...DEFAULTS, engineType: "turboprop", engineCount: 4, canards: true, gear: true, tailStyle: "v"});
        expect(model.propellers).toHaveLength(4);
        expect(model.root.children.filter(object => /^Engine \d+$/.test(object.name))).toHaveLength(4);
        expect(model.root.getObjectByName("Canard 1")).toBeDefined();
        expect(model.root.getObjectByName("Port main gear tire")).toBeDefined();
        expect(model.root.getObjectByName("Vertical fin 1")).toBeUndefined();
        const glider = buildAircraft({...DEFAULTS, engineType: "none", gear: false, tailStyle: "twin"});
        expect(glider.propellers).toHaveLength(0);
        expect(glider.root.getObjectByName("Engine 1")).toBeUndefined();
        expect(glider.root.getObjectByName("Port main gear tire")).toBeUndefined();
        expect(glider.root.getObjectByName("Vertical fin -1")).toBeDefined();
        disposeAircraft(model.root); disposeAircraft(glider.root);
    });

    test("cockpit glazing moves forward independently and preserves saved controls", () => {
        const original = buildAircraft({...DEFAULTS, cockpitStyle: "windshield"});
        const parameters = {...DEFAULTS, cockpitStyle: "windshield", cockpitPosition: 45, cockpitWidth: 75, cockpitPanes: 4};
        const changed = buildAircraft(parameters);
        const windshieldBounds = root => {
            const bounds = new Box3();
            root.children.filter(object => object.name.startsWith("Windshield ")).forEach(object => bounds.expandByObject(object));
            return bounds;
        };
        const a = windshieldBounds(original.root), b = windshieldBounds(changed.root);
        expect(b.getCenter(new Vector3()).z).toBeGreaterThan(a.getCenter(new Vector3()).z);
        expect(b.getSize(new Vector3()).x).toBeLessThan(a.getSize(new Vector3()).x);
        expect(changed.root.children.filter(object => object.name.startsWith("Windshield "))).toHaveLength(4);
        expect(Array.from(changed.root.getObjectByName("Fuselage").geometry.attributes.position.array))
            .toEqual(Array.from(original.root.getObjectByName("Fuselage").geometry.attributes.position.array));
        expect(readParameterFile(parameterFile(parameters)).parameters).toEqual(parameters);
        disposeAircraft(original.root); disposeAircraft(changed.root);
    });

    test("old designs receive cockpit defaults and canopy controls change the raised surface", () => {
        const legacy = {...PRESETS.find(preset => preset.id === "fighter").parameters};
        for (const key of Object.keys(legacy)) if (key.startsWith("cockpit") && key !== "cockpit") delete legacy[key];
        const restored = normalizeParameters(legacy);
        expect(restored.cockpitPosition).toBe(95);
        const low = buildAircraft({...restored, canopyHeight: 0.2});
        const high = buildAircraft({...restored, canopyHeight: 1.1, cockpitPosition: 70});
        const lowBounds = new Box3().setFromObject(low.root.getObjectByName("Cockpit canopy"));
        const highBounds = new Box3().setFromObject(high.root.getObjectByName("Cockpit canopy"));
        expect(highBounds.max.y).toBeGreaterThan(lowBounds.max.y);
        expect(highBounds.getCenter(new Vector3()).z).toBeGreaterThan(lowBounds.getCenter(new Vector3()).z);
        disposeAircraft(low.root); disposeAircraft(high.root);
    });

    test("parameter files round-trip and reject unsupported documents", () => {
        const file = parameterFile({...PRESETS[10].parameters, dihedral: 8.5}, "Test aircraft");
        expect(readParameterFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
        expect(() => readParameterFile({version: 2})).toThrow();
        expect(() => readParameterFile({...file, parameters: []})).toThrow();
        const p = normalizeParameters({length: -1, span: Infinity, propBlades: 3.8, engineCount: "4", bodyColor: "bad", gear: "false", engineType: "bad"});
        expect(p.length).toBe(3); expect(p.span).toBe(DEFAULTS.span); expect(p.propBlades).toBe(4);
        expect(p.engineCount).toBe(4); expect(p.bodyColor).toBe(DEFAULTS.bodyColor); expect(p.gear).toBe(false);
        expect(p.engineType).toBe(DEFAULTS.engineType);
    });

    test("737-800 reference has the calibrated envelope and a low six-pane windscreen", () => {
        const preset = PRESETS.find(preset => preset.id === "737");
        const model = buildAircraft(preset.parameters);
        expect(model.stats.size.z).toBeCloseTo(39.47, 2);
        expect(model.stats.wingspan).toBeCloseTo(35.79, 1);
        const glazing = model.root.children.filter(object => object.name.startsWith("Windshield "));
        expect(glazing).toHaveLength(6);
        for (const pane of glazing) {
            const box = new Box3().setFromObject(pane);
            expect(box.min.y).toBeGreaterThan(0.4);
            expect(box.max.y).toBeLessThan(1.5);
        }
        expect(model.root.getObjectByName("Blended winglet 1")).toBeDefined();
        expect(model.root.getObjectByName("Forward door outline 1")).toBeDefined();
        expect(model.root.getObjectByName("Airline wordmark -1")).toBeDefined();
        const windows = model.root.children.filter(object => object.name.startsWith("Cabin window 1 "));
        expect(windows.length).toBeGreaterThanOrEqual(40);
        const heights = windows.map(object => new Box3().setFromObject(object).getCenter(new Vector3()).y);
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.03);
        disposeAircraft(model.root);
    });

    test.each([
        {},
        {cockpitPosition: 48, cockpitHeight: 0.7, cockpitWidth: 80, cockpitSetback: 6},
        {cockpitPosition: 75, cockpitHeight: 1.2, cockpitSetback: 20},
    ])("airliner panes stay in a continuous band as the glazing changes: %j", changes => {
        const parameters = {...PRESETS.find(preset => preset.id === "737").parameters, ...changes};
        function gaps(pillar) {
            const model = buildAircraft({...parameters, cockpitPillar: pillar});
            const distances = [];
            for (const side of [1, -1]) for (const [left, right] of [["front", "side"], ["side", "aft"]]) {
                const a = model.root.getObjectByName(`Windshield ${left} ${side}`).geometry.attributes.position;
                const b = model.root.getObjectByName(`Windshield ${right} ${side}`).geometry.attributes.position;
                const edgePoints = Math.sqrt(a.count);
                for (let i = 0; i < edgePoints; i++) {
                    const start = new Vector3().fromBufferAttribute(a, a.count - edgePoints + i);
                    const end = new Vector3().fromBufferAttribute(b, i);
                    distances.push(start.distanceTo(end));
                }
            }
            disposeAircraft(model.root);
            return distances;
        }
        const thin = gaps(0.5), normal = gaps(5);
        expect(Math.max(...thin)).toBeLessThan(0.012);
        expect(Math.max(...normal)).toBeLessThan(0.10);
        normal.forEach((distance, i) => expect(distance).toBeGreaterThan(thin[i] * 5));
    });

    test("replacing an aircraft disposes its shared GPU resources once", () => {
        const model = buildAircraft(DEFAULTS), geometries = new Set(), materials = new Set();
        model.root.traverse(object => {
            if (object.geometry) geometries.add(object.geometry);
            for (const mat of Array.isArray(object.material) ? object.material : [object.material]) if (mat) materials.add(mat);
        });
        const spies = [...geometries, ...materials].map(resource => jest.spyOn(resource, "dispose"));
        disposeAircraft(model.root);
        spies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    });
});
