const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const {spawn, spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const phpAvailable = spawnSync('php', ['-v'], {encoding: 'utf8'}).status === 0;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

(phpAvailable ? describe : describe.skip)('server security audit events', () => {
    let tmp, web, logs, server, port;
    const records = () => (fs.existsSync(logs) ? fs.readFileSync(logs, 'utf8') : '')
        .split('\n').filter(line => line.includes('SITREC_AUDIT {'))
        .map(line => JSON.parse(line.slice(line.indexOf('SITREC_AUDIT ') + 13)));

    beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-audit-'));
        web = path.join(tmp, 'sitrecServer');
        logs = path.join(tmp, 'audit.log');
        fs.mkdirSync(web);
        for (const name of ['uploads', 'short', 'cache', 'data']) fs.mkdirSync(path.join(tmp, name));
        for (const name of ['audit.php', 'user.php', 'auth_cert.php', 'object_helpers.php', 'requestScheme.php',
            'rehost.php', 'settings.php', 'metadata.php', 'getsitches.php', 'object.php', 's3-proxy.php',
            'shortener.php', 'admin_info.php', 'proxy.php', 'gpData.php', 'customWindProxy.php', 'curlGetRequest.php', 'injectEnv.php']) {
            fs.copyFileSync(path.join(root, 'sitrecServer', name), path.join(web, name));
        }
        // Only infrastructure/identity/storage are substituted. Requests execute the real endpoints.
        fs.writeFileSync(path.join(web, 'config.php'), `<?php
putenv('AUTH_MODE=' . ($_SERVER['HTTP_X_TEST_AUTH'] ?? 'forum'));
putenv('AUDIT_LOG_ENABLED=' . ($_SERVER['HTTP_X_TEST_AUDIT'] ?? 'true'));
putenv('AUDIT_LOG_DESTINATION=' . ($_SERVER['HTTP_X_TEST_DESTINATION'] ?? 'error_log'));
$useAWS = ($_SERVER['HTTP_X_TEST_STORAGE'] ?? '') === 's3';
$s3creds = ['bucket' => 'example-bucket', 'region' => 'example-region'];
function getUserInfoCustom() {
    if (isset($_SERVER['HTTP_X_TEST_IDENTITY_ERROR'])) throw new RuntimeException('Identity unavailable');
    return ['user_id' => (int)($_SERVER['HTTP_X_TEST_USER'] ?? 42),
        'user_groups' => isset($_SERVER['HTTP_X_TEST_ADMIN']) ? [3, 2] : [2]];
}
`);
        fs.writeFileSync(path.join(web, 'config_paths.php'), `<?php
require_once __DIR__ . '/requestScheme.php';
$APP_PATH = dirname(__DIR__) . '/';
$UPLOAD_PATH = $APP_PATH . 'uploads/';
$SHORTENER_PATH = $APP_PATH . 'short/';
$CACHE_PATH = $APP_PATH . 'cache/';
$APP_URL = 'https://example.test/';
$UPLOAD_URL = $APP_URL . 'uploads/';
$SHORTENER_URL = $APP_URL . 'short/';
`);
        fs.writeFileSync(path.join(web, 's3_client.php'), `<?php
function s3HasCredentials() { return $GLOBALS['useAWS']; }
function s3ConfiguredEndpointHost() { return ''; }
function s3ObjectUrl($bucket, $key) { return 'https://example.test/' . rawurlencode($key); }
function getS3Client() {
    if (isset($_SERVER['HTTP_X_TEST_STORAGE_ERROR'])) throw new RuntimeException('storage failed');
    return new class {
        function getObject($params) {
            return ['ContentType' => 'application/octet-stream', '@metadata' => ['statusCode' => 200],
                'Body' => new class {
                    private $sent = false;
                    function eof() { return $this->sent; }
                    function read($n) { $this->sent = true; return 'stored-content'; }
                    function getContents() { return '{}'; }
                    function __toString() { return '{}'; }
                }];
        }
        function putObject($params) { return []; }
        function getIterator($operation, $params) { return []; }
        function upload(...$args) { return []; }
        function deleteMatchingObjects(...$args) { return []; }
        function getCommand($operation, $params) { return []; }
        function createPresignedRequest(...$args) { return new class {
            function getUri() { return 'https://example.test/signed?token=DO_NOT_LOG'; }
        }; }
        function createMultipartUpload($params) { return ['UploadId' => 'DO_NOT_LOG']; }
        function listMultipartUploads($params) { return ['Uploads' => [
            ['UploadId' => 'DO_NOT_LOG', 'Key' => '42/Test/v.js']]]; }
        function completeMultipartUpload($params) { return ['ETag' => 'example']; }
    };
}
`);
        fs.mkdirSync(path.join(web, 'vendor'));
        fs.writeFileSync(path.join(web, 'vendor', 'autoload.php'), '<?php');
        fs.writeFileSync(path.join(web, 'probe.php'), `<?php
require __DIR__ . '/user.php';
sitrecAuditRequest('probe.operation');
if (isset($_GET['fatal'])) throw new RuntimeException('synthetic failure');
sitrecAuditResource("42/private file\\n?token=DO_NOT_LOG");
sitrecAuditWrite("unsafe\\nforged", 'failure', "reason\\r\\nforged", ['body' => 'DO_NOT_LOG']);
if (!isset($_GET['incomplete'])) sitrecAuditResult();
echo 'ok';
`);
        fs.writeFileSync(path.join(web, 'cache-probe.php'), `<?php
require __DIR__ . '/user.php';
require __DIR__ . '/gpData.php';
sitrecAuditRequest('catalogue.read');
serveGPCached(dirname(__DIR__) . '/cache/sample.csv', '/fallback.csv', 60, 'sitrecAuditResult');
`);
        const listener = net.createServer();
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        port = listener.address().port;
        await new Promise(resolve => listener.close(resolve));
        server = spawn('php', ['-d', 'display_errors=0', '-d', 'log_errors=1', '-d', `error_log=${logs}`,
            '-d', `sys_temp_dir=${tmp}`, '-S', `127.0.0.1:${port}`, '-t', tmp],
            {cwd: web, env: {...process.env, AUDIT_LOG_ENABLED: 'true'}, stdio: ['ignore', 'ignore', 'pipe']});
        await new Promise((resolve, reject) => {
            let output = '';
            server.stderr.on('data', chunk => { output += chunk; if (output.includes('started')) resolve(); });
            server.once('error', reject);
            server.once('exit', code => reject(new Error(`PHP server exited ${code}: ${output}`)));
        });
    });

    afterAll(async () => {
        if (server && server.exitCode === null) {
            const done = new Promise(resolve => server.once('exit', resolve));
            server.kill();
            await done;
        }
        if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
    });

    async function request(endpoint, {method = 'GET', headers = {}, body} = {}) {
        const offset = records().length;
        if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
            body = JSON.stringify(body);
            headers = {'Content-Type': 'application/json', ...headers};
        }
        if (body) headers['Content-Length'] = Buffer.byteLength(body);
        const response = await new Promise((resolve, reject) => {
            const req = http.request({hostname: '127.0.0.1', port, path: `/sitrecServer/${endpoint}`, method, headers}, res => {
                let text = '';
                res.on('data', chunk => { text += chunk; });
                res.on('end', () => resolve({status: res.statusCode, text}));
            });
            req.on('error', reject);
            req.end(body);
        });
        return {...response, events: records().slice(offset)};
    }
    const finished = result => result.events.find(event => event.phase === 'finish');

    test('settings save/read records actor, UTC time, request correlation and target digest', async () => {
        const saved = await request('settings.php?token=DO_NOT_LOG', {method: 'POST', body: {settings: {fpsLimit: 30, apiKey: 'DO_NOT_LOG'}}});
        expect(saved.status).toBe(200);
        expect(finished(saved)).toMatchObject({event: 'settings.write', outcome: 'success', actor_id: 42,
            effective_user_id: 42, resource_sha256: digest('settings/42'), http_status: 200, remote_addr: '127.0.0.1'});
        expect(saved.events[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
        expect(new Set(saved.events.map(e => e.request_id)).size).toBe(1);
        expect(saved.events[0].request_id).toMatch(/^[a-f0-9]{32}$/);
        expect(JSON.stringify(saved.events)).not.toContain('DO_NOT_LOG');
        const read = await request('settings.php');
        expect(JSON.parse(read.text).settings.fpsLimit).toBe(30);
        expect(finished(read)).toMatchObject({event: 'settings.read', outcome: 'success'});
        expect(finished(read).request_id).not.toBe(finished(saved).request_id);
    });

    test('administrator impersonation preserves the original actor', async () => {
        const result = await request('settings.php?testUserID=73', {headers: {'X-Test-User': '7', 'X-Test-Admin': '1'}});
        expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({event: 'authorization.impersonation',
            outcome: 'accepted', actor_id: 7, effective_user_id: 73})]));
        expect(finished(result)).toMatchObject({actor_id: 7, effective_user_id: 73});
        const denied = await request('settings.php?testUserID=73');
        expect(denied.events).toEqual(expect.arrayContaining([expect.objectContaining({event: 'authorization.impersonation', outcome: 'denied'})]));
        expect(finished(denied)).toMatchObject({actor_id: 42, effective_user_id: 42});
    });

    test('early authentication, authorization and validation failures are audited', async () => {
        const anonymous = await request('rehost.php', {headers: {'X-Test-User': '0'}});
        expect(finished(anonymous)).toMatchObject({outcome: 'denied', http_status: 401});
        const invalid = await request('settings.php', {method: 'POST', body: '{invalid', headers: {'Content-Type': 'application/json'}});
        expect(finished(invalid)).toMatchObject({outcome: 'rejected', http_status: 400});
        const forbidden = await request('metadata.php', {method: 'POST', body: {updateFeatured: true}});
        expect(finished(forbidden)).toMatchObject({event: 'featured.write', outcome: 'denied', http_status: 403});
        const empty = await request('getsitches.php?get=myfiles', {headers: {'X-Test-User': '0'}});
        expect(empty.status).toBe(200);
        expect(finished(empty)).toMatchObject({outcome: 'denied', reason: 'authentication_required'});
        const versions = await request('getsitches.php?get=versions&userid=73&name=Example', {headers: {'X-Test-Storage': 's3'}});
        expect(versions.events).toEqual(expect.arrayContaining([expect.objectContaining({
            event: 'authorization.version_list', outcome: 'denied', resource_sha256: digest('versions/73/Example')})]));
        expect(finished(versions)).toMatchObject({outcome: 'success', resource_sha256: digest('versions/42/Example')});
    });

    test('metadata writes, featured updates and administrator reads are recorded', async () => {
        for (const [body, event] of [[{labels: [{name: 'private label'}]}, 'metadata.write'],
            [{bumpScreenshotVersions: ['Example']}, 'metadata.screenshot_versions'],
            [{updateFeatured: true, sitches: []}, 'featured.write']]) {
            const result = await request('metadata.php', {method: 'POST', headers: {'X-Test-Admin': '1'}, body});
            expect(result.status).toBe(200);
            expect(finished(result)).toMatchObject({event, outcome: 'success'});
            expect(JSON.stringify(result.events)).not.toContain('private label');
        }
        const admin = await request('admin_info.php?user=73', {headers: {'X-Test-Admin': '1'}});
        expect(finished(admin)).toMatchObject({event: 'administrator.user_read', resource_sha256: digest('user/73'), outcome: 'success'});
    });

    test('uploads and deletes are logged after the filesystem operation succeeds', async () => {
        const boundary = 'AuditTestBoundary';
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\nExample\r\n--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\nv.js\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="v.js"\r\nContent-Type: application/octet-stream\r\n\r\nDO_NOT_LOG\r\n--${boundary}--\r\n`;
        const upload = await request('rehost.php', {method: 'POST', headers: {'Content-Type': `multipart/form-data; boundary=${boundary}`}, body});
        expect(upload.status).toBe(200);
        expect(fs.readFileSync(path.join(tmp, 'uploads/42/Example/v.js'), 'utf8')).toBe('DO_NOT_LOG');
        expect(finished(upload)).toMatchObject({event: 'object.upload', outcome: 'success', resource_sha256: digest('42/Example/v.js')});
        const remove = await request('rehost.php', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'delete=true&filename=Example&version=v.js'});
        expect(fs.existsSync(path.join(tmp, 'uploads/42/Example/v.js'))).toBe(false);
        expect(finished(remove)).toMatchObject({event: 'object.delete', outcome: 'success'});
        expect(JSON.stringify([...upload.events, ...remove.events])).not.toContain('DO_NOT_LOG');
    });

    test('presigned authorization and multipart completion are distinct events', async () => {
        for (const [action, event, extra] of [['getPresignedUrl', 'upload.authorize', {}],
            ['initiateMultipart', 'upload.initiate', {parts: 2}],
            ['completeMultipart', 'upload.complete', {uploadId: 'DO_NOT_LOG', parts: []}]]) {
            const result = await request(`rehost.php?action=${action}`, {method: 'POST', headers: {'X-Test-Storage': 's3'},
                body: {filename: 'Test', version: 'v.js', ...extra}});
            expect(result.status).toBe(200);
            expect(finished(result)).toMatchObject({event, outcome: 'success', resource_sha256: digest('42/Test/v.js')});
            expect(JSON.stringify(result.events)).not.toContain('DO_NOT_LOG');
        }
    });

    test('object reads/resolution and sharing identify targets without exposing capabilities', async () => {
        const key = '42/Private/v.js';
        const read = await request(`s3-proxy.php?key=${encodeURIComponent(key)}`, {headers: {'X-Test-Storage': 's3'}});
        expect(read.text).toBe('stored-content');
        expect(finished(read)).toMatchObject({event: 'object.read', outcome: 'success', resource_sha256: digest(key)});
        const resolved = await request(`object.php?ref=${encodeURIComponent(key)}`);
        expect(finished(resolved)).toMatchObject({event: 'object.resolve', outcome: 'success'});
        const forbidden = await request('object.php?ref=73%2FPrivate%2F');
        expect(finished(forbidden)).toMatchObject({outcome: 'denied'});
        const shared = await request(`shortener.php?url=${encodeURIComponent('https://example.test/?custom=DO_NOT_LOG')}`);
        expect(finished(shared)).toMatchObject({event: 'share.create', outcome: 'success'});
        expect(JSON.stringify([...read.events, ...resolved.events, ...shared.events])).not.toMatch(/Private|DO_NOT_LOG/);
    });

    test('disk and SDK write failures never produce a success record', async () => {
        fs.mkdirSync(path.join(tmp, 'uploads/settings/99.json'));
        const disk = await request('settings.php', {method: 'POST', headers: {'X-Test-User': '99'}, body: {settings: {fpsLimit: 30}}});
        expect(disk.status).toBe(500);
        expect(finished(disk)).toMatchObject({outcome: 'failure'});
        expect(disk.text).not.toContain(tmp);
        const sdk = await request('settings.php', {method: 'POST', headers: {'X-Test-Storage': 's3', 'X-Test-Storage-Error': '1'}, body: {settings: {}}});
        expect(sdk.status).toBe(500);
        expect(finished(sdk)).toMatchObject({outcome: 'failure'});
        fs.mkdirSync(path.join(tmp, 'uploads/42/NonEmpty/child'), {recursive: true});
        const remove = await request('rehost.php', {method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'delete=true&filename=NonEmpty'});
        expect(remove.status).toBe(500);
        expect(remove.text).toBe('Object deletion failed');
        expect(finished(remove)).toMatchObject({event: 'object.delete', outcome: 'failure'});
    });

    test('configuration reads through the real include cycle complete once', async () => {
        const configPath = path.join(web, 'config_paths.php');
        const fixture = fs.readFileSync(configPath);
        try {
            fs.copyFileSync(path.join(root, 'sitrecServer/config_paths.php'), configPath);
            const result = await request('config_paths.php?FETCH_CONFIG=1');
            expect(result.status).toBe(200);
            expect(JSON.parse(result.text)).not.toHaveProperty('UPLOAD_PATH');
            expect(result.events.filter(e => e.phase === 'finish')).toHaveLength(1);
            expect(finished(result)).toMatchObject({event: 'configuration.read', outcome: 'success'});
        } finally {
            fs.writeFileSync(configPath, fixture);
        }
    });

    test('cached catalogue audit distinguishes streamed, unchanged and redirected responses', async () => {
        fs.writeFileSync(path.join(tmp, 'cache/sample.csv.gz'), zlib.gzipSync('sample catalogue'));
        for (const headers of [{}, {'Accept-Encoding': 'gzip'}]) {
            const streamed = await request('cache-probe.php', {headers});
            expect(finished(streamed)).toMatchObject({outcome: 'success', reason: 'stream_finished'});
        }
        const unchanged = await request('cache-probe.php', {headers: {'If-Modified-Since': new Date(Date.now() + 10000).toUTCString()}});
        expect(finished(unchanged)).toMatchObject({outcome: 'success', reason: 'not_modified', http_status: 304});
        fs.unlinkSync(path.join(tmp, 'cache/sample.csv.gz'));
        const redirected = await request('cache-probe.php');
        expect(finished(redirected)).toMatchObject({outcome: 'success', reason: 'redirect_issued', http_status: 302});
    });

    test('fatal errors and incomplete HTTP 200 paths are distinguishable from completion', async () => {
        expect(finished(await request('probe.php?fatal=1'))).toMatchObject({outcome: 'failure', reason: 'runtime_error'});
        expect(finished(await request('probe.php?incomplete=1'))).toMatchObject({outcome: 'failure', reason: 'incomplete', http_status: 200});
    });

    test('log injection and forged correlation/client IP headers cannot alter records', async () => {
        const result = await request('probe.php', {headers: {'X-Request-ID': 'forged', 'X-Forwarded-For': '192.0.2.1', Authorization: 'DO_NOT_LOG'}});
        expect(result.events).toHaveLength(3);
        expect(result.events[1]).toMatchObject({event: 'unknown', reason: 'unknown'});
        expect(JSON.stringify(result.events)).not.toMatch(/DO_NOT_LOG|forged|192\.0\.2\.1/);
    });

    test('public capability reads keep working without identity lookup when auditing is off', async () => {
        const result = await request('object.php?ref=42%2FExample%2Fv.js', {headers: {'X-Test-Audit': 'false', 'X-Test-Identity-Error': '1'}});
        expect(result.status).toBe(200);
        expect(result.events).toEqual([]);
    });

    test('certificate mode cannot turn auditing off and sink failure raises a safe diagnostic', async () => {
        const cert = await request('settings.php', {headers: {'X-Test-Auth': 'cert', 'X-Test-Audit': 'false'}});
        expect(finished(cert)).toMatchObject({event: 'settings.read', outcome: 'success'});
        const badSink = await request('settings.php', {headers: {'X-Test-Destination': 'invalid'}});
        expect(badSink.status).toBe(200);
        expect(badSink.events).toEqual([]);
        expect(fs.readFileSync(logs, 'utf8')).toContain('SITREC_AUDIT_DELIVERY_FAILED');
    });

    test('proxy validation and rate-limit refusals appear in the audit stream', async () => {
        const wind = await request('customWindProxy.php?date=invalid');
        expect(finished(wind)).toMatchObject({event: 'wind.read', outcome: 'rejected'});
        const catalogue = await request('proxy.php?request=unknown');
        expect(finished(catalogue)).toMatchObject({event: 'catalogue.read', outcome: 'rejected'});
        let limited;
        // PHP's temporary directory is isolated to this fixture.
        const actor = '12345';
        for (let i = 0; i < 11; i++) limited = await request('shortener.php', {headers: {'X-Test-User': actor}});
        expect(finished(limited)).toMatchObject({outcome: 'denied', reason: 'rate_limited', http_status: 429});
    });
});
