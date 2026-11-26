const number = (key, label, min, max, step, value) => ({key, label, min, max, step, value, type: "number"});
const color = (key, label, value) => ({key, label, value, type: "color"});
const seed = number("seed", "Shape seed", 1, 99999, 1, 47);
const height = (min, max, value) => number("height", "Height · m", min, max, .1, value);
const style = (key, value, options) => ({key, label: "Regional design", type: "select", value, options});

const forms = {
    pylon: {name: "Lattice transmission tower", fields: [
        style("towerStyle", "us", {us: "North American · stacked crossarms", horizontal: "US · horizontal single circuit",
            british: "British · three-tier lattice"}),
        height(10, 90, 36), number("baseWidth", "Foot spacing · m", 2, 22, .1, 7),
        number("armSpan", "Crossarm span · m", 5, 65, .1, 17),
        number("armLevels", "Crossarm levels", 1, 3, 1, 3),
        number("bays", "Braced sections", 4, 14, 1, 8), color("steelColor", "Steel", "#788287"),
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
    preset("british-pole", "British timber distribution pole", "pole", "Utilities",
        {poleStyle:"british", height:11, armSpan:2.9, armLevels:1}, "Europe"),
    preset("french-pole", "French concrete distribution pole", "pole", "Utilities",
        {poleStyle:"vaulted", height:12, armSpan:4.5, armLevels:1}, "Europe"),
    preset("chimney", "Industrial chimney", "chimney", "Industry"),
    preset("cooling-tower", "Natural-draft cooling tower", "cooling", "Industry"),
    preset("oak", "Spreading oak tree", "tree", "Trees"),
    preset("pine", "Pine tree", "tree", "Trees", {treeForm: "pine", height: 18, crownWidth: 7.5, leafColor: "#395e46"}),
    preset("palm", "Feather palm tree", "tree", "Trees", {treeForm: "palm", height: 11, crownWidth: 8, woodColor: "#887a64", leafColor: "#567d3f"}),
    preset("boulder", "Weathered boulder", "boulder", "Rocks"),
];
