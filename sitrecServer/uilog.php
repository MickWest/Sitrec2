<?php
//
// uilog.php
//
// Receives a batch of UI menu-item click events from the client (see
// src/UILogging.js) and appends them, with the user id and client IP, to a
// per-day JSON-Lines file under sitrec-upload/ui-stats/. The admin dashboard
// aggregates these into a "Top 10 Clicked Menu Items" panel.
//
// Gated by the LOG_UI_INTERACTIONS env var (config/shared.env): if it is off,
// this endpoint silently discards the data. This is the server-side half of the
// defence-in-depth gating; the client also refuses to send when its flag is off.

session_start();

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

header('Content-Type: application/json');

// Feature gate. Respond 200 (not an error) so a stale client bundle that still
// sends events just gets a benign "disabled" acknowledgement.
if (!getenv('LOG_UI_INTERACTIONS')) {
    echo json_encode(['disabled' => true]);
    exit;
}

// --- Rate limiting: max 30 requests per minute per IP -----------------------
// The client batches every 10s, so legitimate traffic is ~6/min; 30 is generous.
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_uilog_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 30) {
    http_response_code(429);
    echo json_encode(['error' => 'Rate limit exceeded']);
    exit;
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

// --- Parse and validate the payload -----------------------------------------
// sendBeacon delivers text/plain, normal flushes deliver application/json; we
// read the raw body either way.
$data = json_decode(file_get_contents('php://input'), true);
if (!$data || !isset($data['events']) || !is_array($data['events'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing events']);
    exit;
}

$MAX_EVENTS = 500;       // cap per request
$MAX_PATH_LEN = 300;     // cap each menu path

$userInfo = getUserInfo();
$userId = $userInfo['user_id'];

// Sanitize each event into a flat record. We strip control characters from the
// path and length-cap it so nothing odd lands in the log file.
$lines = [];
$count = 0;
foreach ($data['events'] as $event) {
    if ($count >= $MAX_EVENTS) break;
    if (!is_array($event) || empty($event['path'])) continue;

    $path = (string)$event['path'];
    // Remove control characters (incl. newlines) to keep one record per line.
    $path = preg_replace('/[\x00-\x1F\x7F]/u', '', $path);
    $path = trim($path);
    if ($path === '') continue;
    if (mb_strlen($path) > $MAX_PATH_LEN) {
        $path = mb_substr($path, 0, $MAX_PATH_LEN);
    }

    // Client timestamp in ms; validate it's a sane positive number, else use now.
    $ts = isset($event['ts']) && is_numeric($event['ts']) ? (int)$event['ts'] : ($now * 1000);

    $record = [
        'ts'      => $ts,
        'user_id' => $userId,
        'ip'      => $clientIP,
        'path'    => $path,
    ];
    // JSON_UNESCAPED_SLASHES keeps the "/" path separators readable.
    $lines[] = json_encode($record, JSON_UNESCAPED_SLASHES);
    $count++;
}

if (count($lines) === 0) {
    echo json_encode(['success' => true, 'logged' => 0]);
    exit;
}

// --- Append to the per-day JSON-Lines file ----------------------------------
global $UPLOAD_PATH;
$uiStatsDir = $UPLOAD_PATH . 'ui-stats/';
if (!is_dir($uiStatsDir)) {
    @mkdir($uiStatsDir, 0755, true);
}
if (!is_dir($uiStatsDir) || !is_writable($uiStatsDir)) {
    http_response_code(500);
    echo json_encode(['error' => 'ui-stats directory not writable']);
    exit;
}

$logFile = $uiStatsDir . 'ui-' . date('Y-m-d') . '.jsonl';
file_put_contents($logFile, implode("\n", $lines) . "\n", FILE_APPEND | LOCK_EX);

echo json_encode(['success' => true, 'logged' => count($lines)]);
