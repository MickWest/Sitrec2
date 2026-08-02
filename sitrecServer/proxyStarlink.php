<?php
// This is specific to the Starlink historical data from Space-Track.org
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/curlGetRequest.php';
require_once __DIR__ . '/gpData.php';

// SECURITY: Rate limiting by IP - max 20 requests per minute (Space-Track has strict limits)
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_starlink_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 20) {
    http_response_code(429);
    exit("Rate limit exceeded. Please wait.");
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

// space-data in config.php should look like this:
//
// $spaceDataUsername = 'somthing@example.com';
// $spaceDataPassword = 'somepassword';

// need to ensure we are logged in first
//require_once __DIR__ . '/user.php';
//$userID = getUserID();
//if ($userID == "") {
//    exit("Not logged in");
//}

$zipIt = getenv('TLE_ZIP_ENABLED');

$starlink_cache = $CACHE_PATH . "starlink/";

// make sure the "starlink" folder exists in the cache directory
if (!file_exists($starlink_cache)) {
    mkdir($starlink_cache);
}

// called like: local.metabunk.org/sitrec/sitrecServer/proxyStarlink.php?request=2024-07-18
$request = isset($_GET["request"]) ? $_GET["request"] : null;

// the request code might have a ?v=8234823958235 parameter at the end (with a random string)
// so strip that off (just strip off everything after the ?)
$request = strtok($request, "?");

if (!$request) {
    exit("No request");
}

// validate the request and make sure it's in the right format
// (and for security)
if (!preg_match("/^\d{4}-\d{2}-\d{2}$/", $request)) {
    exit("Invalid request key ".$request);
}

// Whitelist the allowed types explicitly
$allowed_types = ["", "LEO", "ALL", "SLOW", "LEOALL", "CUSTOM"];

$type = isset($_GET["type"]) ? $_GET["type"] : "";
if (!in_array($type, $allowed_types, true)) {
    exit("Invalid type parameter");
}

// given request in the form of YYYY-MM-DD
// calculate nextDay in the same form, and use 2 days later
$nextDay = date('Y-m-d', strtotime($request . ' +2 days'));

// Ask Space-Track for only the columns we actually use.
//
// Its default CSV is 40 columns, quoted, and carries TLE_LINE0/1/2 in addition
// to the OMM elements they encode - a single LEO date runs to ~57 MB, several
// times the equivalent 3LE. Most of that is duplication and bookkeeping.
//
// Beyond the twelve fields SGP4 needs, four are kept deliberately. The cache is
// permanent and this archive is expensive to rebuild against a rate-limited
// API, so dropping a column now would cost a full re-fetch to recover later:
//
//   OBJECT_TYPE    PAYLOAD / ROCKET BODY / DEBRIS. Bears on the flare
//                  MECHANISM: the model assumes a nadir-pointing flat panel,
//                  which is right for on-station Starlink and wrong for a
//                  tumbling rocket body. The LEO query filters payloads
//                  server-side, so without this the client cannot tell them
//                  apart within a set.
//   RCS_SIZE       SMALL / MEDIUM / LARGE. The only per-object size signal
//                  available - the flare model currently has no per-satellite
//                  area term at all. Radar, not optical, and coarsely bucketed,
//                  so a weak prior for brightness rather than a photometric
//                  input.
//   CREATION_DATE  When Space-Track published the element, as opposed to when
//                  it is valid (EPOCH). Makes a cached set self-describing
//                  about its own completeness, instead of relying on file
//                  mtime, which copying and backups destroy.
//   OBJECT_ID      International designator, e.g. 2019-074B - groups a launch.
$predicates = "/predicates/OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,EPOCH,CREATION_DATE,"
    . "MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,"
    . "BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,OBJECT_TYPE,RCS_SIZE";

// the default STARLINK query
$url = "https://www.space-track.org/basicspacedata/query/class/gp_history/CREATION_DATE/" . $request . "--" . $nextDay . "/orderby/NORAD_CAT_ID,EPOCH/format/csv/OBJECT_NAME/STARLINK~~" . $predicates;

// LEO is Low Earth object, but here filter for payloads only
// decay_date/null-val filters out decayed objects per Space-Track recommendations
if ($type == "LEO") {
    $url = "https://www.space-track.org/basicspacedata/query/class/gp_history/EPOCH/" . $request . "--" . $nextDay . "/MEAN_MOTION/>11.25/ECCENTRICITY/<0.25/OBJECT_TYPE/payload/decay_date/null-val/orderby/NORAD_CAT_ID,EPOCH/format/csv" . $predicates;
}

// LEOALL is all the LEO objects, including payloads and debris
if ($type == "LEOALL") {
    $url = "https://www.space-track.org/basicspacedata/query/class/gp_history/EPOCH/" . $request . "--" . $nextDay . "/MEAN_MOTION/>11.25/ECCENTRICITY/<0.25/decay_date/null-val/format/csv" . $predicates;
}

if ($type == "SLOW") {
    // SLOW is for objects with a mean motion of less than 11.25 (using 11.26 to overlap with LEO a little)
    $url = "https://www.space-track.org/basicspacedata/query/class/gp_history/EPOCH/" . $request . "--" . $nextDay . "/MEAN_MOTION/<11.26/decay_date/null-val/format/csv" . $predicates;
}

// override for ALL query
if ($type == "ALL") {
    $url = "https://www.space-track.org/basicspacedata/query/class/gp_history/CREATION_DATE/" . $request . "--" . $nextDay . "/decay_date/null-val/orderby/NORAD_CAT_ID,EPOCH/format/csv" . $predicates;
}

// CUSTOM TLE handling
if ($type == "CUSTOM") {
    $customTleUrl = getenv('CUSTOM_TLE');
    if (!$customTleUrl) {
        exit("CUSTOM_TLE not configured");
    }
    
    $dateParts = explode('-', $request);
    if (count($dateParts) != 3) {
        exit("Invalid date format for CUSTOM TLE");
    }
    
    $year = (int)$dateParts[0];
    $month = (int)$dateParts[1];
    $day = (int)$dateParts[2];
    
    if ($year < 1900 || $year > 2100) {
        exit("Invalid year for CUSTOM TLE (must be 1900-2100)");
    }

    // get a 2-digit year (unlikely to be used, but just in case)
    $year2 = $year % 100;
    
    if ($month < 1 || $month > 12) {
        exit("Invalid month for CUSTOM TLE (must be 1-12)");
    }
    
    if ($day < 1 || $day > 31) {
        exit("Invalid day for CUSTOM TLE (must be 1-31)");
    }

    $url = str_replace(['{DD}', '{MM}', '{YYYY}', '{YY}'], [sprintf("%02d", $day), sprintf("%02d", $month), sprintf("%04d", $year), sprintf("%02d", $year2)], $customTleUrl);
}

// if the getTLECustom function is defined, use that to get the URL
if (function_exists('getTLECustom')) {
    $url = getTLECustom($request, $nextDay, $type, $url);
}


// encode angle brackets for compatibility with cURL
$url = encodeAngleBrackets($url);

// Determine if we should cache
$caching = true;
if ($type == "CUSTOM" && !getenv('CACHE_CUSTOM_TLE')) {
    $caching = false;
}

// File naming setup.
// New downloads are OMM CSV; anything already cached is TLE. Sitrec parses
// both, so an existing .tle cache is still served rather than re-downloaded -
// Space-Track rate limits hard and this archive is expensive to rebuild.
$baseFileName = $request . $type;
$cachedCSV = $starlink_cache . $baseFileName . ".csv";
$cachedTLE = $starlink_cache . $baseFileName . ".tle";
$cachedZIP = $starlink_cache . $baseFileName . ".tle.zip";

// Historical element sets for a past date never change, so let clients hold
// onto them.
$cacheMaxAge = 30 * 24 * 60 * 60; // 30 days

// Any cached copy is used, whatever format it is in, and we only go to
// Space-Track when we have nothing. Historical element sets for a past date
// never change, Space-Track rate limits hard, and this archive goes back to
// 1977, so re-downloading what we already hold would be pure waste. Sitrec
// parses TLE and OMM CSV alike, so the cached format does not matter.
//
// The one thing an old .tle cache cannot have is objects above catalog number
// 99999 (the catalog passed that on 2026-07-11 and TLE cannot represent them).
// Deleting the affected file is all it takes to pick those up on the next
// request - it will come back as CSV.
// gpCacheIsUsable() rather than file_exists(): a set captured within a few days
// of its own date was fetched before Space-Track had finished publishing, and
// is missing much of what exists now. Such an entry is re-fetched once, after
// which its mtime puts it outside the settle window and it is trusted for good.
if ($caching) {
    // Prefer the CSV cache - it is the only format that can hold everything.
    if (gpCacheIsUsable($cachedCSV, $request)) {
        serveGPCached($cachedCSV, $cachedCSV, $cacheMaxAge);
    }

    if ($zipIt) {
        if (gpCacheIsUsable($cachedZIP, $request)) {
            header("Location: " . $cachedZIP);
            exit();
        }

        if (gpCacheIsUsable($cachedTLE, $request)) {
            if (zipTLE($cachedTLE, $cachedZIP, $baseFileName . ".tle")) {
                unlink($cachedTLE);
                header("Location: " . $cachedZIP);
                exit();
            } else {
                exit("Failed to create ZIP from existing TLE");
            }
        }
    } else {
        if (gpCacheIsUsable($cachedTLE, $request)) {
            header("Location: " . $cachedTLE);
            exit();
        }
    }
}

// We only reach here with a cached file present if that file was judged
// provisional. Keep it as a fallback: refreshing it is an improvement, not a
// requirement, and a Space-Track outage or an expired credential must not turn
// a set that has been serving fine into a hard error. Without this, every
// failure path below would fail a request that used to succeed.
$provisionalFallback = null;
$provisionalIsCSV = false;
if ($caching) {
    foreach ([[$cachedCSV, true], [$cachedZIP, false], [$cachedTLE, false]] as $candidate) {
        if (file_exists($candidate[0])) {
            $provisionalFallback = $candidate[0];
            $provisionalIsCSV = $candidate[1];
            break;
        }
    }
}

/**
 * Report a failed refresh: serve the provisional cached copy if we have one,
 * otherwise fail as before. Does not return.
 */
function gpFailSoft($message) {
    global $provisionalFallback, $provisionalIsCSV, $cacheMaxAge;
    if ($provisionalFallback !== null) {
        error_log("proxyStarlink: refresh failed, serving provisional cached copy "
            . $provisionalFallback . " - " . $message);
        if ($provisionalIsCSV) {
            serveGPCached($provisionalFallback, $provisionalFallback, $cacheMaxAge);
        }
        header("Location: " . $provisionalFallback);
        exit();
    }
    die($message);
}

// For CUSTOM type, use simple GET request without Space-Track login
if ($type == "CUSTOM") {
    $result = curlGetRequest($url);
    $data = $result['data'];
    $http_status = $result['http_status'];
} else {
    // retrieve Space-Track login credentials from environment
    $username = getenv('SPACEDATA_USERNAME');
    $password = getenv('SPACEDATA_PASSWORD');

    // Space-Track.org login URL
    $loginUrl = 'https://www.space-track.org/ajaxauth/login';

    // Space-Track.org data query URL (calculated earlier)
    $dataUrl = $url;

    // Check if credentials are configured
    if (empty($username) || empty($password)) {
        gpFailSoft('ERROR: Space-Track credentials not configured. Set SPACEDATA_USERNAME and SPACEDATA_PASSWORD environment variables.');
    }

    // Initialize cURL session
    $ch = curl_init();

    // SECURITY: Store cookies in temp directory, not web-accessible directory
    $cookieFile = sys_get_temp_dir() . '/sitrec_spacetrack_cookies.txt';
    
    // Set cURL options for login
    curl_setopt($ch, CURLOPT_URL, $loginUrl);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query(['identity' => $username, 'password' => $password]));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_COOKIEJAR, $cookieFile); // Save cookies for subsequent requests
    curl_setopt($ch, CURLOPT_COOKIEFILE, $cookieFile); // Use saved cookies

    // Execute login request
    $response = curl_exec($ch);
    $curl_error = curl_error($ch);
    $http_status = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    // Check for cURL errors during login
    if ($response === false) {
        curl_close($ch);
        gpFailSoft('ERROR: Space-Track login cURL failed: ' . $curl_error);
    }

    // Check for login errors
    if ($http_status !== 200) {
        curl_close($ch);
        gpFailSoft('ERROR: Space-Track login failed with HTTP ' . $http_status . '. Check credentials.');
    }

    // Set cURL options for data query
    curl_setopt($ch, CURLOPT_URL, $dataUrl);
    curl_setopt($ch, CURLOPT_POST, false);
    curl_setopt($ch, CURLOPT_HTTPGET, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, false); // Set to false to exclude headers from the response

    // Execute data query request
    $data = curl_exec($ch);
    $curl_error = curl_error($ch);
    $http_status = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    // Close cURL session
    curl_close($ch);

    // Check for cURL errors during data query
    if ($data === false) {
        gpFailSoft('ERROR: Space-Track data query failed. Please try again later.');
    }
}


// Check for data query errors, and zero length data
if ($data === false || empty($data)) {
    gpFailSoft('ERROR: Space-Track query returned no data. Request: ' . $request . ', Type: ' . ($type ?: 'STARLINK') . ', URL: ' . $url);
}

// Check for HTTP errors (including 5xx server errors)
if ($http_status !== 200) {
    gpFailSoft('ERROR: Space-Track query failed with HTTP ' . $http_status . '. Request: ' . $request . ', Type: ' . ($type ?: 'STARLINK') . ', Response: ' . substr($data, 0, 500));
}

// Check if response looks like an HTML error page instead of TLE data
// Test a bounded prefix: trim() on a 35 MB LEO response copies the whole
// payload, which alone can exhaust the PHP memory_limit.
$prefixData = ltrim(substr($data, 0, 65536));
if (stripos($prefixData, '<!DOCTYPE') === 0 || stripos($prefixData, '<html') === 0) {
    gpFailSoft('ERROR: Space-Track returned HTML instead of TLE data (server error). Request: ' . $request . ', Type: ' . ($type ?: 'STARLINK') . ', Response: ' . substr($data, 0, 500));
}


// The CUSTOM type points at a user-supplied URL that may legitimately serve
// TLE, so only require OMM CSV structure for our own Space-Track queries.
if ($type != "CUSTOM" && !isValidGPData($data, $http_status, "csv")) {
    gpFailSoft('ERROR: Space-Track did not return OMM CSV data. Request: ' . $request
        . ', Type: ' . ($type ?: 'STARLINK') . ', Response: ' . substr($data, 0, 500));
}

// check that the data contains "STARLINK" if the default type.
// In CSV the first line is the OMM header, so look at the first data row.
// getGPLine() reads just that row - explode()ing a 35 MB payload into a
// 60,000-element array to look at line 2 is what previously ran the server
// out of memory.
$firstDataLine = getGPLine($data, 1);
if ($type == "" && strpos($firstDataLine, "STARLINK") === false) {
    gpFailSoft('ERROR: Expected STARLINK data but got: ' . substr($firstDataLine, 0, 100) . '. Request: ' . $request);
}

// Freshly downloaded data is OMM CSV, so it is cached as .csv alongside a
// pre-built .gz. Note that TLE_ZIP_ENABLED no longer applies here: gzip
// Content-Encoding compresses at least as well, is decompressed by the browser
// itself, and so avoids pulling JSZip into the client just to read a catalogue.
// The setting still governs the legacy .tle files already in the cache.
if ($caching) {
    if (!writeGPCache($cachedCSV, $data)) {
        exit("ERROR: Failed to write GP cache file");
    }
    serveGPCached($cachedCSV, $cachedCSV, $cacheMaxAge);
} else {
    header('Vary: Accept-Encoding');
    $acceptsGzip = stripos($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip') !== false;
    $gzData = $acceptsGzip ? gzencode($data, 6) : false;
    if ($gzData !== false) {
        @ini_set('zlib.output_compression', 'Off');
        header('Content-Type: text/plain; charset=UTF-8');
        header('Content-Encoding: gzip');
        header('Content-Length: ' . strlen($gzData));
        echo $gzData;
    } else {
        header('Content-Type: text/plain; charset=UTF-8');
        echo $data;
    }
}

exit();


// Helper to encode < and > in a Space-Track URL
function encodeAngleBrackets($url) {
    return str_replace(['<', '>'], ['%3C', '%3E'], $url);
}

// Helper to zip a .tle file
function zipTLE($tleFile, $zipFile, $tleNameInZip) {
    $zip = new ZipArchive();
    if ($zip->open($zipFile, ZipArchive::CREATE) === TRUE) {
        $zip->addFile($tleFile, $tleNameInZip);
        $zip->close();
        return true;
    }
    return false;
}
?>
