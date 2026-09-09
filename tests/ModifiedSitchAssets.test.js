import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry} from '../src/trackSourceUtils';

// Run the real serializer with scene/UI managers stubbed, avoiding browser-only
// worker imports. File selection and metadata generation are production code.
const source = fs.readFileSync(path.join(__dirname, '../src/CustomManagerSerialize.js'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.type === 'ExportNamedDeclaration'
        && node.declaration?.declarations?.[0]?.id.name === 'serializeMethods');
const method = declaration.declaration.declarations[0].init.properties
    .find(node => node.key.name === 'getCustomSitchString');

function save({local = false, custom = false} = {}) {
    const empty = () => null;
    const manager = {serialize: empty};
    const bindings = {
        Sit: {name: custom ? 'custom' : 'modelinspector', isCustom: custom, canMod: !custom},
        FileManager: {list: {
            'imported-model.ply': {
                filename: 'imported-model.ply', staticURL: 'https://objects.example/model.ply',
                localStaticURL: 'assets/model.ply', dynamicLink: true, dataType: 'ply',
            },
            'overlay.png': {filename: 'overlay.png', staticURL: 'https://objects.example/overlay.png', dataType: 'groundOverlayImage'},
            'source.bin': {filename: 'source.bin', staticURL: 'https://objects.example/source.bin', skipSerialization: true},
        }},
        NodeMan: {exists: () => false, iterate: () => {}},
        TrackManager: {iterate: () => {}, serialize: empty, serializeBalloons: empty},
        Globals: {menuBar: {modSerialize: empty}},
        GlobalScene: {children: []}, par: {}, Units: {modSerialize: empty},
        FeatureManager: manager, CustomGraphManager: manager, Synth3DManager: manager, LayoutMan: manager,
        serializeMotionAnalysis: empty, serializeAutoTracking: empty, serializeHorizonExtractor: empty,
        serializeScriptedVideo: empty, serializeLongExposure: empty,
        process: {env: {BUILD_VERSION_NUMBER: '2.156.2', BUILD_VERSION_STRING: 'test', VERSION: 'test'}},
        currentBuild: null, collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry,
        assert: (condition, message) => { if (!condition) throw new Error(message); },
    };
    const serializer = new Function(...Object.keys(bindings),
        `return ({${source.slice(method.start, method.end)}}).getCustomSitchString`)(...Object.values(bindings));
    return JSON.parse(serializer.call({serializeFixedObjects: empty, serializeSubSitches: empty}, local));
}

test.each([false, true])('hosted imported assets survive saving a %s custom scene', custom => {
    const result = save({custom});
    expect(result.loadedFiles).toEqual({
        'imported-model.ply': 'https://objects.example/model.ply',
        'overlay.png': 'https://objects.example/overlay.png',
    });
    expect(result.loadedFilesMetadata['overlay.png']).toEqual({dataType: 'groundOverlayImage'});
    if (!custom) expect(result.modding).toBe('modelinspector');
});

test('modified scenes retain working-folder asset paths in local saves', () => {
    const result = save({local: true});
    expect(result.loadedFiles['imported-model.ply']).toBe('assets/model.ply');
    expect(result.loadedFiles['source.bin']).toBeUndefined();
});
