import {detectFrameSources} from "../src/starTrack/StarForegroundMask";

test("worker replies include the frame mask and preserve the synchronous detection result", () => {
    const previous = global.self;
    try {
        global.self = {postMessage: jest.fn()};
        require("../src/workers/StarDetectWorker");
        const W = 80, H = 64, rgba = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const rgb = x > 60 && y > 20 ? [100, 25, 10] : [20, 35, 65];
            rgba.set([...rgb, 255], 4 * (y * W + x));
        }
        const opts = {autoMaskForeground: true};
        global.self.onmessage({data: {rgba: rgba.buffer, W, H, opts}});
        const [reply, transferred] = global.self.postMessage.mock.calls[0];
        expect(reply).toEqual(detectFrameSources(rgba, W, H, opts));
        expect(transferred).toEqual([reply.foregroundMask.data.buffer]);
        global.self.onmessage({data: {rgba: rgba.buffer, W, H, opts: {excludeMask: new Uint8Array(1)}}});
        expect(global.self.postMessage.mock.calls[1][0]).toEqual({error: expect.stringMatching(/dimensions/)});
    } finally {
        if (previous === undefined) delete global.self;
        else global.self = previous;
    }
});
