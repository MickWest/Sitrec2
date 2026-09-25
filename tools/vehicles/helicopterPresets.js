// Civil and utility rotorcraft families. The fuselage is an editable visual
// approximation; rotor diameter is not the overall turning-rotor envelope.
const base = {bodyStyle: "helicopter", diameter: 1.7, bodyHeight: 1.08, noseLength: 23, tailLength: 26,
    cockpitStyle: "helicopter", cockpitPanes: 4, cockpitPosition: 62, cockpitLength: 40, cockpitWidth: 98, cockpitPillar: 4,
    wings: false, span: 3, winglet: 0, tailStyle: "conventional", tailPosition: 83, tailSweep: 8, finSweep: 24,
    engineType: "none", engineMount: "top", engineCount: 1, engineDiameter: 0.45, engineLength: 1.3,
    rotorLayout: "single", rotorPosition: 34, rotorHeight: 0.45, rotorBlades: 3,
    windows: true, windowCount: 2, windowStart: 26, windowEnd: 43, windowWidth: 0.48, windowHeight: 0.55, windowLevel: 0.1, windowShape: "square",
    gear: true, gearStyle: "skids", gearHeight: 0.35, doors: false, livery: "stripe", bodyColor: "#e4e8e7", wingColor: "#c5cdd1", accentColor: "#bb4039"};
const entries = [];
function add(id, name, length, rotorDiameter, blades, source, changes = {}) {
    entries.push({id: `heli-${id}`, name, category: "Helicopters · civil & utility", region: "General", role: "Helicopter",
        parameters: {...base, length, rotorDiameter, rotorBlades: blades, tailSpan: rotorDiameter * 0.22, tailChord: length * 0.06,
            finHeight: length * 0.10, finChord: length * 0.11, ...changes},
        reference: {length, wingspan: rotorDiameter, spanLabel: "rotor diameter", lengthLabel: "fuselage",
            quality: "Approximate family proportions", source,
            description: "Civil family reference. Fuselage, glazing and equipment are editable visual approximations; no particular operator livery is represented."}});
}
add("r22", "R22-style · two-seat piston", 6.6, 7.67, 2, "https://www.robinsonheli.com/", {diameter: 1.35, windowCount: 1, cockpitLength: 48, gearHeight: 0.28});
add("r44", "R44-style · four-seat piston", 9.0, 10.06, 2, "https://www.robinsonheli.com/", {diameter: 1.55, cockpitLength: 45});
add("r66", "R66-style · light turbine", 9.0, 10.06, 2, "https://www.robinsonheli.com/", {diameter: 1.65, accentColor: "#4b779e"});
add("bell206", "Bell 206-style · light utility", 9.6, 10.16, 2, "https://www.bellflight.com/", {diameter: 1.65, noseLength: 21});
add("bell407", "Bell 407-style · utility", 10.6, 10.67, 4, "https://www.bellflight.com/products/bell-407", {diameter: 1.8, engineType: "jet", windowCount: 3});
add("bell505", "Bell 505-style · light cabin", 10.5, 11.28, 2, "https://www.bellflight.com/products/bell-505", {diameter: 1.8, cockpitLength: 49, cockpitHeight: 1.15});
add("h125", "H125-style · utility single", 10.9, 10.69, 3, "https://www.airbus.com/en/products-services/helicopters/civil-helicopters/h125/h125-technical-information", {diameter: 1.9, engineType: "jet", windowCount: 3});
add("h130", "H130-style · sightseeing", 10.7, 10.69, 3, "https://www.airbus.com/en/products-services/helicopters/civil-helicopters/h130", {tailRotorStyle: "ducted", tailRotorRatio: 10, diameter: 2.1, cockpitLength: 46, windowCount: 3});
add("h135", "H135-style · medical / police twin", 10.2, 10.4, 4, "https://www.airbus.com/en/products-services/helicopters/civil-helicopters/h135", {tailRotorStyle: "ducted", tailRotorRatio: 10, diameter: 2, engineType: "jet", engineCount: 2, sensorTurret: true, bodyColor: "#e7c62c", accentColor: "#ad3a34"});
add("h145", "H145-style · rescue twin", 11.7, 10.8, 5, "https://www.airbus.com/en/products-services/helicopters/civil-helicopters/h145", {tailRotorStyle: "ducted", tailRotorRatio: 10, diameter: 2.2, engineType: "jet", engineCount: 2, windowCount: 3, bodyColor: "#c54836"});
add("h160", "H160-style · medium twin", 13.6, 12.0, 5, "https://www.airbus.com/en/products-services/helicopters/civil-helicopters/h160", {tailRotorStyle: "ducted", tailRotorRatio: 10, diameter: 2.4, engineType: "jet", engineCount: 2, gearStyle: "tricycle", windowCount: 4, accentColor: "#285b7d"});
add("aw109", "AW109-style · light executive twin", 11.0, 10.83, 4, "https://helicopters.leonardo.com/en/products/aw109-grandnew", {diameter: 1.9, engineType: "jet", engineCount: 2, gearStyle: "tricycle", accentColor: "#275e7a"});
add("aw139", "AW139-style · medium transport", 13.8, 13.8, 5, "https://helicopters.leonardo.com/en/products/aw139", {diameter: 2.6, engineType: "jet", engineCount: 2, gearStyle: "tricycle", windowCount: 4, windowShape: "round"});
add("s76", "S-76-style · executive / offshore", 13.2, 13.41, 4, "https://www.lockheedmartin.com/en-us/products/sikorsky-s-76-helicopter.html", {diameter: 2.5, engineType: "jet", engineCount: 2, gearStyle: "tricycle", windowCount: 4});
add("s92", "S-92-style · offshore / rescue", 17.1, 17.17, 4, "https://www.lockheedmartin.com/en-us/products/sikorsky-s-92-helicopter.html", {diameter: 3.2, engineType: "jet", engineCount: 2, engineDiameter: 0.7, engineLength: 2, gearStyle: "tricycle", windowCount: 6, windowShape: "round", rotorHeight: 0.8});
export const HELICOPTER_PRESETS = entries;
