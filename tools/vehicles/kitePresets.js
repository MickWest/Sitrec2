import {KITE_FLIGHT_DEFAULTS} from "./kiteFlight.js";

// Generic kite types, not named products. Sizes are typical of each type. Mass
// is an estimate from fabric area and frame; lift and drag are type estimates.
const kites = [];
function kite(id, name, category, shape, width, height, mass, changes = {}) {
    kites.push({id: `kite-${id}`, name, category: `Kites · ${category}`, region: "General", role: "Kite",
        parameters: {vehicleType: "kite", kiteShape: shape, width, height, kiteMass: mass, ...KITE_FLIGHT_DEFAULTS[shape], ...changes},
        reference: {quality: "Generic kite", length: height, wingspan: width, lengthLabel: "nose to tail edge", spanLabel: "wide",
            source: "ReferenceReview.md",
            description: "Editable visual example of a kite type. Mass, lift and drag are estimates. Add Kite in Sitrec uses them with the wind to find the line angle."}});
}
const noTail = {tailCount: 0};
kite("diamond", "Diamond kite · ribbon tail", "Framed", "diamond", 0.9, 0.9, 0.07, {tailLength: 3, tailWidth: 0.05});
kite("diamond-blue", "Diamond kite · blue, twin tails", "Framed", "diamond", 1.2, 1.3, 0.14,
    {bodyColor: "#2f6fc2", accentColor: "#f4f1e6", tailColor: "#f4f1e6", tailCount: 2, tailLength: 5, tailWidth: 0.06});
kite("delta", "Delta kite · 2 m", "Framed", "delta", 2, 1, 0.25,
    {bow: 8, flyingAngle: 22, bodyColor: "#e9682c", accentColor: "#28324a", tailColor: "#e9682c", tailCount: 2, tailLength: 4, tailWidth: 0.06});
kite("delta-rainbow", "Delta kite · rainbow, 3 m", "Framed", "delta", 3, 1.5, 0.5,
    {bow: 8, flyingAngle: 22, kitePattern: "rainbow", tailCount: 3, tailLength: 8, tailWidth: 0.08});
kite("rokkaku", "Rokkaku · hexagon", "Framed", "rokkaku", 1.2, 1.5, 0.35,
    {...noTail, bow: 14, flyingAngle: 28, bodyColor: "#f4f1e6", accentColor: "#c92f38"});
kite("sled", "Sled kite", "Framed", "sled", 0.9, 1, 0.12,
    {bow: 20, flyingAngle: 25, bodyColor: "#3aa55d", accentColor: "#f2c840", tailColor: "#f2c840", tailCount: 2, tailLength: 2.5, tailWidth: 0.05});
kite("box", "Box kite", "Framed", "box", 0.6, 1, 0.2, {...noTail, bow: 0, flyingAngle: 28, bodyColor: "#c92f38", accentColor: "#f4f1e6"});
kite("parafoil", "Parafoil · 2 m", "Soft", "parafoil", 2, 1.2, 0.35,
    {depth: 0.2, bow: 16, flyingAngle: 12, cellCount: 8, kitePattern: "rainbow", tailCount: 2, tailLength: 6, tailWidth: 0.08});
kite("parafoil-large", "Parafoil · 5 m lifter", "Soft", "parafoil", 5, 3, 2.2,
    {depth: 0.5, bow: 18, flyingAngle: 12, cellCount: 10, bodyColor: "#2f6fc2", accentColor: "#f4f1e6", tailColor: "#2f6fc2",
        tailCount: 2, tailLength: 15, tailWidth: 0.2});

// An octopus kite is a soft ram-air head with eight tube tentacles. The size in
// the name is the total length. The head is about a quarter of it.
function octopus(id, name, total, mass, colors) {
    const width = total * 0.2;
    kite(id, name, "Octopus", "octopus", width, total * 0.24, mass, {depth: total * 0.12, bow: 0, flyingAngle: 14, kitePattern: "solid",
        tailCount: 8, tailStyle: "tube", tailLength: total * 0.76, tailWidth: width * 0.15, tailTaper: 6,
        tailSpread: 22, tailDroop: 14, tailMotion: 80, waveLength: 60, accentColor: "#f0752b", ...colors});
}
const red = {bodyColor: "#d6353b", tailColor: "#d6353b", accentColor: "#f2c840"}, black = {bodyColor: "#17191d", tailColor: "#17191d", roughness: 0.45};
octopus("octopus-6", "Octopus kite · 6 m, red", 6, 0.75, red);
octopus("octopus-8", "Octopus kite · 8 m, purple", 8, 1.3, {bodyColor: "#6a3fa0", tailColor: "#6a3fa0", accentColor: "#f2c840"});
octopus("octopus-14", "Octopus kite · 14 m, red", 14, 4, red);
octopus("octopus-14-black", "Octopus kite · 14 m, black", 14, 4, black);
octopus("octopus-25", "Octopus kite · 25 m, black", 25, 13, black);
octopus("octopus-rainbow", "Octopus kite · 14 m, rainbow", 14, 4, {kitePattern: "rainbow"});

export const KITE_PRESETS = kites;
