// Generic birds of common species, in the flight pose. Length and wingspan are the
// middle of the range on the linked species page. A wingbeat rate with a source
// (`from`) is a measured value. One without is an estimate, as are the shapes and the
// plumage. README.md ("Birds") has the sources in full.
const birds = [];
const P90 = "Pennycuick 1990", P01 = "Pennycuick 2001", K22 = "Krishnan et al. 2022";
function bird(id, name, category, {length, wingspan, page, rate, from}, ...changes) {
    const parameters = Object.assign({vehicleType: "bird", length, wingspan, wingbeatRate: rate}, ...changes);
    birds.push({id: `bird-${id}`, name, category: `Birds · ${category}`, region: "General", role: "Bird", parameters,
        reference: {quality: "Typical size", length, wingspan, lengthLabel: "bill tip to tail tip", spanLabel: "wingspan",
            source: `https://en.wikipedia.org/wiki/${page}`, wingbeatSource: from ?? null,
            description: "Editable visual example of a bird in flight, at a typical size for the species."
                + (parameters.neckPose === "folded" ? " Its neck is drawn back, so its length in flight is an estimate." : "")
                + ` The wingbeat rate of ${rate} per second is ${from ? `a measured value (${from})` : "an estimate"}.`
                + " The shape and the plumage are estimates."}});
}

const WHITE = "#f3f2ec", BLACK = "#1b1c1f", YELLOW = "#e6bd35", PINK = "#d9a39d", DARK_LEG = "#2a2a2c";
const all = color => ({bodyColor: color, bellyColor: color, headColor: color, neckColor: color, wingColor: color, underwingColor: color, tailColor: color});

// ---- Gulls: long pointed wings with a bend at the wrist, pale below. ----
const gull = {bodyDepth: 23, headSize: 12, neckLength: 4, billLength: 9, billDepth: 34, billShape: "hooked", tailLength: 21, tailSpread: 34,
    tailShape: "square", wingChord: 11.5, armFraction: 45, wristSweep: 20, wristDroop: 8, wingTip: "pointed", flapAngle: 30, wingFold: 45,
    glideAngle: 5, ...all(WHITE), bodyColor: "#a9b1b9", wingColor: "#a9b1b9", wingPattern: "tips", markColor: BLACK, markExtent: 20,
    billColor: YELLOW, legColor: PINK, eyeColor: "#d8c98a"};
const herringGull = {length: 0.60, wingspan: 1.40, page: "European_herring_gull", rate: 3.05, from: P90};
bird("gull-herring", "Herring gull · adult", "Gulls", herringGull, gull);
bird("gull-herring-young", "Herring gull · first year, brown", "Gulls", herringGull, gull,
    {...all("#8a7663"), bellyColor: "#9c8a78", underwingColor: "#8d7b69", markColor: "#3c322b", markExtent: 28,
        tailBand: 45, tailBandColor: "#3c322b", billColor: "#2c2826", eyeColor: "#17150f"});
bird("gull-ring-billed", "Ring-billed gull", "Gulls", {length: 0.48, wingspan: 1.11, page: "Ring-billed_gull", rate: 3.2}, gull,
    {bodyColor: "#b3bbc3", wingColor: "#b3bbc3", legColor: YELLOW, markExtent: 22});
bird("gull-laughing", "Laughing gull · black hood", "Gulls", {length: 0.39, wingspan: 1.04, page: "Laughing_gull", rate: 2.74, from: P90}, gull,
    {bodyColor: "#5d646d", wingColor: "#5d646d", headColor: BLACK, markExtent: 26, billColor: "#7a2320", legColor: "#4a2a28", eyeColor: "#17150f"});
bird("gull-black-headed", "Black-headed gull · brown hood", "Gulls", {length: 0.37, wingspan: 1.05, page: "Black-headed_gull", rate: 3.27, from: P01}, gull,
    {bodyColor: "#c3c9cf", wingColor: "#c3c9cf", headColor: "#3d2b24", markExtent: 10, billColor: "#8f1d1d", legColor: "#a82a22", eyeColor: "#17150f"});
bird("gull-great-black-backed", "Great black-backed gull", "Gulls", {length: 0.71, wingspan: 1.60, page: "Great_black-backed_gull", rate: 2.90, from: P90}, gull,
    {bodyColor: "#2b2d31", wingColor: "#2b2d31", markExtent: 14, bodyDepth: 25});

// ---- Pelicans: neck drawn back, long bill with a pouch, long broad wings. They flap and then glide. ----
const pelican = {bodyDepth: 22, headSize: 9, neckLength: 26, neckPose: "folded", billLength: 23, billDepth: 16, billShape: "pouch",
    tailLength: 11, tailSpread: 50, tailShape: "square", wingChord: 14, armFraction: 55, wristSweep: 8, wristDroop: 4, wingTip: "fingered",
    flightStyle: "bursts", burstBeats: 5, glideSeconds: 2.5, flapAngle: 26, wingFold: 30, glideAngle: 2, eyeColor: "#17150f"};
bird("pelican-white", "American white pelican", "Pelicans", {length: 1.32, wingspan: 2.70, page: "American_white_pelican", rate: 2.5}, pelican,
    {...all(WHITE), wingPattern: "flight", markColor: BLACK, markExtent: 42, billColor: "#e89a3c", legColor: "#e08a35"});
bird("pelican-brown", "Brown pelican", "Pelicans", {length: 1.07, wingspan: 2.15, page: "Brown_pelican", rate: 3.01, from: P90}, pelican,
    {...all("#7d7468"), bellyColor: "#4f4840", headColor: "#e9dfb5", neckColor: "#5a3a2a", wingPattern: "flight", markColor: "#3b3631", markExtent: 45,
        tailColor: "#4a443d", billColor: "#8d8778", legColor: "#3a3a3c"});

// ---- Cranes: long straight neck, long legs behind the tail, broad wings with separate tip feathers. ----
const crane = {bodyDepth: 17, headSize: 6.5, neckLength: 23, billLength: 9, billDepth: 20, billShape: "pointed", legs: "trailing", legLength: 22,
    tailLength: 9, tailSpread: 40, tailShape: "rounded", wingChord: 17, armFraction: 52, wristSweep: 6, wingTip: "fingered",
    flapAngle: 26, wingFold: 25, glideAngle: 2, billColor: "#6f6a5c", legColor: DARK_LEG, eyeColor: "#c98b2c"};
bird("crane-sandhill", "Sandhill crane", "Cranes", {length: 1.20, wingspan: 2.00, page: "Sandhill_crane", rate: 2.8}, crane,
    {...all("#9c9a96"), headColor: "#b9b6b0", wingPattern: "flight", markColor: "#5b5a59", markExtent: 40, headMark: "cap", headMarkColor: "#b3262a"});
bird("crane-whooping", "Whooping crane", "Cranes", {length: 1.32, wingspan: 2.15, page: "Whooping_crane", rate: 2.6}, crane,
    {...all(WHITE), wingPattern: "tips", markColor: BLACK, markExtent: 26, headMark: "cap", headMarkColor: "#b3262a"});
bird("crane-common", "Common crane", "Cranes", {length: 1.15, wingspan: 2.10, page: "Common_crane", rate: 2.7}, crane,
    {...all("#9aa0a4"), headColor: "#2a2b2e", neckColor: "#2a2b2e", wingPattern: "flight", markColor: "#2a2b2e", markExtent: 42,
        headMark: "cap", headMarkColor: "#b3262a"});

// ---- Ravens and crows: all black, broad wings, a wedge tail on the raven. ----
const corvid = {bodyDepth: 25, headSize: 13, neckLength: 4, billLength: 10, billDepth: 42, billShape: "pointed", tailLength: 30, tailSpread: 42,
    wingChord: 18, armFraction: 45, wristSweep: 12, wingTip: "fingered", flapAngle: 34, wingFold: 45, glideAngle: 2,
    ...all(BLACK), bellyColor: "#202124", billColor: "#17181a", legColor: "#17181a", eyeColor: "#2a2118", roughness: 0.5};
bird("raven", "Common raven", "Ravens & crows", {length: 0.63, wingspan: 1.35, page: "Common_raven", rate: 3.3}, corvid, {tailShape: "wedge"});
bird("crow", "American crow", "Ravens & crows", {length: 0.46, wingspan: 0.93, page: "American_crow", rate: 3.8}, corvid,
    {tailShape: "rounded", tailLength: 27, billLength: 9, billDepth: 38, wristSweep: 10});

// ---- Pigeons and doves: plump body, small head, pointed wings, fast wingbeat. ----
const pigeon = {bodyDepth: 30, headSize: 11, neckLength: 5, billLength: 5, billDepth: 34, billShape: "pointed", tailLength: 28, tailSpread: 36,
    tailShape: "rounded", wingChord: 16, armFraction: 38, wristSweep: 22, wingTip: "pointed", flapAngle: 52, wingFold: 70, glideAngle: 12,
    billColor: "#3a3836", legColor: "#b8443c", eyeColor: "#d8792b"};
const rockPigeon = {length: 0.33, wingspan: 0.65, page: "Rock_dove", rate: 5.48, from: "Taylor et al. 2019"};
bird("pigeon-blue", "Rock pigeon · blue-gray, two bars", "Pigeons & doves", rockPigeon, pigeon,
    {bodyColor: "#8e9aa6", bellyColor: "#7f8a96", headColor: "#5f6a78", neckColor: "#4e6a62", wingColor: "#a7b0b9", underwingColor: "#e8e8e4",
        wingPattern: "bars", markColor: "#24262a", markExtent: 20, tailColor: "#7a8591", tailBand: 28, tailBandColor: "#24262a"});
bird("pigeon-checker", "Rock pigeon · dark checker", "Pigeons & doves", rockPigeon, pigeon,
    {...all("#4d5560"), neckColor: "#3f5a54", underwingColor: "#c9cbcc", wingPattern: "tips", markColor: "#23252a", markExtent: 30,
        tailBand: 28, tailBandColor: "#1f2125"});
bird("pigeon-red", "Rock pigeon · red and white", "Pigeons & doves", rockPigeon, pigeon,
    {...all("#a5553a"), bellyColor: "#b9694a", wingColor: "#c98a6c", underwingColor: WHITE, wingPattern: "tips", markColor: WHITE, markExtent: 40,
        tailColor: "#e9e2d8", billColor: "#c9a79a"});
bird("dove-white", "White dove · release dove", "Pigeons & doves", rockPigeon, pigeon, {...all(WHITE), billColor: "#d8b8b0", eyeColor: "#2a2118"});
bird("dove-mourning", "Mourning dove", "Pigeons & doves", {length: 0.31, wingspan: 0.41, page: "Mourning_dove", rate: 7.5}, pigeon,
    {bodyDepth: 25, headSize: 9.5, tailLength: 42, tailSpread: 26, tailShape: "pointed", wingChord: 17, ...all("#a89680"), bellyColor: "#c9ad92",
        headColor: "#b8a48c", wingColor: "#8f8272", underwingColor: "#8b8f96", wingPattern: "tips", markColor: "#4c463f", markExtent: 30,
        tailBand: 18, tailBandColor: WHITE, eyeColor: "#17150f"});
bird("dove-collared", "Eurasian collared dove", "Pigeons & doves", {length: 0.32, wingspan: 0.51, page: "Eurasian_collared_dove", rate: 6.5}, pigeon,
    {bodyDepth: 27, tailLength: 36, tailSpread: 34, tailShape: "square", ...all("#bcae9d"), bellyColor: "#cbbdaf", wingColor: "#b0a290",
        underwingColor: "#d9d2c8", wingPattern: "tips", markColor: "#55504a", markExtent: 30, tailColor: "#6f6a64", tailBand: 45, tailBandColor: WHITE,
        headMark: "nape", headMarkColor: BLACK, eyeColor: "#7a1f1c"});

// ---- Geese, swans and ducks: long straight neck, flat bill, pointed wings, steady flapping. ----
const goose = {bodyDepth: 21, headSize: 8, neckLength: 22, billLength: 6, billDepth: 50, billShape: "flat", tailLength: 13, tailSpread: 40,
    tailShape: "rounded", wingChord: 14, armFraction: 45, wristSweep: 14, wingTip: "pointed", flapAngle: 32, wingFold: 30, glideAngle: 0,
    eyeColor: "#17150f"};
bird("goose-canada", "Canada goose", "Geese, swans & ducks", {length: 0.93, wingspan: 1.56, page: "Canada_goose", rate: 4}, goose,
    {bodyColor: "#6b5a49", bellyColor: "#c4b5a1", headColor: BLACK, neckColor: BLACK, headMark: "cheek", headMarkColor: WHITE,
        wingColor: "#5d4e40", underwingColor: "#5a5048", wingPattern: "flight", markColor: "#2e2a27", markExtent: 40, tailColor: BLACK,
        billColor: BLACK, legColor: BLACK});
bird("goose-snow", "Snow goose", "Geese, swans & ducks", {length: 0.76, wingspan: 1.50, page: "Snow_goose", rate: 4.3}, goose,
    {...all(WHITE), neckLength: 17, wingPattern: "tips", markColor: BLACK, markExtent: 28, billColor: "#d97a8c", legColor: "#d97a8c"});
bird("swan-mute", "Mute swan", "Geese, swans & ducks", {length: 1.50, wingspan: 2.20, page: "Mute_swan", rate: 3.38, from: P01}, goose,
    {...all(WHITE), neckLength: 33, headSize: 7, bodyDepth: 18, tailLength: 10, billColor: "#e2702a", legColor: BLACK});
bird("swan-tundra", "Tundra swan", "Geese, swans & ducks", {length: 1.32, wingspan: 1.90, page: "Tundra_swan", rate: 3.6}, goose,
    {...all(WHITE), neckLength: 31, headSize: 7, bodyDepth: 18, tailLength: 10, billColor: BLACK, legColor: BLACK});
bird("duck-mallard", "Mallard · male", "Geese, swans & ducks",
    {length: 0.58, wingspan: 0.90, page: "Mallard", rate: 8.4, from: "Williamson, Dial & Biewener 2001, in slow flight"}, goose,
    {bodyDepth: 25, headSize: 10.5, neckLength: 12, billLength: 9, billDepth: 34, tailLength: 13, wingChord: 13.5, wristSweep: 18, flapAngle: 40,
        bodyColor: "#7c766e", bellyColor: "#bdb8b0", headColor: "#1f5a3c", neckColor: "#5a2f25", headMark: "collar", headMarkColor: WHITE,
        wingColor: "#7a7067", underwingColor: "#e4e2dc", wingPattern: "tips", markColor: "#4a443f", markExtent: 30, tailColor: "#d9d6cf",
        billColor: "#c9b53a", legColor: "#e07a2c"});

// ---- Eagles, hawks and vultures: broad wings with separate tip feathers. They glide, or flap and then glide. ----
const eagle = {bodyDepth: 25, headSize: 12, neckLength: 4, billLength: 8, billDepth: 60, billShape: "hooked", tailLength: 30, tailSpread: 55,
    tailShape: "rounded", wingChord: 21, armFraction: 48, wristSweep: 5, wingTip: "fingered", flightStyle: "glide", flapAngle: 30, wingFold: 30,
    glideAngle: 2, burstBeats: 4, glideSeconds: 5, billColor: YELLOW, legColor: YELLOW, eyeColor: "#d9c26a"};
const baldEagle = {length: 0.86, wingspan: 2.05, page: "Bald_eagle", rate: 2.72, from: P90};
bird("eagle-bald", "Bald eagle · adult", "Eagles, hawks & vultures", baldEagle, eagle,
    {flightStyle: "bursts", ...all("#3a2c22"), headColor: WHITE, neckColor: WHITE, tailColor: WHITE, bellyColor: "#33261d"});
bird("eagle-bald-young", "Bald eagle · young, dark", "Eagles, hawks & vultures", baldEagle, eagle,
    {flightStyle: "bursts", ...all("#4a3a2c"), bellyColor: "#5e4a38", underwingColor: "#7a6a58", wingPattern: "flightUnder", markColor: "#3a2e24",
        markExtent: 45, tailColor: "#7d7163", tailBand: 30, tailBandColor: "#30261d", billColor: "#3a3530", eyeColor: "#4a3a2a"});
bird("eagle-golden", "Golden eagle", "Eagles, hawks & vultures",
    {length: 0.84, wingspan: 2.07, page: "Golden_eagle", rate: 2.5, from: "Laurent et al. 2021, as given by Gupta et al. 2024"}, eagle,
    {...all("#3f3024"), headColor: "#8f6f3f", neckColor: "#8f6f3f", tailLength: 32, glideAngle: 5, billColor: "#3a3530", eyeColor: "#7a5a2a"});
bird("hawk-red-tailed", "Red-tailed hawk", "Eagles, hawks & vultures", {length: 0.55, wingspan: 1.28, page: "Red-tailed_hawk", rate: 3.5}, eagle,
    {bodyDepth: 27, headSize: 13, billLength: 6, wingChord: 22, tailLength: 30, tailSpread: 70, bodyColor: "#5d4634", bellyColor: "#e6dcc8",
        headColor: "#6a503c", neckColor: "#6a503c", wingColor: "#5d4634", underwingColor: "#e8dfcc", wingPattern: "tips", markColor: "#3a2c22",
        markExtent: 16, tailColor: "#b0572f", glideAngle: 4});
bird("vulture-turkey", "Turkey vulture", "Eagles, hawks & vultures", {length: 0.72, wingspan: 1.75, page: "Turkey_vulture", rate: 2.99, from: P90}, eagle,
    {bodyDepth: 22, headSize: 9, billLength: 7, billDepth: 45, tailLength: 32, tailSpread: 34, wingChord: 20, ...all("#2d2824"),
        headColor: "#a8342e", underwingColor: "#2d2824", wingPattern: "flightUnder", markColor: "#a9a6a0", markExtent: 55, glideAngle: 18,
        billColor: "#e8e2d2", legColor: "#c9b0a8", eyeColor: "#17150f"});

// ---- Herons, egrets and storks: long legs behind the tail, broad wings, slow wingbeat. ----
const heron = {bodyDepth: 19, headSize: 9, neckLength: 28, neckPose: "folded", billLength: 14, billDepth: 20, billShape: "pointed", legs: "trailing",
    legLength: 24, tailLength: 11, tailSpread: 36, tailShape: "square", wingChord: 21, armFraction: 50, wristSweep: 8, wristDroop: 12, wingTip: "rounded",
    flapAngle: 30, wingFold: 35, glideAngle: 6, eyeColor: "#d9c26a"};
bird("heron-great-blue", "Great blue heron", "Herons, egrets & storks", {length: 0.86, wingspan: 1.84, page: "Great_blue_heron", rate: 2.55, from: P90}, heron,
    {...all("#6f7f8f"), bellyColor: "#5f6770", headColor: "#e9e6de", neckColor: "#a59a94", headMark: "cap", headMarkColor: "#23262c",
        wingPattern: "flight", markColor: "#2f3640", markExtent: 45, billColor: "#d9a83a", legColor: "#4a4640"});
bird("egret-great", "Great egret", "Herons, egrets & storks", {length: 0.69, wingspan: 1.50, page: "Great_egret", rate: 2.79, from: P90}, heron,
    {...all(WHITE), billColor: "#e3b12e", legColor: BLACK});
bird("stork-white", "White stork", "Herons, egrets & storks", {length: 1.08, wingspan: 1.85, page: "White_stork", rate: 2.8}, heron,
    {neckPose: "straight", neckLength: 20, headSize: 7, billLength: 16, billDepth: 17, legLength: 18, wingTip: "fingered", wristDroop: 0, wingChord: 19,
        ...all(WHITE), wingPattern: "flight", markColor: BLACK, markExtent: 48, billColor: "#d5372a", legColor: "#d5372a", eyeColor: "#17150f",
        flightStyle: "bursts", burstBeats: 6, glideSeconds: 3});

// ---- Seabirds ----
bird("frigatebird", "Magnificent frigatebird", "Seabirds", {length: 1.02, wingspan: 2.30, page: "Magnificent_frigatebird", rate: 2.24, from: P90},
    {bodyDepth: 14, headSize: 8, neckLength: 5, billLength: 11, billDepth: 20, billShape: "hooked", tailLength: 40, tailSpread: 30, tailShape: "forked",
        wingChord: 8.5, armFraction: 45, wristSweep: 28, wristDroop: 10, wingTip: "pointed", flightStyle: "glide", flapAngle: 28, wingFold: 40,
        glideAngle: 6, ...all("#1f1e22"), billColor: "#6f6a66", legColor: "#3a3432", eyeColor: "#17150f", roughness: 0.55});
bird("albatross-laysan", "Laysan albatross", "Seabirds", {length: 0.81, wingspan: 1.99, page: "Laysan_albatross", rate: 3},
    {bodyDepth: 22, headSize: 11, neckLength: 5, billLength: 12, billDepth: 30, billShape: "hooked", tailLength: 14, tailSpread: 34, tailShape: "square",
        wingChord: 7.5, armFraction: 58, wristSweep: 8, wristDroop: 6, wingTip: "pointed", flightStyle: "glide", flapAngle: 22, wingFold: 20,
        glideAngle: -4, ...all(WHITE), bodyColor: "#3a3836", wingColor: "#33312f", wingPattern: "tips", markColor: "#2a2927", markExtent: 18,
        tailColor: "#3a3836", billColor: "#e0b8a0", legColor: "#d8b8b0", eyeColor: "#17150f"});
bird("gannet", "Northern gannet", "Seabirds", {length: 0.94, wingspan: 1.75, page: "Northern_gannet", rate: 3.53, from: P90},
    {bodyDepth: 20, headSize: 10, neckLength: 9, billLength: 10, billDepth: 30, billShape: "pointed", tailLength: 20, tailSpread: 22, tailShape: "pointed",
        wingChord: 10, armFraction: 48, wristSweep: 14, wingTip: "pointed", flightStyle: "bursts", burstBeats: 6, glideSeconds: 2, flapAngle: 28,
        wingFold: 30, glideAngle: 0, ...all(WHITE), headColor: "#ead9a0", wingPattern: "tips", markColor: BLACK, markExtent: 30, billColor: "#aab6c2",
        legColor: "#3a3a3c", eyeColor: "#aab6c2"});
bird("cormorant", "Double-crested cormorant", "Seabirds", {length: 0.80, wingspan: 1.19, page: "Double-crested_cormorant", rate: 5.03, from: P90},
    {bodyDepth: 19, headSize: 8, neckLength: 17, billLength: 8, billDepth: 28, billShape: "hooked", tailLength: 19, tailSpread: 30, tailShape: "wedge",
        wingChord: 15, armFraction: 45, wristSweep: 12, wingTip: "rounded", flapAngle: 34, wingFold: 30, glideAngle: 0, ...all("#232426"),
        billColor: "#8a7a4a", legColor: "#1f1f21", eyeColor: "#2f8f8a", roughness: 0.55});

// ---- An owl and small birds ----
bird("owl-barn", "Barn owl", "Owls & small birds", {length: 0.34, wingspan: 0.88, page: "Western_barn_owl", rate: 4.4, from: K22},
    {bodyDepth: 30, headSize: 21, neckLength: 0, billLength: 4, billDepth: 60, billShape: "hooked", tailLength: 22, tailSpread: 44, tailShape: "square",
        wingChord: 21, armFraction: 45, wristSweep: 8, wingTip: "rounded", flapAngle: 38, wingFold: 40, glideAngle: 6, bodyColor: "#c9a36a",
        bellyColor: WHITE, headColor: "#efe9df", neckColor: "#e3d2b4", wingColor: "#c39a62", underwingColor: WHITE, tailColor: "#cfae7a",
        billColor: "#e0d2c0", legColor: "#d8cfc0", eyeColor: "#17150f"});
bird("starling", "European starling", "Owls & small birds", {length: 0.21, wingspan: 0.37, page: "Common_starling", rate: 10.6, from: P01},
    {bodyDepth: 30, headSize: 14, neckLength: 3, billLength: 10, billDepth: 26, billShape: "pointed", tailLength: 24, tailSpread: 30, tailShape: "square",
        wingChord: 17, armFraction: 35, wristSweep: 24, wingTip: "pointed", flapAngle: 55, wingFold: 70, glideAngle: 4, ...all("#22242b"),
        underwingColor: "#4a4b52", billColor: "#d8b83a", legColor: "#a8603a", eyeColor: "#17150f", roughness: 0.5});
bird("swift", "Common swift", "Owls & small birds",
    {length: 0.165, wingspan: 0.39, page: "Common_swift", rate: 8.6, from: "Henningsson, Spedding & Hedenström 2008"},
    {bodyDepth: 22, headSize: 14, neckLength: 0, billLength: 4, billDepth: 40, billShape: "pointed", tailLength: 28, tailSpread: 24, tailShape: "forked",
        wingChord: 9, armFraction: 24, wristSweep: 34, wristDroop: 8, wingTip: "pointed", flightStyle: "bursts", burstBeats: 8, glideSeconds: 1,
        flapAngle: 45, wingFold: 30, glideAngle: -6, ...all("#322c2a"), billColor: "#1f1c1b", legColor: "#1f1c1b", eyeColor: "#17150f"});
bird("swallow-barn", "Barn swallow", "Owls & small birds", {length: 0.18, wingspan: 0.33, page: "Barn_swallow", rate: 7},
    {bodyDepth: 23, headSize: 14, neckLength: 1, billLength: 4, billDepth: 40, billShape: "pointed", tailLength: 40, tailSpread: 30, tailShape: "forked",
        wingChord: 12, armFraction: 30, wristSweep: 28, wingTip: "pointed", flightStyle: "bursts", burstBeats: 6, glideSeconds: 0.6, flapAngle: 50,
        wingFold: 55, glideAngle: 0, bodyColor: "#1f2f52", bellyColor: "#e9dccb", headColor: "#1f2f52", neckColor: "#8a3a22", wingColor: "#232a3e",
        underwingColor: "#d9cdbd", tailColor: "#1c2233", billColor: "#1f1c1b", legColor: "#1f1c1b", eyeColor: "#17150f"});

export const BIRD_PRESETS = birds;
