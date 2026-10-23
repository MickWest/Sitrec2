<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

header('Content-Type: application/json');

if (!getenv('SITREC_TRACK_STATS')) {
    echo json_encode(['disabled' => true]);
    exit;
}

require_once __DIR__ . '/stats_history.php';

$userInfo = getUserInfo();
$userId = $userInfo['user_id'];
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';

// Sitch names are short. A longer value would only make the day's visits file bigger, and
// that file is rewritten on every visit.
const VISIT_SITCH_MAX_LENGTH = 64;

$sitch = $_GET['sitch'] ?? null;
if (is_string($sitch)) {
    $sitch = substr(preg_replace('/[^a-zA-Z0-9_-]/', '', $sitch), 0, VISIT_SITCH_MAX_LENGTH);
} else {
    // ?sitch[]=... gives an array, which the length limit would not reach.
    $sitch = null;
}

recordVisit($userId, $ip, $sitch);

echo json_encode(['ok' => true]);
