// FlockModel.js - where each bird of a flock is, relative to the path the flock follows.
//
// Pure math: no three.js and no Sitrec globals, so Jest can test it directly and
// ObjectFlock.js can call it thousands of times a frame.
//
// EVERYTHING HERE IS A PURE FUNCTION OF TIME. Sitrec is frame-indexed and the
// timeline is scrubbed, so a step-by-step simulation (boids) is the wrong shape:
// frame 900 has to look the same whether it was played to or jumped to. Motion is
// therefore built from sums of sines with seeded phases, and the changes of place
// from a seeded hash of the epoch number.
//
// Coordinates are LOCAL to the flock, in meters: [forward, right, up].
//
// WHAT IS MEASURED, AND WHAT IS A MODELING CHOICE
//
// Measured, and the reason a control exists:
//  - Two families of formation, LINE (V, J, echelon, column, front) and CLUSTER
//    (Heppner, Bird-Banding 45, 1974). "Irregular Front" is his front cluster: the
//    broad, shallow band that gulls, waders and ducks fly in.
//  - The V angle of Canada geese varies widely: 34 +/- 6 degrees from photographs of 5
//    formations (Gould & Heppner, Auk 91: 494, 1974), and 71.5 +/- 22.8 from radar on 54
//    (Williams, Klonowski & Berkeley, Auk 93: 554, 1976). So "V Angle" is a control, and
//    its default is the radar mean.
//  - The even V is the LEAST common of the shapes. In 104 Canada goose formations, Vs and
//    Js (a V with one arm longer) together were less common than echelons, and a flock
//    slides from one to another as birds change place (Gould & Heppner 1974):
//    "Asymmetry" is the shape the flock keeps coming back to, and "Shape Drift" is how
//    freely it leaves it.
//  - Followers sit in the upwash of the bird ahead, about one wingspan to the side, and
//    hold their place to the side more closely than their place behind (Lissaman &
//    Shollenberger, Science 168, 1970; Portugal et al., Nature 505: 399, 2014). Across the
//    flight the gap is a wingspan, give or take 0.2 m: ibis overlap 11.5 cm (Portugal),
//    greylag overlap 17 cm (Speakman & Banks, Ibis 140, 1998), pink-footed goose GAP 16.9
//    cm but ranging from -90 to +189 (Cutts & Speakman, J. Exp. Biol. 189, 1994), Canada
//    goose 19.8 cm with the sign unclear from the secondary source (Hainsworth, J. Exp.
//    Biol. 128: 445, 1987). So in a line formation the wander is smaller sideways.
//  - Birds in a V change places often, WITH THE BIRD NEXT TO THEM, and take turns in the
//    lead (Voelkl et al., PNAS 112: 2115, 2015, northern bald ibis: one swap per bird in
//    45 s): "Change of Place". See HOW BIRDS CHANGE PLACE, below.
//  - Followers fly level with the bird ahead or a little below it (Perinot et al. 2024,
//    ibis), and height varies less than the gap to the side (Hainsworth 1988, pelicans).
//  - Large goose flocks fly as several skeins, not one huge V: "Birds per Formation".
//  - Cluster flocks are thin in the direction of gravity: starling flocks measure about
//    1 : 2.8 : 5.6, whatever their size (Ballerini et al., Animal Behaviour 76: 201,
//    2008): "Vertical Spread".
//  - Cluster flocks turn on equal-radius paths, so the arrangement does not rotate with
//    the heading and the birds' paths cross (Pomeroy & Heppner, Auk 109: 256, 1992, rock
//    doves; Ballerini 2008 saw the same in starlings): "Turn Lag", applied by the
//    caller, which owns the heading.
//
// Modeling choices (plausible, NOT measured):
//  - Snaking. The upwash a follower rides trails along the path the leader actually
//    flew. So a follower d meters behind is placed on the leader's wander as it was
//    d / speed seconds ago, which makes the arm ripple from front to back. The physics
//    of the wake is sound; the size and spectrum of the wander are guesses.
//  - The wander is three sines per axis. Real birds are not sinusoidal; this is only
//    smooth, bounded and repeatable.
//  - The ripple along an irregular front, and the sideways swing of a bird changing
//    place, are there to look right and have no source.
//
// NOT HERE
//  - Murmurations. Those come from each bird reacting to its six or seven nearest
//    neighbors (Ballerini et al., PNAS 105: 1232, 2008), which is a true simulation with
//    state. It would be a second model with this same evaluate() shape, run forward from
//    frame 0 and cached so the timeline can still be scrubbed.
//  - Curved arms. Apart from the snaking, the arms are straight. No one has measured a
//    curve: the search found theory (Andersson & Wallander 2004) and no field data.
//  - The waves of gliding that pass down a line of pelicans (Weimerskirch et al. 2001).

import {mulberry32} from "./DifferentialEvolution";

export const FLOCK_FORMATIONS = ["V", "Echelon", "Line Astern", "Line Abreast", "Irregular Front", "Cluster"];

// No line to hold: V-ness, V Angle and the rest do not apply.
const CLUSTER_FORMATIONS = ["Irregular Front", "Cluster"];
// One bird is in front, and gives the lead up to another.
const LED_FORMATIONS = ["V", "Echelon", "Line Astern"];
// A line across the direction of flight, whose front edge ripples.
const FRONT_FORMATIONS = ["Line Abreast", "Irregular Front"];

export const flockDefaults = {
    species: "Custom",      // a name in FLOCK_SPECIES, or "Custom"
    count: 6,               // number of birds
    formation: "V",
    vNess: 1,               // 0 = loose cluster, 1 = birds hold the line formation's slots
    vAngle: 70,             // degrees between the two arms of the V
    asymmetry: 0,           // -1..1: share of the birds on the longer arm; +/- = right/left
    shapeDrift: 0.3,        // 0..1: how freely the arms change length, V to J to echelon
    groupSize: 25,          // most birds in one line formation; more than this makes several
    frontDepth: 0.25,       // Irregular Front: its depth as a fraction of its width
    elongation: 2,          // Cluster: its long horizontal axis as a multiple of its short one
    longAxis: 45,           // Cluster: degrees from the flight to the long axis; 90 = across
    spacing: 1.5,           // meters between neighbors; about one wingspan, for a V
    looseness: 0.3,         // each bird's own wander about its slot, as a fraction of spacing
    snaking: 0.5,           // the line's shared wander, which each bird follows in turn
    wanderPeriod: 5,        // seconds
    verticalSpread: 0.3,    // height as a fraction of the shorter horizontal extent
    placeChange: 45,        // seconds between one bird's changes of place; 0 = never
    wheeling: 0,            // meters the whole flock swings about the path
    wheelPeriod: 20,        // seconds
    turnLag: 2,             // seconds the formation's heading trails the flight direction
    seed: 1,
};

// Flocks of particular birds: a place to start from, which the controls then change.
// A species sets how the flock is arranged and how it moves. It does NOT set the number of
// birds, the seed or the wheeling, and it cannot set the size of a bird or the speed of
// the flock, which are the object's geometry and its track: `about` says what they should be.
//
// Where a value is MEASURED the source is given. Every other value is a JUDGMENT, and is
// marked (j). Wingspans and airspeeds are from Alerstam et al. 2007, PLoS Biology 5: e197,
// Protocol S1, unless another source is named.
export const FLOCK_SPECIES = {
    // The best measured of them all: GPS loggers on every bird of a flock of 14.
    // Portugal et al. 2014 (Nature 505: 399): followers about 1.2 m behind and at 45 degrees
    // to the bird ahead, wing tips overlapping 0.115 m; so 1.1 m across and a V of 90.
    // Voelkl et al. 2015 (PNAS 112: 2115): pairs 61% of the time, 3 or 4 birds 31%, more
    // than 4 only 8.5%; one swap per bird in 45 s; "overall formation shape was variable".
    // Perinot et al. 2024: followers level with the leader to within 0.75 m, or below it.
    "Northern Bald Ibis": {
        about: "Wingspan 1.2 m. Flies at about 12 m/s.",
        params: {formation: "V", vNess: 1, vAngle: 90, asymmetry: 0.4 /* j */, shapeDrift: 0.7 /* j */,
            groupSize: 4, spacing: 1.1, looseness: 0.35 /* j */, snaking: 0.5 /* j */, wanderPeriod: 4 /* j */,
            verticalSpread: 0.15 /* j */, placeChange: 45, turnLag: 2 /* j */},
    },
    // Wingspan 1.69 m. Across the flight, geese sit a wingspan apart, give or take 0.2 m:
    // greylag overlap 17 cm (Speakman & Banks 1998), pink-footed GAP 16.9 cm (Cutts &
    // Speakman 1994), Canada goose 19.8 cm, sign unclear (Hainsworth 1987). V angle 71.5
    // +/- 22.8, n = 54, by radar (Williams et al. 1976; read from summaries, not the paper),
    // against 34 +/- 6, N = 5 (Gould & Heppner 1974). Flock 18 +/- 12 (Gould & Heppner).
    // Echelons and Js outnumber Vs (Gould & Heppner), so the V leans and drifts. How often
    // geese change place is NOT measured: the ibis figure is used.
    "Canada Goose": {
        about: "Wingspan 1.7 m. Flies at about 17 m/s.",
        params: {formation: "V", vNess: 1, vAngle: 70, asymmetry: 0.5 /* j */, shapeDrift: 0.5 /* j */,
            groupSize: 18, spacing: 1.7, looseness: 0.25 /* j */, snaking: 0.5 /* j */, wanderPeriod: 5 /* j */,
            verticalSpread: 0.15 /* j */, placeChange: 45 /* ibis */, turnLag: 2 /* j */},
    },
    // O'Malley & Evans 1982 (Can. J. Zool. 60: 1388; from summaries): a V only 10% of the
    // time; angle 67 +/- 8 in a V and 70 +/- 5 in a J. Flying flock 13 (Birds of the World).
    // Hainsworth 1988, brown pelican: height varies less than wing tip spacing. Weimerskirch
    // et al. 2001 (Nature 413: 697): 13 m/s, gliding 12.6 times a minute "in unison or in
    // regular succession" down the line, which is why the line snakes more than a goose's.
    "White Pelican": {
        about: "Wingspan 2.9 m. Flies at about 14 m/s.",
        params: {formation: "Echelon", vNess: 1, vAngle: 70, asymmetry: 1, shapeDrift: 0.4 /* j */,
            groupSize: 13, spacing: 2.9, looseness: 0.2 /* j */, snaking: 0.8 /* j */, wanderPeriod: 6 /* j */,
            verticalSpread: 0.1 /* j */, placeChange: 45 /* ibis */, turnLag: 2 /* j */},
    },
    // Ballerini et al. 2008 (Animal Behaviour 76: 201), ten flocks of 448 to 2631: nearest
    // neighbor 0.68 to 1.51 m whatever the size of the flock; 1 : 2.8 : 5.6 with the thin
    // axis up and the long axis unrelated to the flight; through a turn the flock "remains
    // approximately constant with respect to an absolute reference frame". Cavagna et al.
    // 2013: by their fitted curve, half of the nearest neighbors have changed in about 12 s,
    // which is one change of place per bird in 17 s. Roost flocks flew at 7 to 15 m/s.
    // THIS IS NOT A MURMURATION: it has the measured shape and spacing, and none of the waves.
    "Starling": {
        about: "Wingspan 0.4 m. Flies at 7 to 15 m/s about a roost, 12 to 16 on passage.",
        params: {formation: "Cluster", elongation: 2, longAxis: 45 /* no link to the flight */, spacing: 1.1,
            looseness: 0.3 /* j */, wanderPeriod: 3 /* j */, verticalSpread: 0.36, placeChange: 17, turnLag: 60},
    },
    // Corcoran & Hedrick 2019 (eLife 8: e45071), seven flocks of 189 to 1039: nearest
    // neighbor 0.80 to 1.08 m, a wingspan to the side and half to one and a half behind,
    // 56% of them within a wingspan in height; flock turn rates 11 to 27 degrees a second.
    // They call these flocks Heppner's "front cluster". No one has measured how deep the
    // front is against its width. 7.6 m/s in these local flocks; 15.3 on passage.
    "Dunlin": {
        about: "Wingspan 0.4 m. Flies at 8 m/s in local flocks, 15 on passage.",
        params: {formation: "Irregular Front", frontDepth: 0.4 /* j */, spacing: 0.9, looseness: 0.3 /* j */,
            wanderPeriod: 3 /* j */, verticalSpread: 0.3 /* j */, placeChange: 17 /* starling */, turnLag: 30 /* j */},
    },
    // Pomeroy & Heppner 1992 (Auk 109: 256), flocks of 12 to 16: nearest neighbor 1.54 m;
    // equal-radius turns in which the paths cross and no bird keeps a fixed place. Heppner
    // 1974: a front cluster, "with spacing and turning... very precise".
    "Pigeon": {
        about: "Wingspan 0.65 m. Flies at about 16 m/s.",
        params: {formation: "Irregular Front", frontDepth: 0.5 /* j */, spacing: 1.5, looseness: 0.15 /* j */,
            wanderPeriod: 3 /* j */, verticalSpread: 0.3 /* j */, placeChange: 17 /* starling */, turnLag: 60},
    },
    // Yomosa et al. 2013 (PLoS ONE 8: e81754), hooded gulls, flocks of up to 23: "the flock
    // is thin... 2 dimensional"; birds avoid the place right behind another, with neighbors
    // about a wingspan to the side; 10 to 15 m/s. The gap between gulls is not given.
    "Gull": {
        about: "Wingspan 1.0 to 1.4 m. Flies at 10 to 15 m/s.",
        params: {formation: "Irregular Front", frontDepth: 0.3 /* j */, spacing: 3 /* j */, looseness: 0.5 /* j */,
            wanderPeriod: 6 /* j */, verticalSpread: 0.05, placeChange: 30 /* j */, turnLag: 10 /* j */},
    },
};

const TWO_PI = Math.PI * 2;

// Three octaves of wander: a slow drift, the named period, and a quicker jitter.
// The amplitudes sum to 1, so "looseness x spacing" is the largest offset per axis.
const WANDER_OCTAVE_FREQ = [1 / 2.7, 1, 2.3];
const WANDER_OCTAVE_AMP = [0.5, 0.35, 0.15];
const WANDER_TERMS = 9;     // 3 axes x 3 octaves

// HOW BIRDS CHANGE PLACE. Measured on northern bald ibis (Voelkl et al. 2015): a bird
// swaps places with the bird next to it, a median of 57 times in 43 minutes, which is once
// in 45 s; a spell behind another bird lasts a median of 2 s; and every bird takes a share
// of the lead (9 to 28% of the time). So the lead passes by a swap with the bird behind,
// not by a long flight to the back of the line. In starling flocks half of the nearest
// neighbors have changed in about 12 s (from the fitted curve of Cavagna et al. 2013).
//
// The history of a flock is made in steps of this many seconds. In each step some birds
// start a move; a move takes as long as it takes, and a bird that is on the move is left
// alone until it arrives.
const PLACE_EPOCH_SECONDS = 5;

// A flock is met part way through its flight, not at the moment it formed up. So its
// history starts this many steps before time 0 (10 minutes), and the shape in the first
// frame of a short sitch is already one the flock has drifted to. The seed picks which.
const EPOCHS_BEFORE_START = 120;

// A bird changing place moves no faster than this relative to the flock, at the fastest
// point of its move, and no faster than any other motion within the flock is allowed to be
// (see MAX_RELATIVE_SPEED_FRACTION): a swap across a slow flock must not turn the bird
// sideways on to its flight. A move eases in and out, so its fastest point is 1.5 times
// its average.
const PLACE_CHANGE_SPEED = 2;       // m/s
const PLACE_CHANGE_MIN_SECONDS = 2;
const EASE_PEAK = 1.5;

// With Shape Drift at 1, a bird crosses from the end of one arm to the end of the other
// about this often. No one has timed it: "the overall formation shape was variable over
// time" (Voelkl 2015) is all the papers say. A judgment.
const SHAPE_CHANGE_SECONDS = 20;

// The line as a whole swings more slowly than a bird corrects its own place. At the
// defaults this is a 1 m swing over some 10 s: about 0.5 m/s2 sideways, a bank of 3
// degrees, which is a skein in steady flight. At the birds' own rate it was 20 degrees.
const SNAKING_RATE = 0.5;

// A bird cannot fly sideways. Whatever the sizes and periods ask for, no part of the
// motion may move a bird faster than this, relative to the flock: a fraction of the
// speed the flock cruises at, which holds its nose within about 8 degrees of its
// flight. When a wander is too big for its period, it is slowed down to fit.
const MAX_RELATIVE_SPEED_FRACTION = 0.15;
const MIN_RELATIVE_SPEED = 0.75;            // m/s, so that a slow or hovering flock still moves
// Peak rate of change of wander(), per unit of size and of rate: the sum of
// amplitude x frequency over the octaves, with the per-bird frequency spread at its top.
const WANDER_SPEED_FACTOR = 1.06;
const RIPPLE_SPEED_FACTOR = 0.62;

// A wake is only "behind" a bird that is moving. Below this the delay would run away.
const SNAKING_MIN_SPEED = 5;        // m/s

// Clusters of up to this many birds are relaxed, so that a small flock is tidy.
const RELAX_MAX_BIRDS = 300;
const NEIGHBOR_SAMPLE_BIRDS = 300;

function hashInt(a, b = 0, c = 0) {
    let h = Math.imul(a | 0, 0x9E3779B1)
        ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA6B)
        ^ Math.imul((c | 0) + 0x165667B1, 0xC2B2AE35);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7FEB352D);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846CA68B);
    h ^= h >>> 16;
    return h >>> 0;
}

function hash01(a, b, c) {
    return hashInt(a, b, c) / 4294967296;
}

function smoothstep(u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    return u * u * (3 - 2 * u);
}

// Mean distance from a bird to its nearest neighbor. Sampled, so that a flock of
// thousands costs 300 x N rather than N x N.
function meanNeighborDistance(points, n) {
    const samples = Math.min(n, NEIGHBOR_SAMPLE_BIRDS);
    const stride = n / samples;
    let total = 0;
    for (let s = 0; s < samples; s++) {
        const i = Math.floor(s * stride);
        const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
        let best = Infinity;
        for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const dx = points[3 * j] - x, dy = points[3 * j + 1] - y, dz = points[3 * j + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) best = d2;
        }
        total += Math.sqrt(best);
    }
    return total / samples;
}

// For each point, the index of the point nearest to it. A grid of cells, so a flock of
// thousands is searched in its own neighborhood and not against everyone.
//
// Exported for the tests.
export function nearestNeighbors(points, n, cellSize = 1.5) {
    const nearest = new Int32Array(n).fill(-1);
    if (n < 2) return nearest;

    const cellOf = (v) => Math.floor(v / cellSize);
    const cells = new Map();
    for (let i = 0; i < n; i++) {
        const key = `${cellOf(points[3 * i])},${cellOf(points[3 * i + 1])},${cellOf(points[3 * i + 2])}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(i);
    }

    for (let i = 0; i < n; i++) {
        const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
        const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
        let best = Infinity;
        // Widen the search until a ring of cells has been looked at that is further
        // away than the best found, so the answer is the true nearest. A bird with no
        // one within a few cells is rare; it is checked against everyone, below.
        for (let reach = 1; reach <= 4 && best > ((reach - 1) * cellSize) ** 2; reach++) {
            for (let ix = cx - reach; ix <= cx + reach; ix++) {
                for (let iy = cy - reach; iy <= cy + reach; iy++) {
                    for (let iz = cz - reach; iz <= cz + reach; iz++) {
                        // only the shell that the last pass did not cover
                        if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== reach
                            && reach > 1) continue;
                        const cell = cells.get(`${ix},${iy},${iz}`);
                        if (!cell) continue;
                        for (const j of cell) {
                            if (j === i) continue;
                            const dx = points[3 * j] - x, dy = points[3 * j + 1] - y, dz = points[3 * j + 2] - z;
                            const d2 = dx * dx + dy * dy + dz * dz;
                            if (d2 < best) {
                                best = d2;
                                nearest[i] = j;
                            }
                        }
                    }
                }
            }
        }
        if (best > (4 * cellSize) ** 2) {
            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                const dx = points[3 * j] - x, dy = points[3 * j + 1] - y, dz = points[3 * j + 2] - z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best) {
                    best = d2;
                    nearest[i] = j;
                }
            }
        }
    }
    return nearest;
}

// Birds in a cluster are further from the bird ahead and the bird behind than from the
// birds beside them: "lack of neighbours along the direction of motion" (Ballerini et al.
// 2008, starlings; the same in hooded gulls, Yomosa et al. 2013, and in four waders,
// Corcoran & Hedrick 2019). The papers give no one number for it. This one is a judgment.
const NEIGHBORS_TO_THE_SIDE = 1.3;

// Density is higher at the border of a flock than in its core, in all ten of Ballerini's.
// A point at a fraction r of the way out is moved to r^0.85 of the way: with the edge
// effect allowed for, birds near the border are some 10% closer together than in the core.
// The size of the rise is a judgment; the papers give the sign.
const BORDER_DENSITY = 0.85;

// n points filling an ellipsoid, with a mean nearest-neighbor distance of 1, centered on
// the origin and sorted front to back. Returned as [fwd, right, up] x n.
//
// shape = {elongation, longAxisDegrees, verticalSpread}: the long horizontal axis as a
// multiple of the short one, which way it lies (0 = along the flight, 90 = across it), and
// the height as a fraction of the SHORT horizontal axis. Starling flocks measure
// 1 : 2.8 : 5.6, so elongation 2 and verticalSpread 0.36, and the long axis has no link to
// the direction of flight (Ballerini et al. 2008, Animal Behaviour 76: 201).
//
// The points are an even grid with jitter, laid INSIDE the ellipsoid. The first version
// squashed a ball of points flat instead, which also squashes the gaps between them: every
// bird's nearest neighbor was then above or below it, the one place it never is.
//
// Exported for the tests.
export function clusterPoints(n, shape, rand) {
    const points = new Float64Array(3 * n);
    if (n <= 1) return points;

    const long = Math.max(1, shape.elongation ?? 1);
    const tall = Math.max(0, shape.verticalSpread ?? 1);
    const turn = (shape.longAxisDegrees ?? 0) * Math.PI / 180;
    const cosT = Math.cos(turn), sinT = Math.sin(turn);
    const stretch = NEIGHBORS_TO_THE_SIDE;

    // The grid is laid in a frame that is SHORTER along the flight by `stretch`, and
    // pulled back out at the end. The grid is even in that frame, so after the pull the
    // gaps along the flight are the longer ones. This is how far out a point of that
    // frame is: 0 at the middle of the flock, 1 on its surface.
    const radius = (x, y, z) => {
        const forward = x * stretch;
        const u = (forward * cosT + y * sinT) / long;
        const v = -forward * sinT + y * cosT;
        const w = tall > 0 ? z / tall : 0;
        return Math.sqrt(u * u + v * v + w * w);
    };
    const halfX = Math.hypot(long * cosT, sinT) / stretch;
    const halfY = Math.hypot(long * sinT, cosT);

    // A flock thinner than the gap between its birds is one layer: a grid in the plane.
    // (A height of 0 makes the cell 0 as well, and a grid of cells of no size never ends.)
    let cell = Math.cbrt(4 / 3 * Math.PI * long * tall / stretch / n);
    const flat = !(tall > 0) || tall < 0.5 * cell;
    if (flat) cell = Math.sqrt(Math.PI * long / stretch / n);

    // Make more than enough, then keep the n nearest the middle. That gives exactly n,
    // in the shape asked for, with no loop that waits on chance.
    let found = [];
    for (let attempt = 0; found.length < n && attempt < 12; attempt++) {
        cell *= 0.9;
        found = [];
        const nx = Math.ceil(halfX / cell) + 1, ny = Math.ceil(halfY / cell) + 1;
        const nz = flat ? 0 : Math.ceil(tall / cell) + 1;
        for (let ix = -nx; ix <= nx; ix++) {
            for (let iy = -ny; iy <= ny; iy++) {
                for (let iz = -nz; iz <= nz; iz++) {
                    // 0.35 of a cell either way: no rows to see, and no two birds
                    // nearer than 0.3 of a cell
                    const x = (ix + (rand() - 0.5) * 0.7) * cell;
                    const y = (iy + (rand() - 0.5) * 0.7) * cell;
                    let z = flat ? 0 : (iz + (rand() - 0.5) * 0.7) * cell;
                    const out = radius(x, y, z);
                    if (out > 1) continue;
                    if (flat) z = (rand() - 0.5) * 2 * tall * Math.sqrt(1 - out * out);
                    found.push([out, x, y, z]);
                }
            }
        }
    }
    found.sort((a, b) => a[0] - b[0]);
    const edge = Math.max(found[Math.min(n, found.length) - 1][0], 1e-9);
    for (let i = 0; i < n; i++) {
        const [out, x, y, z] = found[i % found.length];
        const moved = out > 0 ? Math.pow(out / edge, BORDER_DENSITY) / (out / edge) : 1;
        points[3 * i] = x * moved;
        points[3 * i + 1] = y * moved;
        points[3 * i + 2] = z * moved;
    }

    // A small flock is made tidy: push apart any pair nearer than most. It is an
    // all-pairs pass, so a big flock, where one close pair does not show, goes without.
    if (n <= RELAX_MAX_BIRDS) {
        for (let pass = 0; pass < 8; pass++) {
            const wanted = 0.8 * meanNeighborDistance(points, n);
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    let dx = points[3 * j] - points[3 * i];
                    let dy = points[3 * j + 1] - points[3 * i + 1];
                    let dz = points[3 * j + 2] - points[3 * i + 2];
                    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (d >= wanted) continue;
                    if (d < 1e-9) {
                        dx = 0; dy = 1; dz = 0; d = 1;
                    }
                    const push = 0.5 * (wanted - d) / d;
                    dx *= push; dy *= push; dz *= flat ? 0 : push;
                    points[3 * i] -= dx; points[3 * i + 1] -= dy; points[3 * i + 2] -= dz;
                    points[3 * j] += dx; points[3 * j + 1] += dy; points[3 * j + 2] += dz;
                }
            }
        }
    }

    for (let i = 0; i < n; i++) points[3 * i] *= stretch;

    const scale = 1 / Math.max(meanNeighborDistance(points, n), 1e-9);
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += points[3 * i]; cy += points[3 * i + 1]; cz += points[3 * i + 2];
    }
    cx /= n; cy /= n; cz /= n;

    const order = Array.from({length: n}, (_, i) => i)
        .sort((i, j) => points[3 * j] - points[3 * i]);
    const sorted = new Float64Array(3 * n);
    order.forEach((from, to) => {
        sorted[3 * to] = (points[3 * from] - cx) * scale;
        sorted[3 * to + 1] = (points[3 * from + 1] - cy) * scale;
        sorted[3 * to + 2] = (points[3 * from + 2] - cz) * scale;
    });
    return sorted;
}

// The slots of one line formation of n birds, with a spacing of 1.
// Slot 0 is the leader, and the rest run from front to back.
//
// In a V or an echelon the spacing is measured ACROSS the direction of flight, and the
// angle then sets how far behind each bird is. That is the way round the birds have it:
// a follower holds its wing tip in the upwash of the bird ahead, so the gap to the side
// stays near one wingspan whatever the angle, and the gap behind is what varies. Gould &
// Heppner's geese were 4.1 m apart along the arm of a 34 degree V, which is 1.2 m across.
//
// Returns {positions, arm, rank, depth, back, across}: arm is 0 for the leader, -1 left,
// +1 right; rank counts back along the arm from 1; depth is how far behind the leader the
// slot is, which sets the delay of the snaking; back and across are one rank's step.
//
// Exported for the tests.
export function lineSlots(n, formation, vAngleDegrees, asymmetry = 0) {
    const positions = new Float64Array(3 * n);
    const arm = new Int8Array(n);
    const rank = new Int32Array(n);
    const depth = new Float64Array(n);

    const halfAngle = Math.min(90, Math.max(1, vAngleDegrees / 2)) * Math.PI / 180;
    let back = 1 / Math.tan(halfAngle), across = 1;
    if (formation === "Line Astern") {
        back = 1; across = 0;
    }
    if (formation === "Line Abreast") back = 0;

    // The share of the followers on the longer arm: a half makes a V, all of them makes
    // an echelon, and between the two is the J.
    let lean = Math.min(1, Math.max(-1, asymmetry));
    if (formation === "Echelon" || formation === "Line Astern") lean = lean < 0 ? -1 : 1;
    if (formation === "Line Abreast") lean = 0;
    const longSide = lean < 0 ? -1 : 1;
    const longShare = (1 + Math.abs(lean)) / 2;

    let longRank = 0, shortRank = 0;
    for (let slot = 1; slot < n; slot++) {
        // Deal the slots out so both arms fill from the front together.
        const toLong = Math.floor(slot * longShare) > Math.floor((slot - 1) * longShare);
        rank[slot] = toLong ? ++longRank : ++shortRank;
        arm[slot] = toLong ? longSide : -longSide;
        depth[slot] = rank[slot] * back;
        positions[3 * slot] = -rank[slot] * back;
        positions[3 * slot + 1] = arm[slot] * rank[slot] * across;
    }

    // Center it, so the PATH is the middle of the formation and not its leader.
    let cx = 0, cy = 0;
    for (let slot = 0; slot < n; slot++) {
        cx += positions[3 * slot]; cy += positions[3 * slot + 1];
    }
    for (let slot = 0; slot < n; slot++) {
        positions[3 * slot] -= cx / n; positions[3 * slot + 1] -= cy / n;
    }
    return {positions, arm, rank, depth, back, across};
}

// Slot numbers of a formation with a leader. Every place a bird COULD take has a number,
// so that an arm can grow until it holds every follower: 0 is the leader, 1..size-1 the
// left arm from the front, size..2*size-2 the right arm from the front.
//
// Exported for the tests.
export function armSlot(size, side, rank) {
    return side < 0 ? rank : size - 1 + rank;
}

export class FlockModel {
    constructor(params = {}) {
        this.params = {...flockDefaults};
        this.layoutKey = null;
        // How fast the flock flies on the whole, in m/s. It limits how fast the birds may
        // move about within it. It has to be ONE number for the whole path: it scales
        // rates that are multiplied by time, so a value that changed from frame to frame
        // would throw every phase about.
        this.cruise = 15;
        this.setParams(params);
    }

    get cruiseSpeed() {
        return this.cruise;
    }

    set cruiseSpeed(speed) {
        const before = this.placeChangeSpeed();
        this.cruise = speed;
        // How long a move takes is part of the history of who is where.
        if (this.placeChangeSpeed() !== before) {
            for (const group of this.groups ?? []) group.state = group.spare = null;
        }
    }

    // The fastest a bird may go, relative to the flock, while it changes place. In steps
    // of 0.05 m/s, so that a track being dragged about does not remake the history of the
    // flock on every frame.
    placeChangeSpeed() {
        const fastest = Math.max(MIN_RELATIVE_SPEED, MAX_RELATIVE_SPEED_FRACTION * this.cruise);
        return Math.round(Math.min(PLACE_CHANGE_SPEED, fastest) * 20) / 20;
    }

    // The rate (radians per second) of a wander of this size, slowed if it has to be so
    // that it moves no bird faster than a bird can move within its flock.
    limitedRate(rate, size, speedFactor = WANDER_SPEED_FACTOR) {
        if (!(size > 0)) return rate;
        const fastest = Math.max(MIN_RELATIVE_SPEED, MAX_RELATIVE_SPEED_FRACTION * this.cruise);
        return Math.min(rate, fastest / (speedFactor * size));
    }

    get count() {
        return this.birdCount;
    }

    setParams(params = {}) {
        const p = Object.assign(this.params, params);
        p.count = Math.max(1, Math.round(Number(p.count) || 1));
        p.groupSize = Math.max(2, Math.round(Number(p.groupSize) || 2));
        p.seed = Math.round(Number(p.seed) || 0);
        if (!FLOCK_FORMATIONS.includes(p.formation)) p.formation = flockDefaults.formation;

        // Only these change WHERE the slots are, or the history of who has been in them.
        // The rest are read at evaluate time, so dragging (say) the spacing slider does
        // not rebuild anything.
        const key = [p.count, p.formation, p.vAngle, p.asymmetry, p.shapeDrift, p.groupSize,
            p.frontDepth, p.elongation, p.longAxis, p.verticalSpread, p.seed].join("|");
        if (key !== this.layoutKey) {
            this.layoutKey = key;
            this.buildLayout();
        }
        // The history of who is where also depends on these: how often birds move, and
        // (through how long a move takes) how far. It is replayed, not rebuilt.
        const historyKey = [p.placeChange, p.spacing].join("|");
        if (historyKey !== this.historyKey) {
            this.historyKey = historyKey;
            for (const group of this.groups) group.state = group.spare = null;
        }
    }

    buildLayout() {
        const p = this.params;
        const n = this.birdCount = p.count;
        this.isCluster = CLUSTER_FORMATIONS.includes(p.formation);
        this.hasLeader = LED_FORMATIONS.includes(p.formation);
        this.isFront = FRONT_FORMATIONS.includes(p.formation);
        const rand = mulberry32(hashInt(p.seed, 101) || 1);

        // A cluster is one group. A line formation of more than groupSize birds is
        // split into several, as evenly as it will go.
        const groupCount = this.isCluster ? 1 : Math.ceil(n / p.groupSize);
        // The shape of the cluster. A front is a cluster lying across the flight. The
        // birds of a LINE formation have round homes, for V-ness to draw them from.
        const round = {elongation: 1, longAxisDegrees: 0, verticalSpread: p.verticalSpread};
        let clusterShape = round;
        if (p.formation === "Irregular Front") {
            clusterShape = {...round, elongation: 1 / Math.max(0.02, p.frontDepth), longAxisDegrees: 90};
        }
        if (p.formation === "Cluster") {
            clusterShape = {...round, elongation: p.elongation, longAxisDegrees: p.longAxis};
        }
        this.groups = [];

        let start = 0;
        let widest = 1;
        for (let index = 0; index < groupCount; index++) {
            const size = Math.floor(n / groupCount) + (index < n % groupCount ? 1 : 0);
            const group = {
                index, start, size,
                phase: rand(),              // so the groups do not all change places together
                // Which arm is the longer is the user's to choose for the first formation.
                // The others choose for themselves, as separate skeins would.
                lean: p.asymmetry * (index === 0 || rand() < 0.5 ? 1 : -1),
                epoch: -1,
                center: [0, 0, 0],
            };
            this.groups.push(group);

            // Where each BIRD is when nothing holds it in line: a loose cluster. V-ness
            // draws a bird from here to the slot it has in the line.
            group.home = clusterPoints(size, clusterShape, rand);
            const birdSlot = Int32Array.from({length: size}, (_, bird) => bird);
            let left = 0;

            if (this.isCluster) {
                // The cluster IS the formation: the slots are the homes, and the birds
                // trade them.
                group.line = group.home;
                group.depth = new Float64Array(size);
            } else {
                const slots = lineSlots(size, p.formation, p.vAngle, group.lean);
                this.matchClusterToLine(group.home, slots.arm, size);
                group.line = slots.positions;
                group.depth = slots.depth;
                if (this.hasLeader) {
                    // Both arms at full length, NOT centered: the middle of the formation
                    // moves as the arms change length, so it is taken off at evaluate time.
                    group.back = slots.back;
                    group.across = slots.across;
                    group.oneArm = p.formation === "Line Astern";
                    group.line = new Float64Array(3 * (2 * size - 1));
                    group.depth = new Float64Array(2 * size - 1);
                    for (const side of [-1, 1]) {
                        for (let rank = 1; rank < size; rank++) {
                            const slot = armSlot(size, side, rank);
                            group.line[3 * slot] = -rank * slots.back;
                            group.line[3 * slot + 1] = side * rank * slots.across;
                            group.depth[slot] = rank * slots.back;
                        }
                    }
                    for (let bird = 1; bird < size; bird++) {
                        birdSlot[bird] = armSlot(size, slots.arm[bird], slots.rank[bird]);
                        if (slots.arm[bird] < 0) left++;
                    }
                }
            }
            group.initialSlot = birdSlot;
            group.initialLeft = left;
            group.state = group.spare = null;
            group.slotBird = new Int32Array(group.line.length / 3);
            // Who is next to whom, for the birds that trade places with a neighbor.
            if (!this.hasLeader) group.neighborSlot = nearestNeighbors(group.line, size);

            let midX = 0, midY = 0;
            for (let bird = 0; bird < size; bird++) {
                midX += group.line[3 * birdSlot[bird]] / size;
                midY += group.line[3 * birdSlot[bird] + 1] / size;
            }
            for (let bird = 0; bird < size; bird++) {
                const at = 3 * birdSlot[bird];
                widest = Math.max(widest, Math.hypot(group.line[at] - midX, group.line[at + 1] - midY));
            }
            start += size;
        }

        // Several formations fly as a loose cluster of formations, far enough apart
        // that their arms do not cross.
        this.groupSpacing = 2.5 * widest;
        const centers = clusterPoints(groupCount, round, rand);
        this.groups.forEach((group, index) => {
            group.center = [centers[3 * index], centers[3 * index + 1], centers[3 * index + 2]];
        });
        this.scratch = new Float64Array(4 * Math.max(...this.groups.map(group => group.size)));

        // Per-bird wander: a phase and a small frequency change for each term, so that
        // no two birds move together.
        this.wanderPhase = new Float32Array(n * WANDER_TERMS);
        this.wanderFreq = new Float32Array(n * WANDER_TERMS);
        const wanderRand = mulberry32(hashInt(p.seed, 202) || 1);
        for (let term = 0; term < n * WANDER_TERMS; term++) {
            this.wanderPhase[term] = wanderRand() * TWO_PI;
            this.wanderFreq[term] = (0.8 + 0.4 * wanderRand()) * WANDER_OCTAVE_FREQ[term % 3];
        }

        // Per-group: its drift among the other groups, the wander its birds follow in
        // turn (snaking), and the ripple along its front.
        this.groupPhase = new Float32Array(groupCount * WANDER_TERMS * 3);
        const groupRand = mulberry32(hashInt(p.seed, 303) || 1);
        for (let term = 0; term < this.groupPhase.length; term++) {
            this.groupPhase[term] = groupRand() * TWO_PI;
        }

        const wheelRand = mulberry32(hashInt(p.seed, 404) || 1);
        this.wheelPhase = Array.from({length: 5}, () => wheelRand() * TWO_PI);
        this.wheelDirection = wheelRand() < 0.5 ? -1 : 1;
    }

    // V-ness blends each bird from its home in the cluster to its slot in the line. That
    // only looks like "a ragged V" if the two are near each other to begin with. Both
    // arrive sorted front to back, so the fronts already agree; this puts the left of
    // the cluster on the left arm, a pair of birds at a time.
    matchClusterToLine(cluster, arm, size) {
        for (let slot = 1; slot + 1 < size; slot += 2) {
            const other = slot + 1;
            if (arm[slot] === arm[other]) continue;
            const leftSlot = arm[slot] < 0 ? slot : other;
            const rightSlot = arm[slot] < 0 ? other : slot;
            if (cluster[3 * leftSlot + 1] <= cluster[3 * rightSlot + 1]) continue;
            for (let axis = 0; axis < 3; axis++) {
                const swap = cluster[3 * slot + axis];
                cluster[3 * slot + axis] = cluster[3 * other + axis];
                cluster[3 * other + axis] = swap;
            }
        }
    }

    // Who is where at the start of a group's history: every bird settled in the slot it
    // was dealt. `slot` is where a bird is going (or is), `from` where it set out from,
    // and `start` and `seconds` when, on the group's own clock, and for how long.
    startState(group) {
        const size = group.size;
        return {
            epoch: 0,
            left: group.initialLeft,
            slot: Int32Array.from(group.initialSlot),
            from: Int32Array.from(group.initialSlot),
            start: new Float64Array(size).fill(-Infinity),
            seconds: new Float64Array(size),
        };
    }

    // One step of a group's history: some birds start to change place.
    //
    //  - A swap. In a formation with a leader, a bird trades with the bird AHEAD of it on
    //    its arm, and the head of an arm trades with the leader, which is how the lead
    //    changes hands. In any other formation a bird trades with its nearest neighbor.
    //  - With Shape Drift above 0, the last bird of one arm may cross to the end of the
    //    other. That makes one arm longer and the other shorter, and is how a V becomes a J
    //    and a J an echelon. The asymmetry that was asked for pulls the shape back, less
    //    firmly as Shape Drift grows.
    //
    // A bird that has not yet arrived from its last move is left alone.
    advance(state, group, epoch) {
        const p = this.params;
        const size = group.size;
        state.epoch = epoch;
        if (size < 2 || !(p.placeChange > 0)) return;
        const rand = mulberry32(hashInt(p.seed, group.index * 7919 + 17, epoch) || 1);
        const stepStart = epoch * PLACE_EPOCH_SECONDS;
        const {slot, from, start, seconds} = state;
        const line = group.line;

        const slotBird = group.slotBird.fill(-1);
        for (let bird = 0; bird < size; bird++) slotBird[slot[bird]] = bird;
        const fastest = this.placeChangeSpeed();
        const settled = (bird) => start[bird] + seconds[bird] <= stepStart;
        const moveTo = (bird, toSlot) => {
            const a = 3 * slot[bird], b = 3 * toSlot;
            const meters = Math.hypot(line[b] - line[a], line[b + 1] - line[a + 1], line[b + 2] - line[a + 2])
                * p.spacing;
            from[bird] = slot[bird];
            slot[bird] = toSlot;
            start[bird] = stepStart + rand() * 0.8 * PLACE_EPOCH_SECONDS;
            seconds[bird] = Math.max(PLACE_CHANGE_MIN_SECONDS, EASE_PEAK * meters / fastest);
            slotBird[toSlot] = bird;
        };
        const swap = (birdA, birdB) => {
            if (birdA < 0 || birdB < 0 || birdA === birdB || !settled(birdA) || !settled(birdB)) return;
            const slotA = slot[birdA], slotB = slot[birdB];
            moveTo(birdA, slotB);
            moveTo(birdB, slotA);
        };

        // Each bird changes place once in placeChange seconds, and a swap moves two.
        const expected = size * PLACE_EPOCH_SECONDS / (2 * p.placeChange);
        const swaps = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
        const length = {[-1]: state.left, [1]: size - 1 - state.left};

        for (let count = 0; count < swaps; count++) {
            if (!this.hasLeader) {
                const slotA = Math.floor(rand() * size);
                swap(slotBird[slotA], slotBird[group.neighborSlot[slotA]]);
                continue;
            }
            // a follower, picked by where it is, and the bird ahead of it
            const place = 1 + Math.floor(rand() * (size - 1));
            const side = place <= length[-1] ? -1 : 1;
            const rank = side < 0 ? place : place - length[-1];
            const ahead = rank === 1 ? 0 : armSlot(size, side, rank - 1);
            swap(slotBird[armSlot(size, side, rank)], slotBird[ahead]);
        }

        const drift = (!this.hasLeader || group.oneArm) ? 0 : Math.min(1, Math.max(0, p.shapeDrift));
        if (rand() < drift * PLACE_EPOCH_SECONDS / SHAPE_CHANGE_SECONDS) {
            // Even odds of which arm gains, pulled toward the share of the followers
            // that the asymmetry asks for on the right.
            let lean = Math.min(1, Math.max(-1, group.lean));
            if (p.formation === "Echelon") lean = lean < 0 ? -1 : 1;
            const wantRight = (1 + lean) / 2 * (size - 1);
            const pull = (1 - drift) * 4 * (wantRight - length[1]) / (size - 1);
            const to = rand() < Math.min(1, Math.max(0, 0.5 + pull)) ? 1 : -1;
            const bird = length[-to] > 0 ? slotBird[armSlot(size, -to, length[-to])] : -1;
            if (bird >= 0 && settled(bird)) {
                moveTo(bird, armSlot(size, to, length[to] + 1));
                state.left += to < 0 ? 1 : -1;
            }
        }
    }

    // Bring a group's history to the given step. It is made one step from the last, so it
    // is kept and stepped forward during play. A jump backwards replays it from the start:
    // that is (steps x birds) integer moves, a few milliseconds even for a long sitch.
    //
    // The step BEFORE the current one is kept as well. The caller samples a little before
    // and a little after each frame's time, so for half a second around every step it asks
    // for this step, then the last one, then this one again, on every frame. Without the
    // spare that was a full replay per frame: 20 ms for 5000 birds, a stutter every 5 s.
    seekGroupEpoch(group, epoch) {
        if (group.state?.epoch === epoch) return;
        if (group.spare?.epoch === epoch) {
            [group.state, group.spare] = [group.spare, group.state];
            return;
        }
        if (!group.state || epoch < group.state.epoch) group.state = this.startState(group);
        const state = group.state;
        for (let step = state.epoch + 1; step <= epoch; step++) {
            if (step === epoch) group.spare = this.copyState(state, group.spare);
            this.advance(state, group, step);
        }
    }

    copyState(state, into) {
        const copy = into ?? {slot: new Int32Array(state.slot.length), from: new Int32Array(state.slot.length),
            start: new Float64Array(state.slot.length), seconds: new Float64Array(state.slot.length)};
        copy.epoch = state.epoch;
        copy.left = state.left;
        copy.slot.set(state.slot); copy.from.set(state.from);
        copy.start.set(state.start); copy.seconds.set(state.seconds);
        return copy;
    }

    // Where the center of the flock is, relative to the path, at time t (seconds).
    // In the frame of the PATH: [forward, right, up], meters.
    //
    // The forward and sideways parts are a quarter turn apart, so about a fixed point
    // the flock circles it, and along a moving path it weaves and surges.
    wheelOffset(t, out = [0, 0, 0]) {
        const p = this.params;
        const size = p.wheeling;
        if (!(size > 0)) {
            out[0] = out[1] = out[2] = 0;
            return out;
        }
        const w = TWO_PI / Math.max(p.wheelPeriod, 0.5);
        const ph = this.wheelPhase;
        out[0] = size * (0.7 * Math.cos(w * t + ph[0]) + 0.3 * Math.sin(0.31 * w * t + ph[1]));
        out[1] = size * this.wheelDirection
            * (0.7 * Math.sin(w * t + ph[0]) + 0.3 * Math.sin(0.43 * w * t + ph[2]));
        out[2] = size * p.verticalSpread
            * (0.6 * Math.sin(0.5 * w * t + ph[3]) + 0.4 * Math.sin(1.37 * w * t + ph[4]));
        return out;
    }

    // Three octaves of a sine wander, with the phases starting at `term`.
    wander(rate, t, phases, term) {
        let sum = 0;
        for (let octave = 0; octave < 3; octave++) {
            sum += WANDER_OCTAVE_AMP[octave]
                * Math.sin(rate * WANDER_OCTAVE_FREQ[octave] * t + phases[term + octave]);
        }
        return sum;
    }

    // Where every bird is, relative to the center of the flock, at time t (seconds).
    // In the frame of the FORMATION: out[3i..3i+2] = [forward, right, up], meters.
    //
    // speed (m/s) is how fast the flock is flying. It sets how long ago the leader was
    // where each follower is now, which is the delay of the snaking.
    evaluate(t, speed, out) {
        const p = this.params;
        const spacing = p.spacing;
        const vNess = Math.min(1, Math.max(0, p.vNess));
        // How far each bird is drawn from its home to its slot. In a cluster the slots
        // ARE the formation, so all the way.
        const hold = this.isCluster ? 1 : vNess;
        const lineNess = this.isCluster ? 0 : vNess;
        const wanderRate = TWO_PI / Math.max(p.wanderPeriod, 0.1);
        const manyGroups = this.groups.length > 1;

        // A bird in a line holds its place to the SIDE more closely than its place
        // behind: the upwash it is riding is narrow, and long. A cluster has no such
        // reason, so as V-ness falls the wander goes back to being the same all round.
        const wanderSize = p.looseness * spacing;
        const wanderAcross = wanderSize * (1 - 0.5 * lineNess);
        const wanderUp = wanderSize * p.verticalSpread;
        const ownRate = this.limitedRate(wanderRate, wanderSize);

        const snakeSize = p.snaking * spacing * lineNess;
        const snakeDelayPerMeter = 1 / Math.max(speed, SNAKING_MIN_SPEED);
        const rippleSize = this.isFront ? 1.5 * p.looseness * spacing : 0;
        const snakeRate = this.limitedRate(wanderRate * SNAKING_RATE, snakeSize);
        const rippleRate = this.limitedRate(wanderRate, rippleSize, RIPPLE_SPEED_FACTOR);
        const driftSize = 0.3 * p.looseness * this.groupSpacing * spacing;
        const driftRate = this.limitedRate(wanderRate / 3, driftSize);

        for (const group of this.groups) {
            // The group's own clock, in seconds. Each group's is set a little apart, so
            // that they do not all change places together.
            const clock = t + (group.phase + EPOCHS_BEFORE_START) * PLACE_EPOCH_SECONDS;
            this.seekGroupEpoch(group, Math.max(0, Math.floor(clock / PLACE_EPOCH_SECONDS)));
            const state = group.state;
            const line = group.line, home = group.home;

            // Where each bird is in the line, in spacings: in its slot, or on its way there.
            const where = this.scratch;
            let cx = 0, cy = 0;
            for (let bird = 0; bird < group.size; bird++) {
                const to = 3 * state.slot[bird];
                let x = line[to], y = line[to + 1], z = line[to + 2];
                let depth = group.depth[state.slot[bird]];
                const raw = (clock - state.start[bird]) / state.seconds[bird];
                if (raw < 1) {
                    const at = 3 * state.from[bird];
                    const x0 = line[at], y0 = line[at + 1], z0 = line[at + 2];
                    const u = smoothstep(raw);
                    // Swing wide on the way, so that a bird goes round the others and not
                    // through them: out to the side when it moves along an arm, and back
                    // behind the flock when it crosses from arm to arm.
                    const distance = Math.hypot(x - x0, y - y0, z - z0);
                    const swing = Math.min(0.3 * distance, 4) * Math.sin(Math.PI * u);
                    const crossing = Math.abs(y - y0) > Math.abs(x - x0);
                    const side = (y + y0) < 0 ? -1 : 1;
                    // the two birds of a swap go round each other, one each side
                    const pass = state.from[bird] < state.slot[bird] ? 1 : -1;
                    depth = group.depth[state.from[bird]] + (depth - group.depth[state.from[bird]]) * u;
                    x = x0 + (x - x0) * u - (crossing ? swing * pass : 0);
                    y = y0 + (y - y0) * u + (crossing ? 0 : side * swing * pass);
                    z = z0 + (z - z0) * u;
                }
                where[4 * bird] = x; where[4 * bird + 1] = y; where[4 * bird + 2] = z; where[4 * bird + 3] = depth;
                cx += x / group.size; cy += y / group.size;
            }
            // (cx, cy) is the middle of the formation. The PATH runs through it, not through
            // the leader, and it moves as birds move and as an arm changes length.

            const groupTerm = group.index * WANDER_TERMS * 3;
            const ph = this.groupPhase;
            let gx = 0, gy = 0, gz = 0;
            if (manyGroups) {
                const apart = spacing * this.groupSpacing;
                gx = group.center[0] * apart + driftSize * this.wander(driftRate, t, ph, groupTerm);
                gy = group.center[1] * apart + driftSize * this.wander(driftRate, t, ph, groupTerm + 3);
                gz = group.center[2] * apart
                    + driftSize * p.verticalSpread * this.wander(driftRate, t, ph, groupTerm + 6);
            }

            for (let bird = 0; bird < group.size; bird++) {
                let x = where[4 * bird], y = where[4 * bird + 1], z = where[4 * bird + 2];
                const depth = where[4 * bird + 3];

                const h = 3 * bird;
                x = (home[h] + (x - cx - home[h]) * hold) * spacing;
                y = (home[h + 1] + (y - cy - home[h + 1]) * hold) * spacing;
                z = (home[h + 2] + (z - home[h + 2]) * hold) * spacing;

                // Snaking: the one wander of the group, as it was when the leader was here.
                if (snakeSize > 0) {
                    const then = t - depth * spacing * snakeDelayPerMeter;
                    y += snakeSize * this.wander(snakeRate, then, ph, groupTerm + 9);
                    z += snakeSize * p.verticalSpread * this.wander(snakeRate, then, ph, groupTerm + 12);
                }

                // Ripple: bulges that run along a front, so its edge is never straight.
                if (rippleSize > 0) {
                    const along = y / spacing;
                    x += rippleSize * (0.6 * Math.sin(TWO_PI * along / 8 + rippleRate * 0.5 * t + ph[groupTerm + 15])
                        + 0.4 * Math.sin(TWO_PI * along / 3.1 - rippleRate * 0.8 * t + ph[groupTerm + 16]));
                }

                // The bird's own wander about its slot.
                const index = group.start + bird;
                const term = index * WANDER_TERMS;
                const freq = this.wanderFreq, phase = this.wanderPhase;
                let ownAlong = 0, ownAcross = 0, ownUp = 0;
                for (let octave = 0; octave < 3; octave++) {
                    const amp = WANDER_OCTAVE_AMP[octave];
                    const k = term + octave;
                    ownAlong += amp * Math.sin(ownRate * freq[k] * t + phase[k]);
                    ownAcross += amp * Math.sin(ownRate * freq[k + 3] * t + phase[k + 3]);
                    ownUp += amp * Math.sin(ownRate * freq[k + 6] * t + phase[k + 6]);
                }

                out[3 * index] = x + gx + ownAlong * wanderSize;
                out[3 * index + 1] = y + gy + ownAcross * wanderAcross;
                out[3 * index + 2] = z + gz + ownUp * wanderUp;
            }
        }
        return out;
    }
}
