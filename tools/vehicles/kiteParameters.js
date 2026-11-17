const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const choice = (key, label, options, value) => ({key, label, options, value, type: "select"});
const check = (key, label, value) => ({key, label, value, type: "checkbox"});
const color = (key, label, value) => ({key, label, value, type: "color"});

export const KITE_SHAPES = {diamond: "Diamond", delta: "Delta", rokkaku: "Rokkaku · hexagon", sled: "Sled",
    box: "Box", parafoil: "Parafoil", octopus: "Octopus"};

export const KITE_LED_PATTERNS = {spokes: "Rotating spokes", bar: "Rotating bar", spiral: "Spiral chase",
    burst: "Expanding fireworks", rings: "Chasing rings", rainbow: "Rainbow wheel", twinkle: "Twinkle",
    pulse: "Color pulse", steady: "Steady", sequence: "Automatic sequence"};
// Shared with the object's Lights folder. Layout controls are in the designer only.
export const KITE_LED_PATTERN_FIELDS = [
    check("ledEnabled", "LED lights", false),
    choice("ledPattern", "Pattern", KITE_LED_PATTERNS, "spokes"),
    number("ledSpeed", "Speed · cycles / s (− = reverse)", -5, 5, 0.01, 0.35),
    number("ledPhase", "Phase · °", 0, 360, 1, 0),
    number("ledArms", "Lit spokes / spiral arms", 1, 8, 1, 3),
    number("ledWidth", "Pattern width · %", 5, 100, 1, 35),
    number("ledBackground", "Unlit LED level · %", 0, 50, 1, 0),
    number("ledIntensity", "LED intensity", 0, 500, 0.1, 80),
    choice("ledPalette", "Colors", {custom: "Three chosen colors", rainbow: "Rainbow", solid: "First color only"}, "custom"),
    color("ledColor1", "First color", "#ff2020"),
    color("ledColor2", "Second color", "#20ff40"),
    color("ledColor3", "Third color", "#3060ff"),
    number("ledSequenceSeconds", "Seconds per pattern", 1, 30, 0.1, 4),
];

export const KITE_LED_TAIL_PATTERNS = {solid: "Solid color", chase: "Chasing lights", comet: "Comet",
    alternating: "Alternating colors", rainbow: "Rainbow chase", pulse: "Pulse", twinkle: "Twinkle"};
export const KITE_LED_TAIL_PATTERN_FIELDS = [
    check("ledTailEnabled", "LED Tail", false),
    choice("ledTailPattern", "Tail pattern", KITE_LED_TAIL_PATTERNS, "solid"),
    color("ledTailColor", "Tail LED color", "#3080ff"),
    color("ledTailColor2", "Alternate color", "#ffffff"),
    number("ledTailIntensity", "Tail LED intensity", 0, 500, 0.1, 80),
    number("ledTailSpeed", "Tail speed · cycles / s (− = reverse)", -5, 5, 0.01, 0.4),
    number("ledTailPhase", "Tail phase · °", 0, 360, 1, 0),
    number("ledTailRepeats", "Pattern repeats along tail", 1, 12, 1, 3),
    number("ledTailWidth", "Tail pattern width · %", 5, 100, 1, 35),
    number("ledTailBackground", "Unlit tail LED level · %", 0, 50, 1, 0),
    number("ledTailStagger", "Phase between tails · °", 0, 360, 1, 0),
];

export const KITE_GROUPS = [
    {name: "Kite", open: true, note: "The nose points into the wind (+Z). The origin is the tow point, where the line attaches.", fields: [
        choice("kiteShape", "Type", KITE_SHAPES, "diamond"),
        number("width", "Width · m", 0.01, 30, 0.01, 0.9),
        number("height", "Length, nose to tail edge · m", 0.01, 30, 0.01, 0.9),
        number("depth", "Thickness (parafoil, octopus) · m", 0.01, 15, 0.01, 0.3),
        number("bow", "Bow / arc · °", 0, 40, 1, 12),
        number("deltaNotch", "Delta tail notch · % of length", 0, 45, 1, 22),
        number("flyingAngle", "Flying attitude, nose up · °", 0, 60, 1, 30),
        number("cellCount", "Cells (parafoil)", 3, 24, 1, 8),
        check("bridle", "Bridle lines", true),
        check("eyes", "Eyes and spots (octopus)", true),
    ]},
    {name: "Tails & tentacles", open: true, note: "The preview moves the tails as in a steady 12-knot wind. In Sitrec they move with the wind at the kite.", fields: [
        number("tailCount", "Tails", 0, 12, 1, 1),
        choice("tailStyle", "Tail type", {ribbon: "Ribbon", tube: "Inflated tube"}, "ribbon"),
        number("tailLength", "Tail length · m", 0.01, 60, 0.01, 3),
        number("tailWidth", "Tail width / diameter · m", 0.01, 3, 0.005, 0.05),
        number("tailTaper", "Tip size · % of root", 5, 100, 1, 100),
        number("tailSpread", "Fan angle · °", 0, 60, 1, 0),
        number("tailDroop", "Droop in a 12-knot wind · °", 0, 80, 1, 15),
        number("tailMotion", "Motion in the wind · %", 0, 100, 1, 60),
        number("waveLength", "Wave length · % of tail", 20, 200, 1, 70),
        number("waveSpeed", "Wave speed · % of wind speed", 10, 100, 1, 55),
    ]},
    {name: "Colors & fabric", open: true, fields: [
        choice("kitePattern", "Pattern", {solid: "Solid", panels: "Alternating panels", rainbow: "Rainbow"}, "panels"),
        color("bodyColor", "Main color", "#d6353b"), color("accentColor", "Second color", "#f2c840"),
        color("tailColor", "Tail color", "#d6353b"),
        number("metalness", "Metallic finish", 0, 1, 0.01, 0),
        number("roughness", "Surface roughness", 0.08, 1, 0.01, 0.7),
        number("opacity", "Fabric opacity", 0.3, 1, 0.01, 1),
    ]},
    {name: "LED lights", open: true,
        note: "Fixed bulbs on the underside of the sail. Only their colors and brightness animate. Layout changes rebuild the array; patterns use the same positions. Brightness is a visual setting, not measured photometry.",
        fields: [...KITE_LED_PATTERN_FIELDS,
            number("ledSpokes", "Fixed radial strips", 4, 24, 1, 16),
            number("ledPerSpoke", "LEDs per strip", 2, 10, 1, 6),
            number("ledRings", "Center rings", 0, 3, 1, 2),
            number("ledCoverage", "Array diameter · % of sail", 10, 95, 1, 80),
            number("ledCenter", "Array center toward nose · %", -25, 25, 1, -5),
            number("ledRotation", "Array rotation · °", 0, 360, 1, 0),
        ]},
    {name: "LED Tail", open: true,
        note: "Lights attached along each tail or tentacle, following its motion in the wind. Independent of the sail LEDs; starts with steady blue light. Set Tails above to at least 1. Speed 0 holds the selected phase.",
        fields: [...KITE_LED_TAIL_PATTERN_FIELDS,
            number("ledTailCount", "LEDs per tail", 2, 64, 1, 32),
        ]},
    {name: "Flight", open: true, note: "Add Kite in Sitrec finds the line angle from these values and the wind. Lift and drag are estimates for the kite type, not measurements.", fields: [
        number("kiteMass", "Mass · kg", 0.005, 60, 0.005, 0.07),
        number("kiteArea", "Lifting area · m² (0 = from the shape)", 0, 300, 0.01, 0),
        number("liftCoefficient", "Lift coefficient", 0.05, 2, 0.01, 0.85),
        number("dragCoefficient", "Drag coefficient", 0.05, 2, 0.01, 0.65),
    ]},
];

export const isKite = p => p.vehicleType === "kite";
