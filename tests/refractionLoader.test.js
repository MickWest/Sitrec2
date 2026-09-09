jest.mock("../src/Globals", () => ({Sit: {}, guiMenus: {}, setRenderOne: jest.fn()}));
jest.mock("../src/refraction/RefractionTool", () => ({RefractionTool: jest.fn().mockImplementation(() => ({
    show: jest.fn(), sync: jest.fn(), dispose: jest.fn(),
}))}));

import {Sit} from "../src/Globals";
import {disposeRefractionTool, openRefractionTool, restoreRefractionTool} from "../src/refraction/RefractionLoader";

afterEach(() => { disposeRefractionTool(); delete Sit.raytracedRefraction; jest.clearAllMocks(); });

test("disabled saved settings do not load the tool", async () => {
    Sit.raytracedRefraction = {enabled: false, temperature: 20};
    expect(await restoreRefractionTool()).toBe(null);
});

test("concurrent opens share one instance, and disposal releases it", async () => {
    const [a, b] = await Promise.all([openRefractionTool(), openRefractionTool()]);
    expect(a).toBe(b);
    expect(a.show).toHaveBeenCalledTimes(2);
    disposeRefractionTool();
    expect(a.dispose).toHaveBeenCalledTimes(1);
});

test("a sitch change during lazy import cannot resurrect an old tool", async () => {
    const operation = openRefractionTool();
    disposeRefractionTool();
    expect(await operation).toBe(null);
});
