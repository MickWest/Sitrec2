import {
    formatDecimalDegrees,
    formatDM,
    formatDMS,
    formatLatLon,
    splitDM,
    splitDMS
} from "../src/CoordinateFormat";
import {parseLatLonPair, parseSingleCoordinate} from "../src/CoordinateParser";

describe("splitDMS", () => {
    test("splits a plain value", () => {
        expect(splitDMS(40 + 26 / 60 + 46 / 3600)).toEqual({negative: false, deg: 40, min: 26, sec: 46});
    });

    test("carries seconds that round up to 60 into the minutes", () => {
        // The float version prints 26'60.0" here.
        expect(splitDMS(40 + 26 / 60 + 59.97 / 3600)).toEqual({negative: false, deg: 40, min: 27, sec: 0});
    });

    test("carries all the way into the degrees", () => {
        expect(splitDMS(40.99999)).toEqual({negative: false, deg: 41, min: 0, sec: 0});
    });

    test("keeps the requested seconds precision", () => {
        expect(splitDMS(40 + 26 / 60 + 46.25 / 3600, {secondsDecimals: 2}).sec).toBe(46.25);
        expect(splitDMS(40 + 26 / 60 + 46.25 / 3600, {secondsDecimals: 0}).sec).toBe(46);
    });

    test("sign is reported separately from the magnitude", () => {
        expect(splitDMS(-(40 + 26 / 60 + 46 / 3600))).toEqual({negative: true, deg: 40, min: 26, sec: 46});
    });

    test("a value that rounds to zero is not negative", () => {
        expect(splitDMS(-0.00001).negative).toBe(false);
        expect(splitDMS(-0).negative).toBe(false);
    });

    describe("truncate", () => {
        test("cuts off rather than rounds", () => {
            expect(splitDMS(40 + 26 / 60 + 46.9 / 3600, {secondsDecimals: 0, truncate: true}).sec).toBe(46);
        });

        test("is not fooled by float noise on an exact second", () => {
            // 33°53'05" is 121985 seconds, which the float arithmetic delivers
            // as 121984.99999999; a naive floor gives 04".
            let offByOne = 0;
            for (let deg = 0; deg < 90; deg++) {
                for (let min = 0; min < 60; min += 7) {
                    for (let sec = 0; sec < 60; sec++) {
                        const out = splitDMS(deg + min / 60 + sec / 3600, {secondsDecimals: 0, truncate: true});
                        if (out.deg !== deg || out.min !== min || out.sec !== sec) offByOne++;
                    }
                }
            }
            expect(offByOne).toBe(0);
        });
    });
});

describe("splitDM", () => {
    test("splits degrees and decimal minutes", () => {
        expect(splitDM(40 + 26.767 / 60)).toEqual({negative: false, deg: 40, min: 26.767});
    });

    test("carries minutes that round up to 60 into the degrees", () => {
        expect(splitDM(40 + 59.9997 / 60)).toEqual({negative: false, deg: 41, min: 0});
    });
});

describe("formatDMS", () => {
    const lat = 40 + 26 / 60 + 46 / 3600;
    const lon = -(118 + 24 / 60 + 5 / 3600);

    test("MQ-9 style: padded latitude degrees, hemisphere letter", () => {
        expect(formatDMS(lat, {axis: "lat", padDegrees: 2})).toBe("40°26'46.0\"N");
        expect(formatDMS(5.5, {axis: "lat", padDegrees: 2})).toBe("05°30'00.0\"N");
    });

    test("MQ-9 style: unpadded longitude degrees", () => {
        expect(formatDMS(lon, {axis: "lon"})).toBe("118°24'05.0\"W");
        expect(formatDMS(-5.5, {axis: "lon"})).toBe("5°30'00.0\"W");
    });

    test("Wescam style: colons, whole seconds, truncated", () => {
        const wescam = {style: "colons", secondsDecimals: 0, padDegrees: 2, truncate: true};
        expect(formatDMS(33 + 53 / 60 + 5 / 3600, {...wescam, axis: "lat"})).toBe("33:53:05N");
        expect(formatDMS(lon, {...wescam, axis: "lon"})).toBe("118:24:05W");
        expect(formatDMS(-(1 + 2 / 60 + 3.9 / 3600), {...wescam, axis: "lat"})).toBe("01:02:03S");
    });

    test("no axis: a sign instead of a letter", () => {
        expect(formatDMS(lat)).toBe("40°26'46.0\"");
        expect(formatDMS(lon)).toBe("-118°24'05.0\"");
    });

    test("never prints 60 seconds or 60 minutes", () => {
        expect(formatDMS(40 + 26 / 60 + 59.97 / 3600, {axis: "lat"})).toBe("40°27'00.0\"N");
        expect(formatDMS(40 + 59 / 60 + 59.97 / 3600, {axis: "lat"})).toBe("41°00'00.0\"N");
    });

    test("zero is north/east", () => {
        expect(formatDMS(0, {axis: "lat"})).toBe("0°00'00.0\"N");
        expect(formatDMS(-0, {axis: "lon"})).toBe("0°00'00.0\"E");
    });
});

describe("formatDM", () => {
    test("MQ-9 style", () => {
        expect(formatDM(40 + 26.767 / 60, {axis: "lat", padDegrees: 2})).toBe("40°26.767'N");
        expect(formatDM(-(118 + 24.083 / 60), {axis: "lon"})).toBe("118°24.083'W");
        expect(formatDM(5 + 1.5 / 60, {axis: "lat", padDegrees: 2})).toBe("05°01.500'N");
    });

    test("never prints 60 minutes", () => {
        expect(formatDM(40 + 59.9997 / 60, {axis: "lat"})).toBe("41°00.000'N");
    });
});

describe("formatDecimalDegrees", () => {
    test("with an axis", () => {
        expect(formatDecimalDegrees(31.7, {axis: "lat", decimals: 1})).toBe("31.7°N");
        expect(formatDecimalDegrees(-118.04, {axis: "lon", decimals: 1})).toBe("118.0°W");
    });

    test("without an axis", () => {
        expect(formatDecimalDegrees(-118.5, {decimals: 2})).toBe("-118.50°");
        expect(formatDecimalDegrees(-118.5, {decimals: 2, unit: ""})).toBe("-118.50");
    });

    test("a value that rounds to zero is not south", () => {
        expect(formatDecimalDegrees(-0.04, {axis: "lat", decimals: 1})).toBe("0.0°N");
    });
});

describe("formatLatLon", () => {
    test("live-traffic status line", () => {
        expect(formatLatLon(31.7, -118.0, {decimals: 1})).toBe("31.7°N 118.0°W");
    });

    test("DMS and DM pairs", () => {
        expect(formatLatLon(40.5, -118.5, {style: "dms", separator: ", "})).toBe("40°30'00.0\"N, 118°30'00.0\"W");
        expect(formatLatLon(-40.5, 118.5, {style: "dm"})).toBe("40°30.000'S 118°30.000'E");
    });
});

describe("round trip through the parser", () => {
    // A grid of awkward values: both hemispheres, near zero, near the poles
    // and the antimeridian, and carry cases.
    const values = [
        0, 0.0001, -0.0001, 0.2167, -0.2167, 45.5, -45.5, 89.99999, -89.99999,
        179.99999, -179.99999, 40 + 26 / 60 + 46 / 3600, -(118 + 24 / 60 + 5 / 3600),
        40 + 26 / 60 + 59.97 / 3600, 12.3456789, -98.7654321,
    ];

    test("DMS text parses back to within the seconds precision", () => {
        for (const value of values) {
            const text = formatDMS(value, {axis: "lat", secondsDecimals: 3});
            expect(parseSingleCoordinate(text)).toBeCloseTo(value, 6);   // 0.001" ≈ 3e-7°
            const signed = formatDMS(value, {secondsDecimals: 3});
            expect(parseSingleCoordinate(signed)).toBeCloseTo(value, 6);
        }
    });

    test("colon DMS (the Wescam readout) parses back", () => {
        for (const value of values) {
            const text = formatDMS(value, {axis: "lon", style: "colons", secondsDecimals: 2});
            expect(parseSingleCoordinate(text)).toBeCloseTo(value, 5);
        }
    });

    test("DM text parses back to within the minutes precision", () => {
        for (const value of values) {
            const text = formatDM(value, {axis: "lon", minutesDecimals: 4});
            expect(parseSingleCoordinate(text)).toBeCloseTo(value, 5);    // 0.0001' ≈ 1.7e-6°
        }
    });

    test("decimal text parses back", () => {
        for (const value of values) {
            expect(parseSingleCoordinate(formatDecimalDegrees(value, {axis: "lat"}))).toBeCloseTo(value, 6);
            expect(parseSingleCoordinate(formatDecimalDegrees(value))).toBeCloseTo(value, 6);
        }
    });

    test("a formatted pair parses back as a pair", () => {
        for (const style of ["decimal", "dms", "dm"]) {
            const text = formatLatLon(-0.2167, -78.5, {style, secondsDecimals: 3, minutesDecimals: 4});
            const pair = parseLatLonPair(text);
            expect(pair).not.toBeNull();
            expect(pair.lat).toBeCloseTo(-0.2167, 4);
            expect(pair.lon).toBeCloseTo(-78.5, 4);
        }
    });
});
