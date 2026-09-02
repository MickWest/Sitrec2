#!/usr/bin/env node
// User data egress check — deterministic layer.
//
// Answers one question about a set of changes: where can data now leave the application?
// On the ADDED lines only, it lists every network call, every destination host, every
// server endpoint and every URL that carries a position, and compares the destinations
// against scripts/egress-allowlist.json — the reviewed inventory of where the application
// is designed to send data and what each destination receives.
//
// It is a listing tool, not a judgement tool. It cannot tell whether a new fetch() sends a
// track or a map tile; the LLM review that runs after it (see
// .github/workflows/user-data-egress-check.yml) makes that call with this listing as its
// map. What this layer guarantees on its own is that a new destination or a new server
// endpoint can never arrive silently: those always surface here, at zero cost.
//
// Usage:
//   node scripts/security-scan-egress.mjs --range <base>..<head> [--out-dir DIR] [--json] [--strict]
//   node scripts/security-scan-egress.mjs --diff-file <unified.diff> [--out-dir DIR] [--json]
//   node scripts/security-scan-egress.mjs --inventory            # every tracked file in scope
//
// --out-dir writes scan.json, scan.md and files.txt (the in-scope files, one per line).
// Exit 0 = ran (the verdict is in the output); 1 = ATTENTION under --strict; 2 = script failure.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
export const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'egress-allowlist.json');

// ─── Scope ────────────────────────────────────────────────────────────────────────────
// Code that runs in the browser, on the server, or in the standalone tool pages. Vendored
// third-party copies under src/js are included — a library update can add a beacon.
// Mirrors of npm packages, minified bundles, tests and type declarations are not.
const IN_SCOPE = [
    /^src\//,
    /^sitrecServer\//,
    /^tools\//,
    /^config\/[^/]+\.example$/,
    /^[^/]+\.(js|mjs|cjs|ts|html)$/,
];
const OUT_OF_SCOPE = [
    /^sitrecServer\/vendor\//,
    /^tools\/three\.js\//,
    /(^|\/)node_modules\//,
    /\.min\.js$/,
    /^tools\/shf\/lib\//,
    /(^|\/)tests?\//,
    /(^|\/)__mocks__\//,
    /\.test\.(js|mjs|cjs|ts)$/,
    /\.d\.ts$/,
];
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|html?|php|example)$/;

export function isInScope(file) {
    if (!CODE_EXT.test(file)) return false;
    if (OUT_OF_SCOPE.some(re => re.test(file))) return false;
    return IN_SCOPE.some(re => re.test(file));
}

export function langOf(file) {
    const name = file.replace(/\.example$/, '');
    if (/\.php$/.test(name)) return 'php';
    if (/\.html?$/.test(name)) return 'html';
    if (/\.env$/.test(name)) return 'env';
    return 'js';
}

// ─── What counts as a sink ────────────────────────────────────────────────────────────
// Each entry: [label, pattern, optional extra predicate on the line]. A sink is any call
// that can move data out of the page or the server process. Server-side logging and file
// writes are included: data written there can be read by whoever runs the server.
const hasUrlShape = s => /https?:|\$\{|\+\s*['"`]|\bURL\b|SITREC_SERVER/.test(s);

const JS_SINKS = [
    ['fetch',             /\bfetch\s*\(/],
    ['quickFetch',        /\bquickFetch\s*\(/],
    ['XMLHttpRequest',    /\bXMLHttpRequest\b/],
    ['WebSocket',         /\bnew\s+WebSocket\b/],
    ['sendBeacon',        /\bsendBeacon\s*\(/],
    ['EventSource',       /\bnew\s+EventSource\b/],
    ['WebTransport',      /\bnew\s+WebTransport\b/],
    ['RTCPeerConnection', /\bRTCPeerConnection\b/],
    ['importScripts',     /\bimportScripts\s*\(/],
    ['Image',             /\bnew\s+Image\s*\(/],
    ['loader',            /\bnew\s+\w*(File|Texture|GLTF|FBX|OBJ|Audio|Cube|Data)Loader\b|\.loadAsync\s*\(/],
    ['src assignment',    /\.src\s*=(?!=)/, hasUrlShape],
    ['window.open',       /\bwindow\.open\s*\(/],
    ['navigation',        /\blocation\.(href|assign|replace)\b/],
    ['navigator.share',   /\bnavigator\.share\s*\(/],
    ['geolocation',       /\bnavigator\.geolocation\b/],
    ['postMessage',       /\.postMessage\s*\(/],
    ['form submit',       /\.submit\s*\(\s*\)/],
    ['server endpoint',   /\bSITREC_SERVER\b/],
];
const PHP_SINKS = [
    ['curl',              /\bcurl_(init|setopt|exec)\b|\bcurlGetRequest\s*\(/],
    ['file_get_contents', /\bfile_get_contents\s*\(/],
    ['fopen',             /\bfopen\s*\(/],
    ['socket',            /\b(fsockopen|stream_socket_client)\s*\(/],
    ['mail',              /\bmail\s*\(/],
    ['redirect',          /\bheader\s*\(\s*['"]Location/i],
    ['object storage',    /\b(S3Client|putObject|createPresignedRequest|getCommand)\b/],
    ['process',           /\b(exec|shell_exec|passthru|system|proc_open|popen)\s*\(/],
    ['log',               /\berror_log\s*\(/],
    ['file write',        /\b(file_put_contents|fwrite|move_uploaded_file|copy|rename)\s*\(/],
];
const HTML_SINKS = [
    ['tag source',        /<(script|img|iframe|link|form|video|audio|source|embed|object)\b[^>]*\b(src|href|action)\s*=/i],
    ...JS_SINKS,
];
const ENV_SINKS = [];

function sinksFor(lang) {
    if (lang === 'php') return PHP_SINKS;
    if (lang === 'html') return HTML_SINKS;
    if (lang === 'env') return ENV_SINKS;
    return JS_SINKS;
}

// ─── Destinations ─────────────────────────────────────────────────────────────────────
const HOST_RE = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
// "https://${host}/…" or "https://" + host — a destination decided at run time.
const DYNAMIC_URL_RE = /https?:\/\/(?:[a-z0-9.-]*\$\{|["'`]\s*\+)/i;
// Placeholder, local and loopback names that are never a real destination.
const IGNORED_HOST_RE = /(^|\.)(localhost|invalid|example|test)$|(^|\.)example\.(com|org|net)$|^127\.\d+\.\d+\.\d+$|^0\.0\.0\.0$/i;
// A server endpoint is a .php name the client references relative to its own server
// (SITREC_SERVER + "x.php", or a bare path). A .php name inside an absolute URL belongs
// to whichever host that URL names, and is judged under that host's contract instead.
const ENDPOINT_RE = /\b([A-Za-z0-9_.-]+\.php)\b/g;
const ABSOLUTE_URL_RE = /https?:\/\/[^\s'"`)]+/gi;
const POSITION_PARAM_RE = /[?&]([A-Za-z_]*(lat|lon|lng|latitude|longitude|altitude|coords?|position)[A-Za-z_]*)=/i;
const POSITION_TEMPLATE_RE = /https?:[^\n]*\$\{[^}]*\b(lat|lon|lng|latitude|longitude)\b/i;
const looksLikeUrlLine = s => /https?:|\.php\b|SITREC_SERVER|searchParams|URLSearchParams|\bURL\s*\(/.test(s);

export function hostsIn(code) {
    const out = [];
    for (const m of code.matchAll(HOST_RE)) out.push(m[1].toLowerCase());
    return out;
}

export function endpointsIn(code) {
    const out = [];
    for (const m of code.replace(ABSOLUTE_URL_RE, ' ').matchAll(ENDPOINT_RE)) out.push(m[1]);
    return out;
}

// ─── Comments ─────────────────────────────────────────────────────────────────────────
// Reference links in comments are not requests. Whole-line comments are dropped, and a
// trailing "// …" is cut off unless the "//" is the one inside "https://".
export function isCommentLine(text, lang) {
    const t = text.trim();
    if (t === '') return true;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return true;
    if ((lang === 'php' || lang === 'env') && t.startsWith('#')) return true;
    if (lang === 'html' && t.startsWith('<!--')) return true;
    return false;
}

export function stripTrailingComment(text) {
    let i = -1;
    while ((i = text.indexOf('//', i + 1)) !== -1) {
        if (i > 0 && text[i - 1] === ':') continue;
        return text.slice(0, i);
    }
    return text;
}

const snip = s => {
    const t = s.trim().replace(/\s+/g, ' ');
    return t.length > 140 ? t.slice(0, 137) + '...' : t;
};

// ─── Allow-list ───────────────────────────────────────────────────────────────────────
// Every destination carries a contract: the most revealing classes of data it is designed
// to receive, from this fixed vocabulary (least to most revealing). A destination with no
// entry has no contract, and a listed destination sent a class outside its contract is a
// finding — the scanner enforces the position classes itself, the review judges the rest.
export const DATA_CLASSES = [
    'none',             // the request carries nothing beyond the fact that it was made
    'time',             // a date or time only
    'coarse-area',      // tile coordinates or a bounding box of the viewed area
    'precise-position', // a specific latitude and longitude
    'identifier',       // an aircraft, satellite or object identifier the user looks up
    'user-text',        // text the user typed: a place name, a chat message, a label
    'user-file',        // a file the user explicitly chose to upload or share
    'user-audio',       // microphone audio, for the voice feature
    'usage-stats',      // control names and counts, no content
    'video-frame',      // a frame of the user's video
    'menu-summary',     // a summary of the current menu state, sent with a chat message
];
const POSITION_CLASSES = new Set(['coarse-area', 'precise-position']);
export const allowsPosition = entry => (entry.mayReceive || []).some(c => POSITION_CLASSES.has(c));

export function loadAllowlist(file = ALLOWLIST_PATH) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = [];
    const check = (label, e) => {
        if (!Array.isArray(e.mayReceive) || !e.mayReceive.length) problems.push(`${label}: mayReceive must be a non-empty array`);
        else for (const c of e.mayReceive) if (!DATA_CLASSES.includes(c)) problems.push(`${label}: unknown data class "${c}"`);
        if (!e.purpose) problems.push(`${label}: purpose is required`);
        if (!e.trigger) problems.push(`${label}: trigger is required`);
    };
    const hosts = (data.hosts || []).map(h => ({...h, host: String(h.host).toLowerCase()}));
    for (const h of hosts) check(`host ${h.host}`, h);
    const endpointList = data.serverEndpoints || [];
    for (const e of endpointList) check(`endpoint ${e.endpoint}`, e);
    if (problems.length) throw new Error(`allow-list ${path.relative(ROOT, file)} is invalid:\n  ` + problems.join('\n  '));
    const endpoints = new Map(endpointList.map(e => [e.endpoint, e]));
    return {
        hosts,
        endpoints,
        matchHost(host) {
            const h = host.toLowerCase();
            return hosts.find(e => e.host === h || (e.host.startsWith('*.') && h.endsWith(e.host.slice(1)))) || null;
        },
        matchEndpoint(name) {
            return endpoints.get(name) || null;
        },
    };
}

// ─── Unified diff → added lines per file ──────────────────────────────────────────────
export function parseUnifiedDiff(text) {
    const files = [];
    let cur = null;
    let newLine = 0;
    for (const raw of text.split('\n')) {
        if (raw.startsWith('diff --git ')) {
            cur = {path: null, isNew: false, isDeleted: false, binary: false, added: []};
            files.push(cur);
            const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
            if (m) cur.path = m[2];
            continue;
        }
        if (!cur) continue;
        if (raw.startsWith('new file mode')) { cur.isNew = true; continue; }
        if (raw.startsWith('deleted file mode')) { cur.isDeleted = true; continue; }
        if (raw.startsWith('Binary files')) { cur.binary = true; continue; }
        if (raw.startsWith('+++ ')) {
            const p = raw.slice(4).trim();
            if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
            continue;
        }
        if (raw.startsWith('--- ')) continue;
        if (raw.startsWith('@@')) {
            const m = raw.match(/\+(\d+)(?:,(\d+))?/);
            newLine = m ? parseInt(m[1], 10) : 0;
            continue;
        }
        if (raw.startsWith('+')) { cur.added.push({line: newLine, text: raw.slice(1)}); newLine++; continue; }
        if (raw.startsWith('-')) continue;
        if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
        newLine++;
    }
    return files;
}

// ─── The scan ─────────────────────────────────────────────────────────────────────────
export function scanFiles(files, allow) {
    const result = {
        filesChanged: files.length,
        filesInScope: [],
        newServerFiles: [],
        sinks: [],
        knownHosts: [],
        unknownHosts: [],
        knownEndpoints: [],
        unknownEndpoints: [],
        overBudget: [],
        dynamicUrls: [],
        positionUrls: [],
    };
    const seen = new Set();
    const once = (bucket, key, item) => {
        const k = bucket + '|' + key;
        if (seen.has(k)) return;
        seen.add(k);
        result[bucket].push(item);
    };

    for (const f of files) {
        if (!f.path || f.isDeleted || f.binary) continue;
        if (!isInScope(f.path)) continue;
        result.filesInScope.push(f.path);
        // A new server-side file needs a contract in the same push; with one, it is judged
        // by the review like any other change.
        if (f.isNew && /^sitrecServer\/[^/]+\.php$/.test(f.path) && !allow.matchEndpoint(path.basename(f.path))) {
            result.newServerFiles.push(f.path);
        }

        const lang = langOf(f.path);
        for (const {line, text} of f.added) {
            if (isCommentLine(text, lang)) continue;
            const code = stripTrailingComment(text);
            const at = {file: f.path, line, snippet: snip(code)};

            for (const [kind, re, extra] of sinksFor(lang)) {
                if (re.test(code) && (!extra || extra(code))) result.sinks.push({...at, kind});
            }

            // A position on this line, aimed at whatever destination the line names. The
            // query-string form ("?lat=") is URL-shaped by itself; the template form needs
            // a scheme on the line.
            const carriesPosition = POSITION_PARAM_RE.test(code) ||
                (looksLikeUrlLine(code) && POSITION_TEMPLATE_RE.test(code));
            let destinationNamed = false;

            for (const host of hostsIn(code)) {
                if (IGNORED_HOST_RE.test(host)) continue;
                destinationNamed = true;
                const entry = allow.matchHost(host);
                if (!entry) { once('unknownHosts', `${host}|${f.path}|${line}`, {...at, host}); continue; }
                once('knownHosts', `${host}|${f.path}`, {...at, host, purpose: entry.purpose, mayReceive: entry.mayReceive});
                if (carriesPosition && !allowsPosition(entry)) {
                    result.overBudget.push({...at, destination: host, mayReceive: entry.mayReceive});
                }
            }
            if (DYNAMIC_URL_RE.test(code)) result.dynamicUrls.push(at);
            if (lang !== 'php') {
                for (const ep of endpointsIn(code)) {
                    destinationNamed = true;
                    const entry = allow.matchEndpoint(ep);
                    if (!entry) { once('unknownEndpoints', `${ep}|${f.path}|${line}`, {...at, endpoint: ep}); continue; }
                    once('knownEndpoints', `${ep}|${f.path}`, {...at, endpoint: ep, purpose: entry.purpose, mayReceive: entry.mayReceive});
                    if (carriesPosition && !allowsPosition(entry)) {
                        result.overBudget.push({...at, destination: ep, mayReceive: entry.mayReceive});
                    }
                }
            }
            // A position bound for a destination this line does not name is left to the review.
            if (carriesPosition && !destinationNamed) result.positionUrls.push(at);
        }
    }

    const reasons = [];
    if (result.unknownHosts.length) reasons.push(`${result.unknownHosts.length} destination(s) not in the allow-list`);
    if (result.unknownEndpoints.length) reasons.push(`${result.unknownEndpoints.length} server endpoint(s) not in the allow-list`);
    if (result.newServerFiles.length) reasons.push(`${result.newServerFiles.length} new server-side file(s) without an allow-list entry`);
    if (result.overBudget.length) reasons.push(`${result.overBudget.length} position(s) sent to a destination whose contract has no position class`);
    result.verdict = reasons.length ? 'ATTENTION' : 'CLEAR';
    result.reasons = reasons;
    return result;
}

// ─── Reports ──────────────────────────────────────────────────────────────────────────
const cell = s => String(s).replace(/\|/g, '\\|').replace(/`/g, '\u02cb');
const loc = it => `${it.file}:${it.line}`;

export function renderMarkdown(r, {range, inventory = false} = {}) {
    const out = [];
    out.push(inventory ? '## Egress inventory' : '## Automated scan');
    if (range) out.push(`- Range: \`${range}\``);
    out.push(`- Files changed: ${r.filesChanged}, in scope: ${r.filesInScope.length}`);
    out.push(`- Scan verdict: **${r.verdict}**${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`);
    out.push('');

    const list = (title, items, fmt) => {
        out.push(`### ${title} (${items.length})`);
        if (!items.length) out.push('none');
        else for (const it of items) out.push(fmt(it));
        out.push('');
    };

    list('Destinations not in the allow-list', r.unknownHosts,
        it => `- \`${it.host}\` — ${loc(it)} \`${cell(it.snippet)}\``);
    list('Server endpoints not in the allow-list', r.unknownEndpoints,
        it => `- \`${it.endpoint}\` — ${loc(it)} \`${cell(it.snippet)}\``);
    list('New server-side files without an allow-list entry', r.newServerFiles, it => `- \`${it}\``);
    list('Position sent to a destination whose contract has no position class', r.overBudget,
        it => `- \`${it.destination}\` may receive only [${it.mayReceive.join(', ')}] — ${loc(it)} \`${cell(it.snippet)}\``);

    if (inventory) {
        const byKind = {};
        for (const s of r.sinks) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
        out.push(`### Data sinks by kind`);
        for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) out.push(`- ${k}: ${n}`);
        out.push('');
        const hostCount = {};
        for (const h of r.knownHosts) hostCount[h.host] = (hostCount[h.host] || 0) + 1;
        out.push(`### Destinations in the allow-list that the code references (${Object.keys(hostCount).length})`);
        for (const [h, n] of Object.entries(hostCount).sort()) out.push(`- \`${h}\` (${n} file${n === 1 ? '' : 's'})`);
        out.push('');
        const epCount = {};
        for (const e of r.knownEndpoints) epCount[e.endpoint] = (epCount[e.endpoint] || 0) + 1;
        out.push(`### Server endpoints in the allow-list that the client references (${Object.keys(epCount).length})`);
        for (const [e, n] of Object.entries(epCount).sort()) out.push(`- \`${e}\` (${n} file${n === 1 ? '' : 's'})`);
        out.push('');
        return out.join('\n');
    }

    out.push(`### Network calls and other data sinks on added lines (${r.sinks.length})`);
    if (!r.sinks.length) out.push('none');
    else {
        out.push('| Location | Kind | Code |');
        out.push('|---|---|---|');
        for (const s of r.sinks) out.push(`| ${loc(s)} | ${s.kind} | \`${cell(s.snippet)}\` |`);
    }
    out.push('');
    list('URLs with a destination decided at run time', r.dynamicUrls,
        it => `- ${loc(it)} \`${cell(it.snippet)}\``);
    list('URLs that carry a position to a destination not named on the line', r.positionUrls,
        it => `- ${loc(it)} \`${cell(it.snippet)}\``);
    list('Allow-listed destinations referenced on added lines', r.knownHosts,
        it => `- \`${it.host}\` — ${it.purpose}; may receive [${it.mayReceive.join(', ')}] (${loc(it)})`);
    list('Allow-listed server endpoints referenced on added lines', r.knownEndpoints,
        it => `- \`${it.endpoint}\` — ${it.purpose}; may receive [${it.mayReceive.join(', ')}] (${loc(it)})`);
    out.push('### Files in scope');
    if (!r.filesInScope.length) out.push('none — no code changed in this range');
    else for (const f of r.filesInScope) out.push(`- \`${f}\``);
    out.push('');
    return out.join('\n');
}

// ─── Inputs ───────────────────────────────────────────────────────────────────────────
function diffForRange(base, head) {
    return execFileSync('git', [
        'diff', '--no-color', '--no-ext-diff', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', base, head,
    ], {cwd: ROOT, maxBuffer: 1 << 28}).toString();
}

function inventoryFiles() {
    const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: ROOT, maxBuffer: 1 << 28})
        .toString().split('\0').filter(Boolean);
    return tracked.filter(isInScope).map(p => {
        const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
        return {
            path: p, isNew: false, isDeleted: false, binary: false,
            added: text.split('\n').map((t, i) => ({line: i + 1, text: t})),
        };
    });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const o = {range: null, diffFile: null, inventory: false, outDir: null, json: false, strict: false, allowlist: null};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--range') o.range = next();
        else if (a === '--diff-file') o.diffFile = next();
        else if (a === '--inventory') o.inventory = true;
        else if (a === '--out-dir') o.outDir = next();
        else if (a === '--allowlist') o.allowlist = next();
        else if (a === '--json') o.json = true;
        else if (a === '--strict') o.strict = true;
        else if (a === '--help' || a === '-h') { o.help = true; }
        else throw new Error(`unknown argument: ${a}`);
    }
    return o;
}

function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help || (!o.range && !o.diffFile && !o.inventory)) {
        console.log(fs.readFileSync(SELF, 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        return 0;
    }
    const allow = loadAllowlist(o.allowlist ? path.resolve(o.allowlist) : ALLOWLIST_PATH);

    let files;
    let range = null;
    if (o.inventory) {
        files = inventoryFiles();
    } else if (o.diffFile) {
        files = parseUnifiedDiff(fs.readFileSync(path.resolve(o.diffFile), 'utf8'));
    } else {
        const m = o.range.match(/^(.+?)\.\.\.?(.+)$/);
        if (!m) throw new Error(`--range expects <base>..<head>, got ${o.range}`);
        range = `${m[1]}..${m[2]}`;
        files = parseUnifiedDiff(diffForRange(m[1], m[2]));
    }

    const result = scanFiles(files, allow);
    if (range) result.range = range;
    const md = renderMarkdown(result, {range, inventory: o.inventory});

    if (o.outDir) {
        fs.mkdirSync(o.outDir, {recursive: true});
        fs.writeFileSync(path.join(o.outDir, 'scan.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(o.outDir, 'scan.md'), md);
        fs.writeFileSync(path.join(o.outDir, 'files.txt'), result.filesInScope.join('\n') + (result.filesInScope.length ? '\n' : ''));
    }
    if (o.json) console.log(JSON.stringify(result, null, 2));
    else console.log(md);

    console.error(`egress scan: ${result.verdict} — ${result.filesInScope.length} file(s) in scope, ` +
        `${result.sinks.length} sink(s) on added lines, ${result.unknownHosts.length} unlisted destination(s), ` +
        `${result.unknownEndpoints.length} unlisted endpoint(s)`);
    return (o.strict && result.verdict !== 'CLEAR') ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
    // Set the exit code rather than calling process.exit(): a large report written to a
    // pipe is still draining when main() returns, and process.exit() would cut it off.
    try {
        process.exitCode = main();
    } catch (err) {
        console.error(`security-scan-egress: ${err.message}`);
        process.exitCode = 2;
    }
}
