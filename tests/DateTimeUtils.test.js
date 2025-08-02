import {getOffsetFromDateTimeString} from "../src/DateTimeUtils";

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
