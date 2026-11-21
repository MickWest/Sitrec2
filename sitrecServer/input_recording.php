<?php
// Storage and schema for account-scoped UI recordings. This directory must be
// persistent and outside all published paths; never fall back to temporary storage.

function inputRecordingAllowed($identity) {
    $enabled = getenv('INPUT_RECORDING_ENABLED');
    return ($enabled === false || filter_var($enabled, FILTER_VALIDATE_BOOLEAN))
        && in_array((int)($identity['user_id'] ?? 0), [1, 99999999], true);
}

function inputRecordingConfigured($identity) {
    // The same rule as inputRecordingDirectory(): only an absolute directory turns recording
    // on, so a relative path never lets the browser send a batch that cannot be stored.
    $path = trim(getenv('INPUT_RECORDING_DIR') ?: '');
    return inputRecordingAllowed($identity) && $path !== '' && $path[0] === '/';
}

function inputRecordingDirectory() {
    global $UPLOAD_PATH, $CACHE_PATH;
    $path = rtrim(trim(getenv('INPUT_RECORDING_DIR') ?: ''), '/');
    if ($path === '' || $path[0] !== '/') throw new RuntimeException('Configure an absolute INPUT_RECORDING_DIR');
    if (!is_dir($path) && !@mkdir($path, 0700, true) && !is_dir($path)) {
        throw new RuntimeException('Recording directory unavailable');
    }
    $path = realpath($path);
    // Also reject known public mounts outside DOCUMENT_ROOT (uploads/cache).
    foreach ([$_SERVER['DOCUMENT_ROOT'] ?? '', dirname(__DIR__), $UPLOAD_PATH ?? '', $CACHE_PATH ?? ''] as $public) {
        $public = $public ? realpath($public) : false;
        if ($public && ($path === $public || strpos($path . '/', rtrim($public, '/') . '/') === 0)) {
            throw new RuntimeException('Recording directory must be outside published paths');
        }
    }
    if (!$path || !is_writable($path)) throw new RuntimeException('Recording directory is not writable');
    return $path;
}

function inputRecordingText($value, $limit = 300) {
    if (!is_string($value)) return '';
    $value = preg_replace('/[\x00-\x1f\x7f]/u', ' ', $value);
    $value = preg_replace_callback('~https?://[^\s]+~i', function ($match) {
        $url = parse_url($match[0]);
        if (!$url || !isset($url['host'])) return '[url]';
        return ($url['scheme'] ?? 'https') . '://' . $url['host'] .
            (isset($url['port']) ? ':' . $url['port'] : '') . ($url['path'] ?? '');
    }, $value);
    $value = preg_replace('/\b(?:sk-[\w-]+|Bearer\s+\S+)/i', '[redacted]', $value);
    return mb_substr($value, 0, $limit);
}

function inputRecordingFields($input, $strings, $numbers = [], $bools = []) {
    $out = [];
    if (!is_array($input)) return $out;
    foreach ($strings as $key => $limit) {
        if (isset($input[$key]) && is_string($input[$key])) $out[$key] = inputRecordingText($input[$key], $limit);
    }
    foreach ($numbers as $key) {
        $n = $input[$key] ?? null;
        if ((is_int($n) || is_float($n)) && is_finite((float)$n) && abs($n) <= 1e15) $out[$key] = $n;
    }
    foreach ($bools as $key) {
        if (isset($input[$key]) && is_bool($input[$key])) $out[$key] = $input[$key];
    }
    return $out;
}

function inputRecordingEvent($event) {
    $types = ['session', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'contextmenu',
        'wheel', 'scroll', 'input', 'change', 'keydown', 'keyup', 'focusin', 'focusout', 'dragstart', 'drop', 'copy', 'cut', 'paste',
        'control_change', 'control_finish', 'resize', 'error', 'online', 'offline', 'pagehide', 'pageshow', 'visibility', 'gap'];
    if (!is_array($event) || !in_array($event['type'] ?? null, $types, true)
        || !is_int($event['seq'] ?? null) || $event['seq'] < 1 || $event['seq'] > 1e12
        || !(is_int($event['ts'] ?? null) || is_float($event['ts'] ?? null))
        || $event['ts'] < 1 || $event['ts'] > 1e15) {
        throw new InvalidArgumentException('Invalid event');
    }
    foreach (['target', 'context', 'bounds', 'modifiers'] as $key) {
        if (isset($event[$key]) && !is_array($event[$key])) throw new InvalidArgumentException('Invalid event fields');
    }
    $out = inputRecordingFields($event,
        ['type' => 30, 'key' => 40, 'inputType' => 40, 'pointerType' => 20, 'build' => 100,
            'page' => 300, 'language' => 40, 'timezone' => 80, 'name' => 60, 'file' => 300, 'state' => 20],
        ['seq', 'ts', 'elapsed', 'x', 'y', 'button', 'buttons', 'pointerId', 'deltaX', 'deltaY', 'deltaMode',
            'scrollX', 'scrollY', 'fileCount', 'width', 'height', 'pixelRatio', 'line', 'column', 'count'], ['trusted', 'repeat']);
    if (isset($out['page'])) $out['page'] = explode('?', explode('#', $out['page'])[0])[0];
    if (isset($event['context'])) $out['context'] = inputRecordingFields($event['context'],
        ['sitch' => 100, 'view' => 100], ['frame'], ['paused']);
    if (isset($event['bounds'])) $out['bounds'] = inputRecordingFields($event['bounds'], [], ['x', 'y', 'width', 'height']);
    if (isset($event['modifiers'])) $out['modifiers'] = inputRecordingFields($event['modifiers'], [], [], ['alt', 'ctrl', 'meta', 'shift']);
    if (isset($event['target'])) {
        $target = inputRecordingFields($event['target'], ['tag' => 30, 'id' => 100, 'path' => 300, 'role' => 40,
            'inputType' => 40, 'view' => 100], ['fileCount', 'textLength'], ['sensitive', 'disabled']);
        $sensitive = ($target['sensitive'] ?? false) || ($target['inputType'] ?? '') === 'password'
            || preg_match('/password|passwd|secret|credential|api.?key|access.?token|authorization|username/i',
                ($target['path'] ?? '') . ' ' . ($target['id'] ?? ''));
        $value = $event['target']['value'] ?? null;
        if ($sensitive) {
            $target['sensitive'] = true;
            $target['value'] = '[redacted]';
            unset($target['textLength']);
            if (isset($out['key'])) $out['key'] = '[redacted]';
        } elseif (is_bool($value) || (is_numeric($value) && !is_string($value) && is_finite((float)$value))) {
            $target['value'] = $value;
        } elseif (in_array($target['inputType'] ?? '', ['select-one', 'select-multiple', 'color', 'date', 'time', 'datetime-local'], true)) {
            $target['value'] = inputRecordingText($value);
            $target['option'] = inputRecordingText($event['target']['option'] ?? '');
        } elseif (isset($event['target']['value'])) {
            $target['value'] = '[text omitted]';
        }
        if (isset($out['key']) && isset($target['textLength']) && mb_strlen($out['key']) === 1) $out['key'] = '[text]';
        $out['target'] = $target;
    }
    return $out;
}

function appendInputRecording($data, $userId, $effectiveUserId) {
    if (!is_array($data) || ($data['schema'] ?? null) !== 1 || !is_string($data['session'] ?? null)
        || !preg_match('/^\d{4}-\d{2}-\d{2}_[a-f0-9-]{36}$/D', $data['session'])
        || !is_array($data['events'] ?? null) || count($data['events']) < 1 || count($data['events']) > 100) {
        throw new InvalidArgumentException('Invalid batch');
    }
    $events = [];
    $previous = 0;
    foreach ($data['events'] as $event) {
        $event = inputRecordingEvent($event);
        if ($event['seq'] <= $previous) throw new InvalidArgumentException('Events must be ordered');
        $previous = $event['seq'];
        $events[] = $event;
    }
    $directory = inputRecordingDirectory() . '/' . $userId . '/' . substr($data['session'], 0, 10);
    if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Recording session directory unavailable');
    }
    $file = $directory . '/' . $data['session'] . '.jsonl';
    $oldMask = umask(0077);
    $handle = @fopen($file, 'c+b');
    umask($oldMask);
    if (!$handle) throw new RuntimeException('Recording file unavailable');
    try {
        if (!flock($handle, LOCK_EX)) throw new RuntimeException('Recording lock failed');
        $size = fstat($handle)['size'];
        $ack = 0;
        if ($size) {
            // Each validated line is bounded below 16 KiB. The final sequence is
            // the acknowledgement, so no separate state file can get out of sync.
            fseek($handle, max(0, $size - 16384));
            $tail = trim(stream_get_contents($handle));
            $lines = explode("\n", $tail);
            $last = json_decode(end($lines), true);
            if (!is_array($last) || !isset($last['seq'])) throw new RuntimeException('Incomplete recording tail');
            $ack = $last['seq'];
        }
        $received = (int)round(microtime(true) * 1000);
        $lines = [];
        foreach ($events as $event) {
            if ($event['seq'] <= $ack) continue; // repeated beacon / retry / reload
            $lines[] = json_encode(['schema' => 1, 'session' => $data['session'], 'user_id' => $userId,
                'effective_user_id' => $effectiveUserId, 'received' => $received] + $event,
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        }
        if ($lines) {
            $raw = implode("\n", $lines) . "\n";
            fseek($handle, 0, SEEK_END);
            if (fwrite($handle, $raw) !== strlen($raw) || !fflush($handle)) {
                ftruncate($handle, $size);
                throw new RuntimeException('Recording write failed');
            }
            $ack = max($ack, $previous);
        }
        return ['success' => true, 'logged' => count($lines), 'ack' => $ack];
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}
