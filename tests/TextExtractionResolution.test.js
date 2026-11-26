/** @jest-environment jsdom */
import {undoManager} from "../src/UndoManager";
import {TextExtractor} from '../src/CTextExtraction';
import {loadTesseract} from '../src/tesseractLoader';

jest.mock('../src/Globals', () => ({Globals: {}, Sit: {}, setRenderOne: jest.fn()}));
jest.mock('../src/par', () => ({par: {frame: 0}}));
jest.mock('../src/tesseractLoader', () => ({loadTesseract: jest.fn(), getTesseract: jest.fn()}));
jest.mock('../src/configUtils', () => ({}));
jest.mock('../src/i18n', () => ({t: s => s}));
jest.mock('../src/showError', () => ({}));

test('a text region selects the same source area at playback and analysis resolutions', () => {
    const extractor = new TextExtractor({videoData: {originalVideoWidth: 1920, originalVideoHeight: 1080}});
    const region = {x1: 900, x2: 1200, y1: 600, y2: 750, numChars: 5};
    expect(extractor.regionToImage(region, {width: 1280, height: 720}))
        .toEqual({x1: 600, x2: 800, y1: 400, y2: 500, numChars: 5});
    expect(extractor.regionToImage(region, {width: 1920, height: 1080})).toEqual(region);
    expect(region.x1).toBe(900);
});

test('stopping during OCR loading cannot start extraction after loading finishes', async () => {
    let ready;
    loadTesseract.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    const videoData = {getImage: jest.fn()};
    const extractor = new TextExtractor({videoData});
    extractor.enabled = true;
    extractor.regions = [{}];
    const running = extractor.startExtraction();
    await extractor.startExtraction();
    ready();
    await running;
    expect(videoData.getImage).not.toHaveBeenCalled();
    expect(extractor.extracting).toBe(false);
    expect(extractor.extractionSession).toBeNull();
});

test("a region drag and a deletion replay independently with the same extracted data", () => {
    undoManager.clear();
    const mouse = {handlers: {}};
    const extractor = new TextExtractor({mouse, canvasToVideoCoordsOriginal: (x,y) => [x,y]});
    extractor.enabled = true;
    extractor.hookMouseHandler();
    const dispatch = (type, x, y) => {
        Object.assign(mouse, {x, y});
        mouse.handlers[type]({});
    };
    extractor.startAddRegion();
    dispatch("down", 5, 10);
    dispatch("drag", 100, 80);
    dispatch("up", 100, 80);
    const region = extractor.selectedRegion;
    region.extractedText.set(9, "123");
    dispatch("down", 50, 45);
    dispatch("drag", 60, 60);
    dispatch("drag", 70, 70);
    expect(undoManager.getStatus().undoCount).toBe(1);
    dispatch("up", 70, 70);
    extractor.removeSelectedRegion();
    expect(extractor.regions).toHaveLength(0);
    expect(undoManager.undo()).toBe(true);
    expect(extractor.selectedRegion.extractedText.get(9)).toBe("123");
    expect(extractor.selectedRegion.x1).toBe(25);
    undoManager.undo();
    expect(extractor.selectedRegion.x1).toBe(5);
    undoManager.redo();
    expect(extractor.selectedRegion.x1).toBe(25);
    undoManager.redo();
    expect(extractor.regions).toEqual([]);
});
