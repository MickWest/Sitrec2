import {PARAMETER_GROUPS as AIRCRAFT_GROUPS, normalizeParameters as normalizeAircraft, readParameterFile as readAircraftFile} from "./aircraftSchema.js";
import {LIGHT_GROUP} from "./vehicleLights.js";
import {BRAND_GROUP} from "./vehicleLivery.js";
import {DRONE_GROUPS, BALLOON_GROUPS, isMultirotor, isBalloon} from "./aerialParameters.js";
export {isMultirotor, isBalloon} from "./aerialParameters.js";

const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const choice = (key, label, options, value) => ({key, label, options, value, type: "select"});
const check = (key, label, value) => ({key, label, value, type: "checkbox"});
const color = (key, label, value) => ({key, label, value, type: "color"});
export const ROAD_GROUPS = [
    {name: "Body & cabin", open: true, fields: [
        number("length", "Body length · m", 2.5, 18, 0.01, 4.65), number("width", "Body width · m", 1.3, 3.4, 0.01, 1.82),
        number("height", "Height · m", 1, 4.5, 0.01, 1.46), number("clearance", "Ground clearance · m", 0.08, 0.8, 0.01, 0.17),
        number("beltLevel", "Belt line · % height", 35, 70, 1, 54), number("cabFront", "Cabin starts · % from front", 3, 45, 1, 30),
        number("cabRear", "Cabin ends · % from front", 35, 98, 1, 82), number("cabHeight", "Cabin roof · % height", 60, 100, 1, 100),
        number("roofWidth", "Roof width · % body", 65, 100, 1, 87), number("windshieldRake", "Windscreen rake · °", 0, 60, 1, 35),
        number("rearRake", "Rear window rake · °", 0, 60, 1, 32),
    ]},
    {name: "Windows & doors", fields: [check("glazing", "Window glazing", true),
        number("sideWindows", "Side panes per side", 1, 12, 1, 2), number("pillarWidth", "Window pillars · cm", 2, 20, 0.5, 6),
        number("doorsPerSide", "Doors per side", 1, 4, 1, 2), color("glassColor", "Glass color", "#173346") ]},
    {name: "Wheels & stance", open: true, fields: [
        number("wheelRadius", "Wheel radius · m", 0.2, 0.9, 0.01, 0.34), number("tireWidth", "Tire width · m", 0.15, 0.6, 0.01, 0.24),
        number("wheelbase", "Wheelbase · % body length", 38, 82, 1, 60), number("track", "Wheel track · % body width", 68, 104, 1, 88),
        choice("axles", "Axle count", {2: "2", 3: "3", 4: "4"}, 2), check("dualRear", "Dual rear tires", false),
        number("steering", "Front-wheel steering · °", -38, 38, 1, 0),
    ]},
    {name: "Cargo & equipment", fields: [
        choice("cargoStyle", "Rear body", {none: "Passenger body", pickup: "Open pickup bed", box: "Cargo box", flatbed: "Flatbed", dump: "Tipper body", tanker: "Tank", fifthwheel: "Tractor fifth wheel"}, "none"),
        number("cargoLevel", "Cargo top · % height", 55, 100, 1, 100), number("dumpTilt", "Tipper lift · °", 0, 55, 1, 0),
        check("roofRack", "Roof rails / equipment rack", false), check("spoiler", "Rear spoiler", false),
        check("lightbar", "Emergency lightbar", false), check("roofSign", "Taxi roof sign", false),
        check("mirrors", "Door mirrors", true), check("grille", "Front grille", true),
    ]},
    {name: "Paint & trim", fields: [color("bodyColor", "Body paint", "#526f91"), color("cargoColor", "Cargo paint", "#d7dadd"),
        color("trimColor", "Trim / stripe", "#252d36"), check("sideStripe", "Contrasting side stripe", false),
        number("roughness", "Paint roughness", 0.15, 1, 0.01, 0.38)]},
];
export const isRoad = p => p.vehicleType === "car" || p.vehicleType === "truck";
export const vehicleKind = p => isRoad(p) || p.vehicleType === "drone" || isBalloon(p) ? p.vehicleType : p.rotorLayout !== "none" && p.rotorLayout ? "helicopter" : "aircraft";
export function parameterGroups(p) {
    const groups=isMultirotor(p)?DRONE_GROUPS:isBalloon(p)?BALLOON_GROUPS:isRoad(p)?ROAD_GROUPS:AIRCRAFT_GROUPS;
    const lightFields=isBalloon(p)?["lightsEnabled","lightGain"]:isMultirotor(p)?["lightsEnabled","positionLights","landingLights","strobeLights","beaconLights","lightGain","flashPeriod","flashDuration"]:null;
    const lights=lightFields?{...LIGHT_GROUP,note:isBalloon(p)?"Warm light follows the flame. Envelope glow is set in Basket, tether & glow.":"Editable status LEDs and auxiliary lights. Colors are generic visual defaults, not flight-status telemetry.",fields:LIGHT_GROUP.fields.filter(f=>lightFields.includes(f.key)).map(f=>({...f,label:({positionLights:"Motor status LEDs",landingLights:"Downward auxiliary light",strobeLights:"White strobe",beaconLights:"Red beacon"})[f.key]??f.label}))}:LIGHT_GROUP;
    return [...groups,BRAND_GROUP,lights];
}
function lightParameters(input) {
    const result={};
    for(const f of [...LIGHT_GROUP.fields,...BRAND_GROUP.fields]) {
        const v=input[f.key];
        if(f.type==="number")result[f.key]=Number.isFinite(v)?Math.max(f.min,Math.min(f.max,v)):f.value;
        else if(f.type==="select")result[f.key]=Object.hasOwn(f.options,v)?v:f.value;
        else if(f.type==="color")result[f.key]=typeof v==="string"&&/^#[0-9a-f]{6}$/i.test(v)?v:f.value;
        else result[f.key]=typeof v==="boolean"?v:f.value;
    }
    return result;
}
export function normalizeParameters(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Vehicle parameters must be an object.");
    const drone=isMultirotor(input),balloon=isBalloon(input);
    if (!isRoad(input) && !drone && !balloon) return {...normalizeAircraft(input), vehicleType: input.vehicleType==="drone"?"drone":"aircraft", ...(input.vehicleType==="drone"?{droneStyle:"fixedwing"}:{}), ...lightParameters(input)};
    const defaults=balloon?{positionLights:false,landingLights:false,beaconLights:false,strobeLights:false}:drone?{landingLights:false,beaconLights:false,strobeLights:false}:{};
    const p = {vehicleType: input.vehicleType, ...(drone?{droneStyle:"multirotor"}:{}), ...lightParameters({...defaults,...input})};
    for (const f of (drone?DRONE_GROUPS:balloon?BALLOON_GROUPS:ROAD_GROUPS).flatMap(g => g.fields)) {
        const v = input[f.key];
        if (f.type === "number") {const n = Number.isFinite(v) ? v : f.value; p[f.key] = Math.max(f.min, Math.min(f.max, f.step === 1 ? Math.round(n) : n));}
        else if (f.type === "select") p[f.key] = Object.hasOwn(f.options, v) ? (typeof f.value === "number" ? Number(v) : v) : f.value;
        else if (f.type === "color") p[f.key] = typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : f.value;
        else p[f.key] = typeof v === "boolean" ? v : f.value;
    }
    if(isRoad(p)) {
        p.cabRear = Math.max(p.cabFront + 18, p.cabRear);
        p.wheelRadius = Math.min(p.wheelRadius, p.height * 0.31, p.length / (p.axles * 3.3));
        p.clearance = Math.min(p.clearance, p.wheelRadius * 1.2);
    } else if(drone) {
        // Expand the frame when a larger propeller would intersect its neighbor.
        // Guard rims need more separation than an unguarded rotor disc.
        const clearance=p.rotorGuards?1.14:1.03;
        const minSpan=p.rotorDiameter*clearance/(p.rotorCount===4?1:Math.sin(Math.PI/p.rotorCount));
        p.armSpan=Math.max(p.armSpan,p.width,minSpan);p.armLength=Math.max(p.armLength,p.length*.85,minSpan);
        p.armRise=Math.max(p.armRise,-p.height*.20);
        p.armThickness=Math.min(p.armThickness,p.rotorDiameter*.2);
    }
    return p;
}
export function parameterFile(parameters, name = "My vehicle") {
    return {format: "sitrec-procedural-vehicle", version: 1, name: String(name).slice(0, 100), parameters: normalizeParameters(parameters)};
}
export function readParameterFile(data) {
    if (data?.format === "sitrec-procedural-aircraft") {
        const legacy = readAircraftFile(data); return parameterFile(legacy.parameters, legacy.name);
    }
    if (!data || data.format !== "sitrec-procedural-vehicle" || data.version !== 1 || !data.parameters ||
        typeof data.parameters !== "object" || Array.isArray(data.parameters) || !["car", "truck", "aircraft","drone","balloon"].includes(data.parameters.vehicleType))
        throw new Error("Choose a Vehicle Designer or legacy Aircraft Designer parameter file (version 1).");
    return parameterFile(data.parameters, typeof data.name === "string" ? data.name : "Imported vehicle");
}
