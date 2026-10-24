/** @jest-environment jsdom */
// A label edit posts the user's whole label file, which metadata.php writes over
// the stored one. It must not post after the stored file could not be read (that
// would wipe every label), and it must carry screenshotVersions through.
jest.mock('../src/configUtils', () => ({
    isAdmin: () => false,
    SITREC_APP: 'https://example.test/',
    SITREC_SHARE_APP: 'https://example.test/',
    SITREC_SERVER: 'https://example.test/sitrecServer/',
}));
jest.mock('../src/showError', () => ({showConfirm: jest.fn(), showError: jest.fn(), showPrompt: jest.fn()}));
jest.mock('../src/DragDropHandler', () => ({DragDropHandler: {}}));
jest.mock('../src/WarGovUFOUtils', () => ({extractWarGovPRCode: () => null}));

import {CSitchBrowser} from '../src/CSitchBrowser';
import {Globals} from '../src/Globals';
import {showConfirm, showError, showPrompt} from '../src/showError';

const USER = 42;
const STORED = {
    labels: [{name: 'Work', color: '#34a853'}],
    sitchLabels: {other: ['Work'], hidden: ['Private']},
    screenshotVersions: {other: 3, mine: 7},
};

const json = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body))});

let posts, previousUserID, previousFetch;

// Opens the browser with metadata.php's GET answering `metadataGet()`, and
// resolves once it has shown (fetchFromServer does not return its promise).
async function openBrowser(metadataGet) {
    global.fetch = jest.fn(async (url, options = {}) => {
        if (options.method === 'POST') {
            posts.push(JSON.parse(options.body));
            return json({success: true});
        }
        if (url.includes('getsitches.php')) return json([['mine', '2026-01-01 00:00:00', null], ['other', '2026-01-02 00:00:00', null]]);
        if (url.includes('metadata.php?featured')) return json({sitches: []});
        if (url.includes('metadata.php')) return metadataGet();
        throw new Error(`unexpected fetch ${url}`);
    });
    const browser = new CSitchBrowser(null);
    for (const name of ['_rebuildSidebar', '_rebuildSidebarLabels', 'rebuildContent', '_refreshLabelChips']) {
        browser[name] = jest.fn();
    }
    await new Promise(resolve => {
        browser.show = jest.fn(resolve);
        browser.open();
    });
    return browser;
}

const key = name => `${USER}:${name}`;

beforeEach(() => {
    posts = [];
    previousUserID = Globals.userID;
    previousFetch = global.fetch;
    Globals.userID = USER;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    showError.mockReset();
    showConfirm.mockReset().mockResolvedValue(true);
    showPrompt.mockReset().mockResolvedValue('New');
});
afterEach(() => {
    Globals.userID = previousUserID;
    global.fetch = previousFetch;
    jest.restoreAllMocks();
});

describe.each([
    ['metadata.php returns 500', async () => json({error: 'Metadata storage unavailable'}, 500)],
    ['metadata.php cannot be reached', async () => { throw new TypeError('Failed to fetch'); }],
    ['metadata.php returns a broken body', async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); }})],
])('when %s', (_label, metadataGet) => {
    test('deleting a sitch does not overwrite the stored labels', async () => {
        const browser = await openBrowser(metadataGet);

        browser._addLabelToSitches([key('mine')], 'Deleted');

        expect(posts).toEqual([]);
        expect(browser.sitchLabels).toEqual({});
        expect(showError).toHaveBeenCalledTimes(1);
    });

    test('removing, adding and deleting labels post nothing', async () => {
        const browser = await openBrowser(metadataGet);

        browser._removeLabelFromSitches([key('mine')], 'Private');
        await browser._promptAddLabel([key('mine')]);
        await browser._deleteLabel('Work');

        expect(posts).toEqual([]);
        expect(showPrompt).not.toHaveBeenCalled();
        expect(showConfirm).not.toHaveBeenCalled();
    });
});

describe('when the stored labels were read', () => {
    test('a label edit keeps the other labels and the screenshot versions', async () => {
        const browser = await openBrowser(async () => json(STORED));

        browser._addLabelToSitches([key('mine')], 'Deleted');

        expect(showError).not.toHaveBeenCalled();
        expect(posts).toHaveLength(1);
        expect(posts[0].screenshotVersions).toEqual(STORED.screenshotVersions);
        expect(posts[0].sitchLabels).toEqual({...STORED.sitchLabels, mine: ['Deleted']});
        expect(posts[0].labels.map(label => label.name)).toEqual(expect.arrayContaining(['Work', 'Private', 'Deleted']));
        expect(posts[0].updateSitches).toEqual(['mine']);
    });

    test('adding and deleting a label keep the screenshot versions', async () => {
        const browser = await openBrowser(async () => json(STORED));

        await browser._promptAddLabel([key('mine')]);
        await browser._deleteLabel('Work');

        expect(posts).toHaveLength(2);
        for (const body of posts) expect(body.screenshotVersions).toEqual(STORED.screenshotVersions);
        expect(posts[1].sitchLabels).toEqual({hidden: ['Private'], mine: ['New']});
    });

    test('a later failed reload turns label edits off again', async () => {
        const browser = await openBrowser(async () => json(STORED));
        browser.overlay = null;
        await new Promise(resolve => {
            browser.show = jest.fn(resolve);
            global.fetch.mockImplementation(async (url, options = {}) => {
                if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return json({success: true}); }
                if (url.includes('getsitches.php')) return json([['mine', '2026-01-01 00:00:00', null]]);
                if (url.includes('metadata.php?featured')) return json({sitches: []});
                return json({error: 'Metadata storage unavailable'}, 500);
            });
            browser.open();
        });

        browser._addLabelToSitches([key('mine')], 'Private');

        expect(posts).toEqual([]);
        expect(showError).toHaveBeenCalledTimes(1);
    });
});
