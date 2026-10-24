import {CVideoData} from "../src/CVideoData";

let savedDocument;
beforeAll(() => {
    savedDocument = global.document;
    global.document = {createElement: () => ({getContext: () => ({fillRect() {}, drawImage() {}})})};
});
afterAll(() => { global.document = savedDocument; });

function stabilizedVideo() {
    const v = new CVideoData({id: "video", frames: 0});
    v.setStabilizationData(new Map([[0, {x: 900, y: 500}], [10000, {x: 1000, y: 600}]]), {x: 900, y: 500});
    v.setStabilizationEnabled(true);
    return v;
}
const frame = {width: 1920, height: 1080};
const cachedFrames = v => Object.keys(v.stabilizedImageCache).map(Number);

test("stabilized playback keeps a few full-size frames, not one per frame played", () => {
    const v = stabilizedVideo();
    for (let f = 0; f < 600; f++) v.getStabilizedImage(f, frame);
    expect(cachedFrames(v)).toEqual([592, 593, 594, 595, 596, 597, 598, 599]);
    // A paused frame is still served from the cache rather than drawn again
    expect(v.getStabilizedImage(599, frame)).toBe(v.getStabilizedImage(599, frame));
});

test("the bound still holds after the cache is replaced from outside", () => {
    const v = stabilizedVideo();
    for (let f = 0; f < 20; f++) v.getStabilizedImage(f, frame);
    // as the stabilize-centers toggle does
    v.stabilizedImageCache = [];
    for (let f = 100; f < 200; f++) v.getStabilizedImage(f, frame);
    expect(cachedFrames(v)).toEqual([192, 193, 194, 195, 196, 197, 198, 199]);
});
