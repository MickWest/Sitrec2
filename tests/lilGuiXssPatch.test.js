// Guards the Sitrec security patch to the vendored lil-gui.
//
// lil-gui upstream writes GUI labels with innerHTML, which is a DOM XSS sink here: menu
// names and folder titles are routinely built from untrusted data — track names out of a
// loaded KML/CSV, object and graph titles out of a sitch fetched from an arbitrary URL via
// ?custom= — so a shared link could run script on the Sitrec origin. That matters
// especially now the origin holds a BYOK provider API key in IndexedDB.
//
// The realistic way this regresses is not someone re-typing innerHTML, it is a routine
// `lil-gui` upgrade dropping the vendored file back in and silently reverting the patch.
// This test fails loudly if that happens.

import fs from 'fs';
import path from 'path';

const LIL_GUI = path.resolve(__dirname, '..', 'src', 'js', 'lil-gui.esm.js');

// The only innerHTML assignments allowed to survive, both with constant right-hand sides:
//   'Select an option'  — a hardcoded placeholder option label
//   cssContent          — lil-gui's own stylesheet text, injected at startup
const ALLOWED_INNERHTML_RHS = ["'Select an option'", 'cssContent'];

describe('lil-gui XSS patch', () => {
    const source = fs.readFileSync(LIL_GUI, 'utf8');

    test('no innerHTML assignment takes a data-derived value', () => {
        const assignments = [...source.matchAll(/^\s*(?!\/\/)(\S[^\n]*?)\.innerHTML\s*=\s*([^;]+);/gm)]
            .map(m => ({line: m[0].trim(), rhs: m[2].trim()}));

        const unexpected = assignments.filter(a => !ALLOWED_INNERHTML_RHS.includes(a.rhs));
        expect(unexpected.map(a => a.line)).toEqual([]);
    });

    // Pin the specific sinks that were exploitable, so a partial revert is caught even if
    // the upgrade happens to keep the total count the same.
    test.each([
        ['controller name', 'this.$name.textContent = name;'],
        ['folder title', 'this.$title.textContent = title;'],
        ['dropdown option', '$option.textContent = name;'],
        ['dropdown display', 'this.$display.textContent = index === -1 ? value : this._names[ index ];'],
    ])('%s uses textContent', (_label, expected) => {
        expect(source).toContain(expected);
    });
});
