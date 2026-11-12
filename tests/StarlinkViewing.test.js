import {compassHeading, parseViewingDate, satelliteMatchesSearch, viewingDateInput} from "../src/StarlinkViewing";

describe("Starlink viewing time", () => {
    test.each([0, -8, 5.5, 5.75])("round-trips UTC through an explicit %s hour offset", offset => {
        const instant = new Date("2026-11-08T02:03:24Z");
        expect(parseViewingDate(viewingDateInput(instant, offset), offset)).toEqual(instant);
    });
    test("local midnight crosses the UTC date without using the host zone", () => {
        expect(parseViewingDate("2026-11-07T23:30", -8).toISOString()).toBe("2026-11-08T07:30:00.000Z");
    });
    test.each(["", "2026-02-30T12:00", "2026-13-01T12:00", "2026-11-07T25:00", "2026-11-07"])("rejects invalid date %s", value => {
        expect(parseViewingDate(value)).toBeNull();
    });
});

test("compass uses positive headings and wraps north", () => {
    expect(compassHeading(-90)).toBe("270.0° W");
    expect(compassHeading(720)).toBe("0.0° N");
    expect(compassHeading(144)).toBe("144.0° SE");
});

describe("loaded satellite search", () => {
    const sat = {name: "0 STARLINK-1234", number: 56789};
    test.each(["", "  ", "starlink-12", "sl-1234", "56789", "ISS, SL-1234"])("matches %s", query => {
        expect(satelliteMatchesSearch(sat, query)).toBe(true);
    });
    test.each(["5678", "ISS", "sl-9999"])("does not match %s", query => {
        expect(satelliteMatchesSearch(sat, query)).toBe(false);
    });
});
