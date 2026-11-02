// Catalog fields carried by a Space-Track OMM CSV (LAUNCH_DATE, RCS_SIZE,
// OBJECT_ID), the launch check that hides an object before its launch, merging
// sets whose CSV headers differ, and the era-dependent history window.

import {strict as assert} from "assert";
import {
    CTLEData,
    elementSetErrorKm,
    gpHistoryWindowDays,
    GP_QUERY_WINDOW_DAYS,
    isBeforeLaunch,
    isGPSetIncomplete,
    satRecToDate,
} from "../src/TLEUtils";

const {spawnSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The columns proxyStarlink.php requests, before and after LAUNCH_DATE was added.
const OLD_HEADER = "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,EPOCH,CREATION_DATE,MEAN_MOTION," +
    "ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,BSTAR," +
    "MEAN_MOTION_DOT,MEAN_MOTION_DDOT,OBJECT_TYPE,RCS_SIZE";
const NEW_HEADER = OLD_HEADER + ",LAUNCH_DATE";

function row({name = "STARLINK-1008", objectId = "2019-074B", norad = 44714,
              epoch = "2026-07-27T12:00:00", objectType = "PAYLOAD", rcs = "LARGE",
              launch = "2019-11-11"} = {}, withLaunch = true) {
    const cells = [`"${name}"`, `"${objectId}"`, `"${norad}"`, `"${epoch}"`, '"2026-07-27T18:00:00"',
        '"15.54002605"', '"0.00050927"', '"53.1497"', '"270.1063"', '"339.2481"',
        '"20.8322"', '"0.00060016118000"', '"0.00039227"', '"0.0000000000000"',
        `"${objectType}"`, `"${rcs}"`];
    if (withLaunch) cells.push(`"${launch}"`);
    return cells.join(",");
}

describe("catalog fields from a Space-Track OMM CSV", () => {
    it("reads launch date, radar size and international designator", () => {
        const d = new CTLEData([NEW_HEADER, row()].join("\n"));
        const sat = d.getRecordFromNORAD(44714);
        assert.equal(sat.objectId, "2019-074B");
        assert.equal(sat.objectType, "PAYLOAD");
        assert.equal(sat.rcsSize, "LARGE");
        assert.equal(new Date(sat.launchDate).toISOString(), "2019-11-11T00:00:00.000Z");
    });

    it("leaves the launch date unset for a set cached without the column", () => {
        const d = new CTLEData([OLD_HEADER, row({}, false)].join("\n"));
        const sat = d.getRecordFromNORAD(44714);
        assert.equal(sat.launchDate, undefined);
        assert.equal(sat.rcsSize, "LARGE");
    });

    it("leaves an empty LAUNCH_DATE unset rather than inventing a date", () => {
        const d = new CTLEData([NEW_HEADER, row({launch: ""})].join("\n"));
        assert.equal(d.getRecordFromNORAD(44714).launchDate, undefined);
    });
});

describe("hiding an object before its launch", () => {
    const sat = {launchDate: Date.UTC(2026, 6, 28)};

    it("is not launched before the start of the launch day", () => {
        assert.equal(isBeforeLaunch(sat, Date.UTC(2026, 6, 27, 23, 59)), true);
    });

    it("is kept on the launch day itself, which LAUNCH_DATE cannot split", () => {
        assert.equal(isBeforeLaunch(sat, Date.UTC(2026, 6, 28, 3, 0)), false);
    });

    it("is kept when the launch date is unknown", () => {
        assert.equal(isBeforeLaunch({}, Date.UTC(2000, 0, 1)), false);
    });
});

describe("merging sets", () => {
    it("fills a missing launch date from a newer download of the same object", () => {
        const a = new CTLEData([OLD_HEADER, row({}, false)].join("\n"));
        a.mergeFrom(new CTLEData([NEW_HEADER, row({epoch: "2026-07-28T12:00:00"})].join("\n")));
        const sat = a.getRecordFromNORAD(44714);
        assert.equal(sat.satrecs.length, 2);
        assert.equal(new Date(sat.launchDate).toISOString().slice(0, 10), "2019-11-11");
    });

    it("keeps the catalog fields of a satellite the merge adds", () => {
        const a = new CTLEData([NEW_HEADER, row()].join("\n"));
        a.mergeFrom(new CTLEData([NEW_HEADER,
            row({name: "SL-16 R/B", objectId: "1990-046B", norad: 20625, objectType: "ROCKET BODY"})].join("\n")));
        const added = a.getRecordFromNORAD(20625);
        assert.equal(added.objectType, "ROCKET BODY");
        assert.equal(added.objectId, "1990-046B");
    });

    it("exports sets with different headers so each row reloads under its own header", () => {
        // Before: the second header was always dropped, so the new set's rows
        // were read by the old set's column positions on reload.
        const a = new CTLEData([OLD_HEADER, row({}, false)].join("\n"));
        a.mergeFrom(new CTLEData([NEW_HEADER,
            row({name: "STARLINK-9999", objectId: "2026-150A", norad: 99999,
                epoch: "2026-07-27T06:00:00", launch: "2026-07-20"})].join("\n")));

        const reloaded = new CTLEData(a.rawText);
        assert.equal(reloaded.satData.length, 2);
        const fresh = reloaded.getRecordFromNORAD(99999);
        assert.equal(new Date(fresh.launchDate).toISOString().slice(0, 10), "2026-07-20");
        assert.equal(satRecToDate(fresh.satrecs[0]).toISOString(), "2026-07-27T06:00:00.000Z");
        assert.equal(satRecToDate(reloaded.getRecordFromNORAD(44714).satrecs[0]).toISOString(),
            "2026-07-27T12:00:00.000Z");
    });

    it("still folds a set with the same header into one block", () => {
        const a = new CTLEData([NEW_HEADER, row()].join("\n"));
        a.mergeFrom(new CTLEData([NEW_HEADER, row({norad: 45000, name: "STARLINK-1100"})].join("\n")));
        assert.equal(a.rawText.split("\n").filter(line => line.startsWith("OBJECT_NAME")).length, 1);
        assert.equal(new CTLEData(a.rawText).satData.length, 2);
    });
});

describe("the history window", () => {
    it("keeps the standard two days from 2018", () => {
        assert.equal(gpHistoryWindowDays(new Date("2018-01-01T00:00:00Z")), GP_QUERY_WINDOW_DAYS);
        assert.equal(gpHistoryWindowDays(new Date("2026-07-27T00:00:00Z")), GP_QUERY_WINDOW_DAYS);
    });

    it("widens to six days before 2018, when element sets were published less often", () => {
        assert.equal(gpHistoryWindowDays(new Date("2017-12-31T23:00:00Z")), 6);
        assert.equal(gpHistoryWindowDays(new Date("2005-06-15T00:00:00Z")), 6);
        assert.equal(gpHistoryWindowDays(new Date("1985-01-01T00:00:00Z")), 6);
    });

    it("judges completeness against the window the set was requested with", () => {
        const date = new Date("2015-03-01T00:00:00Z");
        // Epochs reach D+2: complete for a two-day window, short for six days.
        const d = new CTLEData([NEW_HEADER,
            row({norad: 1, epoch: "2015-03-01T00:10:00"}),
            row({norad: 2, epoch: "2015-03-02T23:59:00"})].join("\n"));
        assert.equal(isGPSetIncomplete(d, date, "LEO"), false);
        assert.equal(isGPSetIncomplete(d, date, "LEO", 6), true);
    });
});

describe("the rough position error of an element set", () => {
    it("starts near a kilometre and grows with age either side of the epoch", () => {
        assert.deepEqual(elementSetErrorKm(0), [1, 1]);
        assert.deepEqual(elementSetErrorKm(2), [3, 7]);
        assert.deepEqual(elementSetErrorKm(-2), [3, 7]);
    });
});

const phpResult = spawnSync("php", ["-r", "echo PHP_BINARY;"], {encoding: "utf8"});
const php = phpResult.status === 0 ? phpResult.stdout : null;

(php ? describe : describe.skip)("proxyStarlink.php window parameter", () => {
    let root;
    let script;
    let env;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-starlink-days-"));
        for (const dir of ["sitrecServer", "cache", "tmp"]) {
            fs.mkdirSync(path.join(root, dir));
        }
        script = path.join(root, "sitrecServer/proxyStarlink.php");
        fs.copyFileSync(path.join(__dirname, "../sitrecServer/proxyStarlink.php"), script);
        fs.writeFileSync(path.join(root, "sitrecServer/config.php"), "<?php\n");
        fs.writeFileSync(path.join(root, "sitrecServer/config_paths.php"),
            `<?php $CACHE_PATH = ${JSON.stringify(path.join(root, "cache") + "/")};\n`);
        fs.writeFileSync(path.join(root, "sitrecServer/curlGetRequest.php"), "<?php\n");
        fs.writeFileSync(path.join(root, "sitrecServer/gpData.php"), "<?php\n");
        env = {...process.env, TMPDIR: path.join(root, "tmp")};
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    it("refuses a window it does not offer, so a client cannot pick the download size", () => {
        const result = spawnSync(php, ["-r",
            '$_GET = ["request" => "2010-01-01", "type" => "LEO", "days" => "5"]; require $argv[1];',
            script], {encoding: "utf8", timeout: 10000, env});
        expect(result.stdout).toBe("Invalid days parameter");
    });
});
