import {chooseMotionCalibration, CLEAR_RATIO} from "../src/MotionCalibration";

// Measured at the seed frame of each test clip (score in the tight gate, ratio against the
// strongest competitor in the tracker's search gate).
const duckFrame0 = [
    {featureScale: 1, score: 13.9, ratio: 1.15},
    {featureScale: 2, score: 15.0, ratio: 1.77},
    {featureScale: 4, score: 14.8, ratio: 14.4},
    {featureScale: 8, score: 6.6, ratio: Infinity},
];
const windmillFrame0 = [
    {featureScale: 1, score: 26.7, ratio: 4.83},
    {featureScale: 2, score: 17.3, ratio: 4.83},
    {featureScale: 4, score: 7.2, ratio: 9.48},
];
const partyFrame0 = [
    {featureScale: 1, slack: 0, score: 12.9, ratio: 2.19},
    {featureScale: 1, slack: 2, score: 12.0, ratio: 2.25},
    {featureScale: 2, slack: 0, score: 7.5, ratio: 1.97},
    {featureScale: 4, slack: 0, score: 2.4, ratio: 1.62},
];

test("a strong but ambiguous setting gives way to a comparably strong, clearly separated one", () => {
    const chosen = chooseMotionCalibration(duckFrame0, 6);
    expect(chosen.featureScale).toBe(4);
    expect(chosen.clearer).toBe(true);
});

test("a clearly separated strongest setting is kept", () => {
    const chosen = chooseMotionCalibration(windmillFrame0, 6);
    expect(chosen.featureScale).toBe(1);
    expect(chosen.clearer).toBeUndefined();
});

test("an ambiguous strongest setting is kept when nothing comparable is clearer", () => {
    const chosen = chooseMotionCalibration(partyFrame0, 6);
    expect(chosen).toMatchObject({featureScale: 1, slack: 0});
    expect(chosen.clearer).toBeUndefined();
});

test("a clearer setting that is much weaker, or not a detection, does not win", () => {
    expect(chooseMotionCalibration([
        {featureScale: 1, score: 20, ratio: 1.2},
        {featureScale: 8, score: 11, ratio: CLEAR_RATIO + 1},
    ], 6).featureScale).toBe(1);
    expect(chooseMotionCalibration([
        {featureScale: 1, score: 8, ratio: 1.2},
        {featureScale: 4, score: 5.5, ratio: CLEAR_RATIO + 1},
    ], 6).featureScale).toBe(1);
});

test("a missing separation measurement never triggers the veto", () => {
    expect(chooseMotionCalibration([
        {featureScale: 1, score: 10},
        {featureScale: 2, score: 9, ratio: 20},
    ]).featureScale).toBe(1);
    expect(chooseMotionCalibration([])).toBeNull();
});
