// The "Track: <name>" wind source of a sounding track reads that one profile by altitude.
//
// A wind field with two sounding profiles loaded: the Track entry of one of them uses that
// profile alone, with no blend with the other, at any altitude. The Manual Soundings
// source, by contrast, blends the two. The Track entry of a track that is not a sounding
// is not read by altitude.

import {setNodeMan} from '../src/Globals';
import {CNodeDisplayWindField} from '../src/nodes/CNodeDisplayWindField';
import {fromDirSpeedToUV} from '../src/nodes/WindHelpers';
import {trackSourceKey} from '../src/nodes/WindSources';

// A sounding profile: wind from `dir` at `speed` m/s below 5 km, and from dir + 40 at
// twice the speed above.
function profile(id, lat, lon, dir, speed) {
    return {
        id, windByAltitude: true, stationLat: lat, stationLon: lon, topWindAlt: 20000,
        evidenceClass: "observation",
        getAtAltitude: altM => altM < 5000
            ? {windDir: dir, windSpeed: speed}
            : {windDir: dir + 40, windSpeed: 2 * speed},
    };
}

const site = profile("atmosphericProfile_wx-site", 34.5, -117.25, 270, 10);
const other = profile("atmosphericProfile_wx-other", 34.6, -117.0, 90, 4);
const telemetry = {id: "atmosphericProfile_N12345", windByAltitude: false};
const nodes = {[site.id]: site, [other.id]: other, [telemetry.id]: telemetry};

beforeAll(() => setNodeMan({
    get: (id) => nodes[id],
    exists: (id) => id in nodes,
    // _gatherSondeProfiles walks the graph for profile nodes by class name.
    iterate: (callback) => {
        for (const node of [site, other]) {
            callback(node.id, Object.assign(Object.create({constructor: {name: "CNodeAtmosphericProfile"}}), node));
        }
    },
    listVersion: 1,
}));
afterAll(() => setNodeMan(undefined));

function windField(source) {
    return Object.assign(Object.create(CNodeDisplayWindField.prototype), {source});
}

const closeTo = (actual, expected) => {
    expect(actual.u).toBeCloseTo(expected.u, 9);
    expect(actual.v).toBeCloseTo(expected.v, 9);
};

test("the Track entry of a sounding track reads that profile alone, at each altitude", () => {
    const field = windField(trackSourceKey("TrackData_wx-site"));
    const set = field._soundingSet();
    expect(set.profiles).toEqual([site]);
    expect(set.label).toBe("wx-site");
    // Near the other station too: there is no blend.
    closeTo(field.sampleWindAtAltitude(34.6, -117.0, 1000), fromDirSpeedToUV(270, 10));
    closeTo(field.sampleWindAtAltitude(34.6, -117.0, 8000), fromDirSpeedToUV(310, 20));
});

test("Manual Soundings blends both profiles at the same point", () => {
    const blended = windField("manual-soundings").sampleWindAtAltitude(34.55, -117.1, 1000);
    const siteOnly = fromDirSpeedToUV(270, 10);
    expect(Math.hypot(blended.u - siteOnly.u, blended.v - siteOnly.v)).toBeGreaterThan(1);
});

test("the Track entry of a track that is not a sounding is not read by altitude", () => {
    const field = windField(trackSourceKey("TrackData_N12345"));
    expect(field._soundingSet()).toBeNull();
});
