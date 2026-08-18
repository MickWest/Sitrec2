<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

$userInfo = getUserInfo();
$userId = $userInfo['user_id'];

if (!isAdmin($userInfo)) {
    http_response_code(403);
    die('Admin access required');
}

// Drill-down "Top 200" view. Each "Top 10 ..." card title links here via
// ?expand=<type>; the page then renders just that one list, up to 200 rows.
// Admin-only is already enforced above. $EXPAND_LIMIT bumps the per-list limits.
$VALID_EXPANDS = ['ai', 'tiles', 'menu', 's3'];
$expand = $_GET['expand'] ?? '';
if (!in_array($expand, $VALID_EXPANDS, true)) $expand = '';
$EXPAND_LIMIT = 200;

$AI_RATE_LIMIT_DIR = sys_get_temp_dir() . '/sitrec_ratelimit/';
$TILE_USAGE_DIR = sys_get_temp_dir() . '/sitrec_tile_usage/';

// $AI_LOG_FILE comes from the same file the writers use. Held in one place because a reader
// pointed at a path the writers no longer use shows an empty dashboard rather than an error.
require_once __DIR__ . '/ai_log.php';

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
    // Sort by tile count excluding byte-tracking services
    $excludeKeys = array_flip(['cesium_osm_3d_bytes']);
    usort($data, fn($a, $b) =>
        array_sum(array_diff_key($b['daily'], $excludeKeys)) <=>
        array_sum(array_diff_key($a['daily'], $excludeKeys))
    );
    return $data;
}

// Money is stored as integer micro-dollars (see ai_log.php recordAISpend) because the daily
// rollup is a running sum and one turn is often a fraction of a cent. Render at a precision
// that does not round a real cost to $0.00.
function fmtUSD($micros) {
    if ($micros === null) return '-';
    $usd = $micros / 1000000;
    if ($usd == 0) return '$0';
    if ($usd < 0.01) return '$' . number_format($usd, 4);
    return '$' . number_format($usd, 2);
}

// Totals over the 28-day window, plus the per-model split. The split matters because
// "AI cost $40 this week" is only actionable next to which model spent it.
function summarizeAISpend($statsHistory) {
    $out = ['cost_micros' => 0, 'calls' => 0, 'requests' => 0, 'unpriced' => 0,
            'input' => 0, 'output' => 0, 'cache_read' => 0, 'cache_write' => 0,
            'today_micros' => 0, 'by_model' => []];
    $today = date('Y-m-d');
    foreach ($statsHistory as $date => $day) {
        $out['cost_micros'] += $day['ai_cost_micros'] ?? 0;
        $out['calls']       += $day['ai_calls'] ?? 0;
        $out['requests']    += $day['ai_requests'] ?? 0;
        $out['unpriced']    += $day['ai_unpriced_calls'] ?? 0;
        $out['input']       += $day['ai_input_tokens'] ?? 0;
        $out['output']      += $day['ai_output_tokens'] ?? 0;
        $out['cache_read']  += $day['ai_cache_read_tokens'] ?? 0;
        $out['cache_write'] += $day['ai_cache_write_tokens'] ?? 0;
        if ($date === $today) $out['today_micros'] = $day['ai_cost_micros'] ?? 0;
        foreach ($day as $k => $v) {
            if (strpos($k, 'ai_cost_micros__') === 0) {
                $model = substr($k, strlen('ai_cost_micros__'));
                $out['by_model'][$model] = ($out['by_model'][$model] ?? 0) + $v;
            }
        }
    }
    arsort($out['by_model']);
    return $out;
}

function loadAIRequestLogs($file, $limit = 50) {
    if (!file_exists($file)) return [];
    $logs = json_decode(file_get_contents($file), true) ?: [];
    return array_reverse(array_slice($logs, -$limit));
}

// Aggregate UI menu-item click logs (written by uilog.php as per-day JSON-Lines
// files) into a "path => click count" map, returning the top $top entries.
// Limited to the $days most recent daily files to bound the work on this page.
function loadTopMenuItems($dir, $top = 10, $days = 28) {
    $counts = [];
    if (!is_dir($dir)) return $counts;
    $files = glob($dir . 'ui-*.jsonl');
    if (!$files) return $counts;
    rsort($files);                        // most recent day first (filenames sort by date)
    $files = array_slice($files, 0, $days);
    foreach ($files as $file) {
        $fh = @fopen($file, 'r');
        if (!$fh) continue;
        while (($line = fgets($fh)) !== false) {   // stream line-by-line, memory-friendly
            $line = trim($line);
            if ($line === '') continue;
            $rec = json_decode($line, true);
            if (!$rec || empty($rec['path'])) continue;
            $p = $rec['path'];
            $counts[$p] = ($counts[$p] ?? 0) + 1;
        }
        fclose($fh);
    }
    arsort($counts);
    return array_slice($counts, 0, $top, true);
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

function getS3Usage($limit = 10) {
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
        // Only include properly formatted sitch files (YYYYMMDD_HHMMSS.js)
        $sitchFiles = array_filter($objects, function($obj) {
            $parts = explode('/', $obj['Key']);
            $filename = end($parts);
            return preg_match('/^\d{8}_\d{6}\.js$/', $filename);
        });
        $result['recent_files'] = array_slice(array_values($sitchFiles), 0, 8);
        $result['bucket'] = $bucket;
        $result['region'] = $s3creds['region'];
        
        uasort($result['users'], fn($a, $b) => $b['size'] <=> $a['size']);
        $result['users'] = array_slice($result['users'], 0, $limit, true);
        
    } catch (Exception $e) {
        $result['error'] = $e->getMessage();
    }
    
    return $result;
}

require_once __DIR__ . '/stats_history.php';

function renderSparkGraph($statsHistory, $key, $label, $formatFn = 'number_format', $color = '#64ffda') {
    $values = [];
    $dates = [];
    foreach ($statsHistory as $date => $day) {
        $dates[] = $date;
        $values[] = $day[$key] ?? 0;
    }
    $max = max(1, max($values));
    $h = 60;
    $today = end($values);

    // Dispatch on the named formatter rather than special-casing one of them, so a new
    // unit does not silently render as a bare count. fmtUSD takes micro-dollars.
    $fmt = function ($v) use ($formatFn) {
        if ($formatFn === 'formatBytes') return formatBytes($v);
        if ($formatFn === 'fmtUSD') return fmtUSD($v);
        return number_format($v);
    };

    $formattedToday = $fmt($today);

    $svg = '<svg viewBox="0 0 280 ' . $h . '" preserveAspectRatio="none" style="width:100%;height:' . $h . 'px;">';
    foreach ($values as $i => $v) {
        $barH = ($v / $max) * ($h - 2);
        $x = $i * (280 / count($values));
        $bw = (280 / count($values)) - 1;
        $y = $h - $barH;
        $opacity = ($i === count($values) - 1) ? '1' : '0.6';
        $svg .= '<rect x="' . $x . '" y="' . $y . '" width="' . $bw . '" height="' . $barH . '" fill="' . $color . '" opacity="' . $opacity . '">';
        $formattedVal = $fmt($v);
        $svg .= '<title>' . htmlspecialchars($dates[$i]) . ': ' . $formattedVal . '</title>';
        $svg .= '</rect>';
    }
    $svg .= '</svg>';

    return '<div class="spark-card">'
        . '<div class="spark-header"><span class="spark-label">' . htmlspecialchars($label) . '</span>'
        . '<span class="spark-today">' . $formattedToday . '</span></div>'
        . $svg
        . '</div>';
}

$aiUsage = loadAIUsageData($AI_RATE_LIMIT_DIR);
$tileUsage = loadTileUsageData($TILE_USAGE_DIR);
$statsHistory = getStatsHistory28();
$todayVisits = getVisitDetails(date('Y-m-d'));

// UI menu-item click stats (written by uilog.php to sitrec-upload/ui-stats/).
global $UPLOAD_PATH;
$topMenuItems = loadTopMenuItems($UPLOAD_PATH . 'ui-stats/', $expand === 'menu' ? $EXPAND_LIMIT : 10);

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

// Services that track bytes rather than tile counts — exclude from tile totals
$byteServices = ['cesium_osm_3d_bytes'];
foreach ($tracked3DServices as $service) {
    if (!isset($tileTotalHour[$service])) $tileTotalHour[$service] = 0;
    if (!isset($tileTotalDay[$service])) $tileTotalDay[$service] = 0;
}
ksort($tileTotalHour);
ksort($tileTotalDay);

function sumTilesOnly($arr, $byteServices) {
    $sum = 0;
    foreach ($arr as $service => $count) {
        if (!in_array($service, $byteServices)) $sum += $count;
    }
    return $sum;
}

$google3DRootHour = $tileTotalHour['google_3d_root'] ?? 0;
$google3DRootDay = $tileTotalDay['google_3d_root'] ?? 0;
$google3DTilesHour = $tileTotalHour['google_3d_tiles'] ?? 0;
$google3DTilesDay = $tileTotalDay['google_3d_tiles'] ?? 0;
$cesiumOSMTilesHour = $tileTotalHour['cesium_osm_3d_tiles'] ?? 0;
$cesiumOSMTilesDay = $tileTotalDay['cesium_osm_3d_tiles'] ?? 0;
$cesiumOSMBytesHour = $tileTotalHour['cesium_osm_3d_bytes'] ?? 0;
$cesiumOSMBytesDay = $tileTotalDay['cesium_osm_3d_bytes'] ?? 0;

$diskSpace = getDiskSpace();
$s3Usage = getS3Usage($expand === 's3' ? $EXPAND_LIMIT : 10);
$aiRequestLogs = loadAIRequestLogs($AI_LOG_FILE, 50);
$aiSpend = summarizeAISpend($statsHistory);
$aiMissingPrices = modelsMissingPrices();

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
        .card-title-link { color: inherit; text-decoration: none; }
        .card-title-link:hover { color: #64ffda; text-decoration: underline; }
        .card-title-link::after { content: " \2197"; opacity: 0.5; font-size: 0.9em; }
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
        .spark-card { margin-bottom: 8px; }
        .spark-card:last-child { margin-bottom: 0; }
        .spark-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px; }
        .spark-label { font-size: 0.75em; color: #8892b0; text-transform: uppercase; }
        .spark-today { font-size: 1.1em; font-weight: 600; color: #64ffda; }
        .spark-card svg { display: block; border-radius: 3px; background: rgba(255,255,255,0.02); }
        .spark-card svg rect { transition: opacity 0.15s; }
        .spark-card svg rect:hover { opacity: 1 !important; }
        .grid-2 { grid-template-columns: repeat(2, 1fr); }
        @media (min-width: 1400px) { .grid-2 { grid-template-columns: repeat(2, 1fr); } }
        .visit-ip { font-family: monospace; font-size: 0.85em; color: #8892b0; }
    </style>
</head>
<body>
    <div class="dashboard">
        <h1>Sitrec Admin Dashboard</h1>

<?php if ($expand): ?>
        <p><a href="admin_dashboard.php" class="refresh-btn">&larr; Back to Dashboard</a></p>
        <div class="grid">
            <div class="card full-width">
<?php if ($expand === 'ai'): ?>
                <h2>Top 200 AI Users (Hour)</h2>
                <table>
                    <tr><th>#</th><th>User</th><th>Requests</th></tr>
                    <?php foreach (array_slice($aiUsage, 0, $EXPAND_LIMIT) as $i => $u): ?>
                    <tr>
                        <td class="user-id"><?= $i + 1 ?></td>
                        <td><?= renderUserLink($u['user_id'], $userNames) ?></td>
                        <td class="highlight"><?= number_format($u['hour_count']) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($aiUsage)): ?><tr><td colspan="3">No data</td></tr><?php endif; ?>
                </table>
<?php elseif ($expand === 'tiles'): ?>
                <h2>Top 200 Tile Users (Day)</h2>
                <table>
                    <tr><th>#</th><th>User</th><th>Tiles</th></tr>
                    <?php foreach (array_slice($tileUsage, 0, $EXPAND_LIMIT) as $i => $u): ?>
                    <tr>
                        <td class="user-id"><?= $i + 1 ?></td>
                        <td><?= renderUserLink($u['user_id'], $userNames) ?></td>
                        <td class="highlight"><?= number_format(sumTilesOnly($u['daily'], $byteServices)) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($tileUsage)): ?><tr><td colspan="3">No data</td></tr><?php endif; ?>
                </table>
<?php elseif ($expand === 'menu'): ?>
                <h2>Top 200 Clicked Menu Items</h2>
                <table>
                    <tr><th>#</th><th>Menu Item</th><th>Clicks</th></tr>
                    <?php $rank = 0; foreach ($topMenuItems as $path => $clicks): $rank++; ?>
                    <tr>
                        <td class="user-id"><?= $rank ?></td>
                        <td><?= htmlspecialchars($path) ?></td>
                        <td class="highlight"><?= number_format($clicks) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($topMenuItems)): ?><tr><td colspan="3">No data</td></tr><?php endif; ?>
                </table>
<?php elseif ($expand === 's3'): ?>
                <h2>Top 200 S3 Users by Space</h2>
                <?php if ($s3Usage['error']): ?>
                <div class="stat-label"><?= htmlspecialchars($s3Usage['error']) ?></div>
                <?php else: ?>
                <table>
                    <tr><th>#</th><th>User</th><th>Size</th><th>Files</th></tr>
                    <?php $rank = 0; foreach ($s3Usage['users'] as $uid => $info): $rank++; ?>
                    <tr>
                        <td class="user-id"><?= $rank ?></td>
                        <td><?= renderUserLink($uid, $userNames) ?></td>
                        <td class="highlight"><?= formatBytes($info['size']) ?></td>
                        <td><?= number_format($info['files']) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($s3Usage['users'])): ?><tr><td colspan="4">No data</td></tr><?php endif; ?>
                </table>
                <?php endif; ?>
<?php endif; ?>
            </div>
        </div>
<?php else: ?>

        <div class="grid">
            <div class="card">
                <h2>AI Usage (This Hour)</h2>
                <div class="stat-value"><?= number_format($aiTotalHour) ?></div>
                <div class="stat-label">Total AI requests across <?= count($aiUsage) ?> users</div>
            </div>

            <div class="card">
                <h2>AI Spend (28 Days)</h2>
                <div class="stat-value"><?= fmtUSD($aiSpend['cost_micros']) ?></div>
                <div class="stat-label">
                    <?= fmtUSD($aiSpend['today_micros']) ?> today &middot;
                    <?= number_format($aiSpend['calls']) ?> provider calls for
                    <?= number_format($aiSpend['requests']) ?> requests
                </div>
                <div class="stat-label">
                    <?php
                    // Cache reads are the whole point of the three-tier system prompt: a high
                    // read share against a low uncached-input share is the fix working.
                    $inTotal = $aiSpend['input'] + $aiSpend['cache_read'] + $aiSpend['cache_write'];
                    $readPct = $inTotal > 0 ? round($aiSpend['cache_read'] / $inTotal * 100) : 0;
                    ?>
                    in <?= number_format($inTotal) ?> tok
                    (<?= $readPct ?>% served from cache) &middot;
                    out <?= number_format($aiSpend['output']) ?> tok
                </div>
                <?php if ($aiSpend['unpriced'] > 0): ?>
                <div class="stat-label" style="color:#fbbf24">
                    <?= number_format($aiSpend['unpriced']) ?> calls on a model with no price on
                    file - the total above is a floor, not the whole bill
                </div>
                <?php endif; ?>
                <?php if (!empty($aiMissingPrices)): ?>
                <div class="stat-label" style="color:#fbbf24">
                    Unpriced models reachable by a tier:
                    <?= htmlspecialchars(implode(', ', $aiMissingPrices)) ?>
                </div>
                <?php endif; ?>
                <?php if (!empty($aiSpend['by_model'])): ?>
                <div class="log-table" style="margin-top:8px">
                    <table>
                        <tr><th>Model</th><th>28-day cost</th></tr>
                        <?php foreach ($aiSpend['by_model'] as $model => $micros): ?>
                        <tr>
                            <td><span class="model-tag"><?= htmlspecialchars($model) ?></span></td>
                            <td><?= fmtUSD($micros) ?></td>
                        </tr>
                        <?php endforeach; ?>
                    </table>
                </div>
                <?php endif; ?>
            </div>
            
            <div class="card">
                <h2>Tile Usage (This Hour)</h2>
                <div class="stat-value"><?= number_format(sumTilesOnly($tileTotalHour, $byteServices)) ?></div>
                <div class="stat-label">Total tiles across <?= count($tileUsage) ?> users</div>
            </div>
            
            <div class="card">
                <h2>Tile Usage (Today)</h2>
                <div class="stat-value"><?= number_format(sumTilesOnly($tileTotalDay, $byteServices)) ?></div>
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
        
        <div class="grid grid-2">
            <div class="card">
                <h2>28-Day Usage History</h2>
                <?= renderSparkGraph($statsHistory, 'visits', 'Visits', 'number_format', '#64ffda') ?>
                <?= renderSparkGraph($statsHistory, 'unique_users', 'Unique Users', 'number_format', '#7ec8e3') ?>
                <?= renderSparkGraph($statsHistory, 'unique_ips', 'Unique IPs', 'number_format', '#c084fc') ?>
                <?= renderSparkGraph($statsHistory, 'ai_requests', 'AI Requests', 'number_format', '#fbbf24') ?>
                <?= renderSparkGraph($statsHistory, 'ai_calls', 'AI Provider Calls', 'number_format', '#fb923c') ?>
                <?= renderSparkGraph($statsHistory, 'ai_cost_micros', 'AI Cost', 'fmtUSD', '#f87171') ?>
            </div>
            <div class="card">
                <h2>28-Day Tile History</h2>
                <?php
                // Calculate tiles_total (excluding byte services) per day for the graph
                $tileHistoryForGraph = $statsHistory;
                $byteKeys = array_flip($byteServices);
                foreach ($tileHistoryForGraph as $date => &$day) {
                    $total = 0;
                    foreach ($day as $k => $v) {
                        if (!isset($byteKeys[$k]) && !in_array($k, ['ai_requests', 'visits', 'unique_users', 'unique_ips'])) {
                            $total += $v;
                        }
                    }
                    $day['tiles_total'] = $total;
                }
                unset($day);
                ?>
                <?= renderSparkGraph($tileHistoryForGraph, 'tiles_total', 'Total Tiles', 'number_format', '#64ffda') ?>
                <?= renderSparkGraph($statsHistory, 'google_3d_root', 'Google 3D Root', 'number_format', '#f87171') ?>
                <?= renderSparkGraph($statsHistory, 'google_3d_tiles', 'Google 3D Tiles', 'number_format', '#fb923c') ?>
                <?= renderSparkGraph($statsHistory, 'cesium_osm_3d_bytes', 'Cesium OSM BW', 'formatBytes', '#a78bfa') ?>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h2>Visitors Today (<?= count($todayVisits['users']) ?> users, <?= count($todayVisits['ips']) ?> IPs)</h2>
                <table>
                    <tr><th>User</th><th>Visits</th><th>IP</th><th>IP Visits</th></tr>
                    <?php
                    // Merge user and IP data for display
                    arsort($todayVisits['users']);
                    $visitUserIds = array_keys($todayVisits['users']);
                    $visitUserNames = getUserNames(array_map(fn($id) => is_numeric($id) ? (int)$id : $id, $visitUserIds));
                    foreach (array_slice($todayVisits['users'], 0, 20, true) as $uid => $count):
                        // Find most recent IP for this user
                        $userIp = '';
                        foreach (array_reverse($todayVisits['entries']) as $entry) {
                            if (strval($entry['user_id']) === strval($uid)) {
                                $userIp = $entry['ip'];
                                break;
                            }
                        }
                        $ipCount = $todayVisits['ips'][$userIp] ?? 0;
                    ?>
                    <tr>
                        <td><?= renderUserLink(is_numeric($uid) ? (int)$uid : $uid, $visitUserNames) ?></td>
                        <td class="highlight"><?= number_format($count) ?></td>
                        <td class="visit-ip"><a href="https://whatismyipaddress.com/ip/<?= htmlspecialchars($userIp) ?>" target="_blank" rel="noopener" class="sitch-link"><?= htmlspecialchars($userIp) ?></a></td>
                        <td><?= number_format($ipCount) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($todayVisits['users'])): ?>
                    <tr><td colspan="4">No visits recorded today</td></tr>
                    <?php endif; ?>
                </table>
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
                <h2><a class="card-title-link" href="?expand=ai">Top 10 AI Users (Hour)</a></h2>
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
                <h2><a class="card-title-link" href="?expand=tiles">Top 10 Tile Users (Day)</a></h2>
                <table>
                    <tr><th>User</th><th>Tiles</th></tr>
                    <?php foreach (array_slice($tileUsage, 0, 10) as $u): ?>
                    <tr>
                        <td><?= renderUserLink($u['user_id'], $userNames) ?></td>
                        <td class="highlight"><?= number_format(sumTilesOnly($u['daily'], $byteServices)) ?></td>
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
                <h2><a class="card-title-link" href="?expand=menu">Top 10 Clicked Menu Items</a></h2>
                <table>
                    <tr><th>Menu Item</th><th>Clicks</th></tr>
                    <?php foreach ($topMenuItems as $path => $clicks): ?>
                    <tr>
                        <td><?= htmlspecialchars($path) ?></td>
                        <td class="highlight"><?= number_format($clicks) ?></td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($topMenuItems)): ?>
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
                <h2><a class="card-title-link" href="?expand=s3">Top 10 S3 Users by Space</a></h2>
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
                    $linkUrl = $isSitch ? '../?custom=' . urlencode($key) : $s3Url;
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
                        <tr><th>Time</th><th>User</th><th>Model</th><th>Calls</th><th>Tokens (in/out)</th><th>Cost</th><th>Prompt</th></tr>
                        <?php foreach ($aiRequestLogs as $log): ?>
                        <?php
                            // Rows written before this request finished - or by a build that
                            // did not record usage - simply have none. Show a dash rather
                            // than a fabricated zero.
                            $u = $log['usage'] ?? null;
                            $inTok = $u ? ($u['inputTokens'] ?? 0) + ($u['cacheReadTokens'] ?? 0) + ($u['cacheWriteTokens'] ?? 0) : null;
                        ?>
                        <tr>
                            <td><?= date('Y-m-d H:i:s', $log['timestamp']) ?></td>
                            <td><?= renderUserLink($log['user_id'], $userNames) ?></td>
                            <td><span class="model-tag"><?= htmlspecialchars($log['model'] ?? 'default') ?></span></td>
                            <td><?= $u ? number_format($u['calls'] ?? 0) : '-' ?></td>
                            <td><?= $u ? number_format($inTok) . ' / ' . number_format($u['outputTokens'] ?? 0) : '-' ?></td>
                            <td><?= array_key_exists('cost_micros', $log) ? fmtUSD($log['cost_micros']) : '-' ?></td>
                            <td><div class="prompt-text"><?= htmlspecialchars($log['prompt']) ?></div></td>
                        </tr>
                        <?php endforeach; ?>
                        <?php if (empty($aiRequestLogs)): ?>
                        <tr><td colspan="7">No AI requests logged</td></tr>
                        <?php endif; ?>
                    </table>
                </div>
            </div>
        </div>
<?php endif; // end !$expand dashboard body ?>

        <div class="timestamp">
            Last updated: <?= date('Y-m-d H:i:s') ?>
            <a href="<?= $expand ? '?expand=' . htmlspecialchars($expand) : '?' ?>" class="refresh-btn">Refresh</a>
        </div>
    </div>
</body>
</html>
