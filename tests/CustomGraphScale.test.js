jest.mock("../src/nodes/CNodeCurveEdit2", () => ({CNodeOSDGraphView: class {}}));
jest.mock("../src/nodes/CNodeTabbedCanvasView", () => ({CNodeTabbedCanvasView: class {renderCanvas() {}}}));
jest.mock("../src/Globals", () => ({Sit: {frames: 100}, NodeMan: {}, setRenderOne: jest.fn()}));
jest.mock("../src/par", () => ({par: {frame: 0}}));

import {CNodeCustomGraphView} from "../src/nodes/CNodeCustomGraphView";

function graph(equalAspect) {
    return Object.assign(Object.create(CNodeCustomGraphView.prototype), {
        equalAspect, isFrameX: false, widthPx: 600, heightPx: 400,
        series: [{yAxis: 1, data: [{x: 0.2, y: 1000}, {x: 0.8, y: 2000}]}],
    });
}

test("speed versus altitude uses independent ranges instead of square unlike units", () => {
    const view = graph(false);
    view.autoScale();
    expect(view.minX).toBeCloseTo(0.188);
    expect(view.maxX).toBeCloseTo(0.812);
    expect(view.minY).toBeCloseTo(950);
    expect(view.maxY).toBeCloseTo(2050);
});

test("spatial coordinate pairs can retain equal screen scale", () => {
    const view = graph(true);
    view.autoScale();
    const xUnitsPerPixel = (view.maxX - view.minX) / (view.widthPx - 120);
    const yUnitsPerPixel = (view.maxY - view.minY) / (view.heightPx - 120);
    expect(xUnitsPerPixel).toBeCloseTo(yUnitsPerPixel);
});

test("independent value axes preserve fixed bounds and separate altitude scale", () => {
    const view = graph(false);
    view.series[0].fixedMin = -1;
    view.series[0].fixedMax = 1;
    view.series.push({yAxis: 2, data: [{x: 0.2, y: 10000}, {x: 0.8, y: 20000}]});
    view.autoScale();
    expect([view.minY, view.maxY]).toEqual([-1, 1]);
    expect(view.hasY2).toBe(true);
    expect(view.minY2).toBeCloseTo(9500);
    expect(view.maxY2).toBeCloseTo(20500);
});


test("missing samples do not invent crosshair values across gaps or outside observations", () => {
    const view = graph(false);
    view.preserveGaps = true;
    const series = {data: [{frame: 2, x: 2, y: 20}, {frame: 3, x: 3, y: 30}, {frame: 6, x: 6, y: 60}]};
    expect(view.interpolateSeriesAtFrame(series, 2.5)).toEqual({x: 2.5, y: 25});
    expect(view.interpolateSeriesAtFrame(series, 4)).toBeNull();
    expect(view.interpolateSeriesAtFrame(series, 1)).toBeNull();
    expect(view.interpolateSeriesAtFrame(series, 7)).toBeNull();
    expect(view.interpolateSeriesAtFrame(series, 6)).toEqual({x: 6, y: 60});
});


test("isolated partial-analysis frame samples remain visible as points", () => {
    const view = graph(false);
    const ctx = new Proxy({}, {get(target, key) {
        if (!(key in target)) target[key] = jest.fn();
        return target[key];
    }});
    ctx.measureText.mockImplementation(text => ({width: text.length * 7}));
    Object.assign(view, {visible: true, preserveGaps: true, isFrameX: true, ctx,
        minX: 0, maxX: 5, minY: 0, maxY: 2, dark: true, showLegend: false,
        _lastWidth: view.widthPx, _lastHeight: view.heightPx,
        series: [{yAxis: 1, data: [{frame: 1, x: 1, y: 1}, {frame: 4, x: 4, y: 1}]}],
        calculateStep: () => 1,
    });
    view.renderCanvas(0);
    expect(ctx.arc).toHaveBeenCalledTimes(2);
});


test("narrow high-altitude ticks remain distinct and horizontal labels do not overlap", () => {
    const view = graph(false);
    const ctx = new Proxy({}, {get(target, key) {
        if (!(key in target)) target[key] = jest.fn();
        return target[key];
    }});
    ctx.measureText.mockImplementation(text => ({width: text.length * 7}));
    Object.assign(view, {visible: true, preserveGaps: true, ctx, isFrameX: false, dark: true, showLegend: false,
        minX: 32681, maxX: 32683, minY: 0, maxY: 2,
        _lastWidth: view.widthPx, _lastHeight: view.heightPx,
        calculateStep: () => 0.2,
    });
    view.renderCanvas(0);
    const labels = ctx.fillText.mock.calls.filter(([, , y]) => y === view.heightPx - 40);
    expect(labels.length).toBeGreaterThan(2);
    expect(new Set(labels.map(([label]) => label)).size).toBe(labels.length);
    expect(labels.some(([label]) => /3268[12]\.[1-9]/.test(label))).toBe(true);
    for (let i = 1; i < labels.length; i++) {
        const [previous, px] = labels[i - 1];
        const [label, x] = labels[i];
        expect(x - label.length * 3.5 - (px + previous.length * 3.5)).toBeGreaterThanOrEqual(8);
    }
});


test("speed and altitude minimum spans apply independently to all three Y axes", () => {
    const view = graph(false);
    view.isFrameX = true;
    view.series = [
        {yAxis: 1, minimumRange: 10, data: [{x: 0, y: 4704.58}, {x: 1, y: 4704.70}]},
        {yAxis: 2, minimumRange: 10, data: [{x: 0, y: -1e-8}, {x: 1, y: 1e-8}]},
        {yAxis: 3, minimumRange: 10, data: [{x: 0, y: 32000}, {x: 1, y: 32000}]},
    ];
    view.autoScale();
    expect(view.minY).toBeCloseTo(4699.64);
    expect(view.maxY).toBeCloseTo(4709.64);
    expect([view.minY2, view.maxY2]).toEqual([-5, 5]);
    expect([view.minY3, view.maxY3]).toEqual([31995, 32005]);
    view.series[0].data[1].y = 4800;
    view.autoScale();
    expect(view.maxY - view.minY).toBeGreaterThan(95);
});

test("rolling-window whole-clip bounds honor the minimum Y span", () => {
    const view = graph(false);
    view.isFrameX = true;
    view.fixedXRange = {min: 100, max: 200};
    Object.assign(view.series[0], {minimumRange: 10, fixedMin: 4704.5, fixedMax: 4704.7});
    view.autoScale();
    expect([view.minX, view.maxX]).toEqual([100, 200]);
    expect([view.minY, view.maxY]).toEqual([4699.6, 4709.6]);
});
