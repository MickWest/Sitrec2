const {execFile, spawnSync} = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// sitrecServer/rate_limit.php, and the two proxies that used to key their limit on
// CF-Connecting-IP / X-Forwarded-For with an unlocked read-increment-write: a caller
// could pick a fresh bucket per request, or win the race with parallel requests, and
// spend proxyADSBx.php's paid API key without limit.
const phpResult = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'});
const php = phpResult.status === 0 ? phpResult.stdout : null;
// The CLI sends no headers, so the Retry-After checks need the CGI binary. Without
// opcache it needs no lock file in /tmp, which a sandbox can refuse.
const CGI_ARGS = ['-d', 'opcache.enable=0'];
const phpCgi = spawnSync('php-cgi', [...CGI_ARGS, '-v'], {encoding: 'utf8'}).status === 0 ? 'php-cgi' : null;

// Runs a script as a GET from remoteAddr, with forwarding headers naming forwardedIP.
// The status goes to stderr because the CLI sends no headers.
const REQUEST = '$_SERVER["REQUEST_METHOD"] = "GET"; $_SERVER["REMOTE_ADDR"] = $argv[2];' +
    ' $_SERVER["HTTP_X_FORWARDED_FOR"] = $argv[3]; $_SERVER["HTTP_CF_CONNECTING_IP"] = $argv[3];' +
    ' $_GET = json_decode($argv[4], true) ?: [];' +
    ' register_shutdown_function(function () { fwrite(STDERR, (string)(http_response_code() ?: 200)); });' +
    ' require $argv[1];';

const AIRPORT = {lat: '33.94', lon: '-118.41', dist: '30'};
const OTHER_AIRPORT = {lat: '37.62', lon: '-122.38', dist: '30'};
const PROXY_ENV = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];

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
        // No key, so an ADSBx miss stops at the 503 after the token check. A dead proxy,
        // so a FlySFO miss fails at once instead of reaching flysfo.com.
        delete env.ADSBX_RAPIDAPI_KEY;
        delete env.NO_PROXY;
        delete env.no_proxy;
        for (const name of PROXY_ENV) env[name] = 'http://127.0.0.1:9';
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    function request(script, remoteAddr, forwardedIP, query = {}) {
        const result = spawnSync(php, ['-r', REQUEST, path.join(root, 'sitrecServer', script),
            remoteAddr, forwardedIP, JSON.stringify(query)], {encoding: 'utf8', timeout: 10000, env});
        return {status: Number(result.stderr), body: result.stdout};
    }

    function cgiRequest(script, remoteAddr, query = {}) {
        const result = spawnSync(phpCgi, CGI_ARGS, {
            encoding: 'utf8', timeout: 10000,
            env: {...env, REDIRECT_STATUS: '1', REQUEST_METHOD: 'GET', REMOTE_ADDR: remoteAddr,
                SCRIPT_FILENAME: path.join(root, 'sitrecServer', script),
                QUERY_STRING: new URLSearchParams(query).toString()},
        });
        const [head, ...rest] = result.stdout.split(/\r?\n\r?\n/);
        const headers = {};
        for (const line of head.split(/\r?\n/)) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        return {status: Number((headers.status || '200').split(' ')[0]), headers, body: rest.join('\n\n')};
    }

    // An address's bucket with `count` tokens spent and `secondsLeft` until it refills.
    function seedBucket(bucket, remoteAddr, count, secondsLeft) {
        const dir = path.join(root, `tmp/sitrec_${bucket}_ratelimit`);
        fs.mkdirSync(dir, {recursive: true});
        const reset = Math.floor(Date.now() / 1000) + secondsLeft;
        const name = crypto.createHash('md5').update(remoteAddr).digest('hex');
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({count, reset}));
        return reset;
    }

    function writeADSBxCache({lat, lon, dist}, body) {
        const dir = path.join(root, 'tmp/sitrec_adsbx_cache');
        fs.mkdirSync(dir, {recursive: true});
        // proxyADSBx.php's key: sprintf("%.2f_%.2f_%d", lat, lon, dist).
        const key = `${Number(lat).toFixed(2)}_${Number(lon).toFixed(2)}_${Number(dist)}`;
        fs.writeFileSync(path.join(dir, crypto.createHash('md5').update(key).digest('hex') + '.json'), body);
    }

    function writeFlySFOCache(body) {
        const dir = path.join(root, 'tmp/sitrec_flysfo_cache');
        fs.mkdirSync(dir, {recursive: true});
        const file = path.join(dir, 'flight-status.json');
        fs.writeFileSync(file, body);
        return file;
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
            ' $take = function () { return sitrecConsumeRateToken("window", 1, 2) ? "y" : "n"; };' +
            ' echo $take(), $take(); sleep(3); echo $take();';
        const result = spawnSync(php, ['-r', code, path.join(root, 'sitrecServer/rate_limit.php')],
            {encoding: 'utf8', timeout: 10000, env});
        expect(result.stdout).toBe('yny');
    });

    test('reports when the window resets, and a caller that waits until then gets a token', () => {
        const code = '$_SERVER["REMOTE_ADDR"] = "203.0.113.5"; require $argv[1];' +
            ' $start = time(); $out = [];' +
            ' $out[] = [sitrecConsumeRateToken("reset", 1, 2, $r), $r - $start];' +
            ' $out[] = [sitrecConsumeRateToken("reset", 1, 2, $r2), $r2 - $start];' +
            ' while (time() < $r) usleep(20000);' +
            ' $out[] = [sitrecConsumeRateToken("reset", 1, 2, $r3), $r3 - $r];' +
            ' echo json_encode($out);';
        const result = spawnSync(php, ['-r', code, path.join(root, 'sitrecServer/rate_limit.php')],
            {encoding: 'utf8', timeout: 10000, env});
        const [granted, refused, afterWait] = JSON.parse(result.stdout);
        // The window ends 2 s after its first token (3 s if the clock ticked before it).
        expect(granted[0]).toBe(true);
        expect([2, 3]).toContain(granted[1]);
        expect(refused).toEqual([false, granted[1]]);
        // At the reported time the bucket has refilled, and a new window starts.
        expect(afterWait[0]).toBe(true);
        expect([2, 3]).toContain(afterWait[1]);
    });

    test('proxyADSBx.php ignores forwarding headers when choosing the bucket', () => {
        // Every granted request misses the cache and stops at the missing key.
        for (let i = 0; i < 10; i++) {
            expect(request('proxyADSBx.php', '198.51.100.7', `10.0.0.${i}`, AIRPORT).status).toBe(503);
        }
        const refused = request('proxyADSBx.php', '198.51.100.7', '10.0.0.99', AIRPORT);
        expect(refused.status).toBe(429);
        expect(JSON.parse(refused.body).error).toMatch(/Rate limit exceeded/);
        // Another address still has its own bucket.
        expect(request('proxyADSBx.php', '198.51.100.8', '10.0.0.99', AIRPORT).status).toBe(503);
    });

    test('proxyADSBx.php answers a cached airport without spending a token', () => {
        // In production every visitor shares one address, so a spent token is spent for the site.
        writeADSBxCache(AIRPORT, '{"ac":[]}');
        for (let i = 0; i < 15; i++) {
            expect(request('proxyADSBx.php', '198.51.100.7', '10.0.0.1', AIRPORT))
                .toEqual({status: 200, body: '{"ac":[]}'});
        }
        // Misses still spend all 10 tokens...
        for (let i = 0; i < 10; i++) {
            expect(request('proxyADSBx.php', '198.51.100.7', '10.0.0.1', OTHER_AIRPORT).status).toBe(503);
        }
        expect(request('proxyADSBx.php', '198.51.100.7', '10.0.0.1', OTHER_AIRPORT).status).toBe(429);
        // ...and the cached airport is still served from the empty bucket.
        expect(request('proxyADSBx.php', '198.51.100.7', '10.0.0.1', AIRPORT))
            .toEqual({status: 200, body: '{"ac":[]}'});
        // Requests refused before the cache (bad parameters) spend nothing either:
        // that address still has all 10 tokens afterwards.
        expect(request('proxyADSBx.php', '198.51.100.8', '10.0.0.1').status).toBe(400);
        for (let i = 0; i < 10; i++) {
            expect(request('proxyADSBx.php', '198.51.100.8', '10.0.0.1', OTHER_AIRPORT).status).toBe(503);
        }
        expect(request('proxyADSBx.php', '198.51.100.8', '10.0.0.1', OTHER_AIRPORT).status).toBe(429);
    });

    test('proxyFlySFO.php ignores forwarding headers when choosing the bucket', () => {
        // No cached board, and upstream fails, so each granted request is a 502.
        for (let i = 0; i < 20; i++) {
            expect(request('proxyFlySFO.php', '198.51.100.7', `10.0.0.${i}`).status).toBe(502);
        }
        const refused = request('proxyFlySFO.php', '198.51.100.7', '10.0.0.99');
        expect(refused.status).toBe(429);
        expect(JSON.parse(refused.body)).toEqual({error: 'Rate limit exceeded'});
        expect(request('proxyFlySFO.php', '198.51.100.8', '10.0.0.99').status).toBe(502);
    });

    test('proxyFlySFO.php answers from a fresh cache without spending a token', () => {
        const cacheFile = writeFlySFOCache('{"flights":[]}');
        for (let i = 0; i < 25; i++) {
            expect(request('proxyFlySFO.php', '198.51.100.7', '10.0.0.1'))
                .toEqual({status: 200, body: '{"flights":[]}'});
        }
        // Once the board is stale every request goes upstream and spends a token. Upstream
        // fails here, so the stale board is served until the bucket is empty.
        const stale = Date.now() / 1000 - 600;
        fs.utimesSync(cacheFile, stale, stale);
        for (let i = 0; i < 20; i++) {
            expect(request('proxyFlySFO.php', '198.51.100.7', '10.0.0.1'))
                .toEqual({status: 200, body: '{"flights":[]}'});
        }
        expect(request('proxyFlySFO.php', '198.51.100.7', '10.0.0.1').status).toBe(429);
    });

    (phpCgi ? test : test.skip)('the 429s give the time left in the window as Retry-After', () => {
        seedBucket('adsbx', '198.51.100.7', 10, 37);
        const adsbx = cgiRequest('proxyADSBx.php', '198.51.100.7', AIRPORT);
        expect(adsbx.status).toBe(429);
        expect(JSON.parse(adsbx.body).error).toMatch(/Rate limit exceeded/);
        expect(Math.abs(Number(adsbx.headers['retry-after']) - 37)).toBeLessThanOrEqual(1);

        seedBucket('flysfo', '198.51.100.7', 20, 52);
        const flysfo = cgiRequest('proxyFlySFO.php', '198.51.100.7');
        expect(flysfo.status).toBe(429);
        expect(Math.abs(Number(flysfo.headers['retry-after']) - 52)).toBeLessThanOrEqual(1);
    });
});
