import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {asyncOperationRegistry} from '../src/AsyncOperationRegistry';

// Exercise the actual loader with transport/parser stubs, without initializing
// its browser UI and worker dependencies. Keep its private deduplication map.
const source = fs.readFileSync(path.join(__dirname, '../src/CFileManager.js'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'CFileManager').declaration;
const loaderSource = declaration.body.body
    .filter(node => node.key?.name === 'loadAsset' || node.key?.id?.name === 'loadingPromises')
    .map(node => source.slice(node.start, node.end)).join('\n');

// shareBase is the channel-neutral app root (SITREC_SHARE_APP); it equals appBase
// everywhere except a channel install, where appBase is the immutable build directory.
function createLoader(appBase, localhost = '', shareBase = appBase) {
    const Globals = {parsing: 0, pendingActions: 0};
    const LoadingManager = {registerLoading: jest.fn(), completeLoading: jest.fn()};
    const fileSystemFetch = jest.fn().mockResolvedValue({
        ok: true, arrayBuffer: async () => new ArrayBuffer(8),
    });
    const bindings = {
        Globals, LoadingManager, fileSystemFetch, asyncOperationRegistry,
        SITREC_APP: appBase, SITREC_SHARE_APP: shareBase, isConsole: false, versionString: 'test',
        process: {env: {LOCALHOST: localhost}}, getEnv: (_key, fallback) => fallback,
        isHttpOrHttps: url => /^https?:\/\//i.test(url),
        isResolvableSitrecReference: url => url.startsWith('sitrec://'),
        resolveURLForFetch: jest.fn().mockResolvedValue('https://objects.example/track.kml'),
        assert: (condition, message) => { if (!condition) throw new Error(message); },
    };
    const Loader = new Function(...Object.keys(bindings), `return class {${loaderSource}}`)(...Object.values(bindings));
    const manager = Object.assign(new Loader(), {
        list: {},
        exists(id) { return this.list[id] !== undefined; },
        iterate(callback) { Object.entries(this.list).forEach(([id, entry]) => callback(id, entry.data)); },
        add(id, data, original) { this.list[id] = {data, original}; },
        isLikelyImportedLocalAssetPath: () => false,
        isLikelyWorkingFolderAssetPath: () => false,
        normalizeWorkingFolderRelativePath: () => null,
        parseAsset: jest.fn(async filename => ({filename, parsed: {loaded: true}, dataType: 'json'})),
    });
    return {manager, ...bindings};
}

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
    asyncOperationRegistry.clear();
    jest.restoreAllMocks();
});

const reportedAssets = [
    'nightsky/constellations.lines.astrometry.json',
    'models/FA-18F.glb',
    'models/A-10.glb',
    'models/Lear-75.glb',
];

describe.each([
    'https://local.metabunk.org/sitrec/',
    'https://local.metabunk.org/render/',
    'http://localhost:8080/',
    'https://www.metabunk.org/sitrec/builds/current-build/',
])('restoring bundled assets into %s', appBase => {
    test.each(reportedAssets)('%s uses the current installation', async asset => {
        const {manager, fileSystemFetch} = createLoader(appBase);
        const result = await manager.loadAsset('https://www.metabunk.org/sitrec/data/' + asset, asset);
        expect(fileSystemFetch).toHaveBeenCalledWith(appBase + 'data/' + asset + '?v=1test', expect.any(Object));
        expect(result.filename).toBe(appBase + 'data/' + asset);
        expect(manager.list[asset].staticURL).toBe(result.filename);
    });
});

test.each([
    'https://metabunk.org/sitrec/data/models/FA-18F.glb?source=saved',
    'http://www.metabunk.org/sitrec/data/models/FA-18F.glb?source=saved',
    'https://www.metabunk.org/sitrec/builds/old-build/data/models/FA-18F.glb?source=saved',
    'https://local.metabunk.org/sitrec/data/models/FA-18F.glb?source=saved',
    'https://local.metabunk.org/old-branch/data/models/FA-18F.glb?source=saved',
    'http://localhost:8081/old-branch/data/models/FA-18F.glb?source=saved',
    'https://dev.example:8443/old-branch/data/models/FA-18F.glb?source=saved',
])('relocates recognized saved asset URL %s', async url => {
    const {manager, fileSystemFetch} = createLoader('https://current.example/app/', 'dev.example:8443');
    await manager.loadAsset(url, 'model');
    expect(fileSystemFetch).toHaveBeenCalledWith(
        'https://current.example/app/data/models/FA-18F.glb?source=saved&v=1test', expect.any(Object));
});

test.each([
    'https://third-party.example/data/models/FA-18F.glb',
    'https://www.metabunk.org/attachments/data/track.kml',
    'https://www.metabunk.org/sitrec/sitrecServer/windProxy.php',
    'https://www.metabunk.org/sitrec-videos/public/video.mp4',
    'https://www.metabunk.org/sitrec/uploads/data/track.kml',
    'https://www.metabunk.org.example/sitrec/data/models/FA-18F.glb',
    'https://current.example/app/data/models/FA-18F.glb',
])('preserves external, service and current asset URL %s', async url => {
    const {manager, fileSystemFetch} = createLoader('https://current.example/app/');
    await manager.loadAsset(url, 'asset');
    expect(fileSystemFetch).toHaveBeenCalledWith(url + '?v=1test', expect.any(Object));
});

// Legacy sitches name their videos "../sitrec-videos/...", one level above the app
// root. On a channel install the app's assets live in /sitrec/builds/<id>/, and 2.156.0
// resolved the prefix from there, so every legacy video 404'd at /sitrec/builds/sitrec-videos/.
test.each([
    ['https://www.metabunk.org/sitrec/', 'https://www.metabunk.org/sitrec/'],
    ['https://www.metabunk.org/sitrec/builds/current-build/', 'https://www.metabunk.org/sitrec/'],
    ['https://local.metabunk.org/render/', 'https://local.metabunk.org/render/'],
])('legacy ../sitrec-videos/ paths resolve against the app root, not the build directory (%s)', async (appBase, shareBase) => {
    const {manager, fileSystemFetch} = createLoader(appBase, '', shareBase);
    await manager.loadAsset('../sitrec-videos/public/video.mp4', 'video');
    expect(fileSystemFetch).toHaveBeenCalledWith(shareBase + '../sitrec-videos/public/video.mp4?v=1test', expect.any(Object));
});

test('object references still use object resolution', async () => {
    const {manager, fileSystemFetch, resolveURLForFetch} = createLoader('https://current.example/app/');
    await manager.loadAsset('sitrec://123/track.kml', 'track');
    expect(resolveURLForFetch).toHaveBeenCalled();
    expect(fileSystemFetch).toHaveBeenCalledWith('https://objects.example/track.kml', expect.any(Object));
});

test('a handled fetch failure cleans up, permits retry and has no unhandled rejection', async () => {
    const {manager, fileSystemFetch, Globals} = createLoader('https://current.example/app/');
    const error = new TypeError('Failed to fetch');
    fileSystemFetch.mockRejectedValueOnce(error);
    await expect(manager.loadAsset('models/A-10.glb', 'model')).rejects.toBe(error);
    // Let detached promise rejections surface; Jest fails if cleanup creates one.
    await new Promise(resolve => setImmediate(resolve));
    expect(Globals).toEqual({parsing: 0, pendingActions: 0});
    expect(asyncOperationRegistry.getCount()).toBe(0);
    await expect(manager.loadAsset('models/A-10.glb', 'model')).resolves.toMatchObject({parsed: {loaded: true}});
    expect(fileSystemFetch).toHaveBeenCalledTimes(2);
});
