import {AIRLINER_PRESETS} from "./airlinerPresets.js";
import {MILITARY_PRESETS} from "./militaryPresets.js";

// Dimensions are metres; angles are degrees. Presets are visual approximations.
const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const choice = (key, label, options, value) => ({key, label, options, value, type: "select"});
const check = (key, label, value) => ({key, label, value, type: "checkbox"});
const color = (key, label, value) => ({key, label, value, type: "color"});

export const PARAMETER_GROUPS = [
    {name: "Airframe", open: true, fields: [
        choice("bodyStyle", "Basic type", {transport: "Transport / airliner", light: "Light aircraft", jet: "Streamlined jet", glider: "Glider", helicopter: "Helicopter cabin & boom", flyingwing: "Flying wing"}, "transport"),
        number("length", "Fuselage length · m", 3, 85, 0.01, 39.5),
        number("diameter", "Fuselage width · m", 0.4, 9, 0.01, 3.8),
        number("bodyHeight", "Height / width", 0.2, 1.8, 0.01, 1.04),
        number("noseLength", "Nose · % of length", 5, 35, 0.1, 14),
        choice("noseProfile", "Nose profile", {auto: "Automatic", smooth: "Smooth / pointed", airliner: "Airliner radome & crown"}, "auto"),
        number("tailLength", "Tail cone · % of length", 10, 45, 0.1, 24),
        number("tailRadius", "Tail outlet · % body radius", 0, 85, 0.1, 0),
        number("upperDeckRise", "Upper-deck hump · m", 0, 3, 0.01, 0),
        number("upperDeckEnd", "Hump ends · % from nose", 20, 65, 0.1, 40),
    ]},
    {name: "Cockpit glazing", note: "Move Position left to slide the glazing forward. All changes preview live.", fields: [
        check("cockpit", "Show cockpit glazing", true),
        choice("cockpitStyle", "Glazing style", {auto: "Automatic", airliner: "Airliner · six panes", airliner4: "Airliner · four panes", transport: "Transport · framed wraparound", helicopter: "Helicopter · tall wraparound", windshield: "Crown windshield panes", canopy: "Bubble canopy"}, "auto"),
        check("cockpitMask", "Dark surround / mask", false),
        number("cockpitPosition", "Position · % of nose", 15, 150, 0.5, 60),
        number("cockpitLength", "Length · % of nose", 8, 100, 0.5, 30),
        number("cockpitWidth", "Width · % of body", 25, 99, 0.5, 92),
        number("cockpitHeight", "Window height scale", 0.4, 1.8, 0.01, 1),
        number("cockpitSetback", "Side setback · % of nose", -20, 40, 0.5, 12),
        choice("cockpitPanes", "Windshield panes", {2: "2", 4: "4", 6: "6", 8: "8"}, 6),
        number("cockpitPillar", "Pillar width · cm", 0.5, 20, 0.5, 5),
        number("canopyHeight", "Canopy rise · body radii", 0.05, 1.5, 0.01, 0.7),
        choice("canopyFrame", "Canopy framing", {none: "Frameless", front: "Windshield bow", tandem: "Tandem seats", cage: "Multiple bows"}, "none"),
        check("navigatorWindows", "Lower nose glazing", false),
        check("cockpitEyebrows", "Upper flight-deck windows", false),
    ]},
    {name: "Wings", open: true, fields: [
        check("wings", "Main wings / stub wings", true),
        number("span", "Main wing span · m", 3, 90, 0.01, 35.8),
        number("rootChord", "Root chord · m", 0.4, 28, 0.01, 6.5),
        number("taper", "Tip / root chord", 0.06, 1.2, 0.01, 0.24),
        choice("wingPlanform", "Planform", {taper: "Straight taper", cranked: "Cranked trailing edge", flying: "Flying wing · notched trailing edge"}, "taper"),
        choice("flyingWingShape", "Flying-wing outline", {sawtooth: "B-2-style multiple notches", lambda: "Single cranked / lambda wing"}, "sawtooth"),
        number("sweep", "Leading-edge sweep · °", -15, 65, 0.1, 28),
        number("dihedral", "Dihedral · °", -12, 20, 0.1, 5),
        number("wingPosition", "Position · % from nose", 20, 75, 0.1, 43),
        number("wingHeight", "Height · body radii", -0.85, 0.95, 0.01, -0.55),
        number("thickness", "Thickness · % chord", 3, 20, 0.1, 10),
        number("twist", "Tip twist · °", -10, 10, 0.1, -2),
        number("winglet", "Tip height / raked span · m", 0, 5, 0.01, 1.6),
        choice("wingletStyle", "Winglet style", {blade: "Straight", blended: "Blended / sharklet", split: "Split upper & lower", fence: "Tip fence", raked: "Raked tip"}, "blade"),
        number("wingletCant", "Winglet outward cant · °", 0, 65, 1, 12),
        check("biplane", "Second wing", false),
        check("struts", "Wing support struts", false),
        number("wingGlove", "Leading-edge root extensions · m", 0, 12, 0.01, 0),
    ]},
    {name: "Tail & canards", fields: [
        choice("tailStyle", "Tail layout", {conventional: "Conventional", t: "T-tail", v: "V-tail", invertedv: "Inverted V-tail", twin: "Twin fin", twinnone: "Twin fins / no tailplane", quad: "Four fins", boom: "Twin boom", none: "No horizontal tail", tailless: "No tail surfaces"}, "conventional"),
        number("tailPosition", "Position · % from nose", 65, 98, 0.1, 88),
        number("tailSpan", "Tailplane span · m", 1, 35, 0.01, 13.5),
        number("tailChord", "Tailplane root chord · m", 0.3, 12, 0.01, 4.2),
        number("tailSweep", "Tailplane sweep · °", 0, 60, 0.1, 32),
        number("tailDihedral", "Tailplane dihedral · °", -35, 20, 0.1, 3),
        number("finHeight", "Fin height · m", 0.3, 15, 0.01, 5.8),
        number("finChord", "Fin root chord · m", 0.3, 14, 0.01, 5.3),
        number("finSweep", "Fin sweep · °", 0, 65, 0.1, 36),
        number("finCant", "Twin-fin outward cant · °", 0, 40, 0.1, 15),
        check("canards", "Canards", false),
        number("canardSpan", "Canard span · m", 1, 16, 0.01, 4),
    ]},
    {name: "Engines & propellers", fields: [
        choice("engineType", "Engine", {jet: "Turbofan / jet", prop: "Piston / propeller", turboprop: "Turboprop", none: "Unpowered"}, "jet"),
        choice("engineCount", "Engine count", {1: "1", 2: "2", 3: "3", 4: "4", 8: "8"}, 2),
        choice("engineMount", "Mounting", {wing: "Under wing", paired: "Paired underwing pods", rear: "Rear fuselage", shoulder: "Wing-root housings", vectored: "Four side-vectoring nozzles", nose: "Nose", integrated: "Integrated rear exhausts", pusher: "Rear pusher", top: "Above fuselage"}, "wing"),
        choice("intakeStyle", "Integrated engine intakes", {none: "None", side: "Side intakes", chin: "Chin intake", nose: "Nose intake", top: "Dorsal intake"}, "none"),
        number("engineDiameter", "Nacelle diameter · m", 0.2, 4.5, 0.01, 2.1),
        number("engineLength", "Nacelle length · m", 0.3, 9, 0.01, 3.6),
        number("engineSpacing", "Position · % half-span", 16, 75, 0.1, 34),
        number("engineOffset", "Forward offset · m", -4, 6, 0.01, 1),
        number("engineDrop", "Below wing · diameters", 0.1, 1.2, 0.01, 0.65),
        number("engineFlatness", "Flatten underside", 0, 0.35, 0.01, 0),
        number("propDiameter", "Propeller diameter · m", 0.7, 7, 0.01, 2),
        number("propBlades", "Propeller blades", 2, 8, 1, 3),
        check("contraProps", "Contra-rotating propellers", false),
        number("nozzleTilt", "Vectoring nozzle tilt · °", 0, 90, 1, 0),
    ]},
    {name: "Rotors & mission details", fields: [
        choice("rotorLayout", "Rotor arrangement", {none: "None", single: "Single + tail rotor", coaxial: "Coaxial", tandem: "Tandem", tiltrotor: "Tiltrotor"}, "none"),
        number("rotorDiameter", "Main rotor diameter · m", 2, 35, 0.01, 16),
        number("rotorBlades", "Main rotor blades", 2, 8, 1, 4),
        number("rotorPosition", "Rotor · % from nose", 20, 65, 0.1, 38),
        number("rotorHeight", "Mast above cabin · m", 0.2, 3, 0.01, 0.7),
        number("rotorTilt", "Tiltrotor forward tilt · °", 0, 90, 0.5, 0),
        choice("tailRotorStyle", "Tail rotor", {open: "Open rotor", ducted: "Enclosed / Fenestron-style"}, "open"),
        number("tailRotorRatio", "Tail rotor · % main diameter", 5, 25, 0.1, 19),
        choice("radarStyle", "Radar fairing", {none: "None", disc: "Dorsal disc", beam: "Dorsal beam"}, "none"),
        number("radarSize", "Radar width / beam length · m", 1, 12, 0.01, 7),
        check("sensorTurret", "Under-nose sensor turret", false),
        check("refuelBoom", "Tanker boom", false),
    ]},
    {name: "Livery & details", fields: [
        choice("livery", "Paint scheme", {stripe: "Classic stripe", belly: "Colored belly", tail: "Tail accent", solid: "Solid", british: "British Airways reference"}, "belly"),
        color("bodyColor", "Fuselage", "#f1f4f8"),
        color("accentColor", "Accent / tail", "#196fa5"),
        color("wingColor", "Wings", "#cbd4de"),
        color("engineColor", "Engine nacelles", "#f1f4f8"),
        number("roughness", "Paint roughness", 0.15, 1, 0.01, 0.38),
        check("windows", "Cabin windows", true),
        number("windowCount", "Windows per side", 0, 90, 1, 38),
        number("windowStart", "Cabin starts · % from nose", 8, 40, 0.1, 21),
        number("windowEnd", "Cabin ends · % from nose", 20, 92, 0.1, 72.5),
        choice("windowShape", "Cabin window shape", {rounded: "Rounded rectangle", round: "Circular porthole", square: "Rectangular"}, "rounded"),
        number("windowWidth", "Window width · m", 0.08, 1.3, 0.01, 0.27),
        number("windowHeight", "Window height · m", 0.1, 1.3, 0.01, 0.42),
        number("windowLevel", "Window line · body radii", -0.2, 0.8, 0.01, 0.4),
        check("doors", "Passenger doors & exits", false),
        choice("doorLayout", "Door arrangement", {overwing: "Doors + overwing exits", four: "Four doors per side", five: "Five doors per side"}, "overwing"),
        check("doubleDeck", "Upper-deck windows", false),
        number("upperWindowStart", "Upper row starts · %", 8, 40, 0.1, 18),
        number("upperWindowEnd", "Upper row ends · %", 20, 92, 0.1, 78),
        number("upperWindowCount", "Upper windows per side", 1, 90, 1, 40),
        number("upperWindowLevel", "Upper row · body radii", 0.45, 0.95, 0.01, 0.76),
        check("gear", "Landing gear extended", false),
        choice("gearStyle", "Landing gear", {tricycle: "Tricycle", taildragger: "Taildragger", skids: "Helicopter skids"}, "tricycle"),
        number("gearHeight", "Gear leg length · m", 0.2, 4, 0.01, 1.5),
        check("navLights", "Navigation light lenses", true),
    ]},
];

export const FIELDS = PARAMETER_GROUPS.flatMap(group => group.fields);
export const DEFAULTS = Object.fromEntries(FIELDS.map(field => [field.key, field.value]));

export function usesCanopy(p) {
    return p.cockpitStyle === "canopy" || ((p.cockpitStyle === undefined || p.cockpitStyle === "auto") &&
        (p.bodyStyle === "glider" || (p.bodyStyle === "jet" && p.windowCount === 0)));
}

export function usesAirlinerWindscreen(p) {
    return ["airliner", "airliner4", "transport", "helicopter"].includes(p.cockpitStyle) || ((p.cockpitStyle === undefined || p.cockpitStyle === "auto") &&
        !usesCanopy(p) && p.bodyStyle !== "light");
}

export function normalizeParameters(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Aircraft parameters must be an object.");
    // Old saved designs have no cockpit controls. Supply useful defaults for their
    // existing airframe, without replacing explicit settings in newer designs.
    const canopy = usesCanopy(input);
    const cockpitDefaults = canopy ? {cockpitPosition: 95, cockpitLength: 65, cockpitWidth: 74} :
        input.bodyStyle === "light" ? {cockpitPosition: 75, cockpitLength: 38, cockpitPillar: 2.5} : {};
    const cabinDefaults = input.bodyStyle === "light" || input.bodyStyle === "glider"
        ? {windowStart: Math.min(40, (input.noseLength ?? 22) + 7), windowEnd: Math.max(55, 96.5 - (input.tailLength ?? 42)),
            windowWidth: (input.diameter ?? 1.15) * 0.48, windowHeight: (input.diameter ?? 1.15) * 0.18, windowLevel: 0.3} : {};
    const result = {};
    for (const field of FIELDS) {
        const value = input[field.key];
        if (field.type === "number") {
            const n = typeof value === "number" && Number.isFinite(value) ? value : (cockpitDefaults[field.key] ?? cabinDefaults[field.key] ?? field.value);
            result[field.key] = Math.min(field.max, Math.max(field.min, field.step === 1 ? Math.round(n) : n));
        } else if (field.type === "select") {
            const valid = Object.hasOwn(field.options, value) ? value : field.value;
            result[field.key] = typeof field.value === "number" ? Number(valid) : valid;
        } else if (field.type === "color") {
            result[field.key] = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : field.value;
        } else result[field.key] = typeof value === "boolean" ? value : field.value;
    }
    return result;
}

export function parameterFile(parameters, name = "My aircraft") {
    return {format: "sitrec-procedural-aircraft", version: 1, name: String(name).slice(0, 100), parameters: normalizeParameters(parameters)};
}

export function readParameterFile(data) {
    if (!data || data.format !== "sitrec-procedural-aircraft" || data.version !== 1 ||
        !data.parameters || typeof data.parameters !== "object" || Array.isArray(data.parameters)) {
        throw new Error("Choose an Aircraft Designer parameter file (version 1).");
    }
    return parameterFile(data.parameters, typeof data.name === "string" ? data.name : "Imported aircraft");
}

const light = {bodyStyle: "light", length: 8.3, diameter: 1.15, bodyHeight: 1.18, noseLength: 22, tailLength: 42,
    span: 11, rootChord: 1.65, taper: 0.7, sweep: 1, dihedral: 2, wingPosition: 39, wingHeight: 0.8,
    thickness: 14, twist: -1, winglet: 0, struts: true, tailSpan: 3.6, tailChord: 1.2, tailSweep: 8,
    finHeight: 1.5, finChord: 1.5, finSweep: 25, engineType: "prop", engineCount: 1, engineMount: "nose",
    engineDiameter: 0.8, engineLength: 0.8, propDiameter: 1.9, propBlades: 2, gear: true, gearHeight: 0.65,
    windowCount: 3, livery: "stripe", wingColor: "#f1f4f8"};
const business = {bodyStyle: "jet", length: 28, diameter: 2.5, noseLength: 19, span: 28.5, rootChord: 4.4,
    taper: 0.25, sweep: 34, wingPosition: 48, wingHeight: -0.6, winglet: 1.3, tailStyle: "t", tailSpan: 9,
    tailChord: 2.8, finHeight: 4, finChord: 3.8, engineMount: "rear", engineDiameter: 1.25,
    engineLength: 3.1, windowCount: 8, livery: "stripe"};
const fighter = {bodyStyle: "jet", length: 15, diameter: 1.5, noseLength: 29, tailLength: 28, span: 10,
    rootChord: 4.7, taper: 0.23, sweep: 40, dihedral: 0, wingPosition: 49, wingHeight: -0.15, thickness: 5,
    winglet: 0, tailSpan: 5.4, tailChord: 2.7, tailSweep: 40, finHeight: 2.5, finChord: 3.8,
    engineMount: "integrated", intakeStyle: "chin", canopyFrame: "none", engineCount: 1, engineDiameter: 1.2, engineLength: 3.2, windowCount: 0,
    livery: "solid", bodyColor: "#8996a0", wingColor: "#8996a0", accentColor: "#536577", engineColor: "#6f7c87"};

const preset = (id, name, category, parameters) => ({id, name, category, parameters: normalizeParameters(parameters)});
export const PRESETS = [
    ...AIRLINER_PRESETS.map(item => ({...item, parameters: normalizeParameters(item.parameters)})),
    ...MILITARY_PRESETS.map(item => ({...item, parameters: normalizeParameters(item.parameters)})),
    preset("regional", "CRJ-style · regional jet", "Regional & business", {...business, length: 32.5, diameter: 2.7, span: 26, rootChord: 4.8, sweep: 27, windowCount: 24, livery: "belly"}),
    preset("business", "Gulfstream-style · business jet", "Regional & business", business),
    preset("trijet", "Falcon-style · business trijet", "Regional & business", {...business, length: 23.5, span: 26, engineCount: 3, tailStyle: "conventional", windowCount: 10, accentColor: "#bd924b"}),
    preset("atr", "ATR-style · regional turboprop", "Propeller aircraft", {length: 27.2, diameter: 2.8, span: 27, rootChord: 3, taper: 0.5, sweep: 3, dihedral: 2, wingPosition: 42, wingHeight: 0.8, winglet: 0, tailStyle: "t", tailSpan: 8, tailChord: 2.5, finHeight: 4.8, finChord: 4.6, engineType: "turboprop", engineDiameter: 1.1, engineLength: 3.1, propDiameter: 3.8, propBlades: 6, windowCount: 22, accentColor: "#d28632"}),
    preset("kingair", "King Air-style · twin turboprop", "Propeller aircraft", {...light, length: 13.3, diameter: 1.7, span: 17.6, rootChord: 2.4, wingHeight: -0.55, dihedral: 6, taper: 0.45, struts: false, tailStyle: "t", tailSpan: 5.5, finHeight: 2.4, finChord: 2.3, engineType: "turboprop", engineCount: 2, engineMount: "wing", engineDiameter: 0.85, engineLength: 2, propDiameter: 2.6, propBlades: 4, windowCount: 6, gear: false}),
    preset("cessna", "C172-style · high-wing single", "Light aircraft", light),
    preset("piper", "PA-28-style · low-wing single", "Light aircraft", {...light, length: 7.3, span: 10.8, wingHeight: -0.65, dihedral: 6, taper: 0.8, struts: false, accentColor: "#b7433c"}),
    preset("bonanza", "Bonanza-style · V-tail", "Light aircraft", {...light, length: 8.1, wingHeight: -0.6, dihedral: 6, struts: false, tailStyle: "v", tailSpan: 4, gear: false, propBlades: 3, accentColor: "#287e69"}),
    preset("dc3", "DC-3-style · classic twin", "Propeller aircraft", {...light, length: 19.7, diameter: 2.3, span: 29, rootChord: 4.3, taper: 0.4, sweep: 13, wingHeight: -0.55, dihedral: 5, struts: false, tailSpan: 8, tailChord: 2.6, finHeight: 3.5, finChord: 3.6, engineMount: "wing", engineCount: 2, engineDiameter: 1.4, engineLength: 1.8, propDiameter: 3.5, propBlades: 3, windowCount: 12, gearStyle: "taildragger", gearHeight: 1.2}),
    preset("biplane", "Sport biplane", "Light aircraft", {...light, length: 6.5, span: 7.8, rootChord: 1.5, taper: 1, wingHeight: -0.5, sweep: 0, biplane: true, gearStyle: "taildragger", windowCount: 1, bodyColor: "#ecd14c", wingColor: "#ecd14c", accentColor: "#273747"}),
    preset("glider", "Sailplane · 18 m", "Special configurations", {...light, bodyStyle: "glider", length: 7, diameter: 0.65, span: 18, rootChord: 0.95, taper: 0.25, wingHeight: 0.3, wingPosition: 41, dihedral: 4, sweep: 1, winglet: 0.45, struts: false, tailStyle: "t", tailSpan: 2.5, tailChord: 0.55, finHeight: 1, finChord: 0.85, engineType: "none", windowCount: 0, gear: false}),
    preset("fighter", "F-16-style · swept-wing jet", "Special configurations", fighter),
    preset("twinfin", "Twin-fin jet", "Special configurations", {...fighter, length: 18, span: 13.5, rootChord: 6, tailStyle: "twin", engineCount: 2, engineDiameter: 1.25, engineSpacing: 17}),
    preset("delta", "Delta-wing canard jet", "Special configurations", {...fighter, length: 15.3, span: 10.9, rootChord: 8, taper: 0.07, sweep: 56, wingPosition: 46, tailStyle: "none", canards: true, canardSpan: 5.5, finHeight: 2.8}),
    preset("concorde", "Concorde-style · supersonic delta", "Special configurations", {...fighter, length: 61.7, diameter: 2.9, noseLength: 30, span: 25.6, rootChord: 24, taper: 0.08, sweep: 62, wingPosition: 47, tailStyle: "none", finHeight: 6.5, finChord: 8, engineMount: "paired", intakeStyle: "none", engineCount: 4, engineDiameter: 1.6, engineLength: 6, windowCount: 48, cockpitStyle: "airliner4", cockpitPosition: 75, cockpitLength: 13, cockpitWidth: 86, bodyColor: "#f1f4f8", wingColor: "#e1e7ed", livery: "stripe", accentColor: "#234a87"}),
];
