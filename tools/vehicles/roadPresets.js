// Generic visual classes, not exact model-year replicas or engineering drawings.
const car = {vehicleType: "car", bodyColor: "#526f91", trimColor: "#252d36"};
const truck = {vehicleType: "truck", bodyColor: "#d2d7da", cabFront: 10, cabRear: 37, cabHeight: 82,
    windshieldRake: 14, rearRake: 5, roofWidth: 92, wheelRadius: 0.50, tireWidth: 0.32,
    clearance: 0.30, beltLevel: 43, cargoStyle: "box", dualRear: true};
const items = [];
function add(id, name, category, length, width, height, base, changes = {}) {
    items.push({id: `road-${id}`, name, category, vehicleType: base.vehicleType, region: "General", role: category,
        description: "Generic editable proportions; no manufacturer or model-year specification is implied.",
        parameters: {...base, length, width, height, ...changes}});
}
add("city", "City car · three door", "Cars · hatchbacks", 3.55, 1.64, 1.48, car, {cabFront: 29, cabRear: 92, sideWindows: 2, doorsPerSide: 1, wheelbase: 66});
add("compact", "Compact hatchback · five door", "Cars · hatchbacks", 4.15, 1.78, 1.47, car, {cabFront: 29, cabRear: 92, rearRake: 15});
add("electric-hatch", "Electric hatchback", "Cars · hatchbacks", 4.30, 1.82, 1.54, car, {grille: false, cabFront: 24, cabRear: 92, wheelbase: 65, bodyColor: "#e2e7e9"});
add("sedan", "Midsize sedan", "Cars · sedans & wagons", 4.75, 1.82, 1.46, car);
add("executive", "Executive sedan", "Cars · sedans & wagons", 5.10, 1.91, 1.49, car, {wheelbase: 61, bodyColor: "#242c38", wheelRadius: 0.36});
add("ev-sedan", "Electric fastback sedan", "Cars · sedans & wagons", 4.72, 1.85, 1.44, car, {grille: false, cabFront: 26, cabRear: 89, rearRake: 48, roofWidth: 82, bodyColor: "#e4e9ed"});
add("wagon", "Estate / station wagon", "Cars · sedans & wagons", 4.80, 1.83, 1.50, car, {cabRear: 94, rearRake: 12, sideWindows: 3, roofRack: true});
add("taxi", "City taxi", "Cars · sedans & wagons", 4.90, 1.86, 1.57, car, {bodyColor: "#e6b91d", roofSign: true});
add("police", "Patrol sedan", "Cars · service", 5.03, 1.91, 1.48, car, {bodyColor: "#e5e8eb", trimColor: "#151b24", lightbar: true, sideStripe: true});
add("coupe", "Sports coupe", "Cars · sports", 4.50, 1.89, 1.29, car, {cabFront: 36, cabRear: 79, doorsPerSide: 1, sideWindows: 2, wheelRadius: 0.34, clearance: 0.12, roofWidth: 79, spoiler: true, bodyColor: "#be3434"});
add("supercar", "Mid-engine sports car", "Cars · sports", 4.55, 1.98, 1.18, car, {cabFront: 23, cabRear: 64, windshieldRake: 53, doorsPerSide: 1, sideWindows: 1, wheelRadius: 0.33, clearance: 0.10, roofWidth: 76, spoiler: true, bodyColor: "#e29924"});
add("muscle", "Long-hood muscle coupe", "Cars · sports", 4.85, 1.93, 1.38, car, {cabFront: 39, cabRear: 81, doorsPerSide: 1, wheelRadius: 0.36, bodyColor: "#3b6e54"});
add("crossover", "Compact crossover", "Cars · SUVs & people carriers", 4.42, 1.84, 1.65, car, {cabFront: 28, cabRear: 93, rearRake: 20, wheelRadius: 0.36, clearance: 0.21, sideWindows: 3});
add("suv", "Midsize SUV", "Cars · SUVs & people carriers", 4.90, 1.97, 1.80, car, {cabFront: 29, cabRear: 95, rearRake: 8, wheelRadius: 0.40, clearance: 0.24, sideWindows: 3, roofRack: true});
add("offroad", "Short-wheelbase off-roader", "Cars · SUVs & people carriers", 4.05, 1.89, 1.86, car, {cabFront: 29, cabRear: 96, windshieldRake: 14, rearRake: 2, wheelbase: 59, doorsPerSide: 1, wheelRadius: 0.42, clearance: 0.32, sideWindows: 2, roofWidth: 92});
add("large-suv", "Full-size SUV", "Cars · SUVs & people carriers", 5.65, 2.06, 1.96, car, {cabRear: 96, rearRake: 5, wheelRadius: 0.42, clearance: 0.27, sideWindows: 3, roofRack: true, bodyColor: "#252e39"});
add("minivan", "Family minivan / MPV", "Cars · SUVs & people carriers", 5.10, 1.95, 1.79, car, {cabFront: 19, cabRear: 95, rearRake: 7, sideWindows: 3, wheelbase: 63});
const pickup = {...truck, cabFront: 29, cabRear: 61, cabHeight: 100, windshieldRake: 28, cargoStyle: "pickup", wheelRadius: 0.41, tireWidth: 0.29, dualRear: false, beltLevel: 51};
add("pickup-single", "Pickup · regular cab", "Trucks · pickups", 5.35, 1.97, 1.83, pickup, {cabRear: 50, doorsPerSide: 1, sideWindows: 1});
add("pickup-crew", "Pickup · crew cab", "Trucks · pickups", 5.90, 2.03, 1.93, pickup);
add("pickup-heavy", "Heavy-duty pickup · dual rear wheels", "Trucks · pickups", 6.65, 2.18, 2.02, pickup, {dualRear: true, wheelRadius: 0.45, cabRear: 56, tireWidth: 0.26});
add("pickup-offroad", "Off-road pickup", "Trucks · pickups", 5.70, 2.10, 2.10, pickup, {clearance: 0.43, wheelRadius: 0.47, track: 96, bodyColor: "#b77e37", roofRack: true});
add("panel-van", "Panel delivery van", "Trucks · vans", 5.95, 2.04, 2.65, truck, {cargoStyle: "box", cabFront: 10, cabRear: 34, cabHeight: 87, wheelRadius: 0.37, dualRear: false, wheelbase: 62});
add("passenger-van", "Passenger minibus", "Trucks · vans", 6.10, 2.08, 2.55, truck, {cargoStyle: "none", cabFront: 8, cabRear: 97, cabHeight: 100, windshieldRake: 12, rearRake: 0, sideWindows: 5, wheelRadius: 0.37, dualRear: false, doorsPerSide: 1});
add("ambulance", "Box ambulance", "Trucks · service", 6.75, 2.35, 2.85, truck, {cabRear: 33, cargoStyle: "box", lightbar: true, sideStripe: true, bodyColor: "#ede9df", trimColor: "#b53031", wheelRadius: 0.42});
add("box-light", "Light box truck", "Trucks · delivery & freight", 6.40, 2.20, 3.05, truck, {cabRear: 31, cabFront: 7, wheelRadius: 0.42});
add("box-heavy", "Rigid box truck · 6×2", "Trucks · delivery & freight", 10.0, 2.50, 3.80, truck, {cabRear: 25, cabFront: 4, axles: 3, wheelbase: 65, wheelRadius: 0.52});
add("flatbed", "Flatbed truck · 6×4", "Trucks · construction", 8.60, 2.50, 3.10, truck, {cabRear: 29, axles: 3, cargoStyle: "flatbed", wheelbase: 64});
add("dump", "Tipper / dump truck · 6×4", "Trucks · construction", 8.0, 2.50, 3.35, truck, {cabRear: 31, axles: 3, cargoStyle: "dump", bodyColor: "#cc9b32", cargoColor: "#b78428"});
add("dump-four", "Heavy tipper · 8×4", "Trucks · construction", 10.1, 2.55, 3.50, truck, {cabRear: 26, axles: 4, cargoStyle: "dump", wheelbase: 61, bodyColor: "#a74832"});
add("tanker", "Rigid tanker · 6×4", "Trucks · delivery & freight", 9.2, 2.50, 3.40, truck, {cabRear: 27, axles: 3, cargoStyle: "tanker", cargoColor: "#adb9c2"});
add("tractor-us", "Long-hood tractor · 6×4", "Trucks · tractors", 7.45, 2.50, 3.65, truck, {cabFront: 28, cabRear: 63, axles: 3, cargoStyle: "fifthwheel", cabHeight: 100, wheelbase: 55, windshieldRake: 12, bodyColor: "#5d7490"});
add("tractor-eu", "Cab-over tractor · 4×2", "Trucks · tractors", 5.95, 2.50, 3.75, truck, {cabFront: 5, cabRear: 49, cargoStyle: "fifthwheel", cabHeight: 100, wheelbase: 58, windshieldRake: 6, bodyColor: "#ae3734"});
add("fire", "Fire engine", "Trucks · service", 8.35, 2.50, 3.20, truck, {cabRear: 39, cargoStyle: "box", cargoLevel: 84, cabHeight: 90, lightbar: true, sideStripe: true, roofRack: true, bodyColor: "#b63031", cargoColor: "#b63031", trimColor: "#e3dbb4"});
add("refuse", "Refuse collection truck", "Trucks · service", 9.3, 2.50, 3.60, truck, {cabRear: 27, axles: 3, cargoStyle: "box", bodyColor: "#edeae0", cargoColor: "#497955"});
add("city-bus", "City bus · 12 m", "Trucks · buses & coaches", 12.0, 2.55, 3.15, truck, {cargoStyle: "none", cabFront: 3, cabRear: 98, cabHeight: 100, windshieldRake: 3, rearRake: 0, sideWindows: 9, doorsPerSide: 3, wheelbase: 58, wheelRadius: 0.48, bodyColor: "#ac3d38", roofWidth: 98});
add("coach", "Touring coach · 13 m", "Trucks · buses & coaches", 13.0, 2.55, 3.75, truck, {cargoStyle: "none", cabFront: 4, cabRear: 98, cabHeight: 100, windshieldRake: 10, rearRake: 5, sideWindows: 8, doorsPerSide: 1, wheelbase: 61, axles: 3, beltLevel: 53, bodyColor: "#dce1e4", roofWidth: 95});
export const ROAD_PRESETS = items;
