// Public-reference visual models. Dimensions describe the selected configuration,
// not an assertion about fleet status. Fine contours remain editable estimates.
import {AIRLINER_PRESETS} from "./airlinerPresets.js";

const B = "https://www.boeing.com/defense/";
const LM = "https://www.lockheedmartin.com/en-us/products/";
const UAC = "https://uacrussia.ru/en/aircraft/lineup/";
const AIRBUS = "https://www.airbus.com/en/products-services/";
const china = "https://eng.mod.gov.cn/xb/News_213114/Features/16241501.html";
const china20 = "https://eng.mod.gov.cn/2025xb/H_251589/F/16478359.html";
const iran = "https://iranpress.ir/content/14903/iran-army-unveils-yasin-jet-trainer";
const russianRotors = "https://rostec.ru/en/media/news/russian-helicopters-to-present-a-wide-range-of-military-rotorcraft-at-the-army-2021-forum/";
const museum = "https://www.rafmuseum.org.uk/london/things-to-see-and-do/on-display/";
const gray = {livery: "solid", bodyColor: "#7d8587", wingColor: "#7d8587", engineColor: "#6e7779", accentColor: "#596668", roughness: 0.7,
    windows: false, windowCount: 0, doors: false, winglet: 0, navLights: true};
const fighter = { ...gray, bodyStyle: "jet", noseProfile: "smooth", diameter: 1.65, bodyHeight: 0.85, noseLength: 29, tailLength: 22, tailRadius: 40,
    cockpitStyle: "canopy", cockpitPosition: 76, cockpitLength: 43, cockpitWidth: 60, canopyHeight: 0.48, canopyFrame: "front", cockpitPillar: 3,
    taper: 0.23, sweep: 40, dihedral: 0, wingPosition: 49, wingHeight: -0.12, thickness: 5, twist: 0,
    tailStyle: "conventional", tailSweep: 37, finSweep: 36, finCant: 0, engineMount: "integrated", engineCount: 1, engineType: "jet", intakeStyle: "side"};
const twin = {...fighter, diameter: 2.1, bodyHeight: 0.72, tailStyle: "twin", engineCount: 2, finCant: 12, cockpitWidth: 45};
const delta = {...fighter, tailStyle: "none", canards: true, sweep: 55, taper: 0.07, wingPosition: 52};
const trainer = {...fighter, cockpitPosition: 85, cockpitLength: 72, canopyFrame: "tandem", canopyHeight: 0.65, sweep: 24, taper: 0.4, intakeStyle: "side"};
const transport = {...gray, bodyStyle: "transport", diameter: 4, bodyHeight: 1.1, noseLength: 17, tailLength: 28,
    cockpitStyle: "transport", cockpitPosition: 60, cockpitLength: 30, cockpitWidth: 96, cockpitHeight: 0.9, cockpitPillar: 7,
    sweep: 20, taper: 0.35, dihedral: -2, wingPosition: 40, wingHeight: 0.75, thickness: 12, twist: -2, tailStyle: "t",
    tailSweep: 26, finSweep: 32, engineType: "jet", engineCount: 4, engineMount: "wing", engineSpacing: 31, engineOffset: 0.8,
    windowShape: "round", windowWidth: 0.35, windowHeight: 0.35, windowStart: 27, windowEnd: 70, windowLevel: 0.05};
const propTransport = {...transport, engineType: "turboprop", tailStyle: "conventional", sweep: 4, taper: 0.45, engineDiameter: 1.2,
    engineLength: 3.3, engineDrop: 0.15, propDiameter: 4.1, propBlades: 6, cockpitPanes: 6, cockpitEyebrows: true};
const helicopter = {...gray, bodyStyle: "helicopter", diameter: 2.4, bodyHeight: 1.05, noseLength: 21, tailLength: 25,
    cockpitStyle: "helicopter", cockpitPanes: 4, cockpitPosition: 65, cockpitLength: 37, cockpitWidth: 98, cockpitHeight: 1, cockpitPillar: 6,
    wings: false, span: 3, sweep: 0, wingHeight: -0.1, wingPosition: 40, taper: 0.75, dihedral: 0,
    tailStyle: "conventional", tailSweep: 12, finSweep: 28, tailPosition: 88,
    engineType: "jet", engineMount: "top", engineCount: 2, engineDiameter: 0.7, engineLength: 2,
    rotorLayout: "single", rotorPosition: 35, rotorHeight: 0.65, rotorBlades: 4,
    windows: true, windowCount: 3, windowStart: 25, windowEnd: 46, windowWidth: 0.65, windowHeight: 0.65, windowLevel: 0.2, windowShape: "square",
    gear: true, gearHeight: 0.6};
const attackHelicopter = {...helicopter, diameter: 1.35, bodyHeight: 1.6, cockpitStyle: "canopy", cockpitPosition: 85, cockpitLength: 95,
    cockpitWidth: 87, canopyHeight: 0.65, canopyFrame: "tandem", cockpitPillar: 6, windows: false, windowCount: 0,
    wings: true, span: 5, sensorTurret: true};
const drone = {...gray, bodyStyle: "glider", diameter: 0.9, bodyHeight: 1.15, noseLength: 19, tailLength: 29,
    cockpit: false, windows: false, sweep: 4, taper: 0.38, wingPosition: 40, wingHeight: 0.25, dihedral: 2, thickness: 12,
    tailStyle: "v", tailSweep: 18, engineType: "prop", engineCount: 1, engineMount: "pusher", engineDiameter: 0.6, engineLength: 1.1,
    propDiameter: 1.8, propBlades: 3, sensorTurret: true};
const wing = {...gray, bodyStyle: "flyingwing", diameter: 3, bodyHeight: 0.4, noseLength: 26, tailLength: 45, wings: true,
    wingPlanform: "flying", wingHeight: 0, thickness: 8, tailStyle: "tailless", engineType: "none", cockpit: false, sensorTurret: false};

const catalog = [];
function add(region, role, id, name, length, span, base, source, description, changes = {}, dimensions = "Reference dimensions") {
    const rotor = (changes.rotorLayout ?? base.rotorLayout ?? "none") !== "none";
    const p = {rootChord: length * 0.25, tailSpan: span * 0.40, tailChord: length * 0.13,
        finHeight: length * 0.16, finChord: length * 0.18, engineDiameter: length * 0.075, engineLength: length * 0.16,
        canardSpan: span * 0.44, ...(rotor ? {tailSpan: (changes.rotorDiameter ?? base.rotorDiameter ?? 16) * 0.25, tailChord: length * 0.06, finHeight: length * 0.09, finChord: length * 0.10} : {}), ...base, ...changes, length, span};
    // Keep swept tails inside the stated fuselage length. Other controls remain
    // independent; rotors and deployed gear can extend the overall envelope.
    const finSweep = Math.tan((p.finSweep ?? 36) * Math.PI / 180) * p.finHeight;
    const tailReach = Math.max(p.tailChord * 0.75,
        Math.tan((p.tailSweep ?? 32) * Math.PI / 180) * p.tailSpan / 2 + p.tailChord * 0.15);
    const reach = Math.max(finSweep + p.finChord * 0.05, tailReach + (p.tailStyle === "t" ? finSweep : 0));
    p.tailPosition = Math.min(p.tailPosition ?? 85, 100 * (1 - (reach + 0.15) / length));
    for (const key of Object.keys(p)) if (typeof p[key] === "number") p[key] = Math.round(p[key] * 10000) / 10000;
    const item = {id: `mil-${id}`, name, category: `${region} · ${role}`, region, role, military: true, parameters: p,
        reference: {length, wingspan: rotor ? p.rotorDiameter : span + 2 * (p.winglet ?? 0) * (p.wingletStyle === "raked" ? 1 : Math.tan((p.wingletCant ?? 0) * Math.PI / 180)), spanLabel: rotor ? "rotor diameter" : "span",
            lengthLabel: rotor ? "fuselage" : "length", quality: dimensions, source, description}};
    catalog.push(item); return item;
}
function derivative(region, role, id, name, parent, source, description, changes = {}, dimensions) {
    const original = catalog.find(item => item.id === `mil-${parent}`);
    return add(region, role, id, name, original.parameters.length, original.parameters.span, original.parameters, source, description, changes, dimensions ?? original.reference.quality);
}
function airliner(region, role, id, name, parent, source, description, changes = {}) {
    const original = AIRLINER_PRESETS.find(item => item.id === parent);
    return add(region, role, id, name, changes.length ?? original.reference.length, changes.span ?? original.parameters.span,
        {...original.parameters, ...gray, winglet: original.parameters.winglet}, source, description, changes);
}
const estimated = "Approximate dimensions · visual reference";

// United States: current and familiar Cold War families, including naval types.
add("US", "Fighter / attack", "f14", "F-14A Tomcat · wings forward", 19.1, 19.55, twin,
    "https://airandspace.si.edu/collection-objects/grumman-f-14dr-tomcat/nasm_A20040156000", "Long tandem canopy with a separate windscreen; broad wing gloves. Wings shown forward.",
    {canopyFrame: "tandem", cockpitLength: 62, sweep: 20, rootChord: 4.6, wingGlove: 7, finCant: 5});
add("US", "Fighter / attack", "f15c", "F-15C Eagle", 19.4, 13.05, twin, B + "fighters-and-bombers/f-15ex-eagle",
    "Single-seat raised canopy, twin upright fins and paired side intakes.", {finCant: 0, rootChord: 5.5, cockpitLength: 42});
derivative("US", "Fighter / attack", "f15e", "F-15E Strike Eagle", "f15c", B + "fighters-and-bombers/f-15ex-eagle",
    "Longer tandem glazing with windscreen and center bow.", {canopyFrame: "tandem", cockpitLength: 67, bodyColor: "#59656c", wingColor: "#59656c"});
derivative("US", "Fighter / attack", "f15ex", "F-15EX Eagle II", "f15e", B + "fighters-and-bombers/f-15ex-eagle", "Two-seat canopy; broad swept wings and upright twin fins.");
add("US", "Fighter / attack", "f16c", "F-16C Fighting Falcon", 15.06, 9.96, fighter, LM + "f-16.html",
    "Single bubble canopy without a forward bow; chin intake and one exhaust.", {canopyFrame: "none", cockpitWidth: 65, intakeStyle: "chin", wingGlove: 2.2, sweep: 40, rootChord: 4.4});
add("US", "Fighter / attack", "fa18c", "F/A-18C Hornet", 17.07, 11.43, twin, B + "fighters-and-bombers/fa-18-super-hornet-and-ea-18-growler",
    "Single canopy with windscreen bow, prominent root extensions and canted fins.", {wingGlove: 5.0, rootChord: 4.3, sweep: 26, finCant: 20});
add("US", "Fighter / attack", "fa18e", "F/A-18E Super Hornet", 18.31, 13.62, twin, B + "fighters-and-bombers/fa-18-super-hornet-and-ea-18-growler",
    "Larger Hornet airframe; one-seat canopy, side intakes and canted twin fins.", {wingGlove: 5.8, rootChord: 5, sweep: 28, finCant: 20});
derivative("US", "Fighter / attack", "ea18g", "EA-18G Growler · electronic warfare", "fa18e", B + "fighters-and-bombers/fa-18-super-hornet-and-ea-18-growler",
    "Tandem cockpit with center canopy bow; external mission pods are omitted.", {canopyFrame: "tandem", cockpitLength: 66});
add("US", "Fighter / attack", "f22", "F-22A Raptor", 18.90, 13.56, twin, LM + "f-22.html",
    "Single continuous canopy, broad trapezoidal wings and outward-canted fins. Exhausts simplified.", {canopyFrame: "none", sweep: 42, rootChord: 7.4, taper: 0.2, finCant: 28, diameter: 2.8, bodyHeight: 0.53, cockpitWidth: 38});
for (const [variant, length, span] of [["A", 15.7, 10.7], ["B", 15.6, 10.7], ["C", 15.7, 13.1]]) add("US", "Fighter / attack", `f35${variant.toLowerCase()}`, `F-35${variant} Lightning II`, length, span,
    {...twin, engineCount: 1}, "https://www.lockheedmartin.com/f35/mediakit.html", "Unbroken single-seat canopy, canted twin fins and broad center body; doors closed.",
    {canopyFrame: "none", diameter: 2.5, bodyHeight: 0.68, cockpitWidth: 45, rootChord: 5.7, sweep: 35, finCant: 25, tailSpan: variant === "C" ? 8.02 : 6.86, engineDiameter: 1.25});
add("US", "Fighter / attack", "a10", "A-10C Thunderbolt II", 16.26, 17.53, fighter, "https://museumofaviation.org/portfolio/a-10a-thunderbolt-ii/",
    "Framed single-seat canopy; straight wing, high rear engines and twin fins.", {engineMount: "rear", engineCount: 2, intakeStyle: "none", engineDiameter: 1.35, engineLength: 3.1, rootChord: 3.2, sweep: 2, taper: 0.6, tailStyle: "twin", finCant: 0, noseLength: 22, cockpitPosition: 80, tailRadius: 0});
add("US", "Fighter / attack", "f4", "F-4E Phantom II", 19.2, 11.71, {...fighter, engineCount: 2},
    "https://airandspace.si.edu/collection-objects/mcdonnell-f-4s-phantom-ii/nasm_A19890038000", "Two heavily framed tandem canopies; side intakes. E-model nose is approximate.",
    {canopyFrame: "tandem", cockpitLength: 63, sweep: 45, rootChord: 5.5, diameter: 1.9}, estimated);
add("US", "Fighter / attack", "f5e", "F-5E Tiger II", 14.68, 8.13, {...fighter, engineCount: 2},
    "https://www.northropgrumman.com/what-we-do/aircraft/f5-tiger", "Narrow single-seat canopy, small swept wings and twin exhausts.", {diameter: 1.2, engineDiameter: 0.55, rootChord: 3.3, sweep: 32, canopyHeight: 0.65});
add("US", "Bomber", "b1b", "B-1B Lancer · wings forward", 44.5, 41.8, {...transport, bodyStyle: "jet"}, B + "fighters-and-bombers/b-1-lancer",
    "Small framed flight-deck glazing; slender body and paired engines. Forward wing configuration.", {diameter: 3.1, noseLength: 27, cockpitStyle: "airliner4", cockpitPosition: 68, cockpitLength: 18, cockpitWidth: 80, cockpitHeight: 0.8, sweep: 20, rootChord: 7, wingPosition: 47, wingGlove: 11, wingHeight: -0.15, tailStyle: "conventional", engineMount: "paired", engineDiameter: 1.5, engineLength: 5});
add("US", "Bomber", "b2", "B-2A Spirit", 21.03, 52.43, wing, "https://www.northropgrumman.com/what-we-do/aircraft/b-2-stealth-bomber/technical-details",
    "Flying wing without fins; four small cockpit panes and a notched trailing edge.", {diameter: 4.6, bodyHeight: 0.45, cockpit: true, cockpitStyle: "airliner4", noseProfile: "airliner", cockpitLength: 26, cockpitWidth: 88});
add("US", "Bomber", "b52h", "B-52H Stratofortress", 48.6, 56.4, transport, B + "fighters-and-bombers/b-52",
    "Raised framed flight deck; eight engines in four paired pods and a single fin.", {diameter: 3.7, rootChord: 10, sweep: 35, dihedral: -3, engineMount: "paired", engineCount: 8, engineDiameter: 1.25, engineLength: 4.1, engineSpacing: 32, tailStyle: "conventional", cockpitHeight: 0.8});
add("US", "Transport", "c130h", "C-130H Hercules", 29.79, 40.41, propTransport, LM + "c130.html",
    "Tall wraparound flight deck, sparse round cabin windows and four-blade propellers.", {diameter: 4.0, rootChord: 5, propBlades: 4, windows: true, windowCount: 5, cockpitEyebrows: true});
add("US", "Transport", "c130j30", "C-130J-30 Super Hercules", 34.37, 40.38, propTransport, LM + "c130.html",
    "Stretched cabin, tall pilot windows and six-blade propellers; no airliner window row.", {diameter: 4, rootChord: 5.2, windows: true, windowCount: 6});
add("US", "Transport", "c17", "C-17A Globemaster III", 53, 51.8, transport, B + "tankers-and-transports/c-17-globemaster",
    "Broad four-pane flight deck, high swept wings, winglets and a T-tail.", {diameter: 6.9, bodyHeight: 0.95, cockpitStyle: "transport", cockpitPanes: 4, cockpitHeight: 0.72, rootChord: 11, winglet: 1.9, wingletCant: 0, engineDiameter: 2.3, engineLength: 4.5});
add("US", "Transport", "c5m", "C-5M Super Galaxy", 75.31, 67.89, transport, LM + "c-5.html",
    "High flight-deck band above the nose cargo door; high wing and large T-tail.", {diameter: 6.7, cockpitPosition: 80, cockpitHeight: 0.8, rootChord: 12.8, engineDiameter: 2.7, engineLength: 5.3});
add("US", "Tanker", "kc135", "KC-135R Stratotanker", 41.53, 39.88, transport, "https://www.boeing.com/content/dam/boeing/boeingdotcom/history/pdf/Boeing_Products.pdf",
    "Six-pane cockpit band, nearly blank cabin and an under-tail boom.", {diameter: 3.66, cockpitStyle: "airliner", sweep: 35, rootChord: 8, wingHeight: -0.5, tailStyle: "conventional", engineDiameter: 1.8, engineLength: 3.4, refuelBoom: true});
airliner("US", "Tanker", "kc46", "KC-46A Pegasus", "767-200er", B + "tankers-and-transports/kc-46-pegasus",
    "767-derived six-pane cockpit; cargo cabin without a passenger window row and a boom.", {refuelBoom: true, length: 50.5, span: 47.57});
add("US", "Patrol / AEW / reconnaissance", "e3", "E-3 Sentry", 46.61, 44.42, transport, B + "patrol-early-warning-and-battle-management",
    "707-family cockpit band and large elevated radar disc; sparse cabin glazing.", {diameter: 3.76, cockpitStyle: "airliner", wingHeight: -0.5, tailStyle: "conventional", sweep: 35, rootChord: 8.9, radarStyle: "disc", radarSize: 9.1, engineDiameter: 1.35});
airliner("US", "Patrol / AEW / reconnaissance", "e7", "E-7 Wedgetail", "737-700", B + "patrol-early-warning-and-battle-management/e-7-aewc",
    "737 cockpit band; dorsal radar beam and blank mission cabin.", {span: 35.8, radarStyle: "beam", radarSize: 10.8, winglet: 0});
add("US", "Patrol / AEW / reconnaissance", "e2d", "E-2D Advanced Hawkeye", 17.6, 24.56, propTransport,
    "https://www.northropgrumman.com/what-we-do/aircraft/e-2d-advanced-hawkeye", "Wraparound pilot windows, no cabin row, radar disc and four tail fins.",
    {diameter: 2.2, engineCount: 2, rootChord: 3.5, propDiameter: 4.11, propBlades: 8, radarStyle: "disc", radarSize: 7.3, tailStyle: "quad", tailSpan: 7.5, finHeight: 2.1, finCant: 0});
airliner("US", "Patrol / AEW / reconnaissance", "p8", "P-8A Poseidon", "737", B + "patrol-early-warning-and-battle-management/p-8-poseidon",
    "737 six-pane windshield, raked tips and sparse observation windows.", {span: 34.3, wingletStyle: "raked", winglet: 1.67, windows: true, windowCount: 3, windowWidth: 0.45, windowHeight: 0.55});
add("US", "Patrol / AEW / reconnaissance", "p3", "P-3C Orion", 35.61, 30.37, propTransport, LM + "p-3.html",
    "Framed flight deck and sparse observation windows; long tail boom.", {diameter: 3.4, wingHeight: -0.35, rootChord: 4.5, propBlades: 4, propDiameter: 4.1, windows: true, windowCount: 5});
add("US", "Patrol / AEW / reconnaissance", "u2", "U-2S Dragon Lady", 19.2, 31.39, fighter, LM + "u2-dragon-lady.html",
    "Small framed canopy on a very long-span reconnaissance airframe.", {diameter: 1.6, rootChord: 3.2, taper: 0.3, sweep: 3, engineDiameter: 1.2, wingPosition: 38, cockpitLength: 34});
add("US", "Trainer", "t38", "T-38C Talon", 14.14, 7.7, trainer, "https://www.northropgrumman.com/what-we-do/air/t-38-talon",
    "Two tandem canopy sections; slim body and small low wings.", {diameter: 1.1, engineCount: 2, engineDiameter: 0.55, rootChord: 3.1, sweep: 28});
add("US", "Trainer", "t6", "T-6A Texan II", 10.16, 10.19, trainer, "https://defense.txtav.com/en/t-6c",
    "Long framed tandem canopy and a nose-mounted four-blade propeller.", {engineType: "turboprop", engineMount: "nose", intakeStyle: "none", engineDiameter: 0.7, engineLength: 0.8, propDiameter: 2.44, propBlades: 4, sweep: 3, rootChord: 1.9, noseLength: 32, tailRadius: 0});
add("US", "Helicopter / tiltrotor", "uh60", "UH-60M Black Hawk", 15.27, 3, helicopter, LM + "sikorsky-black-hawk-helicopter.html",
    "Two broad forward windows plus tall pilot side windows; short cabin row. Fuselage length excludes rotor sweep.", {rotorDiameter: 16.36, rotorBlades: 4});
derivative("US", "Helicopter / tiltrotor", "mh60r", "MH-60R Seahawk", "uh60", LM + "sikorsky-mh-60-seahawk-helicopters.html", "Naval H-60 cabin glazing, four-blade rotor and under-nose sensor turret.", {sensorTurret: true, bodyColor: "#969c9f", wingColor: "#969c9f"});
add("US", "Helicopter / tiltrotor", "ah64", "AH-64E Apache", 14.68, 5.23, attackHelicopter, B + "military-rotorcraft/ah-64-apache",
    "Narrow tandem framed canopy, stub wings and four-blade main rotor.", {rotorDiameter: 14.63, rotorBlades: 4, rootChord: 1.2, engineDiameter: 0.8});
add("US", "Helicopter / tiltrotor", "ch47", "CH-47F Chinook", 15.46, 3, {...helicopter, bodyStyle: "transport"}, B + "military-rotorcraft/h-47-chinook",
    "Tall cockpit panes, round cabin portholes and tandem three-blade rotors; no tail rotor.", {rotorLayout: "tandem", rotorDiameter: 18.3, rotorBlades: 3, tailStyle: "tailless", diameter: 3.2, tailLength: 19, windowShape: "round", windowCount: 6, windowEnd: 77});
add("US", "Helicopter / tiltrotor", "ch53k", "CH-53K King Stallion", 22.3, 3, helicopter, LM + "sikorsky-ch-53k-helicopter.html",
    "Broad cockpit, sparse cabin windows and seven-blade rotor. Body dimensions are approximate.", {diameter: 4.1, rotorDiameter: 24.08, rotorBlades: 7, engineCount: 3, engineDiameter: 1.1, windowCount: 5}, estimated);
add("US", "Helicopter / tiltrotor", "ah1z", "AH-1Z Viper", 13.61, 3.28, attackHelicopter, "https://www.bellflight.com/products/h1",
    "Very narrow tandem canopy, four-blade rotor and landing skids.", {rotorDiameter: 14.63, diameter: 1.1, rotorBlades: 4, gearStyle: "skids", rootChord: 0.8});
add("US", "Helicopter / tiltrotor", "uh1y", "UH-1Y Venom", 13.63, 3, helicopter, "https://www.bellflight.com/products/h1",
    "Tall pilot panes, broad rectangular cabin windows, four-blade rotor and skids.", {rotorDiameter: 14.63, windowCount: 2, gearStyle: "skids", noseLength: 19});
add("US", "Helicopter / tiltrotor", "v22", "V-22 Osprey", 17.48, 13.97, transport, B + "military-rotorcraft/v-22-osprey",
    "Tall transport cockpit; three-blade tip rotors tilt live between hover and forward flight.", {diameter: 2.8, rotorLayout: "tiltrotor", rotorDiameter: 11.61, rotorBlades: 3, rotorTilt: 0, engineType: "none", engineDiameter: 1.25, engineLength: 3.2, rootChord: 2.8, sweep: 0, tailStyle: "twin", finCant: 0, finHeight: 2.1, tailSpan: 5.6});
add("US", "Drone", "mq9", "MQ-9A Reaper", 11, 20.12, drone, "https://www.ga-asi.com/remotely-piloted-aircraft/mq-9a",
    "No cockpit or cabin glazing; raised nose, sensor turret, V-tail and rear pusher.", {diameter: 1.1, rootChord: 1.8, propDiameter: 2.6});
add("US", "Drone", "rq4", "RQ-4B Global Hawk", 14.5, 39.9, drone, "https://www.northropgrumman.com/what-we-do/air/global-hawk",
    "Windowless bulbous nose, long narrow wings and a dorsal jet engine.", {diameter: 1.8, noseLength: 14, engineType: "jet", engineMount: "top", engineDiameter: 0.95, engineLength: 2.8, rootChord: 2.6, sweep: 8, sensorTurret: false});

// European designs, including shared multinational programmes.
add("Europe", "Fighter / attack", "typhoon", "Eurofighter Typhoon", 15.96, 10.95, {...delta, engineCount: 2},
    "https://world.eurofighter.com/the-aircraft/performance", "Single raised canopy, forward canards, delta wing and twin chin intakes.", {intakeStyle: "chin", rootChord: 7, diameter: 1.7, engineDiameter: 0.85, canardSpan: 5.4});
add("Europe", "Fighter / attack", "rafalec", "Dassault Rafale C", 15.3, 10.9, {...delta, engineCount: 2},
    "https://www.dassault-aviation.com/en/defense/rafale/specifications-and-performance-data/", "Single-seat framed canopy; close-coupled canards and low side intakes.", {rootChord: 7.6, diameter: 1.8, engineDiameter: 0.8, canardSpan: 5.1});
derivative("Europe", "Fighter / attack", "rafaleb", "Dassault Rafale B", "rafalec", "https://dassault-aviation.publispeak.com/2023-annual-report/doc/article/44/",
    "Two-seat Rafale with a longer tandem canopy and a center frame.", {cockpitLength: 68, canopyFrame: "tandem"});
add("Europe", "Fighter / attack", "mirage2000", "Mirage 2000-5", 14.3, 9.1, {...delta, canards: false},
    "https://dassault-aviation.publispeak.com/2023-annual-report/doc/article/44/", "Single framed canopy; pure delta, one fin and side intakes.", {rootChord: 7.5, sweep: 58, diameter: 1.5});
add("Europe", "Fighter / attack", "gripenc", "Saab Gripen C", 14.1, 8.4, delta, "https://www.saab.com/products/gripen-c-series",
    "Single-seat canopy with a front bow; canard delta and one exhaust.", {rootChord: 5.6, diameter: 1.4, canardSpan: 4.4});
add("Europe", "Fighter / attack", "gripene", "Saab Gripen E", 15.2, 8.6, delta, "https://www.saab.com/products/gripen-e-series",
    "Enlarged Gripen body, single-seat canopy and close-coupled canards.", {rootChord: 6.2, diameter: 1.6, canardSpan: 4.5});
add("Europe", "Fighter / attack", "tornado", "Panavia Tornado IDS · wings forward", 16.72, 13.91, {...trainer, engineCount: 2},
    "https://www.panavia.de/aircraft/", "Long tandem canopy with center bow; tall fin and forward-positioned swing wings.", {sweep: 25, rootChord: 4.2, wingGlove: 4.5, finHeight: 3.5, diameter: 1.8, engineDiameter: 0.85});
add("Europe", "Fighter / attack", "harrier", "Harrier GR9", 14.12, 9.25, fighter, "https://www.rafmuseum.org.uk/harrier-gr7/",
    "Raised canopy, high anhedral wing, broad side intakes and four vectoring side nozzles. GR7/9 family outline.", {rootChord: 3.8, sweep: 34, wingHeight: 0.7, dihedral: -8, tailDihedral: -12, canopyHeight: 0.8, diameter: 1.8, engineMount: "vectored", tailRadius: 0}, estimated);
add("Europe", "Fighter / attack", "jaguar", "SEPECAT Jaguar GR1", 16.83, 8.69, {...fighter, engineCount: 2},
    "https://www.rafmuseum.org.uk/blog/jaguar-the-accidental-cold-war-warrior/", "Short framed cockpit, narrow swept high wing and twin exhausts.", {wingHeight: 0.55, dihedral: -3, rootChord: 3.7, diameter: 1.45, engineDiameter: 0.65}, estimated);
add("Europe", "Transport", "a400m", "Airbus A400M Atlas", 45.1, 42.4, {...propTransport, tailStyle: "t"}, AIRBUS + "defence/military-aircraft/a400m",
    "Four broad cockpit panes; eight-blade propellers, high wing and T-tail.", {diameter: 5.64, rootChord: 9.5, sweep: 15, propDiameter: 5.33, propBlades: 8, cockpitPanes: 4, cockpitEyebrows: false, engineDiameter: 1.6, engineLength: 4.7});
add("Europe", "Transport", "c295", "Airbus C295", 24.5, 25.81, {...propTransport, engineCount: 2}, AIRBUS + "defence/military-aircraft/c295",
    "Tall flight-deck panes and sparse cabin portholes; six-blade props and high straight wing.", {diameter: 2.7, rootChord: 3.3, sweep: 2, windows: true, windowCount: 6, propDiameter: 3.89, engineDiameter: 0.95, finHeight: 3.4});
add("Europe", "Transport", "c27j", "Leonardo C-27J Spartan", 22.7, 28.7, {...propTransport, engineCount: 2},
    "https://aircraft.leonardo.com/products/c-27j-spartan-next-generation", "Wide cargo body and tall cockpit panes; sparse round cabin windows.", {diameter: 3.33, rootChord: 4.2, windows: true, windowCount: 4, propDiameter: 4.11});
airliner("Europe", "Tanker", "a330mrtt", "Airbus A330 MRTT", "a330-200", AIRBUS + "defence/military-aircraft/a330-mrtt",
    "A330 six-pane cockpit and retained passenger windows; refuelling boom configuration.", {windows: true, windowCount: 65, refuelBoom: true});
add("Europe", "Patrol / AEW / reconnaissance", "atlantic2", "Dassault Atlantique 2", 31.7, 37.5, {...propTransport, engineCount: 2},
    "https://dassault-aviation.publispeak.com/2023-annual-report/doc/article/44/", "Tall framed cockpit with lower nose glazing and sparse observation windows.", {diameter: 3.3, bodyHeight: 1.4, rootChord: 5.1, navigatorWindows: true, windows: true, windowCount: 4, propBlades: 4, propDiameter: 4.88});
add("Europe", "Patrol / AEW / reconnaissance", "globaleye", "Saab GlobalEye", 30.3, 28.7, {...transport, bodyStyle: "jet"},
    "https://www.saab.com/products/globaleye", "Business-jet cockpit and dorsal radar beam; sparse mission-cabin windows.", {diameter: 2.7, engineCount: 2, engineMount: "rear", cockpitStyle: "airliner4", wingHeight: -0.5, rootChord: 5, sweep: 33, radarStyle: "beam", radarSize: 9, engineDiameter: 1.25});
add("Europe", "Trainer", "hawk", "BAE Hawk T2", 12.43, 9.94, trainer, "https://www.raf.mod.uk/aircraft/hawk-t2/",
    "Long stepped tandem canopy with a center bow and raised rear seat position.", {diameter: 1.4, rootChord: 3.1, sweep: 28, canopyHeight: 0.8});
add("Europe", "Trainer", "m346", "Leonardo M-346", 11.49, 9.72, {...trainer, engineCount: 2},
    "https://aircraft.leonardo.com/en/products/m-346", "Long tandem glazing, side intakes and broad wing-root extensions.", {diameter: 1.6, engineDiameter: 0.7, rootChord: 3.6, wingGlove: 2.5});
add("Europe", "Trainer", "pc21", "Pilatus PC-21", 11.23, 9.11, trainer, "https://www.pilatus-aircraft.com/en/pc-21",
    "Long tandem bubble canopy, low tapered wings and a five-blade nose propeller.", {diameter: 1.15, engineType: "turboprop", engineMount: "nose", intakeStyle: "none", engineDiameter: 0.75, engineLength: 0.8, propDiameter: 2.39, propBlades: 5, rootChord: 1.9, sweep: 5, noseLength: 32, tailRadius: 0});
add("Europe", "Helicopter", "tiger", "Airbus Tiger", 13.85, 4.52, attackHelicopter, AIRBUS + "helicopters/military-helicopters/tiger",
    "Narrow stepped tandem canopy with heavy frames; four-blade rotor and stub wings.", {rotorDiameter: 13, rotorBlades: 4, rootChord: 1.05, diameter: 1.2});
add("Europe", "Helicopter", "nh90", "NHIndustries NH90 TTH", 16.13, 3, helicopter, "https://www.nhindustries.com/",
    "Broad angular pilot panes, rectangular cabin windows and four-blade rotor.", {diameter: 3, rotorDiameter: 16.3, windowCount: 3});
add("Europe", "Helicopter", "h225m", "Airbus H225M", 16.79, 3, helicopter, AIRBUS + "helicopters/military-helicopters/h225m/h225m-technical-information",
    "Tall divided cockpit glazing, cabin window row and five-blade rotor. Fuselage excludes rotor overhang.", {diameter: 2.9, rotorDiameter: 16.2, rotorBlades: 5, windowCount: 5}, estimated);
add("Europe", "Helicopter", "aw101", "Leonardo AW101 Merlin", 19.53, 3, helicopter, "https://helicopters.leonardo.com/en/products/aw101",
    "Large transport cockpit and five-blade rotor; sparse rectangular cabin windows.", {diameter: 3.3, rotorDiameter: 18.59, rotorBlades: 5, engineCount: 3, windowCount: 4}, estimated);
add("Europe", "Helicopter", "aw159", "Leonardo AW159 Wildcat", 13.49, 3, helicopter, "https://helicopters.leonardo.com/en/products/aw159",
    "Compact cabin with broad side windows, four-blade rotor and under-nose turret.", {diameter: 2.2, rotorDiameter: 12.8, windowCount: 2, sensorTurret: true}, estimated);
add("Europe", "Drone", "neuron", "Dassault nEUROn · demonstrator", 10, 12.5, wing,
    "https://www.dassault-aviation.com/en/defense/neuron/", "Windowless lambda wing and single upper intake. Demonstrator outline; rounded dimensions published by the manufacturer.", {flyingWingShape: "lambda", diameter: 2.2, engineType: "jet", engineMount: "integrated", engineCount: 1, intakeStyle: "top", engineDiameter: 0.65});

// Chinese domestic families. Many public releases provide photographs, but no
// engineering dimensions. Those entries explicitly retain an estimate label.
add("China", "Fighter / attack", "j7", "Chengdu J-7G", 14.88, 8.32, {...delta, canards: false}, china,
    "Framed canopy, narrow delta wing, separate tailplanes and circular nose intake; no cabin windows.", {diameter: 1.25, rootChord: 5.6, intakeStyle: "nose", sweep: 57, tailStyle: "conventional"}, estimated);
add("China", "Fighter / attack", "j8", "Shenyang J-8F", 21.59, 9.34, {...fighter, engineCount: 2}, china,
    "Long narrow fuselage, framed single canopy, side intakes and swept delta-like wing.", {diameter: 1.6, rootChord: 6.5, sweep: 59, taper: 0.08, engineDiameter: 0.85}, estimated);
add("China", "Fighter / attack", "j10c", "Chengdu J-10C", 16.9, 9.75, delta,
    "https://www.mod.gov.cn/gfbw/wzll/yw_214068/4830500.html", "Single bubble canopy, forward canards and a chin intake.", {intakeStyle: "chin", rootChord: 6.9, canopyFrame: "none", diameter: 1.7}, estimated);
add("China", "Fighter / attack", "j11b", "Shenyang J-11B", 21.9, 14.7, twin, china,
    "Flanker-family single canopy, long wing-root extensions and upright twin fins.", {diameter: 2.5, cockpitWidth: 43, wingGlove: 6.5, rootChord: 6.2, finCant: 0, engineDiameter: 1.25}, estimated);
derivative("China", "Fighter / attack", "j15", "Shenyang J-15", "j11b", china,
    "Carrier Flanker with forward canards and single-seat canopy; wings unfolded.", {canards: true, canardSpan: 6});
derivative("China", "Fighter / attack", "j16", "Shenyang J-16", "j11b", "https://www.mod.gov.cn/gfbw/wzll/yw_214068/4830500.html",
    "Two-seat Flanker-family canopy with a center bow and long root extensions.", {canopyFrame: "tandem", cockpitLength: 67});
add("China", "Fighter / attack", "j20", "Chengdu J-20", 20.4, 13.5, {...twin, canards: true},
    "https://www.mod.gov.cn/gfbw/wzll/yw_214068/4830500.html", "Long forebody, single continuous canopy, canards and canted twin fins; dimensions estimated.",
    {rootChord: 7, taper: 0.12, sweep: 48, diameter: 2.7, bodyHeight: 0.6, canopyFrame: "none", cockpitWidth: 40, canardSpan: 7, finCant: 26, tailStyle: "twinnone", tailSpan: 7, tailChord: 0.3}, estimated);
add("China", "Fighter / attack", "jh7a", "Xi’an JH-7A", 22.32, 12.8, {...trainer, engineCount: 2}, china,
    "Long tandem framed canopy, swept high wing and single fin.", {diameter: 1.9, rootChord: 5.1, sweep: 45, wingHeight: 0.6, engineDiameter: 1.1}, estimated);
add("China", "Fighter / attack", "jf17", "JF-17 Thunder · joint design", 14.33, 9.44, fighter, "https://www.pac.org.pk/jf-17",
    "Single framed canopy, diverterless side intakes and swept tapered wings.", {diameter: 1.45, rootChord: 3.9, wingGlove: 2.5, sweep: 40}, estimated);
add("China", "Bomber", "h6k", "Xi’an H-6K", 34.8, 33, transport, "https://eng.mod.gov.cn/xb/News_213114/Features/16233376.html",
    "Solid radar nose, compact flight deck and engines embedded at the wing roots; no glazed navigator nose on this K variant.", {diameter: 2.9, engineCount: 2, engineMount: "shoulder", intakeStyle: "none", engineDiameter: 1.5, engineLength: 6.4, engineOffset: 0, cockpitStyle: "airliner", noseLength: 24, cockpitPosition: 88, cockpitLength: 19, rootChord: 8, sweep: 37, tailStyle: "conventional", wingHeight: 0, navigatorWindows: false}, estimated);
add("China", "Transport", "y8", "Shaanxi Y-8", 34.02, 38, propTransport, china,
    "Older transport flight deck with lower navigator glazing and sparse portholes.", {diameter: 3.9, navigatorWindows: true, propBlades: 4, propDiameter: 4.5, rootChord: 5.5, windows: true, windowCount: 5}, estimated);
add("China", "Transport", "y9", "Shaanxi Y-9", 36.06, 38, propTransport, china,
    "Modern solid nose, tall flight deck and six-blade propellers; sparse cabin windows.", {diameter: 3.9, propBlades: 6, propDiameter: 4.5, rootChord: 5.5, windows: true, windowCount: 5}, estimated);
add("China", "Transport", "y20", "Xi’an Y-20", 47, 45, transport, china20,
    "Broad angular flight-deck windows; solid cargo cabin, high wing and T-tail.", {diameter: 5.5, rootChord: 10.5, engineDiameter: 2.4, engineLength: 4.6}, estimated);
derivative("China", "Tanker", "yy20", "Xi’an YY-20A tanker", "y20", china20,
    "Y-20 flight-deck glazing and transport outline; refuelling hose pods omitted.");
derivative("China", "Patrol / AEW / reconnaissance", "kj500", "KJ-500 airborne early warning", "y9", "https://eng.mod.gov.cn/2025xb/H_251589/F/16454974.html",
    "Y-9 cockpit, sparse mission windows and a broad dorsal radar disc.", {radarStyle: "disc", radarSize: 7, windows: false});
derivative("China", "Patrol / AEW / reconnaissance", "kj200", "KJ-200 airborne early warning", "y8", china,
    "Y-8-family cockpit with a long dorsal radar beam; window layout simplified.", {radarStyle: "beam", radarSize: 10, navigatorWindows: false});
add("China", "Trainer", "l15", "Hongdu L-15 / JL-10", 12.27, 9.48, {...trainer, engineCount: 2}, china,
    "Stepped tandem canopy, broad root extensions and twin rear exhausts.", {diameter: 1.55, engineDiameter: 0.7, rootChord: 3.6, wingGlove: 2.7}, estimated);
add("China", "Trainer", "k8", "Hongdu K-8 / JL-8", 11.6, 9.63, trainer, "https://www.pac.org.pk/k-8",
    "Long two-seat framed canopy, low straight tapered wing and side intakes.", {diameter: 1.25, rootChord: 2.6, sweep: 5}, estimated);
add("China", "Helicopter", "z10", "Changhe Z-10", 14.15, 4.6, attackHelicopter, china,
    "Narrow stepped tandem canopy, stub wings and a five-blade rotor.", {rotorDiameter: 13, rotorBlades: 5, diameter: 1.25, rootChord: 1.1}, estimated);
add("China", "Helicopter", "z19", "Harbin Z-19", 12, 3.8, attackHelicopter, china,
    "Tandem canopy, four-blade main rotor and an enclosed tail rotor.", {rotorDiameter: 11.9, rotorBlades: 4, tailRotorStyle: "ducted", tailRotorRatio: 10, diameter: 1.1, rootChord: 0.85}, estimated);
add("China", "Helicopter", "z20", "Harbin Z-20", 15.8, 3, helicopter,
    "https://www.xinhuanet.com/english/2019-10/19/c_138485818.htm", "Broad cabin with divided pilot windows and five-blade rotor.", {rotorDiameter: 16, rotorBlades: 5, diameter: 2.5}, estimated);
add("China", "Helicopter", "z8", "Changhe Z-8", 19.4, 3, helicopter, china,
    "Large transport cabin, broad pilot windows and six-blade rotor; boat hull simplified.", {rotorDiameter: 18.9, rotorBlades: 6, diameter: 3.4, engineCount: 3, windowCount: 5}, estimated);
add("China", "Drone", "wingloong2", "Wing Loong II", 11, 20.5, drone, "https://www.ecns.cn/2017/02-28/247122.shtml",
    "Windowless bulbous nose, V-tail, sensor turret and rear pusher propeller.", {diameter: 1.1, rootChord: 1.85, propDiameter: 2.5}, estimated);
add("China", "Drone", "ch4", "CASC CH-4", 8.5, 18, drone, china,
    "No glazing; long high-aspect wings, V-tail and a rear pusher.", {rootChord: 1.4, propDiameter: 1.9}, estimated);

// Russia and Soviet-origin families still familiar in modern service.
add("Russia", "Fighter / attack", "mig21", "MiG-21bis", 14.7, 7.15, {...delta, canards: false}, museum,
    "Small framed single-seat canopy, nose intake and narrow delta wing.", {diameter: 1.25, rootChord: 5.6, sweep: 57, intakeStyle: "nose", tailStyle: "conventional", engineDiameter: 0.9}, estimated);
add("Russia", "Fighter / attack", "mig23", "MiG-23ML · wings forward", 16.7, 13.97, fighter, museum,
    "Framed canopy and side intakes; variable wings shown forward.", {diameter: 1.65, sweep: 16, rootChord: 3.9, wingHeight: 0.6, wingGlove: 4.6}, estimated);
add("Russia", "Fighter / attack", "mig29", "MiG-29", 17.32, 11.36, twin, UAC + "military/mig-35/",
    "Single canopy with a front bow, root extensions, twin fins and twin exhausts.", {diameter: 2.0, rootChord: 4.8, wingGlove: 4.3, sweep: 42, finCant: 5, engineDiameter: 1.0}, estimated);
add("Russia", "Fighter / attack", "mig31", "MiG-31BM", 22.69, 13.46, {...twin, canopyFrame: "tandem"}, UAC + "military/",
    "Long tandem cockpit, high swept wings and large upright twin fins.", {diameter: 2.5, cockpitLength: 64, rootChord: 6, sweep: 41, wingHeight: 0.7, finCant: 0, engineDiameter: 1.3}, estimated);
add("Russia", "Fighter / attack", "su27", "Su-27S Flanker", 21.94, 14.7, twin, UAC + "military/su-35/",
    "Single framed canopy, wide engine spacing and long wing-root extensions.", {diameter: 2.5, rootChord: 6.1, wingGlove: 6, finCant: 0, engineDiameter: 1.3}, estimated);
derivative("Russia", "Fighter / attack", "su30", "Su-30SM", "su27", UAC + "military/su-30sm/",
    "Tandem canopy with center bow and forward canards.", {canopyFrame: "tandem", cockpitLength: 68, canards: true, canardSpan: 6});
derivative("Russia", "Fighter / attack", "su33", "Su-33 · wings unfolded", "su27", UAC + "military/",
    "Single-seat carrier Flanker with canards; wings and tailplanes unfolded.", {canards: true, canardSpan: 6});
add("Russia", "Fighter / attack", "su34", "Su-34", 23.34, 14.7, twin, UAC + "military/su-34/",
    "Wide side-by-side flight deck with framed front and side panes; flattened nose.", {diameter: 3, bodyHeight: 0.65, cockpitStyle: "transport", cockpitPosition: 79, cockpitLength: 23, cockpitHeight: 0.95, cockpitWidth: 92, noseLength: 27, noseProfile: "airliner", rootChord: 6.2, wingGlove: 6, canards: true, canardSpan: 6, finCant: 0, engineDiameter: 1.3});
add("Russia", "Fighter / attack", "su35", "Su-35S", 21.9, 14.75, twin, UAC + "military/su-35/",
    "Single-seat canopy, upright twin fins and no canards on this version.", {diameter: 2.5, rootChord: 6.1, wingGlove: 6.2, finCant: 0, engineDiameter: 1.3});
add("Russia", "Fighter / attack", "su57", "Su-57", 20.1, 14.1, twin, UAC + "military/su-57/",
    "Single framed canopy on a broad flattened body, canted fins and swept wings.", {diameter: 3, bodyHeight: 0.48, cockpitWidth: 35, rootChord: 7.5, wingGlove: 5, finCant: 25, engineDiameter: 1.25}, estimated);
add("Russia", "Fighter / attack", "su24", "Su-24M · wings forward", 22.53, 17.64, {...fighter, engineCount: 2}, UAC + "military/",
    "Wide side-by-side framed cockpit and high variable wing shown forward.", {diameter: 2.4, cockpitStyle: "transport", noseProfile: "airliner", cockpitPosition: 85, cockpitLength: 23, cockpitWidth: 92, sweep: 16, wingHeight: 0.6, rootChord: 4.7, wingGlove: 5, engineDiameter: 1.1}, estimated);
add("Russia", "Fighter / attack", "su25", "Su-25", 15.53, 14.36, fighter, UAC + "military/",
    "Small heavily framed canopy, high straight tapered wing and side engine housings.", {diameter: 1.6, rootChord: 3.9, sweep: 19, wingHeight: 0.45, engineCount: 2, engineDiameter: 0.85, cockpitLength: 36, canopyFrame: "front"}, estimated);
add("Russia", "Bomber", "tu160", "Tu-160 · wings forward", 54.1, 55.7, {...transport, bodyStyle: "jet"}, UAC + "strategic/tu-160/",
    "Small framed cockpit in a long pointed forebody; swing wings forward, paired engines.", {diameter: 4, noseLength: 28, cockpitStyle: "airliner4", cockpitPosition: 78, cockpitLength: 18, cockpitWidth: 82, rootChord: 8.8, sweep: 20, wingPosition: 48, wingGlove: 12, engineMount: "paired", engineDiameter: 1.6, engineLength: 6.5, tailStyle: "conventional", bodyColor: "#dddeda", wingColor: "#dddeda"}, estimated);
add("Russia", "Bomber", "tu95", "Tu-95MS Bear", 49.5, 50.04, propTransport, UAC + "strategic/tu-95ms/",
    "Compact framed cockpit, long swept wings and four sets of contra-rotating propellers.", {diameter: 2.9, rootChord: 8.5, sweep: 35, engineLength: 5, propDiameter: 5.6, propBlades: 4, contraProps: true, cockpitStyle: "airliner", cockpitPosition: 85, cockpitLength: 22, noseLength: 23}, estimated);
add("Russia", "Bomber", "tu22m3", "Tu-22M3 · wings forward", 42.46, 34.28, {...transport, bodyStyle: "jet"}, UAC + "strategic/tu-22m3/",
    "Compact side-by-side flight deck; pointed nose, large side intakes and forward swing wings.", {diameter: 3, noseLength: 29, cockpitStyle: "airliner", cockpitPosition: 80, cockpitLength: 19, sweep: 20, rootChord: 7, wingGlove: 10, tailStyle: "conventional", engineMount: "integrated", engineCount: 2, intakeStyle: "side", engineDiameter: 1.7}, estimated);
add("Russia", "Transport", "il76", "Il-76MD-90A", 46.59, 50.5, transport, UAC + "transport/il-76md-90a/",
    "Distinct lower navigator glazing under the pilot window band; high wing and T-tail.", {diameter: 4.8, navigatorWindows: true, rootChord: 9, engineDiameter: 1.9, engineLength: 4.7}, estimated);
derivative("Russia", "Tanker", "il78", "Il-78M tanker", "il76", UAC + "transport/il-76md-90a/",
    "Il-76-family pilot and lower navigator windows; hose pods omitted.");
derivative("Russia", "Patrol / AEW / reconnaissance", "a50", "Beriev A-50", "il76", UAC + "strategic/",
    "Il-76 glazing beneath a large dorsal radar disc; blank mission cabin.", {radarStyle: "disc", radarSize: 9});
add("Russia", "Transport", "an12", "Antonov An-12", 33.1, 38, propTransport, "https://www.antonov.com/en/history/an-12",
    "Tall pilot windows and lower navigator glazing; four-blade props. Soviet-origin Ukrainian design.", {diameter: 4.1, navigatorWindows: true, propBlades: 4, propDiameter: 4.5, rootChord: 5.5, windows: true, windowCount: 5}, estimated);
add("Russia", "Transport", "an26", "Antonov An-26", 23.8, 29.2, {...propTransport, engineCount: 2}, "https://www.antonov.com/en/history/an-26",
    "Wraparound cockpit with sparse circular cabin windows; Soviet-origin Ukrainian design.", {diameter: 2.8, rootChord: 4.1, propBlades: 4, propDiameter: 3.9, windows: true, windowCount: 6}, estimated);
add("Russia", "Transport", "an124", "Antonov An-124 Ruslan", 69.1, 73.3, transport, "https://www.antonov.com/en/history/an-124-ruslan",
    "High flight deck over a large cargo nose, high swept wings and a conventional low tailplane; Soviet-origin Ukrainian design.", {diameter: 7.3, cockpitPosition: 84, cockpitLength: 24, rootChord: 13.4, engineDiameter: 3, engineLength: 5.8, tailStyle: "conventional"}, estimated);
add("Russia", "Trainer", "yak130", "Yakovlev Yak-130", 11.49, 9.84, {...trainer, engineCount: 2}, UAC + "military/yak-130/",
    "Long tandem canopy, root extensions and twin side intakes.", {diameter: 1.55, engineDiameter: 0.65, rootChord: 3.6, wingGlove: 2.5}, estimated);
add("Russia", "Helicopter", "mi8", "Mi-8 / Mi-17 transport", 18.17, 3, helicopter, russianRotors,
    "Rounded broad cockpit, round cabin portholes and five-blade main rotor.", {diameter: 3.1, rotorDiameter: 21.3, rotorBlades: 5, windowShape: "round", windowCount: 5, windowEnd: 51}, estimated);
add("Russia", "Helicopter", "mi24", "Mi-24V Hind", 17.51, 6.54, attackHelicopter, russianRotors,
    "Long heavily framed tandem glazing, small cabin windows, anhedral stub wings and five-blade rotor.", {diameter: 2, bodyHeight: 1.3, rotorDiameter: 17.3, rotorBlades: 5, rootChord: 1.8, dihedral: -10, windows: true, windowCount: 3, windowStart: 29, windowEnd: 45}, estimated);
add("Russia", "Helicopter", "mi28", "Mi-28N", 16.85, 4.9, attackHelicopter, russianRotors,
    "Narrow tandem framed cockpit, small stub wings and five-blade rotor.", {rotorDiameter: 17.2, rotorBlades: 5, rootChord: 1.2}, estimated);
add("Russia", "Helicopter", "ka52", "Ka-52 Alligator", 13.5, 7.3, {...attackHelicopter, cockpitStyle: "helicopter"}, russianRotors,
    "Wide side-by-side pilot windows and two coaxial three-blade rotors; no tail rotor.", {diameter: 2.2, bodyHeight: 0.95, cockpitLength: 40, cockpitWidth: 98, cockpitPosition: 65, rotorDiameter: 14.5, rotorLayout: "coaxial", rotorBlades: 3, rotorHeight: 0.85, rootChord: 1.5}, estimated);
add("Russia", "Helicopter", "ka27", "Ka-27 Helix", 11.3, 3, {...helicopter, bodyStyle: "transport"}, russianRotors,
    "Broad pilot panes, compact naval cabin, coaxial rotors and twin fins.", {diameter: 2.9, rotorDiameter: 15.9, rotorLayout: "coaxial", rotorBlades: 3, tailStyle: "twin", finCant: 0, finHeight: 1.3, tailSpan: 3.8, windowCount: 2}, estimated);
add("Russia", "Helicopter", "mi26", "Mi-26 Halo", 33.73, 3, helicopter, russianRotors,
    "Large transport cockpit and porthole cabin row beneath an eight-blade rotor.", {diameter: 5, rotorDiameter: 32, rotorBlades: 8, windowShape: "round", windowCount: 8, windowEnd: 53, engineDiameter: 1.3}, estimated);
add("Russia", "Drone", "orion", "Orion / Inokhodets", 8, 16, drone, "https://kronshtadt.ru/",
    "Windowless slender body, long straight wings, V-tail and rear pusher.", {rootChord: 1.5, propDiameter: 1.8}, estimated);
add("Russia", "Drone", "s70", "S-70 Okhotnik · demonstrator", 14, 19, wing, UAC + "military/",
    "Windowless lambda-wing demonstrator with a single upper intake; dimensions estimated.", {flyingWingShape: "lambda", diameter: 3.5, engineType: "jet", engineMount: "integrated", engineCount: 1, engineDiameter: 1.1, intakeStyle: "top"}, estimated);

// Iran includes indigenous types and identifiable imported families. These are
// historical/operator presets, not a claim that a particular airframe is active.
const sand = {bodyColor: "#9b9579", wingColor: "#9b9579", engineColor: "#898774", accentColor: "#70795f"};
for (const [id, label, role] of [["f14", "F-14A Tomcat", "Fighter / attack"], ["f4", "F-4E Phantom II", "Fighter / attack"],
    ["f5e", "F-5E Tiger II", "Fighter / attack"], ["mig29", "MiG-29", "Fighter / attack"], ["su24", "Su-24MK", "Fighter / attack"],
    ["c130h", "C-130H Hercules", "Transport"], ["p3", "P-3F Orion", "Patrol / reconnaissance"], ["yak130", "Yak-130", "Trainer"],
    ["ch47", "CH-47C Chinook", "Helicopter"]]) {
    const parent = catalog.find(item => item.id === `mil-${id}`);
    derivative("Iran", role, `iran-${id}`, `${label} · Iranian scheme`, id, parent.reference.source,
        `${parent.reference.description} Generic Iranian colors; operator details approximate.`, sand);
}
derivative("Iran", "Fighter / attack", "saeqeh", "HESA Saeqeh", "f5e", "https://irannewsdaily.com/wp-content/uploads/2023/04/1402-01-28.pdf",
    "F-5-derived single canopy with outward-canted twin fins; dimensions approximate.", {...sand, tailStyle: "twin", finCant: 20}, estimated);
derivative("Iran", "Fighter / attack", "kowsar", "HESA Kowsar · two seat", "f5e", "https://irannewsdaily.com/wp-content/uploads/2023/04/1402-01-28.pdf",
    "F-5-derived tandem framed cockpit; twin exhausts and one fin. Approximate outer shape.", {...sand, canopyFrame: "tandem", cockpitLength: 74}, estimated);
add("Iran", "Trainer", "yasin", "HESA Yasin", 12.25, 10.4, {...trainer, ...sand, engineCount: 2}, iran,
    "Long tandem framed canopy, side intakes and low tapered wings; public prototype proportions.", {diameter: 1.5, rootChord: 3.1, engineDiameter: 0.65, sweep: 18}, estimated);
add("Iran", "Trainer", "pc7iran", "Pilatus PC-7 · Iranian scheme", 9.78, 10.4, {...trainer, ...sand}, "https://www.pilatus-aircraft.com/en/pc-7",
    "Tandem framed canopy and nose propeller; older PC-7 outline and approximate operator colors.", {engineType: "turboprop", engineMount: "nose", intakeStyle: "none", engineLength: 0.8, engineDiameter: 0.65, propBlades: 3, propDiameter: 2.36, rootChord: 1.8, sweep: 2, noseLength: 32, tailRadius: 0}, estimated);
add("Iran", "Helicopter", "ah1jiran", "AH-1J SeaCobra · Iranian scheme", 13.6, 3.28, {...attackHelicopter, ...sand}, "https://www.bellflight.com/products/h1",
    "Narrow tandem framed canopy, skids and older two-blade rotor; approximate J-model outline.", {diameter: 1.05, rotorDiameter: 13.41, rotorBlades: 2, gearStyle: "skids", rootChord: 0.9}, estimated);
add("Iran", "Drone", "shahed129", "Shahed 129", 8, 16, drone, "https://dam.gcsp.ch/files/doc/iran-forward-defence-strategy-en",
    "Windowless long-wing pusher with V-tail and sensor turret; dimensions estimated.", {rootChord: 1.5, propDiameter: 1.8}, estimated);
add("Iran", "Drone", "mohajer6", "Mohajer-6", 5.67, 10, drone, "https://www.tehrantimes.com/news/438266/Iranian-Army-unveils-new-drone-called-Mohajer-6",
    "No glazing; short center body, twin tail booms, rear pusher and sensor turret.", {diameter: 0.7, rootChord: 1.35, tailStyle: "boom", tailSpan: 3.7, finCant: 0, finHeight: 0.85, propDiameter: 1.5}, estimated);

export const MILITARY_PRESETS = catalog;
