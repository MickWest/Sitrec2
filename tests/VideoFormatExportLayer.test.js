/** @jest-environment jsdom */
import {setNodeMan} from '../src/Globals';
import {VideoFormatExportLayer} from '../src/videoFilters/VideoFormatExportLayer';
import {AnalogVideoFilter} from '../src/videoFilters/AnalogVideoFilter';

jest.mock('../src/videoFilters/AnalogVideoFilter', () => ({
    AnalogVideoFilter: jest.fn().mockImplementation(options => ({
        options, filterFrame: jest.fn(source => source), dispose: jest.fn(),
    })),
}));

let contexts;
function view(id, zIndex, extras = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 100;
    return {id, canvas, zIndex, leftPx: 10, topPx: 20, widthPx: 100, heightPx: 50,
        _effectivelyVisible: true, ...extras};
}

beforeEach(() => {
    contexts = new Map();
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
        if (!contexts.has(this)) contexts.set(this, {
            drawImage: jest.fn(), fillRect: jest.fn(), clearRect: jest.fn(), globalAlpha: 1,
        });
        return contexts.get(this);
    });
    AnalogVideoFilter.mockClear();
});
afterEach(() => jest.restoreAllMocks());

test('captures the letterboxed host and visible HUD before filtering, once per encoded frame', () => {
    const host = view('lookView', 1);
    host.canvas.style.width = '80px';
    host.canvas.style.height = '50px';
    host.canvas.style.left = '10px';
    const hud = view('hud', 2, {overlayView: host, transparency: .5});
    const hidden = view('hidden', 3, {in: {relativeTo: host}});
    hidden.canvas.style.display = 'none';
    setNodeMan({list: {host: {data: host}, hud: {data: hud}, hidden: {data: hidden}}});
    const settings = {signal: {format: 'rs170'}, screen: {enabled: true}};
    const layer = new VideoFormatExportLayer(host, {width: 200, height: 100, fps: 24, settings});
    for (let i = 0; i < 4; i++) layer.capture(); // warm-up/settling is not filter time
    expect(layer.filter.filterFrame).not.toHaveBeenCalled();
    const draws = contexts.get(layer.source).drawImage.mock.calls;
    expect(draws[0]).toEqual([host.canvas, 20, 0, 160, 100]);
    expect(draws[1]).toEqual([hud.canvas, 0, 0, 200, 100]);
    expect(draws.some(args => args[0] === hidden.canvas)).toBe(false);
    const destination = {drawImage: jest.fn()};
    layer.draw(destination, 10, 20, 100, 50);
    expect(layer.filter.filterFrame).toHaveBeenCalledTimes(1);
    expect(layer.filter.options).toMatchObject({fps: 24, settings});
    expect(destination.drawImage.mock.calls[0]).toEqual([layer.source, 10, 20, 100, 50]);
    layer.dispose();
    expect(layer.filter.dispose).toHaveBeenCalledTimes(1);
});

test('keeps higher viewport views above the filtered picture and omits a hidden host', () => {
    const host = view('lookView', 1);
    const hud = view('hud', 3, {in: {relativeTo: host}});
    const lower = view('mainView', 2);
    const higher = view('inset', 4, {leftPx: 60, topPx: 45, widthPx: 25, heightPx: 20});
    const overlay = view('insetOverlay', 0, {overlayView: higher});
    setNodeMan({list: Object.fromEntries([host, hud, lower, higher, overlay].map(v => [v.id, {data: v}]))});
    const layer = new VideoFormatExportLayer(host, {width: 200, height: 100, fps: 30, settings: {}});
    layer.capture([host, lower, hud, higher, overlay]);
    expect(contexts.get(layer.foreground).drawImage.mock.calls).toEqual([
        [higher.canvas, 100, 50, 50, 40], [overlay.canvas, 100, 50, 50, 40],
    ]);
    host._effectivelyVisible = false;
    layer.capture();
    layer.draw({drawImage: jest.fn()}, 0, 0, 200, 100);
    expect(layer.filter.filterFrame).not.toHaveBeenCalled();
    layer.dispose();
});
