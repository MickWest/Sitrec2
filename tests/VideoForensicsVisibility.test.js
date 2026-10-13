jest.mock("../src/VideoExporter", () => ({}));
jest.mock("../src/nodes/CNodeVideoViewFilters", () => ({}));

import {analysisMethods} from "../src/nodes/CNodeVideoViewAnalysis";

test.each([
    ["Error Level Analysis", "elaEnabled", "getELAOverlayState"],
    ["Noise Analysis", "noiseEnabled", "getNoiseOverlayState"],
])("%s visibility follows its checkbox without requiring an expanded folder", (name, flag, method) => {
    const enabled = {v0: false};
    const view = {in: {[flag]: enabled}, currentVideoIndex: 0};
    const image = {width: 640, height: 360};
    const state = () => analysisMethods[method].call(view, 10, image);

    expect(state().enabled).toBe(false);
    enabled.v0 = true;
    expect(state()).toMatchObject({enabled: true, opacity: 0.65});
    enabled.v0 = false;
    expect(state()).toEqual({enabled: false, key: null, opacity: 0});
});
