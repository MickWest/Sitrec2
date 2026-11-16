const {spawnSync, spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {satelliteCatalogText, isSatelliteParquet, satelliteCatalogURL} = require('../src/SatelliteCatalogSource');
const {CTLEData, splitCSVRow} = require('../src/TLEUtils');
const {sniffFileType} = require('../src/sniffFileType');

const python = spawnSync('python3', ['-c', 'import pyarrow; import sys; print(sys.executable)'], {encoding:'utf8'});
const available = python.status === 0 && spawnSync('php', ['-v']).status === 0;
const header = 'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,EPOCH,CREATION_DATE,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,OBJECT_TYPE,RCS_SIZE,LAUNCH_DATE,DECAY_DATE,COUNTRY_CODE,SITE,GP_ID,FILE,MEAN_ELEMENT_THEORY,EPHEMERIS_TYPE';
const values = ['TEST SAT','2025-001A','100001','2025-10-10T12:34:56.123456','2025-10-10T14:00:00',
    '15.12345678','0.00012345','53.1234','90.5678','12.3456','30.1234','0.00001234567890',
    '0.00000001','0.0000000000000','PAYLOAD','SMALL','2025-01-01','','US','AFETR','4294967295',
    '18446744073709551615','SGP4','0'];
const csv = header + '\n' + values.join(',') + '\n';
const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

(available ? describe : describe.skip)('typed satellite Parquet cache', () => {
    let root, server, cache, source, binary, env;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-parquet-'));
        server = path.join(root, 'server'); cache = path.join(root, 'cache/starlink');
        fs.mkdirSync(server); fs.mkdirSync(cache, {recursive:true}); fs.mkdirSync(path.join(root, 'tmp'));
        for (const name of ['proxyStarlink.php', 'gpData.php', 'gpParquet.php', 'gpParquet.py']) {
            fs.copyFileSync(path.join(__dirname, '../sitrecServer', name), path.join(server, name));
        }
        fs.writeFileSync(path.join(server, 'config.php'), '<?php\n');
        fs.writeFileSync(path.join(server, 'config_paths.php'), '<?php $CACHE_PATH = ' + JSON.stringify(path.join(root, 'cache/')) + ';');
        fs.writeFileSync(path.join(server, 'curlGetRequest.php'), '<?php\n');
        source = path.join(cache, '2025-10-09ALL_epochs.csv.gz');
        binary = path.join(cache, '2025-10-09ALL_epochs.v1.parquet');
        fs.writeFileSync(source, zlib.gzipSync(csv));
        const when = new Date('2025-11-01T00:00:00Z'); fs.utimesSync(source, when, when);
        env = {...process.env, TMPDIR:path.join(root, 'tmp'), GP_PYTHON:python.stdout.trim(),
            SPACEDATA_USERNAME:'', SPACEDATA_PASSWORD:''};
    });
    afterEach(() => fs.rmSync(root, {recursive:true,force:true}));
    function args(format='parquet', type='ALL', modified='') {
        return ['-r', '$_GET=["request"=>"2025-10-09","type"=>$argv[2],"format"=>$argv[3]]; '
            + '$_SERVER["HTTP_IF_MODIFIED_SINCE"]=$argv[4]; require $argv[1];',
        path.join(server,'proxyStarlink.php'), type, format, modified];
    }
    const run = (...parameters) => spawnSync('php', args(...parameters), {env, timeout:20000});
    function convert(text, target=binary) {
        fs.writeFileSync(source, zlib.gzipSync(text));
        const result = spawnSync(python.stdout.trim(), [path.join(server,'gpParquet.py'),'encode',source,target]);
        expect(result.status).toBe(0);
        return arrayBuffer(fs.readFileSync(target));
    }

    test('migrates once, preserves cache age, and retains all orbit and provenance fields', async () => {
        const mtime = fs.statSync(source).mtimeMs;
        const first = run();
        expect(first.status).toBe(0);
        expect(isSatelliteParquet(arrayBuffer(first.stdout))).toBe(true);
        expect(sniffFileType(arrayBuffer(first.stdout))).toBe('parquet');
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.statSync(binary).mtimeMs).toBe(mtime);
        expect(run().stdout.equals(first.stdout)).toBe(true);
        const text = await satelliteCatalogText(arrayBuffer(first.stdout));
        expect(text).toBe(csv);
        const sat = new CTLEData(text).satData[0];
        expect(sat.number).toBe(100001);
        expect(sat.countryCode).toBe('US');
        expect(sat.satrecs[0].sourceFileId).toBe('18446744073709551615');
        expect(sat.satrecs[0].ephemerisType).toBe(0);
        const original = new CTLEData(csv).satData[0];
        expect(sat.satrecs[0]).toEqual(original.satrecs[0]);
        expect(fs.readdirSync(cache).filter(n=>n.startsWith('.gp-'))).toEqual([]);
    });

    test('old clients receive CSV and unchanged requests finish with no body', () => {
        expect(isSatelliteParquet(arrayBuffer(run().stdout))).toBe(true);
        expect(run('').stdout.toString()).toBe(csv);
        expect(run('parquet','ALL',new Date(fs.statSync(binary).mtimeMs).toUTCString()).stdout.length).toBe(0);
        expect(fs.existsSync(source)).toBe(false);
    });

    test('a missing converter leaves CSV usable and intact', () => {
        env.GP_PYTHON = '/unavailable/python3';
        const result = run();
        expect(result.stdout.toString()).toBe(csv);
        expect(zlib.gunzipSync(fs.readFileSync(source)).toString()).toBe(csv);
        expect(fs.existsSync(binary)).toBe(false);
    });

    test('an expired current catalog survives an upstream failure', () => {
        convert(csv);
        const current = path.join(cache,'current_all.v1.parquet'); fs.renameSync(binary,current);
        const old = new Date(Date.now()-7200000); fs.utimesSync(current,old,old);
        const result = run('parquet','CURRENT');
        expect(isSatelliteParquet(arrayBuffer(result.stdout))).toBe(true);
        expect(result.stderr.toString()).toContain('refresh failed, serving provisional cached copy');
        expect(fs.statSync(current).mtimeMs).toBeCloseTo(old.getTime(), 0);
    });

    test('parallel migrations both receive the same complete file', async () => {
        const request = () => new Promise((resolve,reject)=>{
            const child=spawn('php',args(),{env}); const chunks=[];
            child.stdout.on('data',b=>chunks.push(b)); child.on('error',reject);
            child.on('exit',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error('PHP '+code)));
        });
        const [a,b]=await Promise.all([request(),request()]);
        expect(isSatelliteParquet(arrayBuffer(a))).toBe(true); expect(a.equals(b)).toBe(true);
        expect(fs.existsSync(source)).toBe(false);
    });

    test('decimal bytes, pre-1970 microseconds, nulls and noncanonical numbers round-trip', async () => {
        const row = [...values];
        row[0] = '"SAT, ""quoted"""';
        row[3] = '1965-01-01T00:00:00.000001';
        row[11] = '-0.000000000000000012345678901234';
        row[20] = '000123'; // stays text rather than silently losing leading zeroes
        const text = header+'\n'+row.join(',')+'\n';
        const restored = await satelliteCatalogText(convert(text));
        expect(restored.split('\n').map(splitCSVRow)).toEqual(text.split('\n').map(splitCSVRow));
    });

    // A page policy whose connect-src has no data: source rejects fetch("data:...").
    // The decoder must start without that fetch. A new module registry gives
    // this test a decoder that has not started yet.
    test('decodes when the page policy blocks fetch of data: URLs', async () => {
        const buffer = convert(csv);
        const pageFetch = globalThis.fetch;
        const blockedFetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
        globalThis.fetch = blockedFetch;
        try {
            await jest.isolateModulesAsync(async () => {
                const freshSource = require('../src/SatelliteCatalogSource');
                expect(await freshSource.satelliteCatalogText(buffer)).toBe(csv);
            });
            expect(blockedFetch).not.toHaveBeenCalled();
            expect(globalThis.fetch).toBe(blockedFetch);
        } finally {
            globalThis.fetch = pageFetch;
        }
    });

    test('rejects truncated Parquet and keeps ordinary CSV/TLE decoding', async () => {
        const buffer = convert(csv);
        await expect(satelliteCatalogText(buffer.slice(0,20))).rejects.toThrow();
        expect(await satelliteCatalogText(new TextEncoder().encode(csv).buffer)).toBe(csv);
        expect(satelliteCatalogURL('/server/','2025-10-09','ALL',2)).toContain('format=parquet');
    });
});
