import {applyDateTimeString, parseDateTimeString, resolveDateTimeString} from "../src/DateTimeParser";

describe("parseDateTimeString", () => {
    describe("times", () => {
        test("12pm and 12am", () => {
            expect(parseDateTimeString("12pm").time).toEqual({hour: 12, minute: 0, second: 0, millisecond: 0});
            expect(parseDateTimeString("12am").time).toEqual({hour: 0, minute: 0, second: 0, millisecond: 0});
        });

        test("noon and midnight", () => {
            expect(parseDateTimeString("noon").time).toEqual({hour: 12, minute: 0, second: 0, millisecond: 0});
            expect(parseDateTimeString("midnight").time).toEqual({hour: 0, minute: 0, second: 0, millisecond: 0});
        });

        test("12:33am", () => {
            expect(parseDateTimeString("12:33am").time).toEqual({hour: 0, minute: 33, second: 0, millisecond: 0});
        });

        test("24 hour clock", () => {
            expect(parseDateTimeString("15:20").time).toEqual({hour: 15, minute: 20, second: 0, millisecond: 0});
            expect(parseDateTimeString("15:20:30").time).toEqual({hour: 15, minute: 20, second: 30, millisecond: 0});
        });

        test("pm adds twelve", () => {
            expect(parseDateTimeString("3:45pm").time).toEqual({hour: 15, minute: 45, second: 0, millisecond: 0});
            expect(parseDateTimeString("9 pm").time).toEqual({hour: 21, minute: 0, second: 0, millisecond: 0});
        });

        test("UTC marker, attached or spaced", () => {
            expect(parseDateTimeString("17:33UTC")).toEqual({
                date: null, time: {hour: 17, minute: 33, second: 0, millisecond: 0}, utc: true
            });
            expect(parseDateTimeString("17:33 utc").utc).toBe(true);
            expect(parseDateTimeString("15:20 GMT").utc).toBe(true);
            expect(parseDateTimeString("15:20Z").utc).toBe(true);
            expect(parseDateTimeString("15:20").utc).toBe(false);
        });

        test("out of range times are rejected", () => {
            expect(parseDateTimeString("25:00")).toBeNull();
            expect(parseDateTimeString("15:99")).toBeNull();
            expect(parseDateTimeString("13pm")).toBeNull();
        });

        test("a bare hour without am/pm is not a time (it is a frame number)", () => {
            expect(parseDateTimeString("12")).toBeNull();
        });
    });

    describe("dates", () => {
        test("12/25 is month/day, year left open", () => {
            expect(parseDateTimeString("12/25").date).toEqual({month: 12, day: 25, year: undefined});
        });

        test("12/26/2000", () => {
            expect(parseDateTimeString("12/26/2000").date).toEqual({month: 12, day: 26, year: 2000});
        });

        test("Jan 5", () => {
            expect(parseDateTimeString("Jan 5").date).toEqual({month: 1, day: 5, year: undefined});
        });

        test("Jan 6, 2020", () => {
            expect(parseDateTimeString("Jan 6, 2020").date).toEqual({month: 1, day: 6, year: 2020});
        });

        test("full month names, and day-first order", () => {
            expect(parseDateTimeString("January 6 2020").date).toEqual({month: 1, day: 6, year: 2020});
            expect(parseDateTimeString("6 Jan 2020").date).toEqual({month: 1, day: 6, year: 2020});
            expect(parseDateTimeString("September 11 2001").date).toEqual({month: 9, day: 11, year: 2001});
            expect(parseDateTimeString("Sept 11 2001").date).toEqual({month: 9, day: 11, year: 2001});
        });

        test("out of range dates are rejected", () => {
            expect(parseDateTimeString("13/25")).toBeNull();
            expect(parseDateTimeString("12/32")).toBeNull();
        });

        test("two-digit years are declined rather than guessed", () => {
            expect(parseDateTimeString("12/26/00")).toBeNull();
        });

        test("days that no year could make valid are rejected, not rolled over", () => {
            // Date.UTC would silently turn these into Mar 2 / May 1.
            expect(parseDateTimeString("2/30")).toBeNull();
            expect(parseDateTimeString("Apr 31")).toBeNull();
            expect(parseDateTimeString("4/31/2020")).toBeNull();
            expect(parseDateTimeString("31 Apr")).toBeNull();
            expect(parseDateTimeString("6/31")).toBeNull();
        });

        test("Feb 29 parses - whether it is real depends on the year", () => {
            expect(parseDateTimeString("2/29").date).toEqual({month: 2, day: 29, year: undefined});
            expect(parseDateTimeString("2/29/2024").date).toEqual({month: 2, day: 29, year: 2024});
        });
    });

    describe("ISO 8601", () => {
        test("the form Sit.startTime is displayed in, pasted straight back", () => {
            expect(parseDateTimeString("2020-01-06T17:33:00.000Z")).toEqual({
                date: {month: 1, day: 6, year: 2020},
                time: {hour: 17, minute: 33, second: 0, millisecond: 0},
                utc: true
            });
        });

        test("without milliseconds, and with a space instead of T", () => {
            expect(parseDateTimeString("2024-01-06T15:20:00Z").time)
                .toEqual({hour: 15, minute: 20, second: 0, millisecond: 0});
            expect(parseDateTimeString("2024-01-06 15:20").date)
                .toEqual({month: 1, day: 6, year: 2024});
        });

        test("milliseconds are kept", () => {
            expect(parseDateTimeString("2024-01-06T15:20:00.250Z").time.millisecond).toBe(250);
        });

        test("date only", () => {
            expect(parseDateTimeString("2024-01-06")).toEqual({
                date: {month: 1, day: 6, year: 2024}, time: null, utc: false
            });
        });

        test("an impossible ISO date is rejected", () => {
            expect(parseDateTimeString("2025-02-30")).toBeNull();
        });

        test("a numeric zone offset is kept, including fractional hours", () => {
            expect(parseDateTimeString("2024-01-06T15:20:00+05:45").offsetHours).toBe(5.75);
            expect(parseDateTimeString("2024-01-06T15:20:00-08:00").offsetHours).toBe(-8);
            expect(parseDateTimeString("2024-01-06T15:20:00+08:75")).toBeNull();
        });
    });

    describe("date and time together", () => {
        test.each(["Saturday,", "Saturday", "Sat,", "Sat.", "SATURDAY,"])(
            "accepts the weekday prefix %s on a pasted timestamp", weekday => {
                const expected = {
                    date: {month: 8, day: 30, year: 2025},
                    time: {hour: 20, minute: 9, second: 0, millisecond: 0},
                    utc: false,
                };
                expect(parseDateTimeString(`${weekday} August 30, 2025, at 8:09 PM`)).toEqual(expected);
            });

        test.each(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"])(
            "accepts %s before an explicit calendar date", weekday => {
                expect(parseDateTimeString(`${weekday}, August 30, 2025`))
                    .toEqual(parseDateTimeString("August 30, 2025"));
            });

        test("both halves are picked up", () => {
            expect(parseDateTimeString("Jan 6, 2020 15:20")).toEqual({
                date: {month: 1, day: 6, year: 2020},
                time: {hour: 15, minute: 20, second: 0, millisecond: 0},
                utc: false
            });
        });

        test("with a UTC marker", () => {
            const r = parseDateTimeString("12/26/2000 17:33 UTC");
            expect(r.date).toEqual({month: 12, day: 26, year: 2000});
            expect(r.time).toEqual({hour: 17, minute: 33, second: 0, millisecond: 0});
            expect(r.utc).toBe(true);
        });
    });

    describe("things that are NOT dates", () => {
        // The leftover guard: anything not consumed means this was never a date.
        test("place names", () => {
            expect(parseDateTimeString("Mayfield")).toBeNull();
            expect(parseDateTimeString("5 Jackson Street")).toBeNull();
            expect(parseDateTimeString("Eiffel Tower")).toBeNull();
            expect(parseDateTimeString("March")).toBeNull();      // also a town
            expect(parseDateTimeString("Jan 5 Street")).toBeNull();
        });

        test("coordinates in every supported format", () => {
            const coords = [
                "25.299895° 60.430364°",
                "40.7128, -74.0060",
                "45° 30' 30\" N 122° 30' 30\" W",
                "37SCR1192692923",
                "N40 42.77 W074 00.36",
                "45.5 -122.5",
            ];
            for (const c of coords) expect(parseDateTimeString(c)).toBeNull();
        });

        test("empty and junk", () => {
            expect(parseDateTimeString("")).toBeNull();
            expect(parseDateTimeString("   ")).toBeNull();
            expect(parseDateTimeString(null)).toBeNull();
            expect(parseDateTimeString("zzqqxyzz")).toBeNull();
        });

        test.each(["Saturday", "Saturday at 8:09 PM", "Saturday Market August 30, 2025", "Saturdayish, August 30, 2025"])(
            "does not strip weekday-like text without an explicit date: %s", text => {
                expect(parseDateTimeString(text)).toBeNull();
            });
    });
});

describe("resolveDateTimeString", () => {
    const options = {
        baseDate: new Date("2024-07-15T03:04:05.123Z"),
        now: new Date("2026-01-01T01:15:00.456Z"),
        offsetHours: -8,
    };

    test("a weekday prefix preserves the selected time zone when resolving the pasted date", () => {
        const text = "Saturday, August 30, 2025, at 8:09 PM";
        expect(resolveDateTimeString(text, {...options, timeZone: "America/Los_Angeles"}).toISOString())
            .toBe("2025-08-31T03:09:00.000Z");
        expect(resolveDateTimeString(`${text} UTC`, options).toISOString())
            .toBe("2025-08-30T20:09:00.000Z");
    });

    test.each([
        ["yesterday", "2025-12-31T03:04:05.123Z"],
        ["today", "2026-01-01T03:04:05.123Z"],
        ["tomorrow", "2026-01-02T03:04:05.123Z"],
        ["tomorrow at noon", "2026-01-01T20:00:00.000Z"],
        ["noon yesterday", "2025-12-30T20:00:00.000Z"],
        ["tomorrow at midnight UTC", "2026-01-02T00:00:00.000Z"],
        ["tomorrow at 00:15+05:45", "2026-01-01T18:30:00.000Z"],
        ["NOW", "2026-01-01T01:15:00.456Z"],
        ["now UTC", "2026-01-01T01:15:00.456Z"],
        ["2026-11-08 00:15:30.42+05:45", "2026-11-07T18:30:30.420Z"],
    ])("%s resolves against the real calendar in the input zone", (text, expected) => {
        expect(resolveDateTimeString(text, options).toISOString()).toBe(expected);
    });

    test.each(["Tomorrowland", "Now York", "Yesterday Cafe", "tomorrow London", "yesterday tomorrow",
        "now noon", "now tomorrow", "tomorrow Jan 6", "noon midnight", "2024-01-06T15:20Z+08:00"])(
        "rejects unrelated or conflicting text: %s", text => {
            expect(resolveDateTimeString(text, options)).toBeNull();
        });
});

describe("location-dependent times", () => {
    const context = {
        baseDate: new Date('2025-06-10T12:00:00Z'),
        location: {lat: 53.8479533, lon: -1.8384526},
        timeZone: 'Europe/London',
    };

    test.each([
        ['Sunrise', '2025-06-10T03:37:00Z'],
        ['Sunset', '2025-06-10T20:37:00Z'],
        ['Moonrise', '2025-06-10T20:45:00Z'],
        ['Moonset', '2025-06-10T02:16:00Z'],
        ['dawn', '2025-06-10T02:44:00Z'],
        ['dusk', '2025-06-10T21:30:00Z'],
        ['morning', '2025-06-10T04:37:00Z'],
        ['evening', '2025-06-10T19:37:00Z'],
        ['night', '2025-06-10T22:30:00Z'],
    ])('%s uses the observer and local calendar date', (text, expected) => {
        expect(parseDateTimeString(text).namedTime).toBe(text.toLowerCase());
        expect(Math.abs(resolveDateTimeString(text, context) - new Date(expected))).toBeLessThan(60000);
    });

    test('an explicit date changes the season and its daylight saving offset', () => {
        const winter = resolveDateTimeString('January 10 sunrise', context);
        expect(winter.toISOString().startsWith('2025-01-10T08:')).toBe(true);
        expect(resolveDateTimeString('June 10 sunset', {...context, baseDate: winter}).toISOString())
            .toBe(resolveDateTimeString('sunset', context).toISOString());
    });

    test.each([
        ['an hour after sunset', 'sunset', 3600000],
        ['a minute before sunrise', 'sunrise', -60000],
        ['30 minutes before sunrise', 'sunrise', -1800000],
        ['half an hour before moonrise', 'moonrise', -1800000],
        ['a quarter of an hour after moonset', 'moonset', 900000],
        ['quarter hour before dusk', 'dusk', -900000],
        ['two hours after dawn', 'dawn', 7200000],
        ['1.5 hours after sunset', 'sunset', 5400000],
        ['two and a half hours before sunset', 'sunset', -9000000],
        ['an hour and a half after sunset', 'sunset', 5400000],
        ['1 hour and 30 minutes after sunset', 'sunset', 5400000],
        ['1h30m after sunset', 'sunset', 5400000],
        ['twenty-five minutes after sunset', 'sunset', 1500000],
        ['45 seconds before midnight', 'midnight', -45000],
        ['15 min before noon', 'noon', -900000],
        ['1 day after sunset', 'sunset', 86400000],
        ['0 hours after sunset', 'sunset', 0],
    ])('%s shifts the resolved anchor by elapsed time', (text, anchor, shift) => {
        expect(parseDateTimeString(text).timeShiftMS).toBe(shift);
        const result = resolveDateTimeString(text, context);
        expect(result).not.toBeNull();
        expect(result - resolveDateTimeString(anchor, context)).toBe(shift);
    });

    test('the anchor keeps its date when the modifier crosses midnight', () => {
        const result = resolveDateTimeString('June 10 2025 four hours after sunset', context);
        expect(result.toISOString().startsWith('2025-06-11T00:37:')).toBe(true);
        const previousDay = resolveDateTimeString('45 seconds before midnight', context);
        expect(previousDay.toISOString()).toBe('2025-06-09T22:59:15.000Z');
    });

    test('offsets from now use the real instant and offsets across DST use elapsed hours', () => {
        const now = new Date('2026-11-15T10:00:00Z');
        expect(resolveDateTimeString('ten minutes before now', {...context, now}).toISOString())
            .toBe('2026-11-15T09:50:00.000Z');
        expect(resolveDateTimeString('March 9 2025 an hour after 1:30am', {...context, timeZone: 'America/New_York'}).toISOString())
            .toBe('2025-03-09T07:30:00.000Z');
    });

    test.each(['before sunset', 'an hour after', '-1 hour after sunset', 'two parsecs before sunset',
        'one hour and before sunset', 'one hour after one hour before sunset', 'a while before sunset'])(
        'incomplete modifiers fail as a whole: %s', text => {
            expect(parseDateTimeString(text)).toBeNull();
        });

    test('a modifier cannot invent a missing polar event', () => {
        expect(resolveDateTimeString('an hour after sunrise', {...context, location: {lat: 89, lon: 0}})).toBeNull();
    });

    test('relative dates use the actual local date, not the sitch date or host timezone', () => {
        const options = {...context, timeZone: 'Asia/Tokyo', location: {lat: 35.68, lon: 139.69},
            now: new Date('2026-11-15T23:30:00Z')};
        expect(resolveDateTimeString('tomorrow dawn', options).toISOString())
            .toBe(resolveDateTimeString('November 17 2026 dawn', options).toISOString());
    });

    test('UTC boundaries do not change the requested local calendar date', () => {
        const date = resolveDateTimeString('June 10 sunset', {...context, timeZone: 'Pacific/Honolulu',
            location: {lat: 21.3, lon: -157.8}});
        expect(date.toISOString().startsWith('2025-06-11T')).toBe(true);
        expect(new Date(date.getTime() - 10 * 3600000).toISOString().slice(0, 10)).toBe('2025-06-10');
    });

    test('a nonexistent polar event and a missing location fail without inventing a time', () => {
        expect(resolveDateTimeString('sunrise', {...context, location: {lat: 89, lon: 0}})).toBeNull();
        expect(resolveDateTimeString('sunset', {baseDate: context.baseDate})).toBeNull();
    });

    test.each(['sunset 6PM', 'sunrise sunset', 'now moonrise', 'moonset noon', 'Sunset Boulevard'])(
        'rejects conflicting times or leftover place text: %s', text => {
            expect(parseDateTimeString(text)).toBeNull();
        });
});

describe("applyDateTimeString", () => {
    // Stand-in for CNodeDateTime: the fields the Time menu binds its sliders to,
    // plus the updateDateTime() seam a slider edit goes through.
    function makeNode({useTimeZone = false, offsetHours = 0, now = "2024-03-10T08:45:30.123Z"} = {}) {
        return {
            dateNow: new Date(now),
            useTimeZone,
            getTimeZoneOffset: () => offsetHours,
            dateTime: {},
            updated: 0,
            updateDateTime() { this.updated++; },
            // What updateDateTime() would compute as the new absolute instant.
            resolved() {
                const d = this.dateTime;
                const utcMs = Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second, d.millisecond);
                return new Date(utcMs - (this.useTimeZone ? offsetHours * 3600000 : 0)).toISOString();
            },
        };
    }

    test("returns false and touches nothing when the text is not a date/time", () => {
        const node = makeNode();
        expect(applyDateTimeString("Eiffel Tower", node)).toBe(false);
        expect(node.updated).toBe(0);
    });

    test("a time keeps the current date", () => {
        const node = makeNode();
        expect(applyDateTimeString("15:20", node)).toBe(true);
        expect(node.resolved()).toBe("2024-03-10T15:20:00.000Z");
        expect(node.updated).toBe(1);
    });

    test("a date keeps the current time of day", () => {
        const node = makeNode();
        applyDateTimeString("12/25", node);
        expect(node.resolved()).toBe("2024-12-25T08:45:30.123Z");
    });

    test("a full date and time", () => {
        const node = makeNode();
        applyDateTimeString("Jan 6, 2020 15:20", node);
        expect(node.resolved()).toBe("2020-01-06T15:20:00.000Z");
    });

    test("an ISO string round-trips exactly", () => {
        const node = makeNode();
        expect(applyDateTimeString("2020-01-06T17:33:00.000Z", node)).toBe(true);
        expect(node.resolved()).toBe("2020-01-06T17:33:00.000Z");
    });

    test("Go To applies relative dates and now through its normal edit path", () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-01-01T01:15:00.456Z"));
        try {
            const node = makeNode({useTimeZone: true, offsetHours: -8});
            expect(applyDateTimeString("tomorrow at noon", node)).toBe(true);
            expect(node.resolved()).toBe("2026-01-01T20:00:00.000Z");
            expect(applyDateTimeString("now", node)).toBe(true);
            expect(node.resolved()).toBe("2026-01-01T01:15:00.456Z");
            expect(node.updated).toBe(2);
        } finally {
            jest.useRealTimers();
        }
    });

    describe("impossible dates are declined, never rolled over", () => {
        test("Feb 29 in a non-leap year", () => {
            const node = makeNode({now: "2025-03-10T08:45:30.123Z"});   // 2025, not a leap year
            expect(applyDateTimeString("2/29", node)).toBe(false);
            expect(node.updated).toBe(0);
        });

        test("Feb 29 in a leap year is fine", () => {
            const node = makeNode({now: "2024-03-10T08:45:30.123Z"});
            expect(applyDateTimeString("2/29", node)).toBe(true);
            expect(node.resolved()).toBe("2024-02-29T08:45:30.123Z");
        });

        test("an explicit non-leap Feb 29", () => {
            const node = makeNode();
            expect(applyDateTimeString("2/29/2025", node)).toBe(false);
            expect(node.updated).toBe(0);
        });
    });

    test("noon and midnight", () => {
        const noon = makeNode();
        applyDateTimeString("noon", noon);
        expect(noon.resolved()).toBe("2024-03-10T12:00:00.000Z");

        const mid = makeNode();
        applyDateTimeString("midnight", mid);
        expect(mid.resolved()).toBe("2024-03-10T00:00:00.000Z");
    });

    // The Go To box is the main way into a 19th-century date, so it has to carry a
    // pre-epoch instant intact - negative epoch milliseconds all the way through.
    describe("historic dates", () => {
        test("a 19th-century date round-trips exactly", () => {
            const node = makeNode();
            expect(applyDateTimeString("10 April 1897 1:30", node)).toBe(true);
            expect(node.dateTime.year).toBe(1897);
            expect(node.resolved()).toBe("1897-04-10T01:30:00.000Z");
            // Before 1970, so this only works because nothing assumes a positive epoch.
            expect(new Date(node.resolved()).getTime()).toBeLessThan(0);
        });

        test.each([
            ["1897-04-10", 1897, 4, 10],
            ["April 10, 1897", 1897, 4, 10],
            ["4/10/1897", 1897, 4, 10],
            ["1909-05-13", 1909, 5, 13],
        ])("%s is read as a historic date", (text, year, month, day) => {
            const node = makeNode();
            expect(applyDateTimeString(text, node)).toBe(true);
            expect([node.dateTime.year, node.dateTime.month, node.dateTime.day]).toEqual([year, month, day]);
        });

        test("a two-digit year is declined rather than guessed", () => {
            // "97" must never become 1997 via Date.UTC's 0-99 remap, nor 1897 by
            // guessing the century. parseDateTimeString requires four digits.
            const node = makeNode();
            expect(applyDateTimeString("4/10/97", node)).toBe(false);
            expect(node.updated).toBe(0);
        });

        test("29 February 1900 is declined - 1900 was not a leap year", () => {
            // The century rule: divisible by 100 but not 400, so a common year.
            const node = makeNode();
            expect(applyDateTimeString("1900-02-29", node)).toBe(false);
            expect(node.updated).toBe(0);
        });

        test("29 February 2000 is accepted - divisible by 400", () => {
            const node = makeNode();
            expect(applyDateTimeString("2000-02-29", node)).toBe(true);
            expect(node.dateTime.day).toBe(29);
        });
    });

    describe("time zones", () => {
        test("a plain time is read in the displayed zone", () => {
            // Menu shows UTC-7; typing 15:20 means 15:20 local = 22:20 UTC.
            const node = makeNode({useTimeZone: true, offsetHours: -7});
            applyDateTimeString("15:20", node);
            expect(node.resolved()).toBe("2024-03-10T22:20:00.000Z");
            expect(node.dateTime.hour).toBe(15);        // the menu still reads 15:20
        });

        test("an explicit UTC time is absolute, and the menu shows the local equivalent", () => {
            const node = makeNode({useTimeZone: true, offsetHours: -7});
            applyDateTimeString("17:33 UTC", node);
            expect(node.resolved()).toBe("2024-03-10T17:33:00.000Z");
            expect(node.dateTime.hour).toBe(10);        // 17:33Z shown as 10:33 local
        });

        test("an explicit UTC time can roll the displayed date", () => {
            const node = makeNode({useTimeZone: true, offsetHours: -7, now: "2024-03-10T08:00:00.000Z"});
            applyDateTimeString("02:00 UTC", node);
            expect(node.resolved()).toBe("2024-03-10T02:00:00.000Z");
            expect(node.dateTime.day).toBe(9);          // still the 9th locally
            expect(node.dateTime.hour).toBe(19);
        });

        test("with the time zone override off, everything is UTC", () => {
            const node = makeNode({useTimeZone: false, offsetHours: -7});
            applyDateTimeString("15:20", node);
            expect(node.resolved()).toBe("2024-03-10T15:20:00.000Z");
        });
    });
});
