const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// record_visit.php is anonymous and appends one entry to the day's visits file, which it
// reads and rewrites whole on every visit. Two limits keep that file, and so the cost of
// every page load, bounded: the sitch value is cut to a short length, and once the file
// reaches its size limit the rest of the day's visits are not recorded.
const phpCgi = spawnSync('php-cgi', ['-v'], {encoding: 'utf8'}).status === 0 ? 'php-cgi' : null;

const SERVER = path.join(__dirname, '../sitrecServer');
const MAX_BYTES = Number(fs.readFileSync(path.join(SERVER, 'stats_history.php'), 'utf8')
    .match(/const VISITS_FILE_MAX_BYTES = (\d+);/)[1]);

const STUBS = {
    'config.php': '<?php\n',
    'user.php': `<?php
function getUserInfo() {
    return ['user_id' => (int)getenv('TEST_USER_ID'), 'user_groups' => []];
}
`,
};

(phpCgi ? describe : describe.skip)('record_visit.php file growth limits', () => {
    let root;
    let statsDir;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-visit-'));
        for (const dir of ['sitrecServer', 'cache', 'tmp']) {
            fs.mkdirSync(path.join(root, dir));
        }
        for (const name of ['record_visit.php', 'stats_history.php']) {
            fs.copyFileSync(path.join(SERVER, name), path.join(root, 'sitrecServer', name));
        }
        for (const [name, content] of Object.entries(STUBS)) {
            fs.writeFileSync(path.join(root, 'sitrecServer', name), content);
        }
        fs.writeFileSync(path.join(root, 'sitrecServer/config_paths.php'),
            `<?php $CACHE_PATH = ${JSON.stringify(path.join(root, 'cache') + '/')};\n`);
        statsDir = path.join(root, 'cache/sitrec-stats');
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    // The date is UTC on both sides, so the test knows which file today's visit goes to.
    const todayFile = () => path.join(statsDir, `visits_${new Date().toISOString().slice(0, 10)}.json`);

    function visit(query, userId = 0) {
        const result = spawnSync(phpCgi, ['-d', 'date.timezone=UTC', '-d', 'display_errors=0'], {
            encoding: 'utf8', timeout: 10000,
            env: {
                ...process.env,
                TMPDIR: path.join(root, 'tmp'),
                REDIRECT_STATUS: '1',
                REQUEST_METHOD: 'GET',
                SCRIPT_FILENAME: path.join(root, 'sitrecServer/record_visit.php'),
                QUERY_STRING: query,
                SITREC_TRACK_STATS: 'true',
                REMOTE_ADDR: '203.0.113.7',
                TEST_USER_ID: String(userId),
            },
        });
        const body = result.stdout.slice(result.stdout.search(/\r?\n\r?\n/)).trim();
        expect(JSON.parse(body)).toEqual({ok: true});
    }

    // getVisitDetails() is what the admin dashboard reads, so the file must stay readable by it.
    function readVisits() {
        const script = 'require $argv[1]; echo json_encode(getVisitDetails(date("Y-m-d")));';
        const result = spawnSync('php', ['-d', 'date.timezone=UTC', '-r', script,
            path.join(root, 'sitrecServer/stats_history.php')], {encoding: 'utf8', timeout: 10000});
        return JSON.parse(result.stdout);
    }

    test('cuts a long sitch value to 64 characters', () => {
        const long = 'abc<>' + 'x'.repeat(5000);
        visit('sitch=' + encodeURIComponent(long));

        const visits = readVisits();
        expect(visits.entries).toHaveLength(1);
        expect(visits.entries[0].sitch).toBe(('abc' + 'x'.repeat(5000)).slice(0, 64));
        expect(fs.statSync(todayFile()).size).toBeLessThan(300);
    });

    test('records an ordinary visit in the existing format', () => {
        visit('sitch=gimbal', 42);
        visit('sitch=custom');

        const visits = readVisits();
        expect(visits.entries.map(e => [e.user_id, e.ip, e.sitch])).toEqual([
            [42, '203.0.113.7', 'gimbal'],
            [0, '203.0.113.7', 'custom'],
        ]);
        expect(visits.users).toEqual({42: 1, 0: 1});
        expect(visits.ips).toEqual({'203.0.113.7': 2});
    });

    test('stops recording once the day\'s file reaches its size limit', () => {
        fs.mkdirSync(statsDir);
        // A valid visits file at the limit: one entry whose sitch pads it out.
        const full = {entries: [{user_id: 0, ip: '198.51.100.1', time: 0, sitch: ''}],
            users: {0: 1}, ips: {'198.51.100.1': 1}};
        const base = JSON.stringify(full).length;
        full.entries[0].sitch = 'p'.repeat(MAX_BYTES - base);
        fs.writeFileSync(todayFile(), JSON.stringify(full));
        const before = fs.readFileSync(todayFile());
        expect(before.length).toBe(MAX_BYTES);

        visit('sitch=gimbal');

        expect(fs.readFileSync(todayFile()).equals(before)).toBe(true);
    });
});
