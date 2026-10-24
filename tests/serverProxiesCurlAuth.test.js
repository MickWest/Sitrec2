const {execFile, spawnSync} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// curlGetRequest() used to copy the browser's Authorization header onto every
// upstream request. Its callers all fetch third-party hosts, so a site behind HTTP
// Basic auth sent its password to CelesTrak, adsb.lol, SondeHub and the rest.
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

(canRun ? describe : describe.skip)('curlGetRequest upstream headers', () => {
    let dir;
    let server;
    let port;
    let seen;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-curlauth-'));
        fs.writeFileSync(path.join(dir, 'harness.php'), HARNESS);
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
    function fetchThroughHelper(extraHeaders) {
        const env = {...process.env, NO_PROXY: '*', no_proxy: '*'};
        for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY',
            'AUTH_MODE', 'AUDIT_LOG_ENABLED']) {
            delete env[name];
        }
        return new Promise((resolve, reject) => {
            execFile('php', ['-d', 'display_errors=stderr', path.join(dir, 'harness.php'), SERVER_DIR,
                `http://127.0.0.1:${port}/feed`, JSON.stringify(extraHeaders)],
            {encoding: 'utf8', timeout: 10000, env},
            (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))));
        });
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
});
