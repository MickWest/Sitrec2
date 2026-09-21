jest.mock('../src/nodes/CNodeTrackingOverlay', () => ({CNodeActiveOverlay: class {
    modSerialize() { return {}; }
    modDeserialize() {}
    renderCanvas() {}
}}));
jest.mock('../src/Globals', () => ({setRenderOne: jest.fn()}));
jest.mock('../src/ViewUtils', () => ({mouseToCanvas: jest.fn()}));
jest.mock('../src/UndoManager', () => ({undoManager: {}}));
jest.mock('../src/KeyBoardHandler', () => ({isKeyCodeHeld: jest.fn()}));
jest.mock('../src/FlowAlignment', () => ({getFlowAlignRotation: jest.fn()}));
jest.mock('../src/CEventManager', () => ({EventManager: {}}));
jest.mock('../src/par', () => ({par: {frame: 0}}));

const {CNodeMaskOverlay} = require('../src/nodes/CNodeMaskOverlay');
let images, originalImage, originalDocument;

beforeEach(() => {
    images = [];
    originalImage = global.Image;
    originalDocument = global.document;
    global.Image = class { constructor() { images.push(this); } };
    global.document = {createElement: () => {
        const canvas = {width: 0, height: 0};
        const context = {drawImage: jest.fn(), clearRect: jest.fn(), putImageData: jest.fn(),
            getImageData: jest.fn(() => ({width: canvas.width, height: canvas.height, data: []}))};
        canvas.getContext = () => context;
        return canvas;
    }};
});

afterEach(() => {
    if (originalImage === undefined) delete global.Image;
    else global.Image = originalImage;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
});

function restored() {
    const overlay = new CNodeMaskOverlay({});
    overlay.maskData = 'data:image/png;base64,first';
    overlay.initMask(640, 480);
    return overlay;
}

test('initial restored mask is painted at the video dimensions', () => {
    const overlay = restored();
    images[0].onload();
    expect(overlay.maskCtx.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 640, 480);
    expect(overlay.maskCtx.clearRect).toHaveBeenCalledWith(0, 0, 640, 480);
    expect(overlay.maskCtx.clearRect.mock.invocationCallOrder[0]).toBeLessThan(overlay.maskCtx.drawImage.mock.invocationCallOrder[0]);
    expect(overlay.maskImageData).toMatchObject({width: 640, height: 480});
});

test('a mask image completing after its canvas is cleared is harmless', () => {
    const overlay = restored();
    const context = overlay.maskCtx;
    overlay.maskCanvas = null;
    overlay.maskCtx = null;
    expect(() => images[0].onload()).not.toThrow();
    expect(context.drawImage).not.toHaveBeenCalled();
});

test('an older mask cannot overwrite a newer mask that decoded first', () => {
    const overlay = restored();
    overlay.maskData = 'data:image/png;base64,second';
    overlay.loadMask();
    images[1].onload();
    images[0].onload();
    expect(overlay.maskCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(overlay.maskCtx.drawImage).toHaveBeenLastCalledWith(images[1], 0, 0, 640, 480);
});

test('a mask decoded after resize uses the current video dimensions', () => {
    const overlay = restored();
    overlay.initMask(320, 240);
    images[0].onload();
    expect(overlay.maskCtx.drawImage).toHaveBeenLastCalledWith(images[0], 0, 0, 320, 240);
});

test.each([
    [false, false, false], [false, true, true], [true, false, true], [true, true, true],
])('Show=%s Edit=%s controls mask visibility independently of Enable', (show, edit, visible) => {
    const overlay = new CNodeMaskOverlay({});
    for (const enabled of [true, false]) {
        overlay.maskEnabled = enabled;
        overlay.setShowMaskPreview(show);
        overlay.setEditing(edit);
        expect(overlay.visible).toBe(visible);
    }
});

test('Show, Edit and Enable round-trip even when the mask overlay is hidden', () => {
    const overlay = new CNodeMaskOverlay({});
    overlay.maskEnabled = false;
    overlay.setShowMaskPreview(true);
    const restored = new CNodeMaskOverlay({});
    restored.modDeserialize(overlay.modSerialize());
    expect(restored).toMatchObject({maskEnabled: false, showMaskPreview: true, editing: false, visible: true});
    restored.modDeserialize({});
    expect(restored).toMatchObject({maskEnabled: true, showMaskPreview: false, editing: false, visible: false});
});

test('numeric menu flags save and restore as booleans', () => {
    const overlay = new CNodeMaskOverlay({});
    overlay.setShowMaskPreview(1);
    overlay.setEditing(0);
    expect(overlay.modSerialize()).toMatchObject({showMaskPreview: true, editing: false});
    overlay.modDeserialize({showMaskPreview: 0, editing: 1});
    expect(overlay).toMatchObject({showMaskPreview: false, editing: true, visible: true});
});

test.each([true, false])('preview intensity follows Enable=%s in both Show and Edit modes', enabled => {
    const overlay = new CNodeMaskOverlay({});
    overlay.maskCanvas = {};
    overlay.maskEnabled = enabled;
    overlay.ensureMaskInitialized = jest.fn();
    overlay.handleBrushSizeKeys = jest.fn();
    overlay.drawBrushCursor = jest.fn();
    overlay.overlayView = {getSourceAndDestCoords: jest.fn(), in: {zoom: 1}};
    overlay.ctx = {save: jest.fn(), restore: jest.fn(), drawImage: jest.fn()};
    require('../src/FlowAlignment').getFlowAlignRotation.mockReturnValue(0);
    for (const editing of [false, true]) {
        overlay.setShowMaskPreview(!editing);
        overlay.setEditing(editing);
        overlay.renderCanvas(0);
        expect(overlay.ctx.globalAlpha).toBe(enabled ? .4 : .2);
    }
});
