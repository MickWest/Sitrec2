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

$cmd = sprintf(
    'export PATH=%s:$PATH && python3 %s --date %s --hour %s --level %s --output %s 2>&1',
    escapeshellarg($extraPaths),
    escapeshellarg($script),
    escapeshellarg($date),
    escapeshellarg((string)(int)$cycleHour),
    escapeshellarg($level),
    escapeshellarg($cacheDir)
);

$output = shell_exec($cmd);

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
