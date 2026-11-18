import {Group} from 'three';
import {CNodeDisplayWindField} from '../src/nodes/CNodeDisplayWindField';
import {setFileManager, setNodeMan, setSit, setGlobalDateTimeNode} from '../src/Globals';
import {par} from '../src/par';
import {LoadingManager} from '../src/CLoadingManager';

const time = Date.parse('2020-12-30T06:00:00Z');
const grid = {source:'GFS', refTime:'2020-12-30T06:00:00Z', level:'10m',
    nx:2, ny:2, lon0:0, lat0:90, dlon:180, dlat:-180, u:[8,8,8,8], v:[0,0,0,0]};
const makeField = extra => Object.assign(Object.create(CNodeDisplayWindField.prototype), {
    source:'gfs', windAltFt:33, visible:true, linesVisible:true, simpleSerials:[],
    inspectObjects:{}, inspectPoints:[], _object:new Group(), inputs:{},
    _levelCache:{}, _loadedWindFiles:new Map(), _failedLevels:new Map(),
    _omColumns:new Map(), _omInFlight:new Map(), _sourceDataVersion:0,
    _soundingSet:()=>null, setInspect:jest.fn(),
    material:{uniforms:{uTime:{value:0}}}, frameCount:0,
    rebuildStreamlines:jest.fn(), propagateToWindNodes:jest.fn(), _showProvenance:jest.fn(),
    setStatusMessage(message) { this.statusText = message; },
}, extra);

let previousFrame, previousFetch, manager;
beforeEach(() => {
    previousFrame = par.frame;
    previousFetch = global.fetch;
    par.frame = 0;
    setSit({frames:100});
    setNodeMan({exists:()=>false, get:()=>undefined});
    setGlobalDateTimeNode({dateNow:new Date(time), frameToMS:f=>time+f*3600000});
    manager = {list:{}, add(id, data, original) {this.list[id]={data, original};}};
    setFileManager(manager);
    for (const method of ['error', 'warn', 'log']) jest.spyOn(console, method).mockImplementation(()=>{});
    jest.spyOn(LoadingManager, 'registerLoading').mockImplementation(()=>{});
    jest.spyOn(LoadingManager, 'completeLoading').mockImplementation(()=>{});
    global.fetch = jest.fn().mockRejectedValue(new Error('Offline'));
});
afterEach(() => {
    jest.restoreAllMocks();
    par.frame = previousFrame;
    global.fetch = previousFetch;
    setSit(undefined); setNodeMan(undefined); setFileManager(undefined); setGlobalDateTimeNode(undefined);
});

test.each(['gfs', 'custom'])('a local %s save restores both times and other loaded levels offline', async source => {
    par.frame = 3; // A 50/50 blend between 06Z and 12Z.
    const later = {...grid, refTime:'2020-12-30T12:00:00Z', u:[20,20,20,20]};
    const aloft = {...grid, level:'500hPa', hgt:[5500,5500,5500,5500], u:[40,40,40,40]};
    const field = makeField({source, _levelCache:{
        [`${source}:20201230_6_surface`]:grid,
        [`${source}:20201230_12_surface`]:later,
        [`${source}:20201230_6_500`]:aloft,
    }});
    await field.fetchWindForAltitude(33);
    expect(field.windU[0]).toBe(14);
    const saved = JSON.parse(JSON.stringify(field.modSerialize(true)));
    expect(typeof saved.localWindGrids).toBe('string');
    expect(field.modSerialize().localWindGrids).toBeUndefined();

    // Nothing from the original session, its folder, or the server is available.
    manager.list = {};
    const restored = makeField();
    await restored.modDeserialize(saved);
    expect(restored._needsPostDeserializeFetch).toBe(true);
    expect(restored._needsPostDeserializeReloadGFS).toBeUndefined();
    await restored.fetchWindForAltitude(restored.windAltFt);
    expect([...restored.windU]).toEqual([...field.windU]);
    expect(await restored._fetchLevel('500', '20201230', 6, source)).toEqual(aloft);
    expect(global.fetch).not.toHaveBeenCalled();
});

test('local saves retain a separate camera source and the actual earlier-cycle snapshot', async () => {
    const earlier = {...grid, _earlierCycle:true, _fetchedAt:0};
    const field = makeField({source:'manual', sourceLocal:'custom', sourceSeparate:true,
        _levelCache:{'custom:20201230_12_surface':earlier}});
    const restored = makeField();
    await restored.modDeserialize(JSON.parse(JSON.stringify(field.modSerialize(true))));
    expect(restored.sourceKeyFor('local')).toBe('custom');
    const actual = await restored._fetchLevel('surface', '20201230', 12, 'custom');
    expect(actual.refTime).toBe(grid.refTime);
    expect(actual.u).toEqual(grid.u);
    expect(global.fetch).not.toHaveBeenCalled();
    // Saving the snapshot must not change the live session's retry policy.
    expect(earlier._earlierCycle).toBe(true);
});

test('a legacy grid available only in FileManager is included in a local snapshot', async () => {
    const field = makeField();
    field._applyWindJSON(grid);
    field._storeWindFiles(grid, grid, false, '20201230', 6);
    // Exercise decompression of a legacy/local asset, not only parsed JSON.
    for (const entry of Object.values(manager.list)) delete entry.data;
    const saved = JSON.parse(JSON.stringify(field.modSerialize(true)));
    manager.list = {};
    const restored = makeField();
    await restored.modDeserialize(saved);
    await restored.fetchWindForAltitude(33);
    expect([...restored.windU]).toEqual(grid.u);
    expect(global.fetch).not.toHaveBeenCalled();
});

test.each(['gfs', 'custom', 'openmeteo'])('%s retries at a new time after a failed fill without retrying every frame', async source => {
    const fill = jest.fn().mockRejectedValueOnce(new Error('Temporary upstream failure'));
    const field = makeField({source, _displaySource:source, _displayTimeKey:'previous-time',
        _fillFromGridSource:fill, _fillFromOpenMeteo:fill});
    await field.fetchWindForAltitude(33);
    expect(field._displayTimeKey).toBeNull();
    field.update(0);
    field.update(0);
    expect(fill).toHaveBeenCalledTimes(1);

    fill.mockImplementation(async () => {
        field._applyWindJSON(grid);
        field._displayTimeKey = field._windDisplayTimeKey();
    });
    const fetchDisplay = jest.spyOn(field, 'fetchWindForAltitude');
    par.frame = 6;
    field.update(6);
    await fetchDisplay.mock.results[0].value;
    expect([...field.windU]).toEqual(grid.u);
    expect(fill).toHaveBeenCalledTimes(2);
    field.update(6);
    expect(fill).toHaveBeenCalledTimes(2);
});

test('a time change during a failed request is picked up after that request finishes', async () => {
    let fail;
    const fill = jest.fn().mockImplementationOnce(() => new Promise((resolve, reject) => {fail = reject;}));
    const field = makeField({_fillFromGridSource:fill});
    const original = field.fetchWindForAltitude(33);
    par.frame = 6;
    field.update(6);
    expect(fill).toHaveBeenCalledTimes(1);
    fail(new Error('Temporary failure'));
    await original;
    fill.mockResolvedValue(undefined);
    const fetchDisplay = jest.spyOn(field, 'fetchWindForAltitude');
    field.update(6);
    await fetchDisplay.mock.results[0].value;
    expect(fill).toHaveBeenCalledTimes(2);
});
