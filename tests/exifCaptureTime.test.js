// EXIF timestamps carry no timezone, so a naive read is only right when the
// photograph happened to be taken in the viewer's own timezone. The measured
// failure: Berlin_Funkturm_fullmånen_2026-04-01_img02.jpg records
// DateTimeOriginal 2026:04:01 19:49:28 with OffsetTimeOriginal +02:00, i.e.
// 17:49:28 UTC. Opened on a US Pacific machine it was taken as 19:49:28 PDT and
// became 2026-04-02T02:49:28Z — nine hours late, Moon on the other side of the
// sky.

import {parseExifUtcOffset, applyExifUtcOffset, pickExifUtcOffset} from "../src/exifCaptureTime";

// exifr builds its Date by reading the EXIF wall-clock as LOCAL time, so this is
// what it hands over whatever machine is running.
const asLocalWallClock = (y, mo, d, h, mi, s, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);

describe("parsing the EXIF offset", () => {
    test("the ordinary forms", () => {
        expect(parseExifUtcOffset("+02:00")).toBe(120);
        expect(parseExifUtcOffset("-07:00")).toBe(-420);
        expect(parseExifUtcOffset("+00:00")).toBe(0);
        expect(parseExifUtcOffset("+0530")).toBe(330);   // colon is optional
        expect(parseExifUtcOffset("-03:30")).toBe(-210); // Newfoundland
        expect(parseExifUtcOffset("Z")).toBe(0);
        expect(parseExifUtcOffset("  +02:00  ")).toBe(120);
    });

    test("absent or corrupt means NO information, not UTC", () => {
        for (const bad of [undefined, null, "", "   ", "unknown", "+2:00", "0200", "+15:00", "+02:99", 120]) {
            expect(parseExifUtcOffset(bad)).toBe(null);
        }
    });

    test("+14:00 is real (Kiritimati) and must survive the sanity bound", () => {
        expect(parseExifUtcOffset("+14:00")).toBe(840);
    });
});

describe("recovering the true instant", () => {
    // THE case that motivated this.
    test("the Berlin moonrise resolves to 17:49:28Z from any timezone", () => {
        const naive = asLocalWallClock(2026, 4, 1, 19, 49, 28, 115);
        expect(applyExifUtcOffset(naive, "+02:00").toISOString())
            .toBe("2026-04-01T17:49:28.115Z");
    });

    test("a western offset moves the other way", () => {
        const naive = asLocalWallClock(2024, 9, 18, 6, 44, 10);
        // Chicago, CDT
        expect(applyExifUtcOffset(naive, "-05:00").toISOString())
            .toBe("2024-09-18T11:44:10.000Z");
    });

    test("the result does not depend on the machine's own wall-clock reading", () => {
        // Whatever zone the test host is in, the local getters return the EXIF
        // numbers, so the recovered instant is the same.
        const naive = asLocalWallClock(2026, 4, 1, 19, 49, 28, 115);
        const out = applyExifUtcOffset(naive, "+02:00");
        expect(out.getUTCHours()).toBe(17);
        expect(out.getUTCMinutes()).toBe(49);
        expect(out.getUTCDate()).toBe(1);
    });

    test("an offset that rolls the date backwards", () => {
        const naive = asLocalWallClock(2026, 4, 2, 1, 30, 0);
        expect(applyExifUtcOffset(naive, "+13:00").toISOString())
            .toBe("2026-04-01T12:30:00.000Z");
    });

    test("with no offset the date is handed back untouched — the old behaviour", () => {
        const naive = asLocalWallClock(2026, 4, 1, 19, 49, 28);
        expect(applyExifUtcOffset(naive, undefined)).toBe(naive);
        expect(applyExifUtcOffset(naive, "nonsense")).toBe(naive);
    });

    test("a missing or invalid date is not turned into a fake one", () => {
        expect(applyExifUtcOffset(undefined, "+02:00")).toBe(undefined);
        const bad = new Date(NaN);
        expect(applyExifUtcOffset(bad, "+02:00")).toBe(bad);
    });
});

describe("which offset tag wins", () => {
    test("the original exposure's offset outranks the others", () => {
        expect(pickExifUtcOffset({
            OffsetTimeOriginal: "+02:00", OffsetTime: "-07:00", OffsetTimeDigitized: "+09:00",
        })).toBe("+02:00");
    });

    test("falls through to the generic tag, then the digitised one", () => {
        expect(pickExifUtcOffset({OffsetTime: "-07:00"})).toBe("-07:00");
        expect(pickExifUtcOffset({OffsetTimeDigitized: "+09:00"})).toBe("+09:00");
    });

    test("an unparseable higher-priority tag does not block a good lower one", () => {
        expect(pickExifUtcOffset({OffsetTimeOriginal: "", OffsetTime: "+02:00"})).toBe("+02:00");
    });

    test("nothing usable reports undefined, so callers can say the time is a guess", () => {
        expect(pickExifUtcOffset({})).toBe(undefined);
        expect(pickExifUtcOffset(undefined)).toBe(undefined);
        expect(pickExifUtcOffset({OffsetTimeOriginal: "garbage"})).toBe(undefined);
    });
});
