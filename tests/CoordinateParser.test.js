import {
    parseCoordinate,
    parseECEF,
    parseLatLonAlt,
    parseLatLonPair,
    parseMGRS,
    parseSingleCoordinate
} from "../src/CoordinateParser";
import {LLAToECEF, RLLAToECEF} from "../src/LLA-ECEF-ENU";
import {radians} from "../src/mathUtils";

// Sitrec's earth model is a sphere until a sitch turns the ellipsoid on, and
// nothing loads a sitch here, so LLAToECEF() below is the spherical one. That is
// exactly the case that matters: an x,y,z triple is read as WGS84, and at 45°
// the two models name the same point 0.19° and 10.7 km apart, so a test that
// built its input with the wrong one would quietly assert the wrong answer.
const ecefString = (v) => `${v.x}, ${v.y}, ${v.z}`;
// A triple as an external tool would give it: WGS84, whatever Sitrec is using.
const wgs84ECEF = (lat, lon, alt) => ecefString(RLLAToECEF(radians(lat), radians(lon), alt));

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

    describe("space separated with degree symbols", () => {
        // A coordinate can only carry one degree symbol, so two of them is
        // unambiguously two coordinates even with only whitespace between.
        test("decimal degrees with degree symbols", () => {
            const result = parseLatLonPair("25.299895° 60.430364°");
            expect(result.lat).toBeCloseTo(25.299895, 6);
            expect(result.lon).toBeCloseTo(60.430364, 6);
        });

        test("negative longitude", () => {
            const result = parseLatLonPair("25.299895° -60.430364°");
            expect(result.lat).toBeCloseTo(25.299895, 6);
            expect(result.lon).toBeCloseTo(-60.430364, 6);
        });

        test("DMS without direction letters", () => {
            const result = parseLatLonPair("40°26'46\" 79°58'56\"");
            expect(result.lat).toBeCloseTo(40.446111, 5);
            expect(result.lon).toBeCloseTo(79.982222, 5);
        });

        test("DMS with spaces between every part", () => {
            const result = parseLatLonPair("40° 26' 46\" 79° 58' 56\"");
            expect(result.lat).toBeCloseTo(40.446111, 5);
            expect(result.lon).toBeCloseTo(79.982222, 5);
        });

        test("alternate degree glyphs", () => {
            const result = parseLatLonPair("25.3˚ 60.4º");
            expect(result.lat).toBeCloseTo(25.3, 5);
            expect(result.lon).toBeCloseTo(60.4, 5);
        });

        test("no whitespace between the two coordinates is declined", () => {
            expect(parseLatLonPair("25.3°60.4°")).toBeNull();
        });

        test("a single coordinate is still a single coordinate", () => {
            expect(parseLatLonPair("45° 30'")).toBeNull();
            expect(parseSingleCoordinate("45° 30'")).toBeCloseTo(45.5, 5);
        });
    });

    describe("loose whitespace pairs (submitted strings only)", () => {
        test("bare decimal pair", () => {
            const result = parseLatLonPair("45.5 -122.5", {loose: true});
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(-122.5, 5);
        });

        test("four tokens are a DM pair", () => {
            const result = parseLatLonPair("45 30 122 30", {loose: true});
            expect(result.lat).toBeCloseTo(45.5, 5);
            expect(result.lon).toBeCloseTo(122.5, 5);
        });

        test("six tokens are a DMS pair", () => {
            const result = parseLatLonPair("45 30 30 122 30 30", {loose: true});
            expect(result.lat).toBeCloseTo(45.508333, 4);
            expect(result.lon).toBeCloseTo(122.508333, 4);
        });

        test("place names are not coordinates", () => {
            expect(parseLatLonPair("Area 51", {loose: true})).toBeNull();
            expect(parseLatLonPair("New York", {loose: true})).toBeNull();
            expect(parseLatLonPair("Highway 101 California", {loose: true})).toBeNull();
        });

        test("odd token counts are not pairs", () => {
            expect(parseLatLonPair("45 30 30", {loose: true})).toBeNull();
        });

        test("out of range values are rejected", () => {
            expect(parseLatLonPair("1600 1600", {loose: true})).toBeNull();
        });

        test("loose is opt-in - the default is unchanged", () => {
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

describe("parseECEF", () => {
    describe("recognises a position on the Earth", () => {
        test("round-trips a WGS84 triple at ground level", () => {
            const result = parseECEF(wgs84ECEF(45, -122, 0));
            expect(result).not.toBeNull();
            expect(result.lat).toBeCloseTo(45, 6);
            expect(result.lon).toBeCloseTo(-122, 6);
            expect(result.alt).toBeCloseTo(0, 3);
        });

        test("round-trips a WGS84 triple at altitude", () => {
            // The case that breaks if the spherical model is tried first: this
            // reads as 730 m underground on a sphere, which passes the altitude
            // window, and would be accepted 0.19° (21 km) south and 10.7 km low.
            const result = parseECEF(wgs84ECEF(45, -122, 10000));
            expect(result).not.toBeNull();
            expect(result.lat).toBeCloseTo(45, 6);
            expect(result.lon).toBeCloseTo(-122, 6);
            expect(result.alt).toBeCloseTo(10000, 3);
        });

        test("accepts a point just under the surface", () => {
            expect(parseECEF(wgs84ECEF(45, -122, -500))).not.toBeNull();
        });

        test("accepts a point at the top of the altitude window", () => {
            expect(parseECEF(wgs84ECEF(45, -122, 999000))).not.toBeNull();
        });

        test("Sitrec's own model rescues a triple only WGS84 rejects", () => {
            // A spherical-model point this high reads as 1009 km on WGS84, past
            // the top of the window - so the fallback is what accepts it, and it
            // reports the spherical altitude it was built with.
            const result = parseECEF(ecefString(LLAToECEF(45, -122, 999000)));
            expect(result).not.toBeNull();
            expect(result.alt).toBeCloseTo(999000, 1);
        });
    });

    describe("rejects what is not one", () => {
        // At the equator the sphere and WGS84 agree exactly, so these test the
        // altitude window itself rather than the gap between the two models.
        test("too far underground", () => {
            expect(parseECEF(wgs84ECEF(45, -122, -2000))).toBeNull();
        });

        test("too far above", () => {
            expect(parseECEF(wgs84ECEF(45, -122, 2000000))).toBeNull();
        });

        test("small numbers - a DMS coordinate is not an ECEF triple", () => {
            expect(parseECEF("45, 30, 20")).toBeNull();
            expect(parseECEF("1, 2, 3")).toBeNull();
        });

        test("the centre of the Earth", () => {
            expect(parseECEF("0, 0, 0")).toBeNull();
        });

        test("a lat/lon with an altitude", () => {
            expect(parseECEF("38.73, -120.56, 100000")).toBeNull();
        });

        test("two or four numbers", () => {
            const p = RLLAToECEF(radians(45), radians(-122), 0);
            expect(parseECEF(`${p.x}, ${p.y}`)).toBeNull();
            expect(parseECEF(`${p.x}, ${p.y}, ${p.z}, 0`)).toBeNull();
        });

        test("non-numeric text", () => {
            expect(parseECEF("x, y, z")).toBeNull();
            expect(parseECEF("")).toBeNull();
        });
    });

    describe("separators", () => {
        test("semicolons", () => {
            const p = RLLAToECEF(radians(45), radians(-122), 1000);
            const result = parseECEF(`${p.x}; ${p.y}; ${p.z}`);
            expect(result).not.toBeNull();
            expect(result.lat).toBeCloseTo(45, 6);
        });

        test("exponent notation", () => {
            const p = RLLAToECEF(radians(45), radians(-122), 1000);
            const result = parseECEF(`${p.x.toExponential(12)}, ${p.y.toExponential(12)}, ${p.z.toExponential(12)}`);
            expect(result).not.toBeNull();
            expect(result.lat).toBeCloseTo(45, 5);
        });

        test("bare whitespace only separates for a submitted string", () => {
            const p = RLLAToECEF(radians(45), radians(-122), 1000);
            const spaced = `${p.x} ${p.y} ${p.z}`;
            expect(parseECEF(spaced)).toBeNull();
            expect(parseECEF(spaced, {loose: true})).not.toBeNull();
        });
    });
});

describe("parseLatLonAlt", () => {
    test("lat, lon, alt triple", () => {
        const result = parseLatLonAlt("38.73, -120.56, 100000");
        expect(result.lat).toBeCloseTo(38.73, 5);
        expect(result.lon).toBeCloseTo(-120.56, 5);
        expect(result.alt).toBeCloseTo(100000, 5);
    });

    test("a plain pair reports no altitude, which is not the same as zero", () => {
        const result = parseLatLonAlt("45.5, -122.5");
        expect(result.lat).toBeCloseTo(45.5, 5);
        expect(result.alt).toBeUndefined();
    });

    test("an ECEF triple brings its altitude with it", () => {
        const result = parseLatLonAlt(wgs84ECEF(45, -122, 3000));
        expect(result.lat).toBeCloseTo(45, 6);
        expect(result.alt).toBeCloseTo(3000, 3);
    });

    test("an absurd altitude stays a lat/lon rather than becoming an ECEF z", () => {
        // Read as ECEF this is a valid position; read as LLA it is a lat/lon
        // 6378 km up. LLA wins, because a real ECEF x is millions of metres and
        // so can never pass for a latitude in the first place.
        const result = parseLatLonAlt("38.7, -120.5, 6378137");
        expect(result.lat).toBeCloseTo(38.7, 5);
        expect(result.lon).toBeCloseTo(-120.5, 5);
        expect(result.alt).toBeCloseTo(6378137, 5);
    });

    test("MGRS still works, with no altitude", () => {
        const result = parseLatLonAlt("37SCR1192692923");
        expect(result.lat).toBeCloseTo(32.4576, 3);
        expect(result.alt).toBeUndefined();
    });

    test("a whitespace triple needs a submitted string", () => {
        expect(parseLatLonAlt("38.73 -120.56 100000")).toBeNull();
        const result = parseLatLonAlt("38.73 -120.56 100000", {loose: true});
        expect(result.lat).toBeCloseTo(38.73, 5);
        expect(result.alt).toBeCloseTo(100000, 5);
    });

    test("returns null for a place name", () => {
        expect(parseLatLonAlt("Area 51", {loose: true})).toBeNull();
        expect(parseLatLonAlt("")).toBeNull();
        expect(parseLatLonAlt(null)).toBeNull();
    });
});

describe("ECEF through the shared pair parser", () => {
    test("the lat/lon boxes accept an ECEF paste", () => {
        const result = parseLatLonPair(wgs84ECEF(45, -122, 1000));
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(45, 6);
        expect(result.lon).toBeCloseTo(-122, 6);
    });

    test("parseCoordinate accepts one too", () => {
        const result = parseCoordinate(wgs84ECEF(45, -122, 1000));
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(45, 6);
        expect(result.alt).toBeCloseTo(1000, 3);
    });
});
