/** @jest-environment jsdom */
// Save and Save As do not write to a template. Only "Save as Template" does.
// A sitch opened from a template has no name, so its first Save asks for one.
import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';

jest.mock('../src/SitchTemplates', () => ({
    GLOBAL_TEMPLATE_LABEL: 'Global Template',
    LOCAL_TEMPLATE_LABEL: 'Local Template',
    ownTemplateLabels: jest.fn(),
    updateGlobalTemplates: jest.fn(),
    addLocalTemplateLabel: jest.fn(),
    templateAddress: jest.requireActual('../src/SitchTemplates').templateAddress,
}));
jest.mock('../src/showError', () => ({showChoice: jest.fn(), showConfirm: jest.fn(), showError: jest.fn()}));
jest.mock('../src/TextPrompt', () => ({promptForText: jest.fn()}));
jest.mock('../src/configUtils', () => ({
    ...jest.requireActual('../src/configUtils'),
    isAdmin: jest.fn(() => true),
    SITREC_SHARE_APP: 'http://localhost/sitrec/',
}));

import {saveMethods} from '../src/CFileManagerSave';
import {Globals, setSit, Sit} from '../src/Globals';
import {isAdmin} from '../src/configUtils';
import {showChoice, showConfirm, showError} from '../src/showError';
import {promptForText} from '../src/TextPrompt';
import {addLocalTemplateLabel, ownTemplateLabels, updateGlobalTemplates} from '../src/SitchTemplates';

const USER = 42;
const TEMPLATES = {'Flares': ['Global Template'], 'My Setup': ['Local Template']};

let manager, typedName, previousUserID;

// The file manager, with the real save methods and no storage: saveSitchNamed records the name.
function createManager() {
    return {
        ...saveMethods,
        saveSitchNamed: jest.fn(async () => {}),
        // The name prompt. `typedName` is what the user enters; null is Cancel.
        inputSitchName: jest.fn(async () => {
            if (typedName === null) throw "Sitch Name Cancelled";
            Sit.sitchName = typedName;
        }),
        confirmOverwriteForNamedSave: jest.fn(async () => true),
        refreshVersions: jest.fn(async () => {}),
        activateStorageFolder: jest.fn(),
        guiFolder: {close: jest.fn()},
        sourceUserID: 7,
    };
}

beforeEach(() => {
    previousUserID = Globals.userID;
    Globals.userID = USER;
    Globals.loadGeneration = 1;
    typedName = 'New Name';
    manager = createManager();
    isAdmin.mockReturnValue(true);
    ownTemplateLabels.mockReset().mockImplementation(async name => TEMPLATES[name] ?? []);
    updateGlobalTemplates.mockReset().mockResolvedValue(undefined);
    addLocalTemplateLabel.mockReset().mockResolvedValue(undefined);
    showChoice.mockReset();
    showConfirm.mockReset().mockResolvedValue(true);
    showError.mockReset();
    promptForText.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    Globals.userID = previousUserID;
    jest.restoreAllMocks();
});

describe('Save', () => {
    test('writes a normal sitch to its name, with no prompt', async () => {
        setSit({sitchName: 'Work'});

        await manager.saveSitch();

        expect(manager.inputSitchName).not.toHaveBeenCalled();
        expect(manager.saveSitchNamed).toHaveBeenCalledWith('Work', false, null, null);
    });

    test.each(['Flares', 'My Setup'])('does not write to the template "%s": it asks for a new name', async (templateName) => {
        setSit({sitchName: templateName});

        await manager.saveSitch();

        expect(manager.inputSitchName).toHaveBeenCalledTimes(1);
        expect(manager.inputSitchName.mock.calls[0][0].message).toContain(`"${templateName}" is a template`);
        expect(manager.saveSitchNamed.mock.calls).toEqual([['New Name', false, null, null]]);
        expect(Sit.sitchName).toBe('New Name');
    });

    test('keeps the name of the sitch when the user cancels that prompt, and saves nothing', async () => {
        setSit({sitchName: 'Flares'});
        typedName = null;

        await expect(manager.saveSitch()).rejects.toBe("Sitch Name Cancelled");

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(Sit.sitchName).toBe('Flares');
    });

    test('refuses the name of a template that the user types', async () => {
        setSit({});
        typedName = 'My Setup';

        await expect(manager.saveSitch()).rejects.toBe("Save Cancelled");

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledTimes(1);
        expect(Sit.sitchName).toBeUndefined();
    });

    test('asks for a name for a sitch that came from a template, which has none', async () => {
        setSit({templateSource: {name: 'Flares', userID: 1}});

        await manager.saveSitch();

        expect(manager.saveSitchNamed.mock.calls).toEqual([['New Name', false, null, null]]);
    });

    // With no answer the name can be a template. A save then would change what each
    // user opens from that template, so the save stops and the user is told.
    test('does not save when the server does not answer the template check', async () => {
        setSit({sitchName: 'Flares'});
        ownTemplateLabels.mockRejectedValue(new Error('metadata.php returned 500'));

        await expect(manager.saveSitch()).rejects.toBe("Save Cancelled");

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(manager.inputSitchName).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0]).toContain('could not check if "Flares" is a template');
        expect(Sit.sitchName).toBe('Flares');
    });

    test('does not save a typed name when the server does not answer the template check', async () => {
        setSit({});
        typedName = 'My Setup';
        ownTemplateLabels.mockRejectedValue(new Error('Failed to fetch'));

        await expect(manager.saveSitch()).rejects.toBe("Save Cancelled");

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(manager.confirmOverwriteForNamedSave).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledTimes(1);
        expect(Sit.sitchName).toBeUndefined();
    });

    test('shows no message for a check that failed after a different sitch loaded', async () => {
        setSit({sitchName: 'Flares'});
        ownTemplateLabels.mockImplementation(async () => {
            Globals.loadGeneration++;
            throw new Error('Failed to fetch');
        });

        await expect(manager.saveSitch()).rejects.toBe("Save Cancelled");

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(showError).not.toHaveBeenCalled();
    });

    test('does not save when a different sitch loads during the template check', async () => {
        setSit({sitchName: 'Work'});
        ownTemplateLabels.mockImplementation(async () => {
            Globals.loadGeneration++;
            setSit({sitchName: 'Other Sitch'});
            return [];
        });

        await manager.saveSitch();

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(Sit.sitchName).toBe('Other Sitch');
    });

    test('saves on the next try, when the server answers again', async () => {
        setSit({sitchName: 'Work'});
        ownTemplateLabels.mockRejectedValueOnce(new Error('metadata.php returned 503'));

        await expect(manager.saveSitch()).rejects.toBe("Save Cancelled");
        await manager.saveSitch();

        expect(manager.saveSitchNamed.mock.calls).toEqual([['Work', false, null, null]]);
    });

    test('to a local file does not ask the server about templates', async () => {
        setSit({sitchName: 'Flares'});

        await manager.saveSitch(true);

        expect(ownTemplateLabels).not.toHaveBeenCalled();
        expect(manager.saveSitchNamed).toHaveBeenCalledWith('Flares', true, null, null);
    });
});

describe('Save As', () => {
    test('does not save when the server does not answer the template check, and the sitch keeps its name', async () => {
        setSit({sitchName: 'Work'});
        typedName = 'Flares';
        ownTemplateLabels.mockRejectedValue(new Error('metadata.php returned 500'));

        await manager.saveSitchAs();

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledTimes(1);
        expect(Sit.sitchName).toBe('Work');
    });

    test('refuses the name of a template, and the sitch keeps its name', async () => {
        setSit({sitchName: 'Work'});
        typedName = 'Flares';

        await manager.saveSitchAs();

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledTimes(1);
        expect(Sit.sitchName).toBe('Work');
    });
});

describe('Save as Template', () => {
    test('saves a new global template, then adds it to the global list for this user', async () => {
        setSit({sitchName: 'Work'});
        promptForText.mockResolvedValue('Satellites');
        showChoice.mockResolvedValue('Global Template');

        expect(await manager.saveSitchAsTemplate()).toBe(true);

        expect(promptForText.mock.calls[0][0].defaultValue).toBe('Work');
        expect(manager.saveSitchNamed.mock.calls).toEqual([['Satellites']]);
        expect(updateGlobalTemplates).toHaveBeenCalledWith({add: [{name: 'Satellites', userID: USER}]});
        expect(addLocalTemplateLabel).not.toHaveBeenCalled();
        expect(Sit.sitchName).toBe('Satellites');
        // The label goes on after the sitch is in storage, so the list entry gets its screenshot.
        expect(manager.saveSitchNamed.mock.invocationCallOrder[0]).toBeLessThan(updateGlobalTemplates.mock.invocationCallOrder[0]);
    });

    test('saves a new local template with the label in the user\'s own file', async () => {
        setSit({sitchName: 'Work'});
        promptForText.mockResolvedValue('Satellites');
        showChoice.mockResolvedValue('Local Template');

        expect(await manager.saveSitchAsTemplate()).toBe(true);

        expect(addLocalTemplateLabel).toHaveBeenCalledWith('Satellites');
        expect(updateGlobalTemplates).not.toHaveBeenCalled();
    });

    test('offers the template that the sitch came from, and saves a new version of it', async () => {
        setSit({templateSource: {name: 'Flares', userID: USER}});
        promptForText.mockImplementation(async ({defaultValue}) => defaultValue);

        expect(await manager.saveSitchAsTemplate()).toBe(true);

        expect(showConfirm).toHaveBeenCalledTimes(1);
        expect(showChoice).not.toHaveBeenCalled();
        expect(manager.saveSitchNamed.mock.calls).toEqual([['Flares']]);
        // It is a template already: the labels do not change.
        expect(updateGlobalTemplates).not.toHaveBeenCalled();
        expect(addLocalTemplateLabel).not.toHaveBeenCalled();
    });

    test('sets the address to the template by name, in place of the address of the saved version', async () => {
        setSit({templateSource: {name: 'Flares', userID: USER}});
        promptForText.mockImplementation(async ({defaultValue}) => defaultValue);
        // The save sets the address of the new version, as CustomManager.serialize does.
        manager.saveSitchNamed = jest.fn(async () => {
            window.history.pushState({}, null, '/sitrec/?custom=42/Flares/20260101_000000.js');
        });
        const historyLength = window.history.length;

        expect(await manager.saveSitchAsTemplate()).toBe(true);

        expect(window.location.pathname + window.location.search).toBe('/sitrec/?template=Flares');
        // One new entry, from the save. The template address replaced it and added none.
        expect(window.history.length).toBe(historyLength + 1);
    });

    test('leaves the address as it is when the template is not saved', async () => {
        setSit({sitchName: 'Work'});
        window.history.replaceState(null, '', '/sitrec/?custom=42/Work/20260101_000000.js');
        promptForText.mockResolvedValue(null);

        expect(await manager.saveSitchAsTemplate()).toBe(false);

        expect(window.location.search).toBe('?custom=42/Work/20260101_000000.js');
    });

    test.each([
        ['the name prompt', () => promptForText.mockResolvedValue(null)],
        ['the type choice', () => { promptForText.mockResolvedValue('Satellites'); showChoice.mockResolvedValue(null); }],
        ['the change of a template', () => { promptForText.mockResolvedValue('Flares'); showConfirm.mockResolvedValue(false); }],
    ])('saves nothing when the user cancels %s', async (_step, cancelAt) => {
        setSit({sitchName: 'Work'});
        cancelAt();

        expect(await manager.saveSitchAsTemplate()).toBe(false);

        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
        expect(updateGlobalTemplates).not.toHaveBeenCalled();
        expect(Sit.sitchName).toBe('Work');
    });

    test('asks before it writes to a different sitch of the user that is not a template', async () => {
        setSit({sitchName: 'Work'});
        promptForText.mockResolvedValue('Other Sitch');
        showChoice.mockResolvedValue('Local Template');
        manager.confirmOverwriteForNamedSave.mockResolvedValue(false);

        expect(await manager.saveSitchAsTemplate()).toBe(false);

        expect(manager.confirmOverwriteForNamedSave).toHaveBeenCalledWith({sitchName: 'Other Sitch'});
        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
    });

    test('saves nothing when the template labels cannot be read', async () => {
        setSit({sitchName: 'Work'});
        promptForText.mockResolvedValue('Satellites');
        ownTemplateLabels.mockRejectedValue(new Error('metadata.php returned 500'));

        expect(await manager.saveSitchAsTemplate()).toBe(false);

        expect(showError).toHaveBeenCalledTimes(1);
        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
    });

    test('tells the user when the sitch is saved but the label is not', async () => {
        setSit({sitchName: 'Work'});
        promptForText.mockResolvedValue('Satellites');
        showChoice.mockResolvedValue('Global Template');
        updateGlobalTemplates.mockRejectedValue(new Error('Admin access required'));

        expect(await manager.saveSitchAsTemplate()).toBe(false);

        expect(manager.saveSitchNamed).toHaveBeenCalledTimes(1);
        expect(showError).toHaveBeenCalledTimes(1);
    });

    test('is for administrators only', async () => {
        setSit({sitchName: 'Work'});
        isAdmin.mockReturnValue(false);

        expect(await manager.saveSitchAsTemplate()).toBe(false);

        expect(promptForText).not.toHaveBeenCalled();
        expect(manager.saveSitchNamed).not.toHaveBeenCalled();
    });

    test('a Save after it does not write to the template', async () => {
        setSit({sitchName: 'Work'});
        promptForText.mockResolvedValue('Flares');
        await manager.saveSitchAsTemplate();
        manager.saveSitchNamed.mockClear();

        await manager.saveSitch();

        expect(manager.saveSitchNamed.mock.calls).toEqual([['New Name', false, null, null]]);
    });
});

describe('a sitch opened as a template', () => {
    // Run the real loadSavedFile from CFileManager.js, with the things that it calls supplied.
    const source = fs.readFileSync(path.join(__dirname, '../src/CFileManager.js'), 'utf8');
    const declaration = parse(source, {sourceType: 'module'}).program.body
        .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'CFileManager').declaration;
    const methodSource = ['loadSavedFile', 'loadTemplateByName'].map(name => {
        const method = declaration.body.body.find(node => node.key?.name === name);
        return source.slice(method.start, method.end);
    }).join('\n');

    const VERSIONS = [{version: 'v1.js', ref: 'sitrec://7/Flares/v1.js'}, {version: 'v2.js', ref: 'sitrec://7/Flares/v2.js'}];
    let loaded, findTemplateByName, showError;

    function createLoader() {
        loaded = [];
        findTemplateByName = jest.fn(async name => ({name, userID: 7}));
        showError = jest.fn();
        const bindings = {
            findTemplateByName: (...args) => findTemplateByName(...args),
            // A saved sitch has its name two times: at the top level, and in the "Sit" block.
            fetch: jest.fn(async () => ({ok: true, text: async () => JSON.stringify(
                {sitchName: 'Flares', isASitchFile: true, lat: 40, Sit: {satScale: 2, sitchName: 'Flares'}})})),
            resolveURLForFetch: async reference => reference,
            textSitchToObject: text => JSON.parse(text),
            approveSitchChannel: async () => true,
            setNewSitchObject: sitch => loaded.push(sitch),
            getEffectiveUserID: () => USER,
            showError: (...args) => showError(...args),
        };
        const Loader = new Function(...Object.keys(bindings), `return class {${methodSource}}`)(...Object.values(bindings));
        return Object.assign(new Loader(), {
            getVersions: jest.fn(async () => VERSIONS),
            clearLocalSitchContext: jest.fn(),
            updateVersionsDropdown: jest.fn(),
        });
    }

    test('has no name, and records the template and its owner', async () => {
        const loader = createLoader();

        await loader.loadSavedFile('Flares', 7, {asTemplate: true});

        expect(loaded).toEqual([{isASitchFile: true, lat: 40, Sit: {satScale: 2}, templateSource: {name: 'Flares', userID: 7}}]);
        expect(loader.getVersions).toHaveBeenCalledWith('Flares', 7);
        // The new sitch is not a version of the template.
        expect(loader.updateVersionsDropdown).toHaveBeenCalledWith([]);
        expect(loader.loadURL).toBe('sitrec://7/Flares/v2.js');
    });

    test('of the user records the user as the owner', async () => {
        const loader = createLoader();

        await loader.loadSavedFile('Flares', null, {asTemplate: true});

        expect(loaded[0].templateSource).toEqual({name: 'Flares', userID: USER});
    });

    test('a sitch opened in the usual way keeps its name and its versions', async () => {
        const loader = createLoader();

        await loader.loadSavedFile('Flares', 7);

        expect(loaded).toEqual([{sitchName: 'Flares', isASitchFile: true, lat: 40, Sit: {satScale: 2, sitchName: 'Flares'}}]);
        expect(loader.updateVersionsDropdown).toHaveBeenCalledWith(VERSIONS);
        expect(loader.loadName).toBe('Flares');
    });

    describe('by its name (?template=<name>)', () => {
        test('opens the template of a different user as a template from that user', async () => {
            const loader = createLoader();

            expect(await loader.loadTemplateByName('Flares')).toBe(true);

            expect(findTemplateByName).toHaveBeenCalledWith('Flares');
            expect(loader.getVersions).toHaveBeenCalledWith('Flares', 7);
            expect(loaded[0].templateSource).toEqual({name: 'Flares', userID: 7});
            expect(loaded[0].sitchName).toBeUndefined();
        });

        test('opens one of the user\'s own templates with no owner, as the sitch browser does', async () => {
            const loader = createLoader();
            findTemplateByName = jest.fn(async name => ({name, userID: USER}));

            expect(await loader.loadTemplateByName('Flares')).toBe(true);

            expect(loader.getVersions).toHaveBeenCalledWith('Flares', null);
            expect(loaded[0].templateSource).toEqual({name: 'Flares', userID: USER});
        });

        test('with no template of that name, says so and opens nothing', async () => {
            const loader = createLoader();
            findTemplateByName = jest.fn(async () => null);

            expect(await loader.loadTemplateByName('No Such')).toBe(false);

            expect(showError).toHaveBeenCalledWith('There is no template with the name "No Such".');
            expect(loaded).toEqual([]);
            expect(loader.getVersions).not.toHaveBeenCalled();
        });

        test('when the server does not answer, says so and opens nothing', async () => {
            const loader = createLoader();
            const failure = new Error('template list returned 503');
            findTemplateByName = jest.fn(async () => { throw failure; });

            expect(await loader.loadTemplateByName('Flares')).toBe(false);

            expect(showError).toHaveBeenCalledWith('Could not look for the template "Flares".', failure);
            expect(loaded).toEqual([]);
        });

        test('when the sitch file does not load, the result is false', async () => {
            const loader = createLoader();
            loader.getVersions = jest.fn(async () => []);

            expect(await loader.loadTemplateByName('Flares')).toBe(false);

            expect(showError).toHaveBeenCalledTimes(1);
            expect(loaded).toEqual([]);
        });
    });
});
