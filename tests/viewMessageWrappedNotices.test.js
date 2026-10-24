/**
 * @jest-environment jsdom
 */
// The two notices that say what went wrong at load (a failed login check, a sitch that did
// not fully load) must be read to their end, so they wrap onto more lines rather than being
// cut with an ellipsis in a narrow (for example half-width) main view.

const fs = require('fs');
const vm = require('vm');
const babel = require('@babel/core');
const {t} = require('../src/i18n');
const {Globals, setNodeMan} = require('../src/Globals');
const {checkLogin} = require('../src/login');

jest.mock('../src/runtimeConfig', () => ({configParams: {rehostRequiresLogin: true}}));
jest.mock('../src/configUtils', () => ({isServerless: false, SITREC_SERVER: 'https://example.test/sitrecServer/'}));

describe('the notice for a failed login check', () => {
    let mainView;
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        document.body.innerHTML = '';
        const div = document.createElement('div');
        div.style.position = 'absolute';
        document.body.appendChild(div);
        mainView = {id: 'mainView', div};
        setNodeMan({get: id => (id === 'mainView' ? mainView : undefined)});
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        setNodeMan(undefined);
        delete global.fetch;
        delete Globals.userID;
        delete Globals.userData;
    });

    test('wraps instead of being cut with an ellipsis', async () => {
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
        await checkLogin();
        const notice = mainView.div.querySelector('[role=status]');
        expect(notice.textContent).toBe(t('file.loginCheckFailed'));
        expect(notice.style.whiteSpace).toBe('normal');
        expect(notice.style.textOverflow).not.toBe('ellipsis');
    });
});

describe('the notice for a sitch that did not fully load', () => {
    // Runs the real deserialize with the managers it touches stubbed, as in
    // clientSecurityDeserialize.test.js. Importing the module itself would pull in
    // three/addons, which Jest cannot load.
    const source = fs.readFileSync(require.resolve('../src/CustomManagerSerialize.js'), 'utf8');
    const code = babel.transformSync(source, {configFile: false, plugins: [() => ({visitor: {
        ImportDeclaration(p) { p.remove(); },
        ExportNamedDeclaration(p) { p.replaceWith(p.node.declaration); },
    }})]}).code;

    function harness() {
        const mainView = {id: 'mainView'};
        const context = {
            console: {log: jest.fn(), warn: jest.fn(), error: jest.fn()},
            Globals: {loadGeneration: 1, settings: {}}, Sit: {}, par: {}, GlobalDateTimeNode: null,
            FileManager: {list: {}},
            NodeMan: {exists: () => false, get: () => undefined, list: {}, recalculateAllRootFirst: jest.fn()},
            TrackManager: {applyDisplayNames() {}},
            TimelineMarkers: {deserialize() {}},
            ViewMan: {restoreFullscreenFromMods() {}, get: id => (id === 'mainView' ? mainView : undefined)},
            showViewMessage: jest.fn(),
            t,
            setSitchEstablished: jest.fn(),
            setRenderOne: jest.fn(),
        };
        vm.createContext(context);
        vm.runInContext(code + ';globalThis.methods = serializeMethods;', context);
        const manager = {
            ...context.methods,
            deserializeMods: jest.fn(async () => { throw new Error('bad mod'); }),
        };
        return {manager, context, mainView};
    }

    // deserialize() starts its chain without returning it; let that chain run out.
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    test('wraps instead of being cut with an ellipsis', async () => {
        const {manager, context, mainView} = harness();
        manager.deserialize({mods: {}});
        await settle();
        expect(context.showViewMessage).toHaveBeenCalledTimes(1);
        expect(context.showViewMessage).toHaveBeenCalledWith(mainView, t('file.sitchNotFullyLoaded'),
            expect.objectContaining({wrap: true}));
    });
});
