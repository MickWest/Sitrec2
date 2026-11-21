import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry} from '../src/trackSourceUtils';
import {CNodeDisplayWindField} from '../src/nodes/CNodeDisplayWindField';

// Run the real serializer with scene/UI managers stubbed, avoiding browser-only
// worker imports. File selection and metadata generation are production code.
const source = fs.readFileSync(path.join(__dirname, '../src/CustomManagerSerialize.js'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.type === 'ExportNamedDeclaration'
        && node.declaration?.declarations?.[0]?.id.name === 'serializeMethods');
const method = declaration.declaration.declarations[0].init.properties
    .find(node => node.key.name === 'getCustomSitchString');

function save({local = false, custom = false, nodes = {}, sit = {}, savingTemplate, options} = {}) {
    const empty = () => null;
    const manager = {serialize: empty};
    const bindings = {
        Sit: {name: custom ? 'custom' : 'modelinspector', isCustom: custom, canMod: !custom, ...sit},
        FileManager: {savingTemplate, list: {
            'imported-model.ply': {
                filename: 'imported-model.ply', staticURL: 'https://objects.example/model.ply',
                localStaticURL: 'assets/model.ply', dynamicLink: true, dataType: 'ply',
            },
            'overlay.png': {filename: 'overlay.png', staticURL: 'https://objects.example/overlay.png', dataType: 'groundOverlayImage'},
            'source.bin': {filename: 'source.bin', staticURL: 'https://objects.example/source.bin', skipSerialization: true},
        }},
        NodeMan: {exists: () => false, iterate: fn => Object.entries(nodes).forEach(([id, node]) => fn(id, node))},
        TrackManager: {iterate: () => {}, serialize: empty, serializeBalloons: empty, serializeKites: () => [], serializeDisplayNames: () => ({})},
        Globals: {menuBar: {modSerialize: empty}},
        GlobalScene: {children: []}, par: {}, Units: {modSerialize: empty},
        FeatureManager: manager, TimelineMarkers: manager, CustomGraphManager: manager, MeasurementManager: manager,
        Synth3DManager: manager, LayoutMan: manager,
        serializeMotionAnalysis: empty, serializeAutoTracking: empty, serializeHorizonExtractor: empty,
        serializeScriptedVideo: empty, serializeLongExposure: empty, serializeVideoFormatEffects: empty,
        serializeVideoQPGraph: empty, serializeVideoTonalGraph: empty, serializePointTrackFrequencyGraph: empty,
        serializeVideoNoisePattern: empty,
        process: {env: {BUILD_VERSION_NUMBER: '2.156.2', BUILD_VERSION_STRING: 'test', VERSION: 'test'}},
        buildVersionNumber: () => 2156002,
        currentBuild: null, collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry,
        assert: (condition, message) => { if (!condition) throw new Error(message); },
    };
    const serializer = new Function(...Object.keys(bindings),
        `return ({${source.slice(method.start, method.end)}}).getCustomSitchString`)(...Object.values(bindings));
    return JSON.parse(serializer.call({serializeFixedObjects: empty, serializeSubSitches: empty}, local, options));
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

test('only Save as Template keeps the template options of a custom scene', () => {
    const sit = {templateOptions: {analyzeImages: true, satellites: 'manual'}, templateSource: {name: 'Star Tracker'}};
    for (const local of [false, true]) {
        const ordinary = save({custom: true, local, sit});
        expect(ordinary).not.toHaveProperty('templateOptions');
        expect(ordinary).not.toHaveProperty('templateSource');
    }
    expect(save({custom: true, sit, savingTemplate: true}).templateOptions).toEqual(sit.templateOptions);
    // A reload in memory keeps an administrator's unsaved options, but not the template session.
    const reload = save({custom: true, sit, options: {keepTemplateOptions: true}});
    expect(reload.templateOptions).toEqual(sit.templateOptions);
    expect(reload).not.toHaveProperty('templateSource');
});

test('the scene serializer includes wind snapshots only for a local save', () => {
    const windField = Object.assign(Object.create(CNodeDisplayWindField.prototype), {
        id:'windField', simpleSerials:[], source:'gfs', inspectObjects:{}, inspectPoints:[], _loadedWindFiles:new Map(),
        _levelCache:{'gfs:20201230_6_surface':{nx:2, ny:2, u:[8,8,8,8], v:[0,0,0,0]}},
    });
    const nodes = {windField};
    expect(typeof save({custom:true, local:true, nodes}).mods.windField.localWindGrids).toBe('string');
    expect(save({custom:true, nodes}).mods.windField.localWindGrids).toBeUndefined();
});
