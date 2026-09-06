/** @jest-environment jsdom */
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
