const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const choice = (key, label, options, value) => ({key, label, options, value, type: "select"});
const color = (key, label, value) => ({key, label, value, type: "color"});

export const BIRD_FLIGHT_STYLES = {flap: "Flapping", glide: "Gliding · wings held still", bursts: "Flap, then glide"};
export const BIRD_WING_TIPS = {pointed: "Pointed", rounded: "Rounded", fingered: "Separate feathers (eagle, crane)"};
export const BIRD_TAIL_SHAPES = {rounded: "Rounded", square: "Square", wedge: "Wedge", pointed: "Long and pointed", forked: "Forked"};
export const BIRD_BILL_SHAPES = {pointed: "Pointed", hooked: "Hooked", flat: "Flat (duck, goose)", pouch: "Pouch (pelican)"};
export const BIRD_WING_PATTERNS = {plain: "None", tips: "Wing tips", flight: "Flight feathers",
    flightUnder: "Flight feathers, underside only", bars: "Two wing bars and the tips"};

export const BIRD_GROUPS = [
    {name: "Bird", open: true, note: "The bird is in its flight pose, with the bill toward +Z. The length is from the bill tip to the tail tip.", fields: [
        number("length", "Length, bill tip to tail tip · m", 0.01, 2, 0.005, 0.6),
        number("bodyDepth", "Body depth · % of length", 10, 45, 0.5, 23),
        number("headSize", "Head length · % of length", 4, 25, 0.5, 12),
        number("neckLength", "Neck length · % of length", 0, 40, 0.5, 5),
        choice("neckPose", "Neck in flight", {straight: "Stretched forward", folded: "Drawn back (heron, pelican)"}, "straight"),
        number("billLength", "Bill length · % of length", 2, 32, 0.5, 9),
        number("billDepth", "Bill depth · % of bill length", 8, 90, 1, 30),
        choice("billShape", "Bill shape", BIRD_BILL_SHAPES, "pointed"),
        choice("legs", "Legs in flight", {tucked: "Tucked in", trailing: "Trailing behind the tail"}, "tucked"),
        number("legLength", "Feet beyond the tail tip · % of length", 0, 40, 1, 15),
    ]},
    {name: "Wings", open: true, note: "The wingspan is for flat wings. The wrist is the bend at the front edge of the wing.", fields: [
        number("wingspan", "Wingspan · m", 0.01, 3.6, 0.01, 1.4),
        number("wingChord", "Wing chord · % of wingspan", 5, 30, 0.5, 12),
        number("armFraction", "Inner wing · % of wing length", 20, 65, 1, 45),
        number("wristSweep", "Outer wing swept back · °", 0, 50, 1, 18),
        number("wristDroop", "Outer wing droop · °", 0, 30, 1, 0),
        choice("wingTip", "Wing tip", BIRD_WING_TIPS, "pointed"),
    ]},
    {name: "Tail", fields: [
        number("tailLength", "Tail length · % of length", 5, 50, 0.5, 20),
        number("tailSpread", "Tail fan angle · °", 10, 140, 1, 40),
        choice("tailShape", "Tail shape", BIRD_TAIL_SHAPES, "rounded"),
    ]},
    {name: "Wing motion", open: true, note: "Each preset has a wingbeat rate for the cruising flight of its species: a measured value where one was found, or an estimate. In Sitrec the wings move with the sitch time.", fields: [
        choice("flightStyle", "Flight", BIRD_FLIGHT_STYLES, "flap"),
        number("wingbeatRate", "Wingbeats per second", 0.5, 25, 0.01, 3),
        number("flapAngle", "Flap angle, up and down · °", 5, 80, 1, 30),
        number("wingFold", "Wing fold on the upstroke · %", 0, 100, 1, 50),
        number("glideAngle", "Wing angle in a glide, + is up · °", -20, 35, 1, 3),
        number("burstBeats", "Wingbeats before each glide", 1, 40, 1, 6),
        number("glideSeconds", "Length of each glide · s", 0.2, 30, 0.1, 2),
    ]},
    {name: "Plumage", open: true, fields: [
        color("bodyColor", "Back", "#9aa3ab"), color("bellyColor", "Breast and belly", "#f4f4f0"),
        color("headColor", "Head", "#f4f4f0"), color("neckColor", "Neck", "#f4f4f0"),
        choice("headMark", "Head mark", {none: "None", cap: "Cap", cheek: "Cheek patch", collar: "Neck ring", nape: "Back of the neck"}, "none"),
        color("headMarkColor", "Head mark color", "#1d1f22"),
        color("wingColor", "Upper wing", "#9aa3ab"), color("underwingColor", "Underwing", "#f4f4f0"),
        choice("wingPattern", "Wing marks", BIRD_WING_PATTERNS, "plain"),
        color("markColor", "Wing mark color", "#1d1f22"),
        number("markExtent", "Wing mark size · %", 5, 80, 1, 22),
        color("tailColor", "Tail", "#f4f4f0"),
        number("tailBand", "Tail tip band · % of tail", 0, 70, 1, 0),
        color("tailBandColor", "Tail tip band color", "#1d1f22"),
        color("billColor", "Bill", "#e8c33c"), color("legColor", "Legs and feet", "#d99aa0"), color("eyeColor", "Eye", "#17150f"),
        number("roughness", "Feather roughness", 0.2, 1, 0.01, 0.8),
    ]},
];

export const isBird = p => p.vehicleType === "bird";
