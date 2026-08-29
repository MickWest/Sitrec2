/**
 * @jest-environment jsdom
 */
// showPrompt replaced the native prompt(). Native prompt() froze the entire page, and
// callers were written against that guarantee without ever stating it. A plain in-page
// modal does not freeze anything, so two properties had to be re-established explicitly:
//
//   1. ONE AT A TIME  — a second activation while a prompt is up used to be swallowed by
//      the blocked thread. Unguarded it stacks a second modal, and submitting both runs
//      the caller's action twice: two objects from one Add Object double-click.
//   2. PLAYBACK HOLDS — callers read frame-dependent state around the prompt
//      (CNodeAnnotateOverlay's stroke frame, CTextExtraction's video image,
//      createObjectFromInput's track start). A running video could not previously advance
//      past them; now it can, and the results are wrong in ways that look like nothing
//      happened — e.g. an annotation committed already fully faded.

import {showPrompt} from '../src/showError';
import {Globals} from '../src/Globals';
import {par} from '../src/par';

// showPrompt short-circuits under validationMode; these tests want the real modal.
const realValidationMode = Globals.validationMode;
beforeEach(() => {
    Globals.validationMode = false;
    par.pausedLock = false;
    par.paused = false;
    document.body.innerHTML = '';
});
afterAll(() => { Globals.validationMode = realValidationMode; });

// The modal is the last overlay appended to body; its buttons are Cancel then OK.
function openModals() {
    return [...document.body.children].filter(el => el.querySelector?.('input'));
}
function buttonsOf(overlay) {
    const [cancel, ok] = overlay.querySelectorAll('button');
    return {cancel, ok};
}
function typeInto(overlay, text) {
    overlay.querySelector('input').value = text;
}

describe('showPrompt runs one at a time', () => {

    test('a single prompt opens one modal', async () => {
        const p = showPrompt('First?');
        expect(openModals()).toHaveLength(1);
        buttonsOf(openModals()[0]).cancel.click();
        await expect(p).resolves.toBeNull();
    });

    test('a second concurrent prompt does NOT stack a modal', async () => {
        const first = showPrompt('First?');
        const second = showPrompt('Second?');

        expect(openModals()).toHaveLength(1);
        // The extra request resolves as cancelled — the no-op it used to be.
        await expect(second).resolves.toBeNull();

        typeInto(openModals()[0], 'answer');
        buttonsOf(openModals()[0]).ok.click();
        await expect(first).resolves.toBe('answer');
    });

    test('the double-click case creates one result, not two', async () => {
        // Exactly the Add Object regression: one activation pattern, two handler runs.
        const results = await Promise.all([
            (async () => {
                const a = showPrompt('Add Object');
                const b = showPrompt('Add Object');       // the second click
                // Answer whichever modal is up.
                typeInto(openModals()[0], '37.7 -122.4');
                buttonsOf(openModals()[0]).ok.click();
                return [await a, await b];
            })(),
        ]);
        const [a, b] = results[0];
        expect([a, b].filter(v => v !== null)).toEqual(['37.7 -122.4']);
    });

    test('the guard clears, so a later prompt still opens', async () => {
        const first = showPrompt('First?');
        buttonsOf(openModals()[0]).cancel.click();
        await first;

        const later = showPrompt('Later?');
        expect(openModals()).toHaveLength(1);
        typeInto(openModals()[0], 'ok now');
        buttonsOf(openModals()[0]).ok.click();
        await expect(later).resolves.toBe('ok now');
    });

    test('the guard clears after Escape too', async () => {
        const first = showPrompt('First?');
        const input = openModals()[0].querySelector('input');
        input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await expect(first).resolves.toBeNull();

        const later = showPrompt('Later?');
        expect(openModals()).toHaveLength(1);
        buttonsOf(openModals()[0]).cancel.click();
        await later;
    });
});

describe('showPrompt holds playback while it is open', () => {

    test('pauses on open and resumes on OK', async () => {
        par.paused = false;
        const p = showPrompt('Annotation text:');
        expect(par.paused).toBe(true);            // video cannot advance past the frame

        typeInto(openModals()[0], 'hello');
        buttonsOf(openModals()[0]).ok.click();
        await p;
        expect(par.paused).toBe(false);           // and playback resumes
    });

    test('resumes on Cancel', async () => {
        par.paused = false;
        const p = showPrompt('Annotation text:');
        buttonsOf(openModals()[0]).cancel.click();
        await p;
        expect(par.paused).toBe(false);
    });

    test('resumes on Escape', async () => {
        par.paused = false;
        const p = showPrompt('Annotation text:');
        const input = openModals()[0].querySelector('input');
        input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await p;
        expect(par.paused).toBe(false);
    });

    test('leaves an already-paused video paused', async () => {
        // Must RESTORE the prior state, not blindly resume.
        par.paused = true;
        const p = showPrompt('Annotation text:');
        expect(par.paused).toBe(true);
        buttonsOf(openModals()[0]).cancel.click();
        await p;
        expect(par.paused).toBe(true);
    });

    test('respects pausedLock — an analysis driving par.frame keeps the hold', async () => {
        // par's setter refuses to resume while pausedLock is held; showPrompt must not
        // fight that (Star Tracker's detect pass steps frames itself).
        par.paused = true;
        par.pausedLock = true;
        const p = showPrompt('Anything?');
        buttonsOf(openModals()[0]).cancel.click();
        await p;
        expect(par.paused).toBe(true);
        par.pausedLock = false;
    });

    test('validationMode still short-circuits without touching playback', async () => {
        // Headless runs must neither block nor perturb the frame counter.
        Globals.validationMode = true;
        par.paused = false;
        await expect(showPrompt('Suppressed?')).resolves.toBeNull();
        expect(openModals()).toHaveLength(0);
        expect(par.paused).toBe(false);
    });
});
