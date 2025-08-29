import {f2m, metersFromNM, scaleF2M, unitsToMeters} from "../src/utils.js";

describe('unitsToMeters', () => {
    
    // Happy Path Tests
    describe('supported unit conversions', () => {
        test('converts miles to meters correctly', () => {
            expect(unitsToMeters('miles', 1)).toBeCloseTo(1609.344);
            expect(unitsToMeters('miles', 0)).toBe(0);
            expect(unitsToMeters('miles', 2.5)).toBeCloseTo(4023.36);
        });

        test('converts feet to meters correctly', () => {
            expect(unitsToMeters('feet', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('ft', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('f', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('feet', 10)).toBeCloseTo(10 * scaleF2M);
            expect(unitsToMeters('feet', 0)).toBe(0);
        });

        test('handles meters without conversion', () => {
            expect(unitsToMeters('meters', 100)).toBe(100);
            expect(unitsToMeters('m', 50.5)).toBe(50.5);
            expect(unitsToMeters('meters', 0)).toBe(0);
            expect(unitsToMeters('m', -10)).toBe(-10);
        });

        test('converts nautical miles to meters correctly', () => {
            expect(unitsToMeters('nm', 1)).toBe(1852);
            expect(unitsToMeters('nm', 0)).toBe(0);
            expect(unitsToMeters('nm', 2.5)).toBe(4630);
        });

        test('converts kilometers to meters correctly', () => {
            expect(unitsToMeters('km', 1)).toBe(1000);
            expect(unitsToMeters('kilometers', 1)).toBe(1000);
            expect(unitsToMeters('km', 2.5)).toBe(2500);
            expect(unitsToMeters('kilometers', 0)).toBe(0);
        });
    });

    // Input Verification Tests
    describe('case insensitive handling', () => {
        test('handles mixed case units correctly', () => {
            expect(unitsToMeters('MILES', 1)).toBeCloseTo(1609.344);
            expect(unitsToMeters('Miles', 1)).toBeCloseTo(1609.344);
            expect(unitsToMeters('FEET', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('Feet', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('FT', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('F', 1)).toBeCloseTo(scaleF2M);
            expect(unitsToMeters('METERS', 100)).toBe(100);
            expect(unitsToMeters('Meters', 100)).toBe(100);
            expect(unitsToMeters('M', 100)).toBe(100);
            expect(unitsToMeters('NM', 1)).toBe(1852);
            expect(unitsToMeters('KM', 1)).toBe(1000);
            expect(unitsToMeters('KILOMETERS', 1)).toBe(1000);
            expect(unitsToMeters('Kilometers', 1)).toBe(1000);
        });
    });

    describe('edge cases', () => {
        test('handles zero values correctly', () => {
            expect(unitsToMeters('miles', 0)).toBe(0);
            expect(unitsToMeters('feet', 0)).toBe(0);
            expect(unitsToMeters('meters', 0)).toBe(0);
            expect(unitsToMeters('nm', 0)).toBe(0);
            expect(unitsToMeters('km', 0)).toBe(0);
        });

        test('handles negative values correctly', () => {
            expect(unitsToMeters('miles', -1)).toBeCloseTo(-1609.344);
            expect(unitsToMeters('feet', -1)).toBeCloseTo(-scaleF2M);
            expect(unitsToMeters('meters', -100)).toBe(-100);
            expect(unitsToMeters('nm', -1)).toBe(-1852);
            expect(unitsToMeters('km', -1)).toBe(-1000);
        });

        test('handles decimal values correctly', () => {
            expect(unitsToMeters('miles', 0.5)).toBeCloseTo(804.672);
            expect(unitsToMeters('feet', 3.5)).toBeCloseTo(3.5 * scaleF2M);
            expect(unitsToMeters('meters', 10.75)).toBe(10.75);
            expect(unitsToMeters('nm', 1.5)).toBe(2778);
            expect(unitsToMeters('km', 2.25)).toBe(2250);
        });

        test('handles very large values correctly', () => {
            expect(unitsToMeters('miles', 1000)).toBeCloseTo(1609344);
            expect(unitsToMeters('km', 1000)).toBe(1000000);
            expect(unitsToMeters('meters', 1000000)).toBe(1000000);
        });
    });

    // Exception Handling Tests
    describe('unknown units handling', () => {
        test('triggers assertion but returns fallback value for unknown units', () => {
            // The assert function logs to console and triggers debugger but doesn't throw
            // The function returns the original value as a fallback due to the unreachable return statement
            
            // Mock console methods to suppress output during this test
            const originalConsoleTrace = console.trace;
            const originalConsoleError = console.error;
            console.trace = jest.fn();
            console.error = jest.fn();
            
            expect(unitsToMeters('unknown', 100)).toBe(100);
            expect(unitsToMeters('inches', 12)).toBe(12);
            expect(unitsToMeters('yards', 10)).toBe(10);
            expect(unitsToMeters('centimeters', 100)).toBe(100);
            expect(unitsToMeters('millimeters', 1000)).toBe(1000);
            expect(unitsToMeters('', 100)).toBe(100);
            
            // Verify that console methods were called (assertions were triggered)
            expect(console.trace).toHaveBeenCalled();
            expect(console.error).toHaveBeenCalled();
            
            // Restore original console methods
            console.trace = originalConsoleTrace;
            console.error = originalConsoleError;
        });

        test('handles null/undefined units with toLowerCase error', () => {
            // These will throw because toLowerCase() is called on null/undefined
            expect(() => unitsToMeters(null, 100)).toThrow();
            expect(() => unitsToMeters(undefined, 100)).toThrow();
        });
    });

    describe('consistency with helper functions', () => {
        test('results match direct helper function calls', () => {
            const testValue = 5;
            
            // Test that unitsToMeters uses the same conversions as direct function calls
            expect(unitsToMeters('feet', testValue)).toBeCloseTo(f2m(testValue));
            expect(unitsToMeters('ft', testValue)).toBeCloseTo(f2m(testValue));
            expect(unitsToMeters('f', testValue)).toBeCloseTo(f2m(testValue));
            
            expect(unitsToMeters('nm', testValue)).toBe(metersFromNM(testValue));
        });
    });
});