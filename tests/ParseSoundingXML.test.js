/**
 * @jest-environment jsdom
 */
import {parseXml} from '../src/parseXml';
import {findSoundingXML, parseSoundingXML, soundingXMLLayoutsFromEnv} from '../src/ParseSoundingXML';
import {CTrackFileSoundingXML} from '../src/TrackFiles/CTrackFileSoundingXML';
import {CTrackFileKML} from '../src/TrackFiles/CTrackFileKML';
import {CTrackFileSTANAG} from '../src/TrackFiles/CTrackFileSTANAG';
import {CTrackFileSonde} from '../src/TrackFiles/CTrackFileSonde';
import {Globals} from '../src/Globals';
import {MISB} from '../src/MISBFields';

// ─── Sample Data ─────────────────────────────────────────────────────────

// Namespace prefixes, value + sense, feet and knots, labelled values that are
// not wanted, and a second data object with its own position before the one
// that holds the profile.
const sampleXML = `<?xml version="1.0"?>
<wx:Report xmlns:wx="urn:example:wx">
  <wx:Issued>2024-03-05T18:00:00</wx:Issued>
  <wx:DataObject>
    <wx:Kind>Reference</wx:Kind>
    <wx:Position>
      <wx:Latitude><wx:Value>10.0</wx:Value><wx:Sense>N</wx:Sense></wx:Latitude>
      <wx:Longitude><wx:Value>20.0</wx:Value><wx:Sense>E</wx:Sense></wx:Longitude>
      <wx:Elevation><wx:Value>0</wx:Value></wx:Elevation>
    </wx:Position>
  </wx:DataObject>
  <wx:DataObject>
    <wx:Kind>Target</wx:Kind>
    <wx:Position>
      <wx:Latitude><wx:Value>34.5</wx:Value><wx:Sense>N</wx:Sense></wx:Latitude>
      <wx:Longitude><wx:Value>117.25</wx:Value><wx:Sense>W</wx:Sense></wx:Longitude>
      <wx:Elevation><wx:Value>1000</wx:Value></wx:Elevation>
    </wx:Position>
    <wx:VerticalProfile>
      <wx:Level>
        <wx:Altitude><wx:Value>1000</wx:Value></wx:Altitude>
        <wx:Pressure><wx:Value>29.92</wx:Value></wx:Pressure>
        <wx:Temperature><wx:Value>59</wx:Value></wx:Temperature>
        <wx:Humidity><wx:Value>40</wx:Value></wx:Humidity>
        <wx:WindDirection><wx:Value>270</wx:Value></wx:WindDirection>
        <wx:WindSpeed><wx:Value>10</wx:Value></wx:WindSpeed>
      </wx:Level>
      <wx:Level>
        <wx:Altitude><wx:Value>10000</wx:Value></wx:Altitude>
        <wx:Pressure><wx:Value>20.58</wx:Value></wx:Pressure>
        <wx:Temperature><wx:Value>23</wx:Value></wx:Temperature>
        <wx:Humidity><wx:Value>20</wx:Value></wx:Humidity>
        <wx:WindDirection><wx:Value>300</wx:Value></wx:WindDirection>
        <wx:WindSpeed><wx:Value>40</wx:Value></wx:WindSpeed>
      </wx:Level>
      <wx:Level>
        <wx:Altitude><wx:Value>30000</wx:Value></wx:Altitude>
        <wx:Pressure><wx:Value>8.89</wx:Value></wx:Pressure>
        <wx:Temperature><wx:Value>-48</wx:Value></wx:Temperature>
        <wx:Humidity><wx:Value>5</wx:Value></wx:Humidity>
        <wx:WindDirection><wx:Value>310</wx:Value></wx:WindDirection>
        <wx:WindSpeed><wx:Value>90</wx:Value></wx:WindSpeed>
      </wx:Level>
    </wx:VerticalProfile>
  </wx:DataObject>
</wx:Report>`;

const sampleEnv = {
    SITREC_CUSTOM_SOUNDING_WX_NAME: "Site Weather",
    SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG: "Level",
    SITREC_CUSTOM_SOUNDING_WX_ALT_TAG: "Altitude",
    SITREC_CUSTOM_SOUNDING_WX_ALT_UNITS: "ft",
    SITREC_CUSTOM_SOUNDING_WX_WIND_DIR_TAG: "WindDirection",
    SITREC_CUSTOM_SOUNDING_WX_WIND_SPEED_TAG: "WindSpeed",
    SITREC_CUSTOM_SOUNDING_WX_WIND_SPEED_UNITS: "kt",
    SITREC_CUSTOM_SOUNDING_WX_PRESSURE_TAG: "Pressure",
    SITREC_CUSTOM_SOUNDING_WX_PRESSURE_UNITS: "inHg",
    SITREC_CUSTOM_SOUNDING_WX_TEMP_TAG: "Temperature",
    SITREC_CUSTOM_SOUNDING_WX_TEMP_UNITS: "F",
    SITREC_CUSTOM_SOUNDING_WX_TIME_TAG: "Issued",
    UNRELATED: "x",
};

const layoutFor = (env) => soundingXMLLayoutsFromEnv(env)[0];

// ─── Layout settings ─────────────────────────────────────────────────────

describe('soundingXMLLayoutsFromEnv', () => {
    test('no settings, no layouts', () => {
        expect(soundingXMLLayoutsFromEnv(undefined)).toEqual([]);
        expect(soundingXMLLayoutsFromEnv({UNRELATED: "x"})).toEqual([]);
    });

    test('reads one layout with defaults for the position tags', () => {
        const layouts = soundingXMLLayoutsFromEnv(sampleEnv);
        expect(layouts).toHaveLength(1);
        expect(layouts[0].name).toBe("WX");
        expect(layouts[0].label).toBe("Site Weather");
        expect(layouts[0].latTag).toEqual(["latitude"]);
        expect(layouts[0].valueTag).toEqual(["value"]);
        expect(layouts[0].altToM).toBeCloseTo(0.3048);
    });

    test('ignores a layout with an unknown unit or a missing wind tag', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(soundingXMLLayoutsFromEnv({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_ALT_UNITS: "furlongs"})).toEqual([]);
        const {SITREC_CUSTOM_SOUNDING_WX_WIND_SPEED_TAG, ...noSpeed} = sampleEnv;
        expect(soundingXMLLayoutsFromEnv(noSpeed)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});

// ─── Parsing ─────────────────────────────────────────────────────────────

describe('parseSoundingXML', () => {
    const sonde = parseSoundingXML(parseXml(sampleXML), layoutFor(sampleEnv));

    test('takes the position nearest the profile, with the sense applied', () => {
        expect(sonde.station.lat).toBeCloseTo(34.5);
        expect(sonde.station.lon).toBeCloseTo(-117.25);
        expect(sonde.station.elev).toBeCloseTo(304.8);
        expect(sonde.station.name).toBe("Site Weather");
    });

    test('converts each level to metres, m/s, hPa and Celsius', () => {
        expect(sonde.levels).toHaveLength(3);
        const top = sonde.levels[2];
        expect(top.height).toBeCloseTo(9144);
        expect(top.windDir).toBe(310);
        expect(top.windSpeed).toBeCloseTo(90 * 0.514444);
        expect(top.pressure).toBeCloseTo(8.89 * 33.8639);
        expect(top.temp).toBeCloseTo((-48 - 32) * 5 / 9);
        expect(sonde.levels[0].pressure).toBeCloseTo(1013.2, 0);
        expect(sonde.levels[0].temp).toBeCloseTo(15);
    });

    test('reads the time as UTC when it has no zone', () => {
        expect(sonde.datetime.toISOString()).toBe("2024-03-05T18:00:00.000Z");
    });

    test('uses the default date when no time tag is set', () => {
        const {SITREC_CUSTOM_SOUNDING_WX_TIME_TAG, ...noTime} = sampleEnv;
        const fallback = new Date(Date.UTC(2020, 0, 2, 3));
        const result = parseSoundingXML(parseXml(sampleXML), layoutFor(noTime), fallback);
        expect(result.datetime).toBe(fallback);
    });

    test('a "to" direction is turned into a "from" direction', () => {
        const layout = layoutFor({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_WIND_DIR_CONVENTION: "to"});
        const result = parseSoundingXML(parseXml(sampleXML), layout);
        expect(result.levels.map(level => level.windDir)).toEqual([90, 120, 130]);
    });

    test('a flight level is read as FL x 30.48 m, and the elevation is then in feet', () => {
        // The sample's levels as FL10, FL100 and FL300.
        const flightLevels = sampleXML
            .replace("<wx:Altitude><wx:Value>1000<", "<wx:Altitude><wx:Value>10<")
            .replace("<wx:Altitude><wx:Value>10000<", "<wx:Altitude><wx:Value>100<")
            .replace("<wx:Altitude><wx:Value>30000<", "<wx:Altitude><wx:Value>300<");
        const layout = layoutFor({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_ALT_UNITS: "FL"});
        expect(layout.altToM).toBe(30.48);
        expect(layout.elevToM).toBe(0.3048);
        const result = parseSoundingXML(parseXml(flightLevels), layout);
        expect(result.levels.map(level => level.height)).toEqual([304.8, 3048, 9144].map(height => expect.closeTo(height, 6)));
        expect(result.station.elev).toBeCloseTo(304.8, 6);
        // A flight level is a unit for the altitude only.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(soundingXMLLayoutsFromEnv({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_ELEV_UNITS: "fl"})).toEqual([]);
        warn.mockRestore();
    });

    test('a profile is a model product unless the layout says the data is measured', () => {
        expect(sonde.measured).toBe(false);
        const measured = layoutFor({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_DATA_KIND: "Measured"});
        expect(parseSoundingXML(parseXml(sampleXML), measured).measured).toBe(true);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(soundingXMLLayoutsFromEnv({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_DATA_KIND: "forecast"})).toEqual([]);
        expect(warn.mock.calls[0][0]).toMatch(/DATA_KIND="forecast" is not one of model, measured/);
        warn.mockRestore();
    });

    test('altitude above ground has the station elevation added', () => {
        const layout = layoutFor({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_ALT_REFERENCE: "agl"});
        const result = parseSoundingXML(parseXml(sampleXML), layout);
        expect(result.levels[0].height).toBeCloseTo(609.6);
    });

    test('plain text values, signed coordinates and a tag path', () => {
        const xml = parseXml(`<Report>
            <Site><Lat>-33.9</Lat><Lon>151.2</Lon><Height>50</Height></Site>
            <Surface><Wind><Speed>99</Speed></Wind></Surface>
            <Column>
              <Row><Alt>50</Alt><Wind><Dir>180</Dir><Speed>5</Speed></Wind><Gust><Speed>77</Speed></Gust></Row>
              <Row><Alt>1500</Alt><Wind><Dir>200</Dir><Speed>12</Speed></Wind><Gust><Speed>77</Speed></Gust></Row>
            </Column>
        </Report>`);
        const layout = layoutFor({
            SITREC_CUSTOM_SOUNDING_B_LEVEL_TAG: "Column/Row",
            SITREC_CUSTOM_SOUNDING_B_ALT_TAG: "Alt",
            SITREC_CUSTOM_SOUNDING_B_WIND_DIR_TAG: "Dir",
            SITREC_CUSTOM_SOUNDING_B_WIND_SPEED_TAG: "Wind/Speed",
            SITREC_CUSTOM_SOUNDING_B_LAT_TAG: "Lat",
            SITREC_CUSTOM_SOUNDING_B_LON_TAG: "Lon",
            SITREC_CUSTOM_SOUNDING_B_ELEV_TAG: "Height",
        });
        const result = parseSoundingXML(xml, layout);
        expect(result.station).toMatchObject({lat: -33.9, lon: 151.2, elev: 50});
        expect(result.levels.map(level => level.windSpeed)).toEqual([5, 12]);
        expect(result.levels.map(level => level.height)).toEqual([50, 1500]);
    });

    test('a longitude given as 0 to 360 is taken to -180 to 180', () => {
        const xml = parseXml(sampleXML.replace("<wx:Value>117.25</wx:Value><wx:Sense>W</wx:Sense>",
            "<wx:Value>242.75</wx:Value>"));
        const result = parseSoundingXML(xml, layoutFor(sampleEnv));
        expect(result.station.lon).toBeCloseTo(-117.25, 9);
    });

    test('position tags given as paths find the longitude and elevation beside the latitude', () => {
        const xml = parseXml(`<Report>
            <Other><Lat>1</Lat><Lon>2</Lon><Height>3</Height></Other>
            <Column>
              <Site><Lat>-33.9</Lat><Lon>151.2</Lon><Height>50</Height></Site>
              <Row><Alt>50</Alt><Dir>180</Dir><Speed>5</Speed></Row>
              <Row><Alt>1500</Alt><Dir>200</Dir><Speed>12</Speed></Row>
            </Column>
        </Report>`);
        const layout = layoutFor({
            SITREC_CUSTOM_SOUNDING_B_LEVEL_TAG: "Row",
            SITREC_CUSTOM_SOUNDING_B_ALT_TAG: "Alt",
            SITREC_CUSTOM_SOUNDING_B_WIND_DIR_TAG: "Dir",
            SITREC_CUSTOM_SOUNDING_B_WIND_SPEED_TAG: "Speed",
            SITREC_CUSTOM_SOUNDING_B_LAT_TAG: "Site/Lat",
            SITREC_CUSTOM_SOUNDING_B_LON_TAG: "Site/Lon",
            SITREC_CUSTOM_SOUNDING_B_ELEV_TAG: "Site/Height",
        });
        expect(parseSoundingXML(xml, layout).station).toMatchObject({lat: -33.9, lon: 151.2, elev: 50});
    });

    test('the longitude and elevation beside the latitude win over nested ones of the same name', () => {
        // <Survey> comes first in the file and holds its own Longitude and Elevation.
        const xml = parseXml(`<Report>
            <Site>
              <Survey><Longitude>99</Longitude><Elevation>999</Elevation></Survey>
              <Latitude>10</Latitude><Longitude>20</Longitude><Elevation>30</Elevation>
            </Site>
            <Level><Altitude>1</Altitude><WindDirection>1</WindDirection><WindSpeed>1</WindSpeed></Level>
            <Level><Altitude>2</Altitude><WindDirection>1</WindDirection><WindSpeed>1</WindSpeed></Level>
        </Report>`);
        const plain = {
            SITREC_CUSTOM_SOUNDING_B_LEVEL_TAG: "Level",
            SITREC_CUSTOM_SOUNDING_B_ALT_TAG: "Altitude",
            SITREC_CUSTOM_SOUNDING_B_WIND_DIR_TAG: "WindDirection",
            SITREC_CUSTOM_SOUNDING_B_WIND_SPEED_TAG: "WindSpeed",
        };
        expect(parseSoundingXML(xml, layoutFor(plain)).station).toMatchObject({lat: 10, lon: 20, elev: 30});
        const withPaths = layoutFor({
            ...plain,
            SITREC_CUSTOM_SOUNDING_B_LAT_TAG: "Site/Latitude",
            SITREC_CUSTOM_SOUNDING_B_LON_TAG: "Site/Longitude",
            SITREC_CUSTOM_SOUNDING_B_ELEV_TAG: "Site/Elevation",
        });
        expect(parseSoundingXML(xml, withPaths).station).toMatchObject({lat: 10, lon: 20, elev: 30});
    });

    test('a file that does not fit the layout gives null', () => {
        const layout = layoutFor(sampleEnv);
        expect(parseSoundingXML(parseXml(`<a><b>1</b></a>`), layout)).toBeNull();
        // levels but no position
        expect(parseSoundingXML(parseXml(`<a>
            <Level><Altitude>1</Altitude><WindDirection>1</WindDirection><WindSpeed>1</WindSpeed></Level>
            <Level><Altitude>2</Altitude><WindDirection>1</WindDirection><WindSpeed>1</WindSpeed></Level>
        </a>`), layout)).toBeNull();
    });

    test('findSoundingXML uses the first unidentified layout that fits', () => {
        const layouts = soundingXMLLayoutsFromEnv({
            SITREC_CUSTOM_SOUNDING_OTHER_LEVEL_TAG: "Stratum",
            SITREC_CUSTOM_SOUNDING_OTHER_ALT_TAG: "Altitude",
            SITREC_CUSTOM_SOUNDING_OTHER_WIND_DIR_TAG: "WindDirection",
            SITREC_CUSTOM_SOUNDING_OTHER_WIND_SPEED_TAG: "WindSpeed",
            ...sampleEnv,
        });
        expect(layouts).toHaveLength(2);
        expect(findSoundingXML(parseXml(sampleXML), layouts).station.id).toBe("WX");
    });
});

// ─── Identifying the layout ──────────────────────────────────────────────

describe('findSoundingXML with identifying substrings', () => {
    // Two layouts that both fit the sample file's structure, told apart only by
    // what identifies them. ALT_UNITS differs so the result shows which was used.
    const twoLayouts = (identityA, identityB) => soundingXMLLayoutsFromEnv({
        ...Object.fromEntries(Object.entries(sampleEnv).map(([key, value]) => [key.replace("_WX_", "_A_"), value])),
        SITREC_CUSTOM_SOUNDING_A_ALT_UNITS: "m",
        ...identityA,
        ...sampleEnv,
        ...identityB,
    });
    const topHeight = (layouts, text = sampleXML) => findSoundingXML(parseXml(text), layouts, undefined, text)?.levels[2].height;

    test('reads the comma-separated lists', () => {
        const layout = layoutFor({
            ...sampleEnv,
            SITREC_CUSTOM_SOUNDING_WX_XMLNS_CONTAINS: " urn:example:wx , weather.example/v2,",
            SITREC_CUSTOM_SOUNDING_WX_FILE_CONTAINS: "SITE-WX",
        });
        expect(layout.xmlnsContains).toEqual(["urn:example:wx", "weather.example/v2"]);
        expect(layout.fileContains).toEqual(["SITE-WX"]);
        expect(layoutFor(sampleEnv).xmlnsContains).toEqual([]);
    });

    test('any one substring in a namespace declaration selects the layout', () => {
        const layouts = twoLayouts(
            {SITREC_CUSTOM_SOUNDING_A_XMLNS_CONTAINS: "urn:other:format"},
            {SITREC_CUSTOM_SOUNDING_WX_XMLNS_CONTAINS: "no-such-thing,example:wx"});
        expect(topHeight(layouts)).toBeCloseTo(9144);       // WX: feet
    });

    test('a substring anywhere in the file text selects the layout', () => {
        const layouts = twoLayouts(
            {SITREC_CUSTOM_SOUNDING_A_FILE_CONTAINS: "generator: site-a"},
            {SITREC_CUSTOM_SOUNDING_WX_FILE_CONTAINS: "generator: site-b"});
        // In a comment, which parseXml() drops: only the raw text has it.
        const withComment = sampleXML.replace("<wx:Report", "<!-- generator: site-a -->\n<wx:Report");
        expect(topHeight(layouts, withComment)).toBeCloseTo(30000);    // A: metres
    });

    test('a layout with identifying substrings is not used for a file without them', () => {
        const layouts = soundingXMLLayoutsFromEnv({...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_XMLNS_CONTAINS: "urn:other:format"});
        expect(findSoundingXML(parseXml(sampleXML), layouts, undefined, sampleXML)).toBeNull();
    });

    test('an identified layout wins over one that only fits, whatever the order', () => {
        const layouts = twoLayouts({}, {SITREC_CUSTOM_SOUNDING_WX_XMLNS_CONTAINS: "urn:example:wx"});
        expect(layouts[0].name).toBe("A");
        expect(topHeight(layouts)).toBeCloseTo(9144);       // WX, though A is first and fits
    });

    test('an identified file that the layout cannot read is reported, and no other layout is tried', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const layouts = twoLayouts(
            {SITREC_CUSTOM_SOUNDING_A_XMLNS_CONTAINS: "urn:example:wx", SITREC_CUSTOM_SOUNDING_A_LEVEL_TAG: "Stratum"},
            {});
        expect(findSoundingXML(parseXml(sampleXML), layouts, undefined, sampleXML)).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('"A"');
        warn.mockRestore();
    });
});

// ─── Track file ──────────────────────────────────────────────────────────

describe('CTrackFileSoundingXML', () => {
    const savedEnv = Globals.env;
    afterEach(() => { Globals.env = savedEnv; });

    test('matches nothing when no layout is configured', () => {
        Globals.env = {};
        expect(CTrackFileSoundingXML.canHandle('wx.xml', parseXml(sampleXML))).toBe(false);
    });

    test('handles a matching .xml file and no other handler does', () => {
        Globals.env = sampleEnv;
        const parsed = parseXml(sampleXML);
        expect(CTrackFileSoundingXML.canHandle('wx.xml', parsed)).toBe(true);
        expect(CTrackFileSoundingXML.canHandle('wx.json', parseXml(sampleXML))).toBe(false);
        expect(CTrackFileKML.canHandle('wx.xml', parsed)).toBe(false);
        expect(CTrackFileSTANAG.canHandle('wx.xml', parsed)).toBe(false);
        expect(CTrackFileSonde.canHandle('wx.xml', parsed)).toBe(false);
    });

    test('is given the file text, for a layout identified by a string in the file', () => {
        Globals.env = {...sampleEnv, SITREC_CUSTOM_SOUNDING_WX_FILE_CONTAINS: "<wx:VerticalProfile>"};
        expect(CTrackFileSoundingXML.canHandle('wx.xml', parseXml(sampleXML))).toBe(false);
        expect(CTrackFileSoundingXML.canHandle('wx.xml', parseXml(sampleXML), sampleXML)).toBe(true);
        expect(new CTrackFileSoundingXML(parseXml(sampleXML), sampleXML).doesContainTrack()).toBe(true);
    });

    test('becomes a sonde track with wind in MISB rows', () => {
        Globals.env = sampleEnv;
        const trackFile = new CTrackFileSoundingXML(parseXml(sampleXML));
        expect(trackFile.isSondeTrack()).toBe(true);
        expect(trackFile.doesContainTrack()).toBe(true);
        expect(trackFile.getSondeData(0).source).toBe("xml");
        expect(trackFile.getShortName(0, "wx-today.xml")).toBe("wx-today");

        const misb = trackFile.toMISB(0);
        expect(misb).toHaveLength(3);
        expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(34.5);
        expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-117.25);
        expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(304.8);
        expect(misb[2][MISB.WindDirection]).toBe(310);
        expect(misb[2][MISB.WindSpeed]).toBeCloseTo(90 * 0.514444);
    });
});
