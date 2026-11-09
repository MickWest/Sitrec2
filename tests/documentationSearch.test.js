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
            {file: 'docs/FrequencyAnalysis'}, {file: 'docs/Other'}, {file: 'README'}
        ];`);
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
`);
    fs.writeFileSync(path.join(root, 'README.md'), '# Sitrec\nStart here.');
    fs.writeFileSync(path.join(root, 'docs/Unregistered.md'), '# Unregistered\nexcludedmarker');
    result = buildDocumentationIndex(root);
    search = createDocumentationSearch(result.index);
});
afterAll(() => fs.rmSync(root, {recursive: true, force: true}));

test('indexes only guides in the registry and excludes comments and markup', () => {
    expect(result.index.documents.map(d => d.file)).toEqual(['docs/FrequencyAnalysis', 'docs/Other', 'README']);
    expect(search('excludedmarker').total).toBe(0);
    expect(search('hiddenmarker').total).toBe(0);
    const match = search('Hann window').results[0];
    expect(match.snippet).toContain('Hann window');
    expect(match.snippet).not.toContain('**');
});

test('ranks the actual topic above incidental mentions', () => {
    expect(search('Frequency Analysis').results[0].file).toBe('docs/FrequencyAnalysis');
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
    expect(built.files).toContain('docs/FrequencyAnalysis.md');
});
