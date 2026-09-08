<?php
/**
 * Wind data proxy for Sitrec — fetches GFS wind data and returns cached JSON.
 *
 * Usage: windProxy.php?date=20220919&hour=18&level=surface
 * Levels: surface, 1000, 925, 850, 700, 500, 300, 250, 200
 *
 * Results are cached as JSON files in ../data/wind/ — subsequent requests for
 * the same date/hour/level are served instantly from cache.
 * If the exact cycle isn't available (GFS takes ~4h to process), earlier cycles
 * on the same day are tried automatically.
 */

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
