/** @jest-environment jsdom */
// The start screen shows the sitch templates, and a sitch opened from a template
// does not get the template's name. The server side of the template list is in
// sitchTemplateEndpoints.test.js, and the save guard is in sitchTemplateSave.test.js.
jest.mock('../src/configUtils', () => ({
    isAdmin: jest.fn(() => false),
    SITREC_APP: 'https://example.test/',
    SITREC_SHARE_APP: 'https://example.test/',
    SITREC_SERVER: 'https://example.test/sitrecServer/',
}));
jest.mock('../src/showError', () => ({showConfirm: jest.fn(), showError: jest.fn(), showPrompt: jest.fn()}));
jest.mock('../src/DragDropHandler', () => ({DragDropHandler: {}}));
jest.mock('../src/WarGovUFOUtils', () => ({extractWarGovPRCode: () => null}));

import {CSitchBrowser} from '../src/CSitchBrowser';
import {Globals} from '../src/Globals';
import {isAdmin} from '../src/configUtils';
import {showError} from '../src/showError';

const USER = 42;
const ADMIN_USER = 1;

// The server's global list. "Video" is another user's sitch. "Flares" is the user's own.
const GLOBAL_TEMPLATES = [
    {name: 'Video', userID: ADMIN_USER, screenshotUrl: 'https://example.test/video.jpg', date: '2026-01-05 00:00:00'},
    {name: 'Flares', userID: USER, screenshotUrl: null, date: '2026-01-03 00:00:00'},
];
const OWN_SITCHES = [
    ['Normal', '2026-01-01 00:00:00', null],
    ['Flares', '2026-01-03 00:00:00', null],
    ['Zulu Local', '2026-01-04 00:00:00', null],
    ['Alpha Local', '2026-01-04 00:00:00', null],
];
const OWN_METADATA = {
    labels: [],
    sitchLabels: {'Zulu Local': ['Local Template'], 'Alpha Local': ['Local Template']},
    screenshotVersions: {},
};

const json = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body))});

let posts, fileManager, previousUserID, previousFetch;

// Opens the browser with the real show(), and resolves when the overlay is up.
// The default is the open() call of the start (index.js). `fromFileMenu` is
// File > New Sitch from Template instead, and `fromFileOpen` is File > Server > Open.
async function openBrowser({screen = 'templates', fromFileMenu = false, fromFileOpen = false,
                               globalTemplates = GLOBAL_TEMPLATES, metadata = OWN_METADATA,
                               ownSitches = OWN_SITCHES, postResult = async () => json({success: true})} = {}) {
    global.fetch = jest.fn(async (url, options = {}) => {
        if (options.method === 'POST') {
            posts.push(JSON.parse(options.body));
            return postResult();
        }
        if (url.includes('getsitches.php')) return json(ownSitches);
        if (url.includes('metadata.php?featured')) return json({sitches: []});
        if (url.includes('metadata.php?templates')) return json({sitches: globalTemplates});
        if (url.includes('metadata.php')) return json(metadata);
        throw new Error(`unexpected fetch ${url}`);
    });
    const browser = new CSitchBrowser(fileManager);
    await new Promise(resolve => {
        const show = browser.show.bind(browser);
        browser.show = () => { show(); resolve(); };
        if (fromFileMenu) browser.openTemplateScreen();
        else if (fromFileOpen) browser.openBrowseScreen();
        else browser.open({screen, browseIfNoTemplates: true});
    });
    return browser;
}

const NO_TEMPLATES = {globalTemplates: [], metadata: {labels: [], sitchLabels: {}}};

// The address of the page, without the origin. setAddress changes it with no navigation.
const address = () => window.location.pathname + window.location.search;
const setAddress = (pathAndSearch) => window.history.replaceState(null, '', pathAndSearch);
const SITCH_ADDRESS = '/sitrec/?custom=42/Normal/20260101_000000.js';

const key = (name, userID = USER) => `${userID}:${name}`;
const cardNames = (section) => [...document.querySelectorAll(`[data-template-section="${section}"] [data-template-card]`)]
    .map(card => card.title);
const card = (name) => [...document.querySelectorAll('[data-template-card]')].find(element => element.title === name);
const button = (text) => [...document.querySelectorAll('button')].find(element => element.textContent === text);
const onStartScreen = () => !!document.querySelector('[data-template-screen]');

beforeEach(() => {
    posts = [];
    fileManager = {loadSavedFile: jest.fn(), refreshVersions: jest.fn(), userSaves: []};
    previousUserID = Globals.userID;
    previousFetch = global.fetch;
    Globals.userID = USER;
    isAdmin.mockReturnValue(false);
    showError.mockReset();
    global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    setAddress('/');
    document.body.innerHTML = '';
    Globals.userID = previousUserID;
    global.fetch = previousFetch;
    jest.restoreAllMocks();
});

describe('the start screen', () => {
    test('shows the global templates in the order of the server, then the local templates by name', async () => {
        await openBrowser();

        expect(onStartScreen()).toBe(true);
        expect(cardNames('Global Templates')).toEqual(['Video', 'Flares']);
        expect(cardNames('Local Templates')).toEqual(['Alpha Local', 'Zulu Local']);
    });

    test('a click on a template of a different user opens it as a template from that user', async () => {
        const browser = await openBrowser();

        card('Video').click();

        expect(fileManager.loadSavedFile).toHaveBeenCalledWith('Video', ADMIN_USER, {asTemplate: true});
        expect(browser.overlay).toBeNull();
    });

    test('a click on one of the user\'s own templates opens it as a template', async () => {
        await openBrowser();

        card('Zulu Local').click();

        expect(fileManager.loadSavedFile).toHaveBeenCalledWith('Zulu Local', null, {asTemplate: true});
    });

    test('a user with no login sees the global templates only, and can log in', async () => {
        Globals.userID = 0;
        fileManager.loginServer = jest.fn();
        await openBrowser();

        expect(cardNames('Global Templates')).toEqual(['Video', 'Flares']);
        expect(document.querySelector('[data-template-section="Local Templates"]')).toBeNull();
        button('Login').click();
        expect(fileManager.loginServer).toHaveBeenCalledTimes(1);
    });

    test('a deleted template does not show', async () => {
        await openBrowser({metadata: {...OWN_METADATA, sitchLabels: {'Zulu Local': ['Local Template', 'Deleted'], 'Alpha Local': ['Local Template'], Flares: ['Deleted']}}});

        expect(cardNames('Global Templates')).toEqual(['Video']);
        expect(cardNames('Local Templates')).toEqual(['Alpha Local']);
    });

    test('a sitch with the two template labels shows one time', async () => {
        await openBrowser({metadata: {...OWN_METADATA, sitchLabels: {Flares: ['Local Template']}}});

        expect(cardNames('Global Templates')).toEqual(['Video', 'Flares']);
        expect(document.querySelector('[data-template-section="Local Templates"]')).toBeNull();
    });

    test('with no template, the sitch browser is the start screen', async () => {
        const browser = await openBrowser(NO_TEMPLATES);

        expect(onStartScreen()).toBe(false);
        expect(browser.screen).toBe('browse');
        expect(button('New Sitch')).toBeTruthy();
        expect(button('Templates')).toBeUndefined();
    });

    test('"Browse Sitches" shows the sitch browser, and its "Templates" button comes back', async () => {
        await openBrowser();
        const fetchCount = global.fetch.mock.calls.length;

        button('Browse Sitches').click();
        expect(onStartScreen()).toBe(false);
        expect(document.querySelectorAll('[data-sitch-card]').length).toBe(5);  // 4 own sitches + "Video"

        button('Templates').click();
        expect(onStartScreen()).toBe(true);
        // The two screens use the same data: no second request to the server.
        expect(global.fetch.mock.calls.length).toBe(fetchCount);
    });

    test('File > Open shows the sitch browser, not the start screen', async () => {
        await openBrowser({fromFileOpen: true});

        expect(onStartScreen()).toBe(false);
    });
});

describe('the address of the sitch browser (?action=browse)', () => {
    test('"Browse Sitches" sets the address, and "Templates" puts the address back', async () => {
        setAddress('/sitrec/');
        await openBrowser();
        expect(address()).toBe('/sitrec/');
        const historyLength = window.history.length;

        button('Browse Sitches').click();
        expect(onStartScreen()).toBe(false);
        expect(address()).toBe('/sitrec/?action=browse');

        button('Templates').click();
        expect(onStartScreen()).toBe(true);
        expect(address()).toBe('/sitrec/');
        // The address changed in place: no new entry for the Back button.
        expect(window.history.length).toBe(historyLength);
    });

    test('File > Open sets the address, and Cancel puts the address of the open sitch back', async () => {
        setAddress(SITCH_ADDRESS);
        const browser = await openBrowser({fromFileOpen: true});
        expect(address()).toBe('/sitrec/?action=browse');

        button('Cancel').click();

        expect(browser.overlay).toBeNull();
        expect(address()).toBe(SITCH_ADDRESS);
    });

    test('File > Open with the template screen open changes the screen and the address', async () => {
        setAddress('/sitrec/');
        const browser = await openBrowser();
        const fetchCount = global.fetch.mock.calls.length;

        browser.openBrowseScreen();

        expect(onStartScreen()).toBe(false);
        expect(address()).toBe('/sitrec/?action=browse');
        expect(global.fetch.mock.calls.length).toBe(fetchCount);
    });

    test('File > New Sitch from Template with the sitch browser open puts the address back', async () => {
        setAddress(SITCH_ADDRESS);
        const browser = await openBrowser({fromFileOpen: true});

        browser.openTemplateScreen();

        expect(onStartScreen()).toBe(true);
        expect(address()).toBe(SITCH_ADDRESS);
    });

    test('a start at ?action=browse shows the sitch browser, and "Templates" goes to the address with no action', async () => {
        setAddress('/sitrec/?action=browse');
        await openBrowser({screen: 'browse'});  // index.js: startScreenForAction("browse")

        expect(onStartScreen()).toBe(false);
        expect(address()).toBe('/sitrec/?action=browse');

        button('Templates').click();
        expect(onStartScreen()).toBe(true);
        expect(address()).toBe('/sitrec/');
    });

    test('a sitch opened from the sitch browser does not keep the browse address', async () => {
        setAddress('/sitrec/');
        await openBrowser();
        button('Browse Sitches').click();

        document.querySelector('[data-sitch-card]').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));

        // The load sets the address of the sitch later. Until then it is the address from before.
        expect(fileManager.loadSavedFile).toHaveBeenCalledTimes(1);
        expect(address()).toBe('/sitrec/');
    });

    test('a start with no template shows the sitch browser and does not change the address', async () => {
        setAddress('/sitrec/');
        await openBrowser(NO_TEMPLATES);

        expect(onStartScreen()).toBe(false);
        expect(address()).toBe('/sitrec/');
    });

    test('an address that a save set while the sitch browser was open stays after Cancel', async () => {
        setAddress(SITCH_ADDRESS);
        const browser = await openBrowser({fromFileOpen: true});
        const savedAddress = '/sitrec/?custom=42/Normal/20260202_000000.js';
        window.history.pushState({}, null, savedAddress);  // as a save does

        browser.close();

        expect(address()).toBe(savedAddress);
    });
});

describe('File > New Sitch from Template', () => {
    test('shows the templates, and Cancel goes back to the open sitch', async () => {
        const browser = await openBrowser({fromFileMenu: true});

        expect(onStartScreen()).toBe(true);
        expect(cardNames('Global Templates')).toEqual(['Video', 'Flares']);
        expect(cardNames('Local Templates')).toEqual(['Alpha Local', 'Zulu Local']);

        button('Cancel').click();
        expect(browser.overlay).toBeNull();
        expect(fileManager.loadSavedFile).not.toHaveBeenCalled();
    });

    test('with no template, it shows the template screen and says so', async () => {
        const browser = await openBrowser({fromFileMenu: true, ...NO_TEMPLATES});

        // The user asked for the templates, so the sitch browser must not show in their place.
        expect(onStartScreen()).toBe(true);
        expect(browser.screen).toBe('templates');
        expect(document.querySelector('[data-template-empty]').textContent).toBe('There are no templates.');
        expect(document.querySelectorAll('[data-template-card]').length).toBe(0);
        expect(button('New Sitch')).toBeTruthy();
        expect(button('Browse Sitches')).toBeTruthy();
    });

    test('a screen with templates has no "no templates" line', async () => {
        await openBrowser({fromFileMenu: true});

        expect(document.querySelector('[data-template-empty]')).toBeNull();
    });

    test('with the sitch browser open, it changes the screen with no new request', async () => {
        const browser = await openBrowser({screen: 'browse'});
        const fetchCount = global.fetch.mock.calls.length;

        browser.openTemplateScreen();

        expect(onStartScreen()).toBe(true);
        expect(cardNames('Global Templates')).toEqual(['Video', 'Flares']);
        expect(global.fetch.mock.calls.length).toBe(fetchCount);
    });

    test('after a start that showed the sitch browser for no templates, it shows the template screen', async () => {
        const browser = await openBrowser(NO_TEMPLATES);
        expect(onStartScreen()).toBe(false);

        browser.openTemplateScreen();

        expect(onStartScreen()).toBe(true);
        expect(document.querySelector('[data-template-empty]')).toBeTruthy();
    });
});

describe('templates in the sitch browser', () => {
    test('a template opens as a template, and a normal sitch does not', async () => {
        const browser = await openBrowser({screen: 'browse'});

        browser._loadSitch(key('Normal'));
        browser._loadSitch(key('Flares'));
        browser._loadSitch(key('Alpha Local'));

        expect(fileManager.loadSavedFile.mock.calls).toEqual([
            ['Normal', null, {asTemplate: false}],
            ['Flares', null, {asTemplate: true}],
            ['Alpha Local', null, {asTemplate: true}],
        ]);
    });

    test('a template is not "Unlabeled"', async () => {
        const browser = await openBrowser({screen: 'browse'});

        browser.activeLabel = 'Unlabeled';
        browser.applyFilterAndSort();

        expect(browser.filtered.map(sitch => sitch.name)).toEqual(['Normal']);
    });

    test('the two template labels filter the list', async () => {
        const browser = await openBrowser({screen: 'browse'});

        browser.activeLabel = 'Global Template';
        browser.applyFilterAndSort();
        expect(browser.filtered.map(sitch => sitch.name).sort()).toEqual(['Flares', 'Video']);

        browser.activeLabel = 'Local Template';
        browser.applyFilterAndSort();
        expect(browser.filtered.map(sitch => sitch.name).sort()).toEqual(['Alpha Local', 'Zulu Local']);
    });

    test('an administrator adds and removes a global template with a change, not a new list', async () => {
        isAdmin.mockReturnValue(true);
        const browser = await openBrowser({screen: 'browse'});

        browser._addLabelToSitches([key('Normal')], 'Global Template');
        expect(posts).toEqual([{updateTemplates: true, add: [{name: 'Normal', userID: USER}], remove: []}]);
        expect(browser._sitchHasLabel(key('Normal'), 'Global Template')).toBe(true);

        browser._removeLabelFromSitches([key('Video', ADMIN_USER)], 'Global Template');
        expect(posts[1]).toEqual({updateTemplates: true, add: [], remove: [{name: 'Video', userID: ADMIN_USER}]});
        // "Video" was in the list only as a global template, so it goes out of the list.
        expect(browser._getSitch(key('Video', ADMIN_USER))).toBeNull();
    });

    test('a user who is not an administrator cannot change the global templates', async () => {
        const browser = await openBrowser({screen: 'browse'});

        browser._addLabelToSitches([key('Normal')], 'Global Template');
        browser._removeLabelFromSitches([key('Flares')], 'Global Template');

        expect(posts).toEqual([]);
        expect(browser._sitchHasLabel(key('Flares'), 'Global Template')).toBe(true);
    });

    test('a change that the server refuses is taken back', async () => {
        isAdmin.mockReturnValue(true);
        const browser = await openBrowser({screen: 'browse', postResult: async () => json({error: 'Admin access required'}, 403)});

        browser._addLabelToSitches([key('Normal')], 'Global Template');
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(showError).toHaveBeenCalledTimes(1);
        expect(browser._sitchHasLabel(key('Normal'), 'Global Template')).toBe(false);
    });

    test('"Local Template" is a normal label in the user\'s own label file', async () => {
        const browser = await openBrowser({screen: 'browse'});

        browser._addLabelToSitches([key('Normal')], 'Local Template');

        expect(posts.length).toBe(1);
        expect(posts[0].sitchLabels.Normal).toEqual(['Local Template']);
        expect(posts[0].updateSitches).toEqual(['Normal']);
        expect(posts[0].updateTemplates).toBeUndefined();
    });
});

describe('the right-click menu of the sitch browser', () => {
    const {InteractionRouter, INTERACTION} = require('../src/InteractionRouter');
    const press = (target) => {
        const event = new MouseEvent('pointerdown', {bubbles: true, cancelable: true, button: 0});
        target.dispatchEvent(event);
        return event;
    };
    const menuItem = (text) => [...document.querySelectorAll('body > div > div')].find(item => item.textContent === text);
    const rightClick = (name) => {
        const sitchCard = [...document.querySelectorAll('[data-sitch-card]')].find(element => element.textContent.includes(name));
        sitchCard.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 2}));
    };

    test('"Delete" gives the sitch the Deleted label and takes it out of the list', async () => {
        const browser = await openBrowser({screen: 'browse'});

        rightClick('Normal');
        menuItem('Delete').click();

        expect(posts.length).toBe(1);
        expect(posts[0].sitchLabels.Normal).toEqual(['Deleted']);
        expect(posts[0].updateSitches).toEqual(['Normal']);
        expect(browser.filtered.map(sitch => sitch.name)).not.toContain('Normal');
        expect(menuItem('Delete')).toBeUndefined();  // the menu closed
    });

    test('a press on a menu item is not taken for the 3D view behind the browser', async () => {
        // A view of a loaded sitch claims every press that is not on a native control.
        const router = new InteractionRouter(document);
        const begin = jest.fn();
        router.register({id: 'view', hitTest: () => ({kind: INTERACTION.DRAG}), begin});
        try {
            await openBrowser({screen: 'browse'});
            rightClick('Normal');

            const onMenu = press(menuItem('Delete'));
            expect(onMenu.defaultPrevented).toBe(false);
            expect(begin).not.toHaveBeenCalled();

            // The same press on a plain element of the page does go to the view.
            const plain = document.body.appendChild(document.createElement('div'));
            expect(press(plain).defaultPrevented).toBe(true);
            expect(begin).toHaveBeenCalledTimes(1);
        } finally {
            router.dispose();
        }
    });
});

describe('the template list from the server', () => {
    test('an answer with no list is an error, not "no templates"', async () => {
        const {fetchGlobalTemplates} = require('../src/SitchTemplates');
        global.fetch = jest.fn(async () => json({}));

        await expect(fetchGlobalTemplates()).rejects.toThrow('template list is not valid');
    });

    test('a template check with a bad list answer has no result', async () => {
        const {ownTemplateLabels} = require('../src/SitchTemplates');
        global.fetch = jest.fn(async (url) => url.includes('?templates') ? json({error: 'x'}) : json(OWN_METADATA));

        await expect(ownTemplateLabels('Flares')).rejects.toThrow();
    });

    test('a template check gives the labels of the user\'s own sitch', async () => {
        const {ownTemplateLabels} = require('../src/SitchTemplates');
        global.fetch = jest.fn(async (url) => url.includes('?templates') ? json({sitches: GLOBAL_TEMPLATES}) : json(OWN_METADATA));

        expect(await ownTemplateLabels('Flares')).toEqual(['Global Template']);
        expect(await ownTemplateLabels('Zulu Local')).toEqual(['Local Template']);
        expect(await ownTemplateLabels('Normal')).toEqual([]);
        // "Video" is a global template of a different user, so it is not one of this user's templates.
        expect(await ownTemplateLabels('Video')).toEqual([]);
    });
});

describe('a template by its name (?template=<name>)', () => {
    const {findTemplateByName, templateAddress} = require('../src/SitchTemplates');
    const serve = (metadata = OWN_METADATA, globalTemplates = GLOBAL_TEMPLATES) => {
        global.fetch = jest.fn(async (url) => url.includes('?templates') ? json({sitches: globalTemplates}) : json(metadata));
    };

    test('the address has the name only, with no owner and no version', () => {
        expect(templateAddress('https://example.test/sitrec/', {name: 'Star Tracker', userID: 7}))
            .toBe('https://example.test/sitrec/?template=Star%20Tracker');
        expect(templateAddress('https://example.test/sitrec/', {name: 'A&B = 50% #1', userID: 7}))
            .toBe('https://example.test/sitrec/?template=A%26B%20%3D%2050%25%20%231');
    });

    test('finds a global template, with its owner', async () => {
        serve();

        expect(await findTemplateByName('Video')).toEqual({name: 'Video', userID: ADMIN_USER});
        expect(await findTemplateByName('Flares')).toEqual({name: 'Flares', userID: USER});
    });

    test('finds one of the user\'s own local templates', async () => {
        serve();

        expect(await findTemplateByName('Zulu Local')).toEqual({name: 'Zulu Local', userID: USER});
    });

    test('a global template comes before a local template of the same name', async () => {
        serve({labels: [], sitchLabels: {Video: ['Local Template']}});

        expect(await findTemplateByName('Video')).toEqual({name: 'Video', userID: ADMIN_USER});
    });

    test('does not find a normal sitch, a deleted local template, or a name that is not there', async () => {
        serve({labels: [], sitchLabels: {'Zulu Local': ['Local Template', 'Deleted'], Normal: ['Starlink']}});

        expect(await findTemplateByName('Normal')).toBeNull();
        expect(await findTemplateByName('Zulu Local')).toBeNull();
        expect(await findTemplateByName('No Such')).toBeNull();
        expect(await findTemplateByName('')).toBeNull();
    });

    test('the name must be exact', async () => {
        serve();

        expect(await findTemplateByName('video')).toBeNull();
    });

    test('a user with no login finds the global templates only, with no request for labels', async () => {
        Globals.userID = 0;
        serve();

        expect(await findTemplateByName('Video')).toEqual({name: 'Video', userID: ADMIN_USER});
        expect(await findTemplateByName('Zulu Local')).toBeNull();
        expect(global.fetch.mock.calls.every(([url]) => url.includes('?templates'))).toBe(true);
    });

    test('has no result when the server does not answer', async () => {
        global.fetch = jest.fn(async () => json({error: 'x'}, 503));

        await expect(findTemplateByName('Video')).rejects.toThrow();
    });
});
