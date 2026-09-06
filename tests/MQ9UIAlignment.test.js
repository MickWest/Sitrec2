/** @jest-environment jsdom */
import {CNodeMQ9UI} from "../src/nodes/CNodeMQ9UI";

function hud(width, height, video) {
    const node = Object.create(CNodeMQ9UI.prototype);
    Object.assign(node, {widthPx: width, heightPx: height});
    node.hudRect = node.getHUDRect(video);
    return node;
}

function videoRect(width, height, sx, sy, sw, sh, dx, dy, dw, dh) {
    return {widthPx: width, heightPx: height, videoWidth: 640, videoHeight: 480,
        videoToCanvasCoords(x, y) { return [dx + (x - sx) / sw * dw, dy + (y - sy) / sh * dh]; }};
}

test('MQ9 reticle follows the source image through the reported zoom and pan', () => {
    const video = videoRect(950, 426, 45.014216852660844, 97.77835214859695,
        550.5943291111582, 246.89808863300354, 0, 0, 950, 426);
    const node = hud(950, 426, video);
    expect(node.px_square(50)).toBeCloseTo(474.46273994811116, 8);
    expect(node.py(50)).toBeCloseTo(245.3904050863476, 8);
    // Compare all four arm endpoints to the burned-in 640x480 HUD geometry.
    expect(node.px_square(56)).toBeCloseTo(video.videoToCanvasCoords(320 + 480 * .06, 240)[0], 8);
    expect(node.px_square(44)).toBeCloseTo(video.videoToCanvasCoords(320 - 480 * .06, 240)[0], 8);
    expect(node.py(44)).toBeCloseTo(video.videoToCanvasCoords(320, 480 * .44)[1], 8);
    expect(node.py(56)).toBeCloseTo(video.videoToCanvasCoords(320, 480 * .56)[1], 8);
    // Text size is a length, independent of a panned image's negative origin.
    expect(node.sx(1.5)).toBeGreaterThan(0);
});

test('letterboxed video controls crosshair size as well as its center', () => {
    const video = videoRect(960, 871, 0, 0, 640, 480, 0, 75.5, 960, 720);
    const node = hud(960, 871, video);
    expect(node.px_square(50)).toBe(480);
    expect(node.py(50)).toBe(435.5);
    expect(node.py(56) - node.py(50)).toBeCloseTo(43.2);
    expect(node.px_square(56) - node.px_square(50)).toBeCloseTo(43.2);
});

test('maps image coordinates between differently sized panes', () => {
    const video = videoRect(640, 480, 80, 60, 320, 240, 0, 0, 640, 480);
    const node = hud(960, 720, video);
    expect([node.px_square(50), node.py(50)]).toEqual([720, 540]);
});

test('standalone recording keeps its original 640x480 HUD', () => {
    const node = hud(640, 480, null);
    expect(node.hudRect).toEqual({x: 0, y: 0, width: 640, height: 480});
    expect([node.px_square(50), node.py(50)]).toEqual([320, 240]);
    expect(node.py(44)).toBe(211.2);
});
