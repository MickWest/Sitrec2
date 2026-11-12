/** @jest-environment jsdom */
import en from '../src/i18n/en';
import {showDocumentationSearch} from '../src/documentation/DocumentationSearchDialog';

jest.mock('../src/i18n', () => ({t: (key, values = {}) => {
    const strings = require('../src/i18n/en').default;
    return key.split('.').reduce((value, part) => value[part], strings)
        .replace(/{{(\w+)}}/g, (_, name) => values[name]);
}}));
jest.mock('../src/docsRegistry', () => ({docUrl: (file, {anchor}) => `./${file}.html#${anchor}`}));

const index = {version: 1, documents: [{file: 'docs/FrequencyAnalysis', title: 'Frequency Analysis'}],
    sections: [{document: 0, heading: 'Small objects', anchor: 'small-objects', text: 'Wings flapping <img src=x onerror=alert(1)>'}],
    postings: {wing: [0], wings: [0], flapping: [0], frequency: [0], small: [0]}};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
    jest.useFakeTimers();
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () {
        this.open = false; this.dispatchEvent(new Event('close'));
    };
    global.fetch = jest.fn().mockResolvedValue({ok: true, json: async () => index});
});
afterEach(() => {
    document.querySelector('dialog')?.close();
    document.body.replaceChildren();
    jest.useRealTimers();
});

test('loads once, searches locally, opens the matching anchor and renders text safely', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const dialog = showDocumentationSearch('/build-a/docs/search-index.json');
    expect(document.activeElement.tagName).toBe('INPUT');
    expect(showDocumentationSearch('/build-a/docs/search-index.json')).toBe(dialog);
    await flush();
    const input = dialog.querySelector('input'); input.value = 'wing flapping';
    input.dispatchEvent(new Event('input')); jest.advanceTimersByTime(110);
    expect(dialog.querySelector('a').getAttribute('href')).toBe('./docs/FrequencyAnalysis.html#small-objects');
    expect(dialog.querySelector('a').target).toBe('_blank');
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('li p').textContent).toContain('<img');
    expect([...dialog.querySelectorAll('li p mark')].map(mark => mark.textContent)).toEqual(['Wing', 'flapping']);
    input.value = 'freq small'; input.dispatchEvent(new Event('input')); jest.advanceTimersByTime(110);
    expect(dialog.querySelector('a > mark').textContent).toBe('Freq');
    expect(dialog.querySelector('.search-section mark').textContent).toBe('Small');
    input.value = 'wings'; input.dispatchEvent(new Event('input')); jest.advanceTimersByTime(110);
    expect([...dialog.querySelectorAll('li mark')].map(mark => mark.textContent)).toEqual(['Wings']);
    expect(fetch).toHaveBeenCalledTimes(1);
    dialog.close(); expect(document.activeElement).toBe(opener);
    showDocumentationSearch('/build-a/docs/search-index.json'); await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('a failed load offers a retry and accepts the query entered while loading', async () => {
    fetch.mockRejectedValueOnce(new Error('offline'));
    const dialog = showDocumentationSearch('/build-b/docs/search-index.json');
    dialog.querySelector('input').value = 'flapping';
    await flush();
    expect(dialog.textContent).toContain(en.documentationSearch.failed);
    const retry = [...dialog.querySelectorAll('button')].find(b => b.textContent === en.documentationSearch.retry);
    expect(retry.hidden).toBe(false);
    retry.click(); await flush();
    expect(dialog.querySelector('a')).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
});

test('typing and key releases do not reach application shortcuts', async () => {
    const onKey = jest.fn();
    document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKey);
    const dialog = showDocumentationSearch('/build-c/docs/search-index.json'); await flush();
    for (const type of ['keydown', 'keyup']) dialog.querySelector('input').dispatchEvent(
        new KeyboardEvent(type, {key: ' ', bubbles: true}));
    expect(onKey).not.toHaveBeenCalled();
    document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKey);
});
