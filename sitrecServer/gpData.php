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
    if (file_put_contents($plainFile, $dataBlob) === false) {
        return false;
    }

    $gzFile = $plainFile . ".gz";
    $in = @fopen($plainFile, 'rb');
    $out = @gzopen($gzFile, 'wb6');
    if ($in === false || $out === false) {
        // A missing .gz simply means callers fall back to the uncompressed path.
        if ($in !== false) fclose($in);
        if ($out !== false) gzclose($out);
        @unlink($gzFile);
        return true;
    }

    $ok = true;
    while (!feof($in)) {
        $chunk = fread($in, 1024 * 1024);
        if ($chunk === false) { $ok = false; break; }
        if ($chunk !== '' && gzwrite($out, $chunk) === false) { $ok = false; break; }
    }
    fclose($in);
    gzclose($out);

    if (!$ok) {
        @unlink($gzFile);
    }
    return true;
}

/**
 * Serve a cached GP file, using the pre-compressed copy when the client accepts
 * gzip (every browser does), which cuts these payloads to roughly a third.
 *
 * Falls back to redirecting at $redirectUrl - the original behaviour - for
 * clients that don't advertise gzip or when no .gz has been built.
 * Does not return.
 */
function serveGPCached($plainFile, $redirectUrl, $maxAge) {
    $gzFile = $plainFile . ".gz";
    $acceptsGzip = stripos($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip') !== false;

    if (!$acceptsGzip || !file_exists($gzFile)) {
        header("Location: " . $redirectUrl);
        exit();
    }

    $lastModified = filemtime($gzFile);
    $etag = '"' . md5($plainFile . $lastModified) . '"';

    header("Content-Type: text/plain; charset=UTF-8");
    header("Content-Encoding: gzip");
    header("Vary: Accept-Encoding");
    header("Cache-Control: public, max-age=" . $maxAge);
    header("Last-Modified: " . gmdate("D, d M Y H:i:s", $lastModified) . " GMT");
    header("ETag: " . $etag);

    // Let an unchanged repeat request finish without moving the payload again.
    $ifNoneMatch = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
    $ifModifiedSince = strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '');
    if ($ifNoneMatch === $etag || ($ifModifiedSince !== false && $ifModifiedSince >= $lastModified)) {
        http_response_code(304);
        exit();
    }

    // PHP must not compress an already-compressed body.
    @ini_set('zlib.output_compression', 'Off');
    header("Content-Length: " . filesize($gzFile));
    readfile($gzFile);
    exit();
}
?>
