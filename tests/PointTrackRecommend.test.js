import {ISOLATED_PEAK, measureAppearance, recommendMethod} from "../src/PointTrackRecommend";

// What Analyse Object measured at the seed of each reference clip.
const clips = {
    party: {motionFound: true, motionPolarity: 'bright', rawPolarity: 'bright', peakAtSeed: true, isolation: 15.3},
    windmill: {motionFound: true, motionPolarity: 'bright', rawPolarity: 'bright', peakAtSeed: true, isolation: 18.3},
    duck: {motionFound: true, motionPolarity: 'bright', rawPolarity: 'bright', peakAtSeed: false, isolation: 3.9},
    truck: {motionFound: false, rawPolarity: 'bright', peakAtSeed: false, isolation: 2.1},
    iss: {motionFound: true, motionPolarity: 'dark', rawPolarity: 'bright', peakAtSeed: true, isolation: 43.3},
};

test.each([
    ['party', 'motion'], ['windmill', 'motion'], ['duck', 'motion'], ['truck', 'template'], ['iss', 'highPeak'],
])('%s is recommended %s', (clip, method) => {
    expect(recommendMethod(clips[clip]).method).toBe(method);
});

test("the isolation threshold separates the measured clips with room on both sides", () => {
    expect(clips.duck.isolation * 2).toBeLessThan(ISOLATED_PEAK * 1.1);
    expect(clips.party.isolation).toBeGreaterThan(ISOLATED_PEAK * 1.5);
});

test("an isolated dark point is recommended Low Peak", () => {
    expect(recommendMethod({motionFound: false, rawPolarity: 'dark', peakAtSeed: true, isolation: 20}).method)
        .toBe('lowPeak');
});

test("measureAppearance reads polarity and isolation from the pixels", () => {
    const size = 21, luma = new Float32Array(size * size);
    for (let i = 0; i < luma.length; i++) luma[i] = 100 + ((i * 7919) % 11) - 5;   // background near 100
    luma[10 * size + 10] = 220;                                                     // bright point at the centre
    const bright = measureAppearance(luma, size, 3);
    expect(bright.rawPolarity).toBe('bright');
    expect(bright.isolation).toBeGreaterThan(ISOLATED_PEAK);
    luma[10 * size + 10] = 10;
    expect(measureAppearance(luma, size, 3).rawPolarity).toBe('dark');
});
