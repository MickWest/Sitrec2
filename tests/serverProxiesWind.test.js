const {execFile, spawnSync} = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// windProxy.php starts tools/fetch_wind.py, which can hold a PHP worker for up to
// 100 s, on every cache miss. It used to do so for any 8-digit date and any level,
// with no rate limit and no cap on how many ran at once, so a burst of distinct
// requests could take every PHP worker.
const phpResult = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'});
const php = phpResult.status === 0 ? phpResult.stdout : null;
// The CLI sends no headers, so the Retry-After check needs the CGI binary. Without
// opcache it needs no lock file in /tmp, which a sandbox can refuse.
// A full path, because the requests run with a minimal PATH.
const CGI_ARGS = ['-d', 'opcache.enable=0'];
const cgiPath = spawnSync('sh', ['-c', 'command -v php-cgi'], {encoding: 'utf8'}).stdout.trim();
const phpCgi = cgiPath && spawnSync(cgiPath, [...CGI_ARGS, '-v'], {encoding: 'utf8'}).status === 0 ? cgiPath : null;

const CLIENT = '198.51.100.7';

// The status goes to stderr because the CLI sends no headers.
const REQUEST = '$_SERVER["REMOTE_ADDR"] = "198.51.100.7"; $_GET = json_decode($argv[2], true);' +
    ' register_shutdown_function(function () { fwrite(STDERR, (string)(http_response_code() ?: 200)); });' +
    ' require $argv[1];';

// The Python stand-in logs each start, then acts on STUB_MODE: "write" produces the
// grid windProxy asked for, "fail" exits at once, "slow" holds its slot for a while.
const STUB = `#!/bin/sh
echo "$@" >> "$STUB_LOG"
case "$STUB_MODE" in
write) level=$7; [ "$level" = surface ] && name=10m || name="\${level}hPa"
       printf '{"source":"stub","u":[1],"v":[2]}' > "$9/wind_$3_$(printf %02d "$5")z_$name.json" ;;
slow)  sleep 3; exit 1 ;;
*)     exit 1 ;;
esac
`;

function utcDate(offsetDays) {
    return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

(php ? describe : describe.skip)('windProxy.php limits', () => {
    let root;
    let script;
    let stubLog;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-wind-limits-'));
        for (const dir of ['sitrecServer', 'tools', 'tmp', 'home/.pyenv/shims']) {
            fs.mkdirSync(path.join(root, dir), {recursive: true});
        }
        script = path.join(root, 'sitrecServer/windProxy.php');
        for (const file of ['windProxy.php', 'rate_limit.php']) {
            fs.copyFileSync(path.join(__dirname, '../sitrecServer', file), path.join(root, 'sitrecServer', file));
        }
        fs.writeFileSync(path.join(root, 'tools/fetch_wind.py'), '# fixture\n');
        // First on windProxy's search path, ahead of any real python3.
        fs.writeFileSync(path.join(root, 'home/.pyenv/shims/python3'), STUB, {mode: 0o755});
        stubLog = path.join(root, 'stub.log');
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    function options(mode) {
        return {
            encoding: 'utf8', timeout: 15000,
            // TMPDIR keeps the rate-limit counters and fetch slots in the fixture.
            env: {...process.env, HOME: path.join(root, 'home'), PATH: '/usr/bin:/bin',
                TMPDIR: path.join(root, 'tmp'), STUB_MODE: mode, STUB_LOG: stubLog},
        };
    }

    function request(query, mode = 'fail') {
        const result = spawnSync(php, ['-r', REQUEST, script, JSON.stringify(query)], options(mode));
        return {status: Number(result.stderr), body: JSON.parse(result.stdout)};
    }

    function requestAsync(query, mode) {
        return new Promise((resolve) => {
            execFile(php, ['-r', REQUEST, script, JSON.stringify(query)], options(mode),
                (error, stdout, stderr) => resolve({status: Number(stderr), body: JSON.parse(stdout)}));
        });
    }

    function cgiRequest(query, mode = 'fail') {
        const base = options(mode);
        const result = spawnSync(phpCgi, CGI_ARGS, {
            ...base,
            env: {...base.env, REDIRECT_STATUS: '1', REQUEST_METHOD: 'GET', REMOTE_ADDR: CLIENT,
                SCRIPT_FILENAME: script, QUERY_STRING: new URLSearchParams(query).toString()},
        });
        const [head, ...rest] = result.stdout.split(/\r?\n\r?\n/);
        const headers = {};
        for (const line of head.split(/\r?\n/)) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        return {status: Number((headers.status || '200').split(' ')[0]), headers, body: JSON.parse(rest.join('\n\n'))};
    }

    // The client's wind bucket with `count` tokens spent and `secondsLeft` until it refills.
    function seedBucket(count, secondsLeft) {
        const dir = path.join(root, 'tmp/sitrec_wind_ratelimit');
        fs.mkdirSync(dir, {recursive: true});
        const name = crypto.createHash('md5').update(CLIENT).digest('hex');
        fs.writeFileSync(path.join(dir, `${name}.json`),
            JSON.stringify({count, reset: Math.floor(Date.now() / 1000) + secondsLeft}));
    }

    const fetchCount = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').trim().split('\n').length : 0);

    test('fetches and returns a grid for a valid request', () => {
        const result = request({date: '20250919', hour: 18, level: '500'}, 'write');
        expect(result).toEqual({status: 200, body: {source: 'stub', u: [1], v: [2]}});
        expect(fs.readFileSync(stubLog, 'utf8').trim()).toMatch(/--date 20250919 --hour 18 --level 500 --output /);
    });

    test('refuses levels fetch_wind.py does not support without starting Python', () => {
        for (const level of ['123', 'abc', '0', '1000hpa']) {
            expect(request({date: '20250919', hour: 0, level})).toEqual({status: 400, body: {error: 'Invalid level'}});
        }
        expect(fetchCount()).toBe(0);
    });

    test('refuses dates outside the GFS archive, and impossible dates, without starting Python', () => {
        for (const date of ['20210321', '19990101', '00000000', '20230231', '20231301', utcDate(2), '99991231']) {
            const result = request({date, hour: 0, level: 'surface'});
            expect(result.status).toBe(400);
            expect(result.body.error).toMatch(/Date out of range/);
        }
        expect(fetchCount()).toBe(0);
        // The first archived day, today and tomorrow (for clock skew) are all fetched.
        for (const date of ['20210322', utcDate(0), utcDate(1)]) {
            expect(request({date, hour: 12, level: 'surface'}, 'write').status).toBe(200);
        }
        expect(fetchCount()).toBe(3);
    });

    test('limits cache misses per address, but never cache hits', () => {
        const cacheDir = path.join(root, 'data/wind');
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(path.join(cacheDir, 'wind_20250919_00z_10m.json'), '{"source":"cached"}');
        for (let i = 0; i < 45; i++) {
            expect(request({date: '20250919', hour: 0, level: 'surface'}).body).toEqual({source: 'cached'});
        }
        expect(fetchCount()).toBe(0);
        // Each miss fails upstream (502), and each one spends a token.
        for (let i = 0; i < 120; i++) {
            expect(request({date: '20250919', hour: 0, level: '850'}).status).toBe(502);
        }
        const refused = request({date: '20250919', hour: 0, level: '850'});
        expect(refused.status).toBe(429);
        expect(refused.body.error).toMatch(/Too many wind data requests/);
        expect(fetchCount()).toBe(120);
        // Cached data is still served to the same address.
        expect(request({date: '20250919', hour: 0, level: 'surface'}).body).toEqual({source: 'cached'});
    }, 120000);

    test('runs at most four fetches at once and answers 503 while all are busy', async () => {
        const levels = ['1000', '925', '850', '700'];
        const running = levels.map((level) => requestAsync({date: '20250919', hour: 0, level}, 'slow'));
        const start = Date.now();
        while (fetchCount() < 4 && Date.now() - start < 10000) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(fetchCount()).toBe(4);

        const busy = request({date: '20250919', hour: 0, level: '500'}, 'slow');
        expect(busy).toEqual({status: 503, body: {error: 'Wind data fetcher is busy; please retry'}});
        expect(fetchCount()).toBe(4);

        for (const result of await Promise.all(running)) {
            expect(result.status).toBe(502);
        }
        // The finished fetches gave their slots back.
        expect(request({date: '20250919', hour: 0, level: '500'}, 'write').status).toBe(200);
        expect(fetchCount()).toBe(5);
    }, 30000);

    test('a request that finds every slot busy spends no token', async () => {
        // In production every visitor shares one address, so a flood of 503s must not
        // empty the budget. Five misses are left.
        seedBucket(115, 600);
        const levels = ['1000', '925', '850', '700'];
        const running = levels.map((level) => requestAsync({date: '20250919', hour: 0, level}, 'slow'));
        const start = Date.now();
        while (fetchCount() < 4 && Date.now() - start < 10000) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(fetchCount()).toBe(4);

        for (let i = 0; i < 3; i++) {
            expect(request({date: '20250919', hour: 0, level: '500'}, 'slow'))
                .toEqual({status: 503, body: {error: 'Wind data fetcher is busy; please retry'}});
        }
        for (const result of await Promise.all(running)) {
            expect(result.status).toBe(502);
        }
        // The fifth miss still has its token...
        expect(request({date: '20250919', hour: 0, level: '500'}, 'write').status).toBe(200);
        // ...and then the budget is empty.
        expect(request({date: '20250919', hour: 0, level: '300'}, 'write').status).toBe(429);
        expect(fetchCount()).toBe(5);
    }, 30000);

    (phpCgi ? test : test.skip)('a 429 gives the time left in the window as Retry-After', () => {
        seedBucket(120, 250);
        const refused = cgiRequest({date: '20250919', hour: 0, level: '850'});
        expect(refused.status).toBe(429);
        expect(refused.body.error).toMatch(/Too many wind data requests/);
        expect(Math.abs(Number(refused.headers['retry-after']) - 250)).toBeLessThanOrEqual(1);
        expect(fetchCount()).toBe(0);
    });

    test('gives its fetch slot back before it answers', () => {
        // The shutdown function runs while the request's own handles are still open,
        // so a slot that was never released still shows as locked there.
        const probe = '$_SERVER["REMOTE_ADDR"] = "198.51.100.7"; $_GET = json_decode($argv[2], true);' +
            ' register_shutdown_function(function () { $held = 0;' +
            ' foreach (glob(sys_get_temp_dir() . "/sitrec_wind_fetch_slots/slot*.lock") as $file) {' +
            ' $fh = fopen($file, "c"); if (flock($fh, LOCK_EX | LOCK_NB)) flock($fh, LOCK_UN); else $held++;' +
            ' fclose($fh); }' +
            ' fwrite(STDERR, (http_response_code() ?: 200) . " " . $held); });' +
            ' require $argv[1];';
        const run = (level, mode) => spawnSync(php, ['-r', probe, script,
            JSON.stringify({date: '20250919', hour: 0, level})], options(mode)).stderr;
        expect(run('850', 'write')).toBe('200 0');
        expect(run('700', 'fail')).toBe('502 0');
        seedBucket(120, 600);
        expect(run('500', 'write')).toBe('429 0');
    });
});
