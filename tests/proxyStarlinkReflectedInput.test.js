const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// proxyStarlink.php used to put the raw ?request= value into its "Invalid request key"
// message, sent with PHP's default text/html Content-Type, so a crafted link could run a
// script on the site's origin.
const phpResult = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'});
const php = phpResult.status === 0 ? phpResult.stdout : null;
const phpCgi = spawnSync('php-cgi', ['-v'], {encoding: 'utf8'}).status === 0 ? 'php-cgi' : null;

const PAYLOAD = '<i>t</i>';

(php ? describe : describe.skip)('proxyStarlink.php reflected input', () => {
    let root;
    let script;
    let env;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-starlink-'));
        for (const dir of ['sitrecServer', 'cache', 'tmp']) {
            fs.mkdirSync(path.join(root, dir));
        }
        script = path.join(root, 'sitrecServer/proxyStarlink.php');
        fs.copyFileSync(path.join(__dirname, '../sitrecServer/proxyStarlink.php'), script);
        // Stubs: the request check must be reached without configuration or network access.
        fs.writeFileSync(path.join(root, 'sitrecServer/config.php'), '<?php\n');
        fs.writeFileSync(path.join(root, 'sitrecServer/config_paths.php'),
            `<?php $CACHE_PATH = ${JSON.stringify(path.join(root, 'cache') + '/')};\n`);
        fs.writeFileSync(path.join(root, 'sitrecServer/curlGetRequest.php'), '<?php\n');
        fs.writeFileSync(path.join(root, 'sitrecServer/gpData.php'), '<?php\n');
        // sys_get_temp_dir() follows TMPDIR, which keeps the rate-limit files in the fixture.
        env = {...process.env, TMPDIR: path.join(root, 'tmp')};
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    test('escapes an invalid request key instead of echoing it as markup', () => {
        const result = spawnSync(php, ['-r', '$_GET = ["request" => $argv[2]]; require $argv[1];',
            script, PAYLOAD], {encoding: 'utf8', timeout: 10000, env});
        expect(result.stdout).toBe('Invalid request key &lt;i&gt;t&lt;/i&gt;');
    });

    (phpCgi ? test : test.skip)('sends the message as text/plain, not text/html', () => {
        const result = spawnSync(phpCgi, [], {
            encoding: 'utf8', timeout: 10000,
            env: {...env, REDIRECT_STATUS: '1', REQUEST_METHOD: 'GET', SCRIPT_FILENAME: script,
                QUERY_STRING: 'request=' + encodeURIComponent(PAYLOAD)},
        });
        const [head, body] = result.stdout.split(/\r?\n\r?\n/);
        expect(head).toMatch(/^Content-type: text\/plain; charset=UTF-8$/mi);
        expect(body).toBe('Invalid request key &lt;i&gt;t&lt;/i&gt;');
    });
});
