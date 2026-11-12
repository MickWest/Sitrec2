import {parseTimeEntry, replaceTimePart, shiftTimePart, wallTimeISO} from "../src/TimeEditing";

test.each([0, -8, 5.5, 5.75])("wall-clock editing preserves milliseconds with offset %s", offset => {
    const date = new Date("2026-11-08T02:03:24.987Z");
    expect(parseTimeEntry(wallTimeISO(date, offset), offset)).toEqual(date);
    expect(replaceTimePart(date, "minute", "10", offset).getUTCMilliseconds()).toBe(987);
});

test("minute and second scrubbing carries through midnight, leap day and year end", () => {
    expect(shiftTimePart(new Date("2024-02-28T23:59:10.123Z"), "minute", 1).toISOString()).toBe("2024-02-29T00:00:10.123Z");
    expect(shiftTimePart(new Date("2025-01-01T00:00:00.123Z"), "second", -1).toISOString()).toBe("2024-12-31T23:59:59.123Z");
    expect(shiftTimePart(new Date("2024-03-01T00:00:00Z"), "hour", -24).toISOString()).toBe("2024-02-29T00:00:00.000Z");
});

test("calendar edit preserves the local time of day and its milliseconds", () => {
    const date = new Date("2026-11-08T02:03:24.987Z");
    expect(replaceTimePart(date, "date", "2026-11-09", -8).toISOString()).toBe("2026-11-10T02:03:24.987Z");
    expect(replaceTimePart(date, "date", "2026-02-29", -8)).toBeNull();
});

test("month and year steps clamp short months in the displayed time zone", () => {
    const date = new Date("2024-02-01T02:03:24.987Z"); // Jan 31 at UTC-8.
    expect(shiftTimePart(date, "month", 1, -8).toISOString()).toBe("2024-03-01T02:03:24.987Z");
    expect(shiftTimePart(new Date("2024-02-29T23:30:00.987Z"), "year", 1).toISOString()).toBe("2025-02-28T23:30:00.987Z");
    expect(shiftTimePart(date, "month", -1, -8).toISOString()).toBe("2024-01-01T02:03:24.987Z");
});

test.each([["month", "00"], ["day", "00"], ["month", "13"], ["day", "32"]])("rejects invalid calendar digit %s=%s", (part, value) => {
    expect(replaceTimePart(new Date("2024-01-01T00:00:00Z"), part, value)).toBeNull();
});

test("explicit pasted zone wins over the displayed zone", () => {
    expect(parseTimeEntry("2026-11-08 00:15:30.42+05:45", -8).toISOString()).toBe("2026-11-07T18:30:30.420Z");
    expect(parseTimeEntry("2026-11-08 00:15Z", -8).toISOString()).toBe("2026-11-08T00:15:00.000Z");
});

test.each(["", "1900-02-29 12:00", "2026-04-31 12:00", "2026-01-01 24:00", "2026-01-01 01:60", "2026-01-01 01:00+08:75"])("rejects impossible date without normalizing: %s", value => {
    expect(parseTimeEntry(value)).toBeNull();
});

test.each([["hour", "24"], ["minute", "60"], ["second", "-1"], ["millisecond", "1000"], ["hour", ""]])("rejects invalid %s input %s", (part, value) => {
    expect(replaceTimePart(new Date("2026-01-01T00:00:00Z"), part, value)).toBeNull();
});
