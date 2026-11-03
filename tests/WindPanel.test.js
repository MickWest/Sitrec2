// The Wind panel says what its numbers are (2026-11-03, wind plan phase 3):
// one speed unit (Units, or knots with Wind in Knots), heights as numbers, a
// Status line that gives the source, the data time, the distance to the data and
// the heights it covers, readout boxes that do not cover each other or a menu,
// the menu name of a Track source, and a profile with no time that keeps to the
// sitch start.

import {setGlobalDateTimeNode, setNodeMan, setUnits} from "../src/Globals";
import {CNodeDisplayWindField} from "../src/nodes/CNodeDisplayWindField";
import {CNodeAtmosphericProfile} from "../src/nodes/CNodeAtmosphericProfile";
import {CNodeWind} from "../src/nodes/CNodeWind";
import {
    dataTimeText,
    gridColumnBracket,
    heightText,
    placeReadoutBoxes,
    windHeightUnit,
    windSpeedText,
    windSpeedUnit,
} from "../src/nodes/WindHelpers";
import {trackSourceKey, windSourceShortLabel} from "../src/nodes/WindSources";
import {MISB} from "../src/MISBFields";

// The parts of CUnits that the wind panel reads.
const FEET = {abbrev: "ft", toM: 0.3048};
const UNITS = {
    nautical: {units: "nautical", speed: {abbrev: "kt", toM: 1852 / 3600}, small: FEET},
    imperial: {units: "imperial", speed: {abbrev: "mph", toM: 1609.344 / 3600}, small: FEET},
    metric: {units: "metric", speed: {abbrev: "km/h", toM: 1000 / 3600}, small: {abbrev: "m", toM: 1}},
    feet: {units: "feet", speed: {abbrev: "fph", toM: 0.3048 / 3600}, small: FEET},
};

describe("one speed unit on the Wind panel", () => {
    test("Units gives the unit; Wind in Knots and Feet only give knots", () => {
        expect(windSpeedUnit(UNITS.nautical)).toEqual({abbrev: "kt", fromKnots: 1});
        expect(windSpeedUnit(UNITS.imperial).abbrev).toBe("mph");
        expect(windSpeedUnit(UNITS.imperial).fromKnots).toBeCloseTo(1.150779, 6);
        expect(windSpeedUnit(UNITS.metric).fromKnots).toBeCloseTo(1.852, 9);
        expect(windSpeedUnit(UNITS.imperial, true)).toEqual({abbrev: "kt", fromKnots: 1});
        expect(windSpeedUnit(UNITS.feet)).toEqual({abbrev: "kt", fromKnots: 1});
        expect(windSpeedUnit(null)).toEqual({abbrev: "kt", fromKnots: 1});
    });

    test("a speed in knots, as text in the unit", () => {
        expect(windSpeedText(10, windSpeedUnit(UNITS.metric))).toBe("19 km/h");
        expect(windSpeedText(NaN, windSpeedUnit(UNITS.metric))).toBe("–");
    });

    test("the Target Wind speed row shows the unit and keeps knots", () => {
        setUnits(UNITS.imperial);
        setNodeMan({get: () => undefined, exists: () => false});
        try {
            const node = Object.assign(Object.create(CNodeWind.prototype), {knots: 10});
            expect(node.speedInUnit).toBeCloseTo(11.50779, 4);
            node.speedInUnit = 23.01558;
            expect(node.knots).toBeCloseTo(20, 4);
        } finally {
            setUnits(undefined);
            setNodeMan(undefined);
        }
    });
});

describe("heights and times as numbers", () => {
    test("a low height is a number, not \"Surface\"", () => {
        expect(heightText(10)).toBe("33 ft");
        expect(heightText(0)).toBe("0 ft");
    });

    test("heights follow the height unit of Units; Wind in Knots does not change them", () => {
        expect(windHeightUnit(UNITS.nautical)).toEqual(FEET);
        expect(windHeightUnit(UNITS.imperial)).toEqual(FEET);
        expect(windHeightUnit(UNITS.feet)).toEqual(FEET);
        expect(windHeightUnit(UNITS.metric)).toEqual({abbrev: "m", toM: 1});
        expect(windHeightUnit(null)).toEqual(FEET);
        expect(heightText(9144, windHeightUnit(UNITS.metric))).toBe("9,144 m");
        expect(heightText(9144, windHeightUnit(UNITS.imperial))).toBe("30,000 ft");
    });

    test("a data time on the hour, and one between hours", () => {
        expect(dataTimeText(Date.UTC(2025, 8, 19, 12))).toBe("2025-09-19 12Z");
        expect(dataTimeText(Date.UTC(2025, 8, 19, 12, 34))).toBe("2025-09-19 12:34Z");
        expect(dataTimeText(null)).toBeNull();
    });

    test("a held grid value gives the height it is held from", () => {
        expect(gridColumnBracket(40000, 0).limitM).toBeCloseTo(101000 * 0.3048, 6);
        expect(gridColumnBracket(1605, 1600).limitM).toBe(1610);
        expect(gridColumnBracket(5000, 0).limitM).toBeUndefined();
    });
});

describe("readout boxes", () => {
    const W = 1000, H = 800;

    test("two readouts at one place do not cover each other", () => {
        const items = [{anchor: {x: 400, y: 300}, w: 120, h: 60}, {anchor: {x: 405, y: 305}, w: 120, h: 60}];
        const [a, b] = placeReadoutBoxes(items, [], W, H);
        const overlapX = Math.min(a.left + 120, b.left + 120) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.top + 60, b.top + 60) - Math.max(a.top, b.top);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
    });

    test("a readout goes to a corner that a menu does not cover", () => {
        // A menu to the right of and under the anchor.
        const menu = {left: 410, top: 300, right: 700, bottom: 800};
        const [spot] = placeReadoutBoxes([{anchor: {x: 400, y: 300}, w: 120, h: 60}], [menu], W, H);
        expect(spot.left + 120 <= menu.left || spot.top + 60 <= menu.top).toBe(true);
    });

    test("at the right edge of the screen, the readout goes to the left of its point", () => {
        const [spot] = placeReadoutBoxes([{anchor: {x: 980, y: 300}, w: 120, h: 60}], [], W, H);
        expect(spot.left + 120).toBeLessThanOrEqual(980);
    });
});

describe("the source as the menus name it", () => {
    test("a Track entry shows the track's name, not the internal key", () => {
        expect(windSourceShortLabel(trackSourceKey("TrackData_wx-probe"))).toBe("Track: wx-probe");
        expect(windSourceShortLabel("gfs")).toBe("GFS");
    });
});

describe("the Status line", () => {
    // Three soundings, launched at 12Z, the nearest at the target.
    const launch = Date.UTC(2025, 8, 19, 12);
    const sounding = (id, lat, lon, bottom, top) => ({
        id, stationLat: lat, stationLon: lon, topWindAlt: top, timeFromFile: true,
        bottomWindAlt: () => bottom, launchTimeMs: () => launch,
    });
    const profiles = [sounding("a", 34, -117, 700, 30000), sounding("b", 35, -117, 500, 25000),
        sounding("c", 34, -116, 900, 31000)];

    function field() {
        return Object.assign(Object.create(CNodeDisplayWindField.prototype), {
            source: "uwyo", sourceLocal: "uwyo", sourceSeparate: false,
            _levelCache: {}, _levelQueue: [], _levelQueueActive: 0, _omInFlight: new Map(),
            _soundingSet: (key) => key === "uwyo" ? {profiles, label: "UWYO"} : null,
            _anchorLatLon: (anchor) => anchor === "target" ? {lat: 34.1, lon: -117} : null,
        });
    }

    test("it gives the source, the count, the launch, the distance and the heights", () => {
        const text = field().provenanceText();
        expect(text).toMatch(/^UWYO: 3 soundings, nearest launched 2025-09-19 12Z\./);
        expect(text).toMatch(/ 11 km from the target\./);
        expect(text).toContain(`Wind data ${heightText(500)} to ${heightText(31000)}.`);
        expect(text).not.toMatch(/Surface|\(3\)/);
    });

    test("with Metric units, the heights are in metres", () => {
        setUnits(UNITS.metric);
        try {
            expect(field().provenanceText()).toContain("Wind data 500 m to 31,000 m.");
        } finally {
            setUnits(undefined);
        }
    });

    test("a profile with no time says that it uses the sitch start", () => {
        const wf = field();
        const xml = {...sounding("x", 34, -117, 10, 9000), timeFromFile: false};
        wf._soundingSet = () => ({profiles: [xml], label: "x"});
        setNodeMan({get: (id) => id === "atmosphericProfile_x" ? {...xml, windByAltitude: true} : undefined});
        try {
            const facts = wf.sourceFacts(trackSourceKey("TrackData_x"), 34, -117);
            expect(facts.kind).toBe("profile");
            expect(facts.timeNote).toBe("no time in the file: the sitch start");
            expect(wf._factsLine(facts, "target")).toMatch(
                /^Track: x: one profile, 2025-09-19 12Z \(no time in the file: the sitch start\)\. 0 km from the target\./);
        } finally {
            setNodeMan(undefined);
        }
    });
});

describe("a profile with no time keeps to the sitch start", () => {
    test("when the start changes, every row of the track moves by the change", () => {
        const t0 = Date.UTC(2025, 8, 19, 12);
        const row = (ms) => {
            const r = [];
            r[MISB.UnixTimeStamp] = ms;
            return r;
        };
        const dataTrack = {misb: [row(t0), row(t0 + 60000)], recalculateCascade: jest.fn()};
        const profile = Object.assign(Object.create(CNodeAtmosphericProfile.prototype), {
            timeFromFile: false, inputs: {dataTrack}, frames: 0,
        });
        // The sitch start is now one hour later.
        setGlobalDateTimeNode({frameToDate: () => new Date(t0 + 3600000)});
        try {
            profile.update(0);
            expect(dataTrack.misb.map(r => r[MISB.UnixTimeStamp])).toEqual([t0 + 3600000, t0 + 3660000]);
            expect(dataTrack.recalculateCascade).toHaveBeenCalledTimes(1);
            // Nothing more to do at the next frame.
            profile.update(1);
            expect(dataTrack.recalculateCascade).toHaveBeenCalledTimes(1);
            // A profile with its own time does not move.
            profile.timeFromFile = true;
            setGlobalDateTimeNode({frameToDate: () => new Date(t0)});
            profile.update(2);
            expect(dataTrack.misb[0][MISB.UnixTimeStamp]).toBe(t0 + 3600000);
        } finally {
            setGlobalDateTimeNode(undefined);
        }
    });
});

describe("the lines agree with the readouts", () => {
    // Mick's sitch, 2026-11-03: three UWYO soundings at 10,250 ft that disagree,
    // and the camera between them. The readout (the blend at the point) gave
    // 190° at 8.1 kt; the 5° line grid gave 176° at 6.1 kt there.
    const {fromDirSpeedKnotsToUV, fromUVToDirKnots} = require("../src/nodes/WindHelpers");
    const sample = (lat, lon, from, knots) => ({lat, lon, ...fromDirSpeedKnotsToUV(from, knots)});
    const samples = [sample(34.75, -120.5666, 93, 5.1), sample(32.8333, -117.1166, 205, 15),
        sample(36.0471, -115.1846, 206, 19.6)];
    const camera = {lat: 33.983391566365704, lon: -118.70455339131584};

    test("the 1° line grid at the camera is within 2° and 0.5 kt of the point blend", () => {
        const wf = Object.assign(Object.create(CNodeDisplayWindField.prototype), {coverageLengthDeg: 5, windAltFt: 10250});
        const started = performance.now();
        wf._buildGridFromSamples(samples, "UWYO");
        const ms = performance.now() - started;
        const point = wf._blendSoundingProfiles(samples.map((s, i) => ({
            id: `p${i}`, stationLat: s.lat, stationLon: s.lon, topWindAlt: null,
            windAtAltitude: () => {
                const w = fromUVToDirKnots(s.u, s.v);
                return {windDir: w.from, windSpeed: w.knots * 1852 / 3600};
            },
        })), camera.lat, camera.lon, 3124);
        const exact = fromUVToDirKnots(point.u, point.v);
        const grid = fromUVToDirKnots(...Object.values(wf.sampleWind(camera.lat, camera.lon)));
        expect(Math.round(exact.from)).toBe(190);
        expect(Math.abs(grid.from - exact.from)).toBeLessThan(2);
        expect(Math.abs(grid.knots - exact.knots)).toBeLessThan(0.5);
        expect([wf.gridNx, wf.gridNy, wf.gridDLon]).toEqual([360, 181, 1]);
        // A build is a few tens of ms at most (it runs on every Altitude step). The limit is
        // loose because GitHub's shared CI runners took 365 to 557 ms (2.185.0 to 2.186.0).
        expect(ms).toBeLessThan(1000);
    });
});
