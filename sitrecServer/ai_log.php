<?php

// The AI request log: one rolling file of who asked what of which model.
//
// Shared, for the same reason ai_models.php is: the log is only useful if EVERY endpoint that
// spends money on a provider writes to it. A second endpoint keeping its own file, or naming
// the same file separately, produces an admin dashboard that quietly under-reports. So the
// path and the writer live here, and chatbot.php, aimask.php and admin_dashboard.php all
// take them from this one place.

$AI_LOG_FILE = sys_get_temp_dir() . '/sitrec_ai_requests.json';

function logAIRequest($userId, $prompt, $model = null) {
    global $AI_LOG_FILE;

    $logs = [];
    if (file_exists($AI_LOG_FILE)) {
        $content = file_get_contents($AI_LOG_FILE);
        $logs = json_decode($content, true) ?: [];
    }

    $logs[] = [
        'timestamp' => time(),
        'user_id' => $userId,
        'prompt' => substr($prompt, 0, 500),
        'model' => $model,
    ];

    if (count($logs) > 500) {
        $logs = array_slice($logs, -500);
    }

    file_put_contents($AI_LOG_FILE, json_encode($logs), LOCK_EX);
}
