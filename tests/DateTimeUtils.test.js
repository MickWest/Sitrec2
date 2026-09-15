import {frameTimeOffsetMS, getOffsetFromDateTimeString, timeStrToEpoch} from "../src/DateTimeUtils";

test('fractional video time uses one reversible millisecond offset at half-millisecond boundaries', () => {
    const fps = 30000/1001;
    const start = Date.parse('2000-01-01T00:00:00Z');
    expect(frameTimeOffsetMS(645, fps)).toBe(21522);
    for (const frame of [0, 1, 15, 368, 370, 645, 1032]) {
        const offset = frameTimeOffsetMS(frame, fps);
        expect(Math.abs(offset-frame*1001/30)).toBeLessThanOrEqual(.50000001);
        expect((start+offset)-frameTimeOffsetMS(frame, fps)).toBe(start);
    }
    expect(frameTimeOffsetMS(30, 30, 2)).toBe(2000);
});

describe('getOffsetFromDateTimeString', () => {
    test('returns 0 for UTC datetime (Z)', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00Z')).toBe(0);
    });

    test('returns correct positive offset for +02:00', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00+02:00')).toBe(2);
    });

    test('returns correct negative offset for -07:30', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00-07:30')).toBe(-7.5);
    });

    test('returns correct offset for +0230 format (HHMM)', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00+0230')).toBe(2.5);
    });

    test('returns correct offset for -0415 format (HHMM)', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00-0415')).toBe(-4.25);
    });

    test('returns correct offset for +02 format (HH)', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00+02')).toBe(2);
    });

    test('returns correct offset for -11 format (HH)', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00-11')).toBe(-11);
    });


    test('returns null for invalid date string', () => {
        expect(getOffsetFromDateTimeString('not-a-date')).toBeNull();
    });

    test('returns null for non-string input', () => {
        expect(getOffsetFromDateTimeString(12345)).toBeNull();
    });

    test('returns null if no time zone info is included', () => {
        expect(getOffsetFromDateTimeString('2025-08-02T12:00:00')).toBeNull();
    });
});

describe('timeStrToEpoch', () => {
    describe('numeric string inputs', () => {
        test('handles milliseconds since epoch (1e11 to 1e14 range)', () => {
            const milliseconds = 1640995200000; // Jan 1, 2022 00:00:00 UTC
            expect(timeStrToEpoch('1640995200000')).toBe(1640995200000);
            expect(timeStrToEpoch('1640995200000.5')).toBe(1640995200000.5);
        });

        test('converts seconds to milliseconds (1e8 to 1e11 range)', () => {
            const seconds = 1640995200; // Jan 1, 2022 00:00:00 UTC in seconds
            expect(timeStrToEpoch('1640995200')).toBe(1640995200000);
            expect(timeStrToEpoch('1640995200.5')).toBe(1640995200500);
        });

        test('returns numeric value unchanged for unlikely epoch times', () => {
            expect(timeStrToEpoch('123')).toBe(123);
            expect(timeStrToEpoch('456.789')).toBe(456.789);
            expect(timeStrToEpoch('99999999')).toBe(99999999); // Below 1e8
        });

        test('handles edge cases for range boundaries', () => {
            // Exactly 1e8 (not in seconds range, so returns unchanged)
            expect(timeStrToEpoch('100000000')).toBe(100000000);
            // Just above 1e8 (seconds range)
            expect(timeStrToEpoch('100000001')).toBe(100000001000);
            // Just below 1e11 (seconds range)
            expect(timeStrToEpoch('99999999999')).toBe(99999999999000);
            // Just above 1e11 (milliseconds range)
            expect(timeStrToEpoch('100000000000')).toBe(100000000000);
            // Just below 1e14 (milliseconds range)
            expect(timeStrToEpoch('99999999999999')).toBe(99999999999999);
        });
    });

    describe('ISO 8601 date string inputs', () => {
        test('parses valid ISO 8601 date strings', () => {
            const dateStr = '2022-01-01T00:00:00Z';
            const expectedMs = Date.parse(dateStr);
            expect(timeStrToEpoch(dateStr)).toBe(expectedMs);
        });

        test('parses ISO 8601 with timezone offset', () => {
            const dateStr = '2022-01-01T10:00:00+05:00';
            const expectedMs = Date.parse(dateStr);
            expect(timeStrToEpoch(dateStr)).toBe(expectedMs);
        });

        test('parses various ISO 8601 formats', () => {
            const formats = [
                '2022-01-01T12:00:00.000Z',
                '2022-01-01T12:00:00-07:00',
                '2022-01-01T12:00:00+02:30'
            ];
            
            formats.forEach(dateStr => {
                const expectedMs = Date.parse(dateStr);
                expect(timeStrToEpoch(dateStr)).toBe(expectedMs);
            });
        });
    });

    describe('input handling', () => {
        test('trims whitespace from input', () => {
            expect(timeStrToEpoch('  1640995200  ')).toBe(1640995200000);
            expect(timeStrToEpoch(' 2022-01-01T00:00:00Z ')).toBe(Date.parse('2022-01-01T00:00:00Z'));
        });

        test('handles invalid date strings', () => {
            const result = timeStrToEpoch('invalid-date');
            expect(isNaN(result)).toBe(true);
        });

        test('handles empty and whitespace-only strings', () => {
            expect(isNaN(timeStrToEpoch(''))).toBe(true);
            expect(isNaN(timeStrToEpoch('   '))).toBe(true);
        });
    });

    describe('numeric validation', () => {
        test('rejects non-numeric strings with mixed content', () => {
            const result = timeStrToEpoch('123abc');
            expect(isNaN(result)).toBe(true);
        });

        test('accepts decimal numbers', () => {
            expect(timeStrToEpoch('123.456')).toBe(123.456);
            expect(timeStrToEpoch('1640995200.123')).toBe(1640995200123);
        });

        test('handles negative numbers via Date.parse (not numeric path)', () => {
            const result = timeStrToEpoch('-123');
            // Negative numbers don't match the numeric regex, so they go to Date.parse
            // Date.parse('-123') actually parses it as a year (-123 AD) and returns a valid timestamp
            expect(typeof result).toBe('number');
            expect(result).toBe(Date.parse('-123'));
        });
    });
});
