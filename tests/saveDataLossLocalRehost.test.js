/** @jest-environment jsdom */
// A local sitch's assets must be copied into whatever folder it is saved into.
// Loading from folder A caches "already in the folder" for each asset; saving
// into folder B must not trust that, or B's sitch points at files B lacks.
import fs from 'node:fs';
import path from 'node:path';
import {TextDecoder, TextEncoder} from 'node:util';
import {parse} from '@babel/parser';
import {asyncOperationRegistry} from '../src/AsyncOperationRegistry';
import {saveMethods} from '../src/CFileManagerSave';

// Run the real loadAsset (as CFileManagerLoadAsset.test.js does) so the cache
// entry it seeds is the one the save path sees.
const source = fs.readFileSync(path.join(__dirname, '../src/CFileManager.js'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'CFileManager').declaration;
const loaderSource = declaration.body.body
    .filter(node => node.key?.name === 'loadAsset' || node.key?.id?.name === 'loadingPromises')
    .map(node => source.slice(node.start, node.end)).join('\n');

const notFound = (what) => Object.assign(new Error(`${what} not found`), {name: 'NotFoundError'});

// In-memory folder with the subset of the File System Access API the save path uses.
// Desktop handles carry a `path` and are rebuilt for every pick; browser ones do not.
function memoryFolder(files = {}, desktopPath = undefined) {
    const store = new Map(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)]));
    const dir = (prefix) => ({
        kind: 'directory',
        ...(desktopPath !== undefined && {path: desktopPath + (prefix ? '/' + prefix.slice(0, -1) : '')}),
        async getDirectoryHandle(name, {create = false} = {}) {
            const sub = prefix + name + '/';
            if (!create && ![...store.keys()].some(key => key.startsWith(sub))) throw notFound(sub);
            return dir(sub);
        },
        async getFileHandle(name, {create = false} = {}) {
            const key = prefix + name;
            if (!create && !store.has(key)) throw notFound(key);
            return {
                async getFile() { return {arrayBuffer: async () => store.get(key).slice().buffer}; },
                async createWritable() {
                    let pending;
                    return {write: async data => { pending = data; }, close: async () => { store.set(key, new Uint8Array(pending)); }};
                },
            };
        },
    });
    return {handle: () => dir(''), text: name => store.has(name) ? new TextDecoder().decode(store.get(name)) : undefined};
}

function createManager(directoryHandle) {
    const bindings = {
        Globals: {parsing: 0, pendingActions: 0},
        LoadingManager: {registerLoading: jest.fn(), completeLoading: jest.fn()},
        fileSystemFetch: jest.fn(), asyncOperationRegistry,
        SITREC_APP: 'https://example.test/', SITREC_SHARE_APP: 'https://example.test/', isConsole: false, versionString: 'test',
        process: {env: {}}, getEnv: (_key, fallback) => fallback,
        isHttpOrHttps: url => /^https?:\/\//i.test(url),
        isResolvableSitrecReference: url => url.startsWith('sitrec://'),
        resolveURLForFetch: jest.fn(),
        assert: (condition, message) => { if (!condition) throw new Error(message); },
    };
    const Loader = new Function(...Object.keys(bindings), `return class {${loaderSource}}`)(...Object.values(bindings));
    return Object.assign(new Loader(), saveMethods, {
        list: {},
        directoryHandle,
        _localSitchContextActive: true,
        _localRehostPathCache: new Map(),
        exists(id) { return this.list[id] !== undefined; },
        iterate(callback) { Object.entries(this.list).forEach(([id, entry]) => callback(id, entry.data)); },
        isLikelyImportedLocalAssetPath: () => false,
        // The parts of parseResult the save path reads: a dynamic-link entry holding the read buffer.
        parseResult: jest.fn(async function (filename, buffer) {
            this.list[filename] = {data: {}, original: buffer, dynamicLink: true, filename, dataType: 'trackfile'};
            return [{filename, parsed: {}, dataType: 'trackfile'}];
        }),
    });
}

const TRACK = 'local/tracks/t.kml';

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
    asyncOperationRegistry.clear();
    jest.restoreAllMocks();
});

describe('saving a loaded local sitch', () => {
    test('into a newly selected browser folder copies its assets there', async () => {
        const folderA = memoryFolder({[TRACK]: '<kml>A</kml>'});
        const folderB = memoryFolder();
        const manager = createManager(folderA.handle());
        await manager.loadAsset(TRACK, TRACK);

        // Select Local Sitch Folder (or the folder prompt on Save Local) picks B.
        manager.directoryHandle = folderB.handle();
        await manager.rehostDynamicLinksLocal(manager.directoryHandle);

        expect(folderB.text(TRACK)).toBe('<kml>A</kml>');
        expect(manager.list[TRACK].localStaticURL).toBe(TRACK);
    });

    test('with desktop Save Local As into another folder copies its assets there', async () => {
        const folderA = memoryFolder({[TRACK]: '<kml>A</kml>'}, '/Users/me/A');
        const folderB = memoryFolder({}, '/Users/me/B');
        const manager = createManager(folderA.handle());
        await manager.loadAsset(TRACK, TRACK);

        // Save Local As hands the target folder straight to the save, leaving directoryHandle on A.
        await manager.rehostDynamicLinksLocal(folderB.handle());

        expect(folderB.text(TRACK)).toBe('<kml>A</kml>');
    });

    test('into a folder that already has a different file of that name keeps both', async () => {
        const folderA = memoryFolder({[TRACK]: '<kml>A</kml>'});
        const folderB = memoryFolder({[TRACK]: '<kml>B</kml>'});
        const manager = createManager(folderA.handle());
        await manager.loadAsset(TRACK, TRACK);

        await manager.rehostDynamicLinksLocal(folderB.handle());

        expect(folderB.text(TRACK)).toBe('<kml>B</kml>');
        expect(folderB.text('local/tracks/t-2.kml')).toBe('<kml>A</kml>');
        expect(manager.list[TRACK].localStaticURL).toBe('local/tracks/t-2.kml');
    });

    test.each([
        ['the same browser handle', undefined, (handle) => handle],
        ['a rebuilt desktop handle for the same path', '/Users/me/A', (_handle, folder) => folder.handle()],
    ])('back into its own folder via %s reuses the file without re-reading it', async (_label, desktopPath, saveTarget) => {
        const folderA = memoryFolder({[TRACK]: '<kml>A</kml>'}, desktopPath);
        const handle = folderA.handle();
        const manager = createManager(handle);
        await manager.loadAsset(TRACK, TRACK);
        const read = jest.spyOn(manager, 'getWorkingFolderFileHandle');

        await manager.rehostDynamicLinksLocal(saveTarget(handle, folderA));

        expect(read).not.toHaveBeenCalled();
        expect(manager.list[TRACK].localStaticURL).toBe(TRACK);
    });
});
