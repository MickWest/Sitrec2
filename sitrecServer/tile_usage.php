<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

header('Content-Type: application/json');

if (!getenv('SITREC_TRACK_STATS')) {
    echo json_encode(['disabled' => true, 'message' => 'Stats tracking disabled']);
    exit;
}

$userInfo = getUserInfo();
$userId = $userInfo['user_id'];
$userGroups = $userInfo['user_groups'];
$isGuest = false;

if ($userId <= 0) {
    $isGuest = true;
    if (isset($_COOKIE['sitrec_guest_id'])) {
        $guestId = preg_replace('/[^a-f0-9]/i', '', $_COOKIE['sitrec_guest_id']);
        if (strlen($guestId) === 32) {
            $userId = 'guest_' . $guestId;
        }
    }
    if ($userId <= 0) {
        $guestId = bin2hex(random_bytes(16));
        setcookie('sitrec_guest_id', $guestId, time() + 86400 * 30, '/', '', true, true);
        $userId = 'guest_' . $guestId;
    }
    $userGroups = [0];
}

// Tile service rate limits by user group (tiles per hour).
// For Google/Cesium 3D tracking:
// - google_3d_root is controlled primarily by DAILY limits below.
// - google_3d_tiles and cesium_osm_3d_tiles are tracked for audit but
//   effectively not hourly-limited here.
// Groups: admin=3, registered=2, verified=9, sitrec=14
// Services: mapbox, maptiler, aws, osm, eox, esri, google_3d_root,
//           google_3d_tiles, cesium_osm_3d_tiles, cesium_osm_3d_bytes, other
$UNLIMITED_TILE_RATE = 1000000000;
$TILE_RATE_LIMITS = [
    3 => [ // admin - effectively unlimited
        'mapbox' => 1000000,
        'maptiler' => 1000000,
        'aws' => 1000000,
        'osm' => 1000000,
        'eox' => 1000000,
        'esri' => 1000000,
        'google_3d_root' => 1000000,
        'google_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
        'other' => 1000000,
    ],
    14 => [ // sitrec - premium
        'mapbox' => 5000,
        'maptiler' => 5000,
        'aws' => 50000,
        'osm' => 50000,
        'eox' => 20000,
        'esri' => 50000,
        'google_3d_root' => 1000000,
        'google_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
        'other' => 10000,
    ],
    9 => [ // verified - mid tier
        'mapbox' => 2000,
        'maptiler' => 2000,
        'aws' => 20000,
        'osm' => 20000,
        'eox' => 10000,
        'esri' => 20000,
        'google_3d_root' => 1000000,
        'google_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
        'other' => 5000,
    ],
    2 => [ // registered - basic
        'mapbox' => 500,
        'maptiler' => 500,
        'aws' => 10000,
        'osm' => 10000,
        'eox' => 5000,
        'esri' => 10000,
        'google_3d_root' => 1000000,
        'google_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
        'other' => 2000,
    ],
    19 => [ // sitrec plus
        'mapbox' => 5000,
        'maptiler' => 5000,
        'aws' => 50000,
        'osm' => 50000,
        'eox' => 20000,
        'esri' => 50000,
        'google_3d_root' => 1000000,
        'google_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
        'other' => 10000,
    ],
    0 => [ // guest - minimal
        'mapbox' => 200,
        'maptiler' => 200,
        'aws' => 5000,
        'osm' => 5000,
        'eox' => 2000,
        'esri' => 5000,
        'google_3d_root' => 1000000,
        'google_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
        'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
        'other' => 1000,
    ],
];

// Default limits for unrecognized groups
$DEFAULT_LIMITS = [
    'mapbox' => 100,
    'maptiler' => 100,
    'aws' => 5000,
    'osm' => 5000,
    'eox' => 2000,
    'esri' => 5000,
    'google_3d_root' => 1000000,
    'google_3d_tiles' => $UNLIMITED_TILE_RATE,
    'cesium_osm_3d_tiles' => $UNLIMITED_TILE_RATE,
    'cesium_osm_3d_bytes' => $UNLIMITED_TILE_RATE * 1024,
    'other' => 1000,
];

// Daily limits by user group. This enforces Google 3D root/session requests.
$CESIUM_OSM_DAILY_BYTES_LIMIT = intdiv(1024 * 1024 * 1024, 30); // 1 GiB / 30 days per day
$TILE_DAILY_LIMITS = [
    3 => [ // admin
        'google_3d_root' => 1000000,
        'cesium_osm_3d_bytes' => 1000000000000,
    ],
    14 => [ // Meta Members
        'google_3d_root' => 30,
        'cesium_osm_3d_bytes' => $CESIUM_OSM_DAILY_BYTES_LIMIT,
    ],
    19 => [ // Sitrec Plus
        'google_3d_root' => 30,
        'cesium_osm_3d_bytes' => $CESIUM_OSM_DAILY_BYTES_LIMIT,
    ],
];

$DEFAULT_DAILY_LIMITS = [
    // No Google 3D root sessions unless user is in an allowed group above.
    'google_3d_root' => 0,
    'cesium_osm_3d_bytes' => 0,
];

$TILE_USAGE_DIR = sys_get_temp_dir() . '/sitrec_tile_usage/';

function getTileLimitsForUser($userGroups) {
    global $TILE_RATE_LIMITS, $DEFAULT_LIMITS;
    
    $limits = $DEFAULT_LIMITS;
    
    foreach ($userGroups as $group) {
        if (isset($TILE_RATE_LIMITS[$group])) {
            foreach ($TILE_RATE_LIMITS[$group] as $service => $limit) {
                $limits[$service] = max($limits[$service] ?? 0, $limit);
            }
        }
    }
    
    return $limits;
}

function getTileDailyLimitsForUser($userGroups) {
    global $TILE_DAILY_LIMITS, $DEFAULT_DAILY_LIMITS;

    $limits = $DEFAULT_DAILY_LIMITS;

    foreach ($userGroups as $group) {
        if (isset($TILE_DAILY_LIMITS[$group])) {
            foreach ($TILE_DAILY_LIMITS[$group] as $service => $limit) {
                $limits[$service] = max($limits[$service] ?? 0, $limit);
            }
        }
    }

    return $limits;
}

function getUserUsageFile($userId, $usageDir) {
    return $usageDir . "user_{$userId}.json";
}

function loadUserUsage($userId, $usageDir) {
    $file = getUserUsageFile($userId, $usageDir);
    $now = time();
    
    if (!file_exists($file)) {
        return [
            'hourly' => [],
            'daily' => [],
            'hourReset' => $now + 3600,
            'dayReset' => $now + 86400,
        ];
    }
    
    $data = json_decode(file_get_contents($file), true);
    if (!$data) {
        return [
            'hourly' => [],
            'daily' => [],
            'hourReset' => $now + 3600,
            'dayReset' => $now + 86400,
        ];
    }
    
    // Reset hourly counts if hour has passed
    if ($now > ($data['hourReset'] ?? 0)) {
        $data['hourly'] = [];
        $data['hourReset'] = $now + 3600;
    }
    
    // Reset daily counts if day has passed
    if ($now > ($data['dayReset'] ?? 0)) {
        $data['daily'] = [];
        $data['dayReset'] = $now + 86400;
    }
    
    return $data;
}

function saveUserUsage($userId, $usageDir, $data) {
    if (!is_dir($usageDir)) {
        @mkdir($usageDir, 0755, true);
    }
    $file = getUserUsageFile($userId, $usageDir);
    file_put_contents($file, json_encode($data), LOCK_EX);
}

// Handle GET request - fetch current usage and limits
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $limits = getTileLimitsForUser($userGroups);
    $dailyLimits = getTileDailyLimitsForUser($userGroups);
    $usage = loadUserUsage($userId, $TILE_USAGE_DIR);
    
    $remaining = [];
    foreach ($limits as $service => $limit) {
        $used = $usage['hourly'][$service] ?? 0;
        $remaining[$service] = max(0, $limit - $used);
    }

    $dailyRemaining = [];
    foreach ($dailyLimits as $service => $limit) {
        $used = $usage['daily'][$service] ?? 0;
        $dailyRemaining[$service] = max(0, $limit - $used);
    }
    
    echo json_encode([
        'userId' => $userId,
        'isGuest' => $isGuest,
        'userGroups' => $userGroups,
        'limits' => $limits,
        'dailyLimits' => $dailyLimits,
        'usage' => $usage['hourly'],
        'remaining' => $remaining,
        'dailyRemaining' => $dailyRemaining,
        'hourReset' => $usage['hourReset'],
        'dailyUsage' => $usage['daily'],
    ]);
    exit;
}

// Handle POST request - report usage
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    
    if (!$input || !isset($input['usage'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid request body']);
        exit;
    }
    
    $reportedUsage = $input['usage'];
    $limits = getTileLimitsForUser($userGroups);
    $dailyLimits = getTileDailyLimitsForUser($userGroups);
    $currentUsage = loadUserUsage($userId, $TILE_USAGE_DIR);
    
    $warnings = [];
    $blocked = [];
    
    // Validate and accumulate usage
    foreach ($reportedUsage as $service => $count) {
        // Sanitize service name
        $service = preg_replace('/[^a-z0-9_-]/i', '', $service);
        if (empty($service)) continue;
        
        // Sanitize count
        $count = max(0, intval($count));
        if ($count <= 0) continue;
        
        // Add to hourly usage
        $currentUsage['hourly'][$service] = ($currentUsage['hourly'][$service] ?? 0) + $count;
        
        // Add to daily usage (for audit purposes)
        $currentUsage['daily'][$service] = ($currentUsage['daily'][$service] ?? 0) + $count;
        
        // Check hourly limit
        $limit = $limits[$service] ?? $limits['other'] ?? 1000;
        if ($currentUsage['hourly'][$service] > $limit) {
            $blocked[$service] = [
                'used' => $currentUsage['hourly'][$service],
                'limit' => $limit,
                'window' => 'hourly',
            ];
        } elseif ($currentUsage['hourly'][$service] > $limit * 0.8) {
            $warnings[$service] = [
                'used' => $currentUsage['hourly'][$service],
                'limit' => $limit,
                'remaining' => $limit - $currentUsage['hourly'][$service],
                'window' => 'hourly',
            ];
        }

        // Check daily limit for services that define one
        if (isset($dailyLimits[$service])) {
            $dailyLimit = $dailyLimits[$service];
            if ($currentUsage['daily'][$service] > $dailyLimit) {
                $blocked[$service] = [
                    'used' => $currentUsage['daily'][$service],
                    'limit' => $dailyLimit,
                    'window' => 'daily',
                ];
            } elseif ($currentUsage['daily'][$service] > $dailyLimit * 0.8) {
                $warnings[$service] = [
                    'used' => $currentUsage['daily'][$service],
                    'limit' => $dailyLimit,
                    'remaining' => $dailyLimit - $currentUsage['daily'][$service],
                    'window' => 'daily',
                ];
            }
        }
    }
    
    saveUserUsage($userId, $TILE_USAGE_DIR, $currentUsage);
    
    $remaining = [];
    foreach ($limits as $service => $limit) {
        $used = $currentUsage['hourly'][$service] ?? 0;
        $remaining[$service] = max(0, $limit - $used);
    }

    $dailyRemaining = [];
    foreach ($dailyLimits as $service => $limit) {
        $used = $currentUsage['daily'][$service] ?? 0;
        $dailyRemaining[$service] = max(0, $limit - $used);
    }
    
    echo json_encode([
        'success' => true,
        'usage' => $currentUsage['hourly'],
        'remaining' => $remaining,
        'dailyRemaining' => $dailyRemaining,
        'warnings' => $warnings,
        'blocked' => $blocked,
        'hourReset' => $currentUsage['hourReset'],
        'dayReset' => $currentUsage['dayReset'],
    ]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
