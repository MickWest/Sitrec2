<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

$userInfo = getUserInfo();
$userId = $userInfo['user_id'];

if (!in_array(3, $userInfo['user_groups']) && $userId !== 99999999) {
    http_response_code(403);
    die('Admin access required');
}

$AI_RATE_LIMIT_DIR = sys_get_temp_dir() . '/sitrec_ratelimit/';
$TILE_USAGE_DIR = sys_get_temp_dir() . '/sitrec_tile_usage/';
$AI_LOG_FILE = sys_get_temp_dir() . '/sitrec_ai_requests.json';

function loadAIUsageData($dir) {
    $data = [];
    if (!is_dir($dir)) return $data;
    
    $files = glob($dir . 'user_*.json');
    $now = time();
    
    foreach ($files as $file) {
        if (preg_match('/user_(\d+)\.json/', basename($file), $m)) {
            $uid = (int)$m[1];
            $d = json_decode(file_get_contents($file), true);
            if ($d && isset($d['hour'])) {
                $hourExpired = $now > ($d['hour']['reset'] ?? 0);
                $data[] = [
                    'user_id' => $uid,
                    'hour_count' => $hourExpired ? 0 : ($d['hour']['count'] ?? 0),
                    'hour_reset' => $d['hour']['reset'] ?? 0,
                ];
            }
        }
    }
    usort($data, fn($a, $b) => $b['hour_count'] <=> $a['hour_count']);
    return $data;
}

function loadTileUsageData($dir) {
    $data = [];
    if (!is_dir($dir)) return $data;
    
    $files = glob($dir . 'user_*.json');
    $now = time();
    
    foreach ($files as $file) {
        if (preg_match('/user_(.+)\.json/', basename($file), $m)) {
            $uid = $m[1];
            if (is_numeric($uid)) {
                $uid = (int)$uid;
            }
            $d = json_decode(file_get_contents($file), true);
            if ($d) {
                $hourExpired = $now > ($d['hourReset'] ?? 0);
                $dayExpired = $now > ($d['dayReset'] ?? 0);
                $data[] = [
                    'user_id' => $uid,
                    'hourly' => $hourExpired ? [] : ($d['hourly'] ?? []),
                    'daily' => $dayExpired ? [] : ($d['daily'] ?? []),
                    'hour_reset' => $d['hourReset'] ?? 0,
                    'day_reset' => $d['dayReset'] ?? 0,
                ];
            }
        }
    }
    usort($data, fn($a, $b) => array_sum($b['daily']) <=> array_sum($a['daily']));
    return $data;
}

function loadAIRequestLogs($file, $limit = 50) {
    if (!file_exists($file)) return [];
    $logs = json_decode(file_get_contents($file), true) ?: [];
    return array_reverse(array_slice($logs, -$limit));
}

function getUserNames($userIds) {
    $names = [];
    $numericIds = [];
    
    foreach ($userIds as $uid) {
        if (is_string($uid) && strpos($uid, 'guest_') === 0) {
            $names[$uid] = 'Guest';
        } elseif (is_numeric($uid)) {
            $numericIds[] = (int)$uid;
        }
    }
    
    if (class_exists('\XF') && !empty($numericIds)) {
        try {
            $userFinder = \XF::finder('XF:User')->whereIds($numericIds);
            foreach ($userFinder->fetch() as $user) {
                $names[$user->user_id] = $user->username;
            }
        } catch (Exception $e) {
        }
    }
    return $names;
}

function renderUserLink($userId, $userNames) {
    $name = htmlspecialchars($userNames[$userId] ?? 'User');
    $escapedId = htmlspecialchars($userId);
    if (is_numeric($userId)) {
        return '<a href="admin_info.php?user=' . $escapedId . '" class="user-link">' . $name . '</a> <span class="user-id">#' . $escapedId . '</span>';
    }
    return $name . ' <span class="user-id">#' . $escapedId . '</span>';
}

function formatBytes($bytes, $precision = 2) {
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $bytes = max($bytes, 0);
    $pow = floor(($bytes ? log($bytes) : 0) / log(1024));
    $pow = min($pow, count($units) - 1);
    return round($bytes / pow(1024, $pow), $precision) . ' ' . $units[$pow];
}

function getDiskSpace() {
    global $CACHE_PATH, $UPLOAD_PATH;
    $paths = [];
    
    if (isset($CACHE_PATH) && is_dir($CACHE_PATH)) {
        $paths['Cache'] = [
            'path' => $CACHE_PATH,
            'free' => disk_free_space($CACHE_PATH),
            'total' => disk_total_space($CACHE_PATH),
        ];
    }
    
    if (isset($UPLOAD_PATH) && is_dir($UPLOAD_PATH)) {
        $paths['Uploads'] = [
            'path' => $UPLOAD_PATH,
            'free' => disk_free_space($UPLOAD_PATH),
            'total' => disk_total_space($UPLOAD_PATH),
        ];
    }
    
    $tmpDir = sys_get_temp_dir();
    $paths['Temp'] = [
        'path' => $tmpDir,
        'free' => disk_free_space($tmpDir),
        'total' => disk_total_space($tmpDir),
    ];
    
    return $paths;
}

function getS3Usage() {
    global $s3creds;
    
    $result = [
        'total_size' => 0,
        'total_files' => 0,
        'users' => [],
        'recent_files' => [],
        'error' => null,
    ];
    
    if (!isset($s3creds) || empty($s3creds['bucket'])) {
        $result['error'] = 'S3 not configured';
        return $result;
    }
    
    try {
        require_once __DIR__ . '/vendor/autoload.php';
        
        $credentials = new Aws\Credentials\Credentials($s3creds['accessKeyId'], $s3creds['secretAccessKey']);
        $s3 = new Aws\S3\S3Client([
            'version' => 'latest',
            'region' => $s3creds['region'],
            'credentials' => $credentials
        ]);
        
        $bucket = $s3creds['bucket'];
        $objects = [];
        $continuationToken = null;
        
        do {
            $params = ['Bucket' => $bucket, 'MaxKeys' => 1000];
            if ($continuationToken) {
                $params['ContinuationToken'] = $continuationToken;
            }
            $response = $s3->listObjectsV2($params);
            
            if (isset($response['Contents'])) {
                foreach ($response['Contents'] as $obj) {
                    $objects[] = $obj;
                    $result['total_size'] += $obj['Size'];
                    $result['total_files']++;
                    
                    $keyParts = explode('/', $obj['Key']);
                    if (count($keyParts) > 0) {
                        $userId = $keyParts[0];
                        if (!isset($result['users'][$userId])) {
                            $result['users'][$userId] = ['size' => 0, 'files' => 0];
                        }
                        $result['users'][$userId]['size'] += $obj['Size'];
                        $result['users'][$userId]['files']++;
                    }
                }
            }
            
            $continuationToken = $response['NextContinuationToken'] ?? null;
        } while ($response['IsTruncated'] ?? false);
        
        usort($objects, fn($a, $b) => $b['LastModified'] <=> $a['LastModified']);
        $result['recent_files'] = array_slice($objects, 0, 8);
        $result['bucket'] = $bucket;
        $result['region'] = $s3creds['region'];
        
        uasort($result['users'], fn($a, $b) => $b['size'] <=> $a['size']);
        $result['users'] = array_slice($result['users'], 0, 10, true);
        
    } catch (Exception $e) {
        $result['error'] = $e->getMessage();
    }
    
    return $result;
}

$aiUsage = loadAIUsageData($AI_RATE_LIMIT_DIR);
$tileUsage = loadTileUsageData($TILE_USAGE_DIR);

$aiTotalHour = array_sum(array_column($aiUsage, 'hour_count'));
$tileTotalHour = [];
$tileTotalDay = [];
foreach ($tileUsage as $u) {
    foreach ($u['hourly'] as $s => $c) $tileTotalHour[$s] = ($tileTotalHour[$s] ?? 0) + $c;
    foreach ($u['daily'] as $s => $c) $tileTotalDay[$s] = ($tileTotalDay[$s] ?? 0) + $c;
}

$tracked3DServices = [
    'google_3d_root',
    'google_3d_tiles',
    'cesium_osm_3d_tiles',
    'cesium_osm_3d_bytes',
];
foreach ($tracked3DServices as $service) {
    if (!isset($tileTotalHour[$service])) $tileTotalHour[$service] = 0;
    if (!isset($tileTotalDay[$service])) $tileTotalDay[$service] = 0;
}
ksort($tileTotalHour);
ksort($tileTotalDay);

$google3DRootHour = $tileTotalHour['google_3d_root'] ?? 0;
$google3DRootDay = $tileTotalDay['google_3d_root'] ?? 0;
$google3DTilesHour = $tileTotalHour['google_3d_tiles'] ?? 0;
$google3DTilesDay = $tileTotalDay['google_3d_tiles'] ?? 0;
$cesiumOSMTilesHour = $tileTotalHour['cesium_osm_3d_tiles'] ?? 0;
$cesiumOSMTilesDay = $tileTotalDay['cesium_osm_3d_tiles'] ?? 0;
$cesiumOSMBytesHour = $tileTotalHour['cesium_osm_3d_bytes'] ?? 0;
$cesiumOSMBytesDay = $tileTotalDay['cesium_osm_3d_bytes'] ?? 0;

$diskSpace = getDiskSpace();
$s3Usage = getS3Usage();
$aiRequestLogs = loadAIRequestLogs($AI_LOG_FILE, 50);

$allUserIds = array_unique(array_merge(
    array_column($aiUsage, 'user_id'),
    array_column($tileUsage, 'user_id'),
    array_keys($s3Usage['users'] ?? []),
    array_column($aiRequestLogs, 'user_id')
));
$userNames = getUserNames($allUserIds);

?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sitrec Admin Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #e4e4e4;
            padding: 10px;
            font-size: 13px;
            user-select: text;
            -webkit-user-select: text;
        }
        .dashboard { max-width: 1900px; margin: 0 auto; }
        h1 {
            text-align: center;
            margin-bottom: 12px;
            font-weight: 300;
            font-size: 1.8em;
            color: #fff;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px;
            margin-bottom: 10px;
        }
        @media (min-width: 1400px) {
            .grid { grid-template-columns: repeat(4, 1fr); }
            .grid-3 { grid-template-columns: repeat(3, 1fr); }
        }
        @media (min-width: 1700px) {
            .grid { grid-template-columns: repeat(5, 1fr); }
        }
        .card {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 12px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
        }
        .card h2 {
            font-size: 0.85em;
            font-weight: 500;
            color: #8892b0;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stat-value {
            font-size: 1.8em;
            font-weight: 700;
            color: #64ffda;
            margin-bottom: 2px;
        }
        .stat-label { font-size: 0.8em; color: #8892b0; }
        .progress-bar {
            height: 6px;
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
            overflow: hidden;
            margin: 6px 0;
        }
        .progress-fill { height: 100%; border-radius: 3px; }
        .progress-green { background: linear-gradient(90deg, #00c853, #64ffda); }
        .progress-yellow { background: linear-gradient(90deg, #ffd600, #ffab00); }
        .progress-red { background: linear-gradient(90deg, #ff5252, #ff1744); }
        .service-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
        .service-item {
            background: rgba(255,255,255,0.03);
            padding: 6px 8px;
            border-radius: 4px;
        }
        .service-name { font-size: 0.75em; color: #8892b0; text-transform: uppercase; }
        .service-value { font-size: 1.1em; font-weight: 600; color: #ccd6f6; }
        .full-width { grid-column: 1 / -1; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th, td {
            padding: 6px 4px;
            text-align: left;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        th { color: #8892b0; font-weight: 500; font-size: 0.75em; text-transform: uppercase; }
        td { color: #ccd6f6; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .user-id { color: #8892b0; font-size: 0.8em; }
        .user-link { color: #ccd6f6; text-decoration: none; }
        .user-link:hover { color: #64ffda; text-decoration: underline; }
        .sitch-link { color: #64ffda; text-decoration: none; }
        .sitch-link:hover { text-decoration: underline; }
        .highlight { color: #64ffda; font-weight: 600; }
        .prompt-text {
            max-width: 500px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 0.85em;
        }
        .prompt-text:hover { white-space: normal; word-break: break-word; }
        .model-tag {
            font-size: 0.7em;
            color: #8892b0;
            background: rgba(255,255,255,0.05);
            padding: 1px 4px;
            border-radius: 3px;
        }
        .log-table { max-height: 400px; overflow-y: auto; }
        .disk-item { margin-bottom: 10px; }
        .disk-item:last-child { margin-bottom: 0; }
        .disk-label { display: flex; justify-content: space-between; margin-bottom: 2px; font-size: 0.9em; }
        .disk-path { font-size: 0.7em; color: #5a6a8a; word-break: break-all; }
        .timestamp { text-align: center; color: #5a6a8a; font-size: 0.8em; margin-top: 10px; }
        .refresh-btn {
            display: inline-block;
            margin-left: 8px;
            padding: 3px 10px;
            background: rgba(100, 255, 218, 0.1);
            border: 1px solid #64ffda;
            color: #64ffda;
            border-radius: 3px;
            text-decoration: none;
            font-size: 0.8em;
        }
        .refresh-btn:hover { background: rgba(100, 255, 218, 0.2); }
    </style>
</head>
<body>
    <div class="dashboard">
        <h1>Sitrec Admin Dashboard</h1>
        
        <div class="grid">
            <div class="card">
                <h2>AI Usage (This Hour)</h2>
                <div class="stat-value"><?= number_format($aiTotalHour) ?></div>
                <div class="stat-label">Total AI requests across <?= count($aiUsage) ?> users</div>
            </div>
            
            <div class="card">
                <h2>Tile Usage (This Hour)</h2>
                <div class="stat-value"><?= number_format(array_sum($tileTotalHour)) ?></div>
                <div class="stat-label">Total tiles across <?= count($tileUsage) ?> users</div>
            </div>
            
            <div class="card">
                <h2>Tile Usage (Today)</h2>
                <div class="stat-value"><?= number_format(array_sum($tileTotalDay)) ?></div>
                <div class="stat-label">Daily total for audit</div>
            </div>

            <div class="card">
                <h2>Google 3D Root Sessions</h2>
                <div class="stat-value"><?= number_format($google3DRootDay) ?></div>
                <div class="stat-label">Day: <?= number_format($google3DRootDay) ?> | Hour: <?= number_format($google3DRootHour) ?></div>
            </div>

            <div class="card">
                <h2>Google 3D Tile Requests</h2>
                <div class="stat-value"><?= number_format($google3DTilesDay) ?></div>
                <div class="stat-label">Day: <?= number_format($google3DTilesDay) ?> | Hour: <?= number_format($google3DTilesHour) ?></div>
            </div>

            <div class="card">
                <h2>Cesium OSM 3D Bandwidth</h2>
                <div class="stat-value"><?= formatBytes($cesiumOSMBytesDay) ?></div>
                <div class="stat-label">
                    BW Day: <?= formatBytes($cesiumOSMBytesDay) ?> | Hour: <?= formatBytes($cesiumOSMBytesHour) ?><br>
                    Requests Day: <?= number_format($cesiumOSMTilesDay) ?> | Hour: <?= number_format($cesiumOSMTilesHour) ?>
                </div>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h2>Tiles by Service (Hour)</h2>
                <div class="service-grid">
                    <?php foreach ($tileTotalHour as $service => $count): ?>
                    <div class="service-item">
                        <div class="service-name"><?= htmlspecialchars($service) ?></div>
                        <div class="service-value"><?= number_format($count) ?></div>
                    </div>
                    <?php endforeach; ?>
                    <?php if (empty($tileTotalHour)): ?>
                    <div class="service-item"><div class="service-name">No data</div></div>
                    <?php endif; ?>
                </div>
            </div>
            
            <div class="card">
                <h2>Tiles by Service (Day)</h2>
                <div class="service-grid">
                    <?php foreach ($tileTotalDay as $service => $count): ?>
                    <div class="service-item">
                        <div class="service-name"><?= htmlspecialchars($service) ?></div>
                        <div class="service-value"><?= number_format($count) ?></div>
                    </div>
                    <?php endforeach; ?>
                    <?php if (empty($tileTotalDay)): ?>
                    <div class="service-item"><div class="service-name">No data</div></div>
                    <?php endif; ?>
                </div>
            </div>
            
            <div class="card">
                <h2>Disk Space</h2>
                <?php foreach ($diskSpace as $name => $info): ?>
                <div class="disk-item">
                    <div class="disk-label">
                        <span><?= $name ?></span>
                        <span><?= formatBytes($info['free']) ?> free</span>
                    </div>
                    <?php 
                    $usedPercent = 100 - (($info['free'] / $info['total']) * 100);
                    $colorClass = $usedPercent < 70 ? 'progress-green' : ($usedPercent < 90 ? 'progress-yellow' : 'progress-red');
                    ?>
                    <div class="progress-bar">
                        <div class="progress-fill <?= $colorClass ?>" style="width: <?= $usedPercent ?>%"></div>
                    </div>
                    <div class="disk-path"><?= htmlspecialchars($info['path']) ?></div>
                </div>
                <?php endforeach; ?>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h2>Top 10 AI Users (Hour)</h2>
                <table>
                    <tr><th>User</th><th>Requests</th></tr>
                    <?php foreach (array_slice($aiUsage, 0, 10) as $u): ?>
                    <tr>
                        <td><?= renderUserLink($u['user_id'], $userNames) ?></td>
                        <td class="highlight"><?= number_format($u['hour_count']) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($aiUsage)): ?>
                    <tr><td colspan="2">No data</td></tr>
                    <?php endif; ?>
                </table>
            </div>
            
            <div class="card">
                <h2>Top 10 Tile Users (Day)</h2>
                <table>
                    <tr><th>User</th><th>Tiles</th></tr>
                    <?php foreach (array_slice($tileUsage, 0, 10) as $u): ?>
                    <tr>
                        <td><?= renderUserLink($u['user_id'], $userNames) ?></td>
                        <td class="highlight"><?= number_format(array_sum($u['daily'])) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($tileUsage)): ?>
                    <tr><td colspan="2">No data</td></tr>
                    <?php endif; ?>
                </table>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h2>S3 Storage Summary</h2>
                <?php if ($s3Usage['error']): ?>
                <div class="stat-label"><?= htmlspecialchars($s3Usage['error']) ?></div>
                <?php else: ?>
                <div class="stat-value"><?= formatBytes($s3Usage['total_size']) ?></div>
                <div class="stat-label"><?= number_format($s3Usage['total_files']) ?> files across <?= count($s3Usage['users']) ?> users</div>
                <?php endif; ?>
            </div>
            
            <div class="card">
                <h2>Top 10 S3 Users by Space</h2>
                <?php if ($s3Usage['error']): ?>
                <div class="stat-label"><?= htmlspecialchars($s3Usage['error']) ?></div>
                <?php else: ?>
                <table>
                    <tr><th>User</th><th>Size</th><th>Files</th></tr>
                    <?php foreach ($s3Usage['users'] as $uid => $info): ?>
                    <tr>
                        <td><?= renderUserLink($uid, $userNames) ?></td>
                        <td class="highlight"><?= formatBytes($info['size']) ?></td>
                        <td><?= number_format($info['files']) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($s3Usage['users'])): ?>
                    <tr><td colspan="3">No data</td></tr>
                    <?php endif; ?>
                </table>
                <?php endif; ?>
            </div>
            
            <div class="card">
                <h2>Most Recent S3 Files</h2>
                <?php if ($s3Usage['error']): ?>
                <div class="stat-label"><?= htmlspecialchars($s3Usage['error']) ?></div>
                <?php elseif (empty($s3Usage['recent_files'])): ?>
                <div class="stat-label">No files</div>
                <?php else: ?>
                <?php foreach ($s3Usage['recent_files'] as $file): 
                    $key = $file['Key'];
                    $s3Url = 'https://' . $s3Usage['bucket'] . '.s3.' . $s3Usage['region'] . '.amazonaws.com/' . $key;
                    $keyParts = explode('/', $key);
                    $isSitch = count($keyParts) >= 3 && is_numeric($keyParts[0]) && str_ends_with($key, '.js');
                    $linkUrl = $isSitch ? '../?custom=' . urlencode($s3Url) : $s3Url;
                ?>
                <div class="disk-item">
                    <div class="disk-label">
                        <a href="<?= htmlspecialchars($linkUrl) ?>" target="_blank" rel="noopener" class="sitch-link" style="word-break: break-all;"><?= htmlspecialchars($key) ?></a>
                    </div>
                    <div class="disk-path"><?= formatBytes($file['Size']) ?> - <?= $file['LastModified']->format('Y-m-d H:i:s') ?> <?php if (is_numeric($keyParts[0])): ?><?= renderUserLink($keyParts[0], $userNames) ?><?php endif; ?></div>
                </div>
                <?php endforeach; ?>
                <?php endif; ?>
            </div>
        </div>
        
        <div class="grid">
            <div class="card full-width">
                <h2>Recent AI Requests (Last 50)</h2>
                <div class="log-table">
                    <table>
                        <tr><th>Time</th><th>User</th><th>Model</th><th>Prompt</th></tr>
                        <?php foreach ($aiRequestLogs as $log): ?>
                        <tr>
                            <td><?= date('Y-m-d H:i:s', $log['timestamp']) ?></td>
                            <td><?= renderUserLink($log['user_id'], $userNames) ?></td>
                            <td><span class="model-tag"><?= htmlspecialchars($log['model'] ?? 'default') ?></span></td>
                            <td><div class="prompt-text"><?= htmlspecialchars($log['prompt']) ?></div></td>
                        </tr>
                        <?php endforeach; ?>
                        <?php if (empty($aiRequestLogs)): ?>
                        <tr><td colspan="4">No AI requests logged</td></tr>
                        <?php endif; ?>
                    </table>
                </div>
            </div>
        </div>
        
        <div class="timestamp">
            Last updated: <?= date('Y-m-d H:i:s') ?>
            <a href="?" class="refresh-btn">Refresh</a>
        </div>
    </div>
</body>
</html>
