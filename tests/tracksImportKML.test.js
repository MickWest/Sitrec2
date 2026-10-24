/**
 * @jest-environment jsdom
 */
// Static KML shapes (LineString / Polygon placemarks) must import when a style sets
// only part of a LineStyle or PolyStyle, and every geometry in a MultiGeometry must
// be drawn, not just a lone one.

import {CTrackFileKML} from '../src/TrackFiles/CTrackFileKML';
import {parseXml} from '../src/parseXml';
import {CNodeTrackFromLLAArray} from '../src/nodes/CNodeTrack';
import {CNodeDisplayTrack} from '../src/nodes/CNodeDisplayTrack';
import {Synth3DManager} from '../src/Globals';

jest.mock('../src/nodes/CNodeTrack', () => ({
    CNodeTrackFromLLAArray: jest.fn(() => ({setArray: jest.fn(), recalculateCascade: jest.fn()}))
}));
jest.mock('../src/nodes/CNodeDisplayTrack', () => ({CNodeDisplayTrack: jest.fn()}));
jest.mock('../src/LayerMasks', () => ({MASK_WORLD: 1}));
jest.mock('../src/Globals', () => ({
    CustomManager: {shouldIgnore: () => false, ignore: () => {}},
    NodeMan: {getUniqueID: (name) => name},
    Sit: {allowDashInFlightNumber: false},
    Synth3DManager: {addOverlay: jest.fn()},
    FileManager: {kmzImageMap: {}, list: {}},
    Globals: {validationMode: true},
}));
jest.mock('../src/CFeatureManager', () => ({FeatureManager: {addFeature: jest.fn()}}));

const ring = (lon) => `<outerBoundaryIs><LinearRing><coordinates>
    ${lon},50,0 ${lon + 0.01},50,0 ${lon + 0.01},50.01,0 ${lon},50,0
</coordinates></LinearRing></outerBoundaryIs>`;

function kml(styles, placemarks) {
    return new CTrackFileKML(parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${styles}${placemarks}</Document></kml>`));
}

const displayed = () => CNodeDisplayTrack.mock.calls.map(([v]) => v);

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    CNodeTrackFromLLAArray.mockClear();
    CNodeDisplayTrack.mockClear();
    Synth3DManager.addOverlay.mockClear();
});

afterEach(() => jest.restoreAllMocks());

describe('KML styles without a color', () => {
    // <fill>0</fill> asks for an outline only: no fill, and an invisible fill must not
    // write depth and hide what is behind it.
    test('an outline-only PolyStyle draws no fill', () => {
        const file = kml(
            `<Style id="outline"><LineStyle><color>ff0000ff</color></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>`,
            `<Placemark><name>Zone</name><styleUrl>#outline</styleUrl><Polygon>${ring(-1)}</Polygon></Placemark>`);
        expect(() => file.extractObjects()).not.toThrow();
        expect(displayed()).toHaveLength(1);
        expect(displayed()[0].color).toBe('#ff0000ff');
        expect(displayed()[0].lineOpacity).toBe(1);
        expect(displayed()[0].polyOpacity).toBe(0);
        expect(displayed()[0].depthWrite).toBe(false);
    });

    test('a filled PolyStyle keeps its fill', () => {
        const file = kml(
            `<Style id="filled"><PolyStyle><color>800000ff</color><fill>1</fill></PolyStyle></Style>`,
            `<Placemark><name>Zone</name><styleUrl>#filled</styleUrl><Polygon>${ring(-1)}</Polygon></Placemark>`);
        file.extractObjects();
        expect(displayed()[0].dropColor).toBe('#800000ff');
        expect(displayed()[0].polyOpacity).toBeCloseTo(0x80 / 255, 6);
        expect(displayed()[0].depthWrite).toBe(true);
    });

    test('a PolyStyle with outline 0 draws no wall outline', () => {
        const file = kml(
            `<Style id="nooutline"><PolyStyle><color>800000ff</color><outline>0</outline></PolyStyle></Style>`,
            `<Placemark><name>Zone</name><styleUrl>#nooutline</styleUrl><Polygon>${ring(-1)}</Polygon></Placemark>`);
        file.extractObjects();
        expect(displayed()[0].lineOpacity).toBe(0);
        expect(displayed()[0].polyOpacity).toBeCloseTo(0x80 / 255, 6);
    });

    test('a LineStyle with only a width keeps the default line color', () => {
        const file = kml(
            `<Style id="thin"><LineStyle><width>2</width></LineStyle></Style>`,
            `<Placemark><name>Path</name><styleUrl>#thin</styleUrl><LineString><coordinates>
                -1,50,0 -0.99,50.01,0</coordinates></LineString></Placemark>`);
        expect(() => file.extractObjects()).not.toThrow();
        expect(displayed()).toHaveLength(1);
        expect(displayed()[0].color).toBe('#ffffffff');
    });
});

describe('KML MultiGeometry', () => {
    test('imports every Polygon', () => {
        const file = kml('', `<Placemark><name>Airspace</name><MultiGeometry>
            <Polygon>${ring(-1)}</Polygon><Polygon>${ring(-2)}</Polygon><Polygon>${ring(-3)}</Polygon>
        </MultiGeometry></Placemark>`);
        expect(() => file.extractObjects()).not.toThrow();
        expect(CNodeTrackFromLLAArray).toHaveBeenCalledTimes(3);
        expect(displayed().every(v => v.showCap)).toBe(true);
    });

    test('imports every LineString', () => {
        const file = kml('', `<Placemark><name>Border</name><MultiGeometry>
            <LineString><coordinates>-1,50,0 -0.99,50.01,0</coordinates></LineString>
            <LineString><coordinates>-2,50,0 -1.99,50.01,0</coordinates></LineString>
        </MultiGeometry></Placemark>`);
        file.extractObjects();
        expect(CNodeTrackFromLLAArray).toHaveBeenCalledTimes(2);
        const arrays = CNodeTrackFromLLAArray.mock.results.map(r => r.value.setArray.mock.calls[0][0]);
        expect(arrays.map(a => a[0][1])).toEqual([-1, -2]);
    });

    test('shapes after a MultiGeometry are still imported', () => {
        const file = kml('', `<Placemark><name>Two</name><MultiGeometry>
            <Polygon>${ring(-1)}</Polygon><Polygon>${ring(-2)}</Polygon>
        </MultiGeometry></Placemark>
        <Placemark><name>After</name><Polygon>${ring(-4)}</Polygon></Placemark>`);
        file.extractObjects();
        expect(CNodeTrackFromLLAArray).toHaveBeenCalledTimes(3);
    });

    // A MultiGeometry has no style or name of its own: each part takes its Placemark's.
    test('every part keeps the style of its Placemark', () => {
        const file = kml(
            `<Style id="red"><LineStyle><color>ff0000ff</color></LineStyle><PolyStyle><color>800000ff</color></PolyStyle></Style>`,
            `<Placemark><name>Airspace</name><styleUrl>#red</styleUrl><MultiGeometry>
                <Polygon>${ring(-1)}</Polygon><Polygon>${ring(-2)}</Polygon>
            </MultiGeometry></Placemark>`);
        file.extractObjects();
        expect(displayed()).toHaveLength(2);
        for (const v of displayed()) {
            expect(v.color).toBe('#ff0000ff');
            expect(v.dropColor).toBe('#800000ff');
            expect(v.polyOpacity).toBeCloseTo(0x80 / 255, 6);
        }
    });

    test('parts are named after their Placemark', () => {
        const file = kml('', `<Placemark><name>Airspace</name><MultiGeometry>
            <Polygon>${ring(-1)}</Polygon><Polygon>${ring(-2)}</Polygon><Polygon>${ring(-3)}</Polygon>
        </MultiGeometry></Placemark>`);
        file.extractObjects();
        expect(CNodeTrackFromLLAArray.mock.calls.map(([v]) => v.id)).toEqual(['Airspace', 'Airspace 2', 'Airspace 3']);
        expect(displayed().map(v => v.id)).toEqual(['Airspace-display', 'Airspace 2-display', 'Airspace 3-display']);
    });

    test('parts of an unnamed Placemark still get readable names', () => {
        const file = kml('', `<Placemark><MultiGeometry>
            <LineString><coordinates>-1,50,0 -0.99,50.01,0</coordinates></LineString>
            <LineString><coordinates>-2,50,0 -1.99,50.01,0</coordinates></LineString>
        </MultiGeometry></Placemark>`);
        file.extractObjects();
        expect(CNodeTrackFromLLAArray.mock.calls.map(([v]) => v.id)).toEqual(['KML Shape', 'KML Shape 2']);
    });

    test('imports every GroundOverlay in a Folder', () => {
        const overlay = (n) => `<GroundOverlay><name>Map ${n}</name><Icon><href>map${n}.png</href></Icon>
            <LatLonBox><north>${50 + n}</north><south>${49 + n}</south><east>1</east><west>0</west></LatLonBox></GroundOverlay>`;
        const file = kml('', `<Folder>${overlay(1)}${overlay(2)}</Folder>`);
        file.extractObjects();
        expect(Synth3DManager.addOverlay).toHaveBeenCalledTimes(2);
    });
});
