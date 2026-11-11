<?php
/**
 * User Metadata API
 *
 * Handles loading and saving user metadata (label definitions + sitch-label mappings).
 * Storage mirrors settings.php pattern:
 *   - S3: metadata/<userID>.json
 *   - Local: $UPLOAD_PATH/metadata/<userID>.json
 *
 * Per-sitch metadata is also written to <userID>/<sitchName>/metadata.json
 * when labels are assigned.
 *
 * GET: Returns user metadata {labels: [...], sitchLabels: {...}}
 * POST: Saves user metadata. If "updateSitches" array is provided, also writes per-sitch metadata.json for each.
 *
 * Two shared lists sit beside the per-user files. An administrator writes them and
 * anyone can read them, logged in or not:
 *   - metadata/featured.json  : the featured sitches      (GET ?featured=1,  POST updateFeatured)
 *   - metadata/templates.json : the global templates      (GET ?templates=1, POST updateTemplates)
 * A sitch on either list is published: getsitches.php lets any caller list its versions.
 */

// The CORS origin below is built before config_paths.php is loaded, so settle the scheme first.
require_once __DIR__ . '/requestScheme.php';

header('Content-Type: application/json');

// CORS support (matches getsitches.php pattern) — needed because the client
// calls this endpoint via the absolute SITREC_SERVER URL which may be cross-origin
// during development (webpack dev server on a different port).
$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($requestOrigin) {
    $serverOrigin = $_SERVER['REQUEST_SCHEME'] . '://' . $_SERVER['HTTP_HOST'];
    $allowedOrigins = [$serverOrigin];
    $localhostEnv = getenv('LOCALHOST');
    if ($localhostEnv) {
        $allowedOrigins[] = 'https://' . $localhostEnv;
        $allowedOrigins[] = 'http://'  . $localhostEnv;
    }
    if (in_array($requestOrigin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $requestOrigin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/user.php';
sitrecAuditRequest(($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' ? 'metadata.write' : 'metadata.read');

$user_id = getUserID();
sitrecAuditResource('metadata/' . $user_id);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/object_helpers.php';

// Allow unauthenticated GET for the two shared lists only; everything else requires login
if ($user_id == 0 && !($_SERVER['REQUEST_METHOD'] === 'GET' && (isset($_GET['featured']) || isset($_GET['templates'])))) {
    http_response_code(401);
    echo json_encode(['error' => 'Not logged in']);
    exit();
}

define('MAX_LABELS', 100);
define('MAX_LABEL_NAME_LENGTH', 50);
define('MAX_SITCHES_WITH_LABELS', 10000);
define('SITCH_NAME_PATTERN', '/^(?!\.{1,2}$)[^\/\\\\<>\x00-\x1f]+$/u');

function isValidSitchName($name) {
    return is_string($name) && preg_match(SITCH_NAME_PATTERN, $name) === 1;
}

/**
 * Sanitize user metadata to prevent exploits.
 */
function sanitizeMetadata($data) {
    $sanitized = ['labels' => [], 'sitchLabels' => []];

    // Sanitize label definitions
    if (isset($data['labels']) && is_array($data['labels'])) {
        $count = 0;
        foreach ($data['labels'] as $label) {
            if ($count >= MAX_LABELS) break;
            if (!is_array($label) || !isset($label['name'])) continue;

            $name = substr(trim(strval($label['name'])), 0, MAX_LABEL_NAME_LENGTH);
            if ($name === '') continue;

            // Validate color (hex format)
            $color = '#4285f4'; // default blue
            if (isset($label['color']) && preg_match('/^#[0-9a-fA-F]{6}$/', $label['color'])) {
                $color = $label['color'];
            }

            $sanitized['labels'][] = ['name' => $name, 'color' => $color];
            $count++;
        }
    }

    // Sanitize sitch-label mappings
    if (isset($data['sitchLabels']) && is_array($data['sitchLabels'])) {
        $count = 0;
        foreach ($data['sitchLabels'] as $sitchName => $labels) {
            if ($count >= MAX_SITCHES_WITH_LABELS) break;
            if (!is_string($sitchName) || !is_array($labels)) continue;

            // Normalize then validate to block traversal-like names (e.g. "."/"..")
            $sitchName = basename($sitchName);
            if (!isValidSitchName($sitchName)) continue;

            $cleanLabels = [];
            foreach ($labels as $lbl) {
                $lbl = substr(trim(strval($lbl)), 0, MAX_LABEL_NAME_LENGTH);
                if ($lbl !== '') $cleanLabels[] = $lbl;
            }
            if (!empty($cleanLabels)) {
                $sanitized['sitchLabels'][$sitchName] = $cleanLabels;
            }
            $count++;
        }
    }

    // Preserve screenshotVersions (integer counters per sitch)
    if (isset($data['screenshotVersions']) && is_array($data['screenshotVersions'])) {
        foreach ($data['screenshotVersions'] as $sitchName => $ver) {
            if (!is_string($sitchName) || !isValidSitchName(basename($sitchName))) continue;
            $sanitized['screenshotVersions'][basename($sitchName)] = intval($ver);
        }
    }

    // Force sitchLabels to encode as JSON object {} not array []
    if (empty($sanitized['sitchLabels'])) {
        $sanitized['sitchLabels'] = new \stdClass();
    }
    if (empty($sanitized['screenshotVersions'])) {
        $sanitized['screenshotVersions'] = new \stdClass();
    }

    return $sanitized;
}

// --- S3 helpers (same pattern as settings.php) ---

function startS3() {
    require_once __DIR__ . '/s3_client.php';
    global $s3creds;
    if (!isset($s3creds) || !is_array($s3creds) || !s3HasCredentials()) {
        http_response_code(503);
        echo json_encode(['error' => 'S3 credentials not configured']);
        exit();
    }
    $aws = $s3creds;
    $s3 = getS3Client();
    return ['s3' => $s3, 'aws' => $aws];
}

function readS3Json($s3, $aws, $key) {
    try {
        $result = $s3->getObject(['Bucket' => $aws['bucket'], 'Key' => $key]);
        $data = json_decode($result['Body']->getContents(), true);
        return is_array($data) ? $data : [];
    } catch (Aws\S3\Exception\S3Exception $e) {
        if ($e->getAwsErrorCode() === 'NoSuchKey') return [];
        throw $e;
    }
}

function writeS3Json($s3, $aws, $key, $data) {
    $putParams = [
        'Bucket' => $aws['bucket'],
        'Key' => $key,
        'Body' => json_encode($data, JSON_PRETTY_PRINT),
        'ContentType' => 'application/json',
    ];
    if (!empty($aws['acl'])) {
        $putParams['ACL'] = 'private';
    }
    $s3->putObject($putParams);
}

// --- Local filesystem helpers ---

function readLocalJson($path) {
    if (!is_file($path)) return [];
    $storedMetadata = file_get_contents($path);
    if ($storedMetadata === false) throw new RuntimeException('Metadata read failed');
    $data = json_decode($storedMetadata, true);
    return is_array($data) ? $data : [];
}

function writeLocalJson($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    if (file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX) === false) {
        throw new RuntimeException('Metadata write failed');
    }
}

// The shared lists. Each is one file, {"sitches": [{name, userID, screenshotVersion, date, ...}]}.
define('SHARED_LISTS', ['featured', 'templates']);

function sharedListFile($list) {
    if (!in_array($list, SHARED_LISTS, true)) throw new RuntimeException('Unknown shared list');
    return 'metadata/' . $list . '.json';
}

function readSharedList($list, $s3Data = null) {
    global $useAWS, $UPLOAD_PATH;

    if ($useAWS) {
        if ($s3Data === null) {
            $s3Data = startS3();
        }
        return readS3Json($s3Data['s3'], $s3Data['aws'], sharedListFile($list));
    }

    return readLocalJson($UPLOAD_PATH . sharedListFile($list));
}

function writeSharedList($list, $data, $s3Data = null) {
    global $useAWS, $UPLOAD_PATH;

    if ($useAWS) {
        if ($s3Data === null) {
            $s3Data = startS3();
        }
        writeS3Json($s3Data['s3'], $s3Data['aws'], sharedListFile($list), $data);
        return;
    }

    writeLocalJson($UPLOAD_PATH . sharedListFile($list), $data);
}

/**
 * The valid entries of a stored shared list, in their stored order and stored shape
 * ({name, userID, screenshotVersion, date, screenshotName}), so they can be written back.
 */
function validSharedEntries($raw) {
    $entries = [];
    if (!isset($raw['sitches']) || !is_array($raw['sitches'])) return $entries;
    foreach ($raw['sitches'] as $entry) {
        if (!is_array($entry) || !isset($entry['name']) || !isset($entry['userID'])) continue;
        $name = basename(strval($entry['name']));
        $uid = intval($entry['userID']);
        if ($uid <= 0 || !isValidSitchName($name)) continue;
        $entry['name'] = $name;
        $entry['userID'] = $uid;
        $entry['date'] = strval($entry['date'] ?? '');
        $entries[] = $entry;
    }
    return $entries;
}

/** The {name, userID} pairs of a request, validated. Anything else in an entry is dropped. */
function requestedSharedEntries($input) {
    $entries = [];
    if (!is_array($input)) return $entries;
    foreach ($input as $entry) {
        if (!is_array($entry) || !isset($entry['name']) || !isset($entry['userID'])) continue;
        $name = basename(strval($entry['name']));
        $uid = intval($entry['userID']);
        if ($uid > 0 && isValidSitchName($name)) {
            $entries[] = ['name' => $name, 'userID' => $uid];
        }
    }
    return $entries;
}

// $screenshotName is the stored filename from featured.json. It is absent for
// entries written before screenshots were tokenised, and the legacy fixed name is
// the correct fallback for exactly those sitches. A featured sitch re-saved since
// the last featured-list edit shows its previous thumbnail until that list is
// refreshed - the same way its 'date' already behaves.
function buildScreenshotUrl($userID, $sitchName, $version = null, $s3Data = null, $screenshotName = null) {
    global $useAWS, $UPLOAD_URL;

    $file = (is_string($screenshotName) && isScreenshotFile($screenshotName))
        ? $screenshotName : 'screenshot.jpg';

    if ($useAWS) {
        $key = $userID . '/' . $sitchName . '/' . $file;
        if (s3ReadsViaServer()) {
            // Same-origin when the deployment's browsers cannot reach storage.
            $url = buildServerObjectUrl($key);
        } else {
            if ($s3Data === null) {
                $s3Data = startS3();
            }
            $url = $s3Data['s3']->getObjectUrl($s3Data['aws']['bucket'], $key);
        }
    } else {
        $url = $UPLOAD_URL . $userID . '/' . $sitchName . '/' . $file;
    }

    if ($version !== null && intval($version) > 0) {
        $url .= (strpos($url, '?') !== false ? '&' : '?') . 'v=' . intval($version);
    }

    return $url;
}

/**
 * Newest version-file modification date per sitch for a user, as 'Y-m-d H:i:s'
 * keyed by sitch name.
 *
 * Mirrors the date logic in getsitches.php?get=myfiles (screenshot.jpg and
 * metadata.json are ignored, so a thumbnail refresh does not look like a save)
 * so featured sitches sort by the same "last saved" time as your own sitches.
 *
 * Pass $onlySitch to narrow the storage scan to a single sitch.
 * Callers must not use this on the featured GET path - it hits storage.
 */
// $screenshots, when passed, is filled with name => newest screenshot filename.
// Screenshots carry their own token now, so the fixed 'screenshot.jpg' can no
// longer be assumed; this scan already walks every file, so collecting it here
// costs nothing and keeps the featured GET path free of storage calls.
function sitchDatesForUser($userID, $s3Data = null, $onlySitch = null, &$screenshots = null) {
    global $useAWS, $UPLOAD_PATH;

    $dates = [];
    $userID = intval($userID);
    if ($userID <= 0) return $dates;
    if ($onlySitch !== null && !isValidSitchName($onlySitch)) return $dates;

    $isVersionFile = function ($file) {
        return $file !== '' && !isScreenshotFile($file) && $file !== 'metadata.json';
    };

    if ($useAWS) {
        if ($s3Data === null) $s3Data = startS3();
        $base = $userID . '/';
        $prefix = $base . ($onlySitch !== null ? $onlySitch . '/' : '');
        $objects = $s3Data['s3']->getIterator('ListObjects', [
            'Bucket' => $s3Data['aws']['bucket'],
            'Prefix' => $prefix,
        ]);
        foreach ($objects as $object) {
            $key = $object['Key'];
            if (strpos($key, $base) !== 0) continue;
            $rest = substr($key, strlen($base));
            $slash = strpos($rest, '/');
            if ($slash === false) continue;
            $name = substr($rest, 0, $slash);
            $fileName = substr($rest, $slash + 1);
            if ($screenshots !== null && isScreenshotFile($fileName)
                && (!isset($screenshots[$name]) || strcmp($fileName, $screenshots[$name]) > 0)) {
                $screenshots[$name] = $fileName;
            }
            if (!$isVersionFile($fileName)) continue;
            $date = $object['LastModified']->format('Y-m-d H:i:s');
            if (!isset($dates[$name]) || $date > $dates[$name]) $dates[$name] = $date;
        }
        return $dates;
    }

    $userDir = $UPLOAD_PATH . $userID;
    if (!is_dir($userDir)) return $dates;
    $sitchNames = ($onlySitch !== null) ? [$onlySitch] : (@scandir($userDir) ?: []);
    foreach ($sitchNames as $name) {
        if ($name === '.' || $name === '..' || $name === '.DS_Store') continue;
        $sitchPath = $userDir . '/' . $name;
        if (!is_dir($sitchPath)) continue;
        $versions = @scandir($sitchPath) ?: [];
        if ($screenshots !== null) {
            $shot = newestScreenshotName($versions);
            if ($shot !== null) $screenshots[$name] = $shot;
        }
        $newestTime = 0;
        foreach ($versions as $v) {
            if (!$isVersionFile($v) || $v === '.' || $v === '..') continue;
            if (!is_file($sitchPath . '/' . $v)) continue;
            $vTime = @filemtime($sitchPath . '/' . $v);
            if ($vTime > $newestTime) $newestTime = $vTime;
        }
        if ($newestTime) $dates[$name] = date('Y-m-d H:i:s', $newestTime);
    }
    return $dates;
}

/**
 * Fill in the 'date' field on featured entries by scanning storage, one listing
 * per distinct userID. Only called from the admin featured-list write path.
 */
function refreshFeaturedDates(&$sitches, $s3Data = null) {
    $datesByUser = [];
    $shotsByUser = [];
    foreach ($sitches as &$entry) {
        $uid = intval($entry['userID']);
        if (!isset($datesByUser[$uid])) {
            $shots = [];
            $datesByUser[$uid] = sitchDatesForUser($uid, $s3Data, null, $shots);
            $shotsByUser[$uid] = $shots;
        }
        $found = $datesByUser[$uid][$entry['name']] ?? null;
        // Keep any previously stored date if the sitch has since been deleted.
        $entry['date'] = $found !== null ? $found : strval($entry['date'] ?? '');

        // Same rule for the screenshot filename: record what is actually in storage,
        // keeping the previous value if the sitch has gone. Entries written before
        // screenshots were tokenised have no field at all, and buildScreenshotUrl
        // falls back to the legacy fixed name for those.
        $foundShot = $shotsByUser[$uid][$entry['name']] ?? null;
        if ($foundShot !== null) {
            $entry['screenshotName'] = $foundShot;
        }
    }
    unset($entry);
}

// ============================
// Handle GET - Fetch metadata
// ============================
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // GET ?featured=1 or ?templates=1 — return a shared list (no login required).
    // Returns [{name, userID, screenshotUrl, date}] so any user can browse and load these sitches.
    $sharedList = isset($_GET['templates']) ? 'templates' : (isset($_GET['featured']) ? 'featured' : null);
    if ($sharedList !== null) {
        sitrecAuditOperation($sharedList . '.read');
        sitrecAuditResource('metadata/' . $sharedList);
        try {
            global $useAWS;
            $s3Data = $useAWS ? startS3() : null;
            $storedEntries = validSharedEntries(readSharedList($sharedList, $s3Data));

            // This path only ever reads. Entries stored before dates existed report an
            // empty date until the next featured-list edit, which rescans them all
            // (see refreshFeaturedDates). Backfilling here instead would mean writing
            // featured.json from a cacheable GET, and the storage scan it needs is slow
            // enough that a concurrent featured edit or screenshot bump would be lost.
            $sitches = [];
            foreach ($storedEntries as $entry) {
                $version = isset($entry['screenshotVersion']) ? intval($entry['screenshotVersion']) : null;
                $sitches[] = [
                    'name' => $entry['name'],
                    'userID' => $entry['userID'],
                    // Avoid an S3 HEAD per sitch on the hot path. Missing screenshots are
                    // handled by the browser UI's img.onerror fallback.
                    'screenshotUrl' => buildScreenshotUrl($entry['userID'], $entry['name'], $version, $s3Data, $entry['screenshotName'] ?? null),
                    // Stored at write time (see refreshFeaturedDates) so this path never
                    // probes storage. Logged-out users have no other source of dates, and
                    // without it the sitch browser cannot sort Featured by date.
                    'date' => $entry['date'],
                ];
            }

            $payload = json_encode(['sitches' => $sitches]);
            $etag = '"' . sha1($payload) . '"';
            // The template list is checked before each save, to keep a template from being
            // saved over, so the browser must not answer that check from a minute-old copy.
            // It revalidates each time; the ETag makes an unchanged list a 304.
            header($sharedList === 'templates'
                ? 'Cache-Control: no-cache'
                : 'Cache-Control: public, max-age=60, stale-while-revalidate=300');
            header('ETag: ' . $etag);
            if (isset($_SERVER['HTTP_IF_NONE_MATCH']) && trim($_SERVER['HTTP_IF_NONE_MATCH']) === $etag) {
                sitrecAuditResult();
                http_response_code(304);
                exit();
            }
            sitrecAuditResult();
            echo $payload;
        } catch (Exception $e) {
            http_response_code(500);
            echo json_encode(['error' => 'Metadata storage unavailable']);
        }
        exit();
    }

    try {
        global $useAWS;
        if ($useAWS) {
            $s3Data = startS3();
            $key = 'metadata/' . $user_id . '.json';
            $raw = readS3Json($s3Data['s3'], $s3Data['aws'], $key);
        } else {
            global $UPLOAD_PATH;
            $path = $UPLOAD_PATH . 'metadata/' . $user_id . '.json';
            $raw = readLocalJson($path);
        }
        $sanitized = sanitizeMetadata($raw);
        sitrecAuditResult();
        echo json_encode($sanitized);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Metadata storage unavailable']);
    }
    exit();
}

// ============================
// Handle POST - Save metadata
// ============================
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON']);
            exit();
        }

        // Handle screenshotVersion bump: read-modify-write
        if (isset($input['bumpScreenshotVersions']) && is_array($input['bumpScreenshotVersions'])) {
            sitrecAuditOperation('metadata.screenshot_versions');
            global $useAWS;
            $metaKey = $useAWS ? ('metadata/' . $user_id . '.json') : null;
            $metaPath = $useAWS ? null : ($GLOBALS['UPLOAD_PATH'] . 'metadata/' . $user_id . '.json');
            $s3Data = null;

            // Read existing
            if ($useAWS) {
                $s3Data = startS3();
                $existing = readS3Json($s3Data['s3'], $s3Data['aws'], $metaKey);
            } else {
                $existing = readLocalJson($metaPath);
            }
            $existing = sanitizeMetadata($existing);

            // Bump versions
            $versions = (array)($existing['screenshotVersions'] ?? []);
            $bumpedNames = [];
            foreach ($input['bumpScreenshotVersions'] as $rawName) {
                if (!is_string($rawName)) continue;
                $sitchName = basename($rawName);
                if (!isValidSitchName($sitchName)) continue;
                $versions[$sitchName] = ($versions[$sitchName] ?? 0) + 1;
                $bumpedNames[$sitchName] = ($bumpedNames[$sitchName] ?? 0) + 1;
            }
            $existing['screenshotVersions'] = empty($versions) ? new \stdClass() : $versions;

            // Write back
            if ($useAWS) {
                writeS3Json($s3Data['s3'], $s3Data['aws'], $metaKey, $existing);
            } else {
                writeLocalJson($metaPath, $existing);
            }

            // Keep the shared lists' screenshot cache-busters in sync so their GET does not
            // need to probe storage for screenshot existence/version.
            if (!empty($bumpedNames)) {
                foreach (SHARED_LISTS as $list) {
                    $shared = readSharedList($list, $s3Data);
                    $sharedChanged = false;
                    if (isset($shared['sitches']) && is_array($shared['sitches'])) {
                        foreach ($shared['sitches'] as &$entry) {
                            if (!is_array($entry) || !isset($entry['name']) || !isset($entry['userID'])) continue;
                            $name = basename(strval($entry['name']));
                            $uid = intval($entry['userID']);
                            if ($uid !== $user_id || !isset($bumpedNames[$name])) continue;
                            $entry['screenshotVersion'] = intval($entry['screenshotVersion'] ?? 0) + $bumpedNames[$name];
                            // A bump means this sitch was just saved, so refresh its stored date
                            // and screenshot name (one prefix-scoped listing). Screenshots carry
                            // their own token, so the old name would show the old thumbnail.
                            $shots = [];
                            $freshDate = sitchDatesForUser($user_id, $s3Data, $name, $shots)[$name] ?? null;
                            if ($freshDate !== null) $entry['date'] = $freshDate;
                            if ($list === 'templates' && isset($shots[$name])) $entry['screenshotName'] = $shots[$name];
                            $sharedChanged = true;
                        }
                        unset($entry);
                    }
                    if ($sharedChanged) {
                        writeSharedList($list, $shared, $s3Data);
                    }
                }
            }

            sitrecAuditResult();
            echo json_encode(['success' => true, 'screenshotVersions' => $existing['screenshotVersions']]);
            exit();
        }

        // Handle updateFeatured: admin-only, writes global metadata/featured.json
        // Each featured entry stores {name, userID} so any user can load them.
        if (isset($input['updateFeatured']) && $input['updateFeatured']) {
            sitrecAuditOperation('featured.write');
            sitrecAuditResource('metadata/featured');
            if (!isAdmin()) {
                http_response_code(403);
                echo json_encode(['error' => 'Admin access required']);
                exit();
            }

            $sitches = requestedSharedEntries($input['sitches'] ?? null);
            $existingFeatured = readSharedList('featured');
            $existingVersions = [];
            $existingDates = [];
            if (isset($existingFeatured['sitches']) && is_array($existingFeatured['sitches'])) {
                foreach ($existingFeatured['sitches'] as $existingEntry) {
                    if (!is_array($existingEntry) || !isset($existingEntry['name']) || !isset($existingEntry['userID'])) continue;
                    $existingName = basename(strval($existingEntry['name']));
                    $existingUserID = intval($existingEntry['userID']);
                    if ($existingUserID <= 0 || !isValidSitchName($existingName)) continue;
                    $existingVersions[$existingUserID . ':' . $existingName] = intval($existingEntry['screenshotVersion'] ?? 0);
                    $existingDates[$existingUserID . ':' . $existingName] = strval($existingEntry['date'] ?? '');
                }
            }
            foreach ($sitches as &$entry) {
                $key = $entry['userID'] . ':' . $entry['name'];
                $entry['screenshotVersion'] = $existingVersions[$key] ?? 0;
                $entry['date'] = $existingDates[$key] ?? '';
            }
            unset($entry);

            global $useAWS;
            $s3Data = $useAWS ? startS3() : null;
            // Rescan dates for the whole list (one listing per distinct userID). Cheap
            // enough here - this is an admin-only, infrequent write - and it backfills
            // entries featured before dates were stored.
            refreshFeaturedDates($sitches, $s3Data);
            $featuredData = ['sitches' => $sitches];

            writeSharedList('featured', $featuredData, $s3Data);

            sitrecAuditResult();
            echo json_encode(['success' => true, 'featured' => $featuredData]);
            exit();
        }

        // Handle updateTemplates: admin-only, changes the global template list
        // (metadata/templates.json). Unlike updateFeatured it does not replace the list.
        // The request names the entries to add and to remove, and the server applies them
        // to the stored list. "Save as Template" in the File menu adds one entry without
        // the sitch browser open, so it has no complete list to send.
        if (isset($input['updateTemplates']) && $input['updateTemplates']) {
            sitrecAuditOperation('templates.write');
            sitrecAuditResource('metadata/templates');
            if (!isAdmin()) {
                http_response_code(403);
                echo json_encode(['error' => 'Admin access required']);
                exit();
            }

            $toAdd = requestedSharedEntries($input['add'] ?? null);
            $toRemove = requestedSharedEntries($input['remove'] ?? null);
            $removeKeys = [];
            foreach ($toRemove as $entry) {
                $removeKeys[$entry['userID'] . ':' . $entry['name']] = true;
            }

            global $useAWS;
            $s3Data = $useAWS ? startS3() : null;

            // Keep the stored order: the start screen shows the templates in this order.
            $sitches = [];
            $present = [];
            foreach (validSharedEntries(readSharedList('templates', $s3Data)) as $entry) {
                $key = $entry['userID'] . ':' . $entry['name'];
                if (isset($removeKeys[$key]) || isset($present[$key])) continue;
                $present[$key] = true;
                $sitches[] = $entry;
            }
            $added = [];
            foreach ($toAdd as $entry) {
                $key = $entry['userID'] . ':' . $entry['name'];
                if (isset($present[$key])) continue;
                $present[$key] = true;
                $entry['screenshotVersion'] = 0;
                $entry['date'] = '';
                $added[] = $entry;
            }
            // Fill the date and the screenshot name of the new entries from storage, with
            // one listing for each, of that sitch's folder only. The owner can have
            // hundreds of sitches, and a listing of all of them is slow. The stored
            // entries keep what they have.
            foreach ($added as &$entry) {
                $shots = [];
                $dates = sitchDatesForUser($entry['userID'], $s3Data, $entry['name'], $shots);
                $entry['date'] = $dates[$entry['name']] ?? '';
                if (isset($shots[$entry['name']])) $entry['screenshotName'] = $shots[$entry['name']];
            }
            unset($entry);
            $sitches = array_merge($sitches, $added);
            $templateData = ['sitches' => $sitches];

            writeSharedList('templates', $templateData, $s3Data);

            sitrecAuditResult();
            echo json_encode(['success' => true, 'templates' => $templateData]);
            exit();
        }

        $sanitized = sanitizeMetadata($input);

        global $useAWS;
        if ($useAWS) {
            $s3Data = startS3();
            $s3 = $s3Data['s3'];
            $aws = $s3Data['aws'];

            // Save user-level metadata
            writeS3Json($s3, $aws, 'metadata/' . $user_id . '.json', $sanitized);

            // Write per-sitch metadata.json for each listed sitch
            if (isset($input['updateSitches']) && is_array($input['updateSitches'])) {
                foreach ($input['updateSitches'] as $rawName) {
                    if (!is_string($rawName)) continue;
                    $sitchName = basename($rawName);
                    if (!isValidSitchName($sitchName)) continue;
                    $sitchLabels = $sanitized['sitchLabels'][$sitchName] ?? [];
                    $sitchKey = $user_id . '/' . $sitchName . '/metadata.json';
                    writeS3Json($s3, $aws, $sitchKey, ['labels' => $sitchLabels]);
                }
            }
        } else {
            global $UPLOAD_PATH;

            // Save user-level metadata
            $metaPath = $UPLOAD_PATH . 'metadata/' . $user_id . '.json';
            writeLocalJson($metaPath, $sanitized);

            // Write per-sitch metadata.json for each listed sitch
            if (isset($input['updateSitches']) && is_array($input['updateSitches'])) {
                foreach ($input['updateSitches'] as $rawName) {
                    if (!is_string($rawName)) continue;
                    $sitchName = basename($rawName);
                    if (!isValidSitchName($sitchName)) continue;
                    $sitchLabels = $sanitized['sitchLabels'][$sitchName] ?? [];
                    $sitchPath = $UPLOAD_PATH . $user_id . '/' . $sitchName . '/metadata.json';
                    writeLocalJson($sitchPath, ['labels' => $sitchLabels]);
                }
            }
        }

        sitrecAuditResult();
        echo json_encode(['success' => true, 'metadata' => $sanitized]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Metadata storage unavailable']);
    }
    exit();
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
?>
