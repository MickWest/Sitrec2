import {AIRLINER_PRESETS} from "./airlinerPresets.js";
import {MILITARY_PRESETS} from "./militaryPresets.js";
import {normalizeParameters} from "./aircraftSchema.js";
export * from "./aircraftSchema.js";

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
