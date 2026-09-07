/** @jest-environment jsdom */
jest.mock('../src/Globals', () => ({setRenderOne: jest.fn()}));
jest.mock('../src/configUtils', () => ({SITREC_APP: 'https://example.test/app/'}));
jest.mock('../src/AsyncOperationRegistry', () => ({asyncOperationRegistry: {registerPromise: jest.fn()}}));

let finish, fail, ready;
beforeEach(() => {
    jest.resetModules();
    ready = new Promise((resolve, reject) => {finish = resolve; fail = reject;});
    global.FontFace = jest.fn(function() {this.load = () => ready;});
    Object.defineProperty(document, 'fonts', {configurable: true, value: {add: jest.fn()}});
});
afterEach(() => {delete global.FontFace; delete document.fonts;});

test('shares font loading across HUDs and keeps export waiting until it is ready', async () => {
    const {ensureMQ9FontLoaded} = require('../src/HUDFonts');
    const {asyncOperationRegistry} = require('../src/AsyncOperationRegistry');
    const {setRenderOne} = require('../src/Globals');
    const first = ensureMQ9FontLoaded();
    expect(ensureMQ9FontLoaded()).toBe(first);
    expect(FontFace).toHaveBeenCalledTimes(1);
    expect(FontFace.mock.calls[0][1]).toContain('https://example.test/app/data/fonts/SitrecOSD.ttf');
    expect(asyncOperationRegistry.registerPromise).toHaveBeenCalledWith(first, 'font', expect.any(String));
    expect(setRenderOne).not.toHaveBeenCalled();
    finish();
    await expect(first).resolves.toBe(true);
    expect(setRenderOne).toHaveBeenCalledWith(true);
});

test('reports missing fonts so a benchmark cannot silently record fallback glyphs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const {ensureMQ9FontLoaded} = require('../src/HUDFonts');
        const pending = ensureMQ9FontLoaded();
        fail(new Error('missing font'));
        await expect(pending).resolves.toBe(false);
        expect(warn).toHaveBeenCalled();
    } finally {warn.mockRestore();}
});
