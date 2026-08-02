// Working out where a set of satellite elements came from, and whether it was
// complete when it was downloaded — both from the data alone.
//
// A saved sitch bakes in the elements but not the request that fetched them.
// The filename carries the date; the query type and the completeness have to be
// recovered from the contents, so that a sitch saved before either was recorded
// can still be refreshed correctly.

import { strict as assert } from "assert";
import { CTLEData, isGPSetIncomplete, GP_QUERY_WINDOW_DAYS } from "../src/TLEUtils";

// Space-Track OMM CSV columns, in the order proxyStarlink.php requests them.
const HEADER = "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,EPOCH,CREATION_DATE,MEAN_MOTION," +
    "ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,BSTAR," +
    "MEAN_MOTION_DOT,MEAN_MOTION_DDOT,OBJECT_TYPE,RCS_SIZE";

// meanMotion is rev/day: >11.25 is the LEO band, <11.26 is SLOW.
function row({name = "STARLINK-1008", norad = 44714, epoch = "2026-07-27T12:00:00",
              created = "2026-07-27T18:00:00", meanMotion = "15.54002605",
              objectType = "PAYLOAD"} = {}) {
    return [`"${name}"`, '"2019-074B"', `"${norad}"`, `"${epoch}"`, `"${created}"`,
        `"${meanMotion}"`, '"0.00050927"', '"53.1497"', '"270.1063"', '"339.2481"',
        '"20.8322"', '"0.00060016118000"', '"0.00039227"', '"0.0000000000000"',
        `"${objectType}"`, '"LARGE"'].join(",");
}

const build = (rows) => new CTLEData([HEADER, ...rows].join("\n"));

describe("inferring which query produced a set", () => {

    // Each query in proxyStarlink.php is defined by filters, and those leave an
    // exact signature — these are read off the query URLs, not guessed.

    it("recognises the Starlink-only query by its names", () => {
        const d = build([
            row({name: "STARLINK-1008", norad: 44714}),
            row({name: "STARLINK-2000", norad: 45000}),
        ]);
        assert.equal(d.inferQueryType(), "STARLINK");
    });

    it("recognises LEO: fast band, payloads only", () => {
        const d = build([
            row({name: "COSMOS 2251", norad: 22675, meanMotion: "14.5"}),
            row({name: "ISS (ZARYA)", norad: 25544, meanMotion: "15.5"}),
        ]);
        assert.equal(d.inferQueryType(), "LEO");
    });

    it("recognises LEOALL: fast band containing debris", () => {
        const d = build([
            row({name: "COSMOS 2251", norad: 22675, meanMotion: "14.5"}),
            row({name: "COSMOS 2251 DEB", norad: 34321, meanMotion: "14.9", objectType: "DEBRIS"}),
        ]);
        assert.equal(d.inferQueryType(), "LEOALL");
    });

    it("recognises SLOW: nothing in the fast band", () => {
        const d = build([
            row({name: "GPS BIIR-2", norad: 24876, meanMotion: "2.005"}),
            row({name: "MOLNIYA 1-91", norad: 25485, meanMotion: "2.01"}),
        ]);
        assert.equal(d.inferQueryType(), "SLOW");
    });

    it("declines to guess when a set spans both bands", () => {
        const d = build([
            row({name: "ISS (ZARYA)", norad: 25544, meanMotion: "15.5"}),
            row({name: "GPS BIIR-2", norad: 24876, meanMotion: "2.005"}),
        ]);
        assert.equal(d.inferQueryType(), "UNKNOWN");
    });

    it("takes the narrower LEO when object types are absent", () => {
        // A legacy TLE bake has no OBJECT_TYPE, so LEO and LEOALL cannot be told
        // apart. Refreshing merges, so the narrower query can only under-repair,
        // whereas the broader one would add debris the user never had.
        const d = new CTLEData(
            "COSMOS 2251\n" +
            "1 22675U 93036A   26201.21370140  .00039227  00000-0  60016-3 0  9999\n" +
            "2 22675  74.0355 270.1063 0005093 339.2481  20.8322 14.35002605369347");
        assert.equal(d.format, "tle");
        assert.equal(d.inferQueryType(), "LEO");
    });

    it("has nothing to infer from an empty set", () => {
        assert.equal(new CTLEData("").inferQueryType(), "UNKNOWN");
    });
});

describe("detecting a set downloaded before publication finished", () => {

    const DATE = new Date("2026-07-27T00:00:00Z");
    // The query asks for epochs across [D, D+2]; a complete set reaches the end.
    const END = "2026-07-28T23:59:48";

    it("accepts a set whose epochs reach the end of the window", () => {
        const d = build([
            row({norad: 44714, epoch: "2026-07-27T00:00:02"}),
            row({norad: 45000, epoch: END}),
        ]);
        assert.equal(isGPSetIncomplete(d, DATE), false);
    });

    it("flags a set cut short partway through the window", () => {
        // Downloaded around D+1: nothing with a later epoch existed yet.
        const d = build([
            row({norad: 44714, epoch: "2026-07-27T00:00:02"}),
            row({norad: 45000, epoch: "2026-07-27T19:30:34"}),
        ]);
        assert.equal(isGPSetIncomplete(d, DATE), true);
    });

    it("flags a same-day download, which is the worst case", () => {
        const d = build([row({norad: 44714, epoch: "2026-07-27T04:16:27"})]);
        assert.equal(isGPSetIncomplete(d, DATE), true);
    });

    it("tolerates a complete set ending slightly short of the boundary", () => {
        // Elements are dense near the end, so a real complete set lands within
        // seconds — but the test must not be so tight that it false-positives.
        const d = build([row({norad: 44714, epoch: "2026-07-28T23:30:00"})]);
        assert.equal(isGPSetIncomplete(d, DATE), false);
    });

    it("works on TLE-format data, which carries no CREATION_DATE", () => {
        // Epoch 26201.21370140 = 2026 day 201.21 = 2026-07-20, far short of a
        // window ending 2026-07-29 — so this is detectably truncated even
        // though the format has no publication timestamps at all.
        const d = new CTLEData(
            "COSMOS 2251\n" +
            "1 22675U 93036A   26201.21370140  .00039227  00000-0  60016-3 0  9999\n" +
            "2 22675  74.0355 270.1063 0005093 339.2481  20.8322 14.35002605369347");
        assert.equal(d.latestCreationDate, undefined);
        assert.equal(isGPSetIncomplete(d, DATE), true);
    });

    it("says nothing about an empty set", () => {
        assert.equal(isGPSetIncomplete(new CTLEData(""), DATE), false);
    });

    it("records the newest publication time when the data has one", () => {
        const d = build([
            row({norad: 44714, created: "2026-07-28T06:00:00"}),
            row({norad: 45000, created: "2026-07-30T04:00:45"}),
        ]);
        assert.equal(d.latestCreationDate.toISOString(), "2026-07-30T04:00:45.000Z");
    });

    it("uses the documented two-day query window", () => {
        assert.equal(GP_QUERY_WINDOW_DAYS, 2);
    });
});
