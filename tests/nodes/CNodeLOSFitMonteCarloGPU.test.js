jest.mock("../../src/gpu/MonteCarloLOS", () => ({fitMonteCarloGPU: jest.fn()}));

import {Vector3} from "three";
import {setNodeMan, setSit, setFileManager} from "../../src/Globals";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeArray} from "../../src/nodes/CNodeArray";
import {CNodeLOSFitMonteCarloGPU} from "../../src/nodes/CNodeLOSFitMonteCarloGPU";
import {fitMonteCarloGPU} from "../../src/gpu/MonteCarloLOS";

let finish;
beforeEach(() => {
    setNodeMan(new CNodeManager());
    setFileManager({removeExportButton: jest.fn()});
    setSit({frames: 12, fps: 2, simSpeed: 1, aFrame: 2, bFrame: 10});
    new CNodeArray({id: "testLOS", array: Array.from({length: 12}, (_, f) => ({
        position: new Vector3(6371000, f * 10, 1000), heading: new Vector3(0, 1, 0),
    }))});
    fitMonteCarloGPU.mockReset().mockImplementation(dataset => new Promise(resolve => {
        finish = () => resolve({positions: dataset.S.slice(), params: {
            backend: "webgpu", bestScore: 0.001, timing: {totalMs: 12.3},
        }});
    }));
});

test("fits the A-B window lazily, then updates all frames and dependent nodes", async () => {
    const node = new CNodeLOSFitMonteCarloGPU({id: "mc", LOS: "testLOS", preset: "mc_250k"});
    const output = {recalculateCascade: jest.fn()};
    node.outputs.push(output);
    expect(fitMonteCarloGPU).not.toHaveBeenCalled();
    expect(node.v(0).position).toBeInstanceOf(Vector3);
    const [dataset, , options] = fitMonteCarloGPU.mock.calls[0];
    expect(dataset).toMatchObject({frame0: 2, frame1: 10, n: 9});
    expect(options.preset).toBe("mc_250k");
    finish();
    await node._fitPromise;
    expect(node.guiDisplay.status).toBe("Ready (WebGPU)");
    expect(node.array).toHaveLength(12);
    expect(node.solvedParams.backend).toBe("webgpu");
    expect(output.recalculateCascade).toHaveBeenCalledTimes(1);
});

test.each(["recalculate", "hide", "dispose"])("%s discards an obsolete in-flight result", async action => {
    const node = new CNodeLOSFitMonteCarloGPU({id: "mc", LOS: "testLOS"});
    node.v(0);
    const pending = node._fitPromise, cancelled = fitMonteCarloGPU.mock.calls[0][2].shouldCancel;
    if (action === "hide") node.show(false);
    else node[action]();
    expect(cancelled()).toBe(true);
    finish();
    await pending;
    expect(node.solvedParams).toBeNull();
    expect(node.guiDisplay.status).not.toBe("Ready (WebGPU)");
});

test("GPU errors are displayed, without retrying every frame", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fitMonteCarloGPU.mockRejectedValue(new Error("WebGPU unavailable"));
    const node = new CNodeLOSFitMonteCarloGPU({id: "mc", LOS: "testLOS"});
    node.v(0);
    await node._fitPromise;
    expect(node.guiDisplay.status).toMatch(/Unavailable: WebGPU unavailable/);
    node.v(1);
    expect(fitMonteCarloGPU).toHaveBeenCalledTimes(1);
    warn.mockRestore();
});

test("selecting a previously fitted hidden node refreshes inputs skipped by visible-only cascades", async () => {
    const node = new CNodeLOSFitMonteCarloGPU({id: "mc", LOS: "testLOS"});
    node.show();
    node.v(0);
    finish();
    await node._fitPromise;
    node.show(false);
    // A hidden node need not receive recalculate when the timebase changes.
    setSit({frames: 12, fps: 4, simSpeed: 1, aFrame: 2, bFrame: 10});
    node.show();
    node.v(0);
    expect(fitMonteCarloGPU).toHaveBeenCalledTimes(2);
    expect(fitMonteCarloGPU.mock.calls[1][0].fps).toBe(4);
    finish();
    await node._fitPromise;
});
