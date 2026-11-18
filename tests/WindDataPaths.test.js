import {setFileManager, setGlobalDateTimeNode, setNodeMan, setSit} from '../src/Globals';
import {CNodeDisplayWindField, fetchOpenMeteoColumn} from '../src/nodes/CNodeDisplayWindField';
import {getNearbyWeatherBalloons} from '../src/SondeFetch';
import JSZip from 'jszip';
import {LoadingManager} from '../src/CLoadingManager';
import {spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createHash} from 'crypto';

jest.mock('../src/CProgressIndicator', () => ({initProgress() {}, updateProgress() {}, hideProgress() {}}));

const T0 = Date.parse('2020-12-30T06:00:00Z');
const grid = {source: 'GFS', refTime: '2020-12-30T06:00:00Z', level: '10m',
    nx: 2, ny: 2, lon0: 0, lat0: 90, dlon: 180, dlat: -180, u: [8,8,8,8], v: [0,0,0,0]};
const field = extra => Object.assign(Object.create(CNodeDisplayWindField.prototype), {
    source: 'gfs', windAltFt: 33, _levelCache: {}, _loadedWindFiles: new Map(),
    _omColumns: new Map(), _omInFlight: new Map(), _failedLevels: new Map(),
    _sourceDataVersion: 0, _soundingSet: () => null, _groundMSL: () => null,
    setStatusMessage(text) {this.statusText = text;},
}, extra);

beforeEach(() => {
    jest.spyOn(LoadingManager, 'registerLoading').mockImplementation(() => {});
    jest.spyOn(LoadingManager, 'completeLoading').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setSit({frames: 100});
    setNodeMan({get: () => undefined, exists: () => false});
    setGlobalDateTimeNode({dateNow: new Date(T0), frameToMS: f => T0 + f * 3600000});
});
afterEach(() => {
    setGlobalDateTimeNode(undefined); setFileManager(undefined); setNodeMan(undefined); setSit(undefined);
    delete global.fetch;
    jest.restoreAllMocks();
});

test('Open-Meteo uses the requested frame time', () => {
    const n = field({source: 'openmeteo'});
    const hours = Array.from({length: 24}, (_, h) => [{altM: 100, u: h, v: 0}]);
    n._omColumns.set('0|0|2020-12-30', {lat: 0, lon: 0, dateStr: '2020-12-30', hours});
    expect(n.windAt('openmeteo', 0, 0, 100, 0).u).toBe(6);
    expect(n.windAt('openmeteo', 0, 0, 100, 6).u).toBe(12);
});

test('a failed Open-Meteo column is no-data while retry is backed off', () => {
    const n = field();
    n._failedLevels.set('om:0.00|0.00|2020-12-30', Date.now());
    expect(n.windAt('openmeteo', 0, 0, 100).status).toBe('no-data');
    expect(n._omInFlight.size).toBe(0);
});

test('Open-Meteo failure invalidates consumers, reports the provider reason, and can recover', async () => {
    global.fetch = jest.fn().mockResolvedValue({ok:false, status:400,
        json:async()=>({error:true, reason:'Requested date is outside the available range'})});
    const n = field();
    expect(n.windAt('openmeteo', 0, 0, 100, 0).status).toBe('pending');
    await Promise.all(n._omInFlight.values());
    expect(n._sourceDataVersion).toBe(1);
    expect(n.windAt('openmeteo', 0, 0, 100, 0)).toMatchObject({
        status:'no-data', error:expect.stringContaining('outside the available range'),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    n._clearOpenMeteoColumns();
    global.fetch.mockResolvedValue({ok:true, json:async()=>({hourly:{
        geopotential_height_1000hPa: new Array(24).fill(100),
        wind_speed_1000hPa: new Array(24).fill(8),
        wind_direction_1000hPa: new Array(24).fill(270),
    }})});
    await n.loadDataFor('openmeteo', 0, 0, 100, 24);
    expect(global.fetch.mock.calls[1][0]).toContain('start_date=2020-12-31');
    expect(n.windAt('openmeteo', 0, 0, 100, 24)).toMatchObject({status:'ok', u:8});
});

test('an all-null Open-Meteo response is an explicit no-data error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ok:true, json:async()=>({hourly:{
        wind_speed_1000hPa:new Array(24).fill(null),
    }})});
    await expect(fetchOpenMeteoColumn(0, 0, '2020-12-30')).rejects.toThrow('no pressure-level wind data for 2020-12-30');
});

test('switching sources during a GFS fill preserves its source and leaves the display alone', async () => {
    const manager = {list: {}, add(id, data, original) {this.list[id] = {data, original};}};
    setFileManager(manager);
    let finish;
    const n = field({_applyWindJSON: jest.fn(), _frameTimeMs: () => T0,
        _fetchLevel: jest.fn(() => new Promise(resolve => {finish = resolve;}))});
    const fill = n._fillFromGridSource(33);
    n.source = 'custom';
    finish(grid);
    await fill;
    expect([...n._loadedWindFiles.values()][0].sourceKey).toBe('gfs');
    expect(n._applyWindJSON).not.toHaveBeenCalled();
    expect(n._windFileIds ?? []).toEqual([]);
    global.fetch = jest.fn().mockResolvedValue({ok: true, json: async () => ({...grid, source: 'Custom'})});
    const custom = await CNodeDisplayWindField.prototype._fetchLevel.call(n, 'surface', '20201230', 6, 'custom');
    expect(custom.source).toBe('Custom');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('customWindProxy.php');
});

test('a queued source switch finishes with the new field and separate saved grids', async () => {
    setFileManager({list:{}, add(id, data) {this.list[id] = {data};}});
    let finish;
    const n = field({_frameTimeMs:()=>T0, rebuildStreamlines:jest.fn(),
        propagateToWindNodes:jest.fn(), _showProvenance:jest.fn(),
        _fetchLevel:jest.fn((level, date, hour, source) => source === 'gfs'
            ? new Promise(resolve => {finish = resolve;})
            // Custom upstreams may use the same human-readable source label.
            : Promise.resolve({...grid, u:[20,20,20,20]}))});
    const original = n.fetchWindForAltitude(33);
    n.source = 'custom';
    await n.fetchWindForAltitude(33);
    finish(grid);
    await original;
    expect(n.windU[0]).toBe(20);
    expect(n._displaySource).toBe('custom');
    expect(n.rebuildStreamlines).toHaveBeenCalledTimes(1);
    expect([...n._loadedWindFiles.values()].map(m => m.sourceKey)).toEqual(['gfs', 'custom']);
});

test('provenance names only the cycle that is loaded', () => {
    const n = field({_frameTimeMs: () => T0 + 3 * 3600000,
        _levelCache: {'gfs:20201230_6_surface': grid}});
    const facts = n.sourceFacts('gfs');
    expect(facts.blended).toBe(false);
    expect(facts.time).toBe('2020-12-30 06Z');
});

test('provenance reports a real blend and uses the actual returned cycle', () => {
    const n = field({_frameTimeMs: () => T0 + 3 * 3600000,
        _levelCache: {'gfs:20201230_6_surface': grid,
            'gfs:20201230_12_surface': {...grid, refTime:'2020-12-30T12:00:00Z'}}});
    expect(n.sourceFacts('gfs')).toMatchObject({blended:true, time:'2020-12-30 06Z–12Z'});
    n._levelCache['gfs:20201230_12_surface'] = grid;
    expect(n.sourceFacts('gfs')).toMatchObject({blended:false, time:'2020-12-30 06Z'});
    n._levelCache = {};
    expect(n.sourceFacts('gfs')).toMatchObject({blended:false, time:null});
});

test('a failed second level never claims a time blend because another level arrived', async () => {
    setFileManager({list:{}, add(id, data) {this.list[id] = {data};}});
    const n = field({windAltFt:11000, _frameTimeMs:()=>T0 + 3 * 3600000,
        _levelCache:{'gfs:20201230_12_700':{...grid, refTime:'2020-12-30T12:00:00Z'}},
        _fetchLevel:jest.fn(async (level, date, hour) => {
            if (hour === 12 && level === '500') throw new Error('missing');
            return {...grid, level, refTime:`2020-12-30T${String(hour).padStart(2, '0')}:00:00Z`};
        })});
    await n._fillFromGridSource(11000);
    expect(n._lastWindJSON._timeWeight).toBe(0);
    expect(n.sourceFacts('gfs')).toMatchObject({blended:false, time:'2020-12-30 06Z'});
});

test('a failed source switch clears the previous wind field without changing display preferences', async () => {
    const manual = {...grid, source: 'Manual', level: '33ft'};
    const n = field({_lastWindJSON: manual, windU: manual.u, _windFileIds:['previous-source'],
        linesVisible: true, linesMesh: {visible: true}, _fillFromGridSource: async () => {throw new Error('No data');}});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await n.fetchWindForAltitude(33);
    expect(n.source).toBe('gfs');
    expect(n.statusText).toBe('Error: No data');
    expect(n._lastWindJSON).toBeNull();
    expect(n.windU).toBeNull();
    expect(n.linesMesh).toBeNull();
    expect(n.linesVisible).toBe(true);
    expect(n._windFileIds).toEqual([]);
});

test('automatic IGRA2 skips inactive stations and archive gaps, then imports a nearby launch', async () => {
    const sounding = (id, date) => `#${id} ${date} 12 1156    2 ncdc-gts ncdc-gts  377626  -999695\n`
        + '10 -9999 101320    79   -53   960   259   200    36\n'
        + '20   120  85000  1546   -93 -9999 -9999   270    82\n';
    const zip = text => new JSZip().file('data.txt', text).generateAsync({type: 'arraybuffer'});
    const old = await zip(sounding('USM00072451', '2024  1  1'));
    const near = await zip(sounding('USM00072452', '2020 12 30'));
    const stations = [
        {id:'USM00072450', wmo:'72450', name:'Inactive', lat:0, lon:0, firstYear:2024, lastYear:2026},
        {id:'USM00072451', wmo:'72451', name:'Gap', lat:1, lon:0, firstYear:2000, lastYear:2026},
        {id:'USM00072452', wmo:'72452', name:'Near launch', lat:2, lon:0, firstYear:2000, lastYear:2026},
    ];
    global.fetch = jest.fn().mockResolvedValueOnce({ok:true, json:async()=>stations})
        .mockResolvedValueOnce({ok:true, arrayBuffer:async()=>old})
        .mockResolvedValueOnce({ok:true, arrayBuffer:async()=>near});
    const parseResult = jest.fn();
    setFileManager({parseResult});
    setGlobalDateTimeNode({frameToDate:()=>new Date(T0)});
    setNodeMan({get:()=>undefined, iterate: fn=>fn('profile', {constructor:{name:'CNodeAtmosphericProfile'},
        stationId:'72452', getWindProfile:()=>[{},{}]})});
    const result = await getNearbyWeatherBalloons(1, 'igra2');
    expect(result).toEqual([
        expect.objectContaining({station:'72451', success:false, error:expect.stringContaining('within 12 hours')}),
        expect.objectContaining({station:'72452', success:true}),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls[1][0]).toContain('USM00072451');
    expect(parseResult).toHaveBeenCalledTimes(1);
    expect(parseResult.mock.calls[0][0]).toContain('2020-12-30_12Z');
});

const phpResult = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding:'utf8'});
const php = phpResult.status === 0 ? phpResult.stdout : null;

(php ? describe : describe.skip)('proxy regressions with isolated config, cache, and upstream stubs', () => {
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wind-path-review-'));
        fs.mkdirSync(path.join(root, 'sitrecServer/cache'), {recursive: true});
        fs.mkdirSync(path.join(root, 'tmp'));
        for (const file of ['customWindProxy.php', 'proxySounding.php']) {
            fs.copyFileSync(path.resolve(__dirname, '../sitrecServer', file), path.join(root, 'sitrecServer', file));
        }
        fs.writeFileSync(path.join(root, 'sitrecServer/config.php'), '<?php');
        fs.writeFileSync(path.join(root, 'sitrecServer/config_paths.php'), '<?php $CACHE_PATH=__DIR__."/cache/";');
        fs.writeFileSync(path.join(root, 'sitrecServer/audit.php'), '<?php function sitrecAuditRequest($x) {} function sitrecAuditResource($x) {} function sitrecAuditResult() {}');
        fs.writeFileSync(path.join(root, 'sitrecServer/curlGetRequest.php'), `<?php
            function curlConfiguredSourceHeaders($url) {return [];}
            function curlGetRequest($url, $headers=[], $timeout=0) {
                return ['http_status'=>(int)(getenv('MOCK_STATUS') ?: 200),
                    'data'=>json_encode(['url'=>$url, 'value'=>getenv('MOCK_VALUE')])];
            }`);
    });
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));
    const request = (script, query, env={}) => {
        const r = spawnSync(php, ['-r',
            '$_SERVER["REQUEST_METHOD"]="GET"; $_GET=json_decode($argv[2],true); register_shutdown_function(function(){fwrite(STDERR,(string)(http_response_code()?:200));}); require $argv[1];',
            path.join(root, 'sitrecServer', script), JSON.stringify(query)], {
            encoding: 'utf8', env: {...process.env, TMPDIR:path.join(root, 'tmp'),
                CUSTOM_WIND_URL:'https://weather.example/{YYYY}/{MM}/{DD}/{HH}/{LEVEL}',
                CACHE_CUSTOM_WIND:'false', MOCK_VALUE:'A', ...env},
        });
        return {status:Number(r.stderr), text:r.stdout};
    };
    test.each([
        {date:'20230231'}, {date:'20231301'}, {date:'2020-12-30'},
        {hour:'NaN'}, {hour:''}, {hour:'6junk'}, {hour:'24'}, {hour:'-1'},
        {level:'33ft'}, {level:'850hPa'}, {level:'123'},
    ])('custom proxy rejects malformed inputs %j', invalid => {
        const r = request('customWindProxy.php', {date:'20201230', hour:'6', level:'surface', ...invalid});
        expect(r.status).toBe(400);
        expect(JSON.parse(r.text).error).toMatch(/^Invalid/);
    });
    test('custom proxy accepts older dates and honors an hourly source', () => {
        const r = request('customWindProxy.php', {date:'20000229', hour:'7', level:'850'},
            {SITREC_CUSTOM_WIND_CADENCE_HOURS:'1'});
        expect(r.status).toBe(200);
        expect(JSON.parse(r.text).url).toBe('https://weather.example/2000/02/29/07/850hPa');
    });
    test.each(['false', '0', 'off', ''])('CACHE_CUSTOM_WIND=%s disables caching', setting => {
        const query = {date:'20201230', hour:6, level:'surface'};
        request('customWindProxy.php', query, {CACHE_CUSTOM_WIND:setting});
        const r = request('customWindProxy.php', query, {MOCK_VALUE:'B', CACHE_CUSTOM_WIND:setting});
        expect(JSON.parse(r.text).value).toBe('B');
    });
    test('CACHE_CUSTOM_WIND=true reuses the successful response', () => {
        const query = {date:'20201230', hour:6, level:'surface'};
        request('customWindProxy.php', query, {CACHE_CUSTOM_WIND:'true'});
        const r = request('customWindProxy.php', query, {MOCK_VALUE:'B', CACHE_CUSTOM_WIND:'true'});
        expect(JSON.parse(r.text).value).toBe('A');
    });
    test('an upstream UWYO 429 is preserved and the next request can recover', () => {
        const query = {source:'uwyo', station:'72451', date:'2020-12-30', hour:'0'};
        const first = request('proxySounding.php', query, {MOCK_STATUS:'429'});
        const second = request('proxySounding.php', query, {MOCK_STATUS:'200'});
        expect(first.status).toBe(429);
        expect(second.status).toBe(200);
    });
    test.each(['401', '403', '500', '503'])('UWYO HTTP %s is not cached as a missing sounding', status => {
        const query = {source:'uwyo', station:'72451', date:'2020-12-30', hour:'0'};
        expect(request('proxySounding.php', query, {MOCK_STATUS:status}).status).toBe(502);
        expect(request('proxySounding.php', query).status).toBe(200);
    });
    test('a definitive UWYO missing sounding is still cached', () => {
        const query = {source:'uwyo', station:'72451', date:'2020-12-30', hour:'0'};
        expect(request('proxySounding.php', query, {MOCK_STATUS:'404'}).status).toBe(404);
        expect(request('proxySounding.php', query).status).toBe(404);
    });
    test('a previously cached UWYO 429 is discarded immediately', () => {
        const url = 'https://weather.uwyo.edu/wsgi/sounding?datetime=2020-12-30+00%3A00%3A00&id=72451&type=TEXT%3ALIST';
        const hash = createHash('md5').update(url).digest('hex');
        fs.writeFileSync(path.join(root, 'sitrecServer/cache', `${hash}.miss`),
            'No sounding data available (UWYO HTTP 429).');
        expect(request('proxySounding.php', {source:'uwyo', station:'72451', date:'2020-12-30', hour:'0', format:'list'}).status)
            .toBe(200);
    });
});
