// Named drones are editable family approximations, with unfolded rotor layouts.
// Motor-center spans are distinct from published envelopes including propellers.
const drones = [];
function drone(id, name, family, length, width, height, span, foreAft, rotor, source, changes = {}) {
    drones.push({id: `drone-${id}`, name: `${name}-style`, category: `Drones · ${family}`, region: "General", role: "Drone",
        parameters: {vehicleType: "drone", droneStyle: "multirotor", length, width, height, armSpan: span, armLength: foreAft,
            rotorDiameter: rotor, armThickness: Math.min(width * 0.22, 0.065), gearHeight: height * 0.5,
            cameraSize: width * 0.5, landingLights: false, beaconLights: false, strobeLights: false, ...changes},
        reference: {quality: "Approximate generated rotor envelope", length: foreAft + rotor, wingspan: span + rotor,
            lengthLabel: "fore-aft", spanLabel: "wide", source,
            description: "Manufacturer family reference. Body, motor spacing, propellers and equipment are editable approximations; displayed dimensions include the generated rotor sweep."}});
}
const DJI = "https://www.dji.com/";
drone("mini4", "DJI Mini 4 Pro", "DJI Mini & Air", .148, .073, .05, .22, .145, .1524, DJI+"mini-4-pro/specs");
drone("mini3", "DJI Mini 3 Pro", "DJI Mini & Air", .145, .072, .05, .215, .15, .1524, DJI+"mini-3-pro/specs");
drone("air2s", "DJI Air 2S", "DJI Mini & Air", .18, .087, .065, .26, .22, .185, DJI+"air-2s/specs");
drone("air3s", "DJI Air 3S", "DJI Mini & Air", .205, .10, .075, .30, .24, .22, DJI+"air-3s/specs", {cameraLenses: 2});
drone("mavic3", "DJI Mavic 3 Classic", "DJI Mavic", .215, .10, .075, .32, .26, .24, DJI+"mavic-3-classic/specs");
drone("mavic3pro", "DJI Mavic 3 Pro", "DJI Mavic", .23, .11, .08, .33, .27, .24, DJI+"mavic-3-pro/specs", {cameraLenses: 3});
drone("phantom4", "DJI Phantom 4 Pro", "DJI Phantom & Inspire", .19, .16, .09, .247, .247, .24, DJI+"phantom-4-pro/info", {bodyColor: "#eceef0", accentColor: "#dee0e2", droneGear: "skids", gearHeight: .15, cameraSize: .08});
drone("inspire2", "DJI Inspire 2", "DJI Phantom & Inspire", .32, .15, .11, .40, .45, .381, DJI+"inspire-2/info", {bodyColor: "#63696b", accentColor: "#222a30", droneGear: "skids", gearHeight: .22, armRise: .10, cameraSize: .11});
drone("inspire3", "DJI Inspire 3", "DJI Phantom & Inspire", .36, .17, .12, .43, .55, .4064, DJI+"inspire-3/specs", {bodyColor: "#53595c", accentColor: "#252a30", droneGear: "skids", gearHeight: .24, armRise: .12, cameraSize: .13});
drone("neo", "DJI Neo", "DJI FPV & compact", .10, .07, .035, .087, .075, .065, DJI+"neo/specs", {rotorGuards: true, guardHeight: .014, gearHeight: .012, cameraSize: .03});
drone("avata2", "DJI Avata 2", "DJI FPV & compact", .13, .07, .04, .133, .106, .0762, DJI+"avata-2/specs", {rotorGuards: true, rotorBlades: 3, guardHeight: .023, bodyColor: "#72777c", gearHeight: .015, cameraSize: .035});
drone("fpv", "DJI FPV", "DJI FPV & compact", .17, .09, .10, .205, .175, .135, DJI+"dji-fpv/specs", {bodyColor: "#555e65", accentColor: "#393f43", rotorBlades: 3, cameraPitch: -15});
drone("matrice30", "DJI Matrice 30", "DJI enterprise", .32, .20, .14, .52, .41, .30, "https://enterprise.dji.com/matrice-30/specs", {bodyColor: "#555c61", rtk: true, cameraLenses: 3, droneGear: "skids", gearHeight: .19});
drone("matrice350", "DJI Matrice 350 RTK", "DJI enterprise", .40, .28, .19, .69, .69, .53, "https://enterprise.dji.com/matrice-350-rtk/specs", {bodyColor: "#40484f", rtk: true, droneGear: "skids", gearHeight: .31, cameraSize: .15});
drone("matrice4", "DJI Matrice 4", "DJI enterprise", .28, .14, .11, .39, .34, .28, "https://enterprise.dji.com/matrice-4-series/specs", {bodyColor: "#646c70", rtk: true, lidar: true, cameraLenses: 3});
drone("agras-t50", "DJI Agras T50", "DJI agricultural", .75, .56, .36, 1.56, 1.45, 1.37, "https://ag.dji.com/t50/specs", {bodyColor: "#e2e5e2", accentColor: "#282f32", coaxial: true, cargoTank: true, camera: false, droneGear: "skids", gearHeight: .65});
drone("evo-nano", "Autel EVO Nano", "Autel", .145, .075, .05, .20, .145, .145, "https://www.autelrobotics.com/product/evo-nano-series/", {bodyColor: "#ed7c2d"});
drone("evo2", "Autel EVO II Pro", "Autel", .23, .12, .09, .34, .27, .23, "https://www.autelrobotics.com/product/evo-ii-pro-v3/", {bodyColor: "#e97b28"});
drone("evo-max", "Autel EVO Max 4T", "Autel", .29, .15, .11, .40, .33, .28, "https://www.autelrobotics.com/product/evo-max-series/", {bodyColor: "#61666d", cameraLenses: 3, lidar: true});
drone("anafi", "Parrot ANAFI", "Parrot & Skydio", .22, .05, .04, .22, .24, .13, "https://www.parrot.com/en/drones/technical-specifications-anafi-fpv", {bodyColor: "#434950", cameraSize: .05});
drone("anafi-usa", "Parrot ANAFI USA", "Parrot & Skydio", .25, .07, .06, .25, .26, .14, "https://www.parrot.com/en/drones/anafi-usa/technical-specifications", {bodyColor: "#666d70", cameraLenses: 3});
drone("skydio2", "Skydio 2", "Parrot & Skydio", .22, .08, .065, .25, .29, .17, "https://www.skydio.com/skydio-2-plus", {bodyColor: "#375d93", accentColor: "#26333f"});
drone("skydio-x10", "Skydio X10", "Parrot & Skydio", .35, .15, .10, .38, .52, .27, "https://www.skydio.com/x10/technical-specs", {bodyColor: "#454c50", cameraLenses: 3, lidar: true});
drone("typhoon-h", "Yuneec Typhoon H", "Yuneec & Freefly", .22, .22, .12, .48, .48, .254, "https://yuneec.com/typhoon-h-plus/", {rotorCount: 6, bodyColor: "#30373d", droneGear: "skids", gearHeight: .24});
drone("alta-x", "Freefly Alta X", "Yuneec & Freefly", .50, .50, .20, 1.10, 1.10, .84, "https://freeflysystems.com/alta-x/specs", {bodyColor: "#333c43", accentColor: "#262d32", cameraSize: .24, droneGear: "skids", gearHeight: .45});
drone("fpv-racer", "5-inch FPV racer", "FPV & generic", .12, .045, .035, .16, .16, .127, "ReferenceReview.md", {bodyColor: "#202831", accentColor: "#db6335", rotorBlades: 3, cameraPitch: -25, gearHeight: .015});
drone("tiny-whoop", "Tiny whoop", "FPV & generic", .05, .025, .022, .05, .05, .04, "ReferenceReview.md", {rotorGuards: true, rotorBlades: 3, bodyColor: "#f6cf3f", guardHeight: .012, armThickness: .004, gearHeight: .005, cameraSize: .017});
drone("hexacopter", "Survey hexacopter", "FPV & generic", .28, .24, .12, .65, .65, .30, "ReferenceReview.md", {rotorCount: 6, rtk: true, droneGear: "skids", gearHeight: .25});
drone("octocopter", "Heavy-lift octocopter", "FPV & generic", .5, .4, .2, 1.3, 1.3, .46, "ReferenceReview.md", {rotorCount: 8, droneGear: "skids", gearHeight: .45, cameraSize: .20});
for(const preset of drones) {
    if(["drone-phantom4","drone-fpv"].includes(preset.id))preset.parameters.droneBody="dome";
    if(preset.id.startsWith("drone-inspire"))preset.parameters.droneBody="spine";
    if(["drone-fpv-racer","drone-tiny-whoop","drone-avata2"].includes(preset.id))preset.parameters.droneBody="stack";
}
export const DRONE_PRESETS = drones;

const balloons = [];
function balloon(id, name, category, shape, width, height, length, changes = {}, source = "ReferenceReview.md") {
    balloons.push({id: `balloon-${id}`, name, category: `Balloons · ${category}`, region: "General", role: "Balloon",
        parameters: {vehicleType: "balloon", balloonShape: shape, width, height, length, positionLights: false, landingLights: false,
            strobeLights: false, beaconLights: false, suspended: "none", flame: false, balloonPattern: "solid", ...changes},
        reference: {quality: "Generic envelope", length, wingspan: width, lengthLabel: "deep / long", spanLabel: "wide", source,
            description: "Editable visual example. Envelope dimensions exclude the basket, lines and payload. No lift or thermal behavior is simulated."}});
}
const hot = {suspended: "basket", flame: true, balloonPattern: "rainbow"};
balloon("hotair", "Classic hot-air · rainbow gores", "Hot-air", "hotair", 15, 19, 15, hot, "https://www.cameronballoons.co.uk/our-range");
balloon("hotair-red", "Hot-air · red and cream", "Hot-air", "hotair", 15, 19, 15, {...hot, balloonPattern: "alternating", bodyColor: "#c93c36", accentColor: "#f3e5be"});
balloon("hotair-checker", "Hot-air · checkerboard", "Hot-air", "hotair", 17, 21, 17, {...hot, balloonPattern: "checker", bodyColor: "#24528e", accentColor: "#f6eee0"});
balloon("racer", "Sport balloon · tall envelope", "Hot-air", "hotair", 12, 22, 12, {...hot, fullness: .80, balloonPattern: "bands"});
balloon("passenger", "Passenger balloon · large basket", "Hot-air", "hotair", 22, 26, 22, {...hot, basketWidth: 4, suspension: 2.5, goreCount: 32});
balloon("weather", "Weather balloon · white latex", "Weather & gas", "sphere", 1.8, 2.0, 1.8, {bodyColor: "#eeeee2", suspended: "sonde", basketWidth: .10, suspension: 3, lobing: 0}, "https://www.vaisala.com/en/sounding-systems-radiosondes");
balloon("weather-large", "Weather balloon · expanded", "Weather & gas", "sphere", 8, 8, 8, {bodyColor: "#e2e1cb", suspended: "sonde", basketWidth: .15, suspension: 5, opacity: .75, lobing: 0});
balloon("pilot", "Pilot balloon · orange", "Weather & gas", "sphere", .8, .9, .8, {bodyColor: "#e85e25", basketWidth: .1, lobing: 0});
balloon("gas", "Gas balloon · round envelope", "Weather & gas", "sphere", 12, 12, 12, {bodyColor: "#e6d9ab", suspended: "basket", basketWidth: 1.5, suspension: 2, goreCount: 24});
balloon("party-red", "Party balloon · red latex", "Party & foil", "oval", .30, .40, .30, {bodyColor: "#d93543", tether: true, lobing: 0, roughness: .22});
balloon("party-blue", "Party balloon · blue latex", "Party & foil", "oval", .30, .40, .30, {bodyColor: "#347ed5", tether: true, lobing: 0, roughness: .22});
balloon("party-yellow", "Party balloon · yellow latex", "Party & foil", "oval", .32, .43, .32, {bodyColor: "#f4ce3a", tether: true, lobing: 0, roughness: .22});
balloon("foil-round", "Foil balloon · silver disc", "Party & foil", "foil", .46, .46, .16, {bodyColor: "#c6d2df", metalness: .85, roughness: .22, tether: true, lobing: 0});
balloon("foil-star", "Foil balloon · gold star", "Party & foil", "star", .5, .5, .14, {bodyColor: "#e8b840", metalness: .8, roughness: .2, tether: true, lobing: 0});
balloon("foil-heart", "Foil balloon · red heart", "Party & foil", "heart", .46, .48, .17, {bodyColor: "#d93055", metalness: .65, roughness: .2, tether: true, lobing: 0});
balloon("blimp", "Advertising blimp", "Blimps & solar", "blimp", 7, 7, 22, {bodyColor: "#dce2e5", suspended: "gondola", basketWidth: 1.5, suspension: .30, balloonFins: true, lobing: 0, balloonPattern: "bands"});
balloon("aerostat", "Tethered aerostat", "Blimps & solar", "blimp", 10, 10, 32, {bodyColor: "#e0dfd4", balloonFins: true, tether: true, tetherLength: 12, lobing: 0});
balloon("solar", "Solar balloon · black tube", "Blimps & solar", "solar", .8, .8, 4, {bodyColor: "#24252b", lobing: 0, roughness: .3, tether: true, tetherLength: 2});
balloon("lantern-white", "Sky lantern · warm white", "Sky lanterns", "lantern", .60, .90, .60, {bodyColor: "#fff0cf", flame: true, glow: .7, opacity: .88, lobing: 0});
balloon("lantern-red", "Sky lantern · red", "Sky lanterns", "lantern", .60, .90, .60, {bodyColor: "#d83e34", flame: true, glow: .55, opacity: .94, lobing: 0});
balloon("lantern-box", "Sky lantern · square paper", "Sky lanterns", "boxlantern", .55, .85, .55, {bodyColor: "#f6d185", flame: true, glow: .65, opacity: .9, lobing: 0});
balloon("lantern-pagoda", "Sky lantern · tapered", "Sky lanterns", "pagoda", .65, 1.0, .65, {bodyColor: "#efa949", flame: true, glow: .65, opacity: .9, lobing: 0});
export const BALLOON_PRESETS = balloons;
