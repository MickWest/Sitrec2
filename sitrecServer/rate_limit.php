<?php
/**
 * Per-IP rate limiting shared by the proxies.
 *
 *   require_once __DIR__ . '/rate_limit.php';
 *   if (!sitrecConsumeRateToken('adsbx', 10)) { ...answer 429... }
 *
 * Each bucket keeps one small JSON counter per client IP in
 * sys_get_temp_dir()/sitrec_<bucket>_ratelimit/.
 *
 * Only proxyADSBx.php, proxyFlySFO.php and windProxy.php use this so far. The
 * other endpoints still carry their own copies: proxyADSBLive.php,
 * proxyADSBTrace.php, proxyLiveFeed.php and streetview.php (locked), and
 * proxy.php, proxyStarlink.php, proxySounding.php, dvidsVideo.php,
 * shortener.php, logNLU.php and uilog.php (an unlocked read-increment-write,
 * which parallel requests can get past). New code should call this instead.
 */

/**
 * The address a rate-limit bucket is keyed on: the transport peer, never
 * CF-Connecting-IP or X-Forwarded-For. Those headers come from the client
 * unless a proxy in front overwrites them, and nothing here knows which proxies
 * to trust, so honouring them lets a caller pick a fresh bucket per request.
 * A deployment behind a reverse proxy should set REMOTE_ADDR with Apache's
 * mod_remoteip (see docs/dev/Deploying-on-a-VPS.md).
 */
function sitrecRateLimitClientIP() {
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

/**
 * Atomically consume one token from the caller's bucket: at most $limit per
 * $windowSec seconds. The whole read-increment-write runs under flock(), so
 * parallel requests from one IP serialize on the counter instead of all
 * observing the same count and bypassing the limit. Returns true when a token
 * was granted. Fails OPEN on filesystem trouble — a broken temp dir must
 * degrade the limiter, not the proxy.
 */
function sitrecConsumeRateToken($bucket, $limit, $windowSec = 60) {
    $dir = sys_get_temp_dir() . '/sitrec_' . $bucket . '_ratelimit/';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $fh = @fopen($dir . md5(sitrecRateLimitClientIP()) . '.json', 'c+');
    if ($fh === false) return true;
    if (!flock($fh, LOCK_EX)) { fclose($fh); return true; }
    $now = time();
    $raw = stream_get_contents($fh);
    $rateData = $raw ? json_decode($raw, true) : null;
    if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
        $rateData = ['count' => 0, 'reset' => $now + $windowSec];
    }
    $allowed = $rateData['count'] < $limit;
    if ($allowed) {
        $rateData['count']++;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($rateData));
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    return $allowed;
}
