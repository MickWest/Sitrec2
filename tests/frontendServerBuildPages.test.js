const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn, spawnSync} = require('child_process');
const net = require('net');
const hasPython = spawnSync('python3', ['--version']).status === 0;

// A build's own top-level page must not be served: it would start a retired Beta or an
// older Shipped outside the channel manifest. Everything the bootstrap loads, and the
// per-build tool pages below tools/, must still be served.
(hasPython ? describe : describe.skip)('frontend artifact server', () => {
    let directory, server, origin;
    const build = 'beta-20260909221048500-dfbcb581e84a';
    const files = ['index.html', 'README.html', 'index.htm', 'app-entry.json', 'build-info.json',
        'index.abc.bundle.js', 'src_workers_Decode_js.abc.bundle.js', 'tools/shf/index.html',
        'tools/shf/rate/index.html', 'docs/Tracks.html'];
    beforeAll(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-frontend-'));
        for (const name of files) {
            const file = path.join(directory, 'builds', build, name);
            fs.mkdirSync(path.dirname(file), {recursive: true});
            fs.writeFileSync(file, 'fixture');
        }
        const port = await new Promise(resolve => {
            const socket = net.createServer();
            socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)); });
        });
        origin = `http://127.0.0.1:${port}`;
        server = spawn('python3', [path.resolve(__dirname, '../docker/frontend_server.py')], {stdio: 'ignore',
            env: {...process.env, SITREC_FRONTEND_ROOT: directory, PORT: String(port)}});
        for (let i = 0; i < 60; i++) {
            try { if ((await status('/healthz')) === 200) return; } catch { /* not listening yet */ }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Frontend server did not start');
    });
    afterAll(() => { server?.kill(); if (directory) fs.rmSync(directory, {recursive: true, force: true}); });
    function status(pathname, method = 'GET') {
        return new Promise((resolve, reject) => {
            const req = http.request(origin + pathname, {method}, response => { response.resume(); resolve(response.statusCode); });
            req.on('error', reject);
            req.end();
        });
    }

    test.each(['index.html', 'README.html', 'index.htm', 'INDEX.HTML'])('refuses the build page %s', async name => {
        expect(await status(`/builds/${build}/${name}`)).toBe(404);
        expect(await status(`/builds/${build}/${name}`, 'HEAD')).toBe(404);
    });

    test('refuses an encoded build page', async () => {
        expect(await status(`/builds/${build}/index%2Ehtml`)).toBe(404);
    });

    test.each(['app-entry.json', 'build-info.json', 'index.abc.bundle.js', 'src_workers_Decode_js.abc.bundle.js',
        'tools/shf/index.html', 'tools/shf/rate/index.html', 'docs/Tracks.html'])('still serves %s', async name => {
        expect(await status(`/builds/${build}/${name}`)).toBe(200);
    });
});
