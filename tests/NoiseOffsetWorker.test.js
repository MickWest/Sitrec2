import {createNoisePatternCore} from "../src/videoNoisePattern/NoisePatternWorkerCore";

test("offset frame decode accepts bounded continuation messages and returns only requested pictures", async () => {
    const post = jest.fn();
    const descriptor = {offset: 0, stride: 16, step: 1, width: 16, height: 16, sx: 1, sy: 1};
    const core = createNoisePatternCore({post, decoder: {
        async decodeSegment(message, onFrame, more) {
            const items = [...message.items];
            let last = message.last;
            while (!last) { const part = await more(); items.push(...part.items); last = part.last; }
            for (const item of items) onFrame({index: item.index, data: new Uint8Array(256).fill(40 + item.index),
                descriptors: {shift: 0, planes: [descriptor, descriptor, descriptor]}});
            return {decoded: items.length, failed: 0};
        },
    }});
    const running = core.handle({type: "offsetFrames", id: 1, targets: [0, 2], step: 4, items: [{index: 0}], last: false});
    await core.handle({type: "decodeChunks", id: 1, items: [{index: 1}, {index: 2}], last: true});
    await running;
    const result = post.mock.calls.at(-1)[0];
    expect(result.type).toBe("offsetFrames");
    expect(result.frames.map(f => f.index)).toEqual([0, 2]);
    expect(Array.from(result.frames[1].planes[0].pixels)).toEqual(new Array(16).fill(42));
});
