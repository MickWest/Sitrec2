<?php
// Shared helpers for General Perturbations (GP) satellite element data.
//
// Sitrec requests GP data in the CCSDS OMM CSV format rather than the legacy
// TLE format. The TLE format cannot express catalog numbers above 99999 and the
// catalog passed that limit on 2026-07-11, so both CelesTrak and Space-Track
// omit newer objects from TLE feeds entirely. CSV has no such limit, keeps the
// full-precision epoch, and is slightly smaller on the wire than TLE.
// Sitrec still parses TLE (see src/TLEUtils.ts) so older cached files and
// user-supplied .tle files keep working.

/**
 * Does this response actually look like the GP data we asked for?
 *
 * Upstream failures arrive as 200-adjacent junk rather than as network errors:
 * CelesTrak answers a too-early re-request with HTTP 403 and a plain-text
 * "GP data has not updated since your last successful download" body, and
 * Space-Track can return an HTML error page. Without this check that text gets
 * written into the cache and served as satellite data for the whole cache
 * lifetime, leaving the user with an empty sky and no explanation.
 *
 * @param string|false $dataBlob     Raw response body.
 * @param int          $httpStatus   HTTP status the body came with.
 * @param string       $ext          "csv" for OMM CSV, otherwise TLE-family.
 * @return bool
 */
function isValidGPData($dataBlob, $httpStatus, $ext) {
    if ($dataBlob === false || strlen($dataBlob) === 0) {
        return false;
    }
    if ($httpStatus !== 200) {
        return false;
    }

    // Inspect a bounded prefix, never the whole payload. A Space-Track LEO
    // query runs to ~35 MB, and ltrim()/trim() on that allocates a second
    // copy of it - enough on its own to exhaust a 128 MB memory_limit.
    // Everything below is decided by the first line or two.
    $prefix = ltrim(substr($dataBlob, 0, 65536));

    if (stripos($prefix, '<!DOCTYPE') === 0 || stripos($prefix, '<html') === 0) {
        return false;
    }

    if ($ext === "csv") {
        // Every OMM CSV starts with a header row naming the OMM keywords.
        return strpos($prefix, "NORAD_CAT_ID") !== false;
    }

    // TLE / 2LE / 3LE: element lines are numbered "1 " and "2 ".
    return preg_match('/^1 .{20}/m', $prefix) === 1
        && preg_match('/^2 .{20}/m', $prefix) === 1;
}

/**
 * How many days after the requested date a historical query stops growing.
 *
 * Space-Track publishes an element set AFTER its epoch, and the queries span
 * [D, D+2], so a set fetched too soon holds only what happened to be published
 * by then. Measured over 59,608 real element sets, the publication lag
 * (CREATION_DATE - EPOCH) is a median of 0.29 days, 1.04 at p99.9, with a thin
 * tail to 9.7. A same-day fetch of 2025-10-29 LEO captured 10,230 element sets
 * where 59,608 exist today - 17%, missing 3,251 satellites outright. The same
 * query fetched 6 days out was already complete to within one element set.
 * Four days clears the +2 day window plus the p99.9 lag.
 */
define('GP_SETTLE_DAYS', 4);

/**
 * Is this cached file trustworthy, or was it captured before the data settled?
 *
 * Returns false for a cache entry fetched inside the settle window, so the
 * caller re-fetches it - but only once that window has actually passed, since
 * before then a fresh request would be no more complete than what we hold.
 * The re-fetched file's own mtime then falls outside the window, so this
 * self-corrects exactly once per entry rather than re-fetching forever.
 *
 * @param string $file        Path to the cached file.
 * @param string $requestDate The requested date, YYYY-MM-DD.
 */
function gpCacheIsUsable($file, $requestDate) {
    // $file may name the uncompressed form while only the .gz is on disk.
    $entry = gpCacheEntry($file);
    if ($entry === null) {
        return false;
    }
    $settledTs = strtotime($requestDate . ' +' . GP_SETTLE_DAYS . ' days');
    if ($settledTs === false) {
        return true;    // unparseable date - don't throw away a good cache
    }
    if (filemtime($entry) < $settledTs && time() >= $settledTs) {
        return false;   // provisional, and it is now worth replacing
    }
    return true;
}

/**
 * First line of a payload, without copying the whole thing.
 * $skip lines are stepped over first, so getGPLine($data, 1) is the first data
 * row of a CSV (the header being line 0).
 */
function getGPLine($dataBlob, $skip = 0) {
    $start = 0;
    for ($i = 0; $i < $skip; $i++) {
        $nl = strpos($dataBlob, "\n", $start);
        if ($nl === false) return '';
        $start = $nl + 1;
    }
    $nl = strpos($dataBlob, "\n", $start);
    $end = ($nl === false) ? min(strlen($dataBlob), $start + 4096) : $nl;
    return substr($dataBlob, $start, $end - $start);
}

/**
 * Write a GP payload to the cache, alongside a pre-compressed copy.
 *
 * Compressing once at fetch time rather than per request is what makes serving
 * the compressed form cheap - these payloads are megabytes and are re-requested
 * far more often than they change. Level 6 is where extra CPU stops buying
 * meaningful size on element data.
 *
 * The .gz is built by streaming the file back through gzwrite in 1 MB chunks,
 * NOT with gzencode(). gzencode() returns the whole compressed payload as a
 * second string, so a large historical set needs the response, the copy PHP
 * makes of it, and the compressed result all resident at once. A Space-Track
 * LEO query runs to 25 MB (40 quoted columns, including the full TLE lines),
 * which blew the 128 MB memory_limit outright:
 *   "Allowed memory size of 134217728 bytes exhausted (tried to allocate
 *    34994256 bytes)"
 * Streaming holds one chunk at a time regardless of payload size.
 *
 * @return bool true if the plain file was written.
 */
function writeGPCache($plainFile, $dataBlob) {
    $gzFile = $plainFile . ".gz";
    $len = strlen($dataBlob);
    if ($len === 0) {
        return false;
    }

    $ctx = deflate_init(ZLIB_ENCODING_GZIP, ['level' => 6]);
    $out = @fopen($gzFile, 'wb');
    if ($ctx === false || $out === false) {
        if ($out !== false) fclose($out);
        return false;
    }

    // Compress straight from the response in 1 MB chunks. gzencode() would
    // return the whole compressed payload as a second string, which on a 57 MB
    // Space-Track LEO response exhausts the 128 MB memory_limit outright.
    $ok = true;
    $chunkSize = 1024 * 1024;
    for ($offset = 0; $offset < $len; $offset += $chunkSize) {
        $mode = ($offset + $chunkSize >= $len) ? ZLIB_FINISH : ZLIB_NO_FLUSH;
        $encoded = deflate_add($ctx, substr($dataBlob, $offset, $chunkSize), $mode);
        if ($encoded === false) { $ok = false; break; }
        if ($encoded !== '' && fwrite($out, $encoded) === false) { $ok = false; break; }
    }
    fclose($out);

    if (!$ok) {
        @unlink($gzFile);
        return false;
    }

    // Only the .gz is kept. The uncompressed copy was pure duplication - it
    // existed solely so a non-gzip client could be redirected at a static file,
    // and serveGPCached() now inflates on the fly for that rare case instead.
    // Storing both cost ~6x the disk for no benefit: a Space-Track LEO date is
    // 57 MB plain against 9 MB compressed.
    @unlink($plainFile);
    return true;
}

/**
 * Which file actually represents this cache entry, or null if it is absent.
 *
 * Prefers the compressed copy. Plain files are still recognised so entries
 * written before compression became the only stored form keep working.
 */
function gpCacheEntry($plainFile) {
    if (file_exists($plainFile . ".gz")) {
        return $plainFile . ".gz";
    }
    if (file_exists($plainFile)) {
        return $plainFile;
    }
    return null;
}

/**
 * Serve a cached GP file, using the pre-compressed copy when the client accepts
 * gzip (every browser does), which cuts these payloads to roughly a third.
 *
 * Only the compressed form is stored, so a client that does not advertise gzip
 * is served an inflated copy streamed from it. That path is vanishingly rare -
 * every browser accepts gzip - and it is what lets us stop keeping a second,
 * uncompressed copy of every payload on disk.
 *
 * Falls back to redirecting at $redirectUrl for legacy entries written before
 * compression became the only stored form. Does not return.
 */
function serveGPCached($plainFile, $redirectUrl, $maxAge, $onComplete = null) {
    $gzFile = $plainFile . ".gz";

    // Legacy entry stored uncompressed only: redirect at it as before.
    if (!file_exists($gzFile)) {
        header("Location: " . $redirectUrl);
        if ($onComplete) $onComplete('success', 'redirect_issued');
        exit();
    }

    $acceptsGzip = stripos($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip') !== false;
    $lastModified = filemtime($gzFile);
    $etag = '"' . md5($plainFile . $lastModified) . ($acceptsGzip ? '"' : '-plain"');

    header("Content-Type: text/plain; charset=UTF-8");
    header("Vary: Accept-Encoding");
    header("Cache-Control: public, max-age=" . $maxAge);
    header("Last-Modified: " . gmdate("D, d M Y H:i:s", $lastModified) . " GMT");
    header("ETag: " . $etag);

    // Let an unchanged repeat request finish without moving the payload again.
    $ifNoneMatch = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
    $ifModifiedSince = strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '');
    if ($ifNoneMatch === $etag || ($ifModifiedSince !== false && $ifModifiedSince >= $lastModified)) {
        http_response_code(304);
        if ($onComplete) $onComplete('success', 'not_modified');
        exit();
    }

    // PHP must not compress an already-compressed body.
    @ini_set('zlib.output_compression', 'Off');

    if ($acceptsGzip) {
        header("Content-Encoding: gzip");
        header("Content-Length: " . filesize($gzFile));
        $bytes = readfile($gzFile);
        if ($onComplete) $onComplete($bytes !== false && $bytes === filesize($gzFile) ? 'success' : 'failure', 'stream_finished');
        exit();
    }

    // No gzip support: inflate on the fly, a chunk at a time. Content-Length is
    // omitted because the uncompressed size is not known without reading it.
    $in = @gzopen($gzFile, 'rb');
    if ($in === false) {
        header("Location: " . $redirectUrl);
        if ($onComplete) $onComplete('failure', 'cache_read_failed');
        exit();
    }
    $ok = true;
    while (!gzeof($in)) {
        $chunk = gzread($in, 1024 * 1024);
        if ($chunk === false) { $ok = false; break; }
        echo $chunk;
    }
    gzclose($in);
    if ($onComplete) $onComplete($ok ? 'success' : 'failure', 'stream_finished');
    exit();
}
?>
