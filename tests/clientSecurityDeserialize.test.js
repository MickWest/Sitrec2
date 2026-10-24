const fs = require('fs');
const vm = require('vm');
const babel = require('@babel/core');

// Runs the real deserialize/finishDeserialization with the managers they touch stubbed.
// Importing the module itself would pull in three/addons, which Jest cannot load.
const source = fs.readFileSync(require.resolve('../src/CustomManagerSerialize.js'), 'utf8');
const code = babel.transformSync(source, {configFile: false, plugins: [() => ({visitor: {
    ImportDeclaration(p) { p.remove(); },
    ExportNamedDeclaration(p) { p.replaceWith(p.node.declaration); },
}})]}).code;

const {t} = require('../src/i18n');

function harness() {
    const settings = {chatModel: 'default-model', aiEffort: 'low', tileSegments: 64};
    const Globals = {loadGeneration: 1, settings, showLabelsMain: true, objectScale: 1};
    const mainView = {id: 'mainView'};
    const context = {
        console: {log: jest.fn(), warn: jest.fn(), error: jest.fn()},
        Globals, Sit: {}, par: {}, GlobalDateTimeNode: null,
        FileManager: {list: {}},
        NodeMan: {exists: () => false, get: () => undefined, list: {}, recalculateAllRootFirst: jest.fn()},
        TrackManager: {applyDisplayNames() {}},
        TimelineMarkers: {deserialize() {}},
        ViewMan: {restoreFullscreenFromMods() {}, get: id => (id === 'mainView' ? mainView : undefined)},
        showViewMessage: jest.fn(),
        t,
        setSitchEstablished: jest.fn(),
        setRenderOne: jest.fn(),
        updateDocumentTitle() {}, refreshLabelsAfterLoading() {}, refreshLatLonGridVisibility() {},
        restoreRefractionTool: async () => {},
        deserializeMotionAnalysis: jest.fn(async () => {}),
        deserializeLongExposure() {}, deserializeVideoFormatEffects() {},
        deserializeVideoQPGraph: async () => {}, deserializeVideoTonalGraph: async () => {},
        deserializePointTrackFrequencyGraph: async () => {}, deserializeVideoNoisePattern: async () => {},
        applyFlightLightweightGating() {},
        checkAndOfferTLERefresh: async () => {},
    };
    vm.createContext(context);
    vm.runInContext(code + ';globalThis.methods = serializeMethods;', context);
    const manager = {
        ...context.methods,
        refreshLookViewTracks() {}, applyTrackLimit() {}, markChapterBaseline() {},
        deserializeMods: jest.fn(async () => true),
    };
    return {manager, Globals, settings, context, mainView};
}

// deserialize() starts its chain without returning it; let that chain run out.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('restoring a saved sitch\'s globals', () => {
    test('a shared sitch cannot replace Globals.settings or lifecycle state', async () => {
        const {manager, Globals, settings} = harness();
        const proto = Object.getPrototypeOf(Globals);
        const hostile = JSON.parse(`{
            "settings": {"chatModel": "costly-model", "aiEffort": "max"},
            "env": {"SITREC_SERVER": "https://evil.example/"},
            "loadGeneration": 99,
            "__proto__": {"polluted": true},
            "showLabelsMain": false
        }`);
        await manager.finishDeserialization({globals: hostile}, 1);
        expect(Globals.settings).toBe(settings);
        expect(settings).toEqual({chatModel: 'default-model', aiEffort: 'low', tileSegments: 64});
        expect(Globals.env).toBeUndefined();
        expect(Globals.restoredLoadGeneration).toBe(1);
        expect(Object.getPrototypeOf(Globals)).toBe(proto);
        // The genuine display toggle in the same block still restores.
        expect(Globals.showLabelsMain).toBe(false);
    });

    test('a value of the wrong type is ignored', async () => {
        const {manager, Globals} = harness();
        await manager.finishDeserialization({globals: {
            showLabelsMain: 'false', objectScale: 'huge', objectScaleMain: 7.5,
        }}, 1);
        expect(Globals.showLabelsMain).toBe(true);
        expect(Globals.objectScale).toBe(1);
        expect(Globals.objectScaleMain).toBe(7.5);
    });

    test('a save from before per-view Show Tracks still sets the Look gate', async () => {
        const {manager, Globals} = harness();
        await manager.finishDeserialization({globals: {showTracks: false}}, 1);
        expect(Globals.showTracks).toBe(false);
        expect(Globals.showTracksLook).toBe(false);
    });

    test('every global the save writes is one the load restores', () => {
        const {context} = harness();
        vm.runInContext('globalThis.restorable = RESTORABLE_GLOBALS;', context);
        const saved = source.match(/const globalsNeeded = \[([\s\S]*?)\]/)[1];
        const names = [...saved.matchAll(/^\s*"(\w+)"/gm)].map(m => m[1]);
        expect(names.length).toBeGreaterThan(10);
        expect(Object.keys(context.restorable).sort()).toEqual(names.sort());
    });
});

describe('a failure late in a sitch restore', () => {
    const openCVFailure = context => context.deserializeMotionAnalysis.mockImplementation(async () => {
        throw new Error('OpenCV load timed out');
    });

    test.each([
        ['with mods', {mods: {}, motionAnalysis: {}}],
        ['without mods', {motionAnalysis: {}}],
    ])('does not leave the app stuck mid-load (%s)', async (label, sitchData) => {
        const {manager, Globals, context} = harness();
        openCVFailure(context);
        manager.deserialize(sitchData);
        await settle();
        expect(context.console.error).toHaveBeenCalledWith(
            'Deserialization did not complete cleanly:', expect.objectContaining({message: 'OpenCV load timed out'}));
        expect(Globals.deserializing).toBe(false);
        // Edits recalculate again, and the graph caught up with what did load.
        expect(Globals.dontRecalculate).toBe(false);
        expect(context.NodeMan.recalculateAllRootFirst).toHaveBeenCalled();
        expect(context.setRenderOne).toHaveBeenCalledWith(3);
    });

    test('only a sitch with mods is marked established', async () => {
        const withMods = harness();
        withMods.manager.deserialize({mods: {}});
        const without = harness();
        without.manager.deserialize({});
        await settle();
        expect(withMods.context.setSitchEstablished).toHaveBeenCalledWith(true);
        expect(without.context.setSitchEstablished).not.toHaveBeenCalled();
        // Both still finish normally.
        expect(withMods.Globals.deserializing).toBe(false);
        expect(without.Globals.deserializing).toBe(false);
    });

    test('a failure in a load that a newer one replaced leaves the new load alone', async () => {
        const {manager, Globals, context} = harness();
        context.deserializeMotionAnalysis.mockImplementation(async () => {
            // A newer sitch load starts while this one waits on OpenCV.
            Globals.loadGeneration++;
            Globals.deserializing = true;
            Globals.dontRecalculate = true;
            throw new Error('OpenCV load timed out');
        });
        manager.deserialize({mods: {}, motionAnalysis: {}});
        await settle();
        expect(context.console.error).toHaveBeenCalled();
        expect(Globals.deserializing).toBe(true);
        expect(Globals.dontRecalculate).toBe(true);
        expect(context.NodeMan.recalculateAllRootFirst).not.toHaveBeenCalled();
        // The newer sitch is the one on screen, so nothing is said about this one.
        expect(context.showViewMessage).not.toHaveBeenCalled();
    });

    // The partly restored sitch is interactive and not marked dirty, so without a notice a
    // save writes the skipped parts out of it. The notice must not block: no dialog, no click.
    test.each([
        ['finishDeserialization', context => openCVFailure(context)],
        ['deserializeMods', (context, manager) => manager.deserializeMods.mockRejectedValue(new Error('bad mod'))],
    ])('a failure in %s says once, over the main view, that the sitch did not fully load', async (_, fail) => {
        const {manager, context, mainView} = harness();
        fail(context, manager);
        manager.deserialize({mods: {}, motionAnalysis: {}});
        await settle();
        expect(context.console.error).toHaveBeenCalledWith('Deserialization did not complete cleanly:', expect.any(Error));
        expect(context.showViewMessage).toHaveBeenCalledTimes(1);
        expect(context.showViewMessage).toHaveBeenCalledWith(mainView,
            'This sitch did not fully load. Saving it now may lose parts of it.', expect.any(Object));
    });

    test('a sitch that loads completely shows no notice', async () => {
        const {manager, Globals, context} = harness();
        manager.deserialize({mods: {}, motionAnalysis: {}});
        await settle();
        expect(Globals.deserializing).toBe(false);
        expect(context.console.error).not.toHaveBeenCalled();
        expect(context.showViewMessage).not.toHaveBeenCalled();
    });
});
