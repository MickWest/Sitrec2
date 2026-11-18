const {spawnSync} = require('child_process');
const path = require('path');

const hasPython = spawnSync('python3', ['--version']).status === 0;

(hasPython ? test : test.skip)('GFS historical archive downloads and cycle routing', () => {
    const result = spawnSync('python3', ['-B', path.join(__dirname, 'fetchWindArchive.py')], {
        encoding: 'utf8', timeout: 10000,
    });
    if (result.status !== 0) throw new Error(result.stderr + result.stdout);
});
