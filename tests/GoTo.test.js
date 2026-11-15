jest.mock('../src/Globals', () => ({
    GlobalDateTimeNode: {liveMode: false},
    Sit: {aFrame: 0, bFrame: 100},
    setRenderOne: jest.fn(),
}));
jest.mock('../src/par', () => ({par: {frame: 0}}));
jest.mock('../src/nodes/CNodeFrameSlider', () => ({updateFrameSlider: jest.fn()}));
jest.mock('../src/UpdateSitFrames', () => ({lastSitFrame: () => 100}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/TLEPaste', () => ({importPastedTLE: jest.fn(async () => false)}));
jest.mock('../src/DateTimeParser', () => ({applyDateTimeString: jest.fn(() => false)}));
jest.mock('../src/CoordinateInput', () => ({
    goToLatLon: jest.fn(),
    resolveLocationString: jest.fn(),
}));
jest.mock('../src/CFeatureManager', () => ({FeatureManager: {addLocationPin: jest.fn()}}));

import {applyGoToString} from '../src/GoTo';
import {goToLatLon, resolveLocationString} from '../src/CoordinateInput';
import {FeatureManager} from '../src/CFeatureManager';
import {applyDateTimeString} from '../src/DateTimeParser';

beforeEach(() => jest.clearAllMocks());

test('Go To places one pin with the requested name', async () => {
    resolveLocationString.mockResolvedValueOnce({lat: 51.5, lon: -0.12, isCoordinate: false});
    expect(await applyGoToString('  London  ')).toBe(true);
    expect(goToLatLon).toHaveBeenCalledWith(51.5, -0.12, undefined, undefined, 0);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledTimes(1);
    expect(FeatureManager.addLocationPin).toHaveBeenCalledWith(expect.objectContaining({lat: 51.5, lon: -0.12, name: 'London'}));
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
