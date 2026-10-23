const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// tile_usage.php keeps a usage file per user. A guest is known by the sitrec_guest_id cookie.
// Behind a proxy that strips cookies, that cookie never comes back, so each guest report used
// to mint a new ID and write a new file that nothing read again, and nothing deleted.
// Now a guest file is written only when the request carried an existing guest ID, and old
// guest files are deleted by a sweep that runs at most once an hour.
const phpCgi = spawnSync('php-cgi', ['-v'], {encoding: 'utf8'}).status === 0 ? 'php-cgi' : null;

const SERVER = path.join(__dirname, '../sitrecServer');
const GUEST_ID = '0123456789abcdef0123456789abcdef';
const DAY = 86400;

const STUBS = {
    'config.php': '<?php\n',
    'user.php': `<?php
function getUserInfo() {
    return ['user_id' => (int)getenv('TEST_USER_ID'),
            'user_groups' => json_decode(getenv('TEST_USER_GROUPS') ?: '[]', true)];
}
`,
};

(phpCgi ? describe : describe.skip)('tile_usage.php guest usage files', () => {
    let root;
    let usageDir;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-tiles-'));
        for (const dir of ['sitrecServer', 'cache', 'tmp']) {
            fs.mkdirSync(path.join(root, dir));
        }
        for (const name of ['tile_usage.php', 'stats_history.php']) {
            fs.copyFileSync(path.join(SERVER, name), path.join(root, 'sitrecServer', name));
        }
        for (const [name, content] of Object.entries(STUBS)) {
            fs.writeFileSync(path.join(root, 'sitrecServer', name), content);
        }
        fs.writeFileSync(path.join(root, 'sitrecServer/config_paths.php'),
            `<?php $CACHE_PATH = ${JSON.stringify(path.join(root, 'cache') + '/')};\n`);
        // sys_get_temp_dir() follows TMPDIR, which keeps the usage files in the fixture.
        usageDir = path.join(root, 'tmp/sitrec_tile_usage');
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    function post(usage, {userId = 0, groups = [], cookie = null} = {}) {
        const input = JSON.stringify({usage});
        const env = {
            ...process.env,
            TMPDIR: path.join(root, 'tmp'),
            REDIRECT_STATUS: '1',
            REQUEST_METHOD: 'POST',
            SCRIPT_FILENAME: path.join(root, 'sitrecServer/tile_usage.php'),
            CONTENT_TYPE: 'application/json',
            CONTENT_LENGTH: String(Buffer.byteLength(input)),
            SITREC_TRACK_STATS: 'true',
            TEST_USER_ID: String(userId),
            TEST_USER_GROUPS: JSON.stringify(groups),
        };
        if (cookie) env.HTTP_COOKIE = cookie;
        const result = spawnSync(phpCgi, ['-d', 'display_errors=0'],
            {encoding: 'utf8', timeout: 10000, env, input});
        const split = result.stdout.search(/\r?\n\r?\n/);
        return {head: result.stdout.slice(0, split), json: JSON.parse(result.stdout.slice(split).trim())};
    }

    const usageFiles = () => (fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : [])
        .filter(name => name.startsWith('user_')).sort();
    const readUsage = name => JSON.parse(fs.readFileSync(path.join(usageDir, name), 'utf8'));

    function writeAged(name, ageDays) {
        fs.mkdirSync(usageDir, {recursive: true});
        const file = path.join(usageDir, name);
        fs.writeFileSync(file, JSON.stringify({hourly: {osm: 1}, daily: {osm: 1}, hourReset: 0, dayReset: 0}));
        const time = Date.now() / 1000 - ageDays * DAY;
        fs.utimesSync(file, time, time);
    }

    test('a guest report without a guest ID writes no usage file', () => {
        const {head, json} = post({osm: 5});

        expect(json.success).toBe(true);
        expect(json.usage).toEqual({osm: 5});
        // The new ID is still offered, for a deployment where cookies reach PHP.
        expect(head).toMatch(/^Set-Cookie: sitrec_guest_id=[0-9a-f]{32}/mi);
        expect(usageFiles()).toEqual([]);
    });

    test('a guest report with a guest ID is still tracked and adds up', () => {
        post({osm: 5}, {cookie: `sitrec_guest_id=${GUEST_ID}`});
        const {head, json} = post({osm: 3}, {cookie: `sitrec_guest_id=${GUEST_ID}`});

        expect(head).not.toMatch(/^Set-Cookie:/mi);
        expect(json.usage).toEqual({osm: 8});
        expect(usageFiles()).toEqual([`user_guest_${GUEST_ID}.json`]);
        expect(readUsage(`user_guest_${GUEST_ID}.json`).daily).toEqual({osm: 8});
    });

    test('a logged-in user is tracked as before', () => {
        post({mapbox: 2}, {userId: 42, groups: [2]});
        const {json} = post({mapbox: 3}, {userId: 42, groups: [2]});

        expect(json.usage).toEqual({mapbox: 5});
        expect(json.remaining.mapbox).toBe(495);
        expect(usageFiles()).toEqual(['user_42.json']);
        expect(readUsage('user_42.json').hourly).toEqual({mapbox: 5});
    });

    test('deletes old guest files, keeps recent ones and user files, and sweeps at most once an hour', () => {
        const oldGuests = ['a', 'b', 'c'].map(ch => `user_guest_${ch.repeat(32)}.json`);
        for (const name of oldGuests) writeAged(name, 5);
        const recentGuest = `user_guest_${'d'.repeat(32)}.json`;
        writeAged(recentGuest, 1);
        writeAged('user_7.json', 5);

        post({osm: 1}, {userId: 42, groups: [2]});

        expect(usageFiles()).toEqual(['user_42.json', 'user_7.json', recentGuest].sort());

        // The next sweep waits an hour, so a file that is old now stays until then.
        const lateGuest = `user_guest_${'e'.repeat(32)}.json`;
        writeAged(lateGuest, 5);
        post({osm: 1});

        expect(usageFiles()).toContain(lateGuest);
    });
});
