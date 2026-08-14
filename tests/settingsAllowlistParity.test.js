// The settings allowlist exists twice: sanitizeSettings() in src/SettingsManager.js runs in
// the browser, and sanitizeSettings() in sitrecServer/settings.php runs on the server. Both
// are allowlists — anything not named is silently dropped.
//
// Both files carry a comment saying "you must update BOTH", and nothing enforced it. The
// drift is silent in the worst way: the setting works locally, saves without error, and is
// quietly discarded on the way to the server, so it only reappears as "my preference does
// not stick across devices". showFilename was in that state — it shipped browser-side,
// was never added to the PHP list, and every settings save fired an assert about it.
//
// This test compares the two lists directly, so the next added setting fails here rather
// than in a user's session.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

function jsAllowlist() {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'SettingsManager.js'), 'utf8');
    const body = src.slice(src.indexOf('export function sanitizeSettings'));
    return new Set([...body.matchAll(/settings\.([A-Za-z][A-Za-z0-9]*)\s*!==\s*undefined/g)]
        .map(m => m[1]));
}

function phpAllowlist() {
    const src = fs.readFileSync(path.join(ROOT, 'sitrecServer', 'settings.php'), 'utf8');
    const start = src.indexOf('function sanitizeSettings');
    // Stop at the next top-level function so we only read this one's body.
    const next = src.indexOf('\nfunction ', start + 1);
    const body = next === -1 ? src.slice(start) : src.slice(start, next);
    return new Set([...body.matchAll(/isset\(\$settings\['([A-Za-z][A-Za-z0-9]*)'\]\)/g)]
        .map(m => m[1]));
}

describe('settings allowlist parity', () => {
    const js = jsAllowlist();
    const php = phpAllowlist();

    test('both allowlists were parsed (guards against the regexes silently matching nothing)', () => {
        expect(js.size).toBeGreaterThan(5);
        expect(php.size).toBeGreaterThan(5);
    });

    test('every browser-side setting is also accepted by the server', () => {
        const missingFromPhp = [...js].filter(k => !php.has(k)).sort();
        expect(missingFromPhp).toEqual([]);
    });

    test('the server accepts no setting the browser will not send', () => {
        // Not a security problem in itself, but it means one of the two is stale.
        const missingFromJs = [...php].filter(k => !js.has(k)).sort();
        expect(missingFromJs).toEqual([]);
    });
});
