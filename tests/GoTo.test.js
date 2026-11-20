jest.mock('../src/Globals', () => ({
    GlobalDateTimeNode: {
        liveMode: false, dateNow: new Date('2025-09-19T20:50:00Z'),
        editTime: jest.fn(), setTimeZoneFromZone: jest.fn(),
        getTimeLocation: () => ({lat: 53.8479533, lon: -1.8384526}),
    },
    Sit: {aFrame: 0, bFrame: 100},
    NodeMan: {get: jest.fn()},
    setRenderOne: jest.fn(),
}));
jest.mock('../src/par', () => ({par: {frame: 0}}));
jest.mock('../src/nodes/CNodeFrameSlider', () => ({updateFrameSlider: jest.fn()}));
jest.mock('../src/UpdateSitFrames', () => ({lastSitFrame: () => 100}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/TLEPaste', () => ({importPastedTLE: jest.fn(async () => false)}));
jest.mock('../src/DateTimeParser', () => ({
    ...jest.requireActual('../src/DateTimeParser'), applyDateTimeString: jest.fn(() => false),
}));
jest.mock('../src/TimeZoneLookup', () => ({
    ...jest.requireActual('../src/TimeZoneLookup'), lookupTimeZone: jest.fn(),
}));
jest.mock('../src/CoordinateInput', () => ({
    goToLatLon: jest.fn(),
    resolveLocationString: jest.fn(),
}));
jest.mock('../src/CFeatureManager', () => ({FeatureManager: {addLocationPin: jest.fn()}}));

import {applyGoToString, executeGoToRequest} from '../src/GoTo';
import {parseGoToString} from '../src/GoToParser';
import {GlobalDateTimeNode, NodeMan} from '../src/Globals';
import {lookupTimeZone, utcOffsetHoursInZone} from '../src/TimeZoneLookup';
import {goToLatLon, resolveLocationString} from '../src/CoordinateInput';
import {FeatureManager} from '../src/CFeatureManager';
import {applyDateTimeString} from '../src/DateTimeParser';
import {beginInitialCameraPosition, noteCameraPositionChange, withInitialCameraPlacement} from '../src/InitialCameraPosition';

beforeEach(() => {
    jest.clearAllMocks();
    NodeMan.get.mockReset();
    resolveLocationString.mockReset();
    lookupTimeZone.mockReset();
    GlobalDateTimeNode.dateNow = new Date('2025-09-19T20:50:00Z');
    GlobalDateTimeNode.useTimeZone = false;
    GlobalDateTimeNode.setTimeZoneFromZone.mockImplementation((zone, date) => {
        GlobalDateTimeNode.timeZoneOffset = utcOffsetHoursInZone(zone, date);
    });
    lookupTimeZone.mockResolvedValue('Europe/London');
});

function initialLookCamera() {
    const position = {_LLA: [34, -118, 10000], agl: false};
    position.gotoLLA = jest.fn((lat, lon, alt, agl) => {
        position._LLA = [lat, lon, alt];
        position.agl = agl;
        noteCameraPositionChange(position);
    });
    const nodes = {fixedCameraPosition: position, cameraTrackSwitch: {choice: 'fixedCamera'}, lookCamera: {freeLook: false}};
    NodeMan.get.mockImplementation(id => nodes[id]);
    beginInitialCameraPosition(position, true);
    lookupTimeZone.mockResolvedValue('Asia/Seoul');
    resolveLocationString.mockResolvedValue({lat: 36.5, lon: 127.8});
    return {position, nodes};
}

test.each(['South Korea', ' Saturday, August 30, 2025, at 8:09 PM, South Korea'])(
    'text navigation places an untouched look camera 10 feet AGL: %s', async text => {
        const {position} = initialLookCamera();
        expect(await applyGoToString(text)).toBe(true);
        expect(resolveLocationString).toHaveBeenCalledWith('South Korea');
        expect(position.gotoLLA).toHaveBeenCalledWith(36.5, 127.8, 3.048, true);
        expect(goToLatLon).toHaveBeenCalledWith(36.5, 127.8, undefined, undefined, 0);
        if (text.includes('2025')) expect(GlobalDateTimeNode.editTime).toHaveBeenCalledWith(new Date('2025-08-30T11:09:00Z'));
        else expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    });

test('a geolocated starting camera still follows text locations', async () => {
    const {position} = initialLookCamera();
    withInitialCameraPlacement(position, () => position.gotoLLA(51, 1, 3, true));
    position.gotoLLA.mockClear();
    await applyGoToString('South Korea');
    expect(position.gotoLLA).toHaveBeenCalledWith(36.5, 127.8, 3.048, true);
    resolveLocationString.mockResolvedValueOnce({lat: 35.7, lon: 139.7});
    await applyGoToString('Tokyo');
    expect(position.gotoLLA).toHaveBeenLastCalledWith(35.7, 139.7, 3.048, true);
});

test('an independently placed camera stays put while the overview and destination time update', async () => {
    const {position} = initialLookCamera();
    position.gotoLLA(40, -80, 100, false);
    position.gotoLLA.mockClear();
    await applyGoToString('South Korea, August 30, 2025, 8:09 PM');
    expect(position.gotoLLA).not.toHaveBeenCalled();
    expect(position._LLA).toEqual([40, -80, 100]);
    expect(goToLatLon).toHaveBeenCalled();
    expect(GlobalDateTimeNode.editTime).toHaveBeenCalledWith(new Date('2025-08-30T11:09:00Z'));
});

test('a camera moved while geocoding is in flight is preserved', async () => {
    const {position} = initialLookCamera();
    let finish;
    resolveLocationString.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const request = applyGoToString('South Korea');
    position.gotoLLA(40, -80, 100, false);
    position.gotoLLA.mockClear();
    finish({lat: 36.5, lon: 127.8});
    await request;
    expect(position.gotoLLA).not.toHaveBeenCalled();
});

test('explicit coordinate altitude wins over the default ground clearance', async () => {
    const {position} = initialLookCamera();
    resolveLocationString.mockResolvedValueOnce({lat: 40, lon: -74, alt: 300, isCoordinate: true});
    await applyGoToString('40, -74, 300');
    expect(position.gotoLLA).toHaveBeenCalledWith(40, -74, 300, false);
});

test('Go To places one pin with the requested name', async () => {
    resolveLocationString.mockResolvedValueOnce({lat: 51.5, lon: -0.12, isCoordinate: false});
    expect(await applyGoToString('  London  ')).toBe(true);
    expect(goToLatLon).toHaveBeenCalledWith(51.5, -0.12, undefined, undefined, 0);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledTimes(1);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith(expect.objectContaining({lat: 51.5, lon: -0.12, name: 'London'}));
});

test('an observer destination shares place/date/zone parsing without moving the main camera', async () => {
    resolveLocationString.mockResolvedValueOnce({lat: 53.84, lon: -1.83});
    const moveToLocation = jest.fn();
    const result = await executeGoToRequest(parseGoToString('Bingley June 10 6PM'), {moveToLocation, isCurrent: () => true});
    expect(result.success).toBe(true);
    expect(moveToLocation).toHaveBeenCalledWith({lat: 53.84, lon: -1.83});
    expect(goToLatLon).not.toHaveBeenCalled();
    expect(GlobalDateTimeNode.editTime.mock.calls[0][0].toISOString()).toBe('2025-06-10T17:00:00.000Z');
    expect(FeatureManager.addLocationPin.mock.calls[0][0].name).toBe('Bingley');
});

test('a manual observer edit cancels a pending place lookup before any time or position changes', async () => {
    resolveLocationString.mockResolvedValueOnce({lat: 53.84, lon: -1.83});
    const moveToLocation = jest.fn();
    await executeGoToRequest(parseGoToString('Bingley 6PM'), {moveToLocation, isCurrent: () => false});
    expect(moveToLocation).not.toHaveBeenCalled();
    expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    expect(FeatureManager.addLocationPin).not.toHaveBeenCalled();
});

test('a coordinate with an altitude pins that point', async () => {
    resolveLocationString.mockResolvedValueOnce({lat: 40, lon: -74, alt: 300, isCoordinate: true});
    await applyGoToString('40, -74, 300');
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith(expect.objectContaining({lat: 40, lon: -74, alt: 300, name: '40, -74, 300'}));
});

test('failed location lookups do not create pins', async () => {
    resolveLocationString.mockResolvedValueOnce(null);
    expect(await applyGoToString('Unknown place')).toBe(false);
    expect(FeatureManager.addLocationPin).not.toHaveBeenCalled();
});

test('a superseded lookup neither navigates nor leaves a stray pin', async () => {
    let finishFirst;
    resolveLocationString.mockImplementationOnce(() => new Promise(resolve => {finishFirst = resolve;}));
    const first = applyGoToString('London');
    // Let the first request pass its TLE check and start looking up the place.
    await Promise.resolve();
    resolveLocationString.mockResolvedValueOnce({lat: 48.86, lon: 2.35});
    await applyGoToString('Paris');
    finishFirst({lat: 51.5, lon: -0.12});
    await first;
    expect(goToLatLon).toHaveBeenCalledTimes(1);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledTimes(1);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith({lat: 48.86, lon: 2.35, name: 'Paris'});
});

test('frame and time navigation do not create location pins', async () => {
    await applyGoToString('25');
    applyDateTimeString.mockReturnValueOnce(true);
    await applyGoToString('12pm');
    expect(resolveLocationString).not.toHaveBeenCalled();
    expect(FeatureManager.addLocationPin).not.toHaveBeenCalled();
});

test.each([
    ['Bingley, 10AM', '2025-09-19T09:00:00.000Z'],
    ['Bingley, January 6, 2027, 10am', '2027-01-06T10:00:00.000Z'],
    ['Bingley, 10am UTC', '2025-09-19T10:00:00.000Z'],
    ['Bingley, 10:00+05:45', '2025-09-20T04:15:00.000Z'],
])('%s sets destination local time and pins only the place', async (text, iso) => {
    resolveLocationString.mockResolvedValueOnce({lat: 53.85, lon: -1.84});
    expect(await applyGoToString(text)).toBe(true);
    expect(resolveLocationString).toHaveBeenCalledWith('Bingley');
    expect(GlobalDateTimeNode.editTime).toHaveBeenCalledWith(new Date(iso));
    expect(GlobalDateTimeNode.setTimeZoneFromZone).toHaveBeenCalledWith('Europe/London', new Date(iso));
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith({lat: 53.85, lon: -1.84, name: 'Bingley'});
});

test.each([
    ['2025-01-15T12:00:00Z', 'Bingley jun 10, 6PM', '2025-06-10T17:00:00Z', 1],
    ['2025-01-15T12:00:00Z', 'Bingley jun 10 6PM', '2025-06-10T17:00:00Z', 1],
    ['2025-06-15T12:00:00Z', 'Bingley jan 10 6PM', '2025-01-10T18:00:00Z', 0],
    ['2025-01-15T12:00:00Z', '12PM Bingley', '2025-01-15T12:00:00Z', 0],
    ['2025-01-15T12:00:00Z', 'Bingley 12PM', '2025-01-15T12:00:00Z', 0],
    ['2025-01-15T12:00:00Z', 'June 10 Bingley 6PM', '2025-06-10T17:00:00Z', 1],
    ['2025-01-15T12:00:00Z', '6PM Bingley June 10', '2025-06-10T17:00:00Z', 1],
])('selects the destination date timezone before applying the time: %s / %s', async (start, text, iso, offset) => {
    GlobalDateTimeNode.dateNow = new Date(start);
    resolveLocationString.mockResolvedValueOnce({lat: 53.85, lon: -1.84});
    expect(await applyGoToString(text)).toBe(true);
    expect(resolveLocationString).toHaveBeenCalledWith('Bingley');
    expect(GlobalDateTimeNode.timeZoneOffset).toBe(offset);
    expect(GlobalDateTimeNode.editTime).toHaveBeenCalledWith(new Date(iso));
    expect(goToLatLon.mock.invocationCallOrder[0]).toBeLessThan(GlobalDateTimeNode.setTimeZoneFromZone.mock.invocationCallOrder[0]);
    expect(GlobalDateTimeNode.setTimeZoneFromZone.mock.invocationCallOrder[0]).toBeLessThan(GlobalDateTimeNode.editTime.mock.invocationCallOrder[0]);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith(expect.objectContaining({name: 'Bingley'}));
});

test.each([
    ['2025-01-15T12:00:00Z', 0],
    ['2025-06-15T12:00:00Z', 1],
])('a place alone selects its timezone without changing the instant: %s', async (iso, offset) => {
    GlobalDateTimeNode.dateNow = new Date(iso);
    resolveLocationString.mockResolvedValueOnce({lat: 53.85, lon: -1.84});
    expect(await applyGoToString('Bingley')).toBe(true);
    expect(GlobalDateTimeNode.setTimeZoneFromZone).toHaveBeenCalledWith('Europe/London', new Date(iso));
    expect(GlobalDateTimeNode.timeZoneOffset).toBe(offset);
    expect(GlobalDateTimeNode.useTimeZone).toBe(true);
    expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    expect(GlobalDateTimeNode.dateNow.toISOString()).toBe(new Date(iso).toISOString());
});

test('tomorrow uses the real date at the destination', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-15T23:30:00Z'));
    try {
        lookupTimeZone.mockResolvedValueOnce('Asia/Tokyo');
        resolveLocationString.mockResolvedValueOnce({lat: 35.68, lon: 139.69});
        await applyGoToString('Tokyo, tomorrow at 10am');
        expect(GlobalDateTimeNode.editTime).toHaveBeenCalledWith(new Date('2026-11-17T01:00:00Z'));
    } finally { jest.useRealTimers(); }
});

test.each(['Bingley, 2025-02-29 at 10am', 'Bingley, 25:00'])('invalid time does not partially navigate: %s', async text => {
    resolveLocationString.mockResolvedValueOnce({lat: 53.85, lon: -1.84});
    expect(await applyGoToString(text)).toBe(false);
    expect(goToLatLon).not.toHaveBeenCalled();
    expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    expect(FeatureManager.addLocationPin).not.toHaveBeenCalled();
});

test('failed geocoding offers AI without changing the time', async () => {
    resolveLocationString.mockRejectedValueOnce(new Error('lookup unavailable'));
    expect(await executeGoToRequest(parseGoToString('Bingley, 10AM'))).toEqual(expect.objectContaining({success: false, needsLLM: true}));
    expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    expect(goToLatLon).not.toHaveBeenCalled();
});

test.each(['Bingley June 10 sunset', 'sunset Bingley June 10'])('%s resolves the sky event at the destination', async text => {
    resolveLocationString.mockResolvedValueOnce({lat: 53.8479533, lon: -1.8384526});
    expect(await applyGoToString(text)).toBe(true);
    expect(resolveLocationString).toHaveBeenCalledWith('Bingley');
    const date = GlobalDateTimeNode.editTime.mock.calls[0][0];
    expect(Math.abs(date - new Date('2025-06-10T20:37:00Z'))).toBeLessThan(60000);
    expect(GlobalDateTimeNode.timeZoneOffset).toBe(1);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith(expect.objectContaining({name: 'Bingley'}));
});

test('a named time alone uses the current location without moving or creating a pin', async () => {
    GlobalDateTimeNode.dateNow = new Date('2025-06-10T12:00:00Z');
    expect(await applyGoToString('sunset')).toBe(true);
    expect(lookupTimeZone).toHaveBeenCalledWith(53.8479533, -1.8384526);
    expect(GlobalDateTimeNode.editTime).toHaveBeenCalledTimes(1);
    expect(resolveLocationString).not.toHaveBeenCalled();
    expect(goToLatLon).not.toHaveBeenCalled();
    expect(FeatureManager.addLocationPin).not.toHaveBeenCalled();
});

test.each(['Bingley June 10 an hour after sunset', 'an hour after sunset Bingley June 10'])(
    '%s keeps the location name and applies the modifier after the event', async text => {
        resolveLocationString.mockResolvedValueOnce({lat: 53.8479533, lon: -1.8384526});
        expect(await applyGoToString(text)).toBe(true);
        expect(resolveLocationString).toHaveBeenCalledWith('Bingley');
        expect(Math.abs(GlobalDateTimeNode.editTime.mock.calls[0][0] - new Date('2025-06-10T21:37:00Z'))).toBeLessThan(60000);
        expect(FeatureManager.addLocationPin).toHaveBeenCalledWith(expect.objectContaining({name: 'Bingley'}));
    });

test('no sunrise on the requested day does not partially move or change the scene', async () => {
    resolveLocationString.mockResolvedValueOnce({lat: 89, lon: 0});
    const result = await executeGoToRequest(parseGoToString('North Pole June 10 sunrise'));
    expect(result).toEqual(expect.objectContaining({success: false, error: expect.stringContaining('No sunrise')}));
    expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    expect(goToLatLon).not.toHaveBeenCalled();
    expect(FeatureManager.addLocationPin).not.toHaveBeenCalled();
});

test('a superseded timezone lookup cannot change time, camera, or pins', async () => {
    let finishZone;
    lookupTimeZone.mockImplementationOnce(() => new Promise(resolve => {finishZone = resolve;}));
    resolveLocationString.mockResolvedValueOnce({lat: 53.85, lon: -1.84});
    const first = applyGoToString('Bingley, 10AM');
    await Promise.resolve();
    resolveLocationString.mockResolvedValueOnce({lat: 48.86, lon: 2.35});
    await applyGoToString('Paris');
    finishZone('Europe/London');
    await first;
    expect(GlobalDateTimeNode.editTime).not.toHaveBeenCalled();
    expect(goToLatLon).toHaveBeenCalledTimes(1);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledTimes(1);
});
