const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const phpAvailable = spawnSync('php', ['-v']).status === 0;
const keys = [
    '42/Public Sitch/20260901_120000_aaaaaaaa.js',
    '42/Public Sitch/20260902_120000_bbbbbbbb.js',
    '42/Public Sitch/20260903_120000_private.js',
    '42/Public Sitch/nested/20990101_120000_other.js',
    '42/Public Sitch/screenshot.jpg',
    '42/Private/20260902_120000_cccccccc.js',
];

(phpAvailable ? describe : describe.skip)('object folder visibility', () => {
    let tmp;
    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-folder-access-'));
        for (const name of ['object.php', 'object_helpers.php', 'requestScheme.php', 'user.php', 'audit.php']) {
            fs.copyFileSync(path.join(__dirname, '../sitrecServer', name), path.join(tmp, name));
        }
        for (const key of keys) {
            const file = path.join(tmp, 'uploads', key);
            fs.mkdirSync(path.dirname(file), {recursive: true});
            fs.writeFileSync(file, '{}');
        }
        fs.writeFileSync(path.join(tmp, 'config.php'), `<?php
$useAWS = getenv('TEST_STORAGE') === 's3';
$s3creds = ['bucket'=>'example-bucket', 'region'=>'example-region'];
function getUserInfoCustom() {
    if (getenv('TEST_IDENTITY_ERROR')) throw new RuntimeException('Identity unavailable');
    return ['user_id'=>(int)getenv('TEST_CALLER'),
        'user_groups'=>getenv('TEST_ADMIN') ? [3] : [2]];
}
`);
        fs.writeFileSync(path.join(tmp, 'config_paths.php'), `<?php
$UPLOAD_PATH = __DIR__ . '/uploads/';
$APP_URL = 'https://app.example.test/';
$UPLOAD_URL = $APP_URL . 'uploads/';
`);
        fs.writeFileSync(path.join(tmp, 's3_client.php'), `<?php
function s3HasCredentials() { return $GLOBALS['useAWS']; }
function s3ConfiguredEndpointHost() { return ''; }
function s3ObjectUrl($bucket, $key) { return 'https://objects.example.test/' . encodeObjectKeyForUrl($key); }
function getS3Client() {
    return new class {
        function getIterator($op, $params) {
            return array_map(fn($key)=>['Key'=>$key], json_decode(getenv('TEST_KEYS'), true));
        }
        function getCommand($op, $params) { return $params; }
        function createPresignedRequest($command, $expiry) {
            return new class($command['Key']) {
                function __construct(private $key) {}
                function getUri() { return 'https://objects.example.test/' . encodeObjectKeyForUrl($this->key) . '?signed=example'; }
            };
        }
    };
}
`);
    });
    afterAll(() => { if (tmp) fs.rmSync(tmp, {recursive: true, force: true}); });

    function resolve(storage, ref, settings = {}) {
        const result = spawnSync('php', ['-r', `
$_SERVER['REQUEST_METHOD']='GET';
$_SERVER['HTTP_HOST']='app.example.test';
$_SERVER['REQUEST_SCHEME']='https';
$_GET=['ref'=>getenv('TEST_REF')];
register_shutdown_function(function() { fwrite(STDERR, 'STATUS=' . (http_response_code() ?: 200)); });
require ${JSON.stringify(path.join(tmp, 'object.php'))};
`], {encoding: 'utf8', env: {...process.env,
            AUDIT_LOG_ENABLED: 'false', AUTH_MODE: 'forum', TEST_STORAGE: storage,
            TEST_REF: ref, TEST_KEYS: JSON.stringify(keys), TEST_CALLER: '0',
            TEST_ADMIN: '', TEST_IDENTITY_ERROR: '', S3_DEFAULT_VISIBILITY: 'public',
            S3_PRIVATE_PREFIXES: '', S3_PUBLIC_PREFIXES: '', S3_READS_VIA_SERVER: '',
            S3_PUBLIC_BASE_URL: '', ...settings}});
        expect(result.status).toBe(0);
        expect(result.stderr).not.toMatch(/Warning|Fatal error/);
        return {status: Number(/STATUS=(\d+)/.exec(result.stderr)[1]), body: JSON.parse(result.stdout)};
    }

    describe.each(['local', 's3'])('%s storage', storage => {
        test.each(['0', '73'])('public latest links work for caller %s', caller => {
            const result = resolve(storage, 'sitrec://42/Public Sitch/', {TEST_CALLER: caller});
            expect(result.status).toBe(200);
            expect(result.body.key).toBe(keys[2]);
        });
        test.each(['0', '73'])('private folders refuse caller %s', caller => {
            const result = resolve(storage, '42/Private/', {TEST_CALLER: caller,
                S3_PRIVATE_PREFIXES: '42/Private/'});
            expect(result.status).toBe(403);
            expect(result.body).not.toHaveProperty('key');
        });
        test.each([{TEST_CALLER: '42'}, {TEST_CALLER: '7', TEST_ADMIN: '1'}])('owner/admin can resolve a private folder: %o', identity => {
            const result = resolve(storage, '42/Private/', {...identity, S3_DEFAULT_VISIBILITY: 'private'});
            expect(result.status).toBe(200);
            expect(result.body.key).toBe(keys[5]);
        });
        test('private defaults allow only explicitly public folders', () => {
            const settings = {S3_DEFAULT_VISIBILITY: 'private', S3_PUBLIC_PREFIXES: '42/Public Sitch/'};
            expect(resolve(storage, '42/Public Sitch/', settings).body.key).toBe(keys[2]);
            expect(resolve(storage, '42/Private/', settings).status).toBe(403);
        });
        test('a public folder never reveals its private child to another reader', () => {
            const settings = {S3_PRIVATE_PREFIXES: keys[2]};
            expect(resolve(storage, '42/Public Sitch/', settings).body.key).toBe(keys[1]);
            expect(resolve(storage, '42/Public Sitch/', {...settings, TEST_CALLER: '42'}).body.key).toBe(keys[2]);
        });
        test('a folder with no visible versions returns no private key', () => {
            const result = resolve(storage, '42/Public Sitch/', {S3_PRIVATE_PREFIXES: keys.slice(0,3).join(',')});
            expect(result.status).toBe(404);
            expect(result.body).not.toHaveProperty('key');
        });
        test('exact shared versions keep working without identity lookup', () => {
            const result = resolve(storage, keys[5], {S3_DEFAULT_VISIBILITY: 'private', TEST_IDENTITY_ERROR: '1'});
            expect(result.status).toBe(200);
            expect(result.body.key).toBe(keys[5]);
        });
        test.each(['42/../Private/', 'sitrec://42/Public Sitch/../', 'invalid/Folder/'])('rejects malformed reference %s', ref => {
            expect(resolve(storage, ref).status).toBe(400);
        });
    });
});
