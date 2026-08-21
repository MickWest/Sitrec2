// Working out where a set of satellite elements came from, and whether it was
// complete when it was downloaded — both from the data alone.
//
// A saved sitch bakes in the elements but not the request that fetched them.
// The filename carries the date; the query type and the completeness have to be
// recovered from the contents, so that a sitch saved before either was recorded
// can still be refreshed correctly.

import { strict as assert } from "assert";
import { CTLEData, isGPSetIncomplete, GP_QUERY_WINDOW_DAYS } from "../src/TLEUtils";
import { describeShortfall } from "../src/TLERefresh";

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
    // The window is [D, D+2] on whichever field the query filtered on.
    const END = "2026-07-28T23:59:48";

    // The LEO/LEOALL/SLOW queries filter on EPOCH, so epoch coverage is what
    // says whether the download caught everything.
    describe("an EPOCH-filtered query (LEO, LEOALL, SLOW)", () => {

        it("accepts a set whose epochs reach the end of the window", () => {
            const d = build([
                row({norad: 44714, epoch: "2026-07-27T00:00:02"}),
                row({norad: 45000, epoch: END}),
            ]);
            assert.equal(isGPSetIncomplete(d, DATE, "LEO"), false);
        });

        it("flags a set cut short partway through the window", () => {
            // Downloaded around D+1: nothing with a later epoch existed yet.
            const d = build([
                row({norad: 44714, epoch: "2026-07-27T00:00:02"}),
                row({norad: 45000, epoch: "2026-07-27T19:30:34"}),
            ]);
            assert.equal(isGPSetIncomplete(d, DATE, "LEO"), true);
        });

        it("flags a same-day download, which is the worst case", () => {
            const d = build([row({norad: 44714, epoch: "2026-07-27T04:16:27"})]);
            assert.equal(isGPSetIncomplete(d, DATE, "LEOALL"), true);
        });

        it("tolerates a complete set ending slightly short of the boundary", () => {
            // Elements are dense near the end, so a real complete set lands within
            // seconds — but the test must not be so tight that it false-positives.
            const d = build([row({norad: 44714, epoch: "2026-07-28T23:30:00"})]);
            assert.equal(isGPSetIncomplete(d, DATE, "SLOW"), false);
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
            assert.equal(isGPSetIncomplete(d, DATE, "LEO"), true);
        });
    });

    // The Starlink and ALL queries filter on CREATION_DATE, and an element is
    // published AFTER its epoch — so epoch coverage means nothing here, and
    // judging by it flagged complete sets on every load.
    describe("a CREATION_DATE-filtered query (the default Starlink one, and ALL)", () => {

        it("accepts a complete set whose epochs stop short of the window end", () => {
            // The real 2025-09-05 Starlink set, in miniature: fully settled, yet
            // its newest epoch is 2.17 h before the window closed because that
            // is simply the shortest publication lag it contains.
            const d = build([
                row({norad: 44714, epoch: "2026-07-27T00:00:02", created: "2026-07-27T06:12:00"}),
                row({norad: 45000, epoch: "2026-07-28T21:50:05", created: "2026-07-28T23:26:17"}),
            ]);
            assert.equal(isGPSetIncomplete(d, DATE, ""), false);
        });

        it("flags a set whose publication stops partway through the window", () => {
            // Downloaded on the day of the event: everything published later is
            // missing, and no later download can be told apart from this one by
            // epochs alone.
            const d = build([
                row({norad: 44714, epoch: "2026-07-26T18:00:00", created: "2026-07-27T02:00:00"}),
                row({norad: 45000, epoch: "2026-07-27T01:00:00", created: "2026-07-27T04:16:27"}),
            ]);
            assert.equal(isGPSetIncomplete(d, DATE, ""), true);
        });

        it("judges ALL the same way, since it filters on the same field", () => {
            const d = build([row({norad: 44714, created: "2026-07-27T04:16:27"})]);
            assert.equal(isGPSetIncomplete(d, DATE, "ALL"), true);
        });

        it("tolerates the quiet period between the last burst and the boundary", () => {
            // Publication comes in bursts, so a complete set's newest one sits
            // hours short of the window end (measured: 0.56 h, with quiet
            // periods of up to 8.3 h). Flagging those would ask on every load,
            // since refreshing a complete set cannot move its CREATION_DATE.
            const d = build([row({norad: 44714, created: "2026-07-28T16:00:00"})]);
            assert.equal(isGPSetIncomplete(d, DATE, ""), false);
        });

        it("accepts a download 12 h short, which loses no satellites", () => {
            // The tolerance is deliberately wide, and this is the boundary it
            // was set at. A satellite goes missing only when the download
            // precedes the first publication covering it, and the median
            // publication lag is ~7 h: measured on 2025-09-05, a download 12 h
            // before the close held all 8,231 satellites and 32,779 of 32,783
            // element sets. There is no satellite to recover here.
            const d = build([row({norad: 44714, created: "2026-07-28T12:00:00"})]);
            assert.equal(isGPSetIncomplete(d, DATE, ""), false);
        });

        it("flags a download 24 h short, which does lose satellites", () => {
            // The same reconstruction at 24 h: 103 satellites absent outright,
            // any of which could be the one under analysis. This is the case
            // the prompt exists for.
            const d = build([row({norad: 44714, created: "2026-07-28T00:00:00"})]);
            assert.equal(isGPSetIncomplete(d, DATE, ""), true);
        });

        it("falls back to epochs for TLE data, at this query's tolerance", () => {
            // A legacy .tle bake has no publication times, so epochs are all
            // there is — but read against the 12 h tolerance, not the 1 h epoch
            // one, since under this query a complete set's epochs stop short by
            // the trailing publication gap plus its freshest element's own lag
            // (measured 0.56 + 1.61 = 2.17 h). Epoch here is 2026-07-28T21:50,
            // 2.17 h before the window end: complete.
            const d = new CTLEData(
                "STARLINK-1008\n" +
                "1 44714U 19074B   26209.90978272  .00039227  00000-0  60016-3 0  9999\n" +
                "2 44714  53.0355 270.1063 0005093 339.2481  20.8322 15.54002605369347");
            assert.equal(d.latestCreationDate, undefined);
            assert.equal(d.endDate.toISOString().slice(0, 16), "2026-07-28T21:50");
            assert.equal(isGPSetIncomplete(d, DATE, ""), false);
        });

        it("still catches a truncated TLE bake through that fallback", () => {
            // Epoch 26201.21 = 2026-07-20, 8.7 days short — the case the old
            // epoch-only test did catch, and which must keep being caught.
            const d = new CTLEData(
                "STARLINK-1008\n" +
                "1 44714U 19074B   26201.21370140  .00039227  00000-0  60016-3 0  9999\n" +
                "2 44714  53.0355 270.1063 0005093 339.2481  20.8322 15.54002605369347");
            assert.equal(isGPSetIncomplete(d, DATE, ""), true);
        });
    });

    it("declines to judge a query whose filters we do not define", () => {
        // CUSTOM fetches an external URL with the date substituted in; its
        // window, if it has one, is not ours to reason about.
        const d = build([row({norad: 44714, epoch: "2026-07-27T04:16:27",
                              created: "2026-07-27T04:20:00"})]);
        assert.equal(isGPSetIncomplete(d, DATE, "CUSTOM"), false);
    });

    it("says nothing about an empty set", () => {
        assert.equal(isGPSetIncomplete(new CTLEData(""), DATE, "LEO"), false);
    });

    it("records the newest publication time when the data has one", () => {
        const d = build([
            row({norad: 44714, created: "2026-07-28T06:00:00"}),
            row({norad: 45000, created: "2026-07-30T04:00:45"}),
        ]);
        assert.equal(d.latestCreationDate.toISOString(), "2026-07-30T04:00:45.000Z");
    });

    it("carries the newer publication time through a merge", () => {
        // A refreshed sitch reloads as the baked set merged with the refreshed
        // one. If the merge kept the stale time, the merged set would go on
        // reporting itself as truncated.
        const baked = build([row({norad: 44714, created: "2026-07-27T04:16:27"})]);
        const refreshed = build([row({norad: 45000, created: "2026-07-28T23:26:17"})]);
        baked.mergeFrom(refreshed);
        assert.equal(baked.latestCreationDate.toISOString(), "2026-07-28T23:26:17.000Z");
        assert.equal(isGPSetIncomplete(baked, DATE, ""), false);
    });

    it("uses the documented two-day query window", () => {
        assert.equal(GP_QUERY_WINDOW_DAYS, 2);
    });
});

describe("describing the shortfall in the offer", () => {

    // The dialog must measure whatever the DECISION measured. These drifted
    // apart once: isGPSetIncomplete() fell back to epochs for TLE data under a
    // CREATION_DATE query, while the description still reached for the
    // publication time, read undefined, and threw — and the caller treats a
    // throw as "make no offer". The sets the fallback existed for were exactly
    // the ones it then silenced.
    const DATE = new Date("2026-07-27T00:00:00Z");

    it("measures a CSV set by its publication times", () => {
        const d = build([row({norad: 44714, epoch: "2026-07-27T01:00:00",
                              created: "2026-07-27T04:16:27"})]);
        const {measured, reached, percent} = describeShortfall(d, DATE, "creation");
        assert.equal(measured, "creation");
        assert.equal(reached.toISOString(), "2026-07-27T04:16:27.000Z");
        assert.equal(percent.toFixed(0), "9");
    });

    it("measures a TLE set by its epochs, exactly as the decision did", () => {
        const d = new CTLEData(
            "STARLINK-1008\n" +
            "1 44714U 19074B   26201.21370140  .00039227  00000-0  60016-3 0  9999\n" +
            "2 44714  53.0355 270.1063 0005093 339.2481  20.8322 15.54002605369347");
        assert.equal(isGPSetIncomplete(d, DATE, ""), true);   // the decision: offer it
        const {measured, reached} = describeShortfall(d, DATE, "creation");
        assert.equal(measured, "epoch");
        assert.equal(reached, d.endDate);
    });
});
