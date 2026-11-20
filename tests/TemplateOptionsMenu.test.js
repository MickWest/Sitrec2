/** @jest-environment jsdom */
jest.mock('../src/configUtils', () => ({isAdmin: jest.fn()}));
jest.mock('../src/Globals', () => ({guiMenus: {}, Sit: {}, markSitchDirty: jest.fn()}));
import {isAdmin} from '../src/configUtils';
import {guiMenus, Sit, markSitchDirty} from '../src/Globals';
import {setupTemplateOptionsMenu} from '../src/TemplateOptionsMenu';

function menu() {
    const m = {folders: {}, controls: [], close: () => m, open: () => m, tooltip: () => m,
        addFolder: name => (m.folders[name] = menu()),
        add: (object, property) => {
            const c = {object, property, name: () => c, listen: () => c, tooltip: () => c};
            m.controls.push(c); return c;
        }};
    return m;
}
beforeEach(() => {
    guiMenus.file = menu();
    delete Sit.templateOptions;
    Sit.templateSource = {name: 'Star Tracker'};
    markSitchDirty.mockClear();
    isAdmin.mockReturnValue(true);
});

test('only an admin gets the template authoring menu', () => {
    isAdmin.mockReturnValue(false);
    setupTemplateOptionsMenu();
    expect(guiMenus.file.folders).toEqual({});
    isAdmin.mockReturnValue(true);
    setupTemplateOptionsMenu();
    expect(guiMenus.file.folders['Template Options']).toBeDefined();
});

test('an admin edit produces serializable options and cannot edit after losing permission', () => {
    setupTemplateOptionsMenu();
    const options = guiMenus.file.folders['Template Options'];
    const control = options.folders['On Media Import'].controls.find(c => c.property === 'analyzeVideos');
    control.object.analyzeVideos = false;
    expect(JSON.parse(JSON.stringify(Sit)).templateOptions).toMatchObject({analyzeImages: true, analyzeVideos: false});
    expect(markSitchDirty).toHaveBeenCalledTimes(1);
    isAdmin.mockReturnValue(false);
    control.object.analyzeVideos = true;
    expect(Sit.templateOptions.analyzeVideos).toBe(false);
});

test('presets set the complete saved policy without changing the scene location or time', () => {
    setupTemplateOptionsMenu();
    const presets = guiMenus.file.folders['Template Options'].folders.Presets.controls;
    presets[2].object.apply();
    expect(Sit.templateOptions).toMatchObject({satellites: 'manual', analyzeImages: false, findNightView: false});
    presets[1].object.apply();
    expect(Sit.templateOptions).toMatchObject({satellites: 'manual', analyzeImages: true, analyzeVideos: true, findNightView: true});
    expect(Sit.startTime).toBeUndefined();
    expect(Sit.lat).toBeUndefined();
});
