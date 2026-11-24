import {createInundationWorker, InundationCancelled, InundationWorkerClient} from "../src/water/InundationWorkerClient";

class FakeWorker {
    constructor() {
        this.messages = [];
        this.terminate = jest.fn();
        this.postMessage = jest.fn((data, transfer = []) => {
            this.messages.push(structuredClone(data, {transfer}));
        });
    }

    receive(data) { this.onmessage({data}); }
}

test("a completed request returns its result and progress belongs only to its active calculation", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker), progress = jest.fn();
    const pending = client.request("geometry", {domain: 1}, [], progress);
    const id = worker.messages[0].id;
    worker.receive({id: id + 1, progress: {fraction: 0.1}});
    worker.receive({id, progress: {stage: "Coverage", done: 3, total: 4, fraction: 0.75}});
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({stage: "Coverage", done: 3, total: 4, fraction: 0.75});
    const result = {barriers: {east: new Uint8Array([0, 1, 0])}};
    worker.receive({id, result});
    expect(worker.messages.at(-1)).toEqual({type: "accept", id});
    await expect(pending).resolves.toBe(result);
    worker.receive({id, progress: {fraction: 1}});
    expect(progress).toHaveBeenCalledTimes(1);
    expect(client.pending).toBeNull();
    client.dispose();
});

test("a newer calculation cancels the old promise immediately and ignores late replies", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const oldProgress = jest.fn(), newProgress = jest.fn();
    const first = client.request("geometry", {level: 2}, [], oldProgress);
    const firstFailure = first.catch(error => error);
    const firstId = worker.messages[0].id;
    const second = client.request("geometry", {level: 3}, [], newProgress);
    const secondId = worker.messages.at(-1).id;
    expect(worker.messages[1]).toEqual({type: "cancel", id: firstId});
    expect(await firstFailure).toBeInstanceOf(InundationCancelled);
    worker.receive({id: firstId, progress: {fraction: 1}});
    worker.receive({id: firstId, result: {level: 2}});
    worker.receive({id: firstId, error: "late failure"});
    expect(worker.messages.some(message => message.type === "accept" && message.id === firstId)).toBe(false);
    expect(oldProgress).not.toHaveBeenCalled();
    expect(newProgress).not.toHaveBeenCalled();
    expect(client.pending.id).toBe(secondId);
    worker.receive({id: secondId, result: {level: 3}});
    await expect(second).resolves.toEqual({level: 3});
    client.dispose();
});

test("Lock cancellation preserves the worker cache and permits a later calculation", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const first = client.request("fill", {level: 2}).catch(error => error);
    const id = worker.messages[0].id;
    client.cancel();
    expect((await first).name).toBe("AbortError");
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(client.pending).toBeNull();
    client.cancel();
    expect(worker.messages).toHaveLength(2);
    worker.receive({id, result: {wet: new Uint8Array([255])}});
    const next = client.request("fill", {level: 2});
    worker.receive({id: worker.messages.at(-1).id, result: {wet: new Uint8Array([0])}});
    await expect(next).resolves.toEqual({wet: new Uint8Array([0])});
    client.dispose();
});

test("transferring calculation copies leaves caller-owned render and geoid buffers attached", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const livePositions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const copiedPositions = new Float64Array(livePositions);
    const liveGeoid = new Int16Array([100, 200, 300]);
    const request = client.request("geometry", {positions: copiedPositions, geoid: liveGeoid}, [copiedPositions.buffer]);
    expect(copiedPositions.byteLength).toBe(0);
    expect([...livePositions]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...liveGeoid]).toEqual([100, 200, 300]);
    const sent = worker.messages[0];
    expect([...sent.payload.positions]).toEqual([...livePositions]);
    expect(sent.payload.geoid.buffer).not.toBe(liveGeoid.buffer);
    sent.payload.geoid[0] = -50;
    expect(liveGeoid[0]).toBe(100);
    worker.receive({id: sent.id, result: {}});
    await request;
    client.dispose();
});

test("a calculation error rejects that job without discarding a healthy worker", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const first = client.request("geometry", {});
    const failure = expect(first).rejects.toThrow("bad geometry");
    worker.receive({id: worker.messages[0].id, error: "bad geometry"});
    await failure;
    expect(worker.terminate).not.toHaveBeenCalled();
    const next = client.request("geometry", {});
    worker.receive({id: worker.messages.at(-1).id, result: {ok: true}});
    await expect(next).resolves.toEqual({ok: true});
    client.dispose();
});

test.each([
    ["onerror", {message: "worker load failed"}, "worker load failed"],
    ["onmessageerror", {}, "unreadable data"],
])("%s fails pending and future requests without leaving a hung promise", async (event, details, message) => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const pending = client.request("geometry", {});
    const failure = expect(pending).rejects.toThrow(message);
    worker[event](details);
    await failure;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(client.pending).toBeNull();
    await expect(client.request("fill", {})).rejects.toThrow(message);
    expect(worker.messages).toHaveLength(1);
});

test("a transfer failure rejects the request and terminates the unusable worker", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    worker.postMessage.mockImplementationOnce(() => { throw new Error("buffer could not be cloned"); });
    await expect(client.request("geometry", {})).rejects.toThrow("buffer could not be cloned");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(client.pending).toBeNull();
});

test("geometry acceptance is sent before resolving and an acknowledgement failure rejects the result", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker), accepted = [];
    const first = client.request("geometry", {}).then(() => accepted.push(worker.messages.at(-1).type));
    worker.receive({id: worker.messages[0].id, result: {}});
    expect(accepted).toEqual([]);
    await first;
    expect(accepted).toEqual(["accept"]);
    const next = client.request("geometry", {});
    const failure = expect(next).rejects.toThrow("ack failed");
    const id = worker.messages.at(-1).id;
    worker.postMessage.mockImplementationOnce(() => { throw new Error("ack failed"); });
    worker.receive({id, result: {}});
    await failure;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test("clearing geometry cancels its pending job but keeps the shared worker usable for terrain", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const first = client.request("geometry", {}).catch(error => error);
    const id = worker.messages[0].id;
    client.clearGeometry();
    expect(await first).toBeInstanceOf(InundationCancelled);
    expect(worker.messages.slice(1)).toEqual([{type: "cancel", id}, {type: "clearGeometry"}]);
    expect(worker.terminate).not.toHaveBeenCalled();
    const terrain = client.request("fill", {useBuildings: false});
    const fillId = worker.messages.at(-1).id;
    worker.receive({id: fillId, result: {wet: new Uint8Array([255])}});
    await expect(terrain).resolves.toEqual({wet: new Uint8Array([255])});
    expect(worker.messages.at(-1).type).toBe("fill");
    client.dispose();
});

test("disposing a busy worker rejects its job and refuses future work", async () => {
    const worker = new FakeWorker(), client = new InundationWorkerClient(worker);
    const first = client.request("geometry", {}).catch(error => error);
    const id = worker.messages[0].id;
    client.dispose();
    expect(await first).toBeInstanceOf(InundationCancelled);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.receive({id, result: {late: true}});
    await expect(client.request("geometry", {})).rejects.toMatchObject({name: "AbortError"});
});

test("unsupported and synchronously blocked workers select the calculation fallback", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    try {
        delete globalThis.Worker;
        expect(createInundationWorker()).toBeNull();
        globalThis.Worker = jest.fn(() => { throw new Error("worker blocked"); });
        expect(createInundationWorker()).toBeNull();
    } finally {
        if (original) Object.defineProperty(globalThis, "Worker", original);
        else delete globalThis.Worker;
    }
});
