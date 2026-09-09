#!/usr/bin/env node
// Local artifact preparation and timed gates. Host promotion lives in the
// deployment adapter; this tool never commits, tags, pushes or replaces Shipped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const excluded = name => name === 'AGENTS.md' || name === 'CLAUDE.md' ||
    name.startsWith('private/') || /^\.(?:agents|claude|codex)(?:\/|$)/.test(name) ||
    name.split('/').some(p => p === '.git' || p === 'node_modules') ||
    (name.startsWith('config/') && !name.endsWith('.example') && !name.endsWith('.example.js')) ||
    /(?:^|\/)(?:\.env|shared\.env|credentials)(?:\.|$)/.test(name) && !name.endsWith('.example');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {cwd: ROOT, encoding: 'utf8', ...options});
    if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.error || '').toString().slice(-1500)}`);
    return result.stdout;
}

export function snapshot(destination, extraFiles = [], root = ROOT) {
    const tracked = run('git', ['ls-files', '-z'], {cwd: root}).split('\0').filter(Boolean);
    const names = [...new Set([...tracked, ...extraFiles])].filter(name => !excluded(name)).sort();
    const files = {};
    for (const name of names) {
        if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Unsafe snapshot path');
        const source = path.join(root, name);
        if (!fs.existsSync(source)) continue;
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Source symlink requires review: ${name}`);
        if (!fs.statSync(source).isFile()) throw new Error(`Source is not a file: ${name}`);
        const bytes = fs.readFileSync(source);
        files[name] = hash(bytes);
        const target = path.join(destination, name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, bytes, {mode: fs.statSync(source).mode & 0o777});
    }
    return {files, sourceHash: hash(canonical(files))};
}

export function deltaFiles(baseline, candidate) {
    return [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])]
        .filter(name => baseline[name] !== candidate[name]).sort();
}

export function checkScope(changed) {
    const blocked = changed.filter(name =>
        !/^(src|tests|docs)\//.test(name) ||
        /^(?:src\/(?:release\/|login\.js|SettingsManager\.js|envUtils\.js|configUtils\.js|runtimeConfig\.js|secureFlags\.js|SitrecObjectResolver\.js|SitchProvenance\.js))/.test(name));
    if (blocked.length) throw new Error(`Full ship required for: ${blocked.join(', ')}`);
}

const staticExtensions = new Set(['.js', '.mjs', '.css', '.json', '.html', '.md', '.txt', '.png', '.jpg', '.jpeg',
    '.gif', '.svg', '.ico', '.webmanifest', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf',
    '.wasm', '.bin', '.glb', '.gltf', '.obj', '.mtl', '.csv', '.kml', '.kmz', '.tle', '.mp4', '.webm',
    '.zip', '.srt', '.vtt', '.gpx', '.tif', '.tiff', '.xml', '.stl', '.ppm']);
export function copyFrontend(source, destination) {
    const copied = [];
    function walk(directory, prefix = '') {
        for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
            const name = prefix + entry.name;
            if (entry.isSymbolicLink()) throw new Error(`Artifact symlink: ${name}`);
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) {
                if (prefix === '' && !['data', 'assets', 'docs', 'libs', 'src'].includes(entry.name)) continue;
                walk(path.join(directory, entry.name), name + '/');
            } else if (staticExtensions.has(path.extname(name).toLowerCase())) {
                if (prefix === '' && /^(?:config|shared\.env)/.test(entry.name)) continue;
                const target = path.join(destination, name);
                fs.mkdirSync(path.dirname(target), {recursive: true});
                fs.copyFileSync(path.join(directory, entry.name), target);
                copied.push(name);
            }
        }
    }
    walk(source);
    for (const name of ['index.html', 'app-entry.json', 'build-info.json']) {
        if (!copied.includes(name)) throw new Error(`Missing frontend artifact: ${name}`);
    }
    return copied;
}

function argumentsFor(argv) {
    const result = {command: argv[0], include: []};
    for (let i = 1; i < argv.length; i += 2) {
        if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error('Expected --name value');
        const name = argv[i].slice(2);
        if (name === 'include') result.include.push(argv[i + 1]);
        else result[name] = argv[i + 1];
    }
    return result;
}

function write(file, value) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
}

async function main(args) {
    if (!args.work) throw new Error('Pass --work with an isolated build directory');
    const work = path.resolve(args.work);
    const recordPath = path.join(work, 'quickship.json');
    if (args.command === 'prepare') {
        const start = performance.now();
        if (fs.existsSync(recordPath)) throw new Error('Use a fresh work directory');
        fs.mkdirSync(work, {recursive: true});
        const source = path.join(work, 'source');
        const identity = snapshot(source, args.include);
        const channel = args.channel || 'beta';
        if (!['beta', 'shipped'].includes(channel)) throw new Error('Invalid channel');
        if (!/^\d+\.\d+\.\d+$/.test(args.version || '')) throw new Error('Pass a numeric --version');
        let baseline, changed = [];
        if (channel === 'beta') {
            if (!args.baseline) throw new Error('Beta requires --baseline from the reviewed foundation');
            baseline = JSON.parse(fs.readFileSync(args.baseline));
            if (baseline.channel !== 'shipped' || baseline.foundationReviewed !== true) throw new Error('Baseline is not a reviewed Shipped foundation');
            changed = deltaFiles(baseline.files, identity.files);
            checkScope(changed);
            if (!changed.length) throw new Error('No changes beyond Shipped');
        }
        const builtAt = new Date().toISOString();
        const id = `${channel}-${builtAt.replace(/[^0-9]/g, '').slice(0, 17)}-${identity.sourceHash.slice(0, 12)}`;
        const deltaHash = hash(JSON.stringify(changed.map(name => [name, identity.files[name] || null])));
        const tracked = new Set(run('git', ['ls-files', '-z']).split('\0'));
        const dirty = run('git', ['diff', 'HEAD', '--name-only', '-z']).split('\0').filter(name => name && !excluded(name));
        const sourceMatchesCommit = dirty.length === 0 && Object.keys(identity.files).every(name => tracked.has(name));
        const record = {format: 1, ...identity, channel, version: args.version, builtAt, id,
            sourceCommit: run('git', ['rev-parse', 'HEAD']).trim(), sourceMatchesCommit, changed, deltaHash,
            baselineId: baseline?.id || null, baselineRuntime: baseline?.runtime || null,
            foundationReviewed: false, phases: []};
        write(recordPath, record);
        // Always build with public example configuration. Runtime credentials
        // belong to the reviewed backend and never enter the beta image context.
        for (const name of ['shared.env', 'config.js', 'config.php']) {
            fs.copyFileSync(path.join(source, 'config', name + '.example'), path.join(source, 'config', name));
        }
        fs.writeFileSync(path.join(source, 'config/config-install.js'),
            "const path=require('path'); module.exports={dev_path:path.resolve(__dirname,'../dist'),prod_path:path.resolve(__dirname,'../dist'),buildFolder:''};\n");
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(source, 'node_modules'), 'dir');
        const vendor = path.join(ROOT, 'sitrecServer/vendor');
        if (fs.existsSync(vendor)) fs.symlinkSync(vendor, path.join(source, 'sitrecServer/vendor'), 'dir');
        // Optional local parser fixtures remain outside source/, the image
        // context and the public-source backup. Preserve the normal test coverage.
        const fixtures = path.resolve(ROOT, '../nitf-test-files');
        if (fs.existsSync(fixtures)) fs.symlinkSync(fixtures, path.join(work, 'nitf-test-files'), 'dir');
        // Some tests inventory tracked source. An isolated index provides exactly
        // the frozen public files without creating a commit or copying history.
        run('git', ['init', '--quiet', source]);
        run('git', ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
            {cwd: source, input: Object.keys(identity.files).join('\0') + '\0'});
        record.phases.push({name: 'prepare', status: 'passed', startedAt: builtAt,
            seconds: Number(((performance.now() - start) / 1000).toFixed(2))});
        write(recordPath, record);
        console.log(JSON.stringify({work, id, deltaHash, changed}, null, 2));
        return;
    }
    const record = JSON.parse(fs.readFileSync(recordPath));
    const source = path.join(work, 'source');
    // Tests and packaging always use the frozen source, not whatever happens to
    // be in the editor when a later phase starts.
    for (const [name, expected] of Object.entries(record.files)) {
        const file = path.join(source, name);
        if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) throw new Error(`Frozen source changed: ${name}`);
    }
    async function phase(name, operation) {
        const start = performance.now();
        const log = path.join(work, `${name}.log`);
        const fd = fs.openSync(log, 'w');
        const entry = {name, startedAt: new Date().toISOString(), status: 'running'};
        try { await operation(fd); entry.status = 'passed'; }
        catch (error) { entry.status = 'failed'; entry.error = error.message; throw error; }
        finally {
            fs.closeSync(fd);
            entry.seconds = Number(((performance.now() - start) / 1000).toFixed(2));
            record.phases.push(entry);
            write(recordPath, record);
            console.log(JSON.stringify(entry));
        }
    }
    if (args.command === 'units') {
        await phase('units', fd => run('npm', ['test'], {cwd: source, stdio: ['ignore', fd, fd]}));
    } else if (args.command === 'build') {
        const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SHELL', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
        Object.assign(env, {DOCKER_BUILD: 'true', VERSION: record.version, SITREC_BUILD_CHANNEL: record.channel,
            SITREC_BUILD_ID: record.id, SITREC_BUILD_TIME: record.builtAt, SITREC_SOURCE_HASH: record.sourceHash});
        const notices = path.join(source, 'ThirdPartyNotices.txt');
        const originalNotices = fs.existsSync(notices) ? fs.readFileSync(notices) : null;
        await phase('build', fd => {
            try { run('npm', ['run', 'deploy'], {cwd: source, env, stdio: ['ignore', fd, fd]}); }
            finally {
                // The notice generator updates this source-side convenience copy
                // as well as dist/. Keep the frozen input intact; package dist/.
                if (originalNotices) fs.writeFileSync(notices, originalNotices);
                else fs.rmSync(notices, {force: true});
            }
        });
    } else if (args.command === 'regression') {
        if (!args.preview || !args.base) throw new Error('Pass --preview local webroot and --base URL');
        await phase('regression', fd => {
            copyFrontend(path.join(source, 'dist'), path.resolve(args.preview));
            if (args['runtime-js']) {
                const runtime = path.resolve(args['runtime-js']);
                // Supply only a reviewed browser-public runtime script, never
                // shared.env or a PHP/server configuration file.
                if (path.extname(runtime) !== '.js') throw new Error('--runtime-js must be a browser-public JavaScript file');
                fs.copyFileSync(runtime, path.join(args.preview, 'sitrec-runtime-env.js'));
                const html = path.join(args.preview, 'index.html');
                fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('</head>', '<script src="sitrec-runtime-env.js"></script></head>'));
            }
            run('node', ['tests_regression/fast-regression/run.mjs', `--base=${args.base}`], {stdio: ['ignore', fd, fd]});
        });
    } else if (args.command === 'import-image') {
        if (record.channel !== 'shipped' || !/^ghcr\.io\/mickwest\/sitrec2@sha256:[a-f0-9]{64}$/.test(args.image || '')) {
            throw new Error('Import requires a Shipped record and immutable release image');
        }
        if (record.sourceMatchesCommit !== true) throw new Error('Release import requires an unchanged committed source snapshot');
        const image = JSON.parse(run('docker', ['image', 'inspect', args.image]))[0];
        if (image.Config.Labels?.['org.opencontainers.image.revision'] !== record.sourceCommit) {
            throw new Error('The release image revision differs from the frozen source commit');
        }
        await phase('import-image', fd => {
            const container = run('docker', ['create', '--platform', 'linux/amd64', args.image]).trim();
            try {
                fs.mkdirSync(path.join(source, 'dist'), {recursive: true});
                run('docker', ['cp', container + ':/var/www/html/.', path.join(source, 'dist')], {stdio: ['ignore', fd, fd]});
            } finally { run('docker', ['rm', '-v', container]); }
        });
        const build = JSON.parse(fs.readFileSync(path.join(source, 'dist/build-info.json')));
        if (build.channel !== 'shipped' || build.version !== record.version) throw new Error('Release build identity mismatch');
        Object.assign(record, build, {releaseImage: args.image});
        write(recordPath, record);
    } else if (args.command === 'package') {
        if (!/^(?:ghcr\.io\/mickwest\/sitrec2@)?sha256:[a-f0-9]{64}$/.test(args.runtime || '')) {
            throw new Error('Pass --runtime with an immutable reviewed image digest');
        }
        if (record.channel === 'beta' && args['reviewed-delta'] !== record.deltaHash) throw new Error('Review the frozen diff and pass its --reviewed-delta hash');
        if (record.channel === 'beta' && record.baselineRuntime !== args.runtime) throw new Error('Beta must use the Shipped foundation runtime');
        const context = path.join(work, 'image-context');
        fs.mkdirSync(context, {recursive: true});
        const target = path.join(context, 'frontend/builds', record.id);
        const files = copyFrontend(path.join(source, 'dist'), target);
        // A previous static image retains older immutable build paths. It must
        // use the same reviewed runtime; changing runtimes is a full ship.
        let base = args.runtime;
        let retained = '';
        if (args.previous) {
            if (!/^sha256:[a-f0-9]{64}$/.test(args.previous)) throw new Error('Previous static image must be immutable');
            const info = JSON.parse(run('docker', ['image', 'inspect', args.previous]))[0];
            if (!info.Config.Labels?.['org.sitrec.reviewed-runtime']) throw new Error('Previous image is not a frontend pool');
            if (info.Config.Labels['org.sitrec.reviewed-runtime'] !== args.runtime) {
                if (record.channel !== 'shipped') throw new Error('Previous image uses a different runtime');
                retained = `FROM ${args.previous} AS retained\n`;
            } else base = args.previous;
        }
        fs.copyFileSync(path.join(source, 'docker/frontend_server.py'), path.join(context, 'frontend_server.py'));
        fs.writeFileSync(path.join(context, 'Dockerfile'), `${retained}FROM ${base}\nUSER root\n${retained ? 'COPY --from=retained /srv/frontend/builds/ /srv/frontend/builds/\n' : ''}COPY frontend/ /srv/frontend/\nCOPY frontend_server.py /usr/local/lib/sitrec/frontend_server.py\nUSER 33:33\nWORKDIR /srv/frontend\nLABEL org.sitrec.reviewed-runtime="${args.runtime}"\nENTRYPOINT ["python3", "/usr/local/lib/sitrec/frontend_server.py"]\nCMD []\nHEALTHCHECK CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=3)"\n`);
        const tag = `sitrec-local:${record.id}`;
        await phase('package', fd => run('docker', ['buildx', 'build', '--load', '--platform', 'linux/amd64', '-t', tag, context], {stdio: ['ignore', fd, fd]}));
        record.image = tag;
        record.imageId = JSON.parse(run('docker', ['image', 'inspect', tag]))[0].Id;
        record.runtime = args.runtime;
        record.artifactFiles = files.length;
        record.artifactHashes = Object.fromEntries(files.map(name => [name, hash(fs.readFileSync(path.join(target, name)))]));
        record.artifactHash = hash(canonical(record.artifactHashes));
        write(recordPath, record);
    } else throw new Error('Commands: prepare, units, build, regression, import-image, package');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = argumentsFor(process.argv.slice(2));
    let lock;
    try {
        if (!args.work) throw new Error('Pass --work with an isolated build directory');
        fs.mkdirSync(path.resolve(args.work), {recursive: true});
        lock = path.join(path.resolve(args.work), '.phase-lock');
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid, command: args.command}));
        await main(args);
    } catch (error) {
        console.error(error.code === 'EEXIST' ? 'Another phase owns this work directory. Run phases sequentially; inspect the lock owner before recovering an interrupted run.' : error.message);
        process.exitCode = 1;
    } finally {
        if (lock && fs.existsSync(path.join(lock, 'owner.json')) &&
            JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).pid === process.pid) fs.rmSync(lock, {recursive: true});
    }
}
