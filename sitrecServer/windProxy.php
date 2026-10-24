<?php
/**
 * Wind data proxy for Sitrec — fetches GFS wind data and returns cached JSON.
 *
 * Usage: windProxy.php?date=20220919&hour=18&level=surface
 * Levels: surface, or a pressure level in hPa from fetch_wind.py's
 * PRESSURE_LEVELS (1000 down to 10); anything else is a 400.
 *
 * Results are cached as JSON files in ../data/wind/ — subsequent requests for
 * the same date/hour/level are served instantly from cache.
 * If the exact cycle isn't available (GFS takes ~4h to process), earlier cycles
 * on the same day are tried automatically.
 *
 * Cache hits are unthrottled. A miss starts tools/fetch_wind.py and holds this
 * PHP worker for up to 100 s, so misses are limited per IP and only a few
 * fetches run at once (429 and 503 respectively, both with a JSON error).
 */

require_once __DIR__ . '/rate_limit.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$date  = preg_replace('/[^0-9]/', '', $_GET['date'] ?? '');
$hour  = intval($_GET['hour'] ?? 0);
$level = preg_replace('/[^a-z0-9]/', '', $_GET['level'] ?? 'surface');

// Validate inputs
if (!preg_match('/^\d{8}$/', $date)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid date format, use YYYYMMDD']);
    exit;
}

if ($hour < 0 || $hour > 23) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid hour']);
    exit;
}

// fetch_wind.py can only fetch real days from 2021-03-22 (the AWS archive's
// atmos/ layout, the one it builds, starts with that day's 12Z cycle) up to
// today; one day of slack allows for a client clock ahead of the server's.
// Anything else would start Python only to fail.
if (!checkdate((int)substr($date, 4, 2), (int)substr($date, 6, 2), (int)substr($date, 0, 4))
    || $date < '20210322' || $date > gmdate('Ymd', time() + 86400)) {
    http_response_code(400);
    echo json_encode(['error' => 'Date out of range for GFS wind data']);
    exit;
}

// The levels fetch_wind.py lists in PRESSURE_LEVELS, plus surface.
$levels = ['surface', '1000', '975', '950', '925', '900', '850', '800', '700', '600',
    '500', '400', '300', '250', '200', '150', '100', '70', '50', '30', '20', '10'];
if (!in_array($level, $levels, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid level']);
    exit;
}

$cycleHour = intdiv($hour, 6) * 6;
$cycleHourStr = sprintf('%02d', $cycleHour);   // zero-pad to match Python's f"{hour:02d}"
$levelStr = ($level === 'surface') ? '10m' : "{$level}hPa";

// Cache directory
$cacheDir = __DIR__ . '/../data/wind/';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}

// ── serve from cache ─────────────────────────────────────────────
// Exact cycle match: serve unconditionally (correct data, cache forever)
$exactCache = $cacheDir . "wind_{$date}_{$cycleHourStr}z_{$levelStr}.json";
if (file_exists($exactCache)) {
    readfile($exactCache);
    exit;
}

// Earlier-cycle fallback: only serve if written less than 4 hours ago
// (GFS takes ~3.5–4h to process, so after 4h the correct cycle should be available)
for ($h = $cycleHour - 6; $h >= 0; $h -= 6) {
    $candidate = $cacheDir . sprintf("wind_%s_%02dz_%s.json", $date, $h, $levelStr);
    if (file_exists($candidate) && (time() - filemtime($candidate)) < 4 * 3600) {
        readfile($candidate);
        exit;
    }
}

// ── fetch via Python script (it handles cycle fallback internally) ──
$script = __DIR__ . '/../tools/fetch_wind.py';
if (!file_exists($script)) {
    http_response_code(500);
    echo json_encode(['error' => 'fetch_wind.py not found']);
    exit;
}

// Extend PATH to cover Docker (/home/node/.local/bin) and local macOS
// (pyenv shims, Homebrew on Apple Silicon + Intel).
$extraPaths = implode(':', array_filter([
    getenv('HOME') ? getenv('HOME') . '/.pyenv/shims' : null,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/node/.local/bin',
]));

// An argument array launches Python directly, including on deployments that
// disable shell_exec(). Request values never become shell syntax.
$environment = getenv();
$environment['PATH'] = $extraPaths . ':' . ($environment['PATH'] ?? '/usr/bin:/bin');
// proc_open resolves an unqualified executable using PHP's own PATH, before
// applying the child environment. Resolve against the intended search path
// explicitly so local installations can use their Python dependencies too.
$python = null;
foreach (explode(PATH_SEPARATOR, $environment['PATH']) as $directory) {
    if ($directory === '' || $directory[0] !== DIRECTORY_SEPARATOR) {
        continue;
    }
    $candidate = $directory . '/python3';
    if (is_file($candidate) && is_executable($candidate)) {
        $python = $candidate;
        break;
    }
}
if ($python === null) {
    http_response_code(503);
    echo json_encode(['error' => 'Python is unavailable for wind data fetching']);
    exit;
}

// ── throttle cache misses ────────────────────────────────────────
// The fetch slots below are what protect the PHP workers; this only stops one
// address queueing misses without end. It is generous because behind a reverse
// proxy without mod_remoteip every visitor shares one REMOTE_ADDR, and then this
// is one budget for the whole site. 120 per 10 minutes is a full level set for
// several cycles. The token is taken before the slot, so a flood that only meets
// busy slots still runs out of tokens.
if (!sitrecConsumeRateToken('wind', 120, 600)) {
    http_response_code(429);
    header('Retry-After: 60');
    echo json_encode(['error' => 'Too many wind data requests; please wait and retry']);
    exit;
}

/**
 * Claim one of $count fetch slots: a lock file held until it is released or
 * the request ends. The Python child inherits the descriptor, so a slot stays
 * taken while an orphaned fetch still runs. Returns the handle, false when
 * every slot is busy, or null when no slot can be locked for any other reason,
 * which fails open like the rate limiter.
 */
function claimFetchSlot($count) {
    $dir = sys_get_temp_dir() . '/sitrec_wind_fetch_slots/';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $busy = false;
    for ($i = 0; $i < $count; $i++) {
        $fh = @fopen($dir . "slot{$i}.lock", 'c');
        if ($fh === false) continue;
        if (flock($fh, LOCK_EX | LOCK_NB, $wouldBlock)) return $fh;
        fclose($fh);
        $busy = $busy || $wouldBlock;
    }
    return $busy ? false : null;
}

// Four at once: one client fetches up to three levels in parallel plus the
// one on screen, and the rest of the PHP worker pool stays free.
$slot = claimFetchSlot(4);
if ($slot === false) {
    http_response_code(503);
    header('Retry-After: 10');
    echo json_encode(['error' => 'Wind data fetcher is busy; please retry']);
    exit;
}

$command = [$python, $script, '--date', $date, '--hour', (string)$cycleHour,
    '--level', $level, '--output', $cacheDir];
$process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'],
    2 => ['redirect', 1]], $pipes, null, $environment);
$output = '';
$timedOut = false;
if (is_resource($process)) {
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    // Bound both wall time and diagnostics; PHP's execution limit does not
    // reliably include time spent waiting for a child process on Unix.
    $deadline = microtime(true) + 100;
    while (true) {
        $chunk = stream_get_contents($pipes[1]);
        $output .= substr($chunk === false ? '' : $chunk, 0, max(0, 32768 - strlen($output)));
        if (!proc_get_status($process)['running']) {
            break;
        }
        if (microtime(true) >= $deadline) {
            $timedOut = true;
            proc_terminate($process);
            usleep(100000);
            if (proc_get_status($process)['running']) {
                proc_terminate($process, 9);
            }
            break;
        }
        usleep(50000);
    }
    $chunk = stream_get_contents($pipes[1]);
    $output .= substr($chunk === false ? '' : $chunk, 0, max(0, 32768 - strlen($output)));
    fclose($pipes[1]);
    proc_close($process);
} else {
    $output = 'Unable to start the wind data fetcher';
}
if ($slot) {
    flock($slot, LOCK_UN);
    fclose($slot);
}

if ($timedOut) {
    http_response_code(504);
    echo json_encode(['error' => 'Wind data fetch timed out; please retry']);
    exit;
}

// Check for any cycle that was written
for ($h = $cycleHour; $h >= 0; $h -= 6) {
    $candidate = $cacheDir . sprintf("wind_%s_%02dz_%s.json", $date, $h, $levelStr);
    if (file_exists($candidate)) {
        readfile($candidate);
        exit;
    }
}

http_response_code(502);
echo json_encode([
    'error' => 'Failed to fetch wind data',
    'details' => $output,
]);
