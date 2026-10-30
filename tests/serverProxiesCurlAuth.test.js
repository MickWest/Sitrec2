const {execFile, spawnSync} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// curlGetRequest() used to copy the browser's Authorization header onto every
// upstream request, so a site behind HTTP Basic auth sent its password to CelesTrak,
// adsb.lol, SondeHub and the rest. A source the operator configured still needs that
// header, so those callers ask for it with curlConfiguredSourceHeaders().
//
// This file is what holds SR-17 in docs/dev/SecurityRequirements.md, and both halves
// matter: 2.183.6 closed the leak by removing all forwarding, which broke a configured
// source. Do not relax a test here without withdrawing SR-17 in writing.
const SERVER_DIR = path.resolve(__dirname, '..', 'sitrecServer');

const phpCheck = spawnSync('php', ['-r', 'echo extension_loaded("curl") ? "ok" : "no";'], {encoding: 'utf8'});
const canRun = phpCheck.status === 0 && phpCheck.stdout === 'ok';

// getallheaders() returns what mod_php would for a browser inside a Basic auth realm.
const HARNESS = `<?php
function getallheaders() {
    return ['Authorization' => 'Basic c2l0ZTpzZWNyZXQ=', 'User-Agent' => 'BrowserAgent'];
}
$_SERVER['HTTP_AUTHORIZATION'] = 'Basic c2l0ZTpzZWNyZXQ=';
require_once $argv[1] . '/curlGetRequest.php';
echo json_encode(curlGetRequest($argv[2], json_decode($argv[3], true), 5));
`;

// As a configured-source proxy calls it. argv[3] is what the browser sent; with
// argv[4] the harness prints the chosen headers and makes no request.
const CONFIGURED_HARNESS = `<?php
function getallheaders() {
    return json_decode($GLOBALS['argv'][3], true);
}
require_once $argv[1] . '/curlGetRequest.php';
if (($argv[4] ?? '') === 'headersOnly') {
    echo json_encode(curlConfiguredSourceHeaders($argv[2]));
    exit;
}
echo json_encode(curlGetRequest($argv[2], curlConfiguredSourceHeaders($argv[2]), 5));
`;

(canRun ? describe : describe.skip)('curlGetRequest upstream headers', () => {
    let dir;
    let server;
    let port;
    let seen;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-curlauth-'));
        fs.writeFileSync(path.join(dir, 'harness.php'), HARNESS);
        fs.writeFileSync(path.join(dir, 'configured.php'), CONFIGURED_HARNESS);
        server = http.createServer((req, res) => {
            seen.push(req.headers);
            res.end('upstream body');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, {recursive: true, force: true});
    });

    beforeEach(() => {
        seen = [];
    });

    // Asynchronous, so this process's listener can answer while PHP waits.
    function runPhp(harness, args) {
        const env = {...process.env, NO_PROXY: '*', no_proxy: '*'};
        for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY',
            'AUTH_MODE', 'AUDIT_LOG_ENABLED']) {
            delete env[name];
        }
        return new Promise((resolve, reject) => {
            execFile('php', ['-d', 'display_errors=stderr', path.join(dir, harness), SERVER_DIR, ...args],
            {encoding: 'utf8', timeout: 10000, env},
            (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))));
        });
    }

    function fetchThroughHelper(extraHeaders) {
        return runPhp('harness.php', [`http://127.0.0.1:${port}/feed`, JSON.stringify(extraHeaders)]);
    }

    function fetchConfiguredSource(browserHeaders) {
        return runPhp('configured.php', [`http://127.0.0.1:${port}/feed`, JSON.stringify(browserHeaders)]);
    }

    function configuredHeadersFor(url, browserHeaders) {
        return runPhp('configured.php', [url, JSON.stringify(browserHeaders), 'headersOnly']);
    }

    test("does not forward the caller's Authorization header", async () => {
        const result = await fetchThroughHelper([]);
        expect(result).toEqual({data: 'upstream body', http_status: 200});
        expect(seen).toHaveLength(1);
        expect(seen[0].authorization).toBeUndefined();
    });

    test("sends the caller's own extra headers, and only those", async () => {
        const result = await fetchThroughHelper(['User-Agent: Sitrec-test/1.0', 'Accept: application/json']);
        expect(result.http_status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]['user-agent']).toBe('Sitrec-test/1.0');
        expect(seen[0].accept).toBe('application/json');
        expect(seen[0].authorization).toBeUndefined();
    });

    test("a configured source receives the browser's Authorization header", async () => {
        const result = await fetchConfiguredSource({Authorization: 'Bearer token-from-browser'});
        expect(result).toEqual({data: 'upstream body', http_status: 200});
        expect(seen).toHaveLength(1);
        expect(seen[0].authorization).toBe('Bearer token-from-browser');
    });

    test('a configured source finds the header whatever the case of its name', async () => {
        const result = await fetchConfiguredSource({authorization: 'Basic c2l0ZTpzZWNyZXQ='});
        expect(result.http_status).toBe(200);
        expect(seen[0].authorization).toBe('Basic c2l0ZTpzZWNyZXQ=');
    });

    test('a configured source gets no header when the browser sent none', async () => {
        expect(await configuredHeadersFor('https://tle.example.test/feed', {'User-Agent': 'BrowserAgent'})).toEqual([]);
    });

    test('CelesTrak never receives it, as it is the default and sample value of these settings', async () => {
        const browser = {Authorization: 'Basic c2l0ZTpzZWNyZXQ='};
        expect(await configuredHeadersFor('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv', browser)).toEqual([]);
        expect(await configuredHeadersFor('https://CelesTrak.org/feed', browser)).toEqual([]);
    });
});

describe('which proxies forward the Authorization header', () => {
    const source = (file) => fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');

    test.each(['proxyStarlink.php', 'customWindProxy.php', 'proxy.php'])(
        '%s fetches a configured source with it', (file) => {
            expect(source(file)).toMatch(/curlGetRequest\(\$url, curlConfiguredSourceHeaders\(\$url\)/);
        });

    test.each(['proxyADSBLive.php', 'proxyADSBTrace.php', 'proxyLiveFeed.php', 'proxySounding.php'])(
        '%s fetches a fixed public host without it', (file) => {
            expect(source(file)).not.toContain('curlConfiguredSourceHeaders');
        });
});
