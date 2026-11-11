// The global template list on the server: metadata.php writes and serves it, and
// getsitches.php uses it to decide who can list the versions of a sitch.
// The requests run the real endpoints under PHP's built-in server. Only the
// configuration, the identity and the storage paths are substituted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const {spawn, spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const phpAvailable = spawnSync('php', ['-v'], {encoding: 'utf8'}).status === 0;

const OWNER = 7;          // an administrator, and the owner of the template
const ADMIN = {'X-Test-User': String(OWNER), 'X-Test-Admin': '1'};
const USER = {'X-Test-User': '42'};
const ANONYMOUS = {'X-Test-User': '0'};

(phpAvailable ? describe : describe.skip)('global template list on the server', () => {
    let tmp, web, uploads, server, port;

    beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-templates-'));
        web = path.join(tmp, 'sitrecServer');
        uploads = path.join(tmp, 'uploads');
        fs.mkdirSync(web);
        for (const name of ['uploads', 'short', 'cache', 'data']) fs.mkdirSync(path.join(tmp, name));
        for (const name of ['audit.php', 'user.php', 'auth_cert.php', 'object_helpers.php', 'requestScheme.php',
            'metadata.php', 'getsitches.php']) {
            fs.copyFileSync(path.join(root, 'sitrecServer', name), path.join(web, name));
        }
        fs.writeFileSync(path.join(web, 'config.php'), `<?php
putenv('AUTH_MODE=forum');
putenv('AUDIT_LOG_ENABLED=false');
$useAWS = false;
$s3creds = [];
function getUserInfoCustom() {
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
function s3HasCredentials() { return false; }
function s3ConfiguredEndpointHost() { return ''; }
`);
        fs.mkdirSync(path.join(web, 'vendor'));
        fs.writeFileSync(path.join(web, 'vendor', 'autoload.php'), '<?php');

        // The saved sitches of the administrator. Each has one version and one screenshot.
        for (const sitchName of ['Starlink Flares', 'Video Analysis', 'Not Published']) {
            const sitchDir = path.join(uploads, String(OWNER), sitchName);
            fs.mkdirSync(sitchDir, {recursive: true});
            fs.writeFileSync(path.join(sitchDir, '20261111_120000.js'), '{}');
            fs.writeFileSync(path.join(sitchDir, 'screenshot_20261111_120000_abc123.jpg'), 'jpeg');
        }

        const listener = net.createServer();
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        port = listener.address().port;
        await new Promise(resolve => listener.close(resolve));
        server = spawn('php', ['-d', 'opcache.enable=0', '-d', 'display_errors=0', '-d', `sys_temp_dir=${tmp}`,
            '-S', `127.0.0.1:${port}`, '-t', tmp], {cwd: web, stdio: ['ignore', 'ignore', 'pipe']});
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

    beforeEach(() => {
        fs.rmSync(path.join(uploads, 'metadata'), {recursive: true, force: true});
    });

    async function request(endpoint, {method = 'GET', headers = {}, body} = {}) {
        if (body) {
            body = JSON.stringify(body);
            headers = {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers};
        }
        const response = await new Promise((resolve, reject) => {
            const req = http.request({hostname: '127.0.0.1', port, path: `/sitrecServer/${endpoint}`, method, headers}, res => {
                let text = '';
                res.on('data', chunk => { text += chunk; });
                res.on('end', () => resolve({status: res.statusCode, text, headers: res.headers}));
            });
            req.on('error', reject);
            req.end(body);
        });
        let json = null;
        try { json = JSON.parse(response.text); } catch (error) { /* not JSON: the caller reads .text */ }
        return {...response, json};
    }

    const changeTemplates = (change, headers = ADMIN) =>
        request('metadata.php', {method: 'POST', headers, body: {updateTemplates: true, ...change}});
    const templateNames = async (headers = ANONYMOUS) =>
        (await request('metadata.php?templates=1', {headers})).json.sitches.map(entry => entry.name);
    const storedList = list => JSON.parse(fs.readFileSync(path.join(uploads, 'metadata', list + '.json'), 'utf8'));

    test('the list is empty before an administrator adds a template, and needs no login', async () => {
        const result = await request('metadata.php?templates=1', {headers: ANONYMOUS});
        expect(result.status).toBe(200);
        expect(result.json).toEqual({sitches: []});
    });

    test('an administrator adds templates, and each user reads them in the order of addition', async () => {
        expect((await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}]})).status).toBe(200);
        expect((await changeTemplates({add: [{name: 'Starlink Flares', userID: OWNER}]})).status).toBe(200);

        for (const headers of [ANONYMOUS, USER, ADMIN]) {
            expect(await templateNames(headers)).toEqual(['Video Analysis', 'Starlink Flares']);
        }
        const [first] = (await request('metadata.php?templates=1', {headers: ANONYMOUS})).json.sitches;
        expect(first).toMatchObject({name: 'Video Analysis', userID: OWNER});
        // The entry gets the date and the screenshot of the saved sitch, from storage.
        expect(first.date).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
        expect(first.screenshotUrl).toBe(`https://example.test/uploads/${OWNER}/Video Analysis/screenshot_20261111_120000_abc123.jpg`);
    });

    test('an addition does not replace the list, and a second addition of an entry changes nothing', async () => {
        await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}]});
        await changeTemplates({add: [{name: 'Starlink Flares', userID: OWNER}, {name: 'Video Analysis', userID: OWNER}]});
        expect(await templateNames()).toEqual(['Video Analysis', 'Starlink Flares']);
    });

    test('an administrator removes one template and the others stay', async () => {
        await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}, {name: 'Starlink Flares', userID: OWNER}]});
        await changeTemplates({remove: [{name: 'Video Analysis', userID: OWNER}]});
        expect(await templateNames()).toEqual(['Starlink Flares']);
    });

    test('a user who is not an administrator cannot change the list', async () => {
        await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}]});
        const refused = await changeTemplates({add: [{name: 'Mine', userID: 42}], remove: [{name: 'Video Analysis', userID: OWNER}]}, USER);
        expect(refused.status).toBe(403);
        expect((await changeTemplates({add: [{name: 'Mine', userID: 42}]}, ANONYMOUS)).status).toBe(401);
        expect(await templateNames()).toEqual(['Video Analysis']);
    });

    test('an entry with a path in its name, or with no owner, is not stored', async () => {
        await changeTemplates({add: [{name: '..', userID: OWNER}, {name: 'No Owner'}, {name: 'Zero Owner', userID: 0},
            {name: 'Video Analysis', userID: OWNER}]});
        expect(await templateNames()).toEqual(['Video Analysis']);
    });

    test('the template list and the featured list are separate files', async () => {
        await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}]});
        await request('metadata.php', {method: 'POST', headers: ADMIN,
            body: {updateFeatured: true, sitches: [{name: 'Starlink Flares', userID: OWNER}]}});

        expect(storedList('templates').sitches.map(entry => entry.name)).toEqual(['Video Analysis']);
        expect(storedList('featured').sitches.map(entry => entry.name)).toEqual(['Starlink Flares']);
        const featured = (await request('metadata.php?featured=1', {headers: ANONYMOUS})).json.sitches;
        expect(featured.map(entry => entry.name)).toEqual(['Starlink Flares']);
    });

    test('a save of a template (a screenshot bump by its owner) updates its entry', async () => {
        await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}]});
        fs.writeFileSync(path.join(uploads, String(OWNER), 'Video Analysis', 'screenshot_20261111_130000_def456.jpg'), 'jpeg');

        const bump = await request('metadata.php', {method: 'POST', headers: ADMIN, body: {bumpScreenshotVersions: ['Video Analysis']}});
        expect(bump.status).toBe(200);

        const [entry] = (await request('metadata.php?templates=1', {headers: ANONYMOUS})).json.sitches;
        expect(entry.screenshotUrl).toBe(`https://example.test/uploads/${OWNER}/Video Analysis/screenshot_20261111_130000_def456.jpg?v=1`);
    });

    test('each user can list the versions of a global template, and of no other sitch of its owner', async () => {
        await changeTemplates({add: [{name: 'Video Analysis', userID: OWNER}]});
        const versions = sitchName => `getsitches.php?get=versions&userid=${OWNER}&name=${encodeURIComponent(sitchName)}`;

        for (const headers of [ANONYMOUS, USER]) {
            const published = await request(versions('Video Analysis'), {headers});
            expect(published.status).toBe(200);
            expect(published.json.map(version => version.version)).toEqual(['20261111_120000.js']);
        }

        // Not on a published list. A caller with no login gets nothing.
        expect((await request(versions('Not Published'), {headers: ANONYMOUS})).json).toEqual([]);
        // A different user gets the listing of that name in the user's own folder, which has none.
        const otherUser = await request(versions('Not Published'), {headers: USER});
        expect(otherUser.text).not.toContain('20261111_120000.js');

        // Removed from the list: the versions are private again.
        await changeTemplates({remove: [{name: 'Video Analysis', userID: OWNER}]});
        expect((await request(versions('Video Analysis'), {headers: ANONYMOUS})).json).toEqual([]);
    });
});
