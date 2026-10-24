const {spawn, spawnSync} = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// standalone-server.js proxies every PHP request from localhost, so PHP sees each caller as
// loopback and the default config treats it as the local admin. Listening on every interface
// handed that to anyone on the same network, so it now listens on loopback unless
// SITREC_HOST says otherwise.
const php = spawnSync('php', ['-v'], {encoding: 'utf8'}).status === 0;
const lanAddress = Object.values(os.networkInterfaces()).flat()
    .find(a => a && a.family === 'IPv4' && !a.internal)?.address;

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
            const {port} = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function get(host, port) {
    return new Promise((resolve) => {
        http.get({host, port, path: '/debug/status', timeout: 3000}, res => {
            res.resume();
            resolve(res.statusCode);
        }).on('error', err => resolve(err.code)).on('timeout', function () {
            resolve('TIMEOUT');
            this.destroy();
        });
    });
}

(php ? describe : describe.skip)('standalone-server.js listen address', () => {
    let root;
    let server;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-standalone-'));
        fs.mkdirSync(path.join(root, 'dist-standalone', 'sitrecServer'), {recursive: true});
        fs.copyFileSync(path.join(__dirname, '../standalone-server.js'), path.join(root, 'standalone-server.js'));
    });

    afterEach(async () => {
        if (server && server.exitCode === null) {
            const exited = new Promise(resolve => server.once('exit', resolve));
            server.kill('SIGTERM'); // its handler stops the PHP server too
            await exited;
        }
        fs.rmSync(root, {recursive: true, force: true});
    });

    async function start(extraEnv = {}) {
        const port = await freePort();
        const phpPort = await freePort();
        server = spawn(process.execPath, [path.join(root, 'standalone-server.js')], {
            env: {...process.env, NODE_ENV: 'production', SITREC_HOST: '', ...extraEnv,
                NODE_PATH: path.join(__dirname, '../node_modules'),
                SITREC_PORT: String(port), SITREC_PHP_PORT: String(phpPort)},
        });
        let output = '';
        await new Promise((resolve, reject) => {
            server.stdout.on('data', d => {
                output += d;
                if (output.includes('Press Ctrl+C')) resolve();
            });
            server.stderr.on('data', d => { output += d; });
            server.once('exit', code => reject(new Error(`server exited (${code}): ${output}`)));
        });
        return {port, output};
    }

    test('listens on loopback by default', async () => {
        const {port, output} = await start();
        expect(await get('127.0.0.1', port)).toBe(200);
        // Some hosts refuse a closed port on the LAN address and others drop the packets, so the
        // request times out. Either way the server must not answer there: any HTTP status at
        // all would mean it is reachable from the network.
        if (lanAddress) {
            expect(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'TIMEOUT'])
                .toContain(await get(lanAddress, port));
        }
        expect(output).not.toMatch(/WARNING/);
    }, 20000);

    test('SITREC_HOST opens it to the network, with a warning', async () => {
        const {port, output} = await start({SITREC_HOST: '0.0.0.0'});
        expect(output).toMatch(/WARNING: listening on 0\.0\.0\.0/);
        if (lanAddress) expect(await get(lanAddress, port)).toBe(200);
    }, 20000);
});
