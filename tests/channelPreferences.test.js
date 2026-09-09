const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn, spawnSync} = require('child_process');
const net = require('net');
const hasPHP = spawnSync('php', ['-v']).status === 0;

(hasPHP ? describe : describe.skip)('channel preference endpoint', () => {
    let directory, server, origin;
    beforeAll(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-channels-'));
        const port = await new Promise(resolve => {
            const socket = net.createServer();
            socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)); });
        });
        origin = `http://127.0.0.1:${port}`;
        for (const name of ['channels.php', 'channel_preferences.php']) {
            fs.copyFileSync(path.join(__dirname, '../sitrecServer', name), path.join(directory, name));
        }
        fs.writeFileSync(path.join(directory, 'user.php'), `<?php
$useAWS=false; $UPLOAD_PATH=__DIR__.'/uploads/'; $APP_URL='${origin}/sitrec/';
function getUserID() { return (int)($_SERVER['HTTP_X_TEST_IDENTITY'] ?? 0); }
function sitrecAuditRequest($value) {} function sitrecAuditResult() {}
`);
        const shipped = {id: 'shipped-fixture', channel: 'shipped', version: '2.155.2', builtAt: '2026-09-09T00:00:00Z'};
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({format: 1, shipped,
            beta: {...shipped, id: 'beta-fixture', channel: 'beta'}, privateOperatorValue: 'must-not-be-exposed'}));
        server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', directory], {stdio: 'ignore',
            env: {...process.env, SITREC_CHANNEL_MANIFEST: path.join(directory, 'manifest.json')}});
        for (let i = 0; i < 40; i++) {
            try { await request(); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
        }
        throw new Error('PHP fixture did not start');
    });
    afterAll(() => { server?.kill(); if (directory) fs.rmSync(directory, {recursive: true, force: true}); });
    function request({identity = 0, method = 'GET', body, headers = {}} = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request(origin + '/channels.php', {method,
                headers: {'X-Test-Identity': String(identity), ...headers}}, response => {
                let raw = '';
                response.on('data', chunk => raw += chunk);
                response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: JSON.parse(raw)}));
            });
            req.on('error', reject);
            req.end(body === undefined ? undefined : JSON.stringify(body));
        });
    }
    function save(identity, betaProgram, headers = {}) {
        return request({identity, method: 'POST', body: {betaProgram},
            headers: {'Content-Type': 'application/json', Origin: origin, 'X-Sitrec-Channel': '1', ...headers}});
    }
    test('members default to beta; anonymous visitors default to shipped', async () => {
        expect((await request({identity: 42})).body.betaProgram).toBe(true);
        const guest = await request();
        expect(guest.body.userID).toBe(0);
        expect(guest.body.betaProgram).toBe(false);
    });
    test('account opt-out survives old settings replacement and stays scoped to the user', async () => {
        expect((await save(42, false)).status).toBe(200);
        const ordinary = path.join(directory, 'uploads/settings/42.json');
        fs.writeFileSync(ordinary, JSON.stringify({chatModel: 'example-model', startupLocation: false}));
        expect((await request({identity: 42})).body.betaProgram).toBe(false);
        expect((await request({identity: 73})).body.betaProgram).toBe(true);
        expect((await save(42, true)).status).toBe(200);
        expect(JSON.parse(fs.readFileSync(ordinary))).toEqual({chatModel: 'example-model', startupLocation: false});
    });
    test('anonymous writes and cross-origin writes are refused', async () => {
        expect((await save(0, true)).status).toBe(401);
        expect((await save(42, false, {Origin: 'https://evil.example'})).status).toBe(403);
        expect((await save(42, false, {'X-Sitrec-Channel': ''})).status).toBe(403);
        expect((await save(42, false, {'Content-Type': 'text/plain'})).status).toBe(403);
    });
    test.each(['false', 0, null, {}])('refuses non-boolean preference %p', async value => {
        expect((await save(42, value)).status).toBe(400);
    });
    test('personalized responses cannot be cached and omit operator fields', async () => {
        const result = await request({identity: 42});
        expect(result.headers['cache-control']).toBe('private, no-store');
        expect(result.headers.vary).toContain('Cookie');
        expect(JSON.stringify(result.body)).not.toContain('must-not-be-exposed');
        expect(result.body.manifest.shipped.assetBase).toBe('/sitrec/builds/shipped-fixture/');
    });
    test('an unreadable or malformed preference falls back to Shipped rather than enrolling the member', async () => {
        await save(99, false);
        fs.writeFileSync(path.join(directory, 'uploads/settings/99/channel.json'), '{}');
        const result = await request({identity: 99});
        expect(result.body.betaProgram).toBe(false);
        expect(result.body.preferenceAvailable).toBe(false);
    });
});
