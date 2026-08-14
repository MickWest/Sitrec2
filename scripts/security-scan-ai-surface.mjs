#!/usr/bin/env node
// Focused security scan for the AI assistant / BYOK surface.
//
// This is deliberately narrow. It does not try to be a general SAST tool — it encodes the
// specific invariants that a real security review of this area established, so that a
// future change (or a dependency upgrade) cannot quietly undo them. Every rule below
// exists because the corresponding hole was found and fixed; the comment says which.
//
// Run locally:  node scripts/security-scan-ai-surface.mjs
// Exit code 1 on any violation, so CI fails the PR.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

const failures = [];
const fail = (rule, detail) => failures.push({rule, detail});
const ok = [];

// ─── Rule 1: no data-derived innerHTML in the vendored lil-gui ────────────────────────
// GUI labels are built from untrusted data (track names from a loaded KML, graph/object
// titles from a sitch fetched via ?custom=<any URL>). Upstream lil-gui writes them with
// innerHTML, which made a shared link able to run script on the Sitrec origin — where a
// BYOK provider key now lives in IndexedDB. The realistic regression is a lil-gui upgrade
// dropping the vendored file back in, so check the file itself rather than trusting git.
{
    const file = 'src/js/lil-gui.esm.js';
    if (!exists(file)) {
        fail('lil-gui-present', `${file} is missing — has lil-gui moved to node_modules? Re-target this rule.`);
    } else {
        const src = read(file);
        const ALLOWED_RHS = ["'Select an option'", 'cssContent'];
        const bad = [...src.matchAll(/^\s*(?!\/\/)(\S[^\n]*?)\.innerHTML\s*=\s*([^;]+);/gm)]
            .filter(m => !ALLOWED_RHS.includes(m[2].trim()));
        if (bad.length) {
            fail('lil-gui-innerHTML',
                `${file}: innerHTML assigned a non-constant value — XSS sink. Use textContent.\n` +
                bad.map(m => `    ${m[0].trim()}`).join('\n'));
        } else {
            ok.push('lil-gui label sinks use textContent');
        }
    }
}

// ─── Rule 2: the BYOK key namespace is not squatted ───────────────────────────────────
// BYOKKeyStore.getAllProviders() enumerates IndexedDB keys prefixed "byok_" and treats
// each as a stored provider credential. Anything else stored under that prefix makes
// hasAnyKey() true with no key entered, offering BYOK models to users who never supplied
// one. Usage totals hit exactly this and were moved to 'aiUsageTotals'.
{
    const offenders = [];
    for (const file of walk('src')) {
        if (file.endsWith('BYOKKeyStore.js')) continue;
        // Comments discussing the prefix (e.g. the note in BYOKUsage.js explaining why it
        // deliberately avoids it) are not uses of it.
        const src = stripComments(read(file));
        for (const m of src.matchAll(/['"`]byok_[A-Za-z0-9_]*['"`]/g)) {
            offenders.push(`${file}: ${m[0]}`);
        }
    }
    if (offenders.length) {
        fail('byok-namespace',
            'Only BYOKKeyStore.js may use the "byok_" storage prefix — it is enumerated as ' +
            'stored credentials.\n' + offenders.map(o => `    ${o}`).join('\n'));
    } else {
        ok.push('byok_ storage prefix is used only by BYOKKeyStore');
    }
}

// ─── Rule 3: no key material in GUI labels ────────────────────────────────────────────
// lil-gui labels are enumerated by CSitrecAPI.getMenuSummary(), POSTed to chatbot.php on
// every server-path chat turn, and embedded in the system prompt sent to whichever
// provider that tier uses. A label once carried the key's last 4 characters.
{
    const src = exists('src/CustomSupport.js') ? stripComments(read('src/CustomSupport.js')) : '';
    // Flag the key's VALUE reaching a label — a template hole or a slice of it. Merely
    // branching on whether a key exists (`key ? t(a) : t(b)`) is fine and common, so the
    // rule deliberately does not match a bare identifier.
    const bad = [
        ...src.matchAll(/\.name\([^)]*\$\{[^}]*\b(key|apiKey|token|secret)\b/gi),
        ...src.matchAll(/\.name\([^)]*\b(key|apiKey|token|secret)\s*\.\s*(slice|substr|substring|at)\s*\(/gi),
    ];
    if (bad.length) {
        fail('key-in-label',
            'A GUI label appears to interpolate key material. Labels are sent to the server ' +
            'and to the model — use a constant label.\n' +
            bad.map(m => `    ${m[0].trim()}`).join('\n'));
    } else {
        ok.push('no key material interpolated into GUI labels');
    }
}

// ─── Rule 4: chat-sourced tool calls are awaited ──────────────────────────────────────
// sitrecAPI.handleAPICall is async. Calling it without await yields a pending Promise, so
// success/error checks silently read undefined — markSitchDirty() never fires and tool
// errors never reach the user.
{
    const file = 'src/nodes/CNodeVIewChat.js';
    if (exists(file)) {
        const src = read(file);
        const bad = [...src.matchAll(/^(?!.*await).*\bsitrecAPI\.handleAPICall\(/gm)];
        if (bad.length) {
            fail('unawaited-handleAPICall',
                `${file}: handleAPICall() is async and must be awaited.\n` +
                bad.map(m => `    ${m[0].trim()}`).join('\n'));
        } else {
            ok.push('handleAPICall is awaited in the chat view');
        }
    }
}

// ─── Rule 5: the shared system prompt parses identically in JS and PHP ────────────────
// The prompt is a single file read by both sitrecServer/chatbot.php and
// src/CDirectLLMClient.js. If the two parsers disagree, the server and the browser ship
// different instructions to the model — the exact failure the shared file exists to
// prevent. JS's /m anchor and PCRE's differ on lone CR, U+2028 and U+2029.
{
    const promptFile = 'sitrecServer/chatbotSystemPrompt.txt';
    const EXPECTED = ['base', 'menuHeader', 'menuGroup', 'menuItem', 'menuFooter',
                      'docsHeader', 'docsItem', 'docsFooter'];
    if (!exists(promptFile)) {
        fail('prompt-file', `${promptFile} is missing — chatbot.php reads it at runtime.`);
    } else {
        const raw = read(promptFile);
        const parts = raw.split(/(?:^|\n)@@SECTION[ \t]+(\w+)[ \t]*\r?\n/);
        const jsSections = {};
        for (let i = 1; i + 1 < parts.length; i += 2) {
            jsSections[parts[i]] = parts[i + 1].replace(/\r?\n$/, '');
        }
        const missing = EXPECTED.filter(s => !jsSections[s] || jsSections[s].trim() === '');
        if (missing.length) {
            fail('prompt-sections', `${promptFile}: missing or empty section(s): ${missing.join(', ')}`);
        } else {
            ok.push(`prompt file has all ${EXPECTED.length} sections, none empty`);
        }

        // Cross-language check, when php is available (it is on ubuntu runners).
        try {
            const php = `
$raw = file_get_contents(${JSON.stringify(path.join(ROOT, promptFile))});
$parts = preg_split('/(?:^|\\n)@@SECTION[ \\t]+(\\w+)[ \\t]*\\r?\\n/', $raw, -1, PREG_SPLIT_DELIM_CAPTURE);
$s = [];
for ($i = 1; $i + 1 < count($parts); $i += 2) { $s[$parts[$i]] = preg_replace('/\\r?\\n$/', '', $parts[$i+1]); }
echo json_encode($s);`;
            const out = execFileSync('php', ['-r', php], {encoding: 'utf8'});
            const phpSections = JSON.parse(out);
            const disagree = [...new Set([...Object.keys(jsSections), ...Object.keys(phpSections)])]
                .filter(k => jsSections[k] !== phpSections[k]);
            if (disagree.length) {
                fail('prompt-parser-parity',
                    `JS and PHP parsers disagree on section(s): ${disagree.join(', ')}. ` +
                    'The browser and the server would send the model different prompts.');
            } else {
                ok.push('JS and PHP prompt parsers agree on every section');
            }
        } catch (e) {
            ok.push('PHP not available — skipped cross-language prompt parity check');
        }
    }
}

// ─── Report ───────────────────────────────────────────────────────────────────────────
// Crude but adequate: these rules only need to avoid matching prose in comments, and the
// files scanned have no regex/string literals containing comment markers that matter here.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'js') continue;
            walk(rel, out);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
            out.push(rel);
        }
    }
    return out;
}

for (const line of ok) console.log(`  ok   ${line}`);
if (failures.length === 0) {
    console.log(`\nAI/BYOK surface security scan passed (${ok.length} checks).`);
    process.exit(0);
}
console.error('\nAI/BYOK surface security scan FAILED:\n');
for (const f of failures) console.error(`  [${f.rule}]\n  ${f.detail}\n`);
process.exit(1);
