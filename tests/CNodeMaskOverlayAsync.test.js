jest.mock('../src/nodes/CNodeTrackingOverlay', () => ({CNodeActiveOverlay: class {}}));
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
        const context = {drawImage: jest.fn(), putImageData: jest.fn(),
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
