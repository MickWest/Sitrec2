const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const runner = pathToFileURL(path.resolve(__dirname, '../scripts/quickship.mjs')).href;
const call = code => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {checkScope,snapshot,copyFrontend} from ${JSON.stringify(runner)}; ${code}`], {encoding: 'utf8'});
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quickship-test-')); });
afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

test('Beta scope permits display changes and refuses runtime, auth, dependency and backend changes', () => {
    expect(call(`checkScope(['src/CUIBar.js','src/nodes/CNodeDisplayTrack.js','tests/display.test.js']);`).status).toBe(0);
    for (const name of ['sitrecServer/channels.php', 'src/release/bootstrap.js', 'src/SettingsManager.js',
        'src/SitchProvenance.js', 'src/configUtils.js', 'package-lock.json', 'docker/entrypoint.sh']) {
        expect(call(`checkScope([${JSON.stringify(name)}]);`).status).not.toBe(0);
    }
});

test('static packaging includes decoders and loose workers but never backend or private configuration', () => {
    const source = path.join(directory, 'dist'); const target = path.join(directory, 'frontend');
    const names = ['index.html','app-entry.json','build-info.json','index.abc.bundle.js',
        'libs/openjpeg/decoder.wasm','src/workers/Decode.js','data/model.glb',
        'sitrecServer/config.php','private/note.md','config.json','shared.env.js','.env'];
    for (const name of names) {
        const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');
    }
    const result=call(`console.log(JSON.stringify(copyFrontend(${JSON.stringify(source)},${JSON.stringify(target)})));`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).sort()).toEqual(names.slice(0,7).sort());
});

test('a frozen source captures explicit new files without private files or configuration values', () => {
    const source=path.join(directory,'source');fs.mkdirSync(source);
    const names=['src/a.js','src/new.js','private/note.md','config/shared.env','config/shared.env.example'];
    for (const name of names) {
        const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');
    }
    expect(spawnSync('git',['init','--quiet',source]).status).toBe(0);
    expect(spawnSync('git',['add','src/a.js','config/shared.env.example'],{cwd:source}).status).toBe(0);
    const result=call(`console.log(JSON.stringify(snapshot(${JSON.stringify(path.join(directory,'snapshot'))},
        ['src/new.js','private/note.md','config/shared.env'],${JSON.stringify(source)})));`);
    expect(result.status).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout).files).sort()).toEqual(['config/shared.env.example','src/a.js','src/new.js']);
});
