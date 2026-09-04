<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';
sitrecAuditRequest('administrator.user_read');

$userInfo = getUserInfo();
$currentUserId = $userInfo['user_id'];

if (!isAdmin($userInfo)) {
    http_response_code(403);
    die('Admin access required');
}

if (!isset($_GET['user']) || !is_numeric($_GET['user'])) {
    http_response_code(400);
    die('Invalid user parameter');
}

$targetUserId = (int)$_GET['user'];
sitrecAuditResource('user/' . $targetUserId);

function getXFUserInfo($userId) {
    $info = ['username' => 'Unknown', 'ip' => 'Unknown'];
    
    if (class_exists('\XF')) {
        try {
            $user = \XF::finder('XF:User')->where('user_id', $userId)->fetchOne();
            if ($user) {
                $info['username'] = $user->username;
                
                $ip = \XF::finder('XF:Ip')
                    ->where('user_id', $userId)
                    ->order('log_date', 'DESC')
                    ->fetchOne();
                if ($ip) {
                    $info['ip'] = inet_ntop($ip->ip);
                }
            }
        } catch (Exception $e) {
            sitrecAuditWrite('administrator.lookup', 'failure', 'storage_error');
            sitrecAuditResult('failure', 'storage_error');
        }
    }
    
    return $info;
}

function getUserSitches($userId) {
    global $useAWS, $s3creds, $UPLOAD_PATH, $UPLOAD_URL;
    
    $sitches = [];
    $userDir = strval($userId);
    
    if ($useAWS && isset($s3creds) && !empty($s3creds['bucket'])) {
        try {
            require_once __DIR__ . '/s3_client.php';
            
            $s3 = getS3Client();
            
            $objects = $s3->getIterator('ListObjects', [
                'Bucket' => $s3creds['bucket'],
                'Prefix' => $userDir . '/'
            ]);
            
            $sitchVersions = [];
            foreach ($objects as $object) {
                $key = $object['Key'];
                $parts = explode('/', $key);
                if (count($parts) >= 3 && $parts[1] !== '' && $parts[2] !== '') {
                    $sitchName = $parts[1];
                    $version = $parts[2];
                    // Only consider properly formatted sitch files (YYYYMMDD_HHMMSS.js)
                    if (!preg_match('/^\d{8}_\d{6}\.js$/', $version)) continue;
                    $url = $s3->getObjectUrl($s3creds['bucket'], $key);
                    if (!isset($sitchVersions[$sitchName]) || $object['LastModified'] > $sitchVersions[$sitchName]['lastModified']) {
                        $sitchVersions[$sitchName] = [
                            'name' => $sitchName,
                            'lastModified' => $object['LastModified'],
                            'url' => $url
                        ];
                    }
                }
            }
            foreach ($sitchVersions as $sitch) {
                $sitches[] = [
                    'name' => $sitch['name'],
                    'lastModified' => $sitch['lastModified']->format('Y-m-d H:i:s'),
                    'url' => $sitch['url']
                ];
            }
        } catch (Exception $e) {
            sitrecAuditWrite('administrator.lookup', 'failure', 'storage_error');
            sitrecAuditResult('failure', 'storage_error');
        }
    } else {
        $fullPath = $UPLOAD_PATH . $userDir;
        if (is_dir($fullPath)) {
            $dirs = @scandir($fullPath);
            if ($dirs !== false) {
                foreach ($dirs as $dir) {
                    if ($dir !== '.' && $dir !== '..' && is_dir($fullPath . '/' . $dir)) {
                        $sitchPath = $fullPath . '/' . $dir;
                        $versions = @scandir($sitchPath);
                        $latestVersion = null;
                        $latestTime = 0;
                        if ($versions !== false) {
                            foreach ($versions as $v) {
                                // Only consider properly formatted sitch files (YYYYMMDD_HHMMSS.js)
                                if ($v !== '.' && $v !== '..' && is_file($sitchPath . '/' . $v) && preg_match('/^\d{8}_\d{6}\.js$/', $v)) {
                                    $vTime = @filemtime($sitchPath . '/' . $v);
                                    if ($vTime > $latestTime) {
                                        $latestTime = $vTime;
                                        $latestVersion = $v;
                                    }
                                }
                            }
                        }
                        $url = $latestVersion ? $UPLOAD_URL . $userDir . '/' . $dir . '/' . $latestVersion : null;
                        $sitches[] = [
                            'name' => $dir,
                            'lastModified' => $latestTime ? date('Y-m-d H:i:s', $latestTime) : 'Unknown',
                            'url' => $url
                        ];
                    }
                }
            }
        }
    }
    
    usort($sitches, fn($a, $b) => strcmp($b['lastModified'], $a['lastModified']));
    return $sitches;
}

$targetUserInfo = getXFUserInfo($targetUserId);
$sitches = getUserSitches($targetUserId);

?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User Info - <?= htmlspecialchars($targetUserInfo['username']) ?></title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #e4e4e4;
            padding: 10px;
            font-size: 13px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header-row { display: flex; align-items: center; gap: 20px; margin-bottom: 12px; flex-wrap: wrap; }
        h1 { font-weight: 300; font-size: 1.6em; color: #fff; margin: 0; }
        .back-link { color: #64ffda; text-decoration: none; font-size: 0.9em; }
        .back-link:hover { text-decoration: underline; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
        @media (min-width: 900px) { .grid { grid-template-columns: 300px 1fr; } }
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
        .info-row { display: flex; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #8892b0; width: 80px; flex-shrink: 0; font-size: 0.85em; }
        .info-value { color: #ccd6f6; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 6px 4px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
        th { color: #8892b0; font-weight: 500; font-size: 0.75em; text-transform: uppercase; }
        td { color: #ccd6f6; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .sitch-link { color: #64ffda; text-decoration: none; }
        .sitch-link:hover { text-decoration: underline; }
        .empty { color: #8892b0; font-style: italic; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-row">
            <a href="admin_dashboard.php" class="back-link">&larr; Dashboard</a>
            <h1>User: <?= htmlspecialchars($targetUserInfo['username']) ?> #<?= htmlspecialchars($targetUserId) ?></h1>
        </div>
        
        <div class="grid">
            <div class="card">
                <h2>User Details</h2>
                <div class="info-row">
                    <span class="info-label">User ID</span>
                    <span class="info-value"><?= htmlspecialchars($targetUserId) ?></span>
                </div>
                <div class="info-row">
                    <span class="info-label">Username</span>
                    <span class="info-value"><?= htmlspecialchars($targetUserInfo['username']) ?></span>
                </div>
                <div class="info-row">
                    <span class="info-label">Last IP</span>
                    <span class="info-value"><a href="https://whatismyipaddress.com/ip/<?= htmlspecialchars($targetUserInfo['ip']) ?>" target="_blank" rel="noopener" style="color:#64ffda;text-decoration:none;"><?= htmlspecialchars($targetUserInfo['ip']) ?></a></span>
                </div>
            </div>
            
            <div class="card">
                <h2>Saved Sitches (<?= count($sitches) ?>)</h2>
                <?php if (empty($sitches)): ?>
                <p class="empty">No saved sitches found</p>
                <?php else: ?>
                <table>
                    <tr><th>Name</th><th>Last Modified</th></tr>
                    <?php foreach ($sitches as $sitch): ?>
                    <tr>
                        <td><?php if ($sitch['url']): ?><a href="../?custom=<?= urlencode($sitch['url']) ?>" class="sitch-link"><?= htmlspecialchars($sitch['name']) ?></a><?php else: ?><?= htmlspecialchars($sitch['name']) ?><?php endif; ?></td>
                        <td><?= htmlspecialchars($sitch['lastModified']) ?></td>
                    </tr>
                    <?php endforeach; ?>
                </table>
                <?php endif; ?>
            </div>
        </div>
    </div>
</body>
</html>

<?php sitrecAuditResult(); ?>
