/**
 * @jest-environment jsdom
 */
// Tests for the XML Wind Profile Analyzer (tools/xml-wind): the heuristics that
// find a position and a vertical wind profile in an XML file of unknown layout,
// and the settings it proposes for Sitrec's configurable sounding reader.

import fs from 'fs';
import path from 'path';
import {parseXml} from '../src/parseXml';
import {xmlToObject} from '../tools/xml-wind/xmlObject.js';
import {analyzeXML, buildReport, checkSettings, parseEnvText, settingsText} from '../tools/xml-wind/analyze.js';
import {parseDecimalCoordinate} from '../tools/xml-wind/soundingLayout.js';
import {findSoundingXML, soundingXMLLayoutsFromEnv} from '../src/ParseSoundingXML';

const sampleText = fs.readFileSync(path.resolve(__dirname, '../tools/xml-wind/sample.xml'), 'utf-8');

const toObject = text => xmlToObject(new DOMParser().parseFromString(text, "text/xml"));
const analyze = text => analyzeXML(toObject(text), text);
const settingValue = (analysis, suffix) =>
    analysis.settings.entries.find(entry => entry.key.endsWith("_" + suffix))?.value;

// No namespaces, no <Value> wrapper, short names, signed coordinates, metres and
// m/s, two <Speed> tags in each row, and the units nowhere in the file.
const plainText = `<Sounding>
  <Site><Name>Example</Name><Lat>-33.9</Lat><Lon>151.2</Lon><HeightMSL>50</HeightMSL></Site>
  <ValidTime>2024-03-05T18:00:00</ValidTime>
  <Column>
    <Row><Hgt>50</Hgt><Pres>1008</Pres><Gust><Speed>9</Speed></Gust><Wind><Dir>180</Dir><Speed>5</Speed></Wind></Row>
    <Row><Hgt>1500</Hgt><Pres>846</Pres><Gust><Speed>19</Speed></Gust><Wind><Dir>200</Dir><Speed>12</Speed></Wind></Row>
    <Row><Hgt>5500</Hgt><Pres>505</Pres><Gust><Speed>29</Speed></Gust><Wind><Dir>250</Dir><Speed>25</Speed></Wind></Row>
  </Column>
</Sounding>`;

describe('xmlToObject', () => {
    test('gives the same object as the parseXml() that Sitrec uses', () => {
        expect(toObject(sampleText)).toEqual(parseXml(sampleText));
        expect(toObject(plainText)).toEqual(parseXml(plainText));
    });
});

describe('parseDecimalCoordinate', () => {
    test('reads a sign or a hemisphere letter', () => {
        expect(parseDecimalCoordinate("34.5")).toBe(34.5);
        expect(parseDecimalCoordinate("-117.25")).toBe(-117.25);
        expect(parseDecimalCoordinate("117.25 W")).toBe(-117.25);
        expect(parseDecimalCoordinate("S 33.9")).toBe(-33.9);
        expect(parseDecimalCoordinate("34 30 00 N")).toBeNull();
        expect(parseDecimalCoordinate("north")).toBeNull();
    });
});

describe('analyzeXML on the sample file', () => {
    const analysis = analyze(sampleText);

    test('finds the namespaces and the value element', () => {
        expect(analysis.root.tag).toBe("wx:Report");
        expect(analysis.namespaces).toContainEqual({prefix: "wx", uri: "http://weather.example.org/schema/profile/2"});
        expect(analysis.valueTag.name).toBe("Value");
    });

    test('finds the vertical profile and what each field is', () => {
        expect(analysis.profile.name).toBe("Level");
        expect(analysis.profile.records).toHaveLength(5);
        expect(analysis.profile.path).toBe("Report/DataObject/VerticalProfile");
        const roles = Object.fromEntries(Object.entries(analysis.profile.roles).map(([role, field]) => [role, field.name]));
        expect(roles).toEqual({
            windDir: "WindDirection", windSpeed: "WindSpeed", pressure: "Pressure",
            temperature: "Temperature", altitude: "Altitude",
        });
        expect(analysis.profile.fields.find(field => field.name === "RelativeHumidity").role).toBeNull();
    });

    test('finds both positions and takes the one beside the profile', () => {
        expect(analysis.positions).toHaveLength(2);
        expect(analysis.position.lat.value).toBeCloseTo(34.5);
        expect(analysis.position.lon.value).toBeCloseTo(-117.25);
        expect(analysis.position.lon.sense).toBe("W");
        expect(analysis.position.elev.value).toBe(2300);
    });

    test('takes the units that the file states', () => {
        expect(analysis.units.altitude).toEqual({unit: "ft", source: "file"});
        expect(analysis.units.windSpeed).toEqual({unit: "kt", source: "file"});
        expect(analysis.units.pressure).toEqual({unit: "hPa", source: "file"});
        expect(analysis.units.temperature).toEqual({unit: "C", source: "file"});
    });

    test('proposes settings that the reader then reads the file with', () => {
        expect(settingValue(analysis, "XMLNS_CONTAINS")).toBe("http://weather.example.org/schema/profile/2");
        expect(settingValue(analysis, "LEVEL_TAG")).toBe("Level");
        expect(settingValue(analysis, "ALT_UNITS")).toBe("ft");
        expect(settingValue(analysis, "LAT_TAG")).toBeUndefined();     // Sitrec's default name

        const {sonde, identified, messages} = analysis.check;
        expect(messages).toEqual([]);
        expect(identified).toBe("REPORT");
        expect(sonde.station.lat).toBeCloseTo(34.5);
        expect(sonde.station.lon).toBeCloseTo(-117.25);
        expect(sonde.levels).toHaveLength(5);
        expect(sonde.levels[2].height).toBeCloseTo(3048);
        expect(sonde.levels[2].windDir).toBe(270);
        expect(sonde.levels[2].windSpeed).toBeCloseTo(40 * 0.514444);
        expect(analysis.notes.some(note => note.startsWith("WARNING"))).toBe(false);
    });

    test('the proposed settings work in Sitrec itself', () => {
        const text = settingsText(analysis.settings, "sample.xml");
        const layouts = soundingXMLLayoutsFromEnv(parseEnvText(text));
        const sonde = findSoundingXML(parseXml(sampleText), layouts, new Date(), sampleText);
        expect(sonde.levels.map(level => Math.round(level.height))).toEqual([701, 1524, 3048, 5486, 9144]);
        expect(sonde.station.elev).toBeCloseTo(2300 * 0.3048);
    });
});

describe('analyzeXML on a plain file with other names', () => {
    const analysis = analyze(plainText);

    test('finds the profile, the fields and the position by their short names', () => {
        expect(analysis.valueTag).toBeNull();
        expect(analysis.profile.name).toBe("Row");
        expect(analysis.profile.roles.altitude.name).toBe("Hgt");
        expect(analysis.profile.roles.pressure.name).toBe("Pres");
        expect(analysis.profile.roles.windDir.name).toBe("Wind/Dir");
        expect(analysis.profile.roles.windSpeed.name).toBe("Wind/Speed");
        expect(analysis.position.lat.value).toBeCloseTo(-33.9);
        expect(analysis.position.elev.node.name).toBe("HeightMSL");
    });

    test('uses a tag path where a bare name would give the wrong element', () => {
        expect(settingValue(analysis, "WIND_SPEED_TAG")).toBe("Wind/Speed");
        expect(settingValue(analysis, "WIND_DIR_TAG")).toBe("Dir");
        expect(settingValue(analysis, "LAT_TAG")).toBe("Lat");
        expect(settingValue(analysis, "ELEV_TAG")).toBe("HeightMSL");
        expect(analysis.check.sonde.levels.map(level => level.windSpeed)).toEqual([5, 12, 25]);
    });

    test('says which units are guesses and which are only defaults', () => {
        expect(analysis.units.pressure.source).toBe("values");
        expect(analysis.units.altitude).toMatchObject({unit: "m", source: "values"});
        expect(analysis.units.windSpeed.source).toBe("default");
        const entry = suffix => analysis.settings.entries.find(item => item.key.endsWith("_" + suffix));
        expect(entry("ALT_UNITS").check).toMatch(/GUESS/);
        expect(entry("WIND_SPEED_UNITS").check).toMatch(/does not state/);
    });

    test('with no namespace, identifies the file by its root element', () => {
        expect(settingValue(analysis, "XMLNS_CONTAINS")).toBeUndefined();
        expect(settingValue(analysis, "FILE_CONTAINS")).toBe("<Sounding");
        expect(analysis.check.identified).toBe("SOUNDING");
    });

    test('infers feet when altitude against pressure fits feet', () => {
        const inFeet = plainText.replace(">50</Hgt>", ">164</Hgt>").replace(">1500</Hgt>", ">4921</Hgt>").replace(">5500</Hgt>", ">18045</Hgt>");
        expect(analyze(inFeet).units.altitude).toMatchObject({unit: "ft", source: "values"});
    });
});

describe('analyzeXML on files without the data', () => {
    test('reports no profile, and proposes nothing', () => {
        const analysis = analyze(`<kml><Document><Placemark><name>a</name><Point><coordinates>1,2,3</coordinates></Point></Placemark>
            <Placemark><name>b</name><Point><coordinates>4,5,6</coordinates></Point></Placemark></Document></kml>`);
        expect(analysis.profile).toBeNull();
        expect(analysis.settings).toBeNull();
        expect(analysis.notes[0]).toMatch(/No vertical wind profile/);
    });

    test('reports a profile with no position', () => {
        const analysis = analyze(plainText.replace(/<Site>.*<\/Site>/, ""));
        expect(analysis.profile.name).toBe("Row");
        expect(analysis.position).toBeNull();
        expect(analysis.notes.some(note => /No position found/.test(note))).toBe(true);
        expect(analysis.check.sonde).toBeNull();
    });

    test('flags a missing-value marker in the wind', () => {
        const analysis = analyze(sampleText.replace("<wx:Value>300</wx:Value></wx:WindDirection>", "<wx:Value>-9999</wx:Value></wx:WindDirection>"));
        expect(analysis.profile.roles.windDir.name).toBe("WindDirection");
        expect(analysis.notes.some(note => /out of range/.test(note))).toBe(true);
    });
});

describe('checkSettings', () => {
    const xml = toObject(sampleText);

    test('reads edited settings, and reports a setting it cannot use', () => {
        const good = settingsText(analyze(sampleText).settings);
        const inMetres = good.replace(/ALT_UNITS=ft/, "ALT_UNITS=m");
        expect(checkSettings(xml, sampleText, inMetres).sonde.levels[2].height).toBe(10000);

        const bad = checkSettings(xml, sampleText, good.replace(/ALT_UNITS=ft/, "ALT_UNITS=furlongs"));
        expect(bad.sonde).toBeNull();
        expect(bad.messages[0]).toMatch(/furlongs/);
    });

    test('says when no layout identifies the file', () => {
        const other = settingsText(analyze(sampleText).settings).replace(/XMLNS_CONTAINS=.*/, "XMLNS_CONTAINS=urn:other");
        const result = checkSettings(xml, sampleText, other);
        expect(result.identified).toBeNull();
        expect(result.messages[0]).toMatch(/No layout identifies this file/);
    });

    test('parseEnvText handles quotes and comments', () => {
        expect(parseEnvText('# note\nA=1\nB="two words"  # why\nC=x # y\n\nD=')).toEqual({A: "1", B: "two words", C: "x", D: ""});
    });
});

describe('buildReport', () => {
    const analysis = analyze(sampleText);

    test('the structure-only report has tag names but no value from the file', () => {
        const report = buildReport(analysis, {includeValues: false, fileName: "secret-name.xml"});
        expect(report).toContain("<Level> x 5");
        expect(report).toContain("WindSpeed: WIND SPEED");
        expect(report).toContain("unit in file: kt");
        expect(report).not.toContain("secret-name");
        for (const value of ["34.5", "117.25", "2300", "30000", "931", "-44.5", "2024-03-05", "Example Weather Office"]) {
            expect(report).not.toContain(value);
        }
    });

    test('the structure-only report says what it holds, and hides a unit string it does not know', () => {
        const odd = analyze(sampleText.replaceAll("<wx:Units>kt</wx:Units>", "<wx:Units>Site 7 anemometer</wx:Units>"));
        const report = buildReport(odd, {includeValues: false});
        expect(report).toContain("namespace addresses and unit names");
        expect(report).not.toContain("anemometer");
        expect(report).toContain("stated, not a unit name this tool knows");
        expect(buildReport(odd, {includeValues: true})).toContain("Site 7 anemometer");
    });

    test('the full report has the values', () => {
        const report = buildReport(analysis, {includeValues: true, fileName: "wx.xml"});
        expect(report).toContain("File: wx.xml");
        expect(report).toContain("2300 to 30000");
        expect(report).toContain("= 34.5");
    });
});
