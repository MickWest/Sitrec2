<?php
// stats_history.php - 28-day stats history recording and retrieval

require_once __DIR__ . '/config_paths.php';

// The visit and UI logs hold user ids and IP addresses, so they live in the private temp dir
// like the other per-user state (ai_log.php, tile_usage.php), never under sitrec-cache/ or
// sitrec-upload/, which the web server publishes. $legacyDir is where an earlier version
// wrote them: its files are moved here on first use, so that they stop being served.
function getPrivateStatsDir($name, $legacyDir) {
    static $migrated = [];
    $dir = rtrim(sys_get_temp_dir(), '/') . '/' . $name . '/';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    if (!isset($migrated[$dir])) {
        $migrated[$dir] = true;
        moveLegacyStatsFiles($legacyDir, $dir);
    }
    return $dir;
}

// Best effort: a file that cannot be moved stays where it is and the request carries on.
// A file already in the new directory is newer than the old copy, so it is never replaced.
//
// The move runs under a lock in the new directory. A request that arrives during the move
// waits for it, then finds the old directory gone and does nothing. Without the lock it would
// see a file that is not yet complete, take it as moved and delete the old copy.
function moveLegacyStatsFiles($legacyDir, $dir) {
    if (!$legacyDir || !is_dir($legacyDir) || !is_dir($dir)) return;
    if (realpath($legacyDir) === realpath($dir)) return;
    $lock = @fopen($dir . '.migration.lock', 'c');
    if ($lock === false) return;
    if (!flock($lock, LOCK_EX)) { fclose($lock); return; }
    clearstatcache();
    if (is_dir($legacyDir)) {
        foreach (glob($legacyDir . '*') ?: [] as $old) {
            if (!is_file($old)) continue;
            $new = $dir . basename($old);
            if (file_exists($new) || copyIntoPlace($old, $new)) {
                @unlink($old);
            }
        }
        @rmdir($legacyDir);
    }
    flock($lock, LOCK_UN);
    fclose($lock);
}

// The two directories are often on different mounts, where rename() falls back to copying
// straight to the final name. So the file is copied to a hidden name beside its final name
// and renamed into place, which is atomic within one directory: $new is either absent or
// complete. A copy that comes out short (a full disk) is discarded.
function copyIntoPlace($old, $new) {
    $tmp = dirname($new) . '/.' . basename($new) . '.migrating';
    if (@copy($old, $tmp)) {
        clearstatcache();
        if (filesize($tmp) === filesize($old) && @rename($tmp, $new)) return true;
    }
    @unlink($tmp);
    return false;
}

function getStatsDir() {
    global $CACHE_PATH;
    return getPrivateStatsDir('sitrec-stats', isset($CACHE_PATH) ? $CACHE_PATH . 'sitrec-stats/' : null);
}

function getUIStatsDir() {
    global $UPLOAD_PATH;
    return getPrivateStatsDir('sitrec-ui-stats', isset($UPLOAD_PATH) ? $UPLOAD_PATH . 'ui-stats/' : null);
}

function getStatsHistoryFile() {
    return getStatsDir() . 'history.json';
}

function getVisitsFile($date) {
    return getStatsDir() . 'visits_' . $date . '.json';
}

function loadStatsHistory() {
    $file = getStatsHistoryFile();
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveStatsHistory($history) {
    // Prune to last 28 days
    ksort($history);
    while (count($history) > 28) {
        array_shift($history);
    }
    $file = getStatsHistoryFile();
    file_put_contents($file, json_encode($history), LOCK_EX);
}

// Record incremental stats for today. $stats is an associative array of key => increment.
function recordDailyStats($stats) {
    $today = date('Y-m-d');
    $history = loadStatsHistory();
    if (!isset($history[$today])) {
        $history[$today] = [];
    }
    foreach ($stats as $key => $value) {
        $history[$today][$key] = ($history[$today][$key] ?? 0) + $value;
    }
    saveStatsHistory($history);
}

// A day's visits file is read and rewritten whole on every visit, so its size sets the cost
// of each visit. Once the file reaches this size, the rest of the day's visits are not
// recorded. An entry is about 100 bytes, so this holds about 20,000 visits.
const VISITS_FILE_MAX_BYTES = 2097152;

// Record a visit with user ID and IP address
function recordVisit($userId, $ip, $sitch = null) {
    $today = date('Y-m-d');
    $file = getVisitsFile($today);

    // The read, append and write run under one lock, so two visits at the same time cannot
    // both read the old file (losing one entry), and no visit reads a file that another
    // visit is halfway through writing.
    $fh = @fopen($file, 'c+');
    if ($fh === false) return;
    if (!flock($fh, LOCK_EX)) { fclose($fh); return; }
    if (fstat($fh)['size'] >= VISITS_FILE_MAX_BYTES) {
        flock($fh, LOCK_UN);
        fclose($fh);
        return;
    }

    $data = ['entries' => [], 'users' => [], 'ips' => []];
    $raw = stream_get_contents($fh);
    if ($raw) {
        $loaded = json_decode($raw, true);
        if (is_array($loaded)) $data = $loaded;
    }

    $data['entries'][] = [
        'user_id' => $userId,
        'ip' => $ip,
        'time' => time(),
        'sitch' => $sitch,
    ];

    $uid = strval($userId);
    $data['users'][$uid] = ($data['users'][$uid] ?? 0) + 1;
    $data['ips'][$ip] = ($data['ips'][$ip] ?? 0) + 1;

    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($data));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);

    // Also update stats history with visit counts
    $history = loadStatsHistory();
    if (!isset($history[$today])) $history[$today] = [];
    $history[$today]['visits'] = ($history[$today]['visits'] ?? 0) + 1;
    $history[$today]['unique_users'] = count($data['users']);
    $history[$today]['unique_ips'] = count($data['ips']);
    saveStatsHistory($history);

    // Clean up visit files older than 28 days
    $cutoff = date('Y-m-d', strtotime('-28 days'));
    foreach (glob(getStatsDir() . 'visits_*.json') as $vf) {
        if (preg_match('/visits_(\d{4}-\d{2}-\d{2})\.json/', basename($vf), $m)) {
            if ($m[1] < $cutoff) @unlink($vf);
        }
    }
}

// Return 28 days of history, keyed by date, oldest first
function getStatsHistory28() {
    $history = loadStatsHistory();
    $result = [];
    for ($i = 27; $i >= 0; $i--) {
        $date = date('Y-m-d', strtotime("-{$i} days"));
        $result[$date] = $history[$date] ?? [];
    }
    return $result;
}

// Return visit details for a specific date
function getVisitDetails($date) {
    $file = getVisitsFile($date);
    if (!file_exists($file)) return ['entries' => [], 'users' => [], 'ips' => []];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : ['entries' => [], 'users' => [], 'ips' => []];
}
