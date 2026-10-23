/**
 * Tests for the time limits in sitrecServer/curlGetRequest.php.
 *
 * curlGetRequest() used to wait forever unless a caller passed a timeout, so a
 * stalled upstream held a PHP worker for the life of the request; a handful of
 * them took the whole PHP backend down. It now always applies a limit.
 *
 * PHP is driven as a child process through a small harness written to a temp
 * directory. The file skips cleanly when php (with its cURL extension) is not on PATH.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..", "sitrecServer");

const phpCheck = spawnSync("php", ["-r", 'echo extension_loaded("curl") ? "ok" : "no";'], { encoding: "utf8" });
const canRun = phpCheck.status === 0 && phpCheck.stdout === "ok";

// Mode "limits" prints curlGetTimeouts() for each named argument, plus the value
// with no argument at all. Mode "silent" sets a 1-second default, then calls
// curlGetRequest() with no timeout against a listener that never answers. Mode
// "silentOverride" keeps the 20-second default and passes a 1-second timeout instead.
const HARNESS = `<?php
// curlGetRequest() forwards the caller's Authorization header through
// getallheaders(), which PHP's CLI does not define.
function getallheaders() { return []; }
$mode = $argv[2];
if ($mode === 'silent') {
    define('CURL_GET_DEFAULT_TIMEOUT_SEC', 1);
}
require_once $argv[1] . '/curlGetRequest.php';
if ($mode === 'limits') {
    $out = [];
    foreach (json_decode($argv[3], true) as $name => $value) {
        $out[$name] = curlGetTimeouts($value);
    }
    $out['omitted'] = curlGetTimeouts();
    echo json_encode($out);
} elseif ($mode === 'silent' || $mode === 'silentOverride') {
    // The kernel completes the TCP handshake into the listen queue, so cURL
    // connects and sends its request; nothing ever accepts or answers it.
    $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if ($server === false) {
        fwrite(STDERR, "listen failed: $errstr\\n");
        exit(2);
    }
    $port = parse_url('tcp://' . stream_socket_get_name($server, false), PHP_URL_PORT);
    $start = microtime(true);
    $result = $mode === 'silent'
        ? curlGetRequest("http://127.0.0.1:$port/")
        : curlGetRequest("http://127.0.0.1:$port/", [], 1);
    echo json_encode(['result' => $result, 'elapsed' => microtime(true) - $start]);
}
`;

let harnessPath = null;

function runHarness(mode, input) {
    // Auditing would pull in user.php; the limits do not depend on it.
    const env = { ...process.env };
    delete env.AUTH_MODE;
    delete env.AUDIT_LOG_ENABLED;
    const args = ["-d", "display_errors=stderr", harnessPath, SERVER_DIR, mode];
    if (input !== undefined) args.push(JSON.stringify(input));
    // 10 s is far past the 1 s default the "silent" mode sets: a helper that ignores
    // it would still be waiting when this kills it.
    return spawnSync("php", args, { cwd: SERVER_DIR, encoding: "utf8", timeout: 10000, env });
}

if (!canRun) {
    test.skip("curlGetRequest.php: needs php with the curl extension on PATH", () => {});
} else {
    beforeAll(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-curlget-"));
        harnessPath = path.join(dir, "harness.php");
        fs.writeFileSync(harnessPath, HARNESS);
    });

    test("no timeout, or a non-positive one, gets the 20 s default; a positive one is used as given", () => {
        const r = runHarness("limits", { nullValue: null, zero: 0, negative: -5, text: "abc", three: 3, long: 150 });
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout);
        // [total, connect]; connect is 5 s, or the total when that is shorter.
        expect(out.omitted).toEqual([20, 5]);
        expect(out.nullValue).toEqual([20, 5]);
        expect(out.zero).toEqual([20, 5]);
        expect(out.negative).toEqual([20, 5]);
        expect(out.text).toEqual([20, 5]);
        expect(out.three).toEqual([3, 3]);
        expect(out.long).toEqual([150, 5]);
    });

    // Both silent modes have a 1 s limit in force; each expects the request to give up at it.
    function expectGaveUpAtOneSecond(mode) {
        const r = runHarness(mode);
        // SIGTERM here means the request was still waiting when the 10 s spawn limit hit.
        // Exit 2 with "listen failed" means this environment forbids a local listener.
        if (r.status !== 0) {
            throw new Error("php harness failed (status " + r.status + ", signal " + r.signal + "):\n" + r.stdout + "\n" + r.stderr);
        }
        const out = JSON.parse(r.stdout);
        // The same failure shape callers already handle for any transport error.
        expect(out.result).toEqual({ data: false, http_status: 0 });
        // It waited for the limit (so the listener did not simply refuse), then stopped.
        expect(out.elapsed).toBeGreaterThanOrEqual(0.9);
        expect(out.elapsed).toBeLessThan(5);
    }

    test("a request with no timeout gives up on an upstream that never answers, at the default limit", () => {
        expectGaveUpAtOneSecond("silent");
    }, 20000);

    test("a caller's own timeout is applied instead of the default", () => {
        // The default stays at 20 s here, so a helper that ignored the caller's 1 s
        // would still be waiting when the 10 s spawn limit hit.
        expectGaveUpAtOneSecond("silentOverride");
    }, 20000);
}
