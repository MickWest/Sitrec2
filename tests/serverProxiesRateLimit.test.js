const {execFile, spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// sitrecServer/rate_limit.php, and the two proxies that used to key their limit on
// CF-Connecting-IP / X-Forwarded-For with an unlocked read-increment-write: a caller
// could pick a fresh bucket per request, or win the race with parallel requests, and
// spend proxyADSBx.php's paid API key without limit.
const phpResult = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'});
const php = phpResult.status === 0 ? phpResult.stdout : null;

// Runs a script as a GET from remoteAddr, with forwarding headers naming forwardedIP.
// The status goes to stderr because the CLI sends no headers.
const REQUEST = '$_SERVER["REQUEST_METHOD"] = "GET"; $_SERVER["REMOTE_ADDR"] = $argv[2];' +
    ' $_SERVER["HTTP_X_FORWARDED_FOR"] = $argv[3]; $_SERVER["HTTP_CF_CONNECTING_IP"] = $argv[3];' +
    ' register_shutdown_function(function () { fwrite(STDERR, (string)(http_response_code() ?: 200)); });' +
    ' require $argv[1];';

(php ? describe : describe.skip)('per-IP rate limiting in the proxies', () => {
    let root;
    let env;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-ratelimit-'));
        for (const dir of ['sitrecServer', 'tmp']) {
            fs.mkdirSync(path.join(root, dir));
        }
        for (const file of ['rate_limit.php', 'proxyADSBx.php', 'proxyFlySFO.php']) {
            fs.copyFileSync(path.join(__dirname, '../sitrecServer', file), path.join(root, 'sitrecServer', file));
        }
        fs.writeFileSync(path.join(root, 'sitrecServer/config.php'), '<?php\n');
        // sys_get_temp_dir() follows TMPDIR, which keeps the counters in the fixture.
        env = {...process.env, TMPDIR: path.join(root, 'tmp')};
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    function request(script, remoteAddr, forwardedIP) {
        const result = spawnSync(php, ['-r', REQUEST, path.join(root, 'sitrecServer', script),
            remoteAddr, forwardedIP], {encoding: 'utf8', timeout: 10000, env});
        return {status: Number(result.stderr), body: result.stdout};
    }

    test('parallel requests from one address get no more than the limit between them', async () => {
        const code = '$_SERVER["REMOTE_ADDR"] = "203.0.113.5"; require $argv[1];' +
            ' echo sitrecConsumeRateToken("parallel", 5) ? "granted" : "refused";';
        const runs = Array.from({length: 12}, () => new Promise((resolve, reject) => {
            execFile(php, ['-r', code, path.join(root, 'sitrecServer/rate_limit.php')],
                {encoding: 'utf8', timeout: 10000, env},
                (error, stdout) => (error ? reject(error) : resolve(stdout)));
        }));
        const outcomes = await Promise.all(runs);
        expect(outcomes.filter((o) => o === 'granted')).toHaveLength(5);
        expect(outcomes.filter((o) => o === 'refused')).toHaveLength(7);
    });

    test('a bucket refills once its window has passed', () => {
        const code = '$_SERVER["REMOTE_ADDR"] = "203.0.113.5"; require $argv[1];' +
            ' $take = function () { return sitrecConsumeRateToken("window", 1, 1) ? "y" : "n"; };' +
            ' echo $take(), $take(); sleep(2); echo $take();';
        const result = spawnSync(php, ['-r', code, path.join(root, 'sitrecServer/rate_limit.php')],
            {encoding: 'utf8', timeout: 10000, env});
        expect(result.stdout).toBe('yny');
    });

    test('proxyADSBx.php ignores forwarding headers when choosing the bucket', () => {
        // No lat/lon/dist, so every granted request stops at the 400 before any upstream call.
        for (let i = 0; i < 10; i++) {
            expect(request('proxyADSBx.php', '198.51.100.7', `10.0.0.${i}`).status).toBe(400);
        }
        const refused = request('proxyADSBx.php', '198.51.100.7', '10.0.0.99');
        expect(refused.status).toBe(429);
        expect(JSON.parse(refused.body).error).toMatch(/Rate limit exceeded/);
        // Another address still has its own bucket.
        expect(request('proxyADSBx.php', '198.51.100.8', '10.0.0.99').status).toBe(400);
    });

    test('proxyFlySFO.php ignores forwarding headers when choosing the bucket', () => {
        // A fresh cached board, so granted requests never reach flysfo.com.
        const cacheDir = path.join(root, 'tmp/sitrec_flysfo_cache');
        fs.mkdirSync(cacheDir);
        fs.writeFileSync(path.join(cacheDir, 'flight-status.json'), '{"flights":[]}');
        for (let i = 0; i < 20; i++) {
            const served = request('proxyFlySFO.php', '198.51.100.7', `10.0.0.${i}`);
            expect(served.status).toBe(200);
            expect(served.body).toBe('{"flights":[]}');
        }
        const refused = request('proxyFlySFO.php', '198.51.100.7', '10.0.0.99');
        expect(refused.status).toBe(429);
        expect(JSON.parse(refused.body)).toEqual({error: 'Rate limit exceeded'});
        expect(request('proxyFlySFO.php', '198.51.100.8', '10.0.0.99').status).toBe(200);
    });
});
