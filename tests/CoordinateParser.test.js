import {parseCoordinate, parseLatLonPair, parseMGRS, parseSingleCoordinate} from "../src/CoordinateParser";

describe("parseMGRS", () => {
    test("parses standard MGRS with spaces", () => {
        const result = parseMGRS("37S CR 11926 92923");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(32.4576, 3);
        expect(result.lon).toBeCloseTo(36.999, 3);
    });

    test("parses MGRS without spaces", () => {
        const result = parseMGRS("37SCR1192692923");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(32.4576, 3);
        expect(result.lon).toBeCloseTo(36.999, 3);
    });

    test("parses lowercase MGRS", () => {
        const result = parseMGRS("37scr1192692923");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(32.4576, 3);
        expect(result.lon).toBeCloseTo(36.999, 3);
    });

    test("parses 4-digit MGRS", () => {
        const result = parseMGRS("18SUJ2337");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(39.169, 2);
        expect(result.lon).toBeCloseTo(-77.043, 2);
    });

    test("parses 6-digit MGRS", () => {
        const result = parseMGRS("18SUJ233378");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(39.172, 2);
        expect(result.lon).toBeCloseTo(-77.045, 2);
    });

    test("parses 8-digit MGRS", () => {
        const result = parseMGRS("18SUJ23343789");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(39.172, 2);
        expect(result.lon).toBeCloseTo(-77.045, 2);
    });

    test("returns null for invalid MGRS", () => {
        expect(parseMGRS("not mgrs")).toBeNull();
        expect(parseMGRS("123")).toBeNull();
        expect(parseMGRS("")).toBeNull();
    });
});

describe("parseSingleCoordinate", () => {
    describe("decimal degrees", () => {
        test("parses positive decimal", () => {
            expect(parseSingleCoordinate("45.5")).toBeCloseTo(45.5, 5);
        });

        test("parses negative decimal", () => {
            expect(parseSingleCoordinate("-122.5")).toBeCloseTo(-122.5, 5);
        });

        test("parses integer", () => {
            expect(parseSingleCoordinate("45")).toBe(45);
        });
    });

    describe("cardinal directions", () => {
        test("N suffix", () => {
            expect(parseSingleCoordinate("45.5N")).toBeCloseTo(45.5, 5);
        });

        test("S suffix makes negative", () => {
            expect(parseSingleCoordinate("45.5S")).toBeCloseTo(-45.5, 5);
        });

        test("E suffix", () => {
            expect(parseSingleCoordinate("122.5E")).toBeCloseTo(122.5, 5);
        });

        test("W suffix makes negative", () => {
            expect(parseSingleCoordinate("122.5W")).toBeCloseTo(-122.5, 5);
        });

        test("N prefix", () => {
            expect(parseSingleCoordinate("N 45.5")).toBeCloseTo(45.5, 5);
        });

        test("S prefix makes negative", () => {
            expect(parseSingleCoordinate("S 45.5")).toBeCloseTo(-45.5, 5);
        });

        test("lowercase direction", () => {
            expect(parseSingleCoordinate("45.5n")).toBeCloseTo(45.5, 5);
            expect(parseSingleCoordinate("45.5s")).toBeCloseTo(-45.5, 5);
        });
    });

    describe("degrees minutes (DM)", () => {
        test("space separated", () => {
            expect(parseSingleCoordinate("45 30")).toBeCloseTo(45.5, 5);
        });

        test("with degree symbol", () => {
            expect(parseSingleCoordinate("45° 30")).toBeCloseTo(45.5, 5);
        });

        test("with degree and minute symbols", () => {
            expect(parseSingleCoordinate("45° 30'")).toBeCloseTo(45.5, 5);
        });

        test("with direction suffix", () => {
            expect(parseSingleCoordinate("45° 30' N")).toBeCloseTo(45.5, 5);
            expect(parseSingleCoordinate("45° 30' S")).toBeCloseTo(-45.5, 5);
        });

        test("decimal minutes", () => {
            expect(parseSingleCoordinate("45° 30.5'")).toBeCloseTo(45.508333, 4);
        });

        test("negative degrees", () => {
            expect(parseSingleCoordinate("-45 30")).toBeCloseTo(-45.5, 5);
        });
    });

    describe("degrees minutes seconds (DMS)", () => {
        test("space separated", () => {
            expect(parseSingleCoordinate("45 30 30")).toBeCloseTo(45.508333, 4);
        });

        test("with symbols", () => {
            expect(parseSingleCoordinate("45° 30' 30\"")).toBeCloseTo(45.508333, 4);
        });

        test("with smart quotes", () => {
            expect(parseSingleCoordinate("45° 30′ 30″")).toBeCloseTo(45.508333, 4);
        });

        test("with direction", () => {
            expect(parseSingleCoordinate("45° 30' 30\" N")).toBeCloseTo(45.508333, 4);
            expect(parseSingleCoordinate("45° 30' 30\" S")).toBeCloseTo(-45.508333, 4);
        });

        test("no spaces with symbols", () => {
            expect(parseSingleCoordinate("45°30'30\"")).toBeCloseTo(45.508333, 4);
        });

        test("negative degrees", () => {
            expect(parseSingleCoordinate("-45° 30' 30\"")).toBeCloseTo(-45.508333, 4);
        });

        test("decimal seconds", () => {
            expect(parseSingleCoordinate("45° 30' 30.5\"")).toBeCloseTo(45.508472, 4);
        });
    });

    describe("edge cases", () => {
        test("returns null for empty string", () => {
            expect(parseSingleCoordinate("")).toBeNull();
        });

        test("returns null for whitespace only", () => {
            expect(parseSingleCoordinate("   ")).toBeNull();
        });

        test("returns null for invalid input", () => {
            expect(parseSingleCoordinate("abc")).toBeNull();
        });

        test("handles extra whitespace", () => {
            expect(parseSingleCoordinate("  45.5  ")).toBeCloseTo(45.5, 5);
        });

        test("zero value", () => {
            expect(parseSingleCoordinate("0")).toBe(0);
        });

        test("alternate degree symbols", () => {
            expect(parseSingleCoordinate("45˚ 30'")).toBeCloseTo(45.5, 5);
            expect(parseSingleCoordinate("45º 30'")).toBeCloseTo(45.5, 5);
        });
    });
});

describe("parseLatLonPair", () => {
    describe("comma separated decimal", () => {
        test("positive values", () => {
            const result = parseLatLonPair("45.5, -122.5");
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });

        test("no space after comma", () => {
            const result = parseLatLonPair("45.5,-122.5");
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });

        test("both negative", () => {
            const result = parseLatLonPair("-45.5, -122.5");
            expect(result.lat).toBeCloseTo(-45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });
    });

    describe("space separated decimal", () => {
        test("bare space is NOT a pair separator (ambiguous with DM format)", () => {
            // "32 55" could be the pair (32, 55) OR the single DM value 32°55' = 32.9166°.
            // We reserve bare whitespace for DM/DMS input within a single coordinate,
            // so callers should use comma, semicolon, or N/S/E/W to express a pair.
            expect(parseLatLonPair("45.5 -122.5")).toBeNull();
        });
    });

    describe("semicolon separated", () => {
        test("semicolon separation", () => {
            const result = parseLatLonPair("45.5; -122.5");
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });
    });

    describe("with cardinal directions", () => {
        test("trailing N and W", () => {
            const result = parseLatLonPair("45.5N, 122.5W");
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });

        test("trailing S and E", () => {
            const result = parseLatLonPair("45.5S, 122.5E");
            expect(result.lat).toBeCloseTo(-45.5, 5);
            expect(result.lon).toBeCloseTo(122.5, 5);
        });

        test("direction-separated without comma", () => {
            const result = parseLatLonPair("45.5N 122.5W");
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });
    });

    describe("DMS pairs", () => {
        test("comma separated DMS", () => {
            const result = parseLatLonPair("45° 30' 30\" N, 122° 30' 30\" W");
            expect(result.lat).toBeCloseTo(45.508333, 4);
            expect(result.lon).toBeCloseTo(-122.508333, 4);
        });

        test("direction-separated DMS", () => {
            const result = parseLatLonPair("45° 30' 30\" N 122° 30' 30\" W");
            expect(result.lat).toBeCloseTo(45.508333, 4);
            expect(result.lon).toBeCloseTo(-122.508333, 4);
        });
    });

    describe("DM pairs", () => {
        test("degrees and decimal minutes", () => {
            const result = parseLatLonPair("45° 30.5' N, 122° 30.5' W");
            expect(result.lat).toBeCloseTo(45.508333, 4);
            expect(result.lon).toBeCloseTo(-122.508333, 4);
        });
    });

    describe("MGRS in pair context", () => {
        test("parses MGRS", () => {
            const result = parseLatLonPair("37SCR1192692923");
            expect(result).not.toBeNull();
            expect(result.lat).toBeCloseTo(32.4576, 3);
            expect(result.lon).toBeCloseTo(36.999, 3);
        });
    });

    describe("edge cases", () => {
        test("returns null for invalid input", () => {
            expect(parseLatLonPair("")).toBeNull();
            expect(parseLatLonPair("abc")).toBeNull();
        });

        test("returns null for single value", () => {
            expect(parseLatLonPair("45.5")).toBeNull();
        });

        test("returns null for lat > 90", () => {
            expect(parseLatLonPair("95, 122")).toBeNull();
        });

        test("handles extra whitespace", () => {
            const result = parseLatLonPair("  45.5 ,  -122.5  ");
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });
    });
});

describe("parseCoordinate", () => {
    test("returns MGRS result with lat/lon", () => {
        const result = parseCoordinate("37SCR1192692923");
        expect(result.lat).toBeCloseTo(32.4576, 3);
        expect(result.lon).toBeCloseTo(36.999, 3);
    });

    test("returns lat/lon pair", () => {
        const result = parseCoordinate("45.5, -122.5");
        expect(result.lat).toBeCloseTo(45.5, 5);
        expect(result.lon).toBeCloseTo(-122.5, 5);
    });

    test("returns single value", () => {
        const result = parseCoordinate("45.5");
        expect(result.value).toBeCloseTo(45.5, 5);
    });

    test("returns null for invalid", () => {
        expect(parseCoordinate("")).toBeNull();
        expect(parseCoordinate("   ")).toBeNull();
        expect(parseCoordinate(null)).toBeNull();
        expect(parseCoordinate(undefined)).toBeNull();
    });
});

describe("real-world examples", () => {
    test("Google Maps format", () => {
        const result = parseLatLonPair("40.7128, -74.0060");
        expect(result.lat).toBeCloseTo(40.7128, 4);
        expect(result.lon).toBeCloseTo(-74.006, 4);
    });

    test("Wikipedia DMS format", () => {
        const result = parseLatLonPair("40° 42′ 46″ N, 74° 0′ 22″ W");
        expect(result.lat).toBeCloseTo(40.7128, 3);
        expect(result.lon).toBeCloseTo(-74.006, 2);
    });

    test("Aviation format", () => {
        const result = parseLatLonPair("N40 42.77 W074 00.36");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(40.7128, 3);
        expect(result.lon).toBeCloseTo(-74.006, 2);
    });

    test("Military MGRS", () => {
        const result = parseCoordinate("18T WL 80 60");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(41.192, 2);
        expect(result.lon).toBeCloseTo(-74.040, 2);
    });

    test("degree symbol variations", () => {
        const formats = [
            "45°30'30\"N, 122°30'30\"W",
            "45° 30' 30\" N, 122° 30' 30\" W",
            "45°30′30″N, 122°30′30″W",
        ];
        for (const format of formats) {
            const result = parseLatLonPair(format);
            expect(result).not.toBeNull();
            expect(result.lat).toBeCloseTo(45.508333, 3);
            expect(result.lon).toBeCloseTo(-122.508333, 3);
        }
    });
});
