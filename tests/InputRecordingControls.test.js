/** @jest-environment jsdom */
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
import {TimeEditor} from '../src/TimeEditor';
import {InputRecorder, describeInputTarget} from '../src/InputRecording';
import {buildMenuPath, buildPanelPath} from '../src/UILogging';

let recorder;
beforeEach(() => {
    jest.useFakeTimers();
    sessionStorage.clear();
    recorder = new InputRecorder({url: '/inputlog.php', userID: 1,
        pathFor: el => buildPanelPath(el) || buildMenuPath(el)});
    recorder.start();
});
afterEach(() => {
    recorder.stop();
    document.body.innerHTML = '';
    jest.useRealTimers();
});

test('the real time editor records year values before and after arrow-key edits', () => {
    document.body.innerHTML = '<div class="lil-gui"><button class="title">Time</button><div class="host"></div></div>';
    const state = {now: new Date('2024-11-19T12:00:00Z'), start: new Date('2024-11-19T12:00:00Z'),
        frame: 0, offset: 0, useZone: false, zone: 'UTC', paused: true, speed: 1, playbackSpeed: 1};
    const editor = new TimeEditor(document.querySelector('.host'), {
        zones: [], read: () => state, pause() {}, edit: date => { state.now = date; },
    });
    try {
        const year = editor.root.querySelector('[data-part="year"]');
        year.focus();
        for (const key of ['ArrowUp', 'ArrowDown']) {
            year.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
            year.dispatchEvent(new KeyboardEvent('keyup', {key, bubbles: true}));
        }
        const events = recorder.queue.filter(e => e.type.startsWith('key'));
        expect(events.map(e => [e.type, e.target.path, e.target.value])).toEqual([
            ['keydown', 'Time/Year', 2024], ['keyup', 'Time/Year', 2025],
            ['keydown', 'Time/Year', 2025], ['keyup', 'Time/Year', 2024],
        ]);
        editor.el('paste').value = 'private free text';
        expect(describeInputTarget(editor.el('paste')).value).toBe('[text omitted]');
    } finally { editor.dispose(); }
});

test.each(['thumbnail', 'placeholder', 'list'])('the real sitch browser names %s clicks and double-clicks', mode => {
    const browser = new CSitchBrowser(null);
    browser.filtered = [{key: '1:Other', name: 'Other', date: '2026-11-18'},
        {key: '1:Test scene', name: 'Test scene', date: '2026-11-19',
            screenshotUrl: mode === 'thumbnail' ? 'https://example.test/preview.jpg?token=private' : null}];
    const host = document.createElement('div');
    document.body.append(host);
    const previousObserver = global.IntersectionObserver;
    global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    browser.close = jest.fn(() => host.remove());
    browser._loadSitch = jest.fn();
    try {
        if (mode === 'list') browser.renderRows(host);
        else {
            browser._thumbGrid = host;
            browser._thumbScrollContainer = host;
            browser.renderThumbnails();
        }
        const card = host.lastElementChild;
        const target = card.querySelector('img') || card.firstElementChild;
        for (const type of ['pointerdown', 'click', 'dblclick']) {
            target.dispatchEvent(new MouseEvent(type, {bubbles: true}));
        }
        const events = recorder.queue.filter(e => ['pointerdown', 'click', 'dblclick'].includes(e.type));
        expect(events).toHaveLength(3);
        expect(events.map(e => e.target.path)).toEqual(Array(3).fill('Sitch browser/Test scene'));
        expect(JSON.stringify(events)).not.toContain('token=private');
        expect(browser._loadSitch).toHaveBeenCalledWith('1:Test scene');
    } finally {
        browser._destroyThumbObserver();
        global.IntersectionObserver = previousObserver;
    }
});
