<?php

session_start();

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

header('Content-Type: application/json');

// SECURITY: Rate limiting - max 30 logs per minute per IP
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_nlu_ratelimit/';
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

$NLU_LOG_FILE = sys_get_temp_dir() . '/sitrec_nlu_fallbacks.json';
$MAX_LOG_ENTRIES = 1000;

$data = json_decode(file_get_contents('php://input'), true);

if (!$data || empty($data['prompt'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing prompt']);
    exit;
}

$userInfo = getUserInfo();

// WHOSE PROMPTS ARE KEPT.
//
// Only the two maintainer accounts. This log records what people typed to the AI
// assistant, and nobody else's is retained - including other administrators, who hold that
// role for operational reasons and never agreed to have their prompts stored.
//
// Enforced HERE, not only in the browser. The client also declines to send (see
// isNLULoggingUser in src/configUtils.js), but that saves a round trip rather than
// guaranteeing anything: a stale cached build, a replayed request or a hand-made POST
// would all still arrive. This is the check that makes the guarantee true.
//
// Deliberately by user id and not by group: "is an admin" is a different question from
// "is the person this log is for".
$NLU_LOG_USER_IDS = [1, 99999999];
if (!in_array((int)$userInfo['user_id'], $NLU_LOG_USER_IDS, true)) {
    // 200 with success, not an error: the client is not doing anything wrong, and a
    // failure here must never surface as a broken chat turn.
    echo json_encode(['success' => true, 'logged' => false]);
    exit;
}

$prompt = substr(trim($data['prompt']), 0, 500);
$apiCalls = $data['apiCalls'] ?? null;
$textResponse = isset($data['textResponse']) ? substr($data['textResponse'], 0, 1000) : null;
$timestamp = $data['timestamp'] ?? time() * 1000;

$logs = [];
if (file_exists($NLU_LOG_FILE)) {
    $content = file_get_contents($NLU_LOG_FILE);
    $logs = json_decode($content, true) ?: [];
}

$logs[] = [
    'timestamp' => $timestamp,
    'user_id' => $userInfo['user_id'],
    'prompt' => $prompt,
    'apiCalls' => $apiCalls,
    'textResponse' => $textResponse,
];

if (count($logs) > $MAX_LOG_ENTRIES) {
    $logs = array_slice($logs, -$MAX_LOG_ENTRIES);
}

file_put_contents($NLU_LOG_FILE, json_encode($logs, JSON_PRETTY_PRINT), LOCK_EX);

echo json_encode(['success' => true]);
