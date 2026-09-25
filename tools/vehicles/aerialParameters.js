const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const choice = (key, label, options, value) => ({key, label, options, value, type: "select"});
const check = (key, label, value) => ({key, label, value, type: "checkbox"});
const color = (key, label, value) => ({key, label, value, type: "color"});

export const DRONE_GROUPS = [
    {name: "Drone airframe", open: true, note: "Motor spacing expands as needed to keep propellers and guards clear.", fields: [
        choice("droneBody", "Body profile", {compact:"Compact / folding", dome:"Smooth shell", spine:"Cinema spine", stack:"FPV deck & battery"}, "compact"),
        number("length", "Center body length · m", 0.04, 2, 0.005, 0.18),
        number("width", "Center body width · m", 0.025, 1.5, 0.005, 0.09),
        number("height", "Body height · m", 0.015, 0.8, 0.005, 0.065),
        number("armSpan", "Motor span · m", 0.06, 8, 0.005, 0.27),
        number("armLength", "Motor fore-aft span · m", 0.06, 8, 0.005, 0.20),
        number("armThickness", "Arm thickness · m", 0.003, 0.15, 0.001, 0.018),
        number("armRise", "Motor rise · m", -0.2, 0.5, 0.005, 0.015),
        choice("rotorCount", "Rotor arms", {4: "Quad · 4", 6: "Hexa · 6", 8: "Octo · 8"}, 4),
        check("coaxial", "Paired coaxial rotors", false),
    ]},
    {name: "Propellers & guards", open: true, fields: [
        number("rotorDiameter", "Propeller diameter · m", 0.025, 2.5, 0.005, 0.18),
        choice("rotorBlades", "Blades per rotor", {2: "2", 3: "3", 4: "4", 5: "5"}, 2),
        check("rotorGuards", "Full propeller guards", false),
        number("guardHeight", "Guard depth · m", 0.005, 0.2, 0.005, 0.02),
    ]},
    {name: "Camera & equipment", fields: [
        check("camera", "Camera / gimbal", true),
        choice("cameraLenses", "Camera lenses", {1: "Single", 2: "Dual", 3: "Triple"}, 1),
        number("cameraSize", "Camera size · m", 0.015, 0.6, 0.005, 0.05),
        number("cameraPitch", "Camera pitch down · °", -35, 90, 1, 0),
        number("cameraYaw", "Camera yaw · °", -90, 90, 1, 0),
        check("rtk", "RTK antenna pair", false), check("lidar", "Top sensor", false),
        check("cargoTank", "Agricultural / cargo tank", false),
        choice("droneGear", "Landing gear", {feet: "Short feet", skids: "Tall skids", none: "None"}, "feet"),
        number("gearHeight", "Landing gear height · m", 0.005, 1, 0.005, 0.035),
    ]},
    {name: "Drone colors", fields: [color("bodyColor", "Body", "#a8adb0"), color("accentColor", "Arms / accent", "#66717a"),
        color("propColor", "Propellers", "#242b30"), number("roughness", "Surface roughness", 0.15, 1, 0.01, 0.5)]},
];

export const BALLOON_GROUPS = [
    {name: "Envelope", open: true, fields: [
        choice("balloonShape", "Shape", {hotair: "Hot-air balloon", sphere: "Sphere / weather balloon", oval: "Oval / party balloon",
            blimp: "Blimp / airship", solar: "Solar tube", foil: "Round foil", star: "Star foil", heart: "Heart foil",
            lantern: "Round sky lantern", boxlantern: "Box sky lantern", pagoda: "Tapered sky lantern"}, "hotair"),
        number("width", "Envelope width · m", 0.15, 80, 0.01, 15),
        number("height", "Envelope height · m", 0.15, 100, 0.01, 19),
        number("length", "Envelope depth / length · m", 0.05, 150, 0.01, 15),
        number("fullness", "Envelope fullness", 0.65, 1.5, 0.01, 1),
        number("goreCount", "Vertical panels / gores", 4, 48, 1, 24),
        number("lobing", "Panel bulge · %", 0, 12, 0.5, 2),
    ]},
    {name: "Colors & fabric", open: true, fields: [
        choice("balloonPattern", "Pattern", {solid: "Solid", alternating: "Alternating panels", rainbow: "Rainbow panels", bands: "Horizontal bands", checker: "Checkerboard"}, "rainbow"),
        color("bodyColor", "Main color", "#e34336"), color("accentColor", "Second color", "#f2c840"), color("thirdColor", "Third color", "#247fc2"),
        number("patternBands", "Horizontal bands", 2, 16, 1, 8),
        number("metalness", "Metallic finish", 0, 1, 0.01, 0),
        number("roughness", "Surface roughness", 0.08, 1, 0.01, 0.65),
        number("opacity", "Fabric opacity", 0.3, 1, 0.01, 1),
    ]},
    {name: "Basket, tether & glow", fields: [
        choice("suspended", "Suspended equipment", {none: "None", basket: "Passenger basket", sonde: "Radiosonde", gondola: "Airship gondola"}, "basket"),
        number("basketWidth", "Basket / payload width · m", 0.04, 8, 0.01, 1.8),
        number("suspension", "Suspension length · m", 0.03, 20, 0.01, 1.5),
        check("tether", "Tether / ribbon", false), number("tetherLength", "Tether length · m", 0.05, 30, 0.05, 1.2),
        check("balloonFins", "Airship tail fins", false),
        check("flame", "Burner / lantern flame", true),
        number("glow", "Envelope glow", 0, 3, 0.05, 0.3),
    ]},
];

export const isMultirotor = p => p.vehicleType === "drone" && p.droneStyle !== "fixedwing";
export const isBalloon = p => p.vehicleType === "balloon";

export function droneMotorLayout(p) {
    return Array.from({length:p.rotorCount},(_,i)=>{
        const theta=(i+.5)*Math.PI*2/p.rotorCount;
        return [p.rotorCount===4?Math.sign(Math.sin(theta))*p.armSpan/2:Math.sin(theta)*p.armSpan/2,
            p.rotorCount===4?Math.sign(Math.cos(theta))*p.armLength/2:Math.cos(theta)*p.armLength/2];
    });
}
