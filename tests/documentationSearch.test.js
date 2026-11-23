import fs from 'fs';
import os from 'os';
import path from 'path';
import {createDocumentationSearch, documentationSnippet} from '../src/documentation/DocumentationSearch';
import {helpDocs} from '../src/docsRegistry';
const {buildDocumentationIndex, registeredFiles} = require('../scripts/buildDocumentationIndex');
const {addHeadingIds} = require('../scripts/docHeadings');
const {searchTermRanges, searchTerms} = require('../src/documentation/SearchTerms.cjs');

let root, result, search;
beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-doc-search-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'src/docsRegistry.js'), `
        export const helpDocs = [
            {file: 'docs/WhatsNew'}, {file: 'docs/WhatsNew-Details'},
            {file: 'docs/FrequencyAnalysis'}, {file: 'docs/Other'}, {file: 'README'}
        ];`);
    for (const file of ['WhatsNew', 'WhatsNew-Details']) {
        fs.writeFileSync(path.join(root, `docs/${file}.md`), `# What's New in Sitrec${file.endsWith('Details') ? ' — Detailed Changelog' : ''}
## Version 2.10.0 (2026-11-22)
### FOV Editor
Current FOV Editor improvements. latestmarker
### Fixes
The FOV Editor has another fix. ${file.endsWith('Details') ? 'detailmarker' : 'summarymarker'}
## Version 2.9.0 (2026-11-21)
### FOV Editor
Old FOV Editor changes. archivedmarker
`);
    }
    fs.writeFileSync(path.join(root, 'docs/FrequencyAnalysis.md'), `# Frequency Analysis
Find wings flapping and flashing lights.
<!-- hiddenmarker must stay out -->
## DFT & FFT
Multiply the signal by a test wave. A **Hann window** tapers it.
## DFT & FFT
Repeated heading with a second section.
## Stage 2 — Check
The résumé has QP compression measurements.
`);
    fs.writeFileSync(path.join(root, 'docs/Other.md'), `# Camera settings
## Frequency analysis
This page mentions frequency analysis but is not its main guide.
## Frames
Set the camera frame rate.
${Array.from({length: 32}, (_, i) => `## Camera option ${i}\nSet the FOV with the curve editor.`).join('\n')}
`);
    fs.writeFileSync(path.join(root, 'README.md'), '# Sitrec\nStart here.');
    fs.writeFileSync(path.join(root, 'docs/Unregistered.md'), '# Unregistered\nexcludedmarker');
    result = buildDocumentationIndex(root);
    search = createDocumentationSearch(result.index);
});
afterAll(() => fs.rmSync(root, {recursive: true, force: true}));

test('indexes only guides in the registry and excludes comments and markup', () => {
    expect(result.index.documents.map(d => d.file)).toEqual([
        'docs/WhatsNew', 'docs/WhatsNew-Details', 'docs/FrequencyAnalysis', 'docs/Other', 'README',
    ]);
    expect(search('excludedmarker').total).toBe(0);
    expect(search('hiddenmarker').total).toBe(0);
    const match = search('Hann window').results[0];
    expect(match.snippet).toContain('Hann window');
    expect(match.snippet).not.toContain('**');
});

test('ranks the actual topic above incidental mentions', () => {
    expect(search('Frequency Analysis').results[0].file).toBe('docs/FrequencyAnalysis');
});

test('indexes only the latest release in each changelog', () => {
    expect(search('archivedmarker').total).toBe(0);
    expect(result.json).not.toContain('archivedmarker');
    expect(result.json).not.toContain('Version 2.9.0');
    expect(search('latestmarker').results.map(row => row.file)).toEqual(['docs/WhatsNew', 'docs/WhatsNew-Details']);
});

test('keeps one best match per changelog as the final two results, including at the limit', () => {
    const found = search('fov editor');
    expect(found.total).toBe(34);
    expect(found.results).toHaveLength(30);
    expect(found.results.slice(0, -2).every(row => row.file === 'docs/Other')).toBe(true);
    expect(found.results.slice(-2).map(row => row.file)).toEqual(['docs/WhatsNew', 'docs/WhatsNew-Details']);
    expect(found.results.slice(-2).every(row => row.anchor === 'fov-editor')).toBe(true);
    expect(search('fov editor', 100).results).toHaveLength(34);
});

test('includes a changelog only when it matches, and respects small result limits', () => {
    expect(search('summarymarker').results.map(row => row.file)).toEqual(['docs/WhatsNew']);
    expect(search('detailmarker').results.map(row => row.file)).toEqual(['docs/WhatsNew-Details']);
    expect(search('fov editor', 1).results.map(row => row.file)).toEqual(['docs/WhatsNew']);
    expect(search('fov editor', 0).results).toEqual([]);
});

test('matches prefixes, all query words, punctuation, case and accents', () => {
    expect(search('wing flap').results[0].file).toBe('docs/FrequencyAnalysis');
    expect(search('the HANN, window').results[0].anchor).toBe('dft--fft');
    expect(search('resume').results[0].heading).toBe('Stage 2 — Check');
    expect(search('QP').results[0].snippet).toContain('compression');
    expect(search('flapping compression').total).toBe(0);
    expect(search('unmatchedword').total).toBe(0);
    expect(search('the and of').total).toBe(0);
});

test('links to the same headings as the HTML renderer, including duplicate headings', () => {
    expect(search('second section').results[0].anchor).toBe('dft--fft-1');
    expect(search('resume').results[0].anchor).toBe('stage-2--check');
    expect(addHeadingIds('<h2>Stage 2 — Check</h2><h2>DFT &amp; FFT</h2><h2>DFT &amp; FFT</h2>'))
        .toBe('<h2 id="stage-2--check">Stage 2 — Check</h2><h2 id="dft--fft">DFT &amp; FFT</h2><h2 id="dft--fft-1">DFT &amp; FFT</h2>');
});

test('highlight ranges preserve accented text and the index word boundaries', () => {
    const text = 'Résumé re\u0301sume\u0301 QP QPS other there';
    const ranges = searchTermRanges(text, searchTerms('res QP ther'));
    expect(ranges.map(([start, end]) => text.slice(start, end))).toEqual(['Rés', 're\u0301s', 'QP', 'ther']);
    expect(documentationSnippet('other '.repeat(60) + 'There is heat.', ['ther'])).toContain('There is heat.');
});

test('keeps index generation deterministic and fails on a missing registered document', () => {
    expect(buildDocumentationIndex(root).json).toBe(result.json);
    fs.unlinkSync(path.join(root, 'README.md'));
    expect(() => buildDocumentationIndex(root)).toThrow();
    fs.writeFileSync(path.join(root, 'README.md'), '# Sitrec\nStart here.');
});

test('the build reads the same guide set as the application registry', () => {
    const repo = path.resolve(__dirname, '..');
    expect(registeredFiles(repo)).toEqual(helpDocs.map(doc => doc.file));
    const built = buildDocumentationIndex(repo);
    const actual = createDocumentationSearch(built.index);
    expect(actual('wing flapping').results[0].file).toBe('docs/FrequencyAnalysis');
    expect(actual('zero padding').results.some(row => row.file === 'docs/FrequencyAnalysis')).toBe(true);
    const fov = actual('fov editor');
    expect(fov.results[0].file).toBe('docs/CameraAndTarget');
    const releaseMatches = fov.results.filter(row => row.changelog);
    expect(new Set(releaseMatches.map(row => row.file)).size).toBe(releaseMatches.length);
    expect(fov.results.slice(fov.results.length - releaseMatches.length)).toEqual(releaseMatches);
    expect(built.files).toContain('docs/FrequencyAnalysis.md');
});
