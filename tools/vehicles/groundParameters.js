import {ukTransmission} from "./ukTransmission.js";

const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const color = (key, label, value) => ({key, label, value, type: "color"});
const seed = number("seed", "Shape seed", 1, 99999, 1, 47);
const height = (min, max, value) => number("height", "Height · m", min, max, .1, value);
const runLength = number("length", "Length · m", .5, 24, .1, 5.4);
const postSpacing = number("postSpacing", "Max post spacing · m", .6, 3.6, .05, 1.8);
const style = (key, value, options) => ({key, label: "Regional design", type: "select", value, options});

// These are visual starting dimensions in metres. The style key is also the
// sitrec:design value accepted on a mapped transmission support.
const transmissionPresets = [
    ["woodH", "wood-h-frame", "US timber H-frame", "US", {height:23, baseWidth:7, armSpan:14, shaftDiameter:.63}],
    ["linePost", "line-post", "US braced line-post monopole", "US", {height:26, armSpan:7, shaftDiameter:1}],
    ["davit", "davit-pole", "US double-circuit davit monopole", "US", {height:42, armSpan:13, shaftDiameter:1.7}],
    ["threePole", "three-pole-angle", "US three-pole angle structure", "US", {height:24, armSpan:18, shaftDiameter:.8}],
    ["guyedV", "guyed-v", "US guyed-V lattice tower", "US", {height:42, baseWidth:5, armSpan:36}],
    ["danube", "danube-pylon", "German Danube tower (Donaumast)", "Europe", {height:48, baseWidth:9, armSpan:32}],
    ["barrel", "barrel-pylon", "German barrel tower (Tonnenmast)", "Europe", {height:52, baseWidth:9, armSpan:23}],
    ["flat", "flat-pylon", "German single-level tower (Einebenenmast)", "Europe", {height:34, baseWidth:8, armSpan:46}],
    ["tPylon", "t-pylon", "British T-pylon", "Europe", {height:35, armSpan:29, shaftDiameter:2.2, steelColor:"#cbd1d0"}],
    ["wintrack", "wintrack", "Dutch Wintrack twin poles", "Europe", {height:58, baseWidth:20, armSpan:13,
        shaftDiameter:1.8, steelColor:"#d9ddda"}],
    ...Object.entries(ukTransmission).map(([key,{series,height,baseWidth,armSpan,description}]) =>
        [key,"uk-"+key.slice(2).toLowerCase(),`UK ${series} suspension tower`,"Europe",{height,baseWidth,armSpan},
            {description, quality:"British L-series standard dimensions", length:height, lengthLabel:"high",
                wingspan:armSpan, spanLabel:"crossarm span", source:key === "ukL2" ? "https://www.pylons.org/members/field/L2.pdf" :
                    "https://telcontar.net/Power/pylons/"+(key === "ukL4" ? "L4m" : key.slice(2))}]),
];
export const tubularTower = style => ["woodH","linePost","davit","threePole","tPylon","wintrack"].includes(style);

const forms = {
    brickWall: {name: "Brick wall", fields: [
        runLength, height(.3, 4, 1.6), number("thickness", "Thickness · m", .09, .6, .01, .22),
        color("brickColor", "Brick", "#ab5541"), color("mortarColor", "Mortar", "#c3b6a3"),
    ]},
    chainLink: {name: "Chain-link fence", fields: [
        runLength, height(.5, 4, 1.8), postSpacing, number("meshOpening", "Diamond width · m", .05, .2, .005, .085),
        color("wireColor", "Wire", "#919c9f"), color("frameColor", "Posts and rails", "#9ea8aa"),
    ]},
    woodFence: {name: "Wood fence", fields: [
        runLength, height(.4, 3, 1.1), postSpacing,
        {key: "boardStyle", label: "Board style", type: "select", value: "pointed",
            options: {pointed: "Pointed pickets", dogEar: "Dog-ear pickets", shadowbox: "Good-neighbor · alternating boards"}},
        number("boardWidth", "Board width · m", .06, .23, .005, .095),
        color("boardColor", "Boards", "#f1efe4"), color("frameColor", "Posts and rails", "#e5e1d4"),
    ]},
    railing: {name: "Metal railings", fields: [
        runLength, height(.4, 2.5, 1.05), postSpacing,
        {key: "railStyle", label: "Rail style", type: "select", value: "balusters",
            options: {balusters: "Vertical balusters", pipe: "Horizontal pipe rails"}},
        color("metalColor", "Metal", "#383d40"),
    ]},
    radioTower: {name: "Radio tower", fields: [
        height(12, 200, 60), number("baseWidth", "Foot spacing · m", 2, 20, .1, 8),
        number("bays", "Braced sections", 6, 28, 1, 14),
        color("shaftColor", "Tower paint", "#c84a31"), color("bandColor", "Contrasting bands", "#eeeae1"),
        {key: "lightsEnabled", label: "Obstruction lights", type: "checkbox", value: true},
        number("lightGain", "Light brightness multiplier", .1, 5, .1, 1),
        number("flashPeriod", "Beacon flash interval · s", .5, 5, .05, 2),
        number("flashDuration", "Beacon flash duration · s", .05, 1, .05, .5),
    ]},
    pylon: {name: "Transmission pole or tower", fields: [
        style("towerStyle", "us", {us: "North American · stacked crossarms", horizontal: "US · horizontal single circuit",
            british: "British · three-tier lattice", ...Object.fromEntries(transmissionPresets.map(([key,,name]) => [key,name]))}),
        height(10, 90, 36), number("baseWidth", "Foot spacing · m", 2, 22, .1, 7),
        number("armSpan", "Crossarm span · m", 5, 65, .1, 17),
        number("shaftDiameter", "Pole base diameter · m", .3, 4, .05, 1.2),
        number("armLevels", "Crossarm levels", 1, 3, 1, 3),
        number("bays", "Braced sections", 4, 14, 1, 8), color("steelColor", "Steel", "#788287"),
        color("woodColor", "Timber", "#866544"),
    ]},
    pole: {name: "Telegraph pole", fields: [
        style("poleStyle", "crossarm", {crossarm: "North American · timber crossarms",
            british: "British · timber with steel crossarm", vaulted: "French · concrete with vaulted crossarm"}),
        height(4, 22, 10), number("poleDiameter", "Butt diameter · m", .15, .8, .01, .34),
        number("armSpan", "Crossarm span · m", 1.5, 5, .1, 3.2),
        number("armLevels", "Crossarm levels", 1, 3, 1, 2), number("pins", "Insulators per side", 1, 5, 1, 3),
        color("woodColor", "Timber", "#795d45"), color("concreteColor", "Concrete", "#a39e94"),
    ]},
    chimney: {name: "Industrial chimney", fields: [
        height(5, 180, 44), number("baseDiameter", "Base diameter · m", 1, 18, .1, 4.2),
        number("topRatio", "Top / base diameter", .35, .95, .01, .64),
        number("bands", "Contrasting bands", 0, 6, 1, 3),
        color("shaftColor", "Shaft", "#aa5842"), color("bandColor", "Bands", "#e6dfce"),
    ]},
    cooling: {name: "Natural-draft cooling tower", fields: [
        height(15, 200, 82), number("baseDiameter", "Base diameter · m", 12, 160, .5, 62),
        number("throatRatio", "Throat / base diameter", .42, .80, .01, .57),
        number("throatLevel", "Throat height · %", 60, 85, 1, 75), color("shellColor", "Concrete", "#b4b1a5"),
    ]},
    tree: {name: "Tree", fields: [
        {key: "treeForm", label: "Growth habit", type: "select", value: "oak",
            options: {oak: "Spreading oak", pine: "Conifer", palm: "Feather palm"}},
        height(2, 45, 12), number("crownWidth", "Crown width · m", 1, 28, .1, 13),
        number("density", "Crown density", 1, 5, 1, 3), seed,
        color("woodColor", "Bark", "#645044"), color("leafColor", "Foliage", "#587340"),
    ]},
    boulder: {name: "Boulder", fields: [
        height(.3, 15, 2), number("width", "Width · m", .3, 24, .1, 3.4),
        number("depth", "Depth · m", .3, 24, .1, 2.6),
        number("irregularity", "Surface irregularity", 0, 1, .01, .65), seed,
        color("stoneColor", "Stone", "#8e877a"),
    ]},
};

export const isGroundObject = p => p.vehicleType === "ground";
export const groundKind = p => Object.hasOwn(forms, p.groundKind) ? p.groundKind : "pylon";
export const groundShapeGroup = p => ({...forms[groundKind(p)], open: true});

function preset(id, name, kind, group, parameters = {}, region = kind === "pylon" ? "US" : "General") {
    return {id: "ground-" + id, name, category: "Ground objects · " + group,
        region, parameters: {vehicleType: "ground", groundKind: kind, ...parameters}};
}
export const GROUND_PRESETS = [
    preset("pylon", "US high-voltage transmission pylon", "pylon", "Utilities"),
    preset("telegraph-pole", "Wooden telegraph pole", "pole", "Utilities"),
    preset("horizontal-pylon", "US single-circuit horizontal pylon", "pylon", "Utilities",
        {towerStyle:"horizontal", height:48, baseWidth:12, armSpan:40}),
    preset("british-pylon", "British double-circuit lattice pylon", "pylon", "Utilities",
        {towerStyle:"british", height:45, baseWidth:9, armSpan:21}, "Europe"),
    ...transmissionPresets.map(([towerStyle,id,name,region,dimensions,reference]) =>
        ({...preset(id,name,"pylon","Utilities",{towerStyle,...dimensions},region),reference})),
    preset("british-pole", "British timber distribution pole", "pole", "Utilities",
        {poleStyle:"british", height:11, armSpan:2.9, armLevels:1}, "Europe"),
    preset("french-pole", "French concrete distribution pole", "pole", "Utilities",
        {poleStyle:"vaulted", height:12, armSpan:4.5, armLevels:1}, "Europe"),
    preset("radio-tower", "Radio tower with lights", "radioTower", "Communications"),
    preset("brick-wall", "Brick wall", "brickWall", "Walls and fences"),
    preset("chain-link-fence", "Chain-link fence", "chainLink", "Walls and fences", {postSpacing: 2.7}),
    preset("white-picket-fence", "White picket fence", "woodFence", "Walls and fences"),
    preset("brown-picket-fence", "Brown picket fence", "woodFence", "Walls and fences",
        {boardStyle: "dogEar", boardColor: "#976741", frameColor: "#795237", height: 1.2}),
    preset("good-neighbor-fence", "Good-neighbor wood fence", "woodFence", "Walls and fences",
        {boardStyle: "shadowbox", boardWidth: .145, boardColor: "#ad825a", frameColor: "#8c674a", height: 1.8}),
    preset("metal-railings", "Black metal railings", "railing", "Walls and fences"),
    preset("pipe-railings", "Galvanized metal pipe railings", "railing", "Walls and fences",
        {railStyle: "pipe", metalColor: "#9aa4a7"}),
    preset("chimney", "Industrial chimney", "chimney", "Industry"),
    preset("cooling-tower", "Natural-draft cooling tower", "cooling", "Industry"),
    preset("oak", "Spreading oak tree", "tree", "Trees"),
    preset("pine", "Pine tree", "tree", "Trees", {treeForm: "pine", height: 18, crownWidth: 7.5, leafColor: "#395e46"}),
    preset("palm", "Feather palm tree", "tree", "Trees", {treeForm: "palm", height: 11, crownWidth: 8, woodColor: "#887a64", leafColor: "#567d3f"}),
    preset("boulder", "Weathered boulder", "boulder", "Rocks"),
];
