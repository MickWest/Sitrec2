<?php
/**
 * Structured security events. No request bodies, URLs, filenames or credentials.
 * The operator owns collection, access control and retention outside the webroot.
 * See docs/dev/AuditLogging.md for the event inventory and delivery limitations.
 * The audit.php egress contract covers local logger delivery only; any downstream
 * forwarding requires a site-reviewed collector, field set, access and retention.
 */
function sitrecAuditEnabled(): bool
{
    // Certificate deployments cannot disable auditing with a runtime flag.
    return strtolower(trim((string)getenv('AUTH_MODE'))) === 'cert'
        || in_array(strtolower(trim((string)getenv('AUDIT_LOG_ENABLED'))), ['1', 'true', 'yes', 'on'], true);
}

function sitrecAuditState(): object
{
    static $state;
    if ($state === null) {
        $state = (object)[
            'request_id' => bin2hex(random_bytes(16)),
            'actor_id' => null, 'effective_user_id' => null,
            'event' => null, 'resource_sha256' => null,
            'outcome' => null, 'reason' => null, 'finished' => false,
        ];
    }
    return $state;
}

function sitrecAuditToken($value, string $fallback = 'unknown'): string
{
    return is_string($value) && preg_match('/\A[a-zA-Z0-9_.-]{1,64}\z/D', $value)
        ? $value : $fallback;
}

function sitrecAuditIdentity(array $original, ?array $effective = null): void
{
    if (!sitrecAuditEnabled()) return;
    $state = sitrecAuditState();
    $state->actor_id = max(0, (int)($original['user_id'] ?? 0));
    $state->effective_user_id = max(0, (int)(($effective ?? $original)['user_id'] ?? 0));
}

function sitrecAuditResource(string $resource): void
{
    if (sitrecAuditEnabled()) sitrecAuditState()->resource_sha256 = hash('sha256', $resource);
}

/** Only fixed metadata fields cross this boundary; unknown fields are discarded. */
function sitrecAuditWrite(string $event, string $outcome, string $reason, array $extra = []): bool
{
    if (!sitrecAuditEnabled()) return true;
    $state = sitrecAuditState();
    $peer = $_SERVER['REMOTE_ADDR'] ?? '';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'CLI';
    $record = [
        'schema' => 'sitrec.audit.v1',
        'timestamp' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z'),
        'request_id' => $state->request_id,
        'instance' => sitrecAuditToken(gethostname()),
        'endpoint' => sitrecAuditToken(basename($_SERVER['SCRIPT_FILENAME'] ?? 'unknown')),
        'method' => in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CLI'], true) ? $method : 'OTHER',
        // The transport peer, never an untrusted Forwarded/X-Forwarded-For value.
        'remote_addr' => filter_var($peer, FILTER_VALIDATE_IP) ? $peer : null,
        'actor_id' => $state->actor_id,
        'effective_user_id' => $state->effective_user_id,
        'event' => sitrecAuditToken($event),
        'outcome' => sitrecAuditToken($outcome),
        'reason' => sitrecAuditToken($reason),
        'resource_sha256' => $state->resource_sha256,
    ];
    foreach (['auth', 'identifier_sha256', 'phase'] as $key) {
        if (isset($extra[$key])) $record[$key] = sitrecAuditToken($extra[$key]);
    }
    if (isset($extra['http_status'])) $record['http_status'] = (int)$extra['http_status'];
    $line = 'SITREC_AUDIT ' . json_encode($record, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    $destination = strtolower(trim((string)getenv('AUDIT_LOG_DESTINATION')));
    $ok = false;
    if ($destination === 'syslog') {
        // The local system collector forwards securely; the app opens no network socket.
        $ok = openlog('sitrec-audit', LOG_PID, LOG_AUTHPRIV) && syslog(LOG_INFO, $line);
    } elseif ($destination === '' || $destination === 'error_log') {
        $ok = error_log($line);
    }
    if (!$ok) {
        // Never include the record or destination in a fallback diagnostic.
        error_log('SITREC_AUDIT_DELIVERY_FAILED: check the configured audit collector');
    }
    return $ok;
}

function sitrecAuditAuthentication(array $result): void
{
    sitrecAuditIdentity(['user_id' => $result['user_id'] ?? 0]);
    $identifier = $result['identifier'] ?? null;
    sitrecAuditWrite('authentication', ($result['user_id'] ?? 0) > 0 ? 'accepted' : 'refused',
        $result['reason'] ?? 'ok', [
            'auth' => 'cert',
            'identifier_sha256' => is_string($identifier) && $identifier !== '' ? hash('sha256', $identifier) : null,
        ]);
}

/** Start before validation so early refusals and exceptions are recorded too. */
function sitrecAuditRequest(string $event): void
{
    if (!sitrecAuditEnabled()) return;
    $state = sitrecAuditState();
    if ($state->event !== null) return;
    $state->event = $event;
    register_shutdown_function('sitrecAuditFinish');
    // Public capability reads stay anonymous unless auditing is explicitly enabled.
    require_once __DIR__ . '/user.php';
    getUserInfo();
    sitrecAuditWrite($event, 'attempted', 'request_received', ['phase' => 'start']);
}

function sitrecAuditOperation(string $event): void
{
    if (sitrecAuditEnabled()) sitrecAuditState()->event = $event;
}

/** Call success only after the operation actually completed, never just on HTTP 200. */
function sitrecAuditResult(string $outcome = 'success', string $reason = 'completed'): void
{
    if (!sitrecAuditEnabled()) return;
    $state = sitrecAuditState();
    if ($outcome === 'success' && $state->outcome !== null && $state->outcome !== 'success') return;
    $state->outcome = $outcome;
    $state->reason = $reason;
}

function sitrecAuditFinish(): void
{
    $state = sitrecAuditState();
    if ($state->finished || $state->event === null) return;
    $state->finished = true;
    $status = http_response_code() ?: 200;
    $error = error_get_last();
    $outcome = $state->outcome ?? 'failure';
    $reason = $state->reason ?? 'incomplete';
    if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
        $outcome = 'failure'; $reason = 'runtime_error';
    } elseif (in_array($status, [401, 403], true)) {
        $outcome = 'denied'; $reason = 'authorization_failed';
    } elseif ($status === 429) {
        $outcome = 'denied'; $reason = 'rate_limited';
    } elseif (in_array($status, [400, 405, 413, 415, 422], true)) {
        $outcome = 'rejected'; $reason = 'invalid_request';
    } elseif ($status >= 400) {
        $outcome = 'failure'; $reason = 'http_error';
    }
    sitrecAuditWrite($state->event, $outcome, $reason, ['phase' => 'finish', 'http_status' => $status]);
}
