// Broad compatibility envelopes, not identifications or universal exclusions.
// Store speeds in m/s. Keep model search limits distinct from these screens.
export const PHYSICAL_ENVELOPE_REVISION = 1;
export const MULTIROTOR_LIMITS = Object.freeze({maxSpeed: 60, maxAscent: 30, maxDescent: 30});

const KT = 0.514444;
export const PHYSICAL_ENVELOPES = Object.freeze([
    {key: "balloon", label: "balloon", sizeM: [0.20, 8], speedMS: [0, 80 * KT], gMax: 0.5},
    {key: "bird", label: "bird", sizeM: [0.10, 2.5], speedMS: [0, 60 * KT], gMax: 3},
    {key: "quadcopter", label: "multirotor", sizeM: [0.20, 2],
        speedMS: [0, MULTIROTOR_LIMITS.maxSpeed], speedBasis: "horizontal", gMax: 2},
    {key: "smallUAS", label: "small fixed-wing", sizeM: [0.50, 4], speedMS: [20 * KT, 120 * KT], gMax: 4},
    {key: "lightAir", label: "light aircraft", sizeM: [5, 20], speedMS: [60 * KT, 250 * KT], gMax: 3},
    {key: "jet", label: "jet", sizeM: [10, 25], speedMS: [150 * KT, 600 * KT], gMax: 9},
    {key: "airliner", label: "airliner", sizeM: [25, 80], speedMS: [200 * KT, 500 * KT], gMax: 2.5},
].map(c => Object.freeze({...c, sizeM: Object.freeze(c.sizeM), speedMS: Object.freeze(c.speedMS)})));
