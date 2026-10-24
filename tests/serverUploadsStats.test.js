const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const {spawn, spawnSync} = require('child_process');

// Three server-side problems with where user files and visitor records end up:
//
// - rehost.php stored any name that was not a server script, so a logged-in user could upload
//   x.html or x.svg to sitrec-upload/, where it ran script on the app's origin for anyone who
//   opened the link. HTML is still accepted, because Sitrec imports soundings as HTML and
//   rehosts them when a sitch is saved, but it is stored as .txt.
// - A versioned save went into a folder named without the part after the last dot, while the
//   returned URL, the S3 key and delete used the whole name, so "Mt. Shasta" was saved under
//   "Mt/" and its link was a 404.
// - Visit records and UI click logs, which hold user ids and IP addresses, were written under
//   sitrec-cache/ and sitrec-upload/, which the web server publishes.
//
// The endpoints run under PHP's built-in server with stub configuration; the stats helpers
// run with php -r. Those blocks skip when php is not installed. The last block checks the
// container's Apache rule that serves uploads with a sandbox CSP.

const SERVER = path.resolve(__dirname, '../sitrecServer');
const phpAvailable = spawnSync('php', ['-v'], {encoding: 'utf8'}).status === 0;
const today = () => new Date().toISOString().slice(0, 10);

// A fixture site: copies of the real scripts beside stub configuration, served by `php -S`.
function makeSite(prefix, scripts, configPhp) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const web = path.join(root, 'sitrecServer');
    for (const dir of ['sitrecServer', 'uploads', 'cache', 'tmp']) fs.mkdirSync(path.join(root, dir));
    for (const name of ['user.php', 'audit.php', ...scripts]) {
        fs.copyFileSync(path.join(SERVER, name), path.join(web, name));
    }
    fs.writeFileSync(path.join(web, 'config.php'), configPhp);
    fs.writeFileSync(path.join(web, 'config_paths.php'), `<?php
$APP_PATH = dirname(__DIR__) . '/';
$UPLOAD_PATH = $APP_PATH . 'uploads/';
$CACHE_PATH = $APP_PATH . 'cache/';
$UPLOAD_URL = 'https://example.test/uploads/';
`);
    // Storage that records nothing: the S3 paths' results are the keys rehost.php chose.
    fs.writeFileSync(path.join(web, 's3_client.php'), `<?php
function s3ObjectUrl($bucket, $key) { return 'https://example.test/' . $key; }
function getS3Client() {
    return new class {
        function getCommand($operation, $params) { return $params; }
        function createPresignedRequest($command, $expiry) {
            return new class { function getUri() { return 'https://storage.test/signed'; } };
        }
        function createMultipartUpload($params) { return ['UploadId' => 'upload-1']; }
        function listMultipartUploads($params) {
            return ['Uploads' => [['UploadId' => 'upload-1', 'Key' => '42/stored.txt']]];
        }
        function completeMultipartUpload($params) { return ['ETag' => 'etag-1']; }
        function upload(...$args) { return []; }
    };
}
`);
    return root;
}

async function startServer(root, env = {}) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const tmp = path.join(root, 'tmp');
    const server = spawn('php', ['-d', 'opcache.enable=0', '-d', 'display_errors=0', '-d', 'date.timezone=UTC',
        '-d', `sys_temp_dir=${tmp}`, '-d', `session.save_path=${tmp}`, '-S', `127.0.0.1:${port}`, '-t', root],
    {cwd: path.join(root, 'sitrecServer'), env: {...process.env, AUDIT_LOG_ENABLED: 'false', ...env},
        stdio: ['ignore', 'ignore', 'pipe']});
    await new Promise((resolve, reject) => {
        let output = '';
        server.stderr.on('data', chunk => { output += chunk; if (output.includes('started')) resolve(); });
        server.once('error', reject);
        server.once('exit', code => reject(new Error(`PHP server exited ${code}: ${output}`)));
    });
    return {server, port};
}

async function stopServer(server) {
    if (server && server.exitCode === null) {
        const done = new Promise(resolve => server.once('exit', resolve));
        server.kill();
        await done;
    }
}

function request(port, endpoint, {method = 'GET', headers = {}, body} = {}) {
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
        const req = http.request({hostname: '127.0.0.1', port, path: `/sitrecServer/${endpoint}`, method, headers}, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({status: res.statusCode, text}));
        });
        req.on('error', reject);
        req.end(body);
    });
}

(phpAvailable ? describe : describe.skip)('rehost.php upload names', () => {
    let root, uploads, server, port;

    beforeAll(async () => {
        root = makeSite('sitrec-rehost-names-', ['rehost.php', 'object_helpers.php'], `<?php
$useAWS = isset($_SERVER['HTTP_X_TEST_S3']);
$s3creds = ['bucket' => 'example-bucket'];
function getUserInfoCustom() { return ['user_id' => 42, 'user_groups' => [2]]; }
`);
        uploads = path.join(root, 'uploads');
        ({server, port} = await startServer(root));
    });

    afterAll(async () => {
        await stopServer(server);
        if (root) fs.rmSync(root, {recursive: true, force: true});
    });

    function upload(filename, content, version, headers = {}) {
        const boundary = 'UploadNamesBoundary';
        const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
        const body = field('filename', filename) + (version ? field('version', version) : '')
            + `--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="blob"\r\n`
            + `Content-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`;
        return request(port, 'rehost.php', {method: 'POST',
            headers: {'Content-Type': `multipart/form-data; boundary=${boundary}`, ...headers}, body});
    }

    const s3Action = (action, data) => request(port, `rehost.php?action=${action}`, {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Test-S3': '1'}, body: JSON.stringify(data)})
        .then(result => ({status: result.status, ...JSON.parse(result.text)}));

    // The name SondeFetch.js gives a University of Wyoming sounding, which is HTML.
    const SOUNDING = 'sounding_72451_2026-10-20_12Z.html';
    const SOUNDING_PAGE = '<HTML><TITLE>University of Wyoming</TITLE><PRE>PRES   HGHT   TEMP</PRE></HTML>';

    const remove = (filename, version) => request(port, 'rehost.php', {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: `delete=true&filename=${encodeURIComponent(filename)}` + (version ? `&version=${encodeURIComponent(version)}` : '')});

    // The path on disk that a returned upload URL points at.
    const fileForUrl = url => path.join(uploads, decodeURI(url.replace('https://example.test/uploads/', '')));

    const listUploads = () => (fs.existsSync(path.join(uploads, '42'))
        ? fs.readdirSync(path.join(uploads, '42'), {recursive: true}).sort() : []);

    test.each([
        ['x.xhtml', undefined],
        ['x.svg', undefined],
        ['x.xsl', undefined],
        ['x.mjs', undefined],
        // Apache takes the type from an inner extension when the last one has none.
        ['x.html.klv', undefined],
        // Only an unversioned upload's last extension is renamed to .txt.
        ['x.html.html', undefined],
        // A trailing space or comma hides the extension from Apache's type map, not the browser.
        ['x.html ', undefined],
        ['x.svg,', undefined],
        ['x.html .klv', undefined],
        ['My Sitch', 'v.html'],
        ['My Sitch', 'v.svg '],
        ['My Sitch', 'v.svg.dat'],
    ])('refuses %s (version %s), which a browser would run as a page', async (filename, version) => {
        const result = await upload(filename, '<script>alert(document.domain)</script>', version);
        expect(result.status).toBe(400);
        expect(result.text).toContain('Invalid filename, version, or file type');
        expect(listUploads()).toEqual([]);
    });

    test.each(['track.kml', 'clip.mp4', 'data.csv', 'stream.ts', 'image.NTF', 'soundings.xml', 'sats.tle', 'Custom.js'])(
        'still stores %s, a type Sitrec imports', async filename => {
            const result = await upload(filename, 'data');
            expect(result.status).toBe(200);
            const stored = fileForUrl(result.text);
            expect(fs.readFileSync(stored, 'utf8')).toBe('data');
            fs.rmSync(stored);
        });

    test.each([SOUNDING, 'sonde_WIND_72451_2026-10-20_12Z.HTM'])(
        'stores the HTML sounding %s as .txt, so a saved sitch keeps it', async filename => {
            const result = await upload(filename, SOUNDING_PAGE);
            expect(result.status).toBe(200);
            const base = filename.replace(/\.html?$/i, '');
            expect(result.text).toMatch(new RegExp(`^https://example\\.test/uploads/42/${base}-[0-9a-f]{32}\\.txt$`));
            const stored = fileForUrl(result.text);
            expect(fs.readFileSync(stored, 'utf8')).toBe(SOUNDING_PAGE);
            expect(listUploads()).toEqual([path.basename(stored)]);
            fs.rmSync(stored);
        });

    test('the S3 paths store an HTML sounding as .txt and refuse the same page types', async () => {
        const stored = /^sitrec:\/\/42\/sounding_72451_2026-10-20_12Z-[0-9a-f]+\.txt$/;
        expect((await s3Action('getPresignedUrl', {filename: SOUNDING})).objectRef).toMatch(stored);
        expect((await s3Action('initiateMultipart', {filename: SOUNDING, parts: 1})).objectRef).toMatch(stored);
        // Completion takes the key from the upload id; the HTML name must only not be refused.
        const completed = await s3Action('completeMultipart',
            {filename: SOUNDING, uploadId: 'upload-1', parts: [{PartNumber: 1, ETag: 'part-1'}]});
        expect(completed).toMatchObject({status: 200, objectRef: 'sitrec://42/stored.txt'});
        const posted = await upload(SOUNDING, SOUNDING_PAGE, undefined, {'X-Test-S3': '1'});
        expect(posted.text).toMatch(/^https:\/\/example\.test\/42\/sounding_72451_2026-10-20_12Z-[0-9a-f]{32}\.txt$/);

        for (const action of ['getPresignedUrl', 'initiateMultipart']) {
            for (const filename of ['x.svg', 'x.html.klv']) {
                const refused = await s3Action(action, {filename, parts: 1});
                expect(refused).toEqual({status: 400, error: 'Invalid filename, version, or file type'});
            }
        }
        expect(listUploads()).toEqual([]);
    });

    test('a versioned save of a dotted sitch name is stored where its URL points', async () => {
        const shasta = await upload('Mt. Shasta', 'shasta', '20261024_120000.js');
        expect(shasta.status).toBe(200);
        expect(shasta.text).toBe('https://example.test/uploads/42/Mt. Shasta/20261024_120000.js');
        expect(fs.readFileSync(fileForUrl(shasta.text), 'utf8')).toBe('shasta');

        // Sitches whose names share the text before the last dot no longer share a folder.
        const rainier = await upload('Mt. Rainier', 'rainier', '20261024_120001.js');
        expect(fs.readFileSync(fileForUrl(rainier.text), 'utf8')).toBe('rainier');
        expect(fs.readdirSync(path.join(uploads, '42')).sort()).toEqual(['Mt. Rainier', 'Mt. Shasta']);

        // Delete finds the folder the save wrote.
        expect((await remove('Mt. Shasta', '20261024_120000.js')).status).toBe(200);
        expect(fs.existsSync(fileForUrl(shasta.text))).toBe(false);
        expect((await remove('Mt. Rainier')).status).toBe(200);
        expect(fs.existsSync(path.join(uploads, '42/Mt. Rainier'))).toBe(false);
    });
});

(phpAvailable ? describe : describe.skip)('visit statistics are kept out of the web root', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-stats-private-'));
        for (const dir of ['sitrecServer', 'cache', 'tmp']) fs.mkdirSync(path.join(root, dir));
        fs.copyFileSync(path.join(SERVER, 'stats_history.php'), path.join(root, 'sitrecServer/stats_history.php'));
        fs.writeFileSync(path.join(root, 'sitrecServer/config_paths.php'),
            `<?php $CACHE_PATH = ${JSON.stringify(path.join(root, 'cache') + '/')};\n`);
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    const privateDir = () => path.join(root, 'tmp/sitrec-stats');
    const legacyDir = () => path.join(root, 'cache/sitrec-stats');

    function runPhp(code) {
        const result = spawnSync('php', ['-d', 'date.timezone=UTC', '-d', 'display_errors=stderr', '-r',
            `require $argv[1]; ${code}`, path.join(root, 'sitrecServer/stats_history.php')],
        {encoding: 'utf8', timeout: 10000, env: {...process.env, TMPDIR: path.join(root, 'tmp')}});
        expect(result.stderr).toBe('');
        return result.stdout;
    }

    test('a visit is recorded in the private temp directory, not in sitrec-cache', () => {
        runPhp('recordVisit(42, "203.0.113.7", "gimbal");');

        expect(fs.readdirSync(path.join(root, 'cache'))).toEqual([]);
        const visits = JSON.parse(fs.readFileSync(path.join(privateDir(), `visits_${today()}.json`), 'utf8'));
        expect(visits.entries.map(e => [e.user_id, e.ip, e.sitch])).toEqual([[42, '203.0.113.7', 'gimbal']]);
        expect(JSON.parse(runPhp('echo json_encode(getVisitDetails(date("Y-m-d")));')).ips).toEqual({'203.0.113.7': 1});
    });

    test('files an earlier version wrote under sitrec-cache are moved out on first use', () => {
        fs.mkdirSync(legacyDir());
        fs.writeFileSync(path.join(legacyDir(), 'history.json'), JSON.stringify({[today()]: {ai_requests: 3}}));
        fs.writeFileSync(path.join(legacyDir(), `visits_${today()}.json`),
            JSON.stringify({entries: [{user_id: 7, ip: '198.51.100.1', time: 0, sitch: null}], users: {7: 1}, ips: {'198.51.100.1': 1}}));

        const history = JSON.parse(runPhp('echo json_encode(getStatsHistory28());'));

        expect(history[today()]).toEqual({ai_requests: 3});
        expect(fs.existsSync(legacyDir())).toBe(false);
        expect(fs.readdirSync(privateDir()).sort()).toEqual(['history.json', `visits_${today()}.json`]);
        expect(JSON.parse(runPhp('echo json_encode(getVisitDetails(date("Y-m-d")));')).users).toEqual({7: 1});
    });

    test('a file already in the private directory is not replaced by an old copy', () => {
        fs.mkdirSync(legacyDir());
        fs.mkdirSync(privateDir());
        fs.writeFileSync(path.join(legacyDir(), 'history.json'), JSON.stringify({[today()]: {visits: 1}}));
        fs.writeFileSync(path.join(privateDir(), 'history.json'), JSON.stringify({[today()]: {visits: 9}}));

        expect(JSON.parse(runPhp('echo json_encode(getStatsHistory28());'))[today()]).toEqual({visits: 9});
        expect(fs.existsSync(legacyDir())).toBe(false);
    });
});

(phpAvailable ? describe : describe.skip)('UI click logs are kept out of the web root', () => {
    let root, server, port;

    beforeAll(async () => {
        root = makeSite('sitrec-uilog-private-', ['uilog.php', 'stats_history.php', 'admin_dashboard.php',
            'ai_log.php', 'ai_models.php'], `<?php
$useAWS = false;
$s3creds = [];
function getUserInfoCustom() {
    return ['user_id' => (int)($_SERVER['HTTP_X_TEST_USER'] ?? 42), 'user_groups' => [3]];
}
`);
        // A log an earlier version wrote under sitrec-upload/.
        fs.mkdirSync(path.join(root, 'uploads/ui-stats'));
        fs.writeFileSync(path.join(root, 'uploads/ui-stats/ui-2026-10-20.jsonl'),
            JSON.stringify({ts: 1, user_id: 7, ip: '198.51.100.1', path: 'View/Old Item'}) + '\n');
        ({server, port} = await startServer(root, {LOG_UI_INTERACTIONS: 'true'}));
    });

    afterAll(async () => {
        await stopServer(server);
        if (root) fs.rmSync(root, {recursive: true, force: true});
    });

    test('uilog.php writes to the private directory and moves the old log there', async () => {
        const result = await request(port, 'uilog.php', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({events: [{ts: 2, path: 'Camera/New Item'}]})});
        expect(JSON.parse(result.text)).toEqual({success: true, logged: 1});

        const privateDir = path.join(root, 'tmp/sitrec-ui-stats');
        const record = JSON.parse(fs.readFileSync(path.join(privateDir, `ui-${today()}.jsonl`), 'utf8'));
        expect(record).toMatchObject({user_id: 42, ip: '127.0.0.1', path: 'Camera/New Item'});
        expect(fs.existsSync(path.join(privateDir, 'ui-2026-10-20.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'uploads/ui-stats'))).toBe(false);
    });

    test('the admin dashboard reads the clicks from the private directory', async () => {
        const result = await request(port, 'admin_dashboard.php?expand=menu');
        expect(result.status).toBe(200);
        expect(result.text).toContain('Camera/New Item');
        expect(result.text).toContain('View/Old Item');
    });
});

describe('the container serves uploads and cached files sandboxed', () => {
    const conf = fs.readFileSync(path.resolve(__dirname, '../docker/cache-headers.conf'), 'utf8');
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile.release'), 'utf8');
    const block = conf.match(/<If "%\{REQUEST_FILENAME\} =~ m#([^#]+)#">\s*(Header[^\n]*Content-Security-Policy[^\n]*)\s*<\/If>/);

    test('a path rule sets a sandbox CSP', () => {
        expect(block).not.toBeNull();
        expect(block[2]).toMatch(/^Header always set Content-Security-Policy "[^"]*\bsandbox\b[^"]*"$/);
        expect(block[2]).toContain("default-src 'none'");
    });

    test.each([
        ['sitrec-upload/42/x-0123.klv', true],
        ['sitrec-upload/42/My Sitch/20261024_120000.js', true],
        ['sitrec-cache/starlink/current.json', true],
        ['index.html', false],
        ['sitrecServer/rehost.php', false],
        ['bootstrap.beacfc8a97c4825cb3dd.bundle.js', false],
    ])('%s sandboxed: %s', (file, sandboxed) => {
        expect(new RegExp(block[1]).test('/var/www/html/' + file)).toBe(sandboxed);
    });

    test('the release image enables the conf and mod_headers', () => {
        expect(dockerfile).toMatch(/COPY\s+docker\/cache-headers\.conf\s+\/etc\/apache2\/conf-available\//);
        expect(dockerfile).toMatch(/a2enconf\s+sitrec-cache-headers/);
        expect(dockerfile).toMatch(/a2enmod\s+headers/);
    });
});
