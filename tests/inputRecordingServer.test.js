const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const {spawn, spawnSync} = require('child_process');

const available = spawnSync('php', ['-v']).status === 0;
const session = '2026-11-19_12345678-1234-4234-8234-123456789abc';
const event = (seq, more = {}) => ({seq, type: 'click', ts: 1795123456789, target: {path: 'Camera/Zoom'}, ...more});

(available ? describe : describe.skip)('persistent input recording endpoint', () => {
    let root, web, logs, port, server, serverOutput = '';
    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-input-test-'));
        web = path.join(root, 'web', 'sitrecServer'); logs = path.join(root, 'recordings');
        fs.mkdirSync(web, {recursive: true}); fs.mkdirSync(path.join(root, 'tmp'));
        for (const name of ['inputlog.php', 'input_recording.php', 'user.php', 'audit.php', 'rate_limit.php', 'rehost.php', 'object_helpers.php']) {
            fs.copyFileSync(path.resolve(__dirname, '../sitrecServer', name), path.join(web, name));
        }
        fs.writeFileSync(path.join(web, 'config.php'), `<?php
function getUserInfoCustom() { return ['user_id' => (int)($_SERVER['HTTP_X_TEST_USER'] ?? 1), 'user_groups' => [3]]; }
if (isset($_SERVER['HTTP_X_TEST_ENABLED'])) putenv('INPUT_RECORDING_ENABLED=' . $_SERVER['HTTP_X_TEST_ENABLED']);
if (isset($_SERVER['HTTP_X_TEST_DIRECTORY'])) putenv('INPUT_RECORDING_DIR=' . $_SERVER['HTTP_X_TEST_DIRECTORY']);
`);
        fs.writeFileSync(path.join(web, 'config_paths.php'), `<?php
$APP_URL = 'http://' . $_SERVER['HTTP_HOST'] . '/';
$UPLOAD_PATH = __DIR__ . '/uploads/'; $CACHE_PATH = __DIR__ . '/cache/';
`);
        fs.writeFileSync(path.join(web, 's3_client.php'), '<?php // Login does not use object storage.');
        const listener = net.createServer();
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        port = listener.address().port;
        await new Promise(resolve => listener.close(resolve));
        await launchServer();
    });
    async function launchServer() {
        server = spawn('php', ['-d', 'display_errors=0', '-d', `sys_temp_dir=${root}/tmp`, '-S', `127.0.0.1:${port}`, '-t', path.dirname(web)],
            {cwd: web, env: {...process.env, AUDIT_LOG_ENABLED: 'false', INPUT_RECORDING_ENABLED: 'true', INPUT_RECORDING_DIR: logs},
                stdio: ['ignore', 'ignore', 'pipe']});
        await new Promise((resolve, reject) => {
            server.stderr.on('data', data => { serverOutput += data; if (data.toString().includes('started')) resolve(); });
            server.once('error', reject); server.once('exit', code => reject(new Error(`PHP exited: ${code}`)));
        });
    }
    async function stopServer() {
        if (server && server.exitCode === null) {
            const exited = new Promise(resolve => server.once('exit', resolve));
            server.kill(); await exited;
        }
    }
    afterAll(async () => {
        await stopServer();
        if (root) fs.rmSync(root, {recursive: true, force: true});
    });

    function post(events, headers = {}, query = '', override = {}) {
        const body = JSON.stringify({schema: 1, session, events, ...override});
        return new Promise((resolve, reject) => {
            const req = http.request({host: '127.0.0.1', port, path: '/sitrecServer/inputlog.php' + query, method: 'POST',
                headers: {Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body), ...headers}}, res => {
                let raw = ''; res.on('data', chunk => raw += chunk);
                res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(raw)}));
            });
            req.once('error', reject); req.end(body);
        });
    }
    const file = (uid = 1) => path.join(logs, String(uid), '2026-11-19', session + '.jsonl');
    const read = uid => fs.readFileSync(file(uid), 'utf8').trim().split('\n').map(JSON.parse);

    test('login advertises recording for the real account, even while testing another account', async () => {
        async function login(user, effective = 42) {
            return new Promise((resolve, reject) => {
                http.get({host: '127.0.0.1', port, path: `/sitrecServer/rehost.php?getuser=1&testUserID=${effective}`,
                    headers: {'X-Test-User': user}}, res => {
                    let raw = ''; res.on('data', chunk => raw += chunk);
                    res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error(raw + serverOutput)); } });
                }).once('error', reject);
            });
        }
        expect(await login(1)).toMatchObject({userID: 42, inputRecording: true, inputRecordingUserID: 1});
        expect(await login(99999999)).toMatchObject({inputRecording: true, inputRecordingUserID: 99999999});
        const other = await login(42, 99999999);
        expect(other.inputRecording).toBe(false);
        expect(other.inputRecordingUserID).toBeUndefined();
    });

    test('real identity, not a request field or admin impersonation, controls access', async () => {
        for (const user of [0, 42, 88888888]) {
            expect((await post([event(1)], {'X-Test-User': user}, '?testUserID=1', {user_id: 1})).status).toBe(403);
            expect((await post([event(1)], {'X-Test-User': user}, '?testUserID=99999999')).status).toBe(403);
        }
        expect(fs.existsSync(logs)).toBe(false);
    });

    test('both authorized accounts write private JSONL; effective identity is separate', async () => {
        expect((await post([event(1)], {}, '?testUserID=42')).data).toEqual({success: true, logged: 1, ack: 1});
        expect(read(1)[0]).toMatchObject({user_id: 1, effective_user_id: 42, schema: 1, session, seq: 1});
        expect((await post([event(1)], {'X-Test-User': '99999999'})).status).toBe(200);
        expect(read(99999999)[0].user_id).toBe(99999999);
        expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
        expect(fs.statSync(logs).mode & 0o777).toBe(0o700);
    });

    test('retry and beacon duplicates are idempotent across independent PHP requests', async () => {
        expect((await post([event(1), event(2)])).data).toEqual({success: true, logged: 1, ack: 2});
        expect((await post([event(1), event(2)])).data).toEqual({success: true, logged: 0, ack: 2});
        expect(read().map(e => e.seq)).toEqual([1, 2]);
        expect((await post([event(3), event(2)])).status).toBe(400);
        expect(read()).toHaveLength(2);
    });

    test('server independently redacts secrets and discards unknown payload properties', async () => {
        await post([event(3, {type: 'keydown', key: 's', cookies: 'secret-cookie',
            target: {inputType: 'password', path: 'API key', value: 'secret-value', textLength: 12}}),
        event(4, {type: 'input', target: {inputType: 'text', path: 'Search', value: 'secret-free-text', textLength: 16}}),
        event(5, {target: {path: 'Open https://user:pass@example.test/a?token=secret#secret'}})]);
        const raw = fs.readFileSync(file(), 'utf8');
        expect(raw).not.toMatch(/secret-cookie|secret-value|secret-free-text|user:pass|token=secret|#secret/);
        expect(read()[2].target).toEqual({inputType: 'password', path: 'API key', sensitive: true, value: '[redacted]'});
        expect(read()[2].key).toBe('[redacted]');
    });

    test('cross-site writes, malformed or oversized batches and public directories are refused', async () => {
        expect((await post([event(6)], {Origin: 'https://other.test'})).status).toBe(403);
        expect((await post([event(6)], {Origin: ''})).status).toBe(403);
        expect((await post([event(6)], {}, '', {session: '../../outside'})).status).toBe(400);
        expect((await post([event(6, {type: 'unknown'})])).status).toBe(400);
        expect((await post([event(6)], {}, '', {extra: 'x'.repeat(66000)})).status).toBe(413);
        expect((await post([event(6)], {'X-Test-Directory': path.join(web, 'recordings')})).status).toBe(503);
        expect(fs.existsSync(path.join(web, 'recordings', '1'))).toBe(false);
        expect(read()).toHaveLength(5);
    });

    test('disabled recording and unconfigured storage never fall back to a temp log', async () => {
        expect((await post([event(6)], {'X-Test-Enabled': 'false'})).status).toBe(403);
        expect((await post([event(6)], {'X-Test-Directory': ''})).data).toEqual({disabled: true});
        expect(read()).toHaveLength(5);
    });

    test('logs and deduplication survive a backend restart; the analysis command reads the result', async () => {
        await stopServer(); await launchServer();
        expect((await post([event(5), event(6)])).data).toEqual({success: true, logged: 1, ack: 6});
        expect(read()).toHaveLength(6);
        const report = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/analyzeInputRecording.mjs'), logs], {encoding: 'utf8'});
        expect(report.status).toBe(0);
        const summary = JSON.parse(report.stdout);
        expect(summary.sessions).toHaveLength(2);
        expect(summary.sessions.find(s => s.user === 1).events).toBe(6);
        expect(summary.malformedLines).toBe(0);
    });
});
