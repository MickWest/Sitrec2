// Tests for the container security review (scripts/auditContainerImage.mjs).
//
// The script is run as a child process, because the Jest config maps every .mjs import to
// a stub. That is also the honest way to test it: the same entry point CI calls, driven
// through its --fixture mode, which reads a previously collected evidence file instead of
// running a container engine. So these tests need no Docker, no trivy and no syft, and
// they exercise the real judgement code rather than a copy of it.

const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'auditContainerImage.mjs');

function tmpDir(prefix = 'container-audit-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Minimal but realistically shaped evidence. Every field the checks read is present, so a
 * test can override just the one property it is about.
 */
function evidenceFixture(overrides = {}) {
    const base = {
        collectedAt: '2026-09-03T00:00:00.000Z',
        image: 'example/sitrec:test',
        engine: 'docker',
        toolVersion: 'test',
        tools: {docker: 'Docker version 28.4.0', trivy: 'Version: 0.74.0', syft: 'syft 1.51.1'},
        errors: [],
        inspect: {
            Id: 'sha256:' + 'a'.repeat(64),
            Created: new Date().toISOString(),
            Os: 'linux',
            Architecture: 'amd64',
            Size: 1026584509,
            RepoDigests: [],
            Config: {
                User: '',
                ExposedPorts: {'8080/tcp': {}},
                Labels: null,
                Volumes: {'/var/www/html/sitrec-videos': {}},
            },
        },
        history: [],
        probe: {
            webroot: {mode: 'drwxrwxrwx', owner: 'www-data:www-data'},
            worldWritableDirs: [
                {mode: 'drwxrwxrwt', path: '/tmp'},
                {mode: 'drwxrwxrwx', path: '/var/www/html'},
            ],
            worldWritableFiles: [],
            setuid: [{mode: '-rwsr-xr-x', path: '/usr/bin/su'}],
            tools: [{name: 'curl', path: '/usr/bin/curl'}],
            sourceMaps: [],
            stray: [],
            endpoints: ['rehost.php', 'getsitches.php'],
            configFiles: [{path: '/var/www/html/shared.env.php', mode: '-rw-r--r--', size: 22469}],
            configKeys: [
                {file: '/var/www/html/shared.env.php', key: 'BANNER_TOP_TEXT', length: 22, verdict: 'set'},
                {file: '/var/www/html/shared.env.php', key: 'MAPBOX_TOKEN', length: 10, verdict: 'placeholder'},
                {file: '/var/www/html/shared.env.php', key: 'S3_SECRET_ACCESS_KEY', length: 10, verdict: 'placeholder'},
            ],
        },
        trivyVuln: {
            Metadata: {OS: {Family: 'debian', Name: '13.6'}},
            Results: [{
                Target: 'example (debian 13.6)', Class: 'os-pkgs', Type: 'debian',
                Vulnerabilities: [
                    {VulnerabilityID: 'CVE-1', Severity: 'CRITICAL', PkgName: 'libfoo', InstalledVersion: '1.0'},
                    {VulnerabilityID: 'CVE-2', Severity: 'HIGH', PkgName: 'libbar', InstalledVersion: '1.0', FixedVersion: '1.1'},
                    {VulnerabilityID: 'CVE-3', Severity: 'LOW', PkgName: 'libbaz', InstalledVersion: '1.0'},
                ],
            }],
        },
        trivySecret: {Results: [{Target: '/var/www/html/shared.env.php', Secrets: []}]},
        sbom: {specVersion: '1.7', total: 3, byEcosystem: {deb: 3}},
        sbomPath: 'dist-audit/sbom.cdx.json',
        dockerfile: {
            path: 'Dockerfile.release',
            from: [{ref: 'composer:2', stage: 'phpdeps'}, {ref: 'php:8.4-apache', stage: null}],
        },
    };
    return {...base, ...overrides};
}

/** Runs the script over a fixture and returns {exitCode, report, markdown}. */
function audit(evidence, args = []) {
    const fixtureDir = tmpDir('evidence-');
    const outDir = tmpDir('report-');
    fs.writeFileSync(path.join(fixtureDir, 'evidence.json'), JSON.stringify(evidence));
    const r = spawnSync(process.execPath, [
        SCRIPT, `--fixture=${fixtureDir}`, `--out=${outDir}`, '--quiet', ...args,
    ], {encoding: 'utf8', maxBuffer: 1 << 26});
    const jsonPath = path.join(outDir, 'container-security-review.json');
    return {
        exitCode: r.status,
        stderr: r.stderr,
        report: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null,
        markdown: fs.readFileSync(path.join(outDir, 'container-security-review.md'), 'utf8'),
    };
}

const byId = (report, id) => report.results.find((r) => r.id === id);

// ---------------------------------------------------------------------------

describe('baked credentials (IMG-01)', () => {
    test('a published image with only placeholders passes', () => {
        const {report, exitCode} = audit(evidenceFixture(), ['--fail-on=critical']);
        expect(byId(report, 'IMG-01').status).toBe('pass');
        expect(exitCode).toBe(0);
    });

    test('a real credential in a published image is a critical failure that gates the release', () => {
        const ev = evidenceFixture();
        ev.probe.configKeys.push({
            file: '/var/www/html/shared.env.php', key: 'S3_SECRET_ACCESS_KEY', length: 42, verdict: 'set',
        });
        const {report, exitCode} = audit(ev, ['--fail-on=critical']);
        const c = byId(report, 'IMG-01');
        expect(c.status).toBe('fail');
        expect(c.severity).toBe('critical');
        expect(c.items.map((i) => i.key)).toContain('S3_SECRET_ACCESS_KEY');
        expect(exitCode).toBe(1);
    });

    test('the same evidence in a site image is reported as a handling requirement, not a defect', () => {
        const ev = evidenceFixture();
        ev.probe.configKeys.push({
            file: '/var/www/html/shared.env.php', key: 'S3_SECRET_ACCESS_KEY', length: 42, verdict: 'set',
        });
        const {report, exitCode} = audit(ev, ['--profile=site', '--fail-on=critical']);
        const c = byId(report, 'IMG-01');
        expect(c.status).toBe('info');
        expect(c.items.map((i) => i.key)).toContain('S3_SECRET_ACCESS_KEY');
        // Still reported in full - the point is the verdict changes, not the evidence.
        expect(c.summary).toMatch(/by design/);
        expect(exitCode).toBe(0);
    });

    test('published is the default profile, so an unlabelled run never under-reports', () => {
        const ev = evidenceFixture();
        ev.probe.configKeys.push({
            file: '/var/www/html/shared.env.php', key: 'OPENAI_API', length: 166, verdict: 'set',
        });
        const {report} = audit(ev);
        expect(report.profile).toBe('published');
        expect(byId(report, 'IMG-01').status).toBe('fail');
    });

    test('a non-credential key with a real value is not a finding', () => {
        const {report} = audit(evidenceFixture());
        // BANNER_TOP_TEXT has verdict "set" in the fixture and must be ignored.
        expect(byId(report, 'IMG-01').status).toBe('pass');
    });

    test('no secret value can reach the report - only key, file and length are carried', () => {
        const ev = evidenceFixture();
        ev.probe.configKeys.push({
            file: '/var/www/html/shared.env.php', key: 'ANTHROPIC_API', length: 110, verdict: 'set',
        });
        const {report} = audit(ev);
        for (const item of byId(report, 'IMG-01').items) {
            expect(Object.keys(item).sort()).toEqual(['file', 'key', 'length']);
        }
    });
});

describe('failing closed when evidence is missing', () => {
    // The worst possible failure for a release gate: the probe does not run, every check
    // that reads it sees an empty evidence set, and an empty set looks exactly like a
    // clean image. "Not examined" must never read as "nothing found".
    function noProbeEvidence() {
        const ev = evidenceFixture();
        ev.probeOk = false;
        ev.probe = {
            webroot: null, worldWritableDirs: [], worldWritableFiles: [], setuid: [],
            tools: [], sourceMaps: [], stray: [], endpoints: [], configFiles: [], configKeys: [],
        };
        ev.errors = ['filesystem probe exited 125: no such image'];
        return ev;
    }

    test('a probe that did not run makes IMG-01 fail rather than pass', () => {
        const {report} = audit(noProbeEvidence());
        const c = byId(report, 'IMG-01');
        expect(c.status).toBe('fail');
        expect(c.severity).toBe('critical');
        expect(c.summary).toMatch(/NOT VERIFIED/);
    });

    test('the release gate exits non-zero, so a credential-bearing image cannot be published', () => {
        const {exitCode} = audit(noProbeEvidence(), ['--fail-on=critical']);
        expect(exitCode).toBe(1);
    });

    test('every probe-dependent check reports not-verified, not a pass', () => {
        const {report} = audit(noProbeEvidence());
        for (const id of ['IMG-01', 'CFG-04', 'FS-01', 'FS-02', 'FS-04', 'FS-05', 'APP-03']) {
            expect(byId(report, id).status).toBe('fail');
        }
    });

    test('a baseline covers[] cannot vacuously accept a not-verified failure', () => {
        // FS-01 and FS-03 both have covers[] entries in the shipped baseline. With no
        // items to compare against, a naive implementation marks them ACCEPTED.
        const {report} = audit(noProbeEvidence());
        expect(byId(report, 'FS-01').status).toBe('fail');
        expect(byId(report, 'FS-03').status).toBe('fail');
    });

    test('checks that do not depend on the probe still report normally', () => {
        const {report} = audit(noProbeEvidence());
        expect(byId(report, 'CFG-01').status).toBe('fail');   // reads inspect
        expect(byId(report, 'PRV-03').status).toBe('pass');   // reads Created
    });

    test('an incomplete collection exits non-zero even when no check breaches the threshold', () => {
        const ev = evidenceFixture();
        ev.errors = ['syft exited 1: out of disk'];
        const {exitCode, stderr} = audit(ev, ['--fail-on=critical']);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/this review is incomplete/);
    });

    test('a configuration file that exists but could not be read is never a pass', () => {
        // The precise false-pass shape: a mode-600 credential file in an image whose
        // declared user is not root. The file yields no keys, and no keys used to look
        // exactly like no credentials.
        const ev = evidenceFixture();
        ev.probe.configKeys = [];
        ev.probe.unreadableConfigFiles = ['/var/www/html/shared.env.php'];
        ev.probe.uid = 33;
        const {report, exitCode} = audit(ev, ['--fail-on=critical']);
        const c = byId(report, 'IMG-01');
        expect(c.status).toBe('fail');
        expect(c.severity).toBe('critical');
        expect(c.summary).toMatch(/NOT VERIFIED/);
        expect(c.items.map((i) => i.path)).toContain('/var/www/html/shared.env.php');
        expect(exitCode).toBe(1);
    });

    test('an unreadable file cannot be waved through by an accepted-risk declaration', () => {
        const ev = evidenceFixture();
        ev.probe.configKeys = [];
        ev.probe.unreadableConfigFiles = ['/var/www/html/shared.env.php'];
        expect(byId(audit(ev).report, 'IMG-01').notVerified).toBe(true);
    });

    test('a probe killed part-way through is not mistaken for a complete sweep', () => {
        // It emits plenty of records, so a record count alone would call it a success.
        const ev = evidenceFixture();
        ev.probeOk = false;
        ev.errors = ['filesystem probe did not run to completion (no completion record)'];
        const {report, exitCode} = audit(ev, ['--fail-on=critical']);
        expect(byId(report, 'IMG-01').status).toBe('fail');
        expect(exitCode).toBe(1);
    });

    test('a sweep made as a non-root UID is marked partial on every probe-dependent check', () => {
        const ev = evidenceFixture();
        ev.probeRanAsRoot = false;
        ev.probe.uid = 33;
        const {report, markdown} = audit(ev);
        expect(byId(report, 'FS-02').coverage).toBe('partial');
        expect(byId(report, 'FS-02').note).toMatch(/Partial coverage/);
        // A check that does not read the probe is unaffected.
        expect(byId(report, 'CFG-01').coverage).toBeUndefined();
        expect(markdown).toMatch(/Paths readable only by root were skipped/);
    });

    test('a complete root sweep carries no partial-coverage caveat', () => {
        const ev = evidenceFixture();
        ev.probeRanAsRoot = true;
        const {report} = audit(ev);
        expect(byId(report, 'FS-02').coverage).toBeUndefined();
    });

    test('the probe reports its own UID, readability and completion', () => {
        // These three records are what make the checks above possible; guard the shell.
        const script = fs.readFileSync(path.join(ROOT, 'scripts', 'auditContainerImage.mjs'), 'utf8');
        expect(script).toMatch(/printf "uid\\\\t%s\\\\n" "\$\(id -u\)"/);
        expect(script).toMatch(/if \[ ! -r "\$f" \]; then/);
        expect(script).toMatch(/configunreadable/);
        expect(script).toMatch(/printf "probecomplete/);
    });

    test('the probe is run as UID 0, because this inspects image contents', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts', 'auditContainerImage.mjs'), 'utf8');
        expect(script).toMatch(/probeArgs\(\["--user", "0"\]\)/);
    });

    test('archived evidence from before probeOk existed is judged by its content', () => {
        const ev = evidenceFixture();
        delete ev.probeOk;                    // older evidence file
        expect(audit(ev).report && byId(audit(ev).report, 'IMG-01').status).toBe('pass');
    });
});

describe('placeholder classification', () => {
    function verdictFor(value, key = 'MAPBOX_TOKEN') {
        // The probe classifies in-container; here we assert the report's reading of the
        // verdict it produces, which is what the checks act on.
        const ev = evidenceFixture();
        ev.probe.configKeys = [{file: '/f', key, length: value.length, verdict: value}];
        const {report} = audit(ev);
        return byId(report, 'IMG-01').status;
    }

    test('a set verdict is a finding and a placeholder verdict is not', () => {
        expect(verdictFor('set')).toBe('fail');
        expect(verdictFor('placeholder')).toBe('pass');
        expect(verdictFor('empty')).toBe('pass');
    });

    test('the in-image probe matches placeholders exactly, never by prefix', () => {
        // Guards the shell probe's case list: a prefix pattern like "example*" would
        // classify a real credential beginning "example..." as a placeholder.
        const script = fs.readFileSync(path.join(ROOT, 'scripts', 'auditContainerImage.mjs'), 'utf8');
        const caseList = /case "\$vu" in[\s\S]*?esac/.exec(script);
        expect(caseList).toBeTruthy();
        // No wildcard immediately after a word character in the placeholder alternatives.
        expect(caseList[0]).not.toMatch(/[A-Z_]\*/);
        expect(caseList[0]).toMatch(/EXAMPLEKEY/);
    });

    test('the probe trims keys and values the way injectEnv.php does', () => {
        // sitrecServer/injectEnv.php does trim($key) and trim($value) before putenv, so a
        // padded line is a LIVE setting and must not be skipped.
        const script = fs.readFileSync(path.join(ROOT, 'scripts', 'auditContainerImage.mjs'), 'utf8');
        expect(script).toMatch(/trimws\(\)/);
        expect(script).toMatch(/k=\$\(trimws "\$\{line%%=\*\}"\)/);
        expect(script).toMatch(/v=\$\(trimws "\$\{line#\*=\}"\)/);
    });
});

describe('credentials in the image config, not only in files', () => {
    test('an ENV credential baked into the image is found', () => {
        const ev = evidenceFixture();
        ev.envCredentials = [{key: 'OPENAI_API', file: 'image config (ENV)', length: 166, verdict: 'set'}];
        const {report} = audit(ev);
        const c = byId(report, 'IMG-01');
        expect(c.status).toBe('fail');
        expect(c.items.map((i) => i.key)).toContain('OPENAI_API');
    });

    test('an ENV placeholder is not a finding', () => {
        const ev = evidenceFixture();
        ev.envCredentials = [{key: 'OPENAI_API', file: 'image config (ENV)', length: 10, verdict: 'placeholder'}];
        expect(byId(audit(ev).report, 'IMG-01').status).toBe('pass');
    });
});

describe('the evidence bundle carries no secret', () => {
    // The evidence directory is uploaded as a build artifact and the documentation says it
    // can be circulated. That is only true if the redaction actually happens, and the
    // redactors run at collection time, which fixture mode skips - so exercise them
    // directly, in a child process, since Jest cannot import an .mjs here.
    //
    // The fake credentials below are deliberately NOT key-shaped. This tree ships in the
    // production bundle, and scripts/auditBundleSecrets.js --mode=server scans it and
    // aborts the deploy on a match - /sk-[A-Za-z0-9_-]{20,}/ for an OpenAI-style key, and
    // similar patterns for JWT, GitHub and Slack tokens. A realistic-looking fixture here
    // blocks a release, so keep these obviously fake rather than authentic.
    const {pathToFileURL} = require('url');

    function evalInScript(code) {
        const r = spawnSync(process.execPath, [
            '--input-type=module', '-e',
            `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n` +
            `console.log(JSON.stringify((${code})(m)));`,
        ], {encoding: 'utf8'});
        if (r.status !== 0) throw new Error(r.stderr);
        return JSON.parse(r.stdout);
    }

    test('a credential in Config.Env is redacted before the image config is archived', () => {
        const out = evalInScript(`(m) => m.redactInspect({Config: {Env: [
            "PATH=/usr/bin",
            "OPENAI_API=not-a-real-credential-xy",
            "PHP_VERSION=8.4.25"
        ]}})`);
        const env = out.Config.Env;
        expect(env).toContain('PATH=/usr/bin');
        expect(env).toContain('PHP_VERSION=8.4.25');
        expect(env.join(' ')).not.toMatch(/not-a-real-credential-xy/);
        expect(env.join(' ')).toMatch(/OPENAI_API=<redacted, 24 chars, set>/);
    });

    test('the credential is still classified, so the check can act on it', () => {
        const found = evalInScript(`(m) => m.envCredentials({Config: {Env: [
            "PATH=/usr/bin",
            "S3_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1"
        ]}})`);
        expect(found).toHaveLength(1);
        expect(found[0].key).toBe('S3_SECRET_ACCESS_KEY');
        expect(found[0].verdict).toBe('set');
        expect(JSON.stringify(found)).not.toMatch(/wJalrXUtnFEMIK/);
    });

    test('a credential inside a build command is redacted from the layer history', () => {
        const out = evalInScript(`(m) => m.redactHistory([
            {CreatedBy: "ENV ANTHROPIC_API=not-a-real-anthropic-value"},
            {CreatedBy: "RUN apt-get update && apt-get install -y curl"}
        ])`);
        expect(JSON.stringify(out)).not.toMatch(/not-a-real-anthropic-value/);
        expect(out[0].CreatedBy).toBe('ENV ANTHROPIC_API=<redacted>');
        expect(out[1].CreatedBy).toMatch(/apt-get install -y curl/);
    });

    test('placeholders are classified exactly, so a real key beginning "example" is not excused', () => {
        const verdicts = evalInScript(`(m) => [
            m.classifyValue("EXAMPLEKEY"),
            m.classifyValue("exampleKey"),
            m.classifyValue("example-live-key-9f3a2b"),
            m.classifyValue("xxx-real-credential"),
            m.classifyValue("<your-key>"),
            m.classifyValue("  "),
            m.classifyValue("live-value-1234")
        ]`);
        expect(verdicts).toEqual([
            'placeholder', 'placeholder', 'set', 'set', 'placeholder', 'empty', 'set',
        ]);
    });
});

describe('the credential name rule', () => {
    // The invariant is a SUPERSET one: the audit must never call a key harmless that a
    // build calls sensitive. Equality is deliberately not required - the audit also covers
    // server-only credentials, which never reach a bundle and so are not a build's concern.
    const {isSensitiveEnvKey} = require('../scripts/serverlessClientEnv');

    function auditFlags(key) {
        const ev = evidenceFixture();
        ev.probe.configKeys = [{file: '/f', key, length: 40, verdict: 'set'}];
        const {report} = audit(ev);
        return byId(report, 'IMG-01').status === 'fail';
    }

    const exampleKeys = [...new Set(
        fs.readFileSync(path.join(ROOT, 'config', 'shared.env.example'), 'utf8')
            .split('\n')
            .map((l) => /^([A-Za-z0-9_]+)=/.exec(l.trim()))
            .filter(Boolean)
            .map((m) => m[1])
    )];

    test('the example configuration defines keys the build calls sensitive', () => {
        // Guards the test below from silently passing on an empty set.
        expect(exampleKeys.filter(isSensitiveEnvKey).length).toBeGreaterThan(5);
    });

    test('every key the build calls sensitive is also treated as a credential here', () => {
        const missed = exampleKeys.filter((k) => isSensitiveEnvKey(k) && !auditFlags(k));
        expect(missed).toEqual([]);
    });

    test('server-only credentials that never reach a bundle are covered too', () => {
        for (const key of ['SPACEDATA_PASSWORD', 'ADSBX_RAPIDAPI_KEY', 'GOOGLE_MAPS_SERVER_API_KEY']) {
            expect(auditFlags(key)).toBe(true);
        }
    });

    test('an ordinary setting is not treated as a credential', () => {
        for (const key of ['BANNER_TOP_TEXT', 'DEFAULT_MAP_TYPE', 'MAX_FILE_SIZE_MB', 'S3_REGION']) {
            expect(auditFlags(key)).toBe(false);
        }
    });
});

describe('accepted risks narrow rather than silence', () => {
    test('the declared world-writable directories are accepted, and /var/www/html stays open', () => {
        const {report} = audit(evidenceFixture());
        const fs01 = byId(report, 'FS-01');
        // /tmp is covered by the baseline; /var/www/html deliberately is not.
        expect(fs01.status).toBe('fail');
        expect(fs01.items.map((i) => i.path)).toEqual(['/var/www/html']);
    });

    test('a NEW world-writable directory surfaces even though its neighbours are accepted', () => {
        const ev = evidenceFixture();
        ev.probe.worldWritableDirs = [
            {mode: 'drwxrwxrwt', path: '/tmp'},
            {mode: 'drwxrwxrwx', path: '/opt/unexpected'},
        ];
        const {report} = audit(ev);
        const fs01 = byId(report, 'FS-01');
        expect(fs01.status).toBe('fail');
        expect(fs01.items.map((i) => i.path)).toEqual(['/opt/unexpected']);
    });

    test('a check whose every item is declared becomes ACCEPTED, with its reason carried into the report', () => {
        const ev = evidenceFixture();
        ev.probe.worldWritableDirs = [{mode: 'drwxrwxrwt', path: '/tmp'}];
        const {report, markdown} = audit(ev);
        const fs01 = byId(report, 'FS-01');
        expect(fs01.status).toBe('accepted');
        expect(fs01.accepted.reason).toBeTruthy();
        expect(fs01.accepted.compensatingControl).toBeTruthy();
        // An accepted risk is still printed - it is explained, not hidden.
        expect(markdown).toMatch(/Declared accepted risk/);
    });

    test('an accepted risk is not an open finding', () => {
        const ev = evidenceFixture();
        ev.probe.worldWritableDirs = [{mode: 'drwxrwxrwt', path: '/tmp'}];
        const {report} = audit(ev);
        expect(report.results.filter((r) => r.status === 'accepted').length).toBeGreaterThan(0);
        expect(byId(report, 'FS-01').status).not.toBe('fail');
    });

    test('the shipped baseline states a reason and a compensating control for every entry', () => {
        const baseline = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'scripts', 'container-audit-baseline.json'), 'utf8')
        );
        const ids = Object.keys(baseline.acceptedRisks);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            expect(typeof baseline.acceptedRisks[id].reason).toBe('string');
            expect(baseline.acceptedRisks[id].reason.length).toBeGreaterThan(20);
            expect(typeof baseline.acceptedRisks[id].compensatingControl).toBe('string');
            expect(baseline.acceptedRisks[id].compensatingControl.length).toBeGreaterThan(20);
        }
    });

    test('a baseline entry missing its reason is rejected outright', () => {
        const dir = tmpDir('baseline-');
        const file = path.join(dir, 'baseline.json');
        fs.writeFileSync(file, JSON.stringify({acceptedRisks: {'FS-01': {covers: ['/tmp']}}}));
        const fixtureDir = tmpDir('evidence-');
        fs.writeFileSync(path.join(fixtureDir, 'evidence.json'), JSON.stringify(evidenceFixture()));
        const r = spawnSync(process.execPath, [
            SCRIPT, `--fixture=${fixtureDir}`, `--out=${tmpDir('report-')}`, `--baseline=${file}`, '--quiet',
        ], {encoding: 'utf8'});
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/must state both/);
    });
});

describe('vulnerability reporting', () => {
    test('fixable and unfixable advisories are counted separately', () => {
        const {report} = audit(evidenceFixture());
        expect(report.vulnerabilities.total).toBe(3);
        expect(report.vulnerabilities.fixable).toBe(1);
        expect(report.vulnerabilities.fixableBySeverity.HIGH).toBe(1);
        expect(report.vulnerabilities.fixableBySeverity.CRITICAL).toBeUndefined();
    });

    test('an unfixable critical does not fail the build, because a rebuild cannot close it', () => {
        // The fixture has one CRITICAL with no FixedVersion.
        const {report, exitCode} = audit(evidenceFixture(), ['--fail-on=critical']);
        expect(byId(report, 'IMG-03').status).toBe('warn');
        expect(exitCode).toBe(0);
    });

    test('a fixable critical is a failure, because rebuilding closes it', () => {
        const ev = evidenceFixture();
        ev.trivyVuln.Results[0].Vulnerabilities.push({
            VulnerabilityID: 'CVE-4', Severity: 'CRITICAL', PkgName: 'libqux',
            InstalledVersion: '1.0', FixedVersion: '1.2',
        });
        const {report} = audit(ev);
        expect(byId(report, 'IMG-03').status).toBe('fail');
    });

    test('the report explains why the two counts must not be added together', () => {
        const {markdown} = audit(evidenceFixture());
        expect(markdown).toMatch(/fixable count is the one that changes when the image is rebuilt/);
    });
});

describe('image configuration and provenance', () => {
    test('an image with no USER is reported as running as root', () => {
        const {report} = audit(evidenceFixture());
        expect(byId(report, 'CFG-01').status).toBe('fail');
    });

    test('an image that declares a non-root USER passes', () => {
        const ev = evidenceFixture();
        ev.inspect.Config.User = '33:33';
        const {report} = audit(ev);
        expect(byId(report, 'CFG-01').status).toBe('pass');
    });

    test('a floating base image tag is reported', () => {
        const {report} = audit(evidenceFixture());
        const prv = byId(report, 'PRV-01');
        expect(prv.status).toBe('warn');
        expect(prv.items.map((i) => i.ref)).toEqual(['composer:2', 'php:8.4-apache']);
    });

    test('base images pinned by digest pass', () => {
        const ev = evidenceFixture();
        ev.dockerfile.from = [{ref: 'php:8.4-apache@sha256:' + 'b'.repeat(64), stage: null}];
        const {report} = audit(ev);
        expect(byId(report, 'PRV-01').status).toBe('pass');
    });

    test('missing provenance labels are reported', () => {
        const {report} = audit(evidenceFixture());
        expect(byId(report, 'PRV-02').status).toBe('warn');
    });

    test('a declared privileged port is reported even when the app listens elsewhere', () => {
        const ev = evidenceFixture();
        ev.inspect.Config.ExposedPorts = {'80/tcp': {}, '8080/tcp': {}};
        const {report} = audit(ev);
        expect(byId(report, 'CFG-02').status).toBe('warn');
    });
});

describe('the derived runtime policy', () => {
    test('an image with no USER is told to supply one', () => {
        const {report, markdown} = audit(evidenceFixture());
        expect(report.policy.dockerFlags.join(' ')).toMatch(/--user 33:33/);
        expect(report.policy.k8s.join(' ')).toMatch(/runAsNonRoot: true/);
        expect(markdown).toMatch(/securityContext:/);
    });

    test('an image that already declares a non-root USER is not told to supply one', () => {
        const ev = evidenceFixture();
        ev.inspect.Config.User = '33:33';
        const {report} = audit(ev);
        expect(report.policy.dockerFlags.join(' ')).not.toMatch(/--user/);
    });

    test('capabilities are always dropped, since Apache on 8080 needs none', () => {
        const {report} = audit(evidenceFixture());
        expect(report.policy.dockerFlags.join(' ')).toMatch(/--cap-drop ALL/);
    });

    test('the webroot is never handed a tmpfs, which would hide the application', () => {
        const ev = evidenceFixture();
        ev.probe.worldWritableDirs = [
            {mode: 'drwxrwxrwt', path: '/tmp'},
            {mode: 'drwxrwxrwx', path: '/var/www/html'},
            {mode: 'drwxrwxrwx', path: '/var/www/html/sitrec-cache'},
        ];
        const {report} = audit(ev);
        const flags = report.policy.dockerFlags;
        expect(flags).toContain('--tmpfs /tmp');
        expect(flags).toContain('--tmpfs /var/www/html/sitrec-cache');
        expect(flags).not.toContain('--tmpfs /var/www/html');
        expect(report.policy.notes.join(' ')).toMatch(/would mount an empty directory on top of the application/);
    });

    test('--read-only is withheld while the entrypoint must rewrite the webroot', () => {
        // With a read-only root filesystem and no writable webroot the entrypoint fails at
        // start-up, so recommending the flag would hand over a command that does not run.
        const {report} = audit(evidenceFixture());
        expect(report.policy.dockerFlags).not.toContain('--read-only');
        expect(report.policy.k8s.join(' ')).not.toMatch(/readOnlyRootFilesystem/);
        expect(report.policy.notes.join(' ')).toMatch(/read-only root filesystem is NOT recommended/);
    });

    test('--read-only is recommended once the webroot is no longer writable', () => {
        const ev = evidenceFixture();
        ev.probe.worldWritableDirs = [{mode: 'drwxrwxrwt', path: '/tmp'}];
        const {report} = audit(ev);
        expect(report.policy.dockerFlags).toContain('--read-only');
        expect(report.policy.k8s.join(' ')).toMatch(/readOnlyRootFilesystem: true/);
    });

    test('the runnable command carries no inline comment that would swallow its continuation', () => {
        const {markdown} = audit(evidenceFixture());
        const block = /```\ndocker run \\\n([\s\S]*?)```/.exec(markdown);
        expect(block).toBeTruthy();
        expect(block[1]).not.toMatch(/#/);
    });
});

describe('the report itself', () => {
    test('it states which profile it was reviewed under', () => {
        expect(audit(evidenceFixture()).markdown).toMatch(/Reviewed as: Published image/);
        expect(audit(evidenceFixture(), ['--profile=site']).markdown).toMatch(/Reviewed as: Site image/);
    });

    test('it names what it does not cover, so the reader does not over-read it', () => {
        const {markdown} = audit(evidenceFixture());
        expect(markdown).toMatch(/does \*\*not\*\* assess/);
        expect(markdown).toMatch(/host operating system/);
    });

    test('a table renders every row, not just its header', () => {
        const {markdown} = audit(evidenceFixture());
        // The severity breakdown has one row per severity present in the evidence.
        expect(markdown).toMatch(/\| CRITICAL \| 1 \| 0 \| 1 \|/);
        expect(markdown).toMatch(/\| HIGH \| 1 \| 1 \| 0 \|/);
        expect(markdown).toMatch(/\| LOW \| 1 \| 0 \| 1 \|/);
        // As does a finding's own item table.
        expect(markdown).toMatch(/\| \/var\/www\/html \| drwxrwxrwx \| no \|/);
    });

    test('every check appears in the summary table', () => {
        const {report, markdown} = audit(evidenceFixture());
        for (const r of report.results) {
            expect(markdown).toContain(`| ${r.id} |`);
        }
    });

    test('an unknown profile is rejected rather than silently defaulted', () => {
        const fixtureDir = tmpDir('evidence-');
        fs.writeFileSync(path.join(fixtureDir, 'evidence.json'), JSON.stringify(evidenceFixture()));
        const r = spawnSync(process.execPath, [
            SCRIPT, `--fixture=${fixtureDir}`, '--profile=whatever', '--quiet',
        ], {encoding: 'utf8'});
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/--profile must be one of/);
    });
});
