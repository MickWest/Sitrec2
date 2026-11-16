<?php
// Typed Parquet is the durable satellite cache. CSV remains a compatibility
// response for older clients and a fallback on servers without PyArrow.
function gpParquetIsValid($file) {
    if (!is_file($file) || filesize($file) < 12) return false;
    $stream = @fopen($file, 'rb');
    if (!$stream) return false;
    $head = fread($stream, 4);
    fseek($stream, -4, SEEK_END);
    $tail = fread($stream, 4);
    fclose($stream);
    return $head === 'PAR1' && $tail === 'PAR1';
}

function runGPConverter($operation, $source, $target) {
    if (!function_exists('proc_open')) return false;
    $python = getenv('GP_PYTHON') ?: null;
    if (!$python) {
        $paths = array_filter([getenv('HOME') ? getenv('HOME') . '/.pyenv/shims' : null,
            '/opt/homebrew/bin', '/usr/local/bin']);
        $paths = array_merge($paths, explode(PATH_SEPARATOR, getenv('PATH') ?: '/usr/bin:/bin'));
        foreach ($paths as $path) {
            if ($path !== '' && $path[0] === DIRECTORY_SEPARATOR && is_executable($path . '/python3')) {
                $python = $path . '/python3';
                break;
            }
        }
    }
    if (!$python) return false;
    $process = @proc_open([$python, __DIR__ . '/gpParquet.py', $operation, $source, $target],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes);
    if (!is_resource($process)) return false;
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    $deadline = microtime(true) + 90;
    $diagnostic = '';
    $exitCode = -1;
    while (true) {
        $chunk = stream_get_contents($pipes[1]);
        $diagnostic .= substr($chunk ?: '', 0, max(0, 4096 - strlen($diagnostic)));
        $status = proc_get_status($process);
        if (!$status['running']) { $exitCode = $status['exitcode']; break; }
        if (microtime(true) >= $deadline) {
            proc_terminate($process);
            usleep(100000);
            if (proc_get_status($process)['running']) proc_terminate($process, 9);
            break;
        }
        usleep(10000);
    }
    fclose($pipes[1]);
    $closed = proc_close($process);
    if ($exitCode === -1) $exitCode = $closed;
    if ($exitCode !== 0) error_log('Satellite Parquet conversion unavailable: ' . $diagnostic);
    return $exitCode === 0;
}

// Caller holds the existing per-catalog lock. Keep the old source until the
// converter has verified every typed value and the complete file is published.
function convertGPCacheToParquet($csvFile, $parquetFile) {
    $source = gpCacheEntry($csvFile);
    if ($source === null) return false;
    $temporary = @tempnam(dirname($parquetFile), '.gp-parquet-');
    if ($temporary === false) return false;
    $ok = runGPConverter('encode', $source, $temporary) && gpParquetIsValid($temporary);
    if ($ok) {
        // Migration must not make a provisional/current catalog look fresh.
        $ok = touch($temporary, filemtime($source)) && rename($temporary, $parquetFile);
    }
    if (!$ok) { @unlink($temporary); return false; }
    clearstatcache(true, $parquetFile);
    @unlink($csvFile . '.gz');
    @unlink($csvFile);
    return true;
}

function serveGPParquet($file, $maxAge) {
    $binary = ($_GET['format'] ?? '') === 'parquet';
    $gzip = !$binary && stripos($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip') !== false;
    $modified = filemtime($file);
    $etag = '"' . md5($file . ':' . $modified . ':' . filesize($file))
        . ($binary ? '-parquet' : ($gzip ? '-csv-gzip' : '-csv')) . '"';
    $ifNoneMatch = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
    $ifModifiedSince = strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '');
    $notModified = $ifNoneMatch === $etag
        || ($ifNoneMatch === '' && $ifModifiedSince !== false && $ifModifiedSince >= $modified);
    $csv = null;
    if (!$binary && !$notModified) {
        $csv = tempnam(sys_get_temp_dir(), 'gp-csv-');
        if ($csv === false || !runGPConverter('decode', $file, $csv)) {
            if ($csv !== false) @unlink($csv);
            http_response_code(503);
            exit('ERROR: Could not decode the satellite catalog');
        }
        register_shutdown_function(function () use ($csv) { @unlink($csv); });
    }
    @ini_set('zlib.output_compression', 'Off');
    header('Content-Type: ' . ($binary ? 'application/vnd.apache.parquet' : 'text/plain; charset=UTF-8'));
    header('Cache-Control: public, max-age=' . $maxAge);
    header('Vary: Accept-Encoding');
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $modified) . ' GMT');
    if ($notModified) { http_response_code(304); exit(); }
    if ($binary || $gzip) {
        if ($gzip) header('Content-Encoding: gzip');
        $body = $binary ? $file : $csv;
        header('Content-Length: ' . filesize($body));
        readfile($body);
    } else {
        $stream = gzopen($csv, 'rb');
        while (!gzeof($stream)) echo gzread($stream, 1024 * 1024);
        gzclose($stream);
    }
    exit();
}
