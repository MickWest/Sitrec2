// Guards that no UI code asks for input through the native, blocking prompt().
//
// Native prompt() freezes the main thread, cannot be styled or translated, and stalls
// automation — a headless regression or MCP run sits on the dialog forever. showPrompt()
// (src/showError.js) is the replacement: it is a modal built in the page, and it resolves
// to null under Globals.validationMode so an unattended run never blocks.
//
// Converted call sites: the Add Object menu (src/index.js), Rename Sub Sitch, the sitch
// browser's Add Label, Learn Character, the annotation text tool, and Rename Script.

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');

// Vendored/bundled third-party code, and TextPrompt's own no-DOM fallback, are not
// UI call sites we control.
const SKIP_DIRS = new Set(['js']);
const SKIP_FILES = new Set([
    'showError.js',    // defines showPrompt; its comments name the thing it replaces
    'TextPrompt.js',   // its tryNativePrompt only runs when there is no document.body
]);

function collectSourceFiles(dir, found = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(path.join(dir, entry.name), found);
        } else if (entry.name.endsWith('.js') && !SKIP_FILES.has(entry.name)) {
            found.push(path.join(dir, entry.name));
        }
    }
    return found;
}

// Matches a CALL to the native prompt: bare `prompt(` or `window.prompt(`, but not
// `showPrompt(`, `promptForText(`, `this._promptAddLabel(` or a `.prompt` property read.
const NATIVE_PROMPT_CALL = /(?<![\w.$])prompt\s*\(|window\s*\.\s*prompt\s*\(/;

function stripCommentsAndStrings(line) {
    // Comments mention prompt() deliberately (explaining what was replaced), and i18n
    // keys contain the word; neither is a call.
    const withoutComment = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    return withoutComment
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

describe('no native prompt() in src/', () => {

    const files = collectSourceFiles(SRC);

    test('the scan actually covers the source tree', () => {
        // A broken walk would make every assertion below vacuously pass.
        expect(files.length).toBeGreaterThan(200);
        expect(files.some(f => f.endsWith('index.js'))).toBe(true);
    });

    test('no file calls the native prompt()', () => {
        const offenders = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, 'utf-8').split('\n');
            lines.forEach((line, i) => {
                if (NATIVE_PROMPT_CALL.test(stripCommentsAndStrings(line))) {
                    offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });

    test('the detector would catch a native prompt (it is not vacuous)', () => {
        // Guards the regex itself — a pattern that matched nothing would pass above.
        expect(NATIVE_PROMPT_CALL.test('const n = prompt("Rename script:", t.name);')).toBe(true);
        expect(NATIVE_PROMPT_CALL.test('const t = window.prompt("Annotation text:", "");')).toBe(true);
        // ...and does not fire on the replacements or on a property read
        expect(NATIVE_PROMPT_CALL.test('const n = await showPrompt("Rename script:");')).toBe(false);
        expect(NATIVE_PROMPT_CALL.test('const s = await promptForText({message: "x"});')).toBe(false);
        expect(NATIVE_PROMPT_CALL.test('this._promptAddLabel(names);')).toBe(false);
        expect(NATIVE_PROMPT_CALL.test('t("menus.objects.addObject.prompt");')).toBe(false);
    });
});

describe('the converted call sites use showPrompt', () => {

    const read = (...p) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf-8');

    const CONVERTED = [
        ['src/index.js', 'menus.objects.addObject.prompt'],
        ['src/CustomManagerSubSitch.js', 'Enter new name for Sub Sitch:'],
        ['src/CSitchBrowser.js', 'Enter label name:'],
        ['src/CTextExtraction.js', 'prompts.learnCharacter'],
        ['src/nodes/CNodeAnnotateOverlay.js', 'Annotation text:'],
        ['src/scriptedVideo/ScriptEditorWindow.js', 'Rename script:'],
    ];

    test.each(CONVERTED)('%s asks via showPrompt', (file, message) => {
        const source = read(file);
        expect(source).toContain(message);
        expect(source).toMatch(/showPrompt\s*\(/);
        expect(source).toMatch(/import\s*\{[^}]*\bshowPrompt\b[^}]*\}\s*from\s*["'][^"']*showError["']/);
    });

    test('the annotation tool still returns synchronously', () => {
        // Its caller reads the return value to decide the event was consumed, so this
        // one handler must NOT be awaited — the modal resolves into a .then().
        const source = read('src', 'nodes', 'CNodeAnnotateOverlay.js');
        expect(source).toMatch(/showPrompt\([^)]*\)[\s\S]{0,80}\.then\(/);
        expect(source).not.toMatch(/await showPrompt\("Annotation text:/);
    });

    test('the annotation stroke captures its frame BEFORE the modal opens', () => {
        // Native prompt() blocked the thread, so par.frame could not advance while it
        // was up. Reading it in the continuation would stamp a late frame instead.
        const source = read('src', 'nodes', 'CNodeAnnotateOverlay.js');
        const textTool = source.slice(source.indexOf('if (this.tool === "text")'));
        const strokeAt = textTool.indexOf('frame: par.frame');
        const promptAt = textTool.indexOf('showPrompt(');
        expect(strokeAt).toBeGreaterThan(-1);
        expect(promptAt).toBeGreaterThan(-1);
        expect(strokeAt).toBeLessThan(promptAt);
    });
});
