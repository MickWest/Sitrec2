// The Time Zone list gained Chile, Argentina, Brazil, China, Japan and Korea. Several
// share an offset with a zone already in the list, so this checks that nothing an
// existing sitch or an existing lookup resolves to has moved: the Sit.timeZone prefix
// lookup, the browser-offset lookup, and a saved timeZoneName round trip.
jest.mock("../src/nodes/CNodeViewUI", () => ({forceUpdateUIText: () => {}}));
jest.mock("../src/JetGUI", () => ({updateGUIFrames: () => {}}));
jest.mock("../src/nodes/CNodeFrameSlider", () => ({updateFrameSlider: () => {}}));
jest.mock("../src/showTimingAnalysis", () => ({showTimingAnalysis: () => {}}));

import {CNodeDateTime, timeZoneKeyFromSitTimeZone, timeZoneOffsets} from "../src/nodes/CNodeDateTime";
import {setSit} from "../src/Globals";

// The list as it was before the additions, in its original order.
const OLD_ZONES = [
    ["IDLW UTC-12", -12], ["NT UTC-11", -11], ["HST UTC-10", -10], ["HDT UTC-9", -9],
    ["AKST UTC-9", -9], ["PST UTC-8", -8], ["AKDT UTC-8", -8], ["PDT UTC-7", -7],
    ["MST UTC-7", -7], ["MDT UTC-6", -6], ["CST UTC-6", -6], ["CDT UTC-5", -5],
    ["EST UTC-5", -5], ["EDT UTC-4", -4], ["AST UTC-4", -4], ["ADT UTC-3", -3],
    ["FKST UTC-3", -3], ["GST UTC-2", -2], ["AZOT UTC-1", -1], ["GMT UTC+0", 0],
    ["AZOST UTC+0", 0], ["BST UTC+1", 1], ["CET UTC+1", 1], ["CEST UTC+2", 2],
    ["EET UTC+2", 2], ["EEST UTC+3", 3], ["MSK UTC+3", 3], ["IRST UTC+3.5", 3.5],
    ["SAMT UTC+4", 4], ["AFT UTC+4.5", 4.5], ["YEKT UTC+5", 5], ["IST UTC+5.5", 5.5],
    ["NPT UTC+5.75", 5.75], ["OMST UTC+6", 6], ["MMT UTC+6.5", 6.5], ["KRAT UTC+7", 7],
    ["IRKT UTC+8", 8], ["YAKT UTC+9", 9], ["VLAT UTC+10", 10], ["AEST UTC+10", 10],
    ["ACST UTC+9.5", 9.5], ["ACDT UTC+10.5", 10.5], ["AWST UTC+8", 8], ["NZST UTC+12", 12],
    ["NZDT UTC+13", 13], ["MAGT UTC+11", 11], ["PETT UTC+12", 12], ["LHST UTC+10.5", 10.5],
    ["LHDT UTC+11", 11],
];

const NEW_ZONES = [
    ["CLT UTC-4", -4], ["CLST UTC-3", -3], ["ART UTC-3", -3], ["BRT UTC-3", -3],
    ["BJT UTC+8", 8], ["JST UTC+9", 9], ["KST UTC+9", 9],
];

// The two lookups, applied to the OLD list, give what an existing sitch got before.
function oldSitTimeZoneLookup(name) {
    let match;
    for (const [key] of OLD_ZONES) if (key.startsWith(name)) match = key;
    return match;
}

function oldOffsetLookup(offset) {
    const hit = OLD_ZONES.find(([, value]) => value === offset);
    return hit ? hit[0] : "UTC" + (offset >= 0 ? "+" : "-") + Math.abs(offset).toFixed(2);
}

function nameFromOffset(offset) {
    const node = Object.create(CNodeDateTime.prototype);
    node.setTimeZoneNameFromOffset(offset);
    return node.timeZoneName;
}

test("the new zones are in the list with their offsets", () => {
    for (const [key, offset] of NEW_ZONES) {
        expect(timeZoneOffsets[key]).toBe(offset);
    }
});

test("every existing zone keeps its name and offset", () => {
    for (const [key, offset] of OLD_ZONES) {
        expect(timeZoneOffsets[key]).toBe(offset);
    }
    expect(Object.keys(timeZoneOffsets)).toHaveLength(OLD_ZONES.length + NEW_ZONES.length);
});

test("China is not labelled CST, so a sitch asking for CST still gets US Central", () => {
    expect(Object.keys(timeZoneOffsets).filter(key => key.startsWith("CST"))).toEqual(["CST UTC-6"]);
    expect(timeZoneKeyFromSitTimeZone("CST")).toBe("CST UTC-6");
});

test("Sit.timeZone resolves as before for every existing zone and shipped sitch", () => {
    const names = ["EET", "MST", "PST"]; // data/ariel, data/modelInspector, data/flir1
    for (const [key] of OLD_ZONES) names.push(key, key.split(" ")[0]);
    for (const name of names) {
        expect([name, timeZoneKeyFromSitTimeZone(name)]).toEqual([name, oldSitTimeZoneLookup(name)]);
    }
});

test("Sit.timeZone can name a new zone by its abbreviation", () => {
    for (const [key] of NEW_ZONES) {
        expect(timeZoneKeyFromSitTimeZone(key.split(" ")[0])).toBe(key);
    }
    expect(timeZoneKeyFromSitTimeZone("XYZ")).toBeUndefined();
});

test("an offset (the browser zone) resolves to the same name as before", () => {
    for (let offset = -12; offset <= 14; offset += 0.25) {
        expect([offset, nameFromOffset(offset)]).toEqual([offset, oldOffsetLookup(offset)]);
    }
    expect(nameFromOffset(-4)).toBe("EDT UTC-4");
    expect(nameFromOffset(-3)).toBe("ADT UTC-3");
    expect(nameFromOffset(8)).toBe("IRKT UTC+8");
    expect(nameFromOffset(9)).toBe("YAKT UTC+9");
});

test("a saved zone round-trips, old and new", () => {
    setSit({simSpeed: 1});
    const makeNode = () => {
        const node = Object.create(CNodeDateTime.prototype);
        node.simpleSerials = [];
        node.establishDateTimeDefaults = () => {};
        node.getStartTimeString = () => "2026-04-07T23:28:00.000Z";
        node.populateStartTimeFromUTCString = () => {};
        node.populate = () => {};
        node.update = () => {};
        return node;
    };
    for (const [key, offset] of [...NEW_ZONES, ["AST UTC-4", -4], ["CST UTC-6", -6], ["IRKT UTC+8", 8]]) {
        const saved = makeNode();
        saved.timeZoneName = key;
        const json = JSON.parse(JSON.stringify(saved.modSerialize()));
        expect(json.timeZoneName).toBe(key);

        const loaded = makeNode();
        loaded.modDeserialize(json);
        expect(loaded.getTimeZoneName()).toBe(key);
        expect(loaded.getTimeZoneOffset()).toBe(offset);
    }
});
