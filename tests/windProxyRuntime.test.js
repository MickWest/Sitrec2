const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const phpResult = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'});
const php = phpResult.status === 0 ? phpResult.stdout : null;

(php ? describe : describe.skip)('wind proxy Python selection', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-wind-runtime-'));
        for (const dir of ['sitrecServer', 'tools', 'home/.pyenv/shims', 'parent-bin']) {
            fs.mkdirSync(path.join(root, dir), {recursive: true});
        }
        fs.copyFileSync(path.join(__dirname, '../sitrecServer/windProxy.php'),
            path.join(root, 'sitrecServer/windProxy.php'));
        fs.writeFileSync(path.join(root, 'tools/fetch_wind.py'), '# fixture\n');
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    test('uses the configured Python even when PHP itself sees a different executable', () => {
        // A decoy on the parent's PATH reproduces proc_open's executable lookup.
        const wrong = path.join(root, 'parent-bin/python3');
        fs.writeFileSync(wrong, '#!/bin/sh\necho WRONG_INTERPRETER\nexit 1\n', {mode: 0o755});
        const selected = path.join(root, 'home/.pyenv/shims/python3');
        fs.writeFileSync(selected, '#!/bin/sh\n' +
            'test "$2" = --date || exit 2\n' +
            'test "$4" = --hour || exit 3\n' +
            'test "$6" = --level || exit 4\n' +
            'test "$8" = --output || exit 5\n' +
            'printf \'{"source":"fixture","u":[1],"v":[2]}\' > "$9/wind_20250919_18z_10m.json"\n',
        {mode: 0o755});
        const result = spawnSync(php, ['-d', 'disable_functions=shell_exec,exec,system,passthru', '-r',
            '$_GET=["date"=>"20250919","hour"=>18,"level"=>"surface"]; require $argv[1];',
            path.join(root, 'sitrecServer/windProxy.php')], {
            encoding: 'utf8', timeout: 10000,
            env: {...process.env, HOME: path.join(root, 'home'), PATH: path.join(root, 'parent-bin')},
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({source: 'fixture', u: [1], v: [2]});
    });
});
