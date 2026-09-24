// Published length/span targets, checked against the linked manufacturer sources.
// Other controls approximate visible proportions; window counts are illustrative.
const boeing = model => `https://www.boeing.com/commercial/${model}`;
const planning = file => `https://www.boeing.com/content/dam/boeing/v2/airports/acaps/${file}.pdf`;
const airbus = model => `https://www.aircraft.airbus.com/en/aircraft/${model}`;
const airbusPlanning = "https://www.aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics";
const common = {
    bodyStyle: "transport", noseProfile: "airliner", cockpitStyle: "airliner", cockpitPosition: 60,
    cockpitLength: 30, cockpitWidth: 92, cockpitPillar: 5, wingPlanform: "cranked", taper: 0.22,
    wingHeight: -0.56, thickness: 11, twist: -1.5, dihedral: 5, engineType: "jet", engineCount: 2,
    engineMount: "wing", engineDrop: 0.48, engineFlatness: 0, tailStyle: "conventional",
    windowWidth: 0.28, windowHeight: 0.42, windowLevel: 0.40, windowStart: 15, windowEnd: 83,
    windows: true, doors: true, livery: "tail", bodyColor: "#f0f2f3", wingColor: "#b6bec6",
    engineColor: "#e7ebee", accentColor: "#215a91", roughness: 0.48, gear: false,
};
const b737 = {...common,
    length: 39.47, diameter: 3.76, bodyHeight: 1.064, noseLength: 13.6, tailLength: 20,
    rootChord: 6.6, sweep: 28, dihedral: 5.5, wingPosition: 40, thickness: 11.6,
    winglet: 2.5, wingletStyle: "blended", wingletCant: 16.4,
    tailPosition: 85.5, tailSpan: 14.35, tailChord: 4.6, tailSweep: 33, finHeight: 7.65, finChord: 7.2, finSweep: 35,
    engineDiameter: 2.44, engineLength: 4.1, engineSpacing: 29, engineOffset: 2.35, engineDrop: 0.4, engineFlatness: 0.19,
    windowCount: 46, windowStart: 14.8, windowEnd: 84, windowWidth: 0.27, windowLevel: 0.43, gearHeight: 1.65,
};
const bMax = {...b737, wingletStyle: "split", winglet: 2.2, wingletCant: 21,
    engineDiameter: 2.65, engineLength: 4.25, engineOffset: 2.7, engineFlatness: 0.07, finHeight: 7.45};
const b747 = {...common,
    length: 70.67, diameter: 6.50, bodyHeight: 1.05, noseLength: 14.5, tailLength: 23,
    upperDeckRise: 1.7, upperDeckEnd: 39, doubleDeck: true, upperWindowStart: 14, upperWindowEnd: 31, upperWindowCount: 23,
    cockpitPosition: 62, cockpitLength: 24, cockpitWidth: 80, cockpitHeight: 0.8,
    rootChord: 14.4, taper: 0.16, sweep: 40, wingPosition: 42, dihedral: 6.5,
    winglet: 1.8, wingletStyle: "blade", wingletCant: 15,
    tailPosition: 86, tailSpan: 22.17, tailChord: 8.6, tailSweep: 39, finHeight: 12.2, finChord: 10.9, finSweep: 42,
    engineCount: 4, engineDiameter: 2.85, engineLength: 4.9, engineSpacing: 36.3, engineOffset: 3.5,
    windowCount: 76, windowStart: 6, windowEnd: 85, windowLevel: 0.10, gearHeight: 2.9,
};
const b757 = {...common,
    length: 47.32, diameter: 3.76, bodyHeight: 1.067, noseLength: 12.5, tailLength: 19,
    rootChord: 8.2, sweep: 29, wingPosition: 42, winglet: 0,
    tailPosition: 88, tailSpan: 15.21, tailChord: 5.2, tailSweep: 33, finHeight: 8.8, finChord: 7.4, finSweep: 37,
    engineDiameter: 2.6, engineLength: 4.5, engineSpacing: 34, engineOffset: 3,
    windowCount: 57, windowStart: 14, windowEnd: 83, gearHeight: 2.6,
};
const b767 = {...common,
    length: 54.94, diameter: 5.03, bodyHeight: 1.075, noseLength: 11.7, tailLength: 21,
    rootChord: 10.5, sweep: 32, wingPosition: 41, winglet: 0, dihedral: 6,
    tailPosition: 87, tailSpan: 18.62, tailChord: 6.2, tailSweep: 33, finHeight: 10.2, finChord: 8.7, finSweep: 40,
    engineDiameter: 2.79, engineLength: 4.8, engineSpacing: 33.3, engineOffset: 3.3,
    windowCount: 64, windowStart: 13, windowEnd: 84, gearHeight: 2.5,
};
const b777 = {...common,
    length: 73.9, diameter: 6.20, bodyHeight: 1.035, noseLength: 12.2, tailLength: 24,
    rootChord: 13.3, sweep: 35, wingPosition: 41, winglet: 2.0, wingletStyle: "raked", wingletCant: 0,
    tailPosition: 86.5, tailSpan: 21.5, tailChord: 8, tailSweep: 35, finHeight: 11.3, finChord: 11.4, finSweep: 42,
    engineDiameter: 3.85, engineLength: 6.1, engineSpacing: 31, engineOffset: 4.1,
    windowCount: 86, windowStart: 13, windowEnd: 84, windowWidth: 0.30, windowHeight: 0.44, gearHeight: 3,
};
const b787 = {...common,
    length: 62.8, diameter: 5.77, bodyHeight: 1.03, noseLength: 13.7, tailLength: 25,
    cockpitStyle: "airliner4", cockpitWidth: 90, cockpitHeight: 1.05,
    rootChord: 12.2, sweep: 36, dihedral: 8, wingPosition: 42, taper: 0.13,
    winglet: 2.7, wingletStyle: "raked", wingletCant: 0,
    tailPosition: 86, tailSpan: 19.5, tailChord: 6.6, tailSweep: 37, finHeight: 10.6, finChord: 9.4, finSweep: 40,
    engineDiameter: 3.25, engineLength: 5.4, engineSpacing: 32, engineOffset: 3.6,
    windowCount: 58, windowStart: 14, windowEnd: 82, windowWidth: 0.38, windowHeight: 0.50, gearHeight: 2.6,
};
const a320 = {...common,
    length: 37.57, diameter: 3.95, bodyHeight: 1.05, noseLength: 14.2, tailLength: 22,
    cockpitPosition: 63, cockpitLength: 27, cockpitHeight: 0.85, cockpitSetback: 10,
    rootChord: 6.8, sweep: 28, dihedral: 5, wingPosition: 42,
    winglet: 0.85, wingletStyle: "fence", wingletCant: 0,
    tailPosition: 86, tailSpan: 12.45, tailChord: 4.5, tailSweep: 33, finHeight: 6.8, finChord: 6.7, finSweep: 38,
    engineDiameter: 2.42, engineLength: 3.8, engineSpacing: 34, engineOffset: 2.1,
    windowCount: 43, windowStart: 16.5, windowEnd: 84, windowWidth: 0.27, windowHeight: 0.39, gearHeight: 1.7,
    accentColor: "#177d9d",
};
const aNeo = {...a320, winglet: 2.4, wingletStyle: "blended", wingletCant: 20,
    engineDiameter: 2.85, engineLength: 4.5, engineOffset: 2.4, engineDrop: 0.43};
const a220 = {...aNeo,
    length: 38.7, diameter: 3.50, bodyHeight: 1.03, noseLength: 17, tailLength: 25,
    cockpitStyle: "airliner4", cockpitMask: true, cockpitPosition: 57, cockpitLength: 28,
    rootChord: 6.7, sweep: 27, taper: 0.17, wingPosition: 43, winglet: 1.9, wingletCant: 20,
    tailPosition: 86, tailSpan: 11.9, tailChord: 4.3, finHeight: 6.9, finChord: 6.3,
    engineDiameter: 2.4, engineLength: 3.9, engineSpacing: 33, engineOffset: 2.1,
    windowCount: 34, windowWidth: 0.32, windowHeight: 0.45, windowStart: 19, windowEnd: 81,
};
const a330 = {...common,
    length: 63.69, diameter: 5.64, bodyHeight: 1.01, noseLength: 13, tailLength: 23,
    cockpitPosition: 61, cockpitLength: 24, cockpitHeight: 0.83, cockpitSetback: 10,
    rootChord: 11.8, sweep: 34, wingPosition: 41, dihedral: 5.5, taper: 0.17,
    winglet: 2.15, wingletStyle: "blade", wingletCant: 25,
    tailPosition: 86, tailSpan: 19.4, tailChord: 6.6, tailSweep: 35, finHeight: 10.4, finChord: 10.1, finSweep: 40,
    engineDiameter: 3.05, engineLength: 5.5, engineSpacing: 30.5, engineOffset: 3.5,
    windowCount: 73, windowStart: 13, windowEnd: 83, windowWidth: 0.29, windowHeight: 0.41,
    gearHeight: 2.6, accentColor: "#177d9d",
};
const a330neo = {...a330, winglet: 3.2, wingletStyle: "blended", wingletCant: 33, cockpitMask: true,
    engineDiameter: 3.6, engineLength: 5.8, engineOffset: 3.8};
const a350 = {...common,
    length: 66.8, diameter: 5.96, bodyHeight: 1.02, noseLength: 13.7, tailLength: 24,
    cockpitMask: true, cockpitPosition: 57, cockpitLength: 29, cockpitHeight: 0.94,
    rootChord: 12.5, sweep: 35, wingPosition: 42, dihedral: 7.5, taper: 0.16,
    winglet: 2.6, wingletStyle: "blended", wingletCant: 48,
    tailPosition: 86, tailSpan: 19, tailChord: 6.5, tailSweep: 36, finHeight: 10.6, finChord: 9.8, finSweep: 40,
    engineDiameter: 3.9, engineLength: 6.2, engineSpacing: 31, engineOffset: 3.9,
    windowCount: 69, windowStart: 13.5, windowEnd: 83, windowWidth: 0.32, windowHeight: 0.44,
    gearHeight: 2.8, accentColor: "#177d9d",
};
const a380 = {...common,
    length: 72.73, diameter: 7.14, bodyHeight: 1.31, noseLength: 12.5, tailLength: 24,
    cockpitPosition: 62, cockpitLength: 23, cockpitHeight: 0.72, cockpitWidth: 95,
    rootChord: 16.8, sweep: 36, wingPosition: 43, dihedral: 5.5, taper: 0.17,
    winglet: 2.0, wingletStyle: "fence", wingletCant: 0,
    tailPosition: 86, tailSpan: 30.37, tailChord: 10.5, tailSweep: 37, finHeight: 14.5, finChord: 13.6, finSweep: 43,
    engineCount: 4, engineDiameter: 3.95, engineLength: 5.8, engineSpacing: 32, engineOffset: 4.4,
    windowCount: 78, windowStart: 12, windowEnd: 84, windowLevel: 0.04,
    doubleDeck: true, upperWindowStart: 14, upperWindowEnd: 82, upperWindowCount: 75, upperWindowLevel: 0.65,
    gearHeight: 3.2, accentColor: "#177d9d",
};

function model(id, name, category, base, length, wingspan, source, description, changes = {}) {
    // Stretched variants keep their nose, tail and glazing in physical metres.
    const p = {...base, length,
        noseLength: base.noseLength * base.length / length,
        tailLength: base.tailLength * base.length / length,
        tailPosition: 100 - (100 - base.tailPosition) * base.length / length,
        wingPosition: (base.length * base.wingPosition + (length - base.length) * 50) / length,
        windowStart: base.windowStart * base.length / length,
        windowEnd: 100 - (100 - base.windowEnd) * base.length / length,
        windowCount: Math.round(base.windowCount + (length - base.length) / 0.72), ...changes};
    const extension = p.wingletStyle === "raked" ? p.winglet : p.winglet * Math.tan((p.wingletCant ?? 0) * Math.PI / 180);
    const fenceThickness = p.wingletStyle === "fence" ? p.rootChord * p.taper * 0.06 : 0;
    p.span = changes.span ?? (wingspan - 2 * extension - fenceThickness);
    // Locate the swept tail so its trailing edges fit the published envelope.
    const tailExtent = Math.max(p.finHeight * Math.tan(p.finSweep * Math.PI / 180) + p.finChord * 0.05,
        p.finChord * 0.75, p.tailSpan / 2 * Math.tan(p.tailSweep * Math.PI / 180) + p.tailChord * 0.15);
    p.tailPosition = Math.min(p.tailPosition, 100 * (1 - (tailExtent + 0.15) / length));
    if (!p.doorLayout) p.doorLayout = p.diameter >= 6.2 ? "five" :
        (p.diameter > 4.5 || p.length > 43) ? "four" : "overwing";
    for (const key of Object.keys(p)) if (typeof p[key] === "number") p[key] = Number(p[key].toFixed(4));
    return {id, name, category, parameters: p, reference: {length, wingspan, source, description}};
}

export const AIRLINER_PRESETS = [
    model("737", "737-800 · British Airways reference", "Boeing · 737 NG", b737, 39.47, 35.8, boeing("737ng"),
        "Blended winglets, flattened nacelles and the supplied paint reference.",
        {span: 34.32, livery: "british", bodyColor: "#f0f1f1", wingColor: "#b0b8c0", accentColor: "#102a4b", engineColor: "#102a4b"}),
    model("737-700", "737-700 · blended winglets", "Boeing · 737 NG", b737, 33.6, 35.8, boeing("737ng"), "Short NG fuselage; CFM56-style nacelles."),
    model("737-800", "737-800 · blended winglets", "Boeing · 737 NG", b737, 39.47, 35.8, boeing("737ng"), "Standard NG fuselage; CFM56-style nacelles."),
    model("737-900er", "737-900ER · blended winglets", "Boeing · 737 NG", b737, 42.1, 35.8, boeing("737ng"), "Stretched NG fuselage."),
    ...[["7",35.6],["8",39.5],["9",42.1],["10",43.8]].map(([variant,length]) =>
        model(`737-max-${variant}`, `737 MAX ${variant} · split winglets`, "Boeing · 737 MAX", bMax, length, 35.9, boeing("737max"), "Split tips and larger LEAP-style nacelles. Published design dimensions.")),
    model("747", "747-400 · passenger jumbo", "Boeing · 747", b747, 70.67, 64.44, planning("747-400_Rev_F"), "Short upper deck, four engines and upright winglets."),
    model("747-8", "747-8 Intercontinental", "Boeing · 747", b747, 76.25, 68.4, planning("747-8_Rev_E"), "Longer upper deck, raked tips and larger nacelles.",
        {winglet: 2.1, wingletStyle: "raked", upperDeckEnd: 47, upperWindowEnd: 35, upperWindowCount: 32, engineDiameter: 3.2, engineLength: 5.4, rootChord: 15.1, tailSpan: 21.99}),
    model("757-200", "757-200 · original tips", "Boeing · 757 / 767", b757, 47.32, 38.05, planning("757_Rev_H"), "Slender fuselage, tall fin and original wing tips."),
    model("757-300", "757-300 · original tips", "Boeing · 757 / 767", b757, 54.43, 38.06, planning("757_Rev_H"), "Stretched 757 fuselage with the original wing."),
    model("767-200er", "767-200ER · original tips", "Boeing · 757 / 767", b767, 48.51, 47.57, planning("767_REV_K"), "Short twin-aisle fuselage."),
    model("767-300er", "767-300ER · original tips", "Boeing · 757 / 767", b767, 54.94, 47.57, planning("767_REV_K"), "Stretched twin-aisle fuselage."),
    model("767-400er", "767-400ER · raked tips", "Boeing · 757 / 767", b767, 61.37, 51.92, planning("767_REV_K"), "Longest 767 fuselage and extended raked tips.", {winglet: 2.175, wingletStyle: "raked"}),
    model("777-200er", "777-200ER", "Boeing · 777 / 777X", b777, 63.7, 60.9, boeing("777"), "Short fuselage, original span and smaller nacelles.", {winglet: 0, engineDiameter: 3.45, engineLength: 5.6}),
    model("777-200lr", "777-200LR · raked tips", "Boeing · 777 / 777X", b777, 63.7, 64.8, boeing("777"), "Short fuselage with extended span and large GE90-style nacelles."),
    model("777-300er", "777-300ER · raked tips", "Boeing · 777 / 777X", b777, 73.9, 64.8, boeing("777"), "Long fuselage and large GE90-style nacelles."),
    model("777-9", "777-9 · tips extended", "Boeing · 777 / 777X", b777, 76.7, 71.8, boeing("777x"), "Published design dimensions, tips extended for flight; GE9X-style nacelles.",
        {rootChord: 14.2, winglet: 3.5, engineDiameter: 4.25, engineLength: 6.6, finHeight: 12.0}),
    model("787-8", "787-8 Dreamliner", "Boeing · 787", b787, 56.7, 60.1, boeing("787"), "Short fuselage, four cockpit panes, large cabin windows and raked tips."),
    model("787", "787-9 Dreamliner", "Boeing · 787", b787, 62.8, 60.1, boeing("787"), "Mid-length fuselage, four cockpit panes and raked tips."),
    model("787-10", "787-10 Dreamliner", "Boeing · 787", b787, 68.3, 60.1, boeing("787"), "Longest Dreamliner fuselage with the same wing span."),
    model("a220-100", "A220-100", "Airbus · A220", a220, 35.0, 35.1, airbus("a220/a220-100"), "Short fuselage, large cabin windows, four cockpit panes and geared-fan proportions."),
    model("a220-300", "A220-300", "Airbus · A220", a220, 38.7, 35.1, airbus("a220/a220-300"), "Stretched A220 fuselage with the same wing."),
    ...[["a319",33.84],["a320",37.57],["a321",44.51]].flatMap(([type,length]) => [
        model(type === "a320" ? "a320" : `${type}ceo`, `${type.toUpperCase()}ceo · tip fences`, "Airbus · A320", a320, length, 34.1, airbusPlanning,
            "Original tip-fence configuration with CFM56-style nacelles."),
        model(`${type}neo`, `${type.toUpperCase()}neo · sharklets`, "Airbus · A320", aNeo, length, 35.8, airbus(`a320-family/${type}neo`),
            "Sharklets and larger new-generation nacelles."),
    ]),
    model("a330-200", "A330-200", "Airbus · A330 / A340", a330, 58.82, 60.3, airbus("a330/a330-200"), "Short fuselage and canted winglets.", {finHeight: 11.0}),
    model("a330-300", "A330-300", "Airbus · A330 / A340", a330, 63.69, 60.3, airbus("a330/a330-300"), "Long fuselage and canted winglets."),
    model("a330-800", "A330-800neo", "Airbus · A330 / A340", a330neo, 58.82, 64.0, airbus("a330/a330-800"), "Short neo fuselage, larger engines, mask and curved tips.", {finHeight: 11.0}),
    model("a330-900", "A330-900neo", "Airbus · A330 / A340", a330neo, 63.69, 64.0, airbus("a330/a330-900"), "Long neo fuselage, larger engines, mask and curved tips."),
    model("a340-300", "A340-300 · four engines", "Airbus · A330 / A340", a330, 63.69, 60.3, airbusPlanning, "Four smaller CFM56-style nacelles on the original wing.",
        {engineCount: 4, engineDiameter: 2.1, engineLength: 4.4, engineSpacing: 27, finHeight: 11.2}),
    model("a340-600", "A340-600 · stretched four-engine", "Airbus · A330 / A340", a330, 75.36, 63.45, airbusPlanning, "Long fuselage, larger wing and four Trent-style nacelles.",
        {rootChord: 13.2, engineCount: 4, engineDiameter: 2.95, engineLength: 5.5, engineSpacing: 28, finHeight: 12.1, finChord: 11, tailSpan: 22.6}),
    model("a350-900", "A350-900 · cockpit mask", "Airbus · A350 / A380", a350, 66.8, 64.75, airbus("a350/a350-900"), "Dark cockpit surround, curved tips and large Trent-style nacelles."),
    model("a350-1000", "A350-1000 · cockpit mask", "Airbus · A350 / A380", a350, 73.78, 64.75, airbus("a350/a350-1000"), "Stretched fuselage and larger nacelles.", {diameter: 5.94, engineDiameter: 4.05, engineLength: 6.4}),
    model("a380", "A380-800 · full double deck", "Airbus · A350 / A380", a380, 72.73, 79.75, airbusPlanning, "Full-length upper deck, four engines and tip fences."),
];
