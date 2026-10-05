import {formatReticleClock, parseReticleClock} from "../src/ReticleClock";

describe("ReticleClock", () => {
    test("parses an unset-clock reading as 1999", () => {
        expect(parseReticleClock("12/31/99 18:10:00")).toBe(Date.UTC(1999, 11, 31, 18, 10, 0));
    });

    test("two-digit years below 70 are 20xx, four-digit years pass through", () => {
        expect(parseReticleClock("01/02/25 03:04:05")).toBe(Date.UTC(2025, 0, 2, 3, 4, 5));
        expect(parseReticleClock("1/2/2025 3:04:05")).toBe(Date.UTC(2025, 0, 2, 3, 4, 5));
    });

    test("rejects empty, partial and impossible values", () => {
        for (const text of ["", null, undefined, "12/31/99", "18:10:00", "02/30/25 00:00:00", "12/31/99 24:00:00", "13/01/25 00:00:00"]) {
            expect(parseReticleClock(text)).toBeNull();
        }
    });

    test("format round-trips the parsed value", () => {
        expect(formatReticleClock(parseReticleClock("12/31/99 18:10:00"))).toBe("12/31/99 18:10:00");
        expect(formatReticleClock(Date.UTC(2025, 11, 9, 22, 10, 7))).toBe("12/09/25 22:10:07");
    });
});
