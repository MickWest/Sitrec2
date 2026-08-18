<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

$userInfo = getUserInfo();

if (!isAdmin($userInfo)) {
    http_response_code(403);
    die('Admin access required');
}

require_once __DIR__ . '/ai_log.php';

$RATE_LIMIT_DIR = sys_get_temp_dir() . '/sitrec_ratelimit/';

// Per-user spend over whatever the rolling request log still holds (last 500 requests).
// This is a WINDOW, not a lifetime total - the 28-day totals in admin_dashboard.php are
// the ones that survive a busy hour. Labelled as such in the table header below.
$spendByUser = [];
$loggedRequests = [];
if (file_exists($AI_LOG_FILE)) {
    foreach (json_decode(file_get_contents($AI_LOG_FILE), true) ?: [] as $entry) {
        $uid = (int)($entry['user_id'] ?? 0);
        $loggedRequests[$uid] = ($loggedRequests[$uid] ?? 0) + 1;
        if (isset($entry['cost_micros']) && $entry['cost_micros'] !== null) {
            $spendByUser[$uid] = ($spendByUser[$uid] ?? 0) + (int)$entry['cost_micros'];
        }
    }
}
function fmtUSDMicros($micros) {
    if ($micros === null) return '-';
    $usd = $micros / 1000000;
    if ($usd == 0) return '$0';
    return $usd < 0.01 ? '$' . number_format($usd, 4) : '$' . number_format($usd, 2);
}

$usageData = [];

if (is_dir($RATE_LIMIT_DIR)) {
    $files = glob($RATE_LIMIT_DIR . 'user_*.json');
    foreach ($files as $file) {
        $basename = basename($file);
        if (preg_match('/user_(\d+)\.json/', $basename, $matches)) {
            $userId = (int)$matches[1];
            $data = json_decode(file_get_contents($file), true);
            if ($data && isset($data['hour'])) {
                $usageData[] = [
                    'user_id' => $userId,
                    'minute_count' => $data['minute']['count'] ?? 0,
                    'minute_reset' => $data['minute']['reset'] ?? 0,
                    'hour_count' => $data['hour']['count'] ?? 0,
                    'hour_reset' => $data['hour']['reset'] ?? 0,
                ];
            }
        }
    }
}

usort($usageData, fn($a, $b) => $b['hour_count'] <=> $a['hour_count']);

$userNames = [];
$fileDir = getenv('XENFORO_PATH');
if ($fileDir && file_exists($fileDir . 'src/XF.php')) {
    $userIds = array_column($usageData, 'user_id');
    if (!empty($userIds)) {
        $userFinder = \XF::finder('XF:User')->whereIds($userIds);
        foreach ($userFinder->fetch() as $user) {
            $userNames[$user->user_id] = $user->username;
        }
    }
}

?>
<!DOCTYPE html>
<html>
<head>
    <title>AI Usage Stats</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        table { border-collapse: collapse; width: 100%; max-width: 800px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #4CAF50; color: white; }
        tr:nth-child(even) { background-color: #f2f2f2; }
        .expired { color: #999; }
    </style>
</head>
<body>
    <h1>AI Chatbot Usage</h1>
    <p>Rate-limit counters below are per-user request counts for the current minute/hour
    windows. Cost is summed over the last 500 logged requests, so it is a recent window
    rather than a lifetime total - see the admin dashboard for 28-day spend.</p>
    <p>Rate limit directory: <?= htmlspecialchars($RATE_LIMIT_DIR) ?></p>
    <table>
        <tr>
            <th>User ID</th>
            <th>Username</th>
            <th>Minute Count</th>
            <th>Minute Reset</th>
            <th>Hour Count</th>
            <th>Hour Reset</th>
            <th>Requests logged</th>
            <th>Cost (logged window)</th>
        </tr>
        <?php foreach ($usageData as $row): ?>
        <tr>
            <td><?= $row['user_id'] ?></td>
            <td><?= htmlspecialchars($userNames[$row['user_id']] ?? 'Unknown') ?></td>
            <td><?= $row['minute_count'] ?></td>
            <td class="<?= $row['minute_reset'] < time() ? 'expired' : '' ?>">
                <?= date('Y-m-d H:i:s', $row['minute_reset']) ?>
            </td>
            <td><?= $row['hour_count'] ?></td>
            <td class="<?= $row['hour_reset'] < time() ? 'expired' : '' ?>">
                <?= date('Y-m-d H:i:s', $row['hour_reset']) ?>
            </td>
            <td><?= number_format($loggedRequests[$row['user_id']] ?? 0) ?></td>
            <td><?= fmtUSDMicros($spendByUser[$row['user_id']] ?? null) ?></td>
        </tr>
        <?php endforeach; ?>
    </table>
    <?php if (empty($usageData)): ?>
    <p>No usage data found.</p>
    <?php endif; ?>
</body>
</html>
