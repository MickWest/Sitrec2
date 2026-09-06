jest.mock("../src/Globals", () => ({Globals: {pendingActions: 0}, NodeMan: {list: {}}}));
jest.mock("../src/AsyncOperationRegistry", () => ({asyncOperationRegistry: {getCount: () => 0}}));

import {NodeMan} from "../src/Globals";
import {waitForExportFrameSettled} from "../src/ExportFrameSettler";

describe("export background loading", () => {
    let originalRAF;
    beforeEach(() => {
        originalRAF = global.requestAnimationFrame;
        global.requestAnimationFrame = callback => { callback(); return 0; };
        NodeMan.list = {};
    });
    afterEach(() => { global.requestAnimationFrame = originalRAF; });

    test("waits for cached terrain to refine through multiple levels on the same output frame", async () => {
        const map = {_tileEpoch: 1, forEachTile: () => {}};
        NodeMan.list.terrain = {data: {maps: {imagery: {map}}}};
        let renders = 0;
        const frames = [];
        const renderFrame = () => {
            frames.push(284);
            if (++renders <= 8) map._tileEpoch++;
        };
        const result = await waitForExportFrameSettled({frame: 284, renderFrame});
        expect(result.timedOut).toBe(false);
        expect(map._tileEpoch).toBe(9);
        expect(renders).toBe(11);
        expect(new Set(frames)).toEqual(new Set([284]));
    });

    test("settled terrain needs only the normal quiet checks, regardless of camera grace", async () => {
        const map = {_tileEpoch: 50, forEachTile: () => {}};
        NodeMan.list.terrain = {data: {maps: {imagery: {map}}}};
        NodeMan.list.terrainUI = {data: {_subdivGraceFrames: 120}};
        const renderFrame = jest.fn();
        const result = await waitForExportFrameSettled({frame: 0, renderFrame});
        expect(result.timedOut).toBe(false);
        expect(renderFrame).toHaveBeenCalledTimes(3);
    });

    test("rechecks refinement started by the final presentation render", async () => {
        const map = {_tileEpoch: 1, forEachTile: () => {}};
        NodeMan.list.terrain = {data: {maps: {imagery: {map}}}};
        let renders = 0;
        const result = await waitForExportFrameSettled({frame: 0, renderFrame: () => {
            if (++renders === 3) map._tileEpoch++;
        }});
        expect(result.timedOut).toBe(false);
        expect(renders).toBe(6);
    });
});
